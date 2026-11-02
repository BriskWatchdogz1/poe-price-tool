// backend/v2/networth/tab-unread.test.mjs
//
// A STASH TAB THAT DID NOT ANSWER IS NOT AN EMPTY STASH TAB.
//
// Reported from live use (2026-08-14, docs/bugs.md B2), on a stash nobody had
// touched for many hours: a single recorded event over ~50 minutes with 53
// lines in it — Divine Orb −6 (−1155.6 c), Chromatic Orb −80, Chaos Orb −133,
// Enkindling Orb −35, Sepia Oil +25, Simulacrum Splinter +71 — i.e. the whole
// content of a stash tab leaving, and another tab's arriving. Divine Orbs and
// Chaos Orbs never lose their price, so this is NOT the mechanism e423b47 fixed
// one level down (an item dropping out of the PRICED set).
//
// The three states this file is about, and they are three and not two:
//
//   READ WITH CONTENTS  — GGG answered with items. Stored, diffed, recorded.
//   READ AND EMPTY      — GGG answered `items: []`. A fact about the stash, and
//                         it must NOT stop the recording: an empty tab is a
//                         perfectly ordinary thing to own.
//   NOT KNOWN           — no answer about the contents at all: a 200 whose body
//                         carries no items array, a folder walk whose sub-tabs
//                         did not all answer, an unexpected status the folder
//                         path used to swallow. Nothing may be written for it,
//                         and nothing may be recorded off a snapshot that has
//                         just lost it.
//
// The old code had two: `Array.isArray(j?.items) ? j.items : []` and
// `catch { return [] }` both answered the third case with the second one. The
// store then held an EMPTY tab where a full one had been, `coverageOf` counted
// it as covered (it has stored data — that is all this level can see), the
// recorder wrote a point, and `buildDelta` has exactly one reading for a name
// that was in the previous map and is not in the current one: the whole stock
// leaving at the price it had. On the tab's next turn the same arithmetic ran
// backwards. Nobody had played.
//
// NO NETWORK: every request is a mocked `fetchImpl` / a mocked client.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStashClient } from './stash-client.mjs'
import { createNetworthStore } from './store.mjs'
import { createNetworthRefresher } from './refresher.mjs'
import { createNetworthHistory, createTabSetWatch } from './history.mjs'
import { aggregate } from './aggregate.mjs'

const silentLog = { warn () {}, error () {}, log () {} }

function res (status, headers, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

async function tmpDir (tag) {
  const dir = await mkdtemp(join(tmpdir(), `ppt-${tag}-`))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
// 1. The client: what an answer is, and what is not one
// ---------------------------------------------------------------------------

test('an ordinary tab answering 200 WITHOUT an items array is unread, not empty', async () => {
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1,
    // B7 measured exactly this on the sub-tab endpoint and could name no other
    // way for a full tab to come back empty without one error line in the log.
    fetchImpl: async () => res(200, {}, { numTabs: 30, layout: {} })
  })
  await assert.rejects(() => c.fetchTab(3), e => e.kind === 'unread')
  // The response KEYS travel with it — names only, no item data, no cookie —
  // because they are the only thing that says where the items went instead.
  await assert.rejects(() => c.fetchTab(3), e => /numTabs,layout/.test(e.message))
})

test('an ordinary tab answering `items: []` IS empty, and says so plainly', async () => {
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1,
    fetchImpl: async () => res(200, {}, { items: [] })
  })
  assert.deepEqual(await c.fetchTab(3), [], 'GGG said the tab holds nothing; that is a fact and it is kept')
})

// ---------------------------------------------------------------------------
// 2. The refresher: an unread tab writes nothing and reports nothing
// ---------------------------------------------------------------------------

function refresherOver ({ store, client, over = {} }) {
  const synced = []
  const r = createNetworthRefresher({
    store,
    loadUsers: async () => ({ player1: { accountName: 'acc', poesessid: 'C' } }),
    makeClient: () => ({ client, league: 'L' }),
    valueTab: async ({ items, tab }) => ({
      index: tab.index,
      name: tab.name,
      items: items.map(it => ({
        name: it.name, kind: 'stackable', tab: tab.name, tabIndex: tab.index,
        qty: it.qty, chaosEach: it.c, chaosTotal: it.qty * it.c
      })),
      unpriced: [],
      counts: { priced: items.length, unpriced: 0, unpricedPieces: 0, skipped: 0 }
    }),
    cdRatioFor: () => 200,
    onTabSynced: (user, coverage) => synced.push({ user, coverage }),
    log: silentLog,
    intervalMs: 10_000,
    listTtlMs: 900_000,
    ...over
  })
  return { r, synced }
}

const CURRENCY = [
  { name: 'Divine Orb', qty: 6, c: 192.6 },
  { name: 'Chaos Orb', qty: 133, c: 1 },
  { name: 'Chromatic Orb', qty: 80, c: 2.44 }
]

test('a tab that does not answer keeps its stored contents and produces no sync at all', async () => {
  const { dir, cleanup } = await tmpDir('unread-store')
  const store = createNetworthStore(join(dir, 'nw.json'))
  await store.load()
  let answering = true
  const client = {
    async listTabs () { return [{ index: 0, name: 'Currency' }, { index: 1, name: 'B' }] },
    async fetchTab (index) {
      if (index === 0 && !answering) throw Object.assign(new Error('no items array'), { kind: 'unread' })
      return index === 0 ? CURRENCY : []
    }
  }
  const { r, synced } = refresherOver({ store, client })
  await r.tickOnce()                       // tab list
  await r.tickOnce()                       // tab 0 (never synced -> first)
  await r.tickOnce()                       // tab 1
  assert.equal(store.getTab('player1', 0).items.length, 3)
  const stampBefore = store.getTab('player1', 0).syncedAt
  const syncsBefore = synced.length

  answering = false
  await r.tickOnce()                       // tab 0 comes round again and says nothing
  const stored = store.getTab('player1', 0)
  assert.equal(stored.items.length, 3, 'the tab keeps the last contents it was really read with')
  assert.equal(stored.syncedAt, stampBefore, 'and is not re-stamped for a read that did not happen')
  assert.equal(synced.length, syncsBefore, 'no tab was written, so nothing is broadcast and no point is offered')
  await cleanup()
})

test('a tab that keeps failing does not pin the round-robin to itself', async () => {
  // The attempt stamp used to be read only for a tab with NO stored data, so a
  // tab that HAD been synced and then started failing kept its old syncedAt,
  // stayed the stalest tab and was picked again on every single tick — for
  // ever, while no other tab ever came round again.
  const { dir, cleanup } = await tmpDir('poison-store')
  const store = createNetworthStore(join(dir, 'nw.json'))
  await store.load()
  const fetched = []
  const client = {
    async listTabs () { return [{ index: 0, name: 'A' }, { index: 1, name: 'B' }, { index: 2, name: 'C' }] },
    async fetchTab (index) {
      fetched.push(index)
      if (index === 0 && fetched.filter(i => i === 0).length > 1) {
        throw Object.assign(new Error('no items array'), { kind: 'unread' })
      }
      return []
    }
  }
  const { r } = refresherOver({ store, client })
  // The stamps this compares are milliseconds — `store.setTab` uses the wall
  // clock and cannot be injected — so the ticks are spaced far enough apart to
  // be distinguishable at all. Without that every tab carries the same instant
  // and the order says nothing.
  const tick = async () => { await new Promise(r2 => setTimeout(r2, 3)); await r.tickOnce() }
  await tick()                                       // list
  for (let i = 0; i < 6; i++) await tick()           // two full rounds
  assert.deepEqual(fetched, [0, 1, 2, 0, 1, 2], 'the broken tab takes its turn and gives it up again')
  await cleanup()
})

// ---------------------------------------------------------------------------
// 3. End to end: the phantom event, and that it is gone
//
// The wiring below is server.mjs's recordNetworthHistory: aggregate whatever the
// store holds, hand the totals + items + unpriced + the coverage flag to
// history.append. `createTabSetWatch` is the same call the server makes, out of
// the same module, so this cannot drift away from it.
// ---------------------------------------------------------------------------

async function recorder () {
  const { dir, cleanup } = await tmpDir('unread-hist')
  const store = createNetworthStore(join(dir, 'nw.json'))
  await store.load()
  let clock = 1_000_000
  const hist = createNetworthHistory(join(dir, 'h.ndjson'), {
    minIntervalMs: 0, now: () => clock, priceGuard: false
  })
  await hist.load()
  const watch = createTabSetWatch()
  const record = async (user, coverage) => {
    const tabs = store.tabList(user)
    if (!tabs.length) return false
    const snap = aggregate({ tabs, cdRatio: 200, league: 'L', accountName: null })
    const seen = watch.look(user, snap)
    return hist.append(user, {
      totalChaos: snap.totalChaos,
      cdRatio: snap.cdRatio,
      items: snap.items || [],
      unpriced: snap.unpriced || [],
      tabsChanged: seen.changed,
      syncComplete: coverage ? coverage.complete : undefined
    })
  }
  return { store, hist, record, cleanup, tick: ms => { clock += ms }, at: () => clock }
}

const tabWith = (index, name, rows) => ({
  index,
  name,
  items: rows.map(r => ({
    name: r.name, kind: 'stackable', tab: name, tabIndex: index,
    qty: r.qty, chaosEach: r.c, chaosTotal: r.qty * r.c
  })),
  unpriced: [],
  counts: { priced: rows.length, unpriced: 0, unpricedPieces: 0, skipped: 0 }
})

test('a tab stored EMPTY is a whole tab leaving the stash — the shape that was reported', async () => {
  // This is the defect itself, driven through the recorder to show what it
  // produced. Nothing here asserts that the tool may do this; it asserts what
  // the consequence is, so the fix above is aimed at something demonstrated
  // rather than at something argued.
  const { store, hist, record, cleanup, tick } = await recorder()
  await store.setTab('player1', 0, tabWith(0, 'Currency', CURRENCY))
  await store.setTab('player1', 1, tabWith(1, 'B', [{ name: 'Orb of Alteration', qty: 18, c: 0.2 }]))
  await record('player1', { complete: true })

  tick(60_000)
  // The empty write: a non-answer stored as an answer.
  await store.setTab('player1', 0, tabWith(0, 'Currency', []))
  await record('player1', { complete: true })

  const ev = hist.rawEvents('player1', 24 * 3600_000, { minChaos: 1 })
  const names = ev.events.at(-1).items.map(([n, dq]) => [n, dq])
  assert.deepEqual(names.sort(), [['Chaos Orb', -133], ['Chromatic Orb', -80], ['Divine Orb', -6]].sort(),
    'the whole tab reads as stock that left, at the prices it had')
  await cleanup()
})

test('a tab that does not answer produces NO point and NO phantom movement', async () => {
  const { store, hist, record, cleanup, tick } = await recorder()
  await store.setTab('player1', 0, tabWith(0, 'Currency', CURRENCY))
  await store.setTab('player1', 1, tabWith(1, 'B', [{ name: 'Orb of Alteration', qty: 18, c: 0.2 }]))
  assert.equal(await record('player1', { complete: true }), true)
  const after = hist.points.length

  // The turn on which the currency tab says nothing. The refresher writes
  // nothing (see the test above), so the store is unchanged and the recorder is
  // not even called for that step — the tab that DID sync in the meantime is
  // what calls it, and the snapshot it sums is still whole.
  tick(60_000)
  await store.setTab('player1', 1, tabWith(1, 'B', [{ name: 'Orb of Alteration', qty: 18, c: 0.2 }]))
  assert.equal(await record('player1', { complete: true }), true)
  assert.equal(hist.points.length, after + 1)

  const ev = hist.rawEvents('player1', 24 * 3600_000, { minChaos: 0.1 })
  assert.deepEqual(ev.events, [], 'nobody played, so nothing moved')
  await cleanup()
})

test('a tab that is genuinely EMPTY does not block the recording', async () => {
  // The counter-direction, and the one that would be worse to get wrong: a gate
  // that refuses an empty tab leaves the operator with no history at all rather
  // than with a wrong event.
  const { store, record, hist, cleanup, tick } = await recorder()
  await store.setTab('player1', 0, tabWith(0, 'Currency', CURRENCY))
  await store.setTab('player1', 1, tabWith(1, 'Empty', []))
  assert.equal(await record('player1', { complete: true }), true)
  tick(60_000)
  await store.setTab('player1', 1, tabWith(1, 'Empty', []))
  assert.equal(await record('player1', { complete: true }), true, 'an empty tab is a reading like any other')
  assert.equal(hist.points.length, 2)
  assert.equal(hist.points.at(-1).c, 1483.8)
  await cleanup()
})

// ---------------------------------------------------------------------------
// 4. The residue: a tab that leaves the SNAPSHOT rather than the answer
// ---------------------------------------------------------------------------

test('a tab pruned out of the store skips ONE point and starts the diff over', async () => {
  const { store, hist, record, cleanup, tick } = await recorder()
  await store.setTab('player1', 0, tabWith(0, 'Currency', CURRENCY))
  await store.setTab('player1', 1, tabWith(1, 'B', [{ name: 'Orb of Alteration', qty: 18, c: 0.2 }]))
  await record('player1', { complete: true })

  // Two consecutive tab lists agree the currency tab is gone (store.mjs), so it
  // is deleted. `coverageOf` cannot see this at all: the tab left the LIVE list
  // too, which is the set coverage is counted over, so it reads `complete`.
  tick(60_000)
  store.pruneTabs('player1', [1])
  store.pruneTabs('player1', [1])
  assert.equal(store.getTab('player1', 0), null)
  assert.equal(await record('player1', { complete: true }), false, 'the point over the changed tab set is refused')

  tick(60_000)
  await store.setTab('player1', 1, tabWith(1, 'B', [{ name: 'Orb of Alteration', qty: 18, c: 0.2 }]))
  assert.equal(await record('player1', { complete: true }), true, 'and the series carries on one point later')
  const ev = hist.rawEvents('player1', 24 * 3600_000, { minChaos: 0.1 })
  assert.deepEqual(ev.events, [], 'no phantom outflow of the tab that went away')

  // …and it does not stop for good: the tab stays gone and points keep coming.
  tick(60_000)
  await store.setTab('player1', 1, tabWith(1, 'B', [{ name: 'Orb of Alteration', qty: 18, c: 0.2 }]))
  assert.equal(await record('player1', { complete: true }), true)
  await cleanup()
})

test('a tab read for the FIRST time is not stock arriving', async () => {
  // The other direction of the same thing: coverage counts a tab as covered
  // once the round-robin has been past it, whether or not it yielded anything —
  // deliberately, because a tab that never becomes readable must not stop the
  // series for ever. The price of that is exactly this moment, and it is paid
  // with one skipped point rather than with a phantom find.
  const { store, hist, record, cleanup, tick } = await recorder()
  await store.setTab('player1', 1, tabWith(1, 'B', [{ name: 'Orb of Alteration', qty: 18, c: 0.2 }]))
  await record('player1', { tabsCovered: 2, tabsRead: 1, tabsTotal: 2, complete: true })

  tick(60_000)
  await store.setTab('player1', 0, tabWith(0, 'Currency', CURRENCY))
  assert.equal(await record('player1', { tabsCovered: 2, tabsRead: 2, tabsTotal: 2, complete: true }), false)

  tick(60_000)
  await store.setTab('player1', 1, tabWith(1, 'B', [{ name: 'Orb of Alteration', qty: 18, c: 0.2 }]))
  assert.equal(await record('player1', { tabsCovered: 2, tabsRead: 2, tabsTotal: 2, complete: true }), true)
  const ev = hist.rawEvents('player1', 24 * 3600_000, { minChaos: 0.1 })
  assert.deepEqual(ev.events, [], 'six divine of currency did not arrive; it was there all along')
  await cleanup()
})

test('the breakdown is dropped even when the refused point would have been throttled away anyway', async () => {
  // `tabsChanged` is answered BEFORE the one-point-per-minute throttle on
  // purpose. Otherwise a change that happens inside the throttle window would
  // be forgotten and the next point a minute later would diff straight across
  // it.
  const { dir, cleanup } = await tmpDir('unread-throttle')
  const store = createNetworthStore(join(dir, 'nw.json'))
  await store.load()
  let clock = 1_000_000
  const hist = createNetworthHistory(join(dir, 'h.ndjson'), {
    minIntervalMs: 60_000, now: () => clock, priceGuard: false
  })
  await hist.load()
  const watch = createTabSetWatch()
  const record = async () => {
    const snap = aggregate({ tabs: store.tabList('player1'), cdRatio: 200, league: 'L', accountName: null })
    return hist.append('player1', {
      totalChaos: snap.totalChaos,
      cdRatio: snap.cdRatio,
      items: snap.items,
      unpriced: snap.unpriced,
      tabsChanged: watch.look('player1', snap).changed,
      syncComplete: true
    })
  }
  await store.setTab('player1', 0, tabWith(0, 'Currency', CURRENCY))
  await store.setTab('player1', 1, tabWith(1, 'B', [{ name: 'Orb of Alteration', qty: 18, c: 0.2 }]))
  assert.equal(await record(), true)

  clock += 1000                      // inside the throttle window
  store.pruneTabs('player1', [1])
  store.pruneTabs('player1', [1])
  assert.equal(await record(), false, 'throttled either way — but the breakdown has to go all the same')

  clock += 120_000
  assert.equal(await record(), true)
  assert.equal(hist.points.at(-1).d, undefined,
    'the first point on the new tab set carries no delta rather than a delta across the change')
  await cleanup()
})
