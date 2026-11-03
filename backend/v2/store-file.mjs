// How a /config store reads its file — and what happens to a file it cannot use.
//
// Why this exists: the net-worth, Faustus and corpse stores each had their own
// copy of "read, parse, check schema_version", and all three treated a file
// they could not use as an empty store, silently. The next save then wrote over
// it. That covered broken JSON and a wrong shape, but also a file written by a
// NEWER release: roll back an image and the older one quietly destroyed what
// the newer one had stored.
//
// This module is the one place that decides what happens to such a file:
//
//   - what is BROKEN (not JSON, not an object, no usable schema_version, a
//     shape the store rejects, an older version it has no migration for) is
//     moved to `<name>.broken-<timestamp>` with ONE warning, and the store
//     starts empty. Never overwritten: the content is still there to look at.
//   - what is NEWER is left exactly as it is, and the store runs in memory
//     only (writable = false). A newer file is only ever met after a rollback.
//     Moving it to `.newer` would make the next update start empty and leave
//     the data orphaned; leaving it costs nothing but persistence while the
//     rollback lasts, and updating again picks it up as if nothing happened.
//   - what cannot be moved aside (read-only volume) is left untouched as well,
//     and the store runs in memory only, for the same reason.
//
// The file's content is never quoted in a warning (json-error.mjs: V8 puts an
// excerpt of the input into its parse errors, and these files sit next to the
// session cookies).
//
// The load only ever sets `writable` to FALSE, never to true: server.mjs sets
// it to false first when /config cannot be written at all, and a successful
// load must not undo that.

import { readFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { jsonErrorSummary } from './json-error.mjs'

/** Same shape as the data refresher's snapshot dirs (`v-` + ISO with ':' and '.' as '-'). */
export function asideStamp (ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-')
}

/**
 * Renames filePath to `${filePath}.${label}-${asideStamp(now())}`, with '-2',
 * '-3' … appended while that name exists — a second broken file must never
 * replace the first one. Returns the new path; throws what rename throws.
 */
export async function moveAside (filePath, { label = 'broken', now = Date.now, renameImpl = rename } = {}) {
  const base = `${filePath}.${label}-${asideStamp(now())}`
  let to = base
  for (let n = 2; existsSync(to); n++) to = `${base}-${n}`
  await renameImpl(filePath, to)
  return to
}

/**
 * loadVersionedJson(filePath, options)
 *   -> { outcome, data, writable }
 *
 *   outcome   'missing'   no file (data null, writable true)
 *             'loaded'    the file as it is
 *             'migrated'  an older version, migrated in memory; the file is
 *                         rewritten in the new form with the next save
 *             'moved'     unusable, moved aside (data null, writable true)
 *             'newer'     from a newer release, left alone (data null, writable false)
 *             'unmovable' unusable and could not be moved (data null, writable false)
 *
 * Options:
 *   tag            log prefix, e.g. 'networth-store'
 *   schemaVersion  the version this release reads and writes
 *   shapeProblem   doc -> null | a reason string (the store's own shape check)
 *   migrate        doc -> doc at schemaVersion, or null when there is none
 *   emptyMeans     what starting empty means for the operator, ends the warning
 *   log, now, renameImpl   injectable for tests
 *
 * Any read error other than ENOENT is thrown, as the stores always did.
 */
export async function loadVersionedJson (filePath, {
  tag,
  schemaVersion,
  shapeProblem = () => null,
  migrate = null,
  emptyMeans = 'starting empty',
  log = console,
  now = Date.now,
  renameImpl = rename
} = {}) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { outcome: 'missing', data: null, writable: true }
    throw err
  }

  let reason = null
  let doc = null
  let migrated = false
  let v = null
  try {
    doc = JSON.parse(raw)
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a JSON object')
  } catch (e) {
    reason = jsonErrorSummary(e)
  }

  if (!reason) {
    v = doc.schema_version
    if (!Number.isInteger(v) || v < 1) reason = 'no usable schema_version'
  }

  if (!reason && v > schemaVersion) {
    log.warn?.(`[${tag}] ${filePath} has schema_version ${v}, newer than the ${schemaVersion} this version reads (written by a newer release?) — running in memory only and leaving the file untouched; update again to use it, or move it away and restart to start over`)
    return { outcome: 'newer', data: null, writable: false }
  }

  if (!reason && v < schemaVersion) {
    if (!migrate) {
      reason = `schema_version ${v} is older than ${schemaVersion} and this version has no migration for it`
    } else {
      try {
        const up = migrate(doc)
        if (up?.schema_version !== schemaVersion) throw new Error(`it did not produce schema_version ${schemaVersion}`)
        doc = up
        migrated = true
      } catch (e) {
        reason = `the migration from schema_version ${v} failed (${e?.message || `it did not produce schema_version ${schemaVersion}`})`
      }
    }
  }

  if (!reason) {
    const p = shapeProblem(doc)
    if (typeof p === 'string' && p) reason = p
  }

  if (!reason) {
    if (migrated) log.log?.(`[${tag}] ${filePath}: schema_version ${v} migrated to ${schemaVersion} in memory — the file is rewritten in the new form with the next save`)
    return { outcome: migrated ? 'migrated' : 'loaded', data: doc, writable: true }
  }

  try {
    const to = await moveAside(filePath, { label: 'broken', now, renameImpl })
    log.warn?.(`[${tag}] ${filePath} is not usable (${reason}) — moved to ${to}; ${emptyMeans}`)
    return { outcome: 'moved', data: null, writable: true }
  } catch (e) {
    log.warn?.(`[${tag}] ${filePath} is not usable (${reason}) and could not be moved aside (${e?.code || e?.message}) — running in memory only and leaving the file untouched; fix or remove it and restart`)
    return { outcome: 'unmovable', data: null, writable: false }
  }
}
