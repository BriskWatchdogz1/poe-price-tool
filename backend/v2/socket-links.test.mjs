// maxLinkGroup(clipboardText): largest linked socket group taken from the raw
// Sockets: line ("W-W W-W-W R" -> 3). The function itself is pure and
// side-effect free, but it lives in server.mjs -> the import boots the REAL
// server (top-level await, pattern: server.test.mjs) -> set env BEFORE the
// import and close the server in after(), otherwise the process hangs (unbounded
// cluster harvester interval, see POE_HARVEST_DISABLED).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.PORT = '0'
process.env.POE_HARVEST_DISABLED = '1'

let mod
before(async () => { mod = await import('./server.mjs') })
after(async () => { await new Promise((resolve) => mod.server.close(resolve)) })

test('W-W W-W-W R -> largest group is 3', () => {
  assert.equal(mod.maxLinkGroup('Sockets: W-W W-W-W R'), 3)
})

test('6-Link (R-R-R-R-R-R) -> 6', () => {
  assert.equal(mod.maxLinkGroup('Sockets: R-R-R-R-R-R'), 6)
})

test('completely unlinked (R G B) -> 1', () => {
  assert.equal(mod.maxLinkGroup('Sockets: R G B'), 1)
})

test('B-B -> 2', () => {
  assert.equal(mod.maxLinkGroup('Sockets: B-B'), 2)
})

test('no Sockets line -> null', () => {
  assert.equal(mod.maxLinkGroup('Item Class: Belts\nRarity: Unique\nMageblood\n'), null)
})

test('Sockets line embedded in real item text -> still found', () => {
  const text = `Item Class: Body Armours
Rarity: Rare
Doom Mantle
Astral Plate
--------
Sockets: W-W W-W-W R
--------
Item Level: 86
--------
+50 to maximum Life
`
  assert.equal(mod.maxLinkGroup(text), 3)
})

test('modsOf: hidden weapon DPS pseudos (Elemental/Physical DPS) are surfaced', () => {
  // APT returns Ele/Phys DPS as HIDDEN even though they are the breakdown of
  // Total DPS (205 = 118 + 87). modsOf should show them anyway (unchecked), but
  // NO other hidden stats.
  const preset = { stats: [
    { text: 'Total DPS: #',        tag: 'property', hidden: false, disabled: false, roll: { value: 205 } },
    { text: 'Elemental DPS: #',    tag: 'property', hidden: true,  disabled: true,  roll: { value: 118 } },
    { text: 'Physical DPS: #',     tag: 'property', hidden: true,  disabled: true,  roll: { value: 87 } },
    { text: 'Attacks per Second: #', tag: 'property', hidden: false, disabled: true, roll: { value: 1.4 } },
    { text: 'Some internal stat', tag: 'explicit', hidden: true, disabled: true },
  ] }
  const texts = mod.modsOf(preset).map(m => m.text)
  assert.ok(texts.includes('Elemental DPS: #'), 'Elemental DPS surfaced')
  assert.ok(texts.includes('Physical DPS: #'), 'Physical DPS surfaced')
  assert.ok(texts.includes('Total DPS: #'), 'Total DPS stays visible')
  assert.ok(!texts.includes('Some internal stat'), 'every other hidden stat stays hidden')
  // Ele/Phys DPS arrive disabled -> unchecked
  const ele = mod.modsOf(preset).find(m => m.text === 'Elemental DPS: #')
  assert.equal(ele.selected, false, 'the DPS split is unchecked by default')
})

test('buildItemAdded: the links mod is capped to the actual link count (not a fixed 6)', () => {
  // A 1H mace can hold at most 3 sockets -> [1,3], not [1,6] (the reported bug).
  const card = mod.buildItemAdded('id1', { name: 'Gorebreaker', info: {}, maxLinks: 3 }, { stats: [] })
  const link = card.mods.find(m => m.text === mod.LINKS_MOD_TEXT)
  assert.ok(link, 'links mod present on a 3-link')
  assert.deepEqual(link.valueRange, [1, 3], 'range capped to the item max, not 6')
  assert.equal(link.value, 3)
})

test('buildItemAdded: no links mod on a completely unlinked item (max group 1)', () => {
  const card = mod.buildItemAdded('id2', { name: 'Ring', info: {}, maxLinks: 1 }, { stats: [] })
  assert.equal(card.mods.find(m => m.text === mod.LINKS_MOD_TEXT), undefined, 'unlinked -> no links mod')
})

test('buildItemAdded: active non-mod filters (quality/ilvl) come through as facts', () => {
  // White base: the engine has quality+itemLevel ACTIVE -> show both as facts so
  // the price is readable (27% qual / ilvl 57 is a different product).
  const card = mod.buildItemAdded('q1', { name: 'Crypt Armour', info: {} },
    { stats: [], filters: { quality: { value: 27, disabled: false }, itemLevel: { value: 57, disabled: false } } })
  assert.deepEqual(card.facts, ['Quality: 27%', 'Item Level: 57'])
})

test('buildItemAdded: disabled/missing filters produce NO facts (no rare noise)', () => {
  // Rare: itemLevel comes back disabled, quality not at all -> show nothing.
  const card = mod.buildItemAdded('q2', { name: 'Helm', info: {} },
    { stats: [], filters: { itemLevel: { value: 54, disabled: true } } })
  assert.deepEqual(card.facts, [])
})

// Listings come in MIXED currencies. It used to be the CHEAPEST listing that
// decided the currency and all the others were dropped -> "1c, 1div, 1div,
// 2div" turned into the headline "1 c", pricing the item ~88x too low.
const listing = (amount, cur) => ({ priceAmount: amount, priceCurrency: cur, ign: 'x', relativeDate: '1 hour ago' })

test('price: mixed currencies are put on one scale (the cluster jewel case)', () => {
  const price = { total: 4, listings: [listing(1, 'chaos'), listing(1, 'divine'), listing(1, 'divine'), listing(2, 'divine')] }
  const r = mod.toPriceResult('id', price, 'search', 'L', 88)
  assert.equal(r.currency, 'divine', 'typical price is >= 1 divine -> display in divine')
  assert.equal(r.priceMedian, 1, 'median = 1 div (88c), not 1 c')
  assert.ok(r.priceHigh >= 2, `high must be 2 div, was ${r.priceHigh}`)
  assert.ok(r.priceLow < 0.05, `1c must show up as a fraction of a divine, was ${r.priceLow}`)
})

test('price: pure chaos listings stay in chaos', () => {
  const price = { total: 3, listings: [listing(3, 'chaos'), listing(5, 'chaos'), listing(10, 'chaos')] }
  const r = mod.toPriceResult('id', price, 'search', 'L', 88)
  assert.equal(r.currency, 'chaos')
  assert.deepEqual([r.priceLow, r.priceMedian, r.priceHigh], [3, 5, 10])
})

test('price: exotic currency without a rate -> old behaviour (single currency)', () => {
  const price = { total: 2, listings: [listing(1, 'mirror'), listing(3, 'mirror')] }
  const r = mod.toPriceResult('id', price, 'search', 'L', 88)
  assert.equal(r.currency, 'mirror')
  assert.deepEqual([r.priceLow, r.priceHigh], [1, 3])
})

test('price: with no C:D rate it falls back cleanly to a single currency', () => {
  const price = { total: 2, listings: [listing(1, 'chaos'), listing(2, 'divine')] }
  const r = mod.toPriceResult('id', price, 'search', 'L', 0)
  assert.equal(r.currency, 'chaos', 'no rate, no conversion -> cheapest currency as before')
  assert.equal(r.priceLow, 1)
})

test('an aggregated price names its source (poe.ninja vs Currency Exchange)', () => {
  // Fungibles the trade site's bulk exchange does not answer come from the
  // Currency Exchange (Faustus) instead of from seller ask prices. Real case
  // Fracturing Orb: trade listings 130-435c (median 174c), in-game exchange
  // 70:1, Faustus 74c. The card has to name the source.
  const dflt = mod.toNinjaPriceResult('a', { chaos: 12, count: 5, url: 'u' }, 'L')
  assert.equal(dflt.priceSource, 'ninja')
  assert.equal(dflt.sourceLabel, 'poe.ninja')

  const exch = mod.toNinjaPriceResult('b', { chaos: 74, count: null, url: null }, 'L',
    { source: 'exchange', label: 'Currency Exchange', note: 'market rate' })
  assert.equal(exch.priceSource, 'exchange')
  assert.equal(exch.sourceLabel, 'Currency Exchange')
  assert.equal(exch.sourceNote, 'market rate')
  assert.equal(exch.priceLow, 74)
  assert.equal(exch.priceHigh, 74)
  assert.deepEqual(exch.listings, [], 'an aggregated source deliberately carries no listings')
})

test('buildItemAdded: gems show level/quality — and say so when they are not filtered', () => {
  // Leveling gem (level < maxLevel): APT deliberately leaves the level filter
  // OFF, so the 1c price is correct — but the card has to disclose that.
  const lowGem = mod.buildItemAdded('g1', { name: 'Herald of Purity', info: {}, category: 'Gem', gemLevel: 17 },
    { stats: [], filters: { gemLevel: { value: 17, disabled: true } } })
  assert.deepEqual(lowGem.facts, ['Level: 17 (any priced)'])

  // Max level gem: filter active -> no annotation.
  const maxGem = mod.buildItemAdded('g2', { name: 'Herald of Purity', info: {}, category: 'Gem', gemLevel: 20, quality: 20 },
    { stats: [], filters: { gemLevel: { value: 20, disabled: false }, quality: { value: 20, disabled: false } } })
  assert.deepEqual(maxGem.facts, ['Level: 20', 'Quality: 20%'])

  // Quality 0 is not shown (no noise).
  const noQual = mod.buildItemAdded('g3', { name: 'X', info: {}, category: 'Gem', gemLevel: 1, quality: 0 },
    { stats: [], filters: { gemLevel: { value: 1, disabled: true } } })
  assert.deepEqual(noQual.facts, ['Level: 1 (any priced)'])
})

test('buildItemAdded: unknownModifiers show up as read-only "not searchable" mods', () => {
  // Stats that APT does not resolve to a trade id (e.g. the +Level of Socketed
  // Physical Gems corruption) must not vanish silently -> show them read-only.
  const card = mod.buildItemAdded('id3',
    { name: 'X', info: {}, unknownModifiers: [{ text: '+2 to Level of Socketed Physical Gems', type: 'implicit' }] },
    { stats: [] })
  const um = card.mods.find(m => m.text === '+2 to Level of Socketed Physical Gems')
  assert.ok(um, 'the unknown mod is surfaced')
  assert.equal(um.kind, 'unknown')
  assert.equal(um.searchable, false, 'flagged as not searchable')
  assert.equal(um.selected, false)
})

// --- gem level just below max ----------------------------------------------
// APT always leaves the level filter off below max level. Real case Flicker
// Strike 19/18%: the tool showed 4-5c (any level), the same search with
// level>=19 in game showed 15-20c. A gem with an active quality filter is not
// level fodder — then the level belongs in the search.
const gem = (gemLevel, quality, { maxLevel = 20, qualityDisabled = false } = {}) => ({
  item: { category: 'Gem', gemLevel, quality, info: { gem: { maxLevel } } },
  preset: { filters: {
    gemLevel: { value: gemLevel, disabled: gemLevel < maxLevel },
    quality: { value: quality, disabled: qualityDisabled }
  } }
})

test('gem 19/18% (quality filter active) -> the level is filtered too', () => {
  const g = gem(19, 18)
  assert.equal(mod.pinNearMaxGemLevel(g.item, g.preset), true)
  assert.equal(g.preset.filters.gemLevel.disabled, false)
})

test('level fodder (level 12) is left alone — the floor price is right there', () => {
  const g = gem(12, 18)
  assert.equal(mod.pinNearMaxGemLevel(g.item, g.preset), false)
  assert.equal(g.preset.filters.gemLevel.disabled, true)
})

test('no active quality filter, no intervention (genuine level fodder)', () => {
  const g = gem(19, 8, { qualityDisabled: true })
  assert.equal(mod.pinNearMaxGemLevel(g.item, g.preset), false)
  assert.equal(g.preset.filters.gemLevel.disabled, true)
})

test('max level gem: the engine already has the filter on, nothing to do', () => {
  const g = gem(20, 20)
  assert.equal(g.preset.filters.gemLevel.disabled, false)
  assert.equal(mod.pinNearMaxGemLevel(g.item, g.preset), false)
})

test('small gems (Enlighten, maxLevel 3): level 2 with quality counts too', () => {
  const g = gem(2, 20, { maxLevel: 3 })
  assert.equal(mod.pinNearMaxGemLevel(g.item, g.preset), true)
})

test('non-gems and missing data change nothing', () => {
  assert.equal(mod.pinNearMaxGemLevel({ category: 'Bow' }, { filters: { gemLevel: { value: 19, disabled: true } } }), false)
  assert.equal(mod.pinNearMaxGemLevel({ category: 'Gem' }, { filters: {} }), false)
  assert.equal(mod.pinNearMaxGemLevel(null, null), false)
})

// --- tier evaluation for the T2+ button -------------------------------------
// The tier lives in sources[].modifier.info.tier and only exists when "Advanced
// Mod Descriptions" is enabled in game.
const src = tier => ({ modifier: { info: tier == null ? {} : { tier } } })

test('bestTier: best (lowest) tier across all sources', () => {
  assert.equal(mod.bestTier({ sources: [src(5), src(2), src(8)] }), 2)
  assert.equal(mod.bestTier({ sources: [src(1)] }), 1)
})

test('bestTier: null when no tier is given (no guessing, the button drops away)', () => {
  assert.equal(mod.bestTier({ sources: [src(null)] }), null)
  assert.equal(mod.bestTier({ sources: [] }), null)
  assert.equal(mod.bestTier({}), null)
  assert.equal(mod.bestTier(null), null)
})

test('bestTier: unusable values (0, negative, text) do not count', () => {
  assert.equal(mod.bestTier({ sources: [src(0), src(-1), src('2')] }), null)
  assert.equal(mod.bestTier({ sources: [src(0), src(3)] }), 3)
})

test('modsOf: the tier lands on the mod row, cleanly absent when unknown', () => {
  const preset = { stats: [
    { text: '#% increased Armour', tag: 'explicit', hidden: false, disabled: true, sources: [src(2)] },
    { text: '+# to Intelligence', tag: 'explicit', hidden: false, disabled: true, sources: [src(8)] },
    { text: '+#% to all Elemental Resistances', tag: 'implicit', hidden: false, disabled: false, sources: [src(null)] }
  ] }
  const rows = mod.modsOf(preset)
  assert.equal(rows[0].tier, 2)
  assert.equal(rows[1].tier, 8)
  assert.equal('tier' in rows[2], false, 'an implicit without a tier gets no field')
})
