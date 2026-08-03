/* Trade Console v2 — Vanilla frontend.
 * Speaks the WS `/events` protocol documented in PROTOCOL.md.
 * No framework, no build step. */
'use strict'

const reduce = matchMedia('(prefers-reduced-motion:reduce)').matches

// ---- DOM handles -----------------------------------------------------------
const grid     = document.getElementById('grid')
const empty     = document.getElementById('empty')
const badge     = document.getElementById('badge')
const conn      = document.getElementById('conn')
const connlbl   = document.getElementById('connlbl')
const ref       = document.getElementById('ref')
const ratebanner= document.getElementById('ratebanner')
const rbmsg     = document.getElementById('rbmsg')
const rbwait    = document.getElementById('rbwait')

// ---- State -----------------------------------------------------------------
const items = new Map()          // id -> item data (last-known state)
const pending = new Set()        // ids the user searched, awaiting price-result

// ---- Helpers ---------------------------------------------------------------
const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')

const fmtK = n => n >= 1000 ? (n % 1000 === 0 ? (n/1000)+'k' : (n/1000).toFixed(1)+'k') : String(n)
const cap  = s => s ? s[0].toUpperCase() + s.slice(1) : s

// gold currencies vs teal (chaos-ish)
const GOLD = new Set(['divine','div','exalted','ex','mirror','mir'])
const curUnit = c => ({divine:'div', chaos:'c', exalted:'ex', mirror:'mir'}[c] || c)
const isGold = c => GOLD.has(c)

function ageLabel (m) {
  if (m == null) return ''
  if (m < 60) return m + 'm'
  if (m < 1440) return Math.round(m/60) + 'h'
  return Math.round(m/1440) + 'd'
}

function tierLabel (t) {
  if (t == null) return ''
  return typeof t === 'number' ? 'Tier ' + t : t
}

// Derive a sensible slider step from the roll range. Integer ranges with
// enough span get whole-number steps; float stats (e.g. "Attacks per Second"
// 1.36–1.44) or very small spans get a fine step (~50 steps, snapped to a
// "nice" size) so the handles can actually move.
function rangeStep (lo, hi) {
  const span = hi - lo
  const isInt = Number.isInteger(lo) && Number.isInteger(hi)
  // Integer-bounded stats (linked sockets, "Life per Enemy Hit", small counts…)
  // must step in WHOLE numbers regardless of span — a fractional link/count is
  // nonsense. Only float-bounded stats (APS 1.36–1.44, crit 5.4–5.7) get the
  // fine ~50-step scale below.
  if (isInt) {
    return span > 2000 ? 100 : (span > 400 ? 10 : 1)
  }
  const target = span / 50 || 0.01
  const nice = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5]
  for (const n of nice) if (n >= target) return n
  return 0.01
}

// Inserts the roll value into the mod text and turns it into a live-updating
// bold span (tracking the range slider).
// PoE stat texts carry '#' placeholders ("Adds # Passive Skills", "Evasion
// Rating: #") — the value lives separately in mod.value. With EXACTLY ONE '#'
// insert the value there. Multiple '#' (range mods like "Adds # to #
// Lightning Damage") are left as-is; the slider shows their values (no sensible single fill).
function modTextHtml (mod) {
  const t = esc(mod.text)
  if (mod.value != null) {
    const v = String(mod.value)
    const boldV = '<b class="live">' + esc(v) + '</b>'
    if ((t.match(/#/g) || []).length === 1) {
      return t.replace('#', boldV)
    }
    // Fallback: text already spells out the value -> bold the first occurrence.
    const i = t.indexOf(v)
    if (i >= 0) {
      return t.slice(0, i) + boldV + t.slice(i + v.length)
    }
  }
  return t
}

// group order + human header for the mod picker. 'links' (the synthetic
// Linked-sockets filter, see server.mjs LINKS_MOD_TEXT) sits first so it's
// the first thing the user sees — links matter more than mods this patch.
const GROUP_ORDER = ['links','unknown','implicit','fractured','prefix','suffix','explicit','crafted']
const GROUP_HEAD  = { links:'Sockets', unknown:'Not searchable', implicit:'Implicit', fractured:'Fractured', prefix:'Prefixes',
                      suffix:'Suffixes', explicit:'Explicit', crafted:'Crafted' }
const GROUP_CLASS = { prefix:'pfx', suffix:'sfx', fractured:'frac' }

// ---- Card building ---------------------------------------------------------
function priceHtml (item) {
  const st = item.priceStatus
  const p  = item.price
  if (st === 'queued' || (!p && st !== 'error' && st !== 'searching' && st !== 'rate-limited')) {
    return `<div class="pr wait">queued</div><div class="hits">in queue</div>`
  }
  if (st === 'searching') {
    return `<div class="pr wait"><span class="psp"></span>searching…</div><div class="hits">priority</div>`
  }
  if (st === 'rate-limited') {
    return `<div class="pr wait rl">rate-limited</div><div class="hits">searches paused</div>`
  }
  if (st === 'error') {
    return `<div class="pr err">no price</div><div class="hits">try again</div>`
  }
  // done
  if (!p) return `<div class="pr wait">—</div><div class="hits">no data</div>`
  const gold = isGold(p.currency)
  const unit = curUnit(p.currency)
  // poe.ninja market value (Divination Cards etc., see server.mjs
  // NINJA_BULK_CLASSES): a single aggregated value, no listings to count —
  // label the source instead of "N listings" so it's never mistaken for a
  // (possibly stale) trade-search hit count.
  if (p.display === 'ninja') {
    // Aggregated single value — the source varies (poe.ninja, or GGG's Currency
    // Exchange for a fungible the bulk exchange didn't answer), so name it.
    const prTxt = `${p.priceLow}<span class="u">${esc(unit)}</span>`
    const label = esc(p.sourceLabel || 'poe.ninja')
    const note = p.sourceNote ? esc(p.sourceNote) : (p.count != null ? p.count + ' data pts' : 'market value')
    return `<div class="pr ${gold ? '' : 'c'}">${prTxt}</div><div class="hits"><b>${label}</b>${note}</div>`
  }
  let prTxt
  if (p.display === 'bulk') {
    prTxt = `${p.priceLow} : 1<span class="u">${esc(unit)}/div</span>`
  } else if (p.priceLow === p.priceHigh) {
    prTxt = `${p.priceLow}<span class="u">${esc(unit)}</span>`
  } else {
    // Range plus median: on a thin market one absurd listing stretches the range
    // ("1-250c" for a 1c base), so show the typical price next to it. Shown for
    // ANY real range — including when the median sits ON one end, which is
    // exactly when it says the most ("1-250c | 1c" = nearly everything is at the
    // bottom, the 250 is one outlier). Requiring it strictly inside hid it in
    // that case. A degenerate range (low === high) took the branch above.
    const med = typeof p.priceMedian === 'number' && p.priceMedian > 0
      ? `<span class="med" title="Median — the typical price, unmoved by outliers">${p.priceMedian}</span>` : ''
    prTxt = `${p.priceLow}–${p.priceHigh}<span class="u">${esc(unit)}</span>${med}`
  }
  const hits = p.display === 'bulk'
    ? `<b>bulk</b>${p.count} sellers`
    : `<b>${p.count}</b>listings`
  // Priced off the in-game Currency Exchange: name the source under the
  // headline and keep the trade site's ASK as a secondary line, so the gap
  // between "what it clears at" and "what people ask" stays visible instead of
  // silently becoming the price (see server.mjs withExchangeMain). The listings
  // below are unaffected — those are still the trade offers.
  const head = `<div class="pr ${gold ? '' : 'c'}">${prTxt}</div>`
  if (p.priceSource === 'exchange') {
    // The listing COUNT belongs to the trade-ask line, not to the exchange
    // rate: "6 listings" sitting next to the exchange headline read as "6
    // offers at 13.5c", which is not what it is (those 6 offers are the 1c..40c
    // trade listings below). So it moves onto the Trade-Ask line, and the spot
    // next to the headline shows the span the exchange itself traded at this
    // hour — the honest "how wide is this market" figure. No span known -> the
    // spot stays empty, no placeholder.
    const askTxt = p.tradeAsk
      ? `<div class="pask">Trade-Ask: ${esc(askText(p.tradeAsk))}${p.count != null ? ` · ${p.count} listings` : ''}</div>`
      : ''
    const r = p.exchangeRange
    const range = (r && typeof r.low === 'number' && typeof r.high === 'number')
      ? `<div class="hits"><span class="xrange" title="Range the exchange actually traded at this hour">range ${r.low}–${r.high} c</span></div>`
      : ''
    return `<div class="pcol">${head}<div class="psrc">${esc(p.sourceLabel || 'Exchange')}</div>${askTxt}</div>${range}`
  }
  const ask = p.tradeAsk
    ? `<div class="pask">Trade-Ask: ${esc(askText(p.tradeAsk))}</div>` : ''
  if (ask) {
    return `<div class="pcol">${head}${ask}</div><div class="hits">${hits}</div>`
  }
  return `${head}<div class="hits">${hits}</div>`
}

// "0.7–1 div (75–107 c)" — the trade-site ask next to an exchange headline. The
// chaos figures come from the server (converted at the same C:D rate the card
// uses) and are only added when the ask isn't already in chaos.
function askText (a) {
  const span = a.low === a.high ? `${a.low}` : `${a.low}–${a.high}`
  const cSpan = a.chaosLow === a.chaosHigh ? `${a.chaosLow}` : `${a.chaosLow}–${a.chaosHigh}`
  const chaos = (a.currency !== 'chaos' && a.chaosLow != null) ? ` (${cSpan} c)` : ''
  return `${span} ${curUnit(a.currency)}${chaos}`
}

// ---- poe.ninja reference (F3) ----------------------------------------------
// Builds a small inline SVG line from a sparkline array.
//
// Colour: rising line = green ('up'), falling = red ('dn'). `invert` flips that
// for rows whose number is a QUANTITY per currency unit (the rail's lifeforce rows
// show "44 / c") — there a rising number means the item got cheaper, which reads
// as bad. The flag is set statically per row type by the server, never derived
// from the data. Omitted -> today's behaviour (the item card's ninja reference).
function sparkSvg (data, invert = false) {
  if (!Array.isArray(data) || data.length < 2) return ''
  const w = 66, h = 16
  const min = Math.min(...data), max = Math.max(...data), span = (max - min) || 1
  const pts = data.map((v, i) =>
    `${(i / (data.length - 1) * w).toFixed(1)},${(h - (v - min) / span * h).toFixed(1)}`).join(' ')
  const rising = data[data.length - 1] >= data[0]
  const up = invert ? !rising : rising
  return `<svg class="nspark ${up ? 'up' : 'dn'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`
    + `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`
}

// Reference price + mini sparkline (only when there's a ninja match).
function ninjaHtml (item) {
  const n = item.ninja
  if (!n || (n.chaos == null && n.divine == null)) return ''
  const price = (typeof n.divine === 'number' && n.divine >= 1)
    ? `${n.divine} <span class="u">div</span>`
    : (n.chaos != null ? `${n.chaos} <span class="u">c</span>` : '')
  return `<span class="nlabel">poe.ninja</span><span class="nprice">${price}</span>${sparkSvg(n.sparkline)}`
}

// "Open Trade" button: opens the official pathofexile.com trade site with the
// EXACT search that produced the card's current price (search.id / exchange
// query id, passed through from engine.mts -> server.mjs's price-result
// broadcast as tradeId/tradeKind/league). No tradeId yet (nothing priced,
// error, or a bulk result the engine couldn't get an id for) -> render
// disabled instead of omitting it, so the chead layout doesn't jump around
// as a card goes queued -> searching -> done.
function tradeBtnHtml (item) {
  const p = item.price
  // Priced via poe.ninja -> there never was a trade query. Offer an "Open Ninja"
  // link to that item's poe.ninja economy page instead (the trade site has
  // nothing to open here). Fall back to a disabled button if we couldn't build
  // a URL (unknown league/name).
  if (p && p.priceSource === 'ninja') {
    if (p.ninjaUrl) {
      return `<button type="button" class="opentrade ninja" data-ninja-url="${esc(p.ninjaUrl)}"`
        + ` title="Open this item on poe.ninja">Open Ninja ↗</button>`
    }
    return `<button type="button" class="opentrade" disabled title="Priced via poe.ninja — no trade search was run">Open Ninja ↗</button>`
  }
  const id = p && p.tradeId
  if (!id) {
    return `<button type="button" class="opentrade" disabled title="No trade search yet">Open Trade ↗</button>`
  }
  const kind = p.tradeKind === 'exchange' ? 'exchange' : 'search'
  return `<button type="button" class="opentrade" data-trade-id="${esc(id)}" data-trade-kind="${esc(kind)}"`
    + ` data-trade-league="${esc(p.league)}" title="Open this search on pathofexile.com/trade">Open Trade ↗</button>`
}

const LISTINGS_VISIBLE = 5   // visible by default; the rest sits behind the expander

function listingsHtml (item) {
  const p = item.price
  if (!p || !Array.isArray(p.listings) || !p.listings.length) return ''
  // Exchange headline (fungibles): the individual trade offers below are the
  // BULK asks — for a 0.6c lifeforce that's five identical "164 c" rows, i.e.
  // one divine each, which says nothing about the item and reads like the tool
  // is lying. The Trade-Ask line above already carries that range plus the
  // listing count, so the rows are pure noise here. Rares/uniques (no
  // priceSource) keep their listings — there the offers ARE the price.
  if (p.priceSource === 'exchange') return ''
  const rows = p.listings.map((l, i) => {
    const gold = isGold(l.currency)
    const price = p.display === 'bulk' ? `${l.price}:1` : `${l.price} ${curUnit(l.currency)}`
    const extra = i >= LISTINGS_VISIBLE ? ' extra' : ''
    return `<div class="lrow${extra}"><span class="p ${gold ? '' : 'c'}">${esc(price)}</span>`
      + `<span class="who">${esc(l.seller)}</span>`
      + `<span class="age">${esc(ageLabel(l.ageMinutes))}</span></div>`
  }).join('')
  const hidden = p.listings.length - LISTINGS_VISIBLE
  const toggle = hidden > 0
    ? `<button class="lmore" type="button"><span class="lmi">+ ${hidden} more</span><span class="lmi less">− show less</span></button>`
    : ''
  // .lwrap carries the expanded state; it's recreated on every render -> resets to 5.
  return `<div class="lwrap">${rows}${toggle}</div>`
}

function modsSummaryHtml (item) {
  // 'links' is skipped up here: the chip would read a bare "Linked sockets" with
  // no number (the count lives on its slider), so it adds nothing to the summary.
  // It stays in the editor below, where it IS adjustable.
  const mods = (item.mods || [])
    .filter(m => m.kind !== 'links')
    .map(m => `<span class="mod">${modTextHtml(m)}</span>`)
  // Facts = filters the search applies that aren't mods (quality, item level).
  // Summary-only, no editor row: they're context for reading the price.
  const facts = (item.facts || []).map(f => `<span class="mod fact">${esc(f)}</span>`)
  return facts.concat(mods).join('')
}

function editorHtml (item) {
  const mods = item.mods || []
  const groups = {}
  for (const m of mods) (groups[m.kind] || (groups[m.kind] = [])).push(m)
  let rows = ''
  for (const kind of GROUP_ORDER) {
    const list = groups[kind]
    if (!list) continue
    // header only when more than a single flat group is meaningful
    if (mods.some(m => m.kind !== kind)) {
      rows += `<div class="gh ${GROUP_CLASS[kind] || ''}">${GROUP_HEAD[kind] || cap(kind)}</div>`
    }
    for (const m of list) rows += modRowHtml(m)
  }
  const selCount = mods.filter(m => m.selected).length
  // The tier is only in the clipboard when "Advanced Mod Descriptions" is on in
  // game. No tier information, no T2+ button.
  const hasTopTier = mods.some(m => typeof m.tier === 'number' && m.tier <= TOP_TIER)
  const noun = selCount === 1 ? 'mod' : 'mods'
  // Corruption filter default: a CORRUPTED item prices in a separate market (it
  // can't be modified further), so default to "yes" — searching "any" drowns it
  // in cheap non-corrupted twins and reads as near-worthless. Non-corrupted items
  // stay "any" (don't care). Matches the backend auto-search default. The chosen
  // value rides along in the `search` payload (corrupted: "any"|"yes"|"no").
  const cpref = item.corrupted ? 'yes' : 'any'
  const cbtn = (v, lbl) => `<button type="button" data-c="${v}"${v === cpref ? ' class="on"' : ''}>${lbl}</button>`
  return `<div class="editor"><div class="ed-inner">
      <div class="ed-head">
        <div class="ed-lead">Tick the mods to require and set each roll range (min–max). <b>Nothing runs until you hit Search.</b></div>
        ${hasTopTier ? '<button class="toptier" type="button" title="Tick only the mods that rolled tier 1 or 2">T2+</button>' : ''}
        <button class="allmods" type="button" title="Tick every mod — click again to untick all">All mods</button>
      </div>
      <div class="corruptbar"><span class="cl">Corrupted</span>
        <div class="ctog" data-val="${cpref}">${cbtn('any', 'any')}${cbtn('yes', 'yes')}${cbtn('no', 'no')}</div></div>
      <div class="mgroup">${rows}</div>
      <div class="ed-foot">
        <div class="flow"><span class="sel">${selCount}</span><span>${noun}</span><span class="arw">→</span><span class="chip">Search</span><span>refreshes prices</span>
          <button class="resetbtn" type="button" title="Reset ranges & ticks to this item's defaults">↺ Reset</button></div>
        <button class="searchbtn"><span class="sp"></span><span class="lbl">Search</span></button>
      </div>
    </div></div>`
}

function modRowHtml (m) {
  // Non-searchable mod (APT couldn't resolve it to a trade stat-id, e.g. a
  // new/unvendored corruption implicit): render read-only — NO checkbox (so
  // collectSelected skips it) and NO slider — with a badge so the price is honest
  // that this mod is NOT part of the search. It IS on GGG's live trade, so the
  // user can add it via Open Trade.
  if (m.searchable === false) {
    return `<div class="mrow unsearch" data-text="${esc(m.text)}"><span class="mtxt">${modTextHtml(m)}</span>`
      + `<span class="fracbadge" title="Not in the vendored trade data — add it manually via Open Trade">not searchable</span></div>`
  }
  const on = m.selected ? ' on' : ''
  const implClass = m.kind === 'implicit' ? ' impl' : ''
  const fracClass = m.kind === 'fractured' ? ' frac' : ''
  const tier = m.tier != null ? `<span class="tier">${esc(tierLabel(m.tier))}</span>` : ''
  // Fractured mods survive reforging and price very differently from a normal
  // explicit/implicit roll of the same stat -> always flag them right on the
  // row, not just via the (collapsible) group header above.
  const frac = m.kind === 'fractured' ? `<span class="fracbadge">fractured</span>` : ''
  const top = `<label class="top"><input type="checkbox" class="chk"${m.selected ? ' checked' : ''}>`
    + `<span class="mtxt${implClass}${fracClass}">${modTextHtml(m)}${tier}${frac}</span></label>`
  let range = ''
  if (Array.isArray(m.valueRange)) {
    const [lo, hi] = m.valueRange
    const step = rangeStep(lo, hi)
    // Default handles: lower = the item's actual roll (m.value), upper = hi
    // (open-ended upward) -> default search = "rolls >= my item". Fallback for
    // min is lo. collectSelected omits max while it's at the top, min while at the bottom.
    const startMin = (typeof m.value === 'number' && m.value >= lo && m.value <= hi) ? m.value : lo
    range = `<div class="range"><span class="mm">${esc(fmtK(lo))}</span>`
      + `<div class="dual" data-lo="${lo}" data-hi="${hi}" data-startmin="${startMin}">`
      +   `<div class="drail"><div class="dfill"></div></div>`
      +   `<input type="range" class="sl slmin" min="${lo}" max="${hi}" step="${step}" value="${startMin}" aria-label="Minimum">`
      +   `<input type="range" class="sl slmax" min="${lo}" max="${hi}" step="${step}" value="${hi}" aria-label="Maximum">`
      + `</div>`
      + `<span class="mm hi">${esc(fmtK(hi))}</span>`
      + `<span class="val"><span class="vmin">${esc(fmtK(startMin))}</span>`
      +   `<span class="vdash">–</span><span class="vmax">${esc(fmtK(hi))}</span></span></div>`
  }
  const tierAttr = typeof m.tier === 'number' ? ` data-tier="${m.tier}"` : ''
  return `<div class="mrow${on}" data-text="${esc(m.text)}" data-defsel="${m.selected ? 1 : 0}"${tierAttr}>${top}${range}</div>`
}

function cardHtml (item) {
  const r = item.rarity || 'normal'
  const nameClass = ['unique','rare','magic','currency','gem','normal','divination'].includes(r) ? 'n-' + r : ''
  const subParts = [item.baseType, cap(r), item.itemClass].filter(Boolean).map(esc)
  let sub = subParts.join(' · ')
  if (item.corrupted) sub += ' · <span class="corrupt">Corrupted</span>'
  // Every rarity renders as the same compact grid card (uniques used to get a
  // full-width `.wide` span). The poe.ninja price + sparkline lives in the
  // `.ninja` block below and is unaffected — uniques keep their trend line.
  return `<article class="card appearing tp-${esc(r)}" data-id="${esc(item.id)}">
      <button class="x" aria-label="Dismiss">✕</button>
      <div class="chead"><div class="name ${nameClass}">${esc(item.name)}<small>${sub}</small></div>${tradeBtnHtml(item)}</div>
      <div class="pblock">${priceHtml(item)}</div>
      <div class="ninja">${ninjaHtml(item)}</div>
      <div class="mods">${modsSummaryHtml(item)}</div>
      <div class="listings">${listingsHtml(item)}</div>
      <div class="modbar"><span class="tag">Match mods</span><span class="cnt">${(item.mods||[]).filter(m=>m.selected).length}</span><span class="chev">⌄</span></div>
      ${editorHtml(item)}
    </article>`
}

function elFor (id) { return grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`) }

// ---- Upsert / update -------------------------------------------------------
function upsertItem (data) {
  const existing = items.get(data.id)
  items.set(data.id, Object.assign(existing || {}, data))
  const item = items.get(data.id)
  const el = elFor(data.id)
  if (!el) {
    empty.style.display = 'none'
    // Newest card ON TOP (not at the bottom): when quickly checking many items,
    // the one just checked should be visible right away, without scrolling down.
    // On reconnect replay (server sends old->new) this also puts the newest
    // one on top. `empty` is the grid's first child, but hidden once there are cards.
    grid.insertAdjacentHTML('afterbegin', cardHtml(item))
    // Initialize dual ranges: adjust fill bar/z-index/labels to the default
    // handles (min = item roll, max = hi).
    const fresh = elFor(data.id)
    if (fresh) fresh.querySelectorAll('.dual').forEach(d => updateDual(d, null))
  } else {
    // preserve expanded state; refresh price block + status only to avoid clobbering
    // the user's in-progress mod edits.
    const wasExpanded = el.classList.contains('expanded')
    el.querySelector('.pblock').innerHTML = priceHtml(item)
    el.querySelector('.listings').innerHTML = listingsHtml(item)
    if (wasExpanded) el.classList.add('expanded')
    // Reset a spinning "Searching…" button on any status that ENDS this search
    // without a price result. 'done' resets in applyPriceResult (a price came
    // back); 'rate-limited'/'error' arrive here via upsertItem and would
    // otherwise leave the button stuck on "Searching…" forever (the ban-hang
    // the user saw). Idempotent when the button isn't busy.
    if (item.priceStatus === 'rate-limited' || item.priceStatus === 'error') {
      const btn = el.querySelector('.searchbtn')
      if (btn) { btn.classList.remove('busy'); btn.querySelector('.lbl').textContent = 'Search' }
      // 'error' is terminal (no retry) -> also drop it from the in-flight set.
      // 'rate-limited' keeps its slot: the server DID schedule a retry, so it is
      // genuinely still pending (just paused behind the ban gate).
      if (item.priceStatus === 'error') pending.delete(item.id)
    }
  }
  refreshCounts()
}

function applyPriceResult (msg) {
  const item = items.get(msg.id)
  if (!item) return
  item.price = msg
  item.priceStatus = 'done'
  pending.delete(msg.id)
  const el = elFor(msg.id)
  if (el) {
    el.querySelector('.pblock').innerHTML = priceHtml(item)
    const listings = el.querySelector('.listings')
    listings.innerHTML = listingsHtml(item)
    const hits = el.querySelector('.pblock .hits')
    if (hits && !reduce) { hits.classList.add('flash'); setTimeout(() => hits.classList.remove('flash'), 700) }
    const btn = el.querySelector('.searchbtn')
    if (btn) { btn.classList.remove('busy'); btn.querySelector('.lbl').textContent = 'Search' }
    // New tradeId on every price-result (initial AND requery via `search`) ->
    // re-render so the button always opens the search that produced what's
    // currently on the card, never a stale one from a previous run.
    const tradeBtn = el.querySelector('.opentrade')
    if (tradeBtn) tradeBtn.outerHTML = tradeBtnHtml(item)
  }
  refreshCounts()
}

function markSearching (id) {
  const item = items.get(id)
  if (!item) return
  item.priceStatus = 'searching'
  pending.add(id)
  const el = elFor(id)
  if (el) el.querySelector('.pblock').innerHTML = priceHtml(item)
}

// ---- Counts ----------------------------------------------------------------
function refreshCounts () {
  const n = grid.querySelectorAll('.card:not(.dismissing)').length
  badge.textContent = n + ' active'
  empty.style.display = n ? 'none' : 'block'
}

// ---- Rate-limit banner -----------------------------------------------------
// The rail's queue card (with its per-policy dots) is gone — the amber banner
// (M3) is now the ONLY rate-limit surface. Two inputs feed it:
//   * `rate-limit` (hard ban): queue paused until a timestamp, with countdown.
//   * `queue-status` (soft): a policy budget close to exhaustion (>=85% used)
//     shows a static warning so the state never becomes invisible.
// A hard ban always wins over the soft warning.
let rateUntil = 0    // epoch ms the shared queue is paused until (0 = not limited)
let rateMsg = ''     // hard-ban message from the server
let rateSoft = null  // soft near-limit warning text (null = headroom is fine)

function applyQueueStatus (msg) {
  const limits = (msg && msg.rateLimits) || []
  const worst = limits.reduce((m, rl) => Math.max(m, rl.limit ? rl.used / rl.limit : 0), 0)
  rateSoft = worst >= 0.85
    ? 'Trade API rate limit almost exhausted — searches may pause shortly.'
    : null
  renderRateBanner()
}

function fmtWait (ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `~${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `~${m}m`
  const h = Math.floor(m / 60), rem = m % 60
  return rem ? `~${h}h ${rem}m` : `~${h}h`
}

function renderRateBanner () {
  if (!ratebanner) return
  const left = rateUntil - Date.now()
  if (rateUntil && left > 0) {
    ratebanner.hidden = false
    if (rbmsg) rbmsg.textContent = rateMsg
    if (rbwait) rbwait.textContent = ` Retry in ${fmtWait(left)}.`
  } else if (rateSoft) {
    rateUntil = 0
    ratebanner.hidden = false
    if (rbmsg) rbmsg.textContent = rateSoft
    if (rbwait) rbwait.textContent = ''
  } else {
    rateUntil = 0
    ratebanner.hidden = true
  }
}

function applyRateLimit (msg) {
  if (msg && msg.active && typeof msg.until === 'number' && msg.until > Date.now()) {
    rateUntil = msg.until
    rateMsg = msg.message || "GGG's trade API rate-limited the app — searches are paused."
  } else {
    rateUntil = 0
  }
  renderRateBanner()
}

// Keep the countdown honest + auto-hide when the ban elapses (no server ping needed).
setInterval(() => { if (rateUntil) renderRateBanner() }, 1000)

// C:D tile + league selector are global shell slots — logic lives in shell.js
// (Shell.applyCdRatio / Shell.applyLeagueState / Shell.initLeague).

// ---- poe.ninja reference (F3) ----------------------------------------------
function applyNinjaRef (msg) {
  const item = items.get(msg.id)
  if (!item) return
  item.ninja = msg
  const el = elFor(msg.id)
  if (el) { const box = el.querySelector('.ninja'); if (box) box.innerHTML = ninjaHtml(item) }
}

// ---- Currency reference rail (reference) -----------------------------------
// Three sections (Currency / Lifeforce — Selling / Beasts). "Selling" is a promise:
// in that section the big number IS the sell side (chaos a seller collects per
// piece on the better market, server-side sellRow), not a market middle — and
// the sparkline is drawn from that same series. Same for Dead Man's Sulphur,
// which sits under Currency but is priced the same way. A row without
// trustworthy Faustus data prints "—" and draws nothing.
// Each row: name on the left, display
// value on the right, mini sparkline (same sparkSvg helper as the card's ninja
// ref, green/red depending on trend direction — `invert` comes from the server
// and flips it for the quantity-per-chaos lifeforce rows). The series is the
// server's OWN history in the row's display unit, so a row with less than two
// recorded points simply has no line yet. Empty section -> omitted.
// Sell-side hint badge (server field `sell`, optional): which currency pays a
// SELLER more right now — chaos or divine — and by how much. `better` +
// `edgePct` = a claimed comparison (both markets carry real volume); `only` =
// just one side is backed by enough trades, so the badge names it WITHOUT a
// percentage (a number from a thin market would be a lie, see sell-side.mjs).
// Details (both rates, C:D, data age) live in the badge's tooltip.
function sellBadge (s) {
  if (!s || (!s.better && !s.only)) return ''
  const fmtC = v => (typeof v === 'number' && isFinite(v)) ? `${v >= 100 ? Math.round(v) : v.toPrecision(3)} c/ea` : '?'
  const at = s.updatedAt ? new Date(s.updatedAt) : null
  const stamp = at ? ` · Faustus ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : ''
  const rates = `sell vs chaos ${fmtC(s.viaChaos)} · sell vs divine ${fmtC(s.viaDivine)} (C:D ${s.cd})`
  if (s.better) {
    const pct = Math.round(s.edgePct)
    if (pct < 1) { // both sides pay the same within rounding — say so, claim no winner
      return `<span class="sellhint e" title="${esc(`Selling pays about the same vs chaos and vs divine: ${rates}${stamp}`)}">c ≈ div</span>`
    }
    const cls = s.better === 'chaos' ? 'c' : 'd'
    const label = s.better === 'chaos' ? 'c' : 'div'
    return `<span class="sellhint ${cls}" title="${esc(`Selling vs ${s.better} pays ~${pct}% more: ${rates}${stamp}`)}">${label} +${pct}%</span>`
  }
  const cls = s.only === 'chaos' ? 'c' : 'd'
  const label = s.only === 'chaos' ? 'c' : 'div'
  const other = s.only === 'chaos' ? 'divine' : 'chaos'
  return `<span class="sellhint ${cls}" title="${esc(`Only the ${s.only} market has enough trades to price a sale (${rates}) — the ${other} side is too thin or missing, so no comparison is claimed${stamp}`)}">${label}</span>`
}

// ---- Where a rail row's number comes from ----------------------------------
// Two feeds on two clocks: poe.ninja (the reference fetch, >=15 min, stamped
// once per message in `refreshedAt`) and the Faustus sell side (the store's own
// hourly refresh, stamped per row in `sell.updatedAt`). They are MIXED inside a
// section — Mirror is poe.ninja, the Sulphur row right below it is Faustus — so
// a single footer stamp would be a wrong claim for half the rail.
// The column is 270 px and the row NAMES already ellipsize, so the marker must
// cost zero horizontal space: the Faustus numbers carry a dotted underline, the
// poe.ninja ones stay plain, and every number spells its source out in its
// `title`. The footer resolves that with ONE line and ONE timestamp PER SOURCE,
// each source name set in the very style its rows' numbers use — the legend is
// its own key. A row whose server-side `src` is absent (it prints "—") is
// styled by neither and no footer line speaks for it.
const SRC_LABEL = { ninja: 'poe.ninja', faustus: 'Faustus' }

function hhmm (ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Per-source timestamps, read off the rows themselves — a source only appears
// once a row actually uses it. Faustus rows all read the same store, so the
// newest stamp among them IS the store's; a Faustus row without a stamp still
// registers the source (with an unknown time) so the marker stays explained.
function refSources (msg) {
  const rows = [].concat(msg.currency || [], msg.lifeforce || [], msg.beasts || [])
  const out = new Map() // src -> timestamp | null
  for (const r of rows) {
    if (!SRC_LABEL[r.src]) continue
    const ts = r.src === 'ninja' ? msg.refreshedAt : (r.sell && r.sell.updatedAt)
    const prev = out.get(r.src)
    out.set(r.src, (ts && (!prev || ts > prev)) ? ts : (prev || null))
  }
  return out
}

const NO_SRC_HINT = 'No value, so no source: no trustworthy sell-side data for this row'

// The number's own attribution: style class (the marker) + the sentence that
// names the source in plain words. A row without `src` gets no class and says
// why it names none.
function srcMark (r, sources) {
  if (!SRC_LABEL[r.src]) return { cls: '', title: NO_SRC_HINT }
  const ts = sources.get(r.src)
  const when = ts ? ` · updated ${hhmm(ts)}` : ' · update time unknown'
  return { cls: ` src-${r.src}`, title: `Value from ${SRC_LABEL[r.src]}${when}` }
}

function refSection (title, rows, sources) {
  if (!Array.isArray(rows) || !rows.length) return ''
  const body = rows.map(r => {
    const m = srcMark(r, sources)
    // The name column ellipsizes at the rail's ~218px content width ("Dead
    // Man's Sulphur" shows as "Dead …"), so it carries its full name as a
    // tooltip — a truncated row must stay identifiable without guessing.
    return `<div class="rrow"><span class="n" title="${esc(r.name)}">${esc(r.name)}</span>`
      + `<span class="rv">${sellBadge(r.sell)}`
      + `<span class="p${m.cls}" title="${esc(m.title)}">${esc(r.display)}</span>`
      + `${sparkSvg(r.sparkline, !!r.invert)}</span></div>`
  }).join('')
  return `<div class="rsec"><div class="rh">${esc(title)}</div>${body}</div>`
}

// Footer: one line per source that at least one row actually uses, each with
// its own time. Never a shared stamp, never a source no row is fed by. Fixed
// order (poe.ninja first) so the block does not jump around between refreshes.
function refFooter (sources) {
  const lines = ['ninja', 'faustus'].filter(s => sources.has(s)).map(s => {
    const ts = sources.get(s)
    // Shorter than the number's tooltip on purpose: the footer line must stay
    // under the rail's ~218 px content width (see .rstamp in styles.css).
    const when = ts ? `updated ${hhmm(ts)}` : 'time unknown'
    // The source NAME is set in the same style its rows' numbers are — that is
    // what ties the two together, so the legend needs no extra symbol column.
    return `<div class="rsrc"><span class="src-${s}">${esc(SRC_LABEL[s])}</span> · ${esc(when)}</div>`
  })
  return lines.length ? `<div class="rstamp">${lines.join('')}</div>` : ''
}

function applyReference (msg) {
  if (!ref) return
  const sources = refSources(msg)
  const html = refSection('Currency', msg.currency, sources)
    + refSection('Lifeforce — Selling', msg.lifeforce, sources)
    + refSection('Beasts', msg.beasts, sources)
  ref.innerHTML = (html || '<div class="rsec"><div class="rh">Reference</div>'
    + '<div class="rrow"><span class="n">no data</span></div></div>')
    + refFooter(sources)
}

// ---- League dropdown (F2) --------------------------------------------------
// Global shell slot — Shell.initLeague wires the selector to this page's WS.
Shell.initLeague(obj => sendSafe(obj))

// ---- Dismiss ---------------------------------------------------------------
function dismissCard (el) {
  const id = el.dataset.id
  items.delete(id)
  pending.delete(id)
  sendSafe({ type: 'dismiss', id })
  if (reduce) { el.remove(); refreshCounts(); return }
  el.classList.add('dismissing')
  refreshCounts()
  el.addEventListener('transitionend', () => { el.remove(); refreshCounts() }, { once: true })
}

// Server-initiated removal (item-removed): the backend evicted this card because
// its room hit the item cap. Drop it locally WITHOUT echoing a `dismiss` (the
// server already forgot it). Same fade-out as a user dismiss.
function removeItemById (id) {
  items.delete(id)
  pending.delete(id)
  const el = elFor(id)
  if (!el) { refreshCounts(); return }
  if (reduce) { el.remove(); refreshCounts(); return }
  el.classList.add('dismissing')
  refreshCounts()
  el.addEventListener('transitionend', () => { el.remove(); refreshCounts() }, { once: true })
}

// "T2+" means tier 1 OR 2 — the smaller the number, the better the roll.
const TOP_TIER = 2

// ---- Mod editor interactions (event delegation) ----------------------------
function syncCard (card) {
  let on = 0
  card.querySelectorAll('.mrow').forEach(row => {
    const c = row.querySelector('.chk')
    if (c && c.checked) { on++; row.classList.add('on') } else row.classList.remove('on')
  })
  const cnt = card.querySelector('.modbar .cnt'); if (cnt) cnt.textContent = on
  const sel = card.querySelector('.ed-foot .sel'); if (sel) sel.textContent = on
  const noun = card.querySelector('.ed-foot .flow .sel + span')
  if (noun) noun.textContent = on === 1 ? 'mod' : 'mods'
}

// Reset: revert a card's roll ranges + checkboxes to the item defaults
// (lower handle = item roll, upper = range max, ticks = default).
// ONLY resets the values; it does NOT trigger a search.
function resetCard (card) {
  card.querySelectorAll('.mrow').forEach(row => {
    const chk = row.querySelector('.chk')
    if (chk) chk.checked = row.dataset.defsel === '1'
    const dual = row.querySelector('.dual')
    if (dual) {
      dual.querySelector('.slmin').value = dual.dataset.startmin
      dual.querySelector('.slmax').value = dual.dataset.hi
      updateDual(dual, null)
    }
  })
  syncCard(card)
}

function collectSelected (card) {
  const out = []
  card.querySelectorAll('.mrow').forEach(row => {
    const c = row.querySelector('.chk')
    if (!c || !c.checked) return
    const entry = { text: row.dataset.text }
    const dual = row.querySelector('.dual')
    if (dual) {
      const lo = Number(dual.dataset.lo), hi = Number(dual.dataset.hi)
      const vmin = Number(dual.querySelector('.slmin').value)
      const vmax = Number(dual.querySelector('.slmax').value)
      if (vmin > lo) entry.min = vmin   // lower handle at the stop -> omit min
      if (vmax < hi) entry.max = vmax   // upper handle at the stop -> omit max (open-ended upward)
    }
    out.push(entry)
  })
  return out
}

grid.addEventListener('click', e => {
  const kill = e.target.closest('.x')
  if (kill) { dismissCard(kill.closest('.card')); return }
  const trade = e.target.closest('.opentrade')
  if (trade) {
    if (trade.disabled) return
    if (trade.dataset.ninjaUrl) {
      window.open(trade.dataset.ninjaUrl, '_blank', 'noopener')
      return
    }
    const { tradeId, tradeKind, tradeLeague } = trade.dataset
    if (tradeId && tradeLeague) {
      window.open('https://www.pathofexile.com/trade/' + tradeKind + '/' + encodeURIComponent(tradeLeague) + '/' + tradeId, '_blank', 'noopener')
    }
    return
  }
  const more = e.target.closest('.lmore')
  if (more) { more.closest('.lwrap').classList.toggle('showall'); return }
  const reset = e.target.closest('.resetbtn')
  if (reset) { resetCard(reset.closest('.card')); return }
  // "All mods": tick everything — if everything is already on, untick it all.
  // Only searchable mods have a checkbox (unsearch rows stay out of it).
  // Deliberately triggers NO search, like everything else in this editor.
  // "T2+": set the selection to exactly the top-tier mods (not add to it) — so
  // clicking twice gives the same result, no toggling back and forth.
  const tt = e.target.closest('.toptier')
  if (tt) {
    const card = tt.closest('.card')
    card.querySelectorAll('.mrow').forEach(row => {
      const chk = row.querySelector('.chk')
      if (!chk) return
      const tier = Number(row.dataset.tier)
      chk.checked = Number.isFinite(tier) && tier > 0 && tier <= TOP_TIER
    })
    syncCard(card)
    return
  }
  const allm = e.target.closest('.allmods')
  if (allm) {
    const card = allm.closest('.card')
    const boxes = [...card.querySelectorAll('.mrow .chk')]
    const turnOn = boxes.some(b => !b.checked)
    boxes.forEach(b => { b.checked = turnOn })
    syncCard(card)
    return
  }
  const ctb = e.target.closest('.ctog button')
  if (ctb) {
    const tog = ctb.closest('.ctog')
    tog.dataset.val = ctb.dataset.c
    tog.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === ctb))
    return
  }
  const btn = e.target.closest('.searchbtn')
  if (btn) {
    const card = btn.closest('.card')
    if (btn.classList.contains('busy')) return
    // Don't start a new search while the shared queue is banned: each click would
    // just stack another job behind the ban gate and (once it lifts) fire as a
    // real request — exactly the pile-up that risks a fresh ban. The amber banner
    // already explains the pause; leave the button as-is so the click is a no-op.
    if (rateUntil > Date.now()) return
    btn.classList.add('busy'); btn.querySelector('.lbl').textContent = 'Searching…'
    const id = card.dataset.id
    markSearching(id)
    const tog = card.querySelector('.ctog')
    const corrupted = tog ? tog.dataset.val : 'any'
    sendSafe({ type: 'search', id, selectedMods: collectSelected(card), corrupted })
    return
  }
  const bar = e.target.closest('.modbar')
  if (bar) bar.closest('.card').classList.toggle('expanded')
})

// Dual range: read both handles, prevent crossing, mirror fill bar + values.
function updateDual (dual, changed) {
  const lo = Number(dual.dataset.lo), hi = Number(dual.dataset.hi)
  const smin = dual.querySelector('.slmin'), smax = dual.querySelector('.slmax')
  let vmin = Number(smin.value), vmax = Number(smax.value)
  if (vmin > vmax) {                     // handles crossed -> snap the one that moved
    if (changed === smax) { vmin = vmax; smin.value = vmin }
    else { vmax = vmin; smax.value = vmax }
  }
  const span = hi - lo || 1
  const fill = dual.querySelector('.dfill')
  if (fill) {
    fill.style.left  = ((vmin - lo) / span * 100) + '%'
    fill.style.right = ((hi - vmax) / span * 100) + '%'
  }
  // bring the graspable handle to the front when both sit on the right half
  smin.style.zIndex = vmin > (lo + hi) / 2 ? 5 : 3
  const row = dual.closest('.mrow')
  const vminEl = row.querySelector('.vmin'); if (vminEl) vminEl.textContent = fmtK(vmin)
  const vmaxEl = row.querySelector('.vmax'); if (vmaxEl) vmaxEl.textContent = fmtK(vmax)
  const live = row.querySelector('.live'); if (live) live.textContent = vmin
}

grid.addEventListener('input', e => {
  if (e.target.classList.contains('sl')) {
    const dual = e.target.closest('.dual')
    if (dual) updateDual(dual, e.target)
  }
})

grid.addEventListener('change', e => {
  if (e.target.classList.contains('chk')) syncCard(e.target.closest('.card'))
})

document.getElementById('clear').addEventListener('click', () => {
  grid.querySelectorAll('.card:not(.dismissing)').forEach(dismissCard)
})

// ---- Identity (multi-user routing, no login) --------------------------------
// The `ppt_user` cookie determines which room the WS connection lands in. It's
// sent automatically with the WS handshake (same-origin; the server reads it
// from req.headers.cookie). Missing/invalid -> show identity gate, connect only
// AFTER an identity is set. Switching = set a new cookie + reconnect.
const idgate     = document.getElementById('idgate')
const idbtns     = document.getElementById('idbtns')
const whoami     = document.getElementById('whoami')
const whoamiName = document.getElementById('whoamiName')

// Fixed two-user assumption as a fallback; /users provides the real list.
let USERS = ['player1', 'player2']
let currentUser = null

function readCookie (name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : null
}
function setUserCookie (u) {
  document.cookie = 'ppt_user=' + encodeURIComponent(u) + '; path=/; max-age=31536000; samesite=lax'
}
function clearUserCookie () {
  document.cookie = 'ppt_user=; path=/; max-age=0; samesite=lax'
}

function showWhoami (u) {
  if (!whoami) return
  whoamiName.textContent = u
  whoami.hidden = false
}

// Overlay with one button per user. Selection -> cookie + connect.
function showIdGate () {
  if (!idgate) return
  idbtns.innerHTML = USERS.map(u =>
    `<button type="button" data-user="${esc(u)}">${esc(cap(u))}</button>`).join('')
  idgate.hidden = false
}
function hideIdGate () { if (idgate) idgate.hidden = true }

function pickUser (u) {
  if (!USERS.includes(u)) return
  currentUser = u
  setUserCookie(u)
  hideIdGate()
  showWhoami(u)
  // close the running connection -> reconnect uses the new cookie/room.
  if (ws) { try { ws.close() } catch {} ws = null }
  // discard the old room's cards (they'll arrive fresh for the new room).
  grid.querySelectorAll('.card').forEach(el => el.remove())
  items.clear(); pending.clear()
  refreshCounts()
  connect()
}

if (idbtns) idbtns.addEventListener('click', e => {
  const b = e.target.closest('button[data-user]')
  if (b) pickUser(b.dataset.user)
})
// Switching: clear cookie + show gate (selecting reconnects).
if (whoami) whoami.addEventListener('click', () => { clearUserCookie(); currentUser = null; showIdGate() })

// Fetch the user list from the server, then determine identity and connect if
// applicable. Branding (rail logo + title) is a shell concern -> Shell.applyBrand.
async function initIdentity () {
  try {
    const r = await fetch('/users')
    const j = await r.json()
    if (Array.isArray(j.users) && j.users.length) USERS = j.users
    if (j.appName) Shell.applyBrand(j.appName)
  } catch { /* keep fallback list + fallback brand */ }
  const cookie = readCookie('ppt_user')
  if (cookie && USERS.includes(cookie)) {
    currentUser = cookie
    showWhoami(cookie)
    connect()
  } else {
    showIdGate()
  }
}

// ---- WebSocket -------------------------------------------------------------
let ws = null
let retry = 0

function sendSafe (obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

function setConn (state, label) {
  conn.className = 'conn ' + state
  connlbl.textContent = label
}

function connect () {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${proto}//${location.host}/events`)

  ws.addEventListener('open', () => { retry = 0; setConn('live', 'live') })
  ws.addEventListener('close', () => {
    setConn('down', 'reconnecting…')
    retry = Math.min(retry + 1, 6)
    setTimeout(connect, 400 * retry)
  })
  ws.addEventListener('error', () => { try { ws.close() } catch {} })

  ws.addEventListener('message', ev => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    switch (msg.type) {
      case 'item-added':   upsertItem(msg); break
      case 'item-removed': removeItemById(msg.id); break
      case 'price-result': applyPriceResult(msg); break
      case 'queue-status': applyQueueStatus(msg); break
      case 'rate-limit':   applyRateLimit(msg); break
      case 'cd-ratio':     Shell.applyCdRatio(msg); break
      case 'ninja-ref':    applyNinjaRef(msg); break
      case 'reference':    applyReference(msg); break
      case 'league-state': Shell.applyLeagueState(msg); break
      case 'data-status':  Shell.applyDataStatus(msg); break  // M2 data freshness
      case 'need-identity': // cookie didn't arrive -> show gate (server-side rejected)
        if (Array.isArray(msg.users) && msg.users.length) USERS = msg.users
        if (whoami) whoami.hidden = true
        showIdGate()
        break
      default: /* ignore unknown */ break
    }
  })
}

initIdentity()
