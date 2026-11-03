// One process, two languages: the engine bundle loaded TWICE, and only one of
// the two copies allowed anywhere near the network. The bundled parser keeps
// its item/stat database in module-level closures that `initData(lang)`
// reassigns (assets/data), so one instance serves exactly one language.
// `import(BUNDLE + '?lang=de')` is a different specifier, so Node builds a
// second graph with its own closures, its own `_ready` and its own
// RATE_LIMIT_RULES. Two conditions come with that, and neither is style:
//
//  1. BOTH languages live in the SAME versioned snapshot dir. `ready()` writes
//     `globalThis.__aptEnv.BASE_URL` PROCESS-WIDE (engine.mts) and every load
//     path reads it at fetch time, so two instances pointed at different roots
//     would read each other's data; and the localized load path still reads
//     `data/en/client_strings.js` from the same root (CLIENT_STRINGS_REF,
//     assets/data/index.ts). data/de sits NEXT TO data/en, never instead of it;
//     the data-refresher builds its snapshots that way (carryLangTree).
//  2. `ready()` and `reload()` run STRICTLY SERIALLY across instances: with
//     `__aptEnv` shared, a `Promise.all` over two loads is a race.
//
// THE NON-PRIMARY INSTANCE IS A WRAPPER, not a convention: its rate-limit state
// (RATE_LIMIT_RULES plus the header-learning `adjustRateLimits`, per module
// graph) starts at the virgin default (1 request / 5s) and knows nothing the
// primary has learned, while the server's serial queue and its ban gate only
// guard calls through the primary. One accidental `searchPreset` there is the
// ban path this project has already paid for once. So it is a frozen object
// with EXACTLY ONE key, `parseItem`; `searchPreset`, `bulkPriceItem` and
// `searchRaw` are not reachable on it, and `engine-instances.test.mjs` pins the
// key set so a function added later fails the build. parseItem itself is
// verified network-free: the bundle's only http(s) callers are Host.proxy in
// search/fetch/exchange, and data loading goes through the file:// adapter
// (bilingual-parse.test.mjs puts a fetch spy around a complete parse).

export const PRIMARY_LANG = 'en'

/**
 * createEngineInstances({ bundleUrl, languages, importer, log })
 *
 * `languages[0]` is ignored — PRIMARY_LANG is always the primary instance (the
 * full engine module: trade calls, rate limit rules, activePreset). Every other
 * entry becomes a parse-only instance.
 *
 * Returns:
 *   primary()                  -> the full engine module (unchanged API)
 *   parserFor(lang)            -> frozen { parseItem } or undefined when that
 *                                 language has no LIVE instance
 *   liveLanguages()            -> languages that are currently loaded
 *   languages()                -> languages that were configured
 *   ready({ publicDataDir })   -> serial initial load. A failing primary
 *                                 throws; a failing secondary is logged and
 *                                 stays down (English must not be held hostage
 *                                 by a missing German data set).
 *   reload({ publicDataDir })  -> serial reload of every LIVE instance plus a
 *                                 retry of the down ones. If a live instance
 *                                 fails, ALL of them are put back on the
 *                                 previous dir and the error is rethrown — the
 *                                 caller (data-refresher) then discards the
 *                                 snapshot. A retry of a down instance failing
 *                                 again changes nothing and does not throw.
 *   dataDir()                  -> the dir the instances are currently on
 */
export async function createEngineInstances ({
  bundleUrl,
  languages = [PRIMARY_LANG],
  importer = url => import(url),
  log = console
} = {}) {
  if (!bundleUrl) throw new Error('createEngineInstances: bundleUrl is required')

  const wanted = [PRIMARY_LANG, ...languages.filter(l => l && l !== PRIMARY_LANG)]
  const order = [...new Set(wanted)]

  // A second graph needs a DIFFERENT specifier — Node caches modules by
  // resolved URL. The query string is inert for the bundle itself.
  const specifierFor = lang => (lang === PRIMARY_LANG
    ? bundleUrl
    : `${bundleUrl}${bundleUrl.includes('?') ? '&' : '?'}lang=${encodeURIComponent(lang)}`)

  const instances = []
  for (const lang of order) {
    // Serial on purpose (see the header): the import itself is harmless, but
    // keeping the whole lifecycle in one order is easier to reason about than
    // "imports parallel, loads serial".
    const mod = await importer(specifierFor(lang))
    instances.push({ lang, mod, live: false })
  }
  const byLang = new Map(instances.map(i => [i.lang, i]))
  const primaryInstance = byLang.get(PRIMARY_LANG)

  let currentDir // the publicDataDir every live instance is on

  // The whole exposed surface of a non-primary instance. Frozen, with exactly
  // one own key. `publicDataDir`/`lang` are stripped from the caller's options
  // so nobody can re-point an instance through the parse path; everything else
  // (league, searchStatRange) passes through untouched.
  function makeParser (inst) {
    const parseItem = (clipboard, opts = {}) => {
      if (!inst.live) {
        return Promise.reject(new Error(`engine instance for "${inst.lang}" is not loaded`))
      }
      const { publicDataDir: _dir, lang: _lang, ...rest } = opts
      return inst.mod.parseItem(clipboard, rest)
    }
    return Object.freeze({ parseItem })
  }
  for (const inst of instances) inst.parser = makeParser(inst)

  async function loadOne (inst, publicDataDir, { fresh }) {
    const opts = { lang: inst.lang, publicDataDir }
    // reload() clears the cached _ready, ready() reuses it. A down instance is
    // always reloaded, so a rejected _ready from an earlier attempt cannot
    // stick around forever.
    if (fresh || !inst.live) await inst.mod.reload(opts)
    else await inst.mod.ready(opts)
    inst.live = true
  }

  async function ready ({ publicDataDir } = {}) {
    for (const inst of instances) {
      try {
        await loadOne(inst, publicDataDir, { fresh: false })
      } catch (e) {
        if (inst === primaryInstance) throw e
        inst.live = false
        log.warn?.(`[engine] no parser for language "${inst.lang}" (${e?.message || e}) — items from users on that language are rejected loudly instead of being parsed as ${PRIMARY_LANG}`)
      }
    }
    currentDir = publicDataDir
    return liveLanguages()
  }

  async function reload ({ publicDataDir } = {}) {
    const previousDir = currentDir
    const wasLive = instances.filter(i => i.live)
    try {
      for (const inst of instances) {
        try {
          await loadOne(inst, publicDataDir, { fresh: true })
        } catch (e) {
          // A live instance failing is a veto (rethrow -> rollback below). An
          // instance that was already down staying down is not: it must not
          // freeze the English data updates forever.
          if (wasLive.includes(inst)) throw e
          inst.live = false
          log.warn?.(`[engine] language "${inst.lang}" still has no parser after the reload (${e?.message || e})`)
        }
      }
    } catch (e) {
      // Everything back on the previous snapshot — including the instances
      // that already succeeded, otherwise the languages would sit on different
      // data sets. The previous dir is untouched on disk, so this is expected
      // to work; if it does not, the original error is still what the caller
      // sees.
      for (const inst of wasLive) {
        try {
          await loadOne(inst, previousDir, { fresh: true })
        } catch (rollbackErr) {
          inst.live = false
          log.warn?.(`[engine] rollback of language "${inst.lang}" to the previous data failed (${rollbackErr?.message || rollbackErr})`)
        }
      }
      throw e
    }
    currentDir = publicDataDir
    return liveLanguages()
  }

  function liveLanguages () { return instances.filter(i => i.live).map(i => i.lang) }

  return {
    primary: () => primaryInstance.mod,
    parserFor: lang => {
      const inst = byLang.get(lang)
      return (inst && inst.live) ? inst.parser : undefined
    },
    languages: () => order.slice(),
    liveLanguages,
    dataDir: () => currentDir,
    ready,
    reload
  }
}
