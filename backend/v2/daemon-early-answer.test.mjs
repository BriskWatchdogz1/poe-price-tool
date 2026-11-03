// Two things the hotkey daemon's feed adds to POST /item, against the real
// server in-process: the early Currency Exchange answer (from memory, before
// the queued job), and the queue position of a card that waits.
//
// Faustus is ON here, deliberately, so faustusChaosFor has a store to read.
// Nothing leaves the machine: `fetch` is replaced before server.mjs is
// imported, every call is recorded, and anything that is not loopback is
// rejected (the runner's guard, test-net-guard.mjs, blocks it as well). The
// Faustus refresher's one boot tick fails on that, and the test then writes
// the store itself. Pricing stays off (POE_PRICE_CHECK_DISABLED=1), so a
// queued job ends in 'error' without a request.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quietEnv } from './test-quiet-env.mjs'

const dir = await mkdtemp(join(tmpdir(), 'ppt-early-'))
quietEnv()
delete process.env.POE_FAUSTUS_DISABLED
process.env.PORT = '0'
process.env.POE_LEAGUE = 'EarlyLeague'
process.env.POE_USERS = 'player1,player2'
process.env.POE_FAUSTUS_STORE = join(dir, 'faustus-store.json')
process.env.POE_REFERENCE_HISTORY = join(dir, 'reference-history.ndjson')
process.env.POE_USER_LANG_STORE = join(dir, 'user-langs.json')
process.env.POE_CONFIG_OVERRIDES = join(dir, 'overrides.json')
process.env.POE_NETWORTH_STORE = join(dir, 'networth-store.json')
process.env.POE_NETWORTH_CONFIG = join(dir, 'networth-users.json')

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/
const outbound = []
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input))
  if (!LOOPBACK.test(url)) {
    outbound.push(url)
    return Promise.reject(new Error(`outbound request blocked in this test: ${url}`))
  }
  return realFetch(input, init)
}

const DIVINE = `Item Class: Stackable Currency
Rarity: Currency
Divine Orb
--------
Stack Size: 3/10
--------
Randomises the numeric values of the random modifiers on an item
--------
Right click this item then left click a magic, rare or unique item to apply it.
Shift click to unstack.
`
const EXALTED = `Item Class: Stackable Currency
Rarity: Currency
Exalted Orb
--------
Stack Size: 2/10
--------
Enchants a rare item with a new random modifier
--------
Right click this item then left click a rare item to apply it. Rare items can have up to six random modifiers.
Shift click to unstack.
`
const belt = name => `Item Class: Belts
Rarity: Rare
${name}
Leather Belt
--------
Item Level: 80
--------
+30 to maximum Life
--------
`

let mod, base
const sleep = ms => new Promise(r => setTimeout(r, ms))
const H = (user, instance = 'i1') => ({ 'X-User': user, 'X-PPT-Daemon': '9.9.9', 'X-PPT-Instance': instance })
const feed = (user, qs = 'wait=0') => fetch(`${base}/daemon/events?${qs}`, { headers: H(user) }).then(r => r.json())
const post = (text, user) => fetch(`${base}/item`, { method: 'POST', headers: H(user), body: text }).then(r => r.json())

before(async () => {
  mod = await import('./server.mjs')
  base = `http://127.0.0.1:${mod.server.address().port}`
  // Let the refresher's boot tick run into the blocked fetch, then write the
  // store for the server's league.
  const t0 = Date.now()
  while (!outbound.some(u => u.includes('poecdn')) && Date.now() - t0 < 3000) await sleep(25)
  await sleep(100)
  await mod.faustusStore.setPrices('EarlyLeague', { 'Divine Orb': 212.34, 'Exalted Orb': 14.2 }, Date.now(), { 'Divine Orb': [205, 220], 'Exalted Orb': [13, 15] })
})
after(async () => {
  globalThis.fetch = realFetch
  await new Promise(r => mod.server.close(r))
  await rm(dir, { recursive: true, force: true })
})

test('the early exchange answer comes from memory only', async () => {
  const start = await feed('player1')
  const sent = outbound.length
  const { id } = await post(DIVINE, 'player1')
  await sleep(150)
  const { events } = await feed('player1', `since=${start.seq}&boot=${start.boot}&wait=0`)
  const mine = events.filter(e => e.kind === 'item' && e.id === id)
  assert.ok(mine.length >= 3, JSON.stringify(mine))
  assert.equal(mine[0].status, 'queued', "the card's own first event")
  assert.equal(mine[0].price, null)
  const early = mine.find(e => e.price?.early)
  assert.ok(early, 'an event before the final one carries the early answer')
  assert.ok(mine.indexOf(early) < mine.length - 1)
  assert.equal(early.final, false)
  assert.deepEqual(early.price, { source: 'exchange', currency: 'chaos', median: 212.3, low: 205, high: 220, count: null, ageHours: null, conflict: false, early: true })
  assert.equal(early.stack, 3)
  // No poe.ninja answer in this test: the built-in fallback rate is no market
  // rate, so the game is told none rather than shown it as one.
  assert.ok(mine.every(e => e.cd === null), JSON.stringify(mine.map(e => e.cd)))
  assert.equal(mine.at(-1).status, 'error', 'POE_PRICE_CHECK_DISABLED: the job ends without a price')
  assert.equal(mine.at(-1).final, true)
  assert.deepEqual(outbound.slice(sent), [], 'the POST and the feed sent nothing anywhere')
})

test('an old daemon gets no early answer and no feed entry', async () => {
  const start = await feed('player2')
  const r = await fetch(`${base}/item`, { method: 'POST', headers: { 'X-User': 'player2' }, body: DIVINE })
  const text = await r.text()
  assert.equal(text, JSON.stringify({ id: JSON.parse(text).id, user: 'player2' }))
  await sleep(100)
  assert.equal((await feed('player2')).seq, start.seq)
})

test('a card queued behind another one says how many are ahead, and follows the queue', async () => {
  // A background job that holds the queue (no request: it only waits), so the
  // next two cards have to wait behind it.
  let release
  const held = new Promise(resolve => { release = resolve })
  mod.enqueueBackground(() => held)
  await sleep(50)
  const start = await feed('player1')
  const sent = outbound.length
  const a = await post(belt('Rune Clasp'), 'player1')
  const b = await post(belt('Grim Cord'), 'player1')
  await sleep(100)
  let { events, seq } = await feed('player1', `since=${start.seq}&boot=${start.boot}&wait=0`)
  const lastOf = id => events.filter(e => e.kind === 'item' && e.id === id).at(-1)
  assert.equal(lastOf(a.id).status, 'queued')
  assert.equal(lastOf(a.id).ahead, 1, 'the running job is ahead of it')
  assert.equal(lastOf(b.id).ahead, 2)
  release()
  await sleep(200)
  ;({ events } = await feed('player1', `since=${seq}&boot=${start.boot}&wait=0`))
  assert.ok(events.some(e => e.id === b.id && e.status === 'queued' && e.ahead === 1), 'b moved up when the held job ended')
  assert.equal(lastOf(a.id).final, true)
  assert.equal(lastOf(b.id).final, true)
  assert.deepEqual(outbound.slice(sent), [], 'reading the feed and queueing sent nothing anywhere')
})

test('a throw in the feed calls never turns POST /item into a 400', async () => {
  const start = await feed('player1')
  const parseBefore = mod.gapLog.size('parse')
  const store = mod.faustusStore
  const orig = store.getRange
  let thrown = 0
  // The first lookup of the early answer throws once (pricing is off here, so
  // the queued job does not read the range).
  store.getRange = function () { store.getRange = orig; thrown++; throw new Error('test: the early answer failed') }
  try {
    const r = await fetch(`${base}/item`, { method: 'POST', headers: H('player1'), body: EXALTED })
    assert.equal(r.status, 200)
    const { id, deduped } = await r.json()
    assert.ok(id)
    assert.equal(deduped, undefined)
    assert.equal(thrown, 1, 'the early answer did run into the throw')
    await sleep(150)
    const { events } = await feed('player1', `since=${start.seq}&boot=${start.boot}&wait=0`)
    const mine = events.filter(e => e.kind === 'item' && e.id === id)
    assert.equal(mine[0].status, 'queued')
    assert.equal(mine.at(-1).final, true, 'the card was still queued and its job ran')
    assert.equal(mod.gapLog.size('parse'), parseBefore, 'no parse failure is recorded for it')
  } finally {
    store.getRange = orig
  }
})
