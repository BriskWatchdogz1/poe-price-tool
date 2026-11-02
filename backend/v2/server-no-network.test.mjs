// Boots the REAL server with every switch the suite sets and MEASURES that
// nothing leaves the machine. The rule in CONTRIBUTING ("local runs and tests
// must never crawl or price live") was a rule with no instrument behind it, and
// it was being broken: with every outbound fetch logged, `server.test.mjs` and
// `server-langs.test.mjs` each sent two requests to poe.ninja — the
// currency-exchange overview and the beast overview — on every run
// (docs/bugs.md B12). Nothing in the suite could have told anybody.
//
// The two requests came from `warmLeague()`, which the WS connection handler
// calls when a room's league has no warm C:D / reference cache. Every test that
// opens a WebSocket walked into it, and `POE_REFERENCE_DISABLED=1` did not
// cover it — that switch is documented as skipping the one-time warm-up done at
// BOOT, and widening it would have changed what an existing deployment does.
// `POE_REFERENCE_ON_CONNECT_DISABLED=1` covers the client-triggered half, the
// same way `POE_PRICE_CHECK_DISABLED=1` covers the foreground price check.
//
// HOW THIS MEASURES RATHER THAN ASSERTS INTENT. `globalThis.fetch` is replaced
// before server.mjs is imported: every call is recorded, and anything that is
// not loopback is REJECTED instead of sent. So a regression here fails the
// assertion below and still does not reach GGG or poe.ninja from a test run.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { quietEnv } from './test-quiet-env.mjs'

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/

const calls = []
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input))
  calls.push(url)
  if (!LOOPBACK.test(url)) {
    // Never forwarded. A test that wants to reach the network is a bug in the
    // test, and the assertion below is what reports it.
    return Promise.reject(new Error(`outbound request blocked in the test suite: ${url}`))
  }
  return realFetch(input, init)
}
/** Everything that was aimed at somebody else's server. */
const outbound = () => calls.filter(u => !LOOPBACK.test(u))

// Env MUST be set before server.mjs is imported (its top-level await reads it
// at module load time). This is the full set a test run is expected to carry:
// four background schedules, the foreground price check, and the on-connect
// reference warm-up.
// The full set that keeps a booted server off the network. One list, imported:
// every file that wrote it out by hand left something out, and what kept being
// left out was the switch a WebSocket needs (test-quiet-env.mjs, docs/bugs.md
// B25). Applied FIRST — anything this file sets below overrides it on purpose.
quietEnv()
process.env.PORT = '0'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_REFERENCE_DISABLED = '1'
process.env.POE_REFERENCE_ON_CONNECT_DISABLED = '1'
process.env.POE_PRICE_CHECK_DISABLED = '1'
process.env.POE_NETWORTH_AUTOSYNC = '0'
process.env.POE_USERS = 'player1,player2'

let mod
let base

before(async () => {
  mod = await import('./server.mjs')
  base = `127.0.0.1:${mod.server.address().port}`
})

after(async () => {
  await new Promise((resolve) => mod.server.close(resolve))
  globalThis.fetch = realFetch
})

const MAGEBLOOD = `Item Class: Belts
Rarity: Unique
Mageblood
Heavy Belt
--------
Item Level: 86
--------
Your Flasks gain 0.15 Charges per Second
--------
`

test('booting the server reaches nobody', () => {
  assert.deepEqual(outbound(), [], 'import-time requests: every background schedule is off')
})

test('a WS connection does not warm its league over the network', async () => {
  // THE B12 CASE. The room's league has no cached C:D ratio and no cached
  // reference rail — a cold cache is exactly what makes the connection handler
  // call warmLeague() — and the two poe.ninja requests it used to send are what
  // this whole file exists to keep out.
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=player1' } })
  const seen = []
  ws.on('message', d => { try { seen.push(JSON.parse(d.toString()).type) } catch {} })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  await new Promise(r => setTimeout(r, 300))
  ws.close()

  assert.ok(seen.includes('league-state'), 'the room still opens normally')
  assert.ok(seen.includes('cd-ratio'), 'and still gets a C:D message — the fallback one')
  assert.deepEqual(outbound(), [], 'a WS connect sent something out')
})

test('switching a room to another league does not fetch for it either', async () => {
  // The second client-triggered reference fetch, and the same switch has to
  // cover it: otherwise "the server reaches nothing" would depend on which
  // message a browser happens to send.
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=player2' } })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  ws.send(JSON.stringify({ type: 'set-league', league: 'SomeOtherLeague' }))
  await new Promise(r => setTimeout(r, 300))
  ws.close()

  assert.equal(mod.users.get('player2').league, 'SomeOtherLeague', 'the switch itself still happened')
  assert.deepEqual(outbound(), [], 'a league switch sent something out')
})

test('pasting an item creates a card and no request', async () => {
  const r = await fetch(`http://${base}/item`, {
    method: 'POST', headers: { 'X-User': 'player1' }, body: MAGEBLOOD
  })
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.ok(j.id, 'the card was created')
  await new Promise(res => setTimeout(res, 300))
  assert.deepEqual(outbound(), [], 'POSTing an item sent something out')
})

test('the whole file made loopback calls only, and it really did make some', () => {
  // Guards the instrument itself: an assertion that nothing was recorded would
  // also pass if the recorder had never been installed.
  assert.ok(calls.length > 0, 'the fetch recorder saw nothing at all — is it still wired up?')
  assert.deepEqual(outbound(), [])
})
