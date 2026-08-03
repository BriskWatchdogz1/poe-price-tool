// Persists the Faustus-derived name->chaos map (Task 2's `chaosByName()`
// OUTPUT), not the raw hourly digests — that's the whole point: GGG deletes
// old Faustus history, so this store is what lets valuation (Task 4) work
// immediately on boot, before the hourly refresher's first successful tick.
// Atomic save (tmp+rename with a unique tmp name per writer), ENOENT-tolerant
// load, corrupt/old-schema-tolerant (rebuildable cache, never a backup) — 1:1
// the discipline from networth/store.mjs.
//
// Shape (/config/faustus-store.json):
//   { schema_version: 1, updatedAt: <ms epoch|null>, league: <string|null>,
//     prices: { "<name>": <chaos:number> },
//     ranges?: { "<name>": [min, max] },    // chaos per piece, OPTIONAL
//     sell?:   { "<name>": { c?: [perItem, volX, volQuote],
//                            d?: [perItem, volX, volQuote] } } } // OPTIONAL
//
// `ranges` and `sell` are deliberately NOT schema bumps: they are purely
// additive and a file written before they existed must keep loading (it then
// simply has no ranges/sell until the next refresh tick), and a downgrade must
// not wipe the prices. `sell` mirrors the pricer's per-market sell rates
// (faustus.mjs detail.sell): chaos (`c`) and divine (`d`) side kept separate,
// each rate in quote units per item plus the matched volumes on both sides —
// consumed by sell-side.mjs for the reference rail's "sell vs c or vs div"
// comparison.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'

const SCHEMA_VERSION = 1

function emptyStore () {
  return { schema_version: SCHEMA_VERSION, updatedAt: null, league: null, prices: {}, ranges: {}, sell: {} }
}

// One persisted sell side ([perItem, volX, volQuote]) from a pricer-side
// object ({ perItem, volX, volQuote }) — or null when the rate is unusable.
// Volumes default to 0 (evidence "none"), never invented.
function packSellSide (s) {
  const perItem = s?.perItem
  if (typeof perItem !== 'number' || !isFinite(perItem) || perItem <= 0) return null
  const vol = v => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0
  return [perItem, vol(s.volX), vol(s.volQuote)]
}

function unpackSellSide (a) {
  if (!Array.isArray(a)) return null
  const [perItem, volX, volQuote] = a
  if (typeof perItem !== 'number' || !isFinite(perItem) || perItem <= 0) return null
  return {
    perItem,
    volX: (typeof volX === 'number' && isFinite(volX) && volX >= 0) ? volX : 0,
    volQuote: (typeof volQuote === 'number' && isFinite(volQuote) && volQuote >= 0) ? volQuote : 0
  }
}

let tmpCounter = 0

export function createFaustusStore (filePath) {
  const store = {
    data: emptyStore(),
    // Flipped to false by the server when /config isn't writable (e.g. a
    // local run without the volume) -> setPrices()/save() become no-ops
    // instead of throwing on every refresh tick.
    writable: true,

    async load () {
      let raw
      try {
        raw = await readFile(filePath, 'utf8')
      } catch (err) {
        if (err.code === 'ENOENT') { store.data = emptyStore(); return }
        throw err
      }
      let parsed
      try { parsed = JSON.parse(raw) } catch { store.data = emptyStore(); return }
      if (!parsed || parsed.schema_version !== SCHEMA_VERSION ||
          typeof parsed.prices !== 'object' || parsed.prices === null) {
        store.data = emptyStore(); return
      }
      store.data = parsed
    },

    async save () {
      const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`
      try {
        await writeFile(tmpPath, JSON.stringify(store.data, null, 2), 'utf8')
        await rename(tmpPath, filePath)
      } catch (err) {
        await unlink(tmpPath).catch(() => {})
        throw err
      }
    },

    // Replaces the whole map with a fresh `chaosByName()` result (Map or
    // plain object both accepted) and stamps updatedAt -> isFresh() can gate
    // the refresher/valuator. Persists immediately (mirrors store.mjs's
    // setTab), so a crash right after a tick never loses the last good fetch.
    // Non-finite/non-number entries are dropped defensively (never persist a
    // NaN/Infinity that would silently corrupt a later valuation).
    //
    // `ranges` (optional, Map or object of name -> [min, max] or {min, max})
    // carries the hour's traded chaos range per item. Same defensive filter:
    // only two finite numbers with min < max survive; omitting the argument
    // simply stores no ranges.
    //
    // `sell` (optional, Map or object of name -> { chaos?, divine? } as
    // produced by faustus.mjs detail.sell) carries the separated per-market
    // sell rates + volumes. Same discipline: defensively validated, omitting
    // the argument simply stores no sell data.
    async setPrices (league, prices, now = Date.now(), ranges = null, sell = null) {
      const obj = {}
      const entries = prices instanceof Map ? prices.entries() : Object.entries(prices || {})
      for (const [name, chaos] of entries) {
        if (typeof chaos === 'number' && isFinite(chaos)) obj[name] = chaos
      }
      const rng = {}
      const rEntries = ranges instanceof Map ? ranges.entries() : Object.entries(ranges || {})
      for (const [name, r] of rEntries) {
        const min = Array.isArray(r) ? r[0] : r?.min
        const max = Array.isArray(r) ? r[1] : r?.max
        if (typeof min === 'number' && isFinite(min) && typeof max === 'number' && isFinite(max) &&
            min < max) rng[name] = [min, max]
      }
      const sl = {}
      const sEntries = sell instanceof Map ? sell.entries() : Object.entries(sell || {})
      for (const [name, s] of sEntries) {
        const c = packSellSide(s?.chaos)
        const d = packSellSide(s?.divine)
        if (!c && !d) continue
        const rec = {}
        if (c) rec.c = c
        if (d) rec.d = d
        sl[name] = rec
      }
      store.data = { schema_version: SCHEMA_VERSION, updatedAt: now, league, prices: obj, ranges: rng, sell: sl }
      if (store.writable) await store.save()
    },

    getPrice (name) {
      const v = store.data.prices[name]
      return typeof v === 'number' ? v : null
    },

    // { min, max } for a name, or null — including for every file written
    // before `ranges` existed (then there simply is no ranges object).
    getRange (name) {
      const r = store.data.ranges?.[name]
      const min = Array.isArray(r) ? r[0] : r?.min
      const max = Array.isArray(r) ? r[1] : r?.max
      if (typeof min !== 'number' || !isFinite(min)) return null
      if (typeof max !== 'number' || !isFinite(max)) return null
      return { min, max }
    },

    // Separated sell rates for a name: { chaos: {perItem,volX,volQuote}|null,
    // divine: {...}|null } — or null when the name has none, including for
    // every file written before `sell` existed.
    getSell (name) {
      const rec = store.data.sell?.[name]
      if (!rec || typeof rec !== 'object') return null
      const chaos = unpackSellSide(rec.c)
      const divine = unpackSellSide(rec.d)
      if (!chaos && !divine) return null
      return { chaos, divine }
    },

    // Shallow copy — callers must not mutate the store's internal map.
    allPrices () {
      return { ...store.data.prices }
    },

    league () {
      return store.data.league
    },

    updatedAt () {
      return store.data.updatedAt
    },

    isFresh (ttlMs, now = Date.now()) {
      if (typeof store.data.updatedAt !== 'number') return false
      return (now - store.data.updatedAt) < ttlMs
    }
  }
  return store
}
