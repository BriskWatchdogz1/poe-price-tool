// faustus-refresher.mjs with mocked deps — NO real CDN request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFaustusStore } from './faustus-store.mjs'
import { createFaustusRefresher } from './faustus-refresher.mjs'

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
