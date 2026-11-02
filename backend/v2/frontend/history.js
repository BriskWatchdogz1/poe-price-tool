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
// AT — never of a rate held in this module. There used to be one such variable
// here, filled from the newest point of the series, and it was applied to every
// figure on the page: axis, tooltips, event rows, event sums, the window net
// and the header. A historical event cannot change by definition, and all of
// them changed with every rate tick.
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
    // the newest one into module state any more.
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
      case 'networth-sync-status': window.Shell.applySyncStatus(msg); break
      // A finished stash sync is the one broadcast worth reacting to: it is
      // exactly when a new point (and possibly a new event) exists.
      case 'networth-result': load(); break
    }
  })
}

window.Shell.initLeague(obj => sendSafe(obj))

// The chart labels, the event list and the rail summary are all built from the
// string table — a language change has to redraw all three.
I18n.onChange(() => {
  renderChart(lastPoints)
  renderEvents()
  if (lastSeries) renderCoverage(lastSeries)
})

setInterval(load, POLL_MS)
initIdentity()
