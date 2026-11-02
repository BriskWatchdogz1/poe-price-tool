// backend/v2/networth/map-sections.mjs
// WHICH SECTION OF THE MAP STASH A SUB-TAB BELONGS TO — read off the field GGG
// sends, not guessed from a name.
//
// ---------------------------------------------------------------------------
// THIS IS THE ANSWER TO THE QUESTION subtab-shape.mjs WAS SHIPPED TO ASK
// ---------------------------------------------------------------------------
// The map stash costs 1+N requests and N is ~43 on the production account, so
// the per-tier pages — which hold normal maps, which are never priced — are the
// bulk of the cost for none of the value. A rule that passed over them existed
// once (`subtab-skip.mjs`, 2026-08-13) and was reverted the same day: it
// identified a tier page by its NAME, and the names turned out to be `"1"` and
// `"2"` — PAGE NUMBERS. The pattern matched every child, `Unique Maps` and
// `Special Maps` went with them, and the net worth lost what sits in those.
// docs/bugs.md B19.
//
// The observation line that shipped alongside the revert asked whether the
// response says which SECTION a child belongs to. It answered itself on
// 2026-08-19, out of the production account's own `metadata`:
//
//   "1" type=MapStash metadata={"items":70,"map":{"section":"tier16", …}}
//   "1" type=MapStash metadata={"items":16,"map":{"section":"unique",  …}}
//   "1" type=MapStash metadata={"items":28,"map":{"section":"special", …}}
//
// `metadata.map.section` is GGG's own label for the page, it is in the parent
// response that the walk already has in hand, and it costs no request. Three
// values appeared across 43 children: `unique`, `special`, and `tier<N>` for
// every tier that had a page.
//
// ---------------------------------------------------------------------------
// WHY THIS ONE MAY DECIDE SOMETHING WHERE THE NAME RULE MAY NOT
// ---------------------------------------------------------------------------
// Not because the evidence is better — although it is — but because THE
// DIRECTION OF THE FAILURE IS THE OPPOSITE ONE. B19's rule was built as "does
// this look like a tier page?", so anything the pattern did not understand was
// skipped, and a wrong guess cost a whole tab. This one is built as "did GGG
// say `tier<N>`?", so anything NOT understood is READ: a missing `metadata`, a
// section spelled differently, a page type that does not exist yet, an account
// whose stash answers in some shape nobody here has seen — all of them fall
// through to the sub-tab being fetched exactly as it is today. The worst a
// misreading can do is cost requests, which is the thing it was trying to save.
//
// That is also why the test file asserts the fall-through cases one by one, and
// why `isTierMapChild` takes the CHILD rather than a section string: the fact
// that the field may be absent is part of what it has to decide.
//
// ---------------------------------------------------------------------------
// AND IT IS NOT SILENT, WHICH WAS THE OTHER HALF OF THE OBJECTION
// ---------------------------------------------------------------------------
// A switch whose ON quietly removes value from the net worth is a trap. So the
// walk logs what it passed over and which sections they were, every time, on
// the same line that says how the folder tab was read (networth/folder-walk.mjs
// -> `finishFolderWalk`), and `POE_NETWORTH_SKIP_TIER_MAPS=0` reads the whole
// stash again. Normal maps are unpriced stock either way — skipping them moves
// them out of the "unpriced" list, it does not move a priced number.

/** GGG's section label for a map-stash page, e.g. `tier16` / `unique`. */
export const TIER_SECTION_RE = /^tier\d+$/i

/** The section a folder child says it is, or null if it does not say. */
export function childMapSection (child) {
  const s = child?.metadata?.map?.section
  return typeof s === 'string' && s ? s : null
}

/**
 * Is this child a per-tier page of the map stash?
 *
 * ONLY an explicit `tier<N>` is one. Everything else — `unique`, `special`, a
 * section nobody has seen, no metadata at all — is not, and is therefore read.
 */
export function isTierMapChild (child) {
  const s = childMapSection(child)
  return s != null && TIER_SECTION_RE.test(s)
}

// `0`/`false`/`no`/`off` switch it off; anything else, including unset, leaves
// it on. The admin UI normalizes to `1`/`0` (config-overrides.mjs), but a
// compose file written by hand may say `false`, and that has to mean what it
// says rather than being truthy because it is a non-empty string.
const OFF = new Set(['0', 'false', 'no', 'off'])

/** Is the tier-page skip in force? Read at call time — the setting is live. */
export function skipTierMapsEnabled (env = process.env) {
  const v = env.POE_NETWORTH_SKIP_TIER_MAPS
  return v == null || !OFF.has(String(v).trim().toLowerCase())
}

/**
 * planFolderChildren(tab, children, env) -> { childIds, skipIds, skipSections }
 *
 * `childIds` stays what it always was: every child that can be ADDRESSED, in
 * GGG's order, tier pages included. The skip is a separate set laid over it, so
 * that `folderWalkComplete` keeps comparing like with like — a walk still has to
 * account for every listed sub-tab, it may just account for some of them as
 * "deliberately not read" instead of "answered".
 *
 * `skipSections` is for the log line only: `[[section, count], …]`, so the line
 * can say WHAT was passed over rather than just how many.
 *
 * AN ARRAY AND PAIRS, NOT A SET AND A MAP, and that is not a style choice. Both
 * of these end up inside the walk state, and the walk state has to survive
 * `JSON.parse(JSON.stringify(w))` — folder-walk.test.mjs asserts it, because the
 * refresher carries that state from one tick's client to the next tick's freshly
 * built one and nothing in it may be a live object. A `Set` round-trips through
 * JSON as `{}`, i.e. as a skip list that silently forgets everything in it. With
 * at most a few dozen children, `includes` costs nothing worth having that back.
 */
export function planFolderChildren (tab, children, env = process.env) {
  const list = Array.isArray(children) ? children : []
  const childIds = list.filter(c => c?.id).map(c => c.id)
  const skipIds = []
  const counts = new Map()
  // Only the map stash has tier pages. The unique stash's children are item
  // classes and every one of them holds priced stock.
  if (tab?.type === 'MapStash' && skipTierMapsEnabled(env)) {
    for (const c of list) {
      if (!c?.id || !isTierMapChild(c)) continue
      skipIds.push(c.id)
      const sec = childMapSection(c)
      counts.set(sec, (counts.get(sec) || 0) + 1)
    }
  }
  return { childIds, skipIds, skipSections: [...counts] }
}

/** `tier16 x2, tier15, tier13` — the sections, most pages first, for a log line. */
export function describeSkippedSections (skipSections) {
  return [...(skipSections || [])]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([sec, n]) => (n > 1 ? `${sec} x${n}` : sec))
    .join(', ')
}
