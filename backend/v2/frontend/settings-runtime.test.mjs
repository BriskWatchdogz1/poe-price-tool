// Browser test (headless Chrome, same setup as settings-page.test.mjs): the two
// things the settings page gained when settings became changeable at runtime.
//
// 1. THE CLIENT LANGUAGE, in the ordinary part of the page and without the admin
//    password. It is the language a user's GAME runs in, so it decides which
//    parser his pasted items go through — set wrong, an item is not mispriced,
//    it is not recognised at all. The section is therefore checked for the
//    things that make that comprehensible: the explanation, the options coming
//    from the server rather than from a list in the page, the switch taking
//    effect without a save button, and the field snapping back when the server
//    refuses.
//
// 2. THE CONFIGURATION SECTION of the admin area, which is generated from
//    `GET /config-view` and from nothing else. What is worth testing there is
//    not that a table renders: it is that the three states a stranger would
//    otherwise misread are visible — an override shadowing a compose value, a
//    value written but not in force until a restart, and an entry in the file
//    that is refused and therefore doing nothing.
//
// The restart button gets its own test with its own server, because the thing
// it does is end that server. The UPDATE button, added later, gets one too: it
// needs a stand-in for the script on the host, and the whole point of that
// button is what it does when no such script exists.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { markerBody, QUARANTINE_AFTER_FAILED_STARTS } from '../config-overrides.mjs'
import { QUIET_ENV } from '../test-quiet-env.mjs'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// A second live parser only exists where the localized data set has been
// generated (it is gitignored on purpose). Without it the server has exactly one
// language and the switch has nothing to switch to — which is its own asserted
// case below; the switching half then skips rather than lying.
const DE_DATA = fileURLToPath(new URL('../../../renderer/public/data/de/items.ndjson', import.meta.url))
const HAVE_DE = existsSync(DE_DATA)
const skipSwitch = HAVE_DE ? false : 'no generated data/de here — only one language is live'

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

async function cdpConnect (wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let id = 0
  const pending = new Map()
  ws.on('message', buf => {
    const m = JSON.parse(String(buf))
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params }
    if (sessionId) msg.sessionId = sessionId
    pending.set(msg.id, { res, rej })
    ws.send(JSON.stringify(msg))
  })
  return { send, close: () => ws.close() }
}

let tmp
let chrome
let cdp
let S
let evalJs

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ppt-setrt-'))
  const dbg = await freePort()
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${dbg}`, `--user-data-dir=${join(tmp, 'chrome')}`,
    '--window-size=1280,1000', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let verUrl = null
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${dbg}/json/version`)
      if (r.ok) { verUrl = (await r.json()).webSocketDebuggerUrl; break }
    } catch {}
    await sleep(100)
  }
  assert.ok(verUrl, 'Chrome DevTools reachable')

  cdp = await cdpConnect(verUrl)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  S = (m, p) => cdp.send(m, p, sessionId)
  await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable')

  evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
})

after(async () => {
  try { cdp && cdp.close() } catch {}
  try { chrome && chrome.kill('SIGTERM') } catch {}
  await sleep(200)
  if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
})

// ---------------------------------------------------------------------------
// One server per test: two of them need a different environment to start with,
// and the third one deliberately kills its own.
async function startServer (dir, extraEnv = {}, port) {
  const p = port || await freePort()
  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      // The full set that keeps a booted server off the network — one list,
      // imported, because every file that wrote it out by hand got it wrong.
      // Spread first, so anything below may still override it deliberately.
      ...QUIET_ENV,
      PORT: String(p),
      POE_USERS: 'player1,player2',
      POE_NETWORTH_CONFIG: join(dir, 'networth-users.json'),
      POE_NETWORTH_STORE: join(dir, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(dir, 'networth-history.ndjson'),
      POE_NETWORTH_AUTOSYNC: '0',
      POE_FAUSTUS_DISABLED: '1',
      POE_CORPSE_DISABLED: '1',
      POE_DATA_REFRESH_DISABLED: '1',
      POE_REFERENCE_DISABLED: '1',
      POE_ADMIN_PASSWORD_FILE: join(dir, 'admin-password'),
      POE_USER_LANG_STORE: join(dir, 'user-langs.json'),
      POE_CONFIG_OVERRIDES: join(dir, 'overrides.json'),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const log = []
  srv.stdout.on('data', d => log.push(String(d)))
  srv.stderr.on('data', d => log.push(String(d)))
  for (let i = 0; i < 600; i++) {
    try { const r = await fetch(`http://127.0.0.1:${p}/users`); if (r.ok) break } catch {}
    await sleep(100)
  }
  return { port: p, base: `http://127.0.0.1:${p}`, log, kill: () => srv.kill('SIGTERM'), proc: srv }
}

// `what` may be a function, so a failure can report what the page DOES say
// instead of only what it should have said.
async function waitFor (expr, what, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try { if (await evalJs(expr)) return } catch {}
    await sleep(100)
  }
  assert.fail(typeof what === 'function' ? await what() : what)
}

const text = sel => evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.trim() : null })()`)

// Open the admin area of the page currently loaded, with the default password
// the server writes on first boot.
async function openAdmin () {
  // Wait for the page SCRIPT, not for an element: every id on this page is in
  // the static HTML, so a parsed-but-not-executed document would pass an
  // element check and then swallow the click. A populated language selector is
  // proof that settings.js ran and completed a round trip.
  await waitFor('document.querySelectorAll("#langSel option").length > 0', 'the settings page never loaded')
  await evalJs(`(() => { document.getElementById('admPass').value = 'admin'; document.getElementById('admOpen').click() })()`)
  await waitFor('!document.getElementById("admView").hidden', 'the admin view never opened')
  await waitFor('document.querySelectorAll("#cfgTables table.cfgtab").length > 0', 'the settings table never rendered')
}

// The row of one setting, read back from the DOM.
const rowJs = name => `(() => {
  const el = document.querySelector('[data-cfg=${JSON.stringify(name)}]') ||
             document.querySelector('[data-cfg-reset=${JSON.stringify(name)}]')
  if (!el) return null
  const tr = el.closest('tr')
  return {
    value: el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value,
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    source: tr.querySelector('td.src').textContent.trim(),
    hasReset: !!tr.querySelector('[data-cfg-reset]'),
    shadow: (tr.querySelector('.cfgflag.shadow') || {}).textContent || null,
    pending: (tr.querySelector('.cfgflag.pending') || {}).textContent || null,
    invalid: (tr.querySelector('.cfgflag.invalid') || {}).textContent || null,
    group: (() => { let n = tr.closest('table').previousElementSibling; return n ? n.textContent.trim() : null })()
  }
})()`

// ---------------------------------------------------------------------------
test('the client language is the user\'s own switch: options from the server, effect without a save button',
  { timeout: 240_000 }, async () => {
    const dir = join(tmp, 'lang')
    const srv = await startServer(dir)
    try {
      await S('Network.setCookie', { name: 'ppt_user', value: 'player1', url: srv.base + '/' })
      await S('Page.navigate', { url: srv.base + '/settings.html' })
      await waitFor('!!window.I18n && !!document.getElementById("langSel")', 'the settings page never loaded')

      // What the server says is the only source of the options — the page keeps
      // no list of languages of its own.
      const server = await (await fetch(srv.base + '/user-lang', { headers: { cookie: 'ppt_user=player1' } })).json()
      await waitFor(`document.querySelectorAll('#langSel option').length === ${server.available.length}`,
        'the selector does not offer exactly the languages the server reports')
      const values = await evalJs('[...document.querySelectorAll("#langSel option")].map(o => o.value)')
      assert.deepEqual(Array.from(values).sort(), server.available.slice().sort())
      assert.equal(await evalJs('document.getElementById("langSel").value'), server.lang)

      // The section is FIRST on the page, above the sync settings: it is the one
      // that can silently break the price check.
      const heads = await evalJs('[...document.querySelectorAll(".sect h2")].map(e => e.textContent)')
      assert.equal(Array.from(heads)[0], 'Client language')

      // The explanation is the point of the whole section, so it is on screen
      // and it says the three things a user has to take away.
      const lead = await text('.sect .lead')
      assert.match(lead, /language your game client runs in/)
      assert.match(lead, /not a setting for the language of this website/)
      assert.match(lead, /not recognised at all/)

      // One language -> the field stays, visibly inert, with the reason.
      const single = server.available.length < 2
      assert.equal(await evalJs('document.getElementById("langSel").disabled'), single,
        'the selector is disabled exactly when there is nothing to switch to')
      assert.equal(await evalJs('document.getElementById("langOnly").hidden'), !single,
        'the "only one language" note follows the same condition')

      // This server has a writable store, so the "will not survive a restart"
      // note must NOT be showing.
      assert.equal(server.persisted, true)
      assert.ok(await evalJs('document.getElementById("langNote").hidden'),
        'the not-persisted warning is on screen although the store is writable')

      // There is no save button next to the field — selecting IS the save.
      assert.equal(await evalJs('document.querySelectorAll("#langSel ~ button, label[for=langSel] button").length'), 0)
    } finally {
      srv.kill()
      await sleep(200)
    }
  })

test('switching the language takes effect at once, is persisted, and snaps back when the server refuses',
  { timeout: 240_000, skip: skipSwitch }, async () => {
    const dir = join(tmp, 'switch')
    const srv = await startServer(dir)
    try {
      await S('Network.setCookie', { name: 'ppt_user', value: 'player2', url: srv.base + '/' })
      await S('Page.navigate', { url: srv.base + '/settings.html' })
      await waitFor('document.querySelectorAll("#langSel option").length >= 2', 'the second language never showed up')
      assert.equal(await evalJs('window.I18n.lang()'), 'en')

      // Pick German. No button, no reload.
      await evalJs(`(() => { const s = document.getElementById('langSel'); s.value = 'de'; s.dispatchEvent(new Event('change')) })()`)
      await waitFor('window.I18n.lang() === "de"', 'the page never switched language')
      assert.equal(await evalJs('document.documentElement.lang'), 'de')
      assert.equal(await text('.mhead h1'), 'Einstellungen')
      // Short, visible confirmation.
      assert.ok(!(await evalJs('document.getElementById("langOk").hidden')), 'the switch was not confirmed on screen')
      assert.equal(await text('#langOk'), 'gespeichert')

      // The server agrees, and it is on disk — that is what makes it survive a
      // restart and beat POE_USER_LANGS.
      const after = await (await fetch(srv.base + '/user-lang', { headers: { cookie: 'ppt_user=player2' } })).json()
      assert.equal(after.lang, 'de')
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'user-langs.json'), 'utf8')), { player2: 'de' })

      // ---- the refusal path ------------------------------------------------
      // The server only ever offers languages it can honour, so a refusal is
      // provoked here rather than waited for: what matters is that the field
      // does not keep showing a language that is not in force.
      await evalJs(`(() => {
        const real = window.fetch
        window.fetch = (url, opt) => (String(url) === '/user-lang' && opt && opt.method === 'POST')
          ? Promise.resolve(new Response(JSON.stringify({ error: 'nope', available: ['en', 'de'] }),
              { status: 400, headers: { 'content-type': 'application/json' } }))
          : real(url, opt)
      })()`)
      await evalJs(`(() => { const s = document.getElementById('langSel'); s.value = 'en'; s.dispatchEvent(new Event('change')) })()`)
      await waitFor('!document.getElementById("langErr").hidden', 'a refused switch produced no message')
      assert.equal(await evalJs('document.getElementById("langSel").value'), 'de',
        'the field must jump back to the language that is actually in force')
      assert.equal(await evalJs('window.I18n.lang()'), 'de', 'and nothing switched')
    } finally {
      srv.kill()
      await sleep(200)
    }
  })

test('the admin configuration table: widgets from the type, a readable source, and the three states that mislead',
  { timeout: 240_000 }, async () => {
    const dir = join(tmp, 'cfg')
    // POE_MAX_LISTINGS is set in the ENVIRONMENT here, so an override on it can
    // be seen shadowing a compose value — the trap this section exists to make
    // visible.
    const srv = await startServer(dir, { POE_MAX_LISTINGS: '5' })
    try {
      await S('Network.setCookie', { name: 'ppt_user', value: 'player1', url: srv.base + '/' })
      await S('Page.navigate', { url: srv.base + '/settings.html' })
      await evalJs('sessionStorage.clear()')
      await S('Page.navigate', { url: srv.base + '/settings.html' })
      await openAdmin()

      // ---- the password that guards all of this -----------------------------
      // It is still the one printed in the repository, and it no longer guards
      // only a read-only diagnostic view: the restart button and the table
      // below it hang on it too. So the area says so, where the decision is
      // made rather than in a container log nobody reads.
      const pwWarn = await text('#cfgPwWarn .cfgwarn')
      assert.ok(pwWarn, 'nothing says the admin password is still the default one')
      assert.match(pwWarn, /still the default/)
      assert.match(pwWarn, /restart button/, 'and it says what changed about what it guards')

      // The form is the endpoint's list, not a list in the page.
      const view = await (await fetch(srv.base + '/config-view', { headers: { 'X-Admin-Password': 'admin' } })).json()
      assert.equal(view.adminGateIsDefault, true)
      assert.equal(await evalJs('document.querySelectorAll("#cfgTables tbody tr").length'), view.settings.length)
      assert.match(await text('#cfgPath'), /^Stored in /)

      // Grouped by what pressing a key actually does — and, before that, by
      // whether it costs somebody else a request. The settings that decide how
      // often this tool asks GGG and poe.ninja stand in a section of their own
      // with the reason next to them: a number turned up out of curiosity there
      // is answered with a rate limit, and this repository has two bans behind
      // it. The live/restart split repeats INSIDE that section, which is why
      // the last two headings read like the first two.
      const groups = await evalJs('[...document.querySelectorAll("#cfgTables .cfggroup")].map(e => e.textContent)')
      assert.deepEqual(Array.from(groups),
        ['Takes effect immediately', 'Needs a restart', 'Takes effect immediately', 'Needs a restart'])
      assert.equal(await text('#cfgTables .cfgtraffic h4'), 'How often this tool asks other people’s servers')
      assert.match(await text('#cfgTables .cfgtraffic > .note'), /rate limit/,
        'the section has to say WHY these stand apart, not merely stand apart')

      // Every row the endpoint marks is in that section, no row outside it is
      // marked, and each marked row says which way adds requests. The page owns
      // none of that list: `traffic` comes from the allow-list.
      const marked = view.settings.filter(s => s.traffic).map(s => s.name).sort()
      assert.ok(marked.includes('POE_CORPSE_BUDGET_PER_HOUR'),
        'the corpse budget is the one an operator is most likely to reach for')
      assert.deepEqual(
        Array.from(await evalJs('[...document.querySelectorAll("#cfgTables .cfgtraffic tbody tr .k")].map(e => e.textContent)')).sort(),
        marked)
      assert.equal(await evalJs('document.querySelectorAll("#cfgTables .cfgtraffic .cfgflag.traffic").length'),
        marked.length, 'every row in the section carries its direction')
      assert.equal(await evalJs('document.querySelectorAll("#cfgTables .cfgflag.traffic").length'),
        marked.length, 'and no row outside it does')
      assert.equal(
        await evalJs(`document.querySelector('[data-cfg="POE_CORPSE_BUDGET_PER_HOUR"]').closest('tr').querySelector('.cfgflag.traffic').textContent`),
        'Higher values send more requests.', 'a budget grows with the number, unlike every interval beside it')
      assert.equal(
        await evalJs(`document.querySelector('[data-cfg="POE_CORPSE_INTERVAL_MS"]').closest('tr').querySelector('.cfgflag.traffic').textContent`),
        'Lower values send more requests.')

      // One widget per type, with the constraints the endpoint gave.
      const bool = await evalJs(rowJs('POE_NETWORTH_DEBUG'))
      assert.equal(bool.type, 'checkbox')
      const en = await evalJs(rowJs('POE_LANG_DEFAULT'))
      assert.equal(en.tag, 'select')
      const enumOpts = await evalJs(`[...document.querySelectorAll('[data-cfg="POE_LANG_DEFAULT"] option')].map(o => o.value)`)
      assert.deepEqual(Array.from(enumOpts), view.settings.find(s => s.name === 'POE_LANG_DEFAULT').values)
      const int = await evalJs(rowJs('POE_MAX_LISTINGS'))
      assert.equal(int.type, 'number')
      assert.equal(await evalJs(`document.querySelector('[data-cfg="POE_MAX_LISTINGS"]').getAttribute('max')`), '10')
      const str = await evalJs(rowJs('POE_APP_NAME'))
      assert.equal(str.type, 'text')
      assert.equal(await evalJs(`document.querySelector('[data-cfg="POE_APP_NAME"]').getAttribute('maxlength')`), '60')

      // `source` is explained, never printed as the wire word, and there is no
      // way back offered where there is nothing to go back from.
      assert.equal(int.source, 'from the server’s compose file')
      assert.equal(int.value, '5')
      assert.equal(int.hasReset, false, 'no reset button while no override exists')
      assert.equal(str.source, 'built-in default')

      // ---- a live setting that shadows a compose value ----------------------
      await evalJs(`(() => { const e = document.querySelector('[data-cfg="POE_MAX_LISTINGS"]'); e.value = '7'; e.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      await waitFor(`!!document.querySelector('[data-cfg-reset="POE_MAX_LISTINGS"]')`,
        'the new value never came back from the server')
      const shadowed = await evalJs(rowJs('POE_MAX_LISTINGS'))
      assert.equal(shadowed.source, 'set here, on this page')
      assert.equal(shadowed.hasReset, true, 'the way back has to be findable')
      assert.match(shadowed.shadow, /wins over the compose file, which says 5 here/,
        'a shadowed compose value must be named, or somebody loses an afternoon over it')
      assert.equal(shadowed.pending, null, 'a live setting is not waiting for a restart')
      assert.equal(await text('#cfgMsg'), 'saved')

      // ---- a restart setting: written now, in force later --------------------
      assert.ok(await evalJs('document.getElementById("cfgPend").hidden'), 'nothing was pending before this')
      await evalJs(`(() => { const e = document.querySelector('[data-cfg="POE_LEAGUE"]'); e.value = 'Testleague'; e.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      await waitFor('!document.getElementById("cfgPend").hidden', 'the global restart-pending banner never appeared')
      const pending = await evalJs(rowJs('POE_LEAGUE'))
      assert.match(pending.pending, /in effect after a restart/)
      assert.equal(pending.group, 'Needs a restart')
      assert.equal(await text('#cfgPend'), 'Some settings are saved but not in effect yet. They need a restart.')

      // ---- an entry in the file the allow-list refuses ------------------------
      // Written straight into the file, because the form cannot produce one:
      // that is exactly the case where the page has to say "this is in the file
      // and doing nothing" instead of drawing it as the value.
      const onDisk = JSON.parse(await readFile(join(dir, 'overrides.json'), 'utf8'))
      await writeFile(join(dir, 'overrides.json'), JSON.stringify({ ...onDisk, POE_MAX_LISTINGS: '99' }), 'utf8')
      await evalJs('document.getElementById("admReload").click()')
      await waitFor(`(() => { const t = document.querySelector('[data-cfg="POE_MAX_LISTINGS"]'); return t && t.closest('tr').querySelector('.cfgflag.invalid') })()`,
        'the refused entry was not marked as such')
      const invalid = await evalJs(rowJs('POE_MAX_LISTINGS'))
      assert.match(invalid.invalid, /not allowed, so it does nothing/)
      assert.equal(invalid.value, '7', 'the field shows the value in force, not the refused one')

      // ---- the way back -------------------------------------------------------
      await evalJs(`document.querySelector('[data-cfg-reset="POE_LEAGUE"]').click()`)
      await waitFor(`(() => { const t = document.querySelector('[data-cfg="POE_LEAGUE"]'); return t && !t.closest('tr').querySelector('[data-cfg-reset]') })()`,
        'the override was not removed')
      const back = await evalJs(rowJs('POE_LEAGUE'))
      assert.equal(back.source, 'built-in default')
      assert.equal(back.value, 'Standard')
      assert.equal(JSON.parse(await readFile(join(dir, 'overrides.json'), 'utf8')).POE_LEAGUE, undefined)

      // ---- the read-only block, and the rule that governs all of this ---------
      assert.ok(await evalJs('document.querySelectorAll("#cfgRuntime .rtrow").length > 5'),
        'the read-only runtime list stayed empty')
      const names = await evalJs('[...document.querySelectorAll("#cfgRuntime .rtrow .k")].map(e => e.textContent)')
      for (const n of Array.from(names)) {
        assert.ok(!/SESSID|PASSWORD|TOKEN|SECRET|ACCOUNT|KEY/i.test(n), `the read-only list names ${n}`)
      }
      // Nothing on the whole page may look like a credential, whatever the
      // server sent: the page must not be the hole the endpoint closed.
      const html = await evalJs('document.documentElement.outerHTML')
      assert.ok(!/POESESSID\s*[:=]\s*\w/i.test(String(html)), 'something that reads like a session cookie is on the page')

      // The notice is about the DEFAULT password, not about there being one:
      // change the file and it is gone on the next request, with no restart —
      // the file is read on every one of them (admin-auth.mjs).
      await writeFile(join(dir, 'admin-password'), 'not-the-default\n', 'utf8')
      const changed = await (await fetch(srv.base + '/config-view',
        { headers: { 'X-Admin-Password': 'not-the-default' } })).json()
      assert.equal(changed.adminGateIsDefault, false)
      await writeFile(join(dir, 'admin-password'), 'admin\n', 'utf8')

      // The admin area is still the admin area: none of this is reachable
      // without the password.
      const anon = await fetch(srv.base + '/config-view')
      assert.equal(anon.status, 401)
    } finally {
      srv.kill()
      await sleep(200)
    }
  })

test('a quarantined override set is the first thing in the admin area', { timeout: 240_000 }, async () => {
  const dir = join(tmp, 'quarantine')
  // The marker is what "starts with these overrides did not come up" looks like
  // on disk (config-overrides.mjs). Planting it is the only honest way to reach
  // the state without crashing a server on purpose — and it is planted with the
  // failure count already AT the threshold, because a single failed start
  // deliberately does not quarantine anything any more. The body comes from the
  // module, so the page test cannot drift from the format the server writes.
  await writeFile(join(dir, 'overrides.json'), JSON.stringify({ POE_APP_NAME: 'Broken' }), 'utf8')
    .catch(async () => { await rm(dir, { recursive: true, force: true }) })
  const srv0 = await startServer(dir)   // creates the directory and the password file
  srv0.kill()
  await sleep(300)
  await writeFile(join(dir, 'overrides.json'), JSON.stringify({ POE_APP_NAME: 'Broken' }), 'utf8')
  await writeFile(join(dir, 'overrides.applying'), markerBody(QUARANTINE_AFTER_FAILED_STARTS), 'utf8')

  const srv = await startServer(dir)
  try {
    await S('Network.setCookie', { name: 'ppt_user', value: 'player1', url: srv.base + '/' })
    await S('Page.navigate', { url: srv.base + '/settings.html' })
    await evalJs('sessionStorage.clear()')
    await S('Page.navigate', { url: srv.base + '/settings.html' })
    await openAdmin()

    await waitFor('!!document.querySelector("#cfgAlarm .cfgalarm")', 'the quarantine alarm never appeared')
    assert.equal(await text('#cfgAlarm h3'), 'The saved settings were thrown out')
    assert.match(await text('#cfgAlarm p'), /are NOT in effect/)
    assert.match(await text('#cfgAlarm p'), /overrides\.rejected\.json/, 'the alarm names where the set was parked')

    // "Ganz nach oben": the alarm precedes every other block of the admin area,
    // because everything below it describes a configuration that is not running.
    const first = await evalJs(`(() => {
      const view = document.getElementById('admView')
      const alarm = document.querySelector('#cfgAlarm .cfgalarm')
      const blocks = [...view.querySelectorAll('.admblock, .cfgalarm')]
      return blocks[0] === alarm
    })()`)
    assert.ok(first, 'the alarm is not the first block in the admin area')

    // And the overrides really are not in force: the app name is the default.
    const view = await (await fetch(srv.base + '/config-view', { headers: { 'X-Admin-Password': 'admin' } })).json()
    assert.equal(view.quarantined, true)
    assert.equal(view.settings.find(s => s.name === 'POE_APP_NAME').value, 'Trade Console')
  } finally {
    srv.kill()
    await sleep(200)
  }
})

test('the restart button warns first, then survives losing the server and finds its way back',
  { timeout: 240_000 }, async () => {
    const dir = join(tmp, 'restart')
    const port = await freePort()
    let srv = await startServer(dir, {}, port)
    let second = null
    try {
      await S('Network.setCookie', { name: 'ppt_user', value: 'player1', url: srv.base + '/' })
      await S('Page.navigate', { url: srv.base + '/settings.html' })
      await evalJs('sessionStorage.clear()')
      await S('Page.navigate', { url: srv.base + '/settings.html' })
      await openAdmin()

      // The button says what it costs before it is pressed.
      const note = await text('#cfgRestartNote')
      assert.match(note, /container stops and its supervisor starts it again/)
      assert.match(note, /\bback in about \d+ seconds\b/, 'the note has to name a duration')
      assert.match(note, /background stash sync/, 'and say what is cut off')

      // Declining the confirmation does nothing at all — and the question that
      // was asked names the condition under which the tool comes back, because
      // this is the only button on the page that can make the page unreachable.
      await evalJs('window.__asked = null; window.confirm = q => { window.__asked = q; return false }')
      await evalJs('document.getElementById("cfgRestart").click()')
      await sleep(300)
      const asked = await evalJs('window.__asked')
      assert.match(String(asked), /restart policy/, 'the confirmation must name the precondition')
      assert.match(String(asked), /restart: unless-stopped/, 'and name it concretely enough to act on')
      assert.match(String(asked), /until somebody starts it again on the host/)
      assert.ok(await evalJs('document.getElementById("cfgRestartState").hidden'), 'a declined restart said something')
      assert.ok(await (await fetch(srv.base + '/health')).ok, 'a declined restart stopped the server')

      // ---- the real thing ---------------------------------------------------
      await evalJs('window.confirm = () => true')
      await evalJs('document.getElementById("cfgRestart").click()')
      // Losing the connection is the NORMAL course here, so it must read as a
      // restart in progress and not as an error.
      await waitFor('!document.getElementById("cfgRestartState").hidden', 'the restart was not announced')
      assert.equal(await text('#cfgRestartState'), 'Restarting — waiting for the server to answer again…')
      assert.ok(!(await evalJs('document.getElementById("cfgRestartState").classList.contains("bad")')),
        'a normal restart must not be drawn as a failure')

      // The process really ends — that is what makes a supervisor bring it back.
      await new Promise(resolve => {
        if (srv.proc.exitCode !== null) return resolve()
        srv.proc.once('exit', resolve)
      })

      // Stand in for `restart: unless-stopped`: the same port answers again.
      second = await startServer(dir, {}, port)
      await waitFor(`document.getElementById('cfgRestartState').textContent === 'The server is back.'`,
        async () => 'the page never noticed the server coming back — it says: ' + await text('#cfgRestartState'), 300)
      assert.ok(await evalJs('document.getElementById("cfgRestartState").classList.contains("ok")'))
      // And it re-read the view, so what is on screen is the new process's
      // state: four tables again — live, restart, and the request-volume block
      // with its own live/restart split inside.
      await waitFor('document.querySelectorAll("#cfgTables table.cfgtab").length === 4',
        'the settings were not re-read after the restart')
    } finally {
      try { srv.kill() } catch {}
      if (second) second.kill()
      await sleep(200)
    }
  })

test('a restart that never comes back names the missing restart policy, and says so again after a reload',
  { timeout: 240_000 }, async () => {
    const dir = join(tmp, 'stranded')
    const port = await freePort()
    let srv = await startServer(dir, {}, port)
    let second = null
    try {
      await S('Network.setCookie', { name: 'ppt_user', value: 'player1', url: srv.base + '/' })
      await S('Page.navigate', { url: srv.base + '/settings.html' })
      await evalJs('sessionStorage.clear(); localStorage.removeItem("ppt_restart_stranded")')
      await S('Page.navigate', { url: srv.base + '/settings.html' })
      await openAdmin()

      // The giving-up path, reached in seconds instead of in two minutes. The
      // page's wait budget is wall-clock, so the clock is what the test speeds
      // up — no seam in the page, and the polling loop really runs, it just
      // runs out of time twenty times faster. /health is refused for good
      // measure, because after this the server really is going away.
      await evalJs(`(() => {
        const realNow = Date.now
        const t0 = realNow()
        Date.now = () => { const n = realNow(); return n + (n - t0) * 19 }
        const realFetch = window.fetch
        window.fetch = (u, o) => (String(u) === '/health' ? Promise.reject(new Error('down')) : realFetch(u, o))
      })()`)
      await evalJs('window.confirm = () => true')
      await evalJs('document.getElementById("cfgRestart").click()')
      await new Promise(resolve => {
        if (srv.proc.exitCode !== null) return resolve()
        srv.proc.once('exit', resolve)
      })

      // Bring the server back so the page can be RELOADED — the operator who
      // hits this is the one who has just started the tool again by hand.
      second = await startServer(dir, {}, port)
      await waitFor('document.getElementById("cfgRestartState").classList.contains("bad")',
        async () => 'the page never gave up — it says: ' + await text('#cfgRestartState'), 1500)
      const gone = await text('#cfgRestartState')
      assert.match(gone, /nothing started it again/, 'the message must name the likely cause')
      assert.match(gone, /a container without a restart policy stays down/)
      assert.match(gone, /restart: unless-stopped/, 'and what to change so it works next time')

      // It outlives the page: an accidental reload must not lose the one piece
      // of advice the operator now needs.
      await S('Page.navigate', { url: `http://127.0.0.1:${port}/settings.html` })
      await openAdmin()
      await waitFor('!document.getElementById("cfgRestartState").hidden',
        'the advice did not survive the reload')
      assert.match(await text('#cfgRestartState'), /did not come back on its own/)
      assert.match(await text('#cfgRestartState'), /restart: unless-stopped/)
    } finally {
      try { srv.kill() } catch {}
      if (second) second.kill()
      await evalJs('localStorage.removeItem("ppt_restart_stranded")').catch(() => {})
      await sleep(200)
    }
  })

// ---------------------------------------------------------------------------
// The update button. Its host half is a script this test does not run — it
// STANDS IN for it, by writing the same three files into the same directory:
// that is the whole contract between the two sides, and testing against the
// contract is what proves the page works with any updater that honours it
// (deploy/host-update.sh is exercised for real in host-update-script.test.mjs).
//
// What is worth pinning here is what a stranger would otherwise misread:
//   - without an updater the button is VISIBLE and disabled, with the sentence
//     that says what to install. Hiding it would be how nobody ever sets it up.
//   - the confirmation says what an update costs before anything happens.
//   - a request really becomes a file, and nothing from the page reaches it.
//   - the page notices the host finishing, both ways round.
//   - the host's output is TEXT. It comes from another machine, and the one
//     thing it must never become is markup in this page.
test('the update button: disabled without an updater, and the whole round trip with one',
  { timeout: 240_000 }, async () => {
    const dir = join(tmp, 'update')
    await mkdir(dir, { recursive: true })
    const srv = await startServer(dir, { POE_UPDATE_DIR: dir, POE_BUILD_COMMIT: 'cafe123' })
    const requestPath = join(dir, 'update-request')
    const heartbeatPath = join(dir, 'update-heartbeat')
    const resultPath = join(dir, 'update-result')
    try {
      await S('Network.setCookie', { name: 'ppt_user', value: 'player1', url: srv.base + '/' })
      await S('Page.navigate', { url: srv.base + '/settings.html' })
      await evalJs('sessionStorage.clear()')
      await S('Page.navigate', { url: srv.base + '/settings.html' })
      await openAdmin()

      // ---- no updater: seen, explained, and not pressable -------------------
      await waitFor('document.getElementById("updBuild").textContent.length > 0', 'the update block never rendered')
      assert.match(await text('#updBuild'), /built from commit cafe123/,
        'the running commit is the first thing an update needs to know')
      assert.equal(await evalJs('document.getElementById("updBtn").disabled'), true)
      assert.ok(!(await evalJs('document.getElementById("updBtn").closest(".admblock").hidden')),
        'the block is not hidden — somebody who never sees it never sets it up')
      assert.match(await text('#updSetup'), /^No update script is set up on the host/)
      assert.match(await text('#updSetup'), /deploy\/host-update\.sh/, 'and it names what to install')
      assert.match(await text('#updSetup'), /docs\/admin\.md/, 'and where to read about it')

      // ---- the host script announces itself ---------------------------------
      await writeFile(heartbeatPath, 'at=2026-01-01T00:00:00Z\n')
      await evalJs('document.getElementById("admReload").click()')
      await waitFor('document.getElementById("updBtn").disabled === false',
        'a fresh heartbeat did not enable the button')
      assert.ok(await evalJs('document.getElementById("updSetup").hidden'))
      assert.match(await text('#updLast'), /update script last reported in at/)

      // ---- declining changes nothing ----------------------------------------
      await evalJs('window.__asked = null; window.confirm = q => { window.__asked = q; return false }')
      await evalJs('document.getElementById("updBtn").click()')
      await sleep(300)
      const asked = String(await evalJs('window.__asked'))
      assert.match(asked, /rebuilds the image/, 'the confirmation says what actually happens')
      assert.match(asked, /longer than a restart/, 'and that it is not a restart')
      assert.match(asked, /cut off/, 'and what it costs')
      assert.equal(existsSync(requestPath), false, 'a declined update still asked the host')

      // ---- pressing it writes the request and says it is waiting ------------
      await evalJs('window.confirm = () => true')
      await evalJs('document.getElementById("updBtn").click()')
      await waitFor(`document.getElementById('updState').textContent.startsWith('Requested at')`,
        async () => 'the request was not announced — the page says: ' + await text('#updState'))
      assert.ok(existsSync(requestPath), 'the request is a file in the shared volume, not a state of this tab')
      const written = await readFile(requestPath, 'utf8')
      assert.match(written, /requested-by=player1/, 'the identity cookie names a configured user, so it is recorded')
      assert.equal(/[;&|`]/.test(written.replace(/^#.*$/gm, '')), false, 'and nothing that could be a command')

      // ---- the host finishes: the page notices without being told -----------
      // The stand-in for `docker compose up -d --build` succeeding.
      await writeFile(resultPath,
        'status=ok\nstarted=2026-01-01T00:00:00Z\nfinished=2026-01-01T00:04:00Z\n--- output ---\nContainer recreated\n')
      await waitFor(`document.getElementById('updState').textContent.startsWith('Updated')`,
        async () => 'the page never noticed the host finishing — it says: ' + await text('#updState'), 300)
      assert.match(await text('#updState'), /commit cafe123/, 'and it names the commit it is on now')
      assert.ok(await evalJs('document.getElementById("updState").classList.contains("ok")'))
      assert.ok(await evalJs('document.getElementById("updOut").hidden'),
        'a successful build log is noise and stays out of the way')

      // ---- and a failure, with the host output shown as TEXT ----------------
      // The excerpt comes from a machine outside this tool. If it could become
      // markup, the update button would be a way to script this page.
      await evalJs('document.getElementById("updBtn").click()')
      await waitFor(`document.getElementById('updState').textContent.startsWith('Requested at')`,
        'the second request was not announced')
      await sleep(50)
      await writeFile(resultPath, [
        'status=failed',
        'started=2026-02-02T00:00:00Z',
        'finished=2026-02-02T00:02:00Z',
        '--- output ---',
        '<img src=x onerror="window.__xss = 1">',
        'error: step 3 failed',
        ''
      ].join('\n'))
      await waitFor(`document.getElementById('updState').classList.contains('bad')`,
        async () => 'a failed update was not reported — the page says: ' + await text('#updState'), 300)
      assert.match(await text('#updState'), /^The host tried and failed/)
      assert.ok(!(await evalJs('document.getElementById("updOut").hidden')), 'the output is shown for a failure')
      assert.match(await text('#updOut'), /error: step 3 failed/)
      assert.equal(await evalJs('document.querySelectorAll("#updOut img").length'), 0,
        'the host output became an element in this page')
      assert.equal(await evalJs('window.__xss || null'), null)
      assert.ok(await evalJs(`document.getElementById('updOut').textContent.includes('<img src=x')`),
        'it is shown verbatim, as text — that is the point')

      assert.equal(await evalJs('document.getElementById("updBtn").disabled'), false,
        'a failure leaves the button usable: pressing again is the retry')

      // The excerpt never travels without the sentence that says how far its
      // filtering goes: it drops lines that NAME a credential and masks the
      // ones inside a URL, and a bare token passes it. Whoever pastes this into
      // a bug report has to know that before they do.
      assert.ok(!(await evalJs('document.getElementById("updOutNote").hidden')))
      assert.match(await text('#updOutNote'), /filter, not a guarantee/)

      // ---- and the state the page used to paper over ------------------------
      // An updater whose lock a dead run left behind keeps writing its
      // heartbeat and picks nothing up. By every measure the page had, it was
      // healthy — so the script says so in the heartbeat, and what the page
      // must NOT do is go on offering a button that writes a request nobody
      // will ever read.
      await writeFile(heartbeatPath, 'at=2026-01-01T00:00:00Z\nstuck-since=2026-01-01T00:00:00Z\n')
      await evalJs('document.getElementById("admReload").click()')
      await waitFor('document.getElementById("updBtn").disabled === true',
        async () => 'a stuck updater still offered its button — the page says: ' + await text('#updStuck'))
      assert.ok(!(await evalJs('document.getElementById("updStuck").hidden')))
      assert.match(await text('#updStuck'), /^The update script on the host is stuck/)
      assert.match(await text('#updStuck'), /update\.lock/, 'and it names what has to be removed')
      assert.ok(await evalJs('document.getElementById("updSetup").hidden'),
        'and it does not also claim nothing is installed — this one is installed, and wedged')
    } finally {
      try { srv.kill() } catch {}
      await sleep(200)
    }
  })
