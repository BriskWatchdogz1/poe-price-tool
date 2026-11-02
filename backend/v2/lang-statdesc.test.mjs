// lang-statdesc.mjs — the parser for GGG's Metadata/StatDescriptions/*.txt and
// the two text renderers on top of it.
//
// Everything here runs on a few hundred bytes of inline fixture, never on the
// 51 MB of real game data: the derivation is only as trustworthy as this
// parser, and a test that needs a download is a test nobody runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseStatDescriptions, splitDescLine, placeholders,
  render, matchKey, grammarForms, grammarPlain
} from './lang-statdesc.mjs'

// One block with an English and a German section, exactly the shape of the
// real file: tab indentation, condition ranges, quoted text, handlers.
const FIXTURE = [
  'description',
  '\t1 physical_damage_+%',
  '\t2',
  '\t\t1|# "{0}% increased Physical Damage"',
  '\t\t#|-1 "{0}% reduced Physical Damage" negate 1',
  '\tlang "German"',
  '\t2',
  '\t\t1|# "{0}% erhöhter physischer Schaden"',
  '\t\t#|-1 "{0}% verringerter physischer Schaden" negate 1',
  'description',
  '\t1 mod_granted_passive_hash',
  '\t1',
  '\t\t# "Allocates {0}" passive_hash 1',
  '\tlang "German"',
  '\t1',
  '\t\t# "Weist zu: {0}" passive_hash 1',
  ''
].join('\n')

test('parses blocks, ids and per-language rows', () => {
  const blocks = parseStatDescriptions(FIXTURE)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0].ids, ['physical_damage_+%'])
  assert.deepEqual([...blocks[0].langs.keys()], ['English', 'German'])
  assert.equal(blocks[0].langs.get('English').length, 2)
  assert.equal(blocks[0].langs.get('German').length, 2)
  assert.equal(blocks[1].langs.get('German')[0].text, 'Weist zu: {0}')
})

test('line i of the German block is line i of the English block', () => {
  // The property Gate 0-5 established and the whole derivation rests on.
  const [b] = parseStatDescriptions(FIXTURE)
  const en = b.langs.get('English')
  const de = b.langs.get('German')
  assert.equal(en.length, de.length)
  for (let i = 0; i < en.length; i++) {
    assert.equal(en[i].cond, de[i].cond)
    assert.equal(en[i].handlers, de[i].handlers)
  }
})

test('splitDescLine separates conditions, text and handlers', () => {
  const r = splitDescLine('\t\t#|-1 "{0}% reduced Physical Damage" negate 1')
  assert.deepEqual(r, { cond: '#|-1', text: '{0}% reduced Physical Damage', handlers: 'negate 1' })
})

test('splitDescLine keeps quotes inside the text', () => {
  // Skill names are quoted inside German mod texts.
  const r = splitDescLine('\t\t# "unterstützt durch \'Verkettung\' Stufe {0}" x 1')
  assert.equal(r.text, "unterstützt durch 'Verkettung' Stufe {0}")
  assert.equal(r.handlers, 'x 1')
})

test('placeholders resolve their argument index, empty braces auto-number', () => {
  assert.deepEqual(placeholders('{0} and {1}').map(p => p.idx), [0, 1])
  assert.deepEqual(placeholders('{} and {}').map(p => p.idx), [0, 1])
  assert.deepEqual(placeholders('{0:+d}').map(p => p.idx), [0])
})

test('a literal sign in front of a placeholder belongs to it', () => {
  // The biggest single error source while this was built: the game writes the
  // sign either as a format or literally, and APT's matcher strings carry
  // NEITHER — the `#` swallows it in both spellings.
  assert.equal(render('{0:+d} to Fire Resistance'), '# to Fire Resistance')
  assert.equal(render('+{0} to Maximum Life per Red Socket'), '# to Maximum Life per Red Socket')
  assert.equal(render('-{0} to Level of all {1} Gems'), '# to Level of all # Gems')
  assert.equal(placeholders('+{0}')[0].sign, '+')
})

test('render turns \\n into a real break and picks the right bracket side', () => {
  assert.equal(render('a\\nb'), 'a\nb')
  assert.equal(render('[CrabTotem|Crab Totem]'), 'Crab Totem')
  assert.equal(render('[Word]'), 'Word')
  assert.equal(render('[a|b]', { brackets: 'left' }), 'a')
})

test('matchKey flattens whitespace, render does not', () => {
  assert.equal(render('a\\nb'), 'a\nb')
  assert.equal(matchKey('a\\nb'), 'a b')
  assert.equal(matchKey('  a   b '), 'a b')
})

test('render and matchKey pass null through', () => {
  assert.equal(render(null), null)
  assert.equal(matchKey(null), null)
})

test('grammar markup expands into every distinct surface form', () => {
  const s = '<if:MS>{Rüstiger}<elif:FS>{Rüstige}<elif:NS>{Rüstiges}<elif:MP>{Rüstige}'
  assert.deepEqual(grammarForms(s), ['Rüstiger', 'Rüstige', 'Rüstiges'])
})

test('grammarPlain prefers the else branch, otherwise the first', () => {
  assert.equal(grammarPlain('<if:gen>{Академии}<else>{Академия}'), 'Академия')
  assert.equal(grammarPlain('<if:MS>{Rüstiger}<elif:FS>{Rüstige}'), 'Rüstiger')
})

test('grammar markup keeps the text around it and the double-brace form', () => {
  const s = '<if:MS>{{Synthetisierter}}<elif:NS>{{Synthetisiertes}} {0}'
  assert.deepEqual(grammarForms(s), ['Synthetisierter {0}', 'Synthetisiertes {0}'])
  assert.equal(grammarPlain('Prefix <if:M>{ihn}<else>{sie} suffix'), 'Prefix sie suffix')
})

test('text without markup is returned unchanged', () => {
  assert.deepEqual(grammarForms('Kopfjäger'), ['Kopfjäger'])
  assert.equal(grammarPlain('Kopfjäger'), 'Kopfjäger')
})
