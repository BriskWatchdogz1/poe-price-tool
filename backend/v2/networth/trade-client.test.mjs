// trade-client.mjs — minimal official trade search over an INJECTED transport
// (the real one = engine.searchRaw). Corpse searches are ANONYMOUS, so the real
// failure is IP-side: a 403 soft-ban, an unparseable/HTML (Cloudflare) body, or
// repeated 429s. The client adds the corpse search body + a SELF-HEALING backoff:
// a ban signal pauses ALL corpse trade calls for an (escalating, capped)
// cooldown, then AUTOMATICALLY retries — no permanent dead state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTradeClient } from './trade-client.mjs'

const silent = { error () {}, warn () {}, info () {}, log () {} }

test('searchListings builds the corpse query and passes the listings through', async () => {
  let seen = null
  const searchRaw = async (body, league, opts) => {
    seen = { body, league, opts }
    return { total: 3, listings: [{ priceAmount: 5, priceCurrency: 'chaos' }] }
  }
  const tc = createTradeClient({ searchRaw, log: silent })
  const listings = await tc.searchListings('Forest Tiger', 'Standard', { maxFetch: 8 })
  assert.deepEqual(listings, [{ priceAmount: 5, priceCurrency: 'chaos' }])
  assert.equal(seen.league, 'Standard')
  assert.equal(seen.opts.maxFetch, 8)
  assert.equal(seen.body.query.type, 'Forest Tiger')
  assert.deepEqual(seen.body.query.status, { option: 'online' })
  assert.equal(seen.body.query.filters.trade_filters.filters.sale_type.option, 'priced')
  assert.deepEqual(seen.body.sort, { price: 'asc' })
})

test('403 -> cooldown: follow-up calls short-circuit WITHOUT touching the transport', async () => {
  let calls = 0
  let clock = 1_000_000
  const searchRaw = async () => { calls++; const e = new Error('Forbidden'); e.status = 403; throw e }
  const tc = createTradeClient({ searchRaw, cooldownMs: 10_000, now: () => clock, log: silent })
  assert.equal(tc.isCircuitOpen(), false)

  await assert.rejects(() => tc.searchListings('A', 'Standard'))
  assert.equal(tc.isCircuitOpen(), true)
  assert.equal(calls, 1)

  // cooldown active -> transport NOT touched again
  await assert.rejects(() => tc.searchListings('B', 'Standard'), e => e.code === 'CIRCUIT_OPEN')
  assert.equal(calls, 1)
})

test('unparseable/HTML body (SyntaxError with no status) = ban signal', async () => {
  const searchRaw = async () => { throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON") }
  const tc = createTradeClient({ searchRaw, log: silent })
  await assert.rejects(() => tc.searchListings('A', 'Standard'))
  assert.equal(tc.isCircuitOpen(), true)
})

test('the cooldown heals itself: once it expires the transport is asked again', async () => {
  let clock = 0
  let banning = true
  let calls = 0
  const searchRaw = async () => {
    calls++
    if (banning) { const e = new Error('Forbidden'); e.status = 403; throw e }
    return { listings: [{ priceAmount: 1, priceCurrency: 'chaos' }] }
  }
  const tc = createTradeClient({ searchRaw, cooldownMs: 10_000, now: () => clock, log: silent })

  await assert.rejects(() => tc.searchListings('A', 'Standard')) // ban -> cooldown until 10_000
  assert.equal(tc.isCircuitOpen(), true)

  clock = 5_000
  await assert.rejects(() => tc.searchListings('A', 'Standard'), e => e.code === 'CIRCUIT_OPEN')
  assert.equal(calls, 1) // still in the cooldown -> no transport

  clock = 10_001 // cooldown expired
  banning = false
  assert.equal(tc.isCircuitOpen(), false)
  const listings = await tc.searchListings('A', 'Standard')
  assert.equal(calls, 2) // transport asked again
  assert.deepEqual(listings, [{ priceAmount: 1, priceCurrency: 'chaos' }])
  assert.equal(tc.isCircuitOpen(), false) // success -> streak reset
})

test('repeated bans escalate the cooldown (exponential, capped)', async () => {
  let clock = 0
  const searchRaw = async () => { const e = new Error('Forbidden'); e.status = 403; throw e }
  const tc = createTradeClient({ searchRaw, cooldownMs: 1000, maxCooldownMs: 4000, now: () => clock, log: silent })

  await assert.rejects(() => tc.searchListings('A', 'Standard'))
  assert.equal(tc.cooldownUntil(), 1000) // 1000 * 2^0

  clock = 1000
  await assert.rejects(() => tc.searchListings('A', 'Standard'))
  assert.equal(tc.cooldownUntil(), 1000 + 2000) // 1000 * 2^1

  clock = 3000
  await assert.rejects(() => tc.searchListings('A', 'Standard'))
  assert.equal(tc.cooldownUntil(), 3000 + 4000) // 1000 * 2^2

  clock = 7000
  await assert.rejects(() => tc.searchListings('A', 'Standard'))
  assert.equal(tc.cooldownUntil(), 7000 + 4000) // capped at maxCooldownMs
})

test('ONE 429 changes nothing; only repeated 429s trip the cooldown', async () => {
  let clock = 0
  const searchRaw = async () => { const e = new Error('Retry after 5 seconds'); e.status = 429; throw e }
  const tc = createTradeClient({ searchRaw, rateLimitThreshold: 3, now: () => clock, log: silent })

  await assert.rejects(() => tc.searchListings('A', 'Standard'))
  assert.equal(tc.isCircuitOpen(), false) // 1st 429 -> backoff is the queue's job
  await assert.rejects(() => tc.searchListings('A', 'Standard'))
  assert.equal(tc.isCircuitOpen(), false) // 2nd 429
  await assert.rejects(() => tc.searchListings('A', 'Standard'))
  assert.equal(tc.isCircuitOpen(), true)  // 3rd 429 -> threshold reached -> cooldown
})

test('one successful call in between resets the 429 streak', async () => {
  let clock = 0
  let mode = '429'
  const searchRaw = async () => {
    if (mode === '429') { const e = new Error('429'); e.status = 429; throw e }
    return { listings: [] }
  }
  const tc = createTradeClient({ searchRaw, rateLimitThreshold: 3, now: () => clock, log: silent })
  await assert.rejects(() => tc.searchListings('A', 'Standard')) // streak 1
  await assert.rejects(() => tc.searchListings('A', 'Standard')) // streak 2
  mode = 'ok'
  await tc.searchListings('A', 'Standard') // success -> streak 0
  mode = '429'
  await assert.rejects(() => tc.searchListings('A', 'Standard')) // streak 1 (not 3)
  assert.equal(tc.isCircuitOpen(), false)
})

test('resetCircuit lifts the cooldown manually', async () => {
  let clock = 0
  const searchRaw = async () => { const e = new Error('Forbidden'); e.status = 403; throw e }
  const tc = createTradeClient({ searchRaw, cooldownMs: 10_000, now: () => clock, log: silent })
  await assert.rejects(() => tc.searchListings('A', 'Standard'))
  assert.equal(tc.isCircuitOpen(), true)
  tc.resetCircuit()
  assert.equal(tc.isCircuitOpen(), false)
})
