// backend/v2/rate-limit-signal.mjs
// SINGLE source of truth for "is this error a trade rate-limit / ban, and for how
// many seconds should we back off?". Three copies of this logic used to live in
// server.mjs and networth/trade-client.mjs — and they had
// DRIFTED: one of them only knew the harmless client-side wording, so a REAL
// GGG ban fell through its detector and it kept crawling straight into the ban,
// snowballing 3h -> 11h. Keep ALL rate-limit reasoning here so the detectors can
// never diverge again. (trade-client.mjs still carries its own circuit-breaker
// classifier; converging it is a safe follow-up, not required — it is the MOST
// complete of the three, so it was never the drift risk.)
//
// A rate-limit / ban reaches us in these forms — recognise ALL of them:
//   1. Client-side backpressure: APT's preventQueueCreation throws
//      "Retry after N seconds" BEFORE any request goes out (harmless pacing).
//   2. A REAL server ban: GGG's 429 body, surfaced verbatim as
//      "Rate limit exceeded; Please wait N seconds before trying again."
//   3. A hard block with no number: a 403 soft-ban, or a Cloudflare/WAF HTML
//      challenge page that fails JSON.parse (a SyntaxError, often statusless).
//      engine.searchRaw hides the HTTP status, so we sniff the message too.

// "Retry after N" is CLIENT-side (preventQueueCreation throws it BEFORE any
// request leaves the app) — pure pacing, NOT a ban. "Please wait N" is GGG's
// real 429 body — a request DID hit GGG. Split them so callers can gate the
// global ban banner on REAL bans only.
const CLIENT_SECS_RE = /Retry after\s+(\d+)\s+seconds?/i
const SERVER_SECS_RE = /Please wait\s+(\d+)\s+seconds?/i
// Numberless SERVER-side throttle/ban wordings (a request hit GGG, got rejected,
// no Retry-After to read).
const SERVER_SIGNAL_RE = /rate limit exceeded|too many requests|\b429\b/i
// A hard BLOCK: 403 soft-ban, or a Cloudflare/WAF HTML body that fails
// JSON.parse. engine.searchRaw hides the HTTP status, so sniff the message too.
const BLOCK_SIGNAL_RE = /\b403\b|forbidden|unexpected token|not valid json|unexpected end of json|in json at|json\.parse/i

// Conservative backoff when a ban is detected but carries no explicit duration.
// Matches the price-check banner threshold so a numberless ban still raises it.
export const RATE_LIMIT_FALLBACK_SEC = 60

// Classify a rate-limit/ban signal -> { seconds, kind } or null (not a signal).
//   kind 'client' — "Retry after N": preventQueueCreation threw BEFORE any
//        request left the app. Pure local pacing; NOTHING was sent, so there is
//        nothing to ban. Callers must NOT raise the global banner/gate for it —
//        just a brief local backoff.
//   kind 'server' — GGG's real 429 ("Please wait N" / "rate limit exceeded" /
//        "too many requests" / status 429). A request hit GGG and was rejected.
//   kind 'block'  — 403 / Cloudflare-HTML / statusless JSON-parse SyntaxError.
//        A hard block; also request-hit-GGG.
// A normal error (clipboard parse failure, expired cookie, ECONNRESET) -> null,
// and must never pause the queue.
export function classifyRateLimit (errOrMsg) {
  if (errOrMsg instanceof SyntaxError) return { seconds: RATE_LIMIT_FALLBACK_SEC, kind: 'block' }
  const status = errOrMsg?.status ?? errOrMsg?.statusCode
  if (status === 403) return { seconds: RATE_LIMIT_FALLBACK_SEC, kind: 'block' }
  if (status === 429) return { seconds: RATE_LIMIT_FALLBACK_SEC, kind: 'server' }
  if (Number.isFinite(errOrMsg?.retryAfter)) return { seconds: Number(errOrMsg.retryAfter) || RATE_LIMIT_FALLBACK_SEC, kind: 'server' }
  const msg = typeof errOrMsg === 'string' ? errOrMsg : String(errOrMsg?.message ?? errOrMsg ?? '')
  let m = CLIENT_SECS_RE.exec(msg)
  if (m) return { seconds: Number(m[1]) || RATE_LIMIT_FALLBACK_SEC, kind: 'client' }
  m = SERVER_SECS_RE.exec(msg)
  if (m) return { seconds: Number(m[1]) || RATE_LIMIT_FALLBACK_SEC, kind: 'server' }
  if (SERVER_SIGNAL_RE.test(msg)) return { seconds: RATE_LIMIT_FALLBACK_SEC, kind: 'server' }
  if (BLOCK_SIGNAL_RE.test(msg)) return { seconds: RATE_LIMIT_FALLBACK_SEC, kind: 'block' }
  return null
}

// Seconds to hold off, or null if not a rate-limit/ban at all. Thin wrapper for
// callers that don't need the kind.
export function rateLimitSeconds (errOrMsg) {
  return classifyRateLimit(errOrMsg)?.seconds ?? null
}

// Convenience boolean for callers that only need "is this a ban/throttle signal".
export function isBanSignal (errOrMsg) {
  return classifyRateLimit(errOrMsg) != null
}

// A 'client' wait this long is no longer "pacing after a burst": APT's limiter
// derives its windows from GGG's OWN rate-limit response headers, so once it
// starts refusing for minutes-to-hours it has LEARNED a real server-side limit.
// Observed: "Retry after 13283 seconds" (3.7h) reported as client — nothing was
// sent, but we are unmistakably limited. Below this, a client wait is ordinary
// backpressure and must stay quiet (a 60s pause used to raise a false alarm).
export const CLIENT_GATE_MIN_SEC = 300

// Should this signal raise the GLOBAL ban gate + banner (vs. a quiet local
// backoff)? server/block always: a request reached GGG and was rejected.
// client only when the learned wait is long (see above). Callers keep their own
// display threshold; this decides "is the whole app paused".
export function shouldRaiseGlobalGate (rl) {
  if (!rl) return false
  return rl.kind !== 'client' || rl.seconds >= CLIENT_GATE_MIN_SEC
}
