// Source attribution of the reference rail. Two feeds on two clocks (poe.ninja
// reference fetch >=15 min, Faustus store hourly) are mixed INSIDE a section,
// so every row has to say where its own number comes from (`src`) and the rail
// footer has to carry one timestamp PER SOURCE instead of one shared stamp.
// Part 1 checks the server message, part 2 the rendering in frontend/app.js.
// poe.ninja and the Faustus CDN are fetch-stubbed (no network).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { quietEnv } from './test-quiet-env.mjs'
import { configureNinja } from './ninja.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = await mkdtemp(join(tmpdir(), 'refrailsrc-'))

// The full set that keeps a booted server off the network. One list, imported:
// every file that wrote it out by hand left something out, and what kept being
// left out was the switch a WebSocket needs (test-quiet-env.mjs, docs/bugs.md
// B25). Applied FIRST — anything this file sets below overrides it on purpose.
quietEnv()
process.env.PORT = '0'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_NETWORTH_AUTOSYNC = '0'
process.env.POE_LEAGUE = 'BootLeague'
delete process.env.POE_FAUSTUS_DISABLED
process.env.POE_FAUSTUS_STORE = join(dir, 'faustus-store.json')
process.env.POE_REFERENCE_HISTORY = join(dir, 'reference-history.ndjson')

const RATIO = 200
const EXCHANGE = {
  core: { primary: 'chaos' },
  lines: [
    { id: 'divine', primaryValue: RATIO, sparkline: { data: [1, 2] } },
    { id: 'mirror', primaryValue: 100_000, sparkline: { data: [1, 2] } }
  ]
}
const BEASTS = {
  lines: [{ name: 'Vivid Vulture', chaosValue: 1800, divineValue: 9, count: 40, sparkLine: { data: [1, 2] } }]
}

const realFetch = globalThis.fetch
let cdnDown = false // the Faustus CDN unreachable (onFailed case)
globalThis.fetch = async (url) => {
  const u = String(url)
  // One league whose poe.ninja requests fail on the network (the C:D outage case).
  if (u.includes('poe.ninja') && u.includes('league=CdDown')) throw new Error('connect ECONNREFUSED')
  if (u.includes('web.poecdn.com') && cdnDown) throw new Error('getaddrinfo ENOTFOUND web.poecdn.com')
  if (u.includes('web.poecdn.com')) return { ok: true, status: 200, json: async () => ({ markets: [] }) }
  const body = u.includes('exchange/current/overview')
    ? EXCHANGE
    : (u.includes('item/overview') ? BEASTS : { lines: [] })
  return { ok: true, status: 200, json: async () => body }
}

const fat = { volX: 10_000_000, volQuote: 300_000 }
const fatDiv = { volX: 10_000_000, volQuote: 5_000 }
const SELL = {
  'Vivid Crystallised Lifeforce': { chaos: { perItem: 0.03841, ...fat }, divine: { perItem: 0.03616 / RATIO, ...fatDiv } },
  'Wild Crystallised Lifeforce': { chaos: { perItem: 0.04259, ...fat }, divine: { perItem: 0.01949 / RATIO, ...fatDiv } },
  'Primal Crystallised Lifeforce': { chaos: { perItem: 0.02943, ...fat }, divine: { perItem: 0.02711 / RATIO, ...fatDiv } },
  "Dead Man's Sulphur": { chaos: { perItem: 1.5, ...fat }, divine: { perItem: 1.4 / RATIO, ...fatDiv } },
  'Mirror of Kalandra': { divine: { perItem: 500, ...fatDiv } }
}

let mod
before(async () => {
  mod = await import('./server.mjs')
  const t0 = Date.now()
  while (mod.faustusStore.updatedAt() == null && Date.now() - t0 < 3000) {
    await new Promise(r => setTimeout(r, 25))
  }
  await mod.faustusStore.setPrices('SrcFresh', {}, Date.now(), null, SELL)
})
after(async () => {
  globalThis.fetch = realFetch
  await new Promise(r => mod.server.close(r))
  await rm(dir, { recursive: true, force: true })
})

// ---- Part 1: the server names a source per row ------------------------------

test('mixed section: Mirror is poe.ninja, Sulphur right below it is Faustus', async () => {
  const msg = await mod.refreshReference('SrcFresh')
  const rows = Object.fromEntries([...msg.currency, ...msg.lifeforce, ...msg.beasts].map(r => [r.name, r]))

  // Same section, two sources — the case a single footer stamp got wrong.
  assert.equal(rows['Mirror of Kalandra'].src, 'ninja')
  assert.equal(rows["Dead Man's Sulphur"].src, 'faustus')
  // Mirror's `sell` object is Faustus-derived, but the NUMBER is poe.ninja's:
  // `src` describes the number only — `sell` is separate provenance with its
  // own timestamp (`sell.updatedAt`).
  assert.equal(rows['Mirror of Kalandra'].sell.only, 'divine')

  for (const n of ['Vivid Lifeforce', 'Wild Lifeforce', 'Primal Lifeforce']) {
    assert.equal(rows[n].src, 'faustus', `${n} is priced from Faustus`)
  }
  assert.equal(rows['Vivid Vulture'].src, 'ninja')

  // Both stamps are present and independent: refreshedAt for poe.ninja, the
  // store's own updatedAt on the Faustus rows.
  assert.equal(typeof msg.refreshedAt, 'number')
  assert.equal(typeof rows['Vivid Lifeforce'].sell.updatedAt, 'number')
})

test('refreshedAt is the time of the poe.ninja answer, not of the rebuild (B29)', async () => {
  // A fresh league: the answer is fetched now, so the stamp lies in this window.
  const before = Date.now()
  const fresh = await mod.refreshReference('SrcStamp')
  assert.ok(fresh.refreshedAt >= before && fresh.refreshedAt <= Date.now())
  // An answer poe.ninja gave two hours ago (ninja.mjs is the same module
  // instance the server uses, so its clock can be set back for one fetch).
  // The rail used to stamp it with the time of the rebuild.
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  configureNinja({ now: () => twoHoursAgo })
  try {
    const old = await mod.refreshReference('SrcOldAnswer')
    assert.equal(old.refreshedAt, twoHoursAgo)
  } finally {
    configureNinja({ now: () => Date.now() })
  }
})

test('an old poe.ninja answer adds no Mirror or beast point, but the fresh Faustus rows still get theirs (B29)', async () => {
  const LGX = 'SrcNinjaDown'
  const hist = mod.referenceHistory
  await mod.faustusStore.setPrices(LGX, {}, Date.now(), null, SELL)
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  // The history already holds a point built from the poe.ninja answers of two
  // hours ago, an hour old itself (past the history's 10 min spacing).
  hist.points.push({
    lg: LGX,
    at: Date.now() - 60 * 60 * 1000,
    cd: RATIO,
    v: { 'c:mirror': 100_000, 'b:Vivid Vulture': 1800 },
    ob: { exchange: twoHoursAgo, beasts: twoHoursAgo }
  })
  // poe.ninja serves those same answers again (its clock set back for this
  // league's fetches, as in the refreshedAt case above).
  configureNinja({ now: () => twoHoursAgo })
  try {
    await mod.refreshReference(LGX)
  } finally {
    configureNinja({ now: () => Date.now() })
  }
  const pts = hist.points.filter(p => p.lg === LGX)
  assert.equal(pts.length, 2, 'a new point despite the old poe.ninja answer')
  const v = pts[1].v
  assert.equal('c:mirror' in v, false, 'the old exchange answer is not a new Mirror point')
  assert.equal('b:Vivid Vulture' in v, false, 'the old beast answer is not a new beast point')
  for (const k of ['s:Vivid Crystallised Lifeforce', "s:Dead Man's Sulphur"]) {
    assert.equal(typeof v[k], 'number', `${k} (Faustus) still gets its point`)
  }
  assert.deepEqual(Object.keys(pts[1].ob || {}), ['faustus'], 'no poe.ninja feed is stamped, only the Faustus one')
})

test('the same Faustus store adds no Sulphur or lifeforce point; a newer store does (B29)', async () => {
  // The rail rebuilds every 15 min, the Faustus store only on its hourly tick,
  // and during a Faustus outage not at all. The same store written again as a
  // new point is a flat line that looks like a quiet market.
  const hist = mod.referenceHistory
  const storeAt = Date.now() - 30 * 60 * 1000
  const FAUSTUS_KEYS = ['s:Vivid Crystallised Lifeforce', "s:Dead Man's Sulphur"]
  const seed = (lg, faustusAt) => hist.points.push({
    lg,
    at: Date.now() - 60 * 60 * 1000,
    cd: RATIO,
    v: { 's:Vivid Crystallised Lifeforce': 26, "s:Dead Man's Sulphur": 1.5 },
    ob: { faustus: faustusAt }
  })

  const SAME = 'SrcFaustusSame'
  seed(SAME, storeAt)
  await mod.faustusStore.setPrices(SAME, {}, storeAt, null, SELL)
  await mod.refreshReference(SAME)
  const same = hist.points.filter(p => p.lg === SAME)
  assert.equal(same.length, 2, 'the poe.ninja rows still get a point')
  for (const k of FAUSTUS_KEYS) assert.equal(k in same[1].v, false, `${k}: the same store is not a new point`)
  assert.equal(typeof same[1].v['c:mirror'], 'number')
  assert.equal('faustus' in (same[1].ob || {}), false)

  const NEWER = 'SrcFaustusNewer'
  seed(NEWER, storeAt - 60 * 60 * 1000)
  await mod.faustusStore.setPrices(NEWER, {}, storeAt, null, SELL)
  await mod.refreshReference(NEWER)
  const newer = hist.points.filter(p => p.lg === NEWER)
  assert.equal(newer.length, 2)
  for (const k of FAUSTUS_KEYS) assert.equal(typeof newer[1].v[k], 'number', `${k}: a newer store is a new point`)
  assert.equal(newer[1].ob.faustus, storeAt, 'the point carries the time of the store, not of the rebuild')
})

test('a row without a number claims no source', async () => {
  // Store far beyond the TTL -> the sell-side rows print "—".
  await mod.faustusStore.setPrices('SrcStale', {}, Date.now() - 3 * 24 * 60 * 60 * 1000, null, SELL)
  const msg = await mod.refreshReference('SrcStale')
  const rows = Object.fromEntries([...msg.currency, ...msg.lifeforce].map(r => [r.name, r]))

  for (const n of ['Vivid Lifeforce', "Dead Man's Sulphur"]) {
    assert.equal(rows[n].display, '—')
    assert.equal('src' in rows[n], false, `${n} must not name a source`)
  }
  // The poe.ninja rows are unaffected.
  assert.equal(rows['Mirror of Kalandra'].src, 'ninja')
})

// ---- The C:D tile and the source status, against the same booted server ---

test('C:D from an old poe.ninja answer carries THAT answer\'s time, plus now and staleAfterMs (B29)', async () => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
  configureNinja({ now: () => twoHoursAgo })
  let cd
  try {
    cd = await mod.refreshCdRatio('CdOld')
  } finally {
    configureNinja({ now: () => Date.now() })
  }
  assert.equal(cd.chaosPerDivine, RATIO)
  assert.equal(cd.trendHint, 'live · poe.ninja')
  // The old answer is not re-stamped with the time of the rebuild.
  assert.equal(cd.asOf, twoHoursAgo)
  assert.equal(typeof cd.now, 'number')
  assert.ok(cd.now >= twoHoursAgo + 2 * 60 * 60 * 1000 - 5000, 'now is the server clock, not the answer time')
  assert.ok(cd.staleAfterMs >= 3 * 60 * 60 * 1000)
  // The cached message (what a WS connect sends) carries the same.
  const again = mod.cdMsgFor('CdOld')
  assert.equal(again.asOf, twoHoursAgo)
  assert.equal(typeof again.staleAfterMs, 'number')
})

test('a network error on the C:D fetch marks ninja-cd failing in source-status; the tile stays on its fallback', async () => {
  await new Promise(r => setTimeout(r, 5)) // the failure must be younger than the earlier successes
  const cd = await mod.refreshCdRatio('CdDown')
  assert.equal(cd.trendHint, 'fallback')
  assert.equal('asOf' in cd, false)
  const row = mod.sourceStatusMsg().sources.find(s => s.source === 'ninja-cd')
  assert.equal(typeof row.lastFailureAt, 'number')
  assert.ok(row.lastSuccessAt == null || row.lastFailureAt > row.lastSuccessAt, 'the failure is the latest event')
  assert.match(row.reason, /network error: connect ECONNREFUSED/)
  assert.equal(row.failKind, 'unreachable')
})

test('a Faustus refresh reaches source-status: the boot tick through onRefreshed, a failed one through onFailed', async () => {
  // The boot tick ran against the CDN stub above and wrote the store.
  const ok = mod.sourceStatusMsg().sources.find(s => s.source === 'faustus')
  assert.equal(ok.enabled, true)
  assert.equal(typeof ok.lastSuccessAt, 'number')
  assert.equal(ok.lastFailureAt, null)
  // The CDN goes away: the next tick fails, keeps the store and says why.
  const storeAt = mod.faustusStore.updatedAt()
  cdnDown = true
  try {
    await new Promise(r => setTimeout(r, 5))
    await mod.faustusRefresher.tickOnce()
  } finally {
    cdnDown = false
  }
  const row = mod.sourceStatusMsg().sources.find(s => s.source === 'faustus')
  assert.equal(typeof row.lastFailureAt, 'number')
  assert.ok(row.lastFailureAt > row.lastSuccessAt, 'the failure is the latest event')
  assert.ok(row.reason, 'a reason is named')
  assert.equal(mod.faustusStore.updatedAt(), storeAt, 'the last good store stays')
})

// ---- Part 2: the rail renders one stamp per source --------------------------
// app.js is a classic browser script (touches the DOM at load), so the pure
// source/footer helpers are lifted out of the file and evaluated on their own.
// That keeps the test on the SHIPPED code instead of a copy.

const railRender = await (async () => {
  const src = await readFile(join(here, 'frontend/app.js'), 'utf8')
  const from = src.indexOf('const SRC_LABEL')
  const to = src.indexOf('function applyReference')
  assert.ok(from > 0 && to > from, 'source-attribution block found in app.js')
  const body = src.slice(from, to)
  // The attribution texts go through the string table since the German UI
  // (frontend/i18n.js), so the real table is loaded here rather than stubbed —
  // with the default language that IS the English wording asserted below.
  const i18nCtx = vm.createContext({ window: {} })
  vm.runInContext(await readFile(join(here, 'frontend/i18n.js'), 'utf8'), i18nCtx, { filename: 'i18n.js' })
  const factory = new Function('I18n', `
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const sparkSvg = () => ''
    const T = (k, p) => I18n.t(k, p)
    // A row's name goes through the localized-name table (I18n.itemName) the
    // same way its attribution texts go through t(). Same one-liner as app.js;
    // with no table loaded it is the identity, which is the English wording
    // asserted below.
    const INAME = (ref, fallback) => I18n.itemName(ref) || fallback || ref
    ${body}
    return { refSources, refSection, refFooter }
  `)
  return factory(i18nCtx.window.I18n)
})()

const stamp = (h, m) => new Date(2026, 6, 31, h, m, 0, 0).getTime()

const MSG = {
  refreshedAt: stamp(14, 5),
  currency: [
    { name: 'Mirror of Kalandra', display: '500 div', sparkline: [], invert: false, src: 'ninja' },
    { name: "Dead Man's Sulphur", display: '133 / div', sparkline: [], invert: true, src: 'faustus', sell: { updatedAt: stamp(15, 40) } }
  ],
  lifeforce: [
    { name: 'Vivid Lifeforce', display: '26 / c', sparkline: [], invert: true, src: 'faustus', sell: { updatedAt: stamp(15, 40) } }
  ],
  beasts: [
    { name: 'Vivid Vulture', display: '9 div', sparkline: [], invert: false, src: 'ninja' }
  ]
}

test('footer carries two stamps, one per source, never a shared one', () => {
  const sources = railRender.refSources(MSG)
  const foot = railRender.refFooter(sources)

  assert.match(foot, /poe\.ninja<\/span> · updated 14:05/)
  assert.match(foot, /Faustus<\/span> · updated 15:40/)
  // Two lines, each its own key — not one line for both feeds.
  assert.equal((foot.match(/class="rsrc"/g) || []).length, 2)
  assert.match(foot, /class="src-ninja"/)
  assert.match(foot, /class="src-faustus"/)
  // poe.ninja's stamp is never printed on the Faustus line and vice versa.
  const [ninjaLine, faustusLine] = foot.split('<div class="rsrc">').slice(1)
  assert.equal(ninjaLine.includes('15:40'), false)
  assert.equal(faustusLine.includes('14:05'), false)
})

test('mixed section: each row wears its own marker and says so in the tooltip', () => {
  const sources = railRender.refSources(MSG)
  const html = railRender.refSection('Currency', MSG.currency, sources)

  assert.match(html, /class="p src-ninja" title="Value from poe\.ninja · updated 14:05"/)
  assert.match(html, /class="p src-faustus" title="Value from Faustus · updated 15:40"/)
  assert.equal((html.match(/src-ninja/g) || []).length, 1)
  assert.equal((html.match(/src-faustus/g) || []).length, 1)
})

test('a row without src gets no marker and no invented stamp', () => {
  const msg = {
    refreshedAt: stamp(14, 5),
    currency: [{ name: 'Mirror of Kalandra', display: '500 div', sparkline: [], invert: false, src: 'ninja' }],
    lifeforce: [{ name: 'Vivid Lifeforce', display: '—', sparkline: [], invert: true }],
    beasts: []
  }
  const sources = railRender.refSources(msg)
  const lifeforce = railRender.refSection('Lifeforce — Selling', msg.lifeforce, sources)

  assert.equal(lifeforce.includes('src-'), false, 'no marker on a row without a number')
  assert.equal(lifeforce.includes('Value from'), false)
  assert.match(lifeforce, /class="p" title="No value, so no source/)

  // No Faustus row left -> the footer must not mention Faustus at all.
  const foot = railRender.refFooter(sources)
  assert.equal(foot.includes('Faustus'), false)
  assert.match(foot, /poe\.ninja<\/span> · updated 14:05/)
  assert.equal((foot.match(/class="rsrc"/g) || []).length, 1)
})

test('a Faustus row without a store stamp keeps its marker explained', () => {
  const msg = {
    refreshedAt: stamp(14, 5),
    currency: [],
    lifeforce: [{ name: 'Vivid Lifeforce', display: '26 / c', sparkline: [], invert: true, src: 'faustus', sell: {} }],
    beasts: []
  }
  const sources = railRender.refSources(msg)
  const foot = railRender.refFooter(sources)
  // The source is named, the time is admitted to be unknown — not borrowed
  // from poe.ninja's stamp.
  assert.match(foot, /Faustus<\/span> · time unknown/)
  assert.equal(foot.includes('14:05'), false)
})
