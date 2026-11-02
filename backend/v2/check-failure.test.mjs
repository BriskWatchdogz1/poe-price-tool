// check-failure.mjs — the class of a failure and the filter its reason goes
// through before it may be shown. Both halves exist because a status line was
// carrying a duration and no cause (docs/bugs.md B24), and the fix must not
// swap that for a cause the code invented.
//
// THIS FILE IS PLAIN TEXT. It held two literal control characters inside a
// regex until 2026-08-18, which made git treat it as binary and every diff on
// it invisible — a test file whose changes nobody can review is a test file
// nobody is guarding. The escapes below say the same thing and read as text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FAIL_KIND, failure, kindOf, isFailKind, cleanReason, REASON_MAX_CHARS_DEFAULT
} from './check-failure.mjs'
import { SECRET_VALUE_MASK } from './secret-keys.mjs'

test('a tagged failure carries its class, an untagged error is unknown', () => {
  const e = failure('upstream is away', FAIL_KIND.UNREACHABLE)
  assert.equal(e.message, 'upstream is away')
  assert.equal(kindOf(e), FAIL_KIND.UNREACHABLE)
  assert.equal(kindOf(new Error('something')), FAIL_KIND.UNKNOWN)
  assert.equal(kindOf(undefined), FAIL_KIND.UNKNOWN)
})

test('a class nobody defined is not accepted — it becomes unknown', () => {
  // The status line maps a class to a sentence; a made-up one would either
  // print a missing key or, worse, be invented here.
  const e = failure('x', 'probably-the-network')
  assert.equal(kindOf(e), FAIL_KIND.UNKNOWN)
  assert.equal(isFailKind('probably-the-network'), false)
  assert.equal(isFailKind(FAIL_KIND.INCOMPATIBLE), true)
})

test('a reason is folded to one line and control characters are gone', () => {
  const got = cleanReason('generating data/de failed\n  (schema mismatch)\ttail')
  assert.equal(got, 'generating data/de failed (schema mismatch) tail')
  assert.ok(!/[\u0000-\u001f\u007f]/.test(got), 'no control character may reach a browser')
})

// ---------------------------------------------------------------------------
// The two classes of credential vocabulary. Both belong here: the filter has to
// take the VALUE and leave the WORD, and a test that only checks one of them
// certifies half a filter. Until 2026-08-18 only the first was checked, and the
// second — the ordinary English of a parse error — was being destroyed whole.
// ---------------------------------------------------------------------------

test('a value a credential-shaped name carries is masked, the sentence survives', () => {
  const got = cleanReason('fetch failed: token=abcdef123456')
  assert.ok(!got.includes('abcdef123456'), 'the value must not survive')
  assert.equal(got, `fetch failed: token=${SECRET_VALUE_MASK}`)
})

test('every separator a value is handed over by is covered', () => {
  const leaks = ['deadbeefdeadbeef99', 'sk-live-99887766', 'eyJhbGciOi99', 'hunter2xyz9']
  for (const raw of [
    'POESESSID=deadbeefdeadbeef99',
    'the answer said {"api_key": "sk-live-99887766"}',
    'Authorization: Bearer eyJhbGciOi99',
    'config said secret => hunter2xyz9',
    'POESESSID deadbeefdeadbeef99'
  ]) {
    const got = cleanReason(raw)
    assert.ok(got.includes(SECRET_VALUE_MASK), `no mask in: ${got}`)
    for (const leak of leaks) {
      assert.ok(!got.includes(leak), `${leak} survived in: ${got}`)
    }
  }
})

test('the bare vocabulary is NOT a secret — these reasons arrive intact', () => {
  // Every one of these is a sentence this code can actually produce. Under the
  // line filter each of them came out as the placeholder and nothing else, so
  // the first real `rejected` would have shown a credential warning in place of
  // its cause.
  const intact = [
    'client_strings.js: shape looks wrong (RARITY_UNIQUE / key count)',
    'not importable (SyntaxError: Unexpected token in JSON at position 3)',
    'the game-data export found no column "Name" in table "BaseItemTypes"',
    'the lookup answered "<html>Account sign-in required</html>" — expected a URL',
    'base-names rejected (base-names: malformed entry)'
  ]
  for (const raw of intact) {
    assert.equal(cleanReason(raw), raw, 'a harmless word must not cost the reason')
  }
})

test('masking is idempotent — filtering a persisted reason again changes nothing', () => {
  // data-refresher.mjs filters on the way in AND on the way out of state.json,
  // because a state file written by an older build was never filtered at all.
  const once = cleanReason('fetch failed: token=abcdef123456 at https://u:p@example.invalid/x')
  assert.equal(cleanReason(once), once)
})

test('credentials inside a URL are masked', () => {
  const got = cleanReason('fetch failed (500) https://user:hunter2@example.invalid/data.json')
  assert.ok(!got.includes('hunter2'))
  assert.match(got, /https:\/\/\*\*\*@example\.invalid/)
})

test('the reason is capped, and the HEAD survives — that is where an error names itself', () => {
  const long = 'the current patch version could not be looked up at ' + 'x'.repeat(2000)
  const got = cleanReason(long, { maxChars: 80 })
  assert.equal(got.length, 80)
  assert.ok(got.startsWith('the current patch version could not be looked up at '))
  assert.ok(got.endsWith('…'))
})

test('nothing usable comes back as an empty string, so a caller can store null', () => {
  assert.equal(cleanReason(''), '')
  assert.equal(cleanReason(null), '')
  assert.equal(cleanReason('   \n\t '), '')
})

test('the cap has a floor: an absurd maxChars cannot cut the reason to nothing', () => {
  const got = cleanReason('a'.repeat(200), { maxChars: 1 })
  assert.equal(got.length, 40)
  assert.ok(REASON_MAX_CHARS_DEFAULT >= 40)
})
