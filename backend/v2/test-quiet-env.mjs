// The full set of switches that keeps a booted server off the network.
//
// WHY IT IS ONE LIST AND NOT A PARAGRAPH IN CONTRIBUTING.md. The rule was
// written down ("local runs and tests must never crawl or price live") and every
// test file that boots the server implemented it by hand, from memory, at the
// top of the file. The result on 2026-08-18: a suite run sent ~55 requests to
// poe.ninja from eleven different files, each of which had SOME of these set and
// none of which had all of them. Nothing went to GGG.
//
// The one that was missing everywhere is the interesting one:
// `POE_REFERENCE_DISABLED` covers the warm-up at BOOT, and
// `POE_REFERENCE_ON_CONNECT_DISABLED` covers `warmLeague()`, which runs when a
// WebSocket connects with no warm C:D cache for its league. Every browser test
// opens a socket. A file that set the first and not the second looked complete
// and was not (docs/bugs.md B12, and B25 for the second round of it).
//
// A list that is imported cannot be half-remembered. Two shapes, because the
// suite boots the server two ways:
//
//   quietEnv()   in-process — call it BEFORE `await import('./server.mjs')`,
//                which reads the environment at module load.
//   QUIET_ENV    spread into the `env` of a `spawn(node, [server.mjs])`.
//                Spread FIRST, so a file that deliberately turns one of these
//                back on (reference-rail-*: Faustus on, with a stubbed fetch)
//                still wins.
export const QUIET_ENV = Object.freeze({
  // The background schedules (the four trade/data ones, and the release check).
  POE_FAUSTUS_DISABLED: '1',
  POE_CORPSE_DISABLED: '1',
  POE_DATA_REFRESH_DISABLED: '1',
  POE_REFERENCE_DISABLED: '1',
  // The once-a-day look at GitHub for a newer release (release-check.mjs).
  POE_RELEASE_CHECK_DISABLED: '1',
  // The stash sync, which is a schedule of its own with its own switch.
  POE_NETWORTH_AUTOSYNC: '0',
  // The foreground price check: a pasted item produces a card and no request.
  POE_PRICE_CHECK_DISABLED: '1',
  // The one a WebSocket triggers. This is the one that keeps being forgotten.
  POE_REFERENCE_ON_CONNECT_DISABLED: '1',
  // And the one that is not a schedule, a warm-up or a price check at all: the
  // league dropdown asks `GET /leagues` on every page load, so it only shows up
  // in the browser-driven tests — which is exactly why it outlived the round of
  // switches that was supposed to end this (server.mjs, LEAGUE_LIST_DISABLED).
  POE_LEAGUE_LIST_DISABLED: '1'
})

/** Apply the set to an environment (default: this process's). Returns it. */
export function quietEnv (env = process.env) {
  for (const [k, v] of Object.entries(QUIET_ENV)) env[k] = v
  return env
}
