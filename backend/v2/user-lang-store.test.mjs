// The persisted half of the user->language mapping (user-lang-store.mjs).
//
// What is worth pinning here is not "a file can be written" but the three
// decisions the module makes:
//   1. the stored value BEATS POE_USER_LANGS (the env is only a seed),
//   2. a single unusable entry is dropped, never the whole process,
//   3. broken JSON does not stop a start.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserLangStore } from './user-lang-store.mjs'
import { parseUserLangs, SUPPORTED_LANGS, DEFAULT_LANG } from './user-langs.mjs'

const USERS = ['player1', 'player2']

/** Collects the warnings instead of printing them, so they can be asserted. */
function recorder () {
  const warnings = []
  return { warnings, log: () => {}, warn: m => warnings.push(String(m)) }
}

/** What server.mjs does: env seed first, store overlaid on top. */
function effective ({ spec, stored }) {
  const env = parseUserLangs({ spec, users: USERS, defaultLang: DEFAULT_LANG })
  const out = new Map(env)
  for (const [u, l] of stored) out.set(u, l)
  return out
}

test('the stored language beats POE_USER_LANGS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    // The operator configured player2 as a German client...
    const spec = 'player2:de'
    // ...and player2 has since switched himself back to English on the
    // settings page.
    await writeFile(path, JSON.stringify({ player2: 'en' }))

    const store = createUserLangStore({ path, log: recorder() })
    const stored = await store.load({ users: USERS, supported: SUPPORTED_LANGS })
    const langs = effective({ spec, stored })

    assert.equal(langs.get('player2'), 'en',
      'the users own choice wins — otherwise the next deploy silently reverts it')
    assert.equal(langs.get('player1'), DEFAULT_LANG, 'and nobody else is touched')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an unusable entry is dropped, the rest of the file still counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    await writeFile(path, JSON.stringify({
      player1: 'de',        // fine
      ghost: 'de',          // not in POE_USERS (renamed/removed user)
      player2: 'kl',        // not a language this tool supports
    }))
    const log = recorder()
    const store = createUserLangStore({ path, log })
    const stored = await store.load({ users: USERS, supported: SUPPORTED_LANGS })

    assert.deepEqual([...stored], [['player1', 'de']], 'only the usable entry survives')
    assert.equal(log.warnings.length, 2, 'and each drop is warned about, once')
    assert.ok(log.warnings.some(w => w.includes('ghost') && w.includes('POE_USERS')),
      'the warning names the user and the reason')
    assert.ok(log.warnings.some(w => w.includes('player2') && w.includes('kl')),
      'the warning names the dropped value')

    // The dropped users fall back to the configured/default value.
    const langs = effective({ spec: '', stored })
    assert.equal(langs.get('player2'), DEFAULT_LANG)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a language without a live parser is dropped in the second pass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    await writeFile(path, JSON.stringify({ player1: 'de', player2: 'en' }))
    const log = recorder()
    const store = createUserLangStore({ path, log })
    await store.load({ users: USERS, supported: SUPPORTED_LANGS })

    // The container came up with an English parser only (no German data set in
    // the snapshot). Keeping the stored 'de' would mean a 503 on every item
    // that user pastes.
    const dropped = store.prune({ isLive: l => l === 'en' })
    assert.deepEqual(dropped, ['player1'])
    assert.deepEqual([...store.entries()], [['player2', 'en']])
    assert.ok(log.warnings.some(w => w.includes('player1') && w.includes('no parser')),
      'and it says why')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('broken JSON does not stop the start — the file is moved aside', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    // The marker in the middle is what V8 would quote back: its JSON.parse
    // error carries an EXCERPT of the input, and this file lives in the same
    // /config directory as the session cookies. A log line is pasted into bug
    // reports, so the content of a file we failed to read is not repeated in
    // one (json-error.mjs).
    const NOT_FOR_THE_LOG = 'sessionvalue0123456789abcdef'
    await writeFile(path, `{ "player1": ${NOT_FOR_THE_LOG} this is not json`)
    const log = recorder()
    const store = createUserLangStore({ path, log })
    const stored = await store.load({ users: USERS, supported: SUPPORTED_LANGS })

    assert.equal(stored.size, 0, 'nothing is taken from it')
    assert.ok(log.warnings.some(w => w.includes('.broken')), 'and the operator is told where it went')
    assert.equal(log.warnings.some(w => w.includes(NOT_FOR_THE_LOG)), false,
      'but not by quoting the file back at him')
    assert.equal(await stat(`${path}.broken`).then(() => true, () => false), true)
    assert.equal(await stat(path).then(() => true, () => false), false)

    // And the store is usable again right away — the next save starts clean.
    await store.set('player1', 'de')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { player1: 'de' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an array or a scalar is treated as broken, not as an empty mapping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    await writeFile(path, '["player1"]')
    const store = createUserLangStore({ path, log: recorder() })
    assert.equal((await store.load({ users: USERS, supported: SUPPORTED_LANGS })).size, 0)
    assert.equal(await stat(`${path}.broken`).then(() => true, () => false), true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('set() persists atomically and keeps the other users entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    const store = createUserLangStore({ path, log: recorder() })
    await store.load({ users: USERS, supported: SUPPORTED_LANGS })

    assert.equal(await store.set('player2', 'de'), true, 'reports that it was persisted')
    await store.set('player1', 'en')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { player1: 'en', player2: 'de' })

    // A fresh store reads back exactly that — the point of the whole file.
    const again = createUserLangStore({ path, log: recorder() })
    assert.deepEqual([...await again.load({ users: USERS, supported: SUPPORTED_LANGS })],
      [['player1', 'en'], ['player2', 'de']])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an unwritable store still works in memory and says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const store = createUserLangStore({ path: join(dir, 'user-langs.json'), log: recorder() })
    await store.load({ users: USERS, supported: SUPPORTED_LANGS })
    store.writable = false // what server.mjs sees on a run without /config
    assert.equal(await store.set('player1', 'de'), false, 'the caller learns it was not persisted')
    assert.deepEqual([...store.entries()], [['player1', 'de']], 'but the choice is in force')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
