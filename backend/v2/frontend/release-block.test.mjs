// Browser test (headless Chrome, same setup as settings-page.test.mjs): the
// "Releases" block on the settings page and its "Check for updates" button.
//
// The server is real, the answers of the two release endpoints are not: a
// script injected before the page's own code replaces `fetch` for exactly
// GET /release-status and POST /admin/release-check and serves what the test
// put into sessionStorage. Nothing here can reach GitHub — the server under
// test has the release check switched off (QUIET_ENV) and the stub answers
// before any request leaves the page.
//
// What is pinned: the block is readable WITHOUT the admin password, the three
// states of the "latest release" line (a release, none yet, a failed check
// with the advice for its class), the pointer links built from the `repo` the
// server reports, and the button — shut until the admin area has loaded, and
// reporting the server's own cooldown rather than a number of its own. Also: a
// `release-status` socket message redraws the block, a result sentence follows a
// language change, and the "next automatic check" sentence is only said while
// the automatic check is on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { QUIET_ENV } from '../test-quiet-env.mjs'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable'

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

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

// Runs before the page's own scripts on every navigation.
const FETCH_STUB = `(() => {
  const real = window.fetch.bind(window)
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  // The real socket would push the real (never-checked) status over the canned
  // one a moment after load. This page needs no other message, so it gets a
  // socket that never connects.
  // Its listeners are kept in window.__ws so a test can deliver a message by hand.
  window.__ws = {}
  window.WebSocket = class {
    static OPEN = 1
    constructor () { this.readyState = 0 }
    addEventListener (type, fn) { window.__ws[type] = fn }
    send () {} close () {}
  }
  window.fetch = (url, opts) => {
    try {
      const u = String(url)
      if (u.endsWith('/release-status')) {
        const s = sessionStorage.getItem('__relStatus')
        if (s) return Promise.resolve(json(200, JSON.parse(s)))
      }
      if (u.endsWith('/admin/release-check') && opts && opts.method === 'POST') {
        const p = JSON.parse(sessionStorage.getItem('__relPost') || 'null')
        if (p) return Promise.resolve(json(p.status, p.body))
      }
    } catch {}
    return real(url, opts)
  }
})()`

const BASE_STATUS = {
  enabled: true, installed: '0.1.0', repo: 'owner/repo', lastCheckAt: '2026-11-02T08:00:00Z',
  nextCheckAt: '2026-11-03T08:00:00Z', lastOutcome: 'ok', lastFailKind: null, lastReason: null,
  latest: { version: '0.2.0', tag: 'v0.2.0', url: 'https://example.test/r', publishedAt: '2026-11-01T00:00:00Z', name: 'x' },
  comparison: 'newer', cooldownMs: 60000
}

test('settings page: the Releases block and the Check for updates button', { timeout: 180_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-relblk-'))
  const port = await freePort()
  const dbg = await freePort()

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...QUIET_ENV,
      PORT: String(port),
      POE_USERS: 'player1,player2',
      POE_NETWORTH_CONFIG: join(tmp, 'networth-users.json'),
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_AUTOSYNC: '0',
      POE_FAUSTUS_DISABLED: '1',
      POE_CORPSE_DISABLED: '1',
      POE_DATA_REFRESH_DISABLED: '1',
      POE_REFERENCE_DISABLED: '1',
      POE_RELEASE_CHECK_STATE: join(tmp, 'release-check.json'),
      POE_CONFIG_OVERRIDES: join(tmp, 'overrides.json'),
      POE_ADMIN_PASSWORD_FILE: join(tmp, 'admin-password')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const srvLog = []
  srv.stdout.on('data', d => srvLog.push(String(d)))
  srv.stderr.on('data', d => srvLog.push(String(d)))
  for (let i = 0; i < 300; i++) {
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
  await S('Page.enable'); await S('Runtime.enable')
  await S('Page.addScriptToEvaluateOnNewDocument', { source: FETCH_STUB })
  await S('Network.enable')
  await S('Network.setCookie', { name: 'ppt_user', value: 'player1', url: base + '/' })

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  const waitFor = async (expr, what) => {
    for (let i = 0; i < 100; i++) {
      try { if (await evalJs(expr)) return } catch {}
      await sleep(100)
    }
    assert.fail(`${what}\n` + srvLog.join(''))
  }
  const text = id => evalJs(`document.getElementById(${JSON.stringify(id)}).textContent`)
  const t = (key, params) => evalJs(`I18n.t(${JSON.stringify(key)}, ${JSON.stringify(params || {})})`)
  // Load the settings page with the stub serving `status`.
  const open = async (status, post) => {
    await S('Page.navigate', { url: base + '/settings.html' })
    await waitFor(`location.origin === ${JSON.stringify(base)} && document.readyState !== 'loading'`, 'page did not load')
    await evalJs(`sessionStorage.setItem('__relStatus', ${JSON.stringify(JSON.stringify(status))})`)
    if (post !== undefined) await evalJs(`sessionStorage.setItem('__relPost', ${JSON.stringify(JSON.stringify(post))})`)
    await evalJs(`window.__stale = true`) // gone with the document: tells the old page from the new one
    await S('Page.navigate', { url: base + '/settings.html' })
    await waitFor(`!window.__stale && document.getElementById('relInstalled') && document.getElementById('relInstalled').textContent.length > 0`,
      'the Releases block never rendered')
  }

  try {
    // ---- a newer release, no admin password anywhere -------------------------
    await open(BASE_STATUS)
    assert.ok(await evalJs(`document.getElementById('admView').hidden`), 'the admin area is closed — the block must not need it')
    assert.equal(await evalJs(`document.getElementById('relBlock').offsetParent !== null`), true, 'the block is visible')
    assert.match(await text('relInstalled'), /0\.1\.0/)
    assert.match(await text('relLatest'), /0\.2\.0/)
    assert.equal(await evalJs(`document.querySelector('#relLatest a').getAttribute('href')`), 'https://example.test/r')
    assert.deepEqual(await evalJs(`[...document.querySelectorAll('#relPointer a')].map(a => a.getAttribute('href'))`), [
      'https://github.com/owner/repo/blob/main/docs/admin.md#update-procedure',
      'https://github.com/owner/repo/blob/main/README.md#updating'
    ])
    assert.ok(await evalJs(`document.getElementById('relCheckBtn').disabled`), 'the button stays shut until the admin area has loaded')

    // ---- a link that is not https is not made a link -------------------------
    await open({ ...BASE_STATUS, latest: { ...BASE_STATUS.latest, url: 'javascript:alert(1)' } })
    assert.equal(await evalJs(`document.querySelector('#relLatest a')`), null, 'no anchor for a non-https url')
    assert.match(await text('relLatest'), /0\.2\.0/, 'the version is still shown')

    // ---- no release yet ------------------------------------------------------
    await open({ ...BASE_STATUS, latest: null, lastOutcome: 'none', comparison: 'unknown' })
    assert.equal(await text('relLatest'), await t('rel.latestNone'))
    assert.notEqual(await t('rel.latestNone'), 'rel.latestNone', 'the key exists')

    // ---- never checked, installed version unknown ----------------------------
    await open({ ...BASE_STATUS, installed: null, latest: null, lastOutcome: null, lastCheckAt: null, nextCheckAt: null, comparison: 'unknown' })
    assert.equal(await text('relInstalled'), await t('rel.installedUnknown'))
    assert.equal(await text('relLatest'), await t('rel.latestNotChecked'))

    // ---- a failed check says which kind and what it means --------------------
    await open({ ...BASE_STATUS, lastOutcome: 'failed', lastFailKind: 'rejected', lastReason: 'GitHub refused the request (HTTP 403)' })
    const advice = await t('rel.advice.rejected')
    assert.notEqual(advice, 'rel.advice.rejected', 'the key exists')
    assert.ok((await text('relLastCheck')).includes(advice), 'the advice for the class is on the page')

    // ---- asked, but no answer ever came: unknown, not "not checked" ---------
    await open({ ...BASE_STATUS, latest: null, lastOutcome: 'failed', lastFailKind: 'unreachable', comparison: 'unknown' })
    assert.equal(await text('relLatest'), await t('rel.latestUnknown'))

    // ---- the advice only promises a retry while the automatic check is on ----
    // The block may be read hours after the check, so it names the time of the
    // next try (the server's nextCheckAt), not "in 24 hours".
    const nextAt = await t('rel.adviceNextAt', { when: await evalJs(`new Date(${JSON.stringify(BASE_STATUS.nextCheckAt)}).toLocaleString(I18n.locale())`) })
    assert.notEqual(await t('rel.adviceNextAt', { when: 'X' }), 'rel.adviceNextAt', 'the key exists')
    const failedStatus = { ...BASE_STATUS, lastOutcome: 'failed', lastFailKind: 'unreachable', lastReason: 'x' }
    await open({ ...failedStatus, enabled: true })
    assert.ok((await text('relLastCheck')).includes(nextAt), 'on: the formatted time of the next try is there')
    assert.ok(!(await text('relLastCheck')).includes(await t('rel.adviceNext')), 'on: no relative "in 24 hours" in the block')
    await open({ ...failedStatus, enabled: true, nextCheckAt: null })
    const atPrefix = (await t('rel.adviceNextAt', { when: '@@' })).split('@@')[0]
    assert.ok(!(await text('relLastCheck')).includes(atPrefix), 'on, no nextCheckAt: no time promised')
    await open({ ...failedStatus, enabled: false })
    assert.ok(!(await text('relLastCheck')).includes(nextAt), 'off: no promise of a next automatic check')
    assert.ok((await text('relLastCheck')).includes(await t('rel.advice.unreachable')))
    // ... and off says so.
    const autoOff = await t('rel.autoOff')
    assert.notEqual(autoOff, 'rel.autoOff', 'the key exists')
    assert.ok((await text('relLastCheck')).includes(autoOff), 'off: the block says the automatic check is off')
    await open({ ...BASE_STATUS, enabled: false, lastCheckAt: null, lastOutcome: null, nextCheckAt: null, latest: null, comparison: 'unknown' })
    assert.equal(await text('relLastCheck'), autoOff, 'off and never checked: the sentence stands alone')
    await open(BASE_STATUS)
    assert.ok(!(await text('relLastCheck')).includes(autoOff), 'on: nothing about the check being off')

    // ---- an unclassified failure shows the reason as it is, as text ----------
    await open({ ...BASE_STATUS, lastOutcome: 'failed', lastFailKind: 'unknown', lastReason: 'boom <b>x</b>' })
    assert.ok((await text('relLastCheck')).includes(await t('rel.adviceReason', { reason: 'boom <b>x</b>' })), 'the reason is on the page')
    assert.equal(await evalJs(`document.querySelector('#relLastCheck b')`), null, 'the reason is text, not markup')
    // A classified failure does not print the reason (it has its own sentence).
    await open({ ...BASE_STATUS, lastOutcome: 'failed', lastFailKind: 'rejected', lastReason: 'secret-ish detail' })
    assert.ok(!(await text('relLastCheck')).includes('secret-ish detail'))

    // ---- saving a setting reads the release status again --------------------
    // The switch for the automatic check lives in the admin table; after a save
    // the block must follow it without a page reload.
    await open({ ...BASE_STATUS, enabled: true })
    await evalJs(`sessionStorage.setItem('__relStatus', ${JSON.stringify(JSON.stringify({ ...BASE_STATUS, enabled: false }))})`)
    await evalJs(`document.getElementById('admPass').value = 'admin'`)
    await evalJs(`document.getElementById('admOpen').click()`)
    await waitFor(`!document.getElementById('admView').hidden`, 'the admin view never opened')
    // loading the admin area does not touch the release block; a save does
    assert.ok(!(await text('relLastCheck')).includes(autoOff), 'before any save the block still shows the old state')
    await evalJs(`document.querySelector('[data-cfg="POE_RELEASE_CHECK_DISABLED"]').click()`)
    await waitFor(`document.getElementById('relLastCheck').textContent.includes(${JSON.stringify(autoOff)})`,
      'the block did not follow the saved setting')
    await evalJs(`document.getElementById('admClose').click()`)
    // the override went to this test's own store (POE_CONFIG_OVERRIDES in the temp dir)
    await evalJs(`sessionStorage.removeItem('__relStatus')`)

    // ---- a release-status message from the socket redraws the block ----------
    await open(BASE_STATUS)
    assert.match(await text('relLatest'), /0\.2\.0/)
    await evalJs(`window.__ws.message({ data: ${JSON.stringify(JSON.stringify({
      ...BASE_STATUS, latest: { ...BASE_STATUS.latest, version: '0.3.0' }, type: 'release-status'
    }))} })`)
    await waitFor(`document.getElementById('relLatest').textContent.includes('0.3.0')`, 'the socket message did not redraw the block')

    // ---- the player's hotkey daemon, from `daemon-status` ----------------------
    // Hidden until a daemon-status arrives; without a heartbeat it says so; a
    // daemon that reports a version older than the latest release is told how
    // to update.
    assert.equal(await evalJs(`document.getElementById('relDaemon').hidden`), true)
    await evalJs(`window.__ws.message({ data: ${JSON.stringify(JSON.stringify({
      type: 'daemon-status', lastItemAt: null, outcome: null, now: 1, daemon: null
    }))} })`)
    await waitFor(`document.getElementById('relDaemon').textContent === ${JSON.stringify(await t('rel.daemonNone'))}`,
      'no daemon line for a daemon-status without a heartbeat')
    assert.equal(await evalJs(`document.getElementById('relDaemon').hidden`), false)
    await evalJs(`window.__ws.message({ data: ${JSON.stringify(JSON.stringify({
      type: 'daemon-status', lastItemAt: null, outcome: null, now: 1, daemon: { version: '0.2.9', features: {} }
    }))} })`)
    await waitFor(`document.getElementById('relDaemon').textContent.includes('0.2.9')`, 'the daemon version was not shown')
    assert.match(await text('relDaemon'), /the latest release is 0\.3\.0/)

    // ---- the button: shut, then open after unlocking, then the server's 429 --
    await open(BASE_STATUS, { status: 429, body: { retryAfterMs: 42000, cooldownMs: 60000 } })
    assert.ok(await evalJs(`document.getElementById('relCheckBtn').disabled`))
    await evalJs(`document.getElementById('admPass').value = 'admin'`)
    await evalJs(`document.getElementById('admOpen').click()`)
    await waitFor(`!document.getElementById('admView').hidden`, 'the admin view never opened')
    await waitFor(`!document.getElementById('relCheckBtn').disabled`, 'the button never opened up after the admin area loaded')
    await evalJs(`document.getElementById('relCheckBtn').click()`)
    await waitFor(`document.getElementById('relCheckState').textContent.includes('42')`, 'the cooldown was not reported')
    assert.equal(await text('relCheckState'), await t('rel.resultCooldown', { seconds: 42 }))

    // ---- 409, 401, other, and a good answer ----------------------------------
    const press = async (post, expected) => {
      await evalJs(`sessionStorage.setItem('__relPost', ${JSON.stringify(JSON.stringify(post))})`)
      await evalJs(`document.getElementById('relCheckState').textContent = ''`)
      await evalJs(`document.getElementById('relCheckBtn').click()`)
      await waitFor(`document.getElementById('relCheckState').textContent.length > 0`, 'no result sentence')
      assert.equal(await text('relCheckState'), expected)
      await waitFor(`!document.getElementById('relCheckBtn').disabled`, 'the button did not come back')
    }
    await press({ status: 409, body: { running: true } }, await t('rel.resultRunning'))
    await press({ status: 401, body: {} }, await t('rel.resultUnauthorized'))
    await press({ status: 500, body: {} }, await t('rel.resultHttp', { status: 500 }))
    await press({ status: 200, body: { ok: true, status: { ...BASE_STATUS, comparison: 'current', installed: '0.2.0' } } }, await t('rel.resultUpToDate'))
    assert.match(await text('relInstalled'), /0\.2\.0/, 'the block shows the answer the click produced')
    await press({ status: 200, body: { ok: true, status: BASE_STATUS } }, await t('rel.resultNewer', { version: '0.2.0' }))
    await press({ status: 200, body: { ok: true, status: { ...BASE_STATUS, installed: null, comparison: 'unknown' } } }, await t('rel.resultUnknown', { version: '0.2.0' }))

    // The result sentence is built again when the language changes.
    const before = await text('relCheckState')
    await evalJs(`I18n.setLang('de')`)
    await waitFor(`document.getElementById('relCheckState').textContent !== ${JSON.stringify(before)}`, 'the result sentence stayed in the old language')
    assert.equal(await text('relCheckState'), await t('rel.resultUnknown', { version: '0.2.0' }))
    await evalJs(`I18n.setLang('en')`)
    await press({ status: 200, body: { ok: true, status: { ...BASE_STATUS, latest: null, lastOutcome: 'none', comparison: 'unknown' } } }, await t('rel.resultNone'))

    // Closing the admin area shuts the button again.
    await evalJs(`document.getElementById('admClose').click()`)
    assert.ok(await evalJs(`document.getElementById('relCheckBtn').disabled`))
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
