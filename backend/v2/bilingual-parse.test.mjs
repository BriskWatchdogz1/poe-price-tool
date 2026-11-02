// Two languages, one process, one snapshot — against the REAL engine bundle.
//
// engine-instances.test.mjs pins the lifecycle rules against a fake module.
// This file is the other half: it actually loads the bundle twice, from ONE
// versioned snapshot dir that carries data/en and data/de side by side, and
// checks the three properties the design rests on.
//
//   1. The two instances do not contaminate each other, even though
//      __aptEnv.BASE_URL is process-wide: the English clipboard resolves on the
//      English instance and the localized one on the German instance, in the
//      same process, after a serialized load.
//   2. `refName` stays English on both — that is what the trade side joins on
//      (create-item-filters.ts uses refName / trade.ids, engine.mts parses with
//      useEn: true), so a preset built by the German instance is usable by the
//      English one.
//   3. A COMPLETE parse on the German instance makes no http(s) call at all.
//
// The fixture is a synthetic locale, built the same way localized-names.
// test.mjs builds its own: the real English snapshot with an umlaut prefix on
// every `name`, every `refName` left alone, indices regenerated with
// apt-index.mjs. A real German data set does not exist yet (it is generated
// locally, by another work package), and client_strings stays English here on
// purpose — the checked-in German one is covered by client-strings-de.test.mjs,
// and mixing both would test two things at once.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildIndexBins } from './apt-index.mjs'
import { createEngineInstances } from './engine-instances.mjs'
import { LANG_FILES } from './data-refresher.mjs'

const EN_DIR = new URL('../../renderer/public/data/en/', import.meta.url)
const DATA_DIR = new URL('../../renderer/public/data/', import.meta.url)
const BUNDLE = new URL('./engine.bundle.mjs', import.meta.url).href

const translate = name => `Ü${name}`
const UNIQUE = 'Combat Focus'
const BASE = 'Cobalt Jewel'

const root = await mkdtemp(path.join(tmpdir(), 'ppt-bilingual-'))
after(() => rm(root, { recursive: true, force: true }))

// --- fixture: ONE snapshot dir with both languages in it ---------------------

const enItems = await readFile(new URL('items.ndjson', EN_DIR), 'utf8')
const enStats = await readFile(new URL('stats.ndjson', EN_DIR), 'utf8')
const deItems = enItems.split('\n').filter(Boolean)
  .map(l => JSON.stringify({ ...JSON.parse(l), name: translate(JSON.parse(l).name) }))
  .join('\n') + '\n'

const snapshot = path.join(root, 'apt/v-2026-08-08')
await mkdir(path.join(snapshot, 'data/en'), { recursive: true })
await mkdir(path.join(snapshot, 'data/de'), { recursive: true })
for (const f of ['items.ndjson', 'stats.ndjson', 'client_strings.js', 'app_i18n.json']) {
  await copyFile(new URL(f, EN_DIR), path.join(snapshot, 'data/en', f))
}
for (const aux of ['item-drop.json', 'patrons.json']) {
  await copyFile(new URL(aux, DATA_DIR), path.join(snapshot, 'data', aux))
}
// data/de NEXT TO data/en, never instead of it: the localized load path still
// reads data/en/client_strings.js from the same root (CLIENT_STRINGS_REF).
await writeFile(path.join(snapshot, 'data/de/items.ndjson'), deItems)
await writeFile(path.join(snapshot, 'data/de/stats.ndjson'), enStats)
await copyFile(new URL('client_strings.js', EN_DIR), path.join(snapshot, 'data/de/client_strings.js'))
for (const [lang, items, stats] of [['en', enItems, enStats], ['de', deItems, enStats]]) {
  const bins = buildIndexBins({ itemsNdjson: items, statsNdjson: stats })
  for (const [name, arr] of Object.entries(bins)) {
    await writeFile(path.join(snapshot, 'data', lang, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
  }
}

// --- the fetch spy, installed BEFORE anything loads --------------------------
//
// Order matters and is easy to get wrong: installFetchFs() (engine.mts) binds
// `nativeFetch` to whatever globalThis.fetch is at its FIRST call and then
// replaces the global. A spy installed after that would sit OUTSIDE the
// adapter and never see the calls it is supposed to guard — the test would be
// green without checking anything. So the spy goes on first; the adapter then
// wraps it, handles every file:// URL itself, and passes only real network
// calls down to us.
const netCalls = []
const beforeAdapter = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input))
  if (/^https?:/i.test(url)) {
    netCalls.push(url)
    throw new Error(`NETWORK CALL: ${url}`)
  }
  return beforeAdapter(input, init)
}

let engines
before(async () => {
  engines = await createEngineInstances({ bundleUrl: BUNDLE, languages: ['de'], log: console })
  await engines.ready({ publicDataDir: pathToFileURL(snapshot).href + '/' })
})

// --- the spy is really in the chain -----------------------------------------

test('the fetch spy sits underneath the engine\'s file:// adapter', async () => {
  assert.equal(globalThis.__aptFetchPatched, true, 'the engine patched the global fetch')
  assert.notEqual(globalThis.fetch, beforeAdapter)
  const before = netCalls.length
  await assert.rejects(() => globalThis.fetch('https://www.pathofexile.com/api/trade/search/Standard'), /NETWORK CALL/)
  assert.equal(netCalls.length, before + 1, 'a network call really would be recorded')
  netCalls.length = before
})

// --- both languages live, from one snapshot ---------------------------------

test('both instances came up, serially, from the same snapshot root', () => {
  assert.deepEqual(engines.liveLanguages(), ['en', 'de'])
  assert.equal(globalThis.__aptEnv.BASE_URL, pathToFileURL(snapshot).href + '/')
})

const clipboardFor = (name, base) => `Item Class: Jewels
Rarity: Unique
${name}
${base}
--------
Limited to: 2
Radius: Large
--------
Item Level: 84
--------
30% increased Elemental Damage with Attack Skills
--------
Place into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the Socket.
`

test('the German instance resolves a localized clipboard to the English refName', async () => {
  const { item } = await engines.parserFor('de').parseItem(clipboardFor(translate(UNIQUE), translate(BASE)), { league: 'Standard' })
  assert.equal(item.info.namespace, 'UNIQUE')
  assert.equal(item.info.refName, UNIQUE, 'the join key for the trade side and the price sources stays English')
  assert.equal(item.info.unique.base, BASE)
})

test('the English instance is untouched by it — no contamination through the shared __aptEnv', async () => {
  const { item } = await engines.parserFor('en').parseItem(clipboardFor(UNIQUE, BASE), { league: 'Standard' })
  assert.equal(item.info.refName, UNIQUE)
  // ...and the localized text does NOT parse there: proof the two module
  // graphs really hold different databases rather than one shared one.
  await assert.rejects(
    () => engines.parserFor('en').parseItem(clipboardFor(translate(UNIQUE), translate(BASE)), { league: 'Standard' }),
    /parse failed/
  )
})

// A rare item with real mods on it: this one goes through the stat matcher and
// the matcher index as well, not just the item-name lookup.
const RARE_DE = `Item Class: Body Armours
Rarity: Rare
Dread Cloak
${translate('Astral Plate')}
--------
Quality: +20% (augmented)
Armour: 1245 (augmented)
--------
Requirements:
Level: 62
Str: 180
--------
Sockets: R-R-R-R-R-R
--------
Item Level: 84
--------
+55 to maximum Life
+30% to Fire Resistance
--------
`

test('a complete parse on the German instance makes no http(s) call', async () => {
  netCalls.length = 0
  const { item, presets } = await engines.parserFor('de').parseItem(RARE_DE, { league: 'Standard' })
  // Really a full parse: item database (base type via the translated name
  // column), stat matchers, and the filter presets built on top.
  assert.equal(item.info.refName, 'Astral Plate')
  assert.ok(presets.presets.length > 0, 'presets were really built')
  assert.ok(presets.presets.some(p => p.stats.length > 0), 'mods were really matched into stat filters')
  assert.deepEqual(netCalls, [], 'the parse path must never reach the network')
})

test('the German instance still exposes exactly parseItem when it is the real bundle', () => {
  assert.deepEqual(Reflect.ownKeys(engines.parserFor('de')), ['parseItem'])
  // The primary, by contrast, is the full module — that is where trade calls
  // and the shared rate limiter live.
  assert.equal(typeof engines.primary().searchPreset, 'function')
})

test('the localized set is exactly the files a snapshot has to carry', async () => {
  for (const f of LANG_FILES) {
    assert.ok((await readFile(path.join(snapshot, 'data/de', f), 'utf8')).length > 0, f)
  }
})
