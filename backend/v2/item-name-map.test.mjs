// Item names on screen: the display bridge, and the line it must not cross.
//
// The German page translated its chrome and left every item name English —
// `Chaos Orb` under `WÄHRUNG`, `Vivid Lifefo…` under `LEBENSKRAFT — VERKAUF`.
// The pair table needed for that already existed, but only in the direction the
// corpse store needs it (localized -> English, loadRefNamesByLocalName). This
// file covers the other direction and, just as importantly, fences it in:
//
//   1. data/<lang>/items.ndjson yields refName -> localized name,
//   2. GET /item-name-map hands that table to the browser of a user whose
//      CONFIGURED language is not the primary one, and an empty one to everyone
//      else — the identity path, not a lookup that happens to come out equal,
//   3. and the price side is untouched: the very same item still resolves to
//      its ENGLISH reference name in priceKeyOf, which is what the value join,
//      the trade query and every price source are keyed by. Translating there
//      is the mistake that produced the pricing bugs price-source-lang.test.mjs
//      exists for, so the two claims are asserted side by side, on one item.
//
// Fixture: the same synthetic locale price-source-lang.test.mjs and
// localized-names.test.mjs use — the real English snapshot with an umlaut
// prefix on every `name`, `refName` untouched, indices regenerated. No real
// German data set is needed, so this file does NOT skip on a fresh clone, and
// nothing about the game is spelled out here.
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

const root = await mkdtemp(path.join(tmpdir(), 'ppt-namemap-'))

// --- fixture: one snapshot dir carrying data/en and data/de ------------------

const enItems = await readFile(new URL('items.ndjson', EN_DIR), 'utf8')
const enStats = await readFile(new URL('stats.ndjson', EN_DIR), 'utf8')
const enEntries = enItems.split('\n').filter(Boolean).map(l => JSON.parse(l))
const deItems = enEntries.map(e => JSON.stringify({ ...e, name: translate(e.name) })).join('\n') + '\n'

const VERSION = 'v-item-name-map'
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
await writeFile(path.join(snapshot, 'data/de/items.ndjson'), deItems)
await writeFile(path.join(snapshot, 'data/de/stats.ndjson'), enStats)
await copyFile(new URL('client_strings.js', EN_DIR), path.join(snapshot, 'data/de/client_strings.js'))
for (const [lang, items] of [['en', enItems], ['de', deItems]]) {
  const bins = buildIndexBins({ itemsNdjson: items, statsNdjson: enStats })
  for (const [name, arr] of Object.entries(bins)) {
    await writeFile(path.join(snapshot, 'data', lang, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
  }
}
// A third, deliberately broken locale in the SAME snapshot: two lines share a
// refName but disagree on the localized name. Never configured for a user, so
// it can only be reached by asking the loader directly — which is exactly what
// the ambiguity test does.
const CLASH = 'Zz Clashing Name'
const CLEAR = 'Zz Clear Name'
await mkdir(path.join(snapshot, 'data/zz'), { recursive: true })
await writeFile(path.join(snapshot, 'data/zz/items.ndjson'),
  JSON.stringify({ name: 'Eins', refName: CLASH }) + '\n' +
  JSON.stringify({ name: 'Zwei', refName: CLASH }) + '\n' +
  JSON.stringify({ name: 'Drei', refName: CLEAR }) + '\n')

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
// A stackable currency — the kind that fills the net-worth table and the rail.
const CURRENCY = first(e => e.namespace === 'ITEM' && e.tradeTag != null && /Orb$/.test(e.refName))
// A unique whose base is a jewel: parses from a three-line clipboard and is the
// case where `info` really is the entry for the item's own name.
const UNIQUE = first(e => e.namespace === 'UNIQUE' && e.unique?.base &&
  byRef.get(e.unique.base)?.craftable?.category === 'Jewel')

// --- boot the real server on that snapshot -----------------------------------

// The full set that keeps a booted server off the network. One list, imported:
// every file that wrote it out by hand left something out, and what kept being
// left out was the switch a WebSocket needs (test-quiet-env.mjs, docs/bugs.md
// B25). Applied FIRST — anything this file sets below overrides it on purpose.
quietEnv()
process.env.PORT = '0'
process.env.POE_LEAGUE = LEAGUE
process.env.POE_USERS = 'enuser,deuser'
process.env.POE_USER_LANGS = 'deuser:de'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_DATA_REFRESH_DIR = refreshDir
process.env.POE_REFERENCE_DISABLED = '1'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_NETWORTH_AUTOSYNC = '0'
process.env.POE_NETWORTH_STORE = path.join(root, 'networth-store.json')
process.env.POE_NETWORTH_HISTORY = path.join(root, 'networth-history.ndjson')
process.env.POE_NETWORTH_CONFIG = path.join(root, 'no-such-credentials.json')
process.env.POE_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')

let mod
let de
let base

before(async () => {
  mod = await import('./server.mjs')
  de = mod.engines.parserFor('de')
  assert.ok(de, 'the German instance must be live — the display side is read off it')
  base = `http://127.0.0.1:${mod.server.address().port}`
})

after(async () => {
  await new Promise(r => mod.server.close(r))
  await rm(root, { recursive: true, force: true })
})

const get = (p, user) => fetch(`${base}${p}`, user ? { headers: { cookie: `ppt_user=${user}` } } : undefined)

// --- 1. the table ------------------------------------------------------------

test('the pair table reads refName -> localized name out of the snapshot', async () => {
  const map = await mod.loadLocalNamesByRefName('de')
  assert.ok(map.size > 1000, `suspiciously small table (${map.size})`)
  assert.equal(map.get(CURRENCY.refName), translate(CURRENCY.name))
  assert.equal(map.get(UNIQUE.refName), translate(UNIQUE.name))
})

test('a language with no generated data set yields an empty table, not an error', async () => {
  // The German set is produced locally; before the first generator run the page
  // simply shows English names, which is the state this feature replaced.
  const map = await mod.loadLocalNamesByRefName('xx')
  assert.equal(map.size, 0)
})

test('an ambiguous reference name stays English rather than being guessed', async () => {
  // Two lines, one refName, two different localized names: neither is provably
  // the right one. The entry is poisoned instead of resolved, and a poisoned
  // entry never reaches the browser — a wrong name on a row is worse than an
  // English one. Same stance as loadRefNamesByLocalName takes in the other
  // direction, where the price depends on it.
  const map = await mod.loadLocalNamesByRefName('zz')
  assert.equal(map.get(CLASH), null, 'ambiguous -> poisoned')
  assert.equal(map.get(CLEAR), 'Drei', 'unambiguous -> resolved')

  const names = JSON.parse(mod.itemNameMapJson('zz')).names
  assert.ok(!Object.hasOwn(names, CLASH), 'and the poisoned entry is not shipped at all')
})

test('English pairs are left out — there is nothing there to translate', async () => {
  const map = await mod.loadLocalNamesByRefName('en')
  assert.equal(map.size, 0,
    'data/en has name === refName on every line, so every entry would be dead weight')
})

// --- 2. the endpoint ---------------------------------------------------------

test('the endpoint answers the language the CONFIGURATION puts the user on', async () => {
  const r = await get('/item-name-map', 'deuser')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.lang, 'de')
  assert.equal(j.names[CURRENCY.refName], translate(CURRENCY.name))
  assert.equal(j.names[UNIQUE.refName], translate(UNIQUE.name))
})

test('a user on the primary language gets an empty table, not an identity table', async () => {
  const r = await get('/item-name-map', 'enuser')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.lang, 'en')
  assert.deepEqual(j.names, {},
    'English must not even carry a table — the page can then skip the lookup entirely')
})

test('no identity, no table', async () => {
  assert.equal((await get('/item-name-map')).status, 400)
  assert.equal((await get('/item-name-map', 'nosuchuser')).status, 400)
})

test('the answer is not cached by the browser — a data refresh changes it', async () => {
  const r = await get('/item-name-map', 'deuser')
  assert.equal(r.headers.get('cache-control'), 'no-store')
})

// --- 3. the line the display side must not cross ------------------------------

test('the same item still prices under its ENGLISH reference name', async () => {
  // The whole point of keeping this in one file: the table above says the row
  // is PRINTED in German, and this says the row is still LOOKED UP in English.
  // If a future change ever translates the join, this pair contradicts itself.
  const clip = `Item Class: Stackable Currency
Rarity: Currency
${translate(CURRENCY.name)}
--------
Stack Size: 3/10
`
  const { item } = await de.parseItem(clip, { league: LEAGUE })
  assert.ok(item, 'the German clipboard must parse')
  assert.equal(item.name, translate(CURRENCY.name), 'the parsed DISPLAY name is localized')
  assert.equal(mod.priceKeyOf(item), CURRENCY.refName, 'the PRICE key is the English reference name')

  const names = JSON.parse(mod.itemNameMapJson('de')).names
  assert.equal(names[mod.priceKeyOf(item)], item.name,
    'and the display table is exactly the bridge between those two, in that direction')
})

test('the display table never becomes a price source: it is keyed the other way', async () => {
  // A refName is what goes out to poe.ninja, Faustus and the trade query. Asked
  // with a LOCALIZED name the table answers nothing at all, so a lookup that
  // accidentally used it would fail loudly instead of pricing the wrong item.
  const names = JSON.parse(mod.itemNameMapJson('de')).names
  assert.equal(names[translate(CURRENCY.name)], undefined)
  assert.equal(names[CURRENCY.refName], translate(CURRENCY.name))
})

// --- 4. the OTHER language question: what the GAME matches (B10) --------------
// The stash-highlight regex is not display text — it is pasted into the game's
// stash search, which matches the names the CLIENT prints. GET /item-names
// therefore answers in the game's language, and it answers with BOTH halves the
// generator needs, so they cannot drift apart:
//   { lang, names: [spellings needing no translation], byRef: { ref: client } }
// The universe the page uses is names ∪ values(byRef).

const universeOf = j => new Set([...j.names, ...Object.values(j.byRef)])

test('/item-names answers the language the GAME runs in, universe included', async () => {
  const r = await get('/item-names', 'deuser')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.lang, 'de')
  assert.equal(j.byRef[CURRENCY.refName], translate(CURRENCY.name),
    'the table that moves a wanted name into the game language')
  const universe = universeOf(j)
  assert.ok(universe.has(translate(CURRENCY.name)), 'the localized spelling is in the universe')
  assert.ok(universe.has(translate(UNIQUE.name)))
  assert.ok(universe.size > 1000, `suspiciously small universe (${universe.size})`)
})

test('/item-names: the WHOLE universe moves, not just the wanted names', async () => {
  // The trap this endpoint exists to avoid: shortening German names against an
  // English universe produces fragments that are unambiguous in a universe
  // nobody is searching. So no English reference name may survive in the German
  // answer — for this fixture every localized name differs from its refName, so
  // the check is exact.
  const j = await (await get('/item-names', 'deuser')).json()
  const universe = universeOf(j)
  for (const ref of [CURRENCY.refName, UNIQUE.refName]) {
    assert.ok(!universe.has(ref), `${ref} is still in the German universe in English`)
  }
  const english = [...universe].filter(n => !n.startsWith('Ü'))
  assert.deepEqual(english, [], 'every name in this fixture is translated, so none may stay English')
})

test('/item-names: each localized spelling is stated exactly once', async () => {
  // names and byRef are disjoint by construction — the page unions them, and
  // saying every German name twice would double the payload for nothing.
  const j = await (await get('/item-names', 'deuser')).json()
  const values = new Set(Object.values(j.byRef))
  assert.deepEqual(j.names.filter(n => values.has(n)), [])
})

test('/item-names: the primary language is the list this endpoint always returned', async () => {
  const j = await (await get('/item-names', 'enuser')).json()
  assert.equal(j.lang, 'en')
  assert.deepEqual(j.byRef, {}, 'nothing to translate -> no table, not an identity table')
  assert.ok(j.names.includes(CURRENCY.refName))
  assert.ok(j.names.includes(UNIQUE.refName))
  assert.ok(j.names.length > 1000)
})

test('/item-names: no identity, no list — and no shared cache either', async () => {
  // The body is per user now: a shared cache handing one player's German list
  // to another would highlight the wrong slots for both.
  assert.equal((await get('/item-names')).status, 400)
  assert.equal((await get('/item-names', 'nosuchuser')).status, 400)
  const r = await get('/item-names', 'deuser')
  assert.equal(r.headers.get('cache-control'), 'no-store')
})

test('/item-names and /item-name-map stay two separate answers', async () => {
  // Same configured value today, two different questions (display vs. what the
  // game matches). The point of the assertion is that the highlight has its own
  // source: if one of them is ever switched over, the other does not follow by
  // accident.
  const hl = await (await get('/item-names', 'deuser')).json()
  const disp = await (await get('/item-name-map', 'deuser')).json()
  assert.equal(hl.lang, disp.lang)
  assert.ok(Array.isArray(hl.names), 'the highlight answer carries a universe')
  assert.equal(disp.names[CURRENCY.refName], hl.byRef[CURRENCY.refName],
    'and while one setting feeds both, they say the same thing')
})
