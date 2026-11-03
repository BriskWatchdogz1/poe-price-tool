// Sync follows the game (refresher.mjs, "WHO GETS THE TICK"): the hotkey
// daemons' heartbeats decide WHOSE tab a tick reads, or whether it lapses —
// never that a tick reads more. Mocked deps and an in-memory store on the
// injected clock: no GGG request, no real time, so two runs can be compared
// call for call.
//
// What must hold, and what each test below pins:
//   1. Without heartbeats (no presenceOf, or every answer 'unknown') the
//      refresher does EXACTLY what it did before: the same requests, in the
//      same order.
//   2. At most one request per tick and never two in flight, for any sequence
//      of presence answers; the total never rises above the run without them.
//   3. The trade-ban gate and the 429 cooldown still come before every choice.
//   4. A change of who rests is said (onStatus, a log line on a mode change),
//      and statusFor answers from the presence NOW, not from the last tick.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNetworthRefresher, DEFAULT_IDLE_EVERY } from './refresher.mjs'

const INTERVAL = 30_000

/** The store surface the refresher uses, in memory, stamped on `clock()`. */
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

/** A client per user that records every request into one shared journal. */
function journalClient (user, journal, { tabs, folder = null, inflight, authFails = false }) {
  const rec = async (what) => {
    inflight.now++
    inflight.max = Math.max(inflight.max, inflight.now)
    journal.push(`${user}:${what}`)
    await Promise.resolve()
    inflight.now--
    if (authFails) throw Object.assign(new Error('auth'), { kind: 'auth' }) // an expired cookie
  }
  return {
    async listTabs () { await rec('list'); return tabs },
    async fetchTab (index) { await rec(`tab${index}`); return [] },
    isChildedTab: t => !!(folder && t.index === folder.index),
    async listTabChildren (tab) {
      await rec(`children:${tab.index}`)
      return { listed: folder.n, childIds: Array.from({ length: folder.n }, (_, i) => `C${i}`), items: [] }
    },
    async fetchTabChild (tab, childId) {
      await rec(`child:${childId}`)
      return { items: [], hasItemsArray: true, hasOwnChildren: false }
    }
  }
}

const TABS = [{ index: 0, name: 'A' }, { index: 1, name: 'B' }, { index: 2, name: 'C' }]

/**
 * A refresher over `names` users on a fake clock. `layout[user]` may give a
 * user other tabs or a folder tab. Returns the journal of requests and a way
 * to run ticks that moves the clock by one interval each.
 */
function rig ({ names = ['a', 'b', 'c'], layout = {}, over = {} } = {}) {
  let t = 1_000_000
  const clock = () => t
  const journal = []
  const inflight = { now: 0, max: 0 }
  const statusEvents = []
  const lines = []
  const clients = Object.fromEntries(names.map(u => [u, journalClient(u, journal, { tabs: TABS, inflight, ...(layout[u] || {}) })]))
  const users = Object.fromEntries(names.map(u => [u, { accountName: `acc-${u}`, poesessid: `S-${u}` }]))
  const r = createNetworthRefresher({
    store: memStore(clock),
    loadUsers: async () => users,
    makeClient: user => ({ client: clients[user], league: 'L' }),
    valueTab: async ({ tab }) => ({ index: tab.index, name: tab.name, items: [], unpriced: [], counts: { priced: 0, unpriced: 0, skipped: 0 } }),
    cdRatioFor: () => 200,
    onStatus: u => statusEvents.push(u),
    log: { warn: l => lines.push(l), error: l => lines.push(l), log: l => lines.push(l) },
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
  return { r, journal, inflight, statusEvents, lines, ticks, stepsOf, clock, advance: ms => { t += ms }, users }
}

const FOLDER = { tabs: [{ index: 0, name: 'Maps', type: 'MapStash', id: 'P' }, { index: 1, name: 'B' }], folder: { index: 0, n: 5 } }

test('without heartbeats the refresher does exactly what it did before', async () => {
  const layout = { b: FOLDER }
  const plain = rig({ layout })
  const unknown = rig({ layout, over: { presenceOf: () => 'unknown' } })
  const playing = rig({ layout, over: { presenceOf: () => 'playing' } })
  await plain.ticks(200)
  await unknown.ticks(200)
  await playing.ticks(200)
  assert.ok(plain.journal.length > 150, 'the run did real work')
  assert.deepEqual(unknown.journal, plain.journal, "'unknown' everywhere is today's sequence, request for request")
  assert.deepEqual(playing.journal, plain.journal, 'and so is everybody playing')
  assert.equal(plain.r.pace(), 'normal')
  assert.equal(unknown.statusEvents.length, plain.statusEvents.length, 'no status pushes of its own')
  assert.deepEqual(unknown.lines, plain.lines, 'and no log line of its own')
})

test('an idle user yields to a playing one and to one without a daemon, and keeps every tenth tick', async () => {
  const presence = { a: 'idle', b: 'playing', c: 'unknown' }
  const x = rig({ over: { presenceOf: u => presence[u], idleEvery: 10 } })
  await x.ticks(100)
  assert.equal(x.stepsOf('a'), 10, 'the idle user gets exactly the slow turns')
  for (const u of ['b', 'c']) {
    const n = x.stepsOf(u)
    assert.ok(Math.abs(n - 45) <= 1, `${u} stepped ${n} times, expected 45 ± 1`)
  }
  assert.deepEqual(x.r.statusFor('a').pace, { mode: 'yields', everyMs: 10 * INTERVAL })
  assert.equal(x.r.statusFor('b').pace, undefined, 'a player has no pace field')
  assert.equal(x.r.statusFor('c').pace, undefined, 'nor has a user without a daemon')
  assert.equal(x.r.pace(), 'some-idle')
  assert.equal(DEFAULT_IDLE_EVERY, 10)
})

test('a playing user whose cookie expired takes nothing and gives nothing: the idle one keeps its slow turns', async () => {
  // Known behaviour (docs/admin.md, "Sync follows the game"): the playing
  // user's ticks lapse once the cookie is refused, and the idle user is read
  // on every tenth tick, as when nobody plays. The lapsed ticks are NOT handed
  // to the idle user: an expired cookie must not make anybody's sync faster.
  const presence = { a: 'playing', b: 'idle' }
  const x = rig({ names: ['a', 'b'], layout: { a: { authFails: true } }, over: { presenceOf: u => presence[u], idleEvery: 10 } })
  await x.ticks(100)
  assert.equal(x.stepsOf('a'), 1, 'one refused request, then the cookie pause')
  assert.equal(x.r.statusFor('a', 'S-a').state, 'expired')
  assert.equal(x.stepsOf('b'), 10, 'the idle user gets exactly the slow turns, no more')
  assert.deepEqual(x.r.statusFor('b', 'S-b').pace, { mode: 'yields', everyMs: 10 * INTERVAL }, 'and the page says so')
  const base = rig({ names: ['a', 'b'], layout: { a: { authFails: true } } })
  await base.ticks(100)
  assert.ok(x.journal.length <= base.journal.length, 'the total stays below the run without heartbeats')
})

test('nobody playing: one step every idleEvery ticks, none with idleRest', async () => {
  const all = rig({ over: { presenceOf: () => 'idle', idleEvery: 10 } })
  await all.ticks(10_000)
  assert.equal(all.journal.length, 1000, 'exactly every tenth tick does a step')
  assert.deepEqual(all.r.statusFor('a').pace, { mode: 'rests', everyMs: 10 * INTERVAL })
  const edgeLines = all.lines.filter(l => /pace normal -> all-idle/.test(l))
  assert.equal(edgeLines.length, 1, 'one line for the edge, none per tick')
  assert.match(edgeLines[0], /one step every 10 ticks/)
  assert.deepEqual([...all.statusEvents].sort(), ['a', 'b', 'c'], 'onStatus once per user for the edge')

  const rest = rig({ over: { presenceOf: () => 'idle', idleEvery: 10, idleRest: true } })
  await rest.ticks(1000)
  assert.equal(rest.journal.length, 0, 'resting completely sends nothing')
  assert.deepEqual(rest.r.statusFor('a').pace, { mode: 'rests', everyMs: 0 })
  assert.ok(rest.lines.some(l => /syncing rests/.test(l)))

  for (const bad of [1, 0, 2.5, -3, 'x']) {
    const b = rig({ over: { presenceOf: () => 'idle', idleEvery: bad } })
    const warned = b.lines.filter(l => /idleEvery/.test(l))
    assert.equal(warned.length, 1, `idleEvery ${bad} is named once at the start`)
    await b.ticks(100)
    assert.equal(b.journal.length, 10, `idleEvery ${bad} is treated as ${DEFAULT_IDLE_EVERY}`)
  }
  const quiet = rig({ over: { presenceOf: () => 'idle' } })
  assert.deepEqual(quiet.lines, [], 'the default is not talked about')
})

test('no presence sequence ever makes more than one step per tick', async () => {
  // A small seeded generator: the same random walk on every run.
  let seed = 20261103
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const states = ['playing', 'idle', 'unknown']
  const now = { a: 'unknown', b: 'unknown', c: 'unknown' }
  const layout = { a: FOLDER }
  const x = rig({ layout, over: { presenceOf: u => now[u], idleEvery: 3 } })
  const base = rig({ layout })
  await x.ticks(10_000, () => { for (const u of Object.keys(now)) if (rnd() < 0.05) now[u] = states[Math.floor(rnd() * 3)] })
  await base.ticks(10_000)
  assert.equal(x.inflight.max, 1, 'never two requests in flight')
  assert.ok(x.journal.length <= 10_000, 'at most one request per tick (also checked tick by tick)')
  assert.ok(x.journal.length <= base.journal.length, `the total never rises: ${x.journal.length} > ${base.journal.length}`)
  assert.ok(x.journal.some(j => j.includes('child:')), 'the folder walk was part of it')
})

test('the ban gate and the 429 cooldown still come first', async () => {
  let paused = true
  const presence = { a: 'idle', b: 'playing' }
  const x = rig({ names: ['a', 'b'], over: { presenceOf: u => presence[u], idleEvery: 2, isPaused: () => paused } })
  await x.ticks(20)
  assert.equal(x.journal.length, 0, 'the trade-ban gate holds every tick, slow turns included')
  paused = false

  // A 429 on b stops everybody until the cooldown ends, also the idle user's slow turns.
  const err = () => { const e = new Error('429'); e.kind = 'ratelimit'; return e }
  const failing = { async listTabs () { throw err() }, async fetchTab () { throw err() } }
  const zz = rig({
    names: ['a', 'b'],
    over: {
      presenceOf: u => presence[u],
      idleEvery: 2,
      cooldownMs: 600_000,
      makeClient: u => ({ client: u === 'b' ? failing : { async listTabs () { zz.journal.push('a:list'); return TABS }, async fetchTab (i) { zz.journal.push(`a:tab${i}`); return [] } }, league: 'L' })
    }
  })
  await zz.ticks(1) // tick 1 is not a slow turn: b's turn, a 429
  assert.equal(zz.journal.length, 0)
  assert.equal(zz.r.statusFor('a').state, 'cooldown', 'the idle bystander waits as well')
  await zz.ticks(19) // 19 × 30 s < 600 s: still inside the cooldown, slow turns included
  assert.equal(zz.journal.length, 0, 'no step for anyone during the cooldown')
  zz.advance(600_000)
  await zz.ticks(2)
  assert.ok(zz.journal.length >= 1, 'and the sync resumes after it')
})

test('a folder walk of a user who goes idle continues in that user\'s turns without re-reading', async () => {
  const presence = { a: 'playing', b: 'playing' }
  const x = rig({ names: ['a', 'b'], layout: { a: FOLDER }, over: { presenceOf: u => presence[u], idleEvery: 10 } })
  // Tab lists of both, then a's folder tab: children list and 2 sub-tabs.
  await x.ticks(2)
  await x.ticks(6)
  const walk = x.r.statusFor('a').folderTab
  assert.ok(walk && walk.done >= 1 && walk.done < 5, `the walk is under way (${JSON.stringify(walk)})`)
  presence.a = 'idle'
  const aBefore = x.stepsOf('a')
  await x.ticks(30)
  assert.ok(x.stepsOf('a') - aBefore <= 3, 'a moved on slow turns only')
  presence.a = 'playing'
  await x.ticks(30)
  const children = x.journal.filter(j => j.startsWith('a:child'))
  assert.deepEqual(children.slice(0, 6), ['a:children:0', 'a:child:C0', 'a:child:C1', 'a:child:C2', 'a:child:C3', 'a:child:C4'],
    'the walk completed: 1 + 5 requests, nothing read twice')
})

test('a change of who rests is said to the user it concerns, also within one mode', async () => {
  const presence = { a: 'idle', b: 'playing', c: 'playing' }
  const x = rig({ over: { presenceOf: u => presence[u], idleEvery: 10 } })
  await x.ticks(1)
  x.statusEvents.length = 0
  presence.b = 'idle' // still some-idle: the mode does not change
  assert.deepEqual(x.r.statusFor('b').pace, { mode: 'yields', everyMs: 10 * INTERVAL },
    'statusFor already has the new pace before the next tick')
  await x.ticks(1)
  assert.deepEqual(x.statusEvents, ['b'], 'exactly one status push, for b only')
  x.statusEvents.length = 0
  presence.b = 'playing' // e.g. the hold after b's game ends the other way round
  await x.ticks(1)
  assert.deepEqual(x.statusEvents, ['b'])
  assert.ok(!x.lines.some(l => /pace some-idle -> some-idle/.test(l)), 'no mode line without a mode change')

  // During a 429 cooldown no tick chooses; statusFor still answers from now.
  const err = () => { const e = new Error('429'); e.kind = 'ratelimit'; return e }
  const pres = { a: 'playing', b: 'playing' }
  const y = rig({
    names: ['a', 'b'],
    over: { presenceOf: u => pres[u], makeClient: () => ({ client: { async listTabs () { throw err() } }, league: 'L' }) }
  })
  await y.ticks(1)
  assert.equal(y.r.statusFor('a').state, 'cooldown')
  pres.a = 'idle'; pres.b = 'idle'
  assert.equal(y.r.statusFor('a').pace.mode, 'rests', 'the mode comes from the presence now, not from the last tick')
})

test('a stale or missing heartbeat brings back the normal pace', async () => {
  // daemon-presence.mjs as the server wires it: syncPresenceOf with a hold that
  // is never on, on the same fake clock as the refresher.
  const { createDaemonPresence } = await import('../daemon-presence.mjs')
  let t = 5_000_000
  const presence = createDaemonPresence({ staleMs: 60_000, now: () => t })
  const x = rig({ names: ['a', 'b'], over: { presenceOf: u => presence.syncPresenceOf(u, () => false), now: () => t } })
  presence.beat('a', 'i1', { game: 'absent', everyS: 60 })
  presence.beat('b', 'i1', { game: 'absent', everyS: 60 })
  await x.r.tickOnce()
  assert.deepEqual(x.r.statusFor('a').pace, { mode: 'rests', everyMs: 10 * INTERVAL })
  t += 180_001 // three announced intervals of 60 s are over
  assert.equal(presence.presenceOf('a'), 'unknown')
  assert.equal(x.r.statusFor('a').pace, undefined, 'a silent daemon is unknown: no pace, the normal round-robin')
  await x.r.tickOnce()
  assert.equal(x.r.pace(), 'normal')
})

test('the server passes the pace on in networth-sync-status and wires the presence into the refresher', async () => {
  // server.mjs is not imported here (it would boot the server); the wiring is
  // pinned at the source, like sync-status.test.mjs does for the pages.
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8')
  const msgFn = src.slice(src.indexOf('function syncStatusMsg'), src.indexOf('function broadcastSyncStatus'))
  assert.match(msgFn, /if \(status\.pace\) msg\.pace = status\.pace/)
  const wiring = src.slice(src.indexOf('networthRefresher = createNetworthRefresher({'))
  assert.match(wiring.slice(0, 3000), /presenceOf: user => daemonPresence\.syncPresenceOf\(user, holdAfterGame\)/)
  assert.match(wiring.slice(0, 3000), /idleEvery: NETWORTH_IDLE_EVERY/)
  assert.match(wiring.slice(0, 3000), /idleRest: NETWORTH_IDLE_REST/)
  assert.match(src, /const NETWORTH_IDLE_REST = process\.env\.POE_NETWORTH_IDLE_REST === '1'/)
})
