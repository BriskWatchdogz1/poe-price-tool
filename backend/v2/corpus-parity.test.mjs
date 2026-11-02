// Acceptance criterion 1 of the German rollout, against REAL item texts:
// the same item, copied out of a German and out of an English client, has to
// come out of the parser as the same thing — same `refName`, same set of
// recognised stat `ref`s, same trade query.
//
// The corpus is `corpus/`, one directory per item, and this file iterates over
// whatever is in there. Nothing about any item is written down here: no name,
// no base, no mod text, no expected value. Adding an item is two text files and
// a `covers.txt`; adding a category is a line in `corpus/wanted.txt`. That is
// the whole point — the corpus is small today and has to grow without anybody
// coming back to edit a test.
//
// WHAT IS RED AND WHAT IS ONLY REPORTED. The corpus is knowingly incomplete:
// no wanted category is covered yet, because covering one needs a PAIR and not
// one of the collected texts has an English partner. Failing on that would mean a permanently red
// suite that tells nobody anything. So a missing partner and a missing category
// are PRINTED, in full, by a test that passes. What turns this file red is a
// text that is IN the corpus and stops parsing, and a pair that IS complete and
// drifts apart.
//
// THE TRADE QUERY IS THE REAL ONE. `createTradeRequest` is not exported from
// engine.mts, and rebuilding it here would test a copy of the logic instead of
// the logic. So the query is built the way base-percentile.test.mjs builds it:
// `searchPreset` runs, and the fetch spy takes the body out of the request and
// aborts before anything leaves the machine. It also answers the question the
// preset alone cannot: `filters.searchExact.name` legitimately differs between
// the two languages (it is the display name), and only the request body shows
// whether that difference reaches GGG — it does not, because `nameTrade` wins.
//
// ONE ENGINE GRAPH PER QUERY. The bundle's RateLimiter is module state and
// allows exactly one search per graph (1 per 5s); the second one throws instead
// of building a body. A fresh graph costs ~20 ms and ~10 MB, which is the
// cheaper side of that trade.
//
// NO NETWORK. The spy sits on `globalThis.fetch` BEFORE the engine loads, so it
// ends up underneath the engine's own file:// adapter (installFetchFs binds
// `nativeFetch` on first call — a spy installed later sees nothing and the test
// would be green without checking anything; see bilingual-parse.test.mjs). Any
// http(s) call that is not a trade query we deliberately asked for is recorded
// and fails the last test in this file.
//
// Skips without a generated `renderer/public/data/de/` — that set is derived
// from GGG's game data and every installation makes its own. The bookkeeping
// over `corpus/` runs regardless, so a fresh clone still gets told what the
// corpus is missing.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createEngineInstances } from './engine-instances.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORPUS = path.join(HERE, 'corpus')
const PUBLIC = path.resolve(HERE, '../../renderer/public')
const PUBLIC_URL = pathToFileURL(PUBLIC).href + '/'
const BUNDLE = pathToFileURL(path.join(HERE, 'engine.bundle.mjs')).href
const LEAGUE = 'Standard'

const HAVE_DE = ['items.ndjson', 'stats.ndjson']
  .every(f => existsSync(path.join(PUBLIC, 'data/de', f)))
const skip = HAVE_DE ? false : 'no generated data/de here — run `npm run gen-lang-data` first'

// --- the corpus, read off disk ------------------------------------------------

const lines = text => text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

/** `corpus/wanted.txt` -> [{ id, decides, what }]. A leading "!" on the id marks
 *  a category that settles an open question rather than merely widening cover. */
function parseWanted (text) {
  return lines(text).map(line => {
    const i = line.indexOf(':')
    assert.ok(i > 0, `wanted.txt: expected "<id>: <description>", got ${JSON.stringify(line)}`)
    const id = line.slice(0, i).trim()
    return { id: id.replace(/^!/, ''), decides: id.startsWith('!'), what: line.slice(i + 1).trim() }
  })
}

async function loadCorpus () {
  const entries = await readdir(CORPUS, { withFileTypes: true })
  const items = []
  for (const e of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(CORPUS, e.name)
    const read = async f => existsSync(path.join(dir, f)) ? readFile(path.join(dir, f), 'utf8') : null
    items.push({
      slug: e.name,
      de: await read('de.txt'),
      en: await read('en.txt'),
      covers: lines(await read('covers.txt') ?? '')
    })
  }
  return items
}

const wanted = parseWanted(await readFile(path.join(CORPUS, 'wanted.txt'), 'utf8'))
const items = await loadCorpus()
const pairs = items.filter(i => i.de && i.en)

// --- the fetch spy, installed BEFORE anything loads ---------------------------

const CAPTURED = 'corpus-parity: trade query captured'
const escaped = []
let capture = null
const beforeAdapter = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input))
  if (!/^https?:/i.test(url)) return beforeAdapter(input, init)
  if (capture) {
    capture.body = JSON.parse(init.body)
    capture = null
    throw new Error(CAPTURED)
  }
  escaped.push(url)
  throw new Error(`no network in this test: ${url}`)
}

// --- the engines ---------------------------------------------------------------

let engines
let queryGraphs = 0

before(async () => {
  if (skip) return
  engines = await createEngineInstances({ bundleUrl: BUNDLE, languages: ['de'], log: console })
  await engines.ready({ publicDataDir: PUBLIC_URL })
  assert.deepEqual(engines.liveLanguages(), ['en', 'de'], 'both parsers have to be up for a parity test')
})

const parserFor = lang => {
  const p = engines.parserFor(lang)
  assert.ok(p, `no live engine instance for "${lang}"`)
  return p
}

/** The recognised stats, as a comparable set: type and ref, sorted. Two mods can
 *  fold into one stat and one line can produce several, so this is a multiset,
 *  not a set of distinct refs. */
const statRefs = item => item.statsByType.map(c => `${c.type}|${c.stat.ref}`).sort()

/** The real request body GGG would have received — built, captured, dropped. */
async function tradeQueryFor (preset) {
  const engine = await import(`./engine.bundle.mjs?corpus-query=${queryGraphs++}`)
  await engine.ready({ lang: 'en', publicDataDir: PUBLIC_URL })
  const slot = {}
  capture = slot
  try {
    await engine.searchPreset(preset, { league: LEAGUE })
  } catch (e) {
    if (e.message !== CAPTURED) throw e
  } finally {
    capture = null
  }
  assert.ok(slot.body, 'searchPreset did not get as far as building a request body')
  return slot.body
}

// --- 1. the corpus itself is well formed (no data set needed) -------------------

test('every corpus directory carries a German text', () => {
  const empty = items.filter(i => !i.de?.trim()).map(i => i.slug)
  assert.deepEqual(empty, [], 'a corpus directory without a de.txt is a directory nobody checks')
  assert.ok(items.length > 0, 'the corpus is empty — then criterion 1 has no material at all')
})

test('every covers.txt names categories that exist in wanted.txt', () => {
  const known = new Set(wanted.map(c => c.id))
  const unknown = items.flatMap(i => i.covers.filter(c => !known.has(c)).map(c => `${i.slug}: ${c}`))
  assert.deepEqual(unknown, [], 'unknown category id — a typo here would count towards nothing')
})

test('an English text is a partner, not a copy', () => {
  const copies = items.filter(i => i.en && i.en === i.de).map(i => i.slug)
  assert.deepEqual(copies, [], 'en.txt is byte identical to de.txt — that pair proves nothing')
  const orphans = items.filter(i => i.en && !i.de).map(i => i.slug)
  assert.deepEqual(orphans, [], 'an English text without a German one has nothing to be compared against')
})

// --- 2. every German text parses ------------------------------------------------

for (const item of items) {
  test(`${item.slug}: the German text parses`, { skip }, async () => {
    // parseItem throws on the engine's own refusals — `item.parse_error` when
    // the clipboard is not an item at all, `item.unknown` when the name and
    // base cannot be resolved against the data set. Both are exactly what a
    // German user would experience as "the tool ignores my item".
    const { item: parsed } = await parserFor('de').parseItem(item.de, { league: LEAGUE })
    assert.ok(parsed.info?.refName, 'the item resolved to no database entry')
    assert.ok(parsed.statsByType.length > 0, 'not a single mod line was recognised')
  })
}

// --- 3. criterion 1: the pairs ----------------------------------------------------

for (const item of pairs) {
  test(`${item.slug}: German and English parse to the same item`, { skip }, async () => {
    const de = await parserFor('de').parseItem(item.de, { league: LEAGUE })
    const en = await parserFor('en').parseItem(item.en, { league: LEAGUE })
    assert.equal(de.item.info?.refName, en.item.info?.refName, 'refName is the join key for trade and every price source')
    assert.deepEqual(statRefs(de.item), statRefs(en.item), 'the two parses recognised different mods')
    assert.equal((de.item.unknownModifiers || []).length, (en.item.unknownModifiers || []).length,
      'one language left more lines unrecognised than the other')
  })

  test(`${item.slug}: German and English build the same trade query`, { skip }, async () => {
    const engine = engines.primary()
    const de = await parserFor('de').parseItem(item.de, { league: LEAGUE })
    const en = await parserFor('en').parseItem(item.en, { league: LEAGUE })
    const deQuery = await tradeQueryFor(engine.activePreset(de.presets))
    const enQuery = await tradeQueryFor(engine.activePreset(en.presets))
    assert.deepEqual(deQuery, enQuery, 'filters and values differ between the two languages')
  })
}

// --- 4. what is missing is named, not skipped --------------------------------------

test('the corpus reports what it is still missing', t => {
  const complete = new Set(pairs.flatMap(i => i.covers))
  const missing = wanted.filter(c => !complete.has(c.id))
  const halfPairs = items.filter(i => i.de && !i.en).map(i => i.slug)

  t.diagnostic(`corpus: ${items.length} item(s), ${pairs.length} complete pair(s), ` +
    `${wanted.length - missing.length} of ${wanted.length} categories covered`)
  for (const slug of halfPairs) {
    t.diagnostic(`no English partner yet: ${slug} — parsed, but not compared against anything`)
  }
  for (const c of missing.filter(c => c.decides)) {
    t.diagnostic(`MISSING, AND IT DECIDES SOMETHING — ${c.id}: ${c.what}`)
  }
  const rest = missing.filter(c => !c.decides).map(c => c.id)
  if (rest.length) t.diagnostic(`still to collect: ${rest.join(', ')}`)
  if (!missing.length && !halfPairs.length) t.diagnostic('nothing missing — the corpus is complete')

  // Deliberately no assertion on any of the above: an incomplete corpus is a
  // known state of this project and a red suite would only train people to
  // ignore it. The report is the deliverable here.
  //
  // Criterion 2 of the design (price-source parity) is NOT re-checked in this
  // file. All four paths of section 4 — faustusChaosFor, faustusRangeFor,
  // ninjaBulkPrice, ninjaRefFor — are covered by price-source-lang.test.mjs
  // against frozen answers, and doing it a second time here would only make
  // the same claim from worse material.
  assert.ok(true)
})

// --- 5. nothing left the machine ------------------------------------------------

test('no request escaped to the network', { skip }, () => {
  assert.deepEqual(escaped, [], 'a corpus test reached out to the internet')
})
