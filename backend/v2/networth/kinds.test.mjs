// backend/v2/networth/kinds.test.mjs
// Covers the EXTENSIBLE kind system: classification (CLASSIFIERS/classify) and
// corpse icon detection — both pure, with no items.ndjson load involved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLASSIFIERS, classify, isCorpseEntry, itemModTexts } from './kinds.mjs'

// Minimal ctx: only the fields the rule under test actually reads.
const ctx = over => ({
  ggg: {}, name: '', typeLine: '', stack: 1, frame: 0, entry: undefined,
  index: { categoryOfBase () { return null } }, clusterSeed: {}, ...over
})

test('classify: corpse via the icon signal (…Corpse.png)', () => {
  const entry = { namespace: 'ITEM', refName: 'Blasphemer', icon: 'https://web.poecdn.com/x/GeofriCorpse.png' }
  const d = classify(ctx({ typeLine: 'Blasphemer', stack: 2, entry }))
  assert.deepEqual(d, { kind: 'corpse', name: 'Blasphemer', tradeTag: null, stack: 2 })
})

test('classify: corpse with NO items.ndjson entry via the raw stash icon (bridge data gap)', () => {
  // entry undefined (the corpse is missing from items.ndjson) -> fall back to
  // ggg.icon, and take the name from typeLine. Exactly the "Pain Artist is
  // missing" case.
  const d = classify(ctx({ ggg: { icon: 'https://web.poecdn.com/x/AfflictionMinion2Corpse.png' }, typeLine: 'Perfect Pain Artist', stack: 3, entry: undefined }))
  assert.deepEqual(d, { kind: 'corpse', name: 'Perfect Pain Artist', tradeTag: null, stack: 3 })
})

test('isCorpseEntry: gem corpse icons (…CorpseWarp.png) are NOT corpses', () => {
  assert.equal(isCorpseEntry({ namespace: 'ITEM', icon: 'x/CorpseWarp.png' }), false)
  assert.equal(isCorpseEntry({ namespace: 'ITEM', icon: 'x/HydraCorpse.png' }), true)
  assert.equal(isCorpseEntry({ namespace: 'GEM', icon: 'x/HydraCorpse.png' }), false) // ITEM only
})

test('classify: invitation via its base category (coverage audit task 4)', () => {
  // Maven's Invitations carry no tradeTag and are not exchangeable -> the only
  // signal is the base category 'Invitation' from items.ndjson. Without this
  // rule they would silently drop into the unknown skip.
  const d = classify(ctx({
    typeLine: 'Screaming Invitation', stack: 1, frame: 0,
    index: { categoryOfBase (b) { return b === 'Screaming Invitation' ? 'Invitation' : null } }
  }))
  assert.deepEqual(d, { kind: 'invitation', name: 'Screaming Invitation', stack: 1 })
})

test('classify: unknown ITEM with no matching rule -> skip unknown', () => {
  const d = classify(ctx({ typeLine: 'Sample Widget', frame: 0 }))
  assert.deepEqual(d, { kind: 'skip', reason: 'unknown', name: 'Sample Widget', stack: 1 })
})

test('extensible kind system: a new category costs exactly ONE CLASSIFIERS entry', () => {
  // A single entry is all it takes for a new kind to be recognised.
  const rule = { kind: 'sample', detect: c => c.typeLine === 'Sample Widget' ? { kind: 'sample', name: c.typeLine, stack: c.stack } : null }
  CLASSIFIERS.unshift(rule)
  try {
    const d = classify(ctx({ typeLine: 'Sample Widget', stack: 3 }))
    assert.deepEqual(d, { kind: 'sample', name: 'Sample Widget', stack: 3 })
  } finally {
    CLASSIFIERS.shift()
  }
  // Unknown again once it is gone -> proves that one line is what did the work.
  assert.equal(classify(ctx({ typeLine: 'Sample Widget' })).kind, 'skip')
})

// --- mod texts for the variant match (valuator.mjs) -------------------------
test('itemModTexts collects every *Mods string array and strips markup', () => {
  const mods = itemModTexts({
    implicitMods: ['16% increased Stun and Block Recovery'],
    explicitMods: ['<<set:MS>>Gain 5% of Maximum Life as Extra Maximum Energy Shield', '+26 to Intelligence', 'Everlasting Sacrifice'],
    enchantMods: ['Allocates Whatever'],
    utilityMods: ['Grants Immunity to Freeze'],
    logbookMods: [{ name: 'Karui', mods: ['x'] }], // objects -> ignored, never throws
    craftedMods: [],
    name: 'not a mod array',
    properties: [{ name: 'Level' }]
  })
  assert.deepEqual(mods.sort(), [
    '+26 to Intelligence',
    '16% increased Stun and Block Recovery',
    'Allocates Whatever',
    'Everlasting Sacrifice',
    'Gain 5% of Maximum Life as Extra Maximum Energy Shield',
    'Grants Immunity to Freeze'
  ].sort())
})

test('itemModTexts survives missing / broken input', () => {
  assert.deepEqual(itemModTexts(null), [])
  assert.deepEqual(itemModTexts({}), [])
  assert.deepEqual(itemModTexts({ explicitMods: 'nope' }), [])
  assert.deepEqual(itemModTexts({ explicitMods: [null, 42, '  ', 'ok'] }), ['ok'])
})

test('classify: a unique hands its mod texts through to valuation', () => {
  const d = classify(ctx({
    frame: 3,
    name: 'Foulborn Soul Tether',
    typeLine: 'Cloth Belt',
    ggg: { implicitMods: ['16% increased Stun and Block Recovery'], explicitMods: ['Everlasting Sacrifice'] }
  }))
  assert.equal(d.kind, 'unique')
  assert.deepEqual(d.mods, ['16% increased Stun and Block Recovery', 'Everlasting Sacrifice'])
})

test('classify: a tier-decorated map base line falls back to the undecorated join', () => {
  // GGG hands the map stash a base line with the tier baked in ("Map (Tier 16)")
  // while the bridge data knows the base as plain "Map". Without the retry the
  // join misses, the category stays null and ninjaTypeFor never reaches
  // 'UniqueMap' — the whole tab lands in `unpriced`.
  const index = { categoryOfBase: b => (b === 'Map' ? 'Map' : null) }
  const d = classify(ctx({ frame: 3, name: 'Cortex', typeLine: 'Map (Tier 15)', index }))
  assert.equal(d.category, 'Map')
  assert.equal(d.baseType, 'Map (Tier 15)') // decoration kept: it is the tier key for poe.ninja

  // The DIRECT join still wins — an undecorated hit is never second-guessed.
  const direct = { categoryOfBase: b => (b === 'Map (Tier 15)' ? 'Jewel' : 'Map') }
  assert.equal(classify(ctx({ frame: 3, name: 'X', typeLine: 'Map (Tier 15)', index: direct })).category, 'Jewel')

  // A decoration whose stem is unknown resolves to nothing, never to a guess.
  const none = { categoryOfBase: () => null }
  assert.equal(classify(ctx({ frame: 3, name: 'X', typeLine: 'Nonexistent (Tier 3)', index: none })).category, null)
})
