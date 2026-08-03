// backend/v2/networth/aggregate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregate } from './aggregate.mjs'

const NOW = '2026-07-24T12:00:00.000Z'

function entry (kind, tabIndex, tabName, chaosTotal, extra = {}) {
  const stack = extra.stack || 1
  return {
    desc: { kind, name: extra.name || `${kind}-item`, stack },
    tabIndex, tabName,
    value: chaosTotal == null ? null : { chaosEach: extra.chaosEach ?? chaosTotal, chaosTotal, source: 'test' }
  }
}

test('totals, tab and category breakdown, chaos AND divine', () => {
  const s = aggregate({
    entries: [
      entry('stackable', 0, 'cur', 400),
      entry('stackable', 0, 'cur', 30.5),
      entry('unique', 1, 'uniq', 100),
      entry('unique', 1, 'uniq', null, { name: 'Niche Unique' }),        // unpriced
      { desc: { kind: 'skip', reason: 'rare-gear', name: 'Rare', stack: 1 }, tabIndex: 2, tabName: 'gear', value: null }
    ],
    cdRatio: 215, league: 'Standard', accountName: 'acc', now: NOW
  })
  assert.equal(s.at, NOW)
  assert.equal(s.league, 'Standard')
  assert.equal(s.cdRatio, 215)
  assert.equal(s.totalChaos, 530.5)
  assert.equal(s.totalDivine, 2.5)                       // round1(530.5/215)
  assert.deepEqual(s.tabs, [                             // descending by chaos
    { index: 0, name: 'cur', chaos: 430.5, items: 2 },
    { index: 1, name: 'uniq', chaos: 100, items: 1 }
  ])
  assert.deepEqual(s.categories.stackable, { chaos: 430.5, items: 2 })
  assert.deepEqual(s.categories.unique, { chaos: 100, items: 1 })
  assert.deepEqual(s.unpriced, [{ name: 'Niche Unique', kind: 'unique', count: 1 }])
  assert.deepEqual(s.counts, { priced: 3, unpriced: 1, skipped: 1 })
})

test('topItems: sell list grouped by kind|name|chaosEach, tabs collected, sorted by chaosTotal', () => {
  const s = aggregate({
    entries: [
      // Same currency, same price, two tabs -> one row, stacks summed.
      entry('stackable', 0, 'A', 200, { name: 'Divine Orb', stack: 1, chaosEach: 200 }),
      entry('stackable', 3, 'B', 400, { name: 'Divine Orb', stack: 2, chaosEach: 200 }),
      // One high-value unique.
      entry('unique', 1, 'C', 900, { name: 'Headhunter', stack: 1, chaosEach: 900 })
    ],
    cdRatio: 200, league: 'L', accountName: 'a', now: NOW
  })
  assert.equal(s.topItems.length, 2)
  // Headhunter (900) ahead of the Divine group (600) -> descending chaosTotal.
  assert.deepEqual(s.topItems[0], { name: 'Headhunter', kind: 'unique', count: 1, chaosEach: 900, chaosTotal: 900, tabs: ['C'] })
  assert.deepEqual(s.topItems[1], { name: 'Divine Orb', kind: 'stackable', count: 3, chaosEach: 200, chaosTotal: 600, tabs: ['A', 'B'] })
})

test('items[]: every priced item, grouped per tab, descending by chaosTotal', () => {
  const s = aggregate({
    entries: [
      // Same currency, same price, SAME tab -> one row (qty summed).
      entry('stackable', 0, 'A', 200, { name: 'Divine Orb', stack: 1, chaosEach: 200 }),
      entry('stackable', 0, 'A', 400, { name: 'Divine Orb', stack: 2, chaosEach: 200 }),
      // Same currency, same price, DIFFERENT tab -> its own row (tab is singular).
      entry('stackable', 3, 'B', 200, { name: 'Divine Orb', stack: 1, chaosEach: 200 }),
      entry('unique', 1, 'C', 900, { name: 'Headhunter', stack: 1, chaosEach: 900 }),
      // unpriced -> must NOT show up in items[].
      entry('unique', 1, 'C', null, { name: 'Nische' })
    ],
    cdRatio: 200, league: 'L', accountName: 'a', now: NOW
  })
  assert.equal(s.items.length, 3)
  assert.deepEqual(s.items[0], { name: 'Headhunter', kind: 'unique', tab: 'C', tabIndex: 1, qty: 1, chaosEach: 900, chaosTotal: 900 })
  assert.deepEqual(s.items[1], { name: 'Divine Orb', kind: 'stackable', tab: 'A', tabIndex: 0, qty: 3, chaosEach: 200, chaosTotal: 600 })
  assert.deepEqual(s.items[2], { name: 'Divine Orb', kind: 'stackable', tab: 'B', tabIndex: 3, qty: 1, chaosEach: 200, chaosTotal: 200 })
})

test('items[]: uncapped (far beyond the 100-entry topItems limit)', () => {
  const entries = []
  for (let i = 0; i < 150; i++) entries.push(entry('stackable', i, `t${i}`, 100 - i * 0.1, { name: `Item ${i}`, chaosEach: 100 - i * 0.1 }))
  const s = aggregate({ entries, cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.topItems.length, 100) // sell list stays capped
  assert.equal(s.items.length, 150)    // full list is uncapped
  assert.ok(s.items[0].chaosTotal >= s.items[s.items.length - 1].chaosTotal) // descending
})

test('tabs[]: sorted by in-game index, NOT by value', () => {
  const s = aggregate({
    entries: [
      entry('stackable', 5, 'spaeter-wertvoll', 1000),
      entry('stackable', 2, 'previously-cheap', 10)
    ],
    cdRatio: 200, league: 'L', accountName: 'a', now: NOW
  })
  assert.deepEqual(s.tabs.map(t => t.index), [2, 5]) // index order even though tab 5 holds more value
})

test('unpriced: grouped by name (count = sum of stacks), sorted by count', () => {
  const s = aggregate({
    entries: [
      entry('gem', 0, 'A', null, { name: 'Empower Support', stack: 1 }),
      entry('gem', 1, 'B', null, { name: 'Empower Support', stack: 1 }),
      entry('unique', 2, 'C', null, { name: 'Random Rare', stack: 1 }),
      entry('stackable', 3, 'D', null, { name: 'Mystery Frag', stack: 5 })
    ],
    cdRatio: 200, league: 'L', accountName: 'a', now: NOW
  })
  assert.deepEqual(s.unpriced, [
    { name: 'Mystery Frag', kind: 'stackable', count: 5 },
    { name: 'Empower Support', kind: 'gem', count: 2 },
    { name: 'Random Rare', kind: 'unique', count: 1 }
  ])
  assert.equal(s.counts.unpriced, 4)
})

test('empty scan -> zeros, no NaN/division errors', () => {
  const s = aggregate({ entries: [], cdRatio: 215, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.totalChaos, 0)
  assert.equal(s.totalDivine, 0)
  assert.deepEqual(s.tabs, [])
  assert.deepEqual(s.topItems, [])
  assert.deepEqual(s.unpriced, [])
  assert.deepEqual(s.counts, { priced: 0, unpriced: 0, skipped: 0 })
})

test('cdRatio 0/missing -> totalDivine 0 instead of Infinity', () => {
  const s = aggregate({ entries: [entry('stackable', 0, 't', 100)], cdRatio: 0, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.totalDivine, 0)
})

// ---- tabs path (snapshot built from store tabs) -----------------------------

// Builds the per-tab store objects from a flat entry list, exactly the way the
// scan lays them down: one aggregate() per tab, items/unpriced/counts stored.
function toStoreTabs (entries, { cdRatio = 200, league = 'L', accountName = 'a' } = {}) {
  const byTab = new Map()
  for (const e of entries) {
    if (!byTab.has(e.tabIndex)) byTab.set(e.tabIndex, { index: e.tabIndex, name: e.tabName, entries: [] })
    byTab.get(e.tabIndex).entries.push(e)
  }
  return [...byTab.values()].map(({ index, name, entries }) => {
    const per = aggregate({ entries, cdRatio, league, accountName })
    return { index, name, items: per.items, unpriced: per.unpriced, counts: per.counts }
  })
}

test('tabs path == entries path (identical shape) on collision-free data', () => {
  // Collision-free = every row is exactly one entry (distinct names/prices), so
  // row count == entry count -> byte-identical snapshot across both paths.
  const entries = [
    entry('stackable', 0, 'cur', 400, { name: 'Divine Orb', chaosEach: 400 }),
    entry('stackable', 0, 'cur', 30.5, { name: 'Chaos Orb', chaosEach: 30.5 }),
    entry('unique', 1, 'uniq', 900, { name: 'Headhunter', chaosEach: 900 }),
    entry('unique', 1, 'uniq', null, { name: 'Niche Unique' }),        // unpriced
    { desc: { kind: 'skip', reason: 'rare-gear', name: 'Rare', stack: 1 }, tabIndex: 2, tabName: 'gear', value: null }
  ]
  const fromEntries = aggregate({ entries, cdRatio: 215, league: 'Standard', accountName: 'acc', now: NOW })
  const fromTabs = aggregate({ tabs: toStoreTabs(entries, { cdRatio: 215, league: 'Standard', accountName: 'acc' }), cdRatio: 215, league: 'Standard', accountName: 'acc', now: NOW })
  // Everything EXCEPT the tab list stays byte-identical.
  assert.deepEqual({ ...fromTabs, tabs: null }, { ...fromEntries, tabs: null })
  // Deliberate difference: the tabs path knows the REAL tab list and therefore
  // also lists tabs without any priced item (here 'gear': just one skipped rare)
  // at 0c. The entries path cannot know about them. Without this the UI reported
  // "5/5 tabs" at league start while the stash actually had 17.
  assert.deepEqual(fromEntries.tabs.map(t => t.index), [0, 1])
  assert.deepEqual(fromTabs.tabs.map(t => t.index), [0, 1, 2])
  assert.deepEqual(fromTabs.tabs.find(t => t.index === 2), { index: 2, name: 'gear', chaos: 0, items: 0 })
})

test('tabs path: stacked/grouped items -> totals correct, union across tabs', () => {
  const entries = [
    entry('stackable', 0, 'A', 200, { name: 'Divine Orb', stack: 1, chaosEach: 200 }),
    entry('stackable', 0, 'A', 400, { name: 'Divine Orb', stack: 2, chaosEach: 200 }), // same tab + price -> 1 row, qty 3
    entry('stackable', 3, 'B', 200, { name: 'Divine Orb', stack: 1, chaosEach: 200 }), // different tab -> its own row
    entry('unique', 1, 'C', 900, { name: 'Headhunter', stack: 1, chaosEach: 900 })
  ]
  const s = aggregate({ tabs: toStoreTabs(entries), cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.totalChaos, 1700) // 600 (Tab A) + 200 (Tab B) + 900 (HH)
  // topItems: Divine group (qty 4, 800) below Headhunter (900).
  assert.deepEqual(s.topItems[0], { name: 'Headhunter', kind: 'unique', count: 1, chaosEach: 900, chaosTotal: 900, tabs: ['C'] })
  assert.deepEqual(s.topItems[1], { name: 'Divine Orb', kind: 'stackable', count: 4, chaosEach: 200, chaosTotal: 800, tabs: ['A', 'B'] })
  // items[]: Divine split across tab A (qty 3) and tab B (qty 1).
  assert.equal(s.items.length, 3)
  assert.deepEqual(s.tabs.map(t => t.index), [0, 1, 3]) // index-sorted
})

test('tabs path: unpriced merged across tabs (count summed)', () => {
  const entries = [
    entry('gem', 0, 'A', null, { name: 'Empower Support', stack: 1 }),
    entry('gem', 1, 'B', null, { name: 'Empower Support', stack: 1 }),
    entry('stackable', 3, 'D', null, { name: 'Mystery Frag', stack: 5 })
  ]
  const s = aggregate({ tabs: toStoreTabs(entries), cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.deepEqual(s.unpriced, [
    { name: 'Mystery Frag', kind: 'stackable', count: 5 },
    { name: 'Empower Support', kind: 'gem', count: 2 }
  ])
  assert.equal(s.counts.unpriced, 3)
})

test('tabs path: empty -> zeroed snapshot, no NaN', () => {
  const s = aggregate({ tabs: [], cdRatio: 215, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.totalChaos, 0)
  assert.equal(s.totalDivine, 0)
  assert.deepEqual(s.tabs, [])
  assert.deepEqual(s.counts, { priced: 0, unpriced: 0, skipped: 0 })
})

test('tabs path: syncedAt from the store tabs is passed through to snapshot.tabs (for the auto-sync status line)', () => {
  // Store tabs carry syncedAt (store.setTab stamps it). It has to reach the
  // matching snapshot.tabs[] entry, matched by index.
  const tabs = [
    { index: 0, name: 'A', syncedAt: 1_000, items: [{ name: 'Divine Orb', kind: 'stackable', tab: 'A', tabIndex: 0, qty: 1, chaosEach: 200, chaosTotal: 200 }], unpriced: [], counts: { priced: 1, unpriced: 0, skipped: 0 } },
    { index: 1, name: 'B', syncedAt: 5_000, items: [{ name: 'Headhunter', kind: 'unique', tab: 'B', tabIndex: 1, qty: 1, chaosEach: 900, chaosTotal: 900 }], unpriced: [], counts: { priced: 1, unpriced: 0, skipped: 0 } }
  ]
  const s = aggregate({ tabs, cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  const byIndex = Object.fromEntries(s.tabs.map(t => [t.index, t.syncedAt]))
  assert.equal(byIndex[0], 1_000)
  assert.equal(byIndex[1], 5_000)
})
