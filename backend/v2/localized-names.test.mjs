// Localized item names: the parser must resolve the names it reads from the
// clipboard against the TRANSLATED name column, not against the English
// `refName`.
//
// This is upstream commit 7d53dea5 ("item text contains translated names once
// again", #1863), vendored on top of the 22.07.2026 snapshot. Before it,
// `findInDatabase` looked every name up with `ITEM_BY_REF` — which can only
// ever hit in an English client. A non-English snapshot failed with
// `item.unknown` on the very first lookup, and the Unique variant filter
// (`info.unique.base === item.baseType`) compared an English base name against
// a clipboard base name in the user's language, so it silently produced no
// variant at all.
//
// The fixture below is a synthetic locale derived from the real English
// snapshot: every item `name` is prefixed, every `refName` is left alone, and
// `client_strings.js` is the English one. That isolates exactly what the patch
// changes — the section keywords stay readable, only the NAMES are foreign. It
// also keeps the language-neutral promise of the design honest: `unique.base`
// stays English in the data, and the parser is what bridges the gap.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildIndexBins } from './apt-index.mjs'

const EN_DIR = new URL('../../renderer/public/data/en/', import.meta.url)
const DATA_DIR = new URL('../../renderer/public/data/', import.meta.url)

// The synthetic locale. Non-ASCII on purpose: the index hashes FNV-1a over
// UTF-8 while the ndjson offsets are UTF-16 code units, and a translated
// snapshot is the first thing that ever puts both under load at once.
const LANG = 'xx'
const translate = name => `Ü${name}`

// A Unique that exists on three different bases and carries the SAME name on
// all of them (read back from the snapshot below, not assumed): the only thing
// telling the three apart is `unique.base`, so this is the case the variant
// filter exists for.
const UNIQUE = 'Combat Focus'
const BASE = 'Cobalt Jewel'

const INDEX_BINS = ['stats-ref.index.bin', 'stats-matcher.index.bin', 'items-name.index.bin', 'items-ref.index.bin']

const root = await mkdtemp(path.join(tmpdir(), 'ppt-localized-'))
after(() => rm(root, { recursive: true, force: true }))

// --- fixture: an English snapshot with a translated name column -------------

const enItems = await readFile(new URL('items.ndjson', EN_DIR), 'utf8')
const enStats = await readFile(new URL('stats.ndjson', EN_DIR), 'utf8')

const entries = enItems.split('\n').filter(Boolean).map(JSON.parse)
const localizedItems = entries
  .map(entry => JSON.stringify({ ...entry, name: translate(entry.name) }))
  .join('\n') + '\n'

const publicDir = path.join(root, 'public')
await mkdir(path.join(publicDir, `data/${LANG}`), { recursive: true })
await mkdir(path.join(publicDir, 'data/en'), { recursive: true })
// CLIENT_STRINGS_REF is loaded from data/en by design (assets/data/index.ts) —
// that stays English even in a localized run, so the file has to be there.
await copyFile(new URL('client_strings.js', EN_DIR), path.join(publicDir, 'data/en/client_strings.js'))
await copyFile(new URL('client_strings.js', EN_DIR), path.join(publicDir, `data/${LANG}/client_strings.js`))
await copyFile(new URL('item-drop.json', DATA_DIR), path.join(publicDir, 'data/item-drop.json'))
await copyFile(new URL('patrons.json', DATA_DIR), path.join(publicDir, 'data/patrons.json'))
await writeFile(path.join(publicDir, `data/${LANG}/items.ndjson`), localizedItems)
await writeFile(path.join(publicDir, `data/${LANG}/stats.ndjson`), enStats)

const bins = buildIndexBins({ itemsNdjson: localizedItems, statsNdjson: enStats })
for (const name of INDEX_BINS) {
  const bin = bins[name]
  await writeFile(path.join(publicDir, `data/${LANG}/${name}`), Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength))
}

const engine = await import('./engine.bundle.mjs')
await engine.ready({ publicDataDir: pathToFileURL(publicDir).href + '/', lang: LANG })

// --- the properties the fixture rests on ------------------------------------

test('the fixture really is a foreign locale: names translated, refs untouched', () => {
  const variants = entries.filter(e => e.namespace === 'UNIQUE' && e.refName === UNIQUE)
  assert.ok(variants.length > 1, `${UNIQUE} should have several base variants in the snapshot`)
  assert.ok(variants.every(v => v.name === UNIQUE), 'the variants must be indistinguishable by name')
  assert.ok(variants.some(v => v.unique.base === BASE), `${BASE} should be one of the variant bases`)
  assert.ok(entries.every(e => e.name === e.refName), 'the English snapshot has name === refName')
  assert.notEqual(translate(BASE), BASE)
})

// --- the capability the patch adds ------------------------------------------

const clipboard = `Item Class: Jewels
Rarity: Unique
${translate(UNIQUE)}
${translate(BASE)}
--------
Limited to: 2
Radius: Large
--------
Item Level: 84
--------
30% increased Elemental Damage with Attack Skills
--------
Place into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the Socket.
`

test('a localized clipboard resolves to the English refName', async () => {
  const { item } = await engine.parseItem(clipboard, { league: 'Standard' })
  assert.equal(item.info.namespace, 'UNIQUE')
  assert.equal(item.info.refName, UNIQUE)
})

test('the Unique variant filter picks the base the clipboard names', async () => {
  const { item } = await engine.parseItem(clipboard, { league: 'Standard' })
  // The base name arrived translated, `unique.base` in the data is English —
  // without the ITEM_BY_TRANSLATED -> refName hop the filter matches nothing
  // and `info[0]` is undefined.
  assert.equal(item.infoVariants.length, 1)
  assert.equal(item.info.unique.base, BASE)
})

test('language-neutral fields still resolve through the English ref index', async () => {
  const { item } = await engine.parseItem(clipboard, { league: 'Standard' })
  // `category` is read via ITEM_BY_REF('ITEM', unique.base) — the one lookup
  // the patch deliberately leaves ref-based, because its input is data, not
  // clipboard text.
  assert.equal(item.category, entries.find(e => e.namespace === 'ITEM' && e.refName === BASE).craftable.category)
})

test('magic items find their base type in the translated name column', async () => {
  // magic-name.ts permutes the words of the magic name and asks the item
  // database for each permutation — with ITEM_BY_REF that never hit outside an
  // English client.
  const magic = `Item Class: Jewels
Rarity: Magic
Fanatical ${translate(BASE)} of Berserking
--------
Limited to: 2
Radius: Large
--------
Item Level: 84
--------
30% increased Elemental Damage with Attack Skills
`
  const { item } = await engine.parseItem(magic, { league: 'Standard' })
  assert.equal(item.info.refName, BASE)
})
