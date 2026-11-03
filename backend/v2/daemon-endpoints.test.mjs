// The hotkey daemon's own channel against the REAL server (child process,
// every background job off, no request leaves the machine): GET
// /daemon/events, POST /daemon/heartbeat, and what POST /item does with and
// without the daemon's headers.
//
// Two promises are pinned here that matter more than any route shape:
//   - an old daemon (POST /item without X-PPT-Daemon) gets byte for byte the
//     answer it always got, and nothing of it is followed;
//   - reading the feed never queues anything. A WebSocket connect does (it
//     re-queues priceless cards as trade searches), which is why the daemon
//     has a channel of its own; the contrast is asserted at the end of that
//     test, so the instrument is shown to see a re-queue when there is one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
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

const MAGEBLOOD = `Item Class: Belts
Rarity: Unique
Mageblood
Heavy Belt
--------
Item Level: 86
--------
Your Flasks gain 0.15 Charges per Second
--------
`
const HEADHUNTER = `Item Class: Belts
Rarity: Unique
Headhunter
Leather Belt
--------
Item Level: 84
--------
+40 to maximum Life
--------
`
const belt = name => `Item Class: Belts
Rarity: Rare
${name}
Leather Belt
--------
Item Level: 80
--------
+30 to maximum Life
--------
`

let tmp, srv, base, port
const srvLog = []

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ppt-daemon-ep-'))
  port = await freePort()
  srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...QUIET_ENV,
      PORT: String(port),
      POE_USERS: 'player1,player2,player3,player4',
      POE_USER_LANG_STORE: join(tmp, 'user-langs.json'),
      POE_CONFIG_OVERRIDES: join(tmp, 'overrides.json'),
      POE_ADMIN_PASSWORD_FILE: join(tmp, 'admin-password'),
      POE_NETWORTH_CONFIG: join(tmp, 'networth-users.json'),
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_SESSIONS: join(tmp, 'networth-sessions.json'),
      POE_DAEMON_WAITERS_MAX: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  srv.stdout.on('data', d => srvLog.push(String(d)))
  srv.stderr.on('data', d => srvLog.push(String(d)))
  base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 900; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return } catch {}
    await sleep(100)
  }
  throw new Error('server did not come up:\n' + srvLog.join(''))
})

after(async () => {
  srv.kill('SIGKILL')
  await new Promise(resolve => srv.on('exit', resolve))
  await rm(tmp, { recursive: true, force: true })
  assert.doesNotMatch(srvLog.join(''), /\[daemon-feed\]/, 'the feed never threw')
})

const daemonHeaders = (user, instance = 'i1') => ({ 'X-User': user, 'X-PPT-Daemon': '9.9.9', 'X-PPT-Instance': instance })
const events = (user, qs = 'wait=0', headers = daemonHeaders(user), init = {}) =>
  fetch(`${base}/daemon/events?${qs}`, { headers, ...init })
async function feedNow (user) {
  const r = await events(user)
  assert.equal(r.status, 200)
  return r.json()
}
const postItem = (text, headers) => fetch(`${base}/item`, { method: 'POST', headers, body: text })
const beat = (user, body, instance = 'i1') => fetch(`${base}/daemon/heartbeat`, {
  method: 'POST', headers: { ...daemonHeaders(user, instance), 'content-type': 'application/json' }, body
})

async function wsCollect (user) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, { headers: { cookie: `ppt_user=${user}` } })
  const msgs = []
  ws.on('message', d => { try { msgs.push(JSON.parse(String(d))) } catch {} })
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await sleep(200)
  return { ws, msgs }
}

test('the daemon routes answer with names, never with the static fallback', async () => {
  let r = await events('player1', 'wait=0', { 'X-User': 'player1' })
  assert.equal(r.status, 400)
  assert.match(r.headers.get('content-type'), /application\/json/)
  assert.deepEqual(await r.json(), { error: 'missing X-PPT-Daemon header' })

  r = await events('player1', 'wait=0', { 'X-PPT-Daemon': '9.9.9' })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'missing X-User header' }, 'no fallback to the first user')

  r = await events('nobody', 'wait=0', daemonHeaders('nobody'))
  assert.equal(r.status, 400)
  const body = await r.json()
  assert.equal(body.error, 'unknown user "nobody"')
  assert.deepEqual(body.users, ['player1', 'player2', 'player3', 'player4'])

  r = await fetch(`${base}/daemon/nothing`)
  assert.equal(r.status, 404, 'the path is checked before the headers')
  assert.equal((await r.json()).error, 'unknown daemon route')

  r = await fetch(`${base}/daemon/events`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-ppt-daemon' } })
  assert.equal(r.status, 405, 'a CORS preflight is refused')
  assert.equal((await r.json()).error, 'method not allowed')
  for (const [k] of r.headers) assert.doesNotMatch(k, /^access-control-/i, `no ${k} on the preflight answer`)

  r = await fetch(`${base}/daemon/events`, { method: 'POST', headers: daemonHeaders('player1') })
  assert.equal(r.status, 405)
  assert.equal((await r.json()).allow, 'GET')
  r = await fetch(`${base}/daemon/heartbeat`, { method: 'POST', headers: { 'X-User': 'player1' }, body: '{}' })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'missing X-PPT-Daemon header' })
})

test('a hotkey card reaches the feed without a browser, and the old POST answer is unchanged', async () => {
  const first = await feedNow('player1')
  assert.equal(first.reset, true, 'a first request is told to reset')
  assert.equal(first.v, 1)
  assert.deepEqual(first.events, [])
  const { boot, seq } = first

  let r = await postItem(MAGEBLOOD, daemonHeaders('player1', 'i1'))
  assert.equal(r.status, 200)
  const text = await r.text()
  const posted = JSON.parse(text)
  assert.deepEqual(Object.keys(posted), ['id', 'user'])
  assert.equal(text, JSON.stringify({ id: posted.id, user: 'player1' }), 'the answer is the one every daemon always got')

  await sleep(100)
  r = await events('player1', `since=${seq}&boot=${boot}&wait=0`)
  const feed = await r.json()
  assert.equal(feed.reset, false)
  const mine = feed.events.filter(e => e.kind === 'item' && e.id === posted.id)
  assert.ok(mine.length >= 2, JSON.stringify(feed.events))
  assert.equal(mine[0].by, 'i1')
  assert.equal(mine[0].status, 'queued')
  assert.equal(mine[0].name, 'Mageblood')
  assert.equal(mine[0].final, false)
  assert.equal(mine.at(-1).status, 'error', 'POE_PRICE_CHECK_DISABLED: no price will come, and the feed says so')
  assert.equal(mine.at(-1).final, true)

  r = await postItem(MAGEBLOOD, daemonHeaders('player1', 'i2'))
  const again = await r.text()
  assert.equal(again, JSON.stringify({ id: posted.id, user: 'player1', deduped: true }))
  await sleep(100)
  const after = await (await events('player1', `since=${feed.seq}&boot=${boot}&wait=0`)).json()
  const re = after.events.filter(e => e.kind === 'item' && e.id === posted.id)
  assert.ok(re.length >= 1, 'the dedupe re-asserts the card in the feed')
  assert.equal(re[0].by, 'i2', 'for the instance that pressed now')
})

test("an old daemon's POST /item is not followed, and its answer is byte for byte the old one", async () => {
  const before = await feedNow('player2')
  const r = await postItem(HEADHUNTER, { 'X-User': 'player2' })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /^application\/json$/)
  const text = await r.text()
  const { id } = JSON.parse(text)
  assert.equal(text, JSON.stringify({ id, user: 'player2' }))
  await sleep(100)
  assert.equal((await feedNow('player2')).seq, before.seq, 'nothing of an old daemon is followed')

  const { ws, msgs } = await wsCollect('player2')
  try {
    const st = msgs.find(m => m.type === 'daemon-status')
    assert.ok(st, 'daemon-status on connect')
    assert.equal(st.daemon, null, 'no heartbeat yet: no daemon block')
    assert.equal(st.outcome, 'card')
  } finally { ws.close() }
})

test('reading the feed never queues a trade search', async () => {
  const observer = await wsCollect('player3')
  try {
    for (const t of [belt('Rune Clasp'), belt('Grim Cord'), belt('Dusk Lash')]) {
      assert.equal((await postItem(t, daemonHeaders('player3'))).status, 200)
    }
    await sleep(300)
    const { boot, seq } = await feedNow('player3')
    observer.msgs.length = 0
    const logBefore = srvLog.join('').length
    for (let i = 0; i < 20; i++) {
      const qs = i % 2 ? `since=${seq}&boot=${boot}&wait=0` : 'wait=0'
      assert.equal((await events('player3', qs)).status, 200)
    }
    await sleep(300)
    assert.deepEqual(observer.msgs.map(m => m.type), [], 'twenty polls: no queue-status, no card, nothing')
    assert.doesNotMatch(srvLog.join('').slice(logBefore), /trade|reference|ninja|price job/i)
    assert.equal((await feedNow('player3')).seq, seq)

    // The contrast: a page connect re-queues the three priceless cards. The
    // observer sees that queue move; the feed does not, because the cards are
    // past their first final state.
    const second = await wsCollect('player3')
    second.ws.close()
    await sleep(300)
    assert.ok(observer.msgs.some(m => m.type === 'queue-status'), 'a WebSocket connect does queue, and this test can see it')
    assert.equal((await feedNow('player3')).seq, seq, 'a re-queue after a page reconnect does not reach the game')
  } finally { observer.ws.close() }
})

test('a held GET is released when the daemon goes away', async () => {
  const { boot, seq } = await feedNow('player4')
  const hold = `since=${seq}&boot=${boot}&wait=20000`
  const ac = new AbortController()
  const held = events('player4', hold, daemonHeaders('player4', 'a'), { signal: ac.signal }).catch(e => e)
  await sleep(150)
  const busy = await events('player4', `since=${seq}&boot=${boot}&wait=500`, daemonHeaders('player4', 'b'))
  assert.equal(busy.status, 429, 'POE_DAEMON_WAITERS_MAX=1 and one request held')
  assert.equal((await busy.json()).error, 'too-many-waiters')
  ac.abort()
  await held
  await sleep(150)
  const t0 = Date.now()
  const next = await events('player4', `since=${seq}&boot=${boot}&wait=400`, daemonHeaders('player4', 'b'))
  assert.equal(next.status, 200, 'the aborted request no longer holds the slot')
  const body = await next.json()
  assert.deepEqual(body.events, [])
  assert.ok(Date.now() - t0 >= 350, 'it was held for its wait')

  // A newer request of the SAME instance answers its older one at once.
  const older = events('player4', hold, daemonHeaders('player4', 'c')).then(r => r.json())
  await sleep(150)
  const newer = events('player4', `since=${seq}&boot=${boot}&wait=300`, daemonHeaders('player4', 'c'))
  const o = await older
  assert.deepEqual(o.events, [])
  assert.equal((await newer).status, 200)
})

test('an event releases a held GET at once', async () => {
  const { boot, seq } = await feedNow('player4')
  const t0 = Date.now()
  const held = events('player4', `since=${seq}&boot=${boot}&wait=20000`).then(r => r.json())
  await sleep(150)
  await postItem(belt('Wyrm Buckle'), daemonHeaders('player4'))
  const got = await held
  assert.ok(Date.now() - t0 < 5000)
  assert.ok(got.events.length >= 1)
  assert.equal(got.events[0].kind, 'item')
})

test('a heartbeat is bounded, judged strictly, and reaches the page only on change', async () => {
  const { ws, msgs } = await wsCollect('player1')
  try {
    msgs.length = 0
    let r = await beat('player1', 'x'.repeat(5000))
    assert.equal(r.status, 413)
    r = await beat('player1', 'not json')
    assert.equal(r.status, 400)
    assert.equal((await r.json()).error, 'bad json')
    r = await beat('player1', '[1]')
    assert.equal(r.status, 400)
    await sleep(150)
    assert.deepEqual(msgs.filter(m => m.type === 'daemon-status'), [], 'a refused beat changes nothing')

    r = await beat('player1', JSON.stringify({ v: 1, game: 'running', everyS: 60, features: { overlay: 'no-qt', notify: 'ok' } }))
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { ok: true, presence: 'playing', v: 1 })
    await sleep(200)
    let st = msgs.filter(m => m.type === 'daemon-status')
    assert.equal(st.length, 1, 'the first beat, an edge to playing, is ONE daemon-status')
    assert.equal(st[0].daemon.presence, 'playing')
    assert.equal(st[0].daemon.version, '9.9.9', 'the version comes from X-PPT-Daemon')
    assert.deepEqual(st[0].daemon.features, { overlay: 'no-qt', notify: 'ok' })
    assert.equal(st[0].daemon.instances, 1)
    assert.equal(typeof st[0].lastItemAt, 'number', 'the old fields stay')

    await beat('player1', JSON.stringify({ v: 1, game: 'running', everyS: 60, features: { overlay: 'no-qt', notify: 'ok' } }))
    await sleep(200)
    assert.equal(msgs.filter(m => m.type === 'daemon-status').length, 1, 'a beat that changes nothing is no page update')

    await beat('player1', JSON.stringify({ v: 1, game: 'running', everyS: 60, features: { overlay: 'ok', notify: 'ok' } }))
    await sleep(200)
    st = msgs.filter(m => m.type === 'daemon-status')
    assert.equal(st.length, 2, 'a beat that changes only features is exactly one')
    assert.equal(st[1].daemon.features.overlay, 'ok')

    r = await beat('player1', JSON.stringify({ game: 'banana' }))
    assert.equal((await r.json()).presence, 'unknown', 'a game value outside the three never plays')
  } finally { ws.close() }

  // A fresh user whose daemon cannot tell: no edge, but the first report is a change.
  const p2 = await wsCollect('player2')
  try {
    p2.msgs.length = 0
    const r = await beat('player2', JSON.stringify({ game: 'unknown', features: { downlink: 'ok' } }))
    assert.equal((await r.json()).presence, 'unknown')
    await sleep(200)
    const st = p2.msgs.filter(m => m.type === 'daemon-status')
    assert.equal(st.length, 1)
    assert.equal(st[0].daemon.presence, 'unknown')
    assert.equal(st[0].daemon.version, '9.9.9')
  } finally { p2.ws.close() }
  assert.match(srvLog.join(''), /\[daemon\] player1: unknown -> playing \(daemon 9\.9\.9\)/)
})

test('a game that is not running is idle, and its edge re-sends the sync status without a pace while the sync is off', async () => {
  // The background sync is off here (QUIET_ENV), so there is no refresher and
  // no pace: `pace` exists only while the background sync runs. What the edge
  // must still do is send the sync status again, because a change of who plays
  // can move the pace of every user.
  const { ws, msgs } = await wsCollect('player3')
  try {
    msgs.length = 0
    const r = await beat('player3', JSON.stringify({ v: 1, game: 'absent', everyS: 300, features: { game: 'ok' } }))
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { ok: true, presence: 'idle', v: 1 })
    await sleep(300)
    const st = msgs.filter(m => m.type === 'daemon-status')
    assert.equal(st.length, 1)
    assert.equal(st[0].daemon.game, 'absent')
    assert.equal(st[0].daemon.presence, 'idle')
    assert.deepEqual(st[0].daemon.features, { game: 'ok' })
    const sync = msgs.filter(m => m.type === 'networth-sync-status')
    assert.ok(sync.length >= 1, 'the presence edge sent the sync status again')
    for (const m of sync) assert.equal(m.pace, undefined, 'no refresher, no pace')
  } finally { ws.close() }
  assert.match(srvLog.join(''), /\[daemon\] player3: unknown -> idle/)
})
