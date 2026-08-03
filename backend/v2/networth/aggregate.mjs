// backend/v2/networth/aggregate.mjs
// Pure function: valued entries -> snapshot (total chaos+divine via
// injected C:D ratio, breakdown per tab & category, unpriced list).
// unpriced (value===null) NEVER goes into the sum as 0 — the gap is
// reported explicitly (feasibility: call out the rare-gear gap clearly).
import { round1 } from '../ninja.mjs'

const UNPRICED_MAX = 100 // display limit; counts.unpriced still counts all of them
const TOPITEMS_MAX = 100 // sell-list display cap

// Two input shapes, IDENTICAL output snapshot:
//   { entries: [...] }  -> flat valued-entry list (per-tab valuation + tests)
//   { tabs:    [...] }  -> stored per-tab objects (the incremental store) —
//                          the union of all tabs' item rows is the snapshot.
export function aggregate ({ entries, tabs, cdRatio, league, accountName, now = new Date().toISOString() }) {
  if (tabs) return aggregateFromTabs({ tabs, cdRatio, league, accountName, now })
  return aggregateFromEntries({ entries, cdRatio, league, accountName, now })
}

// Snapshot from the per-tab store. Each tab already carries GROUPED item rows
// (kind|name|chaosEach, one tab), a grouped unpriced list and entry counts.
// Turn the priced rows back into pseudo-entries and reuse the entry core for
// totals/tabs/categories/topItems/items[] (all derivable from the rows), then
// merge the pre-grouped unpriced lists and sum the faithful per-tab counts.
function aggregateFromTabs ({ tabs, cdRatio, league, accountName, now }) {
  const entries = []
  for (const tab of tabs) {
    for (const row of (tab.items || [])) {
      entries.push({
        desc: { kind: row.kind, name: row.name, stack: row.qty },
        tabIndex: row.tabIndex, tabName: row.tab,
        value: { chaosEach: row.chaosEach, chaosTotal: row.chaosTotal, source: 'store' }
      })
    }
  }
  const snap = aggregateFromEntries({ entries, cdRatio, league, accountName, now })

  // snap.tabs must list EVERY scanned tab, not only the ones that happened to
  // hold priced items. aggregateFromEntries can only see priced rows, so an
  // empty or all-unpriced tab used to vanish entirely — at league start that is
  // most of them, and the UI then reported "5/5 tabs" to someone with
  // seventeen. Merge the stored tab list back in with zeroed totals: priced
  // tabs keep their order (by value), the rest follow in stash order.
  //
  // syncedAt passthrough: the per-tab store stamps each tab with when it was
  // last valued (store.setTab), which the frontend's status line ("N/M tabs
  // fresh · oldest synced X min ago") needs. Only attached when the stored tab
  // actually carries a numeric syncedAt, so the entries-path snapshot (which
  // has no syncedAt concept) stays byte-identical.
  const withSynced = (t, syncedAt) => (typeof syncedAt === 'number' ? { ...t, syncedAt } : t)
  const syncedByIndex = new Map(tabs.map(t => [t.index, t.syncedAt]))
  const pricedIdx = new Set(snap.tabs.map(t => t.index))
  snap.tabs = snap.tabs
    .map(t => withSynced(t, syncedByIndex.get(t.index)))
    .concat(tabs
      .filter(t => !pricedIdx.has(t.index))
      .map(t => withSynced({ index: t.index, name: t.name, chaos: 0, items: 0 }, t.syncedAt)))

  // unpriced: merge the per-tab (already name-grouped) lists across tabs.
  const byUnpriced = new Map()
  for (const tab of tabs) {
    for (const u of (tab.unpriced || [])) {
      const cur = byUnpriced.get(u.name)
      if (cur) cur.count += u.count
      else byUnpriced.set(u.name, { name: u.name, kind: u.kind, count: u.count })
    }
  }
  snap.unpriced = [...byUnpriced.values()].sort((a, b) => b.count - a.count).slice(0, UNPRICED_MAX)

  // counts: sum the per-tab entry counts (priced/unpriced/skipped are the
  // ORIGINAL GGG-item counts, preserved exactly across the round-trip).
  const counts = { priced: 0, unpriced: 0, skipped: 0 }
  for (const tab of tabs) {
    counts.priced += tab.counts?.priced || 0
    counts.unpriced += tab.counts?.unpriced || 0
    counts.skipped += tab.counts?.skipped || 0
  }
  snap.counts = counts
  return snap
}

function aggregateFromEntries ({ entries, cdRatio, league, accountName, now = new Date().toISOString() }) {
  const byTab = new Map()
  const byCategory = new Map()
  const byTop = new Map()     // `kind|name|chaosEach` -> aggregated sell-list row (capped, tabs collected)
  const byItem = new Map()    // `kind|name|round(chaosEach)|tabIndex` -> full item row (uncapped, per tab)
  const byUnpriced = new Map() // name -> grouped unpriced row
  let totalChaos = 0
  let priced = 0
  let unpricedCount = 0
  let skipped = 0

  for (const e of entries) {
    if (e.desc.kind === 'skip') { skipped++; continue }
    const stack = e.desc.stack ?? 1
    if (!e.value) {
      unpricedCount++
      const u = byUnpriced.get(e.desc.name)
      if (u) { u.count += stack } else if (byUnpriced.size < UNPRICED_MAX) {
        byUnpriced.set(e.desc.name, { name: e.desc.name, kind: e.desc.kind, count: stack })
      }
      continue
    }
    priced++
    totalChaos += e.value.chaosTotal
    const t = byTab.get(e.tabIndex) || { index: e.tabIndex, name: e.tabName, chaos: 0, items: 0 }
    t.chaos += e.value.chaosTotal; t.items++; byTab.set(e.tabIndex, t)
    const c = byCategory.get(e.desc.kind) || { chaos: 0, items: 0 }
    c.chaos += e.value.chaosTotal; c.items++; byCategory.set(e.desc.kind, c)
    // Sell-list grouping: same item (kind|name) at the same unit price folds
    // into one row; stacks and totals sum, distinct tabs collect.
    const key = `${e.desc.kind}|${e.desc.name}|${e.value.chaosEach}`
    const g = byTop.get(key)
    if (g) {
      g.count += stack; g.chaosTotal += e.value.chaosTotal
      if (e.tabName != null && !g.tabs.includes(e.tabName)) g.tabs.push(e.tabName)
    } else {
      byTop.set(key, {
        name: e.desc.name, kind: e.desc.kind, count: stack,
        chaosEach: e.value.chaosEach, chaosTotal: e.value.chaosTotal,
        tabs: e.tabName != null ? [e.tabName] : []
      })
    }
    // Full item list (snapshot.items): same grouping as topItems but ALSO keyed
    // by tabIndex — so each row belongs to exactly one tab (singular tab/tabIndex
    // for the filterable UI + deep-links) and is NOT capped.
    const ikey = `${e.desc.kind}|${e.desc.name}|${round1(e.value.chaosEach)}|${e.tabIndex}`
    const it = byItem.get(ikey)
    if (it) { it.qty += stack; it.chaosTotal += e.value.chaosTotal } else {
      byItem.set(ikey, {
        name: e.desc.name, kind: e.desc.kind, tab: e.tabName, tabIndex: e.tabIndex,
        qty: stack, chaosEach: e.value.chaosEach, chaosTotal: e.value.chaosTotal
      })
    }
  }

  return {
    at: now,
    league,
    accountName,
    cdRatio,
    totalChaos: round1(totalChaos),
    totalDivine: cdRatio > 0 ? round1(totalChaos / cdRatio) : 0,
    tabs: [...byTab.values()]
      .map(t => ({ ...t, chaos: round1(t.chaos) }))
      .sort((a, b) => a.index - b.index), // in-game/account order, NOT by value
    categories: Object.fromEntries(
      [...byCategory].map(([k, v]) => [k, { chaos: round1(v.chaos), items: v.items }])),
    topItems: [...byTop.values()]
      .map(g => ({ ...g, chaosTotal: round1(g.chaosTotal) }))
      .sort((a, b) => b.chaosTotal - a.chaosTotal)
      .slice(0, TOPITEMS_MAX),
    items: [...byItem.values()]
      .map(g => ({ ...g, chaosTotal: round1(g.chaosTotal) }))
      .sort((a, b) => b.chaosTotal - a.chaosTotal), // uncapped, descending by chaosTotal
    unpriced: [...byUnpriced.values()].sort((a, b) => b.count - a.count).slice(0, UNPRICED_MAX),
    counts: { priced, unpriced: unpricedCount, skipped }
  }
}
