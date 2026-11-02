// The runner's total line, and the example of it in CONTRIBUTING.md.
//
// CONTRIBUTING used to show a MEASURED example ("91 files   1018 pass   0 fail
// 0 skip") and quote the pass count once more in the prose around it. Both were
// stale within days — the tree reported 92 files and 1068 pass by 2026-08-11 —
// and a half-correction would have left the paragraph contradicting itself,
// which is why an earlier pass left them alone. The counts were never what the
// passage is about: what it teaches is the SHAPE of the line and the two zeros
// in it. So the document names no count any more, and this test keeps the two
// halves of that decision honest — the shape it does show has to be the shape
// the runner prints, and no number that can age may creep back into it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
/** The column words of a total line, with placeholders and counts removed. */
const columns = s => s.replace(/\$\{[^}]*\}/g, ' ').replace(/<[^>]*>/g, ' ').match(/[a-z]+/g)

test('the total line documented in CONTRIBUTING.md is the one run-tests.mjs prints', () => {
  const template = /console\.log\(`([^`]*\bfiles\b[^`]*\bskip\b)`/.exec(read('./run-tests.mjs'))
  assert.ok(template, 'run-tests.mjs no longer prints a total line this test can find')

  const example = read('../../CONTRIBUTING.md').split('\n')
    .find(l => /\bfiles\b.*\bpass\b.*\bfail\b.*\bskip\b/.test(l))
  assert.ok(example, 'CONTRIBUTING.md no longer shows the runner total line')

  assert.deepEqual(columns(example), columns(template[1]),
    'the documented example and the runner disagree about the columns')
})

test('the documented example claims no count that can age', () => {
  const example = read('../../CONTRIBUTING.md').split('\n')
    .find(l => /\bfiles\b.*\bpass\b.*\bskip\b/.test(l))
  // The only numbers in it are the two zeros, and those are the claim: no
  // failure, nothing skipped. Everything else is a placeholder on purpose.
  assert.deepEqual(example.match(/\d+/g), ['0', '0'],
    'a file count or a pass count is back in the example, and it will be wrong tomorrow')
})
