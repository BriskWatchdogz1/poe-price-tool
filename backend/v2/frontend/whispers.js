// The Price Check page's block "Buyer whispers (this session)" (classic
// script, loaded after i18n.js and before app.js). Pure: entries in, HTML text
// out; app.js owns the DOM and the WebSocket (`whisper` / `whispers`,
// PROTOCOL.md).
//
// EVERY FIELD IS A STRANGER'S TEXT. Item, tab and league come from another
// player's whisper; verdict and reason come from the server and may be newer
// than this page. All of them go through esc() and never raw into innerHTML;
// an unknown verdict or reason is shown as it came, as text.
//
// The price in a trade whisper is the player's OWN listed price (the buyer
// copies the trade site's template), so 'below' reads "you are selling below
// the market" (docs/pricing-logic.md).
'use strict'

window.Whispers = (() => {
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const T = (k, p) => window.I18n.t(k, p)
  const has = key => Object.prototype.hasOwnProperty.call(window.I18n.STRINGS.en, key)
  // A word for a server value, or the value itself when this page has none.
  const word = (prefix, v) => (has(prefix + v) ? T(prefix + v) : String(v == null ? '' : v))
  // Whole from 100 up, two decimals from 1, three significant digits below
  // (as the server rounds: a stack of 40 for 1 c is 0.025 c each, not 0.03).
  const num = n => Number(n).toLocaleString(window.I18n.locale(), Math.abs(n) < 1 && n !== 0
    ? { maximumSignificantDigits: 3 }
    : { maximumFractionDigits: n >= 100 ? 0 : 2 })
  const isNum = n => typeof n === 'number' && Number.isFinite(n)

  const VERDICT_CLASS = { below: 'wv-below', above: 'wv-above', fair: 'wv-fair', pending: 'wv-pending', unparsed: 'wv-nc', 'not-compared': 'wv-nc' }

  function timeOf (at) {
    if (!isNum(at)) return ''
    return new Date(at).toLocaleTimeString(window.I18n.locale(), { hour: '2-digit', minute: '2-digit' })
  }

  // A single whisper for a stackable item (reason 'stack-unknown'): no
  // verdict, but both readings of 'listed for', in chaos per unit: 'listed
  // 100 c: per unit 100 c, per stack of 20: 5 c per unit; market 0.4 c per
  // unit'. The stack size comes from the server (`stack`, the whisper's own
  // text or the last sync at that cell, which the text names, since that
  // stack may have changed); without one only the per-unit reading. A
  // `caveat` (the Chaos:Divine rate or the market price is in doubt) follows
  // the numbers it doubts. null when the listed price has no chaos value.
  function readingsText (e) {
    const a = e.asked
    if (!a || !isNum(a.chaos)) return null
    const chaosUnit = a.unit == null || /^chaos( orb)?$/i.test(String(a.unit))
    const listed = chaosUnit || !isNum(a.amount)
      ? `${num(a.chaos)} c`
      : `${num(a.amount)} ${a.unit} (${num(a.chaos)} c)`
    let text = T('pc.whisper.readings.unit', { listed, unit: num(a.chaos) })
    const st = e.stack && typeof e.stack === 'object' ? e.stack : null
    if (st && Number.isInteger(st.size) && st.size >= 2 && isNum(st.chaosEach)) {
      const key = st.from === 'sync' ? 'pc.whisper.readings.stackSync' : 'pc.whisper.readings.stack'
      text += ', ' + T(key, { size: num(st.size), each: num(st.chaosEach) })
    }
    if (e.market && isNum(e.market.chaosEach)) text += '; ' + T('pc.whisper.readings.market', { amount: num(e.market.chaosEach) })
    if (e.caveat != null && e.caveat !== '') text += ' — ' + word('pc.whisper.reason.', e.caveat)
    return text
  }

  // 'your 140 divine · market 150 divine' — the market value in the unit the
  // listing names, so the two numbers compare at a glance.
  function priceText (e) {
    if (e.verdict === 'not-compared' && e.reason === 'stack-unknown') {
      const r = readingsText(e)
      if (r) return r
    }
    const a = e.asked
    const m = e.market
    const parts = []
    if (a && isNum(a.amount)) parts.push(T('pc.whisper.yours', { amount: num(a.amount), unit: a.unit ?? '' }))
    if (m && isNum(m.chaos)) {
      if (a && isNum(a.chaos) && a.chaos > 0 && isNum(a.amount)) {
        parts.push(T('pc.whisper.market', { amount: num(m.chaos * a.amount / a.chaos), unit: a.unit ?? '' }))
      } else {
        parts.push(T('pc.whisper.marketChaos', { amount: num(m.chaos) }))
      }
    }
    let text = parts.join(' · ')
    if (isNum(e.pct) && (e.verdict === 'below' || e.verdict === 'above' || e.verdict === 'fair')) {
      const sign = e.verdict === 'below' ? '−' : e.verdict === 'above' ? '+' : '±'
      text += ` (${sign}${num(e.pct)} %)`
    }
    return text
  }

  function verdictText (e) {
    const v = e.verdict
    if (v === 'not-compared') {
      const why = e.reason == null ? '' : e.reason === 'other-league'
        ? T('pc.whisper.reason.other-league', { league: e.league ?? '' })
        : word('pc.whisper.reason.', e.reason)
      return why ? `${T('pc.whisper.verdict.not-compared')} — ${why}` : T('pc.whisper.verdict.not-compared')
    }
    return word('pc.whisper.verdict.', v)
  }

  function rowHtml (e) {
    if (!e || typeof e !== 'object') return ''
    const who = `${e.label ?? ''}${e.by ? ` · ${String(e.by).slice(0, 4)}` : ''}`
    const item = e.verdict === 'unparsed'
      ? T('pc.whisper.unparsedItem')
      : `${e.kind === 'bulk' && isNum(e.qty) ? `${num(e.qty)} × ` : ''}${e.item && e.item.text != null ? e.item.text : ''}`
    const where = e.tab != null && isNum(e.left) && isNum(e.top)
      ? T('pc.whisper.where', { tab: e.tab, left: e.left, top: e.top })
      : ''
    const cls = VERDICT_CLASS[e.verdict] || 'wv-nc'
    return '<li class="wrow">' +
      `<span class="wtime">${esc(timeOf(e.at))}</span>` +
      `<span class="wwho">${esc(who)}</span>` +
      `<span class="witem">${esc(item)}</span>` +
      `<span class="wprice">${esc(priceText(e))}</span>` +
      `<span class="wverdict ${cls}">${esc(verdictText(e))}</span>` +
      `<span class="wwhere">${esc(where)}</span>` +
      '</li>'
  }

  const listHtml = entries => (Array.isArray(entries) ? entries.map(rowHtml).join('') : '')

  // One `whisper` message into the list: replaced by its key (instance plus
  // wid), or put in front.
  function upsert (list, entry) {
    if (!entry || typeof entry !== 'object' || entry.key == null) return list
    const i = list.findIndex(e => e.key === entry.key)
    if (i < 0) return [entry, ...list]
    const next = list.slice()
    next[i] = entry
    return next
  }

  return { rowHtml, listHtml, upsert }
})()
