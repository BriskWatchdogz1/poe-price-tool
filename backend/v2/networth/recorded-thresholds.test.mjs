// The volume and confidence thresholds of docs/pricing-logic.md, measured
// again against recorded market data instead of numbers made up for a test.
//
// The data is a cut of one recording (Allflame, 2026-11-03): eight Faustus
// hourly digests and poe.ninja overviews, cut by fixtures/cut.mjs to the
// entries read here; provenance and the reason for each pick are in
// fixtures/2026-11-03/README.md. Each threshold sits between a recorded market
// that clears it and one that does not; moving the threshold out of that
// bracket, or changing its rule, moves one of them across and turns a test red.
// The brackets are as narrow as this recording allows and are named in the
// README; a move inside a bracket stays green. Each test first states what the
// recording shows (units, turnover, ratios), then what the code makes of it.
//
// No network: the Faustus hours come from an injected fetchHour, the poe.ninja
// answers from an injected fetchImpl that reads the fixture files.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createFaustusPricer, volumeRateXperQuote, rateXperQuote, rawRateRange } from './faustus.mjs'
import { createValuator } from './valuator.mjs'
import {
  fetchExchangeOverview, fetchItemOverview, fetchCurrencyOverview,
  configureNinja, __clearNinjaCaches
} from '../ninja.mjs'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/2026-11-03')
const LEAGUE = 'Allflame'
const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare'
const DIVINE = 'Metadata/Items/Currency/CurrencyModValues'
const readJson = f => JSON.parse(readFileSync(path.join(DIR, f), 'utf8'))

// The metadata ids of the recorded markets, named here rather than through the
// checked-in base-names.json, so a regenerated name map cannot move a test.
const ID = {
  'Divine Orb': DIVINE,
  'Memory of Reverence': 'Metadata/Items/Currency/BenevolenceMemoryThread',
  'Deafening Essence of Torment': 'Metadata/Items/Currency/CurrencyEssenceTorment6',
  'Cosmic Fragment': 'Metadata/Items/MapFragments/CurrencyUberBossKeyShaper',
  'Memory of Loneliness': 'Metadata/Items/Currency/IgnoranceMemoryThread',
  'Shuddering Fossil': 'Metadata/Items/Currency/CurrencyDelveCraftingSpeed',
  Matryoshka: 'Metadata/Items/DivinationCards/DivinationCardMatryoshka',
  'Prime Chaotic Resonator': 'Metadata/Items/Delve/DelveStackableSocketableCurrencyReroll4',
  'Timeless Templar Emblem': 'Metadata/Items/MapFragments/CurrencyLegionFragmentTemplar',
  'Deafening Essence of Wrath': 'Metadata/Items/Currency/CurrencyEssenceWrath5',
  'Tattoo of the Ramako Fleetfoot': 'Metadata/Items/Currency/AncestralTattooRamako4',
  'Fragment of the Phoenix': 'Metadata/Items/MapFragments/CurrencyShaperFragment1',
  'Devouring Fragment': 'Metadata/Items/MapFragments/CurrencyUberBossKeyEater',
  'Fine Delirium Orb': 'Metadata/Items/Currency/CurrencyAfflictionOrbCurrency',
  'Exalted Orb': 'Metadata/Items/Currency/CurrencyAddModToRare',
  "Zorath's Eye of the Endless": 'Metadata/Items/MapFragments/AbyssPinnacleKeyGhastly'
}
const baseNames = { byId: new Map(Object.entries(ID).map(([n, id]) => [id, n])) }

// ---------------------------------------------------------------- Faustus

const HOURS = [1793671200, 1793674800, 1793678400, 1793682000, 1793685600, 1793689200, 1793692800, 1793696400]
const digests = new Map(HOURS.map(h => [h, readJson(`faustus-${h}.json`)]))
const NEWEST = HOURS.at(-1)

// The market of `name` against `quote` in one recorded hour.
function market (hour, name, quote) {
  const x = ID[name]
  const m = digests.get(hour).markets.find(m => m.league === LEAGUE && m.market_pair.includes(x) && m.market_pair.includes(quote))
  assert.ok(m, `recorded: ${name} against ${quote === CHAOS ? 'Chaos' : 'Divine'} in hour ${hour}`)
  return m
}
const vol = (m, name) => m.volume_traded[ID[name]]
const volQuote = (m, quote) => m.volume_traded[quote]

// The pricer over the recording. `hoursBack` 0 is the window the server would
// have walked one minute after the newest recorded hour closed (all eight
// hours); 1 drops the newest, the server's view an hour earlier.
async function faustusDetail (hoursBack = 0) {
  const p = createFaustusPricer({
    league: LEAGUE,
    deps: {
      fetchHour: async id => digests.get(id) ?? null,
      now: () => NEWEST + 3600 + 60 - hoursBack * 3600,
      baseNames
    }
  })
  return p.detailByName()
}
const close = (a, b, eps = 0.01) => Math.abs(a - b) <= eps

test('the recording is there: eight consecutive hours, one Allflame Divine<->Chaos market in each', () => {
  for (const f of ['exchange-DivinationCard.json', 'exchange-Essence.json', 'exchange-Currency.json', 'item-SkillGem.json', 'item-UniqueMap.json']) {
    assert.ok(existsSync(path.join(DIR, f)), f)
  }
  for (let i = 1; i < HOURS.length; i++) assert.equal(HOURS[i] - HOURS[i - 1], 3600)
  for (const h of HOURS) assert.ok(market(h, 'Divine Orb', CHAOS))
})

// docs/pricing-logic.md, Faustus, "Quote-side volume floor": 50 on the chaos
// side, 10 on the divine side.
test('Faustus quote floor, chaos side: 49 chaos in an hour are rejected, 50 are a price', () => {
  // Memory of Reverence: 11 units for 49 chaos, a sound market in every other
  // respect: spread 2.5 (under 4), the volume-weighted rate inside the band.
  const under = market(1793685600, 'Memory of Reverence', CHAOS)
  assert.equal(volQuote(under, CHAOS), 49)
  assert.equal(vol(under, 'Memory of Reverence'), 11)
  const band = rawRateRange(under, ID['Memory of Reverence'], CHAOS)
  assert.ok(band.max / band.min <= 4)
  const r = 49 / 11
  assert.ok(r >= band.min && r <= band.max)
  assert.equal(volumeRateXperQuote(under, ID['Memory of Reverence'], CHAOS), null)
  assert.equal(rateXperQuote(under, ID['Memory of Reverence'], CHAOS), null)

  // Deafening Essence of Torment: 10 units for exactly 50 chaos.
  const at = market(1793692800, 'Deafening Essence of Torment', CHAOS)
  assert.equal(volQuote(at, CHAOS), 50)
  assert.equal(volumeRateXperQuote(at, ID['Deafening Essence of Torment'], CHAOS), 5)
})

test('Faustus quote floor, divine side: the same fragment at 9 divine is rejected, at 10 divine priced', () => {
  // Cosmic Fragment, 18 units for 9 divine in the newest hour (09:00 UTC), 13
  // for 10 divine five hours earlier (04:00 UTC); both single-ratio hours
  // (spread 1).
  const under = market(1793696400, 'Cosmic Fragment', DIVINE)
  assert.equal(volQuote(under, DIVINE), 9)
  assert.equal(vol(under, 'Cosmic Fragment'), 18)
  assert.equal(volumeRateXperQuote(under, ID['Cosmic Fragment'], DIVINE), null)
  assert.equal(rateXperQuote(under, ID['Cosmic Fragment'], DIVINE), null)

  const at = market(1793678400, 'Cosmic Fragment', DIVINE)
  assert.equal(volQuote(at, DIVINE), 10)
  assert.ok(close(volumeRateXperQuote(at, ID['Cosmic Fragment'], DIVINE), 10 / 13, 1e-9))
})

test('Faustus quote floor in the union: a newest hour under 50 chaos is not replaced by an older one', async () => {
  // Fragment of the Phoenix: the newest hour traded 2 for 30 chaos. The hour
  // before (4 for 60 chaos, 15c) clears the floor, but the newest informative
  // hour is the one the union keeps, so the fragment is unpriced in the full
  // window and priced at 15c one hour earlier.
  const newest = market(1793696400, 'Fragment of the Phoenix', CHAOS)
  assert.equal(volQuote(newest, CHAOS), 30)
  assert.equal((await faustusDetail(0)).get('Fragment of the Phoenix'), undefined)
  assert.equal((await faustusDetail(1)).get('Fragment of the Phoenix').chaos, 15)
})

// docs/pricing-logic.md, Faustus, "Cross-hour sanity check on the direct chaos
// path": a winning hour under 10 units (THIN_X_UNITS) is discarded when another
// hour traded at least 3x as many (DEEP_HOUR_VOL_RATIO), itself at least 10,
// and the two rates are at least 2x apart (DEEP_HOUR_DISAGREE_RATIO).
test('cross-hour check fires: 9 units at 9.6c against 51 units at 2.7c, the thin price is discarded', async () => {
  const win = market(1793696400, 'Memory of Loneliness', CHAOS)
  const deep = market(1793689200, 'Memory of Loneliness', CHAOS)
  assert.equal(vol(win, 'Memory of Loneliness'), 9) // one under the 10-unit floor
  assert.equal(volQuote(win, CHAOS), 86)
  assert.equal(vol(deep, 'Memory of Loneliness'), 51)
  assert.equal(volQuote(deep, CHAOS), 137)
  assert.ok(close((86 / 9) / (137 / 51), 3.56)) // 3.56x apart
  assert.equal((await faustusDetail(0)).get('Memory of Loneliness'), undefined)
})

test('cross-hour check fires at 3.75x deeper: 4 units at 35.5c against 15 units at 10c', async () => {
  const win = market(1793689200, 'Shuddering Fossil', CHAOS)
  const deep = market(1793682000, 'Shuddering Fossil', CHAOS)
  assert.equal(vol(win, 'Shuddering Fossil'), 4)
  assert.equal(vol(deep, 'Shuddering Fossil'), 15) // 3.75x the thin hour
  assert.equal(volQuote(win, CHAOS) / 4, 35.5)
  assert.equal(volQuote(deep, CHAOS) / 15, 10)
  assert.equal((await faustusDetail(0)).get('Shuddering Fossil'), undefined)
})

test('cross-hour check fires at 2.02x apart: one resonator at 104c against 17 at 209.8c, the thin price is discarded', async () => {
  // The window one hour before the newest. Together with Matryoshka (1.98x,
  // kept) this brackets DEEP_HOUR_DISAGREE_RATIO between 1.98 and 2.02.
  const win = market(1793692800, 'Prime Chaotic Resonator', CHAOS)
  const deep = market(1793685600, 'Prime Chaotic Resonator', CHAOS)
  assert.equal(vol(win, 'Prime Chaotic Resonator'), 1)
  assert.equal(volQuote(win, CHAOS), 104)
  assert.equal(vol(deep, 'Prime Chaotic Resonator'), 17) // 17x the thin hour
  assert.equal(volQuote(deep, CHAOS), 3567)
  const apart = (3567 / 17) / 104
  assert.ok(apart > 2 && apart < 2.02, `${apart}`)
  assert.equal((await faustusDetail(1)).get('Prime Chaotic Resonator'), undefined)
})

test('cross-hour check holds back at 1.98x apart: Matryoshka keeps 60c beside a 129-unit hour at 118.6c', async () => {
  const win = market(1793696400, 'Matryoshka', CHAOS)
  const deep = market(1793692800, 'Matryoshka', CHAOS)
  assert.equal(vol(win, 'Matryoshka'), 5)
  assert.equal(vol(deep, 'Matryoshka'), 129)
  const apart = (volQuote(deep, CHAOS) / 129) / (volQuote(win, CHAOS) / 5)
  assert.ok(apart > 1.97 && apart < 2, `${apart}`)
  assert.equal((await faustusDetail(0)).get('Matryoshka').chaos, 60)
})

test('cross-hour check holds back at 2.75x deeper: Fragment of the Phoenix keeps 15c beside 11 units at 6.4c', async () => {
  // The window one hour before the newest: the winning hour 4 units at 15c,
  // the deepest hour 11 units (2.75x, not 3x) at 6.36c, 2.36x apart.
  const win = market(1793692800, 'Fragment of the Phoenix', CHAOS)
  const deep = market(1793682000, 'Fragment of the Phoenix', CHAOS)
  assert.equal(vol(win, 'Fragment of the Phoenix'), 4)
  assert.equal(vol(deep, 'Fragment of the Phoenix'), 11)
  assert.ok((volQuote(win, CHAOS) / 4) / (volQuote(deep, CHAOS) / 11) >= 2)
  assert.equal((await faustusDetail(1)).get('Fragment of the Phoenix').chaos, 15)
})

test('cross-hour check holds back when the winning hour has 16 units: 74c stands beside a 255-unit hour at 16.3c', async () => {
  // 16 units clear THIN_X_UNITS, so no other hour is consulted at all, however
  // much deeper and further apart it is.
  const win = market(1793696400, 'Timeless Templar Emblem', CHAOS)
  const deep = market(1793689200, 'Timeless Templar Emblem', CHAOS)
  assert.equal(vol(win, 'Timeless Templar Emblem'), 16)
  assert.equal(vol(deep, 'Timeless Templar Emblem'), 255)
  assert.ok((volQuote(win, CHAOS) / 16) / (volQuote(deep, CHAOS) / 255) > 4)
  assert.equal((await faustusDetail(0)).get('Timeless Templar Emblem').chaos, 74)
})

test('cross-hour check holds back when the winning hour has exactly 10 units: 5c stands beside 62 units at 2.24c', async () => {
  // The window one hour before the newest. The deep hour is 6.2x deeper and
  // 2.23x apart, so only the 10-unit floor keeps the price; with Memory of
  // Loneliness (9 units, discarded) this pins THIN_X_UNITS at exactly 10.
  const win = market(1793689200, 'Deafening Essence of Wrath', CHAOS)
  const deep = market(1793685600, 'Deafening Essence of Wrath', CHAOS)
  assert.equal(vol(win, 'Deafening Essence of Wrath'), 10)
  assert.equal(volQuote(win, CHAOS), 50)
  assert.equal(vol(deep, 'Deafening Essence of Wrath'), 62)
  assert.equal(volQuote(deep, CHAOS), 139)
  assert.ok((50 / 10) / (139 / 62) >= 2)
  assert.equal((await faustusDetail(1)).get('Deafening Essence of Wrath').chaos, 5)
})

test('cross-hour check holds back when the deepest hour has only 7 units: one tattoo at 62c stands', async () => {
  // The deepest hour is 7x the winning hour and 2.17x apart, but is itself
  // under 10 units; no blanket floor on the item side.
  const win = market(1793692800, 'Tattoo of the Ramako Fleetfoot', CHAOS)
  const deep = market(1793689200, 'Tattoo of the Ramako Fleetfoot', CHAOS)
  assert.equal(vol(win, 'Tattoo of the Ramako Fleetfoot'), 1)
  assert.equal(vol(deep, 'Tattoo of the Ramako Fleetfoot'), 7)
  assert.ok((volQuote(deep, CHAOS) / 7) / volQuote(win, CHAOS) >= 2)
  assert.equal((await faustusDetail(0)).get('Tattoo of the Ramako Fleetfoot').chaos, 62)
})

// docs/pricing-logic.md, Faustus, "A worse-evidenced chaos market does not
// outrank a better-evidenced divine one": divine units >= 3x chaos units
// (BRIDGE_UNIT_RATIO) and >= 5000 chaos of divine turnover (isTurnoverAttested).
test('Faustus bridge at exactly 3x the units and 5897c of turnover: the divine market sets the price', async () => {
  const d = await faustusDetail(0)
  const cpd = d.get('Divine Orb').chaos
  assert.ok(close(cpd, 393.12))
  const c = market(1793696400, 'Devouring Fragment', CHAOS)
  const v = market(1793696400, 'Devouring Fragment', DIVINE)
  assert.equal(vol(c, 'Devouring Fragment'), 6)
  assert.equal(vol(v, 'Devouring Fragment'), 18) // exactly 3x
  assert.ok(volQuote(v, DIVINE) * cpd >= 5000) // 15 divine, 5897c
  assert.equal(volQuote(c, CHAOS) / 6, 227) // the own chaos market's price
  assert.ok(close(d.get('Devouring Fragment').chaos, (15 / 18) * cpd))
})

test('Faustus bridge at 2.8x the units: Fine Delirium Orb keeps its own chaos market despite 43,636c of divine turnover', async () => {
  const d = await faustusDetail(0)
  const c = market(1793696400, 'Fine Delirium Orb', CHAOS)
  const v = market(1793692800, 'Fine Delirium Orb', DIVINE) // the newest hour's divine entry is an idle placeholder
  assert.equal(vol(c, 'Fine Delirium Orb'), 506)
  assert.equal(vol(v, 'Fine Delirium Orb'), 1417) // 2.8x
  assert.ok(volQuote(v, DIVINE) * d.get('Divine Orb').chaos > 40000)
  assert.ok(close(d.get('Fine Delirium Orb').chaos, volQuote(c, CHAOS) / 506))
})

test('Faustus bridge on turnover: 14 divine (5504c) bridge Exalted Orb, 10 divine (3931c) do not bridge a 4x deeper Zorath\'s Eye', async () => {
  const d = await faustusDetail(0)
  const cpd = d.get('Divine Orb').chaos

  const ec = market(1793696400, 'Exalted Orb', CHAOS)
  const ev = market(1793696400, 'Exalted Orb', DIVINE)
  assert.ok(vol(ev, 'Exalted Orb') >= 3 * vol(ec, 'Exalted Orb')) // 1841 against 478
  assert.equal(volQuote(ev, DIVINE), 14)
  assert.ok(close(volQuote(ev, DIVINE) * cpd, 5504, 1))
  assert.ok(close(d.get('Exalted Orb').chaos, (14 / 1841) * cpd))

  const zc = market(1793671200, "Zorath's Eye of the Endless", CHAOS)
  const zv = market(1793696400, "Zorath's Eye of the Endless", DIVINE)
  assert.equal(vol(zc, "Zorath's Eye of the Endless"), 1)
  assert.equal(vol(zv, "Zorath's Eye of the Endless"), 4) // 4x the chaos side
  assert.equal(volQuote(zv, DIVINE), 10)
  assert.ok(volQuote(zv, DIVINE) * cpd < 5000) // 3931c
  assert.equal(d.get("Zorath's Eye of the Endless").chaos, 611) // the one chaos sale
})

// ---------------------------------------------------------------- poe.ninja

// The real fetchers of ninja.mjs, answered from the fixture files. A type
// without a fixture answers 404, which ninja.mjs caches as an empty overview.
function fixtureFetch (url) {
  const u = new URL(url)
  assert.equal(u.searchParams.get('league'), LEAGUE)
  const type = u.searchParams.get('type')
  const kind = u.pathname.endsWith('/exchange/current/overview') ? 'exchange'
    : u.pathname.endsWith('/stash/current/item/overview') ? 'item'
      : u.pathname.endsWith('/stash/current/currency/overview') ? 'currency' : null
  const f = kind && path.join(DIR, `${kind}-${type}.json`)
  if (!f || !existsSync(f)) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
  const body = JSON.parse(readFileSync(f, 'utf8'))
  return Promise.resolve({ ok: true, status: 200, json: async () => body })
}

before(() => {
  __clearNinjaCaches()
  configureNinja({ log: { log () {}, warn () {}, error () {}, info () {} } })
})
after(() => __clearNinjaCaches())

function ninjaValuator (fetchImpl = fixtureFetch) {
  __clearNinjaCaches()
  configureNinja({ log: { log () {}, warn () {}, error () {}, info () {} } })
  return createValuator({
    league: LEAGUE,
    deps: {
      fetchExchangeOverview: (league, type) => fetchExchangeOverview(league, type, { fetchImpl }),
      fetchItemOverview: (league, type) => fetchItemOverview(league, type, { fetchImpl }),
      fetchCurrencyOverview: (league, type) => fetchCurrencyOverview(league, type, { fetchImpl })
    }
  })
}

// The recorded line of `name` in an item overview.
function itemLines (type, name) {
  return readJson(`item-${type}.json`).lines.filter(l => l.name === name)
}
// The recorded exchange line of `name`: { primaryValue, volumePrimaryValue, units }.
function exchangeLine (type, name) {
  const j = readJson(`exchange-${type}.json`)
  const id = j.items.find(it => it.name === name)?.id
  const l = j.lines.find(l => l.id === id)
  assert.ok(l, `recorded: ${name} in exchange ${type}`)
  return { ...l, units: l.volumePrimaryValue / l.primaryValue }
}

// docs/pricing-logic.md, "poe.ninja count confidence filter": count >= 5.
test('count filter on gems: Vaal Clarity\'s count-4 line at 238.6c is passed over, its count-5 line priced exactly', async () => {
  const lines = itemLines('SkillGem', 'Vaal Clarity')
  const l2020 = lines.find(l => l.gemLevel === 20 && l.gemQuality === 20 && l.corrupted === true)
  const l1 = lines.find(l => l.gemLevel === 1 && l.gemQuality == null && l.corrupted === true)
  assert.equal(l2020.count, 4)
  assert.equal(l2020.chaosValue, 238.6)
  assert.equal(l1.count, 5)
  assert.equal(l1.chaosValue, 4.6)

  const v = ninjaValuator()
  const exact = await v.value({ kind: 'gem', name: 'Vaal Clarity', level: 1, quality: 0, corrupted: true, stack: 1 })
  assert.equal(exact.chaosEach, 4.6)
  assert.equal(exact.uncertain, null)
  // The 20/20 gem has a recorded line of its own, but with count 4 it cannot
  // win; the only confident line stands in, marked as a guess.
  const guessed = await v.value({ kind: 'gem', name: 'Vaal Clarity', level: 20, quality: 20, corrupted: true, stack: 1 })
  assert.equal(guessed.chaosEach, 4.6)
  assert.equal(guessed.uncertain, 'gem-guessed')
})

test('count filter on gems: a 21/23 Heavy Strike at 64,016c off count 2 is a phantom, not a price', async () => {
  const phantom = itemLines('SkillGem', 'Heavy Strike').find(l => l.gemLevel === 21 && l.gemQuality === 23)
  assert.equal(phantom.count, 2)
  assert.equal(phantom.chaosValue, 64016)
  const r = await ninjaValuator().value({ kind: 'gem', name: 'Heavy Strike', level: 21, quality: 23, corrupted: true, stack: 1 })
  assert.ok(r.chaosEach < 1, `${r.chaosEach}`) // the one confident line, 0.07c
  assert.equal(r.uncertain, 'gem-guessed')
})

test('count filter on uniques: a unique map with count 4 is unpriced, one with count 5 priced', async () => {
  const [four] = itemLines('UniqueMap', 'Replica Pillars of Arun')
  const [five] = itemLines('UniqueMap', "Replica Poorjoy's Asylum")
  assert.equal(four.count, 4)
  assert.equal(five.count, 5)
  const v = ninjaValuator()
  const desc = name => ({ kind: 'unique', name, baseType: 'Map (Tier 16)', category: 'Map', links: 0, stack: 1 })
  assert.equal(await v.value(desc('Replica Pillars of Arun')), null)
  assert.equal((await v.value(desc("Replica Poorjoy's Asylum"))).chaosEach, 720)
})

// docs/pricing-logic.md, "poe.ninja exchange volume floor": 10 units
// (MIN_EXCHANGE_UNITS), or 2000 chaos of turnover (MIN_EXCHANGE_TURNOVER_C)
// behind at least one whole trade (MIN_EXCHANGE_TURNOVER_UNITS).
test('exchange floor, cards: 10.3 units are a price, 9.0 units with 1937c of turnover are not', async () => {
  const damnation = exchangeLine('DivinationCard', 'Damnation')
  const beauty = exchangeLine('DivinationCard', 'Divine Beauty')
  const lost = exchangeLine('DivinationCard', 'Lost Worlds')
  assert.ok(close(damnation.units, 10.33))
  assert.ok(close(beauty.units, 9.0))
  assert.equal(beauty.volumePrimaryValue, 1937)
  assert.ok(close(lost.units, 12)) // a cheap card clears on units alone

  const v = ninjaValuator()
  const card = name => v.value({ kind: 'divcard', name, stack: 1 })
  assert.equal((await card('Damnation')).chaosEach, 31244)
  assert.equal(await card('Divine Beauty'), null)
  assert.equal((await card('Lost Worlds')).chaosEach, 0.1)
})

test('exchange floor, cards: 2.83 units with 3201c of turnover are rescued, 0.83 units with 22,341c are not', async () => {
  const mawr = exchangeLine('DivinationCard', 'Mawr Blaidd')
  const beast = exchangeLine('DivinationCard', 'The Slumbering Beast')
  assert.ok(close(mawr.units, 2.83))
  assert.equal(mawr.volumePrimaryValue, 3201)
  assert.ok(close(beast.units, 0.83)) // under one whole trade
  assert.equal(beast.volumePrimaryValue, 22341)

  const v = ninjaValuator()
  assert.equal((await v.value({ kind: 'divcard', name: 'Mawr Blaidd', stack: 1 })).chaosEach, 1130)
  assert.equal(await v.value({ kind: 'divcard', name: 'The Slumbering Beast', stack: 1 }), null)
})

test('exchange floor, stackables: 9.50 units are not a price, 10.33 are; 9.17 units with 13,805c are rescued, 0.83 with 3601c are not', async () => {
  // The recording carries primaryValue and volumePrimaryValue with at most 2
  // decimals between 1 and 100, so a ratio of two such numbers is only good to
  // about 0.01 there: 9.50 stays under 10 within that error, 9.99 would not.
  const delirium = exchangeLine('Essence', 'Essence of Delirium')
  const hysteria = exchangeLine('Essence', 'Essence of Hysteria')
  const dominance = exchangeLine('Currency', 'Orb of Dominance')
  const veiled = exchangeLine('Currency', 'Veiled Exalted Orb')
  assert.ok(close(delirium.units, 9.5))
  assert.ok(delirium.volumePrimaryValue < 2000) // 600.2c: no turnover rescue
  assert.ok(close(hysteria.units, 10.33))
  assert.ok(close(dominance.units, 9.17))
  assert.equal(dominance.volumePrimaryValue, 13805)
  assert.ok(close(veiled.units, 0.83))
  assert.equal(veiled.volumePrimaryValue, 3601)

  // No Faustus store and no stash currency overview recorded for these, so
  // the merged exchange map is the only stage that can price them.
  const v = ninjaValuator()
  const stack = name => v.value({ kind: 'stackable', name, tradeTag: null, stack: 1 })
  assert.equal(await stack('Essence of Delirium'), null)
  assert.equal((await stack('Essence of Hysteria')).chaosEach, 35)
  assert.equal((await stack('Orb of Dominance')).chaosEach, 1506)
  assert.equal(await stack('Veiled Exalted Orb'), null)
})

// The two exchange lines of the recording within 0.1 of 10 units. The cut
// leaves both out (fixtures/2026-11-03/README.md names them), so they are
// copied here from the raw overviews of the same recording, every field but
// `image` and `sparkline`. Of its 641 exchange lines with both numbers, no
// other one lies between 9.9 and 10.1 units.
const NEAR_TEN = {
  Fossil: {
    item: { id: 'jagged-fossil', name: 'Jagged Fossil', category: 'Delve', detailsId: 'jagged-fossil' },
    line: { id: 'jagged-fossil', primaryValue: 20.01, volumePrimaryValue: 200.1, maxVolumeCurrency: 'divine', maxVolumeRate: 20 }
  },
  Essence: {
    item: { id: 'deafening-essence-of-torment', name: 'Deafening Essence of Torment', category: 'Essences', detailsId: 'deafening-essence-of-torment' },
    line: { id: 'deafening-essence-of-torment', primaryValue: 5.92, volumePrimaryValue: 59.17, maxVolumeCurrency: 'chaos', maxVolumeRate: 0.169 }
  }
}

// fixtureFetch with the NEAR_TEN lines added to their exchange overview. The
// Fossil overview has no file in the cut; its `core` is the core of the raw
// Fossil file, identical to the Essence file's, so it is taken from there.
function nearTenFetch (url) {
  const u = new URL(url)
  const add = u.pathname.endsWith('/exchange/current/overview') && NEAR_TEN[u.searchParams.get('type')]
  if (!add) return fixtureFetch(url)
  const f = `exchange-${u.searchParams.get('type')}.json`
  const body = existsSync(path.join(DIR, f)) ? readJson(f) : { core: readJson('exchange-Essence.json').core, items: [], lines: [] }
  body.items.push(add.item)
  body.lines.push(add.line)
  return Promise.resolve({ ok: true, status: 200, json: async () => body })
}

// B36 in docs/bugs.md: the recorded numbers of Jagged Fossil state exactly 10
// units, the division misses 10 by floating-point error and used to reject the
// line. Deafening Essence of Torment, 9.995 units by its rounded numbers, is
// under the floor as recorded and stays unpriced: the floor holds for the
// numbers poe.ninja states, with no allowance for their rounding.
test('exchange floor at 10 units: Jagged Fossil at exactly 10 units is a price, 9.995 units are not', async () => {
  const jagged = NEAR_TEN.Fossil.line
  const torment = NEAR_TEN.Essence.line
  assert.equal(jagged.volumePrimaryValue / jagged.primaryValue, 9.999999999999998) // 200.1 / 20.01
  assert.ok(close(torment.volumePrimaryValue / torment.primaryValue, 9.995, 0.001))
  assert.ok(jagged.volumePrimaryValue < 2000 && torment.volumePrimaryValue < 2000) // no turnover rescue

  // No Faustus store and no stash currency overview, as in the test above.
  const v = ninjaValuator(nearTenFetch)
  const stack = name => v.value({ kind: 'stackable', name, tradeTag: null, stack: 1 })
  assert.equal((await stack('Jagged Fossil'))?.each, 20.01) // chaosEach is rounded to 20
  assert.equal(await stack('Deafening Essence of Torment'), null)
  // The lines of the cut beside them are read as before.
  assert.equal((await stack('Essence of Hysteria')).chaosEach, 35)
})
