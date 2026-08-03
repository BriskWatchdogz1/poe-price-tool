import { buildHighlight, HIGHLIGHT_MAX_DEFAULT } from './highlight.js'
import { tabLabel, orderedTabs, migrateTabNames, tabState, nextTabState } from './tabs.js'

/* Net Worth — Vanilla frontend, standalone page.
 * (identity gate/WS connect mirrored, no shared state with app.js).
 * Protocol: sends {type:'networth-history'}, receives networth-latest /
 * networth-result / networth-history. Snapshots are filled in by the
 * server's 24/7 background auto-sync — there is no manual scan trigger.
 *
 * Rendering (redesign): filterable sell view — sidebar stash-tab picker
 * (drag-reorderable), collapsible category overview, list/grouped toggle,
 * kind chips, search, value threshold. Snapshot shape (backend, unchanged):
 *   snapshot.items[]  = { name, kind, tab, tabIndex, qty, chaosEach, chaosTotal }
 *   snapshot.tabs[]   = { index, name, chaos, items }  (sorted by index = in-game order)
 *   snapshot.categories = { kind: { chaos, items } }
 *   snapshot.unpriced[] = { name, kind, count } */
'use strict'

// ---- DOM handles -----------------------------------------------------------
const errBox        = document.getElementById('errBox')
const noResultEl     = document.getElementById('noResult')
const shellEl        = document.getElementById('shell')
const sideBoxEl      = document.getElementById('sideBox')   // rail R6 block (tab picker)
const totalDivEl     = document.getElementById('totalDiv')
const totalChaosEl   = document.getElementById('totalChaos')
const conn           = document.getElementById('conn')
const connlbl        = document.getElementById('connlbl')
const autosyncEl     = document.getElementById('autosync')

const sideCountEl    = document.getElementById('sideCount')
const tabListEl      = document.getElementById('tabList')
const selAllBtn      = document.getElementById('selAll')
const selNoneBtn     = document.getElementById('selNone')
const selValuedBtn   = document.getElementById('selValued')
const resetOrderBtn  = document.getElementById('resetOrder')

const overviewEl     = document.getElementById('overview')
const ovToggle       = document.getElementById('ovToggle')
const barsEl         = document.getElementById('bars')

const viewSeg        = document.getElementById('viewSeg')
const chipsEl        = document.getElementById('kindChips')
const searchInput    = document.getElementById('q')
const threshSel      = document.getElementById('threshSel')

const statEl         = document.getElementById('stat')
const hlToggle       = document.getElementById('hlToggle')
const hlBox          = document.getElementById('hlBox')
const hlText         = document.getElementById('hlText')
const hlCopy         = document.getElementById('hlCopy')
const hlMax          = document.getElementById('hlMax')
const hlMeta         = document.getElementById('hlMeta')
const hlWarn         = document.getElementById('hlWarn')
const statHiddenEl   = document.getElementById('statHidden')
const wrapEl         = document.getElementById('wrap')

const unpricedBox     = document.getElementById('unpricedBox')
const unpricedSummary = document.getElementById('unpricedSummary')
const unpricedList     = document.getElementById('unpricedList')
const historyBox      = document.getElementById('historyBox')
const historyList      = document.getElementById('historyList')

// ---- Helpers ---------------------------------------------------------------
const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s
const fmt = n => Number(n ?? 0).toLocaleString('en-US')
// Rounding to whole chaos turns every cheap currency into a bare "0 c" — an
// Armourer's Scrap at 0.15c read as worthless even though 27 of them are 4c.
// Below 1c keep enough precision to stay meaningful; from 1c up, whole numbers.
const fmtC = (n) => {
  const v = Number(n) || 0
  if (v !== 0 && Math.abs(v) < 1) {
    return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: Math.abs(v) < 0.1 ? 3 : 2 })
  }
  return Math.round(v).toLocaleString('en-US')
}

const KIND_LABEL = {
  stackable: 'Currency & Stackables', unique: 'Uniques',
  divcard: 'Divination Cards', beast: 'Beasts', incubator: 'Incubators',
  vial: 'Vials', gem: 'Gems', corpse: 'Corpses'
}
const CAT_ORDER = ['unique', 'stackable', 'divcard', 'gem', 'beast', 'incubator', 'vial', 'corpse']

function money (v, cdRatio) {
  const n = Number(v) || 0
  if (cdRatio > 0 && n >= cdRatio) {
    return `<span class="val div">${(n / cdRatio).toLocaleString('en-US', { maximumFractionDigits: 1 })}<span class="u"> div</span></span>`
  }
  return `<span class="val">${fmtC(n)}<span class="u"> c</span></span>`
}
function moneyShort (v, cdRatio) {
  const n = Number(v) || 0
  if (cdRatio > 0 && n >= cdRatio) return `${(n / cdRatio).toLocaleString('en-US', { maximumFractionDigits: n / cdRatio >= 100 ? 0 : 1 })}d`
  return `${fmtC(n)}c`
}

const TRADE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7"/><path d="M9 7h8v8"/></svg>'
// Per-item link to the official trade site: uniques search by name, everything
// else by type (gem name, scarab/essence/div-card name, ...). league comes from
// the snapshot. Pure-currency edge cases may land on an empty search — that's
// fine; the link is meant for the uniques/gems you actually list to sell.
function tradeUrl (name, kind, league) {
  const q = kind === 'unique'
    ? { query: { name, status: { option: 'online' } } }
    : { query: { type: name, status: { option: 'online' } } }
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(league || '')}?q=${encodeURIComponent(JSON.stringify(q))}`
}
function tradeBtn (name, kind, league) {
  return `<a class="tradebtn" href="${esc(tradeUrl(name, kind, league))}" target="_blank" rel="noopener noreferrer" title="Open on pathofexile.com/trade">${TRADE_ICON}</a>`
}

// ---- Persisted UI state ------------------------------------------------------
const THRESH_KEY = 'ppt_networth_threshold'
const THRESH_DEFAULT = '1'
const VIEW_KEY = 'ppt_networth_view'
// Tab order and exclusion list are stored per INDEX since .v2 — the v1 keys
// held tab NAMES and must not be read as indexes (see migrateTabKeys).
const ORDER_KEY = 'ppt_networth_taborder.v2'
const ORDER_KEY_V1 = 'ppt_networth_taborder'
const TABOFF_KEY = 'ppt_networth_tabs_off.v2'
const TABOFF_KEY_V1 = 'ppt_networth_tabs_off'
// Sticky exclusions — kept apart from TABOFF_KEY on purpose: the All/None/
// Only-w-value buttons rewrite the off list wholesale, this one they never touch.
const TABIGN_KEY = 'ppt_networth_tabs_ignored.v1'
const TABMODE_KEY = 'ppt_networth_tabmode'
const TAB_MODES = ['all', 'none', 'valued', 'custom']
const GRPCLOSED_KEY = 'ppt_networth_groups_closed.v1'

function loadThreshold () {
  const v = localStorage.getItem(THRESH_KEY)
  return v == null ? THRESH_DEFAULT : v
}
function saveThreshold (v) { try { localStorage.setItem(THRESH_KEY, v) } catch { /* ignore */ } }
function thresholdChaos (v, cdRatio) {
  if (v === 'div') return Number(cdRatio) || 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function loadView () {
  const v = localStorage.getItem(VIEW_KEY)
  return v === 'list' || v === 'grouped' ? v : 'grouped'
}
function saveView (v) { try { localStorage.setItem(VIEW_KEY, v) } catch { /* ignore */ } }
const toIndexList = a => (Array.isArray(a) ? a.map(Number).filter(Number.isFinite) : [])
function loadOrder () {
  try { return toIndexList(JSON.parse(localStorage.getItem(ORDER_KEY) || '[]')) } catch { return [] }
}
function saveOrder (indexes) { try { localStorage.setItem(ORDER_KEY, JSON.stringify(indexes)) } catch { /* ignore */ } }
function loadTabsOff () {
  try { return new Set(toIndexList(JSON.parse(localStorage.getItem(TABOFF_KEY) || '[]'))) } catch { return new Set() }
}
function saveTabsOff (set) { try { localStorage.setItem(TABOFF_KEY, JSON.stringify([...set])) } catch { /* ignore */ } }
function loadTabsIgnored () {
  try { return new Set(toIndexList(JSON.parse(localStorage.getItem(TABIGN_KEY) || '[]'))) } catch { return new Set() }
}
function saveTabsIgnored (set) { try { localStorage.setItem(TABIGN_KEY, JSON.stringify([...set])) } catch { /* ignore */ } }
function loadTabMode () {
  const v = localStorage.getItem(TABMODE_KEY)
  return TAB_MODES.includes(v) ? v : 'all'
}
function saveTabMode (v) { try { localStorage.setItem(TABMODE_KEY, v) } catch { /* ignore */ } }

// Collapsed state of the grouped-view categories. Keyed by the group's stable
// KIND (not its list position), so it survives re-renders, reloads AND a
// category temporarily vanishing from a snapshot. Missing key = positional
// default (first three groups open). Every server snapshot rebuilds #wrap via
// innerHTML — without this store the collapse state lived only in the DOM and
// reset on each ~30s sync (the bug the user hit).
function loadGroupsClosed () {
  try {
    const o = JSON.parse(localStorage.getItem(GRPCLOSED_KEY) || '{}')
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch { return {} }
}
function saveGroupsClosed (o) { try { localStorage.setItem(GRPCLOSED_KEY, JSON.stringify(o)) } catch { /* ignore */ } }

let groupsClosed = loadGroupsClosed() // kind -> bool (missing = positional default)
function isGroupClosed (kind, idx) {
  return typeof groupsClosed[kind] === 'boolean' ? groupsClosed[kind] : idx > 2
}

let tabsOff = loadTabsOff() // Set of tab INDEXES currently unchecked (missing = on)
let tabsIgnored = loadTabsIgnored() // Set of tab INDEXES permanently excluded (see tabs.js)
let tabMode = loadTabMode() // 'all' | 'none' | 'valued' | 'custom' — drives the sideacts button highlight
function isTabIgnored (t) { return tabsIgnored.has(Number(t && t.index)) }
function stateOf (t) { return tabState(t && t.index, tabsOff, tabsIgnored) }
function isTabOn (t) { return stateOf(t) === 'on' }

// One-shot upgrade of the v1 (name-keyed) order/exclusion lists, resolved
// against the first snapshot that arrives — before that there is nothing to map
// names onto. Unresolvable names are dropped (see migrateTabNames); the v1 keys
// are removed afterwards so this runs exactly once per browser.
let tabKeysMigrated = false
function migrateTabKeys (tabs) {
  if (tabKeysMigrated || !(tabs && tabs.length)) return
  tabKeysMigrated = true
  for (const [oldKey, newKey] of [[ORDER_KEY_V1, ORDER_KEY], [TABOFF_KEY_V1, TABOFF_KEY]]) {
    try {
      const raw = localStorage.getItem(oldKey)
      if (raw == null) continue
      if (localStorage.getItem(newKey) == null) {
        const mapped = migrateTabNames(JSON.parse(raw), tabs)
        if (mapped.length) localStorage.setItem(newKey, JSON.stringify(mapped))
      }
      localStorage.removeItem(oldKey)
    } catch { /* corrupt v1 value -> start clean */ }
  }
  tabsOff = loadTabsOff()
}

// Per-tab value AFTER the global "hide < threshold" filter: sum of this
// tab's items (by tabIndex) whose chaosTotal >= threshold. A tab whose items
// are all below the threshold shows/counts as 0 — independent of tab
// selection (on/off), independent of kind chips and search.
function computeTabValues (threshold) {
  const map = new Map()
  const s = currentSnapshot
  if (!s) return map
  for (const it of (s.items || [])) {
    if (it.chaosTotal < threshold) continue
    map.set(it.tabIndex, (map.get(it.tabIndex) || 0) + it.chaosTotal)
  }
  return map
}

// Reconciles tabsOff with the active tabMode. 'all'/'none'/'valued' fully
// derive the selection (and get persisted); 'custom' leaves the user's own
// per-row choices untouched. Call whenever the snapshot or the threshold
// changes so 'valued' stays reactive (e.g. raising the threshold can drop a
// tab's thresholded value to 0, which then auto-unchecks it).
//
// Ignored tabs are excluded from all three derivations — they are already off
// via tabsIgnored, and keeping them out of tabsOff means un-ignoring a tab
// hands it back in whatever state the current mode says it should have.
function applyTabMode () {
  const s = currentSnapshot
  if (!s) return
  const tabs = (s.tabs || []).filter(t => !isTabIgnored(t))
  if (tabMode === 'all') {
    tabsOff = new Set()
  } else if (tabMode === 'none') {
    tabsOff = new Set(tabs.map(t => t.index))
  } else if (tabMode === 'valued') {
    const vals = computeTabValues(currentThresholdChaos())
    tabsOff = new Set(tabs.filter(t => !((vals.get(t.index) || 0) > 0)).map(t => t.index))
  }
  if (tabMode !== 'custom') saveTabsOff(tabsOff)
}
function updateTabModeButtons () {
  selAllBtn.classList.toggle('on', tabMode === 'all')
  selNoneBtn.classList.toggle('on', tabMode === 'none')
  selValuedBtn.classList.toggle('on', tabMode === 'valued')
}

// Sidebar display order (pure part in tabs.js): saved index order first, the
// rest by index.
function displayTabs (tabs) { return orderedTabs(tabs, loadOrder()) }

// index -> display label for the CURRENT snapshot, so the sidebar and the "Tab"
// column of the item table read the same for every row.
function tabLabelMap () {
  const m = new Map()
  for (const t of ((currentSnapshot && currentSnapshot.tabs) || [])) m.set(Number(t.index), tabLabel(t))
  return m
}
// An item row knows its tabIndex; the label comes from the snapshot's tab list,
// falling back to the name stored on the row itself.
function itemTabLabel (it, labels) {
  const l = labels.get(Number(it.tabIndex))
  return l != null ? l : tabLabel({ name: it.tab, index: it.tabIndex })
}

// ---- App state (transient — resets on reload except where persisted) -------
const st = { view: loadView(), q: '', kinds: new Set(), sortK: 'chaosTotal', sortDir: -1 }
let currentSnapshot = null
let dragSrc = null

viewSeg.querySelectorAll('button[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === st.view))
if (threshSel) threshSel.value = loadThreshold()
updateTabModeButtons()

// ---- Sidebar: stash-tab picker ----------------------------------------------
// A row cycles on -> off -> ignored -> on. The mark is drawn by us rather than
// by a native checkbox: a checkbox has two clickable states, and its third
// (indeterminate) one cannot be reached by clicking at all.
const TAB_STATE_MARK = { on: '✓', off: '', ignored: '✕' }
const TAB_STATE_HINT = {
  on: 'counted. Click to exclude.',
  off: 'excluded, but All / None / Only w/ value may switch it back on. Click to ignore it permanently.',
  ignored: 'permanently ignored — All / None / Only w/ value leave it alone. Click to count it again.'
}

function renderSide () {
  updateTabModeButtons()
  const tabs = (currentSnapshot && currentSnapshot.tabs) || []
  const disp = displayTabs(tabs)
  const vals = computeTabValues(currentThresholdChaos())
  const onCount = disp.filter(isTabOn).length
  const ignCount = disp.filter(isTabIgnored).length
  sideCountEl.textContent = disp.length
    ? `${onCount}/${disp.length}${ignCount ? ` · ${ignCount} ignored` : ''}`
    : ''
  tabListEl.innerHTML = disp.length
    ? disp.map(t => {
        const st = stateOf(t)
        const val = vals.get(t.index) || 0
        const label = tabLabel(t)
        return `<div class="tabrow st-${st}" draggable="true" data-idx="${esc(t.index)}"` +
          ` role="button" tabindex="0" title="${esc(label)} — ${esc(TAB_STATE_HINT[st])}">` +
          `<span class="dragh" aria-hidden="true">⋮⋮</span>` +
          `<span class="tri" data-tab="${esc(t.index)}" aria-hidden="true">${TAB_STATE_MARK[st]}</span>` +
          `<span class="tn">${esc(label)}</span>` +
          `<span class="tv">${moneyShort(val, currentSnapshot.cdRatio)}</span></div>`
      }).join('')
    : '<p class="sidetip">No tabs with priced items yet.</p>'
  resetOrderBtn.hidden = loadOrder().length === 0
}

// One click anywhere on the row advances its state. Switching to 'ignored'
// keeps tabMode as it is — ignoring a tab is not a manual pick of the others,
// so All/None/Only-w-value stay highlighted and keep governing the rest.
function cycleTab (idx) {
  if (!Number.isFinite(idx)) return
  const next = nextTabState(tabState(idx, tabsOff, tabsIgnored))
  if (next === 'ignored') {
    tabsIgnored.add(idx); tabsOff.delete(idx)
  } else {
    tabsIgnored.delete(idx)
    if (next === 'off') tabsOff.add(idx); else tabsOff.delete(idx)
    tabMode = 'custom'
    saveTabMode(tabMode)
  }
  saveTabsIgnored(tabsIgnored)
  saveTabsOff(tabsOff)
  const hadFocus = document.activeElement && document.activeElement.closest &&
    document.activeElement.closest('.tabrow')
  renderSide(); render()
  // renderSide() rebuilds the list via innerHTML, which drops focus — put it
  // back on the same row so the keyboard can cycle a tab more than once.
  if (hadFocus) {
    const back = tabListEl.querySelector(`.tabrow[data-idx="${CSS.escape(String(idx))}"]`)
    if (back) back.focus()
  }
}
tabListEl.addEventListener('click', e => {
  const row = e.target.closest('.tabrow')
  if (row) cycleTab(Number(row.dataset.idx))
})
tabListEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const row = e.target.closest('.tabrow')
  if (!row) return
  e.preventDefault()
  cycleTab(Number(row.dataset.idx))
})
tabListEl.addEventListener('dragstart', e => {
  const row = e.target.closest('.tabrow')
  if (!row) return
  dragSrc = Number(row.dataset.idx)
  row.classList.add('dragging')
  e.dataTransfer.effectAllowed = 'move'
})
tabListEl.addEventListener('dragend', e => {
  const row = e.target.closest('.tabrow')
  if (row) row.classList.remove('dragging')
})
tabListEl.addEventListener('dragover', e => { if (dragSrc) e.preventDefault() })
tabListEl.addEventListener('drop', e => {
  e.preventDefault()
  const row = e.target.closest('.tabrow')
  const src = dragSrc
  dragSrc = null
  if (!row || !Number.isFinite(src)) return
  const dst = Number(row.dataset.idx)
  if (dst === src) return
  const tabs = (currentSnapshot && currentSnapshot.tabs) || []
  const order = displayTabs(tabs).map(t => Number(t.index))
  const from = order.indexOf(src)
  if (from === -1) return
  order.splice(from, 1)
  const to = order.indexOf(dst)
  order.splice(to === -1 ? order.length : to, 0, src)
  saveOrder(order)
  renderSide()
})

function setTabMode (mode) {
  tabMode = mode
  saveTabMode(tabMode)
  applyTabMode()
  renderSide(); render()
}
selAllBtn.addEventListener('click', () => setTabMode('all'))
selNoneBtn.addEventListener('click', () => setTabMode('none'))
selValuedBtn.addEventListener('click', () => setTabMode('valued'))
resetOrderBtn.addEventListener('click', () => { try { localStorage.removeItem(ORDER_KEY) } catch { /* ignore */ } renderSide() })

// ---- Overview bars (category share of TOTAL net worth, independent of filters) --
// Headline numbers and category bars follow the TAB selection — the sidebar
// promises "Uncheck a tab to exclude it from the totals". The category chip,
// the search and the value threshold, in contrast, filter ONLY the table,
// otherwise the overview would always be a copy of the currently filtered view.
// With every tab on, the server totals apply unchanged (no rounding drift).
function tabScoped (s) {
  const on = onTabIndexSet(s)
  const off = (s.tabs || []).filter(t => !on.has(t.index))
  if (!off.length) {
    return {
      totalChaos: Number(s.totalChaos) || 0,
      totalDivine: Number(s.totalDivine) || 0,
      categories: s.categories || {}
    }
  }
  const categories = {}
  let totalChaos = 0
  for (const it of (s.items || [])) {
    if (!on.has(it.tabIndex)) continue
    totalChaos += it.chaosTotal
    ;(categories[it.kind] ||= { chaos: 0 }).chaos += it.chaosTotal
  }
  const cd = Number(s.cdRatio) > 0 ? Number(s.cdRatio) : 0
  return { totalChaos, totalDivine: cd ? totalChaos / cd : 0, categories }
}

function renderBars () {
  const s = currentSnapshot
  if (!s) { barsEl.innerHTML = ''; return }
  const scoped = tabScoped(s)
  const cats = Object.entries(scoped.categories).sort((a, b) => b[1].chaos - a[1].chaos)
  const total = scoped.totalChaos || cats.reduce((sum, [, v]) => sum + v.chaos, 0) || 1
  barsEl.innerHTML = cats.length
    ? cats.map(([k, v]) => {
        const pct = total > 0 ? (v.chaos / total * 100) : 0
        return `<div class="bar"><div class="l"><span>${esc(KIND_LABEL[k] || cap(k))}</span>` +
          `<b>${moneyShort(v.chaos, s.cdRatio)} <span class="pct">${pct.toFixed(pct < 10 ? 1 : 0)}%</span></b></div>` +
          `<div class="track"><div class="fill" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div></div>`
      }).join('')
    : '<div class="empty">nothing priced yet</div>'
}
ovToggle.addEventListener('click', () => overviewEl.classList.toggle('closed'))

// ---- Kind filter chips -------------------------------------------------------
function renderChips () {
  const items = (currentSnapshot && currentSnapshot.items) || []
  const presentSet = new Set(items.map(i => i.kind))
  const present = [...CAT_ORDER.filter(k => presentSet.has(k)), ...[...presentSet].filter(k => !CAT_ORDER.includes(k))]
  chipsEl.innerHTML = `<button type="button" class="chip ${st.kinds.size === 0 ? 'on' : ''}" data-k="">All</button>` +
    present.map(k => `<button type="button" class="chip ${st.kinds.has(k) ? 'on' : ''}" data-k="${esc(k)}">${esc(KIND_LABEL[k] || cap(k))}</button>`).join('')
}
chipsEl.addEventListener('click', e => {
  const b = e.target.closest('.chip')
  if (!b) return
  const k = b.dataset.k
  if (!k) st.kinds.clear(); else { st.kinds.has(k) ? st.kinds.delete(k) : st.kinds.add(k) }
  renderChips(); render()
})

// ---- View toggle / search / threshold ---------------------------------------
viewSeg.addEventListener('click', e => {
  const b = e.target.closest('button[data-v]')
  if (!b) return
  st.view = b.dataset.v
  saveView(st.view)
  viewSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b))
  render()
})
searchInput.addEventListener('input', () => { st.q = searchInput.value.trim().toLowerCase(); render() })
if (threshSel) {
  // Threshold is a GLOBAL filter: it recomputes the sidebar tab values, and —
  // while tabMode is 'valued' — the tab selection itself (tabs whose
  // thresholded value drops to 0 get auto-unchecked), before the main list
  // re-renders. All three stay in sync on every change, in either order.
  threshSel.addEventListener('change', () => {
    saveThreshold(threshSel.value)
    if (tabMode === 'valued') applyTabMode()
    renderSide()
    render()
  })
}

// ---- Filtering ----------------------------------------------------------------
function onTabIndexSet (s) {
  const set = new Set()
  for (const t of (s.tabs || [])) if (isTabOn(t)) set.add(t.index)
  return set
}
function currentThresholdChaos () {
  const s = currentSnapshot
  return thresholdChaos(threshSel ? threshSel.value : THRESH_DEFAULT, s ? s.cdRatio : 0)
}
function passesTabKindSearch (it, tabIdxOn) {
  if (!tabIdxOn.has(it.tabIndex)) return false
  if (st.kinds.size && !st.kinds.has(it.kind)) return false
  if (st.q && !String(it.name).toLowerCase().includes(st.q)) return false
  return true
}
function filteredItems () {
  const s = currentSnapshot
  if (!s) return []
  const tabIdxOn = onTabIndexSet(s)
  const th = currentThresholdChaos()
  return (s.items || []).filter(it => passesTabKindSearch(it, tabIdxOn) && it.chaosTotal >= th)
}
function hiddenBelowThreshold () {
  const s = currentSnapshot
  if (!s) return 0
  const tabIdxOn = onTabIndexSet(s)
  const th = currentThresholdChaos()
  return (s.items || []).filter(it => passesTabKindSearch(it, tabIdxOn) && it.chaosTotal < th).length
}

// ---- List view ----------------------------------------------------------------
const COLS = [['name', 'Item', ''], ['tab', 'Tab', ''], ['qty', 'Qty', 'r'], ['chaosEach', 'Each', 'r'], ['chaosTotal', 'Total', 'r']]
function renderList (rows) {
  const s = currentSnapshot
  const labels = tabLabelMap()
  const th = COLS.map(([k, l, align]) =>
    `<th class="${align}" data-k="${k}">${esc(l)}${st.sortK === k ? `<span class="ar">${st.sortDir < 0 ? '▼' : '▲'}</span>` : ''}</th>`).join('')
  const body = rows.length
    ? rows.map(it => `<tr>` +
        `<td><span class="iname"><span class="kb ${esc(it.kind)}">${esc(KIND_LABEL[it.kind] || it.kind)}</span>${esc(it.name)}${tradeBtn(it.name, it.kind, s.league)}</span></td>` +
        `<td class="tabcell">${esc(itemTabLabel(it, labels))}</td>` +
        `<td class="r">${fmtC(it.qty)}</td>` +
        `<td class="r">${money(it.chaosEach, s.cdRatio)}</td>` +
        `<td class="r">${money(it.chaosTotal, s.cdRatio)}</td>` +
      `</tr>`).join('')
    : '<tr><td colspan="5" class="empty">No items match the current filters.</td></tr>'
  wrapEl.innerHTML = `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`
}

// ---- Grouped view (category -> items, drill-down) ------------------------------
function renderGrouped (rows) {
  const s = currentSnapshot
  const labels = tabLabelMap()
  const cats = {}
  rows.forEach(it => (cats[it.kind] = cats[it.kind] || []).push(it))
  const presentSet = new Set(Object.keys(cats))
  const order = [...CAT_ORDER.filter(k => presentSet.has(k)), ...[...presentSet].filter(k => !CAT_ORDER.includes(k))]
  if (!order.length) { wrapEl.innerHTML = '<div class="empty">No items match the current filters.</div>'; return }
  // rows arrive already sorted by the active column (st.sortK/sortDir, applied in
  // render()); bucketing by kind preserves that order, so each group follows the
  // same column sort — no per-group re-sort.
  const gth = COLS.map(([kk, l, align]) =>
    `<th class="${align}" data-k="${kk}">${esc(l)}${st.sortK === kk ? `<span class="ar">${st.sortDir < 0 ? '▼' : '▲'}</span>` : ''}</th>`).join('')
  wrapEl.innerHTML = order.map((k, idx) => {
    const g = cats[k]
    const tot = g.reduce((sum, it) => sum + it.chaosTotal, 0)
    const qtySum = g.reduce((sum, it) => sum + it.qty, 0)
    const body = g.map(it => `<tr>` +
      `<td><span class="iname">${esc(it.name)}${tradeBtn(it.name, it.kind, s.league)}</span></td>` +
      `<td class="tabcell">${esc(itemTabLabel(it, labels))}</td>` +
      `<td class="r">${fmtC(it.qty)}</td>` +
      `<td class="r">${money(it.chaosEach, s.cdRatio)}</td>` +
      `<td class="r">${money(it.chaosTotal, s.cdRatio)}</td>` +
    `</tr>`).join('')
    return `<div class="grp ${isGroupClosed(k, idx) ? 'closed' : ''}" data-kind="${esc(k)}"><div class="grph">` +
      `<span class="chev">▾</span><span class="gtitle">${esc(KIND_LABEL[k] || cap(k))}</span>` +
      `<span class="gcount">${fmtC(g.length)} items · ${fmtC(qtySum)} pcs</span>` +
      `<span class="gval">${money(tot, s.cdRatio)}</span></div>` +
      `<div class="grpbody"><table><thead><tr>${gth}</tr></thead><tbody>${body}</tbody></table></div></div>`
  }).join('')
}

// Delegated clicks inside #wrap: column sort (list + grouped) and group collapse.
// Per-item trade links are native <a> — they navigate on their own.
wrapEl.addEventListener('click', e => {
  const th = e.target.closest('thead th[data-k]')
  if (th) {
    const k = th.dataset.k
    st.sortDir = st.sortK === k ? -st.sortDir : -1
    st.sortK = k
    render()
    return
  }
  const grph = e.target.closest('.grph')
  if (grph) {
    // Toggle in place (no re-render, so the clicked element stays in the
    // document) and persist by KIND so the next snapshot render keeps it.
    const grp = grph.parentElement
    const closed = grp.classList.toggle('closed')
    if (grp.dataset.kind) { groupsClosed[grp.dataset.kind] = closed; saveGroupsClosed(groupsClosed) }
  }
})

// ---- Stash-Highlight ------------------------------------------------------------
// Turns the VISIBLE selection into a search string for the stash search field.
// Wanted = whatever is left after tab selection, chip, search and threshold.
//
// Unwanted is NOT "the rest of the snapshot". That is exactly where the first
// version failed: checked against your own holdings, fragments like "dis", "nb"
// or "nsta" looked unambiguous, yet in game they lit up ~14 slots instead of 9,
// because "... Scarab of Discernment/Unbreaking/Instability" exists for many
// prefixes the player does not own. Unwanted = ALL item names the game knows
// (GET /item-names), plus everything from the snapshot that this list does not
// know (unpriced entries, new bases). Costs characters, but it is correct.
let itemNameUniverse = null   // string[] | null (not loaded yet)
let itemNamesRequested = false

function ensureItemNames () {
  if (itemNameUniverse || itemNamesRequested) return
  itemNamesRequested = true
  fetch('/item-names')
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      if (!Array.isArray(j?.names) || !j.names.length) return
      itemNameUniverse = j.names
      render()   // first pass ran on the snapshot alone -> redraw more precisely
    })
    .catch(() => { /* endpoint missing (old container) -> snapshot fallback stays */ })
}

function renderHighlight (rows) {
  if (hlBox.hidden) return
  const s = currentSnapshot
  if (!s) return
  ensureItemNames()
  const wantedNames = rows.map(r => r.name)
  const wantedSet = new Set(wantedNames.map(n => String(n).toLowerCase()))
  const universe = new Set(itemNameUniverse || [])
  for (const it of (s.items || [])) universe.add(it.name)
  for (const u of (s.unpriced || [])) universe.add(u.name)
  const unwanted = [...universe].filter(n => n && !wantedSet.has(String(n).toLowerCase()))
  const maxLen = Math.max(10, Number(hlMax.value) || HIGHLIGHT_MAX_DEFAULT)
  const r = buildHighlight(wantedNames, unwanted, { maxLen })

  hlText.value = r.text
  hlCopy.disabled = !r.text
  hlMeta.textContent = r.text
    ? `${fmtC(r.used.length)}/${fmtC(r.used.length + r.dropped.length)} items · ${r.length}/${maxLen} chars`
    : 'nothing selected — adjust the filters'

  // No silent truncation: what did not fit and what inevitably matches too much
  // is spelled out. Otherwise the regex reads as "covers everything".
  const lines = []
  if (r.dropped.length) lines.push(`<b>${fmtC(r.dropped.length)} no longer fit:</b> ${esc(r.dropped.join(', '))}`)
  if (r.overmatching.length) lines.push(`<b>unavoidably matches similar items too:</b> ${esc(r.overmatching.join(', '))}`)
  hlWarn.innerHTML = lines.join('<br>')
  hlWarn.hidden = !lines.length
}

hlToggle.addEventListener('click', () => {
  hlBox.hidden = !hlBox.hidden
  hlToggle.classList.toggle('on', !hlBox.hidden)
  render()
})
hlMax.addEventListener('input', () => render())
hlCopy.addEventListener('click', async () => {
  if (!hlText.value) return
  try {
    await navigator.clipboard.writeText(hlText.value)
    hlCopy.textContent = 'copied'
  } catch {
    // The clipboard API needs https OR localhost — over plain http on the LAN
    // it does not work. Then at least select the text, so Ctrl+C is enough.
    hlText.select()
    hlCopy.textContent = 'Ctrl+C'
  }
  setTimeout(() => { hlCopy.textContent = 'Copy' }, 1200)
})

// ---- Render driver --------------------------------------------------------------
function render () {
  const s = currentSnapshot
  if (!s) return
  const dir = st.sortDir
  const k = st.sortK
  const rows = filteredItems().sort((a, b) =>
    typeof a[k] === 'string' ? a[k].localeCompare(b[k]) * (-dir) : (a[k] - b[k]) * dir)
  const shownTotal = rows.reduce((sum, it) => sum + it.chaosTotal, 0)
  statEl.innerHTML = `<b>${fmtC(rows.length)}</b> items shown · <b>${money(shownTotal, s.cdRatio)}</b>`
  const hidden = hiddenBelowThreshold()
  statHiddenEl.textContent = hidden ? `${fmtC(hidden)} hidden below threshold` : ''
  if (st.view === 'list') renderList(rows); else renderGrouped(rows)
  renderUnpriced(s)
  // rows is sorted by the active column — with the default (total value
  // descending) the cheapest ones at the end are the ones dropped when space
  // runs short.
  renderHighlight(rows)
  // Headline numbers + bars depend on the tab selection -> redone on every render().
  const scoped = tabScoped(s)
  totalDivEl.innerHTML = `${fmt(scoped.totalDivine)}<u>div</u>`
  totalChaosEl.textContent = `${fmt(scoped.totalChaos)} c`
  renderBars()
}

// ---- Unpriced (grouped by name, collapsed by default via <details>) -------------
// Follows the same category/search filters as the table: with the "Gems" chip
// active, no divination cards may show up here. The tab filter does not apply —
// unpriced entries are aggregated by name and carry no tab membership.
function unpricedRows (s) {
  return (s.unpriced || []).filter(u =>
    (!st.kinds.size || st.kinds.has(u.kind)) &&
    (!st.q || String(u.name).toLowerCase().includes(st.q)))
}

function renderUnpriced (s) {
  const un = unpricedRows(s)
  unpricedBox.hidden = un.length === 0
  if (!un.length) return
  const filtered = st.kinds.size > 0 || st.q
  const totalUnpriced = filtered
    ? un.reduce((sum, u) => sum + u.count, 0)
    : (s.counts?.unpriced ?? un.reduce((sum, u) => sum + u.count, 0))
  unpricedSummary.textContent = `${fmtC(totalUnpriced)} unpriced items across ${fmtC(un.length)} names (not counted)`
  unpricedList.innerHTML = un.map(u => `<li>${esc(u.name)} ×${fmtC(u.count)} (${esc(KIND_LABEL[u.kind] || u.kind)})</li>`).join('')
}

// ---- Top-level snapshot rendering -----------------------------------------------
function showNoResult (msg) {
  shellEl.hidden = true
  if (sideBoxEl) sideBoxEl.hidden = true
  noResultEl.hidden = false
  noResultEl.textContent = msg || 'Building your snapshot in the background — this fills in automatically.'
}

function renderSnapshot (s) {
  if (!s) return
  currentSnapshot = s
  noResultEl.hidden = true
  shellEl.hidden = false
  if (sideBoxEl) sideBoxEl.hidden = false
  totalDivEl.innerHTML = `${fmt(s.totalDivine)}<u>div</u>`
  totalChaosEl.textContent = `${fmt(s.totalChaos)} c`

  // Name-keyed leftovers from before the index switch — needs a tab list to
  // resolve, so it happens here and not at module init.
  migrateTabKeys(s.tabs)
  // Reconcile the persisted tabMode against the (possibly new) tab set —
  // 'valued' must be recomputed per snapshot; 'all'/'none' too (new tabs may
  // have appeared); 'custom' is left untouched (user's own picks).
  applyTabMode()
  renderSide()
  renderBars()
  renderChips()
  render()
  renderAutoSync(s)
}

// Background auto-sync status line. Derived from snapshot.tabs[].syncedAt (the
// backend stamps each tab when the refresher syncs it). "Fresh" = synced within
// FRESH_MS — a purely cosmetic display threshold for this status line, not tied
// to any server config value.
const FRESH_MS = 10 * 60 * 1000
function renderAutoSync (s) {
  if (!autosyncEl) return
  // Plain text, no dot/prefix — the conn pill next to the title is the only
  // live indicator. Account, league + last scan hang on the title attribute
  // instead of taking up their own header block.
  const at = s && s.at ? new Date(s.at).toLocaleString() : ''
  const who = [s && s.accountName, s && s.league].filter(Boolean).join(' · ')
  autosyncEl.title = [who, at && `last scan ${at}`].filter(Boolean).join(' — ')
  const tabs = ((s && s.tabs) || []).filter(t => typeof t.syncedAt === 'number')
  if (!tabs.length) { autosyncEl.textContent = 'syncing in background'; return }
  const now = Date.now()
  const fresh = tabs.filter(t => now - t.syncedAt < FRESH_MS).length
  const oldest = tabs.reduce((m, t) => Math.min(m, t.syncedAt), Infinity)
  const mins = Math.max(0, Math.round((now - oldest) / 60000))
  autosyncEl.textContent = `${fresh}/${tabs.length} tabs fresh · oldest synced ${mins} min ago`
}

function renderHistory (items) {
  historyBox.hidden = !items.length
  historyList.innerHTML = items.slice().reverse().map(h =>
    `<li>${esc(new Date(h.at).toLocaleString())} — ${fmt(h.totalDivine)} div (${fmt(h.totalChaos)}c) · ${esc(h.league)}</li>`).join('')
}

function renderError (message) {
  errBox.hidden = false
  errBox.textContent = message
}

// ---- Sync status (M2 status line) + sync-settings dialog --------------------
// The server sends `networth-sync-status` on connect and whenever the
// refresher's state for this user changes (auth pause, cooldown, renewal).
// The stored POESESSID never travels in any of these messages.
const appStatusEl = document.getElementById('appStatus')
const settingsBtn = document.getElementById('settingsBtn')
const setGate     = document.getElementById('setGate')
const setState    = document.getElementById('setState')
const setAccount  = document.getElementById('setAccount')
const setSessid   = document.getElementById('setSessid')
const setHint     = document.getElementById('setHint')
const setErr      = document.getElementById('setErr')
const setCancel   = document.getElementById('setCancel')
const setSave     = document.getElementById('setSave')

let syncStatus = null       // last { state, until? } from the server
let cooldownTimer = null    // clears the "rate-limited" line once `until` passes

function statusLineText (st) {
  if (!st) return ''
  if (st.state === 'expired') return 'POESESSID expired — background sync paused. Open settings to renew.'
  if (st.state === 'cooldown') {
    const at = st.until ? new Date(st.until).toLocaleTimeString() : 'soon'
    return `Rate-limited by GGG — sync resumes at ${at}.`
  }
  if (st.state === 'missing') return 'No credentials configured — open settings to add them.'
  return '' // ok -> the slot stays empty and collapses
}

function applySyncStatus (st) {
  syncStatus = st
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null }
  const text = statusLineText(st)
  // Keyed: the M2 slot is shared with the data auto-update note, so only OUR
  // message is written or removed here (see shell.js STATUS_ORDER).
  window.Shell.setStatus(text, 'sync')
  // A cooldown ends by time passing, without a server push — clear the line
  // on its own once `until` elapses (the next real status still overrides).
  if (st && st.state === 'cooldown' && st.until) {
    const wait = Math.max(1000, st.until - Date.now() + 1000)
    cooldownTimer = setTimeout(() => { if (syncStatus && syncStatus.state === 'cooldown') applySyncStatus({ state: 'ok' }) }, wait)
  }
  if (!setGate.hidden) renderSettingsState()
}

function settingsStateText (st) {
  if (!st) return 'Background sync: state unknown.'
  if (st.state === 'expired') return 'Background sync is paused — the stored POESESSID has expired. Paste a new one below.'
  if (st.state === 'cooldown') {
    const at = st.until ? new Date(st.until).toLocaleTimeString() : 'soon'
    return `Background sync is rate-limited by GGG and resumes at ${at}. Credentials are fine.`
  }
  if (st.state === 'missing') return 'No credentials configured for this user yet. Enter account name and POESESSID to start syncing.'
  return 'Background sync is running.'
}

function renderSettingsState () {
  setState.textContent = settingsStateText(syncStatus)
  setState.classList.toggle('warn', !!syncStatus && syncStatus.state !== 'ok')
}

// Non-blocking plausibility hint (NO hard format check — if GGG changes the
// cookie format, the field must keep working). Live sessions have been 32 hex
// chars for years; anything else is most likely a paste accident.
function renderSessidHint () {
  const v = setSessid.value.trim()
  const odd = v.length > 0 && v.length !== 32
  setHint.hidden = !odd
  setHint.textContent = odd
    ? `Heads-up: this value is ${v.length} characters — POESESSID cookies are usually 32. Saving is still allowed.`
    : ''
}
setSessid.addEventListener('input', renderSessidHint)

function openSettings () {
  setErr.hidden = true; setErr.textContent = ''
  setSessid.value = ''            // ALWAYS empty — the stored value is never shown
  renderSessidHint()
  setAccount.value = ''
  renderSettingsState()
  setGate.hidden = false
  // Current accountName (never the poesessid) + fresh state from the server.
  fetch('/networth/credentials')
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      if (!j || setGate.hidden) return
      if (j.accountName && !setAccount.value) setAccount.value = j.accountName
      if (j.status) applySyncStatus(j.status)
    })
    .catch(() => { /* dialog still usable — save reports its own errors */ })
  setAccount.focus()
}

function closeSettings () { setGate.hidden = true }

async function saveSettings () {
  setErr.hidden = true; setErr.textContent = ''
  setSave.disabled = true
  try {
    const r = await fetch('/networth/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountName: setAccount.value, poesessid: setSessid.value })
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) {
      setErr.textContent = (j && j.error) ? j.error : `Saving failed (HTTP ${r.status}).`
      setErr.hidden = false
      return
    }
    setSessid.value = ''          // never keep the value around after a save
    renderSessidHint()
    if (j && j.status) applySyncStatus(j.status)
    closeSettings()
  } catch {
    setErr.textContent = 'Saving failed — server not reachable.'
    setErr.hidden = false
  } finally {
    setSave.disabled = false
  }
}

if (settingsBtn) settingsBtn.addEventListener('click', openSettings)
// The status line is the other opener — but ONLY its sync message: every state
// that one shows is fixed in the settings dialog. The data auto-update note in
// the same slot is informational and must not open anything.
if (appStatusEl) {
  appStatusEl.addEventListener('click', e => {
    const hit = e.target && e.target.closest ? e.target.closest('[data-status-key]') : null
    if (hit && hit.dataset.statusKey !== 'sync') return
    if (statusLineText(syncStatus)) openSettings()
  })
}
setCancel.addEventListener('click', closeSettings)
setSave.addEventListener('click', saveSettings)
setGate.addEventListener('click', e => { if (e.target === setGate) closeSettings() })
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !setGate.hidden) closeSettings() })
setSessid.addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings() })
setAccount.addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings() })

// ---- Identity (multi-user routing, no login) ------------------------------
const idgate     = document.getElementById('idgate')
const idbtns     = document.getElementById('idbtns')
const whoami     = document.getElementById('whoami')
const whoamiName = document.getElementById('whoamiName')

let USERS = ['player1', 'player2']
let currentUser = null

function readCookie (name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : null
}
function setUserCookie (u) { document.cookie = 'ppt_user=' + encodeURIComponent(u) + '; path=/; max-age=31536000; samesite=lax' }
function clearUserCookie () { document.cookie = 'ppt_user=; path=/; max-age=0; samesite=lax' }
function showWhoami (u) { if (!whoami) return; whoamiName.textContent = u; whoami.hidden = false }
function showIdGate () {
  if (!idgate) return
  idbtns.innerHTML = USERS.map(u => `<button type="button" data-user="${esc(u)}">${esc(cap(u))}</button>`).join('')
  idgate.hidden = false
}
function hideIdGate () { if (idgate) idgate.hidden = true }
function pickUser (u) {
  if (!USERS.includes(u)) return
  currentUser = u
  setUserCookie(u); hideIdGate(); showWhoami(u)
  if (ws) { try { ws.close() } catch {} ws = null }
  connect()
}
if (idbtns) idbtns.addEventListener('click', e => {
  const b = e.target.closest('button[data-user]')
  if (b) pickUser(b.dataset.user)
})
if (whoami) whoami.addEventListener('click', () => { clearUserCookie(); currentUser = null; showIdGate() })

async function initIdentity () {
  try {
    const r = await fetch('/users')
    const j = await r.json()
    if (Array.isArray(j.users) && j.users.length) USERS = j.users
    if (j.appName) window.Shell.applyBrand(j.appName, 'Net Worth')
  } catch { /* keep fallback list + fallback brand */ }
  const cookie = readCookie('ppt_user')
  if (cookie && USERS.includes(cookie)) { currentUser = cookie; showWhoami(cookie); connect() }
  else showIdGate()
}

// ---- WebSocket -------------------------------------------------------------
let ws = null
let retry = 0

function sendSafe (obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)) }
function setConn (state, label) { conn.className = 'conn ' + state; connlbl.textContent = label }

function connect () {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${proto}//${location.host}/events`)
  ws.addEventListener('open', () => {
    retry = 0; setConn('live', 'live')
    sendSafe({ type: 'networth-history' })
  })
  ws.addEventListener('close', () => {
    setConn('down', 'reconnecting…')
    retry = Math.min(retry + 1, 6)
    setTimeout(connect, 400 * retry)
  })
  ws.addEventListener('error', () => { try { ws.close() } catch {} })

  ws.addEventListener('message', ev => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    switch (msg.type) {
      case 'networth-latest':
        if (msg.snapshot) renderSnapshot(msg.snapshot)
        else showNoResult()
        break
      case 'networth-result':
        // Render the snapshot whenever one is present — including the PARTIAL
        // snapshot sent on an aborted scan (msg.partial + msg.error). Then show
        // the error as a note on top, so the already-scanned tabs are visible
        // immediately instead of only on the next reconnect.
        if (msg.snapshot) { renderSnapshot(msg.snapshot); sendSafe({ type: 'networth-history' }) }
        if (msg.error) renderError(msg.error)
        break
      case 'networth-history':
        renderHistory(msg.items || [])
        break
      case 'networth-sync-status':
        applySyncStatus({ state: msg.state, until: msg.until })
        break
      case 'cd-ratio':     window.Shell.applyCdRatio(msg); break     // global rail tile
      case 'league-state': window.Shell.applyLeagueState(msg); break // global rail slot
      case 'data-status':  window.Shell.applyDataStatus(msg); break  // M2 data freshness
      case 'need-identity':
        if (Array.isArray(msg.users) && msg.users.length) USERS = msg.users
        if (whoami) whoami.hidden = true
        showIdGate()
        break
      default: break // reference/queue-status/... — irrelevant here
    }
  })
}

window.Shell.initLeague(obj => sendSafe(obj))

initIdentity()
