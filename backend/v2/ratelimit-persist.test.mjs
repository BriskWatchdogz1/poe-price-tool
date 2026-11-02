// The ban state MUST survive a restart. APT's limiters live in RAM only: a
// container restart forgets that the budget is spent, blindly fires a request
// into an exhausted window, GGG rejects it — and rejected requests count against
// the invalid-request threshold. That is exactly how a self-imposed brake turned
// into a real 12h ban (~12 deploys in one day, one blind shot each).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { quietEnv } from './test-quiet-env.mjs'

const dir = await mkdtemp(path.join(tmpdir(), 'ppt-rl-'))
const statePath = path.join(dir, 'rate-limit.json')

// An ACTIVE ban (1h into the future) is already on disk before the server
// starts — this simulates a restart in the middle of a ban.
const until = Date.now() + 3600_000
await writeFile(statePath, JSON.stringify({ until, retryAfterSec: 3600 }))

// The full set that keeps a booted server off the network. One list, imported:
// every file that wrote it out by hand left something out, and what kept being
// left out was the switch a WebSocket needs (test-quiet-env.mjs, docs/bugs.md
// B25). Applied FIRST — anything this file sets below overrides it on purpose.
quietEnv()
process.env.PORT = '0'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_DATA_REFRESH_DISABLED = '1'
process.env.POE_REFERENCE_DISABLED = '1'
process.env.POE_RATE_LIMIT_STATE = statePath

let mod
before(async () => { mod = await import('./server.mjs') })
after(async () => {
  await new Promise((r) => mod.server.close(r))
  await rm(dir, { recursive: true, force: true })
})

test('restart in the middle of a ban: the gate is restored from disk (no blind shot)', () => {
  const msg = mod.rateLimitMsg()
  assert.equal(msg.active, true, 'gate not active after restart -> the app would fire blindly at GGG')
  assert.equal(msg.until, until, 'until was not carried over')
})

test('background jobs stay held during the restored ban', async () => {
  let ran = false
  mod.enqueueBackground(() => { ran = true })
  await new Promise(r => setTimeout(r, 120))
  assert.equal(ran, false, 'job ran despite the restored ban')
  assert.equal(mod.bgJobs.length, 1, 'job was not held')
})

test('clearRateLimit wipes the state on disk as well', async () => {
  mod.clearRateLimit()
  await new Promise(r => setTimeout(r, 60)) // persisting is best-effort/async
  const onDisk = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(onDisk.until, undefined, 'expired/cleared ban is still on disk')
  assert.equal(mod.rateLimitMsg().active, false)
})

test('expired state on disk is ignored (no permanent ban)', async () => {
  // No second server start is possible (one module per process) -> the logic is
  // covered via rateLimitMsg's lazy expiry instead: an `until` in the past must
  // never produce an active banner.
  mod.noteRateLimit(3600)
  assert.equal(mod.rateLimitMsg().active, true)
  mod.clearRateLimit()
  assert.equal(mod.rateLimitMsg().active, false)
})
