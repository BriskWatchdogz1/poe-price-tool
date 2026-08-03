// Global shell helpers — shared by all three pages (classic script, loaded
// BEFORE the page script). Owns the rail slots that look identical everywhere:
// brand (R1), league selector (R4), C:D tile (R5) and the reserved status
// line (M2). Pages keep their own WebSocket and forward the broadcast
// messages (`cd-ratio`, `league-state`) here; `initLeague` gets the page's
// send function so the change listener works over that same socket.
'use strict'

window.Shell = (() => {
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // ---- R1 brand: server-configured app name (POE_APP_NAME) -----------------
  // HTML fallback ("Trade Console") stays if this never runs. `pageTitle` is
  // the page name shown in the tab; without it (Price Check = the app's home)
  // the title is just the app name.
  function applyBrand (name, pageTitle) {
    if (!name) return
    const b = document.querySelector('.rail .logo b')
    if (b) b.textContent = name
    document.title = pageTitle ? `${pageTitle} — ${name}` : `${name} — Path of Exile`
  }

  // ---- R4 league selector --------------------------------------------------
  const leagueSel = document.getElementById('leagueSel')

  function populateLeagues (list, active) {
    if (!leagueSel) return
    const arr = Array.isArray(list) && list.length ? list.slice() : ['Standard', 'Hardcore']
    if (active && !arr.includes(active)) arr.unshift(active)
    leagueSel.innerHTML = arr.map(l =>
      `<option value="${esc(l)}"${l === active ? ' selected' : ''}>${esc(l)}</option>`).join('')
  }

  async function loadLeagues (active) {
    try {
      const r = await fetch('/leagues')
      const j = await r.json()
      populateLeagues(j.leagues, active || j.active)
    } catch { populateLeagues(null, active) }
  }

  // Wire the selector to the page's WS send function and load the list.
  function initLeague (sendFn) {
    if (!leagueSel) return
    leagueSel.addEventListener('change', () =>
      sendFn({ type: 'set-league', league: leagueSel.value }))
    loadLeagues()
  }

  // Server broadcast of the active league (also on changes by other clients).
  function applyLeagueState (msg) {
    if (!leagueSel) return
    const active = msg.active
    if (!active) return
    if (!leagueSel.options.length) { loadLeagues(active); return }
    if (![...leagueSel.options].some(o => o.value === active)) {
      const o = document.createElement('option'); o.value = active; o.textContent = active
      leagueSel.appendChild(o)
    }
    leagueSel.value = active
  }

  // ---- R5 C:D tile ---------------------------------------------------------
  const cdValue = document.getElementById('cdValue')
  const cdConv = document.getElementById('cdConv')
  const cdTrend = document.getElementById('cdTrend')
  const cdArea = document.getElementById('cdArea')
  const cdLine = document.getElementById('cdLine')
  const cdDot = document.getElementById('cdDot')

  // Redraw the rail C:D spark from the 7-day sparkline (viewBox 0 0 240 34).
  function drawCdSpark (data) {
    if (!cdLine || !Array.isArray(data) || data.length < 2) return
    const W = 240, H = 34, top = 4, bot = 30
    const min = Math.min(...data), max = Math.max(...data), span = (max - min) || 1
    const pts = data.map((v, i) => [
      (i / (data.length - 1) * W),
      bot - (v - min) / span * (bot - top)
    ])
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
    cdLine.setAttribute('d', line)
    cdArea.setAttribute('d', `${line} L${W},${H} L0,${H} Z`)
    const end = pts[pts.length - 1]
    cdDot.setAttribute('cx', end[0].toFixed(1))
    cdDot.setAttribute('cy', end[1].toFixed(1))
  }

  function applyCdRatio (msg) {
    if (!cdValue) return
    cdValue.textContent = msg.chaosPerDivine
    cdConv.textContent = msg.chaosPerDivine
    cdTrend.textContent = msg.trendHint || 'live'
    if (Array.isArray(msg.sparkline) && msg.sparkline.length) drawCdSpark(msg.sparkline)
  }

  // ---- M2 status line ------------------------------------------------------
  // Reserved slot for operational states. SEVERAL sources write here (the
  // net-worth sync status and the data auto-update freshness note), so the
  // slot holds a KEYED set of messages instead of one string: each key owns
  // one line inside the slot, keys never overwrite each other, and the render
  // order is fixed (STATUS_ORDER) so a message never jumps around. The slot
  // collapses only when the last message is gone.
  const statusEl = document.getElementById('appStatus')
  const statusMsgs = new Map()
  const STATUS_ORDER = ['sync', 'data'] // actionable first, informational after

  function renderStatus () {
    if (!statusEl) return
    const keys = [...statusMsgs.keys()].sort((a, b) => {
      const ia = STATUS_ORDER.indexOf(a); const ib = STATUS_ORDER.indexOf(b)
      return (ia < 0 ? STATUS_ORDER.length : ia) - (ib < 0 ? STATUS_ORDER.length : ib)
    })
    statusEl.textContent = ''
    for (const k of keys) {
      const el = document.createElement('span')
      el.className = 'statusmsg'
      el.dataset.statusKey = k
      el.textContent = statusMsgs.get(k)
      statusEl.appendChild(el)
    }
    statusEl.hidden = keys.length === 0
  }

  // setStatus(text, key) — empty text clears that key.
  function setStatus (text, key = 'general') {
    if (!text) { clearStatus(key); return }
    statusMsgs.set(key, String(text))
    renderStatus()
  }
  // clearStatus(key) removes one message, clearStatus() the whole slot.
  function clearStatus (key) {
    if (key === undefined) statusMsgs.clear()
    else statusMsgs.delete(key)
    renderStatus()
  }

  // ---- M2: data auto-update freshness --------------------------------------
  // The server sends the raw facts (`data-status`), the page decides: a source
  // whose last SUCCESSFUL check is older than staleAfterMs gets a line. The
  // ageing runs client-side on a timer, so a backend whose schedule died
  // silently still turns the line on without any further message.
  let dataStatus = null
  let dataTimer = null

  function ageText (ms) {
    const h = Math.floor(ms / 3600000)
    if (h < 48) return `${h} hours`
    return `${Math.floor(h / 24)} days`
  }

  function staleSources (st, nowMs) {
    if (!st || !st.enabled) return []
    // Age against the SERVER clock (all timestamps are the server's): take its
    // `now` from the message and add the time elapsed since it arrived — a
    // client clock that is off by hours must not fake or hide staleness.
    const serverNow = st.now + (nowMs - st.receivedAt)
    return (st.sources || [])
      .map(s => ({ source: s.source, ageMs: serverNow - (s.lastSuccessAt || st.since || st.now) }))
      .filter(s => s.ageMs >= st.staleAfterMs)
      .sort((a, b) => b.ageMs - a.ageMs)
  }

  function dataStatusText (st, nowMs) {
    const stale = staleSources(st, nowMs)
    if (!stale.length) return ''
    const list = stale.map(s => `${s.source} for ${ageText(s.ageMs)}`).join(', ')
    return `Data auto-update: no successful check of ${list} — the tool keeps running with the data it has.`
  }

  function refreshDataStatus () {
    setStatus(dataStatusText(dataStatus, Date.now()), 'data')
  }

  function applyDataStatus (msg) {
    dataStatus = { ...msg, receivedAt: Date.now() }
    refreshDataStatus()
    if (!dataTimer) dataTimer = setInterval(refreshDataStatus, 60 * 1000)
  }

  return {
    applyBrand,
    initLeague,
    applyLeagueState,
    applyCdRatio,
    applyDataStatus,
    setStatus,
    clearStatus,
    // exposed for the local tests
    _dataStatusText: dataStatusText
  }
})()
