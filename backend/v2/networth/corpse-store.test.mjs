// corpse-store.mjs — name->{chaos,at} with TTL, caches BOTH prices AND nulls,
// atomic persist, league-guarded. Mirrors faustus-store's discipline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCorpseStore } from './corpse-store.mjs'

const HOUR = 60 * 60 * 1000

async function fresh (opts) {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-corpse-'))
  const p = join(dir, 'corpse.json')
  const s = createCorpseStore(p, opts)
  await s.load()
  return { dir, p, s, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('no file on disk -> empty store', async () => {
  const { s, cleanup } = await fresh()
  assert.equal(s.data.schema_version, 1)
  assert.deepEqual(s.data.entries, {})
  assert.equal(s.getPrice('Forest Tiger'), null)
  assert.equal(s.league(), null)
  assert.equal(s.isFresh('Forest Tiger'), false)
  assert.equal(s.ageOf('Forest Tiger'), Infinity)
  await cleanup()
})

test('setPrice(number): persists immediately, counts as fresh, getPrice returns the number', async () => {
  const { p, s, cleanup } = await fresh({ ttlMs: 6 * HOUR })
  const t = 1_000_000
  await s.setPrice('Standard', 'Forest Tiger', 42, t)
  assert.equal(s.getPrice('Forest Tiger', t + 1000), 42)
  assert.equal(s.isFresh('Forest Tiger', t + 1000), true)
  assert.equal(s.league(), 'Standard')

  const onDisk = JSON.parse(await readFile(p, 'utf8'))
  assert.equal(onDisk.entries['Forest Tiger'].chaos, 42)
  assert.equal(onDisk.league, 'Standard')
  await cleanup()
})

test('null is CACHED (0 results) — getPrice=null but the entry counts as fresh', async () => {
  const { s, cleanup } = await fresh({ ttlMs: 6 * HOUR })
  const t = 2_000_000
  await s.setPrice('Standard', 'Imperfect-ish Illiquid', null, t)
  // getPrice stays null (unpriced), BUT the entry is fresh -> the pricer does
  // NOT fire another search. That is the whole point of caching nulls.
  assert.equal(s.getPrice('Imperfect-ish Illiquid', t + 1000), null)
  assert.equal(s.isFresh('Imperfect-ish Illiquid', t + 1000), true)
  assert.ok(s.get('Imperfect-ish Illiquid') !== null)
  assert.equal(s.get('Imperfect-ish Illiquid').chaos, null)
  await cleanup()
})

test('stale past the TTL -> getPrice=null, isFresh=false, ageOf keeps growing', async () => {
  const { s, cleanup } = await fresh({ ttlMs: 6 * HOUR })
  const t = 3_000_000
  await s.setPrice('Standard', 'Forest Tiger', 42, t)
  const later = t + 6 * HOUR + 1
  assert.equal(s.getPrice('Forest Tiger', later), null)
  assert.equal(s.isFresh('Forest Tiger', later), false)
  assert.equal(s.ageOf('Forest Tiger', later), 6 * HOUR + 1)
  await cleanup()
})

test('NaN/Infinity are stored as null: never a corrupt price', async () => {
  const { s, cleanup } = await fresh()
  const t = 4_000_000
  await s.setPrice('Standard', 'Bad', NaN, t)
  assert.equal(s.get('Bad').chaos, null)
  await s.setPrice('Standard', 'Bad2', Infinity, t)
  assert.equal(s.get('Bad2').chaos, null)
  await cleanup()
})

test('load tolerates a corrupt / outdated file -> empty store', async () => {
  const { p, s, cleanup } = await fresh()
  await s.setPrice('Standard', 'X', 1, 5_000_000)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(p, '{ not json', 'utf8')
  const s2 = createCorpseStore(p)
  await s2.load()
  assert.deepEqual(s2.data.entries, {})
  await cleanup()
})

test('setPrice for a different league drops the entries of the old league', async () => {
  const { p, s, cleanup } = await fresh({ ttlMs: 6 * HOUR })
  const t = 3_000_000
  await s.setPrice('Old League', 'Forest Tiger', 42, t)
  await s.setPrice('Old League', 'Rock Golem', 7, t)
  await s.setPrice('New League', 'Cave Bear', 9, t + 1000)
  // Without the clear, the old prices would be served as New League prices for
  // up to the TTL: the valuator's guard compares the single league field only.
  assert.equal(s.league(), 'New League')
  assert.equal(s.getPrice('Forest Tiger', t + 2000), null)
  assert.equal(s.get('Rock Golem'), null)
  assert.equal(s.getPrice('Cave Bear', t + 2000), 9)
  const onDisk = JSON.parse(await readFile(p, 'utf8'))
  assert.deepEqual(Object.keys(onDisk.entries), ['Cave Bear'])
  await cleanup()
})

test('setPrice in the same league keeps the other entries', async () => {
  const { s, cleanup } = await fresh({ ttlMs: 6 * HOUR })
  const t = 4_000_000
  await s.setPrice('Standard', 'Forest Tiger', 42, t)
  await s.setPrice('Standard', 'Rock Golem', 7, t + 1000)
  assert.equal(s.getPrice('Forest Tiger', t + 2000), 42)
  assert.equal(s.getPrice('Rock Golem', t + 2000), 7)
  await cleanup()
})

test('setPrice with no stored league (legacy file) keeps the entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-corpse-'))
  const p = join(dir, 'corpse.json')
  const t = 5_000_000
  await writeFile(p, JSON.stringify({
    schema_version: 1, updatedAt: t, league: null, entries: { 'Forest Tiger': { chaos: 42, at: t } }
  }))
  const s = createCorpseStore(p, { ttlMs: 6 * HOUR })
  await s.load()
  await s.setPrice('Standard', 'Rock Golem', 7, t + 1000)
  assert.equal(s.getPrice('Forest Tiger', t + 2000), 42)
  await rm(dir, { recursive: true, force: true })
})
