// GET /daemon/stash-grid against the REAL server, in-process, without
// credentials and with every background job off (quietEnv). The tabs are put
// into the server's own net-worth store directly; the route reads that store
// and nothing else, so no request may leave the machine (every non-loopback
// fetch is refused here, and the suite's network guard is on top).
//
// What is pinned: the caller rule, the tab list, one tab's cells (one of them
// uncertain), the answers for an unknown, a malformed and a not-yet-reread
// tab, and the per-user gate.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quietEnv } from './test-quiet-env.mjs'

const dir = await mkdtemp(join(tmpdir(), 'ppt-daemon-stash-grid-'))
quietEnv()
process.env.PORT = '0'
process.env.POE_USERS = 'player1,player2'
process.env.POE_USER_LANG_STORE = join(dir, 'user-langs.json')
process.env.POE_CONFIG_OVERRIDES = join(dir, 'overrides.json')
process.env.POE_ADMIN_PASSWORD_FILE = join(dir, 'admin-password')
process.env.POE_NETWORTH_CONFIG = join(dir, 'networth-users.json')
process.env.POE_NETWORTH_STORE = join(dir, 'networth-store.json')
process.env.POE_NETWORTH_HISTORY = join(dir, 'networth-history.ndjson')
process.env.POE_NETWORTH_SESSIONS = join(dir, 'networth-sessions.json')
process.env.POE_FAUSTUS_STORE = join(dir, 'faustus-store.json')
process.env.POE_REFERENCE_HISTORY = join(dir, 'reference-history.ndjson')
process.env.POE_CORPSE_STORE = join(dir, 'corpse-store.json')
process.env.POE_RATE_LIMIT_STATE = join(dir, 'rate-limit.json')

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

let mod, base
const H = user => ({ 'X-User': user, 'X-PPT-Daemon': '9.9.9', 'X-PPT-Instance': 'i1' })
const grid = (user, query = '', headers = H(user)) => fetch(`${base}/daemon/stash-grid${query}`, { headers })
const stored = (index, name, type, extra = {}) => ({ index, name, type, items: [], unpriced: [], counts: { priced: 0, unpriced: 0, skipped: 0 }, listed: [], ...extra })
const CELLS = [{ x: 3, y: 7, w: 2, h: 2, c: 900, n: 'Headhunter', u: true }, { x: 0, y: 0, w: 1, h: 1, c: 12, n: 'Chaos Orb' }]

before(async () => {
  mod = await import('./server.mjs')
  base = `http://127.0.0.1:${mod.server.address().port}`
  const s = mod.networthStore
  s.setMeta('player1', { cdRatio: 200 })
  await s.setTab('player1', 0, stored(0, 'Currency', 'CurrencyStash', { cells: [] }))
  await s.setTab('player1', 1, stored(1, 'Dump', 'QuadStash', { cells: CELLS }))
  await s.setTab('player1', 2, stored(2, 'Old', 'PremiumStash'))
  await s.setTab('player2', 0, stored(0, 'Sale', 'PremiumStash', { cells: [] }))
})

after(async () => {
  mod.networthRefresher?.stop()
  await new Promise(resolve => mod.server.close(resolve))
  await rm(dir, { recursive: true, force: true })
  assert.deepEqual(outbound, [], 'no request left the machine')
})

test('the route takes the daemon headers and GET only', async () => {
  let r = await grid('player1', '', { 'X-User': 'player1' })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'missing X-PPT-Daemon header' })
  r = await grid('nobody')
  assert.equal(r.status, 400)
  await r.json()
  r = await fetch(`${base}/daemon/stash-grid`, { method: 'POST', headers: H('player1'), body: '{}' })
  assert.equal(r.status, 405)
  assert.equal((await r.json()).allow, 'GET')
})

test('without a tab: the stored tabs in stash order, which of them have cells', async () => {
  const r = await grid('player1')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await r.json(), {
    v: 1,
    tabs: [
      { index: 0, name: 'Currency', type: 'CurrencyStash', grid: false },
      { index: 1, name: 'Dump', type: 'QuadStash', grid: true },
      { index: 2, name: 'Old', type: 'PremiumStash', grid: true }
    ]
  })
  const other = await (await grid('player2')).json()
  assert.deepEqual(other.tabs.map(t => t.name), ['Sale'], 'only the caller\'s own tabs')
})

test('with a tab: its cells, their total and the rate', async () => {
  const r = await grid('player1', '?tab=1')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.v, 1)
  assert.equal(j.tabs.length, 3)
  assert.deepEqual({ ...j.tab, syncedAt: typeof j.tab.syncedAt }, { index: 1, name: 'Dump', type: 'QuadStash', quad: true, grid: true, syncedAt: 'number' })
  assert.deepEqual(j.cells, CELLS, 'an uncertain cell comes with u: true, any other without u')
  assert.equal('u' in j.cells[1], false)
  assert.equal(j.totalChaos, 912)
  assert.equal(j.chaosPerDivine, 200)
})

test('a tab not read since the update, an unknown and a malformed index', async () => {
  let r = await grid('player1', '?tab=2')
  assert.equal(r.status, 200)
  let j = await r.json()
  assert.equal(j.cells, null)
  assert.equal(j.reason, 'not-read-since-update')
  assert.equal(j.tab.quad, false)
  r = await grid('player1', '?tab=9')
  assert.equal(r.status, 404)
  assert.deepEqual(await r.json(), { error: 'no such tab' })
  for (const q of ['?tab=x', '?tab=', '?tab=-1', '?tab=1.5']) {
    r = await grid('player1', q)
    assert.equal(r.status, 400, q)
    assert.deepEqual(await r.json(), { error: 'bad tab index' })
  }
})

test('the value key is rate-limited per user: 60 a minute', async () => {
  // player2 has made one counted request so far (the tab list above).
  for (let i = 1; i < 60; i++) {
    const r = await grid('player2', i % 2 ? '?tab=0' : '')
    assert.equal(r.status, 200, `request ${i + 1}`)
    await r.json()
  }
  const r = await grid('player2')
  assert.equal(r.status, 429)
  assert.deepEqual(await r.json(), { v: 1, error: 'too-many-grid-requests' })
  const bad = await grid('player2', '?tab=x')
  assert.equal(bad.status, 400, 'a malformed request is refused before the gate')
  await bad.json()
  const own = await grid('player1')
  assert.equal(own.status, 200, 'another user has a gate of their own')
  await own.json()
})
