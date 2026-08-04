// Collapse state of the grouped-view categories (gitignored, local): collapsed
// groups have to survive a re-render (snapshot rebuild via innerHTML) AND a
// page reload — exactly the bug the user reported ("they pop open again on the
// next tab refresh"). Boots the real server with a store snapshot (schema v2,
// 4 categories) and clicks around in a real Chrome.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
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

// Store with 4 categories -> 4 groups in the grouped view (default: the first
// three open, the fourth collapsed).
function mockStore (user = 'player1') {
  const items = [
    { name: 'Headhunter', kind: 'unique', tab: 'A', tabIndex: 0, qty: 1, chaosEach: 5000, chaosTotal: 5000 },
    { name: 'Divine Orb', kind: 'stackable', tab: 'A', tabIndex: 0, qty: 10, chaosEach: 200, chaosTotal: 2000 },
    { name: 'The Doctor', kind: 'divcard', tab: 'A', tabIndex: 0, qty: 2, chaosEach: 300, chaosTotal: 600 },
    { name: 'Voidforge Cluster', kind: 'cluster', tab: 'A', tabIndex: 0, qty: 1, chaosEach: 50, chaosTotal: 50 }
  ]
  return JSON.stringify({
    schema_version: 2,
    users: {
      [user]: {
        accountName: 'acct', league: 'Standard', cdRatio: 214,
        tabs: { 0: { index: 0, name: 'A', syncedAt: Date.now(), items, unpriced: [], counts: { priced: 4, unpriced: 0, skipped: 0 } } },
        history: []
      }
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

test('a collapsed group stays collapsed: re-render and reload', { timeout: 120_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-grp-'))
  const port = await freePort()
  const dbg = await freePort()
  await writeFile(join(tmp, 'networth-store.json'), mockStore(), 'utf8')

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
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
  await S('Network.setCookie', { name: 'ppt_user', value: 'player1', url: base + '/' })

  const evalJs = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  const groupState = () => evalJs(`[...document.querySelectorAll('#wrap .grp')]
    .map(g => [g.dataset.kind, g.classList.contains('closed')])`)
  const waitGroups = async () => {
    for (let i = 0; i < 100; i++) {
      if (await evalJs(`document.querySelectorAll('#wrap .grp').length`) >= 4) return
      await sleep(100)
    }
    assert.fail('grouped view was never rendered\n' + srvLog.join(''))
  }

  try {
    await S('Page.navigate', { url: base + '/networth.html' })
    await waitGroups()

    // default: first three open, fourth collapsed (position-based)
    let st = await groupState()
    assert.deepEqual(st.map(([, c]) => c), [false, false, false, true], 'default state')
    const firstKind = st[0][0]

    // collapse the first group with a real click on its header
    await evalJs(`document.querySelector('#wrap .grp .grph').click()`)
    st = await groupState()
    assert.equal(st[0][1], true, 'group is collapsed after the click')

    // force a re-render (the same innerHTML rebuild a snapshot triggers):
    // changing the threshold makes render() -> renderGrouped() build anew.
    await evalJs(`(() => { const s = document.getElementById('threshSel'); s.value = '0'; s.dispatchEvent(new Event('change')) })()`)
    st = await groupState()
    assert.equal(st[0][0], firstKind, 'same group up front')
    assert.equal(st[0][1], true, 'group stays collapsed across the re-render')
    assert.deepEqual(st.slice(1).map(([, c]) => c), [false, false, true], 'remaining groups unchanged')

    // reload: the state comes from localStorage, the snapshot from the server
    await S('Page.navigate', { url: base + '/networth.html' })
    await waitGroups()
    st = await groupState()
    assert.equal(st[0][1], true, 'group stays collapsed across the reload')

    // expand it again -> explicitly open, survives the rebuild as well
    await evalJs(`document.querySelector('#wrap .grp .grph').click()`)
    await evalJs(`(() => { const s = document.getElementById('threshSel'); s.value = '1'; s.dispatchEvent(new Event('change')) })()`)
    st = await groupState()
    assert.equal(st[0][1], false, 'a re-opened group stays open')
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
