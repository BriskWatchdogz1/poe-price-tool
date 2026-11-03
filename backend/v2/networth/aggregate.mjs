// backend/v2/networth/aggregate.mjs
// Pure function: valued entries -> snapshot (total chaos+divine via
// injected C:D ratio, breakdown per tab & category, unpriced list).
// unpriced (value===null) NEVER goes into the sum as 0 — the gap is
// reported explicitly (feasibility: call out the rare-gear gap clearly).
import { round1 } from '../ninja.mjs'

const UNPRICED_MAX = 100 // display limit on NAMES; counts.unpriced/unpricedPieces still count all of them
const TOPITEMS_MAX = 100 // sell-list display cap

// THE UNPRICED CAP IS A DISPLAY LIMIT AND NOTHING ELSE, and saying so is not
// pedantry — it leaked out of the display exactly once and cost real numbers.
// The net-worth history diffs the stash against its previous minute over a map
// that holds the priced rows AND the unpriced names (history.mjs, foldItems):
// a name in that map is proof the item is still there, so losing a price comes
// out as a price move instead of as stock leaving. A name the cap ranks out of
// `snapshot.unpriced` would be missing from that proof and read as "in neither
// list, therefore gone" — for precisely the thinly traded items that drift in
// and out of being priced (docs/bugs.md B2).
//
// So the cap applies where the list is READ BY A HUMAN, and not where it is
// read by the server:
//   `unpricedMax` — every caller whose result is stored rather than shown passes
//                   Infinity (scan.mjs writes the per-tab store), so the store
//                   holds every unpriced name of its tab. Bounded by the tab's
//                   own slots; the priced `items[]` next to it is uncapped for
//                   the same reason.
//   `unpricedStock()` — the account-wide fold the recorder reads, off the stored
//                   tabs directly. It never travels to the browser, so the
//                   snapshot that does keeps its cap and its size.
const capOf = n => ((n === Infinity || (Number.isFinite(n) && n >= 0)) ? n : UNPRICED_MAX)

// EVERY unpriced name a user's stored tabs know about, in PIECES, merged across
// tabs — the input the history recorder needs and the only one that answers
// "is this name still in the stash?" without a cap in the way.
//
// Deliberately smaller than `snapshot.unpriced`: no `kind` (nothing reads it
// here) and no `tabIndex` (the diff is account-wide, so a name that moved from
// one tab to another must fold into ONE entry or the move reads as a departure
// plus an arrival). `{name, count}` is exactly the shape foldItems already
// consumes, so nothing downstream had to learn a new one.
//
// A tab stored before the store went uncapped carries at most 100 names, and
// this fold cannot invent what is not there — it is complete for a tab from the
// next time the refresher writes it, and completeness returns tab by tab.
export function unpricedStock (tabs) {
  const byName = new Map()
  for (const tab of (tabs || [])) {
    for (const u of (tab?.unpriced || [])) {
      if (!u || typeof u.name !== 'string' || !u.name) continue
      const n = Number(u.count)
      byName.set(u.name, (byName.get(u.name) || 0) + (Number.isFinite(n) && n > 0 ? n : 0))
    }
  }
  return [...byName].map(([name, count]) => ({ name, count }))
}

// THREE COUNTS, THREE UNITS — and they are not interchangeable:
//   ENTRIES = GGG stash entries (one slot, whatever it holds). counts.*
//   PIECES  = the sum of their stack sizes.                    row `count`/`qty`
//   ROWS    = grouped display lines (kind|name|price|tab).     tabs[].items
// Printing the first over a list of the second and calling both "items" is
// wrong both ways: a five-stack makes the headline too small, and a row the
// name cap cut out of the list makes it too big. Every number this module hands
// out says which of the three it is, and `counts.unpricedPieces` exists so the
// page never has to guess a piece total from a capped list.

// A descriptor's stack size AS A PIECE COUNT, clamped exactly the way
// normalize.mjs clamps GGG's `stackSize`: anything that is not a finite number
// above zero counts as one piece. `?? 1` did not do that — 0 is not nullish, so
// a single zero-stack entry could make the piece total come out BELOW the
// number of entries it was built from. Unreachable through normalize.mjs today
// (every classifier passes the clamped value through or hardcodes 1); the clamp
// lives here too so the two numbers cannot contradict each other whatever a
// future descriptor source hands in.
function pieceCount (desc) {
  const n = Number(desc?.stack)
  return Number.isFinite(n) && n > 0 ? n : 1
}

// A stored tab's unpriced PIECE total. Written by scan.mjs since this count
// exists; a tab last synced before that carries only its grouped rows, so their
// `count` fields are summed instead. That fallback is exact for every tab whose
// stored list holds all of its names — which is every tab written since that
// list stopped being capped — and it never overstates, so it corrects itself the
// next time the refresher reaches the tab.
function unpricedPiecesOf (stored) {
  const n = stored?.counts?.unpricedPieces
  if (typeof n === 'number' && Number.isFinite(n)) return n
  return (stored?.unpriced || []).reduce((sum, u) => sum + (Number(u?.count) || 0), 0)
}

// Two input shapes, IDENTICAL output snapshot:
//   { entries: [...] }  -> flat valued-entry list (per-tab valuation + tests)
//   { tabs:    [...] }  -> stored per-tab objects (the incremental store) —
//                          the union of all tabs' item rows is the snapshot.
//
// `unpricedMax` caps the unpriced NAME list of either shape (see capOf above).
// It defaults to the display cap, so a caller that does not mention it gets the
// snapshot the page has always been served.
export function aggregate ({ entries, tabs, cdRatio, league, accountName, now = new Date().toISOString(), unpricedMax = UNPRICED_MAX }) {
  if (tabs) return aggregateFromTabs({ tabs, cdRatio, league, accountName, now, unpricedMax })
  return aggregateFromEntries({ entries, cdRatio, league, accountName, now, unpricedMax })
}

// Snapshot from the per-tab store. Each tab already carries GROUPED item rows
// (kind|name|chaosEach, one tab), a grouped unpriced list and entry counts.
// Turn the priced rows back into pseudo-entries and reuse the entry core for
// totals/tabs/categories/topItems/items[] (all derivable from the rows), then
// merge the pre-grouped unpriced lists and sum the faithful per-tab counts.
function aggregateFromTabs ({ tabs, cdRatio, league, accountName, now, unpricedMax = UNPRICED_MAX }) {
  const entries = []
  for (const tab of tabs) {
    for (const row of (tab.items || [])) {
      entries.push({
        desc: { kind: row.kind, name: row.name, stack: row.qty },
        tabIndex: row.tabIndex, tabName: row.tab,
        // `source` (which feed produced this price) is carried on the stored
        // row and passed straight back through, so the round trip through the
        // per-tab store does not erase the provenance of a number. `uncertain`
        // likewise must not lose its doubt on the way (a row stored before
        // the field existed reads null until its tab is synced again).
        value: { chaosEach: row.chaosEach, chaosTotal: row.chaosTotal, source: row.source ?? null, uncertain: row.uncertain ?? null }
      })
    }
  }
  const snap = aggregateFromEntries({ entries, cdRatio, league, accountName, now })

  // snap.tabs must list EVERY scanned tab, not only the ones that happened to
  // hold priced items. aggregateFromEntries can only see priced rows, so an
  // empty or all-unpriced tab would vanish entirely — at league start that is
  // most of them, and the UI would report "5/5 tabs" to someone with
  // seventeen. Merge the stored tab list back in with zeroed totals: priced
  // tabs keep their order (by value), the rest follow in stash order.
  //
  // syncedAt passthrough: the per-tab store stamps each tab with when it was
  // last valued (store.setTab), which the frontend's status line ("N/M tabs
  // fresh · oldest synced X min ago") needs. Only attached when the stored tab
  // actually carries a numeric syncedAt, so the entries-path snapshot (which
  // has no syncedAt concept) keeps its shape.
  //
  // `unpriced` / `unpricedPieces` per tab: the merged unpriced list below is
  // name-grouped AND capped, so it can never state a faithful total on its own.
  // The stored per-tab counts can, and the UI needs them per tab to scope the
  // unpriced summary to the selected tabs instead of quoting the whole account.
  // BOTH units travel because the summary states pieces (the ×N of the rows)
  // while the tab tooltip states entries (next to priced/skipped, which are
  // entries as well) — one number could not serve both without lying to one.
  //
  // `priced` per tab, for that same tooltip. `items` right next to it is the
  // number of grouped display ROWS, because that is all the priced round trip
  // through the store can reconstruct: thirty Divine Orbs that arrived as three
  // stash entries come back as ONE row. The tooltip promises GGG item counts
  // ("N priced · M unpriced · K skipped"), so it needs the stored entry count,
  // not a row count beside two entry counts.
  //
  // `skipped` per tab, same reasoning, for a question the page cannot answer
  // otherwise: a tab reading "0c · 0 items" means either that nothing
  // arrived from GGG or that everything arrived and the classifier dropped it
  // (rare/magic gear and non-unique maps are `skip`). The store holds that
  // difference; without it in the snapshot the empty map stash (B7) cannot be
  // judged from the screen at all.
  const storedByIndex = new Map(tabs.map(t => [t.index, t]))
  const decorate = (t) => {
    const stored = storedByIndex.get(t.index)
    const out = typeof stored?.syncedAt === 'number' ? { ...t, syncedAt: stored.syncedAt } : { ...t }
    out.priced = stored?.counts?.priced || 0
    out.unpriced = stored?.counts?.unpriced || 0
    out.unpricedPieces = unpricedPiecesOf(stored)
    out.skipped = stored?.counts?.skipped || 0
    return out
  }
  const pricedIdx = new Set(snap.tabs.map(t => t.index))
  snap.tabs = snap.tabs
    .map(decorate)
    .concat(tabs
      .filter(t => !pricedIdx.has(t.index))
      .map(t => decorate({ index: t.index, name: t.name, chaos: 0, items: 0 })))

  // unpriced: the per-tab lists are already name-grouped WITHIN a tab. Keep
  // that granularity (one row per name+tab, carrying tabIndex — exactly like
  // items[]) instead of merging it away: without it the UI cannot apply the
  // stash-tab selection to this block, and unchecking a tab left its unpriced
  // items on screen. The UNPRICED_MAX cap stays a cap on NAMES, ranked by their
  // total count across tabs, so "across N names" keeps meaning what it did.
  //
  // THIS IS THE LIST THAT GOES OVER THE WIRE, so this is where the cap belongs.
  // The recorder does not read it — it reads unpricedStock(tabs) inside the
  // server, uncapped — which is why lifting the limit for its sake would have
  // paid for a snapshot that is bigger for every reader in a browser.
  //
  // THE CAP IS WHY tabs[].unpricedPieces IS NEEDED. It is account-wide, so a
  // name with one piece in one tab can be ranked out by 100 busier names in
  // OTHER tabs — the row disappears from a tab whose own list is one line long.
  // That is what produced "40 unpriced items across 1 names" over a list adding
  // up to 39: not a lost piece, a lost ROW that the headline still counted.
  const byName = new Map()
  for (const tab of tabs) {
    for (const u of (tab.unpriced || [])) {
      const g = byName.get(u.name) || { count: 0, rows: [] }
      g.count += u.count
      g.rows.push({ name: u.name, kind: u.kind, count: u.count, tabIndex: tab.index })
      byName.set(u.name, g)
    }
  }
  snap.unpriced = [...byName.values()]
    .sort((a, b) => b.count - a.count)   // rank names, so the cap cuts the rarest names
    .slice(0, capOf(unpricedMax))
    .flatMap(g => g.rows)
    .sort((a, b) => b.count - a.count)   // rows descending, same as the entries path

  // counts: sum the per-tab entry counts (priced/unpriced/skipped are the
  // ORIGINAL GGG-item counts, preserved exactly across the round-trip) plus
  // unpricedPieces, which is the same set of items measured in PIECES.
  const counts = { priced: 0, unpriced: 0, unpricedPieces: 0, skipped: 0 }
  for (const tab of tabs) {
    counts.priced += tab.counts?.priced || 0
    counts.unpriced += tab.counts?.unpriced || 0
    counts.unpricedPieces += unpricedPiecesOf(tab)
    counts.skipped += tab.counts?.skipped || 0
  }
  snap.counts = counts
  return snap
}

function aggregateFromEntries ({ entries, cdRatio, league, accountName, now = new Date().toISOString(), unpricedMax = UNPRICED_MAX }) {
  const unpricedCap = capOf(unpricedMax)
  const byTab = new Map()
  const byCategory = new Map()
  const byTop = new Map()     // `kind|name|chaosEach` -> aggregated sell-list row (capped, tabs collected)
  const byItem = new Map()    // `kind|name|round(chaosEach)|tabIndex` -> full item row (uncapped, per tab)
  const byUnpriced = new Map() // `name|tabIndex` -> grouped unpriced row (one tab per row, like byItem)
  let totalChaos = 0
  let priced = 0
  let unpricedCount = 0   // ENTRIES without a price
  let unpricedPieces = 0  // …and what they add up to in PIECES — counted for
                          // every one of them, including the ones the name cap
                          // keeps out of the row list.
  let skipped = 0

  for (const e of entries) {
    if (e.desc.kind === 'skip') { skipped++; continue }
    const stack = pieceCount(e.desc)
    if (!e.value) {
      unpricedCount++
      unpricedPieces += stack
      // Keyed by tab as well: an unpriced row belongs to exactly one tab, so
      // the UI can filter this block by the stash-tab selection like the
      // priced one. In production this path values a SINGLE tab (scan.mjs),
      // where name and name|tabIndex are the same grouping.
      const ukey = `${e.desc.name}|${e.tabIndex}`
      const u = byUnpriced.get(ukey)
      if (u) { u.count += stack } else if (byUnpriced.size < unpricedCap) {
        byUnpriced.set(ukey, { name: e.desc.name, kind: e.desc.kind, count: stack, tabIndex: e.tabIndex })
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
    //
    // `source` rides along: it is the ONLY record of which feed produced a
    // price once the valuation is over, and without it an implausible number in
    // the history cannot be traced back to Faustus, poe.ninja or the trade API
    // afterwards — the exact dead end the Scavenger incident ran into (see
    // price-guard.mjs). Rows are grouped by kind|name|price|tab, and one route
    // values a whole tab, so every entry folded into a row shares its source.
    //
    // `uncertain` rides along the same way (docs/pricing-logic.md, "Uncertain
    // prices"). Unlike the source it can differ between entries of one row —
    // two copies of a unique, one whose mods decided the variant and one whose
    // did not — and the row is uncertain as soon as ONE folded entry is:
    // too cautious is better than silently certain. It moves no number.
    const ikey = `${e.desc.kind}|${e.desc.name}|${round1(e.value.chaosEach)}|${e.tabIndex}`
    const it = byItem.get(ikey)
    if (it) {
      it.qty += stack; it.chaosTotal += e.value.chaosTotal
      if (it.uncertain == null && e.value.uncertain) it.uncertain = e.value.uncertain
    } else {
      byItem.set(ikey, {
        name: e.desc.name, kind: e.desc.kind, tab: e.tabName, tabIndex: e.tabIndex,
        qty: stack, chaosEach: e.value.chaosEach, chaosTotal: e.value.chaosTotal,
        source: e.value.source ?? null, uncertain: e.value.uncertain ?? null
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
    // `count` is PIECES (the ×N the page prints), one row per name+tab.
    unpriced: [...byUnpriced.values()].sort((a, b) => b.count - a.count).slice(0, unpricedCap),
    counts: { priced, unpriced: unpricedCount, unpricedPieces, skipped }
  }
}
