// Background auto-updater for the three vendored data sources that go stale
// with every league patch — WITHOUT anyone touching the server:
//
//  1. APT item/stat data  (renderer/public/data/en/*)     -> the price-check parser
//  2. base-names.json     (RePoE base_items.json)         -> the Faustus id->name bridge
//  3. the LOCALIZED data set (data/de/*)                  -> the second parser
//     — no upstream at all: generated locally out of 1. plus GGG's game data
//     (lang-data-gen.mjs). See "the localized set" further down.
//
// Modelled on faustus-refresher.mjs and corpse-pricer.mjs: runs on its own,
// persists into /config, survives restarts, and on ANY problem keeps the last
// good state instead of wiping. Principles (docs/admin.md "Data auto-update"):
//  - Conditional requests: ETag/Last-Modified are stored per source and sent
//    back — on days without an upstream change, no payload flows at all.
//  - Validate BEFORE adopt: a snapshot is parsed and schema-checked, its
//    search indices generated, and only then swapped in. A broken or
//    half-loaded download is rejected with a warning; the old data stays.
//  - Adopted snapshots live under POE_DATA_REFRESH_DIR (default
//    /config/data-refresh) and are preferred at the next boot, so an update
//    survives a container recreate. If the dir isn't writable (local run
//    without the volume), the whole feature disables with one warning; like
//    the other /config stores, it never throws per tick. state.json is read
//    like their files (store-file.mjs): a broken one is moved aside with one
//    warning and the refresher starts empty; one that cannot be read or moved
//    is never written over, and the feature stays off (loadState).
//  - APT snapshots go to VERSIONED dirs (apt/v-<timestamp>/), never in place:
//    client_strings.js is loaded via dynamic import(), which Node caches by
//    URL. Each dir is a complete public/-shaped root (data/en/* +
//    data/item-drop.json + data/patrons.json + the generated *.index.bin) for
//    engine.ready()/reload().
//  - A snapshot is BILINGUAL when a localized set exists: data/de lives NEXT
//    TO data/en in the SAME versioned dir, never instead of it —
//    engine.ready() writes __aptEnv.BASE_URL process-wide, and the load path
//    reads data/en/client_strings.js even in a localized run
//    (assets/data/index.ts, CLIENT_STRINGS_REF). Every adoption CARRIES THE
//    EXISTING German set FORWARD (carryLangTree).
//
// Observability (nobody should have to look at the server to know it works):
// EXACTLY ONE log line per check, whatever its outcome — updated / unchanged /
// failed; three sources once a day = three lines a day, and silence means "not
// running". The detailed REJECTED/could-not-be-applied warnings carry the
// reason on top of it. The last SUCCESSFUL check per source is persisted in
// state.json and handed out via status(); a source that missed several ticks
// becomes a status-line note (server.mjs `data-status`, frontend/shell.js).
// The REASON of the last failure is persisted with it, plus its CLASS
// (check-failure.mjs; docs/bugs.md B24). The class is set at
// the site that knows, never derived from the wording; an unclassified failure
// stays `unknown` and the status line then offers no advice at all.

import { readFile, writeFile, mkdir, rename, readdir, rm, copyFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { UPSTREAM_BASE as APT_UPSTREAM_BASE, FILES as APT_FILES, diffLines } from './apt-data-update.mjs'
import { buildIndexBins } from './apt-index.mjs'
import { buildBaseNames as realBuildBaseNames, URLS as SEED_URLS } from './base-names-gen.mjs'
import {
  generate as realGenerateLangData,
  resolvePatchVersion as realResolvePatchVersion,
  generatorVersion as realGeneratorVersion,
  buildFingerprint, buildRunSummary, BUILD_INFO_FILE
} from './lang-data-gen.mjs'
import { DEFAULT_MAX_COVERAGE_LOSS_RATIO } from './lang-derive.mjs'
import {
  FAIL_KIND, failure, kindOf, isFailKind, cleanReason, REASON_MAX_CHARS_DEFAULT
} from './check-failure.mjs'
import { TEXT_PAIRS_FILE } from './mod-text-pairs.mjs'
import { configuredLanguages } from './user-langs.mjs'
import { withConsumer, CONSUMER } from './trade-audit.mjs'
import { jsonErrorSummary } from './json-error.mjs'
import { moveAside } from './store-file.mjs'
import { AGENT_BASE } from './version.mjs'

export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000 // one look per day

// How many missed ticks make a source "stale" in the UI. Derived from the
// configured interval (staleAfterMs = intervalMs * staleTicks), never an
// absolute number: with the default 24h interval that is three days — a single
// failed check (upstream hiccup, brief outage) stays quiet.
export const DEFAULT_STALE_TICKS = 3

// How long the manual "check now" trigger stays shut after a run. The reasoning
// for the number, the floor and the guard itself is at the
// POE_DATA_CHECK_NOW_COOLDOWN_MS row in numeric-settings.mjs, which is where
// the value in force comes from.
export const DEFAULT_CHECK_NOW_COOLDOWN_MS = 5 * 60 * 1000

// The localized data set is generated as a POST STEP of the apt job (see
// runJob), never on a timer of its own — but it keeps its own key so its state
// stays a row of its own in status()/the UI.
export const LANG_JOB = 'langData'

// Human labels for the log/status of each job key.
export const SOURCE_LABELS = { apt: 'apt', baseNames: 'base-names', [LANG_JOB]: 'lang-data' }

// The jobs that own a timer. LANG_JOB is not one of them on purpose.
const SCHEDULED_JOBS = ['apt', 'baseNames']

// First check shortly after boot (a restart right after a league patch must
// help immediately, not in 24h), delayed so startup never waits on it, and
// staggered so the sources never fire at once. The 24h interval then
// inherits the stagger.
const DEFAULT_INITIAL_DELAYS_MS = {
  apt: 2 * 60 * 1000,
  baseNames: 7 * 60 * 1000,
}

// Tool name and version (version.mjs), then the purpose.
const UA = `${AGENT_BASE} (data refresher, personal LAN tool)`

// A refreshed file must not shrink dramatically: upstream data only ever
// grows or gets trimmed lightly. Anything below this ratio of the previous
// size is treated as a truncated/broken download and rejected.
const MIN_KEEP_RATIO = 0.9
// Namespaces the net-worth bridge relies on — a snapshot missing one of them
// is broken (see apt-data-update.test.mjs, the schema guard this mirrors).
const REQUIRED_NAMESPACES = ['CAPTURED_BEAST', 'DIVINATION_CARD', 'GEM', 'ITEM', 'UNIQUE']

// The two languages a snapshot can carry. `en` comes from upstream and is
// always there; `de` is generated locally and only present once a generator
// run has produced one (until then every snapshot is English-only and nothing
// below changes behaviour).
export const LANG_EN = 'en'
export const LANG_DE = 'de'

// Source files of a localized set. app_i18n.json is deliberately NOT one of
// them: it belongs to APT's Vue overlay (renderer/src/web/i18n.ts), never
// appears in the bundled parser, and is only mirrored for `en` because the
// upstream refresh copies the whole English set. Demanding it for a locally
// generated language would be a made-up requirement.
export const LANG_FILES = ['items.ndjson', 'stats.ndjson', 'client_strings.js']

// Files a localized set may carry beyond the three it needs: its provenance
// (BUILD_INFO_FILE, read back by the Soll/Ist comparison below) and the
// target->English line pairs of the repair path. Carried when present, never
// demanded — a set generated before they existed must still count as complete.
export const LANG_EXTRA_FILES = [BUILD_INFO_FILE, TEXT_PAIRS_FILE]

// How many drifted client_strings keys are NAMED in the report (the count is
// always exact). A handful is what a real drift looks like — upstream adds a key
// or two per patch — and the list ends up in a log line and on an admin page, so
// it is bounded rather than left to the size of a foreign file.
export const MAX_DRIFT_KEYS_REPORTED = 25

// The generated per-language search indices (apt-index.mjs) and the two aux
// files that sit in the root of a public/-shaped snapshot.
const INDEX_BINS = ['stats-ref', 'stats-matcher', 'items-name', 'items-ref'].map(b => `${b}.index.bin`)
const AUX_FILES = ['item-drop.json', 'patrons.json']

// The three outcomes of a check. Every tick returns one of these; runJob turns
// it into exactly one log line and into the persisted check state.
//
// A FAILED carries its CLASS as well as its reason. The default is `unknown`,
// which is not a placeholder to be filled in later but the honest answer
// wherever the failing code cannot say which of the classes it is — the status
// line shows the reason and stays silent about the remedy.
//
// A WARNING is the third thing a check can have to say, and it is orthogonal to
// the outcome: the check did what it was supposed to do AND saw something the
// operator has to know. The case it was added for is the pinned patch version —
// a tick that builds from POE_PATCH_VERSION succeeds every day, reports
// `unchanged`, ages nothing, and is exactly as green the morning after the next
// patch as it was before it. Nothing in `updated`/`unchanged`/`failed` has a
// place for "this worked and is drifting", so a check that has one says so and
// the status line prints it whether or not anything is stale.
const UPDATED = (detail, warning = null) => ({ outcome: 'updated', detail, warning })
const UNCHANGED = (detail, warning = null) => ({ outcome: 'unchanged', detail, warning })
const FAILED = (reason, kind = FAIL_KIND.UNKNOWN, warning = null) =>
  ({ outcome: 'failed', reason, kind, warning })

const iso = ts => (ts ? new Date(ts).toISOString() : null)

const dirUrl = p => {
  const href = pathToFileURL(p).href
  return href.endsWith('/') ? href : href + '/'
}

/**
 * createDataRefresher(opts) -> {
 *   init(), start(handlers), stop(), status(),
 *   publicDir(), publicDataUrl(), activeLanguages(), generatedLanguages(),
 *   itemsNdjsonPath(lang), statsNdjsonPath(lang), textPairsPath(lang),
 *   baseNamesPath(),
 *   tickApt(), tickBaseNames()   // exposed for tests
 * }
 *
 * `vendored` are the baked-in fallbacks: { publicDir (…/renderer/public),
 * baseNamesPath }. After init() the active pointers are
 * either those or the validated persisted copies under `dir`.
 *
 * tickApt() also runs the localized generation as its post step, so a test
 * drives both through it — there is no separate entry point, by design.
 *
 * start(handlers) begins the background schedule; handlers make an adopted
 * update effective in the RUNNING process:
 *   onAptData({ publicDataUrl, previousPublicDataUrl, enDir, itemsNdjsonPath,
 *               languages })
 *     — throw to veto (the refresher then discards the snapshot and keeps
 *       the old state; the server uses this to roll back a failed engine
 *       reload). Called for an adopted UPSTREAM snapshot and for a
 *       regenerated localized one alike — both are complete new snapshots.
 *   onBaseNames({ path })
 *   onCheck(status)  — called after EVERY check with the fresh status()
 *       payload, so the server can push it to connected clients.
 *
 * status() -> { enabled, intervalMs, staleAfterMs, now, sources: [
 *   { source, key, lastSuccessAt, lastCheckAt, lastOutcome, lastReason,
 *     lastFailKind, updatedAt } ] }
 * `lastReason`/`lastFailKind` describe the LAST check and are null unless it
 * failed (check-failure.mjs for the classes).
 * `lastSuccessAt` is null when no check has succeeded yet since `since`
 * (first init of the /config dir) — consumers age against that fallback.
 */
export function createDataRefresher ({
  dir = '/config/data-refresh',
  intervalMs = DEFAULT_INTERVAL_MS,
  staleTicks = DEFAULT_STALE_TICKS,
  initialDelaysMs = DEFAULT_INITIAL_DELAYS_MS,
  vendored,
  // Which languages this installation has to serve. Read from the same
  // configuration the server routes users by (user-langs.mjs); everything
  // beyond English is a set that has to be GENERATED, because there is no
  // upstream for it. An English-only install never enters that path at all.
  languages = configuredLanguages(),
  // How much of the coverage the live localized set already has may fall away in
  // one regeneration before the run is refused (lang-derive.mjs, validate()).
  // Read from POE_LANG_MAX_COVERAGE_LOSS_RATIO by server.mjs and handed down:
  // the generator sits below numeric-settings.mjs in the import graph and must
  // not read the environment itself.
  langMaxLossRatio = DEFAULT_MAX_COVERAGE_LOSS_RATIO,
  // How much of a failure reason is persisted and handed to the browser
  // (POE_DATA_STATUS_REASON_MAX, read by server.mjs and passed down for the
  // same reason langMaxLossRatio is: this module sits below numeric-settings.mjs
  // in the import graph and must not read the environment itself).
  reasonMaxChars = REASON_MAX_CHARS_DEFAULT,
  // How long checkNow() refuses after a run (POE_DATA_CHECK_NOW_COOLDOWN_MS,
  // handed down by server.mjs like the two above).
  checkNowCooldownMs = DEFAULT_CHECK_NOW_COOLDOWN_MS,
  fetchImpl = fetch,
  buildBaseNames = realBuildBaseNames,
  generateLangData = realGenerateLangData,
  // Which derivation the localized sets have to have been built by: a hash over
  // the generator's own files (lang-data-gen.mjs), null when one is missing.
  // Injectable so a test can stand for a release that changed them.
  generatorVersion = realGeneratorVersion,
  resolvePatch = realResolvePatchVersion,
  timers = { setTimeout, clearTimeout },
  now = () => Date.now(),
  log = console,
  // Test seams only, for state.json at boot: how it is read (a permission
  // error without chmod or root) and how a broken one is moved aside.
  readStateImpl = readFile,
  stateRenameImpl = rename
} = {}) {
  if (!vendored?.publicDir || !vendored?.baseNamesPath) {
    throw new Error('createDataRefresher: vendored { publicDir, baseNamesPath } is required')
  }

  const STATE_PATH = path.join(dir, 'state.json')
  const APT_DIR = path.join(dir, 'apt')
  const BASE_NAMES_PATH = path.join(dir, 'base-names.json')
  // Scratch dir of the generator's game-data export. In /config on purpose:
  // pathofexile-dat caches ~32 MiB of bundles in <cwd>/.cache and clears it
  // itself when the patch changes, so a volume turns a per-RUN download into a
  // per-patch one — and a container recreate does not re-download it.
  const LANG_WORK_DIR = path.join(dir, 'lang-work')

  // Languages whose data set has to be produced here. At most one in practice
  // (`de`), but nothing below assumes that — the pipeline is parameterised by
  // language, which is the whole point of it.
  //
  // Not a constant, because the caller only knows the full set AFTER init():
  // which languages the active snapshot carries is an answer init() produces,
  // and a language that is in the snapshot is selectable in the browser, so it
  // has to be kept up to date whether or not anybody is configured for it right
  // now. `setLanguages()` below is how the server hands that wider set over —
  // before start(), which is where these are first read.
  let genLangs = [...new Set(languages)].filter(l => l && l !== LANG_EN)

  let writable = false
  let state = {}
  let handlers = {}
  const active = {
    publicDir: vendored.publicDir,
    baseNamesPath: vendored.baseNamesPath
  }
  const busy = { apt: false, baseNames: false }
  const timeoutByJob = new Map()
  // Languages the active snapshot carries; recomputed on init and after every
  // adoption. The server reads this to decide which engine instances can come
  // up (see activeLanguages()).
  let activeLangs = [LANG_EN]

  // --- small helpers --------------------------------------------------------

  async function readJsonIfPresent (p) {
    try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
  }

  /**
   * Reads state.json at boot, like every other /config store reads its file
   * (store-file.mjs, docs/bugs.md B31). Returns the state, or null for "do not
   * run": the file is there but cannot be read, or is broken and cannot be
   * moved aside. The auto-update then stays off, because its first save would
   * write over a file this process never saw.
   *
   *   missing          {} without a word (the normal first start)
   *   not JSON, or     moved to state.json.broken-<timestamp> with one warning,
   *   not an object    and {}: the image's baked-in data until the next check
   *                    adopts a snapshot again
   */
  async function loadState () {
    const emptyMeans = 'starting with an empty state: the image\'s baked-in data stays live until the next check fetches the sources again'
    let raw
    try {
      raw = await readStateImpl(STATE_PATH, 'utf8')
    } catch (e) {
      if (e?.code === 'ENOENT') return {}
      log.warn(`[data-refresh] could not read ${STATE_PATH} (${e?.code || e?.message}) — data auto-update off and not writing over it, using the baked-in data; fix or remove it and restart`)
      return null
    }
    let reason = null
    try {
      const doc = JSON.parse(raw)
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc
      throw new Error('not a JSON object')
    } catch (e) {
      reason = jsonErrorSummary(e)
    }
    try {
      const to = await moveAside(STATE_PATH, { label: 'broken', now, renameImpl: stateRenameImpl })
      log.warn(`[data-refresh] ${STATE_PATH} is not usable (${reason}) — moved to ${to}; ${emptyMeans}`)
      return {}
    } catch (e) {
      log.warn(`[data-refresh] ${STATE_PATH} is not usable (${reason}) and could not be moved aside (${e?.code || e?.message}) — data auto-update off and leaving the file untouched, using the baked-in data; fix or remove it and restart`)
      return null
    }
  }

  async function saveState () {
    const tmp = STATE_PATH + '.tmp'
    await writeFile(tmp, JSON.stringify(state, null, 2))
    await rename(tmp, STATE_PATH)
  }

  // Atomic single-file write (tmp + rename) so a crash mid-write can never
  // leave a half file at the path the next boot reads.
  async function writeAtomic (p, content) {
    const tmp = p + '.tmp'
    await writeFile(tmp, content)
    await rename(tmp, p)
  }

  /**
   * Conditional GET. Returns { changed: false, cond } on 304, otherwise
   * { changed: true, text, cond } with the response's validators. Any
   * non-ok/ network error throws — the caller's tick wrapper logs and keeps
   * the previous state.
   *
   * Both throws are tagged `unreachable`: an upstream that answers 5xx and one
   * that does not answer at all are the same thing to whoever reads the status
   * line — nothing to do here, the next check tries again.
   */
  async function conditionalFetch (url, cond = {}) {
    const headers = { 'User-Agent': UA }
    if (cond?.etag) headers['If-None-Match'] = cond.etag
    if (cond?.lastModified) headers['If-Modified-Since'] = cond.lastModified
    let res
    try {
      res = await fetchImpl(url, { headers })
    } catch (e) {
      throw failure(`${url} could not be fetched (${e?.message || e})`, FAIL_KIND.UNREACHABLE)
    }
    if (res.status === 304) return { changed: false, cond }
    if (!res.ok) throw failure(`fetch failed (${res.status}) ${url}`, FAIL_KIND.UNREACHABLE)
    const text = await res.text()
    return {
      changed: true,
      text,
      cond: {
        etag: res.headers?.get?.('etag') || undefined,
        lastModified: res.headers?.get?.('last-modified') || undefined
      }
    }
  }

  // --- validation (the gate in front of EVERY adoption) ---------------------

  function validateItemsNdjson (text, oldLineCount) {
    const lines = String(text).split('\n').filter(Boolean)
    if (oldLineCount > 0 && lines.length < Math.floor(oldLineCount * MIN_KEEP_RATIO)) {
      return `items.ndjson shrank implausibly (${oldLineCount} -> ${lines.length} lines)`
    }
    const namespaces = new Set()
    let anyTradeTag = false; let anyExchangeable = false; let anyCraftCat = false; let anyUniqueBase = false
    for (const line of lines) {
      let e
      try { e = JSON.parse(line) } catch { return 'items.ndjson: unparsable line' }
      // The join fields of the net-worth bridge (normalize.mjs / kinds.mjs).
      if (typeof e.refName !== 'string' || typeof e.namespace !== 'string') {
        return 'items.ndjson: entry without refName/namespace'
      }
      namespaces.add(e.namespace)
      if (e.tradeTag != null) anyTradeTag = true
      if (e.exchangeable) anyExchangeable = true
      if (e.craftable?.category) anyCraftCat = true
      if (e.unique?.base) anyUniqueBase = true
    }
    for (const ns of REQUIRED_NAMESPACES) {
      if (!namespaces.has(ns)) return `items.ndjson: namespace ${ns} missing`
    }
    if (!anyTradeTag || !anyExchangeable || !anyCraftCat || !anyUniqueBase) {
      return 'items.ndjson: a net-worth join field (tradeTag/exchangeable/craftable.category/unique.base) is gone'
    }
    return null
  }

  function validateStatsNdjson (text, oldLineCount) {
    const lines = String(text).split('\n').filter(Boolean)
    if (oldLineCount > 0 && lines.length < Math.floor(oldLineCount * MIN_KEEP_RATIO)) {
      return `stats.ndjson shrank implausibly (${oldLineCount} -> ${lines.length} lines)`
    }
    for (const line of lines) {
      let e
      try { e = JSON.parse(line) } catch { return 'stats.ndjson: unparsable line' }
      const stats = e.stats ? e.stats : [e]
      for (const s of stats) {
        if (typeof s.ref !== 'string' || !Array.isArray(s.matchers)) {
          return 'stats.ndjson: stat without ref/matchers'
        }
      }
    }
    return null
  }

  // client_strings.js is executable JS (`export default {...}`) — read it the
  // same way the engine will: import it from a temp path inside our dir, where
  // the {"type":"module"} marker applies.
  //
  // Node caches dynamic imports by URL, so the temp name has to be unique per
  // read — and NOT by the clock alone: `now()` is injectable and a frozen one
  // would hand back the first file's module for every later read.
  let importSeq = 0
  async function importClientStrings (text) {
    const tmp = path.join(dir, `.client-strings-${now()}-${process.pid}-${++importSeq}.js`)
    try {
      await writeFile(tmp, text)
      const mod = await import(pathToFileURL(tmp).href)
      const cs = mod?.default
      if (!cs || typeof cs !== 'object') return { error: 'no default object export' }
      return { strings: cs }
    } catch (e) {
      return { error: `not importable (${e?.message || e})` }
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  async function validateClientStrings (text) {
    const { strings, error } = await importClientStrings(text)
    if (error) return `client_strings.js: ${error}`
    if (typeof strings.RARITY_UNIQUE !== 'string' || Object.keys(strings).length < 20) {
      return 'client_strings.js: shape looks wrong (RARITY_UNIQUE / key count)'
    }
    return null
  }

  /**
   * DRIFT BETWEEN THE DISPLAY-TEXT TABLES, at the moment the English one is
   * adopted.
   *
   * The English client_strings.js is refreshed from upstream every day; the
   * localized ones are hand written and ship with the IMAGE, so they only ever
   * change with a container update. When upstream adds a key, the localized file
   * does not have it — and if the parser reads that key, the failure lands on a
   * German user as an unexplained parse error, with nothing in the tool naming
   * the cause (docs/bugs.md B24).
   *
   * WHAT IS CLAIMED HERE IS ONLY WHAT IS KNOWN: which keys the two sets do not
   * share. Whether the parser reads a given key is not something this side can
   * see, so the report says "may" and never predicts a failure.
   *
   * Compared against the file in the IMAGE, because that is where a localized
   * client_strings.js comes from in both paths (a generation run copies it from
   * there, and a carried set carries what an earlier run copied).
   */
  async function clientStringDrift (enText) {
    if (!genLangs.length) return null
    const en = await importClientStrings(enText)
    if (en.error) return null // the validation above already refused this snapshot
    const enKeys = new Set(Object.keys(en.strings))
    const langs = {}
    for (const lang of genLangs) {
      const file = path.join(vendored.publicDir, 'data', lang, 'client_strings.js')
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text == null) continue // no localized file shipped for this language
      const tg = await importClientStrings(text)
      if (tg.error) { langs[lang] = { unreadable: tg.error }; continue }
      const tgKeys = new Set(Object.keys(tg.strings))
      const missing = [...enKeys].filter(k => !tgKeys.has(k))
      const extra = [...tgKeys].filter(k => !enKeys.has(k))
      langs[lang] = {
        enKeys: enKeys.size,
        langKeys: tgKeys.size,
        missing: missing.slice(0, MAX_DRIFT_KEYS_REPORTED),
        missingCount: missing.length,
        extra: extra.slice(0, MAX_DRIFT_KEYS_REPORTED),
        extraCount: extra.length
      }
    }
    return Object.keys(langs).length ? { at: now(), langs } : null
  }

  /**
   * The same comparison, made against the ENGLISH SET THAT IS LIVE, and stored.
   *
   * Called at boot, and that is the point of it: the report says "closing this
   * needs a container update", so after that update it has to reflect the
   * container's English set, not wait until upstream moves the English file
   * again (only the branch that adopts a NEW snapshot would compare otherwise).
   *
   * A boot is exactly when the answer can have changed without upstream doing
   * anything: the localized files come out of the image, and a new image is a
   * new set of them.
   *
   * Nothing here reaches the network — both sides are files on disk.
   */
  async function refreshClientStringDrift () {
    const enFile = path.join(active.publicDir, 'data', LANG_EN, 'client_strings.js')
    const enText = await readFile(enFile, 'utf8').catch(() => null)
    // No configured language to compare against, or no English file to compare
    // with: whatever is stored describes a question nobody is asking any more.
    if (!genLangs.length || enText == null) {
      if (state.clientStrings) { state.clientStrings = null; await saveState().catch(() => {}) }
      return null
    }
    const drift = await clientStringDrift(enText).catch(() => null)
    state.clientStrings = drift
    await saveState().catch(() => {})
    return drift
  }

  function validateBaseNames (names, oldCount) {
    if (!names || typeof names !== 'object' || Array.isArray(names)) return 'base-names: not an object'
    const entries = Object.entries(names)
    if (oldCount > 0 && entries.length < Math.floor(oldCount * MIN_KEEP_RATIO)) {
      return `base-names shrank implausibly (${oldCount} -> ${entries.length} entries)`
    }
    if (entries.length === 0) return 'base-names: empty'
    for (const [id, name] of entries) {
      if (typeof name !== 'string' || !id.startsWith('Metadata/')) return 'base-names: malformed entry'
    }
    return null
  }

  // --- boot (writability, state, adopting what /config already holds) --------

  // Light boot-time check of a persisted APT snapshot dir: is every file the
  // engine needs there and non-empty? A snapshot can be half-written — the
  // container was killed mid-update, or the volume ran full — and adopting such
  // a dir fails much later and much less obviously, at the first lookup that
  // misses. Cheap enough to run on every boot (a handful of stat() calls) and
  // deliberately NOT a content check: validation of what a file says is the
  // update path's job, this only answers "is the set complete?".
  async function allNonEmpty (paths) {
    try {
      for (const f of paths) {
        const s = await stat(f)
        if (!s.isFile() || s.size === 0) return false
      }
      return true
    } catch { return false }
  }

  // Is data/<lang> a COMPLETE set — its source files plus all four generated
  // indices? Used both for the boot check and to decide whether there is a
  // localized tree worth carrying into the next snapshot.
  function langComplete (root, lang, files) {
    return allNonEmpty([...files, ...INDEX_BINS].map(f => path.join(root, 'data', lang, f)))
  }

  // `requireDe` is CONDITIONAL on purpose: demanded exactly when the persisted
  // state says the snapshot was adopted WITH a German set. Making it
  // unconditional would make the first boot after this update throw away every
  // existing English-only snapshot; leaving it out entirely would let a
  // half-written German tree pass as complete. Both are wrong, this is the
  // narrow middle.
  async function aptDirComplete (versionDir, { requireDe = false } = {}) {
    if (!(await langComplete(versionDir, LANG_EN, APT_FILES))) return false
    if (!(await allNonEmpty(AUX_FILES.map(f => path.join(versionDir, 'data', f))))) return false
    if (requireDe && !(await langComplete(versionDir, LANG_DE, LANG_FILES))) return false
    return true
  }

  // Which languages the ACTIVE snapshot really serves. English is a given (the
  // engine cannot come up without it); German is whatever is on disk.
  async function refreshActiveLangs () {
    activeLangs = (await langComplete(active.publicDir, LANG_DE, LANG_FILES))
      ? [LANG_EN, LANG_DE]
      : [LANG_EN]
  }

  /**
   * Every persisted sentence through the filter again, on the way OUT.
   *
   * The promise "nothing that reaches the browser is unfiltered and unbounded"
   * was held on the WRITE path only, and a write path is not where a state file
   * comes from. `/config/data-refresh/state.json` outlives the build that wrote
   * it: it may have been written before the filter existed, before the cap
   * existed, or by a build whose cap was set higher than this one's. Reading it
   * back and handing it to the status line unfiltered would make the promise
   * true only for a container that has never been updated.
   *
   * Idempotent, so a sentence that was already filtered is unchanged by this
   * (check-failure.mjs states that and its test holds it).
   */
  function refilterPersistedText () {
    if (!state.checks || typeof state.checks !== 'object') return
    const checks = {}
    for (const [job, c] of Object.entries(state.checks)) {
      if (!c || typeof c !== 'object') continue
      checks[job] = {
        ...c,
        lastReason: cleanReason(c.lastReason, { maxChars: reasonMaxChars }) || null,
        lastWarning: cleanReason(c.lastWarning, { maxChars: reasonMaxChars }) || null,
        // A class from a newer or older build that this one does not know is
        // dropped rather than passed on: the page maps a class to a sentence,
        // and a value it cannot map is either a missing key or an invented
        // remedy. `unknown` is what "nobody classified this" already means.
        lastFailKind: isFailKind(c.lastFailKind) ? c.lastFailKind : null
      }
    }
    state.checks = checks
  }

  // Boot, in three steps: probe whether `dir` is writable at all (a local run
  // without a /config volume simply keeps the baked-in data instead of throwing
  // every tick), load the persisted state, and then prefer what /config already
  // holds over the baked-in copies — otherwise every deploy would throw away
  // the updates the previous container fetched. Nothing here reaches the
  // network; the first real check is scheduled afterwards.
  async function init () {
    try {
      await mkdir(APT_DIR, { recursive: true })
      // {"type":"module"} marker so client_strings.js (ESM syntax, .js
      // extension) is importable from below this dir — outside /app there is
      // no package.json, and Node would otherwise parse it as CommonJS.
      await writeAtomic(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
      writable = true
    } catch (e) {
      writable = false
      log.warn(`[data-refresh] ${dir} not writable (${e?.code || e}) — data auto-update off, using the baked-in data. For local runs set POE_DATA_REFRESH_DIR to a writable path.`)
      await refreshActiveLangs()
      return
    }

    const loaded = await loadState()
    if (!loaded) {
      writable = false
      await refreshActiveLangs()
      return
    }
    state = loaded
    refilterPersistedText()
    // First time this /config dir is used: remember when. A source that has
    // never been checked successfully is aged against this instead of against
    // the process start, so restarts cannot hide a source that never works.
    if (!state.since) { state.since = now(); await saveState().catch(() => {}) }

    // Prefer what /config holds — otherwise every update would die with the
    // next deploy. Each artifact is validated before it wins over the
    // baked-in copy; invalid -> warn once, fall back, and let the next tick
    // re-fetch a good version.
    if (state.apt?.version) {
      const versionDir = path.join(APT_DIR, state.apt.version)
      const requireDe = (state.apt.langs || []).includes(LANG_DE)
      if (await aptDirComplete(versionDir, { requireDe })) {
        active.publicDir = versionDir
      } else {
        log.warn(`[data-refresh] persisted APT snapshot ${state.apt.version} is incomplete${requireDe ? ' (it was adopted with a German set)' : ''} — using the baked-in data (a fresh check runs shortly)`)
        state.apt = {}
      }
    }
    await refreshActiveLangs()

    const bn = await readJsonIfPresent(BASE_NAMES_PATH)
    if (bn) {
      const bad = validateBaseNames(bn, 0)
      if (!bad) active.baseNamesPath = BASE_NAMES_PATH
      else log.warn(`[data-refresh] persisted base-names.json rejected (${bad}) — using the baked-in copy`)
    }

    // Last, because it reads the snapshot the two steps above just decided on.
    await refreshClientStringDrift()
  }

  // --- source 1: APT item/stat data -----------------------------------------

  /**
   * Copies a LOCALIZED set from one snapshot root into another.
   *
   * There is no upstream for it: the German set is generated locally, so the
   * only place a data/de tree can come from is the snapshot that is active
   * right now. Carrying it into every new snapshot is therefore not an
   * optimisation but the thing that makes "English may run ahead, German stays
   * on its last good state" possible at all — pruneAptVersions keeps only the
   * active snapshot and its predecessor, so a tree that is not carried is
   * deleted after the SECOND adoption, and the German engine loses its data
   * root at the next reload.
   *
   * The *.index.bin are rebuilt from the carried ndjson rather than copied
   * (apt-index.mjs: FNV-1a over UTF-8, offsets in UTF-16 code units — both
   * language-agnostic, the file header's "English snapshot only" describes the
   * previous USE, not a limitation). That way the tree in the new snapshot is
   * self-consistent even if the source lost or never had its indices.
   *
   * Returns true when a set was carried, false when there is none to carry.
   * Throws only on a source that exists but cannot be read/parsed.
   *
   * `files`/`extras` make it usable for the ENGLISH tree too (APT_FILES, no
   * extras): the localized generation below builds a fresh snapshot out of the
   * active one and needs exactly this — copy the sources, rebuild the indices.
   */
  async function carryLangTree (srcRoot, dstRoot, lang, { files = LANG_FILES, extras = LANG_EXTRA_FILES } = {}) {
    const srcDir = path.join(srcRoot, 'data', lang)
    const content = {}
    for (const f of files) {
      content[f] = await readFile(path.join(srcDir, f), 'utf8').catch(() => null)
    }
    const present = files.filter(f => content[f] != null)
    if (!present.length) return false // no localized set at all — the normal case today
    // A LONE client_strings.js is not half a set either: it is hand written and
    // ships with the image for every supported language, whether or not a
    // generated set exists yet. Calling that "incomplete" would put a warning
    // under every single adoption of a fresh German install.
    if (present.length === 1 && present[0] === 'client_strings.js') return false
    if (present.length !== files.length) {
      throw new Error(`data/${lang} is incomplete (has ${present.join(', ')})`)
    }

    const bins = buildIndexBins({ itemsNdjson: content['items.ndjson'], statsNdjson: content['stats.ndjson'] })
    const dstDir = path.join(dstRoot, 'data', lang)
    await mkdir(dstDir, { recursive: true })
    for (const f of files) await writeFile(path.join(dstDir, f), content[f])
    // Optional extras ride along when they are there. build-info.json is the
    // one that matters: lose it and the next tick has no idea what the carried
    // set was built from, so it would regenerate a perfectly current one.
    for (const f of extras) {
      const text = await readFile(path.join(srcDir, f), 'utf8').catch(() => null)
      if (text != null) await writeFile(path.join(dstDir, f), text)
    }
    for (const [name, arr] of Object.entries(bins)) {
      await writeFile(path.join(dstDir, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
    }
    return true
  }

  async function tickApt () {
    const conds = state.apt?.conditional || {}
    const results = {}
    let anyChanged = false
    for (const f of APT_FILES) {
      results[f] = await conditionalFetch(`${APT_UPSTREAM_BASE}/${f}`, conds[f])
      if (results[f].changed) anyChanged = true
    }
    if (!anyChanged) return UNCHANGED('upstream reported no change (304)') // quiet day — not a byte moved

    // Candidate = fetched where changed, current active content where not.
    const content = {}
    const oldContent = {}
    for (const f of APT_FILES) {
      oldContent[f] = await readFile(path.join(active.publicDir, 'data', LANG_EN, f), 'utf8').catch(() => '')
      content[f] = results[f].changed ? results[f].text : oldContent[f]
    }

    // First check after a deploy: no stored validators yet, so upstream
    // answers 200 even when nothing really changed. Identical content is not
    // an update — just store the validators so tomorrow is a 304 day.
    if (APT_FILES.every(f => content[f] === oldContent[f])) {
      const newConds = {}
      for (const f of APT_FILES) newConds[f] = results[f].changed ? results[f].cond : conds[f]
      state.apt = { ...state.apt, conditional: newConds }
      await saveState()
      return UNCHANGED('upstream answered, content identical')
    }

    // Validate BEFORE adopting anything.
    const oldItemLines = oldContent['items.ndjson'].split('\n').filter(Boolean).length
    const oldStatLines = oldContent['stats.ndjson'].split('\n').filter(Boolean).length
    const bad =
      validateItemsNdjson(content['items.ndjson'], oldItemLines) ||
      validateStatsNdjson(content['stats.ndjson'], oldStatLines) ||
      (await validateClientStrings(content['client_strings.js'])) ||
      (() => { try { JSON.parse(content['app_i18n.json']); return null } catch { return 'app_i18n.json: not valid JSON' } })()
    if (bad) {
      log.warn(`[data-refresh] APT snapshot REJECTED (${bad}) — keeping the current data`)
      return FAILED(`snapshot rejected (${bad})`, FAIL_KIND.REJECTED)
    }

    // Search indices — MUST match the adopted ndjson (assets/data reads the
    // files through these offsets).
    const bins = buildIndexBins({ itemsNdjson: content['items.ndjson'], statsNdjson: content['stats.ndjson'] })

    // Write a complete versioned public/ root, tmp-first, rename when whole.
    const version = 'v-' + new Date(now()).toISOString().replace(/[:.]/g, '-')
    const tmpDir = path.join(APT_DIR, `tmp-${version}`)
    const versionDir = path.join(APT_DIR, version)
    const enDir = path.join(versionDir, 'data', LANG_EN)
    let carriedDe = false
    try {
      await mkdir(path.join(tmpDir, 'data', LANG_EN), { recursive: true })
      for (const f of APT_FILES) await writeFile(path.join(tmpDir, 'data', LANG_EN, f), content[f])
      for (const [name, arr] of Object.entries(bins)) {
        await writeFile(path.join(tmpDir, 'data', LANG_EN, name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
      }
      // Aux files the engine loads from the public root; they are not part of
      // the upstream refresh, carry them over from the active snapshot.
      for (const aux of AUX_FILES) {
        await copyFile(path.join(active.publicDir, 'data', aux), path.join(tmpDir, 'data', aux))
      }
      // Same pattern, one level up: the locally generated German set has no
      // upstream, so it rides along with every English adoption.
      try {
        carriedDe = await carryLangTree(active.publicDir, tmpDir, LANG_DE)
      } catch (e) {
        // A German set that exists but is broken must not cost the English
        // users their update. It does not pass silently either: the new
        // snapshot is English-only, so a LIVE German parser fails its reload
        // and vetoes the whole adoption in onAptData.
        log.warn(`[data-refresh] the German set could not be carried into ${version} (${e?.message || e}) — the new snapshot is English-only`)
      }
      await rename(tmpDir, versionDir)
    } catch (e) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      throw e
    }
    const newLangs = carriedDe ? [LANG_EN, LANG_DE] : [LANG_EN]

    // Hand over to the server (engine reload + index swap). A throw here is a
    // veto: discard the new snapshot, keep state as it was.
    const previousDir = active.publicDir
    try {
      await handlers.onAptData?.({
        publicDataUrl: dirUrl(versionDir),
        previousPublicDataUrl: dirUrl(previousDir),
        enDir,
        itemsNdjsonPath: path.join(enDir, 'items.ndjson'),
        // Which languages the NEW snapshot serves. The server compares this
        // against its live engine instances before it reloads them, so a
        // missing set is a named error instead of an ENOENT deep in the
        // engine's data loader.
        languages: newLangs
      })
    } catch (e) {
      log.warn(`[data-refresh] APT snapshot ${version} could not be applied (${e?.message || e}) — previous data stays live, snapshot discarded`)
      await rm(versionDir, { recursive: true, force: true }).catch(() => {})
      // The snapshot arrived and was refused on this side (the engine reload
      // vetoed it) — not something a later tick fixes by itself.
      return FAILED(`snapshot ${version} could not be applied (${e?.message || e})`, FAIL_KIND.REJECTED)
    }

    active.publicDir = versionDir
    activeLangs = newLangs
    const newConds = {}
    for (const f of APT_FILES) newConds[f] = results[f].cond
    const previousVersion = state.apt?.version
    // `langs` is what the boot check reads back: it demands data/de exactly
    // when the snapshot was adopted with one.
    state.apt = { version, conditional: newConds, updatedAt: now(), langs: newLangs }
    await saveState()
    await pruneAptVersions([version, previousVersion].filter(Boolean))

    // The scope of the change, for the one outcome line runJob writes: which
    // files, how many lines, from when to when.
    const parts = []
    for (const f of APT_FILES) {
      if (content[f] === oldContent[f]) continue // a 200 with identical body is not a change
      const d = diffLines(oldContent[f], content[f])
      parts.push(`${f} ${d.before}->${d.after} lines (+${d.added.length}/-${d.removed.length})`)
    }
    const fromTo = `${conds['items.ndjson']?.lastModified || 'baked-in'} -> ${newConds['items.ndjson']?.lastModified || new Date(now()).toISOString()}`
    const langNote = carriedDe ? '; German set carried over unchanged' : ''

    // The display-text tables of the two languages, compared at the moment the
    // English one changes. Not a gate — a snapshot is never refused over it, the
    // English users have nothing to do with it — but it must not be silent: the
    // localized file ships with the image and cannot follow upstream by itself.
    const drift = await clientStringDrift(content['client_strings.js'])
    let driftNote = ''
    if (drift) {
      state.clientStrings = drift
      await saveState().catch(() => {})
      for (const [lang, d] of Object.entries(drift.langs)) {
        if (d.unreadable) {
          log.warn(`[data-refresh] data/${lang}/client_strings.js in the image could not be read (${d.unreadable}) — the display texts of the two languages were not compared`)
          continue
        }
        if (!d.missingCount && !d.extraCount) continue
        const named = d.missing.length ? ` (${d.missing.join(', ')}${d.missingCount > d.missing.length ? ', …' : ''})` : ''
        log.warn(
          `[data-refresh] client_strings drift: the new English set has ${d.missingCount} key(s) data/${lang} does not${named}` +
          (d.extraCount ? `, and ${d.extraCount} that English no longer has (${d.extra.join(', ')})` : '') +
          ' — any of them the parser reads is missing for that language. They are hand written and ship with the image, ' +
          'so closing this needs a container update, not a data refresh.')
      }
      const worst = Object.entries(drift.langs).find(([, d]) => d.missingCount > 0)
      if (worst) driftNote = `; client_strings: data/${worst[0]} lacks ${worst[1].missingCount} key(s) the new English set has`
    }
    return UPDATED(`APT data updated (${version}): ${parts.join(', ')}; upstream ${fromTo}${langNote}${driftNote}`)
  }

  // Keep the active snapshot + its predecessor (instant rollback material),
  // drop everything older plus stranded tmp dirs. Scoped strictly to our own
  // apt/ dir.
  async function pruneAptVersions (keep) {
    let names = []
    try { names = await readdir(APT_DIR) } catch { return }
    for (const name of names) {
      if (keep.includes(name)) continue
      if (!name.startsWith('v-') && !name.startsWith('tmp-')) continue
      await rm(path.join(APT_DIR, name), { recursive: true, force: true }).catch(() => {})
    }
  }

  // --- source 3: the LOCALIZED data set (generated, no upstream) ------------
  //
  // THE TRIGGER IS A SOLL/IST COMPARISON, NOT AN EVENT. The localized set
  // records what it was built from — the patch version, the identity of the
  // English snapshot AND the generator version (build-info.json, written next
  // to the data). Every tick recomputes all three and compares; a difference
  // means "generate", equality means "nothing to do".
  //
  // Why a level and not an edge, because this is the easy thing to get wrong:
  // after a generation run that FAILED, the next tick of an event-driven
  // trigger would find "patch unchanged, no new English adoption", report
  // `unchanged` — and runJob would carry `lastSuccessAt` forward, because only
  // `failed` is excluded from it. The source would never go stale and the skew
  // would stay invisible forever. With the comparison the difference simply
  // stands: every tick either retries or reports `failed`. No new outcome code
  // is needed for that, `FAILED` already excludes lastSuccessAt.
  //
  // THE SKEW POLICY: English comes from upstream and is adopted immediately,
  // even when the localized set cannot follow — English users do not lose
  // currency over a language they do not use. The localized set catches up on
  // the next generation run; until then the old tree stays live (carryLangTree)
  // and this source's own row says what is going on.

  /**
   * The English side of the comparison: the content the derivation would read.
   * Deliberately NOT the snapshot dir's name — generating writes a new dir, so
   * a name would differ from itself the moment it was recorded.
   */
  async function englishFingerprint (root) {
    const enDir = path.join(root, 'data', LANG_EN)
    return buildFingerprint(
      await readFile(path.join(enDir, 'items.ndjson'), 'utf8'),
      await readFile(path.join(enDir, 'stats.ndjson'), 'utf8')
    )
  }

  /** Which configured languages are out of date, and in one word why. */
  async function staleLangs (root, patch, enFingerprint, generator) {
    const out = []
    for (const lang of genLangs) {
      const complete = await langComplete(root, lang, LANG_FILES)
      const info = complete
        ? await readJsonIfPresent(path.join(root, 'data', lang, BUILD_INFO_FILE))
        : null
      if (!complete) out.push({ lang, why: 'no set yet' })
      else if (!info) out.push({ lang, why: 'no build-info — unknown provenance' })
      else if (info.patch !== patch) out.push({ lang, why: `patch ${info.patch ?? 'unknown'} -> ${patch}` })
      else if (info.enFingerprint !== enFingerprint) out.push({ lang, why: 'the English snapshot moved on' })
      // A set built before the field existed has `undefined` here and is
      // rebuilt once, like one without build-info. An unknown CURRENT version
      // (null) is recorded as null, so it matches itself on the next tick.
      else if ((info.generator ?? null) !== generator || !('generator' in info)) {
        out.push({ lang, why: `generator version ${info.generator ?? 'unknown'} -> ${generator ?? 'unknown'}` })
      }
    }
    return out
  }

  async function tickLangData () {
    // Soll, part one. Without the patch there is no comparison at all, so a
    // lookup that fails is a failed CHECK — not a quiet one. That is the point:
    // an installation whose only way of knowing the current patch has gone away
    // can no longer keep the localized set current, and it should say so.
    const { patch, source: patchSource, pinned, lookedUp, mismatch } = await resolvePatch({ fetchImpl })
    // A pin that disagrees with the lookup is the one thing a SUCCESSFUL tick
    // has to report. It travels on every outcome below, because a frozen set is
    // exactly as frozen when the check says `unchanged` as when it says
    // `failed` — and `unchanged` is the outcome it produces every single day.
    // runTick() puts it in the log — one place for every job, so a warning
    // cannot be logged twice by one tick or forgotten by another.
    const warning = mismatch || null
    // Soll, part two.
    const enFingerprint = await englishFingerprint(active.publicDir)
    // Soll, part three: which derivation this image carries.
    const generator = (await generatorVersion()) ?? null
    // Ist.
    const stale = await staleLangs(active.publicDir, patch, enFingerprint, generator)
    if (!stale.length) {
      const from = pinned
        ? `pinned patch ${patch} (POE_PATCH_VERSION${lookedUp ? `; the lookup reports ${lookedUp}` : '; the lookup did not answer'})`
        : `patch ${patch}`
      return UNCHANGED(`data/${genLangs.join(', data/')} built from ${from} and the current English snapshot, generator version ${generator ?? 'unknown'}`, warning)
    }

    // A generated set has to end up in a snapshot dir that also holds data/en
    // (one process-wide BASE_URL, and the localized load path reads
    // data/en/client_strings.js) — so a run produces a COMPLETE new snapshot:
    // the active English tree byte for byte, the aux files, and every localized
    // tree, freshly built where stale and carried where current.
    // Same naming as an upstream adoption, but a suffix if that name is taken:
    // this tick may follow an English adoption made in the very same
    // millisecond, and renaming onto an existing dir would fail.
    let version = 'v-' + new Date(now()).toISOString().replace(/[:.]/g, '-')
    for (let n = 2; existsSync(path.join(APT_DIR, version)); n++) {
      version = `v-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${n}`
    }
    const tmpDir = path.join(APT_DIR, `tmp-${version}`)
    const versionDir = path.join(APT_DIR, version)
    const built = []
    try {
      if (!(await carryLangTree(active.publicDir, tmpDir, LANG_EN, { files: APT_FILES, extras: [] }))) {
        throw new Error(`the active snapshot has no data/${LANG_EN} to build from`)
      }
      for (const aux of AUX_FILES) {
        await copyFile(path.join(active.publicDir, 'data', aux), path.join(tmpDir, 'data', aux))
      }
      for (const lang of genLangs) {
        const todo = stale.find(s => s.lang === lang)
        if (!todo) { await carryLangTree(active.publicDir, tmpDir, lang); continue }
        const outDir = path.join(tmpDir, 'data', lang)
        await mkdir(outDir, { recursive: true })
        // client_strings.js is hand written and checked in; the generator
        // refuses to touch it. It comes from the IMAGE, not from the previous
        // snapshot, so a fix shipped with a container update takes effect.
        await copyFile(
          path.join(vendored.publicDir, 'data', lang, 'client_strings.js'),
          path.join(outDir, 'client_strings.js')
        )
        // Validation, tmp-and-rename and the coverage report all live in the
        // generator; a run whose validation fails writes nothing and throws.
        const run = await generateLangData({
          lang,
          patch,
          // Where the version came from travels with it. A CDN that refuses
          // every file means "wait" for a version the lookup produced and
          // "look at the pin" for one somebody typed in, and the export cannot
          // tell those apart on its own (classifyExportFailure).
          patchSource,
          skeleton: path.join(tmpDir, 'data', LANG_EN),
          out: outDir,
          // The set this run REPLACES, and the reason it has to be named: the
          // generator's default baseline is its own output dir, which here is a
          // fresh snapshot holding nothing but client_strings.js. Without this
          // every regeneration would look like a first build, and the check
          // that asks "did the derivation lose what it already had" would have
          // nothing to ask it of.
          previous: path.join(active.publicDir, 'data', lang),
          maxLossRatio: langMaxLossRatio,
          work: LANG_WORK_DIR
        })
        if (!(await langComplete(tmpDir, lang, LANG_FILES))) {
          throw new Error(`the generator left data/${lang} incomplete`)
        }
        // Provenance written by the side that did the COMPARING, over the
        // generator's own copy. Not redundancy for its own sake — it is what
        // makes the level logic terminate: the next tick has to read back
        // exactly the values THIS run was triggered by (patch, English
        // fingerprint, generator version), otherwise a successful
        // run could still look stale and the comparison would regenerate
        // forever.
        await writeFile(path.join(outDir, BUILD_INFO_FILE), JSON.stringify({
          lang,
          patch,
          enFingerprint,
          generator,
          builtAt: new Date(now()).toISOString(),
          // The run's own numbers, in the generator's shape (buildRunSummary):
          // when, from which patch, how much carries a matcher, what was lost and
          // what is newly missing — the admin area reads this file back, so "does
          // this still run" stops being a question only the log can answer.
          run: buildRunSummary(run)
        }, null, 2) + '\n')
        // How complete the set that just went live actually is, in the line the
        // admin area shows for this source. A set is allowed to carry refs it
        // has no matcher for (that beats keeping a set that does not carry them
        // at all — see validate()), but "allowed" must not mean "unsaid": this
        // is where an operator sees the coverage move without opening the
        // container log. The continuous view of the same distance is the skew
        // report, lang-skew.mjs.
        const c = run?.result?.counts
        built.push(c
          ? `${lang} (${todo.why}; ${c.covered} of ${c.statsEn} stats carry a matcher, ${c.uncovered} do not)`
          : `${lang} (${todo.why})`)
      }
      await rename(tmpDir, versionDir)
    } catch (e) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      log.warn(`[data-refresh] generating data/${stale.map(s => s.lang).join(', data/')} FAILED (${e?.message || e}) — the previous localized set stays live`)
      // The class comes from wherever the throw happened — the patch lookup, the
      // game-data export, the derivation's own validation — and is `unknown`
      // when none of them said. Nothing is inferred from the message here.
      return FAILED(`generating data/${stale.map(s => s.lang).join(', data/')} failed (${e?.message || e})`, kindOf(e), warning)
    }

    const newLangs = [LANG_EN, ...genLangs]
    const previousDir = active.publicDir
    try {
      await handlers.onAptData?.({
        publicDataUrl: dirUrl(versionDir),
        previousPublicDataUrl: dirUrl(previousDir),
        enDir: path.join(versionDir, 'data', LANG_EN),
        itemsNdjsonPath: path.join(versionDir, 'data', LANG_EN, 'items.ndjson'),
        languages: newLangs
      })
    } catch (e) {
      log.warn(`[data-refresh] the regenerated snapshot ${version} could not be applied (${e?.message || e}) — previous data stays live, snapshot discarded`)
      await rm(versionDir, { recursive: true, force: true }).catch(() => {})
      return FAILED(`snapshot ${version} could not be applied (${e?.message || e})`, FAIL_KIND.REJECTED, warning)
    }

    active.publicDir = versionDir
    activeLangs = newLangs
    const previousVersion = state.apt?.version
    // The English half of state.apt is untouched on purpose: its validators
    // still describe the upstream fetch, and `updatedAt` is the age of the
    // ENGLISH data, which this run did not change.
    state.apt = { ...state.apt, version, langs: newLangs }
    state[LANG_JOB] = { updatedAt: now(), patch, enFingerprint, generator, version }
    await saveState()
    await pruneAptVersions([version, previousVersion].filter(Boolean))
    return UPDATED(`data/${built.join(', data/')} generated from patch ${patch} (${patchSource}) into ${version}`, warning)
  }

  // --- source 2: base-names.json (RePoE base_items) -------------------------

  async function tickBaseNames () {
    const r = await conditionalFetch(SEED_URLS.baseItems, state.baseNames?.conditional)
    if (!r.changed) return UNCHANGED('upstream reported no change (304)')

    let baseItems
    try { baseItems = JSON.parse(r.text) } catch {
      log.warn('[data-refresh] base_items.json REJECTED (not valid JSON) — keeping the current base-names')
      return FAILED('base_items.json rejected (not valid JSON)', FAIL_KIND.REJECTED)
    }
    const names = buildBaseNames(baseItems)
    const oldNames = (await readJsonIfPresent(active.baseNamesPath)) || {}
    const oldCount = Object.keys(oldNames).length
    // Identical result (typical first check after a deploy, no validators
    // stored yet) -> only remember the validators, no adoption, no log.
    if (JSON.stringify(names) === JSON.stringify(oldNames)) {
      state.baseNames = { ...state.baseNames, conditional: r.cond }
      await saveState()
      return UNCHANGED('upstream answered, map identical')
    }
    const bad = validateBaseNames(names, oldCount)
    if (bad) {
      log.warn(`[data-refresh] base-names REJECTED (${bad}) — keeping the current map`)
      return FAILED(`base-names rejected (${bad})`, FAIL_KIND.REJECTED)
    }

    await writeAtomic(BASE_NAMES_PATH, JSON.stringify(names, null, 0))
    await handlers.onBaseNames?.({ path: BASE_NAMES_PATH })
    active.baseNamesPath = BASE_NAMES_PATH
    state.baseNames = { conditional: r.cond, updatedAt: now() }
    await saveState()
    return UPDATED(`base-names.json updated: ${oldCount} -> ${Object.keys(names).length} entries (upstream ${r.cond.lastModified || 'no last-modified'})`)
  }

  // --- scheduling -----------------------------------------------------------

  const TICKS = { apt: tickApt, baseNames: tickBaseNames, [LANG_JOB]: tickLangData }

  // Sources that appear in status(). The localized one only exists once a
  // language beyond English is configured — an English-only install must not
  // grow a row that can never succeed and would age into a false stale note.
  const statusJobs = () => (genLangs.length ? [...SCHEDULED_JOBS, LANG_JOB] : [...SCHEDULED_JOBS])

  // Age of the data a source currently serves, for the "unchanged" line: an
  // adoption timestamp, or the baked-in copy if nothing was ever adopted.
  function dataAgeText (job) {
    const at = state[job]?.updatedAt
    return at ? `data from ${iso(at)}` : 'data as shipped'
  }

  /**
   * ONE line per check, whatever happened. `updated` and `unchanged` are
   * normal operation (log), `failed` is not (warn) — the rejection warnings
   * inside the ticks stay, they carry the detail, this one carries the
   * outcome. Also persists lastSuccessAt per source (the basis of the UI's
   * staleness note) and notifies onCheck.
   */
  async function runTick (job) {
    const label = SOURCE_LABELS[job] || job
    const prevSuccess = state.checks?.[job]?.lastSuccessAt
    let res
    try {
      // Tagged for the trade-audit bookkeeping, so refresher requests stay
      // attributable like every other consumer's. Tagging only — the schedule,
      // the pacing and the request count are unchanged.
      res = (await withConsumer(CONSUMER.DATA_REFRESHER, () => TICKS[job]())) || UNCHANGED('nothing to do')
    } catch (e) {
      res = FAILED(e?.message || String(e), kindOf(e))
    }
    if (res.outcome === 'updated') {
      log.log(`[data-refresh] ${label} check updated — ${res.detail}`)
    } else if (res.outcome === 'unchanged') {
      log.log(`[data-refresh] ${label} check unchanged — ${res.detail}; ${dataAgeText(job)}`)
    } else {
      log.warn(`[data-refresh] ${label} check failed (kept last good state): ${res.reason}; last success ${iso(prevSuccess) || 'none yet'}`)
    }
    if (res.warning) log.warn(`[data-refresh] ${label}: ${res.warning}`)
    const at = now()
    const failed = res.outcome === 'failed'
    state.checks = { ...state.checks }
    state.checks[job] = {
      lastCheckAt: at,
      lastOutcome: res.outcome,
      lastSuccessAt: failed ? (prevSuccess ?? null) : at,
      // The reason belongs to the LAST check, so a success clears it: a source
      // that is answering again must not keep a sentence on screen that
      // describes a state it is no longer in. The staleness note only appears
      // while the last successes are old anyway, and then the last check is the
      // failing one whose reason this is.
      lastReason: failed ? (cleanReason(res.reason, { maxChars: reasonMaxChars }) || null) : null,
      lastFailKind: failed ? (res.kind || FAIL_KIND.UNKNOWN) : null,
      // A warning belongs to the last check the same way, and is cleared the
      // same way — but it is NOT tied to the outcome: the whole reason it
      // exists is that a green check can have something to say. Through the
      // same filter as a reason, because it quotes the same foreign text.
      lastWarning: cleanReason(res.warning, { maxChars: reasonMaxChars }) || null
    }
    if (writable) await saveState().catch(() => {}) // a full disk must not kill the tick
    try { handlers.onCheck?.(status()) } catch { /* a consumer must never break the schedule */ }
    return res
  }

  async function runJob (job) {
    if (busy[job]) return // overlap guard, like the other refreshers
    busy[job] = true
    try {
      await runTick(job)
      // The localized set is generated INSIDE the apt job's critical section,
      // never beside it. The overlap guard is per job (busy[job]) and every
      // scheduled job has its own timer, so a second job would run CONCURRENTLY
      // with this one — and the generator reads the active snapshot while
      // pruneAptVersions is free to delete it underneath. As a post step it
      // inherits busy['apt'] and needs no second lock; its own status key keeps
      // it visible as a source of its own regardless.
      if (job === 'apt' && genLangs.length) await runTick(LANG_JOB)
    } finally {
      busy[job] = false
    }
  }

  // --- status (what the UI needs to spot a source that went quiet) ----------

  function staleAfterMs () { return intervalMs * staleTicks }

  function status () {
    return {
      enabled: writable,
      intervalMs,
      staleAfterMs: staleAfterMs(),
      // The floor the UI ages against while a source has never succeeded yet
      // (fresh /config: nothing is stale a minute after the first boot).
      since: state.since ?? null,
      now: now(),
      sources: statusJobs().map(job => ({
        key: job,
        source: SOURCE_LABELS[job] || job,
        lastSuccessAt: state.checks?.[job]?.lastSuccessAt ?? null,
        lastCheckAt: state.checks?.[job]?.lastCheckAt ?? null,
        lastOutcome: state.checks?.[job]?.lastOutcome ?? null,
        // Why the last check failed, and of which class — null whenever the
        // last check did not fail. Persisted, so a restart does not lose the
        // reason a source has been quiet for days (docs/bugs.md B24).
        lastReason: state.checks?.[job]?.lastReason ?? null,
        lastFailKind: isFailKind(state.checks?.[job]?.lastFailKind)
          ? state.checks[job].lastFailKind
          : null,
        // Something a SUCCESSFUL check has to say. Independent of the outcome
        // and of staleness, because the state it reports — a set that is frozen
        // on a pinned patch — produces neither.
        lastWarning: state.checks?.[job]?.lastWarning ?? null,
        updatedAt: state[job]?.updatedAt ?? null
      }))
    }
  }

  // --- the manual trigger ---------------------------------------------------

  // When the last manual run started. In memory on purpose: a restart is a
  // legitimate reset of it, and it costs far more than the run it would let
  // through, so persisting it would guard nothing anybody would bypass.
  let lastCheckNowAt = 0

  /**
   * Run every check NOW, for somebody who has just repaired something.
   *
   * THE HOLE THIS FILLS. Every remedy this tool offers — clear the pin, set the
   * pin, update the container — was followed by up to 24 hours of the same old
   * failure on screen, because the next scheduled tick is the only thing that
   * can change it. A stranger cannot tell "my fix did not work" from "my fix
   * has not been tried yet", and the second is what they would be looking at.
   *
   * TWO GUARDS, and they answer different questions:
   *
   *   busy       a check is running right now. Starting a second one would put
   *              the generator and pruneAptVersions in the same snapshot dir at
   *              the same time, which is what the per-job guard has always
   *              prevented. Answered as `running`, not as a refusal.
   *   cooldown   a check finished less than checkNowCooldownMs ago. One press
   *              costs a patch lookup, four conditional fetches and possibly a
   *              multi-megabyte CDN download; the person most likely to press
   *              it repeatedly is the person in the middle of a repair.
   *
   * Returns { ok, ran, running, retryAfterMs, status } — never throws, because
   * the caller is an HTTP handler and a stack trace is not an answer.
   */
  async function checkNow () {
    if (!writable) {
      return { ok: false, ran: false, reason: 'disabled', status: status() }
    }
    if (SCHEDULED_JOBS.some(j => busy[j])) {
      return { ok: false, ran: false, running: true, status: status() }
    }
    const since = now() - lastCheckNowAt
    if (lastCheckNowAt && since < checkNowCooldownMs) {
      return { ok: false, ran: false, retryAfterMs: checkNowCooldownMs - since, status: status() }
    }
    lastCheckNowAt = now()
    // Sequentially, and apt first: runJob('apt') runs the localized generation
    // as its post step, and it reads the snapshot the base-names job never
    // touches. Same order and same locks as the schedule — a manual trigger
    // must not be a second way of doing this.
    for (const job of SCHEDULED_JOBS) await runJob(job)
    // The clock starts when the run FINISHES, not when it started: a run that
    // took four minutes must not leave a one-minute cooldown behind it.
    lastCheckNowAt = now()
    return { ok: true, ran: true, status: status() }
  }

  function schedule (job, delayMs) {
    const t = timers.setTimeout(() => {
      runJob(job).finally(() => schedule(job, intervalMs))
    }, delayMs)
    t?.unref?.()
    timeoutByJob.set(job, t)
  }

  function start (h = {}) {
    handlers = h
    if (!writable) return // init already logged the one-time warning
    for (const job of SCHEDULED_JOBS) schedule(job, initialDelaysMs[job] ?? intervalMs)
    log.log(`[data-refresh] auto-update on (dir=${dir} interval=${intervalMs}ms, stale after ${staleTicks} missed ticks = ${staleAfterMs()}ms, first checks in ${SCHEDULED_JOBS.map(j => `${j}:${Math.round((initialDelaysMs[j] ?? intervalMs) / 1000)}s`).join(' ')}` +
      (genLangs.length ? `; data/${genLangs.join(', data/')} regenerated as part of the apt check` : '') + ')')
  }

  function stop () {
    for (const t of timeoutByJob.values()) timers.clearTimeout(t)
    timeoutByJob.clear()
  }

  return {
    init,
    start,
    stop,
    status,
    writable: () => writable,
    publicDir: () => active.publicDir,
    // undefined (not null) when the baked-in data is active, so callers can
    // splat it straight into engine.ready({ publicDataDir: ... }).
    publicDataUrl: () => (active.publicDir === vendored.publicDir ? undefined : dirUrl(active.publicDir)),
    // Languages the ACTIVE snapshot serves — ['en'] or ['en','de']. The server
    // brings up one engine instance per configured language and needs to know
    // whether the data for it is actually there.
    activeLanguages: () => [...activeLangs],
    // Languages this installation GENERATES a set for (everything configured
    // beyond English). Empty means the whole generation path is inert.
    generatedLanguages: () => [...genLangs],
    /**
     * Widen (or narrow) that set. Meant for exactly one call, from the server,
     * between init() and start(): the set of languages a user can be switched
     * to is only known once the snapshot has been read, and every language that
     * can be switched to has to be refreshed. Calling it after start() would
     * change what the NEXT tick generates, not what a running one does.
     */
    setLanguages: langs => {
      genLangs = [...new Set(langs || [])].filter(l => l && l !== LANG_EN)
      return [...genLangs]
    },
    itemsNdjsonPath: (lang = LANG_EN) => path.join(active.publicDir, 'data', lang, 'items.ndjson'),
    statsNdjsonPath: (lang = LANG_EN) => path.join(active.publicDir, 'data', lang, 'stats.ndjson'),
    // Where a localized set says what it was built FROM and what the run
    // measured — read by the admin area (server.mjs, /admin/gaps) out of the
    // snapshot that is really live, never out of a guessed one.
    buildInfoPath: lang => path.join(active.publicDir, 'data', lang, BUILD_INFO_FILE),
    // The last comparison of the display-text tables (clientStringDrift above),
    // or null while none has been made. Persisted, so it survives a restart and
    // is not lost with the log line that reported it — and recomputed at boot,
    // so following its advice (update the container) actually clears it.
    //
    // Filtered to the languages that are configured RIGHT NOW on the way out.
    // The stored object outlives a configuration change: a language that was
    // dropped from POE_USER_LANGS leaves an entry behind, and reporting drift
    // for a language nobody is served in is a finding about nothing.
    clientStringDrift: () => {
      const d = state.clientStrings
      if (!d?.langs) return null
      const langs = Object.fromEntries(
        Object.entries(d.langs).filter(([lang]) => genLangs.includes(lang)))
      return Object.keys(langs).length ? { ...d, langs } : null
    },
    // The repair path's de->en table, from the SAME snapshot the engine parses
    // with — a pair table from another snapshot would describe a data set that
    // is no longer live (mod-text-pairs.mjs).
    textPairsPath: (lang = LANG_EN) => path.join(active.publicDir, 'data', lang, TEXT_PAIRS_FILE),
    baseNamesPath: () => active.baseNamesPath,
    tickApt: () => runJob('apt'),
    tickBaseNames: () => runJob('baseNames'),
    // Every check at once, guarded — the admin area's "check now" (see above).
    checkNow,
    checkNowCooldownMs: () => checkNowCooldownMs
  }
}
