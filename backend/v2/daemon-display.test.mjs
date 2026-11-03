// daemon/ppt_display.py — shows a result card on the game PC. This part: the
// desktop notification through notify-send, and the Display that chooses
// where a card goes (the overlay process is a separate, optional part).
//
// Why this lives here: `npm test` covers only backend/v2 (same reason as
// daemon-diag.test.mjs). No real notify-send is ever called: the Notifier gets
// a stub script (it records its arguments and prints an id) through an
// injected `which`, so nothing pops up on the machine running the tests.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')

const PRELUDE = `
import json, os, sys, time
sys.path.insert(0, sys.argv[1])
root = sys.argv[2]
from ppt_diag import ThrottledLog
from ppt_display import *
lines = []
log = ThrottledLog(60, emit=lines.append)
def stub(body):
    p = os.path.join(root, 'notify-send')
    with open(p, 'w') as fh:
        fh.write(body)
    os.chmod(p, 0o755)
    return p
CALLS = os.path.join(root, 'calls')
RECORD = '''#!/usr/bin/env python3
import json, os, sys
calls = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'calls')
n = 0
if os.path.exists(calls):
    with open(calls) as fh: n = len(fh.read().splitlines())
with open(calls, 'a') as fh: fh.write(json.dumps(sys.argv[1:]) + '\\\\n')
print(17 + n)
'''
def calls():
    if not os.path.exists(CALLS): return []
    with open(CALLS) as fh: return [json.loads(l) for l in fh.read().splitlines()]
def settle(n, until=5):
    end = time.monotonic() + until
    while time.monotonic() < end:
        n.tick(time.monotonic())
        if not n.running: return
        time.sleep(0.01)
`

function py (code) {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-display-'))
  try {
    const r = spawnSync('python3', ['-c', PRELUDE + code, DAEMON_DIR, root], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    })
    assert.equal(r.status, 0, `python3 failed: ${r.stderr}`)
    return JSON.parse(r.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('the notification replaces itself and stays out of the history', () => {
  const out = py(`
p = stub(RECORD)
n = Notifier(log, time.monotonic, which=lambda prog: p)
n.show('item', 'Mageblood', 'queued')
settle(n)
n.show('item', 'Mageblood', '<b>x</b> & y')
settle(n)
n.show('whisper:a', 'Whisper', 'a'); settle(n)
n.show('whisper:b', 'Whisper', 'b'); settle(n)
n.show('whisper:a', 'Whisper', 'a2'); settle(n)
print(json.dumps({'calls': calls(), 'state': n.state(), 'lines': lines}))
`)
  const [first, second, wa, wb, wa2] = out.calls
  assert.ok(first.includes('--transient') && first.includes('--print-id'), first.join(' '))
  assert.ok(first.includes('--app-name=poe-price-tool'))
  assert.ok(first.includes('--expire-time=8000'))
  assert.ok(!first.some(a => a.startsWith('--replace-id')), 'the first one is new')
  assert.deepEqual(first.slice(-3), ['--', 'Mageblood', 'queued'])
  assert.ok(second.includes('--replace-id=17'), second.join(' '))
  assert.equal(second.at(-1), '&lt;b&gt;x&lt;/b&gt; &amp; y', 'markup in the body never renders')
  assert.ok(!wa.some(a => a.startsWith('--replace-id')), 'a whisper slot has its own notification')
  assert.ok(!wb.some(a => a.startsWith('--replace-id')))
  assert.ok(wa2.includes('--replace-id=19'), 'a show in whisper:a replaces only that one')
  assert.equal(out.state, 'ok')
  assert.deepEqual(out.lines, [])
})

test('while a call of the slot runs, only the newest text waits', () => {
  const out = py(`
p = stub('''#!/usr/bin/env bash
sleep 0.3
printf '%s\\\\n' "$*" >> "$(dirname "$0")/calls.txt"
echo 5
''')
n = Notifier(log, time.monotonic, which=lambda prog: p)
n.show('item', 'A', 'one'); n.show('item', 'A', 'two'); n.show('item', 'A', 'three')
settle(n); settle(n)
with open(os.path.join(root, 'calls.txt')) as fh:
    got = fh.read().splitlines()
print(json.dumps(got))
`)
  assert.equal(out.length, 2)
  assert.match(out[0], /-- A one$/)
  assert.match(out[1], /--replace-id=5 .*-- A three$/)
})

test('a missing, failing or hanging notify-send is a state with one line', () => {
  const out = py(`
r = {}
spawned = []
def spy(*a, **k):
    spawned.append(a)
    raise AssertionError('must not spawn')
n = Notifier(log, time.monotonic, which=lambda prog: None, spawn=spy)
r['missing'] = n.state()
n.check()
for _ in range(3): n.show('item', 'A', 'b')
n.check()
r['spawned'] = len(spawned)
r['missing_lines'] = list(lines)
del lines[:]
p = stub('''#!/usr/bin/env bash
echo "Cannot connect to the session bus" >&2
exit 1
''')
log2 = ThrottledLog(60, emit=lines.append)
n2 = Notifier(log2, time.monotonic, which=lambda prog: p)
n2.show('item', 'A', 'b'); settle(n2)
n2.show('item', 'A', 'b'); settle(n2)
r['failing'] = n2.state()
r['failing_lines'] = list(lines)
del lines[:]
p = stub('''#!/usr/bin/env bash
echo 9
''')
n2.show('item', 'A', 'b'); settle(n2)
r['recovered'] = [n2.state(), list(lines)]
del lines[:]
p = stub('''#!/usr/bin/env bash
exec sleep 30
''')
n3 = Notifier(ThrottledLog(60, emit=lines.append), time.monotonic, which=lambda prog: p, deadline_s=0.3)
t0 = time.monotonic()
n3.show('item', 'A', 'b')
r['returned'] = time.monotonic() - t0
settle(n3)
r['ended_in'] = time.monotonic() - t0
r['timeout'] = [n3.state(), list(lines)]
n3.close()
print(json.dumps(r))
`)
  assert.equal(out.missing, 'missing')
  assert.equal(out.spawned, 0, 'no further attempts')
  assert.equal(out.missing_lines.length, 1, out.missing_lines.join('\n'))
  assert.match(out.missing_lines[0], /notify-send is not on the daemon's PATH.*install libnotify/)
  assert.equal(out.failing, 'failing')
  assert.equal(out.failing_lines.length, 1, 'throttled')
  assert.match(out.failing_lines[0], /notify-send exited 1: Cannot connect to the session bus/)
  assert.equal(out.recovered[0], 'ok')
  assert.match(out.recovered[1][0], /Notifications work again \(2 failed attempt\(s\) before\)/)
  assert.ok(out.returned < 0.2, `show() returns at once (${out.returned})`)
  assert.ok(out.ended_in < 2, `the hanging child is ended (${out.ended_in})`)
  assert.equal(out.timeout[0], 'failing')
  assert.match(out.timeout[1][0], /notify-send did not finish within/)
})

test('the KDE fullscreen mute is read, not guessed', () => {
  const out = py(`
class R:
    def __init__(self, out): self.stdout = out; self.returncode = 0
seen = []
def run(argv, **kw):
    seen.append(argv)
    return R(answer[0])
answer = ['true\\n']
w = lambda prog: '/usr/bin/' + prog
kde = {'XDG_CURRENT_DESKTOP': 'KDE'}
r = [kde_fullscreen_mute(kde, run, w)]
answer[0] = 'false\\n'
r.append(kde_fullscreen_mute(kde, run, w))
r.append(kde_fullscreen_mute({'XDG_CURRENT_DESKTOP': 'GNOME'}, run, w))
r.append(kde_fullscreen_mute(kde, run, lambda prog: None))
def boom(argv, **kw): raise OSError('x')
r.append(kde_fullscreen_mute(kde, boom, w))
print(json.dumps({'r': r, 'argv': seen[0]}))
`)
  assert.deepEqual(out.r, [true, false, null, null, null])
  assert.deepEqual(out.argv.slice(1), ['--file', 'plasmanotifyrc', '--group', 'DoNotDisturb', '--key', 'WhenFullscreen', '--default', 'true'])
})

test('the display sends a card to the notification, the overlay slot stays off until there is one', () => {
  const out = py(`
class N:
    def __init__(self): self.shown = []
    def show(self, slot, s, b): self.shown.append([slot, s, b])
    def state(self): return 'ok'
    def tick(self, now): pass
    def close(self): pass
class O:
    def __init__(self, st, ok): self.st, self.ok, self.cards = st, ok, []
    def state(self): return self.st
    def show(self, card): self.cards.append(card['key']); return self.ok
    def tick(self, now): pass
    def close(self): pass
card = {'key': 'item:a', 'title': 'Mageblood', 'lines': [['Mageblood', 'name'], ['140 div', 'price']], 'final': True}
n = N(); d = Display(log, notifier=n)
d.show_item(card); f1 = d.features()
n2 = N(); o = O('ok', True); d2 = Display(log, notifier=n2, overlay=o); d2.show_item(card)
n3 = N(); o3 = O('ok', False); d3 = Display(log, notifier=n3, overlay=o3); d3.show_item(card)
n4 = N(); o4 = O('no-qt', True); d4 = Display(log, notifier=n4, overlay=o4); d4.show_item(card)
d5 = Display(log); d5.show_item(card); d5.tick(0); d5.close()
print(json.dumps({'n': n.shown, 'f1': f1, 'n2': n2.shown, 'o2': o.cards, 'n3': n3.shown, 'n4': n4.shown, 'o4': o4.cards,
                  'f4': d4.features(), 'f5': d5.features()}))
`)
  assert.deepEqual(out.n, [['item', 'Mageblood', '140 div']])
  assert.deepEqual(out.f1, { notify: 'ok', overlay: 'off' })
  assert.deepEqual(out.n2, [], 'a working overlay takes the card')
  assert.deepEqual(out.o2, ['item:a'])
  assert.equal(out.n3.length, 1, 'an overlay that could not show it falls back to the notification')
  assert.equal(out.n4.length, 1)
  assert.deepEqual(out.o4, [], 'an overlay that is not ok is not asked')
  assert.deepEqual(out.f4, { notify: 'ok', overlay: 'no-qt' })
  assert.deepEqual(out.f5, { notify: 'off', overlay: 'off' })
})

// --- the overlay process (OverlayLink) and the focus check (FocusProbe) -------
// The overlay child here is a small fake script, never ppt_overlay.py: it
// says hello (or not), exits with a given code, or stops reading stdin. The
// link's clock is a number the test moves; the child is a real process.

const FAKE_OVERLAY = `
import json, os, sys, time
mode = os.environ.get('FAKE_MODE', 'ok')
root = os.environ['FAKE_ROOT']
def out(o):
    sys.stdout.write(json.dumps(o) + '\\n'); sys.stdout.flush()
if mode == 'exit3':
    print('ppt_overlay: PySide6 cannot be imported (ImportError: no module)', file=sys.stderr); sys.exit(3)
if mode == 'exit4':
    print('ppt_overlay: DISPLAY is not set', file=sys.stderr); sys.exit(4)
if mode == 'abort':
    os.abort()
if mode == 'silent':
    time.sleep(60); sys.exit(0)
plat = 'wayland' if mode == 'wayland' else os.environ.get('PPT_OVERLAY_PLATFORM')
out({'type': 'hello', 'binding': 'PySide6', 'qt': '6.12.0', 'platform': plat, 'screens': 1})
if mode == 'deaf':
    time.sleep(60); sys.exit(0)
got = os.path.join(root, 'got-%d' % os.getpid())
for line in sys.stdin:
    with open(got, 'a') as fh: fh.write(line)
    msg = json.loads(line)
    if msg.get('cmd') == 'ping': out({'type': 'pong', 'n': msg.get('n')})
    if msg.get('cmd') == 'item': out({'type': 'shown', 'key': msg.get('key'), 'x': 1, 'y': 2})
    if msg.get('cmd') == 'quit': sys.exit(0)
`

const LINK_PRELUDE = `
import glob, subprocess
fake = os.path.join(root, 'fake_overlay.py')
with open(fake, 'w') as fh: fh.write(FAKE)
T = [0.0]
clock = lambda: T[0]
spawned = []
def spawn(argv, **kw):
    spawned.append(kw.get('env'))
    return subprocess.Popen(argv, **kw)
def link(mode, env=None, **kw):
    e = dict(env if env is not None else {'DISPLAY': ':99'})
    e.update({'FAKE_MODE': mode, 'FAKE_ROOT': root, 'PATH': os.environ.get('PATH', '')})
    return OverlayLink(log, clock, argv=[sys.executable, fake], env=e, spawn=spawn, **kw)
def wait_state(l, states, until=5):
    end = time.monotonic() + until
    while time.monotonic() < end:
        l.tick(T[0])
        if l.state() in states: return l.state()
        time.sleep(0.01)
    return l.state()
def got():
    out = {}
    for p in sorted(glob.glob(os.path.join(root, 'got-*')), key=os.path.getmtime):
        with open(p) as fh: out[os.path.basename(p)] = [json.loads(x) for x in fh.read().splitlines()]
    return out
CARD = {'key': 'item:a', 'title': 'Mageblood', 'lines': [['Mageblood', 'name'], ['140 div', 'price']], 'final': True}
class N:
    def __init__(self): self.shown = []
    def show(self, slot, s, b): self.shown.append([slot, s, b])
    def state(self): return 'ok'
    def tick(self, now): pass
    def close(self): pass
`

function pyLink (code) {
  return py(`FAKE = ${JSON.stringify(FAKE_OVERLAY)}\n${LINK_PRELUDE}\n${code}`)
}

test('the overlay link starts the child on the platform it names, sends the style after every hello, and shows cards', () => {
  const out = pyLink(`
r = {}
l = link('ok', env={'DISPLAY': ':99', 'QT_QPA_PLATFORM': 'wayland'}, style={'font_pt': 12})
r['before'] = l.state()
l.start(0)
r['starting'] = l.state()
r['send_starting'] = l.send({'cmd': 'ping', 'n': 1})
r['ok'] = wait_state(l, ('ok',))
r['child_env'] = {k: spawned[0].get(k) for k in ('QT_QPA_PLATFORM', 'PPT_OVERLAY_PLATFORM')}
r['show'] = l.show(CARD)
l.style({'font_pt': 14})
time.sleep(0.3); l.tick(T[0])
# The child dies: a restart after 5 s, and the remembered style again.
l._proc.kill()
r['restarting'] = wait_state(l, ('restarting',))
T[0] = 4.9; l.tick(T[0]); r['spawned_early'] = len(spawned)
T[0] = 5.2; l.tick(T[0])
r['again'] = wait_state(l, ('ok',))
time.sleep(0.3); l.tick(T[0])
r['got'] = got()
r['lines'] = list(lines)
l.close()
r['closed'] = l.state()
print(json.dumps(r))
`)
  assert.equal(out.before, 'off')
  assert.equal(out.starting, 'starting')
  assert.equal(out.send_starting, false, 'nothing goes to a child that has not said hello')
  assert.equal(out.ok, 'ok')
  assert.deepEqual(out.child_env, { QT_QPA_PLATFORM: 'xcb', PPT_OVERLAY_PLATFORM: 'xcb' }, "the session's wayland is overwritten")
  assert.equal(out.show, true)
  assert.equal(out.restarting, 'restarting')
  assert.equal(out.spawned_early, 1, 'no restart before 5 s')
  assert.equal(out.again, 'ok')
  const runs = Object.values(out.got)
  assert.equal(runs.length, 2)
  assert.deepEqual(runs[0][0], { cmd: 'style', font_pt: 12 }, 'the style goes out right after the hello')
  assert.equal(runs[0][1].cmd, 'item')
  assert.equal(runs[0][1].key, 'item:a')
  assert.deepEqual(runs[0][1].lines, [['Mageblood', 'name'], ['140 div', 'price']])
  assert.deepEqual(runs[0][2], { cmd: 'style', font_pt: 14 })
  assert.deepEqual(runs[1][0], { cmd: 'style', font_pt: 14 }, 'a restarted overlay gets the remembered style')
  assert.equal(out.lines.filter(l => /overlay process ended/.test(l)).length, 1, out.lines.join('\n'))
  assert.ok(out.lines.some(l => /The overlay works again/.test(l)), out.lines.join('\n'))
  assert.equal(out.closed, 'off')
})

test('an overlay that never says hello is restarted, and the card goes to the notification', () => {
  const out = pyLink(`
r = {}
l = link('silent')
n = N()
d = Display(log, notifier=n, overlay=l)
l.start(0)
time.sleep(0.2)
T[0] = 4.9; l.tick(T[0]); r['early'] = l.state()
T[0] = 5.1; l.tick(T[0]); r['late'] = l.state()
d.show_item(CARD)
r['shown'] = n.shown
r['lines'] = list(lines)
r['features'] = d.features()
l.close()
print(json.dumps(r))
`)
  assert.equal(out.early, 'starting')
  assert.equal(out.late, 'restarting')
  assert.equal(out.lines.length, 1, out.lines.join('\n'))
  assert.match(out.lines[0], /did not report within 5 s; it is started again in 5 s/)
  assert.equal(out.shown.length, 1, 'the notification carries the card')
  assert.equal(out.features.overlay, 'restarting')
})

test('no PySide6, no display, an abort and the wrong platform are states, not restart loops', () => {
  const out = pyLink(`
r = {}
l = link('exit3', required=True)
l.start(0)
r['noqt'] = wait_state(l, ('no-qt',))
T[0] = 100; l.show(CARD); l.tick(T[0])
T[0] = 700; l.show(CARD); l.tick(T[0])
r['noqt_spawned'] = len(spawned)
r['noqt_lines'] = list(lines); del lines[:]
del spawned[:]
T[0] = 0
l4 = link('exit4')
l4.start(0)
r['nodisp'] = wait_state(l4, ('no-display',))
T[0] = 10; r['show10'] = l4.show(CARD); l4.tick(T[0])
T[0] = 599; l4.show(CARD); l4.tick(T[0])
r['nodisp_spawned_early'] = len(spawned)
T[0] = 601; r['show601'] = l4.show(CARD); l4.show(CARD)
r['nodisp_spawned_late'] = len(spawned)
r['nodisp_lines'] = list(lines); del lines[:]
wait_state(l4, ('no-display',))
del spawned[:]
T[0] = 0
l0 = link('ok', env={})
l0.start(0)
r['nodisplay_env'] = [l0.state(), len(spawned)]
del lines[:]
la = link('abort')
la.start(0)
r['abort'] = wait_state(la, ('no-display',))
del lines[:]
lw = link('wayland')
n = N()
d = Display(log, notifier=n, overlay=lw)
lw.start(0)
r['wayland'] = wait_state(lw, ('wrong-platform',))
d.show_item(CARD)
r['wayland_shown'] = len(n.shown)
r['wayland_lines'] = list(lines)
for x in (l, l4, l0, la, lw): x.close()
print(json.dumps(r))
`)
  assert.equal(out.noqt, 'no-qt')
  assert.equal(out.noqt_spawned, 1, 'no second spawn: it would fail the same way')
  assert.equal(out.noqt_lines.length, 1)
  assert.match(out.noqt_lines[0], /needs PySide6.*ImportError/)
  assert.equal(out.nodisp, 'no-display')
  assert.equal(out.show10, false)
  assert.equal(out.nodisp_spawned_early, 1, 'no spawn for items within 600 s')
  assert.equal(out.show601, false, 'the card of the re-check goes to the notification')
  assert.equal(out.nodisp_spawned_late, 2, 'one spawn at the first item after 600 s')
  assert.equal(out.nodisp_lines.length, 1)
  assert.match(out.nodisp_lines[0], /import-environment DISPLAY XAUTHORITY/)
  assert.deepEqual(out.nodisplay_env, ['no-display', 0], 'no DISPLAY: no start at all')
  assert.equal(out.abort, 'no-display', "Qt's abort while opening its platform")
  assert.equal(out.wayland, 'wrong-platform')
  assert.equal(out.wayland_shown, 1, 'the notification is used')
  assert.match(out.wayland_lines.join('\n'), /Qt platform "wayland" instead of xcb/)
})

test('an overlay that stops reading costs no time, drops cards and is restarted', () => {
  const out = pyLink(`
r = {}
l = link('deaf')
l.start(0)
r['ok'] = wait_state(l, ('ok',))
t0 = time.monotonic()
results = [l.send({'cmd': 'item', 'key': 'item:x', 'title': 'x' * 4096, 'lines': [], 'final': True}) for _ in range(2000)]
r['took'] = time.monotonic() - t0
r['dropped'] = l.dropped
r['false'] = results.count(False)
T[0] = 4.9; l.tick(T[0]); r['before'] = l.state()
T[0] = 5.1; l.tick(T[0]); r['hung'] = l.state()
r['lines'] = [x for x in lines if 'Overlay ready' not in x]
r['ready'] = [x for x in lines if 'Overlay ready' in x]
T[0] = 10.2; l.tick(T[0])
r['spawned'] = len(spawned)
l.close()
print(json.dumps(r))
`)
  assert.equal(out.ok, 'ok')
  assert.ok(out.took < 1, `2000 sends took ${out.took} s`)
  assert.ok(out.dropped > 0)
  assert.equal(out.false, out.dropped, 'a dropped card is answered False, so the notification takes it')
  assert.equal(out.before, 'ok')
  assert.equal(out.hung, 'restarting')
  assert.equal(out.lines.length, 1, out.lines.join('\n'))
  assert.match(out.lines[0], /stopped answering; it is started again in 5 s/)
  assert.match(out.ready[0], /Overlay ready: PySide6 6\.12\.0 on xcb, 1 screen\(s\)\./, 'the first hello is one line')
  assert.equal(out.spawned, 2, 'one restart after 5 s')
})

test('after the last restart step the overlay stays off until the daemon restarts', () => {
  const out = pyLink(`
r = []
l = link('silent', restart_steps=(5, 30))
l.start(0)
for t in (5.1, 10.2, 15.3, 45.4, 50.5):
    T[0] = t; l.tick(T[0]); r.append(l.state())
T[0] = 1000; l.tick(T[0]); r.append(l.state()); r.append(len(spawned))
r.append([x for x in lines if 'stays off' in x])
l.close()
print(json.dumps(r))
`)
  assert.deepEqual(out.slice(0, 7), ['restarting', 'starting', 'restarting', 'starting', 'failed', 'failed', 3])
  assert.equal(out[7].length, 1)
  assert.match(out[7][0], /failed 3 times and stays off until the daemon restarts/)
})

test('the overlay is used only while the game has focus', () => {
  const out = py(`
class N:
    def __init__(self): self.shown = []
    def show(self, slot, s, b): self.shown.append(s)
    def state(self): return 'ok'
    def tick(self, now): pass
    def close(self): pass
class O:
    def __init__(self): self.cards = []
    def state(self): return 'ok'
    def show(self, card): self.cards.append(card['key']); return True
    def tick(self, now): pass
    def close(self): pass
class F:
    def __init__(self, st): self.st = st; self.ticks = 0
    def state(self): return self.st
    def tick(self, now): self.ticks += 1
card = {'key': 'item:a', 'title': 'Mageblood', 'lines': [['Mageblood', 'name']], 'final': True}
r = {}
for st in ('not-focused', 'focused', 'unknown', 'no-focus-check'):
    n, o = N(), O()
    d = Display(log, notifier=n, overlay=o, focus=F(st), only_in_game=True)
    d.show_item(card); d.show_item(card)
    r[st] = {'n': len(n.shown), 'o': len(o.cards), 'f': d.features()}
r['no_focus_lines'] = [l for l in lines if 'overlay' in l.lower()]
for st in ('not-focused', 'no-focus-check'):
    n, o = N(), O()
    d = Display(log, notifier=n, overlay=o, focus=F(st), only_in_game=False)
    d.show_item(card)
    r['always_' + st] = {'n': len(n.shown), 'o': len(o.cards), 'f': d.features()}
f = F('focused')
d = Display(log, notifier=N(), overlay=O(), focus=f, only_in_game=True); d.tick(0)
f2 = F('focused')
d2 = Display(log, notifier=N(), overlay=None, focus=f2, only_in_game=True); d2.tick(0)
r['ticks'] = [f.ticks, f2.ticks]
print(json.dumps(r))
`)
  assert.deepEqual([out['not-focused'].n, out['not-focused'].o], [2, 0], 'not focused: the notification')
  assert.deepEqual([out.focused.n, out.focused.o], [0, 2], 'focused: the overlay')
  assert.deepEqual([out.unknown.n, out.unknown.o], [2, 0], 'no answer yet: the notification')
  assert.deepEqual([out['no-focus-check'].n, out['no-focus-check'].o], [2, 0])
  assert.equal(out['no-focus-check'].f.overlay, 'no-focus-check')
  assert.equal(out.focused.f.overlay, 'ok')
  assert.equal(out.no_focus_lines.length, 1, out.no_focus_lines.join('\n'))
  assert.match(out.no_focus_lines[0], /xdotool and xprop.*overlay_only_in_game = false/)
  assert.deepEqual([out['always_not-focused'].n, out['always_not-focused'].o], [0, 1])
  assert.deepEqual([out['always_no-focus-check'].n, out['always_no-focus-check'].o], [0, 1])
  assert.equal(out['always_no-focus-check'].f.overlay, 'ok')
  assert.deepEqual(out.ticks, [1, 0], 'no overlay: no focus check is run')
})

test('the stash cell frame goes to the overlay only while the game has focus, and leaves with it', () => {
  const out = py(`
class O:
    def __init__(self, ok=True): self.sent, self.ok = [], ok
    def state(self): return 'ok'
    def show_frame(self, frame): self.sent.append(['frame', frame['key'], frame['x']]); return self.ok
    def hide(self, key): self.sent.append(['hide', key]); return True
    def tick(self, now): pass
    def close(self): pass
class F:
    def __init__(self, st): self.st = st
    def state(self): return self.st
    def tick(self, now): pass
FRAME = {'key': 'frame', 'x': 226, 'y': 231, 'w': 53, 'h': 53, 'label': 'x', 'hold_ms': 20000}
r = {}
f, o = F('focused'), O()
d = Display(log, notifier=None, overlay=o, focus=f, only_in_game=True)
r['shown'] = d.show_frame(FRAME)
d.tick(0)
f.st = 'not-focused'
d.tick(1); d.tick(2)
r['sent'] = o.sent
o2 = O()
r['unfocused'] = Display(log, overlay=o2, focus=F('not-focused'), only_in_game=True).show_frame(FRAME)
r['no_overlay'] = Display(log, overlay=None, focus=F('focused')).show_frame(FRAME)
r['refused'] = Display(log, overlay=O(ok=False), focus=F('focused')).show_frame(FRAME)
r['sent2'] = o2.sent
print(json.dumps(r))
`)
  assert.equal(out.shown, true)
  assert.deepEqual(out.sent, [['frame', 'frame', 226], ['hide', 'frame']], 'hidden once when the game loses focus')
  assert.equal(out.unfocused, false, 'not over another window')
  assert.deepEqual(out.sent2, [])
  assert.equal(out.no_overlay, false)
  assert.equal(out.refused, false)
})

test('a frame press leaves a missing display to the card that follows it', () => {
  // The overlay found no display (started before the desktop session was
  // up). The frame is not sent; the press then shows a card (ppt_stash_grid),
  // and that card re-checks the display once it is due, as any card does.
  const out = pyLink(`
r = {}
l = link('exit4')
d = Display(log, overlay=l)
l.start(0)
r['state'] = wait_state(l, ('no-display',))
FRAME = {'key': 'frame', 'x': 1, 'y': 2, 'w': 3, 'h': 4, 'label': 'L', 'hold_ms': 5}
T[0] = 601; r['frame'] = d.show_frame(FRAME)
r['spawned_frame'] = len(spawned)
d.show_item(CARD)
r['spawned_card'] = len(spawned)
wait_state(l, ('no-display',))
l.close()
print(json.dumps(r))
`)
  assert.equal(out.state, 'no-display')
  assert.equal(out.frame, false, 'not drawn')
  assert.equal(out.spawned_frame, 1, 'the frame itself starts nothing')
  assert.equal(out.spawned_card, 2, 'the card after it re-checks the display')
})

test('the overlay link sends a frame as a frame command', () => {
  const out = pyLink(`
l = link('ok')
l.start(0)
wait_state(l, ('ok',))
r = {'sent': l.show_frame({'key': 'frame', 'x': 1, 'y': 2, 'w': 3, 'h': 4, 'label': 'L', 'hold_ms': 5})}
time.sleep(0.3); l.tick(T[0])
r['got'] = got()
l.close()
r['closed'] = l.show_frame({'key': 'frame', 'x': 1, 'y': 2, 'w': 3, 'h': 4})
print(json.dumps(r))
`)
  assert.equal(out.sent, true)
  const run = Object.values(out.got)[0]
  assert.deepEqual(run.at(-1), { cmd: 'frame', key: 'frame', x: 1, y: 2, w: 3, h: 4, label: 'L', hold_ms: 5 })
  assert.equal(out.closed, false)
})

test('the focus check never blocks and asks xprop only for a new window', () => {
  const out = py(`
from ppt_link import CurlPool
def tool(name, body):
    p = os.path.join(root, name)
    with open(p, 'w') as fh: fh.write(body)
    os.chmod(p, 0o755)
    return p
r = {}
tool('xdotool', '#!/usr/bin/env bash\\nexec sleep 30\\n')
tool('xprop', '#!/usr/bin/env bash\\necho "$*" >> "$(dirname "$0")/xprop-calls"\\necho "WM_CLASS(STRING) = \\\\"$FAKE_CLASS\\\\", \\\\"$FAKE_CLASS\\\\""\\n')
which = lambda prog: os.path.join(root, prog) if os.path.exists(os.path.join(root, prog)) else None
pool = CurlPool()
fp = FocusProbe('steam_app_238960', pool, time.monotonic, which=which)
t0 = time.monotonic()
for _ in range(5):
    fp.tick(time.monotonic()); fp.state()
r['took'] = time.monotonic() - t0
r['slow'] = fp.state()
pool.close()
tool('xdotool', '#!/usr/bin/env bash\\necho 4242\\n')
os.environ['FAKE_CLASS'] = 'steam_app_238960'
pool = CurlPool()
fp = FocusProbe('Steam_App_238960', pool, time.monotonic, every_s=0.01, which=which)
def settle(want, until=5):
    end = time.monotonic() + until
    while time.monotonic() < end:
        fp.tick(time.monotonic())
        if fp.state() == want: return want
        time.sleep(0.01)
    return fp.state()
r['focused'] = settle('focused')
for _ in range(20):
    fp.tick(time.monotonic()); time.sleep(0.01)
with open(os.path.join(root, 'xprop-calls')) as fh:
    r['xprop_calls'] = len(fh.read().splitlines())
tool('xdotool', '#!/usr/bin/env bash\\necho 77\\n')
os.environ['FAKE_CLASS'] = 'firefox'
r['other'] = settle('not-focused')
tool('xdotool', '#!/usr/bin/env bash\\nexit 1\\n')
os.environ['FAKE_CLASS'] = 'steam_app_238960'
tool('xdotool', '#!/usr/bin/env bash\\necho 4242\\n')
r['back'] = settle('focused')
tool('xdotool', '#!/usr/bin/env bash\\nexit 1\\n')
r['none'] = settle('not-focused')
pool.close()
nofp = FocusProbe('x', CurlPool(), time.monotonic, which=lambda prog: None if prog == 'xdotool' else '/usr/bin/' + prog)
nofp.tick(0)
r['missing'] = nofp.state()
print(json.dumps(r))
`)
  assert.ok(out.took < 0.05, `tick() and state() return at once (${out.took} s)`)
  assert.equal(out.slow, 'unknown', 'no answer yet')
  assert.equal(out.focused, 'focused', 'the class is compared without case')
  assert.equal(out.xprop_calls, 1, 'the same window is not asked again')
  assert.equal(out.other, 'not-focused')
  assert.equal(out.back, 'focused')
  assert.equal(out.none, 'not-focused', 'no focused window')
  assert.equal(out.missing, 'no-focus-check')
})

test('a failed xprop is not kept: the next check asks again', () => {
  // A window can vanish between xdotool and xprop (BadWindow), or X answers
  // with a short error. Kept as "not the game", the game window would count
  // as unfocused for as long as it keeps the focus.
  const out = py(`
from ppt_link import CurlPool
def tool(name, body):
    p = os.path.join(root, name)
    with open(p, 'w') as fh: fh.write(body)
    os.chmod(p, 0o755)
    return p
tool('xdotool', '#!/usr/bin/env bash\\necho 4242\\n')
tool('xprop', '#!/usr/bin/env bash\\nc="$(dirname "$0")/xprop-calls"\\necho x >> "$c"\\nif [ "$(wc -l < "$c")" -eq 1 ]; then echo "X Error: BadWindow" >&2; exit 1; fi\\necho "WM_CLASS(STRING) = \\\\"steam_app_238960\\\\", \\\\"steam_app_238960\\\\""\\n')
which = lambda prog: os.path.join(root, prog)
pool = CurlPool()
fp = FocusProbe('steam_app_238960', pool, time.monotonic, every_s=0.01, which=which)
seen = []
end = time.monotonic() + 5
while time.monotonic() < end:
    fp.tick(time.monotonic())
    if not seen or seen[-1] != fp.state(): seen.append(fp.state())
    if fp.state() == 'focused': break
    time.sleep(0.01)
pool.close()
with open(os.path.join(root, 'xprop-calls')) as fh:
    n = len(fh.read().splitlines())
print(json.dumps({'seen': seen, 'xprop_calls': n}))
`)
  assert.equal(out.seen.at(-1), 'focused', `states: ${out.seen.join(' -> ')}`)
  assert.ok(!out.seen.includes('not-focused'), 'a failed xprop is "unknown", not "not the game"')
  assert.equal(out.xprop_calls, 2, 'asked once more after the failure')
})

test('the overlay card goes when the game loses focus or a later card goes to the notification', () => {
  const out = py(`
class N:
    def __init__(self): self.shown = []
    def show(self, slot, s, b): self.shown.append(s)
    def state(self): return 'ok'
    def tick(self, now): pass
    def close(self): pass
class O:
    def __init__(self): self.cards, self.hidden, self.st = [], [], 'ok'
    def state(self): return self.st
    def show(self, card): self.cards.append(card['key']); return True
    def hide(self, key): self.hidden.append(key); return True
    def tick(self, now): pass
    def close(self): pass
class F:
    def __init__(self, st): self.st = st
    def state(self): return self.st
    def tick(self, now): pass
def card(key, final): return {'key': key, 'title': key, 'lines': [[key, 'name']], 'final': final}
r = {}
# A waiting card in the game, then Alt-Tab: it goes at once, and only once.
n, o, f = N(), O(), F('focused')
d = Display(log, notifier=n, overlay=o, focus=f, only_in_game=True)
d.show_item(card('item:a', False)); d.tick(0)
r['in_game'] = list(o.hidden)
f.st = 'not-focused'; d.tick(1); d.tick(2)
r['alt_tab'] = list(o.hidden)
# Its result comes while another window has focus: the notification only.
d.show_item(card('item:a', True))
r['result'] = {'o': list(o.cards), 'n': len(n.shown), 'hidden': list(o.hidden)}
# Focus unknown for a moment (a timed-out check): the card stays, the next
# card goes to the notification and takes the overlay's card with it.
n, o, f = N(), O(), F('focused')
d = Display(log, notifier=n, overlay=o, focus=f, only_in_game=True)
d.show_item(card('item:a', False))
f.st = 'unknown'; d.tick(0)
r['unknown_tick'] = list(o.hidden)
d.show_item(card('item:b', True))
r['next_card'] = {'hidden': list(o.hidden), 'n': len(n.shown)}
# An overlay that is no longer 'ok' gets no hide (its child was stopped).
n, o, f = N(), O(), F('focused')
d = Display(log, notifier=n, overlay=o, focus=f, only_in_game=True)
d.show_item(card('item:a', False))
o.st = 'restarting'; f.st = 'not-focused'
d.show_item(card('item:b', True)); d.tick(0)
r['not_ok'] = list(o.hidden)
# Without the focus rule nothing is hidden on a focus change.
n, o, f = N(), O(), F('focused')
d = Display(log, notifier=n, overlay=o, focus=f, only_in_game=False)
d.show_item(card('item:a', False)); f.st = 'not-focused'; d.tick(0)
r['always'] = list(o.hidden)
print(json.dumps(r))
`)
  assert.deepEqual(out.in_game, [], 'nothing hidden while the game has focus')
  assert.deepEqual(out.alt_tab, ['item:a'], 'the game lost focus: hidden once')
  assert.deepEqual(out.result, { o: ['item:a'], n: 1, hidden: ['item:a'] })
  assert.deepEqual(out.unknown_tick, [], '"unknown" alone does not hide the card')
  assert.deepEqual(out.next_card, { hidden: ['item:a'], n: 1 })
  assert.deepEqual(out.not_ok, [])
  assert.deepEqual(out.always, [])
})

test('the overlay link sends hide as one command line', () => {
  const out = pyLink(`
l = link('ok')
l.start(0)
r = {'ok': wait_state(l, ('ok',))}
r['hide_ok'] = l.hide('item:a')
time.sleep(0.3); l.tick(T[0])
r['got'] = [m for msgs in got().values() for m in msgs if m.get('cmd') == 'hide']
l.close()
r['hide_closed'] = l.hide('item:a')
print(json.dumps(r))
`)
  assert.equal(out.ok, 'ok')
  assert.equal(out.hide_ok, true)
  assert.deepEqual(out.got, [{ cmd: 'hide', key: 'item:a' }])
  assert.equal(out.hide_closed, false)
})

test('missing focus tools are a failure with overlay = "on" and an info line with "auto"', () => {
  const out = py(`
class O:
    def __init__(self, required): self.required = required; self.started = 0
    def state(self): return 'off'
    def start(self, now): self.started += 1
    def tick(self, now): pass
    def close(self): pass
class F:
    def state(self): return 'no-focus-check'
    def tick(self, now): pass
r = {}
for mode, required in (('on', True), ('auto', False)):
    lines.clear()
    o = O(required)
    d = Display(log, overlay=o, focus=F(), only_in_game=True)
    d.start(0); d.check()
    r[mode] = {'lines': list(lines), 'open': log.recovered('overlay'), 'started': o.started}
print(json.dumps(r))
`)
  for (const mode of ['on', 'auto']) {
    assert.equal(out[mode].lines.length, 1, out[mode].lines.join('\n'))
    assert.match(out[mode].lines[0], /xdotool and xprop.*selftest\.sh --overlay also checks PySide6/)
    assert.equal(out[mode].started, 0, 'the overlay is not started when it could never be used')
  }
  assert.equal(out.on.open, 1, '"on": a failure')
  assert.equal(out.auto.open, 0, '"auto": an info line, like a missing PySide6')
})

test('a run of RESTART_RESET_S without a fault starts the restart steps from the beginning', () => {
  const out = pyLink(`
import ppt_display
r = {'reset_s': ppt_display.RESTART_RESET_S}
def answer_pings(l):
    end = time.monotonic() + 5
    while time.monotonic() < end and l._ping_wait is not None:
        l.tick(T[0]); time.sleep(0.01)
def crash(l, restart_at):
    if l._proc is None: return l.state()
    l._proc.kill()
    st = wait_state(l, ('restarting', 'failed'))
    if st == 'restarting':
        T[0] = restart_at; l.tick(T[0]); wait_state(l, ('ok',))
    return st
for keep_running in (True, False):
    T[0] = 0.0
    l = link('ok', restart_steps=(5, 30))
    l.start(0); wait_state(l, ('ok',))
    seen = [crash(l, 6), crash(l, 40)]
    if keep_running:
        # 600 s of an overlay that answers every ping.
        for t in range(45, 45 + ppt_display.RESTART_RESET_S + 31, 30):
            T[0] = float(t); l.tick(T[0]); answer_pings(l)
            if l.state() != 'ok': break
    seen.append(l.state())
    seen += [crash(l, T[0] + 6), crash(l, T[0] + 31)]
    r['reset' if keep_running else 'no_reset'] = seen
    l.close()
print(json.dumps(r))
`)
  assert.equal(out.reset_s, 600)
  assert.deepEqual(out.reset, ['restarting', 'restarting', 'ok', 'restarting', 'restarting'],
    'after 600 s without a fault two more faults are steps 1 and 2 again')
  assert.deepEqual(out.no_reset.slice(0, 3), ['restarting', 'restarting', 'ok'])
  assert.equal(out.no_reset[3], 'failed', 'without the quiet run the third fault is the last')
})

test('a whisper card has a slot of its own and goes to the overlay stack or the notification', () => {
  const out = py(`
class N:
    def __init__(self): self.shown = []
    def show(self, slot, s, b): self.shown.append([slot, s, b])
    def state(self): return 'ok'
    def tick(self, now): pass
    def close(self): pass
class O:
    def __init__(self, ok=True): self.cards, self.whispers, self.hidden, self.st, self.ok = [], [], [], 'ok', ok
    def state(self): return self.st
    def show(self, card): self.cards.append(card['key']); return True
    def show_whisper(self, card): self.whispers.append(card['key']); return self.ok
    def hide(self, key): self.hidden.append(key); return True
    def tick(self, now): pass
    def close(self): pass
class F:
    def __init__(self, st): self.st = st
    def state(self): return self.st
    def tick(self, now): pass
def wcard(wid): return {'key': 'whisper:' + wid, 'title': 'Whisper from buyer 1',
                        'lines': [['Whisper from Abc', 'name'], ['Tabula Rasa', 'name'], ['your 1 c', 'good']], 'final': True}
r = {}
n = N(); d = Display(log, notifier=n)
d.show_whisper(wcard('w1'), ('Whisper from buyer 1', 'Tabula Rasa\\nyour 1 c'))
d.show_whisper(wcard('w2'), ('Whisper from buyer 2', 'x'))
r['notify'] = n.shown
n, o, f = N(), O(), F('focused')
d = Display(log, notifier=n, overlay=o, focus=f, only_in_game=True)
d.show_item({'key': 'item:a', 'title': 'a', 'lines': [['a', 'name']], 'final': True})
d.show_whisper(wcard('w1'), ('s', 'b'))
r['overlay'] = {'w': list(o.whispers), 'items': list(o.cards), 'n': len(n.shown)}
f.st = 'not-focused'; d.tick(1)
r['alt_tab'] = sorted(o.hidden)
d.show_whisper(wcard('w2'), ('s', 'b'))
r['unfocused'] = {'w': list(o.whispers), 'n': [s[0] for s in n.shown]}
n, o = N(), O(ok=False)
d = Display(log, notifier=n, overlay=o, focus=F('focused'), only_in_game=True)
d.show_whisper(wcard('w3'), ('s', 'b'))
r['refused'] = [s[0] for s in n.shown]
print(json.dumps(r))
`)
  assert.deepEqual(out.notify, [['whisper:w1', 'Whisper from buyer 1', 'Tabula Rasa\nyour 1 c'], ['whisper:w2', 'Whisper from buyer 2', 'x']],
    'each whisper replaces only its own notification')
  assert.deepEqual(out.overlay, { w: ['whisper:w1'], items: ['item:a'], n: 0 })
  assert.deepEqual(out.alt_tab, ['item:a', 'whisper:w1'], 'the game lost focus: the whisper card goes too')
  assert.deepEqual(out.unfocused, { w: ['whisper:w1'], n: ['whisper:w2'] })
  assert.deepEqual(out.refused, ['whisper:w3'])
})

test('the overlay link sends a whisper card as a whisper command, and the item slot survives many whispers', () => {
  const out = pyLink(`
l = link('ok')
l.start(0)
r = {'ok': wait_state(l, ('ok',))}
r['sent'] = l.show_whisper({'key': 'whisper:w1', 'title': 'Whisper from buyer 1', 'lines': [['Whisper from Abc', 'name']], 'final': True})
l.close()
r['got'] = [m for msgs in got().values() for m in msgs if m.get('cmd') == 'whisper']
n = Notifier(log, which=lambda p: '/bin/true', max_slots=3)
n.ids['item'] = 5
for i in range(5):
    n.ids['whisper:w%d' % i] = 10 + i
    n.ids.move_to_end('whisper:w%d' % i)
    n._trim()
r['ids'] = list(n.ids)
print(json.dumps(r))
`)
  assert.equal(out.ok, 'ok')
  assert.equal(out.sent, true)
  assert.deepEqual(out.got, [{ cmd: 'whisper', key: 'whisper:w1', title: 'Whisper from buyer 1', lines: [['Whisper from Abc', 'name']] }])
  assert.deepEqual(out.ids, ['item', 'whisper:w3', 'whisper:w4'], 'the price check keeps its own notification')
})
