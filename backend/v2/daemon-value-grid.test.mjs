// daemon/ppt_value_grid.py — the value key ([stash_grid] value_key): what each
// item in a stash tab is worth, drawn over the open tab, from the cells the
// server stores per tab (GET /daemon/stash-grid, backend/v2/frontend/PROTOCOL.md).
//
// Why this lives here: `npm test` covers only backend/v2 (same reason as
// daemon-diag.test.mjs). ppt_value_grid.py is standard library only; the clock
// is a number the test moves and the server is a fake pool that records the
// requests (no curl, no network). The key press itself (evdev, the focus
// gate) and a real HTTP exchange are in daemon-diag.test.mjs.
//
// The rules under test: the stash API does not say which tab is open, so the
// first press shows the tab of the newest buyer whisper, else the tab shown
// last (when the hold ran out), else the first of the run, and each further
// press within value_hold_s steps on, until the grid goes after the last and
// the next press starts afresh (the whisper's tab, else the first); the tab
// list is asked at most every 60 s, the cells once per press; a cell's
// rectangle is the stash cell frame's grid (ppt_stash_grid), and a wrong
// rectangle would put a price on the wrong item; every case that shows no
// grid is a card that says why.

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
from ppt_value_grid import *
clock = [0.0]
lines = []
log = ThrottledLog(60, clock=lambda: clock[0], emit=lines.append)
class FakeJob:
    def __init__(self, args, timeout_s, tag, http=True):
        self.args, self.timeout_s, self.tag, self.http = args, timeout_s, tag, http
        self.result = None
    def poll(self, now):
        return self.result
class FakePool:
    def __init__(self):
        self.jobs = []
    def start(self, args, stdin_bytes=None, timeout_s=10, tag=None):
        j = FakeJob(args, timeout_s, tag)
        self.jobs.append(j)
        return j
    def start_cmd(self, argv, timeout_s=1, tag=None):
        j = FakeJob(argv, timeout_s, tag, http=False)
        self.jobs.append(j)
        return j
def answer(job, status=200, body='', rc=0, timed_out=False, err=''):
    if not isinstance(body, str):
        body = json.dumps(body)
    job.result = CurlResult(rc, status, body, err, timed_out)
def url(job):
    return job.args[-1]
TABS = [{'index': 0, 'name': 'Dump', 'type': 'QuadStash', 'grid': True},
        {'index': 1, 'name': 'Currency', 'type': 'CurrencyStash', 'grid': False},
        {'index': 2, 'name': 'Sale', 'type': 'PremiumStash', 'grid': True},
        {'index': 3, 'name': 'Maps', 'type': 'NormalStash', 'grid': True}]
def tab_answer(i, cells=None, cd=180, total=None):
    t = next(t for t in TABS if t['index'] == i)
    cells = [] if cells is None else cells
    return {'v': 1, 'tabs': TABS, 'tab': {**t, 'quad': t['type'] == 'QuadStash', 'syncedAt': 1793606400000},
            'cells': cells, 'totalChaos': total if total is not None else round(sum(c['c'] for c in cells), 1),
            'chaosPerDivine': cd}
shown, hidden, cards = [], [], []
def show_grid(g, toast):
    shown.append({'grid': g, 'toast': list(toast)})
def hide_grid(key):
    hidden.append(key)
def show_card(c):
    cards.append(c['lines'][-1][0])
whispers = []
MANUAL = {'mode': 'manual', 'folders': 'none', 'rect': [15, 125, 634, 634]}
def make(pool=None, grid=MANUAL, cfg=None, xdotool='/usr/bin/xdotool', **kw):
    c = {'key': 'F9', 'min_c': 5, 'hold_s': 20, 'tabs': []}
    c.update(cfg or {})
    opts = dict(pool=pool or FakePool(), base_url='http://h:1/', hdrs=headers('player1', '9.9.9', 'ab12'),
                log=log, grid=grid, cfg=c, whisper_hold_s=20, positions=lambda: whispers,
                show_grid=show_grid, hide_grid=hide_grid, show_card=show_card, xdotool=xdotool,
                config_path='/cfg/config.toml', user='player1')
    opts.update(kw)
    return ValueGrid(**opts)
def press(v, now):
    clock[0] = float(now)
    v.press(now)
def tick(v, now):
    clock[0] = float(now)
    v.tick(now)
`

function py (code) {
  const r = spawnSync('python3', ['-c', PRELUDE + code, DAEMON_DIR], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  assert.equal(r.status, 0, `python3 failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

// --- the config ------------------------------------------------------------------

test('the value keys of [stash_grid] are optional, and each is checked and named', () => {
  const out = py(`
cases = [{}, {'value_key': ' F9 ', 'value_min_c': 0, 'value_hold_s': 2.5, 'value_tabs': ['Dump', 'Sale']},
         {'value_tabs': 'Dump'}, {'value_key': 9}, {'value_min_c': -1}, {'value_min_c': True}, {'value_min_c': 'x'},
         {'value_min_c': float('nan')}, {'value_hold_s': 0}, {'value_hold_s': float('inf')}, {'value_tabs': ['Dump', '']},
         {'value_tabs': [1]}, {'mode': 'manual'}]
print(json.dumps([list(read_value_config(c)) for c in cases]))
`)
  assert.deepEqual(out[0], [{ key: '', min_c: 5, hold_s: 20, tabs: [] }, null], 'defaults: off, 5 c, 20 s, every grid tab')
  assert.deepEqual(out[1], [{ key: 'F9', min_c: 0, hold_s: 2.5, tabs: ['Dump', 'Sale'] }, null])
  assert.deepEqual(out[2][0].tabs, ['Dump'], 'a single text is a list of one')
  assert.equal(out[3][1], '[stash_grid] value_key must be a text (got 9)')
  assert.equal(out[4][1], '[stash_grid] value_min_c must be a number of at least 0 (got -1)')
  assert.equal(out[5][1], '[stash_grid] value_min_c must be a number of at least 0 (got True)')
  assert.equal(out[6][1], "[stash_grid] value_min_c must be a number of at least 0 (got 'x')")
  assert.equal(out[7][1], '[stash_grid] value_min_c must be a number of at least 0 (got nan)')
  assert.equal(out[8][1], '[stash_grid] value_hold_s must be a positive number (got 0)')
  assert.equal(out[9][1], '[stash_grid] value_hold_s must be a positive number (got inf)')
  assert.equal(out[10][1], "[stash_grid] value_tabs must be a list of non-empty texts (got ['Dump', ''])")
  assert.equal(out[11][1], '[stash_grid] value_tabs must be a list of non-empty texts (got [1])')
  assert.deepEqual(out[12], [{ key: '', min_c: 5, hold_s: 20, tabs: [] }, null], 'the frame\'s keys are not its business')
  for (const [cfg, err] of out) assert.ok((cfg === null) !== (err === null), 'a config or an error, never both')
})

// --- which tab a press shows ---------------------------------------------------------

test('the first press shows the whisper\'s tab, else the one shown last, else the first; each press steps on, after the last the grid goes', () => {
  const out = py(`
c = TabCycle(20)
seq = []
seq.append(c.press(0, [0, 2, 3]))            # nothing known: the first
seq.append(c.press(5, [0, 2, 3]))            # within the hold: the next
seq.append(c.press(10, [0, 2, 3]))
seq.append(c.press(15, [0, 2, 3]))           # after the last: gone
seq.append(c.press(16, [0, 2, 3]))           # a run that went past its last, no whisper: the first
seq.append(c.press(17, [0, 2, 3]))           # within the hold: the next
seq.append(c.press(60, [0, 2, 3]))           # the hold ran out on tab 2: the tab shown last
seq.append(c.press(100, [0, 2, 3], 3))       # a whisper's tab beats the one shown last
seq.append(c.press(102, [0, 2, 3], 0))       # within the hold the whisper changes nothing: after the last, gone
seq.append(c.press(103, [0, 2, 3], 2))       # a new run: the whisper's tab
seq.append(c.press(200, [0, 3], 9))          # a whisper tab outside the run, the one shown last gone too: the first
seq.append(c.press(201, []))
print(json.dumps(seq))
`)
  assert.deepEqual(out, [0, 1, 2, null, 0, 1, 1, 2, null, 1, 0, null])
})

test('pressing through every tab again and again shows every tab, also with pauses between the runs', () => {
  const out = py(`
c = TabCycle(20)
fast = [c.press(t, [1, 2, 3]) for t in range(10)]
c = TabCycle(20)
slow = []
for run in range(3):
    base = run * 100
    slow += [c.press(base + t, [1, 2, 3]) for t in range(4)]
print(json.dumps({'fast': fast, 'slow': slow}))
`)
  assert.deepEqual(out.fast, [0, 1, 2, null, 0, 1, 2, null, 0, 1])
  assert.deepEqual(out.slow, [0, 1, 2, null, 0, 1, 2, null, 0, 1, 2, null], 'never stuck on the last tab')
})

test('a press asks for the tab list once, then for the cells of the chosen tab; the list is kept for 60 s', () => {
  const out = py(`
pool = FakePool()
v = make(pool)
press(v, 0)
r = {'first': [url(j) for j in pool.jobs]}
answer(pool.jobs[0], 200, {'v': 1, 'tabs': TABS})
tick(v, 0.1)
r['then'] = [url(j) for j in pool.jobs]
answer(pool.jobs[1], 200, tab_answer(0))
tick(v, 0.2)
press(v, 1); tick(v, 1)
answer(pool.jobs[2], 200, tab_answer(2)); tick(v, 1.1)
press(v, 2); tick(v, 2)
answer(pool.jobs[3], 200, tab_answer(3)); tick(v, 2.1)
press(v, 3); tick(v, 3)                          # after the last: gone, no request
r['after_last'] = len(pool.jobs)
press(v, 70); tick(v, 70)                        # the list is old: asked again first
r['stale'] = [url(j) for j in pool.jobs[4:]]
r['headers'] = pool.jobs[0].args
r['hidden'] = hidden
r['shown'] = [s['grid']['label'] for s in shown]
print(json.dumps(r))
`)
  assert.deepEqual(out.first, ['http://h:1/daemon/stash-grid'])
  assert.deepEqual(out.then, ['http://h:1/daemon/stash-grid', 'http://h:1/daemon/stash-grid?tab=0'])
  assert.equal(out.after_last, 4, 'the end of the run sends nothing')
  assert.deepEqual(out.hidden, ['grid'])
  assert.deepEqual(out.stale, ['http://h:1/daemon/stash-grid'])
  for (const h of ['X-User: player1', 'X-PPT-Daemon: 9.9.9', 'X-PPT-Instance: ab12']) assert.ok(out.headers.includes(h), h)
  assert.deepEqual(out.shown, [
    '1/3 tab "Dump" · nothing from 5c',
    '2/3 tab "Sale" · nothing from 5c',
    '3/3 tab "Maps" · nothing from 5c'
  ], 'the currency tab has no grid and is not part of the run')
})

test('the first press shows the tab of the newest buyer whisper within whisper_hold_s', () => {
  const out = py(`
pool = FakePool()
v = make(pool)
whispers[:] = [{'wid': 'w2', 'label': 'buyer 2', 'tab': 'Sale', 'left': 5, 'top': 3, 'quad': None, 'at': 10.0},
               {'wid': 'w1', 'label': 'buyer 1', 'tab': 'Maps', 'left': 1, 'top': 1, 'quad': None, 'at': 5.0}]
press(v, 12)
answer(pool.jobs[0], 200, {'v': 1, 'tabs': TABS}); tick(v, 12.1)
r = {'fresh': url(pool.jobs[1])}
answer(pool.jobs[1], 200, tab_answer(2)); tick(v, 12.2)
press(v, 50)                                    # hold over, whisper 40 s old: the tab shown last
r['old'] = url(pool.jobs[2])
answer(pool.jobs[2], 200, tab_answer(2)); tick(v, 50.1)
whispers[:] = [{'wid': 'w3', 'label': 'buyer 3', 'tab': 'Elsewhere', 'left': 1, 'top': 1, 'quad': None, 'at': 99.0}]
press(v, 100)                                   # its tab is not in the run: the tab shown last
r['outside'] = url(pool.jobs[3])
print(json.dumps(r))
`)
  assert.equal(out.fresh, 'http://h:1/daemon/stash-grid?tab=2')
  assert.equal(out.old, 'http://h:1/daemon/stash-grid?tab=2')
  assert.equal(out.outside, 'http://h:1/daemon/stash-grid?tab=2')
})

test('value_tabs is the run, in its own order; a name no stored tab has is written once, at the first list', () => {
  const out = py(`
pool = FakePool()
v = make(pool, cfg={'tabs': ['Maps', 'Nope', 'Currency', 'Dump']})
v.start(0)
answer(pool.jobs[0], 200, {'v': 1, 'tabs': TABS}); tick(v, 0.1)
r = {'lines': list(lines)}
press(v, 1)
r['first'] = url(pool.jobs[1])
answer(pool.jobs[1], 200, tab_answer(3)); tick(v, 1.1)
press(v, 2)
r['second'] = len(pool.jobs)
press(v, 3)
r['third'] = url(pool.jobs[-1])
answer(pool.jobs[-1], 200, tab_answer(0)); tick(v, 3.1)
press(v, 80); answer(pool.jobs[-1], 200, {'v': 1, 'tabs': TABS}); tick(v, 80.1)
r['lines_after'] = len(lines)
r['cards'] = cards
print(json.dumps(r))
`)
  assert.equal(out.lines.length, 1, out.lines.join('\n'))
  assert.match(out.lines[0], /Value grid: \[stash_grid\] value_tabs names "Nope", which no stored stash tab has; the value key skips it\./)
  assert.equal(out.first, 'http://h:1/daemon/stash-grid?tab=3', 'Maps first: the order of value_tabs')
  assert.equal(out.second, 2, 'a named tab without a grid is a card, without a request')
  assert.deepEqual(out.cards, ['tab "Currency": no value grid for this tab type'])
  assert.equal(out.third, 'http://h:1/daemon/stash-grid?tab=0')
  assert.equal(out.lines_after, 1, 'written once')
})

// --- the grid it draws ---------------------------------------------------------------

test('cells land on the stash cell frame\'s grid: left = x + 1, top = y + 1, the size in cells, quad from the server', () => {
  const out = py(`
pool = FakePool()
v = make(pool)
press(v, 0)
answer(pool.jobs[0], 200, {'v': 1, 'tabs': TABS}); tick(v, 0.1)
cells = [{'x': 4, 'y': 2, 'w': 2, 'h': 3, 'c': 900, 'n': 'Headhunter'},
         {'x': 0, 'y': 0, 'w': 1, 'h': 1, 'c': 12.4, 'n': 'Chaos Orb'},
         {'x': 23, 'y': 23, 'w': 1, 'h': 1, 'c': 4.9, 'n': 'Cheap'},
         {'x': 23, 'y': 22, 'w': 2, 'h': 1, 'c': 50, 'n': 'Over the edge'}]
answer(pool.jobs[1], 200, tab_answer(0, cells)); tick(v, 0.2)
quad = shown[-1]
press(v, 1); answer(pool.jobs[2], 200, tab_answer(2, [{'x': 4, 'y': 2, 'w': 2, 'h': 3, 'c': 900, 'n': 'Headhunter'}])); tick(v, 1.1)
print(json.dumps({'quad': quad, 'normal': shown[-1]}))
`)
  const g = out.quad.grid
  assert.deepEqual([g.key, g.x, g.y, g.w, g.h, g.hold_ms], ['grid', 15, 125, 634, 634, 20000])
  // Quad: a cell is 634/24 = 26.4 px; x 4 -> left 5: 15 + round(634*4/24) = 121, y 2: 125 + round(634*2/24) = 178;
  // the far edges are where the cell after the item starts: 15 + round(634*6/24) = 174, 125 + round(634*5/24) = 257.
  assert.deepEqual(g.cells, [
    { x: 121, y: 178, w: 53, h: 79, label: '5d' },
    { x: 15, y: 125, w: 26, h: 26, label: '12c' }
  ], 'below value_min_c and beyond the grid: no cell; dearest first')
  assert.equal(g.label, '1/3 tab "Dump" · 2 items from 5c · tab total 5.4d')
  // 12x12: x 4 -> 15 + round(634*4/12) = 226 to 15 + round(634*6/12) = 332; y 2 -> 125 + round(634*2/12) = 231 to 125 + round(634*5/12) = 389.
  assert.deepEqual(out.normal.grid.cells, [{ x: 226, y: 231, w: 106, h: 158, label: '5d' }])
  assert.deepEqual(out.quad.toast, ['Value grid · tab "Dump"', 'left 5, top 3: 5d Headhunter\nleft 1, top 1: 12c Chaos Orb'])
})

test('an item at the grid\'s right or bottom edge ends on it and reaches the overlay, at every common window height', () => {
  const out = py(`
from ppt_overlay_model import grid_cells
from ppt_stash_grid import grid_rect
pool = FakePool()
v = make(pool, grid={'mode': 'auto', 'folders': 'none', 'rect': None}, cfg={'tabs': ['Sale']})
press(v, 0)
answer(pool.jobs[0], 200, {'v': 1, 'tabs': TABS}); tick(v, 0.1)
cells_job, geo_job = pool.jobs[1], pool.jobs[2]      # Sale, a premium tab: 12x12
answer(cells_job, 200, tab_answer(2, [{'x': 10, 'y': 9, 'w': 2, 'h': 3, 'c': 900, 'n': 'Big'}]))
answer(geo_job, None, 'WINDOW=1\\nX=0\\nY=0\\nWIDTH=1920\\nHEIGHT=1080\\n')
tick(v, 0.2)
g = shown[-1]['grid']
r = {'grid': [g['x'], g['y'], g['w'], g['h']], 'cells': g['cells'],
     'overlay': len(grid_cells((g['x'], g['y'], g['w'], g['h']), g['cells']))}
dropped = {}
for wh in (720, 900, 1080, 1200, 1440, 1600, 2160):
    rect = grid_rect((0, 0, wh * 16 // 9, wh))
    for quad, count in ((False, 12), (True, 24)):
        n = 0
        for w in (1, 2):
            for h in (1, 2, 3, 4):
                for x in range(count - w + 1):
                    for y in range(count - h + 1):
                        cx, cy, cw, ch = span_rect(rect, x + 1, y + 1, w, h, quad)
                        n += not grid_cells(rect, [{'x': cx, 'y': cy, 'w': cw, 'h': ch, 'label': '1c'}])
        dropped[f'{wh}{"q" if quad else ""}'] = n
r['dropped'] = dropped
r['quad_bottom'] = span_rect((15, 125, 634, 634), 24, 23, 1, 2, True)
r['outside'] = [span_rect((15, 125, 634, 634), 12, 10, 1, 4, False), span_rect((15, 125, 634, 634), 11, 1, 2, 0, False)]
print(json.dumps(r))
`)
  assert.deepEqual(out.grid, [15, 125, 634, 634], '1920x1080, the reference size')
  // x 10 -> 15 + round(634*10/12) = 543 to 15 + 634 = 649; y 9 -> 125 + round(634*9/12) = 601 (475.5 rounds up) to 125 + 634 = 759.
  assert.deepEqual(out.cells, [{ x: 543, y: 601, w: 106, h: 158, label: '5d' }])
  assert.equal(out.overlay, 1, 'the overlay keeps the 2x3 item in the bottom-right corner')
  for (const [size, n] of Object.entries(out.dropped)) assert.equal(n, 0, `${size}: no item dropped`)
  // Quad, 1x2 at the bottom of the last column: 15 + round(634*23/24) = 623 to 649, 125 + round(634*22/24) = 706 to 759.
  assert.deepEqual(out.quad_bottom, [623, 706, 26, 53])
  assert.deepEqual(out.outside, [null, null], 'past the grid, or no size: no rectangle')
})

test('an uncertain cell gets a question mark after its value, in the grid and the notification, and the tab line counts them', () => {
  const out = py(`
pool = FakePool()
v = make(pool)
press(v, 0)
answer(pool.jobs[0], 200, {'v': 1, 'tabs': TABS}); tick(v, 0.1)
cells = [{'x': 4, 'y': 2, 'w': 2, 'h': 3, 'c': 270, 'n': 'Headhunter', 'u': True},
         {'x': 0, 'y': 0, 'w': 1, 'h': 1, 'c': 12.4, 'n': 'Chaos Orb', 'u': True},
         {'x': 2, 'y': 4, 'w': 1, 'h': 1, 'c': 50, 'n': 'Plain'},
         {'x': 3, 'y': 4, 'w': 1, 'h': 1, 'c': 40, 'n': 'Text', 'u': 'yes'},
         {'x': 5, 'y': 5, 'w': 1, 'h': 1, 'c': 30, 'n': 'False', 'u': False},
         {'x': 6, 'y': 6, 'w': 1, 'h': 1, 'c': 4, 'n': 'Cheap', 'u': True},
         {'x': 23, 'y': 22, 'w': 2, 'h': 1, 'c': 60, 'n': 'Over the edge', 'u': True}]
answer(pool.jobs[1], 200, tab_answer(2, cells, total=1000)); tick(v, 0.2)
marked = shown[-1]
press(v, 1); answer(pool.jobs[2], 200, tab_answer(3, [c for c in cells if c.get('u') is not True], total=120)); tick(v, 1.1)
print(json.dumps({'marked': marked, 'plain': shown[-1]}))
`)
  const g = out.marked.grid
  assert.deepEqual(g.cells.map(c => [c.label, c.u]), [
    ['1.5d?', true], ['50c', undefined], ['40c', undefined], ['30c', undefined], ['12c?', true]
  ], 'only u: true marks a cell; a cell under value_min_c or off the grid is not drawn at all')
  assert.equal(g.label, '1/3 tab "Sale" · 5 items from 5c · 2 uncertain · tab total 5.6d',
    'counted among the cells drawn, not every stored one, and beside them, before the total')
  assert.deepEqual(out.marked.toast, ['Value grid · tab "Sale"',
    'left 5, top 3: 1.5d? Headhunter\nleft 3, top 5: 50c Plain\nleft 4, top 5: 40c Text\nleft 6, top 6: 30c False\nleft 1, top 1: 12c? Chaos Orb'])
  const p = out.plain.grid
  assert.ok(p.cells.every(c => !('u' in c) && !c.label.endsWith('?')), JSON.stringify(p.cells))
  assert.equal(p.label, '2/3 tab "Maps" · 3 items from 5c · tab total 120c', 'no uncertain cell: no count')
  assert.ok(!out.plain.toast[1].includes('?'))
})

test('values are written like the cards: chaos without decimals below 1 divine, divine with one from there, chaos without a rate', () => {
  const out = py(`
print(json.dumps([value_text(12.4, 180), value_text(179.4, 180), value_text(180, 180), value_text(270, 180),
                  value_text(1234.5, 180, 'de'), value_text(4500, None), value_text(4500, None, 'de'),
                  value_text(4500, 0), value_text(0.6, 180), value_text(179.6, 180), value_text(360, 180),
                  value_text(368.9, 180)]))
`)
  assert.deepEqual(out, ['12c', '179c', '1d', '1.5d', '6,9d', '4,500c', '4.500c', '4,500c', '1c',
    '1d', '2d', '2d'], 'one decimal at most, like the cards; 179.6 c rounds to 180 c, which is 1 divine')
})

test('without the overlay the grid is a notification of the 5 dearest cells; value_min_c holds there too', () => {
  const out = py(`
pool = FakePool()
v = make(pool, cfg={'min_c': 10})
press(v, 0)
answer(pool.jobs[0], 200, {'v': 1, 'tabs': TABS}); tick(v, 0.1)
cells = [{'x': i, 'y': 0, 'w': 1, 'h': 1, 'c': 100 - i * 10, 'n': f'Item {i}'} for i in range(8)]
answer(pool.jobs[1], 200, tab_answer(2, cells, cd=None)); tick(v, 0.2)
print(json.dumps(shown[-1]['toast']))
`)
  assert.deepEqual(out, ['Value grid · tab "Sale"',
    'left 1, top 1: 100c Item 0\nleft 2, top 1: 90c Item 1\nleft 3, top 1: 80c Item 2\nleft 4, top 1: 70c Item 3\nleft 5, top 1: 60c Item 4'])
})

test('in auto mode the grid comes from the game window\'s size, read with xdotool next to the cells', () => {
  const out = py(`
pool = FakePool()
v = make(pool, grid={'mode': 'auto', 'folders': 'none', 'rect': None})
press(v, 0)
answer(pool.jobs[0], 200, {'v': 1, 'tabs': TABS}); tick(v, 0.1)
r = {'jobs': [j.args for j in pool.jobs[1:]]}
answer(pool.jobs[1], 200, tab_answer(0, [{'x': 0, 'y': 0, 'w': 1, 'h': 1, 'c': 50, 'n': 'A'}])); tick(v, 0.2)
r['before_geometry'] = len(shown)
answer(pool.jobs[2], None, 'WINDOW=1\\nX=0\\nY=0\\nWIDTH=2560\\nHEIGHT=1440\\n'); tick(v, 0.3)
r['grid'] = shown[-1]['grid']
press(v, 1); answer(pool.jobs[3], 200, tab_answer(2)); answer(pool.jobs[4], None, '', rc=1, err='no window'); tick(v, 1.1)
r['cards'] = list(cards)
r['lines'] = list(lines)
nox = make(FakePool(), grid={'mode': 'auto', 'folders': 'none', 'rect': None}, xdotool=None)
nox._tabs, nox._tabs_at = TABS, 5
press(nox, 5)
r['nox'] = cards[-1]
print(json.dumps(r))
`)
  assert.equal(out.jobs[0].at(-1), 'http://h:1/daemon/stash-grid?tab=0')
  assert.deepEqual(out.jobs[1], ['/usr/bin/xdotool', 'getwindowfocus', 'getwindowgeometry', '--shell'])
  assert.equal(out.before_geometry, 0, 'drawn once both are there')
  assert.deepEqual([out.grid.x, out.grid.y, out.grid.w, out.grid.h], [20, 167, 845, 845])
  assert.deepEqual(out.cards, ['the game window\'s size could not be read'])
  assert.match(out.lines.join('\n'), /Value grid: the game window's size could not be read with xdotool \(exit 1: no window\)/)
  assert.match(out.nox, /the value grid needs xdotool to find the game window/)
})

// --- the cards when there is no grid --------------------------------------------------

test('every case without a grid is a card titled Value grid that says why', () => {
  const out = py(`
r = {}
def one(status, body, rc=0, timed_out=False, list_too=True):
    del cards[:]
    pool = FakePool()
    v = make(pool)
    press(v, 0)
    if list_too:
        answer(pool.jobs[0], 200, {'v': 1, 'tabs': TABS}); tick(v, 0.1)
    answer(pool.jobs[-1], status, body, rc=rc, timed_out=timed_out); tick(v, 0.2)
    return v, pool, list(cards)
_, _, r['not_read'] = one(200, {**tab_answer(0), 'cells': None, 'reason': 'not-read-since-update', 'totalChaos': None})
_, _, r['no_grid'] = one(200, {**tab_answer(0), 'tab': {'index': 0, 'name': 'Dump', 'type': 'MapStash', 'quad': False, 'grid': False, 'syncedAt': 1}})
_, _, r['too_old'] = one(404, {'error': 'unknown daemon route', 'path': '/daemon/stash-grid'}, list_too=False)
_, _, r['too_old_405'] = one(405, 'Method not allowed', list_too=False)
_, _, r['too_many'] = one(429, {'v': 1, 'error': 'too-many-grid-requests'})
_, _, r['unreachable'] = one(None, '', rc=7, list_too=False)
_, _, r['timeout'] = one(None, '', timed_out=True)
v, pool, r['gone'] = one(404, {'error': 'no such tab'})
press(v, 1)
r['gone_then'] = url(pool.jobs[-1])
_, _, r['empty'] = one(200, {'v': 1, 'tabs': []}, list_too=False)
_, _, r['no_run'] = one(200, {'v': 1, 'tabs': [TABS[1]]}, list_too=False)
r['lines'] = lines
print(json.dumps(r))
`)
  assert.deepEqual(out.not_read, ['tab "Dump": read again with the next sync'])
  assert.deepEqual(out.no_grid, ['tab "Dump": no value grid for this tab type'])
  assert.deepEqual(out.too_old, ['server too old for the value grid'])
  assert.deepEqual(out.too_old_405, ['server too old for the value grid'])
  assert.deepEqual(out.too_many, ['too many presses, wait a moment'])
  assert.deepEqual(out.unreachable, ['server not reachable'])
  assert.deepEqual(out.timeout, ['no answer from the server, see the journal'])
  assert.deepEqual(out.gone, ['tab "Dump" is gone from the stash; press again'])
  assert.equal(out.gone_then, 'http://h:1/daemon/stash-grid', 'a tab that is gone: the list is asked again')
  assert.deepEqual(out.empty, ['no stash tab stored yet: the net-worth sync has not read your stash'])
  assert.deepEqual(out.no_run, ['no stash tab with a grid stored'])
  const text = out.lines.join('\n')
  assert.match(text, /The backend at http:\/\/h:1 has no \/daemon\/stash-grid \(HTTP 404\).*The value key does nothing/)
  assert.match(text, /GET \/daemon\/stash-grid failed: cannot reach http:\/\/h:1/)
  assert.doesNotMatch(text, /429|too-many/, 'too many presses is an answer, not a fault')
})

test('a server without the route is asked again only after reprobe_s; the card comes without a request', () => {
  const out = py(`
pool = FakePool()
v = make(pool, reprobe_s=600)
press(v, 0)
answer(pool.jobs[0], 404, {'error': 'unknown daemon route'}); tick(v, 0.1)
press(v, 10); tick(v, 10)
r = {'quiet': len(pool.jobs), 'cards': list(cards)}
press(v, 700)
r['again'] = len(pool.jobs)
print(json.dumps(r))
`)
  assert.equal(out.quiet, 1)
  assert.deepEqual(out.cards, ['server too old for the value grid', 'server too old for the value grid'])
  assert.equal(out.again, 2)
})

test('one request at a time: a press while one runs sends nothing', () => {
  const out = py(`
pool = FakePool()
v = make(pool)
press(v, 0); press(v, 0.1)
r = {'n': len(pool.jobs)}
answer(pool.jobs[0], 200, {'v': 1, 'tabs': TABS}); tick(v, 0.2)
press(v, 0.3)
r['m'] = len(pool.jobs)
print(json.dumps(r))
`)
  assert.equal(out.n, 1)
  assert.equal(out.m, 2, 'the cells request of the first press only')
})
