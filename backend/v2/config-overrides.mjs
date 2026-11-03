// Settings the operator can change from the browser instead of from
// `docker-compose.override.yml` — a small JSON file in the /config volume that
// is folded into `process.env` before the server reads any of it. The server
// reads its configuration in ~50 places as `process.env.POE_…`, at module
// load; filling `process.env` before the first read is one entry point, and
// every existing read stays exactly as it is.
//
// THE OVERRIDE WINS OVER THE REAL ENVIRONMENT, by decision: it is what a human
// deliberately submitted through the admin area; the compose file is what the
// box was started with weeks ago. Otherwise the button would silently do
// nothing whenever compose set the same key. So that a compose value without
// effect is visible, `GET /config-view` names the source of every value
// (`override` | `env` | `default`) and says when an override is shadowing the
// environment. Documented in docs/admin.md and README.md.
//
// BOOT QUARANTINE. An override that kills the process at startup would restart
// forever (`restart: unless-stopped`) with no web UI left to undo it. So a
// marker file is written BEFORE the values go into the environment and deleted
// once the server is listening. THE MARKER COUNTS, IT DOES NOT SWITCH: it can
// only observe "the last start did not reach `listen`", never "the overrides
// were to blame" — the whole boot (engine loads, refresher init, a `docker
// compose restart` at the wrong second, a host reboot, an OOM kill) sits in
// that window, while only validated values reach the file. It carries a COUNT
// of consecutive failed starts, and the file is rejected only once that count
// reaches `QUARANTINE_AFTER_FAILED_STARTS`: a restart loop ends after a bounded
// number of attempts, one unlucky restart costs nothing. Rejecting moves the
// file aside to `…rejected.json` and the process starts on the compose/default
// configuration; the rejected file can be inspected and put back by hand.
// ONE /config VOLUME BELONGS TO ONE INSTANCE: two containers sharing one would
// count each other's boots as failures. Not defended with a lock (a deployment
// mistake to begin with); documented in docs/admin.md.
//
// NOTHING SECRET GOES IN HERE. The allow-list below is the only set of keys the
// UI can write, and no POESESSID, account name, password or path is in it.
// `SECRET_KEY_RE` is applied again on the way out, to BOTH halves of
// `configView()` — the settings built from the allow-list and the read-only
// runtime block — so a key added carelessly to either is dropped from the
// answer and reported as a programming error. `config-override.test.mjs`
// smuggles a secret key into the allow-list and proves it does not reach the
// view; `config-override-endpoint.test.mjs` walks a whole real answer. Nor out
// of an error message: V8 quotes an EXCERPT of the file in its `JSON.parse`
// SyntaxError, so the parser's own message never travels into
// `state.problems`, which `GET /config-view` publishes (see `json-error.mjs`).

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SUPPORTED_LANGS } from './user-langs.mjs'
import { jsonErrorSummary } from './json-error.mjs'
import { NUMERIC_SETTINGS_BY_NAME } from './numeric-settings.mjs'
import { SECRET_KEY_RE } from './secret-keys.mjs'
import { PATCH_RE, PATCH_EXAMPLE } from './patch-version.mjs'

export const CONFIG_OVERRIDES_DEFAULT = '/config/overrides.json'

// Anything whose NAME matches this never appears in a response, in any form —
// not the value, not a mask, not a length. It lives in secret-keys.mjs (see the
// header there for the import-cycle reason) and is re-exported here, because
// this is the module every caller learnt it from.
export { SECRET_KEY_RE }

// Keys that are not secret by NAME but point at a file full of secrets. Kept
// out of the read-only view as well: naming the credential file buys nobody
// anything the documentation does not already say.
export const HIDDEN_KEYS = new Set(['POE_NETWORTH_CONFIG'])

// ---------------------------------------------------------------------------
// The allow-list. THIS IS THE ONE SOURCE the settings page builds its fields
// from (over GET /config-view) — a second list in the frontend would drift.
//
// `apply` is the honest answer to "does pressing save do anything right now":
//   live    — the value is read at use time, so the next request/tick sees it.
//   restart — the value was read once into a module constant at startup; the
//             file is written immediately, the running process keeps the old
//             value until it is restarted.
// Every entry below was checked against the read site in server.mjs. Do not
// add a key without doing the same: promising `live` for a value that is read
// once at boot is worse than admitting `restart`.
//
// `defaultValue` is what the server would fall back to, for display only ("what
// do I get if I clear this"). It is never used to configure anything. For a
// number it is read out of numeric-settings.mjs by `numeric()` below; for the
// handful of strings, enums and switches it mirrors the fallback in server.mjs.
//
// `traffic` marks the settings that change HOW OFTEN this tool asks somebody
// else's server, and says which direction does it: `'higher'` or `'lower'`. It
// is wire vocabulary, not display text — the page turns it into a sentence and
// puts every marked row in a group of its own. Only a value that moves the
// REQUEST COUNT carries it; a value that only changes what a request is spent
// on does not (POE_NETWORTH_LIST_TTL_MS is the instructive case — see below).
//
// NUMBERS COME FROM numeric-settings.mjs, NOT FROM HERE. `numeric()` reads the
// default and the outer bounds out of that table, which is the same table the
// server reads the value through — so there is one answer to "what is the
// default" and one to "what is allowed", not two that drift. An entry may pass
// `min`/`max` to NARROW the range for the browser path and never to widen it
// (config-override.test.mjs proves both halves). That asymmetry is deliberate
// and pre-dates this list: the allow-list is the path a human clicks through in
// a moment of curiosity, the environment is what a deployment writes once.
//
// The nine request-volume rows are nonetheless bounded in the TABLE and not
// here. A one-millisecond interval is not safer for coming out of a compose
// file, and a ban has been reported to reach the whole address rather than the
// account that earned it — so the floor belongs where both paths read it. See
// the range note in numeric-settings.mjs for where each number comes from.
// ---------------------------------------------------------------------------

/**
 * A numeric row of the allow-list, built from the table in numeric-settings.mjs.
 *
 * The widget `type` is 'int' throughout: every numeric setting the admin area
 * offers is a count, a budget or a millisecond duration, and a text field that
 * accepts `2.5` milliseconds only invites a typo. Where the table already says
 * `integer` this is the same rule; where it does not, it is a narrowing of the
 * browser path, like `min`/`max` below.
 */
function numeric (name, { description, apply, traffic, min, max }) {
  const spec = NUMERIC_SETTINGS_BY_NAME.get(name)
  if (!spec) {
    throw new Error(`${name} is not in numeric-settings.mjs — add it to that table first, so its default and range have one home`)
  }
  // The smallest value the reader in env-number.mjs would accept: its own `min`
  // if it has one, otherwise 0 or 1 depending on whether an explicit zero is a
  // setting for this variable. Restating it as a literal here is exactly the
  // second list this function exists to avoid.
  const floor = spec.min != null ? spec.min : (spec.zero ? 0 : 1)
  return {
    name,
    description,
    type: 'int',
    min: min == null ? floor : Math.max(min, floor),
    max: max == null ? spec.max : (spec.max == null ? max : Math.min(max, spec.max)),
    defaultValue: String(spec.fallback),
    apply,
    traffic
  }
}

export const SETTABLE = Object.freeze([
  {
    name: 'POE_APP_NAME',
    description: 'Display name in the header and page title of the landing page.',
    type: 'string',
    maxLength: 60,
    defaultValue: 'Trade Console',
    apply: 'live'
  },
  {
    name: 'POE_LEAGUE',
    description: 'Starting league for every room, and the single league the background pricers (Faustus, corpses) work on.',
    type: 'string',
    maxLength: 60,
    defaultValue: 'Standard',
    apply: 'restart'
  },
  {
    name: 'POE_LANG_DEFAULT',
    description: 'Client language for users who have never picked one themselves. Also decides which language data sets this installation keeps up to date.',
    type: 'enum',
    values: [...SUPPORTED_LANGS],
    defaultValue: 'en',
    apply: 'restart'
  },
  {
    // THE ESCAPE HATCH THAT NEEDED SSH TO REACH. When the patch lookup is gone
    // or answers something the tool refuses, this variable is the documented
    // one-line repair — and it was settable only in the compose file, i.e. only
    // by the person with a shell on the box. That is the opposite of what the
    // admin area is for (docs/bugs.md B24).
    //
    // `live`, and checked at the read site rather than assumed: nothing reads
    // this at module load. `resolvePatchVersion()` (lang-data-gen.mjs) reads
    // `env.POE_PATCH_VERSION` when it is CALLED, and the caller is the data
    // refresher's daily lang-data tick — so a value saved here is in force at
    // the next tick, without a restart.
    //
    // The pattern is the generator's own (patch-version.mjs), so a value this
    // form accepts is a value the next start accepts too.
    name: 'POE_PATCH_VERSION',
    description: 'Game patch the localized data set is generated from, e.g. ' + PATCH_EXAMPLE +
      '. Normally EMPTY: the version is looked up automatically. Set it when that lookup is unavailable ' +
      'or answers something the tool refuses — it then wins outright, and it is the one-line repair for ' +
      'every failure of the lookup. Digits and dots only, however many parts. Remember to clear it again ' +
      'at the next patch, or the data set stays on this one.',
    type: 'string',
    maxLength: 40,
    pattern: PATCH_RE,
    patternError: 'expected a patch version — digits and dots, e.g. ' + PATCH_EXAMPLE +
      ' (an empty field means "look it up"; use the reset button for that)',
    // No default: unset is a state of its own here, and it is the normal one.
    defaultValue: '',
    apply: 'live'
  },
  numeric('POE_MAX_LISTINGS', {
    // NOT marked `traffic`: the fetch endpoint takes all ids in ONE call, so
    // raising this changes how much comes back, not how often anything is
    // asked. The ceiling of 10 is GGG's and comes out of the table.
    description: 'Trade listings fetched per search. The trade API refuses more than 10, and they all arrive in one request — this changes how much an answer contains, not how many requests are sent.',
    apply: 'live'
  }),
  {
    // ON BY DEFAULT, WHICH IS THE OPPOSITE OF WHAT B19 CONCLUDED — because the
    // rule underneath it is the opposite rule. B19's skip asked "does this look
    // like a tier page?" and skipped everything it did not understand; this one
    // asks "did GGG say `tier<N>`?" and READS everything it does not
    // understand (networth/map-sections.mjs). A misreading here costs requests,
    // not stock.
    //
    // What it removes from the net worth is normal maps, which have no price in
    // this tool anyway — they leave the "unpriced" list, no priced number moves.
    // What it saves is most of a folder tab: 14 of 43 sub-tabs on the account
    // this was measured on, at one derived spacing each.
    name: 'POE_NETWORTH_SKIP_TIER_MAPS',
    description: 'Skip the per-tier pages of the map stash (GGG labels them tier1…tier16) and read only Unique and Special maps. ' +
      'Normal maps are never priced, and those pages are most of what the map tab costs to read. ' +
      'Off means the whole map stash is read, which takes markedly longer per round.',
    type: 'bool',
    defaultValue: '1',
    apply: 'live',
    // Turning it UP (on) sends fewer requests, which is the same direction
    // every interval in this group runs in — so the page can say one sentence
    // about the whole section without a switch reading backwards inside it.
    traffic: 'lower'
  },
  {
    name: 'POE_NETWORTH_DEBUG',
    description: 'One diagnostic log line per scanned stash tab (raw/priced/unpriced/skipped). Tells "the tab came back empty" apart from "everything was skipped".',
    type: 'bool',
    defaultValue: '0',
    apply: 'live'
  },
  numeric('POE_CD_RATIO', {
    description: 'Chaos per divine to fall back on while poe.ninja cannot be reached. A number the tool holds, not one it asks for.',
    apply: 'restart'
  }),

  // ---- The background jobs, as switches ------------------------------------
  // Their dangerous direction is "on", which is also the default and is said in
  // the label, so they stay in the ordinary groups. What is NOT here:
  // POE_PRICE_CHECK_DISABLED. It exists for tests and for a deployment that
  // deliberately runs without the price check; through the settings page it
  // would be a checkbox that switches off the tool's main feature, with nothing
  // on screen to say why every card afterwards is unpriced.
  {
    name: 'POE_NETWORTH_AUTOSYNC',
    description: 'Background net-worth refresher: syncs one stash tab per tick. Off means the net-worth snapshot only changes on a manual scan.',
    type: 'bool',
    defaultValue: '1',
    apply: 'restart'
  },
  {
    name: 'POE_FAUSTUS_DISABLED',
    description: 'Turn off the Faustus (GGG Currency Exchange) refresher. Fungible items then fall back to poe.ninja prices.',
    type: 'bool',
    defaultValue: '0',
    apply: 'restart'
  },
  {
    name: 'POE_CORPSE_DISABLED',
    description: 'Turn off the itemised-corpse background pricer. Corpses then stay honestly unpriced.',
    type: 'bool',
    defaultValue: '0',
    apply: 'restart'
  },
  {
    name: 'POE_DATA_REFRESH_DISABLED',
    description: 'Turn off the daily data auto-update. An already adopted snapshot stays in use; nothing new is fetched.',
    type: 'bool',
    defaultValue: '0',
    apply: 'restart'
  },
  {
    name: 'POE_RELEASE_CHECK_DISABLED',
    description: 'Turn off the once-a-day check for a newer release on GitHub. The manual check on this page keeps working.',
    type: 'bool',
    defaultValue: '0',
    apply: 'live'
  },
  {
    name: 'POE_REFERENCE_DISABLED',
    description: 'Skip the one-time Chaos:Divine and reference-rail warm-up at boot. Both stay on their fallback value until the periodic refresh reaches them.',
    type: 'bool',
    defaultValue: '0',
    apply: 'restart'
  },

  // ---- Bars and limits that cost nobody a request --------------------------
  numeric('POE_NETWORTH_LIST_TTL_MS', {
    // NOT marked `traffic`, and it is the case that shows why the mark is about
    // the request COUNT: a refresher tick is either a tab-list refresh or one
    // tab sync, never both. Lowering this spends more of the same ticks on the
    // list instead of on a tab. The number of requests does not move; what
    // moves is how much of the net worth is ever looked at.
    description: 'How long a stash-tab list stays fresh before the refresher spends a tick re-reading it. A tick refreshes the list OR syncs one tab, never both — so a shorter life here does not add requests, it takes ticks away from the tabs.',
    apply: 'restart'
  }),
  numeric('POE_FAUSTUS_TTL_MS', {
    description: 'How stale the stored Faustus prices may get before the valuator stops using them and falls through to poe.ninja. A read-side bar: it does not change how often the store is refreshed.',
    apply: 'restart'
  }),
  // The uncertainty marker's two bars. `restart`: the valuator is built once
  // per league with its bars fixed (server.mjs valuatorByLeague).
  numeric('POE_NETWORTH_THIN_TURNOVER_C', {
    description: 'Net Worth marks a price "thin market" when the trading behind it moved less than this many chaos (Faustus: the hour the price came from; poe.ninja exchange: the line\'s own volume, and a line without one counts as thin). It only marks: no price, total or history point changes. 0 marks nothing.',
    apply: 'restart'
  }),
  numeric('POE_NETWORTH_CORPSE_MIN_LISTINGS', {
    description: 'Net Worth marks a corpse price "few listings" when it was averaged from fewer trade offers than this. It only marks. 0 marks nothing.',
    apply: 'restart'
  }),
  numeric('POE_SOURCE_STALE_MS', {
    // Read through envNum each time a source-status or cd-ratio message is
    // built, and server.mjs sends both again right after this setting changes
    // (broadcastStaleBars), so open pages get the new bar at once — live for
    // real.
    description: 'How old the last successful update of a price source (Faustus, poe.ninja) may get before the status line on every page and the Sources block on this page call it stale. Display only: it changes no request.',
    apply: 'live'
  }),
  numeric('POE_NINJA_MAX_AGE_MS', {
    description: 'How long a poe.ninja answer is still served after poe.ninja stopped answering. Past it the item is unpriced and falls through to the next source instead of keeping an old price.',
    apply: 'restart'
  }),
  numeric('POE_DATA_STALE_TICKS', {
    description: 'How many missed checks make a data source "stale" in the status line. Counted in refresh intervals, not in days.',
    apply: 'restart'
  }),
  numeric('POE_GAP_LOG_MAX', {
    description: 'How many distinct gaps the admin view keeps per kind. Over the cap the least frequent entry is dropped and the view says so.',
    apply: 'restart'
  }),
  numeric('POE_GAP_LOG_TEXT_MAX', {
    description: 'How many characters of a recorded text are kept. Below roughly 40 the excerpt can no longer show which item failed.',
    apply: 'restart'
  }),
  numeric('POE_UPDATE_HEARTBEAT_MAX_AGE_MS', {
    description: 'How old the host updater’s heartbeat may get before this page says no updater is installed. Raise it if the script runs less often than every few minutes.',
    apply: 'restart'
  }),
  // Farm sessions (networth/sessions.mjs): display thresholds only. The two
  // that shape stored data — POE_SESSIONS_KEEP and POE_SESSION_FINALIZE_MAX_MS —
  // stay environment-only on purpose.
  numeric('POE_SESSION_RATE_MIN_MS', {
    description: 'Shortest farm session that gets a loot-per-hour figure. Shorter sessions show their totals and say they were too short. 0 gives every session a figure.',
    apply: 'restart'
  }),
  numeric('POE_SESSION_TOP_N', {
    description: 'How many of the biggest additions and removals a farm-session balance names. 0 names none; the totals are unaffected.',
    apply: 'restart'
  }),
  numeric('POE_SESSION_LIST_MAX', {
    description: 'How many past farm sessions the History page lists, newest first.',
    apply: 'restart'
  }),
  numeric('POE_SESSION_BASELINE_MAX_AGE_MS', {
    description: 'How old the newest net-worth reading may be when a farm session is started. Older means the background sync is not running, and the start is refused rather than measured from a stale stash.',
    apply: 'restart'
  }),

  // ---- Everything that decides how often somebody else's server is asked ---
  // Every entry below carries `traffic`, and the settings page draws them in a
  // group of their own with that said out loud. This repository has two real
  // Trade-API bans behind it; a number that raises request volume must not look
  // like a number that renames the header.
  numeric('POE_NETWORTH_SYNC_INTERVAL_MS', {
    description: 'Delay between net-worth refresher ticks. One tick is one request against GGG’s stash API, shared round-robin between all configured users.',
    apply: 'restart',
    traffic: 'lower',
    // No `min` here: the floor is 30s and lives in numeric-settings.mjs, where
    // the compose path is bound by it too (see the range note in that file's
    // header); a browser-only floor of five seconds would allow 720 stash
    // reads an hour. What this row adds is the ceiling: an hour between ticks
    // is the slowest setting that is still a background refresher, and it is a
    // narrowing (the table has no maximum) rather than something the reader
    // would refuse.
    max: 3600000
  }),
  numeric('POE_NETWORTH_COOLDOWN_MS', {
    description: 'How long the net-worth refresher waits after GGG answered 429, for every user rather than only the one that was refused. A longer Retry-After from GGG still wins.',
    apply: 'restart',
    traffic: 'lower'
  }),
  numeric('POE_CORPSE_BUDGET_PER_HOUR', {
    description: 'How many distinct corpse names the background pricer may look up on the Trade API per rolling hour. 0 means it asks for nothing at all and only serves what it already has. The ceiling is what the pacing can actually deliver — one name per tick, so 30 in an hour.',
    apply: 'restart',
    traffic: 'higher'
  }),
  numeric('POE_CORPSE_INTERVAL_MS', {
    description: 'Delay between corpse pricer ticks, one name per tick. The hourly budget caps the total; this is the pacing that keeps the shared trade queue free for a manual search.',
    apply: 'restart',
    traffic: 'lower'
  }),
  numeric('POE_CORPSE_TTL_MS', {
    description: 'How long a corpse price stays fresh before it is asked again. Shorter means the hourly budget is spent re-asking questions that already have answers.',
    apply: 'restart',
    traffic: 'lower'
  }),
  numeric('POE_FAUSTUS_REFRESH_MS', {
    description: 'How often the Faustus refresher reads the GGG Currency Exchange feed. Each run fetches one file per unioned hour, and the underlying data only changes hourly.',
    apply: 'restart',
    traffic: 'lower'
  }),
  numeric('POE_CD_REFRESH_MS', {
    description: 'How often the Chaos:Divine ratio and the reference rail are read from poe.ninja. 15 minutes is the floor: the server lifts anything smaller back to it anyway, following poe.ninja’s own courtesy limit.',
    apply: 'restart',
    traffic: 'lower'
  }),
  numeric('POE_DATA_REFRESH_MS', {
    description: 'How often the data auto-update checks its sources (item and stat data, base names). Conditional requests, so an unchanged day transfers nothing — but it is still a request.',
    apply: 'restart',
    traffic: 'lower'
  }),
  numeric('POE_NINJA_MAP_TTL_MS', {
    description: 'How long the net-worth valuation keeps its merged poe.ninja exchange map (14 overview types) before it reads them again. Shorter means more poe.ninja requests: 14 per rebuild.',
    apply: 'restart',
    traffic: 'lower'
  })
])

export const SETTABLE_BY_NAME = new Map(SETTABLE.map(s => [s.name, s]))

// WHAT IS DELIBERATELY NOT ON THE LIST, and why. Each of these was looked at
// once and left out on purpose; docs/admin.md carries the same list in operator
// language, and a test keeps the two in step.
//
//   POE_USERS — rooms, the per-tab net-worth store, the credential file and the
//     language mapping are all keyed by the names in it. One click in a browser
//     must not be able to orphan all of that.
//   Paths, ports, PORT — a wrong one takes the tool off the air, and the page
//     that could undo it goes with it.
//   Anything secret — no POESESSID, no account name, no password. Not settable
//     and not shown; see SECRET_KEY_RE and redactEntries() below.
//   POE_PRICE_CHECK_DISABLED — a switch for tests and for a deployment that
//     runs without the price check. Set from the settings page it would turn
//     off the tool's main feature, leaving every card unpriced with nothing on
//     screen saying why.
//   POE_TRADE_AUDIT and POE_TRADE_AUDIT_THRESHOLD — the rate-limit audit is the
//     observability that exists BECAUSE of the two bans; a page that can blind
//     the tool to how full its rate-limit windows are is the wrong page. The
//     threshold follows the switch: it is a fraction with no upper bound in the
//     table, so a 2 typed into it silences the audit as effectively as the
//     switch would, and without saying so.
//   POE_FAUSTUS_UNION_HOURS — the one row in numeric-settings.mjs with no
//     default of its own: unset means "faustus.mjs decides" (8), which is the
//     normal state. The page could not answer "what do I get if I clear this",
//     which is the one thing every other row can. It also multiplies the CDN
//     fetches of every refresh run, so leaving it in compose is the safe side.
//   POE_NINJA_FAIL_LOG_MS — how often a failing poe.ninja key is logged again.
//     It shapes the container log and nothing a page shows; that is an
//     operator setting for the compose file, not for a form.

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on'])
const BOOL_FALSE = new Set(['0', 'false', 'no', 'off'])

/**
 * validateSetting(name, value) -> { ok: true, value: '<string>' }
 *                               | { ok: false, error: '<why>' }
 *
 * The result is always a STRING, because that is what an environment variable
 * is — a value that validates but cannot be represented as one is a bug here,
 * not something to paper over at the read site.
 */
export function validateSetting (name, value) {
  const spec = SETTABLE_BY_NAME.get(name)
  if (!spec) {
    return { ok: false, error: `"${name}" is not a settable key (settable: ${SETTABLE.map(s => s.name).join(', ')})` }
  }
  if (value === null || value === undefined) return { ok: false, error: `${name}: no value given` }
  if (typeof value === 'object') return { ok: false, error: `${name}: value must be a string, number or boolean` }

  const raw = String(typeof value === 'boolean' ? (value ? '1' : '0') : value).trim()
  if (!raw) return { ok: false, error: `${name}: value must not be empty (send null to remove the override)` }

  switch (spec.type) {
    case 'bool': {
      const low = raw.toLowerCase()
      if (BOOL_TRUE.has(low)) return { ok: true, value: '1' }
      if (BOOL_FALSE.has(low)) return { ok: true, value: '0' }
      return { ok: false, error: `${name}: expected a boolean (1/0)` }
    }
    case 'int': {
      const n = Number(raw)
      if (!Number.isInteger(n)) return { ok: false, error: `${name}: expected a whole number` }
      if (spec.min != null && n < spec.min) return { ok: false, error: `${name}: must be >= ${spec.min}` }
      if (spec.max != null && n > spec.max) return { ok: false, error: `${name}: must be <= ${spec.max}` }
      return { ok: true, value: String(n) }
    }
    case 'enum': {
      if (!spec.values.includes(raw)) {
        return { ok: false, error: `${name}: unsupported value (allowed: ${spec.values.join(', ')})` }
      }
      return { ok: true, value: raw }
    }
    case 'string': {
      // No control characters: these end up in an env var, in log lines and in
      // an HTML page. A newline in POE_APP_NAME is not a use case.
      if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: `${name}: control characters are not allowed` }
      if (spec.maxLength && raw.length > spec.maxLength) {
        return { ok: false, error: `${name}: at most ${spec.maxLength} characters` }
      }
      // A row may demand a SHAPE on top of that, and then it is the shape the
      // READING side demands — the expression is imported from where the value
      // is read, never restated here (POE_PATCH_VERSION / patch-version.mjs).
      // A form that accepts what the next start refuses is worse than no form.
      if (spec.pattern && !spec.pattern.test(raw)) {
        return { ok: false, error: `${name}: ${spec.patternError || 'value has the wrong shape'}` }
      }
      return { ok: true, value: raw }
    }
    default:
      return { ok: false, error: `${name}: unknown type "${spec.type}" in the allow-list` }
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const stripJson = p => p.replace(/\.json$/i, '')

/** The "a start with these overrides is in progress" marker. */
export function markerPathFor (path) { return `${stripJson(path)}.applying` }
/** Where a set of overrides that killed the previous start is parked. */
export function rejectedPathFor (path) { return `${stripJson(path)}.rejected.json` }

// ---------------------------------------------------------------------------
// The boot marker: how many consecutive starts with this file failed to listen
// ---------------------------------------------------------------------------

/**
 * How many starts in a row may fail before the overrides are blamed for it.
 * Two, not one: one failed start is far more likely to be a restart, a reboot
 * or an OOM kill inside the boot window than a poisonous configuration (see the
 * header). Two in a row with nothing in between that ever listened is the point
 * at which "it is the file" becomes the better explanation.
 */
export const QUARANTINE_AFTER_FAILED_STARTS = 2

/** What is written into the marker. Readable for whoever cats it in /config. */
export function markerBody (failedStarts, at = new Date()) {
  return `failedStarts=${failedStarts}\nlast=${at.toISOString()}\n`
}

/**
 * The count in an existing marker. A marker written by an older version (a bare
 * timestamp), an empty one or one that cannot be read all mean the same thing:
 * a start did not finish, and we cannot tell how many. Counting that as ONE is
 * the safe direction — it keeps a configuration that may be fine.
 */
function readFailedStarts (markerPath) {
  let raw = ''
  try { raw = readFileSync(markerPath, 'utf8') } catch { return 1 }
  const m = /failedStarts=(\d+)/.exec(raw)
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) && n > 0 ? n : 1
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function parseOverrideObject (raw) {
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('overrides file must contain a JSON object')
  }
  return parsed
}

/**
 * applyConfigOverrides({ path, env, log }) -> state
 *
 * SYNCHRONOUS on purpose: it has to finish before the first module-level
 * `process.env` read in the process, and an `await` cannot be put in front of
 * an ESM module body. See config-boot.mjs, which is what actually calls it.
 *
 * state = {
 *   path, markerPath, rejectedPath,
 *   applied:      { KEY: 'value' }  what went into env this boot
 *   shadowedEnv:  ['KEY', …]        overrides that overrode a real env value
 *   baseEnv:      { KEY: 'value'|undefined }  every settable key as the process
 *                                   was STARTED with — the way back when an
 *                                   override is removed at runtime
 *   failedStarts: number            consecutive starts before this one that did
 *                                   not reach 'listening' (0 = none)
 *   quarantined:  boolean           that count reached the threshold and the
 *                                   file was put aside
 *   problems:     ['…', …]          human-readable, already logged
 *   quarantineProblems: ['…', …]    the alarm's own text, kept apart so a
 *                                   deliberate new save can clear it without
 *                                   string-matching the list above
 * }
 */
export function applyConfigOverrides ({
  path = process.env.POE_CONFIG_OVERRIDES || CONFIG_OVERRIDES_DEFAULT,
  env = process.env,
  log = console
} = {}) {
  const markerPath = markerPathFor(path)
  const rejectedPath = rejectedPathFor(path)
  const state = {
    path,
    markerPath,
    rejectedPath,
    applied: {},
    shadowedEnv: [],
    baseEnv: {},
    failedStarts: 0,
    quarantined: false,
    problems: [],
    quarantineProblems: []
  }
  // The way back: remember every settable key as the process was started with,
  // before anything is folded in. Removing an override at runtime restores
  // exactly this — not "delete from env", which would silently drop a compose
  // value along with the override.
  for (const s of SETTABLE) state.baseEnv[s.name] = env[s.name]

  let raw = null
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') {
      state.problems.push(`could not read ${path} (${e.code || e.message})`)
      log.warn?.(`[config-overrides] ${state.problems.at(-1)} — starting without overrides`)
    }
    // No file: make sure a marker left over from an earlier run does not
    // quarantine a file that no longer exists.
    try { if (existsSync(markerPath)) unlinkSync(markerPath) } catch { /* read-only /config */ }
    return state
  }

  // Boot quarantine. The marker is only ever left behind by a start that never
  // reached 'listening'; the count in it says how many of those there were in a
  // row. Below the threshold the file gets another chance — see the header for
  // why one failed start is the wrong moment to blame it.
  state.failedStarts = existsSync(markerPath) ? readFailedStarts(markerPath) : 0
  if (state.failedStarts >= QUARANTINE_AFTER_FAILED_STARTS) {
    state.quarantined = true
    try {
      renameSync(path, rejectedPath)
      unlinkSync(markerPath)
      state.quarantineProblems.push(`the last ${state.failedStarts} starts with these overrides did not come up — moved them to ${rejectedPath}`)
    } catch (e) {
      state.quarantineProblems.push(`the last ${state.failedStarts} starts with these overrides did not come up, and ${path} could not be moved aside (${e.code || e.message}) — ignoring the file for this start`)
    }
    log.warn?.(`[config-overrides] ${state.quarantineProblems.at(-1)}`)
    log.warn?.('[config-overrides] running on the compose/default configuration. Inspect the rejected file before putting it back.')
    return state
  }

  let values
  try {
    values = parseOverrideObject(raw)
  } catch (e) {
    // Broken JSON is left in place: it is the operator's file, the next save
    // through the UI rewrites it anyway, and moving it would hide the mistake.
    // The parser's message is summarised, never quoted — see json-error.mjs.
    state.problems.push(`${path} is not valid JSON (${jsonErrorSummary(e)}) — ignoring it`)
    log.warn?.(`[config-overrides] ${state.problems.at(-1)}`)
    // Nothing from this file is in force, so nothing that happens to this start
    // can be blamed on it: the failure count has no business surviving.
    try { if (existsSync(markerPath)) unlinkSync(markerPath) } catch { /* read-only /config */ }
    return state
  }

  const accepted = {}
  for (const [name, value] of Object.entries(values)) {
    if (value === null) continue // "no override" written out long-hand
    const check = validateSetting(name, value)
    if (!check.ok) {
      state.problems.push(check.error)
      log.warn?.(`[config-overrides] ignoring ${check.error}`)
      continue
    }
    accepted[name] = check.value
  }
  if (!Object.keys(accepted).length) {
    try { if (existsSync(markerPath)) unlinkSync(markerPath) } catch { /* ignore */ }
    return state
  }

  // Marker BEFORE the values reach the environment — that ordering is the whole
  // point. It carries this start's number in the failure count, so the next one
  // knows whether it is the first retry or the last. A read-only /config cannot
  // have been written by our own UI, so a marker that cannot be created is a
  // warning, not a refusal.
  try {
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, markerBody(state.failedStarts + 1), 'utf8')
  } catch (e) {
    log.warn?.(`[config-overrides] could not write the boot marker ${markerPath} (${e.code || e.message}) — overrides are applied, but a start they break will not be caught automatically`)
  }
  if (state.failedStarts > 0) {
    // Loud, but not an alarm: the operator should see it in the log if a boot
    // really is dying on these values, and see nothing on the page if the last
    // start was simply interrupted.
    log.warn?.(`[config-overrides] the previous start with these overrides did not reach 'listening' (${state.failedStarts} of ${QUARANTINE_AFTER_FAILED_STARTS} before they are put aside) — applying them again`)
  }

  for (const [name, value] of Object.entries(accepted)) {
    if (env[name] !== undefined && env[name] !== value) state.shadowedEnv.push(name)
    env[name] = value
    state.applied[name] = value
  }
  log.log?.(`[config-overrides] applied from ${path}: ${Object.keys(accepted).sort().join(', ')}` +
    (state.shadowedEnv.length ? `  (overriding the environment for: ${state.shadowedEnv.sort().join(', ')})` : ''))
  return state
}

/**
 * The other half of the quarantine bracket: called once the server is actually
 * listening. Removing the marker is what RESETS the failure count — a start
 * that got this far says nothing about these overrides is fatal, whatever
 * happened before it.
 */
export function clearApplyingMarker (state, { log = console } = {}) {
  if (!state?.markerPath) return false
  try {
    unlinkSync(state.markerPath)
    return true
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log.warn?.(`[config-overrides] could not remove the boot marker ${state.markerPath} (${e.code || e.message}) — the next start would reject the overrides`)
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Runtime (the endpoints)
// ---------------------------------------------------------------------------

/** The override file as it is on disk right now. Missing/broken -> {}. */
export async function readOverrideFile (path) {
  try {
    return parseOverrideObject(await readFile(path, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return {}
    return {}
  }
}

let tmpCounter = 0

/** Atomic tmp+rename, same pattern as the net-worth store. */
export async function writeOverrideFile (path, values) {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.${process.pid}.${++tmpCounter}.tmp`
  try {
    await writeFile(tmpPath, JSON.stringify(values, null, 2) + '\n', 'utf8')
    await rename(tmpPath, path)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}

/**
 * setOverride({ path, state, name, value })
 *
 *   value === null  -> remove the override, back to compose/default
 *   otherwise       -> validate, persist, and for a `live` key put it into the
 *                      running environment
 *
 * Persist FIRST, then change the running process: a write that fails must not
 * leave a value that is in force but nowhere on disk.
 *
 * -> { ok: true, name, value, applied: 'live' | 'restart-required' }
 *  | { ok: false, status, error }
 */
export async function setOverride ({ path, state, name, value }) {
  const spec = SETTABLE_BY_NAME.get(name)
  if (!spec) {
    return { ok: false, status: 400, error: `"${name}" is not a settable key`, settable: SETTABLE.map(s => s.name) }
  }
  let stored = null
  if (value !== null && value !== undefined) {
    const check = validateSetting(name, value)
    if (!check.ok) return { ok: false, status: 400, error: check.error }
    stored = check.value
  }

  const values = await readOverrideFile(path)
  if (stored === null) delete values[name]
  else values[name] = stored
  try {
    await writeOverrideFile(path, values)
  } catch (e) {
    return { ok: false, status: 500, error: `could not write ${path} (${e.code || e.message})` }
  }
  // The quarantine alarm describes a file that was put aside at boot. This
  // write replaces that file with one a human just submitted, so the alarm has
  // nothing left to describe and must not stand until the next restart —
  // otherwise the page keeps shouting about a configuration that is gone.
  clearQuarantineNotice(state)

  if (spec.apply === 'live') {
    if (stored === null) {
      const back = state?.baseEnv?.[name]
      if (back === undefined) delete process.env[name]
      else process.env[name] = back
    } else {
      process.env[name] = stored
    }
    // Boot bookkeeping follows, so `restartPending` below stays false for a
    // key that really did take effect.
    if (state) {
      if (stored === null) delete state.applied[name]
      else state.applied[name] = stored
    }
  }

  return {
    ok: true,
    name,
    value: stored,
    applied: spec.apply === 'live' ? 'live' : 'restart-required'
  }
}

/** Drop the quarantine alarm from a state, once it no longer describes reality. */
export function clearQuarantineNotice (state) {
  if (!state?.quarantined) return false
  state.quarantined = false
  state.quarantineProblems = []
  return true
}

/**
 * configView({ state, env, runtime }) — everything the settings page needs to
 * draw the configuration section, and NOTHING that is secret.
 *
 * `runtime` is the caller's list of effective settings it does not offer for
 * editing (server.mjs builds it from its own constants, so it cannot drift from
 * what the process is really doing).
 *
 * BOTH halves go through `redactEntries()`. The allow-list is not exempt from
 * that just because it is right here in this file: a key added to it carelessly
 * later is exactly the case the filter exists for, and the answer must not be
 * the one place where the rule is only claimed.
 *
 * `settable` is a parameter so a test can smuggle a secret key into the list and
 * watch it be dropped. Nothing in the running server passes it.
 */
export function configView ({
  state, env = process.env, runtime = [], overrides = {},
  settable = SETTABLE, log = console
} = {}) {
  const settings = redactEntries(settable, { kind: 'settable key', log }).map(spec => {
    const present = Object.hasOwn(overrides, spec.name) && overrides[spec.name] !== null
    const fromEnv = state?.baseEnv?.[spec.name]
    const effective = env[spec.name]
    // Normalized the same way the boot path normalizes it, so `true` in a
    // hand-edited file and `'1'` in the environment are not reported as a
    // pending change. An entry that does not validate is NOT an override: it
    // was ignored at boot and would be refused on the way in, so saying
    // "override" here would explain a value the process does not have.
    const check = present ? validateSetting(spec.name, overrides[spec.name]) : null
    const fileValue = check?.ok ? check.value : undefined
    const overridden = fileValue !== undefined
    // What this process is really running with, and what the file on disk asks
    // for — both normalised the same way, so they can be compared. `restart`
    // keys are the reason: the environment still holds what was read at boot,
    // and an override written since then is only pending if it asks for
    // something ELSE. Writing the compose value into the file changes nothing
    // and must not be announced as a change waiting for a restart.
    const currentValue = effective !== undefined ? String(effective) : spec.defaultValue
    const desiredValue = fileValue ?? (fromEnv !== undefined ? String(fromEnv) : spec.defaultValue)
    return {
      name: spec.name,
      description: spec.description,
      type: spec.type,
      values: spec.values ? [...spec.values] : undefined,
      min: spec.min,
      max: spec.max,
      maxLength: spec.maxLength,
      apply: spec.apply,
      // 'higher' | 'lower' | undefined — which direction of THIS setting sends
      // more requests to somebody else's server. The page groups by it and
      // turns it into a sentence; it never travels as display text.
      traffic: spec.traffic,
      defaultValue: spec.defaultValue,
      value: currentValue,
      overrideValue: fileValue ?? null,
      source: overridden ? 'override' : (fromEnv !== undefined ? 'env' : 'default'),
      // The honest warning for "my compose value does nothing".
      shadowsEnv: overridden && fromEnv !== undefined && fromEnv !== fileValue,
      envValue: overridden && fromEnv !== undefined ? String(fromEnv) : null,
      // Written to disk, not yet in force in this process.
      restartPending: spec.apply === 'restart' && desiredValue !== currentValue,
      // An entry in the file that the allow-list refuses — it is doing nothing
      // and the page should say so rather than draw it as a value in force.
      invalid: present && !check.ok ? check.error : null
    }
  })
  const quarantined = Boolean(state?.quarantined)
  return {
    settings,
    runtime: redactView(runtime, { log }),
    overridesPath: state?.path ?? null,
    quarantined,
    rejectedPath: quarantined ? state.rejectedPath : null,
    // The alarm's own text only travels while the alarm stands.
    problems: [
      ...(state?.problems ?? []),
      ...(quarantined ? (state.quarantineProblems ?? []) : [])
    ],
    restartPending: settings.some(s => s.restartPending)
  }
}

/**
 * Last line of defence in front of BOTH halves of the view: drop every entry
 * whose NAME could name a secret, whoever put it in the list.
 *
 * Getting here is a programming error — the allow-list is curated in this file
 * and the read-only block is curated in server.mjs — so it is not silent. The
 * entry is dropped from the answer AND the process says which one and why,
 * because a value that quietly disappears from a settings page is its own kind
 * of bug report nobody reads.
 *
 * `HIDDEN_KEYS` is the other case and stays quiet: those names are deliberately
 * kept out, not accidentally let in.
 */
export function redactEntries (entries, { kind = 'entry', log = console } = {}) {
  const out = []
  for (const e of entries || []) {
    if (!e || typeof e.name !== 'string') continue
    if (SECRET_KEY_RE.test(e.name)) {
      log?.warn?.(`[config-overrides] BUG: ${kind} "${e.name}" has a name that could name a credential — dropped from the configuration view instead of being published. Rename it or take it out.`)
      continue
    }
    if (HIDDEN_KEYS.has(e.name)) continue
    out.push(e)
  }
  return out
}

/** The runtime half, by its original name. */
export function redactView (entries, opts = {}) {
  return redactEntries(entries, { kind: 'runtime entry', ...opts })
}
