// POST /update-request and GET /update-status against the REAL server (child
// process), all background jobs disabled, no GGG requests.
//
// The three claims this file exists for:
//
//   1. THE BUTTON IS BEHIND THE ADMIN PARTITION, exactly like /restart — and a
//      refused request must not leave a request file behind either. A 401 that
//      still wrote the file would be the whole gate for nothing.
//   2. THE REQUEST FILE CARRIES NO COMMAND. It is written by a web request, it
//      lands in a directory a root cron job looks at, and the entire security
//      argument of this feature is that nothing in it is ever executed. The
//      server's half of that promise is: it writes a timestamp and a checked
//      user name and nothing else, whatever the caller sends.
//   3. THE RESULT EXCERPT IS FOREIGN TEXT and comes back filtered. A host that
//      printed a POESESSID or a git remote with a token in it must not be able
//      to hand that to a browser through this endpoint.
//
// Plus the state machine the page draws from: no heartbeat -> no updater,
// stale heartbeat -> no updater, fresh heartbeat -> updater.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { QUIET_ENV } from './test-quiet-env.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const exists = p => stat(p).then(() => true, () => false)

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

test('update endpoints: the gate, the request file, the updater state and the excerpt', { timeout: 180_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-update-'))
  const port = await freePort()
  const updateDir = join(tmp, 'config')
  const requestPath = join(updateDir, 'update-request')
  const heartbeatPath = join(updateDir, 'update-heartbeat')
  const resultPath = join(updateDir, 'update-result')
  // Not real credentials — values that must not come back out of the endpoint.
  const SESSID = 'sessid00112233445566778899aabbcc'
  const TOKEN = 'tokennotarealoneatallbutlonghere'

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      // The full set that keeps a booted server off the network — one list,
      // imported, because every file that wrote it out by hand got it wrong.
      // Spread first, so anything below may still override it deliberately.
      ...QUIET_ENV,
      PORT: String(port),
      POE_USERS: 'player1,player2',
      POE_UPDATE_DIR: updateDir,
      POE_BUILD_COMMIT: 'abc1234',
      POE_CONFIG_OVERRIDES: join(tmp, 'overrides.json'),
      POE_USER_LANG_STORE: join(tmp, 'user-langs.json'),
      POE_ADMIN_PASSWORD_FILE: join(tmp, 'admin-password'),
      POE_NETWORTH_CONFIG: join(tmp, 'networth-users.json'),
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_AUTOSYNC: '0',
      POE_FAUSTUS_DISABLED: '1',
      POE_CORPSE_DISABLED: '1',
      POE_DATA_REFRESH_DISABLED: '1',
      POE_REFERENCE_DISABLED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const srvLog = []
  srv.stdout.on('data', d => srvLog.push(String(d)))
  srv.stderr.on('data', d => srvLog.push(String(d)))
  const exited = new Promise(resolve => srv.on('exit', code => resolve(code)))

  const base = `http://127.0.0.1:${port}`
  const status = () => fetch(`${base}/update-status`, { headers: { 'x-admin-password': 'admin' } }).then(r => r.json())

  let up = false
  for (let i = 0; i < 900; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break } } catch {}
    await sleep(100)
  }

  try {
    assert.ok(up, 'server did not come up:\n' + srvLog.join(''))

    // ---- nothing exists until somebody presses the button -------------------
    // An installation without the host script has to look exactly like it did
    // before this feature existed: no new files, no new behaviour.
    assert.equal(await exists(requestPath), false)
    assert.equal(await exists(heartbeatPath), false)
    assert.equal(await exists(resultPath), false)

    // ---- the partition ------------------------------------------------------
    assert.equal((await fetch(`${base}/update-status`)).status, 401, 'no header at all')
    assert.equal((await fetch(`${base}/update-status`, { headers: { 'x-admin-password': 'wrong' } })).status, 401)
    assert.equal((await fetch(`${base}/update-request`, { method: 'POST' })).status, 401,
      'the update button is behind the same partition as the restart button')
    assert.equal((await fetch(`${base}/update-request`, {
      method: 'POST', headers: { 'x-admin-password': 'wrong' }
    })).status, 401)
    assert.equal(await exists(requestPath), false,
      'a refused request wrote nothing — otherwise the gate would be decoration')

    // ---- and so is the manual data check ------------------------------------
    // It starts outbound traffic on demand, so an unauthenticated way to press
    // it is a way for anyone on this network to spend the installation's
    // rate-limit budget.
    assert.equal((await fetch(`${base}/admin/data-check`, { method: 'POST' })).status, 401,
      '"check now" is behind the same partition as the restart and update buttons')
    assert.equal((await fetch(`${base}/admin/data-check`, {
      method: 'POST', headers: { 'x-admin-password': 'wrong' }
    })).status, 401)
    // POE_DATA_REFRESH_DISABLED=1 is how this very test keeps the process off
    // the network. A button that ignored it would be a hole straight through
    // that promise, so past the gate it refuses rather than checking.
    const dc = await fetch(`${base}/admin/data-check`, {
      method: 'POST', headers: { 'x-admin-password': 'admin' }
    })
    assert.equal(dc.status, 503, 'with the auto-update switched off there is nothing to trigger')
    const dcBody = await dc.json()
    assert.equal(dcBody.ok, false)
    assert.ok(dcBody.cooldownMs > 0, 'the page is told how long it stays shut afterwards')

    // ---- no heartbeat means "not set up", and it says so without guessing ---
    let s = await status()
    assert.equal(s.updater.installed, false)
    assert.equal(s.updater.heartbeatAt, null)
    assert.equal(s.request.pending, false)
    assert.equal(s.lastResult, null)
    assert.equal(s.build.commit, 'abc1234', 'the image knows which commit it was built from')

    // ---- pressing it writes one file, and that file holds no command --------
    const res = await fetch(`${base}/update-request`, {
      method: 'POST',
      headers: {
        'x-admin-password': 'admin',
        // Identity is a freely settable cookie, so an unknown one must not
        // travel into a file a root cron job sits next to.
        cookie: 'ppt_user=' + encodeURIComponent('nobody; rm -rf /')
      },
      // A body is not read at all. Sending one has to change nothing.
      body: JSON.stringify({ branch: 'evil', cmd: 'touch /tmp/pwned' })
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.match(body.requestedAt, /^\d{4}-\d{2}-\d{2}T/)

    const written = await readFile(requestPath, 'utf8')
    assert.equal(written.includes('evil'), false, 'nothing from the request body is in the file')
    assert.equal(written.includes('touch'), false)
    assert.equal(written.includes('rm -rf'), false, 'and nothing from the cookie either')
    assert.match(written, /requested-by=unknown/, 'an identity that is not a configured user is recorded as unknown')
    assert.match(written, /requested-at=\d{4}-\d{2}-\d{2}T/)

    s = await status()
    assert.equal(s.request.pending, true)
    assert.equal(s.request.requestedBy, 'unknown')

    // A known user is recorded by name — that is the point of the field.
    await fetch(`${base}/update-request`, {
      method: 'POST', headers: { 'x-admin-password': 'admin', cookie: 'ppt_user=player2' }
    })
    assert.match(await readFile(requestPath, 'utf8'), /requested-by=player2/)
    s = await status()
    assert.equal(s.request.requestedBy, 'player2')

    // ---- the heartbeat decides whether there is an updater ------------------
    await writeFile(heartbeatPath, 'at=2026-01-01T00:00:00Z\n')
    s = await status()
    assert.equal(s.updater.installed, true, 'a fresh heartbeat is an installed updater')
    assert.ok(s.updater.heartbeatAt)

    const old = new Date(Date.now() - 2 * s.updater.maxAgeMs)
    await utimes(heartbeatPath, old, old)
    s = await status()
    assert.equal(s.updater.installed, false, 'a stale one is not')

    const fresh = new Date()
    await utimes(heartbeatPath, fresh, fresh)
    assert.equal((await status()).updater.installed, true)

    // ---- the result, and the one rule about it ------------------------------
    await writeFile(resultPath, [
      'status=failed',
      'started=2026-01-01T00:00:00Z',
      'finished=2026-01-01T00:03:00Z',
      '--- output ---',
      'Building poe-price-tool',
      `POESESSID=${SESSID}`,
      `fatal: could not read from https://someone:${TOKEN}@git.example.invalid/repo.git`,
      'error: the build died here',
      ''
    ].join('\n'))

    const raw = await (await fetch(`${base}/update-status`, { headers: { 'x-admin-password': 'admin' } })).text()
    assert.equal(raw.includes(SESSID), false, 'a session id printed by the host does not come back out of this endpoint')
    assert.equal(raw.includes(TOKEN), false, 'nor a token inside a git remote')
    assert.equal(raw.includes('someone:'), false)
    const parsed = JSON.parse(raw)
    assert.equal(parsed.lastResult.status, 'failed')
    assert.match(parsed.lastResult.output, /error: the build died here/,
      'while the part that explains the failure survives — a filter that dropped everything would be useless')
    assert.match(parsed.lastResult.output, /https:\/\/\*\*\*@git\.example\.invalid/)
  } finally {
    srv.kill('SIGKILL')
    await exited.catch(() => {})
    await rm(tmp, { recursive: true, force: true })
  }
})
