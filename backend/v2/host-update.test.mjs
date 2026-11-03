// host-update.mjs — the container half of "the container asks, the host
// decides", without a server around it.
//
// Three claims are worth a test here, and they are the three that decide
// whether the feature is honest:
//
//   1. WHAT "AN UPDATER IS INSTALLED" MEANS. Missing heartbeat, stale
//      heartbeat and fresh heartbeat have to be three distinguishable answers,
//      and a missing one must read as "not set up" — never as "broken".
//   2. THE RESULT EXCERPT IS FOREIGN TEXT. A credential that ends up in the
//      host's build output must not come back out of this module, whether it
//      sits in a line that names it or inside a URL.
//   3. NOTHING IS CREATED UNTIL SOMEBODY ASKS. An installation without the
//      host script has to look exactly like it did before this feature
//      existed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, readdir, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHostUpdate, redactOutput, safeUserLabel,
  HEARTBEAT_MAX_AGE_MS_DEFAULT, OUTPUT_MAX_CHARS, REDACTED_LINE
} from './host-update.mjs'

const tmpDir = t => mkdtemp(join(tmpdir(), 'ppt-hu-')).then(d => {
  t.after(() => rm(d, { recursive: true, force: true }))
  return d
})

/** Backdate a file so an age can be tested without waiting for one. */
async function ageFile (path, ms) {
  const when = new Date(Date.now() - ms)
  await utimes(path, when, when)
}

test('no heartbeat file: not set up, and it does not pretend to know more', async t => {
  const dir = await tmpDir(t)
  const hu = createHostUpdate({ dir })
  const s = await hu.status()
  assert.equal(s.updater.installed, false)
  assert.equal(s.updater.heartbeatAt, null)
  assert.equal(s.updater.heartbeatAgeMs, null, 'no age is reported for a file that is not there')
  assert.equal(s.request.pending, false)
  assert.equal(s.lastResult, null)
})

test('a fresh heartbeat means installed, a stale one does not', async t => {
  const dir = await tmpDir(t)
  const hu = createHostUpdate({ dir })
  await writeFile(hu.heartbeatPath, 'at=2026-01-01T00:00:00Z\n')

  // Fresh: written just now.
  let s = await hu.status()
  assert.equal(s.updater.installed, true)
  assert.ok(s.updater.heartbeatAgeMs < 5000)
  assert.equal(s.updater.maxAgeMs, HEARTBEAT_MAX_AGE_MS_DEFAULT)

  // Still inside the window: three missed 5-minute runs are tolerated.
  await ageFile(hu.heartbeatPath, 14 * 60 * 1000)
  s = await hu.status()
  assert.equal(s.updater.installed, true, '14 minutes is within the 20-minute window')

  // Past it.
  await ageFile(hu.heartbeatPath, 25 * 60 * 1000)
  s = await hu.status()
  assert.equal(s.updater.installed, false)
  assert.ok(s.updater.heartbeatAgeMs > 20 * 60 * 1000, 'the age is still reported, so the page can say how old it is')
})

test('the age comes from the mtime, not from the timestamp written inside the file', async t => {
  const dir = await tmpDir(t)
  const hu = createHostUpdate({ dir })
  // A timestamp from years ago in the content, but the file was touched now.
  // Parsing the content would call a live updater dead.
  await writeFile(hu.heartbeatPath, 'at=2001-09-11T00:00:00Z\nnonsense\n')
  const s = await hu.status()
  assert.equal(s.updater.installed, true)
  const { mtimeMs } = await stat(hu.heartbeatPath)
  assert.equal(s.updater.heartbeatAt, new Date(mtimeMs).toISOString())
})

test('a stuck updater is reported as stuck, not as healthy', async t => {
  const dir = await tmpDir(t)
  const hu = createHostUpdate({ dir })

  // The state that looks healthy: the script is running and writing its
  // heartbeat, and it exits at a lock a dead run left behind. Fresh heartbeat,
  // and not one request will ever be picked up.
  await writeFile(hu.heartbeatPath, 'at=2026-01-01T00:00:00Z\nstuck-since=2026-01-01T03:00:00Z\n')
  let s = await hu.status()
  assert.equal(s.updater.installed, true, 'it IS installed — that is exactly what makes this state deceptive')
  assert.equal(s.updater.stuck, true)
  assert.equal(s.updater.stuckSince, '2026-01-01T03:00:00Z')

  // The fact is the field being there. A time the script could not write
  // (a crash truncated its own lock note) must not turn "stuck" back into
  // "healthy" — it only leaves the page without a date to name.
  await writeFile(hu.heartbeatPath, 'at=2026-01-01T00:00:00Z\nstuck-since=unknown\n')
  s = await hu.status()
  assert.equal(s.updater.stuck, true)
  assert.equal(s.updater.stuckSince, null, 'and a value that is not a timestamp is not shown as prose')

  // The ordinary run says nothing about a lock, and must not read as stuck.
  await writeFile(hu.heartbeatPath, 'at=2026-01-01T00:00:00Z\n')
  s = await hu.status()
  assert.equal(s.updater.stuck, false)
  assert.equal(s.updater.stuckSince, null)
})

test('the window is configurable for somebody running the script less often', async t => {
  const dir = await tmpDir(t)
  const hu = createHostUpdate({ dir, heartbeatMaxAgeMs: 60 * 60 * 1000 })
  await writeFile(hu.heartbeatPath, 'at=x\n')
  await ageFile(hu.heartbeatPath, 45 * 60 * 1000)
  const s = await hu.status()
  assert.equal(s.updater.installed, true)
  assert.equal(s.updater.maxAgeMs, 60 * 60 * 1000)
})

test('requesting writes one file, and pressing twice replaces it instead of piling up', async t => {
  const dir = await tmpDir(t)
  const hu = createHostUpdate({ dir, log: { log () {} } })

  assert.deepEqual(await readdir(dir), [], 'nothing exists before the button is pressed')

  const first = await hu.request({ user: 'player1', at: new Date('2026-01-01T00:00:00Z') })
  assert.equal(first.ok, true)
  assert.equal(first.requestedAt, '2026-01-01T00:00:00.000Z')
  await hu.request({ user: 'player2', at: new Date('2026-01-01T00:05:00Z') })
  assert.deepEqual(await readdir(dir), ['update-request'], 'one file, replaced — requests do not queue')

  const s = await hu.status()
  assert.equal(s.request.pending, true)
  assert.equal(s.request.requestedAt, '2026-01-01T00:05:00.000Z')
  assert.equal(s.request.requestedBy, 'player2')

  // What is in the file is a record, not an instruction — and it says so.
  const raw = await readFile(hu.requestPath, 'utf8')
  assert.match(raw, /does not read a\n# single value out of it/)
  assert.equal(/[;&|`$(]/.test(raw.replace(/^#.*$/gm, '')), false,
    'no shell metacharacter is ever written into the file the host script sees')
})

test('a user name is bounded and stripped, whatever the cookie said', () => {
  assert.equal(safeUserLabel('player1'), 'player1')
  assert.equal(safeUserLabel('a b; rm -rf /'), 'abrm-rf')
  assert.equal(safeUserLabel(''), 'unknown')
  assert.equal(safeUserLabel(null), 'unknown')
  assert.equal(safeUserLabel('x'.repeat(200)).length, 40)
})

test('the result file is parsed into a state, and an unknown state stays unknown', async t => {
  const dir = await tmpDir(t)
  const hu = createHostUpdate({ dir })
  await writeFile(hu.resultPath,
    'status=ok\nstarted=2026-01-01T00:00:00Z\nfinished=2026-01-01T00:04:12Z\n--- output ---\nAlready up to date.\n')
  let s = await hu.status()
  assert.equal(s.lastResult.status, 'ok')
  assert.equal(s.lastResult.startedAt, '2026-01-01T00:00:00Z')
  assert.equal(s.lastResult.finishedAt, '2026-01-01T00:04:12Z')
  assert.equal(s.lastResult.output, 'Already up to date.')

  await writeFile(hu.resultPath, 'status=whatever the host felt like\n--- output ---\nx\n')
  s = await hu.status()
  assert.equal(s.lastResult.status, 'unknown', 'the page renders a state, not a word from the host')

  await writeFile(hu.resultPath, 'status=failed\nstarted=yesterday\n--- output ---\nboom\n')
  s = await hu.status()
  assert.equal(s.lastResult.status, 'failed')
  assert.equal(s.lastResult.startedAt, null, 'a time that is not a time is dropped, not shown as prose')
  assert.ok(s.lastResult.at, 'the file mtime always answers "when"')
})

test('a secret in the host output never comes back out', async t => {
  const dir = await tmpDir(t)
  const hu = createHostUpdate({ dir })
  const SESSID = 'aaaaaaaabbbbbbbbccccccccdddddddd'
  const TOKEN = 'ghp_notarealtokenjustforthistest'
  await writeFile(hu.resultPath, [
    'status=failed',
    '--- output ---',
    'Cloning into repo...',
    `POESESSID=${SESSID}`,
    `remote: fatal: authentication failed for https://someone:${TOKEN}@git.example.invalid/x.git`,
    `  export API_KEY=${TOKEN}`,
    'error: build step 3 failed',
    ''
  ].join('\n'))

  const s = await hu.status()
  const body = JSON.stringify(s)
  assert.equal(body.includes(SESSID), false, 'the session id is gone')
  assert.equal(body.includes(TOKEN), false, 'so is the token, in both places it appeared')
  assert.equal(s.lastResult.output.includes(REDACTED_LINE), true, 'and the removal is visible rather than silent')
  assert.match(s.lastResult.output, /error: build step 3 failed/, 'the part that explains the failure survives')
})

test('redactOutput: URL credentials, line-level filtering, control characters, length', () => {
  assert.equal(redactOutput('git@example.invalid:x/y.git'), 'git@example.invalid:x/y.git',
    'an ssh remote has no credentials in it and is left alone')
  assert.equal(redactOutput('https://u:p@example.invalid/x'), 'https://***@example.invalid/x')
  assert.equal(redactOutput('https://example.invalid/a@b'), 'https://example.invalid/a@b',
    'an @ inside the path is not a credential')
  // A password may contain a slash. Stopping at the first one used to walk past
  // the whole credential and leave it in the excerpt.
  assert.equal(redactOutput('https://user:pa/ss@example.invalid/x.git'), 'https://***@example.invalid/x.git')
  assert.equal(redactOutput('fatal: could not read from https://u:a/b/c@example.invalid/x'),
    'fatal: could not read from https://***@example.invalid/x')
  assert.equal(redactOutput('  keeps\tindentation'), 'keeps\tindentation')
  assert.equal(redactOutput('abc'), 'abc', 'control characters are stripped on the way to the browser')

  // AND THE GAP, pinned rather than glossed over: the filter works on names and
  // on the shape of a URL. A bare token on a line that has neither goes through
  // it, and nothing that keeps the error message readable would catch it. The
  // comments, the docs and the note under the excerpt in the page all say the
  // same; this is the assertion that keeps them from drifting into a promise.
  assert.equal(redactOutput('  -> ghp_a1b2c3d4e5f60718293a4b5c6d7e8f90'), '-> ghp_a1b2c3d4e5f60718293a4b5c6d7e8f90',
    'a filter over free text is a filter, not a guarantee — say so wherever this excerpt is shown')

  const long = redactOutput('x'.repeat(OUTPUT_MAX_CHARS * 2) + '\nTHE ERROR')
  assert.ok(long.length <= OUTPUT_MAX_CHARS + 1)
  assert.match(long, /THE ERROR$/, 'the tail is kept — that is where the error is')
  assert.match(long, /^…/, 'and the cut is marked')
})

test('an oversized result file is read from the end and never loaded whole', async t => {
  const dir = await tmpDir(t)
  const hu = createHostUpdate({ dir })
  // Far bigger than the read window: a host script somebody edited, or a build
  // that printed a megabyte. The bound is on this side, not on trust.
  await writeFile(hu.resultPath, 'status=ok\n--- output ---\n' + 'y'.repeat(2 * 1024 * 1024) + '\nTAIL LINE\n')
  const s = await hu.status()
  assert.equal(s.lastResult.truncated, true)
  assert.ok(s.lastResult.output.length <= OUTPUT_MAX_CHARS + 1)
  assert.match(s.lastResult.output, /TAIL LINE$/)
  assert.equal(s.lastResult.status, 'unknown',
    'the head with status= fell outside the window, and that is reported as unknown rather than guessed')
})

test('the build commit is a fact or a null, never a guess', async t => {
  const dir = await tmpDir(t)
  assert.equal((await createHostUpdate({ dir }).status()).build.commit, null)
  assert.equal((await createHostUpdate({ dir, buildCommit: '' }).status()).build.commit, null)
  assert.equal((await createHostUpdate({ dir, buildCommit: 'deadbeef' }).status()).build.commit, 'deadbeef')
})
