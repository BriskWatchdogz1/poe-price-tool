// Minimal official Trade search+fetch for corpse pricing, layered on an INJECTED
// transport. The real transport is the APT engine's `searchRaw(body, league,
// { maxFetch })` (engine.bundle.mjs) — the SAME shared RateLimiter the price
// check goes through, with SEPARATE /search and /fetch
// rate-limit policies (RATE_LIMIT_RULES.SEARCH / .FETCH, header-driven) and a
// hard /fetch cap of 10 ids/call. Corpse queries run at BACKGROUND priority by
// being enqueued via the server's `enqueueBackground` (three-tier queue) — this
// client is only the query builder + a SELF-HEALING ban backoff; it never picks
// its own priority.
//
// SELF-HEALING BACKOFF (review-mandated). Corpse searches run ANONYMOUSLY — no
// POESESSID reaches engine.searchRaw — so the old "expired-cookie 401" case can
// never fire. The REAL failure is IP-side: GGG soft-bans the address (403), or
// Cloudflare answers with an HTML challenge instead of JSON (then the
// transport's `response.json()` throws a SyntaxError with NO status), or the
// address is rate-limited (429) repeatedly. On such a BAN SIGNAL we pause ALL
// corpse trade calls for a COOLDOWN window (short-circuit WITHOUT touching the
// transport, so we stop hammering a banned IP), then AUTOMATICALLY try again —
// no permanent dead state, no restart needed. Repeated bans escalate the
// cooldown (exponential, capped); the FIRST success clears the streak. A single
// transient 429 does NOT trip it (the shared RateLimiter/queue handles ordinary
// backoff); only a run of them does. resetCircuit() stays as a manual clear the
// server can call on a config reload.

const DEFAULT_COOLDOWN_MS = 12 * 60 * 1000   // 12min base pause on a ban signal
const DEFAULT_MAX_COOLDOWN_MS = 60 * 60 * 1000 // escalation cap (1h)
const DEFAULT_RATE_LIMIT_THRESHOLD = 3       // consecutive 429s before we pause

// A body that could not be parsed as JSON (Cloudflare HTML challenge, WAF block
// page, GGG's plain-text ban notice) surfaces from the transport as a
// SyntaxError WITHOUT an HTTP status — the strongest anonymous ban signal.
function isUnparseableBody (e) {
  if (e instanceof SyntaxError) return true
  const m = String(e?.message || '')
  return /Unexpected token|not valid JSON|Unexpected end of JSON|JSON at position|in JSON at|JSON\.parse/i.test(m)
}

// A hard ban signal: soft-ban (403) or an unparseable/HTML body. engine.searchRaw
// hides the HTTP status (it throws the JSON error message or a parse error), so
// fall back to message sniffing.
function isBanSignal (e) {
  const s = e?.status ?? e?.statusCode
  if (s === 403) return true
  if (isUnparseableBody(e)) return true
  const m = String(e?.message || '').toLowerCase()
  return /\b403\b|forbidden/.test(m)
}

// Rate-limit signal (429 / "too many requests" / a RateLimiter "retry after").
// One is normal; a RUN of them means the IP is throttled and we should back off.
function isRateLimit (e) {
  const s = e?.status ?? e?.statusCode
  if (s === 429) return true
  const m = String(e?.message || '').toLowerCase()
  return /\b429\b|too many requests|rate limit|retry after/.test(m)
}

// Corpse search body: exact base type, online + priced only, cheapest first.
export function corpseSearchBody (name) {
  return {
    query: {
      type: name,
      status: { option: 'online' },
      filters: { trade_filters: { filters: { sale_type: { option: 'priced' } } } }
    },
    sort: { price: 'asc' }
  }
}

export function createTradeClient ({
  searchRaw,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  maxCooldownMs = DEFAULT_MAX_COOLDOWN_MS,
  rateLimitThreshold = DEFAULT_RATE_LIMIT_THRESHOLD,
  now = () => Date.now(),
  log = console
} = {}) {
  let cooldownUntil = 0     // ms timestamp; open while now() < cooldownUntil
  let banStreak = 0         // consecutive ban windows -> exponential escalation
  let rateLimitStreak = 0   // consecutive 429s -> trip once threshold reached

  function openCooldown (reason) {
    banStreak++
    const backoff = Math.min(cooldownMs * 2 ** (banStreak - 1), maxCooldownMs)
    cooldownUntil = now() + backoff
    rateLimitStreak = 0
    log.warn?.(`[corpse-trade] BAN SIGNAL (${reason}) — corpse trade paused for ` +
      `${Math.round(backoff / 1000)}s (attempt ${banStreak}), then auto-retries. ` +
      'Likely an IP-side GGG soft-ban / Cloudflare challenge / rate-limit; corpses stay honestly unpriced meanwhile.')
  }

  return {
    isCircuitOpen: () => now() < cooldownUntil,
    circuitAt: () => (cooldownUntil ? cooldownUntil : null),
    cooldownUntil: () => cooldownUntil,
    // Manual clear (server config reload). The backoff self-heals without this.
    resetCircuit () { cooldownUntil = 0; banStreak = 0; rateLimitStreak = 0 },

    // Search + fetch corpses of exact base `name`. Returns the raw listings
    // ([{ priceAmount, priceCurrency, ... }], ≤maxFetch). Throws CIRCUIT_OPEN
    // while paused (caller must NOT count this as a real query).
    async searchListings (name, league, { maxFetch = 8 } = {}) {
      if (now() < cooldownUntil) {
        const e = new Error('corpse trade paused (ban-signal cooldown active)')
        e.code = 'CIRCUIT_OPEN'
        throw e
      }
      const body = corpseSearchBody(name)
      try {
        // Corpse searches are ANONYMOUS by design — no POESESSID is threaded to
        // the transport (the engine transport ignores it anyway). See the header.
        const res = await searchRaw(body, league, { maxFetch: Math.min(maxFetch, 10) })
        // Success -> self-heal: clear any accumulated ban/rate-limit streak.
        banStreak = 0
        rateLimitStreak = 0
        return res?.listings ?? []
      } catch (e) {
        if (e?.code === 'CIRCUIT_OPEN') throw e
        if (isBanSignal(e)) {
          openCooldown(e instanceof SyntaxError || isUnparseableBody(e) ? 'unparseable/HTML body' : '403 soft-ban')
        } else if (isRateLimit(e)) {
          if (++rateLimitStreak >= rateLimitThreshold) openCooldown(`${rateLimitStreak}× 429`)
        }
        // Other transient errors (5xx/network): leave the streaks; the queue's
        // own retry/backoff handles those, the name stays stale and is retried.
        throw e
      }
    }
  }
}
