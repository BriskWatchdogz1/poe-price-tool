// backend/v2/networth/stash-pacer.mjs
// How long to wait between two stash requests — DERIVED from the limits GGG
// publishes in every stash response, instead of guessed at as a constant. It
// sends nothing, retries nothing and asks GGG nothing: it reads rules off
// responses that arrived anyway and returns a number of milliseconds.
//
// THE RULES are the ones stash-client.mjs `noteRateLimitRules` logs, one set
// per endpoint group; the measured sets (and the stricter `Ip`-only form an
// unauthenticated request gets) are listed at the rule table in
// createStashPacer. There are `Ip` rules: the budget hangs off the address, not
// only the session. Why a flat 1500ms is too fast for them (89% of `Ip
// 45/60s`; the map stash's 31 requests in 46s past `Account 30/300s`) is
// measured in docs/admin.md, "The pace between two stash requests".
//
// THE PACE. Every rule states a mean rate: `hits` per `windowSec` is one
// request every `windowSec/hits` seconds, held over the window plus its bucket
// (bucketSecFor). The strictest rule wins, a SHARE of it is all this tool
// claims, and the base spacing (baseMs, 1500ms) is the floor, so the
// derivation can only lengthen the wait, whatever the headers or shares say:
//
//     spacing = max( baseMs, max over rules of
//                    (windowSec + bucketSec)*1000 / (hits*share) )
//
// The published number is where GGG bans, not a target. `Ip` gets HALF: the
// address is shared with everything else leaving it (the household's browser on
// pathofexile.com, this app's OWN trade path, not counted here). `Account` gets
// three quarters, the rest left for the operator's own logged-in browsing. An
// unknown rule name is treated as `Ip`: a scope never seen is not one to assume
// as its own. On the measured set the binding rule is `Account 100/1800s`
// (24.8s a request) ahead of `Ip 180/1800s` (20.7s).
//
// THE STATE IS MODULE-LEVEL, process-wide and shared by every client and USER,
// like `seenRuleSets` in stash-client.mjs: an `Ip` budget belongs to the
// address, server.mjs builds a fresh stash client every tick, and an 1800s
// window outlives any number of ticks. One pacer is safe because the refresher
// is strictly sequential (`busy`-guarded): on one stream a minimum spacing IS a
// maximum rate.

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
 * no policy header keys under the empty string and is treated as pure union
 * (added to, never replaced).
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
  // has no way out at all, and the production log says what that costs. Over
  // two days one account on one address was answered with three different sets:
  //
  //   12.08. 14:12 UTC  Account 30/60s ban 60s,  Account 100/1800s ban 600s,
  //                     Ip      45/60s ban 120s, Ip      180/1800s ban 600s
  //   12.08. 14:13 UTC  Account 15/10s ban 60s,  Account 30/300s ban 300s
  //   13.08. 02:15 UTC  Ip 30/60s ban 120s, Ip 90/1800s ban 600s,
  //                     Ip 180/7200s ban 3600s
  //   13.08. 11:28 UTC  the 14:12 set again
  //
  // The 02:15 set derives an 80s spacing. With nothing ever removed, the tool
  // still held to 80s at 11:28 — hours after GGG had gone back to publishing
  // the set that asks for 24s — and would have until a restart (docs/bugs.md
  // B16). Strictly one-way: any single strict answer, whatever produced it,
  // is permanent, and an address change (nightly on plenty of domestic lines,
  // and it resets the `Ip` counters) does not help.
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
  // published: that request really was measured against them. What it must not
  // do is hold on to them afterwards, which is what this key prevents.
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
  // A response with NO policy header is added to the union and never replaces
  // anything. A header that is not there
  // must not be able to make two endpoints look like one budget and take the
  // 1800s window away from a folder-tab walk.
  const rules = new Map()
  // When the last request was SENT (not answered): the request is what counts
  // against a window, so that is what the spacing is measured from.
  let lastRequestAt = null
  // Earliest time the next request may go out because of a REACTIVE brake —
  // delayFor()'s answer to a state counter that is near or at its limit. The
  // client sleeps that value inside its own step already; keeping it here is
  // what makes it survive into the next tick's fresh client, which starts
  // without the previous client's header state.
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
