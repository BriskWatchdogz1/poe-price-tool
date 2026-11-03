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

import { AGENT_BASE } from './version.mjs'

const TRADE_STATS_URL = 'https://www.pathofexile.com/api/trade/data/stats'
// Tool name and version (version.mjs), then the purpose.
const UA = `${AGENT_BASE} (personal LAN tool)`
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

// Same text, minus a literal sign in front of a placeholder: "+# to maximum
// Life" -> "# to maximum Life".
//
// Only resolveMatcherForm uses this, and only because of where its input comes
// from: the de->en pair table (mod-text-pairs.mjs) is built from GGG's own
// description lines, where the sign belongs to the placeholder (`{0:+d}`) and
// is swallowed with it. The catalogue writes it out. So the two agree on every
// word and disagree on exactly one character, systematically, for the whole
// class of flat additive mods.
export const signlessStatText = key => String(key).replace(/(^|[\s([])[+-]#/g, '$1#')

export function createTradeStatIndex ({
  fetchImpl = fetch,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  url = TRADE_STATS_URL,
} = {}) {
  let index = null // { byText: Map<"type|text", id>, bySignless: Map<..., id|null> }
  let loadedAt = 0
  let nextAttemptAt = 0
  let inflight = null

  function build (payload) {
    const byText = new Map()
    const bySignless = new Map()
    for (const group of payload?.result || []) {
      for (const entry of group?.entries || []) {
        if (!entry?.id || !entry?.text) continue
        // Options-based stats (id + a separate option list) can't be matched from
        // the item's flat text alone -> skip rather than mis-resolve.
        if (entry.option) continue
        const type = typeOfId(entry.id)
        const norm = normalizeStatText(entry.text)
        const key = `${type}|${norm}`
        if (!byText.has(key)) byText.set(key, entry.id) // first wins (catalogue order)
        // Two catalogue entries that differ ONLY in the sign are two different
        // stats; nothing may be resolved from a text that cannot tell them
        // apart. `null` is the poison value, same rule as everywhere else here.
        const loose = `${type}|${signlessStatText(norm)}`
        if (bySignless.has(loose)) {
          if (bySignless.get(loose) !== entry.id) bySignless.set(loose, null)
        } else {
          bySignless.set(loose, entry.id)
        }
      }
    }
    return { byText, bySignless }
  }

  async function load () {
    if (index && now() - loadedAt < ttlMs) return index
    if (now() < nextAttemptAt) return index // in failure cooldown
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const payload = await r.json()
        index = build(payload)
        loadedAt = now()
        nextAttemptAt = 0
        console.log('[trade-stats] catalogue loaded (%d stats)', index.byText.size)
      } catch (e) {
        nextAttemptAt = now() + FAIL_COOLDOWN_MS
        console.warn('[trade-stats] catalogue unavailable (%s) — unknown mods stay unsearchable', e?.message || e)
      } finally {
        inflight = null
      }
      return index
    })()
    return inflight
  }

  // Returns the trade id for this mod text/type, or null when the catalogue is
  // unavailable or has no match. `type` is the unknownModifier type
  // ('implicit' | 'explicit' | 'fractured' | 'crafted' | 'enchant' | ...).
  async function resolve (text, type) {
    const idx = await load()
    if (!idx) return null
    const norm = normalizeStatText(text)
    const t = String(type || 'explicit').toLowerCase()
    return idx.byText.get(`${t}|${norm}`) ?? null
  }

  // Same lookup for a text that is already English but arrives in APT's MATCHER
  // form — the output of the de->en pair table, which has no literal signs (see
  // signlessStatText). Exact first, so a text that does carry its sign is never
  // decided by the looser key; signless second; a signless key two catalogue
  // entries share resolves to nothing.
  //
  // Deliberately a second entry point rather than a flag on resolve(): the
  // English path must stay bit-for-bit what it was.
  async function resolveMatcherForm (text, type) {
    const idx = await load()
    if (!idx) return null
    const norm = normalizeStatText(text)
    const t = String(type || 'explicit').toLowerCase()
    return idx.byText.get(`${t}|${norm}`) ??
      idx.bySignless.get(`${t}|${signlessStatText(norm)}`) ??
      null
  }

  return { load, resolve, resolveMatcherForm, get size () { return index ? index.byText.size : 0 } }
}
