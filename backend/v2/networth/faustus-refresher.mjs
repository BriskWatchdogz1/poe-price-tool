// Background hourly refresh of the Faustus name->chaos map. Faustus data
// itself only changes once per hour (see faustus.mjs), so this simply calls
// the pricer (Task 2's `chaosByName()`) on an interval and persists the
// result into the Faustus store (faustus-store.mjs). Modelled on
// refresher.mjs's shape (overlap-guarded, .unref()'d interval, start/stop/
// tickOnce) but far simpler: there's no per-user/per-tab state and no
// rate-limit cooldown (Faustus is a public CDN, not the throttled GGG stash
// API) — a failed tick just skips and keeps the store's last good map (NEVER
// wipes on error; the union walk inside chaosByName already absorbs single
// missing hours, so this only fires on a harder failure).
//
// A failure is also handed to `onFailed(reason, kind)` (docs/bugs.md B29): the
// server feeds it into source-health.mjs, so the status line on every page can
// say the Faustus prices are getting old and why. The per-tick warn stays — at
// the 1 h floor of POE_FAUSTUS_REFRESH_MS that is already one line an hour —
// and the first success after failures says how long it was down.
import { kindOf } from '../check-failure.mjs'
import { fmtDuration } from '../fail-log.mjs'

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000 // 1h — matches Faustus's own cadence

export function createFaustusRefresher ({
  league,
  store,
  pricer,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => Date.now(),
  onRefreshed = () => {},
  onFailed = () => {},
  log = console
} = {}) {
  let busy = false // overlap guard: a slow fetch never runs alongside the next tick
  let failingSince = null // when the current run of failed ticks began
  let failedTicks = 0
  function noteFailure (reason, kind) {
    failingSince ??= now()
    failedTicks++
    // The status callback must not turn one failure into two log lines.
    try { onFailed(reason, kind) } catch (e) { log.warn?.(`[faustus-refresher] onFailed threw: ${e?.message || e}`) }
  }
  let intervalHandle = null

  async function tickOnce () {
    if (busy) return
    busy = true
    try {
      // detailByName() when the pricer has it (name ->
      // {chaos,min?,max?,sell?,at?,turnoverC?}), so the traded range, the
      // separated sell-side rates, the HOUR each price was observed in and the
      // chaos turnover of that hour get persisted alongside the price; a pricer
      // that only has chaosByName() (older stub / test double) still works
      // unchanged.
      //
      // `at` and `turnoverC` cannot be recovered later: this tick's timestamp
      // says when the map was written, and the union walk means two prices in
      // the same map can be hours apart (networth/faustus-age.mjs); the
      // turnover is what the Net-Worth "thin market" marker reads
      // (valuator.mjs thinMarket).
      let prices, ranges = null, sell = null, hours = null, turnover = null
      if (typeof pricer.detailByName === 'function') {
        const detail = await pricer.detailByName()
        prices = new Map()
        ranges = new Map()
        sell = new Map()
        hours = new Map()
        turnover = new Map()
        for (const [name, d] of detail) {
          prices.set(name, d.chaos)
          if (typeof d.min === 'number' && typeof d.max === 'number') ranges.set(name, [d.min, d.max])
          if (d.sell) sell.set(name, d.sell)
          if (typeof d.at === 'number') hours.set(name, d.at)
          if (typeof d.turnoverC === 'number') turnover.set(name, d.turnoverC)
        }
      } else {
        prices = await pricer.chaosByName()
      }
      // Nothing priced at all: no market of the digests matched this league (a
      // typo in POE_LEAGUE, or a league that has no trade yet). Replacing the map
      // with an empty one would stamp "nothing" as fresh without a word, so the
      // last good store stays. It cannot leak into another league: the valuator
      // ignores a store whose league differs from its own (fromFaustus).
      const priced = prices instanceof Map ? prices.size : Object.keys(prices || {}).length
      if (priced === 0) {
        log.warn?.(`[faustus-refresher] no market matched league=${league} in the digest window — keeping the previous store`)
        noteFailure(`no market matched league=${league} in the digest window`, 'rejected')
        return
      }
      await store.setPrices(league, prices, now(), ranges, sell, hours, turnover)
      if (failingSince != null) {
        log.warn?.(`[faustus-refresher] refresh succeeded again after ${fmtDuration(now() - failingSince)} (${failedTicks} failed ticks)`)
        failingSince = null
        failedTicks = 0
      }
      onRefreshed(prices)
    } catch (e) {
      log.warn?.(`[faustus-refresher] refresh failed (kept last good map): ${e?.message || e}`)
      noteFailure(String(e?.message || e), kindOf(e))
    } finally {
      busy = false
    }
  }

  function start () {
    if (intervalHandle) clearInterval(intervalHandle)
    intervalHandle = setInterval(() => {
      tickOnce().catch(e => log.error?.(`[faustus-refresher] tick failed: ${e?.message || e}`))
    }, intervalMs)
    intervalHandle.unref?.()
    return intervalHandle
  }

  function stop () {
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null }
  }

  return { start, stop, tickOnce }
}
