// What the tool could NOT do, kept where somebody can look at it. The premise
// of the German rollout (design doc, section 6): the second user is not
// technical and will never report a bug; an item that comes back wrong or not
// at all makes him stop using the tool, quietly. So the backend records its own
// gaps, in a shape that survives being looked at once a week.
//
// Two kinds, both from the price-check path (server.mjs):
//   parse         the engine refused the clipboard text outright. No card
//                 reaches the browser; an empty Price Check page only says
//                 the last item could not be read (`daemon-status`), and the
//                 player's daemon journal has one line for it, neither says
//                 which text it was.
//   unknownMod    the item parsed, but a mod line stayed unresolved — neither
//                 the vendored stat DB nor GGG's stat catalogue knew it. The
//                 card shows it read-only and the search silently ignores it,
//                 the more dangerous of the two: the price is that of a
//                 different item.
//
// AGGREGATION, NOT A JOURNAL: every record folds into a counted entry keyed by
// language + kind + a stable signature of the text (the same broken mod line
// seen 200 times is one row with count 200), sorted by frequency. MEMORY, three
// configurable bounds: the stored text is trimmed, whitespace-collapsed and
// truncated; the entries per kind are capped; over the cap the LEAST frequent
// entry is evicted (oldest wins the tie). Evictions are counted and reported,
// so a truncated list never pretends to be complete. NOT PERSISTED, by design:
// the log lives in memory and starts empty after a restart; a gap that matters
// recurs at the next price check of that item, and the data is diagnostic,
// never authoritative.

// The two kinds, as they appear in the API and in the UI grouping.
export const GAP_PARSE = 'parse'
export const GAP_UNKNOWN_MOD = 'unknownMod'
export const GAP_KINDS = [GAP_PARSE, GAP_UNKNOWN_MOD]

export const DEFAULT_MAX_ENTRIES_PER_KIND = 200
export const DEFAULT_MAX_TEXT_LENGTH = 400

// One line of the clipboard text, cleaned up for display: no control chars, no
// runs of whitespace, no unbounded length. Everything that goes into an entry
// passes through here — the input is, after all, whatever was in a clipboard.
function clean (raw, maxLength) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim()
  return s.length > maxLength ? s.slice(0, maxLength - 1) + '…' : s
}

// The signature a parse failure is counted under. The full item text is NOT the
// key: two rare boots that both fail differ in every roll, so keying on them
// would produce one row per item and defeat the aggregation. The first line is
// the item class header ("Item Class: Boots" / "Gegenstandsklasse: Stiefel"),
// which together with the error message names the failure CLASS. The full text
// still travels along as `sample` so the operator can reproduce it.
function parseSignature (text) {
  const first = String(text == null ? '' : text).split('\n').find(l => l.trim())
  return first ? first.trim() : ''
}

/**
 * createGapLog({ maxEntriesPerKind, maxTextLength, now })
 *
 *   recordParseFailure({ lang, text, reason })
 *   recordUnknownMod({ lang, text })
 *   snapshot()  -> { kinds: { parse: {...}, unknownMod: {...} }, languages: [...] }
 *   clear()
 *
 * `snapshot()` is the shape the admin endpoint hands out: per kind, the
 * languages that produced entries, each with its entries already sorted by
 * frequency (descending, most recent first on a tie). Sorting here rather than
 * in the browser keeps the two consumers — endpoint and test — reading the same
 * order.
 */
export function createGapLog ({
  maxEntriesPerKind = DEFAULT_MAX_ENTRIES_PER_KIND,
  maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
  now = () => Date.now()
} = {}) {
  const cap = Math.max(1, Number(maxEntriesPerKind) || DEFAULT_MAX_ENTRIES_PER_KIND)
  const textMax = Math.max(20, Number(maxTextLength) || DEFAULT_MAX_TEXT_LENGTH)

  // kind -> Map(key -> entry). One Map per kind so the cap is per kind: a flood
  // of unknown mods must not push the parse failures out of the list.
  const byKind = new Map(GAP_KINDS.map(k => [k, new Map()]))
  const dropped = new Map(GAP_KINDS.map(k => [k, 0]))

  function evictIfNeeded (kind) {
    const entries = byKind.get(kind)
    while (entries.size > cap) {
      // Least frequent first; among equals the one not seen for longest. That
      // keeps the recurring gap — the one worth fixing — and sheds the noise.
      let worstKey = null
      let worst = null
      for (const [k, e] of entries) {
        if (!worst || e.count < worst.count || (e.count === worst.count && e.lastAt < worst.lastAt)) {
          worst = e; worstKey = k
        }
      }
      entries.delete(worstKey)
      dropped.set(kind, dropped.get(kind) + 1)
    }
  }

  function record (kind, { lang, signature, text, reason }) {
    const l = String(lang || '').trim() || 'unknown'
    const sig = clean(signature, textMax)
    const sample = clean(text, textMax)
    const why = clean(reason, textMax)
    // The reason is part of the key: the same item class failing for two
    // different causes is two gaps, not one row that flip-flops its message.
    const key = `${l}\u0000${sig}\u0000${why}`
    const entries = byKind.get(kind)
    const at = now()
    const found = entries.get(key)
    if (found) {
      found.count++
      found.lastAt = at
      found.sample = sample || found.sample
      return found
    }
    const entry = { kind, lang: l, text: sig, reason: why, sample, count: 1, firstAt: at, lastAt: at }
    entries.set(key, entry)
    evictIfNeeded(kind)
    return entry
  }

  return {
    // The engine refused the text. `reason` is the error message; it is part of
    // the identity of the gap, see record().
    recordParseFailure ({ lang, text, reason }) {
      return record(GAP_PARSE, { lang, signature: parseSignature(text), text, reason })
    },

    // A mod line nothing could resolve. Here the text IS the signature — mod
    // lines are short and repeat verbatim across items, which is exactly the
    // aggregation this list wants.
    recordUnknownMod ({ lang, text }) {
      return record(GAP_UNKNOWN_MOD, { lang, signature: text, text, reason: '' })
    },

    snapshot () {
      const kinds = {}
      const languages = new Set()
      for (const kind of GAP_KINDS) {
        const groups = new Map()
        for (const e of byKind.get(kind).values()) {
          languages.add(e.lang)
          if (!groups.has(e.lang)) groups.set(e.lang, [])
          groups.get(e.lang).push({ ...e })
        }
        for (const list of groups.values()) {
          list.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
        }
        kinds[kind] = {
          dropped: dropped.get(kind),
          // Languages in a fixed order too, so the page never reshuffles its
          // sections between two loads.
          languages: [...groups.keys()].sort().map(lang => ({ lang, entries: groups.get(lang) }))
        }
      }
      return { kinds, languages: [...languages].sort() }
    },

    size (kind) { return kind ? byKind.get(kind).size : GAP_KINDS.reduce((n, k) => n + byKind.get(k).size, 0) },

    clear () {
      for (const kind of GAP_KINDS) { byKind.get(kind).clear(); dropped.set(kind, 0) }
    }
  }
}
