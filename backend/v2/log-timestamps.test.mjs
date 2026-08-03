// Timestamps on every log line (log-timestamps.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installLogTimestamps, timestamp } from './log-timestamps.mjs'

function fakeConsole () {
  const lines = []
  const push = (...a) => lines.push(a)
  return { lines, log: push, info: push, warn: push, error: push, debug: push }
}

const FIXED = Date.UTC(2026, 6, 31, 14, 3, 21, 456)

test('timestamp: ISO to the second, UTC, sortable', () => {
  assert.equal(timestamp(FIXED), '2026-07-31T14:03:21Z')
  assert.ok(timestamp(FIXED) < timestamp(FIXED + 1000), 'lexical order = chronological order')
})

test('prefixes log/warn/error and keeps the message intact', () => {
  const c = fakeConsole()
  const off = installLogTimestamps({ target: c, now: () => FIXED })
  c.log('[server] hello')
  c.warn('[data-refresh] APT check failed (kept last good state): boom')
  off()
  assert.equal(c.lines[0][0], '2026-07-31T14:03:21Z [server] hello')
  // The substring the existing suite asserts on must survive the prefix.
  assert.ok(c.lines[1][0].includes('check failed (kept last good state)'))
})

test('printf-style arguments still work (format string keeps its slots)', () => {
  const c = fakeConsole()
  const off = installLogTimestamps({ target: c, now: () => FIXED })
  c.log('[corpse] %s took %dms', 'tick', 12)
  off()
  assert.deepEqual(c.lines[0], ['2026-07-31T14:03:21Z [corpse] %s took %dms', 'tick', 12])
})

test('non-string first argument -> timestamp as its own argument', () => {
  const c = fakeConsole()
  const off = installLogTimestamps({ target: c, now: () => FIXED })
  const err = new Error('nope')
  c.error(err)
  off()
  assert.deepEqual(c.lines[0], ['2026-07-31T14:03:21Z', err])
})

test('idempotent and reversible: no double prefix, uninstall restores', () => {
  const c = fakeConsole()
  const off1 = installLogTimestamps({ target: c, now: () => FIXED })
  const off2 = installLogTimestamps({ target: c, now: () => FIXED })
  assert.equal(off1, off2, 'second install is a no-op')
  c.log('once')
  assert.equal(c.lines[0][0], '2026-07-31T14:03:21Z once')
  off1()
  c.log('bare')
  assert.deepEqual(c.lines[1], ['bare'])
})
