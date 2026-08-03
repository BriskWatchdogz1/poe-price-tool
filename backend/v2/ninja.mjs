// backend/v2/ninja.mjs
// poe.ninja fetchers, extracted from server.mjs (not exported there and
// not importable due to import side effects). Shared by server.mjs
// (price path, reference rail) and backend/v2/networth/ (valuator).
// Importable without side effects: only module caches, no network call on import.
// Cache policy unchanged: >= 15min per league|type, descriptive UA.

// poe.ninja (poe1/api/economy): descriptive user agent (usage policy), responses
// are HTTP-cached for ~5min and PoE1 data updates ~every 15min -> NEVER poll
// faster than 15min; additionally cached server-side here.
export const NINJA_UA = 'poe-price-tool/0.1 (personal LAN tool)'
export const NINJA_BASE = 'https://poe.ninja/poe1/api/economy'
export const NINJA_MIN_MS = 15 * 60 * 1000

export const round1 = n => Math.round(n * 10) / 10

// Clean up the raw sparkline array: leading null -> 0 (baseline), keep point count.
// (Same rule that ninjaRefFor uses inline.)
export const normSpark = raw => (Array.isArray(raw) && raw.some(n => typeof n === 'number')
  ? raw.map(n => (typeof n === 'number' ? n : 0)) : [])

// Shared, cached fetch of the currency EXCHANGE response (Faustus NPC).
// Currency trading nowadays runs almost exclusively via the exchange; the
// stash value is practically irrelevant. exchange/current/overview: core.primary
// == "chaos", lines[] with { id, primaryValue, sparkline:{data} }. BOTH C:D
// (id==="divine") AND the currency/lifeforce reference rows are derived from THIS
// one response -> only ONE request per league (cached >=15min), no double poll.
const exchangeCache = new Map() // league -> { at, data }

export async function fetchCurrencyExchange (league) {
  const c = exchangeCache.get(league)
  if (c && Date.now() - c.at < NINJA_MIN_MS) return c.data
  try {
    const url = `${NINJA_BASE}/exchange/current/overview?league=${encodeURIComponent(league)}&type=Currency`
    const r = await fetch(url, { headers: { 'User-Agent': NINJA_UA, Accept: 'application/json' } })
    if (r.ok) {
      const j = await r.json()
      if (j?.core?.primary === 'chaos' && Array.isArray(j.lines)) {
        const data = { lines: j.lines }
        exchangeCache.set(league, { at: Date.now(), data })
        return data
      }
    }
    // Negative-cache a bad/unexpected response for the full TTL (consistency
    // with the item/exchange fetchers; callers treat empty lines as "no data").
    const data = c ? c.data : { lines: [] }
    exchangeCache.set(league, { at: Date.now(), data })
    return data
  } catch { /* network/provider down -> keep last known, don't poison the cache */ }
  return c ? c.data : null
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
const exchangeOverviewCache = new Map() // `${league}|${type}` -> { at, data }

// Network errors we already warned about (per fn|key) — keep the catch path
// from spamming the log on every unpriced item.
const netWarned = new Set()
function warnNetOnce (fn, key, err) {
  if (netWarned.has(`${fn}|${key}`)) return
  netWarned.add(`${fn}|${key}`)
  console.warn('[ninja] %s %s -> network error: %s', fn, key, String(err?.message || err))
}

const emptyExchange = () => ({ nameToId: new Map(), lineById: new Map() })

// Negative-caching: a 404 (or any !ok / unexpected shape) is cached as an
// EMPTY result for the FULL TTL, so an unpriced item is asked at most ONCE
// per league|type per 15min instead of re-firing on every stash line. A
// network error does NOT poison the cache — it falls back to the last cached
// value (or null) and retries next time.
export async function fetchExchangeOverview (league, type, { fetchImpl = fetch } = {}) {
  const key = `${league}|${type}`
  const c = exchangeOverviewCache.get(key)
  if (c && Date.now() - c.at < NINJA_MIN_MS) return c.data
  try {
    const url = `${NINJA_BASE}/exchange/current/overview?league=${encodeURIComponent(league)}&type=${encodeURIComponent(type)}`
    const r = await fetchImpl(url, { headers: { 'User-Agent': NINJA_UA, Accept: 'application/json' } })
    if (r.ok) {
      const j = await r.json()
      if (j?.core?.primary === 'chaos' && Array.isArray(j.lines) && Array.isArray(j.items)) {
        const data = {
          nameToId: new Map(j.items.map(it => [it.name, it.id])),
          lineById: new Map(j.lines.map(l => [l.id, l]))
        }
        exchangeOverviewCache.set(key, { at: Date.now(), data })
        return data
      }
      console.warn('[ninja] fetchExchangeOverview type=%s -> HTTP %d (unexpected shape)', type, r.status)
    } else {
      console.warn('[ninja] fetchExchangeOverview type=%s -> HTTP %d', type, r.status)
    }
    const empty = emptyExchange()
    exchangeOverviewCache.set(key, { at: Date.now(), data: empty })
    return empty
  } catch (e) {
    warnNetOnce('fetchExchangeOverview', key, e)
    return c ? c.data : null
  }
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
// like the other fetchers (a 404 / bad shape -> empty map for the full TTL; a
// network error keeps the last good value, no cache poisoning).
// ---------------------------------------------------------------------------
const currencyOverviewCache = new Map() // `${league}|${type}` -> { at, data }
const emptyCurrency = () => ({ byName: new Map() })

export async function fetchCurrencyOverview (league, type, { fetchImpl = fetch } = {}) {
  const key = `${league}|${type}`
  const c = currencyOverviewCache.get(key)
  if (c && Date.now() - c.at < NINJA_MIN_MS) return c.data
  try {
    const url = `${NINJA_BASE}/stash/current/currency/overview?league=${encodeURIComponent(league)}&type=${encodeURIComponent(type)}`
    const r = await fetchImpl(url, { headers: { 'User-Agent': NINJA_UA, Accept: 'application/json' } })
    if (r.ok) {
      const j = await r.json()
      if (Array.isArray(j.lines)) {
        const byName = new Map()
        for (const l of j.lines) {
          if (l && typeof l.currencyTypeName === 'string' && typeof l.chaosEquivalent === 'number') {
            byName.set(l.currencyTypeName, l.chaosEquivalent)
          }
        }
        const data = { byName }
        currencyOverviewCache.set(key, { at: Date.now(), data })
        return data
      }
      console.warn('[ninja] fetchCurrencyOverview type=%s -> HTTP %d (unexpected shape)', type, r.status)
    } else {
      console.warn('[ninja] fetchCurrencyOverview type=%s -> HTTP %d', type, r.status)
    }
    const empty = emptyCurrency()
    currencyOverviewCache.set(key, { at: Date.now(), data: empty })
    return empty
  } catch (e) {
    warnNetOnce('fetchCurrencyOverview', key, e)
    return c ? c.data : null
  }
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

const itemOverviewCache = new Map() // `${league}|${type}` -> { at, lines }

export async function fetchItemOverview (league, type, { fetchImpl = fetch } = {}) {
  const key = `${league}|${type}`
  const c = itemOverviewCache.get(key)
  if (c && Date.now() - c.at < NINJA_MIN_MS) return c.lines
  try {
    const url = `${NINJA_BASE}/stash/current/item/overview?league=${encodeURIComponent(league)}&type=${encodeURIComponent(type)}`
    const r = await fetchImpl(url, { headers: { 'User-Agent': NINJA_UA, Accept: 'application/json' } })
    if (r.ok) {
      const j = await r.json()
      const lines = Array.isArray(j.lines) ? j.lines : []
      itemOverviewCache.set(key, { at: Date.now(), lines })
      return lines
    }
    // Negative-cache !ok (e.g. 404 on retired types) as EMPTY for the full TTL.
    console.warn('[ninja] fetchItemOverview type=%s -> HTTP %d', type, r.status)
    itemOverviewCache.set(key, { at: Date.now(), lines: [] })
    return []
  } catch (e) {
    warnNetOnce('fetchItemOverview', key, e)
    return c ? c.lines : null
  }
}

// Test-only: drop all module caches so cases don't leak state into each other.
export function __clearNinjaCaches () {
  exchangeCache.clear()
  exchangeOverviewCache.clear()
  currencyOverviewCache.clear()
  itemOverviewCache.clear()
  netWarned.clear()
}
