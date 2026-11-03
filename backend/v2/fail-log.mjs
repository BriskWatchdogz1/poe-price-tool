// One log line when something starts failing, one when it works again, and in
// between at most one line per interval — per KEY (one poe.ninja type in one
// league, say).
//
// WHY A MODULE FOR THREE LOG LINES. The two answers that existed before were
// both wrong, in opposite directions. ninja.mjs warned about a network error
// ONCE PER PROCESS for each key and then never again — so the log could not say
// whether poe.ninja had been down for a minute or for a week, and it never said
// when it came back. And every non-ok answer was logged EVERY time, which is a
// line per retired type every 15 minutes for as long as the process runs. What
// an operator reading the log needs is the state change: started, still going
// (with how long and how often), over (docs/bugs.md B29).
//
// Pure: no environment, no network, no timer. The interval and the clock are
// handed in, so the rule is testable and the number has one home
// (numeric-settings.mjs, POE_NINJA_FAIL_LOG_MS).

/**
 * A short human duration for a log line: minutes under an hour, hours under
 * two days, days beyond. Rounded DOWN above an hour, so "1 h" never means 59 min.
 */
export function fmtDuration (ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n < 60 * 60 * 1000) return `${Math.max(1, Math.round(n / 60000))} min`
  if (n < 48 * 60 * 60 * 1000) return `${Math.floor(n / 3600000)} h`
  return `${Math.floor(n / 86400000)} d`
}

/**
 * createFailureLog({ prefix, everyMs, now, log }) -> { fail(key, subject, reason), ok(key, subject) }
 *
 *   everyMs   how often a key that KEEPS failing is mentioned again. 0 means
 *             every failed attempt gets its line.
 */
export function createFailureLog ({ prefix, everyMs, now = Date.now, log = console } = {}) {
  const state = new Map() // key -> { since, lastLoggedAt, attempts }
  const every = Number.isFinite(everyMs) && everyMs >= 0 ? everyMs : 0

  function fail (key, subject, reason) {
    const t = now()
    const s = state.get(key)
    if (!s) {
      state.set(key, { since: t, lastLoggedAt: t, attempts: 1 })
      log.warn?.(`${prefix} ${subject} failing: ${reason}`)
      return
    }
    s.attempts++
    if (every === 0 || t - s.lastLoggedAt >= every) {
      s.lastLoggedAt = t
      log.warn?.(`${prefix} ${subject} still failing after ${fmtDuration(t - s.since)} (${s.attempts} attempts): ${reason}`)
    }
  }

  function ok (key, subject) {
    const s = state.get(key)
    if (!s) return
    state.delete(key)
    log.warn?.(`${prefix} ${subject} recovered after ${fmtDuration(now() - s.since)} (${s.attempts} failed attempts)`)
  }

  return { fail, ok }
}
