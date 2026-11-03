// The persisted half of the user->language mapping (user-lang-store.mjs).
//
// What is worth pinning here is not "a file can be written" but the three
// decisions the module makes:
//   1. the stored value BEATS POE_USER_LANGS (the env is only a seed),
//   2. a single unusable entry is dropped, never the whole process,
//   3. broken JSON does not stop a start,
//   4. an entry whose parser is not live is PARKED, not dropped: it stays in
//      the file and comes back once that parser is live,
//   5. an entry of a user who is not in POE_USERS is KEPT for the file: it is
//      out of force, written back with every save, and in force again at a
//      start with that user back in the list (never at runtime).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises'
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

test('an unusable entry is out of force, the rest of the file still counts', async () => {
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

    assert.deepEqual([...stored], [['player1', 'de']], 'only the usable entry is in force')
    assert.equal(log.warnings.length, 2, 'and each entry left out is warned about, once')
    assert.ok(log.warnings.some(w => w.includes('ghost') && w.includes('POE_USERS')),
      'the warning names the user and the reason')
    assert.ok(log.warnings.some(w => w.includes('player2') && w.includes('kl')),
      'the warning names the dropped value')

    // The users left out fall back to the configured/default value.
    const langs = effective({ spec: '', stored })
    assert.equal(langs.get('player2'), DEFAULT_LANG)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a user taken out of POE_USERS keeps his stored language in the file', async () => {
  // docs/bugs.md B33. The entry was dropped at load, and the next save of ANY
  // user wrote the file without it: put back into POE_USERS later, the user was
  // on his configured value, not on the language he had picked himself.
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    await writeFile(path, JSON.stringify({ player1: 'en', ghost: 'de' }))
    const log = recorder()
    const store = createUserLangStore({ path, log })
    const stored = await store.load({ users: USERS, supported: SUPPORTED_LANGS })

    assert.deepEqual([...stored], [['player1', 'en']], 'not in force: ghost is no user of this process')
    assert.deepEqual([...store.entries()], [['player1', 'en']])
    assert.deepEqual([...store.retained()], [['ghost', 'de']], 'but held on to for the file')
    assert.ok(log.warnings.some(w => w.includes('ghost') && w.includes('POE_USERS') &&
      w.includes(path) && w.includes('applies again')),
      'and the warning says the choice stays in the file and when it applies again')

    // The save of another user writes it back.
    await store.set('player2', 'de')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ghost: 'de', player1: 'en', player2: 'de' })

    // Not at runtime: POE_USERS changes only with a restart, and unpark() asks
    // about parsers only.
    store.park({ isLive: () => true })
    assert.deepEqual([...store.unpark({ isLive: () => true })], [])
    assert.equal(store.entries().has('ghost'), false)

    // A start with ghost back in POE_USERS finds his own choice.
    const again = createUserLangStore({ path, log: recorder() })
    const back = await again.load({ users: [...USERS, 'ghost'], supported: SUPPORTED_LANGS })
    assert.equal(back.get('ghost'), 'de')
    assert.equal(again.retained().size, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an unsupported language of a user not in POE_USERS is still dropped', async () => {
  // No start of this release can honour that entry, whoever it belongs to.
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    await writeFile(path, JSON.stringify({ ghost: 'kl' }))
    const log = recorder()
    const store = createUserLangStore({ path, log })
    await store.load({ users: USERS, supported: SUPPORTED_LANGS })
    assert.equal(store.retained().size, 0)
    assert.ok(log.warnings.some(w => w.includes('ghost') && w.includes('kl') && w.includes('dropping')))
    await store.set('player1', 'en')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { player1: 'en' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a language without a live parser is parked in the second pass, not dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    await writeFile(path, JSON.stringify({ player1: 'de' }))
    const log = recorder()
    const store = createUserLangStore({ path, log })
    await store.load({ users: USERS, supported: SUPPORTED_LANGS })

    // The container came up with an English parser only (no German data set in
    // the snapshot). Keeping the stored 'de' in force would mean a 503 on every
    // item that user pastes, so it is not in force...
    const parked = store.park({ isLive: l => l === 'en' })
    assert.deepEqual(parked, ['player1'])
    assert.deepEqual([...store.entries()], [], 'not in force: the user is on the configured value')
    assert.deepEqual([...store.parked()], [['player1', 'de']], 'but held on to')
    assert.ok(log.warnings.some(w => w.includes('player1') && w.includes('no parser') &&
      w.includes(path) && w.includes('applies again')),
      'and the warning says the choice stays in the file and comes back')

    // ...and the next save of ANOTHER user must not write it out of the file.
    // Before, it did: the entry had only been deleted from memory, and the
    // choice was gone for good, even after a start with the German set back.
    await store.set('player2', 'en')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { player1: 'de', player2: 'en' })
    assert.deepEqual([...store.parked()], [['player1', 'de']], 'still parked, not put in force by the save')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a restart with the parser live takes the parked choice back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    await writeFile(path, JSON.stringify({ player1: 'de' }))
    const first = createUserLangStore({ path, log: recorder() })
    await first.load({ users: USERS, supported: SUPPORTED_LANGS })
    first.park({ isLive: l => l === 'en' })
    await first.set('player2', 'en')

    // Next start: the German data set is back.
    const again = createUserLangStore({ path, log: recorder() })
    await again.load({ users: USERS, supported: SUPPORTED_LANGS })
    assert.deepEqual(again.park({ isLive: () => true }), [])
    assert.deepEqual([...again.entries()], [['player1', 'de'], ['player2', 'en']])
    assert.equal(again.parked().size, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a parser that comes up at runtime takes the parked choice back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    await writeFile(path, JSON.stringify({ player1: 'de' }))
    const log = recorder()
    const store = createUserLangStore({ path, log })
    await store.load({ users: USERS, supported: SUPPORTED_LANGS })
    store.park({ isLive: l => l === 'en' })

    // A data update without the German set changes nothing.
    assert.deepEqual([...store.unpark({ isLive: l => l === 'en' })], [])
    assert.deepEqual([...store.parked()], [['player1', 'de']])

    // The one that brings it puts the choice back in force.
    assert.deepEqual([...store.unpark({ isLive: () => true })], [['player1', 'de']])
    assert.deepEqual([...store.entries()], [['player1', 'de']])
    assert.equal(store.parked().size, 0)
    assert.equal(await readFile(path, 'utf8'), JSON.stringify({ player1: 'de' }),
      'the file already said so; nothing is written')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a parked user who chooses again overwrites the parked entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    await writeFile(path, JSON.stringify({ player1: 'de' }))
    const store = createUserLangStore({ path, log: recorder() })
    await store.load({ users: USERS, supported: SUPPORTED_LANGS })
    store.park({ isLive: l => l === 'en' })

    // His new choice is the one that counts, also once German is back.
    await store.set('player1', 'en')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { player1: 'en' })
    assert.equal(store.parked().size, 0)
    assert.deepEqual([...store.unpark({ isLive: () => true })], [], 'nothing left to bring back')
    assert.deepEqual([...store.entries()], [['player1', 'en']])

    const again = createUserLangStore({ path, log: recorder() })
    await again.load({ users: USERS, supported: SUPPORTED_LANGS })
    again.park({ isLive: () => true })
    assert.deepEqual([...again.entries()], [['player1', 'en']])
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
    assert.ok(log.warnings.some(w => w.includes('.broken-')), 'and the operator is told where it went')
    assert.equal(log.warnings.some(w => w.includes(NOT_FOR_THE_LOG)), false,
      'but not by quoting the file back at him')
    assert.equal((await readdir(dir)).filter(f => /^user-langs\.json\.broken-/.test(f)).length, 1)
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
    assert.equal((await readdir(dir)).filter(f => /^user-langs\.json\.broken-/.test(f)).length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a second broken file does not replace the first one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    for (const content of ['{ first', '{ second']) {
      await writeFile(path, content)
      const store = createUserLangStore({ path, log: recorder() })
      await store.load({ users: USERS, supported: SUPPORTED_LANGS })
    }
    const aside = (await readdir(dir)).filter(f => /^user-langs\.json\.broken-/.test(f))
    assert.equal(aside.length, 2)
    const contents = await Promise.all(aside.map(f => readFile(join(dir, f), 'utf8')))
    assert.deepEqual(contents.sort(), ['{ first', '{ second'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a broken file that cannot be moved aside is not written over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    await writeFile(path, '{ broken')
    const log = recorder()
    const renameImpl = async () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e }
    const store = createUserLangStore({ path, log, renameImpl })
    assert.equal((await store.load({ users: USERS, supported: SUPPORTED_LANGS })).size, 0)
    assert.equal(store.writable, false)
    assert.equal(await store.set('player1', 'de'), false, 'not persisted')
    assert.equal(await readFile(path, 'utf8'), '{ broken', 'the broken file is still there, untouched')
    assert.ok(log.warnings.some(w => w.includes('not writing over it') && w.includes('EACCES')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a file that exists but cannot be read is not written over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const path = join(dir, 'user-langs.json')
    const content = JSON.stringify({ player2: 'de' })
    await writeFile(path, content)
    const log = recorder()
    // A seam instead of chmod 000: root reads such a file anyway.
    const readFileImpl = async () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e }
    const store = createUserLangStore({ path, log, readFileImpl })
    assert.equal((await store.load({ users: USERS, supported: SUPPORTED_LANGS })).size, 0)
    assert.equal(store.writable, false)
    assert.equal(await store.set('player1', 'en'), false, 'not persisted')
    assert.deepEqual([...store.entries()], [['player1', 'en']], 'but the choice is in force')
    assert.equal(await readFile(path, 'utf8'), content, 'the other users entry is still there')
    assert.ok(log.warnings.some(w => w.includes('not writing over it') && w.includes('EACCES')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a missing file is a normal first start: the store writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-userlang-'))
  try {
    const log = recorder()
    const store = createUserLangStore({ path: join(dir, 'user-langs.json'), log })
    await store.load({ users: USERS, supported: SUPPORTED_LANGS })
    assert.equal(store.writable, true)
    assert.equal(log.warnings.length, 0)
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
