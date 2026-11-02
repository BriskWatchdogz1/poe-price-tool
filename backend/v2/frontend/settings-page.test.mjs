// Browser test (headless Chrome, same setup as shell-load.test.mjs): the
// settings page — both halves of it.
//
// The sync credentials used to be a modal on the net-worth page. They are a
// section of this page now, so the net-worth status line no longer opens
// anything, it LINKS here; the rest of the promise is unchanged and still
// checked: saving writes the file, the status line clears itself, and the
// POESESSID is nowhere in the DOM afterwards.
//
// The second half is new: the admin area and its state model. The password goes
// out as a header on every request, lives in sessionStorage and nowhere else,
// and closing the view forgets it — there is no session on the server to end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
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

test('settings page: the net-worth line links here, saving works, the admin area unlocks', { timeout: 180_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-setdlg-'))
  const port = await freePort()
  const dbg = await freePort()
  const credPath = join(tmp, 'networth-users.json') // does NOT exist -> state 'missing'
  const SECRET = 'browsertestcookie1234567890abcd0'

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      // The full set that keeps a booted server off the network — one list,
      // imported, because every file that wrote it out by hand got it wrong.
      // Spread first, so anything below may still override it deliberately.
      ...QUIET_ENV,
      PORT: String(port),
      POE_USERS: 'player1,player2',
      POE_NETWORTH_CONFIG: credPath,
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_AUTOSYNC: '0',
      POE_FAUSTUS_DISABLED: '1',
      POE_CORPSE_DISABLED: '1',
      POE_DATA_REFRESH_DISABLED: '1',
      POE_REFERENCE_DISABLED: '1',
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
    // ---- the net-worth page now POINTS here instead of opening a modal ------
    await S('Page.navigate', { url: base + '/networth.html' })
    await waitFor(`document.getElementById('connlbl') && document.getElementById('connlbl').textContent === 'live'`, 'page never went live')

    await waitFor(`!document.getElementById('appStatus').hidden`, 'status line stayed empty despite missing credentials')
    assert.equal(await evalJs(`document.getElementById('appStatus').textContent`),
      'No credentials configured — open settings to add them.')
    assert.equal(await evalJs(`new URL(document.getElementById('settingsBtn').href).pathname`), '/settings.html',
      'the M1 action is a link to the settings page')
    assert.ok(await evalJs(`!document.getElementById('setGate')`), 'the modal is gone for good')

    // Clicking the sync message navigates — the state it names is fixed there.
    await evalJs(`document.getElementById('appStatus').click()`)
    await waitFor(`location.pathname === '/settings.html'`, 'the status line did not navigate to the settings page')

    // ---- the sync credentials, now a section of this page -------------------
    await waitFor(`document.getElementById('setState') && document.getElementById('setState').textContent.startsWith('No credentials configured')`,
      'the settings page never showed the real credential state')
    assert.equal(await evalJs(`document.getElementById('setSessid').type`), 'password')
    assert.equal(await evalJs(`document.getElementById('setSessid').value`), '', 'the stored value is never delivered')
    assert.equal(await evalJs(`document.getElementById('setSessid').autocomplete`), 'off')

    // length hint: shown at an unusual length, but it never blocks saving
    await evalJs(`(el => { el.value = 'kurz'; el.dispatchEvent(new Event('input')) })(document.getElementById('setSessid'))`)
    assert.ok(!(await evalJs(`document.getElementById('setHint').hidden`)), 'hint visible at 4 characters')

    await evalJs(`document.getElementById('setAccount').value = 'Player#0001'`)
    await evalJs(`(el => { el.value = ${JSON.stringify(SECRET)}; el.dispatchEvent(new Event('input')) })(document.getElementById('setSessid'))`)
    assert.ok(await evalJs(`document.getElementById('setHint').hidden`), 'hint gone again at 32 characters')
    await evalJs(`document.getElementById('setSave').click()`)
    await waitFor(`!document.getElementById('setOk').hidden`, 'saving never confirmed')

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

    // reload: accountName prefilled from the server, POESESSID field empty
    await S('Page.navigate', { url: base + '/settings.html' })
    await waitFor(`document.getElementById('setAccount') && document.getElementById('setAccount').value === 'Player#0001'`, 'accountName was not prefilled')
    assert.equal(await evalJs(`document.getElementById('setSessid').value`), '')

    // ---- the admin area -----------------------------------------------------
    // Closed by default: the ordinary user never sees the diagnostics.
    assert.ok(await evalJs(`document.getElementById('admView').hidden`), 'the admin view starts closed')
    assert.ok(!(await evalJs(`document.getElementById('admGate').hidden`)), 'the password prompt is what is shown')

    // A wrong password says so and changes nothing.
    await evalJs(`document.getElementById('admPass').value = 'nope'`)
    await evalJs(`document.getElementById('admOpen').click()`)
    await waitFor(`!document.getElementById('admErr').hidden`, 'a wrong password produced no message')
    assert.equal(await evalJs(`document.getElementById('admErr').textContent`), 'Wrong password.')
    assert.ok(await evalJs(`document.getElementById('admView').hidden`), 'and the view stayed closed')
    assert.equal(await evalJs(`sessionStorage.getItem('ppt_admin')`), null, 'nothing was remembered')

    // The default password from the file the server created on boot.
    await evalJs(`document.getElementById('admPass').value = 'admin'`)
    await evalJs(`document.getElementById('admOpen').click()`)
    await waitFor(`!document.getElementById('admView').hidden`, 'the admin view never opened')
    assert.equal(await evalJs(`sessionStorage.getItem('ppt_admin')`), 'admin',
      'the password lives in sessionStorage — that is the whole session model')
    assert.ok(await evalJs(`document.getElementById('admSkew').textContent.length > 0`), 'the dataset offset is rendered')
    assert.ok(await evalJs(`document.getElementById('admGaps').textContent.length > 0`), 'so is the gap list')

    // A reload of the tab keeps it open, because the value survives in
    // sessionStorage and the server re-checks it on every request.
    await S('Page.navigate', { url: base + '/settings.html' })
    await waitFor(`document.getElementById('admView') && !document.getElementById('admView').hidden`,
      'the unlocked view did not survive a reload of the same tab')

    // Closing forgets it again — the only "logout" there is.
    await evalJs(`document.getElementById('admClose').click()`)
    assert.ok(await evalJs(`document.getElementById('admView').hidden`))
    assert.equal(await evalJs(`sessionStorage.getItem('ppt_admin')`), null)
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
