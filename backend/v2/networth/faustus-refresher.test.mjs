// faustus-refresher.mjs with mocked deps — NO real CDN request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaustusStore } from './faustus-store.mjs'
import { createFaustusRefresher } from './faustus-refresher.mjs'
import { failure } from '../check-failure.mjs'

const silentLog = { warn () {}, error () {}, log () {} }

async function freshStore () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-faustus-refresher-'))
  const s = createFaustusStore(join(dir, 'faustus.json'))
  await s.load()
  return { s, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('tickOnce: pricer output lands in the store', async () => {
  const { s, cleanup } = await freshStore()
  const pricer = { chaosByName: async () => new Map([['Chaos Orb', 1], ['Divine Orb', 180]]) }
  const r = createFaustusRefresher({ league: 'Standard', store: s, pricer, log: silentLog })
  await r.tickOnce()
  assert.deepEqual(s.allPrices(), { 'Chaos Orb': 1, 'Divine Orb': 180 })
  assert.equal(s.league(), 'Standard')
  await cleanup()
})

test('tickOnce: pricer error -> the previous state survives', async () => {
  const { s, cleanup } = await freshStore()
  await s.setPrices('Standard', { 'Chaos Orb': 1 })
  const pricer = { chaosByName: async () => { throw new Error('CDN down') } }
  const r = createFaustusRefresher({ league: 'Standard', store: s, pricer, log: silentLog })
  await r.tickOnce()
  assert.deepEqual(s.allPrices(), { 'Chaos Orb': 1 }) // unchanged
  await cleanup()
})

test('tickOnce: onRefreshed is called with the fresh map', async () => {
  const { s, cleanup } = await freshStore()
  const pricer = { chaosByName: async () => new Map([['Chaos Orb', 1]]) }
  let seen = null
  const r = createFaustusRefresher({ league: 'Standard', store: s, pricer, onRefreshed: m => { seen = m }, log: silentLog })
  await r.tickOnce()
  assert.equal(seen.get('Chaos Orb'), 1)
  await cleanup()
})

test('tickOnce: overlap guard — a second concurrent tick does not run in parallel', async () => {
  const { s, cleanup } = await freshStore()
  let calls = 0
  let resolveFirst
  const gate = new Promise(res => { resolveFirst = res })
  const pricer = {
    chaosByName: async () => {
      calls++
      if (calls === 1) await gate
      return new Map([['Chaos Orb', calls]])
    }
  }
  const r = createFaustusRefresher({ league: 'Standard', store: s, pricer, log: silentLog })
  const p1 = r.tickOnce() // blocks on the gate
  const p2 = r.tickOnce() // busy -> immediate no-op
  await p2
  assert.equal(calls, 1) // the second call did NOT kick off the pricer again
  resolveFirst()
  await p1
  assert.deepEqual(s.allPrices(), { 'Chaos Orb': 1 })
  await cleanup()
})

test('start/stop: the interval ticks and tears itself down cleanly (unref, no dangling timer)', async () => {
  const { s, cleanup } = await freshStore()
  let calls = 0
  const pricer = { chaosByName: async () => { calls++; return new Map([['Chaos Orb', calls]]) } }
  const r = createFaustusRefresher({ league: 'Standard', store: s, pricer, intervalMs: 5, log: silentLog })
  r.start()
  await new Promise(res => setTimeout(res, 30))
  r.stop()
  assert.ok(calls >= 1)
  await cleanup()
})

test('tickOnce: detail.at is carried into the store, per item', async () => {
  // The refresher is the only place the observation hour can be persisted —
  // the pricer holds it for one call and the store cannot derive it. A tick
  // that dropped it would leave every price looking equally fresh again.
  const { s, cleanup } = await freshStore()
  const pricer = {
    detailByName: async () => new Map([
      ['Item A', { chaos: 10, at: 9 * 3600 }],
      ['Item B', { chaos: 50, at: 8 * 3600 }],
      ['Chaos Orb', { chaos: 1 }] // no observation behind it -> no hour
    ])
  }
  await createFaustusRefresher({ league: 'Standard', store: s, pricer, log: silentLog }).tickOnce()
  assert.equal(s.getHour('Item A'), 9 * 3600)
  assert.equal(s.getHour('Item B'), 8 * 3600)
  assert.equal(s.getHour('Chaos Orb'), null)
  assert.deepEqual(s.allPrices(), { 'Item A': 10, 'Item B': 50, 'Chaos Orb': 1 })
  await cleanup()
})

test('tickOnce: a pricer with only chaosByName() still works — prices, no hours', async () => {
  const { s, cleanup } = await freshStore()
  const pricer = { chaosByName: async () => new Map([['Item A', 10]]) }
  await createFaustusRefresher({ league: 'Standard', store: s, pricer, log: silentLog }).tickOnce()
  assert.equal(s.getPrice('Item A'), 10)
  assert.equal(s.getHour('Item A'), null, 'unknown age, never a guessed one')
  await cleanup()
})

test('tickOnce: an empty result keeps the previous store, logs a warning and does not call onRefreshed', async () => {
  const { s, cleanup } = await freshStore()
  await s.setPrices('Standard', { 'Chaos Orb': 1 }, 1000)
  const warnings = []
  const log = { warn: m => warnings.push(m), error () {}, log () {} }
  let refreshed = 0
  // No market matched the configured league (typo, or a league without trade yet).
  const pricer = { chaosByName: async () => new Map() }
  const r = createFaustusRefresher({
    league: 'Typo League', store: s, pricer, now: () => 99_000, onRefreshed: () => { refreshed++ }, log
  })
  await r.tickOnce()
  assert.deepEqual(s.allPrices(), { 'Chaos Orb': 1 }) // not replaced by an empty map
  assert.equal(s.league(), 'Standard')
  assert.equal(s.updatedAt(), 1000) // not re-stamped as fresh
  assert.equal(refreshed, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /\[faustus-refresher\] no market matched league=Typo League/)
  assert.match(warnings[0], /keeping the previous store/)
  await cleanup()
})

test('tickOnce: an empty detailByName() result is treated the same way', async () => {
  const { s, cleanup } = await freshStore()
  await s.setPrices('Standard', { 'Chaos Orb': 1 }, 1000)
  const warnings = []
  const pricer = { detailByName: async () => new Map() }
  const r = createFaustusRefresher({
    league: 'Standard', store: s, pricer, log: { warn: m => warnings.push(m), error () {}, log () {} }
  })
  await r.tickOnce()
  assert.deepEqual(s.allPrices(), { 'Chaos Orb': 1 })
  assert.equal(warnings.length, 1)
  await cleanup()
})

// ---------------------------------------------------------------------------
// B29: a failure is reported to the source status, and the first success after
// failures says so in the log.
// ---------------------------------------------------------------------------
test('tickOnce: a thrown refresh calls onFailed with the reason and the error kind', async () => {
  const { s, cleanup } = await freshStore()
  const pricer = { chaosByName: async () => { throw failure('CDN 503', 'unreachable') } }
  const failed = []
  let refreshed = 0
  const r = createFaustusRefresher({
    league: 'Standard', store: s, pricer, log: silentLog,
    onFailed: (reason, kind) => failed.push([reason, kind]),
    onRefreshed: () => { refreshed++ }
  })
  await r.tickOnce()
  assert.deepEqual(failed, [['CDN 503', 'unreachable']])
  assert.equal(refreshed, 0)
  await cleanup()
})

test('tickOnce: no market matched calls onFailed with kind rejected and keeps the store', async () => {
  const { s, cleanup } = await freshStore()
  let setCalls = 0
  const orig = s.setPrices.bind(s)
  s.setPrices = async (...a) => { setCalls++; return orig(...a) }
  const pricer = { detailByName: async () => new Map() }
  const failed = []
  const r = createFaustusRefresher({ league: 'Standard', store: s, pricer, log: silentLog, onFailed: (reason, kind) => failed.push([reason, kind]) })
  await r.tickOnce()
  assert.equal(failed.length, 1)
  assert.match(failed[0][0], /no market matched league=/)
  assert.equal(failed[0][1], 'rejected')
  assert.equal(setCalls, 0)
  await cleanup()
})

test('tickOnce: the first success after failures logs one recovery line', async () => {
  const { s, cleanup } = await freshStore()
  let fail = true
  const pricer = { chaosByName: async () => { if (fail) throw new Error('down'); return new Map([['Chaos Orb', 1]]) } }
  const lines = []
  const log = { warn: l => lines.push(l), error () {}, log () {} }
  let t = 0
  const r = createFaustusRefresher({ league: 'Standard', store: s, pricer, log, now: () => t })
  await r.tickOnce(); t += 3600000
  await r.tickOnce(); t += 3600000
  fail = false
  await r.tickOnce()
  await r.tickOnce()
  const rec = lines.filter(l => /refresh succeeded again/.test(l))
  assert.equal(rec.length, 1)
  assert.match(rec[0], /refresh succeeded again after .* \(2 failed ticks\)/)
  await cleanup()
})

test('tickOnce: the turnover behind each price is persisted, and a price without one has none', async () => {
  // Like `at`, the turnover exists only for the length of one pricer call; the
  // refresher is the one place that can hand it to the store.
  const { s, cleanup } = await freshStore()
  const seen = []
  const orig = s.setPrices.bind(s)
  s.setPrices = async (...a) => { seen.push(a[6]); return orig(...a) }
  const pricer = {
    detailByName: async () => new Map([
      ['Imperial Legacy', { chaos: 4.6, at: 9 * 3600, turnoverC: 55 }],
      ['Chaos Orb', { chaos: 1 }]
    ])
  }
  await createFaustusRefresher({ league: 'Standard', store: s, pricer, log: silentLog }).tickOnce()
  assert.ok(seen[0] instanceof Map, 'the seventh argument is the turnover map')
  assert.deepEqual([...seen[0]], [['Imperial Legacy', 55]])
  assert.equal(s.getTurnover('Imperial Legacy'), 55)
  assert.equal(s.getTurnover('Chaos Orb'), null)
  await cleanup()
})
