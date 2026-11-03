// Background corpse pricer. Reads the corpse base names actually held in the
// latest net-worth snapshot(s) (injected getCorpseNames), then per tick prices
// the single stalest/unpriced one via the Trade API — at BACKGROUND priority
// (jobs handed to the server's enqueueBackground three-tier queue) and behind a
// per-hour NAME budget so the first snapshot's ~70 possible searches never
// burst. With the store's 6h cache the steady state is trivial.
//
// Per name: 'Imperfect ' is SKIPPED (the valuation route hard-codes those to 0,
// no query). Otherwise: trade-search -> ≤10 buyouts -> normalise each to chaos
// (divine via the SHARED live C:D, the same value Faustus uses — no second
// constant) -> each = average of the 5 CHEAPEST (fewer than 5 -> what exists;
// 0 results -> null). The result (INCLUDING null) goes into the corpse store so
// illiquid corpses aren't re-queried until the entry goes stale. The count of
// usable listings is stored with the price (`n`), so the valuator can mark a
// price from too few offers (docs/pricing-logic.md, "Uncertain prices"); it
// falls out of the same search, no extra request.
//
// Modelled on faustus-refresher's shape (overlap guard, .unref()'d interval,
// start/stop/tickOnce) but paces ONE name per tick with a hard hourly budget.
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000 // 2min/name -> ~30/h ceiling; budget is the real cap
const WINDOW_MS = 60 * 60 * 1000

const isImperfect = name => typeof name === 'string' && name.startsWith('Imperfect ')

// Default bar of the Net-Worth "few listings" marker: a corpse price averaged
// from fewer usable trade offers than this is marked uncertain. 2 marks
// exactly a price from ONE offer — one seller's ask, which says little about
// what the corpse sells for. It only marks; no price changes. numeric-settings
// imports it as the default of POE_NETWORTH_CORPSE_MIN_LISTINGS.
export const CORPSE_MIN_LISTINGS = 2

// Normalise a buyout to chaos. Only the two currencies we can price are kept:
// chaos 1:1 and divine via the shared C:D. ANY other priceCurrency (exalted,
// mirror, …) is DISCARDED (null) rather than silently miscounted as chaos —
// sort:price:asc usually keeps exotics out but does NOT guarantee it, and one
// mislabelled "1 mirror" booked as 1 chaos would poison the avg. The avg-5
// then uses only normalisable listings.
function toChaos (listing, cdRatio) {
  const amt = listing?.priceAmount
  if (typeof amt !== 'number' || !isFinite(amt) || amt < 0) return null
  const cur = listing?.priceCurrency
  if (cur === 'chaos') return amt
  // Divine needs a usable C:D. Without one (cdRatio null/0/NaN) the listing is
  // NON-normalisable -> drop it, never fall back to 1:1 (a "1 divine" booked as
  // 1 chaos would be a ~1150x under-price). Chaos listings still price fine.
  if (cur === 'divine') return (typeof cdRatio === 'number' && isFinite(cdRatio) && cdRatio > 0) ? amt * cdRatio : null
  return null // unknown/exotic currency -> drop this listing
}

// { each, n }: each = the average of the 5 cheapest usable listings (null when
// there is none), n = how many usable listings there were BEFORE the cut to
// five — the evidence behind the number.
function averageOf5Cheapest (listings, cdRatio) {
  const chaos = listings
    .map(l => toChaos(l, cdRatio))
    .filter(v => typeof v === 'number' && isFinite(v) && v >= 0)
    .sort((a, b) => a - b)
  if (!chaos.length) return { each: null, n: 0 } // 0 results / all unparseable -> honestly unpriced (cached as null)
  const take = chaos.slice(0, 5)
  return { each: take.reduce((a, b) => a + b, 0) / take.length, n: chaos.length }
}

export function createCorpsePricer ({
  store,
  tradeClient,
  league,
  getCorpseNames,        // () => string[]  (corpse names from the networth snapshot(s))
  chaosPerDivine,        // () => number|Promise<number>  (SHARED live C:D)
  enqueueBackground,     // server three-tier queue (background tier)
  budgetPerHour = 25,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => Date.now(),
  maxFetch = 10,
  onPriced = () => {},
  log = console
} = {}) {
  let busy = false           // overlap guard (a slow query never runs alongside the next tick)
  let intervalHandle = null
  const queryTimes = []      // ms timestamps of the last hour's queries (budget)
  const inFlight = new Set() // names handed to the background queue but not yet
                             // written to the store — nextName() must skip them
                             // so a staled background queue can't get the SAME
                             // name re-picked (double query, wasted budget).

  function budgetLeft () {
    const cutoff = now() - WINDOW_MS
    while (queryTimes.length && queryTimes[0] < cutoff) queryTimes.shift()
    return budgetPerHour - queryTimes.length
  }

  // The stalest un-priced/stale non-Imperfect name that needs a (re)query.
  function nextName () {
    const names = getCorpseNames?.() || []
    const seen = new Set()
    let pick = null
    let pickAge = -1
    for (const name of names) {
      if (!name || isImperfect(name) || seen.has(name)) continue
      seen.add(name)
      if (inFlight.has(name)) continue          // already queued/running -> don't double-query
      if (store.isFresh(name, now())) continue // cached (price OR null) -> skip
      const age = store.ageOf(name, now())     // Infinity for never-priced -> wins
      if (age > pickAge) { pick = name; pickAge = age }
    }
    return pick
  }

  async function resolveCd () {
    // No usable C:D -> null (NOT 1). null makes divine listings non-normalisable
    // (dropped in toChaos) instead of a 1c-divine footgun. With the current
    // wiring cdMsgFor always yields a number, so this null path is defensive
    // insurance against a future re-wire, not a live code path.
    try {
      const v = await (typeof chaosPerDivine === 'function' ? chaosPerDivine() : chaosPerDivine)
      return (typeof v === 'number' && isFinite(v) && v > 0) ? v : null
    } catch { return null }
  }

  async function priceOne (name) {
    try {
      const listings = await tradeClient.searchListings(name, league, { maxFetch })
      const cd = await resolveCd()
      const { each, n } = averageOf5Cheapest(listings, cd) // each: number or null (0 results)
      await store.setPrice(league, name, each, now(), n)
      onPriced(name, each)
    } catch (e) {
      if (e?.code === 'CIRCUIT_OPEN') return // breaker tripped -> stay quiet, leave the entry as-is
      // Other failures (429/5xx/network): do NOT cache -> the name stays stale and
      // is retried on a later tick. Never poison the store with a fake price.
      log.warn?.(`[corpse-pricer] price failed for "${name}" (kept unpriced, will retry): ${e?.message || e}`)
    } finally {
      inFlight.delete(name) // store written (or job failed) -> free the name for a later tick
    }
  }

  async function tickOnce () {
    if (busy) return
    if (tradeClient.isCircuitOpen?.()) return // ban-signal cooldown active -> query nothing (self-heals)
    if (budgetLeft() <= 0) return             // per-hour name budget exhausted
    const name = nextName()
    if (!name) return
    busy = true
    queryTimes.push(now()) // reserve the budget slot at decision time (serial queue)
    inFlight.add(name)     // block re-pick until priceOne writes the store (removed in its finally)
    try {
      // enqueueBackground is fire-and-forget: it returns once the job is QUEUED,
      // not once it runs. inFlight (not this await) is what prevents a double
      // query while the job waits behind foreground price-checks.
      await enqueueBackground(() => priceOne(name))
    } finally {
      busy = false
    }
  }

  function start () {
    if (intervalHandle) clearInterval(intervalHandle)
    intervalHandle = setInterval(() => {
      tickOnce().catch(e => log.error?.(`[corpse-pricer] tick failed: ${e?.message || e}`))
    }, intervalMs)
    intervalHandle.unref?.()
    return intervalHandle
  }

  function stop () {
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null }
  }

  return { start, stop, tickOnce, nextName, budgetLeft }
}
