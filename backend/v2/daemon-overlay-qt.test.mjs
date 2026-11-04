// daemon/ppt_overlay.py — the click-through card over the game, as the process
// the daemon starts. Here it runs on Qt's 'offscreen' platform only
// (PPT_OVERLAY_PLATFORM): no window ever opens on the display of the machine
// running the tests, and DISPLAY and WAYLAND_DISPLAY are removed from the
// child's environment so nothing could connect to it by mistake.
//
// Needs PySide6. Without it the Qt tests are skipped ('no PySide6 on this
// machine'); the import failure itself (exit 3) is tested either way, with a
// stub PySide6 on PYTHONPATH.
//
// Why this lives here: `npm test` covers only backend/v2 (same reason as
// daemon-diag.test.mjs).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')
const OVERLAY = path.join(DAEMON_DIR, 'ppt_overlay.py')

const HAS_QT = spawnSync('python3', ['-c', 'import PySide6'], { encoding: 'utf8' }).status === 0
const NO_QT = HAS_QT ? false : 'no PySide6 on this machine'

/** The parent's environment without anything that points at a real display. */
function cleanEnv (extra = {}) {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'PPT_OVERLAY_PLATFORM', 'QT_QPA_PLATFORM']) delete env[k]
  return { ...env, ...extra }
}

/** Start the overlay; lines() resolves with the next stdout line as JSON. */
function startOverlay (args, env) {
  const child = spawn('python3', [OVERLAY, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  let err = ''
  const queue = []
  const waiting = []
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (waiting.length) waiting.shift()(msg)
      else queue.push(msg)
    }
  })
  child.stderr.on('data', d => { err += d })
  const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })))
  const next = (ms = 8000) => new Promise((resolve, reject) => {
    if (queue.length) { resolve(queue.shift()); return }
    const t = setTimeout(() => reject(new Error(`no line within ${ms} ms; stderr: ${err}`)), ms)
    waiting.push(msg => { clearTimeout(t); resolve(msg) })
  })
  const send = obj => child.stdin.write(JSON.stringify(obj) + '\n')
  return { child, next, send, exited, stderr: () => err }
}

test('the overlay process runs offscreen, answers and ends with stdin', { skip: NO_QT }, async () => {
  // The session's QT_QPA_PLATFORM=wayland must be overwritten: only the
  // platform the daemon names counts.
  const o = startOverlay([], cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen', QT_QPA_PLATFORM: 'wayland' }))
  try {
    const hello = await o.next()
    assert.equal(hello.type, 'hello')
    assert.equal(hello.binding, 'PySide6')
    assert.equal(hello.platform, 'offscreen')
    assert.ok(hello.screens >= 1)
    o.send({ cmd: 'style', font_pt: 12, opacity: 0.9, max_width_px: 400 })
    o.send({ cmd: 'item', key: 'item:a', title: 'Mageblood', lines: [['Mageblood', 'name'], ['140 div (125–170)', 'price'], ['259 listings', 'muted']], final: true })
    const shown = await o.next()
    assert.equal(shown.type, 'shown')
    assert.equal(shown.key, 'item:a')
    assert.ok(Number.isInteger(shown.x) && Number.isInteger(shown.y), JSON.stringify(shown))
    o.send({ cmd: 'whisper', key: 'whisper:1', title: 'Whisper', lines: [['<b>buyer</b> & co', 'name']] })
    const w = await o.next()
    assert.equal(w.type, 'shown')
    assert.equal(w.key, 'whisper:1')
    o.child.stdin.write('this is not json\n')
    const bad = await o.next()
    assert.equal(bad.type, 'error')
    o.send({ cmd: 'hide', key: 'item:a' })
    assert.deepEqual(await o.next(), { type: 'hidden', key: 'item:a' })
    o.send({ cmd: 'hide', key: 'item:a' })
    o.send({ cmd: 'ping', n: 7 })
    assert.deepEqual(await o.next(), { type: 'pong', n: 7 }, 'a card hidden already says nothing')
    const t0 = Date.now()
    o.child.stdin.end()
    const { code } = await o.exited
    assert.equal(code, 0, o.stderr())
    assert.ok(Date.now() - t0 < 3000, 'ends within 3 s of the end of stdin')
  } finally {
    o.child.kill()
  }
})

test('an overlay whose stdin is already closed at start ends at once', { skip: NO_QT }, () => {
  // The daemon died before the overlay came up: no window may stay behind.
  const r = spawnSync('python3', [OVERLAY], {
    input: '{"cmd":"ping","n":1}\n', encoding: 'utf8', env: cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }), timeout: 20000
  })
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines[0].type, 'hello')
  assert.deepEqual(lines[1], { type: 'pong', n: 1 })
})

test('--probe reports the binding, the platform and the window flags, without showing a window', { skip: NO_QT }, () => {
  const r = spawnSync('python3', [OVERLAY, '--probe'], {
    encoding: 'utf8', env: cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }), timeout: 20000
  })
  assert.equal(r.status, 0, r.stderr)
  const hello = JSON.parse(r.stdout.trim().split('\n')[0])
  assert.equal(hello.type, 'hello')
  assert.equal(hello.platform, 'offscreen')
  for (const flag of ['FramelessWindowHint', 'WindowStaysOnTopHint', 'X11BypassWindowManagerHint',
    'WindowTransparentForInput', 'WindowDoesNotAcceptFocus', 'Tool']) {
    assert.ok(hello.flags.includes(flag), `${flag} in ${hello.flags}`)
  }
  assert.ok(hello.attrs.includes('WA_TranslucentBackground'))
  assert.ok(hello.attrs.includes('WA_ShowWithoutActivating'))
  // The stash cell frame lies over the stash the player clicks in: it
  // has to let every click through as the cards do.
  assert.deepEqual(hello.frame_flags, hello.flags)
  assert.deepEqual(hello.frame_attrs, hello.attrs)
  // So does the value grid, which covers the whole tab.
  assert.deepEqual(hello.grid_flags, hello.flags)
  assert.deepEqual(hello.grid_attrs, hello.attrs)
})

test('a frame command puts the stash cell frame at the cell it names', { skip: NO_QT }, async () => {
  const o = startOverlay([], cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }))
  try {
    assert.equal((await o.next()).type, 'hello')
    o.send({ cmd: 'frame', key: 'frame', x: 226, y: 231, w: 53, h: 53, label: '1/2 buyer 1 · tab "Sale" · left 5, top 3', hold_ms: 20000 })
    assert.deepEqual(await o.next(), { type: 'shown', key: 'frame', x: 226, y: 231 })
    o.send({ cmd: 'frame', key: 'frame', x: 358, y: 627, w: 26, h: 26, label: '<b>x</b>', hold_ms: 20000 })
    assert.deepEqual(await o.next(), { type: 'shown', key: 'frame', x: 358, y: 627 }, 'the next press moves the same frame')
    o.send({ cmd: 'frame', key: 'frame', x: 'a', y: 1, w: 1, h: 1 })
    const bad = await o.next()
    assert.equal(bad.type, 'error')
    assert.match(bad.message, /frame needs whole numbers x, y and w, h above 0/)
    o.send({ cmd: 'hide', key: 'frame' })
    assert.deepEqual(await o.next(), { type: 'hidden', key: 'frame' }, 'the daemon hides it (focus lost)')
    o.send({ cmd: 'ping', n: 3 })
    assert.deepEqual(await o.next(), { type: 'pong', n: 3 })
    o.child.stdin.end()
    assert.equal((await o.exited).code, 0, o.stderr())
  } finally {
    o.child.kill()
  }
})

test('the stash cell frame leaves by itself after its hold_ms, whatever its key', { skip: NO_QT }, async () => {
  // A frame left standing over the stash would cover the cells the player
  // clicks next; the overlay's own tick has to take it away.
  const o = startOverlay([], cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }))
  try {
    assert.equal((await o.next()).type, 'hello')
    for (const key of ['frame', 'frame:b']) {
      const t0 = Date.now()
      o.send({ cmd: 'frame', key, x: 15, y: 125, w: 53, h: 53, label: 'L', hold_ms: 300 })
      assert.deepEqual(await o.next(), { type: 'shown', key, x: 15, y: 125 })
      assert.deepEqual(await o.next(4000), { type: 'hidden', key }, `the frame ${key} leaves`)
      assert.ok(Date.now() - t0 >= 250, 'not before its hold time')
    }
    o.send({ cmd: 'frame', key: 'frame:c', x: 15, y: 125, w: 53, h: 53, hold_ms: 20000 })
    assert.equal((await o.next()).type, 'shown')
    o.send({ cmd: 'hide', key: 'frame:c' })
    assert.deepEqual(await o.next(), { type: 'hidden', key: 'frame:c' }, 'hidden by the key it was shown with')
    o.child.stdin.end()
    assert.equal((await o.exited).code, 0, o.stderr())
  } finally {
    o.child.kill()
  }
})

test('--frame shows the self-test frame at the rectangle it is given, then ends', { skip: NO_QT }, () => {
  const r = spawnSync('python3', [OVERLAY, '--frame', '15,125,53,53'], {
    encoding: 'utf8', env: cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }), timeout: 20000
  })
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines[0].type, 'hello')
  assert.deepEqual(lines[1], { type: 'shown', key: 'frame', x: 15, y: 125 })
  const bad = spawnSync('python3', [OVERLAY, '--frame', '15,125'], {
    encoding: 'utf8', env: cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }), timeout: 20000
  })
  assert.equal(bad.status, 5)
  assert.match(bad.stderr, /--frame needs x,y,w,h/)
})

test('a grid command paints one rectangle per cell over the grid, and goes with hide', { skip: NO_QT }, async () => {
  const o = startOverlay([], cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }))
  try {
    assert.equal((await o.next()).type, 'hello')
    const cells = [{ x: 121, y: 178, w: 52, h: 78, label: '5d' }, { x: 15, y: 125, w: 26, h: 26, label: '12c' },
      { x: 41, y: 125, w: 26, h: 26, label: 'a label far too long for one cell' }, { x: 900, y: 125, w: 26, h: 26, label: 'off' }]
    o.send({ cmd: 'grid', key: 'grid', x: 15, y: 125, w: 634, h: 634, cells, label: '1/3 tab "<b>Dump</b>" · 3 items from 5c', hold_ms: 20000 })
    assert.deepEqual(await o.next(), { type: 'shown', key: 'grid', x: 15, y: 125, cells: 3 }, 'the cell off the grid is not drawn')
    o.send({ cmd: 'grid', key: 'grid', x: 15, y: 125, w: 634, h: 634, cells: [], label: '2/3 tab "Sale" · nothing from 5c', hold_ms: 20000 })
    assert.deepEqual(await o.next(), { type: 'shown', key: 'grid', x: 15, y: 125, cells: 0 }, 'the next press redraws the same window')
    o.send({ cmd: 'grid', key: 'grid', x: 15, y: 125, w: 0, h: 634, cells: [] })
    const bad = await o.next()
    assert.equal(bad.type, 'error')
    assert.match(bad.message, /grid needs whole numbers x, y and w, h above 0/)
    o.send({ cmd: 'hide', key: 'grid' })
    assert.deepEqual(await o.next(), { type: 'hidden', key: 'grid' })
    o.send({ cmd: 'grid', key: 'grid', x: 15, y: 125, w: 634, h: 634, cells, hold_ms: 300 })
    assert.equal((await o.next()).cells, 3)
    assert.deepEqual(await o.next(4000), { type: 'hidden', key: 'grid' }, 'it leaves by itself after its hold_ms')
    o.child.stdin.end()
    assert.equal((await o.exited).code, 0, o.stderr())
  } finally {
    o.child.kill()
  }
})

test('--grid shows the self-test value grid with 3 cells over the rectangle it is given, then ends', { skip: NO_QT }, () => {
  const r = spawnSync('python3', [OVERLAY, '--grid', '15,125,634,634'], {
    encoding: 'utf8', env: cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }), timeout: 20000
  })
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines[0].type, 'hello')
  assert.deepEqual(lines[1], { type: 'shown', key: 'grid', x: 15, y: 125, cells: 3 })
  const bad = spawnSync('python3', [OVERLAY, '--grid', '15,125,0,634'], {
    encoding: 'utf8', env: cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }), timeout: 20000
  })
  assert.equal(bad.status, 5)
  assert.match(bad.stderr, /--grid needs x,y,w,h/)
})

test('the self-test value grid marks one of its 3 cells uncertain, with a ? and a dashed border', { skip: NO_QT }, () => {
  const out = borderRows(`
msg = ppt_overlay.demo_grid((15, 125, 634, 634))
print(json.dumps({'labels': [[c['label'], c.get('u')] for c in msg['cells']], 'rows': border(msg, msg['cells'])}))
`)
  assert.deepEqual(out.labels, [['12c', null], ['1.5d?', true], ['240c', null]])
  const [plain, marked, tall] = out.rows
  assert.deepEqual([plain[0], plain[2], tall[2]], [plain[1], 0, 0], 'the plain sample cells: solid')
  assert.ok(marked[2] >= 4, `the marked sample cell: dashed (${marked[2]} gaps)`)
})

test('a grid command with an uncertain cell paints it and goes with hide', { skip: NO_QT }, async () => {
  const o = startOverlay([], cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }))
  try {
    assert.equal((await o.next()).type, 'hello')
    const cells = [{ x: 121, y: 178, w: 52, h: 78, label: '5d?', u: true }, { x: 15, y: 125, w: 26, h: 26, label: '12c' },
      { x: 41, y: 125, w: 26, h: 26, label: '3c', u: 'yes' }]
    o.send({ cmd: 'grid', key: 'grid', x: 15, y: 125, w: 634, h: 634, cells, label: '1/3 tab "Dump" · 3 items from 5c · 1 uncertain', hold_ms: 20000 })
    assert.deepEqual(await o.next(), { type: 'shown', key: 'grid', x: 15, y: 125, cells: 3 })
    o.send({ cmd: 'hide', key: 'grid' })
    assert.deepEqual(await o.next(), { type: 'hidden', key: 'grid' })
    o.child.stdin.end()
    assert.equal((await o.exited).code, 0, o.stderr())
  } finally {
    o.child.kill()
  }
})

// The border of an uncertain cell is dashed: drawn in the overlay's own
// process (offscreen), the top edge of such a cell has gaps the solid border
// of a plain cell of the same size has not. Counted in border-coloured pixels
// along the edge ([hits, pixels, gaps]: a gap is a run of other pixels), so
// the window's background does not matter.
const BORDER_ROWS = `
import json, os, sys
os.environ['PPT_OVERLAY_PLATFORM'] = 'offscreen'
sys.path.insert(0, sys.argv[1])
import ppt_overlay
from PySide6 import QtCore, QtGui, QtWidgets
app = QtWidgets.QApplication(['test'])
overlay = ppt_overlay.Overlay(QtCore, QtGui, QtWidgets, app, lambda obj: None)
tone = ppt_overlay.TONES[ppt_overlay.GRID_TONE]
def border(msg, cells):
    overlay.grid(msg)
    win = overlay.grid_win
    img = win.grab().toImage()
    dpr = img.devicePixelRatio()
    out = []
    for c in cells:
        rx, ry, cw = c['x'] - msg['x'], c['y'] - msg['y'], c['w']
        row = int((ry + 1) * dpr)
        hits = gaps = 0
        was = True
        span = range(int((rx + 4) * dpr), int((rx + cw - 4) * dpr))
        for px in span:
            col = img.pixelColor(px, row)
            hit = all(abs(a - b) <= 40 for a, b in zip((col.red(), col.green(), col.blue()), tone)) and col.alpha() > 128
            hits += hit
            gaps += was and not hit
            was = hit
        out.append([hits, len(span), gaps])
    return out
`

function borderRows (code) {
  const r = spawnSync('python3', ['-c', BORDER_ROWS + code, DAEMON_DIR], {
    encoding: 'utf8', env: cleanEnv(), timeout: 20000
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').at(-1))
}

test('an uncertain cell\'s border is dashed, a plain one\'s solid, in the same colour', { skip: NO_QT }, () => {
  const out = borderRows(`
cells = [{'x': 15, 'y': 125, 'w': 106, 'h': 106, 'label': '5d'}, {'x': 121, 'y': 125, 'w': 106, 'h': 106, 'label': '5d?', 'u': True}]
print(json.dumps(border({'key': 'grid', 'x': 15, 'y': 125, 'w': 634, 'h': 634, 'cells': cells, 'hold_ms': 20000}, cells)))
`)
  const [[solid, n, solidGaps], [dashed, m, gaps]] = out
  assert.deepEqual([solid, solidGaps], [n, 0], `the plain border is solid (${solid} of ${n})`)
  assert.ok(gaps >= 4, `the uncertain border has gaps (${gaps})`)
  assert.ok(dashed > m / 2, `…and is mostly drawn, in the border colour (${dashed} of ${m})`)
})

// On a quad tab a 1x1 cell is about 26 px wide: a '?' that does not fit
// beside the value is dropped whole, and the value is cut as it would be
// without it; the dashed border carries the mark then. A '?' that fits stays.
test('an uncertain value too long for its cell loses its ? before any digit or unit', { skip: NO_QT }, () => {
  const out = borderRows(`
from ppt_value_grid import span_rect
frame = (15, 125, 634, 634)
def at(left, size, label, u):
    x, y, w, h = span_rect(frame, left, 1, size, size, True)
    c = {'x': x, 'y': y, 'w': w, 'h': h, 'label': label}
    if u:
        c['u'] = True
    return c
cells = [at(1, 1, '12.5d', False), at(3, 1, '12.5d?', True), at(5, 1, '12c?', True), at(7, 2, '12.5d?', True)]
overlay.grid({'key': 'grid', 'x': 15, 'y': 125, 'w': 634, 'h': 634, 'cells': cells, 'hold_ms': 20000})
print(json.dumps([[c[2], c[4], c[5]] for c in overlay.grid_win.cells]))
`)
  const [[pw, plain], [uw, cut, u1], [, short, u2], [, wide, u3]] = out
  assert.equal(uw, pw, 'the plain and the uncertain 1x1 cell are equally wide')
  assert.equal(cut, plain, `the value without its ? reads as it would on a certain item (${cut} vs ${plain})`)
  assert.equal(short, '12c?', 'a ? that fits stays')
  assert.equal(wide, '12.5d?', 'a 2x2 cell keeps the whole text')
  assert.deepEqual([u1, u2, u3], [true, true, true], 'all three keep their mark for the dashed border')
})

// The tab line is cut at its end when it is wider than the grid (or
// max_width_px): with a long tab name over the grid of a 1920x1080 window
// the tab total goes first, and the count of uncertain items, which comes
// before it, is still whole.
test('the tab line keeps its uncertain count with a long tab name on a 1920x1080 grid', { skip: NO_QT }, () => {
  const out = borderRows(`
name = 'Currency and fragments dump'
label = f'1/12 tab "{name}" · 140 items from 5c · 13 uncertain · tab total 54.3d'
overlay.grid({'key': 'grid', 'x': 15, 'y': 125, 'w': 634, 'h': 634, 'cells': [], 'label': label, 'hold_ms': 20000})
print(json.dumps(overlay.grid_win.label))
`)
  assert.match(out, / · 13 uncertain/, out)
  assert.ok(out.endsWith('…'), `the line is cut, at the total (${out})`)
})

test('--session shows a sample session card where whisper cards stack, then ends', { skip: NO_QT }, () => {
  const r = spawnSync('python3', [OVERLAY, '--session'], {
    encoding: 'utf8', env: cleanEnv({ PPT_OVERLAY_PLATFORM: 'offscreen' }), timeout: 20000
  })
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines[0].type, 'hello')
  assert.equal(lines[1].type, 'shown')
  assert.equal(lines[1].key, 'session', 'the daemon\'s own session card, under its own key')
})

test('on xcb without DISPLAY the overlay exits 4 at once, before Qt tries to connect', { skip: NO_QT }, () => {
  const r = spawnSync('python3', [OVERLAY, '--probe'], { encoding: 'utf8', env: cleanEnv(), timeout: 20000 })
  assert.equal(r.status, 4, r.stderr)
  assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr)
  assert.match(r.stderr, /DISPLAY/)
  assert.equal(r.stdout, '')
})

test('without PySide6 the overlay exits 3 with one line', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-noqt-'))
  try {
    mkdirSync(path.join(root, 'PySide6'))
    writeFileSync(path.join(root, 'PySide6', '__init__.py'), 'raise ImportError("libQt6Core.so.6: cannot open shared object file")\n')
    const r = spawnSync('python3', [OVERLAY, '--probe'], {
      encoding: 'utf8', env: cleanEnv({ PYTHONPATH: root, PPT_OVERLAY_PLATFORM: 'offscreen' }), timeout: 20000
    })
    assert.equal(r.status, 3, r.stderr)
    const lines = r.stderr.trim().split('\n')
    assert.equal(lines.length, 1, r.stderr)
    assert.match(lines[0], /PySide6.*libQt6Core/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
