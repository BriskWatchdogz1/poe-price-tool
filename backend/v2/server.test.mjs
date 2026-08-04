// Boots the REAL backend/v2/server.mjs on a random port, originally just to
// check GET /users (brand name via POE_APP_NAME). PORT=0 plus
// POE_FAUSTUS_DISABLED=1, POE_CORPSE_DISABLED=1, POE_DATA_REFRESH_DISABLED=1 and
// POE_REFERENCE_DISABLED=1 turn off the four background network schedules
// server.mjs would otherwise start on import (the Faustus CDN refresher, the
// corpse Trade-API pricer, the APT/RePoE data auto-update, and the C:D ratio +
// reference rail warm-up) — no live crawl, no network polling in tests.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

// Env MUST be set before server.mjs is imported (its top-level await reads it at
// module load time).
process.env.PORT = '0'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_REFERENCE_DISABLED = '1'
process.env.POE_APP_NAME = 'Custom Console'
// Dedicated users so the robustness tests don't fight the dedup tests' rooms.
process.env.POE_USERS = 'player1,player2,capuser,requser,xuser'
// Small caps -> the tests can exercise eviction/requeue without posting 50+.
process.env.POE_MAX_ITEMS_PER_ROOM = '3'
process.env.POE_MAX_REQUEUE_ON_RECONNECT = '2'

let mod
let base

before(async () => {
  mod = await import('./server.mjs')
  base = `127.0.0.1:${mod.server.address().port}`
})

after(async () => {
  await new Promise((resolve) => mod.server.close(resolve))
})

test('GET /users: serves appName from POE_APP_NAME on top of the existing users list', async () => {
  const r = await fetch(`http://${base}/users`)
  const j = await r.json()
  assert.equal(j.appName, 'Custom Console')
  assert.ok(Array.isArray(j.users) && j.users.length, 'users is still there, unchanged')
})

// --- Bug 1: one hotkey press -> exactly ONE card, uniques included -----------
// Root cause: /item hands out a fresh id per POST (makeId + idSeq). A unique's
// clipboard text can show up again a blink later as slightly different raw text
// (the flavour-text block that rares/currency/gems do not have) -> the daemon's
// exact-text dedupe sees "two items" and POSTs both. Without server-side
// idempotency that turns into two identical cards. These tests pin down: the
// same parsed item within the window -> one card; a different item -> its own
// card.

// Collects the item-added ids of a fresh WS connection as player1.
async function collectAddedIds (postFns) {
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=player1' } })
  const ids = new Set()
  ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m.type === 'item-added') ids.add(m.id) } catch {} })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  for (const fn of postFns) await fn()
  await new Promise(r => setTimeout(r, 300)) // let broadcasts settle
  ws.close()
  return ids
}

const post = (body) => fetch(`http://${base}/item`, {
  method: 'POST', headers: { 'X-User': 'player1' }, body
}).then(r => r.json())

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
// Second clipboard read of the same unique: differs ONLY in the appended
// flavour text -> different raw text, identical parse.
const MAGEBLOOD_FLAVOUR = MAGEBLOOD + `Kaom's blood boiled with a rage that transcended death itself.
--------
`
const HEADHUNTER = `Item Class: Belts
Rarity: Unique
Headhunter
Leather Belt
--------
Item Level: 84
--------
+40 to maximum Life
--------
`

test('POST /item: unique flicker (same parse, different raw text) yields ONE card', async () => {
  let a, b
  const ids = await collectAddedIds([
    async () => { a = await post(MAGEBLOOD) },
    async () => { await new Promise(r => setTimeout(r, 120)); b = await post(MAGEBLOOD_FLAVOUR) }
  ])
  assert.equal(b.deduped, true, 'the second post is recognised as a duplicate')
  assert.equal(a.id, b.id, 'both posts point at the same card')
  const magebloodCards = [...ids].filter(i => i.startsWith('mageblood-'))
  assert.equal(magebloodCards.length, 1, 'exactly one Mageblood card despite two POSTs')
})

test('POST /item: different uniques stay separate cards (no over-collapse)', async () => {
  let a, b
  await collectAddedIds([
    async () => { a = await post(MAGEBLOOD) },
    async () => { await new Promise(r => setTimeout(r, 50)); b = await post(HEADHUNTER) }
  ])
  assert.notEqual(a.id, b.id, 'Mageblood and Headhunter get their own ids')
  assert.ok(!b.deduped, 'a different item is not deduped away')
})

// Corrupted items price in a market of their own -> the auto-search has to
// filter on corrupted=yes by default (exact:true), otherwise it counts the cheap
// non-corrupted twins as well (observed: 1c/any vs 3-30c/yes). The engine hands
// out {value:true, exact:false} by itself (= "any", which is not sent).
const CORRUPTED_RARE = `Item Class: Helmets
Rarity: Rare
Test Visage
Callous Mask
--------
Sockets: W G-W
--------
Item Level: 54
--------
{ Prefix Modifier "Sanguine" (Tier: 8) — Life }
+33(25-39) to maximum Life
--------
Corrupted`

test('POST /item: corrupted item -> auto-search defaults to corrupted=yes (exact:true), not "any"', async () => {
  const r = await post(CORRUPTED_RARE)
  const rec = mod.users.get('player1').items.get(r.id)
  assert.ok(rec, 'card was created')
  assert.deepEqual(rec.preset.filters.corrupted, { value: true, exact: true },
    'corrupted filter active by default (yes) -> otherwise the auto-search prices the non-corrupted twins along with it')
})

// --- Fix A/1: room.items is capped (MAX_ITEMS_PER_ROOM) ----------------------
// Root cause: cards live server-side until they are dismissed (no TTL, no cap)
// -> the map grows without bound (a slow memory leak). Fix: keep the NEWEST N;
// an (N+1)-th card evicts the OLDEST one and sends item-removed to the room.
// The parser only accepts REAL uniques (item.unknown otherwise); these belts all
// share the "Heavy Belt" base -> they parse with one simple mod.
const belt = (name) => `Item Class: Belts
Rarity: Unique
${name}
Heavy Belt
--------
Item Level: 86
--------
+25 to maximum Life
--------
`
const CAP_BELTS = ["Bisco's Leash", "Meginord's Girdle", "Doryani's Invitation", 'Belt of the Deceiver']
const postAs = (user, body) => fetch(`http://${base}/item`, {
  method: 'POST', headers: { 'X-User': user }, body
}).then(async r => ({ status: r.status, body: await r.json() }))

test('POST /item: the cap evicts the oldest card and sends item-removed (MAX_ITEMS_PER_ROOM=3)', async () => {
  // Observer WS as capuser: collects the item-added and item-removed ids.
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=capuser' } })
  const added = new Set() // distinct ids (a card re-broadcasts on queued/searching/error)
  const removed = []
  ws.on('message', d => {
    try {
      const m = JSON.parse(d.toString())
      if (m.type === 'item-added') added.add(m.id)
      else if (m.type === 'item-removed') removed.push(m.id)
    } catch {}
  })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })

  // 4 different uniques (no dedupe) in a row -> cap=3 -> the 1st one is evicted.
  // capuser is a dedicated, fresh room -> an exact count is possible.
  const r1 = await postAs('capuser', belt(CAP_BELTS[0]))
  const r2 = await postAs('capuser', belt(CAP_BELTS[1]))
  const r3 = await postAs('capuser', belt(CAP_BELTS[2]))
  const r4 = await postAs('capuser', belt(CAP_BELTS[3]))
  await new Promise(r => setTimeout(r, 300))
  ws.close()

  assert.equal(r1.status, 200, 'post 1 ok')
  const firstId = r1.body.id
  assert.equal(added.size, 4, 'all 4 cards (distinct ids) arrived')
  assert.deepEqual(removed, [firstId], 'exactly the oldest (1st) card is evicted via item-removed')

  // Reconnect replay: the room only holds the newest 3.
  const ws2 = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=capuser' } })
  const replay = new Set()
  ws2.on('message', d => { try { const m = JSON.parse(d.toString()); if (m.type === 'item-added') replay.add(m.id) } catch {} })
  await new Promise((res, rej) => { ws2.on('open', res); ws2.on('error', rej) })
  await new Promise(r => setTimeout(r, 300))
  ws2.close()

  assert.equal(replay.size, 3, 'after the cap the room holds exactly 3 cards')
  assert.ok(!replay.has(firstId), 'the evicted card is gone server-side')
  assert.deepEqual([...replay].sort(), [r2.body.id, r3.body.id, r4.body.id].sort(), 'and they are the newest 3')
})

// --- Fix A/2: the reconnect requeue is capped (MAX_REQUEUE_ON_RECONNECT) -----
// Root cause: every WS reconnect re-queues ALL unpriced cards -> after a
// poe.ninja/trade outage a single reconnect sets off a queue flood. Fix:
// re-enqueue only the newest N. Tested deterministically by "parking" the worker
// with a background job that never resolves (working=true) -> the reconnect
// enqueues just sit in `jobs` and are never drained.
test('reconnect: only the newest N unpriced cards are re-enqueued (MAX=2)', async () => {
  // Wait until the queue is empty (auto jobs from earlier tests drained).
  const t0 = Date.now()
  while (mod.jobs.length > 0 && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 50))

  // Park the worker: a background job that never resolves -> working=true (set
  // synchronously in pump), so follow-up enqueues only push, they never drain.
  let releaseWorker
  mod.enqueueBackground(() => new Promise(res => { releaseWorker = res }))
  await new Promise(r => setTimeout(r, 50))
  mod.jobs.length = 0 // clear out any foreign jobs (only for a clean measurement)

  // Fill the requser room with 3 unpriced cards (oldest -> newest).
  const room = mod.users.get('requser')
  room.items.clear()
  for (const id of ['req-old', 'req-mid', 'req-new']) {
    room.items.set(id, { id, addedMsg: { type: 'item-added', id }, alive: true, status: 'queued', lastPrice: null })
  }

  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=requser' } })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  await new Promise(r => setTimeout(r, 300))

  const requeued = mod.jobs.filter(j => j.user === 'requser').map(j => j.id).sort()
  assert.equal(requeued.length, 2, 'exactly 2 (the cap) unpriced cards re-enqueued, no flood')
  assert.deepEqual(requeued, ['req-mid', 'req-new'], 'and they are the NEWEST two, not the oldest')
  assert.ok(!requeued.includes('req-old'), 'the oldest unpriced card is not re-enqueued')

  // Cleanup.
  if (releaseWorker) releaseWorker()
  mod.jobs.length = 0
  room.items.clear()
  ws.close()
})

// --- Fix B: an unknown X-User is rejected, not silently folded into USERS[0] --
// Root cause: a typo in X-User silently fell back to USERS[0] (HTTP 200) -> the
// player with the typo never saw a card, and USERS[0] got someone else's items
// in their room. Fix: 400 + console.warn, and the USERS[0] room stays clean.
test('POST /item: an unknown X-User is rejected with 400 (no silent USERS[0] fallback)', async () => {
  // Observer for USERS[0] (player1): must NOT get a card because of the typo.
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=player1' } })
  const added = []
  ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m.type === 'item-added') added.push(m.id) } catch {} })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })

  const before = added.length
  const r = await postAs('capuserr' /* typo */, belt('TypoBelt'))
  await new Promise(r => setTimeout(r, 200))
  ws.close()

  assert.equal(r.status, 400, 'unknown X-User -> HTTP 400')
  assert.match(r.body.error, /unknown user/i, 'clear error message')
  assert.ok(Array.isArray(r.body.users) && r.body.users.includes('player1'), 'the valid user list comes along')
  assert.equal(added.length - before, 0, 'USERS[0] (player1) gets NO card that is not theirs')
})

test('POST /item: a missing X-User still falls back to USERS[0] (headerless stays intact)', async () => {
  const r = await fetch(`http://${base}/item`, { method: 'POST', body: belt('Mageblood') }).then(async x => ({ status: x.status, body: await x.json() }))
  assert.equal(r.status, 200, 'still 200 without the header')
  assert.equal(r.body.user, 'player1', 'lands in the USERS[0] room')
})

// --- W2: the configured league is ALWAYS refreshed (headless included) -------
// Root cause: the C:D refresh interval only updated cdMsgFor for leagues with
// CONNECTED clients. But the corpse pricer + faustus bridge read cdMsgFor(LEAGUE)
// passively -> with the server running headless (no tab open), divine
// normalisation froze at its boot value. Fix: unconditionally put the configured
// league (POE_LEAGUE, exported as mod.LEAGUE) into the refresh set. No test
// client ever joins that league's room, so its presence in the set proves the
// unconditional injection, independent of connected clients.
test('leaguesToRefresh: the configured league is in there, even with no client connected', () => {
  const set = mod.leaguesToRefresh()
  assert.ok(set.has(mod.LEAGUE), 'POE_LEAGUE is always in the refresh set')
})

// --- H3: negative/0 cap overrides are clamped to >=1 (no endless loop) -------
test('positiveEnvInt: negative/0/NaN are guarded (lower bound 1)', () => {
  assert.equal(mod.positiveEnvInt('-5', 50), 1, 'negative -> clamped to 1 (endless loop otherwise)')
  assert.equal(mod.positiveEnvInt('0', 50), 50, '0 -> default (|| fallback)')
  assert.equal(mod.positiveEnvInt(undefined, 10), 10, 'unset -> default')
  assert.equal(mod.positiveEnvInt('abc', 10), 10, 'NaN -> default')
  assert.equal(mod.positiveEnvInt('7', 50), 7, 'a valid value is kept')
})
