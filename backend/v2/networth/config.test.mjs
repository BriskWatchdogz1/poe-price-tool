// backend/v2/networth/config.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadNetworthUsers } from './config.mjs'

test('missing file -> empty object, no throw', async () => {
  const users = await loadNetworthUsers({ path: '/nonexistent/nw.json', env: {} })
  assert.deepEqual(users, {})
})

test('loading the file: only complete entries (accountName AND poesessid)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-nw-'))
  const p = join(dir, 'networth-users.json')
  await writeFile(p, JSON.stringify({
    player1: { accountName: 'acc1', poesessid: 's1' },
    broken: { accountName: 'acc2' } // poesessid missing -> dropped
  }))
  const users = await loadNetworthUsers({ path: p, env: {} })
  assert.deepEqual(users, { player1: { accountName: 'acc1', poesessid: 's1' } })
  await rm(dir, { recursive: true, force: true })
})

test('env overrides the file for the env user', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-nw-'))
  const p = join(dir, 'networth-users.json')
  await writeFile(p, JSON.stringify({ player1: { accountName: 'old', poesessid: 'old' } }))
  const users = await loadNetworthUsers({
    path: p,
    env: { POE_SESSID: 'envsid', POE_NETWORTH_ACCOUNT: 'envacc' },
    defaultUser: 'player1'
  })
  assert.deepEqual(users.player1, { accountName: 'envacc', poesessid: 'envsid' })
  await rm(dir, { recursive: true, force: true })
})

test('env with an explicit POE_NETWORTH_USER', async () => {
  const users = await loadNetworthUsers({
    path: '/nonexistent/nw.json',
    env: { POE_SESSID: 's', POE_NETWORTH_ACCOUNT: 'a', POE_NETWORTH_USER: 'player2' },
    defaultUser: 'player1'
  })
  assert.deepEqual(users, { player2: { accountName: 'a', poesessid: 's' } })
})

test('broken JSON -> throws, no silent carry-on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-nw-'))
  const p = join(dir, 'networth-users.json')
  await writeFile(p, '{nope')
  await assert.rejects(() => loadNetworthUsers({ path: p, env: {} }), SyntaxError)
  await rm(dir, { recursive: true, force: true })
})
