// Scan core (scan.mjs) with a mocked stash client — NO GGG requests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthStore } from './store.mjs'
import { aggregate } from './aggregate.mjs'
import { scanTabs, valueTab, CELLS_MIN_CHAOS, CELLS_MAX } from './scan.mjs'
import { round1 } from '../ninja.mjs'

// Raw "GGG" item: { kind, name, stack, c }. c==null -> unpriced; an extra
// `u` is the valuation's uncertain marker (valuator.mjs UNCERTAIN).
const item = (kind, name, c, stack = 1) => ({ kind, name, stack, c })
const normalize = ggg => ({ kind: ggg.kind, name: ggg.name, stack: ggg.stack ?? 1, _c: ggg.c, _u: ggg.u })
// Rounds like the real one (valuator.mjs value()): chaosEach and chaosTotal to
// 0.1 c for display, `each` unrounded; `uncertain` a marker or null.
const valuator = {
  async value (desc) {
    if (desc._c == null) return null
    return { chaosEach: round1(desc._c), chaosTotal: round1(desc._c * desc.stack), each: desc._c, source: 'mock', uncertain: desc._u ?? null }
  }
}

// Mock client with call tracking. tabs = [{index,name}], contents = { index: items[] },
// fail = { index: errorFactory } throws on fetchTab for that index.
function mockClient ({ tabs, contents = {}, fail = {} }) {
  const fetched = []
  return {
    fetched,
    async listTabs () { return tabs },
    async fetchTab (index) {
      fetched.push(index)
      if (fail[index]) throw fail[index]()
      return contents[index] || []
    }
  }
}

async function freshStore () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-scan-'))
  const s = createNetworthStore(join(dir, 'nw.json'))
  await s.load()
  return { s, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const base = (client, s, over = {}) => ({
  client, store: s, valuator, normalize,
  user: 'player1', league: 'L', cdRatio: 200, accountName: 'acc',
  ttlMs: 10_000, now: () => 1_000_000, ...over
})

test('fresh tab is skipped (no fetchTab), its data survives', async () => {
  const { s, cleanup } = await freshStore()
  // Put tab 0 into the store up front as fresh (syncedAt = now).
  await s.setTab('player1', 0, {
    index: 0, name: 'Currency',
    items: [{ name: 'Old', kind: 'stackable', tab: 'Currency', tabIndex: 0, qty: 1, chaosEach: 5, chaosTotal: 5 }],
    unpriced: [], counts: { priced: 1, unpriced: 0, skipped: 0 }
  })
  const syncedBefore = s.getTab('player1', 0).syncedAt
  const client = mockClient({ tabs: [{ index: 0, name: 'Currency' }], contents: { 0: [item('stackable', 'New', 999)] } })
  // now sits just inside the TTL relative to syncedBefore
  await scanTabs(base(client, s, { now: () => syncedBefore + 1_000 }))
  assert.deepEqual(client.fetched, [])                         // tab 0 NOT fetched
  assert.equal(s.getTab('player1', 0).items[0].name, 'Old')        // old state kept
  await cleanup()
})

test('stale tab is refetched + persisted', async () => {
  const { s, cleanup } = await freshStore()
  await s.setTab('player1', 0, {
    index: 0, name: 'Currency',
    items: [{ name: 'Old', kind: 'stackable', tab: 'Currency', tabIndex: 0, qty: 1, chaosEach: 5, chaosTotal: 5 }],
    unpriced: [], counts: { priced: 1, unpriced: 0, skipped: 0 }
  })
  const syncedBefore = s.getTab('player1', 0).syncedAt
  const client = mockClient({ tabs: [{ index: 0, name: 'Currency' }], contents: { 0: [item('stackable', 'Divine Orb', 200, 3)] } })
  await scanTabs(base(client, s, { now: () => syncedBefore + 20_000 })) // > TTL 10s -> stale
  assert.deepEqual(client.fetched, [0])                        // fetched
  const t = s.getTab('player1', 0)
  assert.equal(t.items[0].name, 'Divine Orb')                  // new state
  assert.equal(t.items[0].qty, 3)
  assert.equal(t.items[0].chaosTotal, 600)
  await cleanup()
})

test('force ignores the TTL -> even fresh tabs are refetched', async () => {
  const { s, cleanup } = await freshStore()
  await s.setTab('player1', 0, { index: 0, name: 'A', items: [], unpriced: [], counts: { priced: 0, unpriced: 0, skipped: 0 } })
  const syncedBefore = s.getTab('player1', 0).syncedAt
  const client = mockClient({ tabs: [{ index: 0, name: 'A' }], contents: { 0: [item('stackable', 'Chaos Orb', 1, 10)] } })
  await scanTabs(base(client, s, { force: true, now: () => syncedBefore + 1_000 }))
  assert.deepEqual(client.fetched, [0]) // fetched despite being fresh
  await cleanup()
})

test('abort (ratelimit) in the tail -> tabs fetched before it survive, partial snapshot from the store', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }, { index: 1, name: 'B' }, { index: 2, name: 'C' }],
    contents: {
      0: [item('stackable', 'Divine Orb', 200, 2)],
      1: [item('unique', 'Headhunter', 900)]
    },
    fail: { 2: () => Object.assign(new Error('Rate-limited'), { kind: 'ratelimit' }) }
  })
  await assert.rejects(scanTabs(base(client, s)), /Rate-limited/)
  // Tabs 0 and 1 are persisted, tab 2 is missing.
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 1])
  // Build the partial snapshot from the store (the way server.mjs does in its catch).
  const snap = aggregate({ tabs: s.tabList('player1'), cdRatio: 200, league: 'L', accountName: 'acc' })
  assert.equal(snap.totalChaos, 1300) // 400 + 900
  assert.equal(snap.items.length, 2)
  await cleanup()
})

test('single tab error (rejected) -> that tab is skipped, the scan keeps going', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }, { index: 1, name: 'B' }, { index: 2, name: 'C' }],
    contents: { 0: [item('stackable', 'Divine Orb', 200)], 2: [item('unique', 'Headhunter', 900)] },
    fail: { 1: () => Object.assign(new Error('HTTP 400'), { kind: 'rejected' }) }
  })
  const tabs = await scanTabs(base(client, s))
  assert.equal(tabs.length, 3)
  assert.deepEqual(client.fetched, [0, 1, 2])               // all attempted
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 2]) // tab 1 not persisted
  await cleanup()
})

test('pruneTabs during the scan: vanished tabs are dropped once a second list agrees', async () => {
  const { s, cleanup } = await freshStore()
  // Up front: tabs 0,1,2 in the store (from an older scan).
  for (const i of [0, 1, 2]) await s.setTab('player1', i, { index: i, name: `T${i}`, items: [], unpriced: [], counts: { priced: 0, unpriced: 0, skipped: 0 } })
  // The account now only has 0 and 2.
  const client = mockClient({ tabs: [{ index: 0, name: 'T0' }, { index: 2, name: 'T2' }], contents: {} })
  await scanTabs(base(client, s, { force: true }))
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 1, 2],
    'the first shorter list only proposes the drop — see pruneTabs in store.mjs')
  await scanTabs(base(client, s, { force: true }))
  assert.deepEqual(s.tabList('player1').map(t => t.index), [0, 2]) // tab 1 pruned
  // Meta was written.
  assert.deepEqual(s.getMeta('player1'), { accountName: 'acc', league: 'L', cdRatio: 200 })
  await cleanup()
})

// The store is where the two unpriced numbers have to agree, because that is
// where the page reads them from: `counts.unpriced` is stash ENTRIES, the rows'
// `count` and `counts.unpricedPieces` are PIECES. A stack larger than one pulls
// them apart, and a stack of zero — which normalize.mjs can never produce, but
// which `?? 1` used to wave through — pulled them apart the other way.
test('a scanned tab stores unpriced entries and unpriced PIECES as two numbers that both hold', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({
    tabs: [{ index: 0, name: 'A' }],
    contents: {
      0: [
        item('stackable', 'Mystery Frag', null, 5),  // one entry, five pieces
        item('stackable', 'Mystery Frag', null, 2),  // …same name, folds into the row
        item('unique', 'Unidentified Map (Tier 16)', null, 0) // a zero stack is still one piece
      ]
    }
  })
  await scanTabs(base(client, s))
  const tab = s.getTab('player1', 0)
  assert.equal(tab.counts.unpriced, 3)        // three stash entries
  assert.equal(tab.counts.unpricedPieces, 8)  // 5 + 2 + 1
  assert.equal(tab.unpriced.reduce((sum, u) => sum + u.count, 0), tab.counts.unpricedPieces,
    'the stored rows must add up to the stored piece total — the page prints both')
  // …and the snapshot the page actually receives says the same.
  const snap = aggregate({ tabs: s.tabList('player1'), cdRatio: 200, league: 'L', accountName: 'acc' })
  assert.equal(snap.counts.unpricedPieces, 8)
  assert.equal(snap.tabs[0].unpricedPieces, 8)
  assert.equal(snap.unpriced.reduce((sum, u) => sum + u.count, 0), 8)
  await cleanup()
})

test('a scanned tab keeps the price notes of its priced items, with their cell, and nothing else', async () => {
  const { s, cleanup } = await freshStore()
  const noted = (kind, name, c, note, x, y, stack = 1) => ({ ...item(kind, name, c, stack), note, x, y })
  const client = mockClient({
    tabs: [{ index: 0, name: 'Sale', type: 'PremiumStash' }],
    contents: {
      0: [
        noted('unique', 'Headhunter', 900, '~price 5 chaos', 3, 7),
        noted('stackable', 'Chaos Shard', 0.05, '~b/o 1/20 chaos', 0, 0, 20), // stored unrounded, not as 0.1
        noted('unique', 'No Price', null, '~price 5 chaos', 1, 1), // unpriced: nothing to compare
        noted('unique', 'Just A Note', 10, 'for my alt', 2, 2),     // not a price note
        item('unique', 'No Note', 10)
      ]
    }
  })
  await scanTabs(base(client, s))
  const tab = s.getTab('player1', 0)
  assert.deepEqual(tab.listed, [
    { name: 'Headhunter', kind: 'unique', qty: 1, x: 3, y: 7, note: '~price 5 chaos', fromTab: false, chaosEach: 900, uncertain: null },
    { name: 'Chaos Shard', kind: 'stackable', qty: 20, x: 0, y: 0, note: '~b/o 1/20 chaos', fromTab: false, chaosEach: 0.05, uncertain: null }
  ])
  await cleanup()
})

test('a scanned tab keeps its stash tab type, so a whisper can tell a quad tab', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({
    tabs: [{ index: 0, name: 'Quad', type: 'QuadStash' }, { index: 1, name: 'Plain' }],
    contents: { 0: [item('unique', 'Headhunter', 900)], 1: [item('unique', 'Kaom', 5)] }
  })
  await scanTabs(base(client, s))
  assert.equal(s.getTab('player1', 0).type, 'QuadStash')
  assert.equal(s.getTab('player1', 1).type, null, 'a tab list without a type stores null, not a guess')
  await cleanup()
})

// The value grid (GET /daemon/stash-grid): one cell per priced stash entry
// with its position, kept from the read the sync makes anyway.
const placed = (kind, name, c, x, y, w, h, stack = 1) => ({ ...item(kind, name, c, stack), x, y, w, h })
const gridTab = { index: 0, name: 'Dump', type: 'PremiumStash' }
const cellsOf = async items => (await valueTab({ items, tab: gridTab, valuator, normalize, cdRatio: 200, league: 'L', accountName: 'acc' })).cells

test('a valued tab keeps one cell per priced entry from 1 c up, with its position, dearest first', async () => {
  assert.equal(CELLS_MIN_CHAOS, 1)
  const cells = await cellsOf([
    placed('stackable', 'Chaos Orb', 1, 0, 0, 1, 1, 10),     // 10 c for the stack
    placed('unique', 'Headhunter', 900, 3, 7, 2, 2),
    placed('unique', 'Cheap', 0.5, 1, 1, 1, 1),              // under 1 c: left out
    placed('unique', 'Exactly One', 1, 5, 5, 1, 3),          // 1 c counts
    placed('unique', 'Unpriced', null, 2, 2, 1, 1),          // no value: left out
    placed('stackable', 'Shards', 0.04, 4, 4, 1, 1, 33),     // 1.32 c for the stack, shown as 1.3
    { ...placed('unique', 'Skipped', 50, 6, 6, 1, 1), kind: 'skip' }
  ])
  assert.deepEqual(cells, [
    { x: 3, y: 7, w: 2, h: 2, c: 900, n: 'Headhunter' },
    { x: 0, y: 0, w: 1, h: 1, c: 10, n: 'Chaos Orb' },
    { x: 4, y: 4, w: 1, h: 1, c: 1.3, n: 'Shards' },
    { x: 5, y: 5, w: 1, h: 3, c: 1, n: 'Exactly One' }
  ])
})

test('an entry without a numeric cell has no cell; a missing size reads as one cell', async () => {
  const cells = await cellsOf([
    { ...item('unique', 'No Position', 50) },                          // no x/y at all
    { ...item('unique', 'Half Position', 50), x: 2 },
    { ...item('unique', 'Negative', 50), x: -1, y: 0, w: 1, h: 1 },
    { ...item('unique', 'String Cell', 50), x: '1', y: '1', w: 1, h: 1 },
    { ...item('unique', 'No Size', 40), x: 7, y: 8 }
  ])
  assert.deepEqual(cells, [{ x: 7, y: 8, w: 1, h: 1, c: 40, n: 'No Size' }])
})

test('only a tab whose items sit on cells keeps cells; every other type stores an empty list', async () => {
  // A folder tab's read merges the items of all its sub-tabs, so their x/y
  // overlap; the route marks such a tab grid=false and the daemon never draws
  // it. Keeping cells there would only grow the store file.
  const items = [placed('unique', 'Headhunter', 900, 3, 7, 2, 2)]
  const cellsFor = async type => (await valueTab({ items, tab: { index: 0, name: 'T', type }, valuator, normalize, cdRatio: 200, league: 'L', accountName: 'acc' })).cells
  for (const type of ['NormalStash', 'PremiumStash', 'QuadStash']) {
    assert.deepEqual(await cellsFor(type), [{ x: 3, y: 7, w: 2, h: 2, c: 900, n: 'Headhunter' }], type)
  }
  for (const type of ['CurrencyStash', 'FragmentStash', 'MapStash', 'UniqueStash', 'Folder', null, undefined]) {
    assert.deepEqual(await cellsFor(type), [], String(type))
  }
})

test('a cell whose value carries an uncertain marker says u: true; any other cell has no u', async () => {
  // The grid marks the price the Net Worth page marks; which marker it is
  // stays on that page, so the cell carries only the flag.
  const cells = await cellsOf([
    { ...placed('stackable', 'Stacked Deck', 4, 0, 0, 1, 1, 10), u: 'thin-market' },
    { ...placed('unique', 'Headhunter', 900, 3, 7, 2, 2), u: 'variant-guessed' },
    placed('unique', 'Kaom', 30, 5, 5, 2, 3),
    { ...placed('unique', 'Marked Null', 20, 8, 8, 1, 1), u: null }
  ])
  assert.deepEqual(cells, [
    { x: 3, y: 7, w: 2, h: 2, c: 900, n: 'Headhunter', u: true },
    { x: 0, y: 0, w: 1, h: 1, c: 40, n: 'Stacked Deck', u: true },
    { x: 5, y: 5, w: 2, h: 3, c: 30, n: 'Kaom' },
    { x: 8, y: 8, w: 1, h: 1, c: 20, n: 'Marked Null' }
  ])
  for (const c of cells.slice(2)) assert.equal('u' in c, false, `${c.n}: no u: false, the field is left out`)
})

test('a tab keeps at most CELLS_MAX cells, the cheapest ones are cut', async () => {
  assert.equal(CELLS_MAX, 600)
  const items = []
  for (let i = 0; i < CELLS_MAX + 50; i++) items.push(placed('unique', `U${i}`, 1 + i, i % 24, Math.floor(i / 24) % 24, 1, 1))
  const cells = await cellsOf(items)
  assert.equal(cells.length, CELLS_MAX)
  assert.equal(cells[0].c, CELLS_MAX + 50)
  assert.equal(cells.at(-1).c, 51, 'the 50 cheapest are the ones left out')
})

test('a scanned tab stores its cells, and an empty tab stores an empty list', async () => {
  const { s, cleanup } = await freshStore()
  const client = mockClient({
    tabs: [{ index: 0, name: 'Dump', type: 'PremiumStash' }, { index: 1, name: 'Empty', type: 'NormalStash' }],
    contents: { 0: [placed('unique', 'Headhunter', 900, 3, 7, 2, 2)], 1: [] }
  })
  await scanTabs(base(client, s))
  assert.deepEqual(s.getTab('player1', 0).cells, [{ x: 3, y: 7, w: 2, h: 2, c: 900, n: 'Headhunter' }])
  assert.deepEqual(s.getTab('player1', 1).cells, [])
  await cleanup()
})
