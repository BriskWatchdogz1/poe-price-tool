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
// ROBUSTNESS, same discipline as the rest of /config: missing/empty/corrupt
// file -> start empty, never throw. Writes are atomic (tmp + rename), so a
// reader never sees a half file. A read-only /config disables the writing side
// silently (`writable = false`) instead of erroring once a minute.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'

const FORMAT = 1
let tmpCounter = 0

export function createHistoryItems (filePath) {
  // user -> { at:<ms>, items:Map(name -> [qty, chaosTotal]) }
  let entries = new Map()

  const side = {
    writable: true,
    get path () { return filePath },

    // Reads the file into memory. Anything unparsable or structurally wrong is
    // treated as "no sidecar yet" — this is a convenience cache, not a backup.
    async load () {
      entries = new Map()
      let raw
      try {
        raw = await readFile(filePath, 'utf8')
      } catch {
        return entries // ENOENT or unreadable -> start fresh
      }
      let doc
      try { doc = JSON.parse(raw) } catch { return entries }
      const users = doc && typeof doc === 'object' ? doc.u : null
      if (!users || typeof users !== 'object') return entries
      for (const [user, rec] of Object.entries(users)) {
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
    async save () {
      if (!side.writable) return false
      const u = {}
      for (const [user, rec] of entries) {
        u[user] = { at: rec.at, i: [...rec.items].map(([name, v]) => [name, v[0], v[1]]) }
      }
      const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`
      try {
        await writeFile(tmpPath, JSON.stringify({ v: FORMAT, u }), 'utf8')
        await rename(tmpPath, filePath)
        return true
      } catch {
        // Disk hiccup / read-only volume -> drop the durable copy, never take
        // the refresher down over a convenience cache.
        await unlink(tmpPath).catch(() => {})
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
