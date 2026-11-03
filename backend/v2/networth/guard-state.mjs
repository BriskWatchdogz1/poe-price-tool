// The price guard's memory across restarts — the file next to the series.
// Without it a restart forgets every running hold of the implausible-price
// brake (price-guard.mjs), every price it accepted for a name that has since
// left the stash, and the last C:D rate: an absent name re-enters through the
// arrival bar alone and a running hold starts its window over (docs/bugs.md
// B1).
//
// WHAT: exactly what the history-items sidecar does not carry (price-guard.mjs,
// exportState): every running hold, the newest C:D rate, and remembered prices
// only for names not in the last recorded point with a price; importState puts
// the rest back from the sidecar. Normally a few dozen rows; when the sidecar
// was not written at that point (left alone, or its write failed), the file
// carries every name (history.mjs, persistGuard).
//
// File shape (/config/networth-history-guard.json, derived from the series
// path like the sidecar, no setting of its own):
//   { "schema_version": 1, "savedAt": <ms>, "league": "<POE_LEAGUE>",
//     "ratio": [<chaos per divine>, <ms>] | null,
//     "users": { "<user>": { "held":  [[name, since, seen, price]],
//                            "known": [[name, at, price]] } },
//     "stale": { "<user>": <at> } }            (only while there is one)
// No account name; `user` is the same local routing name the series uses.
// `stale` names items-sidecar entries still on disk although a change of stash
// tabs dropped them, because the sidecar write there failed; the next start
// leaves exactly those out (history.mjs, loadLastItems; docs/bugs.md B35). It
// rides here because this file is written right after the sidecar. Optional, so
// no new schema version: an older release ignores it.
//
// WRITTEN right after the sidecar (history.mjs): after a recorded point, and
// when a change in the set of stash tabs drops a user's breakdown from the
// sidecar (a failed sidecar write there adds a `stale` mark) — only when the
// content changed (rows sorted: an unchanged memory is the same bytes). It
// changes when a hold starts or ends, at almost every point while a hold runs
// (`seen` moves), when a name enters or leaves the remembered prices, and when
// the C:D rate changes; the rate's time alone moves only every half hold window
// (price-guard.mjs, ratioMark). Atomic (tmp + rename). Overlapping saves
// (server.mjs does not await append, and users overlap) fold into one
// follow-up write with the newest state.
//
// EXPIRY is the guard's own (importState): what apply() would have aged out by
// now is not restored, and the downtime counts as blind for a running hold,
// like a point without a price. A file of another league is ignored with one
// line and replaced by the next save (no manual step on a league switch); the
// load says so (`foreignLeague`), and the caller then leaves out the items
// sidecar's prices too, since the sidecar records no league (history.mjs,
// restoreGuard). LOADING follows every other /config store (store-file.mjs): a
// broken file is moved to `.broken-<stamp>` with one warning and the guard
// starts empty; a file from a newer release is left alone and the memory stays
// in the process (writable = false).
import { writeFile, rename, unlink } from 'node:fs/promises'
import { loadVersionedJson } from '../store-file.mjs'

export const GUARD_STATE_SCHEMA = 1

let tmpCounter = 0

/** `networth-history.ndjson` -> `networth-history-guard.json`, the sidecar's rule. */
export function defaultGuardStatePath (historyPath) {
  return String(historyPath).replace(/\.ndjson$/i, '') + '-guard.json'
}

/**
 * createGuardStateFile(filePath, { league, log, now, writeImpl, renameImpl })
 *   -> { path, writable, foreignLeague, async load () -> doc | null, async save (exportFn) -> boolean }
 *
 * load() returns the parsed document, or null for "start with an empty
 * memory" (missing, moved aside, newer, another league). After a load that met
 * a file of another league, `foreignLeague` is true. It throws only what
 * loadVersionedJson throws: a read error other than ENOENT — and then the file
 * is not written over (writable = false).
 * save(exportFn) calls exportFn() for the state to write (the guard's
 * exportState) and returns true when it wrote. A write error is thrown.
 */
export function createGuardStateFile (filePath, {
  league = null,
  log = console,
  now = Date.now,
  writeImpl = writeFile,
  renameImpl = rename
} = {}) {
  let lastKey = null
  let running = false
  let pending = null

  const keyOf = s => JSON.stringify({ league, ratio: s?.ratio ?? null, users: s?.users ?? {}, stale: s?.stale ?? null })

  async function writeOnce (exportFn) {
    if (!file.writable) return false
    const s = exportFn()
    const key = keyOf(s)
    if (key === lastKey) return false
    const doc = { schema_version: GUARD_STATE_SCHEMA, savedAt: now(), league, ratio: s?.ratio ?? null, users: s?.users ?? {} }
    // Only when there is a stale entry: a file without one stays the bytes it
    // always was, and an older release reads either (it ignores the field).
    if (s?.stale) doc.stale = s.stale
    const body = JSON.stringify(doc)
    const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`
    try {
      await writeImpl(tmpPath, body, 'utf8')
      await renameImpl(tmpPath, filePath)
    } catch (err) {
      await unlink(tmpPath).catch(() => {})
      throw err
    }
    lastKey = key
    return true
  }

  const file = {
    get path () { return filePath },
    // Only ever set to false (by a load that met a newer, unmovable or
    // unreadable file).
    writable: true,
    // Set by load(): the file on disk belonged to another league.
    foreignLeague: false,

    async load () {
      file.foreignLeague = false
      let r
      try {
        r = await loadVersionedJson(filePath, {
          tag: 'networth-guard',
          schemaVersion: GUARD_STATE_SCHEMA,
          shapeProblem: d => (d.users && typeof d.users === 'object' && !Array.isArray(d.users)) ? null : 'users is missing or not an object',
          emptyMeans: 'starting with an empty memory: the price guard judges from the next recorded point as after a first start',
          log,
          now
        })
      } catch (err) {
        // There, but not readable (owner, mode): never written over, like
        // every other /config file (store-file.mjs). The caller logs it.
        file.writable = false
        throw err
      }
      if (!r.writable) file.writable = false
      const doc = r.data
      if (!doc) return null
      if (typeof league === 'string' && typeof doc.league === 'string' && doc.league !== league) {
        log.warn?.(`[networth-guard] ${filePath} is from league "${doc.league}", not "${league}" — starting with an empty memory; the file is replaced with the next save`)
        file.foreignLeague = true
        return null
      }
      // What is on disk is what a save of the same memory would write: no
      // rewrite until something changes.
      lastKey = keyOf(doc)
      return doc
    },

    async save (exportFn) {
      if (running) { pending = exportFn; return false }
      running = true
      try {
        let wrote = false
        let fn = exportFn
        while (fn) {
          pending = null
          if (await writeOnce(fn)) wrote = true
          fn = pending
        }
        return wrote
      } finally {
        running = false
        pending = null
      }
    }
  }
  return file
}
