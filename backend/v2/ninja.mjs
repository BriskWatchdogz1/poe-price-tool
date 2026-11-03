// backend/v2/ninja.mjs
// poe.ninja fetchers, extracted from server.mjs (not exported there and
// not importable due to import side effects). Shared by server.mjs
// (price path, reference rail) and backend/v2/networth/ (valuator).
// Importable without side effects: only module caches, no network call on import.
// Cache policy: >= 15min per league|type, descriptive UA.
//
// FAILURES COST THE SAME 15 MINUTES AS ANSWERS (docs/bugs.md B29). A failed
// attempt — a network error, a 5xx, an answer of the wrong shape — is cached
// as an attempt too, so the same key is not asked again for NINJA_MIN_MS. That
// is courtesy towards poe.ninja, and it is what keeps an outage from turning
// into one request per valued item. What a failure does NOT do is
// replace a good answer with an empty one: the last good answer stays and is
// served — but only up to maxAgeMs (POE_NINJA_MAX_AGE_MS, default 24 h) after
// it was fetched. Past that the item is unpriced and falls through to the next
// source, because a wrong price is worse than none.
//
// ONE REQUEST PER KEY AT A TIME. Callers that ask for a key whose request is
// still running join it, and a request that has no answer after
// NINJA_FETCH_TIMEOUT_DEFAULT_MS is a failed attempt like any other, so a
// hanging poe.ninja never multiplies into one request per caller.
//
// Every outcome is reported through configureNinja({ onOutcome }) — 'ninja-cd'
// for the currency exchange behind Chaos:Divine, 'ninja-overview' for the
// other three — and logged per key through fail-log.mjs: one line when a key
// starts failing, one when it recovers, at most one per interval in between.
import { createFailureLog } from './fail-log.mjs'
import { AGENT_BASE } from './version.mjs'

// poe.ninja (poe1/api/economy): descriptive user agent (usage policy; tool name
// and version from version.mjs, then the purpose), responses
// are HTTP-cached for ~5min and PoE1 data updates ~every 15min -> NEVER poll
// faster than 15min; additionally cached server-side here.
export const NINJA_UA = `${AGENT_BASE} (personal LAN tool)`
export const NINJA_BASE = 'https://poe.ninja/poe1/api/economy'
export const NINJA_MIN_MS = 15 * 60 * 1000
// How long a poe.ninja answer may still be served after poe.ninja stopped
// answering (POE_NINJA_MAX_AGE_MS). One day: long enough to ride out an
// evening's outage, short enough that a week-old unique price never stands in
// for a current one.
export const NINJA_MAX_AGE_DEFAULT_MS = 24 * 60 * 60 * 1000
// How long the valuator keeps its merged exchange map (POE_NINJA_MAP_TTL_MS).
export const NINJA_MAP_TTL_DEFAULT_MS = 60 * 60 * 1000
// How often a key that keeps failing is logged again (POE_NINJA_FAIL_LOG_MS).
export const NINJA_FAIL_LOG_DEFAULT_MS = 60 * 60 * 1000
// How long one request may take, answer body included, before it counts as a
// failed attempt (a network error) and waits NINJA_MIN_MS like any other.
export const NINJA_FETCH_TIMEOUT_DEFAULT_MS = 15 * 1000

export const round1 = n => Math.round(n * 10) / 10

// An exchange rate as a price: round1 would flatten a genuinely sub-chaos
// fungible (lifeforce & co trade near 0.018 c a piece) to a flat "0", so three
// significant digits below 1 c, one decimal above. Significant digits, not
// three decimals: a rate under 0.0005 c would round to 0 again, and 0 is no
// valid price (hasValidPrice), so a page reconnect would re-queue the card as a
// trade search. One rounding for every place an exchange rate becomes a price
// (server.mjs: the card's headline, the empty-bulk branch of the price job,
// and the early answer for the game), so they show one number.
export const roundExchange = v => (v < 1 ? Number(Number(v).toPrecision(3)) : round1(v))

// Clean up the raw sparkline array: leading null -> 0 (baseline), keep point count.
// (Same rule that ninjaRefFor uses inline.)
export const normSpark = raw => (Array.isArray(raw) && raw.some(n => typeof n === 'number')
  ? raw.map(n => (typeof n === 'number' ? n : 0)) : [])

// ---- Configuration and the shared fetch path --------------------------------
// The defaults are built on import and touch nothing; the server hands in the
// numbers it read from the environment and the callback that feeds
// source-health.mjs. Tests hand in a clock.
function defaultCfg () {
  return {
    onOutcome: () => {},
    maxAgeMs: NINJA_MAX_AGE_DEFAULT_MS,
    fetchTimeoutMs: NINJA_FETCH_TIMEOUT_DEFAULT_MS,
    now: () => Date.now(),
    failLog: createFailureLog({ prefix: '[ninja]', everyMs: NINJA_FAIL_LOG_DEFAULT_MS })
  }
}
let cfg = defaultCfg()

/**
 * configureNinja({ onOutcome, maxAgeMs, fetchTimeoutMs, failLogEveryMs, now, log })
 *
 *   onOutcome(source, { ok, at } | { ok: false, kind, reason, at })
 *             source is 'ninja-cd' or 'ninja-overview'.
 *   maxAgeMs  how long an answer is served after it was fetched, once
 *             refreshing it failed.
 *   fetchTimeoutMs  how long one request may take (tests hand in a short one).
 *   failLogEveryMs, log   the failure log (fail-log.mjs).
 */
export function configureNinja ({ onOutcome, maxAgeMs, fetchTimeoutMs, failLogEveryMs, now, log } = {}) {
  const next = { ...cfg }
  if (typeof onOutcome === 'function') next.onOutcome = onOutcome
  if (typeof maxAgeMs === 'number' && maxAgeMs > 0) next.maxAgeMs = maxAgeMs
  if (typeof fetchTimeoutMs === 'number' && fetchTimeoutMs > 0) next.fetchTimeoutMs = fetchTimeoutMs
  if (typeof now === 'function') next.now = now
  if (failLogEveryMs !== undefined || log !== undefined || now !== undefined) {
    next.failLog = createFailureLog({
      prefix: '[ninja]',
      everyMs: typeof failLogEveryMs === 'number' ? failLogEveryMs : NINJA_FAIL_LOG_DEFAULT_MS,
      now: next.now,
      log: log || console
    })
  }
  cfg = next
}

function report (source, key, subject, outcome) {
  try { cfg.onOutcome(source, outcome) } catch (e) { console.warn('[ninja] onOutcome failed: %s', e?.message || e) }
  if (outcome.ok) cfg.failLog.ok(`${source}|${key}`, subject)
  else cfg.failLog.fail(`${source}|${key}`, subject, outcome.reason)
}

// A cache entry: { at, fetchedAt, data }. `at` is the last ATTEMPT and drives
// NINJA_MIN_MS; `fetchedAt` is when the answer in `data` arrived (null for a
// negative-cached 404, which has no age that could run out).
function serve (e, t) {
  if (!e || e.data == null) return null
  if (e.fetchedAt != null && t - e.fetchedAt > cfg.maxAgeMs) return null
  return e.data
}

// The request running for a key, per cache: while the first lookup of a cold
// key waits for poe.ninja, every further caller (a burst of buyer whispers, a
// stash tab full of items) joins it instead of sending a request of its own.
const inflight = new WeakMap() // cache -> Map(key -> promise)

function cachedFetch (opts) {
  const { cache, key } = opts
  const t = cfg.now()
  const c = cache.get(key)
  if (c && t - c.at < NINJA_MIN_MS) return Promise.resolve(serve(c, t))
  let running = inflight.get(cache)
  if (!running) { running = new Map(); inflight.set(cache, running) }
  const joined = running.get(key)
  if (joined) return joined
  const p = fetchOnce(opts).finally(() => { if (running.get(key) === p) running.delete(key) })
  running.set(key, p)
  return p
}

// fetchImpl with a deadline that holds even when the impl ignores its signal:
// past cfg.fetchTimeoutMs the attempt rejects (a network error for fetchOnce)
// and the request is aborted. The answer body is read inside the deadline.
function fetchWithTimeout (fetchImpl, url, init) {
  const ctl = new AbortController()
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`no answer within ${cfg.fetchTimeoutMs} ms`)
      try { ctl.abort(e) } catch { /* nothing left to abort */ }
      reject(e)
    }, cfg.fetchTimeoutMs)
    try { timer.unref?.() } catch { /* a fake timer */ }
  })
  const run = (async () => {
    const r = await fetchImpl(url, { ...init, signal: ctl.signal })
    return { r, j: r.ok ? await r.json() : null }
  })()
  run.catch(() => {}) // lost the race: its late rejection is not unhandled
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer))
}

async function fetchOnce ({ cache, key, source, subject, url, fetchImpl, accept, parse, empty, count }) {
  const t = cfg.now()
  const c = cache.get(key)
  // A failed attempt is an attempt: it waits NINJA_MIN_MS like an answer, and
  // the last good answer (with ITS fetchedAt) stays in place.
  const keepLast = fallback => ({ at: t, fetchedAt: c?.fetchedAt ?? null, data: c?.data ?? fallback })
  try {
    const { r, j } = await fetchWithTimeout(fetchImpl, url, { headers: { 'User-Agent': NINJA_UA, Accept: 'application/json' } })
    if (r.ok) {
      if (accept(j)) {
        const data = parse(j, t)
        cache.set(key, { at: t, fetchedAt: t, data })
        if (count(data) > 0) report(source, key, subject, { ok: true, at: t })
        else report(source, key, subject, { ok: false, kind: 'rejected', reason: 'answered with no prices for this league', at: t })
        return data
      }
      cache.set(key, keepLast(empty()))
      report(source, key, subject, { ok: false, kind: 'rejected', reason: `unexpected answer (HTTP ${r.status})`, at: t })
      return serve(cache.get(key), t)
    }
    if (r.status === 404) {
      // A retired type: an empty answer for the full TTL, as before.
      cache.set(key, { at: t, fetchedAt: null, data: empty() })
      report(source, key, subject, { ok: false, kind: 'rejected', reason: 'HTTP 404', at: t })
      return serve(cache.get(key), t)
    }
    cache.set(key, keepLast(empty()))
    const kind = (r.status >= 500 || r.status === 429) ? 'unreachable' : 'rejected'
    report(source, key, subject, { ok: false, kind, reason: `HTTP ${r.status}`, at: t })
    return serve(cache.get(key), t)
  } catch (e) {
    cache.set(key, keepLast(null))
    report(source, key, subject, { ok: false, kind: 'unreachable', reason: `network error: ${e?.message || e}`, at: t })
    return serve(cache.get(key), t)
  }
}

// Shared, cached fetch of the currency EXCHANGE response (Faustus NPC).
// Currency trading nowadays runs almost exclusively via the exchange; the
// stash value is practically irrelevant. exchange/current/overview: core.primary
// == "chaos", lines[] with { id, primaryValue, sparkline:{data} }. BOTH C:D
// (id==="divine") AND the currency/lifeforce reference rows are derived from THIS
// one response -> only ONE request per league (cached >=15min), no double poll.
// The answer carries `fetchedAt`: the C:D tile and the reference rail show the
// age of the DATA, not of the last attempt.
const exchangeCache = new Map() // league -> { at, fetchedAt, data }

export async function fetchCurrencyExchange (league, { fetchImpl = fetch } = {}) {
  return cachedFetch({
    cache: exchangeCache,
    key: league,
    source: 'ninja-cd',
    subject: `currency exchange league=${league}`,
    url: `${NINJA_BASE}/exchange/current/overview?league=${encodeURIComponent(league)}&type=Currency`,
    fetchImpl,
    accept: j => j?.core?.primary === 'chaos' && Array.isArray(j.lines),
    parse: (j, t) => ({ lines: j.lines, fetchedAt: t }),
    empty: () => ({ lines: [], fetchedAt: null }),
    count: d => d.lines.length
  })
}

// Generalized version of fetchCurrencyExchange for arbitrary exchange `type`s
// (Divination Cards, Scarabs, Oils, ... — see NINJA_BULK_CLASSES below). SAME
// endpoint family (exchange/current/overview), SAME >=15min server-side cache
// policy, just keyed by `${league}|${type}` instead of hardcoding
// type=Currency. Response shape here additionally carries `items[]` (id -> {
// name, ... }) — the exchange `lines[]` themselves have NO name field, only
// `id` (a slug), so matching a ParsedItem's display name needs this side
// table. Pre-indexed both ways (name->id, id->line) so a per-item lookup
// (ninjaBulkPrice, called once per priced item) is O(1) instead of an O(n)
// scan of a ~100-line array.
const exchangeOverviewCache = new Map() // `${league}|${type}` -> { at, fetchedAt, data }

const emptyExchange = () => ({ nameToId: new Map(), lineById: new Map() })

// Negative-caching: a 404 (a retired type) is cached as an EMPTY result for
// the FULL TTL, so an unpriced item is asked at most ONCE per league|type per
// 15min instead of re-firing on every stash line. Any other failure keeps the
// last good answer (see the header) and waits the same 15 minutes.
export async function fetchExchangeOverview (league, type, { fetchImpl = fetch } = {}) {
  return cachedFetch({
    cache: exchangeOverviewCache,
    key: `${league}|${type}`,
    source: 'ninja-overview',
    subject: `exchange overview league=${league} type=${type}`,
    url: `${NINJA_BASE}/exchange/current/overview?league=${encodeURIComponent(league)}&type=${encodeURIComponent(type)}`,
    fetchImpl,
    accept: j => j?.core?.primary === 'chaos' && Array.isArray(j.lines) && Array.isArray(j.items),
    parse: j => ({
      nameToId: new Map(j.items.map(it => [it.name, it.id])),
      lineById: new Map(j.lines.map(l => [l.id, l]))
    }),
    empty: emptyExchange,
    count: d => d.lineById.size
  })
}

// ---------------------------------------------------------------------------
// poe.ninja stash CURRENCY overview (Currency / Fragment). DIFFERENT endpoint
// and shape from the currency EXCHANGE (fetchCurrencyExchange, Faustus NPC)
// above: `stash/current/currency/overview` returns lines[] with
// `currencyTypeName` (the display name) + `chaosEquivalent` (poe.ninja's own
// aggregated chaos value) + `currencyDetails[]`. Used as the MIDDLE stage of
// the fungible fallback chain (Faustus -> here -> exchange overview) in the
// valuator, and as the live Divine `chaosEquivalent` source for the Faustus
// bridge + corpse pricer (never a static C:D constant). Negative-cached exactly
// like the other fetchers (a 404 -> empty map for the full TTL; any other
// failure keeps the last good value up to maxAgeMs).
// ---------------------------------------------------------------------------
const currencyOverviewCache = new Map() // `${league}|${type}` -> { at, fetchedAt, data }
const emptyCurrency = () => ({ byName: new Map() })

export async function fetchCurrencyOverview (league, type, { fetchImpl = fetch } = {}) {
  return cachedFetch({
    cache: currencyOverviewCache,
    key: `${league}|${type}`,
    source: 'ninja-overview',
    subject: `currency overview league=${league} type=${type}`,
    url: `${NINJA_BASE}/stash/current/currency/overview?league=${encodeURIComponent(league)}&type=${encodeURIComponent(type)}`,
    fetchImpl,
    accept: j => Array.isArray(j?.lines),
    parse: j => {
      const byName = new Map()
      for (const l of j.lines) {
        if (l && typeof l.currencyTypeName === 'string' && typeof l.chaosEquivalent === 'number') {
          byName.set(l.currencyTypeName, l.chaosEquivalent)
        }
      }
      return { byName }
    },
    empty: emptyCurrency,
    count: d => d.byName.size
  })
}

// ---------------------------------------------------------------------------
// F3 (stretch): poe.ninja reference price + 7-day sparkline per unique.
// item/overview returns lines[] with name/baseType/chaosValue/divineValue/sparkline.
// Match only for uniques (rares have no ninja price). Cached server-side.
// ---------------------------------------------------------------------------
// Item class -> poe.ninja item/overview `type`.
export function ninjaTypeFor (item) {
  const c = item.category
  if (c === 'Amulet' || c === 'Belt' || c === 'Ring' || c === 'Trinket' || c === 'Charm') return 'UniqueAccessory'
  if (c === 'Helmet' || c === 'Body Armour' || c === 'Gloves' || c === 'Boots' || c === 'Shield' || c === 'Quiver') return 'UniqueArmour'
  if (c === 'Flask') return 'UniqueFlask'
  if (c === 'Jewel' || c === 'Abyss Jewel' || c === 'Cluster Jewel') return 'UniqueJewel'
  if (c === 'Map') return 'UniqueMap'
  const weapons = new Set(['Claw', 'Bow', 'Sceptre', 'Wand', 'Fishing Rod', 'Staff', 'Warstaff',
    'Dagger', 'Rune Dagger', 'One-Handed Axe', 'Two-Handed Axe', 'One-Handed Mace', 'Two-Handed Mace',
    'One-Handed Sword', 'Two-Handed Sword'])
  if (weapons.has(c)) return 'UniqueWeapon'
  return null
}

const itemOverviewCache = new Map() // `${league}|${type}` -> { at, fetchedAt, data: lines[] }

export async function fetchItemOverview (league, type, { fetchImpl = fetch } = {}) {
  return cachedFetch({
    cache: itemOverviewCache,
    key: `${league}|${type}`,
    source: 'ninja-overview',
    subject: `item overview league=${league} type=${type}`,
    url: `${NINJA_BASE}/stash/current/item/overview?league=${encodeURIComponent(league)}&type=${encodeURIComponent(type)}`,
    fetchImpl,
    // An ok answer without lines[] is not silently []: it is an unexpected
    // answer and is reported as one.
    accept: j => Array.isArray(j?.lines),
    parse: j => j.lines,
    empty: () => [],
    count: lines => lines.length
  })
}

// When the item overview answer that fetchItemOverview serves for this key was
// fetched (null: none, or a negative-cached 404). The rail history needs it to
// tell a new beast answer from the last good one served again (B29); the lines
// themselves stay a plain array for the other callers.
export function itemOverviewFetchedAt (league, type) {
  const e = itemOverviewCache.get(`${league}|${type}`)
  return e && typeof e.fetchedAt === 'number' ? e.fetchedAt : null
}

// Test-only: drop all module caches so cases don't leak state into each other,
// and put the configuration (clock, callback, failure log) back to its defaults.
export function __clearNinjaCaches () {
  exchangeCache.clear()
  exchangeOverviewCache.clear()
  currencyOverviewCache.clear()
  itemOverviewCache.clear()
  cfg = defaultCfg()
}
