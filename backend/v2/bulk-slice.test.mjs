// Currency choice in the bulk exchange: the side that pays the SELLER more
// wins (chaos vs. divine on a common chaos scale), not the one with the most
// listings. Source: backend/v2/engine.mts (chooseBulkSlice), tested against
// the built bundle.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as engine from './engine.bundle.mjs'

const CD = 106 // chaos per divine

// exchangeAmount/itemAmount = price per unit in the have currency
const slice = (haveTag, perItem, n, id = haveTag) => ({
  haveTag,
  queryId: id,
  total: n,
  listed: Array.from({ length: n }, () => ({ exchangeAmount: perItem, itemAmount: 1 }))
})

test('the better payout wins even when the worse side has more listings', () => {
  // chaos: 60c per unit (5 offers) vs. divine: 0.4 div = 42.4c (20 offers)
  const chosen = engine.chooseBulkSlice([slice('divine', 0.4, 20), slice('chaos', 60, 5)], CD)
  assert.equal(chosen.haveTag, 'chaos')
})

test('divine wins when divine pays more', () => {
  // divine: 0.6 div = 63.6c (5 offers) vs. chaos: 50c (20 offers)
  const chosen = engine.chooseBulkSlice([slice('chaos', 50, 20), slice('divine', 0.6, 5)], CD)
  assert.equal(chosen.haveTag, 'divine')
})

test('the price is computed per unit (exchangeAmount/itemAmount)', () => {
  const bulkChaos = { haveTag: 'chaos', queryId: 'c', total: 4, listed: Array.from({ length: 4 }, () => ({ exchangeAmount: 100, itemAmount: 2 })) } // 50c/unit
  const div = slice('divine', 0.6, 4) // 63.6c/unit
  assert.equal(engine.chooseBulkSlice([bulkChaos, div], CD).haveTag, 'divine')
})

test('median instead of mean: one outlier inside a side does not flip the choice', () => {
  const trollish = {
    haveTag: 'divine',
    queryId: 'd',
    total: 5,
    listed: [0.3, 0.3, 0.3, 0.3, 40].map(v => ({ exchangeAmount: v, itemAmount: 1 }))
  } // median 0.3 div = 31.8c, the mean would be ~8 div
  const chosen = engine.chooseBulkSlice([trollish, slice('chaos', 50, 5)], CD)
  assert.equal(chosen.haveTag, 'chaos')
})

test('a thin troll corner never displaces a liquid side (under 3 listings)', () => {
  // 2 offers at 3 div = 318c against 12 offers at 50c: the thin side wins on
  // paper, but it must not replace the liquid one.
  const chosen = engine.chooseBulkSlice([slice('divine', 3, 2), slice('chaos', 50, 12)], CD)
  assert.equal(chosen.haveTag, 'chaos')
})

test('without a C:D rate the old behaviour stands: most listings wins', () => {
  const chosen = engine.chooseBulkSlice([slice('chaos', 60, 5), slice('divine', 0.4, 20)], undefined)
  assert.equal(chosen.haveTag, 'divine')
})

test('empty/null sides drop out, a single side -> exactly that one', () => {
  assert.equal(engine.chooseBulkSlice([null, slice('chaos', 5, 3)], CD).haveTag, 'chaos')
  assert.equal(engine.chooseBulkSlice([slice('divine', 1, 0), slice('chaos', 5, 3)], CD).haveTag, 'chaos')
  assert.equal(engine.chooseBulkSlice([null, undefined], CD), null)
  assert.equal(engine.chooseBulkSlice([], CD), null)
})

test('a tie: no arbitrary flip, a valid side comes back', () => {
  const chosen = engine.chooseBulkSlice([slice('chaos', 106, 4), slice('divine', 1, 4)], CD)
  assert.ok(chosen && ['chaos', 'divine'].includes(chosen.haveTag))
})

// --- outlier rule (extreme factor -> better-backed side over the richer one) --
// Measured in the Allflame league (C:D 173.36 per Faustus), see the comment on
// BULK_EXTREME_SPLIT in engine.mts.
const CD_LIVE = 173.36

// like slice(), but with its own hit count (total) — the Exchange reports more
// hits than it hands out listings (page capped at 20).
const wide = (haveTag, perItem, n, total) => ({ ...slice(haveTag, perItem, n), total })

test('Wildwood-Ember: 50x spread -> the better-backed chaos side wins', () => {
  // Measured live: chaos median 3.5c over 72 hits, divine median 1 div
  // (173.4c) over 17 hits. Faustus does not know the item, really worth ~1c.
  const chaos = wide('chaos', 3.5, 20, 72)
  const divine = wide('divine', 1, 17, 17)
  assert.equal(engine.chooseBulkSlice([chaos, divine], CD_LIVE).haveTag, 'chaos')
})

test('Ancient Orb: just over the threshold (10.4x) -> chaos side', () => {
  // chaos 9.0c/29 hits vs. divine 0.54 div = 93.9c/6 hits; Faustus 9.2c.
  const chosen = engine.chooseBulkSlice([wide('chaos', 9, 20, 29), wide('divine', 93.9 / CD_LIVE, 6, 6)], CD_LIVE)
  assert.equal(chosen.haveTag, 'chaos')
})

test('Ethereal-Ember: 5.8x -> no outlier, the higher-paying side stands', () => {
  // chaos 30c/11 hits vs. divine 1 div = 173.4c/51 hits; Faustus 162.7c.
  const chosen = engine.chooseBulkSlice([wide('chaos', 30, 11, 11), wide('divine', 1, 20, 51)], CD_LIVE)
  assert.equal(chosen.haveTag, 'divine')
})

test('Reflecting Mist: 2.2x, both sides plausible -> revenue logic unchanged', () => {
  // chaos 155c/4 hits vs. divine 2 div = 346.7c/12 hits. The chaos side is the
  // worse-backed AND the poorer one — divine still wins, because 2.2x is a
  // normal spread.
  const chosen = engine.chooseBulkSlice([wide('chaos', 155, 4, 4), wide('divine', 2, 12, 12)], CD_LIVE)
  assert.equal(chosen.haveTag, 'divine')
})

test('extreme spread, but the richer side is also the better-backed one -> it wins', () => {
  const chosen = engine.chooseBulkSlice([wide('chaos', 5, 4, 4), wide('divine', 1, 20, 60)], CD_LIVE)
  assert.equal(chosen.haveTag, 'divine')
})

test('extreme spread with equal backing -> no flip, revenue decides', () => {
  const chosen = engine.chooseBulkSlice([wide('chaos', 5, 8, 20), wide('divine', 1, 8, 20)], CD_LIVE)
  assert.equal(chosen.haveTag, 'divine')
})

test('without total the delivered listings count as the backing', () => {
  const noTotal = (haveTag, perItem, n) => {
    const s = slice(haveTag, perItem, n)
    delete s.total
    return s
  }
  const chosen = engine.chooseBulkSlice([noTotal('chaos', 3.5, 20), noTotal('divine', 1, 17)], CD_LIVE)
  assert.equal(chosen.haveTag, 'chaos')
})

test('the outlier rule keeps thin sides out as before', () => {
  // with 2 listings divine sits below BULK_THIN_SLICE: it may compete against
  // the liquid chaos side neither on price nor on backing.
  const chosen = engine.chooseBulkSlice([wide('divine', 3, 2, 900), wide('chaos', 50, 12, 12)], CD_LIVE)
  assert.equal(chosen.haveTag, 'chaos')
})

test('only one side despite an extreme price -> exactly that side, no crash', () => {
  assert.equal(engine.chooseBulkSlice([null, wide('divine', 3, 5, 5)], CD_LIVE).haveTag, 'divine')
  assert.equal(engine.chooseBulkSlice([], CD_LIVE), null)
})
