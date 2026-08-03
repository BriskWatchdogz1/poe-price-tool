// The vendored APT data snapshot (renderer/public/data/en) and the CLI that
// refreshes it (apt-data-update.mjs).
//
// The case that motivated this: "The Crustacean's Call" (Primordial Staff,
// Velka boss drop from the current league patch). With the old snapshot the
// parser hard-failed with "parse failed: item.unknown" — the item database
// simply did not contain the unique. So the test below is not decoration: it is
// the exact symptom, in the exact place it appeared.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { diffLines, namespaceCounts, entryKeys, regenerateIndices } from './apt-data-update.mjs'
import { loadItemsIndex, normalizeItem } from './networth/normalize.mjs'
import { createValuator } from './networth/valuator.mjs'

const ITEMS = new URL('../../renderer/public/data/en/items.ndjson', import.meta.url)
const NEW_UNIQUE = "The Crustacean's Call"
const NEW_UNIQUE_BASE = 'Primordial Staff'

// --- the CLI's reporting helpers (pure, no network) -------------------------

test('diffLines counts additions and removals, duplicates included', () => {
  const d = diffLines('a\nb\nb\nc\n', 'a\nb\nd\nd\n')
  assert.equal(d.before, 4)
  assert.equal(d.after, 4)
  assert.deepEqual(d.added.sort(), ['d', 'd'])
  assert.deepEqual(d.removed.sort(), ['b', 'c'])
})

test('diffLines against an empty old file reports everything as added', () => {
  const d = diffLines('', 'a\nb\n')
  assert.equal(d.before, 0)
  assert.deepEqual(d.added.sort(), ['a', 'b'])
  assert.deepEqual(d.removed, [])
})

test('namespaceCounts groups by namespace and survives a broken line', () => {
  const c = namespaceCounts('{"namespace":"UNIQUE"}\nnot json\n{"namespace":"ITEM"}\n{"namespace":"UNIQUE"}\n')
  assert.deepEqual(c, { UNIQUE: 2, ITEM: 1 })
})

test('entryKeys: items keyed by namespace::refName, stat groups flattened to refs', () => {
  const items = entryKeys('items.ndjson', '{"namespace":"UNIQUE","refName":"X"}\n{"namespace":"ITEM","refName":"X"}\n')
  assert.deepEqual([...items].sort(), ['ITEM::X', 'UNIQUE::X'])

  const stats = entryKeys('stats.ndjson', '{"ref":"a"}\n{"stats":[{"ref":"b"},{"ref":"c"}]}\n')
  assert.deepEqual([...stats].sort(), ['a', 'b', 'c'])
})

test('regenerateIndices warns instead of throwing when the script cannot run', () => {
  assert.equal(regenerateIndices({ run: () => ({ error: new Error('boom'), status: null }) }), false)
  assert.equal(regenerateIndices({ run: () => ({ status: 0 }) }), true)
})

// --- the snapshot itself ----------------------------------------------------

test(`items.ndjson knows ${NEW_UNIQUE} as a UNIQUE on ${NEW_UNIQUE_BASE}`, async () => {
  const raw = await readFile(ITEMS, 'utf8')
  const hit = raw.split('\n').filter(Boolean).map(JSON.parse)
    .find(e => e.refName === NEW_UNIQUE && e.namespace === 'UNIQUE')
  assert.ok(hit, `${NEW_UNIQUE} is missing from items.ndjson — refresh it: npm run update-apt-data`)
  assert.equal(hit.unique.base, NEW_UNIQUE_BASE)
})

test('the fields the net-worth bridge joins on are still populated', async () => {
  const raw = await readFile(ITEMS, 'utf8')
  const entries = raw.split('\n').filter(Boolean).map(JSON.parse)
  // normalize.mjs / kinds.mjs read exactly these. A snapshot where one of them
  // vanished would not throw anywhere — every stash item would just silently
  // stop being classified, so assert their presence instead of assuming it.
  assert.ok(entries.every(e => typeof e.refName === 'string' && typeof e.namespace === 'string'))
  assert.ok(entries.some(e => e.craftable?.category))
  assert.ok(entries.some(e => e.unique?.base))
  assert.ok(entries.some(e => e.tradeTag != null))
  assert.ok(entries.some(e => e.exchangeable))
  assert.deepEqual(
    [...new Set(entries.map(e => e.namespace))].sort(),
    ['CAPTURED_BEAST', 'DIVINATION_CARD', 'GEM', 'ITEM', 'UNIQUE']
  )
})

// --- price-check parser (the symptom) ---------------------------------------

const CLIPBOARD = `Item Class: Warstaves
Rarity: Unique
${NEW_UNIQUE}
${NEW_UNIQUE_BASE}
--------
Warstaff
Physical Damage: 66-138
Critical Strike Chance: 6.60%
Attacks per Second: 1.30
Weapon Range: 1.3 metres
--------
Requirements:
Level: 68
Str: 113
Int: 113
--------
Sockets: B-B-B-B-B-B
--------
Item Level: 84
--------
+25% Chance to Block Spell Damage (implicit)
--------
Socketed Spells are Supported by level 20 Crab Totem
Totems have 100% increased Movement Speed
175% increased Spell Damage
60% increased Totem Duration
+2 to maximum number of Summoned Totems
--------
The tide always returns.
`

test('the APT parser identifies the new unique from clipboard text', async () => {
  // Reads items.ndjson through the generated items-name.index.bin, so this also
  // covers the indices being in step with the data.
  const engine = await import('./engine.bundle.mjs')
  const { item } = await engine.parseItem(CLIPBOARD, { league: 'Standard' })
  assert.equal(item.info.namespace, 'UNIQUE')
  assert.equal(item.info.refName, NEW_UNIQUE)
  assert.equal(item.info.unique.base, NEW_UNIQUE_BASE)
  assert.equal(item.category, 'Staff')
})

// --- net-worth path ---------------------------------------------------------

// The three lines poe.ninja really serves for this unique (Allflame, verified
// live): same name, same baseType, NO `variant` — they differ only by `links`.
// That is the links tiebreak's case, not the mod-text variant picker's.
const NINJA_LINES = [
  { name: NEW_UNIQUE, baseType: NEW_UNIQUE_BASE, links: 6, chaosValue: 454.8, count: 125, listingCount: 125 },
  { name: NEW_UNIQUE, baseType: NEW_UNIQUE_BASE, links: 5, chaosValue: 55, count: 73, listingCount: 73 },
  { name: NEW_UNIQUE, baseType: NEW_UNIQUE_BASE, chaosValue: 14, count: 399, listingCount: 940 }
]

const stashItem = links => ({
  name: NEW_UNIQUE,
  typeLine: NEW_UNIQUE_BASE,
  frameType: 3,
  identified: true,
  sockets: Array.from({ length: links }, () => ({ group: 0 })),
  explicitMods: [
    'Socketed Spells are Supported by level 20 Crab Totem',
    'Totems have 100% increased Movement Speed',
    '175% increased Spell Damage',
    '60% increased Totem Duration',
    '+2 to maximum number of Summoned Totems'
  ],
  implicitMods: ['+25% Chance to Block Spell Damage']
})

test('net worth: the new unique classifies as a Staff via the base join', async () => {
  const index = await loadItemsIndex()
  const desc = normalizeItem(stashItem(6), index)
  assert.equal(desc.kind, 'unique')
  assert.equal(desc.name, NEW_UNIQUE)
  assert.equal(desc.baseType, NEW_UNIQUE_BASE)
  // Comes from the ITEM entry for the BASE, which the snapshot already had
  // before this refresh — which is why net worth priced the item all along and
  // only the price check went blind.
  assert.equal(desc.category, 'Staff')
  assert.equal(desc.links, 6)
})

test('net worth: the links tiebreak picks the right one of the three ninja lines', async () => {
  const index = await loadItemsIndex()
  const v = createValuator({
    league: 'Allflame',
    deps: {
      fetchItemOverview: async (_league, type) => (type === 'UniqueWeapon' ? NINJA_LINES : []),
      fetchExchangeOverview: async () => null,
      fetchCurrencyOverview: async () => null,
    }
  })
  const priceOf = async links => (await v.value(normalizeItem(stashItem(links), index)))?.chaosEach

  assert.equal(await priceOf(6), 454.8)
  assert.equal(await priceOf(5), 55)
  // Unlinked: must NOT inherit the 6L price — the base line without `links` wins.
  assert.equal(await priceOf(4), 14)
  assert.equal(await priceOf(0), 14)
})
