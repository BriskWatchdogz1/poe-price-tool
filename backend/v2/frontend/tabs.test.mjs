// Stash tab identity: index instead of name (gitignored, local).
// The live finding these tests pin down: 18 tabs, four of them WITHOUT a name ->
// the sidebar showed only 15, and unchecking one unnamed tab excluded every
// unnamed tab at once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tabLabel, orderedTabs, migrateTabNames, tabState, nextTabState, TAB_STATES } from './tabs.js'

// 18 tabs as seen live: four without a name (index 4, 9, 12, 17).
const UNNAMED = new Set([4, 9, 12, 17])
const TABS = Array.from({ length: 18 }, (_, i) => ({
  index: i, name: UNNAMED.has(i) ? '' : `Tab${i}`, chaos: i * 10
}))

test('four unnamed tabs stay four entries', () => {
  const out = orderedTabs(TABS, [])
  assert.equal(out.length, 18)
  assert.deepEqual(out.map(t => t.index), [...Array(18).keys()])
  const labels = out.filter(t => UNNAMED.has(t.index)).map(tabLabel)
  assert.deepEqual(labels, ['Tab #4', 'Tab #9', 'Tab #12', 'Tab #17'])
  assert.equal(new Set(out.map(tabLabel)).size, 18, 'every label unique')
})

test('tabLabel: the name wins, whitespace-only counts as unnamed', () => {
  assert.equal(tabLabel({ index: 2, name: 'Currency' }), 'Currency')
  assert.equal(tabLabel({ index: 2, name: '   ' }), 'Tab #2')
  assert.equal(tabLabel({ index: 0, name: '' }), 'Tab #0')
  assert.equal(tabLabel({ name: '' }), 'Tab')
  assert.equal(tabLabel(null), 'Tab')
})

test('stored order first, new tabs after it by index', () => {
  const out = orderedTabs(TABS, [9, 3, 99]) // 99 does not exist -> ignored
  assert.deepEqual(out.slice(0, 2).map(t => t.index), [9, 3])
  const rest = out.slice(2).map(t => t.index)
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b))
  assert.equal(out.length, 18)
})

test('order from localStorage comes back as strings and still counts', () => {
  assert.deepEqual(orderedTabs(TABS, ['9', '3']).slice(0, 2).map(t => t.index), [9, 3])
})

test('duplicate indices in the snapshot/order are de-duplicated', () => {
  const dupes = [{ index: 1, name: 'A' }, { index: 1, name: 'A' }, { index: 2, name: '' }]
  assert.deepEqual(orderedTabs(dupes, [2, 2, 1]).map(t => t.index), [2, 1])
})

test('excluding one unnamed tab hits only that tab', () => {
  // This is the logic from networth.js: a Set of indices, isTabOn by index.
  const off = new Set([9])
  const on = TABS.filter(t => !off.has(Number(t.index)))
  assert.equal(on.length, 17)
  assert.deepEqual(on.filter(t => UNNAMED.has(t.index)).map(t => t.index), [4, 12, 17])
})

test('migration: the old name list is mapped onto indices', () => {
  assert.deepEqual(migrateTabNames(['Tab3', 'Tab0', 'Tab17'], TABS), [3, 0])
})

test('migration: empty and ambiguous names are skipped', () => {
  const tabs = [
    { index: 0, name: 'Dubl' }, { index: 1, name: 'Dubl' },
    { index: 2, name: '' }, { index: 3, name: 'Klar' }
  ]
  // '' cannot be resolved, 'Dubl' is ambiguous -> rather show one tab too many
  assert.deepEqual(migrateTabNames(['Dubl', '', 'Klar', 'Weg'], tabs), [3])
  assert.deepEqual(migrateTabNames(null, tabs), [])
  assert.deepEqual(migrateTabNames(['Klar', 'Klar'], tabs), [3])
})

// --- tri-state: on / off / permanently ignored ------------------------------
test('cycle: on -> off -> ignored -> on', () => {
  assert.deepEqual(TAB_STATES, ['on', 'off', 'ignored'])
  assert.equal(nextTabState('on'), 'off')
  assert.equal(nextTabState('off'), 'ignored')
  assert.equal(nextTabState('ignored'), 'on')
})

test('cycle: an unknown starting state lands on "on"', () => {
  assert.equal(nextTabState('quatsch'), 'on')
  assert.equal(nextTabState(undefined), 'on')
})

test('tabState reads both sets, ignored takes precedence', () => {
  const off = new Set([1, 3])
  const ign = new Set([3, 5])
  assert.equal(tabState(0, off, ign), 'on')
  assert.equal(tabState(1, off, ign), 'off')
  assert.equal(tabState(3, off, ign), 'ignored') // in both sets
  assert.equal(tabState(5, off, ign), 'ignored')
  assert.equal(tabState('5', off, ign), 'ignored') // the index arrives as a string from the DOM
  assert.equal(tabState(0, null, null), 'on')
})

test('All/None/Only-w-value do not touch ignored tabs', () => {
  // Mirror of applyTabMode(): the three modes derive ONLY from non-ignored
  // tabs, ignored ones stay off no matter which mode is picked.
  const ign = new Set([4, 9])
  const selectable = TABS.filter(t => !ign.has(t.index))
  const offAll = new Set()
  const offNone = new Set(selectable.map(t => t.index))
  for (const i of ign) {
    assert.equal(tabState(i, offAll, ign), 'ignored')  // "All" does not bring them back
    assert.equal(tabState(i, offNone, ign), 'ignored')
    assert.ok(!offNone.has(i))                          // and "None" does not flip them to "off" either
  }
  assert.equal(tabState(0, offAll, ign), 'on')
  assert.equal(tabState(0, offNone, ign), 'off')
})
