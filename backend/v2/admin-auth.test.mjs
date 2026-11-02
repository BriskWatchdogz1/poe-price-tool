// The partition in front of the admin view. What is pinned here is exactly the
// state model the design doc fixes (section 6): the password comes from a
// plaintext file, is checked on EVERY request out of a header, and nothing is
// remembered between requests — so a changed file takes effect immediately and
// there is no session to expire.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAdminAuth, ADMIN_PASSWORD_HEADER, DEFAULT_ADMIN_PASSWORD, ADMIN_MISSING, ADMIN_WRONG
} from './admin-auth.mjs'

const quiet = { log () {}, warn () {} }
const hdr = v => ({ [ADMIN_PASSWORD_HEADER]: v })

test('no header at all is refused, and says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-admin-'))
  try {
    const auth = createAdminAuth({ path: join(dir, 'pw'), log: quiet })
    assert.deepEqual(await auth.check({}), { ok: false, reason: ADMIN_MISSING })
    assert.deepEqual(await auth.check(hdr('')), { ok: false, reason: ADMIN_MISSING })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a wrong password is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-admin-'))
  try {
    const path = join(dir, 'pw')
    await writeFile(path, 'hunter2')
    const auth = createAdminAuth({ path, log: quiet })
    assert.deepEqual(await auth.check(hdr('admin')), { ok: false, reason: ADMIN_WRONG })
    assert.deepEqual(await auth.check(hdr('hunter3')), { ok: false, reason: ADMIN_WRONG })
    assert.deepEqual(await auth.check(hdr('hunter2')), { ok: true })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('with no file the documented default is in force', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-admin-'))
  try {
    const auth = createAdminAuth({ path: join(dir, 'does-not-exist'), log: quiet })
    assert.equal(await auth.expected(), DEFAULT_ADMIN_PASSWORD)
    assert.deepEqual(await auth.check(hdr(DEFAULT_ADMIN_PASSWORD)), { ok: true })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a trailing newline from an editor does not lock the operator out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-admin-'))
  try {
    const path = join(dir, 'pw')
    await writeFile(path, '  s3cret \n\n')
    const auth = createAdminAuth({ path, log: quiet })
    assert.deepEqual(await auth.check(hdr('s3cret')), { ok: true })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an empty file falls back to the default rather than accepting everything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-admin-'))
  try {
    const path = join(dir, 'pw')
    await writeFile(path, '   \n')
    const auth = createAdminAuth({ path, log: quiet })
    assert.equal(await auth.expected(), DEFAULT_ADMIN_PASSWORD)
    assert.deepEqual(await auth.check(hdr('')), { ok: false, reason: ADMIN_MISSING })
    assert.deepEqual(await auth.check(hdr('anything')), { ok: false, reason: ADMIN_WRONG })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// The consequence of "no cache, read the file every time" — and the reason the
// design doc can promise "changeable by anyone with server access".
test('editing the file takes effect on the very next request, with no restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-admin-'))
  try {
    const path = join(dir, 'pw')
    await writeFile(path, 'first')
    const auth = createAdminAuth({ path, log: quiet })
    assert.deepEqual(await auth.check(hdr('first')), { ok: true })
    await writeFile(path, 'second')
    assert.deepEqual(await auth.check(hdr('first')), { ok: false, reason: ADMIN_WRONG })
    assert.deepEqual(await auth.check(hdr('second')), { ok: true })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('ensureFile writes the default once and never overwrites an existing password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-admin-'))
  try {
    const path = join(dir, 'sub', 'admin-password')
    const auth = createAdminAuth({ path, log: quiet })
    assert.equal(await auth.ensureFile(), true, 'created on first boot, so the knob is findable')
    assert.equal((await readFile(path, 'utf8')).trim(), DEFAULT_ADMIN_PASSWORD)

    await writeFile(path, 'operator-chose-this')
    assert.equal(await auth.ensureFile(), false, 'a second boot leaves it alone')
    assert.equal((await readFile(path, 'utf8')).trim(), 'operator-chose-this')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an unwritable location is not an error — the default simply stays in force', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-admin-'))
  try {
    await chmod(dir, 0o500) // read+execute, no write: the read-only /config case
    const auth = createAdminAuth({ path: join(dir, 'pw'), log: quiet })
    assert.equal(await auth.ensureFile(), false)
    assert.deepEqual(await auth.check(hdr(DEFAULT_ADMIN_PASSWORD)), { ok: true })
  } finally {
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})
