// The M2 data-freshness note, sentence by sentence (shell.js, `dataStatusText`).
//
// WHY ITS OWN FILE AND NOT THE BROWSER SMOKE TEST. shell-load.test.mjs boots the
// real server in headless Chrome and is the right place for "the slot is shared
// and collapses"; it is the wrong place for "does this line say what to do",
// which is a pure function of one message. So the module is evaluated in a vm
// with a bare `document`, exactly as i18n-coverage.test.mjs does with i18n.js.
//
// What is nailed down here is the point of docs/bugs.md B24: the note used to
// carry the duration and the consequence and nothing about the cause, and the
// fix must not replace that with a cause the page made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = p => fileURLToPath(new URL(p, import.meta.url))
const DAY = 86_400_000

// i18n.js + shell.js in one context. shell.js reads a handful of elements at
// load time and guards every one of them, so a document that has nothing is a
// legitimate page for it.
async function loadShell () {
  const ctx = vm.createContext({
    window: {},
    localStorage: undefined,
    // i18n.js reads the `ppt_user` cookie at load to resolve the cached
    // language; shell.js reads a handful of elements. Both take "nothing there"
    // for an answer, which is what makes this test possible without a DOM.
    document: {
      getElementById: () => null,
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
    clearTimeout: () => {},
    setTimeout: () => 0
  })
  vm.runInContext(await readFile(here('i18n.js'), 'utf8'), ctx, { filename: 'i18n.js' })
  vm.runInContext(await readFile(here('shell.js'), 'utf8'), ctx, { filename: 'shell.js' })
  return { Shell: ctx.window.Shell, I18n: ctx.window.I18n }
}

const message = (source, extra = {}) => {
  const now = Date.now()
  return {
    enabled: true,
    staleAfterMs: 3 * DAY,
    since: now - 10 * DAY,
    now,
    receivedAt: now,
    sources: [{ source, lastSuccessAt: now - 5 * DAY, lastOutcome: 'failed', ...extra }]
  }
}

test('without a reason the line is exactly what it always was', async () => {
  // Older servers send no `reason`, and a source can be stale without its last
  // check having failed at all. Neither may grow a sentence out of nothing.
  const { Shell } = await loadShell()
  const text = Shell._dataStatusText(message('base-names'), Date.now())
  assert.match(text, /no successful check of base-names for 5 days/)
  assert.ok(!/failed:/.test(text), 'nothing is claimed about a cause nobody sent')
})

test('an unreachable source names the cause and says there is nothing to do', async () => {
  const { Shell } = await loadShell()
  const text = Shell._dataStatusText(
    message('lang-data', { reason: 'the current patch version could not be looked up at https://example.invalid', failKind: 'unreachable' }),
    Date.now())
  assert.match(text, /Last attempt for lang-data failed: the current patch version could not be looked up/)
  assert.match(text, /nothing to do here/)
})

test('a refused answer says it does not fix itself', async () => {
  const { Shell } = await loadShell()
  const text = Shell._dataStatusText(
    message('apt', { reason: 'snapshot rejected (items.ndjson: namespace UNIQUE missing)', failKind: 'rejected' }),
    Date.now())
  assert.match(text, /namespace UNIQUE missing/)
  assert.match(text, /refused it/)
  assert.ok(!/nothing to do here/.test(text))
})

test('an incompatible format points at the update button, not at a spelling', async () => {
  // The expensive wrong answer this whole pass is about: the generator dying on
  // a schema version used to arrive as advice about a language name.
  const { Shell } = await loadShell()
  const text = Shell._dataStatusText(
    message('lang-data', { reason: 'the game-data export refused the schema of this build', failKind: 'incompatible' }),
    Date.now())
  assert.match(text, /update the container/i)
})

test('an unknown class prints the reason and gives NO advice', async () => {
  const { Shell } = await loadShell()
  const text = Shell._dataStatusText(
    message('apt', { reason: 'something nobody classified', failKind: 'unknown' }),
    Date.now())
  assert.match(text, /something nobody classified/)
  assert.ok(!/nothing to do here/.test(text))
  assert.ok(!/refused it/.test(text))
  assert.ok(!/update the container/i.test(text))
})

test('a class from a newer server shows no advice instead of a missing key', async () => {
  const { Shell } = await loadShell()
  const text = Shell._dataStatusText(
    message('apt', { reason: 'a reason', failKind: 'something-invented-later' }),
    Date.now())
  assert.match(text, /a reason/)
  assert.ok(!/shell\.dataAdvice/.test(text), 'no key leaked into the page')
})

test('the whole line follows the language switch', async () => {
  const { Shell, I18n } = await loadShell()
  I18n.setLang('de')
  const text = Shell._dataStatusText(
    message('lang-data', { reason: 'die Gegenstelle schweigt', failKind: 'unreachable' }),
    Date.now())
  assert.match(text, /Automatische Datenaktualisierung/)
  assert.match(text, /Letzter Versuch für lang-data fehlgeschlagen/)
  assert.match(text, /hier ist nichts zu tun/)
})

test('a fresh source still produces nothing at all', async () => {
  const { Shell } = await loadShell()
  const now = Date.now()
  const text = Shell._dataStatusText({
    enabled: true,
    staleAfterMs: 3 * DAY,
    since: now - 10 * DAY,
    now,
    receivedAt: now,
    sources: [{ source: 'apt', lastSuccessAt: now - 2 * DAY, reason: 'an old failure', failKind: 'rejected' }]
  }, now)
  assert.equal(text, '')
})

// ---------------------------------------------------------------------------
// Two ways onto the line that are not "it has been quiet for days".
// ---------------------------------------------------------------------------

/** A source whose last check is RECENT — nothing about it is stale. */
const fresh = (source, extra = {}) => {
  const now = Date.now()
  return {
    enabled: true,
    staleAfterMs: 3 * DAY,
    since: now - 10 * DAY,
    now,
    receivedAt: now,
    sources: [{ source, lastSuccessAt: now - 60_000, lastOutcome: 'failed', ...extra }]
  }
}

test('a certain diagnosis does not wait three days to be shown', async () => {
  // `incompatible` means the data was reached and READ and the schema does not
  // match this build. That is settled at the moment it is made; holding it back
  // until the source ages past the threshold is three silent days on a known
  // cause — the exact defect the whole line was added to remove.
  const { Shell } = await loadShell()
  const text = Shell._dataStatusText(
    fresh('lang-data', { reason: 'the game-data export refuses this build', failKind: 'incompatible' }),
    Date.now())
  assert.match(text, /the game-data export refuses this build/)
  assert.match(text, /update the container/i)
  assert.ok(!/no successful check/.test(text),
    'it is not stale, and the line must not say it is')
})

test('an uncertain one still does, because there the age IS the information', async () => {
  // An upstream away for a minute is not news, and a run that failed once may
  // succeed on the next tick. Showing these at once would put a line on screen
  // every time anything hiccups.
  const { Shell } = await loadShell()
  for (const failKind of ['unreachable', 'rejected', 'unknown']) {
    assert.equal(
      Shell._dataStatusText(fresh('apt', { reason: 'a fresh failure', failKind }), Date.now()),
      '', failKind)
  }
})

test('a check that SUCCEEDED can still have something to say', async () => {
  // The pinned patch version: the tick works, reports `unchanged`, ages
  // nothing — and the data set is frozen. Without this the only thing that
  // could put it on screen was a staleness that never arrives.
  const { Shell } = await loadShell()
  const now = Date.now()
  const text = Shell._dataStatusText({
    enabled: true,
    staleAfterMs: 3 * DAY,
    since: now - 10 * DAY,
    now,
    receivedAt: now,
    sources: [{
      source: 'lang-data',
      lastSuccessAt: now - 60_000,
      lastOutcome: 'unchanged',
      reason: null,
      failKind: null,
      warning: 'POE_PATCH_VERSION pins the patch to 3.29.2.1; the lookup reports 3.30.0.1.'
    }]
  }, now)
  assert.match(text, /Note on lang-data/)
  assert.match(text, /3\.29\.2\.1/)
  assert.match(text, /3\.30\.0\.1/)
  assert.ok(!/no successful check/.test(text), 'it succeeded — the line must not call it stale')
  assert.ok(!/failed:/.test(text), 'it succeeded — the line must not call it a failure')
  // A warning carries no class, so it gets no advice invented for it.
  assert.ok(!/nothing to do here|refused it|update the container/i.test(text))
})

test('a warning follows the language switch like everything else', async () => {
  const { Shell, I18n } = await loadShell()
  I18n.setLang('de')
  const now = Date.now()
  const text = Shell._dataStatusText({
    enabled: true,
    staleAfterMs: 3 * DAY,
    since: now - 10 * DAY,
    now,
    receivedAt: now,
    sources: [{ source: 'lang-data', lastSuccessAt: now - 60_000, lastOutcome: 'unchanged', warning: 'ein Hinweis' }]
  }, now)
  assert.match(text, /Hinweis zu lang-data: ein Hinweis/)
})
