/* Geometry for the history chart — pure, no DOM (same pattern as trend.js and
 * tabs.js, so it can be unit-tested in node).
 *
 * The old trend line was a 240x34 sparkline squeezed next to the totals: no
 * axes, no scale, and every recorded minute was a click target on a line three
 * pixels tall. This module produces the opposite: one wide plot with real
 * ticks, and click targets ONLY where something actually happened.
 *
 * Coordinates are computed in a fixed viewBox; the SVG scales to the container.
 */
'use strict'

// Chart box. Left gutter holds the value ticks, bottom strip the time ticks.
export const CHART = { w: 1000, h: 260, padL: 62, padR: 14, padT: 14, padB: 26 }

const lerp = (a, b, t) => a + (b - a) * t

// "Nice" step for an axis: 1, 2, 2.5 or 5 times a power of ten. Keeps tick
// labels readable (0.5 / 1 / 2.5 div) instead of 0.732-style noise.
export function niceStep (span, targetTicks = 4) {
  if (!(span > 0)) return 1
  const raw = span / Math.max(1, targetTicks)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / mag
  // 2.5 covers the 2..3 band as well: rounding a 2.7 up to 5 halves the tick
  // count and leaves a plot with two labels on it.
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 3 ? 2.5 : n <= 5 ? 5 : 10
  return mult * mag
}

/* Value-axis bounds. Deliberately NOT zero-based: a stash that moves between
 * 83 and 85 divine would otherwise be a flat line at the top of an empty box —
 * which is exactly how the old sparkline looked. A tenth of the span as padding
 * keeps the curve off both edges, and a completely flat series still gets a
 * band to sit in the middle of. */
export function valueBounds (values) {
  const nums = (Array.isArray(values) ? values : []).filter(v => Number.isFinite(v))
  if (!nums.length) return { min: 0, max: 1 }
  let min = Math.min(...nums)
  let max = Math.max(...nums)
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1
    return { min: min - pad, max: max + pad }
  }
  const pad = (max - min) * 0.1
  return { min: min - pad, max: max + pad }
}

/**
 * chartGeometry(points, events, opts) — everything the renderer needs.
 *
 * points: [[at, chaos, cd], ...] ascending, as served by /networth-trend
 * events: [{ at, c, v }, ...] as served by /networth-events
 *
 * Returns { line, area, xOf, yOf, from, to, min, max, valueTicks, timeTicks,
 *           markers, empty }.
 * Markers are positioned from their TIMESTAMP, not from a point index — the
 * series is downsampled, so an event's own point may not be among the drawn
 * ones, and index-matching would silently put the dot in the wrong place.
 */
export function chartGeometry (points, events, opts = {}) {
  const box = { ...CHART, ...opts }
  const pts = (Array.isArray(points) ? points : []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
  const x0 = box.padL; const x1 = box.w - box.padR
  const y0 = box.padT; const y1 = box.h - box.padB

  if (pts.length < 2) {
    return { line: '', area: '', segments: [], from: 0, to: 0, min: 0, max: 1, valueTicks: [], timeTicks: [], markers: [], empty: true, xOf: () => x0, yOf: () => y1 }
  }

  const from = pts[0][0]; const to = pts[pts.length - 1][0]
  const span = Math.max(1, to - from)
  const { min, max } = valueBounds(pts.map(p => p[1]))
  const range = max - min || 1

  const xOf = at => lerp(x0, x1, Math.min(1, Math.max(0, (at - from) / span)))
  const yOf = v => lerp(y1, y0, Math.min(1, Math.max(0, (v - min) / range)))
  const r1 = n => Math.round(n * 10) / 10

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${r1(xOf(p[0]))},${r1(yOf(p[1]))}`).join(' ')
  const area = `${line} L${r1(x1)},${r1(y1)} L${r1(x0)},${r1(y1)} Z`

  /* The line is also drawn segment by segment so a falling stretch can be red.
   * Consecutive segments of the same direction are merged into one path — a
   * per-pair path would be 180 elements for a series that usually only changes
   * direction a handful of times. `down` is decided by the VALUE, not by the
   * pixel: equal values are flat and inherit the previous direction, so a long
   * plateau does not flip colour on rounding noise. */
  const segments = []
  let cur = null
  let dir = false
  for (let i = 1; i < pts.length; i++) {
    const dv = pts[i][1] - pts[i - 1][1]
    const d = dv === 0 ? dir : dv < 0
    const a = `${r1(xOf(pts[i - 1][0]))},${r1(yOf(pts[i - 1][1]))}`
    const b = `${r1(xOf(pts[i][0]))},${r1(yOf(pts[i][1]))}`
    if (!cur || d !== dir) {
      cur = { down: d, d: `M${a} L${b}` }
      segments.push(cur)
      dir = d
    } else {
      cur.d += ` L${b}`
    }
  }

  // Value ticks on a nice step inside the bounds.
  const step = niceStep(range, 4)
  const valueTicks = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    valueTicks.push({ v, y: r1(yOf(v)) })
  }

  // Time ticks: five evenly spaced instants across the window. Labelling is the
  // renderer's job (it knows the locale).
  const timeTicks = []
  for (let i = 0; i <= 4; i++) {
    const at = from + (span * i) / 4
    timeTicks.push({ at, x: r1(xOf(at)) })
  }

  const markers = (Array.isArray(events) ? events : [])
    .filter(e => e && Number.isFinite(e.at) && e.at >= from && e.at <= to)
    .map(e => ({ at: e.at, x: r1(xOf(e.at)), y: r1(yOf(Number(e.c))), v: Number(e.v) || 0 }))

  return { line, area, segments, xOf, yOf, from, to, min, max, valueTicks, timeTicks, markers, empty: false }
}

// Nearest event to a chart x coordinate, within `radius` px — the click/hover
// hit test. Returns the index in `markers`, or -1. Without it a click would
// have to land exactly on a 4px dot.
export function markerAt (markers, x, radius = 18) {
  let best = -1; let bestD = Infinity
  for (let i = 0; i < (markers || []).length; i++) {
    const d = Math.abs(markers[i].x - x)
    if (d < bestD) { bestD = d; best = i }
  }
  return bestD <= radius ? best : -1
}
