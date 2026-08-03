// Geometry of the history page (gitignored, local).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chartGeometry, valueBounds, niceStep, markerAt, CHART } from './history-chart.js'

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
