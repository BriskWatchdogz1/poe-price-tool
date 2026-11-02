// backend/v2/networth/stash-pacer.mjs
// How long to wait between two stash requests — DERIVED from the limits GGG
// publishes in every stash response, instead of guessed at as a constant.
//
// WHAT WAS MEASURED. Since the stash path started logging the rule set it is
// answered with (stash-client.mjs `noteRateLimitRules`), the limits are no
// longer a matter of opinion. Two rule sets come back, one per endpoint group:
//
//   Account 30/60s ban 60s,  Account 100/1800s ban 600s,
//   Ip      45/60s ban 120s, Ip      180/1800s ban 600s
//   Account 15/10s ban 60s,  Account 30/300s  ban 300s
//
// …AND A THIRD ONE ARRIVED LATER, which is why the rule table has a way out of
// it now. On 13.08. at 02:15 UTC the same account on the same address was
// answered `Ip 30/60s ban 120s, Ip 90/1800s ban 600s, Ip 180/7200s ban 3600s`
// — stricter across the board, with a two-hour window nothing had published
// before — and at 11:28 UTC the set of 14:12 was back. That third set is the
// SAME policy answering an unauthenticated request, not a penalty; see the note
// on the rule table in createStashPacer for the evidence and for what its
// permanence cost while the table only ever grew.
//
// AND THE NUMBERS ARE NOT AIMED AT THIS DEPLOYMENT. The authenticated set above
// is digit for digit the one a third party measured on 18.07.2026 from another
// account, another address and another continent: it is what GGG ships to
// everybody. Nothing in this file is a reaction to a punishment, and there is
// none to react to — GGG's penalties are binary (a timed lock, a withdrawn
// credential, a Cloudflare block), never a quietly smaller set of numbers.
//
// Read as "hits allowed / window / how long the ban lasts if you exceed it".
// Two things in there decide this whole module:
//
//   1. THERE ARE `Ip` RULES. The budget hangs off the address, not only off the
//      session — which is the same thing the one incident this repository has
//      an operator's account of said: a ban applied to the whole address and
//      ended by taking a new one, not by sitting out an account penalty.
//   2. THE CONSTANT WAS AT 89% OF ONE OF THEM. The base pace inside a step was
//      1500ms, i.e. 40 requests a minute, against `Ip 45/60s`. The existing
//      brake in delayFor() only opens at 80% of a window — and it is REACTIVE:
//      it reads a state counter off a response, so the requests it reacts to
//      are already out. Nothing was ahead of the limit; something was behind it.
//
// AND THE LONG WINDOWS ARE THE ONES THAT WERE NEVER COUNTED. `Ip 180/1800s` is
// 6 requests a MINUTE averaged over half an hour, and `Account 100/1800s` is
// 3.3 a minute. The ordinary cadence (one step every 30s = 60 requests per
// 1800s) fits inside both. A folder tab does not: it spends 1+N requests inside
// ONE step, and the map stash was measured at 30 sub-tabs = 31 requests in 46s
// at the old pace.
//
// That burst was already past a published limit, with no assumption needed to
// see it: a folder tab is walked on the second endpoint, whose own rules are
// `Account 15/10s` and `Account 30/300s`, and 31 requests inside 46s is past
// 30/300s on its own — before the unique stash's 19 on the next turn are
// counted. Against the FIRST endpoint's windows the same burst only counts if
// the two rule sets are less separate than they look: on an 18-tab account the
// round-robin reaches both folder tabs about three times per half hour, ~214
// requests per 1800s, of which only ~52 go to that endpoint. So its `Account
// 100/1800s` is safe under the strict reading, and `Ip 180/1800s` is exceeded
// under the conservative one. Nothing in the headers decides between them, and
// the ban this deployment actually saw reached the whole address.
//
// SO THE PACE IS DERIVED, NOT DECLARED. Every rule states a mean rate the tool
// may not exceed: `hits` per `windowSec` is one request every
// `windowSec/hits` seconds. The strictest rule wins, a SHARE of it is all this
// tool claims (see below), and the old constant stays underneath as the floor:
//
//     spacing = max( baseMs, max over rules of  windowSec*1000 / (hits*share) )
//
// The floor is what makes this change unable to send MORE in any constellation,
// whatever the headers say and whatever the shares are set to: the derivation
// can only ever lengthen the wait the client already took.
//
// WHY A SHARE AND NOT THE WHOLE LIMIT. The published number is the point at
// which GGG bans, not a target to run at. Two shares, because the two rule
// names do not mean the same thing:
//
//   `Ip`      — shared with everything else leaving this address: the household's
//               own browser on pathofexile.com, and this app's OWN trade path,
//               which spends the same address and is not counted here. The tool
//               cannot see any of that, so it claims HALF and leaves the rest to
//               traffic it has no way to measure.
//   `Account` — spent by this session. The operator's own logged-in browsing is
//               the only other plausible consumer, so three quarters, with the
//               remainder left for it.
//
// An unknown rule name is treated as `Ip`: a scope this code has never seen is
// exactly the one it must not assume it has to itself.
//
// Note that "Ip is taken more strictly" is about the SHARE, not about which rule
// ends up binding. On the measured set the binding rule is `Account 100/1800s`
// (18s/request at 0.75 = 24s) ahead of `Ip 180/1800s` (10s/request at 0.5 =
// 20s), because GGG's account rule is the tighter rate to begin with. All of
// them are honoured at once; that is what taking the maximum means.
//
// WHY THE STATE LIVES HERE, AT MODULE LEVEL, AND NOT IN THE CLIENT. The server
// builds a fresh stash client every tick (server.mjs: "the 30s interval IS the
// pacing, so the client's per-request backoff state isn't needed across ticks").
// That reasoning holds for a step of one request and breaks for a folder tab:
// 31 requests inside one step are not paced by a 30s tick, and the 1800s window
// they land in outlives any number of ticks. The pacer is therefore process-wide
// and shared by every client — the same shape `seenRuleSets` in stash-client.mjs
// already has, and for a stronger reason: an `Ip` budget belongs to the process
// (to the address), not to a client instance, and it is shared across USERS too,
// which a per-client pacer could not express. Making it a constructor argument
// server.mjs has to pass would mean a forgotten argument silently removes the
// protection; a shared default cannot be forgotten.
//
// It is safe to have one because the refresher is strictly sequential — one step
// at a time, one request at a time, `busy`-guarded. Nothing here parallelises
// anything, and on that single stream a minimum spacing IS a maximum rate:
// at 24s the whole process cannot exceed 75 requests per 1800s, whatever a
// folder tab does inside one step.
//
// WHAT THIS MODULE DOES NOT DO: send anything, retry anything, or ask GGG
// anything. It reads rules off responses that arrived anyway, and returns a
// number of milliseconds to the caller.

import { envNum } from '../numeric-settings.mjs'

/**
 * The share of a published rule this tool will spend, by rule name. Read per
 * derivation rather than once at import: these are ordinary environment
 * settings, and reading them live keeps a corrected value from needing a
 * restart. env-number.mjs reports an unusable value once, not once per request.
 */
function defaultShareOf (ruleName) {
  return ruleName === 'Account'
    ? envNum('POE_STASH_ACCOUNT_BUDGET_SHARE')
    : envNum('POE_STASH_IP_BUDGET_SHARE')
}

/**
 * How long a rule keeps counting after GGG last published it. Read live, for
 * the same reason the shares are: a corrected value should not need a restart.
 * See numeric-settings.mjs for why the floor is the longest observed window.
 */
function defaultRuleTtlMs () { return envNum('POE_STASH_RULE_TTL_MS') }

/**
 * bucketSecFor(windowSec) -> the RESOLUTION of the window, in seconds.
 *
 * GGG does not count requests at the instant they arrive; it buckets them, and
 * the bucket size is in no header at all. From GGG's own support, to the
 * gerwaric/acquisition project, about a stash policy:
 *
 *   "That particular policy has a resolution of 5 seconds, which means that it
 *    buckets incoming requests in 5 second intervals. To be safe you'd have to
 *    add 5 more seconds rather than 2. This isn't exposed anywhere for you to
 *    have known."
 *
 * For the stash and character policies that is 5 seconds on the short limit and
 * one minute on the sustained one. WHAT IT MEANS FOR A MEAN RATE: a limit of
 * "45 per 60s" is summed over whole buckets, so the span it actually covers is
 * anything from 60s to 60s+bucket depending on where the present moment falls
 * inside the current bucket. The safe reading is the longer one — the rate has
 * to hold for `windowSec + bucketSec`, not for `windowSec`. That is why this is
 * added to the WINDOW rather than to the derived spacing: it is the window that
 * is uncertain, and adding a whole minute to every gap would be a slowdown
 * nothing here argues for.
 *
 * On the measured set the surcharge is 3.3% (24.0s -> 24.8s). It can only ever
 * lengthen a wait; that is the direction this file is allowed to move in.
 *
 * WHICH BUCKET APPLIES IS DERIVED, NOT A THIRD NUMBER: a window no longer than
 * the sustained limit's own bucket cannot be a sustained limit. On every set
 * seen so far that splits exactly where it should — 10s and 60s take the short
 * bucket, 300s, 1800s and 7200s the long one.
 */
export function bucketSecFor (windowSec, {
  shortSec = envNum('POE_STASH_BUCKET_SHORT_SEC'),
  longSec = envNum('POE_STASH_BUCKET_LONG_SEC')
} = {}) {
  const short = Number(shortSec) > 0 ? Number(shortSec) : 0
  const long = Number(longSec) > 0 ? Number(longSec) : 0
  return windowSec <= long ? short : long
}

// A pathological server that varies its window lengths — or its policy names —
// per response must not be able to grow the rule table without bound. Past the
// cap the known rules keep being UPDATED but no new ones are added, and the
// rules a policy replaces are removed before this is consulted, so a policy
// restating its own set never trips it. Same guard and same number as
// MAX_LOGGED_RULE_SETS in stash-client.mjs. It is a memory bound, not a dial:
// the measurement shows nine distinct rules across three sets.
const MAX_TRACKED_RULES = 20

/**
 * The minimum spacing between two requests that honours EVERY rule at once,
 * floored at `baseMs`. Pure function — the unit the assurances are tested on.
 *
 * A rule with no hits, no window, or a share that is not a positive number
 * contributes nothing rather than an Infinity: a malformed header must not be
 * able to stop the refresher, and the floor still applies.
 *
 * The window a rate is derived against is `windowSec + bucketSec`, never the
 * published `windowSec` on its own — see bucketSecFor above for the quote that
 * is from.
 */
export function minSpacingMs (rules, {
  baseMs, shareOf = defaultShareOf, bucketSecOf = bucketSecFor
} = {}) {
  let spacing = baseMs
  for (const r of rules || []) {
    const share = shareOf(r?.rule)
    if (!(r?.hits > 0) || !(r?.windowSec > 0) || !(share > 0)) continue
    const bucketSec = Math.max(0, Number(bucketSecOf(r.windowSec)) || 0)
    const perRequest = ((r.windowSec + bucketSec) * 1000) / (r.hits * share)
    if (perRequest > spacing) spacing = perRequest
  }
  return spacing
}

/**
 * The identity of a rule: which BUDGET it belongs to, then which rule name and
 * window inside it. "stash-request-limit\0Ip:60".
 *
 * The policy is what makes the table two-way rather than one-way — see the
 * WHY THE POLICY IS PART OF THE KEY note in createStashPacer. A response with
 * no policy header keys under the empty string, which is exactly the pre-policy
 * key, and is treated as pure union (added to, never replaced).
 */
function ruleKey (policy, r) { return `${policy ?? ''}\0${r.rule}:${r.windowSec}` }

/** The policy a parsed response names, or null. Blank is the same as absent. */
function policyOf (parsed) {
  const p = typeof parsed?.policy === 'string' ? parsed.policy.trim() : ''
  return p || null
}

/**
 * createStashPacer({ now, shareOf, ruleTtlMs }) -> pacer
 *
 * Remembers what GGG has published and when the last request went out, and
 * answers the only question the client asks: how long before the next one.
 */
export function createStashPacer ({
  now = () => Date.now(), shareOf = defaultShareOf, ruleTtlMs = defaultRuleTtlMs
} = {}) {
  // policy + rule name + window -> the limit last published for it, with the
  // time it was last published. The UNION ACROSS POLICIES, not the last
  // response's set on its own: the stash path talks to two endpoints with two
  // different rule sets, and swapping one for the other every time a folder tab
  // is walked would drop the very window (1800s) that the walk is at risk of
  // filling. Which counter a request actually lands in is not knowable from
  // here, so every rule known is honoured for every request.
  //
  // WHY THE POLICY IS PART OF THE KEY. Keyed on `rule:window` alone the table
  // had no way out at all, and the production log says what that costs. Over
  // two days one account on one address was answered with three different sets:
  //
  //   12.08. 14:12 UTC  Account 30/60s ban 60s,  Account 100/1800s ban 600s,
  //                     Ip      45/60s ban 120s, Ip      180/1800s ban 600s
  //   12.08. 14:13 UTC  Account 15/10s ban 60s,  Account 30/300s ban 300s
  //   13.08. 02:15 UTC  Ip 30/60s ban 120s, Ip 90/1800s ban 600s,
  //                     Ip 180/7200s ban 3600s
  //   13.08. 11:28 UTC  the 14:12 set again
  //
  // The 02:15 set derives an 80s spacing. Because nothing was ever removed, the
  // tool was still holding to 80s at 11:28 — hours after GGG had gone back to
  // publishing the set that asks for 24s, and it would have kept doing so until
  // the process was restarted. Strictly one-way: any single strict answer,
  // whatever produced it, was permanent. An address change (nightly on plenty of
  // domestic lines, and it resets the `Ip` counters) did not help either.
  //
  // WHAT THE 02:15 SET ACTUALLY IS, because it decides how to read all of this:
  // NOT a penalty. It is the SAME policy answering an UNAUTHENTICATED request.
  // The gerwaric/acquisition project measured the same thing on the same legacy
  // endpoint (28.07.2026): one policy name, an `Ip`-only form without a valid
  // POESESSID and an `Account,Ip` form with one. A GGG web developer said the
  // same in the official forum in 2018 — with a session id the budget is counted
  // per account, and the address limit is then twice as generous. Our own two
  // forms are exactly that, digit for digit: Ip/60s 30 -> 45 (1.5x), Ip/1800s
  // 90 -> 180 (2x), and the Account rules present in one form and absent in the
  // other. 02:15 UTC is a night-time round with an expired cookie nobody was
  // awake to notice.
  //
  // So the strict form is not something to pace around quietly — it is a dead
  // session, and stash-client.mjs says so out loud when the `Account` rules
  // disappear from a policy that had them (`noteSessionScope`). The pacing side
  // is still right to honour the Ip-only limits while they are what GGG
  // published: that request really was measured against them. What was wrong was
  // never letting go of them afterwards, which is what this key fixes.
  //
  // The policy is the field that says which of these are the SAME budget being
  // restated and which are different budgets standing side by side, and that is
  // GGG's own documented meaning of it rather than a convenient reading:
  // "Policies may be the same across different API endpoints but are treated
  // the same for rate limiting purposes." Same policy name, one counter;
  // different names, independent counters. With it in the key, a response
  // REPLACES the set of its own policy and leaves every other policy alone: the
  // folder-tab endpoint keeps its windows while the ordinary endpoint's set is
  // corrected, and a rule GGG has stopped publishing stops counting. Getting
  // FASTER is only ever GGG's decision, never a lapse of memory — that is the
  // whole difference between this and expiry.
  //
  // A response with NO policy header keeps the old behaviour exactly: it is
  // added to the union and never replaces anything. A header that is not there
  // must not be able to make two endpoints look like one budget and take the
  // 1800s window away from a folder-tab walk.
  const rules = new Map()
  // When the last request was SENT (not answered): the request is what counts
  // against a window, so that is what the spacing is measured from.
  let lastRequestAt = null
  // Earliest time the next request may go out because of a REACTIVE brake —
  // delayFor()'s answer to a state counter that is near or at its limit. The
  // client sleeps that value inside its own step already; keeping it here is
  // what makes it survive into the next tick's fresh client, where it used to be
  // discarded along with the rest of the header state.
  let notBefore = 0

  /**
   * Drop what GGG has not published for long enough that it cannot still be
   * counting. THE FALLBACK, not the mechanism: the policy key above answers
   * within one response, and this only covers what a key cannot — a policy that
   * is never asked again, and a response that carries no policy header at all,
   * where the union has no other way out.
   *
   * A rule is kept for the LONGER of the configured TTL and its own window, and
   * the second half is the arithmetic one: a request of ours can still be
   * inside a window of length W for W after it was sent, and a rule is only
   * ever published in the answer to a request — so a set younger than its own
   * longest window may still be counting requests we made. That floor holds
   * whatever the dial says, which is what keeps a future rule with a window
   * longer than anything observed safe without this number being kept current.
   *
   * Lazy, at read time rather than on a timer: this module owns no clock (`now`
   * is injected), so a test moves time instead of waiting for it.
   */
  function dropExpired (t) {
    const ttl = ruleTtlMs()
    for (const [key, r] of rules) {
      const keepForMs = Math.max(Number(ttl) > 0 ? ttl : 0, r.windowSec * 1000)
      if (t - r.seenAt > keepForMs) rules.delete(key)
    }
  }

  // A plain function rather than a method, so a destructured `waitMs` cannot
  // lose its `this` and silently answer with the constant.
  const spacing = baseMs => {
    dropExpired(now())
    return minSpacingMs([...rules.values()], { baseMs, shareOf })
  }

  return {
    /** Learn (or re-learn) the limits off a parsed response. */
    noteRules (parsed) {
      const t = now()
      dropExpired(t)
      const policy = policyOf(parsed)
      const incoming = (parsed?.rules || []).filter(r => r?.hits > 0 && r?.windowSec > 0)
      // A response with NO usable rule headers leaves the known rules standing
      // — including its own policy's. Losing them would silently drop the pace
      // back to the constant, which is the direction that sends more, and a
      // missing header is not GGG saying the budget is gone.
      if (!incoming.length) return
      if (policy != null) {
        // This response is the whole truth about ITS budget: whatever that
        // policy no longer publishes is no longer counted. Every other policy
        // is untouched — that is what keeps the folder-tab endpoint's windows
        // standing while the ordinary endpoint's set is corrected.
        const published = new Set(incoming.map(r => ruleKey(policy, r)))
        for (const [key, r] of rules) {
          if (r.policy === policy && !published.has(key)) rules.delete(key)
        }
      }
      for (const r of incoming) {
        const key = ruleKey(policy, r)
        if (!rules.has(key) && rules.size >= MAX_TRACKED_RULES) continue
        rules.set(key, { rule: r.rule, hits: r.hits, windowSec: r.windowSec, policy, seenAt: t })
      }
    },
    /** A request is going out NOW. Called immediately before the fetch. */
    noteRequest () { lastRequestAt = now() },
    /** A header-derived backoff of `ms`, so it outlives the client that got it. */
    noteBrake (ms) {
      if (!(ms > 0)) return
      notBefore = Math.max(notBefore, now() + ms)
    },
    /** The derived minimum spacing, floored at the constant. For the log. */
    spacingMs: baseMs => spacing(baseMs),
    /**
     * How long the caller must wait before its next request, in ms.
     *
     * 0 when nothing has been sent yet (there is nothing to space away from)
     * and 0 once enough time has passed anyway — which is the ordinary case
     * between two ticks, so the derived pace costs the normal cadence nothing.
     */
    waitMs: baseMs => {
      const t = now()
      const sinceLast = lastRequestAt == null ? Infinity : t - lastRequestAt
      const fromSpacing = Math.max(0, spacing(baseMs) - sinceLast)
      const fromBrake = Math.max(0, notBefore - t)
      return Math.round(Math.max(fromSpacing, fromBrake))
    },
    /** What has been learnt, for tests and for the log line. */
    knownRules () { dropExpired(now()); return [...rules.values()] },
    /** Forget everything. Tests, and nothing else. */
    reset () { rules.clear(); lastRequestAt = null; notBefore = 0 }
  }
}

/**
 * The one pacer of this process. Every stash client uses it unless a test hands
 * one in — see the note on module-level state above: the budget belongs to the
 * address, so it cannot belong to a client that lives for one tick.
 */
export const sharedStashPacer = createStashPacer()

/** Forget what the shared pacer has learnt. Tests only. */
export function resetStashPacer () { sharedStashPacer.reset() }
