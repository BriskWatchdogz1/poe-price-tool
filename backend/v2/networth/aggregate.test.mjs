// backend/v2/networth/aggregate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregate, unpricedStock } from './aggregate.mjs'

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
  assert.deepEqual(s.unpriced, [{ name: 'Niche Unique', kind: 'unique', count: 1, tabIndex: 1 }])
  assert.deepEqual(s.counts, { priced: 3, unpriced: 1, unpricedPieces: 1, skipped: 1 })
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
  // `source` rides along on every row — once the valuation is over it is the
  // only surviving record of which feed produced the price (price-guard.mjs).
  // So does `uncertain` (docs/pricing-logic.md, "Uncertain prices"): null
  // here, because no entry named a doubt.
  assert.deepEqual(s.items[0], { name: 'Headhunter', kind: 'unique', tab: 'C', tabIndex: 1, qty: 1, chaosEach: 900, chaosTotal: 900, source: 'test', uncertain: null })
  assert.deepEqual(s.items[1], { name: 'Divine Orb', kind: 'stackable', tab: 'A', tabIndex: 0, qty: 3, chaosEach: 200, chaosTotal: 600, source: 'test', uncertain: null })
  assert.deepEqual(s.items[2], { name: 'Divine Orb', kind: 'stackable', tab: 'B', tabIndex: 3, qty: 1, chaosEach: 200, chaosTotal: 200, source: 'test', uncertain: null })
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

// One row per name AND tab (like items[]): the page filters this block by the
// stash-tab selection, which needs the tab on every row. Same name in two tabs
// = two rows; the UI re-merges them for display.
test('unpriced: grouped by name+tab (count = sum of stacks), sorted by count', () => {
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
    { name: 'Mystery Frag', kind: 'stackable', count: 5, tabIndex: 3 },
    { name: 'Empower Support', kind: 'gem', count: 1, tabIndex: 0 },
    { name: 'Empower Support', kind: 'gem', count: 1, tabIndex: 1 },
    { name: 'Random Rare', kind: 'unique', count: 1, tabIndex: 2 }
  ])
  assert.equal(s.counts.unpriced, 4)
})

// Two stacks of the same name in the SAME tab stay one row.
test('unpriced: same name twice in one tab -> one row, counts summed', () => {
  const s = aggregate({
    entries: [
      entry('stackable', 4, 'E', null, { name: 'Mystery Frag', stack: 5 }),
      entry('stackable', 4, 'E', null, { name: 'Mystery Frag', stack: 2 })
    ],
    cdRatio: 200, league: 'L', accountName: 'a', now: NOW
  })
  assert.deepEqual(s.unpriced, [{ name: 'Mystery Frag', kind: 'stackable', count: 7, tabIndex: 4 }])
})

// ---- unpriced: ENTRIES and PIECES are two numbers (B18) ---------------------
// The page prints a headline over this list. As long as the headline came from
// counts.unpriced (entries) and the rows from `count` (pieces), the two agreed
// only while every stack was one. Both units are stated now, and the tests hold
// them apart in both directions of drift.

test('unpriced: a stack larger than one -> 1 entry, N pieces (the headline used to say 1 over a row of N)', () => {
  const s = aggregate({
    entries: [entry('stackable', 0, 'A', null, { name: 'Mystery Frag', stack: 5 })],
    cdRatio: 200, league: 'L', accountName: 'a', now: NOW
  })
  assert.equal(s.counts.unpriced, 1)        // one stash entry
  assert.equal(s.counts.unpricedPieces, 5)  // …holding five pieces
  assert.deepEqual(s.unpriced, [{ name: 'Mystery Frag', kind: 'stackable', count: 5, tabIndex: 0 }])
  // The piece total is the one the rows add up to — that is the whole contract.
  assert.equal(s.unpriced.reduce((sum, u) => sum + u.count, 0), s.counts.unpricedPieces)
})

// `?? 1` let a literal 0 through (0 is not nullish) and the row then counted
// FEWER pieces than there were entries — the direction that made the headline
// too big. Unreachable through normalize.mjs (which clamps stackSize the same
// way), so this pins the clamp rather than a live case.
test('unpriced: a stack size of 0 counts as one piece, never as none', () => {
  const s = aggregate({
    entries: [
      { desc: { kind: 'unique', name: 'Unidentified Map (Tier 16)', stack: 0 }, tabIndex: 0, tabName: 'Maps', value: null },
      { desc: { kind: 'unique', name: 'Unidentified Map (Tier 16)', stack: null }, tabIndex: 0, tabName: 'Maps', value: null },
      { desc: { kind: 'unique', name: 'Unidentified Map (Tier 16)' }, tabIndex: 0, tabName: 'Maps', value: null }
    ],
    cdRatio: 200, league: 'L', accountName: 'a', now: NOW
  })
  assert.equal(s.counts.unpriced, 3)
  assert.equal(s.counts.unpricedPieces, 3)
  assert.deepEqual(s.unpriced, [{ name: 'Unidentified Map (Tier 16)', kind: 'unique', count: 3, tabIndex: 0 }])
})

// The same clamp on the priced side: a zero stack must not silently make a
// priced row's quantity zero either.
test('priced: a stack size of 0 counts as one piece', () => {
  const s = aggregate({
    entries: [{ desc: { kind: 'stackable', name: 'Chaos Orb', stack: 0 }, tabIndex: 0, tabName: 'A', value: { chaosEach: 1, chaosTotal: 1, source: 'test' } }],
    cdRatio: 200, league: 'L', accountName: 'a', now: NOW
  })
  assert.equal(s.items[0].qty, 1)
  assert.equal(s.topItems[0].count, 1)
})

// The row list is capped at UNPRICED_MAX NAMES. Everything beyond it is still
// counted in both units — that is what lets the page say how much it is not
// showing instead of quietly printing a bigger number than its own list.
test('unpriced: names beyond the display cap still count towards both totals', () => {
  const entries = []
  for (let i = 0; i < 130; i++) entries.push(entry('unique', 0, 'A', null, { name: `Unique ${i}`, stack: 2 }))
  const s = aggregate({ entries, cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.unpriced.length, 100)          // rows: capped
  assert.equal(s.counts.unpriced, 130)          // entries: complete
  assert.equal(s.counts.unpricedPieces, 260)    // pieces: complete
})

test('empty scan -> zeros, no NaN/division errors', () => {
  const s = aggregate({ entries: [], cdRatio: 215, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.totalChaos, 0)
  assert.equal(s.totalDivine, 0)
  assert.deepEqual(s.tabs, [])
  assert.deepEqual(s.topItems, [])
  assert.deepEqual(s.unpriced, [])
  assert.deepEqual(s.counts, { priced: 0, unpriced: 0, unpricedPieces: 0, skipped: 0 })
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
    // unpricedMax: Infinity like scan.mjs — what a tab stores is read back by
    // the recorder, so the store keeps every unpriced name of the tab.
    const per = aggregate({ entries, cdRatio, league, accountName, unpricedMax: Infinity })
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
  // …and the row says WHY that tab is worth 0c: one item arrived and was
  // skipped. Without `skipped` on the row, "0c · 0 items" reads exactly like a
  // tab GGG returned nothing for at all — the ambiguity that made the empty map
  // stash (B7) undecidable from the page.
  assert.deepEqual(fromTabs.tabs.find(t => t.index === 2),
    { index: 2, name: 'gear', chaos: 0, items: 0, priced: 0, unpriced: 0, unpricedPieces: 0, skipped: 1 })
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

// Merging by name across tabs is exactly what the frontend cannot undo: it
// left the unpriced block listing items from UNCHECKED tabs (divination cards
// from a deselected Divination tab next to the one selected Delve tab). Every
// row keeps its tabIndex so the page can apply the same tab filter the priced
// table uses; the cap still counts NAMES, not rows.
test('tabs path: unpriced keeps its tab (one row per name+tab)', () => {
  const entries = [
    entry('gem', 0, 'A', null, { name: 'Empower Support', stack: 1 }),
    entry('gem', 1, 'B', null, { name: 'Empower Support', stack: 1 }),
    entry('stackable', 3, 'D', null, { name: 'Mystery Frag', stack: 5 })
  ]
  const s = aggregate({ tabs: toStoreTabs(entries), cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.deepEqual(s.unpriced, [
    { name: 'Mystery Frag', kind: 'stackable', count: 5, tabIndex: 3 },
    { name: 'Empower Support', kind: 'gem', count: 1, tabIndex: 0 },
    { name: 'Empower Support', kind: 'gem', count: 1, tabIndex: 1 }
  ])
  assert.equal(s.counts.unpriced, 3)
  // Rows of a single tab still add up to that tab's share, so a tab-scoped view
  // can be built from them alone.
  const tab1 = s.unpriced.filter(u => u.tabIndex === 1)
  assert.deepEqual(tab1, [{ name: 'Empower Support', kind: 'gem', count: 1, tabIndex: 1 }])
})

// The list is capped at UNPRICED_MAX names, so it cannot state a faithful item
// count — that is what counts.unpriced does for the whole snapshot. Scoped to a
// tab selection the frontend needs the same number PER TAB, hence tabs[].unpriced.
test('tabs path: snapshot.tabs[] carries the faithful per-tab unpriced count', () => {
  const tabs = [
    {
      index: 0,
      name: 'DELVE',
      items: [{ name: 'Divine Orb', kind: 'stackable', tab: 'DELVE', tabIndex: 0, qty: 1, chaosEach: 200, chaosTotal: 200 }],
      unpriced: [{ name: 'Metallic Fossil', kind: 'stackable', count: 3 }],
      counts: { priced: 1, unpriced: 3, skipped: 0 }
    },
    {
      index: 1,
      name: 'Divination',
      items: [],
      unpriced: [{ name: 'Prosperity', kind: 'divcard', count: 9 }],
      counts: { priced: 0, unpriced: 9, skipped: 0 }
    }
  ]
  const s = aggregate({ tabs, cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.deepEqual(s.tabs.map(t => [t.index, t.unpriced]), [[0, 3], [1, 9]])
  assert.equal(s.counts.unpriced, 12) // whole snapshot = sum of the per-tab counts
})

// The per-tab PIECE total travels next to the per-tab entry count, because the
// page's summary line is in pieces and the entry count cannot answer it.
test('tabs path: snapshot.tabs[] carries the per-tab unpriced piece count as well', () => {
  const tabs = [
    {
      index: 0,
      name: 'DELVE',
      items: [],
      unpriced: [{ name: 'Metallic Fossil', kind: 'stackable', count: 30 }],
      counts: { priced: 0, unpriced: 3, unpricedPieces: 30, skipped: 0 } // 3 stacks of 10
    },
    {
      index: 1,
      name: 'Divination',
      items: [],
      unpriced: [{ name: 'Prosperity', kind: 'divcard', count: 9 }],
      counts: { priced: 0, unpriced: 9, unpricedPieces: 9, skipped: 0 }
    }
  ]
  const s = aggregate({ tabs, cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.deepEqual(s.tabs.map(t => [t.index, t.unpriced, t.unpricedPieces]), [[0, 3, 30], [1, 9, 9]])
  assert.equal(s.counts.unpriced, 12)
  assert.equal(s.counts.unpricedPieces, 39)
})

// A tab stored before unpricedPieces existed carries only its rows. Falling
// back to their sum keeps the number meaningful (and never larger than the
// truth) until the refresher next writes that tab.
test('tabs path: a stored tab without unpricedPieces falls back to its row sum', () => {
  const tabs = [{
    index: 0,
    name: 'Old',
    items: [],
    unpriced: [{ name: 'Metallic Fossil', kind: 'stackable', count: 7 }],
    counts: { priced: 0, unpriced: 2, skipped: 0 } // pre-upgrade shape
  }]
  const s = aggregate({ tabs, cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.tabs[0].unpricedPieces, 7)
  assert.equal(s.counts.unpricedPieces, 7)
})

// THE REPORTED CASE (B18). The name cap is ACCOUNT-WIDE, so a name holding one
// piece in one tab can be ranked out by busier names in OTHER tabs — and the
// row then disappears from a tab whose own list is a single line, while the
// per-tab counts still include it. The page needs both numbers to say so.
test('tabs path: the account-wide name cap can drop a row a tab still counts', () => {
  const busy = {
    index: 0,
    name: 'Everything else',
    items: [],
    unpriced: Array.from({ length: 120 }, (_, i) => ({ name: `Filler ${i}`, kind: 'unique', count: 5 })),
    counts: { priced: 0, unpriced: 120, unpricedPieces: 600, skipped: 0 }
  }
  const maps = {
    index: 1,
    name: 'Maps',
    items: [],
    unpriced: [
      { name: 'Unidentified Map (Tier 16)', kind: 'unique', count: 39 },
      { name: 'Unidentified Map (Tier 15)', kind: 'unique', count: 1 }
    ],
    counts: { priced: 0, unpriced: 40, unpricedPieces: 40, skipped: 0 }
  }
  const s = aggregate({ tabs: [busy, maps], cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  const mapRows = s.unpriced.filter(u => u.tabIndex === 1)
  // The Tier 15 row lost the ranking to 120 filler names in the other tab.
  assert.deepEqual(mapRows.map(u => u.count), [39])
  // …and the tab's own numbers still know about it, in BOTH units. That gap —
  // 40 against 39 — is what the summary line now states instead of hiding.
  const mapTab = s.tabs.find(t => t.index === 1)
  assert.equal(mapTab.unpriced, 40)
  assert.equal(mapTab.unpricedPieces, 40)
})

// The sidebar tooltip prints priced/unpriced/skipped side by side and promises
// GGG item counts. `items` next to them counts grouped display ROWS: three
// stash entries of Divine Orb at one price come back from the store as ONE row,
// and the tooltip used to read "1 priced" for them.
test('tabs path: snapshot.tabs[] carries the stored priced ENTRY count beside the row count', () => {
  const tabs = [{
    index: 0,
    name: 'Cur',
    items: [{ name: 'Divine Orb', kind: 'stackable', tab: 'Cur', tabIndex: 0, qty: 30, chaosEach: 200, chaosTotal: 6000 }],
    unpriced: [],
    counts: { priced: 3, unpriced: 0, unpricedPieces: 0, skipped: 0 }
  }]
  const s = aggregate({ tabs, cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.tabs[0].items, 1)   // rows
  assert.equal(s.tabs[0].priced, 3)  // entries
  assert.equal(s.items[0].qty, 30)   // pieces
})

test('tabs path: empty -> zeroed snapshot, no NaN', () => {
  const s = aggregate({ tabs: [], cdRatio: 215, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.totalChaos, 0)
  assert.equal(s.totalDivine, 0)
  assert.deepEqual(s.tabs, [])
  assert.deepEqual(s.counts, { priced: 0, unpriced: 0, unpricedPieces: 0, skipped: 0 })
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

// ---- the unpriced NAME cap: a display limit, and only that -------------------
//
// The cap used to reach further than the display. The net-worth recorder diffs
// the stash against its previous minute and treats an unpriced name as proof
// that the item is still there (history.mjs); a name the cap ranked out of the
// list was missing from that proof and read as stock leaving instead. The cap
// therefore applies to the snapshot that is DRAWN, and not to what is STORED.

// One tab, 100 busy unpriced names of two pieces each plus one thinly traded
// name of a single piece — which is exactly the name the ranking cuts.
const THIN = 'Thin Trader'
function crowdedTab (tabIndex = 0, tabName = 'A') {
  const out = []
  for (let i = 0; i < 100; i++) {
    out.push(entry('stackable', tabIndex, tabName, null, { name: `Filler ${i}`, stack: 2 }))
  }
  out.push(entry('unique', tabIndex, tabName, null, { name: THIN, stack: 1 }))
  return out
}
const listedPieces = rows => rows.reduce((sum, u) => sum + u.count, 0)

test('entries path: the display cap cuts at 100 NAMES and the counts still hold every piece', () => {
  const s = aggregate({ entries: crowdedTab(), cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.unpriced.length, 100, 'the drawn list is capped')
  assert.ok(!s.unpriced.some(u => u.name === THIN), 'and the rarest name is the one it cuts')
  assert.equal(s.counts.unpriced, 101, 'every unpriced ENTRY is still counted')
  assert.equal(s.counts.unpricedPieces, 201, 'and every PIECE of them')
  // What renderUnpriced prints as "N pcs not listed": the faithful piece total
  // minus what the rows on screen add up to. Still derivable, still exactly the
  // one piece the cap held back.
  assert.equal(s.counts.unpricedPieces - listedPieces(s.unpriced), 1)
})

test('entries path: a caller that stores instead of drawing gets every name', () => {
  const s = aggregate({ entries: crowdedTab(), cdRatio: 200, league: 'L', accountName: 'a', now: NOW, unpricedMax: Infinity })
  assert.equal(s.unpriced.length, 101)
  assert.equal(listedPieces(s.unpriced), s.counts.unpricedPieces, 'nothing is held back, so nothing is missing')
  assert.deepEqual(s.unpriced.find(u => u.name === THIN), { name: THIN, kind: 'unique', count: 1, tabIndex: 0 })
})

test('tabs path: snapshot capped for the page, unpricedStock() complete for the recorder', () => {
  const tabs = toStoreTabs(crowdedTab())
  const s = aggregate({ tabs, cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
  assert.equal(s.unpriced.length, 100, 'the wire snapshot keeps its cap')
  assert.ok(!s.unpriced.some(u => u.name === THIN))
  assert.equal(s.tabs[0].unpricedPieces, 201, 'the per-tab piece total the summary scopes by is untouched')
  assert.equal(s.counts.unpricedPieces - listedPieces(s.unpriced), 1, 'and "1 pcs not listed" still comes out')

  const stock = unpricedStock(tabs)
  assert.equal(stock.length, 101, 'the recorder sees the name the page cannot show')
  assert.deepEqual(stock.find(u => u.name === THIN), { name: THIN, count: 1 })
  assert.equal(listedPieces(stock), 201)
})

test('unpricedStock(): one entry per name across tabs, nothing else in it', () => {
  const tabs = [
    { index: 0, name: 'A', items: [], unpriced: [{ name: 'Empower Support', kind: 'gem', count: 1, tabIndex: 0 }] },
    { index: 1, name: 'B', items: [], unpriced: [{ name: 'Empower Support', kind: 'gem', count: 4, tabIndex: 1 }] },
    { index: 2, name: 'C', items: [] } // a tab with nothing unpriced at all
  ]
  // Merged across tabs on purpose: the diff is account-wide, so a name carried
  // from one tab to another must not read as a departure plus an arrival. And
  // `kind`/`tabIndex` are dropped — the recorder reads neither.
  assert.deepEqual(unpricedStock(tabs), [{ name: 'Empower Support', count: 5 }])
})

test('unpricedStock(): nothing, junk and a missing list are an empty answer, never a throw', () => {
  assert.deepEqual(unpricedStock([]), [])
  assert.deepEqual(unpricedStock(undefined), [])
  assert.deepEqual(unpricedStock([{ index: 0 }, null, { index: 1, unpriced: null }]), [])
  // A row without a usable name is skipped; a count that is not a positive
  // number counts as nothing, exactly as foldItems reads it.
  assert.deepEqual(unpricedStock([{ index: 0, unpriced: [{ name: '', count: 3 }, { count: 2 }, { name: 'X', count: 'n/a' }] }]),
    [{ name: 'X', count: 0 }])
})

// ---------------------------------------------------------------------------
// The uncertainty marker (docs/pricing-logic.md, "Uncertain prices"): the
// doubt of the valued entry rides on its row exactly like `source`, and it
// never moves a number (sum option (b): counted, and marked).
// ---------------------------------------------------------------------------
const doubted = (kind, tabIndex, tabName, chaosTotal, uncertain, extra = {}) => {
  const e = entry(kind, tabIndex, tabName, chaosTotal, extra)
  e.value.uncertain = uncertain
  return e
}

test('items[] carries the doubt of the valued entry, null when there is none', () => {
  const s = aggregate({
    entries: [
      doubted('gem', 0, 'A', 300, 'gem-guessed', { name: 'Enlighten Support' }),
      entry('stackable', 0, 'A', 600, { name: 'Divine Orb' })
    ],
    cdRatio: 200, league: 'L', accountName: 'a', now: NOW
  })
  assert.deepEqual(s.items.map(i => [i.name, i.uncertain]), [['Divine Orb', null], ['Enlighten Support', 'gem-guessed']])
  assert.equal(s.totalChaos, 900, 'the uncertain row counts in the total')
  assert.deepEqual(s.categories.gem, { chaos: 300, items: 1 })
})

test('a row folded from a doubted and an undoubted entry is uncertain, in either order', () => {
  for (const order of [0, 1]) {
    const pair = [
      entry('unique', 0, 'A', 5, { name: 'Voices', chaosEach: 5 }),
      doubted('unique', 0, 'A', 5, 'variant-guessed', { name: 'Voices', chaosEach: 5 })
    ]
    if (order) pair.reverse()
    const s = aggregate({ entries: pair, cdRatio: 200, league: 'L', accountName: 'a', now: NOW })
    assert.equal(s.items.length, 1)
    assert.equal(s.items[0].qty, 2)
    assert.equal(s.items[0].uncertain, 'variant-guessed', `order ${order}`)
  }
})

test('uncertain survives the round trip through the per-tab store and never changes a total', () => {
  const s = aggregate({
    tabs: [{
      index: 0,
      name: 'Cards',
      items: [
        { name: 'Imperial Legacy', kind: 'divcard', tab: 'Cards', tabIndex: 0, qty: 14, chaosEach: 4.6, chaosTotal: 64.4, source: 'faustus', uncertain: 'thin-market' },
        { name: 'Divine Orb', kind: 'stackable', tab: 'Cards', tabIndex: 0, qty: 3, chaosEach: 200, chaosTotal: 600, source: 'exchange', uncertain: null },
        // A row stored before the field existed.
        { name: 'Ancient Orb', kind: 'stackable', tab: 'Cards', tabIndex: 0, qty: 1, chaosEach: 30, chaosTotal: 30, source: 'exchange' }
      ],
      unpriced: [],
      counts: { priced: 3, unpriced: 0, unpricedPieces: 0, skipped: 0 }
    }],
    cdRatio: 200, league: 'L', accountName: 'a', now: NOW
  })
  const by = Object.fromEntries(s.items.map(i => [i.name, i.uncertain]))
  assert.deepEqual(by, { 'Imperial Legacy': 'thin-market', 'Divine Orb': null, 'Ancient Orb': null })
  assert.equal(s.totalChaos, 694.4, 'the uncertain row counts in the headline exactly as before')
  assert.equal(s.tabs[0].chaos, 694.4)
})
