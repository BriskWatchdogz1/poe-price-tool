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

const here = dirname(fileURLToPath(import.meta.url))
const dir = await mkdtemp(join(tmpdir(), 'refrailsrc-'))

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
globalThis.fetch = async (url) => {
  const u = String(url)
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
  const factory = new Function(`
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const sparkSvg = () => ''
    ${body}
    return { refSources, refSection, refFooter }
  `)
  return factory()
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
