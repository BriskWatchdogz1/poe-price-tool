// daemon/ppt_diag.py — the hotkey daemon's throttled journal and the wording
// of every failure it can name.
//
// Why this lives here: `npm test` covers only backend/v2, so a test
// outside this directory would never run (same reason as
// daemon-post-filter.test.mjs). The module is Python; python3 is already a
// prerequisite of the suite (daemon-selftest.test.mjs runs the config reader).
// ppt_diag.py imports only the standard library, so it loads without
// python-evdev, without a device, a clipboard or a network. The clock and the
// output are injected: every timing below is a number, not a sleep.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseWhisper } from './whisper.mjs'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')

// Prelude for every snippet: ppt_diag importable, a fake clock, a list as the
// journal. The snippet prints one JSON value as its result.
const PRELUDE = `
import json, sys
sys.path.insert(0, sys.argv[1])
from ppt_diag import *
clock = [0.0]
lines = []
def make(interval=60, **kw):
    return ThrottledLog(interval, clock=lambda: clock[0], emit=lines.append, **kw)
def at(t):
    clock[0] = float(t)
`

/** Run `code` after the prelude; returns the JSON it printed. */
function py (code) {
  const r = spawnSync('python3', ['-c', PRELUDE + code, DAEMON_DIR], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  assert.equal(r.status, 0, `python3 failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

test('the first failure is logged at once, repeats inside the interval are counted', () => {
  const out = py(`
log = make(60)
k = ('post', 'http-400')
res = []
at(0);  res.append(log.failure(k, 'boom'))
at(10); res.append(log.failure(k, 'boom'))
at(20); res.append(log.failure(k, 'boom'))
n_before = len(lines)
at(61); res.append(log.failure(k, 'boom'))
print(json.dumps({'res': res, 'lines': lines, 'n_before': n_before}))
`)
  assert.deepEqual(out.res, [true, false, false, true])
  assert.equal(out.n_before, 1, 'nothing is written inside the interval')
  assert.equal(out.lines[0], '[poe-price-daemon] boom')
  assert.ok(out.lines[1].startsWith('[poe-price-daemon] boom '), out.lines[1])
  assert.match(out.lines[1], /\(repeat 1; and 2 more time\(s\) in the last 61 s\)$/, 'the repeat line names its number and what it swallowed')
})

test('a failure that never stops slows down to the long interval after 10 repeats', () => {
  // A permanent misconfiguration at one line a minute is 1.440 lines a day.
  const out = py(`
log = make(60, slow_interval=600, slow_after=10)
k = ('clipboard', 'no-display')
res = []
at(0); log.failure(k, 'no display')
for i in range(1, 11):
    at(61 * i); res.append(log.failure(k, 'no display'))
at(61 * 10 + 61); res.append(log.failure(k, 'no display'))
at(61 * 10 + 599); res.append(log.failure(k, 'no display'))
at(61 * 10 + 600); res.append(log.failure(k, 'no display'))
print(json.dumps({'res': res, 'lines': lines}))
`)
  assert.deepEqual(out.res, [...Array(10).fill(true), false, false, true],
    'ten repeats a minute apart, then nothing for 600 s')
  assert.match(out.lines[10], /repeat 10;.*from now on at most every 600 s/, 'the switch is announced on the line that makes it')
  assert.doesNotMatch(out.lines[9], /600 s/)
  assert.match(out.lines[11], /\(repeat 11; and 2 more time\(s\) in the last 600 s\)$/)
})

test("one failure's throttle does not swallow a different one", () => {
  const out = py(`
log = make(60)
at(0)
log.failure(('post', 'http-400'), 'a')
log.failure(('post', 'unreachable-7'), 'b')
print(json.dumps(lines))
`)
  assert.deepEqual(out, ['[poe-price-daemon] a', '[poe-price-daemon] b'])
})

test('recovery closes a failure so the next one is logged at once', () => {
  const out = py(`
log = make(60)
k = ('post', 'http-400')
at(0); log.failure(k, 'x')
at(1); log.failure(k, 'x')
n = log.recovered('post')
at(5); again = log.failure(k, 'x')
empty = make(60).recovered('post')
other = log.recovered('clipboard')
log.info('hello')
print(json.dumps({'n': n, 'again': again, 'empty': empty, 'other': other, 'lines': lines}))
`)
  assert.equal(out.n, 2, 'recovered() returns how many failures it closed')
  assert.equal(out.again, true)
  assert.deepEqual(out.lines, ['[poe-price-daemon] x', '[poe-price-daemon] x', '[poe-price-daemon] hello'])
  assert.equal(out.empty, 0)
  assert.equal(out.other, 0, 'a category with nothing open recovers nothing')
})

test("post_outcome maps the handler's exit contract", () => {
  const out = py(`
r = [post_outcome(0, '', '/h'), post_outcome(3, '', '/h'),
     post_outcome(4, '[http-400-unknown-user] POST /item rejected: HTTP 400 {}\\n', '/h'),
     post_outcome(4, 'garbage', '/h'),
     post_outcome(127, 'bash: curl: command not found\\n', '/h'),
     post_outcome(4, '[http-400] POST /item rejected: HTTP 400 {}\\n', '/h')]
print(json.dumps(r))
`)
  assert.deepEqual(out[0], ['ok', null, null])
  assert.deepEqual(out[1], ['skipped', null, null])
  assert.equal(out[2][0], 'failed')
  assert.deepEqual(out[2][1], ['post', 'http-400-unknown-user'])
  assert.equal(out[2][2], 'POST /item rejected: HTTP 400 {}', 'the tag is the key, not part of the text')
  assert.deepEqual(out[3][1], ['post', 'untagged'])
  assert.match(out[3][2], /garbage/)
  assert.deepEqual(out[4][1], ['post', 'handler', 127])
  assert.match(out[4][2], /exited 127/)
  assert.match(out[4][2], /selftest\.sh/)
  assert.deepEqual(out[5][1], ['item', 'http-400'],
    'one unreadable item is a fault of that item, not of the POST path: a category of its own')
})

test('xsel problems name their cause: no DISPLAY, missing xsel, other exit', () => {
  const out = py(`
print(json.dumps([
  xsel_problem((1, "xsel: Can't open display: (null)\\n: Inappropriate ioctl"), '', '/usr/bin:/bin', 1),
  xsel_problem('missing', ':0', '/opt/x/bin:/usr/bin', 1),
  xsel_problem((1, 'boom'), ':0', '/usr/bin', 1),
  xsel_problem('timeout', ':0', '/usr/bin', 1),
]))
`)
  assert.deepEqual(out[0][0], ['clipboard', 'no-display'])
  assert.match(out[0][1], /DISPLAY is not set/)
  assert.match(out[0][1], /import-environment DISPLAY XAUTHORITY/)
  assert.deepEqual(out[1][0], ['clipboard', 'xsel-missing'])
  assert.match(out[1][1], /\/opt\/x\/bin:\/usr\/bin/, 'the PATH the daemon really has')
  assert.match(out[2][1], /exited 1 on DISPLAY=:0: boom/)
  assert.deepEqual(out[3][0], ['clipboard', 'xsel-timeout'])
})

test('ydotool problems all say that the macro was not sent', () => {
  const out = py(`
print(json.dumps([
  ydotool_problem('no-socket', '/run/user/1/.ydotool_socket', '/cfg.toml', 10),
  ydotool_problem('missing', '/s', '/cfg.toml', 10),
  ydotool_problem('timeout', '/s', '/cfg.toml', 10),
  ydotool_problem((2, 'failed to connect socket\\n'), '/s', '/cfg.toml', 10),
]))
`)
  for (const [, text] of out) assert.match(text, /^Chat macro not sent: /)
  assert.deepEqual(out[0][0], ['ydotool', 'socket'])
  assert.match(out[0][1], /\/run\/user\/1\/\.ydotool_socket does not exist/)
  assert.match(out[0][1], /\/cfg\.toml/)
  assert.deepEqual(out[3][0], ['ydotool', 2, 'failed to connect socket'])
  assert.match(out[3][1], /exited 2: failed to connect socket/)
})

test('health_report and users_report tell the start-up verdicts apart', () => {
  const out = py(`
u = 'http://b:8788'
print(json.dumps({
  'nocurl': health_report(None, '', '', u, '/c'),
  'down': health_report(7, '000 ', 'curl: (7) Failed to connect\\n', u, '/c'),
  'redir': health_report(0, '301 https://x/health', '', u, '/c'),
  'notfound': health_report(0, '404 ', '', u, '/c'),
  'ok': health_report(0, '200 ', '', u, '/c'),
  'unknown': users_report(0, '{"users":["a"]}', 'b', u, '/c'),
  'known': users_report(0, '{"users":["a","b"]}', 'b', u, '/c'),
  'garbage': users_report(0, 'not json', 'b', u, '/c'),
  'nolist': users_report(0, '{"x":1}', 'b', u, '/c'),
  'failed': users_report(7, '', 'b', u, '/c'),
}))
`)
  assert.deepEqual(out.nocurl[0], ['backend', 'no-curl'])
  assert.match(out.down[1], /cannot reach/)
  assert.match(out.down[1], /curl exit 7/)
  assert.match(out.redir[1], /redirect to https:\/\/x\/health/)
  assert.match(out.redir[1], /does not follow redirects/)
  assert.match(out.notfound[1], /HTTP 404 instead of 200/)
  assert.equal(out.ok[0], null)
  assert.match(out.ok[1], /answers/)
  assert.deepEqual(out.unknown[0], ['backend', 'unknown-user'])
  assert.match(out.unknown[1], /it knows: a/)
  assert.equal(out.known[0], null)
  assert.match(out.known[1], /knows user "b"/)
  assert.equal(out.garbage, null)
  assert.equal(out.nolist, null)
  assert.equal(out.failed, null)
})

test('the back channel and the notification name their cause and the next step', () => {
  const out = py(`
r = [link_problem('downlink', ('unsupported', 404), 'http://h', '/c.toml')[1],
     link_problem('heartbeat', ('unsupported', 405), 'http://h', '/c.toml', reprobe_s=1200)[1],
     link_problem('downlink', ('failing', 'unreachable-7', 'curl: (7) Failed to connect'), 'http://h', '/c.toml'),
     link_problem('downlink', ('failing', 'unreachable-56', 'curl: (56) Recv failure'), 'http://h', '/c.toml')[1],
     link_problem('downlink', ('failing', 'timeout', ''), 'http://h', '/c.toml')[1],
     link_problem('downlink', ('failing', 'too-many-waiters', ''), 'http://h', '/c.toml', user='player1')[1],
     link_problem('downlink', ('failing', 'unknown-user', ''), 'http://h', '/c.toml', user='player1')[1],
     link_problem('heartbeat', ('failing', 'http-500', 'internal'), 'http://h', '/c.toml')[1],
     link_recovered('downlink', 3), link_recovered('heartbeat', 1, was_unsupported=True),
     notify_problem('missing'), notify_problem('timeout')[1], notify_problem((1, 'GDBus.Error: no bus\\nmore'))]
print(json.dumps(r))
`)
  assert.match(out[0], /^The backend at http:\/\/h has no \/daemon\/events \(HTTP 404\): it is older than this daemon\. Prices stay in the browser.*Next: update the server.*every 10 min\.$/)
  assert.match(out[1], /\/daemon\/heartbeat \(HTTP 405\).*cannot see which parts of this daemon work.*every 20 min/)
  assert.deepEqual(out[2][0], ['downlink', 'unreachable-7'])
  assert.match(out[2][1], /GET \/daemon\/events failed: cannot reach http:\/\/h — curl: \(7\) Failed to connect \(curl exit 7\)\. Next: nothing listens there/)
  assert.match(out[3], /the exchange with http:\/\/h broke off/)
  assert.match(out[4], /no answer from http:\/\/h in time.*read timeout must be above 30 s/)
  assert.match(out[5], /most result requests it allows for user "player1".*second daemon/)
  assert.match(out[6], /does not know user "player1"/)
  assert.match(out[7], /POST \/daemon\/heartbeat failed: HTTP 500 internal\. Next: check the backend log\./)
  assert.equal(out[8], 'Back channel works again (3 failed attempt(s) before).')
  assert.match(out[9], /^Heartbeat is offered by the backend now/)
  assert.deepEqual(out[10][0], ['notify', 'missing'])
  assert.match(out[10][1], /notify-send is not on the daemon's PATH\. Next: install libnotify/)
  assert.match(out[11], /did not finish within 5 s/)
  assert.deepEqual(out[12][0], ['notify', 1, 'GDBus.Error: no bus'])
  assert.match(out[12][1], /notify-send exited 1: GDBus\.Error: no bus\. Next: \.\/daemon\/selftest\.sh \(section 9/)
})

test('the daemon script itself parses without evdev', () => {
  // poe-price-daemon.py imports evdev at module level, so it cannot be imported
  // here; parsing it still catches a syntax error before a player does.
  const r = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])',
    path.join(DAEMON_DIR, 'poe-price-daemon.py')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

// --- the daemon's wiring ------------------------------------------------------
// poe-price-daemon.py itself, loaded with a stand-in for python-evdev (it only
// needs `ecodes` to turn key names into numbers) and a PATH holding exactly
// the stub tools a scenario gives it. The stubs read their behaviour from
// files in the scenario directory, so one run can switch a tool from failing
// to working. Nothing here reads the real clipboard or types a key.

const WIRING = `
import importlib.util, json, os, sys, types
daemon_dir, root = sys.argv[1], sys.argv[2]
sys.path.insert(0, daemon_dir)
ec = types.ModuleType('evdev.ecodes')
ec.EV_KEY = 1
ec.__getattr__ = lambda name: sum(map(ord, name))
ev = types.ModuleType('evdev')
ev.ecodes = ec
sys.modules['evdev'] = ev
sys.modules['evdev.ecodes'] = ec
spec = importlib.util.spec_from_file_location('ppd', os.path.join(daemon_dir, 'poe-price-daemon.py'))
ppd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ppd)
clock = [0.0]
lines = []
def at(t):
    clock[0] = float(t)
def make(**cfg):
    base = {'poe_window_class': 'x', 'backend_url': 'http://127.0.0.1:1', 'user': 'player1'}
    base.update(cfg)
    app = ppd.PriceDaemon(base, os.path.join(root, 'config.toml'))
    app.log.clock = lambda: clock[0]
    app.log.emit = lines.append
    return app
def put(name, text):
    with open(os.path.join(root, name), 'w') as fh:
        fh.write(text)
def drop(name):
    try: os.remove(os.path.join(root, name))
    except FileNotFoundError: pass
`

// xsel: prints the file `clip`, unless the file `xsel-fail` exists.
// ydotool: appends its arguments to `ydo.calls`, exits with the number in `ydo.rc`.
// notify-send: appends its arguments as one JSON line to `notify.calls` and
// prints an id, like notify-send --print-id; nothing pops up.
const STUBS = {
  'notify-send': `#!/usr/bin/env python3
import json, os, sys
calls = os.path.join(os.environ['STUB_ROOT'], 'notify.calls')
n = 0
if os.path.exists(calls):
    with open(calls) as fh: n = len(fh.read().splitlines())
with open(calls, 'a') as fh: fh.write(json.dumps(sys.argv[1:]) + '\\n')
print(100 + n)
`,
  xsel: `#!/usr/bin/env bash
if [ -e "$STUB_ROOT/xsel-fail" ]; then echo "xsel: Can't open display: (null)" >&2; exit 1; fi
cat "$STUB_ROOT/clip" 2>/dev/null
`,
  ydotool: `#!/usr/bin/env bash
echo "$*" >>"$STUB_ROOT/ydo.calls"
rc="$(cat "$STUB_ROOT/ydo.rc" 2>/dev/null || echo 0)"
[ "$rc" = 0 ] || echo "boom" >&2
exit "$rc"
`
}

const whichBin = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim()

/** A scenario dir with a bin/ of stubs plus the real `link` tools. */
function scenario (link = ['bash', 'cat', 'rm', 'curl', 'id', 'python3']) {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-daemon-'))
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  for (const cmd of link) symlinkSync(whichBin(cmd), path.join(bin, cmd))
  for (const [name, body] of Object.entries(STUBS)) writeFileSync(path.join(bin, name), body, { mode: 0o755 })
  return { root, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Run `code` after the wiring prelude in scenario `sc`; async (a mock server may answer). */
function wiring (sc, code, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(whichBin('python3'), ['-c', WIRING + code, DAEMON_DIR, sc.root], {
      // XDG_STATE_HOME: the game probe's seen file (ppt_presence) stays in the scenario.
      env: { PATH: sc.bin, STUB_ROOT: sc.root, XDG_RUNTIME_DIR: sc.root, XDG_STATE_HOME: sc.root, PYTHONDONTWRITEBYTECODE: '1', ...env }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    // A failure rejects (an assert thrown in this callback would leave the
    // promise, and a test holding a mock server, open for good).
    child.on('close', status => {
      if (status !== 0) { reject(new Error(`python3 failed: ${err}`)); return }
      try { resolve(JSON.parse(out)) } catch (e) { reject(new Error(`${e.message}: ${out}\n${err}`)) }
    })
  })
}

test('a clipboard the daemon cannot read is one journal line, and so is its recovery', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, `
put('xsel-fail', '')
app = make()
before = list(lines)
for t in (0, 1, 2):
    at(t); app._read_clipboard()
drop('xsel-fail'); put('clip', 'hello')
at(3); text = app._read_clipboard()
print(json.dumps({'before': before, 'lines': lines, 'text': text}))
`)
    assert.deepEqual(out.before, [], 'the baseline read at start is not reported (the start-up check is)')
    assert.equal(out.lines.length, 2, out.lines.join('\n'))
    assert.match(out.lines[0], /Clipboard not readable: DISPLAY is not set in the daemon's environment/)
    assert.match(out.lines[0], /Can't open display/)
    assert.match(out.lines[1], /Clipboard readable again via xsel \(3 failed read\(s\) before\)/)
    assert.equal(out.text, 'hello')
  } finally { sc.cleanup() }
})

test("a failed POST reaches the journal in the handler's own words, a skipped one does not", async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, `
put('clip', 'before')
app = make()
def settle():
    for p in app._posts: p.wait()
    app._reap_posts()
put('clip', 'some browser text'); app.poll_clipboard(); settle()
skipped = list(lines)
put('clip', 'Item Class: Belts\\nRarity: Unique\\nHeadhunter'); app.poll_clipboard(); settle()
print(json.dumps({'skipped': skipped, 'lines': lines}))
`)
    assert.deepEqual(out.skipped, [], 'every Ctrl+C in the game is a skip: no line')
    assert.equal(out.lines.length, 1)
    assert.match(out.lines[0], /^\[poe-price-daemon\] POST \/item failed: cannot reach http:\/\/127\.0\.0\.1:1 — curl: \(7\)/)
    assert.doesNotMatch(out.lines[0], /\[unreachable-7\]/, 'the tag is the throttle key, not journal text')
  } finally { sc.cleanup() }
})

test('one unreadable item is not followed by a "works again" line', async () => {
  // A 400 for one item that the backend could not read says nothing about the
  // POST path; the next item that arrives fine must not read like a repair.
  let n = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      n++
      if (n === 1) res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"could not parse item"}')
      else res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"x"}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const sc = scenario()
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const out = await wiring(sc, `
put('clip', 'before')
app = make(backend_url='${url}')
def settle():
    for p in app._posts: p.wait()
    app._reap_posts()
put('clip', 'Item Class: Belts\\nRarity: Unique\\nHeadhunter'); app.poll_clipboard(); settle()
put('clip', 'Item Class: Belts\\nRarity: Unique\\nMageblood'); app.poll_clipboard(); settle()
put('clip', 'Item Class: Belts\\nRarity: Unique\\nDarkness Enthroned'); app.poll_clipboard(); settle()
print(json.dumps({'lines': lines, 'open': [list(k) for k in app.log._open]}))
`)
    assert.equal(out.lines.length, 1, out.lines.join('\n'))
    assert.match(out.lines[0], /POST \/item rejected: HTTP 400/)
    assert.deepEqual(out.open, [], 'the item fault is closed by the next good item, without a line')
  } finally {
    sc.cleanup()
    await new Promise(resolve => server.close(resolve))
  }
})

test('a handler that writes more than a pipe holds still ends, and its line is bounded', async () => {
  // The daemon used to read stderr only after the handler had ended; 200 KB on
  // stderr then blocked the handler on its write for good, without a line.
  const sc = scenario()
  try {
    writeFileSync(path.join(sc.bin, 'big-post'), `#!/usr/bin/env bash
cat >/dev/null
s=xxxxxxxxxx; for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do s="$s$s"; done
printf '[big] %s\\n' "$s" >&2
exit 4
`, { mode: 0o755 })
    const out = await wiring(sc, `
import time
put('clip', 'before')
app = make()
app.post_handler = os.path.join(root, 'bin', 'big-post')
put('clip', 'Item Class: Belts'); app.poll_clipboard()
end = time.monotonic() + 10
while app._posts and time.monotonic() < end:
    time.sleep(0.02); app._reap_posts()
print(json.dumps({'running': len(app._posts), 'lines': lines}))
`)
    assert.equal(out.running, 0, 'the handler ended')
    assert.equal(out.lines.length, 1, out.lines.map(l => l.slice(0, 80)).join('\n'))
    assert.match(out.lines[0], /^\[poe-price-daemon\] xxxx/)
    assert.ok(out.lines[0].length <= 8192 + 100, `length ${out.lines[0].length}`)
  } finally { sc.cleanup() }
})

test('a start-up check that failed is closed with one line by the first item that arrives', async () => {
  // Typical: the daemon starts at login, before the network or the container.
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"x"}'))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const sc = scenario()
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const out = await wiring(sc, `
put('clip', 'before')
app = make(backend_url='http://127.0.0.1:1', results={'overlay': 'off'})
app.startup_checks()
app.backend_url = '${url}'
def settle():
    for p in app._posts: p.wait()
    app._reap_posts()
put('clip', 'Item Class: Belts\\nRarity: Unique\\nHeadhunter'); app.poll_clipboard(); settle()
put('clip', 'Item Class: Belts\\nRarity: Unique\\nMageblood'); app.poll_clipboard(); settle()
print(json.dumps(lines))
`, { DISPLAY: ':7' })
    assert.equal(out.length, 4, out.join('\n'))
    assert.match(out[0], /Start-up check FAILED: cannot reach the backend/)
    assert.match(out[1], /clipboard readable via xsel/)
    assert.match(out[2], /Results in the game: notification ok, overlay off/)
    assert.match(out[3], /Backend answers now: an item was posted \(the start-up check had failed\)/)
    assert.doesNotMatch(out.join('\n'), /daemon\/events/, 'no back-channel check against a backend that does not answer')
  } finally {
    sc.cleanup()
    await new Promise(resolve => server.close(resolve))
  }
})

test('a macro is not typed half-way when ydotool fails, and says so', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, `
sock = os.path.join(root, 'ydo.sock')
app = make(ydotool_socket=sock, macros={'chat_open_delay_ms': 0, 'keys': {'F5': '/hideout'}})
def calls():
    try:
        with open(os.path.join(root, 'ydo.calls')) as fh: return len(fh.read().splitlines())
    except FileNotFoundError: return 0
at(0); app.do_macro('/hideout'); no_socket = calls()
put('ydo.sock', ''); put('ydo.rc', '1')
at(1); app.do_macro('/hideout'); failing = calls()
put('ydo.rc', '0')
at(2); app.do_macro('/hideout'); working = calls()
print(json.dumps({'no_socket': no_socket, 'failing': failing, 'working': working, 'lines': lines}))
`)
    assert.equal(out.no_socket, 0, 'without a socket nothing is sent to ydotool at all')
    assert.equal(out.failing, 1, 'the failing Enter stops the macro: no typing, no second Enter')
    assert.equal(out.working, 4, 'then the whole macro: Enter, the text, Enter')
    assert.match(out.lines[0], /Chat macro not sent: the ydotool socket .*ydo\.sock does not exist/)
    assert.match(out.lines[1], /Chat macro not sent: ydotool exited 1: boom/)
    assert.match(out.lines[2], /Chat macros work again \(2 failed attempt\(s\) before\)/)
  } finally { sc.cleanup() }
})

test('the start-up check names an unknown user and a readable clipboard', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200).end('ok'); return }
    if (req.url === '/users') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"users":["someone-else"]}'); return }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const sc = scenario()
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const out = await wiring(sc, `
put('clip', 'x')
app = make(backend_url='${url}', results={'overlay': 'off'})
app.startup_checks()
print(json.dumps(lines))
`, { DISPLAY: ':7' })
    assert.equal(out.length, 3, out.join('\n'))
    assert.match(out[0], /Start-up check FAILED: the backend at .* does not know user "player1" \(it knows: someone-else\)/)
    assert.match(out[1], /Start-up check: clipboard readable via xsel \(DISPLAY=:7\)/)
    assert.match(out[2], /Results in the game: notification ok, overlay off/)
  } finally {
    sc.cleanup()
    await new Promise(resolve => server.close(resolve))
  }
})

test('the start-up check says when nothing answers, and when xsel is missing', async () => {
  const sc = scenario()
  try {
    rmSync(path.join(sc.bin, 'xsel'))
    const out = await wiring(sc, `
app = make(backend_url='http://127.0.0.1:1/', results={'overlay': 'off'})
app.startup_checks()
print(json.dumps(lines))
`)
    assert.equal(out.length, 3, out.join('\n'))
    assert.match(out[0], /Start-up check FAILED: cannot reach the backend at http:\/\/127\.0\.0\.1:1: curl: \(7\).*\(curl exit 7\)/)
    assert.match(out[1], /Start-up check FAILED: clipboard not readable: xsel is not on the daemon's PATH/)
    assert.match(out[2], /Results in the game: notification ok, overlay off/)
  } finally { sc.cleanup() }
})

test('a throttle setting that is not a positive number stops the daemon with its name', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, `
res = []
for cfg in ({'error_repeat_s': 0}, {'error_repeat_slow_s': -1}, {'error_repeat_slow_after': 'x'},
            {'error_repeat_slow_after': 2.5}, {'error_repeat_s': 900},
            {'error_repeat_s': 900, 'error_repeat_slow_s': 900}, {'error_repeat_slow_after': 4.0},
            {'error_repeat_s': float('nan')}, {'error_repeat_slow_s': float('nan')},
            {'error_repeat_slow_after': float('inf')}, {'error_repeat_s': float('inf')}):
    try:
        make(**cfg); res.append(None)
    except SystemExit as ex:
        res.append(str(ex))
print(json.dumps(res))
`)
    assert.match(out[0], /error_repeat_s must be a positive number/)
    assert.match(out[1], /error_repeat_slow_s must be a positive number/)
    assert.match(out[2], /error_repeat_slow_after must be a positive whole number/)
    assert.match(out[3], /error_repeat_slow_after must be a positive whole number \(got 2\.5\)/,
      '2.5 used to become 2 without a word')
    assert.match(out[4], /error_repeat_slow_s \(600\) must not be shorter than error_repeat_s \(900\)/,
      'the slow stage would write more often than the first one')
    assert.equal(out[5], null, 'equal intervals are allowed')
    assert.equal(out[6], null, 'a whole number written as 4.0 is allowed')
    // TOML has nan and inf. nan passed every comparison (nan <= 0 is false) and
    // switched the throttle off; inf as a whole number ended in a traceback.
    assert.match(out[7], /error_repeat_s must be a positive number \(got nan\)/)
    assert.match(out[8], /error_repeat_slow_s must be a positive number \(got nan\)/)
    assert.match(out[9], /error_repeat_slow_after must be a positive whole number \(got inf\)/)
    assert.match(out[10], /error_repeat_s must be a positive number \(got inf\)/)
  } finally { sc.cleanup() }
})

// --- the way back to the game -------------------------------------------------
// A mock backend in this process; the daemon's real curl children talk to it,
// the notify-send stub records what would pop up. The Python side runs the
// daemon's loop (poll_clipboard + tick) until a condition holds.

const LOOP = `
import time
ITEM = 'Item Class: Belts\\nRarity: Unique\\nMageblood\\nHeavy Belt'
def calls():
    try:
        with open(os.path.join(root, 'notify.calls')) as fh:
            return [json.loads(l) for l in fh.read().splitlines()]
    except FileNotFoundError:
        return []
def run_until(cond, secs=10):
    end = time.monotonic() + secs
    while time.monotonic() < end:
        app.poll_clipboard(); app.tick(time.monotonic())
        if cond(): return True
        time.sleep(0.02)
    return False
def bodies():
    return [c[-1] for c in calls()]
`

/** A backend of either age. old: /daemon/* answer 404/405 like a server from before them. */
// session: the session for POST /daemon/session (answered 200 and put into the
// feed with this instance, like server.mjs does); sessionAfter: feed events
// added after that answer (a later state, the game detection's own).
async function withDaemonBackend ({ old = false, whisper = null, session = null, sessionAfter = [] }, fn) {
  const seen = { items: [], beats: [], polls: [], whispers: [], sessions: [] }
  const events = []
  let seq = 0
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      if (req.method === 'GET' && u.pathname === '/health') { res.writeHead(200).end('ok'); return }
      if (req.method === 'GET' && u.pathname === '/users') { json(200, { users: ['player1'], langs: { player1: 'de' } }); return }
      if (req.method === 'POST' && u.pathname === '/item') {
        const id = `c${seen.items.length + 1}`
        seen.items.push({ headers: req.headers })
        const by = req.headers['x-ppt-instance']
        if (!old && req.headers['x-ppt-daemon']) {
          const base = { kind: 'item', by, id, name: 'Mageblood', base: 'Heavy Belt', rarity: 'unique', stack: null, ahead: null, retryAfterSec: null, ref: null, cd: null }
          events.push({ seq: ++seq, ...base, status: 'queued', ahead: 1, price: null, final: false })
          events.push({ seq: ++seq, ...base, status: 'done', final: true, price: { source: 'trade', currency: 'divine', median: 140, low: 125, high: 170, count: 259, ageHours: null, conflict: false, early: false } })
        }
        json(200, { id, user: 'player1' })
        return
      }
      if (old && u.pathname.startsWith('/daemon/')) {
        if (req.method === 'GET') res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
        else res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed')
        return
      }
      if (!req.headers['x-ppt-daemon']) { json(400, { error: 'missing X-PPT-Daemon header' }); return }
      if (req.method === 'POST' && u.pathname === '/daemon/heartbeat') {
        seen.beats.push({ body: JSON.parse(body), version: req.headers['x-ppt-daemon'] })
        json(200, { ok: true, presence: 'unknown', v: 1 }); return
      }
      if (req.method === 'POST' && u.pathname === '/daemon/whisper') {
        // As server.mjs: the entry is the answer AND a feed event of this instance.
        const by = req.headers['x-ppt-instance']
        const w = JSON.parse(body)
        seen.whispers.push({ raw: body, headers: req.headers })
        const entry = { key: `${by}:${w.wid}`, wid: w.wid, label: w.label, by, ...(whisper || {}) }
        events.push({ seq: ++seq, kind: 'whisper', by, wid: w.wid, entry })
        json(200, { v: 1, entry }); return
      }
      if (req.method === 'POST' && u.pathname === '/daemon/session' && session) {
        const by = req.headers['x-ppt-instance']
        seen.sessions.push({ body: JSON.parse(body), headers: req.headers })
        events.push({ seq: ++seq, kind: 'session', by, session })
        for (const e of sessionAfter) events.push({ seq: ++seq, ...e })
        json(200, { ok: true, v: 1, action: 'start', session }); return
      }
      if (req.method === 'GET' && u.pathname === '/daemon/events') {
        seen.polls.push(u.search)
        const since = u.searchParams.get('since')
        const answer = () => {
          if (since === null || u.searchParams.get('boot') !== 'b1') {
            json(200, { v: 1, boot: 'b1', seq, now: Date.now(), reset: true, gap: false, events: [] }); return
          }
          json(200, { v: 1, boot: 'b1', seq, now: Date.now(), reset: false, gap: false, events: events.filter(e => e.seq > Number(since)) })
        }
        if (since !== null && u.searchParams.get('wait') !== '0' && !events.some(e => e.seq > Number(since))) setTimeout(answer, 150)
        else answer()
        return
      }
      json(404, { error: 'unknown daemon route' })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen)
  } finally {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
}

test('a hotkey card reaches the game through the back channel: queued, then the price', async () => {
  await withDaemonBackend({}, async (url, seen) => {
    const sc = scenario()
    try {
      const out = await wiring(sc, LOOP + `
put('clip', 'before')
app = make(backend_url='${url}')
app.startup_checks()
up = run_until(lambda: app.downlink.state() == 'ok')
put('clip', ITEM)
got = run_until(lambda: any('140 div' in b for b in bodies()))
run_until(lambda: False, 0.3)
print(json.dumps({'up': up, 'got': got, 'calls': calls(), 'lines': lines, 'lang': app.results.lang,
                  'version': ppd.DAEMON_VERSION, 'instance': app.instance, 'features': app.features()}))
app.display.close(); app.pool.close()
`, { DISPLAY: ':7' })
      assert.equal(out.up, true, out.lines.join('\n'))
      assert.equal(out.got, true, JSON.stringify(out.calls))
      assert.match(out.lines.join('\n'), /Start-up check: back channel available \(in-game results on\)/)
      assert.equal(out.lang, 'de', 'the card language follows the server when lang is empty')
      const bodies = out.calls.map(c => c.at(-1))
      assert.ok(bodies.some(b => /^queued · about 1 ahead$/.test(b)), bodies.join(' | '))
      assert.equal(bodies.at(-1), '140 div (125–170)\n259 listings')
      assert.ok(out.calls.at(-1).some(a => a.startsWith('--replace-id=')), 'the price replaces the queued notification')
      assert.equal(seen.items[0].headers['x-ppt-daemon'], out.version, 'poe-price-post.sh sent the daemon version')
      assert.equal(seen.items[0].headers['x-ppt-instance'], out.instance)
      assert.match(out.version, /^\d+\.\d+\.\d+/)
      assert.ok(seen.beats.length >= 1, 'a heartbeat went out')
      assert.equal(seen.beats[0].version, out.version)
      assert.equal(seen.beats[0].body.game, 'unknown')
      assert.deepEqual(Object.keys(seen.beats.at(-1).body.features).sort(), ['downlink', 'game', 'notify', 'overlay', 'whispers'])
      // No xdotool or xprop in this PATH: the overlay could never be used
      // (overlay_only_in_game), so it is not started, and the state says why.
      // No xdotool here either: the game detection cannot tell (the server keeps the normal pace).
      assert.deepEqual(out.features, { downlink: 'ok', notify: 'ok', overlay: 'no-focus-check', whispers: 'off', game: 'no-xdotool' })
      assert.doesNotMatch(out.lines.join('\n'), /Traceback|older than this daemon/)
    } finally { sc.cleanup() }
  })
})

test('a new daemon against an old server keeps pricing and says so once per channel', async () => {
  await withDaemonBackend({ old: true }, async (url, seen) => {
    const sc = scenario()
    try {
      const out = await wiring(sc, LOOP + `
put('clip', 'before')
app = make(backend_url='${url}')
app.startup_checks()
run_until(lambda: app.downlink.state() == 'unsupported' and app.heartbeat.state() == 'unsupported')
put('clip', ITEM)
got = run_until(lambda: any('older than this daemon' in b for b in bodies()))
put('clip', 'some text')
run_until(lambda: False, 0.3)
n_before = len(calls())
put('clip', ITEM)
again = run_until(lambda: len(calls()) > n_before, 3)
print(json.dumps({'got': got, 'again': again, 'calls': calls(), 'lines': lines, 'states': [app.downlink.state(), app.heartbeat.state()]}))
app.display.close(); app.pool.close()
`, { DISPLAY: ':7' })
      assert.equal(out.got, true, JSON.stringify(out.calls) + out.lines.join('\n'))
      const older = out.lines.filter(l => /older than this daemon/.test(l))
      assert.equal(older.length, 2, older.join('\n'))
      assert.ok(older.some(l => l.includes('/daemon/events')) && older.some(l => l.includes('/daemon/heartbeat')))
      assert.deepEqual(out.states, ['unsupported', 'unsupported'])
      assert.equal(seen.items.length, 1, 'the item was posted once; the copy again was a duplicate, no request')
      assert.equal(out.again, true, 'the same item again shows the last card again')
      const last = out.calls.at(-1).at(-1)
      assert.equal(last, 'sent — the price shows in the browser only (the server is older than this daemon)')
      assert.doesNotMatch(out.lines.join('\n'), /Traceback/)
    } finally { sc.cleanup() }
  })
})

test('a POST that cannot be sent is a card in the game too', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, LOOP + `
put('clip', 'before')
app = make(backend_url='http://127.0.0.1:1')
put('clip', ITEM)
run_until(lambda: len(calls()) > 0, 5)
print(json.dumps({'calls': calls()}))
app.display.close(); app.pool.close()
`)
    assert.equal(out.calls.length, 1)
    assert.deepEqual(out.calls[0].slice(-2), ['Mageblood', 'server not reachable — the item was not sent'])
  } finally { sc.cleanup() }
})

test('an old config.toml runs as before; new keys are checked and named', async () => {
  const sc = scenario()
  try {
    rmSync(path.join(sc.bin, 'notify-send'))
    const out = await wiring(sc, `
r = {}
app = make()
r['features'] = app.features()
r['downlink'] = [app.downlink.enabled, app.downlink.hold_s, app.downlink.min_gap_s, app.results.wait_s]
off = make(link={'back_channel': False}, results={'notify': False, 'overlay': 'off', 'lang': 'de', 'result_wait_s': 90})
r['off'] = [off.features(), off.results.lang, off.results.wait_s]
r['card'] = off.results.posted(0, off.downlink.state())['lines'][-1][0]
errs = []
for kw in ({'link': {'hold_s': 60}}, {'link': {'back_channel': 'yes'}}, {'results': {'notify': 1}},
           {'results': {'overlay': 'maybe'}}, {'results': {'lang': 'fr'}}, {'results': {'result_wait_s': 0}},
           {'link': 'x'}, {'results': {'overlay': 'on'}}, {'results': {'overlay_only_in_game': 'yes'}},
           {'results': {'opacity': 1.5}}, {'results': {'hide_distance_px': 0}}, {'results': {'item_hold_s': 2.5}}):
    try:
        make(**kw); errs.append(None)
    except SystemExit as ex:
        errs.append(str(ex))
r['errs'] = errs
r['lines'] = lines
print(json.dumps(r))
`)
    assert.deepEqual(out.features, { downlink: 'starting', notify: 'missing', overlay: 'no-focus-check', whispers: 'off', game: 'starting' })
    assert.deepEqual(out.downlink, [true, 25, 2, 120])
    assert.deepEqual(out.off[0], { downlink: 'off', notify: 'off', overlay: 'off', whispers: 'off', game: 'starting' })
    assert.equal(out.off[1], 'de')
    assert.equal(out.off[2], 90)
    assert.equal(out.card, 'sent — the price shows in the browser only (back channel off in config.toml)')
    assert.match(out.errs[0], /\[link\] hold_s must be at most 50 \(got 60\)/)
    assert.match(out.errs[1], /\[link\] back_channel must be true or false \(got 'yes'\)/)
    assert.match(out.errs[2], /\[results\] notify must be true or false/)
    assert.match(out.errs[3], /\[results\] overlay must be one of "auto", "on", "off" \(got 'maybe'\)/)
    assert.match(out.errs[4], /\[results\] lang must be one of "", "en", "de"/)
    assert.match(out.errs[5], /\[results\] result_wait_s must be a positive number/)
    assert.match(out.errs[6], /\[link\] must be a table/)
    assert.equal(out.errs[7], null)
    assert.match(out.errs[8], /\[results\] overlay_only_in_game must be true or false/)
    assert.match(out.errs[9], /\[results\] opacity must be at most 1 \(got 1\.5\)/)
    assert.match(out.errs[10], /\[results\] hide_distance_px must be a positive whole number/)
    assert.equal(out.errs[11], null, 'a hold time may have a fraction')
    assert.deepEqual(out.lines, [], 'nothing is written before the start-up check')
  } finally { sc.cleanup() }
})

test('a missing notify-send is one line at start, and items still post', async () => {
  const sc = scenario()
  try {
    rmSync(path.join(sc.bin, 'notify-send'))
    const out = await wiring(sc, LOOP + `
put('clip', 'before')
app = make(backend_url='http://127.0.0.1:1/')
app.startup_checks()
for name in ('Mageblood', 'Headhunter', 'Kaom'):
    put('clip', 'Item Class: Belts\\nRarity: Unique\\n' + name)
    run_until(lambda: not app._posts, 5)
print(json.dumps({'lines': lines}))
app.display.close(); app.pool.close()
`)
    const notify = out.lines.filter(l => /notify-send/.test(l))
    assert.equal(notify.length, 1, out.lines.join('\n'))
    assert.match(notify[0], /notify-send is not on the daemon's PATH/)
    assert.ok(out.lines.some(l => /Results in the game: notification missing, overlay no-focus-check/.test(l)))
  } finally { sc.cleanup() }
})

const HAS_QT = spawnSync('python3', ['-c', 'import PySide6'], { encoding: 'utf8' }).status === 0

test('with the game focused, the card goes to the overlay process instead of a notification', { skip: HAS_QT ? false : 'no PySide6 on this machine' }, async () => {
  // The real ppt_overlay.py, on Qt's offscreen platform (PPT_OVERLAY_PLATFORM):
  // no window reaches a display. xdotool and xprop are stubs that report the
  // game window, so the focus check says 'focused'.
  await withDaemonBackend({}, async url => {
    const sc = scenario()
    try {
      writeFileSync(path.join(sc.bin, 'xdotool'), '#!/usr/bin/env bash\necho 42\n', { mode: 0o755 })
      writeFileSync(path.join(sc.bin, 'xprop'), '#!/usr/bin/env bash\necho \'WM_CLASS(STRING) = "steam_app_238960", "steam_app_238960"\'\n', { mode: 0o755 })
      const out = await wiring(sc, LOOP + `
put('clip', 'before')
app = make(backend_url='${url}', poe_window_class='steam_app_238960')
app.startup_checks()
ready = run_until(lambda: app.display.overlay.state() == 'ok' and app.display.focus.state() == 'focused')
put('clip', ITEM)
shown = run_until(lambda: app.display.overlay.last_shown is not None)
run_until(lambda: False, 0.5)
print(json.dumps({'ready': ready, 'shown': app.display.overlay.last_shown, 'calls': calls(), 'lines': lines,
                  'features': app.features()}))
app.display.close(); app.pool.close()
`, { PPT_OVERLAY_PLATFORM: 'offscreen' })
      assert.equal(out.ready, true, out.lines.join('\n'))
      assert.equal(out.shown.type, 'shown')
      assert.match(out.shown.key, /^item:/)
      assert.deepEqual(out.calls, [], 'no notification while the overlay shows the card')
      assert.deepEqual(out.features, { downlink: 'ok', notify: 'ok', overlay: 'ok', whispers: 'off', game: 'no-display' })
      assert.ok(out.lines.some(l => /Overlay ready: PySide6 [\d.]+ on offscreen/.test(l)), out.lines.join('\n'))
      assert.doesNotMatch(out.lines.join('\n'), /Traceback|overlay process ended/)
    } finally { sc.cleanup() }
  })
})

test('overlay = "off" starts no overlay process', async () => {
  const sc = scenario()
  try {
    writeFileSync(path.join(sc.bin, 'xdotool'), '#!/usr/bin/env bash\necho 42\n', { mode: 0o755 })
    writeFileSync(path.join(sc.bin, 'xprop'), '#!/usr/bin/env bash\necho x\n', { mode: 0o755 })
    const out = await wiring(sc, `
app = make(results={'overlay': 'off'})
app.startup_checks()
print(json.dumps({'overlay': app.display.overlay, 'features': app.features(),
                  'line': [l for l in lines if 'Results in the game' in l]}))
app.display.close(); app.pool.close()
`, { PPT_OVERLAY_PLATFORM: 'offscreen' })
    assert.equal(out.overlay, null)
    assert.equal(out.features.overlay, 'off')
    assert.match(out.line[0], /overlay off\./)
  } finally { sc.cleanup() }
})

test('the shipped config.example.toml starts the daemon with the documented defaults', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, `
import tomllib
with open(os.path.join(daemon_dir, 'config.example.toml'), 'rb') as fh:
    cfg = tomllib.load(fh)
app = make(**{k: v for k, v in cfg.items() if k not in ('macros',)})
print(json.dumps({'features': app.features(), 'hold': app.downlink.hold_s, 'gap': app.downlink.min_gap_s,
                  'wait': app.results.wait_s, 'overlay': app.overlay_setting, 'expire': app.display.notifier.expire_ms,
                  'grid': app.grid, 'highlight': app.highlight_code, 'session': [app.session_code, app.session_cards]}))
`)
    assert.deepEqual(out, { features: { downlink: 'starting', notify: 'ok', overlay: 'no-focus-check', whispers: 'off', game: 'starting' }, hold: 25, gap: 2, wait: 120, overlay: 'auto', expire: 8000, grid: { mode: 'auto', folders: 'none', rect: null }, highlight: null, session: [null, true] })
  } finally { sc.cleanup() }
})

// --- buyer whispers ([whispers], ppt_whisper) ----------------------------------

const WHISPER_ENTRY = {
  verdict: 'below', reason: null, kind: 'single', lang: 'en', league: 'Mercenaries', tab: 'Sale', left: 5, top: 3, extraLen: 0,
  item: { text: 'Tabula Rasa, Simple Robe', ref: 'Tabula Rasa', base: 'Simple Robe', kind: 'unique' }, qty: 1,
  asked: { amount: 100, unit: 'chaos', chaos: 100, chaosEach: 100 },
  market: { chaosEach: 154, chaos: 154, source: 'ninja', uncertain: null }, ratio: 0.65, pct: 35
}
const WLINE = name => `2026/11/03 20:11:46 1234 abcd [INFO Client 77] @From ${name}: Hi, I would like to buy your Tabula Rasa, Simple Robe listed for 100 chaos in Mercenaries (stash tab "Sale"; position: left 5, top 3)\r\n`

test('[whispers] is optional, and its keys are checked and named', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, `
r = {}
app = make()
r['off'] = [app.whispers, app.features()['whispers'], app.overlay_style]
r['lines'] = list(lines)
errs = []
for kw in ({'whispers': 'x'}, {'whispers': {'client_log': 5}}, {'whispers': {'client_log': '/x', 'incoming_markers': []}},
           {'whispers': {'client_log': '/x', 'trade_prefixes': ['']}}, {'whispers': {'toast_shows_name': 'no'}},
           {'whispers': {'whisper_anchor': [0.5]}}, {'whispers': {'whisper_anchor': [1.5, 0.2]}},
           {'whispers': {'whisper_hold_s': 0}}, {'whispers': {'max_whispers': 2.5}}, {'whispers': {'keep': 0}},
           {'whispers': {'poll_s': -1}}, {'whispers': {'trade_hints': 'buy your'}},
           {'whispers': {'client_log': '', 'whisper_anchor': [0.9, 0.1], 'max_whispers': 5}}):
    try:
        a = make(**kw); errs.append(a.overlay_style)
    except SystemExit as ex:
        errs.append(str(ex))
r['errs'] = errs
print(json.dumps(r))
`)
    assert.equal(out.off[0], null, 'no client_log: no whisper part at all')
    assert.equal(out.off[1], 'off')
    assert.deepEqual([out.off[2].whisper_anchor, out.off[2].whisper_hold_ms, out.off[2].max_whispers], [[0.02, 0.35], 20000, 3])
    assert.deepEqual(out.lines, [], 'client_log empty: off without a line')
    assert.match(out.errs[0], /\[whispers\] must be a table/)
    assert.match(out.errs[1], /\[whispers\] client_log must be a text/)
    assert.match(out.errs[2], /\[whispers\] incoming_markers must be a list of non-empty texts/)
    assert.match(out.errs[3], /\[whispers\] trade_prefixes must be a list of non-empty texts/)
    assert.match(out.errs[4], /\[whispers\] toast_shows_name must be true or false/)
    assert.match(out.errs[5], /\[whispers\] whisper_anchor must be two numbers from 0 to 1/)
    assert.match(out.errs[6], /\[whispers\] whisper_anchor must be two numbers from 0 to 1/)
    assert.match(out.errs[7], /\[whispers\] whisper_hold_s must be a positive number/)
    assert.match(out.errs[8], /\[whispers\] max_whispers must be a positive whole number/)
    assert.match(out.errs[9], /\[whispers\] keep must be a positive whole number/)
    assert.match(out.errs[10], /\[whispers\] poll_s must be a positive number/)
    assert.match(out.errs[11], /\[whispers\] trade_hints must be a list of texts/)
    assert.deepEqual([out.errs[12].whisper_anchor, out.errs[12].max_whispers], [[0.9, 0.1], 5])
  } finally { sc.cleanup() }
})

test("a buyer's trade whisper reaches the game as a card, without the name leaving this PC", async () => {
  await withDaemonBackend({ whisper: WHISPER_ENTRY }, async (url, seen) => {
    const sc = scenario()
    try {
      const log = path.join(sc.root, 'Client.txt')
      writeFileSync(log, '2026/11/03 20:00:00 1 ab [INFO Client 77] @From Oldname: Hi, I would like to buy your old thing\r\n')
      const out = await wiring(sc, LOOP + `
put('clip', 'before')
app = make(backend_url='${url}', whispers={'client_log': '${log}'})
app.startup_checks()
up = run_until(lambda: app.downlink.state() == 'ok' and app.features()['whispers'] == 'ok')
with open('${log}', 'a', encoding='utf-8') as fh:
    fh.write(${JSON.stringify(WLINE('Zxqvname'))})
    fh.write('2026/11/03 20:11:47 1234 abcd [INFO Client 77] @From Zxqvname: see you later\\r\\n')
got = run_until(lambda: any('below market' in b for b in bodies()))
run_until(lambda: False, 0.5)
beat = run_until(lambda: False, 0.1)
app.whispers.close()
with open(os.path.join(root, 'ppt-whisper-offset.json')) as fh:
    resume = fh.read()
print(json.dumps({'up': up, 'got': got, 'calls': calls(), 'lines': lines, 'features': app.features(),
                  'resume': resume}))
app.display.close(); app.pool.close()
`, { DISPLAY: ':7' })
      assert.equal(out.up, true, out.lines.join('\n'))
      assert.equal(out.got, true, JSON.stringify(out.calls) + out.lines.join('\n'))
      assert.equal(seen.whispers.length, 1, 'only the trade whisper was sent; the old line and "see you later" stayed here')
      const sent = JSON.parse(seen.whispers[0].raw)
      assert.equal(sent.label, 'buyer 1')
      assert.match(sent.body, /^Hi, I would like to buy your Tabula Rasa/)
      assert.doesNotMatch(seen.whispers[0].raw + JSON.stringify(seen.whispers[0].headers), /Zxqvname/)
      const whisperCalls = out.calls.filter(c => c.includes('Whisper from buyer 1'))
      assert.equal(whisperCalls.length, 1, 'the answer and the feed event of the same entry are one notification')
      assert.match(whisperCalls[0].at(-1), /your 100 chaos · market 154 c — 35 % below market/)
      assert.match(whisperCalls[0].at(-1), /tab "Sale" · left 5, top 3/)
      assert.doesNotMatch(JSON.stringify(out.calls) + out.lines.join('\n') + out.resume, /Zxqvname|Oldname/)
      assert.match(out.lines.join('\n'), /Whispers: reading .*Client\.txt from its end/)
      assert.equal(out.features.whispers, 'ok')
      assert.equal(seen.beats.at(-1).body.features.whispers, 'ok', 'the heartbeat reports it')
      assert.match(out.resume, /"offset"/)
    } finally { sc.cleanup() }
  })
})

// One whisper per server template (whisper.mjs). Every language but English
// follows SlimTrade's patterns, not a real log (README, Known issues).
const TEMPLATE_SAMPLES = [
  'Hi, I would like to buy your Tabula Rasa, Simple Robe listed for 12 chaos in Mercenaries (stash tab "Sale"; position: left 5, top 3)',
  'Hi, I would like to buy your Lost in the Pit in Mercenaries (stash tab "S"; position: left 1, top 2)',
  "Hi, I'd like to buy your 10 Orb of Alchemy for my 1 Divine Orb in Mercenaries",
  "Hi, ich möchte 'Tabula Rasa, Einfaches Gewand' zum angebotenen Preis von 1 divine in der 'Mercenaries'-Liga kaufen (Truhenfach \"V\"; Position: 3 von links, 4 von oben)",
  "Hi, ich möchte '10 Alchemie-Sphäre' zum angebotenen Preis von '1 Göttliche Sphäre' in der 'Mercenaries'-Liga kaufen",
  "Bonjour, je souhaiterais t'acheter Tabula Rasa, Robe simple pour 12 chaos dans la ligue Mercenaries (onglet de réserve \"V\" ; 5e en partant de la gauche, 3e en partant du haut)",
  "Bonjour, je voudrais t'acheter 10 Orbe d'alchimie contre 1 Orbe divin dans la ligue Mercenaries",
  'Здравствуйте, хочу купить у вас Табула Раса, Простая роба за 12 chaos в лиге Mercenaries (секция "П"; позиция: 5 столбец, 3 ряд)',
  'Здравствуйте, хочу купить у вас 10 Сфера алхимии за 1 Божественная сфера в лиге Mercenaries',
  'Hola, quisiera comprar tu Tabula Rasa, Túnica simple listado por 12 chaos en Mercenaries (pestaña de alijo "V"; posición: izquierda5, arriba 3)',
  'Hola, me gustaría comprar tu(s) 10 Orbe de alquimia por mi 1 Orbe divino en Mercenaries',
  'Olá, eu gostaria de comprar o seu item Tabula Rasa, Túnica Simples listado por 12 chaos na Mercenaries (aba do baú: "V"; posição: esquerda 5, topo 3)',
  'Olá, eu gostaria de comprar seu(s) 10 Orbe de Alquimia pelo(s) meu(s) 1 Orbe Divino na Mercenaries'
]

test('the whisper defaults let every template language through, and the shipped example says the same', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, LOOP + `
import tomllib
app = make(whispers={'client_log': '~/nowhere/Client.txt'})
d = {'markers': app.whispers.markers, 'prefixes': app.whispers.prefixes, 'hints': app.whispers.hint_words}
with open(os.path.join(daemon_dir, 'config.example.toml'), 'rb') as fh:
    w = tomllib.load(fh)['whispers']
ex = {'markers': w['incoming_markers'], 'prefixes': w['trade_prefixes'], 'hints': w['trade_hints']}
from ppt_whisper import parse_line
ru = parse_line('2026/11/03 20:11:46 1234 abcd [INFO Client 77] @От кого Abc: Здравствуйте', d['markers'])
print(json.dumps({'d': d, 'ex': ex, 'ru': ru}))
app.display.close(); app.pool.close()
`, { HOME: sc.root })
    assert.deepEqual(out.d.markers, ['@From', '@Von', '@De', '@От кого'])
    assert.deepEqual(out.d.hints, ['buy your', 'kaufen', 'acheter', 'купить', 'comprar'])
    assert.deepEqual(out.ex, out.d, 'config.example.toml shows the defaults')
    assert.deepEqual(out.ru, ['Abc', 'Здравствуйте'], 'a marker with a space inside is read whole')
    const ids = new Set()
    for (const body of TEMPLATE_SAMPLES) {
      const p = parseWhisper(body)
      assert.ok(p, body)
      ids.add(p.template)
      assert.ok(out.d.prefixes.some(x => body.startsWith(x)), `no default prefix lets this through: ${body.slice(0, 40)}`)
      assert.ok(out.d.hints.some(h => body.toLowerCase().includes(h)), `no default hint counts this: ${body.slice(0, 40)}`)
    }
    const { WHISPER_TEMPLATES } = await import('./whisper.mjs')
    assert.deepEqual([...ids].sort(), WHISPER_TEMPLATES.map(t => t.id).sort(), 'one sample per server template')
  } finally { sc.cleanup() }
})

test('a client_log that does not exist is one line and a state the browser sees', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, LOOP + `
app = make(whispers={'client_log': '~/nowhere/Client.txt'})
for i in range(20):
    app.tick(time.monotonic())
print(json.dumps({'lines': [l for l in lines if 'Whispers' in l], 'state': app.features()['whispers'],
                  'path': app.whispers.path}))
app.display.close(); app.pool.close()
`, { HOME: sc.root })
    assert.equal(out.state, 'missing')
    assert.equal(out.lines.length, 1, out.lines.join('\n'))
    assert.match(out.lines[0], /nowhere\/Client\.txt does not exist/)
    assert.equal(out.path, path.join(sc.root, 'nowhere/Client.txt'), '~ is expanded')
  } finally { sc.cleanup() }
})

// --- the stash cell frame ([whispers] highlight_key, [stash_grid]) -------------

test('the highlight key and [stash_grid] are optional, and their keys are checked and named', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, `
r = {}
app = make()
r['default'] = [app.highlighter, app.highlight_code, sorted(app.watched_keys())]
on = make(whispers={'highlight_key': 'F10'}, macros={'keys': {'F5': '/hideout'}})
r['on'] = [on.highlight_code == ppd.keycode('F10'), on.highlighter.grid, sorted(on.watched_keys()) == sorted([ppd.keycode('F5'), ppd.keycode('F10')])]
manual = make(whispers={'highlight_key': 'F10'}, stash_grid={'mode': 'manual', 'x': 10, 'y': 120, 'w': 640, 'h': 640})
r['manual'] = manual.highlighter.grid
off = make(whispers={'highlight_key': 'F10'}, stash_grid={'mode': 'off'})
r['off'] = [off.highlighter, off.highlight_code, off.watched_keys() == set()]
errs = []
for kw in ({'whispers': {'highlight_key': 10}}, {'stash_grid': 'x'}, {'stash_grid': {'mode': 'maybe'}},
           {'stash_grid': {'mode': 'manual'}}, {'stash_grid': {'folders': 'left'}},
           {'whispers': {'highlight_key': 'F5'}, 'macros': {'keys': {'F5': '/hideout'}}},
           {'whispers': {'highlight_key': '  '}}):
    try:
        make(**kw); errs.append(None)
    except SystemExit as ex:
        errs.append(str(ex))
r['errs'] = errs
r['lines'] = lines
print(json.dumps(r))
`)
    assert.deepEqual(out.default, [null, null, []], 'no key: nothing is watched, no device is opened for it')
    assert.deepEqual(out.on, [true, { mode: 'auto', folders: 'none', rect: null }, true])
    assert.deepEqual(out.manual, { mode: 'manual', folders: 'none', rect: [10, 120, 640, 640] })
    assert.deepEqual(out.off, [null, null, true], 'mode off: the key is not watched')
    assert.match(out.errs[0], /^\[poe-price-daemon\] \[whispers\] highlight_key must be a text \(got 10\)/)
    assert.match(out.errs[1], /^\[poe-price-daemon\] \[stash_grid\] must be a table/)
    assert.match(out.errs[2], /^\[poe-price-daemon\] \[stash_grid\] mode must be one of "auto", "manual", "off" \(got 'maybe'\)/)
    assert.match(out.errs[3], /^\[poe-price-daemon\] \[stash_grid\] mode = "manual" needs x, y, w and h/)
    assert.match(out.errs[4], /^\[poe-price-daemon\] \[stash_grid\] folders must be one of/)
    assert.match(out.errs[5], /^\[poe-price-daemon\] \[whispers\] highlight_key F5 is also a key in \[macros\.keys\]/)
    assert.equal(out.errs[6], null, 'blank is off')
    assert.deepEqual(out.lines, [], 'nothing is written before the start-up check')
  } finally { sc.cleanup() }
})

test('a press of the highlight key in the game frames the newest whisper, or says why not', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, LOOP + `
class Ev:
    def __init__(self, code, value=1): self.type, self.code, self.value = 1, code, value
r = {}
app = make(whispers={'highlight_key': 'F10'}, stash_grid={'mode': 'manual', 'x': 15, 'y': 125, 'w': 634, 'h': 634},
           results={'overlay': 'off'})
app.startup_checks()
r['start'] = [l for l in lines if 'Stash cell frame' in l]
focused = [False]
app.is_poe_focused = lambda: focused[0]
F10 = ppd.keycode('F10')
app.handle(Ev(F10))
run_until(lambda: False, 0.3)
r['unfocused'] = calls()
focused[0] = True
app.handle(Ev(F10, 0))            # a release does nothing
app.handle(Ev(F10))
run_until(lambda: len(calls()) >= 1, 3)
app.whispers = types.SimpleNamespace(positions=lambda: [{'wid': 'w1', 'label': 'buyer 1', 'tab': 'Sale', 'left': 5, 'top': 3, 'quad': None}],
                                     tick=lambda now: [], state=lambda: 'ok', close=lambda: None)
frames = []
app.highlighter.show_frame = lambda f: frames.append(f) or True
app.handle(Ev(F10))
r['frames'] = frames
r['calls'] = [c[-1] for c in calls()]
print(json.dumps(r))
app.display.close(); app.pool.close()
`)
    assert.equal(out.start.length, 1, out.start.join('\n'))
    assert.match(out.start[0], /Stash cell frame: key F10, grid manual \(x 15, y 125, 634x634 px\)/)
    assert.match(out.start[0], /whispers are off \(\[whispers\] client_log is empty\)/)
    assert.match(out.start[0], /the overlay is off \(\[results\] overlay = "off"\)/)
    assert.deepEqual(out.unfocused, [], 'outside the game the key does nothing, like the macro keys')
    assert.deepEqual(out.calls, ['no whisper with a stash position yet'])
    assert.equal(out.frames.length, 1)
    assert.deepEqual([out.frames[0].x, out.frames[0].y, out.frames[0].w, out.frames[0].h], [226, 231, 53, 53])
  } finally { sc.cleanup() }
})

// --- the session key ([session], ppt_session) -----------------------------------

test('[session] is optional, and its keys are checked and named', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, `
r = {}
app = make()
r['default'] = [app.session_code, app.session_cards, sorted(app.watched_keys())]
on = make(session={'key': 'F11'}, macros={'keys': {'F5': '/hideout'}})
r['on'] = [on.session_code == ppd.keycode('F11'), sorted(on.watched_keys()) == sorted([ppd.keycode('F5'), ppd.keycode('F11')]),
           on.session_cards]
quiet = make(session={'key': '', 'cards': False})
r['quiet'] = [quiet.session_code, quiet.session_cards]
errs = []
for kw in ({'session': 'x'}, {'session': {'key': 11}}, {'session': {'key': 'F5'}, 'macros': {'keys': {'F5': '/hideout'}}},
           {'session': {'key': 'F10'}, 'whispers': {'highlight_key': 'F10'}}, {'session': {'cards': 'yes'}},
           {'session': {'key': '  '}}):
    try:
        make(**kw); errs.append(None)
    except SystemExit as ex:
        errs.append(str(ex))
r['errs'] = errs
r['lines'] = lines
print(json.dumps(r))
`)
    assert.deepEqual(out.default, [null, true, []], 'no key: nothing is watched; cards from the server still show')
    assert.deepEqual(out.on, [true, true, true])
    assert.deepEqual(out.quiet, [null, false])
    assert.match(out.errs[0], /^\[poe-price-daemon\] \[session\] must be a table/)
    assert.match(out.errs[1], /^\[poe-price-daemon\] \[session\] key must be a text \(got 11\)/)
    assert.match(out.errs[2], /^\[poe-price-daemon\] \[session\] key F5 is also a key in \[macros\.keys\]; one key cannot do both/)
    assert.match(out.errs[3], /^\[poe-price-daemon\] \[session\] key F10 is also \[whispers\] highlight_key; one key cannot do both/)
    assert.match(out.errs[4], /^\[poe-price-daemon\] \[session\] cards must be true or false/)
    assert.equal(out.errs[5], null, 'blank is off')
    assert.deepEqual(out.lines, [], 'nothing is written before the start-up check')
  } finally { sc.cleanup() }
})

test('a press of the session key in the game toggles a farm session; the answer, the feed and the game detection become cards', async () => {
  const farm = { id: 's1', kind: 'farm', parent: 'g1', state: 'starting', baseline: null, startedAt: 1793600000000, endedAt: null, about: 6, balance: null }
  const game = { id: 'g2', kind: 'game', parent: null, state: 'starting', baseline: null, startedAt: 1793600001000, endedAt: null, about: 6, balance: null }
  await withDaemonBackend({ session: farm, sessionAfter: [{ kind: 'session', by: null, session: game }] }, async (url, seen) => {
    const sc = scenario()
    try {
      const out = await wiring(sc, LOOP + `
class Ev:
    def __init__(self, code, value=1): self.type, self.code, self.value = 1, code, value
put('clip', 'before')
app = make(backend_url='${url}', session={'key': 'F11'}, results={'overlay': 'off'})
app.startup_checks()
r = {}
r['start'] = [l for l in lines if 'Session key' in l]
up = run_until(lambda: app.downlink.state() == 'ok')
focused = [False]
app.is_poe_focused = lambda: focused[0]
F11 = ppd.keycode('F11')
app.handle(Ev(F11))
run_until(lambda: False, 0.3)
r['unfocused'] = calls()
focused[0] = True
app.handle(Ev(F11))
got = run_until(lambda: any(c[-2] == 'Game session started' for c in calls()))
# A release (0) and the auto-repeat of a held key (2) after the answer came do
# nothing: neither may end the session the press just started.
app.handle(Ev(F11, 0))
app.handle(Ev(F11, 2))
app.handle(Ev(F11, 0))
run_until(lambda: False, 0.5)
r['up'] = up
r['got'] = got
r['toasts'] = [c[-2:] for c in calls()]
r['lang'] = app.session.lang
print(json.dumps(r))
app.display.close(); app.pool.close()
`)
      assert.equal(out.up, true)
      assert.equal(out.start.length, 1, out.start.join('\n'))
      assert.match(out.start[0], /Session key: F11, pressed while the game has focus: starts or ends a farm session; session cards on\./)
      assert.deepEqual(out.unfocused, [], 'outside the game the key does nothing, like the macro keys')
      assert.equal(out.got, true, JSON.stringify(out.toasts))
      assert.deepEqual(out.toasts, [
        ['Farm session started', 'baseline with the next full read (about 6 min)'],
        ['Game session started', '']
      ], 'the answer and its feed event are one card; the game detection\'s event (by null) is shown too')
      assert.equal(seen.sessions.length, 1, 'one press, one request; a release and a repeat send none')
      assert.deepEqual(seen.sessions[0].body, { action: 'toggle' })
      assert.equal(seen.sessions[0].headers['x-user'], 'player1')
      assert.ok(seen.sessions[0].headers['x-ppt-daemon'])
      assert.equal(out.lang, 'de', 'the number format follows the language the server reads the user\'s items in')
    } finally { sc.cleanup() }
  })
})

test('with cards = false only the answer to a press is shown; without [session] the start says nothing of it', async () => {
  const farm = { id: 's1', kind: 'farm', parent: null, state: 'starting', baseline: null, startedAt: 1793600000000, endedAt: null, about: null, balance: null }
  const game = { id: 'g2', kind: 'game', parent: null, state: 'starting', baseline: null, startedAt: 1793600001000, endedAt: null, about: 6, balance: null }
  await withDaemonBackend({ session: farm, sessionAfter: [{ kind: 'session', by: null, session: game }] }, async (url) => {
    const sc = scenario()
    try {
      const out = await wiring(sc, LOOP + `
class Ev:
    def __init__(self, code, value=1): self.type, self.code, self.value = 1, code, value
put('clip', 'before')
off = make(backend_url='${url}', results={'overlay': 'off'})
off.startup_checks()
r = {'off': [l for l in lines if 'Session key' in l]}
off.display.close(); off.pool.close()
del lines[:]
app = make(backend_url='${url}', session={'key': 'F11', 'cards': False}, results={'overlay': 'off'})
app.startup_checks()
r['quiet'] = [l for l in lines if 'Session key' in l]
run_until(lambda: app.downlink.state() == 'ok')
app.is_poe_focused = lambda: True
app.handle(Ev(ppd.keycode('F11')))
run_until(lambda: len(calls()) >= 1)
# Wait until the downlink has fetched and handled the game detection's feed
# event (seq 2, after the press's own at seq 1), so that its missing card is
# the cards switch at work, not a fetch still under way.
r['fed'] = run_until(lambda: (app.downlink.since or 0) >= 2)
run_until(lambda: False, 0.3)
r['toasts'] = [c[-2:] for c in calls()]
print(json.dumps(r))
app.display.close(); app.pool.close()
`)
      assert.deepEqual(out.off, [], 'no [session]: no line, the cards show as on any default')
      assert.match(out.quiet[0], /Session key: F11, pressed while the game has focus: starts or ends a farm session; session cards off \(\[session\] cards = false\): only the answer to a press is shown\./)
      assert.equal(out.fed, true, 'the downlink fetched the game session\'s feed event')
      assert.deepEqual(out.toasts, [['Farm session started', 'baseline with the next full read']])
    } finally { sc.cleanup() }
  })
})

// --- game detection ([presence], ppt_presence) ----------------------------------

test('[presence] is optional, and its keys are checked and named', async () => {
  const sc = scenario()
  try {
    const out = await wiring(sc, `
r = {}
app = make()
r['on'] = [app.features()['game'], app.heartbeat.interval_s, app.heartbeat.idle_interval_s, app.game.check_s]
off = make(presence={'report_game': False})
r['off'] = [off.features()['game'], off.heartbeat.game(), off.game]
off.startup_checks()
errs = []
for kw in ({'presence': {'report_game': 'yes'}}, {'presence': {'heartbeat_s': 5}}, {'presence': {'heartbeat_s': 700}},
           {'presence': {'heartbeat_s': 120, 'idle_heartbeat_s': 60}}, {'presence': {'game_check_s': 0}},
           {'presence': {'game_check_s': 0.5}}, {'presence': 'x'}, {'presence': {'idle_heartbeat_s': 600, 'game_check_s': 30}}):
    try:
        make(**kw); errs.append(None)
    except SystemExit as ex:
        errs.append(str(ex))
r['errs'] = errs
r['lines'] = lines
print(json.dumps(r))
`)
    assert.deepEqual(out.on, ['starting', 60, 300, 10], 'an old config.toml gets game detection with the defaults')
    assert.deepEqual(out.off, ['off', 'unknown', null], 'off: no probe, and every beat says unknown')
    assert.ok(out.lines.some(l => /Game detection: off \(\[presence\] report_game = false\)/.test(l)), out.lines.join('\n'))
    assert.match(out.errs[0], /\[presence\] report_game must be true or false/)
    assert.match(out.errs[1], /\[presence\] heartbeat_s must be from 10 to 600 \(got 5\)/)
    assert.match(out.errs[2], /\[presence\] heartbeat_s must be from 10 to 600 \(got 700\)/)
    assert.match(out.errs[3], /\[presence\] idle_heartbeat_s \(60\) must not be shorter than heartbeat_s \(120\)/)
    assert.match(out.errs[4], /\[presence\] game_check_s must be a positive number/)
    assert.match(out.errs[5], /\[presence\] game_check_s must be from 1 to 600 \(got 0\.5\)/)
    assert.match(out.errs[6], /\[presence\] must be a table/)
    assert.equal(out.errs[7], null)
  } finally { sc.cleanup() }
})

test('a game window found goes to the server as running, with one journal line, and is remembered', async () => {
  await withDaemonBackend({}, async (url, seen) => {
    const sc = scenario()
    try {
      writeFileSync(path.join(sc.bin, 'xdotool'), '#!/usr/bin/env bash\necho "$*" >>"$STUB_ROOT/xdotool.calls"\necho 62914561\n', { mode: 0o755 })
      const out = await wiring(sc, LOOP + `
put('clip', 'before')
app = make(backend_url='${url}', poe_window_class='steam_app_238960')
app.startup_checks()
up = run_until(lambda: app.game.state() == 'running' and app.heartbeat.state() == 'ok')
run_until(lambda: False, 0.5)  # the beat that carries the change goes out and is answered
with open(os.path.join(root, 'poe-price-daemon', 'game-seen.json')) as fh:
    seen_file = json.load(fh)
print(json.dumps({'up': up, 'lines': lines, 'features': app.features(), 'seen': seen_file}))
app.display.close(); app.pool.close()
`, { DISPLAY: ':7' })
      assert.equal(out.up, true, out.lines.join('\n'))
      const game = out.lines.filter(l => /Game detection/.test(l))
      assert.equal(game.length, 1, game.join('\n'))
      assert.match(game[0], /Game detection: window class steam_app_238960: running; heartbeat every 60 s while the game runs or the daemon cannot tell, every 300 s while it is not running\./)
      assert.equal(out.features.game, 'ok')
      assert.ok(seen.beats.some(b => b.body.game === 'running' && b.body.everyS === 60 && b.body.features.game === 'ok'),
        JSON.stringify(seen.beats.map(b => b.body)))
      assert.deepEqual(out.seen, { v: 1, seen: [{ class: 'steam_app_238960', display: ':7' }] })
    } finally { sc.cleanup() }
  })
})

test('a game-seen.json that cannot be written is one journal line, and detection goes on', async () => {
  await withDaemonBackend({}, async (url, seen) => {
    const sc = scenario()
    try {
      writeFileSync(path.join(sc.bin, 'xdotool'), '#!/usr/bin/env bash\necho 62914561\n', { mode: 0o755 })
      const blocker = path.join(sc.root, 'state-is-a-file')
      writeFileSync(blocker, 'not a directory')
      const out = await wiring(sc, LOOP + `
put('clip', 'before')
app = make(backend_url='${url}', poe_window_class='steam_app_238960')
app.startup_checks()
up = run_until(lambda: app.game.state() == 'running' and app.heartbeat.state() == 'ok')
run_until(lambda: False, 0.5)
print(json.dumps({'up': up, 'lines': lines, 'features': app.features()}))
app.display.close(); app.pool.close()
`, { DISPLAY: ':7', XDG_STATE_HOME: blocker })
      assert.equal(out.up, true, out.lines.join('\n'))
      const bad = out.lines.filter(l => /not writable/.test(l))
      assert.equal(bad.length, 1, out.lines.join('\n'))
      assert.match(bad[0], /state-is-a-file\/poe-price-daemon\/game-seen\.json not writable/)
      assert.equal(out.features.game, 'ok', 'the detection itself works for this run')
    } finally { sc.cleanup() }
  })
})
