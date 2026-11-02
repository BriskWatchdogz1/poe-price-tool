// Currency Exchange (Faustus) as the headline price of the price-check card.
// The rule: if Faustus knows the item, its rate IS the price — the trade ask
// drops down into the extra `tradeAsk` line. If Faustus does not know it,
// everything stays exactly as before (no regression for rare gear/uniques).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { quietEnv } from './test-quiet-env.mjs'

// The full set that keeps a booted server off the network. One list, imported:
// every file that wrote it out by hand left something out, and what kept being
// left out was the switch a WebSocket needs (test-quiet-env.mjs, docs/bugs.md
// B25). Applied FIRST — anything this file sets below overrides it on purpose.
quietEnv()
// PRICING IS ON HERE, DELIBERATELY, and it is the one switch of the quiet set
// this file turns back off: the exchange price path is what this file measures. Nothing leaves
// the machine for it — `fetch` is stubbed in this file, and the runner's guard
// (test-net-guard.mjs) blocks anything that is not loopback anyway. Written out
// rather than left implicit, because "this file prices" used to be visible only
// as the ABSENCE of a line.
delete process.env.POE_PRICE_CHECK_DISABLED
// And this one, for the same reason and with the same protection: the Faustus store IS the price source under test here.
delete process.env.POE_FAUSTUS_DISABLED
process.env.PORT = '0'
// Faustus stays ON here (unlike most other server.mjs-importing tests): the
// store is populated directly via setPrices below and read back through
// faustusChaosFor/faustusRangeFor, both of which short-circuit to null when
// POE_FAUSTUS_DISABLED is set.
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_USERS = 'exuser'
// Store file in tmp: the test sets prices via setPrices (writes immediately).
process.env.POE_FAUSTUS_STORE = path.join(tmpdir(), `faustus-exchange-test-${process.pid}.json`)

// No network: the Faustus CDN boot tick finds nothing (empty markets) and the
// tests seed the store by hand; everything else (cd-ratio, reference rail) is
// stubbed too so importing server.mjs never reaches out for real.
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('web.poecdn.com')) return { ok: true, status: 200, json: async () => ({ markets: [] }) }
  return { ok: true, status: 200, json: async () => ({ lines: [] }) }
}

let mod
const CD = 106 // chaos per divine (Allflame example from the bug report)

const tradeResult = (over = {}) => ({
  type: 'price-result',
  id: 'i1',
  display: 'single',
  currency: 'divine',
  priceLow: 0.7,
  priceHigh: 1,
  priceMedian: 1,
  count: 24,
  listings: [{ price: 1, currency: 'divine', seller: '@a', ageMinutes: 3 }],
  tradeId: 'abc123',
  tradeKind: 'exchange',
  league: 'Standard',
  ...over
})

before(async () => { mod = await import('./server.mjs') })
after(async () => {
  globalThis.fetch = realFetch
  await new Promise(r => mod.server.close(r))
})

test('Faustus knows it: the Exchange rate becomes the headline price, the trade ask moves to tradeAsk', () => {
  const r = mod.withExchangeMain(tradeResult(), 56, CD)
  assert.equal(r.currency, 'chaos')
  assert.equal(r.priceLow, 56)
  assert.equal(r.priceHigh, 56)
  assert.equal(r.priceMedian, 56)
  assert.equal(r.priceSource, 'exchange')
  assert.equal(r.sourceLabel, 'Exchange')
  assert.deepEqual(r.tradeAsk, {
    low: 0.7, high: 1, currency: 'divine', chaosLow: 74.2, chaosHigh: 106, chaosMedian: 106
  })
})

test('listings, trade link and count stay unchanged (the list below is still trade)', () => {
  const base = tradeResult()
  const r = mod.withExchangeMain(base, 56, CD)
  assert.deepEqual(r.listings, base.listings)
  assert.equal(r.count, 24)
  assert.equal(r.tradeId, 'abc123')
  assert.equal(r.tradeKind, 'exchange')
  assert.equal(r.display, 'single')
})

test('many trade listings at a different price change nothing: Faustus always wins', () => {
  const listings = Array.from({ length: 30 }, (_, i) => ({
    price: 1, currency: 'divine', seller: '@s' + i, ageMinutes: i
  }))
  const r = mod.withExchangeMain(
    tradeResult({ priceLow: 1, priceHigh: 1, priceMedian: 1, count: 30, listings }), 45, CD)
  assert.equal(r.priceLow, 45)
  assert.equal(r.priceHigh, 45)
  assert.equal(r.currency, 'chaos')
  assert.equal(r.tradeAsk.low, 1)
  assert.equal(r.tradeAsk.currency, 'divine')
})

test('trade ask already in chaos: no double conversion', () => {
  const r = mod.withExchangeMain(
    tradeResult({ currency: 'chaos', priceLow: 80, priceHigh: 120 }), 56, CD)
  assert.deepEqual(r.tradeAsk, {
    low: 80, high: 120, currency: 'chaos', chaosLow: 80, chaosHigh: 120, chaosMedian: 1
  })
})

test('trade result without a price: Faustus headline price, but no trade-ask line', () => {
  const r = mod.withExchangeMain(
    tradeResult({ priceLow: 0, priceHigh: 0, priceMedian: 0, count: 0, listings: [] }), 56, CD)
  assert.equal(r.priceLow, 56)
  assert.equal(r.tradeAsk, null)
})

test('sub-chaos fungibles (Lifeforce and friends) are not rounded down to 0', () => {
  const r = mod.withExchangeMain(tradeResult({ currency: 'chaos', priceLow: 0.1, priceHigh: 0.1 }), 0.0179, CD)
  assert.equal(r.priceLow, 0.018)
  assert.ok(r.priceLow > 0, 'no "0 c" as the headline price')
})

test('Faustus does not know the item: the result stays byte for byte identical (no regression)', () => {
  const base = tradeResult()
  const r = mod.withExchangeMain(base, null, CD)
  assert.deepEqual(r, base)
  assert.equal(r.tradeAsk, undefined)
  assert.equal(r.priceSource, undefined)
})

test('an implausible Faustus value (0/NaN) is ignored', () => {
  const base = tradeResult()
  assert.deepEqual(mod.withExchangeMain(base, 0, CD), base)
  assert.deepEqual(mod.withExchangeMain(base, NaN, CD), base)
})

test('without a C:D rate the chaos equivalent on the trade-ask line stays empty (never guessed)', () => {
  const r = mod.withExchangeMain(tradeResult(), 56, 0)
  assert.equal(r.priceLow, 56)
  assert.equal(r.tradeAsk.chaosLow, null)
  assert.equal(r.tradeAsk.chaosHigh, null)
})

test('faustusChaosFor: item in the store -> rate; wrong league/unknown name -> null', async () => {
  await mod.faustusStore.setPrices('Standard', {
    "Valdo's Puzzle Box": 55.5, 'Templar Astrolabe': 43.5
  })
  const box = { name: "Valdo's Puzzle Box", info: { refName: "Valdo's Puzzle Box" } }
  const astro = { name: 'Templar Astrolabe', info: { refName: 'Templar Astrolabe' } }
  const rare = { name: 'Corpse Whisper', rarity: 'Rare', info: { refName: 'Vaal Regalia' } }
  assert.equal(mod.faustusChaosFor(box, 'Standard'), 55.5)
  assert.equal(mod.faustusChaosFor(astro, 'Standard'), 43.5)
  assert.equal(mod.faustusChaosFor(rare, 'Standard'), null, 'rare gear is unknown to Faustus')
  assert.equal(mod.faustusChaosFor(box, 'Allflame'), null, 'a foreign league is never priced')
})

test('the rare-gear path is completely untouched: no Faustus value -> original result', () => {
  const rare = { name: 'Corpse Whisper', rarity: 'Rare', info: { refName: 'Vaal Regalia' } }
  const base = tradeResult({ tradeKind: 'search', currency: 'chaos', priceLow: 12, priceHigh: 40 })
  const r = mod.withExchangeMain(base, mod.faustusChaosFor(rare, 'Standard'), CD)
  assert.deepEqual(r, base)
})

// --- range (exchangeRange) ---------------------------------------------------

test('the range is passed through as exchangeRange, rounded like the headline number', () => {
  const r = mod.withExchangeMain(tradeResult(), 13.6, CD, { min: 10.04, max: 17.06 })
  assert.deepEqual(r.exchangeRange, { low: 10, high: 17.1 })
  const sub = mod.withExchangeMain(tradeResult(), 0.0179, CD, { min: 0.0121, max: 0.0304 })
  assert.deepEqual(sub.exchangeRange, { low: 0.012, high: 0.03 }, 'below 1c three decimal places')
})

test('without (or with a degenerate) range exchangeRange stays absent — no placeholder', () => {
  assert.equal(mod.withExchangeMain(tradeResult(), 56, CD).exchangeRange, undefined)
  assert.equal(mod.withExchangeMain(tradeResult(), 56, CD, null).exchangeRange, undefined)
  assert.equal(mod.withExchangeMain(tradeResult(), 56, CD, { min: 5, max: 5 }).exchangeRange, undefined)
  assert.equal(mod.withExchangeMain(tradeResult(), 56, CD, { min: 9, max: 2 }).exchangeRange, undefined)
  assert.equal(mod.withExchangeMain(tradeResult(), 56, CD, { min: 0, max: 2 }).exchangeRange, undefined)
})

test('no Faustus value: even WITH a range the result stays byte for byte identical', () => {
  const base = tradeResult()
  assert.deepEqual(mod.withExchangeMain(base, null, CD, { min: 1, max: 2 }), base)
  assert.equal(mod.withExchangeMain(base, null, CD, { min: 1, max: 2 }).exchangeRange, undefined)
})

// --- askConflict (ask-conflict marker) --------------------------------------

test('ask-conflict: over — Broken Truce shape (headline far above the ask median)', () => {
  const r = mod.withExchangeMain(
    tradeResult({ currency: 'chaos', priceLow: 1, priceHigh: 1, priceMedian: 1, count: 218 }), 22, CD)
  assert.deepEqual(r.askConflict, { dir: 'over', factor: 22 })
})

test("ask-conflict: under — cheapest ask far above headline (Father's Love shape)", () => {
  const r = mod.withExchangeMain(
    tradeResult({ currency: 'chaos', priceLow: 8000, priceHigh: 8500, priceMedian: 8200, count: 50 }), 153, CD)
  assert.deepEqual(r.askConflict, { dir: 'under', factor: 52.3 })
})

test('ask-conflict: near-floor no-fire — ratio crossed but the absolute gap is too small', () => {
  const r = mod.withExchangeMain(
    tradeResult({ currency: 'chaos', priceLow: 1, priceHigh: 1, priceMedian: 1, count: 50 }), 4.5, CD)
  assert.equal(r.askConflict, undefined)
})

test('ask-conflict: sub-chaos no-fire — headline below the minimum', () => {
  const r = mod.withExchangeMain(
    tradeResult({ currency: 'chaos', priceLow: 164, priceHigh: 170, priceMedian: 165, count: 50 }), 0.6, CD)
  assert.equal(r.askConflict, undefined)
})

test('ask-conflict: thin-evidence no-fire — fewer than 5 fetched asks', () => {
  const r = mod.withExchangeMain(
    tradeResult({ currency: 'chaos', priceLow: 1, priceHigh: 1, priceMedian: 1, count: 3 }), 22, CD)
  assert.equal(r.askConflict, undefined)
})

test('ask-conflict: exotic ask currency no-fire — no C:D rate to convert by', () => {
  const r = mod.withExchangeMain(
    tradeResult({ priceLow: 1, priceHigh: 1, priceMedian: 1, count: 218 }), 22, 0)
  assert.equal(r.tradeAsk.chaosLow, null)
  assert.equal(r.tradeAsk.chaosMedian, null)
  assert.equal(r.askConflict, undefined)
})

test('faustusRangeFor: range from the store, same league/freshness guards', async () => {
  await mod.faustusStore.setPrices('Standard',
    { 'Memory of Reverence': 13.6, 'Templar Astrolabe': 43.5 }, Date.now(),
    { 'Memory of Reverence': [10, 17] })
  const mem = { name: 'Memory of Reverence', info: { refName: 'Memory of Reverence' } }
  const astro = { name: 'Templar Astrolabe', info: { refName: 'Templar Astrolabe' } }
  assert.deepEqual(mod.faustusRangeFor(mem, 'Standard'), { min: 10, max: 17 })
  assert.equal(mod.faustusRangeFor(astro, 'Standard'), null, 'no range stored -> null')
  assert.equal(mod.faustusRangeFor(mem, 'Allflame'), null, 'a foreign league never yields a range')
})

// --- age of the observation (exchangeAgeHours) -------------------------------
//
// The report this covers: the card said 206.6c for The Chosen while the in-game
// Currency Exchange sold it at 147c, and a second card of the same league at
// the same minute (Imperfect Memories, 19c against 21c in-game) came out of the
// identical code path essentially right. What separates them is not the market
// SIDE — a rate sitting between bid and ask would land ABOVE 21 for the second
// card, not below it — but which hour the observation is from. So the card has
// to be able to say that, and the valuation has to stop using a number that is
// too old (networth/faustus-age.mjs).

const HOUR_MS = 60 * 60 * 1000
/** unix hour that CLOSED `h` hours ago, i.e. an observation `h` hours old. */
const closedHoursAgo = h => Math.floor((Date.now() - (h + 1) * HOUR_MS) / 1000)

test('faustusStaleHoursFor: silent while the price is as fresh as the pipeline allows', async () => {
  // Default refresh is hourly, so a served price is never fresher than 2h:
  // one hour of digest granularity plus one refresh interval. Labelling that
  // would put a marker on every card and the marker would stop being read.
  await mod.faustusStore.setPrices('Standard', { 'Memory of Reverence': 13.6 }, Date.now(), null, null,
    { 'Memory of Reverence': closedHoursAgo(0) })
  const mem = { name: 'Memory of Reverence', info: { refName: 'Memory of Reverence' } }
  assert.equal(mod.faustusStaleHoursFor(mem, 'Standard'), null)

  await mod.faustusStore.setPrices('Standard', { 'Memory of Reverence': 13.6 }, Date.now(), null, null,
    { 'Memory of Reverence': closedHoursAgo(1.5) })
  assert.equal(mod.faustusStaleHoursFor(mem, 'Standard'), null, 'still inside the unavoidable lag')
})

test('faustusStaleHoursFor: past the lag it names the whole hours, and the league guard holds', async () => {
  await mod.faustusStore.setPrices('Standard', { 'Memory of Reverence': 13.6 }, Date.now(), null, null,
    { 'Memory of Reverence': closedHoursAgo(4) })
  const mem = { name: 'Memory of Reverence', info: { refName: 'Memory of Reverence' } }
  assert.equal(mod.faustusStaleHoursFor(mem, 'Standard'), 4)
  assert.equal(mod.faustusStaleHoursFor(mem, 'Allflame'), null, 'a foreign league says nothing')
})

test('faustusStaleHoursFor: no stored hour -> no claim about the age', async () => {
  await mod.faustusStore.setPrices('Standard', { 'Memory of Reverence': 13.6 })
  const mem = { name: 'Memory of Reverence', info: { refName: 'Memory of Reverence' } }
  assert.equal(mod.faustusStaleHoursFor(mem, 'Standard'), null)
})

test('faustusChaosFor: an observation past the age gate is not served as a price', async () => {
  // Same gate the net-worth valuator applies, on purpose: a card and the net
  // worth that disagree about one item are worse than either being wrong alone.
  // Default POE_FAUSTUS_MAX_AGE_HOURS is 6.
  const box = { name: "Valdo's Puzzle Box", info: { refName: "Valdo's Puzzle Box" } }
  await mod.faustusStore.setPrices('Standard', { "Valdo's Puzzle Box": 55.5 }, Date.now(), null, null,
    { "Valdo's Puzzle Box": closedHoursAgo(5) })
  assert.equal(mod.faustusChaosFor(box, 'Standard'), 55.5, 'inside the gate: unchanged')

  await mod.faustusStore.setPrices('Standard', { "Valdo's Puzzle Box": 55.5 }, Date.now(), null, null,
    { "Valdo's Puzzle Box": closedHoursAgo(9) })
  assert.equal(mod.faustusChaosFor(box, 'Standard'), null,
    'past the gate the item routes like one Faustus never quoted')
})

test('withExchangeMain: the age rides along as exchangeAgeHours, and is absent when fresh', () => {
  const aged = mod.withExchangeMain(tradeResult(), 206.6, CD, { min: 142, max: 300 }, 'The Chosen', 6)
  assert.equal(aged.exchangeAgeHours, 6)
  assert.deepEqual(aged.exchangeRange, { low: 142, high: 300 })

  // Fresh, and everything the server can hand over that is NOT a positive
  // number of hours: no field at all, never a "0 h old" that reads like a
  // guarantee of freshness the source cannot give.
  for (const v of [null, undefined, 0, -1, NaN, '3']) {
    const fresh = mod.withExchangeMain(tradeResult(), 206.6, CD, null, 'The Chosen', v)
    assert.equal('exchangeAgeHours' in fresh, false, `${String(v)} produced an age field`)
  }
})

test('no Faustus value: the age never appears on a trade-priced card', () => {
  const base = tradeResult({ tradeKind: 'search', currency: 'chaos', priceLow: 1, priceHigh: 5 })
  const r = mod.withExchangeMain(base, null, CD, null, 'The Trial', 7)
  assert.deepEqual(r, base, 'no exchange headline, so nothing to date')
})
