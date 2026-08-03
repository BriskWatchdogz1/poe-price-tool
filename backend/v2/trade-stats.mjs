// backend/v2/trade-stats.mjs
// Resolves mod texts APT could NOT map to a trade stat-id against GGG's own
// public stat catalogue (https://www.pathofexile.com/api/trade/data/stats).
//
// Why: the app bundles APT's stat database, and that snapshot can lag GGG. A mod
// missing from it lands in item.unknownModifiers -> it was neither searchable nor
// (before this) even visible, which silently understates an item: a corruption
// implicit is PERMANENT on the item, so it belongs in the search, not in a
// footnote. Observed case: "+# to Level of Socketed Physical Gems" — the bundled
// DB has 25 sibling "Socketed <tag> Gems" stats but not Physical, while GGG lists
// it as implicit.stat_516565950.
//
// This is a DATA endpoint, not the trade search: it does NOT go through the
// shared search RateLimiter and cannot cause a search ban. It's fetched at most
// once per TTL (default 24h), lazily on first use, with a short cooldown after a
// failure so a hiccup can't turn into a fetch loop. Every failure degrades
// silently to "unresolved" (the mod stays visible as not-searchable).

const TRADE_STATS_URL = 'https://www.pathofexile.com/api/trade/data/stats'
const UA = 'poe-price-tool/0.1 (personal LAN tool)'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const FAIL_COOLDOWN_MS = 10 * 60 * 1000

// "+2 to Level of Socketed Physical Gems" -> "+# to Level of Socketed Physical Gems"
// GGG writes every numeric slot as '#', so normalising the item's rolled numbers
// the same way makes the two directly comparable. Also collapses whitespace.
export function normalizeStatText (text) {
  // Replace the DIGITS only, never the sign: GGG writes "+# to Level of ...",
  // so swallowing the '+' from "+2" would produce "# to Level of ..." and miss.
  return String(text ?? '')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

// Trade ids are namespaced by type ("implicit.stat_x", "explicit.stat_y"), which
// is exactly the discriminator we need: the same wording can exist as both.
function typeOfId (id) {
  const i = String(id).indexOf('.')
  return i === -1 ? '' : String(id).slice(0, i)
}

export function createTradeStatIndex ({
  fetchImpl = fetch,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  url = TRADE_STATS_URL,
} = {}) {
  let byTypeAndText = null // Map<"type|normalized text", tradeId>
  let loadedAt = 0
  let nextAttemptAt = 0
  let inflight = null

  function index (payload) {
    const map = new Map()
    for (const group of payload?.result || []) {
      for (const entry of group?.entries || []) {
        if (!entry?.id || !entry?.text) continue
        // Options-based stats (id + a separate option list) can't be matched from
        // the item's flat text alone -> skip rather than mis-resolve.
        if (entry.option) continue
        const key = `${typeOfId(entry.id)}|${normalizeStatText(entry.text)}`
        if (!map.has(key)) map.set(key, entry.id) // first wins (catalogue order)
      }
    }
    return map
  }

  async function load () {
    if (byTypeAndText && now() - loadedAt < ttlMs) return byTypeAndText
    if (now() < nextAttemptAt) return byTypeAndText // in failure cooldown
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const payload = await r.json()
        byTypeAndText = index(payload)
        loadedAt = now()
        nextAttemptAt = 0
        console.log('[trade-stats] catalogue loaded (%d stats)', byTypeAndText.size)
      } catch (e) {
        nextAttemptAt = now() + FAIL_COOLDOWN_MS
        console.warn('[trade-stats] catalogue unavailable (%s) — unknown mods stay unsearchable', e?.message || e)
      } finally {
        inflight = null
      }
      return byTypeAndText
    })()
    return inflight
  }

  // Returns the trade id for this mod text/type, or null when the catalogue is
  // unavailable or has no match. `type` is the unknownModifier type
  // ('implicit' | 'explicit' | 'fractured' | 'crafted' | 'enchant' | ...).
  async function resolve (text, type) {
    const map = await load()
    if (!map) return null
    const norm = normalizeStatText(text)
    const t = String(type || 'explicit').toLowerCase()
    return map.get(`${t}|${norm}`) ?? null
  }

  return { load, resolve, get size () { return byTypeAndText ? byTypeAndText.size : 0 } }
}
