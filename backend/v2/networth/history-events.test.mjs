// Events for the history page (gitignored, local).
// The rule nailed down here: what counts is what came IN or went OUT.
// Pure price movements are not events — they were the noise that made the old
// detail list useless.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNetworthHistory, EVENT_MIN_CHAOS } from './history.mjs'

// History without file IO: writable=false makes append() return right after the
// in-memory part. The clock moves on by a minute per point, otherwise
// minIntervalMs kicks in and the second point never comes into existence.
function makeHist (start = 1_700_000_000_000) {
  let clock = start
  const h = createNetworthHistory('/nonexistent/history.ndjson', { now: () => clock, minIntervalMs: 0 })
  h.writable = false
  return {
    h,
    at: () => clock,
    async point (totalChaos, items) {
      clock += 60_000
      await h.append('player1', { totalChaos, cdRatio: 173, items })
    },
    // Fast-forward time to put points into different buckets.
    jump (ms) { clock += ms }
  }
}

test('only quantity changes turn into events', async () => {
  const { h, at, point } = makeHist()
  await point(1000, [{ name: 'Divine Orb', qty: 5, chaosTotal: 865 }])
  // A card comes in (quantity), the Divine gets more expensive (price only).
  await point(1400, [
    { name: 'Divine Orb', qty: 5, chaosTotal: 900 },
    { name: 'The Doctor', qty: 1, chaosTotal: 500 }
  ])
  const r = h.events('player1', 24 * 3600e3, { at: at() })
  assert.equal(r.events.length, 1)
  assert.deepEqual(r.events[0].items.map(x => x[0]), ['The Doctor'],
    'the pure price move of the Divine must not become an event')
  assert.equal(r.events[0].items[0][1], 1, 'quantity +1')
})

test('the event value is the quantity share, not the whole value change', async () => {
  const { h, at, point } = makeHist()
  await point(200, [{ name: 'Card', qty: 2, chaosTotal: 200 }])
  // Quantity 2 -> 3 AND unit price 100 -> 150: value +250, of which quantity
  // carries 150 (one card at the new price) and price carries 100 (the two old
  // units).
  await point(450, [{ name: 'Card', qty: 3, chaosTotal: 450 }])
  // minDivine 0: this is about the CALCULATION, not about the threshold.
  const e = h.events('player1', 24 * 3600e3, { at: at(), minDivine: 0 }).events[0]
  assert.equal(e.items[0][1], 1, 'quantity +1')
  assert.equal(e.items[0][2], 150, 'valued at the unit price, not at the whole value change')
  assert.equal(e.v, 150)
})

test('small change below the threshold drops out', async () => {
  const { h, at, point } = makeHist()
  await point(1000, [{ name: 'Orb of Alchemy', qty: 10, chaosTotal: 20 }])
  await point(1006, [{ name: 'Orb of Alchemy', qty: 13, chaosTotal: 26 }])
  assert.equal(h.events('player1', 24 * 3600e3, { at: at() }).events.length, 0,
    `+6c is below ${EVENT_MIN_CHAOS}c`)
  assert.equal(h.events('player1', 24 * 3600e3, { at: at(), minChaos: 1 }).events.length, 1,
    'with a lower threshold it shows up')
})

test('events carry time, the running total and their own sum', async () => {
  const { h, at, point } = makeHist()
  await point(100, [{ name: 'X', qty: 1, chaosTotal: 100 }])
  await point(700, [{ name: 'X', qty: 1, chaosTotal: 100 }, { name: 'Mageblood', qty: 1, chaosTotal: 600 }])
  const e = h.events('player1', 24 * 3600e3, { at: at() }).events[0]
  assert.equal(e.at, at())
  assert.equal(e.c, 700, 'running total AFTER the event')
  assert.equal(e.v, 600, 'sum of the event')
})

test('an outflow is booked negative and sorted by magnitude', async () => {
  const { h, at, point } = makeHist()
  await point(1000, [{ name: 'Small', qty: 5, chaosTotal: 50 }, { name: 'Big', qty: 2, chaosTotal: 950 }])
  await point(20, [{ name: 'Small', qty: 2, chaosTotal: 20 }])
  const e = h.events('player1', 24 * 3600e3, { at: at(), minDivine: 0 }).events[0]
  assert.equal(e.items[0][0], 'Big', 'the bigger line comes first')
  assert.ok(e.items[0][1] < 0 && e.items[0][2] < 0, 'an outflow is negative in quantity and value')
  assert.equal(e.items.length, 2)
})

test('nothing outside the window is reported', async () => {
  const { h, at, point } = makeHist()
  await point(100, [{ name: 'X', qty: 1, chaosTotal: 100 }])
  await point(700, [{ name: 'X', qty: 1, chaosTotal: 100 }, { name: 'Mageblood', qty: 1, chaosTotal: 600 }])
  assert.equal(h.events('player1', 30_000, { at: at() + 3600e3 }).events.length, 0)
  assert.equal(h.events('player2', 24 * 3600e3, { at: at() }).events.length, 0, 'a different user')
})

// --- Bucketing: one marker per time window, not per recorded point ----------
// Live finding: ~100 events over 24h whose points melted into a single chain on
// the curve — exactly the click-point density that had to go.
test('several points in the same window collapse into ONE event', async () => {
  const { h, at, point } = makeHist()
  await point(1000, [{ name: 'A', qty: 1, chaosTotal: 1000 }])
  await point(1500, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'B', qty: 1, chaosTotal: 500 }])
  await point(2000, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'B', qty: 1, chaosTotal: 500 },
    { name: 'C', qty: 1, chaosTotal: 500 }])
  const r = h.events('player1', 24 * 3600e3, { at: at() })
  assert.equal(r.events.length, 1, 'three points, one 30-minute window, one marker')
  assert.equal(r.events[0].points, 2, 'the very first point has no predecessor and therefore no delta')
  assert.deepEqual(r.events[0].items.map(x => x[0]).sort(), ['B', 'C'])
  assert.equal(r.events[0].v, 1000)
  assert.equal(r.bucketMs, 30 * 60e3, '24h -> 30-minute window')
})

test('in and back out within the same window cancels itself', async () => {
  const { h, at, point } = makeHist()
  await point(1000, [{ name: 'A', qty: 1, chaosTotal: 1000 }])
  await point(1500, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'Card', qty: 1, chaosTotal: 500 }])
  await point(1000, [{ name: 'A', qty: 1, chaosTotal: 1000 }])
  const r = h.events('player1', 24 * 3600e3, { at: at() })
  assert.equal(r.events.length, 0, 'two lines that cancel each other are not an event')
})

test('separate windows stay separate events', async () => {
  const { h, at, point, jump } = makeHist()
  await point(1000, [{ name: 'A', qty: 1, chaosTotal: 1000 }])
  await point(1500, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'B', qty: 1, chaosTotal: 500 }])
  jump(2 * 3600e3)
  await point(2000, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'B', qty: 1, chaosTotal: 500 },
    { name: 'C', qty: 1, chaosTotal: 500 }])
  const r = h.events('player1', 24 * 3600e3, { at: at() })
  assert.equal(r.events.length, 2)
  assert.ok(r.events[0].at < r.events[1].at, 'chronologically ascending')
})

test('the window size follows the range', async () => {
  const { h, at, point } = makeHist()
  await point(1000, [{ name: 'A', qty: 1, chaosTotal: 1000 }])
  await point(1500, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'B', qty: 1, chaosTotal: 500 }])
  assert.equal(h.events('player1', 3600e3, { at: at() }).bucketMs, 75_000, '1h -> a good minute')
  assert.equal(h.events('player1', 6 * 3600e3, { at: at() }).bucketMs, 450_000, '6h -> 7.5 minutes')
})

test('rawEvents still delivers the per-point resolution', async () => {
  const { h, at, point } = makeHist()
  await point(1000, [{ name: 'A', qty: 1, chaosTotal: 1000 }])
  await point(1500, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'B', qty: 1, chaosTotal: 500 }])
  await point(2000, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'B', qty: 1, chaosTotal: 500 },
    { name: 'C', qty: 1, chaosTotal: 500 }])
  assert.equal(h.rawEvents('player1', 24 * 3600e3, { at: at() }).events.length, 2)
})

// --- Configurable threshold (rail selection) --------------------------------
test('the threshold is given in Divine and converted with the window rate', async () => {
  const { h, at, point } = makeHist()
  await point(1000, [{ name: 'A', qty: 1, chaosTotal: 1000 }])
  // +346c = 2 div at cd 173.
  await point(1346, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'B', qty: 2, chaosTotal: 346 }])
  const w = 24 * 3600e3
  assert.equal(h.events('player1', w, { at: at(), minDivine: 1 }).events.length, 1, '2 div are above 1 div')
  assert.equal(h.events('player1', w, { at: at(), minDivine: 3 }).events.length, 0, 'and below 3 div')
  assert.equal(h.events('player1', w, { at: at(), minDivine: 0 }).events.length, 1, '0 = show everything')
})

test('with nothing specified one Divine applies', async () => {
  const { h, at, point } = makeHist()
  await point(1000, [{ name: 'A', qty: 1, chaosTotal: 1000 }])
  await point(1100, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'B', qty: 1, chaosTotal: 100 }])
  const r = h.events('player1', 24 * 3600e3, { at: at() })
  assert.equal(r.events.length, 0, '100c is less than one Divine (173c)')
  assert.equal(r.minChaos, 173, 'the applied threshold is handed back along with it')
})

test('marker density follows the range', async () => {
  const { h, at, point } = makeHist()
  await point(1000, [{ name: 'A', qty: 1, chaosTotal: 1000 }])
  await point(1500, [{ name: 'A', qty: 1, chaosTotal: 1000 }, { name: 'B', qty: 1, chaosTotal: 500 }])
  const b = r => h.events('player1', 3600e3, { at: at(), range: r }).bucketMs
  assert.equal(b('1h'), 5 * 60e3)
  assert.equal(b('6h'), 15 * 60e3)
  assert.equal(b('24h'), 60 * 60e3)
  assert.equal(b('7d'), 6 * 3600e3)
  assert.equal(b('14d'), 12 * 3600e3)
})
