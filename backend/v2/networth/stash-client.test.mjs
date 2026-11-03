// backend/v2/networth/stash-client.test.mjs
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseRateLimitHeaders, delayFor, createStashClient, resetRateLimitRuleLog, resetSessionScope } from './stash-client.mjs'
import { createStashPacer, resetStashPacer } from './stash-pacer.mjs'
import { resetSubTabShapeLog } from './subtab-shape.mjs'

// Small response builder for the mocked fetch.
function res (status, headers = {}, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body
  }
}

// The pace derived from GGG's published limits lives at MODULE level (one
// budget per process, because an `Ip` budget belongs to the address — see
// stash-pacer.mjs). That is the point of it, and it means one test's rule set
// would otherwise pace the next test's requests.
// …and the per-policy session-scope baseline is module-level for the same
// reason (one deployment, one address, one set of policies), so it is reset
// alongside it or one test's rule form becomes the next one's transition.
// …and the sub-tab shape line is remembered per PROCESS (subtab-shape.mjs), for
// the same reason: one line per folder tab, not one per walk. Without this
// reset the first test to walk a given tab would be the only one that sees it.
beforeEach(() => { resetStashPacer(); resetSessionScope(); resetSubTabShapeLog() })

// A test that only cares about what is LOGGED must not sit out a derived pace
// of several seconds. Handing the client a sleep that does nothing keeps the
// requests in order and the waiting out of the wall clock.
const nosleep = async () => {}

// The rule set measured on the production deployment, as response headers.
const MEASURED_HEADERS = {
  'X-Rate-Limit-Rules': 'Account,Ip',
  'X-Rate-Limit-Account': '30:60:60,100:1800:600',
  'X-Rate-Limit-Account-State': '1:60:0,1:1800:0',
  'X-Rate-Limit-Ip': '45:60:120,180:1800:600',
  'X-Rate-Limit-Ip-State': '1:60:0,1:1800:0'
}
// …and the set the second endpoint group answers with.
const MEASURED_HEADERS_V2 = {
  'X-Rate-Limit-Rules': 'Account',
  'X-Rate-Limit-Account': '15:10:60,30:300:300',
  'X-Rate-Limit-Account-State': '1:10:0,1:300:0'
}
// The spacing those rules derive at the documented default shares (Ip 0.5,
// Account 0.75): Account 100/1800s is the binding rule, against a window of
// 1800s + its one-minute bucket -> 18.6s, of which this tool takes 0.75.
const DERIVED_MS = 24_800

/**
 * A client whose waiting happens on a clock the test owns: every sleep is
 * recorded and advances that clock instead of the wall clock. The pacer is a
 * private one on the same clock, so nothing here depends on how long the test
 * process actually took.
 */
function pacedClient ({ headers = {}, headersFor = null, body = { tabs: [] }, baseDelayMs = 1500 } = {}) {
  let t = 0
  const waits = []
  const calls = []
  const pacer = createStashPacer({ now: () => t })
  // `make()` is a new client on the SAME pacer — what the server does at the
  // start of every tick.
  const make = () => createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs, pacer,
    sleep: async ms => { waits.push(ms); t += ms },
    log: { log () {}, warn () {} },
    fetchImpl: async url => {
      calls.push(url)
      return res(200, headersFor ? headersFor(url) : headers, typeof body === 'function' ? body(url) : body)
    }
  })
  return { client: make(), make, waits, calls, pacer, advance: ms => { t += ms } }
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
  assert.deepEqual(p, { policy: null, rules: [], states: [], retryAfterSec: null })
})

test('parseRateLimitHeaders: the policy names the budget the set belongs to', () => {
  const p = parseRateLimitHeaders(new Headers({
    'X-Rate-Limit-Policy': ' stash-request-limit ',
    'X-Rate-Limit-Rules': 'Ip',
    'X-Rate-Limit-Ip': '45:60:120'
  }))
  assert.equal(p.policy, 'stash-request-limit', 'trimmed, because a header value may carry padding')
  assert.deepEqual(p.rules, [{ rule: 'Ip', hits: 45, windowSec: 60, banSec: 120 }])
})

test('parseRateLimitHeaders: a blank or absurd policy cannot produce an unbounded key', () => {
  assert.equal(parseRateLimitHeaders(new Headers({ 'X-Rate-Limit-Policy': '   ' })).policy, null,
    'blank is the same as absent — a caller falls back to union semantics rather than keying on an empty budget')
  const long = parseRateLimitHeaders(new Headers({ 'X-Rate-Limit-Policy': 'p'.repeat(500) })).policy
  assert.equal(long.length, 64, 'bounded, so a pathological server cannot grow a caller\'s map keys without limit')
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
  // 60s of window plus its 5s bucket: GGG sums whole buckets, so waiting
  // exactly the window lands inside the one it is still being summed over.
  assert.equal(delayFor(p, { baseMs: 1500 }), 65000)
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

// A 429 is not slept off (Retry-After+1, capped at 90s) and retried up to
// maxRetries times — six requests into a throttle GGG has already declared.
// It costs exactly ONE request, and the wait becomes the caller's cooldown.
test('429 -> propagated at once, exactly ONE request, no client-side retry', async () => {
  let n = 0
  const fetchImpl = async () => { n++; return res(429, { 'Retry-After': '0' }, {}) }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1, maxRetries: 5 })
  await assert.rejects(() => c.listTabs(), err => {
    assert.equal(err.kind, 'ratelimit')
    assert.match(err.message, /429/)
    return true
  })
  assert.equal(n, 1, 'a 429 must cost one request, not six')
})

test('a LONG Retry-After does not become six requests — one request, and the wait rides on the error', async () => {
  let n = 0
  // 20 minutes: longer than the old 90s sleep cap, which is exactly what turned
  // one refusal into up to six requests inside the same declared window.
  const fetchImpl = async () => { n++; return res(429, { 'Retry-After': '1200' }, {}) }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1, maxRetries: 5 })
  await assert.rejects(() => c.listTabs(), err => {
    assert.equal(err.kind, 'ratelimit')
    assert.equal(err.retryAfterSec, 1200, 'the caller needs the wait GGG asked for')
    return true
  })
  assert.equal(n, 1)
})

test('a pacing wait beyond the cap is handed to the caller instead of truncated and sent', async () => {
  // The state counter is at the limit of a 600s window -> delayFor asks for
  // 600s plus the window's bucket. The old code slept 90s of it and sent
  // anyway; now nothing is sent.
  const headers = {
    'X-Rate-Limit-Rules': 'Account',
    'X-Rate-Limit-Account': '45:600:900',
    'X-Rate-Limit-Account-State': '45:600:0'
  }
  let n = 0
  const fetchImpl = async () => { n++; return res(200, headers, { tabs: [] }) }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1 })
  await c.listTabs()          // first request: no pacing state yet
  assert.equal(n, 1)
  await assert.rejects(() => c.listTabs(), err => {
    assert.equal(err.kind, 'ratelimit')
    assert.equal(err.retryAfterSec, 660)   // 600s of window plus its one-minute bucket
    return true
  })
  assert.equal(n, 1, 'the second request must not go out at all')
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

// maxRetries covers 5xx ONLY now — a 429 is never retried, so no setting of it
// can make a rate limit cost more than the one request that discovered it.
test('maxRetries does not apply to a 429: even maxRetries=10 sends one request', async () => {
  let n = 0
  const fetchImpl = async () => { n++; return res(429, { 'Retry-After': '0' }, {}) }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1, maxRetries: 10 })
  await assert.rejects(() => c.listTabs(), err => {
    assert.match(err.message, /rate-limit/i)
    assert.equal(err.kind, 'ratelimit')
    return true
  })
  assert.equal(n, 1)
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

// B7: a folder tab that reads empty WITHOUT throwing used to leave no trace at
// all — failure was logged unconditionally, success only under
// POE_NETWORTH_DEBUG. So "0 items" on the page could not be told apart from
// "never fetched", and the one number that decides it (how many sub-tabs were
// walked) was nowhere in the log.
//
// AND THE SAME SHAPE IS NOW REFUSED RATHER THAN STORED (docs/bugs.md B2): a
// sub-tab that answers 200 with no items array said nothing about its contents,
// so the walk that contains it cannot stand in for the tab. It throws
// `kind:'unread'` and the tab keeps whatever it was last really read with.
test('collection tab: sub-tabs that answer without items make the tab UNREAD, with the counts in the line', async () => {
  const lines = { log: [], warn: [] }
  const log = { log: m => lines.log.push(m), warn: m => lines.warn.push(m) }
  // Three sub-folders, each answering in a shape this walk cannot use: one with
  // no items key at all, one with an empty array, one that carries CHILDREN of
  // its own. The last of those was once B7's standing hypothesis ("the map stash
  // has a level the walk does not descend into"); the pacing change refuted it,
  // and the count stays in the line because it is still the number that would
  // decide the question if a folder tab ever reads empty again.
  const fetchImpl = async url => {
    if (/\/api\/stash\/L\/PARENT$/.test(url)) {
      return res(200, {}, { stash: { children: [{ id: 'C1' }, { id: 'C2' }, { id: 'C3' }] } })
    }
    if (/\/C1$/.test(url)) return res(200, {}, { stash: { type: 'MapStash' } })
    if (/\/C2$/.test(url)) return res(200, {}, { stash: { items: [] } })
    return res(200, {}, { stash: { items: [], children: [{ id: 'C3a' }] } })
  }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1, log })
  await assert.rejects(
    () => c.fetchTab(2, { index: 2, name: 'Maps', type: 'MapStash', id: 'PARENT' }),
    e => e.kind === 'unread',
    'C1 said nothing about itself, so this walk cannot claim to be the tab')

  // Opening bracket: without it the ten-minute hole in the log has nothing on
  // either side of it (B5). The second line is the once-per-process shape
  // observation (B19), which is written after the list request returns.
  assert.equal(lines.log.length, 2)
  assert.match(lines.log[0], /folder tab "Maps" \(MapStash\): reading sub-tabs/)
  assert.match(lines.log[1], /sub-tab shape as GGG returns it/)
  // …and the line, with the numbers that say where the items went.
  assert.equal(lines.warn.length, 1)
  assert.match(lines.warn[0], /folder tab "Maps" \(MapStash\) was NOT read in full/)
  assert.match(lines.warn[0], /3 sub-tabs/)
  assert.match(lines.warn[0], /2 answered with an items array/)
  assert.match(lines.warn[0], /0 of those non-empty/)
  assert.match(lines.warn[0], /1 carry children of their own/)
  assert.match(lines.warn[0], /1 answered with something else/)
})

test('collection tab: an EMPTY sub-tab list is distinguishable from sub-tabs holding nothing', async () => {
  const warns = []
  const log = { log () {}, warn: m => warns.push(m) }
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, log,
    fetchImpl: async () => res(200, {}, { stash: { children: [] } })
  })
  assert.deepEqual(await c.fetchTab(2, { index: 2, name: 'Maps', type: 'MapStash', id: 'PARENT' }), [])
  assert.match(warns[0], /0 sub-tabs/, 'zero sub-tabs points at the child list, not at a level below it')
})

test('collection tab: one that DELIVERS does not warn (no noise per turn)', async () => {
  const lines = { log: [], warn: [] }
  const log = { log: m => lines.log.push(m), warn: m => lines.warn.push(m) }
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, log,
    fetchImpl: async url => (/\/PARENT$/.test(url)
      ? res(200, {}, { stash: { children: [{ id: 'C1' }] } })
      : res(200, {}, { stash: { items: [{ typeLine: 'Headhunter' }] } }))
  })
  assert.equal((await c.fetchTab(16, { index: 16, name: 'UNIQUE', type: 'UniqueStash', id: 'PARENT' })).length, 1)
  assert.deepEqual(lines.warn, [], 'a working folder tab must not warn')
  assert.equal(lines.log.length, 2, 'the opening bracket per turn, and the shape line once per process')
  assert.match(lines.log[0], /reading sub-tabs/)
  assert.match(lines.log[1], /sub-tab shape as GGG returns it/)
})

// B19. THE CASE THAT WENT WRONG IN PRODUCTION, pinned at the level where the
// rule that broke it used to sit. GGG names a map stash's children after the
// PAGE they sit on — `"1"`, `"2"` — not after their section, and a pattern
// written for `Tier: 16` matched every one of them: the whole tab, `Unique Maps`
// included, was never requested.
test('a map stash whose children are called "1" and "2" is read COMPLETELY', async () => {
  // 39 children, exactly the shape the production log reported: page numbers for
  // names, the parent's own type repeated on every one of them, and the two that
  // hold the value indistinguishable from the rest by name or type.
  const children = Array.from({ length: 39 }, (_, i) => ({
    id: `C${i}`, parent: 'PARENT', name: String((i % 2) + 1), type: 'MapStash', metadata: {}
  }))
  const calls = []
  const fetchImpl = async url => {
    calls.push(url)
    return /\/PARENT$/.test(url)
      ? res(200, {}, { stash: { children } })
      : res(200, {}, { stash: { items: [{ typeLine: 'Unidentified Map' }] } })
  }
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1,
    log: { log () {}, warn () {} }
  })
  const items = await c.fetchTab(2, { index: 2, name: 'Maps', type: 'MapStash', id: 'PARENT' })
  assert.equal(items.length, 39, 'every sub-tab contributed its items')
  assert.equal(calls.length, 40, 'the child list plus one request per child — 1+N, nothing left out')
})

// …and no environment can bring the skipping back. The reverted feature had a
// switch and a pattern; a setting whose ON state silently deletes value from the
// net worth is a trap, so neither was kept and nothing else may take their place.
test('no environment variable can make a folder tab read less than all of its children', async () => {
  const names = ['1', '2', '16', 'Tier: 16', 'T16', 'XVI', '', 'Unique Maps']
  const children = names.map((name, i) => ({ id: `C${i}`, name, type: 'MapStash' }))
  const env = {
    POE_STASH_MAP_TIER_SUBTABS: '0',
    POE_STASH_TIER_SUBTAB_PATTERN: '.*',
    POE_STASH_SKIP_SUBTABS: '1'
  }
  const saved = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
  try {
    const calls = []
    const c = createStashClient({
      accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1,
      log: { log () {}, warn () {} },
      fetchImpl: async url => {
        calls.push(url)
        return /\/PARENT$/.test(url)
          ? res(200, {}, { stash: { children } })
          : res(200, {}, { stash: { items: [{ typeLine: 'x' }] } })
      }
    })
    const items = await c.fetchTab(2, { index: 2, name: 'Maps', type: 'MapStash', id: 'PARENT' })
    assert.equal(items.length, names.length, 'a pattern in the environment must decide nothing')
    assert.equal(calls.length, names.length + 1)
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})

test('collection tab without an id -> old endpoint (no guessing against the new API)', async () => {
  const calls = []
  const fetchImpl = async url => { calls.push(url); return res(200, {}, { items: [] }) }
  const c = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', fetchImpl, baseDelayMs: 1 })
  await c.fetchTab(16, { index: 16, name: 'UNIQUE', type: 'UniqueStash', id: null })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /character-window\/get-stash-items/)
})

// Not an empty array, although a scan must keep running past an endpoint that
// can change under it. The scan does keep running — every caller skips an
// `unread` tab exactly the way it skips a timeout — but it does not keep
// running while OVERWRITING the tab with nothing, which is
// the part that reached the recorder as a whole tab leaving the stash
// (docs/bugs.md B2).
test('collection tab: a 404 from the new endpoint is UNREAD, not empty, and a ratelimit propagates', async () => {
  const c404 = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1,
    fetchImpl: async () => res(404, {}, { error: 'nope' }) })
  await assert.rejects(
    () => c404.fetchTab(16, { index: 16, name: 'U', type: 'UniqueStash', id: 'P' }),
    e => e.kind === 'unread',
    'an unexpected response says nothing about the tab, so it must not replace it')

  const c429 = createStashClient({ accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, maxRetries: 0,
    fetchImpl: async () => res(429, { 'retry-after': '1' }, {}) })
  await assert.rejects(
    () => c429.fetchTab(16, { index: 16, name: 'U', type: 'UniqueStash', id: 'P' }),
    e => e.kind === 'ratelimit', 'the rate limit must NOT be swallowed')
})

// ---------------------------------------------------------------------------
// Which rules GGG measures the stash budget by. Pure observation: the headers
// arrived anyway, no request is added, no pacing changes. The rule NAME is what
// answers "is this budget per IP or per account?", which nothing else in the
// stash path can answer at all.
// ---------------------------------------------------------------------------

function capturingLog () {
  const lines = []
  return { lines, log: m => lines.push(String(m)), warn: () => {}, error: () => {} }
}

test('the rate-limit rule set is logged ONCE, however many responses arrive', async () => {
  resetRateLimitRuleLog()
  const headers = {
    'X-Rate-Limit-Rules': 'Account',
    'X-Rate-Limit-Account': '45:60:60',
    'X-Rate-Limit-Account-State': '1:60:0'
  }
  const log = capturingLog()
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, log, sleep: nosleep,
    fetchImpl: async () => res(200, headers, { tabs: [] })
  })
  await c.listTabs()
  await c.listTabs()
  await c.listTabs()
  const ruleLines = log.lines.filter(l => l.includes('rate-limit rules'))
  assert.equal(ruleLines.length, 1, 'a refresher ticking round the clock must not log this per request')
  assert.match(ruleLines[0], /Account 45\/60s ban 60s/)
  assert.match(ruleLines[0], /Ip = shared/, 'the line has to say what the name means')
})

test('the rule set is remembered across CLIENTS (the server builds a fresh one every tick)', async () => {
  resetRateLimitRuleLog()
  const headers = { 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '15:60:120' }
  const log = capturingLog()
  const mk = () => createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, log, sleep: nosleep,
    fetchImpl: async () => res(200, headers, { tabs: [] })
  })
  await mk().listTabs()
  await mk().listTabs()
  assert.equal(log.lines.filter(l => l.includes('rate-limit rules')).length, 1)
})

test('a CHANGED rule set is logged again — that is the one event worth a second line', async () => {
  resetRateLimitRuleLog()
  const log = capturingLog()
  let headers = { 'X-Rate-Limit-Rules': 'Account', 'X-Rate-Limit-Account': '45:60:60' }
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, log, sleep: nosleep,
    fetchImpl: async () => res(200, headers, { tabs: [] })
  })
  await c.listTabs()
  headers = { 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '15:60:120' }
  await c.listTabs()
  const ruleLines = log.lines.filter(l => l.includes('rate-limit rules'))
  assert.equal(ruleLines.length, 2)
  assert.match(ruleLines[1], /Ip 15\/60s ban 120s/)
})

test('the rule line names the POLICY the set belongs to', async () => {
  // Which budget a set belongs to is the field that says whether a second,
  // different set replaces the first or stands next to it. A log line that
  // named only the numbers could not answer that after the fact.
  resetRateLimitRuleLog()
  const log = capturingLog()
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, log, sleep: nosleep,
    fetchImpl: async () => res(200, { ...MEASURED_HEADERS, 'X-Rate-Limit-Policy': 'stash-request-limit' }, { tabs: [] })
  })
  await c.listTabs()
  const line = log.lines.find(l => l.includes('rate-limit rules'))
  assert.match(line, /policy stash-request-limit/)
})

test('the same numbers under two policies are two sets, and are logged as two', async () => {
  resetRateLimitRuleLog()
  const log = capturingLog()
  let policy = 'stash-request-limit'
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, log, sleep: nosleep,
    fetchImpl: async () => res(200, { 'X-Rate-Limit-Policy': policy, 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '45:60:120' }, { tabs: [] })
  })
  await c.listTabs()
  policy = 'stash-folder-limit'
  await c.listTabs()
  assert.equal(log.lines.filter(l => l.includes('rate-limit rules')).length, 2)
})

test('a response with no rate-limit headers is reported once as exactly that', async () => {
  resetRateLimitRuleLog()
  const log = capturingLog()
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, log,
    fetchImpl: async () => res(200, {}, { tabs: [] })
  })
  await c.listTabs()
  await c.listTabs()
  const lines = log.lines.filter(l => l.includes('no X-Rate-Limit headers'))
  assert.equal(lines.length, 1)
})

test('the rule line also says what pace was derived from those rules', async () => {
  resetRateLimitRuleLog()
  const log = capturingLog()
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1500, log, sleep: nosleep,
    pacer: createStashPacer({ now: () => 0 }),
    fetchImpl: async () => res(200, MEASURED_HEADERS, { tabs: [] })
  })
  await c.listTabs()
  const line = log.lines.find(l => l.includes('rate-limit rules'))
  assert.match(line, /Ip 45\/60s ban 120s/)
  assert.match(line, /Ip 180\/1800s ban 600s/)
  assert.match(line, /derived minimum spacing between two stash requests: 24\.8s/)
})

// ---------------------------------------------------------------------------
// The pace itself, derived from the rules above instead of from a constant.
//
// The constant was 1500ms = 40 requests a minute against a published
// `Ip 45/60s` — 89% of a window whose only brake (delayFor) opens at 80% and
// reads a counter off a response the requests are already behind. And nothing
// counted the 1800s windows at all: a folder tab spends 1+N requests inside one
// step, which is where they are actually filled.
// ---------------------------------------------------------------------------

test('the wait between two requests comes from GGG\'s rules, not from the constant', async () => {
  const { client, waits, calls } = pacedClient({ headers: MEASURED_HEADERS })
  await client.listTabs()
  await client.listTabs()
  assert.equal(calls.length, 2)
  assert.deepEqual(waits, [DERIVED_MS], 'the first request waits for nothing; the second waits out the derived spacing')
})

test('without rules the constant is what is used — the first request after a start', async () => {
  const { client, waits } = pacedClient({ headers: {} })
  await client.listTabs()
  await client.listTabs()
  assert.deepEqual(waits, [1500], 'no rules seen -> the old base pace, unchanged')
})

test('a generous rule set never derives anything FASTER than the constant', async () => {
  // 10,000 requests a second would be a spacing of a tenth of a millisecond.
  // The constant is the floor, so the client waits exactly what it always did.
  const { client, waits } = pacedClient({
    headers: { 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '10000:1:60' }
  })
  await client.listTabs()
  await client.listTabs()
  assert.deepEqual(waits, [1500])
})

test('the derived pace survives the client — the server builds a fresh one every tick', async () => {
  // This is the defect the pacing state was moved out of the client for: a
  // per-tick client starts with no header state at all, so the first request of
  // every tick used to go out with no pace behind it whatsoever.
  let t = 0
  const pacer = createStashPacer({ now: () => t })
  const waits = []
  const mk = () => createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1500, pacer,
    sleep: async ms => { waits.push(ms); t += ms },
    log: { log () {}, warn () {} },
    fetchImpl: async () => res(200, MEASURED_HEADERS, { tabs: [] })
  })
  await mk().listTabs()          // tick 1
  assert.deepEqual(waits, [])
  t += 10_000                    // ten seconds later, a new tick and a new client
  await mk().listTabs()
  assert.deepEqual(waits, [DERIVED_MS - 10_000], 'the new client owes what is left of the spacing')
  t += 30_000                    // …and a full tick later it owes nothing
  await mk().listTabs()
  assert.deepEqual(waits, [DERIVED_MS - 10_000])
})

test('a folder tab spends its 1+N requests at the derived pace instead of as a burst', async () => {
  // The map stash was measured at 30 sub-tabs. At the old constant those 31
  // requests left inside 46s — 40 a minute, against Ip 45/60s.
  const children = Array.from({ length: 30 }, (_, i) => ({ id: `C${i}` }))
  const { client, make, waits, calls, advance } = pacedClient({
    // A folder tab is walked entirely on the SECOND endpoint, which publishes a
    // rule set of its own — the 1800s windows are not in it. The pacer holds
    // every rule it has seen, so the tab list fetched a tick earlier still paces
    // the walk; dropping the older set is what would let the walk fill the
    // window nobody is watching.
    headersFor: url => (/\/api\/stash\//.test(url) ? MEASURED_HEADERS_V2 : MEASURED_HEADERS),
    body: url => {
      if (/character-window/.test(url)) return { tabs: [] }
      return /PARENT$/.test(url) ? { stash: { children } } : { stash: { items: [{ typeLine: 'x' }] } }
    }
  })
  await client.listTabs()      // an ordinary tick: this is where group 1 is learnt
  advance(30_000)              // …and the folder tab's turn comes one tick later,
  const items = await make().fetchTab(2, { index: 2, name: 'Maps', type: 'MapStash', id: 'PARENT' })  // with a fresh client
  assert.equal(calls.length, 32, '1 tab list + 1 + 30, exactly as before — nothing was removed or added')
  assert.equal(items.length, 30)
  assert.deepEqual(waits, new Array(30).fill(DERIVED_MS), 'no wait for the parent (a tick has passed), then one per sub-tab')
  const total = waits.reduce((a, b) => a + b, 0)
  assert.equal(total, 744_000, 'the same 31 requests, spread over ~13 minutes instead of ~46 seconds')
  // The whole pass fits inside the tightest long window it can be counted
  // against, which is the thing the old burst did not.
  assert.ok(31 <= 1_800_000 / DERIVED_MS)
})

test('GGG going back to a looser set makes the client faster again — end to end', async () => {
  // The one-way street, through the real client. The strict set of 13.08. 02:15
  // paces at 80s; when the same policy publishes the looser set again the very
  // next response, the wait after it is 24s. Before the policy was part of the
  // key this stayed at 80s until the process was restarted.
  const strict = {
    'X-Rate-Limit-Policy': 'stash-request-limit',
    'X-Rate-Limit-Rules': 'Ip',
    'X-Rate-Limit-Ip': '30:60:120,90:1800:600,180:7200:3600'
  }
  const loose = { ...MEASURED_HEADERS, 'X-Rate-Limit-Policy': 'stash-request-limit' }
  let headers = strict
  const { client, waits } = pacedClient({ headersFor: () => headers })
  await client.listTabs()                      // learns the strict set
  await client.listTabs()                      // …and pays for it
  assert.deepEqual(waits, [80_667], 'Ip 180/7200s at the 0.5 share, over a bucketed 7260s window')
  headers = loose
  await client.listTabs()                      // still paced by the strict set
  await client.listTabs()                      // now paced by what GGG last published
  assert.deepEqual(waits, [80_667, 80_667, 24_800])
})

test('a full window brakes the NEXT tick too, not only the rest of this one', async () => {
  // A state counter at the top of a 60s window makes delayFor ask for the whole
  // window plus its bucket. That answer used to die with the client at the end
  // of the tick.
  let t = 0
  const waits = []
  const pacer = createStashPacer({ now: () => t })
  const headers = {
    'X-Rate-Limit-Rules': 'Ip',
    'X-Rate-Limit-Ip': '45:60:120',
    'X-Rate-Limit-Ip-State': '45:60:0'
  }
  const mk = () => createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1500, pacer,
    sleep: async ms => { waits.push(ms); t += ms },
    log: { log () {}, warn () {} },
    fetchImpl: async () => res(200, headers, { tabs: [] })
  })
  await mk().listTabs()
  t += 30_000                     // one tick later, with a fresh client
  await mk().listTabs()
  assert.deepEqual(waits, [35_000], 'the rest of the window — plus its 5s bucket — is still owed')
})

// ---------------------------------------------------------------------------
// THE RULE NAMES AS A SESSION CHECK
//
// The legacy stash endpoint answers the SAME policy in two forms: `Account,Ip`
// when the POESESSID was accepted, `Ip`-only when it was not — with the address
// limit roughly halved in the second (gerwaric/acquisition, 28.07.2026; a GGG
// developer described the same behaviour in the official forum in 2018).
//
// This deployment has one of those in its log: 13.08.2026, 02:15 UTC. The tool's
// only reaction was to get slower, silently, for hours. The pacing was right to
// honour the limits it was given; what was missing is the sentence saying WHY
// they changed.
// ---------------------------------------------------------------------------

const AUTHED = {
  'X-Rate-Limit-Policy': 'backend-item-request-limit',
  'X-Rate-Limit-Rules': 'Account,Ip',
  'X-Rate-Limit-Account': '30:60:60,100:1800:600',
  'X-Rate-Limit-Ip': '45:60:120,180:1800:600'
}
const UNAUTHED = {
  'X-Rate-Limit-Policy': 'backend-item-request-limit',
  'X-Rate-Limit-Rules': 'Ip',
  'X-Rate-Limit-Ip': '30:60:120,90:1800:600,180:7200:3600'
}

function scopeClient (log, headersRef) {
  return createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, log, sleep: nosleep,
    fetchImpl: async () => res(200, headersRef(), { tabs: [] })
  })
}

test('losing the Account rules is reported as a dead session, not paced around quietly', async () => {
  resetSessionScope()
  resetRateLimitRuleLog()
  const log = capturingLog()
  log.warn = m => log.lines.push(String(m))
  let headers = AUTHED
  const c = scopeClient(log, () => headers)
  await c.listTabs()
  assert.equal(log.lines.filter(l => l.includes('per account')).length, 0, 'an authenticated set says nothing')

  headers = UNAUTHED
  await c.listTabs()
  const said = log.lines.filter(l => l.includes('NOT being counted per account'))
  assert.equal(said.length, 1)
  assert.match(said[0], /POESESSID is expired or was not accepted/)
  assert.match(said[0], /Renew it in networth-users\.json/)
  assert.match(said[0], /symptom, not the problem/)

  // Edge-triggered: a refresher ticking round the clock must not repeat it.
  await c.listTabs()
  await c.listTabs()
  assert.equal(log.lines.filter(l => l.includes('NOT being counted per account')).length, 1)
})

test('regaining the Account rules is reported too — "it fixed itself" is half the answer', async () => {
  resetSessionScope()
  resetRateLimitRuleLog()
  const log = capturingLog()
  log.warn = m => log.lines.push(String(m))
  let headers = AUTHED
  const c = scopeClient(log, () => headers)
  await c.listTabs()
  headers = UNAUTHED
  await c.listTabs()
  headers = AUTHED
  await c.listTabs()
  assert.equal(log.lines.filter(l => l.includes('being counted per account again')).length, 1)
})

test('a policy that has NEVER carried Account rules says nothing — there is nothing to conclude', async () => {
  resetSessionScope()
  resetRateLimitRuleLog()
  const log = capturingLog()
  log.warn = m => log.lines.push(String(m))
  const c = scopeClient(log, () => UNAUTHED)
  await c.listTabs()
  await c.listTabs()
  assert.equal(log.lines.filter(l => l.includes('per account')).length, 0,
    'only the TRANSITION is evidence; an Ip-only policy may simply be one')
})

test('the two endpoint groups do not accuse each other — the check is per policy', async () => {
  // The folder-tab endpoint publishes `Account` only; the ordinary one both.
  // Different policies, so neither of them is the other one losing a scope.
  resetSessionScope()
  resetRateLimitRuleLog()
  const log = capturingLog()
  log.warn = m => log.lines.push(String(m))
  const other = { ...MEASURED_HEADERS_V2, 'X-Rate-Limit-Policy': 'backend-item-static' }
  let headers = AUTHED
  const c = scopeClient(log, () => headers)
  await c.listTabs()
  headers = other
  await c.listTabs()
  headers = AUTHED
  await c.listTabs()
  assert.equal(log.lines.filter(l => l.includes('per account')).length, 0)
})

test('the observation changes nothing about the request — the auth path still owns the refusal', async () => {
  // Deliberate: an unauthenticated stash request cannot read a private stash,
  // so it is refused, and THAT is what pauses the user and reports `expired`.
  // A process-wide header observation cannot name a user, and a false positive
  // would freeze a healthy refresher. So it logs and does not intervene.
  resetSessionScope()
  resetRateLimitRuleLog()
  const log = capturingLog()
  log.warn = m => log.lines.push(String(m))
  let n = 0
  const c = createStashClient({
    accountName: 'a', poesessid: 'S', league: 'L', baseDelayMs: 1, log, sleep: nosleep,
    fetchImpl: async () => { n++; return n === 1 ? res(200, AUTHED, { tabs: [] }) : res(403, UNAUTHED, {}) }
  })
  await c.listTabs()
  await assert.rejects(() => c.listTabs(), err => {
    assert.equal(err.kind, 'auth', 'the 403 is still what stops this user, with its own per-user status')
    return true
  })
  assert.equal(log.lines.filter(l => l.includes('NOT being counted per account')).length, 1,
    'and the line says WHY, which the 403 on its own does not')
})
