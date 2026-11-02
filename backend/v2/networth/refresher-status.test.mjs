// statusFor + onStatus of the background refresher — mocked deps, no GGG
// requests. Covers the states ok/expired/cooldown and the automatic resume
// after a cookie swap (WITHOUT a restart); 'missing' is decided by the server
// (networthSyncStatus), not by the refresher.
//
// Since B14 `cooldown` has two causes — a stash 429 and the trade-API ban gate
// — and the last three tests in this file are about telling them apart. A pause
// that does not say why it is paused is the silent stop the whole status line
// exists to prevent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthStore } from './store.mjs'
import { createNetworthRefresher, slowStepMsFromEnv, DEFAULT_SLOW_STEP_MS } from './refresher.mjs'

const silentLog = { warn () {}, error () {}, log () {} }

async function freshStore () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-refstatus-'))
  const s = createNetworthStore(join(dir, 'nw.json'))
  await s.load()
  return { s, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

function authError () { const e = new Error('auth'); e.kind = 'auth'; return e }
function rlError () { const e = new Error('429'); e.kind = 'ratelimit'; return e }

// Client whose listTabs throws on the first call (the first step is always the
// list fetch) — that way the error lands in handleError deterministically.
function failingClient (mkError) {
  return {
    async listTabs () { throw mkError() },
    async fetchTab () { return [] }
  }
}

function okClient () {
  return {
    async listTabs () { return [{ index: 0, name: 'T0' }] },
    async fetchTab () { return [] }
  }
}

function makeRefresher ({ store, client, usersRef, over = {} }) {
  const statusEvents = []
  const r = createNetworthRefresher({
    store,
    loadUsers: async () => usersRef.users,
    makeClient: () => ({ client: usersRef.client ?? client, league: 'L' }),
    valueTab: async ({ tab }) => ({ index: tab.index, name: tab.name, items: [], unpriced: [], counts: { priced: 0, unpriced: 0, skipped: 0 } }),
    cdRatioFor: () => 200,
    onStatus: u => statusEvents.push(u),
    log: silentLog,
    intervalMs: 10_000,
    listTtlMs: 900_000,
    cooldownMs: 600_000,
    ...over
  })
  return { r, statusEvents }
}

test('statusFor: unknown/fresh user -> ok', async () => {
  const { s, cleanup } = await freshStore()
  try {
    const usersRef = { users: { player1: { accountName: 'A#1', poesessid: 'c1' } } }
    const { r } = makeRefresher({ store: s, client: okClient(), usersRef })
    assert.deepEqual(r.statusFor('player1', 'c1'), { state: 'ok' })
    await r.tickOnce() // a successful list fetch changes nothing about the status
    assert.deepEqual(r.statusFor('player1', 'c1'), { state: 'ok' })
  } finally { await cleanup() }
})

test('statusFor: auth error -> expired, as long as the file carries the SAME cookie', async () => {
  const { s, cleanup } = await freshStore()
  try {
    const usersRef = { users: { player1: { accountName: 'A#1', poesessid: 'old' } } }
    const { r, statusEvents } = makeRefresher({ store: s, client: failingClient(authError), usersRef })
    await r.tickOnce()
    assert.deepEqual(r.statusFor('player1', 'old'), { state: 'expired' })
    assert.deepEqual(statusEvents, ['player1'], 'onStatus fired when pausing')
    // New cookie in the file -> status ok immediately (same comparison logic as
    // the reactivation inside the tick), even BEFORE the next tick ran.
    assert.deepEqual(r.statusFor('player1', 'new'), { state: 'ok' })
  } finally { await cleanup() }
})

test('resume without a restart: a cookie swap lifts the pause on the next tick', async () => {
  const { s, cleanup } = await freshStore()
  try {
    const usersRef = { users: { player1: { accountName: 'A#1', poesessid: 'old' } }, client: failingClient(authError) }
    const { r, statusEvents } = makeRefresher({ store: s, client: null, usersRef })
    await r.tickOnce() // auth error -> pause
    assert.deepEqual(r.statusFor('player1', 'old'), { state: 'expired' })

    // Like after a save in the settings dialog: the file carries a new cookie,
    // the client works again. No stop()/start(), no restart.
    usersRef.users = { player1: { accountName: 'A#1', poesessid: 'new' } }
    usersRef.client = okClient()
    await r.tickOnce()
    assert.deepEqual(r.statusFor('player1', 'new'), { state: 'ok' })
    assert.equal(statusEvents.length, 2, 'onStatus also fires when the pause is lifted')
    // and the refresher is working again: the tick fetched the tab list
    await r.tickOnce()
    assert.ok(s.getTab('player1', 0), 'tab 0 synced after the resume')
  } finally { await cleanup() }
})

test('statusFor: 429 -> cooldown with an end time, ok again on its own afterwards', async () => {
  const { s, cleanup } = await freshStore()
  try {
    let t = 1_000_000
    const usersRef = { users: { player1: { accountName: 'A#1', poesessid: 'c1' } } }
    const { r, statusEvents } = makeRefresher({
      store: s,
      client: failingClient(rlError),
      usersRef,
      over: { now: () => t, cooldownMs: 600_000 }
    })
    await r.tickOnce()
    // `mine: true` — GGG refused THIS user's request. A 429 pauses every
    // configured user; the others get the same cooldown with `mine: false`,
    // which refresher.test.mjs pins.
    assert.deepEqual(r.statusFor('player1', 'c1'), { state: 'cooldown', until: 1_600_000, mine: true })
    assert.deepEqual(statusEvents, ['player1'])
    t = 1_600_001 // cooldown expired -> ok again without any further action
    assert.deepEqual(r.statusFor('player1', 'c1'), { state: 'ok' })
  } finally { await cleanup() }
})

// ---------------------------------------------------------------------------
// B14: the trade-API ban gate holds this path too. It has to be visible AS a
// trade ban — the remedy is nothing (wait), where a stash 429 is about this
// deployment's own stash reads and an expired cookie is about the cookie.
// ---------------------------------------------------------------------------
test('a raised trade ban stops every request and says so once, to every user', async () => {
  const { s, cleanup } = await freshStore()
  try {
    let banned = false
    const client = okClient()
    let listCalls = 0
    const usersRef = {
      users: {
        player1: { accountName: 'A#1', poesessid: 'c1' },
        player2: { accountName: 'B#2', poesessid: 'c2' }
      }
    }
    const warns = []
    const { r, statusEvents } = makeRefresher({
      store: s,
      client: { listTabs: async () => { listCalls++; return client.listTabs() }, fetchTab: async () => [] },
      usersRef,
      over: {
        isPaused: () => (banned ? { until: 9_000_000 } : false),
        log: { warn: m => warns.push(m), error () {}, log () {} }
      }
    })

    await r.tickOnce()                       // not banned -> a request goes out
    assert.equal(listCalls, 1)
    assert.deepEqual(statusEvents, [])

    banned = true
    await r.tickOnce()
    await r.tickOnce()
    assert.equal(listCalls, 1, 'a request went out while the trade ban gate was up')
    assert.deepEqual(statusEvents, ['player1', 'player2'],
      'both rooms are told once — the pause is not silent, and not repeated per tick')
    assert.equal(warns.length, 1, 'one line for the pause, not one per tick')
    assert.match(warns[0], /trade-API ban gate is up/)

    banned = false
    await r.tickOnce()
    assert.equal(listCalls, 2, 'syncing resumed on its own once the gate dropped')
    assert.deepEqual(statusEvents, ['player1', 'player2', 'player1', 'player2'])
    assert.equal(warns.length, 2)
    assert.match(warns[1], /trade-API ban lifted/)
  } finally { await cleanup() }
})

test('statusFor: a trade ban reads as a cooldown that names the trade ban, with the ban\'s own end time', async () => {
  const { s, cleanup } = await freshStore()
  try {
    const t = 2_000_000
    let banned = { until: 2_600_000 }
    const usersRef = { users: { player1: { accountName: 'A#1', poesessid: 'c1' } } }
    const { r } = makeRefresher({
      store: s,
      client: okClient(),
      usersRef,
      over: { now: () => t, isPaused: () => banned }
    })
    assert.deepEqual(r.statusFor('player1', 'c1'),
      { state: 'cooldown', tradeBan: true, until: 2_600_000 },
      'no `mine`: a trade ban belongs to nobody\'s session, it belongs to the address')

    // A gate that cannot name an end time still pauses, and still says so —
    // it just does not invent a time to show.
    banned = true
    assert.deepEqual(r.statusFor('player1', 'c1'), { state: 'cooldown', tradeBan: true })

    banned = false
    assert.deepEqual(r.statusFor('player1', 'c1'), { state: 'ok' })

    // An expired cookie keeps precedence over both: it is this user's own
    // problem and the only one of the three that does not lift by itself.
    usersRef.users = { player1: { accountName: 'A#1', poesessid: 'dead' } }
    usersRef.client = failingClient(authError)
    await r.tickOnce()                       // gate still down -> the auth error lands
    banned = { until: 2_600_000 }
    assert.deepEqual(r.statusFor('player1', 'dead'), { state: 'expired' })
  } finally { await cleanup() }
})

test('statusFor: a stash 429 keeps precedence over the trade ban — `mine` still means what it says', async () => {
  const { s, cleanup } = await freshStore()
  try {
    let t = 1_000_000
    let banned = false // the stash 429 comes first, the trade ban lands during it
    const usersRef = { users: { player1: { accountName: 'A#1', poesessid: 'c1' } } }
    const { r } = makeRefresher({
      store: s,
      client: failingClient(rlError),
      usersRef,
      over: { now: () => t, cooldownMs: 600_000, isPaused: () => banned }
    })
    await r.tickOnce()
    banned = { until: 5_000_000 }
    assert.deepEqual(r.statusFor('player1', 'c1'), { state: 'cooldown', until: 1_600_000, mine: true },
      'the more specific refusal of THIS path wins while it lasts')

    // ...and once it has run out, the ban that is still on takes the line over
    // rather than letting the status flip back to a cheerful 'ok'.
    t = 1_600_001
    assert.deepEqual(r.statusFor('player1', 'c1'), { state: 'cooldown', tradeBan: true, until: 5_000_000 })
  } finally { await cleanup() }
})

// ---------------------------------------------------------------------------
// B5: 'ok' used to describe both a refresher walking the stash and one whose
// single step had been stuck for ten minutes. These are the two fields that
// tell them apart, plus the one log line a stall now leaves behind.
// ---------------------------------------------------------------------------

// Lets the event loop run until the tick in flight has actually reached its
// hanging request (several microtask hops: loadUsers, then step).
const settle = () => new Promise(r => setImmediate(r))

// A client whose fetchTab never returns until it is released — a step that
// occupies the refresher, exactly like the ten-minute Maps fetch.
function hangingClient (tabs, held) {
  return {
    async listTabs () { return tabs },
    async fetchTab () { await held; return [] }
  }
}

test('statusFor: names the tab currently in flight, and since when', async () => {
  const { s, cleanup } = await freshStore()
  try {
    let t = 5_000_000
    let release
    const held = new Promise(r => { release = r })
    const usersRef = { users: { player1: { accountName: 'A#1', poesessid: 'c1' } } }
    const { r } = makeRefresher({
      store: s,
      client: hangingClient([{ index: 2, name: 'Maps', type: 'MapStash', id: 'P' }], held),
      usersRef,
      over: { now: () => t }
    })

    await r.tickOnce()                       // tick 1: the tab list
    assert.equal(r.statusFor('player1', 'c1').current, undefined, 'nothing in flight between ticks')

    const inFlight = r.tickOnce()            // tick 2: the tab fetch, which hangs
    await settle()
    t += 600_000                             // ten minutes later, still the same step
    const st = r.statusFor('player1', 'c1')
    assert.equal(st.state, 'ok', 'the state itself is unchanged — this is what made B5 invisible')
    assert.deepEqual(st.current, { phase: 'tab', since: 5_000_000, mine: true, tab: 'Maps', tabIndex: 2 })
    release()
    await inFlight
    assert.equal(r.statusFor('player1', 'c1').current, undefined, 'cleared once the step returns')
  } finally { await cleanup() }
})

test("statusFor: another user's step is visible as busy, but never by tab name", async () => {
  const { s, cleanup } = await freshStore()
  try {
    let release
    const held = new Promise(r => { release = r })
    const usersRef = {
      users: {
        player1: { accountName: 'A#1', poesessid: 'c1' },
        player2: { accountName: 'B#2', poesessid: 'c2' }
      }
    }
    const { r } = makeRefresher({
      store: s,
      client: null,
      usersRef,
      over: {
        now: () => 7_000,
        makeClient: user => ({
          client: user === 'player2'
            ? hangingClient([{ index: 4, name: 'player2 private tab' }], held)
            : okClient(),
          league: 'L'
        })
      }
    })
    await r.tickOnce()             // player1: tab list
    await r.tickOnce()             // player2: tab list
    await r.tickOnce()             // player1: tab 0
    const inFlight = r.tickOnce()  // player2: tab 4 — hangs from here on
    await settle()

    const mine = r.statusFor('player2', 'c2').current
    assert.deepEqual(mine, { phase: 'tab', since: 7_000, mine: true, tab: 'player2 private tab', tabIndex: 4 })

    // player1's tabs stop moving because of it, so the fact of it has to be
    // visible over there too — but the other room's stash-tab names do not.
    const foreign = r.statusFor('player1', 'c1').current
    assert.deepEqual(foreign, { phase: 'tab', since: 7_000, mine: false })

    release()
    await inFlight
  } finally { await cleanup() }
})

test('statusFor: reports when a tab was last WRITTEN (from the store, so a restart cannot lie)', async () => {
  const { s, cleanup } = await freshStore()
  try {
    const usersRef = { users: { player1: { accountName: 'A#1', poesessid: 'c1' } } }
    const { r } = makeRefresher({ store: s, client: okClient(), usersRef })
    assert.equal(r.statusFor('player1', 'c1').lastTab, undefined, 'nothing written yet -> nothing claimed')
    await r.tickOnce()  // tab list
    await r.tickOnce()  // tab 0
    const { lastTab } = r.statusFor('player1', 'c1')
    assert.equal(lastTab.index, 0)
    assert.equal(lastTab.name, 'T0')
    assert.equal(lastTab.at, s.getTab('player1', 0).syncedAt, 'the same stamp the page ages, not a second clock')
  } finally { await cleanup() }
})

test('a step that outlives slowStepMs says so ONCE, and is never aborted for it', async () => {
  const { s, cleanup } = await freshStore()
  try {
    let t = 0
    const warns = []
    let release
    const held = new Promise(r => { release = r })
    let fetches = 0
    const client = {
      async listTabs () { return [{ index: 0, name: 'T0' }] },
      async fetchTab () { fetches++; await held; return [] }
    }
    const usersRef = { users: { player1: { accountName: 'A#1', poesessid: 'c1' } } }
    const { r } = makeRefresher({
      store: s,
      client,
      usersRef,
      over: { now: () => t, slowStepMs: 120_000, log: { warn: m => warns.push(m), error () {}, log () {} } }
    })
    await r.tickOnce()            // tab list
    const inFlight = r.tickOnce() // hangs in fetchTab
    await settle()

    t = 60_000
    await r.tickOnce()
    assert.deepEqual(warns, [], 'below the threshold nothing is said — a folder tab may legitimately take a while')

    t = 130_000
    await r.tickOnce()
    assert.equal(warns.length, 1)
    assert.match(warns[0], /still busy: tab "T0" \(index 0\) for player1 has been running for 130s/)

    t = 400_000
    await r.tickOnce()
    await r.tickOnce()
    assert.equal(warns.length, 1, 'one line per stuck STEP, not one per skipped tick (it ticks every 30s, 24/7)')
    assert.equal(fetches, 1, 'and nothing was released: no second request went out next to the first')

    release()
    await inFlight
    assert.equal(warns.length, 2)
    assert.match(warns[1], /tab "T0" \(index 0\) for player1 finished after 400s/, 'the closing bracket of the hole')
  } finally { await cleanup() }
})

test('slowStepMsFromEnv: 0 is a setting, not an unset value', () => {
  assert.equal(slowStepMsFromEnv({}), DEFAULT_SLOW_STEP_MS)
  assert.equal(slowStepMsFromEnv({ POE_NETWORTH_SLOW_STEP_MS: '' }), DEFAULT_SLOW_STEP_MS, 'blank = unset')
  assert.equal(slowStepMsFromEnv({ POE_NETWORTH_SLOW_STEP_MS: '5000' }), 5000)
  // `Number(env) || DEFAULT` would hand back 120000 here and report every step
  // as fine — the exact trap guardOptionsFromEnv documents.
  assert.equal(slowStepMsFromEnv({ POE_NETWORTH_SLOW_STEP_MS: '0' }), 0)
  assert.equal(slowStepMsFromEnv({ POE_NETWORTH_SLOW_STEP_MS: '-1' }), DEFAULT_SLOW_STEP_MS)
  assert.equal(slowStepMsFromEnv({ POE_NETWORTH_SLOW_STEP_MS: 'soon' }), DEFAULT_SLOW_STEP_MS)
})

test('a tick with ZERO configured users is a no-op (the refresher may start empty)', async () => {
  const { s, cleanup } = await freshStore()
  try {
    const usersRef = { users: {} }
    const { r } = makeRefresher({ store: s, client: okClient(), usersRef })
    await r.tickOnce() // must not throw
    // A user is added later (settings UI) -> the next tick works right away
    usersRef.users = { player1: { accountName: 'A#1', poesessid: 'c1' } }
    await r.tickOnce()
    await r.tickOnce()
    assert.ok(s.getTab('player1', 0), 'user configured after the fact gets synced')
  } finally { await cleanup() }
})
