// store-file.mjs — what a /config store does with a file it cannot use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadVersionedJson, moveAside, asideStamp } from './store-file.mjs'

const NOW = Date.parse('2026-11-02T10:15:00Z')
const STAMP = '2026-11-02T10-15-00-000Z'

function recorder () {
  const warnings = []
  const infos = []
  return { warnings, infos, log: { warn: m => warnings.push(m), log: m => infos.push(m) } }
}

async function fresh () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-store-file-'))
  const p = join(dir, 'store.json')
  return { dir, p, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const usersShape = d => (d.users && typeof d.users === 'object' && !Array.isArray(d.users)) ? null : 'users is missing or not an object'

function opts (log, extra = {}) {
  return { tag: 'test-store', schemaVersion: 2, shapeProblem: usersShape, emptyMeans: 'starting empty, it refills', log, now: () => NOW, ...extra }
}

test('asideStamp has the shape of the data refresher snapshot dirs', () => {
  assert.equal(asideStamp(NOW), STAMP)
})

test("a missing file is 'missing', writable, and nothing is created", async () => {
  const { dir, p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  const r = await loadVersionedJson(p, opts(log))
  assert.deepEqual(r, { outcome: 'missing', data: null, writable: true })
  assert.deepEqual(await readdir(dir), [])
  assert.equal(warnings.length, 0)
  await cleanup()
})

test('a current file loads as it is', async () => {
  const { p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  await writeFile(p, JSON.stringify({ schema_version: 2, users: { a: {} } }))
  const r = await loadVersionedJson(p, opts(log))
  assert.equal(r.outcome, 'loaded')
  assert.equal(r.writable, true)
  assert.deepEqual(r.data, { schema_version: 2, users: { a: {} } })
  assert.equal(warnings.length, 0)
  await cleanup()
})

test('broken JSON is moved to <name>.broken-<stamp> with one warning that names path and reason, never the content', async () => {
  const { p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  const content = '{ "users": sessionvalue0123456789abcdef'
  await writeFile(p, content)
  const r = await loadVersionedJson(p, opts(log))
  assert.deepEqual(r, { outcome: 'moved', data: null, writable: true })
  const aside = `${p}.broken-${STAMP}`
  await stat(aside)
  assert.equal(await readFile(aside, 'utf8'), content)
  assert.equal(existsSync(p), false)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes(p))
  assert.ok(warnings[0].includes(`.broken-${STAMP}`))
  assert.ok(warnings[0].includes('invalid JSON'))
  assert.ok(warnings[0].includes('starting empty, it refills'))
  assert.ok(warnings[0].startsWith('[test-store] '))
  assert.ok(!warnings[0].includes('sessionvalue0123456789abcdef'))
  await cleanup()
})

test('an array, a scalar and a document without schema_version are broken', async () => {
  const cases = [
    ['[]', 'not a JSON object'],
    ['42', 'not a JSON object'],
    ['null', 'not a JSON object'],
    ['{"users":{}}', 'no usable schema_version'],
    ['{"schema_version":"2","users":{}}', 'no usable schema_version'],
    ['{"schema_version":0,"users":{}}', 'no usable schema_version']
  ]
  for (const [content, reason] of cases) {
    const { p, cleanup } = await fresh()
    const { log, warnings } = recorder()
    await writeFile(p, content)
    const r = await loadVersionedJson(p, opts(log))
    assert.equal(r.outcome, 'moved', content)
    assert.equal(warnings.length, 1, content)
    assert.ok(warnings[0].includes(reason), `${content}: ${warnings[0]}`)
    assert.equal(existsSync(p), false, content)
    await cleanup()
  }
})

test("a wrong shape at the current version is broken, with the store's own reason", async () => {
  const { p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  await writeFile(p, JSON.stringify({ schema_version: 2, users: null }))
  const r = await loadVersionedJson(p, opts(log))
  assert.equal(r.outcome, 'moved')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('users is missing or not an object'))
  assert.ok(warnings[0].includes('starting empty, it refills'))
  await cleanup()
})

test('a newer schema_version is left byte for byte and the store is told not to write', async () => {
  const { dir, p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  const content = JSON.stringify({ schema_version: 3, users: { a: {} } })
  await writeFile(p, content)
  const r = await loadVersionedJson(p, opts(log))
  assert.deepEqual(r, { outcome: 'newer', data: null, writable: false })
  assert.equal(await readFile(p, 'utf8'), content)
  assert.equal((await readdir(dir)).filter(f => /\.broken-/.test(f)).length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /schema_version 3, newer than the 2/)
  assert.ok(warnings[0].includes(p))
  await cleanup()
})

test('an older version without a migration is broken; with one it is migrated in memory and the file waits for the next save', async () => {
  {
    const { p, cleanup } = await fresh()
    const { log, warnings } = recorder()
    await writeFile(p, JSON.stringify({ schema_version: 1, snapshots: {} }))
    const r = await loadVersionedJson(p, opts(log))
    assert.equal(r.outcome, 'moved')
    assert.ok(warnings[0].includes('schema_version 1 is older than 2 and this version has no migration for it'))
    await cleanup()
  }
  {
    const { p, cleanup } = await fresh()
    const { log, warnings, infos } = recorder()
    const content = JSON.stringify({ schema_version: 1, snapshots: {} })
    await writeFile(p, content)
    const r = await loadVersionedJson(p, opts(log, { migrate: d => ({ ...d, schema_version: 2, users: {} }) }))
    assert.equal(r.outcome, 'migrated')
    assert.equal(r.writable, true)
    assert.equal(r.data.schema_version, 2)
    assert.equal(await readFile(p, 'utf8'), content)
    assert.equal(warnings.length, 0)
    assert.equal(infos.length, 1)
    assert.ok(infos[0].includes('migrated to 2'))
    await cleanup()
  }
})

test('a migration that throws or returns the wrong version counts as broken', async () => {
  {
    const { p, cleanup } = await fresh()
    const { log, warnings } = recorder()
    await writeFile(p, JSON.stringify({ schema_version: 1 }))
    const r = await loadVersionedJson(p, opts(log, { migrate: () => { throw new Error('boom') } }))
    assert.equal(r.outcome, 'moved')
    assert.ok(warnings[0].includes('the migration from schema_version 1 failed (boom)'))
    await cleanup()
  }
  {
    const { p, cleanup } = await fresh()
    const { log, warnings } = recorder()
    await writeFile(p, JSON.stringify({ schema_version: 1 }))
    const r = await loadVersionedJson(p, opts(log, { migrate: () => ({ schema_version: 1 }) }))
    assert.equal(r.outcome, 'moved')
    assert.ok(warnings[0].includes('it did not produce schema_version 2'))
    await cleanup()
  }
})

test('a migrated document still has to pass the shape check', async () => {
  const { p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  await writeFile(p, JSON.stringify({ schema_version: 1 }))
  const r = await loadVersionedJson(p, opts(log, { migrate: d => ({ ...d, schema_version: 2 }) }))
  assert.equal(r.outcome, 'moved')
  assert.ok(warnings[0].includes('users is missing or not an object'))
  await cleanup()
})

test('two broken files in the same millisecond do not overwrite each other', async () => {
  const { p, cleanup } = await fresh()
  const { log } = recorder()
  await writeFile(p, '{ first')
  await loadVersionedJson(p, opts(log))
  await writeFile(p, '{ second')
  await loadVersionedJson(p, opts(log))
  assert.equal(await readFile(`${p}.broken-${STAMP}`, 'utf8'), '{ first')
  assert.equal(await readFile(`${p}.broken-${STAMP}-2`, 'utf8'), '{ second')
  await cleanup()
})

test('a file that cannot be moved aside is left untouched and the store must not write', async () => {
  const { p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  await writeFile(p, '{ broken')
  const renameImpl = async () => { const e = new Error('read-only file system'); e.code = 'EROFS'; throw e }
  const r = await loadVersionedJson(p, opts(log, { renameImpl }))
  assert.deepEqual(r, { outcome: 'unmovable', data: null, writable: false })
  assert.equal(await readFile(p, 'utf8'), '{ broken')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('could not be moved aside (EROFS)'))
  await cleanup()
})

test('a read error other than ENOENT is thrown, as before', async () => {
  const { dir, cleanup } = await fresh()
  const { log } = recorder()
  // A directory where the file should be: EISDIR.
  await assert.rejects(loadVersionedJson(dir, opts(log)), e => e.code === 'EISDIR')
  await cleanup()
})

test('moveAside: label, stamp and suffix, and it returns the new path', async () => {
  const { p, cleanup } = await fresh()
  await writeFile(p, 'a')
  assert.equal(await moveAside(p, { now: () => NOW }), `${p}.broken-${STAMP}`)
  await writeFile(p, 'b')
  assert.equal(await moveAside(p, { now: () => NOW }), `${p}.broken-${STAMP}-2`)
  await writeFile(p, 'c')
  assert.equal(await moveAside(p, { now: () => NOW }), `${p}.broken-${STAMP}-3`)
  await writeFile(p, 'd')
  assert.equal(await moveAside(p, { label: 'old', now: () => NOW }), `${p}.old-${STAMP}`)
  await cleanup()
})
