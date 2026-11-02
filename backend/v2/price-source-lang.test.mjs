// The English price sources, asked with an English key — from a German parse.
//
// poe.ninja, the Currency Exchange digest (Faustus) and the corpse trade
// searches are all indexed by the ENGLISH item name. The server used to look
// items up by `item.name || item.info?.name`, which is the DISPLAY name and
// follows the client language. As long as everybody played English that was the
// same string; with a second, German parse instance it is not, and the German
// user would quietly get the worse price everywhere (no exchange headline, no
// poe.ninja bulk value, no unique reference) while nothing fails.
//
// Two things are proven here, and the second matters as much as the first:
//
//   1. a German parse hits the same rows as the same item parsed English,
//   2. English behaviour is bit-for-bit unchanged — asserted against the OLD
//      expression, spelled out once below as `displayKey`, not against a
//      remembered value.
//
// Plus the case the design does not mention: `info` is not always the entry for
// the item's OWN name (a Voidstone resolves to "Charged Compass", which has its
// own exchange rate), so a blind "refName first" would mis-price it.
//
// Fixture: the same synthetic locale bilingual-parse.test.mjs uses — the real
// English snapshot with an umlaut prefix on every `name`, `refName` untouched,
// indices regenerated. A real German data set is generated locally by another
// work package and does not exist in the repo. Everything is read out of the
// snapshot, nothing about the game is spelled out here.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildIndexBins } from './apt-index.mjs'
import { quietEnv } from './test-quiet-env.mjs'

const EN_DIR = new URL('../../renderer/public/data/en/', import.meta.url)
const DATA_DIR = new URL('../../renderer/public/data/', import.meta.url)

const LEAGUE = 'Standard'
const translate = name => `Ü${name}`

// The expression the four price paths used BEFORE this change. Every English
// assertion below compares against THIS, so "unchanged" is a computed fact and
// not a number someone typed in once.
const displayKey = item => item?.name || item?.info?.name || null

const root = await mkdtemp(path.join(tmpdir(), 'ppt-pricelang-'))

// --- fixture: one snapshot dir carrying data/en and data/de ------------------

const enItems = await readFile(new URL('items.ndjson', EN_DIR), 'utf8')
const enStats = await readFile(new URL('stats.ndjson', EN_DIR), 'utf8')
const enEntries = enItems.split('\n').filter(Boolean).map(l => JSON.parse(l))
const deItems = enEntries.map(e => JSON.stringify({ ...e, name: translate(e.name) })).join('\n') + '\n'

const VERSION = 'v-price-source-lang'
const refreshDir = path.join(root, 'data-refresh')
const snapshot = path.join(refreshDir, 'apt', VERSION)
await mkdir(path.join(snapshot, 'data/en'), { recursive: true })
await mkdir(path.join(snapshot, 'data/de'), { recursive: true })
for (const f of ['items.ndjson', 'stats.ndjson', 'client_strings.js', 'app_i18n.json']) {
  await copyFile(new URL(f, EN_DIR), path.join(snapshot, 'data/en', f))
}
for (const aux of ['item-drop.json', 'patrons.json']) {
  await copyFile(new URL(aux, DATA_DIR), path.join(snapshot, 'data', aux))
}
// data/de NEXT TO data/en: the localized load path still reads
// data/en/client_strings.js from the same root (CLIENT_STRINGS_REF).
await writeFile(path.join(snapshot, 'data/de/items.ndjson'), deItems)
await writeFile(path.join(snapshot, 'data/de/stats.ndjson'), enStats)
await copyFile(new URL('client_strings.js', EN_DIR), path.join(snapshot, 'data/de/client_strings.js'))
for (const [lang, items] of [['en', enItems], ['de', deItems]]) {
  const bins = buildIndexBins({ itemsNdjson: items, statsNdjson: enStats })
  for (const [name, arr] of Object.entries(bins)) {
    await writeFile(path.join(snapshot, 'data', lang, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
  }
}
// The refresher adopts a persisted snapshot on init() when the state names it
// AND the dir is complete; `langs` is what makes it demand data/de as well.
await writeFile(path.join(refreshDir, 'state.json'), JSON.stringify({
  since: Date.now(),
  apt: { version: VERSION, conditional: {}, updatedAt: Date.now(), langs: ['en', 'de'] }
}))

// --- items picked OUT OF the snapshot, never spelled out ---------------------

const byRef = new Map(enEntries.map(e => [e.refName, e]))
const first = pred => {
  const e = enEntries.find(pred)
  assert.ok(e, 'the snapshot must contain an item of this kind')
  return e
}
// A unique whose base exists too — ninjaRefFor's path (UniqueJewel etc).
const UNIQUE = first(e => e.namespace === 'UNIQUE' && e.unique?.base &&
  byRef.get(e.unique.base)?.craftable?.category === 'Jewel')
const DIVCARD = first(e => e.namespace === 'DIVINATION_CARD')
// Vial: Currency category without a tradeTag — the poe.ninja item/overview
// branch of NINJA_BULK_CLASSES (its `test` reads exactly these two fields).
const VIAL = first(e => e.namespace === 'ITEM' && e.tradeTag == null && /^Vial of /.test(e.refName))
// A real exchange currency for the Faustus digest.
const CURRENCY = first(e => e.namespace === 'ITEM' && e.tradeTag != null && /Orb$/.test(e.refName))
// A corpse: ITEM namespace, icon ending in "…Corpse.png" (kinds.mjs).
const CORPSE = first(e => e.namespace === 'ITEM' && /Corpse\.png$/.test(e.icon || ''))
// A craftable base to hang a rare item off — a rare is the always-available
// case where `info` describes the BASE and not the item's own name.
const RARE_BASE = first(e => e.namespace === 'ITEM' && e.craftable?.category === 'Body Armour')

// A unique that carries ONE name on SEVERAL bases — the case ninjaRefFor's
// baseType tiebreak exists for. poe.ninja keeps one line per base under that
// single name, so without a working tiebreak whichever line comes first is the
// price shown, whatever the item in hand actually is. Read out of the snapshot,
// never named here.
const VARIANTS = (() => {
  const byName = new Map()
  for (const e of enEntries) {
    if (e.namespace !== 'UNIQUE' || !e.unique?.base) continue
    if (byRef.get(e.unique.base)?.craftable?.category !== 'Jewel') continue
    if (!byName.has(e.refName)) byName.set(e.refName, [])
    byName.get(e.refName).push(e)
  }
  const group = [...byName.values()].find(g => g.length > 1)
  assert.ok(group, 'the snapshot must contain a unique that exists on several bases')
  return group
})()
// The item in hand is the LAST of them and poe.ninja is served in snapshot
// order, so the right line is never the first candidate: a tiebreak that does
// not fire shows up as a wrong price and not as a lucky coincidence.
const VARIANT = VARIANTS[VARIANTS.length - 1]

// --- poe.ninja, served from memory -------------------------------------------

const NINJA_UNIQUE_CHAOS = 137
const NINJA_DIV_CHAOS = 42
const NINJA_VIAL_CHAOS = 3.5
const FAUSTUS_CHAOS = 56
const FAUSTUS_RANGE = { min: 50, max: 61 }

// One price per variant base, all different, so the assertion names a base and
// not a number.
const NINJA_VARIANT_CHAOS = VARIANTS.map((_, i) => 11 + i * 7)

const ninjaItemOverview = type => {
  if (type === 'UniqueJewel') {
    return {
      lines: [
        { name: UNIQUE.refName, baseType: UNIQUE.unique.base, chaosValue: NINJA_UNIQUE_CHAOS, divineValue: 1.3, sparkLine: { data: [0, 1, 2] } },
        ...VARIANTS.map((v, i) => ({ name: v.refName, baseType: v.unique.base, chaosValue: NINJA_VARIANT_CHAOS[i], divineValue: 1, sparkLine: { data: [0, i] } }))
      ]
    }
  }
  if (type === 'Vial') {
    return { lines: [{ name: VIAL.refName, chaosValue: NINJA_VIAL_CHAOS, count: 12, sparkLine: { data: [1, 2] } }] }
  }
  return { lines: [] }
}
const ninjaExchangeOverview = type => {
  if (type !== 'DivinationCard') return { core: { primary: 'chaos' }, lines: [], items: [] }
  return {
    core: { primary: 'chaos' },
    items: [{ id: 'card-1', name: DIVCARD.refName }],
    lines: [{ id: 'card-1', primaryValue: NINJA_DIV_CHAOS, sparkline: { data: [0, 1] } }]
  }
}

const realFetch = globalThis.fetch
globalThis.fetch = async (input) => {
  const url = String(typeof input === 'string' ? input : (input?.url ?? input))
  if (!/^https?:/i.test(url)) return realFetch(input)
  const u = new URL(url)
  const type = u.searchParams.get('type')
  const json = u.pathname.includes('/item/overview')
    ? ninjaItemOverview(type)
    : u.pathname.includes('/exchange/current/overview')
      ? ninjaExchangeOverview(type)
      : { lines: [] }
  return { ok: true, status: 200, json: async () => json }
}

// --- boot the real server on that snapshot -----------------------------------

// The full set that keeps a booted server off the network. One list, imported:
// every file that wrote it out by hand left something out, and what kept being
// left out was the switch a WebSocket needs (test-quiet-env.mjs, docs/bugs.md
// B25). Applied FIRST — anything this file sets below overrides it on purpose.
quietEnv()
// PRICING IS ON HERE, DELIBERATELY, and it is the one switch of the quiet set
// this file turns back off: which language a price was sourced in is the subject. Nothing leaves
// the machine for it — `fetch` is stubbed in this file, and the runner's guard
// (test-net-guard.mjs) blocks anything that is not loopback anyway. Written out
// rather than left implicit, because "this file prices" used to be visible only
// as the ABSENCE of a line.
delete process.env.POE_PRICE_CHECK_DISABLED
// And this one, for the same reason and with the same protection: the Faustus store IS the price source under test here.
delete process.env.POE_FAUSTUS_DISABLED
process.env.PORT = '0'
process.env.POE_LEAGUE = LEAGUE
process.env.POE_USERS = 'enuser,deuser'
process.env.POE_USER_LANGS = 'deuser:de'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_DATA_REFRESH_DIR = refreshDir
process.env.POE_REFERENCE_DISABLED = '1'
// Faustus and the corpse store stay ON — both are under test. Their files go to
// tmp so nothing touches /config.
process.env.POE_FAUSTUS_STORE = path.join(root, 'faustus-store.json')
process.env.POE_CORPSE_STORE = path.join(root, 'corpse-store.json')
process.env.POE_NETWORTH_STORE = path.join(root, 'networth-store.json')

let mod
let en
let de

before(async () => {
  mod = await import('./server.mjs')
  en = mod.engines.parserFor('en')
  de = mod.engines.parserFor('de')
  assert.ok(de, 'the German instance must be live — the whole file rests on it')
  await mod.faustusStore.setPrices(LEAGUE, { [CURRENCY.refName]: FAUSTUS_CHAOS }, Date.now(),
    { [CURRENCY.refName]: FAUSTUS_RANGE })
})

after(async () => {
  globalThis.fetch = realFetch
  mod?.corpsePricer?.stop?.()
  mod?.faustusRefresher?.stop?.()
  await new Promise(r => mod.server.close(r))
  await rm(root, { recursive: true, force: true })
})

// --- clipboards, filled from the picked entries ------------------------------

const parsed = async (parser, clipboard) => {
  const res = await parser.parseItem(clipboard, { league: LEAGUE })
  assert.ok(res?.item, `clipboard did not parse:\n${clipboard}`)
  return res.item
}

const uniqueClip = t => `Item Class: Jewels
Rarity: Unique
${t(UNIQUE.name)}
${t(byRef.get(UNIQUE.unique.base).name)}
--------
Item Level: 84
--------
Place into an allocated Jewel Socket on the Passive Skill Tree.
`

// The same shape for the multi-base unique — only the base line differs between
// its variants, which is the whole point.
const variantClip = t => `Item Class: Jewels
Rarity: Unique
${t(VARIANT.name)}
${t(byRef.get(VARIANT.unique.base).name)}
--------
Item Level: 84
--------
Place into an allocated Jewel Socket on the Passive Skill Tree.
`

const divCardClip = t => `Item Class: Divination Cards
Rarity: Divination Card
${t(DIVCARD.name)}
--------
Stack Size: 1/8
--------
Something
`

const vialClip = t => `Item Class: Vials
Rarity: Currency
${t(VIAL.name)}
--------
Stack Size: 1/10
`

const currencyClip = t => `Item Class: Stackable Currency
Rarity: Currency
${t(CURRENCY.name)}
--------
Stack Size: 3/10
`

// --- 1. the ground the no-op claim stands on ---------------------------------

test('every entry of data/en/items.ndjson has name === refName', () => {
  // This is WHY swapping the display name for the reference name cannot change
  // anything for an English user: for English data the two strings are equal,
  // entry for entry. Asserted, not asserted-in-a-comment — if a future snapshot
  // ever breaks it, this file says so before the price paths quietly diverge.
  const differing = enEntries.filter(e => e.name !== e.refName)
  assert.deepEqual(differing, [], 'English display name and reference name must be the same string')
  assert.ok(enEntries.length > 1000, 'and the check has to have run over a real snapshot')
})

test('the German fixture is the opposite: name localized, refName English', () => {
  const deEntries = deItems.split('\n').filter(Boolean).map(l => JSON.parse(l))
  assert.equal(deEntries.length, enEntries.length)
  assert.deepEqual(deEntries.filter(e => e.name === e.refName), [], 'every name is localized here')
  assert.deepEqual(deEntries.map(e => e.refName), enEntries.map(e => e.refName), 'refName stays English')
})

// --- 2. the key itself --------------------------------------------------------

test('English: the lookup key is exactly what the display name used to give', async () => {
  for (const clip of [uniqueClip, divCardClip, vialClip, currencyClip]) {
    const item = await parsed(en, clip(s => s))
    assert.equal(mod.priceKeyOf(item), displayKey(item), clip.name)
  }
})

test('German: the lookup key is the English one, not the localized display name', async () => {
  for (const clip of [uniqueClip, divCardClip, vialClip, currencyClip]) {
    const deItem = await parsed(de, clip(translate))
    const enItem = await parsed(en, clip(s => s))
    assert.equal(mod.priceKeyOf(deItem), mod.priceKeyOf(enItem), clip.name)
    assert.notEqual(displayKey(deItem), displayKey(enItem), 'the display name really does differ')
  }
})

// --- 3. Faustus ---------------------------------------------------------------

test('Faustus: the German parse gets the same Exchange rate and range', async () => {
  const enItem = await parsed(en, currencyClip(s => s))
  const deItem = await parsed(de, currencyClip(translate))
  assert.equal(mod.faustusChaosFor(enItem, LEAGUE), FAUSTUS_CHAOS, 'English is unchanged')
  assert.equal(mod.faustusChaosFor(deItem, LEAGUE), FAUSTUS_CHAOS)
  assert.deepEqual(mod.faustusRangeFor(enItem, LEAGUE), FAUSTUS_RANGE)
  assert.deepEqual(mod.faustusRangeFor(deItem, LEAGUE), FAUSTUS_RANGE)
})

test('Faustus does not invent a rate for an item it has none for', async () => {
  const enItem = await parsed(en, uniqueClip(s => s))
  const deItem = await parsed(de, uniqueClip(translate))
  assert.equal(mod.faustusChaosFor(enItem, LEAGUE), null)
  assert.equal(mod.faustusChaosFor(deItem, LEAGUE), null)
})

// --- 4. poe.ninja bulk --------------------------------------------------------

test('poe.ninja bulk (exchange source): same value for both languages', async () => {
  const enItem = await parsed(en, divCardClip(s => s))
  const deItem = await parsed(de, divCardClip(translate))
  const enPrice = await mod.ninjaBulkPrice(enItem, LEAGUE)
  const dePrice = await mod.ninjaBulkPrice(deItem, LEAGUE)
  assert.equal(enPrice?.chaos, NINJA_DIV_CHAOS, 'English is unchanged')
  assert.deepEqual(dePrice, enPrice)
})

test('poe.ninja bulk (item source): same value for both languages', async () => {
  const enItem = await parsed(en, vialClip(s => s))
  const deItem = await parsed(de, vialClip(translate))
  const enPrice = await mod.ninjaBulkPrice(enItem, LEAGUE)
  const dePrice = await mod.ninjaBulkPrice(deItem, LEAGUE)
  assert.equal(enPrice?.chaos, NINJA_VIAL_CHAOS, 'English is unchanged')
  assert.deepEqual(dePrice, enPrice)
})

// --- 5. poe.ninja unique reference -------------------------------------------

test('poe.ninja reference price + sparkline: same for both languages', async () => {
  const enItem = await parsed(en, uniqueClip(s => s))
  const deItem = await parsed(de, uniqueClip(translate))
  const enRef = await mod.ninjaRefFor(enItem, LEAGUE)
  const deRef = await mod.ninjaRefFor(deItem, LEAGUE)
  assert.equal(enRef?.chaos, NINJA_UNIQUE_CHAOS, 'English is unchanged')
  assert.deepEqual(deRef, enRef)
})

// The variant tiebreak, which is not a language question at all — it was dead
// code for everybody: it held poe.ninja's `baseType` against `info.refName`,
// and for a Unique that field is the unique's OWN name, so the condition could
// never be true and the first line under that name always won. The same join
// done right sits in networth/valuator.mjs (fromItemOverview, on
// `info.unique.base`); this is the other half of the pair.
test('poe.ninja reference: the base in hand decides between a unique’s variant lines', async () => {
  const enItem = await parsed(en, variantClip(s => s))
  assert.equal(enItem.info?.refName, VARIANT.refName, 'one name…')
  assert.equal(enItem.info?.unique?.base, VARIANT.unique.base, '…and the base that tells the variants apart')
  assert.ok(VARIANTS.length > 1 && VARIANT.unique.base !== VARIANTS[0].unique.base,
    'the item in hand must NOT be the first line, or the tiebreak proves nothing')

  const enRef = await mod.ninjaRefFor(enItem, LEAGUE)
  assert.equal(enRef?.chaos, NINJA_VARIANT_CHAOS[VARIANTS.length - 1], 'the line for THIS base, not the first one')
  assert.notEqual(enRef?.chaos, NINJA_VARIANT_CHAOS[0])

  const deRef = await mod.ninjaRefFor(await parsed(de, variantClip(translate)), LEAGUE)
  assert.deepEqual(deRef, enRef, 'and the German parse lands on the same line')
})

// --- 6. the case the design does not name -------------------------------------
//
// `info` is NOT always the entry for the item's own name. findInDatabase
// (engine.bundle.mjs) resolves a rare/normal item to its BASE, a captured beast
// to its base line when there is one, and every Voidstone to the single entry
// `ITEM_BY_REF("ITEM", "Charged Compass")` — a name that carries an exchange
// rate of its own (it is in base-names.json). A plain "refName first" would
// therefore price a Voidstone as a compass and a rare as its bare base.
//
// The Voidstone itself cannot be parsed against this snapshot: the vendored APT
// set is behind upstream and has neither "Charged Compass" nor any Voidstone
// base. The rare is the same defect in a shape the snapshot does have, and the
// second test pins the rule at the level the Voidstone would hit it on.

test('a rare item keeps its own name as the key — its info is only the base', async () => {
  const RARE_NAME = 'Doom Bane' // a rolled rare name; no data set knows it
  const clip = t => `Item Class: Body Armours
Rarity: Rare
${RARE_NAME}
${t(RARE_BASE.name)}
--------
Item Level: 84
--------
+55 to maximum Life
--------
`
  // The base gets a rate the rare must not inherit — that is the whole point.
  await mod.faustusStore.setPrices(LEAGUE, {
    [CURRENCY.refName]: FAUSTUS_CHAOS,
    [RARE_BASE.refName]: 999
  }, Date.now(), { [CURRENCY.refName]: FAUSTUS_RANGE })

  for (const [parser, t] of [[en, s => s], [de, translate]]) {
    const item = await parsed(parser, clip(t))
    assert.equal(item.info?.refName, RARE_BASE.refName, 'the engine really resolves it to the base')
    assert.notEqual(item.name, item.info.name, 'and the name plate says something else')
    assert.equal(mod.priceKeyOf(item), RARE_NAME, 'so the display name stays the key')
    assert.equal(mod.faustusChaosFor(item, LEAGUE), null, 'no base rate leaks onto the rare')
  }

  await mod.faustusStore.setPrices(LEAGUE, { [CURRENCY.refName]: FAUSTUS_CHAOS }, Date.now(),
    { [CURRENCY.refName]: FAUSTUS_RANGE })
})

test('the rule itself: a refName is only a key when info describes THIS name', () => {
  // Shaped exactly like the engine's output for a Voidstone — name plate says
  // one thing, `info` is the hardcoded other entry.
  const other = enEntries.find(e => e.namespace === 'ITEM' && e.refName !== CURRENCY.refName)
  assert.equal(mod.priceKeyOf({ name: CURRENCY.name, info: other }), CURRENCY.name)
  assert.equal(mod.priceKeyOf({ name: CURRENCY.name, info: byRef.get(CURRENCY.refName) }), CURRENCY.refName)
  // No info at all (a parse that never reached findInDatabase): display name.
  assert.equal(mod.priceKeyOf({ name: CURRENCY.name }), CURRENCY.name)
  assert.equal(mod.priceKeyOf({}), null)
})

// --- 7. the shared corpse store ----------------------------------------------

const corpseTab = (user, name) => mod.networthStore.setTab(user, 1, {
  index: 1, name: 'tab', syncedAt: Date.now(),
  items: [{ name, kind: 'corpse', qty: 1, chaosEach: null, chaosTotal: null }],
  unpriced: [],
  counts: { priced: 1, unpriced: 0, skipped: 0 }
})

test('a localized corpse name reaches the shared store as its English name', async () => {
  await corpseTab('enuser', CORPSE.refName)
  await corpseTab('deuser', translate(CORPSE.name))
  // ONE entry, in English: the German user contributed the same corpse, and the
  // store the English user's searches read must not grow a second, German row.
  assert.deepEqual(mod.collectCorpseNames(), [CORPSE.refName])
})

test('an unresolvable localized name is not stored — and never searched', async () => {
  await corpseTab('enuser', CORPSE.refName)
  await corpseTab('deuser', 'Ünbekannte Leiche')
  assert.deepEqual(mod.collectCorpseNames(), [CORPSE.refName])
})

test('a stash answer that is already English passes through untouched (G0-3 positive)', async () => {
  await corpseTab('enuser', CORPSE.refName)
  await corpseTab('deuser', CORPSE.refName)
  assert.deepEqual(mod.collectCorpseNames(), [CORPSE.refName])
})

test('for a user on the primary language nothing can ever be dropped', () => {
  // The identity branch, taken before any lookup exists — this is the no-op
  // guarantee for an installation without a German user. A name the data set
  // has never heard of still goes in, exactly as before.
  assert.equal(mod.englishCorpseName('Not In Any Data Set', 'en'), 'Not In Any Data Set')
  assert.equal(mod.englishCorpseName('Not In Any Data Set', 'de'), null)
})
