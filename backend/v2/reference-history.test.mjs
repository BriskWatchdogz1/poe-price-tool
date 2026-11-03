// Reference-rail history: roundtrip, retention, minimum spacing, a corrupt
// file, unit conversion of old points, and the c<->div unit switch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReferenceHistory, displayValue, downsample } from './reference-history.mjs'

const LG = 'Allflame'
const MIN = 60 * 1000

async function tmpFile (name = 'ref.ndjson') {
  const dir = await mkdtemp(join(tmpdir(), 'refhist-'))
  return { dir, path: join(dir, name) }
}

// Clock we can push forward by hand.
function clock (start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms }, set: (v) => { t = v } }
}

test('roundtrip: append -> file -> load -> series', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const a = createReferenceHistory(path, { now: c.now })
  assert.equal(await a.append(LG, { cdRatio: 100, values: { 'c:exalted': 20 } }), true)
  c.advance(20 * MIN)
  assert.equal(await a.append(LG, { cdRatio: 100, values: { 'c:exalted': 25 } }), true)

  const b = createReferenceHistory(path, { now: c.now })
  await b.load()
  assert.equal(b.points.length, 2)
  assert.deepEqual(b.series(LG, 'c:exalted', 'c'), [20, 25])
  await rm(dir, { recursive: true, force: true })
})

test('minimum spacing: a second point written too early is dropped', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(path, { minIntervalMs: 10 * MIN, now: c.now })
  assert.equal(await h.append(LG, { cdRatio: 100, values: { x: 1 } }), true)
  c.advance(5 * MIN)
  assert.equal(await h.append(LG, { cdRatio: 100, values: { x: 2 } }), false)
  c.advance(6 * MIN)
  assert.equal(await h.append(LG, { cdRatio: 100, values: { x: 3 } }), true)
  assert.equal(h.points.length, 2)
  // The throttle is per league: another league may write right away.
  assert.equal(await h.append('Standard', { cdRatio: 100, values: { x: 9 } }), true)
  await rm(dir, { recursive: true, force: true })
})

test('retention: rows older than the window do not come back on load', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(path, { retentionMs: 60 * MIN, minIntervalMs: 0, now: c.now })
  await h.append(LG, { cdRatio: 100, values: { x: 1 } })
  c.advance(90 * MIN)
  await h.append(LG, { cdRatio: 100, values: { x: 2 } })

  assert.equal(h.prune(), 1)
  assert.equal(h.points.length, 1)

  const b = createReferenceHistory(path, { retentionMs: 60 * MIN, now: c.now })
  await b.load()
  assert.equal(b.points.length, 1)
  assert.equal(b.points[0].v.x, 2)
  await rm(dir, { recursive: true, force: true })
})

test('rewrite() atomically writes only the rows that were kept', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(path, { retentionMs: 60 * MIN, minIntervalMs: 0, now: c.now })
  await h.append(LG, { cdRatio: 100, values: { x: 1 } })
  c.advance(90 * MIN)
  await h.append(LG, { cdRatio: 100, values: { x: 2 } })
  h.prune()
  await h.rewrite()
  const lines = (await readFile(path, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).v.x, 2)
  await rm(dir, { recursive: true, force: true })
})

test('a missing file -> empty, not a crash', async () => {
  const { dir, path } = await tmpFile('gibtsnicht.ndjson')
  const h = createReferenceHistory(path)
  await h.load()
  assert.deepEqual(h.points, [])
  assert.deepEqual(h.series(LG, 'x', 'c'), [])
  await rm(dir, { recursive: true, force: true })
})

test('corrupt file: unreadable lines are skipped one by one', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const good = { lg: LG, at: c.now(), cd: 100, v: { x: 1 } }
  const good2 = { lg: LG, at: c.now() + MIN, cd: 100, v: { x: 2 } }
  await writeFile(path, [
    JSON.stringify(good),
    'this is not json',
    '{"lg":"Allflame","at":"broken","cd":100,"v":{"x":3}}', // at is not a number
    '{"lg":"Allflame","at":123456,"cd":100}',              // no v
    JSON.stringify(good2),
    '{"lg":"Allf'                                          // half-written line
  ].join('\n') + '\n', 'utf8')

  const h = createReferenceHistory(path, { now: c.now })
  await h.load()
  assert.equal(h.points.length, 2)
  assert.deepEqual(h.series(LG, 'x', 'c'), [1, 2])
  await rm(dir, { recursive: true, force: true })
})

test('not writable: append keeps the series in memory instead of throwing', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(join(path, 'no', 'directory.ndjson'), { minIntervalMs: 0, now: c.now })
  h.writable = false
  assert.equal(await h.append(LG, { cdRatio: 100, values: { x: 1 } }), true)
  c.advance(MIN)
  assert.equal(await h.append(LG, { cdRatio: 100, values: { x: 2 } }), true)
  assert.deepEqual(h.series(LG, 'x', 'c'), [1, 2])
  await rm(dir, { recursive: true, force: true })
})

test('a write error while writable=true does not kill the series', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  // The path points into a directory that does not exist -> appendFile throws ENOENT.
  const h = createReferenceHistory(join(dir, 'missing', 'x.ndjson'), { minIntervalMs: 0, now: c.now })
  assert.equal(await h.append(LG, { cdRatio: 100, values: { x: 1 } }), true)
  c.advance(MIN)
  assert.equal(await h.append(LG, { cdRatio: 100, values: { x: 2 } }), true)
  assert.deepEqual(h.series(LG, 'x', 'c'), [1, 2])
  await rm(dir, { recursive: true, force: true })
})

test('displayValue derives every unit from the chaos value + C:D', () => {
  assert.equal(displayValue(20, 100, 'c'), 20)
  assert.equal(displayValue(200, 100, 'div'), 2)
  assert.equal(displayValue(0.02, 100, 'perC'), 50)
  assert.equal(displayValue(0.02, 100, 'perDiv'), 5000)
  // Without a rate there is no divine number -> the point drops out of the series.
  assert.equal(displayValue(200, 0, 'div'), null)
  assert.equal(displayValue(0.02, 0, 'perDiv'), null)
  assert.equal(displayValue(0, 100, 'c'), null)
  assert.equal(displayValue(20, 100, 'quatsch'), null)
})

test('an old point is converted with ITS OWN C:D, not with the current one', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(path, { minIntervalMs: 0, now: c.now })
  // Mirror: chaos value stays at 100000, but the rate doubles.
  await h.append(LG, { cdRatio: 100, values: { 'c:mirror': 100_000 } })
  c.advance(20 * MIN)
  await h.append(LG, { cdRatio: 200, values: { 'c:mirror': 100_000 } })
  // So in divine the Mirror falls from 1000 to 500 — exactly what the line shows.
  assert.deepEqual(h.series(LG, 'c:mirror', 'div'), [1000, 500])
  // In chaos nothing happened at all.
  assert.deepEqual(h.series(LG, 'c:mirror', 'c'), [100_000, 100_000])
  await rm(dir, { recursive: true, force: true })
})

test('the c<->div unit switch does not produce a jump in the series', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(path, { minIntervalMs: 0, now: c.now })
  // Lifeforce keeps getting cheaper: 0.25 -> 0.2 -> 0.1 chaos per unit.
  // At the 5/c threshold the display flips mid-run from "/ c" to "/ div" —
  // but the history only knows the chaos value, so the series stays smooth.
  for (const px of [0.25, 0.2, 0.1]) {
    await h.append(LG, { cdRatio: 100, values: { 'j:vivid': px } })
    c.advance(20 * MIN)
  }
  // display unit today = perDiv (4/c < 5/c): a monotonic per-unit count.
  const perDiv = h.series(LG, 'j:vivid', 'perDiv')
  assert.deepEqual(perDiv, [400, 500, 1000])
  // The same series in perC has exactly the same shape, only scaled —
  // no point jumps out of the series when the unit changes.
  const perC = h.series(LG, 'j:vivid', 'perC')
  assert.deepEqual(perC.map(v => Math.round(v * 100)), [400, 500, 1000])
  await rm(dir, { recursive: true, force: true })
})

test('fewer than 2 usable points -> empty series (no line)', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(path, { minIntervalMs: 0, now: c.now })
  await h.append(LG, { cdRatio: 100, values: { x: 1 } })
  assert.deepEqual(h.series(LG, 'x', 'c'), [])
  c.advance(MIN)
  await h.append(LG, { cdRatio: 100, values: { x: 2 } })
  assert.equal(h.series(LG, 'x', 'c').length, 2)
  // Unknown row / other league / broken unit -> no line either.
  assert.deepEqual(h.series(LG, 'gibtsnicht', 'c'), [])
  assert.deepEqual(h.series('Standard', 'x', 'c'), [])
  assert.deepEqual(h.series(LG, 'x', 'nope'), [])
  await rm(dir, { recursive: true, force: true })
})

test('a row that only exists part of the time skips the points where it is missing', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(path, { minIntervalMs: 0, now: c.now })
  await h.append(LG, { cdRatio: 100, values: { a: 1 } })
  c.advance(MIN)
  await h.append(LG, { cdRatio: 100, values: { a: 2, b: 7 } })
  c.advance(MIN)
  await h.append(LG, { cdRatio: 100, values: { a: 3, b: 8 } })
  assert.deepEqual(h.series(LG, 'a', 'c'), [1, 2, 3])
  assert.deepEqual(h.series(LG, 'b', 'c'), [7, 8]) // no 0 for the first point
  await rm(dir, { recursive: true, force: true })
})

test('downsampling caps the plotted points and keeps the newest one', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(path, { minIntervalMs: 0, maxPoints: 10, now: c.now })
  for (let i = 1; i <= 100; i++) {
    await h.append(LG, { cdRatio: 100, values: { x: i } })
    c.advance(MIN)
  }
  const s = h.series(LG, 'x', 'c')
  assert.ok(s.length <= 10, `expected <=10, was ${s.length}`)
  assert.equal(s[s.length - 1], 100) // the newest point always survives
  assert.ok(s[0] < s[1], 'series stays sorted ascending')
  // Buckets over TIME; per bucket the newest entry survives.
  assert.deepEqual(downsample([[0, 'a'], [10, 'b'], [20, 'c']], 2), [[10, 'b'], [20, 'c']])
  // A gap stays a gap: two dense points + one late point do not end up evenly
  // spread, they stay where they belong in time.
  assert.deepEqual(downsample([[0, 'a'], [1, 'b'], [100, 'c']], 2), [[1, 'b'], [100, 'c']])
  await rm(dir, { recursive: true, force: true })
})

test('append rejects garbage instead of writing a zero series', async () => {
  const { dir, path } = await tmpFile()
  const h = createReferenceHistory(path, { minIntervalMs: 0 })
  assert.equal(await h.append('', { cdRatio: 100, values: { x: 1 } }), false)
  assert.equal(await h.append(LG, { cdRatio: 100 }), false)
  assert.equal(await h.append(LG, { cdRatio: 100, values: {} }), false)
  assert.equal(await h.append(LG, { cdRatio: 100, values: { x: 0, y: -3, z: 'nope' } }), false)
  assert.equal(h.points.length, 0)
  await rm(dir, { recursive: true, force: true })
})

test('a feed whose answer is not newer than its last point adds nothing for its rows (B29)', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(path, { now: c.now })
  const feeds = at => ({ exchange: { at, keys: ['c:x'] } })
  assert.equal(await h.append(LG, { cdRatio: 100, values: { 'c:x': 1 }, feeds: feeds(100) }), true)
  c.advance(60 * MIN)
  // The same poe.ninja answer again (served from the last good answer during an
  // outage): no new point with a new time.
  assert.equal(await h.append(LG, { cdRatio: 100, values: { 'c:x': 1 }, feeds: feeds(100) }), false)
  assert.equal(h.points.length, 1)
  assert.equal(await h.append(LG, { cdRatio: 100, values: { 'c:x': 2 }, feeds: feeds(200) }), true)
  assert.deepEqual(h.points.at(-1).ob, { exchange: 200 })
  assert.equal(h.lastObservedAt(LG, 'exchange'), 200)
  c.advance(60 * MIN)
  assert.equal(await h.append(LG, { cdRatio: 100, values: { 'c:x': 3 } }), true, 'without feeds it behaves as before')
  assert.equal('ob' in h.points.at(-1), false)
  assert.equal(h.lastObservedAt(LG, 'exchange'), 200, 'a point without the feed does not hide its last answer')
  c.advance(60 * MIN)
  assert.equal(await h.append(LG, { cdRatio: 100, values: { 'c:x': 4 }, feeds: feeds(200) }), false)
  const back = createReferenceHistory(path, { now: c.now })
  await back.load()
  assert.deepEqual(back.points[1].ob, { exchange: 200 }, 'ob survives a reload')
  await rm(dir, { recursive: true, force: true })
})

test('one stale feed drops only its own rows; the other feeds still get their point (B29)', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  const h = createReferenceHistory(path, { now: c.now })
  const values = { 'c:mirror': 100000, 'b:vulture': 1800, 's:vivid': 0.04 }
  const feeds = (ex, b) => ({ exchange: { at: ex, keys: ['c:mirror'] }, beasts: { at: b, keys: ['b:vulture'] } })
  assert.equal(await h.append(LG, { cdRatio: 200, values, feeds: feeds(100, 100) }), true)
  c.advance(60 * MIN)
  // The exchange answer is the old one, the beast overview is new, and the
  // Faustus row (no feed) is always written.
  assert.equal(await h.append(LG, { cdRatio: 200, values: { ...values, 's:vivid': 0.05 }, feeds: feeds(100, 300) }), true)
  assert.deepEqual(h.points.at(-1).v, { 'b:vulture': 1800, 's:vivid': 0.05 })
  assert.deepEqual(h.points.at(-1).ob, { beasts: 300 })
  c.advance(60 * MIN)
  // Both poe.ninja feeds stale: the Faustus row alone still makes a point.
  assert.equal(await h.append(LG, { cdRatio: 200, values: { ...values, 's:vivid': 0.06 }, feeds: feeds(100, 300) }), true)
  assert.deepEqual(h.points.at(-1).v, { 's:vivid': 0.06 })
  assert.equal('ob' in h.points.at(-1), false)
  assert.equal(h.series(LG, 's:vivid', 'perC').length, 3, 'the Faustus row keeps moving')
  assert.equal(h.series(LG, 'c:mirror', 'c').length, 0, 'one Mirror point only: no line yet')
  c.advance(60 * MIN)
  // A new exchange answer is compared against the last point that HAD the feed.
  assert.equal(await h.append(LG, { cdRatio: 200, values, feeds: feeds(400, 300) }), true)
  assert.deepEqual(h.points.at(-1).ob, { exchange: 400 })
  await rm(dir, { recursive: true, force: true })
})

test('a point in the first form (numeric ob) counts as the exchange feed', async () => {
  const { dir, path } = await tmpFile()
  const c = clock()
  await writeFile(path, JSON.stringify({ lg: LG, at: c.now(), cd: 100, v: { 'c:x': 1 }, ob: 100 }) + '\n', 'utf8')
  const h = createReferenceHistory(path, { now: c.now })
  await h.load()
  assert.equal(h.lastObservedAt(LG, 'exchange'), 100)
  assert.equal(h.lastObservedAt(LG, 'beasts'), null)
  c.advance(60 * MIN)
  assert.equal(await h.append(LG, { cdRatio: 100, values: { 'c:x': 1 }, feeds: { exchange: { at: 100, keys: ['c:x'] } } }), false)
  await rm(dir, { recursive: true, force: true })
})
