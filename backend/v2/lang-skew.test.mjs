// "German is running behind English" is a comparison between two sources, and
// the data refresher never makes one — its status() reports each source only
// against itself (design doc, section 2, Skew-Policy). This file pins the new
// comparison: what counts as an offset, what the threshold does, and the two
// states that need no threshold at all (no localized set, refs without an
// English counterpart).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLangSkew, DEFAULT_WARN_RATIO } from './lang-skew.mjs'

const ndjson = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const item = refName => ({ name: refName, refName, namespace: 'ITEM' })
const stat = (ref, { matchers = [{ string: ref }] } = {}) => ({ ref, better: 1, matchers })

// An in-memory pair of data sets, addressed the way the server addresses the
// real ones: resolvePath(lang, file).
function fixture (sets) {
  const files = new Map()
  for (const [lang, set] of Object.entries(sets)) {
    files.set(`${lang}/items.ndjson`, ndjson(set.items))
    files.set(`${lang}/stats.ndjson`, ndjson(set.stats))
  }
  return {
    resolvePath: (lang, file) => `${lang}/${file}`,
    readFileImpl: async p => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files.get(p)
    }
  }
}

// 200 stats and 200 items, so a single missing entry is 0.5 % — exactly on the
// default bar, which makes "above the threshold" testable without magic sizes.
const bulk = n => ({
  items: Array.from({ length: n }, (_, i) => item(`Item ${i}`)),
  stats: Array.from({ length: n }, (_, i) => stat(`stat ${i}`))
})

test('two identical sets show no offset', async () => {
  const skew = createLangSkew({ ...fixture({ en: bulk(200), de: bulk(200) }) })
  const r = await skew.compute({ languages: ['en', 'de'] })
  assert.equal(r.basePresent, true)
  assert.equal(r.warn, false)
  assert.equal(r.languages.length, 1)
  assert.equal(r.languages[0].lang, 'de')
  assert.equal(r.languages[0].present, true)
  for (const m of r.languages[0].metrics) assert.equal(m.missing, 0, `${m.key} has no gap`)
})

test('missing entries above the threshold are found and named', async () => {
  const en = bulk(200)
  const de = { items: en.items.slice(0, 190), stats: en.stats.slice(0, 195) }
  const skew = createLangSkew({ ...fixture({ en, de }) })
  const r = await skew.compute({ languages: ['en', 'de'] })

  const by = Object.fromEntries(r.languages[0].metrics.map(m => [m.key, m]))
  assert.equal(by.items.missing, 10)
  assert.equal(by.items.base, 200)
  assert.equal(by.items.ratio, 0.05)
  assert.equal(by.items.warn, true)
  assert.equal(by.stats.missing, 5)
  assert.equal(by.stats.warn, true)
  assert.equal(r.warn, true, 'the report as a whole warns')
})

// The threshold is configuration, and it has to actually move the verdict.
test('the threshold decides, and it is a ratio of the English set', async () => {
  const en = bulk(200)
  const de = { items: en.items.slice(0, 198), stats: en.stats } // 1 % of items missing
  const lenient = createLangSkew({ ...fixture({ en, de }), warnRatio: 0.05 })
  const strict = createLangSkew({ ...fixture({ en, de }), warnRatio: 0.005 })
  assert.equal((await lenient.compute({ languages: ['en', 'de'] })).warn, false)
  assert.equal((await strict.compute({ languages: ['en', 'de'] })).warn, true)
  assert.equal(DEFAULT_WARN_RATIO, 0.005, 'the documented default')
})

// The gap that produces no error anywhere: the stat exists, so nothing is
// "missing", but it can never be matched out of an item text.
test('a stat that exists without a matcher counts as a gap', async () => {
  const en = { items: [item('A')], stats: [stat('s1'), stat('s2')] }
  const de = { items: [item('A')], stats: [stat('s1'), { ref: 's2', matchers: [] }] }
  const r = await createLangSkew({ ...fixture({ en, de }) }).compute({ languages: ['en', 'de'] })
  const by = Object.fromEntries(r.languages[0].metrics.map(m => [m.key, m]))
  assert.equal(by.stats.missing, 0, 'the entry is there')
  assert.equal(by.matchers.missing, 1, 'but it has nothing to match with')
  assert.equal(r.warn, true)
})

// The extended clipboard form (Ctrl+Alt+C) is the NORMAL case for the German
// user and reads exactly this field, so its absence is its own row.
test('a missing advanced form is its own metric, not folded into the matchers', async () => {
  const withAdv = ref => stat(ref, { matchers: [{ string: ref, advanced: ref + ' (advanced)' }] })
  const en = { items: [item('A')], stats: [withAdv('s1'), withAdv('s2')] }
  const de = { items: [item('A')], stats: [withAdv('s1'), stat('s2')] }
  const r = await createLangSkew({ ...fixture({ en, de }) }).compute({ languages: ['en', 'de'] })
  const by = Object.fromEntries(r.languages[0].metrics.map(m => [m.key, m]))
  assert.equal(by.matchers.missing, 0, 'both stats do have a matcher')
  assert.equal(by.advanced.base, 2)
  assert.equal(by.advanced.missing, 1)
  assert.equal(by.advanced.warn, true)
})

test('a configured language with no data set at all is the loudest state', async () => {
  const skew = createLangSkew({ ...fixture({ en: bulk(10) }) })
  const r = await skew.compute({ languages: ['en', 'de'] })
  assert.equal(r.languages[0].present, false)
  assert.equal(r.languages[0].warn, true)
  assert.equal(r.warn, true)
  assert.deepEqual(r.languages[0].metrics, [], 'nothing to measure, so nothing is claimed')
})

test('an unreadable base set says so instead of reporting "all fine"', async () => {
  const skew = createLangSkew({ ...fixture({ de: bulk(10) }) })
  const r = await skew.compute({ languages: ['en', 'de'] })
  assert.equal(r.basePresent, false)
  assert.equal(r.warn, true)
})

// Zero by construction: the localized set is built as a copy of the English
// skeleton, so anything only IT has means the generator left its own design.
test('refs that exist only in the localized set warn regardless of the threshold', async () => {
  const en = bulk(200)
  const de = { items: en.items, stats: [...en.stats, stat('invented stat')] }
  const skew = createLangSkew({ ...fixture({ en, de }), warnRatio: 1 })
  const r = await skew.compute({ languages: ['en', 'de'] })
  assert.equal(r.languages[0].extra, 1)
  assert.equal(r.warn, true, 'a tolerant threshold does not excuse this one')
})

test('the report is cached, and the cache can be dropped', async () => {
  let reads = 0
  const f = fixture({ en: bulk(10), de: bulk(10) })
  const skew = createLangSkew({
    resolvePath: f.resolvePath,
    readFileImpl: (...a) => { reads++; return f.readFileImpl(...a) }
  })
  await skew.compute({ languages: ['en', 'de'] })
  const first = reads
  await skew.compute({ languages: ['en', 'de'] })
  assert.equal(reads, first, 'a second look does not re-parse ~26 000 ndjson lines')
  skew.invalidate()
  await skew.compute({ languages: ['en', 'de'] })
  assert.ok(reads > first, 'until it is invalidated')
})

test('with only the base language configured there is nothing to compare', async () => {
  const r = await createLangSkew({ ...fixture({ en: bulk(10) }) }).compute({ languages: ['en'] })
  assert.deepEqual(r.languages, [])
  assert.equal(r.warn, false)
})
