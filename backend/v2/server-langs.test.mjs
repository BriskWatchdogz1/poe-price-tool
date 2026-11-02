// Boots the REAL server with a user on a German client, on a machine that has
// no German data set yet — which is the state every installation is in until a
// generator run has produced one.
//
// What that has to look like, and what this file pins down:
//   - the English users are completely unaffected,
//   - the German user is refused LOUDLY (503) instead of being parsed by the
//     English engine, because a wrong-language parse comes back as a plausible
//     item, not as an error,
//   - the existing loud failures stay exactly as loud (unknown X-User -> 400,
//     missing X-User -> first user),
//   - both transports learn the language from the same mapping: /users for the
//     browser, X-User for the daemon.
//
// The missing German data set is BUILT HERE, it is not the state of the
// working tree. It used to be: the file relied on renderer/public having no
// data/de, which held right up until the language generator produced one — and
// then two assertions flipped for a reason that had nothing to do with what
// they were guarding. So the test lays out its own /config snapshot with
// data/en and deliberately without data/de, which is the situation it means:
// German configured, German not generated yet.
//
// Same background-schedule switches as server.test.mjs, plus
// POE_PRICE_CHECK_DISABLED=1 for the foreground price check and
// POE_REFERENCE_ON_CONNECT_DISABLED=1 for the reference warm-up a WS connection
// sets off (docs/bugs.md B12: the connection at the bottom of this file used to
// send two poe.ninja requests) — no network here either, and nothing left
// running once the tests are through. The English
// POST below only has to reach 200 with an id; auto-pricing it used to send a
// live Trade-API search whose rate-limit bookkeeping then held the process
// open long after `mod.server.close()`.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, copyFile, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { quietEnv } from './test-quiet-env.mjs'

const VENDORED = fileURLToPath(new URL('../../renderer/public/', import.meta.url))
const configDir = await mkdtemp(path.join(tmpdir(), 'ppt-langs-'))

// An APT snapshot the refresher will accept and prefer over the baked-in one:
// data/en complete, the two aux files present, data/de deliberately absent.
{
  const version = '0-en-only'
  const snapshot = path.join(configDir, 'apt', version)
  await mkdir(path.join(snapshot, 'data/en'), { recursive: true })
  for (const f of ['items.ndjson', 'stats.ndjson', 'client_strings.js', 'app_i18n.json']) {
    await copyFile(path.join(VENDORED, 'data/en', f), path.join(snapshot, 'data/en', f))
  }
  // A complete language tree includes the four generated indices.
  const { buildIndexBins } = await import('./apt-index.mjs')
  const bins = buildIndexBins({
    itemsNdjson: await readFile(path.join(snapshot, 'data/en/items.ndjson'), 'utf8'),
    statsNdjson: await readFile(path.join(snapshot, 'data/en/stats.ndjson'), 'utf8')
  })
  for (const [name, buf] of Object.entries(bins)) {
    await writeFile(path.join(snapshot, 'data/en', name), Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
  }
  for (const f of ['item-drop.json', 'patrons.json']) {
    await copyFile(path.join(VENDORED, 'data', f), path.join(snapshot, 'data', f))
  }
  await writeFile(path.join(configDir, 'state.json'), JSON.stringify({
    since: Date.now(),
    apt: { version, langs: ['en'] }
  }))
}

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
process.env.POE_REFERENCE_ON_CONNECT_DISABLED = '1'
process.env.POE_PRICE_CHECK_DISABLED = '1'
process.env.POE_DATA_REFRESH_DIR = configDir
process.env.POE_USERS = 'enuser,deuser'
process.env.POE_USER_LANGS = 'deuser:de'

let mod
let base

before(async () => {
  mod = await import('./server.mjs')
  base = `127.0.0.1:${mod.server.address().port}`
})

after(async () => {
  await new Promise((resolve) => mod.server.close(resolve))
  await rm(configDir, { recursive: true, force: true })
})

const MAGEBLOOD = `Item Class: Belts
Rarity: Unique
Mageblood
Heavy Belt
--------
Item Level: 86
--------
Your Flasks gain 0.15 Charges per Second
--------
`

const post = (user, body) => fetch(`http://${base}/item`, {
  method: 'POST', headers: user ? { 'X-User': user } : {}, body
})

test('the mapping is configuration and it reached the server', () => {
  assert.deepEqual([...mod.LANG_BY_USER], [['enuser', 'en'], ['deuser', 'de']])
})

test('the English instance is up; the German one is honestly absent', () => {
  // The snapshot laid out above has no data/de, so the German instance cannot
  // come up. It must not take English down with it.
  assert.ok(mod.engines.liveLanguages().includes('en'))
  assert.deepEqual(mod.engines.liveLanguages(), ['en'])
  assert.deepEqual(mod.engines.languages(), ['en', 'de'], 'it was configured, it just has no data')
  assert.equal(mod.engines.parserFor('de'), undefined)
})

test('an English user is untouched by any of this', async () => {
  const r = await post('enuser', MAGEBLOOD)
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.ok(j.id, 'the card was created as before')
})

test('the German user is refused loudly instead of being parsed as English', async () => {
  const r = await post('deuser', MAGEBLOOD)
  assert.equal(r.status, 503)
  const j = await r.json()
  assert.equal(j.lang, 'de')
  assert.match(j.error, /no parser for language "de"/)
  // And nothing landed in their room — a wrong-language parse would have.
  assert.equal(mod.users.get('deuser').items.size, 0)
})

test('the existing loud failures are unchanged', async () => {
  const unknown = await post('nosuchuser', MAGEBLOOD)
  assert.equal(unknown.status, 400, 'unknown X-User is still a hard 400')

  const headerless = await post(null, MAGEBLOOD)
  assert.equal(headerless.status, 200, 'a MISSING header still falls back to the first user')
})

test('the browser transport carries the language too', async () => {
  const j = await (await fetch(`http://${base}/users`)).json()
  assert.deepEqual(j.langs, { enuser: 'en', deuser: 'de' })

  // ...and the WS opening tells a connected page which language its room is on.
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=deuser' } })
  const state = await new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'league-state') resolve(m) })
  })
  ws.close()
  assert.equal(state.lang, 'de')
})

test('an unknown cookie still gets need-identity, not a room', async () => {
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=ghost' } })
  const msg = await new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('message', d => resolve(JSON.parse(d.toString())))
  })
  ws.close()
  assert.equal(msg.type, 'need-identity')
})
