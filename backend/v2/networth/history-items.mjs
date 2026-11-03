// Item breakdown of the LAST recorded history point, per user — the sidecar
// that lets a delta survive a container restart.
//
// WHY A SIDECAR AND NOT A FIELD ON THE POINT LINE:
// history.mjs diffs the current item list against the previous point's list.
// That list is big (every distinct item name a user owns, easily a few thousand
// rows). Writing it into every NDJSON line would multiply the series by roughly
// three orders of magnitude — one point per minute over the 15-day retention
// is ~21600 lines per user, so a ~130 KB breakdown per line would land in the
// gigabytes. The
// same breakdown as a single overwritten sidecar costs those ~130 KB ONCE, flat
// forever. Only the newest one is ever needed: the diff never looks further
// back than one point. It also keeps the point line byte-identical to what is
// already on disk, so lines written before this file existed stay readable and
// nothing has to migrate.
//
// File shape (/config/networth-history-items.json):
//   {"v":1,"u":{"<user>":{"at":<epoch ms of that point>,"i":[[name,qty,chaos],…]}}}
//
// `at` is the anchor: history.mjs only adopts an entry when it matches the
// timestamp of that user's newest retained point. A sidecar that ran ahead of
// (or behind) the series — half-written state, a point whose NDJSON append
// failed, retention having dropped the anchor — is therefore dropped instead of
// blaming the wrong interval. Being wrong about which minute an item arrived in
// is worse than having no breakdown at all.
//
// LOADING follows every other /config store (store-file.mjs, docs/bugs.md B27
// and B31). A missing file is the normal first start and stays silent. A file
// that is not JSON, not an object, or has no format number `v` or no `u` map
// is moved to `<name>.broken-<timestamp>` with ONE warning, and the sidecar
// starts empty. A file with a newer `v` (written by a newer release, met after
// a rollback), one that is there but cannot be read, and a broken one that
// cannot be moved are left as they are: the sidecar then runs in memory only
// and never writes over them, whatever writable flag the caller hands down.
// A single malformed user entry or row is dropped on its own. The load never
// throws. Writes are atomic (tmp + rename), so a reader never sees a half
// file. A read-only /config disables the writing side (`writable = false`)
// instead of erroring once a minute.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { jsonErrorSummary } from '../json-error.mjs'
import { moveAside } from '../store-file.mjs'

const FORMAT = 1
let tmpCounter = 0

// What starting without the file costs; ends every warning about it.
const EMPTY_MEANS = 'starting without a breakdown: the next point has no item movers and skips the price guard'

/**
 * createHistoryItems(filePath, { log, now, readFileImpl, renameImpl, writeFileImpl })
 *
 * readFileImpl, renameImpl and writeFileImpl are test seams only: how the file
 * is read (a permission error without chmod or root), how a broken one is
 * moved aside, and how save() writes its tmp file (a full disk without one).
 */
export function createHistoryItems (filePath, {
  log = console,
  now = Date.now,
  readFileImpl = readFile,
  renameImpl = rename,
  writeFileImpl = writeFile
} = {}) {
  // user -> { at:<ms>, items:Map(name -> [qty, chaosTotal]) }
  let entries = new Map()
  // What the caller wants (history.mjs hands its own flag down before every
  // save), and what the load decided: a file this process must not write over.
  let wanted = true
  let keepOff = false
  // Error codes of failed writes already logged (one line per code).
  const writeWarned = new Set()

  const side = {
    get writable () { return wanted && !keepOff },
    set writable (v) { wanted = !!v },
    get path () { return filePath },

    // Reads the file into memory. Losing it is not free: the next point then
    // has no item movers and skips the price guard (both compare against this
    // breakdown), and the guard's memory loses the prices of the names in it
    // (guard-state.mjs leaves those to this file), which is why docs/admin.md
    // backs it up with the series.
    async load () {
      entries = new Map()
      let raw
      try {
        raw = await readFileImpl(filePath, 'utf8')
      } catch (e) {
        // Any error but ENOENT means a file is there that this process never
        // saw: the next point's breakdown must not replace it without a word.
        if (e?.code !== 'ENOENT') {
          keepOff = true
          log.warn?.(`[networth-history-items] could not read ${filePath} (${e?.code || e?.message}) — ${EMPTY_MEANS}, and not writing over it; fix or remove it and restart`)
        }
        return entries
      }
      let doc = null
      let reason = null
      try {
        doc = JSON.parse(raw)
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a JSON object')
      } catch (e) {
        reason = jsonErrorSummary(e)
      }
      if (!reason && !Number.isInteger(doc.v)) reason = 'no usable format number v'
      if (!reason && doc.v > FORMAT) {
        keepOff = true
        log.warn?.(`[networth-history-items] ${filePath} has format ${doc.v}, newer than the ${FORMAT} this version reads (written by a newer release?) — ${EMPTY_MEANS}, running in memory only and leaving the file untouched; update again to use it, or move it away and restart to start over`)
        return entries
      }
      if (!reason && doc.v < FORMAT) reason = `format ${doc.v} is older than ${FORMAT}`
      if (!reason && (!doc.u || typeof doc.u !== 'object' || Array.isArray(doc.u))) reason = 'u is missing or not an object'
      if (reason) {
        try {
          const to = await moveAside(filePath, { label: 'broken', now, renameImpl })
          log.warn?.(`[networth-history-items] ${filePath} is not usable (${reason}) — moved to ${to}; ${EMPTY_MEANS}`)
        } catch (e) {
          keepOff = true
          log.warn?.(`[networth-history-items] ${filePath} is not usable (${reason}) and could not be moved aside (${e?.code || e?.message}) — ${EMPTY_MEANS}, running in memory only and leaving the file untouched; fix or remove it and restart`)
        }
        return entries
      }
      for (const [user, rec] of Object.entries(doc.u)) {
        if (!user || !rec || typeof rec !== 'object') continue
        if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) continue
        if (!Array.isArray(rec.i)) continue
        const items = new Map()
        for (const row of rec.i) {
          if (!Array.isArray(row)) continue
          const name = typeof row[0] === 'string' ? row[0] : null
          const chaos = Number(row[2])
          if (!name || !Number.isFinite(chaos)) continue
          const qty = Number(row[1])
          items.set(name, [Number.isFinite(qty) ? qty : 0, chaos])
        }
        entries.set(user, { at: rec.at, items })
      }
      return entries
    },

    entries () { return entries },
    get (user) { return entries.get(user) || null },
    set (user, at, items) {
      if (!user || !(items instanceof Map) || !Number.isFinite(Number(at))) return
      entries.set(user, { at: Number(at), items })
    },
    delete (user) { return entries.delete(user) },

    // Atomic full rewrite (tmp + rename), same discipline as store.mjs and
    // history.rewrite(). Returns false when nothing could be written — the
    // caller keeps running either way, it just loses the restart safety net.
    // The answer matters there: only a true lets the guard memory leave the
    // names of this breakdown to the file (history.mjs, persistGuard;
    // docs/bugs.md B34). A failed write is logged once per error code, like a
    // failed write of the guard file: it repeats at every point while the
    // cause lasts, and one line says all there is to say.
    async save () {
      if (!side.writable) return false
      const u = {}
      for (const [user, rec] of entries) {
        u[user] = { at: rec.at, i: [...rec.items].map(([name, v]) => [name, v[0], v[1]]) }
      }
      const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`
      try {
        await writeFileImpl(tmpPath, JSON.stringify({ v: FORMAT, u }), 'utf8')
        await rename(tmpPath, filePath)
        return true
      } catch (e) {
        // Disk hiccup / read-only volume -> drop the durable copy, never take
        // the refresher down over a sidecar whose loss costs one delta.
        await unlink(tmpPath).catch(() => {})
        const code = e?.code || e?.message || String(e)
        if (!writeWarned.has(code)) {
          writeWarned.add(code)
          log.warn?.(`[networth-history-items] could not write ${filePath} (${code}) — the file keeps its previous content; until a write succeeds, a restart finds no breakdown for a newer point (the next point then has no item movers and skips the price guard), and the brake's memory keeps every price itself`)
        }
        return false
      }
    }
  }
  return side
}

// Where the sidecar lives for a given history file: next to it, same base name.
// /config/networth-history.ndjson -> /config/networth-history-items.json
export function defaultItemsPath (historyPath) {
  return String(historyPath).replace(/\.ndjson$/i, '') + '-items.json'
}
