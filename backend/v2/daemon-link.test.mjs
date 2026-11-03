// daemon/ppt_link.py — the hotkey daemon's HTTP channels besides POST /item:
// the long-poll for results (Downlink) and the heartbeat, both through curl as
// child processes that never block the daemon's loop.
//
// Why this lives here: `npm test` covers only backend/v2 (same reason as
// daemon-diag.test.mjs). ppt_link.py is standard library only. The channels get
// a fake pool and a fake clock, so every schedule below is numbers, not sleeps;
// CurlPool itself is tested with real short child processes (a stub curl
// script, `sleep`), never with the network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')

const PRELUDE = `
import json, sys, time
sys.path.insert(0, sys.argv[1])
from ppt_diag import ThrottledLog
from ppt_link import *
clock = [0.0]
lines = []
log = ThrottledLog(60, clock=lambda: clock[0], emit=lines.append)
def at(t):
    clock[0] = float(t)
class FakeJob:
    def __init__(self, args, stdin_bytes, timeout_s, tag, t):
        self.args, self.stdin, self.timeout_s, self.tag, self.t = args, stdin_bytes, timeout_s, tag, t
        self.result = None
class FakePool:
    def __init__(self):
        self.jobs = []
    def start(self, args, stdin_bytes=None, timeout_s=10, tag=None):
        j = FakeJob(args, stdin_bytes, timeout_s, tag, clock[0])
        self.jobs.append(j)
        return j
    def open(self):
        return [j for j in self.jobs if j.result is None]
def answer(job, status=200, body='', rc=0, timed_out=False, err=''):
    job.result = CurlResult(rc, status, body, err, timed_out)
def url_of(job):
    return job.args[-1]
HDRS = headers('player1', '9.9.9', 'ab12')
`

function py (code, args = []) {
  const r = spawnSync('python3', ['-c', PRELUDE + code, DAEMON_DIR, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  assert.equal(r.status, 0, `python3 failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

test('the version comes from package.json, the instance is random and carries no name', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-link-'))
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }))
    const bad = path.join(root, 'bad')
    spawnSync('mkdir', [bad])
    writeFileSync(path.join(bad, 'package.json'), JSON.stringify({ version: '1.2.3 evil\nX-Other: 1' }))
    const out = py(`
r = {'good': read_version(sys.argv[2]), 'bad': read_version(sys.argv[3]), 'none': read_version(sys.argv[2] + '/nothing'),
     'a': new_instance(), 'b': new_instance(), 'h': HDRS}
print(json.dumps(r))
`, [root, bad])
    assert.equal(out.good, '1.2.3')
    assert.equal(out.bad, 'unknown', 'a version that is not a plain token never becomes a header')
    assert.equal(out.none, 'unknown')
    assert.match(out.a, /^[0-9a-f]{8}$/)
    assert.notEqual(out.a, out.b)
    assert.deepEqual(out.h, ['-H', 'X-User: player1', '-H', 'X-PPT-Daemon: 9.9.9', '-H', 'X-PPT-Instance: ab12'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('classify reads the status first and the JSON second', () => {
  const out = py(`
def c(status=200, body='', rc=0, timed_out=False):
    v = classify(CurlResult(rc, status, body, 'curl: (7) Failed to connect', timed_out))
    return [x if not isinstance(x, dict) else 'data' for x in v]
print(json.dumps([
  c(200, '{"v":1}'), c(404, 'Not found'), c(405, 'Method not allowed'),
  c(400, '{"error":"unknown user \\\\"x\\\\"","users":[]}'), c(400, '{"error":"missing X-PPT-Daemon header"}'),
  c(200, '<html>login</html>'), c(200, '[1]'), c(429, '{"error":"too-many-waiters","max":4}'),
  c(429, '{"error":"too-many-whispers"}'), c(429, ''), c(413, ''), c(None, '', rc=7), c(None, '', timed_out=True),
  c(500, '{"error":"internal"}')
]))
`)
  assert.deepEqual(out[0], ['ok', 'data'])
  assert.deepEqual(out[1], ['unsupported', 404])
  assert.deepEqual(out[2], ['unsupported', 405])
  assert.deepEqual(out[3].slice(0, 2), ['failing', 'unknown-user'])
  assert.deepEqual(out[4].slice(0, 2), ['failing', 'bad-request'])
  assert.deepEqual(out[5].slice(0, 2), ['failing', 'not-json'])
  assert.deepEqual(out[6].slice(0, 2), ['failing', 'not-json'], 'a JSON array is not an answer of this server')
  assert.deepEqual(out[7].slice(0, 2), ['failing', 'too-many-waiters'])
  assert.deepEqual(out[8].slice(0, 2), ['failing', 'too-many-whispers'])
  assert.deepEqual(out[9].slice(0, 2), ['failing', 'http-429'])
  assert.deepEqual(out[10].slice(0, 2), ['failing', 'too-large'])
  assert.deepEqual(out[11].slice(0, 2), ['failing', 'unreachable-7'])
  assert.deepEqual(out[12].slice(0, 2), ['failing', 'timeout'])
  assert.deepEqual(out[13].slice(0, 2), ['failing', 'http-500'])
})

test('a server without the route is one line and a re-check, not a loop', () => {
  const out = py(`
pool = FakePool()
d = Downlink('http://h:1', HDRS, pool, log, lambda: clock[0], hold_s=25)
at(0); d.tick(0)
answer(pool.jobs[0], 404, 'Not found')
at(0.1); d.tick(0.1)
state = d.state()
n_at_start = len(pool.jobs)
t = 0.1
while t < 599.5:
    t += 0.5; at(t); d.tick(t)
before = len(pool.jobs)
at(600.2); d.tick(600.2)
after = len(pool.jobs)
answer(pool.jobs[-1], 404, 'Not found')
at(600.3); d.tick(600.3)
print(json.dumps({'state': state, 'n': n_at_start, 'before': before, 'after': after, 'lines': lines}))
`)
  assert.equal(out.state, 'unsupported')
  assert.equal(out.n, 1)
  assert.equal(out.before, 1, 'no new request for 10 minutes')
  assert.equal(out.after, 2, 'exactly one after 600 s')
  assert.equal(out.lines.length, 1, out.lines.join('\n'))
  assert.match(out.lines[0], /has no \/daemon\/events \(HTTP 404\): it is older than this daemon/)
  assert.match(out.lines[0], /asks again every 10 min/)
})

test('an unreachable backend backs off and recovers with one line', () => {
  const out = py(`
pool = FakePool()
d = Downlink('http://h:1', HDRS, pool, log, lambda: clock[0], hold_s=25)
t = 0.0
times = []
while t <= 40 and len(times) < 5:
    at(t); d.tick(t)
    for j in pool.open():
        times.append(j.t); answer(j, None, '', rc=7)
    t = round(t + 0.1, 1)
state = d.state()
n_fail_lines = len(lines)
# now it answers
while not pool.open():
    t = round(t + 0.1, 1); at(t); d.tick(t)
answer(pool.open()[0], 200, json.dumps({'v': 1, 'boot': 'b1', 'seq': 3, 'reset': True, 'gap': False, 'events': []}))
t = round(t + 0.1, 1); at(t); d.tick(t)
ok_state = d.state()
# a failure after the recovery waits 2 s again, not 32
j = pool.open()[0] if pool.open() else None
while j is None:
    t = round(t + 0.1, 1); at(t); d.tick(t)
    j = pool.open()[0] if pool.open() else None
answer(j, None, '', rc=7); t0 = t
t = round(t + 0.1, 1); at(t); d.tick(t)
while not pool.open():
    t = round(t + 0.1, 1); at(t); d.tick(t)
print(json.dumps({'times': times, 'state': state, 'ok': ok_state, 'n_fail': n_fail_lines, 'lines': lines, 'again': round(t - t0, 1)}))
`)
  assert.deepEqual(out.times, [0, 2, 6, 14, 30])
  assert.equal(out.state, 'failing')
  assert.equal(out.n_fail, 1, 'five failures in 30 s are one line')
  assert.match(out.lines[0], /cannot reach http:\/\/h:1/)
  assert.match(out.lines[1], /Back channel works again \(5 failed attempt\(s\) before\)/)
  assert.equal(out.ok, 'ok')
  assert.ok(out.again >= 2 && out.again < 2.5, `backoff reset: ${out.again}`)
})

test('a reset moves since forward without replay, a gap and a new boot are passed on', () => {
  const out = py(`
pool = FakePool()
got, gaps = [], []
d = Downlink('http://h:1', HDRS, pool, log, lambda: clock[0], hold_s=25,
             on_events=lambda evs: got.append([e['seq'] for e in evs]), on_gap=gaps.append)
def step(t, body):
    at(t); d.tick(t)
    j = pool.open()[0]
    u = url_of(j)
    answer(j, 200, json.dumps(body))
    at(t + 0.01); d.tick(t + 0.01)
    return u
u0 = step(0, {'v': 1, 'boot': 'b2', 'seq': 40, 'reset': True, 'gap': False, 'events': []})
u1 = step(30, {'v': 1, 'boot': 'b2', 'seq': 42, 'reset': False, 'gap': True, 'events': [{'seq': 42, 'kind': 'item'}]})
u2 = step(60, {'v': 1, 'boot': 'b3', 'seq': 1, 'reset': True, 'gap': False, 'events': []})
u3 = step(90, {'v': 1, 'boot': 'b3', 'seq': 1, 'reset': False, 'gap': False, 'events': []})
print(json.dumps({'u': [u0, u1, u2, u3], 'got': got, 'gaps': gaps, 'hold': pool.jobs[0].args[1]}))
`)
  assert.match(out.u[0], /\/daemon\/events\?wait=25000$/, 'the first request names no since and no boot')
  assert.match(out.u[1], /since=40&boot=b2/)
  assert.match(out.u[2], /since=42&boot=b2/)
  assert.match(out.u[3], /since=1&boot=b3/)
  assert.deepEqual(out.got, [[42]], 'a reset replays nothing')
  assert.deepEqual(out.gaps, ['gap', 'server restarted'])
  assert.equal(out.hold, '35', 'curl waits the hold plus 10 s')
})

test('a proxy page instead of JSON is named as such, a hanging curl is ended', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-link-'))
  try {
    const curl = path.join(root, 'curl')
    writeFileSync(curl, '#!/usr/bin/env bash\ncat >/dev/null\nprintf \'{"v":1,"args":%s}\\n200\' "$#"\n', { mode: 0o755 })
    const out = py(`
pool = FakePool()
d = Downlink('http://h:1', HDRS, pool, log, lambda: clock[0], hold_s=25)
at(0); d.tick(0); answer(pool.jobs[0], 200, '<html>login</html>'); at(0.1); d.tick(0.1)
state = d.state()
real = CurlPool(curl=sys.argv[2])
t0 = time.monotonic()
j = real.start(['-X', 'POST', 'http://x/'], stdin_bytes=b'{}', timeout_s=5, tag='t')
res = None
while res is None and time.monotonic() - t0 < 5:
    for job, r in real.reap():
        if job is j: res = r
    time.sleep(0.01)
s = real.start_cmd(['sleep', '30'], timeout_s=0.3)
t1 = time.monotonic(); sres = None
while sres is None and time.monotonic() - t1 < 5:
    for job, r in real.reap():
        if job is s: sres = r
    time.sleep(0.01)
took = time.monotonic() - t1
k = real.start_cmd(['sleep', '30'], timeout_s=60)
real.close()
k.proc.wait(timeout=3)
print(json.dumps({'state': state, 'lines': lines, 'status': res.status, 'body': res.body, 'rc': res.rc,
                  'timed_out': sres.timed_out, 'took': took, 'job_result_kept': j.result is res,
                  'closed_rc': k.proc.returncode}))
`, [curl])
    assert.equal(out.state, 'failing')
    assert.match(out.lines[0], /not JSON/)
    assert.match(out.lines[0], /reverse proxy/)
    assert.equal(out.status, 200)
    assert.equal(out.rc, 0)
    assert.match(out.body, /^\{"v":1,"args":\d+\}$/)
    assert.equal(out.job_result_kept, true)
    assert.equal(out.timed_out, true)
    assert.ok(out.took < 1, `ended within 1 s, took ${out.took}`)
    assert.notEqual(out.closed_rc, null, 'close() ends every running child')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a server or proxy that answers at once never makes a tight loop', () => {
  const out = py(`
pool = FakePool()
got = []
d = Downlink('http://h:1', HDRS, pool, log, lambda: clock[0], hold_s=25, min_gap_s=2, on_events=got.append)
t = 0.0
while t <= 10.0:
    at(t); d.tick(t)
    for j in pool.open():
        answer(j, 200, json.dumps({'v': 1, 'boot': 'b', 'seq': 0, 'reset': False, 'gap': False, 'events': []}))
    t = round(t + 0.05, 2)
quiet = len(pool.jobs)
# an answer with events: the next request goes at once
at(20); d.tick(20)
j = pool.open()[0]
answer(j, 200, json.dumps({'v': 1, 'boot': 'b', 'seq': 1, 'reset': False, 'gap': False, 'events': [{'seq': 1, 'kind': 'item'}]}))
n = len(pool.jobs)
at(20.05); d.tick(20.05)
print(json.dumps({'quiet': quiet, 'next_at_once': len(pool.jobs) - n, 'state': d.state()}))
`)
  assert.ok(out.quiet <= 6, `at most 6 requests in 10 s, got ${out.quiet}`)
  assert.equal(out.next_at_once, 1)
  assert.equal(out.state, 'ok')
})

test('back_channel = false never asks', () => {
  const out = py(`
pool = FakePool()
d = Downlink('http://h:1', HDRS, pool, log, lambda: clock[0], enabled=False)
for t in range(0, 100): at(t); d.tick(t)
print(json.dumps({'n': len(pool.jobs), 'state': d.state()}))
`)
  assert.deepEqual(out, { n: 0, state: 'off' })
})

test('the heartbeat goes at start and on a change, else at its interval', () => {
  const out = py(`
pool = FakePool()
game = ['unknown']
feats = [{'downlink': 'ok'}]
hb = Heartbeat(pool, 'http://h:1', HDRS, log, lambda: clock[0], game=lambda: game[0], features=lambda: dict(feats[0]))
sent = []
def run(t0, t1, step=1.0):
    t = t0
    while t <= t1:
        at(t); hb.tick(t)
        for j in pool.open():
            sent.append((t, json.loads(j.stdin.decode())))
            answer(j, 200, '{"ok":true,"presence":"unknown","v":1}')
        t += step
run(0, 59)
first = list(sent)
run(60, 69)
at_60 = len(sent)
feats[0] = {'downlink': 'ok', 'notify': 'missing'}
run(70, 70)
at_70 = len(sent)
game[0] = 'running'
run(71, 200)
game[0] = 'absent'
run(201, 700)
print(json.dumps({'first': first, 'at_60': at_60, 'at_70': at_70, 'sent': sent, 'url': url_of(pool.jobs[0]),
                  'args': pool.jobs[0].args, 'state': hb.state()}))
`)
  // No game probe (game 'unknown'): every 60 s, so the server, which keeps a
  // beat for 3 x everyS, drops a stopped daemon after 3 min, not 15.
  assert.equal(out.first.length, 1, 'one beat at start, none for 59 s')
  assert.deepEqual(out.first[0][1], { v: 1, game: 'unknown', everyS: 60, features: { downlink: 'ok' } })
  assert.equal(out.at_60, 2, 'the next one at 60 s')
  assert.equal(out.at_70, 3, 'a changed feature goes at once')
  const running = out.sent.filter(s => s[1].game === 'running')
  assert.equal(running[0][0], 71, 'a changed game state goes at once')
  assert.equal(running[0][1].everyS, 60)
  assert.equal(running[1][0] - running[0][0], 60, 'then every 60 s')
  const absent = out.sent.filter(s => s[1].game === 'absent')
  assert.equal(absent[0][0], 201)
  assert.equal(absent[0][1].everyS, 300, 'only a game that is known to be closed rests')
  assert.equal(absent[1][0] - absent[0][0], 300)
  assert.match(out.url, /\/daemon\/heartbeat$/)
  assert.ok(out.args.includes('X-PPT-Daemon: 9.9.9'))
  assert.ok(out.args.includes('Content-Type: application/json'))
  assert.equal(out.state, 'ok')
})

test('an unknown user is one line and a re-check every 10 min on both channels, not a backoff loop', () => {
  const out = py(`
pool = FakePool()
feats = [{'downlink': 'failing'}]
d = Downlink('http://h:1', HDRS, pool, log, lambda: clock[0], hold_s=25, user='player1')
hb = Heartbeat(pool, 'http://h:1', HDRS, log, lambda: clock[0], features=lambda: dict(feats[0]), user='player1')
asked = {'downlink': [], 'heartbeat': []}
t = 0.0
while t <= 1300:
    at(t); d.tick(t); hb.tick(t)
    for j in pool.open():
        asked[j.tag].append(t); answer(j, 400, '{"error":"unknown user \\\\"player1\\\\"","users":["player2"]}')
    if t == 100: feats[0] = {'downlink': 'failing', 'notify': 'missing'}
    t += 1.0
n_lines = len(lines)
states = [d.state(), hb.state()]
# the server learns the user: both come back with one line each
while t <= 1900:
    at(t); d.tick(t); hb.tick(t)
    for j in pool.open():
        asked[j.tag].append(t)
        answer(j, 200, '{"v":1,"boot":"b","seq":0,"reset":true,"gap":false,"events":[]}' if j.tag == 'downlink' else '{"ok":true,"v":1}')
    t += 1.0
print(json.dumps({'asked': asked, 'n_lines': n_lines, 'lines': lines, 'states': states, 'after': [d.state(), hb.state()]}))
`)
  assert.deepEqual(out.asked.downlink.slice(0, 3), [0, 601, 1202])
  assert.deepEqual(out.asked.heartbeat.slice(0, 3), [0, 601, 1202], 'a changed feature does not ask again either')
  assert.equal(out.n_lines, 2, out.lines.join('\n'))
  assert.match(out.lines[0], /does not know user "player1".*asks again every 10 min\./)
  assert.deepEqual(out.states, ['failing', 'failing'])
  assert.deepEqual(out.after, ['ok', 'ok'])
  assert.ok(out.asked.downlink.at(-1) > 1800, 'the downlink polls on once it is ok')
})

test('a heartbeat to an older server is one line and a re-check, and a change does not ask again', () => {
  const out = py(`
pool = FakePool()
feats = [{'downlink': 'ok'}]
hb = Heartbeat(pool, 'http://h:1', HDRS, log, lambda: clock[0], features=lambda: dict(feats[0]))
n = []
t = 0.0
while t <= 700:
    at(t); hb.tick(t)
    for j in pool.open():
        n.append(t); answer(j, 405, 'Method not allowed')
    if t == 100: feats[0] = {'downlink': 'unsupported'}
    t += 1.0
print(json.dumps({'n': n, 'lines': lines, 'state': hb.state()}))
`)
  assert.deepEqual(out.n, [0, 601])
  assert.equal(out.lines.length, 1, out.lines.join('\n'))
  assert.match(out.lines[0], /has no \/daemon\/heartbeat \(HTTP 405\): it is older than this daemon\. The server cannot see which parts of this daemon work/)
  assert.equal(out.state, 'unsupported')
})
