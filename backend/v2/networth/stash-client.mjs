// backend/v2/networth/stash-client.mjs
// Legacy stash API (POESESSID path): character-window/get-stash-items.
//   ?...&tabs=1                -> tab list ({ numTabs, tabs:[{ n, i, type }] })
//   ?...&tabIndex=N&tabs=0     -> items of one tab ({ items:[...] })
// Rate-limit discipline: GGG communicates limits ONLY via response headers
// (X-Rate-Limit-Rules / X-Rate-Limit-<Rule> "hits:window:ban" /
//  X-Rate-Limit-<Rule>-State / Retry-After on 429). Therefore: strictly
// sequential, parse the headers after EVERY response and derive the pause
// before the next request from them. Repeated 4xx (invalid-request threshold)
// -> abort instead of hammering away. The cookie value never appears in any message.
//
// A 429 IS NOT RETRIED HERE. Sleeping Retry-After+1 (capped at 90s) and trying
// again up to `maxRetries` times would fire up to SIX requests into a throttle
// GGG has already declared, before the refresher's ten-minute cooldown gets a
// say. The client propagates the very first 429 as kind:'ratelimit' with the
// Retry-After it was given, and the caller (networth/refresher.mjs) owns the
// wait: one request per 429, and the wait is a state the operator can SEE — a
// cooldown with an end time in the status line — rather than a sleep inside a
// fetch. This repository has two real Trade-API bans behind it; nothing in the
// stash path answers a throttle with more traffic.
//
// The pacing derived from the state counters (delayFor) is a different thing
// and keeps its cap: see MAX_PACING_SLEEP_MS below.
//
// TWO PACING MECHANISMS, AND THEY ARE NOT THE SAME ONE. delayFor() reads the
// STATE counters and brakes once a window is already filling up — reactive, by
// construction, because a counter can only be read off a response the requests
// are already behind. stash-pacer.mjs reads the LIMITS and derives the spacing
// the tool holds to before any of that: `Ip 45/60s` says one request every
// 1.33s is the ceiling, the constant below said 1.5s, and 40 requests a minute
// against a limit of 45 is not a margin. The derivation is ahead of the limit,
// the brake is behind it, and the client takes the longer of the two.

import { parseRateLimitHeaders } from '../rate-limit-headers.mjs'
import { envNum } from '../numeric-settings.mjs'
import { sharedStashPacer, bucketSecFor } from './stash-pacer.mjs'
import { walkFolderTab } from './folder-walk.mjs'
import { noteSubTabShape } from './subtab-shape.mjs'
import { planFolderChildren } from './map-sections.mjs'

const STASH_BASE = 'https://www.pathofexile.com/character-window/get-stash-items'
// Browser-like UA — Cloudflare blocks generic agents (the same string the
// trade searches send, BROWSER_UA in shims/ipc-host.mjs).
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36'

const CONSECUTIVE_TAB_FAIL_LIMIT = 3

// Newer stash endpoint of the website (same cookie session, no OAuth). Only it
// knows the sub-folders of the folder tabs:
//   GET /api/stash/<league>/<tabId>            -> { stash: { children:[{id,…}] } }
//   GET /api/stash/<league>/<tabId>/<childId>  -> { stash: { items:[…] } }
// Without an ID (/api/stash/<league>) it answers 403 — the tab LIST still
// comes from the old endpoint.
const STASH_V2_BASE = 'https://www.pathofexile.com/api/stash'

// Tab types whose items live exclusively in sub-folders. The old endpoint
// always returns an empty items array for them (measured, not assumed:
// subIndex=0/1 and tabs=1 return a byte-identical items=0, and the tab ID gets
// answered with a 404).
const CHILDED_TAB_TYPES = new Set(['UniqueStash', 'MapStash'])

// The header parser moved to ../rate-limit-headers.mjs: the trade audit needs
// the same one, and importing it out of THIS file closed a cycle (see the note
// there). Re-exported so every caller and test keeps its one import.
export { parseRateLimitHeaders }

// ---------------------------------------------------------------------------
// Which rules the stash budget is actually measured by — pure observation.
//
// The stash path has no bookkeeping at all (trade-audit.mjs covers /api/trade/*
// only), so after an incident the log said nothing about it. The cheapest thing
// that changes that is already in hand: every stash response carries the rule
// set, and the RULE NAMES answer the question the code cannot: `Ip` means the
// budget is shared with everything else leaving this address (the household's
// browser on pathofexile.com included), `Account` means it belongs to that one
// POESESSID. Nothing here sends, delays or retries anything — it reads headers
// that arrived anyway.
//
// Only the LIMITS are fingerprinted, never the state counters: the counters
// change on every response, so including them would be a line per request.
//
// FREQUENCY IN NORMAL OPERATION: one line per process. The set is module-level
// (the server builds a fresh client every tick, so per-instance memory would
// mean a line every 30s round the clock) and holds every rule set already
// reported, so a set that flips back and forth costs one line per DISTINCT set
// and then stays quiet forever. GGG changing its published limits is the only
// thing that produces a second line, which is exactly the event worth seeing.
const seenRuleSets = new Set()
// A pathological server that varies its limits per response must not be able to
// grow this set — or the log — without bound. Past the cap the observation goes
// quiet rather than becoming the noise it exists to avoid.
const MAX_LOGGED_RULE_SETS = 20

/** "Account 45/60s ban 60s, Account 240/240s ban 900s", or '' when there are none. */
function describeRules (rules) {
  return rules.map(r => `${r.rule} ${r.hits}/${r.windowSec}s ban ${r.banSec}s`).join(', ')
}

/**
 * Log the rule set of a parsed stash response the first time it is seen.
 * Observation only — it returns nothing and changes no pacing.
 *
 * `spacingMs`, when given, is the pace stash-pacer.mjs derives from these rules
 * (see there). It belongs on this line rather than on one of its own: "what GGG
 * published" and "what this tool does about it" are one event, and the second
 * half is the one that can be checked against the first.
 */
export function noteRateLimitRules (parsed, log = console, spacingMs = null) {
  const desc = describeRules(parsed?.rules || [])
  // The POLICY is part of the identity of a set, not decoration on it. GGG
  // answered this deployment with three different sets over two days, and the
  // policy is what says whether a changed set is the same budget being restated
  // (in which case the pacer replaces it) or a second budget standing next to
  // the first (in which case both count). A line that named only the numbers
  // could not tell those apart after the fact — see stash-pacer.mjs.
  const policy = parsed?.policy || null
  const key = `${policy || '(no policy)'} ${desc || '(none)'}`
  if (seenRuleSets.has(key)) return
  if (seenRuleSets.size >= MAX_LOGGED_RULE_SETS) return
  seenRuleSets.add(key)
  const derived = spacingMs != null
    ? ` — derived minimum spacing between two stash requests: ${(spacingMs / 1000).toFixed(1)}s`
    : ''
  const named = policy ? ` (policy ${policy})` : ' (no X-Rate-Limit-Policy header — the set is kept alongside the others rather than replacing one)'
  log?.log?.(desc
    ? `[stash-client] GGG rate-limit rules for the stash endpoints${named}: ${desc} ` +
      '— the rule NAME says what the budget belongs to (Ip = shared with everything else from this address, Account = this session)' +
      derived
    : '[stash-client] the stash endpoints returned no X-Rate-Limit headers at all — the budget cannot be read from the response' +
      derived)
}

/** Forget which rule sets have been reported. Tests only. */
export function resetRateLimitRuleLog () { seenRuleSets.clear() }

// ---------------------------------------------------------------------------
// WHICH SCOPE THE REQUEST WAS COUNTED IN — the rule NAMES as a session check.
//
// The legacy stash endpoint publishes the SAME policy in two forms: `Account,Ip`
// when the POESESSID was accepted and `Ip`-only when it was not, with the
// address limit roughly halved in the second (measured by gerwaric/acquisition
// on 28.07.2026; a GGG developer described the same behaviour in the official
// forum in 2018 — with a session id the budget is counted per account, and the
// address limit is then twice as generous).
//
// This deployment has one of those in its log: on 13.08.2026 at 02:15 UTC an
// `Ip`-only set arrived, which the pacer honoured. It is not a punishment and
// it is not GGG tightening anything. It is what a night-time round with an
// expired cookie looks like from the outside, and the tool's only reaction was
// to get slower — silently, for hours.
//
// So the disappearance of the `Account` rules is a NAMED STATE, not a number.
// It is edge-triggered per policy and reported once each way: a set that has
// never carried `Account` rules says nothing (nothing to conclude from), and a
// policy that regains them says so too, because "it fixed itself" is the other
// half an operator needs.
//
// NOTHING HERE CHANGES CONTROL FLOW, deliberately. An unauthenticated stash
// request cannot read a private stash, so it is refused, and that refusal
// already travels the auth path (401/403 -> kind:'auth' -> the refresher pauses
// that user, logs "cookie expired for X" and reports `state: 'expired'` for
// them). Turning this observation into a second pause would add a per-user
// consequence to a process-wide signal that cannot name a user — and a false
// positive, should GGG ever publish an Ip-only set to an authenticated request,
// would freeze a healthy refresher until somebody edited the cookie. The line
// is what was missing; the pause was not.
const accountScopeByPolicy = new Map()

/**
 * Report the loss (and the return) of the `Account` rules of a policy.
 * Observation only — no request, no pacing change, no thrown error.
 */
export function noteSessionScope (parsed, log = console) {
  const rules = parsed?.rules || []
  if (!rules.length) return          // no headers is not an answer about scope
  const policy = parsed?.policy || '(no policy)'
  const hasAccount = rules.some(r => r?.rule === 'Account')
  const had = accountScopeByPolicy.get(policy)
  if (had === undefined) {
    // A pathological server varying its policy names must not grow this map.
    if (accountScopeByPolicy.size >= MAX_LOGGED_RULE_SETS) return
    accountScopeByPolicy.set(policy, hasAccount)
    return                            // the first set of a policy establishes the baseline
  }
  if (had === hasAccount) return
  accountScopeByPolicy.set(policy, hasAccount)
  if (!hasAccount) {
    log?.warn?.(`[stash-client] the stash session is NOT being counted per account any more (policy ${policy}): ` +
      'GGG published only Ip rules, which is the form it answers an unauthenticated request with — ' +
      'the POESESSID is expired or was not accepted. Renew it in networth-users.json. ' +
      'The Ip-only limits are stricter, so the pace lengthens with them; that is a symptom, not the problem')
  } else {
    log?.log?.(`[stash-client] the stash session is being counted per account again (policy ${policy}) — ` +
      'the POESESSID is being accepted')
  }
}

/** Forget the per-policy scope baseline. Tests only. */
export function resetSessionScope () { accountScopeByPolicy.clear() }

// The REACTIVE half of the pacing: a pause derived from the STATE counters of
// the response that just arrived. Deterministic (unit-testable):
//  - Retry-After set                           -> (N+1)s
//  - any state counter >= limit-1              -> wait out the whole window,
//      PLUS its bucket: GGG buckets incoming requests and the bucket size is in
//      no header ("you'd have to add 5 more seconds rather than 2 … this isn't
//      exposed anywhere for you to have known" — GGG support). Waiting exactly
//      `windowSec` lands inside the bucket the window is still being summed
//      over, which is one way a correctly-paced client still collects a 429.
//  - any state counter >= 80% of the limit      -> 4x baseMs (slow down noticeably)
//  - otherwise baseMs (the floor, and nothing more)
// `baseMs` stays the CONSTANT here and is deliberately not the derived pace: the
// caller takes the maximum of this and stash-pacer.mjs's spacing, so the two
// answers stay separable — this one says "the window you can see is filling up",
// the other says "this is the rate the published limits allow at all".
// The Retry-After branch is not the 429 path — a 429 is propagated on the spot
// and never slept on here (see the header note). It fires for the rarer case
// of a Retry-After on a response that was not a 429.
// Anything this returns above MAX_PACING_SLEEP_MS is not slept out either: the
// request is not sent at all and the wait goes to the caller's cooldown.
export function delayFor (parsed, { baseMs = 1500, bucketSecOf = bucketSecFor } = {}) {
  if (parsed.retryAfterSec != null) return (parsed.retryAfterSec + 1) * 1000
  let delay = baseMs
  for (const st of parsed.states) {
    const rule = parsed.rules.find(r => r.rule === st.rule && r.windowSec === st.windowSec)
    if (!rule || !(rule.hits > 0)) continue
    if (st.hits >= rule.hits - 1) {
      const bucketSec = Math.max(0, Number(bucketSecOf(st.windowSec)) || 0)
      delay = Math.max(delay, (st.windowSec + bucketSec) * 1000)
    } else if (st.hits >= rule.hits * 0.8) delay = Math.max(delay, baseMs * 4)
  }
  return delay
}

export function createStashClient ({
  accountName, poesessid, league, realm = 'pc',
  fetchImpl = fetch, baseDelayMs = 1500,
  // The process-wide pace derived from GGG's own published limits. NOT
  // per-client on purpose: the server builds a fresh client every tick, and an
  // `Ip` budget belongs to the address, not to a client that lives for 30
  // seconds. See stash-pacer.mjs. Injected only by tests.
  pacer = sharedStashPacer,
  // Injected only by tests, so a derived wait can be asserted instead of waited
  // out. Production sleeps for real.
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  // 5xx ONLY. A 429 is not retried at all (see the header note), so this does
  // not bound how many requests a rate limit can cost — that number is one.
  maxRetries = 5, onProgress = () => {},
  requestTimeoutMs = envNum('POE_STASH_TIMEOUT_MS'),
  // Only the folder-tab path routes through this (everything else still writes
  // to console directly). It exists so a test can READ those lines — they are
  // the whole point of B7, and a line nothing can assert on is not evidence.
  log = console
}) {
  if (!accountName || !poesessid) throw new Error('accountName and poesessid are required')
  let nextDelayMs = 0     // derived from the headers of the LAST response

  function fail (message, kind, extra = null) {
    const e = new Error(message)
    e.kind = kind
    // `retryAfterSec` rides along on a 'ratelimit' so the caller's cooldown can
    // be at least as long as the wait GGG asked for — never shorter.
    if (extra) Object.assign(e, extra)
    return e
  }

  // Short, sanitized snippet of an error response body — enough to tell a
  // Cloudflare block ("Just a moment" / "cloudflare") apart from a GGG JSON
  // error. Never contains request headers or the cookie. Best-effort.
  async function bodyHint (r) {
    try {
      const t = (await r.text()) || ''
      if (/cloudflare|just a moment|attention required|cf-ray/i.test(t)) return ' — looks like a Cloudflare block'
      const s = t.replace(/\s+/g, ' ').trim().slice(0, 140)
      return s ? ` — body: ${s}` : ''
    } catch { return '' }
  }

  // How long ONE step may sit inside a header-derived pacing sleep. It is NOT a
  // shortcut past a rate limit: a pacing wait longer than this is not truncated
  // and then sent anyway (that fires a request into a window GGG's own headers
  // call full). It is handed to the caller as a 'ratelimit' instead — zero
  // requests, and the refresher's cooldown does the waiting where the status
  // line can show it.
  //
  // Why a cap at all, rather than sleeping out whatever the headers say: the
  // sleep happens inside a step that holds the refresher's `busy` flag for ALL
  // users, and a state counter against a long window can derive a wait of many
  // minutes. Sitting there is indistinguishable from a hang; a cooldown with an
  // end time is not. 90s is above every pacing wait an ordinary round produces
  // (the derived spacing is ~24s on the measured rule set, the 80% brake 6s) and
  // below the ten-minute cooldown that takes over past it. A derived spacing
  // above 90s — which no rule set seen so far comes close to — would land here
  // too: one request per cooldown instead of a sleep nobody can see.
  const MAX_PACING_SLEEP_MS = 90_000
  const TIMEOUT_MAX_RETRIES = 2    // stalled/network request -> give up fast (~90s) and skip the tab

  // HARD timeout: AbortController alone does NOT reliably tear down a stalled
  // undici socket (a huge remove-only tab whose body trickles/dies keeps the
  // await pending indefinitely). So race every await against a timeout that
  // ALWAYS rejects -> the scan proceeds even when the abort is ignored. The
  // loser promise's late rejection is swallowed to avoid an unhandled rejection.
  function withTimeout (p, ms, ac) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { ac.abort() } catch { /* best effort */ }
        reject(Object.assign(new Error(`request timed out after ${ms}ms`), { name: 'TimeoutError' }))
      }, ms)
    })
    p.catch(() => {}) // if the timeout wins, swallow p's later rejection
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
  }

  async function request (params) {
    return requestUrl(`${STASH_BASE}?accountName=${encodeURIComponent(accountName)}` +
      `&realm=${encodeURIComponent(realm)}&league=${encodeURIComponent(league)}&${params}`)
  }

  async function requestUrl (url) {
    for (let attempt = 0; ; attempt++) {
      // The longer of the two waits, never the shorter: `nextDelayMs` is what
      // this client would have waited before the pacer existed (0 on a fresh
      // client's first request, the reactive brake after that), and the pacer
      // adds what GGG's published limits ask for on top — measured from the
      // last request of ANY client in this process, so a folder tab's burst and
      // the gap between two ticks are counted on the same timeline. Between two
      // ordinary ticks the pacer contributes 0: 30s has already passed.
      const waitMs = Math.max(nextDelayMs, pacer.waitMs(baseDelayMs))
      if (waitMs > 0) {
        if (waitMs > MAX_PACING_SLEEP_MS) {
          throw fail(`Rate limits ask for ${Math.round(waitMs / 1000)}s before the next stash request — ` +
            'handing the wait to the refresher cooldown instead of sitting on it', 'ratelimit',
          { retryAfterSec: Math.ceil(waitMs / 1000) })
        }
        await sleep(waitMs)
      }
      const ac = new AbortController()
      try {
        // Before the fetch, not after: what a rate-limit window counts is a
        // request going out, and it has gone out even if the answer never comes.
        pacer.noteRequest()
        const r = await withTimeout(fetchImpl(url, {
          headers: { Cookie: `POESESSID=${poesessid}`, 'User-Agent': BROWSER_UA, Accept: 'application/json' },
          signal: ac.signal
        }), requestTimeoutMs, ac)
        const parsed = parseRateLimitHeaders(r.headers)
        // The limits GGG publishes -> the pace of every following request, in
        // this client and in the ones later ticks build (stash-pacer.mjs).
        pacer.noteRules(parsed)
        // Pure observation, no request of its own, at most one line per process.
        noteRateLimitRules(parsed, log, pacer.spacingMs(baseDelayMs))
        // …and the one observation that is about the SESSION rather than the
        // budget: an Ip-only set means this request was not authenticated.
        noteSessionScope(parsed, log)
        nextDelayMs = delayFor(parsed, { baseMs: baseDelayMs })
        // …and the reactive brake outlives this client too: a state counter at
        // the top of a 1800s window must not be forgotten when the tick ends,
        // or the next tick opens by sending into the full window.
        pacer.noteBrake(nextDelayMs)
        if (r.status === 429) {
          // NO retry. GGG has said stop; the only thing a retry can add is
          // another request inside the window that produced this one. The wait
          // travels with the error (retryAfterSec) so the caller's cooldown is
          // at least as long as the one GGG asked for.
          throw fail(`Rate-limited by GGG (HTTP 429)${parsed.retryAfterSec != null ? `, Retry-After ${parsed.retryAfterSec}s` : ''} ` +
            '— no client-side retry; the refresher cooldown owns the wait', 'ratelimit',
          parsed.retryAfterSec != null ? { retryAfterSec: parsed.retryAfterSec } : null)
        }
        if (r.status === 401) {
          // Cookie value deliberately NOT in the message.
          throw fail('POESESSID invalid or expired (HTTP 401) — renew the cookie in networth-users.json', 'auth')
        }
        if (r.status === 403) {
          // 403 = authenticated but forbidden. Usually a wrong accountName (you
          // can only read your OWN stash — try the full name#1234 form) or a
          // Cloudflare block. The body hint tells them apart.
          throw fail(`HTTP 403 (forbidden) — check accountName (must match your account; try the full name#1234 form)${await bodyHint(r)}`, 'auth')
        }
        if (!r.ok) {
          // Other 4xx (400/404/422/…) won't change on retry -> give up
          // immediately instead of hammering GGG. 5xx may be transient -> retry.
          if (r.status < 500) {
            throw fail(`Stash request rejected: HTTP ${r.status}${await bodyHint(r)}`, 'rejected')
          }
          if (attempt >= maxRetries) throw fail(`Stash request failed: HTTP ${r.status}`, 'server')
          continue
        }
        return await withTimeout(r.json(), requestTimeoutMs, ac)
      } catch (e) {
        // Typed fail() errors (auth/ratelimit/rejected/server) are deliberate
        // decisions -> propagate. Timeout/network (no kind) -> transient, but
        // give up FAST so ONE stalled tab skips in ~90s of waiting on the socket
        // instead of freezing the whole scan (fetchAllTabs then skips this tab).
        // The two retries are paced like every other request — a request that
        // timed out still went out and still counts against the window — so the
        // wall-clock cost of a stalled tab is those 90s plus two derived gaps.
        if (e?.kind) throw e
        if (attempt >= TIMEOUT_MAX_RETRIES) throw fail(`Stash request failed (network/timeout after ${requestTimeoutMs}ms): ${e?.name || e}`, 'server')
        continue
      }
    }
  }

  // THE TWO REQUESTS A FOLDER TAB IS MADE OF. Both go through the same
  // requestUrl() as everything else, so they inherit header parsing, backoff,
  // timeout AND the derived pace; neither of them knows anything about the
  // walk they are part of. That is what lets the refresher spend them one per
  // tick instead of 1+N inside one (networth/folder-walk.mjs): the walk is
  // plain data held by the caller, and a caller that has been handed a FRESH
  // client — which the server builds every tick, with freshly reloaded
  // credentials — can go on using it without carrying the old one along.
  //
  // One pass is still 1 + N requests (unique tab: 18, map stash: 30) and it is
  // the reason the pace had to be derived at all: at the old 1.5s constant
  // those 31 requests went out inside 45s, which is 41 a minute against a
  // published `Ip 45/60s`.
  //
  // A plain function, not only a method on the returned object: `fetchTab` uses
  // it too, and a `this` that a destructured caller could lose is not something
  // a rate-limit decision should hang on.
  const isChildedTab = tab => !!(tab?.id && CHILDED_TAB_TYPES.has(tab?.type))
  const childApi = {
    async listTabChildren (tab) {
      const base = `${STASH_V2_BASE}/${encodeURIComponent(league)}`
      const parent = await requestUrl(`${base}/${encodeURIComponent(tab.id)}`)
      const children = Array.isArray(parent?.stash?.children) ? parent.stash.children : []
      // What GGG really answered with, in its own words, once per folder tab per
      // process (networth/subtab-shape.mjs). It costs no request — the response
      // is already in hand — and it decides NOTHING: every child that can be
      // addressed is read. That separation is the point of the line, and of
      // docs/bugs.md B19, where reading it the other way round cost a whole tab.
      noteSubTabShape(tab, parent, log)
      // WHAT THE OBSERVATION LINE FOUND, PUT TO USE — and the one thing in this
      // response that decides anything. `planFolderChildren` reads GGG's own
      // `metadata.map.section` and marks the `tier<N>` pages of the MAP stash;
      // everything it does not understand it leaves alone, so a stash shaped
      // differently from this one is read whole
      // (networth/map-sections.mjs). Nothing is dropped from `childIds` — the
      // skip is a set laid over the list, because the walk still has to account
      // for every sub-tab GGG listed.
      const { childIds, skipIds, skipSections } = planFolderChildren(tab, children)
      return {
        // `listed` is what GGG answered, `childIds` what can be addressed. They
        // differ only for an entry with no id, which the walk cannot fetch —
        // reporting the first is what keeps the B7 yield line saying how many
        // sub-tabs there ARE rather than how many were usable.
        listed: children.length,
        childIds,
        skipIds,
        skipSections,
        items: Array.isArray(parent?.stash?.items) ? [...parent.stash.items] : []
      }
    },
    async fetchTabChild (tab, childId) {
      const base = `${STASH_V2_BASE}/${encodeURIComponent(league)}`
      const j = await requestUrl(`${base}/${encodeURIComponent(tab.id)}/${encodeURIComponent(childId)}`)
      const items = j?.stash?.items
      return {
        items: Array.isArray(items) ? items : [],
        hasItemsArray: Array.isArray(items),
        hasOwnChildren: Array.isArray(j?.stash?.children) && j.stash.children.length > 0
      }
    }
  }

  return {
    /**
     * Does this tab have to be read through the sub-folder walk? The refresher
     * asks before it decides whether a tab is one step or many, so the answer
     * belongs to whoever knows which endpoint can read what — here — rather
     * than to a type list copied into the caller.
     */
    isChildedTab,
    ...childApi,
    async listTabs () {
      const j = await request('tabs=1&tabIndex=0')
      const tabs = Array.isArray(j?.tabs) ? j.tabs : []
      if (process.env.POE_NETWORTH_DEBUG === '1') {
        // Index + type only (no tab contents): the type decides whether a tab
        // can return any items over this endpoint at all.
        console.log('[stash-client] tab types: ' +
          tabs.map(t => `${t.i}:${t.type ?? '(no type field)'}`).join(' '))
        // Field names of the tab entries (union, no values): if a tab carries
        // children/subtabs/parent, there is a level below the tab level that
        // we have not been querying at all so far.
        const keys = new Set()
        for (const t of tabs) for (const k of Object.keys(t || {})) keys.add(k)
        console.log(`[stash-client] tab entry fields: ${[...keys].join(',')} (top-level response keys: ${Object.keys(j || {}).join(',')})`)
      }
      // `id` is needed for folder tabs (only the NEWER endpoint knows them).
      return tabs.map(t => ({ index: t.i, name: t.n, type: t.type, id: t.id ?? null }))
    },
    /**
     * Items of one tab. `tab` (the entry from listTabs) is optional and only
     * needed for FOLDER tabs: UniqueStash and MapStash always return an empty
     * items array over the old endpoint — their items sit in sub-folders that
     * do not exist there at all (proven: subIndex is ignored, and it does not
     * know the tab ID). Those go through the newer endpoint of the website,
     * two levels deep, strictly sequential.
     *
     * THIS NEVER ANSWERS "EMPTY" FOR "COULD NOT READ". An empty array means GGG
     * said the tab holds nothing; anything else — a body without an items array,
     * a folder walk whose sub-tabs did not all answer, an unexpected status on
     * the folder path — throws `kind: 'unread'`. The caller keeps
     * the tab's stored contents and tries again on a later turn.
     */
    async fetchTab (tabIndex, tab = null) {
      if (isChildedTab(tab)) {
        try {
          // The whole walk in one call — for callers with no ticks to spread it
          // over (networth/scan.mjs, fetchAllTabs). The refresher takes the same
          // walk apart instead; same requests, same order, same log lines.
          return await walkFolderTab(childApi, tab, log)
        } catch (e) {
          // The newer endpoint is undocumented and can change. auth/ratelimit
          // must propagate (cookie/ban protection), and `unread` already IS the
          // answer this branch has to give, with its own line already logged by
          // finishFolderWalk.
          if (e?.kind === 'auth' || e?.kind === 'ratelimit' || e?.kind === 'unread') throw e
          // EVERYTHING ELSE USED TO DEGRADE TO "TAB EMPTY", and that was the
          // wrong of the two answers available. A tab this client could not read
          // is UNKNOWN, and handing an empty array up says the opposite — the
          // caller stores it, the snapshot loses the tab's whole contents, and
          // the history books them as stock that left the stash (docs/bugs.md
          // B2). `unread` keeps the tab's last real contents standing; the scan
          // still carries on, because every caller skips this tab exactly the
          // way it skips a timeout.
          log.warn?.(`[stash-client] folder tab "${tab.name}" not readable (${e?.message || e}) — ` +
            'its stored contents stand rather than being replaced by an empty tab')
          throw fail(`folder tab "${tab.name}" not readable: ${e?.message || e}`, 'unread')
        }
      }
      const j = await request(`tabIndex=${tabIndex}&tabs=0`)
      // NO ITEMS ARRAY IS NOT AN EMPTY TAB. `Array.isArray(j?.items) ? j.items : []`
      // collapsed two answers into one: GGG saying "this tab holds nothing"
      // (`items: []`, a fact) and GGG answering 200 with a body that is not the
      // documented shape at all (no fact whatsoever). B7 measured the second one
      // on the sub-tab endpoint — a 200 whose body carried no items array,
      // logged nowhere, indistinguishable from an empty tab afterwards — and
      // this is the same collapse on the ordinary endpoint. Stored, it empties a
      // whole stash tab, and the recorder reads the difference as stock leaving
      // (docs/bugs.md B2). The response KEYS travel in the message (names only,
      // never item data, never the cookie) because they are what says where the
      // items went.
      if (!Array.isArray(j?.items)) {
        throw fail(`Stash tab ${tabIndex} answered HTTP 200 without an items array — that is not an empty tab, ` +
          `it is no answer at all (top-level keys: ${Object.keys(j || {}).join(',') || 'none'})`, 'unread')
      }
      const items = j.items
      // Diagnostics (POE_NETWORTH_DEBUG=1): when a tab came back empty, the
      // TOP-LEVEL KEYS of the response show whether GGG puts the items
      // somewhere else (folder tabs) or really returns nothing. Key names and
      // numbers only — no item data, no cookie.
      if (process.env.POE_NETWORTH_DEBUG === '1' && items.length === 0) {
        // For every non-items key: type, entry count and the keys of the FIRST
        // entry. That is enough to tell whether it holds nothing but slot
        // positions (x/y/w/h) or actual items.
        const shape = Object.entries(j || {}).filter(([k]) => k !== 'items').map(([k, v]) => {
          if (v == null || typeof v !== 'object') return `${k}=${typeof v}`
          const keys = Object.keys(v)
          const first = keys.length ? v[keys[0]] : null
          const firstKeys = first && typeof first === 'object' ? Object.keys(first).join('/') : typeof first
          return `${k}[${keys.length}]{${firstKeys}}`
        })
        console.log(`[stash-client] tab ${tabIndex} came back with 0 items — ${shape.join(' ') || '(nothing besides items)'}`)
      }
      return items
    },
    // One-shot experiment (POE_STASH_PROBE=<index>, see server.mjs): folder
    // tabs (UniqueStash/MapStash) return an EMPTY items array and an empty
    // layout over `tabIndex=N&tabs=0` — yet in game there is a level below
    // them (a sub-folder per tier or item class). This probe walks the
    // plausible addressing schemes one after another and logs nothing but
    // response keys and item COUNT per variant. Strictly sequential over the
    // same request() (rate-limit header discipline applies), one pass per
    // start and never again. No item data, no cookie in the log.
    async probeTab (tabIndex) {
      const list = await request('tabs=1&tabIndex=0')
      const entry = (Array.isArray(list?.tabs) ? list.tabs : []).find(t => t.i === tabIndex)
      const id = entry?.id ?? null
      console.log(`[stash-probe] tab ${tabIndex} type=${entry?.type ?? '?'} id=${id ? 'present' : 'absent'}`)
      const variants = [
        ['baseline', `tabIndex=${tabIndex}&tabs=0`],
        ['subIndex=0', `tabIndex=${tabIndex}&tabs=0&subIndex=0`],
        ['subIndex=1', `tabIndex=${tabIndex}&tabs=0&subIndex=1`],
        ['tabs=1', `tabIndex=${tabIndex}&tabs=1`],
        ...(id ? [['tabId', `tabId=${encodeURIComponent(id)}&tabs=0`]] : []),
        ...(id ? [['tabIndex=id', `tabIndex=${encodeURIComponent(id)}&tabs=0`]] : [])
      ]
      for (const [label, params] of variants) {
        try {
          const j = await request(params)
          const n = Array.isArray(j?.items) ? j.items.length : -1
          console.log(`[stash-probe] ${label}: items=${n} keys=${Object.keys(j || {}).join(',')}`)
        } catch (e) {
          console.log(`[stash-probe] ${label}: ${e?.kind || 'error'} — ${e?.message || e}`)
        }
      }
      // Round two: the NEWER stash endpoint of the website (same cookie
      // session, no OAuth). If it returns `children` for folder tabs, that is
      // the way to the sub-folders. Again keys + counts only in the log.
      const alt = [
        ['api/stash/<league>', `https://www.pathofexile.com/api/stash/${encodeURIComponent(league)}`],
        ...(id ? [['api/stash/<league>/<id>', `https://www.pathofexile.com/api/stash/${encodeURIComponent(league)}/${encodeURIComponent(id)}`]] : [])
      ]
      for (const [label, url] of alt) {
        try {
          const r = await fetchImpl(url, {
            headers: { Cookie: `POESESSID=${poesessid}`, 'User-Agent': BROWSER_UA, Accept: 'application/json' }
          })
          if (!r.ok) { console.log(`[stash-probe] ${label}: HTTP ${r.status}`); continue }
          const j = await r.json()
          const stash = j?.stash ?? j
          const kids = Array.isArray(stash?.children) ? stash.children.length : (Array.isArray(j?.stashes) ? `stashes:${j.stashes.length}` : 'none')
          const n = Array.isArray(stash?.items) ? stash.items.length : -1
          console.log(`[stash-probe] ${label}: HTTP 200 keys=${Object.keys(j || {}).join(',')} items=${n} children=${kids}`)
          // Round three: child tabs. Fields of the first child (names only)
          // and both plausible addressings — directly by child ID, and as a
          // path under the parent tab. Two requests, then the question is
          // answered.
          const children = Array.isArray(stash?.children) ? stash.children : []
          if (children.length) {
            console.log(`[stash-probe] child fields: ${Object.keys(children[0] || {}).join(',')}`)
            const childId = children[0]?.id
            const base = `https://www.pathofexile.com/api/stash/${encodeURIComponent(league)}`
            for (const [cl, curl] of [
              ['child direct', `${base}/${encodeURIComponent(childId)}`],
              ['child under parent', `${base}/${encodeURIComponent(id)}/${encodeURIComponent(childId)}`]
            ]) {
              try {
                const cr = await fetchImpl(curl, {
                  headers: { Cookie: `POESESSID=${poesessid}`, 'User-Agent': BROWSER_UA, Accept: 'application/json' }
                })
                if (!cr.ok) { console.log(`[stash-probe] ${cl}: HTTP ${cr.status}`); continue }
                const cj = await cr.json()
                const cs = cj?.stash ?? cj
                console.log(`[stash-probe] ${cl}: HTTP 200 items=${Array.isArray(cs?.items) ? cs.items.length : -1} type=${cs?.type ?? '?'}`)
              } catch (e) {
                console.log(`[stash-probe] ${cl}: error — ${e?.message || e}`)
              }
            }
          }
        } catch (e) {
          console.log(`[stash-probe] ${label}: error — ${e?.message || e}`)
        }
      }
    },
    // Sequential: tab list first, then tab by tab — NEVER in parallel.
    // A flaky tab gets skipped instead of killing the whole scan. auth/ratelimit
    // still abort immediately (cookie/ban protection). Only consecutive 4xx
    // REJECTIONS trip the systemic-abort guard (GGG actively refusing = a real
    // back-off signal). Timeouts / 5xx are individual slow/stalling tabs (each
    // bounded to ~90s, one request at a time) -> skipped freely, so a tail of
    // huge remove-only junk tabs can't abort the run.
    async fetchAllTabs () {
      onProgress({ phase: 'tabs', done: 0, total: 0 })
      const tabs = await this.listTabs()
      const out = []
      const skippedTabs = []
      let consecutiveTabFails = 0
      for (const tab of tabs) {
        onProgress({ phase: 'tab', done: out.length, total: tabs.length, tabName: tab.name })
        try {
          const items = await this.fetchTab(tab.index, tab)
          out.push({ tab, items })
          consecutiveTabFails = 0
        } catch (e) {
          if (e?.kind === 'auth' || e?.kind === 'ratelimit') throw e
          console.warn(`[stash-client] Tab "${tab.name}" skipped (${e?.message || e})`)
          skippedTabs.push(tab.name)
          if (e?.kind === 'rejected') {
            // 4xx refusal in a row = systemic -> abort (ban protection).
            if (++consecutiveTabFails >= CONSECUTIVE_TAB_FAIL_LIMIT) {
              throw fail(`Scan aborted: ${consecutiveTabFails} tabs rejected in a row (last "${tab.name}")`, 'tabfail')
            }
          } else {
            // Timeout / 5xx = a slow tab, not a refusal -> don't count it.
            consecutiveTabFails = 0
          }
        }
      }
      return out
    }
  }
}
