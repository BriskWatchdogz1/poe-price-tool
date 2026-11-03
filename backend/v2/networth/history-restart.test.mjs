// Local tests: the item listing survives a restart (gitignored).
//
// The core: a container restart must not tear a hole into the breakdown — the
// first point after the restart has to carry a `d`. Plus the empty cases that
// remain even with a sidecar file (very first point, legacy lines).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createNetworthHistory } from './history.mjs'
import { createHistoryItems, defaultItemsPath } from './history-items.mjs'
import { createPriceGuard } from './price-guard.mjs'

async function tmpDir () { return mkdtemp(join(tmpdir(), 'nwrestart-')) }
function clock (start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, advance: ms => { t += ms } }
}
const items = (...rows) => rows.map(([name, qty, chaosTotal]) => ({ name, qty, chaosTotal }))

// A fresh instance on the same directory = a process restart.
async function boot (file, c) {
  const h = createNetworthHistory(file, { now: c.now })
  await h.load()
  return h
}

test('restart: the first point afterwards carries a breakdown', async () => {
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')

  const h1 = await boot(file, c)
  assert.equal(await h1.append('player1', {
    totalChaos: 1200, cdRatio: 200,
    items: items(['Divine Orb', 10, 1200])
  }), true)

  // --- restart ---
  c.advance(60_000)
  const h2 = await boot(file, c)
  assert.equal(await h2.append('player1', {
    totalChaos: 1560, cdRatio: 200,
    items: items(['Divine Orb', 13, 1560])
  }), true)

  const last = h2.points[h2.points.length - 1]
  assert.ok(last.d, 'the first point after the restart has a delta')
  assert.deepEqual(last.d.i[0], ['Divine Orb', 3, 360, 0])
  assert.equal(last.d.pt, 1200, 'the anchor is the point BEFORE the restart')

  // And the panel gets real rows instead of an empty case.
  const det = h2.detail('player1', last.d.p, last.at)
  assert.equal(det.detail, true)
  assert.equal(det.items[0].name, 'Divine Orb')
  assert.equal(det.total, 360)
})

test('the point line stays unchanged — the listing lives next to it', async () => {
  const c = clock()
  const dir = await tmpDir()
  const file = join(dir, 'networth-history.ndjson')
  const h = await boot(file, c)
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, items: items(['Divine Orb', 10, 1200]) })

  const line = JSON.parse((await readFile(file, 'utf8')).trim())
  assert.equal(Object.keys(line).sort().join(','), 'at,c,cd,u', 'no new field in the NDJSON line')

  const side = JSON.parse(await readFile(defaultItemsPath(file), 'utf8'))
  assert.equal(side.v, 1)
  assert.equal(side.u.player1.at, line.at, 'the sidecar file is anchored to the point')
  assert.deepEqual(side.u.player1.i, [['Divine Orb', 10, 1200]])
})

test('legacy lines without the new field stay readable', async () => {
  const c = clock(1_700_000_000_000)
  const dir = await tmpDir()
  const file = join(dir, 'networth-history.ndjson')
  // Two legacy lines exactly as they already sit in /config today (one entirely
  // without `d`, one with) — and NO sidecar file.
  const t0 = c.now() - 120_000
  const t1 = c.now() - 60_000
  await writeFile(file,
    JSON.stringify({ u: 'player1', at: t0, c: 1000, cd: 200, t: { 1: 1000 } }) + '\n' +
    JSON.stringify({ u: 'player1', at: t1, c: 1100, cd: 200, t: { 1: 1100 }, d: { p: t0, pt: 1000, pc: 200, i: [['Chaos Orb', 100, 100, 0]] } }) + '\n',
    'utf8')

  const h = await boot(file, c)
  assert.equal(h.points.length, 2, 'both legacy lines loaded')
  assert.equal(h.lastAt('player1'), t1)
  const det = h.detail('player1', t0, t1)
  assert.equal(det.detail, true)
  assert.equal(det.items[0].name, 'Chaos Orb')

  // Without a sidecar file there is no listing for the last point -> the next
  // point still has none, but the one after that does again.
  c.advance(60_000)
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, items: items(['Chaos Orb', 200, 200]) })
  assert.equal(h.points[2].d, undefined, 'first point after legacy data has no delta')
  c.advance(60_000)
  await h.append('player1', { totalChaos: 1300, cdRatio: 200, items: items(['Chaos Orb', 300, 300]) })
  assert.ok(h.points[3].d, 'with a delta again afterwards')
})

test('very first point: the panel reports missing comparison data (start=true)', async () => {
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const h = await boot(file, c)
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, items: items(['Divine Orb', 10, 1200]) })

  const at = h.lastAt('player1')
  const det = h.detail('player1', at - 1, at)
  assert.equal(det.detail, false)
  assert.equal(det.start, true, 'oldest point -> there simply is no predecessor')
  assert.deepEqual(det.items, [])
})

test('"nothing changed" stays distinguishable from the empty case', async () => {
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const h = await boot(file, c)
  const rows = items(['Divine Orb', 10, 1200])
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, items: rows })
  c.advance(60_000)
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, items: rows })

  const [a, b] = h.points
  const det = h.detail('player1', a.at, b.at)
  assert.equal(det.detail, true, 'a comparison exists')
  assert.equal(det.start, undefined)
  assert.deepEqual(det.items, [], 'but nothing moved')
  assert.equal(det.total, 0)
})

test('a sidecar file without a matching anchor is discarded instead of misattributed', async () => {
  const c = clock()
  const dir = await tmpDir()
  const file = join(dir, 'networth-history.ndjson')
  const h1 = await boot(file, c)
  await h1.append('player1', { totalChaos: 1200, cdRatio: 200, items: items(['Divine Orb', 10, 1200]) })

  // Bend the sidecar timestamp by hand (half-written state, the point append
  // failed, retention ate the anchor …).
  const sidePath = defaultItemsPath(file)
  const doc = JSON.parse(await readFile(sidePath, 'utf8'))
  doc.u.player1.at += 1
  await writeFile(sidePath, JSON.stringify(doc), 'utf8')

  c.advance(60_000)
  const h2 = await boot(file, c)
  await h2.append('player1', { totalChaos: 9999, cdRatio: 200, items: items(['Divine Orb', 80, 9999]) })
  assert.equal(h2.points[1].d, undefined, 'rather no delta at all than a misattributed one')
})

test('broken sidecar file = empty instead of a crash', async () => {
  const c = clock()
  const dir = await tmpDir()
  const file = join(dir, 'networth-history.ndjson')
  const h1 = await boot(file, c)
  await h1.append('player1', { totalChaos: 1200, cdRatio: 200, items: items(['Divine Orb', 10, 1200]) })
  await writeFile(defaultItemsPath(file), '{"v":1,"u":{"player1":{"at":', 'utf8') // truncated

  c.advance(60_000)
  const h2 = await boot(file, c)
  assert.equal(h2.points.length, 1, 'the series is undamaged')
  assert.equal(await h2.append('player1', { totalChaos: 1300, cdRatio: 200, items: items(['Divine Orb', 11, 1300]) }), true)
  assert.equal(h2.points[1].d, undefined)
})

test('a missing sidecar file and garbage contents never throw', async () => {
  const dir = await tmpDir()
  const p = join(dir, 'nope.json')
  const a = createHistoryItems(p)
  assert.equal((await a.load()).size, 0)
  await writeFile(p, JSON.stringify({ v: 1, u: { player1: { at: 'nope', i: [] }, player2: { at: 5, i: 'nope' }, ok: { at: 7, i: [['X', 1, 2], 'junk', ['Y', null, 3]] } } }), 'utf8')
  const b = createHistoryItems(p)
  const got = await b.load()
  assert.deepEqual([...got.keys()], ['ok'])
  assert.deepEqual([...got.get('ok').items], [['X', [1, 2]], ['Y', [0, 3]]])
})

test('unwritable /config: silently disabled, the series keeps running', async () => {
  const c = clock()
  const dir = await tmpDir()
  const file = join(dir, 'networth-history.ndjson')
  const h = createNetworthHistory(file, { now: c.now })
  await h.load()
  h.writable = false // what server.mjs sets when /config cannot be created
  assert.equal(await h.append('player1', { totalChaos: 1200, cdRatio: 200, items: items(['Divine Orb', 10, 1200]) }), true)
  await assert.rejects(stat(defaultItemsPath(file)), 'no sidecar file written')
  // In memory the comparison still runs.
  c.advance(60_000)
  await h.append('player1', { totalChaos: 1560, cdRatio: 200, items: items(['Divine Orb', 13, 1560]) })
  assert.ok(h.points[1].d)
})

test('a sidecar write error does not take the history down with it', async () => {
  const c = clock()
  const dir = await tmpDir()
  const file = join(dir, 'networth-history.ndjson')
  const h = await boot(file, c)
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, items: items(['Divine Orb', 10, 1200]) })
  await chmod(dir, 0o555) // directory sealed: no tmp file can be created any more
  try {
    c.advance(60_000)
    assert.equal(await h.append('player1', { totalChaos: 1300, cdRatio: 200, items: items(['Divine Orb', 11, 1300]) }), true)
    assert.equal(h.points.length, 2)
  } finally {
    await chmod(dir, 0o755)
  }
})

// --- the price guard's memory across a restart (guard-state.mjs) ------------
// A fresh history AND a fresh guard on the same directory = a process restart.
async function bootGuarded (file, c, lines, opts = {}) {
  const priceGuard = createPriceGuard({ now: c.now, log: (...a) => lines.push(a[0]) })
  const h = createNetworthHistory(file, { now: c.now, priceGuard, log: { warn: m => lines.push(m), log: m => lines.push(m) }, ...opts })
  await h.load()
  return h
}

test('restart: a name that left the stash is still judged against the remembered price', async () => {
  for (const persisted of [true, false]) {
    const c = clock()
    const dir = await tmpDir()
    const file = join(dir, 'networth-history.ndjson')
    // The counter-proof writes its memory where nothing can be written.
    const opts = persisted ? {} : { guardStatePath: join(dir, 'no-such-dir', 'guard.json') }
    const lines = []
    const h1 = await bootGuarded(file, c, lines, opts)
    // Two points with Card B: the guard runs from the second point on (it
    // needs a previous breakdown) and remembers the 1c it let through there.
    await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card B', 1, 1], ['Rest', 1, 99]) })
    c.advance(60_000)
    await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card B', 1, 1], ['Rest', 1, 99]) })
    c.advance(60_000)
    await h1.append('player1', { totalChaos: 99, cdRatio: 200, items: items(['Rest', 1, 99]) })

    // --- restart ---
    c.advance(60_000)
    const h2 = await bootGuarded(file, c, lines, opts)
    await h2.append('player1', { totalChaos: 159, cdRatio: 200, items: items(['Rest', 1, 99], ['Card B', 1, 60]) })
    const last = h2.points.at(-1)
    if (persisted) {
      assert.equal(last.c, 100, 'Card B stays at its remembered 1c')
      assert.ok(lines.some(l => /implausible price jump/.test(l)))
    } else {
      assert.equal(last.c, 159, 'without the memory file the 60c went into the series — the gap this closes')
    }
  }
})

test('restart: a name the sidecar carried and that is gone on the first point afterwards keeps its reference', async () => {
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const lines = []
  const h1 = await bootGuarded(file, c, lines)
  await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card B', 1, 1], ['Rest', 1, 99]) })
  c.advance(60_000)
  await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card B', 1, 1], ['Rest', 1, 99]) })

  // --- restart --- (Card B is in the sidecar, so it is not in the guard file)
  c.advance(60_000)
  const h2 = await bootGuarded(file, c, lines)
  await h2.append('player1', { totalChaos: 99, cdRatio: 200, items: items(['Rest', 1, 99]) })
  c.advance(60_000)
  await h2.append('player1', { totalChaos: 159, cdRatio: 200, items: items(['Rest', 1, 99], ['Card B', 1, 60]) })
  assert.equal(h2.points.at(-1).c, 100)
  assert.ok(lines.some(l => /implausible price jump/.test(l)))
})

test('restart: a sidecar this process leaves alone does not take names out of the guard memory', async () => {
  // A sidecar from a newer release is left as it is and never written. The
  // guard file then has to keep the prices of every name itself: the sidecar
  // carries none of them after the restart.
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const sidecar = JSON.stringify({ v: 2, u: {} })
  await writeFile(defaultItemsPath(file), sidecar)
  const lines = []
  const h1 = await bootGuarded(file, c, lines)
  await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card B', 1, 1], ['Rest', 1, 99]) })
  c.advance(60_000)
  await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card B', 1, 1], ['Rest', 1, 99]) })

  // --- restart ---
  c.advance(60_000)
  const h2 = await bootGuarded(file, c, lines)
  await h2.append('player1', { totalChaos: 99, cdRatio: 200, items: items(['Rest', 1, 99]) })
  c.advance(60_000)
  await h2.append('player1', { totalChaos: 159, cdRatio: 200, items: items(['Rest', 1, 99], ['Card B', 1, 60]) })
  assert.equal(h2.points.at(-1).c, 100, 'Card B stays at its remembered 1c')
  assert.ok(lines.some(l => /implausible price jump/.test(l)))
  assert.equal(await readFile(defaultItemsPath(file), 'utf8'), sidecar, 'the newer sidecar is untouched')
})

// A sidecar write that fails (a full disk, a read-only volume) leaves the file
// of the point before on disk, and a restart drops it: it is not anchored on
// the newest point. The guard file written at that point must not leave any
// name to it. The seam fails only the sidecar's tmp write; the series and the
// guard file are written as usual.
function failingSidecarWrite () {
  const w = { fail: false }
  w.writeFileImpl = async (...a) => {
    if (w.fail) { const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e }
    return writeFile(...a)
  }
  return w
}

test('restart: a sidecar write that fails after a point does not take names out of the guard memory', async () => {
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const w = failingSidecarWrite()
  const lines = []
  const h1 = await bootGuarded(file, c, lines, { itemsSeams: { writeFileImpl: w.writeFileImpl } })
  await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card B', 1, 1], ['Rest', 1, 99]) })
  const before = h1.points.at(-1).at
  c.advance(60_000)
  w.fail = true
  // The guard runs here and remembers Card B at 1c; the sidecar write fails.
  assert.equal(await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card B', 1, 1], ['Rest', 1, 99]) }), true)
  assert.equal(JSON.parse(await readFile(defaultItemsPath(file), 'utf8')).u.player1.at, before, 'the sidecar on disk is still the one of the point before')

  // --- restart --- (that sidecar is not anchored on the newest point)
  c.advance(60_000)
  const h2 = await bootGuarded(file, c, lines)
  await h2.append('player1', { totalChaos: 99, cdRatio: 200, items: items(['Rest', 1, 99]) })
  c.advance(60_000)
  await h2.append('player1', { totalChaos: 159, cdRatio: 200, items: items(['Rest', 1, 99], ['Card B', 1, 60]) })
  assert.equal(h2.points.at(-1).c, 100, 'Card B stays at its remembered 1c')
  assert.ok(lines.some(l => /implausible price jump/.test(l)))
})

test('restart: a sidecar write that fails after a change of tabs does not take names out of the guard memory', async () => {
  // The other call site: a change in the set of stash tabs drops player1's
  // breakdown and writes the sidecar and the guard file without a point. Its
  // gap needs a failed write after a point first: when only the write at the
  // change of tabs fails, the sidecar of the point before is still anchored
  // and a restart uses it. Here player2's point fails to write the sidecar,
  // then the write at the change of tabs fails as well; the guard file must
  // still keep player2's names, because the sidecar on disk holds player2 at
  // an older point and is dropped for him.
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const w = failingSidecarWrite()
  const lines = []
  const h1 = await bootGuarded(file, c, lines, { itemsSeams: { writeFileImpl: w.writeFileImpl } })
  for (let k = 0; k < 2; k++) {
    if (k) c.advance(60_000)
    await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card B', 1, 1], ['Rest', 1, 99]) })
    await h1.append('player2', { totalChaos: 100, cdRatio: 200, items: items(['Card X', 1, 1], ['Rest', 1, 99]) })
  }
  const before = h1.points.at(-1).at
  c.advance(60_000)
  w.fail = true
  await h1.append('player2', { totalChaos: 100, cdRatio: 200, items: items(['Card X', 1, 1], ['Rest', 1, 99]) })
  assert.equal(await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Rest', 1, 99]), tabsChanged: true }), false)
  assert.equal(JSON.parse(await readFile(defaultItemsPath(file), 'utf8')).u.player2.at, before, 'the sidecar on disk is still the one of the point before')

  // --- restart ---
  c.advance(60_000)
  const h2 = await bootGuarded(file, c, lines)
  await h2.append('player2', { totalChaos: 99, cdRatio: 200, items: items(['Rest', 1, 99]) })
  c.advance(60_000)
  await h2.append('player2', { totalChaos: 159, cdRatio: 200, items: items(['Rest', 1, 99], ['Card X', 1, 60]) })
  assert.equal(h2.points.at(-1).c, 100, 'Card X stays at its remembered 1c')
  assert.ok(lines.some(l => /implausible price jump/.test(l)))
})

test('restart: a breakdown dropped at a change of tabs stays dropped when the sidecar write there failed', async () => {
  // docs/bugs.md B35. The change of tabs drops player1's breakdown and writes
  // the sidecar without it. When that write fails, the sidecar of the point
  // before stays on disk, still anchored on player1's newest point, and a
  // restart used to adopt the dropped breakdown again: the first point after
  // it diffed across the change of tabs. The guard file, written right after,
  // now records which entry on disk is stale, and the next start leaves it out.
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const w = failingSidecarWrite()
  const lines = []
  const h1 = await bootGuarded(file, c, lines, { itemsSeams: { writeFileImpl: w.writeFileImpl } })
  await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Old Tab Item', 1, 100]) })
  await h1.append('player2', { totalChaos: 50, cdRatio: 200, items: items(['Card X', 1, 50]) })
  c.advance(60_000)
  w.fail = true
  assert.equal(await h1.append('player1', { totalChaos: 160, cdRatio: 200, items: items(['Old Tab Item', 1, 100], ['New Tab Item', 1, 60]), tabsChanged: true }), false)
  assert.ok(JSON.parse(await readFile(defaultItemsPath(file), 'utf8')).u.player1, 'the stale entry is still on disk')
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dirname(file), 'networth-history-guard.json'), 'utf8')).stale), ['player1'], 'and marked as stale in the guard file')
  assert.equal(h1.latest('player1'), null, 'and out of this process')

  // --- restart ---
  c.advance(60_000)
  const h2 = await bootGuarded(file, c, lines)
  assert.equal(h2.latest('player1'), null, 'the dropped breakdown is not adopted again')
  assert.ok(h2.latest('player2'), 'the other user\'s entry is adopted as before')
  assert.ok(lines.some(l => /player1/.test(l) && /change of stash tabs/.test(l)), 'and the start says why it leaves the entry out')
  assert.equal(await h2.append('player1', { totalChaos: 160, cdRatio: 200, items: items(['Old Tab Item', 1, 100], ['New Tab Item', 1, 60]) }), true)
  assert.equal(h2.points.at(-1).d, undefined, 'the first point after the restart is the first one on the new set of tabs: no delta')
  const guardPath = join(dirname(file), 'networth-history-guard.json')
  assert.equal(JSON.parse(await readFile(guardPath, 'utf8')).stale, undefined, 'the write of that point landed, so the mark is gone from the guard file')

  // The mark ends with the next sidecar write that lands: the file then holds
  // the new point, and a further restart adopts it.
  c.advance(60_000)
  const h3 = await bootGuarded(file, c, lines)
  assert.ok(h3.latest('player1'), 'the new point\'s breakdown is adopted')
})

test('restart: without a failed write at the change of tabs nothing is marked stale', async () => {
  // The counter-proof: the same sequence with a sidecar write that lands
  // leaves no mark in the guard file, and the other user is untouched.
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const lines = []
  const h1 = await bootGuarded(file, c, lines)
  await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Old Tab Item', 1, 100]) })
  c.advance(60_000)
  await h1.append('player1', { totalChaos: 160, cdRatio: 200, items: items(['Old Tab Item', 1, 100], ['New Tab Item', 1, 60]), tabsChanged: true })
  assert.equal(JSON.parse(await readFile(defaultItemsPath(file), 'utf8')).u.player1, undefined)
  const guard = JSON.parse(await readFile(join(dirname(file), 'networth-history-guard.json'), 'utf8'))
  assert.equal(guard.stale, undefined, 'no mark in the guard file')
})

test('restart: a sidecar write that lands at a later change of tabs clears the stale mark', async () => {
  // The other branch that ends the mark: the write after a change of tabs
  // writes the whole sidecar from memory, which no longer holds the dropped
  // breakdown either. Once it lands, the entry the mark points at is gone from
  // disk, so the guard file must not carry the mark any more.
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const w = failingSidecarWrite()
  const lines = []
  const h1 = await bootGuarded(file, c, lines, { itemsSeams: { writeFileImpl: w.writeFileImpl } })
  await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Old Tab Item', 1, 100]) })
  await h1.append('player2', { totalChaos: 50, cdRatio: 200, items: items(['Card X', 1, 50]) })
  c.advance(60_000)
  const guardPath = join(dirname(file), 'networth-history-guard.json')
  w.fail = true
  await h1.append('player1', { totalChaos: 160, cdRatio: 200, items: items(['Old Tab Item', 1, 100], ['New Tab Item', 1, 60]), tabsChanged: true })
  assert.deepEqual(Object.keys(JSON.parse(await readFile(guardPath, 'utf8')).stale), ['player1'], 'the failed write sets the mark')
  w.fail = false
  await h1.append('player2', { totalChaos: 80, cdRatio: 200, items: items(['Card X', 1, 50], ['Card Y', 1, 30]), tabsChanged: true })
  const sidecar = JSON.parse(await readFile(defaultItemsPath(file), 'utf8'))
  assert.equal(sidecar.u.player1, undefined, 'the landed write took the dropped breakdown off the disk')
  assert.equal(JSON.parse(await readFile(guardPath, 'utf8')).stale, undefined, 'so the mark is gone from the guard file')
})

test('restart: a withheld arrival keeps its window instead of starting over', async () => {
  const CD = 212
  const BASE = 94 * CD
  const MOON = 55.2 * CD
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const lines = []
  const h1 = await bootGuarded(file, c, lines)
  await h1.append('player1', { totalChaos: BASE, cdRatio: CD, items: items(['Rest', 1, BASE]) })
  c.advance(60_000)
  const t0 = c.now()
  const withMoon = () => ({ totalChaos: BASE + MOON, cdRatio: CD, items: items(['Rest', 1, BASE], ['The Twilight Moon', 1, MOON]) })
  await h1.append('player1', withMoon())
  assert.equal(h1.points.at(-1).c, BASE, 'withheld at first sight')
  for (let k = 0; k < 10; k++) { c.advance(30 * 60_000); await h1.append('player1', withMoon()) } // up to t0+5h
  const withheldLines = lines.filter(l => /new item withheld/.test(l)).length
  assert.equal(withheldLines, 1)

  // --- restart, one minute down ---
  c.advance(60_000)
  const h2 = await bootGuarded(file, c, lines)
  await h2.append('player1', withMoon())            // t0+5h+1m
  c.advance(30 * 60_000)
  await h2.append('player1', withMoon())            // t0+5h+31m
  assert.equal(h2.points.at(-1).c, BASE, 'still withheld')
  c.advance(30 * 60_000)
  await h2.append('player1', withMoon())            // t0+6h+1m
  assert.equal(c.now(), t0 + 6 * 3600e3 + 60_000)
  assert.equal(h2.points.at(-1).c, Math.round((BASE + MOON) * 10) / 10, 'accepted once six observed hours stood')
  assert.ok(lines.some(l => /withheld arrival accepted/.test(l)))
  assert.equal(lines.filter(l => /new item withheld/.test(l)).length, withheldLines, 'the hold was not started over')
})

test('the guard memory sits next to the series and a read-only /config writes nothing', async () => {
  const c = clock()
  const dir = await tmpDir()
  const file = join(dir, 'networth-history.ndjson')
  const h = createNetworthHistory(file, { now: c.now })
  assert.equal(h.guardStatePath, join(dir, 'networth-history-guard.json'))
  await h.load()
  h.writable = false
  await h.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Rest', 1, 100]) })
  c.advance(60_000)
  await h.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Rest', 1, 100]) })
  await assert.rejects(stat(h.guardStatePath), 'no guard file written')

  const w = createNetworthHistory(join(dir, 'w.ndjson'), { now: c.now })
  await w.load()
  await w.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Rest', 1, 100]) })
  const doc = JSON.parse(await readFile(w.guardStatePath, 'utf8'))
  assert.equal(doc.schema_version, 1)
  assert.deepEqual(doc.users, {}, 'the one remembered price is covered by the sidecar')

  const off = createNetworthHistory(join(dir, 'off.ndjson'), { now: c.now, priceGuard: false })
  assert.equal(off.guardStatePath, null, 'no guard, no memory file')
})

test('restart into another league: the sidecar\'s prices do not enter the memory either', async () => {
  for (const league of ['Old', 'New']) {
    const c = clock()
    const file = join(await tmpDir(), 'networth-history.ndjson')
    const lines = []
    const h1 = await bootGuarded(file, c, lines, { league: 'Old' })
    await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card X', 10, 10], ['Rest', 1, 90]) })
    c.advance(60_000)
    await h1.append('player1', { totalChaos: 100, cdRatio: 200, items: items(['Card X', 10, 10], ['Rest', 1, 90]) })

    // --- restart, an hour later ---
    c.advance(3600e3)
    const guard = createPriceGuard({ now: c.now, log: (...a) => lines.push(a[0]) })
    const h2 = createNetworthHistory(file, { now: c.now, priceGuard: guard, league, log: { warn: m => lines.push(m), log: m => lines.push(m) } })
    await h2.load()
    if (league === 'Old') {
      assert.equal(guard.known.get('player1|Card X')?.price, 1, 'same league: the sidecar\'s price comes back')
      continue
    }
    assert.ok(lines.some(l => /from league "Old", not "New" — starting with an empty memory/.test(l)))
    assert.equal(guard.known.size, 0, 'the memory really is empty, the sidecar\'s old-league prices included')
    assert.equal(guard.held.size, 0)

    // The case that mattered: the tab set changes (the sidecar entry goes),
    // and Card X turns up later at a new-league price. It is judged by the
    // arrival bar (300c is far under 20 divine), not against the old 1c.
    await h2.append('player1', { totalChaos: 50, cdRatio: 200, items: items(['Start', 1, 50]), tabsChanged: true })
    await h2.append('player1', { totalChaos: 50, cdRatio: 200, items: items(['Start', 1, 50]) })
    c.advance(60_000)
    await h2.append('player1', { totalChaos: 50, cdRatio: 200, items: items(['Start', 1, 50]) })
    c.advance(60_000)
    await h2.append('player1', { totalChaos: 350, cdRatio: 200, items: items(['Start', 1, 50], ['Card X', 10, 300]) })
    assert.equal(h2.points.at(-1).c, 350)
  }
})

test('the guard memory is not rewritten at every point while nothing but the clock moves', async () => {
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const h = await bootGuarded(file, c, [])
  const same = () => ({ totalChaos: 100, cdRatio: 200, items: items(['Rest', 1, 100]) })
  await h.append('player1', same())
  // The guard runs from the second point on and first sees a rate there.
  c.advance(60_000)
  await h.append('player1', same())
  const first = JSON.parse(await readFile(h.guardStatePath, 'utf8'))
  assert.deepEqual(first.ratio, [200, c.now()])
  for (let k = 0; k < 5; k++) { c.advance(60_000); await h.append('player1', same()) }
  assert.equal(h.points.length, 7)
  assert.deepEqual(JSON.parse(await readFile(h.guardStatePath, 'utf8')), first, 'five more points, same file')
  c.advance(60_000)
  await h.append('player1', { ...same(), cdRatio: 201 })
  assert.deepEqual(JSON.parse(await readFile(h.guardStatePath, 'utf8')).ratio, [201, c.now()], 'a new rate is written')
})
