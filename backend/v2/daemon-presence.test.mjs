// daemon-presence.mjs — what the hotkey daemons report about themselves
// (POST /daemon/heartbeat): playing, idle or unknown per user, on the server
// clock only, with `unknown` as the answer whenever nothing fresh says
// otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDaemonPresence, makeHoldAfterGame } from './daemon-presence.mjs'

const S = 1000
function presence (opts = {}) {
  let t = 5_000_000
  const edges = []
  const p = createDaemonPresence({ staleMs: 180 * S, now: () => t, onChange: (u, a, b) => edges.push([u, a, b]), ...opts })
  return { p, edges, add: ms => { t += ms }, at: () => t }
}

test('playing, idle and unknown, and staleness turns into unknown', () => {
  const { p, add } = presence()
  assert.equal(p.presenceOf('a'), 'unknown')
  assert.equal(p.statusOf('a'), null, 'nothing heard: null')
  assert.equal(p.beat('a', 'i1', { game: 'running', everyS: 60 }), 'playing')
  assert.equal(p.beat('a', 'i1', { game: 'absent', everyS: 60 }), 'idle')
  add(180 * S + 1)
  assert.equal(p.presenceOf('a'), 'unknown')
  assert.equal(p.beat('a', 'i1', { game: 'banana' }), 'unknown', 'a game value outside the three is unknown, never playing')
  assert.equal(p.beat('a', 'i1', { game: 'absent', everyS: 300 }), 'idle')
  add(899 * S)
  assert.equal(p.presenceOf('a'), 'idle', 'three announced intervals count, not the shorter stale bar')
  add(2 * S)
  assert.equal(p.presenceOf('a'), 'unknown')
})

test('two instances of one user merge, every change is one edge, junk features are dropped', () => {
  const { p, edges, add } = presence()
  p.beat('a', 'x', { game: 'absent' })
  p.beat('a', 'y', { game: 'running' })
  assert.equal(p.presenceOf('a'), 'playing')
  p.beat('a', 'y', { game: 'running' })
  p.beat('a', 'y', { game: 'running' })
  assert.deepEqual(edges, [['a', 'unknown', 'idle'], ['a', 'idle', 'playing']], 'one edge per change, not one per beat')
  add(181 * S)
  p.sweep(['a', 'b'])
  assert.deepEqual(edges.at(-1), ['a', 'playing', 'unknown'], 'staleness is an edge too')
  p.sweep(['a', 'b'])
  assert.equal(edges.length, 3)

  p.beat('a', 'x', { game: 'unknown' })
  p.beat('a', 'y', { game: 'absent' })
  assert.equal(p.presenceOf('a'), 'unknown', 'a daemon that cannot tell keeps its user at unknown')
  p.beat('a', 'x', { game: 'running' })
  assert.equal(p.presenceOf('a'), 'playing')
  p.beat('a', 'x', { game: 'absent' })
  assert.equal(p.presenceOf('a'), 'idle')

  p.beat('b', 'z', { game: 'absent', features: { overlay: 'no-qt', x: '<script>', Notify: 'ok', downlink: 'a'.repeat(25), notify: 'ok' } })
  assert.deepEqual(p.statusOf('b').features, { overlay: 'no-qt', notify: 'ok' })
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${'abcdefghijkl'[i]}`, 'ok']))
  p.beat('b', 'z', { game: 'absent', features: many })
  assert.equal(Object.keys(p.statusOf('b').features).length, 8)
  p.beat('b', 'z', { game: 'absent', features: 'nope' })
  assert.deepEqual(p.statusOf('b').features, {})
})

test('sweep names a user who lost a daemon without a presence edge', () => {
  const { p, edges, add } = presence()
  p.beat('a', 'x', { game: 'unknown', features: { overlay: 'no-qt' } })
  p.beat('b', 'z', { game: 'running' })
  assert.deepEqual(p.sweep(['a', 'b']), [], 'nothing changed')
  add(181 * S)
  // a: unknown -> unknown, no edge, but 1 -> 0 daemons. b: playing -> unknown is an edge (onChange).
  assert.deepEqual(p.sweep(['a', 'b']), ['a'])
  assert.deepEqual(edges.at(-1), ['b', 'playing', 'unknown'])
  assert.equal(p.statusOf('a').instances, 0)
  assert.deepEqual(p.sweep(['a', 'b']), [], 'once, not on every sweep')
  p.beat('a', 'x', { game: 'unknown' })
  assert.deepEqual(p.sweep(['a', 'b']), [], 'a beat counts itself; the heartbeat route tells the page')
})

test('statusOf: version, game, the last time the game ran, the stop edge and instances', () => {
  const { p, add, at } = presence()
  p.beat('a', 'x', { game: 'running', version: '1.2.3', features: { notify: 'ok' } })
  const t0 = at()
  add(10 * S)
  p.beat('a', 'x', { game: 'absent', version: '1.2.3' })
  p.beat('a', 'y', { game: 'absent', version: '1.2.4' })
  const st = p.statusOf('a')
  assert.equal(st.presence, 'idle')
  assert.equal(st.version, '1.2.4', 'the newest beat speaks')
  assert.equal(st.game, 'absent')
  assert.equal(st.lastGameAt, t0)
  assert.equal(st.lastBeatAt, at())
  assert.equal(st.instances, 2)
  assert.equal(p.lastGameAt('a'), t0)
  assert.equal(p.stoppedAt('a'), at(), 'playing -> idle remembers when')
  add(1000 * S)
  const stale = p.statusOf('a')
  assert.equal(stale.presence, 'unknown')
  assert.equal(stale.instances, 0)
  assert.equal(stale.version, '1.2.4', 'the last report is still shown')
})

test('everyS is clamped and the clock is the server\'s', () => {
  const { p, add } = presence()
  p.beat('a', 'x', { game: 'absent', everyS: 100000, at: 1 })
  add(1801 * S) // 3 x 600 s is the most a beat can stretch its freshness
  assert.equal(p.presenceOf('a'), 'unknown')
  p.beat('a', 'x', { game: 'absent', everyS: 1 })
  add(180 * S - 1)
  assert.equal(p.presenceOf('a'), 'idle', 'never shorter than the stale bar')
})

test('changedForPage: version, features or instances; not the beat time', () => {
  const { p, add } = presence()
  p.beat('a', 'x', { game: 'unknown', version: '1', features: { overlay: 'ok' } })
  const s1 = p.statusOf('a')
  assert.equal(p.changedForPage(null, s1), true, 'the first report is a change')
  add(60 * S)
  p.beat('a', 'x', { game: 'unknown', version: '1', features: { overlay: 'ok' } })
  const s2 = p.statusOf('a')
  assert.equal(p.changedForPage(s1, s2), false)
  p.beat('a', 'x', { game: 'unknown', version: '1', features: { overlay: 'no-qt' } })
  assert.equal(p.changedForPage(s2, p.statusOf('a')), true)
  const s3 = p.statusOf('a')
  p.beat('a', 'x', { game: 'unknown', version: '2', features: { overlay: 'no-qt' } })
  assert.equal(p.changedForPage(s3, p.statusOf('a')), true)
  const s4 = p.statusOf('a')
  p.beat('a', 'y', { game: 'unknown', version: '2', features: { overlay: 'no-qt' } })
  assert.equal(p.changedForPage(s4, p.statusOf('a')), true, 'a second daemon')
})

test('after the game stops, the sync answer stays playing while the hold says so', () => {
  const { p, add } = presence()
  p.beat('a', 'i1', { game: 'running', everyS: 60 })
  add(60 * S)
  const stopAt = (() => { p.beat('a', 'i1', { game: 'absent', everyS: 300 }); return p.stoppedAt('a') })()
  assert.equal(p.presenceOf('a'), 'idle')
  const asked = []
  assert.equal(p.syncPresenceOf('a', (u, t) => { asked.push([u, t]); return true }), 'playing')
  assert.deepEqual(asked, [['a', stopAt]], 'the hold is asked with the time of the stop')
  assert.equal(p.syncPresenceOf('a', () => false), 'idle')
  assert.equal(p.syncPresenceOf('a'), 'idle', 'no hold: the plain answer')
  // Only an idle user is held; playing and unknown pass through.
  assert.equal(p.syncPresenceOf('b', () => true), 'unknown', 'a user never heard of is not held to playing')
  p.beat('c', 'i1', { game: 'absent', everyS: 300 })
  assert.equal(p.syncPresenceOf('c', () => true), 'idle', 'idle without a stop edge (it never played) is not held')
  // A daemon that cannot tell next to one that says 'absent' is unknown, never idle.
  p.beat('d', 'game-pc', { game: 'unknown', everyS: 60 })
  p.beat('d', 'laptop', { game: 'absent', everyS: 300 })
  assert.equal(p.presenceOf('d'), 'unknown')
})

test('makeHoldAfterGame holds until the round since the stop is complete, at most maxMs', () => {
  let t = 10_000_000
  const rounds = new Map()
  const roundSince = (u, since) => rounds.get(u) ?? null
  const hold = makeHoldAfterGame({ maxMs: 3_600_000, roundSince, now: () => t })
  const stop = t - 1000
  rounds.set('a', { done: 3, total: 10, complete: false })
  assert.equal(hold('a', stop), true, 'within maxMs and the round not complete')
  rounds.set('a', { done: 10, total: 10, complete: true })
  assert.equal(hold('a', stop), false, 'the round is complete')
  rounds.set('a', { done: 3, total: 10, complete: false })
  t = stop + 3_600_000
  assert.equal(hold('a', stop), false, 'past maxMs')
  t = stop + 1
  assert.equal(hold('b', stop), true, 'no refresher answer yet (null) is not complete')
  const off = makeHoldAfterGame({ maxMs: 0, roundSince, now: () => t })
  assert.equal(off('a', stop), false, 'maxMs 0: a stopped game yields at once')
})
