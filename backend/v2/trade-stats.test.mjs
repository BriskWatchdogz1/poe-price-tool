// Resolving mods that the bundled APT stat DB does not know against the public
// stat catalogue from GGG. Real case: "+2 to Level of Socketed Physical Gems"
// (the DB is missing exactly this one of the 26 Socketed-<tag>-Gems stats).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTradeStatIndex, normalizeStatText, signlessStatText } from './trade-stats.mjs'

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

// --- the entry point for a text that came out of the de->en pair table -------
//
// That table is built from GGG's own description lines, where a literal sign
// belongs to the placeholder it stands in front of and is swallowed with it
// (render() in lang-statdesc.mjs). So the English text arriving from there
// reads "# to maximum Life" where the catalogue writes "+# to maximum Life" —
// same stat, one character apart, for the whole class of flat additive mods.

test('signlessStatText drops a sign only where it belongs to a placeholder', () => {
  assert.equal(signlessStatText('+# to maximum Life'), '# to maximum Life')
  assert.equal(signlessStatText('Minions have +#% to Chaos Resistance'), 'Minions have #% to Chaos Resistance')
  assert.equal(signlessStatText('# to # Added Fire Damage'), '# to # Added Fire Damage')
})

test('resolveMatcherForm: the signless form of a catalogue entry still resolves', async () => {
  const idx = createTradeStatIndex({ fetchImpl: okFetch() })
  assert.equal(await idx.resolveMatcherForm('# to maximum Life', 'implicit'), 'implicit.stat_3299347043')
  assert.equal(await idx.resolveMatcherForm('# to Level of Socketed Physical Gems', 'implicit'), 'implicit.stat_516565950')
})

test('resolveMatcherForm: a text that DOES carry its sign is decided exactly, not loosely', async () => {
  const idx = createTradeStatIndex({ fetchImpl: okFetch() })
  assert.equal(await idx.resolveMatcherForm('+# to maximum Life', 'explicit'), 'explicit.stat_3299347043')
})

test('resolveMatcherForm: two entries that differ ONLY in the sign resolve to nothing', async () => {
  // Signed and unsigned side by side: the signless key cannot tell them apart,
  // so it must not answer at all. Guessing one of two trade ids is the failure
  // this whole path is built to avoid.
  const ambiguous = { result: [{ label: 'Implicit', entries: [
    { id: 'implicit.stat_signed', text: '+# Foo' },
    { id: 'implicit.stat_plain', text: '# Foo' },
  ] }] }
  const idx = createTradeStatIndex({ fetchImpl: async () => ({ ok: true, json: async () => ambiguous }) })
  // The plain text is still an EXACT hit and stays resolvable...
  assert.equal(await idx.resolveMatcherForm('# Foo', 'implicit'), 'implicit.stat_plain')
  // ...but a text that only exists in the signed form does not fall back onto
  // the plain one through the loose key.
  assert.equal(await idx.resolveMatcherForm('# Bar', 'implicit'), null)
})

test('resolveMatcherForm: the type still separates identical wordings', async () => {
  const idx = createTradeStatIndex({ fetchImpl: okFetch() })
  assert.equal(await idx.resolveMatcherForm('# to maximum Life', 'explicit'), 'explicit.stat_3299347043')
  assert.equal(await idx.resolveMatcherForm('# to maximum Life', 'implicit'), 'implicit.stat_3299347043')
})

test('resolve() is unchanged by the second entry point — the English path is a no-op', async () => {
  const idx = createTradeStatIndex({ fetchImpl: okFetch() })
  // Signless input is NOT resolvable through resolve(): that function still
  // compares the item's own text against the catalogue, character for
  // character, exactly as before.
  assert.equal(await idx.resolve('2 to Level of Socketed Physical Gems', 'implicit'), null)
  assert.equal(await idx.resolve('+2 to Level of Socketed Physical Gems', 'implicit'), 'implicit.stat_516565950')
})
