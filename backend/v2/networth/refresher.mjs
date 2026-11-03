// Continuous background net-worth refresher. Instead of scanning all ~115 tabs
// in one burst (which slams GGG's character-window endpoint into a 429), it
// ticks quietly: ONE step per interval (default ~30s), syncing the single
// stalest stash tab of ONE user into the per-tab store. Strictly sequential,
// one request per tick, overlap-guarded (`busy` flag), .unref()'d interval.
// The POESESSID cookie NEVER touches a log, a broadcast, or the store (that
// discipline lives in the injected makeClient/stash-client + valueTab).
//
// THE PACE IS A TOTAL, NOT A PER-USER RATE: one refresher, one `busy` flag, one
// step per tick, users walked round-robin. A second configured user adds no
// second request stream, it halves how often each comes round: ~2,880 steps a
// DAY in total at the 30s default, and with three users each tab is revisited
// roughly every three hours rather than every hour. A step is usually one
// request; a folder tab is 1+N of them, one per step (FOLDER TAB below).
//
// WHO GETS THE TICK (sync follows the game). `presenceOf(user)` answers
// 'playing' | 'idle' | 'unknown' from the hotkey daemons' heartbeats
// (daemon-presence.mjs). The tick still comes every intervalMs and still does
// at most ONE step; what changes is who gets it, or whether it lapses:
//   nobody idle — exactly the round-robin above. Every deployment without new
//                 daemons is here, and so is every failure: a daemon that stops
//                 reporting, a network that is down, a server that just started
//                 all read 'unknown', which counts like 'playing'.
//   some idle   — the others get the ticks; every idleEvery-th tick goes to the
//                 idle ones, round-robin among them.
//   all idle    — only every idleEvery-th tick does a step; none with idleRest.
// idleEvery is at least 2 (with 1 every tick would go to the idle users and the
// players would get none); idleRest (POE_NETWORTH_IDLE_REST=1) gives idle users
// no tick at all. A player who cannot step (cookie expired, auth-paused) still
// counts as playing: those ticks lapse and are NOT handed to the idle users, so
// an expired cookie never makes anybody's sync faster. The total can therefore
// only stay equal or fall: a playing account is read at most at the rate a
// one-user deployment has, every request still waits for the shared stash pacer
// (every published rule, Account rules included), and the trade-ban gate and
// the 429 cooldown come first. A change of WHO rests is an edge: one log line
// when the mode changes, and an onStatus for every user whose part changed,
// also within one mode (the hold after a game ends, daemon-presence.mjs).
//
// A 429 STOPS THE WHOLE REFRESHER, NOT JUST THE USER WHO GOT IT. Measured: the
// rule names logged off the stash responses include `Ip 45/60s` and
// `Ip 180/1800s`, so part of the budget is the ADDRESS's, shared by every
// configured user (and by everything else leaving this machine). statusFor
// reports `cooldown` for everyone, with `mine` saying whether this user is the
// one GGG refused or is waiting on somebody else.
//
// A TRADE-API BAN STOPS IT AS WELL (docs/bugs.md B14), although the trade gate
// guards anonymous requests to /api/trade/* and this path is cookie-
// authenticated against two stash endpoints: a GGG ban on this deployment (a
// reported observation) applied to the whole ADDRESS and ended only by taking a
// new one; sitting it out would have cost about twelve hours. The price is
// real: the net worth FREEZES for the length of the ban (3.7h and 11h are the
// two waits this repository has seen) and the history series gets a gap. That
// heals itself; a ban costs every user at once. statusFor reports the pause
// like the 429 cooldown, with `tradeBan: true` as the discriminator, because
// the two have different causes and remedies. NOTHING COUPLES THE OTHER WAY: a
// stash 429 does not hold the trade queue (separate rules with separate
// counters, even on the same address); a ban is what spans them, and isPaused
// is how one arrives.
//
// A FOLDER TAB IS MANY STEPS, NOT ONE (docs/bugs.md B5). Its items live in
// sub-folders on a second endpoint, so reading one costs 1+N requests (38 for
// the map stash as measured): at the derived pace ~15 minutes at a 24s spacing
// and ~50 at the 80s a stricter rule set derives. Inside one step that would
// hold `busy` and stop the round-robin, every other tab and USER, for the whole
// of it. So a folder tab is walked ONE SUB-TAB PER TICK, as plain data the
// refresher puts down between ticks (networth/folder-walk.mjs): still one
// request in flight, one global pace, `busy` for one step, and THE REQUEST
// COUNT IS THE SAME 1+N, in the same order, at the same spacing, over 1+N
// turns. Another user waits ONE step for it; a single user's full round gets
// slightly longer in wall clock (each request waits for the next tick); a 429
// mid-walk keeps the walk and resumes after the cooldown. The partial walk is
// memory, NEVER the store: a half-read folder tab there would be read as read
// by the snapshot, `tabList` and coverageOf() (docs/bugs.md B7). A restart
// forgets a walk in progress and walks the tab again from the beginning.
// OBSERVABILITY (B5): the opening `reading sub-tabs` line, a closing line
// naming the sub-tab count, the steps and the seconds, and `folderTab` in
// statusFor() ("12 of 37 sub-tabs") BETWEEN ticks. The `still busy: …` /
// `finished after Ns` pair stays for a step that really does hang; it does not
// report a folder tab.
//
// Session rounds and the injected I/O: see createNetworthRefresher below.

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
// Every how many ticks the users whose game is not running get one (WHO GETS
// THE TICK above). 10 at the 30 s interval: a tab every 5 minutes for them.
export const DEFAULT_IDLE_EVERY = 10

// How long ONE step may run before the log says so. Not a timeout and not a
// bound: nothing is aborted, nothing is released, the line is pure observation.
// 120s sits above every healthy ORDINARY step — an ordinary tab is a single
// request — and far below the ten-minute hole B5 describes.
//
// A folder tab does not cross it: it is walked one sub-tab per step (FOLDER
// TAB above), and the stash pace is derived from GGG's published limits
// (networth/stash-pacer.mjs), so a step is one request at the derived spacing.
// The line therefore marks one genuinely stuck step.
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

// A SESSION ROUND. A farm or game session (sessions.mjs) takes its baseline
// from the first full read of the stash after its start, and its final balance
// from the first full read after its end. prioritize(user, since) asks for that
// read: until every live tab of the user was read (or tried) once at or after
// `since`, this user's steps take the tabs not yet read since then first, and
// the tab-list refresh waits for the round (a refresh in the middle would clear
// the attempts the round has counted, see coverageOf). It gives the user no
// extra tick, shortens no interval and changes nothing about who gets a tick
// (the idle rules, the trade-ban gate, the 429 cooldown): it orders the steps
// the user gets anyway. pickStalest's stalest-first rule already reaches those
// tabs first; the round adds the waiting tab list and the progress in the
// status line (statusFor `sessionRound`). One round per user: a later moment
// replaces an earlier one (reading every tab after the later moment also reads
// every tab after the earlier one). It ends by itself once complete.
//
// Every I/O is injected so the whole thing is unit-testable with mocks — NO
// live GGG requests in tests:
//   store        — per-tab networth store
//                  (getTab/setTab/setMeta/pruneTabs/tabList)
//   loadUsers    — async () => ({ <user>: { accountName, poesessid } })
//                  (creds, reloaded every round -> cookie rotation without a
//                  restart)
//   makeClient   — (user, cred) => ({ client, league })  where client has
//                  listTabs()/fetchTab(index); server binds the league.
//   valueTab     — async ({ items, tab, cdRatio, league, accountName })
//                  => tabData
//                  (server binds valuator+normalize; see scan.mjs valueTab)
//   cdRatioFor   — (user, league) => chaosPerDivine (number)
//   onTabSynced  — (user, coverage) => void  (server broadcasts the refreshed
//                  snapshot). `coverage` = { tabsCovered, tabsRead, tabsTotal,
//                  complete }: whether the store holds an answer for EVERY live
//                  tab, and how much of it is an actual reading rather than a
//                  tab that was tried and yielded nothing (coverageOf()).
//   isPaused     — () => false | true | { until }  (default () => false; the
//                  server wires the TRADE-API BAN GATE into it. `{ until }`
//                  (epoch ms) lets the status line name when the pause is
//                  expected to lift; a bare `true` pauses without one.)
//   onStatus     — (user) => void  (optional; fired whenever this user's sync
//                  status changes: auth-pause set/lifted, cooldown entered or
//                  lifted; the server broadcasts it to the UI. A 429 fires it
//                  for EVERY known user, because a 429 stops all of them.)
//   presenceOf   — (user) => 'playing' | 'idle' | 'unknown' (optional; default
//                  () => 'unknown', the plain round-robin, as for a user
//                  without such a daemon). See WHO GETS THE TICK above.
//   idleEvery    — every how many ticks the idle users get one (default
//                  DEFAULT_IDLE_EVERY; a value that is not a whole number >= 2
//                  is replaced by the default, with one log line).
//   idleRest     — true: idle users get no tick at all.
// Besides start/stop/tickOnce/statusFor it hands out
//   roundSince(user, since) — read-only: how many live tabs were read or
//                  attempted since a moment (farm sessions, sessions.mjs).
//   prioritize(user, since) — a session round, above.
//   etaFor(user, since) — read-only: about how long until every live tab of
//                  the user was read once since a moment, from the steps
//                  still to take (a folder tab 1+N, once walked), the
//                  interval and the user's share of the ticks.
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
  presenceOf = () => 'unknown',
  idleEvery = DEFAULT_IDLE_EVERY,
  idleRest = false,
  now = () => Date.now(),
  log = console
} = {}) {
  // 1 would give every tick to the idle users and none to the players, 0 or a
  // fraction would never or irregularly match. numeric-settings.mjs refuses
  // them already; this protects callers without that table.
  if (!(Number.isInteger(idleEvery) && idleEvery >= 2)) {
    log.warn?.(`[networth-refresher] idleEvery ${String(idleEvery).slice(0, 20)} is not a whole number of at least 2 — using ${DEFAULT_IDLE_EVERY}`)
    idleEvery = DEFAULT_IDLE_EVERY
  }
  // Per-user in-memory state (survives across ticks, NOT across a restart):
  //   tabs           — last live tab list [{index,name,type,id}] from listTabs
  //   listFetchedAt  — when that list was fetched (drives the listTtl refetch)
  //   cooldownUntil  — set on a 429; the user is skipped until now() passes it
  //   pausedPoesessid— set on an auth failure; the user is skipped until the
  //                    reloaded creds carry a DIFFERENT poesessid (cookie renewed)
  //   walk           — a folder tab being read one sub-tab per tick, or null:
  //                    { tab, walk, startedAt, steps }. In memory for the same
  //                    reason everything else here is, and deliberately not in
  //                    the store (see the header note and folder-walk.mjs)
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
  // WHO GETS THE TICK: the tick counter the slow turns are taken from, and the
  // distribution the last tick found ('normal' | 'some-idle' | 'all-idle') with
  // the idle users it found, so a change is said once (log line, onStatus).
  // lastNames: the users of the last tick, for statusFor's 'rests' / 'yields'.
  let tickNo = 0
  let idleCursor = 0        // round-robin pointer of the idle users' slow turns
  let paceNow = 'normal'
  let idleNow = []
  let lastNames = []

  function getState (user) {
    let st = state.get(user)
    if (!st) { st = { tabs: null, listFetchedAt: 0, cooldownUntil: 0, pausedPoesessid: null, attempts: new Map(), walk: null, round: null, folderSizes: new Map() }; state.set(user, st) }
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
  // THE LATER OF THE TWO, NOT "STORED WINS", also for a tab with stored data:
  // a tab that HAS been synced before and now fails keeps its old `syncedAt`,
  // so with the stored stamp alone it would stay the stalest tab and be picked
  // again every tick, for ever, while no other tab came round. Taking
  // the maximum keeps every documented property (a success stamps a NEWER
  // syncedAt, so it still supersedes the attempt) and makes the timeline the
  // comment above claims: the last time anything was DONE about this tab.
  // `before` (a session round's moment): only the tabs nothing was done about
  // since then are candidates, and the stalest of them wins. Falls back to all
  // tabs when there is none (the round is complete then and ends).
  function pickStalest (user, st, before = null) {
    let best = null
    let bestAt = Infinity
    for (const t of st.tabs) {
      const at = timelineOf(user, st, t)
      if (before != null && at >= before) continue
      if (at < bestAt) { bestAt = at; best = t }
    }
    return best || (before != null ? pickStalest(user, st) : null)
  }

  // The last time anything was DONE about a tab: the later of its stored
  // reading and the last attempt (see pickStalest).
  function timelineOf (user, st, t) {
    const stored = store.getTab(user, t.index)
    const syncedAt = (stored && typeof stored.syncedAt === 'number') ? stored.syncedAt : -Infinity
    const attemptAt = st.attempts.has(t.index) ? st.attempts.get(t.index) : -Infinity
    return Math.max(syncedAt, attemptAt)
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

  // How far the round-robin has come for this user SINCE a moment: a live tab
  // counts once something was DONE about it at or after `sinceMs` — a stored
  // reading or an attempt, the same timeline pickStalest walks and coverageOf
  // counts on, so a tab that never yields a reading cannot hold a farm session
  // open for ever. Reads state only; it never causes a request.
  function roundSince (user, sinceMs) {
    const st = state.get(user)
    const tabs = st?.tabs || []
    let done = 0
    for (const t of tabs) if (timelineOf(user, st, t) >= sinceMs) done++
    return { done, total: tabs.length, complete: tabs.length > 0 && done === tabs.length }
  }

  // A SESSION ROUND (note above createNetworthRefresher): read every live tab
  // of `user` once at or after `sinceMs`, within the user's own ticks. Returns
  // roundSince for the moment in force. Never causes a request by itself.
  function prioritize (user, sinceMs) {
    const since = Number(sinceMs)
    if (!user || !Number.isFinite(since)) return null
    const st = getState(user)
    if (!st.round || since > st.round.since) st.round = { since }
    onStatus(user)
    return roundSince(user, st.round.since)
  }

  // The round in force for this user, or null; a complete one is ended here.
  function activeRound (user, st) {
    if (!st?.round) return null
    if (roundSince(user, st.round.since).complete) { st.round = null; return null }
    return st.round
  }

  // The share of the ticks this user gets, from the users and the presence the
  // tick decides with (WHO GETS THE TICK). 0 when the user gets none. An
  // auth-paused user hands every tick on to the next allowed user (tickOnce),
  // so the others share it. A user in a 429 cooldown is not left out: the
  // cooldown is global and at least as long as any user's (handleError), so
  // it is the wait in etaFor, and after it every user takes ticks again.
  function tickShare (user) {
    const st = state.get(user)
    if (st?.pausedPoesessid) return 0
    const known = lastNames.length ? lastNames : [user]
    if (!known.includes(user)) return 0
    const names = known.filter(u => u === user || !state.get(u)?.pausedPoesessid)
    const idle = names.filter(u => presenceOf(u) === 'idle')
    if (!idle.length) return 1 / names.length
    if (idle.length === names.length) return idleRest ? 0 : 1 / (idleEvery * names.length)
    if (idle.includes(user)) return idleRest ? 0 : 1 / (idleEvery * idle.length)
    return (idleRest ? 1 : 1 - 1 / idleEvery) / (names.length - idle.length)
  }

  // A folder tab's size is kept by its id, which a reordering of the tabs
  // does not change (the index does).
  const folderKey = tab => (tab.id != null ? `id:${tab.id}` : `index:${tab.index}`)

  // About how long until every live tab of the user was read once since
  // `sinceMs`: the steps still to take, over the user's share of the ticks,
  // times the interval, after a cooldown that is running. A folder tab takes
  // 1+N steps (its sub-tab list, then one sub-tab per step); N is known from
  // its last walk since the server started, and before that the tab counts as
  // one step, so the estimate is too low until then. `remaining` counts tabs,
  // `steps` steps; `ms` is null when there is no answer (no tab list yet, or no
  // tick for this user).
  function etaFor (user, sinceMs) {
    const r = roundSince(user, sinceMs)
    if (r.complete) return { done: r.done, total: r.total, remaining: 0, steps: 0, ms: 0 }
    const remaining = r.total - r.done
    const st = state.get(user)
    let steps = 0
    for (const tab of st?.tabs || []) {
      if (timelineOf(user, st, tab) >= sinceMs) continue
      steps += 1 + (st.folderSizes.get(folderKey(tab)) || 0)
    }
    const share = tickShare(user)
    if (!r.total || !(share > 0)) return { done: r.done, total: r.total, remaining: r.total ? remaining : null, steps: r.total ? steps : null, ms: null }
    const t = now()
    const wait = Math.max(0, globalCooldownUntil - t, (st?.cooldownUntil || 0) - t)
    return { done: r.done, total: r.total, remaining, steps, ms: wait + Math.ceil(steps / share - 1e-9) * intervalMs }
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
      // is a skip like the ones below, separated from them because stored as
      // an empty tab it would make the recorder read a whole tab's stock as
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
    // A session round lets an aged list wait as well (A SESSION ROUND, above
    // createNetworthRefresher).
    const round = activeRound(user, st)
    const needList = !inWalk && (!st.tabs || st.tabs.length === 0 || (listAge >= listTtlMs && !round))

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
        // which route to take in the first place. Trimmed to {index,name},
        // those two tabs arrive empty.
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
      const target = inWalk ? st.walk.tab : pickStalest(user, st, round ? round.since : null)
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
      // beginning on a later turn — the same requests an all-in-one step would
      // spend again after the same failure, not more.
      //
      // "FAILED" INCLUDES A WALK THAT FINISHED WITHOUT ANSWERS. A sub-tab can
      // reply 200 with a body that carries no items array; finishing such a
      // walk normally would write its subset as the whole tab (docs/bugs.md
      // B2). finishFolderWalk throws `kind:'unread'` for it, so it
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
      // A session round moves with every step of its user, and ends with one:
      // the status line says how far it has come (statusFor `sessionRound`).
      if (round) { activeRound(user, st); onStatus(user) }
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
    // Its size, for the next estimate of a session round (etaFor).
    if (folderWalkTotal(entry.walk) != null) st.folderSizes.set(folderKey(tab), folderWalkTotal(entry.walk))
    if (!folderWalkFinished(entry.walk)) return   // one request spent; the rest on following turns

    // Complete. `finishFolderWalk` owns the B7 yield line, so a walk driven
    // tick by tick reports exactly what one driven in a loop reports.
    const items = finishFolderWalk(entry.walk, log)
    const heldSec = Math.round((now() - entry.startedAt) / 1000)
    st.walk = null
    // The closing bracket of a folder tab (docs/bugs.md B5). Unconditional and
    // once per folder-tab TURN — two lines per full round on an account with a
    // unique and a map stash.
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

      // WHO GETS THE TICK (header). Decides whose step this is, or that there
      // is none; never a second one. Without an 'idle' answer `allowed` stays
      // null and the loop below is the round-robin it always was.
      tickNo++
      lastNames = names
      const idle = names.filter(u => presenceOf(u) === 'idle') // names are sorted, so idle is too
      const slowTurn = !idleRest && tickNo % idleEvery === 0
      const pace = !idle.length ? 'normal' : idle.length === names.length ? 'all-idle' : 'some-idle'
      // The edge is the SET of idle users, not only the mode: a hold after a game
      // ends (no presence edge of its own) changes the set within one mode.
      if (pace !== paceNow || idle.join('\n') !== idleNow.join('\n')) {
        const modeChanged = pace !== paceNow
        if (modeChanged) {
          log.log?.(`[networth-refresher] pace ${paceNow} -> ${pace}` + (pace === 'some-idle'
            ? ': users whose game is not running yield their turns (one step per tick, as before)'
            : pace === 'all-idle'
              ? (idleRest ? ': no game running anywhere, syncing rests' : `: no game running anywhere, one step every ${idleEvery} ticks`)
              : ''))
        }
        const before = new Set(idleNow)
        paceNow = pace
        idleNow = idle
        for (const u of names) if (modeChanged || before.has(u) !== idle.includes(u)) onStatus(u)
      }
      let allowed = null                                          // null: today's behaviour
      if (pace === 'some-idle') allowed = new Set(slowTurn ? idle : names.filter(u => !idle.includes(u)))
      else if (pace === 'all-idle') allowed = slowTurn ? null : new Set()
      if (allowed && !allowed.size) return                        // a resting tick

      // A slow turn of the idle users walks its own pointer, so the players'
      // round-robin goes on where it was and is not reset by it.
      const idleTurn = pace === 'some-idle' && slowTurn
      const from = idleTurn ? idleCursor : cursor
      for (let i = 0; i < names.length; i++) {
        const u = names[(from + i) % names.length]
        if (allowed && !allowed.has(u)) continue                  // not this user's tick
        const st = getState(u)
        if (st.pausedPoesessid) continue          // auth-paused
        if (now() < (st.cooldownUntil || 0)) continue // rate-limit cooldown
        if (idleTurn) idleCursor = (from + i + 1) % names.length
        else cursor = (cursor + i + 1) % names.length
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
    // B5: these two fields tell "syncing along nicely" from "one step has been
    // stuck for ten minutes", which `state: 'ok'` alone cannot. Both are
    // OPTIONAL — omitted when there is nothing to say — so a fresh, idle
    // refresher still answers plainly `{ state: 'ok' }`.
    const lastTab = lastTabWritten(user)
    if (lastTab) out.lastTab = lastTab
    const step = currentStepFor(user)
    if (step) out.current = step
    // A folder tab being walked one sub-tab per tick. A walk is not a step, so
    // between two ticks `current` is null and nothing else reports that a
    // folder tab is half-read. Always
    // this user's own walk — `state.get(user)` is their own state — so no tab
    // name crosses a room.
    // A session round in progress (prioritize): how many of the user's live
    // tabs were read since the session's start or end.
    // Not before the tab list is known: "0 of 0" says nothing.
    const round = activeRound(user, st)
    if (round) {
      const r = roundSince(user, round.since)
      if (r.total > 0) out.sessionRound = { done: r.done, total: r.total, since: round.since }
    }
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
    // WHO GETS THE TICK, for a user whose game is not running. From the
    // presence answers NOW, not from the last tick: a status sent right after
    // a presence edge (or during a cooldown, when no tick chooses) is right.
    // everyMs is the spacing of the idle GROUP, so the page says "about".
    if (presenceOf(user) === 'idle') {
      const names = lastNames.length ? lastNames : [user]
      const allIdle = names.every(u => presenceOf(u) === 'idle')
      out.pace = { mode: allIdle ? 'rests' : 'yields', everyMs: idleRest ? 0 : idleEvery * intervalMs }
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

  return { start, stop, tickOnce, statusFor, roundSince, prioritize, etaFor, pace: () => paceNow }
}
