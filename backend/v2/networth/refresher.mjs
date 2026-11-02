// Continuous background net-worth refresher.
// Instead of the manual "scan all ~115 tabs in one burst" (which slams GGG's
// character-window endpoint into a 429), this ticks quietly: ONE step per
// interval (default ~30s), syncing the single stalest stash tab of ONE user
// into the per-tab store. That stays far under the rate limit, keeps the
// snapshot fresh, and never bursts.
//
// THE PACE IS A TOTAL, NOT A PER-USER RATE. There is one refresher, one `busy`
// flag and one step per tick; the users are walked round-robin, so a second
// configured user does not add a second request stream — it halves how often
// each of them comes round. At the 30s default that is ~2,880 steps a DAY in
// total, and with three users each tab is revisited roughly every three hours
// rather than every hour. (The header of this file used to say "per user",
// which answers the operator's question — does this scale with the number of
// users? — the wrong way round. It does not.) A step is usually one request,
// but a folder tab is 1+N inside the one step; see the OBSERVABILITY note.
//
// Strictly sequential, one request per tick, overlap-guarded (busy flag, like
// one outstanding job at a time), .unref()'d interval. The POESESSID cookie
// NEVER touches a log, a broadcast, or the store (that discipline lives in the
// injected makeClient/stash-client + valueTab).
//
// Every I/O is injected so the whole thing is unit-testable with mocks — NO
// live GGG requests in tests:
//   store        — per-tab networth store (getTab/setTab/setMeta/pruneTabs/tabList)
//   loadUsers    — async () => ({ <user>: { accountName, poesessid } })  (creds,
//                  reloaded every round -> cookie rotation without a restart)
//   makeClient   — (user, cred) => ({ client, league })  where client has
//                  listTabs()/fetchTab(index); server binds the league.
//   valueTab     — async ({ items, tab, cdRatio, league, accountName }) => tabData
//                  (server binds valuator+normalize; see scan.mjs valueTab)
//   cdRatioFor   — (user, league) => chaosPerDivine (number)
//   onTabSynced  — (user, coverage) => void  (server broadcasts the refreshed
//                  snapshot). `coverage` = { tabsCovered, tabsRead, tabsTotal,
//                  complete } and says whether the store now holds an answer for
//                  EVERY live tab, and how much of that answer is an actual
//                  reading rather than a tab that was tried and yielded nothing
//                  — see coverageOf() below.
//   isPaused     — () => false | true | { until }  (yield hook; defaults to
//                  () => false. The server wires the TRADE-API BAN GATE into
//                  it — see the note below. `{ until }` (epoch ms) lets the
//                  status line name the time the pause is expected to lift; a
//                  bare `true` pauses without one.)
//   onStatus     — (user) => void  (optional; fired whenever this user's sync
//                  status changes: auth-pause set/lifted, cooldown entered or
//                  lifted. The server uses it to broadcast the new status to
//                  the UI. A 429 fires it for EVERY known user, because a 429
//                  stops every one of them — see the note below.)
//
// A 429 STOPS THE WHOLE REFRESHER, NOT JUST THE USER WHO GOT IT. This used to
// be caution — nothing in the code could say whether GGG counted a stash
// request against the session or against the address. It is now a measurement:
// the rule names logged off the stash responses include `Ip 45/60s` and
// `Ip 180/1800s`, so part of the budget is the ADDRESS's and is shared by every
// configured user (and by everything else leaving this machine). Stopping
// everybody is therefore not the cautious reading of an unknown, it is the
// correct one. The cost is bounded and visible: statusFor reports `cooldown`
// for everyone, with `mine` saying whether this user is the one GGG refused or
// is waiting on somebody else.
//
// AND A TRADE-API BAN STOPS IT AS WELL (docs/bugs.md B14). This used to be the
// other way round, on the argument that the two paths spend separate budgets:
// the trade gate guards anonymous requests to /api/trade/*, this one is
// cookie-authenticated against two stash endpoints. What overturned it is not
// code but a reported observation — a GGG ban on this deployment applied to the
// whole ADDRESS, and it ended only by taking a new one; sitting it out would
// have cost about twelve hours. A ban that is addressed at the address does not
// care which cookie the next request carries, so during one the cheapest thing
// this path can do is nothing at all.
//
// The trade is stated plainly, because it is a real one: coupling FREEZES the
// net worth for the length of the ban (3.7h and 11h are the two waits this
// repository has actually seen) and leaves a gap in the history series. That is
// annoying and it heals itself. A ban costs every user of the deployment at
// once and heals only with time or a new address — so the asymmetry decides it.
//
// The pause is never silent: statusFor reports it like the 429 cooldown, with
// `tradeBan: true` as the discriminator (the same shape `mine` uses), because
// the two have different causes and different remedies — one waits out GGG's
// trade ban, the other is about this deployment's stash reads.
//
// NOTHING HERE COUPLES THE OTHER WAY. A stash 429 does not hold the trade
// queue: a full rate-limit WINDOW on the stash rules says nothing about the
// state of the trade rules, even when both are keyed to the same address (they
// are separate rules with separate counters). A ban is the thing that spans
// them, and this hook is how one arrives.
//
// A FOLDER TAB IS MANY STEPS, NOT ONE (docs/bugs.md B5). Its items live in
// sub-folders on a second endpoint, so reading one costs 1+N requests — 38 for
// the map stash as measured — and it used to spend all of them inside a single
// step. At the derived pace that is ~15 minutes at a 24s spacing and ~50 at the
// 80s a stricter rule set derives, and for the whole of it the global `busy`
// flag was held and the round-robin did not advance: no other tab, and no other
// USER. On a deployment with several configured users one folder tab pushed a
// full round from hours into days.
//
// So a folder tab is walked ONE SUB-TAB PER TICK, as a piece of plain data the
// refresher puts down between ticks (networth/folder-walk.mjs). Nothing about
// the sequentiality changes: still one request in flight, still one global
// pace, still `busy` for the length of a step — a step is simply one request
// again, like every other. THE REQUEST COUNT IS UNCHANGED: the same 1+N, in the
// same order, at the same spacing, spread over 1+N turns instead of one.
//
// What that buys, and what it costs. Another user now waits ONE step for a
// folder tab rather than 1+N of them. A single user's full round gets slightly
// longer in wall clock (each request waits for the next tick rather than only
// for the derived spacing), which is the direction that sends less. And a 429
// in the middle of a walk no longer throws the walk away — it resumes after the
// cooldown, which is strictly fewer requests than starting over.
//
// The partial walk is memory, never the store. See the note at the top of
// folder-walk.mjs: a half-read folder tab in the per-tab store would be read as
// a tab that HAS been read, by the snapshot, by `tabList` and by coverageOf()
// below — which is docs/bugs.md B7 with the tool writing it itself. A restart
// therefore forgets a walk in progress and the tab is walked again from the
// beginning: the same requests the old all-in-one step would also have had to
// spend again.
//
// OBSERVABILITY (B5): what used to make a folder tab visible was the pair of
// `still busy: …` / `finished after Ns` lines around the step it occupied.
// There is no such step any more, so the pair is not what reports a folder tab
// now (it stays, unchanged, for a step that really does hang). In its place,
// and saying more than it did: the opening `reading sub-tabs` line as before, a
// closing line naming the sub-tab count, the steps and the seconds when the
// walk completes, and — the part the old pair could not do — `folderTab` in
// statusFor(), which answers "12 of 37 sub-tabs" BETWEEN ticks and not only
// while a request happens to be in flight.

// The shared "read a number out of the environment" rule (slowStepMsFromEnv
// below). The default stays here, next to the measurements that argue it; only
// the parsing is shared.
import { readEnvNumber } from '../env-number.mjs'
import {
  beginFolderWalk, stepFolderWalk, finishFolderWalk,
  folderWalkFinished, folderWalkRead, folderWalkTotal
} from './folder-walk.mjs'

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_LIST_TTL_MS = 15 * 60 * 1000
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000

// How long ONE step may run before the log says so. Not a timeout and not a
// bound: nothing is aborted, nothing is released, the line is pure observation.
// 120s sits above every healthy ORDINARY step — an ordinary tab is a single
// request — and far below the ten-minute hole B5 describes.
//
// A FOLDER TAB NOW CROSSES IT ON PURPOSE, and the line is right to fire. Since
// the stash pace is derived from GGG's published limits rather than from a 1.5s
// constant (networth/stash-pacer.mjs), 1+N requests inside one step are spread
// at the derived spacing: on the measured rule set the map stash (1+30) takes
// around twelve minutes where it used to take forty-five seconds. The requests
// are the same requests — what changed is that the burst is gone. So the two
// lines this produces per folder-tab turn are not noise about a defect; they
// are the only thing that tells an operator the refresher is parked in a folder
// tab rather than dead, which is exactly what B5 asked for. Raise the setting if
// the account has no folder tabs worth the brackets.
export const DEFAULT_SLOW_STEP_MS = 120_000

/**
 * slowStepMsFromEnv(env, { log }) -> number
 *
 * Reads POE_NETWORTH_SLOW_STEP_MS through the shared reader (env-number.mjs).
 * Deliberately NOT `Number(env) || DEFAULT`: that cannot express 0, and 0 is
 * meaningful here — it makes every step that is still running when the next
 * tick arrives report itself, which is the setting you want while hunting a
 * stall. Blank/unset falls back in silence; anything that is not a finite
 * number >= 0 falls back and says so in the log.
 */
const SLOW_STEP_SPEC = {
  name: 'POE_NETWORTH_SLOW_STEP_MS',
  fallback: DEFAULT_SLOW_STEP_MS,
  zero: true
}

export function slowStepMsFromEnv (env = process.env, { log } = {}) {
  return readEnvNumber(SLOW_STEP_SPEC, { env, ...(log ? { log } : {}) })
}

export function createNetworthRefresher ({
  store,
  loadUsers,
  makeClient,
  valueTab,
  cdRatioFor,
  onTabSynced = () => {},
  onStatus = () => {},
  isPaused = () => false,
  intervalMs = DEFAULT_INTERVAL_MS,
  listTtlMs = DEFAULT_LIST_TTL_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  slowStepMs = DEFAULT_SLOW_STEP_MS,
  now = () => Date.now(),
  log = console
} = {}) {
  // Per-user in-memory state (survives across ticks, NOT across a restart):
  //   tabs           — last live tab list [{index,name,type,id}] from listTabs
  //   listFetchedAt  — when that list was fetched (drives the listTtl refetch)
  //   cooldownUntil  — set on a 429; the user is skipped until now() passes it
  //   pausedPoesessid— set on an auth failure; the user is skipped until the
  //                    reloaded creds carry a DIFFERENT poesessid (cookie renewed)
  //   walk           — a folder tab being read one sub-tab per tick, or null:
  //                    { tab, walk, startedAt, steps }. In memory for the same
  //                    reason everything else here is, and deliberately not in
  //                    the store (see the note above and folder-walk.mjs)
  const state = new Map()
  let cursor = 0            // round-robin pointer across the user list
  let busy = false          // overlap guard (only one tick's work in flight)
  let intervalHandle = null
  // A 429 anywhere stops EVERY user until this passes (see the header note).
  // The per-user cooldownUntil is kept alongside it and is what `mine` in
  // statusFor is read from — it is the only record of WHO GGG actually refused.
  let globalCooldownUntil = 0
  // Whether the last tick found the trade-API ban gate up (isPaused). Kept only
  // to notice the EDGE: entering and leaving the pause each cost one log line
  // and one status push per user, not one per tick for hours on end.
  let tradeBanPaused = false
  // The users the last tick saw, so a 429 can push a status to all of their
  // rooms and not only to the one whose request was refused. Rebuilt every
  // tick from loadUsers; a user removed from the config simply stops appearing.
  let knownUsers = []
  // What the step in flight is doing, or null while nothing is. At most one
  // entry — that is exactly what `busy` guarantees. Set in step(), cleared in
  // its finally, so an idle refresher reports nothing rather than the last tab
  // it happened to touch. `warned` remembers whether the slow-step line has
  // already fired for THIS step, so a ten-minute stall costs one line and not
  // one per tick.
  //   { user, phase: 'list'|'tab', tabIndex, tabName, tabType, startedAt, warned }
  let current = null

  function getState (user) {
    let st = state.get(user)
    if (!st) { st = { tabs: null, listFetchedAt: 0, cooldownUntil: 0, pausedPoesessid: null, attempts: new Map(), walk: null }; state.set(user, st) }
    return st
  }

  // Stalest tab from the cached live list, on ONE unified timeline:
  //   - a synced tab            -> its stored syncedAt
  //   - a never-synced tab that we just ATTEMPTED (and skipped on a rejected/
  //     timeout/5xx) -> the in-memory attempt timestamp
  //   - a never-synced, never-attempted tab -> -Infinity (picked first)
  // The smallest wins. Recording the attempt is what keeps a persistently
  // failing "poison" tab from blocking the whole round-robin (mirrors the
  // cursor advances even on throw): after it's tried, every other tab
  // is now older, so the loop moves on and only comes back once it laps.
  // THE LATER OF THE TWO, NOT "STORED WINS". The attempt stamp used to be read
  // only for a tab with NO stored data, which left the poison tab this function
  // says it handles wide open in the one case that matters: a tab that HAS been
  // synced before and now fails keeps its old `syncedAt`, so it stayed the
  // stalest tab and was picked again on the very next tick, and the one after
  // that — one request per tick at the same tab, for ever, while every other
  // tab's stamp moved forward and none of them ever came round again. Taking
  // the maximum keeps every documented property (a success stamps a NEWER
  // syncedAt, so it still supersedes the attempt) and makes the timeline the
  // comment above claims: the last time anything was DONE about this tab.
  function pickStalest (user, st) {
    let best = null
    let bestAt = Infinity
    for (const t of st.tabs) {
      const stored = store.getTab(user, t.index)
      const syncedAt = (stored && typeof stored.syncedAt === 'number') ? stored.syncedAt : -Infinity
      const attemptAt = st.attempts.has(t.index) ? st.attempts.get(t.index) : -Infinity
      const at = Math.max(syncedAt, attemptAt)
      if (at < bestAt) { bestAt = at; best = t }
    }
    return best
  }

  // How much of the account the per-tab store can currently answer for.
  //
  // THREE STATES, AND THEY ARE NOT TWO. A live tab is either
  //   READ     — the store holds a reading of it (with contents or genuinely
  //              empty; `tabsRead`),
  //   UNKNOWN  — no stored reading, but the round-robin has been past it since
  //              the current tab list was fetched and it did not yield one, or
  //   PENDING  — not yet reached at all.
  // `tabsCovered` is READ + UNKNOWN and `complete` is "nothing pending", which
  // is deliberately NOT "everything read": a tab that never becomes readable
  // must not stop the recording for ever, and its absence is then a CONSTANT in
  // every point rather than a dip in one of them. `tabsRead` is what says how
  // much of that "covered" is an actual reading, so a series recorded over an
  // account the tool can only partly read says so instead of looking healthy.
  //
  // WHAT THIS CANNOT SEE, and why it is not the gate that matters most: a tab
  // that is stored EMPTY counts as read, because from here that is exactly what
  // it looks like. Telling "GGG said this tab is empty" from "GGG did not
  // answer" is possible only where the response is — stash-client.mjs, which
  // now throws `kind:'unread'` for the second rather than handing up an empty
  // array (docs/bugs.md B2).
  //
  // `st.attempts` is cleared whenever the list is re-fetched, which is what
  // makes this honest after a pruneTabs that emptied the store: stale attempt
  // stamps from the previous round would otherwise vouch for tabs whose data
  // is gone.
  function coverageOf (user, st) {
    const tabs = st.tabs || []
    let read = 0
    let covered = 0
    for (const t of tabs) {
      const stored = !!store.getTab(user, t.index)
      if (stored) read++
      if (stored || st.attempts.has(t.index)) covered++
    }
    return {
      tabsCovered: covered,
      tabsRead: read,
      tabsTotal: tabs.length,
      complete: tabs.length > 0 && covered === tabs.length
    }
  }

  function handleError (user, cred, league, e) {
    const st = getState(user)
    const kind = e?.kind
    if (kind === 'auth') {
      // Cookie invalid/expired -> pause this user until the cookie is renewed
      // on the settings page or in networth-users.json (detected on the next
      // reload via a changed poesessid). Cookie value is NEVER logged.
      st.pausedPoesessid = cred.poesessid
      log.warn?.(`[networth-refresher] cookie expired for ${user} — renew it on the settings page (Sync settings) or in networth-users.json`)
      onStatus(user)
      return
    }
    if (kind === 'ratelimit') {
      // 429 -> back off for a whole cooldown window, then resume gently. NEVER
      // hammer. The backoff is GLOBAL because part of the budget demonstrably
      // is: GGG publishes `Ip` rules on the stash endpoints, so the address
      // every session shares is what filled up (header note).
      //
      // Never SHORTER than the configured cooldown, and longer when GGG named a
      // longer wait: the stash client hands the Retry-After along on the error
      // rather than sleeping it off inside the request.
      const askedMs = Number.isFinite(e?.retryAfterSec) && e.retryAfterSec > 0
        ? (e.retryAfterSec + 1) * 1000
        : 0
      const waitMs = Math.max(cooldownMs, askedMs)
      const until = now() + waitMs
      st.cooldownUntil = Math.max(st.cooldownUntil || 0, until)
      globalCooldownUntil = Math.max(globalCooldownUntil, until)
      const others = knownUsers.filter(u => u !== user)
      log.warn?.(`[networth-refresher] rate-limited on ${user}, cooling down ${Math.round(waitMs / 1000)}s` +
        (askedMs > cooldownMs ? ' (GGG asked for the longer wait)' : '') +
        ` — ALL net-worth syncing is paused for it${others.length ? `, including ${others.length} other user(s)` : ''}: ` +
        'part of the stash budget is published under the rule name Ip, so it belongs to the address every session shares')
      // Everyone's status line changes, not just the refused user's.
      for (const u of [user, ...others]) onStatus(u)
      return
    }
    if (kind === 'unread') {
      // GGG ANSWERED, AND THE ANSWER CARRIED NO CONTENTS. A 200 without an
      // items array, or a folder walk whose sub-tabs did not all answer. This
      // is a skip like the ones below and is separated from them only because
      // it is the one that used to be invisible: it arrived as an empty array,
      // was stored as an empty tab, and the recorder read a whole tab's stock
      // leaving the stash (docs/bugs.md B2). Nothing is written, the tab keeps
      // its last real contents, and because no tab was written there is no
      // onTabSynced and therefore no history point out of this step either.
      log.warn?.(`[networth-refresher] a tab of ${user} was NOT read and is left as it was stored ` +
        `(no point is recorded from this step): ${e?.message || e}`)
      return
    }
    // rejected / server / timeout / unknown -> skip THIS tab, keep its old
    // stored state; the next tick picks the next-stalest tab. No loop abort.
    log.warn?.(`[networth-refresher] tab sync failed for ${user} (skipped): ${e?.message || e}`)
  }

  // ONE step for one user, and ONE request: refresh the tab list when it is
  // stale/unknown, or sync the stalest ordinary tab, or read one sub-tab of a
  // folder tab. Never two of them.
  async function step (user, cred) {
    const ctx = makeClient(user, cred)
    const client = ctx?.client ?? ctx
    const league = ctx?.league
    const accountName = cred.accountName
    const st = getState(user)

    // A folder tab that has been started owns this user's turns until it is
    // finished, and the tab-list refresh WAITS for it. Re-listing mid-walk
    // would replace the tab entry the walk is holding and throw away every
    // request it has already spent; postponing costs nothing but a slightly
    // older list, which is a freshness heuristic and not a correctness one.
    // (`st.attempts.clear()` and pruneTabs go with the list, so they wait too —
    // and coverageOf stays honest either way, because the walked tab's attempt
    // stamp is refreshed on every step below.)
    const inWalk = st.walk != null
    const listAge = now() - (st.listFetchedAt || 0)
    const needList = !inWalk && (!st.tabs || st.tabs.length === 0 || listAge >= listTtlMs)

    // From here on the refresher can say what it is doing. The tab identity is
    // filled in below, once the stalest tab is picked; until then the phase
    // alone ('list') is the honest answer.
    current = {
      user,
      phase: needList ? 'list' : 'tab',
      tabIndex: null,
      tabName: null,
      tabType: null,
      child: null,       // sub-tabs of a folder tab already read, when in one
      childTotal: null,  // …and how many there are, once the list has arrived
      startedAt: now(),
      warned: false
    }

    try {
      if (needList) {
        const tabs = await client.listTabs()
        // type + id have to come along: folder tabs (Unique/Maps) are readable
        // only by their id on the newer endpoint, and the type is what decides
        // which route to take in the first place. This used to be boiled down
        // to {index,name} — which is why those two tabs kept arriving empty.
        st.tabs = (tabs || []).map(t => ({ index: t.index, name: t.name, type: t.type ?? null, id: t.id ?? null }))
        st.listFetchedAt = now()
        // A new list starts a new round: what was attempted against the old one
        // says nothing about this one, and pruneTabs right below can drop
        // stored tabs, so a stale attempt would claim coverage for data that no
        // longer exists (see coverageOf). It takes TWO consecutive lists that
        // agree before anything is actually dropped (store.mjs) — that changes
        // when the store loses a tab, never whether this has to be cleared.
        st.attempts.clear()
        store.pruneTabs(user, st.tabs.map(t => t.index))
        store.setMeta(user, { accountName, league, cdRatio: cdRatioFor(user, league) })
        return // one request spent — the tab syncs happen on following ticks
      }

      // A walk in progress is the target; otherwise the round-robin picks one.
      const target = inWalk ? st.walk.tab : pickStalest(user, st)
      if (!target) return
      current.tabIndex = target.index
      current.tabName = target.name
      current.tabType = target.type ?? null
      // Record the attempt BEFORE the request: on success setTab stamps a
      // (newer) syncedAt that supersedes it; on a skip it's what pushes this
      // tab to the back so the round-robin keeps advancing. Refreshed on every
      // step of a walk too, so an abandoned walk does not come straight back
      // round — and so coverageOf counts the tab from its FIRST step, exactly
      // as it counted the old 1+N step from its start.
      st.attempts.set(target.index, now())

      // A folder tab is 1+N requests, so it is 1+N steps. Everything else is
      // one request and finishes here.
      if (inWalk || client.isChildedTab?.(target)) {
        await walkOneSubTab(user, st, client, target, { league, accountName })
        return
      }

      const items = await client.fetchTab(target.index, target)
      const cdRatio = cdRatioFor(user, league)
      const tabData = await valueTab({ items, tab: target, cdRatio, league, accountName })
      await store.setTab(user, target.index, tabData) // persists immediately, stamps syncedAt
      onTabSynced(user, coverageOf(user, st))
    } catch (e) {
      // A WALK THAT FAILED IS DROPPED, and its partial items are not written:
      // a half-read folder tab must never reach the store, as "empty" or as
      // anything else (docs/bugs.md B7). The tab is walked again from the
      // beginning on a later turn — the same requests the old all-in-one step
      // would have had to spend again after the same failure, not more.
      //
      // "FAILED" NOW INCLUDES A WALK THAT FINISHED WITHOUT ANSWERS. A sub-tab
      // can reply 200 with a body that carries no items array; such a walk used
      // to finish normally and write its subset as the whole tab
      // (docs/bugs.md B2). finishFolderWalk throws `kind:'unread'` for it, so it
      // lands here and is dropped exactly like a walk whose request threw.
      //
      // A 429 is the exception and keeps the walk. The cooldown is exactly the
      // situation resuming was built for: continuing where it stopped costs the
      // remaining sub-tabs, starting over costs all of them.
      if (st.walk && e?.kind !== 'ratelimit') st.walk = null
      handleError(user, cred, league, e)
    } finally {
      // The closing bracket of the log hole, and ONLY for a step that already
      // announced itself as slow: in normal operation nothing here fires at
      // all, and a stall produces exactly two lines (the warning and this one).
      if (current?.warned) {
        log.warn?.(`[networth-refresher] ${describeStep(current)} finished after ${Math.round((now() - current.startedAt) / 1000)}s`)
      }
      current = null
    }
  }

  /**
   * ONE request of a folder tab's 1+N: the sub-tab list on the first turn, one
   * sub-tab on each turn after it. The tab is written to the store only when
   * the last of them has arrived — a walk in progress leaves the previous,
   * COMPLETE contents of that tab standing, so the snapshot never shows a
   * folder tab half-read.
   */
  async function walkOneSubTab (user, st, client, tab, { league, accountName }) {
    if (!st.walk) st.walk = { tab, walk: beginFolderWalk(tab), startedAt: now(), steps: 0 }
    const entry = st.walk
    current.child = folderWalkRead(entry.walk)
    current.childTotal = folderWalkTotal(entry.walk)
    entry.steps++

    await stepFolderWalk(client, entry.walk, log)

    // The list request has just told us how many sub-tabs there are; say so
    // while the step is still in flight, so a status read during it is right.
    current.child = folderWalkRead(entry.walk)
    current.childTotal = folderWalkTotal(entry.walk)
    if (!folderWalkFinished(entry.walk)) return   // one request spent; the rest on following turns

    // Complete. `finishFolderWalk` owns the B7 yield line, so a walk driven
    // tick by tick reports exactly what one driven in a loop reports.
    const items = finishFolderWalk(entry.walk, log)
    const heldSec = Math.round((now() - entry.startedAt) / 1000)
    st.walk = null
    // The closing bracket, and the counterpart to the `still busy` pair a folder
    // tab used to produce (docs/bugs.md B5). Unconditional and once per
    // folder-tab TURN — two lines per full round on an account with a unique
    // and a map stash, which is what the pair it replaces cost as well.
    log.log?.(`[networth-refresher] folder tab "${tab.name}" (index ${tab.index}) for ${user}: ` +
      `${folderWalkTotal(entry.walk)} sub-tabs over ${entry.steps} steps in ${heldSec}s` +
      (entry.walk.skipped ? ` (${entry.walk.skipped} of them not read — see the line above)` : '') + ' — ' +
      'one request per step, so every other tab and user kept their turns')

    const cdRatio = cdRatioFor(user, league)
    const tabData = await valueTab({ items, tab, cdRatio, league, accountName })
    await store.setTab(user, tab.index, tabData)   // persists immediately, stamps syncedAt
    onTabSynced(user, coverageOf(user, st))
  }

  // Human-readable identity of a step, for the log. Routing name (player1) and
  // stash-tab name only — never the account name, never the cookie.
  function describeStep (c) {
    if (!c) return 'idle'
    if (c.phase === 'list') return `tab-list fetch for ${c.user}`
    if (c.tabName == null) return `tab sync for ${c.user}`
    const sub = c.childTotal != null ? `, sub-tab ${c.child + 1}/${c.childTotal}` : ''
    return `tab "${c.tabName}" (index ${c.tabIndex}${c.tabType ? `, ${c.tabType}` : ''}${sub}) for ${c.user}`
  }

  // One tick: overlap-guarded, picks the next eligible user round-robin and
  // does exactly one step (=one request) for them.
  async function tickOnce () {
    if (busy) { warnIfSlow(); return }
    // The trade-API ban gate (B14). Checked before anything else that could
    // lead to a request, and evaluated on EVERY tick rather than remembered, so
    // the gate lifting needs no notification of its own — the next tick sees it.
    // The edge is what gets announced (see tradeBanPaused).
    const paused = !!isPaused()
    if (paused !== tradeBanPaused) {
      tradeBanPaused = paused
      log.warn?.(paused
        ? '[networth-refresher] trade-API ban gate is up — ALL net-worth syncing pauses with it: ' +
          'a ban has been observed to apply to the whole address, so a stash read during one is a request into a ban'
        : '[networth-refresher] trade-API ban lifted — syncing resumes')
      for (const u of knownUsers) onStatus(u)
    }
    if (paused) return
    // The global 429 backoff, opened in handleError and closed here. Closing it
    // in the tick rather than on a timer keeps the whole module free of its own
    // clocks: `now()` is injected, so a test moves time instead of waiting.
    if (globalCooldownUntil) {
      if (now() < globalCooldownUntil) return
      globalCooldownUntil = 0
      log.warn?.('[networth-refresher] rate-limit cooldown over — syncing resumes')
      for (const u of knownUsers) onStatus(u)
    }
    busy = true
    try {
      const users = await loadUsers()
      const names = Object.keys(users || {}).sort()
      knownUsers = names
      if (!names.length) return

      // Reactivate any auth-paused user whose cookie was renewed in the config.
      for (const u of names) {
        const st = getState(u)
        if (st.pausedPoesessid && users[u]?.poesessid !== st.pausedPoesessid) {
          st.pausedPoesessid = null
          onStatus(u)
        }
      }

      for (let i = 0; i < names.length; i++) {
        const u = names[(cursor + i) % names.length]
        const st = getState(u)
        if (st.pausedPoesessid) continue          // auth-paused
        if (now() < (st.cooldownUntil || 0)) continue // rate-limit cooldown
        cursor = (cursor + i + 1) % names.length
        await step(u, users[u])
        return
      }
      // nobody eligible this tick (all paused / cooling down) -> quiet lapse
    } finally {
      busy = false
    }
  }

  // A tick that finds the previous step still running. This does NOT release
  // `busy` and does not touch the step — overlapping requests against GGG are
  // the one thing this module must never do. It only says so, once per step:
  //
  // Frequency in normal operation: NEVER. A step longer than `slowStepMs`
  // (120s by default) does not occur while the account reads normally, and the
  // `warned` latch means even a ten-minute stall is a single line, not one
  // every 30s. With slowStepMs=0 it degenerates to "one line per step that
  // outlives a tick", which is a deliberate debugging setting.
  function warnIfSlow () {
    if (!current || current.warned) return
    const heldMs = now() - current.startedAt
    if (heldMs < slowStepMs) return
    current.warned = true
    log.warn?.(`[networth-refresher] still busy: ${describeStep(current)} has been running for ${Math.round(heldMs / 1000)}s ` +
      '— ticks are being skipped until it returns (not aborted: a second request in flight would break the rate-limit discipline)')
  }

  function start () {
    if (intervalHandle) clearInterval(intervalHandle)
    intervalHandle = setInterval(() => {
      tickOnce().catch(e => log.error?.(`[networth-refresher] tick failed: ${e?.message || e}`))
    }, intervalMs)
    intervalHandle.unref?.()
    return intervalHandle
  }

  function stop () {
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null }
  }

  // Clean status export for the UI ("missing" is decided by the caller, who
  // knows whether credentials exist at all — the refresher only knows its own
  // pause/cooldown state). `currentPoesessid` is the value the credential file
  // holds RIGHT NOW: an auth pause counts only while the file still carries the
  // exact cookie that failed — the same comparison the reactivation loop in
  // tickOnce uses. So the instant a new cookie is saved, the status reads 'ok'
  // even before the next tick formally lifts the pause. NOTE: this NEVER
  // returns the cookie value itself, only a state derived from comparing it.
  function statusFor (user, currentPoesessid) {
    const st = state.get(user)
    const out = { state: 'ok' }
    // An expired cookie is this user's own, more actionable problem and keeps
    // precedence: a global cooldown lifts by itself, a dead cookie does not.
    if (st && st.pausedPoesessid && st.pausedPoesessid === currentPoesessid) {
      out.state = 'expired'
    } else {
      // A 429 pauses everybody, so this has to be answerable for a user with no
      // state of their own at all. `mine` is the difference between "GGG
      // refused YOUR session" and "you are waiting on somebody else's 429" —
      // without it the pause is a silent stop again for every user but one.
      // The other user is never named: rooms are the only separation this tool
      // has (same rule as currentStepFor).
      const mineUntil = st?.cooldownUntil || 0
      const until = Math.max(mineUntil, globalCooldownUntil)
      if (now() < until) { out.state = 'cooldown'; out.until = until; out.mine = now() < mineUntil }
      else {
        // B14: no stash cooldown, but the trade-API ban gate is holding this
        // path too. Same state and the same shape as above — one extra field
        // says which of the two it is, because "GGG refused your stash read"
        // and "GGG banned this deployment's trade traffic" have different
        // causes and different things to do about them. The stash cooldown
        // keeps precedence: it is the more specific refusal of THIS path, and
        // it carries `mine`. A pause with no end time (a bare `true` from the
        // hook) reports no `until` rather than inventing one.
        const pause = isPaused()
        if (pause) {
          out.state = 'cooldown'
          out.tradeBan = true
          const bannedUntil = Number(pause?.until)
          if (Number.isFinite(bannedUntil) && bannedUntil > now()) out.until = bannedUntil
        }
      }
    }
    // B5: 'ok' used to mean both "syncing along nicely" and "one step has been
    // stuck for ten minutes". These two fields are the difference. Both are
    // OPTIONAL — omitted when there is nothing to say — so a fresh, idle
    // refresher still answers plainly `{ state: 'ok' }`.
    const lastTab = lastTabWritten(user)
    if (lastTab) out.lastTab = lastTab
    const step = currentStepFor(user)
    if (step) out.current = step
    // A folder tab being walked one sub-tab per tick. This is the field that
    // replaces what the `still busy` pair used to say, and it says it better:
    // a walk is not a step any more, so between two ticks `current` is null and
    // nothing would otherwise report that a folder tab is half-read. Always
    // this user's own walk — `state.get(user)` is their own state — so no tab
    // name crosses a room.
    const walking = st?.walk
    if (walking) {
      out.folderTab = {
        tab: walking.tab.name,
        tabIndex: walking.tab.index,
        done: folderWalkRead(walking.walk),
        since: walking.startedAt
      }
      const total = folderWalkTotal(walking.walk)
      if (total != null) out.folderTab.total = total
    }
    return out
  }

  // When a tab was last WRITTEN for this user, taken from the store rather than
  // from memory: the store's stamp survives a restart, and it is the same
  // number the page's "oldest synced X min ago" line is built from, so the two
  // cannot disagree. Cheap — the tab list is tens of entries and statusFor is
  // called on a WS connect / a status change, not in a loop.
  function lastTabWritten (user) {
    let best = null
    for (const t of store.tabList(user)) {
      if (typeof t.syncedAt !== 'number') continue
      if (!best || t.syncedAt > best.syncedAt) best = t
    }
    return best ? { at: best.syncedAt, index: best.index, name: best.name ?? null } : null
  }

  // The step in flight, as far as THIS user may see it. A step belonging to
  // another user still shows up — it is the reason this user's tabs are not
  // moving — but only as phase + start time. The other user's stash-tab names
  // are none of this room's business (there is no login here; rooms are the
  // only separation the tool has).
  function currentStepFor (user) {
    if (!current) return null
    const mine = current.user === user
    const out = { phase: current.phase, since: current.startedAt, mine }
    if (mine && current.tabName != null) {
      out.tab = current.tabName
      out.tabIndex = current.tabIndex
      // Which of a folder tab's 1+N requests this step is. Only for the owning
      // room, like the tab name it belongs to.
      if (current.childTotal != null) { out.child = current.child; out.childTotal = current.childTotal }
    }
    return out
  }

  return { start, stop, tickOnce, statusFor }
}
