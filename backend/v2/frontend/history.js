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
import { chartGeometry, markerAt, CHART } from './history-chart.js'

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

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
let cdRatio = 0          // chaos per divine, from the last trend payload
let events = []
let geo = null
let selected = -1

// ---- formatting -------------------------------------------------------------
// Values are shown in divine once they are worth a divine, in chaos below that
// — same rule as the Net Worth totals, so a number means the same thing on both
// pages. cdRatio comes from the series itself, never from a constant.
function money (chaos, { sign = false } = {}) {
  const n = Number(chaos) || 0
  const a = Math.abs(n)
  const s = sign && n > 0 ? '+' : n < 0 ? '−' : ''
  if (cdRatio > 0 && a >= cdRatio) {
    const d = a / cdRatio
    return `${s}${d >= 100 ? Math.round(d) : d.toFixed(1)}d`
  }
  return `${s}${a >= 100 ? Math.round(a) : Math.round(a * 10) / 10}c`
}
const clock = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
// Over a day the time of day says nothing — the axis switches to the date.
const day = at => new Date(at).toLocaleDateString([], { day: '2-digit', month: '2-digit' })
const axisLabel = at => (RANGES.indexOf(range) >= 3 ? day(at) : clock(at))
const clockSec = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function ago (ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min ago`
  const h = m / 60
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10}h ago`
}
function span (ms) {
  const m = Math.round(ms / 60000)
  if (m < 90) return `${m} min`
  const h = m / 60
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10}h`
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
  for (const t of geo.valueTicks) {
    parts.push(`<line class="grid" x1="${x0}" x2="${x1}" y1="${t.y}" y2="${t.y}"/>`)
    parts.push(`<text class="axlbl" x="${x0 - 8}" y="${t.y + 3.5}" text-anchor="end">${esc(money(t.v))}</text>`)
  }
  for (const t of geo.timeTicks) {
    parts.push(`<text class="axlbl" x="${t.x}" y="${CHART.h - 8}" text-anchor="middle">${esc(axisLabel(t.at))}</text>`)
  }
  parts.push(`<path class="tarea" d="${geo.area}"/>`)
  // Falling stretches are drawn red, rising ones green — the direction has to be
  // readable BETWEEN the dots, not just on them.
  for (const seg of geo.segments) {
    parts.push(`<path class="tline${seg.down ? ' dn' : ''}" d="${seg.d}"/>`)
  }
  geo.markers.forEach((m, i) => {
    const cls = `edot${m.v < 0 ? ' neg' : ''}${i === selected ? ' sel' : ''}`
    parts.push(`<circle class="${cls}" cx="${m.x}" cy="${m.y}" r="${i === selected ? 6 : 4.5}" data-i="${i}">` +
      `<title>${esc(clockSec(m.at))} · ${esc(money(m.v, { sign: true }))}</title></circle>`)
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
    evNone.textContent = geo && !geo.empty
      ? 'Nothing came in or went out in this window. The curve still moves with prices.'
      : 'No history recorded yet for this window.'
    evNote.textContent = ''
    return
  }
  evNone.hidden = true
  const bar = minDiv === '0' ? 'everything recorded' : `from ${minDiv} div`
  evNote.textContent = `${events.length} ${events.length === 1 ? 'event' : 'events'} · stock movements only · ${bar}`
  // Newest first: the question is almost always "what just happened?".
  eventsEl.innerHTML = events.map((e, i) => {
    const rows = e.items.map(([name, dq, chaos]) => {
      const cls = chaos < 0 ? 'loss' : 'gain'
      const q = dq > 0 ? `+${dq}` : String(dq)
      return `<div class="evrow"><span class="n">${esc(name)}</span>` +
        `<span class="q">${esc(q)}</span>` +
        `<span class="v ${cls}">${esc(money(chaos, { sign: true }))}</span></div>`
    }).join('')
    return `<div class="ev${i === selected ? ' sel' : ''}" data-i="${i}" id="ev-${i}">` +
      `<div class="evtop"><span class="evtime">${esc(eventWhen(e))}</span>` +
      `<span class="evago">${esc(ago(now - e.at))}</span>` +
      `<span class="evsum ${e.v < 0 ? 'loss' : 'gain'}">${esc(money(e.v, { sign: true }))}</span></div>` +
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
  const net = pts.length >= 2 ? pts[pts.length - 1][1] - pts[0][1] : 0
  const el = $('covNet')
  el.textContent = pts.length >= 2 ? money(net, { sign: true }) : '—'
  el.className = net < 0 ? 'loss' : 'gain'

  const moved = events.reduce((s, e) => s + e.v, 0)
  headSum.innerHTML = pts.length
    ? `now <b>${esc(money(pts[pts.length - 1][1]))}</b> · stock moved ${esc(money(moved, { sign: true }))}`
    : ''
}

// ---- data -------------------------------------------------------------------
let lastPoints = []

async function load () {
  try {
    const [tr, ev] = await Promise.all([
      fetch(`/networth-trend?range=${encodeURIComponent(range)}`).then(r => r.json()),
      fetch(`/networth-events?range=${encodeURIComponent(range)}&minDiv=${encodeURIComponent(minDiv)}`).then(r => r.json())
    ])
    if (tr && Array.isArray(tr.points)) {
      lastPoints = tr.points
      const last = tr.points[tr.points.length - 1]
      if (last && Number(last[2]) > 0) cdRatio = Number(last[2])
    }
    events = (ev && Array.isArray(ev.events)) ? ev.events : []
    // A selection cannot survive a reload of a different window.
    if (selected >= events.length) selected = -1
    renderChart(lastPoints)
    renderEvents()
    renderCoverage(tr || {})
    setConn(true)
  } catch {
    setConn(false)
  }
}

// Same pill states as the other pages ('conn live' / 'conn down' in styles.css).
function setConn (ok) {
  if (!connEl) return
  connEl.className = 'conn ' + (ok ? 'live' : 'down')
  connLbl.textContent = ok ? 'live' : 'offline'
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
    if (j.appName) window.Shell.applyBrand(j.appName, 'History')
  } catch { /* keep fallback list + fallback brand */ }
  const cookie = readCookie('ppt_user')
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
      // A finished stash sync is the one broadcast worth reacting to: it is
      // exactly when a new point (and possibly a new event) exists.
      case 'networth-result': load(); break
    }
  })
}

window.Shell.initLeague(obj => sendSafe(obj))
setInterval(load, POLL_MS)
initIdentity()
