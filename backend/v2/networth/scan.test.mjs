// Scan core (scan.mjs) with a mocked stash client — NO GGG requests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthStore } from './store.mjs'
import { aggregate } from './aggregate.mjs'
import { scanTabs } from './scan.mjs'

// Raw "GGG" item: { kind, name, stack, c }. c==null -> unpriced.
const item = (kind, name, c, stack = 1) => ({ kind, name, stack, c })
const normalize = ggg => ({ kind: ggg.kind, name: ggg.name, stack: ggg.stack ?? 1, _c: ggg.c })
const valuator = {
  async value (desc) {
    if (desc._c == null) return null
    return { chaosEach: desc._c, chaosTotal: desc._c * desc.stack, source: 'mock' }
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
