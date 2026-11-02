// The gap log is the only place a failure of the German path ever surfaces
// (design doc, section 6): the user will not report it and nobody reads the
// container log. So the properties the admin view depends on are pinned here —
// aggregation, separation by language, order by frequency, and the memory bound
// that keeps a months-running server from turning user input into a leak.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGapLog, GAP_PARSE, GAP_UNKNOWN_MOD } from './gap-log.mjs'

// A clock the test drives, so "last seen" and the tie-break are facts rather
// than a race against the wall clock.
function fakeClock (start = 1_700_000_000_000) {
  let t = start
  return { now: () => (t += 1000), at: () => t }
}

test('the same gap seen twice is one counted entry, not two rows', () => {
  const log = createGapLog({ now: fakeClock().now })
  log.recordUnknownMod({ lang: 'de', text: '+# zur Stufe von gefassten Physisch-Gemmen' })
  log.recordUnknownMod({ lang: 'de', text: '+# zur Stufe von gefassten Physisch-Gemmen' })
  log.recordUnknownMod({ lang: 'de', text: '+# zur Stufe von gefassten Physisch-Gemmen' })

  const de = log.snapshot().kinds[GAP_UNKNOWN_MOD].languages
  assert.equal(de.length, 1)
  assert.equal(de[0].entries.length, 1, 'three sightings are one row')
  assert.equal(de[0].entries[0].count, 3)
  assert.ok(de[0].entries[0].lastAt > de[0].entries[0].firstAt, 'first and last sighting are both kept')
})

test('languages are separated, never merged into one list', () => {
  const log = createGapLog({ now: fakeClock().now })
  log.recordUnknownMod({ lang: 'de', text: 'deutsche Zeile' })
  log.recordUnknownMod({ lang: 'en', text: 'english line' })
  log.recordUnknownMod({ lang: 'en', text: 'english line' })

  const groups = log.snapshot().kinds[GAP_UNKNOWN_MOD].languages
  assert.deepEqual(groups.map(g => g.lang), ['de', 'en'])
  assert.equal(groups.find(g => g.lang === 'de').entries[0].count, 1)
  assert.equal(groups.find(g => g.lang === 'en').entries[0].count, 2)
  // The same text in two languages stays two gaps: a line only German misses is
  // a generator problem, one both miss is an upstream problem.
  const log2 = createGapLog({ now: fakeClock().now })
  log2.recordUnknownMod({ lang: 'de', text: 'same text' })
  log2.recordUnknownMod({ lang: 'en', text: 'same text' })
  assert.equal(log2.snapshot().kinds[GAP_UNKNOWN_MOD].languages.length, 2)
})

test('entries come out sorted by frequency, most recent first on a tie', () => {
  const clock = fakeClock()
  const log = createGapLog({ now: clock.now })
  for (let i = 0; i < 2; i++) log.recordUnknownMod({ lang: 'de', text: 'twice' })
  for (let i = 0; i < 7; i++) log.recordUnknownMod({ lang: 'de', text: 'seven times' })
  log.recordUnknownMod({ lang: 'de', text: 'once, early' })
  for (let i = 0; i < 4; i++) log.recordUnknownMod({ lang: 'de', text: 'four times' })
  log.recordUnknownMod({ lang: 'de', text: 'once, late' })

  const entries = log.snapshot().kinds[GAP_UNKNOWN_MOD].languages[0].entries
  assert.deepEqual(entries.map(e => e.text),
    ['seven times', 'four times', 'twice', 'once, late', 'once, early'])
})

test('a parse failure carries language, reason and the triggering text', () => {
  const log = createGapLog({ now: fakeClock().now })
  log.recordParseFailure({
    lang: 'de',
    text: 'Gegenstandsklasse: Stiefel\nSeltenheit: Selten\nSiedender Schritt\n',
    reason: 'Failed to parse item'
  })
  const e = log.snapshot().kinds[GAP_PARSE].languages[0].entries[0]
  assert.equal(e.lang, 'de')
  assert.equal(e.reason, 'Failed to parse item')
  assert.equal(e.text, 'Gegenstandsklasse: Stiefel', 'the item class header is the signature')
  assert.match(e.sample, /Siedender Schritt/, 'the full text travels along, so the failure is reproducible')
})

test('two rare boots with different rolls are ONE row, two different reasons are two', () => {
  const log = createGapLog({ now: fakeClock().now })
  const boot = roll => `Item Class: Boots\nRarity: Rare\nSomething\n+${roll} to maximum Life\n`
  log.recordParseFailure({ lang: 'en', text: boot(90), reason: 'no matching base' })
  log.recordParseFailure({ lang: 'en', text: boot(93), reason: 'no matching base' })
  log.recordParseFailure({ lang: 'en', text: boot(95), reason: 'unexpected section' })

  const entries = log.snapshot().kinds[GAP_PARSE].languages[0].entries
  assert.equal(entries.length, 2, 'the roll is not part of the identity, the reason is')
  assert.equal(entries[0].count, 2)
  assert.equal(entries[0].reason, 'no matching base')
})

test('the stored text is bounded — a pasted novel does not become an entry', () => {
  const log = createGapLog({ maxTextLength: 50, now: fakeClock().now })
  log.recordUnknownMod({ lang: 'de', text: 'x'.repeat(500) })
  const e = log.snapshot().kinds[GAP_UNKNOWN_MOD].languages[0].entries[0]
  assert.equal(e.text.length, 50)
  assert.ok(e.text.endsWith('…'), 'truncation is visible, not silent')
})

test('the number of entries is capped, and the rare ones are what gets dropped', () => {
  const log = createGapLog({ maxEntriesPerKind: 3, now: fakeClock().now })
  for (let i = 0; i < 5; i++) log.recordUnknownMod({ lang: 'de', text: 'recurring' })
  for (let i = 0; i < 4; i++) log.recordUnknownMod({ lang: 'de', text: 'frequent' })
  log.recordUnknownMod({ lang: 'de', text: 'one-off A' })
  log.recordUnknownMod({ lang: 'de', text: 'one-off B' })
  log.recordUnknownMod({ lang: 'de', text: 'one-off C' })

  assert.equal(log.size(GAP_UNKNOWN_MOD), 3, 'the cap holds')
  const group = log.snapshot().kinds[GAP_UNKNOWN_MOD]
  const texts = group.languages[0].entries.map(e => e.text)
  assert.ok(texts.includes('recurring'), 'the most frequent gap survives — it is the one worth fixing')
  assert.ok(texts.includes('frequent'))
  assert.ok(group.dropped >= 2, 'and the truncation is reported, not hidden')
})

test('the two kinds have separate budgets', () => {
  const log = createGapLog({ maxEntriesPerKind: 2, now: fakeClock().now })
  for (const t of ['a', 'b', 'c', 'd']) log.recordUnknownMod({ lang: 'de', text: t })
  log.recordParseFailure({ lang: 'de', text: 'Item Class: Boots', reason: 'boom' })
  // A flood of unknown mods must not push the parse failures out of the view.
  assert.equal(log.size(GAP_PARSE), 1)
  assert.equal(log.size(GAP_UNKNOWN_MOD), 2)
})

test('an empty log answers with both kinds present and no entries', () => {
  const snap = createGapLog().snapshot()
  assert.deepEqual(Object.keys(snap.kinds).sort(), [GAP_PARSE, GAP_UNKNOWN_MOD].sort())
  assert.deepEqual(snap.kinds[GAP_PARSE].languages, [])
  assert.deepEqual(snap.languages, [])
})
