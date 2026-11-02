// One function, and the reason it exists is worth the file.
//
// V8 does not describe a `JSON.parse` failure — it QUOTES the input:
//
//   JSON.parse('{"POESESSID": abc}')
//   -> SyntaxError: Unexpected token 'a', ..."POESESSID": abc"... is not valid JSON
//
// Both JSON files this tool keeps in /config are hand-editable, one of them
// sits next to a file of session cookies, and the overrides file's parse
// problems are published by `GET /config-view`. Passing the parser's message on
// would therefore hand a fragment of an operator's file back over HTTP (or into
// a log that gets pasted into a bug report) precisely when that file was
// mistyped — which is exactly when a half-written credential is most likely to
// be in it.
//
// So the message is summarised, never quoted. Position and kind are useful and
// safe; the excerpt is neither. Where V8 reports no position, the summary says
// that instead of inventing one.

/** A `JSON.parse` error described without repeating any of the input. */
export function jsonErrorSummary (e) {
  // Not a parser error: everything else here is our own message, and ours
  // quote nothing.
  if (!(e instanceof SyntaxError)) return String(e?.message ?? e)
  const at = /at position (\d+)/.exec(e.message)
  if (at) return `invalid JSON at position ${at[1]}`
  if (/Unexpected end of JSON input/i.test(e.message)) return 'invalid JSON: the file ends in the middle of a value'
  return 'invalid JSON (the parser reports this one only with an excerpt of the file, which is deliberately not repeated here)'
}
