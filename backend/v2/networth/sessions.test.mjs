// Farm and game sessions (sessions.mjs): the balance arithmetic as pure
// functions, and the per-user bookkeeping with its file. No server, no
// network, no real clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { balance, hourly, createSessions } from './sessions.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const silent = { warn () {}, error () {}, log () {} }
function recorder () {
  const lines = []
  return { lines, log: { warn: m => lines.push(String(m)), error () {}, log () {} } }
}

// A history.latest() shape: { at, c, cd, items: Map(name -> [qty, chaos]) }
const pt = (at, c, cd, rows) => ({ at, c, cd, items: new Map(Object.entries(rows)) })

function clock (start = 1_800_000_000_000) {
  let t = start
  return { now: () => t, advance: ms => { t += ms }, set: v => { t = v } }
}

async function tmpFile () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-sessions-'))
  return { dir, file: join(dir, 'networth-sessions.json'), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
// balance() and hourly()
// ---------------------------------------------------------------------------

test('balance: a change in stock at start prices is loot, the rest is market', () => {
  const b = balance(pt(1, 1000, 200, { A: [10, 100] }), pt(2, 1300, 200, { A: [12, 150] }))
  assert.equal(b.loot, 20)
  assert.equal(b.total, 300)
  assert.equal(b.market, 280)
  assert.deepEqual(b.gains, [['A', 2, 20]])
  assert.deepEqual(b.losses, [])
  assert.equal(b.startAt, 1)
  assert.equal(b.endAt, 2)
})

test('balance: an item new to the stash is valued at its end price, one that left at its start price', () => {
  const b = balance(pt(1, 50, 200, { B: [1, 50] }), pt(2, 30, 200, { C: [3, 30] }))
  assert.equal(b.loot, -20)
  assert.deepEqual(b.gains, [['C', 3, 30]])
  assert.deepEqual(b.losses, [['B', -1, -50]])
})

test('balance: an item that only gained or lost a price is not loot', () => {
  const b = balance(pt(1, 100, 200, { D: [5, 0] }), pt(2, 125, 200, { D: [5, 25] }))
  assert.equal(b.loot, 0)
  assert.equal(b.market, 25)
  assert.deepEqual(b.gains, [])
  assert.equal(b.unpricedIn, 0)
})

test('balance: an arrival without a price counts 0 and is counted in unpricedIn', () => {
  const b = balance(pt(1, 100, 200, {}), pt(2, 100, 200, { E: [4, 0] }))
  assert.equal(b.loot, 0)
  assert.equal(b.unpricedIn, 1)
  assert.deepEqual(b.gains, [])
  assert.deepEqual(b.losses, [])
})

test('balance: gains and losses are cut to topN, biggest first; topN 0 lists none', () => {
  const s = {}; const e = {}
  for (let i = 1; i <= 7; i++) { s[`G${i}`] = [1, 10]; e[`G${i}`] = [1 + i, 10 * (1 + i)] }
  s.L1 = [5, 50]; e.L1 = [4, 40]
  s.L2 = [5, 50]; e.L2 = [2, 20]
  const start = pt(1, 1000, 200, s); const end = pt(2, 1500, 200, e)
  const b = balance(start, end, { topN: 5 })
  assert.equal(b.gains.length, 5)
  assert.deepEqual(b.gains.map(r => r[0]), ['G7', 'G6', 'G5', 'G4', 'G3'])
  assert.deepEqual(b.losses.map(r => r[0]), ['L2', 'L1'], 'most negative first')
  const none = balance(start, end, { topN: 0 })
  assert.deepEqual(none.gains, [])
  assert.deepEqual(none.losses, [])
  assert.equal(none.loot, b.loot)
  assert.equal(none.total, b.total)
})

test('balance: loot is converted at the start rate, the total at each end\'s own rate', () => {
  const b = balance(pt(1, 2000, 200, { A: [1, 200] }), pt(2, 2500, 250, { A: [2, 500] }))
  assert.equal(b.loot, 200)
  assert.equal(b.totalDiv, 0)
  assert.equal(b.lootDiv, 1)
  assert.equal(b.marketDiv, -1)
})

test('balance: without a rate at either end the divine figures are null, never a guess', () => {
  const noStart = balance(pt(1, 2000, 0, { A: [1, 200] }), pt(2, 2500, 250, { A: [2, 500] }))
  assert.equal(noStart.totalDiv, null)
  assert.equal(noStart.lootDiv, null)
  assert.equal(noStart.marketDiv, null)
  const noEnd = balance(pt(1, 2000, 200, { A: [1, 200] }), pt(2, 2500, 0, { A: [2, 500] }))
  assert.equal(noEnd.totalDiv, null)
  assert.equal(noEnd.lootDiv, 1)
  assert.equal(noEnd.marketDiv, null)
})

test('hourly: from rateMinMs on, never with a changed stash; rateMinMs 0 always', () => {
  const bal = { loot: 100, lootDiv: 0.5 }
  assert.deepEqual(hourly(bal, 30 * MIN, { rateMinMs: 10 * MIN }), { lootPerHour: 200, lootPerHourDiv: 1 })
  assert.deepEqual(hourly(bal, 5 * MIN, { rateMinMs: 10 * MIN }), { lootPerHour: null, lootPerHourDiv: null })
  assert.equal(hourly(bal, 5 * MIN, { rateMinMs: 0 }).lootPerHour, 1200)
  assert.equal(hourly(bal, 30 * MIN, { rateMinMs: 10 * MIN, stashChanged: true }).lootPerHour, null)
  assert.equal(hourly({ loot: 100, lootDiv: null }, 30 * MIN, { rateMinMs: 0 }).lootPerHourDiv, null)
})

// ---------------------------------------------------------------------------
// createSessions()
// ---------------------------------------------------------------------------

async function sessions (opts = {}) {
  const t = await tmpFile()
  const c = clock()
  const s = createSessions(t.file, { now: c.now, log: silent, ...opts })
  await s.load()
  return { ...t, c, s }
}

const complete = () => ({ done: 3, total: 3, complete: true })
const incomplete = () => ({ done: 1, total: 3, complete: false })

// Start a session and give it a read baseline at once: the first point after
// the start, with every tab read since. `rows` and the totals are the start.
async function startRead (s, c, user, c0, cd, rows, opts = {}) {
  const r = await s.start(user, pt(c.now(), c0, cd, rows), opts)
  assert.equal(r.ok, true, `start: ${r.error}`)
  c.advance(1)
  await s.observe(user, pt(c.now(), c0, cd, rows), { roundSince: complete })
  return r.session
}

test('start refuses without a baseline, with a stale one, and while a session runs', async () => {
  const { c, s, cleanup } = await sessions({ baselineMaxAgeMs: 10 * MIN })
  assert.deepEqual(await s.start('player1', null), { ok: false, error: 'no-baseline' })
  const stale = pt(c.now() - 10 * MIN - 1, 100, 200, { A: [1, 10] })
  assert.deepEqual(await s.start('player1', stale), { ok: false, error: 'no-baseline' })
  const fresh = pt(c.now() - MIN, 100, 200, { A: [1, 10] })
  const r = await s.start('player1', fresh)
  assert.equal(r.ok, true)
  assert.equal(r.session.state, 'starting', 'no figure until the stash was read once after the start')
  assert.equal(r.session.kind, 'farm')
  assert.equal(r.session.balance, null)
  assert.deepEqual(await s.start('player1', fresh), { ok: false, error: 'already-running' })
  // Two clicks at once: exactly one of them starts.
  const [a, b] = await Promise.all([s.start('player2', fresh), s.start('player2', fresh)])
  assert.equal([a, b].filter(x => x.ok).length, 1)
  await cleanup()
})

test('the copy at the start is a copy: a later change to the history\'s map does not move it', async () => {
  const { c, s, cleanup } = await sessions()
  const latest = pt(c.now(), 100, 200, { A: [10, 100] })
  await s.start('player1', latest)
  latest.items.get('A')[0] = 99
  latest.items.set('A', [99, 990])
  c.advance(MIN)
  await s.end('player1') // still starting: the copy becomes the baseline
  const end = pt(c.now(), 130, 200, { A: [12, 120] })
  const v = s.view('player1', end, {})
  assert.equal(v.pending[0].baseline, 'at-press')
  assert.deepEqual(v.pending[0].balance.gains, [['A', 2, 20]])
  await cleanup()
})

test('the baseline is the first point after a complete round since the start', async () => {
  const { c, s, cleanup } = await sessions()
  await s.start('player1', pt(c.now() - MIN, 1000, 200, { A: [1, 100] }))
  const startedAt = c.now()
  // A point from before the start, and one after it with the round not
  // complete yet: neither is the baseline.
  let r = await s.observe('player1', pt(startedAt - 1, 1000, 200, { A: [1, 100] }), { roundSince: complete })
  assert.deepEqual(r.changes, [])
  c.advance(MIN)
  let asked = null
  r = await s.observe('player1', pt(c.now(), 1100, 200, { A: [2, 200] }), { roundSince: since => { asked = since; return incomplete() } })
  assert.equal(asked, startedAt, 'the round is counted from the start')
  assert.deepEqual(r.changes, [])
  let v = s.view('player1', pt(c.now(), 1100, 200, { A: [2, 200] }), { roundSince: incomplete, aboutOf: since => (since === startedAt ? 4 : -1) })
  assert.equal(v.running.state, 'starting')
  assert.deepEqual(v.running.round, { done: 1, total: 3 })
  assert.equal(v.running.about, 4, 'minutes until the baseline, from the refresher')
  assert.equal(v.running.balance, null)
  // The round completes: the point it completed with is the baseline.
  c.advance(MIN)
  const base = pt(c.now(), 1200, 200, { A: [3, 300] })
  r = await s.observe('player1', base, { roundSince: complete })
  assert.deepEqual(r.changes, [{ id: v.running.id, kind: 'farm', state: 'running' }])
  c.advance(10 * MIN)
  v = s.view('player1', pt(c.now(), 1400, 200, { A: [5, 500] }), { roundSince: incomplete })
  assert.equal(v.running.state, 'running')
  assert.equal(v.running.baseline, 'read')
  assert.equal(v.running.round, null, 'a running session waits for no round')
  assert.equal(v.running.balance.loot, 200, 'two more A at the baseline price, not three')
  assert.equal(v.running.balance.startAt, base.at)
  await cleanup()
})

test('a starting session past finalizeMaxMs starts from the copy at the start, if it has one', async () => {
  const { c, s, cleanup } = await sessions({ finalizeMaxMs: 60 * MIN, baselineMaxAgeMs: 10 * MIN })
  await s.start('player1', pt(c.now(), 1000, 200, { A: [1, 100] }))
  // A game session without a fresh point has no copy.
  await s.start('player1', pt(c.now() - 11 * MIN, 1000, 200, { A: [1, 100] }), { kind: 'game' })
  c.advance(60 * MIN - 1)
  assert.deepEqual((await s.expire('player1', null)).changes, [])
  c.advance(1)
  const r = await s.expire('player1', null)
  assert.equal(r.changes.length, 1)
  assert.equal(r.changes[0].kind, 'farm')
  assert.equal(r.changes[0].state, 'running')
  const latest = pt(c.now(), 1300, 200, { A: [4, 400] })
  const v = s.view('player1', latest, {})
  assert.equal(v.running.baseline, 'at-press')
  assert.equal(v.running.balance.loot, 300)
  assert.equal(v.game.state, 'starting', 'no copy: it keeps waiting for a read')
  assert.equal(v.game.baseline, null)
  // observe() applies the same window.
  const t2 = await sessions({ finalizeMaxMs: 60 * MIN })
  await t2.s.start('player1', pt(t2.c.now(), 1000, 200, {}))
  t2.c.advance(60 * MIN)
  const r2 = await t2.s.observe('player1', pt(t2.c.now(), 1000, 200, {}), { roundSince: incomplete })
  assert.deepEqual(r2.changes.map(x => x.state), ['running'])
  assert.equal(t2.s.view('player1', null, {}).running.baseline, 'at-press')
  await t2.cleanup()
  await cleanup()
})

test('a session ended before its baseline was read takes the copy at the start, or closes without figures', async () => {
  const { c, s, cleanup } = await sessions({ baselineMaxAgeMs: 10 * MIN })
  // With a copy: the end sets it as the baseline.
  await s.start('player1', pt(c.now(), 1000, 200, { A: [1, 100] }))
  c.advance(5 * MIN)
  const e = await s.end('player1')
  assert.equal(e.session.state, 'preliminary')
  assert.equal(e.session.baseline, 'at-press')
  // Without a copy (a game session started on an old point): no baseline, so
  // its round closes it as unfinished, without a figure.
  await s.start('player2', pt(c.now() - 20 * MIN, 1000, 200, { A: [1, 100] }), { kind: 'game' })
  c.advance(5 * MIN)
  const g = await s.end('player2', { kind: 'game' })
  assert.equal(g.session.baseline, null)
  c.advance(MIN)
  const later = pt(c.now(), 1300, 200, { A: [4, 400] })
  const r = await s.observe('player2', later, { roundSince: complete })
  assert.deepEqual(r.changes, [{ id: g.session.id, kind: 'game', state: 'unfinished' }])
  const d = s.view('player2', later, {}).done[0]
  assert.equal(d.state, 'unfinished')
  assert.equal(d.balance, null)
  assert.equal(d.kind, 'game')
  await cleanup()
})

test('a tab change while starting is no change for a read baseline, and one for the copy', async () => {
  const { c, s, cleanup } = await sessions()
  await s.start('player1', pt(c.now(), 1000, 200, {}))
  await s.start('player2', pt(c.now(), 1000, 200, {}))
  await s.noteStashChanged('player1')
  await s.noteStashChanged('player2')
  c.advance(MIN)
  await s.observe('player1', pt(c.now(), 1000, 200, {}), { roundSince: complete })
  assert.equal(s.view('player1', null, {}).running.stashChanged, false, 'the baseline was read after the change')
  await s.end('player2')
  assert.equal(s.view('player2', null, {}).pending[0].stashChanged, true, 'the copy was taken before it')
  await cleanup()
})

test('a read baseline from after a backdated end gives way to the copy at the start', async () => {
  // A game evening shorter than the start round: the read baseline arrives in
  // the gap after the game stopped, and the end is dated back to the stop.
  const { c, s, file, cleanup } = await sessions({ baselineMaxAgeMs: 10 * MIN })
  await s.start('player1', pt(c.now(), 1000, 200, { A: [1, 100] }), { kind: 'game' })
  c.advance(20 * MIN)
  const stoppedAt = c.now()
  c.advance(3 * MIN)
  // The loot is in the stash; the start round completes after the stop.
  await s.observe('player1', pt(c.now(), 1500, 200, { A: [6, 600] }), { roundSince: complete })
  assert.equal(s.view('player1', null, {}).game.baseline, 'read')
  await s.noteStashChanged('player1')
  // The copy and the tab change since the press survive a reload.
  const again = createSessions(file, { now: c.now, log: silent })
  await again.load()
  c.advance(7 * MIN)
  const e = await again.end('player1', { kind: 'game', at: stoppedAt })
  assert.equal(e.session.endedAt, stoppedAt)
  assert.equal(e.session.baseline, 'at-press', 'a read from after the end is no baseline')
  c.advance(MIN)
  const later = pt(c.now(), 1500, 200, { A: [6, 600] })
  const r = await again.observe('player1', later, { roundSince: complete })
  assert.deepEqual(r.changes.map(x => x.state), ['final'])
  const d = again.view('player1', later, {}).done[0]
  assert.equal(d.baseline, 'at-press')
  assert.equal(d.balance.loot, 500, 'the evening\'s five A, not swallowed by the baseline')
  assert.equal(d.stashChanged, true, 'a tab change since the press counts for the copy')
  const doc = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(doc.users.player1.pending.length, 0)
  await cleanup()
})

test('without a copy a read baseline from after the end leaves the session without figures', async () => {
  const { c, s, cleanup } = await sessions({ baselineMaxAgeMs: 10 * MIN })
  // A game session started on an old point has no copy.
  await s.start('player1', pt(c.now() - 20 * MIN, 1000, 200, { A: [1, 100] }), { kind: 'game' })
  c.advance(20 * MIN)
  const stoppedAt = c.now()
  c.advance(3 * MIN)
  await s.observe('player1', pt(c.now(), 1500, 200, { A: [6, 600] }), { roundSince: complete })
  c.advance(7 * MIN)
  const e = await s.end('player1', { kind: 'game', at: stoppedAt })
  assert.equal(e.session.baseline, null)
  c.advance(MIN)
  const later = pt(c.now(), 1500, 200, { A: [6, 600] })
  await s.observe('player1', later, { roundSince: complete })
  const d = s.view('player1', later, {}).done[0]
  assert.equal(d.state, 'unfinished')
  assert.equal(d.balance, null)
  // closeRunning decides the same way.
  await s.start('player2', pt(c.now(), 1000, 200, { A: [1, 100] }), { kind: 'game' })
  const startedAt = c.now()
  c.advance(10 * MIN)
  await s.observe('player2', pt(c.now(), 1300, 200, { A: [4, 400] }), { roundSince: complete })
  const r = await s.closeRunning('player2', { kind: 'game', endedAt: startedAt + MIN, latest: pt(c.now(), 1300, 200, { A: [4, 400] }) })
  assert.equal(r.session.baseline, 'at-press')
  assert.equal(r.session.balance.loot, 300)
  await cleanup()
})

test('a read baseline from before the end stays, and the copy is dropped at the end', async () => {
  const { c, s, file, cleanup } = await sessions()
  await startRead(s, c, 'player1', 1000, 200, { A: [1, 100] })
  let doc = JSON.parse(await readFile(file, 'utf8'))
  assert.ok(Array.isArray(doc.users.player1.running[0].press.i), 'kept until the end')
  c.advance(30 * MIN)
  const e = await s.end('player1')
  assert.equal(e.session.baseline, 'read')
  doc = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(doc.users.player1.pending[0].press, null, 'the end decided the baseline; the copy goes')
  await cleanup()
})

test('game and farm sessions run side by side; a farm session started in a game session belongs to it', async () => {
  const { c, s, cleanup } = await sessions({ baselineMaxAgeMs: 10 * MIN })
  // A game session needs no fresh point: it starts on the game's word.
  const g = await s.start('player1', null, { kind: 'game' })
  assert.equal(g.ok, true)
  assert.equal(g.session.kind, 'game')
  assert.match(g.session.id, /^g-/)
  assert.equal(g.session.parent, null)
  assert.deepEqual(await s.start('player1', null, { kind: 'game' }), { ok: false, error: 'already-running' })
  assert.deepEqual(await s.start('player1', pt(c.now(), 1, 200, {}), { kind: 'raid' }), { ok: false, error: 'bad-kind' })
  c.advance(MIN)
  const f = await s.start('player1', pt(c.now(), 1000, 200, {}))
  assert.equal(f.session.parent, g.session.id)
  assert.equal(s.runningOf('player1', 'game').id, g.session.id)
  assert.equal(s.runningOf('player1', 'farm').state, 'starting')
  assert.equal(s.runningOf('player2', 'farm'), null)
  // The game ends; the farm session goes on and keeps its parent.
  c.advance(MIN)
  await s.end('player1', { kind: 'game' })
  const v = s.view('player1', null, {})
  assert.equal(v.game, null)
  assert.equal(v.running.parent, g.session.id)
  assert.equal(v.pending[0].kind, 'game')
  // A farm session started without a game session has no parent.
  const other = await s.start('player2', pt(c.now(), 1000, 200, {}))
  assert.equal(other.session.parent, null)
  await cleanup()
})

test('end at a moment in the past is clamped to the start and to now', async () => {
  const { c, s, cleanup } = await sessions()
  await s.start('player1', null, { kind: 'game' })
  const startedAt = c.now()
  c.advance(30 * MIN)
  let r = await s.end('player1', { kind: 'game', at: startedAt + 10 * MIN })
  assert.equal(r.session.endedAt, startedAt + 10 * MIN)
  assert.equal(r.session.durationMs, 10 * MIN)
  await s.start('player2', null, { kind: 'game' })
  r = await s.end('player2', { kind: 'game', at: 0 })
  assert.equal(r.session.endedAt, c.now())
  await s.start('player3', null, { kind: 'game' })
  r = await s.end('player3', { kind: 'game', at: c.now() + HOUR })
  assert.equal(r.session.endedAt, c.now())
  await cleanup()
})

test('closeRunning ends a running session and closes it as unfinished at once', async () => {
  const { c, s, cleanup } = await sessions()
  await startRead(s, c, 'player1', 1000, 200, { A: [1, 100] }, { kind: 'game' })
  const startedAt = c.now() - 1
  c.advance(2 * HOUR)
  const latest = pt(c.now(), 1300, 200, { A: [4, 400] })
  const r = await s.closeRunning('player1', { kind: 'game', endedAt: startedAt + HOUR, latest })
  assert.equal(r.ok, true)
  assert.equal(r.session.state, 'unfinished')
  assert.equal(r.session.endedAt, startedAt + HOUR)
  assert.equal(r.session.balance.loot, 300)
  assert.equal(s.isOpen('player1'), false)
  assert.deepEqual(await s.closeRunning('player1', { kind: 'game' }), { ok: false, error: 'not-running' })
  await cleanup()
})

test('discarding a game session leaves its farm sessions without a parent', async () => {
  const { c, s, cleanup } = await sessions()
  const g = await s.start('player1', null, { kind: 'game' })
  await s.start('player1', pt(c.now(), 1000, 200, {}))
  c.advance(MIN)
  await s.end('player1')
  await s.start('player1', pt(c.now(), 1000, 200, {}))
  assert.deepEqual(await s.discard('player1', { kind: 'game' }), { ok: true, session: { id: g.session.id, kind: 'game' } })
  const v = s.view('player1', null, {})
  assert.equal(v.game, null)
  assert.equal(v.running.parent, null)
  assert.equal(v.pending[0].parent, null)
  await cleanup()
})

test('get finds a session where it is: running, ended or closed', async () => {
  const { c, s, cleanup } = await sessions()
  const a = await s.start('player1', pt(c.now(), 1000, 200, {}))
  assert.equal(s.get('player1', a.session.id, null, {}).state, 'starting')
  c.advance(MIN)
  await s.end('player1')
  assert.equal(s.get('player1', a.session.id, null, {}).state, 'preliminary')
  c.advance(MIN)
  await s.observe('player1', pt(c.now(), 1000, 200, {}), { roundSince: complete })
  assert.equal(s.get('player1', a.session.id, null, {}).state, 'final')
  assert.equal(s.get('player1', 'nope', null, {}), null)
  assert.equal(s.get('player9', a.session.id, null, {}), null)
  await cleanup()
})

test('end makes the running session preliminary; end without one is not-running', async () => {
  const { c, s, cleanup } = await sessions()
  await s.start('player1', pt(c.now(), 100, 200, {}))
  c.advance(30 * MIN)
  const r = await s.end('player1')
  assert.equal(r.ok, true)
  const v = s.view('player1', pt(c.now(), 100, 200, {}), {})
  assert.equal(v.running, null)
  assert.equal(v.pending.length, 1)
  assert.equal(v.pending[0].state, 'preliminary')
  assert.equal(v.pending[0].endedAt, c.now())
  assert.equal(v.pending[0].durationMs, 30 * MIN)
  assert.deepEqual(await s.end('player1'), { ok: false, error: 'not-running' })
  await cleanup()
})

test('discard drops the running session without a trace; without one it is not-running', async () => {
  const { c, s, file, cleanup } = await sessions()
  await s.start('player1', pt(c.now(), 100, 200, {}))
  assert.equal(s.isOpen('player1'), true)
  const r = await s.discard('player1')
  assert.equal(r.ok, true)
  assert.equal(s.isOpen('player1'), false)
  const v = s.view('player1', pt(c.now(), 100, 200, {}), {})
  assert.equal(v.running, null)
  assert.deepEqual(v.pending, [])
  assert.deepEqual(v.done, [])
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(onDisk.users.player1.running, [])
  assert.deepEqual(onDisk.users.player1.done, [])
  assert.deepEqual(await s.discard('player1'), { ok: false, error: 'not-running' })
  // An ended session waiting for confirmation is not the running one.
  await s.start('player1', pt(c.now(), 100, 200, {}))
  await s.end('player1')
  assert.deepEqual(await s.discard('player1'), { ok: false, error: 'not-running' })
  assert.equal(s.view('player1', null, {}).pending.length, 1)
  await cleanup()
})

test('a session becomes final only with a point after the end and a complete round', async () => {
  const { c, s, cleanup } = await sessions()
  await s.start('player1', pt(c.now(), 1000, 200, { A: [1, 100] }))
  c.advance(60 * MIN)
  await s.end('player1')
  const endedAt = c.now()
  let r = await s.observe('player1', pt(endedAt - 1, 1100, 200, { A: [2, 200] }), { roundSince: complete })
  assert.deepEqual(r.finalized, [])
  c.advance(MIN)
  r = await s.observe('player1', pt(c.now(), 1100, 200, { A: [2, 200] }), { roundSince: incomplete })
  assert.deepEqual(r.finalized, [])
  const v0 = s.view('player1', pt(c.now(), 1100, 200, { A: [2, 200] }), { roundSince: incomplete })
  assert.deepEqual(v0.pending[0].round, { done: 1, total: 3 })
  c.advance(MIN)
  const last = pt(c.now(), 1100, 200, { A: [2, 200] })
  let asked = null
  r = await s.observe('player1', last, { roundSince: since => { asked = since; return complete() } })
  assert.equal(asked, endedAt, 'the round is counted from the end')
  assert.equal(r.finalized.length, 1)
  const v = s.view('player1', last, {})
  assert.deepEqual(v.pending, [])
  assert.equal(v.done[0].state, 'final')
  assert.equal(v.done[0].balance.endAt, last.at)
  assert.equal(v.done[0].balance.loot, 100)
  assert.equal(v.done[0].balance.lootPerHour, 100)
  assert.equal(v.done[0].baseline, 'at-press', 'ended before a read: the copy at the start')
  assert.equal(v.done[0].kind, 'farm')
  assert.equal(s.isOpen('player1'), false)
  await cleanup()
})

test('a session not confirmed within finalizeMaxMs is closed as unfinished', async () => {
  const { c, s, cleanup } = await sessions({ finalizeMaxMs: 24 * 60 * MIN })
  await s.start('player1', pt(c.now(), 1000, 200, { A: [1, 100] }))
  c.advance(30 * MIN)
  await s.end('player1')
  const never = () => ({ done: 0, total: 3, complete: false })
  c.advance(24 * 60 * MIN - 1)
  let r = await s.observe('player1', pt(c.now(), 1200, 200, { A: [3, 300] }), { roundSince: never })
  assert.deepEqual(r.finalized, [])
  c.advance(1)
  const latest = pt(c.now(), 1200, 200, { A: [3, 300] })
  r = await s.observe('player1', latest, { roundSince: never })
  assert.equal(r.finalized.length, 1)
  const v = s.view('player1', latest, {})
  assert.equal(v.done[0].state, 'unfinished')
  assert.equal(v.done[0].balance.endAt, latest.at)
  assert.equal(v.done[0].balance.loot, 200)
  await cleanup()
})

test('expire closes an ended session past finalizeMaxMs without a new point', async () => {
  const { c, s, file, cleanup } = await sessions({ finalizeMaxMs: 24 * 60 * MIN })
  // The sync stopped before the end: the newest point is older than the end.
  const startPt = pt(c.now(), 1000, 200, { A: [1, 100] })
  await s.start('player1', startPt)
  c.advance(30 * MIN)
  const beforeEnd = pt(c.now(), 1100, 200, { A: [2, 200] })
  c.advance(10 * MIN)
  await s.end('player1')
  c.advance(24 * 60 * MIN - 1)
  assert.deepEqual((await s.expire('player1', beforeEnd)).finalized, [], 'still inside the window')
  assert.equal(s.view('player1', beforeEnd, {}).pending.length, 1)
  c.advance(1)
  const r = await s.expire('player1', beforeEnd)
  assert.equal(r.finalized.length, 1)
  const v = s.view('player1', beforeEnd, {})
  assert.deepEqual(v.pending, [])
  assert.equal(v.done[0].state, 'unfinished')
  assert.equal(v.done[0].balance, null, 'no point from after the end: no figure, not one that stops early')
  assert.equal(v.done[0].stashChanged, false)
  assert.equal(s.isOpen('player1'), false)
  // No history at all closes it the same way, and the record survives a reload.
  assert.equal((await s.start('player2', pt(c.now(), 1000, 200, { A: [1, 100] }))).ok, true)
  c.advance(MIN)
  await s.noteStashChanged('player2')
  await s.end('player2')
  c.advance(24 * 60 * MIN)
  assert.equal((await s.expire('player2', null)).finalized.length, 1)
  const again = createSessions(file, { now: c.now, log: silent })
  await again.load()
  const d = again.view('player2', null, {}).done[0]
  assert.equal(d.state, 'unfinished')
  assert.equal(d.balance, null)
  assert.equal(d.stashChanged, true)
  await cleanup()
})

test('expire strikes the balance against a point from after the end when there is one', async () => {
  const { c, s, cleanup } = await sessions({ finalizeMaxMs: 60 * MIN })
  await s.start('player1', pt(c.now(), 1000, 200, { A: [1, 100] }))
  c.advance(30 * MIN)
  await s.end('player1')
  c.advance(MIN)
  const after = pt(c.now(), 1300, 200, { A: [4, 400] })
  c.advance(60 * MIN)
  assert.deepEqual((await s.expire('player9', after)).finalized, [], 'unknown user: nothing to do')
  assert.equal((await s.expire('player1', after)).finalized.length, 1)
  const d = s.view('player1', after, {}).done[0]
  assert.equal(d.state, 'unfinished')
  assert.equal(d.balance.loot, 300)
  assert.equal(d.balance.endAt, after.at)
  await cleanup()
})

test('noteStashChanged marks running and pending sessions and drops their hourly figure', async () => {
  const { c, s, cleanup } = await sessions({ rateMinMs: 0 })
  assert.equal(await s.noteStashChanged('player1'), false, 'nothing open')
  await startRead(s, c, 'player1', 1000, 200, { A: [1, 100] })
  c.advance(30 * MIN)
  const latest = pt(c.now(), 1100, 200, { A: [2, 200] })
  assert.notEqual(s.view('player1', latest, {}).running.balance.lootPerHour, null)
  assert.equal(await s.noteStashChanged('player1'), true)
  const v = s.view('player1', latest, {})
  assert.equal(v.running.stashChanged, true)
  assert.equal(v.running.balance.stashChanged, true)
  assert.equal(v.running.balance.lootPerHour, null)
  assert.equal(await s.noteStashChanged('player1'), false, 'already marked: nothing new to save or send')
  await cleanup()
})

test('withheld names only arrivals of this session that are in the end stash', async () => {
  const { c, s, cleanup } = await sessions()
  await startRead(s, c, 'player1', 1000, 200, { Z: [1, 0] })
  c.advance(MIN)
  const latest = pt(c.now(), 1000, 200, { X: [1, 0], Z: [1, 0] })
  const v = s.view('player1', latest, { withheld: ['X', 'Y', 'Z'] })
  assert.deepEqual(v.running.balance.withheld, ['X'])
  await cleanup()
})

test('a withheld arrival is named as withheld, not also counted as arriving without a price', async () => {
  const b = balance(pt(1, 100, 200, {}), pt(2, 100, 200, { X: [1, 0], E: [4, 0] }), { withheld: ['X'] })
  assert.equal(b.unpricedIn, 1, 'only E came in without a price')
  const { c, s, cleanup } = await sessions()
  await s.start('player1', pt(c.now(), 1000, 200, {}))
  c.advance(MIN)
  await s.end('player1')
  c.advance(MIN)
  const latest = pt(c.now(), 1000, 200, { X: [1, 0], E: [4, 0] })
  const v = s.view('player1', latest, { withheld: ['X'] })
  assert.deepEqual(v.pending[0].balance.withheld, ['X'])
  assert.equal(v.pending[0].balance.unpricedIn, 1)
  await s.observe('player1', latest, { roundSince: () => ({ done: 1, total: 1, complete: true }), withheld: ['X'] })
  const d = s.view('player1', latest, {}).done[0]
  assert.deepEqual(d.balance.withheld, ['X'])
  assert.equal(d.balance.unpricedIn, 1)
  await cleanup()
})

test('live: a changed stash is passed on, so the status line does not show its loot as farmed', async () => {
  const { c, s, cleanup } = await sessions()
  await s.start('player1', pt(c.now(), 1000, 200, { A: [1, 100] }))
  c.advance(10 * MIN)
  const latest = pt(c.now(), 11000, 200, { A: [1, 100], B: [50, 10000] })
  assert.equal(s.live('player1', latest).running.stashChanged, false)
  await s.noteStashChanged('player1')
  assert.equal(s.live('player1', latest).running.stashChanged, true)
  await cleanup()
})

test('live: a running session reports loot at the start rate; none reports null', async () => {
  const { c, s, cleanup } = await sessions()
  assert.deepEqual(s.live('player1', null), { running: null, game: null, pending: 0 })
  await s.start('player1', pt(c.now(), 1000, 200, { A: [1, 100] }))
  assert.equal(s.live('player1', null).running.state, 'starting')
  assert.equal(s.live('player1', pt(c.now(), 1700, 250, { A: [8, 800] })).running.loot, null, 'no baseline, no figure')
  c.advance(1)
  await s.observe('player1', pt(c.now(), 1000, 200, { A: [1, 100] }), { roundSince: complete })
  c.advance(10 * MIN)
  const latest = pt(c.now(), 1700, 250, { A: [8, 800] })
  const l = s.live('player1', latest)
  assert.equal(l.pending, 0)
  assert.equal(l.running.loot, 700)
  assert.equal(l.running.lootDiv, 3.5)
  assert.equal(l.running.asOf, latest.at)
  assert.equal(typeof l.running.id, 'string')
  assert.equal(typeof l.running.startedAt, 'number')
  assert.equal(l.running.state, 'running')
  assert.equal(l.running.baseline, 'read')
  assert.equal(l.game, null)
  // Without a point to measure against the figures are null, not zero.
  const blind = s.live('player1', null)
  assert.equal(blind.running.loot, null)
  assert.equal(blind.running.lootDiv, null)
  await s.start('player1', null, { kind: 'game' })
  assert.equal(s.live('player1', latest).game.kind, 'game')
  await s.end('player1')
  assert.equal(s.live('player1', latest).running, null)
  assert.equal(s.live('player1', latest).pending, 1)
  await cleanup()
})

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

test('start, end and closing are on disk, and a reload shows the same view', async () => {
  const { c, s, file, cleanup } = await sessions()
  await s.start('player1', pt(c.now(), 1000, 200, { A: [1, 100], B: [2, 0] }))
  c.advance(20 * MIN)
  await s.end('player1')
  c.advance(MIN)
  const latest = pt(c.now(), 1300, 200, { A: [4, 400], C: [1, 50] })
  await s.observe('player1', latest, { roundSince: complete })
  await s.start('player1', pt(c.now(), 1300, 200, { A: [4, 400] }))
  c.advance(5 * MIN)
  await s.end('player1')
  c.advance(MIN)
  await s.start('player1', pt(c.now(), 1300, 200, { A: [4, 400] }))
  const view = s.view('player1', latest, { roundSince: complete })
  const again = createSessions(file, { now: c.now, log: silent })
  await again.load()
  assert.deepEqual(again.view('player1', latest, { roundSince: complete }), view)
  assert.equal(view.done[0].kind, 'farm')
  await s.start('player1', null, { kind: 'game' })
  await startRead(s, c, 'player2', 1000, 200, { A: [1, 100] })
  const view2 = s.view('player2', latest, {})
  const again2 = createSessions(file, { now: c.now, log: silent })
  await again2.load()
  assert.deepEqual(again2.view('player2', latest, {}), view2, 'a read baseline survives a reload')
  assert.equal(again2.view('player1', latest, {}).game.kind, 'game')
  const doc = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(doc.schema_version, 2)
  for (const d of doc.users.player1.done) assert.equal(d.start, undefined, 'a finished session keeps no breakdown')
  const farm = doc.users.player1.running.find(o => o.kind === 'farm')
  assert.equal(farm.start, null, 'starting: no baseline yet')
  assert.ok(Array.isArray(farm.press.i), 'the copy at the start is kept')
  assert.ok(Array.isArray(doc.users.player2.running[0].start.i))
  await cleanup()
})

test('done is capped at keep, the list is newest first and at most listMax', async () => {
  const { c, s, file, cleanup } = await sessions({ keep: 3 })
  const ids = []
  for (let i = 0; i < 5; i++) {
    const r = await s.start('player1', pt(c.now(), 1000, 200, {}))
    ids.push(r.session.id)
    c.advance(MIN)
    await s.end('player1')
    c.advance(MIN)
    await s.observe('player1', pt(c.now(), 1000, 200, {}), { roundSince: complete })
  }
  const doc = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(doc.users.player1.done.map(d => d.id), ids.slice(2))
  const v = s.view('player1', null, { listMax: 2 })
  assert.deepEqual(v.done.map(d => d.id), [ids[4], ids[3]])
  await cleanup()
})

test('an unusable sessions file is moved aside and sessions start empty', async () => {
  const { dir, file, cleanup } = await tmpFile()
  await writeFile(file, '{ this is broken', 'utf8')
  const { lines, log } = recorder()
  const s = createSessions(file, { log })
  await s.load()
  const v = s.view('player1', null, {})
  assert.equal(v.running, null)
  assert.deepEqual(v.done, [])
  const moved = (await readdir(dir)).filter(f => /^networth-sessions\.json\.broken-/.test(f))
  assert.equal(moved.length, 1)
  assert.equal(await readFile(join(dir, moved[0]), 'utf8'), '{ this is broken')
  assert.equal(s.writable, true)
  assert.equal(lines.length, 1)
  await cleanup()
})

test('users that is not an object is moved aside, not emptied and overwritten', async () => {
  const { dir, file, cleanup } = await tmpFile()
  await writeFile(file, JSON.stringify({ schema_version: 1, users: [] }), 'utf8')
  const { lines, log } = recorder()
  const s = createSessions(file, { log })
  await s.load()
  assert.equal((await readdir(dir)).filter(f => /\.broken-/.test(f)).length, 1)
  assert.match(lines[0], /users is missing or not an object/)
  await cleanup()
})

test('a sessions file from a newer release is left alone and nothing is written', async () => {
  const { dir, file, cleanup } = await tmpFile()
  const original = JSON.stringify({ schema_version: 3, users: { player1: { running: [], pending: [], done: [] } } })
  await writeFile(file, original, 'utf8')
  const c = clock()
  const { lines, log } = recorder()
  const s = createSessions(file, { log, now: c.now })
  await s.load()
  assert.equal(s.writable, false)
  const r = await s.start('player1', pt(c.now(), 100, 200, {}))
  assert.equal(r.ok, true, 'sessions still work, in memory')
  await s.end('player1')
  assert.equal(await readFile(file, 'utf8'), original)
  assert.equal((await readdir(dir)).filter(f => /\.broken-/.test(f)).length, 0)
  assert.equal(lines.length, 1)
  await cleanup()
})

test('the load never makes a store writable that the server marked read-only', async () => {
  const { file, cleanup } = await tmpFile()
  const s = createSessions(file, { log: silent })
  s.writable = false
  await s.load()
  assert.equal(s.writable, false)
  await cleanup()
})

test('an unreadable entry is dropped with one line per user, the rest is kept', async () => {
  const { file, cleanup } = await tmpFile()
  const good = { id: 's-1', state: 'final', startedAt: 1, endedAt: 2, closedAt: 3, balance: { loot: 1, lootDiv: null } }
  await writeFile(file, JSON.stringify({
    schema_version: 1,
    users: { player1: { running: { id: 's-9' }, pending: ['junk'], done: [good, null] } }
  }), 'utf8')
  const { lines, log } = recorder()
  const s = createSessions(file, { log })
  await s.load()
  const v = s.view('player1', null, {})
  assert.equal(v.running, null)
  assert.deepEqual(v.pending, [])
  assert.deepEqual(v.done.map(d => d.id), ['s-1'])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /dropped 3 unreadable session entries for player1/)
  await cleanup()
})

test('a schema-1 file is read as farm sessions started from the copy at the press', async () => {
  const { file, cleanup } = await tmpFile()
  const c = clock()
  const H = 3_600_000
  const t0 = c.now() - 2 * H
  await writeFile(file, JSON.stringify({
    schema_version: 1,
    users: {
      player1: {
        running: { id: 's-3', startedAt: t0 + H, stashChanged: false, start: { at: t0 + H, c: 1000, cd: 200, i: [['A', 1, 100]] } },
        pending: [{ id: 's-2', startedAt: t0, endedAt: t0 + 30 * MIN, stashChanged: true, start: { at: t0, c: 900, cd: 200, i: [] } }],
        done: [{ id: 's-1', state: 'final', startedAt: 1, endedAt: 2, closedAt: 3, balance: { loot: 1, lootDiv: null, stashChanged: false } }]
      }
    }
  }), 'utf8')
  const { lines, log } = recorder()
  const s = createSessions(file, { log, now: c.now })
  await s.load()
  assert.equal(s.writable, true)
  const latest = pt(c.now(), 1300, 200, { A: [4, 400] })
  const v = s.view('player1', latest, {})
  assert.equal(v.running.kind, 'farm')
  assert.equal(v.running.state, 'running')
  assert.equal(v.running.baseline, 'at-press')
  assert.equal(v.running.parent, null)
  assert.equal(v.running.balance.loot, 300)
  assert.equal(v.game, null)
  assert.equal(v.pending[0].id, 's-2')
  assert.equal(v.pending[0].stashChanged, true)
  assert.equal(v.done[0].kind, 'farm')
  assert.equal(v.done[0].baseline, 'at-press')
  assert.ok(lines.every(l => !/dropped/.test(l)), 'nothing dropped')
  // The next save writes the new form.
  await s.start('player1', null, { kind: 'game' })
  const doc = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(doc.schema_version, 2)
  assert.deepEqual(doc.users.player1.running.map(o => o.kind).sort(), ['farm', 'game'])
  await cleanup()
})

test('a second running session of one kind in the file is dropped, not merged', async () => {
  const { file, cleanup } = await tmpFile()
  const o = id => ({ id, kind: 'farm', parent: null, startedAt: 1, stashChanged: false, baseline: null, start: null, press: null })
  await writeFile(file, JSON.stringify({ schema_version: 2, users: { player1: { running: [o('s-1'), o('s-2')], pending: [], done: [] } } }), 'utf8')
  const { lines, log } = recorder()
  const s = createSessions(file, { log })
  await s.load()
  assert.equal(s.view('player1', null, {}).running.id, 's-1')
  assert.match(lines[0], /dropped 1 unreadable session entry for player1/)
  await cleanup()
})

test('a failed save is reported once and the sessions stay in memory', async () => {
  const { dir, cleanup } = await tmpFile()
  const c = clock()
  const { lines, log } = recorder()
  // A path inside a directory that does not exist: every write fails.
  const s = createSessions(join(dir, 'missing', 'networth-sessions.json'), { log, now: c.now })
  await s.load()
  await s.start('player1', pt(c.now(), 100, 200, {}))
  await s.end('player1')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /could not save .* kept in memory/)
  assert.equal(s.view('player1', null, {}).pending.length, 1)
  await cleanup()
})
