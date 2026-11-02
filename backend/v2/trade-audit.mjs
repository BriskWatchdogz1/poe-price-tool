// backend/v2/trade-audit.mjs
// Rate-limit BOOKKEEPING for the PoE Trade API. Pure observation: it reads the
// headers of responses that were going to happen anyway, never issues a request
// of its own, never delays, retries or reorders anything. The pacing stays
// where it belongs (APT's RateLimiter in the engine bundle, the ban gate in
// server.mjs) — this module only writes down what happened.
//
// The question it answers: "who spent the budget?" Four consumers share ONE
// anonymous trade quota — the user's price checks, the corpse pricer (one name
// every 2min) and the data refresher's daily catalogue
// call. When a 429 arrives, nothing in the log used to say which of them had
// been busy, so a banner could not be explained after the fact.
//
// How the attribution travels: an AsyncLocalStorage context, not a parameter
// on every signature. The server tags a job ONCE where it is dispatched
// (`withConsumer(...)` in pump / the refresher tick); everything the job awaits
// below that — including the fetch inside the bundled engine — inherits the
// tag. A request that reaches GGG outside any tagged context is reported as
// 'unknown' rather than guessed at.
//
// What GGG tells us (same header shape the stash client already parses, so
// parseRateLimitHeaders is imported instead of written a second time — the
// repo has been bitten by duplicated rate-limit logic before, see
// rate-limit-signal.mjs):
//   X-Rate-Limit-Rules: Ip                      the rule names in play
//   X-Rate-Limit-Ip:       8:10:60,15:60:120    limit : window s : ban s
//   X-Rate-Limit-Ip-State: 1:10:0,3:60:0        current hits in that window
//   Retry-After: 300                            on a 429
//
// Two log lines, and only two:
//   * THRESHOLD — the first response that shows a window at or above
//     `threshold` (default 80%). Edge-triggered per rule+window: it stays quiet
//     until the counter has fallen back below the mark, so a busy minute costs
//     one line, not one per request.
//   * 429 — always, with the consumer, the rule, the wait, and how many
//     requests EACH of our consumers made inside the offending window.

import { AsyncLocalStorage } from 'node:async_hooks'
// The header parser only — NOT out of networth/stash-client.mjs, where it used
// to come from: that made the trade path import the whole net-worth stack, and
// once the stash client learnt to read a numeric setting it closed an import
// cycle through data-refresher.mjs. See rate-limit-headers.mjs.
import { parseRateLimitHeaders } from './rate-limit-headers.mjs'

export const CONSUMER = Object.freeze({
  PRICE_CHECK: 'price-check',
  CORPSE: 'corpse-pricer',
  DATA_REFRESHER: 'data-refresher',
  STAT_CATALOGUE: 'stat-catalogue',
  UNKNOWN: 'unknown'
})

const DEFAULT_THRESHOLD = 0.8
// Nothing GGG sends us has a window longer than an hour; anything older than
// that can never appear in a 429 report, so it is dropped.
const DEFAULT_HISTORY_MS = 60 * 60 * 1000
// Hard cap so a pathological burst cannot grow the array without bound.
const DEFAULT_MAX_HISTORY = 5000

const storage = new AsyncLocalStorage()

/** Run `fn` with every trade request below it attributed to `consumer`. */
export function withConsumer (consumer, fn) {
  return storage.run({ consumer }, fn)
}

/** The consumer of the currently running async context, or 'unknown'. */
export function currentConsumer () {
  return storage.getStore()?.consumer ?? CONSUMER.UNKNOWN
}

/**
 * Which trade policy does this URL belong to — or null when it is not the
 * trade API at all (poe.ninja, the stash endpoints with their own separate
 * budget, GitHub data downloads). Only /api/trade/* shares the search quota.
 */
export function tradePolicyFor (url) {
  let u
  try { u = new URL(String(url)) } catch { return null }
  if (!/(^|\.)pathofexile\.com$/i.test(u.hostname)) return null
  const m = /^\/api\/trade2?\/([^/]+)/.exec(u.pathname)
  if (!m) return null
  const seg = m[1].toLowerCase()
  return ['search', 'fetch', 'exchange', 'data'].includes(seg) ? seg : 'trade'
}

function urlOf (input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input?.url ?? ''
}

/**
 * The bookkeeping itself, without the fetch patch — directly testable.
 *
 *   record({ url, status, headers, consumer? }) -> void (never throws)
 *
 * `log`/`now` are injectable; `threshold` is the fraction of a window that
 * counts as "getting tight".
 */
export function createTradeAudit ({
  log = console,
  now = () => Date.now(),
  threshold = DEFAULT_THRESHOLD,
  historyMs = DEFAULT_HISTORY_MS,
  maxHistory = DEFAULT_MAX_HISTORY
} = {}) {
  // Rolling in-memory request log: { t, consumer }. Never persisted — it only
  // has to survive long enough to explain a 429 that is happening right now.
  const history = []
  // rule+window -> already reported as tight? (edge trigger, see the header)
  const tight = new Map()

  function remember (consumer) {
    const t = now()
    history.push({ t, consumer })
    const cutoff = t - historyMs
    while (history.length && history[0].t < cutoff) history.shift()
    while (history.length > maxHistory) history.shift()
  }

  // { consumer: count } for the last `windowSec` seconds, busiest first.
  function countsWithin (windowSec) {
    const cutoff = now() - windowSec * 1000
    const counts = new Map()
    for (const e of history) if (e.t >= cutoff) counts.set(e.consumer, (counts.get(e.consumer) || 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }

  function formatCounts (pairs) {
    if (!pairs.length) return 'none'
    const total = pairs.reduce((s, [, n]) => s + n, 0)
    return `${pairs.map(([c, n]) => `${c}=${n}`).join(' ')} (total ${total})`
  }

  // Pair each state counter with its limit. Unparseable/absent headers simply
  // yield an empty list — a missing header must never throw in here.
  function pairs (parsed) {
    const out = []
    for (const st of parsed.states) {
      const rule = parsed.rules.find(r => r.rule === st.rule && r.windowSec === st.windowSec)
      if (!rule || !(rule.hits > 0) || !Number.isFinite(st.hits)) continue
      out.push({ rule: st.rule, hits: st.hits, limit: rule.hits, windowSec: rule.windowSec, banSec: rule.banSec })
    }
    return out
  }

  return {
    record ({ url, status, headers, consumer } = {}) {
      try {
        const policy = tradePolicyFor(url)
        if (!policy) return
        const who = consumer || currentConsumer()
        remember(who)

        const parsed = parseRateLimitHeaders(headers)
        const seen = pairs(parsed)

        if (Number(status) === 429) {
          // The rule that actually tripped: the fullest window we can see. With
          // no usable headers we still log the event — the consumer and the
          // wait are the point.
          const hit = seen.slice().sort((a, b) => (b.hits / b.limit) - (a.hits / a.limit))[0]
          const windowSec = hit?.windowSec ?? 60
          const waitSec = parsed.retryAfterSec ?? hit?.banSec ?? null
          // The counts below are OUR requests only. Anonymous trade calls are
          // limited per IP, and the container shares its public address with
          // everything else in the household (the user's own browser on
          // pathofexile.com/trade included) — that traffic is invisible to us
          // by construction. Say so in the line, or a small number reads as
          // "we did it anyway" instead of "the load was not ours".
          log.warn?.(
            `[trade-audit] 429 from GGG — consumer=${who} policy=${policy} ` +
            `rule=${hit?.rule ?? 'unknown'} ${hit ? `${hit.hits}/${hit.limit} ` : ''}window=${windowSec}s ` +
            `wait=${waitSec == null ? 'unknown' : `${waitSec}s`}; ` +
            `own requests in that window: ${formatCounts(countsWithin(windowSec))} ` +
            '— this app only, other traffic from this IP (e.g. the trade site in a browser) is not counted'
          )
          // A 429 means the window is full; the next line for it should come
          // from a fresh crossing, not from the leftover flag.
          for (const p of seen) tight.set(`${policy}|${p.rule}|${p.windowSec}`, true)
          return
        }

        for (const p of seen) {
          const key = `${policy}|${p.rule}|${p.windowSec}`
          const isTight = p.hits >= p.limit * threshold
          if (isTight && !tight.get(key)) {
            log.warn?.(
              `[trade-audit] rate limit ${Math.round(threshold * 100)}% reached — consumer=${who} ` +
              `policy=${policy} rule=${p.rule} ${p.hits}/${p.limit} in ${p.windowSec}s ` +
              `(ban ${p.banSec}s if exceeded)`
            )
          }
          tight.set(key, isTight)
        }
      } catch { /* observation must never break a request */ }
    },

    // For tests / a future status endpoint. No secrets: consumer names only.
    snapshot () {
      return { requests: history.length, tight: [...tight.entries()].filter(([, v]) => v).map(([k]) => k) }
    },

    reset () { history.length = 0; tight.clear() }
  }
}

/**
 * Wrap the global fetch so every trade response passes through `record`. The
 * wrapper adds NOTHING to the request path: same input, same init, same
 * promise; the body is never read (headers only), errors propagate untouched.
 * Returns an uninstall function; a second install is a no-op.
 */
export function installTradeAudit ({ target = globalThis, audit = createTradeAudit() } = {}) {
  const orig = target.fetch
  if (typeof orig !== 'function' || orig.__tradeAudit) return () => {}
  const wrapped = async (input, init) => {
    const res = await orig(input, init)
    audit.record({ url: urlOf(input), status: res?.status, headers: res?.headers })
    return res
  }
  wrapped.__tradeAudit = audit
  target.fetch = wrapped
  return () => { if (target.fetch === wrapped) target.fetch = orig }
}
