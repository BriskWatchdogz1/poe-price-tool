// Farm-session endpoints against the REAL server (child process), every
// background job off, no GGG request: GET /networth-sessions, the three POSTs,
// the daemon's POST /daemon/session and the `networth-session` WebSocket
// message.
//
// With POE_NETWORTH_AUTOSYNC=0 there is no refresher and therefore no point
// to measure a session against, so the start is refused as `sync-off` rather
// than creating a session that could never become final. A session file
// written beforehand shows that a stored summary is served with its hourly
// figure, and that an ended session past POE_SESSION_FINALIZE_MAX_MS is closed
// on the next look even though no point will ever come (sync off).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { QUIET_ENV } from './test-quiet-env.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

test('farm-session endpoints: identity, shape, sync off, a stored summary and the WS message', { timeout: 180_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-session-ep-'))
  const port = await freePort()
  const sessionsPath = join(tmp, 'networth-sessions.json')
  const H = 3_600_000
  const startedAt = 1_800_000_000_000
  const longAgo = Date.now() - 48 * H // past the 24 h default window
  await writeFile(sessionsPath, JSON.stringify({
    schema_version: 1,
    users: {
      player1: {
        running: null,
        pending: [],
        done: [{
          id: 's-1', state: 'final', startedAt, endedAt: startedAt + H, closedAt: startedAt + 2 * H,
          balance: {
            startAt: startedAt, endAt: startedAt + 2 * H, c0: 1000, c1: 1500, cd0: 200, cd1: 200,
            total: 500, loot: 400, market: 100, totalDiv: 2.5, lootDiv: 2, marketDiv: 0.5,
            gains: [['Divine Orb', 2, 400]], losses: [], unpricedIn: 0, withheld: [], stashChanged: false
          }
        }]
      },
      player2: {
        running: null,
        pending: [{
          id: 's-2', startedAt: longAgo - H, endedAt: longAgo, stashChanged: false,
          start: { at: longAgo - H, c: 1000, cd: 200, i: [['Divine Orb', 5, 1000]] }
        }],
        done: []
      }
    }
  }))

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...QUIET_ENV,
      PORT: String(port),
      POE_USERS: 'player1,player2',
      POE_USER_LANG_STORE: join(tmp, 'user-langs.json'),
      POE_CONFIG_OVERRIDES: join(tmp, 'overrides.json'),
      POE_ADMIN_PASSWORD_FILE: join(tmp, 'admin-password'),
      POE_NETWORTH_CONFIG: join(tmp, 'networth-users.json'),
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_SESSIONS: sessionsPath,
      POE_NETWORTH_AUTOSYNC: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const srvLog = []
  srv.stdout.on('data', d => srvLog.push(String(d)))
  srv.stderr.on('data', d => srvLog.push(String(d)))

  const base = `http://127.0.0.1:${port}`
  const cookie = user => (user ? { cookie: `ppt_user=${user}` } : {})
  const get = user => fetch(`${base}/networth-sessions`, { headers: cookie(user) })
  const post = (what, user) => fetch(`${base}/networth-session/${what}`, { method: 'POST', headers: cookie(user) })

  let up = false
  for (let i = 0; i < 900; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break } } catch {}
    await sleep(100)
  }

  let ws
  try {
    assert.ok(up, 'server did not come up:\n' + srvLog.join(''))

    // ---- identity ------------------------------------------------------------
    for (const r of [await get(null), await get('nobody'), await post('start', null), await post('end', 'nobody'), await post('discard', null)]) {
      assert.equal(r.status, 400)
      assert.equal((await r.json()).error, 'unknown user')
    }

    // ---- the view --------------------------------------------------------------
    let r = await get('player1')
    assert.equal(r.status, 200)
    const v = await r.json()
    assert.equal(v.available, false, 'no background sync, nothing could ever be measured')
    assert.equal(v.persisted, true)
    assert.equal(v.rateMinMs, 600000)
    assert.equal(typeof v.now, 'number')
    assert.equal(typeof v.guardHoldMs, 'number')
    assert.equal(v.running, null)
    assert.deepEqual(v.pending, [])
    assert.equal(v.done.length, 1)
    assert.equal(v.done[0].id, 's-1')
    assert.equal(v.done[0].durationMs, H)
    assert.equal(v.done[0].balance.lootPerHour, 400)
    assert.equal(v.done[0].balance.lootPerHourDiv, 2)

    // player2's ended session never got a point after its end and its window
    // is over: closed as never confirmed, without a figure.
    const v2 = await (await get('player2')).json()
    assert.deepEqual(v2.pending, [])
    assert.equal(v2.done.length, 1)
    assert.equal(v2.done[0].id, 's-2')
    assert.equal(v2.done[0].state, 'unfinished')
    assert.equal(v2.done[0].balance, null)

    // ---- the buttons -----------------------------------------------------------
    r = await post('start', 'player1')
    assert.equal(r.status, 409)
    assert.equal((await r.json()).error, 'sync-off')
    r = await post('end', 'player1')
    assert.equal(r.status, 409)
    assert.equal((await r.json()).error, 'not-running')
    r = await post('discard', 'player1')
    assert.equal(r.status, 409)
    assert.equal((await r.json()).error, 'not-running')
    assert.notEqual((await fetch(`${base}/networth-session/whatever`, { method: 'POST', headers: cookie('player1') })).status, 200,
      'only the three buttons are routes')
    // The daemon's session key meets the same refusal.
    r = await fetch(`${base}/daemon/session`, {
      method: 'POST',
      headers: { 'X-User': 'player1', 'X-PPT-Daemon': '9.9.9', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'toggle' })
    })
    assert.equal(r.status, 409)
    assert.deepEqual(await r.json(), { v: 1, error: 'sync-off', action: 'start' })

    // ---- the WebSocket message on connect --------------------------------------
    ws = new WebSocket(`ws://127.0.0.1:${port}/events`, { headers: cookie('player1') })
    const msg = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no networth-session message')), 10_000)
      ws.on('message', raw => {
        const m = JSON.parse(String(raw))
        if (m.type === 'networth-session') { clearTimeout(t); resolve(m) }
      })
      ws.on('error', reject)
    })
    assert.equal(msg.running, null)
    assert.equal(msg.pending, 0)
    assert.equal(typeof msg.now, 'number')
  } finally {
    try { ws?.close() } catch { /* never opened */ }
    srv.kill('SIGKILL')
    await new Promise(resolve => srv.on('exit', resolve))
    await rm(tmp, { recursive: true, force: true })
  }
})
