// POST /daemon/session and the game session against the REAL server,
// in-process, with the background stash sync ON but no credentials: the
// refresher exists and ticks without a user, so nothing is ever read and no
// request leaves the machine (every non-loopback fetch is refused here, and
// the suite's network guard is on top). A history point is appended through
// the server's own history, which is what a session's copy at the start and
// its figures come from.
//
// What is pinned: the route's shape and caller rule, the toggle's answer and
// the feed's `session` event, the game session a heartbeat starts, and the
// History page's view of both kinds.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quietEnv } from './test-quiet-env.mjs'

const dir = await mkdtemp(join(tmpdir(), 'ppt-daemon-session-'))
quietEnv()
process.env.POE_NETWORTH_AUTOSYNC = '1'
process.env.PORT = '0'
process.env.POE_USERS = 'player1,player2'
process.env.POE_USER_LANG_STORE = join(dir, 'user-langs.json')
process.env.POE_CONFIG_OVERRIDES = join(dir, 'overrides.json')
process.env.POE_ADMIN_PASSWORD_FILE = join(dir, 'admin-password')
process.env.POE_NETWORTH_CONFIG = join(dir, 'networth-users.json')
process.env.POE_NETWORTH_STORE = join(dir, 'networth-store.json')
process.env.POE_NETWORTH_HISTORY = join(dir, 'networth-history.ndjson')
process.env.POE_NETWORTH_SESSIONS = join(dir, 'networth-sessions.json')
process.env.POE_FAUSTUS_STORE = join(dir, 'faustus-store.json')
process.env.POE_REFERENCE_HISTORY = join(dir, 'reference-history.ndjson')
process.env.POE_CORPSE_STORE = join(dir, 'corpse-store.json')
process.env.POE_RATE_LIMIT_STATE = join(dir, 'rate-limit.json')

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/
const outbound = []
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input))
  if (!LOOPBACK.test(url)) {
    outbound.push(url)
    return Promise.reject(new Error(`outbound request blocked in this test: ${url}`))
  }
  return realFetch(input, init)
}

let mod, base
const H = (user, instance = 'i1') => ({ 'X-User': user, 'X-PPT-Daemon': '9.9.9', 'X-PPT-Instance': instance, 'content-type': 'application/json' })
const session = (user, body, headers = H(user)) =>
  fetch(`${base}/daemon/session`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
const feed = (user, since = 0, boot) => fetch(`${base}/daemon/events?wait=0&since=${since}&boot=${boot}`, { headers: H(user) }).then(r => r.json())
const view = user => fetch(`${base}/networth-sessions`, { headers: { cookie: `ppt_user=${user}` } }).then(r => r.json())

before(async () => {
  mod = await import('./server.mjs')
  base = `http://127.0.0.1:${mod.server.address().port}`
})

after(async () => {
  mod.networthRefresher?.stop()
  await new Promise(resolve => mod.server.close(resolve))
  await rm(dir, { recursive: true, force: true })
  assert.deepEqual(outbound, [], 'no request left the machine')
})

test('the route takes the daemon headers and one of three actions', async () => {
  let r = await session('player1', { action: 'toggle' }, { 'content-type': 'application/json', 'X-User': 'player1' })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'missing X-PPT-Daemon header' })
  r = await session('nobody', { action: 'toggle' })
  assert.equal(r.status, 400)
  r = await fetch(`${base}/daemon/session`, { headers: H('player1') })
  assert.equal(r.status, 405)
  assert.equal((await r.json()).allow, 'POST')
  r = await session('player1', { action: 'discard' })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'bad action' })
  r = await session('player1', '{not json')
  assert.equal(r.status, 400)
  r = await session('player1', JSON.stringify({ action: 'toggle', pad: 'x'.repeat(2000) }))
  assert.equal(r.status, 413)
})

test('toggle refuses without a recent point, then starts and ends a farm session, and the feed hears it', async () => {
  const boot = (await feed('player1')).boot
  let r = await session('player1', { action: 'toggle' })
  assert.equal(r.status, 409)
  let j = await r.json()
  assert.equal(j.error, 'no-baseline')
  assert.equal(j.action, 'start')
  assert.equal(typeof j.maxAgeMs, 'number')

  const recorded = await mod.networthHistory.append('player1', {
    totalChaos: 1000, cdRatio: 200, items: [{ name: 'Divine Orb', qty: 5, chaosTotal: 1000 }], unpriced: [], tabsChanged: false
  })
  assert.equal(recorded, true)
  const seq0 = (await feed('player1', 0, boot)).seq

  r = await session('player1', { action: 'toggle' }, H('player1', 'k1'))
  assert.equal(r.status, 200)
  j = await r.json()
  assert.equal(j.ok, true)
  assert.equal(j.action, 'start')
  assert.equal(j.session.kind, 'farm')
  assert.equal(j.session.state, 'starting')
  assert.equal(j.session.baseline, null)
  assert.equal(j.session.balance, null)
  assert.equal(j.session.about, null, 'no tab list for this user: no estimate')

  let ev = (await feed('player1', seq0, boot)).events.filter(e => e.kind === 'session')
  assert.equal(ev.length, 1)
  assert.equal(ev[0].by, 'k1')
  assert.equal(ev[0].session.id, j.session.id)
  assert.equal(ev[0].session.state, 'starting')
  assert.deepEqual((await feed('player2', 0, boot)).events.filter(e => e.kind === 'session'), [], 'only the user\'s own feed')

  r = await session('player1', { action: 'start' })
  assert.equal(r.status, 409)
  assert.equal((await r.json()).error, 'already-running')

  r = await session('player1', { action: 'toggle' })
  j = await r.json()
  assert.equal(j.action, 'end')
  assert.equal(j.session.state, 'preliminary')
  assert.equal(j.session.baseline, 'at-press', 'ended before a read: the copy at the start')
  ev = (await feed('player1', seq0, boot)).events.filter(e => e.kind === 'session')
  assert.deepEqual(ev.map(e => e.session.state), ['starting', 'preliminary'])

  r = await session('player1', { action: 'end' })
  assert.equal(r.status, 409)
  assert.equal((await r.json()).error, 'not-running')

  const v = await view('player1')
  assert.equal(v.available, true)
  assert.equal(v.autoGame, true)
  assert.equal(v.gameGapMs, 600000)
  assert.equal(v.running, null)
  assert.equal(v.game, null)
  assert.equal(v.pending.length, 1)
  assert.equal(v.pending[0].kind, 'farm')
})

test('a heartbeat that says the game runs starts a game session; it can be discarded', async () => {
  const boot = (await feed('player2')).boot
  const seq0 = (await feed('player2', 0, boot)).seq
  const r = await fetch(`${base}/daemon/heartbeat`, {
    method: 'POST', headers: H('player2'), body: JSON.stringify({ v: 1, game: 'running', everyS: 60, features: { game: 'ok' } })
  })
  assert.equal((await r.json()).presence, 'playing')
  // The heartbeat route fires the start off and answers at once; the start
  // writes the sessions file first. Under a full suite that can take longer
  // than a second, so the wait is a deadline, not a fixed count of polls.
  let v
  const deadline = Date.now() + 10_000
  do {
    v = await view('player2')
    if (v.game) break
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  assert.ok(v.game, 'the game session the heartbeat starts shows up within 10 s')
  assert.equal(v.game.kind, 'game')
  assert.equal(v.game.state, 'starting')
  // The feed hears the start right after the sessions file is written
  // (session-control.mjs start: sessions.start, then tell), so the view can
  // show the session a moment before the event is there; on a slow machine
  // one read of the feed lands in that gap. Asked until the event comes.
  let ev = []
  const feedDeadline = Date.now() + 10_000
  do {
    ev = (await feed('player2', seq0, boot)).events.filter(e => e.kind === 'session')
    if (ev.length) break
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < feedDeadline)
  assert.equal(ev.length, 1, 'the feed carries the session start within 10 s')
  assert.equal(ev[0].by, null, 'started by the game, not by a key')
  assert.equal(ev[0].session.kind, 'game')

  let d = await fetch(`${base}/networth-session/discard?kind=raid`, { method: 'POST', headers: { cookie: 'ppt_user=player2' } })
  assert.equal(d.status, 400)
  d = await fetch(`${base}/networth-session/discard?kind=game`, { method: 'POST', headers: { cookie: 'ppt_user=player2' } })
  assert.equal(d.status, 200)
  assert.equal((await view('player2')).game, null)
})

test('the sync status passes a session round on to the page', () => {
  const round = { done: 3, total: 40, since: 1793604080000 }
  assert.deepEqual(mod.syncStatusMsg({ state: 'ok', sessionRound: round }), { type: 'networth-sync-status', state: 'ok', sessionRound: round })
  assert.equal(mod.syncStatusMsg({ state: 'ok' }).sessionRound, undefined)
})

test('the session key is rate-limited per user: POE_DAEMON_SESSION_MAX_PER_MIN (10) a minute', async () => {
  // player2 has sent no session request yet; `end` without a running farm
  // session is refused (409) and writes nothing, but it counts.
  for (let i = 0; i < 10; i++) {
    const r = await session('player2', { action: 'end' })
    assert.equal(r.status, 409, `request ${i + 1}`)
    await r.json()
  }
  const r = await session('player2', { action: 'toggle' })
  assert.equal(r.status, 429)
  assert.deepEqual(await r.json(), { v: 1, error: 'too-many-session-requests', action: 'toggle' })
  const bad = await session('player2', { action: 'discard' })
  assert.equal(bad.status, 400, 'a malformed request is refused before the gate')
})
