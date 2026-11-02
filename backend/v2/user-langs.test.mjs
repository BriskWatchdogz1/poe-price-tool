// user-langs.mjs — the user->language mapping. Configuration, and loud when it
// is wrong: a mistyped mapping would hand the item text to the wrong parser,
// and the failure mode of that is not an error but a plausible wrong item.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUserLangs, languagesOf, configuredLanguages, SUPPORTED_LANGS, DEFAULT_LANG } from './user-langs.mjs'

const USERS = ['alice', 'bob']

test('unset: everybody stays on the default language (no behaviour change)', () => {
  const m = parseUserLangs({ users: USERS })
  assert.deepEqual([...m], [['alice', 'en'], ['bob', 'en']])
  assert.deepEqual(languagesOf(m), ['en'])
})

test('a single pair moves exactly that user', () => {
  const m = parseUserLangs({ spec: 'bob:de', users: USERS })
  assert.deepEqual([...m], [['alice', 'en'], ['bob', 'de']])
  assert.deepEqual(languagesOf(m), ['en', 'de'], 'primary language first')
})

test('whitespace and a spelled-out mapping are fine', () => {
  const m = parseUserLangs({ spec: ' bob : de , alice : en ', users: USERS })
  assert.equal(m.get('bob'), 'de')
  assert.equal(m.get('alice'), 'en')
})

test('the default is configurable, and it applies to everyone unlisted', () => {
  const m = parseUserLangs({ spec: 'alice:en', users: USERS, defaultLang: 'de' })
  assert.deepEqual([...m], [['alice', 'en'], ['bob', 'de']])
  assert.deepEqual(languagesOf(m, 'de'), ['de', 'en'])
})

// --- the loud half ----------------------------------------------------------

test('an unknown user is a startup error, not a shrug', () => {
  assert.throws(() => parseUserLangs({ spec: 'bobb:de', users: USERS }), /unknown user "bobb"/)
})

test('an unsupported language is a startup error', () => {
  assert.throws(() => parseUserLangs({ spec: 'bob:fr', users: USERS }), /unsupported language "fr"/)
  assert.throws(() => parseUserLangs({ users: USERS, defaultLang: 'fr' }), /unsupported language "fr"/)
})

test('a malformed entry is a startup error and says what the format is', () => {
  for (const spec of ['bob', 'bob:', ':de', 'bob=de']) {
    assert.throws(() => parseUserLangs({ spec, users: USERS }), /not a "user:lang" pair/, spec)
  }
})

test('the same user twice is a startup error (the last one would silently win)', () => {
  assert.throws(() => parseUserLangs({ spec: 'bob:de,bob:en', users: USERS }), /listed twice/)
})

test('the supported set is exactly what the tool has data and client strings for', () => {
  assert.deepEqual(SUPPORTED_LANGS, ['en', 'de'])
  assert.equal(DEFAULT_LANG, 'en')
})

// configuredLanguages(): the same configuration, read where only the SET of
// languages matters and the user list does not — the data refresher has to make
// sure a data set exists for every language somebody plays in.

test('configuredLanguages: unset means English only', () => {
  assert.deepEqual(configuredLanguages({}), ['en'])
})

test('configuredLanguages: every language named in the mapping counts, users do not', () => {
  assert.deepEqual(configuredLanguages({ POE_USER_LANGS: 'bob:de' }), ['en', 'de'])
  assert.deepEqual(configuredLanguages({ POE_USER_LANGS: ' bob : de , alice : de ' }), ['en', 'de'])
  assert.deepEqual(configuredLanguages({ POE_USER_LANGS: 'bob:en,alice:en' }), ['en'])
})

test('configuredLanguages: the default language is a language too', () => {
  assert.deepEqual(configuredLanguages({ POE_LANG_DEFAULT: 'de' }), ['de'])
  assert.deepEqual(configuredLanguages({ POE_LANG_DEFAULT: 'de', POE_USER_LANGS: 'bob:en' }), ['de', 'en'])
})

test('configuredLanguages: garbage is ignored here, not reported twice', () => {
  // parseUserLangs() has already ended the startup over it long before
  // anything calls this; a second, worse error message would only obscure it.
  assert.deepEqual(configuredLanguages({ POE_USER_LANGS: 'bob:fr,nonsense,:,' }), ['en'])
})
