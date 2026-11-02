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
  // `pageTitleKey` is an i18n key ('nav.networth'/'nav.history'), not a literal:
  // the tab title has to follow the language like everything else.
  let brandName = null
  let brandPageKey = null
  function applyBrand (name, pageTitleKey) {
    if (name) brandName = name
    if (pageTitleKey) brandPageKey = pageTitleKey
    if (!brandName) return
    const b = document.querySelector('.rail .logo b')
    if (b) b.textContent = brandName
    document.title = brandPageKey
      ? `${window.I18n.t(brandPageKey)} — ${brandName}`
      : `${brandName} — ${window.I18n.t('app.subtitle')}`
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
  //
  // `lang` rides on this message on connect AND after a language switch through
  // POST /user-lang (PROTOCOL.md). Applying it here rather than in each page is
  // what makes the switch reach every tab this user has open — including the
  // ones that were never told about the settings page. A `set-league` broadcast
  // carries no `lang`, so the guard below is what keeps the league from
  // resetting the language.
  function applyLeagueState (msg) {
    if (msg && msg.lang) window.I18n.setLang(msg.lang)
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
    cdTrend.textContent = window.I18n.srv(msg.trendHint) || window.I18n.t('rail.cdTrendFallback')
    if (Array.isArray(msg.sparkline) && msg.sparkline.length) drawCdSpark(msg.sparkline)
  }

  // ---- M2 status line ------------------------------------------------------
  // Reserved slot for operational states. SEVERAL sources write here (the
  // net-worth sync status, the data auto-update freshness note and the notice
  // that a newer release exists), so the slot holds a KEYED set of messages
  // instead of one string: each key owns one line inside the slot, keys never
  // overwrite each other, and the render order is fixed (STATUS_ORDER) so a
  // message never jumps around. The slot collapses only when the last message
  // is gone.
  const statusEl = document.getElementById('appStatus')
  const statusMsgs = new Map()
  const STATUS_ORDER = ['sync', 'data', 'release'] // actionable first, informational after

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
    if (h < 48) return window.I18n.t('shell.ageHours', { n: h })
    return window.I18n.t('shell.ageDays', { n: Math.floor(h / 24) })
  }

  // A class whose diagnosis is CERTAIN the moment it is made, so waiting for the
  // staleness threshold buys nothing. `incompatible` means the export read the
  // data and the schema does not match this build — a fact, not a symptom of a
  // duration. Three silent days on a known cause is precisely the defect this
  // whole line exists to remove, so this one skips the wait.
  //
  // `unreachable` and `rejected` deliberately do not: an upstream that is away
  // for an hour is not news, and a run that failed once may well succeed on the
  // next tick. There the age IS the information.
  const REPORT_AT_ONCE = new Set(['incompatible'])

  function relevantSources (st, nowMs) {
    if (!st || !st.enabled) return []
    // Age against the SERVER clock (all timestamps are the server's): take its
    // `now` from the message and add the time elapsed since it arrived — a
    // client clock that is off by hours must not fake or hide staleness.
    const serverNow = st.now + (nowMs - st.receivedAt)
    return (st.sources || [])
      .map(s => ({
        source: s.source,
        ageMs: serverNow - (s.lastSuccessAt || st.since || st.now),
        reason: s.reason || '',
        warning: s.warning || '',
        failKind: s.failKind || ''
      }))
      .map(s => ({ ...s, stale: s.ageMs >= st.staleAfterMs }))
      // Three ways onto the line, and only the first of them is about time:
      // it has been quiet too long; its cause is already certain; or a check
      // that SUCCEEDED has something to report (a data set frozen on a pinned
      // patch never goes stale, and that is exactly what is wrong with it).
      .filter(s => s.stale || (s.reason && REPORT_AT_ONCE.has(s.failKind)) || s.warning)
      .sort((a, b) => b.ageMs - a.ageMs)
  }

  // What each class of failure means for the reader — and the reason there is no
  // `unknown` entry: a failure nobody classified gets its reason printed and NO
  // advice. Mapped by key rather than concatenated into one, so a class from a
  // newer server shows nothing instead of a missing-key placeholder.
  const DATA_ADVICE_KEYS = {
    unreachable: 'shell.dataAdvice.unreachable',
    rejected: 'shell.dataAdvice.rejected',
    incompatible: 'shell.dataAdvice.incompatible'
  }

  function dataStatusText (st, nowMs) {
    const shown = relevantSources(st, nowMs)
    if (!shown.length) return ''
    const parts = []
    // The duration and what it costs — only for the sources that really have
    // been quiet. A source reported for a certain cause or for a warning is not
    // stale, and saying it is would be the wrong finding.
    const stale = shown.filter(s => s.stale)
    if (stale.length) {
      const list = stale.map(s =>
        window.I18n.t('shell.dataStaleSource', { source: s.source, age: ageText(s.ageMs) })).join(', ')
      parts.push(window.I18n.t('shell.dataStale', { list }))
    }
    // The cause, per source that has one. Without it the line says how long and
    // what it costs, and leaves the one question it exists for — is this waiting
    // out an outage or is it broken — to the container log (docs/bugs.md B24).
    for (const s of shown) {
      if (s.reason) {
        parts.push(window.I18n.t('shell.dataStaleReason', { source: s.source, reason: s.reason }))
        const key = DATA_ADVICE_KEYS[s.failKind]
        if (key) parts.push(window.I18n.t(key))
      }
      // A warning carries no class and gets no advice: it is a finding the
      // check made about itself, and inventing a remedy for it here would be
      // the same mistake in a new place.
      if (s.warning) {
        parts.push(window.I18n.t('shell.dataWarning', { source: s.source, warning: s.warning }))
      }
    }
    return parts.join(' ')
  }

  function refreshDataStatus () {
    setStatus(dataStatusText(dataStatus, Date.now()), 'data')
  }

  function applyDataStatus (msg) {
    dataStatus = { ...msg, receivedAt: Date.now() }
    refreshDataStatus()
    if (!dataTimer) dataTimer = setInterval(refreshDataStatus, 60 * 1000)
  }

  // ---- Newer release of the tool --------------------------------------------
  // `release-status` reaches every page. The server derives `comparison`
  // (newer / current / unknown) from the installed and the latest version, so
  // the page only decides whether to speak: only `newer` does, and only when the
  // message names both versions. A text-only line (the slot is textContent): the
  // link and the update steps live on the settings page.
  let releaseStatus = null

  function releaseStatusText (st) {
    if (!st || st.comparison !== 'newer' || !st.latest || !st.latest.version || !st.installed) return ''
    return window.I18n.t('shell.releaseNewer', { latest: st.latest.version, installed: st.installed })
  }

  function refreshReleaseStatus () {
    setStatus(releaseStatusText(releaseStatus), 'release')
  }

  function applyReleaseStatus (msg) {
    releaseStatus = msg || null
    refreshReleaseStatus()
  }

  // ---- Background-sync pause on pages without their own sync display --------
  // `networth-sync-status` reaches every page. Net Worth and settings draw a
  // richer line of their own (cooldown times, who was rate-limited) and do NOT
  // call this. History and Price Check call it so a stored POESESSID that has
  // expired -- the one state that silently stops all stash syncing until a
  // person acts -- shows up there too. Every other state clears the key: the
  // cooldowns lift by themselves and `missing` is not a pause.
  let syncStatus = null

  function syncStatusText (st) {
    return st && st.state === 'expired' ? window.I18n.t('shell.syncExpired') : ''
  }

  function refreshSyncStatus () {
    setStatus(syncStatusText(syncStatus), 'sync')
  }

  function applySyncStatus (msg) {
    syncStatus = msg ? { state: msg.state } : null
    refreshSyncStatus()
  }

  // A language switch after /users answered has to redraw what this module
  // owns: the tab title and the M2 lines.
  window.I18n.onChange(() => { applyBrand(); refreshDataStatus(); refreshSyncStatus(); refreshReleaseStatus() })

  return {
    applyBrand,
    initLeague,
    applyLeagueState,
    applyCdRatio,
    applyDataStatus,
    applySyncStatus,
    applyReleaseStatus,
    setStatus,
    clearStatus,
    // exposed for the local tests
    _dataStatusText: dataStatusText
  }
})()
