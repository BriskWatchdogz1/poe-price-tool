// Stash highlight generator: turns "these are the items I want to see" into a
// search string for Path of Exile's stash search field (regex, capped at 250
// characters). Format follows the Path-of-Regex style: ONE quoted keyword with
// the alternatives chained inside via |, e.g. "egr|tev|efl"; unquoted, the game
// would split it at the spaces into several keywords. The core is the
// SHORTENING: for every wanted name, the shortest fragment in NO unwanted name.
//
// IMPORTANT — the exclusion set is ALL item names the game knows
// (renderer/public/data/<lang>/items.ndjson, via GET /item-names), never the
// player's own holdings. Items come in families with shared suffixes ("...
// Scarab of Discernment" exists for Ambush, Breach, Harbinger and others): a
// "dis" checked against your own stash alone looks unambiguous and lit up ~14
// slots instead of 9 in game (networth.js, "Stash-Highlight"). Longer
// fragments are the point.
//
// LANGUAGE: wanted and unwanted must be in ONE language, the one the game
// client prints, because the game matches what it prints (B10). The generator
// only shortens what it is handed against what it is handed; the caller owns
// that contract.
//
// SECOND UNIVERSE, THE ONE WE DO NOT HAVE (B21): the stash search reads the
// WHOLE item text, flavour text included. Nine divination cards produced
//   "awr|ne be|mono|ial l|tuna|rker |oml|yos|some"
// and lit up twelve slots: "some" is unique among the ~4700 NAMES but sits in
// the flavour text of Boon of Justice, Demigod's Wager, Disdain, Forbidden
// Power, The Aesthete and The Body — the "14 slots instead of 9" failure one
// level down. Nothing here has or can look up a flavour text (no data file or
// endpoint maps a name to one; the daemon sees only the one pasted item, which
// never reaches this page). So the guard below only refuses fragments LIKELY
// to collide and lets what it does not know pass: a reduction of the risk, not
// a guarantee, and no test in this repository can make it one. It costs
// characters, so fewer items per field — fewer cards per pass beats a field
// that lights up half the stash.

export const HIGHLIGHT_MAX_DEFAULT = 250
const MIN_TOKEN = 2

// The word list, and how it was put together — because a hand-written list of
// "common English words" is otherwise a guessed number in list form.
//
// There is no usable text corpus in this repository. Everything English that
// ships here was checked: `renderer/public/data/en/items.ndjson` holds names
// only (no flavour text, no description field), `stats.ndjson` is modifier
// text — it does not contain the word "some" at all — and `app_i18n.json`,
// `client_strings.js` and `frontend/i18n.js` are UI vocabulary mixed with keys
// and German. None of them says anything about the language a card's flavour
// text is written in. So the list is written by hand, from two criteria that
// can be stated:
//
//  (a) the CLOSED-CLASS words of English — articles, pronouns, demonstratives,
//      prepositions, conjunctions, auxiliaries and modals, quantifiers,
//      question words. Closed class means the set does not grow with the
//      language, so this half can be nearly complete, and it is where the
//      short dangerous fragments live ("the", "one", "ver" in "over/every").
//  (b) every word of the six flavour texts in the collision that was actually
//      MEASURED (B21) — including the rarer ones (obligations, opportunities,
//      limitation), because "measured" is a criterion and "feels common" is
//      not.
//
// What it does NOT cover, and no comment should pretend otherwise: every
// everyday word nobody has written down here yet. "fortunate" is not in it, so
// "tuna" (from The Fortunate) still passes and would light up any card whose
// flavour text says "fortunate". The list is English only, so for a German
// client it guards against the wrong language entirely — the same open
// question as B10. Additions are welcome and belong here, one measured
// collision at a time.
const EVERYDAY_WORDS = Object.freeze([
  // (a) closed class
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'along', 'also', 'am',
  'among', 'an', 'and', 'another', 'any', 'anyone', 'anything', 'are', 'around', 'as',
  'at', 'away', 'be', 'because', 'been', 'before', 'behind', 'being', 'below', 'beneath',
  'beside', 'besides', 'between', 'beyond', 'both', 'but', 'by', 'can', 'cannot', 'could',
  'did', 'do', 'does', 'doing', 'done', 'down', 'during', 'each', 'either', 'else',
  'enough', 'even', 'ever', 'every', 'everyone', 'everything', 'few', 'for', 'from', 'had',
  'has', 'have', 'having', 'he', 'her', 'hers', 'herself', 'him', 'himself', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just',
  'many', 'may', 'me', 'might', 'mine', 'more', 'most', 'much', 'must', 'my',
  'myself', 'near', 'neither', 'never', 'no', 'none', 'nor', 'not', 'nothing', 'now',
  'of', 'off', 'on', 'once', 'one', 'only', 'onto', 'or', 'other', 'others',
  'our', 'ours', 'out', 'over', 'own', 'perhaps', 'same', 'several', 'shall', 'she',
  'should', 'since', 'so', 'some', 'somebody', 'someone', 'something', 'sometimes', 'somewhere', 'still',
  'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
  'these', 'they', 'this', 'those', 'though', 'through', 'throughout', 'thus', 'to', 'together',
  'too', 'toward', 'towards', 'under', 'until', 'up', 'upon', 'us', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'who', 'whom',
  'whose', 'why', 'will', 'with', 'within', 'without', 'would', 'yet', 'you', 'your',
  'yours',
  // (b) the measured flavour texts (B21)
  'body', 'flesh', 'flow', 'gifts', 'great', 'lifetime', 'limitation', 'luck', 'make', 'mortal',
  'need', 'obligations', 'opportunities', 'point', 'power', 'risk', 'see', 'simply', 'things', 'used'
])

/**
 * Is this fragment an everyday English word, or a piece of one?
 *
 * The rule the operator chose, and it is the conservative one: refuse, and let
 * the fragment grow. It answers "does this LOOK like prose", never "is this
 * free of collisions" — see the note above the list. A fragment containing a
 * space is never refused here, because the list holds single words: "ne be"
 * would sit across a word boundary ("gone before"), and this check does not
 * see word boundaries.
 */
function looksEveryday (sub) {
  return EVERYDAY_WORDS.some(w => w.includes(sub))
}

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
//
// `probe`, if given, is filled with `lengthened: true` when a SHORTER fragment
// would have separated this name from every other name and was refused only
// because it looks like everyday English. That is the difference between "the
// name list forced this length" and "the word guard did", and the page says so
// rather than letting the reader guess why less fits than before.
function shortestTokenIn (hay, forbiddenNorm, probe = null) {
  const others = forbiddenNorm.filter(o => o !== hay)
  const collides = sub => others.some(o => o.includes(sub))
  let refused = false
  for (let len = MIN_TOKEN; len <= hay.length; len++) {
    for (let start = 0; start + len <= hay.length; start++) {
      const sub = hay.slice(start, start + len)
      if (REGEX_SPECIAL.test(sub)) continue
      if (collides(sub)) continue
      // The whole name is exempt: it is the most precise thing that exists for
      // this item, and refusing it would leave nothing at all. Better one long
      // entry than a wrong one.
      if (sub !== hay && looksEveryday(sub)) { refused = true; continue }
      if (probe) probe.lengthened = refused
      return sub
    }
  }
  return null
}

/**
 * The two lists buildHighlight needs, both in the GAME CLIENT's language.
 *
 * `table` is the answer of GET /item-names — `{ names, byRef }`, where `names`
 * holds the spellings that need no translation and `byRef` maps an English
 * reference name to the spelling the client prints. `null` (not loaded, old
 * container, request failed) means one thing only: everything stays English on
 * BOTH sides. That is the whole point of doing this in one function — a wanted
 * list in one language and a universe in another produces fragments that are
 * unambiguous in a universe nobody is searching.
 *
 * `refs` are the English names of the rows the user wants highlighted, in
 * priority order; `extraRefs` are English names the snapshot carries that the
 * data set may not know (labels for unidentified uniques, bases newer than the
 * data). Unknown names pass through untranslated — a client prints those in
 * English too, so that is the right answer and not a fallback.
 */
export function highlightInputs ({ refs = [], extraRefs = [], table = null } = {}) {
  const gameName = ref => (table && table.byRef && table.byRef[ref]) || ref
  const wanted = [...refs].map(gameName)
  const wantedSet = new Set(wanted.map(norm))
  const universe = new Set(table ? [...table.names, ...Object.values(table.byRef || {})] : [])
  for (const ref of extraRefs) universe.add(gameName(ref))
  return { wanted, unwanted: [...universe].filter(n => n && !wantedSet.has(norm(n))) }
}

/**
 * buildHighlight(wanted, unwanted, { maxLen }) ->
 *   { text, entries, used, dropped, overmatching, lengthened, length, maxLen }
 *
 * `lengthened` names the entries whose fragment had to grow past the shortest
 * one the NAME list would have allowed, because that shorter one is everyday
 * English (B21). It is what makes the drop count readable: fewer items in the
 * field is the price of the guard, and this says how many fragments paid it.
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
  const lengthened = []
  for (const name of names) {
    // If a fragment already handed out covers this name as well, it comes
    // along for free — no second fragment for the same list of hits.
    const cover = chosen.find(tok => norm(name).includes(tok))
    if (cover) { entries.push({ name, token: null, free: true, coveredBy: cover }); continue }
    const probe = {}
    let token = shortestTokenIn(norm(name), forbidden, probe)
    if (probe.lengthened) lengthened.push(name)
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
  // `lengthened` counts fragments, not entries in the field: a name whose
  // fragment grew and then did not fit is in `dropped` AND here, which is
  // exactly the connection the page draws.
  return { text, entries, tokens, used, dropped, overmatching, lengthened, length: text.length, maxLen }
}
