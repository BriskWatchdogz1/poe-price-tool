// The settings write path (credentials.mjs) — purely local, no network access.
// The mandatory cases: other users stay untouched, an empty field changes
// nothing, validation, mode 600, an unwritable target fails honestly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, stat, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateCredentialInput, saveNetworthUser, CredentialsError } from './credentials.mjs'

async function freshDir () {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-creds-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ---- validateCredentialInput ------------------------------------------------
test('validate: trims and accepts normal input', () => {
  const v = validateCredentialInput({ accountName: '  Name#1234 ', poesessid: ' abc123 ' })
  assert.deepEqual(v, { accountName: 'Name#1234', poesessid: 'abc123' })
})

test('validate: an empty POESESSID (whitespace counts as empty) means "do not change"', () => {
  assert.equal(validateCredentialInput({ accountName: 'A#1', poesessid: '' }).poesessid, null)
  assert.equal(validateCredentialInput({ accountName: 'A#1', poesessid: '   ' }).poesessid, null)
  assert.equal(validateCredentialInput({ accountName: 'A#1' }).poesessid, null)
})

test('validate: accountName is mandatory', () => {
  assert.throws(() => validateCredentialInput({ accountName: '', poesessid: 'x' }), CredentialsError)
  assert.throws(() => validateCredentialInput({ poesessid: 'x' }), CredentialsError)
})

test('validate: a POESESSID with whitespace/control characters is rejected — without naming the value', () => {
  for (const bad of ['ab cd', 'ab\tcd', 'ab\ncd', 'ab\u0000cd', 'ab\u007fcd']) {
    try {
      validateCredentialInput({ accountName: 'A#1', poesessid: bad })
      assert.fail('should have thrown')
    } catch (e) {
      assert.ok(e instanceof CredentialsError)
      assert.ok(!e.message.includes('ab'), 'the error message must not contain the value')
    }
  }
})

test('validate: NO rigid format — unusual lengths/characters pass through', () => {
  // If GGG changes the format, the field must not become unusable.
  assert.equal(validateCredentialInput({ accountName: 'A#1', poesessid: 'short' }).poesessid, 'short')
  const long = 'x'.repeat(200)
  assert.equal(validateCredentialInput({ accountName: 'A#1', poesessid: long }).poesessid, long)
  assert.equal(validateCredentialInput({ accountName: 'A#1', poesessid: 'WITH-hyphen_and.dot' }).poesessid, 'WITH-hyphen_and.dot')
})

// ---- saveNetworthUser -------------------------------------------------------
test('save: creates the file, mode 600, no tmp leftovers', async () => {
  const { dir, cleanup } = await freshDir()
  try {
    const path = join(dir, 'networth-users.json')
    await saveNetworthUser({ path, user: 'player1', accountName: 'A#1', poesessid: 's3cr3t' })
    const st = await stat(path)
    assert.equal(st.mode & 0o777, 0o600)
    const data = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(data, { player1: { accountName: 'A#1', poesessid: 's3cr3t' } })
    const leftovers = (await readdir(dir)).filter(f => f.includes('.tmp'))
    assert.deepEqual(leftovers, [], 'no tmp file left behind')
  } finally { await cleanup() }
})

test('save: other users in the file stay byte-for-byte untouched', async () => {
  const { dir, cleanup } = await freshDir()
  try {
    const path = join(dir, 'networth-users.json')
    const before = { player2: { accountName: 'Other#5678', poesessid: 'player2-cookie' }, extraField: { x: 1 } }
    await writeFile(path, JSON.stringify(before))
    await saveNetworthUser({ path, user: 'player1', accountName: 'A#1', poesessid: 'new' })
    const data = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(data.player2, before.player2)
    assert.deepEqual(data.extraField, before.extraField)
    assert.deepEqual(data.player1, { accountName: 'A#1', poesessid: 'new' })
  } finally { await cleanup() }
})

test('save: poesessid=null (empty field) keeps the stored value, accountName is updated', async () => {
  const { dir, cleanup } = await freshDir()
  try {
    const path = join(dir, 'networth-users.json')
    await writeFile(path, JSON.stringify({ player1: { accountName: 'Old#1', poesessid: 'kept' } }))
    const r = await saveNetworthUser({ path, user: 'player1', accountName: 'New#2', poesessid: null })
    assert.equal(r.changedPoesessid, false)
    const data = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(data.player1, { accountName: 'New#2', poesessid: 'kept' })
  } finally { await cleanup() }
})

test('save: empty field with nothing stored -> honest error (POESESSID required)', async () => {
  const { dir, cleanup } = await freshDir()
  try {
    const path = join(dir, 'networth-users.json')
    await assert.rejects(
      saveNetworthUser({ path, user: 'player1', accountName: 'A#1', poesessid: null }),
      e => e instanceof CredentialsError && e.status === 400
    )
  } finally { await cleanup() }
})

test('save: unwritable target -> CredentialsError 500, value not in the message', async () => {
  const { dir, cleanup } = await freshDir()
  try {
    await chmod(dir, 0o500) // directory read+exec only -> writing fails
    const path = join(dir, 'networth-users.json')
    try {
      await saveNetworthUser({ path, user: 'player1', accountName: 'A#1', poesessid: 'secretvalue' })
      assert.fail('should have thrown')
    } catch (e) {
      assert.ok(e instanceof CredentialsError)
      assert.equal(e.status, 500)
      assert.ok(!e.message.includes('secretvalue'), 'the error message must not contain the value')
      assert.match(e.message, /not writable/)
    }
  } finally {
    await chmod(dir, 0o700).catch(() => {})
    await cleanup()
  }
})

test('save: a corrupt existing file is NOT overwritten, honest error', async () => {
  const { dir, cleanup } = await freshDir()
  try {
    const path = join(dir, 'networth-users.json')
    await writeFile(path, '{ broken')
    await assert.rejects(
      saveNetworthUser({ path, user: 'player1', accountName: 'A#1', poesessid: 'x' }),
      e => e instanceof CredentialsError && e.status === 500 && /not valid JSON/.test(e.message)
    )
    assert.equal(await readFile(path, 'utf8'), '{ broken', 'file left untouched')
  } finally { await cleanup() }
})
