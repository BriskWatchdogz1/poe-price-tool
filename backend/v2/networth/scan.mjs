// Incremental per-tab scan core (extracted from server.mjs so it's unit-testable
// with a mocked stash-client — NO GGG requests in tests). Every tab is valued
// and PERSISTED on its own the moment it's done (store.setTab), so an abort in
// the tail never loses the tabs already fetched. What else a stored tab
// carries (price notes, cells for the daemon's value grid) comes out of the
// same read: nothing here fetches more for it. All I/O is injected:
//   client   — stash-client ({ listTabs(), fetchTab(index) }), UNCHANGED
//   store    — per-tab networth store (setTab/isFresh/pruneTabs/setMeta/tabList)
//   valuator — { value(desc) } (poe.ninja-backed, cached)
//   normalize— ggg -> descriptor (normalizeItem bound with the items index)
import { aggregate } from './aggregate.mjs'
import { listingOf } from './listing-audit.mjs'
import { round1 } from '../ninja.mjs'
import { gridTab } from './stash-grid.mjs'

// The value grid's cells (GET /daemon/stash-grid, the daemon's value key): one
// per priced entry worth at least CELLS_MIN_CHAOS for the whole entry, the
// dearest CELLS_MAX of a tab. A cheaper entry is no sell-or-keep decision and
// only clutters the grid; 600 covers a full quad tab of 1x1 items with room to
// spare (24x24 = 576) and keeps a tab's share of the store file small.
export const CELLS_MIN_CHAOS = 1
export const CELLS_MAX = 600

const cellPos = v => (Number.isInteger(v) && v >= 0 ? v : null)
const cellSize = v => (Number.isInteger(v) && v > 0 ? v : 1)

// One cell for a valued entry, or null: no value, worth under CELLS_MIN_CHAOS,
// or no integer x/y from 0 up.
// x/y are GGG's 0-based cell, w/h the item's size in cells (1 when GGG gives
// none), c the entry's chaos total to 0.1, n its name. u: true when the
// valuation marked this entry's price uncertain (valuator.mjs UNCERTAIN), the
// mark the Net Worth page shows (its row, folding entries, is marked when any
// of them is); which marker it is stays on that page (the grid has no room for
// it), and an unmarked cell has no u at all, which keeps the store small.
function cellOf (ggg, desc, value) {
  const total = Number(value?.chaosTotal)
  if (!(Number.isFinite(total) && total >= CELLS_MIN_CHAOS)) return null
  const x = cellPos(ggg?.x)
  const y = cellPos(ggg?.y)
  if (x == null || y == null) return null
  const cell = { x, y, w: cellSize(ggg?.w), h: cellSize(ggg?.h), c: round1(total), n: desc.name }
  if (value.uncertain) cell.u = true
  return cell
}

// One GGG stash tab's raw items -> per-tab store object (grouped item rows,
// grouped unpriced list, entry counts). Item-level failures are skipped, exactly
// like the whole-scan behaviour before.
//
// `listed`: the price notes of the priced entries, one per stash entry with its
// cell (listing-audit.mjs, "Listed below market"). Kept from the items this
// read already holds; nothing is fetched for it.
//
// `cells`: where the priced entries lie, what each is worth and whether that
// price is uncertain, for the value grid (cellOf above). From the same items;
// nothing is fetched for it either.
// Only a tab whose items sit on cells (gridTab: normal, premium, quad) keeps
// them; any other type stores an empty list. The route marks such a tab
// grid=false and the daemon never draws it, and a folder tab's read merges its
// sub-tabs, so their x/y overlap.
//
// `type`: the stash API's tab type from the tab list (QuadStash, PremiumStash,
// ...; null when the list carried none), so a buyer whisper can say whether
// its tab is a quad tab (listing-audit.mjs quadTabAt).
export async function valueTab ({ items, tab, valuator, normalize, cdRatio, league, accountName }) {
  const onGrid = gridTab(tab.type)
  const entries = []
  const listed = []
  const cells = []
  for (const ggg of items) {
    try {
      const desc = normalize(ggg)
      const value = desc.kind === 'skip' ? null : await valuator.value(desc)
      entries.push({ desc, tabIndex: tab.index, tabName: tab.name, value })
      // Its own guard: a failure here must not book the entry a second time
      // as skipped below. The valuation above stands, only the note is lost.
      try {
        const l = desc.kind === 'skip' ? null : listingOf(ggg, desc, value, tab)
        if (l) listed.push(l)
      } catch { /* no listing for this entry */ }
      const cell = (!onGrid || desc.kind === 'skip') ? null : cellOf(ggg, desc, value)
      if (cell) cells.push(cell)
    } catch {
      entries.push({ desc: { kind: 'skip', reason: 'error', name: '?' }, tabIndex: tab.index, tabName: tab.name, value: null })
    }
  }
  // unpricedMax: Infinity — what comes out of here is WRITTEN TO THE STORE, not
  // drawn on a page, and the net-worth recorder reads the stored unpriced names
  // back as its proof that an item without a price is still in the stash. A cap
  // here would put that proof out of reach for exactly the thinly traded items
  // that need it, so the display cap stays where the display is (aggregate.mjs).
  const per = aggregate({ entries, cdRatio, league, accountName, unpricedMax: Infinity })
  // Diagnostics (POE_NETWORTH_DEBUG=1): ONLY here can "the tab came back empty"
  // be told apart from "every item was skipped". Deliberately sits in valueTab
  // and not in scanTabs — the background refresher calls valueTab directly, and
  // scanTabs does not run in production at all. Off by default.
  if (process.env.POE_NETWORTH_DEBUG === '1') {
    const c = per.counts || {}
    const reasons = {}
    for (const e of entries) if (e.desc?.kind === 'skip') reasons[e.desc.reason || '?'] = (reasons[e.desc.reason || '?'] || 0) + 1
    const why = Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`[networth:scan] tab "${tab.name}" (index=${tab.index} type=${tab.type ?? '?'}) ` +
      `raw=${items.length} priced=${c.priced ?? 0} unpriced=${c.unpriced ?? 0} skipped=${c.skipped ?? 0}${why ? ` [${why}]` : ''}`)
  }
  cells.sort((a, b) => b.c - a.c)
  return { index: tab.index, name: tab.name, type: tab.type ?? null, items: per.items, unpriced: per.unpriced, counts: per.counts, listed, cells: cells.slice(0, CELLS_MAX) }
}

// Sequential incremental scan. Fresh tabs (valued within ttlMs, unless `force`)
// are skipped and their stored data kept. auth/ratelimit propagate (caller
// aborts + broadcasts a partial snapshot from the store); a single tab's
// fetch failure (rejected/server/timeout) is skipped and the scan continues.
// Returns the live tab list (in-game order).
export async function scanTabs ({
  client, store, valuator, normalize,
  user, league, cdRatio, accountName,
  ttlMs, force = false, now = () => Date.now(), onProgress = () => {}
}) {
  const tabs = await client.listTabs()
  store.pruneTabs(user, tabs.map(t => t.index))
  store.setMeta(user, { accountName, league, cdRatio })

  let done = 0
  for (const tab of tabs) {
    done++
    if (!force && store.isFresh(user, tab.index, ttlMs, now())) {
      onProgress({ phase: 'tab', done, total: tabs.length, tabName: tab.name, cached: true })
      continue
    }
    onProgress({ phase: 'tab', done, total: tabs.length, tabName: tab.name })
    let items
    try {
      items = await client.fetchTab(tab.index, tab)
    } catch (e) {
      if (e?.kind === 'auth' || e?.kind === 'ratelimit') throw e
      continue // individual tab failure -> keep old stored state, carry on
    }
    const tabData = await valueTab({ items, tab, valuator, normalize, cdRatio, league, accountName })
    await store.setTab(user, tab.index, tabData) // persists immediately
  }
  return tabs
}
