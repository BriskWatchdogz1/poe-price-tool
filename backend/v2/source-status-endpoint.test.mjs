// The price-source status as the server exposes it (docs/bugs.md B29): the
// `source-status` message on connect, the open GET /source-status, the trade
// ban on the trade row, and a C:D message that carries no age while it is the
// fallback — against the REAL server.mjs booted in this process.
//
// Nothing leaves the machine: QUIET_ENV keeps every schedule and warm-up off,
// so poe.ninja is never asked (the net guard would turn the run red), and the
// rate-limit state is written into a temporary directory.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { quietEnv } from './test-quiet-env.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'ppt-source-status-'))
quietEnv()
process.env.PORT = '0'
process.env.POE_USERS = 'player1,player2'
process.env.POE_RELEASE_CHECK_STATE = join(tmp, 'release-check.json')
process.env.POE_CONFIG_OVERRIDES = join(tmp, 'overrides.json')
process.env.POE_USER_LANG_STORE = join(tmp, 'user-langs.json')
process.env.POE_ADMIN_PASSWORD_FILE = join(tmp, 'admin-password')
process.env.POE_NETWORTH_CONFIG = join(tmp, 'networth-users.json')
process.env.POE_NETWORTH_STORE = join(tmp, 'networth-store.json')
process.env.POE_NETWORTH_HISTORY = join(tmp, 'networth-history.ndjson')
process.env.POE_FAUSTUS_STORE = join(tmp, 'faustus-store.json')
// A Faustus store from before the boot, for this league: its age has to survive
// the restart (server.mjs seeds source-health from it).
process.env.POE_LEAGUE = 'SeedLeague'
const STORE_UPDATED_AT = Date.now() - 5 * 60 * 60 * 1000
writeFileSync(process.env.POE_FAUSTUS_STORE, JSON.stringify({
  schema_version: 1, updatedAt: STORE_UPDATED_AT, league: 'SeedLeague', prices: { 'Divine Orb': 200 }, ranges: {}, sell: {}, hours: {}
}))
process.env.POE_CORPSE_STORE = join(tmp, 'corpse-store.json')
process.env.POE_REFERENCE_HISTORY = join(tmp, 'reference-history.ndjson')
process.env.POE_RATE_LIMIT_STATE = join(tmp, 'rate-limit.json')
process.env.POE_UPDATE_DIR = join(tmp, 'update')
process.env.POE_DATA_REFRESH_DIR = join(tmp, 'data-refresh')

let mod
let base

before(async () => {
  mod = await import('./server.mjs')
  base = `127.0.0.1:${mod.server.address().port}`
})

after(async () => {
  mod.clearRateLimit()
  mod.networthRefresher?.stop()
  await new Promise(resolve => mod.server.close(resolve))
  rmSync(tmp, { recursive: true, force: true })
})

const settle = (ms = 150) => new Promise(r => setTimeout(r, ms))
const IDS = ['faustus', 'ninja-cd', 'ninja-overview', 'trade']

async function connect () {
  const ws = new WebSocket(`ws://${base}/events`, { headers: { cookie: 'ppt_user=player1' } })
  const msgs = []
  ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())) } catch {} })
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await settle()
  return { ws, msgs }
}

test('GET /source-status answers the four sources with now and since; faustus is off under POE_FAUSTUS_DISABLED', async () => {
  const r = await fetch(`http://${base}/source-status`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const body = await r.json()
  assert.deepEqual(body.sources.map(s => s.source), IDS)
  assert.equal(typeof body.now, 'number')
  assert.ok(body.since <= body.now)
  assert.equal('type' in body, false)
  const by = Object.fromEntries(body.sources.map(s => [s.source, s]))
  assert.equal(by.faustus.enabled, false)
  assert.equal(by['ninja-overview'].scheduled, false)
  assert.equal(by['ninja-cd'].scheduled, true)
  assert.equal(by.trade.staleAfterMs, null)
  assert.ok(by['ninja-cd'].staleAfterMs >= 3 * 60 * 60 * 1000)
  for (const s of body.sources) {
    for (const k of ['enabled', 'scheduled', 'staleAfterMs', 'lastSuccessAt', 'lastFailureAt', 'reason', 'failKind']) {
      assert.ok(k in s, `${s.source} lacks ${k}`)
    }
  }
})

test('the age of a Faustus store from before the boot is kept (seed), even with the refresh switched off', async () => {
  const row = mod.sourceStatusMsg().sources.find(s => s.source === 'faustus')
  assert.equal(row.lastSuccessAt, STORE_UPDATED_AT)
  assert.equal(row.lastFailureAt, null)
})

test('a WS connect receives source-status', async () => {
  const { ws, msgs } = await connect()
  try {
    const m = msgs.find(x => x.type === 'source-status')
    assert.ok(m, 'source-status arrives with the opening batch')
    assert.equal(m.sources.length, 4)
  } finally { ws.close() }
})

test('a trade ban puts pausedUntil on the trade row and the lift removes it', async () => {
  const before = Date.now()
  assert.equal(mod.noteRateLimit(3600), true)
  const m = mod.sourceStatusMsg()
  const trade = m.sources.find(s => s.source === 'trade')
  assert.ok(Math.abs(trade.pausedUntil - (before + 3600 * 1000)) < 5000)
  assert.equal(typeof trade.lastFailureAt, 'number')
  assert.match(trade.reason, /GGG rate limit, retry after 3600 s/)
  mod.clearRateLimit()
  assert.equal(mod.sourceStatusMsg().sources.find(s => s.source === 'trade').pausedUntil, null)
})

test('the fallback C:D carries no asOf', async () => {
  const { ws, msgs } = await connect()
  try {
    const cd = msgs.find(x => x.type === 'cd-ratio')
    assert.ok(cd, 'a cd-ratio arrives on connect')
    assert.equal(cd.trendHint, 'fallback')
    for (const k of ['asOf', 'staleAfterMs', 'now']) assert.equal(k in cd, false, `fallback C:D carries ${k}`)
  } finally { ws.close() }
})

test('a new POE_SOURCE_STALE_MS reaches open pages at once: source-status and an aged C:D', async () => {
  // The bar is read per message, but a setting alone used to send nothing: an
  // open page kept the old bar until the next success, failure or C:D tick
  // (15 min at least), and the C:D tile its staleAfterMs until the next cd-ratio.
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('poe.ninja')) return realFetch(url, opts)
    return {
      ok: true,
      status: 200,
      json: async () => ({ core: { primary: 'chaos' }, lines: [{ id: 'divine', primaryValue: 180, sparkline: { data: [1, 2] } }] })
    }
  }
  try {
    const cd = await mod.refreshCdRatio('SeedLeague')
    assert.equal(typeof cd.asOf, 'number', 'precondition: a C:D from poe.ninja for the room league')
  } finally { globalThis.fetch = realFetch }
  const { ws, msgs } = await connect()
  const NEW_BAR = 7 * 60 * 60 * 1000
  try {
    msgs.length = 0
    const r = await fetch(`http://${base}/config-override`, {
      method: 'POST',
      headers: { 'x-admin-password': 'admin', 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'POE_SOURCE_STALE_MS', value: String(NEW_BAR) })
    })
    assert.equal(r.status, 200, await r.clone().text())
    assert.equal((await r.json()).applied, 'live')
    await settle()
    const status = msgs.find(x => x.type === 'source-status')
    assert.ok(status, 'a source-status goes out right after the setting changed, not 10 s or one event later')
    assert.equal(status.sources.find(s => s.source === 'ninja-overview').staleAfterMs, NEW_BAR)
    const tile = msgs.find(x => x.type === 'cd-ratio')
    assert.ok(tile, 'the C:D tile gets its new bar too')
    assert.equal(tile.staleAfterMs, NEW_BAR)
  } finally {
    ws.close()
    await fetch(`http://${base}/config-override`, {
      method: 'POST',
      headers: { 'x-admin-password': 'admin', 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'POE_SOURCE_STALE_MS', value: null })
    })
  }
})
