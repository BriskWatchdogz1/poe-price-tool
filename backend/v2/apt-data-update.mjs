#!/usr/bin/env node
// Refreshes the vendored Awakened PoE Trade data snapshot in
// renderer/public/data/en/ from upstream master (network!).
//
// CLI, NOT imported by the server/container — same role as
// backend/v2/base-names-gen.mjs. Run it when a new league patch ships items
// the price check cannot identify any more ("new unique is not recognised"):
// items.ndjson is the item database the APT parser resolves names against, and
// stats.ndjson is what the mod matcher reads, so an unknown unique means the
// snapshot is simply older than the patch.
//
// Usage:
//   npm run update-apt-data              # report + write + regenerate indices
//   npm run update-apt-data -- --dry-run # report only, touch nothing
//
// What it prints before writing: per file how many lines came in and how many
// fell away, the items.ndjson namespace counts old -> new, and — loudly — every
// stat/item entry upstream REMOVED. Removals are the only direction that can
// break us silently, so they are listed in full rather than summarised.

import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER_DIR = path.join(HERE, '../../renderer')
const DATA_DIR = path.join(RENDERER_DIR, 'public/data/en')

// Upstream is the APT repo's master branch. Only the `en` snapshot is vendored:
// the backend runs the engine with the English data set (engine.mts), the other
// language dirs under renderer/public/data are dead weight we never read.
// Exported: the background data refresher (data-refresher.mjs) pulls from the
// same upstream — one source of truth for URL and file list.
export const UPSTREAM_BASE =
  'https://raw.githubusercontent.com/SnosMe/awakened-poe-trade/master/renderer/public/data/en'

// The four SOURCE files. The *.index.bin next to them are NOT listed on purpose:
// they are generated from these (make-index-files.mjs, see regenerateIndices),
// gitignored, and copying them from upstream would pair our data with foreign
// line offsets.
export const FILES = ['items.ndjson', 'stats.ndjson', 'client_strings.js', 'app_i18n.json']

const INDEX_SCRIPT = 'src/assets/make-index-files.mjs'

async function fetchText (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch failed (${res.status} ${res.statusText}): ${url}`)
  return res.text()
}

const lines = text => String(text).split('\n').filter(Boolean)

/**
 * Line-level diff of two text blobs, order-insensitive and duplicate-aware
 * (items.ndjson legitimately carries the same line twice, e.g. two variants of
 * one unique). Returns counts plus the added/removed lines themselves.
 */
export function diffLines (oldText, newText) {
  const count = arr => {
    const m = new Map()
    for (const l of arr) m.set(l, (m.get(l) || 0) + 1)
    return m
  }
  const a = count(lines(oldText))
  const b = count(lines(newText))
  const added = []
  const removed = []
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) || 0); i++) added.push(l)
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) || 0); i++) removed.push(l)
  return {
    before: lines(oldText).length,
    after: lines(newText).length,
    added,
    removed
  }
}

/** items.ndjson: namespace -> entry count (UNIQUE / ITEM / GEM / ...). */
export function namespaceCounts (text) {
  const out = {}
  for (const l of lines(text)) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    const ns = o.namespace || '(none)'
    out[ns] = (out[ns] || 0) + 1
  }
  return out
}

/**
 * The identities the rest of the codebase joins on:
 *  - items.ndjson: "<namespace>::<refName>" (normalize.mjs / kinds.mjs, and the
 *    parser's own name lookup)
 *  - stats.ndjson: the stat `ref` of every stat, groups (`stats: [...]`)
 *    flattened, because that is what the mod matcher keys on
 * Anything in the OLD file whose key is absent from the NEW one is a removal —
 * the case the operator has to see before committing.
 */
export function entryKeys (file, text) {
  const keys = new Set()
  for (const l of lines(text)) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    if (file === 'items.ndjson') {
      keys.add(`${o.namespace}::${o.refName}`)
    } else if (file === 'stats.ndjson') {
      for (const s of (o.stats ? o.stats : [o])) if (typeof s.ref === 'string') keys.add(s.ref)
    }
  }
  return keys
}

const oneLine = s => String(s).replace(/\n/g, ' \\n ')

async function readIfPresent (file) {
  try {
    return await readFile(path.join(DATA_DIR, file), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return ''
    throw err
  }
}

/**
 * Regenerates the *.index.bin files from the freshly written ndjson. The
 * upstream script uses relative paths (./public/data/...), so it has to start
 * from within renderer/, and it needs renderer's devDependency @sindresorhus/
 * fnv1a. A missing renderer/node_modules is a warning, not an error: the
 * indices are gitignored and the Docker build regenerates them anyway — it just
 * means a LOCAL run against the new data would still use stale indices.
 */
export function regenerateIndices ({ run = spawnSync } = {}) {
  const r = run(process.execPath, [INDEX_SCRIPT], { cwd: RENDERER_DIR, stdio: 'inherit' })
  if (r.error || r.status !== 0) {
    console.warn(
      `WARNING: could not regenerate the *.index.bin files (${r.error ? r.error.message : `exit ${r.status}`}).\n` +
      `  Run it by hand after "npm --prefix renderer ci":  cd renderer && node ${INDEX_SCRIPT}\n` +
      '  They are gitignored and the Docker build regenerates them, so a commit is still safe —\n' +
      '  but a LOCAL server run would keep matching the new data against the old indices.'
    )
    return false
  }
  return true
}

export async function updateAptData ({ dryRun = false } = {}) {
  console.log(`Fetching the APT data snapshot from ${UPSTREAM_BASE} ...`)
  const fetched = await Promise.all(FILES.map(f => fetchText(`${UPSTREAM_BASE}/${f}`)))

  let changed = 0
  let removalsSeen = 0

  for (let i = 0; i < FILES.length; i++) {
    const file = FILES[i]
    const before = await readIfPresent(file)
    const after = fetched[i]
    const d = diffLines(before, after)

    if (before === after) {
      console.log(`${file}: unchanged (${d.after} lines)`)
      continue
    }
    changed++
    console.log(
      `${file}: ${d.before} -> ${d.after} lines ` +
      `(+${d.added.length} / -${d.removed.length})`
    )

    if (file === 'items.ndjson') {
      const nb = namespaceCounts(before)
      const na = namespaceCounts(after)
      for (const ns of [...new Set([...Object.keys(nb), ...Object.keys(na)])].sort()) {
        console.log(`  namespace ${ns}: ${nb[ns] || 0} -> ${na[ns] || 0}`)
      }
    }

    if (file === 'items.ndjson' || file === 'stats.ndjson') {
      const keysAfter = entryKeys(file, after)
      const gone = [...entryKeys(file, before)].filter(k => !keysAfter.has(k)).sort()
      if (gone.length) {
        removalsSeen += gone.length
        console.warn(`  REMOVED UPSTREAM (${gone.length}) — check nothing here is still needed:`)
        for (const k of gone) console.warn(`    ${oneLine(k)}`)
      } else {
        console.log('  removed entries: none (additions only)')
      }
    }

    if (!dryRun) await writeFile(path.join(DATA_DIR, file), after)
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written, no indices regenerated.')
    return { changed, removalsSeen }
  }
  if (changed === 0) {
    console.log('\nAlready up to date — indices left alone.')
    return { changed, removalsSeen }
  }

  console.log(`\nRegenerating the search indices (cd renderer && node ${INDEX_SCRIPT}) ...`)
  regenerateIndices()
  console.log(
    `\n${changed}/${FILES.length} file(s) updated in ${DATA_DIR}.\n` +
    'Review the numbers above, then run "npm test" before committing.'
  )
  if (removalsSeen > 0) {
    console.warn(
      `NOTE: upstream removed ${removalsSeen} entr${removalsSeen === 1 ? 'y' : 'ies'} (listed above). ` +
      'Removals are what breaks the parser silently — make sure none of them is one we rely on.'
    )
  }
  return { changed, removalsSeen }
}

// Only run when invoked directly as a CLI (not on import, e.g. in tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  updateAptData({ dryRun: process.argv.slice(2).includes('--dry-run') })
    .catch(err => {
      console.error('ERROR:', err.message)
      process.exit(1)
    })
}
