// Reference rail history — our OWN price series behind the rail's sparklines,
// in exactly the unit that stands next to the line. Not poe.ninja's
// `sparkline`: it is not consistently oriented. Measured against poe.ninja's
// own charts (Allflame, 24.-28.07.2026) the `divine` row moves with the CHAOS
// value (+150%, API totalChange +133.7%) while `vivid-lifeforce` moves with the
// value in DIVINE (-42.1%, while its chaos value went UP by 44.7%), and the
// response does not say which is which.
//
// Line shape (/config/reference-history.ndjson), NDJSON, append-only:
//   {"lg":"<league>","at":<epoch ms>,"cd":<chaos per divine>,
//    "v":{"<row key>":<chaos per ONE unit>},"ob":{"<feed>":<epoch ms>}}
//
//   ob (optional) says when the answer behind each FEED in the point was
//   fetched: the poe.ninja exchange answer (Mirror), the poe.ninja item
//   overview (beasts), the Faustus store (Sulphur, lifeforce). During an outage
//   a fetcher serves its last good answer, which must not become a NEW point —
//   a flat line that looks like a quiet market (docs/bugs.md B29). So an append
//   names its feeds ({ at, keys }); a feed whose `at` is not newer than the
//   last one recorded for it loses its keys from this point, and the other
//   feeds are written as usual (one feed down must not freeze the rows whose
//   source still runs). Keys that belong to no feed are always written. A
//   numeric `ob` (the first form, exchange feed only) is read as
//   {"exchange": ob}.
//
//   v holds the CANONICAL chaos value per unit, never the formatted display
//   number: the rail switches units (lifeforce/Sulphur between "N / c" and
//   "N / div" following the sell-side recommendation, perPieceDisplay in
//   server.mjs; beasts between "N c" and "N div" at 1 divine), and a stored
//   display number would jump at every flip. From chaos value + that moment's
//   `cd`, TODAY's display number is recomputed for EVERY old point.
//   cd is stored per point as in networth/history.mjs: re-deriving an old
//   divine value with today's ratio would fake movement.
//
// Rows come and go (the beast top 5 is re-picked on every refresh); series()
// skips points without an entry for a row instead of drawing a zero.
// ROBUSTNESS: as networth/history.mjs, a missing, empty, truncated or corrupt
// file NEVER throws. This is a rebuildable convenience series.
import { readFile, appendFile, writeFile, rename, unlink } from 'node:fs/promises'

export const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000        // the rail itself is cached >=15min
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000  // 7 days
export const DEFAULT_MAX_POINTS = 30                         // drawn points per sparkline
const COMPACT_EVERY = 24                                     // rewrite check ~every 6h at one point/15min

// Display units a rail row can be rendered in. `chaos` is always the chaos
// value of ONE unit of the row's item; `cd` the chaos-per-divine of the point.
//   c      -> price in chaos          (cheap beasts: "230 c")
//   div    -> price in divine         (Mirror, expensive beasts: "18 div")
//   perC   -> units per chaos         (lifeforce: "44 / c")
//   perDiv -> units per divine        (lifeforce: "3300 / div")
export const UNITS = ['c', 'div', 'perC', 'perDiv']

// One stored chaos value -> the number the rail actually prints, in `unit`.
// Returns null when the point cannot express that unit (no ratio, no price).
export function displayValue (chaos, cd, unit) {
  const v = Number(chaos)
  const ratio = Number(cd)
  if (!Number.isFinite(v) || v <= 0) return null
  switch (unit) {
    case 'c': return v
    case 'div': return ratio > 0 ? v / ratio : null
    case 'perC': return 1 / v
    case 'perDiv': return ratio > 0 ? ratio / v : null
    default: return null
  }
}

// The per-feed answer times of a point; the first, numeric form named the
// exchange feed only.
function obOf (p) {
  if (typeof p.ob === 'number') return { exchange: p.ob }
  return p.ob && typeof p.ob === 'object' ? p.ob : {}
}

let tmpCounter = 0

export function createReferenceHistory (filePath, {
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  retentionMs = DEFAULT_RETENTION_MS,
  maxPoints = DEFAULT_MAX_POINTS,
  now = () => Date.now()
} = {}) {
  // In-memory mirror of the retained lines, ascending by `at`.
  let points = []
  let appendsSinceCompact = 0

  const hist = {
    // Server flips this to false when /config isn't writable (local run) ->
    // append stays in-memory instead of throwing on every refresh.
    writable: true,

    get points () { return points },

    async load () {
      let raw
      try {
        raw = await readFile(filePath, 'utf8')
      } catch {
        points = []; return // ENOENT or unreadable -> start fresh, never crash
      }
      const cutoff = now() - retentionMs
      const out = []
      for (const line of String(raw).split('\n')) {
        const s = line.trim()
        if (!s) continue
        let p
        try { p = JSON.parse(s) } catch { continue } // corrupt/half-written line -> skip
        if (!p || typeof p.at !== 'number' || typeof p.lg !== 'string') continue
        if (!p.v || typeof p.v !== 'object') continue
        if (p.at < cutoff) continue
        out.push(p)
      }
      out.sort((a, b) => a.at - b.at)
      points = out
    },

    // Last stored timestamp for a league (throttle + tests).
    lastAt (league) {
      for (let i = points.length - 1; i >= 0; i--) if (points[i].lg === league) return points[i].at
      return null
    },

    // When the answer of `feed` behind the newest point that carries that
    // feed was fetched. Points without it are skipped: a point written while
    // the feed had nothing (or only stale data) says nothing about it.
    lastObservedAt (league, feed = 'exchange') {
      for (let i = points.length - 1; i >= 0; i--) {
        if (points[i].lg !== league) continue
        const t = obOf(points[i])[feed]
        if (typeof t === 'number') return t
      }
      return null
    },

    // Appends ONE point holding EVERY rail row of this refresh, unless the last
    // point for this league is younger than minIntervalMs. `feeds` maps a feed
    // name to { at, keys }: the time of the answer behind those keys (see `ob`
    // above). Returns true when a point was actually recorded. Never throws (a
    // disk hiccup costs the durable write, not the rail).
    async append (league, { cdRatio, values, feeds } = {}) {
      if (!league || !values || typeof values !== 'object') return false
      const at = now()
      const last = hist.lastAt(league)
      if (last != null && (at - last) < minIntervalMs) return false

      const v = {}
      for (const [key, chaos] of Object.entries(values)) {
        const n = Number(chaos)
        if (Number.isFinite(n) && n > 0) v[key] = n
      }
      // The same answer of a feed is not a new point for ITS rows (see `ob`).
      const ob = {}
      for (const [feed, f] of Object.entries(feeds || {})) {
        if (!f || typeof f.at !== 'number' || !Array.isArray(f.keys)) continue
        const lastOb = hist.lastObservedAt(league, feed)
        if (lastOb != null && f.at <= lastOb) {
          for (const k of f.keys) delete v[k]
        } else if (f.keys.some(k => k in v)) {
          ob[feed] = f.at
        }
      }
      if (!Object.keys(v).length) return false

      const ratio = Number(cdRatio)
      const point = { lg: league, at, cd: ratio > 0 ? ratio : 0, v, ...(Object.keys(ob).length ? { ob } : {}) }
      points.push(point)

      if (!hist.writable) { hist.prune(); return true }
      try {
        await appendFile(filePath, JSON.stringify(point) + '\n', 'utf8')
      } catch {
        hist.prune(); return true // keep the in-memory series, drop the durable write
      }
      appendsSinceCompact++
      // Rewrite only when retention actually has something to drop AND we've
      // appended a while — not on every single append.
      if (appendsSinceCompact >= COMPACT_EVERY) {
        appendsSinceCompact = 0
        const before = points.length
        hist.prune()
        if (points.length !== before) await hist.rewrite().catch(() => {})
      }
      return true
    },

    // Drops everything older than the retention window (in memory).
    prune (at = now()) {
      const cutoff = at - retentionMs
      if (points.length && points[0].at >= cutoff) return 0
      const before = points.length
      points = points.filter(p => p.at >= cutoff)
      return before - points.length
    },

    // Atomic full rewrite (tmp + rename), same discipline as the other stores.
    async rewrite () {
      const tmpPath = `${filePath}.${process.pid}.${++tmpCounter}.tmp`
      const body = points.map(p => JSON.stringify(p)).join('\n') + (points.length ? '\n' : '')
      try {
        await writeFile(tmpPath, body, 'utf8')
        await rename(tmpPath, filePath)
      } catch (err) {
        await unlink(tmpPath).catch(() => {})
        throw err
      }
    },

    // The drawable series for ONE row, converted into `unit` — the very unit
    // the number beside the line is printed in. Points that don't carry this
    // row (or can't express the unit, e.g. no ratio) are skipped.
    //
    // Fewer than 2 usable points -> [] on purpose: the rail then draws NO line
    // at all rather than a placeholder or an invented series.
    series (league, key, unit, { max = maxPoints } = {}) {
      if (!league || !key || !UNITS.includes(unit)) return []
      const raw = []
      for (const p of points) {
        if (p.lg !== league) continue
        const val = displayValue(p.v?.[key], p.cd, unit)
        if (val == null || !Number.isFinite(val)) continue
        raw.push([p.at, val])
      }
      if (raw.length < 2) return []
      return downsample(raw, max).map(r => r[1])
    }
  }
  return hist
}

// Keeps at most `max` entries of [at, value], evenly spread over TIME (not over
// the index) so a gap in the series stays a gap. The newest entry always
// survives — the line's right edge must be the current value.
export function downsample (list, max) {
  if (!Array.isArray(list) || list.length <= max || max < 2) return list.slice()
  const first = list[0][0]
  const span = list[list.length - 1][0] - first
  if (span <= 0) return [list[list.length - 1]]
  const bucketMs = span / (max - 1)
  const out = []
  let lastBucket = -1
  for (const p of list) {
    const b = Math.floor((p[0] - first) / bucketMs)
    if (b === lastBucket) out[out.length - 1] = p // keep the newest per bucket
    else { out.push(p); lastBucket = b }
  }
  return out
}
