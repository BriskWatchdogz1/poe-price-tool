// The stack size of the last sync behind a single whisper for a stackable
// (reason 'stack-unknown', the `stack` field, frontend/PROTOCOL.md), through
// the REAL server: server.mjs hands the whisper pricer
// `createStackLookup(networthStore)`. The pricer and the lookup have unit
// tests of their own (whisper-price.test.mjs, networth/listing-audit.test.mjs);
// this file pins the wiring between them, which no unit test sees. The same
// for the entry's `quad` field: the whisper handler's
// `createQuadLookup(networthStore)`.
//
// PRICING IS ON HERE, DELIBERATELY: with POE_PRICE_CHECK_DISABLED a whisper
// stops at 'pricing-off' before any stack size is looked up. Nothing leaves
// the machine for it: the market value comes from a Faustus store seeded in a
// temp directory (the valuator reads the store; the Faustus refresher stays
// off), a chaos price needs no rate, and the runner's guard
// (test-net-guard.mjs) fails the run on any request that is not loopback.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quietEnv } from './test-quiet-env.mjs'

const LEAGUE = 'Mercenaries'
const USER = 'player1'
const tmp = mkdtempSync(join(tmpdir(), 'ppt-whisper-stack-'))

quietEnv()
delete process.env.POE_PRICE_CHECK_DISABLED
Object.assign(process.env, {
  PORT: '0',
  POE_LEAGUE: LEAGUE,
  POE_USERS: `${USER},player2`,
  POE_USER_LANG_STORE: join(tmp, 'user-langs.json'),
  POE_CONFIG_OVERRIDES: join(tmp, 'overrides.json'),
  POE_ADMIN_PASSWORD_FILE: join(tmp, 'admin-password'),
  POE_NETWORTH_CONFIG: join(tmp, 'networth-users.json'),
  POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
  POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
  POE_NETWORTH_SESSIONS: join(tmp, 'networth-sessions.json'),
  POE_FAUSTUS_STORE: join(tmp, 'faustus-store.json'),
  POE_CORPSE_STORE: join(tmp, 'corpse-store.json'),
  POE_WHISPER_PRICE_DEADLINE_MS: '4000'
})

// What a sync stores for a priced stack with a price note: 0-based cell x 4,
// y 2, which the whisper names as left 5, top 3 (networth/store.mjs `listed`).
writeFileSync(process.env.POE_NETWORTH_STORE, JSON.stringify({
  schema_version: 2,
  users: {
    [USER]: {
      accountName: null,
      league: LEAGUE,
      cdRatio: null,
      history: [],
      tabs: {
        0: {
          index: 0,
          name: 'Sale',
          syncedAt: Date.now(),
          items: [],
          unpriced: [],
          counts: { priced: 1, unpriced: 0, unpricedPieces: 0, skipped: 0 },
          listed: [{ name: 'Orb of Alchemy', kind: 'stackable', qty: 20, x: 4, y: 2, note: '~price 100 chaos', fromTab: false, chaosEach: 0.4, uncertain: null }]
        },
        // A quad tab, with the type a sync stores since it keeps one ('Sale'
        // above was written before and has none).
        1: {
          index: 1,
          name: 'Quad',
          type: 'QuadStash',
          syncedAt: Date.now(),
          items: [],
          unpriced: [],
          counts: { priced: 0, unpriced: 0, unpricedPieces: 0, skipped: 0 },
          listed: []
        }
      }
    }
  }
}))

let mod, base

before(async () => {
  mod = await import('./server.mjs')
  if (!mod.server.listening) await new Promise(resolve => mod.server.once('listening', resolve))
  base = `http://127.0.0.1:${mod.server.address().port}`
  await mod.faustusStore.setPrices(LEAGUE, { 'Orb of Alchemy': 0.4 })
})

after(async () => {
  await new Promise(resolve => mod.server.close(resolve))
  await rm(tmp, { recursive: true, force: true })
})

const whisper = (left, top, tab = 'Sale') =>
  `Hi, I would like to buy your Orb of Alchemy listed for 100 chaos in ${LEAGUE} (stash tab "${tab}"; position: left ${left}, top ${top})`

async function post (user, wid, body) {
  const r = await fetch(`${base}/daemon/whisper`, {
    method: 'POST',
    headers: { 'X-User': user, 'X-PPT-Daemon': '9.9.9', 'X-PPT-Instance': 'i1', 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, wid, body, label: 'buyer 1' })
  })
  assert.equal(r.status, 200)
  return (await r.json()).entry
}

test('a single whisper for a stackable takes its stack size from the stored sync', async () => {
  const e = await post(USER, 'w1', whisper(5, 3))
  assert.equal(e.verdict, 'not-compared')
  assert.equal(e.reason, 'stack-unknown')
  assert.equal(e.asked.chaos, 100)
  assert.equal(e.market.chaosEach, 0.4)
  assert.deepEqual(e.stack, { size: 20, from: 'sync', chaosEach: 5 })

  // Another cell, or a player whose store holds nothing there: per unit only.
  const other = await post(USER, 'w2', whisper(6, 3))
  assert.equal(other.reason, 'stack-unknown')
  assert.equal(other.stack, null)
  const second = await post('player2', 'w1', whisper(5, 3))
  assert.equal(second.reason, 'stack-unknown')
  assert.equal(second.stack, null, "another player's sync is never read")
})

// A whisper in a language the server has no item names for (French here):
// server.mjs hands the pricer the loaded languages to borrow an exact name
// from, so an English name in it is compared like an English whisper, and a
// French name is shown as text with its listed price, without a verdict.
test('a whisper in a language without data borrows an exact name from a loaded language', async () => {
  const fr = item => `Bonjour, je souhaiterais t'acheter ${item} pour 100 chaos dans la ligue ${LEAGUE} (onglet de réserve "Sale" ; 5e en partant de la gauche, 3e en partant du haut)`
  const known = await post(USER, 'w3', fr('Orb of Alchemy'))
  assert.equal(known.lang, 'fr')
  assert.equal(known.reason, 'stack-unknown')
  assert.equal(known.market.chaosEach, 0.4)
  assert.deepEqual(known.stack, { size: 20, from: 'sync', chaosEach: 5 })

  const foreign = await post(USER, 'w4', fr("Orbe d'alchimie"))
  assert.equal(foreign.verdict, 'not-compared')
  assert.equal(foreign.reason, 'no-language-data')
  assert.equal(foreign.item.text, "Orbe d'alchimie")
  assert.equal(foreign.asked.chaos, 100)
})

test('the entry says whether its tab is a quad tab by the type the sync stored', async () => {
  assert.equal((await post(USER, 'w5', whisper(14, 20, 'Quad'))).quad, true)
  assert.equal((await post(USER, 'w6', whisper(5, 3))).quad, null, 'a stored tab without a type tells nothing')
  assert.equal((await post(USER, 'w7', whisper(5, 3, 'Nope'))).quad, null, 'a tab the sync has not seen')
  assert.equal((await post('player2', 'w5', whisper(14, 20, 'Quad'))).quad, null, "another player's sync is never read")
})
