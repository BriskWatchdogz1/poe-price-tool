// backend/v2/networth/valuator.mjs
// Thin wrapper: descriptor -> chaos value. EXCLUSIVELY via the existing,
// cached fetchers (ninja.mjs) — so a scan only
// triggers a handful of poe.ninja requests (one per league|type, cached
// >=15min), no matter how many items are in the stash.
// null = honest "not priceable" (name unknown, ninja down, no theme
// match) -> lands in the unpriced bucket, NEVER as 0 in the sum.
import {
  fetchItemOverview as realFetchItemOverview,
  fetchExchangeOverview as realFetchExchangeOverview,
  fetchCurrencyOverview as realFetchCurrencyOverview,
  round1
} from '../ninja.mjs'
import { VALUATION_ROUTES } from './kinds.mjs'
import { isTooOld, maxAgeMs as defaultMaxAgeMs } from './faustus-age.mjs'

// All exchange overview types that carry a stackable's price on poe.ninja
// (item/overview 404s for most of these today). Merged ONCE per valuator into
// a single tradeTag/name -> chaos map, so a stackable lookup is O(1) after ~14
// cached requests instead of a per-item fallback storm.
const EXCHANGE_STACKABLE_TYPES = [
  'Currency', 'Fragment', 'Scarab', 'Essence', 'Fossil', 'Resonator', 'Oil',
  'DeliriumOrb', 'Astrolabe', 'Omen', 'Tattoo', 'Runegraft', 'AllflameEmber', 'Artifact'
]

// Confidence floor. poe.ninja's per-line `count` is the sample size behind the
// price — the same signal its site uses to grey out (and hide by default) its
// "low confidence" rows. Standard is full of thin, manipulated phantom prices
// that "# Listed" / `listingCount` does NOT catch: e.g. a level-20/0q "Bear
// Trap" at 369k chaos with listingCount 21 but count 3, or "Soulwrest" (really
// ~5c) at 1.8M chaos with count 1. Requiring a minimum sample keeps such a line
// from winning a pick; a thinly-traded item drops to honestly-unpriced instead
// of a fake price. item/overview lines always carry `count`; exchange lines have
// no `count` and are gated by MIN_EXCHANGE_UNITS below instead.
const MIN_CONFIDENCE = 5
const confident = l => typeof l.count === 'number' && l.count >= MIN_CONFIDENCE

// Volume floor for the poe.ninja EXCHANGE lines (the confidence gate above only
// covers item/overview, which is a different shape). Every exchange line carries
// `volumePrimaryValue` — that line's traded volume expressed in chaos — so
// `volumePrimaryValue / primaryValue` is the number of ITEMS behind the price
// (poe.ninja reports the volume averaged over its 6-slot window, i.e. a ratio
// of 1/6 == 0.1667 is EXACTLY ONE traded item), and `volumePrimaryValue`
// itself is the same evidence expressed as chaos turnover instead of item
// count. Why a floor at all: a line backed by a handful of trades is one or
// two observations, not a market, and it survives into our valuation even
// after the Faustus path (GGG digest) correctly rejects it — both sources
// scrape the same thin trades.
//
// THE REGRESSION this comment used to argue for and no longer does: this
// floor was raised from 0.5 to 10 units on the strength of the calibration
// below (all cases, cheap and expensive, distributed on both sides of 10 —
// "no reason for a value-dependent floor"). That was wrong. A flat item-count
// floor is itself value-dependent in effect, because ITEM COUNT and PRICE are
// inversely related for a fixed amount of chaos changing hands: an expensive
// card clears fewer units for the exact same turnover a cheap card clears in
// bulk. Live Allflame case that broke it (measured 2026-08-05): "Father's
// Love" at 8608c off volumePrimaryValue 41607 -> 4.83 units — comfortably
// under the 10-unit floor despite 41607 CHAOS of turnover, more than every
// Fragment/Scarab/Fossil/Oil line this same floor was calibrated to trust.
// The floor doesn't measure "is this a real market" here, it measures "is
// this item cheap enough to move ten of in the window" — exactly the
// instrument backend/v2/networth/faustus.mjs's comment above QUOTE_VOL_MIN
// warns against: "An expensive X legitimately trades 1-3/hour while the chaos side
// is huge, so a two-sided floor would unprice exactly the high-value items."
// This constant was that two-sided floor, single-sided.
//
// THE FIX: accept a line when it clears EITHER the unit floor below OR a
// turnover floor in chaos (MIN_EXCHANGE_TURNOVER_C) — but this is NOT
// backend/v2/sell-side.mjs's SELL_MIN_UNITS/SELL_MIN_QUOTE_TURNOVER_C AND
// copied in as an OR. That pair guards two INDEPENDENT market legs (X-side
// item count and quote-side turnover come from separate GGG digest markets,
// which is exactly how Rogue's Marker fooled a unit-only floor there:
// 715000 units traded, but only 1918c of quote turnover behind them — a unit
// floor cleared by a near-worthless side with nothing backing it). A poe.ninja
// exchange line has no such second leg: `volumePrimaryValue` and
// `volumePrimaryValue / primaryValue` are the SAME observation read two ways
// (turnover = units x price by construction), so a Rogue's-Marker-shaped
// failure — huge units, thin turnover — cannot occur on the turnover side of
// this particular OR: turnover here can only be large when either units or
// price is large, and it was checked (see below) that every line the turnover
// floor rescues has non-trivial units too, none anywhere near the "single
// extreme trade" shape.
//
// Calibration against live Allflame data (2026-08-05, all 10 exchange types
// fetched fresh via curl — DivinationCard, Currency, Fragment, Scarab,
// Fossil, Oil, Essence, Tattoo, Runegraft, Omen — 916 priced lines total).
// For the population that fails the 10-unit floor, turnover (in chaos) does
// NOT show one clean gap the way the old flat-count calibration implied one
// existed: sorted turnover climbs close to continuously from a few hundred
// chaos into the tens of thousands. What DOES separate cleanly is confirmed
// bad vs. the rescue target: "The Trial", the case that originally motivated
// this floor, topped out at 1359c off 906 turnover (0.67 units) — genuinely
// under one traded card, and it must stay rejected. The closest line the
// turnover floor is meant to rescue ("Journey Tattoo of the Mind", 1085c off
// 2169 turnover, 2.00 units) sits at 2.4x that. MIN_EXCHANGE_TURNOVER_C =
// 2000 sits in between: a safety margin over the one CONFIRMED-bad turnover
// value in this dataset (906c), same margin-over-worst-known-bad logic
// sell-side.mjs used for its own 5000 (never the number itself — that number
// comes from a different market/currency pair shape and does not transfer).
//   - DivinationCard: 391 lines, 157 fail the unit floor -> 150 still fail
//     with the turnover floor added (7 rescued): Father's Love 8608c/41607
//     turnover, The Miracle 3020c/11074, Lucky Bastion 1918c/15348, Pearls
//     Before Swine 3691c/5537, Choking Guilt 1199c/4598, Brother's Gift
//     957c/4306, Outfoxed 917.8c/4283 — every one of these was a named
//     casualty of the old flat floor above. Most expensive line STILL
//     rejected: The Sacrifice, 200c off 33.3 turnover (0.167 units) — a
//     single trade's fraction, same shape as The Trial.
//   - Tattoo: 3 of 53 fail the unit floor -> 2 still fail (1 rescued: Journey
//     Tattoo of the Mind, above). Most expensive still-rejected line: Journey
//     Tattoo of the Body, 740.3c off 1481 turnover (2.00 units) — turnover
//     falls short of 2000, correctly stays out.
//   - Runegraft: 1 of 31 fails the unit floor (Runegraft of the Angler,
//     2574c/5148 turnover, 2.00 units) -> 0 still fail; fully rescued.
//   - Essence: 23 of 99 fail the unit floor, all still fail (turnover floor
//     changes nothing) — capped at 20c (Whispering Essence of Contempt), a
//     thin essence line is cheap, never a stash-sized bet.
//   - Currency: 2 of 102 fail, unchanged — both trivial shard prices
//     (Transmutation Shard 0.5c and similar).
//   - Omen: 3 of 12 fail, unchanged — all under 2c, trivial.
//   - Fragment, Scarab, Fossil, Oil: ZERO lines fail the unit floor in either
//     version — untouched, as before.
const MIN_EXCHANGE_UNITS = 10

// Chaos turnover floor — the rescue for a line that fails MIN_EXCHANGE_UNITS
// but moves real chaos anyway (see the calibration above). Units alone cannot
// tell "few trades because nobody wants it" apart from "few trades because
// each one is expensive"; total chaos moved can, which is exactly what this
// reads.
const MIN_EXCHANGE_TURNOVER_C = 2000

// The turnover floor alone is SELF-VALIDATING and must never stand on its own:
// turnover is units x price, and price is the very number under test, so an
// inflated price manufactures the turnover that vouches for it. Concretely, The
// Trial at 1359c off 0.67 units yields 906 turnover and is correctly rejected —
// but the SAME 0.67 units at a (more) inflated 3000c would yield 2010 and pass.
// The more wrong the price, the likelier it clears the bar.
//
// This is the identical disease the cross-hour check in faustus.mjs was built
// for, where QUOTE_VOL_MIN is denominated in the quote currency for the same
// structural reason. The cure here is cheap: turnover may only vouch for a line
// that represents at least one COMPLETED trade. No line currently rescued by
// the turnover floor is affected — the thinnest is Pearls Before Swine at 1.5
// units — so this costs nothing today and closes the hole for good.
const MIN_EXCHANGE_TURNOVER_UNITS = 1

// Chaos value of a poe.ninja exchange line, or null when it must not be trusted.
// Rejects a non-positive price (would enter the sum as a fake 0) and any line
// clearing NEITHER the unit floor NOR the turnover floor. No usable volume
// field -> fail OPEN: the floors exist to drop lines we can PROVE are thin, so
// if poe.ninja ever stops shipping the field we keep pricing instead of
// blanking every stackable. Never returns 0.
function exchangeLineValue (line) {
  const v = line && typeof line.primaryValue === 'number' ? line.primaryValue : null
  if (v == null || !(v > 0)) return null
  const vol = line.volumePrimaryValue
  if (typeof vol !== 'number' || !Number.isFinite(vol) || vol < 0) return v
  const units = vol / v
  if (units >= MIN_EXCHANGE_UNITS) return v
  return (vol >= MIN_EXCHANGE_TURNOVER_C && units >= MIN_EXCHANGE_TURNOVER_UNITS) ? v : null
}

// Max staleness for the Faustus store before its prices are treated as absent
// (F1). The store replaces its whole name->chaos map atomically with ONE shared
// updatedAt, so freshness is a store-wide gate (unlike the corpse store's
// per-entry TTL). Generous default (48h): Faustus refreshes hourly and unions
// several completed hours, but the CDN feed is undocumented and can go quiet —
// this bounds how long a silently-frozen map keeps serving before valuation
// falls through to poe.ninja instead. Overridable via POE_FAUSTUS_TTL_MS
// (server wires deps.faustusTtlMs). Without a store isFresh() the gate is a
// no-op (test stubs, defensive).
const DEFAULT_FAUSTUS_TTL_MS = 48 * 60 * 60 * 1000

// ─── Unique VARIANTS ────────────────────────────────────────────────────────
// poe.ninja lists a unique NAME once per `variant`, and the variants of one name
// are not remotely the same market. Measured case (Allflame, live):
//   Foulborn Soul Tether "Instant Leech"                        886.5c, count 125
//   Foulborn Soul Tether "Instant Leech, Everlasting Sacrifice" 709.2c, count  19
//   Foulborn Soul Tether "Everlasting Sacrifice"                  2.0c, count  92
// The user's belt is the last one (trade confirms: 67 offers, all 2c) — the old
// "most liquid line wins" tiebreak took the 886.5c line, a factor of 443.
//
// The `variant` STRING itself is not parsed: over the six unique overviews its
// 399 distinct values are free-form and inconsistent — plain mod nicknames
// ("Instant Leech", "Culling Strike"), element names ("Lightning"), defence
// combos ("Armour/Evasion/ES"), counted phrases ("3 passives", "2 Jewels") and
// comma-joined pairs ("Instant Leech, Everlasting Sacrifice"). None of that maps
// onto anything a stash item carries.
//
// What DOES map is the mod text: every overview line ships implicitModifiers /
// explicitModifiers / mutatedModifiers with the variant's actual mods, roll
// ranges included ("Gain (4-6)% of Maximum Life as Extra Maximum Energy Shield"),
// and the stash item ships its rolled mods ("Gain 5% of ..."). So a variant is
// picked by comparing mods, which needs no per-item knowledge at all.
//
// Measured over every multi-candidate pool in the live league (333 cases across
// all six unique types), matching each line's own mods back against the pool:
// 329 resolved to exactly the right line, 0 wrong, 4 ambiguous — all four being
// `Voices`, whose lines carry no mod text on poe.ninja at all and therefore
// cannot be told apart from item data.
const MOD_RANGE = /\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g
const MOD_NUM = /-?\d+(?:\.\d+)?/g
const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g
const normMod = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
// Roll-insensitive fingerprint: every number and every "(min-max)" range becomes
// "#", so a line's stated range and an item's concrete roll collapse to the same
// string. This is what "the item has this mod" means below.
const modShape = s => normMod(s).replace(MOD_RANGE, '#').replace(MOD_NUM, '#')

// All mod texts a poe.ninja overview line states for its variant. `optional`
// mods (poe.ninja's own flag for "may or may not be present") never count as
// missing — they are exactly the mods an item is allowed not to have.
function lineMods (line) {
  const out = []
  for (const key of ['implicitModifiers', 'explicitModifiers', 'mutatedModifiers']) {
    const arr = Array.isArray(line?.[key]) ? line[key] : []
    for (const m of arr) {
      if (m && typeof m.text === 'string') out.push({ text: m.text, optional: m.optional === true })
    }
  }
  return out
}

// Stricter than the shape match: the item's rolls must sit inside the ranges the
// line states. Used only to RANK equally-shaped candidates, never to reject one —
// legacy rolls, catalysts and corrupted uniques legitimately fall outside.
function rollFits (lineText, itemText) {
  const lt = normMod(lineText)
  const bounds = []
  let pattern = ''
  let last = 0
  let m
  MOD_RANGE.lastIndex = 0
  while ((m = MOD_RANGE.exec(lt))) {
    pattern += lt.slice(last, m.index).replace(RE_ESCAPE, '\\$&') + '(-?\\d+(?:\\.\\d+)?)'
    bounds.push([Math.min(Number(m[1]), Number(m[2])), Math.max(Number(m[1]), Number(m[2]))])
    last = m.index + m[0].length
  }
  pattern += lt.slice(last).replace(RE_ESCAPE, '\\$&')
  let hit
  try {
    hit = new RegExp('^' + pattern + '$').exec(normMod(itemText))
  } catch { return false }
  if (!hit) return false
  return bounds.every(([lo, hi], i) => {
    const v = Number(hit[i + 1])
    return Number.isFinite(v) && v >= lo && v <= hi
  })
}

// How well one overview line describes this item.
//  missing = mandatory mods of the line the item does NOT have  (decisive)
//  fits    = mods whose roll additionally lands inside the stated range
//  extra   = item mods the line does not mention (enchants, corrupted implicits)
function scoreLine (line, itemMods) {
  const lm = lineMods(line)
  const itemShapes = itemMods.map(modShape)
  const lineShapes = lm.map(m => modShape(m.text))
  let missing = 0
  let fits = 0
  for (const m of lm) {
    if (!itemShapes.includes(modShape(m.text))) {
      if (!m.optional) missing++
      continue
    }
    if (itemMods.some(t => rollFits(m.text, t))) fits++
  }
  let extra = 0
  for (const s of itemShapes) if (!lineShapes.includes(s)) extra++
  return { missing, fits, extra }
}

// The one line that fits this item's mods best, or null when the data cannot
// decide. "Cannot decide" is two things: the item has no mod text at all (then
// every line would score `missing = its own mod count` and the line with the
// FEWEST mods would win for no reason), or two lines tie on the full score.
export function pickVariant (pool, itemMods) {
  if (!Array.isArray(itemMods) || !itemMods.length) return null
  const scored = pool.map(line => ({ line, s: scoreLine(line, itemMods) }))
  scored.sort((a, b) => a.s.missing - b.s.missing || b.s.fits - a.s.fits || a.s.extra - b.s.extra)
  const top = scored[0].s
  const tied = scored.filter(x => x.s.missing === top.missing && x.s.fits === top.fits && x.s.extra === top.extra)
  return tied.length === 1 ? scored[0].line : null
}

export function createValuator ({ league, deps = {} }) {
  const d = {
    fetchItemOverview: realFetchItemOverview,
    fetchExchangeOverview: realFetchExchangeOverview,
    fetchCurrencyOverview: realFetchCurrencyOverview,
    ...deps
  }

  // Faustus store (Task 3): the PRIMARY source for every fungible. Single-league
  // store, so a valuator built for a DIFFERENT league than the store holds must
  // NOT read stale cross-league prices -> guard on league, fall through to
  // poe.ninja instead. Absent store (disabled/local run) -> null, same effect.
  const faustusStore = d.faustusStore || null
  const faustusTtlMs = (typeof d.faustusTtlMs === 'number' && d.faustusTtlMs > 0)
    ? d.faustusTtlMs : DEFAULT_FAUSTUS_TTL_MS
  // How old the OBSERVATION behind one price may be. Distinct from the TTL
  // above and not a duplicate of it: the TTL asks "is the whole map still being
  // refreshed", this asks "is THIS number still describing the market". A
  // refresher that ticked five minutes ago can hand out an eight-hour-old
  // observation for a quiet market — see networth/faustus-age.mjs for the two
  // live cards that made the difference visible.
  const faustusMaxAgeMs = (typeof d.faustusMaxAgeMs === 'number' && d.faustusMaxAgeMs > 0)
    ? d.faustusMaxAgeMs : defaultMaxAgeMs()
  const nowMs = typeof d.now === 'function' ? d.now : Date.now
  async function fromFaustus (name) {
    if (!faustusStore) return null
    if (typeof faustusStore.league === 'function' && faustusStore.league() !== league) return null
    // F1: staleness gate. If the whole map is older than the TTL (CDN feed
    // silently broke), treat Faustus as absent -> null -> the ninja fallback in
    // the fungible chain takes over, instead of serving frozen prices forever.
    if (typeof faustusStore.isFresh === 'function' && !faustusStore.isFresh(faustusTtlMs)) return null
    const v = faustusStore.getPrice(name) // already null when not a number / absent
    if (v == null) return null
    // Per-item age gate. An observation older than the limit is not served as a
    // current price: null here hands the item to the SAME poe.ninja fallback the
    // chain already uses for a name Faustus never quoted, at no extra request
    // (those overviews are fetched per league|type and cached, see ninja.mjs).
    // An unknown hour (store written before `hours` existed) is not "old" —
    // isTooOld says so — so a deploy does not blank a whole store.
    if (typeof faustusStore.getHour === 'function' &&
        isTooOld(faustusStore.getHour(name), { now: nowMs(), maxMs: faustusMaxAgeMs })) return null
    return v
  }

  // Corpse store (Task 5): background-filled name->chaos cache for itemised
  // corpses (priced via the official Trade API). Same single-league guard as
  // Faustus — a valuator for a different league than the store holds must not
  // read stale cross-league corpse prices. getPrice already returns null for a
  // stale/absent/null-cached entry, so the route falls to honestly-unpriced.
  const corpseStore = d.corpseStore || null
  async function fromCorpseStore (name) {
    if (!corpseStore) return null
    if (typeof corpseStore.league === 'function' && corpseStore.league() !== league) return null
    return corpseStore.getPrice(name)
  }

  // Last stage of the fungible chain (after Faustus and fromExchangeMap):
  // poe.ninja's stash currency overview (Currency / Fragment only) ->
  // chaosEquivalent by display name. null when the overview didn't load or the
  // name isn't in it (essences/scarabs/etc. live on the exchange overview and
  // legitimately miss here -> the chain ends honestly unpriced).
  // An EXACT 1.0 from this endpoint is a placeholder, not a price: it reports
  // chaosEquivalent 1.0 whenever a currency lacks real pay/receive data. Measured
  // against the exchange overview for this league, 28 of 38 currencies came back
  // as exactly 1.0 — Scroll of Wisdom (really 0.0063) and Dead Man's Sulphur
  // (0.0007) among them, i.e. off by 158x and 1371x. Chaos Orb itself never
  // reaches here (routed as `{each: 1, source: 'chaos'}`), so rejecting exactly
  // 1.0 costs nothing real and turns a wildly wrong number into an honest
  // "unpriced" on the rare path where Faustus AND the exchange both missed.
  async function fromNinjaCurrencyOverview (type, name) {
    const data = await d.fetchCurrencyOverview(league, type)
    if (!data || !(data.byName instanceof Map)) return null
    const v = data.byName.get(name)
    if (typeof v !== 'number') return null
    return v === 1 ? null : v
  }

  // Lazily built, then cached for the valuator's lifetime.
  let exchangeMapPromise = null
  function exchangeMap () {
    if (!exchangeMapPromise) {
      exchangeMapPromise = (async () => {
        const byTag = new Map()
        const byName = new Map()
        for (const type of EXCHANGE_STACKABLE_TYPES) {
          const data = await d.fetchExchangeOverview(league, type)
          if (!data) continue
          for (const [name, id] of data.nameToId) {
            const line = id != null ? data.lineById.get(id) : null
            // Same volume floor as the div-card path: the merged map is fed from
            // the very same exchange endpoint, so a single-trade artifact would
            // otherwise land on a stackable too (measured: essences at 1-2 items,
            // and in thin leagues tattoos/runegrafts at 4-figure chaos).
            const v = exchangeLineValue(line)
            if (v == null) continue
            if (id != null && !byTag.has(id)) byTag.set(id, v)
            if (!byName.has(name)) byName.set(name, v)
          }
        }
        return { byTag, byName }
      })()
    }
    return exchangeMapPromise
  }

  async function fromExchangeMap (tradeTag, name) {
    const m = await exchangeMap()
    let v = tradeTag != null ? m.byTag.get(tradeTag) : undefined
    if (v == null) v = m.byName.get(name)
    return typeof v === 'number' ? v : null
  }

  // Single exchange `type` (not part of the merged stackable map) — the exchange
  // fallback stage of the DivinationCard fungible chain. Negative-cached in
  // ninja.mjs like the rest. `absentValue`: what to return when the overview
  // LOADED but this name isn't in it. Default null (honestly unpriced — the
  // forced div-card 0 is GONE as of Task 4; Faustus now prices cards first, and
  // a card absent from BOTH Faustus and the card exchange is honestly unpriced,
  // never a silent 0). On a 404/outage (empty or null data) it also stays null.
  async function exchangeSingle (type, name, { absentValue = null } = {}) {
    const data = await d.fetchExchangeOverview(league, type)
    if (!data || data.nameToId.size === 0) return null
    const id = data.nameToId.get(name)
    const line = id != null ? data.lineById.get(id) : null
    if (line) {
      // Present but below the volume floor -> honestly unpriced (null), NOT
      // absentValue: we know the name, we just don't trust this line's price.
      return exchangeLineValue(line)
    }
    return absentValue
  }

  async function fromItemOverview (type, name, baseType = null, links = 0, mods = null) {
    const lines = await d.fetchItemOverview(league, type)
    if (!Array.isArray(lines)) return null
    // Drop low-confidence/phantom lines before matching so they can't win the pick.
    let cands = lines.filter(l => l.name === name && confident(l))
    if (!cands.length) return null
    // baseType tiebreak like ninjaRefFor (server.mjs): same unique name
    // on multiple bases -> the matching base wins.
    if (baseType && cands.some(l => l.baseType === baseType)) cands = cands.filter(l => l.baseType === baseType)
    // LINK variant: poe.ninja carries the same unique as its own line per link
    // count (…-5l, …-6l and the base line without `links`) — 114 of the 326
    // weapon names have several. The FIRST one used to win, and that was the
    // most expensive: an unlinked Nuro's Harp (market: 1c, 1025 listings) was
    // valued at the 6L price of 103.6c. Only 5L/6L get their own lines.
    const linksOf = l => Number(l.links) || 0
    const want = Number(links) >= 5 ? Number(links) : 0
    const exact = cands.filter(l => linksOf(l) === want)
    const base = cands.filter(l => linksOf(l) === 0)
    const pool = exact.length ? exact : (base.length ? base : cands)
    // Several lines left == poe.ninja `variant`s of the same name (measured on
    // the live league: after the baseType and links filters above, EVERY pool
    // with more than one line is a variant pool — so a unique without variants,
    // the normal case, never reaches the code below and is valued exactly as
    // before). Callers that pass no mods (Beast/Incubator/Vial/Invitation) keep
    // the old most-liquid tiebreak untouched.
    let pick = null
    if (pool.length > 1 && mods != null) {
      // The item's own mods decide. When they cannot (see pickVariant), take the
      // CHEAPEST candidate: the wrong variant at the top of a pool is what this
      // whole block exists to prevent, so an undecidable pool must never be
      // valued at the expensive — or the merely most-traded — end. Same
      // conservative floor fromGem() already uses for an unmatched gem, and it
      // keeps the item visible with a defensible number instead of dropping a
      // genuinely tradeable item into `unpriced`.
      const priced = pool.filter(l => typeof l.chaosValue === 'number')
      pick = pickVariant(pool, mods) ||
        (priced.length ? priced.reduce((a, b) => (b.chaosValue < a.chaosValue ? b : a)) : null)
    }
    // No mods handed in (or a single candidate): unchanged behaviour — the
    // LIQUIDEST line, which describes the market best when nothing separates them.
    if (!pick) pick = pool.reduce((best, l) => ((l.count || 0) > (best.count || 0) ? l : best), pool[0])
    return typeof pick.chaosValue === 'number' ? pick.chaosValue : null
  }

  // Gem pricing with variant matching. SkillGem lines carry gemLevel /
  // gemQuality (null == 0) / corrupted / variant + count. Prefer the exact
  // (level, quality, corrupted) variant; else the nearest by a level/quality/
  // corrupt distance; else the cheapest as a conservative floor. The confident()
  // gate is essential here: without it the exact match happily locks onto a
  // low-count phantom (e.g. the 369k-chaos level-20/0q Bear Trap).
  async function fromGem (desc) {
    const lines = await d.fetchItemOverview(league, 'SkillGem')
    if (!Array.isArray(lines)) return null
    const cands = lines.filter(l => l.name === desc.name && confident(l) && typeof l.chaosValue === 'number')
    if (!cands.length) return null
    const lvl = desc.level ?? null
    const q = desc.quality ?? 0
    const corr = desc.corrupted === true

    const exact = cands.find(l =>
      (l.gemLevel ?? null) === lvl &&
      (l.gemQuality ?? 0) === q &&
      (l.corrupted === true) === corr)
    if (exact) return exact.chaosValue

    if (lvl != null) {
      let best = null; let bestScore = Infinity
      for (const l of cands) {
        const score = Math.abs((l.gemLevel ?? 0) - lvl) +
          Math.abs((l.gemQuality ?? 0) - q) * 0.1 +
          ((l.corrupted === true) === corr ? 0 : 100)
        if (score < bestScore || (score === bestScore && l.chaosValue < best.chaosValue)) {
          best = l; bestScore = score
        }
      }
      if (best) return best.chaosValue
    }

    // Cheapest floor.
    return cands.reduce((a, b) => (b.chaosValue < a.chaosValue ? b : a)).chaosValue
  }

  // Helper bundle handed to every declarative route in kinds.mjs. Adding a new
  // category needs NO change here — just one route entry over there.
  const api = {
    league,
    fromFaustus,
    fromCorpseStore,
    fromNinjaCurrencyOverview,
    fromExchangeMap,
    exchangeSingle,
    fromItemOverview,
    fromGem,
  }

  return {
    async value (desc) {
      const route = VALUATION_ROUTES[desc.kind]
      if (!route) return null // skip / unknown kind -> honestly unpriced
      const res = await route(desc, api)
      const each = res?.each
      if (each == null) return null
      return { chaosEach: round1(each), chaosTotal: round1(each * desc.stack), source: res.source }
    }
  }
}
