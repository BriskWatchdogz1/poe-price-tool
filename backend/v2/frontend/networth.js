import { buildHighlight, highlightInputs, HIGHLIGHT_MAX_DEFAULT } from './highlight.js'
import { syncStatusLine, syncLineText, autosyncSummary } from './networth-sync.js'
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
 *   snapshot.tabs[]   = { index, name, chaos, items, priced, unpriced, unpricedPieces, skipped }
 *                       (sorted by index = in-game order)
 *   snapshot.categories = { kind: { chaos, items } }
 *   snapshot.unpriced[] = { name, kind, count, tabIndex }  (one row per name+tab)
 *   snapshot.belowMarket = { rows: [...], more: n, notCompared: { reason: n } }
 *                       ("Listed below market", see PROTOCOL.md)
 * Units are NOT interchangeable: `items` counts grouped display ROWS,
 * `priced`/`unpriced`/`skipped` count GGG stash ENTRIES, and `count`/`qty`/
 * `unpricedPieces` count PIECES (summed stack sizes). Never print two of them
 * under one word. */
'use strict'

// ---- DOM handles -----------------------------------------------------------
const errBox        = document.getElementById('errBox')
const noResultEl     = document.getElementById('noResult')
const shellEl        = document.getElementById('shell')
const sideBoxEl      = document.getElementById('sideBox')   // rail R6 block (tab picker)
const totalDivEl     = document.getElementById('totalDiv')
const totalChaosEl   = document.getElementById('totalChaos')
const totalUncEl     = document.getElementById('totalUncertain')
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
const uncBtn         = document.getElementById('uncOnly')
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
const belowBox        = document.getElementById('belowBox')
const belowBody       = document.querySelector('#belowList tbody')
const belowSkippedEl  = document.getElementById('belowSkipped')
const belowMoreEl     = document.getElementById('belowMore')
const historyBox      = document.getElementById('historyBox')
const historyList      = document.getElementById('historyList')

// ---- Helpers ---------------------------------------------------------------
const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s
// i18n shorthands — i18n.js is a classic script loaded before this module.
const I18n = window.I18n
const T = (k, p) => I18n.t(k, p)
// Plural pick (key + One/Other) — a count of one must not read "1 names".
const TN = (k, n, p) => I18n.tn(k, n, p)
// An item name to PRINT. Every row on this page travels under its ENGLISH
// reference name — that is what the value join, the trade link and the
// Stash-Highlight token generator are keyed by — so the translation happens
// here, at the last possible moment, and nowhere else. No hit -> English.
const INAME = n => I18n.itemName(n) || n
// Search matches what the user READS as well as what the row is keyed by: on a
// German page, typing the German name has to find the row.
const nameHit = (n, q) => String(n).toLowerCase().includes(q) || String(INAME(n)).toLowerCase().includes(q)
// Number formatting follows the language, not the browser's locale.
const fmt = n => Number(n ?? 0).toLocaleString(I18n.locale())
// Rounding to whole chaos turns every cheap currency into a bare "0 c" — an
// Armourer's Scrap at 0.15c read as worthless even though 27 of them are 4c.
// Below 1c keep enough precision to stay meaningful; from 1c up, whole numbers.
const fmtC = (n) => {
  const v = Number(n) || 0
  if (v !== 0 && Math.abs(v) < 1) {
    return v.toLocaleString(I18n.locale(), { minimumFractionDigits: 1, maximumFractionDigits: Math.abs(v) < 0.1 ? 3 : 2 })
  }
  return Math.round(v).toLocaleString(I18n.locale())
}

const CAT_ORDER = ['unique', 'stackable', 'divcard', 'gem', 'beast', 'incubator', 'vial', 'corpse']
// Category names. A kind the snapshot carries but this list does not know
// (a new backend category) falls back to its raw id — visible, not hidden.
const kindLabel = k => CAT_ORDER.includes(k) ? T('kind.' + k) : cap(k)

function money (v, cdRatio) {
  const n = Number(v) || 0
  if (cdRatio > 0 && n >= cdRatio) {
    return `<span class="val div">${(n / cdRatio).toLocaleString(I18n.locale(), { maximumFractionDigits: 1 })}<span class="u"> div</span></span>`
  }
  return `<span class="val">${fmtC(n)}<span class="u"> c</span></span>`
}
function moneyShort (v, cdRatio) {
  const n = Number(v) || 0
  if (cdRatio > 0 && n >= cdRatio) return `${(n / cdRatio).toLocaleString(I18n.locale(), { maximumFractionDigits: n / cdRatio >= 100 ? 0 : 1 })}d`
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
  return `<a class="tradebtn" href="${esc(tradeUrl(name, kind, league))}" target="_blank" rel="noopener noreferrer" title="${esc(T('nw.tradeTitle'))}">${TRADE_ICON}</a>`
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
const st = { view: loadView(), q: '', kinds: new Set(), uncOnly: false, sortK: 'chaosTotal', sortDir: -1 }
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
const tabStateHint = st => T({ on: 'nw.tabHintOn', off: 'nw.tabHintOff', ignored: 'nw.tabHintIgnored' }[st])

// What actually came out of this tab, for the row's tooltip. Without it a tab
// worth 0c reads the same whether GGG returned nothing at all or returned a
// full tab that the classifier dropped (rare gear, non-unique maps), and an
// empty map stash cannot be judged from this page. The three counts come
// straight from the per-tab store (backend counts.*), so "0 priced · 0
// unpriced · 0 skipped" says "nothing arrived" outright.
// All three are GGG ENTRY counts and have to stay comparable. `t.priced` is the
// stored one; `t.items` beside it counts grouped display ROWS (thirty Divine
// Orbs from three stash entries are one row), and printing that next to two
// entry counts made a full currency tab read "1 priced · 0 unpriced · 0
// skipped". Older snapshots carry only `items` — then it is still the best
// number available.
function tabPricedCount (t) { return Number(t.priced ?? t.items) || 0 }
function tabCountsHint (t) {
  const priced = tabPricedCount(t)
  const unpriced = Number(t.unpriced) || 0
  const skipped = Number(t.skipped) || 0
  if (!priced && !unpriced && !skipped) return T('nw.tabNothingArrived')
  return T('nw.tabCounts', { priced, unpriced, skipped })
}

// …and the same distinction WITHOUT hovering, for the two cases where the row
// is otherwise mute. Symbols only, no words: the row's title says it in the
// user's language, this just makes the two zero-value cases look different.
//   ∅   nothing arrived from this tab at all
//   ⨯N  N items arrived and were dropped by the classifier (rare gear, maps)
// Anything the tab actually contributed already shows as its value.
function tabZeroMark (t) {
  const priced = tabPricedCount(t)
  const unpriced = Number(t.unpriced) || 0
  const skipped = Number(t.skipped) || 0
  if (priced || unpriced) return ''
  if (skipped) return `<span class="tmark">⨯${fmtC(skipped)}</span>`
  return '<span class="tmark">∅</span>'
}

function renderSide () {
  updateTabModeButtons()
  const tabs = (currentSnapshot && currentSnapshot.tabs) || []
  const disp = displayTabs(tabs)
  const vals = computeTabValues(currentThresholdChaos())
  const onCount = disp.filter(isTabOn).length
  const ignCount = disp.filter(isTabIgnored).length
  sideCountEl.textContent = disp.length
    ? T('nw.sideCount', { on: onCount, total: disp.length }) + (ignCount ? T('nw.sideIgnored', { n: ignCount }) : '')
    : ''
  tabListEl.innerHTML = disp.length
    ? disp.map(t => {
        const st = stateOf(t)
        const val = vals.get(t.index) || 0
        const label = tabLabel(t)
        return `<div class="tabrow st-${st}" draggable="true" data-idx="${esc(t.index)}"` +
          ` role="button" tabindex="0" title="${esc(label)} — ${esc(tabCountsHint(t))} — ${esc(tabStateHint(st))}">` +
          `<span class="dragh" aria-hidden="true">⋮⋮</span>` +
          `<span class="tri" data-tab="${esc(t.index)}" aria-hidden="true">${TAB_STATE_MARK[st]}</span>` +
          `<span class="tn">${esc(label)}</span>` +
          tabZeroMark(t) +
          `<span class="tv">${moneyShort(val, currentSnapshot.cdRatio)}</span></div>`
      }).join('')
    : `<p class="sidetip">${esc(T('nw.noTabs'))}</p>`
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

// How much of the headline rests on rows marked uncertain. Scoped exactly like
// the headline — by the tab selection only, not by kind, search or threshold —
// so the two numbers stay comparable ("incl. X uncertain" is a part OF the
// total above it). Nothing is subtracted: the total counts these rows as well.
function uncertainScoped (s) {
  const on = onTabIndexSet(s)
  let c = 0
  for (const it of (s.items || [])) if (it.uncertain && on.has(it.tabIndex)) c += Number(it.chaosTotal) || 0
  return c
}
function renderUncertainTotal (s) {
  const u = uncertainScoped(s)
  totalUncEl.hidden = !(u > 0)
  totalUncEl.innerHTML = u > 0 ? T('nw.uncertainTotal_html', { value: money(u, s.cdRatio) }) : ''
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
        return `<div class="bar"><div class="l"><span>${esc(kindLabel(k))}</span>` +
          `<b>${moneyShort(v.chaos, s.cdRatio)} <span class="pct">${pct.toFixed(pct < 10 ? 1 : 0)}%</span></b></div>` +
          `<div class="track"><div class="fill" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div></div>`
      }).join('')
    : `<div class="empty">${esc(T('nw.nothingPriced'))}</div>`
}
ovToggle.addEventListener('click', () => overviewEl.classList.toggle('closed'))

// ---- "Uncertain only" -------------------------------------------------------
// Narrows the table — and with it Stash Highlight — to the rows to check in
// game before selling. The unpriced block is not touched: it has no price to
// doubt.
uncBtn.addEventListener('click', () => {
  st.uncOnly = !st.uncOnly
  uncBtn.classList.toggle('on', st.uncOnly)
  render()
})

// ---- Kind filter chips -------------------------------------------------------
function renderChips () {
  const items = (currentSnapshot && currentSnapshot.items) || []
  const presentSet = new Set(items.map(i => i.kind))
  const present = [...CAT_ORDER.filter(k => presentSet.has(k)), ...[...presentSet].filter(k => !CAT_ORDER.includes(k))]
  chipsEl.innerHTML = `<button type="button" class="chip ${st.kinds.size === 0 ? 'on' : ''}" data-k="">${esc(T('kind.all'))}</button>` +
    present.map(k => `<button type="button" class="chip ${st.kinds.has(k) ? 'on' : ''}" data-k="${esc(k)}">${esc(kindLabel(k))}</button>`).join('')
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
  if (st.q && !nameHit(it.name, st.q)) return false
  if (st.uncOnly && !it.uncertain) return false
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
// The SOURCE column names the feed a row's price came from (`faustus`,
// `exchange`, `exchange:DivinationCard`, `ninja:currency`, `item:<type>`,
// `corpse:trade`, `chaos`). The value has ridden along in the snapshot since
// the price guard needed it for its log line, but the page never showed it —
// so a wrong number on screen could not be traced to the feed that produced
// it without reading the store by hand. That is precisely what happened to the
// four divination cards of docs/bugs.md B20, whose source is unknown to this
// day. A row served by an older backend has no source and prints an em dash;
// the string itself is an identifier, not display text, so it is not
// translated (see nw.colSource in i18n.js).
const srcLabel = it => (typeof it.source === 'string' && it.source ? it.source : '—')
// The CONFIDENCE column answers "can I trust this number when I sell?": a row
// the valuation knows to rest on a guess or on thin trading names its reason
// (networth/valuator.mjs UNCERTAIN, explained in docs/pricing-logic.md), and
// its amounts take the warning colour. A row without a reason stays blank —
// that is "no KNOWN doubt", not a check, so nothing here ever says "ok". A
// code from a newer backend that this list does not know is shown raw, like
// kindLabel does with an unknown kind: visible, not hidden.
const UNC_CODES = ['thin-market', 'gem-guessed', 'variant-guessed', 'links-guessed', 'few-listings']
const uncLabel = c => UNC_CODES.includes(c) ? T('nw.unc.' + c) : c
const uncWhy = c => UNC_CODES.includes(c) ? T('nw.uncWhy.' + c) : ''
const uncCell = it => `<td class="unccell">${it.uncertain
  ? `<span class="unc" title="${esc(uncWhy(it.uncertain))}">${esc(uncLabel(it.uncertain))}</span>`
  : ''}</td>`
const uncV = it => (it.uncertain ? ' uncv' : '')
const COLS = [['name', 'nw.colItem', ''], ['tab', 'nw.colTab', ''], ['qty', 'nw.colQty', 'r'],
  ['chaosEach', 'nw.colEach', 'r'], ['chaosTotal', 'nw.colTotal', 'r'],
  ['uncertain', 'nw.colTrust', ''], ['source', 'nw.colSource', '']]
function renderList (rows) {
  const s = currentSnapshot
  const labels = tabLabelMap()
  const th = COLS.map(([k, l, align]) =>
    `<th class="${align}" data-k="${k}">${esc(T(l))}${st.sortK === k ? `<span class="ar">${st.sortDir < 0 ? '▼' : '▲'}</span>` : ''}</th>`).join('')
  const body = rows.length
    ? rows.map(it => `<tr>` +
        `<td><span class="iname"><span class="kb ${esc(it.kind)}">${esc(kindLabel(it.kind))}</span>${esc(INAME(it.name))}${tradeBtn(it.name, it.kind, s.league)}</span></td>` +
        `<td class="tabcell">${esc(itemTabLabel(it, labels))}</td>` +
        `<td class="r">${fmtC(it.qty)}</td>` +
        `<td class="r${uncV(it)}">${money(it.chaosEach, s.cdRatio)}</td>` +
        `<td class="r${uncV(it)}">${money(it.chaosTotal, s.cdRatio)}</td>` +
        uncCell(it) +
        `<td class="srccell">${esc(srcLabel(it))}</td>` +
      `</tr>`).join('')
    : `<tr><td colspan="${COLS.length}" class="empty">${esc(T('nw.noMatch'))}</td></tr>`
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
  if (!order.length) { wrapEl.innerHTML = `<div class="empty">${esc(T('nw.noMatch'))}</div>`; return }
  // rows arrive already sorted by the active column (st.sortK/sortDir, applied in
  // render()); bucketing by kind preserves that order, so each group follows the
  // same column sort — no per-group re-sort.
  const gth = COLS.map(([kk, l, align]) =>
    `<th class="${align}" data-k="${kk}">${esc(T(l))}${st.sortK === kk ? `<span class="ar">${st.sortDir < 0 ? '▼' : '▲'}</span>` : ''}</th>`).join('')
  wrapEl.innerHTML = order.map((k, idx) => {
    const g = cats[k]
    const tot = g.reduce((sum, it) => sum + it.chaosTotal, 0)
    const qtySum = g.reduce((sum, it) => sum + it.qty, 0)
    const body = g.map(it => `<tr>` +
      `<td><span class="iname">${esc(INAME(it.name))}${tradeBtn(it.name, it.kind, s.league)}</span></td>` +
      `<td class="tabcell">${esc(itemTabLabel(it, labels))}</td>` +
      `<td class="r">${fmtC(it.qty)}</td>` +
      `<td class="r${uncV(it)}">${money(it.chaosEach, s.cdRatio)}</td>` +
      `<td class="r${uncV(it)}">${money(it.chaosTotal, s.cdRatio)}</td>` +
      uncCell(it) +
      `<td class="srccell">${esc(srcLabel(it))}</td>` +
    `</tr>`).join('')
    return `<div class="grp ${isGroupClosed(k, idx) ? 'closed' : ''}" data-kind="${esc(k)}"><div class="grph">` +
      `<span class="chev">▾</span><span class="gtitle">${esc(kindLabel(k))}</span>` +
      `<span class="gcount">${esc(T('nw.groupCount', { items: fmtC(g.length), pcs: fmtC(qtySum) }))}</span>` +
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
//
// The names in it are the GAME CLIENT's, not the page's (B10). This block is
// the one place on the page whose output is not read by a human: it is pasted
// into the game's stash search, which matches the names the client PRINTS. So
// it does not use INAME (the display table of GET /item-name-map) — it uses its
// own answer from GET /item-names, which the server builds for the language the
// game runs in. Same configured value today, a different question, and a
// different failure mode: getting it wrong highlights the wrong stash slots and
// can never touch a price.
//
// Both halves move together or not at all. Localizing the WANTED names while
// leaving the universe English would shorten each name against the wrong
// universe — the "14 slots instead of 9" failure the universe was introduced to
// fix, back through the side door. Hence one endpoint, one language, one
// object: `hlNames` is either fully loaded or absent, and while it is absent
// every name on both sides stays English, which is what this page did before.
let hlNames = null            // { names: string[], byRef: Record<string,string> } | null
let itemNamesRequested = false

function ensureItemNames () {
  if (hlNames || itemNamesRequested) return
  itemNamesRequested = true
  fetch('/item-names', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      if (!Array.isArray(j?.names) || !j.names.length) return
      hlNames = { names: j.names, byRef: (j.byRef && typeof j.byRef === 'object') ? j.byRef : {} }
      render()   // first pass ran on the snapshot alone -> redraw more precisely
    })
    .catch(() => { /* endpoint missing (old container) -> snapshot fallback stays */ })
}

// Drop the table so the next render fetches it again (language switch). Both
// halves go at once — a stale universe with fresh wanted names is exactly the
// half state this whole block is built to make impossible.
function forgetItemNames () { hlNames = null; itemNamesRequested = false }

function renderHighlight (rows) {
  if (hlBox.hidden) return
  const s = currentSnapshot
  if (!s) return
  ensureItemNames()
  // Both lists come out of ONE call, so they can only be in one language —
  // deliberately NOT through INAME, see above. Snapshot names the data set does
  // not know (our labels for unidentified uniques, newer bases) ride along as
  // extraRefs and are translated by the same rule.
  const { wanted, unwanted } = highlightInputs({
    refs: rows.map(r => r.name),
    extraRefs: [...(s.items || []), ...(s.unpriced || [])].map(x => x.name),
    table: hlNames
  })
  const maxLen = Math.max(10, Number(hlMax.value) || HIGHLIGHT_MAX_DEFAULT)
  const r = buildHighlight(wanted, unwanted, { maxLen })

  hlText.value = r.text
  hlCopy.disabled = !r.text
  hlMeta.textContent = r.text
    ? T('nw.hlMeta', { used: fmtC(r.used.length), total: fmtC(r.used.length + r.dropped.length), len: r.length, max: maxLen })
    : T('nw.hlNothing')

  // No silent truncation: what did not fit and what inevitably matches too much
  // is spelled out. Otherwise the regex reads as "covers everything".
  //
  // The word guard (B21) is named only when something actually dropped out. It
  // is why this count can read 6/9 where it read 9/9 before: fragments that
  // avoid everyday English words are longer, and longer fragments fill the
  // field sooner. Without the line the three missing entries look like a
  // smaller selection instead of a price that was paid on purpose.
  const lines = []
  if (r.dropped.length) lines.push(`<b>${esc(T('nw.hlDropped', { n: fmtC(r.dropped.length) }))}</b> ${esc(r.dropped.join(', '))}`)
  if (r.dropped.length && r.lengthened.length) lines.push(esc(T('nw.hlWordGuard', { n: fmtC(r.lengthened.length) })))
  if (r.overmatching.length) lines.push(`<b>${esc(T('nw.hlOvermatch'))}</b> ${esc(r.overmatching.join(', '))}`)
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
    hlCopy.textContent = T('nw.hlCopied')
  } catch {
    // The clipboard API needs https OR localhost — over plain http on the LAN
    // it does not work. Then at least select the text, so Ctrl+C is enough.
    hlText.select()
    hlCopy.textContent = T('nw.hlCtrlC')
  }
  setTimeout(() => { hlCopy.textContent = T('nw.hlCopy') }, 1200)
})

// ---- Render driver --------------------------------------------------------------
function render () {
  const s = currentSnapshot
  if (!s) return
  const dir = st.sortDir
  const k = st.sortK
  // Numbers compare as numbers, everything else as text — and a MISSING value
  // compares as empty, not as the string "null": `source` is absent on rows
  // written by a backend from before it was carried, and localeCompare(null)
  // would have sorted those between "item:…" and "ninja:currency".
  // The Confidence column sorts as a number (marked 1, unmarked 0), so the
  // first click puts the uncertain rows on top; Array.sort is stable, so each
  // half keeps the order it had.
  const sv = it => (k === 'uncertain' ? (it.uncertain ? 1 : 0) : it[k])
  const rows = filteredItems().sort((a, b) => {
    const x = sv(a); const y = sv(b)
    return (typeof x === 'number' && typeof y === 'number')
      ? (x - y) * dir
      : String(x ?? '').localeCompare(String(y ?? '')) * (-dir)
  })
  const shownTotal = rows.reduce((sum, it) => sum + it.chaosTotal, 0)
  statEl.innerHTML = T('nw.stat_html', { n: fmtC(rows.length), value: money(shownTotal, s.cdRatio) })
  const hidden = hiddenBelowThreshold()
  statHiddenEl.textContent = hidden ? T('nw.statHidden', { n: fmtC(hidden) }) : ''
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
  renderUncertainTotal(s)
  renderBars()
}

// ---- Unpriced (grouped by name, collapsed by default via <details>) -------------
// Follows the SAME filters as the table, tab selection included: unchecking a
// tab removes its unpriced items too, which a name-merged list with no tab
// membership could not do. Each snapshot row belongs to exactly one tab
// (`tabIndex`, like items[]); the rows that survive the filter are re-merged by
// name for the display. Rows served by an older backend carry no tabIndex —
// those stay visible rather than silently vanishing.
function unpricedRows (s) {
  const tabIdxOn = onTabIndexSet(s)
  const byName = new Map()
  for (const u of (s.unpriced || [])) {
    if (u.tabIndex != null && !tabIdxOn.has(u.tabIndex)) continue
    if (st.kinds.size && !st.kinds.has(u.kind)) continue
    if (st.q && !nameHit(u.name, st.q)) continue
    const g = byName.get(u.name)
    if (g) g.count += u.count
    else byName.set(u.name, { name: u.name, kind: u.kind, count: u.count })
  }
  return [...byName.values()].sort((a, b) => b.count - a.count)
}

// THE SUMMARY LINE AND THE LIST HAVE TO BE THE SAME UNIT. They were not: each
// row states PIECES (`×N`, the summed stack sizes) while the summary stated
// counts.unpriced, which counts stash ENTRIES — both printed as "items". They
// only look equal while every stack is one. A five-stack made the summary too
// small; a row the account-wide 100-name cap kept out of the list made it too
// big, which is how "40 unpriced items across 1 names" came to sit over a list
// adding up to 39. So the summary now states pieces and names, both taken from
// the rows on screen, and what the list cannot show is said out loud instead of
// being folded into the headline.
const unpricedShownPieces = rows => rows.reduce((sum, u) => sum + (Number(u.count) || 0), 0)

// The faithful piece total for the CURRENT selection, or null when it cannot be
// established — in which case nothing is claimed about what is missing. A kind
// chip or a search term is not expressible in stash tabs, and a tab stored by a
// backend that predates this number does not carry it.
function unpricedPiecesInSelection (s) {
  if (st.kinds.size || st.q) return null
  const on = (s.tabs || []).filter(isTabOn)
  if (!on.every(t => typeof t.unpricedPieces === 'number')) return null
  return on.reduce((sum, t) => sum + t.unpricedPieces, 0)
}

function renderUnpriced (s) {
  const un = unpricedRows(s)
  unpricedBox.hidden = un.length === 0
  if (!un.length) return
  const shown = unpricedShownPieces(un)
  const inSelection = unpricedPiecesInSelection(s)
  // Clamped: rows an older backend served without a tabIndex stay visible under
  // every selection (see unpricedRows), so the rows can legitimately add up to
  // more than the selected tabs do. That is not a shortfall to report.
  const notListed = inSelection == null ? 0 : Math.max(0, inSelection - shown)
  unpricedSummary.textContent =
    T('nw.unpriced', { pcs: fmtC(shown), names: fmtC(un.length), nameWord: TN('nw.unpricedName', un.length) }) +
    (notListed ? T('nw.unpricedMore', { n: fmtC(notListed) }) : '')
  unpricedList.innerHTML = un.map(u =>
    `<li>${esc(T('nw.unpricedRow', { name: INAME(u.name), n: fmtC(u.count), kind: kindLabel(u.kind) }))}</li>`).join('')
}

// ---- Listed below market (snapshot.belowMarket, networth/listing-audit.mjs) ----
// The player's own price notes under this tool's market value, already decided
// and sorted by the server (the whisper verdict's rule and threshold). Not
// filtered by the tab selection, the kind chips or the search: the decision it
// serves is whether to reprice an item that is up for sale, and an item is up
// for sale whether or not its tab is counted above. Hidden when there is
// nothing to say; a snapshot from an older backend has no belowMarket at all.
const BELOW_SKIPS = ['rate-unknown', 'uncertain-price', 'unknown-currency']
// A price in this block is compared, not summed: fmtC's whole chaos from 1 c up
// would show 4.6 c against 5.45 c as "5 c | 5 c | 0.84". One decimal below
// 100 c keeps the two prices as far apart as the ratio says they are.
const fmtPrice = n => {
  const v = Number(n) || 0
  if (v === 0 || Math.abs(v) < 1 || Math.abs(v) >= 100) return fmtC(v)
  return v.toLocaleString(I18n.locale(), { maximumFractionDigits: 1 })
}
function renderBelowMarket (s) {
  const b = s && s.belowMarket
  const rows = (b && Array.isArray(b.rows)) ? b.rows : []
  const skipped = (b && b.notCompared) || {}
  const skipParts = BELOW_SKIPS.filter(k => Number(skipped[k]) > 0)
    .map(k => T('nw.below.skip.' + k, { n: fmtC(skipped[k]) }))
  belowBox.hidden = rows.length === 0 && skipParts.length === 0
  if (belowBox.hidden) return
  const num = n => Number(n).toLocaleString(I18n.locale(), { maximumFractionDigits: 2 })
  belowBody.innerHTML = rows.map(r => {
    const name = esc(INAME(r.name)) + (Number(r.qty) > 1 ? ` ×${esc(fmtC(r.qty))}` : '')
    const tab = r.fromTab ? T('nw.below.tabPrice', { tab: r.tab ?? '' }) : (r.tab ?? '')
    const where = r.left != null && r.top != null ? T('nw.below.where', { left: r.left, top: r.top }) : '—'
    return `<tr><td>${name}</td><td>${esc(tab)}</td><td>${esc(where)}</td>` +
      `<td class="r" title="${esc(r.note)}">${esc(fmtPrice(r.listedChaos))} c</td>` +
      `<td class="r">${esc(fmtPrice(r.marketChaos))} c</td>` +
      `<td class="r">${esc(num(r.ratio))} (−${esc(num(r.pct))} %)</td></tr>`
  }).join('')
  // The server sends the biggest losses only (BELOW_MAX in listing-audit.mjs)
  // and counts the rest.
  const more = Number(b && b.more) || 0
  belowMoreEl.hidden = more <= 0
  belowMoreEl.textContent = more > 0 ? T('nw.below.more', { n: fmtC(more), max: fmtC(rows.length) }) : ''
  belowSkippedEl.hidden = skipParts.length === 0
  belowSkippedEl.textContent = skipParts.length ? T('nw.below.skipped', { list: skipParts.join('; ') }) : ''
}

// ---- Top-level snapshot rendering -----------------------------------------------
function showNoResult (msg) {
  shellEl.hidden = true
  if (sideBoxEl) sideBoxEl.hidden = true
  noResultEl.hidden = false
  noResultEl.textContent = msg || T('nw.building')
}

function renderSnapshot (s) {
  if (!s) return
  currentSnapshot = s
  noResultEl.hidden = true
  shellEl.hidden = false
  if (sideBoxEl) sideBoxEl.hidden = false
  totalDivEl.innerHTML = `${fmt(s.totalDivine)}<u>div</u>`
  totalChaosEl.textContent = `${fmt(s.totalChaos)} c`
  // The filter is offered only while something is marked; a snapshot without
  // a marked row also drops a filter that would now show nothing.
  const anyUnc = (s.items || []).some(i => i.uncertain)
  uncBtn.hidden = !anyUnc
  if (!anyUnc && st.uncOnly) { st.uncOnly = false; uncBtn.classList.remove('on') }

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
  renderBelowMarket(s)
  renderAutoSync(s)
}

// Background auto-sync status line. Derived from snapshot.tabs[].syncedAt (the
// backend stamps each tab when the refresher syncs it). The counter says how
// many tabs were synced within SYNCED_RECENTLY_MS; see networth-sync.js for why
// that window is not scaled to the length of a full round.
function renderAutoSync (s) {
  if (!autosyncEl) return
  // Plain text, no dot/prefix — the conn pill next to the title is the only
  // live indicator. Account, league + last scan hang on the title attribute
  // instead of taking up their own header block.
  const at = s && s.at ? new Date(s.at).toLocaleString(I18n.locale()) : ''
  const who = [s && s.accountName, s && s.league].filter(Boolean).join(' · ')
  autosyncEl.title = [who, at && `last scan ${at}`].filter(Boolean).join(' — ')
  const sum = autosyncSummary(s && s.tabs, Date.now())
  if (!sum) { autosyncEl.textContent = T('nw.autosyncStarting'); return }
  autosyncEl.textContent = T('nw.autosync', sum)
}

function renderHistory (items) {
  historyBox.hidden = !items.length
  historyList.innerHTML = items.slice().reverse().map(h =>
    `<li>${esc(T('nw.historyRow', {
      when: new Date(h.at).toLocaleString(I18n.locale()),
      div: fmt(h.totalDivine), chaos: fmt(h.totalChaos), league: h.league
    }))}</li>`).join('')
}

function renderError (message) {
  errBox.hidden = false
  errBox.textContent = message
}

// ---- Sync status (M2 status line) -------------------------------------------
// The server sends `networth-sync-status` on connect and whenever the
// refresher's state for this user changes (auth pause, cooldown, renewal).
// The stored POESESSID never travels in any of these messages.
//
// The credential FORM is not here: it lives on the settings page, together with
// the admin area, so there is exactly one place where something gets
// configured. What stays here is the
// status line and its one job: naming the state and pointing at the page that
// fixes it.
const appStatusEl = document.getElementById('appStatus')

let syncStatus = null       // last networth-sync-status message from the server (whole message: `mine`/`tradeBan` pick the wording)
let cooldownTimer = null    // clears the "rate-limited" line once `until` passes

function statusLineText (st) {
  return syncLineText(st, T, I18n.locale())
}

function applySyncStatus (st) {
  // The shell's blind summary needs to know about an expired cookie; this
  // page writes its own, richer sync line and must not write the shared one.
  if (window.Shell) window.Shell.noteSyncState(st && st.state)
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
    // The rest of the message stays: a pace (sync follows the game) is
    // still the server's word after the cooldown.
    cooldownTimer = setTimeout(() => { if (syncStatus && syncStatus.state === 'cooldown') applySyncStatus({ ...syncStatus, state: 'ok', until: null }) }, wait)
  }
}

// Clicking the SYNC message goes to the settings page — every fault it can show
// ("expired", "no credentials") is fixed there; a pace line is not a fault. The data auto-update note in
// the same slot is informational and must not navigate anywhere.
if (appStatusEl) {
  appStatusEl.addEventListener('click', e => {
    const hit = e.target && e.target.closest ? e.target.closest('[data-status-key]') : null
    if (hit && hit.dataset.statusKey !== 'sync') return
    // A pace line (sync follows the game) is information, nothing to fix there.
    const line = syncStatusLine(syncStatus)
    if (line && !line.info) location.href = '/settings.html'
  })
}

// ---- Identity (multi-user routing, no login) ------------------------------
const idgate     = document.getElementById('idgate')
const idbtns     = document.getElementById('idbtns')
const whoami     = document.getElementById('whoami')
const whoamiName = document.getElementById('whoamiName')

let USERS = ['player1', 'player2']
let USER_LANGS = {}   // user -> client language, from GET /users (POE_USER_LANGS)
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
  setUserCookie(u); I18n.applyUsers(USER_LANGS, u); hideIdGate(); showWhoami(u)
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
    if (j.langs && typeof j.langs === 'object') USER_LANGS = j.langs
    if (j.appName) window.Shell.applyBrand(j.appName, 'nav.networth')
  } catch { /* keep fallback list + fallback brand */ }
  const cookie = readCookie('ppt_user')
  I18n.applyUsers(USER_LANGS, cookie)
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
    retry = 0; setConn('live', T('conn.live'))
    sendSafe({ type: 'networth-history' })
  })
  ws.addEventListener('close', () => {
    setConn('down', T('conn.reconnecting'))
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
        applySyncStatus(msg)
        break
      case 'cd-ratio':     window.Shell.applyCdRatio(msg); break     // global rail tile
      case 'league-state': window.Shell.applyLeagueState(msg); break // global rail slot
      case 'data-status':  window.Shell.applyDataStatus(msg); break  // M2 data freshness
      case 'release-status': window.Shell.applyReleaseStatus(msg); break // newer release -> status line
      case 'networth-session': window.Shell.applySessionStatus(msg); break // running farm session -> status line
      case 'source-status': window.Shell.applySourceStatus(msg); break // price sources' age -> status line
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

// Everything this page draws itself has to follow a language change: the whole
// snapshot render (sidebar, bars, chips, table, unpriced) and the sync status
// line.
I18n.onChange(() => {
  // The highlight universe was fetched for the language that was in force when
  // the page loaded. A language switch is the one event that invalidates it —
  // the SERVER still decides which language the new answer is in (that is the
  // game's language, a different question from the page's), this only says
  // "ask again". Without it the regex keeps yesterday's language until reload.
  forgetItemNames()
  if (currentSnapshot) renderSnapshot(currentSnapshot)
  applySyncStatus(syncStatus)
  if (noResultEl && !noResultEl.hidden) showNoResult()
  if (conn.classList.contains('live')) setConn('live', T('conn.live'))
})

initIdentity()
