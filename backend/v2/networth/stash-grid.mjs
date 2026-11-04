// backend/v2/networth/stash-grid.mjs
// The answer of GET /daemon/stash-grid (frontend/PROTOCOL.md): the daemon's
// value key draws, over the open stash tab, what each item there is worth, so
// the player can decide what to sell, keep or move to a sale tab. It reads the
// per-tab store only: the cells come from the read the stash sync makes anyway
// (scan.mjs, `cells`, each with u: true when the valuation marks its price
// uncertain, as the Net Worth page shows), and nothing here sends a request
// to GGG, poe.ninja or Faustus. The daemon cannot tell which tab is open in the game (the stash API
// does not say), so the answer without a tab lists the stored tabs and the
// daemon steps through them.
import { round1 } from '../ninja.mjs'

export const STASH_GRID_VERSION = 1

// The tab types whose items sit on a grid of cells: 12x12 (normal, premium)
// or 24x24 (quad). Every other type lays its items out its own way.
const GRID_TYPES = new Set(['NormalStash', 'PremiumStash', 'QuadStash'])
export const gridTab = type => GRID_TYPES.has(type)

// '?tab=<index>' -> the index, or null when it is not a whole number from 0 up.
export function tabIndexOf (raw) {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null
  return Number(raw)
}

const isPos = v => Number.isInteger(v) && v >= 0
const isSize = v => Number.isInteger(v) && v > 0
const goodCell = c => c && isPos(c.x) && isPos(c.y) && isSize(c.w) && isSize(c.h) &&
  typeof c.c === 'number' && Number.isFinite(c.c) && typeof c.n === 'string'
// u (the price is uncertain, scan.mjs cellOf) goes out only as true: any
// other value costs the cell its u, not the cell.
const outCell = ({ x, y, w, h, c, n, u }) => (u === true ? { x, y, w, h, c, n, u } : { x, y, w, h, c, n })

const listEntry = t => ({ index: t.index, name: t.name ?? null, type: t.type ?? null, grid: gridTab(t.type) })

// -> { status, body }. index null: the tab list; a number: that tab as well.
// A tab stored before cells were kept has `cells: null` and the reason; it
// gets them at its next sync read. One stored before the tab type was kept
// has `type: null` and so `grid: false` until that read.
export function stashGridAnswer (store, user, index) {
  const tabs = store.tabList(user).map(listEntry)
  if (index == null) return { status: 200, body: { v: STASH_GRID_VERSION, tabs } }
  const t = store.getTab(user, index)
  if (!t) return { status: 404, body: { error: 'no such tab' } }
  const type = t.type ?? null
  const tab = { index: t.index, name: t.name ?? null, type, quad: type === 'QuadStash', grid: gridTab(type), syncedAt: t.syncedAt ?? null }
  const cdRatio = Number(store.getMeta(user)?.cdRatio)
  const chaosPerDivine = Number.isFinite(cdRatio) && cdRatio > 0 ? cdRatio : null
  if (!Array.isArray(t.cells)) {
    return { status: 200, body: { v: STASH_GRID_VERSION, tabs, tab, cells: null, reason: 'not-read-since-update', totalChaos: null, chaosPerDivine } }
  }
  const cells = t.cells.filter(goodCell).map(outCell)
  const totalChaos = round1(cells.reduce((sum, c) => sum + c.c, 0))
  return { status: 200, body: { v: STASH_GRID_VERSION, tabs, tab, cells, totalChaos, chaosPerDivine } }
}
