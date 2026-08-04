// Sell-side comparison (reference rail): compareSellSides policy, the
// separated rates handed out by faustus.mjs (detail.sell), and their
// persistence roundtrip through the faustus store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareSellSides, isAttested, SELL_MIN_UNITS, SELL_MIN_QUOTE_TURNOVER_C,
  CHAOS_TAKEOVER_PCT, CHAOS_HOLD_PCT
} from './sell-side.mjs'
import { createFaustusPricer } from './networth/faustus.mjs'
import { createFaustusStore } from './networth/faustus-store.mjs'

const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps

// Rates from the brief's measured cases (Allflame digest 31.07.2026, C:D 172):
// the divine perItem is in DIVINE units (viaDivine = perItem * cd).
const CD = 172
const fat = { volX: 10_000_000, volQuote: 300_000 } // far above both floors
const fatDiv = { volX: 10_000_000, volQuote: 5_000 } // 5000 div * cd >> floor

// ---------------------------------------------------------------------------
// compareSellSides — the three measured cases give the right side
// ---------------------------------------------------------------------------
test('Vivid: both sides attested -> chaos wins by ~6.2%', () => {
  const r = compareSellSides({
    chaos: { perItem: 0.03841, ...fat },
    divine: { perItem: 0.03616 / CD, ...fatDiv }
  }, CD)
  assert.equal(r.better, 'chaos')
  assert.equal(r.only, null)
  assert.ok(approx(r.edgePct, 6.2, 0.1), `edge ${r.edgePct}`)
  assert.ok(approx(r.viaChaos, 0.03841, 1e-6))
  assert.ok(approx(r.viaDivine, 0.03616, 1e-6))
})

test('Primal: both sides attested -> chaos wins by ~8.6%', () => {
  const r = compareSellSides({
    chaos: { perItem: 0.02943, ...fat },
    divine: { perItem: 0.02711 / CD, ...fatDiv }
  }, CD)
  assert.equal(r.better, 'chaos')
  assert.ok(approx(r.edgePct, 8.6, 0.1), `edge ${r.edgePct}`)
})

test('Wild (the outlier case): thin divine side -> NO comparison, chaos shown alone', () => {
  // Divine side passed the pricer's quote floor (20 div) but 20 div * 172c =
  // 3440c < SELL_MIN_QUOTE_TURNOVER_C -> not attested, so no "+118%" claim.
  const r = compareSellSides({
    chaos: { perItem: 0.04259, ...fat },
    divine: { perItem: 0.01949 / CD, volX: 500_000, volQuote: 20 }
  }, CD)
  assert.equal(r.better, null)
  assert.equal(r.edgePct, null)
  assert.equal(r.only, 'chaos')
  // The rates themselves are still handed out for the tooltip.
  assert.ok(approx(r.viaChaos, 0.04259, 1e-6))
  assert.ok(approx(r.viaDivine, 0.01949, 1e-5))
})

test('divine can win too (Exalted-shaped): higher bridged revenue -> divine', () => {
  const r = compareSellSides({
    chaos: { perItem: 1.429, ...fat },
    divine: { perItem: 1.447 / CD, ...fatDiv }
  }, CD)
  assert.equal(r.better, 'divine')
  assert.ok(approx(r.edgePct, 1.26, 0.05), `edge ${r.edgePct}`)
})

// ---------------------------------------------------------------------------
// compareSellSides — divine bias with hysteresis (CHAOS_TAKEOVER_PCT /
// CHAOS_HOLD_PCT). Both sides attested throughout; only the two chaos-side
// revenues and `prevBetter` vary. `sellFor(viaChaos, viaDivine)` builds a
// both-sides-attested `sell` shape from two already-bridged chaos-equivalent
// revenues, so the edge percentages below are exact, not approximated.
// ---------------------------------------------------------------------------
const sellFor = (viaChaos, viaDivine) => ({
  chaos: { perItem: viaChaos, ...fat },
  divine: { perItem: viaDivine / CD, ...fatDiv }
})

test('deadband: chaos pays a bit more but not enough to take over -> divine recommended, no percentage', () => {
  // chaos edge = 2%, below the 5% takeover bar, no previous verdict.
  const r = compareSellSides(sellFor(102, 100), CD)
  assert.equal(r.better, 'divine')
  assert.equal(r.edgePct, null, 'no honest percentage exists here — chaos, not divine, pays more')
  assert.ok(approx(r.viaChaos, 102, 1e-6))
  assert.ok(approx(r.viaDivine, 100, 1e-6))
})

test('deadband also covers an exact tie: chaosEdge 0% -> divine, no percentage', () => {
  const r = compareSellSides(sellFor(100, 100), CD)
  assert.equal(r.better, 'divine')
  assert.equal(r.edgePct, null)
})

test(`takeover: chaos edge right at CHAOS_TAKEOVER_PCT (${CHAOS_TAKEOVER_PCT}%) -> chaos wins with that edge`, () => {
  const viaDivine = 100
  const viaChaos = viaDivine * (1 + CHAOS_TAKEOVER_PCT / 100)
  const r = compareSellSides(sellFor(viaChaos, viaDivine), CD)
  assert.equal(r.better, 'chaos')
  assert.ok(approx(r.edgePct, CHAOS_TAKEOVER_PCT, 1e-6))
})

test('just under the takeover bar (no previous verdict) -> still divine, deadband', () => {
  const viaDivine = 100
  const viaChaos = viaDivine * (1 + (CHAOS_TAKEOVER_PCT - 0.5) / 100)
  const r = compareSellSides(sellFor(viaChaos, viaDivine), CD)
  assert.equal(r.better, 'divine')
  assert.equal(r.edgePct, null)
})

test(`hold: chaos already recommended (prevBetter 'chaos') keeps winning at an edge of only ${CHAOS_HOLD_PCT}%`, () => {
  const viaDivine = 100
  const viaChaos = viaDivine * (1 + CHAOS_HOLD_PCT / 100)
  // Below the takeover bar — a fresh (no prevBetter) comparison would go divine.
  const fresh = compareSellSides(sellFor(viaChaos, viaDivine), CD)
  assert.equal(fresh.better, 'divine')
  // With chaos already holding the recommendation, the smaller hold bar applies.
  const held = compareSellSides(sellFor(viaChaos, viaDivine), CD, 'chaos')
  assert.equal(held.better, 'chaos')
  assert.ok(approx(held.edgePct, CHAOS_HOLD_PCT, 1e-6))
})

test('hold releases once the edge drops below CHAOS_HOLD_PCT, back to the deadband', () => {
  const viaDivine = 100
  const viaChaos = viaDivine * (1 + (CHAOS_HOLD_PCT - 0.5) / 100)
  const r = compareSellSides(sellFor(viaChaos, viaDivine), CD, 'chaos')
  assert.equal(r.better, 'divine')
  assert.equal(r.edgePct, null, 'chaos still pays marginally more, so no percentage is printed')
})

test('prevBetter is only consulted on the both-attested path: an `only` result ignores it entirely', () => {
  const r = compareSellSides({
    chaos: { perItem: 0.04, ...fat },
    divine: null
  }, CD, 'divine')
  assert.equal(r.better, null)
  assert.equal(r.only, 'chaos')
})

// ---------------------------------------------------------------------------
// compareSellSides — attestation and degradation
// ---------------------------------------------------------------------------
test('missing divine market entirely -> same treatment: chaos shown, no claim', () => {
  const r = compareSellSides({ chaos: { perItem: 0.04, ...fat }, divine: null }, CD)
  assert.equal(r.better, null)
  assert.equal(r.only, 'chaos')
  assert.equal(r.viaDivine, null)
})

test('missing chaos market -> divine shown alone (Mirror-shaped)', () => {
  const r = compareSellSides({ chaos: null, divine: { perItem: 500, ...fatDiv } }, CD)
  assert.equal(r.better, null)
  assert.equal(r.only, 'divine')
  assert.ok(approx(r.viaDivine, 500 * CD, 0.1))
})

test('single-trade X side fails the unit floor (The Apothecary case)', () => {
  // 1 card traded for chaos "prices" the chaos side -> volX 1 < SELL_MIN_UNITS.
  const r = compareSellSides({
    chaos: { perItem: 1900, volX: 1, volQuote: 1900 },
    divine: { perItem: 7158 / CD, volX: 487, volQuote: 20_000 }
  }, CD)
  assert.equal(r.better, null)
  assert.equal(r.only, 'divine')
})

test('both sides thin -> nothing is claimed at all (no better, no only)', () => {
  const r = compareSellSides({
    chaos: { perItem: 1, volX: 2, volQuote: 100 },
    divine: { perItem: 0.01, volX: 3, volQuote: 2 }
  }, CD)
  assert.equal(r.better, null)
  assert.equal(r.only, null)
})

test('no usable chaosPerDivine -> divine side treated as absent, never bridged bogusly', () => {
  for (const cd of [null, 0, -1, NaN, undefined]) {
    const r = compareSellSides({
      chaos: { perItem: 0.04, ...fat },
      divine: { perItem: 0.0002, ...fatDiv }
    }, cd)
    assert.equal(r.viaDivine, null)
    assert.equal(r.only, 'chaos')
  }
})

test('nothing usable -> null; garbage input -> null (never throws)', () => {
  assert.equal(compareSellSides(null, CD), null)
  assert.equal(compareSellSides({}, CD), null)
  assert.equal(compareSellSides({ chaos: { perItem: NaN }, divine: { perItem: -1 } }, CD), null)
})

test('isAttested floors: exactly at the boundary counts, below does not', () => {
  const at = { perItem: 1, volX: SELL_MIN_UNITS, volQuote: SELL_MIN_QUOTE_TURNOVER_C }
  assert.equal(isAttested(at, 1), true)
  assert.equal(isAttested({ ...at, volX: SELL_MIN_UNITS - 1 }, 1), false)
  assert.equal(isAttested({ ...at, volQuote: SELL_MIN_QUOTE_TURNOVER_C - 1 }, 1), false)
  // divine side: quote turnover converts at C:D
  assert.equal(isAttested({ perItem: 1, volX: 100, volQuote: 30 }, CD), true) // 30*172 > 5000
  assert.equal(isAttested({ perItem: 1, volX: 100, volQuote: 20 }, CD), false) // 20*172 < 5000
})

// ---------------------------------------------------------------------------
// faustus.mjs hands the two rates out SEPARATELY — same estimator order as the
// price path (volume-weighted first), and the price path itself is unchanged.
// ---------------------------------------------------------------------------
const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare'
const DIVINE = 'Metadata/Items/Currency/CurrencyModValues'
const X = 'Metadata/Items/Currency/HarvestWild'

const mk = (pair, lo, hi, vol, league = 'Standard') => ({
  league, market_pair: pair, lowest_ratio: lo, highest_ratio: hi, volume_traded: vol
})

function pricerFor (markets) {
  return createFaustusPricer({
    league: 'Standard',
    deps: {
      now: () => 10 * 3600,
      fetchHour: async id => ({ next_change_id: id + 1, markets }),
      baseNames: { byId: new Map([[X, 'Wild Crystallised Lifeforce']]) }
    }
  })
}

// The estimator-order trap, pinned (live digest, Wild, hour 18:00Z): extremes
// lo 54:1 / hi 15:1 (midpoint 0.0426) vs volume-weighted 174186/8832207 =
// 0.0197 — the midpoint would flip the WHOLE recommendation (a fake "+118%
// chaos"), so the sell rates must come out volume-weighted like the price path.
const WILD_CHAOS = mk([X, CHAOS], { [X]: 54, [CHAOS]: 1 }, { [X]: 15, [CHAOS]: 1 },
  { [X]: 8_832_207, [CHAOS]: 174_186 })
const WILD_DIVINE = mk([X, DIVINE], { [X]: 9000, [DIVINE]: 1 }, { [X]: 8000, [DIVINE]: 1 },
  { [X]: 850_000, [DIVINE]: 100 })

test('detail.sell: chaos side is the volume-weighted 0.0197, NOT the extremes midpoint 0.0426', async () => {
  const detail = await pricerFor([WILD_CHAOS, WILD_DIVINE]).detailByName()
  const d = detail.get('Wild Crystallised Lifeforce')
  assert.ok(d && d.sell)
  assert.ok(approx(d.sell.chaos.perItem, 174_186 / 8_832_207, 1e-6))
  assert.ok(!approx(d.sell.chaos.perItem, 0.0426, 0.005))
  // and it REUSES the price path's value — cannot diverge
  assert.equal(d.sell.chaos.perItem, d.chaos)
  assert.equal(d.sell.chaos.volX, 8_832_207)
  assert.equal(d.sell.chaos.volQuote, 174_186)
})

test('detail.sell: divine side comes out separately with its own volumes', async () => {
  const detail = await pricerFor([WILD_CHAOS, WILD_DIVINE]).detailByName()
  const d = detail.get('Wild Crystallised Lifeforce')
  assert.ok(approx(d.sell.divine.perItem, 100 / 850_000, 1e-9))
  assert.equal(d.sell.divine.volX, 850_000)
  assert.equal(d.sell.divine.volQuote, 100)
})

test('price path unchanged: same fixture prices identically with sell present', async () => {
  // chaosByName (the collapsed path every consumer uses) still returns the
  // volume-weighted chaos value — detail.sell is purely additive.
  const map = await pricerFor([WILD_CHAOS, WILD_DIVINE]).chaosByName()
  assert.ok(approx(map.get('Wild Crystallised Lifeforce'), 174_186 / 8_832_207, 1e-6))
})

test('chaos-market-only item: sell has no divine side, no crash', async () => {
  const detail = await pricerFor([WILD_CHAOS]).detailByName()
  const d = detail.get('Wild Crystallised Lifeforce')
  assert.ok(d.sell.chaos)
  assert.equal(d.sell.divine, undefined)
})

// ---------------------------------------------------------------------------
// faustus-store: sell persists additively and survives a roundtrip
// ---------------------------------------------------------------------------
test('store: sell roundtrip (memory + disk), old files without sell stay loadable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sellstore-'))
  try {
    const file = join(dir, 'faustus-store.json')
    const store = createFaustusStore(file)
    await store.load()
    const sell = {
      'Wild Crystallised Lifeforce': {
        chaos: { perItem: 0.0197, volX: 8_832_207, volQuote: 174_186 },
        divine: { perItem: 0.0001176, volX: 850_000, volQuote: 100 }
      },
      'Broken Entry': { chaos: { perItem: NaN }, divine: { perItem: -5 } } // dropped
    }
    await store.setPrices('Standard', { 'Wild Crystallised Lifeforce': 0.0197 }, 123, null, sell)
    const got = store.getSell('Wild Crystallised Lifeforce')
    assert.ok(approx(got.chaos.perItem, 0.0197, 1e-9))
    assert.equal(got.chaos.volX, 8_832_207)
    assert.ok(approx(got.divine.perItem, 0.0001176, 1e-9))
    assert.equal(store.getSell('Broken Entry'), null)
    assert.equal(store.getSell('Unknown'), null)
    // disk roundtrip
    const store2 = createFaustusStore(file)
    await store2.load()
    assert.equal(store2.getSell('Wild Crystallised Lifeforce').divine.volQuote, 100)
    // a store written without sell (pre-feature file shape) -> getSell null
    store2.data = { schema_version: 1, updatedAt: 1, league: 'Standard', prices: { A: 1 } }
    assert.equal(store2.getSell('A'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
