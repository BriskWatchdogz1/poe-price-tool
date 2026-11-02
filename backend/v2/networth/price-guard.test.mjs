// Outlier brake for the recorded history (gitignored, local).
// Pinned to the live case from 02.08.: "The Scavenger", 1 in stock at 1c each,
// jumped to 174039c each (= 1000 div) and fell back 40 minutes later. Total
// holdings were 14509.8c -> the jump was twelve times the entire net worth.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPriceGuard, guardOptionsFromEnv, GUARD_FACTOR, GUARD_SHARE, GUARD_MAX_HOLD_MS,
  GUARD_ARRIVAL_MIN_DIVINE, findSpikeRanges, stockMove
} from './price-guard.mjs'

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

test('without a previous total or a previous map there is no yardstick at all', () => {
  const g = createPriceGuard({ log: SILENT })
  const c = new Map([['Mageblood', [1, 192608]]])
  assert.equal(g.apply('player1', prev(), spike(), 0).adjust, 0, 'no previous total, no yardstick')
  assert.equal(g.apply('player1', null, c, TOTAL).adjust, 0)
})

// --- items ENTERING the snapshot --------------------------------------------
// Live case (10.08., 24h window): "The Twilight Moon", a divination card that
// trades at about one chaos, arrived as a quantity change of +1 and was
// recorded at 55.2 divine — ~11,700c at that hour's 212 c/div — on a ~94 divine
// account. It had no entry in the previous map, so the jump bar above never
// looked at it.
const CD = 212
const BASELINE = 94 * CD                                   // ~19,928c, the ~94 div account
const before = () => new Map([['Rest', [1, BASELINE]]])
const withMoon = (chaos = 55.2 * CD) => new Map([['Rest', [1, BASELINE]], ['The Twilight Moon', [1, chaos]]])

test('the live arrival is caught: a card nobody has seen before is recorded at no value', () => {
  const g = createPriceGuard({ log: SILENT })
  const r = g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: CD })
  assert.deepEqual(r.items.get('The Twilight Moon'), [1, 0], 'the card entered the series at its full price')
  assert.equal(r.adjust, -11702.4)                          // 55.2 div at 212 c/div
  assert.equal(r.notes.length, 1)
  assert.equal(r.notes[0].withheld, true)
  assert.equal(r.notes[0].oldPrice, null)
  assert.equal(r.items.get('Rest')[1], BASELINE, 'everything else untouched')
})

test('a withheld arrival that is still there after the hold window is accepted', () => {
  let t = 1_000_000
  const lines = []
  const g = createPriceGuard({ now: () => t, maxHoldMs: 6 * 3600e3, log: (...a) => lines.push(a) })
  assert.notEqual(g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: CD }).adjust, 0)
  assert.match(lines[0][0], /withheld from the trend/)
  // Second point: prevMap now carries the card at the value it was RECORDED
  // with (0) — the hold, not that zero, has to keep the brake on.
  t += 60_000
  const held = g.apply('player1', withMoon(0), withMoon(), BASELINE, { cdRatio: CD })
  assert.deepEqual(held.items.get('The Twilight Moon'), [1, 0])
  assert.equal(lines.length, 1, 'the withheld line is not repeated once a minute')

  t += 6 * 3600e3
  const out = g.apply('player1', withMoon(0), withMoon(), BASELINE, { cdRatio: CD })
  assert.equal(out.adjust, 0, 'past the hold window the arrival stands')
  assert.match(lines.at(-1)[0], /withheld arrival accepted/)
})

test('an arrival that vanishes again costs the following points nothing', () => {
  const g = createPriceGuard({ log: SILENT })
  g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: CD })
  assert.equal(g.held.size, 1)
  // The card is gone from the snapshot: nothing to correct, nothing to record.
  const back = g.apply('player1', withMoon(0), before(), BASELINE, { cdRatio: CD })
  assert.equal(back.adjust, 0)
  assert.equal(back.notes.length, 0)
})

test('an arrival that falls back to a sane price stops being withheld', () => {
  const g = createPriceGuard({ log: SILENT })
  g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: CD })
  // Same card, now at 1c: below both bars, so the hold goes and the point is
  // recorded as it stands.
  const sane = g.apply('player1', withMoon(0), new Map([['Rest', [1, BASELINE]], ['The Twilight Moon', [1, 1]]]), BASELINE, { cdRatio: CD })
  assert.equal(sane.adjust, 0)
  assert.equal(g.held.size, 0)
})

test('an arrival below the divine floor is left alone, however large its share', () => {
  const g = createPriceGuard({ log: SILENT })
  // 7.8 divine on the same account: over a quarter of nothing much, but not the
  // order of magnitude this bar exists for. It was never shown to be wrong.
  const small = new Map([['Rest', [1, 2000]], ['The Demoness', [1, 7.8 * CD]]])
  assert.equal(g.apply('player1', new Map([['Rest', [1, 2000]]]), small, 2000, { cdRatio: CD }).adjust, 0)
})

test('without a C:D rate the arrival bar abstains rather than guess its floor', () => {
  const g = createPriceGuard({ log: SILENT })
  assert.equal(g.apply('player1', before(), withMoon(), BASELINE).adjust, 0)
  assert.equal(g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: 0 }).adjust, 0)
})

test('an item that LEFT the stash and comes back is judged against the remembered price', () => {
  let t = 1_000_000
  const g = createPriceGuard({ now: () => t, log: SILENT })
  const card = c => new Map([['Rest', [1, BASELINE]], ['The Twilight Moon', [1, c]]])
  // Point 1: the card is there at 1c and passes -> the guard remembers 1c.
  g.apply('player1', card(1), card(1), BASELINE, { cdRatio: CD })
  // Point 2: it is gone. prevMap loses it, so only the memory is left.
  t += 60_000
  g.apply('player1', card(1), before(), BASELINE, { cdRatio: CD })
  // Point 3: back at 11,700c. That is an arrival — but not an unknown one.
  t += 60_000
  const r = g.apply('player1', before(), card(55.2 * CD), BASELINE, { cdRatio: CD })
  assert.deepEqual(r.items.get('The Twilight Moon'), [1, 1], 'recorded at the price the guard knew')
  assert.equal(r.notes[0].oldPrice, 1)
  assert.equal(r.notes[0].withheld, undefined, 'a known price is held, not withheld')
})

test('the hold measures STANDING, not the wall clock', () => {
  let t = 1_000_000
  const g = createPriceGuard({ now: () => t, maxHoldMs: 6 * 3600e3, log: SILENT })
  assert.notEqual(g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: CD }).adjust, 0)
  // Gone from the very next snapshot: whatever the clock does afterwards, the
  // card did not stand through the window.
  t += 60_000
  g.apply('player1', withMoon(0), before(), BASELINE, { cdRatio: CD })
  assert.equal(g.held.size, 0, 'a hold outlives the item it is about')
  // Back seven hours later. `since` alone would release it on the second sight
  // of it — "it stood for six hours" on the strength of two observations.
  t += 7 * 3600e3
  const r = g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: CD })
  assert.deepEqual(r.items.get('The Twilight Moon'), [1, 0], 'the returning card enters unexamined')
  assert.equal(r.notes[0].withheld, true, 'it is a fresh arrival, judged from the beginning')
})

// --- a point that says nothing ends nothing ---------------------------------
// GONE and HERE-BUT-UNPRICED used to be the same observation to the hold sweep,
// and they are not: absence says the item did not stand, a missing price says
// only that the valuation had nothing for that name this minute. Treating the
// second as the first restarted the six hours at every flicker of a price feed.

test('a point in which the item carries no price of its own does not end the hold', () => {
  let t = 1_000_000
  const g = createPriceGuard({ now: () => t, maxHoldMs: 6 * 3600e3, log: SILENT })
  g.apply('player1', prev(), spike(), TOTAL)
  assert.equal(g.held.size, 1)
  // The card is still in the snapshot; the valuation just has no price for it.
  t += 60_000
  const unpriced = new Map([['The Scavenger', [1, 0]], ['Rest', [1, 14508.8]]])
  const blind = g.apply('player1', prev(), unpriced, TOTAL)
  assert.equal(g.held.size, 1, 'the hold was dropped although the card never left')
  assert.equal(g.held.get('player1|The Scavenger').price, 1, 'and it still carries its reference')
  assert.equal(blind.adjust, 0)
  assert.deepEqual(blind.notes, [], 'nothing to correct in a point that has no price in it')
  // The reference is therefore still the held one when the spike comes back.
  t += 60_000
  const r = g.apply('player1', prev(), spike(), TOTAL)
  assert.equal(r.items.get('The Scavenger')[1], 1)
})

test('the blind points do not count towards the window either — the deadline moves out', () => {
  let t = 1_000_000
  const g = createPriceGuard({ now: () => t, maxHoldMs: 6 * 3600e3, log: SILENT })
  g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: CD })
  // Three hours in which the card is in the snapshot at no value at all.
  t += 3 * 3600e3
  g.apply('player1', withMoon(0), withMoon(0), BASELINE, { cdRatio: CD })
  assert.equal(g.held.size, 1)
  // Six hours on the clock, but only three of them observed: still withheld.
  t += 3 * 3600e3
  const early = g.apply('player1', withMoon(0), withMoon(), BASELINE, { cdRatio: CD })
  assert.deepEqual(early.items.get('The Twilight Moon'), [1, 0], 'released on a window it was blind for')
  // Six OBSERVED hours after the suspicion started, it is accepted.
  t += 3 * 3600e3
  const out = g.apply('player1', withMoon(0), withMoon(), BASELINE, { cdRatio: CD })
  assert.equal(out.adjust, 0)
  assert.equal(out.notes[0].released, true)
})

test('a flickering price feed no longer restarts the six hours at every gap', () => {
  let t = 1_000_000
  const lines = []
  const g = createPriceGuard({ now: () => t, maxHoldMs: 6 * 3600e3, log: (...a) => lines.push(a[0]) })
  g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: CD })
  assert.equal(lines.length, 1)
  // Thirteen hours of half-minute-apart points, every other one without a price
  // for the card. Six hours of them carried one, so the arrival is accepted —
  // and the withholding line was written once, not once per gap. Before this,
  // the hold restarted on every unpriced point and the card stood in the series
  // at zero for as long as the feed flickered.
  for (let i = 0; i < 26; i++) {
    t += 30 * 60e3
    g.apply('player1', withMoon(0), i % 2 ? withMoon() : withMoon(0), BASELINE, { cdRatio: CD })
  }
  assert.equal(g.held.size, 0, 'the arrival never got out of the hold')
  assert.equal(lines.filter(l => /withheld from the trend/.test(l)).length, 1, 'one restart per gap')
  assert.match(lines.at(-1), /withheld arrival accepted/)
})

test('the release is reported even though it corrects nothing', () => {
  let t = 1_000_000
  const g = createPriceGuard({ now: () => t, maxHoldMs: 6 * 3600e3, log: SILENT })
  g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: CD })
  t += 6 * 3600e3
  const r = g.apply('player1', withMoon(0), withMoon(), BASELINE, { cdRatio: CD })
  assert.equal(r.adjust, 0)
  assert.equal(r.notes.length, 1, 'an empty note list is how the release went missing')
  assert.equal(r.notes[0].released, true)
  assert.equal(r.notes[0].name, 'The Twilight Moon')
  assert.equal(r.notes[0].qty, 1)
})

test('a point without a C:D rate uses the newest rate the guard has seen', () => {
  const g = createPriceGuard({ log: SILENT })
  g.apply('player1', before(), before(), BASELINE, { cdRatio: CD })   // teaches it the rate
  const r = g.apply('player1', before(), withMoon(), BASELINE)        // this point has none
  assert.deepEqual(r.items.get('The Twilight Moon'), [1, 0], 'the bar abstained although it knew a rate')
})

// --- reading the bars out of the environment --------------------------------
test('every bar can be set to 0, and 0 is not the default', () => {
  const o = guardOptionsFromEnv({
    POE_NETWORTH_GUARD_FACTOR: '0',
    POE_NETWORTH_GUARD_SHARE: '0',
    POE_NETWORTH_GUARD_HOLD_MS: '0',
    POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE: '0'
  })
  assert.deepEqual(o, { factor: 0, share: 0, maxHoldMs: 0, arrivalMinDivine: 0 })
})

test('0 divine really does switch the arrival bar off', () => {
  const g = createPriceGuard({ ...guardOptionsFromEnv({ POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE: '0' }), log: SILENT })
  assert.equal(g.apply('player1', before(), withMoon(), BASELINE, { cdRatio: CD }).adjust, 0)
})

// The other three zeros are honoured as well, and NONE of them is an off
// switch. docs/admin.md now says what each one does; these tests are what it
// says it against.
test('factor 0 does not switch the jump bar off — it stops it filtering', () => {
  const p = new Map([['Rest', [1, 1000]], ['Divine Orb', [1, 500]]])
  const doubled = new Map([['Rest', [1, 1000]], ['Divine Orb', [1, 1000]]])
  const g = createPriceGuard({ factor: 0, log: SILENT })
  assert.equal(g.apply('player1', p, doubled, 1500).items.get('Divine Orb')[1], 500,
    'a 2x is nobody\'s implausible jump, but with factor 0 the share bar decides alone')
  // …and the share bar still does decide: a small gain is left alone.
  const nudged = new Map([['Rest', [1, 1000]], ['Divine Orb', [1, 505]]])
  assert.equal(createPriceGuard({ factor: 0, log: SILENT }).apply('player1', p, nudged, 1500).adjust, 0)
})

test('share 0 does not switch the jump bar off either — the factor decides alone', () => {
  const p = new Map([['Rest', [1, 14509]], ['Scroll of Wisdom', [10, 1]]])
  const x100 = new Map([['Rest', [1, 14509]], ['Scroll of Wisdom', [10, 100]]])
  const g = createPriceGuard({ share: 0, log: SILENT })
  assert.equal(g.apply('player1', p, x100, 14510).items.get('Scroll of Wisdom')[1], 1,
    '99c against 14509c of holdings is noise, and with share 0 it is held anyway')
  const x2 = new Map([['Rest', [1, 14509]], ['Scroll of Wisdom', [10, 2]]])
  assert.equal(createPriceGuard({ share: 0, log: SILENT }).apply('player1', p, x2, 14510).adjust, 0)
})

test('factor 0 AND share 0 hold every priced item — and are loud enough to be found', () => {
  const lines = []
  const g = createPriceGuard({ factor: 0, share: 0, log: (...a) => lines.push(a[0]) })
  const p = new Map([['Chaos Orb', [100, 100]], ['Rest', [1, 1000]]])
  const up = new Map([['Chaos Orb', [100, 110]], ['Rest', [1, 1000]]])
  const r = g.apply('player1', p, up, 1100)
  assert.equal(r.items.get('Chaos Orb')[1], 100, 'no price rise reaches the series any more')
  assert.equal(r.notes.length, 2, 'even the item whose price did not move at all is held')
  assert.equal(lines.length, 2, 'one line per priced item per point: pathological, but never silent')
  // Which is why it is documented rather than refused — and it still lets the
  // series follow STOCK, because the hold pins a price and not a quantity.
  const more = new Map([['Chaos Orb', [200, 200]], ['Rest', [1, 1000]]])
  assert.equal(createPriceGuard({ factor: 0, share: 0, log: SILENT }).apply('player1', p, more, 1100).adjust, 0)
})

test('a hold window of 0 is not "no hold": the brake then never lets go', () => {
  let t = 1_000_000
  const g = createPriceGuard({ maxHoldMs: 0, now: () => t, log: SILENT })
  let recorded = prev()
  for (let i = 0; i < 4; i++) {
    const out = g.apply('player1', recorded, spike(), TOTAL)
    assert.equal(out.items.get('The Scavenger')[1], 1, `point ${i} let the spike into the series`)
    assert.equal(out.notes[0].released, undefined, 'a window of zero never reaches the release')
    recorded = out.items
    t += 60_000
  }
})

test('unset, empty and unusable values fall back to the documented defaults', () => {
  const defaults = {
    factor: GUARD_FACTOR, share: GUARD_SHARE,
    maxHoldMs: GUARD_MAX_HOLD_MS, arrivalMinDivine: GUARD_ARRIVAL_MIN_DIVINE
  }
  assert.deepEqual(guardOptionsFromEnv({}), defaults)
  assert.deepEqual(guardOptionsFromEnv({
    POE_NETWORTH_GUARD_FACTOR: '',
    POE_NETWORTH_GUARD_SHARE: '   ',
    POE_NETWORTH_GUARD_HOLD_MS: 'six hours',
    POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE: '-5'
  }), defaults)
  assert.equal(guardOptionsFromEnv({ POE_NETWORTH_GUARD_SHARE: '0.4' }).share, 0.4)
})

test('the guard names the price source it rejected a number from', () => {
  const lines = []
  const g = createPriceGuard({ log: (...a) => lines.push(a) })
  g.apply('player1', prev(), spike(), TOTAL, { sourceOf: new Map([['The Scavenger', 'faustus']]) })
  assert.ok(lines[0].includes('faustus'), 'the source is missing from the log line')
  const arrival = []
  const g2 = createPriceGuard({ log: (...a) => arrival.push(a) })
  g2.apply('player1', before(), withMoon(), BASELINE, {
    cdRatio: CD, sourceOf: new Map([['The Twilight Moon', 'exchange:DivinationCard']])
  })
  assert.ok(arrival[0].includes('exchange:DivinationCard'))
})

test('an unknown source is named as unknown, never omitted', () => {
  const lines = []
  const g = createPriceGuard({ log: (...a) => lines.push(a) })
  g.apply('player1', prev(), spike(), TOTAL)
  assert.ok(lines[0].includes('unknown'))
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

test('a jump hold hands its reference to the memory when the item leaves', () => {
  let t = 1_000_000
  const g = createPriceGuard({ now: () => t, log: SILENT })
  g.apply('player1', prev(), spike(), TOTAL)          // held at 1c/ea
  t += 60_000
  g.apply('player1', prev(), new Map([['Rest', [1, 14508.8]]]), TOTAL) // the card is gone
  assert.equal(g.held.size, 0)
  // Back at the spike: there is no prevMap entry and no hold any more, so only
  // the remembered 1c can keep this out of the series at 174,039c.
  t += 60_000
  const r = g.apply('player1', new Map([['Rest', [1, 14508.8]]]), spike(), TOTAL, { cdRatio: 212 })
  assert.equal(r.items.get('The Scavenger')[1], 1)
  assert.equal(r.notes[0].oldPrice, 1)
  assert.equal(r.notes[0].withheld, undefined, 'a known price is held, not withheld')
})
