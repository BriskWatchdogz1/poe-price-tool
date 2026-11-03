// The base-names CLI (base-names-gen.mjs): its downloads, with fetch injected so
// the tests never touch the network. The transform itself is covered through
// the data refresher (data-refresher.test.mjs) and networth/base-names.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateBaseNames, checkFaustusCoverage, URLS } from './base-names-gen.mjs'
import { AGENT_BASE } from './version.mjs'

// Any request that misses the injected double fails the test instead of going out.
const noNetwork = t => t.mock.method(globalThis, 'fetch', async url => { throw new Error(`no network in this test: ${url}`) })

const WANT_UA = `${AGENT_BASE} (base-names generator, personal LAN tool)`
const BASE_ITEMS = {
  'Metadata/Items/Currency/CurrencyRerollRare': { name: 'Chaos Orb', release_state: 'released' }
}

test('both base_items downloads name the tool, its version and its purpose', async t => {
  noNetwork(t)
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  const seen = []
  // The fork answers 503, so the fallback is asked too.
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url, headers: opts.headers || {} })
    if (url === URLS.baseItems) return { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) }
    return { ok: true, status: 200, statusText: 'OK', json: async () => BASE_ITEMS }
  }
  const names = await generateBaseNames({ fetchImpl })
  assert.deepEqual(names, { 'Metadata/Items/Currency/CurrencyRerollRare': 'Chaos Orb' })
  assert.deepEqual(seen.map(s => s.url), [URLS.baseItems, URLS.baseItemsFallback])
  for (const s of seen) assert.equal(s.headers['User-Agent'], WANT_UA)
})

test('the coverage check against the Currency Exchange names the tool, its version and its purpose', async t => {
  noNetwork(t)
  const seen = []
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url, headers: opts.headers || {} })
    return {
      ok: true,
      status: 200,
      json: async () => ({ next_change_id: 0, markets: [{ market_pair: ['Metadata/Items/Currency/CurrencyRerollRare', 'x'] }] })
    }
  }
  const cov = await checkFaustusCoverage({ 'Metadata/Items/Currency/CurrencyRerollRare': 'Chaos Orb' }, { hours: 1, now: 7200 * 1000, fetchImpl })
  assert.deepEqual(cov, { total: 2, missing: ['x'] })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers['User-Agent'], WANT_UA)
  assert.equal(seen[0].headers.Accept, 'application/json')
})
