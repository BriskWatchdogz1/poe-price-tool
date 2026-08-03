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
// `volumePrimaryValue / primaryValue` is the number of ITEMS behind the price.
// poe.ninja reports the volume averaged over its 6-slot window, i.e. a ratio of
// 1/6 (0.1667) is EXACTLY ONE traded item; measured over all 947 Allflame
// exchange lines the ratio is a multiple of 1/6 throughout. 0.5 therefore means
// "at least three items changed hands".
//
// Why a floor at all: a line backed by a single trade is one observation, not a
// market, and it survives into our valuation even after the Faustus path
// (GGG digest) correctly rejects it — both sources scrape the same lone trade.
// Measured case: "The Carrion Crow" (a 4-card set buys a random magic armour,
// i.e. vendor trash) was listed at 2016c off volumePrimaryValue 336 -> 0.17
// units -> ONE card. GGG's digest showed the very same single 1:14 divine trade.
//
// Calibration against the live Allflame data (all 15 exchange types, 947 lines):
//   - The floor removes 29 of 947 lines. Exactly ONE of them is worth more than
//     100c: The Carrion Crow (2016c, 1 item) — the documented outlier.
//     The rest: Left to Fate (97c, 1) and 22 further cards at <=7c, plus 5
//     essences at <=3c. Full list at the time of writing (name, price, items):
//     Left to Fate 97c/1, The Tumbleweed 7c/1, The Hale Heart 5c/1,
//     Fateful Meeting 4c/2, Forbidden Power 4c/2, The Throne 3.67c/3,
//     The Fathomless Depths 3c/1, The Fox in the Brambles 3c/2,
//     Muttering Essence of Woe 3c/1, Man With Bear 2c/2, The Rabid Rhoa 2c/1,
//     The Return of the Rat 2c/2, Ever-Changing 2c/1, The Whiteout 2c/1,
//     Ambitious Obsession 1.5c/2, A Note in the Wind 1.5c/2,
//     Abandoned Wealth 1c/1, The King's Blade 1c/1, The Lord of Celebration 1c/2,
//     The Metalsmith's Gift 1c/1, The Army of Blood 1c/1, The Body 1c/1,
//     Three Voices 1c/1, and 4 more 0.5-1c essences at 2 items.
//   - The known heavyweights stay: House of Mirrors 9404c/1373 items,
//     The Apothecary 5053c/1820, The Doctor 1804c/1714, The Nurse 216c/2079,
//     Unrequited Love 3281c/1268, The Eye of Terror 3135c/705.
//   - The thinnest lines we still ACCEPT are Father's Love (3708c, 8 items),
//     Pearls Before Swine (2106c, 8) and Runegraft of the Angler (2631c, 4) —
//     so the gap between "rejected" (1 item) and "genuine but thin" (4 items)
//     is real and the floor sits inside it with margin on both sides.
//   - Currency/Fragment/Scarab/Fossil/Oil/… have NO line below the floor in a
//     live league (thinnest currency line: 66 items), so the merged stackable
//     map only ever loses the odd 1c essence.
// The artifact shows up at every price level (2016c and 1c alike), so the data
// give no reason for a value-dependent floor — a flat item count is what they
// support.
const MIN_EXCHANGE_UNITS = 0.5

// Chaos value of a poe.ninja exchange line, or null when it must not be trusted.
// Rejects a non-positive price (would enter the sum as a fake 0) and any line
// below the volume floor. No usable volume field -> fail OPEN: the floor exists
// to drop lines we can PROVE are thin, so if poe.ninja ever stops shipping the
// field we keep pricing instead of blanking every stackable. Never returns 0.
function exchangeLineValue (line) {
  const v = line && typeof line.primaryValue === 'number' ? line.primaryValue : null
  if (v == null || !(v > 0)) return null
  const vol = line.volumePrimaryValue
  if (typeof vol !== 'number' || !Number.isFinite(vol) || vol < 0) return v
  return vol / v >= MIN_EXCHANGE_UNITS ? v : null
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
  async function fromFaustus (name) {
    if (!faustusStore) return null
    if (typeof faustusStore.league === 'function' && faustusStore.league() !== league) return null
    // F1: staleness gate. If the whole map is older than the TTL (CDN feed
    // silently broke), treat Faustus as absent -> null -> the ninja fallback in
    // the fungible chain takes over, instead of serving frozen prices forever.
    if (typeof faustusStore.isFresh === 'function' && !faustusStore.isFresh(faustusTtlMs)) return null
    return faustusStore.getPrice(name) // already null when not a number / absent
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

  // Middle stage of the fungible chain: poe.ninja's stash currency overview
  // (Currency / Fragment only) -> chaosEquivalent by display name. null when the
  // overview didn't load or the name isn't in it (essences/scarabs/etc. live on
  // the exchange overview instead and legitimately miss here -> caller falls
  // through to fromExchangeMap).
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
