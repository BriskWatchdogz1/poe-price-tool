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

test('de führt dieselben Schlüssel wie en, in derselben Reihenfolge', () => {
  assert.deepEqual(Object.keys(de), Object.keys(en))
  assert.equal(Object.keys(de).length, 130)
})

test('jeder Schlüssel hat denselben Typ wie in en', () => {
  for (const key of Object.keys(en)) {
    assert.equal(kind(de[key]), kind(en[key]), `${key}: Typ weicht ab`)
  }
})

test('kein Wert ist leer geblieben', () => {
  for (const [key, value] of Object.entries(de)) {
    if (typeof value === 'string') assert.notEqual(value.trim(), '', `${key} ist leer`)
    if (Array.isArray(value)) assert.ok(value.length > 0, `${key} ist leer`)
  }
})

test('Array-Schlüssel decken mindestens so viele Formen ab wie en', () => {
  // Deutsch braucht stellenweise mehr Einträge als Englisch: Mod-Namen sind
  // Adjektive und liegen in den Spieldaten mit allen Genus-/Numerusformen vor
  // ("Unheimlicher/Unheimliche/Unheimliches"). Derselbe Effekt ist im
  // russischen Satz von APT zu sehen. Weniger Einträge als Englisch wäre
  // dagegen eine Lücke.
  for (const key of Object.keys(en)) {
    if (!Array.isArray(en[key])) continue
    assert.ok(de[key].length >= en[key].length, `${key}: ${de[key].length} < ${en[key].length}`)
    assert.equal(new Set(de[key]).size, de[key].length, `${key}: doppelte Einträge`)
  }
})

test('Werte, auf die der Parser mit switch/case vergleicht, kollidieren nicht', () => {
  // Parser.ts:940-947 unterscheidet die vier Blueprint-Ziele allein über diese
  // Strings; zwei gleiche Werte verschlucken einen Zweig. (Der koreanische Satz
  // von APT hat genau diesen Fehler: GEMS == TRINKETS.)
  const blueprint = ['HEIST_BLUEPRINT_ENCHANTS', 'HEIST_BLUEPRINT_GEMS', 'HEIST_BLUEPRINT_REPLICAS', 'HEIST_BLUEPRINT_TRINKETS']
  assert.equal(new Set(blueprint.map(k => de[k])).size, blueprint.length)

  // advanced-mod-desc.ts:57-79 leitet Typ und Generation aus demselben Feld ab.
  const modTypes = ['IMPLICIT_MODIFIER', 'CORRUPTED_IMPLICIT', 'PREFIX_MODIFIER', 'SUFFIX_MODIFIER',
    'CRAFTED_PREFIX', 'CRAFTED_SUFFIX', 'FRACTURED_PREFIX', 'FRACTURED_SUFFIX', 'FOULBORN_MODIFIER']
  assert.equal(new Set(modTypes.map(k => de[k])).size, modTypes.length)

  // Die sechs Eldritch-Ränge werden in advanced-mod-desc.ts:42-47 gegeneinander
  // geprüft; ein Duplikat macht zwei Ränge ununterscheidbar.
  const ranks = ['ELDRITCH_MOD_R1', 'ELDRITCH_MOD_R2', 'ELDRITCH_MOD_R3', 'ELDRITCH_MOD_R4', 'ELDRITCH_MOD_R5', 'ELDRITCH_MOD_R6']
  assert.equal(new Set(ranks.map(k => de[k])).size, ranks.length)

  // Mod-Namen dürfen nicht zwei Einflussarten zugleich anzeigen
  // (create-stat-filters.ts:253-271 nimmt den ersten Treffer).
  const influence = ['SHAPER_MODS', 'ELDER_MODS', 'CRUSADER_MODS', 'HUNTER_MODS', 'REDEEMER_MODS',
    'WARLORD_MODS', 'DELVE_MODS', 'VEILED_MODS', 'INCURSION_MODS', 'ESSENCE_MODS', 'INFAMOUS_MODS']
  const seen = new Map()
  for (const key of influence) {
    for (const form of de[key]) {
      assert.equal(seen.get(form), undefined, `"${form}" steht in ${seen.get(form)} und ${key}`)
      seen.set(form, key)
    }
  }
})

// --- Grammatik an echtem Client-Text ----------------------------------------

// So zerlegt advanced-mod-desc.ts:25-27 eine Modifikator-Zeile.
const modParts = (line) => line.slice(1, -1).split('—').map(s => s.trim())

test('MODIFIER_LINE trifft die deutsche Klammerform "(Level: n)"', () => {
  const [modText] = modParts('{ Präfix-Modifikator "Siedender" (Level: 1) — Defensiven, Energieschild }')
  const match = modText.match(de.MODIFIER_LINE)
  assert.ok(match, 'kein Treffer — advanced-mod-desc.ts:52 würde werfen')
  assert.equal(match.groups.type, de.PREFIX_MODIFIER)
  assert.equal(match.groups.name, 'Siedender')
  assert.equal(match.groups.tier, '1')

  // Gegenprobe: mit dem englischen Regex läuft genau diese Zeile in den throw.
  assert.equal(modText.match(en.MODIFIER_LINE), null)
})

test('MODIFIER_LINE trifft auch den Suffix-Fall', () => {
  const [modText] = modParts('{ Suffix-Modifikator "des Ephij" (Level: 1) — Elementar, Blitz, Widerstand }')
  const match = modText.match(de.MODIFIER_LINE)
  assert.ok(match)
  assert.equal(match.groups.type, de.SUFFIX_MODIFIER)
  assert.equal(match.groups.name, 'des Ephij')
})

test('MODIFIER_LINE trifft die namenlose implizite Zeile', () => {
  const [modText] = modParts('{ Impliziter Modifikator — Defensiven, Rüstung, Ausweichen }')
  const match = modText.match(de.MODIFIER_LINE)
  assert.ok(match)
  assert.equal(match.groups.type, de.IMPLICIT_MODIFIER)
  assert.equal(match.groups.name, undefined)
})

test('MODIFIER_INCREASED liest den Rollwert aus "20% erhöht"', () => {
  const [, , incrText] = modParts('{ Einzigartiger Modifikator — Leben — 20% erhöht }')
  assert.equal(incrText, '20% erhöht')
  const match = de.MODIFIER_INCREASED.exec(incrText)
  assert.ok(match, 'kein Treffer — advanced-mod-desc.ts:102 liefe in null[1]')
  assert.equal(Number(match[1]), 20)

  // Gegenprobe: der englische Regex greift hier nicht.
  assert.equal(en.MODIFIER_INCREASED.exec(incrText), null)
})

test('EATER_IMPLICIT und EXARCH_IMPLICIT lösen den Rang auf', () => {
  const [eater] = modParts('{ Impliziter Modifikator des Weltenfressers (Kleine(r)) }')
  assert.equal(eater.match(de.EATER_IMPLICIT).groups.rank, de.ELDRITCH_MOD_R1)

  const [exarch] = modParts('{ Impliziter Modifikator des Brennenden Exarchen (Große(r)) }')
  assert.equal(exarch.match(de.EXARCH_IMPLICIT).groups.rank, de.ELDRITCH_MOD_R3)
})

test('die Anker stehen genau so vor den Korpuszeilen', () => {
  // Das Trennzeichen ": " liefern die Spieldaten nicht mit — der Client hängt es
  // an, und nicht überall gleich. Diese Zeilen stammen aus dem echten
  // deutschen Client, sind also der Beleg dafür.
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
    assert.ok(line.startsWith(de[key]), `${key}: ${JSON.stringify(de[key])} passt nicht vor ${JSON.stringify(line)}`)
  }

  assert.equal(de.RARITY_UNIQUE, 'Einzigartig')
  assert.equal(de.RARITY_RARE, 'Selten')
  assert.equal(de.INFLUENCE_SHAPER, 'Schöpfer-Gegenstand')
})
