import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

test('pruneTabs: removes tabs the account no longer has, once a second list agrees', async () => {
  const { s, cleanup } = await fresh()
  await s.setTab('player1', 0, tab(0, 'A'))
  await s.setTab('player1', 1, tab(1, 'B'))
  await s.setTab('player1', 2, tab(2, 'C'))
  s.pruneTabs('player1', [0, 2]) // tab 1 no longer exists — proposed, not done
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 1, 2])
  s.pruneTabs('player1', [0, 2]) // the same answer twice -> carried out
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 2])
  await cleanup()
})

// pruneTabs must not believe the live tab list absolutely: ONE short or empty
// response would take stored tabs with it — a wipe of a whole user's stash on a
// single bad answer, and a way to reach the partial-store window of B2. A drop
// needs two consecutive lists that agree about the same tab. There is
// deliberately no threshold on "how much shorter": that would be a guessed
// number, and requiring agreement needs none.
function pruneStore () {
  const warns = []
  return { warns, make: async dir => {
    const s = createNetworthStore(join(dir, 'nw.json'), { log: { warn: m => warns.push(m) } })
    await s.load()
    for (const [i, n] of [[0, 'A'], [1, 'B'], [2, 'C']]) await s.setTab('player1', i, tab(i, n))
    return s
  } }
}

test('pruneTabs: one empty tab list does NOT wipe the store, and says it is holding back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-nw-prune-'))
  const { warns, make } = pruneStore()
  const s = await make(dir)

  s.pruneTabs('player1', [0, 1, 2])          // the normal case: nothing goes
  assert.deepEqual(warns, [], 'a matching tab list must stay quiet — this runs every ~15 min per user')

  s.pruneTabs('player1', [])                 // one empty response
  assert.equal(warns.length, 1)
  assert.match(warns[0], /would drop 3 of 3 stored tabs for player1 — held back until a second list agrees/)
  assert.match(warns[0], /EMPTY/, 'the empty list is called out as the case it is')
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 1, 2], 'nothing was thrown away')

  s.pruneTabs('player1', [])                 // …and it stays empty: now it goes
  assert.equal(warns.length, 2)
  assert.match(warns[1], /pruning 3 of 3 stored tabs for player1 \(live tab list: 0\) — two consecutive lists agree/)
  assert.deepEqual(s.tabList('player1'), [])
  await rm(dir, { recursive: true, force: true })
})

test('pruneTabs: a single short list between two good ones costs nothing at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-nw-prune-blip-'))
  const { warns, make } = pruneStore()
  const s = await make(dir)

  s.pruneTabs('player1', [0])                // the blip
  s.pruneTabs('player1', [0, 1, 2])          // …and the next list is whole again
  s.pruneTabs('player1', [0])                // a later, unrelated blip
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 1, 2],
    'the good list in between clears the proposal — "consecutive" has to mean consecutive')
  assert.equal(warns.length, 2, 'two hold lines, no prune line')
  for (const w of warns) assert.doesNotMatch(w, /pruning/)
  await rm(dir, { recursive: true, force: true })
})

test('pruneTabs: two short lists that disagree about WHICH tab is gone confirm neither', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-nw-prune-disagree-'))
  const { make } = pruneStore()
  const s = await make(dir)

  s.pruneTabs('player1', [0, 2])             // says tab 1 is gone
  s.pruneTabs('player1', [0, 1])             // says tab 2 is gone
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 1, 2],
    'only the intersection of two lists is confirmed, and it is empty here')
  s.pruneTabs('player1', [0, 1])             // now two lists agree on tab 2
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 1])
  await rm(dir, { recursive: true, force: true })
})

test('pruneTabs: what two lists agree on goes, what only one says is held', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-nw-prune-partial-'))
  const { warns, make } = pruneStore()
  const s = await make(dir)

  s.pruneTabs('player1', [0, 2])             // proposes 1
  s.pruneTabs('player1', [0])                // confirms 1, proposes 2
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 2])
  assert.match(warns[1], /pruning 1 of 3 stored tabs for player1 \(live tab list: 1\)/)
  assert.match(warns[1], /1 further one\(s\) held back/)
  await rm(dir, { recursive: true, force: true })
})

test('pruneTabs: the proposal is per user — one account answering short cannot drop another', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-nw-prune-users-'))
  const s = createNetworthStore(join(dir, 'nw.json'), { log: { warn () {} } })
  await s.load()
  await s.setTab('player1', 0, tab(0, 'A'))
  await s.setTab('player1', 1, tab(1, 'B'))
  await s.setTab('player2', 0, tab(0, 'X'))
  await s.setTab('player2', 1, tab(1, 'Y'))

  s.pruneTabs('player1', [0])
  s.pruneTabs('player2', [0, 1])
  s.pruneTabs('player1', [0])
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0])
  assert.deepEqual(s.tabList('player2').map(t => t.index), [0, 1], 'the other user was never in question')
  await rm(dir, { recursive: true, force: true })
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

function recorder () {
  const warnings = []
  return { warnings, log: { warn: m => warnings.push(m), log: () => {} } }
}

const BROKEN = /^nw\.json\.broken-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

test('an old schema_version:1 store is moved aside, the store starts empty and stays writable', async () => {
  const { dir, p, cleanup } = await fresh()
  // Old snapshot-based store (v1): structurally incompatible, no migration.
  await writeFile(p, JSON.stringify({ schema_version: 1, snapshots: { player1: [{ at: 't', totalChaos: 999 }] } }), 'utf8')
  const { warnings, log } = recorder()
  const s = createNetworthStore(p, { log })
  await s.load()
  assert.equal(s.data.schema_version, 2)
  assert.deepEqual(s.data.users, {})
  assert.deepEqual(s.tabList('player1'), [])
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], BROKEN)
  assert.equal(existsSync(p), false)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('schema_version 1 is older than 2'))
  assert.ok(warnings[0].includes(p))
  assert.equal(s.writable, true)
  await s.setTab('player1', 0, tab(0, 'A'))
  assert.equal(JSON.parse(await readFile(p, 'utf8')).schema_version, 2)
  await cleanup()
})

test('corrupt JSON is moved to .broken-<timestamp> with one warning, the store starts empty', async () => {
  const { dir, p, cleanup } = await fresh()
  await writeFile(p, '{ this is broken', 'utf8')
  const { warnings, log } = recorder()
  const s = createNetworthStore(p, { log })
  await s.load()
  assert.equal(s.data.schema_version, 2)
  assert.deepEqual(s.data.users, {})
  const files = (await readdir(dir)).filter(f => BROKEN.test(f))
  assert.equal(files.length, 1)
  assert.equal(await readFile(join(dir, files[0]), 'utf8'), '{ this is broken')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('invalid JSON'))
  assert.ok(warnings[0].includes('the stash is read again tab by tab'))
  await cleanup()
})

test('a store file from a newer release is left untouched and the store runs in memory', async () => {
  const { dir, p, cleanup } = await fresh()
  const original = JSON.stringify({ schema_version: 3, users: { player1: { tabs: {} } } })
  await writeFile(p, original, 'utf8')
  const { warnings, log } = recorder()
  const s = createNetworthStore(p, { log })
  await s.load()
  assert.equal(s.writable, false)
  assert.deepEqual(s.data.users, {})
  await s.setTab('player1', 0, tab(0, 'A'))
  assert.equal(await readFile(p, 'utf8'), original)
  assert.notEqual(s.getTab('player1', 0), null)
  assert.equal((await readdir(dir)).filter(f => /\.broken-/.test(f)).length, 0)
  assert.equal(warnings.length, 1)
  await cleanup()
})

test('users that is not an object is moved aside, not emptied and overwritten', async () => {
  const { dir, p, cleanup } = await fresh()
  await writeFile(p, JSON.stringify({ schema_version: 2, users: null }), 'utf8')
  const { warnings, log } = recorder()
  const s = createNetworthStore(p, { log })
  await s.load()
  assert.equal((await readdir(dir)).filter(f => BROKEN.test(f)).length, 1)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('users is missing or not an object'))
  await cleanup()
})

test('price notes ride in the same schema: kept across a reload, and a file written before them still loads', async () => {
  const { dir, p, s, cleanup } = await fresh()
  const listed = [{ name: 'Headhunter', kind: 'unique', qty: 1, x: 3, y: 7, note: '~price 5 chaos', fromTab: false, chaosEach: 900, uncertain: null }]
  await s.setTab('player1', 0, { ...tab(0, 'Sale'), listed })
  const s2 = createNetworthStore(p)
  await s2.load()
  assert.deepEqual(s2.getTab('player1', 0).listed, listed)

  // A store file from before the field: same schema_version, no `listed` key.
  // It is read as it is, nothing is moved aside, the key is simply missing.
  const old = join(dir, 'old.json')
  await writeFile(old, JSON.stringify({ schema_version: 2, users: { player1: { tabs: { 0: { ...tab(0, 'Old'), syncedAt: 1 } }, history: [] } } }), 'utf8')
  const rec = recorder()
  const s3 = createNetworthStore(old, { log: rec.log })
  await s3.load()
  assert.equal(s3.writable, true)
  assert.equal(s3.getTab('player1', 0).name, 'Old')
  assert.equal(s3.getTab('player1', 0).listed, undefined)
  assert.deepEqual(rec.warnings, [])
  assert.deepEqual((await readdir(dir)).filter(f => f.includes('broken')), [])
  await cleanup()
})
