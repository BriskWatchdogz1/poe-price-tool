import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthStore } from './store.mjs'

const tab = (index, name, extra = {}) => ({
  index, name,
  items: extra.items ?? [{ name: 'Divine Orb', kind: 'stackable', tab: name, tabIndex: index, qty: 1, chaosEach: 200, chaosTotal: 200 }],
  unpriced: extra.unpriced ?? [],
  counts: extra.counts ?? { priced: 1, unpriced: 0, skipped: 0 }
})

async function fresh () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-nw-'))
  const p = join(dir, 'nw.json')
  const s = createNetworthStore(p)
  await s.load()
  return { dir, p, s, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('empty v2 store when the file is missing', async () => {
  const { s, cleanup } = await fresh()
  assert.equal(s.data.schema_version, 2)
  assert.deepEqual(s.data.users, {})
  assert.deepEqual(s.tabList('player1'), [])
  assert.equal(s.getTab('player1', 0), null)
  assert.deepEqual(s.history('player1'), [])
  await cleanup()
})

test('setTab persists IMMEDIATELY + stamps syncedAt', async () => {
  const { p, s, cleanup } = await fresh()
  const before = Date.now()
  await s.setTab('player1', 3, tab(3, 'Currency'))
  const stored = s.getTab('player1', 3)
  assert.equal(stored.index, 3)
  assert.equal(stored.name, 'Currency')
  assert.ok(stored.syncedAt >= before && stored.syncedAt <= Date.now())
  // On disk without an explicit save() (setTab writes by itself).
  const raw = JSON.parse(await readFile(p, 'utf8'))
  assert.equal(raw.schema_version, 2)
  assert.equal(raw.users.player1.tabs['3'].name, 'Currency')
  assert.ok(typeof raw.users.player1.tabs['3'].syncedAt === 'number')
  await cleanup()
})

test('setTab does NOT write when writable=false', async () => {
  const { p, s, cleanup } = await fresh()
  s.writable = false
  await s.setTab('player1', 0, tab(0, 'A'))
  assert.equal(s.getTab('player1', 0).name, 'A') // present in memory
  await assert.rejects(readFile(p, 'utf8')) // but no file written
  await cleanup()
})

test('isFresh: fresh inside the TTL, stale afterwards', async () => {
  const { s, cleanup } = await fresh()
  const now = 1_000_000
  s.data.users.player1 = { tabs: { 0: { index: 0, name: 'A', syncedAt: now, items: [], unpriced: [], counts: {} } }, history: [] }
  assert.equal(s.isFresh('player1', 0, 10_000, now + 5_000), true)   // 5s < 10s TTL
  assert.equal(s.isFresh('player1', 0, 10_000, now + 20_000), false) // 20s > 10s TTL
  assert.equal(s.isFresh('player1', 99, 10_000, now), false)         // unknown tab
  await cleanup()
})

test('tabList: all tabs, sorted by index', async () => {
  const { s, cleanup } = await fresh()
  await s.setTab('player1', 5, tab(5, 'E'))
  await s.setTab('player1', 1, tab(1, 'B'))
  await s.setTab('player1', 3, tab(3, 'D'))
  assert.deepEqual(s.tabList('player1').map(t => t.index), [1, 3, 5])
  await cleanup()
})

test('pruneTabs: removes tabs the account no longer has', async () => {
  const { s, cleanup } = await fresh()
  await s.setTab('player1', 0, tab(0, 'A'))
  await s.setTab('player1', 1, tab(1, 'B'))
  await s.setTab('player1', 2, tab(2, 'C'))
  s.pruneTabs('player1', [0, 2]) // tab 1 no longer exists
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 2])
  await cleanup()
})

test('setMeta / getMeta', async () => {
  const { s, cleanup } = await fresh()
  s.setMeta('player1', { accountName: 'Acc#1', league: 'Standard', cdRatio: 215 })
  assert.deepEqual(s.getMeta('player1'), { accountName: 'Acc#1', league: 'Standard', cdRatio: 215 })
  await cleanup()
})

test('appendHistory: capped at keep, meta + league on every point', async () => {
  const { dir, cleanup } = await fresh()
  const s = createNetworthStore(join(dir, 'nw2.json'), { keep: 3 })
  await s.load()
  s.setMeta('player1', { league: 'Standard' })
  for (let i = 1; i <= 5; i++) s.appendHistory('player1', { totalChaos: i * 100, totalDivine: i })
  const h = s.history('player1')
  assert.equal(h.length, 3)                 // only the last 3
  assert.equal(h[0].totalChaos, 300)        // t3..t5
  assert.equal(h[2].totalChaos, 500)
  assert.equal(h[2].totalDivine, 5)
  assert.equal(h[0].league, 'Standard')     // league on every point (frontend label)
  assert.ok(typeof h[0].at === 'string')
  await cleanup()
})

test('users are kept separate', async () => {
  const { s, cleanup } = await fresh()
  await s.setTab('player1', 0, tab(0, 'A'))
  await s.setTab('player2', 0, tab(0, 'X'))
  assert.equal(s.getTab('player1', 0).name, 'A')
  assert.equal(s.getTab('player2', 0).name, 'X')
  await cleanup()
})

test('persistence roundtrip: reloading returns tabs + history', async () => {
  const { p, s, cleanup } = await fresh()
  await s.setTab('player1', 0, tab(0, 'A'))
  s.setMeta('player1', { accountName: 'Acc', league: 'L', cdRatio: 200 })
  s.appendHistory('player1', { totalChaos: 200, totalDivine: 1 })
  await s.save()
  const s2 = createNetworthStore(p)
  await s2.load()
  assert.equal(s2.getTab('player1', 0).name, 'A')
  assert.deepEqual(s2.getMeta('player1'), { accountName: 'Acc', league: 'L', cdRatio: 200 })
  assert.equal(s2.history('player1')[0].totalChaos, 200)
  await cleanup()
})

test('migration: old schema_version:1 store -> treated as empty, no crash', async () => {
  const { p, cleanup } = await fresh()
  // Old snapshot-based store (v1).
  await writeFile(p, JSON.stringify({ schema_version: 1, snapshots: { player1: [{ at: 't', totalChaos: 999 }] } }), 'utf8')
  const s = createNetworthStore(p)
  await s.load()
  assert.equal(s.data.schema_version, 2)
  assert.deepEqual(s.data.users, {})
  assert.deepEqual(s.tabList('player1'), [])
  await cleanup()
})

test('migration: corrupt JSON -> treated as empty, no crash', async () => {
  const { p, cleanup } = await fresh()
  await writeFile(p, '{ this is broken', 'utf8')
  const s = createNetworthStore(p)
  await s.load()
  assert.equal(s.data.schema_version, 2)
  assert.deepEqual(s.data.users, {})
  await cleanup()
})
