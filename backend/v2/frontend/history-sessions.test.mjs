// The session list of the History page in a real Chrome, against the real
// server: both kinds, each farm session drawn indented under the game evening
// it was started in, the states and the at-press baseline as the list says
// them, and the running game session's Discard, which takes the evening out
// and leaves its farm session standing on its own.
//
// The server boots on a sessions file (schema 2) written here; the stash sync
// is off, so no request leaves the machine and no session moves by itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
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

const NOW = Date.now()
const H = 3_600_000
const balance = loot => ({
  startAt: 0, endAt: 0, c0: 10000, c1: 10000 + loot, cd0: 200, cd1: 200,
  total: loot, loot, market: 0, totalDiv: loot / 200, lootDiv: loot / 200, marketDiv: 0,
  gains: [], losses: [], unpricedIn: 0, withheld: [], stashChanged: false
})
const done = (id, kind, parent, startedAt, endedAt, baseline = 'read') => ({
  id, kind, parent, baseline, state: 'final', startedAt, endedAt, closedAt: endedAt + 600000, balance: balance(400)
})
// The running ones are still starting: no baseline, no copy (the sync is off).
const open = (id, kind, parent, startedAt) => ({ id, kind, parent, startedAt, stashChanged: false, baseline: null, start: null, press: null })
function sessionsFile () {
  return JSON.stringify({
    schema_version: 2,
    users: {
      player1: {
        running: [open('g-2', 'game', null, NOW - 3 * H), open('s-3', 'farm', 'g-2', NOW - 0.2 * H)],
        pending: [],
        done: [
          done('s-1', 'farm', 'g-1', NOW - 26 * H, NOW - 25 * H),
          done('g-1', 'game', null, NOW - 27 * H, NOW - 23 * H),
          done('s-2', 'farm', 'g-2', NOW - 2.9 * H, NOW - 2.5 * H, 'at-press')
        ]
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

test('History lists farm sessions under their game evening and discards the running evening', { timeout: 120_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hsess-'))
  const port = await freePort()
  const dbg = await freePort()
  await writeFile(join(tmp, 'networth-sessions.json'), sessionsFile(), 'utf8')

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...QUIET_ENV,
      PORT: String(port),
      POE_USERS: 'player1,player2',
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_SESSIONS: join(tmp, 'networth-sessions.json'),
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
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
  // Each row as it is drawn: id, child, the kind cell's text and its left
  // edge of text (padding), the state cell's text.
  const rows = () => evalJs(`[...document.querySelectorAll('#sessRows tr')].map(tr => {
    const kind = tr.querySelector('td.kind')
    return {
      id: tr.dataset.id,
      child: tr.classList.contains('child'),
      kind: kind.textContent,
      pad: parseFloat(getComputedStyle(kind).paddingLeft),
      mark: getComputedStyle(kind, '::before').content,
      state: tr.querySelector('td.state').textContent
    }
  })`)
  const waitFor = async (expr, what) => {
    for (let i = 0; i < 100; i++) {
      if (await evalJs(expr)) return
      await sleep(100)
    }
    assert.fail(`${what}\n` + srvLog.join(''))
  }

  try {
    await S('Page.navigate', { url: base + '/history.html' })
    await waitFor(`document.querySelectorAll('#sessRows tr').length === 5`, 'the five sessions are listed')

    let r = await rows()
    assert.deepEqual(r.map(x => [x.id, x.child]), [
      ['g-2', false], ['s-3', true], ['s-2', true], ['g-1', false], ['s-1', true]
    ], 'newest evening first, each farm session under its evening')
    assert.deepEqual(r.map(x => x.kind), ['Game session', 'Farm session', 'Farm session', 'Game session', 'Farm session'])
    assert.deepEqual(r.map(x => x.state), ['starting', 'starting', 'final · baseline at start', 'final', 'final'])
    const top = r.find(x => !x.child)
    for (const c of r.filter(x => x.child)) {
      assert.ok(c.pad > top.pad + 10, `a farm session under its evening is drawn indented (${c.pad}px against ${top.pad}px)`)
      assert.notEqual(c.mark, 'none', 'and marked as belonging to the row above')
    }
    assert.equal(top.mark, 'none')

    // Unpicked, the card shows the running farm session, starting: no figure,
    // the baseline still to come. The toolbar's button is for farm sessions.
    const card = () => evalJs(`document.getElementById('sessCard').textContent`)
    assert.match(await card(), /^Farm session started at /)
    assert.match(await card(), /Baseline with the next full read of the stash; until then there are no figures\./)
    assert.equal(await evalJs(`document.getElementById('sessBtnLbl').textContent`), 'End farm session')
    assert.equal(await evalJs(`!!document.querySelector('#sessCard button[data-act="discard-game"]')`), false)

    // The evening's own card carries its Discard and no Start or End.
    await evalJs(`document.querySelector('#sessRows tr[data-id="g-2"] td').click()`)
    assert.match(await card(), /^Game session started at /)
    assert.equal(await evalJs(`document.querySelector('#sessCard button[data-act]').dataset.act`), 'discard-game')

    // Discard it (confirmed): the evening is gone, and the farm sessions that
    // were under it stand on their own.
    await evalJs(`window.confirm = () => true; document.querySelector('#sessCard button[data-act="discard-game"]').click(); true`)
    await waitFor(`document.querySelectorAll('#sessRows tr').length === 4`, 'the discarded evening leaves the list')
    r = await rows()
    assert.deepEqual(r.map(x => [x.id, x.child]), [['s-3', false], ['s-2', false], ['g-1', false], ['s-1', true]])
    const view = await (await fetch(`${base}/networth-sessions`, { headers: { cookie: 'ppt_user=player1' } })).json()
    assert.equal(view.game, null, 'the server has no running game session any more')
    assert.equal(view.running.id, 's-3', 'the farm session still runs')
    assert.equal(view.running.parent, null)

    // German: the kinds and the states follow the page language.
    await evalJs(`I18n.setLang('de'); true`)
    r = await rows()
    assert.deepEqual(r.map(x => x.kind), ['Farm-Sitzung', 'Farm-Sitzung', 'Spielsitzung', 'Farm-Sitzung'])
    assert.deepEqual(r.map(x => x.state), ['startet', 'abgeschlossen · Basis beim Start', 'abgeschlossen', 'abgeschlossen'])
  } finally {
    cdp.close()
    chrome.kill('SIGTERM')
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
