// The release check as the server exposes it: the `release-status` message on
// connect, the open GET /release-status, and the admin-gated POST
// /admin/release-check, against the REAL server.mjs booted in this process.
//
// WHAT IS REPLACED, AND WHERE. `globalThis.fetch` is swapped BEFORE the import
// (the server's release check takes `fetch` as its default at construction), and
// the replacement answers api.github.com with a canned release and passes
// everything else — the loopback calls this file makes to its own server —
// through to the real one. Nothing leaves the machine: the net guard
// (test-net-guard.mjs) would turn the run red if anything did.
//
// The automatic schedule is off (`POE_RELEASE_CHECK_DISABLED=1` via QUIET_ENV),
// so the only request that ever reaches the stub is the one the POST causes.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { quietEnv } from './test-quiet-env.mjs'

const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
const [major] = packageVersion.split('.').map(Number)
// One major above what is installed, whatever the package says today.
const CANNED_TAG = `v${major + 1}.0.0`
const REPO = 'example-owner/example-repo'

const tmp = mkdtempSync(join(tmpdir(), 'ppt-release-'))
quietEnv()
process.env.PORT = '0'
process.env.POE_USERS = 'player1,player2'
process.env.POE_RELEASE_REPO = REPO
process.env.POE_RELEASE_CHECK_STATE = join(tmp, 'release-check.json')
process.env.POE_CONFIG_OVERRIDES = join(tmp, 'overrides.json')
process.env.POE_USER_LANG_STORE = join(tmp, 'user-langs.json')
process.env.POE_ADMIN_PASSWORD_FILE = join(tmp, 'admin-password')
process.env.POE_NETWORTH_CONFIG = join(tmp, 'networth-users.json')
process.env.POE_NETWORTH_STORE = join(tmp, 'networth-store.json')
process.env.POE_NETWORTH_HISTORY = join(tmp, 'networth-history.ndjson')
process.env.POE_FAUSTUS_STORE = join(tmp, 'faustus-store.json')
process.env.POE_CORPSE_STORE = join(tmp, 'corpse-store.json')
process.env.POE_UPDATE_DIR = join(tmp, 'update')
process.env.POE_DATA_REFRESH_DIR = join(tmp, 'data-refresh')

const realFetch = globalThis.fetch
const githubCalls = []
globalThis.fetch = async (url, init) => {
  const u = String(url?.url ?? url)
  if (!u.startsWith('https://api.github.com/')) return realFetch(url, init)
  githubCalls.push({ url: u, headers: init?.headers ?? {} })
  return new Response(JSON.stringify({
    tag_name: CANNED_TAG,
    html_url: `https://example.test/r/${CANNED_TAG}`,
    published_at: '2026-11-01T00:00:00Z',
    name: CANNED_TAG
  }), { status: 200, headers: { 'content-type': 'application/json', etag: '"canned"' } })
}

let mod
let base

before(async () => {
  mod = await import('./server.mjs')
  base = `127.0.0.1:${mod.server.address().port}`
})

after(async () => {
  globalThis.fetch = realFetch
  mod.networthRefresher?.stop()
  await new Promise(resolve => mod.server.close(resolve))
  rmSync(tmp, { recursive: true, force: true })
})

const settle = (ms = 150) => new Promise(r => setTimeout(r, ms))
const admin = { 'x-admin-password': 'admin' }

test('release-status: sent on connect, open GET, gated POST, cooldown, newer after a check', async () => {
  // (a) on connect: no check has run, so the installed version is known and the
  // comparison is not.
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=player1' } })
  const msgs = []
  ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())) } catch {} })
  try {
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    await settle()
    const first = msgs.find(m => m.type === 'release-status')
    assert.ok(first, 'a release-status message arrives with the opening batch')
    assert.equal(first.installed, packageVersion)
    assert.equal(first.comparison, 'unknown')
    assert.equal(first.latest, null)
    assert.equal(first.repo, REPO)

    // (b) the status is open — no admin header.
    const open = await fetch(`http://${base}/release-status`)
    assert.equal(open.status, 200)
    const body = await open.json()
    assert.equal(body.repo, REPO)
    assert.equal(body.installed, packageVersion)

    // (c) the manual check is behind the admin partition and reaches only the stub.
    const denied = await fetch(`http://${base}/admin/release-check`, { method: 'POST' })
    assert.equal(denied.status, 401)
    assert.equal(githubCalls.length, 0, 'a refused request sent nothing')
    msgs.length = 0
    const ok = await fetch(`http://${base}/admin/release-check`, { method: 'POST', headers: admin })
    assert.equal(ok.status, 200)
    const done = await ok.json()
    assert.equal(done.ok, true)
    assert.equal(done.status.lastOutcome, 'ok')
    assert.equal(githubCalls.length, 1)
    assert.equal(githubCalls[0].url, `https://api.github.com/repos/${REPO}/releases/latest`)

    // …and every open page is told, without a reload.
    await settle()
    const pushed = msgs.find(m => m.type === 'release-status')
    assert.ok(pushed, 'a check broadcasts release-status')
    assert.equal(pushed.comparison, 'newer')

    // (d) a second press inside the cooldown is refused with the wait.
    const again = await fetch(`http://${base}/admin/release-check`, { method: 'POST', headers: admin })
    assert.equal(again.status, 429)
    const wait = await again.json()
    assert.ok(wait.retryAfterMs > 0 && wait.retryAfterMs <= wait.cooldownMs)
    assert.equal(githubCalls.length, 1, 'the refused press sent nothing')

    // (e) the open status now reports the newer release.
    const after = await (await fetch(`http://${base}/release-status`)).json()
    assert.equal(after.comparison, 'newer')
    assert.equal(after.latest.version, `${major + 1}.0.0`)
    assert.equal(after.latest.url, `https://example.test/r/${CANNED_TAG}`)
  } finally {
    ws.close()
  }
})
