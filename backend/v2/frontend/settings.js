/* Settings page — the two things that are configured, and the one thing the
 * tool has to say about itself.
 *
 * WHY THIS PAGE EXISTS. The net-worth credentials and the gap view (design doc,
 * section 6) need a settings surface, and two would be one too many, so both
 * live here: the sync
 * credentials at the top, the admin area below and behind a password.
 *
 * THE ADMIN STATE MODEL, in one sentence, because it is easy to reinvent as
 * something bigger: the password is sent as a header on EVERY admin request,
 * kept in sessionStorage, and never exchanged for a token. There is no login
 * request, no logout request, no expiry — closing the tab is the logout, and
 * the server holds nothing at all (admin-auth.mjs).
 *
 * The view is pull, not push, and that is a deliberate limit of the design: the
 * operator does not have to SEARCH for gaps, but he does have to LOOK.
 */

import { syncLineText } from './networth-sync.js'

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// i18n shorthands — i18n.js is a classic script loaded before this module.
const I18n = window.I18n
const T = (k, p) => I18n.t(k, p)

const $ = id => document.getElementById(id)

// ---- Net-Worth sync credentials --------------------------------------------
// Moved verbatim from the Net Worth modal, minus the modal: same endpoint, same
// rules. The POESESSID field is ALWAYS empty — the stored value is never
// delivered to the browser in any form, so there is nothing to prefill.
const appStatusEl = $('appStatus')
const setState = $('setState')
const setAccount = $('setAccount')
const setSessid = $('setSessid')
const setHint = $('setHint')
const setErr = $('setErr')
const setSave = $('setSave')
const setOk = $('setOk')

let syncStatus = null       // last networth-sync-status message (state, until, mine, tradeBan, pace)
let cooldownTimer = null    // clears the "rate-limited" line once `until` passes

// The same line as the Net Worth page (networth-sync.js syncLineText): `mine:
// false` means another user's 429 stopped us too, `tradeBan` that it was the
// trade-API gate, `pace` that the sync follows the game; a session round
// (`sessionRound`) is said after it. Empty for a plain ok.
function statusLineText (st) {
  return syncLineText(st, T, I18n.locale())
}

function settingsStateText (st) {
  if (!st) return T('nw.setState.unknown')
  if (st.state === 'expired') return T('nw.setState.expired')
  if (st.state === 'cooldown') {
    // The credentials are fine in all three cases; the wordings differ in what
    // is holding the sync, because "renew your cookie" would be the wrong thing
    // to try for any of them — and a trade ban is not even about this path.
    const key = st.tradeBan ? 'nw.setState.tradeBan'
      : st.mine === false ? 'nw.setState.cooldownOther' : 'nw.setState.cooldown'
    return T(key, { at: st.until ? new Date(st.until).toLocaleTimeString(I18n.locale()) : T('nw.syncSoon') })
  }
  if (st.state === 'missing') return T('nw.setState.missing')
  return T('nw.setState.ok')
}

function renderSettingsState () {
  setState.textContent = settingsStateText(syncStatus)
  setState.classList.toggle('warn', !!syncStatus && syncStatus.state !== 'ok')
}

function applySyncStatus (st) {
  // The shell's blind summary needs to know about an expired cookie; the sync
  // line itself is written below, with this page's richer wording.
  if (window.Shell) window.Shell.noteSyncState(st && st.state)
  syncStatus = st
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null }
  // Keyed: the M2 slot is shared with the data auto-update note, so only OUR
  // message is written or removed here (see shell.js STATUS_ORDER).
  window.Shell.setStatus(statusLineText(st), 'sync')
  if (st && st.state === 'cooldown' && st.until) {
    const wait = Math.max(1000, st.until - Date.now() + 1000)
    // The rest of the message (a pace) stays the server's word.
    cooldownTimer = setTimeout(() => { if (syncStatus && syncStatus.state === 'cooldown') applySyncStatus({ ...syncStatus, state: 'ok', until: null }) }, wait)
  }
  renderSettingsState()
}

// Non-blocking plausibility hint (NO hard format check — if GGG changes the
// cookie format, the field must keep working). Live sessions have been 32 hex
// chars for years; anything else is most likely a paste accident.
function renderSessidHint () {
  const v = setSessid.value.trim()
  const odd = v.length > 0 && v.length !== 32
  setHint.hidden = !odd
  setHint.textContent = odd ? T('nw.setHint', { n: v.length }) : ''
}

function loadCredentials () {
  renderSettingsState()
  fetch('/networth/credentials')
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      if (!j) return
      if (j.accountName && !setAccount.value) setAccount.value = j.accountName
      if (j.status) applySyncStatus(j.status)
    })
    .catch(() => { /* the form stays usable — save reports its own errors */ })
}

async function saveSettings () {
  setErr.hidden = true; setErr.textContent = ''
  setOk.hidden = true
  setSave.disabled = true
  try {
    const r = await fetch('/networth/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountName: setAccount.value, poesessid: setSessid.value })
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) {
      setErr.textContent = (j && j.error) ? j.error : T('nw.saveFailedHttp', { status: r.status })
      setErr.hidden = false
      return
    }
    setSessid.value = ''          // never keep the value around after a save
    renderSessidHint()
    if (j && j.status) applySyncStatus(j.status)
    setOk.hidden = false
  } catch {
    setErr.textContent = T('nw.saveFailedNet')
    setErr.hidden = false
  } finally {
    setSave.disabled = false
  }
}

setSessid.addEventListener('input', renderSessidHint)
setSave.addEventListener('click', saveSettings)
setSessid.addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings() })
setAccount.addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings() })

// ---- Client language ---------------------------------------------------------
// The user's OWN setting, so it sits in the ordinary part of the page and goes
// out without the admin password (GET/POST /user-lang). It is a switch, not a
// form: selecting a language IS the save, because a "Save" button next to a
// single select only invents a state in which the page and the server disagree.
//
// On failure the select JUMPS BACK to the value the server last confirmed —
// leaving the new value standing would show a language that is not in force,
// which is the exact confusion this whole section exists to prevent.
const langSel = $('langSel')
const langOnly = $('langOnly')
const langErr = $('langErr')
const langOk = $('langOk')
const langNote = $('langNote')

// The language codes are wire values (they key the parser on the server); their
// display names are ordinary UI text and live in the string table. A code the
// table has no name for is shown as the code rather than as a missing key.
const LANG_NAME_KEYS = { en: 'lang.name.en', de: 'lang.name.de' }
const langName = code => (LANG_NAME_KEYS[code] ? T(LANG_NAME_KEYS[code]) : String(code))

let langState = null      // last { lang, available, persisted } from the server
let langBusy = false

function renderLangSection () {
  if (!langSel) return
  if (!langState) { langSel.disabled = true; return }
  // A switch made in ANOTHER tab arrives here as a `league-state` broadcast and
  // ends up in I18n; the select has to follow it, or this page would show the
  // old language as the current one.
  if (langState.available.includes(I18n.lang())) langState.lang = I18n.lang()
  const { lang, available, persisted } = langState
  langSel.innerHTML = available.map(code =>
    `<option value="${esc(code)}"${code === lang ? ' selected' : ''}>${esc(langName(code))}</option>`).join('')
  langSel.value = lang
  // One language is not a choice, but hiding the field would leave the user
  // wondering where the setting went — so it stays, visibly inert, with the
  // reason next to it.
  const single = available.length < 2
  langSel.disabled = single || langBusy
  langOnly.hidden = !single
  langOnly.textContent = single ? T('lang.onlyOne') : ''
  langNote.hidden = persisted !== false
  langNote.textContent = persisted === false ? T('lang.notPersisted') : ''
}

async function loadUserLang () {
  if (!langSel) return
  try {
    const r = await fetch('/user-lang', { credentials: 'same-origin' })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j || !Array.isArray(j.available)) return
    langState = { lang: j.lang, available: j.available, persisted: j.persisted }
    renderLangSection()
  } catch { /* the section stays disabled; nothing else on the page depends on it */ }
}

async function changeUserLang (next) {
  if (!langState || langBusy) return
  const previous = langState.lang
  if (next === previous) return
  langBusy = true
  langErr.hidden = true; langErr.textContent = ''
  langOk.hidden = true
  langSel.disabled = true
  try {
    const r = await fetch('/user-lang', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: next })
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) {
      langState.lang = previous
      langErr.textContent = (j && j.error) ? j.error : T('lang.failedHttp', { status: r.status })
      langErr.hidden = false
      return
    }
    langState = { lang: j.lang, available: j.available, persisted: j.persisted }
    langOk.hidden = false
    // The server also broadcasts `league-state` with the new language into every
    // tab of this user (shell.js applies it); doing it here as well means THIS
    // page has switched before the socket message arrives, and setLang() is a
    // no-op the second time.
    I18n.setLang(j.lang)
  } catch {
    langState.lang = previous
    langErr.textContent = T('lang.failedNet')
    langErr.hidden = false
  } finally {
    langBusy = false
    renderLangSection()   // also puts the select back on `previous` after a failure
  }
}

if (langSel) langSel.addEventListener('change', () => changeUserLang(langSel.value))

// ---- Admin area -------------------------------------------------------------
const ADMIN_HEADER = 'X-Admin-Password'
// sessionStorage, not localStorage: the state has to end with the tab. That is
// the whole expiry mechanism, on purpose.
const ADMIN_KEY = 'ppt_admin'

const admGate = $('admGate')
const admView = $('admView')
const admPass = $('admPass')
const admErr = $('admErr')
const admOpen = $('admOpen')
const admClose = $('admClose')
const admReload = $('admReload')
const admMeta = $('admMeta')
const admSkew = $('admSkew')
const admSkewNote = $('admSkewNote')
const admBuild = $('admBuild')
const admStrings = $('admStrings')
const admGaps = $('admGaps')

let admData = null

function adminSecret () {
  try { return sessionStorage.getItem(ADMIN_KEY) || '' } catch { return '' }
}
function storeAdminSecret (v) {
  try { v ? sessionStorage.setItem(ADMIN_KEY, v) : sessionStorage.removeItem(ADMIN_KEY) } catch { /* private mode */ }
}

const pct = x => new Intl.NumberFormat(I18n.locale(), { style: 'percent', maximumFractionDigits: 2 }).format(Number(x) || 0)
const when = ts => (ts ? new Date(ts).toLocaleString(I18n.locale()) : '—')
const num = n => new Intl.NumberFormat(I18n.locale()).format(Number(n) || 0)

// ---- rendering: the dataset offset ------------------------------------------
// Reads as a comparison, because that is what it is — every row is "how much of
// the English set did this language fail to carry". `status()` in the refresher
// cannot answer that; this is the new mechanism the design doc asks for.
function renderSkew (skew) {
  admSkewNote.textContent = T('adm.skewNote', { base: skew.base || '—', pct: pct(skew.warnRatio) })
  if (!skew.basePresent) {
    admSkew.innerHTML = `<p class="skewhead warn">${esc(T('adm.skewBaseAbsent', { base: skew.base || '—' }))}</p>`
    return
  }
  if (!skew.languages.length) {
    admSkew.innerHTML = `<p class="skewhead ok">${esc(T('adm.skewOk'))}</p>`
    return
  }
  const out = []
  for (const l of skew.languages) {
    if (!l.present) {
      out.push(`<p class="skewhead warn">${esc(T('adm.skewAbsent', { lang: l.lang }))}</p>`)
      continue
    }
    out.push(l.warn
      ? `<p class="skewhead warn">${esc(T('adm.skewWarn', { lang: l.lang, base: skew.base }))}</p>`
      : `<p class="skewhead ok">${esc(T('adm.skewOk'))}</p>`)
    for (const m of l.metrics) {
      out.push(
        `<div class="skewrow${m.warn ? ' warn' : ''}">` +
        `<span class="k">${esc(T('adm.metric.' + m.key))}</span>` +
        `<span class="v">${esc(T('adm.metricRow', { missing: num(m.missing), base: num(m.base), pct: pct(m.ratio) }))}</span>` +
        '</div>')
    }
    if (l.extra > 0) {
      out.push(`<p class="admdrop">${esc(T('adm.skewExtra', { n: num(l.extra), lang: l.lang, base: skew.base }))}</p>`)
    }
  }
  admSkew.innerHTML = out.join('')
}

// ---- rendering: where the localized set came from ----------------------------
// The skew rows measure a DISTANCE; these say when and out of what the set was
// made and what that run found. Every number comes from build-info.json next to
// the live data — a missing one is drawn as "unknown", never as a zero.
function buildRow (labelKey, value) {
  return '<div class="skewrow">' +
    `<span class="k">${esc(T(labelKey))}</span>` +
    `<span class="v">${esc(value)}</span>` +
    '</div>'
}

function renderBuild (langBuild) {
  if (!admBuild) return
  const rows = Array.isArray(langBuild) ? langBuild : []
  if (!rows.length) {
    admBuild.innerHTML = `<p class="admdrop">${esc(T('adm.buildNoLangs'))}</p>`
    return
  }
  const out = []
  for (const b of rows) {
    out.push(`<p class="admlang">${esc(T('adm.langSection', { lang: b.lang }))}</p>`)
    if (!b.present) {
      out.push(`<p class="skewhead warn">${esc(T('adm.buildAbsent', { lang: b.lang }))}</p>`)
      continue
    }
    out.push(buildRow('adm.buildAt', b.builtAt ? when(Date.parse(b.builtAt)) : T('adm.buildUnknown')))
    out.push(buildRow('adm.buildPatch', b.patch || T('adm.buildUnknown')))
    const r = b.run
    if (!r) {
      out.push(`<p class="admdrop">${esc(T('adm.buildNoRun'))}</p>`)
      continue
    }
    if (r.statsEn != null) {
      out.push(buildRow('adm.buildCovered',
        T('adm.buildCoveredValue', { covered: num(r.statsCovered), base: num(r.statsEn), gap: num(r.statsUncovered) })))
    }
    out.push(buildRow('adm.buildRegressed', r.regressed == null
      ? T('adm.buildUnknown')
      : T('adm.buildRegressedValue', {
          n: num(r.regressed),
          base: r.baselineCovered == null ? T('adm.buildFirstBuild') : num(r.baselineCovered)
        })))
    out.push(buildRow('adm.buildNewGaps', r.newGaps == null ? T('adm.buildUnknown') : num(r.newGaps)))
    if (r.itemsTotal != null) {
      out.push(buildRow('adm.buildItems',
        T('adm.buildItemsValue', { translated: num(r.itemsTranslated), base: num(r.itemsTotal), kept: num(r.itemsKeptEnglish) })))
    }
    // The gap nothing else shows: a namespace with no name source at all.
    // Its own line and a warning colour — every item of it is English, and no
    // other number on this page moves when it happens.
    for (const u of (r.unknownNamespaces || [])) {
      out.push(`<p class="skewhead warn">${esc(T('adm.buildUnknownNamespace', { namespace: u.namespace, n: num(u.lines) }))}</p>`)
    }
  }
  admBuild.innerHTML = out.join('')
}

// The display-text tables, compared at the last English adoption. A separate
// question from the data sets above: these files are hand written and ship with
// the image, so a difference is closed by a container update and by nothing the
// refresher can do.
function renderClientStrings (drift) {
  if (!admStrings) return
  if (!drift || !drift.langs) { admStrings.innerHTML = ''; return }
  const out = []
  for (const [lang, d] of Object.entries(drift.langs)) {
    if (d.unreadable) {
      out.push(`<p class="skewhead warn">${esc(T('adm.stringsUnreadable', { lang, why: d.unreadable }))}</p>`)
      continue
    }
    if (!d.missingCount && !d.extraCount) {
      out.push(`<p class="skewhead ok">${esc(T('adm.stringsOk', { lang, n: num(d.enKeys) }))}</p>`)
      continue
    }
    if (d.missingCount) {
      out.push(`<p class="skewhead warn">${esc(T('adm.stringsMissing', {
        lang, n: num(d.missingCount), keys: (d.missing || []).join(', ')
      }))}</p>`)
    }
    if (d.extraCount) {
      out.push(`<p class="admdrop">${esc(T('adm.stringsExtra', {
        lang, n: num(d.extraCount), keys: (d.extra || []).join(', ')
      }))}</p>`)
    }
  }
  if (drift.at) out.push(`<p class="admdrop">${esc(T('adm.stringsAt', { at: when(drift.at) }))}</p>`)
  admStrings.innerHTML = out.join('')
}

// ---- rendering: the gap list -------------------------------------------------
// One block per kind, inside it one table per language, rows already sorted by
// frequency on the server (gap-log.mjs) so page and endpoint cannot disagree
// about the order.
function renderGapKind (kind, titleKey, noteKey, withReason) {
  const group = admData.gaps.kinds[kind]
  const out = [
    `<h3>${esc(T(titleKey))}</h3>`,
    `<span class="note">${esc(T(noteKey))}</span>`
  ]
  if (!group || !group.languages.length) {
    out.push(`<p class="empty">${esc(T('adm.none'))}</p>`)
    return `<div class="admblock">${out.join('')}</div>`
  }
  for (const { lang, entries } of group.languages) {
    out.push(`<p class="admlang">${esc(T('adm.langSection', { lang }))}</p>`)
    out.push('<table class="admtab"><thead><tr>' +
      `<th>${esc(T('adm.colCount'))}</th>` +
      `<th>${esc(T('adm.colText'))}</th>` +
      (withReason ? `<th>${esc(T('adm.colReason'))}</th>` : '') +
      `<th>${esc(T('adm.colLast'))}</th>` +
      '</tr></thead><tbody>')
    for (const e of entries) {
      // The full triggering text hangs behind a disclosure: it is the thing the
      // operator needs to reproduce the failure, and the thing that would make
      // the table unreadable if it were always open.
      const sample = withReason && e.sample && e.sample !== e.text
        ? `<details class="admsample"><summary>${esc(T('adm.sample'))}</summary><pre>${esc(e.sample)}</pre></details>`
        : ''
      out.push('<tr>' +
        `<td class="n">${esc(num(e.count))}</td>` +
        `<td class="t">${esc(e.text)}${sample}</td>` +
        (withReason ? `<td class="r">${esc(e.reason)}</td>` : '') +
        `<td class="w">${esc(when(e.lastAt))}</td>` +
        '</tr>')
    }
    out.push('</tbody></table>')
  }
  if (group.dropped > 0) {
    out.push(`<p class="admdrop">${esc(T('adm.dropped', { n: num(group.dropped), max: num(admData.limits.maxEntriesPerKind) }))}</p>`)
  }
  return `<div class="admblock">${out.join('')}</div>`
}

function renderAdmin () {
  if (!admData) return
  admMeta.textContent =
    T('adm.langsConfigured', { list: admData.languages.join(', ') }) + ' · ' +
    T('adm.langsLive', { list: admData.liveLanguages.join(', ') })
  renderSkew(admData.skew)
  renderBuild(admData.langBuild)
  renderClientStrings(admData.clientStrings)
  admGaps.innerHTML =
    renderGapKind('parse', 'adm.parse', 'adm.parseNote', true) +
    renderGapKind('unknownMod', 'adm.unknownMod', 'adm.unknownModNote', false)
}

// The one admin request there is. The password rides along on every call —
// there is no session to establish, so this function IS the login.
async function loadAdmin (secret) {
  admErr.hidden = true; admErr.textContent = ''
  try {
    const r = await fetch('/admin/gaps', { headers: { [ADMIN_HEADER]: secret } })
    if (r.status === 401) {
      relAdminReady = false
      relSetButton()
      storeAdminSecret('')
      admErr.textContent = T('set.adminWrong')
      admErr.hidden = false
      admView.hidden = true
      admGate.hidden = false
      return false
    }
    if (!r.ok) {
      admErr.textContent = T('set.adminFailedHttp', { status: r.status })
      admErr.hidden = false
      return false
    }
    admData = await r.json()
    storeAdminSecret(secret)
    admGate.hidden = true
    admView.hidden = false
    renderAdmin()
    // Three endpoints, three requests, on purpose: the diagnostics, the
    // configuration and the update state fail independently, and one of them
    // being unreachable must not blank the others.
    await loadConfig(secret)
    await loadUpdate(secret)
    renderStrandedNotice()
    relAdminReady = true
    relSetButton()
    return true
  } catch {
    admErr.textContent = T('set.adminFailedNet')
    admErr.hidden = false
    return false
  }
}

// ---- Admin: the server settings (GET /config-view) --------------------------
// The form is generated from the endpoint's `settings` array and from nothing
// else. There is deliberately no list of keys, types or ranges in this file: the
// allow-list lives in config-overrides.mjs, the endpoint serves it, and a second
// copy here would drift the first time somebody adds a key.
const cfgAlarm = $('cfgAlarm')
const cfgPwWarn = $('cfgPwWarn')
const cfgPath = $('cfgPath')
const cfgPend = $('cfgPend')
const cfgTables = $('cfgTables')
const cfgMsg = $('cfgMsg')
const cfgRuntime = $('cfgRuntime')
const cfgRestart = $('cfgRestart')
const cfgRestartNote = $('cfgRestartNote')
const cfgRestartState = $('cfgRestartState')

// How long a restart usually takes, and how long the page is willing to wait
// before it stops claiming to know. Both are page timings, not configuration:
// nothing on the server can answer "how long will your next boot take", so the
// honest shape is an estimate in the note plus a hard budget on the polling
// that ends in a message rather than in a spinner forever.
const RESTART_TYPICAL_SEC = 30
const RESTART_POLL_MS = 1000
const RESTART_WAIT_MS = 120_000
// Longer than the shutdown budget server.mjs gives itself (a 2 s fallback after
// the graceful close), so the first healthy answer after it belongs to the NEW
// process. See waitForServer().
const RESTART_GRACE_MS = 3000
// A restart that never came back is exactly the situation in which the operator
// has no working page to read the advice on, so the advice outlives the page.
const RESTART_STRANDED_KEY = 'ppt_restart_stranded'

let cfgData = null
let cfgBusy = false

const boolOn = v => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())

function cfgSay (text, bad) {
  cfgMsg.textContent = text
  cfgMsg.classList.toggle('bad', !!bad)
  cfgMsg.hidden = !text
}

// The `source` word from the endpoint is wire vocabulary ('override'/'env'/
// 'default'). A stranger reading this table has to be told what it MEANS, so it
// is never printed raw.
function sourceText (source) {
  const key = 'cfg.source.' + source
  // A word the table has no sentence for is shown as it came rather than as a
  // missing-key placeholder — the same rule srv() follows.
  return Object.prototype.hasOwnProperty.call(I18n.STRINGS.en, key) ? T(key) : String(source)
}

// One row's editor. `type` decides the widget; every constraint on it comes
// from the same row of the endpoint's answer.
function fieldHtml (s) {
  const name = esc(s.name)
  if (s.type === 'bool') {
    const on = boolOn(s.value)
    return '<label class="cfgbool">' +
      `<input type="checkbox" data-cfg="${name}"${on ? ' checked' : ''}>` +
      `<span>${esc(on ? T('cfg.boolOn') : T('cfg.boolOff'))}</span>` +
      '</label>'
  }
  if (s.type === 'enum') {
    const opts = (s.values || []).map(v =>
      `<option value="${esc(v)}"${String(s.value) === String(v) ? ' selected' : ''}>${esc(v)}</option>`).join('')
    return `<select data-cfg="${name}">${opts}</select>`
  }
  if (s.type === 'int') {
    return `<input type="number" data-cfg="${name}" value="${esc(s.value)}"` +
      (s.min != null ? ` min="${esc(s.min)}"` : '') +
      (s.max != null ? ` max="${esc(s.max)}"` : '') + '>'
  }
  return `<input type="text" data-cfg="${name}" value="${esc(s.value)}" spellcheck="false"` +
    (s.maxLength ? ` maxlength="${esc(s.maxLength)}"` : '') + '>'
}

// Which direction of THIS setting sends more requests, as a sentence. The
// endpoint sends a wire word ('higher'/'lower'); it is mapped to a key here
// rather than concatenated into one, so an unknown word from a newer server
// shows nothing instead of a missing-key placeholder — and so that this file
// still holds no list of setting names (see the note above fieldHtml).
const TRAFFIC_KEYS = { higher: 'cfg.trafficHigher', lower: 'cfg.trafficLower' }
// A SWITCH HAS NO "HIGHER" AND NO "LOWER". It belongs in this section for the
// same reason the intervals do — it decides how many requests go out — but
// "smaller values send more requests" describes a number, and the widget in
// that row is a checkbox. So the direction sentence is chosen by the WIDGET,
// not only by the wire word; the wire word still says which way it runs.
const TRAFFIC_BOOL_KEYS = { higher: 'cfg.trafficOnMore', lower: 'cfg.trafficOffMore' }
const trafficKeyFor = s => (s.type === 'bool' ? TRAFFIC_BOOL_KEYS : TRAFFIC_KEYS)[s.traffic]

function rowHtml (s) {
  const flags = []
  // First flag on the row, before the caveats about compose and restarts: it
  // is the one that says what pressing the arrow costs somebody else.
  if (TRAFFIC_KEYS[s.traffic]) {
    flags.push(`<span class="cfgflag traffic">${esc(T(trafficKeyFor(s)))}</span>`)
  }
  // The stumbling block: an override is silently beating a value that IS set in
  // the compose file. Whoever edits compose next has to find out here, not after
  // an afternoon.
  if (s.shadowsEnv && s.envValue != null) {
    flags.push(`<span class="cfgflag shadow">${esc(T('cfg.shadowsEnv', { value: s.envValue }))}</span>`)
  }
  // Present in the file, refused by the allow-list: it is doing nothing, and the
  // value in the field is the one really in force — so it is labelled, not drawn
  // as if it were the setting.
  if (s.invalid) {
    flags.push(`<span class="cfgflag invalid">${esc(T('cfg.invalid', { why: s.invalid }))}</span>`)
  }
  if (s.restartPending) {
    flags.push(`<span class="cfgflag pending">${esc(T('cfg.rowPending'))}</span>`)
  }
  if (s.defaultValue != null && String(s.defaultValue) !== String(s.value)) {
    // A row whose default is "not set at all" (POE_PATCH_VERSION) would
    // otherwise print "Default: " and leave the reader to guess what an empty
    // default is. It is a state, so it is said as one.
    flags.push(`<span class="cfgflag def">${esc(String(s.defaultValue) === ''
      ? T('cfg.defaultUnset')
      : T('cfg.defaultIs', { value: s.defaultValue }))}</span>`)
  }
  // The way back is only offered where there is something to go back FROM.
  const reset = s.overrideValue !== null || s.invalid
    ? `<button type="button" class="reset" data-cfg-reset="${esc(s.name)}" title="${esc(T('cfg.resetTitle'))}">${esc(T('cfg.reset'))}</button>`
    : ''
  return '<tr>' +
    `<td><span class="k">${esc(s.name)}</span><span class="d">${esc(s.description)}</span>${flags.join('')}</td>` +
    `<td class="val">${fieldHtml(s)}</td>` +
    `<td class="src">${esc(sourceText(s.source))}</td>` +
    `<td class="act">${reset}</td>` +
    '</tr>'
}

// The request-volume block. Its own heading and its own sentence, and INSIDE it
// the same live/restart split as everywhere else — so a setting that shapes
// outbound traffic can never end up looking like the display name two rows
// above it, and still says honestly when it takes effect. Which rows land here
// is the server's answer (`traffic`), never a list in this file.
function trafficHtml (rows) {
  if (!rows.length) return ''
  return '<div class="cfgtraffic">' +
    `<h4>${esc(T('cfg.trafficTitle'))}</h4>` +
    `<p class="note">${esc(T('cfg.trafficNote'))}</p>` +
    groupHtml('cfg.groupLive', rows.filter(s => s.apply === 'live')) +
    groupHtml('cfg.groupRestart', rows.filter(s => s.apply !== 'live')) +
    '</div>'
}

function groupHtml (titleKey, rows) {
  if (!rows.length) return ''
  return `<p class="cfggroup">${esc(T(titleKey))}</p>` +
    '<table class="cfgtab"><thead><tr>' +
    `<th>${esc(T('cfg.colSetting'))}</th>` +
    `<th>${esc(T('cfg.colValue'))}</th>` +
    `<th>${esc(T('cfg.colSource'))}</th>` +
    '<th></th>' +
    '</tr></thead><tbody>' + rows.map(rowHtml).join('') + '</tbody></table>'
}

function renderConfig () {
  if (!cfgData) return
  // The alarm. `quarantined` means the settings on this page were thrown out at
  // boot — everything below is then a description of a configuration that is not
  // the one running, so it goes above all of it.
  const alarm = []
  if (cfgData.quarantined) {
    alarm.push(`<h3>${esc(T('cfg.quarantineTitle'))}</h3>` +
      `<p>${esc(T('cfg.quarantineBody', { path: cfgData.rejectedPath || cfgData.overridesPath || '—' }))}</p>`)
  }
  if (Array.isArray(cfgData.problems) && cfgData.problems.length) {
    alarm.push(`<h3>${esc(T('cfg.problemsTitle'))}</h3><ul>` +
      cfgData.problems.map(p => `<li>${esc(p)}</li>`).join('') + '</ul>')
  }
  cfgAlarm.innerHTML = alarm.length ? `<div class="cfgalarm">${alarm.join('')}</div>` : ''

  // Below the alarm, above everything it stands in front of: the admin password is
  // still the one printed in the repository. `adminGateIsDefault` is named
  // after the gate rather than the password because the endpoint refuses every
  // field whose name could name a credential — see /config-view.
  cfgPwWarn.innerHTML = cfgData.adminGateIsDefault
    ? `<div class="cfgwarn"><h3>${esc(T('cfg.pwDefaultTitle'))}</h3><p>${esc(T('cfg.pwDefaultBody'))}</p></div>`
    : ''

  cfgPath.textContent = cfgData.overridesPath ? T('cfg.path', { path: cfgData.overridesPath }) : ''
  cfgPend.hidden = !cfgData.restartPending
  cfgPend.textContent = cfgData.restartPending ? T('cfg.pending') : ''

  const settings = Array.isArray(cfgData.settings) ? cfgData.settings : []
  const plain = settings.filter(s => !TRAFFIC_KEYS[s.traffic])
  cfgTables.innerHTML =
    groupHtml('cfg.groupLive', plain.filter(s => s.apply === 'live')) +
    groupHtml('cfg.groupRestart', plain.filter(s => s.apply !== 'live')) +
    trafficHtml(settings.filter(s => TRAFFIC_KEYS[s.traffic]))

  cfgRestartNote.textContent = T('cfg.restartNote', { sec: RESTART_TYPICAL_SEC })
  // No number in this one on purpose: the cooldown is a setting, it is in the
  // table right above, and a sentence repeating it would be a second place for
  // it to be wrong.
  cfgCheckNowNote.textContent = T('cfg.checkNowNote')

  const runtime = Array.isArray(cfgData.runtime) ? cfgData.runtime : []
  cfgRuntime.innerHTML = runtime.map(e =>
    `<div class="rtrow"><span class="k">${esc(e.name)}</span><span class="v">${esc(e.value)}</span></div>`).join('')
}

async function loadConfig (secret) {
  try {
    const r = await fetch('/config-view', { headers: { [ADMIN_HEADER]: secret } })
    if (!r.ok) {
      // 401 is handled by loadAdmin, which runs against the same password and
      // owns the gate; anything else is reported where the section would be.
      if (r.status !== 401) cfgSay(T('cfg.failedHttp', { status: r.status }), true)
      return false
    }
    cfgData = await r.json()
    cfgSay('')
    renderConfig()
    return true
  } catch {
    cfgSay(T('cfg.failedNet'), true)
    return false
  }
}

// One write. `value: null` is the documented way to REMOVE an override, which is
// what the reset button sends — same endpoint, no second route for undoing.
async function saveConfig (name, value) {
  if (cfgBusy) return
  cfgBusy = true
  cfgSay('')
  let said = null
  try {
    const r = await fetch('/config-override', {
      method: 'POST',
      headers: { [ADMIN_HEADER]: adminSecret(), 'content-type': 'application/json' },
      body: JSON.stringify({ key: name, value })
    })
    const j = await r.json().catch(() => null)
    said = r.ok
      ? { text: T('cfg.saved') }
      : { text: T('cfg.saveFailed', { error: (j && j.error) ? j.error : String(r.status) }), bad: true }
  } catch {
    said = { text: T('cfg.saveFailedNet'), bad: true }
  }
  cfgBusy = false
  // Always re-read: a save changes `source`, `shadowsEnv` and `restartPending`
  // of the row, and a refused one must not leave the rejected value on screen.
  // The outcome is announced AFTER that, because the reload clears the slot.
  await loadConfig(adminSecret())
  cfgSay(said.text, said.bad)
  // The release check's switch lives in this table; the block above it shows
  // whether the automatic check is on, so it is read again after every save.
  if (said.bad !== true) loadRelease()
}

// Delegated, because the tables are replaced wholesale on every reload.
cfgTables.addEventListener('change', e => {
  const el = e.target.closest('[data-cfg]')
  if (!el) return
  const value = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value
  saveConfig(el.getAttribute('data-cfg'), value)
})
cfgTables.addEventListener('click', e => {
  const btn = e.target.closest('[data-cfg-reset]')
  if (!btn) return
  saveConfig(btn.getAttribute('data-cfg-reset'), null)
})

// ---- Admin: restart ----------------------------------------------------------
// The server answers and THEN exits, so the page is guaranteed to lose the
// connection. That is the normal course of this button, not a failure, and it is
// treated as such: say what is happening, wait for the process to actually go
// away, then poll the cheapest endpoint there is until it answers again.
const sleep = ms => new Promise(r => setTimeout(r, ms))

function restartState (text, cls) {
  cfgRestartState.textContent = text
  cfgRestartState.className = 'cfgstate' + (cls ? ' ' + cls : '')
  cfgRestartState.hidden = !text
}

async function healthOk () {
  try {
    const r = await fetch('/health', { cache: 'no-store' })
    return r.ok
  } catch { return false }
}

// WAITING FOR THE OLD PROCESS TO BE GONE IS A RACE, so it is not done that way.
// Polling until a request FAILS looks obvious and is wrong: the gap between the
// last answer of the old process and the first of the new one can fall entirely
// between two polls, and then the page waits for a failure that never comes.
// The server's own shutdown path is bounded instead (`/restart` answers, then
// closes, with a 2 s hard fallback), so a grace period longer than that budget
// makes the next healthy answer provably a different process.
//
// The grace period is a parameter because the UPDATE path reuses this function
// with none: by the time it calls, it has already proved the new process is
// answering (see waitForUpdateResult), and a blind three-second sleep would be
// three seconds of lying about it.
async function waitForServer (waitMs = RESTART_WAIT_MS, graceMs = RESTART_GRACE_MS) {
  const deadline = Date.now() + waitMs
  if (graceMs) await sleep(graceMs)
  while (Date.now() < deadline) {
    if (await healthOk()) return true
    await sleep(RESTART_POLL_MS)
  }
  return false
}

function rememberStranded (yes) {
  try {
    if (yes) localStorage.setItem(RESTART_STRANDED_KEY, String(Date.now()))
    else localStorage.removeItem(RESTART_STRANDED_KEY)
  } catch { /* private mode: the live message is all there is then */ }
}
function wasStranded () {
  try { return !!localStorage.getItem(RESTART_STRANDED_KEY) } catch { return false }
}

async function doRestart () {
  // THE ONE ACTION ON THIS PAGE THAT CAN MAKE THE PAGE UNREACHABLE. Whether the
  // tool comes back is a property of the container, not of this tool: without a
  // restart policy nothing starts it again, and the tool cannot find that out
  // for itself — Docker does not tell a container its own restart policy, and
  // the socket that would is deliberately not mounted (see the /restart route).
  // So the condition is NAMED where the decision is made, and never guessed.
  if (!window.confirm(T('cfg.restartConfirm'))) return
  cfgRestart.disabled = true
  restartState(T('cfg.restarting'))
  try {
    const r = await fetch('/restart', { method: 'POST', headers: { [ADMIN_HEADER]: adminSecret() } })
    if (!r.ok) {
      restartState(T('cfg.restartFailedHttp', { status: r.status }), 'bad')
      cfgRestart.disabled = false
      return
    }
  } catch {
    // A connection that dies while the answer is in flight is indistinguishable
    // from one that never arrived — and the process may well be going down
    // already. Waiting for it to come back answers the question either way.
    restartState(T('cfg.restarting'))
  }
  const back = await waitForServer()
  if (!back) {
    // Not "server not reachable" — that is the symptom. This is the one place
    // where the missing restart policy shows up, and the operator reading it
    // has no working page left to look anything up on.
    rememberStranded(true)
    restartState(T('cfg.restartGone', { sec: Math.round(RESTART_WAIT_MS / 1000) }), 'bad')
    cfgRestart.disabled = false
    return
  }
  rememberStranded(false)
  restartState(T('cfg.restartBack'), 'ok')
  cfgRestart.disabled = false
  // The restart is the whole point of `restartPending`, so the view has to be
  // re-read: it is what proves the pending changes are in force now.
  await loadAdmin(adminSecret())
}

// The advice survives the page. Somebody who had to start the tool again by
// hand comes back to a freshly loaded page, and the reason it happened would
// otherwise have gone with the old one.
function renderStrandedNotice () {
  if (cfgRestartState.hidden && wasStranded()) restartState(T('cfg.restartGoneEarlier'), 'bad')
}

cfgRestart.addEventListener('click', doRestart)

// ---- Admin: check the data sources now (POST /admin/data-check) --------------
// WHAT IT IS FOR. Everything on this page that repairs a data source — the patch
// version above all — takes effect at the NEXT check, and there is one a day. So
// the reward for a correct repair was the same failure sentence on screen for up
// to 24 hours, and no way to tell it apart from a repair that did not work. This
// is that way.
//
// It is not a free button and the page says so rather than discovering it: one
// press is a patch lookup, a conditional fetch of every upstream file, and — if
// anything is out of date — a game-data export that pulls tens of megabytes from
// the patch CDN. The cooldown that bounds it is enforced on the SERVER (the
// refresher owns the clock, next to the schedule it protects); everything here
// is reporting, because a guard that only exists in a page is not a guard.
const cfgCheckNow = $('cfgCheckNow')
const cfgCheckNowNote = $('cfgCheckNowNote')
const cfgCheckNowState = $('cfgCheckNowState')

function checkNowState (text, cls) {
  cfgCheckNowState.textContent = text
  cfgCheckNowState.className = 'cfgstate' + (cls ? ' ' + cls : '')
  cfgCheckNowState.hidden = !text
}

async function doCheckNow () {
  cfgCheckNow.disabled = true
  checkNowState(T('cfg.checkNowRunning'))
  let r, body
  try {
    r = await fetch('/admin/data-check', { method: 'POST', headers: { [ADMIN_HEADER]: adminSecret() } })
    body = await r.json().catch(() => ({}))
  } catch {
    checkNowState(T('cfg.checkNowFailed'), 'bad')
    cfgCheckNow.disabled = false
    return
  }
  if (r.status === 429) {
    // The wait comes from the server, so the page cannot promise a shorter one
    // than the one that is actually in force.
    checkNowState(T('cfg.checkNowCooldown', { sec: Math.ceil((body.retryAfterMs || 0) / 1000) }), 'bad')
  } else if (r.status === 409) {
    checkNowState(T('cfg.checkNowBusy'), 'bad')
  } else if (!r.ok) {
    checkNowState(T('cfg.checkNowFailedHttp', { status: r.status }), 'bad')
  } else {
    checkNowState(T('cfg.checkNowDone'), 'ok')
    // The status line is pushed over the socket, and the shell owns it. Handing
    // it the answer this click just produced saves the reader from wondering
    // whether what they are looking at is the old one.
    if (body.status && window.Shell) window.Shell.applyDataStatus(body.status)
  }
  cfgCheckNow.disabled = false
}

cfgCheckNow.addEventListener('click', doCheckNow)

// ---- Admin: update (GET /update-status, POST /update-request) ----------------
// The other button, and deliberately not next to the restart: a restart is
// harmless and frequent, an update replaces the running code and goes through a
// script on the host. The tool can only ASK — see host-update.mjs for why there
// is no docker socket in this container.
const updBuild = $('updBuild')
const updSetup = $('updSetup')
const updStuck = $('updStuck')
const updBtn = $('updBtn')
const updState = $('updState')
const updLast = $('updLast')
const updOut = $('updOut')
const updOutNote = $('updOutNote')

// How long the page waits for the host. A restart is one boot; this is a `git
// pull` plus a full image build, and the page has no way to know how fast the
// host is — so the budget is generous and the message at the end of it says
// what to look at rather than pretending to know what went wrong.
const UPDATE_WAIT_MS = 900_000
const UPDATE_POLL_MS = 3000

let updData = null

function updSay (text, cls) {
  updState.textContent = text
  updState.className = 'cfgstate' + (cls ? ' ' + cls : '')
  updState.hidden = !text
}

// The host's build output. textContent, never innerHTML: this is foreign text
// from a machine outside the tool. The server bounds it and runs it through the
// same secret filter /config-view uses (host-update.mjs), and this is the
// second half of that promise — it must not be able to become markup.
//
// The note travels with it and is not decoration: that filter drops lines that
// NAME a credential and masks credentials inside URLs, and a bare token in a
// line that names nothing goes straight through. Whoever copies this excerpt
// into a bug report has to know that before they do it.
function showOutput (text) {
  updOut.textContent = text || ''
  updOut.hidden = !text
  updOutNote.hidden = !text
}

const localTime = iso => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString()
}

function renderUpdate () {
  if (!updData) return
  const u = updData.updater || {}
  const commit = updData.build && updData.build.commit
  updBuild.textContent = commit ? T('upd.build', { commit }) : T('upd.buildUnknown')

  // NOT HIDDEN when there is no updater. Somebody who never sees that this
  // exists never sets it up — so the button stays visible and disabled, with
  // the sentence that says what would have to happen.
  updSetup.hidden = u.installed
  updSetup.textContent = u.installed ? '' : T('upd.notInstalled')

  // STUCK IS NOT HEALTHY, though it looks like it. An updater whose lock a
  // dead run left behind goes on writing its heartbeat and picks nothing up, so
  // "installed" alone would leave an enabled button that quietly does nothing
  // forever. Pressing it would only write a request nobody consumes, which is
  // why the button goes with the message rather than staying next to it.
  const stuck = Boolean(u.installed && u.stuck)
  updStuck.hidden = !stuck
  updStuck.textContent = !stuck
    ? ''
    : u.stuckSince
      ? T('upd.stuck', { at: localTime(u.stuckSince) })
      : T('upd.stuckNoTime')
  updBtn.disabled = !u.installed || stuck

  const r = updData.lastResult
  const req = updData.request || {}
  const parts = []
  // When the host script IS there, say when it last reported in. Plain text
  // rather than a tooltip: "is the thing on the other side alive" is the first
  // question when the button does not do what was expected, and a title
  // attribute is not an answer anybody finds.
  if (u.installed && u.heartbeatAt) parts.push(T('upd.installedAt', { at: localTime(u.heartbeatAt) }))
  if (r) {
    const at = localTime(r.finishedAt || r.at)
    parts.push(r.status === 'ok' ? T('upd.lastOk', { at }) : r.status === 'failed' ? T('upd.lastFailed', { at }) : T('upd.lastUnknown', { at }))
  }
  // An outstanding request survives a page reload — it is a file on the server,
  // not a state of this tab — so a page opened while the host is still working
  // says so instead of looking idle.
  if (req.pending && req.requestedAt) parts.push(T('upd.pending', { at: localTime(req.requestedAt) }))
  updLast.textContent = parts.join(' ')

  // The excerpt is shown for a failure and kept out of the way otherwise: a
  // successful build log is noise, and this is the one element on the page that
  // carries text from outside.
  showOutput(r && r.status !== 'ok' ? r.output : '')
}

async function loadUpdate (secret) {
  try {
    const r = await fetch('/update-status', { headers: { [ADMIN_HEADER]: secret }, cache: 'no-store' })
    if (!r.ok) {
      // 401 belongs to loadAdmin, which owns the gate.
      if (r.status !== 401) updSay(T('upd.statusFailedHttp', { status: r.status }), 'bad')
      return null
    }
    updData = await r.json()
    renderUpdate()
    return updData
  } catch {
    updSay(T('upd.statusFailedNet'), 'bad')
    return null
  }
}

// WHY THIS DOES NOT JUST POLL /health LIKE THE RESTART DOES. During most of an
// update the OLD container is still running and answering perfectly: `docker
// compose up -d --build` builds the new image first and only then swaps. A
// health poll would therefore report "back" within a second of the button,
// while the build has not even started. What actually marks the end is the host
// script writing its result file — and it writes that AFTER the swap, so the
// first answer we can read it from is already the new process.
//
// `since` is the timestamp of the result this page had ALREADY seen, not a
// clock reading of its own: both sides of that comparison then come from the
// server, and a browser whose clock is minutes off the server's does not turn
// a finished update into a timeout (or an old result into a fresh one).
async function waitForUpdateResult (since) {
  const deadline = Date.now() + UPDATE_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(UPDATE_POLL_MS)
    let s = null
    // Failures are expected here: the container is replaced in the middle of
    // this loop. Only a real answer counts.
    try {
      const r = await fetch('/update-status', { headers: { [ADMIN_HEADER]: adminSecret() }, cache: 'no-store' })
      if (r.ok) s = await r.json()
    } catch { /* the swap — keep waiting */ }
    if (!s) continue
    const done = s.lastResult && Date.parse(s.lastResult.at) > since
    if (done) { updData = s; return s }
  }
  return null
}

async function doUpdate () {
  if (updBtn.disabled) return
  if (!window.confirm(T('upd.confirm'))) return
  updBtn.disabled = true
  showOutput('')
  updSay(T('upd.working'))
  // What counts as "the answer to THIS request": any result newer than the one
  // already on screen. Read before the POST, and expressed in the server's own
  // timestamps rather than this browser's clock (see waitForUpdateResult).
  const since = (updData && updData.lastResult && Date.parse(updData.lastResult.at)) || 0
  try {
    const r = await fetch('/update-request', { method: 'POST', headers: { [ADMIN_HEADER]: adminSecret() } })
    if (!r.ok) {
      updSay(T('upd.failedHttp', { status: r.status }), 'bad')
      updBtn.disabled = false
      return
    }
    const j = await r.json().catch(() => null)
    updSay(T('upd.requested', { at: localTime((j && j.requestedAt) || new Date().toISOString()) }))
  } catch {
    updSay(T('upd.failedNet'), 'bad')
    updBtn.disabled = false
    return
  }

  const s = await waitForUpdateResult(since)
  if (!s) {
    updSay(T('upd.timeout', { min: Math.round(UPDATE_WAIT_MS / 60000) }), 'bad')
    updBtn.disabled = false
    // Whatever the server can still tell us is better than this page's guess.
    await loadUpdate(adminSecret())
    return
  }
  if (s.lastResult.status !== 'ok') {
    updSay(T('upd.failed'), 'bad')
    renderUpdate()
    updBtn.disabled = false
    return
  }
  // Reading the result proved the server answers again; this is the same
  // come-back wait the restart uses, without its grace period (see
  // waitForServer) — it only has to survive a container that is still settling.
  await waitForServer(UPDATE_WAIT_MS, 0)
  const commit = s.build && s.build.commit
  updSay(commit ? T('upd.doneCommit', { commit }) : T('upd.done'), 'ok')
  updBtn.disabled = false
  // Everything on the page may have changed with the new code.
  await loadAdmin(adminSecret())
}

updBtn.addEventListener('click', doUpdate)

// ---- Releases: which version runs here, which one is out ----------------------
// Two halves with different audiences. The BLOCK (#relBlock) is for everybody and
// needs no password: it renders GET /release-status on load and again from every
// `release-status` message on the socket. The BUTTON (#relCheckBtn) is in the
// admin area and asks the server to look at GitHub now (POST /admin/release-check);
// the one-at-a-time guard and the 60 s cooldown belong to the server, this only
// reports what it answered.
//
// The status line on every page (Shell.applyReleaseStatus) is a separate thing
// and is fed from the same message; this file renders the block only.
const relInstalled = $('relInstalled')
const relLatest = $('relLatest')
const relDaemon = $('relDaemon')
const relLastCheck = $('relLastCheck')
const relPointer = $('relPointer')
const relCheckBtn = $('relCheckBtn')
const relCheckState = $('relCheckState')

let relData = null       // last release-status object, from the GET or the socket
let relDaemonInfo = null  // the player's hotkey daemon as its last heartbeat said (`daemon-status`.daemon)
let relDaemonKnown = false // a daemon-status has arrived (before that the line stays hidden)
let relAdminReady = false // the admin area has loaded: the button may be pressed
let relBusy = false       // a manual check is in flight

// Failure classes the page has a sentence for (check-failure.mjs, in the release
// check's own meaning). Anything else gets the unclassified sentence rather than
// a key that does not exist.
const REL_ADVICE = ['unreachable', 'rejected', 'incompatible']
const REL_OUTCOMES = ['ok', 'none', 'unchanged', 'failed']

// A link target from the server is only made a link when it is https. The value
// comes from GitHub's answer; a `javascript:` URL in it must stay text.
const isHttps = u => typeof u === 'string' && /^https:\/\//i.test(u)

function relAdviceKey (kind) {
  return 'rel.advice.' + (REL_ADVICE.includes(kind) ? kind : 'unknown')
}

// The advice for a failed check. A retry is only promised while the automatic
// check is on, and it is left off for the one class (incompatible) that a retry
// tomorrow does not cure. `st.nextCheckAt` is the server's real next try, shown as
// a time of day in the block. Right after the manual button the next try is a
// full interval away, which is the one place the relative sentence is true
// (`relative`); the block itself may be read hours later.
function relAdvice (st, relative) {
  const key = relAdviceKey(st.lastFailKind)
  let text = T(key)
  if (key === 'rel.advice.unknown' && st.lastReason) text += ' ' + T('rel.adviceReason', { reason: st.lastReason })
  if (st.enabled && key !== 'rel.advice.incompatible') {
    if (relative) text += ' ' + T('rel.adviceNext')
    else if (st.nextCheckAt) text += ' ' + T('rel.adviceNextAt', { when: when(st.nextCheckAt) })
  }
  return text
}

// The line under the installed and latest release: the version of this user's
// hotkey daemon, and how to update it when the latest release is newer.
function renderDaemonVersion () {
  if (!relDaemon) return
  relDaemon.textContent = relDaemonKnown ? window.Shell.daemonVersionText(relDaemonInfo, relData) : ''
  relDaemon.hidden = !relDaemon.textContent
}

function renderRelease () {
  renderDaemonVersion()
  if (!relData) return
  const r = relData
  relInstalled.textContent = r.installed ? T('rel.installed', { version: r.installed }) : T('rel.installedUnknown')

  // The latest release: a release, "none yet", "never asked", or "asked and got
  // no answer" are four different facts and one sentence each.
  relLatest.textContent = ''
  relLatest.classList.toggle('newer', r.comparison === 'newer')
  if (r.latest && r.latest.version) {
    const date = r.latest.publishedAt ? when(r.latest.publishedAt) : '—'
    relLatest.textContent = T('rel.latest', { version: r.latest.version, date })
    if (isHttps(r.latest.url)) {
      relLatest.insertAdjacentHTML('beforeend',
        `<a href="${esc(r.latest.url)}" target="_blank" rel="noopener noreferrer">${esc(T('rel.link'))}</a>`)
    }
  } else if (r.lastOutcome === 'none') {
    relLatest.textContent = T('rel.latestNone')
  } else if (!r.lastCheckAt) {
    relLatest.textContent = T('rel.latestNotChecked')
  } else {
    relLatest.textContent = T('rel.latestUnknown')
  }

  // The last check: when, what came of it, and for a failure what that kind of
  // failure means and when the next try is.
  const failed = r.lastOutcome === 'failed'
  relLastCheck.classList.toggle('bad', failed)
  const parts = []
  if (r.lastCheckAt && r.lastOutcome) {
    const outcome = T('rel.outcome.' + (REL_OUTCOMES.includes(r.lastOutcome) ? r.lastOutcome : 'failed'))
    parts.push(T('rel.lastCheck', { when: when(r.lastCheckAt), outcome }))
    if (failed) parts.push(relAdvice(r))
  }
  if (r.enabled === false) parts.push(T('rel.autoOff'))
  relLastCheck.textContent = parts.join(' ')
  relLastCheck.hidden = !relLastCheck.textContent

  // The sentence that says who updates what, with two links into the repository
  // the SERVER says it was released from. `repo` is escaped for the attribute and
  // the text; the https://github.com/ prefix is in the string table, so it cannot
  // become anything else than a link into GitHub.
  relPointer.innerHTML = r.repo ? T('rel.pointer_html', { repo: esc(r.repo) }) : ''
  relPointer.hidden = !r.repo
}

function relSetButton () {
  relCheckBtn.disabled = !relAdminReady || relBusy
}

// `build` returns the sentence, or is null to clear it. It is kept so a language
// change can build the sentence again in the new language.
let relSaid = null
function relSay (build, cls) {
  relSaid = build ? { build, cls } : null
  const text = build ? build() : ''
  relCheckState.textContent = text
  relCheckState.className = 'cfgstate' + (cls ? ' ' + cls : '')
  relCheckState.hidden = !text
}

// One sentence for what a finished check found, as [builder, class].
function relResultSentence (st) {
  if (st.lastOutcome === 'failed') return [() => relAdvice(st, true), 'bad']
  if (st.lastOutcome === 'none') return [() => T('rel.resultNone'), 'ok']
  if (st.comparison === 'newer') return [() => T('rel.resultNewer', { version: st.latest.version }), 'ok']
  if (st.comparison === 'current') return [() => T('rel.resultUpToDate'), 'ok']
  if (st.latest && st.latest.version) return [() => T('rel.resultUnknown', { version: st.latest.version }), 'ok']
  return [() => T('rel.latestUnknown'), 'bad']
}

async function loadRelease () {
  try {
    const r = await fetch('/release-status', { cache: 'no-store' })
    if (!r.ok) return
    relData = await r.json()
    renderRelease()
  } catch { /* the block stays empty; the socket delivers the same object on connect */ }
}

async function doReleaseCheck () {
  if (relCheckBtn.disabled) return
  relBusy = true
  relSetButton()
  relSay(() => T('rel.checking'))
  let r, body
  try {
    r = await fetch('/admin/release-check', { method: 'POST', headers: { [ADMIN_HEADER]: adminSecret() } })
    body = await r.json().catch(() => ({}))
  } catch {
    relSay(() => T('rel.resultNet'), 'bad')
    relBusy = false
    relSetButton()
    return
  }
  if (r.status === 429) {
    // The wait comes from the server, so the page cannot promise a shorter one
    // than the one actually in force.
    const seconds = Math.ceil((body.retryAfterMs || 0) / 1000)
    relSay(() => T('rel.resultCooldown', { seconds }), 'bad')
  } else if (r.status === 409) {
    relSay(() => T('rel.resultRunning'), 'bad')
  } else if (r.status === 401) {
    relSay(() => T('rel.resultUnauthorized'), 'bad')
  } else if (!r.ok || !body.status) {
    const status = r.status
    relSay(() => T('rel.resultHttp', { status }), 'bad')
  } else {
    // The answer this click produced is on screen at once; the socket carries
    // the same object to every other open page.
    relData = body.status
    renderRelease()
    if (window.Shell) window.Shell.applyReleaseStatus(body.status)
    const [build, cls] = relResultSentence(body.status)
    relSay(build, cls)
  }
  relBusy = false
  relSetButton()
}

relCheckBtn.addEventListener('click', doReleaseCheck)

// ---- Sources: where prices come from and how old each one is ------------------
// For everybody, no password, like the Releases block above: nothing in it is a
// secret (the reasons pass the server's filter), and the status line on every
// page points HERE when a price source goes stale. Rendered from GET
// /source-status on load and from every `source-status` message; the state of
// each row comes from Shell.sourceView, the same derivation the status line
// uses, so the block and the line cannot disagree. A minute timer ages it.
const srcRows = $('srcRows')
let srcData = null

async function loadSources () {
  try {
    const r = await fetch('/source-status', { cache: 'no-store' })
    if (!r.ok) return
    srcData = { type: 'source-status', ...await r.json(), receivedAt: Date.now() }
    renderSources()
  } catch { /* the socket delivers the same facts on connect */ }
}

function renderSources () {
  if (!srcData || !srcRows || !window.Shell) return
  const age = ms => window.Shell.durationText(Math.max(0, ms))
  srcRows.textContent = ''
  for (const v of window.Shell.sourceView(srcData, Date.now())) {
    const tr = document.createElement('tr')
    const name = document.createElement('td')
    name.textContent = T('src.name.' + v.source)
    const last = document.createElement('td')
    last.textContent = v.lastSuccessAt != null
      ? when(v.lastSuccessAt) + ' · ' + T('src.ago', { age: age(v.ageMs) })
      : T('src.lastNever')
    const state = document.createElement('td')
    const key = window.Shell.sourceState(v)
    let text
    if (key === 'paused') text = T('src.state.paused', { time: when(v.pausedUntil) })
    else if (key === 'stale') text = T('src.state.stale', { age: age(v.ageMs) })
    else text = T('src.state.' + key)
    if (v.enabled && v.failing) {
      text += ' ' + T('src.state.lastFailure', { time: when(v.lastFailureAt), reason: v.reason || T('shell.reasonUnknown') })
    }
    state.textContent = text
    tr.append(name, last, state)
    tr.classList.toggle('bad', v.stale || v.paused)
    srcRows.appendChild(tr)
  }
}
setInterval(renderSources, 60 * 1000)

admOpen.addEventListener('click', () => loadAdmin(admPass.value))
admPass.addEventListener('keydown', e => { if (e.key === 'Enter') loadAdmin(admPass.value) })
admReload.addEventListener('click', () => loadAdmin(adminSecret()))
admClose.addEventListener('click', () => {
  storeAdminSecret('')
  admData = null
  cfgData = null
  updData = null
  relAdminReady = false
  relSay(null)
  relSetButton()
  admPass.value = ''
  admView.hidden = true
  admGate.hidden = false
})

// ---- Identity (multi-user routing, no login) — mirrored from history.js -----
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
  connect(); loadCredentials(); loadUserLang()
})
if (whoami) whoami.addEventListener('click', () => { clearUserCookie(); showIdGate() })

async function initIdentity () {
  try {
    const r = await fetch('/users')
    const j = await r.json()
    if (Array.isArray(j.users) && j.users.length) USERS = j.users
    if (j.langs && typeof j.langs === 'object') USER_LANGS = j.langs
    if (j.appName) window.Shell.applyBrand(j.appName, 'nav.settings')
  } catch { /* keep fallback list + fallback brand */ }
  const cookie = readCookie('ppt_user')
  I18n.applyUsers(USER_LANGS, cookie)
  if (cookie && USERS.includes(cookie)) {
    whoamiName.textContent = cookie
    whoami.hidden = false
    connect(); loadCredentials(); loadUserLang()
  } else showIdGate()
}

// ---- WebSocket: the global rail slots plus the sync status -------------------
// No page data rides on this socket; the credential form is request/response.
const connEl = $('conn')
const connLbl = $('connlbl')
let ws = null
let retry = 0
function sendSafe (obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)) }
function setConn (live) {
  if (!connEl) return
  connEl.classList.toggle('live', live)
  connLbl.textContent = live ? T('conn.live') : T('conn.reconnecting')
}

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
      case 'release-status': window.Shell.applyReleaseStatus(msg); relData = msg; renderRelease(); break
      case 'daemon-status': relDaemonInfo = msg.daemon || null; relDaemonKnown = true; renderDaemonVersion(); break
      case 'networth-session': window.Shell.applySessionStatus(msg); break // running farm session -> status line
      case 'source-status': window.Shell.applySourceStatus(msg); srcData = { ...msg, receivedAt: Date.now() }; renderSources(); break
      case 'networth-sync-status': applySyncStatus(msg); break
      case 'need-identity':
        if (Array.isArray(msg.users) && msg.users.length) USERS = msg.users
        showIdGate()
        break
    }
  })
}

window.Shell.initLeague(obj => sendSafe(obj))

// The status line is clickable on the other pages because it links HERE; on
// this page there is nothing left to open, so it is plain text.
if (appStatusEl) appStatusEl.style.cursor = 'default'

// Everything on this page is built from the string table, so a language change
// after /users answers has to redraw all of it.
I18n.onChange(() => {
  renderSettingsState()
  renderSessidHint()
  renderLangSection()
  setConn(!!ws && ws.readyState === WebSocket.OPEN)
  if (admData) renderAdmin()
  if (cfgData) renderConfig()
  if (updData) renderUpdate()
  renderRelease()
  renderSources()
  if (relSaid) relSay(relSaid.build, relSaid.cls)
})

// A tab that already unlocked the admin view keeps it across a reload of THIS
// page — the value is in sessionStorage and the server re-checks it anyway.
if (adminSecret()) loadAdmin(adminSecret())

initIdentity()
loadRelease()
loadSources()
