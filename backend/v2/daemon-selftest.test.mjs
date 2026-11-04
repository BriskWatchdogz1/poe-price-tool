// daemon/selftest.sh — the diagnosis a stranger runs when nothing works.
//
// Why this lives here: `npm test` covers only backend/v2, so a test
// outside this directory would never run (same reason as
// daemon-post-filter.test.mjs). The script is bash; we run it the way a user
// would, but with the environment nailed down.
//
// Nailed down means: PATH points at a directory holding ONLY the tools a
// scenario is supposed to have — that is the only honest way to test "xsel is
// missing" on a machine where xsel is installed. HOME/XDG_CONFIG_HOME point at
// a temp dir, so the config under test is the one we wrote and never the one
// the developer happens to have. The backend is a real HTTP server on a
// throwaway port that answers exactly what server.mjs answers (200/400/503),
// so the classification is tested against the real shapes.
//
// What the three required properties are, and what they look like without the
// script: a missing tool would be discovered by the user as "it doesn't work";
// a prefix that does not match the client language would be indistinguishable
// from an unreachable backend (both = no card, no message, nothing in a log);
// and macro tools would be demanded from someone who configured no macros.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, utimesSync, lstatSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon')
const SCRIPT = path.join(DAEMON_DIR, 'selftest.sh')

// Everything the script (and poe-price-post.sh) shells out to no matter what.
// Anything NOT in here plus the scenario's `tools` is genuinely absent.
const BASE_TOOLS = [
  'bash', 'readlink', 'dirname', 'basename', 'sed', 'mktemp', 'rm', 'id',
  'timeout', 'python3', 'head', 'wc', 'cut', 'grep', 'cat', 'chmod', 'mkdir'
]
const ALL_CLIENT_TOOLS = ['curl', 'xsel', 'wl-paste', 'ydotool', 'xdotool', 'xprop']

const which = cmd => execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim()

// python3 in every scenario PATH is this wrapper: the real python3 for
// everything (the config read, poe-price-post.sh's helpers), except
// ppt_overlay.py, which is never run here. The wrapper records how it was
// called (QT_QPA_PLATFORM and the arguments) into overlay.calls and answers
// like the overlay would, as STUB_OVERLAY says: ok (a hello on xcb), noqt
// (exit 3), nodisplay (exit 4), wayland (a hello on another platform).
// Section 10 therefore never imports Qt and never touches a display.
// It also answers section 1's `python3 -c 'import evdev'`, as STUB_EVDEV says
// (present unless it is 'missing'): left to the real python3, the answer was
// the machine's, and on one without python-evdev (a CI runner) every scenario
// that expects a healthy install failed.
const OVERLAY_PY_STUB = `#!/usr/bin/env bash
if [ "\${1:-}" = -c ] && [ "\${2:-}" = 'import evdev' ]; then
  [ "\${STUB_EVDEV:-present}" = missing ] && exit 1
  exit 0
fi
case "\${1:-}" in
  */ppt_overlay.py)
    printf '%s %s\\n' "QT_QPA_PLATFORM=\${QT_QPA_PLATFORM:-}" "\${2:-}" >>"$HOME/overlay.calls"
    case "\${STUB_OVERLAY:-ok}" in
      noqt) echo 'ppt_overlay: PySide6 cannot be imported (ImportError: libQt6Core.so.6)' >&2; exit 3 ;;
      nodisplay) echo 'ppt_overlay: the X server at DISPLAY=:99 does not take a connection (xcb error 1)' >&2; exit 4 ;;
      wayland) echo '{"type":"hello","binding":"PySide6","qt":"6.12.0","platform":"wayland","screens":1}'; exit 0 ;;
      *) [ "\${2:-}" = --probe ] && echo '{"type":"hello","binding":"PySide6","qt":"6.12.0","platform":"xcb","screens":1}'; exit 0 ;;
    esac ;;
esac
exec ${which('python3')} "$@"
`

// xdotool in every scenario PATH that has it is this stub unless a test gives
// its own: a clean miss (exit 1, no output), so section 12 never runs the real
// xdotool against whatever display the machine running the tests has.
const XDOTOOL_MISS = '#!/usr/bin/env bash\nexit 1\n'

// Tools a scenario PATH links from the machine: the base set, curl (the online
// scenarios talk to the mock backend below through it) and sh (the systemd-run
// stub execs it). Every other tool a scenario names (xsel, wl-paste, ydotool,
// xdotool, xprop) is a stand-in that is merely THERE and fails like a tool
// that cannot reach a display. The self-test only asks for those by
// `command -v`, unless a scenario sets DISPLAY, and a scenario that needs a
// working one writes its own stub. Linking the real ones made the suite depend
// on the machine: on one without xsel (a CI runner) 17 tests failed, because
// the link was silently skipped and the scenario lost a tool it was meant to
// have.
const LINKED_TOOLS = new Set([...BASE_TOOLS, 'curl', 'sh'])
const standIn = name =>
  `#!/usr/bin/env bash\n# ${name}: test stand-in, present but without a display\necho "${name}: cannot open display (test stand-in)" >&2\nexit 1\n`

/** A PATH containing exactly `tools` (plus the base set) and nothing else. */
function makeBin (root, tools) {
  const bin = path.join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const cmd of [...BASE_TOOLS, ...tools]) {
    const dest = path.join(bin, cmd)
    if (existsSync(dest)) continue
    // python3 is always the wrapper above, in every scenario that builds a
    // PATH, so the evdev answer is never the machine's.
    if (cmd === 'python3') writeFileSync(dest, OVERLAY_PY_STUB, { mode: 0o755 })
    // which() throws when a linked tool is missing: a machine without curl
    // cannot run these scenarios, and has to say so rather than lose the tool.
    else if (LINKED_TOOLS.has(cmd)) symlinkSync(which(cmd), dest)
    else writeFileSync(dest, standIn(cmd), { mode: 0o755 })
  }
  return bin
}

const CONFIG_MACROS = `
backend_url = "%URL%"
user = "%USER%"
item_prefixes = %PREFIXES%
poe_window_class = "steam_app_238960"

[macros]
keyboard_layout = "us"
[macros.keys]
F5 = "/hideout"
`

const CONFIG_NO_MACROS = `
backend_url = "%URL%"
user = "%USER%"
item_prefixes = %PREFIXES%
poe_window_class = "steam_app_238960"
`

/** spawn + collect, as a promise. NOT spawnSync: the mock backend below lives
 * in this very process, so a blocking child would deadlock against a server
 * that can only answer while the event loop turns. */
function collect (cmd, args, opts) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, opts)
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('close', status => resolve({ status, out }))
  })
}

/**
 * Run selftest.sh in a controlled world.
 * Returns { status, out } with stdout+stderr joined (no colours: not a tty).
 */
async function runSelftest ({
  tools = ALL_CLIENT_TOOLS,
  args = ['--offline'],
  url = 'http://127.0.0.1:1',
  user = 'player1',
  prefixes = ['Item Class: '],
  macros = true,
  extra = '', // appended to config.toml (its own tables)
  env = {},   // merged into the environment; a value may contain %ROOT%
  stubs = {}, // tool name -> script body, written over whatever makeBin linked
  files = {}, // path below the temp HOME -> content (a value may contain %ROOT%)
  ages = {}   // path below the temp HOME (one of files) -> its age in seconds (mtime)
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-selftest-'))
  try {
    const bin = makeBin(root, tools)
    const xdotool = tools.includes('xdotool') ? { xdotool: XDOTOOL_MISS } : {}
    for (const [name, body] of Object.entries({ ...xdotool, ...stubs })) {
      const p = path.join(bin, name)
      rmSync(p, { force: true })
      writeFileSync(p, body, { mode: 0o755 })
    }
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(root, rel)
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(p, content.replaceAll('%ROOT%', root))
    }
    for (const [rel, age] of Object.entries(ages)) {
      const t = Date.now() / 1000 - age
      utimesSync(path.join(root, rel), t, t)
    }
    const cfgDir = path.join(root, 'config/poe-price-daemon')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(path.join(cfgDir, 'config.toml'), (macros ? CONFIG_MACROS : CONFIG_NO_MACROS)
      .replace('%URL%', url)
      .replace('%USER%', user)
      .replace('%PREFIXES%', JSON.stringify(prefixes)) + (extra ? `\n${extra.replaceAll('%ROOT%', root)}\n` : ''))
    const r = await collect('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: bin,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, 'config'),
        TMPDIR: root,
        LANG: 'C.UTF-8',
        ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v).replace('%ROOT%', root)]))
      }
    })
    let overlayCalls = []
    try {
      overlayCalls = readFileSync(path.join(root, 'overlay.calls'), 'utf8').trim().split('\n').filter(Boolean)
    } catch { /* not called */ }
    return { ...r, overlayCalls }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The line carrying `needle`, or '' — so assertions can talk about verdicts. */
const lineWith = (out, needle) => out.split('\n').find(l => l.includes(needle)) || ''

test('a scenario PATH holds stand-ins for the optional tools, never the machine\'s own', () => {
  // The suite has to give the same answers on a machine where none of these
  // is installed (a CI runner) as on one where all of them are: the self-test
  // only asks whether they are there, unless a scenario sets DISPLAY, and then
  // it gets a tool that cannot reach a display rather than the real one.
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-selftest-bin-'))
  try {
    const bin = makeBin(root, ALL_CLIENT_TOOLS)
    for (const tool of ALL_CLIENT_TOOLS.filter(t => t !== 'curl')) {
      const p = path.join(bin, tool)
      assert.equal(lstatSync(p).isSymbolicLink(), false, `${tool} is linked from the host`)
      assert.match(readFileSync(p, 'utf8'), /test stand-in/, tool)
      const r = spawnSync(p, [], { encoding: 'utf8', env: { PATH: bin, DISPLAY: ':99' } })
      assert.equal(r.status, 1, `${tool} has to fail like a tool without a display`)
    }
    assert.equal(lstatSync(path.join(bin, 'curl')).isSymbolicLink(), true,
      'curl is real: the online scenarios talk to the mock backend through it')
    assert.equal(readFileSync(path.join(bin, 'python3'), 'utf8'), OVERLAY_PY_STUB,
      'python3 is the wrapper that answers the evdev import, never the bare interpreter')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A backend that answers /health, /users and POST /item like server.mjs does. */
// grid: what GET /daemon/stash-grid answers ({ code, body }); without it the 404 below.
async function withBackend ({ users = ['player1'], langs = { player1: 'en' }, item = { code: 200, body: '{"id":"x","user":"player1"}' }, events = null, grid = null, seen = null }, fn) {
  const server = createServer((req, res) => {
    const p = req.url.split('?')[0]
    if (req.method === 'GET' && p === '/health') { res.writeHead(200).end('ok'); return }
    // GET /daemon/events: a server new enough answers `events`; without it the
    // 404 below, as an older server does.
    if (seen) seen.push({ method: req.method, url: req.url, headers: req.headers })
    if (events && req.method === 'GET' && p === '/daemon/events') {
      res.writeHead(events.code, { 'content-type': 'application/json' }).end(events.body); return
    }
    if (grid && req.method === 'GET' && p === '/daemon/stash-grid') {
      res.writeHead(grid.code, { 'content-type': 'application/json' }).end(grid.body); return
    }
    if (req.method === 'GET' && p === '/users') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ users, langs })); return
    }
    if (req.method === 'POST' && p === '/item') {
      req.resume()
      req.on('end', () => res.writeHead(item.code, { 'content-type': 'application/json' }).end(item.body))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

// --- 1. a missing tool is named ----------------------------------------------

test('a missing tool is named, not left for the user to discover', async () => {
  const { status, out } = await runSelftest({ tools: ALL_CLIENT_TOOLS.filter(t => t !== 'xsel') })
  const line = lineWith(out, 'xsel')
  assert.match(line, /\[FAIL\]/, `xsel should be reported as a failure, got: ${line}`)
  assert.match(out, /XWayland/, 'and it says why xsel specifically matters')
  assert.equal(status, 1, 'a missing prerequisite makes the whole run fail')
})

test('the unconditional evdev import is checked even though it is a Python module', async () => {
  // The daemon imports evdev at module level: no evdev, no daemon, macros or
  // not. A tools check that only looked at binaries would miss it entirely.
  // The python3 wrapper answers the import (STUB_EVDEV), so both outcomes are
  // tested whether or not the machine running the tests has python-evdev.
  const { out } = await runSelftest()
  assert.match(lineWith(out, 'python evdev'), /\[ ok \]/)

  const missing = await runSelftest({ macros: false, env: { STUB_EVDEV: 'missing' } })
  assert.match(lineWith(missing.out, 'python evdev'), /\[FAIL\].*the daemon will not start, even with no macros/)
  assert.equal(missing.status, 1, 'no evdev is a broken install, macros or not')
})

test('--tools stops after the tool table (that is what install.sh gates on)', async () => {
  const { out } = await runSelftest({ args: ['--tools'] })
  assert.match(out, /1\. Tools/)
  assert.doesNotMatch(out, /7\. Test parse/, '--tools must not run the end-to-end part')
})

// --- 2. a wrong prefix is a prefix problem, not a connection problem ---------

test('a prefix that does not match the client language is named as such', async () => {
  // The failure this whole feature starts from: a German client with the
  // English default prefix. Every item dies in the daemon, nothing reaches the
  // backend, nothing is logged anywhere.
  await withBackend({ users: ['player1'], langs: { player1: 'de' } }, async url => {
    const { status, out } = await runSelftest({ url, args: [], prefixes: ['Item Class: '] })

    assert.match(lineWith(out, 'GET /health'), /\[ ok \]/, 'the backend IS reachable in this scenario')
    const filter = lineWith(out, '[FAIL] filter')
    assert.match(filter, /DROPPED/, `the filter verdict must be the failure, got: ${filter}`)
    assert.match(out, /prefix problem, not a backend problem/)
    assert.doesNotMatch(out, /cannot reach/, 'and it must not be reported as an unreachable backend')
    assert.equal(status, 1)
  })
})

test('the same setup with the matching prefix passes the filter and the parse', async () => {
  await withBackend({ users: ['player1'], langs: { player1: 'de' } }, async url => {
    const { out } = await runSelftest({ url, args: [], prefixes: ['Gegenstandsklasse: '] })
    assert.match(lineWith(out, 'sample'), /de \(the language the backend reads/)
    assert.match(lineWith(out, 'filter'), /\[ ok \]/)
    assert.match(lineWith(out, 'POST /item'), /\[ ok \]/)
  })
})

test('an unreachable backend is a backend verdict, with the filter still proven locally', async () => {
  // The mirror image of the test above: nothing is listening, but the filter
  // half runs anyway — so "no card in the browser" still gets one cause, not two.
  const { status, out } = await runSelftest({ url: 'http://127.0.0.1:1', args: [] })
  assert.match(lineWith(out, 'GET /health'), /\[FAIL\].*cannot reach/)
  assert.match(lineWith(out, 'filter'), /\[ ok \]/, 'the filter verdict is independent of the backend')
  assert.equal(status, 1)
})

test('an unknown user is told apart from a parse failure, both being 400', async () => {
  await withBackend({
    users: ['someone-else'],
    langs: { 'someone-else': 'en' },
    item: { code: 400, body: '{"error":"unknown user \\"player1\\"","users":["someone-else"]}' }
  }, async url => {
    const { out } = await runSelftest({ url, args: [] })
    assert.match(lineWith(out, '[FAIL] user "player1"'), /unknown to the backend/)
    assert.match(lineWith(out, 'POST /item'), /does not know the user/)
    assert.doesNotMatch(lineWith(out, 'POST /item'), /could not parse/)
  })
})

test('a configured language without a data set is named as the 503 it is', async () => {
  await withBackend({
    users: ['player1'],
    langs: { player1: 'de' },
    item: { code: 503, body: '{"error":"no parser for language \\"de\\"","user":"player1","lang":"de"}' }
  }, async url => {
    const { out } = await runSelftest({ url, args: [], prefixes: ['Gegenstandsklasse: '] })
    const line = lineWith(out, 'POST /item')
    assert.match(line, /language "de" is configured but has no data set/)
    assert.doesNotMatch(line, /could not parse/, 'a missing data set is not a parser bug')
  })
})

test('a real parse failure stays a parse failure and says the sample may be stale', async () => {
  await withBackend({
    users: ['player1'],
    langs: { player1: 'en' },
    item: { code: 400, body: '{"error":"item.parse_error"}' }
  }, async url => {
    const { out } = await runSelftest({ url, args: [] })
    assert.match(lineWith(out, 'POST /item'), /could not parse/)
    assert.match(out, /older than the game data/)
  })
})

// --- 3. no [macros] -> macro tools are not failures --------------------------

test('without a [macros] section the macro tools are not reported as failures', async () => {
  const { status, out } = await runSelftest({ macros: false, tools: ['curl', 'xsel', 'wl-paste'] })
  for (const tool of ['ydotool', 'xprop']) {
    const line = lineWith(out, tool)
    assert.match(line, /\[ -- \]/, `${tool} must be "not applicable", got: ${line}`)
  }
  // xdotool is also the game detection's tool ([presence], on by default): a
  // warning, never a failure.
  assert.match(lineWith(out, 'xdotool'), /\[warn\].*needed for game detection \(sync follows the game\)/)
  const off = await runSelftest({ macros: false, tools: ['curl', 'xsel', 'wl-paste'], extra: '[presence]\nreport_game = false' })
  assert.match(lineWith(off.out, 'xdotool'), /\[ -- \]/, 'with game detection off it is not applicable either')
  assert.match(lineWith(out, 'group input'), /\[ -- \]/, 'evdev opens no device without macros')
  assert.equal(status, 0, 'a price-check-only install with no macro tools is a healthy install')
})

test('the unit-environment check asks the service manager, and stays quiet when there is none', async () => {
  // Section 1 measures THIS shell; the daemon runs under systemd with a
  // different PATH. The check that closes that gap needs `systemd-run`, and the
  // sandbox here deliberately has neither it nor a user session. It must then
  // degrade to "not applicable" — never to a failure, and never to a silent
  // pass that would look like the environment had been verified.
  const { status, out } = await runSelftest({ macros: false, tools: ['curl', 'xsel', 'wl-paste'] })
  assert.doesNotMatch(out, /\[FAIL\][^\n]*unit sees/, 'a missing systemd-run is not the daemon\'s fault')
  assert.doesNotMatch(out, /\[ ok \][^\n]*unit sees/, 'it must not claim to have verified what it could not ask')
  assert.doesNotMatch(out, /\[FAIL\][^\n]*unit (DISPLAY|clipboard)/)
  assert.doesNotMatch(out, /\[ ok \][^\n]*unit clipboard/)
  assert.equal(status, 0, 'no service manager to ask is not a broken install')
})

// A service manager that is no service manager: `systemctl --user
// show-environment` prints DISPLAY only when STUB_UNIT_DISPLAY is set, and
// `systemd-run` runs its command right here with exactly that DISPLAY. With
// STUB_SHOW_ENV_FAIL set BOTH fail like a missing user bus, as they do for
// real; STUB_RUN_FAIL fails only systemd-run (a bus that answers
// show-environment but cannot start a unit); STUB_UNIT_PATH gives the unit's
// shell that PATH instead of this one. The xsel stub fails the way the real
// one does without a display.
const UNIT_STUBS = {
  systemctl: `#!/usr/bin/env bash
case "$*" in
  *show-environment*)
    if [ -n "\${STUB_SHOW_ENV_FAIL:-}" ]; then echo "Failed to connect to bus: No medium found" >&2; exit 1; fi
    echo "PATH=$PATH"; [ -n "\${STUB_UNIT_DISPLAY:-}" ] && echo "DISPLAY=$STUB_UNIT_DISPLAY"; exit 0 ;;
  *is-active*) echo active; exit 0 ;;
esac
exit 1
`,
  'systemd-run': `#!/usr/bin/env bash
if [ -n "\${STUB_SHOW_ENV_FAIL:-}\${STUB_RUN_FAIL:-}" ]; then echo "Failed to connect to bus: No medium found" >&2; exit 1; fi
while [ "$#" -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done
if [ -n "\${STUB_UNIT_PATH:-}" ] && [ "$1" = /usr/bin/env ] && [ "$2" = sh ]; then
  sh_bin="$(command -v sh)"; shift 2
  exec /usr/bin/env PATH="$STUB_UNIT_PATH" DISPLAY="\${STUB_UNIT_DISPLAY:-}" "$sh_bin" "$@"
fi
if [ -n "\${STUB_UNIT_DISPLAY:-}" ]; then exec /usr/bin/env DISPLAY="$STUB_UNIT_DISPLAY" "$@"; fi
exec /usr/bin/env -u DISPLAY "$@"
`,
  xsel: `#!/usr/bin/env bash
if [ -z "\${DISPLAY:-}" ]; then echo "xsel: Can't open display: (null)" >&2; exit 1; fi
echo clip
`
}

test('a service manager without DISPLAY is named, even when this shell has one', async () => {
  // Section 2 reads the clipboard in THIS shell, which has DISPLAY. The daemon
  // runs under the service manager; without DISPLAY there, every read fails.
  const { status, out } = await runSelftest({
    macros: false,
    tools: ['curl', 'xsel', 'wl-paste', 'sh'],
    stubs: UNIT_STUBS,
    env: { DISPLAY: ':0', XDG_RUNTIME_DIR: '%ROOT%/runtime' }
  })
  assert.match(lineWith(out, 'xsel -b -o'), /\[ ok \]/, 'this shell reads the clipboard fine')
  assert.match(lineWith(out, 'unit DISPLAY'), /\[FAIL\].*no DISPLAY/)
  assert.match(out, /import-environment DISPLAY XAUTHORITY/)
  assert.equal(status, 1)
})

test('with DISPLAY in the service manager the unit reads the clipboard', async () => {
  const { out } = await runSelftest({
    macros: false,
    tools: ['curl', 'xsel', 'wl-paste', 'sh'],
    stubs: UNIT_STUBS,
    env: { DISPLAY: ':0', XDG_RUNTIME_DIR: '%ROOT%/runtime', STUB_UNIT_DISPLAY: ':0' }
  })
  assert.match(lineWith(out, 'unit clipboard'), /\[ ok \].*DISPLAY=:0/)
  assert.doesNotMatch(out, /\[FAIL\][^\n]*unit DISPLAY/)
})

test('a service manager that cannot be asked is not reported as one without DISPLAY', async () => {
  // show-environment itself failing (no user bus, a timeout) says nothing
  // about DISPLAY; the import-environment advice would send the user nowhere.
  const { status, out } = await runSelftest({
    macros: false,
    tools: ['curl', 'xsel', 'wl-paste', 'sh'],
    stubs: UNIT_STUBS,
    env: { DISPLAY: ':0', XDG_RUNTIME_DIR: '%ROOT%/runtime', STUB_UNIT_DISPLAY: ':0', STUB_SHOW_ENV_FAIL: '1' }
  })
  assert.match(lineWith(out, 'unit environment'), /\[ -- \].*could not ask the service manager/)
  assert.match(lineWith(out, 'unit environment'), /Failed to connect to bus/, 'its own words are named')
  // Without a bus systemd-run fails too. That is no news about PATH: the
  // environment.d advice would not help, and a FAIL next to "could not ask"
  // contradicts itself.
  assert.doesNotMatch(out, /\[FAIL\][^\n]*unit (sees|DISPLAY|clipboard)/)
  assert.doesNotMatch(out, /environment\.d/)
  assert.doesNotMatch(out, /import-environment DISPLAY XAUTHORITY/)
  assert.doesNotMatch(out, /\[ ok \][^\n]*unit (sees|clipboard)/, 'nothing is claimed as verified')
  assert.equal(status, 0)
})

test('a unit that cannot be started is not reported as a tool missing from its PATH', async () => {
  // show-environment answers, but systemd-run itself fails before the command
  // runs. Its own words on stderr tell that apart from `command -v` finding
  // nothing, which prints nothing.
  const { status, out } = await runSelftest({
    macros: false,
    tools: ['curl', 'xsel', 'wl-paste', 'sh'],
    stubs: UNIT_STUBS,
    env: { DISPLAY: ':0', XDG_RUNTIME_DIR: '%ROOT%/runtime', STUB_UNIT_DISPLAY: ':0', STUB_RUN_FAIL: '1' }
  })
  assert.match(lineWith(out, 'unit sees xsel'), /\[ -- \].*could not start a unit.*Failed to connect to bus/)
  assert.doesNotMatch(out, /\[FAIL\][^\n]*unit sees/)
  assert.doesNotMatch(out, /environment\.d/)
  assert.doesNotMatch(out, /\[ ok \][^\n]*unit clipboard/, 'the clipboard was not read under the unit')
  assert.equal(status, 0)
})

test('a tool the unit does not find is still a failure with the environment.d advice', async () => {
  // The counterpart: systemd-run works, the unit's PATH lacks xsel. The stub
  // runs the command without the scenario's bin directory on PATH.
  const { status, out } = await runSelftest({
    macros: false,
    tools: ['curl', 'xsel', 'wl-paste', 'sh'],
    stubs: UNIT_STUBS,
    env: { DISPLAY: ':0', XDG_RUNTIME_DIR: '%ROOT%/runtime', STUB_UNIT_DISPLAY: ':0', STUB_UNIT_PATH: '/nonexistent' }
  })
  assert.match(lineWith(out, 'unit sees xsel'), /\[FAIL\].*not the service manager's/)
  assert.match(out, /environment\.d/)
  assert.equal(status, 1)
})

test('with a [macros] section the same missing tools ARE failures', async () => {
  const { status, out } = await runSelftest({ macros: true, tools: ['curl', 'xsel', 'wl-paste'] })
  for (const tool of ['ydotool', 'xdotool', 'xprop']) {
    assert.match(lineWith(out, tool), /\[FAIL\]/, `${tool} is required once macros are configured`)
  }
  assert.equal(status, 1)
})

// --- runs without an installation --------------------------------------------

test('it runs with no config at all and says so instead of failing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-selftest-bare-'))
  try {
    const bin = makeBin(root, ALL_CLIENT_TOOLS)
    const r = spawnSync('bash', [SCRIPT, '--offline'], {
      encoding: 'utf8',
      env: { PATH: bin, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_RUNTIME_DIR: path.join(root, 'runtime'), TMPDIR: root, LANG: 'C.UTF-8' }
    })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    assert.match(lineWith(out, 'config'), /\[warn\].*none installed yet/)
    assert.match(out, /reading the shipped example/)
    // The shipped example configures chat macros, so sections 3 and 4 look at
    // the machine itself: the input group, /dev/input, /dev/uinput and the
    // ydotool socket (here in an empty XDG_RUNTIME_DIR, never the live one).
    // Those verdicts belong to the machine running the tests, and a CI runner
    // has none of it. Everything else has to pass: no installation is not a
    // failure, it is the state you diagnose from.
    const machineBound = /\] (group input|\/dev\/input|\/dev\/uinput|ydotool socket|ydotool\.service) /
    const fails = out.split('\n').filter(l => /^\s*\[FAIL\]/.test(l))
    assert.deepEqual(fails.filter(l => !machineBound.test(l)), [], 'only the macro hardware may fail here')
    assert.equal(r.status, fails.length ? 1 : 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('it changes nothing: no dedup marker, no config, no service touched', async () => {
  // The dedup marker is the one file the real path writes. If the self-test
  // wrote the LIVE one, the next real copy of that item would be swallowed as
  // a duplicate — a diagnosis that breaks the thing it diagnoses.
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-selftest-ro-'))
  try {
    const bin = makeBin(root, ALL_CLIENT_TOOLS)
    const cfgDir = path.join(root, 'config/poe-price-daemon')
    mkdirSync(cfgDir, { recursive: true })
    const cfgFile = path.join(cfgDir, 'config.toml')
    writeFileSync(cfgFile, CONFIG_MACROS.replace('%URL%', 'http://127.0.0.1:1').replace('%USER%', 'player1').replace('%PREFIXES%', '["Item Class: "]'))
    const runtime = path.join(root, 'runtime')
    mkdirSync(runtime)
    const before = execFileSync('cat', [cfgFile], { encoding: 'utf8' })
    spawnSync('bash', [SCRIPT, '--offline'], {
      encoding: 'utf8',
      env: { PATH: bin, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_RUNTIME_DIR: runtime, TMPDIR: root, LANG: 'C.UTF-8' }
    })
    assert.equal(execFileSync('cat', [cfgFile], { encoding: 'utf8' }), before, 'the config is untouched')
    assert.equal(
      spawnSync('test', ['-e', path.join(runtime, 'ppt-last-posted')]).status, 1,
      'the live dedup marker must not be written by a diagnosis'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- 8. and 9.: the way a result reaches the game -----------------------------

const NOTIFY_STUB = '#!/usr/bin/env bash\necho 1\n'
// systemctl that answers show-environment with exactly STUB_ENV_LINES
// (newline-separated), and nothing else.
const SYSTEMCTL_ENV_STUB = `#!/usr/bin/env bash
case "$*" in
  *show-environment*) printf '%b\\n' "\${STUB_ENV_LINES:-PATH=/bin}"; exit 0 ;;
  *is-active*) echo active; exit 0 ;;
esac
exit 1
`
const KREAD_STUB = '#!/usr/bin/env bash\necho "${STUB_KREAD:-true}"\n'

test('a server without the back channel is a warning, not a failure', async () => {
  await withBackend({}, async url => {
    const { status, out } = await runSelftest({ url, args: [], macros: false, tools: ['curl', 'xsel', 'wl-paste'] })
    assert.match(out, /8\. Back channel/)
    assert.match(lineWith(out, 'back channel'), /\[warn\].*server older than this daemon — results only in the browser/)
    assert.match(out, /docs\/admin\.md.*Update procedure/)
    assert.equal(status, 0, 'pricing works without it')
  })
})

test('a server with the back channel is ok, asked with the daemon headers and without a heartbeat', async () => {
  const seen = []
  await withBackend({ events: { code: 200, body: '{"v":1,"boot":"b","seq":0,"reset":true,"gap":false,"events":[]}' }, seen }, async url => {
    const { out } = await runSelftest({ url, args: [], macros: false, tools: ['curl', 'xsel', 'wl-paste'] })
    assert.match(lineWith(out, 'back channel'), /\[ ok \].*available/)
  })
  const poll = seen.find(r => r.url.startsWith('/daemon/events'))
  assert.ok(poll, 'the self-test asked GET /daemon/events')
  assert.match(poll.url, /wait=0/)
  assert.equal(poll.headers['x-user'], 'player1')
  assert.ok(poll.headers['x-ppt-daemon'])
  assert.ok(!seen.some(r => r.url.startsWith('/daemon/heartbeat')), 'no heartbeat: it would set the presence')
})

test('a back channel that answers with an error or a proxy page is a failure', async () => {
  // The one way section 8 fails (head comment, README, docs/admin.md):
  // the backend answered in step 6, so this is a fault, not an older server.
  for (const events of [{ code: 502, body: 'Bad Gateway' }, { code: 200, body: '<html>login</html>' }]) {
    await withBackend({ events }, async url => {
      const { status, out } = await runSelftest({ url, args: [], macros: false, tools: ['curl', 'xsel', 'wl-paste'] })
      assert.match(lineWith(out, 'back channel'), /\[FAIL\].*GET \/daemon\/events answered/, String(events.code))
      assert.equal(status, 1)
    })
  }
})

test('a back channel switched off, or --offline, is not asked', async () => {
  const { out } = await runSelftest({ macros: false, tools: ['curl', 'xsel', 'wl-paste'] })
  assert.match(lineWith(out, 'back channel'), /\[ -- \].*--offline/)
})

test('a missing notify-send and a missing session bus are warnings and print no value', async () => {
  const { status, out } = await runSelftest({
    macros: false,
    tools: ['curl', 'xsel', 'wl-paste'],
    stubs: { systemctl: SYSTEMCTL_ENV_STUB },
    env: { XDG_RUNTIME_DIR: '%ROOT%/runtime', STUB_ENV_LINES: 'PATH=/bin\\nSECRETISH=do-not-print-me' }
  })
  assert.match(out, /9\. Notification/)
  assert.match(lineWith(out, 'notify-send'), /\[warn\].*missing/)
  assert.match(out, /libnotify/)
  assert.match(lineWith(out, 'session bus'), /\[warn\].*the service sees no session bus/)
  assert.doesNotMatch(out, /do-not-print-me/)
  assert.equal(status, 0)
})

test('a session bus in the service manager is ok, and its address is never printed', async () => {
  const { out } = await runSelftest({
    macros: false,
    tools: ['curl', 'xsel', 'wl-paste'],
    stubs: { systemctl: SYSTEMCTL_ENV_STUB, 'notify-send': NOTIFY_STUB },
    env: { XDG_RUNTIME_DIR: '%ROOT%/runtime', STUB_ENV_LINES: 'PATH=/bin\\nDBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1/bus-secret-address' }
  })
  assert.match(lineWith(out, 'notify-send'), /\[ ok \]/)
  assert.match(lineWith(out, 'session bus'), /\[ ok \]/)
  assert.doesNotMatch(out, /bus-secret-address/)
})

test("KDE's fullscreen mute is named with the switch, and only when it is on", async () => {
  const base = {
    macros: false,
    tools: ['curl', 'xsel', 'wl-paste'],
    stubs: { 'notify-send': NOTIFY_STUB, kreadconfig6: KREAD_STUB }
  }
  const on = await runSelftest({ ...base, env: { XDG_CURRENT_DESKTOP: 'KDE', STUB_KREAD: 'true' } })
  assert.match(lineWith(on.out, 'fullscreen'), /\[warn\].*KDE holds notifications back while a fullscreen window has focus/)
  assert.match(on.out, /System Settings → Notifications → Do Not Disturb mode/)
  assert.equal(on.status, 0)
  const off = await runSelftest({ ...base, env: { XDG_CURRENT_DESKTOP: 'KDE', STUB_KREAD: 'false' } })
  assert.doesNotMatch(lineWith(off.out, 'fullscreen'), /\[warn\]/)
  const gnome = await runSelftest({ ...base, env: { XDG_CURRENT_DESKTOP: 'GNOME' } })
  assert.equal(lineWith(gnome.out, 'fullscreen'), '', 'not KDE: nothing to say')
})

test('notify = false in the config skips the notification checks', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-selftest-notify-'))
  try {
    const bin = makeBin(root, ['curl', 'xsel', 'wl-paste'])
    const cfgDir = path.join(root, 'config/poe-price-daemon')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(path.join(cfgDir, 'config.toml'), CONFIG_NO_MACROS.replace('%URL%', 'http://127.0.0.1:1')
      .replace('%USER%', 'player1').replace('%PREFIXES%', '["Item Class: "]') + '\n[link]\nback_channel = false\n[results]\nnotify = false\noverlay = "off"\n')
    const r = await collect('bash', [SCRIPT, '--offline'], {
      encoding: 'utf8',
      env: { PATH: bin, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), TMPDIR: root, LANG: 'C.UTF-8' }
    })
    assert.match(lineWith(r.out, 'notification'), /\[ -- \].*off in config\.toml/)
    assert.equal(lineWith(r.out, 'notify-send'), '')
    assert.match(lineWith(r.out, 'back channel'), /\[ -- \]/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('--help prints the whole head comment and nothing of the code', () => {
  const r = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir() } })
  const lines = r.stdout.trimEnd().split('\n')
  assert.match(lines.at(-1), /^Exit: 0 = nothing broken/)
  assert.match(r.stdout, /8\. the back channel/)
  assert.match(r.stdout, /9\. notify-send and the session bus/)
  assert.match(r.stdout, /10\. the overlay/)
  assert.match(r.stdout, /11\. buyer whispers/)
  assert.match(r.stdout, /--overlay/)
  assert.doesNotMatch(r.stdout, /set -uo pipefail/)
})

// --- 10. the overlay ---------------------------------------------------------
// ppt_overlay.py is answered by the python3 wrapper (OVERLAY_PY_STUB): the
// verdicts are tested against its exit codes, never against a real Qt. The
// probe runs only with DISPLAY set; DISPLAY here names no real X server, and
// xsel is a stub, so nothing reads the clipboard of the machine running the tests.
const XSEL_STUB = '#!/usr/bin/env bash\necho stub-clipboard\n'
const overlayRun = (opts = {}) => runSelftest({
  ...opts,
  env: { DISPLAY: ':99', ...(opts.env || {}) },
  stubs: { xsel: XSEL_STUB, ...(opts.stubs || {}) }
})

test('without DISPLAY in this shell the overlay is not probed', async () => {
  const { out, overlayCalls } = await runSelftest()
  assert.match(lineWith(out, '] overlay '), /\[warn\].*DISPLAY is not set — cannot test the overlay's X11 window from here/)
  assert.match(out, /section 5 says whether the service has DISPLAY/)
  assert.deepEqual(overlayCalls, [])
  // --overlay runs no section 5, so its hint points to the full run.
  const only = await runSelftest({ args: ['--overlay'] })
  assert.match(lineWith(only.out, '] overlay '), /\[warn\].*DISPLAY is not set/)
  assert.doesNotMatch(only.out, /5\. Daemon service/, 'section 5 did not run')
  assert.match(only.out, /the full run \(\.\/daemon\/selftest\.sh\) says in section 5 whether the service has DISPLAY/)
  assert.equal(only.status, 0, 'a warning, not a failure')
  assert.deepEqual(only.overlayCalls, [])
})

test('the overlay probe runs on xcb and is ok with PySide6 and the focus tools', async () => {
  const { out, overlayCalls } = await overlayRun()
  assert.match(out, /10\. Overlay/)
  assert.match(lineWith(out, '] overlay '), /\[ ok \].*PySide6 6\.12\.0 on xcb, 1 screen\(s\)/)
  assert.deepEqual(overlayCalls, ['QT_QPA_PLATFORM=xcb --probe'])
  assert.equal(lineWith(out, 'overlay focus check'), '')
})

test('no PySide6 is a warning, unless overlay = "on" asks for it', async () => {
  const auto = await overlayRun({ env: { STUB_OVERLAY: 'noqt' } })
  const ok = await overlayRun()
  assert.match(lineWith(auto.out, '] overlay '), /\[warn\].*no PySide6 — results come as notifications/)
  assert.match(auto.out, /libQt6Core/)
  assert.match(auto.out, /Arch: pyside6/)
  assert.equal(auto.status, ok.status, 'the exit code is not raised by it')
  const on = await overlayRun({ env: { STUB_OVERLAY: 'noqt' }, extra: '[results]\noverlay = "on"' })
  assert.match(lineWith(on.out, '] overlay '), /\[FAIL\].*no PySide6/)
  assert.equal(on.status, 1)
})

test('no X11 display for the overlay fails with the import-environment hint', async () => {
  const { status, out } = await overlayRun({ env: { STUB_OVERLAY: 'nodisplay' } })
  assert.match(lineWith(out, '] overlay '), /\[FAIL\].*the X server takes no connection or Qt has no xcb platform/)
  assert.match(out, /X server at DISPLAY=:99 does not take a connection/)
  assert.match(out, /import-environment DISPLAY XAUTHORITY/)
  assert.equal(status, 1)
})

test('an overlay on another Qt platform than xcb fails', async () => {
  const { out } = await overlayRun({ env: { STUB_OVERLAY: 'wayland' } })
  assert.match(lineWith(out, '] overlay '), /\[FAIL\].*wrong platform: Qt started on "wayland" instead of xcb/)
})

test('without xdotool or xprop the overlay focus check is a warning with the package names', async () => {
  const { out } = await overlayRun({ macros: false, tools: ['curl', 'xsel', 'wl-paste', 'xprop'] })
  assert.match(lineWith(out, 'overlay focus check'), /\[warn\].*xdotool\/xprop missing/)
  assert.match(out, /Arch: xdotool xorg-xprop/)
  assert.match(out, /overlay_only_in_game = false/)
  const always = await overlayRun({ macros: false, tools: ['curl', 'xsel', 'wl-paste'], extra: '[results]\noverlay_only_in_game = false' })
  assert.equal(lineWith(always.out, 'overlay focus check'), '', 'not needed when the overlay is used everywhere')
})

test('overlay = "off" skips the overlay checks', async () => {
  const { out, overlayCalls } = await overlayRun({ extra: '[results]\noverlay = "off"' })
  assert.match(lineWith(out, '] overlay '), /\[ -- \].*off in config\.toml/)
  assert.deepEqual(overlayCalls, [])
})

test('--overlay checks only the config and the overlay, then shows the test card on xcb', async () => {
  const { status, out, overlayCalls } = await overlayRun({
    args: ['--overlay'],
    stubs: { sleep: '#!/usr/bin/env bash\nexit 0\n' }
  })
  assert.match(out, /0\. Configuration/)
  assert.doesNotMatch(out, /1\. Tools/, 'no other section')
  assert.doesNotMatch(out, /7\. Test parse/, 'and never the real POST of step 7')
  assert.match(out, /Switch to the game now — in 5 seconds a test card appears at the mouse for 5 seconds\./)
  assert.match(out, /Did the card appear over the game\?/)
  assert.deepEqual(overlayCalls, ['QT_QPA_PLATFORM=xcb --probe', 'QT_QPA_PLATFORM=xcb --demo', 'QT_QPA_PLATFORM=xcb --session'])
  assert.equal(status, 0)
  const broken = await overlayRun({ args: ['--overlay'], env: { STUB_OVERLAY: 'noqt' } })
  assert.match(lineWith(broken.out, '] test card'), /\[ -- \].*not shown — fix the overlay finding above first/)
  assert.deepEqual(broken.overlayCalls, ['QT_QPA_PLATFORM=xcb --probe'])
})

// --- 11. buyer whispers ---------------------------------------------------------
// client_log is a file in the temp HOME; the search paths are below it too.
// Only sizes, ages and counts are printed, never a line of the log.

const POE_LOGS = 'Path of Exile/logs/Client.txt'
const WINE_LOG = `drive_c/Program Files (x86)/Grinding Gear Games/${POE_LOGS}`
const WLOG = [
  '2026/11/03 20:11:46 1 ab [INFO Client 7] @From Zxqname: Hi, I would like to buy your thing\r\n',
  '2026/11/03 20:11:47 1 ab [INFO Client 7] @From <GLD> Zxqother: hello\r\n',
  '2026/11/03 20:11:48 1 ab [INFO Client 7] @To Zxqname: sure\r\n',
  '2026/11/03 20:11:49 1 ab [INFO Client 7] : You have entered Hideout.\r\n'
].join('')

test('the whisper section finds the file and the marker without printing a name', async () => {
  const { status, out } = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: { 'poe/Client.txt': WLOG },
    extra: '[whispers]\nclient_log = "%ROOT%/poe/Client.txt"'
  })
  assert.match(out, /11\. Whispers/)
  assert.match(lineWith(out, '] whispers '), /\[ ok \].*Client\.txt \(\d+(\.\d+)? KB, written (just now|\d+ (s|min) ago)\)/)
  assert.match(lineWith(out, 'incoming marker'), /\[ ok \].*2 incoming whisper line\(s\) with @From/)
  assert.doesNotMatch(out, /Zxq/)
  assert.equal(status, 0, out)
})

test('a marker the client does not write is a warning that names what it writes', async () => {
  const { status, out } = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: { 'poe/Client.txt': WLOG },
    extra: '[whispers]\nclient_log = "~/poe/Client.txt"\nincoming_markers = ["@Von"]'
  })
  assert.match(lineWith(out, '] whispers '), /\[ ok \]/, '~ is the home directory, as in the daemon')
  assert.match(lineWith(out, 'incoming marker'), /\[warn\].*your client writes @From lines, but none with @Von/,
    'the whispers you send (@To) are not named as a marker to add')
  assert.match(out, /add the marker your client language writes to incoming_markers/i)
  assert.doesNotMatch(out, /Zxq/)
  assert.equal(status, 0, 'a warning, not a failure')
})

const SENT_ONLY = [
  '2026/11/03 20:11:46 1 ab [INFO Client 7] @To Zxqseller: Hi, I would like to buy your thing\r\n',
  '2026/11/03 20:11:47 1 ab [INFO Client 7] @To <GLD> Zxqother: Hi, I would like to buy your other thing\r\n',
  '2026/11/03 20:11:48 1 ab [INFO Client 7] @An Zxqthird: Hi, ich möchte etwas\r\n'
].join('')

test('a log with only the whispers you sent cannot check the marker, and does not ask to add @To', async () => {
  const { status, out } = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: { 'poe/Client.txt': SENT_ONLY },
    extra: '[whispers]\nclient_log = "%ROOT%/poe/Client.txt"'
  })
  assert.match(lineWith(out, 'incoming marker'),
    /\[ -- \].*only outgoing whispers \(@An, @To\) in its last 1 MB — the marker cannot be checked/)
  assert.doesNotMatch(out.slice(out.indexOf('11. Whispers'), out.indexOf('12. Game detection')), /\[warn\]/)
  assert.doesNotMatch(out, /Add the marker/)
  assert.doesNotMatch(out, /Zxq/)
  assert.equal(status, 0)
})

test('an unknown marker next to sent whispers is still a warning that names only the unknown one', async () => {
  const { out } = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: { 'poe/Client.txt': SENT_ONLY + '2026/11/03 20:11:49 1 ab [INFO Client 7] @Od Zxqbuyer: Salut\r\n' },
    extra: '[whispers]\nclient_log = "%ROOT%/poe/Client.txt"'
  })
  assert.match(lineWith(out, 'incoming marker'), /\[warn\].*your client writes @Od lines, but none with @From @Von @De @От кого/)
  assert.doesNotMatch(out, /Zxq/)
})

// The markers of the other client languages (SlimTrade's patterns, not seen
// in a real log): the defaults count a Russian marker with a space inside, and
// the whispers you send in French, Spanish, Portuguese or Russian are not
// taken for an unknown incoming marker.
test('the default markers count a Russian incoming whisper, and sent ones of other languages are outgoing', async () => {
  const ru = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: {
      'poe/Client.txt': [
        '2026/11/03 20:11:46 1 ab [INFO Client 7] @От кого Zxqbuyer: Здравствуйте, хочу купить у вас вещь\r\n',
        '2026/11/03 20:11:47 1 ab [INFO Client 7] @От кого <GLD> Zxqother: привет\r\n',
        '2026/11/03 20:11:48 1 ab [INFO Client 7] @Кому Zxqbuyer: да\r\n'
      ].join('')
    },
    extra: '[whispers]\nclient_log = "%ROOT%/poe/Client.txt"'
  })
  assert.match(lineWith(ru.out, 'incoming marker'), /\[ ok \].*2 incoming whisper line\(s\) with @От кого in its last 1 MB$/)
  assert.doesNotMatch(ru.out, /Zxq/)

  const sent = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: {
      'poe/Client.txt': [
        "2026/11/03 20:11:46 1 ab [INFO Client 7] @À Zxqseller: Bonjour, je souhaiterais t'acheter\r\n",
        '2026/11/03 20:11:47 1 ab [INFO Client 7] @Para Zxqother: Hola, quisiera comprar tu\r\n',
        '2026/11/03 20:11:48 1 ab [INFO Client 7] @Кому Zxqthird: Здравствуйте\r\n'
      ].join('')
    },
    extra: '[whispers]\nclient_log = "%ROOT%/poe/Client.txt"'
  })
  assert.match(lineWith(sent.out, 'incoming marker'),
    /\[ -- \].*only outgoing whispers \(@Para, @À, @Кому\) in its last 1 MB — the marker cannot be checked/)
  assert.doesNotMatch(sent.out, /Add the marker/)
  assert.doesNotMatch(sent.out, /Zxq/)
})

test('a config without the Russian marker is told the client writes @От кого lines', async () => {
  const { status, out } = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: {
      'poe/Client.txt': [
        '2026/11/03 20:11:46 1 ab [INFO Client 7] @От кого Zxqbuyer: Здравствуйте, хочу купить у вас вещь\r\n',
        '2026/11/03 20:11:47 1 ab [INFO Client 7] @От кого <GLD> Zxqother: привет\r\n'
      ].join('')
    },
    extra: '[whispers]\nclient_log = "%ROOT%/poe/Client.txt"\nincoming_markers = ["@From"]'
  })
  assert.match(lineWith(out, 'incoming marker'), /\[warn\].*your client writes @От кого lines, but none with @From/,
    'the marker with a space inside is named whole')
  assert.doesNotMatch(out, /Zxq/)
  assert.equal(status, 0, 'a warning, not a failure')
})

test('a marker of the whispers you send among incoming_markers is a warning', async () => {
  const { out } = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: { 'poe/Client.txt': WLOG },
    extra: '[whispers]\nclient_log = "%ROOT%/poe/Client.txt"\nincoming_markers = ["@From", "@To"]'
  })
  assert.match(lineWith(out, 'outgoing marker'), /\[warn\].*@To in incoming_markers marks the whispers YOU send/)
  assert.match(out, /Remove @To from incoming_markers/)
  assert.match(lineWith(out, 'incoming marker'), /\[ ok \].*2 incoming whisper line\(s\) with @From in its last 1 MB$/,
    'the @To lines are not counted as incoming')
})

test('a client_log older than a day is a warning when another log found was written later', async () => {
  const steam = `.steam/steam/steamapps/common/${POE_LOGS}`
  const old = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: { 'oldprefix/Client.txt': WLOG, [steam]: WLOG },
    ages: { 'oldprefix/Client.txt': 12 * 86400, [steam]: 120 },
    extra: '[whispers]\nclient_log = "%ROOT%/oldprefix/Client.txt"'
  })
  assert.match(lineWith(old.out, '] whispers '), /\[warn\].*oldprefix\/Client\.txt \(.*, written 12 d ago\) — another Client\.txt was written later/)
  assert.match(old.out, /\.steam\/steam\/steamapps\/common\/Path of Exile\/logs\/Client\.txt \(written 2 min ago\)/)
  assert.match(old.out, /set client_log in \[whispers\] of .* to it/)
  assert.doesNotMatch(old.out, /Zxq/)
  assert.equal(old.status, 0, 'a warning, not a failure')
  // old, but nothing found was written later: the log is just quiet
  const quiet = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: { [steam]: WLOG, 'Games/x/other.txt': '' },
    ages: { [steam]: 12 * 86400 },
    extra: `[whispers]\nclient_log = "%ROOT%/${steam}"`
  })
  assert.match(lineWith(quiet.out, '] whispers '), /\[ ok \].*written 12 d ago\)$/)
  // a day old at most: no comparison
  const fresh = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: { 'oldprefix/Client.txt': WLOG, [steam]: WLOG },
    ages: { 'oldprefix/Client.txt': 3600, [steam]: 60 },
    extra: '[whispers]\nclient_log = "%ROOT%/oldprefix/Client.txt"'
  })
  assert.match(lineWith(fresh.out, '] whispers '), /\[ ok \].*written 1 h ago\)$/)
})

test('a client_log that does not exist fails and lists the logs found under Steam, ~/Games and ~/.wine', async () => {
  const { status, out } = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: {
      [`Games/poe/${WINE_LOG}`]: WLOG,
      [`.wine/${WINE_LOG}`]: '',
      '.local/share/Steam/steamapps/libraryfolders.vdf': '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"%ROOT%/.local/share/Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"%ROOT%/lib2"\n\t}\n}\n',
      [`lib2/steamapps/common/${POE_LOGS}`]: WLOG
    },
    extra: '[whispers]\nclient_log = "%ROOT%/nowhere/Client.txt"'
  })
  assert.match(lineWith(out, '] whispers '), /\[FAIL\].*nowhere\/Client\.txt does not exist/)
  assert.match(out, /Client\.txt files found:/)
  assert.match(out, /Games\/poe\/drive_c\/Program Files \(x86\)\/Grinding Gear Games\/Path of Exile\/logs\/Client\.txt/)
  assert.match(out, /\.wine\/drive_c\/Program Files/)
  assert.match(out, /lib2\/steamapps\/common\/Path of Exile\/logs\/Client\.txt/)
  assert.doesNotMatch(out, /Zxq/)
  assert.equal(status, 1)
})

test('without any log to suggest, the self-test says to set client_log by hand', async () => {
  const { out } = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    extra: '[whispers]\nclient_log = "/nonexistent/Client.txt"'
  })
  assert.match(out, /none found — a game outside Steam, ~\/Games and ~\/\.wine: set client_log by hand/)
})

test('without client_log the whisper check is off, and found logs are offered', async () => {
  const { status, out } = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'],
    files: { [`.steam/steam/steamapps/common/${POE_LOGS}`]: WLOG }
  })
  assert.match(lineWith(out, '] whispers '), /\[ -- \].*off \(client_log not set\)/)
  assert.match(out, /\.steam\/steam\/steamapps\/common\/Path of Exile\/logs\/Client\.txt/)
  assert.equal(lineWith(out, 'incoming marker'), '')
  assert.equal(status, 0)
})

// --- 12. game detection ---------------------------------------------------------

const SEEN = { '.local/state/poe-price-daemon/game-seen.json': JSON.stringify({ v: 1, seen: [{ class: 'steam_app_238960', display: ':99' }] }) }
const XDOTOOL_HIT = '#!/usr/bin/env bash\necho 62914561\n'

test('game detection is reported, and doubt is a warning, not a failure', async () => {
  const found = await runSelftest({ env: { DISPLAY: ':99' }, stubs: { xdotool: XDOTOOL_HIT } })
  assert.match(found.out, /12\. Game detection \(sync follows the game\)/)
  assert.match(lineWith(found.out, '] game window'), /\[ ok \].*game window found \(window class steam_app_238960\)/)
  assert.doesNotMatch(found.out, /62914561/, 'no window id is printed')

  const absent = await runSelftest({ env: { DISPLAY: ':99' }, files: SEEN })
  assert.match(lineWith(absent.out, '] game window'), /\[ -- \].*no game window — start the game and run this again/)

  const never = await runSelftest({ env: { DISPLAY: ':99' } })
  assert.match(lineWith(never.out, '] game window'), /\[warn\].*class steam_app_238960 never seen yet/)
  assert.match(never.out, /until then your sync keeps its normal pace/)
  assert.match(never.out, /its journal names a game-seen\.json it could not write/, 'a seen file the daemon could not write is pointed at')

  const nodisplay = await runSelftest()
  assert.match(lineWith(nodisplay.out, '] game window'), /\[warn\].*cannot tell \(no-display\)/)

  const noxdotool = await runSelftest({
    macros: false, tools: ['curl', 'xsel', 'wl-paste'], env: { DISPLAY: ':99' }, stubs: { xsel: '#!/usr/bin/env bash\nexit 0\n' }
  })
  assert.match(lineWith(noxdotool.out, '] game window'), /\[warn\].*cannot tell \(no-xdotool\)/)
  assert.equal(noxdotool.status, 0, 'a missing xdotool for game detection does not fail the self-test')
  assert.equal(found.status, never.status, 'the exit code is not raised by doubt')

  const off = await runSelftest({ env: { DISPLAY: ':99' }, extra: '[presence]\nreport_game = false' })
  assert.match(lineWith(off.out, '] game detection'), /\[ -- \].*off in config\.toml/)
})

test('--tools names xdotool for game detection but does not fail on it', async () => {
  const { status, out } = await runSelftest({ args: ['--tools'], macros: false, tools: ['curl', 'xsel', 'wl-paste'] })
  assert.match(lineWith(out, 'xdotool'), /\[warn\]/)
  assert.doesNotMatch(out, /12\. Game detection/)
  assert.equal(status, 0, 'install.sh gates on --tools, and a warning does not stop it')
})

// --- 13. stash cell frame ---------------------------------------------------------
// The key and [stash_grid] are read from the config, the grid with the same
// code as the daemon (ppt_stash_grid.read_grid_config); in auto mode the game
// window's size comes from xdotool, a stub here.

const MANUAL_GRID = '[stash_grid]\nmode = "manual"\nx = 15\ny = 125\nw = 634\nh = 634'
const XDOTOOL_GEOMETRY = `#!/usr/bin/env bash
case "$*" in
  *getwindowgeometry*) printf 'WINDOW=62914561\\nX=0\\nY=0\\nWIDTH=2560\\nHEIGHT=1440\\nSCREEN=0\\n' ;;
  *search*) echo 62914561 ;;
  *) exit 1 ;;
esac
`
// The key's name is checked with python-evdev when it is there; a machine
// without it gets a warning instead (section 1 names it), never a failure.
const keyOk = line => /\[ ok \].*F10/.test(line) || /\[warn\].*python-evdev/.test(line)

test('the stash cell frame section names the key, a manual grid and where cell 1,1 lies', async () => {
  const { status, out } = await runSelftest({ macros: false, extra: `[whispers]\nhighlight_key = "F10"\n${MANUAL_GRID}` })
  assert.match(out, /13\. Stash cell frame/)
  assert.ok(keyOk(lineWith(out, '] highlight key ')), lineWith(out, '] highlight key '))
  assert.match(lineWith(out, '] stash grid'), /\[ ok \].*manual: 634x634 px at 15,125; cell 1,1 is 53x53 at 15,125/)
  assert.match(lineWith(out, '] highlight whispers'), /\[warn\].*client_log is empty — there is never a whisper to frame/)
  assert.notEqual(status, 2)
})

test('without a highlight key the section says it is off; auto without a game window asks for the game', async () => {
  const { out } = await runSelftest({ env: { DISPLAY: ':99' } })
  assert.match(lineWith(out, '] highlight key '), /\[ -- \].*off \(\[whispers\] highlight_key is empty\)/)
  assert.match(lineWith(out, '] stash grid'), /\[ -- \].*auto: no game window — start the game and run this again/)
  const nodisplay = await runSelftest()
  assert.match(lineWith(nodisplay.out, '] stash grid'), /\[warn\].*auto: DISPLAY is not set — cannot read the game window from here/)
  const noxdotool = await runSelftest({ macros: false, tools: ['curl', 'xsel', 'wl-paste'], env: { DISPLAY: ':99' }, stubs: { xsel: '#!/usr/bin/env bash\nexit 0\n' } })
  assert.match(lineWith(noxdotool.out, '] stash grid'), /\[warn\].*auto needs xdotool/)
  const off = await runSelftest({ extra: '[stash_grid]\nmode = "off"' })
  assert.match(lineWith(off.out, '] stash grid'), /\[ -- \].*off \(\[stash_grid\] mode = "off"\)/)
})

test('in auto mode the grid is computed from the game window xdotool finds', async () => {
  const { out } = await runSelftest({ env: { DISPLAY: ':99' }, stubs: { xdotool: XDOTOOL_GEOMETRY } })
  assert.match(lineWith(out, '] stash grid'), /\[ ok \].*auto: game window 2560x1440 at 0,0 — grid 845x845 px at 20,167; cell 1,1 is 70x70 at 20,167/)
  assert.doesNotMatch(out, /62914561/, 'no window id is printed')
})

test('a [stash_grid] or highlight key the daemon would refuse is a failure', async () => {
  const bad = await runSelftest({ extra: '[stash_grid]\nmode = "maybe"' })
  assert.match(lineWith(bad.out, '] stash grid'), /\[FAIL\].*\[stash_grid\] mode must be one of "auto", "manual", "off" \(got 'maybe'\) — the daemon will not start/)
  assert.equal(bad.status, 1)
  const twice = await runSelftest({ extra: '[whispers]\nhighlight_key = "f5"' })
  assert.match(lineWith(twice.out, '] highlight key '), /\[FAIL\].*f5 is also a key in \[macros\.keys\] — the daemon will not start/)
  const notext = await runSelftest({ extra: '[whispers]\nhighlight_key = 10' })
  assert.match(lineWith(notext.out, '] highlight key '), /\[FAIL\].*highlight_key must be a text/)
})

test('--overlay shows a frame at cell 1,1 after the test card when the grid is known', async () => {
  const sleep = { sleep: '#!/usr/bin/env bash\nexit 0\n' }
  const { status, out, overlayCalls } = await overlayRun({ args: ['--overlay'], extra: MANUAL_GRID, stubs: sleep })
  assert.match(out, /13\. Stash cell frame/)
  assert.match(out, /Open your stash in the game: after the card, a frame marks cell 1,1 of it for 3 seconds\./)
  assert.deepEqual(overlayCalls, ['QT_QPA_PLATFORM=xcb --probe', 'QT_QPA_PLATFORM=xcb --demo', 'QT_QPA_PLATFORM=xcb --session', 'QT_QPA_PLATFORM=xcb --frame', 'QT_QPA_PLATFORM=xcb --grid'])
  assert.match(out, /Did the frame sit on the top-left cell of your stash\?/)
  assert.match(out, /Then a sample value grid of 3 cells covers the stash for 5 seconds; the one with a dashed border and a \? shows how an uncertain price looks\./)
  assert.match(out, /Did the three numbers sit in cells of your stash grid\?/)
  assert.equal(status, 0)
  const unknown = await overlayRun({ args: ['--overlay'], stubs: sleep })
  assert.match(lineWith(unknown.out, '] test frame'), /\[ -- \].*not shown — the grid is not known \(see section 13\)/)
  assert.deepEqual(unknown.overlayCalls, ['QT_QPA_PLATFORM=xcb --probe', 'QT_QPA_PLATFORM=xcb --demo', 'QT_QPA_PLATFORM=xcb --session'])
})

test('with [stash_grid] mode = "off" the key is not watched, so neither the input group nor whispers are asked for', async () => {
  // The daemon opens no device for a highlight key when the grid is off
  // (poe-price-daemon.py watched_keys); a missing group is then no failure.
  const noInput = { id: '#!/usr/bin/env bash\ncase "$1" in -nG) echo users wheel ;; *) echo tester ;; esac\n' }
  const extra = '[whispers]\nhighlight_key = "F10"\n[results]\noverlay = "off"\n'
  const off = await runSelftest({ macros: false, stubs: noInput, extra: `${extra}[stash_grid]\nmode = "off"` })
  assert.match(lineWith(off.out, '] highlight input'), /\[ -- \].*\[stash_grid\] mode = "off": the daemon does not watch F10/)
  assert.doesNotMatch(off.out, /\] highlight whispers|\] highlight overlay/)
  assert.doesNotMatch(off.out, /\[FAIL\].*input/)
  assert.match(lineWith(off.out, 'group input'), /\[ -- \].*the daemon opens no input devices/)
  const on = await runSelftest({ macros: false, stubs: noInput, extra: `${extra}${MANUAL_GRID}` })
  assert.match(lineWith(on.out, '] highlight input'), /\[FAIL\].*tester is not in the 'input' group — the highlight key will never be seen/)
  assert.match(lineWith(on.out, '] highlight overlay'), /\[warn\].*the overlay is off/)
  assert.equal(on.status, 1)
})

test('section 3 points to section 13 when only the highlight key needs the input group', async () => {
  const { out } = await runSelftest({ macros: false, extra: '[whispers]\nhighlight_key = "F10"' })
  assert.match(lineWith(out, 'group input'), /\[ -- \].*no \[macros\] section — section 13 checks it for the highlight key/)
  assert.match(out, /\] highlight input /)
})

// --- 14. session key --------------------------------------------------------------
// [session] key is read like the macro keys (evdev, the input group) and only
// while the game has focus (xdotool and xprop). A stand-in python-evdev on
// PYTHONPATH makes the key-name check the same on every machine; one that
// fails to import is the machine without it.

const FAKE_EVDEV = {
  'pylib/evdev/__init__.py': 'from . import ecodes\n',
  'pylib/evdev/ecodes.py': 'KEY_F5 = 63\nKEY_F9 = 67\nKEY_F10 = 68\nKEY_F11 = 87\n'
}
const NO_EVDEV = { 'pylib/evdev/__init__.py': 'raise ImportError("no evdev in this test")\n' }
const IN_INPUT = { id: '#!/usr/bin/env bash\ncase "$1" in -nG) echo users input ;; *) echo tester ;; esac\n' }
const NOT_IN_INPUT = { id: '#!/usr/bin/env bash\ncase "$1" in -nG) echo users wheel ;; *) echo tester ;; esac\n' }
const withEvdev = (opts = {}) => runSelftest({
  macros: false,
  ...opts,
  files: { ...FAKE_EVDEV, ...(opts.files || {}) },
  env: { PYTHONPATH: '%ROOT%/pylib', ...(opts.env || {}) }
})

test('the session key section names the key, the input group, the focus tools and the cards', async () => {
  const { status, out } = await withEvdev({ stubs: IN_INPUT, extra: '[session]\nkey = "F11"' })
  assert.match(out, /14\. Session key/)
  assert.match(lineWith(out, '] session key '), /\[ ok \].*F11 \(pressed while the game has focus: starts or ends a farm session\)/)
  assert.match(lineWith(out, '] session input'), /\[ ok \].*tester is in the 'input' group/)
  assert.match(lineWith(out, '] session focus'), /\[ ok \].*xdotool and xprop present/)
  assert.match(lineWith(out, '] session cards'), /\[ ok \].*on: game and farm sessions show in the game/)
  assert.match(lineWith(out, 'group input'), /\[ -- \].*no \[macros\] section — section 14 checks it for the session key/)
  assert.equal(status, 0, out)
})

test('without a session key the section says it is off, and the cards still come', async () => {
  const { out } = await withEvdev()
  assert.match(lineWith(out, '] session key '), /\[ -- \].*off \(\[session\] key is empty\)/)
  assert.equal(lineWith(out, '] session input'), '', 'no key: no input device, no group needed')
  assert.match(lineWith(out, '] session cards'), /\[ ok \].*on: game and farm sessions show in the game/)
  const quiet = await withEvdev({ extra: '[session]\ncards = false' })
  assert.match(lineWith(quiet.out, '] session cards'), /\[ -- \].*off \(\[session\] cards = false\): only the answer to a press is shown/)
  const noLink = await withEvdev({ extra: '[link]\nback_channel = false\n[session]\nkey = "F11"', stubs: IN_INPUT })
  assert.match(lineWith(noLink.out, '] session cards'), /\[warn\].*the back channel is off \(\[link\] back_channel = false\) — only the answer to a press is shown/)
})

test('a session key the daemon would refuse, or one it can never see, is a failure', async () => {
  const notext = await withEvdev({ extra: '[session]\nkey = 11' })
  assert.match(lineWith(notext.out, '] session key '), /\[FAIL\].*\[session\] key must be a text \(got 11\) — the daemon will not start/)
  assert.equal(notext.status, 1)
  const macro = await withEvdev({ macros: true, extra: '[session]\nkey = "f5"' })
  assert.match(lineWith(macro.out, '] session key '), /\[FAIL\].*f5 is also a key in \[macros\.keys\] — the daemon will not start/)
  const highlight = await withEvdev({ extra: '[whispers]\nhighlight_key = "F10"\n[session]\nkey = "f10"' })
  assert.match(lineWith(highlight.out, '] session key '), /\[FAIL\].*f10 is also \[whispers\] highlight_key — the daemon will not start/)
  const unknown = await withEvdev({ extra: '[session]\nkey = "F99"' })
  assert.match(lineWith(unknown.out, '] session key '), /\[FAIL\].*F99 is not a key name evdev knows \(names like F11, KP1, DOT\) — the daemon will not start/)
  const cards = await withEvdev({ extra: '[session]\ncards = "yes"' })
  assert.match(lineWith(cards.out, '] session cards'), /\[FAIL\].*\[session\] cards must be true or false — the daemon will not start/)
  const table = await withEvdev({ extra: 'session = "F11"' })
  assert.match(lineWith(table.out, '] session key '), /\[FAIL\].*\[session\] must be a table — the daemon will not start/)
  const group = await withEvdev({ stubs: NOT_IN_INPUT, extra: '[session]\nkey = "F11"' })
  assert.match(lineWith(group.out, '] session input'), /\[FAIL\].*tester is not in the 'input' group — the session key will never be seen/)
  assert.equal(group.status, 1)
  const nofocus = await withEvdev({ stubs: IN_INPUT, tools: ['curl', 'xsel', 'wl-paste'], extra: '[session]\nkey = "F11"' })
  assert.match(lineWith(nofocus.out, '] session focus'), /\[FAIL\].*xdotool\/xprop missing — the key works only while the game has focus, and that cannot be checked/)
})

test('without python-evdev the session key cannot be checked, and the section says the daemon would not start', async () => {
  const { out } = await withEvdev({ stubs: IN_INPUT, files: NO_EVDEV, extra: '[session]\nkey = "F11"' })
  assert.match(lineWith(out, '] session key '), /\[warn\].*F11 cannot be checked: python-evdev is missing \(see section 1\)/)
})

test('--overlay shows a session card after the test card', async () => {
  const sleep = { sleep: '#!/usr/bin/env bash\nexit 0\n' }
  const { status, out, overlayCalls } = await overlayRun({ args: ['--overlay'], stubs: sleep })
  assert.deepEqual(overlayCalls, ['QT_QPA_PLATFORM=xcb --probe', 'QT_QPA_PLATFORM=xcb --demo', 'QT_QPA_PLATFORM=xcb --session'])
  assert.match(out, /Then a session card appears where whisper cards stack \(left edge\) for 5 seconds\./)
  assert.match(out, /Did the session card appear\?/)
  assert.equal(status, 0)
})

// --- 15. value key ----------------------------------------------------------------
// [stash_grid] value_key is read like the session key (evdev, the input group,
// xdotool and xprop for the focus gate); its other keys with the daemon's own
// code (ppt_value_grid.read_value_config). GET /daemon/stash-grid without a
// tab is asked once when the backend answered in step 6.

const GRID_TABS = JSON.stringify({ v: 1, tabs: [{ index: 0, name: 'Sale', type: 'PremiumStash', grid: true }, { index: 1, name: 'Currency', type: 'CurrencyStash', grid: false }] })

test('the value key section names the key, the input group, the focus tools and the settings', async () => {
  const { status, out } = await withEvdev({ stubs: IN_INPUT, extra: '[stash_grid]\nvalue_key = "F9"\nvalue_min_c = 10' })
  assert.match(out, /15\. Value key/)
  assert.match(lineWith(out, '] value key '), /\[ ok \].*F9 \(pressed while the game has focus: what each item of a stash tab is worth\)/)
  assert.match(lineWith(out, '] value input'), /\[ ok \].*tester is in the 'input' group/)
  assert.match(lineWith(out, '] value focus'), /\[ ok \].*xdotool and xprop present/)
  assert.match(lineWith(out, '] value settings'), /\[ ok \].*from 10 c, 20 s a tab, every tab with a grid/)
  assert.match(lineWith(out, '] value server'), /\[ -- \].*--offline/)
  assert.match(lineWith(out, 'group input'), /\[ -- \].*no \[macros\] section — section 15 checks it for the value key/)
  assert.equal(status, 0, out)
})

test('without a value key the section says it is off and asks nothing', async () => {
  const { out } = await withEvdev()
  assert.match(lineWith(out, '] value key '), /\[ -- \].*off \(\[stash_grid\] value_key is empty\)/)
  assert.equal(lineWith(out, '] value input'), '')
  assert.equal(lineWith(out, '] value server'), '')
  const off = await withEvdev({ stubs: NOT_IN_INPUT, extra: '[stash_grid]\nmode = "off"\nvalue_key = "F9"' })
  assert.match(lineWith(off.out, '] value input'), /\[ -- \].*\[stash_grid\] mode = "off": the daemon does not watch F9/)
  assert.doesNotMatch(off.out, /\[FAIL\].*value/)
})

test('a value key the daemon would refuse, or one it can never see, is a failure', async () => {
  const cases = [
    ['[stash_grid]\nvalue_key = 9', /\[FAIL\].*\[stash_grid\] value_key must be a text \(got 9\) — the daemon will not start/, '] value key '],
    ['[stash_grid]\nvalue_key = "f5"', /\[FAIL\].*f5 is also a key in \[macros\.keys\] — the daemon will not start/, '] value key ', true],
    ['[whispers]\nhighlight_key = "F10"\n[stash_grid]\nvalue_key = "f10"', /\[FAIL\].*f10 is also \[whispers\] highlight_key — the daemon will not start/, '] value key '],
    ['[session]\nkey = "F11"\n[stash_grid]\nvalue_key = "f11"', /\[FAIL\].*f11 is also \[session\] key — the daemon will not start/, '] value key '],
    ['[stash_grid]\nvalue_key = "F99"', /\[FAIL\].*F99 is not a key name evdev knows \(names like F9, KP1, DOT\) — the daemon will not start/, '] value key '],
    ['[stash_grid]\nvalue_min_c = -1', /\[FAIL\].*\[stash_grid\] value_min_c must be a number of at least 0 \(got -1\) — the daemon will not start/, '] value settings']
  ]
  for (const [extra, re, needle, macros] of cases) {
    const r = await withEvdev({ macros: !!macros, stubs: IN_INPUT, extra })
    assert.match(lineWith(r.out, needle), re, extra)
    assert.equal(r.status, 1, extra)
  }
  const group = await withEvdev({ stubs: NOT_IN_INPUT, extra: '[stash_grid]\nvalue_key = "F9"' })
  assert.match(lineWith(group.out, '] value input'), /\[FAIL\].*tester is not in the 'input' group — the value key will never be seen/)
  const nofocus = await withEvdev({ stubs: IN_INPUT, tools: ['curl', 'xsel', 'wl-paste'], extra: '[stash_grid]\nvalue_key = "F9"' })
  assert.match(lineWith(nofocus.out, '] value focus'), /\[FAIL\].*xdotool\/xprop missing — the key works only while the game has focus/)
  const nooverlay = await withEvdev({ stubs: IN_INPUT, extra: '[results]\noverlay = "off"\n[stash_grid]\nvalue_key = "F9"' })
  assert.match(lineWith(nooverlay.out, '] value overlay'), /\[warn\].*the overlay is off .* a notification of the 5 dearest items/)
})

test('the value grid route is asked with the daemon headers, and its answer names the tabs', async () => {
  const seen = []
  const extra = '[stash_grid]\nvalue_key = "F9"\nvalue_tabs = ["Sale", "Nope"]'
  await withBackend({ grid: { code: 200, body: GRID_TABS }, seen }, async url => {
    const { out } = await withEvdev({ url, args: [], tools: ['curl', 'xsel', 'wl-paste', 'xdotool', 'xprop'], stubs: IN_INPUT, extra })
    assert.match(lineWith(out, '] value server'), /\[ ok \].*2 stored tab\(s\), 1 with a grid/)
    assert.match(lineWith(out, '] value tabs'), /\[warn\].*value_tabs names "Nope", which no stored tab has — the key skips it/)
  })
  const asked = seen.find(r => r.url.startsWith('/daemon/stash-grid'))
  assert.ok(asked, 'the self-test asked GET /daemon/stash-grid')
  assert.equal(asked.url, '/daemon/stash-grid', 'the list only, never a tab')
  assert.equal(asked.headers['x-user'], 'player1')
  assert.ok(asked.headers['x-ppt-daemon'])
})

test('a server without the route is a warning; an empty store a warning; anything else a failure', async () => {
  const extra = '[stash_grid]\nvalue_key = "F9"'
  const tools = ['curl', 'xsel', 'wl-paste', 'xdotool', 'xprop']
  await withBackend({}, async url => {
    const { out } = await withEvdev({ url, args: [], tools, stubs: IN_INPUT, extra })
    assert.match(lineWith(out, '] value server'), /\[warn\].*server older than this daemon — the value key does nothing/)
  })
  await withBackend({ grid: { code: 200, body: '{"v":1,"tabs":[]}' } }, async url => {
    const { out } = await withEvdev({ url, args: [], tools, stubs: IN_INPUT, extra })
    assert.match(lineWith(out, '] value server'), /\[warn\].*no stored stash tab yet — the net-worth sync has not read your stash/)
  })
  // Tabs stored, none with a grid (only special tabs, or all written before
  // the server kept the tab type): the sync has read the stash, so the line
  // must not say it has not.
  const noGrid = '{"v":1,"tabs":[{"index":0,"name":"Cur","type":null,"grid":false},{"index":1,"name":"Frag","type":"FragmentStash","grid":false}]}'
  await withBackend({ grid: { code: 200, body: noGrid } }, async url => {
    const { out } = await withEvdev({ url, args: [], tools, stubs: IN_INPUT, extra })
    const line = lineWith(out, '] value server')
    assert.match(line, /\[warn\].*2 stored tab\(s\), none with a grid yet — each gets its type and cells with its next sync read/)
    assert.doesNotMatch(line, /has not read your stash/)
  })
  for (const grid of [{ code: 502, body: 'Bad Gateway' }, { code: 200, body: '<html>login</html>' }]) {
    await withBackend({ grid }, async url => {
      const { status, out } = await withEvdev({ url, args: [], tools, stubs: IN_INPUT, extra })
      assert.match(lineWith(out, '] value server'), /\[FAIL\].*GET \/daemon\/stash-grid answered/, String(grid.code))
      assert.equal(status, 1)
    })
  }
})
