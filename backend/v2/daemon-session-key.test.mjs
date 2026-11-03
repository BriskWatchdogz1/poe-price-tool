// daemon/ppt_session.py — the hotkey daemon's session key ([session] key), and
// the session cards of daemon/ppt_results.py.
//
// Why this lives here: `npm test` covers only backend/v2 (same reason as
// daemon-diag.test.mjs). ppt_session.py and ppt_results.py are standard
// library only; the clock is a number the test moves and the server is a fake
// pool that records the requests (no curl, no network). The key press itself
// (evdev, the focus gate) and a real HTTP exchange are in daemon-diag.test.mjs.
//
// The rules under test: a press is one POST /daemon/session {"action":
// "toggle"}, never two at once; the answer and the feed's `session` event of
// the same state are one card, not two; every refusal and every failure is a
// card that says why; the words are the ones of the 1.0 plan (farm session
// started, baseline set, session ended, session balance, game session started
// and ended), the numbers in the card's number format.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')

const PRELUDE = `
import json, sys
sys.path.insert(0, sys.argv[1])
from ppt_diag import ThrottledLog
from ppt_link import CurlResult, headers
from ppt_results import session_card, session_refusal_card, session_problem_card, toast_for
from ppt_session import SessionKey
clock = [0.0]
lines = []
log = ThrottledLog(60, clock=lambda: clock[0], emit=lines.append)
def at(t):
    clock[0] = float(t)
class FakeJob:
    def __init__(self, args, stdin_bytes, timeout_s, tag):
        self.args, self.stdin, self.timeout_s, self.tag = args, stdin_bytes, timeout_s, tag
        self.result = None
    def body(self):
        return json.loads(self.stdin.decode('utf-8'))
class FakePool:
    def __init__(self):
        self.jobs = []
    def start(self, args, stdin_bytes=None, timeout_s=10, tag=None):
        j = FakeJob(args, stdin_bytes, timeout_s, tag)
        self.jobs.append(j)
        return j
def answer(job, status=200, body='', rc=0, timed_out=False, err=''):
    if not isinstance(body, str):
        body = json.dumps(body)
    job.result = CurlResult(rc, status, body, err, timed_out)
def S(state='starting', kind='farm', **kw):
    s = {'id': 's1', 'kind': kind, 'parent': None, 'state': state, 'baseline': None,
         'startedAt': 1793600000000, 'endedAt': None, 'about': None, 'balance': None}
    s.update(kw)
    return s
def B(**kw):
    b = {'startAt': 1, 'endAt': 2, 'c0': 1000, 'c1': 1400, 'cd0': 140, 'cd1': 140, 'total': 400,
         'loot': 350, 'market': 50, 'totalDiv': 2.86, 'lootDiv': 2.5, 'marketDiv': 0.36,
         'lootPerHour': 175, 'lootPerHourDiv': 1.4, 'unpricedIn': 0, 'withheld': [], 'stashChanged': False}
    b.update(kw)
    return b
def card(c):
    return None if c is None else {'key': c['key'], 'title': c['title'], 'lines': c['lines'], 'toast': list(toast_for(c))}
def make(pool=None, **kw):
    opts = dict(pool=pool or FakePool(), base_url='http://h:1/', hdrs=headers('player1', '9.9.9', 'ab12'),
                log=log, config_path='/cfg/config.toml', user='player1')
    opts.update(kw)
    return SessionKey(**opts)
def ev(session, by='ab12', kind='session'):
    return {'seq': 1, 'at': 0, 'kind': kind, 'by': by, 'session': session}
`

function py (code) {
  const r = spawnSync('python3', ['-c', PRELUDE + code, DAEMON_DIR], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  assert.equal(r.status, 0, `python3 failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

// --- the cards (ppt_results.session_card) ---------------------------------------

test('a farm session card says what the plan says, in every state', () => {
  const out = py(`
print(json.dumps([card(c) for c in (
    session_card(S('starting', about=6)),
    session_card(S('starting')),
    session_card(S('running', baseline='read')),
    session_card(S('running', baseline='at-press')),
    session_card(S('preliminary', baseline='read', endedAt=1793607200000, about=4)),
    session_card(S('preliminary', baseline='read', endedAt=1793607200000)),
    session_card(S('final', baseline='read', endedAt=1793607200000, balance=B())),
    session_card(S('unfinished', baseline='read', endedAt=1793607200000)),
)]))
`)
  const [starting, startingNoEta, running, atPress, ended, endedNoEta, final, unfinished] = out
  assert.deepEqual(starting, {
    key: 'session',
    title: 'Farm session started',
    lines: [['Farm session started', 'name'], ['baseline with the next full read (about 6 min)', 'muted']],
    toast: ['Farm session started', 'baseline with the next full read (about 6 min)']
  })
  assert.deepEqual(startingNoEta.lines[1], ['baseline with the next full read', 'muted'], 'no estimate: no number')
  assert.deepEqual(running.lines, [['Baseline set, session running', 'name']])
  assert.deepEqual(atPress.lines, [['Baseline set, session running', 'name'],
    ['baseline: the stash at the press (no full read in time)', 'warn']])
  assert.deepEqual(ended.lines, [['Session ended', 'name'], ['put your loot in the stash first', 'warn'],
    ['balance in about 4 min', 'muted']])
  assert.deepEqual(endedNoEta.lines[2], ['balance after the next full read', 'muted'])
  assert.deepEqual(final.lines, [['Session balance', 'name'], ['loot +2.5 div, market +0.36 div', 'price'],
    ['per hour +1.4 div', 'muted']])
  assert.deepEqual(final.toast, ['Session balance', 'loot +2.5 div, market +0.36 div\nper hour +1.4 div'])
  assert.deepEqual(unfinished.lines, [['Session closed unfinished', 'name'],
    ['no full read after its end, see the History page', 'warn']])
  for (const c of out) assert.equal(c.key, 'session', 'one slot: each card replaces the one before')
})

test('a game session card: started and ended, no card for its baseline, its balance like a farm one', () => {
  const out = py(`
print(json.dumps([card(c) for c in (
    session_card(S('starting', kind='game', about=6)),
    session_card(S('running', kind='game', baseline='read')),
    session_card(S('preliminary', kind='game', baseline='read', about=12)),
    session_card(S('preliminary', kind='game', baseline='read')),
    session_card(S('final', kind='game', baseline='read', balance=B())),
    session_card(S('unfinished', kind='game', baseline='read')),
)]))
`)
  const [started, running, ended, endedNoEta, final, unfinished] = out
  assert.deepEqual(started.lines, [['Game session started', 'name']])
  assert.deepEqual(started.toast, ['Game session started', ''])
  assert.equal(running, null, 'a game evening does not interrupt the player for its baseline')
  assert.deepEqual(ended.lines, [['Game session ended', 'name'], ['balance in about 12 min', 'muted']])
  assert.deepEqual(endedNoEta.lines, [['Game session ended', 'name'], ['balance after the next full read', 'muted']])
  assert.deepEqual(final.lines, [['Game session balance', 'name'], ['loot +2.5 div, market +0.36 div', 'price'],
    ['per hour +1.4 div', 'muted']])
  assert.equal(unfinished.title, 'Game session closed unfinished')
})

test('the balance figures: chaos without a rate, the card language, a loss, no hourly figure, a changed stash', () => {
  const out = py(`
r = {}
chaos = B(lootDiv=None, marketDiv=None, lootPerHourDiv=None, loot=1484.5, market=-12, lootPerHour=742)
r['en'] = session_card(S('final', balance=chaos))['lines']
r['de'] = session_card(S('final', balance=chaos), lang='de')['lines']
r['loss'] = session_card(S('final', balance=B(lootDiv=-0.4, marketDiv=0, lootPerHourDiv=-0.2)))['lines']
r['short'] = session_card(S('final', balance=B(lootPerHour=None, lootPerHourDiv=None)))['lines']
r['changed'] = session_card(S('final', balance=B(stashChanged=True, lootPerHour=None, lootPerHourDiv=None)))['lines']
r['none'] = session_card(S('final'))['lines']
r['junk'] = [session_card(None), session_card('x'), session_card(S('maybe')), session_card(S(kind='other'))]
print(json.dumps(r))
`)
  assert.deepEqual(out.en.slice(1), [['loot +1,484 c, market -12 c', 'price'], ['per hour +742 c', 'muted']])
  assert.deepEqual(out.de.slice(1), [['loot +1.484 c, market -12 c', 'price'], ['per hour +742 c', 'muted']])
  assert.deepEqual(out.loss.slice(1), [['loot -0.4 div, market 0 div', 'price'], ['per hour -0.2 div', 'muted']])
  assert.deepEqual(out.short.slice(1), [['loot +2.5 div, market +0.36 div', 'price'], ['per hour: session too short', 'muted']])
  assert.deepEqual(out.changed.slice(1), [['stash tabs changed, no loot figure', 'warn']])
  assert.deepEqual(out.none.slice(1), [['no balance, see the History page', 'warn']])
  assert.deepEqual(out.junk, [null, null, null, null])
})

test('a baseline from the copy at the start (at-press) is said on the cards at the end too', () => {
  const out = py(`
r = {}
r['ended'] = session_card(S('preliminary', baseline='at-press', endedAt=1793607200000, about=4))['lines']
r['final'] = session_card(S('final', baseline='at-press', endedAt=1793607200000, balance=B()))['lines']
r['changed'] = session_card(S('final', baseline='at-press', balance=B(stashChanged=True)))['lines']
r['game_ended'] = session_card(S('preliminary', kind='game', baseline='at-press', about=12))['lines']
r['game_final'] = session_card(S('final', kind='game', baseline='at-press', balance=B()))['lines']
r['unfinished'] = session_card(S('unfinished', baseline='at-press'))['lines']
print(json.dumps(r))
`)
  const press = ['baseline: the stash at the press (no full read in time)', 'warn']
  const start = ['baseline: the stash at the start (no full read in time)', 'warn']
  assert.deepEqual(out.ended, [['Session ended', 'name'], ['put your loot in the stash first', 'warn'],
    ['balance in about 4 min', 'muted'], press], 'ended before the first full read: the baseline is the press')
  assert.deepEqual(out.final, [['Session balance', 'name'], ['loot +2.5 div, market +0.36 div', 'price'],
    ['per hour +1.4 div', 'muted'], press])
  assert.deepEqual(out.changed, [['Session balance', 'name'], ['stash tabs changed, no loot figure', 'warn'], press])
  assert.deepEqual(out.game_ended, [['Game session ended', 'name'], ['balance in about 12 min', 'muted'], start],
    'a game session has no press: its copy is the stash at its start')
  assert.deepEqual(out.game_final, [['Game session balance', 'name'], ['loot +2.5 div, market +0.36 div', 'price'],
    ['per hour +1.4 div', 'muted'], start])
  assert.deepEqual(out.unfinished, [['Session closed unfinished', 'name'],
    ['no full read after its end, see the History page', 'warn']], 'no figures: nothing to say about their baseline')
  for (const lines of Object.values(out)) assert.ok(lines.length <= 4, 'the overlay shows at most 4 lines')
})

test('a refusal and a failure of the key are cards that say why', () => {
  const out = py(`
print(json.dumps([card(c) for c in (
    session_refusal_card('start', 'sync-off'),
    session_refusal_card('start', 'no-baseline'),
    session_refusal_card('start', 'already-running'),
    session_refusal_card('end', 'not-running'),
    session_refusal_card(None, 'something-new'),
    session_problem_card('unsupported'),
    session_problem_card('too-many'),
    session_problem_card('unreachable'),
    session_problem_card('no-answer'),
    session_problem_card('unknown-user'),
    session_problem_card('failed'),
)]))
`)
  const pick = c => [c.title, c.lines.slice(1)]
  assert.deepEqual(out.map(pick), [
    ['Farm session not started', [["the server's stash sync is off", 'warn']]],
    ['Farm session not started', [['no recent read of your stash, see the Net Worth page', 'warn']]],
    ['Farm session not started', [['a farm session runs already', 'warn']]],
    ['Farm session not ended', [['no farm session runs', 'warn']]],
    ['Farm session not started', [['refused by the server (something-new)', 'warn']]],
    ['Session key', [['the server is older than this daemon (no session key)', 'warn']]],
    ['Session key', [['too many presses this minute, try again shortly', 'warn']]],
    ['Session key', [['server not reachable, nothing changed', 'bad']]],
    ['Session key', [['no answer from the server, see the History page', 'bad']]],
    ['Session key', [['the server does not know this user', 'bad']]],
    ['Session key', [['the server did not take it, see the journal', 'bad']]]
  ])
  for (const c of out) assert.equal(c.key, 'session')
})

// --- the key (ppt_session.SessionKey) ----------------------------------------------

test('a press is one POST /daemon/session with toggle; a press while it runs is not sent again', () => {
  const out = py(`
pool = FakePool()
k = make(pool)
first = k.press(0)
again = k.press(0.5)
j = pool.jobs[0]
print(json.dumps({'first': first, 'again': again, 'jobs': len(pool.jobs), 'body': j.body(), 'args': j.args,
                  'tag': j.tag, 'lines': lines}))
`)
  assert.deepEqual(out.first, [], 'the card comes with the answer')
  assert.deepEqual(out.again, [])
  assert.equal(out.jobs, 1)
  assert.deepEqual(out.body, { action: 'toggle' })
  assert.equal(out.tag, 'session')
  assert.equal(out.args.at(-1), 'http://h:1/daemon/session')
  assert.ok(out.args.includes('X-PPT-Daemon: 9.9.9') && out.args.includes('X-User: player1') &&
    out.args.includes('X-PPT-Instance: ab12'), out.args.join(' '))
  assert.deepEqual(out.lines, [])
})

test('the answer and the feed event of the same state are one card; each new state is a card of its own', () => {
  const out = py(`
pool = FakePool()
k = make(pool)
k.press(0)
answer(pool.jobs[0], 200, {'ok': True, 'v': 1, 'action': 'start', 'session': S('starting', about=6)})
r = {}
r['answer'] = [c['title'] for c in k.tick(1)]
r['tick_again'] = k.tick(2)
r['feed_same'] = k.event(ev(S('starting', about=6)), 2)
r['running'] = [c['title'] for c in k.event(ev(S('running', baseline='read'), by=None), 3)]
r['other_kind'] = k.event(ev(S('starting', kind='game', id='g1'), by=None, kind='item'), 3)
r['game'] = [c['title'] for c in k.event(ev(S('starting', kind='game', id='g1'), by=None), 4)]
r['game_running'] = k.event(ev(S('running', kind='game', id='g1', baseline='read'), by=None), 5)
r['other_daemon'] = [c['title'] for c in k.event(ev(S('preliminary', baseline='read', about=3), by='zz99'), 6)]
r['junk'] = k.event({'kind': 'session', 'session': 'x'}, 7) + k.event('x', 7)
r['lines'] = lines
print(json.dumps(r))
`)
  assert.deepEqual(out.answer, ['Farm session started'])
  assert.deepEqual(out.tick_again, [])
  assert.deepEqual(out.feed_same, [], 'the server puts the answer into the feed as well')
  assert.deepEqual(out.running, ['Baseline set, session running'])
  assert.deepEqual(out.other_kind, [])
  assert.deepEqual(out.game, ['Game session started'], 'the game detection has no instance: by null is shown')
  assert.deepEqual(out.game_running, [])
  assert.deepEqual(out.other_daemon, ['Session ended'], 'a session belongs to the user, not to one daemon')
  assert.deepEqual(out.junk, [])
  assert.deepEqual(out.lines, [])
})

test('a refusal (409) or too many presses (429) is a card and no journal line', () => {
  const out = py(`
pool = FakePool()
k = make(pool)
r = []
for status, body in ((409, {'v': 1, 'error': 'sync-off', 'action': 'start'}),
                     (409, {'v': 1, 'error': 'not-running', 'action': 'end'}),
                     (429, {'v': 1, 'error': 'too-many-session-requests', 'action': 'toggle'})):
    k.press(clock[0])
    answer(pool.jobs[-1], status, body)
    r.append([[c['title'], c['lines'][1][0]] for c in k.tick(clock[0])])
    at(clock[0] + 1)
print(json.dumps({'r': r, 'jobs': len(pool.jobs), 'lines': lines}))
`)
  assert.deepEqual(out.r, [
    [['Farm session not started', "the server's stash sync is off"]],
    [['Farm session not ended', 'no farm session runs']],
    [['Session key', 'too many presses this minute, try again shortly']]
  ])
  assert.equal(out.jobs, 3, 'a refusal is an answer: the next press asks again')
  assert.deepEqual(out.lines, [])
})

test('a server without the route: one journal line, a card at once for every press, asked again after 10 min', () => {
  const out = py(`
pool = FakePool()
k = make(pool)
k.press(0)
answer(pool.jobs[0], 404, {'error': 'unknown daemon route', 'path': '/daemon/session'})
r = {}
r['first'] = [c['lines'][1][0] for c in k.tick(0)]
at(60)
r['soon'] = [c['lines'][1][0] for c in k.press(60)]
r['jobs_soon'] = len(pool.jobs)
at(601)
r['later'] = k.press(601)
r['jobs_later'] = len(pool.jobs)
answer(pool.jobs[-1], 200, {'ok': True, 'v': 1, 'action': 'start', 'session': S('starting', about=2)})
r['back'] = [c['title'] for c in k.tick(602)]
r['lines'] = lines
print(json.dumps(r))
`)
  assert.deepEqual(out.first, ['the server is older than this daemon (no session key)'])
  assert.deepEqual(out.soon, ['the server is older than this daemon (no session key)'])
  assert.equal(out.jobs_soon, 1, 'no request to a server that has no route, before the re-check')
  assert.deepEqual(out.later, [])
  assert.equal(out.jobs_later, 2)
  assert.deepEqual(out.back, ['Farm session started'])
  assert.equal(out.lines.length, 2, out.lines.join('\n'))
  assert.match(out.lines[0], /has no \/daemon\/session \(HTTP 404\): it is older than this daemon\. The session key does nothing/)
  assert.match(out.lines[1], /Session key is offered by the backend now \(POST \/daemon\/session\)/)
})

test('a server that cannot be reached: a card and one journal line, and one line when it works again', () => {
  const out = py(`
pool = FakePool()
k = make(pool)
k.press(0)
answer(pool.jobs[0], None, '', rc=7, err='curl: (7) Failed to connect to h port 1')
r = {}
r['down'] = [[c['lines'][1][0], c['lines'][1][1]] for c in k.tick(0)]
at(5)
k.press(5)
answer(pool.jobs[1], 400, {'error': 'unknown user "player1"', 'users': ['player2']})
r['user'] = [c['lines'][1][0] for c in k.tick(5)]
at(700)
k.press(700)
answer(pool.jobs[2], 200, {'ok': True, 'v': 1, 'action': 'end', 'session': S('preliminary', baseline='read', about=5)})
r['up'] = [c['title'] for c in k.tick(700)]
r['lines'] = lines
print(json.dumps(r))
`)
  assert.deepEqual(out.down, [['server not reachable, nothing changed', 'bad']])
  assert.deepEqual(out.user, ['the server does not know this user'])
  assert.deepEqual(out.up, ['Session ended'])
  assert.equal(out.lines.length, 3, out.lines.join('\n'))
  assert.match(out.lines[0], /POST \/daemon\/session failed: cannot reach http:\/\/h:1/)
  assert.match(out.lines[1], /POST \/daemon\/session rejected: the backend does not know user "player1"/)
  assert.match(out.lines[2], /Session key works again/)
})

test('a request that may have reached the server (a timeout, a broken exchange) does not claim that nothing changed', () => {
  const out = py(`
pool = FakePool()
k = make(pool)
r = []
for rc, timed_out in ((28, False), (52, False), (0, True)):
    k.press(clock[0])
    answer(pool.jobs[-1], None, '', rc=rc, timed_out=timed_out, err='x')
    r.append(k.tick(clock[0])[0]['lines'][1][0])
    at(clock[0] + 100)
print(json.dumps(r))
`)
  assert.deepEqual(out, Array(3).fill('no answer from the server, see the History page'))
})

test('the card language follows lang, which the daemon may set after the start', () => {
  const out = py(`
k = make()
k.lang = 'de'
print(json.dumps(k.event(ev(S('final', balance=B(lootDiv=None, marketDiv=None, lootPerHourDiv=None, loot=1484.5, lootPerHour=None))), 0)[0]['lines']))
`)
  assert.deepEqual(out[1], ['loot +1.484 c, market +50 c', 'price'])
})

// --- where a session card goes (ppt_display.Display.show_session) -------------------

test('a session card goes into the overlay stack while the game has focus, else to the notification slot "session"', () => {
  const out = py(`
from ppt_display import Display
class Notifier:
    def __init__(self): self.shown = []
    def show(self, slot, summary, body): self.shown.append([slot, summary, body])
    def state(self): return 'ok'
    def tick(self, now): pass
class Overlay:
    required = False
    def __init__(self): self.sent = []
    def state(self): return 'ok'
    def show_whisper(self, card): self.sent.append(['whisper', card['key']]); return True
    def hide(self, key): self.sent.append(['hide', key]); return True
    def tick(self, now): pass
class Focus:
    def __init__(self): self.s = 'focused'
    def state(self): return self.s
    def tick(self, now): pass
n, o, f = Notifier(), Overlay(), Focus()
d = Display(log, notifier=n, overlay=o, focus=f)
c = session_card(S('starting', about=6))
d.show_session(c)
f.s = 'not-focused'
d.show_session(session_card(S('running', baseline='read')))
print(json.dumps({'overlay': o.sent, 'notify': n.shown}))
`)
  assert.deepEqual(out.overlay, [['whisper', 'session'], ['hide', 'session']],
    'the stack card goes when the next one is a notification, so the overlay never shows an older state')
  assert.deepEqual(out.notify, [['session', 'Baseline set, session running', '']])
})
