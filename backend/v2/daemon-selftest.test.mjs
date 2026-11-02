// daemon/selftest.sh — the diagnosis a stranger runs when nothing works.
//
// Why this lives here: `npm test` runs `node --test backend/v2`, so a test
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
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
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

/** A PATH containing exactly `tools` (plus the base set) and nothing else. */
function makeBin (root, tools) {
  const bin = path.join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const cmd of [...BASE_TOOLS, ...tools]) {
    try { symlinkSync(which(cmd), path.join(bin, cmd)) } catch { /* already linked */ }
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
  macros = true
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ppt-selftest-'))
  try {
    const bin = makeBin(root, tools)
    const cfgDir = path.join(root, 'config/poe-price-daemon')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(path.join(cfgDir, 'config.toml'), (macros ? CONFIG_MACROS : CONFIG_NO_MACROS)
      .replace('%URL%', url)
      .replace('%USER%', user)
      .replace('%PREFIXES%', JSON.stringify(prefixes)))
    return await collect('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: bin,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, 'config'),
        TMPDIR: root,
        LANG: 'C.UTF-8'
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The line carrying `needle`, or '' — so assertions can talk about verdicts. */
const lineWith = (out, needle) => out.split('\n').find(l => l.includes(needle)) || ''

/** A backend that answers /health, /users and POST /item like server.mjs does. */
async function withBackend ({ users = ['player1'], langs = { player1: 'en' }, item = { code: 200, body: '{"id":"x","user":"player1"}' } }, fn) {
  const server = createServer((req, res) => {
    const p = req.url.split('?')[0]
    if (req.method === 'GET' && p === '/health') { res.writeHead(200).end('ok'); return }
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
  const { out } = await runSelftest()
  assert.match(out, /python evdev/)
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
  for (const tool of ['ydotool', 'xdotool', 'xprop']) {
    const line = lineWith(out, tool)
    assert.match(line, /\[ -- \]/, `${tool} must be "not applicable", got: ${line}`)
  }
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
  assert.equal(status, 0, 'no service manager to ask is not a broken install')
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
      env: { PATH: bin, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), TMPDIR: root, LANG: 'C.UTF-8' }
    })
    const out = `${r.stdout || ''}${r.stderr || ''}`
    assert.match(lineWith(out, 'config'), /none installed yet/)
    assert.match(out, /reading the shipped example/)
    assert.equal(r.status, 0, 'no installation is not a failure — it is the state you diagnose from')
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
