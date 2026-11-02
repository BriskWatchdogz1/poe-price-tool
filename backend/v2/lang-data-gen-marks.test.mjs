// EXPORT_MARKS against the library it quotes.
//
// classifyExportFailure() decides what a dead game-data export MEANS by
// matching three sentences that pathofexile-dat prints. That is a compromise
// and lang-data-gen.mjs admits it as one — the exit code is 1 for all three, so
// the text is the only thing left to read.
//
// The compromise has a failure mode of its own, and it is quiet: the day
// `pathofexile-dat` rewords one of its messages, the mark stops matching, the
// classification silently falls back to `unknown`, and every green test in the
// suite still passes — because every one of them feeds the OLD wording in by
// hand. The classification would be worth nothing and nothing would say so.
//
// So the marks are pinned to the installed copy here. This file reads
// node_modules and greps for the literals. When a dependency update moves one
// of them, this fails and names it; a test that builds its own input can never
// notice.
//
// Nothing here reaches the network: it reads files out of node_modules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { EXPORT_MARKS } from './lang-data-gen.mjs'

// Resolved exactly the way exportGameData() resolves the binary it runs, so
// this reads the copy that would really be executed rather than one found by a
// different rule. The package's `exports` map does not publish package.json,
// which is why the entry point is the anchor.
const DIST = path.dirname(fileURLToPath(await import.meta.resolve('pathofexile-dat/dat.js')))

/** Where each mark is printed. Part of the claim: a mark is one console.error. */
const SOURCES = {
  schema: 'cli/export-tables.js',
  column: 'cli/export-tables.js',
  cdn: 'cli/bundle-loaders.js'
}

const read = f => readFile(path.join(DIST, f), 'utf8')

test('the schema mark is still the wording the library prints', async () => {
  const src = await read(SOURCES.schema)
  assert.ok(src.includes(EXPORT_MARKS.schema),
    `pathofexile-dat no longer prints ${JSON.stringify(EXPORT_MARKS.schema)} — ` +
    'EXPORT_MARKS.schema has to be brought back in line, or the version conflict it ' +
    'classifies goes back to arriving as `unknown`')
})

test('the CDN mark still matches the line the library builds', async () => {
  const src = await read(SOURCES.cdn)
  // The template as it stands in the source, with the interpolation filled in
  // the way the runtime would fill it.
  assert.ok(src.includes('Failed to fetch ${name} from CDN.'),
    'pathofexile-dat no longer prints "Failed to fetch <name> from CDN." — EXPORT_MARKS.cdn is stale')
  const m = EXPORT_MARKS.cdn.exec('Failed to fetch Data/Mods.dat64 from CDN.')
  assert.equal(m?.[1], 'Data/Mods.dat64')
})

test('the column mark still matches the line the library builds', async () => {
  const src = await read(SOURCES.column)
  assert.ok(src.includes('doesn\'t have a column named'),
    'pathofexile-dat no longer prints "…doesn\'t have a column named…" — EXPORT_MARKS.column is stale')
  const m = EXPORT_MARKS.column.exec('Table "BaseItemTypes" doesn\'t have a column named "Name".')
  assert.deepEqual([m?.[1], m?.[2]], ['BaseItemTypes', 'Name'])
})

test('each mark begins its own line — which is what the matcher relies on', async () => {
  // classifyExportFailure() anchors every mark to the start of a line, so that
  // a bundle NAME carrying one of these sentences cannot produce a finding.
  // That anchoring is only sound while the library prints each mark as a whole
  // console.error and never inside a larger sentence.
  const printed = /console\.error\(\s*(`|')([^`']*)/g
  const lines = new Set()
  for (const f of new Set(Object.values(SOURCES))) {
    const src = await read(f)
    for (const m of src.matchAll(printed)) lines.add(m[2])
  }
  const starts = mark => [...lines].some(l => l.startsWith(mark))
  assert.ok(starts(EXPORT_MARKS.schema), 'the schema mark no longer starts its console.error')
  assert.ok(starts('Failed to fetch '), 'the CDN mark no longer starts its console.error')
  assert.ok(starts('Table "'), 'the column mark no longer starts its console.error')
})

test('the CDN mark is printed on a REFUSED answer, not on a dead connection', async () => {
  // The load-bearing fact behind the `unreachable` / `rejected` split: the
  // library prints it under `if (!response.ok)`, so an answer arrived. A
  // connection that fails throws out of the fetch and never reaches the line.
  // If that guard ever moves, the split is a guess again.
  const src = await read(SOURCES.cdn)
  const at = src.indexOf('Failed to fetch ${name} from CDN.')
  assert.ok(at > 0)
  const before = src.slice(Math.max(0, at - 400), at)
  assert.match(before, /if\s*\(\s*!\s*response\.ok\s*\)/,
    'the CDN mark is no longer guarded by `!response.ok` — classifyExportFailure() ' +
    'may no longer state that the CDN answered and refused')
})
