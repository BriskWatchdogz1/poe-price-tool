// generatorVersion() in lang-data-gen.mjs: the identity of the derivation that
// built a localized set, computed at runtime from the generator files the image
// carries. Pinned here: it is stable, it moves with any of its inputs, and a
// missing input makes it unknown (null) instead of throwing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatorVersion, GENERATOR_INPUTS, GENERATOR_PACKAGES } from './lang-data-gen.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// A copy of the generator's inputs in the layout the image has:
// <root>/backend/v2/<files> and <root>/node_modules/<package>/package.json.
async function copyLayout (t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ppt-genver-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = path.join(root, 'backend/v2')
  await mkdir(dir, { recursive: true })
  for (const f of GENERATOR_INPUTS) {
    await writeFile(path.join(dir, f), await readFile(path.join(HERE, f)))
  }
  for (const pkg of GENERATOR_PACKAGES) {
    await mkdir(path.join(root, 'node_modules', pkg), { recursive: true })
    await writeFile(path.join(root, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0' }))
  }
  return { root, dir }
}

test('the inputs are the generator, its derivation, its tables and the exporter packages', () => {
  assert.deepEqual(GENERATOR_INPUTS, ['lang-data-gen.mjs', 'lang-derive.mjs', 'lang-statdesc.mjs', 'lang-pseudo-matchers.json'])
  assert.deepEqual(GENERATOR_PACKAGES, ['pathofexile-dat', 'pathofexile-dat-schema'])
})

// Local files the generator modules reach that are deliberately NOT part of the
// version, each with the reason. Everything else a generator input imports or
// reads next to itself must be in GENERATOR_INPUTS: a module that takes over
// part of the derivation and is missing there would let a fix to it wait for
// the next game patch again, with no test noticing.
const NOT_INPUTS = new Map([
  ['mod-text-pairs.mjs', 'only the name of the text-pairs file; the pairs are built in lang-derive.mjs'],
  ['apt-index.mjs', 'the index bins, which the data refresher rebuilds itself after adopting a set'],
  ['patch-version.mjs', 'the pattern a patch string is checked against; it does not shape the output'],
  ['check-failure.mjs', 'the failure objects a run reports with; they do not shape the output'],
  ['version.mjs', 'the tool version in the User-Agent of the patch lookup; it does not shape the output, and as an input every release would rebuild every localized set'],
  ['../../renderer/public/data', 'the English data set, compared separately as the English fingerprint']
])

/** Local references in a module: imports (static, side-effect, dynamic) and
 *  files joined onto the module's own directory. */
function localRefs (source) {
  const refs = new Set()
  const patterns = [
    /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /path\.join\(\s*HERE\s*,\s*['"]([^'"]+)['"]/g
  ]
  for (const re of patterns) {
    for (const m of source.matchAll(re)) refs.add(m[1].replace(/^\.\//, ''))
  }
  return refs
}

/** Every local reference of every generator module, as "<module> -> <ref>". */
async function generatorRefs () {
  const out = []
  for (const f of GENERATOR_INPUTS.filter(f => f.endsWith('.mjs'))) {
    for (const ref of localRefs(await readFile(path.join(HERE, f), 'utf8'))) out.push([f, ref])
  }
  return out
}

test('the reference scanner finds every way a module reaches a local file', () => {
  const src = [
    "import { a } from './one.mjs'",
    'import {\n  b,\n  c\n} from "./two.mjs"',
    "import './three.mjs'",
    "const m = await import('./four.mjs')",
    "const T = path.join(HERE, 'five.json')",
    "import { readFile } from 'node:fs/promises'"
  ].join('\n')
  assert.deepEqual([...localRefs(src)].sort(), ['five.json', 'four.mjs', 'one.mjs', 'three.mjs', 'two.mjs'])
})

test('everything a generator module reaches locally is an input itself or a named exception', async () => {
  // Checked over every .mjs in GENERATOR_INPUTS, so a new module added to the
  // list has its own imports checked as well: the closure is transitive.
  const refs = await generatorRefs()
  const missing = refs
    .filter(([, ref]) => !GENERATOR_INPUTS.includes(ref) && !NOT_INPUTS.has(ref))
    .map(([f, ref]) => `${f} -> ${ref}`)
  assert.deepEqual(missing, [],
    'add each to GENERATOR_INPUTS in lang-data-gen.mjs (and the Dockerfile), or to NOT_INPUTS here with the reason')
  // An exception nothing reaches any more is a stale reason: drop it.
  const reached = new Set(refs.map(([, ref]) => ref))
  assert.deepEqual([...NOT_INPUTS.keys()].filter(k => !reached.has(k)), [], 'every exception is still reached')
})

test('every input is copied into the image, or the version there would always be unknown', async () => {
  const dockerfile = await readFile(path.join(HERE, '../../Dockerfile'), 'utf8')
  for (const f of GENERATOR_INPUTS) {
    assert.ok(dockerfile.includes(`/app/backend/v2/${f} `), `Dockerfile copies backend/v2/${f}`)
  }
  for (const pkg of GENERATOR_PACKAGES) {
    assert.ok(dockerfile.includes(`/app/node_modules/${pkg} `), `Dockerfile copies node_modules/${pkg}`)
  }
})

test('the version of this checkout is a 16-digit hex string, the same on every call', async () => {
  const a = await generatorVersion()
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.equal(await generatorVersion(), a)
})

test('a copy in the image layout has the same version as the checkout when the package versions match', async t => {
  const { root, dir } = await copyLayout(t)
  for (const pkg of GENERATOR_PACKAGES) {
    await writeFile(path.join(root, 'node_modules', pkg, 'package.json'),
      await readFile(path.join(HERE, '../../node_modules', pkg, 'package.json')))
  }
  assert.equal(await generatorVersion({ dir }), await generatorVersion())
})

test('any change to an input file moves the version — a comment as well', async t => {
  const { dir } = await copyLayout(t)
  const before = await generatorVersion({ dir })
  for (const f of GENERATOR_INPUTS) {
    const p = path.join(dir, f)
    const original = await readFile(p)
    await writeFile(p, Buffer.concat([original, Buffer.from('\n')]))
    assert.notEqual(await generatorVersion({ dir }), before, `${f} changed`)
    await writeFile(p, original)
  }
  assert.equal(await generatorVersion({ dir }), before, 'and it is the content, nothing else')
})

test('an upgrade of the exporter packages moves the version', async t => {
  const { root, dir } = await copyLayout(t)
  const before = await generatorVersion({ dir })
  for (const pkg of GENERATOR_PACKAGES) {
    const p = path.join(root, 'node_modules', pkg, 'package.json')
    await writeFile(p, JSON.stringify({ name: pkg, version: '2.0.0' }))
    assert.notEqual(await generatorVersion({ dir }), before, `${pkg} upgraded`)
    await writeFile(p, JSON.stringify({ name: pkg, version: '1.0.0' }))
  }
})

test('a missing input file or package makes the version unknown (null), not an error', async t => {
  const { root, dir } = await copyLayout(t)
  await rm(path.join(dir, 'lang-statdesc.mjs'))
  assert.equal(await generatorVersion({ dir }), null)

  const second = await copyLayout(t)
  await rm(path.join(second.root, 'node_modules', 'pathofexile-dat-schema'), { recursive: true })
  assert.equal(await generatorVersion({ dir: second.dir }), null)
  assert.ok(root)
})
