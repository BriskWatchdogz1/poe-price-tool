// source-health.mjs: the facts the page needs to say how old each price source
// is and why it stopped. It stores, it does not judge — the client ages the
// values against the server clock, like data-status.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSourceHealth, SOURCE_IDS, PRICE_SOURCES } from './source-health.mjs'

function rig (opts = {}) {
  let t = 0
  const events = []
  const h = createSourceHealth({ now: () => t, onChange: (src, ev) => events.push([src, ev]), ...opts })
  return { h, events, at: v => { t = v } }
}

test('ok after failures clears failing and keeps the newest success time', () => {
  const { h, at } = rig()
  at(10); h.fail('ninja-cd', 'HTTP 503', 'unreachable')
  at(20); h.ok('ninja-cd')
  assert.equal(h.get('ninja-cd').lastSuccessAt, 20)
  assert.equal(h.get('ninja-cd').failures, 0)
  h.ok('ninja-cd', { at: 5 })
  assert.equal(h.get('ninja-cd').lastSuccessAt, 20, 'an older success must not move the clock back')
})

test('fail stores a cleaned, capped reason and a known kind', () => {
  const { h } = rig({ reasonMaxChars: 60 })
  h.fail('faustus', 'line one\nline two token=abc' + ' x'.repeat(100), 'weird')
  const r = h.get('faustus')
  assert.ok(!r.reason.includes('\n'))
  assert.ok(r.reason.includes('***'))
  assert.ok(!r.reason.includes('abc'))
  assert.ok(r.reason.length <= 60)
  assert.equal(r.failKind, 'unknown')
  h.fail('faustus', 'x', 'unreachable')
  assert.equal(h.get('faustus').failKind, 'unreachable')
  assert.equal(h.get('faustus').failures, 2)
})

test('onChange fires started on the first failure and recovered on the first success after it; seed is silent', () => {
  const { h, events, at } = rig()
  h.seed('faustus', { lastSuccessAt: 3 })
  assert.equal(events.length, 0)
  assert.equal(h.get('faustus').lastSuccessAt, 3)
  at(10); h.fail('ninja-overview', 'HTTP 503')
  at(11); h.fail('ninja-overview', 'HTTP 503')
  at(12); h.ok('ninja-overview')
  at(13); h.ok('ninja-overview')
  assert.deepEqual(events.map(e => e[1]), [
    { started: true }, { started: false }, { recovered: true }, { recovered: false }
  ])
  assert.ok(events.every(e => e[0] === 'ninja-overview'))
})

test('snapshot lists the four sources in fixed order; an unknown id throws', () => {
  const { h } = rig()
  assert.deepEqual(h.snapshot().map(s => s.source), ['faustus', 'ninja-cd', 'ninja-overview', 'trade'])
  assert.deepEqual([...SOURCE_IDS], ['faustus', 'ninja-cd', 'ninja-overview', 'trade'])
  assert.deepEqual([...PRICE_SOURCES], ['faustus', 'ninja-cd', 'ninja-overview'])
  assert.deepEqual(Object.keys(h.snapshot()[0]).sort(),
    ['failKind', 'failures', 'lastFailureAt', 'lastSuccessAt', 'reason', 'source'])
  assert.throws(() => h.ok('nope'), /unknown source nope/)
  assert.throws(() => h.fail('nope', 'x'), /unknown source/)
})
