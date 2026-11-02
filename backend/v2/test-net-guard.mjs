// The instrument behind "local runs and tests must never crawl or price live",
// preloaded by run-tests.mjs into EVERY test process.
//
// WHY IT IS HERE AND NOT IN A TEST FILE. There was already an instrument —
// `server-no-network.test.mjs` — and it did not catch a suite that was sending
// ~55 requests to poe.ninja per run. It could not: it replaces `globalThis.fetch`
// in ITS OWN process, and run-tests.mjs runs one process per file. It was
// measuring the only file that was already quiet, and reporting on all of them.
// A guard that lives inside one of the things it guards is not a guard.
//
// So the runner preloads this into every process it starts, and into every
// process THOSE start (a test that spawns the real server as a child inherits
// NODE_OPTIONS, so the server is watched too).
//
// IT BLOCKS RATHER THAN WATCHING. A recorded-but-forwarded request is still a
// request against somebody else's server, and the whole point of the promise is
// that the request is not sent. Loopback is untouched, because the suite boots
// real servers on 127.0.0.1 and talks to them.
//
// It reports through the EXIT CODE and one line on stderr rather than by
// throwing where it happens: a rejected fetch inside a fire-and-forget warm-up
// is swallowed by design, so failing the assertion at the call site would be a
// failure nobody sees. run-tests.mjs reads the line.
import { appendFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'

// The line run-tests.mjs greps its report out of. Deliberately a literal on
// both sides rather than an export: importing this module has the side effect of
// installing the guard, and the runner is not one of the processes being
// guarded. Changing the wording here means changing the regex there.
const MARK = '[net-guard] outbound blocked:'

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/
const seen = new Set()

function record (url) {
  seen.add(url)
  // Optional shared ledger, so a run can be summarised across processes.
  const log = process.env.PPT_NET_GUARD_LOG
  if (log) { try { appendFileSync(log, url + '\n') } catch { /* never break the run */ } }
}

/** null when this is loopback or unreadable, the origin+path otherwise. */
function outbound (url) {
  try {
    const u = new URL(url)
    return LOOPBACK.test(u.hostname) ? null : u.origin + u.pathname
  } catch { return null }
}

const realFetch = globalThis.fetch
if (realFetch) {
  globalThis.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    const out = outbound(url)
    if (!out) return realFetch.call(this, input, init)
    record(out)
    return Promise.reject(new Error(`outbound request blocked in the test suite: ${out}`))
  }
}

// Not everything goes through fetch, and a guard that only watches fetch would
// have to be re-argued every time a dependency reaches for `http.request`.
for (const [mod, scheme] of [[http, 'http'], [https, 'https']]) {
  const realRequest = mod.request
  const realGet = mod.get
  const check = args => {
    const a = args[0]
    if (typeof a === 'string') return outbound(a)
    if (a instanceof URL) return outbound(a.href)
    if (a && typeof a === 'object') {
      return outbound(`${scheme}://${a.hostname || a.host || 'localhost'}${a.path || '/'}`)
    }
    return null
  }
  mod.request = function (...args) {
    const out = check(args)
    if (out) { record(out); throw new Error(`outbound request blocked in the test suite: ${out}`) }
    return realRequest.apply(this, args)
  }
  mod.get = function (...args) {
    const out = check(args)
    if (out) { record(out); throw new Error(`outbound request blocked in the test suite: ${out}`) }
    return realGet.apply(this, args)
  }
}

process.on('exit', () => {
  if (!seen.size) return
  process.stderr.write(`${MARK} ${[...seen].join(' ')}\n`)
})
