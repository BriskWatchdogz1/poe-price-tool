// A file that does not exit turns the run red.
//
// The runner names such a file as a LEAK: its tests ran, but something it
// started (a server, a browser, a timer) kept the process alive until the
// per-file timeout killed it, so its count is only a lower bound. A line alone
// is not enough: with exit code 0 whenever the tests passed before the
// timeout, a job that reads nothing but the exit code (the CI workflow) takes
// a hanging file for a green one. CONTRIBUTING.md says
// the absence of any LEAK line is part of a green run; this holds the runner to
// it.
//
// The file is its own fixture. Run directly, it drives the runner on itself
// with LEAK_FIXTURE=1 in the environment, which the runner passes on to the
// file's own process; there it defines one passing test and keeps a timer
// open, so the process does not end until the runner's timeout kills it. In a
// normal `npm test` run LEAK_FIXTURE is unset and only the driving test runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const RUNNER = path.join(path.dirname(SELF), 'run-tests.mjs')

if (process.env.LEAK_FIXTURE === '1') {
  test('passes, then leaves a timer running', () => {
    setInterval(() => {}, 60_000)
  })
} else {
  test('a file that passes but does not exit ends the run with exit 1', () => {
    const env = { ...process.env, LEAK_FIXTURE: '1', TEST_TIMEOUT_MS: '3000' }
    delete env.MIN_TESTS
    delete env.VERBOSE
    // Set by `node --test` for the processes it runs; inherited by the runner's
    // own `node --test` children, it makes them report to a parent that is not
    // listening (see run-tests-min.test.mjs).
    delete env.NODE_TEST_CONTEXT
    const r = spawnSync(process.execPath, [RUNNER, path.basename(SELF)], { encoding: 'utf8', env, timeout: 60_000 })
    const out = (r.stdout || '') + (r.stderr || '')
    assert.match(out, /^LEAK\s+\d+ pass\s+0 fail\s+.*run-tests-leak\.test\.mjs$/m, out)
    assert.match(out, /^1 files\s+\d+ pass\s+0 fail\s+0 skip\s+\(1 file\(s\) did not exit/m, out)
    assert.equal(r.status, 1, out)
  })
}
