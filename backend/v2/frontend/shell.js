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

  // The C:D foot ages like the status lines (docs/bugs.md B29): a value that
  // came from poe.ninja carries `asOf`, and once it is older than
  // `staleAfterMs` the foot says "stale · poe.ninja · 5 h" instead of the
  // server's "live" hint — and stops being green. The fallback carries no asOf
  // and keeps its hint.
  let cdMsg = null

  function ageShort (ms) {
    const h = Math.floor(ms / 3600000)
    if (h < 48) return window.I18n.t('shell.ageShortHours', { n: h })
    return window.I18n.t('shell.ageShortDays', { n: Math.floor(h / 24) })
  }

  function cdTrendText (msg, nowMs) {
    if (msg && typeof msg.asOf === 'number' && typeof msg.staleAfterMs === 'number' && typeof msg.now === 'number') {
      const age = msg.now + (nowMs - (msg.receivedAt || nowMs)) - msg.asOf
      if (age >= msg.staleAfterMs) return { text: window.I18n.t('rail.cdStale', { age: ageShort(age) }), stale: true }
    }
    return { text: (msg && window.I18n.srv(msg.trendHint)) || window.I18n.t('rail.cdTrendFallback'), stale: false }
  }

  function refreshCdTrend () {
    if (!cdTrend || !cdMsg) return
    const r = cdTrendText(cdMsg, Date.now())
    cdTrend.textContent = r.text
    cdTrend.classList.toggle('stale', r.stale)
    cdTrend.classList.toggle('up', !r.stale)
  }

  function applyCdRatio (msg) {
    if (!cdValue) return
    cdMsg = { ...msg, receivedAt: Date.now() }
    cdValue.textContent = msg.chaosPerDivine
    cdConv.textContent = msg.chaosPerDivine
    refreshCdTrend()
    ensureTick()
    if (Array.isArray(msg.sparkline) && msg.sparkline.length) drawCdSpark(msg.sparkline)
  }

  // ---- M2 status line ------------------------------------------------------
  // Reserved slot for operational states. SEVERAL sources write here (the
  // net-worth sync status, the data auto-update freshness note, the notice
  // that a newer release exists, the two price-source lines and a running farm
  // session), so the slot
  // holds a KEYED set of messages
  // instead of one string: each key owns one line inside the slot, keys never
  // overwrite each other, and the render order is fixed (STATUS_ORDER) so a
  // message never jumps around. The slot collapses only when the last message
  // is gone.
  const statusEl = document.getElementById('appStatus')
  const statusMsgs = new Map()
  // The blind summary first (it is the one that says prices are not current),
  // then actionable, then a running farm session, then informational.
  const STATUS_ORDER = ['blind', 'sync', 'sources', 'session', 'daemon', 'data', 'release']

  function renderStatus () {
    if (!statusEl) return
    const keys = [...statusMsgs.keys()].sort((a, b) => {
      const ia = STATUS_ORDER.indexOf(a); const ib = STATUS_ORDER.indexOf(b)
      return (ia < 0 ? STATUS_ORDER.length : ia) - (ib < 0 ? STATUS_ORDER.length : ib)
    })
    statusEl.textContent = ''
    for (const k of keys) {
      const el = document.createElement('span')
      el.className = 'statusmsg' + (k === 'blind' ? ' blind' : '')
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

  // Two age words, because German needs two cases. ageText is the plain form
  // ("5 hours old", "3 Tage alt"); every sentence that puts the age after
  // "for"/"seit" or "ago"/"vor" takes durationText (daemonAgeText below, the
  // pc.daemonAge* words), whose German forms are dative ("seit 3 Tagen", "seit
  // einer Stunde"). Both pick singular or plural.
  function ageText (ms) {
    const h = Math.floor(ms / 3600000)
    if (h < 48) return window.I18n.tn('shell.ageHour', h, { n: h })
    const d = Math.floor(h / 24)
    return window.I18n.tn('shell.ageDay', d, { n: d })
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
        window.I18n.t('shell.dataStaleSource', { source: s.source, age: daemonAgeText(s.ageMs) })).join(', ')
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
    ensureTick()
  }

  // One minute timer for everything on this page that ages against the server
  // clock: the data line, the price-source lines, the C:D foot and the running
  // farm session's duration. Started by
  // the first message that needs it, never twice.
  let tickTimer = null
  function ensureTick () {
    if (tickTimer) return
    tickTimer = setInterval(() => { refreshDataStatus(); refreshSourceStatus(); refreshCdTrend(); refreshSessionStatus() }, 60 * 1000)
  }

  // ---- Price sources: age and state (source-status, docs/bugs.md B29) -------
  // Same split as data-status: the server sends facts (last success, last
  // failure, reason, threshold per source), the page ages them against the
  // SERVER clock and decides what to say. One derivation, used by both lines
  // here and by the Sources block on the settings page (sourceView).
  //
  // Two lines on the slot:
  //   sources  every price source past its threshold, with age and reason.
  //   blind    the summary, and only when it adds something: no price source
  //            is fresh and at least one is stale (pricesBlind), or at least
  //            two parts are out at once (prices, a trade ban, an expired
  //            POESESSID). A single
  //            ban or a single expired cookie already has its own display —
  //            the banner, the sync line — and a second line saying the same
  //            would teach people to skip both.
  let sourceStatus = null
  let syncState = null
  const PRICE_SOURCES = ['faustus', 'ninja-cd', 'ninja-overview']

  function sourceView (st, nowMs) {
    if (!st || !Array.isArray(st.sources)) return []
    const serverNow = st.now + (nowMs - (st.receivedAt || nowMs))
    return st.sources.map(s => {
      const lastSuccessAt = typeof s.lastSuccessAt === 'number' ? s.lastSuccessAt : null
      const lastFailureAt = typeof s.lastFailureAt === 'number' ? s.lastFailureAt : null
      const enabled = s.enabled !== false
      const ageMs = serverNow - (lastSuccessAt ?? st.since ?? st.now)
      const failing = lastFailureAt != null && (lastSuccessAt == null || lastFailureAt > lastSuccessAt)
      const bar = Number.isFinite(s.staleAfterMs) ? s.staleAfterMs : null
      // A scheduled source may go stale by age alone (its timer should have
      // refreshed it); an on-demand one only when its last attempt failed —
      // nobody asking poe.ninja for a unique price is not an outage.
      const stale = enabled && bar != null && ageMs >= bar && (s.scheduled === true || failing)
      const fresh = enabled && lastSuccessAt != null && bar != null && serverNow - lastSuccessAt < bar
      const paused = enabled && typeof s.pausedUntil === 'number' && serverNow < s.pausedUntil
      return {
        source: s.source,
        enabled,
        scheduled: s.scheduled === true,
        lastSuccessAt,
        lastFailureAt,
        reason: s.reason || '',
        failKind: s.failKind || '',
        pausedUntil: paused ? s.pausedUntil : null,
        ageMs,
        failing,
        stale,
        fresh,
        paused
      }
    })
  }

  // The word the Sources block shows for one row of sourceView. A source that
  // was asked but never answered since the start is not "current", whatever its
  // age: without a success there is nothing current to show (docs/bugs.md B29).
  function sourceState (v) {
    if (!v.enabled) return 'disabled'
    if (v.paused) return 'paused'
    if (v.stale) return 'stale'
    if (v.lastSuccessAt == null) return v.lastFailureAt == null ? 'unused' : 'noAnswer'
    return 'ok'
  }

  function pricesBlind (view) {
    const p = view.filter(v => v.enabled && PRICE_SOURCES.includes(v.source))
    return p.some(v => v.stale) && !p.some(v => v.fresh)
  }

  function srcName (id) {
    const key = 'src.name.' + id
    const text = window.I18n.t(key)
    return text === key ? id : text
  }

  function clock (ms) {
    return new Date(ms).toLocaleTimeString(window.I18n.locale(), { hour: '2-digit', minute: '2-digit' })
  }

  function sourcesStatusText (st, nowMs) {
    const stale = sourceView(st, nowMs)
      .filter(v => v.stale && PRICE_SOURCES.includes(v.source))
      .sort((a, b) => b.ageMs - a.ageMs)
    if (!stale.length) return ''
    const sentences = stale.map(v => {
      const params = {
        source: srcName(v.source),
        age: ageText(v.ageMs),
        reason: v.reason || window.I18n.t('shell.reasonUnknown')
      }
      if (v.lastSuccessAt == null) return window.I18n.t('shell.sourceNever', { ...params, age: daemonAgeText(v.ageMs) })
      if (v.failing) return window.I18n.t('shell.sourceStale', params)
      return window.I18n.t('shell.sourceStaleQuiet', params)
    })
    return window.I18n.t('shell.sourcesLead') + ' ' + sentences.join(' ')
  }

  function blindStatusText (st, nowMs) {
    const view = sourceView(st, nowMs)
    const parts = []
    const blind = pricesBlind(view)
    if (blind) {
      // The age of the youngest SUCCESS. A source that never succeeded is aged
      // from the server start, which says nothing about how old the prices are
      // (a 5 h old Faustus store next to a poe.ninja that failed since a
      // restart 2 min ago read "for 0 hours"). With no success at all, the
      // server start is the only bound there is, and the sentence says so.
      const prices = view.filter(v => v.enabled && PRICE_SOURCES.includes(v.source))
      const done = prices.filter(v => v.lastSuccessAt != null).map(v => v.ageMs)
      parts.push(done.length
        ? window.I18n.t('shell.blindPrices', { age: daemonAgeText(Math.min(...done)) })
        : window.I18n.t('shell.blindPricesNever', { age: daemonAgeText(Math.max(...prices.map(v => v.ageMs))) }))
    }
    const trade = view.find(v => v.source === 'trade' && v.paused)
    if (trade) parts.push(window.I18n.t('shell.blindTrade', { time: clock(trade.pausedUntil) }))
    if (syncState === 'expired') parts.push(window.I18n.t('shell.blindCookie'))
    if (!blind && parts.length < 2) return ''
    return window.I18n.t('shell.blind', { list: parts.join(', ') })
  }

  function refreshSourceStatus () {
    const now = Date.now()
    setStatus(sourceStatus ? blindStatusText(sourceStatus, now) : '', 'blind')
    setStatus(sourceStatus ? sourcesStatusText(sourceStatus, now) : '', 'sources')
  }

  function applySourceStatus (msg) {
    sourceStatus = msg ? { ...msg, receivedAt: Date.now() } : null
    refreshSourceStatus()
    ensureTick()
  }

  // Net Worth and Settings draw their own, richer sync line and must not write
  // the shared one (sync-status.test.mjs), but the blind summary still needs to
  // know whether the cookie has expired.
  function noteSyncState (state) {
    syncState = state || null
    refreshSourceStatus()
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

  // ---- Running farm or game session (`networth-session`) --------------------
  // Facts from the server, the ticking clock is ours: the duration is aged
  // against the SERVER clock like data-status, once a minute (ensureTick). Only
  // a running session speaks, the farm session when one runs, else the game
  // session (one line, never both); an ended one waiting for confirmation is
  // the History page's business.
  let sessionStatus = null

  // "1:12" — hours and minutes, the hours unbounded (a forgotten session can
  // run past a day). The History page uses it too, through window.Shell.
  function fmtSessionDuration (ms) {
    const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000)
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
  }

  // Divine when the start had a rate, chaos otherwise, in the page language's
  // number format; '—' while there is no point to measure against.
  function fmtSessionValue (chaos, div) {
    const loc = window.I18n.locale()
    if (div != null && Number.isFinite(Number(div))) {
      const r = Math.round(Number(div) * 10) / 10
      const sign = r > 0 ? '+' : r < 0 ? '−' : ''
      return `${sign}${Math.abs(r).toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} div`
    }
    if (chaos == null || !Number.isFinite(Number(chaos))) return '—'
    const c = Math.round(Number(chaos))
    return `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c).toLocaleString(loc)}c`
  }

  // A changed stash (a tab came, went or was read for the first time, or
  // another league) counts that whole content as loot: no figure then, a
  // wrong one is worse than none. A starting session has no baseline yet, so
  // it says that instead of a figure.
  function sessionStatusText (st, nowMs) {
    const s = st && (st.running || st.game)
    if (!s) return ''
    const serverNow = (Number(st.now) || nowMs) + (nowMs - st.receivedAt)
    const dur = fmtSessionDuration(serverNow - s.startedAt)
    // A message without `kind` comes from a server that knew farm sessions only.
    const kind = window.I18n.t(s.kind === 'game' ? 'shell.sessKindGame' : 'shell.sessKindFarm')
    if (s.state === 'starting') return window.I18n.t('shell.sessionStarting', { kind, dur })
    if (s.stashChanged === true) return window.I18n.t('shell.sessionChanged', { kind, dur })
    return window.I18n.t('shell.session', { kind, dur, loot: fmtSessionValue(s.loot, s.lootDiv) })
  }

  function refreshSessionStatus () {
    setStatus(sessionStatusText(sessionStatus, Date.now()), 'session')
  }

  function applySessionStatus (msg) {
    sessionStatus = msg ? { ...msg, receivedAt: Date.now() } : null
    refreshSessionStatus()
    ensureTick()
  }

  // ---- Background-sync pause on pages without their own sync display --------
  // `networth-sync-status` reaches every page. Net Worth and settings draw a
  // richer line of their own (cooldown times, who was rate-limited) and do NOT
  // call this. History and Price Check call it so a stored POESESSID that has
  // expired -- the one state that silently stops all stash syncing until a
  // person acts -- shows up there too, and so does a slower pace while the
  // player's game is not running (`pace`, sync follows the game). Every other
  // state clears the key: the cooldowns lift by themselves and `missing` is
  // not a pause.
  let syncStatus = null

  function syncStatusText (st) {
    if (!st) return ''
    if (st.state === 'expired') return window.I18n.t('shell.syncExpired')
    if (st.state !== 'ok') return ''
    const parts = []
    // Sync follows the game (`pace`): said only while the sync runs normally.
    const pace = st.pace
    if (pace && (pace.mode === 'yields' || pace.mode === 'rests')) {
      const everyMs = Number(pace.everyMs) || 0
      if (everyMs <= 0) parts.push(window.I18n.t(pace.mode === 'yields' ? 'shell.syncYieldsFully' : 'shell.syncRestsFully'))
      else parts.push(window.I18n.t(pace.mode === 'yields' ? 'shell.syncYields' : 'shell.syncRests', { min: Math.max(1, Math.round(everyMs / 60000)) }))
    }
    // A session round: every tab of this player once from a session's start
    // or end (the baseline or the final balance waits for it). Next to a pace,
    // which says why it goes slowly.
    const r = st.sessionRound
    if (r && Number.isFinite(r.done) && Number.isFinite(r.total) && r.total > 0) {
      parts.push(window.I18n.t('shell.syncSessionRound', { done: r.done, total: r.total }))
    }
    return parts.join(' ')
  }

  function refreshSyncStatus () {
    setStatus(syncStatusText(syncStatus), 'sync')
  }

  function applySyncStatus (msg) {
    syncStatus = msg ? { state: msg.state, pace: msg.pace || null, sessionRound: msg.sessionRound || null } : null
    syncState = syncStatus ? syncStatus.state : null
    refreshSyncStatus()
    refreshSourceStatus()
  }

  // ---- Price Check empty state: the hotkey daemon's last item ---------------
  // `daemon-status` carries the raw facts; this turns them into the second
  // sentence under "No items in the queue". Pure, so the vm tests can call it,
  // and here because it ages a server timestamp the way the data line does:
  // the server's `now` plus the time since arrival, so a browser clock that is
  // off cannot move it. A message without `lastItemAt` says nothing.
  const DAEMON_OUTCOME_KEYS = {
    card: 'pc.daemonLastCard',
    'no-parser': 'pc.daemonLastNoParser',
    'parse-failed': 'pc.daemonLastParseFailed'
  }

  function daemonAgeText (ms) {
    const min = Math.floor(ms / 60000)
    if (min < 1) return window.I18n.t('pc.daemonAgeJustNow')
    if (min < 60) return window.I18n.tn('pc.daemonAgeMin', min, { n: min })
    const h = Math.floor(min / 60)
    if (h < 48) return window.I18n.tn('pc.daemonAgeHour', h, { n: h })
    const d = Math.floor(h / 24)
    return window.I18n.tn('pc.daemonAgeDay', d, { n: d })
  }

  function daemonHintText (st, nowMs) {
    if (!st || !Object.prototype.hasOwnProperty.call(st, 'lastItemAt')) return ''
    if (st.lastItemAt == null) return window.I18n.t('pc.daemonNone')
    const serverNow = (st.now || nowMs) + (nowMs - (st.receivedAt || nowMs))
    const age = daemonAgeText(Math.max(0, serverNow - st.lastItemAt))
    return window.I18n.t(DAEMON_OUTCOME_KEYS[st.outcome] || 'pc.daemonLastCard', { age })
  }

  // ---- The hotkey daemon's own report (`daemon-status`.daemon) ----------------
  // What the player's daemon said in its last heartbeat. A part that does not
  // work on the game machine (no PySide6, no notify-send, a failing back
  // channel) is named in the status line, so it is visible in the browser too.
  // Only states other than ok/off/starting/unknown are named; a state or a
  // feature this page has no words for appears as it came (the server lets
  // only short lower-case words through, and the line is set as text). Only
  // while a daemon reports (`instances` > 0): the features of a daemon that
  // went quiet are not a current fault (the server sends a daemon-status
  // when the last one goes quiet).
  const DAEMON_QUIET_STATES = ['ok', 'off', 'starting', 'unknown']
  const hasKey = key => Object.prototype.hasOwnProperty.call(window.I18n.STRINGS.en, key)

  // unparsed: whispers from this user's daemon that the server could read with
  // no template (`daemon-status`.unparsed, a count since the server started;
  // the texts are not kept). Said even before a heartbeat: the count is the
  // server's own.
  function daemonFeatureText (daemon, unparsed = 0) {
    const parts = []
    const features = daemon && daemon.features
    if (features && typeof features === 'object' && daemon.instances !== 0) {
      for (const [feature, state] of Object.entries(features)) {
        if (DAEMON_QUIET_STATES.includes(state)) continue
        const key = `pc.daemonFeature.${feature}.${state}`
        if (hasKey(key)) { parts.push(window.I18n.t(key)); continue }
        const nameKey = `pc.daemonFeatureName.${feature}`
        const name = hasKey(nameKey) ? window.I18n.t(nameKey) : feature
        parts.push(`${name} — ${state}`)
      }
    }
    const n = Number(unparsed) || 0
    if (n > 0) parts.push(window.I18n.tn('pc.daemonWhispersUnparsed', n, { n }))
    if (!parts.length) return ''
    return window.I18n.t('pc.daemonFeatures', { version: (daemon && daemon.version) || 'unknown', list: parts.join('; ') })
  }

  // The settings page's line under the release block: the daemon's version,
  // and when the latest release is newer, how to update. The comparison is the
  // release check's rule (release-check.mjs): `1.2.3` or `v1.2.3`, anything
  // else is not compared.
  const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/
  function isNewerVersion (latest, installed) {
    const a = VERSION_RE.exec(String(latest || ''))
    const b = VERSION_RE.exec(String(installed || ''))
    if (!a || !b) return false
    for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i])
    return false
  }

  // A daemon that went quiet (`instances` 0) keeps its last version, with a
  // note that it is not reporting now.
  function daemonVersionText (daemon, rel) {
    if (!daemon) return window.I18n.t('rel.daemonNone')
    const version = daemon.version || 'unknown'
    const latest = rel && rel.latest
    const text = latest && isNewerVersion(latest.version, version)
      ? window.I18n.t('rel.daemonBehind', { version, latest: latest.version })
      : window.I18n.t('rel.daemon', { version })
    return daemon.instances === 0 ? `${text} ${window.I18n.t('rel.daemonQuiet')}` : text
  }

  let daemonInfo = null
  let daemonUnparsed = 0
  function refreshDaemonStatus () { setStatus(daemonFeatureText(daemonInfo, daemonUnparsed), 'daemon') }
  // The Price Check page forwards every `daemon-status` here.
  function applyDaemonStatus (msg) {
    daemonInfo = (msg && msg.daemon) || null
    daemonUnparsed = (msg && Number(msg.unparsed)) || 0
    refreshDaemonStatus()
  }

  // A language switch after /users answered has to redraw what this module
  // owns: the tab title and the M2 lines.
  window.I18n.onChange(() => {
    applyBrand(); refreshDataStatus(); refreshSyncStatus(); refreshReleaseStatus()
    refreshSourceStatus(); refreshCdTrend(); refreshSessionStatus(); refreshDaemonStatus()
  })

  return {
    applyBrand,
    initLeague,
    applyLeagueState,
    applyCdRatio,
    applyDataStatus,
    applySyncStatus,
    applyReleaseStatus,
    applySourceStatus,
    applySessionStatus,
    fmtSessionDuration,
    fmtSessionValue,
    noteSyncState,
    sourceView,
    sourceState,
    setStatus,
    clearStatus,
    daemonHintText,
    daemonFeatureText,
    daemonVersionText,
    applyDaemonStatus,
    // "5 minutes", "2 hours", "3 days" — the settings page's Sources block
    // uses it; under an hour the hour-only age would read "0 hours".
    durationText: daemonAgeText,
    // exposed for the local tests
    _dataStatusText: dataStatusText,
    _sourcesStatusText: sourcesStatusText,
    _blindStatusText: blindStatusText,
    _sessionStatusText: sessionStatusText,
    _cdTrendText: cdTrendText
  }
})()
