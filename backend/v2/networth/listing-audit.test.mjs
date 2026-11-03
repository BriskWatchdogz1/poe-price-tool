// "Listed below market" (listing-audit.mjs): the price notes kept in the
// per-tab store, compared with the tool's own market value by the same rule
// as the buyer-whisper verdict 'below'. Pure functions, no I/O.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePriceNote, listingOf, auditListings, stackSizeAt, createStackLookup, quadTabAt, createQuadLookup, AUDIT_SKIP_REASONS, BELOW_MAX } from './listing-audit.mjs'
import { verdictFor } from '../whisper-price.mjs'

const BAND = { lowRatio: 0.85, highRatio: 1.15 }
const RATE = { chaosPerDivine: 200, divineRateKnown: true }

test('parsePriceNote reads ~price and ~b/o with whole, decimal and fractional amounts', () => {
  assert.deepEqual(parsePriceNote('~price 5 chaos'), { amount: 5, unit: 'chaos' })
  assert.deepEqual(parsePriceNote('~b/o 1.5 divine'), { amount: 1.5, unit: 'divine' })
  assert.deepEqual(parsePriceNote('~b/o 1/20 divine'), { amount: 0.05, unit: 'divine' })
  assert.deepEqual(parsePriceNote('  ~price 3 exalted  '), { amount: 3, unit: 'exalted' })
})

test('parsePriceNote: anything that is not a price note is null', () => {
  for (const n of [null, undefined, 5, '', 'my stuff', '~price chaos', '~price 5', '~price -5 chaos',
    '~price 0 chaos', '~price 5/0 chaos', '~sell 5 chaos', 'x~price 5 chaos', '~price 5 chaos extra',
    '~price 1e3 chaos', '~price ' + '9'.repeat(400) + ' chaos']) {
    assert.equal(parsePriceNote(n), null, JSON.stringify(n))
  }
})

test('listingOf keeps the item note, falls back to a priced tab name, and stores nothing else', () => {
  const tab = { index: 2, name: 'Sale', type: 'PremiumStash' }
  const desc = { kind: 'unique', name: 'Headhunter', stack: 1 }
  const value = { chaosEach: 900, chaosTotal: 900, each: 900, uncertain: null }
  assert.deepEqual(listingOf({ note: '~price 5 chaos', x: 3, y: 7 }, desc, value, tab),
    { name: 'Headhunter', kind: 'unique', qty: 1, x: 3, y: 7, note: '~price 5 chaos', fromTab: false, chaosEach: 900, uncertain: null })
  // The stored market value is the unrounded `each`, not the 0.1 c display value.
  const shard = { kind: 'stackable', name: 'Chaos Shard', stack: 20 }
  assert.equal(listingOf({ note: '~b/o 1/20 chaos', x: 0, y: 0 }, shard, { chaosEach: 0.1, chaosTotal: 1, each: 0.05, uncertain: null }, tab).chaosEach, 0.05)
  // No market value above 0: nothing to be below, nothing kept.
  assert.equal(listingOf({ note: '~price 5 chaos', x: 0, y: 0 }, desc, { chaosEach: 0, chaosTotal: 0, each: 0, uncertain: null }, tab), null)
  // No price note on the item: nothing to keep.
  assert.equal(listingOf({ note: 'keep', x: 0, y: 0 }, desc, value, tab), null)
  assert.equal(listingOf({ x: 0, y: 0 }, desc, value, tab), null)
  // Unpriced item: nothing to compare with, nothing kept.
  assert.equal(listingOf({ note: '~price 5 chaos', x: 0, y: 0 }, desc, null, tab), null)
  // A tab named as a price prices every item in it without its own note.
  const priced = { index: 4, name: '~b/o 2 chaos', type: 'QuadStash' }
  const row = listingOf({ x: 13, y: 20 }, desc, value, priced)
  assert.equal(row.note, '~b/o 2 chaos')
  assert.equal(row.fromTab, true)
  // A normal tab cannot be put up for sale: neither its name nor a note on an
  // item in it is a listing (an item moved there with its note is not for sale).
  const normal = { index: 5, name: '~price 1 chaos', type: 'NormalStash' }
  assert.equal(listingOf({ x: 0, y: 0 }, desc, value, normal), null)
  assert.equal(listingOf({ note: '~price 5 chaos', x: 0, y: 0 }, desc, value, normal), null)
  assert.equal(listingOf({ note: '~price 5 chaos', x: 0, y: 0 }, desc, value, { index: 6, name: 'Dump', type: 'NormalStash' }), null)
  // The item's own note wins over the tab's.
  assert.equal(listingOf({ note: '~price 9 chaos', x: 0, y: 0 }, desc, value, priced).note, '~price 9 chaos')
  // A position that is not a whole number is not invented.
  const odd = listingOf({ note: '~price 5 chaos', x: 'a' }, desc, value, tab)
  assert.equal(odd.x, null)
  assert.equal(odd.y, null)
})

const tabOf = (index, name, listed) => ({ index, name, items: [], unpriced: [], counts: {}, listed })
const L = (name, note, chaosEach, over = {}) => ({ name, kind: 'unique', qty: 1, x: 0, y: 0, note, fromTab: false, chaosEach, uncertain: null, ...over })

test('auditListings lists what is below by the whisper rule, sorted by loss, and nothing else', () => {
  const tabs = [
    tabOf(0, 'Sale', [
      L('Cheap', '~price 10 chaos', 100, { x: 4, y: 2 }),     // ratio 0.1  loss 90
      L('Fair', '~price 95 chaos', 100),                       // ratio 0.95 fair
      L('Dear', '~price 200 chaos', 100)                       // above
    ]),
    tabOf(1, 'Uniques', [
      L('Big', '~b/o 1 divine', 400)                           // 200 c vs 400: ratio 0.5 loss 200
    ])
  ]
  const r = auditListings(tabs, { ...RATE, ...BAND })
  assert.deepEqual(r.rows.map(x => x.name), ['Big', 'Cheap'])
  const big = r.rows[0]
  assert.equal(big.tab, 'Uniques')
  assert.equal(big.tabIndex, 1)
  assert.equal(big.listedChaos, 200)
  assert.equal(big.marketChaos, 400)
  assert.equal(big.lossChaos, 200)
  assert.equal(big.ratio, 0.5)
  assert.equal(big.pct, 50)
  assert.equal(big.unit, 'divine')
  assert.equal(big.amount, 1)
  // Positions are the trade site's 1-based left/top, like a whisper's.
  assert.equal(r.rows[1].left, 5)
  assert.equal(r.rows[1].top, 3)
  assert.deepEqual(r.notCompared, {})
})

test('the threshold is the whisper verdict\'s, not a copy: a ratio the whisper calls below is listed, one it calls fair is not', () => {
  for (const [asked, market] of [[84, 100], [85, 100], [86, 100], [10, 11], [1, 1]]) {
    const r = auditListings([tabOf(0, 'T', [L('X', `~price ${asked} chaos`, market)])], { ...RATE, ...BAND })
    assert.equal(r.rows.length === 1, verdictFor(asked, market, BAND).verdict === 'below', `${asked}/${market}`)
  }
  // Another low ratio moves the line with it.
  const r = auditListings([tabOf(0, 'T', [L('X', '~price 60 chaos', 100)])], { ...RATE, lowRatio: 0.5, highRatio: 1.15 })
  assert.equal(r.rows.length, 0)
})

test('a stack is read per unit: the dearest reading, so a stack listed below is below either way', () => {
  // 20 per unit against a market of 30 each: below per unit (0.67), and per
  // stack (20 for 10 pieces) even more so.
  const r = auditListings([tabOf(0, 'Cards', [L('The Doctor', '~price 20 chaos', 30, { kind: 'divcard', qty: 10 })])], { ...RATE, ...BAND })
  assert.equal(r.rows.length, 1)
  const row = r.rows[0]
  assert.equal(row.qty, 10)
  assert.equal(row.listedChaosEach, 20)
  assert.equal(row.marketChaosEach, 30)
  assert.equal(row.listedChaos, 200)
  assert.equal(row.marketChaos, 300)
  assert.equal(row.lossChaos, 100)
  // 2 per unit is fair per unit (2 vs 2): not listed, even though the stack
  // reading would be far below — the tool does not know which one is meant.
  const fair = auditListings([tabOf(0, 'Cards', [L('C', '~price 2 chaos', 2, { qty: 10 })])], { ...RATE, ...BAND })
  assert.equal(fair.rows.length, 0)
})

test('no comparison where the whisper verdict would make none; each is counted by reason', () => {
  const tabs = [tabOf(0, 'T', [
    L('Div', '~price 1 divine', 900),                               // rate unknown below
    L('Unc', '~price 1 chaos', 900, { uncertain: 'thin-market' }),  // uncertain market price
    L('Ex', '~price 1 exalted', 900),                               // a currency the audit does not convert
    L('Zero', '~price 1 chaos', 0),                                  // stored by an older build: no verdict, not counted
    L('Broken', 'not a note', 900),                                  // a stored note that no longer parses
    L('Ok', '~price 1 chaos', 900)
  ])]
  const r = auditListings(tabs, { chaosPerDivine: 200, divineRateKnown: false, ...BAND })
  assert.deepEqual(r.rows.map(x => x.name), ['Ok'])
  assert.deepEqual(r.notCompared, { 'rate-unknown': 1, 'uncertain-price': 1, 'unknown-currency': 1 })
  for (const k of Object.keys(r.notCompared)) assert.ok(AUDIT_SKIP_REASONS.includes(k), k)
  // No usable rate at all is the same as an unknown one.
  const none = auditListings([tabOf(0, 'T', [L('Div', '~price 1 divine', 900)])], { chaosPerDivine: null, divineRateKnown: true, ...BAND })
  assert.deepEqual(none.notCompared, { 'rate-unknown': 1 })
})

test('a tab stored before notes were kept has no listed key and adds nothing', () => {
  const r = auditListings([{ index: 0, name: 'Old', items: [], unpriced: [], counts: {} }, null], { ...RATE, ...BAND })
  assert.deepEqual(r, { rows: [], more: 0, notCompared: {} })
})

test('cheap stacks are judged on the unrounded market value, as a whisper is', () => {
  // 1/20 chaos for a Chaos Shard worth 0.05 c is fair; rounded to 0.1 c it
  // would read as half the market. 1/8 chaos for a Transmutation worth 0.149 c
  // is below (0.84); rounded to 0.1 c it would read as above.
  for (const [note, each, below] of [['~b/o 1/20 chaos', 0.05, false], ['~b/o 1/8 chaos', 0.149, true], ['~b/o 1/7 chaos', 0.15, false]]) {
    const r = auditListings([tabOf(0, 'T', [L('X', note, each, { kind: 'stackable', qty: 20 })])], { ...RATE, ...BAND })
    assert.equal(r.rows.length === 1, below, `${note} vs ${each}`)
    assert.equal(r.rows.length === 1, verdictFor(parsePriceNote(note).amount * 20, each * 20, BAND).verdict === 'below')
  }
})

test('the rows are capped to the biggest losses and the rest is counted', () => {
  const listed = Array.from({ length: BELOW_MAX + 7 }, (_, i) => L(`I${i}`, '~price 1 chaos', 10 + i))
  const r = auditListings([tabOf(0, '~price 1 chaos', listed)], { ...RATE, ...BAND })
  assert.equal(r.rows.length, BELOW_MAX)
  assert.equal(r.more, 7)
  // The biggest loss first, the smallest ones are the ones left out.
  assert.equal(r.rows[0].name, `I${BELOW_MAX + 6}`)
  assert.equal(r.rows.at(-1).name, 'I7')
  const small = auditListings([tabOf(0, 'T', listed)], { ...RATE, ...BAND, max: 2 })
  assert.deepEqual([small.rows.length, small.more], [2, BELOW_MAX + 5])
})

// A single whisper for a stackable names a tab and a cell; the stored listing
// at that cell says how big the stack is (whisper-price.mjs, 'stack-unknown').
test('stackSizeAt finds the stack size at a whisper\'s tab and cell, 1-based like the whisper', () => {
  const tabs = [
    { index: 0, name: 'Sale', listed: [
      { name: 'Orb of Alchemy', kind: 'stackable', qty: 20, x: 4, y: 2, note: '~price 5 chaos', chaosEach: 0.4, uncertain: null },
      { name: 'Chaos Orb', kind: 'stackable', qty: 7, x: 0, y: 0, note: '~price 1 chaos', chaosEach: 1, uncertain: null }
    ] },
    { index: 1, name: 'Other', listed: [
      { name: 'Orb of Alchemy', kind: 'stackable', qty: 40, x: 4, y: 2, note: '~price 5 chaos', chaosEach: 0.4, uncertain: null }
    ] },
    { index: 2, name: 'Old' } // stored before listings were kept
  ]
  assert.equal(stackSizeAt(tabs, { tab: 'Sale', left: 5, top: 3, ref: 'Orb of Alchemy' }), 20)
  assert.equal(stackSizeAt(tabs, { tab: 'Other', left: 5, top: 3, ref: 'Orb of Alchemy' }), 40)
  assert.equal(stackSizeAt(tabs, { tab: 'Sale', left: 1, top: 1, ref: 'Chaos Orb' }), 7)
  assert.equal(stackSizeAt(tabs, { tab: 'Sale', left: 5, top: 3, ref: 'Chaos Orb' }), null, 'another item at that cell')
  assert.equal(stackSizeAt(tabs, { tab: 'Sale', left: 4, top: 3, ref: 'Orb of Alchemy' }), null, 'another cell')
  assert.equal(stackSizeAt(tabs, { tab: 'Nope', left: 5, top: 3, ref: 'Orb of Alchemy' }), null, 'another tab')
  assert.equal(stackSizeAt(tabs, { tab: 'Old', left: 1, top: 1, ref: 'Chaos Orb' }), null)
  // Two tabs of the same name that disagree: no size rather than a guess.
  const twins = [tabs[0], { ...tabs[1], name: 'Sale' }]
  assert.equal(stackSizeAt(twins, { tab: 'Sale', left: 5, top: 3, ref: 'Orb of Alchemy' }), null)
  const agree = [tabs[0], { index: 3, name: 'Sale', listed: [{ ...tabs[0].listed[0] }] }]
  assert.equal(stackSizeAt(agree, { tab: 'Sale', left: 5, top: 3, ref: 'Orb of Alchemy' }), 20)
  for (const odd of [null, undefined, [], [null], [{ name: 'Sale', listed: [null, { x: 'a' }] }]]) {
    assert.equal(stackSizeAt(odd, { tab: 'Sale', left: 5, top: 3, ref: 'Orb of Alchemy' }), null)
  }
  assert.equal(stackSizeAt(tabs, {}), null)
  assert.equal(stackSizeAt(tabs, null), null)
})

// What server.mjs hands the whisper pricer: the store of the whisper's user,
// and only while that store holds the whisper's league.
test('createStackLookup reads the user\'s stored tabs for the league the store holds', () => {
  const tabs = { p1: [{ index: 0, name: 'Sale', listed: [{ name: 'Orb of Alchemy', qty: 20, x: 4, y: 2 }] }] }
  const meta = { p1: { league: 'Mercenaries' } }
  const reads = []
  const store = {
    tabList: u => { reads.push(u); return tabs[u] || [] },
    getMeta: u => meta[u] || null
  }
  const at = { tab: 'Sale', left: 5, top: 3, ref: 'Orb of Alchemy' }
  const lookup = createStackLookup(store)
  assert.equal(lookup({ user: 'p1', league: 'Mercenaries', ...at }), 20)
  assert.equal(lookup({ user: 'p1', league: 'Standard', ...at }), null, 'the store holds another league')
  assert.equal(lookup({ user: 'p2', league: 'Mercenaries', ...at }), null, 'nothing stored for that user')
  assert.equal(lookup({ user: null, league: 'Mercenaries', ...at }), null)
  meta.p1 = {}
  assert.equal(lookup({ user: 'p1', league: 'Mercenaries', ...at }), 20, 'a store without a league yet is read')
  assert.equal(createStackLookup({ tabList () { throw new Error('x') }, getMeta: () => null })({ user: 'p1', league: 'Mercenaries', ...at }), null)
  assert.equal(createStackLookup(null)({ user: 'p1', league: 'Mercenaries', ...at }), null)
  assert.ok(reads.every(u => u === 'p1' || u === 'p2'))
})

// The daemon's stash cell frame (ppt_stash_grid.py) needs to know whether a
// whisper's tab is a quad tab (24x24 cells): the stored tab type of the last
// sync, by the whisper's tab name.
test('quadTabAt says whether the whisper\'s tab is a quad tab, and null when the sync cannot tell', () => {
  const tabs = [
    { index: 0, name: 'Quad', type: 'QuadStash' },
    { index: 1, name: 'Sale', type: 'PremiumStash' },
    { index: 2, name: 'Old' },                     // written before the type was kept
    { index: 3, name: 'Twin', type: 'QuadStash' },
    { index: 4, name: 'Twin', type: 'PremiumStash' },
    { index: 5, name: 'Pair', type: 'QuadStash' },
    { index: 6, name: 'Pair', type: 'QuadStash' }
  ]
  assert.equal(quadTabAt(tabs, 'Quad'), true)
  assert.equal(quadTabAt(tabs, 'Sale'), false)
  assert.equal(quadTabAt(tabs, 'Old'), null, 'a stored tab without a type tells nothing')
  assert.equal(quadTabAt(tabs, 'Twin'), null, 'tabs of the same name that disagree give null, not a guess')
  assert.equal(quadTabAt(tabs, 'Pair'), true, 'tabs of the same name that agree')
  assert.equal(quadTabAt(tabs, 'Nope'), null, 'a tab the sync has not seen')
  assert.equal(quadTabAt(tabs, null), null)
  assert.equal(quadTabAt(null, 'Quad'), null)
})

test('createQuadLookup reads the user\'s stored tabs for the league the store holds, never throws', () => {
  const tabs = { p1: [{ index: 0, name: 'Quad', type: 'QuadStash' }] }
  const meta = { p1: { league: 'Mercenaries' } }
  const store = { tabList: u => tabs[u] || [], getMeta: u => meta[u] || null }
  const lookup = createQuadLookup(store)
  assert.equal(lookup({ user: 'p1', league: 'Mercenaries', tab: 'Quad' }), true)
  assert.equal(lookup({ user: 'p1', league: 'Standard', tab: 'Quad' }), null, 'the store holds another league')
  assert.equal(lookup({ user: 'p2', league: 'Mercenaries', tab: 'Quad' }), null)
  assert.equal(lookup({ user: null, league: 'Mercenaries', tab: 'Quad' }), null)
  assert.equal(lookup(), null)
  assert.equal(createQuadLookup({ tabList () { throw new Error('x') }, getMeta: () => null })({ user: 'p1', league: 'Mercenaries', tab: 'Quad' }), null)
  assert.equal(createQuadLookup(null)({ user: 'p1', league: 'Mercenaries', tab: 'Quad' }), null)
})
