/* Trade Console v2 — real backend (Multi-User).
 *
 * Serves the frontend statically and drives the item/trade pipeline:
 *  - serves backend/v2/frontend/ statically,
 *  - WS /events (speaks PROTOCOL.md, the messages),
 *  - POST /item (body = item text from the daemon): engine parses -> immediate
 *    `item-added` (queued) to the browser -> trade job into the FIFO queue,
 *  - ONE serial queue through APT's RateLimiter (header-driven, never hits 429),
 *  - `search` (WS) = requery with selected mods, gets pulled forward with priority,
 *  - `dismiss` (WS) = remove item from the active set,
 *  - `cd-ratio` = Chaos:Divine (best-effort poe.ninja, otherwise env fallback).
 *
 * Multi-user (budget variant, no auth): multiple users (POE_USERS, default
 * "player1,player2") share ONE backend + ONE global queue (the shared
 * RateLimiter is the whole point), but each has their own "room" with their
 * own item cards and their own league. Identity is only used for routing (LAN, trusted):
 *  - browser: cookie `ppt_user=<user>` (read from req.headers.cookie at the WS handshake).
 *  - daemon: header `X-User: <user>` on POST /item (missing -> USERS[0]; unknown -> 400).
 *  - daemon channel: GET /daemon/events (long-poll feed of the daemon's own
 *    cards, its buyer-whisper verdicts and the user's session changes), POST
 *    /daemon/heartbeat (version, features, game), POST /daemon/whisper (a
 *    buyer's trade whisper, checked against the market without the trade
 *    API), POST /daemon/session (the session key: start, end or toggle a farm
 *    session) and GET /daemon/stash-grid (the value key: what each item in a
 *    stored stash tab is worth, at its cell); X-User and X-PPT-Daemon
 *    required, no USERS[0] fallback (frontend/PROTOCOL.md).
 * The same identity also carries the CLIENT LANGUAGE (POE_USER_LANGS, see
 * user-langs.mjs): a user on a German client is parsed by a second, parse-only
 * engine instance (engine-instances.mjs). Trade calls stay on the one primary
 * instance with the one shared RateLimiter.
 * `queue-status` is global (shared queue), everything else is routed per room.
 * poe.ninja caches are keyed by league (two users on the same league share them).
 *
 * Deps: only `ws` + the engine.
 * Start:  node backend/v2/server.mjs   (PORT default 8788)
 */
// FIRST import, and it has to stay first: it folds /config/overrides.json into
// process.env before anything reads a `POE_…` variable (config-boot.mjs says
// why it is a module of its own rather than a call further down).
import { configOverrideState } from './config-boot.mjs'
import { createServer } from 'node:http'
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises'
import { join, extname, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { rateLimitSeconds, classifyRateLimit, shouldRaiseGlobalGate } from './rate-limit-signal.mjs'
import { createTradeStatIndex } from './trade-stats.mjs'
// Observability of the shared trade budget — pure bookkeeping, NO extra
// requests: timestamps on every log line (log-timestamps.mjs) and a
// who-spent-what record per trade response (trade-audit.mjs).
import { installLogTimestamps } from './log-timestamps.mjs'
import { installTradeAudit, createTradeAudit, withConsumer, CONSUMER } from './trade-audit.mjs'
// poe.ninja fetchers: extracted into ninja.mjs (importable, side-effect-free),
// used here for the price path, reference rail, and C:D. Signatures unchanged.
import {
  NINJA_UA, NINJA_BASE, NINJA_MIN_MS,
  round1, roundExchange, normSpark, configureNinja,
  fetchCurrencyExchange, fetchExchangeOverview, fetchItemOverview, itemOverviewFetchedAt, ninjaTypeFor
} from './ninja.mjs'
// The age and state of each price source, for the status line and the
// settings page (docs/bugs.md B29).
import { createSourceHealth } from './source-health.mjs'
// Net-Worth tracker: stash scan -> valuation -> snapshot (Task 7 wiring).
import { loadNetworthUsers, NETWORTH_CONFIG_DEFAULT } from './networth/config.mjs'
import { validateCredentialInput, saveNetworthUser, CredentialsError } from './networth/credentials.mjs'
import { createStashClient } from './networth/stash-client.mjs'
import { loadItemsIndex, normalizeItem, descriptorForName } from './networth/normalize.mjs'
import { createValuator } from './networth/valuator.mjs'
import { aggregate, unpricedStock } from './networth/aggregate.mjs'
import { createNetworthStore } from './networth/store.mjs'
import { stashGridAnswer, tabIndexOf, STASH_GRID_VERSION } from './networth/stash-grid.mjs'
import { valueTab } from './networth/scan.mjs'
import { auditListings, createStackLookup, createQuadLookup } from './networth/listing-audit.mjs'
import { createNetworthRefresher, slowStepMsFromEnv } from './networth/refresher.mjs'
import { createNetworthHistory, createTabSetWatch, RANGES as NETWORTH_RANGES } from './networth/history.mjs'
import { createPriceGuard, guardOptionsFromEnv } from './networth/price-guard.mjs'
import { createSessions } from './networth/sessions.mjs'
import { createSessionControl } from './networth/session-control.mjs'
import { createReferenceHistory } from './reference-history.mjs'
// Faustus (GGG Currency Exchange, public CDN) — Task 3: store + hourly
// refresher for the derived name->chaos map (Task 2's faustus.mjs is the
// fetch/derivation engine; Task 4 wires valuator.mjs to read this store).
import { createFaustusPricer } from './networth/faustus.mjs'
import { createFaustusStore } from './networth/faustus-store.mjs'
import { createFaustusRefresher } from './networth/faustus-refresher.mjs'
import { faustusMaxAgeHoursFromEnv, maxAgeMs as faustusMaxAgeMsOf, isTooOld as faustusTooOld, staleHours as faustusStaleHours } from './networth/faustus-age.mjs'
// Sell-side comparison for the reference rail: which currency pays the seller
// more (chaos vs divine), from the SEPARATED Faustus per-market rates.
import { compareSellSides } from './sell-side.mjs'
// Corpses (Task 5): itemised-corpse pricing via the official Trade API (search+
// fetch over the SHARED RateLimiter at background priority), cached in a store,
// filled by a budgeted background pricer. 401/403 = circuit-breaker.
import { createCorpseStore } from './networth/corpse-store.mjs'
import { createTradeClient } from './networth/trade-client.mjs'
import { createCorpsePricer } from './networth/corpse-pricer.mjs'
// Data auto-update: keeps the vendored APT data, base-names.json and
// base-names.json fresh in the background (daily conditional checks,
// validate-before-adopt, persisted under /config) — see data-refresher.mjs.
// (its DEFAULT_INTERVAL_MS/DEFAULT_STALE_TICKS are the defaults for
// POE_DATA_REFRESH_MS/POE_DATA_STALE_TICKS and are imported by
// numeric-settings.mjs, so the number is not restated here.)
import { createDataRefresher } from './data-refresher.mjs'
import { isFailKind } from './check-failure.mjs'
// Once-a-day look at GitHub for a newer release of this tool (reports only,
// installs nothing) — see release-check.mjs. The installed version is the root
// package.json's, read by version.mjs.
import { createReleaseCheck, DEFAULT_REPO as RELEASE_DEFAULT_REPO } from './release-check.mjs'
import { VERSION, USER_AGENT } from './version.mjs'
import { loadBaseNames } from './networth/base-names.mjs'
// Two languages in one process: the primary engine (English — parse AND trade)
// plus a parse-only instance per additional client language, handed out as a
// wrapper that exposes nothing but parseItem. See engine-instances.mjs for why
// that is structural and not a convention.
import { createEngineInstances, PRIMARY_LANG } from './engine-instances.mjs'
import { parseUserLangs, DEFAULT_LANG, SUPPORTED_LANGS } from './user-langs.mjs'
// ...and the half of that mapping the USER owns: a language chosen on the
// settings page, persisted in /config and beating POE_USER_LANGS (see
// user-lang-store.mjs for why that direction and not the other one).
import { createUserLangStore } from './user-lang-store.mjs'
// Configuration the admin area may change at runtime: the allow-list, the
// validation, and the read/write half of the override file whose boot half ran
// in config-boot.mjs above.
import { SETTABLE_BY_NAME, configView, readOverrideFile, setOverride, clearApplyingMarker } from './config-overrides.mjs'
// ...and the numbers among them. One table (default, range, and whether an
// explicit 0 is a setting), one reader, one rule for a value that cannot be
// honoured: say so and use the default. Not the `Number(env) || DEFAULT`
// idiom, which cannot express zero — see numeric-settings.mjs for what that
// costs.
import { envNum } from './numeric-settings.mjs'
// The de->en bridge that lets the unknown-mod repair path fire for a localized
// item at all (design doc, section 5) — without it the English-only stat
// catalogue can never match a German mod line.
import { createModTextBridge } from './mod-text-pairs.mjs'
// The tool reporting its own gaps (design doc, section 6): what failed to parse
// and which mod lines stayed unresolved, aggregated per language; how far a
// localized data set has fallen behind English; and the plaintext-password
// partition in front of the view that shows all of it.
import { createGapLog } from './gap-log.mjs'
import { createLangSkew } from './lang-skew.mjs'
import { createAdminAuth, ADMIN_PASSWORD_FILE_DEFAULT, ADMIN_MISSING } from './admin-auth.mjs'
// The update button. A restart this process can do to itself; an update needs
// the host, so the container writes a request into /config and a script out
// there decides. host-update.mjs argues the whole shape of it, including why
// there is no docker socket anywhere near this container.
// (HEARTBEAT_MAX_AGE_MS_DEFAULT is the default for
// POE_UPDATE_HEARTBEAT_MAX_AGE_MS and lives in numeric-settings.mjs's table.)
import { createHostUpdate, UPDATE_DIR_DEFAULT } from './host-update.mjs'
// The hotkey daemon's own channel (frontend/PROTOCOL.md, `GET /daemon/events`):
// the feed of the cards a daemon posted itself, what the daemons report about
// themselves, the caller rule of every /daemon/* route and its bounded bodies.
// None of it sends a request anywhere.
import { createDaemonFeed, FEED_VERSION, guarded } from './daemon-feed.mjs'
import { createDaemonPresence, makeHoldAfterGame } from './daemon-presence.mjs'
import { daemonCaller, daemonInstanceOf } from './daemon-user.mjs'
import { readBodyLimited, BodyTooLarge, parseJsonBody } from './http-body.mjs'
// Buyer whispers (POST /daemon/whisper): the trade site's templates as data,
// and the verdict on the player's own listed price through the net-worth
// valuator. Memory only; never a trade-API request, never a whisper's text in
// the log.
import { WHISPER_TEMPLATES } from './whisper.mjs'
import { createWhisperPricer, createWhisperBook, createRateGate, createWhisperHandler, createWhisperErrorLog, loadUniqueIndex } from './whisper-price.mjs'

// ---- Observability (install FIRST, before anything can log) ----------------
// Timestamps on every console line: without them a log gives the order of
// events but not the time, and a rate-limit banner cannot be matched against
// the requests that caused it. POE_LOG_TIMESTAMPS=0 restores the bare console.
if (process.env.POE_LOG_TIMESTAMPS !== '0') installLogTimestamps()
// Trade rate-limit bookkeeping. Reads the headers of responses that happen
// anyway (never sends anything itself) and logs ONE line when a window gets
// tight, plus one with per-consumer counts on a 429. POE_TRADE_AUDIT=0 off.
// The threshold accepts 0 ("report every window"); the audit never sends a
// request, so the loudest setting it has still costs nothing.
const TRADE_AUDIT_THRESHOLD = envNum('POE_TRADE_AUDIT_THRESHOLD')
const tradeAudit = createTradeAudit({ threshold: TRADE_AUDIT_THRESHOLD })
if (process.env.POE_TRADE_AUDIT !== '0') installTradeAudit({ audit: tradeAudit })

// ---- Config (all from env, sensible defaults) ------------------------------
// Every NUMBER below comes from envNum() — numeric-settings.mjs holds the
// default, the range and the answer to "is an explicit 0 a setting here?" for
// each one, and an unusable value is reported instead of silently replaced.
// That includes PORT (0 = let the OS pick a free port, the test suite's normal path).
const PORT = envNum('PORT')
const LEAGUE = process.env.POE_LEAGUE || 'Standard'
// Fixed user list (no login). Identity is only used for routing.
const USERS = (process.env.POE_USERS || 'player1,player2').split(',').map(s => s.trim()).filter(Boolean)
// ...and which client language each of them plays in — same identity, both
// transports (X-User on POST /item, cookie ppt_user on the WS). Unset means
// English for everyone. A malformed mapping throws right here, at startup,
// instead of feeding items to the wrong parser
// (user-langs.mjs explains why that is a hard error).
const ENV_LANG_BY_USER = parseUserLangs({
  spec: process.env.POE_USER_LANGS,
  users: USERS,
  defaultLang: process.env.POE_LANG_DEFAULT || DEFAULT_LANG
})
// The mapping actually in force. Starts as the env seed and is overlaid with
// whatever each user has chosen for himself — the store WINS over the env, so
// a deploy never silently reverts somebody's own choice (user-lang-store.mjs).
// Mutable on purpose: POST /user-lang writes into it.
const LANG_BY_USER = new Map(ENV_LANG_BY_USER)
const userLangStore = createUserLangStore()
for (const [u, lang] of await userLangStore.load({ users: USERS, supported: SUPPORTED_LANGS })) {
  LANG_BY_USER.set(u, lang)
}
// Configurable brand name (landing page only — the feature pages keep their
// own functional names, "Net Worth"/"History"). Neutral default; the
// operator sets their own via env. Read at REQUEST time, not once at startup:
// that is what makes it changeable from the admin area without a restart
// (config-overrides.mjs lists it as `live`).
const appName = () => process.env.POE_APP_NAME || 'Trade Console'
// PoE trade fetch (/api/trade/fetch/{ids}) allows MAX. 10 ids per request —
// more -> the API responds "Invalid query". searchPreset fetches in ONE call,
// so the ceiling of 10 is GGG's, not ours; the table carries it as `max` and
// refuses anything above it instead of quietly clamping (a `Math.min(10, …)`
// also passes a NEGATIVE value through untouched, so POE_MAX_LISTINGS=-5 would
// ask for -5 listings).
// Read per search for the same reason as appName().
const maxListings = () => envNum('POE_MAX_LISTINGS')
const CD_FALLBACK = envNum('POE_CD_RATIO') // used when poe.ninja is unreachable
// The band of the buyer-whisper verdict (whisper-price.mjs verdictFor). Read
// once and shared: the "Listed below market" block on the Net Worth page uses
// the same two numbers, so a whisper and the page cannot disagree.
const WHISPER_LOW_RATIO = envNum('POE_WHISPER_LOW_RATIO')
const WHISPER_HIGH_RATIO = envNum('POE_WHISPER_HIGH_RATIO')
const CD_REFRESH_MS = envNum('POE_CD_REFRESH_MS')
// NINJA_UA/NINJA_BASE/NINJA_MIN_MS -> ninja.mjs (see the import above).
const FALLBACK_LEAGUES = ['Standard', 'Hardcore']

const FE_DIR = fileURLToPath(new URL('./frontend/', import.meta.url))
const BUNDLE = new URL('./engine.bundle.mjs', import.meta.url).href

// ---- Data auto-update (data-refresher.mjs) ---------------------------------
// Created and init()ed BEFORE the engine/seed/base-names load, because init()
// decides which copy of each data source is active: a validated snapshot
// persisted under POE_DATA_REFRESH_DIR (survives redeploys), or the baked-in
// one. The background schedule itself starts further down (start()), once the
// consumers exist. POE_DATA_REFRESH_DISABLED=1 stops the fetching, but an
// already-persisted valid snapshot is still preferred (wipe the dir to reset).
const DATA_REFRESH_MS = envNum('POE_DATA_REFRESH_MS')
const DATA_REFRESH_DISABLED = process.env.POE_DATA_REFRESH_DISABLED === '1'
const DATA_REFRESH_DIR = process.env.POE_DATA_REFRESH_DIR || '/config/data-refresh'
// How many missed ticks make a source "stale" in the UI status line. Relative
// to the interval, not an absolute duration (POE_DATA_STALE_TICKS overrides).
const DATA_STALE_TICKS = envNum('POE_DATA_STALE_TICKS')
// How many characters of the last failure REASON a source's status line carries
// (check-failure.mjs). The duration alone never said whether a source is briefly
// away or refusing to work again — docs/bugs.md B24.
const DATA_STATUS_REASON_MAX = envNum('POE_DATA_STATUS_REASON_MAX')
// How long the admin area's "check now" stays shut after a run. It exists so a
// repair can be verified instead of waited out, and it is guarded because the
// person most likely to press it twice is the one in the middle of a repair.
const DATA_CHECK_NOW_COOLDOWN_MS = envNum('POE_DATA_CHECK_NOW_COOLDOWN_MS')
// The languages somebody is configured for right now. Handed over explicitly
// rather than left to the refresher's own `configuredLanguages()` read of
// POE_USER_LANGS: a language a user picked HIMSELF (user-lang-store) is not in
// that variable, and a data set that stops being refreshed goes stale silently.
//
// This is the SEED, not the final answer: the set the refresher ends up with is
// widened to BOOT_LANGS below, once the snapshot has been read. The refresher is
// created here because its init() is what decides which snapshot is active, and
// that answer is an input to the wider set — see setLanguages() further down.
const CONFIGURED_LANGS = [...new Set([
  process.env.POE_LANG_DEFAULT || DEFAULT_LANG,
  ...ENV_LANG_BY_USER.values(),
  ...LANG_BY_USER.values()
])].filter(l => SUPPORTED_LANGS.includes(l))
// How much of the coverage the live localized set already has may fall away in
// one regeneration before the run is refused (lang-derive.mjs, validate()). Read
// here rather than in the generator: numeric-settings.mjs sits ABOVE it in the
// import graph, and a module reading the environment on its own is exactly what
// that table exists to end.
const LANG_MAX_COVERAGE_LOSS_RATIO = envNum('POE_LANG_MAX_COVERAGE_LOSS_RATIO')
const dataRefresher = createDataRefresher({
  dir: DATA_REFRESH_DIR,
  intervalMs: DATA_REFRESH_MS,
  staleTicks: DATA_STALE_TICKS,
  languages: CONFIGURED_LANGS,
  langMaxLossRatio: LANG_MAX_COVERAGE_LOSS_RATIO,
  // How much of a failure reason travels into the status line (the refresher
  // filters and caps it there, so nothing longer is ever persisted either).
  reasonMaxChars: DATA_STATUS_REASON_MAX,
  checkNowCooldownMs: DATA_CHECK_NOW_COOLDOWN_MS,
  vendored: {
    publicDir: fileURLToPath(new URL('../../renderer/public/', import.meta.url)),
    baseNamesPath: fileURLToPath(new URL('./networth/base-names.json', import.meta.url))
  }
})
await dataRefresher.init()

// ---- Release check (release-check.mjs) --------------------------------------
// Asks GitHub at most once a day whether a newer release of this tool exists and
// tells every open page. POE_RELEASE_CHECK_DISABLED=1 stops the AUTOMATIC check
// only and is read at tick time (setting, apply: live); the admin area's manual
// check ignores it. The state survives restarts, so a container that restarts
// every night still asks once a day.
const RELEASE_REPO = process.env.POE_RELEASE_REPO || RELEASE_DEFAULT_REPO
const RELEASE_CHECK_STATE = process.env.POE_RELEASE_CHECK_STATE || '/config/release-check.json'
const releaseCheck = createReleaseCheck({
  repo: RELEASE_REPO,
  installedVersion: VERSION,
  statePath: RELEASE_CHECK_STATE,
  userAgent: USER_AGENT,
  isDisabled: () => process.env.POE_RELEASE_CHECK_DISABLED === '1',
  onCheck () { broadcastAll(releaseStatusMsg()) }
})
await releaseCheck.init()

function releaseStatusMsg () {
  return { type: 'release-status', ...releaseCheck.status() }
}

// From which age of its last success a source counts as stale. One bar for all
// (POE_SOURCE_STALE_MS, read here per message so a change from the settings
// page applies live), raised per source to twice its own refresh interval so a
// slow schedule is not reported between two of its own ticks. Trade has no
// age: it is a search, not a feed, and its outage is the ban (pausedUntil).
function sourceStaleAfterMs (source) {
  const bar = envNum('POE_SOURCE_STALE_MS')
  if (source === 'faustus') return Math.max(bar, 2 * FAUSTUS_REFRESH_MS)
  if (source === 'ninja-cd') return Math.max(bar, 2 * Math.max(CD_REFRESH_MS, NINJA_MIN_MS))
  if (source === 'ninja-overview') return bar
  return null
}

// The `source-status` message (frontend/PROTOCOL.md). Facts only — enabled
// and scheduled say how to read an age: a `scheduled` source runs on a timer
// and may go stale by age alone; an on-demand one (scheduled: false) is only
// stale when its last attempt failed. The client does the ageing.
function sourceStatusMsg () {
  const plan = {
    faustus: { enabled: !FAUSTUS_DISABLED && faustusStoreWritable, scheduled: true },
    'ninja-cd': { enabled: true, scheduled: true },
    'ninja-overview': { enabled: true, scheduled: false },
    trade: { enabled: !PRICE_CHECK_DISABLED || !CORPSE_DISABLED, scheduled: false }
  }
  const ban = tradeBanPause()
  return {
    type: 'source-status',
    now: Date.now(),
    since: SERVER_STARTED_AT,
    sources: sourceHealth.snapshot().map(s => ({
      source: s.source,
      enabled: plan[s.source].enabled,
      scheduled: plan[s.source].scheduled,
      staleAfterMs: sourceStaleAfterMs(s.source),
      lastSuccessAt: s.lastSuccessAt,
      lastFailureAt: s.lastFailureAt,
      reason: s.reason,
      failKind: s.failKind,
      ...(s.source === 'trade' ? { pausedUntil: ban ? ban.until : null } : {})
    }))
  }
}

// A display-only message that costs no request. A state change (a source
// starting or stopping to fail, a ban set or lifted) goes out at once; plain
// successes are bundled, so a busy trade queue cannot flood every socket —
// at most one message per SOURCE_STATUS_COALESCE_MS.
let sourceBroadcastTimer = null
const SOURCE_STATUS_COALESCE_MS = 10_000
function scheduleSourceBroadcast (now = false) {
  if (!sourceStatusReady) return
  if (now) {
    clearTimeout(sourceBroadcastTimer)
    sourceBroadcastTimer = null
    broadcastAll(sourceStatusMsg())
    return
  }
  if (sourceBroadcastTimer) return
  sourceBroadcastTimer = setTimeout(() => {
    sourceBroadcastTimer = null
    broadcastAll(sourceStatusMsg())
  }, SOURCE_STATUS_COALESCE_MS)
  sourceBroadcastTimer.unref?.()
}

// POE_SOURCE_STALE_MS is read per message, but a changed setting is no event
// of its own: without this an open page kept the old bar until the next
// success or failure of a source, and the C:D tile its staleAfterMs until the
// next cd-ratio (15 minutes at least). Called after the setting is changed.
function broadcastStaleBars () {
  scheduleSourceBroadcast(true)
  const leagues = new Set()
  for (const room of users.values()) if (room.clients.size) leagues.add(room.league)
  for (const lg of leagues) {
    const m = cdMsgFor(lg)
    if (typeof m.asOf === 'number') broadcastLeague(lg, m)
  }
}

// ---- Gap reporting + admin partition (design doc, section 6) ---------------
// The German user will not report a bug and the operator will not read logs, so
// the two failure modes that would otherwise stay invisible are counted here
// and handed out on the settings page: a clipboard text the engine refused, and
// a mod line nothing could resolve. Both are aggregated per language and
// bounded in memory — see gap-log.mjs for the eviction rule.
const GAP_LOG_MAX = envNum('POE_GAP_LOG_MAX')
const GAP_LOG_TEXT_MAX = envNum('POE_GAP_LOG_TEXT_MAX')
const gapLog = createGapLog({ maxEntriesPerKind: GAP_LOG_MAX, maxTextLength: GAP_LOG_TEXT_MAX })

// How far a localized data set may fall behind English before the view calls it
// a warning, as a fraction of the English set. A ratio, not a count — see
// lang-skew.mjs.
const LANG_SKEW_WARN_RATIO = envNum('POE_LANG_SKEW_WARN_RATIO')
// Compared against the snapshot the container is ACTUALLY serving (the
// refresher's active dir), never against a guessed one.
const langSkew = createLangSkew({
  resolvePath: (lang, file) => (file === 'items.ndjson'
    ? dataRefresher.itemsNdjsonPath(lang)
    : dataRefresher.statsNdjsonPath(lang)),
  warnRatio: LANG_SKEW_WARN_RATIO
})

// Plaintext password in a file, default `admin`, checked on EVERY admin request
// — no session, no expiry, no server-side state. admin-auth.mjs argues why.
const ADMIN_PASSWORD_PATH = process.env.POE_ADMIN_PASSWORD_FILE || ADMIN_PASSWORD_FILE_DEFAULT
const adminAuth = createAdminAuth({ path: ADMIN_PASSWORD_PATH })
await adminAuth.ensureFile()
// Said out loud at every start while the default is still in force, because
// what it guards has grown: the same password ends the process and writes the
// configuration the next start reads, not just a read-only diagnostic view. The
// trust model is unchanged (LAN, no authentication) and nothing is forced —
// this is a warning, not a gate.
if (await adminAuth.usingDefault()) {
  console.warn('[admin] ============================================================')
  console.warn(`[admin] THE ADMIN PASSWORD IS STILL THE DEFAULT (${ADMIN_PASSWORD_PATH}).`)
  console.warn('[admin] It is published in this repository, and it is what stands')
  console.warn('[admin] between anyone on this network and the restart button, the')
  console.warn('[admin] configuration the next start reads, and the diagnostic view.')
  console.warn('[admin] Change it before this tool is reachable from anywhere but')
  console.warn('[admin] your own network.')
  console.warn('[admin] ============================================================')
}

// ---- The update button (host-update.mjs) -----------------------------------
// Which commit this image was built from. Comes in as a build argument
// (Dockerfile ARG BUILD_COMMIT -> POE_BUILD_COMMIT), and is EMPTY whenever
// nobody passed one — a plain `docker compose build` does not know about git.
// It is then reported as unknown rather than filled with a plausible-looking
// value: "which version is running" is the first question of every update, and
// a wrong answer to it is worse than no answer.
const BUILD_COMMIT = (process.env.POE_BUILD_COMMIT || '').trim()
// Where the container and the host script meet: the /config volume. Not a file
// path but the directory, because the three files of the protocol (request,
// heartbeat, result) have to sit together and the host script names the same
// directory in its own constant.
const UPDATE_DIR = process.env.POE_UPDATE_DIR || UPDATE_DIR_DEFAULT
const UPDATE_HEARTBEAT_MAX_AGE_MS = envNum('POE_UPDATE_HEARTBEAT_MAX_AGE_MS')
// NOTHING HAPPENS AT BOOT HERE. Creating this object touches no file: an
// installation without the host script must not gain a single new file in its
// /config volume, and must not behave differently in any other way either.
const hostUpdate = createHostUpdate({
  dir: UPDATE_DIR,
  heartbeatMaxAgeMs: UPDATE_HEARTBEAT_MAX_AGE_MS,
  buildCommit: BUILD_COMMIT
})

// ---- Load engine (import the bundle dynamically, like the CLI) ------------
// One instance per configured client language, all pointed at the SAME
// snapshot dir (data/en and data/de live side by side in it) and loaded
// STRICTLY SERIALLY — __aptEnv.BASE_URL is process-wide, so a parallel load
// would be a race. Only the primary (English) instance is the full engine;
// every other one is handed out as a parse-only wrapper.
//
// The set is wider than "the languages somebody is configured for": every
// language whose data set is IN THE ACTIVE SNAPSHOT gets an instance. That is
// what makes the runtime language switch (POST /user-lang) mean anything — a
// user can only be moved to a language that has a live parser, and loading one
// on demand is not possible (the loads must be serial, `__aptEnv.BASE_URL` is
// process-wide). A data set is only ever in the snapshot because this
// installation was configured for that language at some point, so this costs a
// second instance exactly where somebody once wanted one.
const BOOT_LANGS = [...new Set([
  ...CONFIGURED_LANGS,
  ...dataRefresher.activeLanguages().filter(l => SUPPORTED_LANGS.includes(l))
])]
// WHAT CAN BE CHOSEN HAS TO BE KEPT UP TO DATE. The refresher was created with
// the configured languages alone, which is a smaller set than this one: a
// language that is in the snapshot but that nobody is configured for any more
// still gets a parser below, is still offered by GET /user-lang — and its data
// set would have gone stale silently, the exact failure the comment at
// CONFIGURED_LANGS warns about. So the refresher is handed the set the parsers
// are built from, before it is ever started. What /user-lang offers is exactly
// the subset of it that came up, so nothing selectable is left unrefreshed;
// covering the few that did not come up as well is the cheaper mistake, and it
// is what lets them come up later: the refresher generates their data set, and
// the engine reload after that update retries every instance that is down
// (applyAptData), so no restart is needed for them.
//
// Once, here, and never again at runtime — because the set cannot change at
// runtime either: /user-lang only hands out languages that have a LIVE PARSER,
// every parser is an instance created here for a language of this set (the
// instances are loaded serially, `__aptEnv.BASE_URL` is process-wide), and the
// one setting that could widen the set, POE_LANG_DEFAULT, is a `restart` key.
// Every way to put a language outside this set into it goes through a boot,
// and every boot passes this line.
dataRefresher.setLanguages(BOOT_LANGS)
const engines = await createEngineInstances({
  bundleUrl: BUNDLE,
  languages: BOOT_LANGS,
  log: console
})
const engine = engines.primary()
// warm up the data DB once — from the refresher's active snapshot (undefined
// -> engine default, the baked-in renderer/public)
await engines.ready({ publicDataDir: dataRefresher.publicDataUrl() })
{
  const missing = engines.languages().filter(l => !engines.liveLanguages().includes(l))
  console.log(`[engine] parsers=[${engines.liveLanguages().join(', ')}]  snapshot languages=[${dataRefresher.activeLanguages().join(', ')}]` +
    (missing.length ? `  MISSING=[${missing.join(', ')}] — those users get an error instead of an English parse` : ''))
}

// Second pass over the stored per-user languages, now that it is known which
// parsers are actually LIVE. A stored entry whose language did not come up
// (its data set is missing from the snapshot, or its instance failed to load)
// would otherwise mean 503 on every item that user pastes. PARKED instead —
// per entry, with a warning — and the user is on the env/default value for
// now. Parked, not dropped: the entry stays in /config/user-langs.json (the
// store writes it back with every save) and is in force again as soon as its
// parser is live — at the next start, or earlier, when a data update brings
// the missing data set (reviveParkedLangs, called from applyAptData).
for (const u of userLangStore.park({ isLive: l => engines.liveLanguages().includes(l) })) {
  LANG_BY_USER.set(u, ENV_LANG_BY_USER.get(u) || DEFAULT_LANG)
}

// Consumer-tagged entry points into the engine's trade calls. These are the
// ONLY places this app reaches the Trade API from, so tagging them here (rather
// than threading a parameter through every caller) attributes every request:
// the tag rides an AsyncLocalStorage context that the engine's own fetch
// inherits. Behaviour is otherwise identical — same function, same arguments,
// same shared RateLimiter, no extra call.
const searchPresetAs = (...args) => withConsumer(CONSUMER.PRICE_CHECK, () => engine.searchPreset(...args))
const bulkPriceItemAs = (...args) => withConsumer(CONSUMER.PRICE_CHECK, () => engine.bulkPriceItem(...args))
const searchRawAs = (consumer) => (...args) => withConsumer(consumer, () => engine.searchRaw(...args))

// The item price check was the one outbound path with no off switch. Every
// background schedule can be disabled (Faustus, corpses, data refresh,
// reference warm-up), but POSTing an item always sent a Trade-API search, so
// "boot the real server without touching the network" was not expressible —
// which is why `server.test.mjs` and `server-langs.test.mjs` priced live
// against www.pathofexile.com on every run, and why they then never exited:
// APT's RateLimiter books each spent request as a timer that runs for the
// whole rate-limit window it learned from GGG's headers (observed: 302 s and
// 21602 s), and the engine's response cache adds an expiry timer of the same
// order. Those are ref'd, so closing the HTTP server does not end the process.
// Not in the config-overrides allow-list on purpose: turning the tool's own
// price check off is a deployment decision, not a click in the settings page.
const PRICE_CHECK_DISABLED = process.env.POE_PRICE_CHECK_DISABLED === '1'
if (PRICE_CHECK_DISABLED) {
  console.log('[price-check] disabled via POE_PRICE_CHECK_DISABLED=1 — item cards are created but never priced')
}

// ---- Net-Worth-Tracker: store + items index + credentials -------------------
// Store path in the /config volume; mkdir guard
// identical (local run without /config -> persistence off, feature honestly
// reports an error on save instead of killing the server start).
const NETWORTH_STORE = process.env.POE_NETWORTH_STORE || '/config/networth-store.json'
// Background auto-sync (refresher.mjs): ONE tab per interval instead of a
// ~115-request burst that trips GGG's 429. On by default; POE_NETWORTH_AUTOSYNC=0
// disables it. The interval is the pace (30s = lowest load), listTtl how rarely
// the tab list is re-fetched, cooldown how long a user backs off after a 429.
const NETWORTH_AUTOSYNC = process.env.POE_NETWORTH_AUTOSYNC !== '0'
// Credential file the settings UI writes (same path config.mjs reads). The
// stored POESESSID never leaves this file towards a client — see the
// /networth/credentials endpoints below.
const NETWORTH_CONFIG_PATH = process.env.POE_NETWORTH_CONFIG || NETWORTH_CONFIG_DEFAULT
// None of the three accepts 0: a tick without pause, a tab list re-fetched
// every tick and a 429 retried immediately are all requests against GGG that
// nobody asked for. POE_NETWORTH_AUTOSYNC=0 is the switch that means "stop".
const NETWORTH_SYNC_INTERVAL_MS = envNum('POE_NETWORTH_SYNC_INTERVAL_MS')
const NETWORTH_LIST_TTL_MS = envNum('POE_NETWORTH_LIST_TTL_MS')
const NETWORTH_COOLDOWN_MS = envNum('POE_NETWORTH_COOLDOWN_MS')
// Sync follows the game (networth/refresher.mjs, WHO GETS THE TICK): which
// tick a user whose daemon reports the game not running gets. Both can only
// move or drop a stash read, never add one. POE_NETWORTH_IDLE_REST is a switch
// like POE_*_DISABLED, so it is not in the numeric table.
const NETWORTH_IDLE_EVERY = envNum('POE_NETWORTH_IDLE_EVERY')
const NETWORTH_IDLE_REST = process.env.POE_NETWORTH_IDLE_REST === '1'
// How long a stopped game keeps the playing pace at most (makeHoldAfterGame).
const SYNC_AFTER_GAME_MAX_MS = envNum('POE_SYNC_AFTER_GAME_MAX_MS')
// This one DOES accept 0 (report every step that outlives a tick), and its
// default lives next to the module that uses it — see slowStepMsFromEnv in
// refresher.mjs, which reads it through the same env-number.mjs reader.
const NETWORTH_SLOW_STEP_MS = slowStepMsFromEnv()
const networthStore = createNetworthStore(NETWORTH_STORE)
let networthStoreWritable = true
try {
  await mkdir(dirname(NETWORTH_STORE), { recursive: true })
} catch (e) {
  networthStoreWritable = false
  networthStore.writable = false
  console.warn(`[networth] Store folder ${dirname(NETWORTH_STORE)} could not be created (${e?.code || e}) — snapshots will not be persisted.`)
}
await networthStore.load() // missing -> empty; unusable -> moved aside, empty; from a newer release -> left alone, in memory only (store-file.mjs)

// ---- Net-worth history (header trend chart) --------------------------------
// Append-only NDJSON next to the store, at most ONE point per user per minute,
// 15-day retention. Deliberately NOT part of networth-store.json: that file is
// rewritten in full on every tab sync (~30s), the series is not. See
// networth/history.mjs for the line shape and the privacy note.
const NETWORTH_HISTORY = process.env.POE_NETWORTH_HISTORY ||
  join(dirname(NETWORTH_STORE), 'networth-history.ndjson')
// The implausible-price brake in front of that series (networth/price-guard.mjs).
// Every bar of it is settable, because every one of them is a judgement about a
// market and the market is not ours: the factor and the share come from the
// Scavenger incident, the hold window is how long a suspicion may stand, and
// the arrival floor is what keeps a fresh account out of the brake's reach.
// The module constants are the documented defaults; see docs/pricing-logic.md.
// Parsed by the module itself (guardOptionsFromEnv) and NOT with a
// `Number(env) || DEFAULT` idiom, which cannot express zero — and zero is how
// POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE switches the arrival bar off; the idiom
// would hand back 20 for 0, silently.
// Its memory (running holds, remembered prices, the last C:D) is kept next to
// the series in `…-guard.json`, derived from this path like the items sidecar
// (networth/guard-state.mjs); POE_NETWORTH_GUARD_STATE_MAX_NAMES bounds it.
const NETWORTH_GUARD = guardOptionsFromEnv(process.env)
// Kept in a name so a farm session can ask which arrivals it is holding at no
// value (withheldArrivals below).
const networthPriceGuard = createPriceGuard(NETWORTH_GUARD)
const networthHistory = createNetworthHistory(NETWORTH_HISTORY, {
  priceGuard: networthPriceGuard,
  // A memory file of another league is not restored (guard-state.mjs).
  league: LEAGUE
})
networthHistory.writable = networthStoreWritable
await networthHistory.load() // tolerates missing/empty/corrupt -> empty series

// ---- Farm and game sessions (networth/sessions.mjs) -------------------------
// Farm sessions start and end from the History page and the daemon's session
// key, game sessions from the daemon's game detection (session-control.mjs,
// below); the balance is struck against the history's own points, so a session
// costs no request of its own.
const NETWORTH_SESSIONS = process.env.POE_NETWORTH_SESSIONS ||
  join(dirname(NETWORTH_STORE), 'networth-sessions.json')
const SESSION_BASELINE_MAX_AGE_MS = envNum('POE_SESSION_BASELINE_MAX_AGE_MS')
const SESSION_RATE_MIN_MS = envNum('POE_SESSION_RATE_MIN_MS')
const SESSION_LIST_MAX = envNum('POE_SESSION_LIST_MAX')
const SESSIONS_KEEP = envNum('POE_SESSIONS_KEEP')
const SESSION_FINALIZE_MAX_MS = envNum('POE_SESSION_FINALIZE_MAX_MS')
// Game sessions: how long the game must be reported not running before one
// ends, and the switch that starts none (POE_SESSION_AUTO_GAME=0).
const SESSION_GAME_GAP_MS = envNum('POE_SESSION_GAME_GAP_MS')
const SESSION_AUTO_GAME = process.env.POE_SESSION_AUTO_GAME !== '0'
const networthSessions = createSessions(NETWORTH_SESSIONS, {
  baselineMaxAgeMs: SESSION_BASELINE_MAX_AGE_MS,
  rateMinMs: SESSION_RATE_MIN_MS,
  topN: envNum('POE_SESSION_TOP_N'),
  keep: SESSIONS_KEEP,
  finalizeMaxMs: SESSION_FINALIZE_MAX_MS
})
networthSessions.writable = networthStoreWritable
await networthSessions.load() // missing -> none; unusable -> moved aside; from a newer release -> left alone, in memory only (store-file.mjs)

// ---- Reference rail history (the rail's own sparklines) ---------------------
// poe.ninja's `sparkline` is not consistently oriented across rows (see
// reference-history.mjs), so the rail keeps its own series: one point per
// successful reference refresh, canonical chaos value per row + the C:D of that
// moment, 7 days. mkdir guard identical to the other /config stores — a local
// run without the volume just draws no lines instead of throwing every refresh.
const REFERENCE_HISTORY = process.env.POE_REFERENCE_HISTORY || '/config/reference-history.ndjson'
const referenceHistory = createReferenceHistory(REFERENCE_HISTORY)
try {
  await mkdir(dirname(REFERENCE_HISTORY), { recursive: true })
} catch (e) {
  referenceHistory.writable = false
  console.warn(`[reference] History folder ${dirname(REFERENCE_HISTORY)} could not be created (${e?.code || e}) — rail sparklines are in-memory only.`)
}
await referenceHistory.load() // tolerates missing/empty/corrupt -> empty series

// ---- Faustus (GGG Currency Exchange) store + hourly refresher --------------
// Persists the derived name->chaos map (Task 2's chaosByName() output) so
// valuation (Task 4) has data immediately on boot -- GGG deletes old Faustus
// history, so without a persisted last-good map a fresh restart would have to
// wait for the first completed hourly refresh. Single-league store (like the
// the configured LEAGUE) -- multi-league networth users are a
// Task 4 concern. mkdir guard identical to the networth store above.
// ---- Price-source status (source-health.mjs, docs/bugs.md B29) -------------
// Every price source reports its outcomes here; the `source-status` message
// carries the facts, and each page ages them against the server clock. Set up
// BEFORE the Faustus refresher, whose boot tick already reports.
const SERVER_STARTED_AT = Date.now()
// How long an old poe.ninja answer is still served once refreshing it failed,
// and how long the net-worth exchange map lives (ninja.mjs, valuator.mjs).
const NINJA_MAX_AGE_MS = envNum('POE_NINJA_MAX_AGE_MS')
const NINJA_MAP_TTL_MS = envNum('POE_NINJA_MAP_TTL_MS')
const NINJA_FAIL_LOG_MS = envNum('POE_NINJA_FAIL_LOG_MS')
// No broadcast before the server listens: no page is connected yet, and a
// callback from the Faustus boot tick must not reach `users` while it is still
// in its temporal dead zone. Set to true right after clearApplyingMarker().
let sourceStatusReady = false
const sourceHealth = createSourceHealth({
  reasonMaxChars: DATA_STATUS_REASON_MAX,
  onChange: (src, ev) => scheduleSourceBroadcast(!!(ev.started || ev.recovered))
})
configureNinja({
  maxAgeMs: NINJA_MAX_AGE_MS,
  failLogEveryMs: NINJA_FAIL_LOG_MS,
  onOutcome: (src, o) => (o.ok
    ? sourceHealth.ok(src, { at: o.at })
    : sourceHealth.fail(src, o.reason, o.kind, { at: o.at }))
})

const FAUSTUS_STORE = process.env.POE_FAUSTUS_STORE || '/config/faustus-store.json'
const FAUSTUS_DISABLED = process.env.POE_FAUSTUS_DISABLED === '1'
const FAUSTUS_UNION_HOURS = envNum('POE_FAUSTUS_UNION_HOURS') // undefined -> faustus.mjs default (8)
const FAUSTUS_REFRESH_MS = envNum('POE_FAUSTUS_REFRESH_MS')
// Max staleness before the valuator treats the Faustus map as absent (F1). The
// store shares one updatedAt across the whole map; generous default (48h) covers
// the multi-hour union + hourly refresh, but bounds silently-frozen prices if
// the CDN feed breaks -> valuation falls through to poe.ninja.
const FAUSTUS_TTL_MS = envNum('POE_FAUSTUS_TTL_MS')
// How old the OBSERVATION behind ONE price may be — a different question from
// the map-wide TTL above, and the one the "206.6c against 147c in-game" report
// turned out to be about. Lives with its own module for the same reason
// guardOptionsFromEnv and slowStepMsFromEnv do (same reader, same refusal
// logging, default next to the prose that argues it): networth/faustus-age.mjs.
const FAUSTUS_MAX_AGE_MS = faustusMaxAgeMsOf(faustusMaxAgeHoursFromEnv(process.env), FAUSTUS_REFRESH_MS)
// The two bars of the Net-Worth uncertainty marker (networth/valuator.mjs
// UNCERTAIN). Display only: they mark rows and change no number.
const NETWORTH_THIN_TURNOVER_C = envNum('POE_NETWORTH_THIN_TURNOVER_C')
const NETWORTH_CORPSE_MIN_LISTINGS = envNum('POE_NETWORTH_CORPSE_MIN_LISTINGS')
const faustusStore = createFaustusStore(FAUSTUS_STORE)
let faustusStoreWritable = true
try {
  await mkdir(dirname(FAUSTUS_STORE), { recursive: true })
} catch (e) {
  faustusStoreWritable = false
  faustusStore.writable = false
  console.warn(`[faustus] Store folder ${dirname(FAUSTUS_STORE)} could not be created (${e?.code || e}) — Faustus persistence off.`)
}
await faustusStore.load() // missing -> empty; unusable -> moved aside, empty; from a newer release -> left alone, in memory only (store-file.mjs). An empty store means valuation falls through to ninja until the first refresh
// The Faustus store persists when it was last written, so its age survives a
// restart (the poe.ninja ones do not: they are measured from server start).
if (faustusStore.league() === LEAGUE) sourceHealth.seed('faustus', { lastSuccessAt: faustusStore.updatedAt() })

let faustusRefresher = null
let faustusPricer = null // hoisted: the data refresher swaps its base-names map at runtime
if (!FAUSTUS_DISABLED && faustusStoreWritable) {
  faustusPricer = createFaustusPricer({
    league: LEAGUE,
    deps: {
      // SINGLE C:D source (F2): the currency-EXCHANGE divine rate (cdMsgFor /
      // fetchCurrencyExchange) that the price-check bulk and
      // the net-worth aggregate already use. Only consulted when the Faustus
      // feed's own Divine<->Chaos market is missing this window.
      chaosPerDivineFallback: () => cdMsgFor(LEAGUE).chaosPerDivine,
      // The id->name bridge from the refresher's active copy (persisted
      // /config version if valid, baked-in otherwise).
      baseNames: await loadBaseNames(dataRefresher.baseNamesPath()),
      ...(FAUSTUS_UNION_HOURS ? { unionHours: FAUSTUS_UNION_HOURS } : {})
    }
  })
  faustusRefresher = createFaustusRefresher({
    league: LEAGUE,
    store: faustusStore,
    pricer: faustusPricer,
    intervalMs: FAUSTUS_REFRESH_MS,
    onRefreshed: () => sourceHealth.ok('faustus', { at: faustusStore.updatedAt() ?? Date.now() }),
    onFailed: (reason, kind) => sourceHealth.fail('faustus', reason, kind)
  })
  faustusRefresher.tickOnce().catch(e => console.warn('[faustus] initial refresh failed (will retry hourly):', e?.message || e)) // best-effort, non-blocking — don't delay server start on a CDN fetch
  faustusRefresher.start()
  console.log('[faustus] background refresh on (league=%s interval=%dms unionHours=%s, prices cached=%d)',
    LEAGUE, FAUSTUS_REFRESH_MS, FAUSTUS_UNION_HOURS || 8, Object.keys(faustusStore.allPrices()).length)
} else if (FAUSTUS_DISABLED) {
  console.log('[faustus] disabled via POE_FAUSTUS_DISABLED=1')
}

// ---- Corpses (Task 5): store + Trade-API pricer ----------------------------
// Itemised corpses aren't on poe.ninja/Faustus -> priced via the official Trade
// API (search+fetch through the SHARED RateLimiter, BACKGROUND priority). The
// pricer never queries during valuation: it fills a store (name->chaos, ~6h TTL,
// nulls cached) that the corpse route reads. mkdir guard identical to the other
// /config stores. Single-league (LEAGUE), like Faustus.
const CORPSE_STORE = process.env.POE_CORPSE_STORE || '/config/corpse-store.json'
const CORPSE_DISABLED = process.env.POE_CORPSE_DISABLED === '1'
const CORPSE_TTL_MS = envNum('POE_CORPSE_TTL_MS')
// 0 is a setting and it means what it says: the pricer runs and asks the Trade
// API for NOTHING. `Number(env) || 25` would answer that with 25 queries an
// hour, silently — the defect numeric-settings.mjs exists for.
const CORPSE_BUDGET_PER_HOUR = envNum('POE_CORPSE_BUDGET_PER_HOUR')
const CORPSE_INTERVAL_MS = envNum('POE_CORPSE_INTERVAL_MS')
const corpseStore = createCorpseStore(CORPSE_STORE, { ttlMs: CORPSE_TTL_MS })
let corpseStoreWritable = true
try {
  await mkdir(dirname(CORPSE_STORE), { recursive: true })
} catch (e) {
  corpseStoreWritable = false
  corpseStore.writable = false
  console.warn(`[corpse] Store folder ${dirname(CORPSE_STORE)} could not be created (${e?.code || e}) — corpse persistence off.`)
}
await corpseStore.load() // missing -> empty; unusable -> moved aside, empty; from a newer release -> left alone, in memory only (store-file.mjs). An empty store leaves corpses honestly unpriced until the first fill

// Corpse base names actually held across ALL users' latest snapshots (union of
// stored tabs). Priced corpses live in tab.items (kind 'corpse'), unpriced ones
// in tab.unpriced — collect from both, dedupe. The pricer skips 'Imperfect '.
//
// This store is SHARED between users while the searches that fill it are
// ENGLISH (corpse-pricer -> trade search). A name that is not English therefore
// does not merely stay unpriced for the one user who owns the corpse: it sits
// in everybody's store and burns a slot of the hourly trade budget on a query
// that cannot ever match. So nothing goes in that could not be brought to its
// English name first — englishCorpseName decides that, and returns null when it
// cannot (unpriced beats wrongly priced, and a search that can never hit should
// not be made at all).
//
// Whether GGG's stash API answers localized at all is still an open question
// (design doc, gate G0-3); this is the precaution for the negative outcome, and
// it is built so the positive one costs nothing — see englishCorpseName.
function collectCorpseNames () {
  const names = new Set()
  for (const user of USERS) {
    const lang = LANG_BY_USER.get(user) || PRIMARY_LANG
    const add = raw => { const en = englishCorpseName(raw, lang); if (en) names.add(en) }
    for (const tab of networthStore.tabList(user)) {
      for (const row of (tab.items || [])) if (row?.kind === 'corpse' && row.name) add(row.name)
      for (const u of (tab.unpriced || [])) if (u?.kind === 'corpse' && u.name) add(u.name)
    }
  }
  return [...names]
}

// Corpse Trade searches run ANONYMOUSLY by design — the engine transport
// (Host.proxy) does not forward a POESESSID, and the corpse pricer relies on the
// public online+priced search only. No cookie seam.
let corpsePricer = null
const corpseTradeClient = createTradeClient({ searchRaw: searchRawAs(CONSUMER.CORPSE) })
if (!CORPSE_DISABLED && corpseStoreWritable) {
  corpsePricer = createCorpsePricer({
    store: corpseStore,
    tradeClient: corpseTradeClient,
    league: LEAGUE,
    getCorpseNames: collectCorpseNames,
    chaosPerDivine: () => cdMsgFor(LEAGUE).chaosPerDivine, // SINGLE C:D source (F2): currency-exchange divine rate, same as Faustus bridge + aggregate
    enqueueBackground,
    budgetPerHour: CORPSE_BUDGET_PER_HOUR,
    intervalMs: CORPSE_INTERVAL_MS
  })
  corpsePricer.start()
  console.log('[corpse] background pricer on (league=%s ttl=%dms budget=%d/h interval=%dms, prices cached=%d)',
    LEAGUE, CORPSE_TTL_MS, CORPSE_BUDGET_PER_HOUR, CORPSE_INTERVAL_MS, Object.keys(corpseStore.data.entries).length)
  // A budget of zero is a legal setting and means exactly nothing goes out. Say
  // it in its own line: "budget=0/h" in the line above is easy to read past,
  // and this is the state somebody deliberately asked for after a rate-limit
  // scare. Already-cached prices are still served from the store.
  if (CORPSE_BUDGET_PER_HOUR === 0) {
    console.log('[corpse] POE_CORPSE_BUDGET_PER_HOUR=0 — no Trade-API query will be made; cached prices are still served')
  }
} else if (CORPSE_DISABLED) {
  console.log('[corpse] disabled via POE_CORPSE_DISABLED=1')
}

// `let`, not const: rebuilt from the new items.ndjson when the data refresher
// adopts a fresh APT snapshot (normalizeItem reads it per call).
let itemsIndex = await loadItemsIndex(dataRefresher.itemsNdjsonPath())

// ---------------------------------------------------------------------------
// Localized stash names -> English reference names
// ---------------------------------------------------------------------------
// Second derivative of the snapshot's items.ndjson, next to itemsIndex and
// rebuilt with it (see onAptData). data/<lang>/items.ndjson carries the
// localized `name` beside the same English `refName`, which is exactly the pair
// needed to undo a localized stash answer.
//
// Ambiguity is REJECTED, not resolved: if two entries share a localized name
// but not a refName, the entry is poisoned to null and the name counts as
// unresolvable. Guessing which of the two an item is would be the failure mode
// this project pays the most for — a confident wrong price.
async function loadRefNamesByLocalName (lang) {
  const map = new Map() // localized name -> refName, or null when ambiguous
  let raw
  try {
    raw = await readFile(dataRefresher.itemsNdjsonPath(lang), 'utf8')
  } catch {
    // No generated set for this language yet. Not an error: the German data is
    // produced locally and only exists after a generator run. Every name then
    // has to prove itself English (englishCorpseName) or is left out.
    return map
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (typeof e.name !== 'string' || !e.name) continue
    if (typeof e.refName !== 'string' || !e.refName) continue
    if (map.has(e.name)) { if (map.get(e.name) !== e.refName) map.set(e.name, null); continue }
    map.set(e.name, e.refName)
  }
  return map
}

// lang -> the map above, for every configured NON-primary language. English is
// absent on purpose: it needs no bridge, and its absence is what makes the
// identity path below impossible to get wrong.
const refNamesByLang = new Map()
async function reloadRefNamesByLang () {
  refNamesByLang.clear()
  for (const lang of new Set(LANG_BY_USER.values())) {
    if (lang === PRIMARY_LANG) continue
    refNamesByLang.set(lang, await loadRefNamesByLocalName(lang))
  }
}
await reloadRefNamesByLang()

// A whisper's language is the BUYER's trade-site language, not this user's
// client language, so the name data is loaded for every language a whisper
// template exists for, whoever plays here. English needs no bridge (its names
// are the reference names); a language whose items.ndjson is missing gets no
// entry (French, Russian, Spanish and Portuguese have none here): its whispers
// are still read, an item name one of the loaded languages knows exactly is
// compared, and any other ends as 'not-compared' with reason 'no-language-data'.
const WHISPER_LANGS = [...new Set(WHISPER_TEMPLATES.map(t => t.lang))]
const whisperNames = new Map() // lang -> { localToRef: Map | null, uniques: Map(name -> Set(base)) }
async function reloadWhisperNames () {
  for (const lang of WHISPER_LANGS) {
    let uniques
    try {
      uniques = await loadUniqueIndex(dataRefresher.itemsNdjsonPath(lang))
    } catch {
      whisperNames.delete(lang)
      continue
    }
    const localToRef = lang === PRIMARY_LANG ? null : await loadRefNamesByLocalName(lang)
    whisperNames.set(lang, { uniques, localToRef })
  }
}
await reloadWhisperNames()

// ---------------------------------------------------------------------------
// English reference names -> localized names, FOR DISPLAY ONLY
// ---------------------------------------------------------------------------
// The same pair table as above, read the other way round — and for the opposite
// purpose. loadRefNamesByLocalName UNDOES a localized stash answer so a name can
// be MATCHED: the value join, the trade query and every price source are keyed
// on the English reference name (see refNameOf/priceKeyOf and
// price-source-lang.test.mjs). This table is only ever used to SHOW a name, and
// nothing derived from it may travel back into a lookup — that is exactly the
// mistake that produced the pricing bugs those two guard against.
//
// It is therefore never consulted here: it is serialized once per language and
// handed to the browser (GET /item-name-map), which applies it in the renderer
// and nowhere else. Every row still travels under its English name.
//
// Ambiguity is rejected in this direction too: two entries carrying the same
// refName but different localized names leave that refName out, so the English
// name stays on screen. An English name is readable; a coin flip is a lie.
// Entries whose two names are equal are left out as well — they would only pad
// the payload without changing a single character on the page.
async function loadLocalNamesByRefName (lang) {
  const map = new Map() // refName -> localized name, or null when ambiguous
  let raw
  try {
    raw = await readFile(dataRefresher.itemsNdjsonPath(lang), 'utf8')
  } catch {
    // No generated set for this language yet (the German data is produced
    // locally). Same consequence as everywhere else: English names on screen,
    // which is the state before this feature existed.
    return map
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (typeof e.name !== 'string' || !e.name) continue
    if (typeof e.refName !== 'string' || !e.refName) continue
    if (e.name === e.refName) continue
    if (map.has(e.refName)) { if (map.get(e.refName) !== e.name) map.set(e.refName, null); continue }
    map.set(e.refName, e.name)
  }
  return map
}

// lang -> the map above, for every configured NON-primary language, plus the
// serialized answer the endpoint hands out. English is absent for the same
// reason as in refNamesByLang: it needs no bridge, and its absence is what
// makes the identity path impossible to get wrong.
const localNamesByLang = new Map()
const localNamesJson = new Map()
async function reloadLocalNamesByLang () {
  localNamesByLang.clear()
  localNamesJson.clear()
  for (const lang of new Set(LANG_BY_USER.values())) {
    if (lang === PRIMARY_LANG) continue
    localNamesByLang.set(lang, await loadLocalNamesByRefName(lang))
  }
}
await reloadLocalNamesByLang()

// The body of GET /item-name-map for one language, built once and kept until
// the next snapshot swap drops it (reloadLocalNamesByLang).
function itemNameMapJson (lang) {
  const cached = localNamesJson.get(lang)
  if (cached) return cached
  const names = {}
  for (const [ref, local] of (localNamesByLang.get(lang) || new Map())) {
    if (local) names[ref] = local // null == ambiguous -> stays English
  }
  const json = JSON.stringify({ lang, names })
  localNamesJson.set(lang, json)
  return json
}

// Third derivative of the active snapshot, next to itemsIndex and
// refNamesByLang — but LAZY, unlike those two: the pair table is only read once
// a non-primary language actually has an unresolved mod line, which on an
// English-only installation never happens (mod-text-pairs.mjs argues the size).
// Dropped on every snapshot swap in onAptData, so the table and the data set
// the engine parses with are always from the same generator run.
const modTextBridge = createModTextBridge({
  resolvePath: lang => dataRefresher.textPairsPath(lang)
})

// Names already reported as undroppable, so a two-minute pricer tick cannot
// turn one unmappable corpse into an endless log (same idea as ninja.mjs's
// warnNetOnce).
const corpseNameWarned = new Set()

// The English name for a corpse out of `lang`'s stash answer, or null when it
// cannot be established.
//
// For a user on the primary language this is the IDENTITY — not a lookup that
// happens to succeed, but a branch taken before any lookup exists. That is the
// no-op guarantee: with everybody on English, not one name can be dropped, no
// matter what the data set says.
//
// For anyone else, English comes first anyway: should the stash API turn out to
// answer English regardless of client language (G0-3 positive), the name is
// already a reference name and passes through untouched. Only what is neither a
// known reference name nor resolvable through the localized set is dropped.
function englishCorpseName (name, lang) {
  if (lang === PRIMARY_LANG) return name
  if (itemsIndex.byName.has(name)) return name
  const ref = refNamesByLang.get(lang)?.get(name) // null == ambiguous, undefined == unknown
  if (ref) return ref
  if (!corpseNameWarned.has(name)) {
    corpseNameWarned.add(name)
    console.warn('[corpse] "%s" (%s) has no English reference name — not stored, not searched', name, lang)
  }
  return null
}

// Snapshot aggregated from whatever the store currently holds for a user
// (union of all persisted tabs), or null when the store has nothing yet. Uses
// the meta frozen at scan time (league + C:D) so a replay matches the scan.
// `tabs` is a parameter only so a caller that also needs the stored tabs
// themselves (recordNetworthHistory does, for the uncapped unpriced names) can
// read the list ONCE and be certain both halves describe the same moment.
//
// `belowMarket` rides along: the stored price notes under the market value
// (networth/listing-audit.mjs). A note in divine is converted at the CURRENT
// Chaos:Divine rate and, like a buyer's whisper, not at all while that rate is
// the fallback or stale (divineRate). The threshold is the whisper verdict's
// own POE_WHISPER_LOW_RATIO. At most BELOW_MAX rows travel, the biggest
// losses, with the number left out (`more`).
function networthSnapshot (user, tabs = networthStore.tabList(user)) {
  if (!tabs.length) return null
  const meta = networthStore.getMeta(user) || {}
  const league = meta.league || users.get(user)?.league || LEAGUE
  const cdRatio = meta.cdRatio ?? cdMsgFor(league).chaosPerDivine
  const snap = aggregate({ tabs, cdRatio, league, accountName: meta.accountName ?? null })
  const rate = divineRate(league)
  snap.belowMarket = auditListings(tabs, {
    chaosPerDivine: rate.chaos,
    divineRateKnown: rate.chaos != null && !rate.fallback,
    lowRatio: WHISPER_LOW_RATIO,
    highRatio: WHISPER_HIGH_RATIO
  })
  return snap
}

// One history point from the CURRENT snapshot (the refresher calls this after
// every synced tab; history.append() throttles it down to one point/minute).
// The C:D ratio of THIS moment travels with the point so an old value never
// gets re-derived with today's ratio. Fire-and-forget: a failing history write
// must never disturb the refresher.
// Users the recorder is currently refusing points for, so the two log lines
// below fire on the TRANSITION instead of once per tab. A gap in the series
// that says nothing about itself is the same dead end the price guard's log
// line exists to avoid.
const historyPausedFor = new Set()
// Users the recorder has already said it is recording over an incomplete
// account for, so the line fires on the transition rather than once a tab.
const historyUnreadWarned = new Set()

// Which stash tabs the recorder last saw a user's snapshot summed over. The
// rule lives in networth/history.mjs next to the `tabsChanged` it feeds, so the
// recorder and its tests cannot drift apart on it.
const networthTabWatch = createTabSetWatch()

// ---- Farm-session helpers ----------------------------------------------------
// Arrivals the price brake currently records at no value for this user — a
// session names them instead of silently missing them.
function withheldArrivals (user) {
  const out = []
  for (const h of networthPriceGuard.held.values()) if (h.user === user && h.price === 0) out.push(h.name)
  return out
}
function sessionMsg (user) {
  return { type: 'networth-session', now: Date.now(), ...networthSessions.live(user, networthHistory.latest(user)) }
}
// Every start, end and change of state of a session goes through here: the
// round the refresher is asked to read first, the daemon's feed (`session`
// events) and the `networth-session` message (networth/session-control.mjs).
// networthRefresher, daemonFeed and daemonPresence are declared further down;
// these closures run only after the boot, when they are set (the refresher
// stays null with POE_NETWORTH_AUTOSYNC=0, and then no session starts).
const sessionControl = createSessionControl({
  sessions: networthSessions,
  latestOf: user => networthHistory.latest(user),
  withheldOf: user => withheldArrivals(user),
  refresher: () => networthRefresher,
  pushFeed: (user, session, opts) => feedSession(user, session, opts),
  onChange: user => broadcast(user, sessionMsg(user)),
  presenceOf: user => daemonPresence.presenceOf(user),
  autoGame: SESSION_AUTO_GAME,
  gapMs: SESSION_GAME_GAP_MS,
  finalizeMaxMs: SESSION_FINALIZE_MAX_MS
})
async function onSessionPoint (user) {
  await sessionControl.onPoint(user)
}
// A tab that appeared or vanished, or another league: the whole content counts
// as a change, so an open session is marked as no farming result.
function noteSessionStashChanged (user) {
  networthSessions.noteStashChanged(user)
    .then(marked => { if (marked) broadcast(user, sessionMsg(user)) })
    .catch(() => {})
}

// `coverage` is what the refresher knows and this level does not: whether the
// store can answer for EVERY live stash tab yet. While it cannot, the snapshot
// is a sum over a subset of the account and must not become a point — see the
// note on history.append().
function recordNetworthHistory (user, coverage = null) {
  const storedTabs = networthStore.tabList(user)
  const snap = networthSnapshot(user, storedTabs)
  if (!snap) return
  if (coverage && coverage.complete === false) {
    if (!historyPausedFor.has(user)) {
      historyPausedFor.add(user)
      console.log('[networth-history] no points for %s until the sync covers the whole account (%d of %d tabs so far)',
        user, coverage.tabsCovered, coverage.tabsTotal)
    }
  } else if (historyPausedFor.delete(user)) {
    console.log('[networth-history] %s covered again (%d tabs) — recording resumed', user, coverage?.tabsTotal ?? 0)
  }
  // `tabsRead` is the part of "covered" that is an actual reading. Covered and
  // not read means the round-robin has been past a tab and got nothing storable
  // out of it, which is allowed to continue for ever (its absence is a constant
  // in every point, not a dip in one) — but it must not do so silently, because
  // every point recorded meanwhile is a sum over less than the account.
  if (coverage && coverage.complete && Number.isFinite(coverage.tabsRead) &&
      coverage.tabsRead < coverage.tabsTotal && !historyUnreadWarned.has(user)) {
    historyUnreadWarned.add(user)
    console.warn('[networth-history] recording for %s over %d of %d tabs — %d have been tried and never yielded a reading, ' +
      'so every point is a sum over the rest of the account',
      user, coverage.tabsRead, coverage.tabsTotal, coverage.tabsTotal - coverage.tabsRead)
  } else if (coverage && Number.isFinite(coverage.tabsRead) &&
      coverage.tabsRead >= coverage.tabsTotal && historyUnreadWarned.delete(user)) {
    console.log('[networth-history] every tab of %s reads again (%d)', user, coverage.tabsTotal)
  }
  // A tab set that differs from the one the last point was summed over. Not a
  // stock movement, and indistinguishable from one in the delta — see the note
  // on history.append(). One point is refused, the breakdown is dropped, and
  // the next point starts the diff over on the new set.
  const tabSet = networthTabWatch.look(user, snap)
  if (tabSet.changed) {
    console.warn('[networth-history] the stash tabs %s is summed over changed (%d now, %d before) — ' +
      'one point is skipped and the item diff starts over, because a tab appearing or disappearing ' +
      'is not stock moving (docs/bugs.md B2)',
      user, tabSet.tabs, tabSet.before)
    noteSessionStashChanged(user)
  }
  // items travel along so the history can diff them against the previous point
  // (quantity vs price movers behind a jump) and so the price guard can name
  // the source of a number it rejects. Only name/qty/chaos/source are read from
  // them; nothing account-identifying goes near the file.
  //
  // unpriced travels for ONE reason: it is the proof that a name which fell out
  // of `items` is still in the stash. Without it the diff reads a lost price as
  // an item leaving and a regained one as an item arriving, and the events list
  // — which promises stock movements and nothing else — filled up with mirror
  // pairs on an untouched stash (docs/bugs.md B2). It adds no value to any
  // total.
  //
  // AND IT IS NOT `snap.unpriced`. That list is capped at 100 names for the
  // page's sake, and the names it drops are the rarest ones — the same thinly
  // traded items that drift in and out of being priced, i.e. precisely the
  // population this proof exists for. A name ranked out of the display list
  // would be invisible here and read as gone. So the
  // uncapped account-wide fold of the stored tabs is what travels; it stays
  // inside the server, so the snapshot the browser gets keeps its cap and its
  // size. Older stored tabs still carry a capped list of their own and cannot be
  // helped until the refresher writes them again — completeness returns tab by
  // tab, and nothing gets worse in the meantime.
  networthHistory.append(user, {
    totalChaos: snap.totalChaos,
    cdRatio: snap.cdRatio,
    items: snap.items || [],
    unpriced: unpricedStock(storedTabs),
    tabsChanged: tabSet.changed,
    syncComplete: coverage ? coverage.complete : undefined
  })
    .then(recorded => {
      // A recorded point also advances any open farm session; a refused one
      // does not.
      if (recorded) onSessionPoint(user).catch(e => console.warn(`[networth-sessions] update failed: ${e?.message || e}`))
    })
    .catch(e => console.warn(`[networth-history] append failed: ${e?.message || e}`))
}

// ---- Net-worth sync status (per user, for the UI status line) ---------------
// Credentials are re-read on every call (small file; called on WS connect, on
// a refresher status change and on a settings save — not in a hot loop) so the
// answer always reflects the file as it is NOW. The refresher contributes its
// pause/cooldown state via statusFor; 'missing' is decided here because only
// this level knows whether the file holds an entry at all. The poesessid is
// passed INTO statusFor for comparison and never travels any further.
async function networthSyncStatus (user) {
  let creds
  try {
    creds = await loadNetworthUsers({ defaultUser: USERS[0] })
  } catch {
    // Unreadable/corrupt credential file -> no creds usable for this user.
    return { state: 'missing' }
  }
  const cred = creds[user]
  if (!cred) return { state: 'missing' }
  if (!networthRefresher) return { state: 'ok' } // autosync off/store read-only: nothing can be paused
  return networthRefresher.statusFor(user, cred.poesessid)
}

// WS message for the M2 status line (see PROTOCOL.md `networth-sync-status`).
//
// `lastTab` and `current` are the answer to B5: `state: "ok"` alone described
// both a refresher walking the stash and one whose single step had been stuck
// for ten minutes. Neither field carries a cookie or an account name — a
// timestamp, a stash-tab name of THIS user, and a phase. Both are optional and
// only present when the refresher has something to report.
function syncStatusMsg (status) {
  const msg = { type: 'networth-sync-status', state: status.state }
  if (status.until) msg.until = status.until
  // Only meaningful next to a cooldown: a stash 429 pauses EVERY user (the
  // refresher cannot tell whether GGG counted it per session or per address),
  // so the status line has to say whether this room is the cause or a bystander.
  if (status.mine != null) msg.mine = status.mine
  // ...and the other reason a cooldown can be on: the trade-API ban gate holds
  // the stash path too (B14). Same state, one field of difference, because the
  // remedy is not the same one — this one is waited out, not fixed here.
  if (status.tradeBan) msg.tradeBan = true
  if (status.lastTab) msg.lastTab = status.lastTab
  if (status.current) msg.current = status.current
  // Sync follows the game: only for a user whose daemon reports the game not
  // running, and only while the background sync runs (refresher statusFor).
  if (status.pace) msg.pace = status.pace
  // A session round: every tab of this user read once since a session's start
  // or end, within the user's own ticks (refresher.mjs, A SESSION ROUND).
  if (status.sessionRound) msg.sessionRound = status.sessionRound
  return msg
}

function broadcastSyncStatus (user) {
  networthSyncStatus(user)
    .then(st => broadcast(user, syncStatusMsg(st)))
    .catch(() => {})
}

// WS message for the M2 status line (see PROTOCOL.md `data-status`): the raw
// facts of the data auto-update — when each source was last checked
// successfully, plus the threshold. The client ages them itself, so a schedule
// that stopped pushing anything still turns stale in the UI on its own.
//
// `reason`/`failKind` ride along (docs/bugs.md B24): the
// DURATION and the CONSEQUENCE alone say nothing about the cause, so "the
// endpoint is briefly away" and "this build cannot read the format any more"
// would produce the same sentence for days. The reason is foreign text —
// filtered and capped by the refresher before it is persisted (check-failure.mjs)
// — and `failKind` is the class the failing code named, never one derived from
// the wording here; the page maps a class it does not know to no advice at all.
function dataStatusMsg () {
  const st = dataRefresher.status()
  return {
    type: 'data-status',
    enabled: st.enabled && !DATA_REFRESH_DISABLED,
    intervalMs: st.intervalMs,
    staleAfterMs: st.staleAfterMs,
    since: st.since,
    now: st.now,
    sources: st.sources.map(s => ({
      source: s.source,
      lastSuccessAt: s.lastSuccessAt,
      lastOutcome: s.lastOutcome,
      reason: s.lastReason ?? null,
      // The last gate before the wire, and what isFailKind() is for: the page
      // maps a class to a sentence, so a value it cannot map is a missing key
      // on screen or — worse — the wrong remedy. Anything this build does not
      // know leaves as null, which the page reads as "no advice".
      failKind: isFailKind(s.lastFailKind) ? s.lastFailKind : null,
      // Something a check that SUCCEEDED has to say. Beside the reason rather
      // than inside it, because it is not one: the tick did its job. The page
      // shows it without waiting for anything to go stale — a set frozen on a
      // pinned patch never goes stale, which is the whole problem with it.
      warning: s.lastWarning ?? null
    }))
  }
}

// ---------------------------------------------------------------------------
// Static file serving (locked to FE_DIR) — 1:1 like the mock
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.map': 'application/json'
}

async function serveStatic (urlPath, res) {
  const clean = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '')
  const filePath = join(FE_DIR, clean)
  if (!filePath.startsWith(FE_DIR)) { res.writeHead(403).end(); return }
  try {
    const s = await stat(filePath)
    const target = s.isDirectory() ? join(filePath, 'index.html') : filePath
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
  }
}

// The language THE GAME CLIENT runs in for this user. Reads the same
// configuration as the display language (POE_USER_LANGS, overridden per user by
// /user-lang — which the settings page calls "the user's own client language"),
// and is deliberately its OWN function anyway: it answers a different question.
// The display lookups ask "how should this be spelled for the person reading
// the page"; this one asks "what will the game match". They agree today because
// one setting feeds both, and they must stay separately named so that the day
// they stop agreeing, only one of them moves. A wrong answer here highlights the
// wrong stash slots; it can never reach a price.
const gameClientLang = user => LANG_BY_USER.get(user) || PRIMARY_LANG

// ---------------------------------------------------------------------------
// Item name universe (GET /item-names) — ground truth for the Stash-Highlight
// ---------------------------------------------------------------------------
// The highlight generator shortens each wanted item name to the smallest piece
// that matches NOTHING ELSE. "Nothing else" may not be read as "nothing else in
// the player's stash": PoE item families share suffixes ("... Scarab of
// Discernment" exists for Ambush, Breach, Harbinger, ...), so a piece that looks
// unique against one's own snapshot still lights up the whole family in-game —
// those variants are simply not owned and therefore in no ownership-derived
// list. Only the complete name list settles it.
//
// Delivered as one flat name array (~4700 entries, ~90 KB, ~29 KB gzipped),
// parsed once per language and cached until the next snapshot swap. Names only
// — the frontend needs nothing else from these records, and the icons/
// namespaces would blow the payload up tenfold. No category filter either: any
// item class can share a stash tab, and the list is small enough that guessing
// categories would only add a way to be wrong.
//
// ── The language of this list is the GAME CLIENT's, not the page's (B10) ────
// Every other localized thing on the net-worth page is DISPLAY: it answers "how
// should this be spelled for the person reading". The highlight answers a
// different question — "what will the game's stash search match" — and the game
// matches the names IT shows. A German client searching for "Chaosscherbe"
// finds nothing when handed an English fragment. Same configured value today
// (see gameClientLang), a different question, and a different failure mode: a
// wrong entry here highlights the wrong stash slots, it can never misprice
// anything.
//
// ── Why the whole universe has to move languages together ──────────────────
// The generator shortens a wanted name against the universe. Localizing only
// the WANTED names while the universe stayed English would shorten against the
// wrong universe — fragments that look unambiguous among English names but
// collide among German ones — which is the "14 slots instead of 9" failure the
// universe was introduced to fix, reintroduced through the back door. So the
// endpoint ships the universe in the client's language, and the ref -> client
// name table needed to move the wanted names into that same language, in ONE
// answer. They cannot get out of step because they are built from one file.
//
// Payload shape avoids saying every localized name twice:
//   { lang, names: [...], byRef: { englishRefName: clientName } }
// `names` holds only the entries that need no translation; the universe the
// page uses is names ∪ values(byRef). For the primary language `byRef` is empty
// and `names` is exactly the list this endpoint has always returned.
const itemNamesJsonByLang = new Map() // lang -> serialized body

async function loadItemNamesJson (lang = PRIMARY_LANG) {
  const cached = itemNamesJsonByLang.get(lang)
  if (cached) return cached
  const raw = await readFile(dataRefresher.itemsNdjsonPath(lang), 'utf8')
  const set = new Set()
  const pairs = new Map() // refName -> client name, or null once ambiguous
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const name = typeof e.name === 'string' && e.name ? e.name : null
    const ref = typeof e.refName === 'string' && e.refName ? e.refName : null
    if (lang === PRIMARY_LANG) {
      // name = display name, refName = the English reference name; for uniques
      // and a few bases they differ, and BOTH can show up in a stash search.
      if (name) set.add(name)
      if (ref) set.add(ref)
      continue
    }
    // Localized set: `name` is what the client PRINTS, and that is the only
    // string its stash search can match — the English refName is invisible in
    // that client and would only make every fragment longer for nothing. So
    // every localized name goes into the universe here, translated or not.
    if (!name) continue
    set.add(name)
    if (!ref || ref === name) continue
    // Ambiguous (two lines claim one refName with different spellings) -> no
    // translation for that ref, exactly like the display table: that one name
    // keeps its English spelling in the regex. Both spellings stay in the
    // universe above, because the client really does print both somewhere. A
    // locally generated German set was measured for this: zero such refNames —
    // a shape guard, not a live case.
    if (pairs.has(ref)) { if (pairs.get(ref) !== name) pairs.set(ref, null); continue }
    pairs.set(ref, name)
  }
  const byRef = {}
  for (const [ref, name] of pairs) if (name) byRef[ref] = name
  // Say every localized spelling ONCE: whatever `byRef` already carries as a
  // value drops out of `names`, and the page unions the two back together.
  // Halves the German payload; for the primary language byRef is empty and the
  // list is byte-for-byte the one this endpoint always returned.
  for (const name of Object.values(byRef)) set.delete(name)
  const json = JSON.stringify({ lang, names: [...set].sort(), byRef })
  itemNamesJsonByLang.set(lang, json)
  return json
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Minimal cookie parser (no package) — "a=1; b=2" -> { a:'1', b:'2' }.
function parseCookies (header) {
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (!k) continue
    let v = part.slice(i + 1).trim()
    try { v = decodeURIComponent(v) } catch { /* leave raw */ }
    out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-user state (rooms). One room per USER: own clients, own items,
// own league. The queue (jobs/working/...) stays GLOBAL & shared.
// ---------------------------------------------------------------------------
// A single hotkey press can land the SAME item in the clipboard as two
// slightly different raw texts a poll apart (uniques carry a trailing flavour-
// text block that rares/currency/gems don't -> the clipboard's XWayland bridge
// can surface it a beat late, so the daemon's exact-text de-dupe sees "two new
// items" and POSTs both). Both parse to the same item -> without this guard the
// server mints two ids -> two identical cards. Collapse re-POSTs of the same
// parsed item (same user) within this window into the existing card.
const REPOST_DEDUP_MS = 2000
// Cap on how many item cards a room keeps server-side. Cards live until the
// user dismisses them (no TTL) and each pins a ParsedItem + presets + last
// price, so an unbounded Map is a slow memory leak for a long-running server.
// Keep the NEWEST N; adding an (N+1)th card evicts the OLDEST alive one (and
// tells that room via `item-removed`). N=50 is far above a realistic on-screen
// working set, so a normal session never notices the cap.
// A cap of 0 would make the `size > cap` while-loops below (eviction,
// reconnect-trim) delete every card as fast as it is created, so the table
// refuses it with a floor of 1 — and says so, which `Math.max(1, …)` never did.
const MAX_ITEMS_PER_ROOM = envNum('POE_MAX_ITEMS_PER_ROOM')
// Cap on how many priceless cards a single WS reconnect re-enqueues. After a
// poe.ninja/Trade outage a room can hold many cards without a valid price;
// re-queueing ALL of them on a reconnect would flood the queue the moment the
// service comes back. Re-queue only the NEWEST N; the rest still replay as
// `queued` and the user can trigger a search on demand.
// 0 is honoured here and means "re-queue nothing": a re-queued card is an
// `auto` Trade-API search, so this is the one of the seven settings of
// docs/bugs.md B13 where a refused zero costs requests.
const MAX_REQUEUE_ON_RECONNECT = envNum('POE_MAX_REQUEUE_ON_RECONNECT')
// lastItemAt/lastItemOutcome: when the last POST /item of this user arrived and
// what became of it (daemon-status, memory only; null until the first one).
const users = new Map() // user -> { clients:Set<ws>, items:Map, league:string, lang:string, recentPosts:Map, lastItemAt:number|null, lastItemOutcome:string|null }
for (const u of USERS) users.set(u, { clients: new Set(), items: new Map(), league: LEAGUE, lang: LANG_BY_USER.get(u), recentPosts: new Map(), lastItemAt: null, lastItemOutcome: null })

// The hotkey daemon's own channel (PROTOCOL.md, `GET /daemon/events`): a feed
// per room, filled from broadcast() below, and what the daemons report about
// themselves. Memory only; reading either never queues, fetches or prices.
const DAEMON_POLL_MAX_HOLD_MS = envNum('POE_DAEMON_POLL_MAX_HOLD_MS')
const DAEMON_WAITERS_MAX = envNum('POE_DAEMON_WAITERS_MAX')
// The largest body POST /daemon/heartbeat reads; its JSON is a few hundred bytes.
const DAEMON_BEAT_BODY_MAX = 4096
const daemonFeed = createDaemonFeed({
  users: USERS,
  keep: envNum('POE_DAEMON_EVENTS_KEEP'),
  waitersMax: DAEMON_WAITERS_MAX,
  maxAgeMs: envNum('POE_DAEMON_FEED_MAX_AGE_MS'),
  // Jobs ahead of this card in the shared queue, the running one included.
  // Read at call time (jobs/working are declared below), never at boot.
  positionOf: (user, id) => {
    const i = jobs.findIndex(j => j.user === user && j.id === id)
    return i < 0 ? null : i + (working ? 1 : 0)
  },
  // A rate poe.ninja actually gave for this league, or null: the built-in
  // fallback (cdMsgFor, trendHint 'fallback') is no market rate.
  cdFor: league => {
    if (!league) return null
    const m = cdMsgFor(league)
    return m.trendHint === 'fallback' ? null : (Number(m.chaosPerDivine) || null)
  }
})
// A throw inside the feed is logged once per text and never stops a browser
// message, pump() or POST /item (daemon-feed.mjs, guarded): the card is still
// queued and answered 200.
const noteFeed = guarded(daemonFeed.noteBroadcast, console.warn)
const refreshFeedQueue = guarded(daemonFeed.refreshQueued, console.warn)
const trackFeed = guarded(daemonFeed.track, console.warn)
const refreshFeed = guarded(daemonFeed.refresh, console.warn)
const earlyFeed = guarded(feedEarlyAnswer, console.warn)
const feedSession = guarded((user, session, opts) => daemonFeed.pushSession(user, session, opts), console.warn)

// Early answer for the game (daemon feed): an exchange rate is known at the
// POST, from memory, with the same guards the queued job uses (pump() reads
// the same function first), so the in-game card need not wait for the queue.
// The job's own result replaces it. Never a request.
function feedEarlyAnswer (user, id, item, league) {
  const early = faustusChaosFor(item, league)
  if (early == null) return
  const r = faustusRangeFor(item, league)
  daemonFeed.hint(user, id, {
    source: 'exchange',
    currency: 'chaos',
    median: roundExchange(early),
    low: roundExchange(r ? r.min : early),
    high: roundExchange(r ? r.max : early),
    count: null,
    ageHours: faustusStaleHoursFor(item, league),
    conflict: false
  })
}
const daemonPresence = createDaemonPresence({ staleMs: envNum('POE_DAEMON_BEAT_STALE_MS'), onChange: onPresenceChange })
// Buyer whispers of this session (POST /daemon/whisper), per user, memory
// only, with the daemon's pseudonym and never a buyer's name; a restart
// forgets them. Declared here because daemonStatusMsg reads the count of
// unrecognised ones. The largest body the route reads.
const whisperBook = createWhisperBook({ users: USERS, keep: envNum('POE_WHISPER_KEEP') })
const whisperRate = createRateGate({ perMin: envNum('POE_WHISPER_MAX_PER_MIN') })
const DAEMON_WHISPER_BODY_MAX = 4096
// The largest body POST /daemon/session reads; `{"action":"toggle"}` is 19 bytes.
const DAEMON_SESSION_BODY_MAX = 1024
// Session-key requests per user and minute (each accepted start or end writes
// the sessions file); the same sliding-minute gate as the whispers'.
const daemonSessionRate = createRateGate({ perMin: envNum('POE_DAEMON_SESSION_MAX_PER_MIN') })
// Value-grid requests (GET /daemon/stash-grid) per user and minute. A fixed
// number and no setting: the daemon asks once per key press, and one press a
// second is already more than anyone steps through stash tabs; the gate only
// stops a stuck key or a loop. Each request reads the store, never GGG.
const daemonGridRate = createRateGate({ perMin: 60 })
// One line per presence edge (never one per beat), and the page hears of it.
// presenceEdges counts them, so the heartbeat route can tell whether its beat
// already sent the page an update.
let presenceEdges = 0
function onPresenceChange (user, before, after) {
  presenceEdges++
  const st = daemonPresence.statusOf(user)
  console.log(`[daemon] ${user}: ${before} -> ${after} (daemon ${st?.version || 'unknown'})`)
  const room = users.get(user)
  if (room) broadcast(user, daemonStatusMsg(room, user))
  // A change of who plays can move every user's net-worth pace (the refresher
  // decides whose tab a tick reads). The refresher says so again with its next
  // tick through onStatus; twice is harmless, missing would be silent.
  for (const u of USERS) broadcastSyncStatus(u)
  // The game starts or ends a game session (networth/session-control.mjs).
  sessionControl.onPresence(user, before, after)
}
// The hold after a game stops (daemon-presence.mjs makeHoldAfterGame): the
// player keeps the playing pace until each of their tabs was read once since
// the stop, at most POE_SYNC_AFTER_GAME_MAX_MS. networthRefresher is assigned
// further down; until then (and with the background sync off) there is no
// round to ask, and there is no pace to hold either.
const holdAfterGame = makeHoldAfterGame({
  maxMs: SYNC_AFTER_GAME_MAX_MS,
  roundSince: (u, t) => networthRefresher?.roundSince(u, t) ?? null
})
// A daemon that goes silent is an edge too, and no request would notice it.
// The sweep also names the users who lost a daemon without a presence edge
// (one that could not tell the game state went quiet): their page still shows
// it as reporting, so it gets a daemon-status as well.
// The same tick ends a game session whose gap has run out and moves sessions
// past their windows (networth/session-control.mjs sweep); memory and the
// sessions file only.
setInterval(() => {
  for (const user of daemonPresence.sweep(USERS)) {
    const room = users.get(user)
    if (room) broadcast(user, daemonStatusMsg(room, user))
  }
  sessionControl.sweep(USERS).catch(e => console.warn(`[networth-sessions] sweep failed: ${e?.message || e}`))
}, 30_000).unref()

const jobs = []            // waiting jobs (FIFO; priority ones get pulled forward); each carries `user`
const bgJobs = []           // three-tier queue, lowest tier: background jobs
// (job objects here carry `run` instead of user/id — pump() detects them by that, see below)
let working = false        // a job is currently running
let currentPriority = false
let currentJob = null       // currently running job (duplicate guard on re-enqueue)
let idSeq = 0

const send = (ws, obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)) }

// Broadcast only into one user's room.
function broadcast (user, obj) {
  const room = users.get(user)
  if (!room) return
  // The one funnel for room messages, so the daemon feed cannot miss a card
  // whatever sends it. Guarded: the browser gets the message regardless.
  noteFeed(user, obj)
  const s = JSON.stringify(obj)
  for (const ws of room.clients) if (ws.readyState === ws.OPEN) ws.send(s)
}

// Broadcast to ALL clients of all rooms (only for the shared queue-status).
function broadcastAll (obj) {
  const s = JSON.stringify(obj)
  for (const room of users.values()) for (const ws of room.clients) if (ws.readyState === ws.OPEN) ws.send(s)
}

// Broadcast to all users currently on THIS league (poll/warm).
function broadcastLeague (league, obj) {
  for (const [user, room] of users) if (room.league === league) broadcast(user, obj)
}

// WS message for the Price Check page's empty state (PROTOCOL.md
// `daemon-status`): when the last POST /item of THIS user arrived and what
// became of it. The daemon's journal says why a POST failed on the player's
// machine; this is the other end, and the only sign in the browser that the
// daemon reaches the server at all — a prefix that drops every item and a
// daemon that is not running both look like an empty page. Memory only: a
// restart starts at null, and the page words null as "since the server started".
// `daemon` is what the user's hotkey daemon last reported about itself
// (POST /daemon/heartbeat: version, game, features), null until one did.
function daemonStatusMsg (room, user) {
  return {
    type: 'daemon-status', lastItemAt: room.lastItemAt, outcome: room.lastItemOutcome, now: Date.now(),
    daemon: daemonPresence.statusOf(user),
    // Whispers from this user's daemon that matched no known template since
    // the server started (their text is not kept).
    unparsed: whisperBook.unparsed(user)
  }
}

function noteDaemonItem (user, room, outcome) {
  room.lastItemAt = Date.now()
  room.lastItemOutcome = outcome
  broadcast(user, daemonStatusMsg(room, user))
}

// Enforce MAX_ITEMS_PER_ROOM: evict the OLDEST alive card(s) once a room is over
// the cap. `room.items` is a Map -> insertion order, so the first key is the
// oldest card (dismiss deletes entries, so every entry here is alive). Evicting
// also drops any pending queue work for that id and tells the room via the
// additive `item-removed` message (unknown types are ignored by older clients,
// see PROTOCOL.md). Call AFTER inserting the new card: the newest card is never
// the one evicted.
function enforceItemCap (user, room) {
  while (room.items.size > MAX_ITEMS_PER_ROOM) {
    const oldestId = room.items.keys().next().value
    const rec = room.items.get(oldestId)
    if (rec) rec.alive = false
    room.items.delete(oldestId)
    // recentPosts is keyed by item fingerprint (not id) and self-expires via the
    // REPOST_DEDUP_MS sweep, so nothing to clean here.
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].user === user && jobs[i].id === oldestId) jobs.splice(i, 1)
    broadcast(user, { type: 'item-removed', id: oldestId })
  }
}

// ---- Mapping ParsedItem/preset -> protocol ---------------------------------
const slug = s => String(s || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
const makeId = item => `${slug(item.name || item.info?.name)}-${++idSeq}`

function rarityOf (item) {
  switch (item.category) {
    case 'Currency': return 'currency'
    case 'Gem': return 'gem'
    case 'Divination Card': return 'divination'
  }
  return String(item.rarity || 'Normal').toLowerCase()
}

// FilterTag -> protocol `kind` (implicit|explicit|prefix|suffix|fractured|crafted).
// Stat filters don't distinguish prefix/suffix; pseudo/property/explicit -> explicit.
function tagToKind (tag) {
  switch (tag) {
    case 'implicit': return 'implicit'
    case 'enchant': return 'implicit'
    case 'fractured': return 'fractured'
    case 'crafted': return 'crafted'
    default: return 'explicit'
  }
}

const modText = s => String(s.text).replace(/\n/g, ' / ')

// Mods the bundled APT stat DB can't map to a trade id land in
// item.unknownModifiers — invisible to the search even though GGG itself lists
// them. Resolve them against GGG's public stat catalogue and splice them back
// into preset.stats as REAL stats, so they price like any other mod.
// The catalogue lives on /api/trade/data/stats — same host, own policy. Its (at
// most one per TTL) request is tagged here too, so it can never show up as
// 'unknown' in the audit; trade-stats.mjs stays unaware of the bookkeeping.
const tradeStatIndex = createTradeStatIndex({
  fetchImpl: (...args) => withConsumer(CONSUMER.STAT_CATALOGUE, () => fetch(...args))
})

// A corruption implicit (or any unresolved mod) is PERMANENT on the item — it
// can't be rerolled away — so it goes in ACTIVE (disabled:false) with min = the
// item's own roll, matching how every other mod defaults ("rolls >= mine"). The
// roll range comes from the line itself when the copy carried it (see
// splitRollRanges); a line without one gets a checkbox and no slider (modsOf
// only emits valueRange when bounds exist) — honest: we know the stat, not its
// roll range.
//
// The catalogue is ENGLISH, so a localized mod line needs one more step before
// it: the de->en text pair table (design doc, section 5). resolveUnknownMod
// keeps that step out of the primary language entirely — for English this
// function is the call that has always been here, not a lookup that happens to
// come out the same.
async function resolveUnknownMod (text, type, lang) {
  if (lang === PRIMARY_LANG) return tradeStatIndex.resolve(text, type)
  // Unknown OR ambiguous both arrive as null, and both end the same way: the
  // line stays read-only on the card and is counted in the gap view. Falsely
  // priced is worse than unpriced.
  const english = await modTextBridge.toEnglish(text, lang)
  if (!english) return null
  // The pair table's English side is APT's matcher form, which carries no
  // literal sign — resolveMatcherForm is the entry point that knows that.
  return tradeStatIndex.resolveMatcherForm(english, type)
}

// Ctrl+Alt+C ("Advanced Mod Descriptions") — the copy form this tool asks its
// users to bind — writes the ROLL together with the range it came out of:
//
//   +310(260-320) zu Rüstung        20(20-22)% erhöhten Schaden
//   1(0-3) Füllung                  Fügt 12(10-15) bis 25(20-30) Schaden hinzu
//
// GGG's stat catalogue lists none of that, only "+# to Armour", and
// normalizeStatText masks digits without touching the brackets — so the two
// texts can never meet and the repair path is dead for the NORMAL copy form, in
// every language (English hits it identically). The bracket has to go before
// the lookup; the number in front of it must not.
//
// Same shape the vendored engine reads a roll in (_statPlaceholderGenerator,
// renderer/src/parser/stat-translations.ts) — deliberately, so "what is a roll"
// cannot drift between the parser and this. Sign optional, decimal point
// optional, a bracket with one bound ("# uses remaining") as well as two, and a
// negative lower bound (the leading `.` in the min group) all come from there.
const ADVANCED_ROLL = /(?<!\d|\))([+-]?\d+(?:\.\d+)?)\((.[^)-]*)(?:-([^)]+))?\)/g
const ROLL_NUMBER = /^[+-]?\d+(?:\.\d+)?$/

/**
 * A rolled mod line, split into what the lookup needs and what the card needs.
 *
 *   text    the line with every roll RANGE removed, rolls kept  ("+310 zu …")
 *   masked  the same line with the rolls as '#'                 ("+# zu …")
 *   rolls   [{ value, min, max }] per bracket, in reading order
 *
 * An empty `rolls` means the line carried no range at all (plain Ctrl+C) — then
 * `masked` is exactly what it has always been and nothing downstream changes.
 */
function splitRollRanges (raw) {
  // "Passives in Radius of Wicked Ward() can be Allocated" — GGG writes an
  // EMPTY bracket where it has no advanced description; the engine drops it.
  const src = String(raw ?? '').replace(/\(\)/g, '')
  const rolls = []
  let text = ''
  let masked = ''
  let last = 0
  for (const m of src.matchAll(ADVANCED_ROLL)) {
    const [whole, value, min, max = min] = m
    // Not a numeric range -> not a roll bracket. Wording that happens to sit
    // behind a number is left alone rather than mangled.
    if (!ROLL_NUMBER.test(min) || !ROLL_NUMBER.test(max)) continue
    const lead = src.slice(last, m.index)
    text += lead + value
    masked += lead + normalizeStatTextForCard(value) // digits only, sign stays
    const v = Number(value)
    // Bounds swapped (legacy translations) or a roll outside its own range
    // (legacy roll) — both are real on old items, and neither may produce a
    // slider whose handle sits outside its track.
    rolls.push({ value: v, min: Math.min(Number(min), Number(max), v), max: Math.max(Number(min), Number(max), v) })
    last = m.index + whole.length
  }
  if (!rolls.length) return { text: src, masked: normalizeStatTextForCard(src), rolls }
  return { text: text + src.slice(last), masked: masked + src.slice(last), rolls }
}

// Two rolled values in one line ("Fügt # bis # Schaden hinzu") are ONE number on
// the trade site — their average. Same fold as the engine's getRollOrMinmaxAvg
// (stat-translations.ts), which is where the pair of values comes from.
const avgOrFirst = xs => (xs.length === 2 ? (xs[0] + xs[1]) / 2 : xs[0])

async function spliceResolvedUnknownMods (item, preset, lang = PRIMARY_LANG) {
  const unknown = item.unknownModifiers
  if (!Array.isArray(unknown) || unknown.length === 0) return
  const keep = []
  for (const um of unknown) {
    if (!um?.text) continue
    // Ranges off FIRST, then the same path as ever with the cleaned line —
    // English straight into the catalogue, German through the pair table. One
    // cleanup for both, so the two sides cannot start disagreeing about which
    // texts are lookup-able.
    const { text, masked, rolls } = splitRollRanges(um.text)
    let tradeId = null
    try {
      tradeId = await resolveUnknownMod(text, um.type, lang)
    } catch { tradeId = null } // catalogue trouble must never break a price-check
    if (!tradeId) { keep.push(um); continue }
    // The value the trade search filters on. With the ranges present the rolled
    // numbers are exactly the ones that carried a bracket, so a static number in
    // the wording ("… alle 3 Sekunden 1(0-3) Füllung") cannot be mistaken
    // for the roll; without them, the first number is still all there is.
    const num = /[+-]?\d+(?:\.\d+)?/.exec(text)
    const value = rolls.length ? avgOrFirst(rolls.map(r => r.value)) : (num ? Number(num[0]) : undefined)
    preset.stats.push({
      text: masked,
      tag: um.type || 'implicit',
      tradeId: [tradeId],
      disabled: false,
      // roll.default = the slider's track (modsOf -> valueRange). It exists only
      // when the line brought its own range along; an unvendored stat has no
      // bounds anywhere else, and then the card shows a checkbox without a
      // slider — honest: we know the stat, not its roll range.
      roll: rolls.length
        ? { value, min: value, max: undefined, default: { min: avgOrFirst(rolls.map(r => r.min)), max: avgOrFirst(rolls.map(r => r.max)) } }
        : { value, min: value, max: undefined },
      resolvedFromCatalogue: true, // provenance, for debugging
    })
    keep.push(null) // resolved -> drop from unknownModifiers (no "not searchable" row)
  }
  item.unknownModifiers = keep.filter(Boolean)
}

// The card renders `#` placeholders by substituting the roll (see modTextHtml),
// so store the GGG-style text with the rolled number replaced by '#'. Same rule
// as the catalogue's normalizeStatText: digits only, sign preserved.
const normalizeStatTextForCard = text => String(text).replace(/\d+(?:\.\d+)?/, '#')

// Base Percentile: where the roll of the BASE values (armour/evasion/ES/ward)
// sits inside the base type's span — quality and "#% increased" mods factored
// out (calcBasePercentile in the engine). Only armour pieces carry the value,
// everything else is undefined.
//
// The engine does build the matching pseudo filter itself
// (filterBasePercentile), but only attaches it to Emperor's Vigilance —
// ordinary rares never get it. The bundle file is generated (not editable) and
// does not export the function, so the stat is rebuilt here, in exactly the
// shape the existing trade mapping expects (tradeId[0] ===
// 'item.base_percentile' -> armour_filters.filters.base_defence_percentile
// .min/max in createTradeRequest).
//
// ON by default (range: measured percentile up to 100), like every other mod
// line's "rolls >= mine". APT only wires the filter in from 50% upward; here it
// rides along from the first percentile on, because a high base is exactly the
// difference the mod list otherwise never shows. Unticking is one click.
const BASE_PCT_MOD_TEXT = 'Base Percentile: #%'
const hasBasePercentileStat = preset =>
  Array.isArray(preset?.stats) && preset.stats.some(s => s?.tradeId?.[0] === 'item.base_percentile')

export function addBasePercentileFilter (item, preset) {
  if (typeof item?.basePercentile !== 'number') return false
  if (!Array.isArray(preset?.stats)) return false
  if (hasBasePercentileStat(preset)) return false // Emperor's Vigilance: engine already has it
  preset.stats.push({
    text: BASE_PCT_MOD_TEXT,
    statRef: BASE_PCT_MOD_TEXT,
    tag: 'property',
    tradeId: ['item.base_percentile'],
    disabled: false, // ticked by default (see above)
    // roll.default = the slider's bounds (modsOf -> valueRange), roll.value =
    // measured percentile -> starting point of the min handle, max handle sits
    // at 100. roll.min is the actual search bound of the auto search
    // (createTradeRequest reads roll.min/max), roll.max stays open = unbounded
    // upward.
    roll: { value: item.basePercentile, min: item.basePercentile, max: undefined, default: { min: 0, max: 100 }, dp: false }
  })
  return true
}

// Rare-gear pricing this patch hinges on the LARGEST linked-socket group (colors
// barely matter) -> a single synthetic mod-like filter, active by default (see
// POST /item below). LINKS_MOD_TEXT is its stable identity across buildItemAdded
// (renders it), applySelection (re-applies it on a manual search) and the
// frontend's `data-text` round-trip — must match exactly on all three sides.
const LINKS_MOD_TEXT = 'Linked sockets'

// Largest linked-socket group in the RAW clipboard text (GGG's
// socket_filters.filters.links.min target). The `Sockets:` line is
// space-separated groups, sockets WITHIN a group joined by '-'
// ("Sockets: W-W W-W-W R" -> groups W-W(2) W-W-W(3) R(1) -> 3). No sockets
// line (currency/gems/div cards/...) -> null. Colors/total socket count are
// deliberately ignored — only the link count matters for this feature.
function maxLinkGroup (clipboardText) {
  const m = /^Sockets:[ \t]*(.+)$/m.exec(String(clipboardText || ''))
  if (!m) return null
  const groups = m[1].trim().split(/\s+/).filter(Boolean)
  if (!groups.length) return null
  return Math.max(...groups.map(g => g.split('-').filter(Boolean).length))
}

// Weapon DPS split: APT folds a weapon's raw damage rolls (Adds Fire/Lightning/
// Cold, increased Phys%, local crit, APS) into computed DPS pseudo-stats. It
// shows "Total DPS" but returns "Elemental DPS"/"Physical DPS" HIDDEN — yet
// those ARE the pricing-relevant breakdown (Total = Ele + Phys, e.g. 205=118+87)
// and a 205-all-elemental weapon is worth nothing like a 205-all-physical one.
// Surface them too. They arrive disabled (unchecked) -> Total DPS still drives
// the default search; tick the split to pin phys-vs-ele. Only weapons carry
// these, and the \bDPS\b match is specific, so nothing else is unhidden.
const isDpsPseudo = s => s.tag === 'property' && /\bDPS\b/i.test(String(s.text))

// Best (= lowest) tier across all sources of a stat. It is only in the
// clipboard when "Advanced Mod Descriptions" is enabled in game; without it
// there simply is no tier here — then the card drops the T selector instead of
// guessing wrong. A pseudo stat can originate from several mods (e.g. "+# total
// to Intelligence"), hence the minimum.
export function bestTier (stat) {
  const tiers = (stat?.sources || [])
    .map(src => src?.modifier?.info?.tier)
    .filter(t => typeof t === 'number' && t > 0)
  return tiers.length ? Math.min(...tiers) : null
}

function modsOf (preset) {
  return preset.stats.filter(s => !s.hidden || isDpsPseudo(s)).map(s => {
    const m = { text: modText(s), kind: tagToKind(s.tag), selected: !s.disabled }
    const tier = bestTier(s)
    if (tier != null) m.tier = tier
    if (s.roll) {
      if (typeof s.roll.value === 'number') m.value = s.roll.value
      const b = s.roll.bounds; const d = s.roll.default
      const lo = (b && typeof b.min === 'number') ? b.min : (d && typeof d.min === 'number' ? d.min : undefined)
      const hi = (b && typeof b.max === 'number') ? b.max : (d && typeof d.max === 'number' ? d.max : undefined)
      if (typeof lo === 'number' && typeof hi === 'number' && hi > lo) m.valueRange = [lo, hi]
    }
    return m
  })
}

// Stable identity of a parsed item for the re-POST de-dupe (see REPOST_DEDUP_MS).
// Keyed on what actually makes two clipboard copies "the same item": name, base,
// rarity, corruption + the full searchable mod set (text + roll). Flavour text,
// requirements and trailing whitespace — the parts that flicker between two
// clipboard reads of ONE item — are not part of the parse output, so the two
// reads fingerprint identically. Two genuinely different items (different rolls,
// a different base, an un-linked duplicate) differ in the mod set -> distinct
// fingerprint -> both get their own card, as they should.
// rec.status -> the frontend's priceStatus wording (1:1 today; explicit so a
// future rename of one side can't silently desync the de-dupe re-assert below).
const PRICE_STATUS = { queued: 'queued', searching: 'searching', done: 'done', error: 'error', 'rate-limited': 'rate-limited' }

function itemFingerprint (item, preset) {
  const mods = modsOf(preset)
    .map(m => `${m.kind}:${m.text}=${m.value != null ? m.value : ''}`)
    .sort()
    .join('|')
  return [
    item.name || item.info?.name || '',
    item.info?.refName || item.baseType || '',
    rarityOf(item),
    item.isCorrupted ? 'c' : '',
    item.maxLinks != null ? item.maxLinks : '',
    (item.unknownModifiers || []).map(u => u.text).sort().join(','), // e.g. differing corruption implicits
    mods
  ].join('␟')
}

// Filters the engine applies to the search but that are NOT mods, so they never
// showed anywhere: quality and item level. On a white BASE those two are the
// whole price (a 27% quality / ilvl 57 Crypt Armour is a different product from a
// 0%/ilvl 1 one), and the engine has them active — invisibly. Report them as
// read-only "facts" for the card's summary line so the price is legible. Rares
// get nothing here (the engine returns itemLevel disabled and no quality at all),
// so this adds no noise where it doesn't matter. Read-only on purpose: they're
// shown, not another row to tick — see the mods list for things you can change.
function activeFilterFacts (preset, item) {
  const f = preset?.filters || {}
  const out = []
  const active = flt => flt && !flt.disabled && typeof flt.value === 'number'
  const add = (flt, label, suffix = '') => { if (active(flt)) out.push(`${label}: ${flt.value}${suffix}`) }

  // Gems are bought by LEVEL and QUALITY — without them the card is unreadable
  // ("1c" for a Herald of Purity tells you nothing). Show them always, and say
  // when they are NOT constraining the search: APT deliberately leaves the level
  // filter off below max level and quality off below 16, treating such a gem as
  // generic levelling fodder priced at the floor. That IS the right price, but
  // the card has to admit the search wasn't restricted.
  if (item?.category === 'Gem') {
    if (typeof item.gemLevel === 'number') {
      out.push(active(f.gemLevel) ? `Level: ${item.gemLevel}` : `Level: ${item.gemLevel} (any priced)`)
    }
    if (typeof item.quality === 'number' && item.quality > 0) {
      out.push(active(f.quality) ? `Quality: ${item.quality}%` : `Quality: ${item.quality}% (any priced)`)
    }
    return out
  }

  add(f.quality, 'Quality', '%')
  add(f.itemLevel, 'Item Level')
  // Base Percentile (see addBasePercentileFilter): it sits in the mod list as a
  // tickable filter row — and that list already renders as a chip in the
  // summary up top. So the fact would show the number twice. Only when the
  // filter row is missing (the filter could not be built) does the chip stay as
  // information, otherwise the number would be lost entirely.
  if (typeof item?.basePercentile === 'number' && !hasBasePercentileStat(preset)) {
    out.push(`Base Percentile: ${item.basePercentile}%`)
  }
  return out
}

// APT turns the gem-level filter off for EVERY gem below max level
// (`disabled: gemLevel < maxLevel`) — the assumption behind it being "below max
// it is levelling stock at floor price". For a level-19 gem with quality that
// is wrong: the search then reads "any level", and the level-1 copies drag the
// range down. Measured case: Flicker Strike 19/18% showed 4-5c, the same search
// with level>=19 in game 15-20c.
//
// Rule: if the QUALITY filter is already active (so the engine considers the gem
// a real product rather than levelling stock) and the level is at most one below
// max, the level is filtered along as a minimum. Levelling stock (level 1-18) is
// left alone — there the floor price is the right answer.
export function pinNearMaxGemLevel (item, preset) {
  const f = preset?.filters
  if (!f?.gemLevel || !f.gemLevel.disabled) return false
  if (item?.category !== 'Gem') return false
  const maxLevel = item?.info?.gem?.maxLevel
  if (typeof maxLevel !== 'number' || typeof f.gemLevel.value !== 'number') return false
  if (f.gemLevel.value < maxLevel - 1) return false
  if (!f.quality || f.quality.disabled) return false
  f.gemLevel.disabled = false
  return true
}

function buildItemAdded (id, item, preset) {
  const mods = modsOf(preset)
  // Synthetic links mod, rendered exactly like a normal mod row (see
  // LINKS_MOD_TEXT) — first entry so it sits at the top of the editor. Not
  // part of modsOf (that maps preset.stats only); active by default because
  // the auto price-check already filters by it (see POST /item). Range is
  // capped at the item's OWN largest group, NOT a fixed 6: a 1H weapon maxes at
  // 3 sockets, so [1,6] falsely suggested a 6-link. Only shown when there's a
  // real link (>=2) — see POST /item for the same gate.
  if (item.maxLinks != null && item.maxLinks >= 2) {
    mods.unshift({ text: LINKS_MOD_TEXT, kind: 'links', selected: true, value: item.maxLinks, valueRange: [1, item.maxLinks] })
  }
  // Mods APT couldn't resolve to a trade stat-id — new-this-patch stats whose
  // matcher isn't in the vendored (pre-3.29) DB, e.g. the "+# to Level of
  // Socketed Physical Gems" corruption (the DB has 25 other Socketed-*-Gems tags
  // but not Physical). They exist on GGG's live trade but the app can't SEARCH
  // them, so hiding them makes the price a silent lie. Surface them read-only so
  // the corruption is visible and the user can add it via Open Trade.
  for (const um of item.unknownModifiers || []) {
    if (um?.text) mods.push({ text: um.text, kind: 'unknown', selected: false, searchable: false })
  }
  return {
    type: 'item-added',
    id,
    facts: activeFilterFacts(preset, item),
    name: item.name || item.info?.name || 'Unknown',
    itemClass: item.category || item.info?.refName || '',
    rarity: rarityOf(item),
    baseType: item.info?.refName || '',
    corrupted: Boolean(item.isCorrupted),
    priceStatus: 'queued',
    mods
  }
}

// FE `search` -> mutate preset: activate checked mods + set range (min AND max),
// disable the rest. min/max are optional: if a bound is missing (slider at the
// stop), it's set to undefined = no bound in that direction. APT's
// createTradeRequest/getMinMax reads roll.min/roll.max -> filter.value.min/max.
function applySelection (preset, selectedMods) {
  const wanted = new Map((selectedMods || []).map(m => [m.text, m]))

  // Linked sockets is a synthetic filter (LINKS_MOD_TEXT), not a preset.stats
  // entry -> handle it separately BEFORE the stats loop and remove it from
  // `wanted` so it can't fall through there (its text wouldn't match any stat
  // anyway, but this keeps the intent explicit). Checked -> (re)enable with the
  // slider's min handle (fallback: the previous value, else 1); unchecked ->
  // disable rather than delete, so a later re-check has something to revive.
  // Note: GGG/engine supports links.min ONLY in this build — the slider's max
  // handle is a no-op here (max support would need an engine.bundle.mjs change).
  preset.filters = preset.filters || {}
  const linksSel = wanted.get(LINKS_MOD_TEXT)
  wanted.delete(LINKS_MOD_TEXT)
  if (linksSel) {
    const value = typeof linksSel.min === 'number' ? linksSel.min : (preset.filters.linkedSockets?.value ?? 1)
    preset.filters.linkedSockets = { value, disabled: false }
  } else if (preset.filters.linkedSockets) {
    preset.filters.linkedSockets.disabled = true
  }

  for (const s of preset.stats) {
    const sel = wanted.get(modText(s))
    s.disabled = !sel
    if (sel && s.roll) {
      s.roll.min = typeof sel.min === 'number' ? sel.min : undefined
      s.roll.max = typeof sel.max === 'number' ? sel.max : undefined
    }
  }
}

// The selection a manual `search` ran with, normalized down to what the card
// needs to render it again: the ticked mod texts with their chosen roll bounds
// (an omitted bound = handle at its stop, exactly as the FE sends it) plus the
// corruption toggle. Stored on the record next to the price it produced, and
// echoed back as `item-added.selection` (see itemAddedFor / PROTOCOL.md).
//
// Why it has to be kept at all: `rec.addedMsg` is frozen at POST time and
// carries the DEFAULT ticks. Replaying it on a reconnect re-rendered the picker
// at those defaults while the price block still showed the result of the user's
// own (different) search — a listing count standing next to a selection that
// never produced it, with no way to tell what was actually searched.
function selectionOf (job) {
  return {
    corrupted: ['yes', 'no'].includes(job.corrupted) ? job.corrupted : 'any',
    mods: (job.selectedMods || []).filter(m => m && m.text != null).map(m => {
      const out = { text: m.text }
      if (typeof m.min === 'number') out.min = m.min
      if (typeof m.max === 'number') out.max = m.max
      return out
    })
  }
}

// The card message for a record in its current state: the parsed item (fixed at
// POST time) + the status + the selection that produced the price, if the user
// ever ran one. Every place that re-sends a card goes through here so the two
// can't drift apart again.
function itemAddedFor (rec, priceStatus, extra) {
  const msg = { ...rec.addedMsg, priceStatus }
  if (rec.selection) msg.selection = rec.selection
  return extra ? Object.assign(msg, extra) : msg
}

// Set the corruption filter per item (APT misc filter). createTradeRequest sends
// `misc_filters.filters.corrupted.option` ONLY when value===false OR exact===true
// (see pathofexile-trade.ts). From that:
//   'no'  -> { value:false }            -> option "false" (uncorrupted only)
//   'yes' -> { value:true, exact:true } -> option "true"  (corrupted only)
//   'any' -> { value:true }             -> nothing sent (either way)  [default]
function applyCorrupted (preset, corrupted) {
  if (!preset.filters) return
  if (corrupted === 'no') preset.filters.corrupted = { value: false }
  else if (corrupted === 'yes') preset.filters.corrupted = { value: true, exact: true }
  else preset.filters.corrupted = { value: true } // 'any'
}

// luxon short relative date ("2 hr. ago", "5 min. ago", "3 days ago") -> minutes.
function relToMinutes (str) {
  if (!str) return null
  const s = String(str).toLowerCase()
  if (s.includes('now')) return 0
  const m = s.match(/(\d+(?:\.\d+)?)\s*(sec|min|hr|hour|day|wk|week|mo|month|yr|year)/)
  if (!m) return null
  const n = Number(m[1])
  const per = { sec: 1 / 60, min: 1, hr: 60, hour: 60, day: 1440, wk: 10080, week: 10080, mo: 43200, month: 43200, yr: 525600, year: 525600 }
  return Math.round(n * (per[m[2]] || 0))
}

// round1 -> ninja.mjs (see the import above).

// Median of a non-empty number array (even count -> mean of the two middles).
const medianOf = (nums) => {
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// `kind`/`league` describe how `price` was obtained (server.mjs's own
// useBulk routing decision + the room's active league at search time) so the
// frontend can build the official trade URL:
//   search:   https://www.pathofexile.com/trade/search/<league>/<queryId>
//   exchange: https://www.pathofexile.com/trade/exchange/<league>/<queryId>
// `price.queryId` comes straight from the trade API response (search.id in
// engine.mts searchPreset / chosen.queryId in bulkPriceItem) -> null if the
// engine never got one (error, empty bulk result etc.) -> no button.
function toPriceResult (id, price, kind, league, cdRatio) {
  const priced = price.listings.filter(l => l.priceAmount > 0 && l.priceCurrency && l.priceCurrency !== 'no price')
  let currency = 'chaos'; let priceLow = 0; let priceHigh = 0; let priceMedian = 0
  let rows = []
  if (priced.length) {
    // Listings come in MIXED currencies. Keying off the cheapest listing's
    // currency and dropping every other one collapses
    // a page of "1c, 1div, 1div, 2div" into a headline of "1 c": the three
    // divine offers, i.e. the actual market, silently discarded and the item
    // understated ~88x. Put chaos and divine on one scale instead and derive the
    // display unit from the outcome. Exotic currencies (exalted, mirror) have no
    // rate here, so they stay out of the aggregate but remain visible in the
    // listing rows; if ONLY such listings exist, fall back to single-currency.
    const ratio = Number(cdRatio) > 0 ? Number(cdRatio) : 0
    const convertible = ratio ? priced.filter(l => l.priceCurrency === 'chaos' || l.priceCurrency === 'divine') : []
    const useChaosScale = convertible.length > 0
    const base = useChaosScale ? convertible : priced.filter(l => l.priceCurrency === priced[0].priceCurrency)
    const amounts = base.map(l => (useChaosScale && l.priceCurrency === 'divine' ? l.priceAmount * ratio : l.priceAmount))

    let lo = Math.min(...amounts)
    let hi = Math.max(...amounts)
    // Min-max alone misreads badly on a thin market: one absurd listing turns a
    // 1c base into "1-250c", which looks valuable. The median is the honest
    // middle (a single outlier can't move it), so send both and let the card
    // show range + typical.
    let med = medianOf(amounts)

    if (!useChaosScale) {
      currency = base[0].priceCurrency // no C:D rate, or only exotic listings
    } else if (med >= ratio) {
      currency = 'divine' // typical price is a divine or more -> read it that way
      lo /= ratio; hi /= ratio; med /= ratio
    } else {
      currency = 'chaos'
    }
    priceLow = round1(lo)
    priceHigh = round1(hi)
    priceMedian = round1(med)
    rows = priced.slice(0, 10).map(l => ({
      price: round1(l.priceAmount),
      currency: l.priceCurrency,
      seller: '@' + (l.ign || l.accountName || 'unknown'),
      ageMinutes: relToMinutes(l.relativeDate)
    }))
  }
  return {
    type: 'price-result',
    id,
    display: 'single',
    currency,
    priceLow,
    priceHigh,
    priceMedian,
    count: price.total,
    listings: rows,
    tradeId: price.queryId ?? null,
    tradeKind: kind,
    league
  }
}

// Promotes the Currency Exchange rate to the card's headline price and demotes
// whatever the trade site asked to a secondary `tradeAsk` line. Everything else
// about the trade result (listings, count, trade query id/kind) is kept: the
// list underneath still shows real trade offers and "Open Trade" still works.
//
// `chaos == null` (Faustus doesn't know this item) -> the result is returned
// untouched, byte for byte. That's the no-regress path for every rare/unique/
// gear item, which is everything Faustus never quotes.
//
// `range` ({min,max} chaos per piece, optional) is what the exchange ACTUALLY
// traded at that hour and rides along as `exchangeRange` so the card can show
// how wide the market is instead of just the single derived number.
//
// `ageHours` (optional) is how old the OBSERVATION behind `chaos` is, in whole
// hours, and only when that exceeds the lag the pipeline cannot avoid — null
// otherwise (networth/faustus-age.mjs staleHours). It rides along as
// `exchangeAgeHours` so the card can say the headline is not from now. This is
// the field the "206.6c on the card, 147c in the game" report needed: both
// numbers were real, they were from different hours, and nothing said so.
//
// `itemName` is display-only, for the ask-conflict log line below — it never
// affects pricing.
//
// ---- Ask-conflict thresholds (see the marker logic further down) ----------
// Disclose, never override: a lowball ask is not a sale and asks are
// manipulable, so the Exchange headline still wins outright — the marker only
// says the two sources disagree, it never substitutes a "corrected" number.
//
// Measured against the bug report (divination card Broken Truce: headline 22c
// while 218 people asked 1c on the trade site, shown with no hint anything
// was off) and validated across 505 Allflame fungibles priced by both Faustus
// and poe.ninja on the same day: median divergence there was 1.07x, p95
// 1.83x, and the worst HONEST divergence topped out near 2.4x, while
// everything measurably broken sat at 9x or more. 4 halves that gap with
// margin on both sides (only ~1.0% of lines exceed it) and is the same number
// AND the same meaning as BRIDGE_TOLERANCE in networth/faustus.mjs.
const ASK_CONFLICT_RATIO = envNum('POE_ASK_CONFLICT_RATIO')
// Absolute floor on top of the ratio. Sub-chaos fungibles (lifeforce trades
// near 0.018c while the trade site can't list below 1c) would otherwise fire
// on pure granularity, and the over-direction would fire constantly on
// near-floor junk where 1c walls are endemic — the ratio alone can't tell
// "22c vs 1c" (real conflict) from "1.5c vs 1c" (rounding noise).
// 0 is honoured: "no absolute gap required, the ratio alone decides".
const ASK_CONFLICT_ABS_GAP_C = envNum('POE_ASK_CONFLICT_ABS_GAP_C')
// Below this many fetched asks, the ask median is itself noise.
// 0 is honoured: "no minimum listing count". The listings are already in hand
// when this is read, so it is a confidence bar and never a request cap.
const MIN_ASK_EVIDENCE = envNum('POE_MIN_ASK_EVIDENCE')
// Same granularity problem as the abs-gap, from the other end: below 1c the
// exchange rate is honestly sub-chaos and the trade site's floor is the whole
// reason for the gap, not evidence of a wrong headline.
// 0 is honoured: "mark sub-chaos headlines too".
const MIN_CONFLICT_HEADLINE_C = envNum('POE_MIN_CONFLICT_HEADLINE_C')
function withExchangeMain (result, chaos, cdRatio, range, itemName, ageHours = null) {
  if (typeof chaos !== 'number' || !(chaos > 0) || !result) return result
  const ratio = Number(cdRatio) > 0 ? Number(cdRatio) : 0
  const toChaos = v => (result.currency === 'chaos'
    ? v
    : (result.currency === 'divine' && ratio ? round1(v * ratio) : null))
  // No priced listing at all -> nothing to ask about, so no second line.
  // chaosMedian is read off `result.priceMedian` HERE, before `out` below
  // overwrites that field with the Exchange headline — this is still the
  // trade-derived median.
  const ask = (result.priceLow > 0 || result.priceHigh > 0)
    ? {
        low: result.priceLow,
        high: result.priceHigh,
        currency: result.currency,
        chaosLow: toChaos(result.priceLow),
        chaosHigh: toChaos(result.priceHigh),
        chaosMedian: toChaos(result.priceMedian)
      }
    : null
  // roundExchange (ninja.mjs): three significant digits below 1 c, so a
  // genuinely sub-chaos fungible stays an honest number instead of a flat "0".
  const c = roundExchange(chaos)
  const rc = roundExchange // same rounding as the headline
  const lo = Number(range?.min); const hi = Number(range?.max)
  const out = {
    ...result,
    currency: 'chaos',
    priceLow: c,
    priceHigh: c,
    priceMedian: c,
    priceSource: 'exchange',
    sourceLabel: 'Exchange',
    tradeAsk: ask
  }
  // Only a real span: no range, a degenerate one or garbage -> the field stays
  // absent and the card shows nothing there (never a made-up placeholder).
  if (isFinite(lo) && isFinite(hi) && lo > 0 && lo < hi) out.exchangeRange = { low: rc(lo), high: rc(hi) }
  // Same rule for the age: absent means "as fresh as this source gets", not
  // "unknown" — faustusStaleHoursFor only returns a number past the unavoidable
  // lag, so a present field always means the headline is genuinely behind.
  if (typeof ageHours === 'number' && isFinite(ageHours) && ageHours > 0) out.exchangeAgeHours = ageHours

  // ---- Ask-conflict marker ---------------------------------------------------
  // Gates: ALL required or there is no comparison at all — thin/exotic/floor
  // situations are not evidence of anything, so they stay silent rather than
  // guess.
  if (
    ask &&
    c >= MIN_CONFLICT_HEADLINE_C &&
    result.count >= MIN_ASK_EVIDENCE &&
    ask.chaosLow != null &&
    ask.chaosMedian != null
  ) {
    // Over (headline maybe too high) and under (headline maybe too low) read
    // DIFFERENT ask statistics on purpose. Asks BELOW the headline are
    // self-enforcing — an ask that's genuinely too cheap gets bought, so a
    // standing wall of cheap asks is real supply — so the robust measure is
    // the MEDIAN of the fetched asks. Asks ABOVE the headline are aspirational
    // and cost nothing to post — a single greedy listing proves nothing — so
    // the conservative measure is the CHEAPEST ask; only if even that is
    // ASK_CONFLICT_RATIO above the headline is the headline itself suspect.
    // Never `ask.chaosHigh`: it is not a market high, it's the 10th-cheapest
    // fetched listing — a meaningless quantity for this purpose.
    const over = c >= ASK_CONFLICT_RATIO * ask.chaosMedian && c - ask.chaosMedian >= ASK_CONFLICT_ABS_GAP_C
    const under = ask.chaosLow >= ASK_CONFLICT_RATIO * c && ask.chaosLow - c >= ASK_CONFLICT_ABS_GAP_C
    if (over || under) {
      const dir = over ? 'over' : 'under'
      const factor = Math.round((over ? c / ask.chaosMedian : ask.chaosLow / c) * 10) / 10
      out.askConflict = { dir, factor }
      // Logged unconditionally on every firing so the thresholds above can be
      // calibrated from real use later — that is the point of shipping this.
      console.log(`[server] ask-conflict ${dir} x${factor} item=${itemName || 'unknown'} headline=${c} askMed=${ask.chaosMedian} askLow=${ask.chaosLow} count=${result.count}`)
    }
  }

  return out
}

// Does an item have a renderable last price? (done + real listings with a price)
// Decides on reconnect whether to replay it or trigger it again. poe.ninja
// bulk results (toNinjaPriceResult) carry NO listings by design (there's no
// trade query behind them) -> they'd never count as "valid" under the
// listings-based check and get needlessly re-triggered on every reconnect
// (harmless — the ninja fetch is cached — but pointless), so recognize them
// via `priceSource === 'ninja'` instead.
function hasValidPrice (rec) {
  const p = rec.lastPrice
  if (!p || rec.status !== 'done') return false
  // Aggregated sources (poe.ninja, Currency Exchange) carry no listings by
  // design -> judge them by the value, not by an empty listings array.
  if (p.priceSource === 'ninja' || p.priceSource === 'exchange') return p.priceLow > 0
  return Array.isArray(p.listings) && p.listings.length > 0 && p.priceLow > 0
}

// ---- queue-status ----------------------------------------------------------
function rateLimitSnapshot () {
  const out = []
  const add = (policy, set) => { if (set) for (const rl of set) out.push({ policy, used: rl.stack.length, limit: rl.max, windowSec: Math.round(rl.window) }) }
  add('trade-search', engine.RATE_LIMIT_RULES?.SEARCH)
  add('trade-fetch', engine.RATE_LIMIT_RULES?.FETCH)
  add('trade-exchange', engine.RATE_LIMIT_RULES?.EXCHANGE) // bulk exchange (currency)
  return out
}

function queueStatusMsg () {
  const priorityActive = currentPriority || jobs.some(j => j.kind === 'priority')
  return { type: 'queue-status', depth: jobs.length, bgDepth: bgJobs.length, priorityActive, rateLimits: rateLimitSnapshot() }
}
// Shared queue -> queue-status goes to ALL rooms (both see the same depth).
// The daemon feed follows the queue position of the cards it tracks from here
// (an event only when a position changed).
const broadcastQueue = () => { refreshFeedQueue(); broadcastAll(queueStatusMsg()) }

// ---- Rate-limit banner (shared trade-queue ban signal) ---------------------
// GGG can hand the app a LONG Retry-After (league-launch soft-ban: observed
// ~11538s). pump() retries such a job SILENTLY, so the card just sits in
// "queued"/"searching…" forever and the user never learns they're rate-limited.
// The RateLimiter (and the anonymous IP) is SHARED across all users, so a real
// ban is queue-wide, not per-card -> broadcast a GLOBAL banner to every room
// (same routing rationale as queue-status). Routine serial-queue backpressure
// (a few seconds) is normal and must NOT panic-banner everyone; only a
// Retry-After >= RATE_LIMIT_BANNER_MIN_SEC (env POE_RATE_LIMIT_BANNER_MIN_SEC,
// default 60s) is treated as "actually rate-limited". The banner clears on the
// next successful price (searches got through again) and self-expires once its
// `until` passes, so a stale ban never lingers on screen.
// 0 is honoured: "banner every rate-limit wait, however short". Display only.
const RATE_LIMIT_BANNER_MIN_SEC = envNum('POE_RATE_LIMIT_BANNER_MIN_SEC')
let rateLimit = null // { retryAfterSec, until, message } | null

// The gate is written to disk, not just held in memory, because APT's
// RateLimiter knows nothing across a restart: it comes up empty and the first
// job fires a blind request straight into the open ban, which GGG can answer by
// extending it. Deploys are exactly when that happens — with a real 12h ban
// here, ~12 deploys in one day means ~12 blind probes. Persisting `until` means
// a restart resumes the gate instead of probing.
const RATE_LIMIT_STATE = process.env.POE_RATE_LIMIT_STATE || '/config/rate-limit.json'

// Persist / restore the gate across restarts (see RATE_LIMIT_STATE). Best
// effort throughout: a missing, unreadable or corrupt file simply means "no
// known ban", never a startup failure.
async function persistRateLimit () {
  try {
    await mkdir(dirname(RATE_LIMIT_STATE), { recursive: true })
    const body = rateLimit ? JSON.stringify({ until: rateLimit.until, retryAfterSec: rateLimit.retryAfterSec }) : '{}'
    await writeFile(RATE_LIMIT_STATE, body)
  } catch { /* not writable -> gate is in-memory only, as before */ }
}

async function restoreRateLimit () {
  try {
    const saved = JSON.parse(await readFile(RATE_LIMIT_STATE, 'utf8'))
    const until = Number(saved?.until)
    if (!Number.isFinite(until) || until <= Date.now()) return
    rateLimit = {
      retryAfterSec: Number(saved.retryAfterSec) || Math.round((until - Date.now()) / 1000),
      until,
      message: "GGG's trade API rate-limited the app — searches are paused (retry-after). Common at league launch under heavy load.",
    }
    scheduleBanResume()
    console.warn('[server] restored active rate-limit gate from disk — %d s left (NOT probing GGG until it expires)',
      Math.round((until - Date.now()) / 1000))
  } catch { /* no state / unreadable -> nothing known, start clean */ }
}

// Current banner message, lazily expiring: once `until` passes, the ban is over
// -> report inactive (and drop the state) even without an explicit clear.
function rateLimitMsg () {
  if (rateLimit && Date.now() >= rateLimit.until) rateLimit = null
  return rateLimit
    ? { type: 'rate-limit', active: true, retryAfterSec: rateLimit.retryAfterSec, until: rateLimit.until, message: rateLimit.message }
    : { type: 'rate-limit', active: false }
}

// The same gate, as the question the NET-WORTH REFRESHER asks before every tick
// (B14). While it is up, the stash path stops too — and it is the same `until`
// pump() gates on, so the two can never disagree about whether a ban is on.
//
// Why the stash path listens to a TRADE ban at all: a ban on this deployment
// was reported to apply to the whole address rather than to an account, and to
// have ended only by taking a new one. A cookie-authenticated stash read during
// such a ban is still a request from a banned address. The counter-argument is
// real and is documented where the decision is (docs/bugs.md B14): the net
// worth freezes for the length of the ban. It heals; a ban does not, and it
// costs every user of the deployment at once.
//
// A pause with an end time, not a bare boolean: the refresher hands it to the
// status line so a user reads "resumes at 19:40" instead of an open-ended stop.
function tradeBanPause () {
  return (rateLimit && Date.now() < rateLimit.until) ? { until: rateLimit.until } : false
}

// Called from pump()'s rate-limit retry branch with the parsed Retry-After.
// Returns true iff it raised (or refreshed) the banner (>= threshold).
function noteRateLimit (seconds) {
  const secs = Number(seconds) || 0
  if (secs < RATE_LIMIT_BANNER_MIN_SEC) return false
  rateLimit = {
    retryAfterSec: secs,
    until: Date.now() + secs * 1000,
    message: "GGG's trade API rate-limited the app — searches are paused (retry-after). Common at league launch under heavy load.",
  }
  broadcastAll(rateLimitMsg())
  persistRateLimit() // survive a restart instead of probing GGG blind
  sourceHealth.fail('trade', `GGG rate limit, retry after ${secs} s`, 'unknown')
  scheduleSourceBroadcast(true) // the trade row carries pausedUntil
  return true
}

// While a queue-wide ban is active, the pump gate (see pump()) holds the whole
// queue. This schedules ONE timer to resume pumping the moment `until` passes,
// so held jobs run again on their own. Firing trade requests DURING the ban is
// exactly what snowballed 3h -> 11h: each rejected request counts against GGG's
// Invalid-Request threshold and extends the ban. `.unref()` so a pending resume
// timer never keeps the process (or a test run) alive.
let banResumeTimer = null
// setTimeout clamps delays > 2^31-1 ms to 1ms (which would turn a long ban into
// a re-gate spin loop) -> cap any delay we derive from a GGG-supplied
// Retry-After. Purely defensive; real values are hours, not the ~24.8 days this
// guards.
const MAX_TIMER_MS = 2 ** 31 - 1
function scheduleBanResume () {
  if (banResumeTimer || !rateLimit) return
  const ms = Math.min(Math.max(0, rateLimit.until - Date.now()) + 500, MAX_TIMER_MS)
  banResumeTimer = setTimeout(() => {
    banResumeTimer = null
    if (rateLimit && Date.now() >= rateLimit.until) clearRateLimit() // ban over -> clearRateLimit pumps
    else pump()                                                      // still banned -> re-gate + reschedule
  }, ms)
  banResumeTimer.unref?.()
}

// Called when a search gets through again (or on shutdown/tests): drop the
// banner and tell every room the queue is moving again.
function clearRateLimit () {
  const hadTimer = !!banResumeTimer
  if (banResumeTimer) { clearTimeout(banResumeTimer); banResumeTimer = null }
  // If the ban was already lazily nulled (rateLimitMsg) while the resume timer
  // was still pending, clearing that timer just removed the ONLY thing that
  // would drain the held queue -> pump here so held jobs never get stranded.
  if (!rateLimit) { if (hadTimer) pump(); return }
  rateLimit = null
  broadcastAll(rateLimitMsg())
  scheduleSourceBroadcast(true) // pausedUntil is gone from the trade row
  persistRateLimit() // clear the on-disk gate too
  pump() // ban lifted -> drain any jobs the gate was holding
}

// ---------------------------------------------------------------------------
// Queue worker: ONE connection, serial, through APT's RateLimiter. GLOBAL across
// all users (the shared RateLimiter is the whole point of M4). Each job carries
// `user` -> rec/league from that user's room, results only go to that room.
//
// Three-tier queue (priority: priority > auto > background): `jobs` carries the
// existing item-based jobs (kind priority/auto), `bgJobs` the new lowest
// tier for background jobs. pump() ALWAYS pulls from `jobs`
// first, only pulling from `bgJobs` once that's empty. A job with `.run`
// (regardless of which queue) runs via the run closure instead of the item
// path — this leaves the existing price path (rec/room/searchPreset) untouched.
// ---------------------------------------------------------------------------
function enqueue (job) {
  if (job.kind === 'priority') jobs.unshift(job) // ahead of the background jobs
  else jobs.push(job)
  broadcastQueue()
  pump()
}

// A rate-limit surfaces in TWO different wordings, and we MUST recognise both:
//
//  1. Client-side backpressure — APT's RateLimiter throws `Retry after N
//     seconds` (preventQueueCreation) BEFORE any request goes out, when the
//     search/fetch window is full. Harmless, normal pacing.
//  2. A REAL server-side ban — GGG's 429 body is surfaced verbatim as
//     `Rate limit exceeded; Please wait N seconds before trying again.` This is
//     the one that matters: a request DID reach GGG and got rejected, and every
//     further request during it EXTENDS the ban (3h -> 11h).
//
// The old regex only matched wording (1). Wording (2) fell through to the
// generic 'error' branch, so noteRateLimit() was never called, the banner never
// showed, and the ban gate never engaged for an ACTUAL ban — the app just kept
// firing. rateLimitSeconds() (now in the SHARED rate-limit-signal.mjs, imported
// above so the two can't drift again) extracts N from every ban
// wording; a numberless ban still returns a conservative cooldown so the gate
// engages instead of silently hammering. Non-rate-limit errors -> null. pump()'s
// catch requeues the SAME job (kind/selectedMods/corrupted untouched -> keeps its
// tier) after N+1s. `job.retries` counts attempts FOR THIS JOB INSTANCE ONLY ->
// a persistently limited window still gives up after RATE_LIMIT_MAX_RETRIES
// instead of retrying forever.
const RATE_LIMIT_MAX_RETRIES = 5

function enqueueBackground (jobFn) {
  bgJobs.push({ kind: 'background', run: jobFn })
  broadcastQueue()
  pump()
}

async function pump () {
  if (working) return
  // Global ban gate: while a real (queue-wide) ban is active, do NOT dispatch
  // ANY job — every current job type (price, corpse) hits GGG's
  // trade API, and a request fired during the ban just gets rejected AND risks
  // extending it (Invalid-Request threshold). Hold the whole queue; scheduleBan-
  // Resume() re-pumps once `until` passes. This is the one place that stops a
  // known ban from snowballing. Idle-empty queues need no timer — the ban self-
  // expires (rateLimitMsg lazy check) and the next enqueue re-checks `until`.
  if (rateLimit && Date.now() < rateLimit.until) { scheduleBanResume(); return }
  const job = jobs.shift() ?? bgJobs.shift() // foreground first, background only if jobs is empty
  if (!job) return
  working = true
  currentPriority = job.kind === 'priority'
  currentJob = job
  broadcastQueue()

  if (job.run) {
    // Background job with its own runner — item path below untouched.
    try {
      await job.run()
    } catch (e) {
      // A background runner swallows its OWN errors (it self-cools),
      // so this normally never fires. Defensive belt-and-suspenders for any
      // future bg-job type: a ban that reaches here still raises the global gate
      // instead of being logged and forgotten.
      const rl = classifyRateLimit(e)
      if (shouldRaiseGlobalGate(rl)) noteRateLimit(rl.seconds)
      console.error('[bg] job failed:', e?.message || e)
    } finally {
      working = false
      currentPriority = false
      currentJob = null
      broadcastQueue()
      pump()
    }
    return
  }

  try {
    const room = users.get(job.user)
    const rec = room && room.items.get(job.id)
    if (rec && rec.alive) {
      // Pricing switched off (POE_PRICE_CHECK_DISABLED=1): the card stays, no
      // request goes out. 'error' rather than leaving it on 'queued' or
      // 'searching', because no price is ever going to arrive for it — a card
      // that claims to be searching when nothing is searching is the same lie
      // the status field exists to prevent.
      if (PRICE_CHECK_DISABLED) {
        rec.status = 'error'
        broadcast(job.user, itemAddedFor(rec, 'error'))
        return
      }
      // Mod selection/corrupted filter apply for every manual ('priority')
      // search, regardless of route: for true bulk items (real currency)
      // preset.stats is empty anyway (no-op loop), so this is harmless there
      // and correct for stat-searched items.
      if (job.kind === 'priority') {
        // Remember it HERE, in the same breath as the preset mutation below —
        // not when the job was enqueued. Between click and dispatch the card
        // still shows the PREVIOUS search's price, so a reconnect in that window
        // has to replay the previous selection with it; rec.selection and
        // rec.preset must always describe the same search.
        rec.selection = selectionOf(job)
        applySelection(rec.preset, job.selectedMods)
        applyCorrupted(rec.preset, job.corrupted) // any/yes/no from the search payload
      }
      rec.status = 'searching'
      broadcast(job.user, itemAddedFor(rec, 'searching'))

      // poe.ninja bulk routing (NINJA_BULK_CLASSES, see above): these item
      // classes have no exchange tradeTag (bulkPriceItem can't price them
      // either) and their single-listing trade search comes back full of
      // stale/dead offers (Divination Cards being the poster child: a card
      // like "The Fortunate" shows a handful of long-dead listings) -> use poe.ninja's aggregated market value
      // instead, no trade call at all. `ninjaBulkPrice` returns null (not
      // this item class / name not in poe.ninja's data / poe.ninja
      // unreachable) -> falls straight through to the normal trade routing
      // below, so an honest trade-search result still beats no price at all.
      // The Currency Exchange comes FIRST, unconditionally: if Faustus knows
      // this item, its rate IS the price — no "only for bulk", no "only when
      // the trade search came back empty". Trade-site listings are ASKING
      // prices with huge spreads; the exchange is where currency actually
      // clears, and Faustus is that same in-game window. Observed in Allflame:
      // Valdo's Puzzle Box asked 0.7-1 div (75-107c) on the trade site while
      // the exchange cleared it at 56c; Templar Astrolabe asked a flat 1 div
      // (107c) against 45c on the exchange — a 2.4x overstatement.
      // The condition is deliberately "Faustus knows it", not "we classified it
      // as bulk": in practice that's currency/fragments/scarabs, but an item
      // that routes through the stat search and still has an exchange rate gets
      // priced by the exchange too. Unknown to Faustus (null) -> this block
      // does nothing and the path below runs as it would without it.
      // Read ONCE per pass. POE_MAX_LISTINGS is live (config-overrides.mjs), so
      // a save between the bulk call and the fallback search below would put
      // two different limits into one result — a price built from ten listings
      // and a fallback built from three, with nothing on the card saying so.
      const listings = maxListings()
      const faustusChaos = faustusChaosFor(rec.item, room.league)
      // poe.ninja is only asked when the exchange has no rate — an aggregated
      // ninja value must never outrank the live exchange.
      const ninjaPrice = faustusChaos == null ? await ninjaBulkPrice(rec.item, room.league) : null
      let price; let tradeKind; let exchangePrice = null

      if (ninjaPrice) {
        price = null
        tradeKind = null
      } else {
        // Route like APT's own overlay does (apiToSatisfySearch, see engine.mts):
        // bulk exchange only when NO stat filter is active AND the item has an
        // exchange tradeTag. This replaces the old, too-coarse
        // `category === 'Currency'` check, which also caught Corpses/
        // Incubators (same clipboard "Rarity: Currency" line, but NO exchange
        // tradeTag) -> those hard-got {total:0} from bulkPriceItem even though
        // they have normal trade-search listings.
        const useBulk = engine.apiToSatisfySearch(rec.item, rec.preset.stats, rec.preset.filters) === 'bulk'
        // Tracks which route actually PRODUCED `price` (the fallback below can
        // downgrade bulk -> search) -> this, not `useBulk`, decides tradeKind /
        // the trade.../search/ vs trade/.../exchange/ URL shape.
        tradeKind = useBulk ? 'exchange' : 'search'

        price = useBulk
          ? await bulkPriceItemAs(rec.item, rec.preset.filters, {
              league: room.league,
              maxListings: listings,
              cdRatio: cdMsgFor(room.league).chaosPerDivine
            })
          : await searchPresetAs(rec.preset, { league: room.league, maxListings: listings })

        // Defensive fallback: even WITH a tradeTag, the bulk exchange can come
        // back empty for a genuinely thin/dead exchange pair -> fall back to
        // the stat search instead of broadcasting a bare "0c / 0 listings" for
        // an item that might still have normal trade-search listings.
        //
        // With a Faustus rate there's nothing to fall back to: the exchange
        // already IS the price, and an empty trade result just means there's no
        // trade-ask line to show underneath it.
        if (useBulk && (!price || price.total === 0)) {
          if (faustusChaos != null) {
            price = null
            tradeKind = null
            exchangePrice = { chaos: roundExchange(faustusChaos), count: null, url: null }
          } else {
            price = await searchPresetAs(rec.preset, { league: room.league, maxListings: listings })
            tradeKind = 'search'
          }
        }
      }
      broadcastQueue() // rate limit headers were processed -> policies updated

      if (rec.alive) {
        const result = ninjaPrice
          ? toNinjaPriceResult(job.id, ninjaPrice, room.league)
          : exchangePrice
            ? toNinjaPriceResult(job.id, exchangePrice, room.league, {
                source: 'exchange', label: 'Currency Exchange', note: 'market rate',
                ageHours: faustusStaleHoursFor(rec.item, room.league)
              })
            // Faustus rate + real trade listings: the exchange rate becomes the
            // headline, the trade result keeps its listings/trade link and its
            // price drops to the `tradeAsk` line (see withExchangeMain).
            : withExchangeMain(
                toPriceResult(job.id, price, tradeKind, room.league, cdMsgFor(room.league).chaosPerDivine),
                faustusChaos,
                cdMsgFor(room.league).chaosPerDivine,
                faustusRangeFor(rec.item, room.league),
                rec.item.name || rec.item.info?.name || 'Unknown',
                faustusStaleHoursFor(rec.item, room.league)
              )
        rec.status = 'done'
        rec.lastPrice = result
        broadcast(job.user, result)
        sourceHealth.ok('trade') // the last search that went through (source-status)
        clearRateLimit() // a search got through -> the shared queue is moving again
      }
    }
  } catch (e) {
    const msg = e?.message || String(e)
    const room = users.get(job.user)
    const rec = room && room.items.get(job.id)
    const rl = classifyRateLimit(msg)
    const seconds = rl?.seconds
    if (rl != null && (job.retries || 0) < RATE_LIMIT_MAX_RETRIES) {
      job.retries = (job.retries || 0) + 1
      console.error(`[server] price job ${job.id} (${job.user}) rate-limited [${rl.kind}] (retry ${job.retries}/${RATE_LIMIT_MAX_RETRIES} in ${seconds + 1}s):`, msg)
      // Raise the global banner + mark the card 'rate-limited' for a REAL limit:
      // any server 429 / hard block, AND a client-side wait long enough that
      // APT's limiter has clearly learned a server limit from GGG's headers
      // (see shouldRaiseGlobalGate). Short client backpressure stays 'queued'
      // and just reschedules — no false alarm for ordinary pacing.
      const bannered = shouldRaiseGlobalGate(rl) ? noteRateLimit(seconds) : false
      if (rec && rec.alive) {
        const st = bannered ? 'rate-limited' : 'queued'
        rec.status = st
        broadcast(job.user, itemAddedFor(rec, st, { retryAfterSec: seconds }))
        // Clamp (see MAX_TIMER_MS) so a huge Retry-After can't collapse to a 1ms
        // busy-requeue; .unref() so a pending multi-hour retry never blocks a
        // clean process exit (symmetry with scheduleBanResume's timer).
        const retryTimer = setTimeout(() => { if (rec.alive) enqueue(job) }, Math.min((seconds + 1) * 1000, MAX_TIMER_MS))
        retryTimer.unref?.()
      }
    } else {
      console.error(`[server] price job ${job.id} (${job.user}) failed:`, msg)
      if (rec && rec.alive) { rec.status = 'error'; broadcast(job.user, itemAddedFor(rec, 'error')) }
    }
  } finally {
    working = false
    currentPriority = false
    currentJob = null
    broadcastQueue()
    pump()
  }
}

// ---------------------------------------------------------------------------
// poe.ninja — league list (GET /leagues) + real C:D. Cached server-side
// (>=15min), descriptive user agent. Caches are keyed BY LEAGUE (map), so
// two users on the same league share the cache.
// ---------------------------------------------------------------------------
let leaguesCache = { at: 0, list: null }

// The THIRD kind of outbound traffic, and the one no switch covered. The four
// background switches cover schedules, POE_REFERENCE_DISABLED covers the warm-up
// at boot, POE_REFERENCE_ON_CONNECT_DISABLED covers what a WebSocket sets off,
// and POE_PRICE_CHECK_DISABLED covers the foreground price check. This is none
// of those: it is a REQUEST — the browser asks `GET /leagues` to fill its
// dropdown, once per page load — so no amount of disabling schedules silences
// it. That is why it survived the round of switches added in B12 and was still
// the only thing a measured suite run reached out for in B25.
//
// A switch of its own rather than a wider meaning for an existing one, for the
// reason spelt out at POE_REFERENCE_ON_CONNECT_DISABLED: stretching a documented
// switch changes what an existing compose file does, silently.
//
// It is not only a test switch. An installation with no route to poe.ninja pays
// for this on every page load — the fetch has to fail before the dropdown can be
// drawn — and this turns that into no request at all.
//
// What it costs when set: the dropdown offers the leagues this installation
// already knows rather than the current list. Not the bare fallback pair, which
// would leave out the league everybody here is actually on: the leagues the
// configured users are in are known without asking anybody.
const LEAGUE_LIST_DISABLED = process.env.POE_LEAGUE_LIST_DISABLED === '1'
if (LEAGUE_LIST_DISABLED) {
  console.log('[leagues] list lookup disabled via POE_LEAGUE_LIST_DISABLED=1 — the dropdown offers the configured leagues and the fallbacks')
}

/** What this installation can answer without asking poe.ninja. */
function knownLeagues () {
  return [...new Set([
    ...USERS.map(u => users.get(u)?.league).filter(Boolean),
    ...FALLBACK_LEAGUES
  ])]
}

async function fetchLeagues () {
  if (LEAGUE_LIST_DISABLED) return knownLeagues()
  if (leaguesCache.list && Date.now() - leaguesCache.at < NINJA_MIN_MS) return leaguesCache.list
  try {
    const r = await fetch(`${NINJA_BASE}/leagues`, { headers: { 'User-Agent': NINJA_UA, Accept: 'application/json' } })
    if (r.ok) {
      const j = await r.json()
      const arr = Array.isArray(j) ? j : (j.leagues || j.economyLeagues || [])
      const list = arr.map(l => (typeof l === 'string' ? l : (l.id || l.name))).filter(Boolean)
      if (list.length) { leaguesCache = { at: Date.now(), list }; return list }
    }
  } catch { /* network/provider down -> fallback */ }
  return leaguesCache.list || FALLBACK_LEAGUES
}

// normSpark, fetchCurrencyExchange (+exchangeCache), fetchExchangeOverview
// (+exchangeOverviewCache) -> ninja.mjs (see the import above).

// C:D cache per league (>=15min). cdMsgByLeague carries live/fallback to the frontend.
const cdCache = new Map()      // league -> { at, ratio, spark, asOf }
const cdMsgByLeague = new Map() // league -> cdMsg

// Current C:D message for a league (cached -> live, otherwise env fallback).
// A value that came from poe.ninja carries `asOf` (when poe.ninja gave it),
// the server's `now` and `staleAfterMs`: when poe.ninja stops answering, the
// last value stays and the page shows its age instead of "live" (B29). The
// fallback carries none of the three — it never came from poe.ninja.
function cdMsgFor (league) {
  const m = cdMsgByLeague.get(league)
  if (!m) return { type: 'cd-ratio', chaosPerDivine: CD_FALLBACK, trendHint: 'fallback' }
  return typeof m.asOf === 'number' ? { ...m, now: Date.now(), staleAfterMs: sourceStaleAfterMs('ninja-cd') } : m
}

// Chaos per divine for converting a price in divine: { chaos, fallback }.
// chaos null: no usable rate at all. fallback: the rate is POE_CD_RATIO or
// older than its freshness limit, so a verdict that hangs on it is not given
// (buyer whispers, "Listed below market").
function divineRate (league) {
  const m = cdMsgFor(league)
  const chaos = Number(m.chaosPerDivine)
  if (!(chaos > 0)) return { chaos: null, fallback: true }
  const fallback = typeof m.asOf !== 'number' || (typeof m.staleAfterMs === 'number' && m.now - m.asOf > m.staleAfterMs)
  return { chaos, fallback }
}

// Real C:D via the currency EXCHANGE (Faustus NPC) — NOT the stash overview.
// lines[] with id==="divine" -> primaryValue = chaos per divine (~1265 in Standard).
// This row's sparkline is the 7-day trend for the C:D graph. Returns the
// league's cdMsg (and caches it), fallback = last known/env value.
async function refreshCdRatio (league) {
  const c = cdCache.get(league)
  if (c && Date.now() - c.at < NINJA_MIN_MS) {
    const msg = { type: 'cd-ratio', chaosPerDivine: c.ratio, trendHint: 'live · poe.ninja', sparkline: c.spark, asOf: c.asOf }
    cdMsgByLeague.set(league, msg)
    return cdMsgFor(league)
  }
  const ex = await fetchCurrencyExchange(league)
  const div = (ex?.lines || []).find(l => l.id === 'divine')
  const v = div?.primaryValue
  if (typeof v === 'number' && v > 0) {
    const spark = normSpark(div.sparkline?.data)
    // asOf is the time of the poe.ninja ANSWER. During an outage ninja.mjs
    // serves its last good answer, and stamping that with `now` kept the tile
    // on "live" for as long as the outage lasted.
    const asOf = typeof ex.fetchedAt === 'number' ? ex.fetchedAt : Date.now()
    cdCache.set(league, { at: Date.now(), ratio: Math.round(v), spark, asOf })
    const msg = { type: 'cd-ratio', chaosPerDivine: Math.round(v), trendHint: 'live · poe.ninja', sparkline: spark, asOf }
    cdMsgByLeague.set(league, msg)
    return cdMsgFor(league)
  }
  // Fallback: keep the last known value (start = env default)
  return cdMsgFor(league)
}

// ---------------------------------------------------------------------------
// Reference rail (left rail): currency + lifeforce (harvest lifeforce) + top 5
// beasts, each with a display string and mini sparkline. Currency/lifeforce from the
// SHARED exchange fetch (fetchCurrencyExchange), beasts from the stash item
// overview. Cached server-side (>=15min, keyed by league). Best-effort: never
// throws (like ninjaRefFor).
//
// The sparklines do NOT come from poe.ninja's `sparkline`/`sparkLine` field:
// that series is not consistently oriented across rows (the divine row
// tracks its chaos value, the lifeforce rows their divine value), so it can't be
// coloured honestly. The rail keeps its own series instead — see
// reference-history.mjs. poe.ninja's own sparkline stays in use for the C:D
// trend and the item card's ninja reference, which have a single known unit.
// ---------------------------------------------------------------------------

// Rows whose number IS the sell side (see sellRow below). `faustusName` is the
// RePoE/base-names name the Faustus store keys its rates by; `name` is what the
// rail prints. No poe.ninja exchange id here on purpose — these rows are priced
// entirely from Faustus, so an item poe.ninja has no exchange line for (Dead
// Man's Sulphur) is no different from one it has.
const LIFEFORCE_ROWS = [
  { name: 'Vivid Lifeforce', faustusName: 'Vivid Crystallised Lifeforce' },
  { name: 'Wild Lifeforce', faustusName: 'Wild Crystallised Lifeforce' },
  { name: 'Primal Lifeforce', faustusName: 'Primal Crystallised Lifeforce' }
]

// Dead Man's Sulphur (Metadata/Items/Currency/CurrencyDeepwater) sits in the
// CURRENCY section but is a Faustus-traded fungible exactly like the lifeforce
// rows -> same derivation, same `sell` shape, same display shape.
const SULPHUR_ROW = { name: "Dead Man's Sulphur", faustusName: "Dead Man's Sulphur" }

// What a row without usable Faustus data prints instead of a number. NOT a
// zero, NOT poe.ninja's market middle: the section says "Selling", so anything
// printed there must be a sell-side figure or nothing at all.
const NO_SELL_DATA = '—'

// Sell-side hint for a reference-rail row: does selling this item pay more
// against chaos or against divine, and how clearly? For the sellRow rows
// (lifeforce + Sulphur) this object ALSO carries their displayed number — see
// sellRevenuePerItem. Sources:
//   - the two SEPARATED per-market rates from the Faustus store (matched-trade
//     rates, same league/freshness guards as faustusChaosFor — a stale or
//     foreign-league digest never feeds a claim), and
//   - `ratio`, the rail's C:D — the tool's ONE shared C:D source (the
//     currency-exchange divine rate, same number the "/ div" conversions and
//     the Faustus bridge use). No second truth.
// The attestation policy (thin side -> show the reliable side, claim NO
// comparison) lives in sell-side.mjs. Returns the protocol `sell` object or
// null (the row then carries no `sell`).
//
// `railBetterByRow` remembers the last CLAIMED verdict ('chaos' | 'divine')
// per row, keyed by league + faustus name, so compareSellSides' hysteresis
// (CHAOS_HOLD_PCT vs CHAOS_TAKEOVER_PCT) has something to hold against. This
// is in-memory only and deliberately not persisted: after a restart the first
// comparison for a row always uses the takeover threshold, which is fine —
// hysteresis only needs to survive between consecutive hourly Faustus
// refreshes, not a process restart. Only updated when a comparison is
// actually claimed (`better` set); an `only` result or a null result (thin
// data, disabled Faustus, ...) leaves the remembered side untouched, so one
// thin hour can't reset the hold.
const railBetterByRow = new Map()

function railSellFor (faustusName, league, ratio) {
  if (FAUSTUS_DISABLED || !faustusName) return null
  if (typeof faustusStore?.getSell !== 'function') return null
  if (typeof faustusStore.league === 'function' && faustusStore.league() !== league) return null
  if (typeof faustusStore.isFresh === 'function' && !faustusStore.isFresh(FAUSTUS_TTL_MS)) return null
  const rowKey = `${league}::${faustusName}`
  const prevBetter = railBetterByRow.get(rowKey) ?? null
  const cmp = compareSellSides(faustusStore.getSell(faustusName), ratio, prevBetter)
  if (!cmp || (!cmp.better && !cmp.only)) return null
  if (cmp.better) railBetterByRow.set(rowKey, cmp.better)
  const sig4 = v => (typeof v === 'number' && isFinite(v)) ? Number(v.toPrecision(4)) : null
  const sell = {
    better: cmp.better, // 'chaos' | 'divine' | null (null -> no comparison claimed)
    only: cmp.only, // the single attested side when no comparison is claimed
    edgePct: cmp.edgePct == null ? null : Math.round(cmp.edgePct * 10) / 10,
    viaChaos: sig4(cmp.viaChaos), // chaos revenue per piece via the chaos market
    viaDivine: sig4(cmp.viaDivine), // chaos revenue per piece via the divine market (bridged at `cd`)
    cd: ratio,
    updatedAt: typeof faustusStore.updatedAt === 'function' ? faustusStore.updatedAt() : null
  }
  return sell
}

// Group thousands with commas — bridged divine-side numbers are routinely
// five digits (31208 pieces per divine) and unreadable without it.
//
// Rounding to a whole piece is not safe: the unit follows the recommendation,
// with no scarcity threshold guaranteeing at least 5 pieces per chaos before a
// row is quoted in chaos, so a row whose recommended side yields well under one
// piece per unit reaches this — where Math.round prints "0", or "1" for
// anything from 0.5 to 1.5, i.e. it destroys the very number the row exists to
// show. Only that
// range needs decimals; from 10 up a whole piece is what a seller counts and
// the extra digits would just be noise.
function grouped (n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '0'
  const v = n >= 10 ? Math.round(n) : Number(n.toPrecision(3))
  return v.toLocaleString('en-US')
}

// Unit for a per-piece chaos value FOLLOWS THE RECOMMENDATION (`side`, the
// sellRow's `sell.better || sell.only`), not a scarcity threshold: one
// statement per row — which market to sell on, and the rate on that market.
// priceC = chaos per 1 piece, ratio = current C:D.
//   side 'chaos'  -> pieces per 1 chaos  (1/priceC),   unit 'perC',  "N / c"
//   side 'divine' -> pieces per 1 divine (ratio/priceC), unit 'perDiv', "N / div"
// Returns the unit alongside the string: the rail's sparkline has to be drawn
// in the SAME unit, and the history stores the canonical chaos value, not this
// number (see reference-history.mjs).
function perPieceDisplay (priceC, ratio, side) {
  return side === 'divine'
    ? { display: `${grouped(ratio / priceC)} / div`, unit: 'perDiv' }
    : { display: `${grouped(1 / priceC)} / c`, unit: 'perC' }
}

// The chaos a seller actually collects per piece, taken from the very `sell`
// object the row's unit is chosen from — the better side when a comparison is
// claimed, the single attested side when only one is. null when the row has
// nothing trustworthy (railSellFor already returns null then).
//
// THE POINT OF THIS FUNCTION: number AND sparkline of these rows both read
// the same value here. Mixing them (number = poe.ninja's market middle, the
// sell-side hint = Faustus sell side) is exactly the mix-up the "Selling"
// heading must not reintroduce.
function sellRevenuePerItem (sell) {
  if (!sell) return null
  const pick = side => {
    const v = side === 'chaos' ? sell.viaChaos : sell.viaDivine
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : null
  }
  if (sell.better) return pick(sell.better)
  if (sell.only) return pick(sell.only)
  return null
}

// One Faustus-priced rail row ({ name, faustusName }). Carries the same fields
// as the other rows (see refreshReference); `chaos` is the sell-side revenue
// per piece, so the stored history — and with it the sparkline — follows the
// displayed number by construction.
//
// The history key is deliberately NEW (`s:` instead of the old `j:`): the old
// points hold poe.ninja market middles, and splicing a Faustus series onto them
// would draw a source change as if it were a market move. Unknown key -> no
// points -> no line until this source has recorded two of its own (same state
// as right after a deploy). The orphaned `j:` points age out of the 7-day
// retention on their own; nothing has to be deleted.
function sellRow (row, league, ratio) {
  const sell = railSellFor(row.faustusName, league, ratio)
  const chaos = sellRevenuePerItem(sell)
  // `name` is the SHORTENED English wording the rail prints ("Vivid Lifeforce"
  // for "Vivid Crystallised Lifeforce") and exists nowhere in the data set, so
  // it can never be looked up. `refName` is the real reference name and is what
  // the localized-name table is keyed by (GET /item-name-map): without it these
  // three rows are the only ones on the rail that could not be translated. The
  // other rows already carry the reference name in `name` itself.
  const base = { name: row.name, refName: row.faustusName, key: `s:${row.faustusName}`, invert: true }
  // invert: these rows print a QUANTITY per currency unit, so a rising number
  // means the item got cheaper — bad news for the seller reading the rail.
  // `src` names where the PRINTED NUMBER comes from; it stays absent while the
  // row prints "—", because a row without a number has no source to claim (see
  // the src note in refreshReference).
  if (chaos == null) return { ...base, display: NO_SELL_DATA, chaos: null, unit: null, sell: null }
  // sell is non-null here (chaos came from sellRevenuePerItem(sell), which
  // requires sell.better or sell.only to produce a value) — the recommended
  // side is exactly what perPieceDisplay quotes the row's unit against.
  const d = perPieceDisplay(chaos, ratio, sell.better || sell.only)
  return { ...base, display: d.display, chaos, unit: d.unit, sell, src: 'faustus' }
}

const refCache = new Map()      // league -> { at, msg }
const refMsgByLeague = new Map() // league -> refMsg

// Current reference message for a league (cached, otherwise empty fallback).
function refMsgFor (league) {
  return refMsgByLeague.get(league) || { type: 'reference', league, currency: [], lifeforce: [], beasts: [] }
}

async function refreshReference (league) {
  const c = refCache.get(league)
  if (c && Date.now() - c.at < NINJA_MIN_MS) { refMsgByLeague.set(league, c.msg); return c.msg }
  try {
    const ex = await fetchCurrencyExchange(league)
    const lines = ex?.lines || []
    const byId = id => lines.find(l => l.id === id)
    // Ratio directly from the same exchange response (divine row), fallback: cdMsg.
    const div = byId('divine')
    const ratio = (typeof div?.primaryValue === 'number' && div.primaryValue > 0)
      ? Math.round(div.primaryValue) : cdMsgFor(league).chaosPerDivine

    // Currency: Mirror in divine (mirror-chaos / ratio), then Dead Man's
    // Sulphur — the latter Faustus-priced like the lifeforce rows (sellRow).
    // Every row carries, besides its display string:
    //   key    stable identity in the history file
    //   chaos  canonical chaos value of ONE unit (what gets stored)
    //   unit   the unit the DISPLAYED number is in -> the sparkline is drawn in it
    //   invert whether a RISING displayed number is bad (see below)
    //   src    which feed the DISPLAYED number comes from: 'ninja' (poe.ninja
    //          exchange/overview, refreshed with this message's refreshedAt) or
    //          'faustus' (Faustus sell side, refreshed on the store's own
    //          hourly clock, stamped in the row's sell.updatedAt). The two
    //          feeds run on different clocks and are MIXED inside a section
    //          (Mirror is ninja, the Sulphur row right below it is Faustus), so
    //          the rail cannot carry one shared "updated HH:MM". A row that
    //          prints "—" carries NO src: nothing may be attributed to it.
    // `sell` (optional, may be null): the sell-side hint — which currency pays
    // a seller more right now. Uniform across currency and lifeforce rows (both
    // are Faustus-traded fungibles); beasts have no exchange market at all, so
    // they never carry one.
    const currency = []
    const mir = byId('mirror')
    if (mir && typeof mir.primaryValue === 'number' && mir.primaryValue > 0) {
      // src 'ninja': the NUMBER is poe.ninja's exchange price. The row's `sell`
      // field is still Faustus-derived and carries its own stamp
      // (`sell.updatedAt`) — that is separate provenance, not the row's number.
      currency.push({ name: 'Mirror of Kalandra', display: `${Math.round(mir.primaryValue / ratio)} div`, key: 'c:mirror', chaos: mir.primaryValue, unit: 'div', invert: false, src: 'ninja', sell: railSellFor('Mirror of Kalandra', league, ratio) })
    }
    currency.push(sellRow(SULPHUR_ROW, league, ratio))

    // Lifeforce (harvest lifeforce): number and sparkline both from the
    // Faustus sell side — see sellRow. Auto c/d unit as before.
    const lifeforce = LIFEFORCE_ROWS.map(j => sellRow(j, league, ratio))

    // Beasts: stash item overview (field `sparkLine`, value in chaos/divineValue).
    // Confidence via `count` (= poe.ninja's number of data points, NOT `listingCount`
    // — that doesn't discriminate confidence): low-confidence beasts get floored by
    // poe.ninja to ~1 divine, the "never traded" placeholder (chaosValue≈mirror value)
    // has count 1–4. `count>=15` filters exactly those out and reproduces poe.ninja's
    // default view ("show low confidence" off). Then sorted by chaosValue
    // descending, top 5. Displayed in div from >=1 divine, otherwise in chaos.
    const beastLines = (await fetchItemOverview(league, 'Beast')) || []
    const beasts = beastLines
      .filter(l => typeof l.chaosValue === 'number' && (l.count || 0) >= 15)
      .sort((a, b) => b.chaosValue - a.chaosValue)
      .slice(0, 5)
      .map(l => {
        const asDiv = typeof l.divineValue === 'number' && l.divineValue >= 1
        return {
          name: l.name,
          display: asDiv ? `${Math.round(l.divineValue)} div` : `${Math.round(l.chaosValue)} c`,
          key: `b:${l.name}`,
          chaos: l.chaosValue,
          unit: asDiv ? 'div' : 'c',
          invert: false, // a price: rising is good
          src: 'ninja'
        }
      })

    // Own series instead of poe.ninja's `sparkline`: append this refresh as ONE
    // point (canonical chaos values + the C:D of this moment), then draw each row
    // from the history, converted into the unit its number is printed in.
    // Best-effort like the rest of the reference code — a failing history write
    // must never take the rail down.
    const rows = [...currency, ...lifeforce, ...beasts]
    try {
      const values = {}
      for (const r of rows) values[r.key] = r.chaos
      // The same answer served again is not a new point for ITS rows
      // (reference-history.mjs, B29). Per feed: the poe.ninja exchange answer
      // carries Mirror, the item overview the beasts, the Faustus store
      // (stamped on its own hourly tick, not on this 15 min rebuild) Sulphur
      // and lifeforce. One feed standing still never takes the others' points.
      const faustusRows = [...currency, ...lifeforce].filter(r => r.src === 'faustus')
      const feeds = {
        exchange: { at: ex?.fetchedAt ?? null, keys: currency.filter(r => r.src === 'ninja').map(r => r.key) },
        beasts: { at: itemOverviewFetchedAt(league, 'Beast'), keys: beasts.map(r => r.key) },
        faustus: { at: faustusRows.find(r => typeof r.sell?.updatedAt === 'number')?.sell.updatedAt ?? null, keys: faustusRows.map(r => r.key) }
      }
      await referenceHistory.append(league, { cdRatio: ratio, values, feeds })
    } catch (e) {
      console.warn(`[reference] history append failed: ${e?.message || e}`)
    }
    // <2 usable points -> empty array -> the frontend draws no line at all
    // (no placeholder, no invented series). That's the state right after a deploy.
    for (const r of rows) {
      r.sparkline = referenceHistory.series(league, r.key, r.unit)
      delete r.key
      delete r.chaos
      delete r.unit
      if (r.sell == null) delete r.sell // no hint -> field absent, not null
    }

    // refreshedAt = when this poe.ninja data was actually fetched — the time of
    // the ANSWER (ninja.mjs fetchedAt), not of this rebuild, which during an
    // outage serves an old answer. Baked into the message so it survives
    // caching -> the frontend can show "poe.ninja updated at HH:MM".
    const msg = { type: 'reference', league, currency, lifeforce, beasts, refreshedAt: ex?.fetchedAt ?? Date.now() }
    refCache.set(league, { at: Date.now(), msg })
    refMsgByLeague.set(league, msg)
    return msg
  } catch { /* network/provider down -> keep last known reference */ }
  return refMsgFor(league)
}

// ---------------------------------------------------------------------------
// F3 (stretch): poe.ninja reference price + 7-day sparkline per unique.
// ninjaTypeFor + fetchItemOverview (+itemOverviewCache) -> ninja.mjs
// (see the import above). Match only for uniques (rares have no ninja price).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bulk/non-gear item pricing via poe.ninja (Divination Cards, Beasts,
// Incubators, Vials, ...). Extensible classifier: each entry decides (via
// `test`, cheap + synchronous — no item class ever pays for a fetch it
// doesn't need) whether a ParsedItem belongs to this poe.ninja-priced bucket,
// and which of the two poe.ninja endpoint families serves it:
//   'exchange' -> fetchExchangeOverview  (exchange/current/overview, the
//                 Faustus bulk-exchange aggregate; lines have no name, only
//                 an id, matched via the type's items[] name->id table)
//   'item'     -> fetchItemOverview      (stash/current/item/overview; lines
//                 carry the name directly — same endpoint refreshReference's
//                 beast rows and ninjaRefFor's unique lookups already use)
//
// Populated ONLY with classes verified live against poe.ninja — anything
// dropped here simply keeps going through the existing trade routing below.
//
// Divination Cards: `item.category === 'Divination Card'` is exact and
// unique to this class (see Parser.ts) -> the whole class routes to
// poe.ninja, unconditionally. THE reason this feature exists: div cards have
// no exchange tradeTag (bulkPriceItem can't price them) and PoE's stat search
// (searchPreset) returns single "listings" for them that are overwhelmingly
// stale (a card like "The Fortunate" shows a handful of long-dead listings).
//
// Captured Beasts: same story — `category === 'Captured Beast'`, no
// tradeTag, single-listing trade search only.
//
// Incubators / Vials: BOTH have `category === 'Currency'` (PoE's clipboard
// literally says "Rarity: Currency" for them, same as real currency/scarabs/
// essences/etc. — see the `useBulk` comment above in pump()), so `category`
// alone can't tell them apart from the Currency-class items that already
// have a tradeTag and correctly go through the live bulk exchange
// (bulkPriceItem) — those must NOT be redirected here. `tradeTag == null`
// excludes exactly that (verified against renderer/public/data/en/items.
// ndjson: every Scarab/Oil/Essence/Fossil/Resonator/Delirium-Orb/Fragment/
// real-Currency base has a tradeTag; every Incubator/Vial base has none), and
// the refName pattern then picks the specific sub-class poe.ninja actually
// has a matching `item/overview` type for.
//
// Left OPEN (see report): Fragments/Scarabs/Oils/Essences/Fossils/
// Resonators/Delirium Orbs (already correctly bulk-priced, tradeTag != null
// — must stay untouched per the task's constraints) and Corpses (not a
// poe.ninja economy type at all — verified: absent from the 47-type list
// poe.ninja's dense overview enumerates).
// `ninjaSlug` is the poe.ninja economy overview slug for this class — used to
// build the "Open Ninja" deep link (https://poe.ninja/economy/<league>/<slug>/<item>).
const NINJA_BULK_CLASSES = [
  {
    name: 'Divination Card',
    source: 'exchange',
    type: 'DivinationCard',
    ninjaSlug: 'divination-cards',
    test: item => item.category === 'Divination Card'
  },
  {
    name: 'Captured Beast',
    source: 'item',
    type: 'Beast',
    ninjaSlug: 'beasts',
    test: item => item.category === 'Captured Beast'
  },
  {
    name: 'Incubator',
    source: 'item',
    type: 'Incubator',
    ninjaSlug: 'incubators',
    test: item => item.category === 'Currency' && item.info?.tradeTag == null &&
      /Incubator$/.test(item.info?.refName || item.name || '')
  },
  {
    name: 'Vial',
    source: 'item',
    type: 'Vial',
    ninjaSlug: 'vials',
    test: item => item.category === 'Currency' && item.info?.tradeTag == null &&
      /^Vial of /.test(item.info?.refName || item.name || '')
  }
]

// poe.ninja URL slugs: lowercase, apostrophes dropped, every other run of
// non-alphanumerics collapsed to a single dash ("The Fortunate" -> the-fortunate,
// "Standard" -> standard). Matches poe.ninja's own economy-page slug convention.
function ninjaSlugify (s) {
  return String(s || '').trim().toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Deep link to the item's poe.ninja economy page, or null if we can't build one.
function ninjaUrlFor (cls, name, league) {
  if (!cls?.ninjaSlug || !name || !league) return null
  return `https://poe.ninja/economy/${ninjaSlugify(league)}/${cls.ninjaSlug}/${ninjaSlugify(name)}`
}

function ninjaBulkClassFor (item) {
  for (const cls of NINJA_BULK_CLASSES) if (cls.test(item)) return cls
  return null
}

// ---------------------------------------------------------------------------
// The key an item is looked up by in an ENGLISH price source
// ---------------------------------------------------------------------------
// `item.name` is the DISPLAY name and follows the client language: on a German
// parse it reads "Chaos-Kugel", and poe.ninja's lines, the Faustus digest and
// the trade site all only know "Chaos Orb". `info.refName` is the reference
// name the data set keeps English in EVERY language (the design's tragendes
// Prinzip — data/de carries a German `name` next to the same English
// `refName`), so it, not the display name, is what those sources are indexed
// by. Everything user-facing keeps using the display name; this is purely the
// lookup key.
//
// The guard is what makes the swap safe. `info` describes THIS name only when
// its own display name is the one on the name plate, and findInDatabase
// (engine.bundle.mjs) deliberately breaks that for a few classes:
//
//   - a Voidstone is resolved as ITEM_BY_REF("ITEM", "Charged Compass"), and
//     "Charged Compass" has its own Currency-Exchange rate (it is in
//     base-names.json) — handing that refName to faustusStore.getPrice would
//     price every Voidstone as a compass,
//   - a rare/normal item resolves to its BASE (`item.baseType ?? item.name`),
//     so refName is the base type and never the item's own name,
//   - a captured beast does the same when the clipboard carries a base line.
//
// Where the two disagree, the display name stays the only honest key and the
// caller falls back to it: the plain display-name lookup, bit for bit.
//
// For English the whole thing is a no-op by construction: in
// data/en/items.ndjson `name === refName` holds for every single entry
// (4738/4738 at the time of writing), so whenever the guard passes, refName IS
// what the old `item.name || item.info?.name` expression already returned.
function refNameOf (item) {
  const info = item?.info
  if (!info?.refName) return null
  const shown = item.name || info.name
  if (shown && info.name && shown !== info.name) return null
  return info.refName
}

// The lookup key for the English price sources: reference name first, display
// name only as the last resort (see refNameOf for when that happens).
const priceKeyOf = item => refNameOf(item) || item?.name || item?.info?.name || null

// Best-effort poe.ninja lookup for a NINJA_BULK_CLASSES item. Returns
// `{ chaos, count, sparkline }` or `null` — null covers ALL miss cases alike
// (item class not in the map, poe.ninja doesn't know this exact name yet, the
// league/type combination has no data, or the request itself failed) so the
// caller (pump(), server.mjs) has one simple check to fall back to the normal
// trade routing. Never throws.
async function ninjaBulkPrice (item, league) {
  const cls = ninjaBulkClassFor(item)
  if (!cls) return null
  // poe.ninja indexes its lines by the English name (`l.name === name` /
  // `nameToId`), so this has to be the reference name — see priceKeyOf.
  const name = priceKeyOf(item)
  if (!name) return null
  const url = ninjaUrlFor(cls, name, league)

  if (cls.source === 'item') {
    const lines = await fetchItemOverview(league, cls.type)
    const line = lines && lines.find(l => l.name === name)
    if (!line || typeof line.chaosValue !== 'number') return null
    return {
      chaos: round1(line.chaosValue),
      count: typeof line.count === 'number' ? line.count : null,
      sparkline: normSpark(line.sparkLine?.data ?? line.sparkline?.data),
      url
    }
  }

  // source === 'exchange'
  const data = await fetchExchangeOverview(league, cls.type)
  if (!data) return null
  const id = data.nameToId.get(name)
  const line = id != null ? data.lineById.get(id) : null
  if (!line || typeof line.primaryValue !== 'number') return null
  return {
    chaos: round1(line.primaryValue),
    count: null,
    sparkline: normSpark(line.sparkline?.data),
    url
  }
}

// price-result for a poe.ninja bulk hit — same message TYPE as toPriceResult
// (the frontend keys off `type`, not a separate message kind) so it slots
// straight into the existing card-update path, but `display:'ninja'` +
// `priceSource:'ninja'` tell app.js to render a market value instead of a
// listings table, and there IS no trade query behind it (tradeId null ->
// tradeBtnHtml already renders a disabled "Open Trade" button for that).
// Single aggregated market value (no trade query behind it). `opts` names the
// source for the card; the default is poe.ninja, the other user is the GGG
// Currency Exchange (Faustus) for fungibles the bulk exchange didn't answer.
function toNinjaPriceResult (id, ninjaPrice, league, opts = {}) {
  return {
    type: 'price-result',
    id,
    display: 'ninja',
    priceSource: opts.source || 'ninja',
    sourceLabel: opts.label || 'poe.ninja',
    sourceNote: opts.note || null,
    // Only the Currency-Exchange caller passes this, and only past the
    // unavoidable lag — see withExchangeMain. poe.ninja's own aggregates carry
    // no comparable per-item observation time, so they never set it.
    ...(typeof opts.ageHours === 'number' && opts.ageHours > 0 ? { exchangeAgeHours: opts.ageHours } : {}),
    currency: 'chaos',
    priceLow: ninjaPrice.chaos,
    priceHigh: ninjaPrice.chaos,
    count: ninjaPrice.count,
    listings: [],
    tradeId: null,
    tradeKind: null,
    ninjaUrl: ninjaPrice.url ?? null,
    league
  }
}

// Chaos rate for a fungible straight from the Currency Exchange digest (Faustus)
// — the same market the in-game window shows. Guarded exactly like the
// valuator's: only for the league the store was built for, and only while the
// store is fresh, so a stale or foreign-league digest never prices anything.
function faustusChaosFor (item, league) {
  if (FAUSTUS_DISABLED) return null
  if (typeof faustusStore?.getPrice !== 'function') return null
  if (typeof faustusStore.league === 'function' && faustusStore.league() !== league) return null
  if (typeof faustusStore.isFresh === 'function' && !faustusStore.isFresh(FAUSTUS_TTL_MS)) return null
  // The digest is keyed by the English currency name (base-names.json bridges
  // GGG's metadata ids to it), so the lookup key is the reference name — see
  // priceKeyOf. Without it a German parse silently loses the exchange headline,
  // i.e. exactly the price that IS correct, and falls back to trade asks.
  const name = priceKeyOf(item)
  if (!name) return null
  const v = faustusStore.getPrice(name)
  if (!(typeof v === 'number' && v > 0)) return null
  // Per-item age gate, the SAME one the net-worth valuator applies
  // (networth/valuator.mjs fromFaustus) — on purpose: a card and the net worth
  // that disagree about one item are worse than either being wrong alone. Too
  // old -> null -> this item routes exactly like one Faustus never quoted
  // (poe.ninja bulk, else the trade search).
  if (typeof faustusStore.getHour === 'function' &&
      faustusTooOld(faustusStore.getHour(name), { maxMs: FAUSTUS_MAX_AGE_MS })) return null
  return v
}

// Whole hours of age worth printing on the card for a Faustus-priced item, or
// null when the price is as fresh as the pipeline can make it. Null is the
// normal case by design: a label that is always there is not read (see
// networth/faustus-age.mjs staleHours). Guards match faustusChaosFor's, so a
// price it refuses never carries an age here either.
function faustusStaleHoursFor (item, league) {
  if (FAUSTUS_DISABLED) return null
  if (typeof faustusStore?.getHour !== 'function') return null
  if (typeof faustusStore.league === 'function' && faustusStore.league() !== league) return null
  if (typeof faustusStore.isFresh === 'function' && !faustusStore.isFresh(FAUSTUS_TTL_MS)) return null
  const name = priceKeyOf(item)
  if (!name) return null
  return faustusStaleHours(faustusStore.getHour(name), { refreshMs: FAUSTUS_REFRESH_MS })
}

// The chaos range that same digest hour actually traded at ({min,max}), or null
// — same league/freshness guards as faustusChaosFor. Absent for a store written
// before ranges existed, which is fine: the card then just shows no span.
function faustusRangeFor (item, league) {
  if (FAUSTUS_DISABLED) return null
  if (typeof faustusStore?.getRange !== 'function') return null
  if (typeof faustusStore.league === 'function' && faustusStore.league() !== league) return null
  if (typeof faustusStore.isFresh === 'function' && !faustusStore.isFresh(FAUSTUS_TTL_MS)) return null
  const name = priceKeyOf(item) // English key, same reason as in faustusChaosFor
  if (!name) return null
  const r = faustusStore.getRange(name)
  return (r && r.min > 0 && r.min < r.max) ? r : null
}

async function ninjaRefFor (item, league) {
  if (String(item.rarity || '').toLowerCase() !== 'unique') return null
  const type = ninjaTypeFor(item)
  if (!type) return null
  const lines = await fetchItemOverview(league, type)
  if (!lines || !lines.length) return null
  // poe.ninja's unique lines carry the English unique name -> reference name,
  // not the display name (see priceKeyOf). For a Unique `info` IS the UNIQUE
  // entry, so refName is the unique's own English name and the guard passes.
  const name = priceKeyOf(item)
  // …which is exactly why the baseType tiebreak must NOT read refName: for a
  // Unique that IS the unique's own name and never a base type, so the
  // comparison could not come out true and the first line always won. The base a
  // Unique sits on is `info.unique.base` (English in the data whatever the
  // client language) — the same field fromItemOverview joins on in
  // networth/valuator.mjs. It decides between the five uniques that carry one
  // name on several bases (Precursor's Emblem on five ring bases, Combat Focus
  // and Grand Spectrum on three jewels each), where poe.ninja keeps one line per
  // base under the one name.
  const base = item.info?.unique?.base
  const cands = lines.filter(l => l.name === name)
  if (!cands.length) return null
  const pick = (base && cands.find(l => l.baseType === base)) || cands[0]
  // sparkLine.data = 7-day change series (can have leading nulls). For the
  // mini trend, set leading nulls to 0 (= baseline), keep point count.
  const raw = pick.sparkLine?.data ?? pick.sparkline?.data ?? pick.sparkLine ?? pick.sparkline
  const sparkline = Array.isArray(raw) && raw.some(n => typeof n === 'number')
    ? raw.map(n => (typeof n === 'number' ? n : 0))
    : []
  return {
    chaos: typeof pick.chaosValue === 'number' ? Math.round(pick.chaosValue) : null,
    divine: typeof pick.divineValue === 'number' ? Math.round(pick.divineValue * 100) / 100 : null,
    sparkline
  }
}

// Fetch ninja ref best-effort + broadcast as `ninja-ref` into the user's room
// (never blocking). Uses the user's league.
function pushNinjaRef (user, id) {
  if (PRICE_CHECK_DISABLED) return // same switch: pricing an item sends nothing at all
  const room = users.get(user)
  if (!room) return
  const rec = room.items.get(id)
  if (!rec || !rec.alive) return
  ninjaRefFor(rec.item, room.league).then(ref => {
    const r = room.items.get(id)
    if (ref && r && r.alive) { r.ninja = ref; broadcast(user, { type: 'ninja-ref', id, ...ref }) }
  }).catch(() => {})
}

// The reference traffic a CONNECTED CLIENT sets off, as opposed to the one-time
// warm-up at boot that POE_REFERENCE_DISABLED covers. Two paths lead into it: a
// WS connect whose league has no warm cache, and a user switching leagues. Each
// sends two poe.ninja requests, and neither had a switch — so "boot the real
// server and let it reach nothing" was not expressible, and the two server test
// files each sent those two requests on every run (docs/bugs.md B12).
//
// A SWITCH OF ITS OWN RATHER THAN A WIDER MEANING FOR THE BOOT ONE.
// POE_REFERENCE_DISABLED is documented precisely as "skips the one-time warm-up
// done at boot"; stretching it to cover a client-triggered fetch would change
// what an existing compose file does, silently, in the direction of less data.
// The precedent is POE_PRICE_CHECK_DISABLED, which was added for exactly this
// class — the foreground path the four background switches never covered —
// rather than folded into one of them.
//
// What it costs when set: a room whose league has no cached C:D ratio or
// reference rail keeps the fallback values until the periodic refresh reaches
// that league. Nothing is retried and nothing is queued for later.
const REFERENCE_ON_CONNECT_DISABLED = process.env.POE_REFERENCE_ON_CONNECT_DISABLED === '1'
if (REFERENCE_ON_CONNECT_DISABLED) {
  console.log('[reference] on-connect warm-up disabled via POE_REFERENCE_ON_CONNECT_DISABLED=1 — a league with a cold cache stays on its fallback values')
}

// Warm up a league (cd + ref) and then broadcast to the room of users on this
// league. For fresh connections whose league doesn't have a warm cache yet.
function warmLeague (league) {
  if (REFERENCE_ON_CONNECT_DISABLED) return
  refreshCdRatio(league)
    .then(() => { broadcastLeague(league, cdMsgFor(league)); return refreshReference(league) })
    .then(() => broadcastLeague(league, refMsgFor(league)))
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// Client language at runtime (see user-lang-store.mjs)
// ---------------------------------------------------------------------------

/** The languages a user may actually be switched to right now. */
function availableLangs () { return engines.liveLanguages() }

/**
 * setUserLang(user, lang) -> { ok: true, persisted } | { ok: false, error }
 *
 * Checked against the LIVE parsers, not against SUPPORTED_LANGS: the latter is
 * the list of languages the tool can support in principle, and moving a user
 * onto one this container has no parser for would swap his 503-free item route
 * for a permanent one.
 *
 * Order matters and is: validate -> persist -> apply in memory -> tell the
 * browsers. Persisting first means a failing write can never leave a language
 * that is in force but nowhere on disk, i.e. one that reverts at the next
 * restart with nothing to show for it.
 */
async function setUserLang (user, lang) {
  const room = users.get(user)
  if (!room) return { ok: false, status: 400, error: `unknown user "${user}"` }
  const available = availableLangs()
  if (typeof lang !== 'string' || !available.includes(lang)) {
    return {
      ok: false,
      status: 400,
      error: `language "${lang}" is not available on this server`,
      available
    }
  }
  // "Unchanged" only when there is nothing to write. A user with a parked
  // choice (user-lang-store.mjs) who picks the language he is on right now is
  // replacing that parked choice, and it must not come back over his newest
  // one at the next start or data update.
  if (lang === room.lang && !userLangStore.parked().has(user)) {
    return { ok: true, persisted: userLangStore.writable, unchanged: true }
  }

  let persisted
  try {
    persisted = await userLangStore.set(user, lang)
  } catch (e) {
    console.warn(`[user-langs] could not persist the language for "${user}": ${e?.code || e?.message || e}`)
    return { ok: false, status: 500, error: 'the language could not be saved' }
  }
  room.lang = lang
  LANG_BY_USER.set(user, lang)
  // The page learns its language from `league-state` (PROTOCOL.md) — the same
  // message it already gets on connect, so nothing new has to be understood on
  // the other side and every open tab of this user follows immediately.
  broadcast(user, { type: 'league-state', active: room.league, lang: room.lang })
  return { ok: true, persisted }
}

/**
 * reviveParkedLangs() -> nothing
 *
 * Puts every parked choice (user-lang-store.mjs) whose parser is live now back
 * in force and tells that user's open tabs, with the same `league-state` a
 * switch on the settings page sends. Called from applyAptData (the data
 * refresher's onAptData handler) after a successful engine reload: reload()
 * retries every instance that is down, so a data update that brings a missing
 * data set makes its parser live without a restart. Writes nothing — the file
 * held the choice all along. user-lang-park.test.mjs drives it through
 * applyAptData.
 */
function reviveParkedLangs () {
  for (const [user, lang] of userLangStore.unpark({ isLive: l => engines.liveLanguages().includes(l) })) {
    LANG_BY_USER.set(user, lang)
    const room = users.get(user)
    if (room && room.lang !== lang) {
      room.lang = lang
      broadcast(user, { type: 'league-state', active: room.league, lang: room.lang })
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime configuration view (admin area)
// ---------------------------------------------------------------------------

/**
 * The settings that are NOT editable from the web UI, as this process really
 * resolved them — built from the server's own constants rather than re-derived
 * from env, so the view cannot drift away from what is actually running.
 *
 * NOTHING SECRET IS BUILT INTO THIS LIST, and `redactView()` in
 * config-overrides.mjs drops anything whose name looks like a secret on the way
 * out anyway. No POESESSID, no account name, no admin password, no path to the
 * credential file — not the value, not a mask, not a length.
 */
function runtimeConfigEntries () {
  const bool = v => (v ? '1' : '0')
  const entries = [
    { name: 'PORT', value: String(server.address()?.port ?? PORT) },
    { name: 'POE_USERS', value: USERS.join(',') },
    // The environment variable as given, and — separately — what is actually in
    // force. Those two are NOT the same thing: a language a user picked himself
    // beats the variable (user-lang-store.mjs), so printing the effective
    // mapping under the variable's name would describe a compose line that does
    // not exist. Two rows, each honest about which of the two it is.
    { name: 'POE_USER_LANGS (starting value from the environment)', value: process.env.POE_USER_LANGS || '' },
    { name: 'client language per user, in force (including each user’s own choice)', value: [...LANG_BY_USER].map(([u, l]) => `${u}:${l}`).join(',') },
    { name: 'POE_CD_RATIO', value: String(CD_FALLBACK) },
    { name: 'POE_CD_REFRESH_MS', value: String(CD_REFRESH_MS) },
    { name: 'POE_MAX_ITEMS_PER_ROOM', value: String(MAX_ITEMS_PER_ROOM) },
    { name: 'POE_MAX_REQUEUE_ON_RECONNECT', value: String(MAX_REQUEUE_ON_RECONNECT) },
    { name: 'POE_RATE_LIMIT_BANNER_MIN_SEC', value: String(RATE_LIMIT_BANNER_MIN_SEC) },
    { name: 'POE_RATE_LIMIT_STATE', value: RATE_LIMIT_STATE },
    { name: 'POE_NETWORTH_STORE', value: NETWORTH_STORE },
    { name: 'POE_NETWORTH_HISTORY', value: NETWORTH_HISTORY },
    { name: 'POE_NETWORTH_SESSIONS', value: NETWORTH_SESSIONS },
    { name: 'POE_SESSIONS_KEEP', value: String(SESSIONS_KEEP) },
    { name: 'POE_SESSION_FINALIZE_MAX_MS', value: String(SESSION_FINALIZE_MAX_MS) },
    { name: 'POE_SESSION_GAME_GAP_MS', value: String(SESSION_GAME_GAP_MS) },
    { name: 'POE_SESSION_AUTO_GAME', value: bool(SESSION_AUTO_GAME) },
    { name: 'POE_NETWORTH_LIST_TTL_MS', value: String(NETWORTH_LIST_TTL_MS) },
    { name: 'POE_NETWORTH_COOLDOWN_MS', value: String(NETWORTH_COOLDOWN_MS) },
    { name: 'POE_NETWORTH_SLOW_STEP_MS', value: String(NETWORTH_SLOW_STEP_MS) },
    { name: 'POE_NETWORTH_GUARD_FACTOR', value: String(NETWORTH_GUARD.factor) },
    { name: 'POE_NETWORTH_GUARD_SHARE', value: String(NETWORTH_GUARD.share) },
    { name: 'POE_NETWORTH_GUARD_HOLD_MS', value: String(NETWORTH_GUARD.maxHoldMs) },
    { name: 'POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE', value: String(NETWORTH_GUARD.arrivalMinDivine) },
    { name: 'POE_NETWORTH_GUARD_STATE_MAX_NAMES', value: String(NETWORTH_GUARD.stateMaxNames) },
    { name: 'net-worth guard memory (derived from POE_NETWORTH_HISTORY)', value: networthHistory.guardStatePath ?? '' },
    { name: 'POE_FAUSTUS_STORE', value: FAUSTUS_STORE },
    { name: 'POE_FAUSTUS_UNION_HOURS', value: String(FAUSTUS_UNION_HOURS ?? 'default') },
    { name: 'POE_FAUSTUS_REFRESH_MS', value: String(FAUSTUS_REFRESH_MS) },
    { name: 'POE_FAUSTUS_TTL_MS', value: String(FAUSTUS_TTL_MS) },
    { name: 'POE_SOURCE_STALE_MS', value: String(envNum('POE_SOURCE_STALE_MS')) },
    { name: 'POE_NINJA_MAX_AGE_MS', value: String(NINJA_MAX_AGE_MS) },
    { name: 'POE_NINJA_MAP_TTL_MS', value: String(NINJA_MAP_TTL_MS) },
    { name: 'POE_NINJA_FAIL_LOG_MS', value: String(NINJA_FAIL_LOG_MS) },
    { name: 'POE_CORPSE_STORE', value: CORPSE_STORE },
    { name: 'POE_CORPSE_TTL_MS', value: String(CORPSE_TTL_MS) },
    { name: 'POE_CORPSE_BUDGET_PER_HOUR', value: String(CORPSE_BUDGET_PER_HOUR) },
    { name: 'POE_CORPSE_INTERVAL_MS', value: String(CORPSE_INTERVAL_MS) },
    { name: 'POE_REFERENCE_HISTORY', value: REFERENCE_HISTORY },
    { name: 'POE_DATA_REFRESH_MS', value: String(DATA_REFRESH_MS) },
    { name: 'POE_DATA_REFRESH_DIR', value: DATA_REFRESH_DIR },
    { name: 'POE_DATA_STALE_TICKS', value: String(DATA_STALE_TICKS) },
    { name: 'POE_DATA_STATUS_REASON_MAX', value: String(DATA_STATUS_REASON_MAX) },
    { name: 'POE_DATA_CHECK_NOW_COOLDOWN_MS', value: String(DATA_CHECK_NOW_COOLDOWN_MS) },
    { name: 'POE_GAP_LOG_MAX', value: String(GAP_LOG_MAX) },
    { name: 'POE_GAP_LOG_TEXT_MAX', value: String(GAP_LOG_TEXT_MAX) },
    { name: 'POE_LANG_SKEW_WARN_RATIO', value: String(LANG_SKEW_WARN_RATIO) },
    { name: 'POE_LANG_MAX_COVERAGE_LOSS_RATIO', value: String(LANG_MAX_COVERAGE_LOSS_RATIO) },
    { name: 'POE_TRADE_AUDIT_THRESHOLD', value: String(TRADE_AUDIT_THRESHOLD) },
    { name: 'POE_USER_LANG_STORE', value: userLangStore.path },
    // The update round trip (host-update.mjs). The commit this image was built
    // from is NOT repeated here — it is shown once, in the update block that
    // needs it, because one page must not give two answers to one question.
    { name: 'POE_UPDATE_DIR', value: hostUpdate.dir },
    { name: 'POE_UPDATE_HEARTBEAT_MAX_AGE_MS', value: String(hostUpdate.heartbeatMaxAgeMs) },
    // Facts rather than variables, but they are what somebody opening this view
    // wants to know and would otherwise go looking for over SSH.
    { name: 'live parsers', value: engines.liveLanguages().join(', ') },
    { name: 'snapshot languages', value: dataRefresher.activeLanguages().join(', ') },
    // store.writable, not the mkdir result: a store that met a file from a
    // newer release runs in memory and must say so here.
    { name: 'net-worth store writable', value: bool(networthStore.writable) },
    { name: 'farm sessions writable', value: bool(networthSessions.writable) },
    { name: 'net-worth guard memory writable', value: bool(networthHistory.guardStateWritable) },
    { name: 'Faustus store writable', value: bool(faustusStore.writable) },
    { name: 'corpse store writable', value: bool(corpseStore.writable) },
    { name: 'user-language store writable', value: bool(userLangStore.writable) }
  ]
  // The editable ones are shown by the settings block above with their source;
  // repeating them here would invite two different answers on one page.
  return entries.filter(e => !SETTABLE_BY_NAME.has(e.name))
}

/**
 * The provenance of every generated language set that is live: what
 * `build-info.json` says next to the data the container is really serving.
 *
 * Nothing is computed here and nothing is guessed. A set without the file is
 * reported as `present: false` rather than as zeroes — an old set generated
 * before the file existed, and a set that was never built, are both "we do not
 * know", which is a different statement from "nothing was translated".
 */
async function langBuildInfo (langs) {
  const out = []
  for (const lang of langs) {
    let info = null
    try {
      info = JSON.parse(await readFile(dataRefresher.buildInfoPath(lang), 'utf8'))
    } catch { info = null }
    if (!info || typeof info !== 'object') { out.push({ lang, present: false }); continue }
    out.push({
      lang,
      present: true,
      patch: typeof info.patch === 'string' ? info.patch : null,
      builtAt: typeof info.builtAt === 'string' ? info.builtAt : null,
      // The run's own numbers, passed through as they were written. `null` when
      // the set predates them (build-info.json without a `run` block).
      run: info.run && typeof info.run === 'object' ? info.run : null
    })
  }
  return out
}

/** 401 + a body that says which of the two cases it is. Same as /admin/gaps. */
async function adminGate (req, res) {
  const auth = await adminAuth.check(req.headers)
  if (auth.ok) return true
  res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(JSON.stringify({
      error: auth.reason === ADMIN_MISSING ? 'admin password required' : 'wrong admin password',
      reason: auth.reason
    }))
  return false
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0]

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return
  }

  // User list for the identity gate (no auth, just routing). `langs` is the
  // browser half of the language mapping (the daemon half is X-User on
  // /item): the page picks a user here and knows its language from the same
  // answer, no second round trip and no second source of truth.
  if (req.method === 'GET' && path === '/users') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ users: USERS, appName: appName(), langs: Object.fromEntries(LANG_BY_USER) })); return
  }

  // Every item name the game knows, in the language THE GAME runs in — the
  // exclusion set for the Stash-Highlight token generator, plus the table that
  // moves the wanted names into that same language (see loadItemNamesJson).
  //
  // Identity via the same ppt_user cookie as /item-name-map, because the answer
  // is now per user. `no-store` for the same two reasons that endpoint gives:
  // the body is user-specific (a shared cache must never hand player1's German
  // list to player2), and a data refresh swaps the snapshot underneath.
  if (req.method === 'GET' && path === '/item-names') {
    const user = parseCookies(req.headers.cookie).ppt_user
    if (!user || !users.has(user)) {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unknown user', users: USERS })); return
    }
    try {
      const body = await loadItemNamesJson(gameClientLang(user))
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e?.message || e) }))
    }
    return
  }

  // English reference name -> the name to SHOW, for the language THIS user
  // plays in. The mapping user -> language is the one configuration already
  // holds (POE_USER_LANGS, user-langs.mjs) and /users already answers with;
  // identity comes from the same ppt_user cookie as /events, so no language
  // ever has to be named in a URL or guessed from a header.
  //
  // Strictly the display side of the bridge: names travel English in every
  // message and stay English in every trade link, join and price lookup (see
  // loadLocalNamesByRefName). The primary language gets an EMPTY table rather
  // than one that happens to be an identity — there is nothing to translate,
  // and the page can tell the difference in one branch.
  //
  // no-store: a data-refresh swaps the snapshot underneath, and a page holding
  // last week's names would be wrong in a way nobody could see. It is one
  // request per page load of a self-hosted tool.
  if (req.method === 'GET' && path === '/item-name-map') {
    const user = parseCookies(req.headers.cookie).ppt_user
    if (!user || !users.has(user)) {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unknown user', users: USERS })); return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(itemNameMapJson(LANG_BY_USER.get(user) || PRIMARY_LANG))
    return
  }

  // Net-worth trend series for the History page chart. Deliberately a GET and
  // NOT part of the WebSocket snapshot: that payload goes out on every tab sync
  // (~30s) and would then carry the whole 24h series each time. The chart needs
  // it once per page load plus a slow poll, so it gets its own endpoint —
  // downsampled server-side (<=180 points), one positional [at, chaos, cd]
  // triple per point. Identity via the same ppt_user cookie as /events.
  if (req.method === 'GET' && path === '/networth-trend') {
    const user = parseCookies(req.headers.cookie).ppt_user
    if (!user || !users.has(user)) {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unknown user', users: USERS })); return
    }
    const rangeKey = new URL(req.url, 'http://localhost').searchParams.get('range')
    const key = Object.hasOwn(NETWORTH_RANGES, rangeKey) ? rangeKey : '24h'
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(networthHistory.series(user, NETWORTH_RANGES[key], { range: key })))
    return
  }

  // Stock movements for the history page: what came in, what went out, when.
  // Same range keys as /networth-trend so both halves of that page always
  // describe the same window.
  if (req.method === 'GET' && path === '/networth-events') {
    const user = parseCookies(req.headers.cookie).ppt_user
    if (!user || !users.has(user)) {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unknown user', users: USERS })); return
    }
    const q = new URL(req.url, 'http://localhost').searchParams
    const rangeKey = q.get('range')
    const key = Object.hasOwn(NETWORTH_RANGES, rangeKey) ? rangeKey : '24h'
    // User-set bar, in divine (rail control). Out of range / absent -> the
    // module's own default; never trust the query for anything but a number.
    const raw = Number(q.get('minDiv'))
    const minDivine = Number.isFinite(raw) && raw >= 0 && raw <= 1000 ? raw : null
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(networthHistory.events(user, NETWORTH_RANGES[key], { range: key, minDivine })))
    return
  }

  // Item detail behind ONE stretch of the trend line ("what was that jump?").
  // Fetched on demand (click/keyboard on the chart), never as part of the
  // polled series — per-point item lists would multiply that payload.
  // from/to are the timestamps of the clicked point and its drawn predecessor,
  // so the answer covers exactly the interval the click stands for even when
  // the series was downsampled and one drawn point covers several minutes.
  if (req.method === 'GET' && path === '/networth-detail') {
    const user = parseCookies(req.headers.cookie).ppt_user
    if (!user || !users.has(user)) {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unknown user', users: USERS })); return
    }
    const q = new URL(req.url, 'http://localhost').searchParams
    const detail = networthHistory.detail(user, Number(q.get('from')), Number(q.get('to')))
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(detail || { detail: false, items: [], points: 0, recorded: 0 }))
    return
  }

  // Farm and game sessions (History page). GET is the page's whole view; the
  // three POSTs are its buttons and take no body (discard takes ?kind=game for
  // a game session). Identity from the same ppt_user cookie as everything
  // else. None of them sends a request to GGG.
  if (req.method === 'GET' && path === '/networth-sessions') {
    const user = parseCookies(req.headers.cookie).ppt_user
    if (!user || !users.has(user)) {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unknown user', users: USERS })); return
    }
    // An ended session past POE_SESSION_FINALIZE_MAX_MS is closed here too:
    // observe() only runs after a new point, and none may come any more.
    // Through sessionControl, so the daemon's feed and the other pages hear
    // of what this changed, as they would from the sweep.
    await sessionControl.expire(user)
    const latest = networthHistory.latest(user)
    const view = networthSessions.view(user, latest, { ...sessionControl.viewOptions(user), listMax: SESSION_LIST_MAX })
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify({
        available: !!networthRefresher,
        persisted: networthSessions.writable,
        now: Date.now(),
        rateMinMs: SESSION_RATE_MIN_MS,
        guardHoldMs: NETWORTH_GUARD.maxHoldMs,
        autoGame: SESSION_AUTO_GAME,
        gameGapMs: SESSION_GAME_GAP_MS,
        ...view
      }))
    return
  }
  if (req.method === 'POST' && (path === '/networth-session/start' || path === '/networth-session/end' || path === '/networth-session/discard')) {
    const user = parseCookies(req.headers.cookie).ppt_user
    if (!user || !users.has(user)) {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unknown user', users: USERS })); return
    }
    let r
    if (path === '/networth-session/start') {
      // No refresher, no points: a session started now could never be measured
      // (session-control answers sync-off).
      r = await sessionControl.start(user, 'farm')
    } else if (path === '/networth-session/end') {
      r = await sessionControl.end(user, 'farm')
    } else {
      const kind = new URL(req.url, 'http://localhost').searchParams.get('kind') || 'farm'
      if (kind !== 'farm' && kind !== 'game') {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad kind' })); return
      }
      r = await sessionControl.discard(user, kind)
    }
    if (!r.ok) {
      res.writeHead(409, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: r.error, ...(r.error === 'no-baseline' ? { maxAgeMs: SESSION_BASELINE_MAX_AGE_MS } : {}) }))
      return
    }
    // sessionControl has sent `networth-session` to the room already.
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, persisted: networthSessions.writable, session: r.session }))
    return
  }

  // Net-worth credentials (settings dialog). Identity via the same ppt_user
  // cookie as /events. GET returns account name + sync state ONLY — the stored
  // POESESSID is NEVER part of any response, in no form (not masked, not as a
  // length): what is never delivered cannot leak into a screenshot or log.
  if (path === '/networth/credentials' && (req.method === 'GET' || req.method === 'POST')) {
    const user = parseCookies(req.headers.cookie).ppt_user
    if (!user || !users.has(user)) {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unknown user', users: USERS })); return
    }
    if (req.method === 'GET') {
      let accountName = null
      try {
        const creds = await loadNetworthUsers({ defaultUser: USERS[0] })
        accountName = creds[user]?.accountName ?? null
      } catch { /* unreadable file -> no account name, status says 'missing' */ }
      const status = await networthSyncStatus(user)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ user, accountName, status }))
      return
    }
    // POST: save accountName + (optionally) a new POESESSID. Empty poesessid =
    // keep the stored one. The refresher reloads the credential file every
    // round, so a renewed cookie lifts an auth pause on its own — no restart,
    // no manual unlock (refresher.mjs, tickOnce's reactivation loop).
    let body
    try { body = JSON.parse(await readBody(req)) } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'invalid JSON body' })); return
    }
    try {
      const input = validateCredentialInput(body)
      await saveNetworthUser({
        path: NETWORTH_CONFIG_PATH,
        user,
        accountName: input.accountName,
        poesessid: input.poesessid
      })
      const status = await networthSyncStatus(user)
      broadcast(user, syncStatusMsg(status)) // status line updates live on every open page
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, accountName: input.accountName, status }))
    } catch (e) {
      const status = e instanceof CredentialsError ? e.status : 500
      // e.message is value-free by contract (credentials.mjs never puts the
      // submitted or stored value into an error message).
      res.writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: e instanceof CredentialsError ? e.message : 'saving failed' }))
      if (!(e instanceof CredentialsError)) console.warn(`[networth-credentials] save failed: ${e?.message || e}`)
    }
    return
  }

  // Client language of the requesting user (settings page). NO admin password:
  // this is the user's own setting, sitting on the same page as his own
  // POESESSID, and gating it behind the operator's password would put the
  // problem back that the store exists to remove. Identity from the same
  // `ppt_user` cookie as everything else.
  if (path === '/user-lang' && (req.method === 'GET' || req.method === 'POST')) {
    const user = parseCookies(req.headers.cookie).ppt_user
    if (!user || !users.has(user)) {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unknown user', users: USERS })); return
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({
          user,
          lang: users.get(user).lang,
          available: availableLangs(),
          // false on a local run without a writable /config: the switch works,
          // it just will not survive a restart. Said out loud rather than
          // discovered later.
          persisted: userLangStore.writable
        }))
      return
    }
    let body
    try { body = JSON.parse(await readBody(req)) } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'invalid JSON body' })); return
    }
    const result = await setUserLang(user, body?.lang)
    if (!result.ok) {
      res.writeHead(result.status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: result.error, available: result.available ?? availableLangs() }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, user, lang: users.get(user).lang, available: availableLangs(), persisted: result.persisted }))
    return
  }

  // League list (poe.ninja, cached) + active league for the frontend dropdown.
  // Multi-user: `active` = league of USERS[0] (the frontend uses its own from
  // `league-state`); pure convenience for the initial dropdown highlight.
  if (req.method === 'GET' && path === '/leagues') {
    const leagues = await fetchLeagues()
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ leagues, active: users.get(USERS[0]).league })); return
  }

  // ---- Admin: what the tool could not do (design doc, section 6) -----------
  // The one endpoint behind the password partition. Checked on EVERY request
  // out of the header — there is no session to establish and none to expire, so
  // there is also no login endpoint and no logout: the page holds the value in
  // sessionStorage and the state ends with the tab (admin-auth.mjs).
  //
  // Deliberately a single endpoint rather than one per section: the page is a
  // pull view that is opened rarely, and three round trips to build one screen
  // would only spread the same data over more code.
  if (req.method === 'GET' && path === '/admin/gaps') {
    const auth = await adminAuth.check(req.headers)
    if (!auth.ok) {
      // 401 for both cases; the body says which, because "you sent nothing"
      // and "that was wrong" are different things to show under a form. This
      // is a partition, not a login — there is nothing here worth being coy
      // about.
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ error: auth.reason === ADMIN_MISSING ? 'admin password required' : 'wrong admin password', reason: auth.reason }))
      return
    }
    // English first: it is the yardstick every skew row is measured against.
    const configured = [PRIMARY_LANG, ...engines.languages().filter(l => l !== PRIMARY_LANG)]
    let skew
    try {
      skew = await langSkew.compute({ languages: configured })
    } catch (e) {
      // A diagnostic view must not go blank because a diagnostic failed.
      skew = { base: PRIMARY_LANG, basePresent: false, warn: true, languages: [], error: String(e?.message || e), generatedAt: Date.now() }
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify({
        gaps: gapLog.snapshot(),
        skew,
        // Where the localized sets that are LIVE came from (build-info.json in
        // the active snapshot). The skew block says how far apart the languages
        // are and cannot say when, or from what, the last run made them — so
        // "does this still run" was a question only the container log answered.
        langBuild: await langBuildInfo(configured.filter(l => l !== PRIMARY_LANG)),
        // The other half of "is the localized side still following": the display
        // texts. English client_strings.js is refreshed daily, the localized one
        // ships with the image, and a key upstream added is simply absent for
        // that language until the container is updated.
        clientStrings: dataRefresher.clientStringDrift(),
        languages: configured,
        liveLanguages: engines.liveLanguages(),
        limits: { maxEntriesPerKind: GAP_LOG_MAX, maxTextLength: GAP_LOG_TEXT_MAX }
      }))
    return
  }

  // ---- Admin: configuration (config-overrides.mjs) -------------------------
  // Same partition as /admin/gaps — the password out of the header, checked on
  // every request, no session. Unlike /user-lang these are the OPERATOR's
  // settings, so they are gated.
  if (req.method === 'GET' && path === '/config-view') {
    if (!(await adminGate(req, res))) return
    const overrides = await readOverrideFile(configOverrideState.path)
    // THE ONE HARD RULE OF THIS ENDPOINT: nothing secret, in no form. The
    // allow-list holds no secret key, the read-only block is built from
    // non-secret constants, and configView() filters both by name again.
    // `config-override-endpoint.test.mjs` walks the whole answer and fails on
    // any key that could name a credential.
    const view = configView({
      state: configOverrideState,
      overrides,
      runtime: runtimeConfigEntries()
    })
    // Whether the admin password is still the published default. A boolean, to
    // somebody who has just proved he knows the password anyway — it tells him
    // nothing he could not try himself, and it is the only place the notice can
    // reach an operator who never reads container logs.
    //
    // NAMED AFTER THE GATE, NOT THE PASSWORD, on purpose: this endpoint refuses
    // every field whose NAME could name a credential, and that rule has no
    // exceptions — not even for a field that holds no credential.
    view.adminGateIsDefault = await adminAuth.usingDefault()
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(view))
    return
  }

  // Set or (value: null) remove one override. The way back has to exist, or the
  // first bad value would need an SSH session to undo — which is the state this
  // whole feature is meant to end.
  if (req.method === 'POST' && path === '/config-override') {
    if (!(await adminGate(req, res))) return
    let body
    try { body = JSON.parse(await readBody(req)) } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'invalid JSON body' })); return
    }
    const name = typeof body?.key === 'string' ? body.key : (typeof body?.name === 'string' ? body.name : '')
    const result = await setOverride({
      path: configOverrideState.path,
      state: configOverrideState,
      name,
      value: body?.value ?? null
    })
    if (!result.ok) {
      res.writeHead(result.status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: result.error, settable: result.settable })); return
    }
    console.log(`[config-overrides] ${result.value === null ? `removed override ${name}` : `set override ${name}=${result.value}`} (${result.applied})`)
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(result))
    if (result.name === 'POE_SOURCE_STALE_MS') broadcastStaleBars()
    return
  }

  // Restart the process. THE DELIBERATE ALTERNATIVE TO MOUNTING THE DOCKER
  // SOCKET: handing a container the socket that controls its own host daemon,
  // for a tool that has no authentication and sits behind a plaintext password,
  // is a far bigger hole than the button is worth. Exiting cleanly reaches the
  // same result through the supervisor that is already there —
  // `restart: unless-stopped` in docker-compose.yml starts the container again
  // within a second.
  //
  // Run WITHOUT docker (`node backend/v2/server.mjs`) this button does exactly
  // what it says it does and nothing more: it ends the process, and starting it
  // again is the operator's job. That is honest — a button that silently did
  // nothing outside docker would be worse than one that does the one thing it
  // can.
  if (req.method === 'POST' && path === '/restart') {
    if (!(await adminGate(req, res))) return
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, restarting: true }))
    // After the response has left, not before.
    setTimeout(() => {
      console.log('[admin] restart requested over /restart — shutting down (the container supervisor brings it back)')
      // 1012 = Service Restart: the browsers reconnect on their own.
      for (const client of wss.clients) { try { client.close(1012, 'server restart') } catch { /* already gone */ } }
      wss.close()
      server.close(() => process.exit(0))
      // A connection that refuses to close must not turn a restart into a hang.
      setTimeout(() => process.exit(0), 2000).unref()
    }, 50)
    return
  }

  // Run the data checks now. BEHIND THE ADMIN PASSWORD, like the restart
  // button and for the same kind of reason: it starts outbound traffic on
  // demand, and an unauthenticated way to do that is a way for anyone on the
  // network to spend this installation's rate-limit budget.
  //
  // WHY IT EXISTS. Every remedy this tool offers is followed by up to 24 hours
  // of the same old failure on screen, because the next scheduled tick is the
  // only thing that can clear it. Somebody who has just corrected the pin
  // cannot tell "my fix did not work" from "my fix has not been tried yet" —
  // and the second is what they are looking at. This is how they find out.
  //
  // The guards live in the refresher (checkNow), not here: the busy flags and
  // the cooldown clock belong next to the schedule they protect. This turns
  // its answer into a status code — 409 while one is running, 429 while the
  // cooldown stands, with the wait in the body so the page can say how long.
  if (req.method === 'POST' && path === '/admin/data-check') {
    if (!(await adminGate(req, res))) return
    // POE_DATA_REFRESH_DISABLED is the switch the test suite and a local run
    // use to keep the process off the network entirely. A button that ignored
    // it would be a hole straight through that promise.
    const r = DATA_REFRESH_DISABLED
      ? { ok: false, ran: false, reason: 'disabled' }
      : await dataRefresher.checkNow()
    const code = r.ran ? 200 : (r.running ? 409 : (r.retryAfterMs ? 429 : 503))
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify({
        ok: !!r.ran,
        running: !!r.running,
        retryAfterMs: r.retryAfterMs ?? null,
        cooldownMs: dataRefresher.checkNowCooldownMs(),
        // The fresh status, so the page can redraw the answer it just caused
        // instead of waiting for the push that reports it.
        status: dataStatusMsg()
      }))
    return
  }

  // The release check's answer, for any page. OPEN, no admin gate: it carries
  // the installed version of a public tool and the latest public release, and
  // the WebSocket message with the same content goes to every connection anyway.
  // The price-source status, for the settings page's Sources block. OPEN like
  // /release-status: nothing in it is secret (reasons pass cleanReason), and
  // every connection gets the same content as a WebSocket message anyway.
  if (req.method === 'GET' && path === '/source-status') {
    const { type, ...rest } = sourceStatusMsg()
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(rest))
    return
  }

  if (req.method === 'GET' && path === '/release-status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(releaseCheck.status()))
    return
  }

  // Ask GitHub for the latest release now. BEHIND THE ADMIN PASSWORD: it spends
  // this server's GitHub quota, and the operator is the one who updates the
  // server. Unlike /admin/data-check it is NOT locked by its disabled flag: the
  // flag turns the automatic check off, and the button works either way. The
  // guards (one at a time, 60 s cooldown) live in the check itself; this turns
  // its answer into a status code — 409 while running, 429 with the wait.
  if (req.method === 'POST' && path === '/admin/release-check') {
    if (!(await adminGate(req, res))) return
    const r = await releaseCheck.checkNow()
    const code = r.ok ? 200 : (r.running ? 409 : 429)
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(r.ok
        ? { ok: true, status: r.status }
        : r.running
          ? { running: true, cooldownMs: releaseCheck.cooldownMs }
          : { retryAfterMs: r.retryAfterMs, cooldownMs: releaseCheck.cooldownMs }))
    return
  }

  // ---- Admin: update (host-update.mjs) -------------------------------------
  // A SECOND ENDPOINT RATHER THAN A FIELD ON /config-view, deliberately:
  //
  //  - /config-view answers what THIS process resolved its configuration to,
  //    built from our own constants, under one rule with no exceptions —
  //    nothing secret, in no form, proven by a test that walks the whole
  //    answer. The update status is the opposite kind of data: three files a
  //    script on the host writes, one of which holds an excerpt of a build log.
  //    Folding foreign text into the answer whose whole point is "everything in
  //    here is ours and safe" would blunt that rule for both of them.
  //  - it is POLLED. The page reads it once when the admin area opens and then
  //    every couple of seconds while it waits for the host, where /config-view
  //    is a one-shot page build.
  //
  // Same partition, same header, same check on every request.
  if (req.method === 'GET' && path === '/update-status') {
    if (!(await adminGate(req, res))) return
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(await hostUpdate.status()))
    return
  }

  // Ask the host to update. This writes a FILE and nothing else — no command
  // is built here, none is run here, and nothing the caller sends becomes part
  // of one on the other side either (host-update.mjs, and the head of
  // deploy/host-update.sh). The only thing recorded besides the time is who
  // pressed it, and only if it is one of the configured users: the identity
  // cookie is freely settable, so an unknown value is written as `unknown`
  // rather than passed through into a file on a shared volume.
  if (req.method === 'POST' && path === '/update-request') {
    if (!(await adminGate(req, res))) return
    const who = parseCookies(req.headers.cookie).ppt_user
    const result = await hostUpdate.request({ user: users.has(who) ? who : null })
    if (!result.ok) {
      res.writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: result.error })); return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, requestedAt: result.requestedAt }))
    return
  }

  // ---- The hotkey daemon's own channel (frontend/PROTOCOL.md) ---------------
  // Path and method FIRST, before the caller check: a CORS preflight (OPTIONS,
  // without X-PPT-Daemon) ends in 405 here, without any Access-Control-*
  // header, so no web page can send the custom header these routes require.
  if (path.startsWith('/daemon/')) {
    const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
    const DAEMON_ROUTES = { '/daemon/events': 'GET', '/daemon/heartbeat': 'POST', '/daemon/whisper': 'POST', '/daemon/session': 'POST', '/daemon/stash-grid': 'GET' }
    if (!Object.hasOwn(DAEMON_ROUTES, path)) { json(404, { error: 'unknown daemon route', path }); return }
    if (req.method !== DAEMON_ROUTES[path]) { json(405, { error: 'method not allowed', allow: DAEMON_ROUTES[path] }); return }
    // The rest in try/catch: this handler is async and nothing catches its
    // rejection, and on Node 24 an unhandled rejection ends the process.
    try {
      const who = daemonCaller(req.headers, users)
      if (who.status) { json(who.status, who.body); return }

      if (path === '/daemon/events') {
        const q = new URL(req.url, 'http://localhost').searchParams
        const since = q.has('since') ? Number(q.get('since')) : NaN
        const boot = q.get('boot') || ''
        const holdMs = Math.min(Math.max(0, Math.floor(Number(q.get('wait')) || 0)), DAEMON_POLL_MAX_HOLD_MS)
        const ready = daemonFeed.read(who.user, { since, boot })
        if (ready.reset || ready.gap || ready.events.length || holdMs === 0) { json(200, ready); return }
        const cancel = daemonFeed.wait(who.user, {
          since, boot, instance: who.instance, holdMs,
          onAnswer: out => { if (!res.writableEnded) json(200, out) }
        })
        if (!cancel) { json(429, { error: 'too-many-waiters', max: DAEMON_WAITERS_MAX }); return }
        res.on('close', cancel)
        return
      }

      if (path === '/daemon/whisper') {
        let wbody
        try {
          wbody = parseJsonBody(await readBodyLimited(req, DAEMON_WHISPER_BODY_MAX))
        } catch (e) {
          if (e instanceof BodyTooLarge) {
            res.setHeader('connection', 'close')
            json(413, { error: 'body too large', max: DAEMON_WHISPER_BODY_MAX })
            res.on('finish', () => req.destroy())
            return
          }
          json(400, { error: 'bad body' }); return
        }
        if (!wbody.ok) { json(400, { error: wbody.error }); return }
        const room = users.get(who.user)
        // Never throws or rejects (whisper-price.mjs); a valuation that fails
        // is 'not-compared' with reason 'error'.
        const out = await whisperHandler.handle({ user: who.user, instance: who.instance, league: room.league }, wbody.value)
        if (!res.writableEnded) json(out.status, out.body)
        return
      }

      if (path === '/daemon/stash-grid') {
        // The daemon's value key (networth/stash-grid.mjs): the stored tab
        // list, and with ?tab=<index> that tab's cells. Reads the store only.
        const q = new URL(req.url, 'http://localhost').searchParams
        const index = q.has('tab') ? tabIndexOf(q.get('tab')) : null
        if (q.has('tab') && index == null) { json(400, { error: 'bad tab index' }); return }
        if (!daemonGridRate.admit(who.user)) { json(429, { v: STASH_GRID_VERSION, error: 'too-many-grid-requests' }); return }
        const out = stashGridAnswer(networthStore, who.user, index)
        json(out.status, out.body)
        return
      }

      if (path === '/daemon/session') {
        // The daemon's session key: start, end or toggle the user's farm
        // session, exactly like the History page's buttons
        // (networth/session-control.mjs). The answer carries the session as
        // the feed's `session` event does; the feed gets that event as well.
        let sbody
        try {
          sbody = parseJsonBody(await readBodyLimited(req, DAEMON_SESSION_BODY_MAX))
        } catch (e) {
          if (e instanceof BodyTooLarge) {
            res.setHeader('connection', 'close')
            json(413, { error: 'body too large', max: DAEMON_SESSION_BODY_MAX })
            res.on('finish', () => req.destroy())
            return
          }
          json(400, { error: 'bad body' }); return
        }
        if (!sbody.ok) { json(400, { error: sbody.error }); return }
        const action = sbody.value.action
        if (action !== 'toggle' && action !== 'start' && action !== 'end') { json(400, { error: 'bad action' }); return }
        if (!daemonSessionRate.admit(who.user)) { json(429, { v: FEED_VERSION, error: 'too-many-session-requests', action }); return }
        const r = action === 'toggle'
          ? await sessionControl.toggle(who.user, { by: who.instance })
          : { ...(action === 'start'
              ? await sessionControl.start(who.user, 'farm', { by: who.instance })
              : await sessionControl.end(who.user, 'farm', { by: who.instance })), action }
        if (!r.ok) {
          json(409, { v: FEED_VERSION, error: r.error, action: r.action, ...(r.error === 'no-baseline' ? { maxAgeMs: SESSION_BASELINE_MAX_AGE_MS } : {}) })
          return
        }
        json(200, { ok: true, v: FEED_VERSION, action: r.action, session: sessionControl.feedSession(r.session) })
        return
      }

      // POST /daemon/heartbeat
      let body
      try {
        body = parseJsonBody(await readBodyLimited(req, DAEMON_BEAT_BODY_MAX))
      } catch (e) {
        if (e instanceof BodyTooLarge) {
          res.setHeader('connection', 'close')
          json(413, { error: 'body too large', max: DAEMON_BEAT_BODY_MAX })
          res.on('finish', () => req.destroy())
          return
        }
        json(400, { error: 'bad body' }); return
      }
      if (!body.ok) { json(400, { error: body.error }); return }
      const room = users.get(who.user)
      const before = daemonPresence.statusOf(who.user)
      const edgesBefore = presenceEdges
      const presence = daemonPresence.beat(who.user, who.instance, { ...body.value, version: who.version })
      const after = daemonPresence.statusOf(who.user)
      // A page update only when something the page shows changed. A presence
      // change already went out through onPresenceChange (inside beat()); here
      // only new version, features or instance count without such an edge, so
      // one change is ONE daemon-status, and a beat a minute is not a page
      // update a minute.
      if (presenceEdges === edgesBefore && daemonPresence.changedForPage(before, after)) {
        broadcast(who.user, daemonStatusMsg(room, who.user))
      }
      json(200, { ok: true, presence, v: FEED_VERSION })
      return
    } catch (e) {
      console.warn(`[daemon] ${path} failed: ${e?.message || e}`) // never a body
      if (!res.headersSent) json(500, { error: 'internal' })
      return
    }
  }

  if (req.method === 'POST' && path === '/item') {
    let text
    try { text = await readBody(req) } catch { res.writeHead(400).end('bad body'); return }
    // Daemon identity via X-User. MISSING header -> USERS[0] (keeps the existing
    // header-less trigger working for the first user). A header that is PRESENT
    // but names an unknown user is a config error (typo in the daemon's
    // PPT_USER): routing it silently to USERS[0] would pollute the first user's
    // room with foreign items AND hide the typo from the player who set it (they
    // never see a card). Reject loudly instead. The daemon does not retry;
    // poe-price-post.sh turns this 400 and its body into one line in the
    // player's daemon journal. No room is stamped (daemon-status): the POST
    // belongs to nobody.
    const hdr = req.headers['x-user']
    const hdrName = typeof hdr === 'string' ? hdr.trim() : ''
    if (hdrName && !users.has(hdrName)) {
      console.warn(`[server] POST /item: unknown X-User "${hdrName}" — valid users: ${USERS.join(', ')}. Rejecting (NOT routing to ${USERS[0]}).`)
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: `unknown user "${hdrName}"`, users: USERS }))
      return
    }
    const user = hdrName || USERS[0]
    const room = users.get(user)
    // A daemon new enough to read its feed says so (X-PPT-Daemon, its version)
    // and which of its runs it is (X-PPT-Instance); only then is the card
    // followed in the feed (daemon-feed.mjs). Without the header — every older
    // daemon, the self-test, a plain curl — `by` stays null and this route
    // answers and behaves exactly as it did before the feed existed.
    const by = req.headers['x-ppt-daemon'] ? daemonInstanceOf(req.headers['x-ppt-instance']) : null
    // The parse instance follows the user's client language. Parse-only for
    // every non-primary language: the wrapper has no trade calls on it at all
    // (engine-instances.mjs). If that language has no live parser (its data set
    // is missing from the snapshot), say so — routing the text into the English
    // parser instead would produce a plausible-looking wrong item, which is the
    // one outcome this project treats as worse than no result.
    const parser = engines.parserFor(room.lang)
    if (!parser) {
      console.warn(`[server] POST /item: no parser for language "${room.lang}" (user ${user}) — rejecting`)
      // Counts as a gap, not just as a log line: this is the state in which the
      // German user gets no card at all, and it is the one he will never
      // report. From the admin view it is indistinguishable in shape from a
      // parse failure, which is exactly right — for him it IS one.
      gapLog.recordParseFailure({ lang: room.lang, text, reason: `no parser for language "${room.lang}"` })
      noteDaemonItem(user, room, 'no-parser')
      res.writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: `no parser for language "${room.lang}"`, user, lang: room.lang }))
      return
    }
    try {
      const { item, presets } = await parser.parseItem(text, { league: room.league })
      const preset = engine.activePreset(presets)

      // Linked sockets: default-active filter (this feature's whole point) —
      // set on preset.filters BEFORE the fingerprint/enqueue below, so even the
      // initial AUTO search (which runs the preset as-parsed, no applySelection
      // call) already filters by socket_filters.filters.links.min. No sockets
      // line (currency/gems/...) -> maxLinks stays null, nothing set. Note:
      // GGG/engine supports links.min ONLY in this build (no max/colors).
      // Pull mods GGG knows but the bundled stat DB doesn't back into the
      // searchable set (active), BEFORE the fingerprint/card/enqueue below.
      await spliceResolvedUnknownMods(item, preset, room.lang)
      // What is LEFT in unknownModifiers after the catalogue path had its turn
      // is a real gap: the card shows the line read-only and the trade search
      // ignores it, so the price that comes back is the price of a different
      // item. Recorded per language, because a line that only the German set
      // misses is a generator problem and one that both miss is an upstream
      // one — and the view separates them for exactly that reason.
      for (const um of item.unknownModifiers || []) {
        if (um?.text) gapLog.recordUnknownMod({ lang: room.lang, text: um.text })
      }
      pinNearMaxGemLevel(item, preset)
      addBasePercentileFilter(item, preset) // armour: base percentile as an (unticked) filter row

      const maxLinks = maxLinkGroup(text)
      if (maxLinks != null) item.maxLinks = maxLinks // for the card + dedupe fingerprint
      // A "link" needs a group of >=2. A fully unlinked item (largest group 1)
      // has nothing to filter — links.min=1 matches everything — so no default
      // filter and no mod row for it.
      if (maxLinks != null && maxLinks >= 2) {
        preset.filters = preset.filters || {}
        preset.filters.linkedSockets = { value: maxLinks, disabled: false }
      }

      // Corrupted items price in a SEPARATE market (can't be modified further),
      // so default the corruption filter to "yes" for the initial AUTO search —
      // mirroring the card's toggle default. Searching "any" drowns a corrupted
      // rare in its cheap non-corrupted twins (observed: 1c/any vs 3-30c/yes).
      // {value:true, exact:true} is exactly what applyCorrupted sets for 'yes';
      // the user can still relax the toggle to "any" and re-Search.
      if (item.isCorrupted) {
        preset.filters = preset.filters || {}
        preset.filters.corrupted = { value: true, exact: true }
      }

      // Idempotency guard: one hotkey press must produce exactly ONE card. A
      // rapid re-POST of the SAME parsed item (the clipboard double-read that
      // hits uniques, see REPOST_DEDUP_MS) resolves to the card already on
      // screen instead of minting a second, identical one.
      const now = Date.now()
      const fp = itemFingerprint(item, preset)
      for (const [k, v] of room.recentPosts) if (now - v.ts > REPOST_DEDUP_MS) room.recentPosts.delete(k)
      const dup = room.recentPosts.get(fp)
      const dupRec = dup && room.items.get(dup.id)
      if (dupRec && dupRec.alive) {
        dup.ts = now
        // Followed again for the daemon that pressed now (re-opens a card past
        // its final state), BEFORE the re-assert below so the feed sees it;
        // `reassert`: the price-result right after the item-added is the
        // card's last price, not a new result (daemon-feed.mjs, track).
        if (by) trackFeed(user, dupRec.id, { by, stack: item.stackSize?.value ?? null, league: room.league, reassert: true })
        // The card already exists in the browser; re-assert its current state
        // (harmless if already shown) rather than adding a duplicate.
        broadcast(user, itemAddedFor(dupRec, PRICE_STATUS[dupRec.status] || 'queued'))
        if (dupRec.lastPrice) broadcast(user, dupRec.lastPrice)
        if (dupRec.ninja) broadcast(user, { type: 'ninja-ref', id: dupRec.id, ...dupRec.ninja })
        noteDaemonItem(user, room, 'card')
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: dup.id, user, deduped: true }))
        return
      }

      const id = makeId(item)
      const addedMsg = buildItemAdded(id, item, preset)
      // selection stays null until the user runs a manual search: the card is
      // showing the auto search, which IS the default selection in addedMsg.
      room.items.set(id, { id, item, presets, preset, addedMsg, alive: true, status: 'queued', lastPrice: null, selection: null })
      room.recentPosts.set(fp, { id, ts: now })
      enforceItemCap(user, room)             // cap the room -> evict oldest over MAX_ITEMS_PER_ROOM (never the just-added one)
      if (by) trackFeed(user, id, { by, stack: item.stackSize?.value ?? null, league: room.league }) // before the broadcast that is its first event
      broadcast(user, addedMsg)              // immediately queued to the browser (only that room)
      // Early answer for the game (feedEarlyAnswer). Its place is fixed:
      // enqueue() runs pump() synchronously, and on an empty queue the card is
      // 'searching' or already final right after it. The feed calls here are
      // guarded: a throw in them never turns this POST into a 400.
      if (by) earlyFeed(user, id, item, room.league)
      enqueue({ user, id, kind: 'auto' })    // trade job into the global queue
      if (by) refreshFeed(user, id)          // its queue position, now that the job is queued
      pushNinjaRef(user, id)                 // F3: send poe.ninja reference price best-effort afterwards
      noteDaemonItem(user, room, 'card')     // daemon-status: the empty page knows an item arrived
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, user }))
    } catch (e) {
      // The engine refused the text. The player's daemon journal gets one
      // line for it and the empty Price Check page says the last item could
      // not be read (`daemon-status`); the gap log is where the operator sees
      // WHICH text it was (design doc, section 6).
      gapLog.recordParseFailure({ lang: room.lang, text, reason: String(e?.message || e) })
      noteDaemonItem(user, room, 'parse-failed')
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e?.message || e) }))
    }
    return
  }

  if (req.method === 'GET') { serveStatic(path, res); return }
  res.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed')
})

// ---------------------------------------------------------------------------
// WebSocket /events — room assignment via cookie ppt_user
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/events' })

wss.on('connection', (ws, req) => {
  const cookies = parseCookies(req.headers.cookie)
  const user = cookies.ppt_user

  // No/invalid user -> need-identity, do NOT put them in a room.
  if (!user || !users.has(user)) {
    send(ws, { type: 'need-identity', users: USERS })
    return
  }

  const room = users.get(user)
  room.clients.add(ws)
  ws.on('close', () => room.clients.delete(ws))
  ws.on('error', () => room.clients.delete(ws))

  // Opening: user's league + their ratio + their reference + global
  // queue status + replay of their own items (reconnect). `lang` rides on the
  // opening league-state so the page knows, from the cookie identity alone,
  // which language it is serving (used by the UI string table).
  send(ws, { type: 'league-state', active: room.league, lang: room.lang })
  send(ws, cdMsgFor(room.league))
  send(ws, refMsgFor(room.league)) // reference rail (currency/lifeforce/beasts)
  send(ws, queueStatusMsg())
  send(ws, rateLimitMsg()) // shared trade-queue ban banner (active or inactive)
  send(ws, { type: 'networth-latest', snapshot: networthSnapshot(user) })
  send(ws, dataStatusMsg()) // M2 status line: freshness of the auto-updated data
  send(ws, releaseStatusMsg()) // is a newer release of this tool out (status line, settings page)
  send(ws, sourceStatusMsg()) // age and state of the price sources (status line, settings page)
  send(ws, daemonStatusMsg(room, user)) // Price Check empty state: last item from this user's hotkey daemon
  send(ws, { type: 'whispers', entries: whisperBook.list(user) }) // buyer whispers of this session (memory only)
  send(ws, sessionMsg(user)) // running farm session -> status line
  // Sync status for the M2 status line (async: reads the credential file).
  networthSyncStatus(user).then(st => send(ws, syncStatusMsg(st))).catch(() => {})

  // League not warm yet -> fallback has already gone out (cdMsgFor/refMsgFor),
  // now refresh async and broadcast to the room afterwards.
  if (!cdCache.has(room.league) || !refCache.has(room.league)) warmLeague(room.league)

  // A reconnect after a poe.ninja/Trade outage can find MANY priceless cards.
  // Re-queue only the NEWEST N (Map is oldest->newest, so take the tail) to
  // avoid a queue flood; the rest still replay as `queued` and can be searched
  // on demand.
  const requeueSet = new Set()
  for (const rec of room.items.values()) if (rec.alive && !hasValidPrice(rec)) requeueSet.add(rec.id)
  while (requeueSet.size > MAX_REQUEUE_ON_RECONNECT) requeueSet.delete(requeueSet.values().next().value)

  for (const rec of room.items.values()) {
    if (!rec.alive) continue
    if (hasValidPrice(rec)) {
      // Valid last price -> replay the card as done + send the price afterwards.
      // itemAddedFor carries the selection that price came from, so the picker
      // comes back the way the user left it instead of at the item defaults.
      send(ws, itemAddedFor(rec, 'done'))
      send(ws, rec.lastPrice)
    } else {
      // No valid last price (0c symptom): replay the card as queued and, for the
      // newest N only, automatically (re-)trigger the default price query -> the
      // price arrives on its own, without the user having to click search.
      const alreadyQueued = jobs.some(j => j.user === user && j.id === rec.id) ||
        (working && currentJob && currentJob.user === user && currentJob.id === rec.id)
      rec.status = 'queued'
      send(ws, itemAddedFor(rec, 'queued'))
      if (!alreadyQueued && requeueSet.has(rec.id)) enqueue({ user, id: rec.id, kind: 'auto' })
    }
    // Replay the F3 reference AFTER the card (frontend needs the item first).
    if (rec.ninja) send(ws, { type: 'ninja-ref', id: rec.id, ...rec.ninja })
  }

  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type === 'search') {
      const rec = room.items.get(msg.id)
      if (!rec || !rec.alive) return
      const corrupted = ['yes', 'no'].includes(msg.corrupted) ? msg.corrupted : 'any'
      enqueue({ user, id: msg.id, kind: 'priority', selectedMods: msg.selectedMods || [], corrupted })
    } else if (msg.type === 'set-league') {
      const lg = String(msg.league || '').trim()
      if (lg && lg !== room.league) {
        room.league = lg // changes ONLY this user's league
        broadcast(user, { type: 'league-state', active: room.league })
        // Another league is another stash; a balance across it is not a
        // farming result.
        noteSessionStashChanged(user)
        // New league -> fetch C:D again, then (exchange cache is warm by then ->
        // no double fetch) fetch reference again + broadcast only to THIS room.
        // Same switch as warmLeague: this is the other client-triggered
        // reference fetch, and one switch has to cover both or "the server
        // reaches nothing" depends on which message a browser happens to send.
        if (!REFERENCE_ON_CONNECT_DISABLED) {
          refreshCdRatio(lg)
            .then(() => { broadcast(user, cdMsgFor(lg)); return refreshReference(lg) })
            .then(() => broadcast(user, refMsgFor(lg)))
            .catch(() => {})
        }
      }
    } else if (msg.type === 'dismiss') {
      const rec = room.items.get(msg.id)
      if (rec) rec.alive = false
      room.items.delete(msg.id)
      // discard this user's waiting jobs for this item
      for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].user === user && jobs[i].id === msg.id) jobs.splice(i, 1)
      broadcastQueue()
    } else if (msg.type === 'networth-history') {
      send(ws, { type: 'networth-history', items: networthStore.history(user, 50) })
    }
  })
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const REFERENCE_DISABLED = process.env.POE_REFERENCE_DISABLED === '1'
if (REFERENCE_DISABLED) {
  console.log('[reference] disabled via POE_REFERENCE_DISABLED=1')
} else {
  await refreshCdRatio(LEAGUE)
  await refreshReference(LEAGUE) // warm up the reference rail once (exchange cache is already warm)
}

// ---------------------------------------------------------------------------
// Net-Worth background refresher: syncs ONE stash tab per interval (default
// 30s) into the per-tab store — one step per tick in TOTAL, walked round-robin
// across the configured users, NOT one per user (a second user halves each
// one's turn rate, it does not double the traffic). Quiet and continuous,
// staying far under GGG's rate limit instead of the manual full scan's ~115-request burst
// (which is what tripped the 429). Only started when creds exist + the store is
// writable + it isn't disabled. One tab sync broadcasts the refreshed snapshot
// into the user's room -> an open page nudges live. The POESESSID cookie never
// touches a log/broadcast/store.
// ---------------------------------------------------------------------------
// One valuator per league — its poe.ninja exchange map lives at most
// POE_NINJA_MAP_TTL_MS and an empty one is never kept (valuator.mjs), so the
// valuator itself needs no expiry, and re-using it across ticks keeps the
// ninja request count tiny (the whole point of valuator.mjs). At module scope
// because the refresher below and the buyer-whisper check share it (one set of
// caches), and the whisper check works with POE_NETWORTH_AUTOSYNC=0 too.
const valuatorByLeague = new Map()
const valuatorFor = league => {
  let v = valuatorByLeague.get(league)
  if (!v) { v = createValuator({ league, deps: { faustusStore, corpseStore, faustusTtlMs: FAUSTUS_TTL_MS, faustusMaxAgeMs: FAUSTUS_MAX_AGE_MS, exchangeMapTtlMs: NINJA_MAP_TTL_MS, thinTurnoverC: NETWORTH_THIN_TURNOVER_C, corpseMinListings: NETWORTH_CORPSE_MIN_LISTINGS } }); valuatorByLeague.set(league, v) }
  return v
}

// ---------------------------------------------------------------------------
// Buyer whispers (POST /daemon/whisper, frontend/PROTOCOL.md)
// ---------------------------------------------------------------------------
// The verdict on the player's own listed price: fungibles through the valuator
// above (Faustus, then poe.ninja), a unique only when exactly one poe.ninja
// line can be meant, never the trade API. Defined before server.listen, so the
// first request never meets these bindings uninitialised.
// A trade tag ('alch') or a currency name ('Orb of Alchemy') -> its chaos value
// in that league, unrounded (a 0.37 c Alchemy is not 0.4 c). null: not a
// currency this tool knows ('unknown-currency'); { chaos: null }: a known one
// without a price right now ('no-rate'). `fallback`: the Chaos:Divine rate
// behind it is the configured fallback or older than its freshness limit;
// `uncertain`: the valuator's marker on the currency's own price. Either
// means no verdict.
async function whisperChaosPerTag (tag, league) {
  const ref = itemsIndex.byTag.get(tag) ?? (itemsIndex.byName.has(tag) ? tag : null)
  if (!ref) return null
  if (ref === 'Chaos Orb') return { chaos: 1, fallback: false, uncertain: null }
  if (ref === 'Divine Orb') {
    const r = divineRate(league)
    return r.chaos == null ? { chaos: null } : { chaos: r.chaos, fallback: r.fallback, uncertain: null }
  }
  const desc = descriptorForName(ref, itemsIndex)
  if (!desc) return null
  const v = await valuatorFor(league).valueEach(desc)
  return v && typeof v.each === 'number' && v.each > 0
    ? { chaos: v.each, fallback: false, uncertain: v.uncertain ?? null }
    : { chaos: null }
}
const whisperPricer = createWhisperPricer({
  valuatorFor,
  resolveContext: lang => {
    const w = whisperNames.get(lang)
    if (!w) return null
    return {
      byName: itemsIndex.byName,
      uniques: w.uniques,
      localToRef: w.localToRef ? (n => w.localToRef.get(n) || null) : null,
      describe: ref => descriptorForName(ref, itemsIndex),
      categoryOf: base => itemsIndex.categoryOfBase(base)
    }
  },
  // A whisper in a language without name data (French, Russian, Spanish,
  // Portuguese today) borrows a name one of these knows exactly.
  fallbackLangs: () => WHISPER_LANGS.filter(l => whisperNames.has(l)),
  chaosPerTag: whisperChaosPerTag,
  lowRatio: WHISPER_LOW_RATIO,
  highRatio: WHISPER_HIGH_RATIO,
  pricingOff: PRICE_CHECK_DISABLED,
  // The stack size the last sync saw at a whisper's tab and cell, for the
  // second reading of a single whisper for a stackable (stack-unknown). Reads
  // the per-tab store in memory; never a stash request.
  stackAt: createStackLookup(networthStore)
})
const whisperHandler = createWhisperHandler({
  pricer: whisperPricer,
  book: whisperBook,
  rate: whisperRate,
  deadlineMs: envNum('POE_WHISPER_PRICE_DEADLINE_MS'),
  broadcast,
  pushWhisper: guarded((u, e, o) => daemonFeed.pushWhisper(u, e, o), console.warn),
  onUnparsed: u => { const room = users.get(u); if (room) broadcast(u, daemonStatusMsg(room, u)) },
  // '[whisper] valuation failed' / 'delivery failed' / 'handler failed', at
  // most one line a minute for each, with a count of the ones left out; never
  // a whisper's text, item or label.
  onError: createWhisperErrorLog(),
  log: line => console.log(line),
  // Is a whisper's tab a quad tab, by the tab type the last sync stored (the
  // daemon's stash cell frame, entry field `quad`). Reads the per-tab store in
  // memory; never a stash request.
  quadOf: createQuadLookup(networthStore)
})

let networthRefresher = null
const networthBootCreds = await loadNetworthUsers({ defaultUser: USERS[0] }).catch(() => ({}))
// Started even with ZERO configured users: the refresher reloads the
// credential file every round, so credentials added later through the settings
// UI start syncing on the next tick — without this, a server booted before the
// first credentials were saved would need a restart (a tick with no users is a
// no-op, so an idle refresher costs nothing).
if (NETWORTH_AUTOSYNC && networthStoreWritable) {
  // valuatorFor (above) is shared with the buyer-whisper check. A fresh stash client per tick is
  // fine — createStashClient does no network at construction, and the
  // credentials and the league may change between ticks — but "the 30s
  // interval IS the pacing" does not hold for a folder tab, whose 1+N requests
  // land in windows 30 minutes long. So the pacing state does not live in the
  // client: networth/stash-pacer.mjs holds it for the whole process, which is
  // also the only scope an `Ip` budget can honestly be held at (it is shared
  // across users). Nothing has to be passed in here for that — a shared default
  // cannot be forgotten at a call site.
  networthRefresher = createNetworthRefresher({
    store: networthStore,
    // Reloaded every round -> cookie rotation (and newly-added users) without a restart.
    loadUsers: () => loadNetworthUsers({ defaultUser: USERS[0] }),
    makeClient: (user, cred) => {
      const league = users.get(user)?.league || LEAGUE
      const client = createStashClient({ accountName: cred.accountName, poesessid: cred.poesessid, league })
      return { client, league }
    },
    valueTab: ({ items, tab, cdRatio, league, accountName }) => valueTab({
      items, tab, cdRatio, league, accountName,
      valuator: valuatorFor(league),
      normalize: ggg => normalizeItem(ggg, itemsIndex)
    }),
    cdRatioFor: (user, league) => cdMsgFor(league).chaosPerDivine,
    // Broadcast the refreshed snapshot so an open page pulls the new tab in live.
    onTabSynced: (user, coverage) => {
      broadcast(user, { type: 'networth-result', snapshot: networthSnapshot(user) })
      // Throttled to <=1 point/min inside, and skipped entirely while the store
      // has not been past every live tab (coverage.complete === false).
      recordNetworthHistory(user, coverage)
    },
    // Pause/cooldown entered or lifted -> push the new state to the status line.
    onStatus: user => broadcastSyncStatus(user),
    // B14: a real trade-API ban holds this path as well. Passed as the live
    // question rather than as a value — the refresher asks it every tick.
    isPaused: tradeBanPause,
    intervalMs: NETWORTH_SYNC_INTERVAL_MS,
    listTtlMs: NETWORTH_LIST_TTL_MS,
    cooldownMs: NETWORTH_COOLDOWN_MS,
    slowStepMs: NETWORTH_SLOW_STEP_MS,
    // Sync follows the game: whose tab a tick reads, from the daemons'
    // heartbeats; 'unknown' (no or a silent daemon) is today's round-robin.
    presenceOf: user => daemonPresence.syncPresenceOf(user, holdAfterGame),
    idleEvery: NETWORTH_IDLE_EVERY,
    idleRest: NETWORTH_IDLE_REST
  })
  networthRefresher.start()
  console.log('[networth] background auto-sync on (interval=%dms listTtl=%dms cooldown=%dms slowStep=%dms idleEvery=%d idleRest=%s users=%d)',
    NETWORTH_SYNC_INTERVAL_MS, NETWORTH_LIST_TTL_MS, NETWORTH_COOLDOWN_MS, NETWORTH_SLOW_STEP_MS,
    NETWORTH_IDLE_EVERY, NETWORTH_IDLE_REST ? 'on' : 'off', Object.keys(networthBootCreds).length)
}

// One-shot probe for folder tabs (POE_STASH_PROBE=<tabIndex>): runs exactly
// once at startup, only for the FIRST configured net-worth user, and logs
// response keys + item count per addressing variant. Purely a diagnostic tool
// — not set in normal operation.
if (process.env.POE_STASH_PROBE) {
  const probeIndex = Number(process.env.POE_STASH_PROBE)
  const [probeUser, probeCred] = Object.entries(networthBootCreds)[0] || []
  if (!Number.isInteger(probeIndex) || !probeCred) {
    console.warn('[stash-probe] skipped (POE_STASH_PROBE must be a tab index, and a net-worth user must be configured)')
  } else {
    const probeLeague = users.get(probeUser)?.league || LEAGUE
    createStashClient({ accountName: probeCred.accountName, poesessid: probeCred.poesessid, league: probeLeague })
      .probeTab(probeIndex)
      .catch(e => console.warn(`[stash-probe] failed: ${e?.message || e}`))
  }
}

// The distinct set of leagues to refresh each tick: every league with CONNECTED
// clients, PLUS the configured league unconditionally. The headless background
// pricers (corpse pricer, Faustus divine bridge) read cdMsgFor(LEAGUE)
// passively — with no tab open, a clients-only set would never refresh it,
// freezing the divine normalisation on the boot value (bad at league start,
// when divine moves fast). So the configured league is always in the set,
// independent of connected clients.
function leaguesToRefresh () {
  const set = new Set()
  for (const room of users.values()) if (room.clients.size) set.add(room.league)
  set.add(LEAGUE)
  return set
}

// Never poll faster than 15min (poe.ninja usage policy); the refreshes cache
// additionally. Sequentially cd+ref per league (shared exchange fetch only
// ONCE), then broadcast to that league's connected users (headless leagues have
// none — the refresh still updates cdMsgFor for the background pricers).
setInterval(() => {
  for (const lg of leaguesToRefresh()) {
    refreshCdRatio(lg)
      .then(() => { broadcastLeague(lg, cdMsgFor(lg)); return refreshReference(lg) })
      .then(() => broadcastLeague(lg, refMsgFor(lg)))
      .catch(() => {})
  }
}, Math.max(CD_REFRESH_MS, NINJA_MIN_MS)).unref()

// Top-level await until 'listening' -> an `await import('./server.mjs')` (tests)
// gets back a module whose `server` already has a real port
// (server.address().port), even with PORT=0 (random port).
await new Promise((resolve) => {
  server.listen(PORT, () => {
    const actualPort = server.address().port
    console.log(`[server] http + ws on http://localhost:${actualPort}  (ws: /events)`)
    console.log(`[server] serving ${FE_DIR}`)
    console.log(`[server] users=[${USERS.join(', ')}]  league=${LEAGUE}  maxListings=${maxListings()}  cd=${cdMsgFor(LEAGUE).chaosPerDivine} (${cdMsgFor(LEAGUE).trendHint})`)
    resolve()
  })
})

// The closing half of the override boot quarantine: from here the start counts
// as successful, so the next boot must NOT reject /config/overrides.json. Put
// exactly here — after `listening`, before anything else can throw — because
// "the server came up" is the only definition of success that stops a restart
// loop (config-overrides.mjs).
clearApplyingMarker(configOverrideState)
// From here a source-status change may be broadcast (see sourceStatusReady).
sourceStatusReady = true

// Restore a still-running ban gate BEFORE anything can enqueue a search, so a
// restart mid-ban resumes paused instead of probing GGG (see RATE_LIMIT_STATE).
await restoreRateLimit()

// New APT snapshot: hot-reload the engine data (initData re-assigns the
// lookup closures inside the bundle — no process restart), then rebuild
// the two server-side derivatives of items.ndjson. A parse that is
// in-flight during the few ms of the swap may see mixed old/new lookups —
// harmless (worst case one odd result), and the alternative would be
// stalling the whole item pipeline for every update.
//
// The refresher's onAptData handler (dataRefresher.start below). Named and
// exported rather than written inline, so that user-lang-park.test.mjs can run
// the real handler with stubbed engines and pin that a parked language choice
// comes back here.
async function applyAptData ({ publicDataUrl, itemsNdjsonPath, languages }) {
  // A snapshot that does not carry every LIVE language would silently pull
  // the data root out from under one of the instances. Say so by name
  // instead of letting it surface as an ENOENT inside the data loader; the
  // throw is a veto, so the refresher discards the snapshot and the
  // previous one stays live for both languages.
  const lost = engines.liveLanguages().filter(l => !(languages || [PRIMARY_LANG]).includes(l))
  if (lost.length) {
    throw new Error(`snapshot carries no data/${lost.join(', data/')} — a live parser would lose its data root`)
  }
  try {
    // Serial reload of every instance; on failure engine-instances puts
    // ALL of them back on the previous (validated, still on disk) snapshot
    // and rethrows, so the refresher discards the new one.
    await engines.reload({ publicDataDir: publicDataUrl })
  } catch (e) {
    console.warn(`[data-refresh] engine reload failed (${e?.message || e}) — rolled back to the previous data`)
    throw e
  }
  // A parser that was down may be live now; a user whose stored choice
  // waited for it is put back on it. Before the rebuilds below, which
  // build their per-language tables from LANG_BY_USER.
  reviveParkedLangs()
  itemsIndex = await loadItemsIndex(itemsNdjsonPath)
  // Same snapshot, same rebuild: the localized name bridge must never
  // describe a data set the engine has already left behind, or a corpse
  // name would be resolved against the wrong league's items.
  await reloadRefNamesByLang()
  // And the names a buyer whisper is read with (every template language).
  await reloadWhisperNames()
  // Same snapshot again, the other direction: the names the browser prints
  // must come from the data set the engine now parses with, or the page
  // shows last week's wording for this week's items.
  await reloadLocalNamesByLang()
  // Same reason, one level further: a pair table from the previous snapshot
  // would translate mod lines for a data set the engine has already left.
  modTextBridge.reload()
  // Same reason once more, for the stash-search name universe: every
  // language's body is lazily rebuilt from the new snapshot on next use.
  itemNamesJsonByLang.clear()
}

// ---- Data auto-update: start the background schedule ------------------------
// The handlers make an adopted update effective in the RUNNING process; how
// each source is validated/persisted lives in data-refresher.mjs.
if (DATA_REFRESH_DISABLED) {
  console.log('[data-refresh] disabled via POE_DATA_REFRESH_DISABLED=1')
} else {
  dataRefresher.start({
    onAptData: applyAptData,
    // New base-names map: swap it into the (single) Faustus pricer — effective
    // with the next hourly Faustus tick.
    async onBaseNames ({ path }) {
      if (faustusPricer) faustusPricer.setBaseNames(await loadBaseNames(path))
    },
    // Every check (updated, unchanged or failed) refreshes the freshness facts
    // in every open page — no reload needed to see a source recover.
    onCheck () { broadcastAll(dataStatusMsg()) }
  })
}

// ---- Release check: start the daily schedule -------------------------------
// Always started; the disabled flag is read at each tick (see above), so turning
// the setting back on needs no restart. Tests keep it off via QUIET_ENV.
releaseCheck.start()

// ---------------------------------------------------------------------------
// Test/integration exports. Minimal refactor for task 8 (server integration
// lets tests drive the three-tier queue
// and the lookup store directly, instead of only reaching everything via real
// HTTP/WS requests. The existing price path remains untouched by this —
// these exports are purely additive (no existing function changed).
// ---------------------------------------------------------------------------
export { gapLog, langSkew, adminAuth, ADMIN_PASSWORD_PATH, modTextBridge }
export { userLangStore, setUserLang, applyAptData, availableLangs, configOverrideState, runtimeConfigEntries }
export { sourceStatusMsg, sourceHealth, refreshCdRatio, cdMsgFor, syncStatusMsg }
export { server, enqueue, enqueueBackground, pump, jobs, bgJobs, users, dataRefresher, engines, LANG_BY_USER, LEAGUE, leaguesToRefresh, networthStore, networthHistory, networthSessions, networthRefresher, referenceHistory, refreshReference, faustusStore, faustusRefresher, corpseStore, corpsePricer, corpseTradeClient, rateLimitMsg, noteRateLimit, clearRateLimit, rateLimitSeconds, tradeBanPause, maxLinkGroup, LINKS_MOD_TEXT, splitRollRanges, spliceResolvedUnknownMods, modsOf, buildItemAdded, applySelection, selectionOf, itemAddedFor, toNinjaPriceResult, toPriceResult, withExchangeMain, faustusChaosFor, faustusRangeFor, faustusStaleHoursFor, ninjaBulkPrice, ninjaRefFor, priceKeyOf, collectCorpseNames, englishCorpseName, loadLocalNamesByRefName, localNamesByLang, itemNameMapJson }
