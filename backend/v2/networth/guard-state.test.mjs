// The price guard's memory file (guard-state.mjs): where it lives, how it is
// read and written, and what happens to a file it cannot use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuardStateFile, defaultGuardStatePath, GUARD_STATE_SCHEMA } from './guard-state.mjs'

async function tmpDir () { return mkdtemp(join(tmpdir(), 'guardstate-')) }
function recorder () {
  const lines = []
  return { lines, warn: (...a) => lines.push(a.join(' ')), log: (...a) => lines.push(a.join(' ')) }
}
const STATE = {
  ratio: [212.4, 1_700_000_000_000],
  users: { player1: { held: [['The Twilight Moon', 1_699_990_000_000, 1_700_000_000_000, 0]], known: [['The Scavenger', 1_699_999_000_000, 1]] } },
  cut: 0
}
const NOW = Date.parse('2026-11-02T10:15:00.000Z')

test('defaultGuardStatePath follows the sidecar rule', () => {
  assert.equal(defaultGuardStatePath('/config/networth-history.ndjson'), '/config/networth-history-guard.json')
  assert.equal(defaultGuardStatePath('/config/series'), '/config/series-guard.json')
})

test('a missing file is an empty memory and nothing is created', async () => {
  const dir = await tmpDir()
  const f = createGuardStateFile(join(dir, 'networth-history-guard.json'), { log: recorder() })
  assert.equal(await f.load(), null)
  assert.equal(f.writable, true)
  assert.deepEqual(await readdir(dir), [])
})

test('save and load round-trip, and an unchanged memory is not rewritten', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'networth-history-guard.json')
  const a = createGuardStateFile(path, { league: 'Mercenaries', now: () => NOW, log: recorder() })
  assert.equal(await a.save(() => STATE), true)
  const onDisk = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(onDisk.schema_version, GUARD_STATE_SCHEMA)
  assert.equal(onDisk.savedAt, NOW)
  assert.equal('cut' in onDisk, false, 'the cut count is for the log, not the file')

  let writes = 0
  const writeImpl = (...a) => { writes++; return fsWriteFile(...a) }
  const b = createGuardStateFile(path, { league: 'Mercenaries', log: recorder(), writeImpl })
  const doc = await b.load()
  assert.equal(doc.league, 'Mercenaries')
  assert.deepEqual(doc.ratio, STATE.ratio)
  assert.deepEqual(doc.users, STATE.users)
  assert.equal(await b.save(() => STATE), false, 'the same memory is not written again')
  assert.equal(writes, 0)
  assert.equal(await b.save(() => ({ ...STATE, ratio: [213, NOW] })), true)
  assert.equal(writes, 1)
  assert.deepEqual((await readdir(dir)).sort(), ['networth-history-guard.json'], 'no tmp file left behind')
})

test('a broken file is moved to .broken-<stamp> and the guard starts empty', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'networth-history-guard.json')
  await writeFile(path, '{ "users": "sentinel-content-x', 'utf8')
  const log = recorder()
  const f = createGuardStateFile(path, { now: () => NOW, log })
  assert.equal(await f.load(), null)
  assert.equal(f.writable, true)
  assert.deepEqual(await readdir(dir), ['networth-history-guard.json.broken-2026-11-02T10-15-00-000Z'])
  assert.equal(log.lines.length, 1)
  assert.match(log.lines[0], /networth-history-guard\.json/)
  assert.match(log.lines[0], /starting with an empty memory/)
  assert.doesNotMatch(log.lines[0], /sentinel-content-x/, 'the file content is never quoted')
})

test('a file without users is broken in shape, and moved aside as well', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'networth-history-guard.json')
  await writeFile(path, JSON.stringify({ schema_version: 1, users: [] }), 'utf8')
  const log = recorder()
  const f = createGuardStateFile(path, { now: () => NOW, log })
  assert.equal(await f.load(), null)
  assert.equal((await readdir(dir)).length, 1)
  assert.match(log.lines[0], /users is missing or not an object/)
})

test('a file from a newer release is left alone and never written', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'networth-history-guard.json')
  const raw = JSON.stringify({ schema_version: GUARD_STATE_SCHEMA + 1, users: { p: { future: true } } })
  await writeFile(path, raw, 'utf8')
  const f = createGuardStateFile(path, { log: recorder() })
  assert.equal(await f.load(), null)
  assert.equal(f.writable, false)
  assert.equal(await f.save(() => STATE), false)
  assert.equal(await readFile(path, 'utf8'), raw, 'byte for byte unchanged')
})

test('a file of another league is ignored and replaced by the next save', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'networth-history-guard.json')
  await writeFile(path, JSON.stringify({ schema_version: 1, savedAt: NOW, league: 'Old', ratio: null, users: STATE.users }), 'utf8')
  const log = recorder()
  const f = createGuardStateFile(path, { league: 'New', log })
  assert.equal(f.foreignLeague, false)
  assert.equal(await f.load(), null)
  assert.equal(f.foreignLeague, true, 'the caller learns why the memory is empty')
  assert.equal(log.lines.length, 1)
  assert.match(log.lines[0], /"Old"/)
  assert.match(log.lines[0], /"New"/)
  assert.equal(await f.save(() => STATE), true)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).league, 'New')
  const again = createGuardStateFile(path, { league: 'New', log })
  assert.ok(await again.load())
  assert.equal(again.foreignLeague, false, 'a file of this league is not foreign')
})

test('overlapping saves end with the newest state on disk', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'networth-history-guard.json')
  let writes = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const writeImpl = async (...a) => {
    writes++
    if (writes === 1) await gate
    return fsWriteFile(...a)
  }
  const f = createGuardStateFile(path, { log: recorder(), writeImpl })
  const s = n => ({ ratio: [n, NOW], users: {} })
  const first = f.save(() => s(1))
  const second = f.save(() => s(2))
  const third = f.save(() => s(3))
  assert.equal(await second, false)
  assert.equal(await third, false)
  release()
  assert.equal(await first, true)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).ratio, [3, NOW])
  assert.ok(writes <= 2, `written ${writes} times`)
})

test('a failed write leaves no tmp file and is thrown to the caller', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'networth-history-guard.json')
  const renameImpl = async () => { const e = new Error('nope'); e.code = 'EACCES'; throw e }
  const f = createGuardStateFile(path, { log: recorder(), renameImpl })
  await assert.rejects(f.save(() => STATE), /nope/)
  assert.deepEqual(await readdir(dir), [])
})

test('a file that cannot be read is never written over', async () => {
  const { chmod } = await import('node:fs/promises')
  const dir = await tmpDir()
  const path = join(dir, 'networth-history-guard.json')
  const raw = JSON.stringify({ schema_version: 1, users: {} })
  await writeFile(path, raw, 'utf8')
  await chmod(path, 0o000)
  try {
    const f = createGuardStateFile(path, { log: recorder() })
    await assert.rejects(f.load(), e => e.code === 'EACCES')
    assert.equal(f.writable, false)
    assert.equal(await f.save(() => STATE), false)
  } finally {
    await chmod(path, 0o644)
  }
  assert.equal(await readFile(path, 'utf8'), raw)
})
