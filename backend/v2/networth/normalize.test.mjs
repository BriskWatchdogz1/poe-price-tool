import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadItemsIndex, normalizeItem } from './normalize.mjs'

// Minimal but shape-accurate GGG stash item fixtures (legacy get-stash-items).
const CHAOS_STACK = { frameType: 5, typeLine: 'Chaos Orb', name: '', stackSize: 273, ilvl: 0 }
const DIV_CARD = { frameType: 6, typeLine: 'The Doctor', name: '', stackSize: 3, ilvl: 0 }
const UNIQUE_MARKUP = { // legacy API markup in the name (yes, really: <<set:...>> prefixes)
  frameType: 3, name: '<<set:MS>><<set:M>><<set:S>>Abyssus', typeLine: 'Ezomyte Burgonet', ilvl: 84
}
const RARE_RING = { frameType: 2, name: 'Doom Loop', typeLine: 'Vermillion Ring', ilvl: 84 }
const GEM = {
  frameType: 4, name: '', typeLine: 'Enlighten Support', ilvl: 0, corrupted: true,
  properties: [
    { name: 'Level', values: [['4', 0]] },
    { name: 'Quality', values: [['+10%', 1]] }
  ]
}
const GEM_BARE = { frameType: 4, name: '', typeLine: 'Absolution', ilvl: 0 } // no properties
const BEAST = { frameType: 0, name: '', typeLine: 'Black Mórrigan', ilvl: 82 }
const INCUBATOR = { frameType: 0, name: '', typeLine: 'Abyssal Incubator', stackSize: 4, ilvl: 80 }
const VIAL = { frameType: 0, name: '', typeLine: 'Vial of Awakening', stackSize: 2, ilvl: 0 }
const SCARAB = { frameType: 0, name: '', typeLine: 'Titanic Scarab', stackSize: 9, ilvl: 0 }
// Itemised corpse: an ITEM without tradeTag/exchangeable, recognisable only by
// its icon (…Corpse.png). "Blasphemer" is such a corpse ITEM row in items.ndjson.
const CORPSE = { frameType: 0, name: '', typeLine: 'Blasphemer', stackSize: 2, ilvl: 0 }

let index
before(async () => {
  index = await loadItemsIndex()
})

test('stackable: Chaos Orb with a stack', () => {
  const d = normalizeItem(CHAOS_STACK, index)
  assert.equal(d.kind, 'stackable')
  assert.equal(d.name, 'Chaos Orb')
  assert.equal(d.stack, 273)
})

test('stackable: Scarab (ITEM + tradeTag + exchangeable), tradeTag passed through', () => {
  const d = normalizeItem(SCARAB, index)
  assert.equal(d.kind, 'stackable')
  assert.equal(d.stack, 9)
  assert.equal(d.tradeTag, 'titanic-scarab') // == poe.ninja exchange id
})

test('divcard via frameType 6', () => {
  const d = normalizeItem(DIV_CARD, index)
  assert.deepEqual({ kind: d.kind, name: d.name, stack: d.stack }, { kind: 'divcard', name: 'The Doctor', stack: 3 })
})

test('unique: markup stripped, category via base join (items.ndjson craftable.category)', () => {
  const d = normalizeItem(UNIQUE_MARKUP, index)
  assert.equal(d.kind, 'unique')
  assert.equal(d.name, 'Abyssus')
  assert.equal(d.baseType, 'Ezomyte Burgonet')
  assert.equal(d.category, 'Helmet')
  assert.equal(d.stack, 1)
})



test('rare gear -> skip with a reason', () => {
  assert.equal(normalizeItem(RARE_RING, index).reason, 'rare-gear')
})

test('gem: frameType 4 -> kind gem with level/quality/corrupted from properties', () => {
  const d = normalizeItem(GEM, index)
  assert.equal(d.kind, 'gem')
  assert.equal(d.name, 'Enlighten Support')
  assert.equal(d.level, 4)
  assert.equal(d.quality, 10)
  assert.equal(d.corrupted, true)
  assert.equal(d.stack, 1)
})

test('gem without properties: robust (level null, quality 0, corrupted false)', () => {
  const d = normalizeItem(GEM_BARE, index)
  assert.equal(d.kind, 'gem')
  assert.equal(d.name, 'Absolution')
  assert.equal(d.level, null)
  assert.equal(d.quality, 0)
  assert.equal(d.corrupted, false)
})

test('beast/vial are recognised', () => {
  assert.equal(normalizeItem(BEAST, index).kind, 'beast')
  assert.equal(normalizeItem(VIAL, index).kind, 'vial')
})

test('incubators are GONE from the vendored data (as of Allflame)', () => {
  // With the APT data refresh (upstream 25.07.2026) GGG removed every incubator
  // from the item data — all 40 names are gone. The incubator rule in kinds.mjs
  // stays in place for old holdings in Standard, but without a data row it never
  // fires any more. If this test ever flips, the incubators are back and the test
  // above belongs merged into it again.
  assert.equal(normalizeItem(INCUBATOR, index).kind, 'skip')
})

test('itemised corpse via the items.ndjson icon signal -> kind corpse', () => {
  const d = normalizeItem(CORPSE, index)
  assert.equal(d.kind, 'corpse')
  assert.equal(d.name, 'Blasphemer')
  assert.equal(d.stack, 2)
  assert.equal(d.tradeTag, null)
})

test('unique map: category Map comes from the Map Tier property, not from items.ndjson', () => {
  // The map bases are missing from items.ndjson (only a few special bases are in
  // there), so this used to come out as category null -> unpriced. The signal is
  // the item property "Map Tier".
  const umap = {
    frameType: 3, name: 'Maelström of Chaos', typeLine: 'Torture Chamber Map', ilvl: 76,
    properties: [{ name: 'Map Tier', values: [['8', 0]] }, { name: 'Quantity', values: [['+20%', 1]] }]
  }
  const d = normalizeItem(umap, index)
  assert.equal(d.kind, 'unique')
  assert.equal(d.category, 'Map')
  assert.equal(d.name, 'Maelström of Chaos')
  assert.equal(d.unidentified, false)

  // Without a Map Tier property and without a base hit it stays "no category".
  const noProps = { frameType: 3, name: 'Whatever', typeLine: 'Unknown Base', ilvl: 1 }
  assert.equal(normalizeItem(noProps, index).category, null)
  // malformed properties -> no throw.
  const weird = { frameType: 3, name: 'Whatever', typeLine: 'Unknown Base', properties: [null, 'x', {}] }
  assert.equal(normalizeItem(weird, index).category, null)
})

test('unique with a known category is left alone: the Map Tier fallback does not kick in', () => {
  // Even with a Map Tier property the base category from items.ndjson wins.
  const helm = { ...UNIQUE_MARKUP, properties: [{ name: 'Map Tier', values: [['16', 0]] }] }
  assert.equal(normalizeItem(helm, index).category, 'Helmet')
})

test('unidentified unique: empty name -> English label, no pricing attempt', () => {
  const unid = { frameType: 3, name: '', typeLine: 'Ezomyte Burgonet', ilvl: 84, identified: false }
  const d = normalizeItem(unid, index)
  assert.equal(d.kind, 'unique')
  assert.equal(d.name, 'Unidentified Ezomyte Burgonet')
  assert.equal(d.unidentified, true)
  assert.equal(d.category, 'Helmet') // category stays correct, only the name is unknown

  const bare = { frameType: 3, name: '', typeLine: '', ilvl: 84 }
  assert.equal(normalizeItem(bare, index).name, 'Unidentified Unique')
})

test('unique carries the largest linked socket group (for the 5L/6L price row)', () => {
  const six = { frameType: 3, name: "Nuro's Harp", typeLine: 'Harbinger Bow', ilvl: 79,
    sockets: [0, 0, 0, 0, 0, 0].map(g => ({ group: g })) }
  assert.equal(normalizeItem(six, index).links, 6)

  // Two groups: 3 + 2 -> the largest is 3, i.e. unlinked in poe.ninja terms.
  const split = { frameType: 3, name: 'X', typeLine: 'Harbinger Bow', ilvl: 79,
    sockets: [{ group: 0 }, { group: 0 }, { group: 0 }, { group: 1 }, { group: 1 }] }
  assert.equal(normalizeItem(split, index).links, 3)

  // No sockets at all (ring/amulet) -> 0, no crash.
  const ring = { frameType: 3, name: 'Y', typeLine: 'Two-Stone Ring', ilvl: 79 }
  assert.equal(normalizeItem(ring, index).links, 0)
})
