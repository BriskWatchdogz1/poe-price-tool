// Rate-limit bookkeeping for the trade API (trade-audit.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTradeAudit, installTradeAudit, withConsumer, currentConsumer, tradePolicyFor, CONSUMER } from './trade-audit.mjs'

const SEARCH = 'https://www.pathofexile.com/api/trade/search/Allflame%20Ember'

// GGG's shape: limit:window:ban / hits:window:ban
function headers ({ rules = 'Ip', ip = '10:10:60,15:60:120', state = '1:10:0,3:60:0', retryAfter = null } = {}) {
  const h = new Map([
    ['x-rate-limit-rules', rules],
    ['x-rate-limit-ip', ip],
    ['x-rate-limit-ip-state', state]
  ])
  if (retryAfter != null) h.set('retry-after', String(retryAfter))
  return { get: k => h.get(String(k).toLowerCase()) ?? null }
}

function collector () {
  const lines = []
  return { lines, log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) }
}

test('tradePolicyFor: only /api/trade counts, other hosts/paths do not', () => {
  assert.equal(tradePolicyFor(SEARCH), 'search')
  assert.equal(tradePolicyFor('https://www.pathofexile.com/api/trade/fetch/abc'), 'fetch')
  assert.equal(tradePolicyFor('https://www.pathofexile.com/api/trade/exchange/Standard'), 'exchange')
  assert.equal(tradePolicyFor('https://www.pathofexile.com/api/trade/data/stats'), 'data')
  // Stash has its OWN budget, poe.ninja is not GGG at all -> not our business.
  assert.equal(tradePolicyFor('https://www.pathofexile.com/character-window/get-stash-items'), null)
  assert.equal(tradePolicyFor('https://poe.ninja/api/data/currencyoverview'), null)
  assert.equal(tradePolicyFor('not a url'), null)
})

test('withConsumer tags everything below it; outside it is unknown', async () => {
  assert.equal(currentConsumer(), CONSUMER.UNKNOWN)
  const seen = await withConsumer(CONSUMER.CORPSE, async () => {
    await new Promise(r => setTimeout(r, 1))
    return currentConsumer()
  })
  assert.equal(seen, CONSUMER.CORPSE)
  assert.equal(currentConsumer(), CONSUMER.UNKNOWN, 'context does not leak out')
})

test('threshold line: once when crossed, not on every request', () => {
  const log = collector()
  const audit = createTradeAudit({ log, threshold: 0.8 })
  // 1/10 and 5/10 -> quiet.
  audit.record({ url: SEARCH, status: 200, headers: headers({ state: '1:10:0,3:60:0' }), consumer: CONSUMER.PRICE_CHECK })
  audit.record({ url: SEARCH, status: 200, headers: headers({ state: '5:10:0,5:60:0' }), consumer: CONSUMER.PRICE_CHECK })
  assert.equal(log.lines.length, 0)
  // 8/10 = 80% -> exactly one line.
  audit.record({ url: SEARCH, status: 200, headers: headers({ state: '8:10:0,8:60:0' }), consumer: CONSUMER.PRICE_CHECK })
  assert.equal(log.lines.length, 1)
  const line = log.lines[0]
  assert.match(line, /\[trade-audit\] rate limit 80% reached/)
  assert.match(line, /consumer=price-check/)
  assert.match(line, /policy=search/)
  assert.match(line, /rule=Ip 8\/10 in 10s/)
  assert.match(line, /ban 60s/)
  // Still tight -> no repeat.
  audit.record({ url: SEARCH, status: 200, headers: headers({ state: '9:10:0,9:60:0' }), consumer: CONSUMER.PRICE_CHECK })
  audit.record({ url: SEARCH, status: 200, headers: headers({ state: '10:10:0,9:60:0' }), consumer: CONSUMER.PRICE_CHECK })
  assert.equal(log.lines.length, 1, 'edge-triggered, not per request')
  // Window emptied, gets tight again -> a fresh line.
  audit.record({ url: SEARCH, status: 200, headers: headers({ state: '1:10:0,9:60:0' }), consumer: CONSUMER.PRICE_CHECK })
  audit.record({ url: SEARCH, status: 200, headers: headers({ state: '8:10:0,9:60:0' }), consumer: CONSUMER.PRICE_CHECK })
  assert.equal(log.lines.length, 2)
})

test('429: one context line with rule, wait and per-consumer counts', () => {
  const log = collector()
  let t = 1_000_000
  const audit = createTradeAudit({ log, now: () => t })
  // Four corpse-pricer requests and one price check inside the 60s window.
  for (let i = 0; i < 4; i++) {
    audit.record({ url: SEARCH, status: 200, headers: headers({ state: `${i}:10:0,${i}:60:0` }), consumer: CONSUMER.CORPSE })
    t += 1000
  }
  audit.record({ url: SEARCH, status: 200, headers: headers({ state: '5:10:0,5:60:0' }), consumer: CONSUMER.PRICE_CHECK })
  t += 1000
  audit.record({
    url: SEARCH,
    status: 429,
    headers: headers({ state: '9:10:0,15:60:0', retryAfter: 300 }),
    consumer: CONSUMER.PRICE_CHECK
  })
  const line = log.lines.at(-1)
  assert.match(line, /\[trade-audit\] 429 from GGG/)
  assert.match(line, /consumer=price-check/)
  assert.match(line, /rule=Ip 15\/15 window=60s/)
  assert.match(line, /wait=300s/)
  // The whole point: who spent the window.
  assert.match(line, /own requests in that window: corpse-pricer=4 price-check=2 \(total 6\)/)
  // ... and that this counts OUR traffic only (the IP is shared with the
  // household's browser), so a small number is not read as "we did it anyway".
  assert.match(line, /this app only/)
})

test('429: counts only the offending window, older requests drop out', () => {
  const log = collector()
  let t = 1_000_000
  const audit = createTradeAudit({ log, now: () => t })
  audit.record({ url: SEARCH, status: 200, headers: headers(), consumer: CONSUMER.CORPSE })
  t += 120_000 // two minutes later — outside the 60s window
  audit.record({ url: SEARCH, status: 429, headers: headers({ state: '9:10:0,15:60:0', retryAfter: 300 }), consumer: CONSUMER.CORPSE })
  assert.match(log.lines.at(-1), /own requests in that window: corpse-pricer=1 \(total 1\)/)
})

test('missing / broken headers never throw and stay quiet', () => {
  const log = collector()
  const audit = createTradeAudit({ log })
  assert.doesNotThrow(() => {
    audit.record({ url: SEARCH, status: 200, headers: undefined })
    audit.record({ url: SEARCH, status: 200, headers: {} })
    audit.record({ url: SEARCH, status: 200, headers: headers({ ip: 'garbage', state: '' }) })
    audit.record({})
  })
  assert.equal(log.lines.length, 0, 'no rate-limit information -> nothing to report')
  // A 429 without usable headers still gets its line (consumer + event matter).
  audit.record({ url: SEARCH, status: 429, headers: {}, consumer: CONSUMER.CORPSE })
  assert.match(log.lines.at(-1), /429 from GGG — consumer=corpse-pricer .*wait=unknown/)
})

test('non-trade responses are ignored entirely', () => {
  const log = collector()
  const audit = createTradeAudit({ log })
  audit.record({ url: 'https://poe.ninja/api/data/x', status: 429, headers: headers({ retryAfter: 5 }) })
  assert.equal(log.lines.length, 0)
  assert.equal(audit.snapshot().requests, 0)
})

test('installTradeAudit: observes without changing the request', async () => {
  const log = collector()
  const audit = createTradeAudit({ log })
  const calls = []
  const target = {
    fetch: async (url, init) => {
      calls.push([url, init])
      return { status: 429, headers: headers({ state: '9:10:0,15:60:0', retryAfter: 300 }) }
    }
  }
  const off = installTradeAudit({ target, audit })
  const res = await withConsumer(CONSUMER.PRICE_CHECK, () => target.fetch(SEARCH, { method: 'POST' }))
  assert.equal(res.status, 429, 'response passed through untouched')
  assert.equal(calls.length, 1, 'exactly ONE request — the audit adds none')
  assert.match(log.lines.at(-1), /429 from GGG — consumer=price-check/)
  // Errors are not swallowed.
  target.fetch = async () => { throw new Error('boom') }
  off()
  assert.equal(typeof target.fetch, 'function')
})

test('installTradeAudit: a rejected fetch keeps rejecting', async () => {
  const target = { fetch: async () => { throw new Error('ECONNRESET') } }
  const off = installTradeAudit({ target, audit: createTradeAudit({ log: collector() }) })
  await assert.rejects(() => target.fetch(SEARCH), /ECONNRESET/)
  off()
})
