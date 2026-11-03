// The session view on the History page (history.js: renderSessionButton,
// renderSessionCard, renderSessionTable), fed by a canned GET
// /networth-sessions answer: both kinds, a farm session under its game
// evening, every state, the at-press baseline, and which buttons act on what.
//
// history.js is an ES module; its one import (history-chart.js) is handed in
// as globals and the rest runs in a vm next to the real i18n.js and shell.js,
// with every element a minimal fake. No server, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import * as chart from './history-chart.js'

const here = p => fileURLToPath(new URL(p, import.meta.url))
const noop = () => {}

function fakeElement () {
  const el = {
    hidden: false,
    textContent: '',
    innerHTML: '',
    title: '',
    disabled: false,
    dataset: {},
    style: {},
    children: [],
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    listeners: {},
    addEventListener (type, fn) { (this.listeners[type] ||= []).push(fn) },
    setAttribute: noop,
    getAttribute: () => null,
    appendChild (c) { this.children.push(c); return c },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null
  }
  return el
}

async function loadPage (sessAnswer, { confirm = () => true, postAnswer = () => ({ ok: true, status: 200, body: { ok: true } }) } = {}) {
  const els = new Map()
  const el = id => { if (!els.has(id)) els.set(id, fakeElement()); return els.get(id) }
  const posts = []
  const window = { confirm }
  const ctx = vm.createContext({
    window,
    localStorage: undefined,
    location: { protocol: 'http:', host: 'localhost' },
    WebSocket: function () { throw new Error('no socket in this test') },
    document: {
      getElementById: el,
      createElement: () => fakeElement(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      readyState: 'complete',
      documentElement: null,
      title: '',
      cookie: ''
    },
    fetch: async (url, opts) => {
      if (url === '/networth-sessions') return { ok: true, json: async () => sessAnswer }
      if (opts && opts.method === 'POST') {
        posts.push(url)
        const a = postAnswer(url)
        return { ok: a.ok, status: a.status, json: async () => a.body }
      }
      throw new Error('no network in this test')
    },
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    ...chart
  })
  vm.runInContext(await readFile(here('i18n.js'), 'utf8'), ctx, { filename: 'i18n.js' })
  vm.runInContext(await readFile(here('shell.js'), 'utf8'), ctx, { filename: 'shell.js' })
  const src = (await readFile(here('history.js'), 'utf8'))
    .replace(/^import \{[^}]*\} from '\.\/history-chart\.js'\n/m, '')
  assert.ok(!/^import /m.test(src), 'history.js gained an import this test does not provide')
  vm.runInContext(src, ctx, { filename: 'history.js' })
  await ctx.loadSessions()
  return { el, I18n: window.I18n, ctx, posts }
}

// The rows of the session list as [id, kind cell, state cell, child?], in
// the order they are drawn.
function listRows (html) {
  return html.split('<tr ').slice(1).map(r => {
    const cells = [...r.matchAll(/<td class="([^"]*)">([^<]*)<\/td>/g)].map(m => [m[1], m[2]])
    return {
      id: r.match(/data-id="([^"]+)"/)[1],
      child: /class="[^"]*\bchild\b/.test(r.split('>')[0]),
      kind: cells[0][1],
      state: cells[cells.length - 1][1]
    }
  })
}

// A click on an element inside `host` that matches `sel` and carries `dataset`.
function clickInside (host, sel, dataset) {
  const target = { closest: s => (s === sel ? { dataset } : null) }
  for (const fn of host.listeners.click || []) fn({ target })
}

const T0 = Date.UTC(2026, 10, 3, 12, 0)
const H = 3_600_000
const base = { available: true, persisted: true, now: T0, rateMinMs: 600000, guardHoldMs: 6 * H }

test('a running session is a line of the list, not an empty list', async () => {
  const running = {
    id: 's-1', kind: 'farm', parent: null, state: 'running', baseline: 'read', startedAt: T0 - H, endedAt: null,
    durationMs: H, asOf: T0, round: null, about: null, stashChanged: false, balance: null
  }
  const { el, I18n, ctx } = await loadPage({ ...base, running, game: null, pending: [], done: [] })
  assert.equal(el('sessNone').hidden, true)
  assert.deepEqual(listRows(el('sessRows').innerHTML).map(r => [r.id, r.kind, r.state]), [['s-1', 'Farm session', 'running']])
  assert.equal(el('sessBtnLbl').textContent, 'End farm session')
  I18n.setLang('de')
  ctx.renderSessions()
  assert.deepEqual(listRows(el('sessRows').innerHTML).map(r => [r.kind, r.state]), [['Farm-Sitzung', 'läuft']])
  assert.equal(el('sessBtnLbl').textContent, 'Farm-Sitzung beenden')
})

test('without a running session the empty list invites a start', async () => {
  const { el } = await loadPage({ ...base, running: null, game: null, pending: [], done: [] })
  assert.equal(el('sessNone').hidden, false)
  assert.equal(el('sessNone').textContent, 'No sessions yet. Start a farm session with the button above the chart.')
  assert.equal(el('sessBtnLbl').textContent, 'Start farm session')
})

test('a session closed without any point after its end says it has no figures', async () => {
  const done = [{
    id: 's-2', kind: 'farm', parent: null, baseline: 'read', state: 'unfinished', startedAt: T0 - 50 * H, endedAt: T0 - 48 * H, closedAt: T0,
    durationMs: 2 * H, stashChanged: false, balance: null
  }]
  const { el, ctx } = await loadPage({ ...base, running: null, game: null, pending: [], done })
  const html = () => el('sessCard').innerHTML
  // The card shows the running or newest pending session; a finished one only
  // once its row is picked, which is what a click does.
  assert.equal(el('sessCard').hidden, true)
  vm.runInContext("sessSel = 's-2'; renderSessionCard()", ctx)
  assert.match(html(), /No net-worth reading came in after the end/)
  assert.doesNotMatch(html(), /these figures were never confirmed/)
  assert.match(el('sessRows').innerHTML, /never confirmed/, 'the list row still says never confirmed')
})

// A balance as the server sends it; only the fields the page reads.
const bal = (loot, extra = {}) => ({
  startAt: 0, endAt: 0, c0: 0, c1: 0, cd0: 200, cd1: 200, total: loot, loot, market: 0,
  totalDiv: loot / 200, lootDiv: loot / 200, marketDiv: 0, lootPerHour: loot, lootPerHourDiv: loot / 200,
  gains: [], losses: [], unpricedIn: 0, withheld: [], stashChanged: false, ...extra
})
const sessionOf = (id, kind, parent, state, startedAt, endedAt, extra = {}) => ({
  id, kind, parent, state, baseline: state === 'starting' ? null : 'read', startedAt, endedAt,
  durationMs: (endedAt ?? T0) - startedAt, asOf: null, round: null, about: null,
  closedAt: endedAt != null ? endedAt + 600000 : undefined, stashChanged: false,
  balance: state === 'starting' ? null : bal(400), ...extra
})

test('the list names each kind and puts a farm session under its game evening', async () => {
  const game = sessionOf('g-2', 'game', null, 'running', T0 - 3 * H, null)
  const farm = sessionOf('s-4', 'farm', 'g-2', 'starting', T0 - 0.1 * H, null)
  const pending = [sessionOf('s-3', 'farm', 'g-2', 'preliminary', T0 - 2 * H, T0 - 0.5 * H)]
  const done = [
    sessionOf('s-2', 'farm', 'g-2', 'final', T0 - 2.9 * H, T0 - 2.5 * H, { baseline: 'at-press' }),
    sessionOf('g-1', 'game', null, 'final', T0 - 27 * H, T0 - 23 * H),
    sessionOf('s-1', 'farm', 'g-1', 'unfinished', T0 - 26 * H, T0 - 25 * H),
    // The evening of this one was discarded: the server dropped its parent,
    // so it stands on its own, not under another evening.
    sessionOf('s-0', 'farm', null, 'final', T0 - 50 * H, T0 - 49 * H),
    // The evening of this one is older than the list holds: it closed after
    // the farm session began and fell out of the newest ones, the parent
    // still names it. It stands on its own too, and is not lost.
    sessionOf('s-z', 'farm', 'g-gone', 'final', T0 - 60 * H, T0 - 59 * H)
  ]
  const { el, I18n, ctx } = await loadPage({ ...base, running: farm, game, pending, done })
  const rows = () => listRows(el('sessRows').innerHTML)
  assert.deepEqual(rows().map(r => [r.id, r.child]), [
    ['g-2', false], ['s-4', true], ['s-3', true], ['s-2', true],
    ['g-1', false], ['s-1', true],
    ['s-0', false],
    ['s-z', false]
  ], 'newest evening first, its farm sessions under it, newest first')
  // The note counts the finished lines only: the running and waiting ones
  // are in the list too, and the server keeps the newest finished ones.
  assert.equal(el('sessNote').textContent, 'newest 5 finished · each kept as its own summary, beyond the history’s retention')
  assert.deepEqual(rows().map(r => r.kind), [
    'Game session', 'Farm session', 'Farm session', 'Farm session', 'Game session', 'Farm session', 'Farm session', 'Farm session'])
  assert.deepEqual(rows().map(r => r.state), [
    'running', 'starting', 'preliminary', 'final · baseline at start', 'final', 'never confirmed', 'final', 'final'])
  I18n.setLang('de')
  ctx.renderSessions()
  assert.deepEqual(rows().map(r => r.kind).slice(0, 2), ['Spielsitzung', 'Farm-Sitzung'])
  assert.deepEqual(rows().map(r => r.state).slice(0, 4), ['läuft', 'startet', 'vorläufig', 'abgeschlossen · Basis beim Start'])
})

test('a starting session says its baseline comes with the next full read, and when', async () => {
  const farm = sessionOf('s-1', 'farm', null, 'starting', T0 - 120000, null, { about: 6, round: { done: 3, total: 40 } })
  const { el, I18n, ctx } = await loadPage({ ...base, running: farm, game: null, pending: [], done: [] })
  const html = () => el('sessCard').innerHTML
  assert.equal(el('sessCard').hidden, false)
  assert.match(html(), /Farm session started at /)
  assert.match(html(), /<span class="sessstate starting">starting<\/span>/)
  assert.match(html(), /Baseline with the next full read of the stash, about 6 min; until then there are no figures\./)
  assert.match(html(), /3 of 40 tabs read since the start\./)
  I18n.setLang('de')
  ctx.renderSessions()
  assert.match(html(), /Basis mit dem nächsten vollständigen Lesen des Stashs, in etwa 6 Min\.; bis dahin gibt es keine Zahlen\./)
  assert.match(html(), /3 von 40 Tabs seit dem Start gelesen\./)
  // Without an estimate the sentence names no minutes, and never "about 0".
  vm.runInContext("sess.running = { ...sess.running, about: null, round: null }; I18n.setLang('en'); renderSessions()", ctx)
  assert.match(html(), /Baseline with the next full read of the stash; until then there are no figures\./)
  assert.doesNotMatch(html(), /tabs read since the start/)
})

test('an at-press baseline is said in the card, and an ended farm session asks for the loot in the stash', async () => {
  const pending = [sessionOf('s-1', 'farm', null, 'preliminary', T0 - 2 * H, T0 - 0.1 * H,
    { baseline: 'at-press', about: 4, round: { done: 10, total: 40 } })]
  const { el, I18n, ctx } = await loadPage({ ...base, running: null, game: null, pending, done: [] })
  const html = () => el('sessCard').innerHTML
  assert.match(html(), /Baseline: the stash as it stood at the start, not a full read after it/)
  assert.match(html(), /Final in about 4 min\./)
  assert.match(html(), /Put loot still in your inventory into the stash now/)
  I18n.setLang('de')
  ctx.renderSessions()
  assert.match(html(), /Basis: der Stash, wie er beim Start stand/)
  assert.match(html(), /Abgeschlossen in etwa 4 Min\./)
  // A game session that ended has no inventory to empty: the game is closed.
  vm.runInContext("sess.pending = [{ ...sess.pending[0], kind: 'game', baseline: 'read' }]; I18n.setLang('en'); renderSessions()", ctx)
  assert.doesNotMatch(html(), /Put loot still in your inventory/)
  assert.doesNotMatch(html(), /Baseline: the stash as it stood/)
  assert.match(html(), /Game session /)
})

test('without a pick the card shows the running farm session, else an ended one still waiting, else the evening', async () => {
  const game = sessionOf('g-1', 'game', null, 'running', T0 - 3 * H, null)
  const waiting = sessionOf('s-1', 'farm', 'g-1', 'preliminary', T0 - 2 * H, T0 - 0.1 * H, { about: 4 })
  const done = [sessionOf('s-0', 'farm', 'g-1', 'final', T0 - 2.9 * H, T0 - 2.5 * H)]
  const { el, ctx } = await loadPage({ ...base, running: null, game, pending: [waiting], done })
  const html = () => el('sessCard').innerHTML
  // The evening runs, a farm session waits for its final balance: the card
  // is the farm session's, because its loot has to go into the stash now.
  assert.match(html(), /^<div class="sesstop"><b>Farm session /)
  assert.match(html(), /Final in about 4 min\./)
  assert.match(html(), /Put loot still in your inventory into the stash now/)
  assert.doesNotMatch(html(), /data-act="discard-game"/)
  // A running farm session comes before the waiting one.
  const farm = sessionOf('s-2', 'farm', 'g-1', 'running', T0 - 0.05 * H, null)
  vm.runInContext(`sess.running = ${JSON.stringify(farm)}; renderSessions()`, ctx)
  assert.match(html(), /Farm session running since /)
  // Nothing waits and no farm session runs: the evening, never a finished one.
  vm.runInContext('sess.running = null; sess.pending = []; renderSessions()', ctx)
  assert.match(html(), /Game session running since /)
})

test('Start, End and Discard act on the farm session; a game session has only its own Discard', async () => {
  const game = sessionOf('g-1', 'game', null, 'running', T0 - 3 * H, null)
  const { el, ctx, posts } = await loadPage({ ...base, running: null, game, pending: [], done: [] })
  // A game evening runs, no farm session: the toolbar offers a farm start,
  // and its Discard (a farm session's) is not there.
  assert.equal(el('sessBtnLbl').textContent, 'Start farm session')
  assert.equal(el('sessBtn').dataset.act, 'start')
  assert.equal(el('sessDiscard').hidden, true)
  // The card shows the evening, with a Discard of its own and no Start or End.
  assert.match(el('sessCard').innerHTML, /Game session running since /)
  assert.match(el('sessCard').innerHTML, /data-act="discard-game"/)
  assert.doesNotMatch(el('sessCard').innerHTML, /data-act="(start|end)"/)
  clickInside(el('sessCard'), 'button[data-act]', { act: 'discard-game' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(posts, ['/networth-session/discard?kind=game'])

  // A farm session runs in the evening: the toolbar ends and discards it, the
  // card shows it, and the evening's Discard is on the evening's card only.
  const farm = sessionOf('s-1', 'farm', 'g-1', 'running', T0 - H, null)
  vm.runInContext(`sess.running = ${JSON.stringify(farm)}; renderSessions()`, ctx)
  assert.equal(el('sessBtnLbl').textContent, 'End farm session')
  assert.equal(el('sessDiscard').hidden, false)
  assert.match(el('sessCard').innerHTML, /Farm session running since /)
  assert.doesNotMatch(el('sessCard').innerHTML, /data-act="discard-game"/)
  for (const fn of el('sessDiscard').listeners.click) fn({ target: {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(posts[posts.length - 1], '/networth-session/discard', 'the toolbar Discard drops the farm session')
  vm.runInContext("sessSel = 'g-1'; renderSessionCard()", ctx)
  assert.match(el('sessCard').innerHTML, /data-act="discard-game"/)

  // An evening that has ended has no button at all.
  const ended = sessionOf('g-0', 'game', null, 'final', T0 - 30 * H, T0 - 26 * H)
  vm.runInContext(`sess.done = [${JSON.stringify(ended)}]; sessSel = 'g-0'; renderSessionCard()`, ctx)
  assert.doesNotMatch(el('sessCard').innerHTML, /data-act=/)
})

test('discarding the game session asks first, and a refusal names the game session', async () => {
  const game = sessionOf('g-1', 'game', null, 'running', T0 - 3 * H, null)
  let answer = false
  let asked = null
  const { el, posts } = await loadPage({ ...base, running: null, game, pending: [], done: [] }, {
    confirm: q => { asked = q; return answer },
    postAnswer: () => ({ ok: false, status: 409, body: { error: 'not-running' } })
  })
  const settle = () => new Promise(resolve => setImmediate(resolve))
  clickInside(el('sessCard'), 'button[data-act]', { act: 'discard-game' })
  await settle()
  assert.match(asked, /Discard the running game session\?/)
  assert.deepEqual(posts, [], 'no POST without a yes')
  answer = true
  clickInside(el('sessCard'), 'button[data-act]', { act: 'discard-game' })
  await settle(); await settle()
  assert.deepEqual(posts, ['/networth-session/discard?kind=game'])
  assert.equal(el('sessMsg').textContent, 'No game session is running.')
  assert.equal(el('sessMsg').hidden, false)
})
