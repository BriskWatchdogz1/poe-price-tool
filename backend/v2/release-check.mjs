// Asks GitHub for the latest release of this tool and remembers the answer, so
// the browser can say when a newer one exists. It only reports; nothing is
// downloaded or installed. Design: docs/superpowers/specs/2026-11-02-release-check-design.md
//
// The failure classes of check-failure.mjs are used here with a meaning of
// their own, not the data refresher's: `unreachable` is a network error, a
// timeout or a 5xx; `rejected` is GitHub answering and refusing (403/429, in
// practice its rate limit); `incompatible` is an answer that could not be read
// (not JSON, no tag, a tag that is not a version number). Nothing here is
// fixed by a container update, so the advice the UI attaches differs too.
//
// Shape of createDataRefresher on purpose: fetch, clock and log are injected,
// the state lives in one atomically written file, and on ANY failure the last
// good answer stays (a 404 means "no release" and clears it). One log line per check. This module never touches the
// network on its own; the suite reaches it only with a fetch double.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { FAIL_KIND, failure, kindOf, isFailKind, cleanReason } from './check-failure.mjs'
import { USER_AGENT } from './version.mjs'

/** What GitHub answered. Exactly one per check. */
export const OUTCOME = Object.freeze({ OK: 'ok', NONE: 'none', UNCHANGED: 'unchanged', FAILED: 'failed' })

/** Latest release against the installed version, derived on every read. */
export const COMPARISON = Object.freeze({ NEWER: 'newer', CURRENT: 'current', UNKNOWN: 'unknown' })

export const DEFAULT_REPO = 'BriskWatchdogz1/poe-price-tool'
// One request a day is a courtesy rule towards GitHub's unauthenticated API,
// not a knob.
export const INTERVAL_MS = 86_400_000
export const INITIAL_DELAY_MS = 600_000
export const CHECK_NOW_COOLDOWN_MS = 60_000
export const REQUEST_TIMEOUT_MS = 10_000

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/
const OUTCOMES = new Set(Object.values(OUTCOME))

/** `1.2.3` / `v1.2.3` -> numbers; everything else (pre-releases, 4 parts, garbage) is not a version. */
export function parseVersion (s) {
  if (typeof s !== 'string') return null
  const m = VERSION_RE.exec(s)
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null
}

/** `unknown` when either side is not a version; `current` for equal or lower. */
export function compareVersions (latest, installed) {
  const a = parseVersion(latest)
  const b = parseVersion(installed)
  if (!a || !b) return COMPARISON.UNKNOWN
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] > b[k] ? COMPARISON.NEWER : COMPARISON.CURRENT
  }
  return COMPARISON.CURRENT
}

const normalVersion = tag => { const v = parseVersion(tag); return v ? `${v.major}.${v.minor}.${v.patch}` : null }
const str = v => (typeof v === 'string' && v ? v : null)
const num = v => (Number.isFinite(v) ? v : null)

// A stored release is trusted only as far as it still parses; anything else is
// "no release known" rather than a crash or a made-up version.
function cleanLatest (l) {
  const version = normalVersion(l?.version)
  if (!version) return null
  return { version, tag: str(l.tag) ?? `v${version}`, url: str(l.url), publishedAt: str(l.publishedAt), name: str(l.name) }
}

export function createReleaseCheck ({
  repo = DEFAULT_REPO,
  installedVersion = null,
  statePath,
  userAgent = USER_AGENT,
  fetchImpl = fetch,
  now = () => Date.now(),
  log = console,
  onCheck = () => {},
  isDisabled = () => false,
  timers = { setTimeout, clearTimeout }
} = {}) {
  if (!statePath) throw new Error('createReleaseCheck: statePath is required')

  let state = {}
  let busy = false // a check is in flight; the tick and the manual check both respect it
  let timer = null
  let stopped = true // start() clears it; a tick that ends after stop() must not book another
  let lastCheckNowEndedAt = null

  function emptyState () { return { since: now(), latest: null, etag: null } }

  async function init () {
    state = emptyState()
    let raw
    try {
      raw = await readFile(statePath, 'utf8')
    } catch (e) {
      if (e?.code !== 'ENOENT') log.warn(`[release-check] state file ${statePath} could not be read (${e?.code || e}) — starting empty`)
      return
    }
    try {
      const s = JSON.parse(raw)
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('not an object')
      state = {
        since: num(s.since) ?? state.since,
        lastCheckAt: num(s.lastCheckAt),
        nextCheckAt: num(s.nextCheckAt),
        lastOutcome: OUTCOMES.has(s.lastOutcome) ? s.lastOutcome : null,
        lastFailKind: isFailKind(s.lastFailKind) ? s.lastFailKind : null,
        lastReason: cleanReason(s.lastReason) || null,
        etag: str(s.etag),
        latest: cleanLatest(s.latest)
      }
      // An ETag without a release to go with it would make GitHub answer 304 for
      // ever: "unchanged" against a copy this process no longer has.
      if (!state.latest) state.etag = null
    } catch (e) {
      log.warn(`[release-check] state file ${statePath} is not usable (${e?.message || e}) — starting empty`)
    }
  }

  async function save () {
    try {
      await mkdir(path.dirname(statePath), { recursive: true })
      const tmp = statePath + '.tmp'
      await writeFile(tmp, JSON.stringify(state, null, 2))
      await rename(tmp, statePath)
    } catch (e) {
      log.warn(`[release-check] state could not be saved (${e?.code || e?.message || e}) — the result is kept in memory only`)
    }
  }

  function status () {
    const latest = state.latest ?? null
    return {
      enabled: !isDisabled(),
      installed: installedVersion ?? null,
      repo,
      lastCheckAt: state.lastCheckAt ?? null,
      nextCheckAt: state.nextCheckAt ?? null,
      lastOutcome: state.lastOutcome ?? null,
      lastFailKind: state.lastFailKind ?? null,
      lastReason: state.lastReason ?? null,
      latest,
      comparison: compareVersions(latest?.version, installedVersion),
      cooldownMs: CHECK_NOW_COOLDOWN_MS
    }
  }

  // One request. Returns { outcome, latest?, etag? } or throws failure(...).
  async function ask () {
    const url = `https://api.github.com/repos/${repo}/releases/latest`
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': userAgent }
    if (state.etag) headers['If-None-Match'] = state.etag
    let res
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (e) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        throw failure(`GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} s (request timeout)`, FAIL_KIND.UNREACHABLE)
      }
      throw failure(`GitHub could not be reached (${e?.message || e})`, FAIL_KIND.UNREACHABLE)
    }
    if (res.status === 304) return { outcome: OUTCOME.UNCHANGED }
    if (res.status === 404) return { outcome: OUTCOME.NONE }
    if (res.status === 403 || res.status === 429) {
      throw failure(`GitHub refused the request (HTTP ${res.status}), most likely its rate limit`, FAIL_KIND.REJECTED)
    }
    if (res.status >= 500) throw failure(`GitHub answered HTTP ${res.status}`, FAIL_KIND.UNREACHABLE)
    if (res.status !== 200) throw failure(`GitHub answered HTTP ${res.status}`, FAIL_KIND.UNKNOWN)

    // The body is read apart from parsing it: the timeout signal also covers
    // the download, so a stalled body is a timeout, not "not JSON".
    let text
    try {
      text = await res.text()
    } catch (e) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        throw failure(`GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} s (request timeout)`, FAIL_KIND.UNREACHABLE)
      }
      throw failure(`GitHub's answer could not be read (${e?.message || e})`, FAIL_KIND.UNREACHABLE)
    }
    let body
    try { body = JSON.parse(text) } catch {
      throw failure('the answer is not JSON', FAIL_KIND.INCOMPATIBLE)
    }
    const tag = body?.tag_name
    if (typeof tag !== 'string' || !tag) throw failure('the answer has no tag_name', FAIL_KIND.INCOMPATIBLE)
    const version = normalVersion(tag)
    if (!version) throw failure(`the latest release tag "${tag}" is not a version number`, FAIL_KIND.INCOMPATIBLE)
    return {
      outcome: OUTCOME.OK,
      etag: str(res.headers?.get?.('etag')),
      latest: { version, tag, url: str(body.html_url), publishedAt: str(body.published_at), name: str(body.name) }
    }
  }

  function logOutcome (outcome) {
    const p = '[release-check]'
    const s = status()
    const nextIso = new Date(s.nextCheckAt).toISOString()
    if (outcome === OUTCOME.FAILED) {
      log.warn(`${p} check failed (kept last state): ${s.lastReason}; next check ${nextIso}`)
    } else if (outcome === OUTCOME.NONE) {
      log.log(`${p} no release published yet`)
    } else if (outcome === OUTCOME.UNCHANGED) {
      const l = s.latest
      log.log(l ? `${p} unchanged — latest ${l.version} from ${l.publishedAt?.slice(0, 10) ?? 'an unknown date'}` : `${p} unchanged`)
    } else if (s.comparison === COMPARISON.NEWER) {
      log.log(`${p} release ${s.latest.version} is newer than installed ${s.installed}${s.latest.url ? `: ${s.latest.url}` : ''}`)
    } else if (s.comparison === COMPARISON.CURRENT) {
      log.log(`${p} up to date (${s.installed})`)
    } else {
      log.log(`${p} latest release is ${s.latest.version}; the installed version is unknown`)
    }
  }

  /** One check against GitHub. Never throws; persists; one log line; tells onCheck. */
  async function check () {
    busy = true
    try {
      return await checkOnce()
    } finally {
      busy = false
    }
  }

  async function checkOnce () {
    let result
    try {
      const r = await ask()
      result = { outcome: r.outcome }
      if (r.outcome === OUTCOME.OK) { state.latest = r.latest; state.etag = r.etag }
      else if (r.outcome === OUTCOME.NONE) { state.latest = null; state.etag = null }
    } catch (e) {
      result = { outcome: OUTCOME.FAILED, failKind: kindOf(e), reason: cleanReason(e?.message || e) || 'unknown error' }
    }
    const at = now()
    state.lastCheckAt = at
    state.nextCheckAt = at + INTERVAL_MS
    state.lastOutcome = result.outcome
    state.lastFailKind = result.failKind ?? null
    state.lastReason = result.reason ?? null
    await save()
    try { logOutcome(result.outcome) } catch { /* a log line must not fail the check */ }
    try { onCheck(status()) } catch { /* nor must a handler */ }
    return result
  }

  /**
   * The button. Ignores isDisabled(): the switch is for the automatic check only.
   * Returns { ok: true, status } after a run (also when GitHub failed: the failure
   * is in status.lastOutcome), { running: true } while a check is in flight, or
   * { retryAfterMs } inside the cooldown, which counts from the END of the
   * previous manual check and lives in memory only. Never throws.
   */
  async function checkNow () {
    if (busy) return { running: true }
    if (lastCheckNowEndedAt !== null) {
      const since = now() - lastCheckNowEndedAt
      if (since >= 0 && since < CHECK_NOW_COOLDOWN_MS) return { retryAfterMs: CHECK_NOW_COOLDOWN_MS - since }
    }
    try { await check() } catch { /* check() does not throw; this is the belt to its braces */ }
    lastCheckNowEndedAt = now()
    return { ok: true, status: status() }
  }

  function schedule (delayMs) {
    timer = timers.setTimeout(tick, delayMs)
    timer?.unref?.()
  }

  // A tick skips the request while the switch is off or a manual check is still
  // running, and in every case books the next one (unless stop() was called): the
  // timer keeps going idle so the switch works live in both directions. When a
  // manual check has pushed nextCheckAt into the future since this tick was
  // booked, the tick asks nothing and waits out the rest.
  async function tick () {
    let nextDelay = INTERVAL_MS
    try {
      const wait = state.nextCheckAt != null ? state.nextCheckAt - now() : 0
      if (wait > 0) {
        nextDelay = Math.min(wait, INTERVAL_MS)
      } else {
        let off = false
        try { off = isDisabled() } catch { /* an unreadable switch means "on" */ }
        if (!off && !busy) await check()
      }
    } finally {
      if (!stopped) schedule(nextDelay)
    }
  }

  // First tick: the stored nextCheckAt when it is still ahead, so a restart does
  // not ask again; but never further out than one interval (a state file from a
  // machine with a wrong clock must not silence the check for years). No usable
  // nextCheckAt (none, or already past): the initial delay, not an instant request.
  function start () {
    stop()
    stopped = false
    const wait = state.nextCheckAt != null ? state.nextCheckAt - now() : 0
    schedule(wait > 0 ? Math.min(wait, INTERVAL_MS) : INITIAL_DELAY_MS)
  }

  function stop () {
    stopped = true
    if (timer) timers.clearTimeout(timer)
    timer = null
  }

  return { init, start, stop, check, checkNow, status, cooldownMs: CHECK_NOW_COOLDOWN_MS }
}
