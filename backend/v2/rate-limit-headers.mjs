// backend/v2/rate-limit-headers.mjs
// GGG's rate-limit headers, parsed. Nothing else.
//
//   X-Rate-Limit-Policy:       stash-request-limit which BUDGET this set belongs to
//   X-Rate-Limit-Rules:        Account,Ip          which rules apply
//   X-Rate-Limit-<Rule>:       30:60:60,100:1800:600   hits:window:ban, per rule
//   X-Rate-Limit-<Rule>-State: 4:60:0,11:1800:0        the same shape, but used
//   Retry-After:               120                 on a 429 (and occasionally not)
//
// ITS OWN MODULE FOR THE REASON secret-keys.mjs IS: two unrelated paths need
// it. The trade audit (trade-audit.mjs, /api/trade/*) used to import it out of
// networth/stash-client.mjs, which made the trade path depend on the whole
// net-worth stack — and once the stash client learnt to derive its pace from a
// numeric setting (networth/stash-pacer.mjs -> numeric-settings.mjs ->
// data-refresher.mjs -> trade-audit.mjs) that dependency closed into an import
// cycle and broke module initialisation outright. A parser with no imports of
// its own cannot be part of one.
//
// Pure and total: unknown, missing or malformed headers produce empty arrays,
// never a throw. A caller reads limits off a response it already has; it must
// not be able to fail because of what a proxy did to a header.

// A policy name is an identifier, not prose. Bounded so a pathological server
// cannot make a caller key a map on an unbounded string; 64 characters is far
// past anything GGG publishes ("stash-request-limit" is 19), so the truncation
// cannot merge two real policies into one.
const MAX_POLICY_LEN = 64

/**
 * parseRateLimitHeaders(headers) -> { policy, rules, states, retryAfterSec }
 *
 * `headers` may be a Headers object or a plain lower-cased object.
 * `rules`/`states` are `{ rule, hits, windowSec, banSec }`, in the order the
 * rule names were published.
 *
 * `policy` is the name of the BUDGET the set belongs to, or null when the
 * header is absent. It is what tells two rule sets apart when both are answered
 * with the same rule NAMES: `Ip 45/60s` from one policy and `Ip 30/60s` from
 * another are two limits, not a limit that changed. A caller that remembers
 * rules across responses needs that distinction; see networth/stash-pacer.mjs.
 */
export function parseRateLimitHeaders (headers) {
  const get = k => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k]) ?? null
  const rules = []
  const states = []
  const ruleNames = String(get('x-rate-limit-rules') || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const parseTriples = (raw, rule, into) => {
    for (const part of String(raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const [hits, windowSec, banSec] = part.split(':').map(Number)
      into.push({ rule, hits, windowSec, banSec })
    }
  }
  for (const rule of ruleNames) {
    parseTriples(get(`x-rate-limit-${rule.toLowerCase()}`), rule, rules)
    parseTriples(get(`x-rate-limit-${rule.toLowerCase()}-state`), rule, states)
  }
  const ra = get('retry-after')
  const policy = String(get('x-rate-limit-policy') || '').trim().slice(0, MAX_POLICY_LEN) || null
  return { policy, rules, states, retryAfterSec: ra != null && ra !== '' ? Number(ra) : null }
}
