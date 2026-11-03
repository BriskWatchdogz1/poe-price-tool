// MIN_TESTS: the floor the runner itself puts under the number of passing tests.
//
// A CI job that only checks the exit code cannot tell a green run from a run in
// which half the files quietly stopped defining tests, or a filter that matched
// fewer files than meant: "0 fail" holds for both. The runner already refuses a
// file that defines no tests at all (see run-tests.mjs); MIN_TESTS covers the
// rest of that shape from the outside. Set, the run ends with exit 1 when fewer
// tests passed than it says — skips do not count, they did not pass. A value
// that is not a whole number ends the run at once instead of being ignored,
// because an ignored floor reads exactly like a met one.
//
// The runner is driven for real, on one small file of its own suite
// (run-tests-doc.test.mjs), so the floor is measured against a count the runner
// actually produced rather than against a number written into this file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, 'run-tests.mjs')
const FILTER = 'run-tests-doc.test.mjs'

function run (min) {
  const env = { ...process.env }
  delete env.MIN_TESTS
  // Set by `node --test` for the processes it runs. Inherited by the runner's
  // own `node --test` children, it makes them report to a parent that is not
  // listening, and the runner then counts 0 of everything.
  delete env.NODE_TEST_CONTEXT
  if (min !== undefined) env.MIN_TESTS = String(min)
  const r = spawnSync(process.execPath, [RUNNER, FILTER], { encoding: 'utf8', env, timeout: 120_000 })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const passCount = out => {
  const m = /^(\d+) files\s+(\d+) pass\s+(\d+) fail/m.exec(out)
  assert.ok(m, `no total line in the runner output:\n${out}`)
  return Number(m[2])
}

test('without MIN_TESTS the run is judged as before', () => {
  const r = run()
  assert.equal(r.status, 0, r.out)
  assert.ok(passCount(r.out) >= 1, 'the file under the runner has to pass something')
  assert.doesNotMatch(r.out, /MIN_TESTS/, 'no floor set, nothing said about one')
})

test('a floor the run meets keeps it green and says so', () => {
  const n = passCount(run().out)
  const r = run(n)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, new RegExp(`MIN_TESTS=${n}: met \\(${n} pass\\)`))
})

test('a floor above the pass count turns the run red and names both numbers', () => {
  const n = passCount(run().out)
  const r = run(n + 1)
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, new RegExp(`only ${n} test\\(s\\) passed, MIN_TESTS requires ${n + 1}`))
})

test('an empty MIN_TESTS is the same as none', () => {
  const r = run('')
  assert.equal(r.status, 0, r.out)
  assert.doesNotMatch(r.out, /MIN_TESTS/)
})

test('a MIN_TESTS that is not a whole number stops the run before any test', () => {
  for (const bad of ['abc', '1900.5', '-1', '19 00']) {
    const r = run(bad)
    assert.equal(r.status, 1, `${bad}: ${r.out}`)
    assert.match(r.out, /MIN_TESTS must be a whole number/, bad)
    assert.doesNotMatch(r.out, /\bpass\b.*\bfail\b/, `${bad}: no file may run under a floor that could not be read`)
  }
})
