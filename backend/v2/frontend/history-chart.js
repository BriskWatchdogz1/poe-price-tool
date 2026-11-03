/* Geometry AND number formatting for the history chart — pure, no DOM (same
 * pattern as trend.js and tabs.js, so it can be unit-tested in node).
 *
 * The old trend line was a 240x34 sparkline squeezed next to the totals: no
 * axes, no scale, and every recorded minute was a click target on a line three
 * pixels tall. This module produces the opposite: one wide plot with real
 * ticks, and click targets ONLY where something actually happened.
 *
 * WHY THE FORMATTING LIVES HERE TOO. A recorded point carries its own C:D rate
 * (`cd`, history.mjs), and the page's promise is that the divine value of an
 * old point never moves again. That promise is a function of (chaos, rate) and
 * of nothing else — so it belongs in the module a test can call, not in the
 * renderer, where a rate read out of module state (the newest point's) would
 * change every historical figure on the page with every rate tick.
 *
 * Coordinates are computed in a fixed viewBox; the SVG scales to the container.
 */
'use strict'

// Chart box. Left gutter holds the value ticks, bottom strip the time ticks.
export const CHART = { w: 1000, h: 260, padL: 62, padR: 14, padT: 14, padB: 26 }

/* How much counter-movement the line has to accumulate before it changes
 * colour, as a share of the PLOTTED span. Rounding noise around a bare sign
 * test turned a 14-day curve into a red/green patchwork: a tolerance alone does
 * not fix that, because a series that wobbles around the tolerance keeps
 * flipping. This is a hysteresis instead — see segmentDirections.
 *
 * NOT AN ENV SETTING (numeric-settings.mjs) on purpose: nothing about it
 * reaches the server. It decides how one SVG is painted in one browser, it is
 * measured against the drawn span rather than against any recorded quantity,
 * and routing it through the environment would mean a new wire field on a
 * polled endpoint for a purely cosmetic constant. It is overridable per call
 * (`opts.hysteresis`) so the tests can pin both sides of the threshold.
 */
export const DIRECTION_HYSTERESIS = 0.02

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

/* ---- units: what a number on this page means -------------------------------
 *
 * The page prints DIVINE. Not because the digits are smaller, but because that
 * is the unit purchasing power is thought in: "150d" is a Mageblood, "30k c" is
 * nothing anybody owns a picture of. The Net Worth page prints divine as well,
 * and a number has to mean the same thing on both.
 *
 * Chaos is the honest fallback and nothing else: it is used only where no rate
 * is known for the window at all, never as a second unit to switch to.
 */

// Points as served by /networth-trend: [at, chaos, cd]. `cd` is 0 when no rate
// was known at that minute (history.mjs). Rows that carry no timestamp or no
// total are not points.
const clean = points => (Array.isArray(points) ? points : [])
  .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))

/* The rate a moment is valued at: the point's own, and — only when it has none
 * — the rate of the NEAREST point in time that has one. Never the newest rate
 * of the series: valuing a ten-day-old point at today's rate invents movement
 * that never happened, which is the very reason `cd` is stored per point.
 * Returns 0 when no point in the window carries a rate at all; the caller then
 * says so in chaos instead of guessing. */
export function rateAt (points, at) {
  let best = 0
  let bestD = Infinity
  for (const p of clean(points)) {
    const r = Number(p[2]) || 0
    if (!(r > 0)) continue
    const d = Math.abs(p[0] - Number(at))
    if (d < bestD) { bestD = d; best = r }
  }
  return best
}

/* The series as it is DRAWN: one value per point in the unit the whole plot is
 * labelled in, plus the rate each value was converted with.
 *
 * `unit` is 'div' as soon as a single point in the window carries a rate (every
 * other point then borrows the nearest one), and 'chaos' only when not one
 * does. There is no third case and no mixed axis — a curve whose points are
 * partly divine and partly chaos would not be a curve. */
export function displaySeries (points) {
  const pts = clean(points)
  const rates = pts.map(p => (Number(p[2]) > 0 ? Number(p[2]) : rateAt(pts, p[0])))
  const unit = rates.some(r => r > 0) ? 'div' : 'chaos'
  const values = pts.map((p, i) => (unit === 'div' ? p[1] / rates[i] : p[1]))
  return { unit, rates, values, points: pts }
}

// A divine amount, already converted. Two decimals below one divine so a small
// net change does not read as a flat 0.0d.
export function fmtDivine (div, { sign = false } = {}) {
  const n = Number(div) || 0
  const a = Math.abs(n)
  const s = sign && n > 0 ? '+' : n < 0 ? '−' : ''
  return `${s}${a.toFixed(a >= 100 ? 0 : a >= 1 ? 1 : 2)}d`
}

// A chaos amount. Above ten thousand it is written in thousands: a stash total
// spelled out is a six-digit run of glyphs on an axis 62px wide, and reading it
// means counting digits.
export function fmtChaos (chaos, { sign = false } = {}) {
  const n = Number(chaos) || 0
  const a = Math.abs(n)
  const s = sign && n > 0 ? '+' : n < 0 ? '−' : ''
  if (a >= 10000) return `${s}${(a / 1000).toFixed(a >= 100000 ? 0 : 1)}k c`
  return `${s}${a >= 100 ? Math.round(a) : Math.round(a * 10) / 10}c`
}

/* A chaos amount printed at THE RATE IT BELONGS TO — the rate is a parameter,
 * never module state. Shown in divine once it is worth a divine, in chaos below
 * that, the same rule the Net Worth totals use. A rate of 0 means the window
 * knows none, and then chaos is the only thing that can be said truthfully. */
export function money (chaos, rate, { sign = false } = {}) {
  const n = Number(chaos) || 0
  const r = Number(rate) || 0
  if (r > 0 && Math.abs(n) >= r) return fmtDivine(n / r, { sign })
  return fmtChaos(n, { sign })
}

/* Net change across the window, in the display unit, each end valued at ITS OWN
 * rate. This can be NEGATIVE while the chaos total rose — when the rate rose
 * faster, the stash buys less than it did, and that is the true statement. The
 * rate readout and the rate overlay exist so that answer is readable rather
 * than mysterious. */
export function windowNet (points) {
  const { values, unit } = displaySeries(points)
  if (values.length < 2) return { v: 0, unit, ok: false }
  return { v: values[values.length - 1] - values[0], unit, ok: true }
}

/* First and last RECORDED rate of the window (points that carry one; borrowed
 * rates would only repeat a neighbour) plus the move between them, for the
 * rail readout. Null when the window has no rate at all. */
export function rateSpan (points) {
  const withRate = clean(points).filter(p => Number(p[2]) > 0)
  if (!withRate.length) return null
  const from = Number(withRate[0][2])
  const to = Number(withRate[withRate.length - 1][2])
  return { from, to, pct: from > 0 ? ((to - from) / from) * 100 : 0 }
}

/* Per-edge direction with HYSTERESIS. `tol` is an absolute amount in the
 * DISPLAY unit (the caller derives it from the plotted span), so the rule keeps
 * meaning the same thing now that the plot is drawn in divine.
 *
 * The rule: the colour follows the current direction until the movement AGAINST
 * it, measured from the last extreme, exceeds `tol`. Only then does it turn —
 * and it turns back to that extreme, so the edges of the confirmed reversal are
 * coloured as one stretch instead of leaving the first half of a fall painted
 * green. A wobble smaller than `tol` changes nothing, however often it repeats,
 * which is what a bare sign test (and a bare tolerance) could not do. */
export function segmentDirections (values, tol = 0) {
  const n = values.length
  if (n < 2) return []
  const t = Math.max(0, Number(tol) || 0)
  const dirs = new Array(n - 1)
  // Opening direction: the first change that is not flat. An all-flat series
  // never turns and is drawn rising, as it was before.
  let dir = false
  for (let i = 1; i < n; i++) {
    if (values[i] !== values[i - 1]) { dir = values[i] < values[i - 1]; break }
  }
  let extVal = values[0]
  let extIdx = 0
  for (let i = 1; i < n; i++) {
    dirs[i - 1] = dir
    const v = values[i]
    if (dir ? v <= extVal : v >= extVal) { extVal = v; extIdx = i; continue }
    const against = Math.abs(v - extVal)
    if (against <= t) continue
    dir = !dir
    for (let k = extIdx; k <= i - 1; k++) dirs[k] = dir
    extVal = v
    extIdx = i
  }
  return dirs
}

/* Value-axis bounds. Deliberately NOT zero-based: a stash that moves between
 * 83 and 85 divine would otherwise be a flat line at the top of an empty box.
 * A tenth of the span as padding
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
 * events: [{ at, c, cd, v }, ...] as served by /networth-events
 *
 * THE CURVE IS PLOTTED IN THE DISPLAY UNIT (divine, chaos/cd per point), not in
 * chaos. The old version drew `chaos` and only divided by a rate on the way to
 * the axis label — with the NEWEST rate, for every label, which meant a ten-day
 * window was relabelled every time the rate ticked. `unit` says what the
 * numbers coming out of here are; the renderer only formats them.
 *
 * Returns { line, area, segments, xOf, yOf, from, to, min, max, unit, values,
 *           rates, rate, rateFrom, rateTo, valueTicks, timeTicks, markers,
 *           empty }.
 * Markers are positioned from their TIMESTAMP, not from a point index — the
 * series is downsampled, so an event's own point may not be among the drawn
 * ones, and index-matching would silently put the dot in the wrong place.
 */
export function chartGeometry (points, events, opts = {}) {
  const box = { ...CHART, ...opts }
  const { unit, values, rates, points: pts } = displaySeries(points)
  const x0 = box.padL; const x1 = box.w - box.padR
  const y0 = box.padT; const y1 = box.h - box.padB

  if (pts.length < 2) {
    return { line: '', area: '', segments: [], from: 0, to: 0, min: 0, max: 1, unit, values, rates, rate: null, rateFrom: 0, rateTo: 0, valueTicks: [], timeTicks: [], markers: [], empty: true, xOf: () => x0, yOf: () => y1 }
  }

  const from = pts[0][0]; const to = pts[pts.length - 1][0]
  const span = Math.max(1, to - from)
  const { min, max } = valueBounds(values)
  const range = max - min || 1

  const xOf = at => lerp(x0, x1, Math.min(1, Math.max(0, (at - from) / span)))
  const yOf = v => lerp(y1, y0, Math.min(1, Math.max(0, (v - min) / range)))
  const r1 = n => Math.round(n * 10) / 10

  const line = values.map((v, i) => `${i ? 'L' : 'M'}${r1(xOf(pts[i][0]))},${r1(yOf(v))}`).join(' ')
  const area = `${line} L${r1(x1)},${r1(y1)} L${r1(x0)},${r1(y1)} Z`

  /* The line is also drawn segment by segment so a falling stretch can be red.
   * Consecutive segments of the same direction are merged into one path — a
   * per-pair path would be 180 elements otherwise, and on a 14-day series that
   * is what it was: the direction is decided with a hysteresis (see
   * segmentDirections), because a bare sign test flips on every wobble and the
   * result was a red/green patchwork rather than "here it went down". The
   * threshold is a share of the plotted span, in the display unit. */
  const hyst = Number.isFinite(opts.hysteresis) ? opts.hysteresis : DIRECTION_HYSTERESIS
  const dirs = segmentDirections(values, range * hyst)
  const segments = []
  let cur = null
  for (let i = 1; i < pts.length; i++) {
    const d = dirs[i - 1]
    const a = `${r1(xOf(pts[i - 1][0]))},${r1(yOf(values[i - 1]))}`
    const b = `${r1(xOf(pts[i][0]))},${r1(yOf(values[i]))}`
    if (!cur || d !== cur.down) {
      cur = { down: d, d: `M${a} L${b}` }
      segments.push(cur)
    } else {
      cur.d += ` L${b}`
    }
  }

  /* The rate curve, laid over the plot on ITS OWN min/max — sparkline manner,
   * two small edge labels, and deliberately NO second full axis: a chart with
   * axes on both sides is read wrong more often than it is read. It is here so
   * a drop in a divine curve can be TOLD APART from a rate that ran away; the
   * rail's C:D sparkline cannot do that, it is not aligned to this window. */
  let rate = null
  if (unit === 'div') {
    const rmin = Math.min(...rates)
    const rmax = Math.max(...rates)
    const top = y0 + (y1 - y0) * 0.08
    const bot = y1 - (y1 - y0) * 0.08
    const yr = rmax > rmin ? v => lerp(bot, top, (v - rmin) / (rmax - rmin)) : () => (top + bot) / 2
    rate = {
      d: rates.map((r, i) => `${i ? 'L' : 'M'}${r1(xOf(pts[i][0]))},${r1(yr(r))}`).join(' '),
      min: rmin,
      max: rmax,
      ticks: (rmax > rmin ? [rmax, rmin] : [rmin]).map(v => ({ v, y: r1(yr(v)) }))
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

  /* An event is valued at ITS OWN rate as well (`cd`, stamped from the bucket's
   * last point), falling back to the nearest point that has one — the dot has
   * to sit on the curve it belongs to, and its tooltip has to say the same
   * number tomorrow as it says today. */
  const markers = (Array.isArray(events) ? events : [])
    .filter(e => e && Number.isFinite(e.at) && e.at >= from && e.at <= to)
    .map(e => {
      const r = Number(e.cd) > 0 ? Number(e.cd) : rateAt(pts, e.at)
      const c = Number(e.c) || 0
      return { at: e.at, x: r1(xOf(e.at)), y: r1(yOf(unit === 'div' && r > 0 ? c / r : c)), v: Number(e.v) || 0, rate: r }
    })

  return {
    line,
    area,
    segments,
    xOf,
    yOf,
    from,
    to,
    min,
    max,
    unit,
    values,
    rates,
    rate,
    rateFrom: rates[0] || 0,
    rateTo: rates[rates.length - 1] || 0,
    valueTicks,
    timeTicks,
    markers,
    empty: false
  }
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
