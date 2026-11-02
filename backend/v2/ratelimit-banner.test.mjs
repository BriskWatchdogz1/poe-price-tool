// Boots the REAL server.mjs (same pattern as server.test.mjs) and checks the
// rate-limit banner message: when the shared trade queue gets rate-limited or
// banned (long Retry-After), a GLOBAL `rate-limit` banner must go out to ALL
// rooms — instead of cards hanging silently in "queued/searching" forever.
// Short (routine) Retry-Afters below the threshold must NOT raise a banner.
// Since B14 the same gate also stops the net-worth refresher, which is checked
// at the bottom — this file is where the gate and its consumers meet.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { quietEnv } from './test-quiet-env.mjs'

// Env MUST be set before the import (top-level await reads it at load time).
// The full set that keeps a booted server off the network. One list, imported:
// every file that wrote it out by hand left something out, and what kept being
// left out was the switch a WebSocket needs (test-quiet-env.mjs, docs/bugs.md
// B25). Applied FIRST — anything this file sets below overrides it on purpose.
quietEnv()
// PRICING IS ON HERE, DELIBERATELY, and it is the one switch of the quiet set
// this file turns back off: the banner is raised BY a rate-limited price job. Nothing leaves
// the machine for it — `fetch` is stubbed in this file, and the runner's guard
// (test-net-guard.mjs) blocks anything that is not loopback anyway. Written out
// rather than left implicit, because "this file prices" used to be visible only
// as the ABSENCE of a line.
delete process.env.POE_PRICE_CHECK_DISABLED
// And this one, for the same reason and with the same protection: the net-worth refresher is what has to be seen pausing.
delete process.env.POE_NETWORTH_AUTOSYNC
process.env.PORT = '0'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_REFERENCE_DISABLED = '1'
// …and the reference warm-up a WS CONNECTION sets off, which the boot switch
// above does not cover: every connection below opens a room whose league has a
// cold cache, and that used to be two poe.ninja requests per run (docs/bugs.md
// B12). Measured, not assumed — see server-no-network.test.mjs.
process.env.POE_REFERENCE_ON_CONNECT_DISABLED = '1'
process.env.POE_USERS = 'player1,player2'
process.env.POE_RATE_LIMIT_BANNER_MIN_SEC = '60' // threshold pinned explicitly
// A writable store, so the background refresher is actually STARTED here: the
// B14 test below asserts on the object the server wired the ban gate into, and
// a null refresher would let it pass by accident. No credentials are configured,
// so its ticks load an empty user list and send nothing.
const tmpStoreDir = mkdtempSync(join(tmpdir(), 'ppt-rlban-'))
process.env.POE_NETWORTH_STORE = join(tmpStoreDir, 'networth-store.json')
process.env.POE_NETWORTH_CONFIG = join(tmpStoreDir, 'networth-users.json')

let mod
let base

before(async () => {
  mod = await import('./server.mjs')
  base = `127.0.0.1:${mod.server.address().port}`
})

after(async () => {
  mod.clearRateLimit()
  mod.networthRefresher?.stop()
  await new Promise((resolve) => mod.server.close(resolve))
  rmSync(tmpStoreDir, { recursive: true, force: true })
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

// ---------------------------------------------------------------------------
// B14: the same gate holds the NET-WORTH refresher. The two paths used to be
// gated separately, on the reading that each spends a budget of its own; what
// ended that reading is a ban reported to apply to the whole ADDRESS. Checked
// here, where the wiring is assembled — how the refresher behaves once the gate
// is up is networth/refresher-status.test.mjs.
// ---------------------------------------------------------------------------
test('a real trade ban pauses the net-worth refresher, and the status says it was a trade ban', () => {
  assert.equal(mod.tradeBanPause(), false, 'no ban -> nothing paused')
  assert.ok(mod.networthRefresher, 'no refresher was started — this test would prove nothing')
  assert.deepEqual(mod.networthRefresher.statusFor('player1', 'whatever'), { state: 'ok' })

  mod.noteRateLimit(3600)
  const pause = mod.tradeBanPause()
  assert.ok(pause && typeof pause.until === 'number', 'the gate hands over an end time, not a bare stop')
  assert.equal(pause.until, mod.rateLimitMsg().until, 'the same `until` pump() gates on — one ban, one clock')

  const st = mod.networthRefresher.statusFor('player1', 'whatever')
  assert.equal(st.state, 'cooldown')
  assert.equal(st.tradeBan, true, 'a stash 429 and a trade ban must not read the same')
  assert.equal(st.mine, undefined, 'a trade ban belongs to the address, not to one session')
  assert.equal(st.until, pause.until)

  mod.clearRateLimit()
  assert.equal(mod.tradeBanPause(), false)
  assert.deepEqual(mod.networthRefresher.statusFor('player1', 'whatever'), { state: 'ok' },
    'the pause lifts with the ban, without a restart and without a timer of its own')
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
