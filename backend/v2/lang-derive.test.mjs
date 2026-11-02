// lang-derive.mjs — the derivation of a localized data set from the English
// one plus the game data.
//
// Fixtures only: a handful of description blocks and a few table rows, all
// inline. The real run needs 51 MB of game data and a download; this must not.
// What is pinned here is the behaviour that decides whether the generated set
// is safe to ship — flag inheritance, ambiguity rejection, and the rules that
// keep the target matcher list derivable from the English one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStatDescriptions } from './lang-statdesc.mjs'
import {
  createResolver, deriveStats, deriveItems, buildTextPairs, validate,
  nameMap, listEnds, buildTemplates, buildFrames, isPseudoMatcher,
  REQUIRED_TABLES, ITEM_NAME_SOURCES, NAME_SOURCES, WHOLE_NAME_TABLES
} from './lang-derive.mjs'

// --------------------------------------------------------------- fixtures

const DESC = [
  // a plain increased/reduced pair
  'description',
  '\t1 physical_damage_+%',
  '\t2',
  '\t\t1|# "{0}% increased Physical Damage"',
  '\t\t#|-1 "{0}% reduced Physical Damage" negate 1',
  '\tlang "German"',
  '\t2',
  '\t\t1|# "{0}% erhöhter physischer Schaden"',
  '\t\t#|-1 "{0}% verringerter physischer Schaden" negate 1',
  // a name slot, filled from PassiveSkills
  'description',
  '\t1 mod_granted_passive_hash',
  '\t1',
  '\t\t# "Allocates {0}" passive_hash 1',
  '\tlang "German"',
  '\t1',
  '\t\t# "Weist zu: {0}" passive_hash 1',
  // a name slot with an indexable list -> this is where `advanced` comes from
  'description',
  '\t2 random_skill_gem_level_+_level random_skill_gem_level_+_index',
  '\t1',
  '\t\t1|#  # "+{0} to Level of all {1} Gems" display_indexable_skill 2',
  '\tlang "German"',
  '\t1',
  '\t\t1|#  # "+{0} zur Stufe aller {1}-Gemmen" display_indexable_skill 2',
  // the same English text with two different German forms in two blocks:
  // genuine ambiguity, and the dangerous kind — the second one inverts it
  'description',
  '\t1 cast_speed_zealotry_a',
  '\t1',
  '\t\t# "{0}% increased Cast Speed while affected by Zealotry"',
  '\tlang "German"',
  '\t1',
  '\t\t# "{0}% erhöhte Zaubergeschwindigkeit unter Glaubenseifer"',
  'description',
  '\t1 cast_speed_zealotry_b',
  '\t1',
  '\t\t# "{0}% increased Cast Speed while affected by Zealotry"',
  '\tlang "German"',
  '\t1',
  '\t\t# "{0}% verringerte Zaubergeschwindigkeit unter Glaubenseifer"',
  // singular / plural, which German collapses into one form
  'description',
  '\t1 tormented_spirits',
  '\t2',
  '\t\t1 "Area is haunted by {0} additional Tormented Spirit"',
  '\t\t# "Area is haunted by {0} additional Tormented Spirits"',
  '\tlang "German"',
  '\t2',
  '\t\t1 "Gebiet wird von # zusätzlichen gequälten Geistern heimgesucht"',
  '\t\t# "Gebiet wird von # zusätzlichen gequälten Geistern heimgesucht"',
  ''
].join('\n')

const blocks = parseStatDescriptions(DESC)

const rows = (col, pairs) => ({
  en: pairs.map(([a]) => ({ [col]: a })),
  tg: pairs.map(([, b]) => ({ [col]: b }))
})

const TABLES = {
  PassiveSkills: rows('Name', [['Acrimony', 'Verbitterung'], ['Acuity', 'Scharfsinn']]),
  IndexableSkillGems: {
    en: [{ Name1: 'Fireball', Name2: 'Fireball' }, { Name1: 'Arc', Name2: 'Arc' }, { Name1: 'Mana-Infused Staff', Name2: 'Mana-Infused Staff' }],
    tg: [{ Name1: 'Feuerball', Name2: 'Feuerball' }, { Name1: 'Lichtbogen', Name2: 'Lichtbogen' }, { Name1: 'Manastab', Name2: 'Manastab' }]
  },
  IndexableSupportGems: rows('Name', [['Added Fire Damage', 'Zusätzlicher Feuerschaden']]),
  // Two rows, and the second one is deliberately a name NO other table carries:
  // it is what tells this table apart from IndexableSupportGems next to it,
  // which was the only one of the gem family byName() could see before B23.
  IndexableNonActiveSupportGems: rows('Name', [
    ['Added Fire Damage', 'Zusätzlicher Feuerschaden'],
    ['Ailment Damage', 'Zustandsschaden']
  ]),
  AfflictionRewardTypeVisuals: rows('Name', [['Currency', 'Währung']]),
  ItemClasses: rows('Name', [['Ring', 'Ring']]),
  BaseItemTypes: rows('Name', [['Chaos Orb', 'Chaossphäre'], ['Vanguard Belt', 'Vorhut-Gürtel']]),
  // `Arc` is in IndexableSkillGems as well and must not turn into a split;
  // `Bear Trap` is in no other table; `Ball Lightning of Static` is a
  // transfigured variant, which is the half only this table carries.
  ActiveSkills: {
    en: [{ DisplayedName: 'Arc' }, { DisplayedName: 'Bear Trap' }, { DisplayedName: 'Ball Lightning of Static' }],
    tg: [{ DisplayedName: 'Lichtbogen' }, { DisplayedName: 'Bärenfalle' }, { DisplayedName: 'Kugelblitz des Statischen' }]
  },
  Mods: rows('Name', [["Catarina's Veiled", '<if:MS>{Catarinas verhüllter}<elif:FS>{Catarinas verhüllte}']]),
  IncursionRooms: rows('Name', [['Antechamber', 'Vestibül'], ['Vault', 'Tresor']]),
  ExpeditionFactions: rows('Name', [['Knights of the Sun', 'Ritter der Sonne']]),
  LakeRooms: rows('Name', [['Reflection of Abyss', 'Spiegelung des Abgrunds']]),
  MonsterVarieties: rows('Name', [['Farric Lynx', 'Farrischer Luchs']]),
  WorldAreas: rows('Name', [['Academy', 'Akademie']]),
  Words: { en: [{ Text: 'Headhunter', Text2: 'Headhunter' }], tg: [{ Text: 'Headhunter', Text2: 'Kopfjäger' }] },
  ClientStrings: {
    en: [
      { Id: 'InfluenceStatConditionPresenceCelestialBoss', Text: 'While a Pinnacle Atlas Boss is in your Presence, {0}' },
      { Id: 'StatDescripotionTreeExpansionJewelGrantedSmallStat', Text: 'Added Small Passive Skills grant: {0}' },
      { Id: 'IncursionRoomPopupTier', Text: '(Tier {0})' },
      { Id: 'ItemDisplayLakeRoomDifficulty', Text: 'Difficulty {0}' }
    ],
    tg: [
      { Id: 'InfluenceStatConditionPresenceCelestialBoss', Text: 'Während in der Präsenz eines Endgame-Atlasbosses: {0}' },
      { Id: 'StatDescripotionTreeExpansionJewelGrantedSmallStat', Text: 'Hinzugefügte kleine passive Fertigkeiten gewähren: {0}' },
      { Id: 'IncursionRoomPopupTier', Text: '(Level {0})' },
      { Id: 'ItemDisplayLakeRoomDifficulty', Text: 'Schwierigkeit {0}' }
    ]
  }
}

const resolver = () => createResolver({ blocks, targetLang: 'German', tables: TABLES })
const forms = s => resolver().resolve(s)?.forms

// ------------------------------------------------------------ name tables

test('nameMap joins the two exports by row index', () => {
  const m = nameMap(TABLES, 'PassiveSkills', ['Name'])
  assert.deepEqual([...m.get('Acrimony')], ['Verbitterung'])
})

test('nameMap expands grammar markup, item names take the citation form', () => {
  const expanded = nameMap(TABLES, 'Mods', ['Name'])
  assert.deepEqual([...expanded.get("Catarina's Veiled")].sort(), ['Catarinas verhüllte', 'Catarinas verhüllter'])
  const plain = nameMap(TABLES, 'Mods', ['Name'], ['Name'], { expand: false })
  assert.deepEqual([...plain.get("Catarina's Veiled")], ['Catarinas verhüllter'])
})

test('nameMap refuses a table the export did not deliver', () => {
  assert.throws(() => nameMap({}, 'PassiveSkills', ['Name']), /name table missing/)
})

test('listEnds gives the first and last entry of the first column', () => {
  const e = listEnds(TABLES, 'IndexableSkillGems', ['Name1', 'Name2'])
  assert.deepEqual(e.en, ['Fireball', 'Mana-Infused Staff'])
  assert.deepEqual(e.tg, ['Feuerball', 'Manastab'])
})

test('every table the derivation asks for is in REQUIRED_TABLES', () => {
  for (const sources of Object.values(ITEM_NAME_SOURCES)) {
    for (const s of sources) assert.ok(REQUIRED_TABLES.includes(s.table), `${s.table} missing`)
  }
  for (const t of REQUIRED_TABLES) assert.ok(TABLES[t], `fixture lacks ${t}`)
})

// ------------------------------------------------------------- resolution

test('a plain description line resolves to the German line at the same index', () => {
  assert.deepEqual(forms('#% increased Physical Damage'), ['#% erhöhter physischer Schaden'])
  assert.deepEqual(forms('#% reduced Physical Damage'), ['#% verringerter physischer Schaden'])
})

test('a name slot is translated through the handler\'s own table', () => {
  assert.deepEqual(forms('Allocates Acrimony'), ['Weist zu: Verbitterung'])
  assert.deepEqual(forms('# to Level of all Arc Gems'), ['# zur Stufe aller Lichtbogen-Gemmen'])
})

test('an unknown name produces nothing rather than a half-translated line', () => {
  assert.equal(resolver().resolve('Allocates Nonexistent Notable'), null)
})

test('advanced carries the list ends and they are translated too', () => {
  assert.deepEqual(
    forms('# to Level of all Arc(Fireball-Mana-Infused Staff) Gems'),
    ['# zur Stufe aller Lichtbogen(Feuerball-Manastab)-Gemmen']
  )
})

test('a bare name from a name table resolves, with every declension form', () => {
  assert.deepEqual(forms('Antechamber'), ['Vestibül'])
  assert.deepEqual(forms("Catarina's Veiled"), ['Catarinas verhüllte', 'Catarinas verhüllter'])
})

// --- B23, second half: a matcher that is nothing but a skill or gem name -----

test('a matcher that is nothing but a skill or gem name resolves', () => {
  // The 487 unresolved matchers of 2026-08-18 were these. Every one of the
  // tables below was already being exported on every run; byName() was simply
  // never offered them, so a stat whose whole matcher is `Arc` produced nothing
  // while `Added Fire Damage` two tables over produced a German string.
  assert.deepEqual(forms('Arc'), ['Lichtbogen'])
  assert.deepEqual(forms('Bear Trap'), ['Bärenfalle'])
  assert.deepEqual(forms('Ball Lightning of Static'), ['Kugelblitz des Statischen'])
  assert.deepEqual(forms('Ailment Damage'), ['Zustandsschaden'])
  assert.deepEqual(forms('Added Fire Damage'), ['Zusätzlicher Feuerschaden'])
})

test('a name two gem tables agree on stays ONE form, not a split', () => {
  // `Arc` is in ActiveSkills and in IndexableSkillGems. byName() unions the
  // tables, so agreeing tables must collapse to one matcher — otherwise every
  // skill gem would arrive twice and `longer` would climb for nothing.
  const r = resolver().resolve('Arc')
  assert.equal(r.how, 'name:ActiveSkills+IndexableSkillGems', 'both tables answered')
  assert.equal(r.forms.length, 1)
})

test('the gem tables cost no new export — REQUIRED_TABLES is unchanged by them', () => {
  // The whole point of the fix: the names were already on disk. Every table in
  // WHOLE_NAME_TABLES has to be reachable through NAME_SOURCES or
  // ITEM_NAME_SOURCES too, or the download would have grown.
  const alreadyFetched = new Set([
    ...Object.values(NAME_SOURCES).map(s => s.table),
    ...Object.values(ITEM_NAME_SOURCES).flat().map(s => s.table)
  ])
  for (const { table } of WHOLE_NAME_TABLES) {
    if (table === 'Mods' || table === 'IncursionRooms' || table === 'ExpeditionFactions' || table === 'LakeRooms') continue
    assert.ok(alreadyFetched.has(table), `${table} would be a NEW table to export`)
  }
  assert.equal(REQUIRED_TABLES.length, 16)
})

test('BaseItemTypes stays out of the whole-name tables on purpose', () => {
  // It carries gem base names AND ~14 000 ordinary item bases, into a lookup
  // tried for every matcher that is not a description line. What it would add
  // over ActiveSkills is the support gem FULL names, which is not what the
  // observed matchers are — a real risk for no measured gain.
  assert.ok(!WHOLE_NAME_TABLES.some(t => t.table === 'BaseItemTypes'))
  assert.equal(forms('Chaos Orb'), undefined, 'an item base name is not a matcher')
})

test('a description line still wins over a name that reads like one', () => {
  // byName() is only consulted after byLine() and byTemplate() have failed.
  // Widening it must not let a name table answer for a text the game data
  // already translates as a line — that is the one way this change could take
  // something away instead of adding to it.
  assert.deepEqual(forms('#% increased Physical Damage'), ['#% erhöhter physischer Schaden'])
  assert.deepEqual(forms('Antechamber'), ['Vestibül'], 'and the older name tables still answer')
})

test('a ClientStrings frame wraps a resolvable inner text', () => {
  assert.deepEqual(
    forms('While a Pinnacle Atlas Boss is in your Presence, #% increased Physical Damage'),
    ['Während in der Präsenz eines Endgame-Atlasbosses: #% erhöhter physischer Schaden']
  )
})

test('a concrete number where the line has a placeholder is put back', () => {
  assert.deepEqual(
    forms('Added Small Passive Skills grant: 12% increased Physical Damage'),
    ['Hinzugefügte kleine passive Fertigkeiten gewähren: 12% erhöhter physischer Schaden']
  )
})

test('numbers are only re-inserted when they are all the same', () => {
  // Different numbers could be swapped by the target word order, and a swap
  // would be silent. Equal numbers cannot.
  const r = resolver()
  assert.equal(r.resolve('Added Small Passive Skills grant: 12% increased Physical Damage and 30'), null)
})

test('a prefix frame repeated per line is stripped from all of them', () => {
  assert.deepEqual(
    forms('Added Small Passive Skills grant: 12% increased Physical Damage\nAdded Small Passive Skills grant: 12% reduced Physical Damage'),
    ['Hinzugefügte kleine passive Fertigkeiten gewähren: 12% erhöhter physischer Schaden\n' +
     'Hinzugefügte kleine passive Fertigkeiten gewähren: 12% verringerter physischer Schaden']
  )
})

test('"<name> (<value>)" works with the bracket inside and outside the frame', () => {
  // IncursionRoomPopupTier carries the brackets itself, ItemDisplayLakeRoom-
  // Difficulty does not and APT adds them.
  assert.deepEqual(forms('Vault (Tier 1)'), ['Tresor (Level 1)'])
  assert.deepEqual(forms('Reflection of Abyss (Difficulty #)'), ['Spiegelung des Abgrunds (Schwierigkeit #)'])
})

test('two blocks with different German forms for one English line are rejected', () => {
  // The dangerous case, and it is real: one block says "erhöhte", the other
  // "verringerte". Picking either would flip the sign of the roll without
  // anything failing.
  const r = resolver().resolve('#% increased Cast Speed while affected by Zealotry')
  assert.equal(r.ambiguous, true)
  assert.deepEqual(r.forms, [])
})

// ------------------------------------------------------------------ stats

const statLine = (ref, matchers, extra = {}) => ({ ref, better: 1, matchers, trade: { ids: {} }, ...extra })
const pseudo = new Map([['# Crafted Modifiers ', '# Meisteranfertigungs-Modifikatoren ']])
const derive = lines => deriveStats(lines, resolver().resolve, pseudo)

test('flags are inherited verbatim from the English matcher', () => {
  const en = [statLine('#% increased Physical Damage', [
    { string: '#% increased Physical Damage' },
    { string: '#% reduced Physical Damage', negate: true },
    { string: 'No Physical Damage', value: -100 }
  ])]
  const { lines } = derive(en)
  const m = lines[0].matchers
  assert.equal(m[0].negate, undefined)
  assert.equal(m[1].negate, true)
  assert.equal(m[1].string, '#% verringerter physischer Schaden')
  // "No Physical Damage" is in no fixture block -> no matcher, but the two
  // that did resolve keep their flags.
  assert.equal(m.length, 2)
})

test('everything except the matcher strings is copied through', () => {
  const en = [statLine('#% increased Physical Damage', [{ string: '#% increased Physical Damage' }], {
    dp: true, trade: { ids: { explicit: ['explicit.stat_1'] }, option: true }, fromAreaMods: true
  })]
  const { lines } = derive(en)
  assert.deepEqual(lines[0].trade, { ids: { explicit: ['explicit.stat_1'] }, option: true })
  assert.equal(lines[0].dp, true)
  assert.equal(lines[0].fromAreaMods, true)
  assert.equal(lines[0].ref, '#% increased Physical Damage')
})

test('the English grouping is preserved', () => {
  const en = [{ resolve: { strat: 'trivial-merge' }, stats: [statLine('#% increased Physical Damage', [{ string: '#% increased Physical Damage' }])] }]
  const { lines } = derive(en)
  assert.deepEqual(lines[0].resolve, { strat: 'trivial-merge' })
  assert.equal(lines[0].stats.length, 1)
})

test('a declension split makes one matcher per form, all with the same flags', () => {
  const en = [statLine("Catarina's Veiled", [{ string: "Catarina's Veiled", negate: true }])]
  const { lines, report } = derive(en)
  assert.equal(lines[0].matchers.length, 2)
  assert.ok(lines[0].matchers.every(m => m.negate === true))
  assert.equal(report.split, 1)
})

test('singular and plural collapsing into one form yield one matcher', () => {
  const en = [statLine('Area is haunted by # additional Tormented Spirits', [
    { string: 'Area is haunted by # additional Tormented Spirit' },
    { string: 'Area is haunted by # additional Tormented Spirits' }
  ])]
  const { lines, report } = derive(en)
  assert.equal(lines[0].matchers.length, 1)
  assert.equal(report.collapsed.length, 1)
  assert.equal(report.collapseConflicts.length, 0)
})

test('a collapse with different flags produces NO matcher', () => {
  // Which of the two would win is chance, and the loser's flags are wrong.
  const en = [statLine('Area is haunted by # additional Tormented Spirits', [
    { string: 'Area is haunted by # additional Tormented Spirit', value: 1 },
    { string: 'Area is haunted by # additional Tormented Spirits' }
  ])]
  const { lines, report } = derive(en)
  assert.equal(lines[0].matchers.length, 0)
  assert.equal(report.collapseConflicts.length, 1)
})

test('pseudo matchers come from the hand table and are reported when missing', () => {
  const en = [
    statLine('# Crafted Modifiers', [{ string: '# Crafted Modifiers ' }]),
    statLine('# Empty Modifiers', [{ string: '# Empty Modifiers ' }])
  ]
  const { lines, report } = derive(en)
  assert.deepEqual(lines[0].matchers, [{ string: '# Meisteranfertigungs-Modifikatoren ' }])
  assert.deepEqual(lines[1].matchers, [])
  assert.deepEqual(report.pseudoMisses, ['# Empty Modifiers '])
  assert.equal(report.pseudo, 2)
})

test('the trailing space of a pseudo matcher is what identifies it', () => {
  assert.equal(isPseudoMatcher({ string: '# Crafted Modifiers ' }), true)
  assert.equal(isPseudoMatcher({ string: '# Crafted Modifiers' }), false)
})

test('an unresolved matcher is listed, not silently dropped', () => {
  const en = [statLine('Something Nobody Translated', [{ string: 'Something Nobody Translated' }])]
  const { lines, report } = derive(en)
  assert.equal(lines[0].matchers.length, 0)
  assert.deepEqual(report.misses.map(m => m.string), ['Something Nobody Translated'])
})

test('advanced is derived through the same path and dropped if it fails', () => {
  const en = [statLine('# to Level of all Arc Gems', [{
    string: '# to Level of all Arc Gems',
    advanced: '# to Level of all Arc(Fireball-Mana-Infused Staff) Gems'
  }])]
  const { lines } = derive(en)
  assert.equal(lines[0].matchers[0].advanced, '# zur Stufe aller Lichtbogen(Feuerball-Manastab)-Gemmen')

  const bad = [statLine('# to Level of all Arc Gems', [{
    string: '# to Level of all Arc Gems', advanced: 'not derivable from anything'
  }])]
  const out = derive(bad)
  assert.equal('advanced' in out.lines[0].matchers[0], false)
  assert.equal(out.report.advancedMissing.length, 1)
})

// ------------------------------------------------------------------ items

test('only `name` changes; refName, namespace and unique.base stay English', () => {
  const en = [
    { name: 'Headhunter', refName: 'Headhunter', namespace: 'UNIQUE', unique: { base: 'Leather Belt' }, icon: 'x' },
    { name: 'Chaos Orb', refName: 'Chaos Orb', namespace: 'ITEM', tradeTag: 'chaos-orb' },
    { name: 'Arc', refName: 'Arc', namespace: 'GEM', gem: { normalVariant: 'Arc' } },
    { name: 'Academy', refName: 'Academy', namespace: 'AREA' },
    { name: 'Farric Lynx', refName: 'Farric Lynx', namespace: 'CAPTURED_BEAST' }
  ]
  const { lines, report } = deriveItems(en, TABLES)
  assert.deepEqual(lines.map(l => l.name), ['Kopfjäger', 'Chaossphäre', 'Lichtbogen', 'Akademie', 'Farrischer Luchs'])
  assert.deepEqual(lines.map(l => l.refName), en.map(l => l.refName))
  assert.deepEqual(lines[0].unique, { base: 'Leather Belt' })
  assert.equal(lines[1].tradeTag, 'chaos-orb')
  assert.deepEqual(lines[2].gem, { normalVariant: 'Arc' })
  assert.equal(report.translated, 5)
})

test('a name with no source keeps the English one and is listed', () => {
  const { lines, report } = deriveItems([{ name: 'Blighted Map', refName: 'Blighted Map', namespace: 'ITEM' }], TABLES)
  assert.equal(lines[0].name, 'Blighted Map')
  assert.deepEqual(report.kept, ['ITEM::Blighted Map'])
  assert.deepEqual(report.unknownNamespaces, [], 'a KNOWN namespace whose row is missing is not an unknown namespace')
})

test('a namespace with no name source at all is reported, not just kept English', () => {
  // The quietest gap in the set: upstream adds a namespace ITEM_NAME_SOURCES has
  // no entry for, every line of it stays English, and nothing else in the tool
  // moves — the lines exist, the refs match, the skew view sees no difference
  // and the coverage checks are about stats (docs/bugs.md B24).
  const en = [
    { name: 'Chaos Orb', refName: 'Chaos Orb', namespace: 'ITEM' },
    { name: 'Whatever Charm', refName: 'Whatever Charm', namespace: 'CHARM' },
    { name: 'Second Charm', refName: 'Second Charm', namespace: 'CHARM' },
    { name: 'A Tincture', refName: 'A Tincture', namespace: 'TINCTURE' }
  ]
  const { lines, report } = deriveItems(en, TABLES)
  assert.equal(lines[1].name, 'Whatever Charm', 'the run is not thrown away over it — an English name is not a wrong price')
  assert.deepEqual(report.unknownNamespaces, [
    { namespace: 'CHARM', lines: 2 },
    { namespace: 'TINCTURE', lines: 1 }
  ], 'namespaces, counted, most affected first')
  assert.equal(report.translated, 1)
})

// -------------------------------------------------------------- text pairs

test('the de->en pair table covers every target line, not just the used ones', () => {
  const pairs = buildTextPairs(blocks, 'German')
  assert.deepEqual([...pairs.get('#% erhöhter physischer Schaden')], ['#% increased Physical Damage'])
  // Both Zealotry blocks contribute, and the ambiguity is kept visible rather
  // than resolved — the caller rejects it.
  assert.deepEqual([...pairs.get('#% erhöhte Zaubergeschwindigkeit unter Glaubenseifer')],
    ['#% increased Cast Speed while affected by Zealotry'])
  // Singular and plural map the same German line onto two English texts.
  assert.equal(pairs.get('Gebiet wird von # zusätzlichen gequälten Geistern heimgesucht').size, 2)
})

// -------------------------------------------------------------- validation

const okItems = [{ name: 'Chaos Orb', refName: 'Chaos Orb', namespace: 'ITEM' }]
const okItemsDe = [{ name: 'Chaossphäre', refName: 'Chaos Orb', namespace: 'ITEM' }]

test('a clean run validates without errors', () => {
  const en = [statLine('a', [{ string: '#% increased Physical Damage' }])]
  const de = [statLine('a', [{ string: '#% erhöhter physischer Schaden' }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe })
  assert.deepEqual(r.errors, [])
  assert.equal(r.counts.uncovered, 0)
})

test('a target ref that is not in the English set is an error', () => {
  const en = [statLine('a', [{ string: 'x' }])]
  const de = [statLine('b', [{ string: 'y' }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe })
  assert.ok(r.errors.some(e => /target ref not in the English set/.test(e)))
})

test('refs without a matcher are counted and listed in full', () => {
  const en = [statLine('a', [{ string: 'x' }]), statLine('b', [{ string: 'y' }])]
  const de = [statLine('a', [{ string: 'X' }]), statLine('b', [])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe })
  assert.equal(r.counts.uncovered, 1)
  assert.deepEqual(r.counts.uncoveredRefs, ['b'])
})

test('with no previous set the gap is measured against English, as it always was', () => {
  const en = [statLine('a', [{ string: 'x' }]), statLine('b', [{ string: 'y' }])]
  const de = [statLine('a', [{ string: 'X' }]), statLine('b', [])]
  const loose = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe, maxLossRatio: 1 })
  assert.deepEqual(loose.errors, [])
  const strict = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe, maxLossRatio: 0.1 })
  assert.ok(strict.errors.some(e => /coverage gap too large/.test(e)))
  // ...and there is no baseline to report, which is what tells the two branches
  // apart from the outside.
  assert.equal(strict.counts.baselineCovered, null)
})

// --- the B23 pair: the SAME gap is fatal or not, depending on what it costs --

test('a gap the previous set did not cover either is reported, not refused', () => {
  // English grew a stat the game data cannot supply a target text for. Keeping
  // the old set would not close that gap — it does not carry the ref at all —
  // so refusing the run buys nothing and costs the stat that DID resolve.
  const en = [statLine('a', [{ string: 'x' }]), statLine('new', [{ string: 'y' }])]
  const de = [statLine('a', [{ string: 'X' }]), statLine('new', [])]
  const previousStats = [statLine('a', [{ string: 'X' }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe, previousStats, maxLossRatio: 0.001 })
  assert.deepEqual(r.errors, [])
  assert.equal(r.counts.uncovered, 1)
  assert.equal(r.counts.baselineCovered, 1)
  assert.deepEqual(r.counts.regressedRefs, [])
  assert.deepEqual(r.counts.newGapRefs, ['new'])
  assert.ok(r.warnings.some(w => /not a regression/.test(w)))
})

test('a ref the previous set covered and this one does not fails the run', () => {
  // Same size of gap, opposite meaning: this run would take a matcher AWAY from
  // a stat that has one today. That is the failure the bar exists for, and the
  // English set never enters the ratio.
  const en = [statLine('a', [{ string: 'x' }]), statLine('b', [{ string: 'y' }])]
  const de = [statLine('a', [{ string: 'X' }]), statLine('b', [])]
  const previousStats = [statLine('a', [{ string: 'X' }]), statLine('b', [{ string: 'Y' }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe, previousStats, maxLossRatio: 0.1 })
  assert.ok(r.errors.some(e => /coverage regressed: 1 of 2 refs/.test(e)))
  assert.deepEqual(r.counts.regressedRefs, ['b'])
  assert.deepEqual(r.counts.newGapRefs, [])
})

test('a regression under the bar is a warning, and the refs are still named', () => {
  const en = [statLine('a', [{ string: 'x' }]), statLine('b', [{ string: 'y' }])]
  const de = [statLine('a', [{ string: 'X' }]), statLine('b', [])]
  const previousStats = [statLine('a', [{ string: 'X' }]), statLine('b', [{ string: 'Y' }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe, previousStats, maxLossRatio: 1 })
  assert.deepEqual(r.errors, [])
  assert.ok(r.warnings.some(w => /have no matcher any more/.test(w)))
  assert.deepEqual(r.counts.regressedRefs, ['b'])
})

test('a ref upstream removed since does not shrink the baseline it is not in', () => {
  // The previous set covered `gone`, English no longer has it. Counting it
  // would make the denominator bigger than the population actually at risk and
  // quietly loosen the bar.
  const en = [statLine('a', [{ string: 'x' }])]
  const de = [statLine('a', [{ string: 'X' }])]
  const previousStats = [statLine('a', [{ string: 'X' }]), statLine('gone', [{ string: 'G' }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe, previousStats })
  assert.equal(r.counts.baselineCovered, 1)
  assert.deepEqual(r.errors, [])
})

test('zero loss allowed means not one covered ref may fall away', () => {
  const en = [statLine('a', [{ string: 'x' }]), statLine('b', [{ string: 'y' }])]
  const de = [statLine('a', [{ string: 'X' }]), statLine('b', [])]
  const previousStats = [statLine('a', [{ string: 'X' }]), statLine('b', [{ string: 'Y' }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe, previousStats, maxLossRatio: 0 })
  assert.ok(r.errors.some(e => /coverage regressed/.test(e)))
})

test('two target forms with the same string but different flags are an error', () => {
  const en = [statLine('a', [{ string: 'x' }])]
  const de = [statLine('a', [{ string: 'X' }, { string: 'X', negate: true }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe })
  assert.ok(r.errors.some(e => /same string and different flags/.test(e)))
})

test('a stat losing its advanced entirely is counted', () => {
  const en = [statLine('a', [{ string: 'x', advanced: 'x(a-b)' }])]
  const de = [statLine('a', [{ string: 'X' }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe })
  assert.equal(r.counts.advMissing, 1)
})

test('namespace counts and refName order are checked on the item side', () => {
  const r = validate({
    enStats: [],
    deStats: [],
    enItems: [{ refName: 'a', namespace: 'ITEM' }, { refName: 'b', namespace: 'UNIQUE' }],
    deItems: [{ refName: 'a', namespace: 'ITEM' }, { refName: 'b', namespace: 'ITEM' }]
  })
  assert.ok(r.errors.some(e => /namespace count differs, UNIQUE/.test(e)))

  const r2 = validate({
    enStats: [],
    deStats: [],
    enItems: [{ refName: 'a', namespace: 'ITEM' }],
    deItems: [{ refName: 'z', namespace: 'ITEM' }]
  })
  assert.ok(r2.errors.some(e => /refName diverged at item 0/.test(e)))
})

test('a shorter or longer matcher list is reported, not swallowed', () => {
  const en = [statLine('a', [{ string: 'x' }, { string: 'y' }])]
  const de = [statLine('a', [{ string: 'X' }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe })
  assert.equal(r.counts.shorter, 1)
  assert.equal(r.counts.longer, 0)
})

test('`shorter` says how much of itself is the coverage gap counted again', () => {
  // A stat with no matcher at all is necessarily shorter than its English
  // original, so the two numbers overlap by construction. Without the split
  // `shorter` reads like a second finding; with it, the remainder — shorter but
  // still covered — is the only part that says something new.
  const en = [
    statLine('gone', [{ string: 'x' }, { string: 'y' }]),
    statLine('partial', [{ string: 'p' }, { string: 'q' }])
  ]
  const de = [statLine('gone', []), statLine('partial', [{ string: 'P' }])]
  const r = validate({ enStats: en, deStats: de, enItems: okItems, deItems: okItemsDe, maxLossRatio: 1 })
  assert.equal(r.counts.shorter, 2)
  assert.equal(r.counts.shorterToZero, 1)
  assert.equal(r.counts.uncovered, 1)
})

// ----------------------------------------------------------- index builders

test('templates need literal context on both sides', () => {
  const degenerate = parseStatDescriptions([
    'description',
    '\t1 x',
    '\t1',
    '\t\t# "{0}" passive_hash 1',
    '\tlang "German"',
    '\t1',
    '\t\t# "{0}" passive_hash 1',
    ''
  ].join('\n'))
  // English side is nothing but the slot -> would match every string.
  assert.equal(buildTemplates(degenerate, 'German', TABLES).length, 0)

  const bareTarget = parseStatDescriptions([
    'description',
    '\t1 x',
    '\t1',
    '\t\t# "Allocates {0}" passive_hash 1',
    '\tlang "German"',
    '\t1',
    '\t\t# "{0}" passive_hash 1',
    ''
  ].join('\n'))
  // Target side is nothing but the slot -> a degenerate translation that would
  // compete with the real phrasing.
  assert.equal(buildTemplates(bareTarget, 'German', TABLES).length, 0)
})

test('identical templates from several blocks are deduplicated', () => {
  const twice = parseStatDescriptions([
    'description', '\t1 a', '\t1', '\t\t# "Allocates {0}" passive_hash 1',
    '\tlang "German"', '\t1', '\t\t# "Weist zu: {0}" passive_hash 1',
    'description', '\t1 b', '\t1', '\t\t# "Allocates {0}" passive_hash 1',
    '\tlang "German"', '\t1', '\t\t# "Weist zu: {0}" passive_hash 1',
    ''
  ].join('\n'))
  assert.equal(buildTemplates(twice, 'German', TABLES).length, 1)
})

test('frames come from client strings with exactly one placeholder', () => {
  const f = buildFrames(TABLES)
  assert.deepEqual(f.map(x => x.id).sort(), [
    'IncursionRoomPopupTier', 'InfluenceStatConditionPresenceCelestialBoss',
    'ItemDisplayLakeRoomDifficulty', 'StatDescripotionTreeExpansionJewelGrantedSmallStat'
  ])
  // Short frames are marked and only used where the capture is a bare value.
  assert.equal(f.find(x => x.id === 'IncursionRoomPopupTier').textual, false)
  assert.equal(f.find(x => x.id === 'ItemDisplayLakeRoomDifficulty').textual, true)
})
