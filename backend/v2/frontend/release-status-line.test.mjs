// The "a newer release is out" line on the shared status slot (shell.js,
// `applyReleaseStatus`).
//
// Same approach as data-status-line.test.mjs: i18n.js and shell.js are evaluated
// in a vm. This test needs the slot itself, so `#appStatus` is a minimal fake
// element (children, `textContent`, `hidden`) instead of the null the
// text-only tests get away with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = p => fileURLToPath(new URL(p, import.meta.url))

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
    clearTimeout: () => {},
    setTimeout: () => 0
  })
  vm.runInContext(await readFile(here('i18n.js'), 'utf8'), ctx, { filename: 'i18n.js' })
  vm.runInContext(await readFile(here('shell.js'), 'utf8'), ctx, { filename: 'shell.js' })
  return { Shell: ctx.window.Shell, I18n: ctx.window.I18n, slot }
}

const releaseEntries = slot => slot.children.filter(c => c.dataset.statusKey === 'release')

test('a newer release puts one line on the slot with both versions', async () => {
  const { Shell, slot } = await loadShell()
  Shell.applyReleaseStatus({ comparison: 'newer', installed: '0.1.0', latest: { version: '0.2.0' } })
  assert.equal(slot.hidden, false)
  const entries = releaseEntries(slot)
  assert.equal(entries.length, 1)
  assert.match(entries[0].textContent, /0\.2\.0/)
  assert.match(entries[0].textContent, /0\.1\.0/)
})

test('the line goes away again when the server is up to date', async () => {
  const { Shell, slot } = await loadShell()
  Shell.applyReleaseStatus({ comparison: 'newer', installed: '0.1.0', latest: { version: '0.2.0' } })
  Shell.applyReleaseStatus({ comparison: 'current', installed: '0.2.0', latest: { version: '0.2.0' } })
  assert.equal(releaseEntries(slot).length, 0)
  assert.equal(slot.hidden, true, 'the slot collapses when the last entry is gone')
})

test('unknown shows nothing and does not throw', async () => {
  const { Shell, slot } = await loadShell()
  Shell.applyReleaseStatus({ comparison: 'unknown', installed: null, latest: null })
  assert.equal(releaseEntries(slot).length, 0)
  assert.equal(slot.hidden, true)
  // A message from a server that sends less than this one must not throw either.
  assert.doesNotThrow(() => Shell.applyReleaseStatus({}))
  assert.doesNotThrow(() => Shell.applyReleaseStatus(null))
  assert.equal(releaseEntries(slot).length, 0)
})

test('a newer message without a latest version shows nothing instead of "undefined"', async () => {
  const { Shell, slot } = await loadShell()
  Shell.applyReleaseStatus({ comparison: 'newer', installed: '0.1.0', latest: null })
  assert.equal(releaseEntries(slot).length, 0)
})

test('the line follows the language switch', async () => {
  const { Shell, I18n, slot } = await loadShell()
  Shell.applyReleaseStatus({ comparison: 'newer', installed: '0.1.0', latest: { version: '0.2.0' } })
  assert.match(releaseEntries(slot)[0].textContent, /is out/)
  I18n.setLang('de')
  const text = releaseEntries(slot)[0].textContent
  assert.doesNotMatch(text, /is out/)
  assert.match(text, /erschienen/)
  assert.match(text, /0\.2\.0/)
})

test('it sits after the sync and data entries', async () => {
  const { Shell, slot } = await loadShell()
  Shell.applyReleaseStatus({ comparison: 'newer', installed: '0.1.0', latest: { version: '0.2.0' } })
  Shell.setStatus('sync line', 'sync')
  Shell.setStatus('data line', 'data')
  assert.deepEqual(slot.children.map(c => c.dataset.statusKey), ['sync', 'data', 'release'])
})
