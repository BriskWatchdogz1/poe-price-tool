// Background auto-updater for the three vendored data sources that go stale
// with every league patch — WITHOUT anyone touching the server:
//
//  1. APT item/stat data  (renderer/public/data/en/*)     -> the price-check parser
//  2. base-names.json     (RePoE base_items.json)         -> the Faustus id->name bridge
//
// Modelled on the repo's other background refreshers (faustus-refresher.mjs,
// corpse-pricer.mjs): runs on its own, persists into /config, survives
// restarts, and on ANY problem keeps the last good state instead of wiping.
//
// Principles (see docs/admin.md "Data auto-update"):
//  - Conditional requests: ETag/Last-Modified are stored per source and sent
//    back — on days without an upstream change, no payload flows at all.
//  - Validate BEFORE adopt: a snapshot is parsed and schema-checked, its
//    search indices generated, and only then swapped in. A broken or
//    half-loaded download is rejected with a warning; the old data stays.
//  - Adopted snapshots live under POE_DATA_REFRESH_DIR (default
//    /config/data-refresh) and are preferred at the next boot, so an update
//    survives a container recreate. If the dir isn't writable (local run
//    without the volume), the whole feature silently disables — like the
//    other /config stores, it never throws per tick.
//  - APT snapshots are written to VERSIONED dirs (apt/v-<timestamp>/), never
//    in place: client_strings.js is loaded via dynamic import(), which Node
//    caches by URL — only a new path makes a runtime reload actually pick up
//    the new strings. Each dir is a complete public/-shaped root
//    (data/en/* + data/item-drop.json + data/patrons.json + the generated
//    *.index.bin), so engine.ready()/reload() can point straight at it.
//
// Observability (the point of this: nobody should ever have to look at the
// server to know the thing still works):
//  - EXACTLY ONE log line per check, whatever its outcome — updated /
//    unchanged / failed. Three sources once a day = three lines a day.
//    Silence now means "not running", not "nothing to do".
//  - The timestamp of the last SUCCESSFUL check per source is persisted in
//    state.json and handed out via status(); the UI turns a source that has
//    missed several ticks into a status-line note (see server.mjs
//    `data-status` and frontend/shell.js).
// The detailed REJECTED/could-not-be-applied warnings stay on top of that
// line — they carry the reason, the outcome line carries the outcome.

import { readFile, writeFile, mkdir, rename, readdir, rm, copyFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { UPSTREAM_BASE as APT_UPSTREAM_BASE, FILES as APT_FILES, diffLines } from './apt-data-update.mjs'
import { buildIndexBins } from './apt-index.mjs'
import { buildBaseNames as realBuildBaseNames, URLS as SEED_URLS } from './base-names-gen.mjs'
import { withConsumer, CONSUMER } from './trade-audit.mjs'

export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000 // one look per day

// How many missed ticks make a source "stale" in the UI. Derived from the
// configured interval (staleAfterMs = intervalMs * staleTicks), never an
// absolute number: with the default 24h interval that is three days — a single
// failed check (upstream hiccup, brief outage) stays quiet.
export const DEFAULT_STALE_TICKS = 3

// Human labels for the log/status of each job key.
export const SOURCE_LABELS = { apt: 'apt', baseNames: 'base-names' }

// First check shortly after boot (a restart right after a league patch must
// help immediately, not in 24h), delayed so startup never waits on it, and
// staggered so the sources never fire at once. The 24h interval then
// inherits the stagger.
const DEFAULT_INITIAL_DELAYS_MS = {
  apt: 2 * 60 * 1000,
  baseNames: 7 * 60 * 1000,
}

const UA = 'poe-price-tool/0.1 (data refresher, personal LAN tool)'

// A refreshed file must not shrink dramatically: upstream data only ever
// grows or gets trimmed lightly. Anything below this ratio of the previous
// size is treated as a truncated/broken download and rejected.
const MIN_KEEP_RATIO = 0.9
// Namespaces the net-worth bridge relies on — a snapshot missing one of them
// is broken (see apt-data-update.test.mjs, the schema guard this mirrors).
const REQUIRED_NAMESPACES = ['CAPTURED_BEAST', 'DIVINATION_CARD', 'GEM', 'ITEM', 'UNIQUE']

// The three outcomes of a check. Every tick returns one of these; runJob turns
// it into exactly one log line and into the persisted check state.
const UPDATED = detail => ({ outcome: 'updated', detail })
const UNCHANGED = detail => ({ outcome: 'unchanged', detail })
const FAILED = reason => ({ outcome: 'failed', reason })

const iso = ts => (ts ? new Date(ts).toISOString() : null)

const dirUrl = p => {
  const href = pathToFileURL(p).href
  return href.endsWith('/') ? href : href + '/'
}

/**
 * createDataRefresher(opts) -> {
 *   init(), start(handlers), stop(), status(),
 *   publicDir(), publicDataUrl(), itemsNdjsonPath(), statsNdjsonPath(),
 *   baseNamesPath(),
 *   tickApt(), tickBaseNames()   // exposed for tests
 * }
 *
 * `vendored` are the baked-in fallbacks: { publicDir (…/renderer/public),
 * baseNamesPath }. After init() the active pointers are
 * either those or the validated persisted copies under `dir`.
 *
 * start(handlers) begins the background schedule; handlers make an adopted
 * update effective in the RUNNING process:
 *   onAptData({ publicDataUrl, previousPublicDataUrl, enDir, itemsNdjsonPath })
 *     — throw to veto (the refresher then discards the snapshot and keeps
 *       the old state; the server uses this to roll back a failed engine
 *       reload).
 *   onBaseNames({ path })
 *   onCheck(status)  — called after EVERY check with the fresh status()
 *       payload, so the server can push it to connected clients.
 *
 * status() -> { enabled, intervalMs, staleAfterMs, now, sources: [
 *   { source, key, lastSuccessAt, lastOutcome, updatedAt } ] }
 * `lastSuccessAt` is null when no check has succeeded yet since `since`
 * (first init of the /config dir) — consumers age against that fallback.
 */
export function createDataRefresher ({
  dir = '/config/data-refresh',
  intervalMs = DEFAULT_INTERVAL_MS,
  staleTicks = DEFAULT_STALE_TICKS,
  initialDelaysMs = DEFAULT_INITIAL_DELAYS_MS,
  vendored,
  fetchImpl = fetch,
  buildBaseNames = realBuildBaseNames,
  timers = { setTimeout, clearTimeout },
  now = () => Date.now(),
  log = console
} = {}) {
  if (!vendored?.publicDir || !vendored?.baseNamesPath) {
    throw new Error('createDataRefresher: vendored { publicDir, baseNamesPath } is required')
  }

  const STATE_PATH = path.join(dir, 'state.json')
  const APT_DIR = path.join(dir, 'apt')
  const BASE_NAMES_PATH = path.join(dir, 'base-names.json')

  let writable = false
  let state = {}
  let handlers = {}
  const active = {
    publicDir: vendored.publicDir,
    baseNamesPath: vendored.baseNamesPath
  }
  const busy = { apt: false, baseNames: false }
  const timeoutByJob = new Map()

  // --- small helpers --------------------------------------------------------

  async function readJsonIfPresent (p) {
    try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
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
   */
  async function conditionalFetch (url, cond = {}) {
    const headers = { 'User-Agent': UA }
    if (cond?.etag) headers['If-None-Match'] = cond.etag
    if (cond?.lastModified) headers['If-Modified-Since'] = cond.lastModified
    const res = await fetchImpl(url, { headers })
    if (res.status === 304) return { changed: false, cond }
    if (!res.ok) throw new Error(`fetch failed (${res.status}) ${url}`)
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

  // client_strings.js is executable JS (`export default {...}`) — validate it
  // the same way the engine will consume it: import it (from a temp path
  // inside our dir, where the {"type":"module"} marker applies) and check the
  // shape. Node caches dynamic imports by URL, so the temp name is unique.
  async function validateClientStrings (text) {
    const tmp = path.join(dir, `.validate-client-strings-${now()}.js`)
    try {
      await writeFile(tmp, text)
      const mod = await import(pathToFileURL(tmp).href)
      const cs = mod?.default
      if (!cs || typeof cs !== 'object') return 'client_strings.js: no default object export'
      if (typeof cs.RARITY_UNIQUE !== 'string' || Object.keys(cs).length < 20) {
        return 'client_strings.js: shape looks wrong (RARITY_UNIQUE / key count)'
      }
      return null
    } catch (e) {
      return `client_strings.js: not importable (${e?.message || e})`
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
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


  async function aptDirComplete (versionDir) {
    const needed = [
      ...APT_FILES.map(f => path.join(versionDir, 'data/en', f)),
      ...['stats-ref', 'stats-matcher', 'items-name', 'items-ref'].map(b => path.join(versionDir, 'data/en', `${b}.index.bin`)),
      path.join(versionDir, 'data/item-drop.json'),
      path.join(versionDir, 'data/patrons.json')
    ]
    try {
      for (const f of needed) {
        const s = await stat(f)
        if (!s.isFile() || s.size === 0) return false
      }
      return true
    } catch { return false }
  }

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
      return
    }

    state = (await readJsonIfPresent(STATE_PATH)) || {}
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
      if (await aptDirComplete(versionDir)) {
        active.publicDir = versionDir
      } else {
        log.warn(`[data-refresh] persisted APT snapshot ${state.apt.version} is incomplete — using the baked-in data (a fresh check runs shortly)`)
        state.apt = {}
      }
    }

    const bn = await readJsonIfPresent(BASE_NAMES_PATH)
    if (bn) {
      const bad = validateBaseNames(bn, 0)
      if (!bad) active.baseNamesPath = BASE_NAMES_PATH
      else log.warn(`[data-refresh] persisted base-names.json rejected (${bad}) — using the baked-in copy`)
    }
  }

  // --- source 1: APT item/stat data -----------------------------------------

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
      oldContent[f] = await readFile(path.join(active.publicDir, 'data/en', f), 'utf8').catch(() => '')
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
      return FAILED(`snapshot rejected (${bad})`)
    }

    // Search indices — MUST match the adopted ndjson (assets/data reads the
    // files through these offsets).
    const bins = buildIndexBins({ itemsNdjson: content['items.ndjson'], statsNdjson: content['stats.ndjson'] })

    // Write a complete versioned public/ root, tmp-first, rename when whole.
    const version = 'v-' + new Date(now()).toISOString().replace(/[:.]/g, '-')
    const tmpDir = path.join(APT_DIR, `tmp-${version}`)
    const versionDir = path.join(APT_DIR, version)
    const enDir = path.join(versionDir, 'data/en')
    try {
      await mkdir(path.join(tmpDir, 'data/en'), { recursive: true })
      for (const f of APT_FILES) await writeFile(path.join(tmpDir, 'data/en', f), content[f])
      for (const [name, arr] of Object.entries(bins)) {
        await writeFile(path.join(tmpDir, 'data/en', name), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
      }
      // Aux files the engine loads from the public root; they are not part of
      // the upstream refresh, carry them over from the active snapshot.
      for (const aux of ['item-drop.json', 'patrons.json']) {
        await copyFile(path.join(active.publicDir, 'data', aux), path.join(tmpDir, 'data', aux))
      }
      await rename(tmpDir, versionDir)
    } catch (e) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      throw e
    }

    // Hand over to the server (engine reload + index swap). A throw here is a
    // veto: discard the new snapshot, keep state as it was.
    const previousDir = active.publicDir
    try {
      await handlers.onAptData?.({
        publicDataUrl: dirUrl(versionDir),
        previousPublicDataUrl: dirUrl(previousDir),
        enDir,
        itemsNdjsonPath: path.join(enDir, 'items.ndjson')
      })
    } catch (e) {
      log.warn(`[data-refresh] APT snapshot ${version} could not be applied (${e?.message || e}) — previous data stays live, snapshot discarded`)
      await rm(versionDir, { recursive: true, force: true }).catch(() => {})
      return FAILED(`snapshot ${version} could not be applied (${e?.message || e})`)
    }

    active.publicDir = versionDir
    const newConds = {}
    for (const f of APT_FILES) newConds[f] = results[f].cond
    const previousVersion = state.apt?.version
    state.apt = { version, conditional: newConds, updatedAt: now() }
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
    return UPDATED(`APT data updated (${version}): ${parts.join(', ')}; upstream ${fromTo}`)
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

  // --- source 2: base-names.json (RePoE base_items) -------------------------

  async function tickBaseNames () {
    const r = await conditionalFetch(SEED_URLS.baseItems, state.baseNames?.conditional)
    if (!r.changed) return UNCHANGED('upstream reported no change (304)')

    let baseItems
    try { baseItems = JSON.parse(r.text) } catch {
      log.warn('[data-refresh] base_items.json REJECTED (not valid JSON) — keeping the current base-names')
      return FAILED('base_items.json rejected (not valid JSON)')
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
      return FAILED(`base-names rejected (${bad})`)
    }

    await writeAtomic(BASE_NAMES_PATH, JSON.stringify(names, null, 0))
    await handlers.onBaseNames?.({ path: BASE_NAMES_PATH })
    active.baseNamesPath = BASE_NAMES_PATH
    state.baseNames = { conditional: r.cond, updatedAt: now() }
    await saveState()
    return UPDATED(`base-names.json updated: ${oldCount} -> ${Object.keys(names).length} entries (upstream ${r.cond.lastModified || 'no last-modified'})`)
  }

  // --- scheduling -----------------------------------------------------------

  const TICKS = { apt: tickApt, baseNames: tickBaseNames }

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
  async function runJob (job) {
    if (busy[job]) return // overlap guard, like the other refreshers
    busy[job] = true
    const label = SOURCE_LABELS[job] || job
    const prevSuccess = state.checks?.[job]?.lastSuccessAt
    let res
    try {
      // Tagged for the trade-audit bookkeeping, so refresher requests stay
      // attributable like every other consumer's. Tagging only — the schedule,
      // the pacing and the request count are unchanged.
      res = (await withConsumer(CONSUMER.DATA_REFRESHER, () => TICKS[job]())) || UNCHANGED('nothing to do')
    } catch (e) {
      res = FAILED(e?.message || String(e))
    }
    try {
      if (res.outcome === 'updated') {
        log.log(`[data-refresh] ${label} check updated — ${res.detail}`)
      } else if (res.outcome === 'unchanged') {
        log.log(`[data-refresh] ${label} check unchanged — ${res.detail}; ${dataAgeText(job)}`)
      } else {
        log.warn(`[data-refresh] ${label} check failed (kept last good state): ${res.reason}; last success ${iso(prevSuccess) || 'none yet'}`)
      }
      const at = now()
      state.checks = { ...state.checks }
      state.checks[job] = {
        lastCheckAt: at,
        lastOutcome: res.outcome,
        lastSuccessAt: res.outcome === 'failed' ? (prevSuccess ?? null) : at
      }
      if (writable) await saveState().catch(() => {}) // a full disk must not kill the tick
      try { handlers.onCheck?.(status()) } catch { /* a consumer must never break the schedule */ }
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
      sources: Object.keys(TICKS).map(job => ({
        key: job,
        source: SOURCE_LABELS[job] || job,
        lastSuccessAt: state.checks?.[job]?.lastSuccessAt ?? null,
        lastCheckAt: state.checks?.[job]?.lastCheckAt ?? null,
        lastOutcome: state.checks?.[job]?.lastOutcome ?? null,
        updatedAt: state[job]?.updatedAt ?? null
      }))
    }
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
    for (const job of Object.keys(TICKS)) schedule(job, initialDelaysMs[job] ?? intervalMs)
    log.log(`[data-refresh] auto-update on (dir=${dir} interval=${intervalMs}ms, stale after ${staleTicks} missed ticks = ${staleAfterMs()}ms, first checks in ${Object.keys(TICKS).map(j => `${j}:${Math.round((initialDelaysMs[j] ?? intervalMs) / 1000)}s`).join(' ')})`)
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
    itemsNdjsonPath: () => path.join(active.publicDir, 'data/en/items.ndjson'),
    statsNdjsonPath: () => path.join(active.publicDir, 'data/en/stats.ndjson'),
    baseNamesPath: () => active.baseNamesPath,
    tickApt: () => runJob('apt'),
    tickBaseNames: () => runJob('baseNames')
  }
}
