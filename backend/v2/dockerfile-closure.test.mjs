// The runtime image copies backend/v2 FILE BY FILE (Dockerfile), so a module
// added to server.mjs's import graph and not added there crashes the container
// on boot with ERR_MODULE_NOT_FOUND — and nothing in the test suite notices,
// because the suite runs against the source tree where every file is present.
//
// That is not hypothetical: the whole second-language set (engine-instances,
// user-langs, mod-text-pairs, gap-log, lang-skew, admin-auth) plus the
// generator (lang-data-gen and its two helpers) was missing from the image
// until this test was written.
//
// So: walk the real import graph from server.mjs and require every file in it
// to be reachable in the image. `networth/` is copied as a whole directory, and
// so is `frontend/` — a prefix that the Dockerfile copies wholesale satisfies
// everything below it. Anything else has to be named.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const REL = p => path.relative(REPO, p).split(path.sep).join('/')

// Static `from '...'` and dynamic `import('...')`, relative specifiers only.
const SPECIFIER = /from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]/g

function importClosure (entry) {
  const seen = new Set()
  const unresolved = []
  const walk = file => {
    if (seen.has(file)) return
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(SPECIFIER)) {
      const target = path.resolve(path.dirname(file), m[1] ?? m[2])
      if (existsSync(target)) walk(target)
      else unresolved.push(`${REL(file)} -> ${m[1] ?? m[2]}`)
    }
  }
  walk(entry)
  return { files: [...seen], unresolved }
}

test('every module server.mjs imports is copied into the runtime image', () => {
  const { files, unresolved } = importClosure(path.join(HERE, 'server.mjs'))
  assert.deepEqual(unresolved, [], 'import specifiers that resolve to nothing on disk')

  const dockerfile = readFileSync(path.join(REPO, 'Dockerfile'), 'utf8')
  // Whole directories the Dockerfile copies in one go — everything under them
  // travels along and needs no line of its own.
  const wholeDirs = ['backend/v2/networth/', 'backend/v2/frontend/']

  const missing = files
    .map(REL)
    .filter(rel => !wholeDirs.some(d => rel.startsWith(d)))
    .filter(rel => !dockerfile.includes(`/app/${rel} `) && !dockerfile.includes(`/app/${rel}\t`))
    .sort()

  assert.deepEqual(missing, [], 'modules missing from the runtime stage of the Dockerfile')
})

test('the data files the language generator reads at runtime are in the image', () => {
  const dockerfile = readFileSync(path.join(REPO, 'Dockerfile'), 'utf8')
  // Read by lang-data-gen.mjs (PSEUDO_TABLE) rather than imported, so the graph
  // walk above cannot see it.
  assert.ok(
    dockerfile.includes('/app/backend/v2/lang-pseudo-matchers.json '),
    'lang-pseudo-matchers.json is missing from the runtime stage'
  )
  // Read by version.mjs (readFileSync) rather than imported, so the graph walk
  // cannot see it either — and without it the server reports "unknown" as its
  // own version, which only shows once the release check runs.
  assert.ok(
    /^COPY .*\/app\/package\.json /m.test(dockerfile),
    'package.json is missing from the runtime stage'
  )
  // Resolved at call time via import.meta.resolve, so it is invisible to the
  // graph walk as well — and its absence only shows on the first German
  // generation run, months after the deploy.
  for (const pkg of ['pathofexile-dat', 'pathofexile-dat-schema', 'ooz-wasm']) {
    assert.ok(
      dockerfile.includes(`/app/node_modules/${pkg} `),
      `node_modules/${pkg} is missing from the runtime stage`
    )
  }
})
