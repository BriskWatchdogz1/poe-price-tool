// Net-worth history — the time series behind the History page's trend chart.
//
// WHY A SEPARATE FILE (and not networth-store.json):
// the per-tab store is rewritten IN FULL on every single setTab, i.e. every
// ~30s. Parking 48h of points inside it would re-serialize the whole series
// with each tab sync. This file instead is APPEND-ONLY (NDJSON, one point per
// line) and gets rewritten only when retention actually has something to drop.
//
// Line shape (/config/networth-history.ndjson):
//   {"u":"<user>","at":<epoch ms>,"c":<total chaos>,"cd":<chaos per divine>,
//    "d":{...item delta, see below}}
//
//   OLD LINES MAY CARRY MORE. Until the header sparkline was removed, every
//   line also held `t`, a per-tab chaos breakdown — 42% of the line for a field
//   nothing read once that chart was gone. It is no longer written; recorded
//   lines that still have it are read normally (unknown fields are ignored, not
//   a reason to skip a point) and age out with retention. No migration.
//
//   d is OPTIONAL — lines written before this field existed simply have none.
//   Every read path treats a missing d as "no detail recorded", never as an
//   error. The item breakdown the next d is diffed against outlives a restart
//   in a sidecar file (history-items.mjs) instead of only in memory; the point
//   LINE is unchanged by that, so older lines stay readable as they are.
//
//   cd is stored PER POINT on purpose: reconstructing the divine value of an
//   old point with today's ratio would fake movement that never happened.
//
//   AND EVERY READER HAS TO HONOUR IT, which is where this used to fall apart:
//   the field was served (series() as the third column) and then not used —
//   the history page divided every chaos figure it printed by the rate of the
//   NEWEST point, so axis, tooltips, event rows and the window net were all
//   re-valued whenever the rate ticked. events() therefore stamps each bucket
//   with its own `cd` as well, and the page values a point at the rate it was
//   recorded at.
//
// PRIVACY: only the local routing name (`u`, same key the store already uses)
// is written. No accountName, and the POESESSID cookie never comes near this
// module.
//
// ROBUSTNESS: a missing, empty, truncated or corrupt file NEVER throws — this
// is a rebuildable convenience series, not a backup. Unparsable lines are
// skipped individually (a half-written tail line after a hard container kill
// costs exactly one point).
import { readFile, appendFile, writeFile, rename, unlink } from 'node:fs/promises'
import { round1 } from '../ninja.mjs'
import { createHistoryItems, defaultItemsPath } from './history-items.mjs'
import { createPriceGuard, findSpikeRanges } from './price-guard.mjs'

export const DEFAULT_MIN_INTERVAL_MS = 60_000            // at most one point per minute per user
// Longest shown range (14d) plus a day of slack. At one point per minute that
// is ~21600 lines per user; the file stays a few MB and every read path answers
// from the in-memory mirror, so the size costs nothing at query time.
export const DEFAULT_RETENTION_MS = 15 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_POINTS = 180                           // downsample cap per series response

// ---- item deltas ("what caused this jump?") --------------------------------
// Per point we keep the biggest movers since the PREVIOUS point, so a click on
// the chart can answer "what did I put in there?" on item level.
//
//   d = { p:<prev at>, pt:<prev total chaos>, pc:<prev chaos/div>,
//         i: [ [name, qtyDelta, valueDelta, priceShare], ... ],   // top movers
//         r: [ <count of smaller changes>, <their summed chaos> ] }  // optional
//
// QUANTITY vs PRICE is split on purpose — "+3 Divine Orb" and "Divine Orb went
// up 4c" are very different answers to the same jump. Exact decomposition:
//   valueDelta = qtyDelta * pRef + priceShare
//   pRef       = current unit price (the price the NEW units are worth), or the
//                old one when the item is gone entirely (removed units can only
//                be valued at the price they had).
// priceShare is therefore the revaluation of the stock that was already there.
//
// QUANTITY MEANS STOCK, NOT PRICED STOCK. The breakdown the diff runs on holds
// every name that is IN THE STASH — the priced rows with their value, and the
// unpriced names at a value of zero (all of them: the recorder folds the stored
// tabs, not the snapshot's capped display list). Without the second half the
// diff could only see the priced rows, and then an item that merely lost its
// price left that set and read as an item leaving the stash; getting a price
// back read as one arriving. Live case, six hours of an evening nobody played
// (2026-08-14, Allflame): The Card Sharp +3/+12.6c at 09:37 and −3/−12.6c at
// 10:16, Weeping Essence of Contempt +7/+18.8c at 05:37 and −7/−18.8c at 06:16
// — mirror images to the decimal, on an untouched stash. See docs/bugs.md B2.
// With the unpriced names in the map both directions come out as what they are:
// quantity delta 0, the whole value change on the price side.
//
// The remainder `r` is not cosmetic: it is computed as (total delta − shown
// items) so the panel always adds up to the header number. Nothing is silently
// dropped, neither sub-threshold items nor rounding dust.
export const DELTA_TOP_N = 10        // biggest movers kept per point
export const DELTA_MIN_CHAOS = 1     // below this an item goes into the remainder
const DELTA_NOISE_CHAOS = 0.1        // below this a change is not even counted
// A stock movement is worth a row once it is worth about a DIVINE — the value
// the player actually thinks in. The chaos figure is derived per window from
// that window's own C:D rate, so the bar does not silently drift as the rate
// moves. EVENT_MIN_CHAOS is only the fallback when no rate was recorded.
export const EVENT_MIN_CHAOS = 10
export const EVENT_MIN_DIVINE = 1

// Marker spacing per range. Explicit rather than derived: these are the
// densities that read well on the plot — one marker every five minutes on an
// hour, hourly over a day. Anything denser turned the dots into a chain.
export const RANGE_BUCKET_MS = {
  '1h': 5 * 60 * 1000,
  '6h': 15 * 60 * 1000,
  '24h': 60 * 60 * 1000,
  '7d': 6 * 60 * 60 * 1000,
  '14d': 12 * 60 * 60 * 1000
}

const H = 60 * 60 * 1000
export const RANGES = { '1h': H, '6h': 6 * H, '24h': 24 * H, '7d': 7 * 24 * H, '14d': 14 * 24 * H }

let tmpCounter = 0

export function createNetworthHistory (filePath, {
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  retentionMs = DEFAULT_RETENTION_MS,
  maxPoints = DEFAULT_MAX_POINTS,
  itemsPath = null,
  now = () => Date.now(),
  // Implausible-price brake (see price-guard.mjs). Injectable so tests can
  // drive it; `false` disables it entirely.
  priceGuard = undefined
} = {}) {
  const guard = priceGuard === false ? null : (priceGuard || createPriceGuard({ now }))
  // In-memory mirror of the retained lines, ascending by `at`. The file is the
  // durable copy; every read path answers from here.
  let points = []
  let appendsSinceCompact = 0
  // user -> Map(item name -> [qty, chaosTotal]) of the LAST recorded point.
  // Backed by a sidecar file (history-items.mjs) so a restart does not tear a
  // hole into the series: without it the first point after every deploy carried
  // no delta and the click panel had nothing to show for that interval. Only
  // the NEWEST breakdown is kept — the diff never looks further back than one
  // point, and a per-line copy would blow the NDJSON up by ~1000x.
  const lastItems = new Map()
  const itemsFile = createHistoryItems(itemsPath || defaultItemsPath(filePath))

  function lastPointOf (user) {
    for (let i = points.length - 1; i >= 0; i--) if (points[i].u === user) return points[i]
    return null
  }

  // Drops already-recorded price artefacts (see findSpikeRanges). Per user,
  // because the series are independent. Returns how many points went.
  function pruneSpikes () {
    const doomed = new Set()
    for (const user of new Set(points.map(p => p.u))) {
      const mine = points.filter(p => p.u === user)
      for (const r of findSpikeRanges(mine)) {
        for (let k = r.from; k <= r.to; k++) doomed.add(mine[k])
        console.warn('[networth] dropped %d recorded point(s) for %s: net worth jumped to %sc over %d min and fell straight back to %sc — no stock movement explains it',
          r.to - r.from + 1, user, round1(r.peak), Math.round(r.spanMs / 60000), round1(r.base))
      }
    }
    if (!doomed.size) return 0
    points = points.filter(p => !doomed.has(p))
    return doomed.size
  }

  // Restores the per-user item breakdown from the sidecar — but ONLY where it
  // is anchored on the newest retained point of that user. A sidecar that does
  // not line up (its point never made it into the NDJSON, or retention has
  // since dropped it) would make the next delta span two intervals and blame
  // the wrong minute; no breakdown is the better answer there.
  async function loadLastItems () {
    lastItems.clear()
    let stored
    try { stored = await itemsFile.load() } catch { return } // never fatal
    for (const [user, rec] of stored) {
      const anchor = lastPointOf(user)
      if (anchor && rec.at === anchor.at && rec.items.size) lastItems.set(user, rec.items)
      else itemsFile.delete(user)
    }
  }

  const hist = {
    // Server flips this to false when /config isn't writable (local run) ->
    // append becomes an in-memory-only no-op instead of throwing every minute.
    writable: true,

    get points () { return points },
    get itemsPath () { return itemsFile.path },

    async load () {
      let raw
      try {
        raw = await readFile(filePath, 'utf8')
      } catch {
        // ENOENT or unreadable -> start fresh, never crash. No points means no
        // anchor, so a sidecar could not be adopted anyway.
        points = []; lastItems.clear(); return
      }
      const cutoff = now() - retentionMs
      const out = []
      for (const line of String(raw).split('\n')) {
        const s = line.trim()
        if (!s) continue
        let p
        try { p = JSON.parse(s) } catch { continue } // corrupt/half-written line -> skip
        if (!p || typeof p.at !== 'number' || typeof p.c !== 'number' || typeof p.u !== 'string') continue
        if (p.at < cutoff) continue
        out.push(p)
      }
      out.sort((a, b) => a.at - b.at)
      points = out
      // Spikes recorded BEFORE the brake existed are still on disk, and they
      // wreck the chart worse than the numbers: the value axis has to span the
      // peak, so everything real gets flattened against the bottom. Dropping
      // them here (and rewriting the file) makes the cleanup permanent.
      if (guard) {
        const dropped = pruneSpikes()
        if (dropped) await hist.rewrite().catch(() => {})
      }
      await loadLastItems()
    },

    // Last stored timestamp for a user (throttle + tests).
    lastAt (user) {
      const p = lastPointOf(user)
      return p ? p.at : null
    },

    // Appends ONE point unless the last one for this user is younger than
    // minIntervalMs. Returns true when a point was actually recorded.
    //
    // `syncComplete === false` refuses the point outright. The snapshot handed
    // in is the union of whatever the per-tab store happens to hold, and the
    // refresher fills that store ONE TAB PER TICK — so between the moment the
    // store is emptied (a fresh install, or pruneTabs after a tab list that
    // came back short) and the moment the round-robin has been past every live
    // tab, `totalChaos` is a sum over a strict subset of the account. Recorded,
    // that is a dip in the curve that no stock movement explains and that
    // nothing afterwards can tell apart from a real one. Averaging or
    // interpolating it away later would only smear it; the point simply must
    // not be written. Callers that cannot tell (tests, a manual replay) omit
    // the flag and are unaffected.
    // `unpriced` is the list of names that ARE in the stash but carry no price
    // this minute (`{name, count}` where count is PIECES). It never adds a chaos
    // to the point — it exists so the diff can tell "gone" from "still here,
    // just not priced". A caller that omits it gets the old reading, in which
    // the two are the same thing.
    //
    // IT HAS TO BE ALL OF THEM. The snapshot's own `unpriced` is capped at 100
    // names for the page it is drawn on, and a name below that cut reads as gone
    // here exactly as if the list had not been handed in at all — half a proof
    // is not a proof. The server therefore folds the stored tabs uncapped
    // (aggregate.mjs, unpricedStock) instead of forwarding the display list.
    //
    // `tabsChanged === true` says the snapshot was summed over a DIFFERENT SET
    // OF STASH TABS than the one the last point saw — a tab was pruned out of
    // the store, or one the store had never read has just been read for the
    // first time. Neither is a stock movement, and both look exactly like one:
    // every name in the tab appears or disappears at once, at its full stock and
    // its full value. So the point is refused and the previous breakdown is
    // FORGOTTEN, which is the same thing this function already does for a
    // caller that hands in no items at all: the next point is then the first one
    // on the new set and carries no delta, instead of carrying a delta against a
    // stash that was measured differently.
    //
    // It refuses ONE point, not the series: the caller compares against the set
    // it last SAW, so a tab that stays gone is unchanged from the next call on
    // and recording continues (see recordNetworthHistory in server.mjs). This is
    // the same balance `syncComplete` strikes — never stop for ever over a tab
    // that will not come back.
    async append (user, { totalChaos, cdRatio, items, unpriced, tabsChanged, syncComplete } = {}) {
      if (!user || typeof totalChaos !== 'number' || !Number.isFinite(totalChaos)) return false
      if (syncComplete === false) return false
      if (tabsChanged === true) {
        // Before the throttle on purpose: the breakdown has to be dropped even
        // when this call would not have written a point anyway, or the next one
        // a minute later would diff across the change all the same.
        lastItems.delete(user)
        if (itemsFile.delete(user)) {
          // …and out of the sidecar as well, or a restart would adopt it again:
          // it is still anchored on the newest point, which is exactly the test
          // loadLastItems applies. Never fatal — the sidecar can cost a delta,
          // it can never falsify one.
          itemsFile.writable = hist.writable
          await itemsFile.save().catch(() => {})
        }
        return false
      }
      const at = now()
      const last = hist.lastAt(user)
      if (last != null && (at - last) < minIntervalMs) return false

      const point = { u: user, at, c: round1(totalChaos), cd: Number(cdRatio) > 0 ? Number(cdRatio) : 0 }

      // Item delta against the previous point of THIS user. Needs both the
      // previous item breakdown (memory) and the previous point (for the
      // anchor values shown in the panel).
      const prevPoint = lastPointOf(user)
      const prevItems = lastItems.get(user)
      let curItems = items ? foldItems(items, unpriced) : null
      // Brake BEFORE the delta and before the total is used: a corrected item
      // must not appear in the panel as a price move, and the point's total has
      // to match the breakdown it is recorded with (see price-guard.mjs).
      let released = null
      if (guard && curItems && prevItems && prevPoint) {
        // cdRatio: the arrival bar's floor is denominated in divine and needs
        // this point's own rate. sourceOf: which feed priced each name, so a
        // brake that fires says WHERE the number came from instead of leaving
        // the next reader with the dead end the Scavenger night was.
        const g = guard.apply(user, prevItems, curItems, prevPoint.c, {
          cdRatio: point.cd, sourceOf: foldSources(items)
        })
        curItems = g.items
        if (g.adjust !== 0) point.c = round1(point.c + g.adjust)
        for (const n of (g.notes || [])) if (n.released) (released ||= new Set()).add(n.name)
      }
      if (curItems && prevItems && prevPoint) {
        const d = buildDelta(withoutReleased(prevItems, released), curItems, prevPoint, point.c)
        if (d) point.d = d
      }
      // No items handed in -> forget the old breakdown, otherwise the NEXT
      // delta would silently span two intervals and blame the wrong minute.
      if (curItems) { lastItems.set(user, curItems); itemsFile.set(user, at, curItems) }
      else { lastItems.delete(user); itemsFile.delete(user) }

      points.push(point)

      if (!hist.writable) { hist.prune(); return true }
      try {
        await appendFile(filePath, JSON.stringify(point) + '\n', 'utf8')
      } catch {
        // Disk hiccup -> keep the in-memory series, drop the durable write.
        // A trend chart is never worth taking the refresher down.
        hist.prune(); return true
      }
      // Sidecar AFTER the line landed, and never gated on its own success: if
      // it lags behind, the anchor check on the next load simply drops it. The
      // sidecar can only ever cost a delta, never falsify one.
      itemsFile.writable = hist.writable
      await itemsFile.save()
      appendsSinceCompact++
      // Rewrite only when retention has something to drop AND we've appended a
      // while (~hourly at one point/min) — not on every single append.
      if (appendsSinceCompact >= 60) {
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

    // Atomic full rewrite (tmp + rename), same discipline as store.mjs.
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

    // Wire format for the chart — positional per point, because the frontend
    // re-polls this and repeated keys would be most of the payload:
    //
    //   { range, points: [[at, chaos, cd]], coverageMs, retentionMs, total }
    //
    // A fourth column used to carry the per-tab breakdown of `t` for the header
    // sparkline. That chart is gone and no reader was left, so neither the
    // column nor the key dictionary it indexed into is served any more; points
    // recorded with `t` simply contribute their first three values like every
    // other point.
    //
    // coverageMs = how much history exists AT ALL for this user (independent of
    // the requested window), so the frontend can say "collecting data…" instead
    // of drawing a confident line through two points.
    series (user, windowMs, { at = now(), max = maxPoints, range = null } = {}) {
      const mine = points.filter(p => p.u === user)
      const coverageMs = mine.length >= 2 ? (mine[mine.length - 1].at - mine[0].at) : 0
      const from = at - (Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_RETENTION_MS)
      const win = mine.filter(p => p.at >= from)
      const out = downsample(win, max).map(p => [p.at, p.c, p.cd])
      return { range, points: out, coverageMs, retentionMs, total: win.length }
    },

    // Stock movements over a window — the history page's own wire format.
    //
    // The trend panel answers "what was that jump?" for a stretch of line; this
    // answers "what came in and what went out?" for the whole window, and it
    // answers ONLY that: a row counts when its QUANTITY changed. Pure price
    // moves are deliberately dropped — they are what made the old panel a wall
    // of ±2c rows, and they are already in the curve's own height.
    //
    // "Losing a price" is one of those price moves and not a movement of stock,
    // which is why the breakdown the rows are derived from counts unpriced
    // names as stock at zero (see foldItems). Before that, an item whose price
    // flickered off and back on produced a departure and an arrival that were
    // mirror images to the decimal, on a stash nobody had touched.
    //
    // Derived from the stored deltas, so nothing new needs recording. Each
    // stored row is [name, dq, dv, priceShare], where dv - priceShare is the
    // part of the value change the quantity carries — that is what a stock
    // movement is worth.
    //
    //   { range, events: [{ at, from, points, c, cd, items: [[name, dq, chaos]], v }],
    //     total, coverageMs, bucketMs }
    //
    // `v` is the event's summed stock value, the number the list sorts and
    // colours by. Events below EVENT_MIN_CHAOS never make the list.
    //
    // `cd` is the C:D rate OF THAT EVENT, taken from the same point the bucket
    // is stamped with (like `c`). Without it the page had nothing but the
    // newest rate of the series to print a two-week-old movement in divine
    // with, so every historical figure moved with every rate tick — the exact
    // thing storing `cd` per point exists to prevent (see the file header). It
    // is 0 when that point carried no rate; the reader then falls back to the
    // nearest point that has one rather than to "now".
    //
    // BUCKETING: raw points arrive about every 2.5 minutes, so a busy day
    // produced ~100 markers whose dots overlapped into a chain — the "too many
    // click targets" complaint all over again, just with better data behind it.
    // Points are therefore grouped into windows of `bucketMs` (a 48th of the
    // shown range: 30 min at 24h, ~1 min at 1h) and each group becomes ONE
    // event. Grouping happens BEFORE the threshold, so picking a card up and
    // dropping it again inside one bucket cancels out instead of producing two
    // rows that undo each other. `from`/`points` say what a bucket covers.
    events (user, windowMs, { at = now(), range = null, minChaos = null, minDivine = null, bucketMs = null } = {}) {
      const mine = points.filter(p => p.u === user)
      const coverageMs = mine.length >= 2 ? (mine[mine.length - 1].at - mine[0].at) : 0
      const win = Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_RETENTION_MS
      const from = at - win
      const bucket = Number(bucketMs) > 0
        ? Number(bucketMs)
        : (RANGE_BUCKET_MS[range] || Math.max(minIntervalMs, Math.round(win / 48)))
      // The bar is expressed in DIVINE (what the player thinks in) and converted
      // with this window's own newest rate, so it does not drift as the rate
      // moves. `minDivine` = 0 means "show everything that was recorded at all";
      // an explicit `minChaos` still wins for callers that want raw chaos.
      let minValue = Number(minChaos)
      if (!(minValue > 0)) {
        // NOT Number(minDivine) >= 0 alone: Number(null) is 0, so an omitted
        // option would read as "show everything" instead of as "use the default".
        const div = (minDivine == null || !Number.isFinite(Number(minDivine)) || Number(minDivine) < 0)
          ? EVENT_MIN_DIVINE
          : Number(minDivine)
        if (div === 0) {
          minValue = DELTA_NOISE_CHAOS // nothing smaller than this was ever stored
        } else {
          const rate = [...mine].reverse().find(p => p.at >= from && Number(p.cd) > 0)
          minValue = rate ? Number(rate.cd) * div : EVENT_MIN_CHAOS * div
        }
      }
      const buckets = new Map() // bucket index -> { at, from, points, c, sums: Map }
      for (const p of mine) {
        if (p.at < from || !p.d || !Array.isArray(p.d.i)) continue
        // Anchored at NOW, not at the window start: the newest points must fall
        // into one clean bucket, and the raster must not shift under the data
        // every time the window slides forward a minute.
        const key = Math.floor((at - p.at) / bucket)
        let b = buckets.get(key)
        if (!b) { b = { at: p.at, from: p.at, points: 0, c: p.c, cd: p.cd, sums: new Map() }; buckets.set(key, b) }
        b.at = p.at   // the bucket is stamped with its LAST point…
        b.c = p.c     // …and carries the stock as of that point
        b.cd = p.cd   // …and the rate that point was recorded at
        b.points++
        for (const [name, dq, dv, priceShare] of p.d.i) {
          if (!dq) continue
          const chaos = (Number(dv) || 0) - (Number(priceShare) || 0)
          const cur = b.sums.get(name) || [0, 0]
          b.sums.set(name, [cur[0] + dq, cur[1] + chaos])
        }
      }

      const out = []
      for (const b of [...buckets.values()].sort((x, y) => x.at - y.at)) {
        const rows = []
        let v = 0
        for (const [name, [dq, chaos]] of b.sums) {
          const c = round1(chaos)
          if (!dq || Math.abs(c) < minValue) continue
          rows.push([name, dq, c])
          v += c
        }
        if (!rows.length) continue
        rows.sort((x, y) => Math.abs(y[2]) - Math.abs(x[2]))
        out.push({ at: b.at, from: b.from, points: b.points, c: b.c, cd: Number(b.cd) || 0, items: rows, v: round1(v) })
      }
      return { range, events: out, total: out.length, coverageMs, retentionMs, bucketMs: bucket, minChaos: round1(minValue) }
    },

    // Unbucketed per-point movements — kept for tests and any caller that wants
    // the raw resolution.
    rawEvents (user, windowMs, { at = now(), range = null, minChaos = EVENT_MIN_CHAOS } = {}) {
      const mine = points.filter(p => p.u === user)
      const coverageMs = mine.length >= 2 ? (mine[mine.length - 1].at - mine[0].at) : 0
      const from = at - (Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_RETENTION_MS)
      const out = []
      for (const p of mine) {
        if (p.at < from || !p.d || !Array.isArray(p.d.i)) continue
        const rows = []
        let v = 0
        for (const [name, dq, dv, priceShare] of p.d.i) {
          if (!dq) continue // price-only move -> not a stock movement
          const chaos = round1((Number(dv) || 0) - (Number(priceShare) || 0))
          if (Math.abs(chaos) < minChaos) continue
          rows.push([name, dq, chaos])
          v += chaos
        }
        if (rows.length) {
          rows.sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]))
          out.push({ at: p.at, c: p.c, items: rows, v: round1(v) })
        }
      }
      return { range, events: out, total: out.length, coverageMs, retentionMs }
    },

    // Item detail for ONE chart interval — the answer to "what was that jump?".
    //
    // WHY AN INTERVAL AND NOT A POINT: series() downsamples to <=180 points, so
    // a drawn point can stand for several recorded minutes. The frontend sends
    // the timestamps of the clicked point and its drawn PREDECESSOR; everything
    // recorded in (from, to] is merged here. That makes the panel match exactly
    // the stretch of line the click covers, at any range, with no client-side
    // guessing about bucket boundaries — and it keeps the polled series payload
    // free of per-point item lists.
    //
    // Returns null when nothing at all is recorded in the interval.
    detail (user, from, to) {
      const a = Number(from); const b = Number(to)
      if (!user || !Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
      const raw = points.filter(p => p.u === user && p.at > a && p.at <= b)
      if (!raw.length) return null
      const withD = raw.filter(p => p.d && Array.isArray(p.d.i))
      const end = raw[raw.length - 1]
      const base = {
        from: a, to: end.at, points: raw.length, recorded: withD.length,
        chaosTo: end.c, rateTo: end.cd
      }
      // Old lines from before the delta field, or a point that genuinely has no
      // predecessor: say so instead of showing an empty item list. `start`
      // separates the two as far as the data allows — when the clicked interval
      // contains the OLDEST retained point of this user there is nothing to
      // compare against by definition, which is a different sentence in the UI
      // than "the previous breakdown was not recorded".
      if (!withD.length) {
        const oldest = points.find(p => p.u === user)
        return {
          ...base,
          items: [],
          rest: null,
          detail: false,
          start: !!(oldest && oldest.at === raw[0].at)
        }
      }

      const anchor = withD[0].d
      const merged = mergeDeltas(withD.map(p => p.d), end.c)
      return {
        ...base,
        from: Number.isFinite(anchor.p) ? anchor.p : a,
        chaosFrom: anchor.pt,
        rateFrom: anchor.pc,
        total: round1(end.c - (Number(anchor.pt) || 0)),
        partial: withD.length !== raw.length,
        detail: true,
        items: merged.items,
        rest: merged.rest,
        unexplained: merged.unexplained
      }
    }
  }
  return hist
}

// Did the set of stash tabs a user's snapshot is summed over change since the
// last time this was asked? That is the question `append({ tabsChanged })`
// needs answered, and it lives here rather than in the caller so the recorder
// and its tests read the same rule out of one place.
//
// WHY THE SNAPSHOT'S OWN TABS AND NOT THE REFRESHER'S COVERAGE FLAG: coverage
// is counted over the LIVE tab list, and both ways a tab can leave the snapshot
// take it out of that list in the same moment — `pruneTabs` deletes stored tabs
// precisely because the live list no longer names them. So coverage reads
// `complete` straight across the change it would have to catch. The snapshot
// knows which tabs its total was built from; that is the set worth comparing.
//
// ASKED, NOT RECORDED. The memory is updated on every call, including the ones
// whose point is refused: the question is "is this different from last time",
// and a difference that persists has to be answered ONCE and then be over.
// Otherwise a tab deleted in game — or one that never becomes readable — would
// stop the series for good, which is the failure mode this whole gate has to
// avoid more than it has to avoid a wrong delta.
export function createTabSetWatch () {
  const seen = new Map()
  const sizeOf = sig => (sig ? sig.split(',').length : 0)
  return {
    look (user, snap) {
      const sig = (snap?.tabs || []).map(t => t.index).sort((a, b) => a - b).join(',')
      const prev = seen.get(user)
      seen.set(user, sig)
      return {
        changed: prev !== undefined && prev !== sig,
        tabs: sizeOf(sig),
        before: prev === undefined ? null : sizeOf(prev)
      }
    }
  }
}

// items[] (snapshot rows: {name, qty, chaosTotal}) + unpriced[] ({name, count},
// the stored tabs' uncapped fold) -> Map(name -> [qty, chaos]).
//
// Rows of the same item in several tabs / at several prices collapse into one
// entry: the player asks "what came in", not "in which tab did it land".
//
// UNPRICED NAMES BELONG IN HERE, at a value of zero. They are stock — the
// player owns them, they are in the stash, and the only thing missing is a
// number for them. Leaving them out made the map a list of PRICED items, and a
// diff of two such lists cannot tell an item that left from one whose price
// went away (see the header). Zero is the honest value: the same "unpriced
// never enters the sum as 0" rule aggregate.mjs states, read the other way
// round — it contributes nothing to any total, and it is not silently absent.
//
// A name that is priced in one tab and unpriced in another lands in one entry
// with the pieces of both and only the value of the priced ones, so its unit
// price comes out averaged over the whole stock. That is the one case this
// fold cannot separate; it needs a name whose valuation route answers for one
// stash entry and not for another, which no route does today.
export function foldItems (items, unpriced) {
  const map = new Map()
  if (Array.isArray(items)) {
    for (const it of items) {
      const name = it && typeof it.name === 'string' ? it.name : null
      if (!name) continue
      const q = Number(it.qty)
      const v = Number(it.chaosTotal)
      if (!Number.isFinite(v)) continue
      const cur = map.get(name) || [0, 0]
      cur[0] += Number.isFinite(q) ? q : 0
      cur[1] += v
      map.set(name, cur)
    }
  }
  if (Array.isArray(unpriced)) {
    for (const u of unpriced) {
      const name = u && typeof u.name === 'string' ? u.name : null
      if (!name) continue
      // `count` is PIECES, the same unit `qty` carries on a priced row.
      const q = Number(u.count)
      const cur = map.get(name) || [0, 0]
      cur[0] += Number.isFinite(q) && q > 0 ? q : 0
      map.set(name, cur)
    }
  }
  return map
}

// items[] -> Map(name -> price source), for the price guard's log line only.
// Never stored: this is about being able to say "that number came from Faustus"
// while the incident is still on screen, not about keeping a second series.
// A name valued from several tabs normally shares one source; when it does not,
// all of them are named (sorted, so the line is stable) rather than one picked.
export function foldSources (items) {
  const seen = new Map()
  if (!Array.isArray(items)) return new Map()
  for (const it of items) {
    const name = it && typeof it.name === 'string' ? it.name : null
    const src = it && typeof it.source === 'string' && it.source ? it.source : null
    if (!name || !src) continue
    const set = seen.get(name) || new Set()
    set.add(src)
    seen.set(name, set)
  }
  return new Map([...seen].map(([name, set]) => [name, [...set].sort().join('+')]))
}

// The previous breakdown AS THE SERIES KNEW IT, for the names the price guard
// has just released (its notes carry `released`).
//
// A withheld arrival stands in the recorded points at NO value while its hold
// lasts (price-guard.mjs), so the previous breakdown holds it at 0. Diffed
// straight, the acceptance therefore reads as `dv` with `dq === 0`: a pure
// price move on stock that was already there. It was not already there — not as
// far as this series is concerned, which counted nothing for it — and booking
// it that way costs twice over:
//
//   - events() drops rows without a quantity change (they are in the curve's
//     own height), so a find worth twenty divine appears in no list at all and
//     then jumps into the trend line unexplained; and
//   - stockMove() reads the same row as "no stock moved", which is the single
//     condition findSpikeRanges uses to tell an artefact from real wealth. A
//     find that is picked up, released, and traded away again inside the spike
//     window is then deleted from the history as a price artefact — the brake
//     poisoning the evidence its own cleanup runs on.
//
// So the name is diffed against "not there": quantity delta = the whole stock,
// value delta = its whole value, price share = 0. An inflow, stamped at the
// point where the series could first count it. Nothing else about the point
// changes, and the remainder still adds up to the header number, because
// packDelta derives it from the point's own total.
//
// AND THIS IS NOT THE SAME CASE as an item that merely lost its price, even
// though both stand in the previous breakdown at a value of zero. The
// difference is not in the map, it is in what happened: a withheld arrival
// ENTERED the stash and was only valued late, so its acceptance is a stock
// movement the series owes the player. An item whose price went away never
// went anywhere. Which of the two a zero is, is decided by the guard's own
// `released` notes and by nothing that could be read back out of the value —
// that is why `apply` reports a release it corrects nothing for.
function withoutReleased (prevMap, released) {
  if (!released || !released.size) return prevMap
  const out = new Map(prevMap)
  for (const name of released) out.delete(name)
  return out
}

// Diff of two folded item maps -> the stored `d` object. `curTotal` is the
// point's own (rounded) total, so the remainder can be derived from the very
// number the header shows instead of from a re-summed float.
export function buildDelta (prevMap, curMap, prevPoint, curTotal) {
  if (!(prevMap instanceof Map) || !(curMap instanceof Map) || !prevPoint) return null
  const rows = []
  for (const name of new Set([...prevMap.keys(), ...curMap.keys()])) {
    const [q0, v0] = prevMap.get(name) || [0, 0]
    const [q1, v1] = curMap.get(name) || [0, 0]
    const dv = v1 - v0
    const dq = q1 - q0
    if (Math.abs(dv) < DELTA_NOISE_CHAOS && dq === 0) continue
    // Unit price the quantity change is valued at: today's, unless the item is
    // gone from the stash (then the units can only be valued at the price they
    // had). An item that is still there but has no price today has a `pRef` of
    // ZERO — v1 is 0 over a positive q1 — which is what puts the whole value
    // change on the price side and keeps it out of the events list. That is the
    // point: nothing moved, the tool just stopped being able to say what it is
    // worth.
    const pRef = q1 > 0 ? v1 / q1 : (q0 > 0 ? v0 / q0 : 0)
    const priceShare = dv - dq * pRef
    rows.push([name, round1(dq), round1(dv), round1(priceShare)])
  }
  return packDelta(rows, prevPoint, curTotal)
}

// Shared tail of buildDelta/mergeDeltas: sort by impact, keep the top N above
// the threshold, fold everything else into the remainder so
// sum(kept) + remainder == total delta, exactly.
function packDelta (rows, prevPoint, curTotal) {
  rows.sort((x, y) => Math.abs(y[2]) - Math.abs(x[2]))
  const keep = []
  let restCount = 0
  for (const r of rows) {
    if (keep.length < DELTA_TOP_N && Math.abs(r[2]) >= DELTA_MIN_CHAOS) keep.push(r)
    else if (Math.abs(r[2]) >= DELTA_NOISE_CHAOS) restCount++
  }
  const total = round1((Number(curTotal) || 0) - (Number(prevPoint.c) || 0))
  const shown = keep.reduce((s, r) => s + r[2], 0)
  const restValue = round1(total - shown)
  const d = { p: prevPoint.at, pt: prevPoint.c, pc: prevPoint.cd, i: keep }
  if (restCount > 0 || Math.abs(restValue) >= DELTA_MIN_CHAOS) d.r = [restCount, restValue]
  return d
}

// Chains several consecutive stored deltas into one. Value and quantity deltas
// are additive over consecutive intervals, and so is the price share (each
// interval revalues the stock it actually held), so the merge is a plain sum
// per item — followed by a fresh top-N cut, because the biggest mover over an
// hour is not necessarily the biggest mover of any single minute.
export function mergeDeltas (deltas, endChaos) {
  const acc = new Map()
  let restCount = 0
  let restValue = 0
  for (const d of deltas) {
    for (const [name, dq, dv, pv] of (d.i || [])) {
      const cur = acc.get(name) || [0, 0, 0]
      cur[0] += Number(dq) || 0; cur[1] += Number(dv) || 0; cur[2] += Number(pv) || 0
      acc.set(name, cur)
    }
    if (Array.isArray(d.r)) { restCount += Number(d.r[0]) || 0; restValue += Number(d.r[1]) || 0 }
  }
  const rows = [...acc].map(([name, v]) => [name, round1(v[0]), round1(v[1]), round1(v[2])])
    .filter(r => Math.abs(r[2]) >= DELTA_NOISE_CHAOS || r[1] !== 0)
  rows.sort((x, y) => Math.abs(y[2]) - Math.abs(x[2]))

  const keep = []
  let dropped = 0
  for (const r of rows) {
    if (keep.length < DELTA_TOP_N && Math.abs(r[2]) >= DELTA_MIN_CHAOS) keep.push(r)
    else if (Math.abs(r[2]) >= DELTA_NOISE_CHAOS) dropped++
  }
  const explained = rows.reduce((s, r) => s + r[2], 0) + restValue
  const shown = keep.reduce((s, r) => s + r[2], 0)
  const anchor = deltas.length ? deltas[0] : null
  const total = round1((Number(endChaos) || 0) - (anchor ? (Number(anchor.pt) || 0) : 0))
  const rest = { count: dropped + restCount, value: round1(explained - shown) }
  return {
    items: keep.map(([name, dq, dv, pv]) => ({ name, qty: dq, value: dv, price: pv })),
    rest: (rest.count > 0 || Math.abs(rest.value) >= DELTA_MIN_CHAOS) ? rest : null,
    // Whatever the recorded items cannot account for (gaps in the interval,
    // rounding). Shown separately rather than smuggled into "smaller changes".
    unexplained: round1(total - explained)
  }
}

// Keeps at most `max` points, evenly spread over TIME (not over the index) so a
// gap in the series stays a gap. The newest point always survives — the chart's
// right edge must be the current value, never a bucket neighbour.
export function downsample (list, max) {
  if (!Array.isArray(list) || list.length <= max || max < 2) return list.slice()
  const first = list[0].at
  const span = list[list.length - 1].at - first
  if (span <= 0) return [list[list.length - 1]]
  const bucketMs = span / (max - 1)
  const out = []
  let lastBucket = -1
  for (const p of list) {
    const b = Math.floor((p.at - first) / bucketMs)
    if (b === lastBucket) out[out.length - 1] = p // keep the newest per bucket
    else { out.push(p); lastBucket = b }
  }
  return out
}
