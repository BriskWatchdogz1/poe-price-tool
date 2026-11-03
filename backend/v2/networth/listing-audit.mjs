// backend/v2/networth/listing-audit.mjs
// "Listed below market": items the player has put up for sale in a stash tab
// at a price note under this tool's own market value. The decision it serves:
// does this item need a new price? It sends no request: the note arrives with
// the stash answer the sync reads anyway (GGG's item field `note`), valueTab()
// keeps it in the per-tab store next to the market value, and auditListings()
// compares the two when a snapshot is built (server.mjs, networthSnapshot).
//
// THE RULE IS THE WHISPER VERDICT'S: an item is listed exactly when
// verdictFor() in whisper-price.mjs would answer 'below' for the same two
// prices, with the same POE_WHISPER_LOW_RATIO, so a buyer's whisper and this
// block cannot disagree. BOTH SIDES ARE UNROUNDED: the kept market value is the
// valuator's `each` (what valueEach() gives a whisper), not `chaosEach`, which
// is rounded to 0.1 c for display (a Chaos Shard at 0.05 c would be stored as
// 0.1 c and a note of 1/20 chaos read as half the market).
//
// Not compared, as for a whisper (falsely priced is worse than unpriced), and
// counted by reason so a missing row is never read as a fair price: a market
// price with an `uncertain` marker ('uncertain-price'), a note in divine while
// the Chaos:Divine rate is the fallback or stale ('rate-unknown'), a note in
// any currency other than chaos and divine ('unknown-currency'). An item
// without a market value is not kept at all (listingOf): nothing to be below.
// ONLY PREMIUM TABS: a normal tab cannot be put up for sale, so a noted item in
// one is not kept. A NOTE ON A STACK IS READ AS A PRICE PER UNIT, the dearest
// reading (per unit or per stack is the open question of a whisper's
// 'stack-unknown'): a stack below only under the per-stack reading is not
// listed.
//
// `note` is the item's own price field; the trade API's item JSON has the same
// field (the vendored renderer's FetchResult, renderer/src/web/price-check/
// trade/pathofexile-trade.ts). A tab whose NAME is a price note ('~price 1
// chaos') prices every item in it that has none of its own (premium tabs only).
// No stash response recorded in this repository carries a price note, so
// neither reading has been seen in a real stash answer (README, "Known
// issues"). The snapshot carries at most BELOW_MAX rows, the biggest losses,
// and says how many more there are (`more`): every snapshot goes over the
// WebSocket.
import { verdictFor } from '../whisper-price.mjs'
import { roundExchange } from '../ninja.mjs'

export const AUDIT_SKIP_REASONS = ['rate-unknown', 'uncertain-price', 'unknown-currency']
export const BELOW_MAX = 100

// '~price <n> <unit>' or '~b/o <n> <unit>'; <n> a whole or decimal number or a
// fraction of two ('1/20'). Anything else is no price note. A note longer than
// this is no price note either, and is never stored.
const MAX_NOTE = 80
const NOTE = /^~(?:price|b\/o) (\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))? ([a-z][a-z-]*)$/

export function parsePriceNote (note) {
  if (typeof note !== 'string') return null
  const s = note.trim()
  if (!s || s.length > MAX_NOTE) return null
  const m = NOTE.exec(s)
  if (!m) return null
  const num = Number(m[1])
  const den = m[2] == null ? 1 : Number(m[2])
  if (!(den > 0)) return null
  const amount = num / den
  if (!(Number.isFinite(amount) && amount > 0)) return null
  return { amount, unit: m[3] }
}

const pos = v => (Number.isInteger(v) && v >= 0 ? v : null)

// One stored listing for a valued stash entry, or null when there is nothing
// to keep: a normal tab, no price note on the item or its tab, or no market
// value above 0. `ggg` is the raw stash item, `desc`/`value` what normalize and
// the valuator made of it; `value.each` is the unrounded price per unit
// (valuator.mjs value()), stored as the listing's `chaosEach`. x/y are GGG's
// 0-based cell; `fromTab` says the price is the tab's name.
export function listingOf (ggg, desc, value, tab) {
  if (tab?.type === 'NormalStash') return null
  const each = value?.each
  if (!(typeof each === 'number' && Number.isFinite(each) && each > 0)) return null
  let note = null
  let fromTab = false
  if (parsePriceNote(ggg?.note)) note = String(ggg.note).trim()
  else if (parsePriceNote(tab?.name)) { note = String(tab.name).trim(); fromTab = true }
  if (!note) return null
  const qty = Number(desc?.stack)
  return {
    name: desc.name,
    kind: desc.kind,
    qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
    x: pos(ggg?.x),
    y: pos(ggg?.y),
    note,
    fromTab,
    chaosEach: each,
    uncertain: value.uncertain ?? null
  }
}

// Stored tabs -> { rows, more, notCompared }. rows: one per listing below the
// market, descending by the chaos lost (market minus listed, both for the
// whole stack under the per-unit reading), at most `max`; more: how many rows
// below the market were left out by that cap. notCompared: { reason: count },
// only reasons that occurred. A tab stored before listings were kept has no
// `listed` key and contributes nothing until the sync reads it again.
export function auditListings (tabs, { chaosPerDivine, divineRateKnown, lowRatio, highRatio, max = BELOW_MAX }) {
  const rows = []
  const notCompared = {}
  const skip = r => { notCompared[r] = (notCompared[r] || 0) + 1 }
  for (const tab of (tabs || [])) {
    for (const l of (Array.isArray(tab?.listed) ? tab.listed : [])) {
      const p = parsePriceNote(l?.note)
      if (!p) continue
      if (l.uncertain) { skip('uncertain-price'); continue }
      let perUnit
      if (p.unit === 'chaos') perUnit = 1
      else if (p.unit === 'divine') {
        if (!divineRateKnown || !(Number(chaosPerDivine) > 0)) { skip('rate-unknown'); continue }
        perUnit = Number(chaosPerDivine)
      } else { skip('unknown-currency'); continue }
      const qty = Number(l.qty) > 0 ? Number(l.qty) : 1
      const listedEach = p.amount * perUnit
      const marketEach = Number(l.chaosEach)
      // A market of 0 or none gives no verdict (verdictFor), so no row.
      const v = verdictFor(listedEach * qty, marketEach * qty, { lowRatio, highRatio })
      if (v.verdict !== 'below') continue
      rows.push({
        name: l.name,
        kind: l.kind,
        tab: tab.name,
        tabIndex: tab.index,
        // The trade site's left/top, 1-based, as a buyer's whisper names them.
        left: l.x == null ? null : l.x + 1,
        top: l.y == null ? null : l.y + 1,
        qty,
        note: l.note,
        fromTab: l.fromTab === true,
        amount: p.amount,
        unit: p.unit,
        listedChaosEach: roundExchange(listedEach),
        marketChaosEach: roundExchange(marketEach),
        listedChaos: roundExchange(listedEach * qty),
        marketChaos: roundExchange(marketEach * qty),
        lossChaos: roundExchange((marketEach - listedEach) * qty),
        _loss: (marketEach - listedEach) * qty,
        ratio: v.ratio,
        pct: v.pct
      })
    }
  }
  rows.sort((a, b) => b._loss - a._loss)
  const cap = Number.isInteger(max) && max >= 0 ? max : BELOW_MAX
  const shown = rows.slice(0, cap)
  for (const r of shown) delete r._loss
  return { rows: shown, more: rows.length - shown.length, notCompared }
}

// The stack size the last sync saw at a buyer whisper's tab and cell, or null.
// A single whisper for a stackable item mostly names no stack size
// (whisper-price.mjs, 'stack-unknown'); the stored listing at that cell does. left/top are the
// whisper's 1-based cell, x/y the stored 0-based one; ref is the item's
// reference name, which must match the stored row. Tabs of the same name that
// disagree give null, not a guess. Reads the store only, never the stash API.
export function stackSizeAt (tabs, where) {
  const { tab, left, top, ref } = where || {}
  if (typeof tab !== 'string' || typeof ref !== 'string' || !Number.isInteger(left) || !Number.isInteger(top)) return null
  const seen = new Set()
  for (const t of (Array.isArray(tabs) ? tabs : [])) {
    if (!t || t.name !== tab || !Array.isArray(t.listed)) continue
    for (const l of t.listed) {
      if (!l || l.name !== ref || l.x !== left - 1 || l.y !== top - 1) continue
      const qty = Number(l.qty)
      if (Number.isInteger(qty) && qty > 0) seen.add(qty)
    }
  }
  return seen.size === 1 ? [...seen][0] : null
}

// stackSizeAt over a networth store, for the whisper pricer's `stackAt`
// (server.mjs): the whisper's user, and only while the store holds the
// whisper's league (a store not yet given one is read). Never throws.
export function createStackLookup (store) {
  return ({ user, league, ...where } = {}) => {
    try {
      if (!store || typeof user !== 'string' || !user) return null
      const held = store.getMeta?.(user)?.league
      if (held && held !== league) return null
      return stackSizeAt(store.tabList(user), where)
    } catch { return null }
  }
}

// Is a buyer whisper's tab a quad tab (24x24 cells instead of 12x12)? The
// stored tab type of the last sync (scan.mjs keeps the stash API's `type`),
// by the whisper's tab name: true for QuadStash, false for any other type,
// null when no stored tab has that name, when one of them was written before
// the type was kept, or when tabs of that name disagree. The daemon's stash cell
// frame (daemon/ppt_stash_grid.py) falls back to SlimTrade's rule for
// null. Reads the store only, never the stash API.
export function quadTabAt (tabs, tab) {
  if (typeof tab !== 'string') return null
  const seen = new Set()
  for (const t of (Array.isArray(tabs) ? tabs : [])) {
    if (!t || t.name !== tab) continue
    if (typeof t.type !== 'string' || !t.type) return null
    seen.add(t.type === 'QuadStash')
  }
  return seen.size === 1 ? [...seen][0] : null
}

// quadTabAt over a networth store, for the whisper handler's `quadOf`
// (server.mjs): the whisper's user, and only while the store holds the
// whisper's league (a store not yet given one is read). Never throws.
export function createQuadLookup (store) {
  return ({ user, league, tab } = {}) => {
    try {
      if (!store || typeof user !== 'string' || !user) return null
      const held = store.getMeta?.(user)?.league
      if (held && held !== league) return null
      return quadTabAt(store.tabList(user), tab)
    } catch { return null }
  }
}
