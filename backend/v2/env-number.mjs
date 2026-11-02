// Reading a NUMBER out of the environment — one reader, one rule.
//
// THE DEFECT THIS REPLACES. `Number(process.env.X) || DEFAULT` is the shortest
// way to read a numeric setting and it cannot express ZERO: `Number('0') || 25`
// is 25. An operator who sets `POE_CORPSE_BUDGET_PER_HOUR=0` to stop the corpse
// pricer from asking the Trade API for anything got 25 queries an hour and no
// hint that the setting had done nothing at all. This repository has two real
// Trade-API bans behind it, so "the off switch silently did not switch
// anything" is not a cosmetic bug here.
//
// Zero is only the loudest case. `''`, `'   '`, `'abc'` and `'-1'` land on the
// default just as quietly, and afterwards none of them can be told apart from
// "not set". A value somebody deliberately typed and the absence of a value are
// two different situations, and only one of them is worth being quiet about.
//
// WHAT REPLACES IT: one reader with the three things a call site actually
// knows — the default, the allowed range, and whether an explicit zero is a
// legal setting HERE. Zero is a per-setting question and never a global one:
// `POE_CORPSE_BUDGET_PER_HOUR=0` means "ask nothing", which is exactly what an
// operator must be able to say, while `POE_NETWORTH_COOLDOWN_MS=0` removes the
// backoff a 429 buys us and `POE_NETWORTH_SYNC_INTERVAL_MS=0` ticks against GGG
// without pause. So every setting says which it is; see numeric-settings.mjs
// for the table, and docs/admin.md for the same answer in operator language.
//
// WHAT AN UNUSABLE VALUE DOES: it is reported, loudly, and the DEFAULT is used.
// Not a hard startup abort — and that is a decision, held to for every setting:
//   - every fallback here is the DOCUMENTED DEFAULT, and for the settings that
//     decide request volume that is also the conservative direction, because
//     their ranges are floors (plus one ceiling): the values they refuse are
//     the ones that would send MORE than the default does.
//     IT IS NOT THE SAFER NUMBER IN EVERY CASE, and the exceptions are the two
//     settings whose dangerous direction is UP, where a refused value BELOW the
//     default falls back up to it:
//       POE_CORPSE_BUDGET_PER_HOUR=0.5 (or =none) -> 25 Trade-API queries an
//         hour, more than was asked for. A plain 0 is honoured, so the off
//         switch itself is safe; it is the typo next to it that is not.
//       POE_FAUSTUS_UNION_HOURS=3.5 -> the module default of 8, and a pass
//         fetches one hourly CDN digest per unioned hour, so the fallback more
//         than doubles the files an operator reaching for three was after.
//     Refusing to start over either of them buys no safety over starting on the
//     default; it only removes the tool. What it does buy is the log line, and
//     that is the half that has to be loud.
//   - the container runs `restart: unless-stopped`, and the only way to correct
//     a setting from the browser is a server that listens. A typo in
//     `docker-compose.override.yml` that killed the boot would restart-loop
//     with no admin area left to undo it — the exact lockout
//     config-overrides.mjs argues about at length for the override file, except
//     that the environment has no quarantine bracket around it at all.
//   - everything the admin area can write is range-checked before it ever
//     reaches the environment (config-overrides.mjs `validateSetting`), so this
//     path only ever fires on a hand-written compose value.
// The rule is the same for every setting on purpose. A rule with exceptions is
// not one an operator can learn, and this defect was found by an operator who
// had learnt the wrong one.
//
// A NEGATIVE VALUE IS NEVER ACCEPTED. Not one setting in this tool has a
// meaning below zero — a negative interval, budget, cap or threshold is a typo
// every time — so `min` starts at 0 and the specs only ever narrow it.
//
// THE LINE IS PRINTED ONCE per (variable, value). `POE_MAX_LISTINGS` is read
// per search rather than once at boot, so an unusable value would otherwise
// write a log line per priced item and bury the rest of the log.

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
