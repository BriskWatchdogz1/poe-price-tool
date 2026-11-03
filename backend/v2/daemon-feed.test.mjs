// daemon-feed.mjs — the way back from the server to the hotkey daemon
// (GET /daemon/events). Pure bookkeeping on an injected clock: what goes in
// (only cards a daemon posted itself), what comes out (seq, boot, reset, gap),
// how long a request is held, and that a throw inside it stops nothing.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createDaemonFeed, itemStateFrom, guarded, FEED_VERSION } from './daemon-feed.mjs'

function feed (opts = {}) {
  let t = 1_000_000
  const clock = { now: () => t, add: ms => { t += ms } }
  const f = createDaemonFeed({ users: ['a', 'b'], keep: 100, waitersMax: 4, maxAgeMs: 120_000, now: clock.now, bootId: 'b1', ...opts })
  return { f, clock }
}
const added = (id, extra = {}) => ({ type: 'item-added', id, name: 'Mageblood', baseType: 'Heavy Belt', rarity: 'unique', priceStatus: 'queued', ...extra })
const result = (id, extra = {}) => ({ type: 'price-result', id, currency: 'chaos', priceLow: 22, priceHigh: 45, priceMedian: 30, count: 14, ...extra })

test('a daemon asking for the first time is told to reset and gets nothing old', () => {
  const { f } = feed()
  f.track('a', 'x', { by: 'i1' })
  f.noteBroadcast('a', added('x'))
  f.noteBroadcast('a', { type: 'ninja-ref', id: 'x', chaos: 85 })
  f.noteBroadcast('a', result('x'))
  const first = f.read('a', {})
  assert.equal(first.reset, true)
  assert.deepEqual(first.events, [])
  assert.equal(first.seq, 3)
  assert.equal(first.v, FEED_VERSION)
  assert.equal(first.boot, 'b1')
  const next = f.read('a', { since: 3, boot: 'b1' })
  assert.equal(next.reset, false)
  assert.deepEqual(next.events, [])
})

test('events after since arrive in order, a since older than the buffer says gap, a different boot is a reset', () => {
  const { f } = feed({ keep: 5 })
  f.track('a', 'x', { by: 'i1' })
  for (let i = 0; i < 8; i++) f.noteBroadcast('a', { type: 'ninja-ref', id: 'x', chaos: i })
  const old = f.read('a', { since: 1, boot: 'b1' })
  assert.equal(old.gap, true)
  assert.deepEqual(old.events.map(e => e.seq), [4, 5, 6, 7, 8])
  const recent = f.read('a', { since: 6, boot: 'b1' })
  assert.equal(recent.gap, false)
  assert.deepEqual(recent.events.map(e => e.seq), [7, 8])
  const other = f.read('a', { since: 6, boot: 'old' })
  assert.equal(other.reset, true)
  assert.deepEqual(other.events, [])
  assert.equal(f.read('a', { since: 9, boot: 'b1' }).reset, true, 'a since past seq')
  assert.equal(f.read('a', { since: -1, boot: 'b1' }).reset, true)
  assert.equal(f.read('a', { since: 1.5, boot: 'b1' }).reset, true)
})

test('only tracked cards reach the feed, and a later search in the browser does not', () => {
  const { f, clock } = feed()
  f.noteBroadcast('a', result('u'))
  assert.equal(f.read('a', {}).seq, 0, 'an untracked card is not an event')

  f.track('a', 'x', { by: 'i1' })
  assert.equal(f.read('a', {}).seq, 0, 'track() alone is not an event')
  f.noteBroadcast('a', added('x'))
  f.noteBroadcast('a', result('x'))
  let r = f.read('a', { since: 0, boot: 'b1' })
  assert.equal(r.events.length, 2)
  assert.deepEqual(r.events.map(e => e.by), ['i1', 'i1'])
  assert.equal(r.events[1].final, true)

  clock.add(10_000)
  f.noteBroadcast('a', added('x', { priceStatus: 'searching' }))
  f.noteBroadcast('a', result('x', { priceMedian: 99 }))
  assert.equal(f.read('a', {}).seq, 2, 'a search on the page after the final state does not reach the game')

  f.noteBroadcast('a', { type: 'ninja-ref', id: 'x', chaos: 85, divine: 0.4 })
  r = f.read('a', { since: 2, boot: 'b1' })
  assert.equal(r.events.length, 1, 'the reference still does')
  assert.deepEqual(r.events[0].ref, { chaos: 85, divine: 0.4 })
  assert.equal(r.events[0].price.median, 30, 'the price stays the first final one')

  f.track('a', 'x', { by: 'i2' }) // the daemon posted it again (dedupe branch)
  f.noteBroadcast('a', added('x', { priceStatus: 'searching' }))
  f.noteBroadcast('a', result('x', { priceMedian: 31 }))
  r = f.read('a', { since: 3, boot: 'b1' })
  assert.equal(r.events.length, 2)
  assert.deepEqual(r.events.map(e => e.by), ['i2', 'i2'])
  assert.equal(r.events[1].price.median, 31)

  clock.add(120_001)
  f.noteBroadcast('a', result('x'))
  assert.equal(f.read('a', {}).seq, 5, 'past maxAgeMs after the final state the card is no longer followed')

  f.track('a', 'y', { by: 'i1' })
  f.noteBroadcast('a', { type: 'queue-status', depth: 2 })
  f.noteBroadcast('a', { type: 'networth-result', total: 5 })
  assert.equal(f.read('a', {}).seq, 5, 'messages without a card id are not events')

  f.track('b', 'z', { by: 'i9' })
  f.noteBroadcast('b', added('z'))
  assert.equal(f.read('a', {}).seq, 5, "user b's broadcast never lands in a's feed")
  assert.equal(f.read('b', {}).seq, 1)
})

// The dedupe branch of POST /item: track(…, { reassert: true }), then the
// card's item-added with its current status, then its last price-result.
const reassert = (f, id, status, price, by = 'i1') => {
  f.track('a', id, { by, reassert: true })
  f.noteBroadcast('a', added(id, { priceStatus: status }))
  if (price) f.noteBroadcast('a', price)
}
const lastItem = (f, id) => f.read('a', { since: 0, boot: 'b1' }).events.filter(e => e.kind === 'item' && e.id === id).at(-1)

test('a re-post brings the price the page shows, not the first final one', () => {
  const { f } = feed()
  f.track('a', 'x', { by: 'i1' })
  f.noteBroadcast('a', added('x'))
  f.noteBroadcast('a', result('x', { priceMedian: 100 }))
  f.noteBroadcast('a', result('x', { priceMedian: 150 })) // a search on the page: not for the game
  assert.equal(lastItem(f, 'x').price.median, 100)

  reassert(f, 'x', 'done', result('x', { priceMedian: 150 }))
  const last = lastItem(f, 'x')
  assert.equal(last.price.median, 150, "the page's last price reaches the game")
  assert.equal(last.status, 'done')
  assert.equal(last.final, true)
  const seq = f.read('a', {}).seq
  f.noteBroadcast('a', result('x', { priceMedian: 170 }))
  assert.equal(f.read('a', {}).seq, seq, 'only the message right after the item-added is the replay')
})

test('a card first posted without the daemon header gets its price on the re-post', () => {
  const { f } = feed()
  f.noteBroadcast('a', added('y'))
  f.noteBroadcast('a', result('y', { priceMedian: 12 }))
  reassert(f, 'y', 'done', result('y', { priceMedian: 12 }))
  const last = lastItem(f, 'y')
  assert.equal(last.final, true)
  assert.equal(last.price.median, 12, 'not done with price null')
})

test('a reopened card that waits again keeps its status and stays followed', () => {
  const { f, clock } = feed()
  f.track('a', 'x', { by: 'i1' })
  f.noteBroadcast('a', added('x'))
  f.noteBroadcast('a', result('x', { priceMedian: 100 }))
  // The page re-queued it (not for the game), then the daemon posted it again.
  reassert(f, 'x', 'queued', result('x', { priceMedian: 100 }))
  let last = lastItem(f, 'x')
  assert.equal(last.status, 'queued', 'the replayed price does not make a waiting card final')
  assert.equal(last.final, false)
  assert.equal(last.price.median, 100)
  clock.add(121_000) // longer than maxAgeMs in the queue
  f.noteBroadcast('a', result('x', { priceMedian: 140 }))
  last = lastItem(f, 'x')
  assert.equal(last.price.median, 140, "the job's result still reaches the game")
  assert.equal(last.final, true)
  assert.equal(f.stats().a.tracked, 1)
})

test('the replayed item-added of a re-post is marked, so it answers that POST', () => {
  const { f } = feed()
  f.track('a', 'x', { by: 'i1' })
  f.noteBroadcast('a', added('x'))
  f.noteBroadcast('a', result('x', { priceMedian: 100 }))
  reassert(f, 'x', 'done', result('x', { priceMedian: 100 }))
  const items = f.read('a', { since: 0, boot: 'b1' }).events.filter(e => e.kind === 'item')
  assert.deepEqual(items.map(e => e.reassert ?? null), [null, null, true, null],
    'only the replayed item-added: not the first card, not the replayed price')
})

test('without reassert the first price-result after the item-added is a real result', () => {
  const { f } = feed()
  f.track('a', 'x', { by: 'i1' })
  f.noteBroadcast('a', added('x'))
  f.noteBroadcast('a', result('x'))
  assert.equal(lastItem(f, 'x').status, 'done')
  assert.equal(lastItem(f, 'x').final, true)
})

test('a removed card is one event and then gone', () => {
  const { f } = feed()
  f.track('a', 'x', { by: 'i1' })
  f.noteBroadcast('a', { type: 'item-removed', id: 'x' })
  const r = f.read('a', { since: 0, boot: 'b1' })
  assert.deepEqual(r.events.map(e => [e.kind, e.id, e.by]), [['item-removed', 'x', 'i1']])
  f.noteBroadcast('a', added('x'))
  assert.equal(f.read('a', {}).seq, 1)
})

test('itemStateFrom: queued, searching and done for a trade search, exchange and ninja name their source', () => {
  const q = itemStateFrom(null, added('x'), { ahead: 2 })
  assert.equal(q.status, 'queued')
  assert.equal(q.ahead, 2)
  assert.equal(q.final, false)
  assert.equal(q.name, 'Mageblood')
  assert.equal(q.base, 'Heavy Belt')
  assert.equal(q.rarity, 'unique')
  const s = itemStateFrom(q, added('x', { priceStatus: 'searching' }), { ahead: 2 })
  assert.equal(s.status, 'searching')
  assert.equal(s.ahead, null, 'only a queued card has a position')

  const done = itemStateFrom(s, result('x'))
  assert.deepEqual(done.price, { source: 'trade', currency: 'chaos', median: 30, low: 22, high: 45, count: 14, ageHours: null, conflict: false, early: false })
  assert.equal(done.final, true)
  assert.equal(done.status, 'done')

  const ex = itemStateFrom(s, result('x', { priceSource: 'exchange', priceMedian: 212, priceLow: 212, priceHigh: 212, exchangeRange: { low: 205, high: 220 }, exchangeAgeHours: 6 }))
  assert.equal(ex.price.source, 'exchange')
  assert.equal(ex.price.low, 205)
  assert.equal(ex.price.high, 220)
  assert.equal(ex.price.ageHours, 6)
  assert.equal(itemStateFrom(s, result('x', { askConflict: { dir: 'over', factor: 5 } })).price.conflict, true)

  const nj = itemStateFrom(s, { type: 'price-result', id: 'x', display: 'ninja', priceSource: 'ninja', currency: 'chaos', priceLow: 7, priceHigh: 7, count: 40 })
  assert.equal(nj.price.source, 'ninja')
  assert.equal(nj.price.median, 7, 'a ninja result has no median: the low stands in')

  const ref = itemStateFrom(q, { type: 'ninja-ref', id: 'x', chaos: 85 })
  assert.equal(ref.status, 'queued', 'a reference keeps the status')
  assert.deepEqual(ref.ref, { chaos: 85, divine: null })
  assert.equal(itemStateFrom(q, { type: 'queue-status' }), null)
  const rl = itemStateFrom(q, added('x', { priceStatus: 'rate-limited', retryAfterSec: 10800 }))
  assert.equal(rl.retryAfterSec, 10800)
  assert.equal(itemStateFrom(q, added('x', { priceStatus: 'error' })).final, true)
})

test('an early exchange hint is marked and replaced by the job\'s result', () => {
  const { f } = feed()
  f.track('a', 'x', { by: 'i1', stack: 7 })
  f.hint('a', 'x', { source: 'exchange', currency: 'chaos', median: 212, low: 205, high: 220, count: null, ageHours: null, conflict: false })
  let ev = f.read('a', { since: 0, boot: 'b1' }).events
  assert.equal(ev.length, 1)
  assert.equal(ev[0].price.early, true)
  assert.equal(ev[0].final, false)
  assert.equal(ev[0].stack, 7)
  f.noteBroadcast('a', result('x', { priceSource: 'exchange', priceMedian: 213 }))
  ev = f.read('a', { since: 1, boot: 'b1' }).events
  assert.equal(ev[0].price.early, false)
  assert.equal(ev[0].price.median, 213)
  assert.equal(ev[0].final, true)
  assert.equal(ev[0].stack, 7, 'the stack size rides along')
  f.hint('a', 'x', { source: 'exchange', median: 1 })
  assert.equal(f.read('a', {}).seq, 2, 'no hint after the final state')
  f.hint('a', 'nope', { source: 'exchange', median: 1 })
  assert.equal(f.read('a', {}).seq, 2, 'no hint for an untracked card')
})

test('the queue position is set once the job is queued and follows the queue', () => {
  let pos = null
  const { f } = feed({ positionOf: () => pos })
  f.track('a', 'x', { by: 'i1' })
  f.noteBroadcast('a', added('x'))
  let ev = f.read('a', { since: 0, boot: 'b1' }).events
  assert.equal(ev[0].ahead, null, 'not in the queue yet')
  pos = 2
  f.refresh('a', 'x')
  ev = f.read('a', { since: 1, boot: 'b1' }).events
  assert.equal(ev.length, 1)
  assert.equal(ev[0].ahead, 2)
  f.refreshQueued()
  assert.equal(f.read('a', {}).seq, 2, 'an unchanged position is not an event')
  pos = 1
  f.refreshQueued()
  ev = f.read('a', { since: 2, boot: 'b1' }).events
  assert.equal(ev.length, 1)
  assert.equal(ev[0].ahead, 1)
  f.noteBroadcast('a', added('x', { priceStatus: 'searching' }))
  pos = 0
  f.refresh('a', 'x'); f.refreshQueued()
  assert.equal(f.read('a', {}).seq, 4, 'a searching card has no position to follow')
  f.noteBroadcast('a', result('x'))
  f.refresh('a', 'x'); f.refreshQueued()
  assert.equal(f.read('a', {}).seq, 5, 'nor has a final one')
})

test('the Chaos:Divine rate of the card\'s league rides along', () => {
  const { f } = feed({ cdFor: league => (league === 'L' ? 150 : null) })
  f.track('a', 'x', { by: 'i1', league: 'L' })
  f.noteBroadcast('a', added('x'))
  assert.equal(f.read('a', { since: 0, boot: 'b1' }).events[0].cd, 150)
})

test('a held request answers at the first event and at holdMs with nothing, never twice', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { f } = feed()
    f.track('a', 'x', { by: 'i1' })
    const got = []
    f.wait('a', { since: 0, boot: 'b1', instance: 'i1', holdMs: 25_000, onAnswer: o => got.push(o) })
    assert.equal(f.waitersOf('a'), 1)
    f.noteBroadcast('a', added('x'))
    assert.equal(got.length, 1)
    assert.equal(got[0].events.length, 1)
    mock.timers.tick(30_000)
    assert.equal(got.length, 1, 'answered once')
    assert.equal(f.waitersOf('a'), 0)

    const later = []
    f.wait('a', { since: 1, boot: 'b1', instance: 'i1', holdMs: 25_000, onAnswer: o => later.push(o) })
    mock.timers.tick(24_999)
    assert.equal(later.length, 0)
    mock.timers.tick(1)
    assert.equal(later.length, 1)
    assert.deepEqual(later[0].events, [])
  } finally {
    mock.timers.reset()
  }
})

test('waiters are bounded per user and one per instance', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { f } = feed({ waitersMax: 2 })
    const answers = { a1: [], a2: [], b: [], c: [] }
    const w = (inst, key) => f.wait('a', { since: 0, boot: 'b1', instance: inst, holdMs: 25_000, onAnswer: o => answers[key].push(o) })
    assert.ok(w('a', 'a1'))
    const cancelB = w('b', 'b')
    assert.ok(cancelB)
    assert.equal(w('c', 'c'), null, 'a third waiter of this user is refused')
    assert.ok(w('a', 'a2'), 'the same instance again replaces its own waiter')
    assert.equal(answers.a1.length, 1, 'the older request was answered at once')
    assert.deepEqual(answers.a1[0].events, [])
    assert.equal(f.waitersOf('a'), 2)
    cancelB()
    assert.equal(f.waitersOf('a'), 1)
    mock.timers.tick(30_000)
    assert.equal(answers.b.length, 0, 'a cancelled waiter is never answered')
    assert.equal(answers.a2.length, 1)
  } finally {
    mock.timers.reset()
  }
})

test('whisper verdicts are events of their own', () => {
  const { f } = feed()
  f.pushWhisper('a', { wid: 'w1', verdict: 'fair' }, { by: 'i1' })
  const ev = f.read('a', { since: 0, boot: 'b1' }).events
  assert.deepEqual(ev.map(e => [e.kind, e.wid, e.by, e.entry.verdict]), [['whisper', 'w1', 'i1', 'fair']])
})

test('session changes are events of their own, with the session as it is now', () => {
  const { f } = feed()
  const session = { id: 's-1', kind: 'farm', parent: null, state: 'starting', startedAt: 1, endedAt: null, baseline: null, about: 4, balance: null }
  f.pushSession('a', session, { by: 'i1' })
  f.pushSession('a', { ...session, state: 'running', baseline: 'read', about: null })
  const ev = f.read('a', { since: 0, boot: 'b1' }).events
  assert.deepEqual(ev.map(e => [e.kind, e.by, e.session.state]), [['session', 'i1', 'starting'], ['session', null, 'running']])
  assert.deepEqual(ev[0].session, session)
  assert.deepEqual(f.read('b', { since: 0, boot: 'b1' }).events, [], 'only into the user\'s own feed')
  assert.equal(f.pushSession('nobody', session), null)
})

test('stats count per user and nothing leaks between users', () => {
  const { f } = feed()
  f.track('a', 'x', { by: 'i1' })
  f.noteBroadcast('a', added('x'))
  assert.deepEqual(f.stats().a, { seq: 1, buffered: 1, tracked: 1, waiting: 0 })
  assert.deepEqual(f.stats().b, { seq: 0, buffered: 0, tracked: 0, waiting: 0 })
})

test('a throw inside the feed is logged once and stops nothing', () => {
  const lines = []
  const warn = l => lines.push(l)
  let msg = 'boom'
  const g = guarded(() => { throw new Error(msg) }, warn)
  assert.doesNotThrow(() => g('a', {}))
  assert.doesNotThrow(() => g('a', {}))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /\[daemon-feed\] boom/)
  assert.match(lines[0], /the browser still gets every message/)
  msg = 'other'
  g('a', {})
  assert.equal(lines.length, 2, 'a second message text is a second line')
  assert.equal(guarded((x, y) => x + y, warn)(2, 3), 5, 'a normal call passes its value through')
})
