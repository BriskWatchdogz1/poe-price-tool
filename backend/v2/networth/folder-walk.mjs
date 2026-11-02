// backend/v2/networth/folder-walk.mjs
// Walking ONE folder tab (Unique/Map stash), one request at a time, as a piece
// of plain data that can be put down between requests and picked back up.
//
// WHY THIS IS NOT A LOOP INSIDE THE CLIENT ANY MORE. A folder tab's items live
// in sub-folders on the newer endpoint, so reading one costs 1+N requests: 1+18
// for the unique stash, 1+30 for the map stash, and 38 in total for the map
// stash as it is measured on the production account. That was ONE step of the
// refresher — one iteration of its `busy`-guarded, strictly sequential tick —
// and since the pace between two stash requests is derived from GGG's published
// limits rather than from a 1.5s constant, those 38 requests are 38 spacings
// long: ~15 minutes at 24s, ~50 minutes at the 80s a stricter rule set derives.
//
// For the whole of that time NOTHING ELSE HAPPENED. Not another tab, and — this
// is the part that made it a complaint rather than a curiosity — not another
// USER: the `busy` flag is global and the round-robin only advances once a step
// returns, so on a deployment with several configured users one folder tab
// pushed a full round from hours into days.
//
// So the walk is now a state, not a stack frame. The refresher holds it between
// ticks and spends ONE request per tick on it, which is what every other step
// costs. THE REQUESTS ARE THE SAME REQUESTS — 1+N, in the same order, at the
// same derived pace — they are simply no longer all inside one turn.
//
// WHAT THIS MODULE DOES NOT DO: send anything itself, hold a client, keep a
// clock, or decide when the next request may go out. It is handed an `api` with
// exactly two methods and calls one of them once per step.
//
// THE STATE IS DELIBERATELY IN MEMORY AND NOT IN THE STORE. networth/store.mjs
// keys a user's tabs by index and persists on every `setTab`, and everything
// that reads it — the snapshot, `tabList`, the refresher's own `coverageOf` —
// treats an entry as a tab that has been READ. A half-walked folder tab written
// there would be exactly the "the Maps tab holds 0 items" of docs/bugs.md B7,
// with the difference that this time the tool would have written it itself. So
// the partial walk lives next to `st.tabs` and `st.attempts` in the refresher's
// per-user memory, with the same property those have: a restart forgets it and
// the tab is walked again from the beginning — the same 1+N requests the old
// all-in-one step would also have had to spend again. Nothing partial ever
// reaches the store; the tab is written once, complete, exactly as before.
//
// ONE THING IS NOT FETCHED, AND IT IS NOT A HOLE. When GGG's own
// `metadata.map.section` says a map-stash page is `tier<N>`, the walk steps over
// it without a request: normal maps are never priced, and those pages are most
// of the 1+N (networth/map-sections.mjs, and docs/bugs.md B19 for the version of
// this that was built on names and cost a whole tab). A skip is accounted as a
// KNOWN state — the walk chose not to ask — where an unanswered sub-tab stays
// unknown and still stops the tab from being written. It is logged on the same
// line that says how the tab was read, every time, because a skip that nobody
// can see is indistinguishable from stock that vanished.
//
// AND "PARTIAL" IS NOT ONLY "A REQUEST THREW". That was the gap: a sub-tab can
// answer HTTP 200 with a body that carries no items array at all (B7 measured
// it and could name no other way for the map stash to come back empty without a
// single error line), and such a walk finished normally and handed its SUBSET
// to the store as the whole tab. The missing part then read back as stock
// leaving the stash and, on the next turn that got a real answer, as the same
// stock arriving — docs/bugs.md B2. So `folderWalkComplete` asks the question
// the cursor cannot: did every listed sub-tab answer? A walk that cannot say yes
// throws `kind:'unread'` out of `finishFolderWalk` instead of returning what it
// has, and the tab keeps the last contents it was actually read with.

import { describeSkippedSections } from './map-sections.mjs'

/** A folder tab that has not been touched yet. `tab` is a listTabs() entry. */
export function beginFolderWalk (tab) {
  return {
    tab,
    // null until the sub-tab list has been fetched — the FIRST of the 1+N
    // requests, and the only one that is not a sub-tab.
    childIds: null,
    // How many entries that list held, including any the walk cannot address.
    // Kept apart from `childIds.length` so the yield line below reports what
    // GGG answered rather than what was usable, exactly as it always has.
    listed: 0,
    cursor: 0,
    items: [],
    // Sub-tabs the walk is DELIBERATELY not fetching — GGG's own
    // `metadata.map.section` said `tier<N>` and the skip is in force
    // (networth/map-sections.mjs). Null until the list request has returned,
    // empty for every folder tab that is not the map stash.
    skipIds: null,
    skipSections: null,
    skipped: 0,
    // Counted only to be able to SAY where the items went missing, should none
    // arrive. No item data is read and no extra request is made — these are the
    // responses the walk already has in hand.
    withItemsArray: 0,   // child answered in the expected {stash:{items:[…]}} shape
    withItems: 0,        // …and that array was not empty
    withOwnChildren: 0   // child carries children of its OWN -> a level below this one
  }
}

/** How many sub-tabs there are, or null while the list has not been fetched. */
export function folderWalkTotal (w) { return w?.childIds == null ? null : w.childIds.length }

/**
 * How many sub-tabs have been READ. 0 before the list request has returned.
 * A count, not the predicate — `folderWalkFinished` is the predicate.
 */
export function folderWalkRead (w) { return w?.childIds == null ? 0 : w.cursor }

/** Is there anything left to fetch? */
export function folderWalkFinished (w) {
  return !!w && w.childIds != null && w.cursor >= w.childIds.length
}

/**
 * Did every sub-tab of a finished walk actually ANSWER?
 *
 * "Finished" only says the cursor ran out. This says the walk holds a reading
 * for every sub-tab GGG listed, which is a different question and the one the
 * store has to be able to trust:
 *
 *   - `listed !== childIds.length` — GGG listed an entry the walk cannot
 *     address (no id). Its contents were never asked for.
 *   - `withItemsArray < childIds.length` — a sub-tab was asked and answered
 *     HTTP 200 with a body that is not `{stash:{items:[…]}}`. B7 measured
 *     exactly this and could name no other way for the map stash to come back
 *     empty without a single error line: `Array.isArray` is false, nothing is
 *     appended, nothing is logged.
 *
 * In both cases the walk's `items` are a SUBSET of the tab, and the difference
 * between "this sub-tab is empty" and "this sub-tab did not answer" is not
 * readable out of them any more once they are merged. Writing that subset as
 * the tab is what turns a silent 200 into a stash movement — see docs/bugs.md
 * B2.
 */
export function folderWalkComplete (w) {
  if (!w || w.childIds == null) return false
  if (w.listed !== w.childIds.length) return false
  // A SKIPPED SUB-TAB IS A KNOWN STATE, an unanswered one is not. That is the
  // whole difference and the reason the skip may be counted here at all: the
  // walk did not fail to learn what is in a tier page, it decided not to ask —
  // and the decision was taken on a field GGG sent, before any request went
  // out. An entry that was asked and answered with something other than an
  // items array still fails this check, exactly as before.
  return w.withItemsArray + w.skipped >= w.childIds.length
}

/**
 * stepFolderWalk(api, walk, log) -> walk
 *
 * EXACTLY ONE REQUEST, through `api`:
 *   listTabChildren(tab) -> { childIds, listed, items }
 *   fetchTabChild(tab, childId) -> { items, hasItemsArray, hasOwnChildren }
 *
 * Throws whatever the api throws, with the walk left as it was apart from the
 * child that was being read — the caller decides whether to resume or drop it.
 */
export async function stepFolderWalk (api, w, log = console) {
  if (w.childIds == null) {
    // UNCONDITIONAL opening bracket (docs/bugs.md B5), and it is logged BEFORE
    // the request for the same reason it always was: it is the line that says a
    // folder tab has started, and it has to be there even if the request that
    // follows never answers.
    log?.log?.(`[stash-client] folder tab "${w.tab.name}" (${w.tab.type}): reading sub-tabs`)
    const { childIds, listed, items, skipIds, skipSections } = await api.listTabChildren(w.tab)
    w.childIds = childIds
    w.listed = listed
    w.skipIds = Array.isArray(skipIds) ? skipIds : []
    w.skipSections = Array.isArray(skipSections) ? skipSections : []
    w.items.push(...items)
    advancePastSkips(w)
    return w
  }
  advancePastSkips(w)
  if (folderWalkFinished(w)) return w
  const childId = w.childIds[w.cursor]
  // Advanced BEFORE the request, so a child that throws is not retried forever
  // by a caller that resumes the walk. It costs at most that one sub-tab's
  // items, and the tab is walked again from the start on its next turn anyway.
  w.cursor++
  let r
  try {
    r = await api.fetchTabChild(w.tab, childId)
  } catch (e) {
    // A 429 IS NOT AN ANSWER ABOUT THIS SUB-TAB — GGG refused to look at all —
    // and it is the one error a caller resumes a walk from (refresher.mjs). So
    // the cursor goes back onto it: the resumed walk reads this sub-tab after
    // the cooldown instead of stepping over it. Without that, resuming saved
    // requests only to hand up a walk with a hole in it, which is not written
    // any more (folderWalkComplete) — i.e. keeping the walk would have bought
    // nothing at all. There is no retry loop in this: every OTHER error drops
    // the whole walk, and a sub-tab that keeps answering 429 costs exactly one
    // request per cooldown, which is the fewest anything can cost.
    if (e?.kind === 'ratelimit') w.cursor--
    throw e
  }
  if (r.hasItemsArray) {
    w.withItemsArray++
    if (r.items.length) w.withItems++
    w.items.push(...r.items)
  }
  if (r.hasOwnChildren) w.withOwnChildren++
  advancePastSkips(w)
  return w
}

/**
 * Move the cursor over every sub-tab that is not going to be fetched.
 *
 * COSTS NOTHING AND IS NOT A STEP. It runs at the end of the step that learned
 * the list and at the end of every step that fetched something, so a walk whose
 * remaining sub-tabs are all skips reports itself FINISHED right away instead
 * of spending a whole tick — 30s of the refresher's round — on discovering that
 * there is nothing left to ask for. `stepFolderWalk` therefore still sends
 * exactly one request per call, and never sends none.
 */
function advancePastSkips (w) {
  if (w.childIds == null || !w.skipIds?.length) return
  while (w.cursor < w.childIds.length && w.skipIds.includes(w.childIds[w.cursor])) {
    w.cursor++
    w.skipped++
  }
}

/**
 * The items of a FINISHED walk, plus the one line that says where they went if
 * there are none. Never call this on a walk that is still going: "0 items so
 * far" and "0 items" are different statements, and only the second one is worth
 * a warning.
 *
 * A walk that is finished but NOT COMPLETE (see folderWalkComplete) throws
 * instead of returning its subset, with `kind: 'unread'` — the same shape every
 * other "this tab could not be read" travels in, so every caller already knows
 * what to do with it: keep the tab's stored contents, write nothing, come back
 * on a later turn. This is the one place the decision can live, because both
 * drivers of a walk end up here — the refresher's one-sub-tab-per-tick loop and
 * `walkFolderTab` — and B5's promise is that the two behave identically.
 *
 * The `[stash-client]` prefix is deliberate even though the refresher is what
 * calls this now: the line is about the stash read, docs/admin.md documents it
 * under that name, and a walk driven tick by tick must not produce a different
 * line from one driven in a loop.
 */
export function finishFolderWalk (w, log = console) {
  if (!folderWalkComplete(w)) {
    const addressable = w.childIds ? w.childIds.length : 0
    const unaddressable = Math.max(0, w.listed - addressable)
    const silent = Math.max(0, addressable - w.withItemsArray)
    log?.warn?.(`[stash-client] folder tab "${w.tab.name}" (${w.tab.type}) was NOT read in full — ` +
      `${w.listed} sub-tabs, ${w.withItemsArray} answered with an items array, ` +
      `${w.withItems} of those non-empty, ${w.withOwnChildren} carry children of their own, ` +
      `${w.skipped} deliberately not read; ` +
      `${silent} answered with something else and ${unaddressable} could not be addressed at all. ` +
      'Nothing is written: a sub-tab that did not answer is UNKNOWN, not empty, and storing it as empty ' +
      'reads back as that part of the tab leaving the stash (docs/bugs.md B2)')
    throw Object.assign(
      new Error(`folder tab "${w.tab.name}" was not read in full: ` +
        `${silent + unaddressable} of ${w.listed} sub-tabs did not answer`),
      { kind: 'unread' })
  }
  if (w.items.length === 0) {
    // UNCONDITIONAL yield line (docs/bugs.md B7). Failure was always logged,
    // success only under POE_NETWORTH_DEBUG — so a folder tab that read empty
    // WITHOUT throwing left no trace at all, and "0 items" on the page could not
    // be told apart from "never fetched". The sub-tab count is the number that
    // decides it: 0 sub-tabs means the child list is the problem, N>0 with
    // nothing usable means the items sit somewhere this walk does not look.
    log?.warn?.(`[stash-client] folder tab "${w.tab.name}" (${w.tab.type}) yielded 0 items — ` +
      `${w.listed} sub-tabs, ${w.withItemsArray} answered with an items array, ` +
      `${w.withItems} of those non-empty, ${w.withOwnChildren} carry children of their own, ` +
      `${w.skipped} deliberately not read`)
  } else if (process.env.POE_NETWORTH_DEBUG === '1') {
    log?.log?.(`[stash-client] folder tab "${w.tab.name}": ${w.listed} sub-tabs, ${w.items.length} items`)
  }
  // UNCONDITIONAL, and separate from everything above: this is the one line
  // that says value was left out of the tab on purpose. It has to be readable
  // in a normal log — an operator comparing the net worth against the game must
  // be able to find out why the maps are missing without turning a debug flag
  // on first — and it names the way back.
  if (w.skipped > 0) {
    log?.log?.(`[stash-client] folder tab "${w.tab.name}": ${w.skipped} of ${w.listed} sub-tabs not read — ` +
      `GGG lists them as ${describeSkippedSections(w.skipSections)}, i.e. pages of normal maps, which carry no price. ` +
      `That saves ${w.skipped} of the ${w.listed + 1} requests this tab costs. ` +
      'POE_NETWORTH_SKIP_TIER_MAPS=0 reads them too.')
  }
  return w.items
}

/**
 * The whole walk in one call, for callers that have no ticks to spread it over
 * (the one-shot scan, and `fetchTab` on the client). Same requests, same order,
 * same lines — the only difference is who owns the pauses in between.
 */
export async function walkFolderTab (api, tab, log = console) {
  const w = beginFolderWalk(tab)
  while (!folderWalkFinished(w)) await stepFolderWalk(api, w, log)
  return finishFolderWalk(w, log)
}
