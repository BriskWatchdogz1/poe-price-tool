// The Price Check page's block "Buyer whispers (this session)" (whispers.js).
// Every field of an entry comes from another player's whisper (item, tab,
// league) and is shown as text; verdicts and reasons have words in both
// languages, and an unknown one is shown as it came, escaped like the rest.
//
// Same approach as daemon-hint.test.mjs: i18n.js and whispers.js are
// evaluated in a vm, and the pure functions are called with entries.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { REASONS } from '../whisper-price.mjs'

const here = p => fileURLToPath(new URL(p, import.meta.url))

async function load (lang = 'en') {
  const ctx = vm.createContext({ window: {}, localStorage: undefined })
  vm.runInContext(await readFile(here('i18n.js'), 'utf8'), ctx, { filename: 'i18n.js' })
  vm.runInContext(await readFile(here('whispers.js'), 'utf8'), ctx, { filename: 'whispers.js' })
  if (lang !== 'en') ctx.window.I18n.setLang(lang)
  return { W: ctx.window.Whispers, I18n: ctx.window.I18n }
}

const BASE = {
  key: 'a1b2c3d4:w1', wid: 'w1', label: 'buyer 1', at: Date.UTC(2026, 10, 3, 12, 0), by: 'a1b2c3d4',
  kind: 'single', lang: 'en', league: 'Mercenaries', tab: 'Sale', left: 5, top: 3, extraLen: 0,
  item: { text: 'Tabula Rasa, Simple Robe', ref: 'Tabula Rasa', base: 'Simple Robe', kind: 'unique' },
  qty: 1,
  asked: { amount: 140, unit: 'divine', chaos: 28000, chaosEach: 28000 },
  market: { chaosEach: 30000, chaos: 30000, source: 'ninja' },
  ratio: 0.93, pct: 7, verdict: 'fair', reason: null
}

test("a buyer's text is shown as text", async () => {
  const { W } = await load()
  const html = W.rowHtml({
    ...BASE,
    item: { text: '<img src=x onerror=alert(1)>', kind: 'rare' },
    tab: '"><b>x</b>',
    league: '<script>1</script>',
    label: 'buyer 1',
    verdict: '<i>odd</i>',
    reason: '<u>why</u>'
  })
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /<b>/)
  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(html, /<i>|<u>/, 'an unknown verdict or reason is text as well')
  assert.match(html, /&lt;i&gt;odd&lt;\/i&gt;/)
})

test('a row says who, what, your price against the market, the verdict and where it lies', async () => {
  const { W } = await load()
  const html = W.rowHtml({ ...BASE, verdict: 'below', pct: 7, ratio: 0.93 })
  assert.match(html, /buyer 1 · a1b2/, 'the pseudonym with the first 4 characters of the instance')
  assert.doesNotMatch(html, /a1b2c3d4/)
  assert.match(html, /Tabula Rasa, Simple Robe/)
  assert.match(html, /your 140 divine · market 150 divine/)
  assert.match(html, /−7 %/)
  assert.match(html, /below market/)
  assert.match(html, /tab &quot;Sale&quot; · left 5, top 3/, 'the quotes escaped like every other character')
  assert.match(html, /wv-below/)

  const above = W.rowHtml({ ...BASE, verdict: 'above', pct: 12 })
  assert.match(above, /\+12 %/)
  assert.match(above, /wv-above/)

  const bulk = W.rowHtml({ ...BASE, kind: 'bulk', qty: 10, item: { text: 'Orb of Alchemy', kind: 'fungible' }, tab: null, left: null, top: null })
  assert.match(bulk, /10 × Orb of Alchemy/)
  assert.doesNotMatch(bulk, /tab &quot;/, 'a bulk whisper names no tab')
})

test('no verdict always says why, a pending one says it is checking, and an unparsed one has no item', async () => {
  const { W } = await load()
  const nc = W.rowHtml({ ...BASE, verdict: 'not-compared', reason: 'variants', ratio: null, pct: null, market: null })
  assert.match(nc, /not compared/)
  assert.match(nc, /several variants/)
  assert.match(nc, /wv-nc/)
  const other = W.rowHtml({ ...BASE, verdict: 'not-compared', reason: 'other-league', league: 'Standard' })
  assert.match(other, /another league \(Standard\)/)
  const raw = W.rowHtml({ ...BASE, verdict: 'not-compared', reason: 'brand-new-reason' })
  assert.match(raw, /brand-new-reason/, 'an unknown reason as it came')
  assert.match(W.rowHtml({ ...BASE, verdict: 'pending', reason: null }), /checking…/)
  const un = W.rowHtml({ key: 'x:w9', wid: 'w9', label: 'buyer 2', at: BASE.at, by: 'x', verdict: 'unparsed' })
  assert.match(un, /not recognised/)
  // Every reason the server can send (whisper-price.mjs REASONS) has words,
  // in English and in German.
  const { W: Wde } = await load('de')
  assert.ok(REASONS.includes('no-rate') && REASONS.includes('uncertain-price'))
  for (const reason of REASONS) {
    for (const R of [W, Wde]) {
      const h = R.rowHtml({ ...BASE, verdict: 'not-compared', reason })
      assert.doesNotMatch(h, new RegExp(`${reason}<`), `${reason} has words`)
    }
  }
})

test('the list keeps the newest first and replaces an entry by its key', async () => {
  const { W } = await load()
  let list = W.upsert([], { ...BASE, key: 'a:w1' })
  list = W.upsert(list, { ...BASE, key: 'b:w1' })
  list = W.upsert(list, { ...BASE, key: 'a:w1', verdict: 'below' })
  assert.deepEqual(Array.from(list, e => e.key), ['b:w1', 'a:w1'])
  assert.equal(list[1].verdict, 'below')
  assert.equal(W.upsert(list, null).length, 2, 'a message without an entry changes nothing')
  assert.equal(W.listHtml([]), '')
})

test('German words and German numbers', async () => {
  const { W } = await load('de')
  const html = W.rowHtml({ ...BASE, verdict: 'below', asked: { amount: 1.5, unit: 'divine', chaos: 300, chaosEach: 300 }, market: { chaosEach: 400, chaos: 400 } })
  assert.match(html, /dein 1,5 divine · Markt 2 divine/)
  assert.match(html, /unter Markt/)
  assert.match(html, /Truhenfach &quot;Sale&quot; · links 5, oben 3/, 'the game\'s word, as in the German whisper')
})

// A single whisper for a stackable item gets no verdict, but both readings of
// 'listed for': per unit, and per stack of the size the server found (in the
// whisper's own text or at that cell in the last sync).
test('a single whisper for a stackable shows both readings and no verdict', async () => {
  const { W } = await load()
  const STACK = {
    ...BASE,
    item: { text: 'Orb of Alchemy', ref: 'Orb of Alchemy', base: null, kind: 'fungible' },
    asked: { amount: 100, unit: 'chaos', chaos: 100, chaosEach: 100 },
    market: { chaosEach: 0.4, chaos: 0.4, source: 'faustus' },
    ratio: null, pct: null, verdict: 'not-compared', reason: 'stack-unknown'
  }
  const both = W.rowHtml({ ...STACK, stack: { size: 20, from: 'sync', chaosEach: 5 } })
  assert.match(both, /listed 100 c: per unit 100 c, per stack of 20 \(last sync\): 5 c per unit; market 0.4 c per unit/)
  assert.match(both, /not compared — per unit or per stack is not known/)
  assert.doesNotMatch(both, /your 100 chaos/)
  assert.doesNotMatch(both, /[−+±]\d/, 'no percentage without a verdict')

  const unit = W.rowHtml({ ...STACK, stack: null })
  assert.match(unit, /listed 100 c: per unit 100 c; market 0.4 c per unit/)
  const price = h => /<span class="wprice">([^<]*)</.exec(h)[1]
  assert.equal(price(unit), 'listed 100 c: per unit 100 c; market 0.4 c per unit')
  for (const odd of [{ size: 1, chaosEach: 100 }, { size: '20', chaosEach: 5 }, { size: 20 }, 'x', []]) {
    assert.equal(price(W.rowHtml({ ...STACK, stack: odd })), 'listed 100 c: per unit 100 c; market 0.4 c per unit', JSON.stringify(odd))
  }

  const DIV = { ...STACK, asked: { amount: 1, unit: 'divine', chaos: 150, chaosEach: 150 }, stack: { size: 20, from: 'whisper', chaosEach: 7.5 } }
  const div = W.rowHtml(DIV)
  assert.match(div, /listed 1 divine \(150 c\): per unit 150 c, per stack of 20: 7.5 c per unit/)

  // Cheap units keep the server's three significant digits (0.025 c is not
  // 0.03 c, and 0.004 c is not 0).
  const cheap = { ...STACK, asked: { amount: 1, unit: 'chaos', chaos: 1, chaosEach: 1 }, market: { chaosEach: 0.149, chaos: 0.149, source: 'ninja' } }
  assert.equal(price(W.rowHtml({ ...cheap, stack: { size: 40, from: 'whisper', chaosEach: 0.025 } })),
    'listed 1 c: per unit 1 c, per stack of 40: 0.025 c per unit; market 0.149 c per unit')
  assert.equal(price(W.rowHtml({ ...cheap, stack: { size: 250, from: 'whisper', chaosEach: 0.004 } })),
    'listed 1 c: per unit 1 c, per stack of 250: 0.004 c per unit; market 0.149 c per unit')
  assert.equal(price(W.rowHtml({ ...cheap, stack: { size: 3, from: 'whisper', chaosEach: 0.333 } })),
    'listed 1 c: per unit 1 c, per stack of 3: 0.333 c per unit; market 0.149 c per unit')

  // A doubtful rate or market price stands next to the numbers it doubts.
  const stale = price(W.rowHtml({ ...DIV, caveat: 'rate-unknown' }))
  assert.equal(stale, 'listed 1 divine (150 c): per unit 150 c, per stack of 20: 7.5 c per unit; market 0.4 c per unit — Chaos:Divine rate unknown or old')
  const thin = price(W.rowHtml({ ...STACK, stack: null, market: { ...STACK.market, uncertain: 'thin-market' }, caveat: 'uncertain-price' }))
  assert.match(thin, /market 0.4 c per unit — too little trading behind the market price/)
  assert.equal(price(W.rowHtml({ ...STACK, stack: null, caveat: null })), 'listed 100 c: per unit 100 c; market 0.4 c per unit')
  assert.equal(price(W.rowHtml({ ...STACK, stack: null, caveat: '<b>new</b>' })),
    'listed 100 c: per unit 100 c; market 0.4 c per unit — &lt;b&gt;new&lt;/b&gt;', 'a newer caveat is shown as it came')

  const { W: Wde } = await load('de')
  const de = Wde.rowHtml({ ...STACK, asked: { amount: 1.5, unit: 'chaos', chaos: 1.5, chaosEach: 1.5 }, stack: { size: 3, from: 'sync', chaosEach: 0.5 } })
  assert.match(de, /gelistet 1,5 c: je Stück 1,5 c, je Stapel von 3 \(letzter Sync\): 0,5 c je Stück; Markt 0,4 c je Stück/)
  assert.match(de, /nicht verglichen — ob je Stück oder je Stapel, ist unbekannt/)
  assert.match(Wde.rowHtml({ ...cheap, stack: { size: 40, from: 'whisper', chaosEach: 0.025 } }), /je Stapel von 40: 0,025 c je Stück; Markt 0,149 c je Stück/)
  assert.match(Wde.rowHtml({ ...STACK, caveat: 'rate-unknown' }), /Markt 0,4 c je Stück — Chaos:Divine-Kurs unbekannt oder alt/)
})
