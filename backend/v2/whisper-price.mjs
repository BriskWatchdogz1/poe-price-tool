// backend/v2/whisper-price.mjs
// "Am I selling below the market?" for a parsed buyer whisper (whisper.mjs).
// The price in a trade whisper is the SELLER's own listed price (the buyer
// copies the trade site's template), so 'below' means: this player is about to
// sell under the market. NEVER a trade-API request: fungibles go through the
// net-worth valuator (Faustus, then poe.ninja) so a whisper and the Net Worth
// page cannot disagree about the same item; a unique is compared only when
// exactly one poe.ninja line can be meant; rares, magic and normal items and
// gems never. Falsely priced is worse than unpriced, so anything uncertain
// says 'not-compared' with a reason (docs/pricing-logic.md, "What a
// buyer-whisper verdict means").
//
// What each field is for (the decision it serves):
//   asked.chaos      your own listed price, in chaos (bulk: what the buyer puts up)
//   market.chaos     what the same goods are worth by this tool's prices
//   ratio/verdict    answer at that price, or is your listing off?
//   tab/left/top     where the goods lie, to pick them up without searching
//   quad             that tab is a quad tab (24x24 cells) by the last sync, or null:
//                    the daemon's stash cell frame draws the right grid
//   reason           WHY there is no comparison, so 'no number' is never read as 'fair'
//   stack            a single whisper for a stackable: the per-stack reading of your
//                    price next to the per-unit one, so you see both without a verdict
//   caveat           on those readings: the C:D rate or the market price is in doubt,
//                    so a number you compare yourself is not taken as sure
//
// Also here: the route's logic without HTTP (createWhisperHandler), the
// session's whisper list (createWhisperBook, memory only) and the per-user
// rate gate. Nothing of a whisper's text, item or label is ever logged.
import { readFile } from 'node:fs/promises'
import { parseWhisper, splitLeague } from './whisper.mjs'
import { roundExchange } from './ninja.mjs'
import { SINGLE_ITEM_KINDS } from './networth/kinds.mjs'

export const VERDICTS = ['fair', 'below', 'above', 'not-compared', 'unparsed', 'pending']
export const REASONS = ['rare', 'magic-or-normal', 'gem', 'variants', 'no-market', 'unknown-currency',
  'no-rate', 'other-league', 'unknown-item', 'no-language-data', 'stack-unknown', 'pricing-off',
  'unpriced-listing', 'rate-unknown', 'uncertain-price', 'error']

const GEM_EN = /^level (\d+) (\d+)% (.+)$/
const MAP_TIER = / \(T\d+\)$/
const MAP_WITH_TIER = /\bMap \(T\d+\)$/
// An item text longer than any real one is not looked at word by word.
const MAX_ITEM_TEXT = 300
const MAX_WORDS = 40
const MAX_RUN = 6
// '20 Orb of Alchemy': a stack size in front of a single whisper's item name.
const LEAD_QTY = /^(\d{1,6}) (.+)$/

const r2 = n => Math.round(n * 100) / 100
// For display only: one decimal from 1 c up, three significant digits below
// (a Transmutation at 0.149 c is not 0.1 c). The verdict is reached on the
// unrounded numbers; rounded unit prices put 1000 Transmutations for a
// divine at 0.2 against 0.1 c, 'above' by 100 % for a fair offer.
const shown = n => roundExchange(n)

// Item text of a whisper -> what it is. Order (each step tested):
// 1 gem: /^level (\d+) (\d+)% (.+)$/ (en; a German gem wording is not known -> 'unknown-item').
// 2 the whole text is a catalogue name (also one with ', ': 'Brush, Paint and
//   Palette', 'Farrul, First of the Plains'): a gem -> gem; describe(ref) not
//   null -> { kind:'fungible', ref, desc }; else -> magic-or-normal (a base).
// 3 text with ', ': split at the LAST ', ' into name and base; base without ' (T\d+)'.
//   name is a unique on that base (uniques: Map name -> Set(base))
//   -> { kind:'unique', ref, base }; a unique map names its own map base while
//   the catalogue gives every unique map the base 'Map' -> { kind:'unique',
//   ref, base: null, category: 'Map' }; else -> { kind:'rare' } (a rare's
//   invented name, also rare maps).
// 4 no comma: text ends in ' Map (T\d+)', or a run of its words is a catalogue
//   base -> { kind:'magic-or-normal' }; else { kind:'unknown-item' }.
// localToRef: null for English (names are reference names), else a function
// localized name -> reference name or null (unknown or ambiguous).
export function resolveWhisperItem (text, { byName, uniques, localToRef = null, describe }) {
  if (typeof text !== 'string' || !text || text.length > MAX_ITEM_TEXT) return { kind: 'unknown-item' }
  const catalogueRef = n => {
    if (byName.has(n)) return n
    const r = localToRef ? localToRef(n) : null
    return r && byName.has(r) ? r : null
  }

  const gem = GEM_EN.exec(text)
  if (gem) return { kind: 'gem', ref: catalogueRef(gem[3]) || gem[3], level: Number(gem[1]), quality: Number(gem[2]) }

  const whole = catalogueRef(text)
  if (whole) {
    if (byName.get(whole)?.namespace === 'GEM') return { kind: 'gem', ref: whole }
    const desc = describe(whole)
    return desc ? { kind: 'fungible', ref: whole, desc } : { kind: 'magic-or-normal', ref: whole }
  }

  const cut = text.lastIndexOf(', ')
  if (cut > 0) {
    const name = text.slice(0, cut)
    const rawBase = text.slice(cut + 2)
    const base = rawBase.replace(MAP_TIER, '')
    const bases = uniques.get(name)
    if (bases) {
      const ref = localToRef ? localToRef(name) : name
      if (bases.has(base)) {
        const refBase = catalogueRef(base) || (localToRef ? null : base)
        return ref && refBase ? { kind: 'unique', ref, base: refBase } : { kind: 'unknown-item' }
      }
      if (/\bMap$/.test(base) && [...bases].some(b => (catalogueRef(b) || b) === 'Map')) {
        return ref ? { kind: 'unique', ref, base: null, category: 'Map' } : { kind: 'unknown-item' }
      }
    }
    return { kind: 'rare' }
  }

  if (MAP_WITH_TIER.test(text)) return { kind: 'magic-or-normal' }
  const words = text.split(' ').slice(0, MAX_WORDS)
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j <= Math.min(words.length, i + MAX_RUN); j++) {
      const ref = catalogueRef(words.slice(i, j).join(' '))
      if (ref && byName.get(ref)?.craftable) return { kind: 'magic-or-normal' }
    }
  }
  return { kind: 'unknown-item' }
}

// The item of a whisper in one language's names, and a stack size in front
// of it ('20 Orb of Alchemy'): only when the whole text is no item and the
// rest is one that stacks, so a name that begins with a number is never cut.
// Bulk whispers carry their quantity apart and are never cut.
function readItem (text, ctx, bulk) {
  const item = resolveWhisperItem(text, ctx)
  if (!bulk && item.kind === 'unknown-item') {
    const lead = LEAD_QTY.exec(text)
    const rest = lead ? resolveWhisperItem(lead[2], ctx) : null
    if (rest?.kind === 'fungible' && !SINGLE_ITEM_KINDS.has(rest.desc?.kind)) return { item: rest, named: Number(lead[1]) }
  }
  return { item, named: null }
}

// asked/market -> verdict; lowRatio/highRatio from POE_WHISPER_LOW_RATIO/HIGH_RATIO.
// Also the rule of the Net Worth page's "Listed below market" block
// (networth/listing-audit.mjs), which calls this function rather than copying it.
// Both sides for the same quantity and unrounded (the pricer passes totals).
// pct: how far off the market, in whole percent, without a sign (the verdict
// says which way).
export function verdictFor (askedChaos, marketChaos, { lowRatio, highRatio }) {
  if (!(typeof askedChaos === 'number' && askedChaos >= 0) || !(typeof marketChaos === 'number' && marketChaos > 0)) {
    return { verdict: 'not-compared', ratio: null, pct: null }
  }
  const ratio = askedChaos / marketChaos
  const verdict = ratio < lowRatio ? 'below' : ratio > highRatio ? 'above' : 'fair'
  return { verdict, ratio: r2(ratio), pct: Math.round(Math.abs(1 - ratio) * 100) }
}

// Resolve `promise` or, after ms, { pending: true } (the promise keeps running).
// A deadline of 0 is pending at once. Only ever given a promise from
// priceSafely(), which never rejects.
export function withDeadline (promise, ms, { setTimer = setTimeout } = {}) {
  if (!(ms > 0)) return Promise.resolve({ pending: true })
  let timer = null
  const deadline = new Promise(resolve => {
    timer = setTimer(() => resolve({ pending: true }), ms)
    try { timer?.unref?.() } catch { /* a fake timer */ }
  })
  return Promise.race([promise, deadline]).finally(() => { try { clearTimeout(timer) } catch { /* a fake timer */ } })
}

const errorResult = () => ({ verdict: 'not-compared', reason: 'error' })

// pricer.price() that NEVER rejects: a synchronous throw or a rejection (a bug in
// resolveContext, descriptorForName, a valuator) becomes
// { verdict: 'not-compared', reason: 'error' } and one call of onError(e), which
// the handler reports as a 'valuation' failure (createWhisperErrorLog), without
// any whisper text.
export function priceSafely (pricer, parsed, opts, onError) {
  let run
  try { run = Promise.resolve(pricer.price(parsed, opts)) } catch (e) { run = Promise.reject(e) }
  return run.then(
    r => (r && typeof r === 'object' ? r : errorResult()),
    e => { try { onError?.(e) } catch { /* the log itself failed */ } return errorResult() }
  )
}

export function createWhisperPricer ({
  valuatorFor,         // league -> valuator (server.mjs, at module scope)
  resolveContext,      // lang -> { byName, uniques, localToRef, describe, categoryOf } | null (no data for that language)
  fallbackLangs = () => [], // the languages with name data, tried in this order for a whisper whose own
                       // language has none (server.mjs: every loaded one, English first)
  chaosPerTag,         // async (trade tag or currency name, league) -> null (not a currency this tool knows)
                       // | { chaos: null } (a known currency without a price now)
                       // | { chaos, fallback, uncertain }: chaos unrounded; fallback: the C:D rate is the
                       // POE_CD_RATIO fallback or older than its staleAfterMs; uncertain: the valuator's
                       // marker on the currency's own price (thin-market, ...) or null
  lowRatio, highRatio,
  pricingOff = false,  // POE_PRICE_CHECK_DISABLED: parse, never value
  stackAt = null       // ({ user, league, tab, left, top, ref }) -> stack size the last sync saw at
                       // that cell, or null (server.mjs, networth/listing-audit.mjs stackSizeAt);
                       // only asked for a 'stack-unknown' whisper, never a stash request
}) {
  // The market side of one item, or the reason there is none. total: the
  // unrounded market value of qty units, for the verdict only.
  async function marketFor (item, qty, league, ctx) {
    const market = (each, source, uncertain) => ({
      market: { chaosEach: shown(each), chaos: shown(each * qty), source, uncertain }, total: each * qty, reason: null
    })
    if (item.kind === 'unique') {
      const category = item.category ?? ctx.categoryOf?.(item.base) ?? null
      const lines = await valuatorFor(league).uniqueCandidates({ kind: 'unique', name: item.ref, baseType: item.base, category })
      if (!Array.isArray(lines) || !lines.length) return { market: null, reason: 'no-market' }
      if (lines.length > 1) return { market: null, reason: 'variants' }
      return market(lines[0].chaosValue, 'ninja', null)
    }
    if (item.kind === 'fungible') {
      const v = await valuatorFor(league).valueEach(item.desc)
      if (!v || typeof v.each !== 'number' || !(v.each >= 0)) return { market: null, reason: 'no-market' }
      return market(v.each, v.source ?? null, v.uncertain ?? null)
    }
    return { market: null, reason: null }
  }

  const ITEM_REASONS = { rare: 'rare', gem: 'gem', 'magic-or-normal': 'magic-or-normal', 'unknown-item': 'unknown-item' }

  // The stack size for the second reading of a single whisper's 'listed for':
  // the one the whisper names in front of the item, else the one the last
  // sync saw at the whisper's tab and cell, else null. Below 2 there is no
  // second reading. A lookup that fails is no size.
  async function stackSizeFor (named, parsed, item, user, league) {
    const ok = n => (Number.isInteger(n) && n >= 2 ? n : null)
    if (ok(named)) return { size: named, from: 'whisper' }
    if (!stackAt) return null
    let n = null
    try { n = await stackAt({ user, league, tab: parsed.tab, left: parsed.left, top: parsed.top, ref: item.ref }) } catch { n = null }
    return ok(n) ? { size: n, from: 'sync' } : null
  }

  // price(parsed, { league, user }) -> { kind, item:{ text, ref, base, kind }, qty, asked:{ amount, unit, chaos, chaosEach },
  //   market:{ chaosEach, chaos, source, uncertain } | null, ratio, pct, verdict, reason[, league, extraLen]
  //   [, stack: { size, from: 'whisper' | 'sync', chaosEach } | null,
  //    caveat: 'rate-unknown' | 'uncertain-price' | null on 'stack-unknown' only] }
  // The reason with the most to say wins: another league, pricing off, no
  // language data, what the item is (rare, gem, …), an unknown currency or a
  // known one without a price, no market line or several, a single whisper
  // for an item that stacks, a C:D rate that is the fallback or stale, a
  // market price or currency price on thin evidence (the valuator's
  // `uncertain` marker: falsely priced is worse than unpriced).
  async function price (parsed, { league, user = null }) {
    const bulk = parsed.kind === 'bulk'
    const qty = bulk ? parsed.qty : 1
    const out = {
      kind: parsed.kind,
      item: { text: parsed.item, ref: null, base: null, kind: null },
      qty,
      asked: null,
      market: null,
      ratio: null,
      pct: null,
      verdict: 'not-compared',
      reason: null
    }
    const stop = reason => { out.verdict = 'not-compared'; out.reason = reason; return out }

    // Another league: before any lookup (no poe.ninja load for a league nobody here plays).
    // A bulk template that closes its league (German) gives the league itself.
    if (bulk) {
      const s = parsed.league != null
        ? (parsed.league === league ? { league, extraLen: parsed.extraLen ?? 0 } : null)
        : splitLeague(parsed.rest, league)
      if (!s) { out.league = String(parsed.league ?? parsed.rest ?? '').slice(0, 40); out.extraLen = null; return stop('other-league') }
      out.league = s.league
      out.extraLen = s.extraLen
    } else if (parsed.league !== league) {
      return stop('other-league')
    }
    if (pricingOff) return stop('pricing-off')
    const read = c => readItem(parsed.item, c, bulk)
    let ctx = resolveContext(parsed.lang)
    let item, named
    let noData = false
    if (ctx) {
      ({ item, named } = read(ctx))
    } else {
      // No item names for the whisper's language: a name one of the loaded
      // languages knows EXACTLY (a catalogue item, a unique on its base, or a
      // gem in the English wording whose name is in the catalogue) is taken;
      // what they would only infer (a rare from a cut at ', ', a magic item
      // from a base inside the text, gem-shaped text with an unknown name, an
      // unknown item) says nothing about a foreign name, so the item stays
      // text and the reason is the language. The listed price is still read.
      const loaded = []
      for (const lang of fallbackLangs() || []) {
        const c = lang === parsed.lang ? null : resolveContext(lang)
        if (c) loaded.push(c)
      }
      for (const c of loaded) {
        const r = read(c)
        if (r.item.ref && (r.item.kind !== 'gem' || c.byName.has(r.item.ref))) { ctx = c; ({ item, named } = r); break }
      }
      if (!ctx) { ctx = loaded[0] || null; item = { kind: null }; named = null; noData = true }
    }
    out.item = { text: parsed.item, ref: item.ref ?? null, base: item.base ?? null, kind: item.kind }
    const m = noData ? { market: null, reason: null } : await marketFor(item, qty, league, ctx)
    out.market = m.market

    if (parsed.kind === 'unpriced-listing') {
      return stop(noData ? 'no-language-data' : ITEM_REASONS[item.kind] || m.reason || 'unpriced-listing')
    }

    const unit = bulk ? parsed.currency : parsed.tag
    const unitRef = ctx?.localToRef && !ctx.byName.has(unit) ? (ctx.localToRef(unit) || unit) : unit
    const conv = await chaosPerTag(unitRef, league)
    const askedChaos = conv && typeof conv.chaos === 'number' && conv.chaos >= 0 ? parsed.amount * conv.chaos : null
    out.asked = {
      amount: parsed.amount,
      unit,
      chaos: askedChaos == null ? null : shown(askedChaos),
      chaosEach: askedChaos == null ? null : shown(askedChaos / qty)
    }

    if (noData) return stop('no-language-data')
    if (ITEM_REASONS[item.kind]) return stop(ITEM_REASONS[item.kind])
    if (!conv) return stop('unknown-currency')
    if (askedChaos == null) return stop('no-rate')
    if (m.reason) return stop(m.reason)
    // A single whisper for what stacks: 'listed for' may be per unit or per
    // stack, and nobody here knows which GGG means. No verdict, but both
    // readings: per unit (asked.chaos against market.chaosEach) and, when a
    // stack size is known, per stack of that size (stack.chaosEach, the
    // listed price divided by it). Only for what stacks: a captured beast is
    // one per slot and compares like a unique.
    if (!bulk && item.kind === 'fungible' && !SINGLE_ITEM_KINDS.has(item.desc?.kind)) {
      const st = await stackSizeFor(named, parsed, item, user, league)
      out.stack = st ? { size: st.size, from: st.from, chaosEach: shown(askedChaos / st.size) } : null
      // What would stop a verdict also doubts these numbers, which the
      // player compares without one, so they say so (the rate first, it
      // moves every number on the line).
      out.caveat = conv.fallback ? 'rate-unknown' : (m.market?.uncertain || conv.uncertain) ? 'uncertain-price' : null
      return stop('stack-unknown')
    }
    if (conv.fallback) return stop('rate-unknown')
    if (m.market?.uncertain || conv.uncertain) return stop('uncertain-price')
    const v = verdictFor(askedChaos, m.total, { lowRatio, highRatio })
    if (v.verdict === 'not-compared') return stop('no-market')
    Object.assign(out, v)
    return out
  }
  return { price }
}

// At most perMin admitted per user in any sliding minute (POE_WHISPER_MAX_PER_MIN).
export function createRateGate ({ perMin, now = () => Date.now() }) {
  const seen = new Map() // user -> timestamps of admitted whispers
  return {
    admit (user) {
      const t = now()
      const list = (seen.get(user) || []).filter(at => t - at < 60_000)
      if (list.length >= perMin) { seen.set(user, list); return false }
      list.push(t)
      seen.set(user, list)
      return true
    }
  }
}

// The session's whispers per user, memory only, newest first; a restart
// forgets them. key = `${instance}:${wid}`: a wid counts per daemon run and
// starts at w1 again after a restart, and two daemons of one user both have a
// w1. `unparsed` counts since the start, also when keep is 0.
export function createWhisperBook ({ users, keep }) {
  const rooms = new Map()
  for (const u of users) rooms.set(u, { entries: [], unparsed: 0 })
  return {
    add (user, entry) {
      const r = rooms.get(user)
      if (!r) return
      if (entry.verdict === 'unparsed') r.unparsed++
      if (!(keep > 0)) return
      r.entries = [entry, ...r.entries.filter(e => e.key !== entry.key)].slice(0, keep)
    },
    update (user, key, patch) {
      const r = rooms.get(user)
      const i = r ? r.entries.findIndex(e => e.key === key) : -1
      if (i < 0) return null
      r.entries[i] = { ...r.entries[i], ...patch }
      return r.entries[i]
    },
    list (user) { return [...(rooms.get(user)?.entries || [])] },
    unparsed (user) { return rooms.get(user)?.unparsed ?? 0 }
  }
}

const WID = /^w\d{1,9}$/
const LABEL = /^buyer \d{1,9}$/
const MAX_BODY_CHARS = 2000

// What failed, for the error log: the valuation of a whisper (it then says
// not-compared / error), handing an entry to the browser or the daemon feed,
// or the handler's own work around both.
export const WHISPER_FAILURES = ['valuation', 'delivery', 'handler']
export const WHISPER_ERROR_LOG_EVERY_MS = 60_000

// The error log for the whisper route: per kind of failure at most one line
// per everyMs, and the next line counts what was left out in between, so a
// failure that keeps happening stays visible without flooding the log. Only
// the error's message, never a whisper's text, item or label.
export function createWhisperErrorLog ({ everyMs = WHISPER_ERROR_LOG_EVERY_MS, now = () => Date.now(), warn = console.warn } = {}) {
  const state = new Map() // what -> { lastAt, skipped }
  return (e, what = 'handler') => {
    const kind = WHISPER_FAILURES.includes(what) ? what : 'handler'
    const t = now()
    const s = state.get(kind)
    if (s && t - s.lastAt < everyMs) { s.skipped++; return }
    const skipped = s?.skipped ?? 0
    state.set(kind, { lastAt: t, skipped: 0 })
    const m = String(e?.message || e).slice(0, 200)
    warn(`[whisper] ${kind} failed: ${m}${skipped ? ` (${skipped} more ${kind} failures since the last line)` : ''}`)
  }
}

// The route's logic without HTTP, so tests drive it with stubs (a pricer that
// throws, KEEP 0, a deadline of 0). server.mjs only reads the body and calls it.
// handle() never throws and never rejects. onError(e, what): what is one of
// WHISPER_FAILURES. log: one line per whisper with its kind, language and
// verdict, never its text, item or label. quadOf({ user, league, tab }) ->
// true | false | null: is the whisper's tab a quad tab by the last sync
// (server.mjs, networth/listing-audit.mjs createQuadLookup); every parsed entry
// carries the answer as `quad` (null without a tab, without a lookup, or when
// it throws), for the daemon's stash cell frame.
export function createWhisperHandler ({ pricer, book, rate, deadlineMs, broadcast, pushWhisper, onUnparsed, onError, quadOf = null, log = () => {}, now = () => Date.now() }) {
  const report = (e, what) => { try { onError?.(e, what) } catch { /* the log itself failed */ } }
  const safe = (fn, what = 'handler') => (...args) => { try { fn(...args) } catch (e) { report(e, what) } }
  const send = safe((user, entry, instance) => {
    safe(broadcast, 'delivery')(user, { type: 'whisper', entry })
    safe(pushWhisper, 'delivery')(user, entry, { by: instance })
  }, 'delivery')
  const quadFor = (user, league, tab) => {
    if (!quadOf || typeof tab !== 'string') return null
    try {
      const q = quadOf({ user, league, tab })
      return q === true || q === false ? q : null
    } catch { return null }
  }
  const say = safe((user, entry) => log(`[whisper] ${user}: ${entry.kind || 'unparsed'} ${entry.lang || '-'} -> ${entry.verdict}${entry.reason ? ` (${entry.reason})` : ''}`))

  async function handle ({ user, instance, league }, value) {
    try {
      // Body: { v, wid, body, label[, truncated] }. A field 'name' is never read.
      const { wid, body, label } = value || {}
      if (typeof wid !== 'string' || !WID.test(wid) || typeof body !== 'string' || body.length > MAX_BODY_CHARS ||
          typeof label !== 'string' || !LABEL.test(label)) return { status: 400, body: { error: 'bad whisper' } }
      if (!rate.admit(user)) return { status: 429, body: { error: 'too-many-whispers' } }
      const key = `${instance}:${wid}`
      let entry = { key, wid, label, at: now(), by: instance, truncated: value.truncated === true }
      const p = parseWhisper(body)
      if (!p) {
        entry = { ...entry, verdict: 'unparsed' } // the text is NOT kept; counted for daemon-status
        book.add(user, entry)
        send(user, entry, instance)
        safe(onUnparsed)(user)
        say(user, entry)
        return { status: 200, body: { v: 1, entry } }
      }
      const base = {
        ...entry, kind: p.kind, lang: p.lang, league: p.league ?? null, tab: p.tab ?? null,
        left: p.left ?? null, top: p.top ?? null, extraLen: p.extraLen ?? null, quad: quadFor(user, league, p.tab)
      }
      const run = priceSafely(pricer, p, { league, user }, e => report(e, 'valuation')) // never rejects
      const first = await withDeadline(run, deadlineMs)
      entry = first.pending ? { ...base, verdict: 'pending' } : { ...base, ...first }
      book.add(user, entry) // with keep 0 the book holds nothing; fine
      send(user, entry, instance) // a final one too: an answer whose HTTP response the daemon gave up on still arrives
      if (first.pending) {
        run.then(r => {
          // Built from base + result and ALWAYS sent: the book may no longer
          // hold the entry (POE_WHISPER_KEEP=0, or pushed out); it is only
          // updated when it does.
          const done = { ...base, ...r }
          safe(() => book.update(user, key, r))()
          send(user, done, instance)
          say(user, done)
        }).catch(e => report(e, 'handler'))
      } else {
        say(user, entry)
      }
      return { status: 200, body: { v: 1, entry } }
    } catch (e) {
      report(e, 'handler')
      return { status: 500, body: { error: 'internal' } }
    }
  }
  return { handle }
}

// UNIQUE entries of an items.ndjson -> Map(name -> Set(base)). A localized file
// maps its localized names, and its bases too, through the ITEM entries of the
// same file (their `unique.base` is the English reference name); a base whose
// localized name is ambiguous keeps the reference name. Rejects when the file
// cannot be read (the caller then has no data for that language).
export async function loadUniqueIndex (path) {
  const raw = await readFile(path, 'utf8')
  const localByRef = new Map() // ITEM refName -> localized name, null when ambiguous
  const uniques = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || typeof e.name !== 'string' || !e.name) continue
    if (e.namespace === 'UNIQUE') {
      if (typeof e.unique?.base === 'string' && e.unique.base) uniques.push(e)
    } else if (e.namespace === 'ITEM' && typeof e.refName === 'string') {
      if (localByRef.has(e.refName) && localByRef.get(e.refName) !== e.name) localByRef.set(e.refName, null)
      else if (!localByRef.has(e.refName)) localByRef.set(e.refName, e.name)
    }
  }
  const out = new Map()
  for (const e of uniques) {
    const base = localByRef.get(e.unique.base) || e.unique.base
    if (!out.has(e.name)) out.set(e.name, new Set())
    out.get(e.name).add(base)
  }
  return out
}
