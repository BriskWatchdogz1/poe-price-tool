// Sync-status plumbing on the pages (docs/bugs.md-style regression file):
//
//  A1  networth.js used to hand `applySyncStatus` only { state, until }, so the
//      `mine` / `tradeBan` fields that pick the sentence never arrived and a
//      trade-API ban read as an ordinary rate limit.
//  A2  the "POESESSID expired, background sync paused" state was visible on the
//      Net Worth and settings pages only; History and Price Check never looked
//      at `networth-sync-status`. Shell.applySyncStatus puts it on the shared
//      status line.
//  A3  the "tabs fresh" counter used a fixed 10 min threshold that no client
//      knows the real round length for (interval, user count are not in any
//      message), so the label now says what is measured and nothing more.
//
// networth-sync.js is a plain ES module (the pure part of the Net Worth page);
// shell.js is evaluated in a vm with a fake status element, the way
// data-status-line.test.mjs does it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { syncStatusLine, sessionRoundLine, syncLineText, autosyncSummary, SYNCED_RECENTLY_MS } from './networth-sync.js'

const here = p => fileURLToPath(new URL(p, import.meta.url))
const MIN = 60_000

// ---- A1 ---------------------------------------------------------------------
test('A1: a trade-API ban picks the trade-ban sentence, not the plain rate limit', () => {
  const until = 1_700_000_000_000
  assert.deepEqual(syncStatusLine({ state: 'cooldown', until, tradeBan: true }),
    { key: 'nw.syncTradeBan', timed: true, until })
  // `mine` must not change the verdict when tradeBan is set (a ban belongs to nobody's session).
  assert.equal(syncStatusLine({ state: 'cooldown', until, tradeBan: true, mine: false }).key, 'nw.syncTradeBan')
})

test('A1: a bystander cooldown and our own cooldown read differently; a missing `mine` reads as ours', () => {
  assert.equal(syncStatusLine({ state: 'cooldown', until: 1, mine: false }).key, 'nw.syncCooldownOther')
  assert.equal(syncStatusLine({ state: 'cooldown', until: 1, mine: true }).key, 'nw.syncCooldown')
  assert.equal(syncStatusLine({ state: 'cooldown', until: 1 }).key, 'nw.syncCooldown')
})

test('A1: the other states and the empty case', () => {
  assert.equal(syncStatusLine({ state: 'expired' }).key, 'nw.syncExpired')
  assert.equal(syncStatusLine({ state: 'missing' }).key, 'nw.syncMissing')
  assert.equal(syncStatusLine({ state: 'ok' }), null)
  assert.equal(syncStatusLine(null), null)
})

test('A1: networth.js hands the whole message to applySyncStatus', async () => {
  // The page script is a browser module (imports, DOM at load), so it cannot be
  // run here; the wiring is pinned at the source: the handler must not pick fields.
  const src = await readFile(here('networth.js'), 'utf8')
  const m = src.match(/case 'networth-sync-status':\s*\n\s*(applySyncStatus\([^\n]*\))/)
  assert.ok(m, "networth.js has a case 'networth-sync-status' that calls applySyncStatus")
  assert.equal(m[1], 'applySyncStatus(msg)')
})

// ---- A2 ---------------------------------------------------------------------
async function loadShell () {
  const lines = []
  const statusEl = {
    hidden: true,
    _kids: [],
    set textContent (v) { this._kids = [] },
    appendChild (el) { this._kids.push(el) }
  }
  const ctx = vm.createContext({
    window: {},
    localStorage: undefined,
    document: {
      getElementById: id => (id === 'appStatus' ? statusEl : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ className: '', dataset: {}, textContent: '' }),
      addEventListener: () => {},
      readyState: 'complete',
      documentElement: null,
      title: '',
      cookie: ''
    },
    fetch: async () => { throw new Error('no network in this test') },
    setInterval: () => 0,
    clearTimeout: () => {},
    setTimeout: () => 0
  })
  vm.runInContext(await readFile(here('i18n.js'), 'utf8'), ctx, { filename: 'i18n.js' })
  vm.runInContext(await readFile(here('shell.js'), 'utf8'), ctx, { filename: 'shell.js' })
  const line = key => {
    const el = statusEl._kids.find(k => k.dataset.statusKey === key)
    return el ? el.textContent : undefined
  }
  return { Shell: ctx.window.Shell, I18n: ctx.window.I18n, statusEl, line, lines }
}

test('A2: an expired cookie puts the paused-sync sentence on the shared status line', async () => {
  const { Shell, line, statusEl } = await loadShell()
  Shell.applySyncStatus({ type: 'networth-sync-status', state: 'expired' })
  assert.match(line('sync'), /Background sync is paused: the stored POESESSID has expired\. Renew it on the settings page\./)
  assert.equal(statusEl.hidden, false)
})

test('A2: any other state clears the sync key again and leaves the data key alone', async () => {
  const { Shell, line, statusEl } = await loadShell()
  Shell.setStatus('data note', 'data')
  Shell.applySyncStatus({ state: 'expired' })
  assert.ok(line('sync'))
  for (const state of ['ok', 'cooldown', 'missing']) {
    Shell.applySyncStatus({ state: 'expired' })
    Shell.applySyncStatus({ state, until: 1 })
    assert.equal(line('sync'), undefined, `state ${state} must not leave the expired sentence`)
  }
  assert.equal(line('data'), 'data note')
  assert.equal(statusEl.hidden, false)
})

test('A2: History and Price Check call Shell.applySyncStatus on the message', async () => {
  for (const f of ['history.js', 'app.js']) {
    const src = await readFile(here(f), 'utf8')
    assert.match(src, /case 'networth-sync-status':\s*(window\.)?Shell\.applySyncStatus\(msg\)/, `${f} routes networth-sync-status to the shell`)
  }
  // networth.js / settings.js keep their richer line and must NOT also call the shell (double line).
  for (const f of ['networth.js', 'settings.js']) {
    assert.ok(!/Shell\.applySyncStatus/.test(await readFile(here(f), 'utf8')), `${f} does not use Shell.applySyncStatus`)
  }
})

// ---- A3 ---------------------------------------------------------------------
test('A3: counts tabs synced inside the window, and reports the oldest in minutes', () => {
  const now = 10_000_000_000
  const tabs = [
    { syncedAt: now - 1 * MIN },
    { syncedAt: now - 9 * MIN },
    { syncedAt: now - 11 * MIN },
    { syncedAt: now - 120 * MIN },
    { name: 'never synced' } // no stamp: not part of the line at all
  ]
  assert.equal(SYNCED_RECENTLY_MS, 10 * MIN)
  assert.deepEqual(autosyncSummary(tabs, now), { recent: 2, total: 4, mins: 120, windowMins: 10 })
})

test('A3: no stamped tab means no summary (the page shows "syncing in background")', () => {
  assert.equal(autosyncSummary([], 1), null)
  assert.equal(autosyncSummary([{ name: 'x' }], 1), null)
  assert.equal(autosyncSummary(null, 1), null)
})

test('A3: the label says "synced in the last N min", not "fresh"', async () => {
  const { I18n } = await loadShell()
  const s = { recent: 3, total: 65, mins: 140, windowMins: 10 }
  const en = I18n.t('nw.autosync', s)
  assert.match(en, /3\/65 tabs synced in the last 10 min/)
  assert.ok(!/fresh/.test(en))
})

// ---- Sync follows the game (`pace`) -----------------------------------------
test('the pace is said only while the sync runs normally', () => {
  assert.deepEqual(syncStatusLine({ state: 'ok', pace: { mode: 'yields', everyMs: 300_000 } }),
    { key: 'nw.syncYields', timed: false, until: null, min: 5, info: true })
  assert.deepEqual(syncStatusLine({ state: 'ok', pace: { mode: 'rests', everyMs: 300_000 } }),
    { key: 'nw.syncRests', timed: false, until: null, min: 5, info: true })
  assert.equal(syncStatusLine({ state: 'ok', pace: { mode: 'rests', everyMs: 0 } }).key, 'nw.syncRestsFully')
  assert.equal(syncStatusLine({ state: 'ok', pace: { mode: 'yields', everyMs: 0 } }).key, 'nw.syncYieldsFully',
    'with IDLE_REST a yielding user rests because the own game is not running; others still play')
  assert.equal(syncStatusLine({ state: 'ok', pace: { mode: 'yields', everyMs: 20_000 } }).min, 1, 'never "0 min"')
  const until = 1_700_000_000_000
  assert.equal(syncStatusLine({ state: 'cooldown', until, pace: { mode: 'yields', everyMs: 300_000 } }).key, 'nw.syncCooldown',
    'a cooldown is said, not the pace (no pace applies during one)')
  assert.equal(syncStatusLine({ state: 'expired', pace: { mode: 'rests', everyMs: 300_000 } }).key, 'nw.syncExpired')
  assert.equal(syncStatusLine({ state: 'ok' }), null, 'without pace: null as before')
  assert.equal(syncStatusLine({ state: 'ok', pace: { mode: 'banana', everyMs: 1 } }), null, 'an unknown mode says nothing')
})

test('the shared status line names the pace on History and Price Check, and drops it with the state', async () => {
  const { Shell, line } = await loadShell()
  Shell.applySyncStatus({ type: 'networth-sync-status', state: 'ok', pace: { mode: 'yields', everyMs: 300_000 } })
  assert.match(line('sync'), /Sync yields: your game is not running — about one tab every 5 min/)
  Shell.applySyncStatus({ state: 'ok', pace: { mode: 'rests', everyMs: 300_000 } })
  assert.match(line('sync'), /Sync rests: no game running anywhere — about one tab every 5 min/)
  Shell.applySyncStatus({ state: 'ok', pace: { mode: 'rests', everyMs: 0 } })
  assert.match(line('sync'), /Sync rests while nobody plays/)
  Shell.applySyncStatus({ state: 'ok', pace: { mode: 'yields', everyMs: 0 } })
  assert.match(line('sync'), /Sync rests while your game is not running/)
  assert.doesNotMatch(line('sync'), /nobody/)
  Shell.applySyncStatus({ state: 'cooldown', until: 1, pace: { mode: 'rests', everyMs: 300_000 } })
  assert.equal(line('sync'), undefined, 'only with state ok')
  Shell.applySyncStatus({ state: 'ok' })
  assert.equal(line('sync'), undefined)
})

test('the pace texts exist in both languages', async () => {
  const { I18n } = await loadShell()
  for (const lang of ['en', 'de']) {
    for (const key of ['nw.syncYields', 'nw.syncRests', 'nw.syncRestsFully', 'nw.syncYieldsFully', 'shell.syncYields', 'shell.syncRests', 'shell.syncRestsFully', 'shell.syncYieldsFully']) {
      assert.ok(I18n.STRINGS[lang][key], `${lang} ${key}`)
    }
  }
})

test('a pace line keeps its pace when a cooldown ends on the page, and does not open the settings', async () => {
  for (const f of ['networth.js', 'settings.js']) {
    const src = await readFile(here(f), 'utf8')
    assert.match(src, /applySyncStatus\(\{ \.\.\.syncStatus, state: 'ok', until: null \}\)/, `${f} keeps pace after a local cooldown end`)
  }
  const nw = await readFile(here('networth.js'), 'utf8')
  assert.match(nw, /line\.info/, 'networth.js does not navigate for an informational line')
  const st = await readFile(here('settings.js'), 'utf8')
  assert.match(st, /import \{[^}]*\bsyncLineText\b[^}]*\} from '\.\/networth-sync\.js'/, 'settings.js uses the same sentence choice')
})

// ---- session round (`sessionRound`, refresher.prioritize) --------------------
test('a session round is said while the sync runs normally, with how far it has come', () => {
  const sessionRound = { done: 3, total: 40, since: 1 }
  assert.deepEqual(sessionRoundLine({ state: 'ok', sessionRound }), { key: 'nw.syncSessionRound', done: 3, total: 40, info: true })
  assert.equal(sessionRoundLine({ state: 'ok' }), null, 'no round, no line')
  assert.equal(sessionRoundLine({ state: 'cooldown', until: 1, sessionRound }), null, 'a cooldown is said instead')
  assert.equal(sessionRoundLine({ state: 'expired', sessionRound }), null)
  assert.equal(sessionRoundLine({ state: 'ok', sessionRound: { done: 0, total: 0 } }), null, 'no tab list yet')
  assert.equal(sessionRoundLine({ state: 'ok', sessionRound: { done: 'x', total: 40 } }), null)
  assert.equal(sessionRoundLine(null), null)
})

test('the shared status line names the session round, next to a pace, in both languages', async () => {
  const { Shell, I18n, line } = await loadShell()
  Shell.applySyncStatus({ type: 'networth-sync-status', state: 'ok', sessionRound: { done: 3, total: 40, since: 1 } })
  assert.equal(line('sync'), 'Reading every tab once for the session (3 of 40).')
  I18n.setLang('de')
  assert.equal(line('sync'), 'Jeder Tab wird für die Sitzung einmal gelesen (3 von 40).')
  I18n.setLang('en')
  Shell.applySyncStatus({ state: 'ok', pace: { mode: 'yields', everyMs: 300_000 }, sessionRound: { done: 5, total: 40, since: 1 } })
  assert.equal(line('sync'), 'Sync yields: your game is not running — about one tab every 5 min. Reading every tab once for the session (5 of 40).')
  Shell.applySyncStatus({ state: 'ok' })
  assert.equal(line('sync'), undefined, 'the round is over: the line goes')
})

test('Net Worth and settings write the session round on their own sync line, in both languages', async () => {
  // syncLineText is the whole line both pages write under the `sync` key,
  // translated with the real i18n.js tables.
  const { I18n } = await loadShell()
  const T = (k, p) => I18n.t(k, p)
  const sessionRound = { done: 3, total: 40, since: 1 }
  assert.equal(syncLineText({ state: 'ok', sessionRound }, T, 'en'), 'Reading every tab once for the session (3 of 40).')
  assert.equal(syncLineText({ state: 'ok', pace: { mode: 'yields', everyMs: 300_000 }, sessionRound }, T, 'en'),
    'Sync yields: your game is not running — about one tab every 5 min. Reading every tab once for the session (3 of 40).')
  assert.equal(syncLineText({ state: 'ok' }, T, 'en'), '', 'a plain ok leaves the slot empty')
  assert.doesNotMatch(syncLineText({ state: 'cooldown', until: 1, sessionRound }, T, 'en'), /for the session/,
    'a cooldown is said instead of the round')
  assert.doesNotMatch(syncLineText({ state: 'expired', sessionRound }, T, 'en'), /for the session/)
  I18n.setLang('de')
  assert.equal(syncLineText({ state: 'ok', sessionRound }, T, 'de'), 'Jeder Tab wird für die Sitzung einmal gelesen (3 von 40).')
  // Both pages write exactly this line (they cannot run here: browser
  // modules with DOM at load), so the wiring is pinned at the source.
  for (const f of ['networth.js', 'settings.js']) {
    const src = await readFile(here(f), 'utf8')
    assert.match(src, /function statusLineText \(st\) \{\n\s*return syncLineText\(st, T, I18n\.locale\(\)\)\n\}/, `${f} writes the shared line`)
    assert.match(src, /setStatus\(statusLineText\(st\)|const text = statusLineText\(st\)/, `${f} puts it on the sync line`)
  }
})
