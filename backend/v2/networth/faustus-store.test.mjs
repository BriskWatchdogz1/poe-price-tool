// faustus-store.mjs — get/set/isFresh/atomic-persist round-trip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaustusStore } from './faustus-store.mjs'

async function fresh () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-faustus-'))
  const p = join(dir, 'faustus.json')
  const s = createFaustusStore(p)
  await s.load()
  return { dir, p, s, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('empty store when the file does not exist', async () => {
  const { s, cleanup } = await fresh()
  assert.equal(s.data.schema_version, 1)
  assert.deepEqual(s.data.prices, {})
  assert.equal(s.getPrice('Chaos Orb'), null)
  assert.deepEqual(s.allPrices(), {})
  assert.equal(s.league(), null)
  assert.equal(s.updatedAt(), null)
  assert.equal(s.isFresh(60_000), false)
  await cleanup()
})

test('setPrices (Map): persists immediately and stamps updatedAt/league', async () => {
  const { p, s, cleanup } = await fresh()
  const before = Date.now()
  await s.setPrices('Standard', new Map([['Chaos Orb', 1], ['Divine Orb', 180]]))
  assert.equal(s.getPrice('Chaos Orb'), 1)
  assert.equal(s.getPrice('Divine Orb'), 180)
  assert.equal(s.getPrice('Unknown'), null)
  assert.deepEqual(s.allPrices(), { 'Chaos Orb': 1, 'Divine Orb': 180 })
  assert.equal(s.league(), 'Standard')
  assert.ok(s.updatedAt() >= before && s.updatedAt() <= Date.now())

  const onDisk = JSON.parse(await readFile(p, 'utf8'))
  assert.equal(onDisk.schema_version, 1)
  assert.equal(onDisk.league, 'Standard')
  assert.deepEqual(onDisk.prices, { 'Chaos Orb': 1, 'Divine Orb': 180 })
  await cleanup()
})

test('setPrices (plain object) behaves identically and throws out NaN/Infinity', async () => {
  const { s, cleanup } = await fresh()
  await s.setPrices('Standard', { 'Chaos Orb': 1, Broken: NaN, AlsoBroken: Infinity, Text: 'nope' })
  assert.deepEqual(s.allPrices(), { 'Chaos Orb': 1 })
  await cleanup()
})

test('setPrices REPLACES the whole map (no merge)', async () => {
  const { s, cleanup } = await fresh()
  await s.setPrices('Standard', { A: 1, B: 2 })
  await s.setPrices('Standard', { A: 5 })
  assert.deepEqual(s.allPrices(), { A: 5 })
  await cleanup()
})

test('isFresh: true inside the TTL, false after it', async () => {
  const { s, cleanup } = await fresh()
  const t0 = 1_000_000
  await s.setPrices('Standard', { A: 1 }, t0)
  assert.equal(s.isFresh(60_000, t0 + 1000), true)
  assert.equal(s.isFresh(60_000, t0 + 60_001), false)
  await cleanup()
})

test('atomic save: no .tmp file left behind, load() reads back exactly', async () => {
  const { dir, p, s, cleanup } = await fresh()
  await s.setPrices('Standard', { A: 1, B: 2 })
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(dir)
  assert.deepEqual(files, ['faustus.json'])

  const s2 = createFaustusStore(p)
  await s2.load()
  assert.deepEqual(s2.allPrices(), { A: 1, B: 2 })
  assert.equal(s2.league(), 'Standard')
  await cleanup()
})

test('load() tolerates broken JSON -> empty store, no crash', async () => {
  const { dir, p, s, cleanup } = await fresh()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(p, '{not json', 'utf8')
  await s.load()
  assert.deepEqual(s.data.prices, {})
  await cleanup()
})

test('load() tolerates a wrong schema_version -> empty store', async () => {
  const { p, s, cleanup } = await fresh()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(p, JSON.stringify({ schema_version: 99, prices: { A: 1 } }), 'utf8')
  await s.load()
  assert.deepEqual(s.data.prices, {})
  await cleanup()
})

test('writable:false -> setPrices updates in memory but writes nothing to disk', async () => {
  const { p, s, cleanup } = await fresh()
  s.writable = false
  await s.setPrices('Standard', { A: 1 })
  assert.deepEqual(s.allPrices(), { A: 1 })
  await assert.rejects(readFile(p, 'utf8'), /ENOENT/)
  await cleanup()
})

// --- ranges: additive, no schema bump ---------------------------------------

test('setPrices persists optional ranges, getRange returns {min,max}', async () => {
  const { p, s, cleanup } = await fresh()
  await s.setPrices('Standard', new Map([['Regal Orb', 0.35], ['Chaos Orb', 1]]), Date.now(),
    new Map([['Regal Orb', [0.2, 1]]]))
  assert.deepEqual(s.getRange('Regal Orb'), { min: 0.2, max: 1 })
  assert.equal(s.getRange('Chaos Orb'), null, 'no range -> null, never guessed')

  const onDisk = JSON.parse(await readFile(p, 'utf8'))
  assert.equal(onDisk.schema_version, 1, 'ranges is NOT a schema bump')
  assert.deepEqual(onDisk.ranges, { 'Regal Orb': [0.2, 1] })

  const s2 = createFaustusStore(p)
  await s2.load()
  assert.deepEqual(s2.getRange('Regal Orb'), { min: 0.2, max: 1 })
  assert.equal(s2.getPrice('Regal Orb'), 0.35)
  await cleanup()
})

test('setPrices without the ranges argument: prices as before, no ranges', async () => {
  const { s, cleanup } = await fresh()
  await s.setPrices('Standard', { A: 1 })
  assert.deepEqual(s.allPrices(), { A: 1 })
  assert.equal(s.getRange('A'), null)
  await cleanup()
})

test('unusable ranges are discarded (NaN, min >= max, half pairs)', async () => {
  const { s, cleanup } = await fresh()
  await s.setPrices('Standard', { A: 1, B: 2, C: 3, D: 4 }, Date.now(), {
    A: [NaN, 5], B: [5, 5], C: [7], D: [1, 3]
  })
  assert.equal(s.getRange('A'), null)
  assert.equal(s.getRange('B'), null, 'min === max is not a range')
  assert.equal(s.getRange('C'), null)
  assert.deepEqual(s.getRange('D'), { min: 1, max: 3 })
  await cleanup()
})

test('an old file WITHOUT ranges loads cleanly (prices stay, ranges are simply absent)', async () => {
  const { p, s, cleanup } = await fresh()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(p, JSON.stringify({
    schema_version: 1, updatedAt: Date.now(), league: 'Standard', prices: { A: 1.5 }
  }), 'utf8')
  await s.load()
  assert.equal(s.getPrice('A'), 1.5, 'an old file must still price')
  assert.equal(s.getRange('A'), null)
  assert.equal(s.isFresh(60_000), true)
  await cleanup()
})

// ---------------------------------------------------------------------------
// hours — WHEN each price was observed
//
// The store's `updatedAt` says when the refresher ran. The union walk in
// faustus.mjs hands it prices observed hours apart in the same tick, so the
// only honest place for an observation time is per item.
// ---------------------------------------------------------------------------

test('setPrices persists optional hours, getHour returns the unix hour', async () => {
  const { p, s, cleanup } = await fresh()
  await s.setPrices('Standard', new Map([['A', 10], ['B', 50]]), Date.now(), null, null,
    new Map([['A', 9 * 3600], ['B', 8 * 3600]]))
  assert.equal(s.getHour('A'), 9 * 3600)
  assert.equal(s.getHour('B'), 8 * 3600, 'two prices of one tick can carry different hours')
  assert.equal(s.getHour('Unknown'), null)
  const onDisk = JSON.parse(await readFile(p, 'utf8'))
  assert.deepEqual(onDisk.hours, { A: 9 * 3600, B: 8 * 3600 })
  await cleanup()
})

test('setPrices without the hours argument: prices as before, no hours', async () => {
  const { s, cleanup } = await fresh()
  await s.setPrices('Standard', new Map([['A', 10]]))
  assert.equal(s.getPrice('A'), 10)
  assert.equal(s.getHour('A'), null, 'absent, not invented')
  await cleanup()
})

test('unusable hour stamps are discarded, never rounded into something plausible', async () => {
  // A bad stamp is worse than none: it would make a price look older or younger
  // than it is, and the age gate acts on that.
  const { s, cleanup } = await fresh()
  await s.setPrices('Standard', new Map([['A', 1], ['B', 1], ['C', 1], ['D', 1], ['E', 1]]),
    Date.now(), null, null,
    { A: 0, B: -3600, C: NaN, D: Infinity, E: '9000' })
  for (const n of ['A', 'B', 'C', 'D', 'E']) assert.equal(s.getHour(n), null, `${n} kept a bad stamp`)
  assert.equal(s.getPrice('A'), 1, 'a bad stamp must not cost the price')
  await cleanup()
})

test('a file written before `hours` existed loads cleanly and reports the age as unknown', async () => {
  const { s, cleanup } = await fresh()
  s.data = { schema_version: 1, updatedAt: Date.now(), league: 'Standard', prices: { A: 7 } }
  assert.equal(s.getPrice('A'), 7)
  assert.equal(s.getHour('A'), null)
  await cleanup()
})
