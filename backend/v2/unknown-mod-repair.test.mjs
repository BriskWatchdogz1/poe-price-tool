// Acceptance criterion 5 of the German rollout, end to end against the REAL
// server: a mod line the German data set does not know is resolved through the
// de->en pair table and GGG's stat catalogue — and when the table cannot answer
// either, the line is read-only on the card and stands in the gap view.
//
// Both stages are PROVOKED, not waited for, which is what makes them a test at
// all: a real gap needs a league patch that APT has not caught up with. Here the
// gap is made on purpose, in the snapshot the server boots from:
//
//   stage 1  one stat has its German matchers emptied. The engine can no longer
//            match that line, it lands in item.unknownModifiers, and the repair
//            path has to bring it back as a searchable stat with GGG's trade id.
//   stage 2  the pair table is emptied and the bridge reloaded — the same
//            reload() the refresher triggers on a new snapshot. The very same
//            item must now come back read-only AND appear under /admin/gaps.
//
// EMPTYING THE MATCHERS, NOT DELETING THE LINE. The engine validates a list of
// refs it has hardcoded and throws when one is missing (init(), engine.bundle),
// so deleting a stat could take the whole instance down for a reason that has
// nothing to do with this path. An empty matcher list is also the truer picture:
// it is exactly the coverage gap the generator's validation counts (lang-derive,
// "every English ref needs at least one matcher").
//
// NOTHING IS TYPED INTO THIS FILE. The victim stats, the base item, the German
// client strings and the trade ids all come out of the snapshot; the catalogue
// answer is built from the victims' own English refs. The two victims are
// picked for the two shapes the catalogue path has to cope with: one whose
// English ref reads exactly like its matcher, and one whose ref carries a
// literal sign the matcher form does not (see trade-stats.resolveMatcherForm).
//
// NO NETWORK. The catalogue is served from a frozen answer through a fetch spy
// installed BEFORE the server is imported, so it also sits underneath the
// engine's file:// adapter; every other http(s) call is refused and recorded.
//
// Skips without a generated data/de — that set is derived from GGG's game data
// and every installation makes its own (renderer/public/data/.gitignore).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, copyFile, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildIndexBins } from './apt-index.mjs'
import { modTextKey, parseTextPairs, TEXT_PAIRS_FILE } from './mod-text-pairs.mjs'
import { ADMIN_PASSWORD_HEADER } from './admin-auth.mjs'
import { quietEnv } from './test-quiet-env.mjs'

const VENDORED = fileURLToPath(new URL('../../renderer/public/', import.meta.url))
const dataPath = (...p) => path.join(VENDORED, 'data', ...p)
const HAVE_DE = ['items.ndjson', 'stats.ndjson', TEXT_PAIRS_FILE].every(f => existsSync(dataPath('de', f)))
const skip = HAVE_DE ? false : 'no generated data/de here — run lang-data-gen.mjs first'

const CATALOGUE_URL = 'https://www.pathofexile.com/api/trade/data/stats'
const SEPARATOR = '--------' // language neutral (design doc, G0-4)
const ITEM_LEVEL = 86

const configDir = await mkdtemp(path.join(tmpdir(), 'ppt-repair-'))
let fixture = null

// --- who gets the hole punched into them -------------------------------------

/**
 * Picks the stats this test can safely blind the German parser to.
 *
 * A candidate has to survive every step of the path on its own, so the
 * conditions are the path read backwards: one matcher on both sides (so
 * emptying the German one removes exactly one line from the parser's reach), a
 * single `#` (so a rolled value can be substituted), one explicit trade id (so
 * the catalogue answer is unambiguous), and a pair-table entry that maps the
 * German matcher back to precisely this English one. The German matcher must
 * also be unique in the whole set, otherwise another stat would still match the
 * line and there would be no gap to repair.
 */
function pickVictims ({ enStats, deLines, pairs }) {
  const enByRef = new Map()
  for (const line of enStats) for (const s of (line.stats ? line.stats : [line])) enByRef.set(s.ref, s)
  const matcherUses = new Map()
  for (const line of deLines) {
    if (!line) continue
    for (const s of (line.stats ? line.stats : [line])) {
      for (const m of s.matchers) matcherUses.set(m.string, (matcherUses.get(m.string) || 0) + 1)
    }
  }

  let plain = null // English ref reads exactly like the matcher
  let signed = null // English ref carries a literal sign the matcher form lost
  for (let i = 0; i < deLines.length; i++) {
    const de = deLines[i]
    if (!de || de.stats) continue // a group is one LINE with several stats — not removable on its own
    const en = enByRef.get(de.ref)
    if (!en || de.matchers.length !== 1 || en.matchers.length !== 1) continue
    const dm = de.matchers[0]
    const em = en.matchers[0]
    if (dm.advanced != null || em.advanced != null) continue
    if (/ $/.test(em.string)) continue // APT's own pseudo entries, not a game stat
    if (dm.negate || dm.value != null) continue
    if (dm.string.includes('\n') || (dm.string.match(/#/g) || []).length !== 1) continue
    if (!dm.string.startsWith('#')) continue // the value has to be substitutable at the front
    const ids = en.trade?.ids?.explicit
    if (!Array.isArray(ids) || ids.length !== 1) continue
    if (pairs.get(modTextKey(dm.string)) !== em.string) continue
    if (matcherUses.get(dm.string) !== 1) continue

    const victim = { index: i, ref: de.ref, de: dm.string, en: em.string, tradeId: ids[0] }
    if (de.ref === em.string && !plain) plain = { ...victim, sign: '' }
    else if (de.ref === '+' + em.string && !signed) signed = { ...victim, sign: '+' }
    if (plain && signed) break
  }
  return [plain, signed].filter(Boolean)
}

/** The base item the test item is built on: anything with a German name of its
 *  own and a craftable category, so the parse has a real base type to resolve. */
function pickBase (deItems) {
  return deItems.find(e => e.namespace === 'ITEM' && e.craftable?.category && e.armour && e.name !== e.refName)
}

// --- the snapshot the server boots from --------------------------------------

if (HAVE_DE) {
  const read = (...p) => readFile(dataPath(...p), 'utf8')
  const parse = text => text.split('\n').map(l => (l.trim() ? JSON.parse(l) : null))

  const enItemsText = await read('en', 'items.ndjson')
  const enStatsText = await read('en', 'stats.ndjson')
  const deItemsText = await read('de', 'items.ndjson')
  const deStatsText = await read('de', 'stats.ndjson')
  const pairsText = await read('de', TEXT_PAIRS_FILE)

  const deStatLines = deStatsText.split('\n')
  const deStats = parse(deStatsText)
  const victims = pickVictims({
    enStats: parse(enStatsText).filter(Boolean),
    deLines: deStats,
    pairs: parseTextPairs(pairsText)
  })
  const base = pickBase(parse(deItemsText).filter(Boolean))

  // Punch the holes: same lines, same order, only the victims lose their
  // matchers. Rewriting just those lines keeps the rest of the file byte-exact.
  const holed = deStatLines.slice()
  for (const v of victims) holed[v.index] = JSON.stringify({ ...deStats[v.index], matchers: [] })
  const deStatsHoled = holed.join('\n')

  // The SAME hole in the English set, so the English path can be shown to still
  // do what it always did — with the pair table out of the picture entirely.
  // The two sets are line-parallel by construction (the German one is derived
  // from the English one), so the victims sit at the same indices.
  const enStatLines = enStatsText.split('\n')
  const enHoled = enStatLines.slice()
  for (const v of victims) {
    const line = JSON.parse(enStatLines[v.index])
    assert.equal(line.ref, v.ref, 'the two sets are line-parallel')
    enHoled[v.index] = JSON.stringify({ ...line, matchers: [] })
  }
  const enStatsHoled = enHoled.join('\n')

  const version = '0-de-with-a-hole'
  const snapshot = path.join(configDir, 'apt', version)
  await mkdir(path.join(snapshot, 'data/en'), { recursive: true })
  await mkdir(path.join(snapshot, 'data/de'), { recursive: true })
  for (const f of ['items.ndjson', 'client_strings.js', 'app_i18n.json']) {
    await copyFile(dataPath('en', f), path.join(snapshot, 'data/en', f))
  }
  await writeFile(path.join(snapshot, 'data/en/stats.ndjson'), enStatsHoled)
  for (const f of ['item-drop.json', 'patrons.json']) {
    await copyFile(dataPath(f), path.join(snapshot, 'data', f))
  }
  await copyFile(dataPath('de', 'client_strings.js'), path.join(snapshot, 'data/de/client_strings.js'))
  await writeFile(path.join(snapshot, 'data/de/items.ndjson'), deItemsText)
  await writeFile(path.join(snapshot, 'data/de/stats.ndjson'), deStatsHoled)
  const pairsPath = path.join(snapshot, 'data/de', TEXT_PAIRS_FILE)
  await writeFile(pairsPath, pairsText)
  for (const [lang, items, stats] of [['en', enItemsText, enStatsHoled], ['de', deItemsText, deStatsHoled]]) {
    const bins = buildIndexBins({ itemsNdjson: items, statsNdjson: stats })
    for (const [name, buf] of Object.entries(bins)) {
      await writeFile(path.join(snapshot, 'data', lang, name), Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
    }
  }
  await writeFile(path.join(configDir, 'state.json'), JSON.stringify({
    since: Date.now(),
    apt: { version, langs: ['en', 'de'] }
  }))

  const DE = (await import(pathToFileURL(dataPath('de', 'client_strings.js')).href)).default
  const EN = (await import(pathToFileURL(dataPath('en', 'client_strings.js')).href)).default
  // The clipboard a German client would put out for this item, in the extended
  // form the tool requires (the parser only reads a modifier section that
  // carries a `{ ... }` info line — see parseModifiers in the bundle, and the
  // README's "Advanced Mod Descriptions" keybind). The item class VALUE is
  // never read by the parser, only its prefix is, so the base's own category
  // stands in for a name the data set does not carry.
  //
  // `rolled` is what goes into the placeholder, not necessarily a bare number:
  // Ctrl+Alt+C writes the roll together with the range it came out of
  // ("42(39-49)"), and that form is a case of its own for the repair path.
  const clipboard = rolled => [
    `${DE.ITEM_CLASS}${base.craftable.category}`,
    `${DE.RARITY}${DE.RARITY_RARE}`,
    `Test ${base.name}`,
    base.name,
    SEPARATOR,
    `${DE.ITEM_LEVEL}${ITEM_LEVEL}`,
    SEPARATOR,
    ...victims.flatMap(v => [`{ ${DE.PREFIX_MODIFIER} }`, v.de.replace('#', v.sign + rolled)]),
    SEPARATOR,
    ''
  ].join('\n')

  // The same item as the English client would put it out — the comparison case
  // for "English is untouched".
  const englishClipboard = rolled => [
    `${EN.ITEM_CLASS}${base.craftable.category}`,
    `${EN.RARITY}${EN.RARITY_RARE}`,
    `Test ${base.refName}`,
    base.refName,
    SEPARATOR,
    `${EN.ITEM_LEVEL}${ITEM_LEVEL}`,
    SEPARATOR,
    ...victims.flatMap(v => [`{ ${EN.PREFIX_MODIFIER} }`, v.en.replace('#', v.sign + rolled)]),
    SEPARATOR,
    ''
  ].join('\n')

  // What GGG's catalogue answers: the victims' own English refs, which is the
  // form the trade site really lists them in (APT's `ref` is that text).
  const catalogue = {
    result: [{
      label: 'Explicit',
      entries: victims.map(v => ({ id: v.tradeId, text: v.ref }))
    }]
  }

  fixture = { victims, base, clipboard, englishClipboard, catalogue, pairsPath, snapshot }
}

// --- the fetch spy, installed BEFORE the server is imported -------------------
//
// installFetchFs() binds `nativeFetch` to whatever globalThis.fetch is at its
// first call and then replaces the global. A spy set up afterwards would sit
// OUTSIDE the adapter and never see anything (see bilingual-parse.test.mjs).
const netCalls = []
const beforeAdapter = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input))
  // The test's own requests to the server under test go straight through; only
  // the outside world is intercepted.
  if (!/^https?:/i.test(url) || url.startsWith('http://127.0.0.1:')) return beforeAdapter(input, init)
  netCalls.push(url)
  if (url === CATALOGUE_URL) return { ok: true, json: async () => fixture.catalogue }
  // Everything else is refused the way a dead network refuses it. The price
  // check's own trade search is one of these — this test is about the card, not
  // about a price, and this project does not reach the trade API from a test.
  throw new Error(`no network in this test: ${url}`)
}

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
process.env.POE_DATA_REFRESH_DIR = configDir
process.env.POE_ADMIN_PASSWORD_FILE = path.join(configDir, 'admin-password')
process.env.POE_USERS = 'enuser,deuser'
process.env.POE_USER_LANGS = 'deuser:de'

let mod
let base
let adminPassword

before(async () => {
  if (!HAVE_DE) return
  mod = await import('./server.mjs')
  base = `127.0.0.1:${mod.server.address().port}`
  adminPassword = await mod.adminAuth.expected()
})

after(async () => {
  if (mod) await new Promise(resolve => mod.server.close(resolve))
  await rm(configDir, { recursive: true, force: true })
})

const post = (user, body) => fetch(`http://${base}/item`, {
  method: 'POST', headers: { 'X-User': user }, body
}).then(r => r.json())

const cardFor = (user, id) => mod.users.get(user).items.get(id)

/** The mod lines of the gap view, for one language. */
async function gapTexts (lang) {
  const r = await fetch(`http://${base}/admin/gaps`, { headers: { [ADMIN_PASSWORD_HEADER]: adminPassword } })
  assert.equal(r.status, 200)
  const j = await r.json()
  const group = j.gaps.kinds.unknownMod.languages.find(g => g.lang === lang)
  return (group?.entries || []).map(e => e.text)
}

// --- the fixture is what it claims to be -------------------------------------

test('the hole is real: two stats, both invisible to the German parser now', { skip }, () => {
  assert.equal(fixture.victims.length, 2, 'one stat per catalogue shape (plain ref, signed ref)')
  const [plain, signed] = fixture.victims
  assert.equal(plain.ref, plain.en, 'the plain one reads the same as its matcher')
  assert.equal(signed.ref, '+' + signed.en, 'the signed one differs from its matcher by exactly the sign')
  assert.deepEqual(mod.engines.liveLanguages(), ['en', 'de'], 'both parsers came up from the prepared snapshot')
})

// --- stage 1: the catalogue path resolves it ---------------------------------

test('stage 1: a mod the German set no longer knows comes back as a searchable stat', { skip }, async () => {
  const { id } = await post('deuser', fixture.clipboard(7))
  const card = cardFor('deuser', id)
  assert.ok(card, 'the item parsed and got a card')

  assert.deepEqual(card.item.unknownModifiers, [], 'nothing was left unresolved')
  for (const v of fixture.victims) {
    const stat = card.preset.stats.find(s => s.tradeId?.[0] === v.tradeId)
    assert.ok(stat, `${v.ref} was spliced back in with GGG's trade id`)
    assert.equal(stat.resolvedFromCatalogue, true)
    assert.equal(stat.disabled, false, 'and it is part of the search, not a footnote')
    assert.equal(stat.roll.value, 7, 'with the roll the item actually has')
  }
  // The card shows them as ordinary, selectable mods — no read-only row.
  assert.equal(card.addedMsg.mods.some(m => m.searchable === false), false)
})

test('stage 1: nothing of it reached the gap view', { skip }, async () => {
  assert.deepEqual(await gapTexts('de'), [])
})

test('stage 1: the catalogue was fetched, and nothing else was fetched successfully', { skip }, () => {
  assert.equal(netCalls.filter(u => u === CATALOGUE_URL).length, 1, 'once per TTL, not once per mod')
})

// --- stage 1, in the copy form the tool actually asks for --------------------
//
// Everything above copies the item as plain Ctrl+C would. The tool asks its
// users to bind Ctrl+Alt+C ("Advanced Mod Descriptions") instead, and that form
// writes the roll TOGETHER with the range it came out of — "+42(39-49) zu
// maximalem Energieschild". GGG's catalogue lists neither bracket, so this is
// the normal case for the repair path, not an edge one. It is also not a German
// problem: the same item copied from an English client carries the same
// brackets, which is what the second test here is for.
const ADV_ROLL = 13
const ADV_LO = 8
const ADV_HI = 21
const advanced = `${ADV_ROLL}(${ADV_LO}-${ADV_HI})`

test('stage 1: a mod copied with Ctrl+Alt+C — roll AND range — is repaired as well', { skip }, async () => {
  const { id } = await post('deuser', fixture.clipboard(advanced))
  const card = cardFor('deuser', id)
  assert.ok(card, 'the item parsed and got a card')

  assert.deepEqual(card.item.unknownModifiers, [], 'the bracket did not stop the catalogue')
  for (const v of fixture.victims) {
    const stat = card.preset.stats.find(s => s.tradeId?.[0] === v.tradeId)
    assert.ok(stat, `${v.ref} was spliced back in with GGG's trade id`)
    assert.equal(stat.roll.value, ADV_ROLL, 'the ROLL is what the search filters on, not a bound')
    assert.deepEqual(stat.roll.default, { min: ADV_LO, max: ADV_HI }, 'the range became the slider track')
  }
  assert.equal(card.addedMsg.mods.some(m => m.searchable === false), false)
  assert.deepEqual(await gapTexts('de'), [], 'and nothing of it is a gap')
})

test('stage 1: the English client gets the identical repair out of that form', { skip }, async () => {
  const { id } = await post('enuser', fixture.englishClipboard(advanced))
  const card = cardFor('enuser', id)
  assert.ok(card, 'the English item parsed')
  assert.deepEqual(card.item.unknownModifiers, [], 'English profits from the same cleanup')
  for (const v of fixture.victims) {
    const stat = card.preset.stats.find(s => s.tradeId?.[0] === v.tradeId)
    assert.ok(stat, `${v.ref} was spliced back in`)
    assert.equal(stat.roll.value, ADV_ROLL)
    assert.deepEqual(stat.roll.default, { min: ADV_LO, max: ADV_HI })
  }
  assert.deepEqual(await gapTexts('en'), [], 'the English user has no gap of his own here')
})

// --- stage 2: the same item with the pair table gone -------------------------

test('stage 2: with an empty pair table the line stays read-only', { skip }, async () => {
  // Emptying the file and reloading the bridge is exactly what a new snapshot
  // does to it (server.mjs, onAptData) — no other state is touched.
  await writeFile(fixture.pairsPath, '')
  mod.modTextBridge.reload()

  // A different roll: same stats, different item, so the repost dedupe cannot
  // hand back the card from stage 1.
  const { id } = await post('deuser', fixture.clipboard(9))
  const card = cardFor('deuser', id)
  assert.ok(card)

  const unresolved = card.item.unknownModifiers.map(u => u.text)
  assert.equal(unresolved.length, fixture.victims.length)
  for (const v of fixture.victims) {
    assert.ok(unresolved.includes(v.de.replace('#', v.sign + 9)), `${v.ref} stayed unresolved`)
    assert.equal(card.preset.stats.some(s => s.tradeId?.[0] === v.tradeId), false, 'and it is NOT in the search')
  }
  // Read-only on the card is what the user sees instead of a silent omission.
  const readOnly = card.addedMsg.mods.filter(m => m.searchable === false).map(m => m.text)
  assert.equal(readOnly.length, fixture.victims.length)
})

test('stage 2: and it stands in the gap view, per language', { skip }, async () => {
  const texts = await gapTexts('de')
  for (const v of fixture.victims) {
    assert.ok(texts.includes(v.de.replace('#', v.sign + 9)), `${v.ref} is listed for the operator`)
  }
  assert.deepEqual(await gapTexts('en'), [], 'the English user has no gap of his own here')
})

// --- English is untouched by all of it ---------------------------------------

test('English resolves the same hole without the pair table being involved at all', { skip }, async () => {
  // Runs AFTER stage 2, on purpose: the German pair table is empty by now and
  // there has never been an English one. If the English path went through the
  // bridge, this could not work — it goes through tradeStatIndex.resolve() with
  // the item's own text.
  const { id } = await post('enuser', fixture.englishClipboard(11))
  const card = cardFor('enuser', id)
  assert.ok(card, 'the English item parsed')
  assert.deepEqual(card.item.unknownModifiers, [], 'both mods came back from the catalogue')
  for (const v of fixture.victims) {
    const stat = card.preset.stats.find(s => s.tradeId?.[0] === v.tradeId)
    assert.ok(stat, `${v.ref} was spliced back in`)
    assert.equal(stat.roll.value, 11)
  }
  assert.deepEqual(await gapTexts('en'), [], 'and nothing of it is a gap')
})
