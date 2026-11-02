// backend/v2/networth/folder-walk.test.mjs
//
// A folder tab as a walk that can be put down and picked back up. What has to
// hold, and why each one is here:
//
//   1. THE REQUEST COUNT IS UNCHANGED. 1+N, in the same order, whether the walk
//      is driven in a loop or one step at a time. This is the assurance that
//      makes the change unable to increase the volume in any constellation —
//      the whole point of it is WHEN the requests go out, never how many.
//   2. One step is one request. Never two, never zero.
//   3. A half-walked tab is not a result. Only a finished walk yields items,
//      and only a finished walk with none of them warns about it (B7).
//   4. The state is plain data: nothing in it holds a client, a clock or a
//      promise, so the refresher can carry it from one tick's client to the
//      next tick's freshly built one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beginFolderWalk, stepFolderWalk, finishFolderWalk,
  folderWalkFinished, folderWalkComplete, folderWalkRead, folderWalkTotal, walkFolderTab
} from './folder-walk.mjs'

const TAB = { index: 2, name: 'Maps', type: 'MapStash', id: 'PARENT' }

/** The map stash as measured: 37 addressable sub-tabs, one item in each. */
function mockApi ({ n = 37, parentItems = [], childItems = () => [{ typeLine: 'x' }], fail = () => null } = {}) {
  const calls = []
  return {
    calls,
    async listTabChildren (tab) {
      calls.push('list')
      const e = fail('list')
      if (e) throw e
      return {
        listed: n,
        childIds: Array.from({ length: n }, (_, i) => `C${i}`),
        items: [...parentItems]
      }
    },
    async fetchTabChild (tab, childId) {
      calls.push(childId)
      const e = fail(childId)
      if (e) throw e
      return { items: childItems(childId), hasItemsArray: true, hasOwnChildren: false }
    }
  }
}

const silent = { log () {}, warn () {} }
function recorder () {
  const lines = []
  return { lines, log: m => lines.push(String(m)), warn: m => lines.push(String(m)) }
}

// ---------------------------------------------------------------------------
// 1 + 2. The same requests, one per step
// ---------------------------------------------------------------------------

test('a 37-sub-tab folder tab is 38 requests, one per step, in order', async () => {
  const api = mockApi({ n: 37 })
  const w = beginFolderWalk(TAB)
  let steps = 0
  while (!folderWalkFinished(w)) {
    const before = api.calls.length
    await stepFolderWalk(api, w, silent)
    assert.equal(api.calls.length - before, 1, 'a step is exactly one request')
    steps++
  }
  assert.equal(steps, 38, '1 sub-tab list + 37 sub-tabs')
  assert.deepEqual(api.calls, ['list', ...Array.from({ length: 37 }, (_, i) => `C${i}`)])
  assert.equal(finishFolderWalk(w, silent).length, 37)
})

test('step by step and all at once send exactly the same requests', async () => {
  // The volume assurance, stated as an equality rather than as a count: the
  // refresher's tick-by-tick walk and the client's own loop are the same walk.
  const a = mockApi({ n: 37, parentItems: [{ typeLine: 'loose' }] })
  const b = mockApi({ n: 37, parentItems: [{ typeLine: 'loose' }] })
  const looped = await walkFolderTab(a, TAB, silent)

  const w = beginFolderWalk(TAB)
  while (!folderWalkFinished(w)) await stepFolderWalk(b, w, silent)
  const spread = finishFolderWalk(w, silent)

  assert.deepEqual(b.calls, a.calls, 'same requests, same order')
  assert.deepEqual(spread, looped, 'and the same items out the other end')
  assert.equal(a.calls.length, 38)
})

test('a folder tab with no sub-tabs at all is one request and is finished', async () => {
  const api = mockApi({ n: 0 })
  const w = beginFolderWalk(TAB)
  assert.equal(folderWalkFinished(w), false, 'not finished before the list has even been asked for')
  await stepFolderWalk(api, w, silent)
  assert.equal(folderWalkFinished(w), true)
  assert.deepEqual(api.calls, ['list'])
})

test('progress is answerable at every point, and null before the list arrives', async () => {
  const api = mockApi({ n: 3 })
  const w = beginFolderWalk(TAB)
  assert.equal(folderWalkTotal(w), null, 'how many sub-tabs there are is not known yet')
  assert.equal(folderWalkRead(w), 0)
  await stepFolderWalk(api, w, silent)
  assert.equal(folderWalkTotal(w), 3)
  assert.equal(folderWalkRead(w), 0)
  await stepFolderWalk(api, w, silent)
  assert.equal(folderWalkRead(w), 1)
})

// ---------------------------------------------------------------------------
// 3. A half-walked tab is not a result
// ---------------------------------------------------------------------------

test('the B7 yield line fires for a FINISHED walk with no items — and says what it always said', () => {
  const log = recorder()
  const w = beginFolderWalk(TAB)
  w.childIds = ['C0', 'C1']
  w.listed = 2
  w.cursor = 2
  w.withItemsArray = 2
  w.withItems = 0
  assert.deepEqual(finishFolderWalk(w, log), [])
  assert.equal(log.lines.length, 1)
  assert.match(log.lines[0], /folder tab "Maps" \(MapStash\) yielded 0 items/)
  assert.match(log.lines[0], /2 sub-tabs, 2 answered with an items array, 0 of those non-empty, 0 carry children of their own/)
})

test('a walk that has read nothing YET says nothing — mid-walk is not "empty"', async () => {
  const log = recorder()
  const api = mockApi({ n: 5, childItems: () => [] })
  const w = beginFolderWalk(TAB)
  await stepFolderWalk(api, w, log)
  await stepFolderWalk(api, w, log)
  assert.equal(folderWalkFinished(w), false)
  assert.equal(log.lines.filter(l => l.includes('yielded 0 items')).length, 0,
    'the empty-tab warning belongs to a completed walk, not to a walk in progress')
})

test('the opening bracket fires once, before the first request', async () => {
  const log = recorder()
  const api = mockApi({ n: 4 })
  const w = beginFolderWalk(TAB)
  await stepFolderWalk(api, w, log)
  await stepFolderWalk(api, w, log)
  await stepFolderWalk(api, w, log)
  const opens = log.lines.filter(l => l.includes('reading sub-tabs'))
  assert.equal(opens.length, 1, 'one line per folder-tab turn, not one per sub-tab')
  assert.match(opens[0], /folder tab "Maps" \(MapStash\): reading sub-tabs/)
})

test('a sub-tab GGG listed but the walk cannot address makes the walk INCOMPLETE, and the line says how many', async () => {
  // An entry with no id cannot be fetched, but it was listed — and the line
  // exists to say how many sub-tabs there are, not how many worked. Three of
  // the four were never asked for, so this walk does not know what is in that
  // tab: it throws instead of handing up the one sub-tab it did read, because
  // the caller would store that as the whole tab and the recorder would read
  // the rest as stock leaving the stash (docs/bugs.md B2).
  const api = {
    calls: [],
    async listTabChildren () { return { listed: 4, childIds: ['C0'], items: [] } },
    async fetchTabChild () { return { items: [], hasItemsArray: true, hasOwnChildren: false } }
  }
  const log = recorder()
  const w = beginFolderWalk(TAB)
  while (!folderWalkFinished(w)) await stepFolderWalk(api, w, log)
  assert.equal(folderWalkComplete(w), false)
  assert.throws(() => finishFolderWalk(w, log), e => e.kind === 'unread')
  const line = log.lines.find(l => l.includes('was NOT read in full'))
  assert.match(line, /4 sub-tabs, 1 answered with an items array/)
  assert.match(line, /3 could not be addressed at all/)
})

test('a sub-tab that answers 200 without an items array is UNKNOWN, not empty', async () => {
  // B7's measured shape, one level up: the walk finishes, nothing threw, and
  // the tab it would hand up is a SUBSET. That subset used to be written as the
  // tab — which is a whole stash tab's worth of items leaving and, on the next
  // turn that got a real answer, arriving again (docs/bugs.md B2).
  const api = {
    calls: [],
    async listTabChildren () { return { listed: 2, childIds: ['C0', 'C1'], items: [] } },
    async fetchTabChild (tab, id) {
      return id === 'C1'
        ? { items: [], hasItemsArray: false, hasOwnChildren: false }
        : { items: [{ typeLine: 'Chaos Orb' }], hasItemsArray: true, hasOwnChildren: false }
    }
  }
  const log = recorder()
  const w = beginFolderWalk(TAB)
  while (!folderWalkFinished(w)) await stepFolderWalk(api, w, log)
  assert.equal(folderWalkFinished(w), true, 'the cursor ran out…')
  assert.equal(folderWalkComplete(w), false, '…which is not the same as every sub-tab having answered')
  assert.throws(() => finishFolderWalk(w, log), e => e.kind === 'unread')
  assert.match(log.lines.find(l => l.includes('was NOT read in full')), /1 answered with something else/)
})

test('a walk in which every listed sub-tab answered is complete, empty or not', async () => {
  const api = {
    calls: [],
    async listTabChildren () { return { listed: 2, childIds: ['C0', 'C1'], items: [] } },
    async fetchTabChild () { return { items: [], hasItemsArray: true, hasOwnChildren: false } }
  }
  const log = recorder()
  const w = beginFolderWalk(TAB)
  while (!folderWalkFinished(w)) await stepFolderWalk(api, w, log)
  assert.equal(folderWalkComplete(w), true)
  // A tab that was READ and holds nothing is a fact, and it is recorded as one.
  assert.deepEqual(finishFolderWalk(w, log), [])
  assert.match(log.lines.find(l => l.includes('yielded 0 items')), /2 sub-tabs, 2 answered with an items array/)
})

// ---------------------------------------------------------------------------
// 4. Plain data, and what a failure leaves behind
// ---------------------------------------------------------------------------

test('the walk state holds nothing but data — it can outlive the client that filled it', async () => {
  const api = mockApi({ n: 3 })
  const w = beginFolderWalk(TAB)
  await stepFolderWalk(api, w, silent)
  await stepFolderWalk(api, w, silent)
  // Round-trip through JSON: if anything in here were a function, a promise or
  // a client, this would not survive it. The refresher carries this state from
  // one tick's client to the next tick's freshly built one.
  const revived = JSON.parse(JSON.stringify(w))
  assert.deepEqual(revived, w)
  const api2 = mockApi({ n: 3 })
  while (!folderWalkFinished(revived)) await stepFolderWalk(api2, revived, silent)
  assert.deepEqual(api2.calls, ['C1', 'C2'], 'it resumes where it stopped — no request is spent twice')
  assert.equal(finishFolderWalk(revived, silent).length, 3)
})

test('a sub-tab that throws does not get retried forever by a caller that resumes', async () => {
  const api = mockApi({ n: 3, fail: id => (id === 'C1' ? new Error('boom') : null) })
  const w = beginFolderWalk(TAB)
  await stepFolderWalk(api, w, silent)                       // the list
  await stepFolderWalk(api, w, silent)                       // C0
  await assert.rejects(() => stepFolderWalk(api, w, silent))  // C1
  await stepFolderWalk(api, w, silent)                       // C2, not C1 again
  assert.deepEqual(api.calls, ['list', 'C0', 'C1', 'C2'])
  assert.equal(folderWalkFinished(w), true)
})

// ---------------------------------------------------------------------------
// 5. Sub-tabs the walk is told to pass over (networth/map-sections.mjs)
// ---------------------------------------------------------------------------
//
// The skip is handed in by `listTabChildren` as a set laid over `childIds` —
// the walk itself knows nothing about maps or tiers. What it owes:
//   - a skipped sub-tab costs NO request,
//   - it does not cost a STEP either (a tick spent on discovering there is
//     nothing left to ask for is 30s of the refresher's round for nothing),
//   - it counts as a KNOWN state, so the tab is still written,
//   - and it is said out loud, unconditionally.

/** Like mockApi, but every id in `skip` is marked and must never be fetched. */
function skippingApi ({ n = 6, skip = [], sections = [] } = {}) {
  const calls = []
  return {
    calls,
    async listTabChildren () {
      calls.push('list')
      return {
        listed: n,
        childIds: Array.from({ length: n }, (_, i) => `C${i}`),
        skipIds: skip,
        skipSections: sections,
        items: []
      }
    },
    async fetchTabChild (tab, childId) {
      calls.push(childId)
      return { items: [{ typeLine: childId }], hasItemsArray: true, hasOwnChildren: false }
    }
  }
}

test('a skipped sub-tab is never fetched, and costs neither a request nor a step', async () => {
  const api = skippingApi({ n: 6, skip: ['C1', 'C2', 'C4', 'C5'] })
  const w = beginFolderWalk(TAB)
  let steps = 0
  while (!folderWalkFinished(w)) { await stepFolderWalk(api, w, silent); steps++ }
  // list + C0 + C3. The trailing C4/C5 do NOT need a step of their own.
  assert.deepEqual(api.calls, ['list', 'C0', 'C3'])
  assert.equal(steps, 3)
  assert.equal(w.skipped, 4)
})

test('a walk of nothing but skips finishes on the list step alone', async () => {
  const api = skippingApi({ n: 3, skip: ['C0', 'C1', 'C2'] })
  const w = beginFolderWalk(TAB)
  await stepFolderWalk(api, w, silent)
  assert.equal(folderWalkFinished(w), true)
  assert.deepEqual(api.calls, ['list'])
})

test('a skipped sub-tab is a KNOWN state: the tab is complete and gets written', async () => {
  const api = skippingApi({ n: 4, skip: ['C1', 'C3'] })
  const items = await walkFolderTab(api, TAB, silent)
  assert.deepEqual(items.map(i => i.typeLine), ['C0', 'C2'])
})

test('an UNANSWERED sub-tab still blocks the tab, skips or no skips', async () => {
  const api = skippingApi({ n: 3, skip: ['C2'] })
  api.fetchTabChild = async childId => ({ items: [], hasItemsArray: false, hasOwnChildren: false })
  const w = beginFolderWalk(TAB)
  while (!folderWalkFinished(w)) await stepFolderWalk(api, w, silent)
  assert.equal(folderWalkComplete(w), false)
  assert.throws(() => finishFolderWalk(w, silent), e => e.kind === 'unread')
})

test('the skip is logged unconditionally, with the sections and the way back', async () => {
  const log = recorder()
  const api = skippingApi({ n: 4, skip: ['C1', 'C2'], sections: [['tier16', 2]] })
  await walkFolderTab(api, TAB, log)
  const line = log.lines.find(l => l.includes('2 of 4 sub-tabs not read'))
  assert.ok(line, `no skip line in:\n${log.lines.join('\n')}`)
  assert.match(line, /tier16 x2/)
  assert.match(line, /POE_NETWORTH_SKIP_TIER_MAPS=0/)
})

test('no skips means no skip line and no behaviour change at all', async () => {
  const log = recorder()
  const api = skippingApi({ n: 3, skip: [] })
  await walkFolderTab(api, TAB, log)
  assert.deepEqual(api.calls, ['list', 'C0', 'C1', 'C2'])
  assert.equal(log.lines.some(l => l.includes('not read')), false)
})

test('an api that says nothing about skips is walked exactly as before', async () => {
  const api = mockApi({ n: 5 })
  const w = beginFolderWalk(TAB)
  while (!folderWalkFinished(w)) await stepFolderWalk(api, w, silent)
  assert.equal(w.skipped, 0)
  assert.equal(folderWalkComplete(w), true)
  assert.equal(api.calls.length, 6)
})
