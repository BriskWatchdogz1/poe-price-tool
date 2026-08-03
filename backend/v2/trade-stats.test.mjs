// Resolving mods that the bundled APT stat DB does not know against the public
// stat catalogue from GGG. Real case: "+2 to Level of Socketed Physical Gems"
// (the DB is missing exactly this one of the 26 Socketed-<tag>-Gems stats).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTradeStatIndex, normalizeStatText } from './trade-stats.mjs'

// Miniature catalogue in the real shape GGG serves (result[].entries[]).
const CATALOGUE = {
  result: [
    { label: 'Implicit', entries: [
      { id: 'implicit.stat_516565950', text: '+# to Level of Socketed Physical Gems' },
      { id: 'implicit.stat_3299347043', text: '+# to maximum Life' },
      { id: 'implicit.stat_opt', text: '# Something', option: { options: [{ id: 1, text: 'x' }] } },
    ] },
    { label: 'Explicit', entries: [
      { id: 'explicit.stat_3299347043', text: '+# to maximum Life' },
    ] },
  ],
}

const okFetch = (calls = []) => async (url) => {
  calls.push(url)
  return { ok: true, json: async () => CATALOGUE }
}

test('normalizeStatText: rolled numbers become the # placeholders GGG uses', () => {
  assert.equal(normalizeStatText('+2 to Level of Socketed Physical Gems'), '+# to Level of Socketed Physical Gems')
  assert.equal(normalizeStatText('+33 to maximum Life'), '+# to maximum Life')
  assert.equal(normalizeStatText('12.5% increased  Damage'), '#% increased Damage')
})

test('resolve: finds the trade id for the real corruption implicit', async () => {
  const idx = createTradeStatIndex({ fetchImpl: okFetch() })
  assert.equal(await idx.resolve('+2 to Level of Socketed Physical Gems', 'implicit'), 'implicit.stat_516565950')
})

test('resolve: the type separates identical wordings (implicit vs explicit)', async () => {
  const idx = createTradeStatIndex({ fetchImpl: okFetch() })
  assert.equal(await idx.resolve('+33 to maximum Life', 'implicit'), 'implicit.stat_3299347043')
  assert.equal(await idx.resolve('+33 to maximum Life', 'explicit'), 'explicit.stat_3299347043')
})

test('resolve: unknown text -> null (stays "not searchable", never a wrong match)', async () => {
  const idx = createTradeStatIndex({ fetchImpl: okFetch() })
  assert.equal(await idx.resolve('+2 to Level of Socketed Nonsense Gems', 'implicit'), null)
})

test('option stats are skipped (cannot be matched reliably from flat text)', async () => {
  const idx = createTradeStatIndex({ fetchImpl: okFetch() })
  assert.equal(await idx.resolve('5 Something', 'implicit'), null)
})

test('the catalogue is loaded only ONCE (TTL) — no fetch per item', async () => {
  const calls = []
  const idx = createTradeStatIndex({ fetchImpl: okFetch(calls) })
  await idx.resolve('+2 to Level of Socketed Physical Gems', 'implicit')
  await idx.resolve('+33 to maximum Life', 'implicit')
  await idx.resolve('anything', 'implicit')
  assert.equal(calls.length, 1, 'exactly one catalogue fetch for many resolves')
})

test('a fetch error degrades quietly (null) and enters a cooldown instead of a fetch loop', async () => {
  const calls = []
  let clock = 0
  const failFetch = async (url) => { calls.push(url); throw new Error('network down') }
  const idx = createTradeStatIndex({ fetchImpl: failFetch, now: () => clock })
  assert.equal(await idx.resolve('+2 to Level of Socketed Physical Gems', 'implicit'), null)
  await idx.resolve('+2 to Level of Socketed Physical Gems', 'implicit')
  await idx.resolve('+2 to Level of Socketed Physical Gems', 'implicit')
  assert.equal(calls.length, 1, 'after one failure do not hammer again (cooldown)')
  clock += 11 * 60 * 1000 // cooldown over
  await idx.resolve('+2 to Level of Socketed Physical Gems', 'implicit')
  assert.equal(calls.length, 2, 'after the cooldown exactly one new attempt')
})

test('an HTTP error (e.g. 429) does not throw, it returns null', async () => {
  const idx = createTradeStatIndex({ fetchImpl: async () => ({ ok: false, status: 429 }) })
  assert.equal(await idx.resolve('+2 to Level of Socketed Physical Gems', 'implicit'), null)
})
