// Stash highlight generator: turns "these are the items I want to see" into a
// search string for Path of Exile's stash search field.
//
// The search field understands regex (the in-game tips say so) and is capped
// at 250 characters. Output format follows the established Path-of-Regex
// style: ONE quoted keyword with the alternatives chained inside it via | —
//   "egr|tev|efl"
// Without the quotes the game would split at the spaces into several keywords;
// quoted, it stays a single expression.
//
// The core is not the chaining, it is the SHORTENING: for every wanted name we
// look for the shortest fragment that occurs in NO unwanted name.
//
// IMPORTANT — what the exclusion set MUST be built from:
// not from the player's own holdings (snapshot/stash), but from ALL item names
// the game knows. PoE items come in families with shared suffixes: "... Scarab
// of Discernment" exists for Ambush, Breach, Harbinger and others. A "dis"
// checked against your own stash alone looks unambiguous there and still
// lights up half the tab in game, because the foreign variants appear in no
// ownership-based list — no matter how complete you make the snapshot.
// Source of truth: renderer/public/data/en/items.ndjson, reached from the
// frontend via GET /item-names. That makes the fragments longer — which is
// exactly the point.

export const HIGHLIGHT_MAX_DEFAULT = 250
const MIN_TOKEN = 2

// Characters that mean something inside a regex. A fragment containing one of
// them is not used — better one character longer and harmless than an
// expression that does something different in game than it does here.
const REGEX_SPECIAL = /[.*+?()[\]{}|^$\\"]/

const norm = s => String(s ?? '').toLowerCase()

/**
 * Shortest substring of `name` that occurs in none of the `forbidden` names.
 * On equal length the leftmost one wins (deterministic, and usually the most
 * readable). null = there is none: the name sits whole inside an unwanted name
 * ("Beyond Scarab" in "Beyond Scarab of Resurgence") — then no search string
 * can separate the two.
 */
export function shortestToken (name, forbidden) {
  return shortestTokenIn(norm(name), [...forbidden].map(norm))
}

// Like shortestToken, but with an ALREADY normalized exclusion list — the
// exclusion set is by now the complete item name list (~4700 entries);
// normalizing it once per buildHighlight instead of once per name saves the
// lion's share of the work.
function shortestTokenIn (hay, forbiddenNorm) {
  const others = forbiddenNorm.filter(o => o !== hay)
  const collides = sub => others.some(o => o.includes(sub))
  for (let len = MIN_TOKEN; len <= hay.length; len++) {
    for (let start = 0; start + len <= hay.length; start++) {
      const sub = hay.slice(start, start + len)
      if (REGEX_SPECIAL.test(sub)) continue
      if (!collides(sub)) return sub
    }
  }
  return null
}

/**
 * buildHighlight(wanted, unwanted, { maxLen }) ->
 *   { text, entries, used, dropped, overmatching, length, maxLen }
 *
 * `wanted` is an ALREADY SORTED name list (most important first) — when space
 * runs short the trailing ones fall out, and whatever falls out is reported
 * instead of silently swallowed.
 */
export function buildHighlight (wanted, unwanted, { maxLen = HIGHLIGHT_MAX_DEFAULT } = {}) {
  const seen = new Set()
  const names = []
  for (const n of wanted) { const k = norm(n); if (k && !seen.has(k)) { seen.add(k); names.push(n) } }
  const forbidden = [...new Set([...unwanted].map(norm).filter(n => n && !seen.has(n)))]

  const entries = []
  const chosen = []          // fragments already handed out
  const overmatching = []
  for (const name of names) {
    // If a fragment already handed out covers this name as well, it comes
    // along for free — no second fragment for the same list of hits.
    const cover = chosen.find(tok => norm(name).includes(tok))
    if (cover) { entries.push({ name, token: null, free: true, coveredBy: cover }); continue }
    let token = shortestTokenIn(norm(name), forbidden)
    if (token == null) {
      // Not separable: the full name inevitably matches longer names too.
      // Say so openly instead of dragging them along in secret.
      token = norm(name)
      if (REGEX_SPECIAL.test(token)) continue
      overmatching.push(name)
    }
    chosen.push(token)
    entries.push({ name, token, free: false })
  }

  // Packing: fragment by fragment, as long as the FINISHED string (quotes
  // included) stays under the limit.
  const used = []
  const dropped = []
  const tokens = []
  const render = toks => toks.length ? `"${toks.join('|')}"` : ''
  for (const e of entries) {
    // Free entry: it only lights up if the fragment covering it actually made
    // it into the finished string.
    if (e.free) { (tokens.includes(e.coveredBy) ? used : dropped).push(e.name); continue }
    const next = [...tokens, e.token]
    if (render(next).length > maxLen) { dropped.push(e.name); continue }
    tokens.push(e.token)
    used.push(e.name)
  }
  const text = render(tokens)
  return { text, entries, tokens, used, dropped, overmatching, length: text.length, maxLen }
}
