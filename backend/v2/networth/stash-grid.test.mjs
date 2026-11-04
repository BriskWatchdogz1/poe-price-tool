// The value grid's answer (stash-grid.mjs, GET /daemon/stash-grid) from a
// real per-tab store in a temp directory. No request of any kind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthStore } from './store.mjs'
import { stashGridAnswer, tabIndexOf, gridTab, STASH_GRID_VERSION } from './stash-grid.mjs'

async function freshStore () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-stash-grid-'))
  const s = createNetworthStore(join(dir, 'nw.json'))
  await s.load()
  return { s, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const tab = (index, name, type, extra = {}) => ({ index, name, type, items: [], unpriced: [], counts: { priced: 0, unpriced: 0, skipped: 0 }, listed: [], ...extra })

test('a tab index is a whole number from 0 up, nothing else', () => {
  assert.equal(tabIndexOf('0'), 0)
  assert.equal(tabIndexOf('17'), 17)
  for (const bad of ['', ' ', 'x', '-1', '1.5', '1e2', '0x10', ' 3', '3 ', 'NaN', 'Infinity', '99999999999999999999']) {
    assert.equal(tabIndexOf(bad), null, JSON.stringify(bad))
  }
})

test('grid is true only for the three cell tab types', () => {
  assert.equal(gridTab('NormalStash'), true)
  assert.equal(gridTab('PremiumStash'), true)
  assert.equal(gridTab('QuadStash'), true)
  for (const t of ['CurrencyStash', 'MapStash', 'Folder', 'FragmentStash', null, undefined, '']) assert.equal(gridTab(t), false, String(t))
})

test('without a tab: the stored tab list in stash order', async () => {
  const { s, cleanup } = await freshStore()
  await s.setTab('player1', 3, tab(3, 'Currency', 'CurrencyStash'))
  await s.setTab('player1', 0, tab(0, 'Dump', 'QuadStash'))
  await s.setTab('player1', 1, tab(1, 'Old', undefined))
  const out = stashGridAnswer(s, 'player1', null)
  assert.equal(STASH_GRID_VERSION, 1)
  assert.deepEqual(out, {
    status: 200,
    body: {
      v: 1,
      tabs: [
        { index: 0, name: 'Dump', type: 'QuadStash', grid: true },
        { index: 1, name: 'Old', type: null, grid: false },
        { index: 3, name: 'Currency', type: 'CurrencyStash', grid: false }
      ]
    }
  })
  assert.deepEqual(stashGridAnswer(s, 'player2', null), { status: 200, body: { v: 1, tabs: [] } }, 'a user without a store: an empty list')
  await cleanup()
})

test('with a tab: its cells, their total and the rate', async () => {
  const { s, cleanup } = await freshStore()
  s.setMeta('player1', { cdRatio: 180 })
  const cells = [{ x: 3, y: 7, w: 2, h: 2, c: 900, n: 'Headhunter' }, { x: 0, y: 0, w: 1, h: 1, c: 10.2, n: 'Chaos Orb' }]
  await s.setTab('player1', 2, tab(2, 'Sale', 'PremiumStash', { cells }))
  const syncedAt = s.getTab('player1', 2).syncedAt
  const out = stashGridAnswer(s, 'player1', 2)
  assert.equal(out.status, 200)
  assert.deepEqual(out.body, {
    v: 1,
    tabs: [{ index: 2, name: 'Sale', type: 'PremiumStash', grid: true }],
    tab: { index: 2, name: 'Sale', type: 'PremiumStash', quad: false, grid: true, syncedAt },
    cells,
    totalChaos: 910.2,
    chaosPerDivine: 180
  })
  await cleanup()
})

test('a quad tab says quad; an empty cell list totals 0', async () => {
  const { s, cleanup } = await freshStore()
  await s.setTab('player1', 0, tab(0, 'Quad', 'QuadStash', { cells: [] }))
  const out = stashGridAnswer(s, 'player1', 0)
  assert.equal(out.body.tab.quad, true)
  assert.equal(out.body.tab.grid, true)
  assert.deepEqual(out.body.cells, [])
  assert.equal(out.body.totalChaos, 0)
  assert.equal(out.body.chaosPerDivine, null, 'no rate stored: null')
  await cleanup()
})

test('a tab stored before cells were kept: cells null with the reason', async () => {
  const { s, cleanup } = await freshStore()
  s.setMeta('player1', { cdRatio: 0 })
  await s.setTab('player1', 4, tab(4, 'Before', 'NormalStash'))
  const out = stashGridAnswer(s, 'player1', 4)
  assert.equal(out.status, 200)
  assert.equal(out.body.cells, null)
  assert.equal(out.body.reason, 'not-read-since-update')
  assert.equal(out.body.totalChaos, null)
  assert.equal(out.body.chaosPerDivine, null, 'a rate of 0 is no rate')
  assert.equal(out.body.tab.grid, true)
  await cleanup()
})

test('an unknown tab index is 404', async () => {
  const { s, cleanup } = await freshStore()
  await s.setTab('player1', 0, tab(0, 'Dump', 'QuadStash', { cells: [] }))
  assert.deepEqual(stashGridAnswer(s, 'player1', 5), { status: 404, body: { error: 'no such tab' } })
  assert.deepEqual(stashGridAnswer(s, 'player2', 0), { status: 404, body: { error: 'no such tab' } })
  await cleanup()
})

test('malformed stored cells are dropped from the answer, not passed on', async () => {
  const { s, cleanup } = await freshStore()
  await s.setTab('player1', 0, tab(0, 'Dump', 'PremiumStash', { cells: [{ x: 1, y: 1, w: 1, h: 1, c: 5, n: 'Ok' }, null, { x: 'a', y: 1, w: 1, h: 1, c: 5, n: 'Bad' }] }))
  const out = stashGridAnswer(s, 'player1', 0)
  assert.deepEqual(out.body.cells, [{ x: 1, y: 1, w: 1, h: 1, c: 5, n: 'Ok' }])
  assert.equal(out.body.totalChaos, 5)
  await cleanup()
})

test('an uncertain cell keeps u: true; a u that is not true goes, its cell stays', async () => {
  const { s, cleanup } = await freshStore()
  await s.setTab('player1', 0, tab(0, 'Dump', 'PremiumStash', {
    cells: [
      { x: 1, y: 1, w: 1, h: 1, c: 40, n: 'Stacked Deck', u: true },
      { x: 2, y: 1, w: 1, h: 1, c: 30, n: 'Plain' },
      { x: 3, y: 1, w: 1, h: 1, c: 20, n: 'Text', u: 'thin-market' },
      { x: 4, y: 1, w: 1, h: 1, c: 10, n: 'False', u: false },
      { x: 5, y: 1, w: 1, h: 1, c: 5, n: 'One', u: 1 }
    ]
  }))
  const out = stashGridAnswer(s, 'player1', 0)
  assert.deepEqual(out.body.cells, [
    { x: 1, y: 1, w: 1, h: 1, c: 40, n: 'Stacked Deck', u: true },
    { x: 2, y: 1, w: 1, h: 1, c: 30, n: 'Plain' },
    { x: 3, y: 1, w: 1, h: 1, c: 20, n: 'Text' },
    { x: 4, y: 1, w: 1, h: 1, c: 10, n: 'False' },
    { x: 5, y: 1, w: 1, h: 1, c: 5, n: 'One' }
  ])
  for (const c of out.body.cells.slice(1)) assert.equal('u' in c, false, c.n)
  assert.equal(out.body.totalChaos, 105, 'an uncertain cell counts in the total like any other')
  await cleanup()
})
