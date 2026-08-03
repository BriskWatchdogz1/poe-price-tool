// corpse-pricer.mjs — background corpse valuation. Reads the corpse names from
// the latest networth snapshot(s), skips 'Imperfect ' (route values those 0 with
// no query), dedupes, budgets per hour (stalest/unpriced first), then per name:
// trade-search -> normalise buyouts to chaos (divine via the SHARED live C:D) ->
// each = average of the 5 cheapest (fewer than 5 -> what exists; 0 -> null) ->
// into the store (INCLUDING null). Trade layer + queue are faked here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCorpseStore } from './corpse-store.mjs'
import { createCorpsePricer } from './corpse-pricer.mjs'

const HOUR = 60 * 60 * 1000
const silent = { error () {}, warn () {}, info () {}, log () {} }

async function store (ttlMs = 6 * HOUR) {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-corpsep-'))
  const s = createCorpseStore(join(dir, 'corpse.json'), { ttlMs })
  await s.load()
  return { s, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// run every queued background job immediately (serial, like pump()).
function immediateQueue () {
  const jobs = []
  return { enqueueBackground: async fn => { jobs.push(fn); await fn() }, jobs }
}

// fake trade client: name -> listings[]; records every queried name.
function fakeTrade (byName, { throwFor } = {}) {
  const queried = []
  let open = false
  return {
    queried,
    isCircuitOpen: () => open,
    async searchListings (name) {
      if (open) { const e = new Error('open'); e.code = 'CIRCUIT_OPEN'; throw e }
      queried.push(name)
      if (throwFor && throwFor.has(name)) { open = true; const e = new Error('401'); e.status = 401; throw e }
      return byName[name] || []
    }
  }
}

test('Imperfect corpses are NEVER queried: the route values them at 0', async () => {
  const { s, cleanup } = await store()
  const trade = fakeTrade({})
  const q = immediateQueue()
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Imperfect Forest Tiger', 'Imperfect Pain Artist'],
    chaosPerDivine: () => 200, enqueueBackground: q.enqueueBackground,
    budgetPerHour: 25, log: silent
  })
  await pricer.tickOnce()
  assert.deepEqual(trade.queried, [])
  await cleanup()
})

test('average of the 5 cheapest, divine-priced listings included via the shared C:D', async () => {
  const { s, cleanup } = await store()
  // 6 buyouts: 5 chaos + 1 divine(1)*200 = 200. Sorted ascending:
  // [3,5,7,9,11,200] -> the 5 cheapest [3,5,7,9,11] -> avg = 7.
  const trade = fakeTrade({
    'Forest Tiger': [
      { priceAmount: 11, priceCurrency: 'chaos' },
      { priceAmount: 3, priceCurrency: 'chaos' },
      { priceAmount: 1, priceCurrency: 'divine' }, // 200c
      { priceAmount: 9, priceCurrency: 'chaos' },
      { priceAmount: 5, priceCurrency: 'chaos' },
      { priceAmount: 7, priceCurrency: 'chaos' }
    ]
  })
  const q = immediateQueue()
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Forest Tiger'],
    chaosPerDivine: () => 200, enqueueBackground: q.enqueueBackground,
    budgetPerHour: 25, log: silent
  })
  await pricer.tickOnce()
  assert.deepEqual(trade.queried, ['Forest Tiger'])
  assert.equal(s.getPrice('Forest Tiger'), 7)
  await cleanup()
})

test('fewer than 5 results -> average of whatever is there', async () => {
  const { s, cleanup } = await store()
  const trade = fakeTrade({
    'Pain Artist': [
      { priceAmount: 10, priceCurrency: 'chaos' },
      { priceAmount: 20, priceCurrency: 'chaos' }
    ]
  })
  const q = immediateQueue()
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Pain Artist'],
    chaosPerDivine: () => 200, enqueueBackground: q.enqueueBackground, log: silent
  })
  await pricer.tickOnce()
  assert.equal(s.getPrice('Pain Artist'), 15)
  await cleanup()
})

test('0 results -> null, and the null is CACHED', async () => {
  const { s, cleanup } = await store()
  const trade = fakeTrade({ 'Rare Corpse': [] })
  const q = immediateQueue()
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Rare Corpse'],
    chaosPerDivine: () => 200, enqueueBackground: q.enqueueBackground, log: silent
  })
  await pricer.tickOnce()
  assert.equal(s.getPrice('Rare Corpse'), null)
  assert.ok(s.get('Rare Corpse') !== null) // entry exists (the null is cached)
  assert.equal(s.isFresh('Rare Corpse'), true)
  await cleanup()
})

test('fresh names are skipped: cache hit, no fetch', async () => {
  const { s, cleanup } = await store()
  await s.setPrice('Standard', 'Forest Tiger', 5, Date.now())
  const trade = fakeTrade({ 'Forest Tiger': [{ priceAmount: 99, priceCurrency: 'chaos' }] })
  const q = immediateQueue()
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Forest Tiger'],
    chaosPerDivine: () => 200, enqueueBackground: q.enqueueBackground, log: silent
  })
  await pricer.tickOnce()
  assert.deepEqual(trade.queried, []) // fresh -> not queried again
  assert.equal(s.getPrice('Forest Tiger'), 5) // unchanged
  await cleanup()
})

test('401 -> circuit open: later ticks query nothing at all', async () => {
  const { s, cleanup } = await store()
  const trade = fakeTrade(
    { A: [{ priceAmount: 1, priceCurrency: 'chaos' }], B: [{ priceAmount: 2, priceCurrency: 'chaos' }] },
    { throwFor: new Set(['A']) }
  )
  const q = immediateQueue()
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['A', 'B'],
    chaosPerDivine: () => 200, enqueueBackground: q.enqueueBackground, log: silent
  })
  await pricer.tickOnce() // queries A -> 401 -> circuit opens
  assert.deepEqual(trade.queried, ['A'])
  await pricer.tickOnce() // circuit open -> no fetch whatsoever
  assert.deepEqual(trade.queried, ['A'])
  await cleanup()
})

// I3: an exotic priceCurrency (exalted/mirror/…) is DROPPED, never counted as chaos.
test('unknown priceCurrency is dropped, not booked as chaos', async () => {
  const { s, cleanup } = await store()
  // 3 chaos [4,6,8] + 1 exalted(1) — the exalted MUST be dropped -> avg = 6.
  const trade = fakeTrade({
    'Forest Tiger': [
      { priceAmount: 8, priceCurrency: 'chaos' },
      { priceAmount: 1, priceCurrency: 'exalted' },
      { priceAmount: 4, priceCurrency: 'chaos' },
      { priceAmount: 6, priceCurrency: 'chaos' }
    ]
  })
  const q = immediateQueue()
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Forest Tiger'],
    chaosPerDivine: () => 200, enqueueBackground: q.enqueueBackground, log: silent
  })
  await pricer.tickOnce()
  assert.equal(s.getPrice('Forest Tiger'), 6) // 6, not (8+1+4+6)/4 = 4.75
  await cleanup()
})

test('only exotic currencies -> null: no listing can be normalised', async () => {
  const { s, cleanup } = await store()
  const trade = fakeTrade({ 'Weird Corpse': [{ priceAmount: 1, priceCurrency: 'mirror' }] })
  const q = immediateQueue()
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Weird Corpse'],
    chaosPerDivine: () => 200, enqueueBackground: q.enqueueBackground, log: silent
  })
  await pricer.tickOnce()
  assert.equal(s.getPrice('Weird Corpse'), null)
  await cleanup()
})

// I2: a backed-up background queue (the job does NOT run right away). Without
// the inFlight guard the next tick would query the same not-yet-fresh name again.
test('backed-up queue: the same name is NOT queried twice (inFlight guard)', async () => {
  const { s, cleanup } = await store()
  const trade = fakeTrade({ 'Forest Tiger': [{ priceAmount: 5, priceCurrency: 'chaos' }] })
  // Deferred queue: collects jobs and only runs them on demand (fire-and-forget
  // as far as enqueueBackground can tell — just like the real three-stage queue).
  const pending = []
  const enqueueBackground = fn => { pending.push(fn); return Promise.resolve() }
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Forest Tiger'],
    chaosPerDivine: () => 200, enqueueBackground, budgetPerHour: 25, log: silent
  })

  await pricer.tickOnce() // enqueued but NOT executed (the job sits in pending)
  await pricer.tickOnce() // 2nd tick: the name is inFlight -> must NOT enqueue again
  await pricer.tickOnce()
  assert.equal(pending.length, 1, 'exactly ONE job despite several ticks')
  assert.equal(trade.queried.length, 0, 'no real query yet — the job never ran')

  // Run the job now -> store written, inFlight released.
  await pending[0]()
  assert.equal(trade.queried.length, 1)
  assert.equal(s.getPrice('Forest Tiger'), 5)

  // After the store write the name is fresh -> a further tick asks for nothing.
  await pricer.tickOnce()
  assert.equal(pending.length, 1)
  await cleanup()
})

test('inFlight is released on failure too (finally)', async () => {
  const { s, cleanup } = await store()
  let attempts = 0
  const trade = {
    queried: [],
    isCircuitOpen: () => false,
    async searchListings (name) {
      trade.queried.push(name)
      attempts++
      if (attempts === 1) throw new Error('boom') // 1st attempt fails (nothing cached)
      return [{ priceAmount: 9, priceCurrency: 'chaos' }]
    }
  }
  const pending = []
  const enqueueBackground = fn => { pending.push(fn); return Promise.resolve() }
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Forest Tiger'],
    chaosPerDivine: () => 200, enqueueBackground, log: silent
  })
  await pricer.tickOnce()
  await pending[0]() // fails -> inFlight must be released anyway
  assert.equal(s.get('Forest Tiger'), null) // nothing cached
  await pricer.tickOnce() // name eligible again -> enqueued once more
  assert.equal(pending.length, 2)
  await pending[1]()
  assert.equal(s.getPrice('Forest Tiger'), 9)
  await cleanup()
})

// H4: a missing/invalid C:D means divine listings are NOT normalisable and get
// dropped (NO 1:1 fallback that would book 1 divine as 1 chaos).
test('no C:D (0/undefined) -> the divine listing is dropped, not booked as 1c', async () => {
  const { s, cleanup } = await store()
  // A single divine listing. With no usable C:D it cannot be normalised -> null.
  // The old fallback (return 1) booked 1*1 = 1c instead — underpriced by ~1150x.
  const trade = fakeTrade({ 'Forest Tiger': [{ priceAmount: 1, priceCurrency: 'divine' }] })
  const q = immediateQueue()
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Forest Tiger'],
    chaosPerDivine: () => 0, // no usable C:D
    enqueueBackground: q.enqueueBackground, log: silent
  })
  await pricer.tickOnce()
  assert.equal(s.getPrice('Forest Tiger'), null) // NOT 1
  await cleanup()
})

test('no C:D: chaos listings still price, only the divine one is dropped', async () => {
  const { s, cleanup } = await store()
  // [4,6] chaos + 1 divine. Without a C:D the divine drops out -> avg([4,6]) = 5.
  const trade = fakeTrade({
    'Forest Tiger': [
      { priceAmount: 4, priceCurrency: 'chaos' },
      { priceAmount: 1, priceCurrency: 'divine' },
      { priceAmount: 6, priceCurrency: 'chaos' }
    ]
  })
  const q = immediateQueue()
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => ['Forest Tiger'],
    chaosPerDivine: () => undefined, // no usable C:D
    enqueueBackground: q.enqueueBackground, log: silent
  })
  await pricer.tickOnce()
  assert.equal(s.getPrice('Forest Tiger'), 5) // divine ignored, no 0/1 dent in the average
  await cleanup()
})

test('the per-hour budget caps how many queries go out', async () => {
  const { s, cleanup } = await store()
  const byName = {}
  const names = []
  for (let i = 0; i < 10; i++) { const n = `Corpse ${i}`; names.push(n); byName[n] = [{ priceAmount: i + 1, priceCurrency: 'chaos' }] }
  const trade = fakeTrade(byName)
  const q = immediateQueue()
  let clock = 1_000_000
  const pricer = createCorpsePricer({
    store: s, tradeClient: trade, league: 'Standard',
    getCorpseNames: () => names,
    chaosPerDivine: () => 200, enqueueBackground: q.enqueueBackground,
    budgetPerHour: 3, now: () => clock, log: silent
  })
  // 5 ticks, but the budget is 3/hour -> only 3 queries inside this window
  for (let i = 0; i < 5; i++) { clock += 1000; await pricer.tickOnce() }
  assert.equal(trade.queried.length, 3)

  // an hour later: the budget window has rolled -> queries allowed again
  clock += HOUR + 1
  await pricer.tickOnce()
  assert.equal(trade.queried.length, 4)
  await cleanup()
})
