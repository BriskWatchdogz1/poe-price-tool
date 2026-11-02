// The numeric half of the configuration: env-number.mjs (the reader) and
// numeric-settings.mjs (the table server.mjs reads through).
//
// The defect under test is `Number(process.env.X) || DEFAULT`, which cannot
// express zero and cannot tell a typo from an unset variable. The two things
// this file has to prove are therefore:
//
//   1. NOTHING MOVED for anybody who sets nothing. Every default is spelled out
//      below as a literal, taken from the code as it stood before the change —
//      not read back out of the table, which would agree with itself no matter
//      what it said.
//   2. A value the tool cannot honour is REPORTED. Silence was the whole bug:
//      POE_CORPSE_BUDGET_PER_HOUR=0 handed back 25 Trade-API queries an hour to
//      an operator who was switching the corpse pricer off, and this project has
//      two real Trade-API bans behind it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvNumber, createEnvNumbers, resetEnvNumberWarnings } from './env-number.mjs'
import { envNum, NUMERIC_SETTINGS, NUMERIC_SETTINGS_BY_NAME } from './numeric-settings.mjs'
import { createCorpseStore } from './networth/corpse-store.mjs'
import { createCorpsePricer } from './networth/corpse-pricer.mjs'
import { guardOptionsFromEnv, GUARD_ARRIVAL_MIN_DIVINE, GUARD_SPECS } from './networth/price-guard.mjs'
import { slowStepMsFromEnv, DEFAULT_SLOW_STEP_MS } from './networth/refresher.mjs'

const HOUR = 60 * 60 * 1000
const silent = { warn () {}, error () {}, log () {} }
/** A log that keeps what it was told, so a test can assert on the line itself. */
function recorder () {
  const lines = []
  return { lines, warn: (...a) => lines.push(a.join(' ')), error () {}, log () {} }
}
/** The environment table of docs/admin.md as variable -> row text. */
function mdRows () {
  const md = readFileSync(fileURLToPath(new URL('../../docs/admin.md', import.meta.url)), 'utf8')
  const rows = new Map()
  for (const line of md.split('\n')) {
    const m = /^\|\s*`(POE_[A-Z0-9_]+|PORT)`\s*\|(.*)$/.exec(line)
    if (m) rows.set(m[1], m[2])
  }
  return rows
}
/** Read `name` out of a throwaway environment, with warnings collected. */
function read (name, value, log = silent) {
  resetEnvNumberWarnings()
  const env = value === undefined ? {} : { [name]: value }
  return envNum(name, { env, log })
}

// ---------------------------------------------------------------------------
// 1. Whoever sets nothing gets exactly what they got before
// ---------------------------------------------------------------------------

// The values as `server.mjs` computed them with `Number(env) || DEFAULT`, typed
// out by hand on purpose. If a future edit changes one of these, this test is
// the thing that has to be argued with.
const DEFAULTS_BEFORE_THE_CHANGE = {
  POE_TRADE_AUDIT_THRESHOLD: 0.8,
  POE_MAX_LISTINGS: 10,
  POE_CD_RATIO: 215,
  POE_CD_REFRESH_MS: 15 * 60 * 1000,
  POE_NETWORTH_SYNC_INTERVAL_MS: 30 * 1000,
  POE_NETWORTH_LIST_TTL_MS: 15 * 60 * 1000,
  POE_NETWORTH_COOLDOWN_MS: 10 * 60 * 1000,
  POE_FAUSTUS_UNION_HOURS: undefined, // -> faustus.mjs's own default (8)
  POE_FAUSTUS_REFRESH_MS: 60 * 60 * 1000,
  POE_FAUSTUS_TTL_MS: 48 * 60 * 60 * 1000,
  POE_CORPSE_TTL_MS: 6 * 60 * 60 * 1000,
  POE_CORPSE_BUDGET_PER_HOUR: 25,
  POE_CORPSE_INTERVAL_MS: 2 * 60 * 1000,
  POE_DATA_REFRESH_MS: 24 * 60 * 60 * 1000,
  POE_DATA_STALE_TICKS: 3,
  POE_GAP_LOG_MAX: 200,
  POE_GAP_LOG_TEXT_MAX: 400,
  POE_UPDATE_HEARTBEAT_MAX_AGE_MS: 20 * 60 * 1000
}

// Settings that came into the table AFTER the idiom was replaced. They have no
// "before", so they are kept apart rather than mixed into the list above, which
// says exactly one thing: this is what `Number(env) || DEFAULT` handed back.
//
// The two shares are the safety margin in the derived stash pace
// (networth/stash-pacer.mjs): the fraction of a limit GGG publishes in its own
// response headers that this tool will spend.
const DEFAULTS_ADDED_SINCE = {
  POE_STASH_IP_BUDGET_SHARE: 0.5,
  POE_STASH_ACCOUNT_BUDGET_SHARE: 0.75
}

// The third row of that derivation, added 2026-08-13, and kept out of the group
// above because it points the other way: the shares say how much of a published
// limit is spent, this says how long a limit is BELIEVED after GGG last
// published it. Its dangerous direction is DOWN — forgetting a rule that still
// counts — so it carries a floor and no ceiling.
const DEFAULTS_ADDED_WITH_THE_RULE_TTL = {
  POE_STASH_RULE_TTL_MS: 6 * 60 * 60 * 1000
}

// The RESOLUTION of GGG's windows, added 2026-08-13 with the same pass: the size
// of the buckets it sums requests in, which is in no header at all and comes
// from GGG's support ("that particular policy has a resolution of 5 seconds").
// Both are their own floor — they may lengthen a wait and never shorten one.
const DEFAULTS_ADDED_WITH_THE_BUCKETS = {
  POE_STASH_BUCKET_SHORT_SEC: 5,
  POE_STASH_BUCKET_LONG_SEC: 60
}

// The seven that were on `positiveEnvInt = (raw, fallback) =>
// Math.max(1, Number(raw) || fallback)` further down server.mjs until
// 2026-08-11 (docs/bugs.md B13). Same rule as the list above and for the same
// reason: these numbers are typed out by hand from the call sites as they
// stood, NOT read back out of the table they are checking.
const DEFAULTS_BEFORE_THE_SECOND_PASS = {
  POE_MAX_ITEMS_PER_ROOM: 50,
  POE_MAX_REQUEUE_ON_RECONNECT: 10,
  POE_RATE_LIMIT_BANNER_MIN_SEC: 60,
  POE_ASK_CONFLICT_RATIO: 4,
  POE_ASK_CONFLICT_ABS_GAP_C: 5,
  POE_MIN_ASK_EVIDENCE: 5,
  POE_MIN_CONFLICT_HEADLINE_C: 1
}
// The coverage bar of the localized data generator, added 2026-08-18 with
// docs/bugs.md B23. It was a default PARAMETER of validate() — 0.01, settable
// from nowhere but a hand written call. The fraction does not move by coming
// into the table: what B23 changed is the population it is measured against.
const DEFAULTS_ADDED_WITH_THE_COVERAGE_BAR = {
  POE_LANG_MAX_COVERAGE_LOSS_RATIO: 0.01
}
// How much of a failure REASON a data source's status line carries, added
// 2026-08-18 with docs/bugs.md B24. There was no value before it: the reason was
// not persisted at all, so the note said how long a source had been quiet and
// nothing about why.
const DEFAULTS_ADDED_WITH_THE_FAILURE_REASON = {
  POE_DATA_STATUS_REASON_MAX: 300,
  POE_DATA_CHECK_NOW_COOLDOWN_MS: 5 * 60 * 1000
}

// The three that were read by hand next to the table (docs/bugs.md B13 follow-up):
// the stash request timeout (`Number(env) || 30000`), the language skew warning
// bar and the listening port.
const DEFAULTS_ADDED_FROM_HAND_ROLLED_READS = {
  POE_STASH_TIMEOUT_MS: 30000,
  POE_LANG_SKEW_WARN_RATIO: 0.005,
  PORT: 8788
}

const ALL_DEFAULTS = {
  ...DEFAULTS_BEFORE_THE_CHANGE,
  ...DEFAULTS_ADDED_SINCE,
  ...DEFAULTS_ADDED_WITH_THE_RULE_TTL,
  ...DEFAULTS_ADDED_WITH_THE_BUCKETS,
  ...DEFAULTS_ADDED_WITH_THE_COVERAGE_BAR,
  ...DEFAULTS_ADDED_WITH_THE_FAILURE_REASON,
  ...DEFAULTS_BEFORE_THE_SECOND_PASS,
  ...DEFAULTS_ADDED_FROM_HAND_ROLLED_READS
}

test('an empty environment resolves to exactly the documented defaults', () => {
  for (const [name, expected] of Object.entries(ALL_DEFAULTS)) {
    assert.equal(envNum(name, { env: {}, log: silent }), expected, `${name} changed its default`)
  }
})

test('the table covers every numeric setting of the config block, and nothing else', () => {
  assert.deepEqual(
    [...NUMERIC_SETTINGS_BY_NAME.keys()].sort(),
    Object.keys(ALL_DEFAULTS).sort()
  )
  assert.equal(NUMERIC_SETTINGS.length, 36,
    'eighteen call sites of the idiom, two stash budget shares, the seven ' +
    'positiveEnvInt sites converted on 2026-08-11, the stash rule TTL ' +
    'plus the two window resolutions added on 2026-08-13, and the localized ' +
    'coverage bar plus the status-line reason cap added on 2026-08-18, and the ' +
    'cooldown of the manual data check added with it, and the stash timeout, ' +
    'the language skew bar and PORT that used to be read by hand')
})

test('the coverage bar honours a 0 and refuses a share that is not one', () => {
  const name = 'POE_LANG_MAX_COVERAGE_LOSS_RATIO'
  // Zero is the STRICTEST setting here, not an off switch: "not one stat that
  // has a German matcher today may lose it". A reader that could not express it
  // would silently hand back the 1 % default, which is the defect env-number.mjs
  // exists to end.
  assert.equal(read(name, '0'), 0)
  assert.equal(read(name, '0.05'), 0.05)
  // Above 1 it is not a share of the baseline any more.
  assert.equal(read(name, '2'), 0.01, 'a value that is not a share falls back to the default')
  assert.equal(read(name, '-0.1'), 0.01)
})

test('PORT=0 is a legal port (random), the other two hand-rolled reads have their ranges', () => {
  // PORT=0 is how the test suite binds a free port instead of the real 8788.
  assert.equal(read('PORT', '0'), 0)
  assert.equal(read('PORT', '9000'), 9000)
  assert.equal(read('PORT', '65536'), 8788)
  assert.equal(read('PORT', 'abc'), 8788)
  assert.equal(read('PORT', '80.5'), 8788)
  // The skew bar: 0 means "warn on any gap"; above 1 is not a fraction.
  assert.equal(read('POE_LANG_SKEW_WARN_RATIO', '0'), 0)
  assert.equal(read('POE_LANG_SKEW_WARN_RATIO', '0.02'), 0.02)
  assert.equal(read('POE_LANG_SKEW_WARN_RATIO', '2'), 0.005)
  // The stash timeout: 0 would abort every request before it can answer.
  assert.equal(read('POE_STASH_TIMEOUT_MS', '0'), 30000)
  assert.equal(read('POE_STASH_TIMEOUT_MS', '999'), 30000)
  assert.equal(read('POE_STASH_TIMEOUT_MS', '45000'), 45000)
})

test('the seven late converts hand back exactly what positiveEnvInt did', () => {
  // The whole risk of B13's conversion is that a default moves while nobody is
  // looking. `Math.max(1, Number(undefined) || d)` is `d` for every one of
  // these, so unset must resolve to the literal above — and a plainly usable
  // value must still be used, which is the other half of "nothing moved".
  for (const [name, expected] of Object.entries(DEFAULTS_BEFORE_THE_SECOND_PASS)) {
    assert.equal(read(name), expected, `${name} changed its default`)
    assert.equal(read(name, '7'), 7, `${name} stopped honouring an ordinary value`)
  }
})

test('the two stash shares are bounded upwards, and have no floor to fall back UP to', () => {
  // Their dangerous direction is UP: a bigger share is a faster pace. So a
  // ceiling of 1 (never claim more than GGG publishes) and deliberately no
  // `min` — a refused value falls back to the DEFAULT (env-number.mjs), and
  // with a floor that fallback would be the direction that sends more.
  for (const name of Object.keys(DEFAULTS_ADDED_SINCE)) {
    const spec = NUMERIC_SETTINGS_BY_NAME.get(name)
    assert.equal(spec.max, 1, `${name}: a share above the published limit is not a share`)
    assert.equal(spec.min, undefined, `${name}: a floor here would make a refusal send MORE`)
    assert.equal(read(name, '2'), DEFAULTS_ADDED_SINCE[name], 'above 1 falls back to the default')
    assert.equal(read(name, '0.25'), 0.25, 'a tighter share is a usable value')
  }
})

test('blank and whitespace mean UNSET, and say nothing about it', () => {
  const log = recorder()
  for (const blank of ['', '   ', '\t']) {
    assert.equal(read('POE_CORPSE_INTERVAL_MS', blank, log), 2 * 60 * 1000)
  }
  assert.deepEqual(log.lines, [], 'an unset variable is not a mistake and must not be reported')
})

// ---------------------------------------------------------------------------
// 2. Zero, per setting
// ---------------------------------------------------------------------------

test('the settings that accept a literal 0 accept it and hand it back', () => {
  assert.equal(read('POE_CORPSE_BUDGET_PER_HOUR', '0'), 0, 'ask the Trade API for nothing')
  assert.equal(read('POE_TRADE_AUDIT_THRESHOLD', '0'), 0, 'report every rate-limit window')
  // Five of the seven late converts (B13). The first is the one that used to
  // cost requests: a re-queued card is an `auto` Trade-API search, so a 0 that
  // came back as 10 was ten searches per reconnect nobody asked for.
  assert.equal(read('POE_MAX_REQUEUE_ON_RECONNECT', '0'), 0, 're-queue nothing on a reconnect')
  assert.equal(read('POE_RATE_LIMIT_BANNER_MIN_SEC', '0'), 0, 'banner every rate-limit wait')
  assert.equal(read('POE_ASK_CONFLICT_ABS_GAP_C', '0'), 0, 'the ratio alone decides')
  assert.equal(read('POE_MIN_ASK_EVIDENCE', '0'), 0, 'no minimum listing count')
  assert.equal(read('POE_MIN_CONFLICT_HEADLINE_C', '0'), 0, 'mark sub-chaos headlines too')
  // The two readers that live with their own module go through the same rule.
  assert.equal(slowStepMsFromEnv({ POE_NETWORTH_SLOW_STEP_MS: '0' }), 0)
  assert.equal(guardOptionsFromEnv({ POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE: '0' }).arrivalMinDivine, 0)
})

test('a 0 that would be dangerous or meaningless is refused, loudly, for the default', () => {
  // Refused, every one of them — and not because zero is wrong in general, but
  // because of what it would do HERE: a loop with no pause against GGG or
  // poe.ninja, a cache that never holds anything, a backoff of no length.
  const refuseZero = [
    'POE_MAX_LISTINGS', 'POE_CD_RATIO', 'POE_CD_REFRESH_MS',
    'POE_NETWORTH_SYNC_INTERVAL_MS', 'POE_NETWORTH_LIST_TTL_MS', 'POE_NETWORTH_COOLDOWN_MS',
    'POE_FAUSTUS_UNION_HOURS', 'POE_FAUSTUS_REFRESH_MS', 'POE_FAUSTUS_TTL_MS',
    'POE_CORPSE_TTL_MS', 'POE_CORPSE_INTERVAL_MS',
    'POE_DATA_REFRESH_MS', 'POE_DATA_STALE_TICKS',
    'POE_GAP_LOG_MAX', 'POE_GAP_LOG_TEXT_MAX', 'POE_UPDATE_HEARTBEAT_MAX_AGE_MS',
    // A share of 0 is an infinite spacing, i.e. a refresher that never sends.
    // POE_NETWORTH_AUTOSYNC=0 stops the ticking as well and is the off switch.
    'POE_STASH_IP_BUDGET_SHARE', 'POE_STASH_ACCOUNT_BUDGET_SHARE',
    // The two of the seven late converts with no sensible zero: a room that
    // evicts every card as fast as it is created, and a conflict ratio that
    // marks every card there is.
    'POE_MAX_ITEMS_PER_ROOM', 'POE_ASK_CONFLICT_RATIO'
  ]
  for (const name of refuseZero) {
    const log = recorder()
    assert.equal(read(name, '0', log), ALL_DEFAULTS[name], `${name} honoured a 0 it should refuse`)
    assert.equal(log.lines.length, 1, `${name} refused a 0 without saying so`)
    assert.match(log.lines[0], new RegExp(`${name}=0`), `${name}'s line does not name the value`)
  }
})

test('a refusal names the variable, the value, the reason and what is used instead', () => {
  const log = recorder()
  read('POE_NETWORTH_COOLDOWN_MS', '0', log)
  const line = log.lines[0]
  assert.match(line, /POE_NETWORTH_COOLDOWN_MS=0/)
  assert.match(line, /zero is not a setting here/)
  assert.match(line, /600000/, 'the value actually used has to be in the line')
})

test('a refusal points at the switch that does what the operator meant', () => {
  const log = recorder()
  read('POE_CORPSE_INTERVAL_MS', '0', log)
  assert.match(log.lines[0], /POE_CORPSE_DISABLED=1/)
  assert.match(log.lines[0], /POE_CORPSE_BUDGET_PER_HOUR=0/)
})

// ---------------------------------------------------------------------------
// 3. The other silent swallowers of the same idiom
// ---------------------------------------------------------------------------

test('gibberish and negatives fall back AND are reported', () => {
  for (const bad of ['abc', '-1', 'NaN', '1e', '  seven  ']) {
    const log = recorder()
    assert.equal(read('POE_CORPSE_TTL_MS', bad, log), 6 * HOUR, `"${bad}" did not fall back`)
    assert.equal(log.lines.length, 1, `"${bad}" fell back in silence`)
  }
})

test('the two readers that live with their own module report the same way', () => {
  resetEnvNumberWarnings()
  const a = recorder()
  assert.equal(slowStepMsFromEnv({ POE_NETWORTH_SLOW_STEP_MS: 'soon' }, { log: a }), DEFAULT_SLOW_STEP_MS)
  assert.equal(a.lines.length, 1)
  resetEnvNumberWarnings()
  const b = recorder()
  assert.equal(
    guardOptionsFromEnv({ POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE: '-5' }, { log: b }).arrivalMinDivine,
    GUARD_ARRIVAL_MIN_DIVINE
  )
  assert.equal(b.lines.length, 1)
})

test('a range is enforced instead of silently clamped', () => {
  // `Math.min(10, Number(env) || 10)` clamped 11 down to 10 without a word AND
  // let a negative through untouched: POE_MAX_LISTINGS=-5 really did ask the
  // trade fetch for -5 ids.
  assert.equal(read('POE_MAX_LISTINGS', '7'), 7)
  assert.equal(read('POE_MAX_LISTINGS', '11'), 10)
  assert.equal(read('POE_MAX_LISTINGS', '-5'), 10)
  assert.equal(read('POE_MAX_LISTINGS', '2.5'), 10, 'a fraction of a listing is not a thing')
  // The three that used to be written as Math.max(…) clamps.
  assert.equal(read('POE_DATA_STALE_TICKS', '0.5'), 3)
  assert.equal(read('POE_GAP_LOG_TEXT_MAX', '10'), 400)
  assert.equal(read('POE_UPDATE_HEARTBEAT_MAX_AGE_MS', '1000'), 20 * 60 * 1000)
})

test('the seven late converts: what each of them refuses, and why it is that one', () => {
  // `Math.max(1, Number(raw) || fallback)` accepted every one of these and said
  // nothing. Counts are whole numbers now; the two thresholds measured in chaos
  // are NOT, because a half-chaos gap is a real quantity.
  assert.equal(read('POE_MAX_ITEMS_PER_ROOM', '2.5'), 50, 'half a card is not a room size')
  assert.equal(read('POE_MAX_REQUEUE_ON_RECONNECT', '1.5'), 10, 'half a re-queued card is not a thing')
  assert.equal(read('POE_MIN_ASK_EVIDENCE', '2.5'), 5, 'listings are counted, not measured')
  assert.equal(read('POE_RATE_LIMIT_BANNER_MIN_SEC', '0.5'), 60, 'Retry-After is whole seconds')
  assert.equal(read('POE_ASK_CONFLICT_ABS_GAP_C', '2.5'), 2.5, 'a chaos gap may be fractional')
  assert.equal(read('POE_MIN_CONFLICT_HEADLINE_C', '0.5'), 0.5, 'so may a sub-chaos floor')
  assert.equal(read('POE_ASK_CONFLICT_RATIO', '2.5'), 2.5, 'and so may the ratio')
  // Below 1 the ratio stops meaning "these two contradict each other": it
  // fires when the headline is merely NEAR the asks.
  assert.equal(read('POE_ASK_CONFLICT_RATIO', '0.5'), 4)
  assert.equal(read('POE_MAX_ITEMS_PER_ROOM', '-5'), 50, 'a negative cap emptied every room')
})

test('a refusal falls back to the DEFAULT, not to the nearest allowed value', () => {
  // The direction is always "fewer requests", but the step is not the small one
  // a range check suggests, and an operator does not expect it. docs/admin.md
  // says so now; this is what it says it against.
  assert.equal(read('POE_CORPSE_TTL_MS', String(30 * 60 * 1000)), 6 * HOUR, 'not the 1h minimum')
  assert.equal(read('POE_CORPSE_BUDGET_PER_HOUR', '50'), 25, 'not the ceiling of 30')
  assert.equal(read('POE_NETWORTH_SYNC_INTERVAL_MS', '20000'), 30 * 1000)
})

test('the two settings where falling back means MORE traffic than was asked for', () => {
  // env-number.mjs used to promise that "every fallback here IS the
  // conservative value". It is the documented DEFAULT, which is the same thing
  // only where the range is a floor — i.e. everywhere the refused values are
  // the faster ones. These two have their dangerous direction UP, so a refused
  // value below the default falls back up to it. The log line is the whole of
  // the protection, so it is asserted here rather than assumed.
  for (const [name, bad, used] of [
    ['POE_CORPSE_BUDGET_PER_HOUR', '0.5', 25],          // 25 Trade-API queries an hour
    ['POE_CORPSE_BUDGET_PER_HOUR', 'none', 25],
    ['POE_FAUSTUS_UNION_HOURS', '3.5', undefined],      // -> faustus.mjs's own 8, one CDN file per hour
    // The third member of that class since B13: a re-queued card is an `auto`
    // Trade-API search, so a typo here hands back ten of them per reconnect.
    // The plain 0 above is honoured, exactly like the corpse budget's.
    ['POE_MAX_REQUEUE_ON_RECONNECT', 'none', 10],
    ['POE_MAX_REQUEUE_ON_RECONNECT', '-1', 10]
  ]) {
    const log = recorder()
    assert.equal(read(name, bad, log), used, `${name}=${bad} did not fall back to the default`)
    assert.equal(log.lines.length, 1, `${name}=${bad} fell back in silence`)
  }
  // The off switch itself is not one of them: a plain 0 is honoured and really
  // does query nothing (the test at the bottom of this file proves that half).
  assert.equal(read('POE_CORPSE_BUDGET_PER_HOUR', '0'), 0)
})

test('docs/admin.md says what a 0 means for every setting read through the shared reader', () => {
  // The pass that introduced the per-setting zero claimed every numeric row
  // states it. It did — except for the four guard bars, which are read by
  // guardOptionsFromEnv rather than out of the table and were missed.
  const md = mdRows()
  const names = [...NUMERIC_SETTINGS_BY_NAME.keys(), ...GUARD_SPECS.map(([, spec]) => spec.name)]
  for (const name of names) {
    const row = md.get(name)
    assert.ok(row, `${name} has no row in docs/admin.md`)
    assert.match(row, /`0`/, `${name}'s row does not say what a 0 means`)
  }
})

test('a usable value is used, and is not talked about', () => {
  const log = recorder()
  assert.equal(read('POE_CORPSE_BUDGET_PER_HOUR', '5', log), 5)
  assert.equal(read('POE_TRADE_AUDIT_THRESHOLD', '0.95', log), 0.95)
  assert.equal(read('POE_FAUSTUS_UNION_HOURS', '3', log), 3)
  assert.deepEqual(log.lines, [])
})

test('the same bad value is reported once, however often it is read', () => {
  // POE_MAX_LISTINGS is read per search (it is a `live` setting), so a line per
  // read would be a line per priced item.
  resetEnvNumberWarnings()
  const log = recorder()
  const env = { POE_MAX_LISTINGS: '0' }
  for (let i = 0; i < 25; i++) envNum('POE_MAX_LISTINGS', { env, log })
  assert.equal(log.lines.length, 1)
  // A DIFFERENT bad value is a different mistake and is worth its own line.
  env.POE_MAX_LISTINGS = '99'
  envNum('POE_MAX_LISTINGS', { env, log })
  assert.equal(log.lines.length, 2)
})

test('reading a name the table does not have is a programming error, not undefined', () => {
  assert.throws(() => envNum('POE_NOT_A_SETTING', { env: {} }), /not a numeric setting|no numeric setting/)
})

test('the reader takes its spec as given — nothing about a variable is hard-coded in it', () => {
  const table = createEnvNumbers([{ name: 'X', fallback: 7, zero: true, max: 9 }])
  assert.equal(table.get('X', { env: { X: '0' }, log: silent }), 0)
  assert.equal(table.get('X', { env: { X: '10' }, log: silent }), 7)
  assert.equal(readEnvNumber({ name: 'X', fallback: 7, zero: false }, { env: { X: '0' }, log: silent }), 7)
})

test('a refusal cannot smuggle control characters or an essay into the log', () => {
  resetEnvNumberWarnings()
  const log = recorder()
  read('POE_CD_RATIO', `2\n[config] 15${'x'.repeat(200)}`, log)
  assert.equal(log.lines.length, 1, 'a newline must not become a second log line')
  assert.ok(!log.lines[0].includes('\n'))
  assert.ok(log.lines[0].length < 300, 'the reason has to stay visible next to the value')
})

// ---------------------------------------------------------------------------
// 4. The assurance the whole change is for
// ---------------------------------------------------------------------------

test('POE_CORPSE_BUDGET_PER_HOUR=0 really does query nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-budget0-'))
  try {
    const store = createCorpseStore(join(dir, 'corpse.json'), { ttlMs: 6 * HOUR })
    await store.load()
    const queried = []
    const trade = {
      isCircuitOpen: () => false,
      async searchListings (name) { queried.push(name); return [{ priceAmount: 3, priceCurrency: 'chaos' }] }
    }
    // The environment as an operator would write it to stop the pricer.
    const budget = envNum('POE_CORPSE_BUDGET_PER_HOUR', {
      env: { POE_CORPSE_BUDGET_PER_HOUR: '0' }, log: silent
    })
    assert.equal(budget, 0, 'the setting did not survive being read')

    const pricer = createCorpsePricer({
      store,
      tradeClient: trade,
      league: 'Standard',
      getCorpseNames: () => ['Forest Tiger', 'Pain Artist', 'Chimeral'],
      chaosPerDivine: () => 200,
      enqueueBackground: async fn => fn(),
      budgetPerHour: budget,
      log: silent
    })
    for (let i = 0; i < 10; i++) await pricer.tickOnce()
    assert.deepEqual(queried, [], 'a budget of 0 still sent a Trade-API search')
    assert.equal(pricer.budgetLeft(), 0)

    // …and the old idiom is what it is being contrasted with: the same "0" read
    // as `Number(env) || 25` would have priced all three names instead.
    const wrong = Number('0') || 25
    assert.equal(wrong, 25, 'the trap this test exists for')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
