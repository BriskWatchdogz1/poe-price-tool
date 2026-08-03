// Local tests for the item deltas of the net-worth history (gitignored).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthHistory, buildDelta, foldItems, mergeDeltas, DELTA_TOP_N } from './history.mjs'

async function tmpFile (name = 'nw.ndjson') {
  const dir = await mkdtemp(join(tmpdir(), 'nwdelta-'))
  return join(dir, name)
}
function clock (start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, advance: ms => { t += ms } }
}
const items = (...rows) => rows.map(([name, qty, chaosTotal]) => ({ name, qty, chaosTotal }))
const sum = arr => Math.round(arr.reduce((s, v) => s + v, 0) * 10) / 10

test('quantity and price are kept cleanly apart', () => {
  const prev = foldItems(items(['Divine Orb', 10, 1200], ['Chaos Orb', 100, 100]))
  const cur = foldItems(items(['Divine Orb', 12, 1500], ['Chaos Orb', 100, 100]))
  // Divine: 10@120 -> 12@125. Quantity +2 @125 = +250, price 10*(125-120) = +50, total +300
  const d = buildDelta(prev, cur, { at: 1, c: 1300, cd: 120 }, 1600)
  const div = d.i.find(r => r[0] === 'Divine Orb')
  assert.deepEqual(div, ['Divine Orb', 2, 300, 50])
})

test('pure price move: quantity 0, the whole amount is the price share', () => {
  const prev = foldItems(items(['Mageblood', 1, 1000]))
  const cur = foldItems(items(['Mageblood', 1, 1400]))
  const d = buildDelta(prev, cur, { at: 1, c: 1000, cd: 200 }, 1400)
  assert.deepEqual(d.i[0], ['Mageblood', 0, 400, 400])
})

test('new item: all quantity, no price share — a vanished item likewise', () => {
  const a = buildDelta(foldItems([]), foldItems(items(['Headhunter', 1, 800])), { at: 1, c: 0, cd: 200 }, 800)
  assert.deepEqual(a.i[0], ['Headhunter', 1, 800, 0])
  const b = buildDelta(foldItems(items(['Headhunter', 1, 800])), foldItems([]), { at: 1, c: 800, cd: 200 }, 0)
  assert.deepEqual(b.i[0], ['Headhunter', -1, -800, 0])
})

test('top-N + the rest bucket add up to exactly the total delta', () => {
  const prevRows = []
  const curRows = []
  for (let i = 0; i < 40; i++) {
    prevRows.push([`Item ${i}`, 1, 10])
    curRows.push([`Item ${i}`, 1, 10 + (i + 1) * 0.7]) // 40 changes, small to large
  }
  const prev = foldItems(items(...prevRows))
  const cur = foldItems(items(...curRows))
  const total = 40 * 10 + sum(curRows.map(r => r[2] - 10))
  const d = buildDelta(prev, cur, { at: 1, c: 400, cd: 200 }, Math.round(total * 10) / 10)
  assert.equal(d.i.length, DELTA_TOP_N, 'at most top-N are stored')
  const shown = sum(d.i.map(r => r[2]))
  assert.ok(d.r, 'rest bucket present')
  assert.equal(Math.round((shown + d.r[1]) * 10) / 10, Math.round((total - 400) * 10) / 10)
  assert.ok(d.r[0] > 0, 'the rest bucket counts the omitted changes')
})

test('anchor: prev at/total/cd are carried in the delta', () => {
  const d = buildDelta(foldItems([]), foldItems(items(['X', 1, 5])), { at: 4711, c: 100, cd: 210 }, 105)
  assert.equal(d.p, 4711); assert.equal(d.pt, 100); assert.equal(d.pc, 210)
})

test('the first point has no delta, the second one does', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 100, cdRatio: 200, tabs: {}, items: items(['Chaos Orb', 100, 100]) })
  assert.equal(h.points[0].d, undefined)
  c.advance(60_000)
  await h.append('player1', { totalChaos: 300, cdRatio: 200, tabs: {}, items: items(['Chaos Orb', 100, 100], ['Divine Orb', 1, 200]) })
  assert.ok(h.points[1].d)
  assert.deepEqual(h.points[1].d.i[0], ['Divine Orb', 1, 200, 0])
})

test('without items[] no delta is written (an old caller stays intact)', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 100, cdRatio: 200, tabs: {}, items: items(['A', 1, 100]) })
  c.advance(60_000)
  await h.append('player1', { totalChaos: 150, cdRatio: 200, tabs: {} })       // without items
  c.advance(60_000)
  await h.append('player1', { totalChaos: 200, cdRatio: 200, tabs: {}, items: items(['A', 2, 200]) })
  assert.equal(h.points[1].d, undefined)
  assert.equal(h.points[2].d, undefined, 'no invented delta after a gap')
})

test('lines stay readable and the delta survives a restart load', async () => {
  const c = clock()
  const file = await tmpFile()
  const h = createNetworthHistory(file, { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 100, cdRatio: 200, tabs: { A: 100 }, items: items(['A', 1, 100]) })
  c.advance(60_000)
  await h.append('player1', { totalChaos: 260, cdRatio: 200, tabs: { A: 260 }, items: items(['A', 2, 260]) })
  const raw = await readFile(file, 'utf8')
  const lines = raw.trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines[0].d, undefined)
  assert.ok(Array.isArray(lines[1].d.i))
  const h2 = createNetworthHistory(file, { now: c.now })
  await h2.load()
  assert.equal(h2.points.length, 2)
  assert.ok(h2.points[1].d)
})

// ---- detail(): mapping intervals across the downsampling -------------------

async function seeded () {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  // 5 points, +1 Divine Orb (200c) each, rate constant
  let qty = 0
  const at = []
  for (let i = 0; i < 5; i++) {
    await h.append('player1', {
      totalChaos: qty * 200, cdRatio: 200, tabs: {}, items: items(['Divine Orb', qty, qty * 200])
    })
    at.push(h.points[h.points.length - 1].at)
    qty++
    c.advance(60_000)
  }
  return { h, at }
}

test('detail() sums up every raw point of the clicked interval', async () => {
  const { h, at } = await seeded()
  // Click on the last point, the drawn predecessor is at[1] -> the interval
  // covers the points at[2], at[3], at[4] = 3 Divine gained
  const d = h.detail('player1', at[1], at[4])
  assert.equal(d.points, 3)
  assert.equal(d.recorded, 3)
  assert.equal(d.items[0].name, 'Divine Orb')
  assert.equal(d.items[0].qty, 3)
  assert.equal(d.items[0].value, 600)
  assert.equal(d.items[0].price, 0)
  assert.equal(d.total, 600)
  assert.equal(d.from, at[1], 'interval start = anchor time of the first raw point')
  assert.equal(d.to, at[4])
  assert.equal(d.unexplained, 0)
})

test('detail() of a single point shows only that one minute', async () => {
  const { h, at } = await seeded()
  const d = h.detail('player1', at[3], at[4])
  assert.equal(d.points, 1)
  assert.equal(d.items[0].qty, 1)
  assert.equal(d.total, 200)
})

test('detail() without delta data says so honestly instead of coming back empty', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 100, cdRatio: 200, tabs: {} }) // old line without items
  const p = h.points[0]
  const d = h.detail('player1', p.at - 1, p.at)
  assert.equal(d.detail, false)
  assert.deepEqual(d.items, [])
  assert.equal(d.recorded, 0)
})

test('detail() with partially missing deltas flags partial + unexplained', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now })
  await h.load()
  await h.append('player1', { totalChaos: 0, cdRatio: 200, tabs: {}, items: items(['A', 0, 0]) })
  c.advance(60_000)
  await h.append('player1', { totalChaos: 100, cdRatio: 200, tabs: {}, items: items(['A', 1, 100]) })
  c.advance(60_000)
  await h.append('player1', { totalChaos: 300, cdRatio: 200, tabs: {} }) // gap: no delta
  const from = h.points[0].at
  const to = h.points[2].at
  const d = h.detail('player1', from, to)
  assert.equal(d.partial, true)
  assert.equal(d.total, 300)
  assert.equal(d.unexplained, 200, 'the unrecorded movement is reported, not hidden')
})

test('detail() outside any recording returns null', async () => {
  const { h, at } = await seeded()
  assert.equal(h.detail('player1', at[4] + 1, at[4] + 1000), null)
  assert.equal(h.detail('player1', NaN, 5), null)
  assert.equal(h.detail('other', at[0], at[4]), null)
})

test('mergeDeltas sums quantity, value and price share and re-trims', () => {
  const a = { p: 1, pt: 0, pc: 200, i: [['X', 1, 100, 0], ['Y', 0, 30, 30]] }
  const b = { p: 2, pt: 100, pc: 200, i: [['X', 1, 120, 20], ['Y', 0, -10, -10]], r: [2, 5] }
  const m = mergeDeltas([a, b], 245)
  const x = m.items.find(i => i.name === 'X')
  assert.deepEqual([x.qty, x.value, x.price], [2, 220, 20])
  const y = m.items.find(i => i.name === 'Y')
  assert.deepEqual([y.qty, y.value, y.price], [0, 20, 20])
  assert.equal(m.rest.count, 2)
  assert.equal(m.rest.value, 5)
  assert.equal(m.unexplained, 0, '245 - 0 = 100+120+30-10+5')
})

test('downsampling: the intervals of the drawn points cover the curve with no gaps and no overlaps', async () => {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now, maxPoints: 12 })
  await h.load()
  let qty = 0
  for (let i = 0; i < 120; i++) {
    await h.append('player1', {
      totalChaos: qty * 7, cdRatio: 200, tabs: {}, items: items(['Chaos Orb', qty, qty * 7])
    })
    qty += (i % 3) + 1
    c.advance(60_000)
  }
  const s = h.series('player1', 24 * 3600e3, { at: c.now() })
  assert.ok(s.points.length <= 12 && s.points.length >= 5)

  // For every drawn point from the second on: interval = (predecessor, point]
  let summed = 0
  let qtySummed = 0
  for (let i = 1; i < s.points.length; i++) {
    const d = h.detail('player1', s.points[i - 1][0], s.points[i][0])
    summed += d.total
    qtySummed += d.items.reduce((acc, it) => acc + it.qty, 0)
    assert.equal(d.unexplained, 0, 'no unexplained remainder inside an interval')
  }
  const first = s.points[0][1]
  const last = s.points[s.points.length - 1][1]
  assert.equal(Math.round(summed * 10) / 10, Math.round((last - first) * 10) / 10,
    'sum of the interval deltas == total movement of the drawn curve')
  const totalQty = h.points[h.points.length - 1].t && 0
  assert.equal(qtySummed, (last - first) / 7, 'quantities add up exactly as well')
})
