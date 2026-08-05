import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lastHour, rateXperQuote, createFaustusPricer, isInformativeMarket } from './faustus.mjs'

const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare'
const DIVINE = 'Metadata/Items/Currency/CurrencyModValues'

// Build a market pairing x with quote. lo/hi are the {id: uint} ratio dicts,
// vol the {id: uint} volume_traded dict. league default 'Standard'.
const mk = (pair, lo, hi, vol, league = 'Standard') => ({
  league, market_pair: pair, lowest_ratio: lo, highest_ratio: hi, volume_traded: vol
})

const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps

// ---------------------------------------------------------------------------
// lastHour
// ---------------------------------------------------------------------------
test('lastHour: truncates to the hour and steps back one', () => {
  // 8h + 1234s -> floor to 8h, minus one hour = 7h.
  assert.equal(lastHour(8 * 3600 + 1234), 7 * 3600)
  assert.equal(lastHour(8 * 3600), 7 * 3600) // exactly on the hour
})

// ---------------------------------------------------------------------------
// rateXperQuote — the empirically-verified midpoint, pinned.
// ---------------------------------------------------------------------------
const X = 'Metadata/Items/Currency/SomeX'

test('rateXperQuote: essence 1:1 -> 1c', () => {
  const m = mk([X, CHAOS], { [X]: 1, [CHAOS]: 1 }, { [X]: 1, [CHAOS]: 1 },
    { [X]: 5, [CHAOS]: 100 })
  assert.equal(rateXperQuote(m, X, CHAOS), 1)
})

test('rateXperQuote: divine lo{955}/hi{1300} -> ~1127', () => {
  const m = mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 955 }, { [DIVINE]: 1, [CHAOS]: 1300 },
    { [DIVINE]: 10, [CHAOS]: 1000 })
  assert.ok(approx(rateXperQuote(m, DIVINE, CHAOS), 1127.5))
})

test('rateXperQuote: swapped lo/hi order -> same ~1127 (no ordering assumption)', () => {
  const m = mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 1300 }, { [DIVINE]: 1, [CHAOS]: 955 },
    { [DIVINE]: 10, [CHAOS]: 1000 })
  assert.ok(approx(rateXperQuote(m, DIVINE, CHAOS), 1127.5))
})

test('rateXperQuote: sub-1c {Chaos:1, X:7} -> ~0.143', () => {
  const m = mk([X, CHAOS], { [X]: 7, [CHAOS]: 1 }, { [X]: 7, [CHAOS]: 1 },
    { [X]: 5, [CHAOS]: 100 })
  assert.ok(approx(rateXperQuote(m, X, CHAOS), 1 / 7))
})

test('rateXperQuote: non-normalised {Chaos:3, X:2} -> 1.5', () => {
  const m = mk([X, CHAOS], { [X]: 2, [CHAOS]: 3 }, { [X]: 2, [CHAOS]: 3 },
    { [X]: 5, [CHAOS]: 100 })
  assert.equal(rateXperQuote(m, X, CHAOS), 1.5)
})

test('rateXperQuote: spread beyond limit (1c vs 100c) -> null', () => {
  const m = mk([X, CHAOS], { [X]: 1, [CHAOS]: 1 }, { [X]: 1, [CHAOS]: 100 },
    { [X]: 5, [CHAOS]: 100 })
  assert.equal(rateXperQuote(m, X, CHAOS), null)
})

test('rateXperQuote: quote-side volume below floor (chaos 49) -> null', () => {
  const m = mk([X, CHAOS], { [X]: 1, [CHAOS]: 5 }, { [X]: 1, [CHAOS]: 5 },
    { [X]: 5, [CHAOS]: 49 })
  assert.equal(rateXperQuote(m, X, CHAOS), null)
})

test('rateXperQuote: expensive item, X-volume 2 but chaos-side 5000 -> priced (floor is quote-side only)', () => {
  const m = mk([X, CHAOS], { [X]: 1, [CHAOS]: 3000 }, { [X]: 1, [CHAOS]: 3000 },
    { [X]: 2, [CHAOS]: 5000 })
  assert.equal(rateXperQuote(m, X, CHAOS), 3000)
})

test('rateXperQuote: missing X-side volume (0) -> null', () => {
  const m = mk([X, CHAOS], { [X]: 1, [CHAOS]: 5 }, { [X]: 1, [CHAOS]: 5 },
    { [CHAOS]: 100 })
  assert.equal(rateXperQuote(m, X, CHAOS), null)
})

// ---------------------------------------------------------------------------
// chaosByName end-to-end — fake multi-hour feed.
// ---------------------------------------------------------------------------
const ID = {
  itemA: 'Metadata/Items/Currency/ItemA',
  itemB: 'Metadata/Items/Currency/ItemB',
  itemY: 'Metadata/Items/Currency/ItemY',
  empty: 'Metadata/Items/Currency/EmptyName',
  unknown: 'Metadata/Items/Currency/UnknownXYZ',
  hcOnly: 'Metadata/Items/Currency/HardcoreOnly'
}

const baseNames = {
  byId: new Map([
    [CHAOS, 'Chaos Orb'],
    [DIVINE, 'Divine Orb'],
    [ID.itemA, 'Item A'],
    [ID.itemB, 'Item B'],
    [ID.itemY, 'Item Y'],
    [ID.empty, ''], // RePoE placeholder empty name -> must be skipped
    [ID.hcOnly, 'Hardcore Only']
    // ID.unknown intentionally absent -> coverage gap, skipped
  ]),
  byName: new Map()
}

const NOW = 10 * 3600 + 42 // lastHour = 9*3600
const HOUR_NEW = lastHour(NOW) // 9*3600
const HOUR_OLD = HOUR_NEW - 3600 // 8*3600

// Newest hour: Divine<->Chaos (chaosPerDivine=100), ItemA@10, ItemY via divine,
// EmptyName@5, UnknownXYZ@3, plus a Hardcore-league market (must be filtered).
const feedNew = [
  mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 1, [CHAOS]: 100 },
    { [DIVINE]: 10, [CHAOS]: 1000 }),
  mk([ID.itemA, CHAOS], { [ID.itemA]: 1, [CHAOS]: 10 }, { [ID.itemA]: 1, [CHAOS]: 10 },
    { [ID.itemA]: 5, [CHAOS]: 1000 }),
  mk([ID.itemY, DIVINE], { [ID.itemY]: 1, [DIVINE]: 2 }, { [ID.itemY]: 1, [DIVINE]: 2 },
    { [ID.itemY]: 3, [DIVINE]: 10 }),
  mk([ID.empty, CHAOS], { [ID.empty]: 1, [CHAOS]: 5 }, { [ID.empty]: 1, [CHAOS]: 5 },
    { [ID.empty]: 5, [CHAOS]: 500 }),
  mk([ID.unknown, CHAOS], { [ID.unknown]: 1, [CHAOS]: 3 }, { [ID.unknown]: 1, [CHAOS]: 3 },
    { [ID.unknown]: 5, [CHAOS]: 500 }),
  mk([ID.hcOnly, CHAOS], { [ID.hcOnly]: 1, [CHAOS]: 77 }, { [ID.hcOnly]: 1, [CHAOS]: 77 },
    { [ID.hcOnly]: 5, [CHAOS]: 500 }, 'Hardcore')
]

// Older hour: ItemA@20 (must LOSE to newest 10), plus ItemB@50 (only here -> union keeps it).
const feedOld = [
  mk([ID.itemA, CHAOS], { [ID.itemA]: 1, [CHAOS]: 20 }, { [ID.itemA]: 1, [CHAOS]: 20 },
    { [ID.itemA]: 5, [CHAOS]: 1000 }),
  mk([ID.itemB, CHAOS], { [ID.itemB]: 1, [CHAOS]: 50 }, { [ID.itemB]: 1, [CHAOS]: 50 },
    { [ID.itemB]: 5, [CHAOS]: 1000 })
]

const makeDeps = (extra = {}) => ({
  now: () => NOW,
  baseNames,
  fetchHour: async id => {
    if (id === HOUR_NEW) return { next_change_id: id + 1, markets: feedNew }
    if (id === HOUR_OLD) return { next_change_id: id + 1, markets: feedOld }
    return null // any other (older) hour: absent -> step back
  },
  ...extra
})

test('chaosByName: multi-hour union, newest-wins, divine-bridge, league filter, skips', async () => {
  const p = createFaustusPricer({ league: 'Standard', deps: makeDeps() })
  const m = await p.chaosByName()

  assert.equal(m.get('Chaos Orb'), 1) // chaos itself = 1
  assert.equal(m.get('Divine Orb'), 100) // divine priced via its chaos market
  assert.equal(m.get('Item A'), 10) // newest hour (10) beats older (20)
  assert.equal(m.get('Item B'), 50) // only in older hour -> union keeps it
  assert.equal(m.get('Item Y'), 200) // divine bridge: 2 divine * 100 chaos/divine

  assert.equal(m.has(''), false) // empty RePoE name skipped
  assert.equal(m.has('Hardcore Only'), false) // wrong league filtered out
  assert.equal(m.has('UnknownXYZ'), false) // unmapped metadata skipped
})

const dualPricer = markets => createFaustusPricer({
  league: 'Standard',
  deps: {
    now: () => NOW,
    baseNames: { byId: new Map([[CHAOS, 'Chaos Orb'], [DIVINE, 'Divine Orb'], ['Metadata/Items/Currency/CurrencyDual', 'Dual Item'], ['Metadata/Items/DivinationCards/DivinationCardThin', 'Thin Card'], ['Metadata/Items/DivinationCards/DivinationCardCheap', 'Cheap Card']]) },
    fetchHour: async id => (id === HOUR_NEW ? { next_change_id: id + 1, markets } : null)
  }
})
const CD100 = mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 50, [CHAOS]: 5000 })

test('dual-traded items: the volume-weighted own chaos market beats the bridge', async () => {
  // This case (spread 5 -> midpoint discarded) used to run over the divine
  // bridge and came out at 5c. Now that the volume-weighted rate is the primary
  // estimator, the item's OWN chaos market prices it: 3000c / 900 units =
  // 3.33c, inside the observed range 2..10 — closer to what the hour actually
  // traded at than a detour via divine.
  const X = 'Metadata/Items/Currency/CurrencyDual'
  const m = await dualPricer([
    CD100,
    // chaos market is liquid, but spread 5 -> midpoint discarded. Range 2..10c.
    mk([X, CHAOS], { [X]: 1, [CHAOS]: 2 }, { [X]: 1, [CHAOS]: 10 }, { [X]: 900, [CHAOS]: 3000 }),
    // Divine side deliberately WELL attested (400 units, 60 divine = 6000c
    // turnover). The point of this test is that a liquid chaos market wins on
    // its own merits — not because the divine side happened to miss a floor.
    mk([X, DIVINE], { [X]: 20, [DIVINE]: 1 }, { [X]: 20, [DIVINE]: 1 }, { [X]: 400, [DIVINE]: 60 })
  ]).detailByName()
  assert.ok(approx(m.get('Dual Item').chaos, 3000 / 900, 1e-9))
  assert.deepEqual([m.get('Dual Item').min, m.get('Dual Item').max], [2, 10], 'range comes raw from the chaos market')
})

test('a one-trade chaos market loses to a liquid divine one', async () => {
  // The Progeny of Lunaris case: ONE chaos trade beside a divine market of 40
  // cards. The single trade used to set the price (6.4 div against a real
  // ~12.4). Chaos side here: 1 unit for 1132c. Divine side: 40 units, 494
  // divine turnover -> attested. Expect the bridge, and the range with it.
  const X = 'Metadata/Items/DivinationCards/DivinationCardThin'
  const m = await dualPricer([
    CD100,
    mk([X, CHAOS], { [X]: 1, [CHAOS]: 1132 }, { [X]: 1, [CHAOS]: 1132 }, { [X]: 1, [CHAOS]: 1132 }),
    mk([X, DIVINE], { [X]: 1, [DIVINE]: 12 }, { [X]: 1, [DIVINE]: 13 }, { [X]: 40, [DIVINE]: 494 })
  ]).detailByName()
  const d = m.get('Thin Card')
  assert.ok(d.chaos > 1132, `the single 1132c trade must not win, got ${d.chaos}`)
  assert.ok(approx(d.chaos, (494 / 40) * 100, 1e-9), 'priced off the divine market, bridged at C:D')
  // The range has to describe the market the price came from, or the headline
  // sits outside its own band in the UI.
  assert.ok(d.chaos >= d.min && d.chaos <= d.max, `${d.chaos} outside ${d.min}..${d.max}`)
})

test('an expensive divine market bridges on turnover, though it is short of the unit floor', async () => {
  // The Father's Love case. The bridge gate used to demand full isAttested() on
  // the divine side, unit floor included, and this card missed it by 3: 7 cards
  // traded for 305 divine. So a lone 153-chaos sale set the price of a card
  // worth ~8500 chaos — a 98% underpricing, and a CONFIDENT one, which is worse
  // than none because it blocks the poe.ninja fallback an unpriced item gets.
  // Its turnover clears the bar 11.8x over; only the flat item count stood in
  // the way, and a flat item count is exactly what punishes expensive items.
  const X = 'Metadata/Items/DivinationCards/DivinationCardThin'
  const m = await dualPricer([
    CD100,
    mk([X, CHAOS], { [X]: 1, [CHAOS]: 153 }, { [X]: 1, [CHAOS]: 153 }, { [X]: 1, [CHAOS]: 153 }),
    mk([X, DIVINE], { [X]: 1, [DIVINE]: 43 }, { [X]: 1, [DIVINE]: 44 }, { [X]: 7, [DIVINE]: 305 })
  ]).detailByName()
  const d = m.get('Thin Card')
  assert.ok(d.chaos > 153, `the single 153c sale must not win, got ${d.chaos}`)
  assert.ok(approx(d.chaos, (305 / 7) * 100, 1e-9), 'priced off the divine market, bridged at C:D')
})

test('a divine market with many units but little turnover must NOT bridge', async () => {
  // The other half of dropping the unit floor: it must not let the cases back in
  // that the measurement table in sell-side.mjs calls bogus. Rogue's Marker is
  // the sharpest of them — 715000 units traded for 1918 chaos of turnover, a
  // shape that sails past ANY unit floor and is caught only by turnover. With
  // C:D 100 here: 19 divine = 1900 chaos, under the 5000 bar, so the bridge must
  // stay shut and the chaos market keeps the price.
  const X = 'Metadata/Items/DivinationCards/DivinationCardThin'
  const m = await dualPricer([
    CD100,
    mk([X, CHAOS], { [X]: 1, [CHAOS]: 100 }, { [X]: 1, [CHAOS]: 100 }, { [X]: 60, [CHAOS]: 6000 }),
    mk([X, DIVINE], { [X]: 1, [DIVINE]: 0.0000266 }, { [X]: 1, [DIVINE]: 0.0000266 }, { [X]: 715000, [DIVINE]: 19 })
  ]).detailByName()
  assert.ok(approx(m.get('Thin Card').chaos, 100, 1e-9), 'the thin-turnover divine side must not take over')
})

test('a cheap but liquid chaos market keeps the price', async () => {
  // Regression guard for the first attempt at the above, which demanded full
  // isAttested() on the chaos side — including 5000c of turnover. That bar is
  // price-dependent and fails cheap markets for being cheap: Desecrated Virtue
  // trades a steady 220-275c but would need ~22 sales an hour to clear it, and
  // got bridged through a coarse divine market to 524c against a real 230c.
  // 6 units at ~220c: few in turnover, plenty in units -> chaos must stay.
  // Still the guard under the RELATIVE gate: 13 divine units against 12 chaos
  // units is not 3x better evidenced, so the bridge must not take over either.
  const X = 'Metadata/Items/DivinationCards/DivinationCardCheap'
  const m = await dualPricer([
    CD100,
    mk([X, CHAOS], { [X]: 1, [CHAOS]: 220 }, { [X]: 1, [CHAOS]: 221 }, { [X]: 12, [CHAOS]: 2646 }),
    mk([X, DIVINE], { [X]: 1, [DIVINE]: 2 }, { [X]: 1, [DIVINE]: 3 }, { [X]: 13, [DIVINE]: 37 })
  ]).detailByName()
  const d = m.get('Cheap Card')
  assert.ok(approx(d.chaos, 2646 / 12, 1e-9), `chaos market must keep it, got ${d.chaos}`)
})

test('the gate is RELATIVE: a chaos market above the old unit floor can still lose', async () => {
  // The One Last Score class, and the reason the absolute "chaos < 10 units"
  // gate was replaced: a chaos market can clear any absolute floor and still be
  // the worse-evidenced side. 30 chaos units against 100 divine units is 3.3x,
  // so the divine side takes it. The old absolute gate never fired here at all.
  const X = 'Metadata/Items/DivinationCards/DivinationCardThin'
  const m = await dualPricer([
    CD100,
    // 30 units, range 150..160c -> volume-weighted 4650/30 = 155c.
    mk([X, CHAOS], { [X]: 1, [CHAOS]: 150 }, { [X]: 1, [CHAOS]: 160 }, { [X]: 30, [CHAOS]: 4650 }),
    // 100 units, 190 divine turnover -> attested, 1.9 div = 190c per card.
    mk([X, DIVINE], { [X]: 10, [DIVINE]: 19 }, { [X]: 10, [DIVINE]: 19 }, { [X]: 100, [DIVINE]: 190 })
  ]).detailByName()
  assert.ok(approx(m.get('Thin Card').chaos, 190, 1e-9),
    `the better-evidenced divine side must win, got ${m.get('Thin Card').chaos}`)
})

test('the gate is RELATIVE: a small chaos market survives a not-much-better divine one', async () => {
  // The Desecrated Virtue case the absolute gate got wrong: 6 chaos units is
  // below the old 10-unit floor, so the bridge used to take over and produced
  // 524c against a real ~240c. The divine side carries 15 units — attested, but
  // only 2.5x the chaos units, i.e. not 3x -> the chaos market keeps the price.
  const X = 'Metadata/Items/DivinationCards/DivinationCardCheap'
  const m = await dualPricer([
    CD100,
    mk([X, CHAOS], { [X]: 1, [CHAOS]: 220 }, { [X]: 1, [CHAOS]: 221 }, { [X]: 6, [CHAOS]: 1320 }),
    // 15 units, 60 divine turnover -> attested, and would bridge to 400c.
    mk([X, DIVINE], { [X]: 1, [DIVINE]: 4 }, { [X]: 1, [DIVINE]: 4 }, { [X]: 15, [DIVINE]: 60 })
  ]).detailByName()
  assert.ok(approx(m.get('Cheap Card').chaos, 220, 1e-9),
    `a small but near-perfect chaos market must keep it, got ${m.get('Cheap Card').chaos}`)
})

test('a single-trade chaos envelope does not veto the bridge (The Fiend case)', async () => {
  // The envelope used to be built from the newest informative hour alone, and
  // in 926 of 1402 firings that was a single chaos trade — min === max. It then
  // vetoed the very bridge that was replacing it: The Fiend kept 121c (89% off)
  // while the bridge would have said 1059c against a real 1107c. A degenerate
  // envelope is no evidence, so it is ignored; the bridge goes through.
  const X = 'Metadata/Items/DivinationCards/DivinationCardThin'
  const m = await dualPricer([
    CD100,
    // ONE chaos trade at 121c -> envelope would be the point 121..121, whose
    // 4x band [30.25, 484] excludes the 1000c bridge.
    mk([X, CHAOS], { [X]: 1, [CHAOS]: 121 }, { [X]: 1, [CHAOS]: 121 }, { [X]: 1, [CHAOS]: 121 }),
    mk([X, DIVINE], { [X]: 1, [DIVINE]: 10 }, { [X]: 1, [DIVINE]: 10 }, { [X]: 30, [DIVINE]: 300 })
  ]).detailByName()
  assert.ok(approx(m.get('Thin Card').chaos, 1000, 1e-9),
    `a point envelope must not veto its own replacement, got ${m.get('Thin Card').chaos}`)
})

test('the plausibility envelope spans the whole union window, not just the newest hour', async () => {
  // The envelope for the bridge-takeover is the chaos range ALL walked hours
  // together spanned. Newest hour alone says 100..110c, whose 4x band
  // [25, 440] would reject the 3000c bridge; an older hour in the same window
  // shows the market ranging up to 900c, so the union band [25, 3600] accepts
  // it. The price itself still comes from the newest hour's market.
  const X = 'Metadata/Items/Currency/CurrencyDual'
  const names = { byId: new Map([[CHAOS, 'Chaos Orb'], [DIVINE, 'Divine Orb'], [X, 'Dual Item']]) }
  const newest = [
    CD100,
    mk([X, CHAOS], { [X]: 1, [CHAOS]: 100 }, { [X]: 1, [CHAOS]: 110 }, { [X]: 10, [CHAOS]: 1050 }),
    mk([X, DIVINE], { [X]: 1, [DIVINE]: 30 }, { [X]: 1, [DIVINE]: 30 }, { [X]: 60, [DIVINE]: 1800 })
  ]
  const older = [mk([X, CHAOS], { [X]: 1, [CHAOS]: 100 }, { [X]: 1, [CHAOS]: 900 }, { [X]: 5, [CHAOS]: 2000 })]
  const build = feedOlder => createFaustusPricer({
    league: 'Standard',
    deps: {
      now: () => NOW,
      baseNames: names,
      fetchHour: async id => {
        if (id === HOUR_NEW) return { next_change_id: id + 1, markets: newest }
        if (id === HOUR_OLD) return { next_change_id: id + 1, markets: feedOlder }
        return null
      }
    }
  }).chaosByName()

  const withHistory = await build(older)
  assert.ok(approx(withHistory.get('Dual Item'), 3000, 1e-9),
    `the union envelope must accept the bridge, got ${withHistory.get('Dual Item')}`)
  // Without that older hour the window only ever saw 100..110c, and the same
  // bridge is out of band -> the chaos market keeps it. This is the control:
  // the envelope is still doing work, it is just no longer a single point.
  const withoutHistory = await build([])
  assert.ok(approx(withoutHistory.get('Dual Item'), 105, 1e-9),
    `out-of-band bridge must be rejected, got ${withoutHistory.get('Dual Item')}`)
})

test('dual-traded items keep the divine bridge (lifeforce case)', async () => {
  // Counter-check to the Regal regression: Harvest lifeforce & co. legitimately
  // trade in BOTH currencies. A noisy chaos market must NOT veto the bridge —
  // as long as the bridged price fits the observed chaos range.
  const X = 'Metadata/Items/Currency/CurrencyDual'
  const m = await dualPricer([
    CD100,
    // chaos market: spread 5 -> midpoint discarded, AND the volume ratio
    // (300/900 = 0.33) sits outside the range 2..10 -> nothing volume-weighted
    // either. That leaves the bridge.
    mk([X, CHAOS], { [X]: 1, [CHAOS]: 2 }, { [X]: 1, [CHAOS]: 10 }, { [X]: 900, [CHAOS]: 300 }),
    // divine market with real volume: 1 divine per 20 X -> 5c. Fits into 2..10.
    mk([X, DIVINE], { [X]: 20, [DIVINE]: 1 }, { [X]: 20, [DIVINE]: 1 }, { [X]: 400, [DIVINE]: 40 })
  ]).chaosByName()
  assert.equal(m.get('Dual Item'), 5, 'plausible bridge was wrongly discarded')
})

test('the bridge over the VOLUME-WEIGHTED divine rate is envelope-checked too', async () => {
  // The Regal case must not come back through the new bridge variant: the
  // volume-weighted divine rate has to be checked against the raw chaos range
  // as well. Chaos range here is 0.2..1.0c, the bridge would give 15c (75x too
  // high) -> discard instead of pricing.
  const X = 'Metadata/Items/Currency/CurrencyDual'
  const m = await dualPricer([
    CD100,
    // chaos market: spread 5 -> midpoint gone; volume 400/8000 = 0.05 is below
    // the range 0.2..1.0 -> nothing volume-weighted either.
    mk([X, CHAOS], { [X]: 5, [CHAOS]: 1 }, { [X]: 1, [CHAOS]: 1 }, { [X]: 8000, [CHAOS]: 400 }),
    // divine market: range is 1 divine per 20..5 X, the volumes say
    // 30/200 = 0.15 divine per X = 15c. The extremes midpoint (0.125 -> 12.5c)
    // is just as implausible -> both bridge variants must fail.
    mk([X, DIVINE], { [X]: 20, [DIVINE]: 1 }, { [X]: 5, [DIVINE]: 1 }, { [X]: 200, [DIVINE]: 30 })
  ]).chaosByName()
  assert.equal(m.has('Dual Item'), false, 'implausible volume-weighted bridge was accepted')
})

test('regression: implausible divine bridge is discarded (Regal Orb case)', async () => {
  // Real case: the Regal Orb chaos market (3095 chaos traded, range 0.2..1.0c)
  // fell through the spread guard; the bridge then took a divine market and
  // produced 5.67c — far outside anything the chaos market ever showed. The
  // plausibility envelope has to catch that (divine volume here deliberately
  // ABOVE the floor, so that the envelope is what bites, not the floor).
  const X = 'Metadata/Items/Currency/CurrencyUpgradeMagicToRare'
  const names = { byId: new Map([[CHAOS, 'Chaos Orb'], [DIVINE, 'Divine Orb'], [X, 'Regal Orb']]) }
  const markets = [
    mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 50, [CHAOS]: 5000 }),
    // Regal<->Chaos: LIQUID (3095), but spread 5 -> discarded.
    mk([X, CHAOS], { [X]: 5, [CHAOS]: 1 }, { [X]: 1, [CHAOS]: 1 }, { [X]: 8853, [CHAOS]: 3095 }),
    // Regal<->Divine: a single trade, lo === hi ("perfect" spread of 1.0).
    mk([X, DIVINE], { [X]: 15, [DIVINE]: 1 }, { [X]: 15, [DIVINE]: 1 }, { [X]: 30, [DIVINE]: 20 })
  ]
  const p = createFaustusPricer({
    league: 'Standard',
    deps: { now: () => NOW, baseNames: names, fetchHour: async id => (id === HOUR_NEW ? { next_change_id: id + 1, markets } : null) }
  })
  const m = await p.chaosByName()
  // The requirement is "NOT 5.67c via the bridge", not "not priced at all".
  // Since the volume-weighted last resort exists, Regal falls back to its OWN
  // chaos market: 3095 chaos / 8853 Regal = 0.3496c, inside the observed range
  // 0.2..1.0 and in line with the real Regal price.
  assert.ok(approx(m.get('Regal Orb'), 3095 / 8853, 1e-9),
    'Regal must come volume-weighted from its OWN chaos market')
  assert.ok(m.get('Regal Orb') < 1.0, 'priced via the divine bridge -> 34x too high')
})

test('volume-weighted is the primary estimator, the midpoint is the fallback', async () => {
  const XC = 'Metadata/Items/Currency/CurrencyCheap'
  const names = { byId: new Map([[CHAOS, 'Chaos Orb'], [DIVINE, 'Divine Orb'], [XC, 'Cheap Item']]) }
  const cd = mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 50, [CHAOS]: 5000 })
  const build = async (xm) => {
    const p = createFaustusPricer({
      league: 'Standard',
      deps: { now: () => NOW, baseNames: names, fetchHour: async id => (id === HOUR_NEW ? { next_change_id: id + 1, markets: [cd, xm] } : null) }
    })
    return (await p.chaosByName()).get('Cheap Item')
  }

  // Spread 4 -> the midpoint would be derivable ((0.5+2)/2 = 1.25), but the
  // volume ratio (600c / 300 units = 2) wins: the midpoint is the mean of the
  // hour's two EXTREMES and can come from two single trades (703 Allflame
  // markets: median spread 2.0, p90 5.0), while the volume ratio is the average
  // that was actually traded.
  assert.equal(await build(
    mk([XC, CHAOS], { [XC]: 2, [CHAOS]: 1 }, { [XC]: 1, [CHAOS]: 2 }, { [XC]: 300, [CHAOS]: 600 })
  ), 2, 'volume-weighted must beat the extremes midpoint')

  // Spread 6 (integer quantisation of a sub-chaos item) -> midpoint discarded
  // anyway, volume prices it: 600/300 = 2c, inside 0.333..2.
  assert.equal(await build(
    mk([XC, CHAOS], { [XC]: 3, [CHAOS]: 1 }, { [XC]: 1, [CHAOS]: 2 }, { [XC]: 300, [CHAOS]: 600 })
  ), 2, 'spread-rejected item must still be priced volume-weighted')

  // volume ratio outside the band of extremes -> do not trust it.
  assert.equal(await build(
    mk([XC, CHAOS], { [XC]: 3, [CHAOS]: 1 }, { [XC]: 1, [CHAOS]: 2 }, { [XC]: 100, [CHAOS]: 900 })
  ), undefined, 'inconsistent volume must not price anything')

  // the quote volume floor applies here too (chaos floor 50).
  assert.equal(await build(
    mk([XC, CHAOS], { [XC]: 3, [CHAOS]: 1 }, { [XC]: 1, [CHAOS]: 2 }, { [XC]: 20, [CHAOS]: 40 })
  ), undefined, 'below the quote volume floor nothing may be priced')
})

test('divine volume floor: a single trade (2 divine) is no longer enough', async () => {
  // Measured: 74 divine markets in this league, median volume 5; real divine
  // goods sit at 237-429. The old floor of 2 let single trades through.
  const X = 'Metadata/Items/Currency/CurrencyThin'
  const names = { byId: new Map([[CHAOS, 'Chaos Orb'], [DIVINE, 'Divine Orb'], [X, 'Thin Item']]) }
  const base = mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 50, [CHAOS]: 5000 })
  const build = async (divVol) => {
    const markets = [base, mk([X, DIVINE], { [X]: 1, [DIVINE]: 2 }, { [X]: 1, [DIVINE]: 2 }, { [X]: 5, [DIVINE]: divVol })]
    const p = createFaustusPricer({
      league: 'Standard',
      deps: { now: () => NOW, baseNames: names, fetchHour: async id => (id === HOUR_NEW ? { next_change_id: id + 1, markets } : null) }
    })
    return (await p.chaosByName()).get('Thin Item')
  }
  assert.equal(await build(2), undefined, 'single-trade divine market was accepted')
  assert.equal(await build(40), 200, 'a real divine market (40) must still bridge')
})

test('chaosForName: known name -> chaos, unknown -> null', async () => {
  const p = createFaustusPricer({ league: 'Standard', deps: makeDeps() })
  assert.equal(await p.chaosForName('Item A'), 10)
  assert.equal(await p.chaosForName('Item Y'), 200)
  assert.equal(await p.chaosForName('Does Not Exist'), null)
})

test('chaosByName: step-back when the newest hour is not ready', async () => {
  // Newest hour returns "not ready" via next_change_id === id; the real data is
  // one hour older. Union must step back and still price everything.
  const deps = {
    now: () => NOW,
    baseNames,
    fetchHour: async id => {
      if (id === HOUR_NEW) return { next_change_id: id, markets: [] } // not ready (empty + self-ref)
      if (id === HOUR_OLD) return { next_change_id: id + 1, markets: feedNew }
      return null
    }
  }
  const p = createFaustusPricer({ league: 'Standard', deps })
  const m = await p.chaosByName()
  assert.equal(m.get('Item A'), 10)
  assert.equal(m.get('Divine Orb'), 100)
})

test('chaosByName: Divine<->Chaos market absent -> chaosPerDivineFallback used for the bridge', async () => {
  // Only ItemY<->Divine exists (no Divine<->Chaos market this window).
  const deps = {
    now: () => NOW,
    baseNames,
    chaosPerDivineFallback: 150,
    fetchHour: async id => {
      if (id === HOUR_NEW) {
        return {
          next_change_id: id + 1,
          markets: [
            mk([ID.itemY, DIVINE], { [ID.itemY]: 1, [DIVINE]: 2 }, { [ID.itemY]: 1, [DIVINE]: 2 },
              { [ID.itemY]: 3, [DIVINE]: 10 })
          ]
        }
      }
      return null
    }
  }
  const p = createFaustusPricer({ league: 'Standard', deps })
  const m = await p.chaosByName()
  assert.equal(m.get('Item Y'), 300) // 2 divine * 150 fallback chaos/divine
  assert.equal(m.get('Chaos Orb'), 1) // chaos still anchored at 1
})

test('chaosByName: chaosPerDivineFallback as a (live) async function -> resolved for the bridge', async () => {
  // Task 4: server.mjs passes a function through (live poe.ninja divine
  // chaosEquivalent) instead of a constant. No Divine<->Chaos market -> the
  // function supplies 120.
  const deps = {
    now: () => NOW,
    baseNames,
    chaosPerDivineFallback: async () => 120,
    fetchHour: async id => id === HOUR_NEW
      ? {
          next_change_id: id + 1,
          markets: [
            mk([ID.itemY, DIVINE], { [ID.itemY]: 1, [DIVINE]: 2 }, { [ID.itemY]: 1, [DIVINE]: 2 },
              { [ID.itemY]: 3, [DIVINE]: 10 })
          ]
        }
      : null
  }
  const p = createFaustusPricer({ league: 'Standard', deps })
  const m = await p.chaosByName()
  assert.equal(m.get('Item Y'), 240) // 2 divine * 120 live chaos/divine
})

test('chaosByName: no C:D market AND no fallback -> divine bridge skipped (not 0/NaN)', async () => {
  // Without a Divine<->Chaos market and without a fallback the divine-bridged
  // entry stays unpriced (the ninja fallback in the valuator takes over)
  // instead of being priced with a bogus ratio (null -> 0/NaN).
  const deps = {
    now: () => NOW,
    baseNames,
    // chaosPerDivineFallback deliberately NOT set
    fetchHour: async id => id === HOUR_NEW
      ? {
          next_change_id: id + 1,
          markets: [
            mk([ID.itemY, DIVINE], { [ID.itemY]: 1, [DIVINE]: 2 }, { [ID.itemY]: 1, [DIVINE]: 2 },
              { [ID.itemY]: 3, [DIVINE]: 10 })
          ]
        }
      : null
  }
  const p = createFaustusPricer({ league: 'Standard', deps })
  const m = await p.chaosByName()
  assert.equal(m.has('Item Y'), false) // bridge skipped -> unpriced
})

// ---------------------------------------------------------------------------
// detailByName — price + the range the hour actually spanned.
// ---------------------------------------------------------------------------
test('detailByName: range comes raw from the chaos market, chaosByName stays compatible', async () => {
  const XR = 'Metadata/Items/Currency/CurrencyRanged'
  const names = { byId: new Map([[CHAOS, 'Chaos Orb'], [DIVINE, 'Divine Orb'], [XR, 'Ranged Item']]) }
  const markets = [
    mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 50, [CHAOS]: 5000 }),
    // 10..17c over the hour, volume-weighted 13600/1000 = 13.6 (Memory of Reverence case).
    mk([XR, CHAOS], { [XR]: 1, [CHAOS]: 17 }, { [XR]: 1, [CHAOS]: 10 }, { [XR]: 1000, [CHAOS]: 13600 })
  ]
  const p = createFaustusPricer({
    league: 'Standard',
    deps: { now: () => NOW, baseNames: names, fetchHour: async id => (id === HOUR_NEW ? { next_change_id: id + 1, markets } : null) }
  })
  const d = await p.detailByName()
  assert.ok(approx(d.get('Ranged Item').chaos, 13.6, 1e-9))
  assert.deepEqual([d.get('Ranged Item').min, d.get('Ranged Item').max], [10, 17])
  // chaos itself: anchored at 1, but no range.
  assert.equal(d.get('Chaos Orb').chaos, 1)
  assert.equal(d.get('Chaos Orb').min, undefined)
  // thin wrapper: identical to the old signature.
  const m = await p.chaosByName()
  assert.ok(approx(m.get('Ranged Item'), 13.6, 1e-9))
  assert.equal(await p.chaosForName('Ranged Item') > 0, true)
})

test('detailByName: priced via the bridge only -> range from the divine market times C:D', async () => {
  const XB = 'Metadata/Items/Currency/CurrencyBridgedOnly'
  const names = { byId: new Map([[CHAOS, 'Chaos Orb'], [DIVINE, 'Divine Orb'], [XB, 'Bridged Item']]) }
  const markets = [
    mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 1, [CHAOS]: 100 }, { [DIVINE]: 50, [CHAOS]: 5000 }),
    // no chaos market. 2..3 divine per unit -> 200..300c, midpoint 250c.
    mk([XB, DIVINE], { [XB]: 1, [DIVINE]: 2 }, { [XB]: 1, [DIVINE]: 3 }, { [XB]: 4, [DIVINE]: 40 })
  ]
  const p = createFaustusPricer({
    league: 'Standard',
    deps: { now: () => NOW, baseNames: names, fetchHour: async id => (id === HOUR_NEW ? { next_change_id: id + 1, markets } : null) }
  })
  const d = (await p.detailByName()).get('Bridged Item')
  assert.equal(d.chaos, 250)
  assert.deepEqual([d.min, d.max], [200, 300])
})

test('detailByName: a degenerate range (min === max) is omitted instead of guessed', async () => {
  const XF = 'Metadata/Items/Currency/CurrencyFlat'
  const names = { byId: new Map([[CHAOS, 'Chaos Orb'], [XF, 'Flat Item']]) }
  const markets = [
    mk([XF, CHAOS], { [XF]: 1, [CHAOS]: 5 }, { [XF]: 1, [CHAOS]: 5 }, { [XF]: 20, [CHAOS]: 100 })
  ]
  const p = createFaustusPricer({
    league: 'Standard',
    deps: { now: () => NOW, baseNames: names, fetchHour: async id => (id === HOUR_NEW ? { next_change_id: id + 1, markets } : null) }
  })
  const d = (await p.detailByName()).get('Flat Item')
  assert.equal(d.chaos, 5)
  assert.equal(d.min, undefined)
  assert.equal(d.max, undefined)
})

// ---------------------------------------------------------------------------
// Empty entries (idle-hour placeholders) must not poison the union — real case
// "The Jeweller's Boon", Allflame league, 29.07.2026.
// ---------------------------------------------------------------------------
test('isInformativeMarket: an all-zero entry is useless, ratio OR volume makes it usable', () => {
  const XI = 'Metadata/Items/Currency/CurrencyInfo'
  // everything 0 -> carries no information.
  assert.equal(isInformativeMarket(
    mk([XI, CHAOS], { [XI]: 0, [CHAOS]: 0 }, { [XI]: 0, [CHAOS]: 0 }, { [XI]: 0, [CHAOS]: 0 })), false)
  // ratio derivable -> usable (even without volume).
  assert.equal(isInformativeMarket(
    mk([XI, CHAOS], { [XI]: 1, [CHAOS]: 1 }, { [XI]: 1, [CHAOS]: 1 }, { [XI]: 0, [CHAOS]: 0 })), true)
  // volume only -> usable.
  assert.equal(isInformativeMarket(
    mk([XI, CHAOS], { [XI]: 0, [CHAOS]: 0 }, { [XI]: 0, [CHAOS]: 0 }, { [XI]: 3, [CHAOS]: 3 })), true)
  // broken shapes -> unusable, never throw.
  assert.equal(isInformativeMarket(null), false)
  assert.equal(isInformativeMarket({}), false)
  assert.equal(isInformativeMarket({ market_pair: [XI, CHAOS] }), false)
  assert.equal(isInformativeMarket({ market_pair: [XI, CHAOS], volume_traded: 5 }), false)
})

// Card fixture taken from the live digest (hours 03..10, values 1:1 real).
const CARD = 'Metadata/Items/DivinationCards/DivinationCardJewellersBoon'
const cardNames = { byId: new Map([[CHAOS, 'Chaos Orb'], [DIVINE, 'Divine Orb'], [CARD, "The Jeweller's Boon"]]) }
const nullMarket = (a, b) => mk([a, b], { [a]: 0, [b]: 0 }, { [a]: 0, [b]: 0 }, { [a]: 0, [b]: 0 })
const cardPricer = (byHour, nowSec) => createFaustusPricer({
  league: 'Standard',
  deps: {
    now: () => nowSec,
    baseNames: cardNames,
    fetchHour: async id => (byHour[id] ? { next_change_id: id + 1, markets: byHour[id] } : null)
  }
})

test('union: an all-zero entry in the newest hour does not mask the real market', async () => {
  // Newest hour: placeholder (all 0). One hour older: a real 1:1 market with
  // volume. The real one must win -> 1c instead of unpriced.
  const now = 10 * 3600
  const byHour = {
    [9 * 3600]: [nullMarket(CARD, CHAOS)],
    [8 * 3600]: [mk([CARD, CHAOS], { [CARD]: 1, [CHAOS]: 1 }, { [CARD]: 1, [CHAOS]: 1 }, { [CARD]: 120, [CHAOS]: 120 })]
  }
  const m = await cardPricer(byHour, now).chaosByName()
  assert.equal(m.get("The Jeweller's Boon"), 1, 'all-zero entry masked the real market')
})

test("finding: The Jeweller's Boon no longer gets a 1400c price", async () => {
  // Live digest 29.07.2026: 10:00 chaos 1:1 (vol 4), 08/07/05 all-zero entries,
  // 04:00 chaos 1:1..1:2 (vol 10/12), 03:00 chaos 1:1 (vol 1) and a SINGLE
  // divine trade 1:10. The all-zero entry at 08:00 used to mask the chaos
  // history, so the bridge ran without an envelope and gave ~1467c (10.5 div).
  const now = 10 * 3600 // -> lastHour 09:00, and 09:00 is missing from the feed
  const cd = mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 147 }, { [DIVINE]: 1, [CHAOS]: 147 },
    { [DIVINE]: 1000, [CHAOS]: 147000 })
  const byHour = {
    [10 * 3600]: [cd, mk([CARD, CHAOS], { [CARD]: 1, [CHAOS]: 1 }, { [CARD]: 1, [CHAOS]: 1 }, { [CARD]: 4, [CHAOS]: 4 })],
    [8 * 3600]: [cd, nullMarket(CARD, CHAOS)],
    [7 * 3600]: [nullMarket(CARD, CHAOS)],
    [5 * 3600]: [nullMarket(CARD, CHAOS)],
    [4 * 3600]: [mk([CARD, CHAOS], { [CARD]: 1, [CHAOS]: 1 }, { [CARD]: 1, [CHAOS]: 2 }, { [CARD]: 10, [CHAOS]: 12 })],
    [3 * 3600]: [
      mk([CARD, CHAOS], { [CARD]: 1, [CHAOS]: 1 }, { [CARD]: 1, [CHAOS]: 1 }, { [CARD]: 1, [CHAOS]: 1 }),
      mk([CARD, DIVINE], { [CARD]: 1, [DIVINE]: 10 }, { [CARD]: 1, [DIVINE]: 10 }, { [CARD]: 1, [DIVINE]: 10 })
    ]
  }
  const d = await cardPricer(byHour, now).detailByName()
  const card = d.get("The Jeweller's Boon")
  // chaos volume (12) is below the floor of 50 -> no price; what matters is
  // that the bridge no longer kicks in (the valuator falls back to ninja).
  assert.equal(card, undefined, 'bridge priced the card at ~1400c again')
})

test('bridge without a chaos market: a single trade on the X side is not enough', async () => {
  // QUOTE_VOL_MIN[DIVINE] = 10 only checks the quote side; "10 divine turnover"
  // can be ONE trade. Without an envelope the bridge therefore needs more than
  // one X unit.
  const now = 10 * 3600
  const cd = mk([DIVINE, CHAOS], { [DIVINE]: 1, [CHAOS]: 147 }, { [DIVINE]: 1, [CHAOS]: 147 },
    { [DIVINE]: 1000, [CHAOS]: 147000 })
  const build = async volX => {
    const byHour = {
      [9 * 3600]: [cd, mk([CARD, DIVINE], { [CARD]: 1, [DIVINE]: 10 }, { [CARD]: 1, [DIVINE]: 10 },
        { [CARD]: volX, [DIVINE]: 10 * volX })]
    }
    return (await cardPricer(byHour, now).chaosByName()).get("The Jeweller's Boon")
  }
  assert.equal(await build(1), undefined, 'single-trade bridge without an envelope was accepted')
  assert.ok(approx(await build(2), 1470, 1e-9), 'bridge with two trades must still price')
})

test('a pair with nothing but all-zero entries stays unpriced (no crash)', async () => {
  const now = 10 * 3600
  const byHour = {
    [9 * 3600]: [nullMarket(CARD, CHAOS)],
    [8 * 3600]: [nullMarket(CARD, CHAOS)]
  }
  const m = await cardPricer(byHour, now).chaosByName()
  assert.equal(m.has("The Jeweller's Boon"), false)
  assert.equal(m.get('Chaos Orb'), 1)
})

// ---------------------------------------------------------------------------
// Cross-hour sanity check on the DIRECT chaos path (THIN_X_UNITS /
// DEEP_HOUR_VOL_RATIO / DEEP_HOUR_DISAGREE_RATIO in faustus.mjs): a thin
// winning hour's own QUOTE_VOL_MIN pass is self-validating (quote turnover =
// units * price, so the price under test buys its own credibility). Real
// case, live digest 2026-08-05 11:00 (hour 1785927600): Broken Truce "priced"
// at 22c off 3 cards for 66 chaos; poe.ninja said 6.4c, the trade-site ask
// was 1c/218 listings, GGG's own Currency Exchange showed "No Stock". The
// hour immediately before (10:00) the SAME card traded 61 units for 346
// chaos = 5.67c/card — 20x the volume, a fraction of the price.
// ---------------------------------------------------------------------------
const BT = 'Metadata/Items/DivinationCards/DivinationCardBrokenTruce'
const btNames = { byId: new Map([[CHAOS, 'Chaos Orb'], [DIVINE, 'Divine Orb'], [BT, 'Broken Truce']]) }
const btPricer = (byHour, nowSec) => createFaustusPricer({
  league: 'Standard',
  deps: {
    now: () => nowSec,
    baseNames: btNames,
    fetchHour: async id => (byHour[id] ? { next_change_id: byHour[id].next_change_id, markets: byHour[id] } : null)
  }
})

test('Broken Truce, real numbers: a thin winning hour (3 units) that disagrees with a materially deeper hour (61 units, one hour older) is abstained, not priced at 22c', async () => {
  const now = 12 * 3600 // -> lastHour 11:00, the exact winning hour from the live digest
  const byHour = {
    [11 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 22 }, { [BT]: 1, [CHAOS]: 22 }, { [BT]: 3, [CHAOS]: 66 })],
    [10 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 19 }, { [BT]: 1, [CHAOS]: 4 }, { [BT]: 61, [CHAOS]: 346 })]
  }
  const d = await btPricer(byHour, now).detailByName()
  assert.equal(d.get('Broken Truce'), undefined,
    'the thin, self-validated 22c hour must not win — better honestly unpriced (valuator falls back to poe.ninja) than confidently wrong')
})

test('a materially deeper hour that AGREES with the thin winning hour does not cause abstention', async () => {
  // Same volumes as the Broken Truce case (3 vs 61 units), but the deeper
  // hour traded at essentially the same rate (22 vs 21) -- no disagreement,
  // so the winning hour's own price must survive untouched.
  const now = 12 * 3600 // -> lastHour 11:00
  const byHour = {
    [11 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 22 }, { [BT]: 1, [CHAOS]: 22 }, { [BT]: 3, [CHAOS]: 66 })],
    [10 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 20 }, { [BT]: 1, [CHAOS]: 22 }, { [BT]: 61, [CHAOS]: 1281 })]
  }
  const d = await btPricer(byHour, now).detailByName()
  assert.ok(d.get('Broken Truce'), 'agreeing hours must not trigger abstention')
  assert.equal(d.get('Broken Truce').chaos, 22)
})

test('a deeper hour that disagrees but does not itself clear THIN_X_UNITS does not override (no blanket X-side floor)', async () => {
  // The deeper hour here has MORE volume than the winning hour (5 vs 3) and a
  // wildly different rate, but 5 units is still below THIN_X_UNITS=10 itself
  // -- "more evidence than a thin hour" is not the same as "enough evidence".
  // This is the guard the QUOTE_VOL_MIN comment warns about: a blanket
  // X-side floor would unprice legitimately thin, expensive items, so the
  // deeper hour must clear the SAME absolute bar, not just relatively beat
  // the winning hour.
  const now = 12 * 3600 // -> lastHour 11:00
  const byHour = {
    [11 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 22 }, { [BT]: 1, [CHAOS]: 22 }, { [BT]: 3, [CHAOS]: 66 })],
    [10 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 5 }, { [BT]: 1, [CHAOS]: 5 }, { [BT]: 5, [CHAOS]: 25 })]
  }
  const d = await btPricer(byHour, now).detailByName()
  assert.equal(d.get('Broken Truce')?.chaos, 22, 'a deeper-but-still-thin hour must not override the winning price')
})

test('a deeper hour that clears THIN_X_UNITS but is not materially deeper (below DEEP_HOUR_VOL_RATIO) does not override', async () => {
  // 20 units vs 9 (winning) is only ~2.2x -- below the 3x DEEP_HOUR_VOL_RATIO
  // bar -- even though both clear THIN_X_UNITS and the rates disagree hugely.
  const now = 12 * 3600 // -> lastHour 11:00
  const byHour = {
    [11 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 22 }, { [BT]: 1, [CHAOS]: 22 }, { [BT]: 9, [CHAOS]: 198 })],
    [10 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 5 }, { [BT]: 1, [CHAOS]: 5 }, { [BT]: 20, [CHAOS]: 100 })]
  }
  const d = await btPricer(byHour, now).detailByName()
  assert.equal(d.get('Broken Truce')?.chaos, 22, 'volume ratio below DEEP_HOUR_VOL_RATIO must not override')
})

test('guard: an expensive item that legitimately trades 1-3 units every hour, with huge chaos turnover, keeps its price across the whole union window', async () => {
  // Mirror-of-Kalandra shape: every single walked hour is "thin" by
  // THIN_X_UNITS (2-3 units), so no hour in the window can ever clear the
  // deep-hour floor and the cross-hour check must never fire -- this is the
  // exact scenario the QUOTE_VOL_MIN comment warns a two-sided/blanket floor
  // would wrongly unprice.
  const now = 12 * 3600 // -> lastHour 11:00
  const byHour = {
    [11 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 100000 }, { [BT]: 1, [CHAOS]: 100000 }, { [BT]: 2, [CHAOS]: 200000 })],
    [10 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 99000 }, { [BT]: 1, [CHAOS]: 99000 }, { [BT]: 3, [CHAOS]: 297000 })],
    [9 * 3600]: [mk([BT, CHAOS], { [BT]: 1, [CHAOS]: 101000 }, { [BT]: 1, [CHAOS]: 101000 }, { [BT]: 1, [CHAOS]: 101000 })]
  }
  const d = await btPricer(byHour, now).detailByName()
  assert.equal(d.get('Broken Truce')?.chaos, 100000, 'a consistently thin but expensive market must keep its price')
})
