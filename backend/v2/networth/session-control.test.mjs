// session-control.mjs: what starts and ends a session (the buttons, the
// daemon's key, the game's presence), what the refresher is asked to read
// first, and what the daemon's feed hears. Real sessions.mjs on a temporary
// file, a fake refresher and feed, an injected clock: no server, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessions } from './sessions.mjs'
import { createSessionControl, GAME_GAP_MS_DEFAULT } from './session-control.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const silent = { warn () {}, error () {}, log () {} }
const pt = (at, c, cd, rows) => ({ at, c, cd, items: new Map(Object.entries(rows)) })

async function rig ({ autoGame = true, gapMs = 10 * MIN, finalizeMaxMs = 24 * HOUR, sync = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-session-control-'))
  let t = 1_800_000_000_000
  const now = () => t
  const sessions = createSessions(join(dir, 'networth-sessions.json'), { now, log: silent, finalizeMaxMs })
  await sessions.load()
  const latest = new Map()          // user -> point
  const presence = new Map()        // user -> 'playing' | 'idle' | 'unknown'
  const round = new Map()           // user -> { since -> complete }
  const asked = []                  // prioritize calls
  const feed = []
  const changed = []
  const refresher = {
    roundSince: (user, since) => {
      const done = round.get(user)?.(since) === true
      return { done: done ? 3 : 1, total: 3, complete: done }
    },
    prioritize: (user, since) => { asked.push([user, since]) },
    etaFor: (user, since) => ({ done: 1, total: 3, remaining: 2, ms: 150_000 })
  }
  const control = () => createSessionControl({
    sessions,
    latestOf: u => latest.get(u) || null,
    withheldOf: () => [],
    refresher: () => (sync ? refresher : null),
    pushFeed: (user, session, { by }) => feed.push({ user, by, ...session }),
    onChange: user => changed.push(user),
    presenceOf: u => presence.get(u) || 'unknown',
    autoGame,
    gapMs,
    finalizeMaxMs,
    now,
    log: silent
  })
  return {
    ctl: control(), control, sessions, latest, presence, round, asked, feed, changed,
    now,
    advance: ms => { t += ms },
    point: (user, c, rows) => latest.set(user, pt(t, c, 200, rows)),
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}


test('a farm start asks for a round from the start, tells the feed and the page', async () => {
  const x = await rig()
  x.point('player1', 1000, { A: [1, 100] })
  const r = await x.ctl.start('player1', 'farm', { by: 'i1' })
  assert.equal(r.ok, true)
  assert.equal(r.session.state, 'starting')
  assert.equal(r.session.about, 3, '150 s, rounded up to whole minutes')
  assert.deepEqual(x.asked, [['player1', x.now()]])
  assert.equal(x.feed.length, 1)
  assert.deepEqual(
    { user: x.feed[0].user, by: x.feed[0].by, kind: x.feed[0].kind, state: x.feed[0].state, about: x.feed[0].about, balance: x.feed[0].balance },
    { user: 'player1', by: 'i1', kind: 'farm', state: 'starting', about: 3, balance: null })
  assert.deepEqual(x.changed, ['player1'])
  assert.deepEqual(await x.ctl.start('player1', 'farm'), { ok: false, error: 'already-running' })
  assert.equal(x.feed.length, 1, 'a refused start says nothing to the feed')
  await x.cleanup()
})

test('without the background sync there is no session', async () => {
  const x = await rig({ sync: false })
  x.point('player1', 1000, {})
  assert.deepEqual(await x.ctl.start('player1', 'farm'), { ok: false, error: 'sync-off' })
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  assert.equal(x.sessions.runningOf('player1', 'game'), null)
  await x.cleanup()
})

test('the baseline, the end and the final balance each reach the feed once', async () => {
  const x = await rig()
  x.point('player1', 1000, { A: [1, 100] })
  await x.ctl.start('player1', 'farm')
  const startedAt = x.now()
  x.advance(5 * MIN)
  // A point with the round not complete: nothing changes.
  x.point('player1', 1000, { A: [1, 100] })
  await x.ctl.onPoint('player1')
  assert.equal(x.feed.length, 1)
  // The round since the start completes.
  x.round.set('player1', since => since <= startedAt)
  x.advance(MIN)
  x.point('player1', 1100, { A: [2, 200] })
  await x.ctl.onPoint('player1')
  assert.deepEqual(x.feed.map(e => [e.state, e.baseline]), [['starting', null], ['running', 'read']])
  x.advance(60 * MIN)
  x.point('player1', 1400, { A: [5, 500] })
  const e = await x.ctl.end('player1', 'farm', { by: 'i1' })
  assert.equal(e.ok, true)
  const endedAt = x.now()
  assert.deepEqual(x.asked.at(-1), ['player1', endedAt], 'a round from the end')
  assert.equal(x.feed.at(-1).state, 'preliminary')
  assert.equal(x.feed.at(-1).about, 3)
  assert.equal(x.feed.at(-1).by, 'i1')
  x.round.set('player1', since => since <= endedAt)
  x.advance(5 * MIN)
  x.point('player1', 1500, { A: [6, 600] })
  await x.ctl.onPoint('player1')
  const fin = x.feed.at(-1)
  assert.equal(fin.state, 'final')
  assert.equal(fin.balance.loot, 400, 'four more A at the baseline price of 100')
  assert.equal(fin.balance.gains, undefined, 'no item lists in the feed')
  assert.equal(fin.about, null)
  assert.equal(x.feed.length, 4)
  await x.cleanup()
})

test('toggle starts a farm session, and ends the running one', async () => {
  const x = await rig()
  x.point('player1', 1000, {})
  let r = await x.ctl.toggle('player1', { by: 'i1' })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'start')
  x.advance(MIN)
  r = await x.ctl.toggle('player1', { by: 'i1' })
  assert.equal(r.action, 'end')
  assert.equal(r.session.state, 'preliminary')
  x.advance(20 * MIN) // the newest point is old now: a farm start is refused
  r = await x.ctl.toggle('player1')
  assert.deepEqual({ ok: r.ok, error: r.error, action: r.action }, { ok: false, error: 'no-baseline', action: 'start' })
  await x.cleanup()
})

test('the game starts a game session; a farm session started in it belongs to it', async () => {
  const x = await rig()
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  const game = x.sessions.runningOf('player1', 'game')
  assert.ok(game)
  assert.equal(x.feed.at(-1).kind, 'game')
  assert.equal(x.feed.at(-1).state, 'starting')
  assert.deepEqual(x.asked.at(-1), ['player1', game.startedAt])
  x.point('player1', 1000, {})
  const f = await x.ctl.start('player1', 'farm')
  assert.equal(f.session.parent, game.id)
  // A second playing edge (a restart of the game) starts nothing new.
  await x.ctl.onPresence('player1', 'idle', 'playing')
  assert.equal(x.sessions.runningOf('player1', 'game').id, game.id)
  await x.cleanup()
})

test('a game session ends only after the gap without the game, dated to the stop; a restart in the gap does not end it', async () => {
  const x = await rig({ gapMs: 10 * MIN })
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  const game = x.sessions.runningOf('player1', 'game')
  x.advance(HOUR)
  // The game crashes and is started again within the gap.
  x.presence.set('player1', 'idle')
  x.ctl.onPresence('player1', 'playing', 'idle')
  x.advance(5 * MIN)
  await x.ctl.sweep(['player1'])
  x.presence.set('player1', 'playing')
  x.ctl.onPresence('player1', 'idle', 'playing')
  x.advance(10 * MIN)
  await x.ctl.sweep(['player1'])
  assert.equal(x.sessions.runningOf('player1', 'game').id, game.id, 'still the same evening')
  // The game is closed for good.
  x.presence.set('player1', 'idle')
  x.ctl.onPresence('player1', 'playing', 'idle')
  const stoppedAt = x.now()
  x.advance(10 * MIN - 1)
  await x.ctl.sweep(['player1'])
  assert.ok(x.sessions.runningOf('player1', 'game'), 'not before the gap is over')
  x.advance(1)
  await x.ctl.sweep(['player1'])
  assert.equal(x.sessions.runningOf('player1', 'game'), null)
  const ended = x.feed.at(-1)
  assert.equal(ended.kind, 'game')
  assert.equal(ended.state, 'preliminary')
  assert.equal(ended.endedAt, stoppedAt, 'the evening ended when the game stopped')
  assert.deepEqual(x.asked.at(-1), ['player1', stoppedAt])
  await x.cleanup()
})

test('a farm session goes on when its game session ends', async () => {
  const x = await rig({ gapMs: MIN })
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  x.point('player1', 1000, {})
  await x.ctl.start('player1', 'farm')
  x.presence.set('player1', 'idle')
  x.ctl.onPresence('player1', 'playing', 'idle')
  x.advance(2 * MIN)
  await x.ctl.sweep(['player1'])
  assert.equal(x.sessions.runningOf('player1', 'game'), null)
  assert.ok(x.sessions.runningOf('player1', 'farm'), 'the farm session is ended by its own key or button')
  await x.cleanup()
})

test('unknown changes nothing: the gap still runs out, and a session nobody reports on closes as unfinished', async () => {
  const x = await rig({ gapMs: 10 * MIN, finalizeMaxMs: 24 * HOUR })
  // Game closed, then the PC shut down: idle, then unknown.
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  x.advance(HOUR)
  x.presence.set('player1', 'idle')
  x.ctl.onPresence('player1', 'playing', 'idle')
  const stoppedAt = x.now()
  x.advance(3 * MIN)
  x.presence.set('player1', 'unknown')
  x.ctl.onPresence('player1', 'idle', 'unknown')
  x.advance(7 * MIN)
  await x.ctl.sweep(['player1'])
  assert.equal(x.sessions.runningOf('player1', 'game'), null)
  assert.equal(x.feed.at(-1).endedAt, stoppedAt)

  // The daemon goes quiet while the game runs: the session runs on, and is
  // closed as unfinished finalizeMaxMs after the last word.
  x.presence.set('player2', 'playing')
  await x.ctl.onPresence('player2', 'unknown', 'playing')
  x.advance(HOUR)
  await x.ctl.sweep(['player2'])
  const lastWord = x.now()
  x.presence.set('player2', 'unknown')
  x.ctl.onPresence('player2', 'playing', 'unknown')
  x.advance(24 * HOUR - 1)
  await x.ctl.sweep(['player2'])
  assert.ok(x.sessions.runningOf('player2', 'game'))
  x.advance(1)
  await x.ctl.sweep(['player2'])
  assert.equal(x.sessions.runningOf('player2', 'game'), null)
  assert.equal(x.feed.at(-1).state, 'unfinished')
  assert.equal(x.feed.at(-1).endedAt, lastWord)
  await x.cleanup()
})

test('a game evening shorter than its start round is struck against the copy at the start, not a read from after the stop', async () => {
  const x = await rig({ gapMs: 10 * MIN })
  x.point('player1', 1000, { A: [1, 100] })
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  const startedAt = x.now()
  x.advance(20 * MIN)
  x.point('player1', 1500, { A: [6, 600] })
  // The game stops; the start round completes three minutes later.
  x.presence.set('player1', 'idle')
  x.ctl.onPresence('player1', 'playing', 'idle')
  const stoppedAt = x.now()
  x.advance(3 * MIN)
  x.round.set('player1', since => since <= startedAt)
  x.point('player1', 1500, { A: [6, 600] })
  await x.ctl.onPoint('player1')
  assert.equal(x.feed.at(-1).baseline, 'read', 'running on a read from after the stop, for now')
  x.advance(7 * MIN)
  await x.ctl.sweep(['player1'])
  const ended = x.feed.at(-1)
  assert.deepEqual([ended.state, ended.endedAt, ended.baseline], ['preliminary', stoppedAt, 'at-press'])
  x.round.set('player1', since => since <= stoppedAt)
  x.advance(MIN)
  x.point('player1', 1500, { A: [6, 600] })
  await x.ctl.onPoint('player1')
  const fin = x.feed.at(-1)
  assert.equal(fin.state, 'final')
  assert.equal(fin.baseline, 'at-press')
  assert.equal(fin.balance.loot, 500, 'the evening\'s loot, not swallowed by the baseline')
  await x.cleanup()
})

test('the next evening after the PC was shut down with the game running is a new game session', async () => {
  const x = await rig({ gapMs: 10 * MIN, finalizeMaxMs: 24 * HOUR })
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  const first = x.sessions.runningOf('player1', 'game')
  x.advance(3 * HOUR)
  await x.ctl.sweep(['player1'])
  const lastWord = x.now()
  x.presence.set('player1', 'unknown')
  x.ctl.onPresence('player1', 'playing', 'unknown')
  for (let i = 0; i < 20; i++) { x.advance(HOUR); await x.ctl.sweep(['player1']) }
  assert.equal(x.sessions.runningOf('player1', 'game').id, first.id, 'unknown alone ends nothing')
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  const next = x.sessions.runningOf('player1', 'game')
  assert.notEqual(next.id, first.id, 'a new evening')
  assert.equal(next.startedAt, x.now())
  const ended = x.feed.find(e => e.id === first.id && e.state === 'preliminary')
  assert.equal(ended.endedAt, lastWord, 'the old evening ended with the last word')
  // A farm session started now belongs to the new evening.
  x.point('player1', 1000, {})
  const f = await x.ctl.start('player1', 'farm')
  assert.equal(f.session.parent, next.id)
  await x.cleanup()
})

test('a short stretch without a word does not split an evening', async () => {
  const x = await rig({ gapMs: 10 * MIN })
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  const game = x.sessions.runningOf('player1', 'game')
  x.advance(HOUR)
  await x.ctl.sweep(['player1'])
  x.presence.set('player1', 'unknown')
  x.ctl.onPresence('player1', 'playing', 'unknown')
  x.advance(10 * MIN - 1)
  await x.ctl.sweep(['player1'])
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  assert.equal(x.sessions.runningOf('player1', 'game').id, game.id)
  // An idle gap that ran out before the sweep saw it ends the evening at the stop.
  x.presence.set('player1', 'idle')
  x.ctl.onPresence('player1', 'playing', 'idle')
  const stoppedAt = x.now()
  x.advance(10 * MIN)
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'idle', 'playing')
  const next = x.sessions.runningOf('player1', 'game')
  assert.notEqual(next.id, game.id)
  assert.equal(x.feed.find(e => e.id === game.id && e.state === 'preliminary').endedAt, stoppedAt)
  await x.cleanup()
})

test('expire tells the feed and the page what it changed, so the sweep after it has nothing left to say', async () => {
  const x = await rig({ finalizeMaxMs: 24 * HOUR })
  x.point('player1', 1000, {})
  await x.ctl.start('player1', 'farm')
  x.advance(24 * HOUR)
  x.changed.length = 0
  const r = await x.ctl.expire('player1')
  assert.deepEqual(r.changes.map(c => c.state), ['running'])
  assert.deepEqual(x.feed.map(e => [e.state, e.baseline]), [['starting', null], ['running', 'at-press']])
  assert.deepEqual(x.changed, ['player1'])
  await x.ctl.sweep(['player1'])
  assert.equal(x.feed.length, 2)
  assert.deepEqual(await x.ctl.expire('nobody'), { finalized: [], changes: [] })
  await x.cleanup()
})

test('a server start does not close a game session before any daemon could report', async () => {
  const x = await rig({ finalizeMaxMs: HOUR })
  await x.sessions.start('player1', null, { kind: 'game' })
  x.advance(2 * HOUR)
  // A restart: the session is older than the window, the control is not.
  const fresh = x.control()
  await fresh.sweep(['player1'])
  assert.ok(x.sessions.runningOf('player1', 'game'))
  x.advance(HOUR)
  await fresh.sweep(['player1'])
  assert.equal(x.sessions.runningOf('player1', 'game'), null, 'a window after the start without a word')
  await x.cleanup()
})

test('POE_SESSION_AUTO_GAME=0: no game session starts; one already running still ends', async () => {
  const x = await rig({ autoGame: false, gapMs: MIN })
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  assert.equal(x.sessions.runningOf('player1', 'game'), null)
  await x.sessions.start('player2', null, { kind: 'game' })
  x.presence.set('player2', 'idle')
  x.ctl.onPresence('player2', 'playing', 'idle')
  x.advance(MIN)
  await x.ctl.sweep(['player2'])
  assert.equal(x.sessions.runningOf('player2', 'game'), null)
  await x.cleanup()
})

test('the sweep moves a starting session to its copy and closes ended ones past the window, and says so', async () => {
  const x = await rig({ finalizeMaxMs: HOUR })
  x.point('player1', 1000, {})
  await x.ctl.start('player1', 'farm')
  x.advance(HOUR)
  await x.ctl.sweep(['player1'])
  assert.deepEqual(x.feed.map(e => [e.state, e.baseline]), [['starting', null], ['running', 'at-press']])
  await x.ctl.end('player1', 'farm')
  x.advance(HOUR)
  await x.ctl.sweep(['player1'])
  assert.equal(x.feed.at(-1).state, 'unfinished')
  await x.cleanup()
})

test('discard takes a kind; a game session can be discarded, and the feed hears nothing', async () => {
  const x = await rig()
  x.presence.set('player1', 'playing')
  await x.ctl.onPresence('player1', 'unknown', 'playing')
  const n = x.feed.length
  const r = await x.ctl.discard('player1', 'game')
  assert.equal(r.ok, true)
  assert.equal(x.sessions.runningOf('player1', 'game'), null)
  assert.equal(x.feed.length, n)
  assert.deepEqual(await x.ctl.discard('player1', 'game'), { ok: false, error: 'not-running' })
  // The sweep does not start a new one while the player keeps playing.
  await x.ctl.sweep(['player1'])
  assert.equal(x.sessions.runningOf('player1', 'game'), null)
  await x.cleanup()
})

test('the default gap is ten minutes', () => {
  assert.equal(GAME_GAP_MS_DEFAULT, 10 * MIN)
})
