// Browser test (headless Chrome, same setup as shell-load.test.mjs): the
// settings dialog on the net-worth page — the status line shows the sync state
// and opens the dialog, saving writes the file and clears the status line away.
// And: after saving, the POESESSID is NOWHERE in the DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
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

test('settings dialog: status line -> open -> save -> status gone, file written', { timeout: 180_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-setdlg-'))
  const port = await freePort()
  const dbg = await freePort()
  const credPath = join(tmp, 'networth-users.json') // does NOT exist -> state 'missing'
  const SECRET = 'browsertestcookie1234567890abcd0'

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
      POE_CRAWLER_DISABLED: '1',
      POE_FAUSTUS_DISABLED: '1',
      POE_CORPSE_DISABLED: '1',
      POE_CLUSTER_STORE: join(tmp, 'cluster-store.json')
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
  await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable')
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

  try {
    await S('Page.navigate', { url: base + '/networth.html' })
    await waitFor(`document.getElementById('connlbl') && document.getElementById('connlbl').textContent === 'live'`, 'page never went live')

    // part 1: the status line shows the 'missing' state
    await waitFor(`!document.getElementById('appStatus').hidden`, 'status line stayed empty despite missing credentials')
    assert.equal(await evalJs(`document.getElementById('appStatus').textContent`),
      'No credentials configured — open settings to add them.')

    // the status line opens the dialog
    await evalJs(`document.getElementById('appStatus').click()`)
    assert.ok(!(await evalJs(`document.getElementById('setGate').hidden`)), 'clicking the status line opens the dialog')
    // POESESSID field: type password, always empty, autocomplete off
    assert.equal(await evalJs(`document.getElementById('setSessid').type`), 'password')
    assert.equal(await evalJs(`document.getElementById('setSessid').value`), '')
    assert.equal(await evalJs(`document.getElementById('setSessid').autocomplete`), 'off')

    // cancel, then re-open via the M1 button
    await evalJs(`document.getElementById('setCancel').click()`)
    assert.ok(await evalJs(`document.getElementById('setGate').hidden`), 'cancel closes the dialog')
    await evalJs(`document.getElementById('settingsBtn').click()`)
    assert.ok(!(await evalJs(`document.getElementById('setGate').hidden`)), 'the settings button opens it')

    // length hint: shown at an unusual length, but it never blocks saving
    await evalJs(`(el => { el.value = 'kurz'; el.dispatchEvent(new Event('input')) })(document.getElementById('setSessid'))`)
    assert.ok(!(await evalJs(`document.getElementById('setHint').hidden`)), 'hint visible at 4 characters')

    // save
    await evalJs(`document.getElementById('setAccount').value = 'Player#0001'`)
    await evalJs(`(el => { el.value = ${JSON.stringify(SECRET)}; el.dispatchEvent(new Event('input')) })(document.getElementById('setSessid'))`)
    assert.ok(await evalJs(`document.getElementById('setHint').hidden`), 'hint gone again at 32 characters')
    await evalJs(`document.getElementById('setSave').click()`)
    await waitFor(`document.getElementById('setGate').hidden`, 'dialog did not close after saving')

    // the status line clears itself (the server broadcasts the new state)
    await waitFor(`document.getElementById('appStatus').hidden`, 'status line did not disappear after saving')

    // file written, mode 600, correct content
    const st = await stat(credPath)
    assert.equal(st.mode & 0o777, 0o600)
    const onDisk = JSON.parse(await readFile(credPath, 'utf8'))
    assert.deepEqual(onDisk, { player1: { accountName: 'Player#0001', poesessid: SECRET } })

    // the value is nowhere in the DOM (the field is cleared after saving)
    assert.ok(!(await evalJs(`document.documentElement.outerHTML.includes(${JSON.stringify(SECRET)})`)), 'secret must not appear in the DOM')
    assert.equal(await evalJs(`document.getElementById('setSessid').value`), '')

    // re-open: accountName prefilled, POESESSID field empty
    await evalJs(`document.getElementById('settingsBtn').click()`)
    await waitFor(`document.getElementById('setAccount').value === 'Player#0001'`, 'accountName was not prefilled')
    assert.equal(await evalJs(`document.getElementById('setSessid').value`), '')
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
