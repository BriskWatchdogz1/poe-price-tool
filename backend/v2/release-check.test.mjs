// The release check: version parsing and comparison, and one check against an
// injected GitHub. Nothing here reaches the network (fetch is a double) and the
// state file lives in a temp dir.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  OUTCOME, COMPARISON, DEFAULT_REPO, INTERVAL_MS, INITIAL_DELAY_MS, CHECK_NOW_COOLDOWN_MS, REQUEST_TIMEOUT_MS,
  parseVersion, compareVersions, createReleaseCheck
} from './release-check.mjs'
import { FAIL_KIND } from './check-failure.mjs'

// --- parsing and comparison ---------------------------------------------------

test('parseVersion accepts x.y.z with an optional v and nothing else', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3 })
  for (const bad of ['1.2', '1.2.3-rc1', '1.2.3.4', '', null, undefined, 'nightly', 123]) {
    assert.equal(parseVersion(bad), null, String(bad))
  }
})

test('compareVersions: newer, current (equal or older), unknown', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), COMPARISON.NEWER)
  assert.equal(compareVersions('0.1.0', '0.1.0'), COMPARISON.CURRENT)
  assert.equal(compareVersions('0.1.0', '0.2.0'), COMPARISON.CURRENT)
  assert.equal(compareVersions('v0.2.0', '0.1.0'), COMPARISON.NEWER)
  assert.equal(compareVersions('0.10.0', '0.9.0'), COMPARISON.NEWER) // numeric, not textual
  assert.equal(compareVersions('1.0.0', '0.99.99'), COMPARISON.NEWER)
  assert.equal(compareVersions('0.1.10', '0.1.9'), COMPARISON.NEWER)
  assert.equal(compareVersions(null, '0.1.0'), COMPARISON.UNKNOWN)
  assert.equal(compareVersions('0.2.0', null), COMPARISON.UNKNOWN)
  assert.equal(compareVersions('0.2.0', 'nightly'), COMPARISON.UNKNOWN)
})

// --- harness ------------------------------------------------------------------

const API = repo => `https://api.github.com/repos/${repo}/releases/latest`
const RELEASE = (tag = 'v0.2.0', extra = {}) => ({
  tag_name: tag,
  html_url: `https://example.test/r/${tag}`,
  published_at: '2026-11-01T00:00:00Z',
  name: tag.replace(/^v/, ''),
  ...extra
})

// reply: { status, body (object | string), etag, textReject } or a function of the request
// options, or an Error to reject with. Replies are consumed in order; the last
// one repeats.
function makeFetch (replies, calls = []) {
  let i = 0
  return async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {}, signal: opts.signal })
    const r0 = replies[Math.min(i++, replies.length - 1)]
    const r = typeof r0 === 'function' ? r0(opts) : r0
    if (r instanceof Error || (r && r.reject)) throw r.reject ?? r
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: h => ({ etag: r.etag }[h.toLowerCase()] ?? null) },
      text: async () => { if (r.textReject) throw r.textReject; return body }
    }
  }
}

async function make (t, { replies = [{ status: 200, body: RELEASE() }], installed = '0.1.0', state = null, statePath, extra = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'release-check-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = statePath ?? path.join(dir, 'release-check.json')
  if (state !== null) await writeFile(file, typeof state === 'string' ? state : JSON.stringify(state))
  const clock = { t: Date.parse('2026-11-02T12:00:00Z') }
  const calls = []
  const warnings = []
  const logs = []
  const checked = []
  const rc = createReleaseCheck({
    installedVersion: installed,
    statePath: file,
    fetchImpl: makeFetch(replies, calls),
    now: () => clock.t,
    log: { log: m => logs.push(String(m)), warn: m => warnings.push(String(m)), error: () => {} },
    onCheck: s => checked.push(s),
    ...extra
  })
  const persisted = async () => JSON.parse(await readFile(file, 'utf8'))
  return { rc, file, clock, calls, warnings, logs, checked, persisted, dir }
}

// --- check(): what GitHub answered --------------------------------------------

test('200 with a newer tag: ok, newer, ETag stored, +24 h, conditional second call', async t => {
  const { rc, calls, clock, persisted, checked, logs } = await make(t, {
    replies: [{ status: 200, body: RELEASE(), etag: 'W/"abc"' }, { status: 304 }]
  })
  await rc.init()
  const checkedAt = clock.t
  const res = await rc.check()
  assert.equal(res.outcome, OUTCOME.OK)
  const s = rc.status()
  assert.equal(s.latest.version, '0.2.0')
  assert.equal(s.latest.tag, 'v0.2.0')
  assert.equal(s.latest.url, 'https://example.test/r/v0.2.0')
  assert.equal(s.latest.publishedAt, '2026-11-01T00:00:00Z')
  assert.equal(s.comparison, COMPARISON.NEWER)
  assert.equal(s.installed, '0.1.0')
  assert.equal(s.repo, DEFAULT_REPO)
  assert.equal(s.lastOutcome, OUTCOME.OK)
  assert.equal(s.lastCheckAt, checkedAt)
  assert.equal(s.nextCheckAt, checkedAt + INTERVAL_MS)
  const p = await persisted()
  assert.equal(p.etag, 'W/"abc"')
  assert.equal(p.latest.version, '0.2.0')
  assert.equal(p.nextCheckAt, checkedAt + INTERVAL_MS)

  assert.equal(calls[0].url, API(DEFAULT_REPO))
  assert.match(calls[0].headers['User-Agent'], /^poe-price-tool\/.* \(release check\)$/)
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json')
  assert.equal(calls[0].headers['If-None-Match'], undefined)
  assert.ok(calls[0].signal, 'a timeout signal is passed to fetch')

  await rc.check()
  assert.equal(calls[1].headers['If-None-Match'], 'W/"abc"')
  assert.equal(checked.length, 2)
  assert.equal(checked[0].comparison, COMPARISON.NEWER)
  assert.ok(logs.some(l => l.startsWith('[release-check] release 0.2.0 is newer than installed 0.1.0: https://example.test/r/v0.2.0')), logs.join('\n'))
})

test('the repo and user agent come from the options', async t => {
  const { rc, calls } = await make(t, { extra: { repo: 'someone/fork', userAgent: 'ua-test' } })
  await rc.init()
  await rc.check()
  assert.equal(calls[0].url, API('someone/fork'))
  assert.equal(calls[0].headers['User-Agent'], 'ua-test')
  assert.equal(rc.status().repo, 'someone/fork')
})

test('200 with the installed tag: ok and current, silent', async t => {
  const { rc, logs } = await make(t, { replies: [{ status: 200, body: RELEASE('v0.1.0') }] })
  await rc.init()
  assert.equal((await rc.check()).outcome, OUTCOME.OK)
  assert.equal(rc.status().comparison, COMPARISON.CURRENT)
  assert.ok(logs.some(l => l.includes('up to date (0.1.0)')), logs.join('\n'))
})

test('an installed version newer than the latest release (a development build) stays current', async t => {
  const { rc } = await make(t, { replies: [{ status: 200, body: RELEASE('v0.0.9') }] })
  await rc.init()
  assert.equal((await rc.check()).outcome, OUTCOME.OK)
  assert.equal(rc.status().comparison, COMPARISON.CURRENT)
})

test('200 without html_url: still a notice, version without link', async t => {
  const body = RELEASE(); delete body.html_url
  const { rc, logs } = await make(t, { replies: [{ status: 200, body }] })
  await rc.init()
  assert.equal((await rc.check()).outcome, OUTCOME.OK)
  assert.equal(rc.status().latest.url, null)
  assert.equal(rc.status().comparison, COMPARISON.NEWER)
  assert.ok(logs.some(l => l.includes('release 0.2.0 is newer than installed 0.1.0')), logs.join('\n'))
})

test('404: none, latest cleared, comparison unknown', async t => {
  const { rc, persisted } = await make(t, {
    replies: [{ status: 404, body: { message: 'Not Found' } }],
    state: { latest: { version: '0.2.0', tag: 'v0.2.0', url: null, publishedAt: null, name: null }, etag: '"old"' }
  })
  await rc.init()
  assert.equal(rc.status().comparison, COMPARISON.NEWER)
  assert.equal((await rc.check()).outcome, OUTCOME.NONE)
  const s = rc.status()
  assert.equal(s.latest, null)
  assert.equal(s.comparison, COMPARISON.UNKNOWN)
  assert.equal(s.lastOutcome, OUTCOME.NONE)
  const p = await persisted()
  assert.equal(p.latest, null)
  assert.equal(p.etag, null)
})

test('304 after a stored latest: unchanged, latest stays', async t => {
  const { rc } = await make(t, {
    replies: [{ status: 304 }],
    state: { latest: { version: '0.2.0', tag: 'v0.2.0', url: 'https://example.test/r', publishedAt: null, name: null }, etag: '"x"' }
  })
  await rc.init()
  assert.equal((await rc.check()).outcome, OUTCOME.UNCHANGED)
  assert.equal(rc.status().latest.version, '0.2.0')
  assert.equal(rc.status().lastOutcome, OUTCOME.UNCHANGED)
})

test('the log says "no release published yet" for 404 and "unchanged — latest ..." for 304', async t => {
  const none = await make(t, { replies: [{ status: 404, body: {} }] })
  await none.rc.init()
  await none.rc.check()
  assert.ok(none.logs.some(l => l.includes('[release-check] no release published yet')), none.logs.join('\n'))
  const same = await make(t, {
    replies: [{ status: 304 }],
    state: { latest: { version: '0.2.0', tag: 'v0.2.0', url: null, publishedAt: '2026-11-01T00:00:00Z', name: null }, etag: '"x"' }
  })
  await same.rc.init()
  await same.rc.check()
  assert.ok(same.logs.some(l => l.includes('[release-check] unchanged — latest 0.2.0 from 2026-11-01')), same.logs.join('\n'))
})

const KEPT = { latest: { version: '0.2.0', tag: 'v0.2.0', url: 'https://example.test/r', publishedAt: null, name: null }, etag: '"x"' }

for (const [label, reply, kind] of [
  ['403', { status: 403, body: { message: 'rate limit' } }, FAIL_KIND.REJECTED],
  ['429', { status: 429, body: '' }, FAIL_KIND.REJECTED],
  ['500', { status: 500, body: 'oops' }, FAIL_KIND.UNREACHABLE],
  ['a network error', new TypeError('fetch failed'), FAIL_KIND.UNREACHABLE],
  ['not JSON', { status: 200, body: 'not json' }, FAIL_KIND.INCOMPATIBLE],
  ['a tag that is not a version', { status: 200, body: { tag_name: 'nightly' } }, FAIL_KIND.INCOMPATIBLE],
  ['an empty object', { status: 200, body: {} }, FAIL_KIND.INCOMPATIBLE],
  ['an unexpected status', { status: 418, body: '' }, FAIL_KIND.UNKNOWN]
]) {
  test(`${label}: failed (${kind}), previous latest kept, next check in 24 h`, async t => {
    const { rc, warnings, persisted, clock } = await make(t, { replies: [reply], state: KEPT })
    await rc.init()
    const res = await rc.check()
    assert.equal(res.outcome, OUTCOME.FAILED)
    assert.equal(res.failKind, kind)
    assert.ok(res.reason)
    const s = rc.status()
    assert.equal(s.lastOutcome, OUTCOME.FAILED)
    assert.equal(s.lastFailKind, kind)
    assert.equal(s.lastReason, res.reason)
    assert.equal(s.latest.version, '0.2.0')
    assert.equal(s.lastCheckAt, clock.t)
    assert.equal(s.nextCheckAt, clock.t + INTERVAL_MS)
    const p = await persisted()
    assert.equal(p.latest.version, '0.2.0')
    assert.equal(p.etag, '"x"')
    assert.equal(p.lastFailKind, kind)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /^\[release-check\] check failed \(kept last state\): .+; next check \d{4}-\d{2}-\d{2}T/)
  })
}

test('a request that times out ends as failed unreachable and says so', async t => {
  const { rc, calls } = await make(t, { replies: [{ reject: { name: 'AbortError' } }] })
  await rc.init()
  const res = await rc.check()
  assert.equal(res.outcome, OUTCOME.FAILED)
  assert.equal(res.failKind, FAIL_KIND.UNREACHABLE)
  assert.match(res.reason, /timeout/i)
  assert.ok(calls[0].signal)
  assert.ok(REQUEST_TIMEOUT_MS > 0)
})

test('a body that stalls past the timeout ends as failed unreachable with the timeout reason', async t => {
  const { rc } = await make(t, { replies: [{ status: 200, textReject: { name: 'TimeoutError' } }] })
  await rc.init()
  const res = await rc.check()
  assert.equal(res.outcome, OUTCOME.FAILED)
  assert.equal(res.failKind, FAIL_KIND.UNREACHABLE)
  assert.match(res.reason, /timeout/i)
})

test('a success after a failure clears the failure fields', async t => {
  const { rc } = await make(t, { replies: [{ status: 500, body: '' }, { status: 200, body: RELEASE() }] })
  await rc.init()
  await rc.check()
  assert.equal(rc.status().lastFailKind, FAIL_KIND.UNREACHABLE)
  await rc.check()
  assert.equal(rc.status().lastFailKind, null)
  assert.equal(rc.status().lastReason, null)
})

// --- state --------------------------------------------------------------------

test('installed version null: comparison unknown even with a latest', async t => {
  const { rc } = await make(t, { installed: null, replies: [{ status: 200, body: RELEASE() }] })
  await rc.init()
  await rc.check()
  assert.equal(rc.status().latest.version, '0.2.0')
  assert.equal(rc.status().comparison, COMPARISON.UNKNOWN)
  assert.equal(rc.status().installed, null)
})

test('a stored latest equal to the installed version is current right after init, before any check', async t => {
  const { rc, calls } = await make(t, { installed: '0.2.0', state: KEPT })
  await rc.init()
  assert.equal(rc.status().comparison, COMPARISON.CURRENT)
  assert.equal(calls.length, 0)
})

test('status before any check is empty and says so', async t => {
  const { rc } = await make(t)
  await rc.init()
  const s = rc.status()
  assert.equal(s.latest, null)
  assert.equal(s.lastCheckAt, null)
  assert.equal(s.nextCheckAt, null)
  assert.equal(s.lastOutcome, null)
  assert.equal(s.comparison, COMPARISON.UNKNOWN)
  assert.equal(s.enabled, true)
})

test('enabled follows isDisabled at the time status() is read', async t => {
  let off = false
  const { rc } = await make(t, { extra: { isDisabled: () => off } })
  await rc.init()
  assert.equal(rc.status().enabled, true)
  off = true
  assert.equal(rc.status().enabled, false)
})

test('a corrupt state file does not stop init: one warning, empty state', async t => {
  const { rc, warnings } = await make(t, { state: '{not json' })
  await rc.init()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^\[release-check\]/)
  assert.equal(rc.status().latest, null)
  assert.equal((await rc.check()).outcome, OUTCOME.OK) // and it recovers
})

test('a state file with nonsense fields is read as far as it makes sense', async t => {
  const { rc, warnings } = await make(t, {
    state: { latest: { version: 'nightly' }, lastOutcome: 'bogus', nextCheckAt: 'soon', lastFailKind: 'weird' }
  })
  await rc.init()
  const s = rc.status()
  assert.equal(warnings.length, 0)
  assert.equal(s.latest, null)
  assert.equal(s.lastOutcome, null)
  assert.equal(s.nextCheckAt, null)
  assert.equal(s.lastFailKind, null)
})

test('an ETag without a usable latest is dropped: the first check is not conditional', async t => {
  const { rc, calls } = await make(t, {
    state: { etag: '"stale"', latest: { version: 'nightly' } },
    replies: [{ status: 200, body: RELEASE(), etag: '"fresh"' }]
  })
  await rc.init()
  const s = await rc.check()
  assert.equal(calls[0].headers['If-None-Match'], undefined)
  assert.equal(s.outcome, OUTCOME.OK)
  assert.equal(rc.status().latest.version, '0.2.0')
})

test('the state file is written whole: a check leaves complete JSON and no temp file behind', async t => {
  const { rc, file, dir, persisted } = await make(t)
  await rc.init()
  await rc.check()
  assert.deepEqual(await readdir(dir), [path.basename(file)], 'only the state file is in the directory')
  const p = await persisted() // JSON.parse throws on a half-written file
  assert.equal(p.lastOutcome, OUTCOME.OK)
  assert.equal(p.latest.version, '0.2.0')
})

test('a missing state file is not a warning', async t => {
  const { rc, warnings } = await make(t)
  await rc.init()
  assert.equal(warnings.length, 0)
})

test('a state write failure does not fail the check', async t => {
  const { dir } = await make(t)
  const blocker = path.join(dir, 'a-file')
  await writeFile(blocker, 'x')
  // The parent of the state path is a regular file: it cannot be created.
  const { rc, warnings } = await make(t, { statePath: path.join(blocker, 'sub', 'release-check.json') })
  await rc.init()
  const res = await rc.check()
  assert.equal(res.outcome, OUTCOME.OK)
  assert.equal(rc.status().latest.version, '0.2.0')
  assert.ok(warnings.some(w => w.includes('could not be saved')), warnings.join('\n'))
})

test('a state path that is a directory does not fail the check either', async t => {
  const { dir } = await make(t)
  const asDir = path.join(dir, 'is-a-dir')
  await mkdir(asDir)
  const { rc } = await make(t, { statePath: asDir })
  await rc.init()
  assert.equal((await rc.check()).outcome, OUTCOME.OK)
})

test('an onCheck handler that throws does not fail the check', async t => {
  const { rc } = await make(t, { extra: { onCheck: () => { throw new Error('boom') } } })
  await rc.init()
  assert.equal((await rc.check()).outcome, OUTCOME.OK)
})

// --- schedule, disabled flag, manual check --------------------------------------

// Records every setTimeout as { fn, ms, unref, cleared }, like the data refresher's tests.
function makeTimers () {
  const scheduled = []
  return {
    scheduled,
    timers: {
      setTimeout: (fn, ms) => {
        const rec = { fn, ms, unrefCalled: false, cleared: false }
        scheduled.push(rec)
        return { unref () { rec.unrefCalled = true }, rec }
      },
      clearTimeout: h => { if (h?.rec) h.rec.cleared = true }
    }
  }
}

const NOW = Date.parse('2026-11-02T12:00:00Z')

test('start(): a fresh state waits the initial delay, unref()ed', async t => {
  const { timers, scheduled } = makeTimers()
  const { rc } = await make(t, { extra: { timers } })
  await rc.init()
  rc.start()
  assert.deepEqual(scheduled.map(x => x.ms), [INITIAL_DELAY_MS])
  assert.equal(scheduled[0].unrefCalled, true)
})

test('start(): a nextCheckAt in the future is waited out exactly', async t => {
  const { timers, scheduled } = makeTimers()
  const { rc } = await make(t, { state: { nextCheckAt: NOW + 3_600_000 }, extra: { timers } })
  await rc.init()
  rc.start()
  assert.deepEqual(scheduled.map(x => x.ms), [3_600_000])
})

test('start(): a nextCheckAt in the past falls back to the initial delay', async t => {
  const { timers, scheduled } = makeTimers()
  const { rc } = await make(t, { state: { nextCheckAt: NOW - 1 }, extra: { timers } })
  await rc.init()
  rc.start()
  assert.deepEqual(scheduled.map(x => x.ms), [INITIAL_DELAY_MS])
})

test('start(): a nextCheckAt far in the future (wrong clock) is capped at 24 h', async t => {
  const { timers, scheduled } = makeTimers()
  const { rc } = await make(t, { state: { nextCheckAt: NOW + 10 * INTERVAL_MS }, extra: { timers } })
  await rc.init()
  rc.start()
  assert.deepEqual(scheduled.map(x => x.ms), [INTERVAL_MS])
})

test('a tick runs one check and schedules the next one 24 h out', async t => {
  const { timers, scheduled } = makeTimers()
  const { rc, calls } = await make(t, { extra: { timers } })
  await rc.init()
  rc.start()
  await scheduled[0].fn()
  await new Promise(r => setImmediate(r))
  assert.equal(calls.length, 1)
  assert.equal(rc.status().lastOutcome, OUTCOME.OK)
  assert.deepEqual(scheduled.map(x => x.ms), [INITIAL_DELAY_MS, INTERVAL_MS])
  assert.equal(scheduled[1].unrefCalled, true)
})

test('a tick reschedules even when the check failed', async t => {
  const { timers, scheduled } = makeTimers()
  const { rc } = await make(t, { replies: [new TypeError('fetch failed')], extra: { timers } })
  await rc.init()
  rc.start()
  await scheduled[0].fn()
  await new Promise(r => setImmediate(r))
  assert.equal(rc.status().lastOutcome, OUTCOME.FAILED)
  assert.deepEqual(scheduled.map(x => x.ms), [INITIAL_DELAY_MS, INTERVAL_MS])
})

test('a tick with isDisabled() true makes no request, reschedules, and picks up the flag live', async t => {
  const { timers, scheduled } = makeTimers()
  let off = true
  const { rc, calls } = await make(t, { extra: { timers, isDisabled: () => off } })
  await rc.init()
  rc.start()
  await scheduled[0].fn()
  await new Promise(r => setImmediate(r))
  assert.equal(calls.length, 0)
  assert.equal(rc.status().enabled, false)
  assert.deepEqual(scheduled.map(x => x.ms), [INITIAL_DELAY_MS, INTERVAL_MS])
  off = false
  await scheduled[1].fn()
  await new Promise(r => setImmediate(r))
  assert.equal(calls.length, 1)
  assert.deepEqual(scheduled.map(x => x.ms), [INITIAL_DELAY_MS, INTERVAL_MS, INTERVAL_MS])
})

test('stop() clears the pending timer; a second start() does not leave two', async t => {
  const { timers, scheduled } = makeTimers()
  const { rc } = await make(t, { extra: { timers } })
  await rc.init()
  rc.start()
  rc.start()
  assert.equal(scheduled[0].cleared, true)
  assert.equal(scheduled[1].cleared, false)
  rc.stop()
  assert.equal(scheduled[1].cleared, true)
})

test('stop() while a tick is still asking: no new timer is booked afterwards', async t => {
  const { timers, scheduled } = makeTimers()
  let release
  const gate = new Promise(r => { release = r })
  const { rc } = await make(t, {
    replies: [async () => { await gate; return { status: 200, body: RELEASE() } }],
    extra: { timers }
  })
  await rc.init()
  rc.start()
  const ticking = scheduled[0].fn()
  await new Promise(r => setImmediate(r))
  rc.stop()
  release()
  await ticking
  assert.deepEqual(scheduled.map(x => x.ms), [INITIAL_DELAY_MS])
})

test('a tick whose booking came before a manual check asks nothing and waits out the rest', async t => {
  const { timers, scheduled } = makeTimers()
  const { rc, calls, clock } = await make(t, { extra: { timers } })
  await rc.init()
  rc.start()
  assert.equal((await rc.checkNow()).ok, true)
  assert.equal(calls.length, 1)
  clock.t += 3_600_000
  await scheduled[0].fn()
  assert.equal(calls.length, 1)
  assert.deepEqual(scheduled.map(x => x.ms), [INITIAL_DELAY_MS, INTERVAL_MS - 3_600_000])
})

test('an isDisabled() that throws counts as "on": the tick asks', async t => {
  const { timers, scheduled } = makeTimers()
  const { rc, calls } = await make(t, { extra: { timers, isDisabled: () => { throw new Error('unreadable') } } })
  await rc.init()
  rc.start()
  await scheduled[0].fn()
  assert.equal(calls.length, 1)
})

test('after stop() a finished tick does not book anything', async t => {
  const { timers, scheduled } = makeTimers()
  const { rc } = await make(t, { extra: { timers } })
  await rc.init()
  rc.start()
  rc.stop()
  await scheduled[0].fn()
  assert.deepEqual(scheduled.map(x => x.ms), [INITIAL_DELAY_MS])
})

test('checkNow() ignores isDisabled() and returns the new status', async t => {
  const { rc, calls } = await make(t, { extra: { isDisabled: () => true } })
  await rc.init()
  const res = await rc.checkNow()
  assert.equal(res.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(res.status.lastOutcome, OUTCOME.OK)
  assert.equal(res.status.comparison, COMPARISON.NEWER)
  assert.equal(res.status.enabled, false)
  assert.equal(rc.cooldownMs, CHECK_NOW_COOLDOWN_MS)
})

test('checkNow() twice in a row: the second is refused with retryAfterMs, then allowed after the cooldown', async t => {
  const { rc, calls, clock } = await make(t)
  await rc.init()
  assert.equal((await rc.checkNow()).ok, true)
  clock.t += 10_000
  const second = await rc.checkNow()
  assert.equal(second.ok, undefined)
  assert.equal(second.retryAfterMs, CHECK_NOW_COOLDOWN_MS - 10_000)
  assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= CHECK_NOW_COOLDOWN_MS)
  assert.equal(calls.length, 1)
  clock.t += CHECK_NOW_COOLDOWN_MS
  assert.equal((await rc.checkNow()).ok, true)
  assert.equal(calls.length, 2)
})

test('the cooldown starts when the manual check ends, not when it starts', async t => {
  const { rc, clock } = await make(t, {
    replies: [() => { clock.t += 45_000; return { status: 200, body: RELEASE() } }]
  })
  await rc.init()
  await rc.checkNow()
  const again = await rc.checkNow()
  assert.equal(again.retryAfterMs, CHECK_NOW_COOLDOWN_MS) // a full minute after the end
})

test('checkNow() while a check is in flight answers { running: true } and fetches once', async t => {
  let release
  const gate = new Promise(r => { release = r })
  const { rc, calls } = await make(t, {
    replies: [async () => { await gate; return { status: 200, body: RELEASE() } }]
  })
  await rc.init()
  const first = rc.checkNow()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(await rc.checkNow(), { running: true })
  release()
  assert.equal((await first).ok, true)
  assert.equal(calls.length, 1)
})

test('a tick during a running check does not start a second request', async t => {
  const { timers, scheduled } = makeTimers()
  let release
  const gate = new Promise(r => { release = r })
  const { rc, calls } = await make(t, {
    replies: [async () => { await gate; return { status: 200, body: RELEASE() } }],
    extra: { timers }
  })
  await rc.init()
  rc.start()
  const running = rc.checkNow()
  await new Promise(r => setImmediate(r))
  await scheduled[0].fn()
  assert.equal(calls.length, 1)
  assert.deepEqual(scheduled.map(x => x.ms), [INITIAL_DELAY_MS, INTERVAL_MS])
  release()
  await running
})

test('checkNow() whose fetch throws still resolves with { ok: true, status } and a failed outcome', async t => {
  const { rc } = await make(t, { replies: [new TypeError('fetch failed')] })
  await rc.init()
  const res = await rc.checkNow()
  assert.equal(res.ok, true)
  assert.equal(res.status.lastOutcome, OUTCOME.FAILED)
  assert.equal(res.status.lastFailKind, FAIL_KIND.UNREACHABLE)
})
