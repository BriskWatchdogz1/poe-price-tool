// The localized -> English bridge that makes the unknown-mod repair path work
// in a language that is not English (design doc, section 5).
//
// WHAT IS BROKEN WITHOUT IT. A mod the bundled APT stat DB cannot map lands in
// item.unknownModifiers, and trade-stats.mjs rescues it against GGG's own
// /api/trade/data/stats — that catalogue is what bridges a stat DB lagging
// behind a league patch. The catalogue is ENGLISH and a localized parse hands
// over a German line, so on German that path could never fire. Which is
// backwards: a freshly generated German set has MORE gaps than the matured
// English one, not fewer.
//
// WHY NOT THROUGH THE GERMAN DATA SET. "Look the German line up in the German
// set to get its English ref" is circular: `unknownModifiers` are by definition
// the lines that set does NOT know. And because the German set is derived from
// the English skeleton (lang-derive.mjs), the two `ref` sets are identical —
// the case "German knows it, English does not" does not exist.
//
// SO THE BRIDGE GOES AROUND THE DATA SET, through text-pairs.ndjson: the
// generator's by-product over EVERY German description block of the CURRENT
// patch, not just the ones that made it into the APT skeleton (buildTextPairs
// in lang-derive.mjs). That skew — game data from this patch, skeleton possibly
// from the previous one — is exactly the case the catalogue path exists for.
//
// AMBIGUITY IS REJECTED, NEVER RESOLVED. A normalized German line that maps to
// more than one English text resolves to nothing: the mod stays read-only on
// the card (frontend/app.js, `searchable === false`) and is counted in the gap
// view. Guessing here would produce a confident wrong price, and this project
// treats falsely priced as worse than unpriced.
//
// MEMORY AND FRESHNESS. The German table is ~20k lines / ~3 MB of text, which is
// why it is read LAZILY, per language, on the first unresolved mod line — on an
// English-only installation it is never read at all. The parsed table is then
// kept for as long as the snapshot lives; reload() drops it, and the server
// calls that from onAptData, so a new generator run is picked up together with
// the data set it belongs to (never one without the other).

import { readFile } from 'node:fs/promises'

/** Written by lang-data-gen.mjs into data/<lang>/, carried forward by the
 *  refresher with the rest of the localized tree (LANG_EXTRA_FILES). */
export const TEXT_PAIRS_FILE = 'text-pairs.ndjson'

// A rolled mod line, brought into the form the pair table is keyed by. The
// generator keys it with matchKey() (lang-statdesc.mjs): the description's
// placeholders are already `#` there, and a literal sign belongs to the
// placeholder it sits in front of — `{0:+d}` renders to `#`, not to `+#`. So
// the mask has to swallow the sign too, exactly as byNumeric does in
// lang-derive.mjs. Whitespace is collapsed for the same reason it is there:
// where a line break sits does not survive translation.
const ROLL = /[+-]?\d+(?:\.\d+)?/g
export function modTextKey (text) {
  return String(text ?? '').replace(ROLL, '#').replace(/\s+/g, ' ').trim()
}

/**
 * text-pairs.ndjson -> Map<localized key, English text | null>.
 *
 * `null` means AMBIGUOUS and is a value, not an absence: the generator already
 * writes every English candidate of a key into one line (`en: [...]`), and two
 * lines sharing a key that disagree are folded the same way. Both come back as
 * "no answer" from the bridge — the caller must not be able to tell them apart
 * and act on it.
 */
export function parseTextPairs (raw) {
  const map = new Map()
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (typeof e?.t !== 'string' || !e.t) continue
    if (!Array.isArray(e.en)) continue
    const value = e.en.length === 1 && typeof e.en[0] === 'string' && e.en[0] ? e.en[0] : null
    if (map.has(e.t)) { if (map.get(e.t) !== value) map.set(e.t, null); continue }
    map.set(e.t, value)
  }
  return map
}

/**
 * createModTextBridge({ resolvePath, read, log })
 *
 *   toEnglish(text, lang) -> Promise<string|null>   null = unknown OR ambiguous
 *   reload()                                        drop every cached table
 *   size(lang)            -> Promise<number>        entries currently held
 *
 * `resolvePath(lang)` names the file inside the ACTIVE snapshot, so the table
 * and the data set the engine parses with always come from the same place.
 * A missing file is not an error: the localized set is generated locally and
 * simply does not exist until the first generator run.
 */
export function createModTextBridge ({
  resolvePath,
  read = path => readFile(path, 'utf8'),
  log = console
} = {}) {
  if (typeof resolvePath !== 'function') throw new Error('createModTextBridge: resolvePath is required')

  // lang -> Promise<Map>. The PROMISE is cached, not the map: two unknown mods
  // arriving together must not read and parse a 3 MB file twice.
  const tables = new Map()

  async function load (lang) {
    const path = resolvePath(lang)
    let raw
    try {
      raw = await read(path)
    } catch (e) {
      log.warn?.(`[mod-text] no ${TEXT_PAIRS_FILE} for language "${lang}" (${e?.message || e}) — unresolved mods of that language stay unresolved`)
      return new Map()
    }
    const map = parseTextPairs(raw)
    log.log?.(`[mod-text] ${lang}: ${map.size} text pairs loaded for the unknown-mod repair path`)
    return map
  }

  function tableFor (lang) {
    let p = tables.get(lang)
    if (!p) tables.set(lang, p = load(lang))
    return p
  }

  return {
    async toEnglish (text, lang) {
      const table = await tableFor(lang)
      // `?? null` folds "not in the table" and "ambiguous" into one answer on
      // purpose — see parseTextPairs.
      return table.get(modTextKey(text)) ?? null
    },
    reload () { tables.clear() },
    async size (lang) { return (await tableFor(lang)).size }
  }
}
