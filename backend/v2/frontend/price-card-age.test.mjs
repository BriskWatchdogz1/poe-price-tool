// priceHtml() from app.js: what the price-check card SAYS about where its
// number comes from and how old it is.
//
// The report behind this: three divination cards of the same league rendered
// three different ways — one with a Currency-Exchange headline, one with a
// poe.ninja aggregate, one with plain trade listings — and only the first two
// named their source. On top of that the exchange headline (206.6c for The
// Chosen) disagreed with the in-game exchange (147c) with nothing on the card
// hinting that the two numbers were from different hours.
//
// app.js is a classic <script>, not a module, so priceHtml is cut out and
// evaluated with its collaborators injected — the same source the browser runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('./app.js', import.meta.url), 'utf8')
const start = src.indexOf('function priceHtml (')
assert.ok(start >= 0, 'priceHtml not found in app.js')
const end = src.indexOf('\n}\n', start)
assert.ok(end > start, 'end of priceHtml not found')

// T echoes the KEY, so a test asserts on the i18n key rather than on wording
// that translators are free to change. Everything else is the smallest stub
// that keeps the function honest.
const deps = [
  (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key), // T
  s => String(s), // esc
  () => false, // isGold
  () => 'c', // curUnit
  s => String(s ?? ''), // SRV
  () => 'ASK' // askText
]
// eslint-disable-next-line no-new-func
const priceHtml = new Function('T', 'esc', 'isGold', 'curUnit', 'SRV', 'askText',
  `${src.slice(start, end + 2)}\nreturn priceHtml`)(...deps)

const exchangeItem = (price = {}) => ({
  priceStatus: 'done',
  price: {
    display: 'single',
    priceSource: 'exchange',
    currency: 'chaos',
    priceLow: 206.6,
    priceHigh: 206.6,
    count: 10,
    sourceLabel: 'Exchange',
    tradeAsk: { low: 9, high: 289.5, currency: 'chaos', chaosLow: 9, chaosHigh: 289.5, chaosMedian: 40 },
    ...price
  }
})

test('an aged exchange rate says so, ABOVE the number', () => {
  const html = priceHtml(exchangeItem({ exchangeAgeHours: 6, exchangeRange: { low: 142, high: 300 } }))
  assert.match(html, /pc\.price\.exchangeAge\(\{"n":6\}\)/, 'the age line is rendered with the hour count')
  assert.match(html, /class="pstale"/)
  // Above, not below: a reader who has already taken in the price has stopped
  // looking, and this qualifies the price.
  assert.ok(html.indexOf('class="pstale"') < html.indexOf('class="pr'),
    'the age has to precede the number it qualifies')
  assert.match(html, /pc\.price\.exchangeAgeTitle/, 'and it explains itself on hover')
})

test('a fresh exchange rate carries no age marker at all', () => {
  // The server only sends exchangeAgeHours past the lag it cannot avoid, so
  // absence IS the normal case — and a marker on every card would stop being
  // read, which is the whole reason it is conditional.
  const html = priceHtml(exchangeItem())
  assert.doesNotMatch(html, /pstale/)
  assert.doesNotMatch(html, /pc\.price\.exchangeAge/)
})

test('the span names the hour it belongs to, not a bare "range"', () => {
  // It is ONE digest hour's low and high — the hour the headline averages —
  // never the span of the hours the union walk searched.
  const html = priceHtml(exchangeItem({ exchangeRange: { low: 142, high: 300 } }))
  assert.match(html, /pc\.price\.exchangeRange\(\{"low":142,"high":300\}\)/)
  assert.match(html, /pc\.price\.exchangeRangeTitle/)
})

test('the trade-ask line explains that asks are not sales', () => {
  const html = priceHtml(exchangeItem())
  assert.match(html, /pc\.price\.tradeAskTitle/)
  assert.match(html, /pc\.price\.tradeAsk\(/)
})

test('a card priced from plain trade listings names THAT source too', () => {
  // The Trial's shape: no exchange rate, no poe.ninja aggregate, just offers.
  // Until this label existed it was the only one of the three shapes that did
  // not say where its number came from, so the difference looked arbitrary.
  const html = priceHtml({
    priceStatus: 'done',
    price: {
      display: 'single', currency: 'chaos', priceLow: 1, priceHigh: 5, priceMedian: 2.5, count: 108,
      listings: [{ price: 1, currency: 'chaos', seller: '@a', ageMinutes: 13 }]
    }
  })
  assert.match(html, /pc\.price\.tradeOnly/)
  assert.match(html, /pc\.price\.tradeOnlyTitle/)
  assert.doesNotMatch(html, /pstale/, 'a trade-priced card has no exchange observation to date')
})

test('a poe.ninja aggregate can carry the age too, and stays labelled as poe.ninja', () => {
  // The other Faustus-fed shape: the bulk exchange came back empty, so the rate
  // is rendered through the aggregate path (server.mjs toNinjaPriceResult with
  // source 'exchange'). Same number, same source, so the same dating applies.
  const html = priceHtml({
    priceStatus: 'done',
    price: {
      display: 'ninja', priceSource: 'exchange', currency: 'chaos', priceLow: 45,
      sourceLabel: 'Currency Exchange', sourceNote: 'market rate', exchangeAgeHours: 5, count: null
    }
  })
  assert.match(html, /pc\.price\.exchangeAge\(\{"n":5\}\)/)
  assert.match(html, /Currency Exchange/)
})
