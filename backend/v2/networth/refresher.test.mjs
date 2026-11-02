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

test('auth -> the log line names the settings page first and never the cookie value', async () => {
  const { s, cleanup } = await freshStore()
  const lines = []
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }],
    fail: { 0: () => Object.assign(new Error('POESESSID invalid'), { kind: 'auth' }) }
  })
  const { r } = makeRefresher({
    store: s, client, users: { player1: { accountName: 'acc', poesessid: 'SECRETVALUE' } },
    over: { log: { warn: m => lines.push(m), error () {}, log () {} } }
  })
  await r.tickOnce() // list
  await r.tickOnce() // fetchTab -> auth
  const line = lines.find(l => l.includes('cookie expired'))
  assert.ok(line, 'no cookie-expired line was logged')
  assert.match(line, /cookie expired for player1 — renew it on the settings page \(Sync settings\) or in networth-users\.json/)
  assert.ok(!line.includes('SECRETVALUE'))
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

// isPaused is the trade-API ban gate today (B14, wired in server.mjs). All this
// hook has to guarantee is that a truthy answer costs zero requests; which
// cause it was, and how it reaches the status line, is refresher-status.test.mjs.
test('isPaused (a trade ban is on) -> the tick does nothing at all', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({ tabs: [{ index: 0, name: 'A' }] })
  let paused = true
  const { r } = makeRefresher({ store: s, client, users: CREDS, over: { isPaused: () => paused } })

  await r.tickOnce()
  assert.equal(client.listed.length, 0, 'requested while the pause hook said stop')

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

// --- coverage: does the store answer for the WHOLE account yet? -------------
// The refresher fills the store one tab per tick, so between an empty store and
// the end of the first round-robin pass the union of stored tabs is a strict
// subset of the account. Anything summing that union (the history recorder)
// has to be able to tell — see history.mjs, append({ syncComplete }).
test('onTabSynced says whether the store covers every live tab yet', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }, { index: 1, name: 'B' }],
    contents: { 0: [item('Chaos Orb', 1)], 1: [item('Divine Orb', 200)] }
  })
  const cov = []
  const { r } = makeRefresher({ store: s, client, users: CREDS, over: { onTabSynced: (u, c) => cov.push(c) } })

  await r.tickOnce() // tab list
  await r.tickOnce() // tab 0
  assert.deepEqual(cov[0], { tabsCovered: 1, tabsRead: 1, tabsTotal: 2, complete: false })
  await r.tickOnce() // tab 1
  assert.deepEqual(cov[1], { tabsCovered: 2, tabsRead: 2, tabsTotal: 2, complete: true })
  await cleanup()
})

test('a tab that cannot be read counts as covered: its absence is a constant, not a dip', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }, { index: 1, name: 'B' }],
    contents: { 1: [item('Divine Orb', 200)] },
    fail: { 0: () => Object.assign(new Error('HTTP 400'), { kind: 'rejected' }) }
  })
  const cov = []
  const { r } = makeRefresher({ store: s, client, users: CREDS, over: { onTabSynced: (u, c) => cov.push(c) } })

  await r.tickOnce() // tab list
  await r.tickOnce() // tab 0 -> rejected, nothing stored, no onTabSynced
  await r.tickOnce() // tab 1 -> stored
  // Covered is 2 and READ is 1, and the difference is the whole point: the
  // series may go on (a tab that never becomes readable is missing from EVERY
  // point, which is a constant and not a dip), but nothing is allowed to
  // pretend the store has an answer for tab 0. `tabsRead` is what the recorder
  // says that out loud with.
  assert.deepEqual(cov, [{ tabsCovered: 2, tabsRead: 1, tabsTotal: 2, complete: true }])
  await cleanup()
})

// Regression: attempt stamps used to outlive the tab list they were made
// against. A list that came back short wipes stored tabs (pruneTabs), and the
// stale stamps would then have vouched for tabs whose data was gone — which is
// exactly the partial sum this coverage flag exists to keep out of the series.
test('after a short tab list wiped the store, coverage reads incomplete again', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  let tabs = [{ index: 0, name: 'A' }, { index: 1, name: 'B' }]
  const client = {
    listed: [],
    fetched: [],
    async listTabs () { this.listed.push(1); return tabs },
    async fetchTab (i) { this.fetched.push(i); return [item('Chaos Orb', 1)] }
  }
  const cov = []
  const { r } = makeRefresher({
    store: s,
    client,
    users: CREDS,
    over: { now: () => clock, listTtlMs: 100_000, onTabSynced: (u, c) => cov.push(c) }
  })

  await r.tickOnce() // list
  await r.tickOnce() // tab 0
  await r.tickOnce() // tab 1
  assert.equal(cov.at(-1).complete, true)

  tabs = []          // GGG answers with nothing this round
  clock += 200_000
  await r.tickOnce() // re-list -> pruneTabs([]) only PROPOSES the wipe
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 1],
    'one empty list is held back (store.mjs) — the wipe below needs a second one')
  await r.tickOnce() // the cached list is empty, so this re-lists: same answer -> wipe
  assert.deepEqual(s.tabList('player1'), [])

  tabs = [{ index: 0, name: 'A' }, { index: 1, name: 'B' }]
  await r.tickOnce() // re-list (the cached one is empty)
  await r.tickOnce() // tab 0 again, from an empty store
  assert.deepEqual(cov.at(-1), { tabsCovered: 1, tabsRead: 1, tabsTotal: 2, complete: false })
  await cleanup()
})

// ---------------------------------------------------------------------------
// A stash 429 stops EVERY user, not only the one it happened to. GGG publishes
// `Ip` rules on the stash endpoints (measured: Ip 45/60s, Ip 180/1800s), so
// part of the budget belongs to the address every configured user shares — the
// reading that costs freshness is also the correct one. (Cheap to get wrong in
// the other direction: this repository has two real bans behind it.)
// ---------------------------------------------------------------------------

const TWO_USERS = {
  player1: { accountName: 'acc1', poesessid: 'C1' },
  player2: { accountName: 'acc2', poesessid: 'C2' }
}

// One client per user, each counting its own calls.
function perUserClients ({ failFor = null, retryAfterSec = null } = {}) {
  const made = {}
  const clientFor = user => {
    if (made[user]) return made[user]
    const calls = []
    made[user] = {
      calls,
      async listTabs () {
        calls.push('list')
        if (user === failFor) {
          const e = new Error('429')
          e.kind = 'ratelimit'
          if (retryAfterSec != null) e.retryAfterSec = retryAfterSec
          throw e
        }
        return [{ index: 0, name: `${user}-A` }]
      },
      async fetchTab (i) { calls.push(`tab${i}`); return [] }
    }
    return made[user]
  }
  return { made, clientFor }
}

test('a 429 for one user stops the OTHER user too (global cooldown), and lifts for both', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  const { made, clientFor } = perUserClients({ failFor: 'player1' })
  const statusEvents = []
  const { r } = makeRefresher({
    store: s,
    client: null,
    users: TWO_USERS,
    over: {
      now: () => clock,
      cooldownMs: 600_000,
      makeClient: user => ({ client: clientFor(user), league: 'L' }),
      onStatus: u => statusEvents.push(u)
    }
  })

  await r.tickOnce() // player1's turn -> 429
  assert.deepEqual(made.player1.calls, ['list'])
  assert.equal(made.player2, undefined, 'player2 has not had a turn yet')
  // Everybody is told, not just the user GGG refused.
  assert.deepEqual(statusEvents.sort(), ['player1', 'player2'])

  clock += 30_000
  await r.tickOnce() // would have been player2's turn
  assert.equal(made.player2, undefined, 'player2 kept syncing straight through another user\'s 429')
  assert.deepEqual(made.player1.calls, ['list'], 'and player1 was not retried either')

  clock += 600_000 // cooldown over
  await r.tickOnce()
  assert.ok(made.player2, 'the cooldown never lifted')
  assert.deepEqual(made.player2.calls, ['list'])
  await cleanup()
})

test('statusFor tells the refused user apart from the bystander', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  const { clientFor } = perUserClients({ failFor: 'player1' })
  const { r } = makeRefresher({
    store: s,
    client: null,
    users: TWO_USERS,
    over: { now: () => clock, cooldownMs: 600_000, makeClient: user => ({ client: clientFor(user), league: 'L' }) }
  })
  await r.tickOnce()
  assert.deepEqual(r.statusFor('player1', 'C1'), { state: 'cooldown', until: 1_600_000, mine: true })
  assert.deepEqual(r.statusFor('player2', 'C2'), { state: 'cooldown', until: 1_600_000, mine: false },
    'a bystander must not be told to renew a cookie that is fine')
  clock = 1_600_001
  assert.deepEqual(r.statusFor('player1', 'C1'), { state: 'ok' })
  assert.deepEqual(r.statusFor('player2', 'C2'), { state: 'ok' })
  await cleanup()
})

test('a Retry-After longer than the configured cooldown wins — the wait is never shortened', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  const { clientFor } = perUserClients({ failFor: 'player1', retryAfterSec: 1200 })
  const { r } = makeRefresher({
    store: s,
    client: null,
    users: TWO_USERS,
    over: { now: () => clock, cooldownMs: 60_000, makeClient: user => ({ client: clientFor(user), league: 'L' }) }
  })
  await r.tickOnce()
  // 1200s + 1s, not the 60s cooldown the configuration would have allowed.
  assert.deepEqual(r.statusFor('player1', 'C1'), { state: 'cooldown', until: 1_000_000 + 1_201_000, mine: true })
  await cleanup()
})

test('a shorter Retry-After never shortens the configured cooldown', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  const { clientFor } = perUserClients({ failFor: 'player1', retryAfterSec: 5 })
  const { r } = makeRefresher({
    store: s,
    client: null,
    users: TWO_USERS,
    over: { now: () => clock, cooldownMs: 600_000, makeClient: user => ({ client: clientFor(user), league: 'L' }) }
  })
  await r.tickOnce()
  assert.deepEqual(r.statusFor('player1', 'C1'), { state: 'cooldown', until: 1_600_000, mine: true })
  await cleanup()
})

// ---------------------------------------------------------------------------
// A FOLDER TAB IS MANY STEPS, NOT ONE (docs/bugs.md B5)
//
// A folder tab's items live in sub-folders on a second endpoint, so reading one
// costs 1+N requests: 38 for the map stash as measured. It used to spend all of
// them inside a single step, holding the global `busy` flag for ~15 minutes at
// a 24s derived spacing and ~50 at the 80s a stricter rule set derives — and
// the round-robin does not advance during a step, so no other tab and NO OTHER
// USER got a turn in all that time. On a deployment with several users one
// folder tab pushed a full round from hours into days.
//
// What must hold now, and what must not have changed:
//   1. THE REQUEST COUNT IS THE SAME. 1+N, no more, in every constellation —
//      including the ones where the walk fails or is interrupted.
//   2. One tick is one request, and the round-robin advances between them.
//   3. A half-read folder tab NEVER reaches the store. Not as empty, not as
//      partial; the previous complete contents stand until the walk finishes.
//   4. The visibility survives: the B7 yield line, and a counterpart to the
//      `still busy`/`finished after` pair that a walk no longer produces.
// ---------------------------------------------------------------------------

/**
 * A client whose folder tab has `n` addressable sub-tabs. Every request is
 * recorded, so a test can count them and read their order.
 */
function folderClient ({ tabs, n = 37, fail = () => null, childItems = () => [item('Chaos Orb', 1)] }) {
  const calls = []
  return {
    calls,
    async listTabs () { calls.push('list'); return tabs },
    async fetchTab (index) { calls.push(`tab${index}`); return [] },
    isChildedTab (tab) { return !!(tab?.id && (tab.type === 'MapStash' || tab.type === 'UniqueStash')) },
    async listTabChildren (tab) {
      calls.push(`children:${tab.index}`)
      const e = fail(`children:${tab.index}`)
      if (e) throw e
      return { listed: n, childIds: Array.from({ length: n }, (_, i) => `C${i}`), items: [] }
    },
    async fetchTabChild (tab, childId) {
      calls.push(`child:${childId}`)
      const e = fail(`child:${childId}`)
      if (e) throw e
      return { items: childItems(childId), hasItemsArray: true, hasOwnChildren: false }
    }
  }
}

const FOLDER_TABS = [{ index: 0, name: 'Maps', type: 'MapStash', id: 'PARENT' }]

test('a folder tab costs one request per tick, and exactly 1+N in total', async () => {
  const { s, cleanup } = await freshStore()
  const client = folderClient({ tabs: FOLDER_TABS, n: 37 })
  const { r } = makeRefresher({ store: s, client, users: CREDS })

  await r.tickOnce()                                  // the tab list
  assert.deepEqual(client.calls, ['list'])
  for (let i = 0; i < 38; i++) {
    const before = client.calls.length
    await r.tickOnce()
    assert.equal(client.calls.length - before, 1, `tick ${i} sent more than one request`)
  }
  assert.equal(client.calls.length, 39, '1 tab list + 1 sub-tab list + 37 sub-tabs — the same requests as before')
  assert.deepEqual(client.calls.slice(1), ['children:0', ...Array.from({ length: 37 }, (_, i) => `child:C${i}`)])
  assert.equal(s.getTab('player1', 0).items.length, 37, 'and the tab is written once, complete')
  await cleanup()
})

test('another user gets a turn between two sub-tabs — the complaint this fixes', async () => {
  const { s, cleanup } = await freshStore()
  const clients = {
    player1: folderClient({ tabs: FOLDER_TABS, n: 37 }),
    player2: folderClient({ tabs: [{ index: 0, name: 'Ordinary' }], n: 0 })
  }
  const { r } = makeRefresher({
    store: s,
    client: null,
    users: { player1: { accountName: 'a1', poesessid: 'S1' }, player2: { accountName: 'a2', poesessid: 'S2' } },
    over: { makeClient: user => ({ client: clients[user], league: 'L' }) }
  })
  // Two ticks of tab lists, then twenty ticks of work, walked round-robin.
  for (let i = 0; i < 22; i++) await r.tickOnce()

  // The first user is still deep inside a 37-sub-tab walk…
  const walking = r.statusFor('player1').folderTab
  assert.ok(walking && walking.done > 0 && walking.done < 37, 'the folder tab is still being read')
  // …and the second user has had exactly as many turns as the first. Before
  // this, `busy` was held for the whole 1+N walk and the round-robin did not
  // advance at all — the second user got their tab list and then nothing until
  // the first user's walk had finished, which at an 80s spacing is 50 minutes.
  assert.equal(clients.player1.calls.length, 11)
  assert.equal(clients.player2.calls.length, 11)
  await cleanup()
})

test('a folder tab in progress never reaches the store, and does not disturb what is there', async () => {
  const { s, cleanup } = await freshStore()
  // The tab already holds a complete, valued reading from an earlier round.
  await s.setTab('player1', 0, {
    index: 0, name: 'Maps', items: [{ name: 'Old Map', qty: 1, chaosEach: 5, chaosTotal: 5 }],
    unpriced: [], counts: { priced: 1, unpriced: 0, skipped: 0 }
  })
  const before = s.getTab('player1', 0)
  const client = folderClient({ tabs: FOLDER_TABS, n: 6 })
  const { r, synced } = makeRefresher({ store: s, client, users: CREDS })

  await r.tickOnce()                        // list
  for (let i = 0; i < 4; i++) await r.tickOnce()   // sub-tab list + 3 of 6 sub-tabs
  assert.deepEqual(s.getTab('player1', 0), before, 'the last COMPLETE reading is what the snapshot still sums')
  assert.deepEqual(synced, [], 'and nothing has been broadcast as a new tab yet')

  for (let i = 0; i < 3; i++) await r.tickOnce()   // the remaining three
  assert.equal(s.getTab('player1', 0).items.length, 6)
  assert.deepEqual(synced, ['player1'], 'one tab, one broadcast — as for any other tab')
  await cleanup()
})

test('coverage counts a folder tab from its FIRST step, exactly as it counted the old 1+N step', async () => {
  // B2's gate: the history recorder refuses a point until the store can answer
  // for every live tab. A walk spread over 38 ticks must not reopen that window
  // — the tab was ATTEMPTED, which is what coverage has always counted.
  const { s, cleanup } = await freshStore()
  const client = folderClient({ tabs: [...FOLDER_TABS, { index: 1, name: 'B' }], n: 5 })
  const coverage = []
  const { r } = makeRefresher({
    store: s, client, users: CREDS,
    over: { onTabSynced: (_u, c) => coverage.push(c) }
  })
  await r.tickOnce()   // list
  await r.tickOnce()   // the folder tab's sub-tab list — index 0 is now attempted
  await r.tickOnce()   // …but the round-robin stays in the walk
  assert.deepEqual(coverage, [], 'nothing is written mid-walk, so nothing is reported')
  for (let i = 0; i < 4; i++) await r.tickOnce()  // finish the walk
  assert.deepEqual(coverage.at(-1), { tabsCovered: 1, tabsRead: 1, tabsTotal: 2, complete: false })
  await r.tickOnce()   // the ordinary tab
  assert.deepEqual(coverage.at(-1), { tabsCovered: 2, tabsRead: 2, tabsTotal: 2, complete: true })
  await cleanup()
})

test('a failure mid-walk writes nothing, drops the walk, and re-walks from the start later', async () => {
  const { s, cleanup } = await freshStore()
  let broken = true
  const client = folderClient({
    tabs: [...FOLDER_TABS, { index: 1, name: 'B' }],
    n: 4,
    fail: what => (broken && what === 'child:C1' ? Object.assign(new Error('500'), { kind: 'server' }) : null)
  })
  const { r } = makeRefresher({ store: s, client, users: CREDS })
  await r.tickOnce()                                // list
  for (let i = 0; i < 3; i++) await r.tickOnce()    // sub-tab list, C0, C1 -> throws
  assert.equal(s.getTab('player1', 0), null, 'a half-read folder tab is not a tab')

  // The round-robin has moved on rather than sitting on the broken tab.
  await r.tickOnce()
  assert.equal(client.calls.at(-1), 'tab1')

  broken = false
  const spent = client.calls.length
  for (let i = 0; i < 5; i++) await r.tickOnce()
  assert.deepEqual(client.calls.slice(spent), ['children:0', 'child:C0', 'child:C1', 'child:C2', 'child:C3'],
    'walked again from the beginning — the same requests the old all-in-one step would have spent again')
  assert.equal(s.getTab('player1', 0).items.length, 4)
  await cleanup()
})

test('a 429 mid-walk keeps the walk and RESUMES it — fewer requests, not more', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  let limited = true
  const client = folderClient({
    tabs: FOLDER_TABS,
    n: 6,
    fail: what => (limited && what === 'child:C2' ? Object.assign(new Error('429'), { kind: 'ratelimit' }) : null)
  })
  const { r } = makeRefresher({
    store: s, client, users: CREDS, over: { now: () => clock, cooldownMs: 60_000 }
  })
  await r.tickOnce()                                // list
  for (let i = 0; i < 4; i++) await r.tickOnce()    // sub-tab list, C0, C1, C2 -> 429
  assert.equal(client.calls.at(-1), 'child:C2')
  await r.tickOnce()
  assert.equal(client.calls.at(-1), 'child:C2', 'nothing goes out during the cooldown')

  limited = false
  clock += 61_000
  const spent = client.calls.length
  for (let i = 0; i < 4; i++) await r.tickOnce()
  // It picks up AT the sub-tab the 429 refused, not after it. Starting over
  // would have re-sent four requests; stepping over C2 would have finished the
  // walk with a hole in it, and a folder tab with a hole in it is not written
  // at all any more (folderWalkComplete) — so resuming would have bought
  // nothing. The 429 costs exactly the one request it refused.
  assert.deepEqual(client.calls.slice(spent), ['child:C2', 'child:C3', 'child:C4', 'child:C5'])
  assert.equal(s.getTab('player1', 0).items.length, 6, 'every sub-tab is in it — a 429 eats none of them')
  await cleanup()
})

test('the tab-list refresh waits for the walk instead of throwing it away', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  const client = folderClient({ tabs: FOLDER_TABS, n: 5 })
  const { r } = makeRefresher({
    store: s, client, users: CREDS, over: { now: () => clock, listTtlMs: 1000 }
  })
  await r.tickOnce()                                // list
  await r.tickOnce()                                // sub-tab list
  clock += 60_000                                   // the list is now long stale
  for (let i = 0; i < 5; i++) await r.tickOnce()
  assert.equal(client.calls.filter(c => c === 'list').length, 1, 'no re-list while a walk is in flight')
  assert.equal(s.getTab('player1', 0).items.length, 5)
  await r.tickOnce()
  assert.equal(client.calls.at(-1), 'list', 'and it happens as soon as the walk is done')
  await cleanup()
})

test('statusFor answers "12 of 37" BETWEEN ticks, which the old busy pair could not', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  const client = folderClient({ tabs: FOLDER_TABS, n: 37 })
  const { r } = makeRefresher({ store: s, client, users: CREDS, over: { now: () => clock } })
  await r.tickOnce()
  assert.equal(r.statusFor('player1').folderTab, undefined, 'nothing to say while no folder tab is open')
  await r.tickOnce()                                // sub-tab list
  for (let i = 0; i < 12; i++) await r.tickOnce()
  const st = r.statusFor('player1')
  assert.deepEqual(st.folderTab, { tab: 'Maps', tabIndex: 0, done: 12, total: 37, since: clock })
  assert.equal(st.current, undefined, 'no step is in flight — the refresher is genuinely free between ticks now')
  for (let i = 0; i < 25; i++) await r.tickOnce()
  assert.equal(r.statusFor('player1').folderTab, undefined, 'and it is gone once the walk finishes')
  await cleanup()
})

test('a completed walk is bracketed in the log, and an empty one still says B7\'s line', async () => {
  const { s, cleanup } = await freshStore()
  let clock = 1_000_000
  const lines = []
  const log = { log: m => lines.push(String(m)), warn: m => lines.push(String(m)), error: () => {} }
  const client = folderClient({ tabs: FOLDER_TABS, n: 3, childItems: () => [] })
  const { r } = makeRefresher({
    store: s, client, users: CREDS, over: { log, now: () => { clock += 30_000; return clock } }
  })
  for (let i = 0; i < 5; i++) await r.tickOnce()
  assert.equal(lines.filter(l => l.includes('reading sub-tabs')).length, 1, 'the opening bracket, once')
  const yielded = lines.filter(l => l.includes('yielded 0 items'))
  assert.equal(yielded.length, 1, 'B7\'s line survives a walk spread over ticks')
  assert.match(yielded[0], /3 sub-tabs, 3 answered with an items array, 0 of those non-empty/)
  const closed = lines.filter(l => l.includes('sub-tabs over'))
  assert.equal(closed.length, 1, 'the closing bracket, once per folder-tab turn')
  assert.match(closed[0], /folder tab "Maps" \(index 0\) for player1: 3 sub-tabs over 4 steps in \d+s/)
  assert.equal(/not read/.test(closed[0]), false, 'nothing was skipped here, so the line does not mention skipping')
  await cleanup()
})
