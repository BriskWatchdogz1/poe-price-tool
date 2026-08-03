import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as ninja from './ninja.mjs'

beforeEach(() => ninja.__clearNinjaCaches())

// A 404 fetch impl that counts how often it was actually called.
function counting404 () {
  const state = { calls: 0 }
  const fetchImpl = async () => { state.calls++; return { ok: false, status: 404, json: async () => ({}) } }
  return { state, fetchImpl }
}

test('fetchExchangeOverview: a 404 is asked ONCE, then negative-cached (empty result)', async () => {
  const { state, fetchImpl } = counting404()
  const a = await ninja.fetchExchangeOverview('NegLeague', 'Scarab', { fetchImpl })
  const b = await ninja.fetchExchangeOverview('NegLeague', 'Scarab', { fetchImpl })
  assert.equal(state.calls, 1)                     // second call served from the cache
  assert.equal(a.nameToId.size, 0)                 // empty, but still a usable result
  assert.equal(a.lineById.size, 0)
  assert.equal(b, a)                               // the exact same cached object
})

test('fetchItemOverview: a 404 is asked ONCE, then negative-cached ([])', async () => {
  const { state, fetchImpl } = counting404()
  const a = await ninja.fetchItemOverview('NegLeague', 'Scarab', { fetchImpl })
  await ninja.fetchItemOverview('NegLeague', 'Scarab', { fetchImpl })
  assert.equal(state.calls, 1)
  assert.deepEqual(a, [])
})

test('fetchExchangeOverview: ok -> the positive result is cached too', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return {
      ok: true,
      json: async () => ({
        core: { primary: 'chaos' },
        items: [{ name: 'Divine Orb', id: 'divine' }],
        lines: [{ id: 'divine', primaryValue: 215 }]
      })
    }
  }
  const a = await ninja.fetchExchangeOverview('OkLeague', 'Currency', { fetchImpl })
  await ninja.fetchExchangeOverview('OkLeague', 'Currency', { fetchImpl })
  assert.equal(calls, 1)
  assert.equal(a.nameToId.get('Divine Orb'), 'divine')
  assert.equal(a.lineById.get('divine').primaryValue, 215)
})

test('fetchCurrencyOverview: ok -> name->chaosEquivalent lookup, cached', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return {
      ok: true,
      json: async () => ({
        lines: [
          { currencyTypeName: 'Divine Orb', chaosEquivalent: 1132.5 },
          { currencyTypeName: 'Exalted Orb', chaosEquivalent: 12.3 },
          { currencyTypeName: 'Broken', chaosEquivalent: 'nope' } // invalid -> dropped
        ]
      })
    }
  }
  const a = await ninja.fetchCurrencyOverview('OkLeague', 'Currency', { fetchImpl })
  await ninja.fetchCurrencyOverview('OkLeague', 'Currency', { fetchImpl })
  assert.equal(calls, 1) // 2nd call served from the cache
  assert.equal(a.byName.get('Divine Orb'), 1132.5)
  assert.equal(a.byName.get('Exalted Orb'), 12.3)
  assert.equal(a.byName.has('Broken'), false)
})

test('fetchCurrencyOverview: a 404 is asked ONCE, then negative-cached (empty map)', async () => {
  const { state, fetchImpl } = counting404()
  const a = await ninja.fetchCurrencyOverview('NegLeague', 'Fragment', { fetchImpl })
  await ninja.fetchCurrencyOverview('NegLeague', 'Fragment', { fetchImpl })
  assert.equal(state.calls, 1)
  assert.equal(a.byName.size, 0)
})

test('ninja.mjs: side-effect-free import, complete export surface', () => {
  assert.equal(typeof ninja.fetchItemOverview, 'function')
  assert.equal(typeof ninja.fetchExchangeOverview, 'function')
  assert.equal(typeof ninja.fetchCurrencyOverview, 'function')
  assert.equal(typeof ninja.fetchCurrencyExchange, 'function')
  assert.equal(typeof ninja.ninjaTypeFor, 'function')
  assert.equal(ninja.round1(1.26), 1.3)
  assert.deepEqual(ninja.normSpark([null, 1, 2]), [0, 1, 2])
  assert.equal(ninja.ninjaTypeFor({ category: 'Helmet' }), 'UniqueArmour')
  assert.equal(ninja.ninjaTypeFor({ category: 'Two-Handed Axe' }), 'UniqueWeapon')
  assert.equal(ninja.ninjaTypeFor({ category: 'Currency' }), null)
  assert.equal(ninja.NINJA_MIN_MS, 15 * 60 * 1000)
})
