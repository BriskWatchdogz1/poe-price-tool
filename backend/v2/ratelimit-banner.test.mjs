// Boots the REAL server.mjs (same pattern as server.test.mjs) and checks the
// rate-limit banner message: when the shared trade queue gets rate-limited or
// banned (long Retry-After), a GLOBAL `rate-limit` banner must go out to ALL
// rooms — instead of cards hanging silently in "queued/searching" forever.
// Short (routine) Retry-Afters below the threshold must NOT raise a banner.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

// Env MUST be set before the import (top-level await reads it at load time).
process.env.PORT = '0'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_REFERENCE_DISABLED = '1'
process.env.POE_USERS = 'player1,player2'
process.env.POE_RATE_LIMIT_BANNER_MIN_SEC = '60' // threshold pinned explicitly

let mod
let base

before(async () => {
  mod = await import('./server.mjs')
  base = `127.0.0.1:${mod.server.address().port}`
})

after(async () => {
  mod.clearRateLimit()
  await new Promise((resolve) => mod.server.close(resolve))
})

// Connects as <user> and collects every message received.
function connectCollect (user) {
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: `ppt_user=${user}` } })
  const msgs = []
  ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())) } catch {} })
  return new Promise((res, rej) => { ws.on('open', () => res({ ws, msgs })); ws.on('error', rej) })
}

const settle = (ms = 120) => new Promise(r => setTimeout(r, ms))

test('noteRateLimit above the threshold -> active banner to ALL rooms (shared queue)', async () => {
  const a = await connectCollect('player1')
  const b = await connectCollect('player2')
  await settle()
  a.msgs.length = 0; b.msgs.length = 0

  const set = mod.noteRateLimit(3600) // 1h ban
  await settle()

  assert.equal(set, true, 'above the threshold -> banner set')
  const ma = a.msgs.find(m => m.type === 'rate-limit')
  const mb = b.msgs.find(m => m.type === 'rate-limit')
  assert.ok(ma && ma.active === true, 'player1 sees the active banner')
  assert.ok(mb && mb.active === true, 'player2 (shared queue) sees it as well')
  assert.equal(ma.retryAfterSec, 3600, 'retryAfterSec passed through')
  assert.ok(typeof ma.until === 'number' && ma.until > Date.now(), 'until lies in the future')
  assert.ok(typeof ma.message === 'string' && ma.message.length > 0, 'human-readable message included')

  a.ws.close(); b.ws.close()
  mod.clearRateLimit()
})

test('a fresh client gets the active banner as its connect snapshot', async () => {
  mod.noteRateLimit(3600)
  const a = await connectCollect('player1')
  await settle()
  const m = a.msgs.find(m => m.type === 'rate-limit')
  assert.ok(m && m.active === true, 'connect snapshot carries the active banner')
  a.ws.close()
  mod.clearRateLimit()
})

test('clearRateLimit -> inactive banner to everyone (searches run again)', async () => {
  mod.noteRateLimit(3600)
  const a = await connectCollect('player1')
  await settle()
  a.msgs.length = 0

  mod.clearRateLimit()
  await settle()

  const m = a.msgs.find(m => m.type === 'rate-limit')
  assert.ok(m && m.active === false, 'banner is taken down again')
  a.ws.close()
})

test('a short (routine) Retry-After below the threshold raises NO banner', async () => {
  const a = await connectCollect('player1')
  await settle()
  a.msgs.length = 0

  const set = mod.noteRateLimit(5) // 5s: normal serial-queue backpressure
  await settle()

  assert.equal(set, false, 'below the threshold -> no banner')
  assert.ok(!a.msgs.some(m => m.type === 'rate-limit' && m.active), 'no active banner broadcast')
  a.ws.close()
})

test('rateLimitMsg mirrors the state (active after note, inactive after clear)', () => {
  mod.noteRateLimit(3600)
  assert.equal(mod.rateLimitMsg().active, true, 'active after note')
  mod.clearRateLimit()
  assert.equal(mod.rateLimitMsg().active, false, 'inactive after clear')
})

test('rateLimitSeconds recognizes BOTH wordings — a real GGG ban AND client-side backpressure', () => {
  // THE core bug: GGG's real 429 arrives as "Rate limit exceeded; Please wait N
  // seconds before trying again." — the old regex (/^Retry after/) did NOT match
  // that, so on a real ban neither the banner nor the gate ever kicked in.
  assert.equal(mod.rateLimitSeconds('Rate limit exceeded; Please wait 40937 seconds before trying again.'), 40937, 'real GGG ban is recognized (the case that escalated 3h->11h)')
  assert.equal(mod.rateLimitSeconds('Retry after 12 seconds'), 12, 'client-side backpressure still recognized')
  assert.equal(mod.rateLimitSeconds('Please wait 5 second'), 5, 'singular "second" tolerated')
  // A real ban without a parsable number must STILL gate (conservative default),
  // not keep firing silently.
  assert.equal(mod.rateLimitSeconds('Rate limit exceeded, try again later'), 60, 'numberless ban -> conservative fallback')
  // Unrelated errors must NOT count as a rate limit (otherwise a parse error or
  // the like would stall the queue for nothing).
  assert.equal(mod.rateLimitSeconds('Invalid regex for mod info line'), null, 'not a rate limit -> null')
  assert.equal(mod.rateLimitSeconds('cookie expired'), null, 'not a rate limit -> null')
})

test('ban gate: pump() holds the queue while a ban is active (no further requests to GGG)', async () => {
  // The heart of the fix: while a ban is active NO job may fire — every request
  // sent during the ban is rejected and extends it (3h -> 11h).
  let ran = false
  mod.noteRateLimit(3600)                    // active ban
  mod.enqueueBackground(() => { ran = true }) // enqueue calls pump() -> must be gated
  await settle()
  assert.equal(ran, false, 'during a ban the job is HELD, not executed')
  assert.equal(mod.bgJobs.length, 1, 'job stays in the queue')

  mod.clearRateLimit()                       // ban gone -> held jobs resume
  await settle()
  assert.equal(ran, true, 'the held job runs after clearRateLimit')
  assert.equal(mod.bgJobs.length, 0, 'queue drained')
})
