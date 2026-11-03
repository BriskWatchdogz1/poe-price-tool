// A session round (refresher.mjs, "A SESSION ROUND"): when a farm or game
// session starts or ends, the refresher reads every live tab of that user once
// after the moment before it reads one twice, and says how far it has come.
// What must hold above everything else: it ORDERS a user's own ticks and never
// adds one. Mocked deps and an in-memory store on an injected clock: no GGG
// request, no real time.
//
//   1. The same number of requests per tick and per user, with and without a
//      session round, for any presence (the load test).
//   2. The round is read before any tab is read twice, and the tab list waits
//      for it (a list refresh in the middle would throw the round's attempts
//      away).
//   3. One round per user at a time; a later moment replaces an earlier one.
//   4. statusFor says `sessionRound` while it runs; etaFor gives the time a
//      round needs from the steps left (a folder tab 1+N once walked), the
//      interval, the user's share and a running cooldown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNetworthRefresher } from './refresher.mjs'

const INTERVAL = 30_000

function memStore (clock) {
  const users = new Map()
  const u = name => { if (!users.has(name)) users.set(name, { meta: null, tabs: new Map() }); return users.get(name) }
  return {
    getTab: (user, i) => u(user).tabs.get(i) || null,
    async setTab (user, i, data) { u(user).tabs.set(i, { ...data, index: i, syncedAt: clock() }) },
    setMeta (user, m) { u(user).meta = m },
    getMeta: user => u(user).meta,
    pruneTabs (user, keep) { for (const i of [...u(user).tabs.keys()]) if (!keep.includes(i)) u(user).tabs.delete(i) },
    tabList: user => [...u(user).tabs.values()]
  }
}

function journalClient (user, journal, { tabs, folder = null }) {
  return {
    async listTabs () { journal.push(`${user}:list`); return tabs },
    async fetchTab (index) { journal.push(`${user}:tab${index}`); return [] },
    isChildedTab: t => !!(folder && t.index === folder.index),
    async listTabChildren (tab) {
      journal.push(`${user}:children:${tab.index}`)
      return { listed: folder.n, childIds: Array.from({ length: folder.n }, (_, i) => `C${i}`), items: [] }
    },
    async fetchTabChild (tab, childId) {
      journal.push(`${user}:child:${childId}`)
      return { items: [], hasItemsArray: true, hasOwnChildren: false }
    }
  }
}

const tabsOf = n => Array.from({ length: n }, (_, i) => ({ index: i, name: `T${i}` }))

function rig ({ names = ['a', 'b', 'c'], tabs = 3, layout = {}, over = {} } = {}) {
  let t = 1_000_000
  const clock = () => t
  const journal = []
  const statusEvents = []
  const clients = Object.fromEntries(names.map(u => [u, journalClient(u, journal, { tabs: tabsOf(tabs), ...(layout[u] || {}) })]))
  const users = Object.fromEntries(names.map(u => [u, { accountName: `acc-${u}`, poesessid: `S-${u}` }]))
  const r = createNetworthRefresher({
    store: memStore(clock),
    loadUsers: async () => users,
    makeClient: user => ({ client: clients[user], league: 'L' }),
    valueTab: async ({ tab }) => ({ index: tab.index, name: tab.name, items: [], unpriced: [], counts: { priced: 0, unpriced: 0, skipped: 0 } }),
    cdRatioFor: () => 200,
    onStatus: u => statusEvents.push(u),
    log: { warn () {}, error () {}, log () {} },
    intervalMs: INTERVAL,
    listTtlMs: 15 * 60_000,
    cooldownMs: 600_000,
    now: clock,
    ...over
  })
  async function ticks (n, before = () => {}) {
    for (let i = 0; i < n; i++) {
      before(i)
      const k = journal.length
      await r.tickOnce()
      assert.ok(journal.length - k <= 1, `tick ${i} sent ${journal.length - k} requests`)
      t += INTERVAL
    }
  }
  const stepsOf = user => journal.filter(j => j.startsWith(`${user}:`)).length
  return { r, journal, statusEvents, ticks, stepsOf, clock, clients, advance: ms => { t += ms } }
}

test('a session round never adds a request: the same steps per tick and per user, for any presence', async () => {
  const presences = [
    () => 'unknown',
    u => (u === 'a' ? 'idle' : 'playing'),
    () => 'idle'
  ]
  for (const presenceOf of presences) {
    for (const idleRest of [false, true]) {
      const layout = { b: { tabs: [{ index: 0, name: 'Maps', type: 'MapStash', id: 'P' }, { index: 1, name: 'B' }], folder: { index: 0, n: 5 } } }
      const plain = rig({ tabs: 7, layout, over: { presenceOf, idleRest, listTtlMs: 5 * INTERVAL } })
      const round = rig({ tabs: 7, layout, over: { presenceOf, idleRest, listTtlMs: 5 * INTERVAL } })
      // A round for every user, again and again: at a session's start and end.
      const ask = i => { if (i % 13 === 0) for (const u of ['a', 'b', 'c']) round.r.prioritize(u, round.clock()) }
      await plain.ticks(400)
      await round.ticks(400, ask)
      assert.equal(round.journal.length, plain.journal.length, 'the same number of requests in the same time')
      for (const u of ['a', 'b', 'c']) {
        assert.equal(round.stepsOf(u), plain.stepsOf(u), `${u} got the same number of steps`)
      }
    }
  }
})

test('the round is read before any tab is read twice, and the tab list waits for it', async () => {
  // One user, six tabs, a tab list that is stale after three ticks.
  const plain = rig({ names: ['a'], tabs: 6, over: { listTtlMs: 3 * INTERVAL } })
  const round = rig({ names: ['a'], tabs: 6, over: { listTtlMs: 3 * INTERVAL } })
  await plain.ticks(7)
  await round.ticks(7)
  const since = round.clock()
  round.r.prioritize('a', since)
  plain.journal.length = 0
  round.journal.length = 0
  await plain.ticks(6)
  await round.ticks(6)
  assert.deepEqual(round.journal.filter(j => j === 'a:list'), [], 'no list refresh during the round')
  assert.equal(new Set(round.journal).size, 6, 'six different tabs in six ticks')
  assert.equal(round.r.roundSince('a', since).complete, true)
  assert.ok(plain.journal.includes('a:list'), 'without a round the list refresh comes in between')
  assert.equal(plain.r.roundSince('a', since).complete, false, 'and the round is not complete after the same ticks')
  // After the round the list refresh comes at once.
  round.journal.length = 0
  await round.ticks(1)
  assert.deepEqual(round.journal, ['a:list'])
})

test('statusFor names the round while it runs; it ends by itself and says so', async () => {
  const x = rig({ names: ['a', 'b'], tabs: 3 })
  await x.ticks(8) // both lists and a first round
  assert.equal(x.r.statusFor('a').sessionRound, undefined, 'no round, no field')
  const since = x.clock()
  x.statusEvents.length = 0
  const first = x.r.prioritize('a', since)
  assert.deepEqual({ done: first.done, total: first.total }, { done: 0, total: 3 })
  assert.deepEqual(x.statusEvents, ['a'], 'the status line hears of the round at once')
  assert.deepEqual(x.r.statusFor('a').sessionRound, { done: 0, total: 3, since })
  assert.equal(x.r.statusFor('b').sessionRound, undefined, 'only the user whose round it is')
  await x.ticks(2) // one step each
  assert.deepEqual(x.r.statusFor('a').sessionRound, { done: 1, total: 3, since })
  await x.ticks(4)
  assert.equal(x.r.statusFor('a').sessionRound, undefined, 'complete: the field goes')
  assert.ok(x.statusEvents.filter(u => u === 'a').length >= 4, 'a status after each of the round\'s steps')
})

test('one round per user: a later moment replaces an earlier one, an earlier one changes nothing', async () => {
  const x = rig({ names: ['a'], tabs: 4 })
  await x.ticks(5)
  const t1 = x.clock()
  x.r.prioritize('a', t1)
  await x.ticks(2)
  const t2 = x.clock()
  x.r.prioritize('a', t2)
  assert.equal(x.r.statusFor('a').sessionRound.since, t2)
  x.r.prioritize('a', t1)
  assert.equal(x.r.statusFor('a').sessionRound.since, t2, 'the later moment stays')
  await x.ticks(4)
  assert.equal(x.r.roundSince('a', t2).complete, true)
  assert.equal(x.r.statusFor('a').sessionRound, undefined)
})

test('etaFor: the tabs still to read, times the interval, over the user\'s share of the ticks', async () => {
  const presence = { a: 'playing', b: 'playing', c: 'playing' }
  const x = rig({ names: ['a', 'b', 'c'], tabs: 4, over: { presenceOf: u => presence[u], idleEvery: 10 } })
  await x.ticks(18)
  const since = x.clock()
  // Three players: a's four tabs take 4 of every 3 ticks.
  assert.deepEqual(x.r.etaFor('a', since), { done: 0, total: 4, remaining: 4, steps: 4, ms: 4 * 3 * INTERVAL })
  // b and c idle: a gets 9 of every 10 ticks.
  presence.b = 'idle'; presence.c = 'idle'
  assert.equal(x.r.etaFor('a', since).ms, Math.ceil(4 / 0.9) * INTERVAL)
  // a idle with them: every tenth tick, shared by three.
  presence.a = 'idle'
  assert.equal(x.r.etaFor('a', since).ms, 4 * 30 * INTERVAL)
  // A finished round needs nothing; a user nobody knows has no estimate.
  assert.equal(x.r.etaFor('a', 0).ms, 0)
  assert.equal(x.r.etaFor('nobody', since).ms, null)
})

test('etaFor: no estimate while the user gets no tick at all', async () => {
  const x = rig({ names: ['a', 'b'], tabs: 2, over: { presenceOf: u => (u === 'a' ? 'idle' : 'playing'), idleRest: true } })
  await x.ticks(6)
  assert.equal(x.r.etaFor('a', x.clock()).ms, null, 'idle with POE_NETWORTH_IDLE_REST=1: never')
  assert.equal(x.r.etaFor('b', x.clock()).ms, 2 * INTERVAL, 'the player gets every tick')
})

const failing = kind => async () => { const e = new Error(kind); e.kind = kind; throw e }

test('etaFor: a running cooldown comes first', async () => {
  const x = rig({ names: ['a'], tabs: 3 })
  await x.ticks(4) // the list and every tab once
  x.clients.a.fetchTab = failing('ratelimit')
  await x.ticks(1) // a 429: the cooldown (600 s) begins
  const since = x.clock()
  assert.deepEqual(x.r.etaFor('a', since), { done: 0, total: 3, remaining: 3, steps: 3, ms: (600_000 - INTERVAL) + 3 * INTERVAL })
})

test('etaFor: a user whose cookie expired hands the ticks on, so the others share them', async () => {
  const x = rig({ names: ['a', 'b'], tabs: 2 })
  await x.ticks(2)
  const since = x.clock()
  assert.equal(x.r.etaFor('a', since).ms, 2 * 2 * INTERVAL, 'half of the ticks')
  x.clients.b.fetchTab = failing('auth')
  await x.ticks(2) // a's list... b's first tab: auth-paused
  const later = x.clock()
  assert.equal(x.r.etaFor('b', later).ms, null, 'the paused user gets no tick')
  assert.equal(x.r.etaFor('a', later).ms, 2 * INTERVAL, 'every tick')
})

test('etaFor: a folder tab counts its sub-tabs once it was walked, one step before', async () => {
  const layout = { a: { tabs: [{ index: 0, name: 'Maps', type: 'MapStash', id: 'P' }, { index: 1, name: 'B' }], folder: { index: 0, n: 5 } } }
  const x = rig({ names: ['a'], layout })
  await x.ticks(1) // the list
  assert.equal(x.r.etaFor('a', x.clock()).steps, 2, 'not walked yet: one step for the folder tab')
  await x.ticks(7) // the folder tab (1+5) and tab 1
  const since = x.clock()
  const e = x.r.etaFor('a', since)
  assert.deepEqual([e.remaining, e.steps, e.ms], [2, 7, 7 * INTERVAL])
})
