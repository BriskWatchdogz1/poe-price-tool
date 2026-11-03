/* History page — the curve plus what moved.
 *
 * Split of responsibilities, deliberately: /networth-trend carries the SHAPE
 * (one line, downsampled), /networth-events carries the REASONS (stock
 * movements only). Both are asked for the same range key, so the two halves can
 * never describe different windows.
 *
 * The chart's only click targets are the event dots. That is the whole point of
 * this page: the previous version put a hit target on every recorded minute of
 * a three-pixel sparkline, and most of them had nothing to say.
 *
 * Farm and game sessions live here too (GET /networth-sessions): the farm
 * session's Start/End/Discard buttons, the running game session's Discard, a
 * card for one session and the list, each farm session under the game
 * evening it was started in. The server computes every figure and every
 * state, this page only formats them.
 */
import {
  chartGeometry, markerAt, CHART,
  money, fmtDivine, fmtChaos, rateAt, displaySeries, windowNet, rateSpan
} from './history-chart.js'

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// i18n shorthands — i18n.js is a classic script loaded before this module.
const I18n = window.I18n
const T = (k, p) => I18n.t(k, p)
// An item name to PRINT. The history file stores the ENGLISH reference name —
// that is the identity a movement is accumulated under across snapshots — so
// the translation happens on the way to the screen and nowhere else.
const INAME = n => I18n.itemName(n) || n

const $ = id => document.getElementById(id)
const chartSvg = $('chart')
const chartBody = $('chartBody')
const chartEmpty = $('chartEmpty')
const eventsEl = $('events')
const evNone = $('evNone')
const evNote = $('evNote')
const headSum = $('headSum')
const rangeSeg = $('rangeSeg')
const covBox = $('covBox')
const connEl = $('conn')
const connLbl = $('connlbl')

const RANGE_KEY = 'ppt_history_range'
const MIN_KEY = 'ppt_history_mindiv'
const RANGES = ['1h', '6h', '24h', '7d', '14d']
const POLL_MS = 30000

function loadRange () {
  try { const v = localStorage.getItem(RANGE_KEY); return RANGES.includes(v) ? v : '24h' } catch { return '24h' }
}
function saveRange (v) { try { localStorage.setItem(RANGE_KEY, v) } catch { /* ignore */ } }
// Event threshold in divine, user-set in the rail. 0 = show everything recorded.
const MIN_CHOICES = ['0', '0.5', '1', '3', '10']
function loadMinDiv () {
  try { const v = localStorage.getItem(MIN_KEY); return MIN_CHOICES.includes(v) ? v : '1' } catch { return '1' }
}
function saveMinDiv (v) { try { localStorage.setItem(MIN_KEY, v) } catch { /* ignore */ } }

let range = loadRange()
let minDiv = loadMinDiv()
let events = []
let geo = null
let selected = -1

// ---- formatting -------------------------------------------------------------
// The numbers themselves are formatted in history-chart.js, because every one
// of them is a function of a chaos amount and THE RATE THAT AMOUNT WAS RECORDED
// AT — never of a rate held in this module. One such variable, filled from the
// newest point of the series, would re-value every figure on the page (axis,
// tooltips, event rows, event sums, the window net and the header) with every
// rate tick, and a historical event cannot change by definition.
//
// The rate of an event: its own, and only if it has none the nearest recorded
// one. `lastPoints` is the window the chart is drawn from, so the borrowed rate
// is always one from the same window.
const eventRate = e => (Number(e && e.cd) > 0 ? Number(e.cd) : rateAt(lastPoints, e && e.at))
// A value already converted into the display unit (a net, a sum over events).
// Such a figure has no single rate left to express it in chaos, so it is
// printed in the unit it was summed in.
const unitFmt = (v, opts) => (geoUnit() === 'div' ? fmtDivine(v, opts) : fmtChaos(v, opts))
const geoUnit = () => (geo && geo.unit) || displaySeries(lastPoints).unit
// Clock and date follow the page language, not the browser's locale — the same
// reasoning as for the numbers (see i18n.js).
const clock = at => new Date(at).toLocaleTimeString(I18n.locale(), { hour: '2-digit', minute: '2-digit' })
// Over a day the time of day says nothing — the axis switches to the date.
const day = at => new Date(at).toLocaleDateString(I18n.locale(), { day: '2-digit', month: '2-digit' })
const axisLabel = at => (RANGES.indexOf(range) >= 3 ? day(at) : clock(at))
const clockSec = at => new Date(at).toLocaleTimeString(I18n.locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function ago (ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return T('hi.agoSec', { n: s })
  const m = Math.round(s / 60)
  if (m < 90) return T('hi.agoMin', { n: m })
  const h = m / 60
  return T('hi.agoHour', { n: h >= 10 ? Math.round(h) : Math.round(h * 10) / 10 })
}
function span (ms) {
  const m = Math.round(ms / 60000)
  if (m < 90) return T('hi.spanMin', { n: m })
  const h = m / 60
  return T('hi.spanHour', { n: h >= 10 ? Math.round(h) : Math.round(h * 10) / 10 })
}

// ---- chart ------------------------------------------------------------------
function renderChart (points) {
  geo = chartGeometry(points, events)
  const has = !geo.empty
  chartEmpty.hidden = has
  chartSvg.style.display = has ? '' : 'none'
  if (!has) { chartBody.innerHTML = ''; return }

  const x0 = CHART.padL; const x1 = CHART.w - CHART.padR
  const parts = []
  // The ticks are already in the plotted unit — no rate is applied here, which
  // is the point: the axis of a ten-day window must not move when today's rate
  // does.
  for (const t of geo.valueTicks) {
    parts.push(`<line class="grid" x1="${x0}" x2="${x1}" y1="${t.y}" y2="${t.y}"/>`)
    parts.push(`<text class="axlbl" x="${x0 - 8}" y="${t.y + 3.5}" text-anchor="end">${esc(unitFmt(t.v))}</text>`)
  }
  for (const t of geo.timeTicks) {
    parts.push(`<text class="axlbl" x="${t.x}" y="${CHART.h - 8}" text-anchor="middle">${esc(axisLabel(t.at))}</text>`)
  }
  parts.push(`<path class="tarea" d="${geo.area}"/>`)
  // The C:D rate, faint, on its own scale — so a falling divine curve can be
  // read as "the rate ran away" instead of as an unexplained loss. Two edge
  // labels, no second axis (see history-chart.js).
  if (geo.rate) {
    parts.push(`<path class="rline" d="${geo.rate.d}"><title>${esc(T('hi.rateLine'))}</title></path>`)
    for (const t of geo.rate.ticks) {
      parts.push(`<text class="ratelbl" x="${x1 - 2}" y="${t.y - 4}" text-anchor="end">${esc(Math.round(t.v).toLocaleString(I18n.locale()))}</text>`)
    }
  }
  // Falling stretches are drawn red, rising ones green — the direction has to be
  // readable BETWEEN the dots, not just on them.
  for (const seg of geo.segments) {
    parts.push(`<path class="tline${seg.down ? ' dn' : ''}" d="${seg.d}"/>`)
  }
  geo.markers.forEach((m, i) => {
    const cls = `edot${m.v < 0 ? ' neg' : ''}${i === selected ? ' sel' : ''}`
    parts.push(`<circle class="${cls}" cx="${m.x}" cy="${m.y}" r="${i === selected ? 6 : 4.5}" data-i="${i}">` +
      `<title>${esc(clockSec(m.at))} · ${esc(money(m.v, m.rate, { sign: true }))}</title></circle>`)
  })
  chartBody.innerHTML = parts.join('')
}

// A click anywhere in the plot snaps to the nearest event within reach, so the
// target is a band around the dot rather than the dot itself.
function svgX (e) {
  const r = chartSvg.getBoundingClientRect()
  if (!r.width) return -1
  return ((e.clientX - r.left) / r.width) * CHART.w
}
chartSvg.addEventListener('click', e => {
  if (!geo || geo.empty) return
  const i = markerAt(geo.markers, svgX(e))
  if (i >= 0) select(i, { scroll: true })
})
chartSvg.addEventListener('mousemove', e => {
  if (!geo || geo.empty) return
  chartSvg.style.cursor = markerAt(geo.markers, svgX(e)) >= 0 ? 'pointer' : 'default'
})

// ---- event list -------------------------------------------------------------
// A bucket covering several recorded points is a SPAN, and says so — otherwise
// "12:30" would claim a precision the grouping does not have.
function eventWhen (e) {
  const long = RANGES.indexOf(range) >= 3
  const end = long ? `${day(e.at)} ${clock(e.at)}` : clockSec(e.at)
  if (!(e.points > 1) || !Number.isFinite(e.from) || e.from === e.at) return end
  return `${clock(e.from)} – ${end}`
}

function renderEvents () {
  const now = Date.now()
  if (!events.length) {
    eventsEl.innerHTML = ''
    evNone.hidden = false
    evNone.textContent = geo && !geo.empty ? T('hi.evNoneInWindow') : T('hi.evNoneRecorded')
    evNote.textContent = ''
    return
  }
  evNone.hidden = true
  const bar = minDiv === '0' ? T('hi.evBarAll') : T('hi.evBarFrom', { n: Number(minDiv).toLocaleString(I18n.locale()) })
  evNote.textContent = T('hi.evNote', { n: events.length, word: I18n.tn('hi.event', events.length), bar })
  // Newest first: the question is almost always "what just happened?".
  eventsEl.innerHTML = events.map((e, i) => {
    // One rate per event, the one the bucket was stamped with. What this row
    // said when it happened is what it says now.
    const rate = eventRate(e)
    const rows = e.items.map(([name, dq, chaos]) => {
      const cls = chaos < 0 ? 'loss' : 'gain'
      const q = dq > 0 ? `+${dq}` : String(dq)
      return `<div class="evrow"><span class="n">${esc(INAME(name))}</span>` +
        `<span class="q">${esc(q)}</span>` +
        `<span class="v ${cls}">${esc(money(chaos, rate, { sign: true }))}</span></div>`
    }).join('')
    return `<div class="ev${i === selected ? ' sel' : ''}" data-i="${i}" id="ev-${i}">` +
      `<div class="evtop"><span class="evtime">${esc(eventWhen(e))}</span>` +
      `<span class="evago">${esc(ago(now - e.at))}</span>` +
      `<span class="evsum ${e.v < 0 ? 'loss' : 'gain'}">${esc(money(e.v, rate, { sign: true }))}</span></div>` +
      rows + '</div>'
  }).reverse().join('')
}

eventsEl.addEventListener('click', e => {
  const row = e.target.closest('.ev')
  if (row) select(Number(row.dataset.i), { scroll: false })
})

function select (i, { scroll }) {
  selected = (i === selected) ? -1 : i
  renderChart(lastPoints)
  renderEvents()
  if (scroll && selected >= 0) {
    const el = document.getElementById(`ev-${selected}`)
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
}

// ---- rail summary -----------------------------------------------------------
function renderCoverage (series) {
  covBox.hidden = false
  $('covRange').textContent = range
  const pts = series.points || []
  $('covRec').textContent = pts.length
    ? (series.coverageMs ? span(series.coverageMs) : '—')
    : '—'
  $('covEv').textContent = String(events.length)
  // Both ends valued at their OWN rate. That is what makes this figure able to
  // be negative on a window whose chaos total rose: the stash buys less than it
  // did. The rate row right under it, and the pale rate curve in the plot, are
  // where that answer becomes readable instead of mysterious.
  const net = windowNet(pts)
  const el = $('covNet')
  el.textContent = net.ok ? unitFmt(net.v, { sign: true }) : '—'
  el.className = net.v < 0 ? 'loss' : 'gain'

  const rs = rateSpan(pts)
  $('covRate').textContent = rs
    ? T('hi.covRateVal', {
        from: Math.round(rs.from).toLocaleString(I18n.locale()),
        to: Math.round(rs.to).toLocaleString(I18n.locale()),
        pct: (rs.pct >= 0 ? '+' : '−') + Math.abs(rs.pct).toFixed(Math.abs(rs.pct) >= 10 ? 0 : 1)
      })
    : '—'

  const { values } = displaySeries(pts)
  // Summed in the display unit, event by event, each at its own rate — summing
  // the chaos first and converting once would be the same mistake in small.
  const div = geoUnit() === 'div'
  const moved = events.reduce((s, e) => {
    const r = eventRate(e)
    return s + (div && r > 0 ? e.v / r : e.v)
  }, 0)
  headSum.innerHTML = values.length
    ? T('hi.headSum_html', {
        now: esc(unitFmt(values[values.length - 1])),
        moved: esc(unitFmt(moved, { sign: true }))
      })
    : ''
}

// ---- farm and game sessions ---------------------------------------------------
// The answer to "is what I am doing right now worth it". Every number comes
// from the server (networth/sessions.mjs); loot is shown at the starting C:D
// rate because it is computed in starting prices. A farm session is started
// and ended by the player (the toolbar buttons, the daemon's session key); a
// game session follows the game (session-control.mjs) and can only be
// discarded here.
const sessBtn = $('sessBtn')
const sessBtnLbl = $('sessBtnLbl')
const sessDiscard = $('sessDiscard')
const sessMsg = $('sessMsg')
const sessCard = $('sessCard')
const sessTable = $('sessTable')
const sessRows = $('sessRows')
const sessNone = $('sessNone')
const sessNote = $('sessNote')

let sess = null      // last GET /networth-sessions answer
let sessSel = null   // id of a session picked in the table, or null

const SESS_ERR = {
  'no-baseline': 'hi.sessErrNoBaseline',
  'already-running': 'hi.sessErrRunning',
  'not-running': 'hi.sessErrNotRunning',
  'sync-off': 'hi.sessErrSyncOff'
}
// A refused discard of the game session names the game session.
const SESS_ERR_GAME = { 'not-running': 'hi.sessErrGameNotRunning' }
const SESS_STATE = {
  starting: 'hi.sessStarting',
  running: 'hi.sessStateRunning',
  preliminary: 'hi.sessPreliminary',
  final: 'hi.sessFinal',
  unfinished: 'hi.sessUnfinished'
}
const kindTxt = s => T(s && s.kind === 'game' ? 'shell.sessKindGame' : 'shell.sessKindFarm')
// The state as the list says it; a baseline taken from the copy at the start
// instead of a full read after it is said there too.
const stateTxt = s => (SESS_STATE[s.state] ? T(SESS_STATE[s.state]) : '') +
  (s.baseline === 'at-press' ? ` · ${T('hi.sessAtPressShort')}` : '')

const durTxt = ms => T('hi.sessDurVal', { dur: window.Shell.fmtSessionDuration(ms) })
const sessAmt = (chaos, div) => (div != null ? fmtDivine(div, { sign: true }) : fmtChaos(chaos, { sign: true }))
const signCls = v => (Number(v) < 0 ? 'loss' : 'gain')
const sessWhen = at => `${day(at)} ${clock(at)}`
const perHourShort = b => (b.lootPerHourDiv != null
  ? fmtDivine(b.lootPerHourDiv, { sign: true })
  : b.lootPerHour != null ? fmtChaos(b.lootPerHour, { sign: true }) : '—')

async function loadSessions () {
  try {
    const r = await fetch('/networth-sessions')
    if (!r.ok) return
    sess = await r.json()
    renderSessions()
  } catch { /* keep the last answer */ }
}

function showSessMsg (text) {
  sessMsg.textContent = text || ''
  sessMsg.hidden = !text
}

function renderSessionButton () {
  if (!sess) { sessBtn.hidden = true; sessDiscard.hidden = true; return }
  const running = !!sess.running
  sessBtn.hidden = false
  sessBtn.dataset.act = running ? 'end' : 'start'
  sessBtn.classList.toggle('end', running)
  sessBtnLbl.textContent = running ? T('hi.sessEnd') : T('hi.sessStart')
  sessBtn.disabled = !sess.available && !running
  sessBtn.title = sessBtn.disabled ? T('hi.sessErrSyncOff') : running ? '' : T('hi.sessStartTitle')
  sessDiscard.hidden = !running
  sessDiscard.title = T('hi.sessDiscardTitle')
}

// act: 'start' | 'end' | 'discard' (the farm session), or 'discard' with
// kind 'game' (the running game session).
async function sessionAction (act, kind = 'farm') {
  let r
  try {
    r = await fetch('/networth-session/' + act + (kind === 'game' ? '?kind=game' : ''), { method: 'POST' })
  } catch {
    showSessMsg(T('hi.sessErrFailed', { status: '—' }))
    return
  }
  if (r.ok) {
    showSessMsg('')
    sessSel = null
  } else {
    const j = await r.json().catch(() => ({}))
    const key = (kind === 'game' && SESS_ERR_GAME[j.error]) || SESS_ERR[j.error]
    showSessMsg(key
      ? T(key, j.error === 'no-baseline' ? { min: Math.round((j.maxAgeMs || 0) / 60000) } : undefined)
      : T('hi.sessErrFailed', { status: r.status }))
  }
  loadSessions()
}

sessBtn.addEventListener('click', () => {
  if (sessBtn.disabled) return
  sessionAction(sessBtn.dataset.act === 'end' ? 'end' : 'start')
})
sessDiscard.addEventListener('click', () => {
  // A discarded session is gone for good: ask first.
  if (!window.confirm(T('hi.sessDiscardConfirm'))) return
  sessionAction('discard')
})
// The card's own button: the running game session's Discard.
sessCard.addEventListener('click', e => {
  const b = e.target.closest('button[data-act]')
  if (!b || b.dataset.act !== 'discard-game') return
  if (!window.confirm(T('hi.sessDiscardGameConfirm'))) return
  sessionAction('discard', 'game')
})

function sessRowsHtml (rows, cd0) {
  if (!rows || !rows.length) return `<div class="evrow"><span class="n">${esc(T('hi.sessNone'))}</span></div>`
  return rows.map(([name, dq, chaos]) =>
    `<div class="evrow"><span class="n">${esc(INAME(name))}</span>` +
    `<span class="q">${esc(dq > 0 ? `+${dq}` : String(dq))}</span>` +
    `<span class="v ${signCls(chaos)}">${esc(money(chaos, cd0, { sign: true }))}</span></div>`).join('')
}

// Every session the answer holds, once: the running ones, the ended ones
// waiting for their round and the closed ones.
function allSessions () {
  if (!sess) return []
  const seen = new Set()
  return [sess.running, sess.game, ...(sess.pending || []), ...(sess.done || [])]
    .filter(x => x && !seen.has(x.id) && seen.add(x.id))
}

function renderSessionCard () {
  if (!sess) { sessCard.hidden = true; return }
  const picked = sessSel ? allSessions().find(x => x.id === sessSel) : null
  const pending = sess.pending || []
  // Unpicked, the card follows what the player is waiting for: the running
  // farm session, then the newest ended one still waiting for its final
  // balance, and only then the game evening; a finished one only when picked.
  const s = picked || sess.running || pending[pending.length - 1] || sess.game || null
  if (!s) { sessCard.hidden = true; sessCard.innerHTML = ''; return }
  sessCard.hidden = false
  const kind = kindTxt(s)
  const title = s.state === 'starting'
    ? T('hi.sessStartedAt', { kind, time: clock(s.startedAt) })
    : s.state === 'running'
      ? T('hi.sessRunning', { kind, time: clock(s.startedAt) })
      : T('hi.sessRange', { kind, from: sessWhen(s.startedAt), to: clock(s.endedAt) })
  const badge = SESS_STATE[s.state] ? `<span class="sessstate ${esc(s.state)}">${esc(T(SESS_STATE[s.state]))}</span>` : ''
  const b = s.balance
  const stashChanged = !!(s.stashChanged || (b && b.stashChanged))
  const cell = (label, value, cls = '') => `<div><span>${esc(T(label))}</span><b class="${cls}">${esc(value)}</b></div>`
  let grid = cell('hi.sessDuration', durTxt(s.durationMs))
  if (b) {
    const perHour = b.lootPerHour != null
      ? T('hi.sessPerHourVal', {
          chaos: fmtChaos(b.lootPerHour, { sign: true }),
          div: b.lootPerHourDiv != null ? fmtDivine(b.lootPerHourDiv, { sign: true }) : '—'
        })
      : (stashChanged ? '—' : T('hi.sessPerHourShort', { min: Math.round((sess.rateMinMs || 0) / 60000) }))
    grid += cell('hi.sessTotal', sessAmt(b.total, b.totalDiv), signCls(b.total)) +
      cell('hi.sessLoot', sessAmt(b.loot, b.lootDiv), signCls(b.loot)) +
      cell('hi.sessMarket', sessAmt(b.market, b.marketDiv), signCls(b.market)) +
      cell('hi.sessPerHour', perHour, b.lootPerHour != null ? signCls(b.lootPerHour) : '')
  } else {
    for (const k of ['hi.sessTotal', 'hi.sessLoot', 'hi.sessMarket', 'hi.sessPerHour']) grid += cell(k, '—')
  }
  const lists = b
    ? `<div class="sesslists"><div><h3>${esc(T('hi.sessGains'))}</h3>${sessRowsHtml(b.gains, b.cd0)}</div>` +
      `<div><h3>${esc(T('hi.sessLosses'))}</h3>${sessRowsHtml(b.losses, b.cd0)}</div></div>`
    : ''
  const warn = []
  const about = Number.isFinite(s.about) && s.about > 0 ? s.about : null
  if (s.state === 'starting') {
    warn.push(about != null ? T('hi.sessBaselineAbout', { min: about }) : T('hi.sessBaselineNext'))
    if (s.round) warn.push(T('hi.sessRoundStart', s.round))
  }
  if (s.state === 'preliminary') {
    warn.push(s.round ? T('hi.sessRound', s.round) : T('hi.sessRoundUnknown'))
    if (about != null) warn.push(T('hi.sessFinalAbout', { min: about }))
    // A farm session ends with the game still open: what is still in the
    // inventory can be stashed in time. A game session ended with the game.
    if (s.kind !== 'game') warn.push(T('hi.sessStashLoot'))
  }
  if (s.baseline === 'at-press') warn.push(T('hi.sessAtPressNote'))
  if (s.state === 'unfinished') warn.push(T(b ? 'hi.sessUnfinishedNote' : 'hi.sessUnfinishedNoFigures'))
  if (stashChanged) warn.push(T('hi.sessStashChanged'))
  if (b && Array.isArray(b.withheld) && b.withheld.length) {
    warn.push(T('hi.sessWithheld', { names: b.withheld.map(INAME).join(', '), h: Math.round((sess.guardHoldMs || 0) / 3600000) }))
  }
  if (b && b.unpricedIn > 0) warn.push(T('hi.sessUnpricedIn', { n: b.unpricedIn }))
  if (sess.persisted === false) warn.push(T('hi.sessNotPersisted'))
  // A game session has no Start or End (it follows the game); while it runs,
  // its card carries its Discard.
  const act = s.kind === 'game' && sess.game && sess.game.id === s.id
    ? `<button type="button" class="sessbtn ghost" data-act="discard-game" title="${esc(T('hi.sessDiscardGameTitle'))}">${esc(T('hi.sessDiscardGame'))}</button>`
    : ''
  sessCard.innerHTML =
    `<div class="sesstop"><b>${esc(title)}</b>${badge}${act}</div>` +
    `<div class="sessgrid">${grid}</div>` + lists +
    warn.map(w => `<p class="sesswarn">${esc(w)}</p>`).join('') +
    `<p class="sessnote">${esc(T('hi.sessNoteStash'))}</p>` +
    `<p class="sessnote">${esc(T('hi.sessNoteTrade'))}</p>` +
    '<details class="unitinfo"><summary><span class="ico" aria-hidden="true">i</span>' +
    `<span>${esc(T('hi.sessHowBtn'))}</span><span class="caret" aria-hidden="true">▾</span></summary>` +
    `<p>${esc(T('hi.sessNoteSplit'))}</p><p>${esc(T('hi.sessNoteRound'))}</p></details>`
}

// The list's order: newest first, each game evening followed by the farm
// sessions started in it (newest first, drawn indented). A farm session whose
// evening is not in the answer (discarded: the server drops the parent;
// older than the list holds) stands on its own. Pure, for the tests.
function sessionTree (list) {
  const byStart = (a, b) => b.startedAt - a.startedAt
  const games = new Set(list.filter(x => x.kind === 'game').map(x => x.id))
  const under = x => x.kind !== 'game' && x.parent != null && games.has(x.parent)
  const out = []
  for (const top of list.filter(x => !under(x)).sort(byStart)) {
    out.push({ s: top, child: false })
    if (top.kind !== 'game') continue
    for (const c of list.filter(x => under(x) && x.parent === top.id).sort(byStart)) out.push({ s: c, child: true })
  }
  return out
}

function renderSessionTable () {
  if (!sess) return
  const rows = sessionTree(allSessions())
  sessNote.textContent = (sess.done || []).length ? T('hi.sessListNote', { n: sess.done.length }) : ''
  if (!rows.length) {
    sessTable.hidden = true
    sessRows.innerHTML = ''
    sessNone.textContent = T('hi.sessListEmpty')
    sessNone.hidden = false
    return
  }
  sessNone.hidden = true
  sessTable.hidden = false
  sessRows.innerHTML = rows.map(({ s: x, child }) => {
    const b = x.balance
    const td = (v, cls = '') => `<td class="${cls}">${esc(v)}</td>`
    const cls = [child ? 'child' : '', x.kind === 'game' ? 'game' : '', x.id === sessSel ? 'sel' : ''].filter(Boolean).join(' ')
    return `<tr data-id="${esc(x.id)}" class="${cls}">` +
      td(kindTxt(x), 'kind') + td(sessWhen(x.startedAt)) + td(durTxt(x.durationMs)) +
      (b
        ? td(sessAmt(b.loot, b.lootDiv), signCls(b.loot)) + td(sessAmt(b.market, b.marketDiv), signCls(b.market)) +
          td(sessAmt(b.total, b.totalDiv), signCls(b.total)) + td(perHourShort(b))
        : td('—') + td('—') + td('—') + td('—')) +
      td(stateTxt(x), 'state') + '</tr>'
  }).join('')
}

sessRows.addEventListener('click', e => {
  const row = e.target.closest('tr[data-id]')
  if (!row) return
  sessSel = sessSel === row.dataset.id ? null : row.dataset.id
  renderSessionCard()
  renderSessionTable()
})

function renderSessions () {
  renderSessionButton()
  renderSessionCard()
  renderSessionTable()
}

// ---- data -------------------------------------------------------------------
let lastPoints = []
let lastSeries = null   // last /networth-trend payload, so a redraw needs no refetch

async function load () {
  try {
    const [tr, ev] = await Promise.all([
      fetch(`/networth-trend?range=${encodeURIComponent(range)}`).then(r => r.json()),
      fetch(`/networth-events?range=${encodeURIComponent(range)}&minDiv=${encodeURIComponent(minDiv)}`).then(r => r.json())
    ])
    // The points carry their own rates (third column). Nothing is lifted out of
    // the newest one into module state.
    if (tr && Array.isArray(tr.points)) lastPoints = tr.points
    events = (ev && Array.isArray(ev.events)) ? ev.events : []
    // A selection cannot survive a reload of a different window.
    if (selected >= events.length) selected = -1
    lastSeries = tr || {}
    renderChart(lastPoints)
    renderEvents()
    renderCoverage(lastSeries)
    setConn(true)
  } catch {
    setConn(false)
  }
  // Outside the try on purpose: a failing session view must not cost the curve,
  // and a failing curve must not cost the session view.
  loadSessions()
}

// Same pill states as the other pages ('conn live' / 'conn down' in styles.css).
function setConn (ok) {
  if (!connEl) return
  connEl.className = 'conn ' + (ok ? 'live' : 'down')
  connLbl.textContent = ok ? T('conn.live') : T('conn.offline')
}

rangeSeg.addEventListener('click', e => {
  const b = e.target.closest('button[data-r]')
  if (!b) return
  range = b.dataset.r
  saveRange(range)
  selected = -1
  rangeSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.r === range))
  load()
})
rangeSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.r === range))

const minSel = $('minSel')
if (minSel) {
  minSel.value = minDiv
  minSel.addEventListener('change', () => {
    minDiv = minSel.value
    saveMinDiv(minDiv)
    selected = -1
    load()
  })
}

// ---- Identity (multi-user routing, no login) — mirrored from networth.js ----
const idgate = $('idgate')
const idbtns = $('idbtns')
const whoami = $('whoami')
const whoamiName = $('whoamiName')
let USERS = ['player1', 'player2']
let USER_LANGS = {}   // user -> client language, from GET /users (POE_USER_LANGS)
const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1)

function readCookie (name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : null
}
function setUserCookie (u) { document.cookie = 'ppt_user=' + encodeURIComponent(u) + '; path=/; max-age=31536000; samesite=lax' }
function clearUserCookie () { document.cookie = 'ppt_user=; path=/; max-age=0; samesite=lax' }
function showIdGate () {
  if (!idgate) return
  idbtns.innerHTML = USERS.map(u => `<button type="button" data-user="${esc(u)}">${esc(cap(u))}</button>`).join('')
  idgate.hidden = false
}
if (idbtns) idbtns.addEventListener('click', e => {
  const b = e.target.closest('button[data-user]')
  if (!b || !USERS.includes(b.dataset.user)) return
  setUserCookie(b.dataset.user)
  I18n.applyUsers(USER_LANGS, b.dataset.user)
  idgate.hidden = true
  whoamiName.textContent = b.dataset.user
  whoami.hidden = false
  connect(); load()
})
if (whoami) whoami.addEventListener('click', () => { clearUserCookie(); showIdGate() })

async function initIdentity () {
  try {
    const r = await fetch('/users')
    const j = await r.json()
    if (Array.isArray(j.users) && j.users.length) USERS = j.users
    if (j.langs && typeof j.langs === 'object') USER_LANGS = j.langs
    if (j.appName) window.Shell.applyBrand(j.appName, 'nav.history')
  } catch { /* keep fallback list + fallback brand */ }
  const cookie = readCookie('ppt_user')
  I18n.applyUsers(USER_LANGS, cookie)
  if (cookie && USERS.includes(cookie)) {
    whoamiName.textContent = cookie
    whoami.hidden = false
    connect(); load()
  } else showIdGate()
}

// ---- WebSocket: only for the global rail slots (C:D tile, league, M2) -------
// The page's own data is polled — the server broadcasts no history events, and
// a socket that reconnects is not a reason to redraw a chart.
let ws = null
let retry = 0
function sendSafe (obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)) }

function connect () {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  try { ws = new WebSocket(`${proto}://${location.host}/events`) } catch { return }
  ws.addEventListener('open', () => { retry = 0; setConn(true) })
  ws.addEventListener('close', () => {
    setConn(false)
    retry = Math.min(retry + 1, 6)
    setTimeout(connect, 500 * 2 ** retry)
  })
  ws.addEventListener('message', ev => {
    let msg = null
    try { msg = JSON.parse(ev.data) } catch { return }
    switch (msg.type) {
      case 'cd-ratio': window.Shell.applyCdRatio(msg); break
      case 'league-state': window.Shell.applyLeagueState(msg); break
      case 'data-status': window.Shell.applyDataStatus(msg); break
      case 'release-status': window.Shell.applyReleaseStatus(msg); break
      case 'source-status': window.Shell.applySourceStatus(msg); break
      case 'networth-sync-status': window.Shell.applySyncStatus(msg); break
      // The running farm session: the status line, and this page's own view.
      case 'networth-session': window.Shell.applySessionStatus(msg); loadSessions(); break
      // A finished stash sync is the one broadcast worth reacting to: it is
      // exactly when a new point (and possibly a new event) exists.
      case 'networth-result': load(); break
    }
  })
}

window.Shell.initLeague(obj => sendSafe(obj))

// The chart labels, the event list, the rail summary and the session view are
// all built from the string table — a language change has to redraw them all.
I18n.onChange(() => {
  renderChart(lastPoints)
  renderEvents()
  if (lastSeries) renderCoverage(lastSeries)
  renderSessions()
})

setInterval(load, POLL_MS)
initIdentity()
