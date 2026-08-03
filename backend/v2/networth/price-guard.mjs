// backend/v2/networth/price-guard.mjs
// Implausible-price brake for the recorded history.
//
// Live case (02.08., 05:50-06:47 local): "The Scavenger", a 1-chaos divination
// card, was recorded at 174,039c — exactly 1000 divine at that hour's rate — on
// an unchanged stack of one, then fell back 40 minutes later. The trend line got
// a mountain worth twelve times the whole account, and the item panel blamed a
// card that never moved. Reconstruction afterwards was impossible: the container
// had been rebuilt, so that night's log was gone, and neither Faustus (the card
// is below its volume floor in every one of the 19 recoverable hourly digests)
// nor poe.ninja (1c) carries a number anywhere near it.
//
// So this module does two things, in this order of importance:
//   1. LOG the jump with everything needed to identify the source next time.
//   2. Record the point at the item's PREVIOUS unit price instead of the new
//      one, and correct the point's total by the same amount.
//
// It deliberately guards the HISTORY only — the live snapshot keeps showing
// whatever the valuator produced. A brake that silently rewrote the displayed
// net worth would hide exactly the bug we are trying to catch.
'use strict'

// A jump must clear BOTH bars to count as implausible, so that ordinary market
// moves and cheap items are never touched:
//   factor — unit price grew at least this much. Real fungibles do not go 20x
//            between two recorded points; the observed case was 174,039x.
//   share  — and the resulting gain is at least this fraction of the previous
//            total. Without it a 20x on a 2-chaos oddity would trip the brake,
//            which is noise, not corruption.
export const GUARD_FACTOR = 20
export const GUARD_SHARE = 0.25
// A held price is a guess about the future: it assumes the spike is wrong. If a
// price really did jump and stays up, the brake must let go rather than freeze
// the series forever — after this long the new price is accepted (and logged).
export const GUARD_MAX_HOLD_MS = 6 * 60 * 60 * 1000

const unit = (v, q) => (q > 0 ? v / q : null)
const round1 = n => Math.round(n * 10) / 10

/**
 * createPriceGuard({ factor, share, maxHoldMs, now, log }) -> { apply, held }
 *
 * apply(user, prevMap, curMap, prevTotal) -> { items, adjust, notes }
 *   prevMap/curMap: folded item maps (name -> [qty, chaos]) as used by
 *     history.mjs; curMap is never mutated.
 *   prevTotal: the previous point's chaos total — the yardstick for `share`.
 *   items:  the map to record (a corrected COPY, or curMap itself when clean)
 *   adjust: chaos to add to the point's total (<= 0)
 *   notes:  one entry per correction, for tests and callers
 */
/* ---- retro-cleanup of ALREADY RECORDED spikes ------------------------------
 * The brake above only protects points recorded from now on. The Scavenger
 * mountain was already on disk, and it wrecked the chart far worse there than
 * in the numbers: the value axis has to span the peak, so a stash moving
 * between 83 and 85 divine was drawn as a flat line at the bottom of a plot
 * scaled to 1156 divine.
 *
 * What separates an artefact from a real mountain is not its height — it is
 * whether anything MOVED. Real wealth arrives as stock: items come in, items go
 * out, and the stored delta says so. A price artefact rises and falls with the
 * stock untouched. So a range is only removed when all of this holds:
 *   - it rises to at least `factor` times the level right before it,
 *   - it comes back DOWN to near that level afterwards (a jump that stays is
 *     someone getting richer, not a glitch),
 *   - it is shorter than `maxSpanMs`, and
 *   - no stock movement explains the rise.
 */
export const SPIKE_FACTOR = 5
export const SPIKE_RETURN = 2          // "back down" = within 2x the old level
export const SPIKE_MAX_SPAN_MS = 6 * 60 * 60 * 1000

// How much of a point's value change is carried by stock moving in or out.
// Stored delta rows are [name, dq, dv, priceShare]; dv - priceShare is the part
// the quantity carries (same derivation the history page's events use).
export function stockMove (point) {
  const rows = point && point.d && Array.isArray(point.d.i) ? point.d.i : []
  let sum = 0
  for (const [, dq, dv, priceShare] of rows) {
    if (!dq) continue
    sum += Math.abs((Number(dv) || 0) - (Number(priceShare) || 0))
  }
  return sum
}

/**
 * findSpikeRanges(points, opts) -> [{ from, to, base, peak, spanMs }]
 * `points` must be ONE user's points, ascending by `at`. Indexes are inclusive.
 */
export function findSpikeRanges (points, {
  factor = SPIKE_FACTOR,
  returnRatio = SPIKE_RETURN,
  maxSpanMs = SPIKE_MAX_SPAN_MS
} = {}) {
  const pts = Array.isArray(points) ? points : []
  const out = []
  for (let i = 1; i < pts.length - 1; i++) {
    const base = Number(pts[i - 1].c)
    if (!(base > 0) || !(Number(pts[i].c) >= base * factor)) continue

    let j = i
    while (j + 1 < pts.length && Number(pts[j + 1].c) >= base * factor) j++
    const after = pts[j + 1]
    // No point after the range: it may simply still be going on — leave it.
    if (!after || !(Number(after.c) <= base * returnRatio)) { i = j; continue }
    if (pts[j].at - pts[i].at > maxSpanMs) { i = j; continue }

    // Did stock actually move? Compare against the rise it would have to carry.
    let moved = 0
    for (let k = i; k <= j; k++) moved += stockMove(pts[k])
    const rise = Number(pts[i].c) - base
    if (moved >= rise * 0.5) { i = j; continue } // real: the items were there

    let peak = 0
    for (let k = i; k <= j; k++) peak = Math.max(peak, Number(pts[k].c) || 0)
    out.push({ from: i, to: j, base, peak, spanMs: pts[j].at - pts[i].at })
    i = j
  }
  return out
}

export function createPriceGuard ({
  factor = GUARD_FACTOR,
  share = GUARD_SHARE,
  maxHoldMs = GUARD_MAX_HOLD_MS,
  now = () => Date.now(),
  log = (...a) => console.warn(...a)
} = {}) {
  // `${user}|${name}` -> { since, price } for items currently held back. Memory
  // only: after a restart the brake simply re-evaluates from the next point,
  // which errs toward guarding rather than toward trusting a stale hold.
  const held = new Map()

  function apply (user, prevMap, curMap, prevTotal) {
    const clean = { items: curMap, adjust: 0, notes: [] }
    if (!(prevMap instanceof Map) || !(curMap instanceof Map)) return clean
    const total = Number(prevTotal)
    if (!Number.isFinite(total) || total <= 0) return clean

    const t = now()
    let out = null
    let adjust = 0
    const notes = []

    for (const [name, cur] of curMap) {
      const prev = prevMap.get(name)
      if (!prev) continue
      const [q0, v0] = prev
      const [q1, v1] = cur
      const p0 = unit(v0, q0)
      const p1 = unit(v1, q1)
      if (p0 == null || p1 == null || !(p0 > 0)) continue

      const key = `${user}|${name}`
      const hold = held.get(key)
      // Compare against the price we are HOLDING, not against the value we
      // recorded last time — otherwise a held spike becomes its own baseline on
      // the very next point and the brake releases after one interval.
      const ref = hold ? hold.price : p0
      const gain = v1 - q1 * ref

      if (!(p1 >= ref * factor) || !(gain >= total * share)) {
        if (hold) held.delete(key) // back to normal -> stop holding
        continue
      }

      if (hold && t - hold.since >= maxHoldMs) {
        held.delete(key)
        log('[networth] price hold released after %dh: "%s" stays at %sc/ea (was %sc/ea) — recording it as real',
          Math.round((t - hold.since) / 3600000), name, round1(p1), round1(ref))
        continue
      }
      if (!hold) held.set(key, { since: t, price: ref })

      if (!out) out = new Map(curMap)
      const corrected = q1 * ref
      out.set(name, [q1, corrected])
      adjust += corrected - v1
      notes.push({ name, qty: q1, oldPrice: ref, newPrice: p1, dropped: round1(v1 - corrected) })
      log('[networth] implausible price jump ignored for the trend: "%s" %sc/ea -> %sc/ea (x%s, %s in stock, +%sc = %d%% of the previous total %sc); recorded at the old price',
        name, round1(ref), round1(p1), round1(p1 / ref), q1, round1(v1 - corrected),
        Math.round((gain / total) * 100), round1(total))
    }

    return out ? { items: out, adjust: round1(adjust), notes } : clean
  }

  return { apply, held }
}
