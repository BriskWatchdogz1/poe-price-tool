// Wiring of the reference rail WITHOUT Faustus: refreshReference writes one
// point into its own history and draws the rows from it — in the unit printed
// next to them, with a static colour flag. Rows whose number IS the sell side
// (lifeforce + Dead Man's Sulphur) have no data to stand on here and therefore
// claim nothing. poe.ninja is replaced by a fetch stub (no network).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quietEnv } from './test-quiet-env.mjs'

const dir = await mkdtemp(join(tmpdir(), 'refrail-'))

// The full set that keeps a booted server off the network. One list, imported:
// every file that wrote it out by hand left something out, and what kept being
// left out was the switch a WebSocket needs (test-quiet-env.mjs, docs/bugs.md
// B25). Applied FIRST — anything this file sets below overrides it on purpose.
quietEnv()
process.env.PORT = '0'
process.env.POE_FAUSTUS_DISABLED = '1'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_NETWORTH_AUTOSYNC = '0'
process.env.POE_REFERENCE_HISTORY = join(dir, 'reference-history.ndjson')

const RATIO = 200
const EXCHANGE = {
  core: { primary: 'chaos' },
  lines: [
    { id: 'divine', primaryValue: RATIO, sparkline: { data: [1, 2] } },
    { id: 'exalted', primaryValue: 20, sparkline: { data: [1, 2] } },
    { id: 'mirror', primaryValue: 100_000, sparkline: { data: [1, 2] } },
    { id: 'vivid-lifeforce', primaryValue: 0.02, sparkline: { data: [1, 2] } },
    { id: 'wild-lifeforce', primaryValue: 2, sparkline: { data: [1, 2] } }
  ]
}
const BEASTS = {
  lines: [{ name: 'Vivid Vulture', chaosValue: 1800, divineValue: 9, count: 40, sparkLine: { data: [1, 2] } }]
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const u = String(url)
  const body = u.includes('exchange/current/overview')
    ? EXCHANGE
    : (u.includes('item/overview') ? BEASTS : { lines: [] })
  return { ok: true, status: 200, json: async () => body }
}

let mod
before(async () => { mod = await import('./server.mjs') })
after(async () => {
  globalThis.fetch = realFetch
  await new Promise(r => mod.server.close(r))
  await rm(dir, { recursive: true, force: true })
})

test('first refresh: point written, but still NO line', async () => {
  const msg = await mod.refreshReference('RailLeague')
  assert.equal(mod.referenceHistory.lastAt('RailLeague') != null, true)

  const rows = [...msg.currency, ...msg.lifeforce, ...msg.beasts]
  // Mirror + Sulphur + 3x lifeforce + 1 beast
  assert.equal(rows.length, 6)
  for (const r of rows) {
    assert.deepEqual(r.sparkline, [], `${r.name}: one point -> no line`)
    // Internal fields have no business in the protocol.
    assert.equal('key' in r, false)
    assert.equal('chaos' in r, false)
    assert.equal('unit' in r, false)
  }
})

test('Exalted Orb no longer shows up anywhere in the rail', async () => {
  const msg = await mod.refreshReference('RailLeague')
  const names = [...msg.currency, ...msg.lifeforce, ...msg.beasts].map(r => r.name)
  assert.equal(names.includes('Exalted Orb'), false)
  // ... and not in this refresh's history either.
  const pt = mod.referenceHistory.points.filter(p => p.lg === 'RailLeague').pop()
  assert.equal('c:exalted' in pt.v, false)
})

test('without solid Faustus data the row claims nothing', async () => {
  const msg = await mod.refreshReference('RailLeague')
  const sulphur = msg.currency.find(r => r.name === "Dead Man's Sulphur")
  assert.ok(sulphur, 'sulphur row exists')
  for (const r of [sulphur, ...msg.lifeforce]) {
    assert.equal(r.display, '—', `${r.name}: no number rather than a wrong one`)
    assert.equal('sell' in r, false, `${r.name}: no sell field`)
    assert.deepEqual(r.sparkline, [], `${r.name}: no line`)
  }
  // These rows do NOT land in the history either (no chaos value).
  const pt = mod.referenceHistory.points.filter(p => p.lg === 'RailLeague').pop()
  assert.deepEqual(Object.keys(pt.v).sort(), ['b:Vivid Vulture', 'c:mirror'])
})

test('display units and colour flag per row type', async () => {
  const msg = await mod.refreshReference('RailLeague') // cache hit, same message
  assert.deepEqual(msg.currency.map(r => [r.name, r.display, r.invert]), [
    ['Mirror of Kalandra', '500 div', false],
    ["Dead Man's Sulphur", '—', true]
  ])
  assert.deepEqual(msg.beasts.map(r => [r.name, r.display, r.invert]), [
    ['Vivid Vulture', '9 div', false]
  ])
})

test('with a second point every row draws its own series', async () => {
  // An older point of the same league, put straight into the loaded series:
  // half the chaos value everywhere, same rate.
  const league = 'RailLeague2'
  mod.referenceHistory.points.push({
    lg: league,
    at: Date.now() - 30 * 60 * 1000,
    cd: RATIO,
    v: { 'c:mirror': 50_000, 'b:Vivid Vulture': 900 }
  })
  const msg = await mod.refreshReference(league)

  const rows = Object.fromEntries([...msg.currency, ...msg.lifeforce, ...msg.beasts].map(r => [r.name, r]))
  // Price rows: doubled, each in its own unit.
  assert.deepEqual(rows['Mirror of Kalandra'].sparkline, [250, 500])
  assert.deepEqual(rows['Vivid Vulture'].sparkline, [4.5, 9])
})
