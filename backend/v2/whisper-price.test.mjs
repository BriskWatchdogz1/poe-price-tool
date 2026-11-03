// whisper-price.mjs: a buyer's whisper against the market, without the trade
// API, and the route's logic without HTTP. Everything is driven with stubs or
// with a real valuator on stubbed fetchers; no request leaves the machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VERDICTS, REASONS, resolveWhisperItem, verdictFor, withDeadline, priceSafely,
  createWhisperPricer, createRateGate, createWhisperBook, createWhisperHandler, loadUniqueIndex,
  createWhisperErrorLog, WHISPER_FAILURES
} from './whisper-price.mjs'
import { parseWhisper } from './whisper.mjs'
import { loadItemsIndex, normalizeItem, descriptorForName } from './networth/normalize.mjs'
import { createValuator } from './networth/valuator.mjs'

const LEAGUE = 'Mercenaries'
const index = await loadItemsIndex()

// The English context as server.mjs builds it, on the shipped item data.
function enContext (uniques = new Map([['Tabula Rasa', new Set(['Simple Robe'])], ['Maelström of Chaos', new Set(['Map'])]])) {
  return {
    byName: index.byName,
    uniques,
    localToRef: null,
    describe: ref => descriptorForName(ref, index),
    categoryOf: base => index.categoryOfBase(base)
  }
}

const single = (item, price = '12 chaos', league = LEAGUE) =>
  parseWhisper(`Hi, I would like to buy your ${item} listed for ${price} in ${league} (stash tab "Sale"; position: left 5, top 3)`)
const bulk = (qty, item, amount, cur, rest = LEAGUE) =>
  parseWhisper(`Hi, I'd like to buy your ${qty} ${item} for my ${amount} ${cur} in ${rest}`)

test('the item text is resolved by its real shapes', () => {
  const ctx = enContext()
  assert.deepEqual(resolveWhisperItem('Tabula Rasa, Simple Robe', ctx), { kind: 'unique', ref: 'Tabula Rasa', base: 'Simple Robe' })
  assert.equal(resolveWhisperItem('Doom Grip, Titan Gauntlets', ctx).kind, 'rare')
  assert.equal(resolveWhisperItem('Icy Territory, Dunes Map (T16)', ctx).kind, 'rare')
  assert.deepEqual(resolveWhisperItem('level 20 0% Summon Ice Golem', ctx), { kind: 'gem', ref: 'Summon Ice Golem', level: 20, quality: 0 })
  const alch = resolveWhisperItem('Orb of Alchemy', ctx)
  assert.equal(alch.kind, 'fungible')
  assert.equal(alch.ref, 'Orb of Alchemy')
  assert.equal(alch.desc.kind, 'stackable')
  assert.equal(resolveWhisperItem('Dunes Map (T16)', ctx).kind, 'magic-or-normal')
  assert.equal(resolveWhisperItem('Simple Robe', ctx).kind, 'magic-or-normal', 'a catalogue base without a price route')
  assert.equal(resolveWhisperItem('Sapphire Ring of the Whale', ctx).kind, 'magic-or-normal', 'a magic item names its base')
  assert.equal(resolveWhisperItem('Abc Xyz', ctx).kind, 'unknown-item')
  assert.equal(resolveWhisperItem('Summon Ice Golem', ctx).kind, 'gem', 'a gem without level is still a gem')
  // A catalogue name with ', ' is that name, not a rare cut in two.
  assert.equal(resolveWhisperItem('Brush, Paint and Palette', ctx).kind, 'fungible')
  assert.equal(resolveWhisperItem('Farrul, First of the Plains', ctx).kind, 'fungible')
  // A unique map names its own map base; the catalogue gives every unique map 'Map'.
  assert.deepEqual(resolveWhisperItem('Maelström of Chaos, Atoll Map (T5)', ctx), { kind: 'unique', ref: 'Maelström of Chaos', base: null, category: 'Map' })

  // German names through localToRef; the unique index of a German file holds
  // German names and bases.
  const de = {
    ...enContext(new Map([['Tabula Rasa', new Set(['Einfaches Gewand'])]])),
    localToRef: n => ({ 'Einfaches Gewand': 'Simple Robe', 'Tabula Rasa': 'Tabula Rasa', 'Alchemie-Sphäre': 'Orb of Alchemy' }[n] || null)
  }
  assert.deepEqual(resolveWhisperItem('Tabula Rasa, Einfaches Gewand', de), { kind: 'unique', ref: 'Tabula Rasa', base: 'Simple Robe' })
  assert.equal(resolveWhisperItem('Alchemie-Sphäre', de).ref, 'Orb of Alchemy')
  assert.equal(resolveWhisperItem('level 20 0% Summon Ice Golem', de).kind, 'gem')
  assert.equal(resolveWhisperItem('Stufe 20 0% Eisgolem beschwören', de).kind, 'unknown-item', 'a German gem wording is not known')
  for (const odd of ['', null, undefined, 'x'.repeat(5000)]) assert.doesNotThrow(() => resolveWhisperItem(odd, enContext()))
})

test('your listed price against the market, both ways and with the band', () => {
  const band = { lowRatio: 0.85, highRatio: 1.15 }
  assert.deepEqual(verdictFor(150, 162, band), { verdict: 'fair', ratio: 0.93, pct: 7 })
  assert.deepEqual(verdictFor(100, 162, band), { verdict: 'below', ratio: 0.62, pct: 38 })
  assert.deepEqual(verdictFor(200, 162, band), { verdict: 'above', ratio: 1.23, pct: 23 })
  assert.equal(verdictFor(82, 100, band).verdict, 'below')
  assert.equal(verdictFor(82, 100, { lowRatio: 0.8, highRatio: 1.25 }).verdict, 'fair')
  assert.equal(verdictFor(120, 100, { lowRatio: 0.8, highRatio: 1.25 }).verdict, 'fair')
  assert.equal(verdictFor(130, 100, { lowRatio: 0.8, highRatio: 1.25 }).verdict, 'above')
  assert.equal(verdictFor(1, 0, band).verdict, 'not-compared', 'no market value, no ratio')
  assert.equal(verdictFor(null, 10, band).verdict, 'not-compared')
})

// A pricer on stubs: valuator answers from a table, chaosPerTag from another.
// A value in the table is a number or { each, uncertain }.
function stubPricer ({ values = {}, uniques = {}, tags = { chaos: { chaos: 1, fallback: false }, divine: { chaos: 200, fallback: false } }, ctx = enContext(), contexts = null, fallbackLangs, pricingOff = false, calls = [], stackAt } = {}) {
  const valuator = {
    async valueEach (desc) {
      calls.push(['value', desc.name])
      const v = values[desc.name]
      if (v == null) return null
      return typeof v === 'number' ? { each: v, source: 'exchange', uncertain: null } : { source: 'exchange', uncertain: null, ...v }
    },
    async uniqueCandidates (q) { calls.push(['unique', q.name, q.baseType, q.category]); return uniques[q.name] || [] }
  }
  return createWhisperPricer({
    valuatorFor: league => { calls.push(['valuatorFor', league]); return valuator },
    resolveContext: lang => (contexts ? (contexts[lang] ?? null) : lang === 'en' ? ctx : null),
    fallbackLangs,
    chaosPerTag: async (tag) => { calls.push(['tag', tag]); return tags[tag] ?? (tag === 'Chaos Orb' ? tags.chaos : tag === 'Divine Orb' ? tags.divine : null) },
    lowRatio: 0.85,
    highRatio: 1.15,
    pricingOff,
    stackAt
  })
}

test('a bulk whisper compares your price per unit', async () => {
  const p = stubPricer({ values: { 'Titanic Scarab': 162 } })
  const r = await p.price(bulk(6, 'Titanic Scarab', 900, 'Chaos Orb'), { league: LEAGUE })
  assert.equal(r.kind, 'bulk')
  assert.equal(r.qty, 6)
  assert.deepEqual(r.asked, { amount: 900, unit: 'Chaos Orb', chaos: 900, chaosEach: 150 })
  assert.equal(r.market.chaosEach, 162)
  assert.equal(r.market.chaos, 972)
  assert.equal(r.ratio, 0.93)
  assert.equal(r.verdict, 'fair')
  assert.equal(r.league, LEAGUE)
  assert.equal(r.extraLen, 0)
  const low = await p.price(bulk(6, 'Titanic Scarab', 600, 'Chaos Orb'), { league: LEAGUE })
  assert.equal(low.verdict, 'below')
  assert.equal(low.pct, 38)
  const high = await p.price(bulk(6, 'Titanic Scarab', 6, 'Divine Orb'), { league: LEAGUE })
  assert.equal(high.asked.chaos, 1200)
  assert.equal(high.verdict, 'above')
})

test('a unique is compared only when exactly one line can be meant', async () => {
  const w = single('Tabula Rasa, Simple Robe', '100 chaos')
  const calls = []
  const one = await stubPricer({ uniques: { 'Tabula Rasa': [{ chaosValue: 150 }] }, calls }).price(w, { league: LEAGUE })
  assert.equal(one.market.chaosEach, 150)
  assert.equal(one.verdict, 'below')
  assert.equal(one.pct, 33)
  assert.deepEqual(calls.find(c => c[0] === 'unique'), ['unique', 'Tabula Rasa', 'Simple Robe', 'Body Armour'])
  const two = await stubPricer({ uniques: { 'Tabula Rasa': [{ chaosValue: 150 }, { chaosValue: 900, links: 6 }] } }).price(w, { league: LEAGUE })
  assert.equal(two.verdict, 'not-compared')
  assert.equal(two.reason, 'variants')
  assert.equal(two.market, null)
  const none = await stubPricer().price(w, { league: LEAGUE })
  assert.equal(none.verdict, 'not-compared')
  assert.equal(none.reason, 'no-market')
})

test('rares, gems, unknown currencies, other leagues and single fungibles say why there is no verdict', async () => {
  const calls = []
  const p = stubPricer({ values: { 'Orb of Alchemy': 0.4, 'Exalted Orb': 30 }, calls, tags: { chaos: { chaos: 1, fallback: false }, divine: { chaos: 200, fallback: false }, exalted: { chaos: 30, fallback: false }, alch: { chaos: 0.4, fallback: false } } })
  const at = { league: LEAGUE }
  assert.equal((await p.price(single('Doom Grip, Titan Gauntlets'), at)).reason, 'rare')
  assert.equal((await p.price(single('level 20 0% Summon Ice Golem'), at)).reason, 'gem')
  assert.equal((await p.price(single('Dunes Map (T16)'), at)).reason, 'magic-or-normal')
  assert.equal((await p.price(single('Abc Xyz'), at)).reason, 'unknown-item')
  const banana = await p.price(single('Tabula Rasa, Simple Robe', '3 banana'), at)
  assert.equal(banana.reason, 'unknown-currency')
  assert.equal(banana.verdict, 'not-compared')

  calls.length = 0
  const other = await p.price(single('Orb of Alchemy', '1 chaos', 'Standard'), at)
  assert.equal(other.verdict, 'not-compared')
  assert.equal(other.reason, 'other-league')
  assert.deepEqual(calls, [], 'nothing is looked up for another league')
  const otherBulk = await p.price(bulk(10, 'Orb of Alchemy', 1, 'Chaos Orb', 'Hardcore ' + LEAGUE + ' and a long tail of text after it'), at)
  assert.equal(otherBulk.reason, 'other-league')
  assert.equal(otherBulk.league.length, 40, 'the rest is cut to 40 characters')
  assert.deepEqual(calls, [])

  const alch = await p.price(single('Orb of Alchemy', '1 chaos'), at)
  assert.equal(alch.verdict, 'not-compared')
  assert.equal(alch.reason, 'stack-unknown')
  assert.equal(alch.market.chaosEach, 0.4)
  assert.equal(alch.asked.chaos, 1)

  const ex = await p.price(single('Tabula Rasa, Simple Robe', '50 exalted'), at)
  assert.equal(ex.asked.chaos, 1500)
  const al = await p.price(single('Tabula Rasa, Simple Robe', '10 alch'), at)
  assert.equal(al.asked.chaos, 4)

  const unpriced = await p.price(parseWhisper('Hi, I would like to buy your Orb of Alchemy in Mercenaries (stash tab "S"; position: left 1, top 2)'), at)
  assert.equal(unpriced.reason, 'unpriced-listing')
  assert.equal(unpriced.asked, null)
  assert.equal(unpriced.market.chaosEach, 0.4)
})

test('a Chaos:Divine rate from the fallback or past its age gives no verdict', async () => {
  for (const fallback of [true]) {
    const p = stubPricer({ uniques: { 'Tabula Rasa': [{ chaosValue: 1000 }] }, tags: { chaos: { chaos: 1, fallback: false }, divine: { chaos: 200, fallback } } })
    const r = await p.price(single('Tabula Rasa, Simple Robe', '1 divine'), { league: LEAGUE })
    assert.equal(r.verdict, 'not-compared')
    assert.equal(r.reason, 'rate-unknown')
    assert.equal(r.market.chaosEach, 1000, 'the market value stays as information')
    assert.equal(r.asked.chaos, 200)
  }
  const fresh = stubPricer({ uniques: { 'Tabula Rasa': [{ chaosValue: 1000 }] } })
  assert.equal((await fresh.price(single('Tabula Rasa, Simple Robe', '1 divine'), { league: LEAGUE })).verdict, 'below')
})

test('pricing off parses and never values', async () => {
  const calls = []
  const p = stubPricer({ pricingOff: true, calls })
  const r = await p.price(single('Tabula Rasa, Simple Robe'), { league: LEAGUE })
  assert.equal(r.verdict, 'not-compared')
  assert.equal(r.reason, 'pricing-off')
  assert.deepEqual(calls, [])
})

test('a language without data says so', async () => {
  const p = stubPricer()
  const de = parseWhisper("Hi, ich möchte 'Tabula Rasa, Einfaches Gewand' zum angebotenen Preis von 1 chaos in der Mercenaries-Liga kaufen (Truhenfach \"S\"; Position: 3 von links, 4 von oben)")
  const r = await p.price(de, { league: LEAGUE })
  assert.equal(r.reason, 'no-language-data')
})

// A German context on stubs: German names through localToRef.
const deContext = () => ({
  ...enContext(new Map([['Tabula Rasa', new Set(['Einfaches Gewand'])]])),
  localToRef: n => ({ 'Einfaches Gewand': 'Simple Robe', 'Tabula Rasa': 'Tabula Rasa', 'Alchemie-Sphäre': 'Orb of Alchemy', 'Chaos-Sphäre': 'Chaos Orb' }[n] || null)
})

test('a German bulk whisper compares its own closed league', async () => {
  const p = stubPricer({ values: { 'Orb of Alchemy': 0.4 }, contexts: { en: enContext(), de: deContext() } })
  const w = league => parseWhisper(`Hi, ich möchte '10 Alchemie-Sphäre' zum angebotenen Preis von '4 Chaos-Sphäre' in der '${league}'-Liga kaufen`)
  const r = await p.price(w(LEAGUE), { league: LEAGUE })
  assert.equal(r.kind, 'bulk')
  assert.equal(r.item.ref, 'Orb of Alchemy')
  assert.deepEqual(r.asked, { amount: 4, unit: 'Chaos-Sphäre', chaos: 4, chaosEach: 0.4 })
  assert.equal(r.verdict, 'fair')
  assert.equal(r.league, LEAGUE)
  assert.equal(r.extraLen, 0)
  const added = await p.price(parseWhisper(`Hi, ich möchte '10 Alchemie-Sphäre' zum angebotenen Preis von '4 Chaos-Sphäre' in der '${LEAGUE}'-Liga kaufen. danke`), { league: LEAGUE })
  assert.equal(added.extraLen, 5, "the length of the buyer's addition is passed on")
  assert.equal(added.verdict, 'fair')
  const other = await p.price(w('Hardcore Mercenaries'), { league: LEAGUE })
  assert.equal(other.reason, 'other-league')
  assert.equal(other.league, 'Hardcore Mercenaries')
})

// A whisper in a language the server has no item names for (French, Russian,
// Spanish, Portuguese today): the price is read, the item only when a loaded
// language knows the very name; else it is shown as text, without a verdict.
const fr = (item, price = '100 chaos') =>
  parseWhisper(`Bonjour, je souhaiterais t'acheter ${item} pour ${price} dans la ligue ${LEAGUE} (onglet de réserve "Vente" ; 5e en partant de la gauche, 3e en partant du haut)`)

test('a whisper in a language without data borrows only an exact name from a loaded language', async () => {
  const contexts = { en: enContext(), de: deContext() }
  const p = stubPricer({ uniques: { 'Tabula Rasa': [{ chaosValue: 150 }] }, values: { 'Orb of Alchemy': 0.4 }, contexts, fallbackLangs: () => ['en', 'de'] })

  const same = await p.price(fr('Tabula Rasa, Simple Robe'), { league: LEAGUE })
  assert.equal(same.item.ref, 'Tabula Rasa')
  assert.equal(same.verdict, 'below', 'a name English knows exactly is compared')

  const german = await p.price(fr('Alchemie-Sphäre'), { league: LEAGUE })
  assert.equal(german.item.ref, 'Orb of Alchemy', 'every loaded language is tried, not only English')
  assert.equal(german.reason, 'stack-unknown')

  // 'Robe simple' is no English base, so English would call it a rare; a
  // foreign name is never read as a rare, a magic item or an unknown item.
  const foreign = await p.price(fr('Tabula Rasa, Robe simple'), { league: LEAGUE })
  assert.equal(foreign.verdict, 'not-compared')
  assert.equal(foreign.reason, 'no-language-data')
  assert.equal(foreign.item.text, 'Tabula Rasa, Robe simple')
  assert.equal(foreign.item.ref, null)
  assert.equal(foreign.market, null)
  assert.deepEqual(foreign.asked, { amount: 100, unit: 'chaos', chaos: 100, chaosEach: 100 }, 'the listed price is still read')
  for (const text of ['Simple Robe de la Baleine', 'Orbe d\'alchimie', 'Dunes Map (T16)']) {
    const r = await p.price(fr(text), { league: LEAGUE })
    assert.equal(r.reason, 'no-language-data', text)
  }

  const ru = parseWhisper(`Здравствуйте, хочу купить у вас 10 Сфера алхимии за 1 Божественная сфера в лиге ${LEAGUE}`)
  const bulkRu = await p.price(ru, { league: LEAGUE })
  assert.equal(bulkRu.reason, 'no-language-data')
  assert.equal(bulkRu.league, LEAGUE)
  assert.equal(bulkRu.asked.chaos, null, 'a currency named in Russian is not known')
})

test('a German single whisper names its currency in several words', async () => {
  const p = stubPricer({ uniques: { 'Tabula Rasa': [{ chaosValue: 150 }] }, contexts: { en: enContext(), de: { ...deContext(), localToRef: n => (n === 'Chaos Sphäre' ? 'Chaos Orb' : deContext().localToRef(n)) } } })
  const r = await p.price(parseWhisper(`Hi, ich möchte 'Tabula Rasa, Einfaches Gewand' zum angebotenen Preis von 100 Chaos Sphäre in der '${LEAGUE}'-Liga kaufen (Truhenfach "S"; Position: 3 von links, 4 von oben)`), { league: LEAGUE })
  assert.equal(r.item.ref, 'Tabula Rasa')
  assert.deepEqual(r.asked, { amount: 100, unit: 'Chaos Sphäre', chaos: 100, chaosEach: 100 })
  assert.equal(r.verdict, 'below')
  const odd = await p.price(parseWhisper(`Hi, ich möchte 'Tabula Rasa, Einfaches Gewand' zum angebotenen Preis von 100 Seltsame Kugel in der '${LEAGUE}'-Liga kaufen (Truhenfach "S"; Position: 3 von links, 4 von oben)`), { league: LEAGUE })
  assert.equal(odd.reason, 'unknown-currency', 'a currency nobody knows keeps the item and the position')
  assert.equal(odd.item.ref, 'Tabula Rasa')
})

test('a gem wording borrowed from a loaded language counts only for a gem its catalogue knows', async () => {
  const p = stubPricer({ contexts: { en: enContext(), de: deContext() }, fallbackLangs: () => ['en', 'de'] })
  const known = await p.price(fr('level 20 0% Summon Ice Golem'), { league: LEAGUE })
  assert.equal(known.item.ref, 'Summon Ice Golem')
  assert.equal(known.reason, 'gem')
  const unknown = await p.price(fr('level 20 0% Invocation de golem de glace'), { league: LEAGUE })
  assert.equal(unknown.item.ref, null)
  assert.equal(unknown.reason, 'no-language-data', 'gem-shaped text with an unknown name is no known name')
})

test('a whisper in a language without data and no loaded language at all says so', async () => {
  const p = stubPricer({ contexts: {}, fallbackLangs: () => ['en'] })
  const r = await p.price(fr('Tabula Rasa, Simple Robe'), { league: LEAGUE })
  assert.equal(r.reason, 'no-language-data')
  assert.equal(r.asked.chaos, 100)
})

test('every verdict and reason the pricer gives is a documented one', async () => {
  assert.ok(VERDICTS.includes('pending') && VERDICTS.includes('unparsed'))
  const p = stubPricer({ values: { 'Orb of Alchemy': 0.4 } })
  for (const w of [single('Doom Grip, Titan Gauntlets'), single('Orb of Alchemy'), bulk(10, 'Orb of Alchemy', 1, 'Chaos Orb'), single('Abc Xyz', '1 banana')]) {
    const r = await p.price(w, { league: LEAGUE })
    assert.ok(VERDICTS.includes(r.verdict), r.verdict)
    if (r.reason) assert.ok(REASONS.includes(r.reason), r.reason)
  }
})

// A fake Faustus store and poe.ninja fetchers, the shapes valuator.test.mjs uses.
function realValuator () {
  return createValuator({
    league: LEAGUE,
    deps: {
      faustusStore: { getPrice: n => (n === 'Orb of Alchemy' ? 0.37 : null), league: () => LEAGUE, isFresh: () => true },
      fetchCurrencyOverview: async () => ({ byName: new Map() }),
      fetchExchangeOverview: async () => ({ nameToId: new Map(), lineById: new Map() }),
      fetchItemOverview: async () => []
    }
  })
}

test('a whisper and the net worth give the same price for the same fungible', async () => {
  const v = realValuator()
  const stash = normalizeItem({ frameType: 5, typeLine: 'Orb of Alchemy', name: '', stackSize: 1 }, index)
  const named = descriptorForName('Orb of Alchemy', index)
  assert.equal(named.kind, stash.kind)
  const a = await v.value(stash)
  const b = await v.value(named)
  assert.ok(a && a.chaosEach > 0)
  assert.equal(b.chaosEach, a.chaosEach)
  const p = createWhisperPricer({
    valuatorFor: () => v,
    resolveContext: () => enContext(),
    chaosPerTag: async t => (t === 'chaos' || t === 'Chaos Orb' ? { chaos: 1, fallback: false } : null),
    lowRatio: 0.85,
    highRatio: 1.15
  })
  const r = await p.price(single('Orb of Alchemy', '1 chaos'), { league: LEAGUE })
  // The same price underneath; the whisper shows more digits below 1 c
  // (0.37 where the Net Worth row says 0.4), the verdict uses none of them.
  assert.equal((await v.valueEach(named)).each, (await v.valueEach(stash)).each)
  assert.equal(r.market.chaosEach, (await v.valueEach(named)).each)
  assert.equal(Math.round(r.market.chaosEach * 10) / 10, a.chaosEach)
})

// Rounded unit prices judged cheap currency wrongly: 1000 Transmutations for
// a divine at 150 c is 0.15 c each against a market of 0.149 c, but rounded
// that was 0.2 against 0.1 ('above' by 100 %); 1000 Alterations for 240 c
// against 0.25 c was 0.2 against 0.3 ('below' by 33 %).
test('cheap bulk currency is judged on unrounded prices', async () => {
  const p = stubPricer({
    values: { 'Orb of Transmutation': 0.149, 'Orb of Alteration': 0.25, 'Orb of Alchemy': 0.37 },
    tags: { chaos: { chaos: 1, fallback: false }, divine: { chaos: 150, fallback: false }, 'Orb of Alchemy': { chaos: 0.37, fallback: false } }
  })
  const at = { league: LEAGUE }
  const tra = await p.price(bulk(1000, 'Orb of Transmutation', 1, 'Divine Orb'), at)
  assert.equal(tra.verdict, 'fair')
  assert.equal(tra.ratio, 1.01)
  assert.equal(tra.market.chaosEach, 0.149, 'three significant digits below 1 c')
  assert.equal(tra.market.chaos, 149)
  assert.equal(tra.asked.chaosEach, 0.15)
  const alt = await p.price(bulk(1000, 'Orb of Alteration', 240, 'Chaos Orb'), at)
  assert.equal(alt.verdict, 'fair')
  assert.equal(alt.ratio, 0.96)
  // A price in a cheap currency: 0.37 c, not 0.4 c, per Alchemy.
  const viaAlch = await p.price(bulk(100, 'Orb of Alteration', 68, 'Orb of Alchemy'), at)
  assert.equal(viaAlch.asked.chaos, 25.2)
  assert.equal(viaAlch.verdict, 'fair', '68 x 0.37 = 25.16 c against 25 c')
  const low = await p.price(bulk(1000, 'Orb of Transmutation', 100, 'Chaos Orb'), at)
  assert.equal(low.verdict, 'below')
  assert.equal(low.pct, 33)
})

test('a market price or a currency price on thin evidence gives no verdict', async () => {
  const at = { league: LEAGUE }
  const thin = stubPricer({ values: { 'Orb of Alchemy': { each: 40, uncertain: 'thin-market' } } })
  const r = await thin.price(bulk(10, 'Orb of Alchemy', 200, 'Chaos Orb'), at)
  assert.equal(r.verdict, 'not-compared')
  assert.equal(r.reason, 'uncertain-price')
  assert.equal(r.market.uncertain, 'thin-market', 'the marker stays on the market value shown')
  assert.equal(r.ratio, null)
  assert.equal(r.pct, null)
  const thinCurrency = stubPricer({
    values: { 'Orb of Alchemy': 0.37 },
    tags: { chaos: { chaos: 1, fallback: false }, ex: { chaos: 30, fallback: false, uncertain: 'thin-market' } }
  })
  const viaEx = await thinCurrency.price(bulk(100, 'Orb of Alchemy', 1, 'ex'), at)
  assert.equal(viaEx.reason, 'uncertain-price', 'the listed currency\'s own price is thin')
  const sure = stubPricer({ values: { 'Orb of Alchemy': { each: 40, uncertain: null } } })
  assert.equal((await sure.price(bulk(10, 'Orb of Alchemy', 200, 'Chaos Orb'), at)).verdict, 'below')
})

// A captured beast is one per slot (kinds.mjs pins its stack to 1): a single
// whisper names the whole quantity, so it compares like a unique.
test('a single whisper for a beast is compared, one for a stackable is not', async () => {
  const at = { league: LEAGUE }
  assert.equal(resolveWhisperItem('Farric Wolf Alpha', enContext()).desc.kind, 'beast')
  const p = stubPricer({ values: { 'Farric Wolf Alpha': 50, 'Orb of Alchemy': 0.4 } })
  const wolf = await p.price(single('Farric Wolf Alpha', '20 chaos'), at)
  assert.equal(wolf.reason, null)
  assert.equal(wolf.verdict, 'below')
  assert.equal(wolf.pct, 60)
  assert.equal(wolf.market.chaos, 50)
  const fair = await p.price(single('Farric Wolf Alpha', '50 chaos'), at)
  assert.equal(fair.verdict, 'fair')
  const alch = await p.price(single('Orb of Alchemy', '1 chaos'), at)
  assert.equal(alch.reason, 'stack-unknown')
})

// A single whisper for a stackable item gives no verdict, but both readings
// of 'listed for': per unit, and per stack of the size the whisper names in
// its item text or, failing that, the last sync saw at that tab and cell.
test('a single whisper for a stackable shows both readings and still no verdict', async () => {
  const at = { league: LEAGUE, user: 'p1' }
  const asks = []
  const none = stubPricer({ values: { 'Orb of Alchemy': 0.4 } })
  const plain = await none.price(single('Orb of Alchemy', '100 chaos'), at)
  assert.equal(plain.verdict, 'not-compared')
  assert.equal(plain.reason, 'stack-unknown')
  assert.equal(plain.stack, null, 'no size known: per unit only')
  assert.equal(plain.asked.chaos, 100)
  assert.equal(plain.market.chaosEach, 0.4)

  const synced = stubPricer({ values: { 'Orb of Alchemy': 0.4 }, stackAt: w => { asks.push(w); return 20 } })
  const s = await synced.price(single('Orb of Alchemy', '100 chaos'), at)
  assert.equal(s.verdict, 'not-compared')
  assert.equal(s.reason, 'stack-unknown')
  assert.equal(s.ratio, null)
  assert.equal(s.pct, null)
  assert.deepEqual(s.stack, { size: 20, from: 'sync', chaosEach: 5 })
  assert.deepEqual(asks, [{ user: 'p1', league: LEAGUE, tab: 'Sale', left: 5, top: 3, ref: 'Orb of Alchemy' }])

  // The size in the item text wins and the sync is not asked.
  asks.length = 0
  const named = await synced.price(single('20 Orb of Alchemy', '1 divine'), at)
  assert.equal(named.reason, 'stack-unknown')
  assert.equal(named.item.text, '20 Orb of Alchemy')
  assert.equal(named.item.ref, 'Orb of Alchemy')
  assert.equal(named.item.kind, 'fungible')
  assert.deepEqual(named.stack, { size: 20, from: 'whisper', chaosEach: 10 })
  assert.equal(named.asked.chaos, 200)
  assert.deepEqual(asks, [])

  // Cheap units keep three significant digits, like every chaos number here.
  const cheap = await synced.price(single('3 Orb of Alchemy', '1 chaos'), at)
  assert.equal(cheap.stack.chaosEach, 0.333)

  // A leading number before something that does not stack, or before no
  // known name, is not a stack size.
  assert.equal((await synced.price(single('20 Abc Xyz', '1 chaos'), at)).reason, 'unknown-item')
  const wolf = stubPricer({ values: { 'Farric Wolf Alpha': 50 } })
  assert.equal((await wolf.price(single('2 Farric Wolf Alpha', '1 chaos'), at)).reason, 'unknown-item')

  // A stack of one adds nothing to the per-unit reading; a failing or odd
  // lookup is no size.
  for (const answer of [1, 0, -3, 2.5, '20', null, undefined]) {
    const odd = stubPricer({ values: { 'Orb of Alchemy': 0.4 }, stackAt: () => answer })
    assert.equal((await odd.price(single('Orb of Alchemy', '100 chaos'), at)).stack, null, String(answer))
  }
  const boom = stubPricer({ values: { 'Orb of Alchemy': 0.4 }, stackAt: () => { throw new Error('store gone') } })
  const b = await boom.price(single('Orb of Alchemy', '100 chaos'), at)
  assert.equal(b.reason, 'stack-unknown')
  assert.equal(b.stack, null)
  const slow = stubPricer({ values: { 'Orb of Alchemy': 0.4 }, stackAt: async () => { throw new Error('async') } })
  assert.equal((await slow.price(single('Orb of Alchemy', '100 chaos'), at)).stack, null)

  // Bulk names its quantity in the template; nothing else carries `stack`.
  const bk = await synced.price(bulk(10, 'Orb of Alchemy', 4, 'Chaos Orb'), at)
  assert.equal('stack' in bk, false)
  assert.equal('stack' in (await synced.price(single('Doom Grip, Titan Gauntlets'), at)), false)
})

// The two readings are numbers the player compares without a verdict, so what would
// have stopped a verdict travels with them: a listing in divine at the
// fallback or a stale C:D rate, or a market price on thin evidence.
test('a stackable whisper says when its readings rest on a doubtful rate or price', async () => {
  const at = { league: LEAGUE, user: 'p1' }
  const sure = stubPricer({ values: { 'Orb of Alchemy': 0.4 }, stackAt: () => 20 })
  const ok = await sure.price(single('Orb of Alchemy', '1 divine'), at)
  assert.equal(ok.reason, 'stack-unknown')
  assert.equal(ok.caveat, null)

  const stale = stubPricer({
    values: { 'Orb of Alchemy': 0.4 },
    tags: { chaos: { chaos: 1, fallback: false }, divine: { chaos: 150, fallback: true } },
    stackAt: () => 20
  })
  const r = await stale.price(single('Orb of Alchemy', '1 divine'), at)
  assert.equal(r.verdict, 'not-compared')
  assert.equal(r.reason, 'stack-unknown')
  assert.equal(r.caveat, 'rate-unknown')
  assert.deepEqual(r.stack, { size: 20, from: 'sync', chaosEach: 7.5 })

  const thin = stubPricer({ values: { 'Orb of Alchemy': { each: 0.4, uncertain: 'thin-market' } }, stackAt: () => 20 })
  const u = await thin.price(single('Orb of Alchemy', '100 chaos'), at)
  assert.equal(u.reason, 'stack-unknown')
  assert.equal(u.caveat, 'uncertain-price')
  assert.equal(u.market.uncertain, 'thin-market')

  const thinRate = stubPricer({
    values: { 'Orb of Alchemy': 0.4 },
    tags: { chaos: { chaos: 1, fallback: false }, divine: { chaos: 150, fallback: false, uncertain: 'thin-market' } }
  })
  assert.equal((await thinRate.price(single('Orb of Alchemy', '1 divine'), at)).caveat, 'uncertain-price')

  // Both at once: the rate is named, it changes every number on the line.
  const both = stubPricer({
    values: { 'Orb of Alchemy': { each: 0.4, uncertain: 'thin-market' } },
    tags: { chaos: { chaos: 1, fallback: false }, divine: { chaos: 150, fallback: true } }
  })
  assert.equal((await both.price(single('Orb of Alchemy', '1 divine'), at)).caveat, 'rate-unknown')

  // Only a stackable single whisper carries it; elsewhere the reason says it.
  const bk = await stale.price(bulk(10, 'Orb of Alchemy', 1, 'Divine Orb'), at)
  assert.equal(bk.reason, 'rate-unknown')
  assert.equal('caveat' in bk, false)
})

test('a known currency without a price is not an unknown one', async () => {
  const at = { league: LEAGUE }
  const p = stubPricer({
    uniques: { 'Tabula Rasa': [{ chaosValue: 10 }] },
    tags: { chaos: { chaos: 1, fallback: false }, exalted: { chaos: null } }
  })
  const ex = await p.price(single('Tabula Rasa, Simple Robe', '1 exalted'), at)
  assert.equal(ex.reason, 'no-rate')
  assert.equal(ex.asked.chaos, null)
  assert.equal(ex.market.chaos, 10)
  assert.equal((await p.price(single('Tabula Rasa, Simple Robe', '1 banana'), at)).reason, 'unknown-currency')
})

test('pricing a whisper never touches the trade API', async () => {
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => { seen.push(String(url)); throw new Error('no network in this test') }
  const enqueued = []
  try {
    const v = realValuator()
    const p = createWhisperPricer({
      valuatorFor: () => v,
      resolveContext: () => enContext(),
      chaosPerTag: async t => (t === 'chaos' || t === 'Chaos Orb' ? { chaos: 1, fallback: false } : null),
      lowRatio: 0.85,
      highRatio: 1.15
    })
    const texts = [
      single('Tabula Rasa, Simple Robe'), single('Doom Grip, Titan Gauntlets'), single('level 20 0% Summon Ice Golem'),
      single('Orb of Alchemy'), single('Dunes Map (T16)'), single('Abc Xyz'), single('Orb of Alchemy', '1 chaos', 'Standard'),
      bulk(10, 'Orb of Alchemy', 1, 'Chaos Orb'), bulk(3, 'The Doctor', 9, 'Chaos Orb'), bulk(1, 'Divine Orb', 200, 'Chaos Orb')
    ]
    for (let i = 0; i < 20; i++) {
      const r = await p.price(texts[i % texts.length], { league: LEAGUE })
      assert.ok(VERDICTS.includes(r.verdict))
    }
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(seen, [], 'no fetch at all, so none to the trade API')
  assert.deepEqual(enqueued, [])
})

test('a slow valuation is answered as pending and finishes later', async () => {
  const timers = []
  const setTimer = (fn, ms) => { timers.push({ fn, ms }); return { unref () {} } }
  let resolveSlow
  const slow = new Promise(r => { resolveSlow = r })
  const raced = withDeadline(slow, 3000, { setTimer })
  assert.equal(timers[0].ms, 3000)
  timers[0].fn()
  assert.deepEqual(await raced, { pending: true })
  resolveSlow({ verdict: 'below' })
  assert.deepEqual(await slow, { verdict: 'below' }, 'the original promise still resolves')
  assert.deepEqual(await withDeadline(Promise.resolve({ verdict: 'fair' }), 3000), { verdict: 'fair' })
  assert.deepEqual(await withDeadline(Promise.resolve({ verdict: 'fair' }), 0), { pending: true }, 'a deadline of 0 is always pending')

  const errors = []
  const thrower = { price () { throw new Error('sync boom') } }
  const rejecter = { price: async () => { throw new Error('async boom') } }
  assert.deepEqual(await priceSafely(thrower, {}, {}, e => errors.push(e.message)), { verdict: 'not-compared', reason: 'error' })
  assert.deepEqual(await priceSafely(rejecter, {}, {}, e => errors.push(e.message)), { verdict: 'not-compared', reason: 'error' })
  assert.deepEqual(errors, ['sync boom', 'async boom'])
})

test('the rate gate admits perMin per user in any sliding minute', () => {
  let t = 0
  const gate = createRateGate({ perMin: 2, now: () => t })
  assert.equal(gate.admit('a'), true)
  assert.equal(gate.admit('a'), true)
  assert.equal(gate.admit('a'), false)
  assert.equal(gate.admit('b'), true, 'per user')
  t = 59_999
  assert.equal(gate.admit('a'), false)
  t = 60_001
  assert.equal(gate.admit('a'), true)
})

test('the book keeps the session per user, by instance and wid, and keep 0 keeps nothing', () => {
  const book = createWhisperBook({ users: ['p1', 'p2'], keep: 2 })
  book.add('p1', { key: 'a:w1', wid: 'w1', verdict: 'pending' })
  book.add('p1', { key: 'b:w1', wid: 'w1', verdict: 'fair' })
  assert.deepEqual(book.list('p1').map(e => e.key), ['b:w1', 'a:w1'], 'two daemons with the same wid are two entries, newest first')
  assert.equal(book.update('p1', 'a:w1', { verdict: 'below' }).verdict, 'below')
  assert.equal(book.list('p1').find(e => e.key === 'b:w1').verdict, 'fair', 'the other instance is untouched')
  book.add('p1', { key: 'a:w2', verdict: 'unparsed' })
  assert.equal(book.list('p1').length, 2, 'keep bounds the list')
  assert.equal(book.unparsed('p1'), 1)
  assert.deepEqual(book.list('p2'), [])
  assert.deepEqual(book.list('nobody'), [])
  assert.equal(book.update('p1', 'zz:w9', {}), null)

  const none = createWhisperBook({ users: ['p1'], keep: 0 })
  none.add('p1', { key: 'a:w1', verdict: 'pending' })
  none.add('p1', { key: 'a:w2', verdict: 'unparsed' })
  assert.deepEqual(none.list('p1'), [])
  assert.equal(none.update('p1', 'a:w1', { verdict: 'fair' }), null)
  assert.equal(none.unparsed('p1'), 1, 'counted even when nothing is kept')
})

// The route's logic with stubs.
function harness ({ pricer, keep = 50, deadlineMs = 3000, perMin = 60, quadOf } = {}) {
  const out = { broadcasts: [], pushes: [], errors: [], unparsed: [], logs: [] }
  const book = createWhisperBook({ users: ['p1'], keep })
  const handler = createWhisperHandler({
    pricer,
    book,
    rate: createRateGate({ perMin }),
    deadlineMs,
    broadcast: (u, m) => out.broadcasts.push([u, m]),
    pushWhisper: (u, e, o) => out.pushes.push([u, e, o]),
    onUnparsed: u => out.unparsed.push(u),
    onError: e => out.errors.push(String(e?.message || e)),
    log: line => out.logs.push(line),
    ...(quadOf ? { quadOf } : {})
  })
  return { handler, book, out }
}
const BODY = 'Hi, I would like to buy your Tabula Rasa, Simple Robe listed for 12 chaos in Mercenaries (stash tab "Secret Tab"; position: left 5, top 3)'
const at = { user: 'p1', instance: 'a', league: LEAGUE }
const nextTick = () => new Promise(r => setTimeout(r, 0))

test('the handler hands the pricer the user and league, for the stack size of the last sync', async () => {
  const seen = []
  const pricer = { price: async (p, opts) => { seen.push(opts); return { verdict: 'fair', reason: null } } }
  const { handler } = harness({ pricer })
  await handler.handle(at, { v: 1, wid: 'w1', body: BODY, label: 'buyer 1' })
  assert.deepEqual(seen, [{ league: LEAGUE, user: 'p1' }])
})

// The daemon's stash cell frame draws a 24x24 grid for a quad tab; the tab type
// comes from the last sync (listing-audit.mjs createQuadLookup), by tab name.
test('the entry says whether its tab is a quad tab, asked by user, league and tab name', async () => {
  const asked = []
  const quadOf = q => { asked.push(q); return q.tab === 'Secret Tab' }
  const pricer = { price: async () => ({ verdict: 'fair', reason: null }) }
  const { handler, out } = harness({ pricer, quadOf })
  const r = await handler.handle(at, { v: 1, wid: 'w1', body: BODY, label: 'buyer 1' })
  assert.equal(r.body.entry.quad, true)
  assert.equal(out.pushes[0][1].quad, true, 'the daemon feed carries it')
  assert.deepEqual(asked, [{ user: 'p1', league: LEAGUE, tab: 'Secret Tab' }])
  // A bulk whisper names no tab: nothing to ask.
  const bulk = await handler.handle(at, { v: 1, wid: 'w2', body: "Hi, I'd like to buy your 10 Orb of Alchemy for my 1 Divine Orb in Mercenaries", label: 'buyer 1' })
  assert.equal(bulk.body.entry.quad, null)
  assert.equal(asked.length, 1)
  // Without a lookup, or one that throws: null, and the whisper is still priced.
  const none = harness({ pricer })
  assert.equal((await none.handler.handle(at, { v: 1, wid: 'w1', body: BODY, label: 'buyer 1' })).body.entry.quad, null)
  const broken = harness({ pricer, quadOf: () => { throw new Error('x') } })
  const b = await broken.handler.handle(at, { v: 1, wid: 'w1', body: BODY, label: 'buyer 1' })
  assert.equal(b.status, 200)
  assert.equal(b.body.entry.quad, null)
  assert.equal(b.body.entry.verdict, 'fair')
  // Only true or false or null, whatever the lookup returns.
  const odd = harness({ pricer, quadOf: () => 'yes' })
  assert.equal((await odd.handler.handle(at, { v: 1, wid: 'w1', body: BODY, label: 'buyer 1' })).body.entry.quad, null)
})

test('the whisper handler never throws and never loses a late result', async () => {
  for (const pricer of [{ price () { throw new Error('sync') } }, { price: async () => { throw new Error('async') } }]) {
    const { handler, out } = harness({ pricer })
    const r = await handler.handle(at, { v: 1, wid: 'w1', body: BODY, label: 'buyer 1' })
    assert.equal(r.status, 200)
    assert.equal(r.body.entry.verdict, 'not-compared')
    assert.equal(r.body.entry.reason, 'error')
    assert.equal(out.errors.length, 1)
    assert.doesNotMatch(out.errors[0], /Tabula|Secret|buyer/)
  }

  // keep 0, deadline 0, a pricer that answers after 100 ms.
  const late = { price: () => new Promise(r => setTimeout(() => r({ verdict: 'below', reason: null, pct: 35, market: { chaosEach: 20, chaos: 20, source: 'x' } }), 100)) }
  const h = harness({ pricer: late, keep: 0, deadlineMs: 0 })
  const first = await h.handler.handle(at, { v: 1, wid: 'w7', body: BODY, label: 'buyer 2' })
  assert.equal(first.body.entry.verdict, 'pending')
  assert.equal(h.out.pushes.length, 1, 'the pending entry goes into the feed as well')
  await new Promise(r => setTimeout(r, 150))
  assert.equal(h.out.pushes.length, 2)
  const done = h.out.pushes[1][1]
  assert.equal(done.verdict, 'below')
  assert.equal(done.key, 'a:w7')
  assert.equal(done.wid, 'w7')
  assert.equal(done.tab, 'Secret Tab', 'built from the parsed fields and the result')
  assert.deepEqual(h.out.pushes[1][2], { by: 'a' })
  assert.equal(h.out.broadcasts.at(-1)[1].type, 'whisper')
  assert.equal(h.out.broadcasts.at(-1)[1].entry.verdict, 'below')
  assert.deepEqual(h.book.list('p1'), [])

  // A final answer within the deadline goes into the feed too.
  const fast = harness({ pricer: { price: async () => ({ verdict: 'fair', ratio: 1 }) } })
  const f = await fast.handler.handle(at, { v: 1, wid: 'w1', body: BODY, label: 'buyer 1' })
  assert.equal(f.body.entry.verdict, 'fair')
  assert.equal(fast.out.pushes.length, 1)
  assert.equal(fast.out.pushes[0][1].verdict, 'fair')
  await nextTick()
  assert.equal(fast.out.pushes.length, 1, 'and only once')

  // wid w1 from two instances: two keys; an update of one leaves the other.
  const two = harness({ pricer: { price: async () => ({ verdict: 'fair' }) } })
  await two.handler.handle({ ...at, instance: 'a' }, { v: 1, wid: 'w1', body: BODY, label: 'buyer 1' })
  await two.handler.handle({ ...at, instance: 'b' }, { v: 1, wid: 'w1', body: BODY, label: 'buyer 1' })
  assert.deepEqual(two.book.list('p1').map(e => e.key), ['b:w1', 'a:w1'])
  two.book.update('p1', 'a:w1', { verdict: 'below' })
  assert.equal(two.book.list('p1').find(e => e.key === 'b:w1').verdict, 'fair')
})

test('the handler refuses malformed bodies, counts unparsed ones and keeps no text of them', async () => {
  const { handler, book, out } = harness({ pricer: { price: async () => ({ verdict: 'fair' }) }, perMin: 3 })
  for (const bad of [
    {}, { wid: 'w1', body: BODY }, { wid: 'x1', body: BODY, label: 'buyer 1' }, { wid: 'w1', body: BODY, label: 'Zxqvname' },
    { wid: 'w1', body: 'x'.repeat(2001), label: 'buyer 1' }, { wid: 'w1', body: 5, label: 'buyer 1' }, { wid: 'w1234567890', body: BODY, label: 'buyer 1' }
  ]) {
    const r = await handler.handle(at, bad)
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60))
    assert.deepEqual(r.body, { error: 'bad whisper' })
  }
  const ok = await handler.handle(at, { wid: 'w1', body: BODY, label: 'buyer 123456789', name: 'Zxqvname' })
  assert.equal(ok.status, 200)
  assert.equal(JSON.stringify(ok.body).includes('Zxqvname'), false, 'a name field is never read')
  const un = await handler.handle(at, { wid: 'w2', body: 'hello there', label: 'buyer 1' })
  assert.equal(un.body.entry.verdict, 'unparsed')
  assert.equal(JSON.stringify(un.body).includes('hello'), false, 'the text of an unparsed whisper is not kept')
  assert.equal(book.unparsed('p1'), 1)
  assert.deepEqual(out.unparsed, ['p1'])
  const third = await handler.handle(at, { wid: 'w3', body: BODY, label: 'buyer 1' })
  assert.equal(third.status, 200)
  const fourth = await handler.handle(at, { wid: 'w4', body: BODY, label: 'buyer 1' })
  assert.equal(fourth.status, 429)
  assert.deepEqual(fourth.body, { error: 'too-many-whispers' })
  for (const line of out.logs) assert.doesNotMatch(line, /Tabula|Secret|hello|buyer|Zxqv/, line)
  assert.ok(out.logs.length >= 2, 'one line per whisper')
})

test('the handler survives a broadcast that throws', async () => {
  const errors = []
  const handler = createWhisperHandler({
    pricer: { price: async () => ({ verdict: 'fair' }) },
    book: createWhisperBook({ users: ['p1'], keep: 5 }),
    rate: createRateGate({ perMin: 60 }),
    deadlineMs: 3000,
    broadcast: () => { throw new Error('ws gone') },
    pushWhisper: () => { throw new Error('feed gone') },
    onUnparsed: () => { throw new Error('status gone') },
    onError: (e, what) => errors.push([what, e.message])
  })
  const r = await handler.handle(at, { wid: 'w1', body: BODY, label: 'buyer 1' })
  assert.equal(r.status, 200)
  const u = await handler.handle(at, { wid: 'w2', body: 'nope', label: 'buyer 1' })
  assert.equal(u.status, 200)
  // A failed delivery is no failed valuation: it is reported as what it is.
  assert.deepEqual(errors.filter(([, m]) => m === 'ws gone' || m === 'feed gone').map(([w]) => w), ['delivery', 'delivery', 'delivery', 'delivery'])
  assert.ok(errors.every(([w]) => WHISPER_FAILURES.includes(w)))
  assert.ok(!errors.some(([w]) => w === 'valuation'))
})

test('a valuation that fails is reported as one', async () => {
  const seen = []
  const handler = createWhisperHandler({
    pricer: { price: async () => { throw new Error('boom') } },
    book: createWhisperBook({ users: ['p1'], keep: 5 }),
    rate: createRateGate({ perMin: 60 }),
    deadlineMs: 3000,
    broadcast: () => {},
    pushWhisper: () => {},
    onError: (e, what) => seen.push([what, e.message])
  })
  await handler.handle(at, { wid: 'w1', body: BODY, label: 'buyer 1' })
  assert.deepEqual(seen, [['valuation', 'boom']])
})

// Before, the log kept one line for each of the first 20 different messages
// and then went quiet until a restart, while the page still said 'the check
// failed'; and a broadcast that threw was logged as a failed valuation.
test('the error log writes one line per kind a minute and counts the rest', () => {
  let t = 0
  const lines = []
  const log = createWhisperErrorLog({ everyMs: 60_000, now: () => t, warn: l => lines.push(l) })
  for (let i = 0; i < 25; i++) log(new Error(`distinct ${i}`), 'valuation')
  log(new Error('ws gone'), 'delivery')
  assert.deepEqual(lines, ['[whisper] valuation failed: distinct 0', '[whisper] delivery failed: ws gone'])
  t = 60_000
  log(new Error('distinct 25'), 'valuation')
  assert.equal(lines[2], '[whisper] valuation failed: distinct 25 (24 more valuation failures since the last line)')
  t = 10 * 60_000
  for (let i = 0; i < 30; i++) log(new Error('again'), 'valuation')
  assert.equal(lines.length, 4, 'never silent for good: a line again after the window')
  assert.equal(lines[3], '[whisper] valuation failed: again')
  log('plain text', 'something else')
  assert.equal(lines[4], '[whisper] handler failed: plain text')
  log(new Error('x'.repeat(500)), 'handler')
  assert.equal(lines.length, 5, 'inside the handler window')
})

test('the unique index maps names to bases, a localized file through its own item rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-uniq-'))
  try {
    const en = join(dir, 'en.ndjson')
    await writeFile(en, [
      { name: 'Tabula Rasa', refName: 'Tabula Rasa', namespace: 'UNIQUE', unique: { base: 'Simple Robe' } },
      { name: 'Simple Robe', refName: 'Simple Robe', namespace: 'ITEM', craftable: { category: 'Body Armour' } },
      'not json'
    ].map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n'))
    const u = await loadUniqueIndex(en)
    assert.deepEqual([...u.get('Tabula Rasa')], ['Simple Robe'])
    const de = join(dir, 'de.ndjson')
    await writeFile(de, [
      { name: 'Tabula Rasa', refName: 'Tabula Rasa', namespace: 'UNIQUE', unique: { base: 'Simple Robe' } },
      { name: 'Einfaches Gewand', refName: 'Simple Robe', namespace: 'ITEM' }
    ].map(e => JSON.stringify(e)).join('\n'))
    assert.deepEqual([...(await loadUniqueIndex(de)).get('Tabula Rasa')], ['Einfaches Gewand'])
    await assert.rejects(loadUniqueIndex(join(dir, 'missing.ndjson')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const shipped = await loadUniqueIndex(new URL('../../renderer/public/data/en/items.ndjson', import.meta.url))
  assert.ok(shipped.get('Tabula Rasa').has('Simple Robe'))
})
