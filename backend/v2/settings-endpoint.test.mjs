// HTTP endpoints GET/POST /networth/credentials + the WS networth-sync-status
// message — against the REAL server (child process), all background jobs
// disabled, no GGG requests. Core proof: the stored POESESSID comes back in NO
// response, not even masked and not even as a length.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('credentials endpoints: status, saving, no secret in any response', { timeout: 120_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-settings-'))
  const port = await freePort()
  const credPath = join(tmp, 'networth-users.json')
  const SECRET = 'secretcookie1234567890abcdefabcd' // 32 chars, same as live
  const OTHER_SECRET = 'othercookie9876543210abcdefabcd'

  // Seed a second user -> proves that saving does not touch him.
  await writeFile(credPath, JSON.stringify({
    player2: { accountName: 'Other#5678', poesessid: OTHER_SECRET }
  }))

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      POE_USERS: 'player1,player2',
      POE_NETWORTH_CONFIG: credPath,
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_AUTOSYNC: '0',   // no refresher -> no GGG stash requests
      POE_CRAWLER_DISABLED: '1',
      POE_FAUSTUS_DISABLED: '1',
      POE_CORPSE_DISABLED: '1',
      POE_CLUSTER_STORE: join(tmp, 'cluster-store.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const srvLog = []
  srv.stdout.on('data', d => srvLog.push(String(d)))
  srv.stderr.on('data', d => srvLog.push(String(d)))

  const base = `http://127.0.0.1:${port}`
  let up = false
  for (let i = 0; i < 300; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break } } catch {}
    await sleep(100)
  }

  try {
    assert.ok(up, 'server did not come up:\n' + srvLog.join(''))
    const asUser = u => ({ headers: { cookie: `ppt_user=${u}` } })

    // --- without an identity: 400
    const anon = await fetch(`${base}/networth/credentials`)
    assert.equal(anon.status, 400)

    // --- GET before saving: missing, no accountName, NO secret
    let r = await fetch(`${base}/networth/credentials`, asUser('player1'))
    assert.equal(r.status, 200)
    let body = await r.text()
    assert.ok(!body.includes(SECRET) && !body.includes(OTHER_SECRET), 'no secret in the GET response')
    let j = JSON.parse(body)
    assert.equal(j.status.state, 'missing')
    assert.equal(j.accountName, null)
    assert.ok(!('poesessid' in j), 'no poesessid field at all, not even empty or masked')

    // --- validation error: a value containing whitespace is rejected, and the value is not echoed in the message
    r = await fetch(`${base}/networth/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'ppt_user=player1' },
      body: JSON.stringify({ accountName: 'Player#0001', poesessid: 'with spaces' })
    })
    assert.equal(r.status, 400)
    body = await r.text()
    assert.ok(!body.includes('spaces'), 'the rejected value does not show up in the error message')

    // --- saving
    r = await fetch(`${base}/networth/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'ppt_user=player1' },
      body: JSON.stringify({ accountName: '  Player#0001 ', poesessid: `  ${SECRET} ` })
    })
    assert.equal(r.status, 200)
    body = await r.text()
    assert.ok(!body.includes(SECRET), 'no secret in the POST response')
    j = JSON.parse(body)
    assert.equal(j.ok, true)
    assert.equal(j.accountName, 'Player#0001')
    assert.equal(j.status.state, 'ok')

    // on disk: stored trimmed, player2 untouched
    const onDisk = JSON.parse(await readFile(credPath, 'utf8'))
    assert.deepEqual(onDisk.player1, { accountName: 'Player#0001', poesessid: SECRET })
    assert.deepEqual(onDisk.player2, { accountName: 'Other#5678', poesessid: OTHER_SECRET })

    // --- GET after saving: accountName yes, secret no
    r = await fetch(`${base}/networth/credentials`, asUser('player1'))
    body = await r.text()
    assert.ok(!body.includes(SECRET), 'no secret in the GET response after saving')
    j = JSON.parse(body)
    assert.equal(j.accountName, 'Player#0001')
    assert.equal(j.status.state, 'ok')

    // --- an empty poesessid field means no change (not a delete)
    r = await fetch(`${base}/networth/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'ppt_user=player1' },
      body: JSON.stringify({ accountName: 'Player#0002', poesessid: '' })
    })
    assert.equal(r.status, 200)
    const after = JSON.parse(await readFile(credPath, 'utf8'))
    assert.equal(after.player1.poesessid, SECRET, 'an empty field leaves the stored cookie in place')
    assert.equal(after.player1.accountName, 'Player#0002')

    // --- WS: networth-sync-status arrives on connect, without the secret
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, { headers: { cookie: 'ppt_user=player1' } })
    const statusMsg = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('no networth-sync-status within 10s')), 10_000)
      ws.on('message', buf => {
        const raw = String(buf)
        assert.ok(!raw.includes(SECRET), 'no secret in any WS message')
        const m = JSON.parse(raw)
        if (m.type === 'networth-sync-status') { clearTimeout(to); resolve(m) }
      })
      ws.on('error', reject)
    })
    ws.close()
    assert.equal(statusMsg.state, 'ok')

    // --- the server log carries the secret nowhere either
    assert.ok(!srvLog.join('').includes(SECRET), 'no secret in the server log')
  } finally {
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
