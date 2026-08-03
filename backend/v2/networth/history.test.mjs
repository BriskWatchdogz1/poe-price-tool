import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthHistory, downsample, RANGES } from './history.mjs'

async function tmpFile (name = 'networth-history.ndjson') {
  const dir = await mkdtemp(join(tmpdir(), 'nwhist-'))
  return join(dir, name)
}

// Clock we can drive by hand — no real waiting anywhere in this file.
function clock (start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, advance: ms => { t += ms }, set: v => { t = v } }
}

const TABS = { Currency: 1200, Fragments: 340.5, Empty: 0.4 }

test('throttle: at most one point per minute and user', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()

  assert.equal(await h.append('player1', { totalChaos: 100, cdRatio: 200, tabs: TABS }), true)
  c.advance(30_000)
  assert.equal(await h.append('player1', { totalChaos: 110, cdRatio: 200, tabs: TABS }), false, '30s -> dropped')
  c.advance(29_999)
  assert.equal(await h.append('player1', { totalChaos: 120, cdRatio: 200, tabs: TABS }), false, '59.999s -> dropped')
  c.advance(1)
  assert.equal(await h.append('player1', { totalChaos: 130, cdRatio: 200, tabs: TABS }), true, '60s -> accepted')
  assert.equal(h.points.length, 2)
})

test('the throttle is PER USER — player2 does not block player1', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  assert.equal(await h.append('player1', { totalChaos: 100, cdRatio: 200, tabs: {} }), true)
  assert.equal(await h.append('player2', { totalChaos: 50, cdRatio: 200, tabs: {} }), true)
  assert.equal(await h.append('player1', { totalChaos: 101, cdRatio: 200, tabs: {} }), false)
  assert.equal(h.points.filter(p => p.u === 'player2').length, 1)
})

test('a point holds time, chaos, the historical div rate and the tab breakdown', async () => {
  const c = clock()
  const file = await tmpFile()
  const h = createNetworthHistory(file, { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 1540.55, cdRatio: 215, tabs: TABS })

  const line = JSON.parse((await readFile(file, 'utf8')).trim())
  assert.equal(line.u, 'player1')
  assert.equal(line.at, c.now())
  assert.equal(line.c, 1540.6)                       // round1
  assert.equal(line.cd, 215)                         // the rate AT THAT MOMENT
  assert.deepEqual(line.t, { Currency: 1200, Fragments: 340.5 }) // <1c drops out
  // No account identifier in the clear: only the local routing name.
  assert.equal(Object.keys(line).sort().join(','), 'at,c,cd,t,u')
})

test('div reconstruction uses the historical rate, not the current one', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 2000, cdRatio: 200, tabs: {} }) // = 10 div back then
  c.advance(60_000)
  await h.append('player1', { totalChaos: 2000, cdRatio: 400, tabs: {} }) // = 5 div today

  const s = h.series('player1', RANGES['24h'], { at: c.now() })
  assert.deepEqual(s.points.map(p => p[2]), [200, 400])
  // Recomputed with the current rate the first point would be 5 div (no growth
  // visible) — with the stored one it is correctly 10.
  assert.equal(s.points[0][1] / s.points[0][2], 10)
  assert.equal(s.points[1][1] / s.points[1][2], 5)
})

test('retention: everything older than the retention window is dropped on load', async () => {
  const c = clock()
  const file = await tmpFile()
  const now = c.now()
  const H = 3600e3
  await writeFile(file, [
    { u: 'player1', at: now - 72 * H, c: 1, cd: 200, t: {} },
    { u: 'player1', at: now - 49 * H, c: 2, cd: 200, t: {} },
    { u: 'player1', at: now - 47 * H, c: 3, cd: 200, t: {} },
    { u: 'player1', at: now - 1 * H, c: 4, cd: 200, t: {} }
  ].map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8')

  const h = createNetworthHistory(file, { now: c.now, retentionMs: 48 * H })
  await h.load()
  assert.deepEqual(h.points.map(p => p.c), [3, 4])
})

test('retention: prune + rewrite trim the file down', async () => {
  const c = clock()
  const file = await tmpFile()
  const h = createNetworthHistory(file, { now: c.now, retentionMs: 48 * 3600e3 })
  await h.load()
  await h.append('player1', { totalChaos: 1, cdRatio: 200, tabs: {} })
  c.advance(49 * 3600e3)
  await h.append('player1', { totalChaos: 2, cdRatio: 200, tabs: {} })
  assert.equal(h.prune(), 1)
  await h.rewrite()
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).c, 2)
})

test('missing file -> empty history instead of a crash', async () => {
  const h = createNetworthHistory(join(await tmpFile(), 'nope', 'gone.ndjson'))
  await h.load()
  assert.deepEqual(h.points, [])
  assert.deepEqual(h.series('player1', RANGES['1h']).points, [])
})

test('empty file -> empty history', async () => {
  const file = await tmpFile()
  await writeFile(file, '', 'utf8')
  const h = createNetworthHistory(file)
  await h.load()
  assert.deepEqual(h.points, [])
})

test('broken lines are skipped one by one, the rest survives', async () => {
  const c = clock()
  const file = await tmpFile()
  const now = c.now()
  await writeFile(file,
    'total garbage, not json\n' +
    JSON.stringify({ u: 'player1', at: now - 1000, c: 42, cd: 200, t: {} }) + '\n' +
    '{"u":"player1","at":123,"c":  <- half-written line\n' +
    JSON.stringify({ at: now, c: 9 }) + '\n' +                 // no user -> out
    JSON.stringify({ u: 'player1', at: 'yesterday', c: 9, cd: 1 }) + '\n', 'utf8') // at is not a number
  const h = createNetworthHistory(file, { now: c.now })
  await h.load()
  assert.deepEqual(h.points.map(p => p.c), [42])
})

test('entirely broken file -> empty history, no throw', async () => {
  const file = await tmpFile()
  await writeFile(file, '{{{ not json at all }}}', 'utf8')
  const h = createNetworthHistory(file)
  await assert.doesNotReject(() => h.load())
  assert.deepEqual(h.points, [])
})

test('container restart: a fresh instance reads the appended points back', async () => {
  const c = clock()
  const file = await tmpFile()
  const a = createNetworthHistory(file, { now: c.now })
  await a.load()
  await a.append('player1', { totalChaos: 100, cdRatio: 200, tabs: TABS })
  c.advance(60_000)
  await a.append('player1', { totalChaos: 200, cdRatio: 210, tabs: TABS })

  const b = createNetworthHistory(file, { now: c.now }) // the "restart"
  await b.load()
  assert.deepEqual(b.points.map(p => p.c), [100, 200])
  // and keeps appending cleanly (the throttle knows the last point from the file)
  assert.equal(await b.append('player1', { totalChaos: 300, cdRatio: 210, tabs: {} }), false)
  c.advance(60_000)
  assert.equal(await b.append('player1', { totalChaos: 300, cdRatio: 210, tabs: {} }), true)
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3)
})

test('range filtering 1h/6h/24h returns exactly the matching points', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  const start = c.now()
  for (let i = 0; i < 30 * 60; i++) {          // 30h, one point per minute
    await h.append('player1', { totalChaos: i, cdRatio: 200, tabs: {} })
    c.advance(60_000)
  }
  c.set(start + 30 * 3600e3)
  const at = c.now()

  const h1 = h.series('player1', RANGES['1h'], { at, max: 10_000 })
  const h6 = h.series('player1', RANGES['6h'], { at, max: 10_000 })
  const h24 = h.series('player1', RANGES['24h'], { at, max: 10_000 })
  assert.equal(h1.total, 60)
  assert.equal(h6.total, 360)
  assert.equal(h24.total, 1440)
  assert.ok(h1.points.every(p => p[0] >= at - RANGES['1h']))
  assert.equal(h1.points[h1.points.length - 1][1], 30 * 60 - 1, 'newest point comes last')
  assert.equal(h24.coverageMs, 29 * 3600e3 + 59 * 60e3, 'coverage = the whole history on hand')
})

test('series downsamples to max and keeps the newest point', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  for (let i = 0; i < 1440; i++) {
    await h.append('player1', { totalChaos: i, cdRatio: 200, tabs: {} })
    c.advance(60_000)
  }
  const s = h.series('player1', RANGES['24h'], { at: c.now() })
  assert.ok(s.points.length <= 180, `${s.points.length} <= 180`)
  assert.ok(s.points.length >= 170)
  assert.equal(s.points[s.points.length - 1][1], 1439)
  assert.equal(s.total, 1440, 'total counts the unfiltered points in the window')
})

test('series: tab values are positional against the shared name dictionary', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 300, cdRatio: 200, tabs: { A: 100, B: 200 } })
  c.advance(60_000)
  await h.append('player1', { totalChaos: 450, cdRatio: 200, tabs: { B: 200, C: 250 } }) // A gone, C new
  const s = h.series('player1', RANGES['1h'], { at: c.now() })
  assert.deepEqual(s.tabs, ['A', 'B', 'C'])
  assert.deepEqual(s.points[0][3], [100, 200, 0])
  assert.deepEqual(s.points[1][3], [0, 200, 250])
})

test('series keeps users apart', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 1000, cdRatio: 200, tabs: { A: 1000 } })
  await h.append('player2', { totalChaos: 7, cdRatio: 200, tabs: { Secret: 7 } })
  const s = h.series('player1', RANGES['24h'], { at: c.now() })
  assert.deepEqual(s.points.map(p => p[1]), [1000])
  assert.deepEqual(s.tabs, ['A'], 'tab names of other users never show up')
})

test('not writable (/config missing) -> memory only, no throw', async () => {
  const c = clock()
  const h = createNetworthHistory('/definitely/not/there/hist.ndjson', { now: c.now })
  h.writable = false
  await h.load()
  assert.equal(await h.append('player1', { totalChaos: 5, cdRatio: 200, tabs: {} }), true)
  assert.equal(h.points.length, 1)
})

test('a write error does not kill the refresher', async () => {
  const c = clock()
  const h = createNetworthHistory('/definitely/not/there/hist.ndjson', { now: c.now })
  await h.load()
  assert.equal(await h.append('player1', { totalChaos: 5, cdRatio: 200, tabs: {} }), true)
})

test('downsample: empty/short lists stay unchanged', () => {
  assert.deepEqual(downsample([], 10), [])
  const three = [{ at: 1 }, { at: 2 }, { at: 3 }]
  assert.deepEqual(downsample(three, 10), three)
  assert.deepEqual(downsample(three, 1), three, 'max < 2 -> unchanged')
})

// Size evidence: the real worst case (115 tabs, ~40 of them worth >=1c) over the
// full 48h retention at one point per minute.
test('file size stays bounded (48h x 1/min, 40 valued tabs)', async () => {
  const c = clock()
  const file = await tmpFile()
  const h = createNetworthHistory(file, { now: c.now })
  await h.load()
  const tabs = {}
  for (let i = 0; i < 115; i++) tabs[`Stash Tab ${i}`] = i < 40 ? 1000 + i * 37.5 : 0.2
  for (let i = 0; i < 48 * 60; i++) {
    await h.append('player1', { totalChaos: 500000 + i, cdRatio: 215, tabs })
    c.advance(60_000)
  }
  const bytes = (await readFile(file, 'utf8')).length
  const perPoint = bytes / (48 * 60)
  assert.ok(h.points.length <= 48 * 60 + 1)
  assert.ok(perPoint < 900, `per point ${perPoint.toFixed(0)} B`)
  assert.ok(bytes < 3.5 * 1024 * 1024, `file ${(bytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(`[size] 48h x 1/min, 40 valued tabs: ${(bytes / 1024 / 1024).toFixed(2)} MB (${perPoint.toFixed(0)} B/point)`)
  // And delivery is decoupled from that: once downsampled the 24h payload stays
  // small enough for a per-minute poll.
  const wire = JSON.stringify(h.series('player1', RANGES['24h'], { at: c.now() })).length
  console.log(`[size] 24h payload: ${(wire / 1024).toFixed(0)} KB`)
  assert.ok(wire < 120 * 1024, `payload ${(wire / 1024).toFixed(0)} KB`)
})
