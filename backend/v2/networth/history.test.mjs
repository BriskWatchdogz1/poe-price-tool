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

test('throttle: at most one point per minute and user', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()

  assert.equal(await h.append('player1', { totalChaos: 100, cdRatio: 200 }), true)
  c.advance(30_000)
  assert.equal(await h.append('player1', { totalChaos: 110, cdRatio: 200 }), false, '30s -> dropped')
  c.advance(29_999)
  assert.equal(await h.append('player1', { totalChaos: 120, cdRatio: 200 }), false, '59.999s -> dropped')
  c.advance(1)
  assert.equal(await h.append('player1', { totalChaos: 130, cdRatio: 200 }), true, '60s -> accepted')
  assert.equal(h.points.length, 2)
})

test('the throttle is PER USER — player2 does not block player1', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  assert.equal(await h.append('player1', { totalChaos: 100, cdRatio: 200 }), true)
  assert.equal(await h.append('player2', { totalChaos: 50, cdRatio: 200 }), true)
  assert.equal(await h.append('player1', { totalChaos: 101, cdRatio: 200 }), false)
  assert.equal(h.points.filter(p => p.u === 'player2').length, 1)
})

test('a point holds time, chaos and the historical div rate — nothing else', async () => {
  const c = clock()
  const file = await tmpFile()
  const h = createNetworthHistory(file, { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 1540.55, cdRatio: 215 })

  const line = JSON.parse((await readFile(file, 'utf8')).trim())
  assert.equal(line.u, 'player1')
  assert.equal(line.at, c.now())
  assert.equal(line.c, 1540.6)                       // round1
  assert.equal(line.cd, 215)                         // the rate AT THAT MOMENT
  // No per-tab breakdown any more, and no account identifier in the clear:
  // only the local routing name.
  assert.equal(Object.keys(line).sort().join(','), 'at,c,cd,u')
})

test('div reconstruction uses the historical rate, not the current one', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 2000, cdRatio: 200 }) // = 10 div back then
  c.advance(60_000)
  await h.append('player1', { totalChaos: 2000, cdRatio: 400 }) // = 5 div today

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
  await h.append('player1', { totalChaos: 1, cdRatio: 200 })
  c.advance(49 * 3600e3)
  await h.append('player1', { totalChaos: 2, cdRatio: 200 })
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
  await a.append('player1', { totalChaos: 100, cdRatio: 200 })
  c.advance(60_000)
  await a.append('player1', { totalChaos: 200, cdRatio: 210 })

  const b = createNetworthHistory(file, { now: c.now }) // the "restart"
  await b.load()
  assert.deepEqual(b.points.map(p => p.c), [100, 200])
  // and keeps appending cleanly (the throttle knows the last point from the file)
  assert.equal(await b.append('player1', { totalChaos: 300, cdRatio: 210 }), false)
  c.advance(60_000)
  assert.equal(await b.append('player1', { totalChaos: 300, cdRatio: 210 }), true)
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3)
})

test('range filtering 1h/6h/24h returns exactly the matching points', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  const start = c.now()
  for (let i = 0; i < 30 * 60; i++) {          // 30h, one point per minute
    await h.append('player1', { totalChaos: i, cdRatio: 200 })
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
    await h.append('player1', { totalChaos: i, cdRatio: 200 })
    c.advance(60_000)
  }
  const s = h.series('player1', RANGES['24h'], { at: c.now() })
  assert.ok(s.points.length <= 180, `${s.points.length} <= 180`)
  assert.ok(s.points.length >= 170)
  assert.equal(s.points[s.points.length - 1][1], 1439)
  assert.equal(s.total, 1440, 'total counts the unfiltered points in the window')
})

test('series: a point is exactly [at, chaos, cd] — no per-tab column', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 300, cdRatio: 200 })
  c.advance(60_000)
  await h.append('player1', { totalChaos: 450, cdRatio: 200 })
  const s = h.series('player1', RANGES['1h'], { at: c.now() })
  assert.deepEqual(s.points, [[c.now() - 60_000, 300, 200], [c.now(), 450, 200]])
  assert.equal('tabs' in s, false, 'the tab key dictionary is gone from the wire format')
})

// The per-tab breakdown `t` was dropped from the line (42% of it, unread since
// the header sparkline went). Lines already on disk still have it and must keep
// counting — a point is never skipped over a field nobody asks for.
test('recorded lines that still carry the old per-tab breakdown are read normally', async () => {
  const c = clock()
  const file = await tmpFile()
  const now = c.now()
  await writeFile(file, [
    { u: 'player1', at: now - 3 * 60e3, c: 100, cd: 200, t: { 3: 60, 7: 40 } },   // by index
    { u: 'player1', at: now - 2 * 60e3, c: 150, cd: 200, t: { Currency: 150 } },  // by name (older still)
    { u: 'player1', at: now - 1 * 60e3, c: 200, cd: 200 }                         // written today
  ].map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8')

  const h = createNetworthHistory(file, { now: c.now })
  await h.load()
  assert.deepEqual(h.points.map(p => p.c), [100, 150, 200], 'no legacy line is dropped')
  assert.deepEqual(h.points[0].t, { 3: 60, 7: 40 }, 'the field is ignored, not stripped')

  const s = h.series('player1', RANGES['1h'], { at: now })
  assert.deepEqual(s.points, [[now - 3 * 60e3, 100, 200], [now - 2 * 60e3, 150, 200], [now - 1 * 60e3, 200, 200]])
  assert.equal('tabs' in s, false)

  // Appending on top of them works, and the new line does not resurrect `t`.
  assert.equal(await h.append('player1', { totalChaos: 250, cdRatio: 200 }), true)
  const last = JSON.parse((await readFile(file, 'utf8')).trim().split('\n').pop())
  assert.equal(last.c, 250)
  assert.equal('t' in last, false)
})

test('series keeps users apart', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 1000, cdRatio: 200 })
  await h.append('player2', { totalChaos: 7, cdRatio: 200 })
  const s = h.series('player1', RANGES['24h'], { at: c.now() })
  assert.deepEqual(s.points.map(p => p[1]), [1000], 'no point of another user leaks in')
})

test('not writable (/config missing) -> memory only, no throw', async () => {
  const c = clock()
  const h = createNetworthHistory('/definitely/not/there/hist.ndjson', { now: c.now })
  h.writable = false
  await h.load()
  assert.equal(await h.append('player1', { totalChaos: 5, cdRatio: 200 }), true)
  assert.equal(h.points.length, 1)
})

test('a write error does not kill the refresher', async () => {
  const c = clock()
  const h = createNetworthHistory('/definitely/not/there/hist.ndjson', { now: c.now })
  await h.load()
  assert.equal(await h.append('player1', { totalChaos: 5, cdRatio: 200 }), true)
})

test('downsample: empty/short lists stay unchanged', () => {
  assert.deepEqual(downsample([], 10), [])
  const three = [{ at: 1 }, { at: 2 }, { at: 3 }]
  assert.deepEqual(downsample(three, 10), three)
  assert.deepEqual(downsample(three, 1), three, 'max < 2 -> unchanged')
})

// Size evidence: a full 48h of retention at one point per minute, with the item
// delta of a busy stash on every point (that is what dominates a line now that
// the per-tab breakdown is gone).
test('file size stays bounded (48h x 1/min, with item deltas)', async () => {
  const c = clock()
  const file = await tmpFile()
  const h = createNetworthHistory(file, { now: c.now })
  await h.load()
  for (let i = 0; i < 48 * 60; i++) {
    const items = []
    for (let k = 0; k < 40; k++) items.push({ name: `Some Currency Item ${k}`, qty: i + k, chaosTotal: (i + k) * 37.5 })
    await h.append('player1', { totalChaos: 500000 + i, cdRatio: 215, items })
    c.advance(60_000)
  }
  const bytes = (await readFile(file, 'utf8')).length
  const perPoint = bytes / (48 * 60)
  assert.ok(h.points.length <= 48 * 60 + 1)
  assert.ok(perPoint < 900, `per point ${perPoint.toFixed(0)} B`)
  assert.ok(bytes < 3.5 * 1024 * 1024, `file ${(bytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(`[size] 48h x 1/min, item deltas: ${(bytes / 1024 / 1024).toFixed(2)} MB (${perPoint.toFixed(0)} B/point)`)
  // And delivery is decoupled from that: once downsampled the 24h payload stays
  // small enough for a per-minute poll.
  const wire = JSON.stringify(h.series('player1', RANGES['24h'], { at: c.now() })).length
  console.log(`[size] 24h payload: ${(wire / 1024).toFixed(0)} KB`)
  assert.ok(wire < 120 * 1024, `payload ${(wire / 1024).toFixed(0)} KB`)
})
