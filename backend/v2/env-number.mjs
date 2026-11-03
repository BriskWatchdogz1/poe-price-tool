// Reading a NUMBER out of the environment — one reader, one rule.
//
// WHY. `Number(process.env.X) || DEFAULT` cannot express ZERO: `Number('0') ||
// 25` is 25, so `POE_CORPSE_BUDGET_PER_HOUR=0` (stop asking the Trade API)
// would give 25 queries an hour and no hint — with two real Trade-API bans
// behind this repository. `''`, `'   '`, `'abc'` and `'-1'` would land on the
// default just as quietly, indistinguishable from "not set"; a value somebody
// typed is worth a report, the absence of one is not. So the reader takes what
// a call site knows: the default, the allowed range, and whether an explicit
// zero is legal HERE — a per-setting question, never a global one
// (`POE_CORPSE_BUDGET_PER_HOUR=0` means "ask nothing";
// `POE_NETWORTH_COOLDOWN_MS=0` removes the backoff a 429 buys and
// `POE_NETWORTH_SYNC_INTERVAL_MS=0` ticks against GGG without pause). The table
// is numeric-settings.mjs; docs/admin.md gives the same answer for operators.
//
// AN UNUSABLE VALUE is reported, loudly, and the DOCUMENTED DEFAULT is used —
// never a hard startup abort, for every setting alike (a rule with exceptions
// is not one an operator can learn):
//   - for the request-volume settings the default is the conservative side,
//     since their ranges are floors (plus one ceiling). NOT IN EVERY CASE: four
//     settings land a refused value on MORE requests than were asked for. Three
//     have their dangerous direction UP and a refused value below the default
//     falls back up to it: POE_CORPSE_BUDGET_PER_HOUR=0.5 (or =none) -> 25
//     Trade-API queries an hour; POE_FAUSTUS_UNION_HOURS=3.5 -> the module
//     default of 8, one hourly CDN digest per unioned hour;
//     POE_MAX_REQUEUE_ON_RECONNECT=-1 (or =none) -> 10 `auto` Trade-API
//     searches per reconnect (a plain 0 is honoured for both). The fourth is a
//     ceiling on a divisor: POE_NETWORTH_IDLE_EVERY=5000 is refused (max 1000)
//     and runs on every 10th tick, more stash reads for idle players than asked
//     for, never more than without game detection. Refusing to start buys no
//     safety over the default; the log line is the half that has to be loud.
//   - the container runs `restart: unless-stopped`: a typo in
//     `docker-compose.override.yml` that killed the boot would restart-loop
//     with no admin area left to undo it, and the environment has no quarantine
//     bracket (config-overrides.mjs has one for the override file).
//   - everything the admin area writes is range-checked first
//     (config-overrides.mjs `validateSetting`), so this path only fires on a
//     hand-written compose value.
// A NEGATIVE VALUE IS NEVER ACCEPTED: no setting has a meaning below zero, so
// `min` starts at 0 and the specs only narrow it. THE LINE IS PRINTED ONCE per
// (variable, value): `POE_MAX_LISTINGS` is read per search, not once at boot.

/** The (variable -> raw value) pairs already complained about. */
const reported = new Map()

/**
 * Bounded and de-fanged for a log line. The value is the operator's own text:
 * it must not be able to smuggle control characters into the log, and a
 * pasted-in essay must not push the reason off the screen.
 */
function quote (raw) {
  const s = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ')
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

/** What is wrong with `n` for this spec, in operator language, or null. */
function refuse (n, spec) {
  const { zero = false, min, max, integer = false } = spec
  if (!Number.isFinite(n)) return 'not a number'
  if (n < 0) return 'negative'
  if (n === 0 && !zero) return 'zero is not a setting here'
  if (integer && !Number.isInteger(n)) return 'not a whole number'
  if (min != null && n < min) return `below the minimum of ${min}`
  if (max != null && n > max) return `above the maximum of ${max}`
  return null
}

/** "whole numbers 1…10", "numbers > 0", "numbers >= 0" — for the log line. */
export function allowedText (spec) {
  const { zero = false, min, max, integer = false } = spec
  const kind = integer ? 'whole numbers' : 'numbers'
  const lo = min != null ? min : (zero ? 0 : null)
  if (lo != null && max != null) return `${kind} ${lo}…${max}`
  if (lo != null) return `${kind} >= ${lo}`
  if (max != null) return `${kind} > 0 and <= ${max}`
  return `${kind} > 0`
}

/**
 * readEnvNumber(spec, { env, log }) -> number | undefined
 *
 * spec = {
 *   name,      the environment variable
 *   fallback,  what unset — and what refused — resolves to. May be `undefined`
 *              when the consuming module carries the default itself.
 *   zero,      is an explicitly set 0 a legal setting for THIS variable?
 *   min, max,  inclusive bounds on top of the sign rule (both optional)
 *   integer,   whole numbers only
 *   hint       one sentence appended to a refusal, e.g. which switch the
 *              operator probably wanted instead
 * }
 *
 * Unset and BLANK both mean "not configured" and fall back in silence.
 * `Number('')` is 0, so reading a blank as a value would be the same trap the
 * other way round: an empty compose line would switch something off that nobody
 * meant to switch off.
 */
export function readEnvNumber (spec, { env = process.env, log = console } = {}) {
  const raw = env == null ? undefined : env[spec.name]
  if (raw == null || String(raw).trim() === '') return spec.fallback
  const n = Number(raw)
  const problem = refuse(n, spec)
  if (problem == null) return n

  const key = String(raw)
  if (reported.get(spec.name) !== key) {
    reported.set(spec.name, key)
    const used = spec.fallback === undefined
      ? 'the built-in default'
      : String(spec.fallback)
    log?.warn?.(
      `[config] ${spec.name}=${quote(raw)} is not a usable value (${problem}; allowed: ` +
      `${allowedText(spec)}) — using ${used} instead.` +
      (spec.hint ? ` ${spec.hint}` : '')
    )
  }
  return spec.fallback
}

/** Forget what has been complained about. Tests only. */
export function resetEnvNumberWarnings () { reported.clear() }

/**
 * createEnvNumbers(specs) -> { get(name, opts), specs }
 *
 * A table of settings plus the reader bound to it, so a call site names a
 * variable and nothing else: the default and the range live in the table and
 * cannot be restated — differently — at the place that reads them. Asking for a
 * name the table does not have is a programming error and says so, rather than
 * quietly resolving to `undefined`.
 */
export function createEnvNumbers (specs) {
  const byName = new Map(specs.map(s => [s.name, Object.freeze({ ...s })]))
  return {
    specs: byName,
    get (name, opts) {
      const spec = byName.get(name)
      if (!spec) {
        throw new Error(`no numeric setting called "${name}" — add it to the table instead of reading it by hand`)
      }
      return readEnvNumber(spec, opts)
    }
  }
}
