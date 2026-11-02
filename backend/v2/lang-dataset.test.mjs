// The SHIPPED German data set against the shipped English one.
//
// The fixture tests next door prove the derivation rules; this one proves the
// file that is actually served. It reads only what is checked in — no game
// data, no network — and it is the guard that catches a bad generator run
// before it reaches a user, because everything it checks fails silently in
// production: an English `name` left in place looks like a translation gap
// nobody reports, a `refName` that moved breaks the price join, and a flag
// that changed flips the sign of a roll.
//
// The German set is NOT checked in — it is derived from GGG's game data and
// every installation generates its own (that is what keeps the redistribution
// question from arising at all). So these tests skip on a fresh clone and bite
// on the machine that just ran the generator, which is the machine where a bad
// run would otherwise go unnoticed:
//   node backend/v2/lang-data-gen.mjs --lang de --patch <version>
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validate } from './lang-derive.mjs'

const DATA = new URL('../../renderer/public/data/', import.meta.url)
const HAVE_DE = ['items.ndjson', 'stats.ndjson']
  .every(f => existsSync(fileURLToPath(new URL(`de/${f}`, DATA))))
const skip = HAVE_DE ? false : 'no generated data/de here — run lang-data-gen.mjs first'
const read = async (lang, file) =>
  (await readFile(new URL(`${lang}/${file}`, DATA), 'utf8'))
    .split('\n').filter(Boolean).map(l => JSON.parse(l))
const flat = lines => lines.flatMap(l => l.stats ? l.stats : [l])

const load = async () => ({
  enItems: await read('en', 'items.ndjson'),
  deItems: await read('de', 'items.ndjson'),
  enStats: await read('en', 'stats.ndjson'),
  deStats: await read('de', 'stats.ndjson')
})

test('the shipped German set passes the generator validation', { skip }, async () => {
  const d = await load()
  // The adoption gate is switched off HERE on purpose (docs/bugs.md B23). It
  // asks "did this RUN lose coverage the live set already had" and needs the
  // set that was replaced; on disk there is one set and no run. Everything else
  // validate() checks — ref order, flag conflicts, namespace counts, item order
  // — still has to hold, and is the work this test was written for.
  const r = validate({ ...d, maxLossRatio: 1 })
  assert.deepEqual(r.errors, [])

  // TWO NUMBERS, AND ONLY ONE OF THEM IS A VERDICT ON THE GENERATOR.
  //
  // Stats with no German matcher AT ALL grow whenever the English set runs
  // ahead of the game data the derivation reads — upstream ships on its own
  // schedule, and a stat whose text is in no description file of the patch
  // cannot be derived by any correct generator. So the bar here is an absolute
  // floor on what IS covered, measured and only ever to be raised, rather than
  // a gap count that upstream can move on its own.
  assert.ok(r.counts.covered >= 8272,
    `only ${r.counts.covered} of ${r.counts.statsEn} stats carry a German matcher — that is below the ` +
    '8272 measured on 2026-08-08, which can only mean the derivation lost ground')

  // Stats that resolved PARTIALLY cannot grow for that reason: a stat the game
  // data does not carry produces nothing, not less. This is the number a
  // slipping derivation moves, and it stood at exactly 20 across a month and
  // 986 added English stats.
  const partial = r.counts.shorter - r.counts.shorterToZero
  assert.ok(partial <= 25, `partially resolved stats grew to ${partial}`)
})

test('German and English are not byte identical', { skip }, async () => {
  // A missing language file makes pathofexile-dat fall back to English without
  // a word. This is the only way to see it.
  for (const file of ['items.ndjson', 'stats.ndjson']) {
    const en = await readFile(new URL(`en/${file}`, DATA), 'utf8')
    const de = await readFile(new URL(`de/${file}`, DATA), 'utf8')
    assert.notEqual(de, en, `${file} is byte identical to the English one`)
  }
})

test('every item line keeps its English refName and namespace, only `name` moves', { skip }, async () => {
  const { enItems, deItems } = await load()
  assert.equal(deItems.length, enItems.length)
  let translated = 0
  for (let i = 0; i < enItems.length; i++) {
    const a = enItems[i]
    const b = deItems[i]
    assert.equal(b.refName, a.refName)
    assert.equal(b.namespace, a.namespace)
    // `unique.base` stays English on purpose: it is joined against English
    // refNames, not against a localized name.
    assert.deepEqual(b.unique, a.unique)
    assert.equal(b.tradeTag, a.tradeTag)
    assert.deepEqual(b.gem, a.gem)
    assert.deepEqual({ ...b, name: a.name }, a)
    if (b.name !== a.name) translated++
  }
  assert.ok(translated > enItems.length * 0.9, `only ${translated} of ${enItems.length} names are translated`)
})

test('every stat keeps its ref, trade ids and grouping', { skip }, async () => {
  const { enStats, deStats } = await load()
  assert.equal(deStats.length, enStats.length)
  const en = flat(enStats)
  const de = flat(deStats)
  assert.equal(de.length, en.length)
  for (let i = 0; i < en.length; i++) {
    assert.equal(de[i].ref, en[i].ref)
    assert.deepEqual(de[i].trade, en[i].trade)
    assert.equal(de[i].better, en[i].better)
    assert.equal(de[i].dp, en[i].dp)
  }
})

test('every German matcher inherits the flags of an English one with the same index', { skip }, async () => {
  const { enStats, deStats } = await load()
  const en = flat(enStats)
  const de = flat(deStats)
  const key = m => `${m.value ?? ''}|${m.negate ? 1 : 0}`
  for (let i = 0; i < en.length; i++) {
    const allowed = new Set(en[i].matchers.map(key))
    for (const m of de[i].matchers) {
      assert.ok(allowed.has(key(m)),
        `${en[i].ref}: ${JSON.stringify(m)} carries flags no English matcher of this stat has`)
    }
  }
})

test('no German matcher text is left in English', { skip }, async () => {
  const { enStats, deStats } = await load()
  const en = flat(enStats)
  const de = flat(deStats)
  let same = 0
  let total = 0
  for (let i = 0; i < en.length; i++) {
    const englishTexts = new Set(en[i].matchers.map(m => m.string))
    for (const m of de[i].matchers) {
      total++
      if (englishTexts.has(m.string)) same++
    }
  }
  // A handful legitimately stay identical (proper names, `[DNT]` debug lines);
  // upstream's Russian set has 3 of 10 646.
  assert.ok(same < total * 0.02, `${same} of ${total} matcher strings are still English`)
})

test('an English matcher with `advanced` has a German one with `advanced`', { skip }, async () => {
  // The index reads `advanced` when it is there, and Strg+Alt+C — the trigger
  // the installation instructions use — produces exactly that form. A German
  // set without it would never match an advanced mod line.
  const { enStats, deStats } = await load()
  const en = flat(enStats)
  const de = flat(deStats)
  let missing = 0
  for (let i = 0; i < en.length; i++) {
    if (!en[i].matchers.some(m => m.advanced != null)) continue
    if (!de[i].matchers.length) continue
    if (!de[i].matchers.some(m => m.advanced != null)) missing++
  }
  assert.equal(missing, 0)
})

test('no two German matchers of one stat share a string with different flags', { skip }, async () => {
  const { deStats } = await load()
  for (const s of flat(deStats)) {
    const seen = new Map()
    for (const m of s.matchers) {
      const k = `${m.value ?? ''}|${m.negate ? 1 : 0}`
      if (seen.has(m.string)) {
        assert.equal(seen.get(m.string), k,
          `${s.ref}: ${JSON.stringify(m.string)} appears twice with different flags`)
      }
      seen.set(m.string, k)
    }
  }
})

test('the engine\'s own required refs survive in the German set', { skip }, async () => {
  // engine.bundle.mjs validates a handful of English refs on init() and throws
  // otherwise. They are `ref`s, so they must NOT have been translated.
  const { deStats } = await load()
  const refs = new Set(flat(deStats).map(s => s.ref))
  for (const r of ['#% increased Physical Damage', '+# to maximum Life', '+#% to Fire Resistance']) {
    assert.ok(refs.has(r), `${r} is missing from the German set`)
  }
})
