// backend/v2/networth/kinds.mjs
// SINGLE SOURCE OF TRUTH for item categories ("kinds").
//
// ── To add a NEW category on an EXISTING price source ───────────────────────
// 1. Add ONE entry to CLASSIFIERS  — how to DETECT it from a GGG stash item.
// 2. Add ONE entry to VALUATION_ROUTES — how to PRICE it (which cached route).
// Nothing else changes: normalize.mjs runs the CLASSIFIERS in order and
// valuator.mjs dispatches VALUATION_ROUTES[desc.kind]. No if/else to touch.
// This 2-line story ONLY holds when the route reuses a source the valuator
// already exposes (fromExchangeMap / fromItemOverview / fromFaustus / …). A
// genuinely NEW price SOURCE is more work: add the fetcher + an `api.fromX`
// helper in valuator.mjs, and usually a store + background refresher + server
// wiring (see how Faustus/corpses are threaded) before a route can call it.
//
// A CLASSIFIER is { kind, detect(ctx) }. detect returns a *descriptor* object
// (or a { kind:'skip', reason } descriptor to claim-and-drop the item) or null
// meaning "not mine — try the next rule". ORDER MATTERS: the first non-null
// descriptor wins. ctx carries everything a rule can need:
//   { ggg, name, typeLine, stack, frame, entry, index }
//   - ggg      = raw GGG stash item JSON (legacy get-stash-items)
//   - name/typeLine = markup-stripped strings; stack = stackSize (>=1)
//   - frame    = ggg.frameType; entry = items.ndjson index entry for typeLine
//   - index    = the loaded items index (has categoryOfBase)
//
// A VALUATION_ROUTE is  kind -> async (desc, api) => ({ each, source, uncertain? })
// where `each` is chaos-per-unit (null = honestly unpriced -> lands in
// `unpriced`, NEVER counted as 0) and `uncertain` is a code from valuator.mjs
// UNCERTAIN or null (no known doubt; a route that names none yields null).
// `api` bundles the helpers built in valuator.mjs: fromFaustus,
// fromCorpseStore, fromNinjaCurrencyOverview, fromExchangeMap, exchangeSingle,
// fromItemOverview, fromGem, plus league. Each helper answers null or
// { each, uncertain }; `answer` below turns that into a route result.
import { ninjaTypeFor } from '../ninja.mjs'

// Pull a numeric property (Level / Quality) out of the GGG properties array.
// poe-JSON: properties[].name === 'Level' | 'Quality', value in values[0][0]
// (a string like "20" or "+20%"). Robust against missing arrays/fields.
function gemProp (ggg, propName) {
  const props = Array.isArray(ggg.properties) ? ggg.properties : []
  const p = props.find(x => x && x.name === propName)
  const raw = p?.values?.[0]?.[0]
  if (raw == null) return null
  const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

// Itemised "Corpse" items (coffin/corpse items, item class Corpse). In
// items.ndjson they are plain ITEM entries WITHOUT tradeTag/exchangeable/
// category — the only stable signal is the icon filename ("…Corpse.png"; the
// gem corpse-skills end in CorpseWarp.png/CorpseEruption.png and are excluded
// by the frame===4 gem rule anyway).
const isCorpseIcon = icon => /Corpse\.png$/.test(String(icon || ''))
export const isCorpseEntry = e => e?.namespace === 'ITEM' && isCorpseIcon(e.icon)

// Itemised corpses whose name starts with "Imperfect " are stated worthless ->
// valued 0 (the ONE documented exception to null-never-0). Skip the trade query.
export const isImperfectCorpse = name => typeof name === 'string' && name.startsWith('Imperfect ')

const itemNoTag = e => e?.namespace === 'ITEM' && e.tradeTag == null

// Largest linked socket group of a stash item. GGG returns sockets[] as
// { group, attr, sColour }; all sockets sharing a group are linked. Needed for
// unique valuation: poe.ninja carries 5L and 6L as their own, considerably more
// expensive lines.
export function maxLinks (ggg) {
  const sockets = Array.isArray(ggg?.sockets) ? ggg.sockets : []
  if (!sockets.length) return 0
  const per = new Map()
  for (const s of sockets) per.set(s.group, (per.get(s.group) || 0) + 1)
  return Math.max(...per.values())
}

// Every mod text a GGG stash item states, as a flat string list. Needed for the
// unique VARIANT match in valuator.mjs: poe.ninja lists a variant-carrying unique
// once per variant and the only item-side signal that separates them is the mod
// text (see the block comment there).
// Collected by RULE, not by a hardcoded key list: GGG puts mods in a growing set
// of `*Mods` arrays (implicitMods, explicitMods, craftedMods, enchantMods,
// fracturedMods, utilityMods on flasks, scourgeMods, crucibleMods, …) and a new
// league regularly adds one. Anything that is an array of strings and ends in
// "Mods" counts; non-string entries (logbookMods holds objects) are skipped, so
// a new shape can never throw. Extra mods an overview line does not know
// (enchants, corrupted implicits) only weigh on the last tiebreak, so being
// generous here is safe. Markup stripped like the name fields.
const stripModMarkup = s => String(s).replace(/<<[^>]*>>/g, '').trim()
export function itemModTexts (ggg) {
  const out = []
  for (const [key, val] of Object.entries(ggg || {})) {
    if (!key.endsWith('Mods') || !Array.isArray(val)) continue
    for (const m of val) if (typeof m === 'string' && m.trim()) out.push(stripModMarkup(m))
  }
  return out
}

// A unique's category normally comes from the items.ndjson base join
// (categoryOfBase). Unique MAPS have no usable entry there: the bridge data
// carries only a handful of special map bases ("Blighted Map", "Nightmare Map",
// …) and none of the ~120 regular ones, so `Torture Chamber Map` &Co resolved to
// no category, ninjaTypeFor returned null and the unique route reported
// honestly-unpriced — Maelstrom of Chaos and Pillars of Arun sat in `unpriced`
// while poe.ninja's UniqueMap overview priced them (that overview also carries
// lines far above 250c, so the gap is not cosmetic).
//
// The robust signal sits on the ITEM INSTANCE: every map carries a "Map Tier"
// property (same properties[] shape the gem rule reads). Instance-based, so it
// cannot rot the way a hardcoded list of map base names would when GGG adds or
// renames bases. Tolerant of missing/odd properties — never throws.
const hasMapTier = ggg => (Array.isArray(ggg?.properties) ? ggg.properties : [])
  .some(p => p && p.name === 'Map Tier')

// …and that instance signal turned out NOT to be enough once the map stash
// started delivering (B7). What arrives from there is a base line GGG has
// DECORATED with the tier: the unpriced list read "Unidentified Map (Tier 16)
// x40", and that label is literally `Unidentified ${typeLine}` (see
// unidentifiedLabel below) — so `typeLine` is the string "Map (Tier 16)", not a
// map base name at all.
//
// The bridge data agrees on the undecorated half: EVERY unique map in
// items.ndjson carries `unique.base: "Map"` (Cortex, Hallowed Ground, Mao Kun,
// Poorjoy's Asylum, The Vinktar Square, Whakawairua Tuahu — checked, all of
// them), and the ITEM row `Map` has `craftable.category: "Map"`. So the base
// join can resolve a unique map perfectly well; it just never gets the chance,
// because it is handed "Map (Tier 16)" and looks up a name that does not exist.
// The paragraph above is therefore wrong about WHY the join misses — it is the
// decoration, not a gap in the data.
//
// Fix: when the direct join misses, drop a TRAILING PARENTHESISED decoration
// and retry. Not a map-specific rule and not a name list: no base name in
// items.ndjson contains a parenthesis at all (asserted in normalize.test.mjs),
// so the retry can never shadow a real base, and it keeps working if GGG ever
// decorates another base line the same way. The direct join still wins first,
// so nothing that is priced today changes.
//
// The decoration is also the reason the tier is NOT lost: `baseType` keeps the
// full "Map (Tier 16)", which is exactly the spelling poe.ninja's UniqueMap
// overview carries in its own `baseType` — so the tiebreak in
// valuator.mjs/fromItemOverview picks the line for the item's tier.
const undecorateBase = s => String(s || '').replace(/\s*\([^()]*\)\s*$/, '')

// Category for a unique: the base join wins, ALWAYS. Only when it yields
// nothing (today: honestly unpriced) do the undecorated retry and then the
// Map-Tier fallback get a say — so every unique that is priced today keeps its
// exact category and value.
function uniqueCategory (c) {
  const joined = c.index?.categoryOfBase(c.typeLine) ?? null
  if (joined != null) return joined
  const bare = undecorateBase(c.typeLine)
  if (bare && bare !== c.typeLine) {
    const undecorated = c.index?.categoryOfBase(bare) ?? null
    if (undecorated != null) return undecorated
  }
  return hasMapTier(c.ggg) ? 'Map' : null
}

// Unidentified uniques arrive with an EMPTY name field (GGG only reveals it on
// identification), which would otherwise produce a nameless row in the
// unpriced list ("x4 (Uniques)"). They stay unpriced — before identifying,
// WHICH unique it is is unknown, so no poe.ninja query can be honest — but the
// row must read.
// baseType == typeLine; no typeLine either -> the generic label.
const unidentifiedLabel = typeLine => typeLine ? `Unidentified ${typeLine}` : 'Unidentified Unique'

// GGG frameType: 0 normal, 1 magic, 2 rare, 3 unique, 4 gem, 5 currency,
// 6 divination card, 8 prophecy, 9 relic (foil).
// Ordered detection rules — the FIRST non-null descriptor wins.
export const CLASSIFIERS = [
  { kind: 'divcard', detect: c => c.frame === 6 ? { kind: 'divcard', name: c.typeLine, stack: c.stack } : null },
  {
    kind: 'gem',
    detect: c => c.frame === 4
      ? { kind: 'gem', name: c.typeLine, level: gemProp(c.ggg, 'Level'), quality: gemProp(c.ggg, 'Quality') ?? 0, corrupted: c.ggg.corrupted === true, stack: 1 }
      : null
  },
  {
    kind: 'unique',
    detect: c => {
      if (!(c.frame === 3 || c.frame === 9)) return null
      const unidentified = !c.name
      return {
        kind: 'unique',
        name: unidentified ? unidentifiedLabel(c.typeLine) : c.name,
        baseType: c.typeLine,
        category: uniqueCategory(c),
        unidentified,
        stack: 1,
        links: maxLinks(c.ggg),
        mods: itemModTexts(c.ggg)
      }
    }
  },
  { kind: 'beast', detect: c => c.entry?.namespace === 'CAPTURED_BEAST' ? { kind: 'beast', name: c.entry.refName, stack: 1 } : null },
  { kind: 'incubator', detect: c => itemNoTag(c.entry) && /Incubator$/.test(c.entry.refName) ? { kind: 'incubator', name: c.entry.refName, stack: c.stack } : null },
  { kind: 'vial', detect: c => itemNoTag(c.entry) && /^Vial of /.test(c.entry.refName) ? { kind: 'vial', name: c.entry.refName, stack: c.stack } : null },
  // Maven's Invitations (Incandescent/Polaric/Screaming/Writhing). No tradeTag/
  // exchangeable (so the stackable rule never claims them) — the only stable
  // signal is the base category 'Invitation' from items.ndjson. Priced via
  // poe.ninja item overview 'Invitation'. Without this rule they fell through to
  // the unknown-skip and were silently unpriced (Task 4 coverage audit).
  { kind: 'invitation', detect: c => c.index?.categoryOfBase(c.typeLine) === 'Invitation' ? { kind: 'invitation', name: c.typeLine, stack: c.stack } : null },
  // Itemised corpses (e.g. Perfect Forest Tiger, Pain Artist) — core-game Ritual
  // rewards, traded on the official site (poe.ninja doesn't list them). Prefer the
  // items.ndjson entry for its canonical refName, but fall back to the raw stash
  // icon: the bridge data doesn't index every corpse variant (Perfect/Imperfect
  // prefixes), and without the fallback an unindexed corpse (undefined entry)
  // silently becomes a skip and vanishes. Corpse icons end in "…Corpse.png"; gem
  // corpse-skills end in CorpseWarp/CorpseEruption.png and are frame-4 gems caught
  // earlier. Name from entry.refName else the stash typeLine (corpses carry the
  // name there; `name` is empty).
  {
    kind: 'corpse',
    detect: c => {
      const viaEntry = itemNoTag(c.entry) && isCorpseEntry(c.entry)
      const viaIcon = isCorpseIcon(c.ggg?.icon)
      if (!viaEntry && !viaIcon) return null
      return { kind: 'corpse', name: c.entry?.refName || c.typeLine || c.name, tradeTag: null, stack: c.stack }
    }
  },
  // Stackable currency-like items: tradeTag OR exchangeable proves poe.ninja/the
  // exchange knows the name. tradeTag == the poe.ninja exchange `id`.
  { kind: 'stackable', detect: c => (c.entry?.namespace === 'ITEM' && (c.entry.tradeTag != null || c.entry.exchangeable)) ? { kind: 'stackable', name: c.entry.refName, tradeTag: c.entry.tradeTag ?? null, stack: c.stack } : null },
  { kind: 'skip', detect: c => (c.frame === 1 || c.frame === 2) ? { kind: 'skip', reason: 'rare-gear', name: c.name || c.typeLine, stack: c.stack } : null }
]

// The kinds whose rule above pins stack to 1: one item per stash slot, never a
// stack. A buyer whisper for one of them names the whole quantity
// (whisper-price.mjs); every other kind keeps the stash's stack size.
// kinds.test.mjs holds this list and the rules together.
export const SINGLE_ITEM_KINDS = Object.freeze(new Set(['gem', 'unique', 'beast']))

// Run the ordered rules; first match wins, else an honest unknown-skip.
export function classify (ctx) {
  for (const rule of CLASSIFIERS) {
    const desc = rule.detect(ctx)
    if (desc) return desc
  }
  return { kind: 'skip', reason: 'unknown', name: ctx.name || ctx.typeLine, stack: ctx.stack }
}

// Fungible fallback chain (Task 4): the OFFICIAL GGG Currency Exchange
// (Faustus, via the persisted store) is PRIMARY for every fungible; poe.ninja
// is only the fallback for items absent from that Faustus window. First
// non-null wins, all null -> honestly unpriced (NEVER a forced 0).
//
// Order follows ONE rule: prefer sources that describe the actual Currency
// EXCHANGE market — the same market the in-game window shows.
//   1. Faustus                     (store, this league) — GGG's own digest
//   2. poe.ninja exchange overview (fromExchangeMap) — that market, aggregated
//   3. poe.ninja stash currency overview (Currency + Fragment only) — player
//      stash LISTINGS, not trades; last resort for names (2) doesn't carry.
//
// (3) sits BELOW (2) because ahead of it it misprices cheap currency badly: a
// currency with no `pay` side in the stash data comes back as
// `chaosEquivalent: 1.0`. Observed live — Armourer's Scrap at 1c each (20 of
// them counted as 20c) while the exchange overview said 0.096c, Faustus
// 0.133c, and the in-game window 1:10. Stage 3 stays as a fallback only.
// A helper's answer (null or { each, uncertain }) as a route result with its
// source — the doubt passes through untouched, the routes add no logic of
// their own.
const answer = (r, source) => (r ? { each: r.each, source, uncertain: r.uncertain ?? null } : null)
const UNPRICED = Object.freeze({ each: null, source: null, uncertain: null })

async function fungibleChain (api, name, tradeTag) {
  // `??` evaluates lazily: a later stage is only asked when every earlier one
  // missed, in the order below.
  return answer(await api.fromFaustus(name), 'faustus') ??
    answer(await api.fromExchangeMap(tradeTag, name), 'exchange') ??
    answer(await api.fromNinjaCurrencyOverview('Currency', name), 'ninja:currency') ??
    answer(await api.fromNinjaCurrencyOverview('Fragment', name), 'ninja:fragment') ??
    UNPRICED
}

// kind -> pricing route. Each returns { each, source, uncertain }; each==null = unpriced.
export const VALUATION_ROUTES = {
  stackable: async (d, api) => {
    if (d.name === 'Chaos Orb') return { each: 1, source: 'chaos', uncertain: null } // primary, has no exchange line
    // Divine Orb is the second DISPLAY unit: the entire UI converts chaos into
    // divine with the C:D rate from the poe.ninja currency exchange (cdMsgFor,
    // the same source the price check and corpse pricer use). Through the
    // normal chain Faustus would win here — the in-game rate, which legitimately
    // differs (measured: Faustus 124.5c against ninja 106c). The result would
    // have been "1 Divine Orb = 1.2 div", a unit contradicting itself. Hence the
    // same source as the display rate, and nothing else.
    if (d.name === 'Divine Orb') {
      const r = answer(await api.fromExchangeMap(d.tradeTag, d.name), 'exchange')
      if (r) return r
    }
    return fungibleChain(api, d.name, d.tradeTag)
  },
  // Div-cards are fungibles too: Faustus first (GGG's Currency Exchange carries
  // DivinationCards), then the poe.ninja card exchange overview. A card absent
  // from BOTH is honestly unpriced (null), never forced to 0 as vendor trash:
  // that would zero cards during a Faustus/exchange gap.
  divcard: async (d, api) =>
    answer(await api.fromFaustus(d.name), 'faustus') ??
    answer(await api.exchangeSingle('DivinationCard', d.name), 'exchange:DivinationCard') ??
    UNPRICED,
  // Corpses (Task 5): priced on-demand via the official Trade API, cached in the
  // corpse store (poe.ninja doesn't carry corpse prices outside a corpse-focused
  // league, and the "Coffin" exchange route returned nothing). NO live trade
  // query here — that's slow + rate-limited; a background pricer fills the
  // store.
  //  - 'Imperfect ' corpses are worthless -> hard 0, never a query (documented
  //    exception to the null-never-0 rule).
  //  - else read the store's FRESH price; a hit wins. Missing/stale -> null
  //    (this snapshot honestly unpriced) — the background pricer refills it.
  corpse: async (d, api) => {
    // A stated value of 0, not a guess: never marked.
    if (isImperfectCorpse(d.name)) return { each: 0, source: 'corpse:imperfect', uncertain: null }
    return answer(await api.fromCorpseStore(d.name), 'corpse:trade') ?? UNPRICED
  },
  gem: async (d, api) => answer(await api.fromGem(d), 'item:SkillGem') ?? UNPRICED,
  beast: async (d, api) => answer(await api.fromItemOverview('Beast', d.name), 'item:Beast') ?? UNPRICED,
  incubator: async (d, api) => answer(await api.fromItemOverview('Incubator', d.name), 'item:Incubator') ?? UNPRICED,
  vial: async (d, api) => answer(await api.fromItemOverview('Vial', d.name), 'item:Vial') ?? UNPRICED,
  invitation: async (d, api) => answer(await api.fromItemOverview('Invitation', d.name), 'item:Invitation') ?? UNPRICED,
  unique: async (d, api) => {
    // Unidentified: the descriptor name is our own label, not a poe.ninja name —
    // querying with it can only miss. Honestly unpriced (null), never 0.
    if (d.unidentified) return UNPRICED
    const type = ninjaTypeFor({ category: d.category })
    return type ? (answer(await api.fromItemOverview(type, d.name, d.baseType, d.links, d.mods), `item:${type}`) ?? UNPRICED) : UNPRICED
  }
}
