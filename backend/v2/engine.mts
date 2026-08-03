// Server-side "engine": item text -> ParsedItem -> filter -> real trade prices.
// Bundled by build.mjs with esbuild into engine.bundle.mjs (alias resolution
// + fetch FS adapter + shims). NO APT source code is changed here; all
// Node adaptations live in the shims and the fetch adapter.

import { parseClipboard, type ParsedItem } from '@/parser'
import { init as initData } from '@/assets/data'
import { createPresets } from '@/web/price-check/filters/create-presets'
import {
  createTradeRequest,
  requestTradeResultList,
  requestResults,
  type PricingResult
} from '@/web/price-check/trade/pathofexile-trade'
// Bulk exchange (/api/trade/exchange): the correct way for currencies. The stat
// search (searchPreset) finds nothing for currency -> 0c. execBulkSearch uses its
// own EXCHANGE rate limit policy and waits internally via RateLimiter.
import { execBulkSearch } from '@/web/price-check/trade/pathofexile-bulk'
import { tradeTag } from '@/web/price-check/trade/common'
import type { ItemFilters, StatFilter, FilterPreset } from '@/web/price-check/filters/interfaces'
import { FilterTag } from '@/web/price-check/filters/interfaces'
import { ModifierType } from '@/parser/modifiers'

// Re-export of the server-side rate limit sets (header-driven via
// adjustRateLimits). The M2 server reads the queue-status policies from these.
export { RATE_LIMIT_RULES } from '@/web/price-check/trade/common'

// Re-export of APT's OWN routing decision (the desktop overlay uses this in
// CheckedItem.vue to pick TradeListing.vue vs TradeBulk.vue): bulk only when
// no stat filter is active AND the item has an exchange tradeTag. The server
// used to approximate this with a much coarser `category === 'Currency'`
// check, which also catches Corpses/Incubators (same clipboard `Rarity:
// Currency` line, but no exchange tradeTag) -> sends them into bulkPriceItem,
// which hard-returns {total:0} for them. Use THIS instead of re-deriving it.
export { apiToSatisfySearch, tradeTag } from '@/web/price-check/trade/common'

// --- fetch FS adapter: serves the relative data/ URLs from the filesystem ---
// assets/data loads via `fetch(BASE_URL + 'data/...')`. BASE_URL is mapped by
// esbuild's `define` onto globalThis.__aptEnv.BASE_URL; we set it at runtime to
// the public/ URL (file://). The adapter intercepts file:// and reads from disk;
// real http(s) URLs (trade) go to the native fetch.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

function installFetchFs (): void {
  const g = globalThis as unknown as { fetch: typeof fetch, __aptFetchPatched?: boolean }
  if (g.__aptFetchPatched) return
  const nativeFetch = g.fetch.bind(globalThis)
  g.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    if (url.startsWith('file://')) {
      const buf = await readFile(fileURLToPath(url))
      return new Response(buf, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    return nativeFetch(input, init)
  }) as typeof fetch
  g.__aptFetchPatched = true
}

// --- Fractured-mod fix (tool layer only; no renderer/src changes) ----------
// APT's `initUiModFilters` (renderer/src/web/price-check/filters/create-stat-filters.ts,
// used to build the "pseudo" preset) intentionally RE-TYPES a Fractured mod to
// Explicit whenever the same stat also has an explicit trade-stat variant --
// a desktop-overlay assumption ("this fractured item might be a base you want
// to craft on top of, so also let me search it as a plain explicit stat").
// The v2 tool has no preset picker and always runs the pseudo preset (see
// createPresets: `active: pseudoPreset.id` whenever `hasCraftingValue`, which
// is true for any fractured item) -> on an item like the Abyss Jewel from the
// bug report ("+# to maximum Energy Shield" as a Fractured Prefix), this
// silently searched the FRACTURED mod as a normal EXPLICIT stat, matching
// non-fractured items too (far too low a price; the mod survives reforging
// and should command a premium).
//
// APT's remap (create-stat-filters.ts ~line 152) only overwrites the
// *aggregated* `StatCalculated.type`; the underlying per-source
// `StatSource.modifier.info.type` (the parser's own verdict from the
// "Fractured ... Modifier" line, advanced-mod-desc.ts) is left untouched.
// That is the reliable signal to detect + undo the remap here: if EVERY
// source of a stat filter is actually a fractured mod on this item, restore
// the fractured trade-stat id(s) and tag, so the trade query searches
// `fractured.stat_...` instead of `explicit.stat_...`.
//
// Filters built by the "exact"/"base_item" presets (createExactStatFilters)
// already keep `tag === Fractured` correctly (APT never remaps there) --
// `filter.tag === FilterTag.Fractured` is skipped below as a no-op.
//
// --- Duplicate fix (dedupe) ------------------------------------------------
// `initUiModFilters` (create-stat-filters.ts ~141-172) does more than the
// single-field type remap described above: for a fractured mod that also has
// an explicit variant, it (1) remaps `type` to Explicit BEFORE `filterPseudo`
// runs, so `filterPseudo` folds it into a "+# total ..." PSEUDO-aggregated
// stat (this is the one restored to Fractured above -> visible/selectable in
// the mod picker), and (2) unconditionally re-appends the item's ORIGINAL,
// untouched Fractured-typed stat from `item.statsByType` afterwards (the
// `ctx.statsByType = ctx.statsByType.filter(mod => mod.type !== Fractured);
// ctx.statsByType.push(...item.statsByType.filter(mod => mod.type ===
// Fractured))` block) -- that pushes the RAW per-mod stat back in even
// though its remapped/aggregated sibling already covers it. `finalFilterTweaks`
// then marks that raw copy `hidden: 'filters.hide_for_crafting'` (never shown,
// never selectable), but it still ends up in `preset.stats` with the SAME
// restored `tradeId` as the pseudo one -> two StatFilter objects for the
// same underlying fractured mod. `createTradeRequest` (pathofexile-trade.ts)
// sends every non-internal stat regardless of `disabled`, so BOTH land in
// the trade query: the real one (user-selectable, correct MIN once chosen)
// plus a permanently-disabled ghost with a stale/default MIN that can never
// be picked -> the trade site shows the same "Fractured +#..." stat twice.
// Verified empirically (backend/v2/engine.mts smoke test, see PR): before
// this dedup, the captured request body for a fractured Abyss Jewel contains
// `fractured.stat_3489782002` twice (`disabled:false` + `disabled:true`).
//
// Fix: after restoring tag/tradeId above, collapse duplicate tradeIds down to
// ONE filter per fractured stat -- keep the visible one if there is a
// hidden/visible pair (that's the one the user can actually select and that
// carries a correct MIN once chosen), otherwise keep the first. Only acts on
// EXACT tradeId collisions, so unrelated/solitary hidden fractured filters
// (e.g. on unique items, hidden for other reasons) are left untouched.
function restoreFracturedStatFilters (stats: StatFilter[]): StatFilter[] {
  for (const filter of stats) {
    if (filter.tag === FilterTag.Fractured) continue
    if (!filter.sources.length) continue
    if (!filter.sources.every(s => s.modifier.info.type === ModifierType.Fractured)) continue
    const fracIds = filter.sources[0].stat.stat.trade.ids[ModifierType.Fractured]
    if (!fracIds || !fracIds.length) continue
    filter.tradeId = fracIds
    filter.tag = FilterTag.Fractured
  }

  const firstIndexByTradeId = new Map<string, number>()
  const deduped: StatFilter[] = []
  for (const filter of stats) {
    if (filter.tag !== FilterTag.Fractured) { deduped.push(filter); continue }
    const key = filter.tradeId.join(',')
    const keptIdx = firstIndexByTradeId.get(key)
    if (keptIdx === undefined) {
      firstIndexByTradeId.set(key, deduped.length)
      deduped.push(filter)
    } else if (deduped[keptIdx].hidden && !filter.hidden) {
      // the previously kept one was the hidden ghost -> this one is the real,
      // user-facing stat -> swap it in.
      deduped[keptIdx] = filter
    }
    // else: drop this filter -- a redundant duplicate of the one already kept.
  }
  return deduped
}

let _ready: Promise<void> | null = null

export interface EngineOptions {
  publicDataDir?: string // base URL (file://) for the data/ assets; default: renderer/public
  lang?: string
}

/** Loads item/stat DB + client_strings server-side (idempotent). */
export function ready (opts: EngineOptions = {}): Promise<void> {
  if (_ready) return _ready
  installFetchFs()
  const publicUrl = opts.publicDataDir ??
    new URL('../../renderer/public/', import.meta.url).href
  // read by assets/data via `import.meta.env.BASE_URL` (define -> globalThis.__aptEnv)
  ;(globalThis as any).__aptEnv = { BASE_URL: publicUrl.endsWith('/') ? publicUrl : publicUrl + '/' }
  _ready = initData(opts.lang ?? 'en')
  return _ready
}

/**
 * Re-runs the data load against a (usually new) public data dir, at runtime.
 * Used by the background data refresher after it has adopted a fresh, already
 * VALIDATED snapshot — initData reassigns the module-level lookup closures in
 * assets/data, so every later parse sees the new items/stats without a process
 * restart. The caller must pass a NEW directory per snapshot (versioned dirs):
 * client_strings.js is loaded via dynamic import(), which Node caches by URL —
 * rewriting the same path in place would keep serving the old strings.
 *
 * On failure the returned promise rejects AND the engine stays unusable (the
 * cached _ready is the rejected promise) — the caller is expected to reload the
 * previous, known-good dir again (its files are untouched on disk).
 */
export function reload (opts: EngineOptions = {}): Promise<void> {
  _ready = null
  return ready(opts)
}

export interface ParseResult {
  item: ParsedItem
  presets: ReturnType<typeof createPresets>
}

/** T1 + T2: item text -> ParsedItem + filter presets (no network). */
export async function parseItem (
  clipboard: string,
  opts: EngineOptions & { league?: string, searchStatRange?: number } = {}
): Promise<ParseResult> {
  await ready(opts)
  const parsed = parseClipboard(clipboard)
  if (parsed.isErr()) {
    throw new Error(`parse failed: ${parsed.error}`)
  }
  const item = parsed.value
  const presets = createPresets(item, {
    league: opts.league ?? 'Standard',
    currency: undefined,
    collapseListings: 'api',
    activateStockFilter: false,
    searchStatRange: opts.searchStatRange ?? 10,
    useEn: true
  })
  // Fix up ALL presets (not just the active one) -- cheap, and keeps every
  // preset internally consistent in case a future preset picker uses another.
  for (const preset of presets.presets) preset.stats = restoreFracturedStatFilters(preset.stats)
  return { item, presets }
}

export interface PriceResult {
  total: number
  inexact: boolean
  queryId: string
  filters: ItemFilters
  stats: StatFilter[]
  listings: PricingResult[]
}

/**
 * Trade search (search + fetch) for an already-built filter preset.
 * The server uses this directly: for the initial pricing (active preset unchanged)
 * and for `search` requeries (server mutates stat.disabled / stat.roll.min beforehand).
 * Runs through APT's RateLimiter (RATE_LIMIT_RULES), so the caller serializes.
 */
export async function searchPreset (
  preset: FilterPreset,
  opts: EngineOptions & { league?: string, maxListings?: number } = {}
): Promise<PriceResult> {
  await ready(opts)
  const league = opts.league ?? 'Standard'

  const body = createTradeRequest(preset.filters, preset.stats) as any
  // Belt-and-suspenders: when the user is actively matching on a fractured
  // mod (see restoreFracturedStatFilters above), also require the listing to
  // literally be a fractured item (misc_filters.fractured_item). Redundant in
  // theory -- only fractured items carry a `fractured.stat_*` value at all --
  // but cheap insurance against trade-API edge cases, and mirrors what APT's
  // own `filters.fractured` misc filter does for the (unsupported here)
  // exclude-fractured case (pathofexile-trade.ts).
  if (preset.stats.some(s => s.tag === FilterTag.Fractured && !s.disabled)) {
    const f = body.query.filters
    f.misc_filters = f.misc_filters || {}
    f.misc_filters.filters = f.misc_filters.filters || {}
    f.misc_filters.filters.fractured_item = { option: 'true' }
  }
  const search = await requestTradeResultList(body, league)

  const max = opts.maxListings ?? 10
  const ids = search.result.slice(0, max)
  const listings = ids.length
    ? await requestResults(search.id, ids, { accountName: '' })
    : []

  return {
    total: search.total,
    inexact: Boolean(search.inexact),
    queryId: search.id,
    filters: preset.filters,
    stats: preset.stats,
    listings
  }
}

/**
 * Bulk pricing for currencies via the trade exchange (Faustus route).
 * Gems/rares/uniques run through the stat search (searchPreset); but in PoE,
 * currency is traded via /api/trade/exchange -> the stat search finds nothing
 * for it (0c/0 listings). execBulkSearch reads `filters.trade.league` and uses
 * its own EXCHANGE rate limit policy (waits internally via RateLimiter).
 *
 * The result is mapped onto the SAME listing schema as searchPreset, so
 * `server.mjs → toPriceResult` keeps working unchanged:
 *   { priceAmount, priceCurrency, ign, accountName, relativeDate, stock }
 */
// Median of a non-empty number list (robust middle — one troll listing in a
// slice can't move it, unlike the mean).
function medianOf (xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// Typical price per single item in a slice, expressed in CHAOS. `null` when the
// slice is divine-denominated and no C:D ratio was passed (nothing to compare
// against then) or when the slice's currency isn't chaos/divine.
function sliceChaosPerItem (slice: { haveTag: string, listed: Array<{ exchangeAmount: number, itemAmount: number }> }, cdRatio?: number): number | null {
  if (!slice.listed.length) return null
  const per = slice.listed.map(p => p.exchangeAmount / Math.max(1, p.itemAmount))
  const med = medianOf(per)
  if (!isFinite(med) || med <= 0) return null
  if (slice.haveTag === 'chaos') return med
  if (slice.haveTag === 'divine') {
    return (typeof cdRatio === 'number' && cdRatio > 0) ? med * cdRatio : null
  }
  return null
}

// A side this thin is a troll corner, not a market: it may only WIN on price,
// never lose to one — see the eligibility step below.
const BULK_THIN_SLICE = 3

// Two sides this far apart (in chaos per item) are no longer quoting the same
// market — one of them is a hope price, not a bid/ask spread. See the
// "extreme split" step in chooseBulkSlice for the measurements behind the 8.
const BULK_EXTREME_SPLIT = 8

// How well-attested a slice is. `total` is the exchange's own hit count for
// that side (execBulkSearch, uncapped), `listed.length` only the fetched page
// (capped at SHOW_RESULTS = 20) — so prefer `total` and keep the page size as
// the fallback for callers/slices that carry no total. On the sample measured
// for BULK_EXTREME_SPLIT both measures agreed on every item.
function sliceEvidence (slice: { total?: number, listed: unknown[] }): number {
  return (typeof slice.total === 'number' && slice.total > 0) ? slice.total : slice.listed.length
}

/**
 * Picks the "have" slice the card shows. The question this answers is the
 * SELLER's: which side pays me more for this item? So both sides are put on the
 * same chaos scale (median price per item, divine bridged through `cdRatio`)
 * and the better-paying one wins — the display currency then falls out of that
 * slice (chaos slice -> "c", divine slice -> "div", see toPriceResult).
 *
 * This replaces a purely listing-COUNT based pick, which was price-blind: for
 * Valdo's Puzzle Box / Templar Astrolabe the divine side simply had more
 * offers and won, even where the chaos side paid better.
 *
 * Guard rails:
 * - Empty/null slices are out (execBulkSearch returns null for a side loaded
 *   on-demand, see pathofexile-bulk.ts).
 * - As long as ONE side has at least BULK_THIN_SLICE listings, only such liquid
 *   sides compete. Comparing medians already kills single outliers inside a
 *   slice, but a whole slice can BE the troll corner: two offers at 6x the real
 *   rate are not a better market, they're bait, and on price alone they would
 *   beat a twelve-offer side. This keeps the old "don't show the 9-listing
 *   troll corner" protection. Only when every side is thin do they all compete.
 * - No comparable chaos value on either side (divine-only without a cdRatio)
 *   -> fall back to the old behaviour: most listings wins.
 * - EXTREME SPLIT: when the surviving sides are more than BULK_EXTREME_SPLIT
 *   apart, the better-ATTESTED side wins instead of the better-paying one (see
 *   below). Paying-more is still the rule everywhere else.
 */
export function chooseBulkSlice<T extends { haveTag: string, total?: number, queryId?: string | null, listed: Array<{ exchangeAmount: number, itemAmount: number }> }> (
  byHave: Array<T | null | undefined>,
  cdRatio?: number
): T | null {
  const nonNull = byHave.filter((b): b is T => b != null && b.listed.length > 0)
  if (!nonNull.length) return null
  const byCount = (best: T | null, cur: T) => (!best || cur.listed.length > best.listed.length) ? cur : best

  const scored = nonNull
    .map(s => ({ s, chaos: sliceChaosPerItem(s, cdRatio) }))
    .filter((x): x is { s: T, chaos: number } => x.chaos != null)
  if (scored.length < 2) return nonNull.reduce<T | null>(byCount, null)

  const liquid = scored.filter(x => x.s.listed.length >= BULK_THIN_SLICE)
  const field = liquid.length ? liquid : scored
  const richest = field.reduce((a, b) => (b.chaos > a.chaos ? b : a))

  // --- Extreme split: not a currency choice any more, an outlier ------------
  // The "who pays me more" comparison above assumes both sides quote the SAME
  // market, so their prices differ by a spread. BULK_THIN_SLICE catches the
  // case where the richer side is just thin — but a side can be liquid AND
  // fantasy: Allflame Ember of the Wildwood had 17 online offers at "1 divine
  // per ember" (Faustus: no completed trade at all; the in-game exchange book
  // fills 1 ember for 1 chaos and shows No Stock the other way) against 20
  // chaos offers with a 3.5c median. Nobody trades at those divine asks; they
  // just sit there, and on price alone they beat the real market 50:1.
  //
  // So above a factor this large the pick switches from "pays more" to "is
  // better attested". Measured live (Allflame, C:D 173.4 from Faustus; the
  // Faustus midpoint is the independent truth where it knows the item):
  //
  //   item                  chaos side        divine side      factor  truth
  //   Wildwood Ember      3.5c (t72)   173.4c (t17)     49.5   chaos (~1c)
  //   Toads Ember         2.0c (t81)   173.4c (t14)     86.7   chaos (~1c)
  //   Orb of Annulment   13.0c (t16)   520.1c  (t1)     40.0   chaos (12.9c)
  //   Sacred Orb         15.0c  (t4)   173.4c  (t1)     11.6   chaos (35.6c)
  //   Ancient Orb         9.0c (t29)    93.9c  (t6)     10.4   chaos (9.2c)
  //   Gilded Ember       18.0c (t35)   173.4c  (t7)      9.6   chaos (23.9c)
  //   --- below: both sides describe the same market, revenue logic stands ---
  //   Ethereal Ember     30.0c (t11)   173.4c (t51)      5.8   divine (162.7c)
  //   Reflecting Mist   155.0c  (t4)   346.7c (t12)      2.2   (revenue pick)
  //
  // Every row above 9.6 is a hope price and every row at/below 5.8 is a real
  // spread, so the boundary sits in that gap; 8 is the round value inside it.
  // In all six outlier rows the better-attested side is the correct one, and
  // in the two normal rows evidence and revenue agree anyway — so the rule
  // changes nothing there even if the factor were mis-set.
  const poorest = field.reduce((a, b) => (b.chaos < a.chaos ? b : a))
  if (poorest.chaos > 0 && richest.chaos / poorest.chaos >= BULK_EXTREME_SPLIT) {
    const best = field.reduce((a, b) => (sliceEvidence(b.s) > sliceEvidence(a.s) ? b : a))
    // Only when the evidence is UNAMBIGUOUS; a tie says nothing, and then the
    // revenue pick below stays in charge rather than flipping on listing noise.
    if (field.filter(x => sliceEvidence(x.s) === sliceEvidence(best.s)).length === 1) {
      return best.s
    }
  }

  return richest.s
}

export async function bulkPriceItem (
  item: ParsedItem,
  filters: ItemFilters,
  opts: { league: string, have?: string[], maxListings?: number, cdRatio?: number }
): Promise<{ total: number, listings: PricingResult[], queryId: string | null }> {
  await ready()
  const have = opts.have ?? ['chaos', 'divine']
  const maxListings = opts.maxListings ?? 10

  // No trade tag -> no bulk possible (never throw, empty result). Caller
  // (server.mjs) should not even route here in that case (see
  // apiToSatisfySearch), but stay defensive if it's ever called directly.
  if (tradeTag(item) == null) {
    return { total: 0, listings: [], queryId: null }
  }

  // execBulkSearch reads the league from filters.trade.league.
  filters.trade.league = opts.league

  const byHave = await execBulkSearch(item, filters, have, { accountName: '' })

  const chosen = chooseBulkSlice(byHave, opts.cdRatio)

  if (!chosen) return { total: 0, listings: [], queryId: null }

  // If the liquid side is divine-denominated and the caller passed a C:D
  // ratio (server.mjs: cdMsgFor(league).chaosPerDivine, live poe.ninja or env
  // fallback), normalize to chaos so the card shows ONE consistent currency.
  // Without this, toPriceResult (server.mjs) picks the cheapest listing's
  // currency and filters the rest to match it -> a divine-denominated slice
  // would silently lose all but the first listing from its own price range.
  const ratio = opts.cdRatio
  const normalizeToChaos = chosen.haveTag === 'divine' && typeof ratio === 'number' && ratio > 0

  // PricingResult -> shared listing schema (like searchPreset listings).
  // Price per item = exchangeAmount / itemAmount (e.g. 60c for 5 orbs -> 12c/orb).
  const listings = chosen.listed.slice(0, maxListings).map(p => {
    const priceAmount = p.exchangeAmount / Math.max(1, p.itemAmount)
    return {
      priceAmount: normalizeToChaos ? priceAmount * ratio! : priceAmount,
      priceCurrency: normalizeToChaos ? 'chaos' : chosen.haveTag,
      ign: p.ign,
      accountName: p.accountName,
      relativeDate: p.relativeDate,
      stock: p.stock
    }
  }) as unknown as PricingResult[]

  // chosen.queryId is the exchange search id (execBulkSearch -> query.id, see
  // pathofexile-bulk.ts) -> https://www.pathofexile.com/trade/exchange/<league>/<id>
  return { total: chosen.total ?? 0, listings, queryId: chosen.queryId ?? null }
}

/**
 * Raw trade search (search + fetch) for an externally built query body,
 * without a parsed item/preset. A caller builds the body
 * itself (e.g. enchant stat filter) and has no ParsedItem for searchPreset.
 * Uses the same APT functions as searchPreset (requestTradeResultList /
 * requestResults) -> runs through the same RateLimiter, same listing schema.
 */
export async function searchRaw (
  body: object,
  league: string,
  opts: { maxFetch?: number } = {}
): Promise<{ total: number, queryId: string, listings: PricingResult[] }> {
  await ready()

  const search = await requestTradeResultList(body as any, league)

  const max = Math.min(opts.maxFetch ?? 10, 10)
  const ids = search.result.slice(0, max)
  const listings = ids.length
    ? await requestResults(search.id, ids, { accountName: '' })
    : []

  return {
    total: search.total,
    queryId: search.id,
    listings
  }
}

/** Get the active preset from a ParseResult (fallback: first preset). */
export function activePreset (presets: ParseResult['presets']): FilterPreset {
  return presets.presets.find(p => p.id === presets.active) ?? presets.presets[0]
}

/** T3: filter -> real trade search (search + fetch) against pathofexile.com. */
export async function priceCheck (
  clipboard: string,
  opts: EngineOptions & { league?: string, maxListings?: number, searchStatRange?: number } = {}
): Promise<{ item: ParsedItem, price: PriceResult }> {
  const league = opts.league ?? 'Standard'
  const { item, presets } = await parseItem(clipboard, { ...opts, league })
  const price = await searchPreset(activePreset(presets), { ...opts, league })
  return { item, price }
}
