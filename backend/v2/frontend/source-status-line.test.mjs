// The price-source lines on the shared status slot (shell.js: `sources`,
// `blind`) and the ageing C:D tile — docs/bugs.md B29.
//
// Same approach as data-status-line.test.mjs and release-status-line.test.mjs:
// i18n.js and shell.js run in a vm with a minimal fake `#appStatus`. What is
// pinned here is that a price source going quiet is said on every page, with
// its age and its reason, and that nothing is said while the sources are fine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = p => fileURLToPath(new URL(p, import.meta.url))
const MIN = 60 * 1000
const HOUR = 60 * MIN

function fakeElement () {
  return {
    hidden: true,
    className: '',
    dataset: {},
    children: [],
    _text: '',
    set textContent (v) { this._text = String(v); if (v === '') this.children = [] },
    get textContent () { return this._text || this.children.map(c => c.textContent).join(' ') },
    appendChild (c) { this.children.push(c); return c }
  }
}

async function loadShell () {
  const slot = fakeElement()
  const ctx = vm.createContext({
    window: {},
    localStorage: undefined,
    document: {
      getElementById: id => (id === 'appStatus' ? slot : null),
      createElement: () => fakeElement(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      readyState: 'complete',
      documentElement: null,
      title: '',
      cookie: ''
    },
    fetch: async () => { throw new Error('no network in this test') },
    setInterval: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    setTimeout: () => 0
  })
  vm.runInContext(await readFile(here('i18n.js'), 'utf8'), ctx, { filename: 'i18n.js' })
  vm.runInContext(await readFile(here('shell.js'), 'utf8'), ctx, { filename: 'shell.js' })
  return { Shell: ctx.window.Shell, I18n: ctx.window.I18n, slot }
}

/** A source-status message; `over` overrides per source id. */
function message (over = {}, now = Date.now()) {
  const base = {
    faustus: { enabled: true, scheduled: true, staleAfterMs: 3 * HOUR },
    'ninja-cd': { enabled: true, scheduled: true, staleAfterMs: 3 * HOUR },
    'ninja-overview': { enabled: true, scheduled: false, staleAfterMs: 3 * HOUR },
    trade: { enabled: true, scheduled: false, staleAfterMs: null, pausedUntil: null }
  }
  return {
    type: 'source-status',
    now,
    receivedAt: now,
    since: now - 48 * HOUR,
    sources: Object.keys(base).map(id => ({
      source: id,
      lastSuccessAt: now - 10 * MIN,
      lastFailureAt: null,
      reason: null,
      failKind: null,
      ...base[id],
      ...(over[id] || {})
    }))
  }
}

test('a fresh set of sources says nothing', async () => {
  const { Shell } = await loadShell()
  const m = message()
  assert.equal(Shell._sourcesStatusText(m, m.now), '')
  assert.equal(Shell._blindStatusText(m, m.now), '')
})

test('a stale, failing poe.ninja overview names source, age and reason', async () => {
  const { Shell } = await loadShell()
  const now = Date.now()
  const m = message({ 'ninja-overview': { lastSuccessAt: now - 5 * HOUR, lastFailureAt: now - MIN, reason: 'HTTP 503', failKind: 'unreachable' } }, now)
  assert.match(Shell._sourcesStatusText(m, now),
    /Price sources are behind: poe\.ninja prices: 5 hours old \(last failure: HTTP 503\)\./)
})

test('a scheduled source that is old without a failure says the refresh is not running; an on-demand source that is old but not failing says nothing', async () => {
  const { Shell } = await loadShell()
  const now = Date.now()
  const a = message({ faustus: { lastSuccessAt: now - 4 * HOUR } }, now)
  assert.match(Shell._sourcesStatusText(a, now), /the refresh is not running/)
  const b = message({ 'ninja-overview': { lastSuccessAt: now - 10 * HOUR } }, now)
  assert.equal(Shell._sourcesStatusText(b, now), '')
})

test('a source with no success at all is measured from the server start', async () => {
  const { Shell } = await loadShell()
  const now = Date.now()
  const m = message({ 'ninja-cd': { lastSuccessAt: null, lastFailureAt: now - MIN, reason: 'network error: ETIMEDOUT' } }, now)
  assert.match(Shell._sourcesStatusText(m, now), /no successful update for 2 days \(last failure: network error: ETIMEDOUT\)/)
})

test('the Sources block never calls a source current that has not answered since the start', async () => {
  const { Shell, I18n } = await loadShell()
  const now = Date.now()
  const m = message({
    // asked at boot, failed, still inside its threshold (since = 1 h ago)
    'ninja-cd': { lastSuccessAt: null, lastFailureAt: now - MIN, reason: 'HTTP 503' },
    // never asked
    'ninja-overview': { lastSuccessAt: null },
    // on-demand, never stale by age: a failed search without any success
    trade: { lastSuccessAt: null, lastFailureAt: now - MIN, reason: 'HTTP 500' }
  }, now)
  m.since = now - HOUR
  const states = Object.fromEntries(Shell.sourceView(m, now).map(v => [v.source, Shell.sourceState(v)]))
  assert.deepEqual(states, { faustus: 'ok', 'ninja-cd': 'noAnswer', 'ninja-overview': 'unused', trade: 'noAnswer' })
  assert.equal(I18n.t('src.state.noAnswer'), 'no answer yet')

  // an old on-demand success without a failure stays current; the same past
  // its threshold for a scheduled source is stale
  const old = message({ 'ninja-overview': { lastSuccessAt: now - 10 * HOUR }, faustus: { lastSuccessAt: now - 10 * HOUR } }, now)
  const s2 = Object.fromEntries(Shell.sourceView(old, now).map(v => [v.source, Shell.sourceState(v)]))
  assert.equal(s2['ninja-overview'], 'ok')
  assert.equal(s2.faustus, 'stale')
})

test('a disabled source is never stale and never counts towards blind', async () => {
  const { Shell } = await loadShell()
  const now = Date.now()
  const m = message({ faustus: { enabled: false, lastSuccessAt: now - 40 * HOUR } }, now)
  assert.ok(!/Faustus/.test(Shell._sourcesStatusText(m, now)))
  assert.equal(Shell._blindStatusText(m, now), '')
})

test('all price sources stale gives the blind line with the freshest age', async () => {
  const { Shell } = await loadShell()
  const now = Date.now()
  const m = message({
    faustus: { lastSuccessAt: now - 6 * HOUR },
    'ninja-cd': { lastSuccessAt: now - 4 * HOUR },
    'ninja-overview': { lastSuccessAt: now - 5 * HOUR, lastFailureAt: now - MIN, reason: 'HTTP 503' }
  }, now)
  assert.match(Shell._blindStatusText(m, now), /partly blind: no price source has updated for 4 hours/)
})

test('the blind age is the youngest SUCCESS, not the server start of a source that never succeeded', async () => {
  const { Shell } = await loadShell()
  const now = Date.now()
  // A restart 2 min ago, poe.ninja unreachable since, the Faustus store 5 h old.
  const m = message({
    faustus: { lastSuccessAt: now - 5 * HOUR, lastFailureAt: now - MIN, reason: 'HTTP 503' },
    'ninja-cd': { lastSuccessAt: null, lastFailureAt: now - MIN, reason: 'network error: ETIMEDOUT' },
    'ninja-overview': { lastSuccessAt: null, lastFailureAt: now - MIN, reason: 'network error: ETIMEDOUT' }
  }, now)
  m.since = now - 2 * MIN
  const text = Shell._blindStatusText(m, now)
  assert.match(text, /partly blind: no price source has updated for 5 hours/)
  assert.ok(!/0 hours/.test(text), text)
})

test('with no success at all the blind line counts from the server start and says so', async () => {
  const { Shell } = await loadShell()
  const now = Date.now()
  const never = { lastSuccessAt: null, lastFailureAt: now - MIN, reason: 'network error: ETIMEDOUT' }
  const m = message({ faustus: never, 'ninja-cd': never, 'ninja-overview': never }, now)
  m.since = now - 4 * HOUR
  assert.match(Shell._blindStatusText(m, now),
    /partly blind: no price source has updated since the server started 4 hours ago/)
})

test('a trade pause alone puts no blind line; a pause plus an expired cookie does; a pause past its until is gone', async () => {
  const { Shell } = await loadShell()
  const now = Date.now()
  const paused = message({ trade: { pausedUntil: now + HOUR } }, now)
  assert.equal(Shell._blindStatusText(paused, now), '')
  Shell.noteSyncState('expired')
  assert.match(Shell._blindStatusText(paused, now),
    /trade searches paused until .*, stash sync stopped \(POESESSID expired\)/)
  const over = message({ trade: { pausedUntil: now - MIN } }, now)
  assert.equal(Shell._blindStatusText(over, now), '', 'the cookie alone has its own line already')
})

test('status keys render in the order blind, sync, sources, data, release', async () => {
  const { Shell, slot } = await loadShell()
  for (const k of ['release', 'data', 'sources', 'sync', 'blind']) Shell.setStatus(`${k} line`, k)
  assert.deepEqual(slot.children.map(c => c.dataset.statusKey), ['blind', 'sync', 'sources', 'data', 'release'])
  assert.equal(slot.children[0].className, 'statusmsg blind')
  assert.equal(slot.children[1].className, 'statusmsg')
})

test('applySourceStatus puts both lines on the slot and noteSyncState does not write the sync line', async () => {
  const { Shell, slot } = await loadShell()
  const now = Date.now()
  Shell.noteSyncState('expired')
  assert.equal(slot.children.some(c => c.dataset.statusKey === 'sync'), false)
  Shell.applySourceStatus(message({
    faustus: { lastSuccessAt: now - 6 * HOUR },
    'ninja-cd': { lastSuccessAt: now - 4 * HOUR },
    trade: { pausedUntil: now + HOUR }
  }, now))
  const keys = slot.children.map(c => c.dataset.statusKey)
  assert.deepEqual(keys, ['blind', 'sources'])
})

test('the C:D tile turns stale after staleAfterMs and stays on the server hint before', async () => {
  const { Shell } = await loadShell()
  const now = Date.now()
  const msg = asOf => ({ trendHint: 'live · poe.ninja', asOf, staleAfterMs: 3 * HOUR, now, receivedAt: now })
  const old = Shell._cdTrendText(msg(now - 5 * HOUR), now)
  assert.equal(old.text, 'stale · poe.ninja · 5 h')
  assert.equal(old.stale, true)
  const young = Shell._cdTrendText(msg(now - HOUR), now)
  assert.equal(young.text, 'live · poe.ninja')
  assert.equal(young.stale, false)
  assert.equal(Shell._cdTrendText({ trendHint: 'fallback', chaosPerDivine: 215 }, now).text, 'fallback')
  // A page left open keeps ageing without a new message.
  assert.equal(Shell._cdTrendText(msg(now - 2 * HOUR), now + 2 * HOUR).stale, true)
})

test('German follows a language switch', async () => {
  const { Shell, I18n } = await loadShell()
  I18n.setLang('de')
  const now = Date.now()
  const m = message({ 'ninja-overview': { lastSuccessAt: now - 5 * HOUR, lastFailureAt: now - MIN, reason: 'HTTP 503' } }, now)
  assert.match(Shell._sourcesStatusText(m, now),
    /Preisquellen hängen hinterher: poe\.ninja-Preise: 5 Stunden alt \(letzter Fehler: HTTP 503\)\./)
  const cd = Shell._cdTrendText({ trendHint: 'live · poe.ninja', asOf: now - 5 * HOUR, staleAfterMs: 3 * HOUR, now, receivedAt: now }, now)
  assert.equal(cd.text, 'veraltet · poe.ninja · 5 Std.')
})

test('German puts the age after "seit" in the dative, and one hour is singular', async () => {
  const { Shell, I18n } = await loadShell()
  I18n.setLang('de')
  const now = Date.now()
  // since = now - 48 h in message(): a source that never succeeded is 2 days old.
  const never = message({ 'ninja-cd': { lastSuccessAt: null, lastFailureAt: now - MIN, reason: 'HTTP 503' } }, now)
  never.since = now - 3 * 24 * HOUR
  assert.match(Shell._sourcesStatusText(never, now), /poe\.ninja Chaos:Divine: seit 3 Tagen keine erfolgreiche Aktualisierung/)
  const blind = message({
    faustus: { lastSuccessAt: now - 3 * 24 * HOUR },
    'ninja-cd': { lastSuccessAt: now - 3 * 24 * HOUR },
    'ninja-overview': { lastSuccessAt: now - 3 * 24 * HOUR, lastFailureAt: now - MIN, reason: 'HTTP 503' }
  }, now)
  assert.match(Shell._blindStatusText(blind, now), /keine Preisquelle seit 3 Tagen aktualisiert/)
  const oneHour = message({ 'ninja-overview': { staleAfterMs: HOUR, lastSuccessAt: now - 90 * MIN, lastFailureAt: now - MIN, reason: 'HTTP 503' } }, now)
  assert.match(Shell._sourcesStatusText(oneHour, now), /poe\.ninja-Preise: 1 Stunde alt/)
  I18n.setLang('en')
  assert.match(Shell._sourcesStatusText(oneHour, now), /poe\.ninja prices: 1 hour old/)
})

test('every page routes source-status to the shell; Net Worth and Settings report the sync state without writing the sync line', async () => {
  for (const f of ['app.js', 'history.js', 'networth.js', 'settings.js']) {
    const src = await readFile(here(f), 'utf8')
    assert.match(src, /case 'source-status':\s*(window\.)?Shell\.applySourceStatus\(msg\)/, `${f} routes source-status to the shell`)
  }
  for (const f of ['networth.js', 'settings.js']) {
    const src = await readFile(here(f), 'utf8')
    assert.match(src, /Shell\.noteSyncState\(/, `${f} tells the shell the sync state`)
    assert.ok(!/Shell\.applySyncStatus/.test(src), `${f} must not write the shared sync line (double line)`)
  }
})
