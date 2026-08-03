/* Stash-tab identity — pure helpers, no DOM (same pattern as trend.js, so the
 * logic can be unit-tested in node).
 *
 * A tab is identified by its INDEX: GGG's `i`, carried by every snapshot tab as
 * `index` and by every item row as `tabIndex`. The NAME is display only.
 * Reason: stash tabs may be unnamed, and every unnamed tab has the same name
 * "". Keying the sidebar (order, exclusion, dedup) off the name collapsed all
 * unnamed tabs into a single entry — 18 tabs showed up as 15 — and unchecking
 * one of them excluded all of them.
 */
'use strict'

// What the user sees for a tab. Unnamed tabs get a stable, distinguishable
// label from their raw GGG index, so four of them are four different rows.
export function tabLabel (t) {
  const name = t && typeof t.name === 'string' ? t.name : ''
  if (name.trim()) return name
  const i = Number(t ? t.index : NaN)
  return Number.isFinite(i) ? `Tab #${i}` : 'Tab'
}

// Sidebar display order: saved order (a list of indexes) first, then every tab
// not covered by it — new tabs from a fresh scan — appended in natural index
// order. Deduplicated by index, so unnamed tabs all survive.
export function orderedTabs (tabs, saved) {
  const byIndex = new Map()
  for (const t of (Array.isArray(tabs) ? tabs : [])) {
    const i = Number(t ? t.index : NaN)
    if (!Number.isFinite(i) || byIndex.has(i)) continue
    byIndex.set(i, t)
  }
  const out = []
  const seen = new Set()
  for (const raw of (Array.isArray(saved) ? saved : [])) {
    const i = Number(raw)
    if (!byIndex.has(i) || seen.has(i)) continue
    out.push(byIndex.get(i)); seen.add(i)
  }
  for (const i of [...byIndex.keys()].filter(i => !seen.has(i)).sort((a, b) => a - b)) {
    out.push(byIndex.get(i))
  }
  return out
}

/* Per-tab selection state. Three states, cycled by clicking the row:
 *
 *   on      counted, and the All / None / Only-w-value buttons may change it
 *   off     not counted, but those buttons may switch it back on
 *   ignored not counted, and the three buttons LEAVE IT ALONE — for tabs that
 *           should never be in the picture (dump tabs, a mule's tab, …).
 *
 * 'ignored' is what 'off' cannot be: sticky. Without it every "All" undid the
 * user's exclusions, which is exactly the complaint this state answers.
 */
export const TAB_STATES = ['on', 'off', 'ignored']

export function nextTabState (cur) {
  const i = TAB_STATES.indexOf(cur)
  return TAB_STATES[(i + 1) % TAB_STATES.length]
}

// Resolve a tab's state from the two persisted index sets. 'ignored' wins over
// 'off' so a tab that ended up in both (an older build only knew the exclusion
// list) reads as ignored instead of silently losing its sticky flag.
export function tabState (index, off, ignored) {
  const i = Number(index)
  if (ignored && ignored.has(i)) return 'ignored'
  if (off && off.has(i)) return 'off'
  return 'on'
}

// One-shot migration of a persisted NAME list (order or exclusion list, both
// pre-index format) to indexes, resolved against the current snapshot.
// Unnamed and ambiguous names are skipped on purpose: for the exclusion list
// that means showing one tab too many rather than hiding the wrong one.
export function migrateTabNames (names, tabs) {
  const byName = new Map()
  for (const t of (Array.isArray(tabs) ? tabs : [])) {
    const n = t && typeof t.name === 'string' ? t.name : ''
    const i = Number(t ? t.index : NaN)
    if (!n.trim() || !Number.isFinite(i)) continue
    if (byName.has(n)) byName.set(n, null) // same name twice -> not resolvable
    else byName.set(n, i)
  }
  const out = []
  const seen = new Set()
  for (const n of (Array.isArray(names) ? names : [])) {
    const i = byName.get(n)
    if (i == null || seen.has(i)) continue
    out.push(i); seen.add(i)
  }
  return out
}
