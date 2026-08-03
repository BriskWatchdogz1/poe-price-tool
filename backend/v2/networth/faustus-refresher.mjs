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
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000 // 1h — matches Faustus's own cadence

export function createFaustusRefresher ({
  league,
  store,
  pricer,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => Date.now(),
  onRefreshed = () => {},
  log = console
} = {}) {
  let busy = false // overlap guard: a slow fetch never runs alongside the next tick
  let intervalHandle = null

  async function tickOnce () {
    if (busy) return
    busy = true
    try {
      // detailByName() when the pricer has it (name -> {chaos,min?,max?,sell?}),
      // so the traded range and the separated sell-side rates get persisted
      // alongside the price; a pricer that only has chaosByName() (older stub /
      // test double) still works unchanged.
      let prices, ranges = null, sell = null
      if (typeof pricer.detailByName === 'function') {
        const detail = await pricer.detailByName()
        prices = new Map()
        ranges = new Map()
        sell = new Map()
        for (const [name, d] of detail) {
          prices.set(name, d.chaos)
          if (typeof d.min === 'number' && typeof d.max === 'number') ranges.set(name, [d.min, d.max])
          if (d.sell) sell.set(name, d.sell)
        }
      } else {
        prices = await pricer.chaosByName()
      }
      await store.setPrices(league, prices, now(), ranges, sell)
      onRefreshed(prices)
    } catch (e) {
      log.warn?.(`[faustus-refresher] refresh failed (kept last good map): ${e?.message || e}`)
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
