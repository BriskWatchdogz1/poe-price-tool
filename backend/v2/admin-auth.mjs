// The partition in front of the admin view — deliberately a partition, not a
// lock.
//
// This tool has no authentication and is not getting one (design doc,
// "Nicht-Ziele"): identity is a freely settable cookie, the LAN is trusted, and
// every secret in /config is plaintext already (the POESESSID next door in
// networth-users.json). What the admin view needs is therefore not security but
// a wall: the ordinary user must not wander into a page of parser diagnostics
// that is none of his business, and whoever runs the box must get in without
// ceremony.
//
// So: one plaintext password in one file, default `admin`, editable by anyone
// with server access. `docs/admin.md` carries the matching warning — the
// default is public in this repository, so it has to change before the tool is
// ever reachable beyond the home network.
//
// WHAT IT GUARDS GREW, AND THE WARNING GREW WITH IT. This started as the wall
// in front of a read-only diagnostic view. The same password now also ends the
// process (POST /restart) and writes the configuration file that the next start
// reads (POST /config-override). The trust model is unchanged and stays
// unchanged — LAN, no authentication, one password — but "the default is still
// in force" is not a small thing to leave unsaid. `usingDefault()` below
// is what the server says it with: one loud line at startup, and a notice in
// the admin area itself. Deliberately NOT a forced password change: locking an
// operator out of his own box on a LAN tool is the worse failure, and the
// warning is not a substitute for a decision he is allowed to make.
//
// THE STATE MODEL IS THE PART THAT HAD TO BE DECIDED, and it is: there is none.
// No session store, no expiry, no token. Every admin request carries the
// password in a header, and every admin request is checked against the file
// again. The page keeps the value in `sessionStorage`, so the "logged in" state
// ends with the browser tab and nothing at all accumulates on the server.
//
// Two consequences worth naming rather than discovering later:
//   - Editing the password file takes effect on the NEXT request. There is no
//     cache to invalidate and no restart to schedule.
//   - The comparison is a plain string compare. A timing-safe one would be
//     theatre here: the value it protects is readable from the same filesystem
//     the attacker would need access to anyway.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

// The header the page sends. Lowercase because Node lowercases every incoming
// header name; comparing against anything else silently never matches.
export const ADMIN_PASSWORD_HEADER = 'x-admin-password'

// The documented default. Not a fallback nobody thought about — it is what a
// fresh install answers with, so the operator can get in before he has read
// anything.
export const DEFAULT_ADMIN_PASSWORD = 'admin'

export const ADMIN_PASSWORD_FILE_DEFAULT = '/config/admin-password'

// Why a request was refused. Distinguishing the two is fine here: this is a
// partition, and "you did not send one" versus "that one is wrong" is the
// difference between a page that shows its login form and one that shows an
// error under it.
export const ADMIN_MISSING = 'missing'
export const ADMIN_WRONG = 'wrong'

/**
 * createAdminAuth({ path, defaultPassword, log })
 *
 *   ensureFile()   -> best-effort: write the default password file if there is
 *                     none, so the operator can FIND the knob instead of having
 *                     to know it exists. Never throws; a read-only /config just
 *                     means the built-in default stays in force.
 *   expected()     -> the password currently in force (file, else default).
 *   usingDefault() -> is that still the documented default? A boolean and never
 *                     the value: what needs this is a warning, and a warning
 *                     does not have to know a password to say that this one is
 *                     printed in a public repository.
 *   check(headers) -> { ok: true } | { ok: false, reason }
 */
export function createAdminAuth ({
  path = ADMIN_PASSWORD_FILE_DEFAULT,
  defaultPassword = DEFAULT_ADMIN_PASSWORD,
  log = console
} = {}) {
  async function expected () {
    try {
      // trim(): an editor that appends a newline must not lock the operator out
      // of his own box.
      const raw = (await readFile(path, 'utf8')).trim()
      if (raw) return raw
    } catch { /* no file / unreadable -> the built-in default is in force */ }
    return defaultPassword
  }

  async function ensureFile () {
    try {
      await readFile(path, 'utf8')
      return false // already there — never overwrite a password somebody set
    } catch { /* fall through and create it */ }
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, defaultPassword + '\n', { flag: 'wx' })
      log.log?.(`[admin] created ${path} with the default password — change it before exposing this tool beyond the LAN`)
      return true
    } catch {
      // Read-only /config, or a race with another boot. Either way the default
      // still works; there is nothing to repair and nothing to warn about.
      return false
    }
  }

  async function usingDefault () {
    return (await expected()) === defaultPassword
  }

  async function check (headers) {
    const raw = headers?.[ADMIN_PASSWORD_HEADER]
    const sent = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : ''
    if (!sent) return { ok: false, reason: ADMIN_MISSING }
    return sent === (await expected()) ? { ok: true } : { ok: false, reason: ADMIN_WRONG }
  }

  return { ensureFile, expected, usingDefault, check, path }
}
