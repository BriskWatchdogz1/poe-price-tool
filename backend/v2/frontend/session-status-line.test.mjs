// The running farm session, else the running game session, on the shared
// status slot (shell.js, `applySessionStatus`, fed by the `networth-session`
// message).
//
// Same approach as release-status-line.test.mjs: i18n.js and shell.js are
// evaluated in a vm, with `#appStatus` as a minimal fake element.
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

const sessionEntries = slot => slot.children.filter(c => c.dataset.statusKey === 'session')

test('a running session puts one line with duration and loot in divine, in both languages', async () => {
  const { Shell, I18n, slot } = await loadShell()
  // The server's clock is the one the duration is aged against.
  const T0 = Date.now()
  Shell.applySessionStatus({ now: T0, running: { kind: 'farm', state: 'running', startedAt: T0 - 72 * 60000, loot: 731.2, lootDiv: 3.4 }, game: null, pending: 0 })
  let e = sessionEntries(slot)
  assert.equal(e.length, 1)
  assert.equal(e[0].textContent, 'Farm session 1:12 h · loot +3.4 div')
  I18n.setLang('de')
  e = sessionEntries(slot)
  assert.equal(e[0].textContent, 'Farm-Sitzung 1:12 h · Beute +3,4 div')
})

test('without a rate the loot is in chaos; running null clears the line', async () => {
  const { Shell, slot } = await loadShell()
  const T0 = Date.now()
  Shell.applySessionStatus({ now: T0, running: { kind: 'farm', state: 'running', startedAt: T0 - 5 * 60000, loot: -42.4, lootDiv: null }, pending: 0 })
  assert.match(sessionEntries(slot)[0].textContent, /−42c$/)
  Shell.applySessionStatus({ now: T0, running: { kind: 'farm', state: 'running', startedAt: T0, loot: null, lootDiv: null }, pending: 0 })
  assert.match(sessionEntries(slot)[0].textContent, /—$/, 'no point to measure against yet: no figure, not a zero')
  Shell.applySessionStatus({ now: T0, running: null, pending: 0 })
  assert.equal(sessionEntries(slot).length, 0)
  assert.equal(slot.hidden, true, 'the slot collapses when the session line was the only one')
})

test('a changed stash shows no loot figure, in both languages', async () => {
  const { Shell, I18n, slot } = await loadShell()
  const T0 = Date.now()
  // The whole content of a re-read tab would otherwise read as farmed loot.
  Shell.applySessionStatus({ now: T0, running: { kind: 'farm', state: 'running', startedAt: T0 - 40 * 60000, loot: 10000, lootDiv: 50, stashChanged: true }, pending: 0 })
  assert.equal(sessionEntries(slot)[0].textContent, 'Farm session 0:40 h · stash tabs changed, no loot figure')
  I18n.setLang('de')
  assert.equal(sessionEntries(slot)[0].textContent, 'Farm-Sitzung 0:40 h · Stash-Tabs geändert, keine Beutezahl')
})

test('without a farm session the line shows the game session; a farm session in it takes the line', async () => {
  const { Shell, I18n, slot } = await loadShell()
  const T0 = Date.now()
  const game = { id: 'g-1', kind: 'game', state: 'running', startedAt: T0 - 180 * 60000, loot: 1500, lootDiv: 7.5 }
  Shell.applySessionStatus({ now: T0, running: null, game, pending: 0 })
  assert.equal(sessionEntries(slot)[0].textContent, 'Game session 3:00 h · loot +7.5 div')
  I18n.setLang('de')
  assert.equal(sessionEntries(slot)[0].textContent, 'Spielsitzung 3:00 h · Beute +7,5 div')
  I18n.setLang('en')
  const farm = { id: 's-1', kind: 'farm', parent: 'g-1', state: 'running', startedAt: T0 - 20 * 60000, loot: 100, lootDiv: 0.5 }
  Shell.applySessionStatus({ now: T0, running: farm, game, pending: 0 })
  const e = sessionEntries(slot)
  assert.equal(e.length, 1, 'one line, not one per kind')
  assert.equal(e[0].textContent, 'Farm session 0:20 h · loot +0.5 div')
  Shell.applySessionStatus({ now: T0, running: null, game: null, pending: 1 })
  assert.equal(sessionEntries(slot).length, 0)
})

test('a starting session says its baseline is still to come instead of a figure', async () => {
  const { Shell, I18n, slot } = await loadShell()
  const T0 = Date.now()
  Shell.applySessionStatus({ now: T0, running: { kind: 'farm', state: 'starting', baseline: null, startedAt: T0 - 2 * 60000, loot: null, lootDiv: null }, game: null, pending: 0 })
  assert.equal(sessionEntries(slot)[0].textContent, 'Farm session 0:02 h · baseline with the next full read')
  I18n.setLang('de')
  assert.equal(sessionEntries(slot)[0].textContent, 'Farm-Sitzung 0:02 h · Basis mit dem nächsten vollständigen Lesen')
  I18n.setLang('en')
  Shell.applySessionStatus({ now: T0, running: null, game: { kind: 'game', state: 'starting', startedAt: T0 - 60000, loot: null, lootDiv: null }, pending: 0 })
  assert.equal(sessionEntries(slot)[0].textContent, 'Game session 0:01 h · baseline with the next full read')
})

test('the session line sits after the warnings and before the informational lines', async () => {
  const { Shell, slot } = await loadShell()
  const T0 = Date.now()
  Shell.setStatus('r', 'release')
  Shell.setStatus('d', 'data')
  Shell.applySessionStatus({ now: T0, running: { kind: 'farm', state: 'running', startedAt: T0, loot: 0, lootDiv: 0 }, pending: 0 })
  Shell.setStatus('s', 'sources')
  Shell.setStatus('y', 'sync')
  Shell.setStatus('b', 'blind')
  assert.deepEqual(slot.children.map(c => c.dataset.statusKey), ['blind', 'sync', 'sources', 'session', 'data', 'release'])
})

test('fmtSessionDuration', async () => {
  const { Shell } = await loadShell()
  assert.equal(Shell.fmtSessionDuration(0), '0:00')
  assert.equal(Shell.fmtSessionDuration(59_000), '0:00')
  assert.equal(Shell.fmtSessionDuration(72 * 60000), '1:12')
  assert.equal(Shell.fmtSessionDuration(25 * 3600000), '25:00')
  assert.equal(Shell.fmtSessionDuration(-5000), '0:00')
})
