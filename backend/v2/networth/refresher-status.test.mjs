// statusFor + onStatus of the background refresher — mocked deps, no GGG
// requests. Covers the states ok/expired/cooldown and the automatic resume
// after a cookie swap (WITHOUT a restart); 'missing' is decided by the server
// (networthSyncStatus), not by the refresher.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthStore } from './store.mjs'
import { createNetworthRefresher } from './refresher.mjs'

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
    assert.deepEqual(r.statusFor('player1', 'c1'), { state: 'cooldown', until: 1_600_000 })
    assert.deepEqual(statusEvents, ['player1'])
    t = 1_600_001 // cooldown expired -> ok again without any further action
    assert.deepEqual(r.statusFor('player1', 'c1'), { state: 'ok' })
  } finally { await cleanup() }
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
