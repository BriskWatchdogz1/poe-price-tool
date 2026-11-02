// An item that only loses its price is not a stock movement.
//
// The live report this file is built from (2026-08-14, Allflame, six hours in
// which the operator did not play): the History page listed seven events, and
// the pairs were mirror images to the decimal on an untouched stash —
//
//   09:37  The Card Sharp                 +3   +12.6 c
//   10:16  The Card Sharp                 -3   -12.6 c
//   05:37  Weeping Essence of Contempt    +7   +18.8 c
//   06:16  Weeping Essence of Contempt    -7   -18.8 c
//
// The rows are derived from a diff of the PRICED breakdown. A name that lost
// its price left that set and read as an item leaving the stash; getting the
// price back read as one arriving. Both directions are pinned below, together
// with the two cases that must NOT change: an item that really leaves, and the
// guard's release of a withheld arrival (networth/price-guard.mjs, `released` note).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNetworthHistory, buildDelta, foldItems } from './history.mjs'
import { createPriceGuard } from './price-guard.mjs'
import { aggregate, unpricedStock } from './aggregate.mjs'

async function tmpFile (name = 'nw.ndjson') {
  const dir = await mkdtemp(join(tmpdir(), 'nwunpriced-'))
  return join(dir, name)
}
function clock (start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, advance: ms => { t += ms } }
}
const items = (...rows) => rows.map(([name, qty, chaosTotal]) => ({ name, qty, chaosTotal }))
const unpriced = (...rows) => rows.map(([name, count]) => ({ name, count }))

// The reported numbers, to the decimal: three cards worth 12.6c together.
const CARD = 'The Card Sharp'
const REST = 20_000            // the rest of the account, priced and unmoving
const CARD_C = 12.6
const CD = 212

// ---- the fold ---------------------------------------------------------------

test('unpriced names are stock in the breakdown, at a value of zero', () => {
  const m = foldItems(items(['Divine Orb', 10, 1200]), unpriced([CARD, 3]))
  assert.deepEqual(m.get(CARD), [3, 0])
  assert.deepEqual(m.get('Divine Orb'), [10, 1200])
})

test('a caller that hands in no unpriced list gets the map it always got', () => {
  const m = foldItems(items(['Divine Orb', 10, 1200]))
  assert.equal(m.size, 1)
  assert.deepEqual(m.get('Divine Orb'), [10, 1200])
})

// ---- the diff ---------------------------------------------------------------

test('losing the price is quantity 0 and the whole amount on the price side', () => {
  const prev = foldItems(items([CARD, 3, CARD_C]))
  const cur = foldItems([], unpriced([CARD, 3]))
  const d = buildDelta(prev, cur, { at: 1, c: REST + CARD_C, cd: CD }, REST)
  assert.deepEqual(d.i, [[CARD, 0, -CARD_C, -CARD_C]])
})

test('getting the price back is quantity 0 as well — not an arrival', () => {
  const prev = foldItems([], unpriced([CARD, 3]))
  const cur = foldItems(items([CARD, 3, CARD_C]))
  const d = buildDelta(prev, cur, { at: 1, c: REST, cd: CD }, REST + CARD_C)
  assert.deepEqual(d.i, [[CARD, 0, CARD_C, CARD_C]])
})

test('an item that really left is still an outflow of its whole stock', () => {
  const prev = foldItems(items([CARD, 3, CARD_C]))
  const cur = foldItems([], unpriced())    // in neither list -> gone
  const d = buildDelta(prev, cur, { at: 1, c: REST + CARD_C, cd: CD }, REST)
  assert.deepEqual(d.i, [[CARD, -3, -CARD_C, 0]])
})

test('pieces that arrive while the name is unpriced are worth nothing and are shown as nothing', () => {
  const prev = foldItems([], unpriced([CARD, 3]))
  const cur = foldItems([], unpriced([CARD, 5]))
  const d = buildDelta(prev, cur, { at: 1, c: REST, cd: CD }, REST)
  // Two pieces came in and the series still cannot say what they are worth. The
  // existing packDelta rule decides the rest: a row worth nothing takes neither
  // a slot nor a place in the remainder, and events() would drop it as well. So
  // the honest answer is an empty breakdown, not a row of zeroes — and nothing
  // is invented for the two pieces on the way there.
  assert.deepEqual(d.i, [])
})

test('a name priced again with MORE pieces splits the two apart', () => {
  const prev = foldItems([], unpriced([CARD, 3]))               // 3 pieces at no value
  const cur = foldItems(items([CARD, 5, 21]))                   // 5 pieces at 4.2c
  const d = buildDelta(prev, cur, { at: 1, c: REST, cd: CD }, REST + 21)
  // +2 pieces at today's 4.2c = 8.4 on the quantity side, the remaining 12.6 is
  // the revaluation of the three the series was already carrying at zero.
  assert.deepEqual(d.i, [[CARD, 2, 21, 12.6]])
})

// ---- end to end: the reported evening ---------------------------------------

async function evening (withUnpriced) {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now, priceGuard: false })
  await h.load()
  const priced = items(['Rest', 1, REST], [CARD, 3, CARD_C])
  const gone = items(['Rest', 1, REST])
  const still = withUnpriced ? unpriced([CARD, 3]) : undefined

  await h.append('player1', { totalChaos: REST + CARD_C, cdRatio: CD, items: priced })
  c.advance(60_000)
  // The stash is untouched; only the price feed dropped the card.
  await h.append('player1', { totalChaos: REST, cdRatio: CD, items: gone, unpriced: still })
  c.advance(60_000)
  await h.append('player1', { totalChaos: REST + CARD_C, cdRatio: CD, items: priced })
  return h
}

test('a price that flickers off and back on produces no event at all', async () => {
  const h = await evening(true)
  // minDivine 0 = everything that was recorded, so this cannot pass by sitting
  // under a threshold — there has to be nothing there.
  const ev = h.events('player1', 6 * 3600e3, { minDivine: 0 })
  const rows = ev.events.flatMap(e => e.items).filter(r => r[0] === CARD)
  assert.deepEqual(rows, [], 'an untouched stash produced stock movements')
})

test('…and without the unpriced list the mirror pair comes back — that was the defect', async () => {
  const h = await evening(false)
  const ev = h.events('player1', 6 * 3600e3, { minDivine: 0, bucketMs: 1 })
  const rows = ev.events.flatMap(e => e.items).filter(r => r[0] === CARD)
  assert.deepEqual(rows, [[CARD, -3, -CARD_C], [CARD, 3, CARD_C]],
    'the reported shape: an outflow and an inflow, mirror images to the decimal')
})

test('the value the card lost is still in the curve, and on the price side of the delta', async () => {
  const h = await evening(true)
  const dip = h.points[1]
  assert.equal(dip.c, REST, 'the curve carries the loss — that is where prices belong')
  assert.deepEqual(dip.d.i, [[CARD, 0, -CARD_C, -CARD_C]])
  // detail() is what the curve's own panel reads: the amount is reported as a
  // price move over an unchanged quantity.
  const det = h.detail('player1', h.points[0].at, dip.at)
  const row = det.items.find(r => r.name === CARD)
  assert.deepEqual(row, { name: CARD, qty: 0, value: -CARD_C, price: -CARD_C })
})

// ---- and the case that must keep producing an event ------------------------

const SILENT = () => {}

test('the guard releasing a withheld arrival is still booked as stock arriving', async () => {
  const c = clock()
  const ACCOUNT = 94 * CD
  const FIND = 25 * CD
  const h = createNetworthHistory(await tmpFile(), {
    now: c.now, priceGuard: createPriceGuard({ now: c.now, maxHoldMs: 6 * 3600e3, log: SILENT })
  })
  await h.load()
  const rest = items(['Rest', 1, ACCOUNT])
  const found = [...rest, { name: 'Big Unique', qty: 1, chaosTotal: FIND }]
  // A completely ordinary unpriced item is present the whole time, so the two
  // zero-valued cases stand side by side in every one of these points.
  const noise = unpriced(['Some Rare Nobody Prices', 4])

  await h.append('player1', { totalChaos: ACCOUNT, cdRatio: CD, items: rest, unpriced: noise })
  c.advance(60_000)
  await h.append('player1', { totalChaos: ACCOUNT + FIND, cdRatio: CD, items: found, unpriced: noise })
  assert.equal(h.points.at(-1).c, ACCOUNT, 'the arrival is withheld')
  c.advance(6 * 3600e3)
  await h.append('player1', { totalChaos: ACCOUNT + FIND, cdRatio: CD, items: found, unpriced: noise })
  assert.equal(h.points.at(-1).c, ACCOUNT + FIND, 'and accepted after the hold window')

  assert.deepEqual(h.points.at(-1).d.i, [['Big Unique', 1, FIND, 0]],
    'the accepted stock enters on the quantity side')
  const ev = h.events('player1', 7 * 3600e3)
  const rows = ev.events.flatMap(e => e.items).filter(r => r[0] === 'Big Unique')
  assert.deepEqual(rows, [['Big Unique', 1, FIND]])
  // The unpriced bystander never becomes an event, in either direction.
  assert.equal(ev.events.flatMap(e => e.items).filter(r => r[0] === noise[0].name).length, 0)
})

test('a point in which a held item is merely unpriced does not end its hold', async () => {
  // price-guard.mjs promises "present in every recorded point of the window",
  // and counts a point without a price of its own as no observation either way.
  // Until the breakdown carried unpriced names, a genuinely unpriced item was
  // simply ABSENT from the map, so that branch could not be reached from a real
  // snapshot at all — the hold ended instead.
  const c = clock()
  const guard = createPriceGuard({ now: c.now, maxHoldMs: 6 * 3600e3, log: SILENT })
  const ACCOUNT = 94 * CD
  const FIND = 25 * CD
  const h = createNetworthHistory(await tmpFile(), { now: c.now, priceGuard: guard })
  await h.load()
  const rest = items(['Rest', 1, ACCOUNT])
  const found = [...rest, { name: 'Big Unique', qty: 1, chaosTotal: FIND }]

  await h.append('player1', { totalChaos: ACCOUNT, cdRatio: CD, items: rest })
  c.advance(60_000)
  await h.append('player1', { totalChaos: ACCOUNT + FIND, cdRatio: CD, items: found })
  assert.equal(guard.held.size, 1, 'the arrival is withheld')
  // Three hours in, the feed drops the price for one point — the item is still
  // in the stash, so it is handed in as unpriced.
  c.advance(3 * 3600e3)
  await h.append('player1', {
    totalChaos: ACCOUNT, cdRatio: CD, items: rest, unpriced: unpriced(['Big Unique', 1])
  })
  assert.equal(guard.held.size, 1, 'a blind point ended the hold')
  // …and the blind stretch does not count towards the window either: three
  // hours after the gap the item has stood for three, not six.
  c.advance(3 * 3600e3)
  await h.append('player1', { totalChaos: ACCOUNT + FIND, cdRatio: CD, items: found })
  assert.equal(h.points.at(-1).c, ACCOUNT, 'the wall clock let a withheld arrival in early')
})

// ---- the name the display cap cut out (the last hole of this class) ----------
//
// The fold above only works for names the recorder is actually told about, and
// `snapshot.unpriced` is capped at 100 NAMES for the page it is drawn on. The
// names that cap drops are the rarest ones — thinly traded items that drift in
// and out of being priced, i.e. exactly the population the fold exists for. Fed
// the display list, the recorder fell straight back into the old reading for
// them; production still showed two such phantom rows per block after the fix
// above had taken the other four away. It is fed the stored tabs now
// (aggregate.mjs, unpricedStock), which nothing caps.

const FILLERS = 100        // busy unpriced names, enough to fill the display cap
const FILLER_PIECES = 5    // …each of them busier than the card, so the ranking cuts the card
const CARD_PIECES = 3

// The stash as the per-tab store holds it: one tab, a priced remainder, a
// hundred busy unpriced names — and the card, either priced or not.
function storedTabs (cardPriced) {
  const unpricedRows = []
  for (let i = 0; i < FILLERS; i++) {
    unpricedRows.push({ name: `Filler ${i}`, kind: 'stackable', count: FILLER_PIECES })
  }
  if (!cardPriced) unpricedRows.push({ name: CARD, kind: 'divcard', count: CARD_PIECES })
  const rows = [{ name: 'Rest', kind: 'stackable', tab: 'A', tabIndex: 0, qty: 1, chaosEach: REST, chaosTotal: REST }]
  if (cardPriced) {
    rows.push({ name: CARD, kind: 'divcard', tab: 'A', tabIndex: 0, qty: CARD_PIECES, chaosEach: CARD_C / CARD_PIECES, chaosTotal: CARD_C })
  }
  const pieces = FILLERS * FILLER_PIECES + (cardPriced ? 0 : CARD_PIECES)
  return [{
    index: 0,
    name: 'A',
    items: rows,
    unpriced: unpricedRows,
    counts: { priced: rows.length, unpriced: unpricedRows.length, unpricedPieces: pieces, skipped: 0 }
  }]
}
const snapshotOf = tabs => aggregate({ tabs, cdRatio: CD, league: 'L', accountName: 'a' })

// Two minutes of an untouched stash: the card is priced in the first and only
// loses its price in the second. `stock` decides which unpriced list the
// recorder is handed — the drawn one or the stored one.
async function cappedEvening (stock) {
  const c = clock()
  const h = createNetworthHistory(await tmpFile(), { now: c.now, priceGuard: false })
  await h.load()
  for (const cardPriced of [true, false]) {
    const tabs = storedTabs(cardPriced)
    const snap = snapshotOf(tabs)
    await h.append('player1', {
      totalChaos: snap.totalChaos, cdRatio: CD, items: snap.items, unpriced: stock(snap, tabs)
    })
    c.advance(60_000)
  }
  return h.events('player1', 6 * 3600e3, { minDivine: 0, bucketMs: 1 })
    .events.flatMap(e => e.items).filter(r => r[0] === CARD)
}

test('a name ranked out of the display list is still stock — no movement is recorded for it', async () => {
  const rows = await cappedEvening((_snap, tabs) => unpricedStock(tabs))
  assert.deepEqual(rows, [], 'the card is below the 100-name cut and must still count as present')
})

test('…and fed the capped display list instead, the phantom departure comes back', async () => {
  const rows = await cappedEvening(snap => snap.unpriced)
  assert.deepEqual(rows, [[CARD, -CARD_PIECES, -CARD_C]],
    'the defect this section exists for: cut from the list, therefore read as gone')
})

test('the page keeps its cap and can still say how many pieces it is not listing', async () => {
  const tabs = storedTabs(false)
  const snap = snapshotOf(tabs)
  // The snapshot that goes over the wire is unchanged by any of this: 100 names,
  // and the card is not one of them.
  assert.equal(snap.unpriced.length, 100)
  assert.ok(!snap.unpriced.some(u => u.name === CARD))
  // What renderUnpriced prints as "N pcs not listed" — the faithful per-tab
  // piece total minus what the rows on screen add up to.
  const shown = snap.unpriced.reduce((sum, u) => sum + u.count, 0)
  assert.equal(snap.tabs[0].unpricedPieces - shown, CARD_PIECES)
  // And the recorder's list is the one that is complete.
  assert.equal(unpricedStock(tabs).length, 101)
})

// The wiring itself, pinned where it cannot be unit-tested: recordNetworthHistory
// lives inside server.mjs and is reachable only through the refresher. The two
// lists it could hand the recorder look interchangeable at the call site and are
// not — one of them is capped for a page — so the choice is asserted here rather
// than left to a reviewer's eye.
test('the server hands the recorder the stored stock, not the display list', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8')
  const from = src.indexOf('networthHistory.append(user, {')
  assert.ok(from > 0, 'the recorder call site moved — this check has to follow it')
  const call = src.slice(from, src.indexOf('\n  })', from))
  assert.match(call, /unpriced:\s*unpricedStock\(/, 'the uncapped fold of the stored tabs is what belongs here')
  assert.doesNotMatch(call, /unpriced:\s*snap\.unpriced/, 'snapshot.unpriced is capped at 100 names for the page')
})
