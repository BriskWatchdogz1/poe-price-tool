// "German is running behind English" — the one question the data refresher
// cannot answer.
//
// `status()` in data-refresher.mjs reports, per source, when that source last
// succeeded and what its last outcome was. It never puts two sources next to
// each other, and it cannot: a source that says "checked, unchanged, fine" is
// fine BY ITSELF even while the language it feeds has drifted a whole patch
// behind the English one. The design doc says so explicitly (section 2,
// Skew-Policy) and files the comparison as new work. This is that work.
//
// WHAT IS COMPARED, and why these four numbers. The German set is built as a
// copy of the English skeleton with the display texts replaced (design doc,
// section 2), so English is the yardstick in every row and the question is
// always the same: how much of it did the localized set fail to carry?
//
//   items      English `refName`s with no line in the localized items file.
//   stats      English stat `ref`s with no line in the localized stats file.
//   matchers   English `ref`s whose localized entry has NO matcher at all.
//              This is the coverage check the generator's validation runs, seen
//              from the outside: a stat without a matcher can never be parsed
//              out of an item text, so the mod is simply invisible.
//   advanced   English matchers carrying an `advanced` form whose localized
//              stat has none. The extended clipboard form (Ctrl+Alt+C) is the
//              NORMAL case for the German user, and it reads exactly this
//              field — a gap here fails silently and only on some items, which
//              is the worst failure shape this project knows.
//
// Plus one asymmetric check, `extra`: localized refs that do not exist in
// English at all. Under the copy-the-skeleton construction that number is
// always zero, so any other value means the generator left its own design —
// a regression barrier, not a gradual measure, and therefore it warns from the
// first occurrence regardless of the threshold.
//
// THE THRESHOLD is a ratio against the English count, not an absolute number:
// "12 missing" means something different in a set of 8 000 stats than in one of
// 40. It is configuration (POE_LANG_SKEW_WARN_RATIO), not a constant in here.
//
// A language that is CONFIGURED but has no data set at all is the loudest case
// and does not need a ratio: it warns on its own.
//
// THIS VIEW DOES NOT DECIDE ANYTHING, and after docs/bugs.md B23 that is worth
// saying out loud rather than leaving to be inferred. Whether a freshly
// generated set may go live is a question about ONE RUN — did it lose coverage
// the live set already had — and it is answered where the run happens
// (lang-derive.mjs, validate()). What is answered here is the other half: how
// far the set that IS being served has drifted from English, continuously, for
// as long as it stays that way. The two numbers even sit in different rows
// depending on which side is behind: a localized set that was CARRIED FORWARD
// past an English update is short of whole refs and shows up under `stats`,
// while one that was regenerated carries every ref and shows its gap under
// `matchers`. Same distance, and the second shape is the one to expect now that
// a run with an honest source gap is adopted instead of thrown away.

import { readFile } from 'node:fs/promises'

// 0.5 % of the English set. Chosen against the measured shape of the data
// rather than a round feeling: the design doc measures the Russian set, the
// closest available analogue, at 59 of 8449 stats (0.7 %) deviating in matcher
// LIST LENGTH while zero refs are missing outright. Missing refs are a
// different and much rarer failure, so a bar well under that deviation rate
// still leaves room for the handful of legitimately hard cases.
export const DEFAULT_WARN_RATIO = 0.005

export const SKEW_FILES = { items: 'items.ndjson', stats: 'stats.ndjson' }

// The ndjson files are one JSON object per line. A malformed line is skipped
// rather than fatal: this is a diagnostic view, and a half-written file must
// not turn the admin page into an error page — the resulting numbers will show
// the gap anyway.
function parseNdjson (text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* skip — counted implicitly as missing */ }
  }
  return out
}

const ratioOf = (missing, base) => (base > 0 ? missing / base : 0)

/**
 * createLangSkew({ resolvePath, warnRatio, ttlMs, readFileImpl, now })
 *
 * `resolvePath(lang, file)` -> absolute path of that language's data file;
 * in the server it is the data refresher's itemsNdjsonPath/statsNdjsonPath, so
 * the comparison always runs against the snapshot the container is REALLY
 * serving — never against a guessed one (design doc, section 2).
 *
 * compute({ languages }) -> the skew report. Cached for ttlMs: the page is
 * pull-based and a reload must not re-parse ~26 000 ndjson lines every time.
 */
export function createLangSkew ({
  resolvePath,
  warnRatio = DEFAULT_WARN_RATIO,
  ttlMs = 5 * 60 * 1000,
  readFileImpl = readFile,
  now = () => Date.now()
} = {}) {
  if (typeof resolvePath !== 'function') throw new Error('createLangSkew: resolvePath is required')
  const bar = Number.isFinite(Number(warnRatio)) && Number(warnRatio) >= 0 ? Number(warnRatio) : DEFAULT_WARN_RATIO

  let cache = null // { at, key, report }

  async function loadLang (lang) {
    const items = await readFileImpl(resolvePath(lang, SKEW_FILES.items), 'utf8').catch(() => null)
    const stats = await readFileImpl(resolvePath(lang, SKEW_FILES.stats), 'utf8').catch(() => null)
    if (items == null || stats == null) return null
    return { items: parseNdjson(items), stats: parseNdjson(stats) }
  }

  // One language against the base set. Everything in here is set arithmetic on
  // the English side — the localized set is only ever asked "do you have this".
  function compare (baseSet, langSet) {
    const langItems = new Set(langSet.items.map(i => i?.refName).filter(Boolean))
    const langStats = new Map()
    for (const s of langSet.stats) if (s?.ref) langStats.set(s.ref, s)

    let itemsMissing = 0
    const baseItems = new Set()
    for (const i of baseSet.items) {
      if (!i?.refName) continue
      baseItems.add(i.refName)
      if (!langItems.has(i.refName)) itemsMissing++
    }

    let statsMissing = 0
    let withoutMatcher = 0
    let advancedBase = 0
    let advancedMissing = 0
    for (const s of baseSet.stats) {
      if (!s?.ref) continue
      const other = langStats.get(s.ref)
      if (!other) { statsMissing++; continue }
      const mine = Array.isArray(other.matchers) ? other.matchers : []
      if (!mine.length) withoutMatcher++
      const baseHasAdvanced = (Array.isArray(s.matchers) ? s.matchers : []).some(m => m?.advanced)
      if (baseHasAdvanced) {
        advancedBase++
        if (!mine.some(m => m?.advanced)) advancedMissing++
      }
    }

    const baseStats = baseSet.stats.filter(s => s?.ref).length
    // Refs the localized set has and English does not. Zero by construction —
    // see the header comment.
    let extra = 0
    for (const ref of langStats.keys()) if (!baseSet.refSet.has(ref)) extra++
    for (const name of langItems) if (!baseItems.has(name)) extra++

    const metric = (key, base, missing) => ({
      key, base, missing, covered: base - missing, ratio: ratioOf(missing, base), warn: ratioOf(missing, base) > bar
    })

    const metrics = [
      metric('items', baseItems.size, itemsMissing),
      metric('stats', baseStats, statsMissing),
      metric('matchers', baseStats, withoutMatcher),
      metric('advanced', advancedBase, advancedMissing)
    ]
    return { metrics, extra, warn: extra > 0 || metrics.some(m => m.warn) }
  }

  async function build (languages) {
    const base = languages[0]
    const others = languages.slice(1)
    const baseSet = await loadLang(base)
    if (!baseSet) {
      // Without the yardstick there is nothing to say. Reported as such rather
      // than as "everything fine".
      return { base, warnRatio: bar, basePresent: false, warn: true, languages: [], generatedAt: now() }
    }
    baseSet.refSet = new Set(baseSet.stats.map(s => s?.ref).filter(Boolean))

    const report = []
    for (const lang of others) {
      const set = await loadLang(lang)
      if (!set) {
        // Configured, but no data on disk. The engine instance for it is down
        // too (server.mjs rejects POST /item for that language), so this is the
        // most severe state the view can show.
        report.push({ lang, present: false, warn: true, metrics: [], extra: 0 })
        continue
      }
      report.push({ lang, present: true, ...compare(baseSet, set) })
    }
    return {
      base,
      basePresent: true,
      warnRatio: bar,
      warn: report.some(l => l.warn),
      languages: report,
      generatedAt: now()
    }
  }

  return {
    warnRatio: bar,
    async compute ({ languages = [], force = false } = {}) {
      const list = [...new Set(languages.filter(Boolean))]
      if (!list.length) return { base: null, basePresent: false, warnRatio: bar, warn: false, languages: [], generatedAt: now() }
      const key = list.join(',')
      if (!force && cache && cache.key === key && now() - cache.at < ttlMs) return cache.report
      const report = await build(list)
      cache = { at: now(), key, report }
      return report
    },
    invalidate () { cache = null }
  }
}
