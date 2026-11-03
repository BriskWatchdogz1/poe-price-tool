// http-body.mjs — the bounded body reader of the hotkey daemon's routes
// (`/daemon/*`) and the JSON check in front of them. POST /item keeps its own
// unbounded readBody; these routes are new, reachable from the LAN without a
// login, and should not buffer whatever somebody sends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readBodyLimited, parseJsonBody, BodyTooLarge } from './http-body.mjs'

/** A request stand-in that emits `chunks` and records whether it was paused. */
function fakeReq (chunks) {
  const req = new EventEmitter()
  req.paused = false
  req.pause = () => { req.paused = true }
  req.destroy = () => { req.destroyed = true }
  setImmediate(() => {
    for (const c of chunks) { if (req.paused) return; req.emit('data', Buffer.from(c)) }
    if (!req.paused) req.emit('end')
  })
  return req
}

test('a body over the limit is refused and not read further', async () => {
  const req = fakeReq(['x'.repeat(3000), 'y'.repeat(2000), 'z'.repeat(2000)])
  await assert.rejects(readBodyLimited(req, 4096), e => e instanceof BodyTooLarge && e.max === 4096)
  assert.equal(req.paused, true, 'reading stops at the limit')
})

test('a body within the limit resolves as utf8', async () => {
  const text = 'ä'.repeat(50) // 100 bytes
  assert.equal(await readBodyLimited(fakeReq([text]), 4096), text)
  assert.equal(await readBodyLimited(fakeReq([]), 4096), '')
})

test('a request error rejects', async () => {
  const req = new EventEmitter()
  req.pause = () => {}
  setImmediate(() => req.emit('error', new Error('aborted')))
  await assert.rejects(readBodyLimited(req, 10), /aborted/)
})

test('parseJsonBody names a broken body and lets only plain objects through', () => {
  assert.deepEqual(parseJsonBody('nope'), { ok: false, error: 'bad json' })
  assert.deepEqual(parseJsonBody('[1]'), { ok: false, error: 'not an object' })
  assert.deepEqual(parseJsonBody('null'), { ok: false, error: 'not an object' })
  assert.deepEqual(parseJsonBody('7'), { ok: false, error: 'not an object' })
  assert.deepEqual(parseJsonBody('{"a":1}'), { ok: true, value: { a: 1 } })
})
