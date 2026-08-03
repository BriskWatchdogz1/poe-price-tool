// Outlier brake for the recorded history (gitignored, local).
// Pinned to the live case from 02.08.: "The Scavenger", 1 in stock at 1c each,
// jumped to 174039c each (= 1000 div) and fell back 40 minutes later. Total
// holdings were 14509.8c -> the jump was twelve times the entire net worth.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPriceGuard, GUARD_FACTOR, findSpikeRanges, stockMove } from './price-guard.mjs'

const SILENT = () => {}
const TOTAL = 14509.8
// Holdings as they were live: the card plus a remainder, together the total.
const prev = () => new Map([['The Scavenger', [1, 1]], ['Rest', [1, 14508.8]]])
const spike = () => new Map([['The Scavenger', [1, 174039]], ['Rest', [1, 14508.8]]])

test('the live case is caught and rolled back to the old price', () => {
  const g = createPriceGuard({ log: SILENT })
  const r = g.apply('player1', prev(), spike(), TOTAL)
  assert.equal(r.items.get('The Scavenger')[1], 1)      // 1 unit at the old price
  assert.equal(r.adjust, -174038)                        // data point total corrected
  assert.equal(r.notes.length, 1)
  assert.equal(r.notes[0].name, 'The Scavenger')
  assert.equal(r.notes[0].oldPrice, 1)
  assert.equal(r.notes[0].newPrice, 174039)
  assert.equal(r.items.get('Rest')[1], 14508.8)          // everything else untouched
})

test('the log line names the item plus the old and the new price', () => {
  const lines = []
  const g = createPriceGuard({ log: (...a) => lines.push(a) })
  g.apply('player1', prev(), spike(), TOTAL)
  assert.equal(lines.length, 1)
  const [fmt, ...args] = lines[0]
  assert.match(fmt, /implausible price jump/)
  assert.ok(args.includes('The Scavenger'), 'name missing from the log line')
  assert.ok(args.includes(174039), 'new price missing from the log line')
})

test('the held price stays the reference: a spike never becomes its own yardstick', () => {
  const g = createPriceGuard({ log: SILENT })
  g.apply('player1', prev(), spike(), TOTAL)
  // Second data point: the spike still stands, and prevMap is now the CORRECTED map.
  const r = g.apply('player1', prev(), spike(), TOTAL)
  assert.equal(r.items.get('The Scavenger')[1], 1, 'the second point must be caught as well')
})

test('once the price falls back the brake releases and holds nothing any more', () => {
  const g = createPriceGuard({ log: SILENT })
  g.apply('player1', prev(), spike(), TOTAL)
  assert.equal(g.held.size, 1)
  const back = g.apply('player1', prev(), prev(), TOTAL)
  assert.equal(back.adjust, 0)
  assert.equal(g.held.size, 0)
})

test('a high price that holds long enough is accepted', () => {
  let t = 1_000_000
  const lines = []
  const g = createPriceGuard({ now: () => t, maxHoldMs: 6 * 3600e3, log: (...a) => lines.push(a) })
  g.apply('player1', prev(), spike(), TOTAL)
  t += 6 * 3600e3
  const r = g.apply('player1', prev(), spike(), TOTAL)
  assert.equal(r.adjust, 0, 'past the hold window the new price stands')
  assert.equal(g.held.size, 0)
  assert.match(lines.at(-1)[0], /price hold released/)
})

test('ordinary market movement is left alone', () => {
  const g = createPriceGuard({ log: SILENT })
  // +50% on an item worth a third of the holdings: real movement, not a bug.
  const p = new Map([['Divine Orb', [30, 5000]]])
  const c = new Map([['Divine Orb', [30, 7500]]])
  assert.equal(g.apply('player1', p, c, TOTAL).adjust, 0)
})

test('a huge factor on a penny item is not enough: the share of net worth counts too', () => {
  const g = createPriceGuard({ log: SILENT })
  const p = new Map([['Scroll of Wisdom', [10, 1]]])
  const c = new Map([['Scroll of Wisdom', [10, 1 * GUARD_FACTOR * 10]]]) // x100
  assert.equal(g.apply('player1', p, c, TOTAL).adjust, 0, '100c against 14509c of holdings is noise')
})

test('more stock at the same unit price is not a price jump', () => {
  const g = createPriceGuard({ log: SILENT })
  const p = new Map([['Chaos Orb', [100, 100]]])
  const c = new Map([['Chaos Orb', [100000, 100000]]]) // bought, not repriced
  assert.equal(g.apply('player1', p, c, TOTAL).adjust, 0)
})

test('new items and missing previous values are never braked', () => {
  const g = createPriceGuard({ log: SILENT })
  const c = new Map([['Mageblood', [1, 192608]]])
  assert.equal(g.apply('player1', new Map(), c, TOTAL).adjust, 0)
  assert.equal(g.apply('player1', prev(), spike(), 0).adjust, 0, 'no previous total, no yardstick')
  assert.equal(g.apply('player1', null, c, TOTAL).adjust, 0)
})

// --- after-the-fact cleanup of spikes already recorded ----------------------
// Live picture: the 24h chart scaled its axis up to 1156d because a ~1084d peak
// sits in it for 47 minutes — which flattens the real curve (83..85d) into a
// line along the bottom edge.
const P = (at, c, d = null) => ({ u: 'player1', at, c, cd: 173, t: {}, ...(d ? { d } : {}) })
const M = 60_000
// Delta with pure PRICE movement (dq = 0) — the shape of the Scavenger jump.
const priceOnly = chaos => ({ p: 0, pt: 0, pc: 173, i: [['The Scavenger', 0, chaos, chaos]] })
// Delta with a real inflow: the quantity carries the value.
const stockIn = (name, qty, chaos) => ({ p: 0, pt: 0, pc: 173, i: [[name, qty, chaos, 0]] })

test('the live peak is recognised as an artefact', () => {
  const pts = [
    P(0, 14500), P(M, 14510),
    P(2 * M, 188000, priceOnly(174039)), P(3 * M, 188100), P(4 * M, 188050),
    P(5 * M, 14520), P(6 * M, 14515)
  ]
  const r = findSpikeRanges(pts)
  assert.equal(r.length, 1)
  assert.deepEqual([r[0].from, r[0].to], [2, 4])
  assert.equal(r[0].base, 14510)
  assert.equal(r[0].peak, 188100)
})

test('a peak that STAYS up is real net worth and is kept', () => {
  const pts = [P(0, 1000), P(M, 1010), P(2 * M, 9000), P(3 * M, 9100), P(4 * M, 9050)]
  assert.deepEqual(findSpikeRanges(pts), [])
})

test('a peak WITH stock movement is kept: the items really were there', () => {
  const pts = [
    P(0, 1000), P(M, 1000),
    P(2 * M, 9000, stockIn('Mageblood', 1, 8000)), P(3 * M, 9000),
    P(4 * M, 1000, stockIn('Mageblood', -1, -8000)), P(5 * M, 1000)
  ]
  assert.deepEqual(findSpikeRanges(pts), [], 'in and back out again is a real transaction')
})

test('a spike that is still running is not touched', () => {
  // No data point after it: it may well be real and still climbing.
  const pts = [P(0, 1000), P(M, 1000), P(2 * M, 90000, priceOnly(89000))]
  assert.deepEqual(findSpikeRanges(pts), [])
})

test('a high phase that lasts too long does not count as an outlier', () => {
  const long = 7 * 3600e3
  const pts = [P(0, 1000), P(M, 1000), P(2 * M, 90000, priceOnly(89000)), P(2 * M + long, 90000), P(2 * M + long + M, 1000)]
  assert.deepEqual(findSpikeRanges(pts), [], 'seven hours is no longer a twitch')
})

test('ordinary fluctuation is left untouched', () => {
  const pts = [P(0, 14500), P(M, 14800), P(2 * M, 14300), P(3 * M, 15000), P(4 * M, 14600)]
  assert.deepEqual(findSpikeRanges(pts), [])
})

test('stockMove counts only the quantity share', () => {
  assert.equal(stockMove(P(0, 0, priceOnly(174039))), 0, 'pure price movement moves no stock')
  assert.equal(stockMove(P(0, 0, stockIn('X', 2, 500))), 500)
  assert.equal(stockMove(P(0, 0)), 0)
  assert.equal(stockMove(null), 0)
})
