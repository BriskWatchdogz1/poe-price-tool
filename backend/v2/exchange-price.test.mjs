// Currency Exchange (Faustus) as the headline price of the price-check card.
// The rule: if Faustus knows the item, its rate IS the price — the trade ask
// drops down into the extra `tradeAsk` line. If Faustus does not know it,
// everything stays exactly as before (no regression for rare gear/uniques).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from 'node:os'

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
    low: 0.7, high: 1, currency: 'divine', chaosLow: 74.2, chaosHigh: 106
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
    low: 80, high: 120, currency: 'chaos', chaosLow: 80, chaosHigh: 120
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
