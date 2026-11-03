// daemon-user.mjs — the one rule every `/daemon/*` route follows to name its
// caller. Pure: the headers object in, a user or an error answer out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { daemonCaller } from './daemon-user.mjs'

const known = new Map([['player1', {}], ['player2', {}]])

test('every daemon route names a missing header and an unknown user, and never falls back to the first user', () => {
  assert.deepEqual(daemonCaller({ 'x-user': 'player1' }, known),
    { status: 400, body: { error: 'missing X-PPT-Daemon header' } })
  assert.deepEqual(daemonCaller({ 'x-ppt-daemon': '1.2.3' }, known),
    { status: 400, body: { error: 'missing X-User header' } }, 'no POE_USERS[0] fallback here')
  assert.deepEqual(daemonCaller({ 'x-ppt-daemon': '1.2.3', 'x-user': '  ' }, known),
    { status: 400, body: { error: 'missing X-User header' } })
  assert.deepEqual(daemonCaller({ 'x-ppt-daemon': '1.2.3', 'x-user': 'nobody' }, known),
    { status: 400, body: { error: 'unknown user "nobody"', users: ['player1', 'player2'] } })
  assert.deepEqual(daemonCaller({ 'x-ppt-daemon': '1.2.3', 'x-user': 'player2', 'x-ppt-instance': 'ab12' }, known),
    { user: 'player2', version: '1.2.3', instance: 'ab12' })
})

test('an instance or version that is not a short token is replaced, not passed on', () => {
  const h = { 'x-ppt-daemon': '1.2.3', 'x-user': 'player1' }
  assert.equal(daemonCaller({ ...h, 'x-ppt-instance': 'a b' }, known).instance, 'default')
  assert.equal(daemonCaller(h, known).instance, 'default', 'no instance header')
  assert.equal(daemonCaller({ ...h, 'x-ppt-instance': 'x'.repeat(33) }, known).instance, 'default')
  assert.equal(daemonCaller({ ...h, 'x-ppt-daemon': '1.2\n3' }, known).version, 'unknown')
  assert.equal(daemonCaller({ ...h, 'x-ppt-daemon': '<script>' }, known).version, 'unknown')
})

test('POST /item reads its instance header by the same rule', async () => {
  const { daemonInstanceOf } = await import('./daemon-user.mjs')
  assert.equal(daemonInstanceOf('ab12'), 'ab12')
  assert.equal(daemonInstanceOf(undefined), 'default')
  assert.equal(daemonInstanceOf('a b'), 'default')
})
