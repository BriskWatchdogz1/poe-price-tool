// daemon/poe-price-post.sh — the clipboard language filter, and the exit
// contract the daemon reads (0 posted, 3 skipped, 4 one tagged line on stderr).
//
// Why this lives here: `npm test` runs only the *.test.mjs files under
// backend/v2 (run-tests.mjs), so a test outside this directory would never
// run. The script itself is bash; we spawn
// it the way the daemon does (content on stdin, config via env).
//
// The filter tests put a stub `curl` first on PATH that answers like a backend
// that took the item (the same stub selftest.sh uses in its stage A). What they
// assert is whether the filter LET THE ITEM THROUGH, and the only observable
// signal for that is the dedup marker the script writes just before POSTing.
// It has to be a stub that answers 200: after a FAILED post the handler removes
// the marker again, so a closed port would now read as "dropped".
//
// The exit-contract tests talk to a real HTTP server on a throwaway loopback
// port that answers the shapes server.mjs answers; no request leaves the host.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../daemon/poe-price-post.sh')

// Stage A's curl from selftest.sh: swallows the item and answers 200.
const CURL_STUB = `#!/usr/bin/env bash
cat >/dev/null
printf '{}\\n200 '
`

/** A directory holding the stub curl, to put first on PATH. */
function stubBin (root) {
  const bin = path.join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'curl'), CURL_STUB, { mode: 0o755 })
  return bin
}

/** Run the handler with `clipboard` on stdin; true if it reached the POST. */
function passesFilter (clipboard, prefixes) {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), 'ppt-filter-'))
  try {
    const env = {
      ...process.env,
      PATH: `${stubBin(runtimeDir)}:${process.env.PATH}`,
      XDG_RUNTIME_DIR: runtimeDir,
      PPT_BACKEND_URL: 'http://127.0.0.1:1' // never contacted: the stub curl answers
    }
    if (prefixes !== undefined) env.PPT_ITEM_PREFIXES = prefixes.join('\n')
    else delete env.PPT_ITEM_PREFIXES
    spawnSync('bash', [SCRIPT], { input: clipboard, env, encoding: 'utf8' })
    return existsSync(path.join(runtimeDir, 'ppt-last-posted'))
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
}

const EN_ITEM = 'Item Class: Belts\nRarity: Unique\nThe Tides of Time'
const DE_ITEM = 'Gegenstandsklasse: Gürtel\nSeltenheit: Einzigartig\nDie Gezeiten der Zeit'

test('English item passes with the English prefix', () => {
  assert.equal(passesFilter(EN_ITEM, ['Item Class: ']), true)
})

test('German item is dropped when only the English prefix is configured', () => {
  // The bug this whole feature starts from: without config, every German item
  // dies here and no backend work can ever show.
  assert.equal(passesFilter(DE_ITEM, ['Item Class: ']), false)
})

test('German item passes with the German prefix', () => {
  assert.equal(passesFilter(DE_ITEM, ['Gegenstandsklasse: ']), true)
})

test('both languages pass when both prefixes are configured', () => {
  const both = ['Item Class: ', 'Gegenstandsklasse: ']
  assert.equal(passesFilter(EN_ITEM, both), true)
  assert.equal(passesFilter(DE_ITEM, both), true)
})

test('non-item clipboard content is still dropped silently', () => {
  // Every Ctrl+C in the game lands here, so a miss must stay quiet.
  assert.equal(passesFilter('some text copied from a browser', ['Item Class: ', 'Gegenstandsklasse: ']), false)
})

test('missing PPT_ITEM_PREFIXES falls back to the English prefix', () => {
  // Old configs and old installs must keep working untouched.
  assert.equal(passesFilter(EN_ITEM, undefined), true)
  assert.equal(passesFilter(DE_ITEM, undefined), false)
})

// --- the exit contract the daemon reads ---------------------------------------

/** spawn + collect, as a promise. NOT spawnSync: the mock backend lives in this
 * process and can only answer while the event loop turns. */
function run (clipboard, env) {
  return new Promise(resolve => {
    const child = spawn('bash', [SCRIPT], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', status => resolve({ status, stdout, stderr }))
    child.stdin.end(clipboard)
  })
}

/** A backend that answers every POST /item with `answer` (code, body, headers). */
async function withItemServer (answer, fn) {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => res.writeHead(answer.code, { 'content-type': 'application/json', ...(answer.headers || {}) }).end(answer.body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

/** Run the handler against `url`; also says whether the dedup marker is left. */
async function postTo (url, clipboard = EN_ITEM, extraEnv = {}, runtimeDir = null) {
  const dir = runtimeDir || mkdtempSync(path.join(tmpdir(), 'ppt-post-'))
  try {
    const r = await run(clipboard, {
      ...process.env,
      XDG_RUNTIME_DIR: dir,
      PPT_BACKEND_URL: url,
      PPT_USER: 'player1',
      PPT_ITEM_PREFIXES: 'Item Class: ',
      ...extraEnv
    })
    return { ...r, marker: existsSync(path.join(dir, 'ppt-last-posted')) }
  } finally {
    if (!runtimeDir) rmSync(dir, { recursive: true, force: true })
  }
}

const lines = s => s.split('\n').filter(Boolean)

test('a 2xx answer exits 0 and prints nothing', async () => {
  await withItemServer({ code: 200, body: '{"id":"x"}' }, async url => {
    const r = await postTo(url)
    assert.equal(r.status, 0)
    assert.equal(r.stderr, '')
    assert.equal(r.marker, true, 'the marker stays: the item was posted')
  })
})

test('a non-item and a duplicate exit 3 and stay silent', async () => {
  await withItemServer({ code: 200, body: '{"id":"x"}' }, async url => {
    const r = await postTo(url, 'some browser text')
    assert.equal(r.status, 3)
    assert.equal(r.stderr, '')
    const dir = mkdtempSync(path.join(tmpdir(), 'ppt-post-dup-'))
    try {
      assert.equal((await postTo(url, EN_ITEM, {}, dir)).status, 0)
      const again = await postTo(url, EN_ITEM, {}, dir)
      assert.equal(again.status, 3, 'the same item again is a skip, not a post')
      assert.equal(again.stderr, '')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test("an unreachable backend is one tagged line with curl's reason and a next step", async () => {
  const r = await postTo('http://127.0.0.1:1')
  assert.equal(r.status, 4)
  assert.equal(lines(r.stderr).length, 1, `exactly one line, got: ${r.stderr}`)
  assert.match(r.stderr, /^\[unreachable-7\] POST \/item failed: cannot reach http:\/\/127\.0\.0\.1:1 — curl: \(7\)/)
  assert.match(r.stderr, /\(curl exit 7\)\. Next: /)
  assert.equal(r.marker, false, 'a failed POST did not post: the marker goes, so copying it again is not a duplicate')
})

test("an unknown user carries the server's answer and the fix", async () => {
  await withItemServer({ code: 400, body: '{"error":"unknown user \\"player1\\"","users":["someone-else"]}' }, async url => {
    const r = await postTo(url)
    assert.equal(r.status, 4)
    assert.ok(r.stderr.startsWith('[http-400-unknown-user] POST /item rejected: HTTP 400 {"error":"unknown user'), r.stderr)
    assert.match(r.stderr, /someone-else/)
    assert.match(r.stderr, /POE_USERS/)
  })
})

test('a parse failure and a missing data set are told apart', async () => {
  await withItemServer({ code: 400, body: '{"error":"item.parse_error"}' }, async url => {
    const r = await postTo(url)
    assert.equal(r.status, 4)
    assert.match(r.stderr, /^\[http-400\] /)
    assert.match(r.stderr, /admin area/)
  })
  await withItemServer({ code: 503, body: '{"error":"no parser for language \\"de\\""}' }, async url => {
    const r = await postTo(url)
    assert.equal(r.status, 4)
    assert.match(r.stderr, /^\[http-503-no-parser\] /)
    assert.match(r.stderr, /data set/)
  })
})

test('a redirect names its target and the https fix', async () => {
  // curl does not follow it, so the target is never contacted.
  await withItemServer({ code: 301, body: '', headers: { location: 'https://example.invalid/item' } }, async url => {
    const r = await postTo(url)
    assert.equal(r.status, 4)
    assert.match(r.stderr, /^\[http-301\] /)
    assert.match(r.stderr, /https:\/\/example\.invalid\/item/)
    assert.match(r.stderr, /does not follow redirects/)
    assert.match(r.stderr, /backend_url/)
  })
})

test('a long answer is cut, not dumped into the journal', async () => {
  const body = ('x'.repeat(99) + '\n').repeat(20) // 2.000 characters with line breaks
  await withItemServer({ code: 500, body }, async url => {
    const r = await postTo(url)
    assert.equal(r.status, 4)
    assert.equal(lines(r.stderr).length, 1, 'the line breaks of the answer do not reach the journal')
    assert.match(r.stderr, /…/)
    assert.ok(r.stderr.length < 300 + 200, `length ${r.stderr.length}`)
    const short = await postTo(url, EN_ITEM, { PPT_ERROR_BODY_MAX: '50' })
    const quoted = short.stderr.match(/HTTP 500 ([x ]*)…/)
    assert.ok(quoted, short.stderr)
    assert.equal(quoted[1].length, 50, 'PPT_ERROR_BODY_MAX sets how much of the answer is quoted')
  })
})

test("an answer cut off mid-transfer quotes curl's message, not the body", async () => {
  // A proxy that announces 200.000 bytes, sends 100.000 and hangs up: curl exits
  // 18. With stdout and stderr in one stream the body came first and went whole
  // into the one stderr line (about 100 KB, more than a pipe holds).
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(502, { 'content-length': '200000' })
      res.write('x'.repeat(100000), () => res.socket.destroy())
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const r = await postTo(url)
    assert.equal(r.status, 4)
    assert.equal(lines(r.stderr).length, 1, r.stderr.slice(0, 500))
    assert.ok(r.stderr.length < 300 + 400, `length ${r.stderr.length}`)
    assert.match(r.stderr, /^\[unreachable-18\] POST \/item failed: the exchange with http:\/\/127\.0\.0\.1:\d+ broke off — curl: \(18\)/)
    assert.doesNotMatch(r.stderr, /xxxx/, 'none of the body')
    assert.doesNotMatch(r.stderr, /cannot reach/, 'the server did answer')
    assert.equal(r.marker, false)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test("curl's own message is cut to PPT_ERROR_BODY_MAX, and its scratch file goes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ppt-post-err-'))
  try {
    const r = await postTo('http://127.0.0.1:1', EN_ITEM, { PPT_ERROR_BODY_MAX: '10' }, dir)
    assert.equal(r.status, 4)
    assert.match(r.stderr, / — curl: \(7\) … \(curl exit 7\)/, 'the first 10 characters of curl\'s message')
    assert.deepEqual(readdirSync(dir).filter(f => f.startsWith('ppt-post-err')), [], 'no file is left behind')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- the daemon's back channel: headers and the duplicate word -----------------
// A daemon new enough to read its feed sets PPT_DAEMON_VERSION (and
// PPT_INSTANCE). Only then does this script send X-PPT-Daemon and
// X-PPT-Instance, and name a skipped duplicate on stdout. An older daemon that
// is still running after a git pull reads this script fresh on every call and
// must see exactly the old behaviour.

/** A backend that records the headers of every POST /item. */
async function withRecordingServer (fn) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.headers)
    req.resume()
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"x-1","user":"player1"}'))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('without PPT_DAEMON_VERSION the script behaves exactly as before', async () => {
  await withRecordingServer(async (url, seen) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ppt-post-old-'))
    try {
      const clean = { ...process.env }
      delete clean.PPT_DAEMON_VERSION
      const r = await run(EN_ITEM, { ...clean, XDG_RUNTIME_DIR: dir, PPT_BACKEND_URL: url, PPT_USER: 'player1', PPT_ITEM_PREFIXES: 'Item Class: ', PPT_INSTANCE: 'ab12' })
      assert.equal(r.status, 0)
      assert.equal(r.stdout, '', 'a 2xx never writes stdout')
      assert.equal(seen.length, 1)
      assert.equal(seen[0]['x-user'], 'player1')
      assert.equal(seen[0]['x-ppt-daemon'], undefined)
      assert.equal(seen[0]['x-ppt-instance'], undefined, 'PPT_INSTANCE alone sends nothing')
      const dup = await run(EN_ITEM, { ...clean, XDG_RUNTIME_DIR: dir, PPT_BACKEND_URL: url, PPT_USER: 'player1', PPT_ITEM_PREFIXES: 'Item Class: ' })
      assert.equal(dup.status, 3)
      assert.equal(dup.stdout, '', 'a duplicate stays silent, as before')
      assert.equal(dup.stderr, '')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('with PPT_DAEMON_VERSION the daemon headers go out and a duplicate says same-item', async () => {
  await withRecordingServer(async (url, seen) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ppt-post-new-'))
    try {
      const env = { PPT_DAEMON_VERSION: '0.3.0', PPT_INSTANCE: 'ab12' }
      const r = await postTo(url, EN_ITEM, env, dir)
      assert.equal(r.status, 0)
      assert.equal(r.stdout, '', 'a 2xx never writes stdout, not even the answer')
      assert.equal(seen[0]['x-ppt-daemon'], '0.3.0')
      assert.equal(seen[0]['x-ppt-instance'], 'ab12')
      assert.equal(seen[0]['x-user'], 'player1')
      const dup = await postTo(url, EN_ITEM, env, dir)
      assert.equal(dup.status, 3)
      assert.equal(dup.stdout, 'same-item\n')
      assert.equal(dup.stderr, '')
      assert.equal(seen.length, 1, 'the duplicate sent nothing')
      const other = await postTo(url, 'some browser text', env, dir)
      assert.equal(other.status, 3)
      assert.equal(other.stdout, '', 'a non-item is not a duplicate')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('a version or instance that is not a plain token is not passed on as is', async () => {
  await withRecordingServer(async (url, seen) => {
    await postTo(url, EN_ITEM, { PPT_DAEMON_VERSION: '0.3 beta', PPT_INSTANCE: 'a-b' })
    assert.equal(seen[0]['x-ppt-daemon'], 'unknown')
    assert.equal(seen[0]['x-ppt-instance'], undefined, 'an instance with other characters is dropped')
    await postTo(url, EN_ITEM, { PPT_DAEMON_VERSION: '1.0.0+git.abc' })
    assert.equal(seen[1]['x-ppt-daemon'], '1.0.0+git.abc')
    assert.equal(seen[1]['x-ppt-instance'], undefined)
  })
})
