// The one rule every `/daemon/*` route follows to name its caller, so the
// routes cannot drift apart. Pure: no res, no I/O, testable with plain objects.
//
// X-PPT-Daemon is REQUIRED: a custom header a web page cannot send without a
// CORS preflight, and this server never grants one (an OPTIONS request ends in
// 405 without any Access-Control-* header), so no page in a player's browser
// can forge a heartbeat or read a feed. It carries the daemon's version.
//
// X-User is REQUIRED too: a daemon new enough to call these routes always
// sends it, and the POE_USERS[0] fallback of POST /item exists only for
// header-less old triggers — a feed that defaulted to the first user would put
// that user's results on another player's screen.
//
// X-PPT-Instance is a random id per daemon start (no host name), so two
// daemons of one user stay apart. Optional; without it the caller is 'default'.
const TOKEN = /^[A-Za-z0-9._+-]{1,32}$/

/**
 * daemonCaller(req.headers, users) -> { user, version, instance }
 *                                   | { status, body }  (the answer to send)
 * `known` is anything with has()/keys() over the configured user names.
 */
export function daemonCaller (headers, known) {
  const version = String(headers['x-ppt-daemon'] || '').trim()
  const user = String(headers['x-user'] || '').trim()
  const rawInst = String(headers['x-ppt-instance'] || '').trim()
  if (!version) return { status: 400, body: { error: 'missing X-PPT-Daemon header' } }
  if (!user) return { status: 400, body: { error: 'missing X-User header' } }
  if (!known.has(user)) return { status: 400, body: { error: `unknown user "${user}"`, users: [...known.keys()] } }
  return {
    user,
    version: TOKEN.test(version) ? version : 'unknown',
    instance: TOKEN.test(rawInst) ? rawInst : 'default'
  }
}

// The same token rule for POST /item, which reads X-PPT-Instance itself.
export function daemonInstanceOf (raw) {
  const s = String(raw || '').trim()
  return TOKEN.test(s) ? s : 'default'
}
