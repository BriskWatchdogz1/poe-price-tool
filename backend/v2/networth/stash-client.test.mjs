// backend/v2/networth/stash-client.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRateLimitHeaders, delayFor, createStashClient } from './stash-client.mjs'

// Small response builder for the mocked fetch.
function res (status, headers = {}, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body
  }
}

test('parseRateLimitHeaders: rules + states + Retry-After', () => {
  const h = new Headers({
    'X-Rate-Limit-Rules': 'Account',
    'X-Rate-Limit-Account': '45:60:60,240:240:900',
    'X-Rate-Limit-Account-State': '12:60:0,30:240:0',
    'Retry-After': '7'
  })
  const p = parseRateLimitHeaders(h)
  assert.deepEqual(p.rules, [
    { rule: 'Account', hits: 45, windowSec: 60, banSec: 60 },
    { rule: 'Account', hits: 240, windowSec: 240, banSec: 900 }
  ])
  assert.deepEqual(p.states[0], { rule: 'Account', hits: 12, windowSec: 60, banSec: 0 })
  assert.equal(p.retryAfterSec, 7)
})

test('parseRateLimitHeaders: no headers -> empty', () => {
  const p = parseRateLimitHeaders(new Headers())
  assert.deepEqual(p, { rules: [], states: [], retryAfterSec: null })
})

test('delayFor: Retry-After wins (N+1 seconds)', () => {
  const p = { rules: [], states: [], retryAfterSec: 7 }
  assert.equal(delayFor(p, { baseMs: 1500 }), 8000)
})

test('delayFor: relaxed state -> baseMs', () => {
  const p = parseRateLimitHeaders(new Headers({
    'X-Rate-Limit-Rules': 'Account',
    'X-Rate-Limit-Account': '45:60:60',
    'X-Rate-Limit-Account-State': '3:60:0'
  }))
  assert.equal(delayFor(p, { baseMs: 1500 }), 1500)
})

test('delayFor: window almost full (hits >= limit-1) -> wait out the whole window', () => {
  const p = parseRateLimitHeaders(new Headers({
    'X-Rate-Limit-Rules': 'Account',
    'X-Rate-Limit-Account': '45:60:60',
    'X-Rate-Limit-Account-State': '44:60:0'
  }))
  assert.equal(delayFor(p, { baseMs: 1500 }), 60000)
})

test('delayFor: close to the limit (>=80%) -> 4x baseMs', () => {
  const p = parseRateLimitHeaders(new Headers({
    'X-Rate-Limit-Rules': 'Account',
    'X-Rate-Limit-Account': '45:60:60',
    'X-Rate-Limit-Account-State': '36:60:0'
  }))
  assert.equal(delayFor(p, { baseMs: 1500 }), 6000)
})

test('fetchAllTabs: sequential, correct URLs (tabs=1 then tabIndex=N&tabs=0), Cookie header', async () => {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, cookie: opts.headers.Cookie })
    if (url.includes('tabs=1')) {
      return res(200, {}, { numTabs: 2, tabs: [{ n: 'one', i: 0, type: 'NormalStash' }, { n: 'uniq', i: 1, type: 'UniqueStash' }] })
    }
    const idx = /tabIndex=(\d+)/.exec(url)[1]
    return res(200, {}, { items: [{ typeLine: `item-of-tab-${idx}` }] })
  }
  const c = createStashClient({ accountName: 'a&b', poesessid: 'S', league: 'Standard', fetchImpl, baseDelayMs: 1 })
  const all = await c.fetchAllTabs()
  assert.equal(calls.length, 3)
  assert.match(calls[0].url, /accountName=a%26b/)          // URL-encoded
  assert.match(calls[0].url, /league=Standard/)
  assert.match(calls[0].url, /tabs=1/)
  assert.match(calls[1].url, /tabIndex=0&/); assert.match(calls[1].url, /tabs=0/)
  assert.match(calls[2].url, /tabIndex=1&/)
  assert.equal(calls[0].cookie, 'POESESSID=S')
  assert.equal(all.length, 2)
  assert.deepEqual(all[0].tab, { index: 0, name: 'one', type: 'NormalStash', id: null })
  // UniqueStash WITHOUT an id -> stays on the old endpoint (no collection-tab path)
  assert.equal(all[1].items[0].typeLine, 'item-of-tab-1')
})

test('429 -> wait out Retry-After and repeat the same request', async () => {
  let n = 0
  const fetchImpl = async () => {
    n++
    if (n === 1) return res(429, { 'Retry-After': '0' }, {})
    return res(200, {}, { tabs: [] })
  }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1 })
  const tabs = await c.listTabs()
  assert.equal(n, 2)
  assert.deepEqual(tabs, [])
})

test('401/403 -> immediate abort with a clear message that does NOT carry the cookie value', async () => {
  const fetchImpl = async () => res(403, {}, {})
  const c = createStashClient({ accountName: 'a', poesessid: 'SECRET', league: 'L', fetchImpl, baseDelayMs: 1 })
  await assert.rejects(() => c.listTabs(), err => {
    assert.match(err.message, /403|forbidden|accountName/i)
    assert.ok(!err.message.includes('SECRET'), 'the cookie value must never appear in the message')
    assert.equal(err.kind, 'auth')
    return true
  })
})

test('401 -> abort, the message names POESESSID (auth)', async () => {
  const fetchImpl = async () => res(401, {}, {})
  const c = createStashClient({ accountName: 'a', poesessid: 'SECRET', league: 'L', fetchImpl, baseDelayMs: 1 })
  await assert.rejects(() => c.listTabs(), err => {
    assert.match(err.message, /POESESSID|401/i)
    assert.ok(!err.message.includes('SECRET'))
    assert.equal(err.kind, 'auth')
    return true
  })
})

test('other 4xx (not 429) -> abort IMMEDIATELY without a retry (kind=rejected)', async () => {
  let n = 0
  const fetchImpl = async () => { n++; return res(400, {}, {}) }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1, maxRetries: 10 })
  await assert.rejects(() => c.listTabs(), err => {
    assert.equal(err.kind, 'rejected')
    return true
  })
  assert.equal(n, 1, 'no retry on 400/404/422/...')
})

test('fetchAllTabs: 3 consecutive failing TABS -> abort (ban protection)', async () => {
  const fetchImpl = async url => {
    if (url.includes('tabs=1')) {
      return res(200, {}, {
        numTabs: 3,
        tabs: [{ n: 'bad-1', i: 0, type: 'NormalStash' }, { n: 'bad-2', i: 1, type: 'NormalStash' }, { n: 'bad-3', i: 2, type: 'NormalStash' }]
      })
    }
    return res(400, {}, {})
  }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1 })
  await assert.rejects(() => c.fetchAllTabs(), /3 tabs rejected in a row/)
})

test('fetchAllTabs: a single 4xx tab between good ones -> the scan runs through, the bad tab is missing from the result', async () => {
  const fetchImpl = async url => {
    if (url.includes('tabs=1')) {
      return res(200, {}, {
        numTabs: 3,
        tabs: [{ n: 'good-1', i: 0, type: 'NormalStash' }, { n: 'folder-bad', i: 1, type: 'Folder' }, { n: 'good-2', i: 2, type: 'NormalStash' }]
      })
    }
    const idx = /tabIndex=(\d+)/.exec(url)[1]
    if (idx === '1') return res(404, {}, {})
    return res(200, {}, { items: [{ typeLine: `item-of-tab-${idx}` }] })
  }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1 })
  const all = await c.fetchAllTabs()
  assert.equal(all.length, 2, 'only the 2 successful tabs')
  assert.deepEqual(all.map(x => x.tab.name), ['good-1', 'good-2'])
})

test('fetchAllTabs: failure, then success -> consecutiveTabFails resets (no abort)', async () => {
  const fetchImpl = async url => {
    if (url.includes('tabs=1')) {
      return res(200, {}, {
        numTabs: 4,
        tabs: [
          { n: 'bad-1', i: 0, type: 'Folder' },
          { n: 'bad-2', i: 1, type: 'Folder' },
          { n: 'good', i: 2, type: 'NormalStash' },
          { n: 'bad-3', i: 3, type: 'Folder' }
        ]
      })
    }
    const idx = /tabIndex=(\d+)/.exec(url)[1]
    if (idx === '2') return res(200, {}, { items: [{ typeLine: 'ok' }] })
    return res(400, {}, {})
  }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1 })
  const all = await c.fetchAllTabs()
  assert.equal(all.length, 1)
  assert.equal(all[0].tab.name, 'good')
})

test('maxRetries on a permanent 429 -> gives up', async () => {
  const fetchImpl = async () => res(429, { 'Retry-After': '0' }, {})
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1, maxRetries: 2 })
  await assert.rejects(() => c.listTabs(), err => {
    assert.match(err.message, /rate-limit/i)
    assert.equal(err.kind, 'ratelimit')
    return true
  })
})

test('network error / timeout -> bounded retries, then kind=server (never hangs)', async () => {
  let n = 0
  const fetchImpl = async () => { n++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1, maxRetries: 3 })
  await assert.rejects(() => c.listTabs(), err => {
    assert.equal(err.kind, 'server')
    assert.match(err.message, /network\/timeout/i)
    return true
  })
  // Timeout/network path is capped by TIMEOUT_MAX_RETRIES (2), NOT maxRetries,
  // so a stalled tab gives up fast: 1 initial + 2 retries = 3 attempts.
  assert.equal(n, 3, '1 initial + 2 retries (fast give-up)')
})

test('transient network error then success -> recovers', async () => {
  let n = 0
  const fetchImpl = async () => {
    n++
    if (n === 1) throw new Error('ECONNRESET')
    return res(200, {}, { tabs: [] })
  }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1 })
  const tabs = await c.listTabs()
  assert.equal(n, 2)
  assert.deepEqual(tabs, [])
})

test('response BODY read aborts/hangs -> transient retry, then kind=server (the Ringtrash bug)', async () => {
  // fetch() resolves (headers OK), but r.json() rejects as if the body read
  // was aborted by our timeout. Previously this was OUTSIDE the timeout/try and
  // would hang the whole scan; now it must be retried then given up as server.
  let n = 0
  const fetchImpl = async () => {
    n++
    return {
      status: 200, ok: true, headers: new Headers(),
      json: async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) }
    }
  }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1, maxRetries: 2 })
  await assert.rejects(() => c.listTabs(), err => {
    assert.equal(err.kind, 'server')
    assert.match(err.message, /network\/timeout/i)
    return true
  })
  assert.equal(n, 3, '1 initial + 2 retries — body read is bounded, not hung')
})

test('a never-resolving fetch that IGNORES abort is still force-timed-out (hard timeout)', async () => {
  let n = 0
  // Simulates the real bug: undici keeps awaiting a stalled socket, abort has no
  // effect -> the fetch promise never settles. Old code hung forever here.
  const fetchImpl = () => { n++; return new Promise(() => {}) }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1, requestTimeoutMs: 25 })
  await assert.rejects(() => c.listTabs(), err => {
    assert.equal(err.kind, 'server')
    assert.match(err.message, /timed out|network\/timeout/i)
    return true
  })
  assert.equal(n, 3, 'raced against the timeout + retried, never hung')
})

// --- collection tabs (UniqueStash/MapStash) ---------------------------------
// The old endpoint ALWAYS returns items=[] for them (measured). Their items sit
// in sub-folders that only the newer endpoint knows about:
//   /api/stash/<league>/<tabId>            -> stash.children[]
//   /api/stash/<league>/<tabId>/<childId>  -> stash.items[]
test('collection tab: items come from the sub-folders, sequentially, loose parent items included', async () => {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push(url)
    if (url.includes('/api/stash/')) {
      if (/\/api\/stash\/L\/PARENT$/.test(url)) {
        return res(200, {}, { stash: { items: [{ typeLine: 'loose' }], children: [{ id: 'C1' }, { id: 'C2' }] } })
      }
      const child = /\/PARENT\/(C\d)$/.exec(url)[1]
      return res(200, {}, { stash: { items: [{ typeLine: `item-${child}` }] } })
    }
    throw new Error(`unexpected call to the OLD endpoint: ${url}`)
  }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1 })
  const items = await c.fetchTab(16, { index: 16, name: 'UNIQUE', type: 'UniqueStash', id: 'PARENT' })
  assert.deepEqual(items.map(i => i.typeLine), ['loose', 'item-C1', 'item-C2'])
  assert.equal(calls.length, 3, 'parent tab + one call per sub-folder')
  assert.equal(calls[0].endsWith('/api/stash/L/PARENT'), true)
})

test('collection tab without an id -> old endpoint (no guessing against the new API)', async () => {
  const calls = []
  const fetchImpl = async url => { calls.push(url); return res(200, {}, { items: [] }) }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1 })
  await c.fetchTab(16, { index: 16, name: 'UNIQUE', type: 'UniqueStash', id: null })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /character-window\/get-stash-items/)
})

test('collection tab: a 404 from the new endpoint degrades to empty, a ratelimit propagates', async () => {
  const c404 = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1,
    fetchImpl: async () => res(404, {}, { error: 'nope' }) })
  assert.deepEqual(await c404.fetchTab(16, { index: 16, name: 'U', type: 'UniqueStash', id: 'P' }), [],
    'unexpected response -> tab empty, scan keeps running')

  const c429 = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, maxRetries: 0,
    fetchImpl: async () => res(429, { 'retry-after': '1' }, {}) })
  await assert.rejects(
    () => c429.fetchTab(16, { index: 16, name: 'U', type: 'UniqueStash', id: 'P' }),
    e => e.kind === 'ratelimit', 'the rate limit must NOT be swallowed')
})
