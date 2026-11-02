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
import { syncStatusLine, autosyncSummary, SYNCED_RECENTLY_MS } from './networth-sync.js'

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
