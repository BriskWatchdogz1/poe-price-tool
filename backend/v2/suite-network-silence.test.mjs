// "A test run reaches nobody" — the claim, and the two things that make it true.
//
// The claim was made repeatedly and was false. Measured on 2026-08-18 by
// preloading a recording wrapper around `fetch` and `http/https.request` into
// every test process: one suite run sent ~55 requests to poe.ninja, from eleven
// files that boot the real server. Nothing went to GGG — that half was checked
// and held.
//
// WHY THE EXISTING INSTRUMENT DID NOT CATCH IT. `server-no-network.test.mjs`
// replaces `globalThis.fetch` before importing the server, records everything
// and rejects anything non-loopback. All of that is true INSIDE ITS OWN
// PROCESS, and `run-tests.mjs` starts one process per file. It was measuring the
// single file that was already quiet and reporting on all of them. A guard that
// lives inside one of the things it guards cannot see the others.
//
// So there are two guards now, and this file holds both of them to their claims:
//
//   1. run-tests.mjs preloads `test-net-guard.mjs` into every process it starts.
//      That is the MEASUREMENT, it covers every file including ones written
//      tomorrow, and it blocks rather than watching, so a regression cannot
//      reach anybody even once.
//   2. Every file that boots server.mjs applies the full switch set from
//      `test-quiet-env.mjs`. That is the FIX, and it is checked statically here:
//      guard (1) only fires while a leak exists, and a new file with the same
//      half-remembered switch list should fail on the list, not on the traffic.
//
// Nothing here reaches the network: it reads its own repository.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { QUIET_ENV, quietEnv } from './test-quiet-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

async function testFiles (dir = HERE) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await testFiles(full))
    else if (entry.name.endsWith('.test.mjs')) out.push(full)
  }
  return out.sort()
}

/** Files that BOOT the server, either in-process or as a child. */
async function serverBooters () {
  const out = []
  for (const f of await testFiles()) {
    const src = await readFile(f, 'utf8')
    const inProcess = /import\(['"][^'"]*\/?server\.mjs['"]\)/.test(src)
    const asChild = /spawn\(\s*process\.execPath\s*,\s*\[[^\]]*server\.mjs/.test(src)
    if (inProcess || asChild) out.push({ file: f, src, rel: path.relative(HERE, f) })
  }
  return out
}

test('the switch set is one list, and it holds the one that keeps being forgotten', () => {
  // POE_REFERENCE_DISABLED covers the warm-up at BOOT. The requests that were
  // being sent came from warmLeague(), which runs when a WEBSOCKET connects —
  // and every browser test opens one. A file setting the first and not the
  // second looked complete and was not, twice (docs/bugs.md B12, then B25).
  assert.equal(QUIET_ENV.POE_REFERENCE_DISABLED, '1')
  assert.equal(QUIET_ENV.POE_REFERENCE_ON_CONNECT_DISABLED, '1')
  assert.equal(QUIET_ENV.POE_PRICE_CHECK_DISABLED, '1')
  assert.equal(QUIET_ENV.POE_NETWORTH_AUTOSYNC, '0')
  // The third kind of traffic: neither a schedule nor a warm-up nor a price
  // check, but a REQUEST the browser makes to fill its league dropdown. It was
  // the only thing left reaching out once the list above was applied everywhere,
  // and it is only reachable from a browser-driven test.
  assert.equal(QUIET_ENV.POE_LEAGUE_LIST_DISABLED, '1')
  for (const k of ['POE_FAUSTUS_DISABLED', 'POE_CORPSE_DISABLED', 'POE_DATA_REFRESH_DISABLED', 'POE_RELEASE_CHECK_DISABLED']) {
    assert.equal(QUIET_ENV[k], '1', k)
  }
})

test('quietEnv() writes the whole set and returns the environment it wrote to', () => {
  const env = {}
  assert.equal(quietEnv(env), env)
  assert.deepEqual(env, { ...QUIET_ENV })
})

test('every test file that boots the server applies the full switch set', async () => {
  const booters = await serverBooters()
  assert.ok(booters.length >= 20, `expected the suite to boot the server in many files, found ${booters.length}`)
  const offenders = []
  for (const { src, rel } of booters) {
    // Either it imports the list, or it writes every one of them out itself.
    // The second is allowed — a file may have a reason to be explicit — but it
    // has to be COMPLETE, which is the thing that kept not happening.
    if (/test-quiet-env\.mjs/.test(src)) continue
    const missing = Object.keys(QUIET_ENV).filter(k => !src.includes(k))
    if (missing.length) offenders.push(`${rel}: ${missing.join(', ')}`)
  }
  assert.deepEqual(offenders, [],
    'these boot server.mjs without the full switch set — import QUIET_ENV/quietEnv from ' +
    'test-quiet-env.mjs rather than writing the list out again')
})

test('the runner preloads the guard into every process it starts', async () => {
  // The claim only holds while this wiring is there, and a runner is not
  // something any other test looks at.
  const runner = await readFile(path.join(HERE, 'run-tests.mjs'), 'utf8')
  assert.match(runner, /test-net-guard\.mjs/,
    'run-tests.mjs no longer preloads the network guard — the suite is unmeasured again')
  assert.match(runner, /NODE_OPTIONS/,
    'the guard has to travel to child processes too: a test that spawns server.mjs starts one')
  assert.match(runner, /noisy\.length \? 1 : 0|\|\| noisy\.length/,
    'a blocked outbound request has to turn the run red, or the measurement is a log line')
})

test('the guard lets loopback through and refuses everything else', async () => {
  // Read rather than imported: importing it would install it in THIS process,
  // and a guard that rewrote fetch for the file testing it would be testing
  // itself in a state no other file is in.
  const guard = await readFile(path.join(HERE, 'test-net-guard.mjs'), 'utf8')
  assert.match(guard, /127\.0\.0\.1/, 'the suite boots real servers on loopback and talks to them')
  assert.match(guard, /globalThis\.fetch\s*=/, 'fetch is the path almost everything takes')
  assert.match(guard, /http\.request|mod\.request\s*=/, 'and not everything takes it')
  assert.match(guard, /outbound request blocked/, 'it blocks; recording and forwarding is still a request')
})

test('the guard really blocks, really reports, and the runner really reads it', () => {
  // THE NEGATIVE CONTROL. Every claim above is about wiring being present; this
  // one makes a real outbound request in a real child process and follows it all
  // the way to the line the runner turns red on. Without it the whole
  // arrangement could be inert and every assertion in this file would still
  // pass — which is exactly how the previous instrument managed to report on a
  // suite that was sending 55 requests a run.
  const guard = pathToFileURL(path.join(HERE, 'test-net-guard.mjs')).href
  const r = spawnSync(process.execPath, [
    '--import=' + guard,
    '-e',
    // Rejected, and swallowed the way a fire-and-forget warm-up swallows it —
    // the case the guard has to survive, since there is no assertion to fail.
    "fetch('https://poe.ninja/poe1/api/economy/leagues').then(() => {}, () => {})"
  ], { encoding: 'utf8' })

  const out = (r.stdout || '') + (r.stderr || '')
  assert.match(out, /outbound blocked: https:\/\/poe\.ninja/,
    'the guard did not report a request it was supposed to block')

  // And the runner's own expression, read out of the runner, applied to what a
  // test process really produces — including the `# ` the TAP reporter puts in
  // front of anything written to stderr. The two drifting apart is a silent
  // failure of the measurement, so it is not left to a comment.
  const runner = readFileSync(path.join(HERE, 'run-tests.mjs'), 'utf8')
  const decl = /const NET_GUARD_LINE = (\/.*\/[gimsuy]*)\n/.exec(runner)
  assert.ok(decl, 'run-tests.mjs no longer declares NET_GUARD_LINE on one line')
  const body = decl[1].slice(1, decl[1].lastIndexOf('/'))
  const flags = decl[1].slice(decl[1].lastIndexOf('/') + 1)
  const re = new RegExp(body, flags)

  const asTapWouldPrintIt = out.split('\n')
    .filter(l => l.includes('outbound blocked:'))
    .map(l => '# ' + l.trim())
    .join('\n')
  const hits = [...asTapWouldPrintIt.matchAll(re)]
  assert.equal(hits.length, 1, `the runner would not see this line: ${JSON.stringify(asTapWouldPrintIt)}`)
  assert.match(hits[0][1], /poe\.ninja/, 'and it has to capture WHICH host was reached')
})

test('the league list has a switch, and switching it off still answers usefully', async () => {
  // A dropdown that loses the league everybody here is on would be a fix that
  // costs more than it saves, so the disabled path answers with what the
  // installation knows WITHOUT asking anybody: the configured users' leagues
  // plus the fallbacks. That is a fact about this configuration, not a guess at
  // what poe.ninja would have said.
  const src = await readFile(path.join(HERE, 'server.mjs'), 'utf8')
  assert.match(src, /POE_LEAGUE_LIST_DISABLED/)
  assert.match(src, /if \(LEAGUE_LIST_DISABLED\) return knownLeagues\(\)/,
    'the switch has to short-circuit BEFORE the fetch, not filter its result')
  assert.match(src, /function knownLeagues \(\)[\s\S]{0,220}FALLBACK_LEAGUES/,
    'the answer has to include the fallbacks')
  assert.match(src, /function knownLeagues \(\)[\s\S]{0,220}USERS\.map/,
    'and the leagues the configured users are on, or the dropdown drops the live one')
})
