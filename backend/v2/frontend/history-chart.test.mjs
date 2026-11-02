// Geometry of the history page (gitignored, local).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chartGeometry, valueBounds, niceStep, markerAt, CHART,
  money, fmtDivine, fmtChaos, rateAt, displaySeries, windowNet, rateSpan,
  segmentDirections, DIRECTION_HYSTERESIS
} from './history-chart.js'

const series = (n, f) => Array.from({ length: n }, (_, i) => [1000 + i * 60000, f(i), 173])

test('the scale is NOT anchored at zero', () => {
  // 83..85 div: with a zero anchor this would be a flat line along the top edge.
  const b = valueBounds([14300, 14400, 14500])
  assert.ok(b.min > 14000, `lower bound ${b.min} sticks to zero`)
  assert.ok(b.min < 14300 && b.max > 14500, 'curve must stay clear of both edges')
})

test('a flat series still gets a band', () => {
  const b = valueBounds([500, 500, 500])
  assert.ok(b.max > b.min, 'otherwise the division by the span would be a division by zero')
})

test('axis steps are round numbers', () => {
  for (const [span, want] of [[100, 25], [1000, 250], [8, 2], [0.4, 0.1]]) {
    assert.equal(niceStep(span, 4), want, `span ${span}`)
  }
})

test('the line spans the full drawing area', () => {
  const g = chartGeometry(series(10, i => 1000 + i * 10), [])
  assert.ok(g.line.startsWith(`M${CHART.padL}`), `line starts at ${g.line.slice(0, 12)}`)
  assert.ok(g.line.includes(`L${CHART.w - CHART.padR}`), 'line must run all the way to the right edge')
  assert.ok(g.area.endsWith('Z'), 'area is closed')
  assert.equal(g.valueTicks.length >= 3, true)
  assert.equal(g.timeTicks.length, 5)
})

test('markers sit on their timestamp, not on a point index', () => {
  // series of 10 points, but only 3 of them "drawn" (downsampling).
  const all = series(10, i => 1000 + i * 10)
  const drawn = [all[0], all[4], all[9]]
  const ev = { at: all[7][0], c: all[7][1], v: 500 }
  const g = chartGeometry(drawn, [ev])
  assert.equal(g.markers.length, 1)
  const expected = g.xOf(ev.at)
  assert.equal(g.markers[0].x, Math.round(expected * 10) / 10)
  // the index-based approach would have taken the third drawn point here:
  assert.notEqual(g.markers[0].x, g.xOf(drawn[2][0]))
})

test('events outside the window get no marker', () => {
  const pts = series(5, i => 100 + i)
  const g = chartGeometry(pts, [{ at: pts[0][0] - 60000, c: 100, v: 9 }, { at: pts[2][0], c: 102, v: 9 }])
  assert.equal(g.markers.length, 1)
})

test('too few points yield an empty but usable state', () => {
  const g = chartGeometry([[1, 2, 3]], [])
  assert.equal(g.empty, true)
  assert.equal(g.line, '')
  assert.equal(typeof g.xOf, 'function', 'the renderer must not run into undefined')
  assert.deepEqual(chartGeometry(null, null).markers, [])
})

test('a hit close by counts, far off does not', () => {
  const m = [{ x: 100 }, { x: 400 }]
  assert.equal(markerAt(m, 104), 0)
  assert.equal(markerAt(m, 390), 1)
  assert.equal(markerAt(m, 250), -1, 'nothing may trigger between two events')
  assert.equal(markerAt([], 100), -1)
})

// --- line direction: falling segments are red -------------------------------
test('rising and falling segments are drawn separately', () => {
  const pts = [[0, 100, 173], [1000, 120, 173], [2000, 140, 173], [3000, 90, 173], [4000, 110, 173]]
  const g = chartGeometry(pts, [])
  assert.equal(g.segments.length, 3, 'up, down, up')
  assert.deepEqual(g.segments.map(s => s.down), [false, true, false])
  // Same direction is merged into one path, not drawn per point pair.
  assert.equal(g.segments[0].d.match(/L/g).length, 2, 'two rises in a single path')
})

test('a flat stretch does not flip the color', () => {
  const pts = [[0, 100, 173], [1000, 90, 173], [2000, 90, 173], [3000, 90, 173]]
  const g = chartGeometry(pts, [])
  assert.equal(g.segments.length, 1, 'unchanged values keep the current direction')
  assert.equal(g.segments[0].down, true)
})

test('every segment starts with its own M', () => {
  const pts = [[0, 100, 173], [1000, 120, 173], [2000, 80, 173]]
  const g = chartGeometry(pts, [])
  for (const s of g.segments) assert.match(s.d, /^M/, 'otherwise the red path hangs off the green one')
})

// --- the point of the whole exercise ----------------------------------------
// A historical event cannot change by definition. Everything below measures
// that one sentence.
test('a ten-day-old point keeps its divine value when today’s rate moves', () => {
  const day = 24 * 3600e3
  const old = [1000, 17300, 173]           // 100 divine at the rate of that day
  const build = todayRate => chartGeometry([old, [1000 + 10 * day, 39000, todayRate]], [])

  const a = build(195)
  const b = build(220)
  assert.equal(a.unit, 'div')
  assert.equal(a.values[0], 100, 'the old point is 100 divine and stays 100 divine')
  assert.equal(a.values[0], b.values[0], 'today’s rate must not reach back into an old point')
  // …and the newest point moves, because that one really is worth less.
  assert.ok(a.values[1] > b.values[1], 'the rate rose, so the same chaos is fewer divine')
  // The old, broken reading: everything divided by the newest rate.
  assert.notEqual(17300 / 195, 17300 / 220)
})

test('money() takes the rate as an argument, never from a series', () => {
  assert.equal(money(17300, 173), '100d')
  assert.equal(money(17300, 220), '78.6d')
  // Below one divine the value is stated in chaos — the same rule the Net Worth
  // totals use, so a number means the same thing on both pages.
  assert.equal(money(90, 173), '90c')
  assert.equal(money(-90, 173, { sign: true }), '−90c')
  assert.equal(money(35000, 173, { sign: true }), '+202d', 'three digits of divine need no decimal')
  assert.equal(money(8650, 173, { sign: true }), '+50.0d')
  // No rate at all -> chaos, and chaos stays readable at stash size.
  assert.equal(money(30200, 0), '30.2k c')
  assert.equal(fmtChaos(174039), '174k c')
  assert.equal(fmtDivine(0.42), '0.42d', 'a small net must not read as a flat 0.0')
})

test('a point without a rate borrows the nearest one, not the newest', () => {
  const pts = [[0, 1000, 100], [10, 2000, 0], [20, 3000, 0], [1000, 4000, 200]]
  assert.equal(rateAt(pts, 10), 100, 'nearest in TIME')
  assert.equal(rateAt(pts, 999), 200)
  const s = displaySeries(pts)
  assert.equal(s.unit, 'div')
  assert.deepEqual(s.rates, [100, 100, 100, 200])
  assert.deepEqual(s.values, [10, 20, 30, 20])
})

test('a window in which NOTHING carries a rate is labelled in chaos, not guessed', () => {
  const pts = [[0, 30200, 0], [1000, 31000, 0]]
  const s = displaySeries(pts)
  assert.equal(s.unit, 'chaos')
  assert.deepEqual(s.values, [30200, 31000], 'the chaos totals themselves')
  const g = chartGeometry(pts, [])
  assert.equal(g.unit, 'chaos')
  assert.equal(g.rate, null, 'no rate curve either — there is nothing to draw')
  assert.equal(fmtChaos(g.valueTicks[0].v).endsWith('k c'), true)
})

test('the window net is measured at both ends’ OWN rate — and may turn negative', () => {
  // 17300c at 173 = 100 div; 19000c at 220 = 86.4 div. The chaos total rose.
  const net = windowNet([[0, 17300, 173], [1000, 19000, 220]])
  assert.equal(net.unit, 'div')
  assert.ok(net.v < 0, `a stash that buys less is a loss, got ${net.v}`)
  assert.equal(Math.round(net.v * 10) / 10, -13.6)
  // The old reading called this a gain of 1700 chaos.
  assert.ok(19000 - 17300 > 0)
  assert.equal(windowNet([[0, 100, 173]]).ok, false, 'one point is not a change')
})

test('the rate readout quotes recorded rates, first and last', () => {
  const rs = rateSpan([[0, 1, 173], [1, 2, 0], [2, 3, 195]])
  assert.equal(rs.from, 173)
  assert.equal(rs.to, 195)
  assert.equal(Math.round(rs.pct), 13)
  assert.equal(rateSpan([[0, 1, 0]]), null)
})

// --- direction: hysteresis, not a sign test ---------------------------------
test('noise around the threshold does not flip the colour', () => {
  // Sawtooth of ±1 on a span of 100: a sign test paints eight segments.
  const v = [100, 99, 100, 99, 100, 99, 100, 99, 200]
  const bare = segmentDirections(v, 0)
  assert.ok(bare.filter((d, i) => i && d !== bare[i - 1]).length >= 7, 'this is the patchwork being fixed')
  const dirs = segmentDirections(v, 100 * DIRECTION_HYSTERESIS)
  const flips = dirs.filter((d, i) => i && d !== dirs[i - 1]).length
  assert.equal(flips, 1, `one real turn, got ${flips}`)
  assert.equal(dirs[dirs.length - 1], false, 'and it ends rising')
})

test('a counter-movement bigger than the threshold still turns the line', () => {
  const tol = 2
  assert.deepEqual(segmentDirections([100, 110, 108], tol), [false, false], 'below the bar: still rising')
  assert.deepEqual(segmentDirections([100, 110, 107], tol), [false, true], 'above it: a fall')
  // The turn is coloured from the extreme it started at, not from the point the
  // reversal happened to be confirmed at.
  assert.deepEqual(segmentDirections([100, 110, 109, 108, 100], tol), [false, true, true, true])
})

test('the threshold is measured in the DISPLAY unit', () => {
  // 2% of the plotted span, and the plot is divine — a threshold left in chaos
  // would be ~200x too large here.
  const day = 24 * 3600e3
  const pts = [[0, 17300, 173], [day, 17500, 173], [2 * day, 17400, 173], [3 * day, 22000, 173]]
  const g = chartGeometry(pts, [])
  assert.equal(g.unit, 'div')
  // The dip is 0.58 div on a plotted span of ~30 div: under the bar.
  assert.deepEqual(g.segments.map(s => s.down), [false])
  const loud = chartGeometry(pts, [], { hysteresis: 0.0001 })
  assert.deepEqual(loud.segments.map(s => s.down), [false, true, false], 'a small enough bar sees it')
})

// --- rate overlay -----------------------------------------------------------
test('the rate rides along on its own scale, inside the plot, with two labels', () => {
  const pts = [[0, 17300, 173], [1000, 18000, 180], [2000, 19500, 195]]
  const g = chartGeometry(pts, [])
  assert.equal(g.rate.min, 173)
  assert.equal(g.rate.max, 195)
  assert.equal(g.rate.ticks.length, 2, 'two small edge labels, not a second axis')
  assert.ok(g.rate.ticks[0].y < g.rate.ticks[1].y, 'the higher rate sits higher')
  for (const t of g.rate.ticks) {
    assert.ok(t.y > CHART.padT && t.y < CHART.h - CHART.padB, 'the overlay stays inside the plot')
  }
  // Its own min/max: the rate curve must span its band, not the value axis'.
  assert.notEqual(g.rate.d, g.line)
  assert.equal(g.rateFrom, 173)
  assert.equal(g.rateTo, 195)
  const flat = chartGeometry([[0, 17300, 173], [1000, 18000, 173]], [])
  assert.equal(flat.rate.ticks.length, 1, 'a rate that did not move gets one label')
})

// --- events -----------------------------------------------------------------
test('an event dot is valued at the event’s own rate', () => {
  const pts = [[0, 17300, 173], [1000, 39000, 195]]
  const ev = { at: 500, c: 17300, cd: 173, v: 1730 }
  const g = chartGeometry(pts, [ev])
  assert.equal(g.markers[0].rate, 173)
  assert.equal(g.markers[0].y, Math.round(g.yOf(100) * 10) / 10, 'the dot sits where 100 divine is')
  assert.equal(money(g.markers[0].v, g.markers[0].rate, { sign: true }), '+10.0d')
  // An event recorded without a rate borrows the nearest point's.
  const g2 = chartGeometry(pts, [{ at: 900, c: 39000, cd: 0, v: 100 }])
  assert.equal(g2.markers[0].rate, 195)
})
