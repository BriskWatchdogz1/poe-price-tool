import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHighlight, highlightInputs, shortestToken, HIGHLIGHT_MAX_DEFAULT } from './highlight.js'

// Real case from the fragment tab: the valuable scarabs should light up in the
// stash, the whole cheap rest should not.
const WANTED = ['Cartography Scarab of the Multitude', 'Titanic Scarab', 'Legion Scarab of Officers']
const UNWANTED = ['Bestiary Scarab', 'Anarchy Scarab', 'Beyond Scarab', 'Torment Scarab',
  'Essence Scarab of Stability', 'Legion Scarab of Treasures', 'Cartography Scarab of Escalation']

test('limit: the default is 250 (the stash search field), not 50', () => {
  assert.equal(HIGHLIGHT_MAX_DEFAULT, 250)
})

test('shortest token separates wanted from unwanted', () => {
  const tok = shortestToken('Titanic Scarab', UNWANTED)
  assert.ok(tok.length >= 2)
  assert.ok('titanic scarab'.includes(tok), 'token must come from the name itself')
  for (const other of UNWANTED) assert.ok(!other.toLowerCase().includes(tok), `${tok} wrongly matches ${other}`)
})

test('output is ONE quoted keyword with |-alternatives', () => {
  const r = buildHighlight(WANTED, UNWANTED)
  assert.match(r.text, /^"[^"]+"$/)
  assert.equal(r.text.split('|').length, 3)
  assert.deepEqual(r.used, WANTED)
  assert.deepEqual(r.dropped, [])
})

test('every generated token matches all wanted names and no unwanted one', () => {
  const r = buildHighlight(WANTED, UNWANTED)
  const re = new RegExp(r.text.slice(1, -1), 'i')
  for (const w of WANTED) assert.ok(re.test(w), `${w} should light up`)
  for (const u of UNWANTED) assert.ok(!re.test(u), `${u} must NOT light up`)
})

test('length cap: trailing entries drop out and are REPORTED', () => {
  const r = buildHighlight(WANTED, UNWANTED, { maxLen: 8 }) // "ab|cd" = 7
  assert.ok(r.length <= 8)
  assert.ok(r.used.length >= 1 && r.used.length < WANTED.length)
  assert.equal(r.used.length + r.dropped.length, WANTED.length, 'nothing disappears silently')
  assert.equal(r.used[0], WANTED[0], 'input order decides what stays in')
})

test('a token covering several wanted names is not handed out twice', () => {
  const r = buildHighlight(['Ritual Scarab of Wisps', 'Ritual Scarab of Corpses'], ['Bestiary Scarab'])
  assert.equal(r.tokens.length, 1, 'one "ritual" covers both')
  assert.deepEqual(r.used, ['Ritual Scarab of Wisps', 'Ritual Scarab of Corpses'])
})

test('an inseparable name (prefix of an unwanted one) is reported as such', () => {
  // "Beyond Scarab" is fully contained in "Beyond Scarab of Resurgence" — no
  // search string in the world separates the two.
  const r = buildHighlight(['Beyond Scarab'], ['Beyond Scarab of Resurgence'])
  assert.deepEqual(r.overmatching, ['Beyond Scarab'])
  assert.equal(r.text, '"beyond scarab"')
})

test('regex metacharacters never end up in a token', () => {
  const r = buildHighlight(["Rogue's Marker", 'Maven\'s Chisel of Scarabs'], ['Chaos Orb'])
  for (const t of r.tokens) assert.doesNotMatch(t, /[.*+?()[\]{}|^$\\"]/)
})

test('empty selection -> empty string, not a bare pair of quotes', () => {
  const r = buildHighlight([], ['Chaos Orb'])
  assert.equal(r.text, '')
  assert.equal(r.length, 0)
})

test('duplicates in the selection count once', () => {
  const r = buildHighlight(['Titanic Scarab', 'Titanic Scarab'], UNWANTED)
  assert.equal(r.tokens.length, 1)
  assert.equal(r.used.length, 1)
})

// ---------------------------------------------------------------------------
// Real case from the screenshot: 9 wanted items, checked against ALL item names
// in the game (not just against the own stash). The old exclusion set, built
// from owned items only, produced "mav|loi|tro|nsta|cres|abyss scarab|dis|
// sulphite scarab|nb" here and lit up ~14 instead of 9 slots in game.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'

const ALL_NAMES = (() => {
  const path = new URL('../../../renderer/public/data/en/items.ndjson', import.meta.url)
  const set = new Set()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const e = JSON.parse(line)
    if (e.name) set.add(e.name)
    if (e.refName) set.add(e.refName)
  }
  return [...set]
})()

const SCREENSHOT_WANTED = [
  "The Maven's Writ",
  'Divination Scarab of The Cloister',
  'Scarab of Monstrous Lineage',
  'Breach Scarab of Instability',
  'Crescent Splinter',
  'Abyss Scarab',
  'Ambush Scarab of Discernment',
  'Sulphite Scarab',
  'Betrayal Scarab of Unbreaking'
]

test('real case: items.ndjson knows all 9 wanted names', () => {
  const lower = new Set(ALL_NAMES.map(n => n.toLowerCase()))
  for (const w of SCREENSHOT_WANTED) assert.ok(lower.has(w.toLowerCase()), `${w} missing from items.ndjson`)
})

test('real case: no token matches a foreign scarab/fragment name', () => {
  const r = buildHighlight(SCREENSHOT_WANTED, ALL_NAMES)
  const wantedLower = new Set(SCREENSHOT_WANTED.map(n => n.toLowerCase()))
  const overLower = new Set(r.overmatching.map(n => n.toLowerCase()))
  const re = new RegExp(r.text.slice(1, -1), 'i')

  // 1) all 9 light up.
  for (const w of SCREENSHOT_WANTED) assert.ok(re.test(w), `${w} should light up`)
  assert.equal(r.used.length, SCREENSHOT_WANTED.length, `not all included: ${r.dropped.join(', ')}`)
  assert.equal(r.used.length + r.dropped.length, SCREENSHOT_WANTED.length)
  assert.ok(r.length <= HIGHLIGHT_MAX_DEFAULT, `${r.length} > ${HIGHLIGHT_MAX_DEFAULT}`)

  // 2) no foreign name lights up along with them — unless it is a superstring
  //    of a reported overmatching entry (then it is provably unavoidable).
  const bad = []
  for (const n of ALL_NAMES) {
    const low = n.toLowerCase()
    if (wantedLower.has(low)) continue
    if (!re.test(n)) continue
    if ([...overLower].some(o => low.includes(o))) continue
    bad.push(n)
  }
  assert.deepEqual(bad, [], `false hits: ${bad.slice(0, 20).join(' | ')}`)
})

test('real case: the old short tokens would have failed against the full name list', () => {
  // evidence for the root cause: against the own stash they looked clean.
  for (const tok of ['dis', 'nb', 'nsta', 'loi', 'tro', 'mav', 'cres']) {
    const hits = ALL_NAMES.filter(n => n.toLowerCase().includes(tok) &&
      !SCREENSHOT_WANTED.some(w => w.toLowerCase() === n.toLowerCase()))
    assert.ok(hits.length > 0, `${tok} supposedly matched nothing foreign`)
  }
})

test('exclusion set = full name list forces longer, more precise tokens', () => {
  const stashOnly = buildHighlight(['Ambush Scarab of Discernment'], ['Abyss Scarab', 'Sulphite Scarab'])
  const universe = buildHighlight(['Ambush Scarab of Discernment'], ALL_NAMES)
  assert.ok(universe.tokens[0].length > stashOnly.tokens[0].length,
    `${universe.tokens[0]} should be longer than ${stashOnly.tokens[0]}`)
})

test('the cap bites honestly when more precise tokens no longer fit', () => {
  const r = buildHighlight(SCREENSHOT_WANTED, ALL_NAMES, { maxLen: 40 })
  assert.ok(r.length <= 40)
  assert.ok(r.dropped.length > 0, 'at 40 characters something has to drop out')
  assert.equal(r.used.length + r.dropped.length, SCREENSHOT_WANTED.length, 'nothing disappears silently')
  const re = new RegExp(r.text.slice(1, -1), 'i')
  for (const w of r.used) assert.ok(re.test(w), `${w} is listed as "used" but does not light up`)
})

// ---------------------------------------------------------------------------
// B21: the game searches the WHOLE item text, flavour text included.
//
// Reproduced in game 2026-08-13 with these nine divination cards. The generated
// regex was "awr|ne be|mono|ial l|tuna|rker |oml|yos|some" and twelve slots lit
// up, six of them cards nobody asked for — every one of them because its
// FLAVOUR TEXT contains "some".
// ---------------------------------------------------------------------------
const CARDS = ['Mawr Blaidd', 'Divine Beauty', 'Monochrome', 'Imperial Legacy',
  'The Fortunate', 'Darker Half', 'The Fathomless Depths', 'Matryoshka', 'Something Dark']

// The six false hits, with the flavour text that produced them — copied from
// the in-game reading, shortened only where the sentence continues. These are
// the ONLY flavour texts this repository has; they are evidence, not a data
// set, and nothing here may pretend they cover the game.
const FLAVOUR = [
  ['Boon of Justice', 'Some gifts are obligations while others are simply opportunities.'],
  ["Demigod's Wager", 'Sometimes you need to make your own luck.'],
  ['Disdain', "but you'll see more than some see in a lifetime."],
  ['Forbidden Power', 'Some things should not be used. Some power is too great a risk.'],
  ['The Aesthete', 'Some see our mortal flesh as a limitation.'],
  ['The Body', 'all must flow through the body at some point.']
]

test('B21: "some" is unique among the NAMES — which is why the name check let it through', () => {
  // The seven hits: the wanted card, and six flavour texts. The first one is
  // the only one the old universe could see.
  const inNames = ALL_NAMES.filter(n => n.toLowerCase().includes('some'))
  assert.deepEqual(inNames, ['Something Dark'], 'the name list knows exactly one "some"')
  for (const [card, text] of FLAVOUR) {
    assert.ok(text.toLowerCase().includes('some'), `${card}: flavour text without "some"`)
    assert.ok(!card.toLowerCase().includes('some'), `${card}: the NAME already contains it, wrong example`)
  }
  assert.equal(1 + FLAVOUR.length, 7, 'one name hit plus six flavour hits')
})

test('B21: the nine cards no longer produce "some"', () => {
  const r = buildHighlight(CARDS, ALL_NAMES)
  assert.ok(!r.tokens.includes('some'), `still there: ${r.text}`)
  // and the six false hits stay dark: no fragment occurs in their flavour text.
  const re = new RegExp(r.text.slice(1, -1), 'i')
  for (const [card, text] of FLAVOUR) {
    assert.ok(!re.test(text), `${card} would light up again via its flavour text: ${r.text}`)
  }
})

test('B21: the nine names still light up, and nothing foreign does', () => {
  const r = buildHighlight(CARDS, ALL_NAMES)
  const re = new RegExp(r.text.slice(1, -1), 'i')
  for (const c of CARDS) assert.ok(re.test(c), `${c} should light up`)
  const wantedLower = new Set(CARDS.map(n => n.toLowerCase()))
  const bad = ALL_NAMES.filter(n => !wantedLower.has(n.toLowerCase()) && re.test(n))
  assert.deepEqual(bad, [], `false hits by NAME: ${bad.join(' | ')}`)
})

test('B21: the guard is named as the reason, per entry', () => {
  const r = buildHighlight(CARDS, ALL_NAMES)
  assert.deepEqual(r.lengthened, ['Something Dark'],
    'only the card whose short fragment was an everyday word')
  assert.ok(r.entries.find(e => e.name === 'Monochrome').token.length <= 4,
    'a fragment the guard has no opinion about must not grow')
})

test('B21: what does not fit is still counted honestly, and the guard is why', () => {
  // At 250 all nine fit (49 characters). Force the cap to bite and the numbers
  // must still add up — the page prints used/(used+dropped).
  const full = buildHighlight(CARDS, ALL_NAMES)
  assert.equal(full.used.length, CARDS.length, `not all nine fit: ${full.dropped.join(', ')}`)
  const tight = buildHighlight(CARDS, ALL_NAMES, { maxLen: 30 })
  assert.ok(tight.dropped.length > 0)
  assert.equal(tight.used.length + tight.dropped.length, CARDS.length, 'nothing disappears silently')
  assert.ok(tight.length <= 30)
  assert.ok(tight.lengthened.length > 0, 'the reason line has something to say')
})

test('B21: a name that cannot be shortened safely passes as the WHOLE name', () => {
  // Every proper substring of "others" sits inside the everyday word "others"
  // itself, so the guard refuses them all. The full name is exempt — a long
  // entry beats a wrong one — and this is NOT overmatching: no other name
  // contains it.
  const r = buildHighlight(['Others'], ['Chaos Orb'])
  assert.deepEqual(r.tokens, ['others'])
  assert.deepEqual(r.overmatching, [])
  assert.deepEqual(r.lengthened, ['Others'])
})

test('B21: the guard is a heuristic, and this is what it does NOT catch', () => {
  // Honesty test, and it is meant to fail the day someone claims completeness:
  // "tuna" comes from The Fortunate and passes, because "fortunate" is not on
  // the word list. Any flavour text using that word still lights up. Without
  // the flavour texts themselves nothing in this repository can do better.
  const r = buildHighlight(CARDS, ALL_NAMES)
  assert.ok(r.tokens.includes('tuna'), 'the example changed — rewrite this test, do not delete it')
  assert.ok('fortunate'.includes('tuna'), 'and a word nobody listed contains it')
  assert.ok(!FLAVOUR.some(([, t]) => t.toLowerCase().includes('tuna')),
    'the six measured texts happen not to say it — which is luck, not coverage')
})

// ---- B10: the regex is matched by the GAME, so it speaks the GAME's language ----
// `table` is the answer of GET /item-names: `names` are the spellings that need
// no translation, `byRef` maps the English reference name a snapshot row travels
// under to the spelling the client prints.
const DE_TABLE = {
  names: ['Cortex'],                       // identical in both languages
  byRef: {
    'Chaos Orb': 'Chaossphäre',
    'Divine Orb': 'Erhabene Sphäre',
    'Orb of Alchemy': 'Sphäre der Alchemie'
  }
}

test('highlightInputs: wanted AND universe are in the client language', () => {
  const { wanted, unwanted } = highlightInputs({
    refs: ['Chaos Orb'],
    extraRefs: ['Chaos Orb', 'Divine Orb'],
    table: DE_TABLE
  })
  assert.deepEqual(wanted, ['Chaossphäre'])
  // The decisive half: no English reference name may survive in the exclusion
  // set. A German wanted list shortened against an English universe is the
  // "unambiguous in a universe nobody searches" failure.
  for (const n of unwanted) assert.ok(!Object.hasOwn(DE_TABLE.byRef, n), `${n} is still English`)
  assert.ok(unwanted.includes('Erhabene Sphäre'))
  assert.ok(unwanted.includes('Cortex'), 'a name that needs no translation belongs in the universe too')
  assert.ok(!unwanted.includes('Chaossphäre'), 'the wanted name is not its own competitor')
})

test('highlightInputs: no table -> everything English, on BOTH sides', () => {
  // Old container, failed request, primary language: the fallback may never be
  // half a translation.
  const { wanted, unwanted } = highlightInputs({
    refs: ['Chaos Orb'], extraRefs: ['Chaos Orb', 'Divine Orb'], table: null
  })
  assert.deepEqual(wanted, ['Chaos Orb'])
  assert.deepEqual(unwanted, ['Divine Orb'])
})

test('highlightInputs: a name the data set does not know stays as it is, everywhere', () => {
  // Our own label for an unidentified unique map. The client prints it in
  // English too, so passing it through is the right answer — and it has to be
  // the same string in both lists or it becomes its own competitor.
  const label = 'Unidentified Map (Tier 16)'
  const { wanted, unwanted } = highlightInputs({
    refs: [label], extraRefs: [label, 'Chaos Orb'], table: DE_TABLE
  })
  assert.deepEqual(wanted, [label])
  assert.ok(!unwanted.includes(label))
  assert.ok(unwanted.includes('Chaossphäre'))
})

test('highlightInputs: the fragments really come out German', () => {
  // End to end through the generator: with the German table the token has to be
  // a piece of the German name, and must not appear in the German universe.
  const { wanted, unwanted } = highlightInputs({
    refs: ['Chaos Orb'], extraRefs: [], table: DE_TABLE
  })
  const r = buildHighlight(wanted, unwanted)
  assert.ok('chaossphäre'.includes(r.tokens[0]), `${r.tokens[0]} is not a piece of the German name`)
  for (const n of unwanted) assert.ok(!n.toLowerCase().includes(r.tokens[0]), `${r.tokens[0]} also matches ${n}`)
})

// ---- and the page has to SAY it, not just compute it ----------------------------
// `lengthened` is worth nothing while it sits in the return value unread. The
// page has no unit test of its own (renderHighlight writes into the DOM), so
// this reads the source: the reason line must exist in both string tables and
// must be printed exactly when something dropped out AND the guard is why.
import vm from 'node:vm'

test('the page prints the reason when the field ran out', async () => {
  const nw = readFileSync(new URL('./networth.js', import.meta.url), 'utf8')
  assert.match(nw, /r\.dropped\.length && r\.lengthened\.length/,
    'the reason line is not tied to a drop AND the guard')
  assert.match(nw, /T\('nw\.hlWordGuard', \{ n: fmtC\(r\.lengthened\.length\) \}\)/,
    'the count printed must be the number of lengthened fragments')

  const ctx = vm.createContext({ window: {} })
  vm.runInContext(readFileSync(new URL('./i18n.js', import.meta.url), 'utf8'), ctx, { filename: 'i18n.js' })
  for (const lang of ['en', 'de']) {
    const s = ctx.window.I18n.STRINGS[lang]['nw.hlWordGuard']
    assert.ok(s && s.includes('{n}'), `${lang}: the reason line is missing or does not count`)
  }
})
