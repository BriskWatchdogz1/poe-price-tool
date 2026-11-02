// The one expression that decides whether a NAME could name a credential.
//
// It lived in config-overrides.mjs, which is where it is used most, and it is
// its own module now for a mechanical reason rather than a tidiness one: the
// allow-list in config-overrides.mjs takes the defaults and ranges of its
// numeric rows from numeric-settings.mjs, that table takes one of ITS defaults
// from host-update.mjs, and host-update.mjs needs this expression. Left in
// config-overrides.mjs that is an import cycle, and the first victim of it is
// whoever imports host-update.mjs first (its own test does): the cycle then
// enters numeric-settings.mjs while host-update.mjs is still evaluating, and
// the table's `fallback:` reads a binding that is still in its temporal dead
// zone — a ReferenceError at load, not a subtle bug, but not one that is
// obvious from the stack either. A regex with no imports of its own cannot be
// part of a cycle.
//
// Case-insensitive on purpose: the test that walks a whole `/config-view`
// answer uses the same expression, and a lower-case field name must not be a
// way past it.
//
// ONE list, two rules. `SECRET_KEY_RE` answers "could this NAME name a
// credential" and is what a field-name allow-list and the host-output line
// filter ask. `maskSecretValues()` below asks the narrower question a single
// sentence needs — "does this text hand such a name a VALUE" — and both are
// built from the same words so the two cannot drift apart.
const SECRET_WORDS = 'SESSID|PASSWORD|TOKEN|SECRET|ACCOUNT|KEY'

export const SECRET_KEY_RE = new RegExp(SECRET_WORDS, 'i')

/** What replaces a value. Short, and obviously not a value. */
export const SECRET_VALUE_MASK = '***'

// The masker's own vocabulary is WIDER than SECRET_KEY_RE's, and deliberately:
// the two rules pay different prices for a false positive. SECRET_KEY_RE
// decides whether a `/config-view` field is shown at all and whether a whole
// build-log line survives, so widening it would silently take content away
// somewhere else. Masking one value inside a sentence costs three characters,
// so the sentence can afford the names an authorization header actually uses.
const MASK_WORDS = `${SECRET_WORDS}|AUTH|CREDENTIAL|COOKIE|BEARER`

// A NAME built out of that vocabulary: the word itself plus whatever a real
// field name wraps around it — `POESESSID`, `api_key`, `X-Auth-Token`,
// `Authorization`.
const NAME = `[A-Za-z0-9_.-]*(?:${MASK_WORDS})[A-Za-z0-9_.-]*`

// The word between the separator and the value in an authorization header.
// Without it `Authorization: Bearer abc123` would mask `Bearer` and print the
// token.
const SCHEME = '(?:Bearer|Basic|Token|Digest)[ \\t]+'

// What a VALUE looks like when nothing but a space separates it from its name.
// At least eight characters out of the alphabet credentials are written in,
// and NOT an ordinary word: a lower-case run, with or without a capital, is
// English and is left alone. That single lookahead is what keeps `key count`,
// `Unexpected token in`, `account information` and `secret sauce` intact while
// `deadbeefdeadbeef99` and `eyJhbGciOi99` do not get through.
const CRED_VALUE = `(?![A-Z]?[a-z]+(?![A-Za-z0-9+/=_~-]))[A-Za-z0-9+/=_~-]{8,}`

// RULE 1 — a name that is HANDED a value: `key=v`, `token: v`, `"secret":"v"`,
// `sessid => v`. The separator has to be there. That is the whole distinction
// this rule exists for: `key=abcdef` carries a value, the word `key` in
// `key count` does not, and dropping the second one costs the only sentence a
// status line has.
//
// Unconditional on the VALUE, unlike rule 2: behind an explicit `=` or `:` a
// password may well be an ordinary word, and there the separator has already
// done the deciding.
const ASSIGNED = new RegExp(
  `(["'\`]?\\b${NAME}\\b["'\`]?[ \\t]*(?:=>|[=:])[ \\t]*(?:${SCHEME})?["'\`]?)([^\\s"'\`,;)\\]}]+)`,
  'gi')

// RULE 2 — the net under rule 1, for the shapes it does not know: a name and a
// value with nothing but space between them (`POESESSID abc…`), and an
// authorization scheme carrying its token without a name in front of it.
const LOOSE = new RegExp(
  `(\\b(?:${NAME}|Bearer|Basic|Digest)\\b[ \\t]+)(${CRED_VALUE})`,
  'gi')

/**
 * Foreign text with every VALUE that a credential-shaped name carries masked,
 * and everything else left standing.
 *
 * WHAT IT DOES NOT DO, in the same words host-update.mjs uses for the filter it
 * is the counterpart of: it catches NAMES and SHAPES. A bare secret on a line
 * that names nothing still passes, and no expression can recognise one without
 * also deleting the text this exists to show. What it buys over dropping the
 * whole line is granularity — and a one-sentence status reason has nothing to
 * spare, because dropping its only line replaces the cause with a placeholder
 * that additionally claims a credential was near.
 */
export function maskSecretValues (text) {
  return String(text ?? '')
    .replace(ASSIGNED, `$1${SECRET_VALUE_MASK}`)
    .replace(LOOSE, `$1${SECRET_VALUE_MASK}`)
}
