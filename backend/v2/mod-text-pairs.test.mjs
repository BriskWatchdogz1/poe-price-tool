// The localized -> English bridge on its own: normalization, ambiguity, and
// when the table is read.
//
// unknown-mod-repair.test.mjs next door is the end-to-end proof against the
// real server and the real German set; this file pins the rules that decide
// whether the bridge answers at all, and it does so with abstract texts on
// purpose — the point here is the mechanism, not the vocabulary.
//
// The one thing that MUST agree with something outside this module is the
// normalization: the table is keyed by the generator's matchKey (lang-statdesc)
// over description lines, and the bridge has to hit those keys from a mod line
// that carries rolled numbers instead of placeholders. That agreement is
// checked against matchKey itself, and — where a shipped German set exists —
// against the shipped table.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { modTextKey, parseTextPairs, createModTextBridge, TEXT_PAIRS_FILE } from './mod-text-pairs.mjs'
import { matchKey } from './lang-statdesc.mjs'

const ndjson = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n'

// --- normalization ----------------------------------------------------------

test('a rolled line normalizes to exactly what matchKey makes of its description line', () => {
  // The two forms of the same text: how it stands in stat_descriptions.txt
  // (what the generator keys the table by) and how it reaches us from a
  // clipboard. Both must come out identical, sign included — `{0:+d}` renders
  // to `#`, so `+12` has to as well.
  assert.equal(modTextKey('a +12 b 3.5 c'), matchKey('a {0:+d} b {1} c'))
  assert.equal(modTextKey('a -12 b'), matchKey('a {0} b'))
})

test('whitespace is collapsed the way matchKey collapses it', () => {
  assert.equal(modTextKey(' a  \n b\t'), matchKey(' a  \n b\t'))
  assert.equal(modTextKey('a\nb'), 'a b')
})

test('nothing to normalize is not a crash', () => {
  assert.equal(modTextKey(null), '')
  assert.equal(modTextKey(undefined), '')
})

// --- the table --------------------------------------------------------------

test('one candidate is an answer, two are not', () => {
  const map = parseTextPairs(ndjson([
    { t: 'x #', en: ['X #'] },
    { t: 'y #', en: ['Y #', 'Z #'] }
  ]))
  assert.equal(map.get('x #'), 'X #')
  assert.equal(map.get('y #'), null, 'two English texts for one key resolve to nothing')
})

test('two lines that disagree about the same key poison it', () => {
  const map = parseTextPairs(ndjson([
    { t: 'x #', en: ['X #'] },
    { t: 'x #', en: ['Q #'] }
  ]))
  assert.equal(map.get('x #'), null)
})

test('two lines that agree about the same key keep the answer', () => {
  const map = parseTextPairs(ndjson([{ t: 'x #', en: ['X #'] }, { t: 'x #', en: ['X #'] }]))
  assert.equal(map.get('x #'), 'X #')
})

test('unusable lines are skipped, they do not take the table down', () => {
  const map = parseTextPairs(
    'not json\n' +
    ndjson([{ t: '', en: ['X'] }, { t: 'a', en: [] }, { t: 'b' }, { t: 'c', en: ['C'] }]) +
    '\n\n'
  )
  assert.deepEqual([...map], [['a', null], ['c', 'C']])
})

// --- the bridge -------------------------------------------------------------

const bridgeOver = (byLang, calls = []) => createModTextBridge({
  resolvePath: lang => `/does-not-exist/${lang}/${TEXT_PAIRS_FILE}`,
  read: async path => {
    calls.push(path)
    const lang = path.split('/')[2]
    if (!(lang in byLang)) throw new Error('ENOENT')
    return byLang[lang]
  },
  log: { warn () {}, log () {} }
})

test('a rolled mod line comes back as its English text', async () => {
  const bridge = bridgeOver({ de: ndjson([{ t: 'x # y', en: ['X # Y'] }]) })
  assert.equal(await bridge.toEnglish('x +7 y', 'de'), 'X # Y')
})

test('ambiguous and unknown are the same answer: nothing', async () => {
  const bridge = bridgeOver({ de: ndjson([{ t: 'x #', en: ['X #', 'Q #'] }]) })
  assert.equal(await bridge.toEnglish('x 7', 'de'), null, 'ambiguous is rejected, not resolved')
  assert.equal(await bridge.toEnglish('nothing like it', 'de'), null)
})

test('the table is read once, however many mods ask', async () => {
  const calls = []
  const bridge = bridgeOver({ de: ndjson([{ t: 'x #', en: ['X #'] }]) }, calls)
  await Promise.all([bridge.toEnglish('x 1', 'de'), bridge.toEnglish('x 2', 'de')])
  await bridge.toEnglish('x 3', 'de')
  assert.equal(calls.length, 1, 'concurrent lookups share one read, not one each')
})

test('reload() drops it, so the next snapshot brings its own', async () => {
  const calls = []
  const bridge = bridgeOver({ de: ndjson([{ t: 'x #', en: ['X #'] }]) }, calls)
  await bridge.toEnglish('x 1', 'de')
  bridge.reload()
  await bridge.toEnglish('x 1', 'de')
  assert.equal(calls.length, 2)
})

test('no table for that language is not an error — it is the state before the first generator run', async () => {
  const bridge = bridgeOver({})
  assert.equal(await bridge.toEnglish('x 1', 'de'), null)
  assert.equal(await bridge.size('de'), 0)
})

test('each language reads its own file', async () => {
  const calls = []
  const bridge = bridgeOver({ de: ndjson([{ t: 'x #', en: ['D #'] }]), ru: ndjson([{ t: 'x #', en: ['R #'] }]) }, calls)
  assert.equal(await bridge.toEnglish('x 1', 'de'), 'D #')
  assert.equal(await bridge.toEnglish('x 1', 'ru'), 'R #')
  assert.equal(calls.length, 2)
})

// --- against the shipped table ----------------------------------------------

const DE_PAIRS = fileURLToPath(new URL(`../../renderer/public/data/de/${TEXT_PAIRS_FILE}`, import.meta.url))
const skip = existsSync(DE_PAIRS) ? false : 'no generated data/de here — run lang-data-gen.mjs first'

test('every shipped key without a literal number is already in the bridge\'s normal form', { skip }, async () => {
  // The exact statement of "the two normalizations agree": run the generator's
  // own keys through the bridge's mask and nothing may move. Keys that carry a
  // LITERAL number ("per 15 Evasion Rating on Shield") are excluded, and that
  // exclusion is the known limit of this path rather than a loophole — the mask
  // cannot tell a rolled number from one the game text spells out, so those
  // lines are not reachable through the table. They stay read-only on the card
  // and are counted in the gap view, which is the safe direction.
  const table = parseTextPairs(await readFile(DE_PAIRS, 'utf8'))
  assert.ok(table.size > 0, 'the shipped table is not empty')
  let checked = 0
  for (const key of table.keys()) {
    if (/\d/.test(key)) continue
    assert.equal(modTextKey(key), key)
    checked++
  }
  assert.ok(checked > 0, 'there are digit-free keys to check')
})
