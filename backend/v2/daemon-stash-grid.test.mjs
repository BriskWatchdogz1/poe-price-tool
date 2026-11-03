// daemon/ppt_stash_grid.py — where a buyer whisper's stash cell lies on the
// screen, and the highlight key that frames it. The grid is SlimTrade's
// (POEWindow.kt: a 634x634 px rectangle at 15,125 of a 1920x1080 game window,
// kept as fractions of the window), so a wrong fraction, a wrong rounding or a
// quad tab drawn on 12 cells would put the frame on the wrong item; as plain
// functions over numbers they are tested here without a display.
//
// Why this lives here: the tests of daemon/ run from backend/v2/ with the rest
// (npm test, backend/v2/run-tests.mjs), driving python3 like
// daemon-overlay-model.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')

const PRELUDE = `
import json, sys
sys.path.insert(0, sys.argv[1])
from ppt_stash_grid import *
from ppt_link import CurlResult
`

function py (code) {
  const r = spawnSync('python3', ['-c', PRELUDE + code, DAEMON_DIR], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  assert.equal(r.status, 0, `python3 failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

test('the grid is SlimTrade\'s rectangle, scaled with the game window', () => {
  const out = py(`
print(json.dumps({
  'ref': grid_rect((0, 0, 1920, 1080)),
  'outside': grid_rect((0, 0, 1920, 1080), 'outside'),
  'inside': grid_rect((0, 0, 1920, 1080), 'inside'),
  'qhd_right': grid_rect((1920, 0, 2560, 1440)),
  'wide': grid_rect((0, 0, 3440, 1440)),
  'windowed': grid_rect((100, 50, 1280, 720)),
}))
`)
  assert.deepEqual(out.ref, [15, 125, 634, 634])
  assert.deepEqual(out.outside, [15, 133, 634, 634], 'with stash folders, selling from tabs outside them')
  assert.deepEqual(out.inside, [15, 167, 634, 634], 'selling from tabs inside a folder')
  // x by the window's width, y by its height, the size by its height only
  // (the game's UI does not stretch sideways): 15/1920*2560 = 20,
  // 125/1080*1440 = 166.7, 634/1080*1440 = 845.3.
  assert.deepEqual(out.qhd_right, [1920 + 20, 167, 845, 845], 'the window\'s own position is added')
  assert.deepEqual(out.wide, [27, 167, 845, 845], 'a wide window keeps a square grid')
  assert.deepEqual(out.windowed, [110, 133, 423, 423])
})

test('a cell is cut from the grid like SlimTrade does, 12 or 24 cells a side', () => {
  const out = py(`
g = (15, 125, 634, 634)
print(json.dumps({
  'first': cell_rect(g, 1, 1, False),
  'last': cell_rect(g, 12, 12, False),
  'quad_first': cell_rect(g, 1, 1, True),
  'quad_last': cell_rect(g, 24, 24, True),
  'beyond': cell_rect(g, 13, 1, False),
  'zero': cell_rect(g, 0, 1, False),
  'quad_beyond': cell_rect(g, 25, 1, True),
  'text': cell_rect(g, '3', 1, False),
  'flag': cell_rect(g, True, 1, False),
}))
`)
  // 634/12 = 52.8 -> 53; 634*11/12 = 581.2 -> 15 + 581.
  assert.deepEqual(out.first, [15, 125, 53, 53])
  assert.deepEqual(out.last, [596, 706, 53, 53])
  // 634/24 = 26.4 -> 26; 634*23/24 = 607.6 -> 608.
  assert.deepEqual(out.quad_first, [15, 125, 26, 26])
  assert.deepEqual(out.quad_last, [623, 733, 26, 26])
  for (const k of ['beyond', 'zero', 'quad_beyond', 'text', 'flag']) assert.equal(out[k], null, k)
})

test('a tab is quad when the sync says so or the cell lies beyond 12', () => {
  const out = py(`
print(json.dumps([is_quad(5, 3, None), is_quad(13, 1, None), is_quad(1, 24, None),
                  is_quad(5, 3, True), is_quad(13, 1, False), is_quad(5, 3, False), is_quad(12, 12, 'yes')]))
`)
  // A position beyond 12 beats a sync that says otherwise (a tab replaced by
  // a quad tab of the same name since): a 12x12 tab has no such cell.
  assert.deepEqual(out, [false, true, true, true, true, false, false])
})

test('the game window\'s geometry is read from xdotool --shell output, or not at all', () => {
  const out = py(`
ok = "WINDOW=62914561\\nX=1920\\nY=0\\nWIDTH=2560\\nHEIGHT=1440\\nSCREEN=0\\n"
print(json.dumps({
  'ok': parse_geometry(ok),
  'missing': parse_geometry("WINDOW=1\\nX=0\\nY=0\\nWIDTH=1920\\n"),
  'zero': parse_geometry("X=0\\nY=0\\nWIDTH=0\\nHEIGHT=1080\\n"),
  'junk': parse_geometry("X=a\\nY=0\\nWIDTH=1920\\nHEIGHT=1080\\n"),
  'empty': parse_geometry(""),
  'none': parse_geometry(None),
}))
`)
  assert.deepEqual(out.ok, [1920, 0, 2560, 1440])
  for (const k of ['missing', 'zero', 'junk', 'empty', 'none']) assert.equal(out[k], null, k)
})

test('[stash_grid] is optional, and its keys are checked and named', () => {
  const out = py(`
cases = [{}, {'mode': 'manual', 'x': 10, 'y': 120, 'w': 640, 'h': 640}, {'mode': 'off'},
         {'mode': 'maybe'}, {'folders': 'left'}, {'mode': 'manual'}, {'mode': 'manual', 'x': 10, 'y': 120, 'w': 0, 'h': 640},
         {'mode': 'manual', 'x': -1, 'y': 120, 'w': 640, 'h': 640}, {'mode': 'manual', 'x': True, 'y': 120, 'w': 640, 'h': 640},
         {'mode': 'manual', 'x': 1.5, 'y': 120, 'w': 640, 'h': 640}, {'x': 'a'}, {'mode': 'auto', 'folders': 'inside'},
         {'mode': 'manual', 'x': 10.0, 'y': 120, 'w': 640, 'h': 640}]
print(json.dumps([list(read_grid_config(c)) for c in cases]))
`)
  assert.deepEqual(out[0], [{ mode: 'auto', folders: 'none', rect: null }, null])
  assert.deepEqual(out[1], [{ mode: 'manual', folders: 'none', rect: [10, 120, 640, 640] }, null])
  assert.deepEqual(out[2][0].mode, 'off')
  assert.match(out[3][1], /^\[stash_grid\] mode must be one of "auto", "manual", "off" \(got 'maybe'\)$/)
  assert.match(out[4][1], /^\[stash_grid\] folders must be one of "none", "outside", "inside" \(got 'left'\)$/)
  assert.match(out[5][1], /^\[stash_grid\] mode = "manual" needs x, y, w and h \(the grid's top-left corner and size in screen pixels\)$/)
  assert.match(out[6][1], /^\[stash_grid\] w must be a whole number above 0 \(got 0\)$/)
  assert.match(out[7][1], /^\[stash_grid\] x must be a whole number of at least 0 \(got -1\)$/)
  assert.match(out[8][1], /^\[stash_grid\] x must be a whole number of at least 0 \(got True\)$/)
  assert.match(out[9][1], /^\[stash_grid\] x must be a whole number of at least 0 \(got 1\.5\)$/)
  assert.match(out[10][1], /^\[stash_grid\] x must be a whole number of at least 0/, 'checked in every mode')
  assert.deepEqual(out[11], [{ mode: 'auto', folders: 'inside', rect: null }, null])
  assert.deepEqual(out[12][0].rect, [10, 120, 640, 640], 'a whole number written as 10.0 is taken')
  for (const [cfg, err] of out) assert.ok((cfg === null) !== (err === null), 'a config or an error, never both')
})

test('each press within the hold goes one whisper older, and after the oldest back to the newest', () => {
  const out = py(`
c = HighlightCycle(20)
seq = []
seq.append(c.press(0, ['w3', 'w2', 'w1']))
seq.append(c.press(5, ['w3', 'w2', 'w1']))
seq.append(c.press(10, ['w3', 'w2', 'w1']))
seq.append(c.press(15, ['w3', 'w2', 'w1']))
seq.append(c.press(40, ['w3', 'w2', 'w1']))   # after the hold: the newest again
seq.append(c.press(45, ['w4', 'w3', 'w2', 'w1']))  # a new whisper came: on from w3 to w2
seq.append(c.press(50, ['w4']))               # the one shown is gone: the newest
seq.append(c.press(55, []))
seq.append(c.press(56, ['w4']))
print(json.dumps(seq))
`)
  assert.deepEqual(out, [0, 1, 2, 0, 0, 2, 0, null, 0])
})

// The highlighter with stand-ins: the whispers it is handed, a pool that
// records the xdotool call, and the display's two ways out (a frame, a card).
const HL = `
class Job:
    def __init__(self, res): self.result = res
    def poll(self, now): return self.result
class Pool:
    def __init__(self): self.calls = []; self.next = None
    def start_cmd(self, argv, timeout_s=1, tag=None):
        self.calls.append(argv); return Job(self.next)
class Log:
    def __init__(self): self.lines = []
    def failure(self, key, text): self.lines.append(['failure', list(key), text])
    def info(self, text): self.lines.append(['info', text])
    def recovered(self, cat): return 0
frames, cards = [], []
def show_frame(f): frames.append(f); return True
def show_card(c): cards.append(c)
W = [{'wid': 'w2', 'label': 'buyer 2', 'tab': 'Quad', 'left': 14, 'top': 20, 'quad': None},
     {'wid': 'w1', 'label': 'buyer 1', 'tab': 'Sale', 'left': 5, 'top': 3, 'quad': False}]
whispers = list(W)
pool, log = Pool(), Log()
def make(cfg, xdotool='/usr/bin/xdotool'):
    return Highlighter(log=log, pool=pool, grid=cfg, hold_s=20, positions=lambda: whispers,
                       show_frame=show_frame, show_card=show_card, xdotool=xdotool, config_path='/c/config.toml')
GEO = "WINDOW=1\\nX=0\\nY=0\\nWIDTH=1920\\nHEIGHT=1080\\n"
`

test('the key frames the newest whisper\'s cell, then the older one, on the right grid', () => {
  const out = py(HL + `
h = make({'mode': 'manual', 'folders': 'none', 'rect': [15, 125, 634, 634]})
h.press(0); h.press(1); h.press(2)
print(json.dumps({'frames': frames, 'cards': cards, 'calls': pool.calls}))
`)
  assert.deepEqual(out.calls, [], 'a manual grid needs no xdotool')
  assert.equal(out.frames.length, 3)
  // w2: left 14 is beyond 12, so a quad tab: 15 + round(634*13/24) = 358.
  assert.deepEqual([out.frames[0].x, out.frames[0].y, out.frames[0].w, out.frames[0].h], [358, 125 + 502, 26, 26])
  assert.equal(out.frames[0].key, 'frame')
  assert.equal(out.frames[0].hold_ms, 20000)
  assert.equal(out.frames[0].label, '1/2 buyer 2 · tab "Quad" · left 14, top 20')
  // w1: a 12x12 tab, cell 5,3: 15 + round(634*4/12) = 226, 125 + round(634*2/12) = 231.
  assert.deepEqual([out.frames[1].x, out.frames[1].y, out.frames[1].w, out.frames[1].h], [226, 231, 53, 53])
  assert.equal(out.frames[1].label, '2/2 buyer 1 · tab "Sale" · left 5, top 3')
  assert.equal(out.frames[2].label, out.frames[0].label, 'after the oldest the newest again')
  assert.deepEqual(out.cards, [])
})

test('in auto mode the game window\'s size comes from xdotool through the pool, never waited for', () => {
  const out = py(HL + `
h = make({'mode': 'auto', 'folders': 'none', 'rect': None})
pool.next = None
h.press(0)
before = list(frames)
h.tick(0.1)                      # no answer yet
pool.calls[-1]                   # the call that was started
h._job.result = CurlResult(0, None, GEO, '', False)
h.tick(0.2)
print(json.dumps({'before': before, 'frames': frames, 'calls': pool.calls, 'cards': cards}))
`)
  assert.deepEqual(out.calls, [['/usr/bin/xdotool', 'getwindowfocus', 'getwindowgeometry', '--shell']])
  assert.deepEqual(out.before, [], 'the frame waits for the geometry')
  assert.equal(out.frames.length, 1)
  assert.deepEqual([out.frames[0].x, out.frames[0].y], [358, 627])
})

test('every way the highlight cannot work is a card, and a geometry fault one journal line', () => {
  const out = py(HL + `
r = {}
whispers = []
h = make({'mode': 'manual', 'folders': 'none', 'rect': [15, 125, 634, 634]})
h.press(0)
r['none'] = cards[-1]['lines'][-1][0]
whispers = list(W)
noxd = make({'mode': 'auto', 'folders': 'none', 'rect': None}, xdotool=None)
noxd.press(0)
r['noxd'] = cards[-1]['lines'][-1][0]
bad = make({'mode': 'auto', 'folders': 'none', 'rect': None})
pool.next = CurlResult(1, None, '', 'XGetWindowAttributes failed', False)
bad.press(0); bad.tick(0.1)
r['bad'] = cards[-1]['lines'][-1][0]
pool.next = CurlResult(None, None, '', '', True)
bad.press(30); bad.tick(30.1)
r['slow'] = cards[-1]['lines'][-1][0]
def refuse(f): return False
off = Highlighter(log=log, pool=pool, grid={'mode': 'manual', 'folders': 'none', 'rect': [0, 0, 600, 600]}, hold_s=20,
                  positions=lambda: whispers, show_frame=refuse, show_card=show_card, xdotool=None, config_path='/c/config.toml')
off.press(0)
r['no_overlay'] = cards[-1]['lines'][-1][0]
r['card'] = cards[-1]
r['frames'] = frames
r['lines'] = log.lines
print(json.dumps(r))
`)
  assert.equal(out.none, 'no whisper with a stash position yet')
  assert.match(out.noxd, /needs xdotool/)
  assert.match(out.bad, /the game window's size could not be read/)
  assert.match(out.slow, /the game window's size could not be read/)
  assert.match(out.no_overlay, /needs the overlay over the game/)
  assert.deepEqual(out.frames, [])
  assert.equal(out.card.title, 'Stash cell frame')
  assert.equal(out.card.again, true, 'a second press brings a hidden card back')
  const fails = out.lines.filter(l => l[0] === 'failure')
  assert.equal(fails.length, 2, JSON.stringify(out.lines))
  assert.match(fails[0][2], /Stash cell frame: the game window's size could not be read with xdotool \(exit 1: XGetWindowAttributes failed\)/)
  assert.match(fails[0][2], /\[stash_grid\] mode = "manual"/, 'the way around it is named')
  assert.match(fails[1][2], /no answer within 1 s/)
})
