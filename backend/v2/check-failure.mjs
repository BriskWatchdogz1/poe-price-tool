// WHY a background check failed, in a form a status line can act on.
//
// The data refresher already logged the reason of every failed check — one line
// a day, in the container log. What it persisted was the OUTCOME only, so the
// browser could say "no successful check of lang-data for 5 days" and nothing
// else. For an operator who is not reading the log that sentence is the whole
// story, and it does not contain the one thing that decides what to do next:
// whether this is an upstream that is briefly away (wait) or an answer this
// build refuses / cannot read (act). See docs/bugs.md B24.
//
// Two values travel from the failure site to the status line:
//
//   reason  the sentence that is already in the log, filtered (see below).
//   kind    one of FAIL_KIND — set AT THE SITE THAT KNOWS, never derived from
//           the wording of the reason afterwards. A failure nobody classified
//           stays `unknown`, and the status line then shows the reason with no
//           advice attached rather than inventing one. Guessing a cause here
//           would be the exact defect this module was written for.
//
// THE REASON IS FOREIGN TEXT. It quotes upstream bodies, error messages of a
// child process and URLs, and it ends up in a browser. So it is filtered — with
// the same vocabulary the update block's host output is filtered by, at the
// granularity THIS text has.
//
// It used to go through `redactOutput()` whole, and that was a defect of its
// own: that filter drops every LINE naming something that could be a credential,
// and the reason IS one line. `key count`, `Unexpected token …` and the quoted
// body of a captive portal all trip the vocabulary, so the first real failure
// showed a credential placeholder INSTEAD of its cause — and asserted a
// credential had been near it. The line granularity is right for a build
// protocol and wrong here, so the reason gets the value granularity instead:
// control characters out, credentials inside a URL masked, and every VALUE a
// credential-shaped name is handed replaced by `***`, while the words around it
// stay. `key=abcdef` carries a secret; the word `key` in `key count` does not.
//
// The security claim is unchanged and is stated where it is implemented
// (secret-keys.mjs): names and shapes are caught, a bare secret that names
// nothing is not — the same limit `redactOutput` has always documented.
//
// On top of that the reason is folded to a single line and capped, because this
// is a status line and not a log view.
import { stripControlChars, maskUrlCredentials } from './host-update.mjs'
import { maskSecretValues } from './secret-keys.mjs'

/**
 * The classes of failure, and what each one says about what to do.
 *
 *   unreachable   the other side did not answer at all (network, DNS, 5xx, a
 *                 CDN that refused). Nothing to fix here; the next check
 *                 retries on its own.
 *   rejected      an answer arrived and THIS TOOL refused it — a snapshot that
 *                 failed validation, a lookup answering something that is not a
 *                 patch version. It does not resolve itself.
 *   incompatible  the format moved past this build: the data can be reached and
 *                 read, and the code that reads it is too old. The remedy is a
 *                 container update, which the admin area has a button for.
 *   unknown       nobody classified it. The reason is shown as it is, WITHOUT
 *                 advice.
 */
export const FAIL_KIND = Object.freeze({
  UNREACHABLE: 'unreachable',
  REJECTED: 'rejected',
  INCOMPATIBLE: 'incompatible',
  UNKNOWN: 'unknown'
})

const KNOWN = new Set(Object.values(FAIL_KIND))

/**
 * How much of a reason survives into the status line. A default, not a
 * constant: the value in force comes from numeric-settings.mjs
 * (POE_DATA_STATUS_REASON_MAX) and is handed down by the server, like every
 * other number in this subsystem.
 *
 * 300 characters is the length of the longest reason this code can produce with
 * a URL and a quoted upstream answer in it; below ~60 the sentence loses the
 * part that names the source of the trouble, which is the only part that is
 * worth showing at all.
 */
export const REASON_MAX_CHARS_DEFAULT = 300

/** An Error carrying its class, for the throw sites. */
export function failure (reason, kind = FAIL_KIND.UNKNOWN) {
  const e = new Error(String(reason))
  e.failKind = KNOWN.has(kind) ? kind : FAIL_KIND.UNKNOWN
  return e
}

/** The class of a caught error — `unknown` for everything nobody tagged. */
export function kindOf (err) {
  return KNOWN.has(err?.failKind) ? err.failKind : FAIL_KIND.UNKNOWN
}

/** Is this a class the UI knows? Used to keep a stray value off the wire. */
export function isFailKind (kind) { return KNOWN.has(kind) }

/**
 * The reason as it may be shown: filtered, one line, bounded.
 *
 * The HEAD is kept when it is too long (a build log ends with its error, an
 * error message STARTS with it), so the cap is applied here and not borrowed
 * from a filter that keeps the tail.
 *
 * ORDER MATTERS. Folding happens BEFORE the value mask, not after: a name and
 * the value it carries may have been split across two lines of a child's
 * stderr, and on the folded line they are adjacent again and the mask sees
 * them. Capping is last, because masking can only shorten.
 *
 * IDEMPOTENT, and it has to be: the same text is filtered on the way into the
 * persisted state and again on the way out of it (data-refresher.mjs reads a
 * state file an older build wrote). Masking an already-masked value produces
 * the same string, and none of the three steps can undo another.
 *
 * Returns '' for nothing usable, so a caller can store null instead of an empty
 * sentence.
 */
export function cleanReason (text, { maxChars = REASON_MAX_CHARS_DEFAULT } = {}) {
  const raw = String(text ?? '')
  if (!raw.trim()) return ''
  const cap = Math.max(Number(maxChars) || REASON_MAX_CHARS_DEFAULT, 40)
  // A generous HEAD first, so a runaway stderr is not filtered in full only to
  // be thrown away a step later.
  const head = raw.length > cap * 8 ? raw.slice(0, cap * 8) : raw
  const oneLine = maskUrlCredentials(stripControlChars(head))
    .split('\n').map(s => s.trim()).filter(Boolean).join(' ')
  const collapsed = maskSecretValues(oneLine).replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  return collapsed.length > cap ? collapsed.slice(0, cap - 1) + '…' : collapsed
}
