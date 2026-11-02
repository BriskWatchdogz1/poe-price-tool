// The extended copy form and the catalogue repair path.
//
// This tool asks its users to bind Ctrl+Alt+C ("Advanced Mod Descriptions"), and
// that form writes a mod line as ROLL plus the range the roll came out of:
//
//   +310(260-320) to Armour        1% increased Armour per 12(10-14) Strength …
//
// GGG's stat catalogue lists neither bracket ("+# to Armour"), and
// normalizeStatText only masks digits — so before this the repair path that is
// supposed to bridge a lagging stat database could never fire for the copy form
// that is the NORMAL case. Nothing about that is German: the assertions below
// run the ENGLISH path (spliceResolvedUnknownMods defaults to PRIMARY_LANG),
// with no pair table anywhere near them. unknown-mod-repair.test.mjs carries the
// same case through a real German parse end to end.
//
// NOTHING IS TYPED INTO THIS FILE. The mod texts are the vendored snapshot's own
// stat refs — the exact form the trade site lists them in — and the ids the
// catalogue answers with are those stats' own trade ids. The rolls are the only
// invented numbers, because a roll is what a test has to choose.
//
// NO NETWORK. The catalogue is served from a frozen answer through a fetch spy
// installed BEFORE the server is imported (so it also sits underneath the
// engine's file:// adapter); every other http(s) call is refused.
//
// The functions under test are pure, but they live in server.mjs -> the import
// boots the REAL server (pattern: socket-links.test.mjs) -> env before the
// import, close in after().
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { quietEnv } from './test-quiet-env.mjs'

const CATALOGUE_URL = 'https://www.pathofexile.com/api/trade/data/stats'
const EN_STATS = new URL('../../renderer/public/data/en/stats.ndjson', import.meta.url)

// --- the stat lines this file works on, read out of the snapshot -------------

/**
 * One stat per SHAPE the bracket form appears in. A candidate needs a single
 * explicit trade id (so the catalogue answer is unambiguous) and a one-line ref,
 * and the shapes are what the corpus of real German/English item texts shows:
 *
 *   signed      "+#% Chance to Block Attack Damage"  -> "+7(5-9)% Chance …"
 *   unsigned    "#% additional Physical Damage …"    -> "12(10-15)% additional …"
 *   two rolls   "# to # Added Chaos Damage …"        -> "12(10-15) to 25(20-30) …"
 *   static num  "1% increased Armour per # Strength" -> the leading 1 is NOT the
 *               roll, and the bracket is the only thing that says so.
 */
function pickStats (lines) {
  const holes = ref => (ref.match(/#/g) || []).length
  const shapes = {
    signed: ref => holes(ref) === 1 && /^\+#/.test(ref),
    unsigned: ref => holes(ref) === 1 && /^#%/.test(ref),
    twoRolls: ref => holes(ref) === 2,
    staticFirst: ref => holes(ref) === 1 && /^\d/.test(ref),
  }
  const picked = {}
  for (const line of lines) {
    for (const s of (line.stats ? line.stats : [line])) {
      const ids = s.trade?.ids?.explicit
      if (!Array.isArray(ids) || ids.length !== 1) continue
      if (typeof s.ref !== 'string' || !s.ref.includes('#') || s.ref.includes('\n')) continue
      if (Object.values(picked).some(p => p.ref === s.ref)) continue // one stat fills one slot
      for (const [name, matches] of Object.entries(shapes)) {
        if (!picked[name] && matches(s.ref)) { picked[name] = { name, ref: s.ref, tradeId: ids[0] }; break }
      }
    }
  }
  return picked
}

const statLines = (await readFile(EN_STATS, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))
const STATS = pickStats(statLines)
const ALL = Object.values(STATS)

// The rolls each placeholder gets, and the range around it. Chosen so no two
// numbers in a line are equal — a mask that grabbed the wrong one would show.
const ROLLS = [{ value: 12, min: 10, max: 15 }, { value: 25, min: 20, max: 30 }]

/** The line as Ctrl+Alt+C would put it out: roll + range in every placeholder. */
const advanced = ref => {
  let i = -1
  return ref.replace(/#/g, () => { i += 1; const r = ROLLS[i]; return `${r.value}(${r.min}-${r.max})` })
}
/** The same line as plain Ctrl+C: the roll alone, no range. */
const plain = ref => {
  let i = -1
  return ref.replace(/#/g, () => { i += 1; return String(ROLLS[i].value) })
}
/** What the trade search must end up filtering on (engine: getRollOrMinmaxAvg). */
const expectedValue = ref => {
  const n = (ref.match(/#/g) || []).length
  return n === 2 ? (ROLLS[0].value + ROLLS[1].value) / 2 : ROLLS[0].value
}

// --- the catalogue, frozen ---------------------------------------------------

const catalogue = {
  result: [{ label: 'Explicit', entries: ALL.map(s => ({ id: s.tradeId, text: s.ref })) }]
}

const netCalls = []
const beforeAdapter = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input))
  if (!/^https?:/i.test(url)) return beforeAdapter(input, init)
  netCalls.push(url)
  if (url === CATALOGUE_URL) return { ok: true, json: async () => catalogue }
  throw new Error(`no network in this test: ${url}`)
}

// The full set that keeps a booted server off the network. One list, imported:
// every file that wrote it out by hand left something out, and what kept being
// left out was the switch a WebSocket needs (test-quiet-env.mjs, docs/bugs.md
// B25). Applied FIRST — anything this file sets below overrides it on purpose.
quietEnv()
process.env.PORT = '0'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_REFERENCE_DISABLED = '1'

let mod
before(async () => { mod = await import('./server.mjs') })
after(async () => { await new Promise(resolve => mod.server.close(resolve)) })

// --- the fixture is what it claims to be -------------------------------------

test('the snapshot supplied one stat for every bracket shape', () => {
  assert.deepEqual(Object.keys(STATS).sort(), ['signed', 'staticFirst', 'twoRolls', 'unsigned'])
  assert.match(advanced(STATS.staticFirst.ref), /^\d+%/, 'its leading number is part of the wording')
  assert.notEqual(expectedValue(STATS.twoRolls.ref), ROLLS[0].value, 'two rolls fold to their average')
})

// --- splitRollRanges: what a rolled line is made of --------------------------

test('splitRollRanges: the range comes off, the roll stays, the mask lands on the roll', () => {
  for (const s of ALL) {
    const { text, masked, rolls } = mod.splitRollRanges(advanced(s.ref))
    assert.equal(text, plain(s.ref), `${s.name}: only the brackets are gone`)
    assert.equal(masked, s.ref, `${s.name}: the mask reproduces the catalogue's own wording`)
    assert.deepEqual(rolls, ROLLS.slice(0, (s.ref.match(/#/g) || []).length), `${s.name}: rolls and their bounds`)
  }
})

test('splitRollRanges: a line without ranges is left exactly as it was', () => {
  for (const s of ALL) {
    const { text, masked, rolls } = mod.splitRollRanges(plain(s.ref))
    assert.equal(text, plain(s.ref))
    assert.deepEqual(rolls, [], 'nothing in the line says which number is a roll')
    // The old behaviour: first number masked, sign kept, everything else literal.
    assert.equal(masked, plain(s.ref).replace(/\d+(?:\.\d+)?/, '#'))
  }
})

test('splitRollRanges: one bound, swapped bounds, a legacy roll, an empty bracket', () => {
  // A single bound is the sextant form ("# uses remaining") — min doubles as max.
  assert.deepEqual(mod.splitRollRanges('4(6)').rolls, [{ value: 4, min: 4, max: 6 }])
  // Bounds the wrong way round (legacy translations) must not produce a slider
  // whose track runs backwards, and a roll outside its own range widens it.
  assert.deepEqual(mod.splitRollRanges('5(9-2)').rolls, [{ value: 5, min: 2, max: 9 }])
  assert.deepEqual(mod.splitRollRanges('11(2-9)').rolls, [{ value: 11, min: 2, max: 11 }])
  assert.deepEqual(mod.splitRollRanges('-4(-10--3)').rolls, [{ value: -4, min: -10, max: -3 }])
  // GGG writes an empty bracket where it has no advanced description.
  assert.equal(mod.splitRollRanges('Passives in Radius of Wicked Ward() can be Allocated').text,
    'Passives in Radius of Wicked Ward can be Allocated')
  // A bracket that is part of the wording is not a range.
  assert.equal(mod.splitRollRanges('3 (Maximum)').text, '3 (Maximum)')
})

// --- the repair path itself, in English --------------------------------------

const spliced = async texts => {
  const item = { unknownModifiers: texts.map(text => ({ text, type: 'explicit' })) }
  const preset = { stats: [] }
  await mod.spliceResolvedUnknownMods(item, preset)
  return { item, preset }
}

test('a mod copied with Ctrl+Alt+C is repaired — English, no pair table involved', async () => {
  const { item, preset } = await spliced(ALL.map(s => advanced(s.ref)))
  assert.deepEqual(item.unknownModifiers, [], 'every line came back from the catalogue')
  for (const s of ALL) {
    const stat = preset.stats.find(st => st.tradeId?.[0] === s.tradeId)
    assert.ok(stat, `${s.name}: spliced back in with GGG's trade id`)
    assert.equal(stat.text, s.ref, `${s.name}: the card shows the catalogue's wording`)
    assert.equal(stat.disabled, false, 'and it is part of the search, not a footnote')
    assert.equal(stat.resolvedFromCatalogue, true)
  }
})

test('the roll survives the repair — it is what the trade search filters on', async () => {
  const { preset } = await spliced(ALL.map(s => advanced(s.ref)))
  for (const s of ALL) {
    const stat = preset.stats.find(st => st.tradeId?.[0] === s.tradeId)
    const value = expectedValue(s.ref)
    assert.equal(stat.roll.value, value, `${s.name}: the item's own roll`)
    assert.equal(stat.roll.min, value, 'searched as "rolls >= mine"')
    assert.equal(stat.roll.max, undefined, 'open upwards')
  }
  // The point of the static-number case: the leading "1%" of the wording is not
  // the roll, and only the bracket could tell the two apart.
  const staticFirst = preset.stats.find(st => st.tradeId?.[0] === STATS.staticFirst.tradeId)
  assert.notEqual(staticFirst.roll.value, Number(/^\d+/.exec(STATS.staticFirst.ref)[0]))
})

test('the range the line brought along becomes the slider track', async () => {
  const { preset } = await spliced(ALL.map(s => advanced(s.ref)))
  for (const s of ALL) {
    const stat = preset.stats.find(st => st.tradeId?.[0] === s.tradeId)
    const n = (s.ref.match(/#/g) || []).length
    const avg = xs => (xs.length === 2 ? (xs[0] + xs[1]) / 2 : xs[0])
    assert.deepEqual(stat.roll.default, {
      min: avg(ROLLS.slice(0, n).map(r => r.min)),
      max: avg(ROLLS.slice(0, n).map(r => r.max))
    }, `${s.name}: bounds out of the line itself`)
  }
  const [withTrack] = mod.modsOf(preset)
  assert.ok(Array.isArray(withTrack.valueRange), 'the card gets a slider, not just a checkbox')
})

test('a plain Ctrl+C copy still resolves exactly as it did before', async () => {
  const { item, preset } = await spliced(ALL.map(s => plain(s.ref)))
  assert.deepEqual(item.unknownModifiers, [], 'the path that always worked still works')
  for (const s of ALL) {
    const stat = preset.stats.find(st => st.tradeId?.[0] === s.tradeId)
    assert.ok(stat, `${s.name}: resolved`)
    assert.equal(stat.roll.default, undefined, 'no range in the line -> no slider invented')
  }
})

test('the catalogue was fetched once, and nothing else was fetched successfully', () => {
  assert.equal(netCalls.filter(u => u === CATALOGUE_URL).length, 1, 'once per TTL, not once per mod')
})
