// engine-instances.mjs — the second engine instance and the wall around it.
//
// Everything here runs against a FAKE engine module, so the tests are about
// the lifecycle rules (serialisation, rollback, surface) and not about the
// parser. The real bundle with a real localized data set is exercised in
// bilingual-parse.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngineInstances, PRIMARY_LANG } from './engine-instances.mjs'

// A stand-in for engine.bundle.mjs: same exported surface (that is the point —
// the wrapper must hide the dangerous half of it), plus a log of every
// lifecycle call and a way to make one fail.
function makeFakeEngine (lang, events, { delayMs = 0 } = {}) {
  const mod = {
    lang,
    fail: null, // set to a string to make the next ready/reload throw
    async ready (opts) { return enter('ready', opts) },
    async reload (opts) { return enter('reload', opts) },
    async parseItem (clipboard, opts) {
      events.push({ lang, call: 'parseItem', clipboard, opts })
      return { item: { lang, clipboard }, presets: { presets: [], active: null } }
    },
    async searchPreset () { throw new Error('searchPreset must never be reachable here') },
    async bulkPriceItem () { throw new Error('bulkPriceItem must never be reachable here') },
    async searchRaw () { throw new Error('searchRaw must never be reachable here') },
    activePreset: p => p.presets[0],
    RATE_LIMIT_RULES: { SEARCH: [] }
  }
  async function enter (call, opts) {
    events.push({ lang, call, phase: 'enter', dir: opts?.publicDataDir, optsLang: opts?.lang })
    // Yield at least once: with a Promise.all over the instances this is where
    // the second load would slip in and the overlap assertion would fire.
    await new Promise(r => setTimeout(r, delayMs))
    if (mod.fail) { const m = mod.fail; mod.fail = null; events.push({ lang, call, phase: 'throw' }); throw new Error(m) }
    events.push({ lang, call, phase: 'leave', dir: opts?.publicDataDir })
    mod.dir = opts?.publicDataDir
  }
  return mod
}

// importer double: one fake module per specifier, remembering the specifiers.
function makeImporter (events, opts = {}) {
  const byLang = new Map()
  const specifiers = []
  const importer = async (url) => {
    specifiers.push(url)
    const lang = new URL(url, 'file:///x').searchParams.get('lang') || PRIMARY_LANG
    const mod = makeFakeEngine(lang, events, opts)
    byLang.set(lang, mod)
    return mod
  }
  return { importer, byLang, specifiers }
}

const BUNDLE = 'file:///app/backend/v2/engine.bundle.mjs'
const quiet = { warn () {}, log () {} }

const make = async (languages, events, opts) => {
  const imp = makeImporter(events, opts)
  const engines = await createEngineInstances({ bundleUrl: BUNDLE, languages, importer: imp.importer, log: quiet })
  return { engines, ...imp }
}

// --- the wall ---------------------------------------------------------------

test('the non-primary instance exposes EXACTLY parseItem and nothing else', async () => {
  const events = []
  const { engines } = await make(['de'], events)
  await engines.ready({ publicDataDir: 'file:///snap/v1/' })
  const de = engines.parserFor('de')

  // An exact key-set assertion on purpose: a function added to the wrapper
  // later — however well meant — fails this test instead of quietly widening
  // the surface that reaches the trade API on a virgin rate limiter.
  assert.deepEqual(Reflect.ownKeys(de), ['parseItem'])
  assert.deepEqual(Object.keys(de), ['parseItem'])
  assert.equal(typeof de.parseItem, 'function')
  assert.ok(Object.isFrozen(de), 'frozen, so nothing can be bolted on at runtime either')

  // The three names from the ban history, spelled out.
  for (const forbidden of ['searchPreset', 'bulkPriceItem', 'searchRaw', 'ready', 'reload', 'RATE_LIMIT_RULES']) {
    assert.equal(de[forbidden], undefined, `${forbidden} must not be reachable on the German instance`)
  }
  // ESM is strict mode, so this does not even fail quietly.
  assert.throws(() => { de.searchPreset = () => 'sneaked in' }, TypeError)
  assert.equal(de.searchPreset, undefined)
})

test('the German instance is a SEPARATE module graph, addressed by its own specifier', async () => {
  const events = []
  const { engines, byLang, specifiers } = await make(['de'], events)
  assert.deepEqual(specifiers, [BUNDLE, `${BUNDLE}?lang=de`])
  assert.notEqual(byLang.get('en'), byLang.get('de'))
  assert.equal(engines.primary(), byLang.get('en'))
})

test('parseItem is delegated to the instance of that language, data-root options stripped', async () => {
  const events = []
  const { engines } = await make(['de'], events)
  await engines.ready({ publicDataDir: 'file:///snap/v1/' })
  await engines.parserFor('de').parseItem('Gegenstandsklasse: Ringe', { league: 'Standard', publicDataDir: 'file:///elsewhere/', lang: 'en' })
  const parse = events.find(e => e.call === 'parseItem')
  assert.equal(parse.lang, 'de')
  assert.deepEqual(parse.opts, { league: 'Standard' }, 'no caller-supplied data root or language reaches the engine')
})

test('a language without an instance has no parser at all (no silent English fallback)', async () => {
  const events = []
  const { engines } = await make([], events)
  await engines.ready({ publicDataDir: 'file:///snap/v1/' })
  assert.equal(engines.parserFor('de'), undefined)
  assert.ok(engines.parserFor(PRIMARY_LANG), 'English is always there')
})

// --- serialisation ----------------------------------------------------------

// __aptEnv.BASE_URL is process-wide, so two loads may never be in flight at the
// same time. Both instances get a real await inside their load, so a
// Promise.all would interleave and be caught here.
function assertSerial (events, call) {
  let inFlight = 0
  for (const e of events) {
    if (e.call !== call) continue
    if (e.phase === 'enter') {
      inFlight++
      assert.equal(inFlight, 1, `two ${call}() calls were in flight at once (${e.lang})`)
    } else if (e.phase === 'leave' || e.phase === 'throw') inFlight--
  }
}

test('ready() loads the instances strictly one after the other', async () => {
  const events = []
  const { engines } = await make(['de'], events, { delayMs: 5 })
  await engines.ready({ publicDataDir: 'file:///snap/v1/' })
  assertSerial(events, 'reload') // first load goes through reload() (fresh _ready)
  assert.deepEqual(engines.liveLanguages(), ['en', 'de'])
})

test('reload() reloads the instances strictly one after the other, onto the same dir', async () => {
  const events = []
  const { engines } = await make(['de'], events, { delayMs: 5 })
  await engines.ready({ publicDataDir: 'file:///snap/v1/' })
  events.length = 0
  await engines.reload({ publicDataDir: 'file:///snap/v2/' })
  assertSerial(events, 'reload')
  assert.deepEqual(events.filter(e => e.phase === 'enter').map(e => e.lang), ['en', 'de'])
  assert.ok(events.filter(e => e.phase === 'enter').every(e => e.dir === 'file:///snap/v2/'), 'one snapshot dir for both languages')
  assert.equal(engines.dataDir(), 'file:///snap/v2/')
})

// --- failure handling -------------------------------------------------------

test('a failing German load at boot leaves English running, without a German parser', async () => {
  const events = []
  const warnings = []
  const imp = makeImporter(events)
  const engines = await createEngineInstances({
    bundleUrl: BUNDLE, languages: ['de'], importer: imp.importer, log: { warn: m => warnings.push(String(m)) }
  })
  imp.byLang.get('de').fail = 'ENOENT data/de/items.ndjson'
  await engines.ready({ publicDataDir: 'file:///snap/v1/' })

  assert.deepEqual(engines.liveLanguages(), ['en'])
  assert.equal(engines.parserFor('de'), undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /rejected loudly/)
})

test('a failing primary load still throws — there is no tool without English', async () => {
  const events = []
  const imp = makeImporter(events)
  const engines = await createEngineInstances({ bundleUrl: BUNDLE, languages: ['de'], importer: imp.importer, log: quiet })
  imp.byLang.get(PRIMARY_LANG).fail = 'corrupt snapshot'
  await assert.rejects(() => engines.ready({ publicDataDir: 'file:///snap/v1/' }), /corrupt snapshot/)
})

test('if ONE instance fails to reload, BOTH go back to the previous snapshot', async () => {
  const events = []
  const imp = makeImporter(events)
  const engines = await createEngineInstances({ bundleUrl: BUNDLE, languages: ['de'], importer: imp.importer, log: quiet })
  await engines.ready({ publicDataDir: 'file:///snap/v1/' })
  assert.deepEqual(engines.liveLanguages(), ['en', 'de'])

  // English adopts the new snapshot fine, German cannot (its set is missing
  // from it). Without a shared rollback English would be left on v2 and German
  // on v1 — two languages on two different data sets, in one process.
  imp.byLang.get('de').fail = 'data/de is gone'
  events.length = 0
  await assert.rejects(() => engines.reload({ publicDataDir: 'file:///snap/v2/' }), /data\/de is gone/)

  assertSerial(events, 'reload')
  assert.equal(imp.byLang.get('en').dir, 'file:///snap/v1/', 'English rolled back')
  assert.equal(imp.byLang.get('de').dir, 'file:///snap/v1/', 'German back on its last good data')
  assert.deepEqual(engines.liveLanguages(), ['en', 'de'], 'both still serving')
})

test('an instance that never came up does not veto later English updates', async () => {
  const events = []
  const warnings = []
  const imp = makeImporter(events)
  const engines = await createEngineInstances({
    bundleUrl: BUNDLE, languages: ['de'], importer: imp.importer, log: { warn: m => warnings.push(String(m)) }
  })
  imp.byLang.get('de').fail = 'no German set yet'
  await engines.ready({ publicDataDir: 'file:///snap/v1/' })
  assert.deepEqual(engines.liveLanguages(), ['en'])

  // The German set is still missing at the next adoption. That must not freeze
  // the English data updates forever — "the previous state stays live" for a
  // down instance means it stays down.
  imp.byLang.get('de').fail = 'still no German set'
  await engines.reload({ publicDataDir: 'file:///snap/v2/' })
  assert.equal(imp.byLang.get('en').dir, 'file:///snap/v2/')
  assert.deepEqual(engines.liveLanguages(), ['en'])

  // ...and once the set shows up, the retry inside reload() picks it up.
  await engines.reload({ publicDataDir: 'file:///snap/v3/' })
  assert.deepEqual(engines.liveLanguages(), ['en', 'de'])
  assert.equal(imp.byLang.get('de').dir, 'file:///snap/v3/')
})

test('a parser reference taken before a vetoed reload keeps working afterwards', async () => {
  // The item route looks the parser up per request, but a card already being
  // worked on holds one. After a rolled-back adoption it must still parse —
  // against the previous, still-mounted data.
  const events = []
  const imp = makeImporter(events)
  const engines = await createEngineInstances({ bundleUrl: BUNDLE, languages: ['de'], importer: imp.importer, log: quiet })
  await engines.ready({ publicDataDir: 'file:///snap/v1/' })
  const de = engines.parserFor('de')

  imp.byLang.get('de').fail = 'data/de is gone'
  await assert.rejects(() => engines.reload({ publicDataDir: 'file:///snap/v2/' }))

  const { item } = await de.parseItem('Gegenstandsklasse: Ringe')
  assert.equal(item.lang, 'de')
  assert.equal(engines.dataDir(), 'file:///snap/v1/', 'still on the snapshot that works')
})
