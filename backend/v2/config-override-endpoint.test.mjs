// GET /config-view, POST /config-override and POST /restart against the REAL
// server (child process), all background jobs disabled, no GGG requests.
//
// The claim this file exists for, above all the others: THE CONFIGURATION VIEW
// NEVER PUBLISHES A SECRET. The tool's /config volume is plaintext by design —
// a POESESSID is full account control — and a view that shows "the rest of the
// effective settings" is exactly the place where one would eventually slip in.
// So the whole answer is walked, every key at every depth, and any key that
// could name a credential fails the test. Do not weaken this by adding an
// exception; rename the field instead.
//
// THE WALK HAS TO LOOK AT VALUES AS WELL, and this is where the first version
// of it was wrong: the names of the settings are not JSON keys in the answer,
// they are values — `{ "name": "POE_APP_NAME", … }`. A walk over keys alone sees
// `name`, `value`, `type` and passes happily while shipping a `POE_SESSID` row.
// It cannot simply test every string either: the descriptions are prose, and a
// sentence that mentions an account name is not a leak. So values are checked
// exactly where a KEY NAME stands — `settings[].name` and `runtime[].name` —
// deliberately and by name, not by accident.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { markerPathFor } from './config-overrides.mjs'
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

// The same expression config-overrides.mjs redacts by, applied here from the
// outside so the test cannot be satisfied by a change to the module.
const SECRET_KEY_RE = /SESSID|PASSWORD|TOKEN|SECRET|ACCOUNT|KEY/i

/**
 * Everything in the answer that NAMES something, with its path: every object
 * key at every depth, plus the string value of every field literally called
 * `name` — which is how this answer spells the name of a setting.
 *
 * Other string values are deliberately NOT collected. `description` is a
 * sentence written for a human and may legitimately contain a word like
 * "account"; failing on that would train whoever hits it to soften the
 * expression, which is the opposite of what this test is for.
 */
function allNames (value, path = '$', out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => allNames(v, `${path}[${i}]`, out))
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push({ text: k, path: `${path}.${k}`, what: 'field name' })
      if (k === 'name' && typeof v === 'string') {
        out.push({ text: v, path: `${path}.${k}`, what: 'setting name' })
      }
      allNames(v, `${path}.${k}`, out)
    }
  }
  return out
}

test('config endpoints: gate, no secrets, live vs restart, and the way back', { timeout: 180_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-cfgview-'))
  const port = await freePort()
  const overridesPath = join(tmp, 'overrides.json')
  const credPath = join(tmp, 'networth-users.json')
  const pwPath = join(tmp, 'admin-password')
  // Not a real cookie — a value that must not turn up in any answer.
  const SESSID = 'testsessid1234567890abcdefabcdef'
  const ACCOUNT = 'SomeAccount#1234'
  const COMPOSE_NAME = 'From compose'
  const OVERRIDE_NAME = 'From the browser'

  await writeFile(credPath, JSON.stringify({ player1: { accountName: ACCOUNT, poesessid: SESSID } }))
  // Seeded BEFORE the start: this is the state a restart finds.
  await writeFile(overridesPath, JSON.stringify({ POE_APP_NAME: OVERRIDE_NAME }))

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
      POE_CONFIG_OVERRIDES: overridesPath,
      POE_USER_LANG_STORE: join(tmp, 'user-langs.json'),
      POE_ADMIN_PASSWORD_FILE: pwPath,
      // The same key in the real environment — the override has to win, and
      // the view has to say that it is winning.
      POE_APP_NAME: COMPOSE_NAME,
      // Secrets in the environment of the process under test. If any of them
      // reaches the view, this test is the place it gets caught.
      POE_SESSID: SESSID,
      POE_NETWORTH_ACCOUNT: ACCOUNT,
      POE_NETWORTH_CONFIG: credPath,
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
  const view = pw => fetch(`${base}/config-view`, pw == null ? undefined : { headers: { 'x-admin-password': pw } })
  const setKey = (key, value) => fetch(`${base}/config-override`, {
    method: 'POST',
    headers: { 'x-admin-password': 'admin', 'content-type': 'application/json' },
    body: JSON.stringify({ key, value })
  })

  let up = false
  for (let i = 0; i < 900; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break } } catch {}
    await sleep(100)
  }

  let restarted = false
  try {
    assert.ok(up, 'server did not come up:\n' + srvLog.join(''))

    // ---- the boot half of the quarantine -----------------------------------
    assert.equal(await exists(markerPathFor(overridesPath)), false,
      'the marker is removed once the server listens — otherwise the next start would reject a working configuration')

    // ---- the override really beat the environment --------------------------
    const users = await (await fetch(`${base}/users`)).json()
    assert.equal(users.appName, OVERRIDE_NAME,
      'the file wins over the compose value — that is the whole point of the feature')

    // ---- the partition ------------------------------------------------------
    assert.equal((await view(null)).status, 401, 'no header at all')
    assert.equal((await view('wrong')).status, 401)
    const r = await view('admin')
    assert.equal(r.status, 200)
    const rawBody = await r.text()
    const body = JSON.parse(rawBody)

    // ---- NOTHING SECRET. Not negotiable. ------------------------------------
    const offenders = allNames(body).filter(k => SECRET_KEY_RE.test(k.text))
    assert.deepEqual(offenders, [],
      'something that could name a credential turned up in /config-view: ' +
      offenders.map(o => `${o.path} (${o.what} "${o.text}")`).join(', '))
    // The walk is only worth anything if it can actually see a setting name, so
    // prove that it does rather than trusting a green result.
    const seen = allNames(body).filter(k => k.what === 'setting name').map(k => k.text)
    assert.ok(seen.includes('POE_APP_NAME'),
      'the walk did not reach the setting names — it would pass on an empty answer too')
    assert.equal(rawBody.includes(SESSID), false, 'the POESESSID itself is not in the answer either')
    assert.equal(rawBody.includes(ACCOUNT), false, 'nor the account name')
    assert.equal(/admin-password/.test(rawBody), false, 'nor the path to the password file')

    // ---- the view is complete enough to build a form from -------------------
    const byName = Object.fromEntries(body.settings.map(s => [s.name, s]))
    assert.ok(body.settings.length >= 10, 'the settings page builds its fields from this list')
    for (const s of body.settings) {
      assert.ok(s.name && s.description && s.type && s.apply, `incomplete entry: ${JSON.stringify(s)}`)
    }
    assert.equal(byName.POE_APP_NAME.source, 'override')
    assert.equal(byName.POE_APP_NAME.value, OVERRIDE_NAME)
    assert.equal(byName.POE_APP_NAME.shadowsEnv, true)
    assert.equal(byName.POE_APP_NAME.envValue, COMPOSE_NAME)
    assert.ok(Array.isArray(body.runtime) && body.runtime.length,
      'plus the read-only block, so nobody needs SSH to see the rest')
    assert.equal(body.runtime.some(e => e.name === 'POE_APP_NAME'), false,
      'the editable ones are not repeated there — one page, one answer per setting')
    assert.equal(body.quarantined, false)

    // ---- live really is live ------------------------------------------------
    let res = await setKey('POE_APP_NAME', 'Renamed live')
    assert.equal(res.status, 200)
    assert.equal((await res.json()).applied, 'live')
    assert.equal((await (await fetch(`${base}/users`)).json()).appName, 'Renamed live',
      'no restart, no redeploy')

    // ---- restart keys say so instead of pretending --------------------------
    res = await setKey('POE_LEAGUE', 'Some Other League')
    assert.equal((await res.json()).applied, 'restart-required')
    const after = await (await view('admin')).json()
    assert.equal(after.settings.find(s => s.name === 'POE_LEAGUE').restartPending, true)
    assert.equal(after.restartPending, true)

    // ---- refusals -----------------------------------------------------------
    assert.equal((await setKey('POE_USERS', 'a,b')).status, 400, 'rooms and stores are keyed by this')
    assert.equal((await setKey('POE_SESSID', 'x')).status, 400)
    assert.equal((await setKey('POE_MAX_LISTINGS', 99)).status, 400)
    assert.equal((await setKey('POE_MAX_LISTINGS', 'seven')).status, 400)
    // ...and none of them was written.
    assert.deepEqual(Object.keys(JSON.parse(await readFile(overridesPath, 'utf8'))).sort(),
      ['POE_APP_NAME', 'POE_LEAGUE'])

    // ---- the way back -------------------------------------------------------
    res = await setKey('POE_APP_NAME', null)
    assert.equal(res.status, 200)
    assert.equal((await (await fetch(`${base}/users`)).json()).appName, COMPOSE_NAME,
      'removing the override falls back to the compose value, not to nothing')
    assert.equal(Object.hasOwn(JSON.parse(await readFile(overridesPath, 'utf8')), 'POE_APP_NAME'), false)

    // ---- restart ------------------------------------------------------------
    assert.equal((await fetch(`${base}/restart`, { method: 'POST' })).status, 401,
      'the restart button is behind the same partition')
    res = await fetch(`${base}/restart`, { method: 'POST', headers: { 'x-admin-password': 'admin' } })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, restarting: true })
    const code = await Promise.race([exited, sleep(15000).then(() => 'timeout')])
    assert.equal(code, 0, 'it answers first and THEN ends the process cleanly')
    restarted = true
  } finally {
    if (!restarted) { srv.kill('SIGKILL'); await exited.catch(() => {}) }
    await rm(tmp, { recursive: true, force: true })
  }
})

// The other way out of the process: not a field of the answer, but an error
// message inside it. `state.problems` is published by /config-view, and V8's
// JSON.parse error quotes the input it failed on — so a hand-edited file with a
// credential in it and a comma missing would have come back over HTTP.
test('a broken overrides file never sends its content back through /config-view', { timeout: 180_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-cfgbroken-'))
  const port = await freePort()
  const overridesPath = join(tmp, 'overrides.json')
  // Not a real cookie. What matters is that it is in the file, in the part V8
  // would quote, and nowhere else.
  const SECRET = 'sessionvalue0123456789abcdef'
  await writeFile(overridesPath, `{ "POE_LEAGUE": "Standard", "POESESSID": ${SECRET} }`)

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
      POE_CONFIG_OVERRIDES: overridesPath,
      POE_USER_LANG_STORE: join(tmp, 'user-langs.json'),
      POE_ADMIN_PASSWORD_FILE: join(tmp, 'admin-password'),
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
  let up = false
  for (let i = 0; i < 900; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break } } catch {}
    await sleep(100)
  }
  try {
    assert.ok(up, 'a broken overrides file must not stop the start:\n' + srvLog.join(''))
    const r = await fetch(`${base}/config-view`, { headers: { 'x-admin-password': 'admin' } })
    assert.equal(r.status, 200)
    const rawBody = await r.text()
    assert.equal(rawBody.includes(SECRET), false,
      'the parser message quoted the file and the quote reached the browser')
    const body = JSON.parse(rawBody)
    assert.ok(body.problems.some(p => /not valid JSON/.test(p)),
      'the operator is still told the file is unusable — the point is HOW, not WHETHER')
    // ...and the log did not print it either. Same file, same content, and a
    // log is pasted into bug reports.
    assert.equal(srvLog.join('').includes(SECRET), false, 'nor into the container log')
  } finally {
    srv.kill('SIGKILL')
    await exited.catch(() => {})
    await rm(tmp, { recursive: true, force: true })
  }
})
