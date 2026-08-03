import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHighlight, shortestToken, HIGHLIGHT_MAX_DEFAULT } from './highlight.js'

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
