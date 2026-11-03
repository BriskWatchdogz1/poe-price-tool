// history-items.mjs — what the items sidecar does with a file it cannot use.
//
// Same rules as the stores in store-file.mjs (docs/bugs.md B27, B31): a
// missing file is the normal first start and stays silent; a broken one is
// moved to `<name>.broken-<stamp>` with one warning; one from a newer release,
// one that cannot be read and one that cannot be moved are never written over.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoryItems, defaultItemsPath } from './history-items.mjs'
import { createNetworthHistory } from './history.mjs'

const NOW = Date.parse('2026-11-03T10:15:00Z')
const STAMP = '2026-11-03T10-15-00-000Z'

function recorder () {
  const warnings = []
  return { warnings, log: { warn: m => warnings.push(String(m)), log: () => {} } }
}

async function fresh () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-history-items-'))
  const p = join(dir, 'networth-history-items.json')
  return { dir, p, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const GOOD = JSON.stringify({ v: 1, u: { player1: { at: 5, i: [['Divine Orb', 1, 200]] } } })

test('a missing sidecar starts empty without a word and creates nothing', async () => {
  const { dir, p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  const s = createHistoryItems(p, { log, now: () => NOW })
  assert.equal((await s.load()).size, 0)
  assert.equal(s.writable, true)
  assert.deepEqual(await readdir(dir), [])
  assert.deepEqual(warnings, [])
  await cleanup()
})

test('a current sidecar loads without a warning', async () => {
  const { p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  await writeFile(p, GOOD)
  const s = createHistoryItems(p, { log, now: () => NOW })
  const got = await s.load()
  assert.deepEqual([...got.get('player1').items], [['Divine Orb', [1, 200]]])
  assert.deepEqual(warnings, [])
  await cleanup()
})

test('broken JSON is moved aside with one warning that names path and reason, never the content', async () => {
  const { dir, p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  const content = '{"v":1,"u":{"player1":{"at":5,"i":[["secretname0123'
  await writeFile(p, content)
  const s = createHistoryItems(p, { log, now: () => NOW })
  assert.equal((await s.load()).size, 0)
  const aside = `${p}.broken-${STAMP}`
  assert.deepEqual((await readdir(dir)).sort(), ['networth-history-items.json.broken-' + STAMP])
  assert.equal(await readFile(aside, 'utf8'), content, 'the content is kept to look at')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^\[networth-history-items\] /)
  assert.ok(warnings[0].includes(p) && warnings[0].includes(aside), warnings[0])
  assert.match(warnings[0], /not usable \(/)
  assert.ok(!warnings[0].includes('secretname'), 'the content is never quoted')
  // Writable as before: the next point writes a fresh sidecar.
  assert.equal(s.writable, true)
  s.set('player1', 9, new Map([['Chaos Orb', [3, 3]]]))
  assert.equal(await s.save(), true)
  assert.equal(JSON.parse(await readFile(p, 'utf8')).u.player1.at, 9)
  assert.equal(await readFile(aside, 'utf8'), content)
  await cleanup()
})

test('a wrong shape is moved aside too: not an object, no users map, no format number', async () => {
  for (const body of ['[1,2]', 'null', '"text"', '{"v":1}', '{"v":1,"u":[]}', '{"u":{}}', '{"v":"1","u":{}}']) {
    const { dir, p, cleanup } = await fresh()
    const { log, warnings } = recorder()
    await writeFile(p, body)
    const s = createHistoryItems(p, { log, now: () => NOW })
    assert.equal((await s.load()).size, 0, body)
    assert.deepEqual(await readdir(dir), ['networth-history-items.json.broken-' + STAMP], body)
    assert.equal(warnings.length, 1, body)
    assert.equal(s.writable, true, body)
    await cleanup()
  }
})

test('a second broken file in the same millisecond does not replace the first', async () => {
  const { dir, p, cleanup } = await fresh()
  const { log } = recorder()
  await writeFile(p, 'first')
  await createHistoryItems(p, { log, now: () => NOW }).load()
  await writeFile(p, 'second')
  await createHistoryItems(p, { log, now: () => NOW }).load()
  assert.deepEqual((await readdir(dir)).sort(), [
    `networth-history-items.json.broken-${STAMP}`,
    `networth-history-items.json.broken-${STAMP}-2`
  ])
  assert.equal(await readFile(`${p}.broken-${STAMP}`, 'utf8'), 'first')
  await cleanup()
})

test('a sidecar from a newer release is left byte for byte and never written over', async () => {
  const { dir, p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  const body = JSON.stringify({ v: 2, u: { player1: { at: 5, i: [] } }, more: true })
  await writeFile(p, body)
  const s = createHistoryItems(p, { log, now: () => NOW })
  assert.equal((await s.load()).size, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /newer/)
  assert.equal(s.writable, false)
  // history.mjs hands its own writable flag down before every save; that must
  // not undo what the load decided.
  s.writable = true
  assert.equal(s.writable, false)
  s.set('player1', 9, new Map([['Chaos Orb', [3, 3]]]))
  assert.equal(await s.save(), false)
  assert.equal(await readFile(p, 'utf8'), body)
  assert.deepEqual(await readdir(dir), ['networth-history-items.json'])
  await cleanup()
})

test('a sidecar that cannot be read is never written over', async () => {
  const { p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  await writeFile(p, GOOD)
  const readFileImpl = async () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e }
  const s = createHistoryItems(p, { log, now: () => NOW, readFileImpl })
  assert.equal((await s.load()).size, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /could not read .*EACCES.*not writing over it/)
  s.writable = true
  assert.equal(s.writable, false)
  s.set('player1', 9, new Map([['Chaos Orb', [3, 3]]]))
  assert.equal(await s.save(), false)
  assert.equal(await readFile(p, 'utf8'), GOOD)
  await cleanup()
})

test('a broken sidecar that cannot be moved is left alone and never written over', async () => {
  const { p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  await writeFile(p, 'not json')
  const renameImpl = async () => { const e = new Error('read-only'); e.code = 'EROFS'; throw e }
  const s = createHistoryItems(p, { log, now: () => NOW, renameImpl })
  assert.equal((await s.load()).size, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /could not be moved aside \(EROFS\)/)
  s.writable = true
  assert.equal(s.writable, false)
  s.set('player1', 9, new Map())
  assert.equal(await s.save(), false)
  assert.equal(await readFile(p, 'utf8'), 'not json')
  await cleanup()
})

test('a failed write answers false and leaves the previous file as it was', async () => {
  // history.mjs reads this answer: only a true lets the guard file leave names
  // to the sidecar (docs/bugs.md B34).
  const { dir, p, cleanup } = await fresh()
  const { log } = recorder()
  await writeFile(p, GOOD)
  // A disk that fills up mid-write leaves part of the tmp file behind and then
  // throws; the seam writes the tmp file for real before it fails, so the
  // check below sees whether save() removes it again.
  const writeFileImpl = async (...a) => {
    await writeFile(...a)
    const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e
  }
  const s = createHistoryItems(p, { log, now: () => NOW, writeFileImpl })
  assert.equal((await s.load()).size, 1)
  s.set('player1', 9, new Map([['Chaos Orb', [1, 1]]]))
  assert.equal(s.writable, true)
  assert.equal(await s.save(), false)
  assert.equal(await readFile(p, 'utf8'), GOOD)
  assert.deepEqual(await readdir(dir), ['networth-history-items.json'], 'no tmp file left behind')
  await cleanup()
})

test('a failed write is logged once per error code', async () => {
  // Before, save() answered false without a word: an operator whose disk was
  // full saw the brake's memory grow and nothing that said why. One line per
  // error code, like the guard file's (history.mjs, persistGuard), so a write
  // that fails every minute does not fill the log.
  const { p, cleanup } = await fresh()
  const { log, warnings } = recorder()
  let code = 'ENOSPC'
  const writeFileImpl = async () => { const e = new Error('write failed'); e.code = code; throw e }
  const s = createHistoryItems(p, { log, now: () => NOW, writeFileImpl })
  await s.load()
  s.set('player1', 9, new Map([['Chaos Orb', [1, 1]]]))
  assert.equal(await s.save(), false)
  assert.equal(await s.save(), false)
  assert.equal(warnings.length, 1, 'the same code twice is one line')
  assert.ok(warnings[0].includes(p) && warnings[0].includes('ENOSPC'), 'naming the file and the code')
  code = 'EACCES'
  assert.equal(await s.save(), false)
  assert.equal(warnings.length, 2, 'another code is another line')
  assert.ok(warnings[1].includes('EACCES'))
  await cleanup()
})

test('the history hands its log to the sidecar, also when there is no series yet', async () => {
  for (const withSeries of [true, false]) {
    const { dir, cleanup } = await fresh()
    const file = join(dir, 'networth-history.ndjson')
    if (withSeries) await writeFile(file, JSON.stringify({ u: 'player1', at: NOW - 60_000, c: 100, cd: 200 }) + '\n')
    await writeFile(defaultItemsPath(file), '{"v":1,"u":')
    const { log, warnings } = recorder()
    const h = createNetworthHistory(file, { now: () => NOW, log })
    await h.load()
    const mine = warnings.filter(w => w.startsWith('[networth-history-items]'))
    assert.equal(mine.length, 1, `series ${withSeries}: ${warnings.join(' | ')}`)
    assert.ok((await readdir(dir)).includes(`networth-history-items.json.broken-${STAMP}`), `series ${withSeries}`)
    await cleanup()
  }
})
