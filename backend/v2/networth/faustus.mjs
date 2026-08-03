// backend/v2/networth/faustus.mjs
// Official GGG Currency Exchange ("Faustus") client: public poecdn CDN, no auth.
// Turns the hourly per-league ratio digests into a name->chaos map that the
// valuator (Task 4) consumes as the PRIMARY source for fungibles.
//
// Endpoint (PoE1 PC, NO realm segment):
//   GET https://web.poecdn.com/api/currency-exchange/<id>
// `id` = unix HOUR timestamp (seconds). Without an id you get the OLDEST hour,
// so we always pass one. Current data = last COMPLETED hour. Data is hourly
// delayed, one feed carries every league (filter by market.league), only
// markets active that hour appear, and GGG may delete old history — so we union
// several completed hours (most-recent market wins). Ratio semantics are NOT
// officially documented; the midpoint derivation below is empirically verified
// and pinned by faustus.test.mjs — see rateXperQuote.
import { loadBaseNames } from './base-names.mjs'
import { isAttested, SELL_MIN_UNITS } from '../sell-side.mjs'

const FAUSTUS_BASE = 'https://web.poecdn.com/api/currency-exchange'
const FAUSTUS_UA = 'poe-price-tool/0.1'

const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare'
const DIVINE = 'Metadata/Items/Currency/CurrencyModValues'

// Volume floor on the QUOTE side ONLY, in absolute units. An expensive X
// legitimately trades 1-3/hour while the chaos side is huge, so a two-sided
// floor would unprice exactly the high-value items.
//
// The divine floor was 2 — one trade. Measured across this league's 74
// divine-quoted markets in an hour: median volume 5, and the markets that
// genuinely price in divine sit far above it (The Doctor 429, The Apothecary
// 237, Deck 248). A floor of 2 therefore admitted single trades, which is how a
// lone "2 divine for 30 regal" priced Regal Orb at 5.67c. 10 clears
// single/double trades while keeping every market with real activity.
const QUOTE_VOL_MIN = { [CHAOS]: 50, [DIVINE]: 10 }
const SPREAD_LIMIT = 4 // hi/lo are hourly EXTREMES, not percentiles; wide spread = troll trade
// How far a Divine-bridged price may sit outside X's own (possibly rejected)
// chaos range before we call it implausible. Same order as SPREAD_LIMIT: wide
// enough that a genuinely dual-traded item passes, tight enough that Regal
// Orb's 5.67c against an observed 0.2..1.0c range does not.
const BRIDGE_TOLERANCE = 4
const DEFAULT_UNION_HOURS = 8 // walk back this many completed hours, most-recent market wins; overridable via deps.unionHours (Task 3: POE_FAUSTUS_UNION_HOURS)
// Slack for the union walk: the newest completed hour may not be published yet
// (undocumented delay) and GGG-deleted history leaves holes — allow that many
// extra "step back" attempts on top of the UNION_HOURS budget of real hours.
const STEP_BACK_MAX = 24

// Last completed hour, hour-truncated (unix seconds).
export function lastHour (now) { const h = Math.floor(now / 3600) * 3600; return h - 3600 }

// Order-independent key for a market_pair ([idA, idB]).
const pairKeyOf = m => [...m.market_pair].sort().join('|')

// Midpoint chaos-per-X (well: quote-units per 1 X) for a market pairing X with
// `quote` (Chaos or Divine). ratio dicts are keyed by metadata id. Do NOT
// assume lowest<highest (pair order is by GGG internal hash) — normalise. The
// volume floor applies to the QUOTE side only; a spread (max/min) beyond
// SPREAD_LIMIT means a single outlier trade skewed the hour -> reject.
export function rateXperQuote (market, x, quote) {
  const lo = market.lowest_ratio, hi = market.highest_ratio, vol = market.volume_traded || {}
  if (!lo || !hi || !(x in lo) || !(quote in lo)) return null
  if ((vol[quote] ?? 0) < (QUOTE_VOL_MIN[quote] ?? 1) || (vol[x] ?? 0) < 1) return null
  const a = lo[quote] / lo[x], b = hi[quote] / hi[x] // quote-units per 1 X
  if (![a, b].every(v => isFinite(v) && v > 0)) return null
  const min = Math.min(a, b), max = Math.max(a, b)
  if (max / min > SPREAD_LIMIT) return null // outlier-skewed hour -> unreliable
  return (min + max) / 2 // robust midpoint
}

// The raw quote-units-per-X range, WITHOUT the volume/spread guards. Only used
// as a plausibility envelope for a bridged price (see buildChaosById): a market
// too noisy to price from still tells us the order of magnitude X traded at.
export function rawRateRange (market, x, quote) {
  const lo = market?.lowest_ratio, hi = market?.highest_ratio
  if (!lo || !hi || !(x in lo) || !(quote in lo)) return null
  const a = lo[quote] / lo[x], b = hi[quote] / hi[x]
  if (![a, b].every(v => isFinite(v) && v > 0)) return null
  return { min: Math.min(a, b), max: Math.max(a, b) }
}

// Does this market entry carry ANY information? GGG publishes placeholder
// entries for a pair that was idle in that hour: all ratio fields 0 and
// volume_traded 0. Such an entry says nothing, yet in the union walk it used to
// shadow the older, REAL entry of the same pair (see fetchUnion) — which is how
// The Jeweller's Boon, a 1-chaos card with a real 1:1 chaos market two hours
// back, ended up priced at ~1470c through a single 10-divine trade.
//
// "Informative" = a raw ratio can be derived (rawRateRange is the existing,
// tolerant definition of "the ratio fields make sense") OR the pair saw traded
// volume. Anything malformed counts as uninformative — never throw.
export function isInformativeMarket (m) {
  if (!m || !Array.isArray(m.market_pair) || m.market_pair.length !== 2) return false
  const [a, b] = m.market_pair
  if (rawRateRange(m, a, b)) return true
  const vol = m.volume_traded
  if (vol && typeof vol === 'object') {
    for (const id of [a, b]) {
      const v = vol[id]
      if (typeof v === 'number' && isFinite(v) && v > 0) return true
    }
  }
  return false
}

// Volume-weighted quote-units-per-X for the same market: volume_traded is the
// hour's MATCHED volume on both sides, so quote-volume / X-volume IS the
// volume-weighted average ratio the hour traded at — no extremes involved.
//
// This is the PRIMARY estimator (see buildChaosById); rateXperQuote's midpoint
// is the fallback. Reason: lowest/highest_ratio are the hour's EXTREMES, so
// their midpoint can be set by two single trades. Measured over the 703 chaos
// markets of the live Allflame digest, the median spread (max/min) is 2.0 and
// p90 is 5.0 — far too wide for a two-point mean to be the better number.
// Concrete gaps (mid vs volume-weighted): Memory of Reverence 13.5 vs 13.6,
// Cartography Scarab of Escalation 1.25 vs 1.07 (25k chaos turnover), Sulphite
// Scarab 1.25 vs 0.76, Chaos:Divine 123.5 vs 121.6 (12.3M chaos turnover).
//
// It also fixes what the midpoint cannot see at all: lowest_ratio/highest_ratio
// are INTEGER pairs, so for anything trading near or below 1 chaos the coarsest
// legal quantisations are far apart (Brinehook's Ducat traded at "3 Ducats : 1
// Chaos" .. "1 Ducat : 2 Chaos" = 0.33..2.0) and the spread guard rejects cheap
// high-volume items BY CONSTRUCTION — they then fell through to the trade-site
// ask, where nothing is listed under 1 Divine; that is how a ~1c Ducat was
// shown as 110c.
//
// Measured against the live Allflame digest (851 chaos markets, 8h union): the
// volume-weighted ratio fell INSIDE the hour's own extremes band in 700 of 700
// markets that had usable volume (0 outliers), and on the markets the spread
// guard accepts it agrees with the midpoint to a median of 0.992x (p10 0.79,
// p90 1.10, n=598). So it is a sound estimator, not a guess.
//
// Same quote-side volume floor as rateXperQuote, plus the band check as a
// consistency guard: if the two fields disagree, the derivation is not trusted
// and the midpoint takes over.
export function volumeRateXperQuote (market, x, quote) {
  const vol = market?.volume_traded || {}
  const vx = vol[x] ?? 0, vq = vol[quote] ?? 0
  if (vq < (QUOTE_VOL_MIN[quote] ?? 1) || vx < 1) return null
  const r = vq / vx
  if (!isFinite(r) || r <= 0) return null
  const env = rawRateRange(market, x, quote)
  if (env && (r < env.min || r > env.max)) return null
  return r
}

// Default (real) hour fetch. 404 / non-ok -> null so the union treats it as
// "step back one hour" (the newest hour may not be published yet).
async function defaultFetchHour (id) {
  const r = await fetch(`${FAUSTUS_BASE}/${id}`, {
    headers: { 'User-Agent': FAUSTUS_UA, Accept: 'application/json' }
  })
  if (!r.ok) return null
  const j = await r.json()
  return { next_change_id: j.next_change_id, markets: Array.isArray(j.markets) ? j.markets : [] }
}

// A digest that is "not ready" (or absent) -> caller steps back one hour.
// Newest-hour "not ready" is undocumented: treat ALL of {404/absent, empty
// markets, next_change_id === requested id} as step-back, not just 404.
function isNotReady (digest, id) {
  return !digest || !Array.isArray(digest.markets) || digest.markets.length === 0 ||
    digest.next_change_id === id
}

/**
 * createFaustusPricer({ league, deps }) ->
 *   { detailByName(): Promise<Map<name,{chaos,min?,max?}>>,
 *     chaosByName(): Promise<Map<name,chaos>>, chaosForName(name): Promise<number|null> }
 *
 * deps (all injectable; defaults are the real implementation):
 *   - fetchHour(id) -> { next_change_id, markets } | null   (real CDN fetch)
 *   - now()          -> unix seconds                          (Date-based)
 *   - baseNames      -> loadBaseNames() result { byId }
 *   - chaosPerDivineFallback -> chaos-per-divine used ONLY when the
 *       Divine<->Chaos market is missing/rejected this window. May be a NUMBER
 *       or a (possibly async) FUNCTION returning one — server.mjs wires the
 *       function to the SINGLE shared C:D source: the currency-EXCHANGE divine
 *       rate (cdMsgFor / fetchCurrencyExchange) that the price-check bulk,
 *       corpse pricer and net-worth aggregate all use, so no
 *       two subsystems bridge at different rates (never a hardcoded constant).
 *       Omitted / resolves to null -> the Divine bridge is skipped for that
 *       window (those items stay unpriced, the ninja fallback in the valuator
 *       takes over) rather than bridged through a bogus ratio.
 *   - unionHours -> how many completed hours to walk back and union (default
 *       8; Task 3 wires this to POE_FAUSTUS_UNION_HOURS).
 */
export function createFaustusPricer ({ league, deps = {} } = {}) {
  const {
    fetchHour = defaultFetchHour,
    now = () => Math.floor(Date.now() / 1000),
    chaosPerDivineFallback, // number | (async () => number) | undefined (see doc above)
    unionHours = DEFAULT_UNION_HOURS
  } = deps

  let baseNames = deps.baseNames || null

  // Resolve the C:D fallback (number or live async fn) to a positive number, or
  // null when unavailable -> the Divine bridge is then skipped, never applied
  // with a bogus ratio.
  async function resolveChaosPerDivineFallback () {
    let v = chaosPerDivineFallback
    if (typeof v === 'function') {
      try { v = await v() } catch { return null }
    }
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : null
  }

  // Union the last `unionHours` *available* completed hours into a
  // pairKey -> market map; the most-recent hour a pair appears in wins.
  //
  // "Most recent" means most recent INFORMATIVE entry: an idle-hour placeholder
  // (all ratios/volumes 0) must not shadow a real entry from an older hour, or
  // the pair looks unpriceable and — worse — loses its plausibility envelope in
  // buildChaosById, which then lets a lone divine trade set the price. A pair
  // that ONLY ever has placeholders keeps one (it stays unpriced as before).
  async function fetchUnion () {
    let id = lastHour(now())
    const byPair = new Map()
    const usable = new Set() // pairKeys whose stored entry is informative
    let collected = 0
    let guard = 0
    const guardMax = unionHours + STEP_BACK_MAX
    while (collected < unionHours && guard < guardMax) {
      guard++
      const digest = await fetchHour(id)
      if (isNotReady(digest, id)) { id -= 3600; continue }
      for (const m of digest.markets) {
        if (league != null && m.league !== league) continue
        if (!Array.isArray(m.market_pair) || m.market_pair.length !== 2) continue
        const key = pairKeyOf(m)
        if (usable.has(key)) continue // newest-first walk -> newest usable wins
        const ok = isInformativeMarket(m)
        if (!byPair.has(key) || ok) byPair.set(key, m)
        if (ok) usable.add(key)
      }
      collected++
      id -= 3600
    }
    return byPair
  }

  // From the unioned markets, build metadata-id -> { chaos, min?, max?, sell? }.
  // `min`/`max` are the chaos-per-X range the hour actually spanned (raw, i.e.
  // WITHOUT the volume/spread guards — the guards decide whether we price at
  // all, not how wide the market was). Omitted when there is no usable range,
  // never guessed.
  async function buildDetailById (byPair) {
    // id -> Map(counterpartId -> market)
    const marketOf = new Map()
    const allIds = new Set()
    const add = (a, b, m) => {
      if (!marketOf.has(a)) marketOf.set(a, new Map())
      marketOf.get(a).set(b, m)
    }
    for (const m of byPair.values()) {
      const [a, b] = m.market_pair
      allIds.add(a); allIds.add(b)
      add(a, b, m); add(b, a, m)
    }

    // 1. chaosPerDivine from the Divine<->Chaos market, else fallback. Same
    // order as everywhere else: volume-weighted first, midpoint second — the
    // C:D market is the highest-turnover market in the whole digest (12.3M
    // chaos in the measured hour), so its extremes mean the least there.
    let chaosPerDivine = null
    const divChaosMarket = marketOf.get(DIVINE)?.get(CHAOS)
    if (divChaosMarket) {
      chaosPerDivine = volumeRateXperQuote(divChaosMarket, DIVINE, CHAOS) ??
        rateXperQuote(divChaosMarket, DIVINE, CHAOS)
    }
    if (chaosPerDivine == null) chaosPerDivine = await resolveChaosPerDivineFallback()

    const detailById = new Map()
    detailById.set(CHAOS, { chaos: 1 }) // Chaos itself = 1, no range

    for (const x of allIds) {
      if (x === CHAOS) continue
      const counterparts = marketOf.get(x)
      const cm = counterparts?.get(CHAOS)
      const dm = counterparts?.get(DIVINE)
      let chaos = null
      let bridged = false

      // 1. + 2. X<->Chaos: volume-weighted primary, extremes-midpoint fallback.
      if (cm) chaos = volumeRateXperQuote(cm, x, CHAOS) ?? rateXperQuote(cm, x, CHAOS)

      // SELL-SIDE RATES (additive, consumed by the reference rail via
      // sell-side.mjs): the two per-market rates KEPT SEPARATE, plus the
      // traded volumes as evidence. This deliberately does NOT touch how
      // `chaos` above is derived — the chaos side REUSES that very value (the
      // estimator ORDER is load-bearing: volume-weighted first, midpoint only
      // as fallback — the extremes midpoint on a wide-spread hour flips the
      // whole chaos-vs-divine recommendation, see the Wild Lifeforce
      // 0.0426-vs-0.0197 case pinned in the tests), and the divine side is
      // estimated by the same procedure. These are rates from MATCHED trade
      // volumes, not asks/bids — the absolute number is an estimate, but the
      // chaos-vs-divine COMPARISON is sound because both sides carry the same
      // estimator bias. Attestation (is a side backed by enough volume to
      // compare at all?) is the consumer's job: see compareSellSides in
      // ../sell-side.mjs.
      const sell = {}
      if (cm && chaos != null) {
        sell.chaos = { perItem: chaos, volX: cm.volume_traded?.[x] ?? 0, volQuote: cm.volume_traded?.[CHAOS] ?? 0 }
      }
      if (dm && x !== DIVINE) {
        const rate = volumeRateXperQuote(dm, x, DIVINE) ?? rateXperQuote(dm, x, DIVINE)
        if (rate != null) {
          sell.divine = { perItem: rate, volX: dm.volume_traded?.[x] ?? 0, volQuote: dm.volume_traded?.[DIVINE] ?? 0 }
        }
      }

      // 3. + 4. Neither worked -> X<->Divine bridged through chaosPerDivine,
      // again volume-weighted first, midpoint second.
      //
      // Plenty of items legitimately trade in BOTH currencies (Harvest
      // lifeforce, fragments, mid-value cards), so a rejected chaos hour must
      // NOT veto the bridge — that would throw away a perfectly good divine
      // quote. What went wrong with Regal Orb was narrower: its chaos market
      // (3095 chaos traded, hourly ratios 1:5..1:1) was rejected on spread, and
      // the bridge then took a Divine market of 2 divine for 30 regal — a SINGLE
      // trade, which also defeats the spread guard by construction since
      // lowest_ratio === highest_ratio looks maximally consistent. Result:
      // 5.67c for a 0.3c currency, 34x too high.
      //
      // So: bridge freely, but when X also has a chaos market, sanity-check the
      // bridged value against what that market actually showed. A market too
      // noisy to price from still pins the order of magnitude. Regal's chaos
      // range was 0.2..1.0c, so 5.67c is rejected; a dual-traded item whose
      // divine quote agrees with its chaos range passes untouched. BOTH bridge
      // variants go through this envelope — dropping it on either one brings
      // the Regal regression straight back.
      //
      // Without a chaos market there IS no envelope, and then nothing checks the
      // divine quote at all: QUOTE_VOL_MIN[DIVINE] = 10 guards the QUOTE side,
      // and "10 divine turnover" can be one single trade (The Jeweller's Boon:
      // one 1-card-for-10-divine trade, while the card really goes for 1 chaos).
      // So in the envelope-less case additionally require more than one traded
      // unit on the X side. With an envelope this does NOT apply — the envelope
      // is the sharper check, and expensive, rarely traded items with a valid
      // chaos reference must keep their price.
      // A thin chaos market must not outrank a liquid divine one. Measured on a
      // live digest: The Progeny of Lunaris had ONE chaos trade (1132c) next to
      // a divine market of 33 cards at a rock-steady 12-13 div, and the single
      // trade won — the card showed as 6.4 div against a real ~12.4. It is
      // systematic and one-sided: of 38 cards quoting both currencies, 19 came
      // out more than 25% low and exactly 1 high, and it hits precisely the
      // expensive ones, because only there is the chaos side thin enough for a
      // single trade to define the hour.
      //
      // None of the three existing guards can catch it. QUOTE_VOL_MIN measures
      // the QUOTE (chaos) side, and one trade of an expensive item clears 50
      // chaos effortlessly. SPREAD_LIMIT cannot fire because a single trade has
      // lowest_ratio === highest_ratio, which looks maximally consistent. And
      // the envelope below never runs, because the bridge is only reached when
      // the chaos market produced nothing at all.
      //
      // So: hand the price to the bridge when the chaos side traded too FEW
      // UNITS while the divine side is properly attested.
      //
      // The unit count is the criterion, deliberately not full isAttested() on
      // the chaos side. isAttested also demands 5000c of turnover, and that bar
      // is price-dependent: it fails cheap-but-liquid markets simply for being
      // cheap. Measured over 102 anchor hours (76k priced lines, poe.ninja as
      // reference): the turnover bar produced 7 lines above 100% error, the unit
      // gate produces 2.
      //
      // What the unit gate does NOT fix, so nobody rediscovers it the hard way:
      //   - Desecrated Virtue still bridges to 524c against a real ~240c in 2 of
      //     those 102 hours. Its chaos market had 6 units there — below the gate
      //     — while spanning a near-perfect 220.0..221.0. The gate discards a
      //     good market for being small.
      //   - One Last Score comes out WORSE than under the turnover bar (item
      //     median 31% -> 37%): its chaos market clears the gate with 10-37
      //     units but underquotes, while the divine side carries 2-4x the units.
      //     The gate is absolute — it never asks whether the divine side is
      //     better evidenced than the chaos side. Making it relative is the
      //     obvious fix and is unmeasured.
      // Attesting the divine side at an honest price was measured as well: it
      // removes both >100% lines but costs two others just as badly (Divine
      // Justice 22-26% -> 66%). Not taken — that is a trade, not a win.
      //
      // On the DIVINE side the full attestation stays, and it is load-bearing:
      // without it the coarse "1 div : N items" quantisation takes over and
      // Breach Scarab of the Marshal (really 1.26c) prices at 184c off a single
      // 1-divine trade.
      if (chaos != null && dm && sell.chaos && sell.divine && chaosPerDivine != null &&
          sell.chaos.volX < SELL_MIN_UNITS && isAttested(sell.divine, chaosPerDivine)) {
        const env = cm ? rawRateRange(cm, x, CHAOS) : null
        const bridgedChaos = sell.divine.perItem * chaosPerDivine
        const plausible = !env ||
          (bridgedChaos >= env.min / BRIDGE_TOLERANCE && bridgedChaos <= env.max * BRIDGE_TOLERANCE)
        if (plausible) { chaos = bridgedChaos; bridged = true }
      }

      if (chaos == null && chaosPerDivine != null && dm) {
        const env = cm ? rawRateRange(cm, x, CHAOS) : null
        const volX = dm.volume_traded?.[x] ?? 0
        const plausible = v => !env ||
          (v >= env.min / BRIDGE_TOLERANCE && v <= env.max * BRIDGE_TOLERANCE)
        if (env || volX >= 2) {
          for (const perDiv of [volumeRateXperQuote(dm, x, DIVINE), rateXperQuote(dm, x, DIVINE)]) {
            if (perDiv == null) continue
            const v = perDiv * chaosPerDivine
            if (plausible(v)) { chaos = v; bridged = true; break }
          }
        }
      }

      if (chaos == null) continue
      // The range shown to the user: what the hour actually spanned, in chaos
      // per X. Chaos market preferred (it IS chaos); only a purely
      // divine-bridged price falls back to the divine market's range converted
      // at chaosPerDivine. Degenerate (min >= max) or unusable -> no range.
      // The range must describe the market the PRICE came from. While the bridge
      // only ever fired without a chaos market this was the same thing; now that
      // a bridged price can coexist with a chaos market, keeping the chaos range
      // put the headline outside its own band in 82% of cases (the UI showed
      // "3004c" next to a span of "1281..2000c").
      let range = (cm && !bridged) ? rawRateRange(cm, x, CHAOS) : null
      if (bridged && dm && chaosPerDivine != null) {
        const dr = rawRateRange(dm, x, DIVINE)
        if (dr) range = { min: dr.min * chaosPerDivine, max: dr.max * chaosPerDivine }
      }
      const detail = { chaos }
      if (range && isFinite(range.min) && isFinite(range.max) && range.min < range.max) {
        detail.min = range.min
        detail.max = range.max
      }
      if (sell.chaos || sell.divine) detail.sell = sell
      detailById.set(x, detail)
    }
    return detailById
  }

  // Normalise a metadata id to its "Metadata/Items/<seg>/" prefix for gap logs.
  const prefixOf = id => {
    const parts = String(id).split('/')
    return parts.length >= 3 ? parts.slice(0, 3).join('/') + '/' : String(id)
  }

  async function buildDetailByName () {
    if (!baseNames) baseNames = await loadBaseNames()
    const byId = baseNames.byId
    const byPair = await fetchUnion()
    const detailById = await buildDetailById(byPair)

    const byName = new Map()
    const unmappedPrefixes = new Set()
    for (const [id, detail] of detailById) {
      const name = byId.get(id)
      // Skip unmapped ids (log the prefix as a coverage gap) and RePoE's empty
      // placeholder names ("" for the 420 RandomFossilOutcome* entries).
      if (name === undefined) { unmappedPrefixes.add(prefixOf(id)); continue }
      if (name === '') continue
      byName.set(name, detail)
    }
    if (unmappedPrefixes.size > 0) {
      console.warn('[faustus] priced ids with no RePoE name (coverage gap) at prefixes: %s',
        [...unmappedPrefixes].sort().join(', '))
    }
    return byName
  }

  return {
    // Swap in a freshly loaded { byId } map at runtime (data refresher: a new
    // base-names.json was adopted). Takes effect on the next pricer call —
    // i.e. at the latest on the next hourly faustus-refresher tick.
    setBaseNames (bn) { if (bn && bn.byId) baseNames = bn },
    // name -> { chaos, min?, max?, sell? }. The full result; chaosByName() is
    // the thin backwards-compatible projection of it. `sell` carries the
    // per-market chaos/divine rates + volumes for the rail's sell-side
    // comparison (see buildDetailById).
    async detailByName () { return buildDetailByName() },
    async chaosByName () {
      const detail = await buildDetailByName()
      const out = new Map()
      for (const [name, d] of detail) out.set(name, d.chaos)
      return out
    },
    async chaosForName (name) {
      const map = await buildDetailByName()
      return map.has(name) ? map.get(name).chaos : null
    }
  }
}
