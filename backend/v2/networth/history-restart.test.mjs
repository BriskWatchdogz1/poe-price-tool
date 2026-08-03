// Local tests: the item listing survives a restart (gitignored).
//
// The core: a container restart must not tear a hole into the breakdown — the
// first point after the restart has to carry a `d`. Plus the empty cases that
// remain even with a sidecar file (very first point, legacy lines).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthHistory } from './history.mjs'
import { createHistoryItems, defaultItemsPath } from './history-items.mjs'

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
    totalChaos: 1200, cdRatio: 200, tabs: { 1: 1200 },
    items: items(['Divine Orb', 10, 1200])
  }), true)

  // --- restart ---
  c.advance(60_000)
  const h2 = await boot(file, c)
  assert.equal(await h2.append('player1', {
    totalChaos: 1560, cdRatio: 200, tabs: { 1: 1560 },
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
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, tabs: { 1: 1200 }, items: items(['Divine Orb', 10, 1200]) })

  const line = JSON.parse((await readFile(file, 'utf8')).trim())
  assert.equal(Object.keys(line).sort().join(','), 'at,c,cd,t,u', 'no new field in the NDJSON line')

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
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, tabs: { 1: 1200 }, items: items(['Chaos Orb', 200, 200]) })
  assert.equal(h.points[2].d, undefined, 'first point after legacy data has no delta')
  c.advance(60_000)
  await h.append('player1', { totalChaos: 1300, cdRatio: 200, tabs: { 1: 1300 }, items: items(['Chaos Orb', 300, 300]) })
  assert.ok(h.points[3].d, 'with a delta again afterwards')
})

test('very first point: the panel reports missing comparison data (start=true)', async () => {
  const c = clock()
  const file = join(await tmpDir(), 'networth-history.ndjson')
  const h = await boot(file, c)
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, tabs: { 1: 1200 }, items: items(['Divine Orb', 10, 1200]) })

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
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, tabs: { 1: 1200 }, items: rows })
  c.advance(60_000)
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, tabs: { 1: 1200 }, items: rows })

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
  await h1.append('player1', { totalChaos: 1200, cdRatio: 200, tabs: { 1: 1200 }, items: items(['Divine Orb', 10, 1200]) })

  // Bend the sidecar timestamp by hand (half-written state, the point append
  // failed, retention ate the anchor …).
  const sidePath = defaultItemsPath(file)
  const doc = JSON.parse(await readFile(sidePath, 'utf8'))
  doc.u.player1.at += 1
  await writeFile(sidePath, JSON.stringify(doc), 'utf8')

  c.advance(60_000)
  const h2 = await boot(file, c)
  await h2.append('player1', { totalChaos: 9999, cdRatio: 200, tabs: { 1: 9999 }, items: items(['Divine Orb', 80, 9999]) })
  assert.equal(h2.points[1].d, undefined, 'rather no delta at all than a misattributed one')
})

test('broken sidecar file = empty instead of a crash', async () => {
  const c = clock()
  const dir = await tmpDir()
  const file = join(dir, 'networth-history.ndjson')
  const h1 = await boot(file, c)
  await h1.append('player1', { totalChaos: 1200, cdRatio: 200, tabs: { 1: 1200 }, items: items(['Divine Orb', 10, 1200]) })
  await writeFile(defaultItemsPath(file), '{"v":1,"u":{"player1":{"at":', 'utf8') // truncated

  c.advance(60_000)
  const h2 = await boot(file, c)
  assert.equal(h2.points.length, 1, 'the series is undamaged')
  assert.equal(await h2.append('player1', { totalChaos: 1300, cdRatio: 200, tabs: { 1: 1300 }, items: items(['Divine Orb', 11, 1300]) }), true)
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
  assert.equal(await h.append('player1', { totalChaos: 1200, cdRatio: 200, tabs: { 1: 1200 }, items: items(['Divine Orb', 10, 1200]) }), true)
  await assert.rejects(stat(defaultItemsPath(file)), 'no sidecar file written')
  // In memory the comparison still runs.
  c.advance(60_000)
  await h.append('player1', { totalChaos: 1560, cdRatio: 200, tabs: { 1: 1560 }, items: items(['Divine Orb', 13, 1560]) })
  assert.ok(h.points[1].d)
})

test('a sidecar write error does not take the history down with it', async () => {
  const c = clock()
  const dir = await tmpDir()
  const file = join(dir, 'networth-history.ndjson')
  const h = await boot(file, c)
  await h.append('player1', { totalChaos: 1200, cdRatio: 200, tabs: { 1: 1200 }, items: items(['Divine Orb', 10, 1200]) })
  await chmod(dir, 0o555) // directory sealed: no tmp file can be created any more
  try {
    c.advance(60_000)
    assert.equal(await h.append('player1', { totalChaos: 1300, cdRatio: 200, tabs: { 1: 1300 }, items: items(['Divine Orb', 11, 1300]) }), true)
    assert.equal(h.points.length, 2)
  } finally {
    await chmod(dir, 0o755)
  }
})
