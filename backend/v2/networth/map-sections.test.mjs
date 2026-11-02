import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  childMapSection, isTierMapChild, skipTierMapsEnabled,
  planFolderChildren, describeSkippedSections
} from './map-sections.mjs'

const child = (id, section) => ({
  id,
  name: '1',
  type: 'MapStash',
  ...(section === undefined ? {} : { metadata: { items: 3, map: { section, name: 'x', index: 0 } } })
})

const mapTab = { id: 'T', type: 'MapStash', name: 'Maps' }
const uniqueTab = { id: 'U', type: 'UniqueStash', name: 'Uniques' }

test('the section is read off metadata.map.section, or is null', () => {
  assert.equal(childMapSection(child('a', 'tier16')), 'tier16')
  assert.equal(childMapSection(child('a', 'unique')), 'unique')
  assert.equal(childMapSection(child('a')), null)
  assert.equal(childMapSection({ id: 'a', metadata: {} }), null)
  assert.equal(childMapSection({ id: 'a', metadata: { map: { section: '' } } }), null)
  assert.equal(childMapSection({ id: 'a', metadata: { map: { section: 7 } } }), null)
  assert.equal(childMapSection(null), null)
})

test('only an explicit tier<N> is a tier page — everything else is READ', () => {
  for (const s of ['tier1', 'tier8', 'tier16', 'TIER16']) {
    assert.equal(isTierMapChild(child('a', s)), true, s)
  }
  // The fall-through cases, one by one. Each of these is a way the rule can be
  // wrong, and each of them has to cost a request rather than a sub-tab.
  for (const s of ['unique', 'special', 'tier', 'tierX', 'tiers16', 'quad', '16', '']) {
    assert.equal(isTierMapChild(child('a', s)), false, JSON.stringify(s))
  }
  assert.equal(isTierMapChild(child('a')), false, 'no metadata at all')
  assert.equal(isTierMapChild({ id: 'a', name: '16', type: 'MapStash' }), false,
    'the NAME is a number — this is exactly what B19 skipped on, and it must not skip now')
})

test('the plan keeps every addressable child and lays the skip over it', () => {
  const children = [
    child('c0', 'unique'), child('c1', 'tier16'), child('c2', 'special'),
    child('c3', 'tier16'), child('c4', 'tier2'), { name: 'no id' }
  ]
  const { childIds, skipIds, skipSections } = planFolderChildren(mapTab, children, {})
  assert.deepEqual(childIds, ['c0', 'c1', 'c2', 'c3', 'c4'], 'nothing is dropped from the list')
  assert.deepEqual([...skipIds].sort(), ['c1', 'c3', 'c4'])
  assert.deepEqual(JSON.parse(JSON.stringify({ skipIds, skipSections })), { skipIds, skipSections },
    'both go into the walk state, which has to survive a JSON round trip')
  assert.equal(describeSkippedSections(skipSections), 'tier16 x2, tier2')
})

test('the unique stash is never skipped — its children are item classes', () => {
  const { skipIds } = planFolderChildren(uniqueTab, [child('c0', 'tier16')], {})
  assert.equal(skipIds.length, 0)
})

test('the switch is on unless it is explicitly off', () => {
  assert.equal(skipTierMapsEnabled({}), true)
  assert.equal(skipTierMapsEnabled({ POE_NETWORTH_SKIP_TIER_MAPS: '1' }), true)
  for (const v of ['0', 'false', 'no', 'off', 'OFF', ' 0 ']) {
    assert.equal(skipTierMapsEnabled({ POE_NETWORTH_SKIP_TIER_MAPS: v }), false, v)
  }
  const off = planFolderChildren(mapTab, [child('c0', 'tier16')], { POE_NETWORTH_SKIP_TIER_MAPS: '0' })
  assert.equal(off.skipIds.length, 0)
  assert.deepEqual(off.childIds, ['c0'])
})
