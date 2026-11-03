// The Net-Worth table has to say which numbers it does not trust
// (docs/pricing-logic.md, "Uncertain prices"). Three parts:
//
//   1. Without a browser: every reason code the valuator can emit
//      (networth/valuator.mjs UNCERTAIN) has a label and an explanation in
//      every shipped language, and the page knows exactly those codes.
//   2. In a real Chrome on the booted server (pattern:
//      networth-source-column.test.mjs): the Confidence column, the amber
//      amounts, the "incl. X uncertain" line under the headline that still
//      counts every row, the tab scoping of that line, the "Uncertain only"
//      filter (on the table and on Stash Highlight) and the sort by the column.
//   3. docs/admin.md keeps its explanation where an operator looks for it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { QUIET_ENV } from '../test-quiet-env.mjs'
import vm from 'node:vm'
import { UNCERTAIN } from '../networth/valuator.mjs'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable'

// i18n.js is a classic browser script; a bare `window` is enough to load it
// (same as i18n-coverage.test.mjs, not imported from there: importing a test
// file would run its tests a second time).
async function loadI18n () {
  const src = await readFile(fileURLToPath(new URL('./i18n.js', import.meta.url)), 'utf8')
  const ctx = vm.createContext({ window: {}, localStorage: undefined })
  vm.runInContext(src, ctx, { filename: 'i18n.js' })
  return ctx.window.I18n
}

test('every uncertainty code the valuator can emit has a label and an explanation in every language', async () => {
  const I18n = await loadI18n()
  const codes = Object.values(UNCERTAIN)
  assert.equal(codes.length, 5)
  for (const lang of Array.from(I18n.languages())) {
    for (const code of codes) {
      for (const key of [`nw.unc.${code}`, `nw.uncWhy.${code}`]) {
        const v = I18n.STRINGS[lang][key]
        assert.ok(typeof v === 'string' && v.length > 0, `${lang}.${key} is missing`)
      }
    }
  }
  // The page's own list of codes is the valuator's list — a code the page does
  // not know would be shown raw, so a mismatch is a missing translation.
  const src = await readFile(fileURLToPath(new URL('./networth.js', import.meta.url)), 'utf8')
  const m = /const UNC_CODES = \[([^\]]*)\]/.exec(src)
  assert.ok(m, 'networth.js declares UNC_CODES')
  const pageCodes = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
  assert.deepEqual(pageCodes, codes)
  // Nothing may claim a price is checked: no label says ok or verified.
  for (const lang of Array.from(I18n.languages())) {
    for (const [k, v] of Object.entries(I18n.STRINGS[lang])) {
      if (!/^nw\.(unc|uncWhy|colTrust|uncertain|uncOnly)/.test(k)) continue
      assert.doesNotMatch(v, /\b(ok|verified|verifiziert|geprüft)\b/i, `${lang}.${k} claims a check nobody made`)
    }
  }
})

// The operator looks for the marker under the Net-Worth-Tracker in
// docs/admin.md. It sat at the tail of "When the refresher goes quiet" (a
// subsection about the tab list) once, where nobody scanning the headings
// finds it; it has a heading of its own inside the tracker's section.
test('docs/admin.md explains the marker under a heading of its own in the Net-Worth-Tracker section', async () => {
  const md = await readFile(join(ROOT, 'docs/admin.md'), 'utf8')
  const from = md.indexOf('\n### Net-Worth-Tracker')
  const to = md.indexOf('\n### ', from + 1)
  assert.ok(from >= 0 && to > from, 'admin.md has a Net-Worth-Tracker section')
  const section = md.slice(from, to)
  const at = section.indexOf('\n#### Uncertain prices\n')
  assert.ok(at >= 0, 'no "#### Uncertain prices" heading in the Net-Worth-Tracker section')
  const body = section.slice(at + 1).split('\n#### ')[0]
  for (const name of ['POE_NETWORTH_THIN_TURNOVER_C', 'POE_NETWORTH_CORPSE_MIN_LISTINGS', 'pricing-logic.md#uncertain-prices--marked-and-still-counted']) {
    assert.ok(body.includes(name), `the Uncertain prices subsection does not name ${name}`)
  }
})

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// player1: two tabs, two uncertain rows (one per tab), one certain row and one
// row from a backend that predates the field. Total 994.4c, of it 364.4c
// uncertain; cdRatio 214 -> 1.7 div.
// player2: nothing uncertain at all.
function mockStore () {
  const tab = (index, name, items) => ({
    index, name, syncedAt: Date.now(), items, unpriced: [],
    counts: { priced: items.length, unpriced: 0, unpricedPieces: 0, skipped: 0 }
  })
  const user = tabs => ({ accountName: 'acct', league: 'Standard', cdRatio: 214, tabs, history: [] })
  return JSON.stringify({
    schema_version: 2,
    users: {
      player1: user({
        0: tab(0, 'A', [
          { name: 'Divine Orb', kind: 'stackable', tab: 'A', tabIndex: 0, qty: 3, chaosEach: 200, chaosTotal: 600, source: 'faustus', uncertain: null },
          { name: 'Imperial Legacy', kind: 'divcard', tab: 'A', tabIndex: 0, qty: 14, chaosEach: 4.6, chaosTotal: 64.4, source: 'exchange:DivinationCard', uncertain: 'thin-market' }
        ]),
        1: tab(1, 'B', [
          { name: 'Enlighten Support', kind: 'gem', tab: 'B', tabIndex: 1, qty: 1, chaosEach: 300, chaosTotal: 300, source: 'item:SkillGem', uncertain: 'gem-guessed' },
          { name: 'Ancient Orb', kind: 'stackable', tab: 'B', tabIndex: 1, qty: 1, chaosEach: 30, chaosTotal: 30, source: 'exchange' }
        ])
      }),
      player2: user({
        0: tab(0, 'A', [
          { name: 'Divine Orb', kind: 'stackable', tab: 'A', tabIndex: 0, qty: 3, chaosEach: 200, chaosTotal: 600, source: 'faustus', uncertain: null }
        ])
      })
    }
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

test('the page marks uncertain rows, counts them in the total and says how much of it they are', { timeout: 120_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-unc-'))
  const port = await freePort()
  const dbg = await freePort()
  await writeFile(join(tmp, 'networth-store.json'), mockStore(), 'utf8')

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...QUIET_ENV,
      PORT: String(port),
      POE_USERS: 'player1,player2',
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_AUTOSYNC: '0',
      POE_FAUSTUS_DISABLED: '1',
      POE_CORPSE_DISABLED: '1',
      POE_DATA_REFRESH_DISABLED: '1',
      POE_REFERENCE_DISABLED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const srvLog = []
  srv.stdout.on('data', d => srvLog.push(String(d)))
  srv.stderr.on('data', d => srvLog.push(String(d)))

  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/users`); if (r.ok) break } catch {}
    await sleep(100)
  }

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${dbg}`, `--user-data-dir=${join(tmp, 'chrome')}`,
    '--window-size=1280,900', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let verUrl = null
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${dbg}/json/version`)
      if (r.ok) { verUrl = (await r.json()).webSocketDebuggerUrl; break }
    } catch {}
    await sleep(100)
  }
  assert.ok(verUrl, 'Chrome DevTools reachable')

  const cdp = await cdpConnect(verUrl)
  const base = `http://127.0.0.1:${port}`
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p) => cdp.send(m, p, sessionId)
  await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable')

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  const names = () => evalJs(
    `[...document.querySelectorAll('#wrap tbody tr')].map(tr =>
       tr.querySelector('.iname').textContent.replace(tr.querySelector('.kb')?.textContent || '', '').trim())`)
  const rowOf = name => `[...document.querySelectorAll('#wrap tbody tr')].find(tr => tr.querySelector('.iname').textContent.includes(${JSON.stringify(name)}))`
  const subLine = () => evalJs(`(() => { const e = document.getElementById('totalUncertain'); return { hidden: e.hidden, text: e.textContent } })()`)
  const open = async user => {
    await S('Network.setCookie', { name: 'ppt_user', value: user, url: base + '/' })
    await S('Page.navigate', { url: base + '/networth.html' })
    for (let i = 0; i < 100; i++) {
      if ((await evalJs(`document.querySelectorAll('#wrap tbody tr').length`)) >= 1) break
      await sleep(100)
    }
    await evalJs(`document.querySelector('#viewSeg button[data-v="list"]').click()`)
  }

  try {
    await open('player1')
    assert.deepEqual(
      await evalJs(`[...document.querySelectorAll('#wrap thead th')].map(th => th.textContent.replace(/[▲▼]/g, ''))`),
      ['Item', 'Tab', 'Qty', 'Each', 'Total', 'Confidence', 'Source'], 'the table has a Confidence column\n' + srvLog.join(''))

    // An uncertain row names its doubt, with the reason in the tooltip; a
    // certain row and a row from an older backend stay blank — never "ok".
    const cell = name => evalJs(`(() => { const td = ${rowOf(name)}.querySelector('.unccell'); const s = td.querySelector('.unc'); return { text: td.textContent, title: s ? s.title : null } })()`)
    const il = await cell('Imperial Legacy')
    assert.equal(il.text, 'thin market')
    assert.match(il.title, /^Very little trading stands behind this price\./)
    assert.equal((await cell('Divine Orb')).text, '')
    assert.equal((await cell('Ancient Orb')).text, '', 'a row stored before the field existed is not marked')
    assert.equal(await evalJs(`[...${rowOf('Imperial Legacy')}.querySelectorAll('td.uncv')].length`), 2,
      'Each and Total of an uncertain row are set apart')
    assert.equal(await evalJs(`${rowOf('Divine Orb')}.querySelectorAll('td.uncv').length`), 0)

    // The headline still counts every row; the line under it says how much of
    // it rests on uncertain prices.
    assert.equal(await evalJs(`document.getElementById('totalChaos').textContent`), '994.4 c')
    let sub = await subLine()
    assert.equal(sub.hidden, false)
    assert.match(sub.text, /^incl\. 1\.7 div uncertain$/)

    // The line follows the tab selection, like the headline.
    await evalJs(`document.querySelector('.tabrow[data-idx="1"]').click()`)
    sub = await subLine()
    // Tab 1 unchecked: only Imperial Legacy (64.4c, printed whole like every
    // chaos amount on the page) is left of the uncertain value.
    assert.match(sub.text, /^incl\. 64 c uncertain$/)
    assert.equal(await evalJs(`document.getElementById('totalChaos').textContent`), '664.4 c')
    await evalJs(`document.querySelector('.tabrow[data-idx="0"]').click()`)
    sub = await subLine()
    assert.equal(sub.hidden, true, 'no uncertain value in the selection -> no line')
    // Both back on (unchecked -> ignored -> on).
    for (const idx of [0, 1]) {
      await evalJs(`document.querySelector('.tabrow[data-idx="${idx}"]').click()`)
      await evalJs(`document.querySelector('.tabrow[data-idx="${idx}"]').click()`)
    }
    assert.equal((await names()).length, 4)

    // "Uncertain only" leaves exactly the marked rows.
    assert.equal(await evalJs(`document.getElementById('uncOnly').hidden`), false)
    await evalJs(`document.getElementById('uncOnly').click()`)
    assert.deepEqual(await names(), ['Enlighten Support', 'Imperial Legacy'])
    assert.equal(await evalJs(`document.getElementById('uncOnly').classList.contains('on')`), true)
    // ... and Stash Highlight with it, to find those rows in game. Today that
    // holds only because renderHighlight gets the same filtered rows as the
    // table; this pins it. The search string is one quoted alternation of
    // fragments ("abc|de f"), so it is read the way the game reads it.
    const hlMatches = async () => {
      let text = ''
      for (let i = 0; i < 100 && !text; i++) {
        text = await evalJs(`document.getElementById('hlText').value`)
        if (!text) await sleep(100)
      }
      assert.match(text, /^".+"$/, 'Stash Highlight produced no search string')
      const toks = text.slice(1, -1).split('|').map(t => t.toLowerCase())
      return name => toks.some(t => name.toLowerCase().includes(t))
    }
    await evalJs(`document.getElementById('hlToggle').click()`)
    let hit = await hlMatches()
    for (const n of ['Enlighten Support', 'Imperial Legacy']) assert.ok(hit(n), `${n} is marked and missing from the search string`)
    for (const n of ['Divine Orb', 'Ancient Orb']) assert.ok(!hit(n), `${n} is not marked and still lit by the search string`)
    await evalJs(`document.getElementById('uncOnly').click()`)
    assert.equal((await names()).length, 4)
    hit = await hlMatches()
    assert.ok(hit('Divine Orb'), 'with the filter off the search string covers the unmarked rows again')
    await evalJs(`document.getElementById('hlToggle').click()`)

    // Sorting by the column puts the marked rows first.
    await evalJs(`document.querySelector('#wrap thead th[data-k="uncertain"]').click()`)
    assert.deepEqual((await names()).slice(0, 2).sort(), ['Enlighten Support', 'Imperial Legacy'])

    // Nothing uncertain: no filter button, no line.
    await open('player2')
    assert.equal(await evalJs(`document.getElementById('uncOnly').hidden`), true)
    assert.equal((await subLine()).hidden, true)
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
