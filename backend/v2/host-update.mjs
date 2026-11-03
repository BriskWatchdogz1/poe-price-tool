// The update button: THE CONTAINER ASKS, THE HOST DECIDES. Restarting is
// something this process can do to itself — it exits and the container
// supervisor brings it back (see POST /restart). Updating is not:
// `git pull && docker compose up -d --build` runs on the HOST, in a checkout
// this container cannot see, against a daemon it must never be able to talk to.
//
// WHY THERE IS NO DOCKER SOCKET HERE. /var/run/docker.sock is root on the host
// without authentication of its own: any container that reaches it can start
// another with the host root filesystem bind-mounted. This tool has no
// authentication at all (LAN by design), its admin area is behind one plaintext
// password whose default is published in this repository, and it parses foreign
// text out of the network all day. Together that is host root for whoever gets
// in. So the socket stays out, and the round trip below is the price.
//
// THE ONE PROPERTY EVERYTHING HANGS ON:
//
//     NOTHING FROM THE REQUEST FILE EVER REACHES THE EXECUTED COMMAND.
//
// The host script reads that file only to learn THAT somebody asked — never
// WHAT to do. Directory and command are constants at the top of the script; no
// branch, tag, path, argument or fragment of a command line travels in the
// file, and the script never expands, sources or evaluates its content. Writing
// that file is exactly what an attacker in the admin area can do, and the most
// he gets is "the host rebuilds the code the host already trusts".
// `deploy/host-update.sh` repeats this argument at its own head, because that
// is the file somebody actually installs.
//
// THREE FILES IN THE /config VOLUME, the only thing container and host share:
//   update-request    written HERE, deleted by the script before it works.
//                     Timestamp and requesting user, for the record. Pressing
//                     twice replaces it; requests do not queue up.
//   update-heartbeat  written by the script on EVERY run, whether there was
//                     anything to do or not: the only way the UI can know an
//                     updater exists at all.
//   update-result     written by the script after a run: outcome, times, and a
//                     bounded excerpt of the output.
// NOTHING IS CREATED AT BOOT: without the host script this feature is a
// disabled button, no file is written unless somebody presses it, and a missing
// directory is not an error.
//
// THE RESULT EXCERPT IS FOREIGN TEXT FROM THE HOST: bounded on the way in,
// filtered by the same `SECRET_KEY_RE` that guards `/config-view`, credentials
// stripped out of any URL (a failing `git` prints its remote, and a remote can
// carry `https://user:token@host/…`), and inserted as TEXT, never as markup
// (`redactOutput()`). THAT FILTER IS NOT A GUARANTEE: it works on names and
// shapes, and a bare token on a line that names nothing and is not a URL
// (`ghp_…` alone, an id echoed by a build step) walks straight through it. The
// promise is "the shapes we can recognise are removed"; `upd.outNote` says so.
//
// "AN UPDATER IS INSTALLED": the documented interval is one run every 5
// minutes, and a heartbeat counts as alive for 20 minutes = three missed runs
// (15 min) plus a 5 min cushion (a host under load, a clock a minute off).
// Generous on purpose: a working updater called dead costs a disabled button,
// the opposite a button that promises what nothing picks up. The script writes
// its heartbeat BEFORE it takes its lock, so runs a long build blocks still
// refresh it WHERE THE SCHEDULE STARTS RUNS INDEPENDENTLY (cron, Unraid's User
// Scripts), not with a systemd `Type=oneshot` timer (no second run while the
// first is building; deploy/host-update.sh and docs/runbooks.md say so at the
// unit file). The window is `POE_UPDATE_HEARTBEAT_MAX_AGE_MS`, for that case
// and for slower schedules. IT NEVER GUESSES: no heartbeat means "no updater is
// installed", never "the updater is broken" — never installed and removed an
// hour ago look the same. THE ONE BROKEN STATE IT CAN NAME is the one the
// script reports: a run killed hard (host reboot mid-build) leaves the lock
// behind, and every later run writes its heartbeat and exits at that lock. The
// script recognises its own stale lock and writes `stuck-since=` into the
// heartbeat; that becomes `updater.stuck` here and a disabled button with the
// reason on the page.

import { readFile, writeFile, rename, unlink, mkdir, stat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
// From secret-keys.mjs and not from config-overrides.mjs, which re-exports it:
// that module reads numeric-settings.mjs now, numeric-settings.mjs reads THIS
// module for one default, and the cycle would leave the table's `fallback:`
// staring at a binding that is still in its temporal dead zone.
import { SECRET_KEY_RE } from './secret-keys.mjs'

/** The /config volume, i.e. the one directory the host and the container share. */
export const UPDATE_DIR_DEFAULT = '/config'

/** Recommended cron interval for deploy/host-update.sh, in minutes. */
export const UPDATER_POLL_MINUTES = 5
/** Three missed runs plus a cushion — see the header for the arithmetic. */
export const HEARTBEAT_MAX_AGE_MS_DEFAULT = 20 * 60 * 1000

/** How much of the result file is read at all, before anything is parsed. */
export const RESULT_READ_MAX_BYTES = 64 * 1024
/** The heartbeat is two short lines; anything beyond this is not one. */
export const HEARTBEAT_READ_MAX_BYTES = 4 * 1024
/** How much of the excerpt survives into the answer. */
export const OUTPUT_MAX_CHARS = 4000

/** What is left where a line was dropped. Visible on purpose. */
export const REDACTED_LINE = '[line removed: it names something that could be a credential]'

// Every Unicode control character. Written as a category rather than as a
// range of escapes so that no literal control character has to appear in this
// source file. Newline and tab survive: a build log is indented, and stripping
// the indentation out of an error message helps nobody.
const CONTROL_CHARS = /\p{Cc}/gu
const KEEP_CONTROL = new Set(['\n', '\t'])

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

/**
 * Line endings normalised and every control character but newline and tab
 * removed. The first step of every filter here, and its own export because it
 * is not the part that is specific to a build log: a status reason has to go
 * through it too (check-failure.mjs).
 */
export function stripControlChars (text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, c => (KEEP_CONTROL.has(c) ? c : ''))
}

/**
 * `scheme://user:password@host` -> `scheme://***@host`. The concrete case is a
 * `git` error quoting a remote with credentials in it, and it is a SHAPE, so it
 * is the same at any granularity — a build log and a one-line reason both want
 * exactly this.
 *
 * Two alternatives for the userinfo, because a password may contain a `/`
 * (`https://user:pa/ss@host`) and stopping at the first slash would walk right
 * past that one:
 *   [^\s/@]*        a bare `user@` — no slash, so a path with an @ in it
 *                   (`https://host/a@b`) is not mistaken for a credential;
 *   [^\s@]*:[^\s@]* `user:password@` — slashes allowed, but only when there is
 *                   a colon, which is what makes it userinfo at all.
 * The second one can over-mask: a URL with both a colon and an @ in its path
 * loses its host to the mask. That is the direction to err in — a masked log
 * line costs nothing.
 */
export function maskUrlCredentials (text) {
  return String(text ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]*|[^\s@]*:[^\s@]*)@/gi, '$1***@')
}

/**
 * The excerpt, filtered — as far as filtering free text goes.
 *
 *   - control characters out (this ends up in a browser and in a log line)
 *   - `scheme://anything@host` -> `scheme://***@host`: the concrete case is a
 *     `git` error quoting a remote with credentials in it
 *   - every LINE that matches SECRET_KEY_RE is dropped, not masked. The same
 *     expression /config-view filters its field names by, applied to free text
 *     the only way free text allows: per line, in the safe direction. A build
 *     log line is cheap; a leaked token is not.
 *   - the TAIL is kept when it is too long, because that is where the error is.
 *
 * THE LINE GRANULARITY IS RIGHT HERE AND ONLY HERE. This filters a MULTI-LINE
 * build protocol: losing one line of it costs a line, the rest of the log still
 * says what happened, and the trade is cheap in the safe direction. It is the
 * wrong granularity for a text that IS one line — a one-sentence status reason
 * comes out of it as nothing but the placeholder, which deletes the cause and
 * claims a credential was near it into the bargain. That text has its own
 * filter, built from the same vocabulary at value granularity
 * (secret-keys.mjs `maskSecretValues`, used by check-failure.mjs).
 *
 * WHAT IT DOES NOT DO, said here so that nobody reads more into it than it
 * does: it catches NAMES and SHAPES. A bare token on a line that names nothing
 * and forms no URL passes through untouched, and there is no way to recognise
 * one that does not also delete the error text this excerpt exists to show.
 * The output is a filtered build log, not a log proven free of secrets, and
 * the page tells its reader that as well (`upd.outNote`).
 */
export function redactOutput (text, { maxChars = OUTPUT_MAX_CHARS } = {}) {
  let s = maskUrlCredentials(stripControlChars(text))
  s = s.split('\n').map(line => (SECRET_KEY_RE.test(line) ? REDACTED_LINE : line)).join('\n').trim()
  if (s.length > maxChars) s = '…' + s.slice(-maxChars)
  return s
}

/** ISO string or null — never a guess, and never the raw value. */
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)
const isoOrNull = v => (typeof v === 'string' && ISO.test(v.trim()) ? v.trim() : null)

/**
 * The last `max` bytes of a file, or null if it is not there.
 *
 * The tail rather than the head, and bounded before anything is allocated: the
 * script caps its own output, but this reads a file somebody else writes, so
 * "it is capped over there" is not a size limit on this side.
 *
 * TWO THINGS GUARD THE OPEN ITSELF, for the same reason the host script guards
 * its own side: these paths live in a directory two parties write to, so what
 * is behind a name is not settled by the name. `O_NONBLOCK` means a FIFO left
 * in the place of one of these files cannot park this request forever waiting
 * for a writer, and the `isFile()` check means anything that is not a plain
 * file reads as "not there" rather than as content.
 */
async function readTail (path, max) {
  let fh = null
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const st = await fh.stat()
    if (!st.isFile()) return null
    const { size, mtimeMs } = st
    const length = Math.min(size, max)
    const buf = Buffer.alloc(length)
    if (length) await fh.read(buf, 0, length, size - length)
    return { text: buf.toString('utf8'), mtimeMs, truncated: size > length }
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** `key=value` lines, first occurrence wins. Everything else is ignored. */
function parseFields (text) {
  const out = {}
  for (const line of String(text).split('\n')) {
    const m = /^\s*([a-z][a-z0-9-]*)\s*=\s*(.*)$/i.exec(line)
    if (m && !Object.hasOwn(out, m[1])) out[m[1]] = m[2].trim()
  }
  return out
}

/** The part after the separator line the script writes before the output. */
const OUTPUT_SEPARATOR = '--- output ---'

/**
 * A user name is only ever recorded for the record, never used for anything —
 * but it is written into a file on a shared volume, so it is bounded and
 * stripped of everything that is not a plain name. The server passes a name it
 * has already checked against POE_USERS; this is the second wall, here because
 * the rule belongs next to the write.
 */
export function safeUserLabel (user) {
  const raw = String(user ?? '').trim()
  const clean = raw.replace(/[^\w.@-]/g, '')
  return clean.slice(0, 40) || 'unknown'
}

/**
 * createHostUpdate({ dir, heartbeatMaxAgeMs, buildCommit })
 *
 *   request({ user })  -> write the request file (replacing any older one)
 *   status()           -> what the page needs: is there an updater, is a request
 *                         outstanding, how did the last run end, what is running
 *                         here right now
 *
 * No state is kept in memory: both answers are the three files, read fresh.
 * The host script and this process are not running at the same time in any
 * coordinated way, and a cache would be a way to be wrong about that.
 */
export function createHostUpdate ({
  dir = process.env.POE_UPDATE_DIR || UPDATE_DIR_DEFAULT,
  heartbeatMaxAgeMs = HEARTBEAT_MAX_AGE_MS_DEFAULT,
  buildCommit = null,
  log = console
} = {}) {
  const requestPath = join(dir, 'update-request')
  const heartbeatPath = join(dir, 'update-heartbeat')
  const resultPath = join(dir, 'update-result')

  async function request ({ user = null, at = new Date() } = {}) {
    const requestedAt = at.toISOString()
    // Comments in the file itself: whoever finds it in /config should be able
    // to see in one glance that it is a flag, not an instruction.
    const body =
      '# An update was requested from the admin area of the running tool.\n' +
      '# The host script only checks that this file EXISTS. It does not read a\n' +
      '# single value out of it, and nothing in here becomes part of a command.\n' +
      `requested-at=${requestedAt}\n` +
      `requested-by=${safeUserLabel(user)}\n`
    const tmpPath = `${requestPath}.${process.pid}.tmp`
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(tmpPath, body, 'utf8')
      await rename(tmpPath, requestPath)
    } catch (e) {
      await unlink(tmpPath).catch(() => {})
      return { ok: false, error: `could not write ${requestPath} (${e.code || e.message})` }
    }
    log.log?.(`[host-update] update requested by ${safeUserLabel(user)} — wrote ${requestPath}; the host script picks it up on its next run`)
    return { ok: true, requestedAt }
  }

  /** Our own file, so its content may be parsed without ceremony. */
  async function readRequest () {
    let raw
    try { raw = await readFile(requestPath, 'utf8') } catch { return null }
    const f = parseFields(raw)
    let at = isoOrNull(f['requested-at'])
    if (!at) {
      // Written by a version that spelled it differently, or edited by hand.
      // The file's existence is the fact that matters; the time is decoration.
      at = await stat(requestPath).then(s => iso(s.mtimeMs), () => null)
    }
    return { requestedAt: at, requestedBy: f['requested-by'] ? safeUserLabel(f['requested-by']) : null }
  }

  /**
   * The heartbeat's AGE comes from the file's mtime, not from the timestamp
   * inside it. The content is written for a human who cats the file; making the
   * liveness check depend on parsing foreign text would add a way to be wrong
   * about it for no gain. An mtime cannot be malformed.
   *
   * ONE FIELD IS READ out of the content, and it is the one an mtime cannot
   * carry: `stuck-since`, which the script writes when it finds its own lock
   * held far longer than a build can take. Liveness stays on the mtime; this
   * only turns a live-but-blocked updater into something the page can say. A
   * missing or unparseable timestamp still counts as stuck — the fact is the
   * field being there, the time is decoration — and a value that is not an ISO
   * timestamp becomes null rather than prose from a file.
   */
  async function readHeartbeat (nowMs) {
    const tail = await readTail(heartbeatPath, HEARTBEAT_READ_MAX_BYTES)
    if (!tail) return { installed: false, at: null, ageMs: null, stuck: false, stuckSince: null }
    const ageMs = Math.max(0, nowMs - tail.mtimeMs)
    const stuckSince = parseFields(tail.text)['stuck-since']
    return {
      installed: ageMs <= heartbeatMaxAgeMs,
      at: iso(tail.mtimeMs),
      ageMs,
      stuck: Boolean(stuckSince),
      stuckSince: isoOrNull(stuckSince)
    }
  }

  async function readResult () {
    const tail = await readTail(resultPath, RESULT_READ_MAX_BYTES)
    if (!tail) return null
    const sepAt = tail.text.indexOf(OUTPUT_SEPARATOR)
    // NO SEPARATOR IN THE WINDOW means the header scrolled out of the top of
    // it: the file is longer than RESULT_READ_MAX_BYTES, so what we are holding
    // is output and nothing but output. Reading `status=` out of THAT would be
    // reading a build log line as a verdict, so the outcome is 'unknown' and
    // the excerpt is kept — an unknown outcome with the error in it is far more
    // use than a confident answer with nothing under it.
    const head = sepAt === -1 ? '' : tail.text.slice(0, sepAt)
    const body = sepAt === -1 ? tail.text : tail.text.slice(sepAt + OUTPUT_SEPARATOR.length)
    const f = parseFields(head)
    // Two words are understood. Anything else is 'unknown' rather than passed
    // through — the page renders a state, not a string from the host.
    const status = f.status === 'ok' || f.status === 'failed' ? f.status : 'unknown'
    return {
      status,
      at: iso(tail.mtimeMs),
      startedAt: isoOrNull(f.started),
      finishedAt: isoOrNull(f.finished),
      output: redactOutput(body),
      truncated: tail.truncated
    }
  }

  async function status ({ now = Date.now() } = {}) {
    const [heartbeat, req, result] = await Promise.all([readHeartbeat(now), readRequest(), readResult()])
    return {
      updater: {
        installed: heartbeat.installed,
        heartbeatAt: heartbeat.at,
        heartbeatAgeMs: heartbeat.ageMs,
        maxAgeMs: heartbeatMaxAgeMs,
        pollMinutes: UPDATER_POLL_MINUTES,
        // Installed AND running AND unable to do anything — see readHeartbeat.
        stuck: heartbeat.stuck,
        stuckSince: heartbeat.stuckSince
      },
      request: {
        pending: Boolean(req),
        requestedAt: req?.requestedAt ?? null,
        requestedBy: req?.requestedBy ?? null
      },
      lastResult: result,
      // Which code this container was built from. `null`, never a guess: the
      // ARG is not set on a plain `docker compose build`, and inventing a value
      // for the one question an update starts with would be worse than saying
      // nothing. The page prints "unknown".
      build: { commit: buildCommit || null },
      dir,
      requestPath
    }
  }

  return { dir, requestPath, heartbeatPath, resultPath, heartbeatMaxAgeMs, request, status }
}
