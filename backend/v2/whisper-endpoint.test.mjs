// POST /daemon/whisper against the REAL server (child process, QUIET_ENV: no
// request leaves the machine, and POE_PRICE_CHECK_DISABLED=1 means a whisper
// is read but never valued). What is pinned here:
//   - the answer, the room, the replay on connect and the daemon's feed all
//     carry the same entry, keyed by instance and wid;
//   - nothing of a whisper's text, item or label reaches the server log;
//   - the route is bounded and guarded like the other /daemon/* routes, and
//     odd bodies never take the server down.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { QUIET_ENV } from './test-quiet-env.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const LEAGUE = 'Mercenaries'
const PER_MIN = 30

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

let tmp, srv, base, port
const srvLog = []

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ppt-whisper-ep-'))
  port = await freePort()
  srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...QUIET_ENV,
      PORT: String(port),
      POE_LEAGUE: LEAGUE,
      POE_USERS: 'player1,player2,player3,player4',
      POE_USER_LANG_STORE: join(tmp, 'user-langs.json'),
      POE_CONFIG_OVERRIDES: join(tmp, 'overrides.json'),
      POE_ADMIN_PASSWORD_FILE: join(tmp, 'admin-password'),
      POE_NETWORTH_CONFIG: join(tmp, 'networth-users.json'),
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_SESSIONS: join(tmp, 'networth-sessions.json'),
      POE_WHISPER_MAX_PER_MIN: String(PER_MIN)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  srv.stdout.on('data', d => srvLog.push(String(d)))
  srv.stderr.on('data', d => srvLog.push(String(d)))
  base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 900; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return } catch {}
    await sleep(100)
  }
  throw new Error('server did not come up:\n' + srvLog.join(''))
})

after(async () => {
  srv.kill('SIGKILL')
  await new Promise(resolve => srv.on('exit', resolve))
  await rm(tmp, { recursive: true, force: true })
  assert.doesNotMatch(srvLog.join(''), /\[daemon-feed\]/, 'the feed never threw')
  assert.doesNotMatch(srvLog.join(''), /\[whisper\] valuation failed/, 'no valuation failed')
})

const daemonHeaders = (user, instance = 'i1') => ({ 'X-User': user, 'X-PPT-Daemon': '9.9.9', 'X-PPT-Instance': instance, 'content-type': 'application/json' })
const postWhisper = (user, body, instance = 'i1', headers = daemonHeaders(user, instance)) =>
  fetch(`${base}/daemon/whisper`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
const SINGLE = `Hi, I would like to buy your Tabula Rasa, Simple Robe listed for 12 chaos in ${LEAGUE} (stash tab "Qwzsale"; position: left 5, top 3)`

async function wsCollect (user) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, { headers: { cookie: `ppt_user=${user}` } })
  const msgs = []
  ws.on('message', d => { try { msgs.push(JSON.parse(String(d))) } catch {} })
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await sleep(200)
  return { ws, msgs }
}
async function feedNow (user, since = 0, boot = '') {
  const r = await fetch(`${base}/daemon/events?wait=0&since=${since}&boot=${boot}`, { headers: daemonHeaders(user) })
  assert.equal(r.status, 200)
  return r.json()
}

test('a whisper is answered, kept for the session and sent only into its room', async () => {
  const one = await wsCollect('player1')
  const two = await wsCollect('player2')
  const replay = one.msgs.find(m => m.type === 'whispers')
  assert.deepEqual(replay?.entries, [], 'a connect replays the (empty) list')
  const head = await feedNow('player1')

  const r = await postWhisper('player1', { v: 1, wid: 'w1', body: SINGLE, label: 'buyer 1' }, 'i1')
  assert.equal(r.status, 200)
  const { v, entry } = await r.json()
  assert.equal(v, 1)
  assert.equal(entry.label, 'buyer 1')
  assert.equal(entry.key, 'i1:w1')
  assert.equal(entry.by, 'i1')
  assert.equal(entry.verdict, 'not-compared')
  assert.equal(entry.reason, 'pricing-off')
  assert.equal(entry.tab, 'Qwzsale')
  assert.equal(entry.left, 5)
  assert.equal(entry.league, LEAGUE)
  assert.equal(entry.item.text, 'Tabula Rasa, Simple Robe')

  await sleep(150)
  const live = one.msgs.filter(m => m.type === 'whisper')
  assert.equal(live.length, 1)
  assert.equal(live[0].entry.key, 'i1:w1')
  assert.equal(two.msgs.some(m => m.type === 'whisper'), false, "another player's room hears nothing")

  const feed = await feedNow('player1', head.seq, head.boot)
  const ev = feed.events.filter(e => e.kind === 'whisper')
  assert.equal(ev.length, 1)
  assert.equal(ev[0].wid, 'w1')
  assert.equal(ev[0].by, 'i1')
  assert.equal(ev[0].entry.key, 'i1:w1')

  // A second daemon of the same user also starts at w1.
  const r2 = await postWhisper('player1', { v: 1, wid: 'w1', body: SINGLE, label: 'buyer 1' }, 'i2')
  assert.equal(r2.status, 200)
  one.ws.close(); two.ws.close()
  const again = await wsCollect('player1')
  const list = again.msgs.find(m => m.type === 'whispers').entries
  assert.deepEqual(list.map(e => e.key), ['i2:w1', 'i1:w1'], 'two entries, newest first, none overwritten')
  again.ws.close()
})

test('a body that is no template is counted, not kept, and nothing reaches the log', async () => {
  const from = srvLog.length
  const sent = [
    SINGLE.replace('Tabula Rasa, Simple Robe', 'Kaom\'s Heart, Glorious Plate'),
    `Hi, I'd like to buy your 10 Orb of Alchemy for my 1 Divine Orb in ${LEAGUE}`,
    'hello there Qwzhello',
    'Hi, I would like to buy your Doom Grip, Titan Gauntlets listed for 2 chaos in Standard (stash tab "Qwzother"; position: left 1, top 1)',
    SINGLE
  ]
  const answers = []
  for (const [i, body] of sent.entries()) {
    const r = await postWhisper('player2', { v: 1, wid: `w${i + 1}`, body, label: `buyer ${i + 7}`, name: 'Zxqvname' })
    assert.equal(r.status, 200)
    answers.push((await r.json()).entry)
  }
  await sleep(150)
  const unparsed = answers[2]
  assert.equal(unparsed.verdict, 'unparsed')
  assert.equal(JSON.stringify(unparsed).includes('Qwzhello'), false, 'the text of an unparsed whisper is not kept')
  assert.equal(answers[3].reason, 'other-league')
  for (const e of answers) assert.equal(JSON.stringify(e).includes('Zxqvname'), false, 'a name field is never stored')

  const ws = await wsCollect('player2')
  const status = ws.msgs.find(m => m.type === 'daemon-status')
  assert.equal(status.unparsed, 1)
  const kept = ws.msgs.find(m => m.type === 'whispers').entries
  assert.equal(kept.length, 5)
  assert.equal(JSON.stringify(kept).includes('Zxqvname'), false)
  ws.ws.close()

  const log = srvLog.slice(from).join('')
  assert.match(log, /\[whisper\] player2: unparsed - -> unparsed/, 'one line per whisper, without text')
  for (const secret of ['Qwz', 'Kaom', 'Tabula', 'Orb of Alchemy', 'Doom Grip', 'buyer ', 'Zxqvname', 'hello']) {
    assert.equal(log.includes(secret), false, `the log carries "${secret}"`)
  }
})

test('the whisper route is bounded and guarded like the other daemon routes', async () => {
  let r = await postWhisper('player3', { v: 1, wid: 'w1', body: SINGLE, label: 'buyer 1' }, 'i1', { 'X-User': 'player3', 'content-type': 'application/json' })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'missing X-PPT-Daemon header' })

  r = await fetch(`${base}/daemon/whisper`, { method: 'GET', headers: daemonHeaders('player3') })
  assert.equal(r.status, 405)
  assert.equal((await r.json()).allow, 'POST')

  r = await postWhisper('player3', JSON.stringify({ v: 1, wid: 'w1', body: 'x'.repeat(5000), label: 'buyer 1' }))
  assert.equal(r.status, 413)

  r = await postWhisper('player3', { v: 1, wid: 'w1', body: SINGLE, label: 'Zxqvname' })
  assert.equal(r.status, 400)
  assert.deepEqual(await r.json(), { error: 'bad whisper' })
  r = await postWhisper('player3', '[1,2]')
  assert.equal(r.status, 400)
  r = await postWhisper('player3', '{not json')
  assert.equal(r.status, 400)

  r = await postWhisper('player3', { v: 1, wid: 'w2', body: SINGLE, label: 'buyer 12345' })
  assert.equal(r.status, 200, 'a label with up to 9 digits is accepted')

  const odd = [
    '', 'x'.repeat(2000), 'Hi, I would like to buy your', "Hi, I'd like to buy your 0 x for my 1 y in z",
    `Hi, I would like to buy your ${'a in '.repeat(390)}`, '\u0000\u0001', '{"a":1}', 'listed for 1 chaos'
  ]
  for (let i = 0; i < 20; i++) {
    const res = await postWhisper('player3', { v: 1, wid: `w${100 + i}`, body: odd[i % odd.length], label: 'buyer 2' })
    assert.ok([200, 400].includes(res.status), `odd body ${i} -> ${res.status}`)
  }
  const h = await fetch(`${base}/health`)
  assert.equal(await h.text(), 'ok', 'the server is still up')

  // The rate gate: PER_MIN per user and minute, the next one 429.
  for (let i = 0; i < PER_MIN; i++) {
    const res = await postWhisper('player4', { v: 1, wid: `w${i + 1}`, body: SINGLE, label: 'buyer 1' })
    assert.equal(res.status, 200)
  }
  r = await postWhisper('player4', { v: 1, wid: 'w999', body: SINGLE, label: 'buyer 1' })
  assert.equal(r.status, 429)
  assert.deepEqual(await r.json(), { error: 'too-many-whispers' })
  r = await postWhisper('player1', { v: 1, wid: 'w50', body: SINGLE, label: 'buyer 1' })
  assert.equal(r.status, 200, 'another user is not held back')
})
