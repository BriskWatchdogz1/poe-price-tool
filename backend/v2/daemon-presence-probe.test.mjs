// daemon/ppt_presence.py — is the game running on this machine (sync follows
// the game). The daemon looks for a window of poe_window_class with
// `xdotool search`; every doubt is 'unknown', and 'unknown' keeps the
// player's net-worth sync at its normal pace.
//
// Why this lives here: `npm test` covers only backend/v2 (same reason as
// daemon-diag.test.mjs). ppt_presence.py is standard library only. Most tests
// give the probe a fake pool and a fake clock, so the answers of xdotool are
// data; one test runs a real CurlPool against a stub xdotool that hangs, to
// show that the daemon's loop never waits for it. No real xdotool runs and no
// display is touched: DISPLAY is a value in an injected environment.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')

const PRELUDE = `
import json, os, sys, time
sys.path.insert(0, sys.argv[1])
root = sys.argv[2]
from ppt_link import CurlResult, CurlPool
from ppt_presence import GameProbe, ere_escape
clock = [0.0]
def at(t):
    clock[0] = float(t)
# What xdotool "answers": a function of the argument list -> CurlResult.
# A hit prints a window id, a clean miss is exit 1 without any output.
HIT = CurlResult(0, None, '62914561\\n', '', False)
MISS = CurlResult(1, None, '', '', False)
class FakeJob:
    def __init__(self, result): self.result = result
    def poll(self, now): return self.result
class FakePool:
    def __init__(self, answer):
        self.answer = answer
        self.calls = []
    def start_cmd(self, argv, timeout_s=1, tag=None):
        self.calls.append(list(argv))
        return FakeJob(self.answer(argv))
def which(prog):
    return '/usr/bin/' + prog
SEEN = os.path.join(root, 'state', 'game-seen.json')
DISP = {'DISPLAY': ':1'}
def probe(answer, env=DISP, seen=SEEN, **kw):
    pool = FakePool(answer)
    return GameProbe('Steam_App_238960', pool, env=env, seen_file=seen, which=kw.pop('which', which), **kw), pool
def run(p, t0, t1, step=1.0):
    t = t0
    while t <= t1:
        at(t); p.tick(t)
        t += step
`

function py (code) {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-presence-'))
  try {
    const r = spawnSync('python3', ['-c', PRELUDE + code, DAEMON_DIR, root], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    })
    assert.equal(r.status, 0, `python3 failed: ${r.stderr}`)
    return JSON.parse(r.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('a window is running, a clean miss is absent once seen, every doubt is unknown', () => {
  const out = py(`
r = {}
answer = [lambda argv: HIT]
p, pool = probe(lambda argv: answer[0](argv), check_s=10)
r['first'] = [p.state(), p.reason(), p.feature()]
run(p, 0, 0)
r['hit'] = [p.state(), p.reason(), p.feature()]
r['argv'] = pool.calls[0]
answer[0] = lambda argv: MISS
run(p, 10, 10)
r['one_miss'] = p.state()
r['both_flags'] = [c[4] for c in pool.calls[1:]]
run(p, 20, 20)
r['two_misses'] = [p.state(), p.reason(), p.feature()]
with open(SEEN) as fh:
    r['seen_text'] = fh.read()

# A fresh probe that never saw the class: a clean miss is not 'absent'.
q, _ = probe(lambda argv: MISS, seen=os.path.join(root, 'empty', 'seen.json'))
run(q, 0, 0)
r['never'] = [q.state(), q.reason(), q.feature()]
# The seen file names another class: never seen either.
os.makedirs(os.path.join(root, 'other'), exist_ok=True)
with open(os.path.join(root, 'other', 'seen.json'), 'w') as fh:
    json.dump({'v': 1, 'seen': [{'class': 'something_else', 'display': ':1'}]}, fh)
q, _ = probe(lambda argv: MISS, seen=os.path.join(root, 'other', 'seen.json'))
run(q, 0, 0)
r['other_class'] = [q.state(), q.reason()]
# Seen on another display: never seen on this one.
q, _ = probe(lambda argv: MISS, env={'DISPLAY': ':0'})
run(q, 0, 0)
r['other_display'] = [q.state(), q.reason()]
# Seen on this display, a new probe (a daemon restart): absent at once.
q, _ = probe(lambda argv: MISS, env={'DISPLAY': ':1.0'})
run(q, 0, 0)
r['restart'] = [q.state(), q.reason()]

# No DISPLAY: nothing is run.
q, qpool = probe(lambda argv: MISS, env={})
run(q, 0, 0)
r['no_display'] = [q.state(), q.reason(), len(qpool.calls)]
# xdotool prints an error (another X server, a broken one): unknown, not absent.
q, _ = probe(lambda argv: CurlResult(1, None, '', "Can't open display: :1\\n", False))
run(q, 0, 0)
r['stderr'] = [q.state(), q.reason()]
# Any other exit code.
q, _ = probe(lambda argv: CurlResult(2, None, '', '', False))
run(q, 0, 0)
r['rc2'] = [q.state(), q.reason()]
# No xdotool on PATH, and xdotool removed after the start (rc 127).
q, qpool = probe(lambda argv: HIT, which=lambda prog: None)
run(q, 0, 0)
r['no_xdotool'] = [q.state(), q.reason(), q.feature(), len(qpool.calls)]
q, _ = probe(lambda argv: CurlResult(127, None, '', 'xdotool: not found', False))
run(q, 0, 0)
r['gone'] = [q.state(), q.reason()]
r['escape'] = [ere_escape('path of exile'), ere_escape('a.b(c)'), ere_escape('x[y]*+?{1}|^$\\\\z')]
print(json.dumps(r))
`)
  assert.deepEqual(out.first, ['unknown', '', 'starting'], 'no answer yet')
  assert.deepEqual(out.hit, ['running', '', 'ok'])
  assert.deepEqual(out.argv, ['/usr/bin/xdotool', 'search', '--limit', '1', '--class', 'steam_app_238960'],
    'the class is searched in lower case (xdotool compares without case anyway)')
  assert.equal(out.one_miss, 'running', 'one miss after running does not count yet')
  assert.deepEqual(out.both_flags, ['--class', '--classname'], 'without a hit on --class, --classname is asked')
  assert.deepEqual(out.two_misses, ['absent', '', 'ok'], 'two checks in a row: absent')
  assert.doesNotMatch(out.seen_text, /62914561/, 'the seen file holds no window id')
  assert.deepEqual(JSON.parse(out.seen_text), { v: 1, seen: [{ class: 'steam_app_238960', display: ':1' }] },
    'only the class and the display, no window name')
  assert.deepEqual(out.never, ['unknown', 'never-seen', 'never-seen'],
    'a wrong class or a game on another X server looks like a miss: not absent')
  assert.deepEqual(out.other_class, ['unknown', 'never-seen'])
  assert.deepEqual(out.other_display, ['unknown', 'never-seen'])
  assert.deepEqual(out.restart, ['absent', ''], 'the seen file survives a restart; :1.0 is display :1')
  assert.deepEqual(out.no_display, ['unknown', 'no-display', 0])
  assert.deepEqual(out.stderr, ['unknown', 'error'])
  assert.deepEqual(out.rc2, ['unknown', 'error'])
  assert.deepEqual(out.no_xdotool, ['unknown', 'no-xdotool', 'no-xdotool', 0])
  assert.deepEqual(out.gone, ['unknown', 'no-xdotool'])
  assert.deepEqual(out.escape, ['path of exile', 'a\\.b\\(c\\)', 'x\\[y\\]\\*\\+\\?\\{1\\}\\|\\^\\$\\\\z'],
    'POSIX ERE: a space stays a space (re.escape would write "path\\ of\\ exile")')
})

test('a seen file that cannot be written is said once, and the fact holds for this run only', () => {
  const out = py(`
blocker = os.path.join(root, 'blocker')
with open(blocker, 'w') as fh:
    fh.write('a file where the directory should be')
seen = os.path.join(blocker, 'game-seen.json')
said = []
answer = [lambda argv: HIT]
p, _ = probe(lambda argv: answer[0](argv), seen=seen, check_s=10, on_problem=said.append)
run(p, 0, 0)
run(p, 10, 10)
r = {'running': p.state(), 'said': said[:]}
answer[0] = lambda argv: MISS
run(p, 20, 30)
r['absent'] = [p.state(), p.reason()]
r['said_after'] = len(said)
quiet, _ = probe(lambda argv: MISS, seen=seen)
run(quiet, 0, 0)
r['restart'] = [quiet.state(), quiet.reason()]
silent, _ = probe(lambda argv: HIT, seen=seen)  # no on_problem: no crash
run(silent, 0, 0)
r['silent'] = silent.state()
print(json.dumps(r))
`)
  assert.equal(out.running, 'running')
  assert.equal(out.said.length, 1, 'one line, not one per check: ' + JSON.stringify(out.said))
  assert.match(out.said[0], /blocker\/game-seen\.json not writable \(/)
  assert.match(out.said[0], /After a restart the detection says never-seen/)
  assert.deepEqual(out.absent, ['absent', ''], 'this run still knows the window')
  assert.equal(out.said_after, 1)
  assert.deepEqual(out.restart, ['unknown', 'never-seen'], 'a restart forgets it, as the line says')
  assert.equal(out.silent, 'running')
})

test('the probe is asked at most every check_s', () => {
  const out = py(`
p, pool = probe(lambda argv: HIT, check_s=10)
for t in (0, 3, 9):
    at(t); p.tick(t)
n9 = len(pool.calls)
at(10); p.tick(10)
print(json.dumps({'n9': n9, 'n10': len(pool.calls)}))
`)
  assert.equal(out.n9, 1, '3 ticks within 9 s: one xdotool run')
  assert.equal(out.n10, 2)
})

test('a hanging xdotool never blocks the loop, and its timeout counts like any doubt', () => {
  const out = py(`
bindir = os.path.join(root, 'bin')
os.makedirs(bindir)
xd = os.path.join(bindir, 'xdotool')
def tool(body):
    with open(xd, 'w') as fh: fh.write(body)
    os.chmod(xd, 0o755)
tool('#!/usr/bin/env bash\\necho 4242\\n')
pool = CurlPool()
p = GameProbe('steam_app_238960', pool, env=DISP, seen_file=SEEN, check_s=0.05, timeout_s=0.3,
              which=lambda prog: xd)
def settle(want, until=5):
    end = time.monotonic() + until
    while time.monotonic() < end:
        pool.reap(); p.tick(time.monotonic())
        if p.state() == want: return want
        time.sleep(0.01)
    return p.state()
r = {'running': settle('running')}
tool('#!/usr/bin/env bash\\nexec sleep 30\\n')
t0 = time.monotonic()
worst = 0.0
seen = []
end = time.monotonic() + 5
while time.monotonic() < end:
    a = time.monotonic()
    pool.reap(); p.tick(time.monotonic()); p.state()
    worst = max(worst, time.monotonic() - a)
    if not seen or seen[-1] != (p.state(), p.reason()):
        seen.append((p.state(), p.reason()))
    if p.state() == 'unknown': break
    time.sleep(0.01)
r['worst'] = worst
r['seen'] = seen
pool.close()
print(json.dumps(r))
`)
  assert.equal(out.running, 'running')
  assert.ok(out.worst < 0.05, `tick() and state() return at once (${out.worst} s)`)
  assert.deepEqual(out.seen.at(-1), ['unknown', 'timeout'], 'a timeout is unknown, never absent')
  assert.deepEqual(out.seen[0], ['running', ''], 'running held through the first timeout')
})

test('the heartbeat follows the game: every 60 s while it runs, at the change, then every 300 s', () => {
  const out = py(`
from ppt_diag import ThrottledLog
from ppt_link import Heartbeat, headers
lines = []
log = ThrottledLog(60, clock=lambda: clock[0], emit=lines.append)
present = [True]
class Pool(FakePool):
    def __init__(self):
        FakePool.__init__(self, lambda argv: HIT if present[0] else MISS)
        self.posts = []
    def start(self, args, stdin_bytes=None, timeout_s=10, tag=None):
        self.posts.append((clock[0], json.loads(stdin_bytes.decode())))
        return FakeJob(CurlResult(0, 200, '{"ok":true,"presence":"playing","v":1}', '', False))
pool = Pool()
p = GameProbe('steam_app_238960', pool, env=DISP, seen_file=SEEN, check_s=10, which=which)
hb = Heartbeat(pool, 'http://h:1', headers('player1', '9.9.9', 'ab12'), log, lambda: clock[0],
               game=p.state, features=lambda: {'game': p.feature()}, interval_s=60, idle_interval_s=300)
t = 0
while t <= 700:
    at(t); p.tick(t); hb.tick(t)
    if t == 65: present[0] = False
    t += 1
print(json.dumps({'posts': [(at_, b['game'], b['everyS']) for at_, b in pool.posts]}))
`)
  const posts = out.posts
  // t=0: the probe's first check answers at once in the fake pool, so the first
  // beat already says running.
  assert.deepEqual(posts.slice(0, 2), [[0, 'running', 60], [60, 'running', 60]])
  // The game goes at 65 s; checks at 70 and 80 miss, the second one counts.
  const absent = posts.filter(p => p[1] === 'absent')
  assert.deepEqual(absent[0], [80, 'absent', 300], 'the change goes at once, after two checks in a row')
  assert.equal(absent[1][0], 380, 'then every 300 s')
  assert.ok(!posts.some(p => p[0] > 60 && p[0] < 80), 'no beat between: one miss is not a change yet')
})

test('check_once is the same verdict, blocking, for the self-test, and writes nothing', () => {
  const out = py(`
import subprocess
calls = []
def fake_run(answers):
    def run_(argv, **kw):
        calls.append(argv)
        a = answers.pop(0)
        if isinstance(a, Exception): raise a
        return subprocess.CompletedProcess(argv, a[0], a[1], a[2])
    return run_
r = {}
p = GameProbe('steam_app_238960', None, env=DISP, seen_file=SEEN, which=which)
r['hit'] = [p.check_once(run=fake_run([(0, '123\\n', '')])), p.reason()]
r['wrote'] = os.path.exists(SEEN)
p = GameProbe('steam_app_238960', None, env=DISP, seen_file=SEEN, which=which)
r['never'] = [p.check_once(run=fake_run([(1, '', ''), (1, '', '')])), p.reason()]
os.makedirs(os.path.dirname(SEEN), exist_ok=True)
with open(SEEN, 'w') as fh:
    json.dump({'v': 1, 'seen': [{'class': 'steam_app_238960', 'display': ':1'}]}, fh)
p = GameProbe('steam_app_238960', None, env=DISP, seen_file=SEEN, which=which)
r['absent'] = [p.check_once(run=fake_run([(1, '', ''), (1, '', '')])), p.reason()]
p = GameProbe('steam_app_238960', None, env=DISP, seen_file=SEEN, which=which)
r['timeout'] = [p.check_once(run=fake_run([subprocess.TimeoutExpired('xdotool', 1)])), p.reason()]
p = GameProbe('steam_app_238960', None, env={}, seen_file=SEEN, which=which)
r['nodisplay'] = [p.check_once(run=fake_run([])), p.reason()]
r['ncalls'] = len(calls)
print(json.dumps(r))
`)
  assert.deepEqual(out.hit, ['running', ''])
  assert.equal(out.wrote, false, 'the self-test changes nothing')
  assert.deepEqual(out.never, ['unknown', 'never-seen'])
  assert.deepEqual(out.absent, ['absent', ''])
  assert.deepEqual(out.timeout, ['unknown', 'timeout'])
  assert.deepEqual(out.nodisplay, ['unknown', 'no-display'])
  assert.equal(out.ncalls, 6)
})
