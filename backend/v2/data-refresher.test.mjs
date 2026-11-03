// data-refresher.mjs — the background auto-updater for the three vendored
// data sources. Everything runs against injected fetch/timers and tmp dirs;
// NOTHING here touches the network or the real /config.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDataRefresher, LANG_FILES } from './data-refresher.mjs'
import { AGENT_BASE } from './version.mjs'
import { FAIL_KIND, failure } from './check-failure.mjs'
import { UPSTREAM_BASE, FILES } from './apt-data-update.mjs'
import { URLS as SEED_URLS } from './base-names-gen.mjs'
import { buildIndexBins } from './apt-index.mjs'
import { generatorVersion as realGeneratorVersion } from './lang-data-gen.mjs'

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

// The synthetic German set: same skeleton, translated display names. Exactly
// the shape a generator run produces (refName untouched, only `name` and the
// matcher strings localized), so the copy-forward tests below run on data that
// is distinguishable from the English one at a glance.
const DE_ITEMS = itemsNdjson(ITEMS_LINES.map(l => ({ ...l, name: `Ü${l.name}` })))
const DE_STATS = statsNdjson(STATS_LINES.map(l => (
  l.stats
    ? { stats: l.stats.map(s => ({ ...s, matchers: s.matchers.map(m => ({ ...m, string: `Ü${m.string}` })) })) }
    : { ...l, matchers: l.matchers.map(m => ({ ...m, string: `Ü${m.string}` })) }
)))
const DE_BODY = {
  'items.ndjson': DE_ITEMS,
  'stats.ndjson': DE_STATS,
  'client_strings.js': clientStrings('de')
}

// Writes a complete data/<lang> set (sources + the four generated indices).
async function writeLangSet (publicDir, lang, body = DE_BODY) {
  const dir = path.join(publicDir, 'data', lang)
  await mkdir(dir, { recursive: true })
  for (const f of LANG_FILES) await writeFile(path.join(dir, f), body[f])
  const bins = buildIndexBins({ itemsNdjson: body['items.ndjson'], statsNdjson: body['stats.ndjson'] })
  for (const [name, arr] of Object.entries(bins)) {
    await writeFile(path.join(dir, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
  }
}

// A vendored (baked-in) layout in a tmp dir: public/data/en + base-names.
// `de: true` also lays down a German set — the state an installation is in
// once a generator run has produced one.
async function makeVendored (root, { de = false } = {}) {
  const pub = path.join(root, 'vendored/public')
  await mkdir(path.join(pub, 'data/en'), { recursive: true })
  const body = APT_BODY('vendored')
  for (const f of FILES) await writeFile(path.join(pub, 'data/en', f), body[f])
  await writeFile(path.join(pub, 'data/item-drop.json'), '[]')
  await writeFile(path.join(pub, 'data/patrons.json'), '[]')
  if (de) await writeLangSet(pub, 'de')
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

async function makeRefresher (t, { routes = new Map(), calls = [], overrides = {}, de = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'data-refresher-test-'))
  const vendored = await makeVendored(root, { de })
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
// The point of the brief: silence must not be ambiguous. Every check
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

// --- why a check failed (docs/bugs.md B24) ---------------------------------
// The outcome alone left the browser saying "no successful check for 5 days"
// with the cause one log line lower. These four nail down that the cause
// travels, that it is CLASSED at the site that knows, and that a success takes
// it back off the wire.

test('status(): a failed check carries its reason and class, and a success clears both', async t => {
  const routes = aptRoutes('why-failed')
  routes.set(`${UPSTREAM_BASE}/stats.ndjson`, { status: 503, body: 'gone' })
  let clock = 2_000_000
  const { r, root } = await makeRefresher(t, { routes, overrides: { now: () => clock } })
  await r.init()
  r.start({})
  await r.tickApt()

  const failed = r.status().sources.find(s => s.key === 'apt')
  assert.equal(failed.lastOutcome, 'failed')
  assert.match(failed.lastReason, /fetch failed \(503\)/)
  assert.equal(failed.lastFailKind, 'unreachable', 'an upstream that will not answer is not something to act on')
  // Persisted, so a restart does not lose the reason a source has been quiet for.
  const persisted = JSON.parse(await readFile(path.join(root, 'config/data-refresh/state.json'), 'utf8'))
  assert.match(persisted.checks.apt.lastReason, /fetch failed \(503\)/)
  assert.equal(persisted.checks.apt.lastFailKind, 'unreachable')

  clock += 5000
  for (const [url] of routes) routes.set(url, { status: 304 })
  await r.tickApt()
  const ok = r.status().sources.find(s => s.key === 'apt')
  assert.equal(ok.lastOutcome, 'unchanged')
  assert.equal(ok.lastReason, null, 'a source that answers again must not keep an old reason on screen')
  assert.equal(ok.lastFailKind, null)
})

test('status(): content this tool refused is classed `rejected`, not `unreachable`', async t => {
  // The distinction the status line exists for: waiting helps with one of these
  // and with the other it does not.
  const routes = aptRoutes('why-rejected')
  routes.set(`${UPSTREAM_BASE}/items.ndjson`, {
    status: 200,
    body: itemsNdjson(ITEMS_LINES.filter(l => l.namespace !== 'UNIQUE')),
    etag: '"broken"'
  })
  const { r } = await makeRefresher(t, { routes })
  await r.init()
  r.start({})
  await r.tickApt()
  const s = r.status().sources.find(s => s.key === 'apt')
  assert.equal(s.lastFailKind, 'rejected')
  assert.match(s.lastReason, /namespace UNIQUE missing/)
})

test('status(): the reason is bounded by reasonMaxChars, whatever upstream says', async t => {
  const routes = aptRoutes('why-long')
  routes.set(`${UPSTREAM_BASE}/stats.ndjson`, { status: 500, body: 'x'.repeat(50_000) })
  const { r } = await makeRefresher(t, { routes, overrides: { reasonMaxChars: 60 } })
  await r.init()
  r.start({})
  await r.tickApt()
  const s = r.status().sources.find(s => s.key === 'apt')
  assert.ok(s.lastReason.length <= 60, `reason is ${s.lastReason.length} chars`)
  assert.match(s.lastReason, /^fetch failed \(500\)/)
})

test('status(): an unclassified failure stays `unknown` instead of being guessed at', async t => {
  const routes = aptRoutes('why-unknown')
  routes.set(SEED_URLS.baseItems, { status: 200, body: JSON.stringify(baseItemsFixture(12)) })
  const { r } = await makeRefresher(t, {
    routes,
    overrides: { buildBaseNames: () => { throw new Error('something nobody classified') } }
  })
  await r.init()
  r.start({})
  await r.tickBaseNames()
  const s = r.status().sources.find(s => s.key === 'baseNames')
  assert.equal(s.lastFailKind, 'unknown')
  assert.match(s.lastReason, /something nobody classified/)
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

// --- bilingual snapshots -------------------------------------------------
// The German set has NO upstream: it is generated locally, so the only place
// the next snapshot can get one from is the snapshot that is active right now.
// Everything below is about that carry-forward and the boot check that guards
// it.

// A second refresher over the SAME /config dir — what a container restart does.
function remake (root, vendored, sink = {}) {
  sink.warnings = []
  sink.logs = []
  return createDataRefresher({
    dir: path.join(root, 'config/data-refresh'),
    vendored,
    fetchImpl: async () => { throw new Error('no network in this test') },
    log: { warn: m => sink.warnings.push(String(m)), log: m => sink.logs.push(String(m)), error: () => {} }
  })
}

test('apt: the German set survives repeated English-only adoptions', async t => {
  // Three adoptions in a row. pruneAptVersions keeps only the active snapshot
  // and its predecessor, so from the third one on, anything that was not
  // carried forward is deleted from disk — this is the test that fails without
  // the carry-forward, and it fails on the FIRST adoption already.
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const routes = aptRoutes('r1')
  const { r, root, warnings } = await makeRefresher(t, { routes, de: true, overrides: { now: () => (clock += 60_000) } })
  await r.init()
  assert.deepEqual(r.activeLanguages(), ['en', 'de'], 'the baked-in German set is seen at boot')

  const applied = []
  r.start({ onAptData: async info => { applied.push(info) } })
  for (const v of ['r1', 'r2', 'r3']) {
    for (const [url, route] of aptRoutes(v)) routes.set(url, route)
    await r.tickApt()
  }
  assert.equal(applied.length, 3)
  assert.equal(warnings.length, 0)

  const kept = (await readdir(path.join(root, 'config/data-refresh/apt'))).filter(n => n.startsWith('v-'))
  assert.equal(kept.length, 2, 'active + predecessor, everything older pruned')

  const active = r.publicDir()
  for (const [f, want] of Object.entries(DE_BODY)) {
    assert.equal(await readFile(path.join(active, 'data/de', f), 'utf8'), want, `data/de/${f} carried over unchanged`)
  }
  // ...with indices rebuilt from exactly that ndjson, not copied from anywhere.
  const bins = buildIndexBins({ itemsNdjson: DE_BODY['items.ndjson'], statsNdjson: DE_BODY['stats.ndjson'] })
  for (const [name, arr] of Object.entries(bins)) {
    const onDisk = await readFile(path.join(active, 'data/de', name))
    assert.deepEqual([...onDisk], [...Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)], name)
  }
  // English really did move on while German stood still.
  assert.match(await readFile(path.join(active, 'data/en/client_strings.js'), 'utf8'), /MARKER: 'r3'/)
  assert.equal(r.itemsNdjsonPath('de'), path.join(active, 'data/de/items.ndjson'))
  assert.deepEqual(r.activeLanguages(), ['en', 'de'])
  for (const info of applied) assert.deepEqual(info.languages, ['en', 'de'], 'the handler is told what the snapshot carries')
  const state = JSON.parse(await readFile(path.join(root, 'config/data-refresh/state.json'), 'utf8'))
  assert.deepEqual(state.apt.langs, ['en', 'de'])
})

test('apt: an English-only install stays English-only, and its old state.json still boots', async t => {
  const routes = aptRoutes('en-only')
  const { r, root, vendored } = await makeRefresher(t, { routes })
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  assert.deepEqual(r.activeLanguages(), ['en'])

  // A state.json written before this feature existed has no `langs` key at
  // all. The boot check must not start demanding data/de because of it —
  // otherwise the first restart after the update throws away a perfectly good
  // snapshot.
  const statePath = path.join(root, 'config/data-refresh/state.json')
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  delete state.apt.langs
  await writeFile(statePath, JSON.stringify(state))

  const sink = {}
  const r2 = remake(root, vendored, sink)
  await r2.init()
  assert.equal(r2.publicDir(), path.join(root, 'config/data-refresh/apt', state.apt.version))
  assert.deepEqual(sink.warnings, [])
})

test('apt: a snapshot adopted WITH a German set is rejected at boot once that set is gutted', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const routes = aptRoutes('with-de')
  const { r, root, vendored } = await makeRefresher(t, { routes, de: true, overrides: { now: () => (clock += 60_000) } })
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  const versionDir = r.publicDir()

  // Half a German set — the container was killed mid-write, or the volume ran
  // full. Every English file is still perfect, so only the conditional check
  // can catch this.
  await rm(path.join(versionDir, 'data/de/stats.ndjson'))

  const sink = {}
  const r2 = remake(root, vendored, sink)
  await r2.init()
  assert.equal(r2.publicDir(), vendored.publicDir, 'falls back to the baked-in data')
  assert.equal(sink.warnings.length, 1)
  assert.match(sink.warnings[0], /German set/)
})

test('apt: a BROKEN German set costs the English users nothing (loud, English-only snapshot)', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const routes = aptRoutes('broken-de')
  const { r, warnings, vendored } = await makeRefresher(t, { routes, de: true, overrides: { now: () => (clock += 60_000) } })
  await writeFile(path.join(vendored.publicDir, 'data/de/items.ndjson'), 'not json at all\n')
  await r.init()
  const applied = []
  r.start({ onAptData: async info => { applied.push(info) } })
  await r.tickApt()

  assert.equal(applied.length, 1, 'English is adopted regardless')
  assert.deepEqual(applied[0].languages, ['en'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /German set could not be carried/)
  assert.deepEqual(r.activeLanguages(), ['en'])
})

// --- the display texts of the two languages (docs/bugs.md B24) --------------
// English client_strings.js is refreshed daily; the localized one is hand
// written and ships with the image. A key upstream adds is simply absent for
// that language, and the failure it causes surfaces as an unexplained German
// parse error much later.

// An English client_strings.js with extra keys on top of the fixture's.
const clientStringsPlus = (marker, extraKeys = []) =>
  clientStrings(marker).replace('\n}\n', '\n' + extraKeys.map(k => `  ${k}: '${k}',`).join('\n') + '\n}\n')

test('apt: keys the new English set has and the localized one does not are reported', async t => {
  let clock = Date.parse('2026-08-18T00:00:00Z')
  const routes = aptRoutes('drift')
  routes.set(`${UPSTREAM_BASE}/client_strings.js`, {
    status: 200,
    body: clientStringsPlus('drift', ['NEW_UPSTREAM_KEY', 'ANOTHER_NEW_KEY']),
    etag: '"cs-drift"'
  })
  const { r, warnings, logs, root } = await makeRefresher(t, {
    routes,
    de: true,
    overrides: { languages: ['en', 'de'], now: () => (clock += 60_000) }
  })
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()

  const drift = r.clientStringDrift()
  assert.equal(drift.langs.de.missingCount, 2)
  assert.deepEqual(drift.langs.de.missing, ['NEW_UPSTREAM_KEY', 'ANOTHER_NEW_KEY'])
  assert.equal(drift.langs.de.extraCount, 0)
  assert.ok(warnings.some(w => /client_strings drift/.test(w) && /NEW_UPSTREAM_KEY/.test(w)),
    `the drift is not in the warnings: ${warnings.join(' | ')}`)
  // ...and the remedy, which is not a data refresh: the file ships with the image.
  assert.ok(warnings.some(w => /container update/.test(w)))
  // The one outcome line says it too, so a log reader does not have to correlate.
  assert.ok(logs.some(l => /apt check updated/.test(l) && /client_strings: data\/de lacks 2 key/.test(l)))
  // Persisted, so a restart does not lose it with the log line.
  const state = JSON.parse(await readFile(path.join(root, 'config/data-refresh/state.json'), 'utf8'))
  assert.equal(state.clientStrings.langs.de.missingCount, 2)
})

test('apt: two sets that agree produce no drift warning at all', async t => {
  let clock = Date.parse('2026-08-18T00:00:00Z')
  const { r, warnings } = await makeRefresher(t, {
    routes: aptRoutes('same-keys'),
    de: true,
    overrides: { languages: ['en', 'de'], now: () => (clock += 60_000) }
  })
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  // Only the client_strings comparison is under test here; the lang-data tick
  // of this bare refresher has no patch lookup and says so in its own line.
  assert.deepEqual(warnings.filter(w => /client_strings/.test(w)), [],
    'the fixture sets carry the same keys')
  const drift = r.clientStringDrift()
  assert.equal(drift.langs.de.missingCount, 0)
  assert.equal(drift.langs.de.extraCount, 0)
})

test('apt: an English-only install compares nothing and says nothing', async t => {
  const { r, warnings } = await makeRefresher(t, { routes: aptRoutes('en-only-drift') })
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  assert.equal(r.clientStringDrift(), null)
  assert.deepEqual(warnings, [])
})

// --- the localized set: generated, triggered by a SOLL/IST comparison -------
// The German set has no upstream, so nothing about the ETag/Last-Modified path
// applies to it. What triggers a run is a comparison of what the set says it
// was built from (build-info.json) against what it WOULD be built from now:
// the patch version and the identity of the English snapshot. Everything below
// drives that comparison; the generator itself is a double (the real one needs
// GGG's game data and minutes of work — its own tests cover it).

// A generator double with the same contract as lang-data-gen.mjs `generate`:
// it writes items.ndjson/stats.ndjson plus the four indices into `out` and
// NEVER touches client_strings.js.
function fakeGenerator ({ calls = [], fail = null, during = null, body = DE_BODY, counts = null, itemsReport = null } = {}) {
  return async opts => {
    calls.push(opts)
    if (during) await during(opts)
    if (fail) throw new Error(fail)
    await mkdir(opts.out, { recursive: true })
    for (const f of ['items.ndjson', 'stats.ndjson']) {
      await writeFile(path.join(opts.out, f), body[f])
    }
    const bins = buildIndexBins({ itemsNdjson: body['items.ndjson'], statsNdjson: body['stats.ndjson'] })
    for (const [name, arr] of Object.entries(bins)) {
      await writeFile(path.join(opts.out, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
    }
    // The real generator returns its validation result; `counts` lets a test
    // hand back a coverage figure without pulling in the derivation. A double
    // that returns nothing is deliberately still legal — the refresher may not
    // depend on it.
    if (!counts && !itemsReport) return { ok: true }
    return {
      ok: true,
      ...(counts ? { result: { counts } } : {}),
      ...(itemsReport ? { items: { report: itemsReport } } : {})
    }
  }
}

const patchStub = (patch = '3.29.2.1', calls = []) => async () => {
  calls.push(patch)
  return { patch, source: 'test' }
}

// The whole German path in one helper: a de-speaking install, a generator
// double, a patch lookup double.
async function makeLangRefresher (t, {
  routes = new Map(), patch = '3.29.2.1', gen = {}, overrides = {}, de = false
} = {}) {
  const genCalls = []
  const patchCalls = []
  const base = await makeRefresher(t, {
    routes,
    de,
    overrides: {
      languages: ['en', 'de'],
      generateLangData: fakeGenerator({ calls: genCalls, ...gen }),
      resolvePatch: patchStub(patch, patchCalls),
      ...overrides
    }
  })
  return { ...base, genCalls, patchCalls }
}

// 304 everywhere: the English source has nothing to say, which is the ONLY
// state in which "the German set is regenerated anyway" can be demonstrated.
const quietRoutes = () => {
  const m = aptRoutes('quiet')
  for (const [url] of m) m.set(url, { status: 304 })
  return m
}

const langSource = r => r.status().sources.find(s => s.key === 'langData')

test('lang-data: with no localized set at all, one apt tick generates and adopts it', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const { r, root, vendored, genCalls, patchCalls, warnings } = await makeLangRefresher(t, {
    routes: quietRoutes(), overrides: { now: () => (clock += 60_000) }
  })
  // The hand written client_strings.js is the one thing the generator never
  // produces: it ships with the image.
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  assert.deepEqual(r.generatedLanguages(), ['de'])
  assert.deepEqual(r.activeLanguages(), ['en'], 'nothing to serve German with yet')

  const applied = []
  r.start({ onAptData: async info => { applied.push(info) } })
  await r.tickApt()

  assert.equal(patchCalls.length, 1)
  assert.equal(genCalls.length, 1, 'exactly one generator run')
  assert.equal(genCalls[0].lang, 'de')
  assert.equal(genCalls[0].patch, '3.29.2.1')
  assert.equal(warnings.length, 0)

  // English said 304, so ONLY the German step produced a snapshot.
  assert.equal(applied.length, 1)
  assert.deepEqual(applied[0].languages, ['en', 'de'])
  const active = r.publicDir()
  assert.equal(active, path.join(root, 'config/data-refresh/apt', path.basename(active)))
  assert.deepEqual(r.activeLanguages(), ['en', 'de'])

  // The generator wrote into the candidate, not into the live snapshot; the
  // hand written strings came from the image, not from the generator.
  assert.equal(await readFile(path.join(active, 'data/de/items.ndjson'), 'utf8'), DE_BODY['items.ndjson'])
  assert.equal(
    await readFile(path.join(active, 'data/de/client_strings.js'), 'utf8'),
    clientStrings('hand-written-de')
  )
  // ...and the English tree came along byte for byte, indices and aux included.
  assert.equal(
    await readFile(path.join(active, 'data/en/items.ndjson'), 'utf8'),
    await readFile(path.join(vendored.publicDir, 'data/en/items.ndjson'), 'utf8')
  )
  for (const aux of ['item-drop.json', 'patrons.json']) {
    await stat(path.join(active, 'data', aux))
  }

  const info = JSON.parse(await readFile(path.join(active, 'data/de/build-info.json'), 'utf8'))
  assert.equal(info.patch, '3.29.2.1')
  assert.equal(typeof info.enFingerprint, 'string')
  assert.ok(info.enFingerprint.length >= 32)
  // Without an injected one, the version is the hash of the generator files
  // this checkout carries — the same thing the image computes at runtime.
  const realVersion = await realGeneratorVersion()
  assert.match(realVersion, /^[0-9a-f]{16}$/)
  assert.equal(info.generator, realVersion)

  const src = langSource(r)
  assert.equal(src.lastOutcome, 'updated')
  assert.ok(src.lastSuccessAt > 0)
  const state = JSON.parse(await readFile(path.join(root, 'config/data-refresh/state.json'), 'utf8'))
  assert.deepEqual(state.apt.langs, ['en', 'de'])
  assert.equal(state.langData.patch, '3.29.2.1')
  assert.equal(state.langData.generator, realVersion)
})

test('lang-data: a second tick does nothing — the comparison, not a flag, is what stops it', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const { r, vendored, genCalls, logs } = await makeLangRefresher(t, {
    routes: quietRoutes(), overrides: { now: () => (clock += 60_000) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })

  await r.tickApt()
  await r.tickApt()
  assert.equal(genCalls.length, 1, 'the set it just wrote is not stale')
  assert.equal(langSource(r).lastOutcome, 'unchanged')
  assert.ok(logs.some(l => /lang-data check unchanged/.test(l)))
})

test('lang-data: a failed run keeps failing every tick — the source really goes stale', async t => {
  // THE test for level instead of edge. An event driven trigger would see
  // "patch unchanged, no new English adoption" on the second tick, report
  // `unchanged`, and runJob would carry lastSuccessAt forward (only `failed` is
  // excluded from it). The source would never age, the skew would stay
  // invisible, and nobody would ever learn that German is a patch behind.
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const { r, vendored, genCalls, warnings } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    gen: { fail: 'the game data export came back empty' },
    overrides: { now: () => (clock += 60_000) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })

  const outcomes = []
  for (let i = 0; i < 3; i++) {
    await r.tickApt()
    outcomes.push(langSource(r).lastOutcome)
  }
  assert.deepEqual(outcomes, ['failed', 'failed', 'failed'])
  assert.equal(genCalls.length, 3, 'every tick tries again instead of reporting nothing to do')
  assert.equal(langSource(r).lastSuccessAt, null, 'never a success -> the source ages and turns stale')
  assert.ok(langSource(r).lastCheckAt > 0, 'it was checked, though — silence would mean "not running"')
  assert.ok(warnings.some(w => /generating data\/de FAILED/.test(w)))

  // Skew policy: English is not held hostage by a language it does not use.
  const apt = r.status().sources.find(s => s.key === 'apt')
  assert.equal(apt.lastOutcome, 'unchanged')
  assert.ok(apt.lastSuccessAt > 0)
})

test('lang-data: an English adoption without a patch change still triggers a rebuild', async t => {
  // The reason the comparison carries TWO values. APT updates its English set
  // between patches; after such an adoption a brand new data/en sits next to a
  // German set derived from the old one, and a trigger that only watches the
  // patch version would never notice.
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const routes = quietRoutes()
  const { r, vendored, genCalls } = await makeLangRefresher(t, {
    routes, overrides: { now: () => (clock += 60_000) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })

  await r.tickApt()
  assert.equal(genCalls.length, 1)
  const firstFingerprint = JSON.parse(
    await readFile(path.join(r.publicDir(), 'data/de/build-info.json'), 'utf8')
  ).enFingerprint

  // Upstream moves — same patch, more item lines.
  const grown = itemsNdjson([...ITEMS_LINES, { name: 'Orb of Testing', refName: 'Orb of Testing', namespace: 'ITEM' }])
  for (const [url, route] of aptRoutes('grown')) routes.set(url, route)
  routes.set(`${UPSTREAM_BASE}/items.ndjson`, { status: 200, body: grown, etag: '"grown"', lastModified: 'Fri, 08 Aug 2026 10:00:00 GMT' })
  await r.tickApt()

  assert.equal(genCalls.length, 2, 'the English snapshot moved on, so German has to follow')
  const info = JSON.parse(await readFile(path.join(r.publicDir(), 'data/de/build-info.json'), 'utf8'))
  assert.equal(info.patch, '3.29.2.1', 'the patch never changed')
  assert.notEqual(info.enFingerprint, firstFingerprint, '...but the skeleton did')
  assert.equal(await readFile(path.join(r.publicDir(), 'data/en/items.ndjson'), 'utf8'), grown)
})

// --- the generator version: a repaired derivation must not wait for a patch --
// The version is a hash over the generator's own files, computed at runtime
// (lang-data-gen.mjs generatorVersion). Injected here so a test can stand for
// a release that changed them.
async function langRefresherWithVersion (t, version) {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const base = await makeLangRefresher(t, {
    routes: quietRoutes(),
    overrides: { now: () => (clock += 60_000), generatorVersion: async () => version.current }
  })
  await mkdir(path.join(base.vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(base.vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await base.r.init()
  base.r.start({ onAptData: async () => {} })
  return base
}

const buildInfoOf = async r => JSON.parse(await readFile(path.join(r.publicDir(), 'data/de/build-info.json'), 'utf8'))

test('lang-data: a set from another generator version is rebuilt, and the run terminates', async t => {
  const version = { current: 'aaaaaaaaaaaaaaaa' }
  const { r, genCalls, logs } = await langRefresherWithVersion(t, version)
  await r.tickApt()
  assert.equal(genCalls.length, 1)
  assert.equal((await buildInfoOf(r)).generator, 'aaaaaaaaaaaaaaaa')

  // A release that changed the generator: same patch, same English snapshot.
  version.current = 'bbbbbbbbbbbbbbbb'
  await r.tickApt()
  assert.equal(genCalls.length, 2, 'the repaired derivation does not wait for the next game patch')
  assert.ok(logs.some(l => l.includes('generator version aaaaaaaaaaaaaaaa -> bbbbbbbbbbbbbbbb')), logs.join('\n'))
  assert.equal((await buildInfoOf(r)).generator, 'bbbbbbbbbbbbbbbb')

  await r.tickApt()
  assert.equal(genCalls.length, 2, 'and once it is rebuilt, it is current')
  assert.equal(langSource(r).lastOutcome, 'unchanged')
})

test('lang-data: a set whose build-info names no generator is rebuilt once', async t => {
  const version = { current: 'aaaaaaaaaaaaaaaa' }
  const { r, genCalls, logs } = await langRefresherWithVersion(t, version)
  await r.tickApt()
  assert.equal(genCalls.length, 1)
  // Every set built before the field existed.
  const p = path.join(r.publicDir(), 'data/de/build-info.json')
  const info = JSON.parse(await readFile(p, 'utf8'))
  delete info.generator
  await writeFile(p, JSON.stringify(info))

  await r.tickApt()
  assert.equal(genCalls.length, 2)
  assert.ok(logs.some(l => /generator version unknown -> aaaaaaaaaaaaaaaa/.test(l)), logs.join('\n'))
  await r.tickApt()
  assert.equal(genCalls.length, 2)
})

test('lang-data: an unknown generator version (a file missing) rebuilds once, then holds', async t => {
  const version = { current: 'aaaaaaaaaaaaaaaa' }
  const { r, genCalls, logs } = await langRefresherWithVersion(t, version)
  await r.tickApt()
  assert.equal(genCalls.length, 1)

  version.current = null
  await r.tickApt()
  assert.equal(genCalls.length, 2, 'unknown is not equal to what the set was built by')
  assert.ok(logs.some(l => l.includes('generator version aaaaaaaaaaaaaaaa -> unknown')), logs.join('\n'))
  assert.equal((await buildInfoOf(r)).generator, null, 'recorded as unknown')

  await r.tickApt()
  assert.equal(genCalls.length, 2, 'unknown matches unknown: no rebuild on every tick')
  assert.ok(logs.some(l => /lang-data check unchanged.*generator version unknown/.test(l)), logs.join('\n'))
})

test('lang-data: the injected generator version is the one recorded and compared', async t => {
  const version = { current: '7777777777777777' }
  const { r, genCalls, logs } = await langRefresherWithVersion(t, version)
  await r.tickApt()
  assert.equal((await buildInfoOf(r)).generator, '7777777777777777')
  await r.tickApt()
  assert.equal(genCalls.length, 1)
  assert.ok(logs.some(l => /lang-data check unchanged.*generator version 7777777777777777/.test(l)), logs.join('\n'))
})

test('lang-data: a new patch alone triggers a rebuild', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  let patch = '3.29.2.1'
  const { r, vendored, genCalls } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    overrides: { now: () => (clock += 60_000), resolvePatch: async () => ({ patch, source: 'test' }) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })

  await r.tickApt()
  await r.tickApt()
  assert.equal(genCalls.length, 1)
  patch = '3.30.0.1'
  await r.tickApt()
  assert.equal(genCalls.length, 2)
  assert.equal(genCalls[1].patch, '3.30.0.1')
  assert.match(
    JSON.parse(await readFile(path.join(r.publicDir(), 'data/de/build-info.json'), 'utf8')).patch,
    /3\.30\.0\.1/
  )
})

test('lang-data: a hotfix-on-a-hotfix version rides through a run unchanged', async t => {
  // The part count of a patch version is not fixed — a five-part one appeared
  // in production on 2026-08-13 (docs/bugs.md, B22). Recognising it is the
  // generator's half; this is the refresher's: it has to reach the generator
  // and come back out of build-info.json byte for byte, or the next tick would
  // compare unequal strings and regenerate forever.
  let clock = Date.parse('2026-08-13T00:00:00Z')
  let patch = '3.29.3.1'
  const { r, vendored, genCalls, logs } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    overrides: { now: () => (clock += 60_000), resolvePatch: async () => ({ patch, source: 'test' }) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })

  await r.tickApt()
  assert.equal(genCalls.length, 1)
  patch = '3.29.3.1.2'
  await r.tickApt()
  assert.equal(genCalls.length, 2, 'the fifth part is a new patch like any other')
  assert.equal(genCalls[1].patch, '3.29.3.1.2', 'handed to the generator verbatim')
  assert.equal(
    JSON.parse(await readFile(path.join(r.publicDir(), 'data/de/build-info.json'), 'utf8')).patch,
    '3.29.3.1.2'
  )
  assert.ok(logs.some(l => /generated from patch 3\.29\.3\.1\.2/.test(l)), 'the outcome line names it in full')
  // And it terminates: the recorded version now equals the resolved one.
  await r.tickApt()
  assert.equal(genCalls.length, 2, 'no rebuild once the recorded version matches')
  assert.equal(langSource(r).lastOutcome, 'unchanged')
})

test('lang-data: the generator is told which set it would replace, and how much loss is allowed', async t => {
  // docs/bugs.md B23. The generator's coverage gate asks "did this run lose
  // what the live set already had", and it cannot ask that of its own output
  // dir: the refresher builds into a FRESH snapshot that holds nothing but the
  // hand written client_strings.js. Without `previous` every regeneration would
  // look like a first build.
  let clock = Date.parse('2026-08-18T00:00:00Z')
  let patch = '3.29.3.1'
  const { r, vendored, genCalls } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    overrides: {
      now: () => (clock += 60_000),
      resolvePatch: async () => ({ patch, source: 'test' }),
      langMaxLossRatio: 0.02
    }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })

  await r.tickApt()
  assert.equal(genCalls.length, 1)
  // First run: the image's tree is what a German set would be replacing, and
  // that is what the generator is pointed at — not its own empty output dir.
  assert.equal(genCalls[0].previous, path.join(vendored.publicDir, 'data/de'))
  assert.notEqual(genCalls[0].previous, genCalls[0].out)
  assert.equal(genCalls[0].maxLossRatio, 0.02, 'the configured bar reaches the generator')

  // Second run: the baseline moved to the snapshot that went live in between.
  const live = r.publicDir()
  patch = '3.29.3.1.2'
  await r.tickApt()
  assert.equal(genCalls.length, 2)
  assert.equal(genCalls[1].previous, path.join(live, 'data/de'))
  assert.notEqual(genCalls[1].previous, genCalls[1].out)
})

test('lang-data: how complete the new set is stands in the line the admin area shows', async t => {
  // A set is allowed to carry refs it has no matcher for — keeping a set that
  // does not carry them AT ALL is worse (B23). "Allowed" must not become
  // "unsaid", so the coverage the run measured is in the outcome line rather
  // than only in the container log.
  let clock = Date.parse('2026-08-18T00:00:00Z')
  const { r, vendored, logs } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    gen: { counts: { statsEn: 9278, covered: 8773, uncovered: 505 } },
    overrides: { now: () => (clock += 60_000) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()

  assert.ok(
    logs.some(l => /8773 of 9278 stats carry a matcher, 505 do not/.test(l)),
    `the coverage figure is not in the outcome line: ${logs.join(' | ')}`
  )
})

test('lang-data: build-info carries what the run measured, so the admin area needs no log', async t => {
  let clock = Date.parse('2026-08-18T00:00:00Z')
  const { r, vendored } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    gen: {
      counts: {
        statsEn: 9278, covered: 8773, uncovered: 505,
        baselineCovered: 8770, regressedRefs: [], newGapRefs: ['a', 'b']
      },
      itemsReport: { total: 4891, translated: 4888, kept: ['x', 'y', 'z'], unknownNamespaces: [{ namespace: 'CHARM', lines: 12 }] }
    },
    overrides: { now: () => (clock += 60_000) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()

  const info = JSON.parse(await readFile(r.buildInfoPath('de'), 'utf8'))
  assert.equal(info.patch, '3.29.2.1')
  assert.ok(info.builtAt, 'when, not just from what')
  assert.deepEqual(info.run, {
    statsEn: 9278,
    statsCovered: 8773,
    statsUncovered: 505,
    baselineCovered: 8770,
    regressed: 0,
    newGaps: 2,
    itemsTotal: 4891,
    itemsTranslated: 4888,
    itemsKeptEnglish: 3,
    unknownNamespaces: [{ namespace: 'CHARM', lines: 12 }]
  })
  // The comparison that decides the next tick still reads the same file, so the
  // extra block may not make a current set look stale.
  const before = r.publicDir()
  await r.tickApt()
  assert.equal(r.publicDir(), before, 'nothing regenerated — the provenance block is not part of the comparison')
})

test('lang-data: a generator that says nothing about its run writes no invented numbers', async t => {
  let clock = Date.parse('2026-08-18T00:00:00Z')
  const { r, vendored } = await makeLangRefresher(t, {
    routes: quietRoutes(), overrides: { now: () => (clock += 60_000) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  const info = JSON.parse(await readFile(r.buildInfoPath('de'), 'utf8'))
  assert.equal(info.run, null, 'no report from the generator means no numbers, not zeroes')
  assert.equal(info.patch, '3.29.2.1', 'the provenance that IS known is still written')
})

test('lang-data: a generator that reports no coverage still produces an outcome line', async t => {
  // The refresher may not depend on the generator's return value: the CLI path,
  // an older image and every test double are all allowed to hand back nothing.
  let clock = Date.parse('2026-08-18T00:00:00Z')
  const { r, vendored, logs } = await makeLangRefresher(t, {
    routes: quietRoutes(), overrides: { now: () => (clock += 60_000) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  assert.equal(langSource(r).lastOutcome, 'updated')
  assert.ok(logs.some(l => /data\/de \(no set yet\) generated from patch/.test(l)))
})

test('lang-data: the generation runs INSIDE the apt job, never beside pruneAptVersions', async t => {
  // The generator reads the active snapshot while it works. pruneAptVersions
  // keeps only the active snapshot and its predecessor, so a concurrent apt
  // tick could delete the tree under it. As a post step of the apt job it
  // inherits busy['apt'] — proven by firing a second tick from inside the
  // generator and watching it bounce off the guard.
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const routes = quietRoutes()
  const calls = []
  const genCalls = []
  const seen = []
  let inner = null
  const { r, vendored } = await makeRefresher(t, {
    routes,
    calls,
    overrides: {
      languages: ['en', 'de'],
      now: () => (clock += 60_000),
      resolvePatch: patchStub('3.29.2.1'),
      generateLangData: fakeGenerator({
        calls: genCalls,
        during: async opts => {
          // The skeleton it was handed must still be readable while it works.
          await stat(path.join(opts.skeleton, 'items.ndjson'))
          const before = calls.length
          inner = await r.tickApt() // must be swallowed by the overlap guard
          seen.push({ fetchesDuringInner: calls.length - before, genRuns: genCalls.length })
          await stat(path.join(opts.skeleton, 'items.ndjson'))
        }
      })
    }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()

  assert.equal(inner, undefined, 'the re-entrant tick returned without running')
  assert.deepEqual(seen, [{ fetchesDuringInner: 0, genRuns: 1 }], 'not one request, not a second generator run')
  assert.equal(genCalls.length, 1)
})

test('lang-data: start() gives it no timer of its own', async t => {
  const scheduled = []
  const { r, vendored } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    overrides: {
      timers: {
        setTimeout: (fn, ms) => { scheduled.push(ms); return { unref () {} } },
        clearTimeout: () => {}
      }
    }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({})
  assert.equal(scheduled.length, 2, 'apt and base-names — the localized set rides along with apt')
  assert.equal(r.status().sources.length, 3, '...but it is still a source of its own in the UI')
  assert.deepEqual(r.status().sources.map(s => s.key), ['apt', 'baseNames', 'langData'])
})

test('lang-data: an English-only install never enters the path at all', async t => {
  const genCalls = []
  const patchCalls = []
  const { r } = await makeRefresher(t, {
    routes: quietRoutes(),
    overrides: {
      languages: ['en'],
      generateLangData: fakeGenerator({ calls: genCalls }),
      resolvePatch: patchStub('3.29.2.1', patchCalls)
    }
  })
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  assert.deepEqual(r.generatedLanguages(), [])
  assert.equal(genCalls.length, 0)
  assert.equal(patchCalls.length, 0, 'not even the patch lookup — no request an English install did not ask for')
  assert.deepEqual(r.status().sources.map(s => s.key), ['apt', 'baseNames'], 'no row that could never succeed')
})

test('lang-data: setLanguages widens the set after init, and the widened one is generated', async t => {
  // The server cannot know the full set when it CREATES the refresher: which
  // languages the active snapshot carries is an answer init() produces, and a
  // language that is in the snapshot is selectable in the browser even when
  // nobody is configured for it any more. Selectable but not refreshed is the
  // state this call exists to prevent — the data set would age silently under
  // whoever picked it.
  const genCalls = []
  const patchCalls = []
  const { r, vendored } = await makeRefresher(t, {
    routes: quietRoutes(),
    overrides: {
      languages: ['en'],
      generateLangData: fakeGenerator({ calls: genCalls }),
      resolvePatch: patchStub('3.29.2.1', patchCalls)
    }
  })
  // The one file the generator never produces — it ships with the image.
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  assert.deepEqual(r.generatedLanguages(), [], 'created for an English-only install')
  assert.deepEqual(r.status().sources.map(s => s.key), ['apt', 'baseNames'])

  assert.deepEqual(r.setLanguages(['en', 'de']), ['de'],
    'English is never generated — it is the one set that comes from upstream')
  assert.deepEqual(r.generatedLanguages(), ['de'])

  r.start({ onAptData: async () => {} })
  await r.tickApt()
  assert.ok(genCalls.length > 0, 'the language that was added really is generated now')
  assert.ok(r.status().sources.some(s => s.key === 'langData'),
    'and it is a source of its own, so an ageing set is visible instead of silent')
})

test('lang-data: an unavailable patch lookup is a failed check, not a quiet one', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const { r, vendored, genCalls, warnings, logs } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    overrides: {
      now: () => (clock += 60_000),
      resolvePatch: async () => { throw new Error('the current patch version could not be looked up') }
    }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()

  assert.equal(genCalls.length, 0, 'no run on a guessed version')
  assert.equal(langSource(r).lastOutcome, 'failed')
  assert.equal(langSource(r).lastSuccessAt, null)
  assert.ok(warnings.some(w => /lang-data check failed/.test(w)))
  assert.equal(logs.filter(l => /lang-data check/.test(l)).length, 0, 'the failure is a warning, not a log line')
})

test('lang-data: the class of the failure comes from the code that failed, unchanged', async t => {
  // The generation path is the deepest of the three, and the one whose failures
  // differ most in what they mean: an endpoint that is away, an answer that is
  // refused, a format this build cannot read. Whatever it was tagged with has to
  // arrive at the status line as itself.
  for (const [kind, message] of [
    [FAIL_KIND.UNREACHABLE, 'the current patch version could not be looked up'],
    [FAIL_KIND.REJECTED, 'ggpk.exposed answered "hello" — no patch version in that path'],
    [FAIL_KIND.INCOMPATIBLE, 'pathofexile-dat refused the schema of this patch']
  ]) {
    let clock = Date.parse('2026-08-08T00:00:00Z')
    const { r, vendored } = await makeLangRefresher(t, {
      routes: quietRoutes(),
      overrides: {
        now: () => (clock += 60_000),
        resolvePatch: async () => { throw failure(message, kind) }
      }
    })
    await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
    await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
    await r.init()
    r.start({ onAptData: async () => {} })
    await r.tickApt()
    const s = langSource(r)
    assert.equal(s.lastOutcome, 'failed')
    assert.equal(s.lastFailKind, kind, `${kind} must not turn into something else on the way`)
    assert.ok(s.lastReason.includes(message.slice(0, 30)))
  }
})

test('lang-data: a carried set keeps its build-info, so a carry alone never triggers a rebuild', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const routes = quietRoutes()
  const { r, vendored, genCalls } = await makeLangRefresher(t, {
    routes, overrides: { now: () => (clock += 60_000) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  assert.equal(genCalls.length, 1)

  // An English adoption that changes NOTHING about the skeleton (same ndjson,
  // new client_strings) still writes a new snapshot dir and carries the German
  // tree into it. Its build-info has to ride along, or the next tick would
  // rebuild a set that is perfectly current.
  for (const [url, route] of aptRoutes('cs-only')) routes.set(url, route)
  await r.tickApt()
  assert.equal(genCalls.length, 1, 'the skeleton is unchanged — nothing to rebuild')
  const info = JSON.parse(await readFile(path.join(r.publicDir(), 'data/de/build-info.json'), 'utf8'))
  assert.equal(info.patch, '3.29.2.1')
  assert.match(await readFile(path.join(r.publicDir(), 'data/en/client_strings.js'), 'utf8'), /MARKER: 'cs-only'/)
})

test('lang-data: an adoption and a regeneration in the same millisecond do not collide', async t => {
  // Patch day: upstream ships a new English set AND the localized one has to be
  // rebuilt, both inside one tick. Version dirs are named after the clock, so
  // with a frozen one the second write would rename onto the first.
  const frozen = Date.parse('2026-08-08T00:00:00Z')
  const routes = aptRoutes('same-ms')
  const { r, vendored, genCalls, warnings } = await makeLangRefresher(t, {
    routes, overrides: { now: () => frozen }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  const applied = []
  r.start({ onAptData: async info => { applied.push(info) } })
  await r.tickApt()

  assert.equal(warnings.length, 0)
  assert.equal(genCalls.length, 1)
  assert.equal(applied.length, 2, 'the English adoption and the regenerated snapshot')
  assert.deepEqual(applied[1].languages, ['en', 'de'])
  assert.equal(langSource(r).lastOutcome, 'updated')
  assert.equal(await readFile(path.join(r.publicDir(), 'data/de/items.ndjson'), 'utf8'), DE_BODY['items.ndjson'])
  assert.match(await readFile(path.join(r.publicDir(), 'data/en/client_strings.js'), 'utf8'), /MARKER: 'same-ms'/)
})

// ---------------------------------------------------------------------------
// A PINNED PATCH VERSION. POE_PATCH_VERSION became settable from the admin form
// and brought two silent failure modes with it, both of which look GREEN:
// a pin that is valid but names no real patch, and a pin that was right until
// the next patch shipped. Neither produces an outcome — the check succeeds —
// so neither had anywhere to be reported. See docs/bugs.md B25.
// ---------------------------------------------------------------------------

/** A patch lookup that behaves like a pin, with a second opinion behind it. */
const pinnedPatch = (pin, lookedUp) => async () => ({
  patch: pin,
  source: 'POE_PATCH_VERSION',
  pinned: pin,
  lookedUp,
  mismatch: lookedUp && lookedUp !== pin
    ? `POE_PATCH_VERSION pins the patch to ${pin}; the lookup reports ${lookedUp}. ` +
      `The localized set is built from ${pin} until the pin is changed or cleared.`
    : null
})

test('lang-data: a pin the lookup disagrees with is reported on a check that SUCCEEDS', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const { r, vendored, warnings } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    overrides: { now: () => (clock += 60_000), resolvePatch: pinnedPatch('3.29.2.1', '3.30.0.1') }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })

  // First tick builds the set, second finds nothing to do — and it is the
  // SECOND one that matters: `unchanged` is what a frozen pin produces every
  // day for the rest of the league.
  await r.tickApt()
  await r.tickApt()

  const s = langSource(r)
  assert.equal(s.lastOutcome, 'unchanged', 'the check itself is fine — that is the whole problem')
  assert.equal(s.lastReason, null, 'nothing failed, so there is no reason')
  assert.match(s.lastWarning, /3\.29\.2\.1/)
  assert.match(s.lastWarning, /3\.30\.0\.1/)
  assert.ok(warnings.some(w => /3\.30\.0\.1/.test(w)), 'and it is in the container log as well')
})

test('lang-data: a pin the lookup agrees with warns about nothing', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const { r, vendored } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    overrides: { now: () => (clock += 60_000), resolvePatch: pinnedPatch('3.29.2.1', '3.29.2.1') }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  assert.equal(langSource(r).lastWarning, null)
})

test('lang-data: the warning is cleared the moment the disagreement is', async t => {
  // Following the advice has to have a visible effect. A warning that outlives
  // its own remedy is the defect this whole pass is about.
  let clock = Date.parse('2026-08-08T00:00:00Z')
  let lookedUp = '3.30.0.1'
  const { r, vendored } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    overrides: {
      now: () => (clock += 60_000),
      resolvePatch: async () => (await pinnedPatch('3.29.2.1', lookedUp)())
    }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  assert.ok(langSource(r).lastWarning)
  lookedUp = '3.29.2.1' // the pin was corrected (or the lookup came back to it)
  await r.tickApt()
  assert.equal(langSource(r).lastWarning, null)
})

test('lang-data: the pin travels to the generator, so the export can name it', async t => {
  // classifyExportFailure() needs it: a CDN that refuses every file means
  // "wait" for a looked-up version and "look at your pin" for a typed one.
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const { r, vendored, genCalls } = await makeLangRefresher(t, {
    routes: quietRoutes(),
    overrides: { now: () => (clock += 60_000), resolvePatch: pinnedPatch('3.29.9.9', null) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  assert.equal(genCalls[0].patchSource, 'POE_PATCH_VERSION')
})

// ---------------------------------------------------------------------------
// What comes back OUT of state.json. The promise "filtered and bounded before
// it reaches a browser" was kept on the write path only, and a state file
// outlives the build that wrote it.
// ---------------------------------------------------------------------------

test('a persisted reason is filtered and capped again when it is read back', async t => {
  const { r, root } = await makeRefresher(t, { overrides: { reasonMaxChars: 60 } })
  const stateFile = path.join(root, 'config/data-refresh/state.json')
  await mkdir(path.dirname(stateFile), { recursive: true })
  // What a build without the filter, or with a larger cap, could have left here.
  await writeFile(stateFile, JSON.stringify({
    since: 1,
    checks: {
      apt: {
        lastCheckAt: 2,
        lastOutcome: 'failed',
        lastSuccessAt: null,
        lastReason: 'fetch failed: token=abcdef123456 ' + 'x'.repeat(400),
        lastFailKind: 'the-network-probably'
      }
    }
  }))
  await r.init()
  const s = r.status().sources.find(x => x.key === 'apt')
  assert.ok(!s.lastReason.includes('abcdef123456'), 'an unfiltered secret must not survive a restart')
  assert.ok(s.lastReason.length <= 60, `capped on the way out, got ${s.lastReason.length}`)
  assert.equal(s.lastFailKind, null, 'a class this build does not know is not passed to the page')
})

// ---------------------------------------------------------------------------
// The client_strings drift report and its own remedy.
// ---------------------------------------------------------------------------

test('client_strings drift is recomputed at boot, so a container update clears it', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const { r, root, vendored } = await makeLangRefresher(t, {
    routes: quietRoutes(), overrides: { now: () => (clock += 60_000) }
  })
  await mkdir(path.join(vendored.publicDir, 'data/de'), { recursive: true })
  await writeFile(path.join(vendored.publicDir, 'data/de/client_strings.js'), clientStrings('hand-written-de'))
  // A report an earlier build left behind, about a key that is no longer
  // missing. The advice it carries is "update the container" — and until this
  // recomputation existed, doing so changed nothing about what was displayed.
  const stateFile = path.join(root, 'config/data-refresh/state.json')
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify({
    since: 1,
    clientStrings: { at: 1, langs: { de: { enKeys: 9, langKeys: 1, missing: ['GONE'], missingCount: 8, extra: [], extraCount: 0 } } }
  }))
  await r.init()
  const d = r.clientStringDrift()
  assert.notEqual(d?.langs?.de?.missingCount, 8, 'the stale count must not survive the boot that can disprove it')
  assert.ok(!(d?.langs?.de?.missing || []).includes('GONE'))
})

test('a drift entry for a language nobody is served in is not reported', async t => {
  const { r, root } = await makeRefresher(t) // English-only install
  const stateFile = path.join(root, 'config/data-refresh/state.json')
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify({
    since: 1,
    clientStrings: { at: 1, langs: { de: { enKeys: 9, langKeys: 1, missing: ['X'], missingCount: 8, extra: [], extraCount: 0 } } }
  }))
  await r.init()
  assert.equal(r.clientStringDrift(), null, 'a finding about a language nobody uses is a finding about nothing')
})

// ---------------------------------------------------------------------------
// The manual trigger. Every remedy this tool offers takes effect at the NEXT
// scheduled check, and there is one a day — so a correct repair and a repair
// that did nothing look identical for up to 24 hours. checkNow() is the way
// out of that, and it is guarded because the person most likely to press it
// repeatedly is the one in the middle of the repair.
// ---------------------------------------------------------------------------

test('checkNow runs every check and reports that it did', async t => {
  const calls = []
  const { r } = await makeRefresher(t, { routes: aptRoutes('now'), calls })
  await r.init()
  r.start({ onAptData: async () => {} })
  calls.length = 0
  const got = await r.checkNow()
  assert.equal(got.ok, true)
  assert.equal(got.ran, true)
  assert.ok(calls.length > 0, 'it really checked rather than reporting that it had')
  // The answer carries the fresh status, so the page can redraw the result of
  // the click instead of waiting for the push that reports it.
  assert.ok(Array.isArray(got.status.sources))
  assert.ok(got.status.sources.some(s => s.lastCheckAt))
})

test('checkNow refuses inside its cooldown, and says how long is left', async t => {
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const { r, calls } = await makeRefresher(t, {
    routes: aptRoutes('cool'),
    overrides: { now: () => clock, checkNowCooldownMs: 300_000 }
  })
  await r.init()
  r.start({ onAptData: async () => {} })
  assert.equal((await r.checkNow()).ran, true)
  calls.length = 0

  clock += 60_000
  const second = await r.checkNow()
  assert.equal(second.ran, false)
  assert.equal(second.retryAfterMs, 240_000, 'the wait is the real one, not a guess the page makes up')
  assert.equal(calls.length, 0, 'and nothing was sent — a refusal that still fetched would guard nothing')

  clock += 240_000
  assert.equal((await r.checkNow()).ran, true, 'once the cooldown is out it works again')
})

test('the cooldown starts when the run FINISHES, not when it started', async t => {
  // A run can take minutes (a game-data export downloads tens of megabytes). If
  // the clock started at the beginning, a long run would leave almost no
  // cooldown behind it — exactly the wrong way round.
  let clock = Date.parse('2026-08-08T00:00:00Z')
  const routes = aptRoutes('slow')
  const { r } = await makeRefresher(t, {
    routes,
    overrides: {
      now: () => clock,
      checkNowCooldownMs: 300_000,
      // Every fetch advances the clock: the run itself takes time.
      fetchImpl: async (url, opts) => {
        clock += 60_000
        const route = routes.get(url)
        const spec = typeof route === 'function' ? route(opts) : route
        return {
          ok: (spec.status ?? 200) < 300,
          status: spec.status ?? 200,
          headers: { get: () => null },
          text: async () => spec.body ?? ''
        }
      }
    }
  })
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.checkNow()
  const second = await r.checkNow()
  assert.equal(second.ran, false)
  assert.equal(second.retryAfterMs, 300_000,
    'the full cooldown is left, measured from the end of the run')
})

test('checkNow does not start a second check on top of a running one', async t => {
  // The overlap guard the schedule has always had, answered as its own state
  // rather than as a refusal: the check the caller wanted IS happening.
  let release
  const gate = new Promise(r => { release = r })
  const { r } = await makeRefresher(t, {
    routes: aptRoutes('busy'),
    overrides: { checkNowCooldownMs: 0 }
  })
  await r.init()
  r.start({ onAptData: async () => { await gate } })
  const first = r.checkNow()
  await new Promise(res => setTimeout(res, 20))
  const second = await r.checkNow()
  assert.equal(second.ran, false)
  assert.equal(second.running, true, 'not a cooldown — a check that is already under way')
  assert.equal(second.retryAfterMs, undefined)
  release()
  await first
})

test('checkNow on an install with no writable /config does nothing and says so', async t => {
  // Without a writable dir the refresher never schedules anything either (a
  // local run with no /config volume keeps the baked-in data instead of failing
  // every tick). A button that started a run here would be the one path that
  // ignores that.
  const root = await mkdtemp(path.join(tmpdir(), 'data-refresher-nowrite-'))
  const notADir = path.join(root, 'occupied')
  await writeFile(notADir, 'a file where the refresher wants a directory')
  const { r } = await makeRefresher(t, { overrides: { dir: notADir } })
  await r.init()
  assert.equal(r.writable(), false)
  const got = await r.checkNow()
  assert.equal(got.ran, false)
  assert.equal(got.reason, 'disabled')
  await rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A state.json the refresher cannot use (docs/bugs.md B31). Missing is the
// normal first start. Broken is moved aside with one warning, like the stores
// in store-file.mjs; one that cannot be read or moved is never written over,
// and the auto-update stays off until somebody fixes or removes it.
// ---------------------------------------------------------------------------

const STATE_NOW = Date.parse('2026-11-03T10:15:00Z')
const STATE_STAMP = '2026-11-03T10-15-00-000Z'

test('a missing state.json starts without a warning and is written', async t => {
  const { r, root, warnings } = await makeRefresher(t, { overrides: { now: () => STATE_NOW } })
  await r.init()
  assert.equal(r.writable(), true)
  assert.deepEqual(warnings, [])
  const state = JSON.parse(await readFile(path.join(root, 'config/data-refresh/state.json'), 'utf8'))
  assert.equal(state.since, STATE_NOW)
  await rm(root, { recursive: true, force: true })
})

test('a broken state.json is moved aside with one warning, and the refresher starts empty', async t => {
  for (const body of ['{"since": 1, "apt": {"version": "v-x"', '[1,2]', 'null', '"text"']) {
    const { r, root, warnings } = await makeRefresher(t, { overrides: { now: () => STATE_NOW } })
    const dir = path.join(root, 'config/data-refresh')
    const stateFile = path.join(dir, 'state.json')
    await mkdir(dir, { recursive: true })
    await writeFile(stateFile, body)
    await r.init()
    const aside = `${stateFile}.broken-${STATE_STAMP}`
    assert.equal(await readFile(aside, 'utf8'), body, `${body}: the content is kept to look at`)
    const mine = warnings.filter(w => w.includes('state.json'))
    assert.equal(mine.length, 1, `${body}: ${warnings.join(' | ')}`)
    assert.match(mine[0], /^\[data-refresh\] .*not usable \(.*\) — moved to /)
    assert.ok(mine[0].includes(aside), mine[0])
    assert.ok(!mine[0].includes('v-x'), 'the content is never quoted')
    assert.equal(r.writable(), true, body)
    assert.equal(r.publicDataUrl(), undefined, 'the baked-in data is active')
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(state.since, STATE_NOW, `${body}: a fresh state is written`)
    await rm(root, { recursive: true, force: true })
  }
})

test('a state.json that cannot be read is not written over, and the auto-update stays off', async t => {
  const body = JSON.stringify({ since: 1, checks: {} })
  const readStateImpl = async () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e }
  const calls = []
  const { r, root, warnings } = await makeRefresher(t, { calls, overrides: { now: () => STATE_NOW, readStateImpl } })
  const stateFile = path.join(root, 'config/data-refresh/state.json')
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, body)
  await r.init()
  const mine = warnings.filter(w => w.includes('state.json'))
  assert.equal(mine.length, 1, warnings.join(' | '))
  assert.match(mine[0], /could not read .*EACCES.*not writing over it/)
  assert.equal(r.writable(), false)
  assert.equal(r.status().enabled, false)
  r.start({ onAptData: async () => {} })
  const got = await r.checkNow()
  assert.equal(got.reason, 'disabled')
  assert.equal(calls.length, 0, 'no check runs')
  assert.equal(await readFile(stateFile, 'utf8'), body)
  r.stop()
  await rm(root, { recursive: true, force: true })
})

test('a broken state.json that cannot be moved is left alone, and the auto-update stays off', async t => {
  const renameImpl = async () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e }
  const { r, root, warnings } = await makeRefresher(t, { overrides: { now: () => STATE_NOW, stateRenameImpl: renameImpl } })
  const stateFile = path.join(root, 'config/data-refresh/state.json')
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, 'not json')
  await r.init()
  const mine = warnings.filter(w => w.includes('state.json'))
  assert.equal(mine.length, 1, warnings.join(' | '))
  assert.match(mine[0], /could not be moved aside \(EBUSY\)/)
  assert.equal(r.writable(), false)
  assert.equal(await readFile(stateFile, 'utf8'), 'not json')
  assert.deepEqual((await readdir(path.dirname(stateFile))).filter(f => f.startsWith('state.json')), ['state.json'])
  await rm(root, { recursive: true, force: true })
})

test('every refresher download names the tool, its version and its purpose', async t => {
  const calls = []
  const { r } = await makeRefresher(t, { routes: aptRoutes('ua'), calls })
  await r.init()
  r.start({ onAptData: async () => {} })
  await r.tickApt()
  assert.equal(calls.length, FILES.length)
  for (const c of calls) assert.equal(c.headers['User-Agent'], `${AGENT_BASE} (data refresher, personal LAN tool)`)
})
