// GET/POST /user-lang against the REAL server (child process), all background
// jobs disabled, no GGG requests.
//
// The point of the endpoint is that a player changes his own client language
// without an operator and without a container restart, so that is what is
// checked: the choice takes effect in the running process, every open tab of
// that user is told over the WebSocket, and it is on disk before the answer
// goes out.
//
// Availability is deliberately measured, not assumed: which languages have a
// live parser depends on whether this checkout has a generated
// `renderer/public/data/de` (gitignored — see CONTRIBUTING.md). The round trip
// is therefore asserted only when the server reports more than one language,
// exactly like the other tests that need that data set.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { QUIET_ENV } from './test-quiet-env.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

test('user language: read, switch, persist, and tell the open tabs', { timeout: 180_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-userlang-ep-'))
  const port = await freePort()
  const storePath = join(tmp, 'user-langs.json')

  // A stored entry for a user who is not in POE_USERS plus one for a language
  // nobody can parse. Neither may stop the start: "ghost" is kept out of force
  // and written back with every save (B33), "kl" is dropped.
  await writeFile(storePath, JSON.stringify({ ghost: 'de', player2: 'kl' }))

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
      POE_USER_LANG_STORE: storePath,
      POE_CONFIG_OVERRIDES: join(tmp, 'overrides.json'), // absent -> no overrides
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

  const base = `http://127.0.0.1:${port}`
  const get = user => fetch(`${base}/user-lang`, { headers: { cookie: `ppt_user=${user}` } })
  const set = (user, lang) => fetch(`${base}/user-lang`, {
    method: 'POST',
    headers: { cookie: `ppt_user=${user}`, 'content-type': 'application/json' },
    body: JSON.stringify({ lang })
  })

  let up = false
  for (let i = 0; i < 900; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break } } catch {}
    await sleep(100)
  }

  let ws
  try {
    assert.ok(up, 'server did not come up:\n' + srvLog.join(''))

    // ---- the two unusable stored entries are not obeyed ----------------------
    const log = srvLog.join('')
    assert.match(log, /ghost.*POE_USERS/, 'a user that is no longer in POE_USERS is named in the warning')
    assert.match(log, /"kl" for "player2".*not a supported language/, 'and so is the unsupported language')

    // ---- GET -----------------------------------------------------------------
    let r = await get('player1')
    assert.equal(r.status, 200)
    const state = await r.json()
    assert.equal(state.user, 'player1')
    assert.ok(state.lang, 'the language currently in force')
    assert.ok(Array.isArray(state.available) && state.available.includes(state.lang),
      'and the list the settings page builds its dropdown from')
    assert.equal(state.persisted, true, 'the store is writable in this test')

    // An unknown identity is refused rather than silently routed.
    assert.equal((await fetch(`${base}/user-lang`)).status, 400, 'no cookie')
    assert.equal((await get('nobody')).status, 400, 'unknown user')

    // ---- a language this server cannot parse is refused ---------------------
    r = await set('player1', 'kl')
    assert.equal(r.status, 400)
    let body = await r.json()
    assert.match(body.error, /not available/)
    assert.deepEqual(body.available, state.available, 'and the answer says what IS available')
    r = await set('player1', 42)
    assert.equal(r.status, 400, 'not even a string')

    // ---- the switch itself ---------------------------------------------------
    const target = state.available.find(l => l !== state.lang)
    if (!target) {
      // Only one parser in this checkout (no generated data/de). The switch has
      // nothing to switch to; say so instead of pretending to have tested it.
      console.log('# only one live parser — the round trip needs a generated renderer/public/data/de')
      assert.equal((await set('player1', state.lang)).status, 200, 'setting the current language is a no-op, not an error')
      return
    }

    // An open tab of this user has to learn about it — the page reads its
    // language from `league-state` (PROTOCOL.md).
    ws = new WebSocket(`ws://127.0.0.1:${port}/events`, { headers: { cookie: 'ppt_user=player1' } })
    const seen = []
    ws.on('message', raw => { try { seen.push(JSON.parse(raw.toString())) } catch {} })
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    await sleep(300)
    const opening = seen.find(m => m.type === 'league-state')
    assert.equal(opening.lang, state.lang, 'the opening message carries the language in force')
    seen.length = 0

    r = await set('player1', target)
    assert.equal(r.status, 200)
    body = await r.json()
    assert.equal(body.lang, target)
    assert.equal(body.persisted, true)

    // On disk BEFORE the answer went out: a switch that is in force but not
    // stored would revert at the next restart with nothing to show for it.
    const onDisk = JSON.parse(await readFile(storePath, 'utf8'))
    assert.equal(onDisk.player1, target)
    // The entry of the user who is not in POE_USERS survives the save, and the
    // one with the unsupported language does not come back (B33).
    assert.equal(onDisk.ghost, 'de', 'a stored choice outside POE_USERS is written back, not lost')
    assert.equal(onDisk.player2, undefined, 'the dropped entry stays dropped')

    await sleep(300)
    const pushed = seen.find(m => m.type === 'league-state')
    assert.ok(pushed, 'every open tab of that user is told')
    assert.equal(pushed.lang, target)

    // In force for the next request too, without a restart.
    assert.equal((await (await get('player1')).json()).lang, target)
    assert.equal((await (await fetch(`${base}/users`)).json()).langs.player1, target,
      'and the identity gate agrees — one mapping, not two')

    // The other user was not touched.
    assert.equal((await (await get('player2')).json()).lang, state.lang)
  } finally {
    try { ws?.close() } catch { /* never opened */ }
    srv.kill('SIGKILL')
    await new Promise(resolve => srv.on('exit', resolve))
    await rm(tmp, { recursive: true, force: true })
  }
})
