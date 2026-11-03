import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as ninja from './ninja.mjs'
import { AGENT_BASE } from './version.mjs'

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

// ---------------------------------------------------------------------------
// B29: failures are reported, wait NINJA_MIN_MS, keep the last good answer —
// and that answer is served only up to maxAgeMs.
// ---------------------------------------------------------------------------
const MIN = 60 * 1000
const HOUR = 60 * MIN

/** A clock, an outcome recorder and a log recorder wired into ninja.mjs. */
function rig (extra = {}) {
  const clock = { t: 10_000_000 }
  const outcomes = []
  const lines = []
  ninja.configureNinja({
    now: () => clock.t,
    onOutcome: (src, o) => outcomes.push([src, o]),
    log: { warn: (...a) => lines.push(a.join(' ')) },
    ...extra
  })
  return { clock, outcomes, lines }
}
/** A fetch stub that answers from a queue of responses (or throws an Error). */
function scripted (answers) {
  const state = { calls: 0 }
  const fetchImpl = async () => {
    const a = answers[Math.min(state.calls, answers.length - 1)]
    state.calls++
    if (a instanceof Error) throw a
    return a
  }
  return { state, fetchImpl }
}
const okJson = body => ({ ok: true, status: 200, json: async () => body })
const status = s => ({ ok: false, status: s, json: async () => ({}) })
const exchangeBody = (lines = [{ id: 'divine', primaryValue: 215 }], items = [{ name: 'Divine Orb', id: 'divine' }]) =>
  ({ core: { primary: 'chaos' }, lines, items })

test('fetchCurrencyExchange: a 503 keeps the last good answer and its fetchedAt, and is not asked again inside NINJA_MIN_MS', async () => {
  const { clock } = rig()
  const t0 = clock.t
  const { state, fetchImpl } = scripted([okJson(exchangeBody()), status(503)])
  const first = await ninja.fetchCurrencyExchange('L', { fetchImpl })
  assert.equal(first.fetchedAt, t0)
  clock.t = t0 + 16 * MIN
  const second = await ninja.fetchCurrencyExchange('L', { fetchImpl })
  assert.equal(state.calls, 2)
  assert.deepEqual(second.lines, first.lines)
  assert.equal(second.fetchedAt, t0, 'the old answer must keep its own time, not the time of the failed attempt')
  clock.t = t0 + 17 * MIN
  await ninja.fetchCurrencyExchange('L', { fetchImpl })
  assert.equal(state.calls, 2, 'a failure waits NINJA_MIN_MS like a success')
})

test('fetchExchangeOverview: a 503 no longer replaces good data with an empty map', async () => {
  const { clock } = rig()
  const { fetchImpl } = scripted([okJson(exchangeBody()), status(503)])
  await ninja.fetchExchangeOverview('L', 'Currency', { fetchImpl })
  clock.t += 16 * MIN
  const d = await ninja.fetchExchangeOverview('L', 'Currency', { fetchImpl })
  assert.equal(d.nameToId.has('Divine Orb'), true)
})

test('a network error is reported as unreachable and not re-asked inside NINJA_MIN_MS', async () => {
  const { clock, outcomes } = rig()
  const { state, fetchImpl } = scripted([new Error('ECONNREFUSED')])
  const a = await ninja.fetchExchangeOverview('L', 'Scarab', { fetchImpl })
  assert.equal(a, null)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0][0], 'ninja-overview')
  assert.equal(outcomes[0][1].ok, false)
  assert.equal(outcomes[0][1].kind, 'unreachable')
  assert.match(outcomes[0][1].reason, /network error/)
  clock.t += 1 * MIN
  const b = await ninja.fetchExchangeOverview('L', 'Scarab', { fetchImpl })
  assert.equal(state.calls, 1)
  assert.equal(b, null)
})

test('an answer older than maxAgeMs is not served after a failure', async () => {
  const { clock } = rig({ maxAgeMs: HOUR })
  const item = scripted([okJson({ lines: [{ name: 'X', chaosValue: 5 }] }), status(503)])
  const cx = scripted([okJson(exchangeBody()), status(503)])
  assert.equal((await ninja.fetchItemOverview('L', 'UniqueArmour', { fetchImpl: item.fetchImpl })).length, 1)
  assert.ok(await ninja.fetchCurrencyExchange('L', { fetchImpl: cx.fetchImpl }))
  clock.t += 2 * HOUR
  assert.equal(await ninja.fetchItemOverview('L', 'UniqueArmour', { fetchImpl: item.fetchImpl }), null)
  assert.equal(await ninja.fetchCurrencyExchange('L', { fetchImpl: cx.fetchImpl }), null)
})

test('a 404 is still negative-cached empty and reported as rejected; an ok answer with no lines is reported as rejected', async () => {
  const { outcomes } = rig()
  const { state, fetchImpl } = counting404()
  const a = await ninja.fetchItemOverview('L', 'Retired', { fetchImpl })
  await ninja.fetchItemOverview('L', 'Retired', { fetchImpl })
  assert.deepEqual(a, [])
  assert.equal(state.calls, 1)
  assert.deepEqual(outcomes[0], ['ninja-overview', { ok: false, kind: 'rejected', reason: 'HTTP 404', at: outcomes[0][1].at }])

  const empty = scripted([okJson({ core: { primary: 'chaos' }, lines: [] })])
  await ninja.fetchCurrencyExchange('Fresh', { fetchImpl: empty.fetchImpl })
  await ninja.fetchCurrencyExchange('Fresh', { fetchImpl: empty.fetchImpl })
  assert.equal(empty.state.calls, 1, 'the empty answer is cached like before')
  const last = outcomes.at(-1)
  assert.equal(last[0], 'ninja-cd')
  assert.equal(last[1].kind, 'rejected')
  assert.match(last[1].reason, /no prices/)
})

test('outcomes are reported per family: ninja-cd for the currency exchange, ninja-overview for the other three', async () => {
  const { outcomes } = rig()
  await ninja.fetchCurrencyExchange('L', { fetchImpl: scripted([okJson(exchangeBody())]).fetchImpl })
  await ninja.fetchExchangeOverview('L', 'Scarab', { fetchImpl: scripted([okJson(exchangeBody())]).fetchImpl })
  await ninja.fetchCurrencyOverview('L', 'Currency', {
    fetchImpl: scripted([okJson({ lines: [{ currencyTypeName: 'Divine Orb', chaosEquivalent: 200 }] })]).fetchImpl
  })
  await ninja.fetchItemOverview('L', 'UniqueArmour', { fetchImpl: scripted([okJson({ lines: [{ name: 'X' }] })]).fetchImpl })
  assert.deepEqual(outcomes.map(o => o[0]), ['ninja-cd', 'ninja-overview', 'ninja-overview', 'ninja-overview'])
  assert.ok(outcomes.every(o => o[1].ok === true))
})

test('fetchItemOverview: an ok answer without lines[] is an unexpected answer, not an empty success', async () => {
  const { outcomes } = rig()
  const r = await ninja.fetchItemOverview('L', 'UniqueArmour', { fetchImpl: scripted([okJson({ nope: 1 })]).fetchImpl })
  assert.deepEqual(r, [])
  assert.equal(outcomes[0][1].kind, 'rejected')
  assert.match(outcomes[0][1].reason, /unexpected answer \(HTTP 200\)/)
})

test('repeated network errors on one key log one line, not one per call', async () => {
  const { clock, lines } = rig()
  const { fetchImpl } = scripted([new Error('ETIMEDOUT')])
  for (let i = 0; i < 4; i++) {
    await ninja.fetchExchangeOverview('L', 'Scarab', { fetchImpl })
    clock.t += 16 * MIN
  }
  assert.equal(lines.length, 1)
  assert.match(lines[0], /failing: network error/)
  await ninja.fetchExchangeOverview('L', 'Scarab', { fetchImpl })
  assert.equal(lines.length, 2)
  assert.match(lines[1], /still failing/)
  ninja.configureNinja({}) // keep the recorder from leaking into later cases
})

test('a 5xx is unreachable, any other non-ok answer is rejected; recovery is logged once', async () => {
  const { clock, outcomes, lines } = rig()
  const { fetchImpl } = scripted([status(502), status(429), status(403), okJson(exchangeBody())])
  for (let i = 0; i < 4; i++) {
    await ninja.fetchExchangeOverview('L', 'Oil', { fetchImpl })
    clock.t += 16 * MIN
  }
  assert.deepEqual(outcomes.map(o => o[1].kind ?? 'ok'), ['unreachable', 'unreachable', 'rejected', 'ok'])
  assert.match(lines.at(-1), /recovered after/)
})

test('configureNinja and the new defaults are exported', () => {
  assert.equal(typeof ninja.configureNinja, 'function')
  assert.equal(ninja.NINJA_MAX_AGE_DEFAULT_MS, 86400000)
  assert.equal(ninja.NINJA_MAP_TTL_DEFAULT_MS, 3600000)
  assert.equal(ninja.NINJA_FAIL_LOG_DEFAULT_MS, 3600000)
})

test('the exchange rounding keeps sub-chaos rates', async () => {
  assert.equal(ninja.roundExchange(0.018), 0.018)
  assert.equal(ninja.roundExchange(0.01849), 0.0185, 'three significant digits below 1 c')
  assert.equal(ninja.roundExchange(0.1234), 0.123)
  // Three decimals turned a rate under 0.0005 c into 0 again, and 0 is no
  // valid price: every page reconnect re-queued the card as a trade search.
  assert.equal(ninja.roundExchange(0.0004), 0.0004)
  assert.ok(ninja.roundExchange(0.00001234) > 0)
  assert.equal(ninja.roundExchange(0.9996), 1)
  assert.equal(ninja.roundExchange(0.5), 0.5)
  assert.equal(ninja.roundExchange(212.34), 212.3)
  assert.equal(ninja.roundExchange(1), 1)
  // One rounding for every place an exchange rate becomes a price: the card's
  // headline (withExchangeMain), the empty-bulk branch of pump() and the early
  // answer for the game. round1 flattened a 0.018 c rate to 0 in that branch.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /round1\(faustusChaos\)/, 'the empty-bulk branch still rounds with round1')
  assert.doesNotMatch(src, /chaos < 1 \? Math\.round\(chaos \* 1000\)/, 'withExchangeMain still has its own copy')
  assert.match(src, /roundExchange/)
})

// The time limit's timer is unref'd (it must not keep the server alive), and a
// request that never answers holds nothing else open. In a server something
// always does; in a test file nothing does, and Node 22's test runner then
// sees an empty event loop with the test still pending and fails it ("Promise
// resolution is still pending but the event loop has already resolved"),
// together with every test after it. Node 24 waited. A ref'd timer for the
// length of such a test keeps the loop running on both.
const keepAlive = () => { const t = setInterval(() => {}, 1000); return () => clearInterval(t) }

// A burst of lookups of one cold key (buyer whispers, a stash tab) while
// poe.ninja does not answer: before, each of them sent its own request.
test('concurrent lookups of one cold key share ONE request, and a hanging one times out', async () => {
  ninja.configureNinja({ fetchTimeoutMs: 30 })
  const release = keepAlive()
  try {
    const urls = []
    const fetchImpl = url => { urls.push(url); return new Promise(() => {}) } // never answers, ignores the signal
    const all = await Promise.all(Array.from({ length: 5 }, () =>
      ninja.fetchItemOverview('HangLeague', 'UniqueAccessory', { fetchImpl })))
    assert.equal(urls.length, 1, 'one request for five callers')
    assert.deepEqual(all, [null, null, null, null, null], 'a timeout is a failed attempt: nothing to serve yet')
    // The failed attempt waits NINJA_MIN_MS like an answer: no second request.
    await ninja.fetchItemOverview('HangLeague', 'UniqueAccessory', { fetchImpl })
    assert.equal(urls.length, 1)
  } finally {
    release()
    ninja.configureNinja({ fetchTimeoutMs: ninja.NINJA_FETCH_TIMEOUT_DEFAULT_MS })
  }
})

test('the timeout aborts the request through its signal', async () => {
  ninja.configureNinja({ fetchTimeoutMs: 20 })
  const release = keepAlive()
  try {
    let signal = null
    const fetchImpl = (url, init) => { signal = init.signal; return new Promise(() => {}) }
    await ninja.fetchExchangeOverview('AbortLeague', 'Scarab', { fetchImpl })
    assert.equal(signal?.aborted, true)
    assert.equal(ninja.NINJA_FETCH_TIMEOUT_DEFAULT_MS, 15000)
  } finally {
    release()
    ninja.configureNinja({ fetchTimeoutMs: ninja.NINJA_FETCH_TIMEOUT_DEFAULT_MS })
  }
})

test('a finished request lets the next cold lookup of that key ask again', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: false, status: 404, json: async () => ({}) } }
  await Promise.all([ninja.fetchItemOverview('SeqLeague', 'A', { fetchImpl }), ninja.fetchItemOverview('SeqLeague', 'A', { fetchImpl })])
  assert.equal(calls, 1)
  ninja.__clearNinjaCaches()
  await ninja.fetchItemOverview('SeqLeague', 'A', { fetchImpl })
  assert.equal(calls, 2, 'nothing stays joined after the request ended')
})

test('every poe.ninja request names the tool, its version and its purpose', async () => {
  const seen = []
  const fetchImpl = async (url, opts) => { seen.push(opts.headers); return { ok: false, status: 404, json: async () => ({}) } }
  await ninja.fetchExchangeOverview('UaLeague', 'Scarab', { fetchImpl })
  await ninja.fetchItemOverview('UaLeague', 'Scarab', { fetchImpl })
  assert.equal(seen.length, 2)
  for (const h of seen) assert.equal(h['User-Agent'], `${AGENT_BASE} (personal LAN tool)`)
  assert.equal(ninja.NINJA_UA, `${AGENT_BASE} (personal LAN tool)`)
})
