// One detector for ALL rate-limit/ban wordings — the earlier drift (the
// harvester only knew "Retry after") caused two real bans. These tests pin down
// all three forms so that no copy can ever fall back again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rateLimitSeconds, isBanSignal, classifyRateLimit, shouldRaiseGlobalGate, RATE_LIMIT_FALLBACK_SEC } from './rate-limit-signal.mjs'

test('shouldRaiseGlobalGate: a LONG client wait is a real limit, not pacing', () => {
  // Real case: APT's limiter learns its windows from GGG's response headers. A
  // "Retry after 13283 seconds" (3.7h) of kind client means: GGG has locked us
  // out, we are merely not sending into it. Must raise banner+gate — otherwise
  // the card hangs silently on "queued" for 3.7h (exactly the observed bug).
  assert.equal(shouldRaiseGlobalGate({ seconds: 13283, kind: 'client' }), true)
  assert.equal(shouldRaiseGlobalGate({ seconds: 300, kind: 'client' }), true, 'threshold is inclusive')
})

test('shouldRaiseGlobalGate: a short client wait stays quiet (no false alarm)', () => {
  // The false alarm reported earlier: 60s of backpressure after a burst while
  // the user did nothing -> must not flag the whole app as "banned".
  assert.equal(shouldRaiseGlobalGate({ seconds: 60, kind: 'client' }), false)
  assert.equal(shouldRaiseGlobalGate({ seconds: 5, kind: 'client' }), false)
})

test('shouldRaiseGlobalGate: server/block always gates, however short', () => {
  assert.equal(shouldRaiseGlobalGate({ seconds: 5, kind: 'server' }), true)
  assert.equal(shouldRaiseGlobalGate({ seconds: 1, kind: 'block' }), true)
  assert.equal(shouldRaiseGlobalGate(null), false)
})

test('classifyRateLimit: kind separates client backpressure from real bans (for the global gate)', () => {
  // "Retry after" = client-side, BEFORE any request goes out -> not a ban, must
  // NOT raise the global banner (exactly the observed false alarm).
  assert.deepEqual(classifyRateLimit('Retry after 60 seconds'), { seconds: 60, kind: 'client' })
  // "Please wait" = GGG's real 429 -> server.
  assert.deepEqual(classifyRateLimit('Rate limit exceeded; Please wait 300 seconds before trying again.'), { seconds: 300, kind: 'server' })
  assert.deepEqual(classifyRateLimit('429 Too Many Requests'), { seconds: RATE_LIMIT_FALLBACK_SEC, kind: 'server' })
  // 403 / Cloudflare HTML / SyntaxError -> block.
  assert.deepEqual(classifyRateLimit(new SyntaxError('Unexpected token < in JSON')), { seconds: RATE_LIMIT_FALLBACK_SEC, kind: 'block' })
  assert.deepEqual(classifyRateLimit('403 Forbidden'), { seconds: RATE_LIMIT_FALLBACK_SEC, kind: 'block' })
  // An ordinary error -> null.
  assert.equal(classifyRateLimit('Invalid regex for mod info line'), null)
})

test('wording 1 — client-side backpressure "Retry after N seconds"', () => {
  assert.equal(rateLimitSeconds('Retry after 12 seconds'), 12)
  assert.equal(rateLimitSeconds(new Error('Retry after 3 second')), 3) // singular tolerated
})

test('wording 2 — a REAL GGG ban "Rate limit exceeded; Please wait N ..."', () => {
  // The case that escalated 3h->11h and that the old harvester regex did NOT see.
  assert.equal(rateLimitSeconds('Rate limit exceeded; Please wait 40937 seconds before trying again.'), 40937)
  assert.equal(rateLimitSeconds(new Error('Rate limit exceeded; Please wait 300 seconds before trying again.')), 300)
})

test('numberless ban -> conservative fallback instead of hammering on', () => {
  assert.equal(rateLimitSeconds('Rate limit exceeded, try again later'), RATE_LIMIT_FALLBACK_SEC)
  assert.equal(rateLimitSeconds('429 Too Many Requests'), RATE_LIMIT_FALLBACK_SEC)
})

test('wording 3 — 403 / Cloudflare HTML / JSON parse error = hard block', () => {
  assert.equal(rateLimitSeconds(new SyntaxError("Unexpected token '<', \"<html>\"... is not valid JSON")), RATE_LIMIT_FALLBACK_SEC)
  assert.equal(rateLimitSeconds({ status: 403, message: 'Forbidden' }), RATE_LIMIT_FALLBACK_SEC)
  assert.equal(rateLimitSeconds('403 Forbidden'), RATE_LIMIT_FALLBACK_SEC)
  assert.equal(rateLimitSeconds('Unexpected token < in JSON at position 0'), RATE_LIMIT_FALLBACK_SEC)
})

test('a structured retryAfter field is tolerated (in case the engine ever hands one over)', () => {
  assert.equal(rateLimitSeconds({ retryAfter: 90 }), 90)
})

test('NON-rate-limits -> null (they must never pause the queue)', () => {
  assert.equal(rateLimitSeconds('Invalid regex for mod info line'), null)
  assert.equal(rateLimitSeconds('cookie expired'), null)
  assert.equal(rateLimitSeconds(new Error('ECONNRESET')), null)
  assert.equal(rateLimitSeconds(null), null)
  assert.equal(rateLimitSeconds(''), null)
})

test('isBanSignal = rateLimitSeconds != null', () => {
  assert.equal(isBanSignal('Please wait 5 seconds'), true)
  assert.equal(isBanSignal('403 Forbidden'), true)
  assert.equal(isBanSignal('Invalid regex for mod info line'), false)
})
