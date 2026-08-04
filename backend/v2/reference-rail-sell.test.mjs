// Rail wiring of the sell side: for the lifeforce rows and Dead Man's Sulphur the
// DISPLAYED number and the sparkline both come from the same Faustus
// derivation (the "Selling" heading has to be true). Mirror keeps poe.ninja's
// number, Exalted is gone entirely, and staleness costs the number instead of
// producing a market middle. poe.ninja and the Faustus CDN are both
// fetch-stubbed (no network).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'refrailsell-'))

process.env.PORT = '0'
process.env.POE_CORPSE_DISABLED = '1'
process.env.POE_NETWORTH_AUTOSYNC = '0'
process.env.POE_LEAGUE = 'BootLeague'
delete process.env.POE_FAUSTUS_DISABLED // Faustus ON — the store feeds the rows
process.env.POE_FAUSTUS_STORE = join(dir, 'faustus-store.json')
process.env.POE_REFERENCE_HISTORY = join(dir, 'reference-history.ndjson')

const RATIO = 200
const EXCHANGE = {
  core: { primary: 'chaos' },
  lines: [
    { id: 'divine', primaryValue: RATIO, sparkline: { data: [1, 2] } },
    { id: 'exalted', primaryValue: 20, sparkline: { data: [1, 2] } },
    { id: 'mirror', primaryValue: 100_000, sparkline: { data: [1, 2] } },
    { id: 'vivid-lifeforce', primaryValue: 0.02, sparkline: { data: [1, 2] } },
    { id: 'wild-lifeforce', primaryValue: 0.04, sparkline: { data: [1, 2] } },
    { id: 'primal-lifeforce', primaryValue: 0.03, sparkline: { data: [1, 2] } }
  ]
}
const BEASTS = {
  lines: [{ name: 'Vivid Vulture', chaosValue: 1800, divineValue: 9, count: 40, sparkLine: { data: [1, 2] } }]
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const u = String(url)
  // Faustus CDN -> "not ready" forever (empty markets): the boot tick finds
  // nothing and the test seeds the store by hand below.
  if (u.includes('web.poecdn.com')) return { ok: true, status: 200, json: async () => ({ markets: [] }) }
  const body = u.includes('exchange/current/overview')
    ? EXCHANGE
    : (u.includes('item/overview') ? BEASTS : { lines: [] })
  return { ok: true, status: 200, json: async () => body }
}

const fat = { volX: 10_000_000, volQuote: 300_000 }
const fatDiv = { volX: 10_000_000, volQuote: 5_000 }
const SELL = {
  // Vivid: both attested, chaos pays ~6.2% more.
  'Vivid Crystallised Lifeforce': {
    chaos: { perItem: 0.03841, ...fat },
    divine: { perItem: 0.03616 / RATIO, ...fatDiv }
  },
  // Wild (outlier): divine side below the turnover floor (20 div * 200 =
  // 4000c < 5000c) -> no comparison claimed, chaos side shown alone.
  'Wild Crystallised Lifeforce': {
    chaos: { perItem: 0.04259, ...fat },
    divine: { perItem: 0.01949 / RATIO, volX: 500_000, volQuote: 20 }
  },
  // Primal: both attested, chaos ~8.6%.
  'Primal Crystallised Lifeforce': {
    chaos: { perItem: 0.02943, ...fat },
    divine: { perItem: 0.02711 / RATIO, ...fatDiv }
  },
  // Sulphur: both attested, chaos ~7.1% ahead (>= the takeover bar) -> unit
  // follows chaos ("/ c"), even though that is a sub-1 quantity per piece.
  "Dead Man's Sulphur": {
    chaos: { perItem: 1.5, ...fat },
    divine: { perItem: 1.4 / RATIO, ...fatDiv }
  },
  // Mirror: divine market only.
  'Mirror of Kalandra': {
    divine: { perItem: 500, ...fatDiv }
  }
}

let mod
before(async () => {
  mod = await import('./server.mjs')
  // Let the boot-time refresher tick settle (it writes an EMPTY map), then
  // seed the store with the separated sell rates. C:D in this test is 200.
  const t0 = Date.now()
  while (mod.faustusStore.updatedAt() == null && Date.now() - t0 < 3000) {
    await new Promise(r => setTimeout(r, 25))
  }
  await mod.faustusStore.setPrices('RailFresh', {}, Date.now(), null, SELL)
})
after(async () => {
  globalThis.fetch = realFetch
  await new Promise(r => mod.server.close(r))
  await rm(dir, { recursive: true, force: true })
})

test('lifeforce rows carry the sell hint: right side, right edge, outlier claims nothing', async () => {
  const msg = await mod.refreshReference('RailFresh')
  const rows = Object.fromEntries([...msg.currency, ...msg.lifeforce, ...msg.beasts].map(r => [r.name, r]))

  const vivid = rows['Vivid Lifeforce'].sell
  assert.equal(vivid.better, 'chaos')
  assert.equal(vivid.edgePct, 6.2)
  assert.equal(vivid.cd, RATIO)
  assert.equal(vivid.viaChaos, 0.03841)
  assert.equal(vivid.viaDivine, 0.03616)
  assert.equal(typeof vivid.updatedAt, 'number')

  const wild = rows['Wild Lifeforce'].sell
  assert.equal(wild.better, null)
  assert.equal(wild.edgePct, null)
  assert.equal(wild.only, 'chaos')

  const primal = rows['Primal Lifeforce'].sell
  assert.equal(primal.better, 'chaos')
  assert.equal(primal.edgePct, 8.6)
})

test('the displayed number IS the sell side, not poe.ninja', async () => {
  const msg = await mod.refreshReference('RailFresh')
  const rows = Object.fromEntries([...msg.currency, ...msg.lifeforce].map(r => [r.name, r]))

  // poe.ninja says 0.02 c per Vivid (= 50 / c). The rail must show the FAUSTUS
  // revenue of the better side (0.03841 c per piece = 26 / c) instead.
  assert.equal(rows['Vivid Lifeforce'].display, `${Math.round(1 / 0.03841)} / c`)
  assert.equal(rows['Vivid Lifeforce'].display, '26 / c')
  // Wild: only one attested side -> that side's rate feeds the number.
  assert.equal(rows['Wild Lifeforce'].display, `${Math.round(1 / 0.04259)} / c`)
  assert.equal(rows['Primal Lifeforce'].display, `${Math.round(1 / 0.02943)} / c`)
  // Mirror is untouched: poe.ninja's price, in divine.
  assert.equal(rows['Mirror of Kalandra'].display, '500 div')
})

test("Dead Man's Sulphur sits in CURRENCY with a sell object backing its number, Exalted is gone", async () => {
  const msg = await mod.refreshReference('RailFresh')
  const sulphur = msg.currency.find(r => r.name === "Dead Man's Sulphur")
  assert.ok(sulphur, 'Sulphur is a currency row')
  // The unit follows the RECOMMENDATION, not a scarcity threshold: chaos pays
  // ~7.1% more here (>= the 5% takeover bar) -> chaos wins -> printed per chaos.
  // That yields a sub-1 quantity (1/1.5 = 0.667 pieces per chaos), and the
  // display keeps three significant digits there: rounding to a whole piece
  // would print "1" for a rate that is not 1 — destroying the one number the
  // row exists to show.
  assert.equal(sulphur.sell.better, 'chaos')
  assert.equal(sulphur.display, '0.667 / c')
  assert.equal(sulphur.invert, true)
  assert.equal(sulphur.sell.edgePct, 7.1)
  assert.equal(sulphur.sell.viaChaos, 1.5)
  assert.equal(sulphur.sell.viaDivine, 1.4)

  const names = [...msg.currency, ...msg.lifeforce, ...msg.beasts].map(r => r.name)
  assert.equal(names.includes('Exalted Orb'), false)
})

test('deadband end-to-end: chaos pays a bit more but not enough to take over -> divine recommended, no percentage, unit follows divine', async () => {
  // Fresh league (no remembered verdict): chaos edge = 2%, under the 5%
  // takeover bar -> compareSellSides recommends divine anyway, edgePct null.
  const league = 'RailDeadband'
  await mod.faustusStore.setPrices(league, {}, Date.now(), null, {
    'Vivid Crystallised Lifeforce': {
      chaos: { perItem: 0.0102, ...fat },
      divine: { perItem: 0.01 / RATIO, ...fatDiv }
    }
  })
  const msg = await mod.refreshReference(league)
  const vivid = msg.lifeforce.find(r => r.name === 'Vivid Lifeforce')
  assert.equal(vivid.sell.better, 'divine')
  assert.equal(vivid.sell.edgePct, null)
  // Unit AND number follow the recommendation (divine, bridged rate 0.01),
  // not the chaos-side rate (0.0102) — and five-digit results are comma-grouped.
  assert.equal(vivid.display, `${Math.round(RATIO / 0.01).toLocaleString('en-US')} / div`)
  assert.equal(vivid.display, '20,000 / div')
})

test('currency rows join in uniformly; beasts never carry sell', async () => {
  const msg = await mod.refreshReference('RailFresh')
  const rows = Object.fromEntries([...msg.currency, ...msg.lifeforce, ...msg.beasts].map(r => [r.name, r]))

  const mir = rows['Mirror of Kalandra'].sell
  assert.equal(mir.better, null)
  assert.equal(mir.only, 'divine')
  assert.equal(mir.viaChaos, null)
  assert.equal(mir.viaDivine, 500 * RATIO)

  assert.equal('sell' in rows['Vivid Vulture'], false)
  // internal fields still stripped from every row
  for (const r of Object.values(rows)) {
    assert.equal('key' in r, false)
    assert.equal('chaos' in r, false)
    assert.equal('unit' in r, false)
  }
})

test('number and sparkline come from the SAME source (old poe.ninja points ignored)', async () => {
  const league = 'RailSpark'
  await mod.faustusStore.setPrices(league, {}, Date.now(), null, SELL)
  const at = Date.now() - 30 * 60 * 1000
  mod.referenceHistory.points.push({
    lg: league,
    at,
    cd: RATIO,
    v: {
      // the sell-side series: half the revenue 30 min ago
      's:Vivid Crystallised Lifeforce': 0.03841 / 2,
      "s:Dead Man's Sulphur": 1.5 / 2,
      // a leftover point from the poe.ninja era — must NOT be picked up
      'j:vivid-lifeforce': 0.02
    }
  })
  const msg = await mod.refreshReference(league)
  const rows = Object.fromEntries([...msg.currency, ...msg.lifeforce].map(r => [r.name, r]))

  // Mirrors `grouped()` in server.mjs: whole pieces from 10 up, three
  // significant digits below — so this stays an assertion about the VALUE and
  // its unit, not about how many digits the display happens to print.
  const asDisplayed = n => n >= 10 ? Math.round(n) : Number(n.toPrecision(3))
  const printed = row => Number(row.display.split(' ')[0].replace(/,/g, ''))

  const vivid = rows['Vivid Lifeforce']
  assert.equal(vivid.sparkline.length, 2)
  // Right edge of the line == the printed number (same value, same unit).
  assert.equal(asDisplayed(vivid.sparkline[1]), printed(vivid))
  assert.equal(vivid.sparkline[1], 1 / 0.03841)
  assert.equal(vivid.sparkline[0], 1 / (0.03841 / 2)) // half the revenue -> twice the pieces

  const sulphur = rows["Dead Man's Sulphur"]
  assert.equal(sulphur.sparkline.length, 2)
  assert.equal(asDisplayed(sulphur.sparkline[1]), printed(sulphur))
  // Sulphur's recommendation is 'chaos' (see the earlier test), so the series
  // is drawn in perC, not perDiv: pieces per 1 chaos, same unit as `display`.
  assert.equal(sulphur.sparkline[1], 1 / 1.5)
  assert.equal(sulphur.sparkline[0], 1 / (1.5 / 2)) // half the revenue -> twice the pieces

  // Rows the sell side can't back have no series at all — not even from the
  // old poe.ninja keys.
  const stale = mod.referenceHistory.series(league, 'j:vivid-lifeforce', 'perC')
  assert.deepEqual(stale, [], 'the abandoned series is never drawn')
})

test('stale store -> the row shows no number instead of a market middle', async () => {
  // Same league, but the store's stamp is far beyond FAUSTUS_TTL_MS (48h).
  const old = Date.now() - 3 * 24 * 60 * 60 * 1000
  await mod.faustusStore.setPrices('RailStale', {}, old, null, SELL)
  const msg = await mod.refreshReference('RailStale')
  const vivid = msg.lifeforce.find(r => r.name === 'Vivid Lifeforce')
  assert.ok(vivid, 'row still renders')
  assert.equal('sell' in vivid, false)
  assert.equal(vivid.display, '—')
  assert.deepEqual(vivid.sparkline, [])

  const sulphur = msg.currency.find(r => r.name === "Dead Man's Sulphur")
  assert.equal(sulphur.display, '—')
  assert.equal('sell' in sulphur, false)
  // Mirror keeps its poe.ninja number — only its `sell` object is gone.
  const mir = msg.currency.find(r => r.name === 'Mirror of Kalandra')
  assert.equal(mir.display, '500 div')
})
