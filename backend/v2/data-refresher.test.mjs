// data-refresher.mjs — the background auto-updater for the three vendored
// data sources. Everything runs against injected fetch/timers and tmp dirs;
// NOTHING here touches the network or the real /config.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDataRefresher } from './data-refresher.mjs'
import { UPSTREAM_BASE, FILES } from './apt-data-update.mjs'
import { URLS as SEED_URLS } from './base-names-gen.mjs'

// --- fixtures ---------------------------------------------------------------

const ITEMS_LINES = [
  { name: 'Chaos Orb', refName: 'Chaos Orb', namespace: 'ITEM', tradeTag: 'chaos', exchangeable: true },
  { name: 'Primordial Staff', refName: 'Primordial Staff', namespace: 'ITEM', craftable: { category: 'Staff' } },
  { name: "The Crustacean's Call", refName: "The Crustacean's Call", namespace: 'UNIQUE', unique: { base: 'Primordial Staff' } },
  { name: 'Empower Support', refName: 'Empower Support', namespace: 'GEM' },
  { name: 'The Doctor', refName: 'The Doctor', namespace: 'DIVINATION_CARD', exchangeable: true },
  { name: 'Craicic Chimeral', refName: 'Craicic Chimeral', namespace: 'CAPTURED_BEAST' }
]
const itemsNdjson = (lines = ITEMS_LINES) => lines.map(l => JSON.stringify(l)).join('\n') + '\n'

const STATS_LINES = [
  { ref: '+# to maximum Life', matchers: [{ string: '+# to maximum Life' }] },
  { stats: [{ ref: '#% increased Spell Damage', matchers: [{ string: '#% increased Spell Damage' }] }] }
]
const statsNdjson = (lines = STATS_LINES) => lines.map(l => JSON.stringify(l)).join('\n') + '\n'

const clientStrings = (marker = 'v1') => {
  const extra = Array.from({ length: 25 }, (_, i) => `  K${i}: 'k${i}',`).join('\n')
  return `export default {\n  RARITY_UNIQUE: 'Unique',\n  MARKER: '${marker}',\n${extra}\n}\n`
}

const APT_BODY = v => ({
  'items.ndjson': itemsNdjson(),
  'stats.ndjson': statsNdjson(),
  'client_strings.js': clientStrings(v),
  'app_i18n.json': '{"please_wait":"Please wait"}'
})

function baseNamesFixture (n = 10) {
  const out = {}
  for (let i = 0; i < n; i++) out[`Metadata/Items/Currency/Fixture${i}`] = `Fixture Orb ${i}`
  return out
}

function baseItemsFixture (n = 10) {
  const out = {}
  for (let i = 0; i < n; i++) {
    out[`Metadata/Items/Currency/Fixture${i}`] = { name: `Fixture Orb ${i}`, release_state: 'released' }
  }
  return out
}

// A vendored (baked-in) layout in a tmp dir: public/data/en + base-names.
async function makeVendored (root) {
  const pub = path.join(root, 'vendored/public')
  await mkdir(path.join(pub, 'data/en'), { recursive: true })
  const body = APT_BODY('vendored')
  for (const f of FILES) await writeFile(path.join(pub, 'data/en', f), body[f])
  await writeFile(path.join(pub, 'data/item-drop.json'), '[]')
  await writeFile(path.join(pub, 'data/patrons.json'), '[]')
  const baseNamesPath = path.join(root, 'vendored/base-names.json')
  await writeFile(baseNamesPath, JSON.stringify(baseNamesFixture(10)))
  return { publicDir: pub, baseNamesPath }
}

// --- fetch double ------------------------------------------------------------

// routes: Map<url, () => ({ status, body, etag, lastModified })>. Records every
// request's conditional headers.
function makeFetch (routes, calls = []) {
  return async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} })
    const route = routes.get(url)
    if (!route) throw new Error(`no route for ${url}`)
    const r = typeof route === 'function' ? route(opts) : route
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: h => ({ etag: r.etag, 'last-modified': r.lastModified }[h.toLowerCase()]) },
      text: async () => r.body
    }
  }
}

const aptRoutes = (v, { status = 200 } = {}) => {
  const m = new Map()
  const body = APT_BODY(v)
  for (const f of FILES) m.set(`${UPSTREAM_BASE}/${f}`, { status, body: body[f], etag: `"${f}-${v}"`, lastModified: 'Thu, 30 Jul 2026 10:00:00 GMT' })
  return m
}

async function makeRefresher (t, { routes = new Map(), calls = [], overrides = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'data-refresher-test-'))
  const vendored = await makeVendored(root)
  const warnings = []
  const logs = []
  const r = createDataRefresher({
    dir: path.join(root, 'config/data-refresh'),
    vendored,
    fetchImpl: makeFetch(routes, calls),
    log: { warn: m => warnings.push(String(m)), log: m => logs.push(String(m)), error: () => {} },
    ...overrides
  })
  return { r, root, vendored, warnings, logs, calls }
}

// --- APT source ---------------------------------------------------------------

test('apt: adopts a validated snapshot, regenerates indices, calls the handler, persists state', async t => {
  const { r: r2, root: root2, warnings } = await makeRefresher(t, { routes: aptRoutes('new') })
  await r2.init()
  assert.equal(r2.publicDataUrl(), undefined) // baked-in active before the first tick

  const applied = []
  r2.start({ onAptData: async info => { applied.push(info) } })
  await r2.tickApt()

  assert.equal(applied.length, 1)
  assert.ok(applied[0].publicDataUrl.startsWith('file://'))
  assert.ok(applied[0].publicDataUrl.endsWith('/'))
  const versionDir = new URL(applied[0].publicDataUrl)
  // full public/ shape: source files + all four generated index bins + aux files
  for (const f of FILES) assert.ok((await stat(new URL(`data/en/${f}`, versionDir))).size > 0)
  for (const b of ['stats-ref', 'stats-matcher', 'items-name', 'items-ref']) {
    assert.ok((await stat(new URL(`data/en/${b}.index.bin`, versionDir))).size > 0)
  }
  assert.ok((await stat(new URL('data/item-drop.json', versionDir))).size > 0)
  // active pointers moved off the baked-in data
  assert.notEqual(r2.publicDataUrl(), undefined)
  assert.equal(r2.publicDataUrl(), applied[0].publicDataUrl)
  // state persisted with the upstream validators for the next conditional round
  const state = JSON.parse(await readFile(path.join(root2, 'config/data-refresh/state.json'), 'utf8'))
  assert.equal(state.apt.conditional['items.ndjson'].etag, '"items.ndjson-new"')
  assert.equal(warnings.length, 0)
})

test('apt: an unchanged upstream (304) writes nothing and stays quiet', async t => {
  // Round 1: adopt. Round 2: all four files 304.
  const routes = aptRoutes('new')
  const calls = []
  const { r, root } = await makeRefresher(t, { routes, calls })
  await r.init()
  const applied = []
  r.start({ onAptData: async info => { applied.push(info) } })
  await r.tickApt()
  assert.equal(applied.length, 1)

  const aptDirBefore = (await readdir(path.join(root, 'config/data-refresh/apt'))).sort()
  calls.length = 0
  for (const [url, route] of routes) routes.set(url, opts => (opts.headers['If-None-Match'] ? { status: 304 } : route))
  await r.tickApt()
  // conditional headers were sent, nothing changed, nothing new on disk
  assert.ok(calls.every(c => c.headers['If-None-Match']))
  assert.equal(applied.length, 1)
  const aptDirAfter = (await readdir(path.join(root, 'config/data-refresh/apt'))).sort()
  assert.deepEqual(aptDirAfter, aptDirBefore)
})

test('apt: identical content on the first check (no stored validators) only stores validators', async t => {
  // Upstream serves exactly what the vendored fixture already contains.
  const { r, root } = await makeRefresher(t, { routes: aptRoutes('vendored') })
  await r.init()
  const applied = []
  r.start({ onAptData: async info => { applied.push(info) } })
  await r.tickApt()
  assert.equal(applied.length, 0) // no adoption, no version dir
  assert.equal(r.publicDataUrl(), undefined)
  const state = JSON.parse(await readFile(path.join(root, 'config/data-refresh/state.json'), 'utf8'))
  assert.equal(state.apt.conditional['items.ndjson'].etag, '"items.ndjson-vendored"') // tomorrow is a 304 day
})

test('base-names: identical map only stores validators, no handler call', async t => {
  const routes = new Map([[SEED_URLS.baseItems, { status: 200, body: JSON.stringify(baseItemsFixture(10)), etag: '"same"' }]])
  const { r, root } = await makeRefresher(t, { routes })
  await r.init()
  const applied = []
  r.start({ onBaseNames: async info => { applied.push(info) } })
  await r.tickBaseNames()
  assert.equal(applied.length, 0)
  const state = JSON.parse(await readFile(path.join(root, 'config/data-refresh/state.json'), 'utf8'))
  assert.equal(state.baseNames.conditional.etag, '"same"')
})

test('apt: a broken download is rejected and the old state kept', async t => {
  // items.ndjson loses the UNIQUE namespace -> schema guard must refuse.
  const routes = aptRoutes('bad')
  routes.set(`${UPSTREAM_BASE}/items.ndjson`, {
    status: 200,
    body: itemsNdjson(ITEMS_LINES.filter(l => l.namespace !== 'UNIQUE')),
    etag: '"broken"'
  })
  const { r, root, warnings } = await makeRefresher(t, { routes })
  await r.init()
  const applied = []
  r.start({ onAptData: async info => { applied.push(info) } })
  await r.tickApt()

  assert.equal(applied.length, 0)
  assert.equal(r.publicDataUrl(), undefined) // baked-in stays active
  assert.ok(warnings.some(w => w.includes('REJECTED')), `expected a REJECTED warning, got: ${warnings}`)
  // no version dir was adopted, no state written for apt (a rejected snapshot
  // leaves NO trace — state.json only exists after a real adoption)
  const state = await readFile(path.join(root, 'config/data-refresh/state.json'), 'utf8').then(JSON.parse).catch(() => ({}))
  assert.equal(state.apt?.version, undefined)
})

test('apt: unparsable items.ndjson is rejected', async t => {
  const routes = aptRoutes('bad2')
  routes.set(`${UPSTREAM_BASE}/items.ndjson`, { status: 200, body: itemsNdjson() + 'NOT JSON\n', etag: '"x"' })
  const { r, warnings } = await makeRefresher(t, { routes })
  await r.init()
  r.start({})
  await r.tickApt()
  assert.equal(r.publicDataUrl(), undefined)
  assert.ok(warnings.some(w => w.includes('REJECTED')))
})

test('apt: a handler veto (failed engine reload) discards the snapshot', async t => {
  const { r, root, warnings } = await makeRefresher(t, { routes: aptRoutes('veto') })
  await r.init()
  r.start({ onAptData: async () => { throw new Error('reload exploded') } })
  await r.tickApt()

  assert.equal(r.publicDataUrl(), undefined)
  assert.ok(warnings.some(w => w.includes('could not be applied')))
  const names = await readdir(path.join(root, 'config/data-refresh/apt'))
  assert.deepEqual(names.filter(n => n.startsWith('v-') || n.startsWith('tmp-')), [])
})

test('apt: a fetch error is caught by the tick wrapper, old state kept', async t => {
  const routes = aptRoutes('err')
  routes.set(`${UPSTREAM_BASE}/stats.ndjson`, { status: 500, body: 'oops' })
  const { r, warnings } = await makeRefresher(t, { routes })
  await r.init()
  r.start({})
  await r.tickApt() // must not throw
  assert.equal(r.publicDataUrl(), undefined)
  assert.ok(warnings.some(w => w.includes('check failed')))
})

// --- persistence across restarts ---------------------------------------------

test('a restart prefers the persisted snapshot; a gutted one falls back to baked-in', async t => {
  const routes = aptRoutes('persist')
  const { r, root, vendored } = await makeRefresher(t, { routes })
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  const adoptedUrl = r.publicDataUrl()
  assert.ok(adoptedUrl)

  // "restart": a second instance over the same dir, same vendored fallbacks
  const r3 = createDataRefresher({
    dir: path.join(root, 'config/data-refresh'),
    vendored,
    fetchImpl: makeFetch(routes),
    log: { warn: () => {}, log: () => {}, error: () => {} }
  })
  await r3.init()
  assert.equal(r3.publicDataUrl(), adoptedUrl)

  // gut the snapshot (delete one required file) -> boot must fall back
  const versionDirs = (await readdir(path.join(root, 'config/data-refresh/apt'))).filter(n => n.startsWith('v-'))
  assert.equal(versionDirs.length, 1)
  const { rm } = await import('node:fs/promises')
  await rm(path.join(root, 'config/data-refresh/apt', versionDirs[0], 'data/en/items-name.index.bin'))
  const warnings = []
  const r4 = createDataRefresher({
    dir: path.join(root, 'config/data-refresh'),
    vendored,
    fetchImpl: makeFetch(routes),
    log: { warn: m => warnings.push(String(m)), log: () => {}, error: () => {} }
  })
  await r4.init()
  assert.equal(r4.publicDataUrl(), undefined)
  assert.ok(warnings.some(w => w.includes('incomplete')))
})

// --- unwritable dir -----------------------------------------------------------

test('an unwritable dir disables the whole feature silently (one warning, no scheduling)', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'data-refresher-test-'))
  const vendored = await makeVendored(root)
  await writeFile(path.join(root, 'blocker'), 'file, not dir')
  const warnings = []
  const scheduled = []
  const r = createDataRefresher({
    dir: path.join(root, 'blocker/data-refresh'), // parent is a file -> mkdir fails
    vendored,
    fetchImpl: async () => { throw new Error('must not fetch') },
    timers: { setTimeout: (fn, ms) => { scheduled.push(ms); return { unref () {} } }, clearTimeout: () => {} },
    log: { warn: m => warnings.push(String(m)), log: () => {}, error: () => {} }
  })
  await r.init()
  assert.equal(r.writable(), false)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('auto-update off'))
  // baked-in pointers still valid -> server can boot normally
  assert.equal(r.publicDataUrl(), undefined)
  assert.equal(r.baseNamesPath(), vendored.baseNamesPath)
  r.start({})
  assert.deepEqual(scheduled, []) // nothing scheduled, no per-tick throwing ever
})

// --- scheduling / env interval -------------------------------------------------

test('start() staggers the sources and reschedules with the configured interval', async t => {
  const scheduled = [] // { ms, fn }
  const routes = aptRoutes('sched')
  for (const [url, route] of routes) routes.set(url, opts => (opts.headers['If-None-Match'] ? { status: 304 } : route))
  routes.set(SEED_URLS.baseItems, { status: 304 })
  const { r } = await makeRefresher(t, {
    routes,
    overrides: {
      intervalMs: 1234,
      initialDelaysMs: { apt: 11, baseNames: 22 },
      timers: { setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return { unref () {} } }, clearTimeout: () => {} }
    }
  })
  await r.init()
  r.start({})
  assert.deepEqual(scheduled.map(s => s.ms), [11, 22]) // staggered initial checks
  // fire the first (apt) tick; afterwards it must be rescheduled at intervalMs
  scheduled[0].fn()
  await new Promise(res => setTimeout(res, 50))
  assert.equal(scheduled.length, 3)
  assert.equal(scheduled[2].ms, 1234)
})

// --- base-names ---------------------------------------------------------------

test('base-names: adopts a grown map, hands it to the handler, then 304s stay quiet', async t => {
  const calls = []
  const routes = new Map([[SEED_URLS.baseItems, opts => (
    opts.headers['If-None-Match'] === '"bn-v2"'
      ? { status: 304 }
      : { status: 200, body: JSON.stringify(baseItemsFixture(12)), etag: '"bn-v2"', lastModified: 'Fri, 31 Jul 2026 06:00:00 GMT' }
  )]])
  const { r, root, logs } = await makeRefresher(t, { routes, calls })
  await r.init()
  const applied = []
  r.start({ onBaseNames: async info => { applied.push(info) } })
  await r.tickBaseNames()

  assert.equal(applied.length, 1)
  const written = JSON.parse(await readFile(applied[0].path, 'utf8'))
  assert.equal(Object.keys(written).length, 12)
  assert.equal(r.baseNamesPath(), applied[0].path)
  assert.ok(logs.some(l => l.includes('base-names.json updated: 10 -> 12')))

  await r.tickBaseNames() // conditional round: 304 -> no second handler call
  assert.equal(applied.length, 1)
})

test('base-names: an implausibly shrunken map is rejected, old map stays', async t => {
  const routes = new Map([[SEED_URLS.baseItems, { status: 200, body: JSON.stringify(baseItemsFixture(2)), etag: '"tiny"' }]])
  const { r, vendored, warnings } = await makeRefresher(t, { routes })
  await r.init()
  const applied = []
  r.start({ onBaseNames: async info => { applied.push(info) } })
  await r.tickBaseNames()
  assert.equal(applied.length, 0)
  assert.equal(r.baseNamesPath(), vendored.baseNamesPath)
  assert.ok(warnings.some(w => w.includes('REJECTED')))
})

// --- observability: one line per check + freshness state ---------------------
// The point of the brief: silence must no longer be ambiguous. Every check
// leaves EXACTLY one outcome line behind, and the timestamp of the last
// successful check lives in state.json + status().

// Every line (log + warn) that concludes a check.
const outcomeLines = (logs, warnings) =>
  [...logs, ...warnings].filter(l => /^\[data-refresh\] [\w-]+ check (updated|unchanged|failed)/.test(l))

test('every check writes exactly one outcome line: updated', async t => {
  const { r, logs, warnings } = await makeRefresher(t, { routes: aptRoutes('obs-updated') })
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  const lines = outcomeLines(logs, warnings)
  assert.equal(lines.length, 1, `exactly one outcome line, got: ${JSON.stringify(lines)}`)
  assert.match(lines[0], /^\[data-refresh\] apt check updated — APT data updated \(v-/)
  // the size of the change is in the line (the fixture changes client_strings.js)
  assert.match(lines[0], /client_strings\.js \d+->\d+ lines \(\+\d+\/-\d+\)/)
  assert.match(lines[0], /upstream baked-in -> Thu, 30 Jul 2026/)
})

test('every check writes exactly one outcome line: unchanged (304)', async t => {
  const routes = aptRoutes('obs-unchanged')
  for (const [url] of routes) routes.set(url, { status: 304 })
  const { r, logs, warnings } = await makeRefresher(t, { routes })
  await r.init()
  r.start({})
  await r.tickApt()
  const lines = outcomeLines(logs, warnings)
  assert.equal(lines.length, 1, `exactly one outcome line, got: ${JSON.stringify(lines)}`)
  assert.match(lines[0], /^\[data-refresh\] apt check unchanged — upstream reported no change \(304\); data as shipped$/)
})

test('every check writes exactly one outcome line: failed (with a reason)', async t => {
  const routes = aptRoutes('obs-failed')
  routes.set(`${UPSTREAM_BASE}/stats.ndjson`, { status: 500, body: 'oops' })
  const { r, logs, warnings } = await makeRefresher(t, { routes })
  await r.init()
  r.start({})
  await r.tickApt()
  const lines = outcomeLines(logs, warnings)
  assert.equal(lines.length, 1, `exactly one outcome line, got: ${JSON.stringify(lines)}`)
  assert.match(lines[0], /^\[data-refresh\] apt check failed \(kept last good state\): fetch failed \(500\)/)
  assert.match(lines[0], /last success none yet$/)
})

test('rejected content: the detailed warning STAYS, plus exactly one outcome line', async t => {
  const routes = aptRoutes('obs-reject')
  routes.set(`${UPSTREAM_BASE}/items.ndjson`, {
    status: 200,
    body: itemsNdjson(ITEMS_LINES.filter(l => l.namespace !== 'UNIQUE')),
    etag: '"broken"'
  })
  const { r, logs, warnings } = await makeRefresher(t, { routes })
  await r.init()
  r.start({})
  await r.tickApt()
  assert.ok(warnings.some(w => w.includes('REJECTED')), 'the detailed warning stays')
  const lines = outcomeLines(logs, warnings)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /apt check failed .*snapshot rejected \(items\.ndjson: namespace UNIQUE missing\)/)
})

test('status(): the stale threshold derives from the interval, tunable via staleTicks', async t => {
  const { r } = await makeRefresher(t, { overrides: { intervalMs: 1000, staleTicks: 3 } })
  await r.init()
  assert.equal(r.status().intervalMs, 1000)
  assert.equal(r.status().staleAfterMs, 3000)
  const { r: r2 } = await makeRefresher(t, { overrides: { intervalMs: 60_000, staleTicks: 5 } })
  await r2.init()
  assert.equal(r2.status().staleAfterMs, 300_000)
})

test('status(): a successful check (unchanged included) sets lastSuccessAt, a failure does not', async t => {
  const routes = aptRoutes('obs-state')
  for (const [url] of routes) routes.set(url, { status: 304 })
  let clock = 1_000_000
  const { r, root } = await makeRefresher(t, { routes, overrides: { now: () => clock } })
  await r.init()
  r.start({})

  const before = r.status()
  assert.equal(before.sources.find(s => s.key === 'apt').lastSuccessAt, null)
  assert.ok(before.since > 0, 'since is the age floor before the very first check')

  await r.tickApt()
  const okAt = r.status().sources.find(s => s.key === 'apt')
  assert.equal(okAt.lastSuccessAt, clock, 'unchanged counts as a successful check')
  assert.equal(okAt.lastOutcome, 'unchanged')
  // persisted (survives a restart)
  const persisted = JSON.parse(await readFile(path.join(root, 'config/data-refresh/state.json'), 'utf8'))
  assert.equal(persisted.checks.apt.lastSuccessAt, clock)

  // now the source goes down: lastSuccessAt stays put, lastOutcome flips
  clock += 5000
  routes.set(`${UPSTREAM_BASE}/stats.ndjson`, { status: 500, body: 'down' })
  await r.tickApt()
  const failed = r.status().sources.find(s => s.key === 'apt')
  assert.equal(failed.lastSuccessAt, 1_000_000, 'last success keeps the old timestamp')
  assert.equal(failed.lastCheckAt, clock)
  assert.equal(failed.lastOutcome, 'failed')
})

test('status(): onCheck reports after EVERY check', async t => {
  const routes = aptRoutes('obs-hook')
  for (const [url] of routes) routes.set(url, { status: 304 })
  routes.set(SEED_URLS.baseItems, { status: 304 })
  const { r } = await makeRefresher(t, { routes })
  await r.init()
  const seen = []
  r.start({ onCheck: st => seen.push(st) })
  await r.tickApt()
  await r.tickBaseNames()
  assert.equal(seen.length, 2)
  assert.equal(seen[1].sources.length, 2)
  assert.ok(seen[1].sources.every(s => typeof s.source === 'string'))
})
