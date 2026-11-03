// fail-log.mjs: one line when a key starts failing, one when it recovers, and
// in between at most one per interval. The defect it replaces is two-sided:
// ninja.mjs warned about a network error once per PROCESS (and never said when
// it worked again), and logged every non-ok answer EVERY time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFailureLog, fmtDuration } from './fail-log.mjs'

const MIN = 60 * 1000

function rig (everyMs = 60 * MIN) {
  let t = 1_000_000
  const lines = []
  const log = { warn: (...a) => lines.push(a.join(' ')) }
  const fl = createFailureLog({ prefix: '[ninja]', everyMs, now: () => t, log })
  return { fl, lines, advance: ms => { t += ms } }
}

test('the first failure of a key logs once, repeats inside everyMs are silent', () => {
  const { fl, lines, advance } = rig()
  const subject = 'exchange overview league=L type=T'
  fl.fail('k', subject, 'HTTP 503')
  advance(4 * MIN); fl.fail('k', subject, 'HTTP 503')
  advance(5 * MIN); fl.fail('k', subject, 'HTTP 503')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[ninja\] exchange overview league=L type=T failing: HTTP 503$/)
})

test('a failure after everyMs logs a still-failing line with duration and attempt count', () => {
  const { fl, lines, advance } = rig()
  fl.fail('k', 's', 'HTTP 503')
  advance(61 * MIN); fl.fail('k', 's', 'HTTP 503')
  assert.equal(lines.length, 2)
  assert.match(lines[1], /still failing after 1 h \(\d+ attempts\): HTTP 503/)
})

test('a success after failures logs one recovered line, a success without failure logs nothing', () => {
  const { fl, lines, advance } = rig()
  fl.ok('unknown', 's')
  assert.equal(lines.length, 0)
  fl.fail('k', 's', 'HTTP 503')
  advance(20 * MIN)
  fl.ok('k', 's')
  assert.equal(lines.length, 2)
  assert.match(lines[1], /recovered after .* \(1 failed attempts\)/)
  fl.ok('k', 's')
  assert.equal(lines.length, 2)
})

test('everyMs 0 logs every failure, and keys are independent', () => {
  const a = rig(0)
  a.fl.fail('k', 's', 'x'); a.fl.fail('k', 's', 'x'); a.fl.fail('k', 's', 'x')
  assert.equal(a.lines.length, 3)
  const b = rig()
  b.fl.fail('A', 'a', 'x'); b.fl.fail('B', 'b', 'x')
  assert.equal(b.lines.length, 2)
  assert.match(b.lines[0], /a failing: x/)
  assert.match(b.lines[1], /b failing: x/)
})

test('fmtDuration: minutes under an hour, hours under two days, days beyond', () => {
  assert.equal(fmtDuration(0), '1 min')
  assert.equal(fmtDuration(20 * MIN), '20 min')
  assert.equal(fmtDuration(61 * MIN), '1 h')
  assert.equal(fmtDuration(47 * 60 * MIN), '47 h')
  assert.equal(fmtDuration(72 * 60 * MIN), '3 d')
})
