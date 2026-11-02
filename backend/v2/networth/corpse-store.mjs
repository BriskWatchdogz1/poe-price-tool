// Persists itemised-corpse trade prices (name -> { chaos, at }) so a net-worth
// snapshot never re-fires a slow, rate-limited Trade search on every valuation.
// Corpses move slowly -> long TTL (~6h). Caches BOTH prices AND nulls: a name
// that came back with 0 priced listings is stored as `chaos:null` WITH a
// timestamp, so the background pricer treats it as "fresh, leave alone" instead
// of hammering the Trade API for an illiquid corpse every snapshot.
//
// League-guarded like faustus-store: single-league store, a valuator built for a
// different league must not read stale cross-league corpse prices.
//
// Shape (/config/corpse-store.json):
//   { schema_version: 1, updatedAt: <ms|null>, league: <string|null>,
//     entries: { "<name>": { chaos: <number|null>, at: <ms> } } }
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'

const SCHEMA_VERSION = 1
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000 // 6h — corpses move slowly

function emptyStore () {
  return { schema_version: SCHEMA_VERSION, updatedAt: null, league: null, entries: {} }
}

let tmpCounter = 0

export function createCorpseStore (filePath, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const store = {
    data: emptyStore(),
    ttlMs,
    // Flipped to false by the server when /config isn't writable -> setPrice()/
    // save() become no-ops instead of throwing on every pricer tick.
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
          typeof parsed.entries !== 'object' || parsed.entries === null) {
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

    // Store a single corpse price. `chaos` may be a number OR null (0-results /
    // illiquid -> honestly unpriced, but CACHED so we don't re-query). Non-finite
    // values collapse to null (never persist a NaN/Infinity). Persists immediately
    // (mirrors faustus-store.setPrices) so a crash after a tick never loses it.
    async setPrice (league, name, chaos, now = Date.now()) {
      const val = (typeof chaos === 'number' && isFinite(chaos)) ? chaos : null
      // A new league invalidates everything stored: the valuator's guard only
      // compares the single `league` field, so entries left over from the old
      // league would otherwise be served as new-league prices until the TTL ran
      // out. A file without a stored league (legacy) is adopted, not cleared.
      if (store.data.league && store.data.league !== league) store.data.entries = {}
      store.data.entries[name] = { chaos: val, at: now }
      store.data.updatedAt = now
      store.data.league = league
      if (store.writable) await store.save()
    },

    // Raw entry ({ chaos, at }) or null when absent. Lets the pricer distinguish
    // "never priced" from "cached null".
    get (name) {
      return store.data.entries[name] ?? null
    },

    // Fresh chaos price for the valuation route: a number when the entry is fresh
    // AND priced; null when fresh-but-null (illiquid), stale, or absent. The route
    // turns null into an honest "unpriced" for this snapshot; the pricer refills.
    getPrice (name, now = Date.now()) {
      const e = store.data.entries[name]
      if (!e) return null
      if ((now - e.at) >= store.ttlMs) return null
      return typeof e.chaos === 'number' ? e.chaos : null
    },

    // Fresh (within TTL) — used by the pricer to SKIP names that don't need a
    // re-query yet (true for both priced and null-cached entries).
    isFresh (name, now = Date.now()) {
      const e = store.data.entries[name]
      return !!e && (now - e.at) < store.ttlMs
    },

    // Age in ms (Infinity when never priced) — stalest/unpriced-first ordering.
    ageOf (name, now = Date.now()) {
      const e = store.data.entries[name]
      return e ? (now - e.at) : Infinity
    },

    league () {
      return store.data.league
    },

    updatedAt () {
      return store.data.updatedAt
    }
  }
  return store
}
