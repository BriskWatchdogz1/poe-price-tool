// renderer/public/data/de/client_strings.js is hand-written and stays that way:
// no generator touches the file, so nothing machine-made cross-checks it. This
// test is that cross-check.
//
// Two things are checked:
//   1. Shape against the English set — the same keys in the same order with the
//      same types. A missing key is `undefined` at runtime and only bites when
//      an item is parsed.
//   2. The two grammar regexes against real German client text (items copied
//      with Ctrl+Alt+C). A mistake there is not a silent gap but a crash:
//        - MODIFIER_LINE  -> throw 'Invalid regex for mod info line'
//                            (renderer/src/parser/advanced-mod-desc.ts:52-54)
//        - MODIFIER_INCREASED -> TypeError on null[1] (same file, :102)
import { test } from 'node:test'
import assert from 'node:assert/strict'

const en = (await import('../../renderer/public/data/en/client_strings.js')).default
const de = (await import('../../renderer/public/data/de/client_strings.js')).default

const kind = (v) => (v instanceof RegExp ? 'RegExp' : Array.isArray(v) ? 'Array' : typeof v)

test('de carries the same keys as en, in the same order', () => {
  assert.deepEqual(Object.keys(de), Object.keys(en))
  assert.equal(Object.keys(de).length, 130)
})

test('every key has the same type as in en', () => {
  for (const key of Object.keys(en)) {
    assert.equal(kind(de[key]), kind(en[key]), `${key}: type differs`)
  }
})

test('no value was left empty', () => {
  for (const [key, value] of Object.entries(de)) {
    if (typeof value === 'string') assert.notEqual(value.trim(), '', `${key} is empty`)
    if (Array.isArray(value)) assert.ok(value.length > 0, `${key} is empty`)
  }
})

test('array keys cover at least as many forms as en', () => {
  // German needs more entries than English in places: mod names are
  // adjectives and the game data carries them in every gender/number form
  // ("Unheimlicher/Unheimliche/Unheimliches"). APT's Russian set shows the
  // same effect. Fewer entries than English, on the other hand, would be a
  // gap.
  for (const key of Object.keys(en)) {
    if (!Array.isArray(en[key])) continue
    assert.ok(de[key].length >= en[key].length, `${key}: ${de[key].length} < ${en[key].length}`)
    assert.equal(new Set(de[key]).size, de[key].length, `${key}: duplicate entries`)
  }
})

test('values the parser compares with switch/case do not collide', () => {
  // Parser.ts:940-947 tells the four blueprint targets apart by these strings
  // alone; two equal values swallow a branch. (APT's Korean set has exactly
  // this bug: GEMS == TRINKETS.)
  const blueprint = ['HEIST_BLUEPRINT_ENCHANTS', 'HEIST_BLUEPRINT_GEMS', 'HEIST_BLUEPRINT_REPLICAS', 'HEIST_BLUEPRINT_TRINKETS']
  assert.equal(new Set(blueprint.map(k => de[k])).size, blueprint.length)

  // advanced-mod-desc.ts:57-79 derives type and generation from the same field.
  const modTypes = ['IMPLICIT_MODIFIER', 'CORRUPTED_IMPLICIT', 'PREFIX_MODIFIER', 'SUFFIX_MODIFIER',
    'CRAFTED_PREFIX', 'CRAFTED_SUFFIX', 'FRACTURED_PREFIX', 'FRACTURED_SUFFIX', 'FOULBORN_MODIFIER']
  assert.equal(new Set(modTypes.map(k => de[k])).size, modTypes.length)

  // advanced-mod-desc.ts:42-47 checks the six eldritch ranks against each
  // other; a duplicate makes two ranks indistinguishable.
  const ranks = ['ELDRITCH_MOD_R1', 'ELDRITCH_MOD_R2', 'ELDRITCH_MOD_R3', 'ELDRITCH_MOD_R4', 'ELDRITCH_MOD_R5', 'ELDRITCH_MOD_R6']
  assert.equal(new Set(ranks.map(k => de[k])).size, ranks.length)

  // A mod name must not signal two influence kinds at once
  // (create-stat-filters.ts:253-271 takes the first match).
  const influence = ['SHAPER_MODS', 'ELDER_MODS', 'CRUSADER_MODS', 'HUNTER_MODS', 'REDEEMER_MODS',
    'WARLORD_MODS', 'DELVE_MODS', 'VEILED_MODS', 'INCURSION_MODS', 'ESSENCE_MODS', 'INFAMOUS_MODS']
  const seen = new Map()
  for (const key of influence) {
    for (const form of de[key]) {
      assert.equal(seen.get(form), undefined, `"${form}" is in ${seen.get(form)} and ${key}`)
      seen.set(form, key)
    }
  }
})

// --- Grammar against real client text ----------------------------------------

// This is how advanced-mod-desc.ts:25-27 splits a modifier line.
const modParts = (line) => line.slice(1, -1).split('—').map(s => s.trim())

test('MODIFIER_LINE matches the German bracket form "(Level: n)"', () => {
  const [modText] = modParts('{ Präfix-Modifikator "Siedender" (Level: 1) — Defensiven, Energieschild }')
  const match = modText.match(de.MODIFIER_LINE)
  assert.ok(match, 'no match — advanced-mod-desc.ts:52 would throw')
  assert.equal(match.groups.type, de.PREFIX_MODIFIER)
  assert.equal(match.groups.name, 'Siedender')
  assert.equal(match.groups.tier, '1')

  // Counter-check: with the English regex this very line runs into the throw.
  assert.equal(modText.match(en.MODIFIER_LINE), null)
})

test('MODIFIER_LINE matches the suffix case too', () => {
  const [modText] = modParts('{ Suffix-Modifikator "des Ephij" (Level: 1) — Elementar, Blitz, Widerstand }')
  const match = modText.match(de.MODIFIER_LINE)
  assert.ok(match)
  assert.equal(match.groups.type, de.SUFFIX_MODIFIER)
  assert.equal(match.groups.name, 'des Ephij')
})

test('MODIFIER_LINE matches the nameless implicit line', () => {
  const [modText] = modParts('{ Impliziter Modifikator — Defensiven, Rüstung, Ausweichen }')
  const match = modText.match(de.MODIFIER_LINE)
  assert.ok(match)
  assert.equal(match.groups.type, de.IMPLICIT_MODIFIER)
  assert.equal(match.groups.name, undefined)
})

test('MODIFIER_INCREASED reads the roll value from "20% erhöht"', () => {
  const [, , incrText] = modParts('{ Einzigartiger Modifikator — Leben — 20% erhöht }')
  assert.equal(incrText, '20% erhöht')
  const match = de.MODIFIER_INCREASED.exec(incrText)
  assert.ok(match, 'no match — advanced-mod-desc.ts:102 would run into null[1]')
  assert.equal(Number(match[1]), 20)

  // Counter-check: the English regex does not match here.
  assert.equal(en.MODIFIER_INCREASED.exec(incrText), null)
})

test('EATER_IMPLICIT and EXARCH_IMPLICIT resolve the rank', () => {
  const [eater] = modParts('{ Impliziter Modifikator des Weltenfressers (Kleine(r)) }')
  assert.equal(eater.match(de.EATER_IMPLICIT).groups.rank, de.ELDRITCH_MOD_R1)

  const [exarch] = modParts('{ Impliziter Modifikator des Brennenden Exarchen (Große(r)) }')
  assert.equal(exarch.match(de.EXARCH_IMPLICIT).groups.rank, de.ELDRITCH_MOD_R3)
})

test('the anchors stand exactly like this in front of the corpus lines', () => {
  // The game data does not ship the ": " separator — the client appends it,
  // and not the same way everywhere. These lines come from the real German
  // client, so they are the evidence for it.
  const corpus = {
    ITEM_CLASS: 'Gegenstandsklasse: Gürtel',
    RARITY: 'Seltenheit: Einzigartig',
    ITEM_LEVEL: 'Gegenstandsstufe: 87',
    QUALITY: 'Qualität: +20% (augmented)',
    ENERGY_SHIELD: 'Energieschild: 350 (augmented)',
    SOCKETS: 'Fassungen: R-B W-G ',
    GEM_LEVEL: 'Stufe: 78'
  }
  for (const [key, line] of Object.entries(corpus)) {
    assert.ok(line.startsWith(de[key]), `${key}: ${JSON.stringify(de[key])} does not fit in front of ${JSON.stringify(line)}`)
  }

  assert.equal(de.RARITY_UNIQUE, 'Einzigartig')
  assert.equal(de.RARITY_RARE, 'Selten')
  assert.equal(de.INFLUENCE_SHAPER, 'Schöpfer-Gegenstand')
})
