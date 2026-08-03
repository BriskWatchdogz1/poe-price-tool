// backend/v2/log-timestamps.mjs
// ONE central place that puts a timestamp on every console line.
//
// Why central: the backend logs from ~everywhere (server.mjs, networth/*,
// data-refresher.mjs) and most of those modules take an injected
// `log = console`. Sweeping hundreds of call sites would drift the moment
// someone adds a line; patching the console object once catches all of them,
// including the ones inside the bundled engine.
//
// Why it matters: without a clock, a log tells you the ORDER of events but not
// WHEN they happened — so a rate-limit banner cannot be matched against the
// requests that caused it, and you cannot tell a fresh limit from the tail of
// an older window. That was the exact blind spot in the incident this module
// was written for.
//
// Format: `2026-07-31T14:03:21Z ` — ISO-8601, second resolution, UTC (the
// container has no meaningful local zone), lexically sortable, 21 characters.
// The message itself is untouched: the prefix is glued onto the FIRST argument
// only when that is a string, so printf-style formats (`'%s took %dms'`) keep
// working and substring assertions in the tests still match.

const PATCHED_METHODS = ['log', 'info', 'warn', 'error', 'debug']
const MARK = Symbol.for('poe-price-tool.log-timestamps')

// Date -> '2026-07-31T14:03:21Z' (drop the milliseconds, keep it sortable).
export function timestamp (ms = Date.now()) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Prefix every console line with a timestamp. Idempotent (a second call is a
 * no-op) and reversible — returns an uninstall function, which the tests use
 * to restore the plain console.
 *
 * `target` defaults to the global console; `now` is injectable so a test can
 * assert an exact line instead of racing the clock.
 */
export function installLogTimestamps ({ target = console, now = () => Date.now() } = {}) {
  if (target[MARK]) return target[MARK]
  const originals = {}
  for (const name of PATCHED_METHODS) {
    const orig = target[name]
    if (typeof orig !== 'function') continue
    originals[name] = orig
    target[name] = (...args) => {
      const stamp = timestamp(now())
      // String first argument -> prefix in place (keeps %s/%d formatting
      // intact). Anything else (object, Error, no args) -> own leading arg.
      if (typeof args[0] === 'string') orig.call(target, `${stamp} ${args[0]}`, ...args.slice(1))
      else orig.call(target, stamp, ...args)
    }
  }
  const uninstall = () => {
    for (const [name, orig] of Object.entries(originals)) target[name] = orig
    delete target[MARK]
  }
  target[MARK] = uninstall
  return uninstall
}
