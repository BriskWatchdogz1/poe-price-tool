// A stored language choice whose parser is not live at boot is PARKED, not
// dropped (user-lang-store.mjs) — checked here against the REAL server, in
// process, because the parts that can go wrong are in server.mjs: what is in
// force after the boot, what a parked user's new choice does, and how a parser
// that comes up later — through the data-update handler — puts the parked
// choice back for every open tab.
//
// Same en-only snapshot as server-langs.test.mjs: data/en complete,
// data/de deliberately absent, so the German instance exists (a stored 'de'
// widens the parser set) but cannot come up. Background schedules off
// (quietEnv), stores in a temp dir, no network.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, copyFile, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { quietEnv } from './test-quiet-env.mjs'

const VENDORED = fileURLToPath(new URL('../../renderer/public/', import.meta.url))
const configDir = await mkdtemp(path.join(tmpdir(), 'ppt-langpark-'))
const storePath = path.join(configDir, 'user-langs.json')

{
  const version = '0-en-only'
  const snapshot = path.join(configDir, 'apt', version)
  await mkdir(path.join(snapshot, 'data/en'), { recursive: true })
  for (const f of ['items.ndjson', 'stats.ndjson', 'client_strings.js', 'app_i18n.json']) {
    await copyFile(path.join(VENDORED, 'data/en', f), path.join(snapshot, 'data/en', f))
  }
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

// Two users chose German for themselves on the settings page; the operator's
// configuration says nothing about languages.
await writeFile(storePath, JSON.stringify({ parked1: 'de', parked2: 'de' }))

quietEnv()
process.env.PORT = '0'
process.env.POE_DATA_REFRESH_DIR = configDir
process.env.POE_USERS = 'enuser,parked1,parked2'
delete process.env.POE_USER_LANGS
delete process.env.POE_LANG_DEFAULT
process.env.POE_USER_LANG_STORE = storePath
process.env.POE_CONFIG_OVERRIDES = path.join(configDir, 'overrides.json')
process.env.POE_ADMIN_PASSWORD_FILE = path.join(configDir, 'admin-password')
process.env.POE_NETWORTH_CONFIG = path.join(configDir, 'networth-users.json')
process.env.POE_NETWORTH_STORE = path.join(configDir, 'networth-store.json')
process.env.POE_NETWORTH_HISTORY = path.join(configDir, 'networth-history.ndjson')

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

const fileNow = async () => JSON.parse(await readFile(storePath, 'utf8'))

test('boot: the choice without a parser is parked — out of force, still in the file', async () => {
  assert.deepEqual(mod.engines.liveLanguages(), ['en'])
  assert.deepEqual(mod.engines.languages(), ['en', 'de'], 'the stored choice still gets an instance to retry')
  assert.equal(mod.LANG_BY_USER.get('parked1'), 'en', 'on the configured value instead of a 503 parser')
  assert.equal(mod.users.get('parked1').lang, 'en')
  assert.deepEqual([...mod.userLangStore.parked()], [['parked1', 'de'], ['parked2', 'de']])
  assert.deepEqual(await fileNow(), { parked1: 'de', parked2: 'de' })
})

test('a parked user who picks the language he is on now replaces the parked choice', async () => {
  // He is on 'en' already; answered "unchanged" without a write, the parked
  // 'de' would come back over his newest choice.
  const r = await mod.setUserLang('parked2', 'en')
  assert.equal(r.ok, true)
  assert.equal(r.persisted, true)
  assert.deepEqual(await fileNow(), { parked1: 'de', parked2: 'en' },
    'his entry is replaced, the other parked one is written back with it')
  assert.deepEqual([...mod.userLangStore.parked()], [['parked1', 'de']])
})

test('a parser that comes up later puts the parked choice back, and the open tab follows', async () => {
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=parked1' } })
  const states = []
  let resolveSecond
  const second = new Promise(resolve => { resolveSecond = resolve })
  ws.on('message', d => {
    const m = JSON.parse(d.toString())
    if (m.type !== 'league-state') return
    states.push(m)
    if (states.length === 2) resolveSecond()
  })
  await new Promise((resolve, reject) => {
    ws.on('error', reject)
    const t = setInterval(() => { if (states.length) { clearInterval(t); resolve() } }, 5)
  })
  assert.equal(states[0].lang, 'en')

  // The real data-update handler, after a reload that brought data/de: the
  // German instance is live now. The two engine calls are stubbed, because
  // generating a German data set is not something a unit run can do;
  // everything after the reload runs as in production, against the en-only
  // snapshot (the German rebuilds find no file and stay empty).
  const { reload, liveLanguages } = mod.engines
  mod.engines.reload = async () => ['en', 'de']
  mod.engines.liveLanguages = () => ['en', 'de']
  try {
    await mod.applyAptData({
      publicDataUrl: mod.dataRefresher.publicDataUrl(),
      itemsNdjsonPath: mod.dataRefresher.itemsNdjsonPath(),
      languages: ['en', 'de']
    })
  } finally {
    mod.engines.reload = reload
    mod.engines.liveLanguages = liveLanguages
  }
  // Bounded, so a handler that never puts him back fails here instead of
  // hanging the run.
  let timer
  await Promise.race([second, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('no second league-state: the parked choice did not come back')), 2000)
  })]).finally(() => { clearTimeout(timer); ws.close() })

  assert.equal(states[1].lang, 'de')
  assert.equal(mod.LANG_BY_USER.get('parked1'), 'de')
  assert.equal(mod.users.get('parked1').lang, 'de')
  assert.equal(mod.LANG_BY_USER.get('parked2'), 'en', 'the user who chose again stays on his choice')
  assert.equal(mod.userLangStore.parked().size, 0)
  assert.deepEqual(await fileNow(), { parked1: 'de', parked2: 'en' }, 'nothing to write: the file held it all along')
  // The revival comes before the per-language rebuilds of the same handler,
  // which build their tables from the languages in force: German has one now.
  assert.ok(mod.localNamesByLang.has('de'), 'the display-name table was rebuilt with the revived language')
})
