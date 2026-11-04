// daemon/ppt_overlay_model.py — where the overlay's cards go and when they
// leave. Placement at screen edges, several screens and hiding after the mouse
// moved away are the usual overlay faults; as plain functions over numbers they
// are tested here without a display and without Qt.
//
// Why this lives here: `npm test` covers only backend/v2 (same reason as
// daemon-diag.test.mjs).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')

const PRELUDE = `
import json, sys
sys.path.insert(0, sys.argv[1])
from ppt_overlay_model import *
`

function py (code) {
  const r = spawnSync('python3', ['-c', PRELUDE + code, DAEMON_DIR], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  assert.equal(r.status, 0, `python3 failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

test('the card is placed next to the mouse and stays on its screen', () => {
  const out = py(`
one = [(0, 0, 1920, 1080)]
two = [(0, 0, 1920, 1080), (1920, 0, 2560, 1440)]
print(json.dumps({
  'plain': place((100, 100), one, (300, 90)),
  'corner': place((1900, 1060), one, (300, 90)),
  'second': place((2500, 500), two, (300, 90)),
  'second_edge': place((4470, 1430), two, (300, 90)),
  'outside': place((-50, -50), one, (300, 90)),
  'huge': place((100, 100), one, (3000, 90)),
  'none': place((10, 10), [], (300, 90)),
}))
`)
  assert.deepEqual(out.plain, [124, 124])
  const [x, y] = out.corner
  assert.ok(x + 300 <= 1900 && y + 90 <= 1060, `left of and above the cursor: ${out.corner}`)
  assert.ok(x >= 8 && y >= 8, 'inside the screen')
  assert.ok(out.second[0] >= 1920, `stays on the cursor's screen: ${out.second}`)
  assert.ok(out.second_edge[0] + 300 <= 1920 + 2560 - 8 && out.second_edge[1] + 90 <= 1440 - 8)
  assert.ok(out.outside[0] >= 8 && out.outside[1] >= 8, 'a cursor outside every screen uses the first one')
  assert.equal(out.huge[0], 8, 'a box wider than the screen keeps its left edge on it')
  assert.deepEqual(out.none, [34, 34])
})

test('the whisper stack starts at its anchor and goes down', () => {
  const out = py(`
two = [(0, 0, 1920, 1080), (1920, 0, 2560, 1440)]
print(json.dumps({
  'anchor': anchor_point(two, (2000, 10), (0.5, 0.25)),
  'stack': stack((100, 50), [(300, 60), (300, 80), (300, 40)], gap=8),
}))
`)
  assert.deepEqual(out.anchor, [1920 + 1280, 360])
  assert.deepEqual(out.stack, [[100, 50], [100, 118], [100, 206]])
})

test('lines are cut to fit, malformed ones are skipped', () => {
  const out = py(`
lines = [['x' * 80, 'name'], ['140 div', 'price'], 'plain', None, ['a', 'muted'], ['b', 'muted'], ['c', 'muted']]
print(json.dumps(fit_lines(lines, max_chars=48, max_lines=4)))
`)
  assert.equal(out.length, 4)
  assert.equal(out[0][0].length, 48)
  assert.ok(out[0][0].endsWith('…'))
  assert.deepEqual(out[1], ['140 div', 'price'])
  assert.deepEqual(out[2], ['plain', 'muted'])
  assert.deepEqual(out[3], ['a', 'muted'])
})

test('the item card leaves with the mouse, after its hold time, and a late result comes back', () => {
  const out = py(`
r = {}
c = Cards(item_hold_ms=8000, pending_hold_ms=60000, hide_distance_px=220, whisper_hold_ms=20000, max_whispers=3)
r['first'] = c.item('item:a', {'final': False}, 0, (500, 500))
r['near'] = c.tick(100, (600, 560))
r['far'] = c.tick(200, (800, 500))
r['hidden_update'] = c.item('item:a', {'final': False}, 300, (800, 500))
r['late'] = c.item('item:a', {'final': True}, 400, (800, 500))
r['hold_before'] = c.tick(8300, (800, 500))
r['hold_after'] = c.tick(8400, (800, 500))
r['again'] = c.item('item:a', {'final': True, 'again': True}, 9000, (10, 10))
r['update'] = c.item('item:a', {'final': True}, 9100, (10, 10))
r['new'] = c.item('item:b', {'final': False}, 9200, (10, 10))
r['pending_before'] = c.tick(9200 + 59999, (10, 10))
r['pending_after'] = c.tick(9200 + 60000, (10, 10))
print(json.dumps(r))
`)
  assert.equal(out.first, 'show')
  assert.deepEqual(out.near, [], '116 px is within 220 px')
  assert.deepEqual(out.far, ['item:a'])
  assert.equal(out.hidden_update, 'hidden', 'a queue update does not bring the card back')
  assert.equal(out.late, 'reshow', 'a late result comes back at the cursor')
  assert.deepEqual(out.hold_before, [])
  assert.deepEqual(out.hold_after, ['item:a'], 'item_hold_ms after the result')
  assert.equal(out.again, 'reshow', 'the same item copied again')
  assert.equal(out.update, 'update')
  assert.equal(out.new, 'show', 'a new hotkey replaces the item card')
  assert.deepEqual(out.pending_before, [])
  assert.deepEqual(out.pending_after, ['item:b'], 'pending_hold_ms without a result')
})

test('whisper cards: newest on top, at most max, each for its hold time', () => {
  const out = py(`
r = {}
c = Cards(item_hold_ms=8000, pending_hold_ms=60000, hide_distance_px=220, whisper_hold_ms=20000, max_whispers=3)
for i, k in enumerate(['w1', 'w2', 'w3', 'w4']):
    c.whisper(k, {}, i * 10)
r['over'] = c.tick(50, (0, 0))
r['order'] = c.visible_whispers()
r['early'] = c.tick(20010, (0, 0))
r['late'] = c.tick(20030, (0, 0))
c.whisper('w5', {}, 30000)
c.forget('w5')
r['forgot'] = c.visible_whispers()
print(json.dumps(r))
`)
  assert.deepEqual(out.over, ['w1'], 'a fourth whisper with max 3 hides the oldest')
  assert.deepEqual(out.order, ['w4', 'w3', 'w2'])
  assert.deepEqual(out.early, ['w2'])
  assert.deepEqual(out.late, ['w3', 'w4'])
  assert.deepEqual(out.forgot, [])
})

test('the stash cell frame stays its own hold time, and a new one replaces it', () => {
  const out = py(`
r = {}
c = Cards(item_hold_ms=8000, pending_hold_ms=60000, hide_distance_px=220, whisper_hold_ms=20000, max_whispers=3)
c.item('item:a', {'final': True}, 0, (0, 0))
c.frame('frame', 0, 3000)
r['early'] = c.tick(2999, (0, 0))
c.frame('frame', 2000, 3000)          # the next press: the hold starts again
r['renewed'] = c.tick(4000, (0, 0))
r['gone'] = c.tick(5000, (0, 0))
r['after'] = c.tick(9000, (0, 0))
c.frame('frame', 10000, 3000)
c.forget('frame')
r['forgot'] = c.tick(20000, (0, 0))
print(json.dumps(r))
`)
  assert.deepEqual(out.early, [])
  assert.deepEqual(out.renewed, [])
  assert.deepEqual(out.gone, ['frame'])
  assert.deepEqual(out.after, ['item:a'], 'the frame does not touch the item card')
  assert.deepEqual(out.forgot, [], 'a frame the daemon hid is not hidden twice')
})

test('the value grid stays its own hold time, apart from the frame and the cards', () => {
  const out = py(`
r = {}
c = Cards(item_hold_ms=8000, pending_hold_ms=60000, hide_distance_px=220, whisper_hold_ms=20000, max_whispers=3)
c.frame('frame', 0, 3000)
c.grid('grid', 0, 20000)
r['frame_only'] = c.tick(3000, (0, 0))
c.grid('grid', 10000, 20000)          # the next press: the hold starts again
r['renewed'] = c.tick(25000, (0, 0))
r['gone'] = c.tick(30000, (0, 0))
c.grid('grid', 40000, 20000)
c.forget('grid')
r['forgot'] = c.tick(70000, (0, 0))
print(json.dumps(r))
`)
  assert.deepEqual(out.frame_only, ['frame'])
  assert.deepEqual(out.renewed, [])
  assert.deepEqual(out.gone, ['grid'])
  assert.deepEqual(out.forgot, [], 'a grid the daemon hid is not hidden twice')
})

test('value grid cells are taken in the grid\'s own pixels with their uncertain flag; a cell off the grid or malformed is dropped', () => {
  const out = py(`
grid = (15, 125, 634, 634)
cells = [{'x': 121, 'y': 178, 'w': 52, 'h': 78, 'label': '5d?', 'u': True}, {'x': 15, 'y': 125, 'w': 26, 'h': 26, 'label': '12c'},
         {'x': 640, 'y': 125, 'w': 26, 'h': 26, 'label': 'off'}, {'x': 15, 'y': 125, 'w': 0, 'h': 26, 'label': 'flat'},
         {'x': 'a', 'y': 1, 'w': 1, 'h': 1, 'label': 'x'}, {'x': 15, 'y': 125, 'w': 26, 'h': 26, 'label': 7},
         {'x': 41, 'y': 125, 'w': 26, 'h': 26, 'label': '3c', 'u': 'yes'}, 'junk']
print(json.dumps({'cells': grid_cells(grid, cells), 'many': len(grid_cells(grid, [cells[1]] * 900)),
                  'font12': grid_font_px([(0, 0, 53, 53, '', False)], 634), 'font24': grid_font_px([(0, 0, 26, 26, '', False)], 634),
                  'font_big': grid_font_px([(0, 0, 106, 159, '', True)], 634), 'font_none': grid_font_px([], 634)}))
`)
  assert.deepEqual(out.cells, [[106, 53, 52, 78, '5d?', true], [0, 0, 26, 26, '12c', false], [0, 0, 26, 26, '7', false],
    [26, 0, 26, 26, '3c', false]], 'u passes as the 6th element, true only for u: true')
  assert.equal(out.many, 600, 'at most as many cells as the server sends')
  assert.ok(out.font24 < out.font12, `a 24x24 grid gets the smaller font (${out.font24} < ${out.font12})`)
  assert.ok(out.font24 >= 7, 'never below 7 px')
  assert.equal(out.font_big, out.font12, 'a large item does not get a larger font than a 1x1 cell would')
  assert.equal(out.font_none, out.font12, 'no cell: the 12x12 cell size')
})
