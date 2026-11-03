// corpse-store.mjs — name->{chaos,at} with TTL, caches BOTH prices AND nulls,
// atomic persist, league-guarded. Mirrors faustus-store's discipline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

function recorder () {
  const warnings = []
  return { warnings, log: { warn: m => warnings.push(m), log: () => {} } }
}

test('a corrupt file is moved aside with one warning, the store starts empty', async () => {
  const { dir, p, cleanup } = await fresh()
  await writeFile(p, '{ not json', 'utf8')
  const { warnings, log } = recorder()
  const s = createCorpseStore(p, { log })
  await s.load()
  assert.deepEqual(s.data.entries, {})
  const broken = (await readdir(dir)).filter(f => /^corpse\.json\.broken-/.test(f))
  assert.equal(broken.length, 1)
  assert.equal(await readFile(join(dir, broken[0]), 'utf8'), '{ not json')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('POE_CORPSE_BUDGET_PER_HOUR'))
  assert.equal(s.writable, true)
  await cleanup()
})

test('a file from a newer release is left untouched and setPrice does not write', async () => {
  const { p, cleanup } = await fresh()
  const original = JSON.stringify({ schema_version: 2, entries: { X: { chaos: 1, at: 1 } } })
  await writeFile(p, original, 'utf8')
  const { log } = recorder()
  const s = createCorpseStore(p, { log })
  await s.load()
  assert.equal(s.writable, false)
  const t = 5_000_000
  await s.setPrice('Standard', 'Y', 3, t)
  assert.equal(await readFile(p, 'utf8'), original)
  assert.equal(s.getPrice('Y', t + 1), 3)
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

// docs/pricing-logic.md "Uncertain prices": the valuator marks a corpse price
// averaged from too few offers. The count is stored with the price (`n`,
// additive — no schema bump), and everything it cannot vouch for reads null.
test('setPrice keeps the listing count, and an entry without it reads as unknown', async () => {
  const { p, s, cleanup } = await fresh({ ttlMs: 6 * HOUR })
  const t = 6_000_000
  await s.setPrice('Standard', 'X', 10, t, 1)
  assert.equal(s.getListings('X'), 1)
  assert.equal(JSON.parse(await readFile(p, 'utf8')).entries.X.n, 1, 'the count is persisted')
  // No price, no count: a cached null has nothing to vouch for.
  await s.setPrice('Standard', 'Y', null, t, 0)
  assert.equal(s.getListings('Y'), null)
  assert.equal(s.get('Y').n, undefined)
  // A broken count is dropped, never stored.
  await s.setPrice('Standard', 'Half', 10, t, 1.5)
  await s.setPrice('Standard', 'Negative', 10, t, -1)
  await s.setPrice('Standard', 'Omitted', 10, t)
  assert.equal(s.getListings('Half'), null)
  assert.equal(s.getListings('Negative'), null)
  assert.equal(s.getListings('Omitted'), null)
  assert.equal(s.getListings('Never priced'), null)
  await cleanup()
})

test('a file written before the listing count existed loads, and its entries read as unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-corpse-'))
  const p = join(dir, 'corpse.json')
  const t = 7_000_000
  await writeFile(p, JSON.stringify({
    schema_version: 1, updatedAt: t, league: 'Standard', entries: { 'Forest Tiger': { chaos: 42, at: t }, Bad: { chaos: 9, at: t, n: 'x' } }
  }))
  const s = createCorpseStore(p, { ttlMs: 6 * HOUR })
  await s.load()
  assert.equal(s.getPrice('Forest Tiger', t + 1000), 42)
  assert.equal(s.getListings('Forest Tiger'), null)
  assert.equal(s.getListings('Bad'), null)
  await rm(dir, { recursive: true, force: true })
})
