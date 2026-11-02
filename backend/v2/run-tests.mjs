#!/usr/bin/env node
// Test runner that can be trusted about how many tests ran.
//
// WHY THIS EXISTS. The package script used to be
// `node --test --test-force-exit backend/v2`. That flag ends the process the
// moment the root test settles, while output is still being flushed, so the
// totals were not merely imprecise but different every run: three consecutive
// runs of the same tree reported 916, 923 and 933 passing, each with zero
// failures. Counting `^ok` lines did not rescue it — that count moved too, and
// the directory run additionally emits one `ok` per *file* on top of the real
// tests. The danger is not the wrong number. It is that "all green" and
// "seventeen files never reported" print the same thing.
//
// The flag was there because `node --test backend/v2` in ONE process did not
// terminate. Measured per file, that was the exception — most files exit
// cleanly on their own, and then their output is complete and their count is
// exact (`faustus.test.mjs`: 43 of 43 without the flag, 40 with it).
//
// Two files did not, and they turned out to be the whole reason for the flag:
// `server.test.mjs` and `server-langs.test.mjs` boot the real server, and the
// items they POST were auto-priced against the live Trade API, whose rate-limit
// bookkeeping holds a timer for the length of every window it learns — hours,
// in a process whose HTTP server is already closed. Both now set
// POE_PRICE_CHECK_DISABLED=1 (docs/bugs.md B11, closed), and with that
// `node --test backend/v2` terminates again: three consecutive runs, 23-24 s,
// 1009 passing each time, the same total this runner reports.
//
// That removes the reason for the flag, not the reason for this file. One
// process per file is what makes the three outcomes below distinguishable at
// all — a shared process cannot say WHICH file failed to exit, a load error in
// one file takes the rest with it, and every `process.env` a test sets is still
// set for every file after it. So: one process per file, no force-exit, and a
// timeout as the backstop. A file that terminates gives a number you can quote.
// A file that does not is named as such — its count is a lower bound, and it is
// a leak worth fixing rather than a fact of life. There is now a worked example
// of fixing one.
//
// Usage:
//   node backend/v2/run-tests.mjs             all *.test.mjs under backend/v2
//   node backend/v2/run-tests.mjs networth    only files whose path contains that
//   VERBOSE=1 ...                             stream each file's own output
//   TEST_TIMEOUT_MS=300000 ...                per-file backstop (default 180s)

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(ROOT, '../..')
const filter = process.argv[2] || ''
const VERBOSE = process.env.VERBOSE === '1'
const TIMEOUT = Number(process.env.TEST_TIMEOUT_MS) || 180_000

function testFiles (dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...testFiles(full))
    else if (entry.endsWith('.test.mjs')) out.push(full)
  }
  return out.sort()
}

const files = testFiles(ROOT).filter(f => f.includes(filter))
if (!files.length) {
  console.error(filter ? `no test file matches "${filter}"` : 'no test files found')
  process.exit(1)
}

let pass = 0, fail = 0, skip = 0
const failing = [], leaked = [], broken = [], noisy = []

// THE NETWORK GUARD, preloaded into every process this runner starts.
//
// The claim "a test run reaches nobody" was made repeatedly and was false: a run
// sent about 55 requests to poe.ninja, out of eleven files that boot the real
// server (docs/bugs.md B25). The instrument that was supposed to catch that,
// `server-no-network.test.mjs`, could not: it replaces `globalThis.fetch` in its
// OWN process, and this runner starts one process per file — so it was measuring
// the single file that was already quiet and reporting on all of them.
//
// Preloading fixes exactly that. Every file is watched, and so is every process
// a file starts, because NODE_OPTIONS is inherited: the tests that spawn the
// real server as a child get the guard inside the server too.
//
// It is prepended to any NODE_OPTIONS already in the environment rather than
// replacing it, so running the suite under a debugger or a coverage flag still
// works.
const GUARD = pathToFileURL(path.join(ROOT, 'test-net-guard.mjs')).href
const CHILD_ENV = {
  ...process.env,
  NODE_OPTIONS: `--import=${GUARD}${process.env.NODE_OPTIONS ? ' ' + process.env.NODE_OPTIONS : ''}`
}

for (const file of files) {
  const rel = path.relative(REPO, file)
  const r = spawnSync(process.execPath, ['--test', file], {
    encoding: 'utf8', cwd: REPO, timeout: TIMEOUT, killSignal: 'SIGKILL', env: CHILD_ENV
  })
  const out = (r.stdout || '') + (r.stderr || '')
  if (VERBOSE) process.stdout.write(out)

  const ok = (out.match(/^ok \d+ /gm) || []).length
  const notOk = (out.match(/^not ok \d+ /gm) || []).length
  const skipped = (out.match(/^ok \d+ .*# (SKIP|TODO)/gm) || []).length
  pass += ok - skipped; fail += notOk; skip += skipped

  // A file with no tests at all still prints `ok 1 - <path>`: node reports the
  // FILE as the passing thing. Left alone that reads as a green test, which is
  // how a file that silently stopped defining tests would hide. One `ok` whose
  // description is the file itself is that case, not a test.
  const soleFileOk = ok === 1 && notOk === 0 &&
    new RegExp(`^ok 1 - .*${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(out)
  if (soleFileOk) { pass -= 1; broken.push({ rel, status: r.status, tail: 'the file defines no tests' }) }

  // Diagnostics a test writes on purpose (`t.diagnostic(...)`) are the point of
  // some files — corpus-parity lists what the corpus is still missing. Node
  // folds its own process warnings into the same `# ` comments, but those come
  // before the first result line, so anything after it is the test talking.
  const diagnostics = []
  let started = false
  for (const line of out.split('\n')) {
    if (/^(ok|not ok) \d+ /.test(line)) { started = true; continue }
    if (!started) continue
    const m = /^# (?!Subtest:)(.*)$/.exec(line)
    if (m && !/^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms|start) /.test(m[1])) {
      diagnostics.push(m[1])
    }
  }

  // Three different things, and they must not be conflated:
  //   timed out  — tests likely all ran, but the process would not exit. The
  //                count is a LOWER bound and the file owes the suite a cleanup.
  //   crashed    — non-zero exit with no failed assertion: it died, hung on
  //                load, or threw outside a test. Must never look like a pass.
  //   failed     — an actual assertion failed.
  const timedOut = r.signal === 'SIGKILL' || r.error?.code === 'ETIMEDOUT'
  const crashed = !timedOut && r.status !== 0 && notOk === 0

  // What the guard blocked, if anything. Reported as its own outcome and not as
  // a failure of the file: the request usually comes from a fire-and-forget
  // warm-up that swallows its own rejection, so there is no assertion for it to
  // fail. It still turns the run red at the bottom.
  // The `# ` is node's doing: the guard writes to stderr, and the TAP reporter
  // folds anything a test process prints into a comment. Matching without
  // allowing for it is how this check measured nothing while looking like it
  // worked — the same shape of defect as the one it reports on, which is why
  // suite-network-silence.test.mjs runs a real leak past this exact expression.
  // KEEP THE NEXT LINE ON ONE LINE: that test reads it out of this file.
  const NET_GUARD_LINE = /^[#\s]*\[net-guard\] outbound blocked: (.*)$/gm
  const blocked = [...out.matchAll(NET_GUARD_LINE)].flatMap(m => m[1].trim().split(/\s+/))
  if (blocked.length) noisy.push({ rel, urls: [...new Set(blocked)] })

  if (timedOut) leaked.push({ rel, ok: ok - skipped })
  if (crashed) broken.push({ rel, status: r.status, tail: out.trim().split('\n').slice(-3).join(' | ') })
  if (notOk) failing.push({ rel, notOk })

  const mark = crashed ? 'CRASH' : notOk ? 'FAIL ' : timedOut ? 'LEAK ' : blocked.length ? 'NET  ' : '  ok '
  const skipCol = skipped ? `${String(skipped).padStart(2)} skip  ` : '         '
  console.log(`${mark} ${String(ok - skipped).padStart(4)} pass  ${String(notOk).padStart(2)} fail  ${skipCol}${rel}`)
  if (!VERBOSE) for (const d of diagnostics) console.log(`       | ${d}`)
}

console.log('\n' + '-'.repeat(74))
console.log(`${files.length} files   ${pass} pass   ${fail} fail   ${skip} skip` +
  (leaked.length ? `   (${leaked.length} file(s) did not exit — see below)` : ''))

if (failing.length) {
  console.log('\nfailed:')
  for (const f of failing) console.log(`  ${f.rel} (${f.notOk})`)
}
if (broken.length) {
  console.log('\ndid not report a result (crash or load error):')
  for (const b of broken) console.log(`  ${b.rel} — exit ${b.status} — ${b.tail}`)
}
if (noisy.length) {
  console.log('\nREACHED OUTSIDE THE MACHINE (blocked, but the request was attempted).')
  console.log('Nothing was sent — but "the suite reaches nobody" is not true while this list is not empty.')
  console.log('A file that boots server.mjs has to apply the full switch set: backend/v2/test-quiet-env.mjs.')
  for (const n of noisy) console.log(`  ${n.rel} — ${n.urls.join(', ')}`)
}
if (leaked.length) {
  console.log(`\ndid not exit within ${TIMEOUT / 1000}s — something is left running (server, browser, timer).`)
  console.log('Their tests still ran, but their counts above are a lower bound:')
  for (const l of leaked) console.log(`  ${l.rel}`)
}

process.exit(fail || broken.length || noisy.length ? 1 : 0)
