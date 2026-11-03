// "German is running behind English" — the one question the data refresher
// cannot answer: `status()` in data-refresher.mjs reports each source by
// itself, and a source that says "checked, unchanged, fine" is fine BY ITSELF
// even while the language it feeds has drifted a patch behind English (design
// doc, section 2, Skew-Policy, which files the comparison as this module).
//
// WHAT IS COMPARED. The German set is a copy of the English skeleton with the
// display texts replaced (design doc, section 2), so English is the yardstick
// in every row: how much of it did the localized set fail to carry?
//   items      English `refName`s with no line in the localized items file.
//   stats      English stat `ref`s with no line in the localized stats file.
//   matchers   English `ref`s whose localized entry has NO matcher at all (the
//              generator's coverage check seen from outside): such a mod can
//              never be parsed out of an item text.
//   advanced   English matchers carrying an `advanced` form whose localized
//              stat has none. The extended clipboard form (Ctrl+Alt+C) is the
//              NORMAL case for the German user and reads exactly this field —
//              a gap fails silently and only on some items.
// Plus `extra`: localized refs that do not exist in English. Always zero by
// construction, so it is a regression barrier and warns from the first
// occurrence regardless of the threshold. THE THRESHOLD is a ratio against the
// English count (POE_LANG_SKEW_WARN_RATIO), since "12 missing" means something
// else in 8 000 stats than in 40. A language that is CONFIGURED but has no data
// set at all warns on its own, without a ratio.
//
// THIS VIEW DECIDES NOTHING (docs/bugs.md B23). Whether a freshly generated set
// may go live is a question about ONE RUN, answered where the run happens
// (lang-derive.mjs, validate()). Here: how far the set being served has drifted
// from English, continuously. A localized set CARRIED FORWARD past an English
// update is short of whole refs and shows under `stats`; a regenerated one
// carries every ref and shows its gap under `matchers` — the shape to expect,
// since a run with an honest source gap is adopted instead of thrown away.

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
