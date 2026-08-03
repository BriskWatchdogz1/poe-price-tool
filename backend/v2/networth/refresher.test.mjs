// Background refresher (refresher.mjs) with mocked deps — NO GGG requests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthStore } from './store.mjs'
import { createNetworthRefresher } from './refresher.mjs'

const silentLog = { warn () {}, error () {}, log () {} }

async function freshStore () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-refresher-'))
  const s = createNetworthStore(join(dir, 'nw.json'))
  await s.load()
  return { s, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// Mock client with call tracking. tabs = [{index,name}], contents = { index: items[] },
// fail = { index: () => error } makes fetchTab throw for that index.
function mockClient ({ tabs, contents = {}, fail = {} }) {
  const listed = []
  const fetched = []
  return {
    listed,
    fetched,
    async listTabs () { listed.push(1); return tabs },
    async fetchTab (index) {
      fetched.push(index)
      if (fail[index]) throw fail[index]()
      return contents[index] || []
    }
  }
}

// Builds a refresher whose makeClient ALWAYS hands back the same (call-tracked)
// client. valueTab is a trivial pass-through (no poe.ninja).
function makeRefresher ({ store, client, users, over = {} }) {
  const synced = []
  const r = createNetworthRefresher({
    store,
    loadUsers: async () => users,
    makeClient: () => ({ client, league: 'L' }),
    valueTab: async ({ items, tab, cdRatio, league, accountName }) => ({
      index: tab.index,
      name: tab.name,
      items: items.map(it => ({ name: it.name, kind: it.kind, tab: tab.name, tabIndex: tab.index, qty: 1, chaosEach: it.c ?? 0, chaosTotal: it.c ?? 0 })),
      unpriced: [],
      counts: { priced: items.length, unpriced: 0, skipped: 0 }
    }),
    cdRatioFor: () => 200,
    onTabSynced: user => synced.push(user),
    log: silentLog,
    intervalMs: 10_000,
    listTtlMs: 900_000,
    cooldownMs: 600_000,
    ...over
  })
  return { r, synced }
}

const CREDS = { player1: { accountName: 'acc', poesessid: 'COOKIE' } }
const item = (name, c) => ({ kind: 'stackable', name, c })

test('first tick fetches the tab list (1 request), syncs no tab yet', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({ tabs: [{ index: 0, name: 'A' }, { index: 1, name: 'B' }] })
  const { r } = makeRefresher({ store: s, client, users: CREDS })
  await r.tickOnce()
  assert.equal(client.listed.length, 1)      // list fetched
  assert.deepEqual(client.fetched, [])        // no fetchTab yet
  assert.deepEqual(s.getMeta('player1'), { accountName: 'acc', league: 'L', cdRatio: 200 })
  await cleanup()
})

test('picks the stalest tab and syncs exactly ONE per tick', async () => {
  const { s, cleanup } = await freshStore()
  // Seeded: tab 0 (old) and tab 1 (newer) in the store; tab 2 never synced.
  await s.setTab('player1', 0, { index: 0, name: 'A', items: [], unpriced: [], counts: { priced: 0, unpriced: 0, skipped: 0 } })
  await new Promise(r => setTimeout(r, 5))
  await s.setTab('player1', 1, { index: 1, name: 'B', items: [], unpriced: [], counts: { priced: 0, unpriced: 0, skipped: 0 } })
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }, { index: 1, name: 'B' }, { index: 2, name: 'C' }],
    contents: { 0: [item('Chaos Orb', 1)], 2: [item('Divine Orb', 200)] }
  })
  const { r, synced } = makeRefresher({ store: s, client, users: CREDS })

  await r.tickOnce() // tick 1: tab list
  await r.tickOnce() // tick 2: never-synced tab 2 first (the stalest)
  assert.deepEqual(client.fetched, [2])
  assert.equal(s.getTab('player1', 2).items[0].name, 'Divine Orb')
  assert.deepEqual(synced, ['player1'])

  await r.tickOnce() // tick 3: now the oldest known one -> tab 0
  assert.deepEqual(client.fetched, [2, 0])
  assert.equal(s.getTab('player1', 0).items[0].name, 'Chaos Orb')
  await cleanup()
})

test('overlap guard: a second tick does not run while one is still in flight', async () => {
  const { s, cleanup } = await freshStore()
  let releaseList
  const gate = new Promise(res => { releaseList = res })
  const client = {
    listed: [],
    fetched: [],
    async listTabs () { this.listed.push(1); await gate; return [{ index: 0, name: 'A' }] },
    async fetchTab (i) { this.fetched.push(i); return [] }
  }
  const { r } = makeRefresher({ store: s, client, users: CREDS })

  const p1 = r.tickOnce() // hangs in listTabs (busy=true)
  await r.tickOnce()      // must return immediately without doing work (guard)
  assert.equal(client.listed.length, 1, 'guard let a second overlapping tick through')

  releaseList()
  await p1
  await cleanup()
})

test('ratelimit -> cooldown: no immediate re-request, resumes once it expires', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }],
    fail: { 0: () => Object.assign(new Error('Rate-limited'), { kind: 'ratelimit' }) }
  })
  const { r } = makeRefresher({
    store: s, client, users: CREDS,
    over: { now: () => clock, cooldownMs: 60_000 }
  })

  await r.tickOnce() // list
  await r.tickOnce() // fetchTab 0 -> ratelimit -> cooldown set
  assert.deepEqual(client.fetched, [0])

  clock += 30_000     // still inside the cooldown
  await r.tickOnce()
  assert.deepEqual(client.fetched, [0], 'requested again inside the cooldown (hammering)')

  clock += 40_000     // cooldown expired (70s > 60s)
  await r.tickOnce()
  assert.deepEqual(client.fetched, [0, 0], 'no new attempt after the cooldown expired')
  await cleanup()
})

test('auth -> user is paused; only reactivated after the cookie changes in the config', async () => {
  const { s, cleanup } = await freshStore()
  let users = { player1: { accountName: 'acc', poesessid: 'OLD' } }
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }],
    fail: { 0: () => Object.assign(new Error('POESESSID invalid'), { kind: 'auth' }) }
  })
  const { r } = makeRefresher({
    store: s, client, users: {}, // overridden by loadUsers below
    over: { loadUsers: async () => users }
  })

  await r.tickOnce() // list
  await r.tickOnce() // fetchTab -> auth -> paused
  assert.deepEqual(client.fetched, [0])

  await r.tickOnce() // paused -> no request
  assert.deepEqual(client.fetched, [0], 'paused user was queried anyway')

  // Cookie renewed in the config -> reactivated. Drop the tab failure, otherwise
  // it would run straight back into auth.
  users = { player1: { accountName: 'acc', poesessid: 'NEW' } }
  client.fetched.length = 0
  client.fetchTab = async function (i) { this.fetched.push(i); return [] }
  await r.tickOnce() // reactivated -> fetchTab attempted again
  assert.deepEqual(client.fetched, [0], 'not reactivated after the cookie change')
  await cleanup()
})

test('rejected -> tab skipped, the loop keeps going (next tick takes the next one)', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }, { index: 1, name: 'B' }],
    contents: { 1: [item('Exalted Orb', 50)] },
    fail: { 0: () => Object.assign(new Error('HTTP 400'), { kind: 'rejected' }) }
  })
  const { r } = makeRefresher({ store: s, client, users: CREDS })

  await r.tickOnce() // list
  await r.tickOnce() // tab 0 (stalest, never synced) -> rejected -> skipped
  assert.deepEqual(client.fetched, [0])
  assert.equal(s.getTab('player1', 0), null, 'skipped tab was persisted anyway')

  await r.tickOnce() // tab 1 (now the stalest, never synced) -> ok
  assert.deepEqual(client.fetched, [0, 1])
  assert.equal(s.getTab('player1', 1).items[0].name, 'Exalted Orb')
  await cleanup()
})

test('tab list is only re-fetched after listTtlMs', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }],
    contents: { 0: [item('Chaos Orb', 1)] }
  })
  const { r } = makeRefresher({
    store: s, client, users: CREDS,
    over: { now: () => clock, listTtlMs: 100_000 }
  })

  await r.tickOnce() // list (1)
  assert.equal(client.listed.length, 1)
  clock += 10_000
  await r.tickOnce() // fetchTab, NO re-list
  assert.equal(client.listed.length, 1, 'list was re-fetched inside the TTL')
  assert.deepEqual(client.fetched, [0])

  clock += 200_000   // > listTtlMs -> list is due again
  await r.tickOnce()
  assert.equal(client.listed.length, 2, 'list was not re-fetched after the TTL expired')
  await cleanup()
})

test('isPaused (full scan running) -> the tick does nothing at all', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({ tabs: [{ index: 0, name: 'A' }] })
  let paused = true
  const { r } = makeRefresher({ store: s, client, users: CREDS, over: { isPaused: () => paused } })

  await r.tickOnce()
  assert.equal(client.listed.length, 0, 'requested despite a full scan running')

  paused = false
  await r.tickOnce()
  assert.equal(client.listed.length, 1)
  await cleanup()
})

test('start()/stop(): fires at least one tick on the interval and stops cleanly', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({ tabs: [{ index: 0, name: 'A' }], contents: { 0: [item('Chaos Orb', 1)] } })
  const { r } = makeRefresher({ store: s, client, users: CREDS, over: { intervalMs: 10 } })
  try {
    r.start()
    await new Promise(res => setTimeout(res, 120))
    assert.ok(client.listed.length >= 1, 'start() fired no tick over the interval')
    r.stop()
    const listedAtStop = client.listed.length
    await new Promise(res => setTimeout(res, 60))
    assert.equal(client.listed.length, listedAtStop, 'stop() did not end the interval')
  } finally {
    r.stop()
    await cleanup()
  }
})

// Regression: the refresher boiled the tab list down to {index,name} — that left
// the client without type and id, so collection tabs (Unique/Maps) arrived
// permanently empty even though the client had had the collection-tab path for
// a long time.
test('tab list keeps type and id and passes the entry through to fetchTab', async () => {
  const seen = []
  const client = {
    listTabs: async () => [{ index: 0, name: 'UNIQUE', type: 'UniqueStash', id: 'PARENT' }],
    fetchTab: async (index, tab) => { seen.push({ index, tab }); return [] }
  }
  const { s: store, cleanup } = await freshStore()
  const r = createNetworthRefresher({
    store,
    loadUsers: async () => ({ player1: { accountName: 'a', poesessid: 'S' } }),
    makeClient: () => ({ client, league: 'L' }),
    valueTab: async ({ tab }) => ({ index: tab.index, name: tab.name, items: [], unpriced: [], counts: {} }),
    cdRatioFor: () => 100
  })
  await r.tickOnce()
  await r.tickOnce()
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].tab, { index: 0, name: 'UNIQUE', type: 'UniqueStash', id: 'PARENT' })
  await cleanup()
})
