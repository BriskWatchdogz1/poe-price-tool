// backend/v2/networth/subtab-shape.mjs
// WHAT GGG'S FOLDER-TAB CHILDREN ACTUALLY LOOK LIKE. One log line per folder
// tab per process, and NOTHING ELSE — this module makes no request, takes no
// decision, changes no behaviour and returns nothing.
//
// ---------------------------------------------------------------------------
// WHY IT IS ONLY AN OBSERVATION, AND WHY THAT IS THE WHOLE FEATURE
// ---------------------------------------------------------------------------
// There was a rule here once (`subtab-skip.mjs`, 2026-08-13, reverted the same
// day): the map stash costs 1+N requests and N was ~37, so the per-tier
// sub-tabs — which hold only normal maps, which are never priced — were passed
// over. A child was identified as a tier folder by its NAME matching a pattern
// (`Tier: 16`, `T16`, `XVI`, `16`).
//
// The names are not section names. This very log line, shipped alongside that
// rule, answered the question one lap later: the map stash's children are
// called `"1"` and `"2"` — PAGE NUMBERS — and all 39 of them carry the same
// `type=MapStash`. The pattern's "a name that is nothing but a number" branch
// therefore matched every child, the whole map stash was skipped, `Unique Maps`
// and `Special Maps` with it, and the net worth lost the value that sits in
// them. See docs/bugs.md, B19.
//
// So the rule went, and this line stayed — the measurement that should have come
// FIRST. It is still the only thing this module does, and it still decides
// nothing.
//
// ---------------------------------------------------------------------------
// IT ANSWERED ITS QUESTION ON 2026-08-19
// ---------------------------------------------------------------------------
// The open question was whether the response says which SECTION a child belongs
// to (`Unique Maps` / `Special Maps` / a tier page). `name` does not, and `type`
// does not — both were measured. `metadata` does:
//
//   "1" type=MapStash metadata={"items":70,"map":{"section":"tier16", …}}
//   "1" type=MapStash metadata={"items":16,"map":{"section":"unique",  …}}
//
// The skip was rebuilt on that field, in the other direction — read anything
// that does not explicitly say `tier<N>` — and lives in networth/map-sections.mjs
// with the reasoning for why it is allowed to decide where the name rule was
// not. The line below is what made that possible and is therefore kept exactly
// as it is: it is how the NEXT such question gets answered, and it must go on
// reporting what GGG sends rather than what anything downstream now reads.
//
// ---------------------------------------------------------------------------
// WHAT THE LINE HAS TO SHOW TO BE WORTH ANYTHING
// ---------------------------------------------------------------------------
// Everything the response already carries is reported here, because all of it is
// free (the parent response is in hand; not one extra request is made for any of
// it):
//
//   - the union of the child entry FIELD NAMES — so a field nobody thought of
//     cannot hide,
//   - each child's `name` and `type`,
//   - each child's `metadata`, AS JSON — the field whose CONTENT was never
//     logged, and the likeliest place for a section marker,
//   - every OTHER field of a child that is not an opaque id, printed by value —
//     so a `folder`, `page`, `index` or sort field shows up by itself, without
//     this file having to guess its name in advance,
//   - the parent's own fields and its `metadata`, in case the structure is
//     explained one level up rather than per child.
//
// WHAT "THE PARENT" MEANS HERE is the parent object of the `/api/stash/<league>/
// <tabId>` response — the one the children came out of. It is NOT the legacy tab
// list's entry for the same tab: that one is trimmed to {index,name,type,id}
// before it ever reaches this file (stash-client.mjs `listTabs`, refresher.mjs),
// and whether it carries anything else is already answerable from the
// `tab entry fields:` line under POE_NETWORTH_DEBUG. Nothing here makes a
// request to find out, which is the rule this module is held to.
//
// `id` and `parent` are the two fields deliberately printed by NAME ONLY. They
// are opaque addressing tokens, they say nothing about a section, and they are
// the one part of the response that is a handle on somebody's stash.
//
// THIS IS FOREIGN DATA, so it is treated as foreign data. Every value is passed
// through the project's own credential filter (`secret-keys.mjs`, the same
// expression that guards `/config-view`): a key that could name a credential is
// printed as `[redacted]`, never by value. Control characters are stripped so
// nothing can forge a log line, and every part is length-capped so one absurd
// response cannot push the rest of the log off the screen.
//
// FREQUENCY: once per folder tab per process, never per walk. The refresher runs
// round the clock and reaches the map stash every lap; a line per walk would be
// a line every couple of hours forever, for an answer that does not change. The
// set is module-level for the same reason the rule-set log in stash-client.mjs
// is: the server builds a fresh client every tick, so per-instance memory would
// mean per-tick logging.

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
