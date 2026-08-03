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
 *  - daemon: header `X-User: <user>` on POST /item (missing/unknown -> USERS[0]).
 * `queue-status` is global (shared queue), everything else is routed per room.
 * poe.ninja caches are keyed by league (two users on the same league share them).
 *
 * Deps: only `ws` + the engine.
 * Start:  node backend/v2/server.mjs   (PORT default 8788)
 */
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
  round1, normSpark,
  fetchCurrencyExchange, fetchExchangeOverview, fetchItemOverview, ninjaTypeFor
} from './ninja.mjs'
// Net-Worth tracker: stash scan -> valuation -> snapshot (Task 7 wiring).
import { loadNetworthUsers, NETWORTH_CONFIG_DEFAULT } from './networth/config.mjs'
import { validateCredentialInput, saveNetworthUser, CredentialsError } from './networth/credentials.mjs'
import { createStashClient } from './networth/stash-client.mjs'
import { loadItemsIndex, normalizeItem } from './networth/normalize.mjs'
import { createValuator } from './networth/valuator.mjs'
import { aggregate } from './networth/aggregate.mjs'
import { createNetworthStore } from './networth/store.mjs'
import { valueTab } from './networth/scan.mjs'
import { createNetworthRefresher } from './networth/refresher.mjs'
import { createNetworthHistory, RANGES as NETWORTH_RANGES } from './networth/history.mjs'
import { createReferenceHistory } from './reference-history.mjs'
// Faustus (GGG Currency Exchange, public CDN) — Task 3: store + hourly
// refresher for the derived name->chaos map (Task 2's faustus.mjs is the
// fetch/derivation engine; Task 4 wires valuator.mjs to read this store).
import { createFaustusPricer } from './networth/faustus.mjs'
import { createFaustusStore } from './networth/faustus-store.mjs'
import { createFaustusRefresher } from './networth/faustus-refresher.mjs'
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
import { createDataRefresher, DEFAULT_INTERVAL_MS as DATA_REFRESH_DEFAULT_MS, DEFAULT_STALE_TICKS as DATA_REFRESH_STALE_TICKS } from './data-refresher.mjs'
import { loadBaseNames } from './networth/base-names.mjs'

// ---- Observability (install FIRST, before anything can log) ----------------
// Timestamps on every console line: without them a log gives the order of
// events but not the time, and a rate-limit banner cannot be matched against
// the requests that caused it. POE_LOG_TIMESTAMPS=0 restores the bare console.
if (process.env.POE_LOG_TIMESTAMPS !== '0') installLogTimestamps()
// Trade rate-limit bookkeeping. Reads the headers of responses that happen
// anyway (never sends anything itself) and logs ONE line when a window gets
// tight, plus one with per-consumer counts on a 429. POE_TRADE_AUDIT=0 off.
const TRADE_AUDIT_THRESHOLD = Number(process.env.POE_TRADE_AUDIT_THRESHOLD) || 0.8
const tradeAudit = createTradeAudit({ threshold: TRADE_AUDIT_THRESHOLD })
if (process.env.POE_TRADE_AUDIT !== '0') installTradeAudit({ audit: tradeAudit })

// ---- Config (all from env, sensible defaults) ------------------------------
// `Number(process.env.PORT) || 8788` would wrongly fall back to 8788 for
// PORT=0 (random port, used by tests so they never bind the real 8788) since
// 0 is falsy -> explicitly check "is env set?" instead.
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 8788
const LEAGUE = process.env.POE_LEAGUE || 'Standard'
// Fixed user list (no login). Identity is only used for routing.
const USERS = (process.env.POE_USERS || 'player1,player2').split(',').map(s => s.trim()).filter(Boolean)
// Configurable brand name (landing page only — the feature pages keep their
// own functional names, "Net Worth"/"History"). Neutral default; the
// operator sets their own via env.
const APP_NAME = process.env.POE_APP_NAME || 'Trade Console'
// PoE trade fetch (/api/trade/fetch/{ids}) allows MAX. 10 ids per request —
// more -> the API responds "Invalid query". searchPreset fetches in ONE call,
// so cap it hard at <=10 here (env can go lower, but never higher).
const MAX_LISTINGS = Math.min(10, Number(process.env.POE_MAX_LISTINGS) || 10)
const CD_FALLBACK = Number(process.env.POE_CD_RATIO) || 215 // used when poe.ninja is unreachable
const CD_REFRESH_MS = Number(process.env.POE_CD_REFRESH_MS) || 15 * 60 * 1000
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36'

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
const DATA_REFRESH_MS = Number(process.env.POE_DATA_REFRESH_MS) || DATA_REFRESH_DEFAULT_MS
const DATA_REFRESH_DISABLED = process.env.POE_DATA_REFRESH_DISABLED === '1'
const DATA_REFRESH_DIR = process.env.POE_DATA_REFRESH_DIR || '/config/data-refresh'
// How many missed ticks make a source "stale" in the UI status line. Relative
// to the interval, not an absolute duration (POE_DATA_STALE_TICKS overrides).
// (positiveEnvInt is defined further down, after the queue section — same clamp)
const DATA_STALE_TICKS = Math.max(1, Number(process.env.POE_DATA_STALE_TICKS) || DATA_REFRESH_STALE_TICKS)
const dataRefresher = createDataRefresher({
  dir: DATA_REFRESH_DIR,
  intervalMs: DATA_REFRESH_MS,
  staleTicks: DATA_STALE_TICKS,
  vendored: {
    publicDir: fileURLToPath(new URL('../../renderer/public/', import.meta.url)),
    baseNamesPath: fileURLToPath(new URL('./networth/base-names.json', import.meta.url))
  }
})
await dataRefresher.init()

// ---- Load engine (import the bundle dynamically, like the CLI) ------------
const engine = await import(BUNDLE)
// warm up the data DB once — from the refresher's active snapshot (undefined
// -> engine default, the baked-in renderer/public)
await engine.ready({ lang: 'en', publicDataDir: dataRefresher.publicDataUrl() })

// Consumer-tagged entry points into the engine's trade calls. These are the
// ONLY places this app reaches the Trade API from, so tagging them here (rather
// than threading a parameter through every caller) attributes every request:
// the tag rides an AsyncLocalStorage context that the engine's own fetch
// inherits. Behaviour is otherwise identical — same function, same arguments,
// same shared RateLimiter, no extra call.
const searchPresetAs = (...args) => withConsumer(CONSUMER.PRICE_CHECK, () => engine.searchPreset(...args))
const bulkPriceItemAs = (...args) => withConsumer(CONSUMER.PRICE_CHECK, () => engine.bulkPriceItem(...args))
const searchRawAs = (consumer) => (...args) => withConsumer(consumer, () => engine.searchRaw(...args))

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
const NETWORTH_SYNC_INTERVAL_MS = Number(process.env.POE_NETWORTH_SYNC_INTERVAL_MS) || 30 * 1000
const NETWORTH_LIST_TTL_MS = Number(process.env.POE_NETWORTH_LIST_TTL_MS) || 15 * 60 * 1000
const NETWORTH_COOLDOWN_MS = Number(process.env.POE_NETWORTH_COOLDOWN_MS) || 10 * 60 * 1000
const networthStore = createNetworthStore(NETWORTH_STORE)
let networthStoreWritable = true
try {
  await mkdir(dirname(NETWORTH_STORE), { recursive: true })
} catch (e) {
  networthStoreWritable = false
  networthStore.writable = false
  console.warn(`[networth] Store folder ${dirname(NETWORTH_STORE)} could not be created (${e?.code || e}) — snapshots will not be persisted.`)
}
await networthStore.load()

// ---- Net-worth history (header trend chart) --------------------------------
// Append-only NDJSON next to the store, at most ONE point per user per minute,
// 15-day retention. Deliberately NOT part of networth-store.json: that file is
// rewritten in full on every tab sync (~30s), the series is not. See
// networth/history.mjs for the line shape and the privacy note.
const NETWORTH_HISTORY = process.env.POE_NETWORTH_HISTORY ||
  join(dirname(NETWORTH_STORE), 'networth-history.ndjson')
const networthHistory = createNetworthHistory(NETWORTH_HISTORY)
networthHistory.writable = networthStoreWritable
await networthHistory.load() // tolerates missing/empty/corrupt -> empty series

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
const FAUSTUS_STORE = process.env.POE_FAUSTUS_STORE || '/config/faustus-store.json'
const FAUSTUS_DISABLED = process.env.POE_FAUSTUS_DISABLED === '1'
const FAUSTUS_UNION_HOURS = Number(process.env.POE_FAUSTUS_UNION_HOURS) || undefined // undefined -> faustus.mjs default (8)
const FAUSTUS_REFRESH_MS = Number(process.env.POE_FAUSTUS_REFRESH_MS) || 60 * 60 * 1000
// Max staleness before the valuator treats the Faustus map as absent (F1). The
// store shares one updatedAt across the whole map; generous default (48h) covers
// the multi-hour union + hourly refresh, but bounds silently-frozen prices if
// the CDN feed breaks -> valuation falls through to poe.ninja.
const FAUSTUS_TTL_MS = Number(process.env.POE_FAUSTUS_TTL_MS) || 48 * 60 * 60 * 1000
const faustusStore = createFaustusStore(FAUSTUS_STORE)
let faustusStoreWritable = true
try {
  await mkdir(dirname(FAUSTUS_STORE), { recursive: true })
} catch (e) {
  faustusStoreWritable = false
  faustusStore.writable = false
  console.warn(`[faustus] Store folder ${dirname(FAUSTUS_STORE)} could not be created (${e?.code || e}) — Faustus persistence off.`)
}
await faustusStore.load() // tolerates a missing/corrupt file (-> empty store, valuation falls through to ninja until the first refresh)

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
    intervalMs: FAUSTUS_REFRESH_MS
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
const CORPSE_TTL_MS = Number(process.env.POE_CORPSE_TTL_MS) || 6 * 60 * 60 * 1000
const CORPSE_BUDGET_PER_HOUR = Number(process.env.POE_CORPSE_BUDGET_PER_HOUR) || 25
const CORPSE_INTERVAL_MS = Number(process.env.POE_CORPSE_INTERVAL_MS) || 2 * 60 * 1000
const corpseStore = createCorpseStore(CORPSE_STORE, { ttlMs: CORPSE_TTL_MS })
let corpseStoreWritable = true
try {
  await mkdir(dirname(CORPSE_STORE), { recursive: true })
} catch (e) {
  corpseStoreWritable = false
  corpseStore.writable = false
  console.warn(`[corpse] Store folder ${dirname(CORPSE_STORE)} could not be created (${e?.code || e}) — corpse persistence off.`)
}
await corpseStore.load() // tolerates missing/corrupt -> empty store (corpses honestly unpriced until first fill)

// Corpse base names actually held across ALL users' latest snapshots (union of
// stored tabs). Priced corpses live in tab.items (kind 'corpse'), unpriced ones
// in tab.unpriced — collect from both, dedupe. The pricer skips 'Imperfect '.
function collectCorpseNames () {
  const names = new Set()
  for (const user of USERS) {
    for (const tab of networthStore.tabList(user)) {
      for (const row of (tab.items || [])) if (row?.kind === 'corpse' && row.name) names.add(row.name)
      for (const u of (tab.unpriced || [])) if (u?.kind === 'corpse' && u.name) names.add(u.name)
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
} else if (CORPSE_DISABLED) {
  console.log('[corpse] disabled via POE_CORPSE_DISABLED=1')
}

// `let`, not const: rebuilt from the new items.ndjson when the data refresher
// adopts a fresh APT snapshot (normalizeItem reads it per call).
let itemsIndex = await loadItemsIndex(dataRefresher.itemsNdjsonPath())

// Snapshot aggregated from whatever the store currently holds for a user
// (union of all persisted tabs), or null when the store has nothing yet. Uses
// the meta frozen at scan time (league + C:D) so a replay matches the scan.
function networthSnapshot (user) {
  const tabs = networthStore.tabList(user)
  if (!tabs.length) return null
  const meta = networthStore.getMeta(user) || {}
  const league = meta.league || users.get(user)?.league || LEAGUE
  const cdRatio = meta.cdRatio ?? cdMsgFor(league).chaosPerDivine
  return aggregate({ tabs, cdRatio, league, accountName: meta.accountName ?? null })
}

// One history point from the CURRENT snapshot (the refresher calls this after
// every synced tab; history.append() throttles it down to one point/minute).
// The C:D ratio of THIS moment travels with the point so an old value never
// gets re-derived with today's ratio. Fire-and-forget: a failing history write
// must never disturb the refresher.
function recordNetworthHistory (user) {
  const snap = networthSnapshot(user)
  if (!snap) return
  // items travel along so the history can diff them against the previous point
  // (quantity vs price movers behind a jump). Only name/qty/chaos are read from
  // them; nothing account-identifying goes near the file.
  networthHistory.append(user, {
    totalChaos: snap.totalChaos, cdRatio: snap.cdRatio, items: snap.items || []
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
function syncStatusMsg (status) {
  const msg = { type: 'networth-sync-status', state: status.state }
  if (status.until) msg.until = status.until
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
      lastOutcome: s.lastOutcome
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
// parsed once and cached for the process lifetime. Names only — the frontend
// needs nothing else from these records, and the icons/namespaces would blow the
// payload up tenfold. No category filter either: any item class can share a
// stash tab, and the list is small enough that guessing categories would only
// add a way to be wrong.
// `let`, both of them: retargeted/reset when the data refresher adopts a new
// APT snapshot, so the stash-search name list follows the active data.
let itemNamesPath = dataRefresher.itemsNdjsonPath()
let itemNamesJson = null

async function loadItemNamesJson () {
  if (itemNamesJson) return itemNamesJson
  const raw = await readFile(itemNamesPath, 'utf8')
  const set = new Set()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    // name = display name, refName = the English reference name; for uniques
    // and a few bases they differ, and BOTH can show up in a stash search.
    if (typeof e.name === 'string' && e.name) set.add(e.name)
    if (typeof e.refName === 'string' && e.refName) set.add(e.refName)
  }
  itemNamesJson = JSON.stringify({ names: [...set].sort() })
  return itemNamesJson
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
// Parse a positive-integer env cap with a floor of 1: a negative/0 override
// would make the `size > cap` while-loops (eviction, reconnect-trim) below
// permanently true and spin forever. `Number(x) || fallback` also catches
// unset/NaN/0; Math.max(1, …) additionally clamps negatives up to 1.
const positiveEnvInt = (raw, fallback) => Math.max(1, Number(raw) || fallback)
const MAX_ITEMS_PER_ROOM = positiveEnvInt(process.env.POE_MAX_ITEMS_PER_ROOM, 50)
// Cap on how many priceless cards a single WS reconnect re-enqueues. After a
// poe.ninja/Trade outage a room can hold many cards without a valid price; a
// reconnect used to re-queue ALL of them at once -> a queue flood the moment
// the service came back. Re-queue only the NEWEST N; the rest still replay as
// `queued` and the user can trigger a search on demand.
const MAX_REQUEUE_ON_RECONNECT = positiveEnvInt(process.env.POE_MAX_REQUEUE_ON_RECONNECT, 10)
const users = new Map() // user -> { clients:Set<ws>, items:Map, league:string, recentPosts:Map }
for (const u of USERS) users.set(u, { clients: new Set(), items: new Map(), league: LEAGUE, recentPosts: new Map() })

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
// item's own roll, matching how every other mod defaults ("rolls >= mine"). No
// bounds are known for an unvendored stat, so the card shows a checkbox without
// a slider (modsOf only emits valueRange when bounds exist) — honest: we know
// the stat, not its roll range.
async function spliceResolvedUnknownMods (item, preset) {
  const unknown = item.unknownModifiers
  if (!Array.isArray(unknown) || unknown.length === 0) return
  const keep = []
  for (const um of unknown) {
    const text = um?.text
    if (!text) continue
    let tradeId = null
    try {
      tradeId = await tradeStatIndex.resolve(text, um.type)
    } catch { tradeId = null } // catalogue trouble must never break a price-check
    if (!tradeId) { keep.push(um); continue }
    const num = /[+-]?\d+(?:\.\d+)?/.exec(text)
    const value = num ? Number(num[0]) : undefined
    preset.stats.push({
      text: normalizeStatTextForCard(text),
      tag: um.type || 'implicit',
      tradeId: [tradeId],
      disabled: false,
      roll: { value, min: value, max: undefined },
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
    // currency and dropping every other one — what this used to do — collapses
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
function withExchangeMain (result, chaos, cdRatio, range) {
  if (typeof chaos !== 'number' || !(chaos > 0) || !result) return result
  const ratio = Number(cdRatio) > 0 ? Number(cdRatio) : 0
  const toChaos = v => (result.currency === 'chaos'
    ? v
    : (result.currency === 'divine' && ratio ? round1(v * ratio) : null))
  // No priced listing at all -> nothing to ask about, so no second line.
  const ask = (result.priceLow > 0 || result.priceHigh > 0)
    ? {
        low: result.priceLow,
        high: result.priceHigh,
        currency: result.currency,
        chaosLow: toChaos(result.priceLow),
        chaosHigh: toChaos(result.priceHigh)
      }
    : null
  // round1 would flatten a genuinely sub-chaos fungible (lifeforce & co, whose
  // exchange rate is ~0.018c a piece) to a flat "0" — keep three decimals below
  // 1c so the headline stays an honest number.
  const c = chaos < 1 ? Math.round(chaos * 1000) / 1000 : round1(chaos)
  const rc = v => (v < 1 ? Math.round(v * 1000) / 1000 : round1(v)) // same rounding as the headline
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
const broadcastQueue = () => broadcastAll(queueStatusMsg())

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
const RATE_LIMIT_BANNER_MIN_SEC = positiveEnvInt(process.env.POE_RATE_LIMIT_BANNER_MIN_SEC, 60)
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
      // stale/dead offers (Divination Cards being the poster child — see
      // FEATURES-report.md) -> use poe.ninja's aggregated market value
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
      // priced by the exchange too. Unknown to Faustus (null) -> everything
      // below behaves exactly as before.
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
              maxListings: MAX_LISTINGS,
              cdRatio: cdMsgFor(room.league).chaosPerDivine
            })
          : await searchPresetAs(rec.preset, { league: room.league, maxListings: MAX_LISTINGS })

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
            exchangePrice = { chaos: round1(faustusChaos), count: null, url: null }
          } else {
            price = await searchPresetAs(rec.preset, { league: room.league, maxListings: MAX_LISTINGS })
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
                source: 'exchange', label: 'Currency Exchange', note: 'market rate'
              })
            // Faustus rate + real trade listings: the exchange rate becomes the
            // headline, the trade result keeps its listings/trade link and its
            // price drops to the `tradeAsk` line (see withExchangeMain).
            : withExchangeMain(
                toPriceResult(job.id, price, tradeKind, room.league, cdMsgFor(room.league).chaosPerDivine),
                faustusChaos,
                cdMsgFor(room.league).chaosPerDivine,
                faustusRangeFor(rec.item, room.league)
              )
        rec.status = 'done'
        rec.lastPrice = result
        broadcast(job.user, result)
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

async function fetchLeagues () {
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
const cdCache = new Map()      // league -> { at, ratio, spark }
const cdMsgByLeague = new Map() // league -> cdMsg

// Current C:D message for a league (cached -> live, otherwise env fallback).
function cdMsgFor (league) {
  return cdMsgByLeague.get(league) || { type: 'cd-ratio', chaosPerDivine: CD_FALLBACK, trendHint: 'fallback' }
}

// Real C:D via the currency EXCHANGE (Faustus NPC) — NOT the stash overview.
// lines[] with id==="divine" -> primaryValue = chaos per divine (~1265 in Standard).
// This row's sparkline is the 7-day trend for the C:D graph. Returns the
// league's cdMsg (and caches it), fallback = last known/env value.
async function refreshCdRatio (league) {
  const c = cdCache.get(league)
  if (c && Date.now() - c.at < NINJA_MIN_MS) {
    const msg = { type: 'cd-ratio', chaosPerDivine: c.ratio, trendHint: 'live · poe.ninja', sparkline: c.spark }
    cdMsgByLeague.set(league, msg)
    return msg
  }
  const ex = await fetchCurrencyExchange(league)
  const div = (ex?.lines || []).find(l => l.id === 'divine')
  const v = div?.primaryValue
  if (typeof v === 'number' && v > 0) {
    const spark = normSpark(div.sparkline?.data)
    cdCache.set(league, { at: Date.now(), ratio: Math.round(v), spark })
    const msg = { type: 'cd-ratio', chaosPerDivine: Math.round(v), trendHint: 'live · poe.ninja', sparkline: spark }
    cdMsgByLeague.set(league, msg)
    return msg
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
// The sparklines do NOT come from poe.ninja's `sparkline`/`sparkLine` field
// anymore: that series is not consistently oriented across rows (the divine row
// tracks its chaos value, the lifeforce rows their divine value), so it can't be
// coloured honestly. The rail keeps its own series instead — see
// reference-history.mjs. poe.ninja's own sparkline stays in use for the C:D
// trend and the item card's ninja reference, which have a single known unit.
// ---------------------------------------------------------------------------

// "Scarce" threshold (tunable): from this many pieces PER CHAOS upward we show
// "N / c", below it we convert to divine and show "N / div".
const LIFEFORCE_PER_CHAOS_MIN = 5

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
// rows -> same derivation, same badge, same display shape.
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
// null (row then renders exactly as before).
function railSellFor (faustusName, league, ratio) {
  if (FAUSTUS_DISABLED || !faustusName) return null
  if (typeof faustusStore?.getSell !== 'function') return null
  if (typeof faustusStore.league === 'function' && faustusStore.league() !== league) return null
  if (typeof faustusStore.isFresh === 'function' && !faustusStore.isFresh(FAUSTUS_TTL_MS)) return null
  const cmp = compareSellSides(faustusStore.getSell(faustusName), ratio)
  if (!cmp || (!cmp.better && !cmp.only)) return null
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

// Auto c/d unit for a per-piece chaos value. priceC = chaos per 1 piece,
// ratio = current C:D. perChaos = pieces per 1 chaos, perDiv = pieces per 1
// divine. abundant-per-chaos -> show per c; scarce-per-chaos -> show per div.
// Returns the unit alongside the string: the rail's sparkline has to be drawn
// in the SAME unit, and the history stores the canonical chaos value, not this
// number (see reference-history.mjs — the threshold flip is not a market move).
function perPieceDisplay (priceC, ratio) {
  const perChaos = 1 / priceC
  const perDiv = ratio / priceC
  return perChaos >= LIFEFORCE_PER_CHAOS_MIN
    ? { display: `${Math.round(perChaos)} / c`, unit: 'perC' }
    : { display: `${Math.round(perDiv)} / div`, unit: 'perDiv' }
}

// The chaos a seller actually collects per piece, taken from the very `sell`
// object the badge is rendered from — the better side when a comparison is
// claimed, the single attested side when only one is. null when the row has
// nothing trustworthy (railSellFor already returns null then).
//
// THE POINT OF THIS FUNCTION: number, badge AND sparkline of these rows all
// read the same value here. They used to disagree (number = poe.ninja's market
// middle, badge = Faustus sell side), which is exactly the mix-up the "Selling"
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
  const base = { name: row.name, key: `s:${row.faustusName}`, invert: true }
  // invert: these rows print a QUANTITY per currency unit, so a rising number
  // means the item got cheaper — bad news for the seller reading the rail.
  // `src` names where the PRINTED NUMBER comes from; it stays absent while the
  // row prints "—", because a row without a number has no source to claim (see
  // the src note in refreshReference).
  if (chaos == null) return { ...base, display: NO_SELL_DATA, chaos: null, unit: null, sell: null }
  const d = perPieceDisplay(chaos, ratio)
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
      // src 'ninja': the NUMBER is poe.ninja's exchange price. The badge next to
      // it is still Faustus-derived and carries its own stamp in its tooltip —
      // that is the badge's claim, not the row's number.
      currency.push({ name: 'Mirror of Kalandra', display: `${Math.round(mir.primaryValue / ratio)} div`, key: 'c:mirror', chaos: mir.primaryValue, unit: 'div', invert: false, src: 'ninja', sell: railSellFor('Mirror of Kalandra', league, ratio) })
    }
    currency.push(sellRow(SULPHUR_ROW, league, ratio))

    // Lifeforce (harvest lifeforce): number, badge and sparkline all from the
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
      await referenceHistory.append(league, { cdRatio: ratio, values })
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

    // refreshedAt = when this poe.ninja data was actually fetched. Baked into the
    // message so it survives caching (a cache hit returns the original stamp, not
    // "now") -> the frontend can show "poe.ninja updated at HH:MM".
    const msg = { type: 'reference', league, currency, lifeforce, beasts, refreshedAt: Date.now() }
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
// Populated ONLY with classes verified live against poe.ninja (see the
// feature's commit message / report for the exact requests) — anything
// dropped here simply keeps going through the existing trade routing below.
//
// Divination Cards: `item.category === 'Divination Card'` is exact and
// unique to this class (see Parser.ts) -> the whole class routes to
// poe.ninja, unconditionally. THE reason this feature exists: div cards have
// no exchange tradeTag (bulkPriceItem can't price them) and PoE's stat search
// (searchPreset) returns single "listings" for them that are overwhelmingly
// stale (see FEATURES-report.md's "The Fortunate" example).
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

// Best-effort poe.ninja lookup for a NINJA_BULK_CLASSES item. Returns
// `{ chaos, count, sparkline }` or `null` — null covers ALL miss cases alike
// (item class not in the map, poe.ninja doesn't know this exact name yet, the
// league/type combination has no data, or the request itself failed) so the
// caller (pump(), server.mjs) has one simple check to fall back to the normal
// trade routing. Never throws.
async function ninjaBulkPrice (item, league) {
  const cls = ninjaBulkClassFor(item)
  if (!cls) return null
  const name = item.name || item.info?.name || item.info?.refName
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
  const name = item?.name || item?.info?.name || item?.info?.refName
  if (!name) return null
  const v = faustusStore.getPrice(name)
  return typeof v === 'number' && v > 0 ? v : null
}

// The chaos range that same digest hour actually traded at ({min,max}), or null
// — same league/freshness guards as faustusChaosFor. Absent for a store written
// before ranges existed, which is fine: the card then just shows no span.
function faustusRangeFor (item, league) {
  if (FAUSTUS_DISABLED) return null
  if (typeof faustusStore?.getRange !== 'function') return null
  if (typeof faustusStore.league === 'function' && faustusStore.league() !== league) return null
  if (typeof faustusStore.isFresh === 'function' && !faustusStore.isFresh(FAUSTUS_TTL_MS)) return null
  const name = item?.name || item?.info?.name || item?.info?.refName
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
  const name = item.name || item.info?.name
  const base = item.info?.refName
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
  const room = users.get(user)
  if (!room) return
  const rec = room.items.get(id)
  if (!rec || !rec.alive) return
  ninjaRefFor(rec.item, room.league).then(ref => {
    const r = room.items.get(id)
    if (ref && r && r.alive) { r.ninja = ref; broadcast(user, { type: 'ninja-ref', id, ...ref }) }
  }).catch(() => {})
}

// Warm up a league (cd + ref) and then broadcast to the room of users on this
// league. For fresh connections whose league doesn't have a warm cache yet.
function warmLeague (league) {
  refreshCdRatio(league)
    .then(() => { broadcastLeague(league, cdMsgFor(league)); return refreshReference(league) })
    .then(() => broadcastLeague(league, refMsgFor(league)))
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0]

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return
  }

  // User list for the identity gate (no auth, just routing).
  if (req.method === 'GET' && path === '/users') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ users: USERS, appName: APP_NAME })); return
  }

  // Every item name the game knows — the exclusion set for the Stash-Highlight
  // token generator (see loadItemNamesJson). Static per build -> cacheable.
  if (req.method === 'GET' && path === '/item-names') {
    try {
      const body = await loadItemNamesJson()
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' }).end(body)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e?.message || e) }))
    }
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

  // League list (poe.ninja, cached) + active league for the frontend dropdown.
  // Multi-user: `active` = league of USERS[0] (the frontend uses its own from
  // `league-state`); pure convenience for the initial dropdown highlight.
  if (req.method === 'GET' && path === '/leagues') {
    const leagues = await fetchLeagues()
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ leagues, active: users.get(USERS[0]).league })); return
  }

  if (req.method === 'POST' && path === '/item') {
    let text
    try { text = await readBody(req) } catch { res.writeHead(400).end('bad body'); return }
    // Daemon identity via X-User. MISSING header -> USERS[0] (keeps the existing
    // header-less trigger working for the first user). A header that is PRESENT
    // but names an unknown user is a config error (typo in the daemon's
    // PPT_USER): routing it silently to USERS[0] would pollute the first user's
    // room with foreign items AND hide the typo from the player who set it (they
    // never see a card). Reject loudly instead. The daemon POSTs fire-and-forget
    // (curl -s, output discarded, no status check, no retry loop), so a 4xx
    // surfaces the misconfiguration without breaking it.
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
    try {
      const { item, presets } = await engine.parseItem(text, { league: room.league })
      const preset = engine.activePreset(presets)

      // Linked sockets: default-active filter (this feature's whole point) —
      // set on preset.filters BEFORE the fingerprint/enqueue below, so even the
      // initial AUTO search (which runs the preset as-parsed, no applySelection
      // call) already filters by socket_filters.filters.links.min. No sockets
      // line (currency/gems/...) -> maxLinks stays null, nothing set. Note:
      // GGG/engine supports links.min ONLY in this build (no max/colors).
      // Pull mods GGG knows but the bundled stat DB doesn't back into the
      // searchable set (active), BEFORE the fingerprint/card/enqueue below.
      await spliceResolvedUnknownMods(item, preset)
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
        // The card already exists in the browser; re-assert its current state
        // (harmless if already shown) rather than adding a duplicate.
        broadcast(user, itemAddedFor(dupRec, PRICE_STATUS[dupRec.status] || 'queued'))
        if (dupRec.lastPrice) broadcast(user, dupRec.lastPrice)
        if (dupRec.ninja) broadcast(user, { type: 'ninja-ref', id: dupRec.id, ...dupRec.ninja })
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
      broadcast(user, addedMsg)              // immediately queued to the browser (only that room)
      enqueue({ user, id, kind: 'auto' })    // trade job into the global queue
      pushNinjaRef(user, id)                 // F3: send poe.ninja reference price best-effort afterwards
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id, user }))
    } catch (e) {
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
  // queue status + replay of their own items (reconnect).
  send(ws, { type: 'league-state', active: room.league })
  send(ws, cdMsgFor(room.league))
  send(ws, refMsgFor(room.league)) // reference rail (currency/lifeforce/beasts)
  send(ws, queueStatusMsg())
  send(ws, rateLimitMsg()) // shared trade-queue ban banner (active or inactive)
  send(ws, { type: 'networth-latest', snapshot: networthSnapshot(user) })
  send(ws, dataStatusMsg()) // M2 status line: freshness of the auto-updated data
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
        // New league -> fetch C:D again, then (exchange cache is warm by then ->
        // no double fetch) fetch reference again + broadcast only to THIS room.
        refreshCdRatio(lg)
          .then(() => { broadcast(user, cdMsgFor(lg)); return refreshReference(lg) })
          .then(() => broadcast(user, refMsgFor(lg)))
          .catch(() => {})
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
await refreshCdRatio(LEAGUE)
await refreshReference(LEAGUE) // warm up the reference rail once (exchange cache is already warm)

// ---------------------------------------------------------------------------
// Net-Worth background refresher: syncs ONE stash tab per interval (default
// 30s) per user into the per-tab store — quiet and continuous, staying far
// under GGG's rate limit instead of the manual full scan's ~115-request burst
// (which is what tripped the 429). Only started when creds exist + the store is
// writable + it isn't disabled. One tab sync broadcasts the refreshed snapshot
// into the user's room -> an open page nudges live. The POESESSID cookie never
// touches a log/broadcast/store.
// ---------------------------------------------------------------------------
let networthRefresher = null
const networthBootCreds = await loadNetworthUsers({ defaultUser: USERS[0] }).catch(() => ({}))
// Started even with ZERO configured users: the refresher reloads the
// credential file every round, so credentials added later through the settings
// UI start syncing on the next tick — without this, a server booted before the
// first credentials were saved would need a restart (a tick with no users is a
// no-op, so an idle refresher costs nothing).
if (NETWORTH_AUTOSYNC && networthStoreWritable) {
  // One valuator per league — its poe.ninja exchange map is built once and
  // cached (>=15min), so re-using it across ticks keeps the ninja request count
  // tiny (the whole point of valuator.mjs). Fresh client per tick is fine
  // (createStashClient does no network at construction; the 30s interval IS the
  // pacing, so the client's per-request backoff state isn't needed across ticks).
  const valuatorByLeague = new Map()
  const valuatorFor = league => {
    let v = valuatorByLeague.get(league)
    if (!v) { v = createValuator({ league, deps: { faustusStore, corpseStore, faustusTtlMs: FAUSTUS_TTL_MS } }); valuatorByLeague.set(league, v) }
    return v
  }
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
    onTabSynced: user => {
      broadcast(user, { type: 'networth-result', snapshot: networthSnapshot(user) })
      recordNetworthHistory(user) // throttled to <=1 point/min inside
    },
    // Pause/cooldown entered or lifted -> push the new state to the status line.
    onStatus: user => broadcastSyncStatus(user),
    intervalMs: NETWORTH_SYNC_INTERVAL_MS,
    listTtlMs: NETWORTH_LIST_TTL_MS,
    cooldownMs: NETWORTH_COOLDOWN_MS
  })
  networthRefresher.start()
  console.log('[networth] background auto-sync on (interval=%dms listTtl=%dms cooldown=%dms users=%d)',
    NETWORTH_SYNC_INTERVAL_MS, NETWORTH_LIST_TTL_MS, NETWORTH_COOLDOWN_MS, Object.keys(networthBootCreds).length)
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
    console.log(`[server] users=[${USERS.join(', ')}]  league=${LEAGUE}  maxListings=${MAX_LISTINGS}  cd=${cdMsgFor(LEAGUE).chaosPerDivine} (${cdMsgFor(LEAGUE).trendHint})`)
    resolve()
  })
})

// Restore a still-running ban gate BEFORE anything can enqueue a search, so a
// restart mid-ban resumes paused instead of probing GGG (see RATE_LIMIT_STATE).
await restoreRateLimit()

// ---- Data auto-update: start the background schedule ------------------------
// The handlers make an adopted update effective in the RUNNING process; how
// each source is validated/persisted lives in data-refresher.mjs.
if (DATA_REFRESH_DISABLED) {
  console.log('[data-refresh] disabled via POE_DATA_REFRESH_DISABLED=1')
} else {
  dataRefresher.start({
    // New APT snapshot: hot-reload the engine data (initData re-assigns the
    // lookup closures inside the bundle — no process restart), then rebuild
    // the two server-side derivatives of items.ndjson. A parse that is
    // in-flight during the few ms of the swap may see mixed old/new lookups —
    // harmless (worst case one odd result), and the alternative would be
    // stalling the whole item pipeline for every update.
    async onAptData ({ publicDataUrl, previousPublicDataUrl, itemsNdjsonPath }) {
      try {
        await engine.reload({ lang: 'en', publicDataDir: publicDataUrl })
      } catch (e) {
        // Roll back to the previous (validated, still on disk) snapshot so the
        // engine keeps working; rethrow so the refresher discards the new one.
        console.warn(`[data-refresh] engine reload failed (${e?.message || e}) — rolling back to the previous data`)
        await engine.reload({ lang: 'en', publicDataDir: previousPublicDataUrl })
        throw e
      }
      itemsIndex = await loadItemsIndex(itemsNdjsonPath)
      itemNamesPath = itemsNdjsonPath
      itemNamesJson = null // lazily rebuilt from the new snapshot on next use
    },
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

// ---------------------------------------------------------------------------
// Test/integration exports. Minimal refactor for task 8 (server integration
// lets tests drive the three-tier queue
// and the lookup store directly, instead of only reaching everything via real
// HTTP/WS requests. The existing price path remains untouched by this —
// these exports are purely additive (no existing function changed).
// ---------------------------------------------------------------------------
export { server, enqueue, enqueueBackground, pump, jobs, bgJobs, users, dataRefresher, LEAGUE, leaguesToRefresh, positiveEnvInt, networthStore, networthHistory, networthRefresher, referenceHistory, refreshReference, faustusStore, faustusRefresher, corpseStore, corpsePricer, corpseTradeClient, rateLimitMsg, noteRateLimit, clearRateLimit, rateLimitSeconds, maxLinkGroup, LINKS_MOD_TEXT, modsOf, buildItemAdded, applySelection, selectionOf, itemAddedFor, toNinjaPriceResult, toPriceResult, withExchangeMain, faustusChaosFor, faustusRangeFor }
