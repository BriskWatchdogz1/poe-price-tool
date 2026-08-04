// Browser smoke test of the global shell (gitignored, local): boots the REAL
// server and loads all three pages in headless Chrome. Per page it checks: no
// JS exceptions, no 404s on our own assets, rail slots in the DOM
// (nav/league/C:D), status line present and invisible, Shell API usable.
// Structure mirrored from trend-click.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'

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
  const events = []
  ws.on('message', buf => {
    const m = JSON.parse(String(buf))
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    } else if (m.method) events.push(m)
  })
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params }
    if (sessionId) msg.sessionId = sessionId
    pending.set(msg.id, { res, rej })
    ws.send(JSON.stringify(msg))
  })
  return { send, events, close: () => ws.close() }
}

test('all three pages load without errors and show the global shell', { timeout: 180_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-shell-'))
  const port = await freePort()
  const dbg = await freePort()

  // Seed credentials: in the normal state (credentials present, no error) the
  // status line stays empty — exactly what the test below checks. Without the
  // file the net worth page rightly shows "No credentials configured".
  const credPath = join(tmp, 'networth-users.json')
  await writeFile(credPath, JSON.stringify({
    player1: { accountName: 'P1#0001', poesessid: 'testcookie-p1' },
    player2: { accountName: 'P2#0002', poesessid: 'testcookie-p2' }
  }))

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      POE_USERS: 'player1,player2',
      POE_NETWORTH_CONFIG: credPath,
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
  await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable'); await S('Log.enable')
  await S('Network.setCookie', { name: 'ppt_user', value: 'player1', url: base + '/' })

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }

  try {
    // Nav grid: box positions (x/y/w/h) of the user switcher + all four nav
    // entries, collected per page and compared at the end — every entry must
    // sit at exactly the same spot on EVERY page.
    const navRects = {}
    for (const path of ['/', '/networth.html', '/history.html']) {
      cdp.events.length = 0
      await S('Page.navigate', { url: base + path })
      // Wait until the page script has run (WS connected or gate open).
      let ready = false
      for (let i = 0; i < 100; i++) {
        try {
          if (await evalJs(`document.getElementById('connlbl') && document.getElementById('connlbl').textContent !== 'connecting…'`)) { ready = true; break }
        } catch {}
        await sleep(100)
      }
      assert.ok(ready, `${path}: page never got out of "connecting…"\n` + srvLog.join(''))

      // no JS exceptions, none of our own assets broken
      const errs = cdp.events.filter(e =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Network.responseReceived' && e.params.response.status >= 400 &&
         e.params.response.url.startsWith(base) &&
         !e.params.response.url.endsWith('/favicon.ico'))) // favicon has always been missing — not a shell concern
      assert.deepEqual(errs.map(e => e.method === 'Runtime.exceptionThrown'
        ? (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
        : `${e.params.response.status} ${e.params.response.url}`), [], `${path}: errors while loading`)

      // global rail slots visible
      for (const sel of ['.rail .logo', '.rail .navlinks', '#leagueSel', '#cdValue', '.mhead h1', '#conn']) {
        assert.ok(await evalJs(`!!document.querySelector(${JSON.stringify(sel)})`), `${path}: ${sel} missing`)
      }
      // nav: exactly one active entry, four targets
      assert.equal(await evalJs(`document.querySelectorAll('.navlinks .backlink').length`), 3, `${path}: 3 nav entries`)
      assert.equal(await evalJs(`document.querySelectorAll('.navlinks .backlink.on').length`), 1, `${path}: 1 active entry`)
      // status line: present, empty -> invisible; Shell.setStatus reveals it
      assert.ok(await evalJs(`document.getElementById('appStatus').hidden`), `${path}: appStatus must be invisible while empty`)
      assert.ok(await evalJs(`(Shell.setStatus('x'), !document.getElementById('appStatus').hidden)`), `${path}: Shell.setStatus shows the status line`)
      assert.ok(await evalJs(`(Shell.clearStatus(), document.getElementById('appStatus').hidden)`), `${path}: Shell.clearStatus hides it again`)

      // M2: SEVERAL messages share the slot (sync status + data freshness).
      // All of it in ONE synchronous block so that no real WS message can cut
      // in between. Fixed order, neither one overwrites the other.
      const coexist = await evalJs(`(() => {
        const day = 86400000, now = Date.now()
        const keys = () => [...document.querySelectorAll('#appStatus .statusmsg')].map(e => e.dataset.statusKey)
        const texts = () => [...document.querySelectorAll('#appStatus .statusmsg')].map(e => e.textContent)
        Shell.setStatus('SYNC NOTE', 'sync')
        Shell.applyDataStatus({ type: 'data-status', enabled: true, intervalMs: day, staleAfterMs: 3 * day,
          since: now - 10 * day, now, sources: [{ source: 'base-names', lastSuccessAt: now - 5 * day }] })
        const both = { keys: keys(), texts: texts() }
        Shell.clearStatus('sync')
        const afterSync = { keys: keys(), hidden: document.getElementById('appStatus').hidden }
        Shell.clearStatus('data')
        const afterAll = { keys: keys(), hidden: document.getElementById('appStatus').hidden }
        // fresh source -> no message at all; disabled -> likewise none
        const fresh = Shell._dataStatusText({ enabled: true, staleAfterMs: 3 * day, since: now - 10 * day,
          now, receivedAt: now, sources: [{ source: 'apt', lastSuccessAt: now - 2 * day }] }, now)
        const off = Shell._dataStatusText({ enabled: false, staleAfterMs: 3 * day, since: now - 10 * day,
          now, receivedAt: now, sources: [{ source: 'apt', lastSuccessAt: now - 40 * day }] }, now)
        return { both, afterSync, afterAll, fresh, off }
      })()`)
      assert.deepEqual(coexist.both.keys, ['sync', 'data'], `${path}: both messages, fixed order`)
      assert.equal(coexist.both.texts[0], 'SYNC NOTE', `${path}: sync status untouched`)
      assert.match(coexist.both.texts[1], /no successful check of base-names for 5 days/, `${path}: freshness hint naming source and age`)
      assert.deepEqual(coexist.afterSync.keys, ['data'], `${path}: clearStatus('sync') clears only its own message`)
      assert.equal(coexist.afterSync.hidden, false, `${path}: slot stays open while something is still in it`)
      assert.deepEqual(coexist.afterAll.keys, [], `${path}: last message gone -> slot empty`)
      assert.equal(coexist.afterAll.hidden, true, `${path}: empty slot collapses`)
      assert.equal(coexist.fresh, '', `${path}: a fresh source produces no message`)
      assert.equal(coexist.off, '', `${path}: disabled auto-refresh reports nothing`)

      navRects[path] = await evalJs(`[...document.querySelectorAll('.navlinks .whoami, .navlinks .backlink')]
        .map(el => { const r = el.getBoundingClientRect()
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })`)
      assert.equal(navRects[path].length, 4, `${path}: whoami + 3 nav entries`)
    }

    // fixed grid: every box sits at the same spot on every page
    const refRects = navRects['/']
    for (const path of ['/networth.html', '/history.html']) {
      navRects[path].forEach((r, i) => {
        r.forEach((v, j) => {
          assert.ok(Math.abs(v - refRects[i][j]) <= 1,
            `nav box ${i} is off on ${path}: ${JSON.stringify(navRects[path])} vs ${JSON.stringify(refRects)}`)
        })
      })
    }
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
