// backend/v2/networth/subtab-shape.mjs
// WHAT GGG'S FOLDER-TAB CHILDREN ACTUALLY LOOK LIKE. One log line per folder
// tab per process, and NOTHING ELSE — this module makes no request, takes no
// decision, changes no behaviour and returns nothing.
//
// WHY ONLY AN OBSERVATION. A name rule (`subtab-skip.mjs`, 2026-08-13, reverted
// the same day) skipped the per-tier map sub-tabs (N was ~37) by NAME pattern
// (`Tier: 16`, `T16`, `XVI`, `16`). This line showed the children are called
// `"1"` and `"2"` — PAGE NUMBERS — and all 39 carry `type=MapStash`, so the
// rule skipped the whole map stash, `Unique Maps` and `Special Maps` with it
// (docs/bugs.md B19). On 2026-08-19 it answered where the SECTION is: not in
// `name`, not in `type` (both measured), but in `metadata`:
//   "1" type=MapStash metadata={"items":70,"map":{"section":"tier16", …}}
//   "1" type=MapStash metadata={"items":16,"map":{"section":"unique",  …}}
// The skip reads that field — anything that does not explicitly say
// `tier<N>` is read — in networth/map-sections.mjs. This line is kept exactly
// as it is: it answers the NEXT such question, and must go on reporting what
// GGG sends rather than what anything downstream reads.
//
// WHAT IT SHOWS, all free (the parent response is in hand, no extra request):
// the union of the child entry FIELD NAMES; each child's `name` and `type`;
// each child's `metadata` AS JSON; every OTHER child field that is not an
// opaque id, by value (so a `folder`, `page`, `index` or sort field shows up by
// itself); the parent's own fields and its `metadata`. "The parent" is the
// parent object of the `/api/stash/<league>/<tabId>` response, NOT the legacy
// tab list's entry (trimmed to {index,name,type,id} by stash-client.mjs
// `listTabs` and refresher.mjs; its fields show in the `tab entry fields:` line
// under POE_NETWORTH_DEBUG). `id` and `parent` are printed by NAME ONLY: opaque
// addressing tokens, a handle on somebody's stash.
//
// THIS IS FOREIGN DATA: every value passes the project's credential filter
// (`secret-keys.mjs`, the expression that guards `/config-view`), so a key that
// could name a credential prints as `[redacted]`; control characters are
// stripped so nothing can forge a log line; every part is length-capped.
// FREQUENCY: once per folder tab per process, never per walk (the refresher
// reaches the map stash every lap). The set is module-level like the rule-set
// log in stash-client.mjs: the server builds a fresh client every tick.

import { SECRET_KEY_RE } from '../secret-keys.mjs'

const seenShapes = new Set()
const MAX_LOGGED_SHAPES = 20
// A folder tab with a pathological number of children must not produce a
// pathological log line. 40 is above the 39 the map stash was measured at.
const MAX_LISTED_CHILDREN = 40
// Per rendered value, and for the whole list of children. Both are generous
// enough for the measured shape and finite for any other.
const MAX_VALUE_CHARS = 200
const MAX_CHILDREN_CHARS = 4000
// How deep and how wide an unknown object is walked before it is elided. A
// stash's metadata is a handful of fields; anything past this is not a metadata
// object, it is a payload.
const MAX_DEPTH = 3
const MAX_KEYS = 20
const MAX_ARRAY = 8

// Printed by name only: opaque addressing tokens, of no use for the question
// and the one part of the answer that is a handle on a stash.
const OPAQUE_FIELDS = new Set(['id', 'parent'])
// Printed in their own place on the line, so they are not printed twice.
const SHOWN_ELSEWHERE = new Set(['name', 'type', 'metadata'])

/**
 * Bounded and de-fanged for a log line — the same rule env-number.mjs holds for
 * an operator's own text: foreign text must not be able to smuggle control
 * characters into the log or run past the end of the line.
 */
function quote (raw, max = MAX_VALUE_CHARS) {
  const s = [...String(raw)]
    .map(ch => { const c = ch.codePointAt(0); return (c < 0x20 || c === 0x7f) ? ' ' : ch })
    .join('')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * A copy of `v` with every value under a key that could name a credential
 * replaced, and with depth, key count and array length bounded. The filter is
 * the project's one expression for this (`secret-keys.mjs`) rather than a second
 * opinion, so a name that is redacted in `/config-view` is redacted here too.
 */
function redact (v, depth = 0) {
  if (v == null || typeof v !== 'object') return v
  if (depth >= MAX_DEPTH) return '…'
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ARRAY).map(e => redact(e, depth + 1))
    if (v.length > MAX_ARRAY) out.push(`…+${v.length - MAX_ARRAY}`)
    return out
  }
  const out = {}
  let n = 0
  for (const [k, val] of Object.entries(v)) {
    if (n >= MAX_KEYS) { out['…'] = `+${Object.keys(v).length - MAX_KEYS} more` ; break }
    n++
    out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(val, depth + 1)
  }
  return out
}

/** A redacted, bounded, control-character-free JSON rendering of any value. */
function asJson (v) {
  let s
  try { s = JSON.stringify(redact(v)) } catch { s = null }
  return quote(s ?? String(v))
}

/** The field names of an object, in the order the response carried them. */
function fieldsOf (v) {
  return (v && typeof v === 'object') ? Object.keys(v) : []
}

/**
 * `key=value` for every field of a child that is not shown elsewhere on the
 * line and not an opaque id. This is the part that does not have to know what it
 * is looking for: whatever GGG adds — `folder`, `page`, a sort order — appears
 * here by itself the first time a process sees it.
 */
function extraFields (child) {
  const out = []
  for (const [k, v] of Object.entries(child || {})) {
    if (SHOWN_ELSEWHERE.has(k) || OPAQUE_FIELDS.has(k)) continue
    if (SECRET_KEY_RE.test(k)) { out.push(`${k}=[redacted]`); continue }
    if (v == null || typeof v !== 'object') { out.push(`${k}=${quote(v)}`); continue }
    out.push(`${k}=${asJson(v)}`)
  }
  return out
}

function describeChild (child) {
  const name = typeof child?.name === 'string' ? `"${quote(child.name)}"` : '(no name)'
  const parts = [name, `type=${child?.type == null ? '(none)' : quote(child.type)}`]
  parts.push(`metadata=${'metadata' in (child || {}) ? asJson(child.metadata) : '(none)'}`)
  parts.push(...extraFields(child))
  return parts.join(' ')
}

/**
 * noteSubTabShape(tab, parent, log)
 *
 * `tab` is the listTabs() entry of the folder tab, `parent` the whole parsed
 * response of `/api/stash/<league>/<tabId>` — the request the walk has just
 * made anyway. Pure observation: nothing is requested, decided or returned.
 */
export function noteSubTabShape (tab, parent, log = console) {
  const key = `${tab?.type ?? '(no type)'}#${tab?.index ?? '?'}`
  if (seenShapes.has(key)) return
  if (seenShapes.size >= MAX_LOGGED_SHAPES) return
  seenShapes.add(key)

  const stash = parent?.stash
  const list = Array.isArray(stash?.children) ? stash.children : []
  const fields = new Set()
  for (const c of list) for (const k of fieldsOf(c)) fields.add(k)

  const shown = list.slice(0, MAX_LISTED_CHILDREN).map(describeChild)
  const more = list.length > shown.length ? ` …+${list.length - shown.length} more` : ''
  let children = shown.join(', ')
  if (children.length > MAX_CHILDREN_CHARS) children = `${children.slice(0, MAX_CHILDREN_CHARS)}… (cut)`

  // The parent side of the answer: if the structure is explained one level up
  // rather than per child, it is in one of these two.
  const parentPart =
    `parent response keys: ${fieldsOf(parent).join(',') || '(none)'}; ` +
    `parent stash fields: ${fieldsOf(stash).join(',') || '(none)'}; ` +
    `parent metadata: ${stash && 'metadata' in stash ? asJson(stash.metadata) : '(none)'}`

  log?.log?.(`[stash-client] folder tab "${quote(tab?.name)}" (${quote(tab?.type)}) sub-tab shape as GGG ` +
    `returns it, once per process: ${list.length} children, entry fields: ` +
    `${[...fields].join(',') || '(none)'} — ${parentPart} — ${children}${more}`)
}

/** Forget what has been reported. Tests only. */
export function resetSubTabShapeLog () {
  seenShapes.clear()
}
