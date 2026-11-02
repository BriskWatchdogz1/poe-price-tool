// Base Percentile: filter row in the mod list (addBasePercentileFilter) +
// fact fallback (activeFilterFacts via buildItemAdded).
// Pattern: server.test.mjs — env before the import, close the server afterwards.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { quietEnv } from './test-quiet-env.mjs'

// The full set that keeps a booted server off the network. One list, imported:
// every file that wrote it out by hand left something out, and what kept being
// left out was the switch a WebSocket needs (test-quiet-env.mjs, docs/bugs.md
// B25). Applied FIRST — anything this file sets below overrides it on purpose.
quietEnv()
process.env.PORT = '0'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_REFERENCE_DISABLED = '1'

let mod

before(async () => { mod = await import('./server.mjs') })
after(async () => { await new Promise(resolve => mod.server.close(resolve)) })

const preset = () => ({ filters: {}, stats: [] })
const BP = 'Base Percentile: #%'
const bpStat = p => p.stats.find(s => s.tradeId?.[0] === 'item.base_percentile')
const bpRow = msg => msg.mods.find(m => m.text === BP)

// ---- addBasePercentileFilter ------------------------------------------------

test('armour with a basePercentile gets the filter row', () => {
  const p = preset()
  assert.equal(mod.addBasePercentileFilter({ basePercentile: 63 }, p), true)
  const s = bpStat(p)
  assert.ok(s)
  assert.equal(s.text, BP)
  assert.deepEqual(s.tradeId, ['item.base_percentile'])
  assert.equal(s.tag, 'property')
  assert.equal(s.disabled, false) // CHECKED by default
  assert.equal(s.roll.min, 63) // lower bound of the auto search
  assert.equal(s.roll.max, undefined) // open-ended upwards
  assert.equal(s.roll.value, 63)
  assert.deepEqual(s.roll.default, { min: 0, max: 100 })
})

test('weapon/gem/undefined -> no filter row', () => {
  for (const item of [{}, { basePercentile: null }, { basePercentile: undefined }, { category: 'Gem' }]) {
    const p = preset()
    assert.equal(mod.addBasePercentileFilter(item, p), false)
    assert.equal(bpStat(p), undefined)
  }
})

test('basePercentile 0 is not swallowed as falsy', () => {
  const p = preset()
  assert.equal(mod.addBasePercentileFilter({ basePercentile: 0 }, p), true)
  assert.equal(bpStat(p).roll.value, 0)
})

test('calling twice does not add a second row', () => {
  const p = preset()
  mod.addBasePercentileFilter({ basePercentile: 63 }, p)
  assert.equal(mod.addBasePercentileFilter({ basePercentile: 63 }, p), false)
  assert.equal(p.stats.filter(s => s.tradeId?.[0] === 'item.base_percentile').length, 1)
})

// Normal/Magic go through createExactStatFilters, which calls
// filterBasePercentile itself — the row is already in the preset there and must
// not be created a second time (and the fact chip must certainly not come back).
test('engine already put the row there (Normal/Magic) -> exactly one row, no fact', () => {
  const p = preset()
  p.stats.push({ // shaped the way propToFilter/filterBasePercentile builds it
    text: BP, statRef: BP, tag: 'property', tradeId: ['item.base_percentile'],
    disabled: false, roll: { value: 100, min: 98, default: { min: 98, max: 100 }, dp: false }
  })
  assert.equal(mod.addBasePercentileFilter({ basePercentile: 100 }, p), false)
  const msg = mod.buildItemAdded('x0', { name: 'Destroyer Regalia', basePercentile: 100 }, p)
  assert.equal(msg.mods.filter(m => m.text === BP).length, 1)
  assert.ok(!msg.facts.some(f => f.startsWith('Base Percentile')), JSON.stringify(msg.facts))
})

// ---- card: row instead of fact ----------------------------------------------

test('the filter row shows up in mods, checked, with a 0..100 slider', () => {
  const p = preset()
  mod.addBasePercentileFilter({ basePercentile: 63 }, p)
  const row = bpRow(mod.buildItemAdded('x1', { name: 'Crypt Armour', basePercentile: 63 }, p))
  assert.ok(row)
  assert.equal(row.selected, true)
  assert.equal(row.value, 63)
  assert.deepEqual(row.valueRange, [0, 100])
})

test('with the filter row the duplicate fact chip disappears', () => {
  const p = preset()
  mod.addBasePercentileFilter({ basePercentile: 63 }, p)
  const msg = mod.buildItemAdded('x2', { name: 'Crypt Armour', basePercentile: 63 }, p)
  assert.ok(!msg.facts.some(f => f.startsWith('Base Percentile')), JSON.stringify(msg.facts))
})

test('without the filter row the fact chip stays (no information lost)', () => {
  const msg = mod.buildItemAdded('x3', { name: 'Crypt Armour', basePercentile: 63 }, preset())
  assert.ok(msg.facts.includes('Base Percentile: 63%'), JSON.stringify(msg.facts))
})

test('weapon: neither row nor fact', () => {
  const p = preset()
  mod.addBasePercentileFilter({ name: 'Siege Axe' }, p)
  const msg = mod.buildItemAdded('x4', { name: 'Siege Axe' }, p)
  assert.equal(bpRow(msg), undefined)
  assert.ok(!msg.facts.some(f => f.startsWith('Base Percentile')), JSON.stringify(msg.facts))
})

test('the gem branch stays untouched', () => {
  const p = preset()
  mod.addBasePercentileFilter({ category: 'Gem', basePercentile: 55 }, p)
  const msg = mod.buildItemAdded('x5', { name: 'Herald', category: 'Gem', gemLevel: 20 }, p)
  assert.ok(!msg.facts.some(f => f.startsWith('Base Percentile')), JSON.stringify(msg.facts))
})

// ---- end to end: checkbox -> trade query ------------------------------------

const ARMOUR_TXT = `Item Class: Body Armours
Rarity: Rare
Dread Cloak
Astral Plate
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

// Builds the real trade query (engine.searchPreset -> createTradeRequest) and
// catches it with a fetch stub instead of sending it off to GGG.
async function queryFor (preset, engine) {
  const realFetch = globalThis.fetch
  let body = null
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body)
    throw new Error('stop') // once the query is built we are done
  }
  try { await engine.searchPreset(preset, { league: 'Standard' }) } catch (e) { if (e.message !== 'stop') console.error('queryFor:', e.message) } finally { globalThis.fetch = realFetch }
  return body
}

// The engine's RateLimiter is module state and allows only ONE search per
// instance (the second one throws "Retry after 5 seconds"). Each case below
// therefore gets a fresh instance (query string = its own module cache entry).
async function freshEngine (tag) {
  const engine = await import(`./engine.bundle.mjs?bp=${tag}`)
  await engine.ready({ lang: 'en' })
  return engine
}

async function armourPreset (engine) {
  const { item, presets } = await engine.parseItem(ARMOUR_TXT, { league: 'Standard' })
  const p = engine.activePreset(presets)
  assert.equal(typeof item.basePercentile, 'number')
  assert.equal(mod.addBasePercentileFilter(item, p), true)
  return { p, item }
}

test('auto search (checked by default) -> base_defence_percentile.min in the query', async () => {
  const engine = await freshEngine('auto')
  const { p, item } = await armourPreset(engine)
  const q = await queryFor(p, engine)
  assert.ok(q, 'no query was built')
  assert.deepEqual(q.query.filters?.armour_filters?.filters?.base_defence_percentile, { min: item.basePercentile },
    JSON.stringify(q.query.filters))
})

test('unchecked -> no percentile filter left in the query', async () => {
  const engine = await freshEngine('off')
  const { p } = await armourPreset(engine)
  mod.applySelection(p, []) // nothing checked, the way the frontend sends it
  const q = await queryFor(p, engine)
  assert.ok(q, 'no query was built')
  assert.equal(q.query.filters?.armour_filters?.filters?.base_defence_percentile, undefined,
    JSON.stringify(q.query.filters?.armour_filters))
})

test('slider 40..100 -> exactly those bounds in the query', async () => {
  const engine = await freshEngine('range')
  const { p } = await armourPreset(engine)
  mod.applySelection(p, [{ text: BP, min: 40, max: 100 }])
  const q = await queryFor(p, engine)
  assert.ok(q, 'no query was built')
  assert.deepEqual(q.query.filters?.armour_filters?.filters?.base_defence_percentile, { min: 40, max: 100 },
    JSON.stringify(q.query.filters))
})
