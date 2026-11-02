// The HOST script, actually executed.
//
// deploy/host-update.sh is the part of this feature that runs outside the
// container, as root on somebody's home server, and the part that carries the
// whole security argument. "It looks harmless" is not a test, so it is run
// here for real against a stub `git`, a stub `docker` and a temporary /config
// directory — the two constants at its head are rewritten into the copy under
// test, which is also a check that they are still constants at the head.
//
// What is pinned:
//   - the heartbeat is written on EVERY run, including the ones with nothing
//     to do (that is what the UI reads "an updater is installed" from)
//   - no request file means no command is run at all — no daily pull, no
//     "while we are here anyway"
//   - the request is deleted BEFORE the work, so a failing build cannot turn
//     into a rebuild every five minutes
//   - a failure is recorded as a failure and does not re-arm itself
//   - the lock keeps a second run out while a build is in progress, and that
//     second run still refreshes the heartbeat
//   - NOTHING FROM THE REQUEST FILE REACHES THE COMMAND: the stubs record
//     their full argument list, and a request file stuffed with shell
//     metacharacters, a branch name and a second command changes none of it.
//
// AND THE OTHER HALF OF THE THREAT MODEL, which is the same one: the /config
// directory is WRITABLE BY THE CONTAINER, and this script runs as root. So the
// attacker here is not somebody sending a request — it is somebody who decides
// what is behind each of those names. Every one of these is executed against
// the real script:
//   - a symlink at the staging path the script used to write through: it must
//     not become a way to have root truncate a file outside the volume
//   - a FIFO in the place of a file the script writes: it must not park the
//     run forever (which would stop the heartbeat for good)
//   - the request as a directory, and the lock pre-created in the shared
//     directory: neither may be able to switch the updater off permanently
//   - a stale lock: reported, in the heartbeat, so the UI stops calling a
//     wedged updater healthy
//   - the CHECKOUT inside the shared directory (or the two being one): refused,
//     because that one makes the container able to write the tree this script
//     builds
//
// AND THE DIRECTION THAT IS NOT AN ATTACK, which is pinned here just as hard,
// because refusing it was a bug: CONFIG_DIR inside REPO_DIR is what `git clone`
// plus the shipped `./config:/config` mount produces on every installation that
// follows the README. It must run — on the one condition the script can check,
// that the build context excludes what the container writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod, stat, lstat, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'deploy/host-update.sh')
const run = promisify(execFile)

/**
 * A copy of the real script with the two "adjust these" constants pointed at
 * temporary directories, plus stub executables in front of PATH.
 *
 * The rewrite asserts it matched: if somebody renames those constants or moves
 * them out of the head, this fails loudly instead of testing a script that
 * still updates the real machine.
 */
async function stage (tmp, {
  gitFails = false,
  buildSleepMs = 0,
  // How the two directories sit relative to each other. All four occur in the
  // field; only the last two are the dangerous ones.
  //   'sibling'        — side by side. Legal, involves no build context at all,
  //                      and therefore what every test above uses.
  //   'config-in-repo' — THE SHIPPED ARRANGEMENT: a checkout whose compose file
  //                      mounts `./config`. Must be accepted.
  //   'repo-in-config' — the checkout inside the directory the container writes.
  //   'same'           — one directory for both. Same danger.
  layout = 'sibling',
  // What lands in the checkout's .dockerignore. `null` writes no file at all.
  // The default is what this repository ships and what the two nested-inside-
  // the-checkout directories need.
  dockerignore = 'config\nconfig.host-update\n'
} = {}) {
  const repo = layout === 'repo-in-config' ? join(tmp, 'config', 'repo')
    : layout === 'same' ? join(tmp, 'both')
      : join(tmp, 'repo')
  const config = layout === 'config-in-repo' ? join(repo, 'config')
    : layout === 'same' ? repo
      : join(tmp, 'config')
  // Where the script keeps its lock and stages what it publishes: a sibling of
  // the config directory, outside the volume. Derived the same way here so that
  // moving it in the script makes these tests fail rather than pass silently.
  const work = config + '.host-update'
  const bin = join(tmp, 'bin')
  const calls = join(tmp, 'calls.log')
  await mkdir(repo, { recursive: true })
  await mkdir(config, { recursive: true })
  await mkdir(bin, { recursive: true })
  const setDockerignore = text => writeFile(join(repo, '.dockerignore'), text)
  if (dockerignore !== null) await setDockerignore(dockerignore)

  let src = await readFile(SCRIPT, 'utf8')
  const before = src
  src = src.replace(/^REPO_DIR=".*"$/m, `REPO_DIR="${repo}"`)
  src = src.replace(/^CONFIG_DIR=".*"$/m, `CONFIG_DIR="${config}"`)
  assert.notEqual(src, before, 'REPO_DIR/CONFIG_DIR are no longer plain constants at the head of the script')
  const script = join(tmp, 'host-update.sh')
  await writeFile(script, src)
  await chmod(script, 0o755)

  // Stubs. Every invocation appends its whole argv, so the test can prove what
  // was and was not executed.
  const stub = async (name, body) => {
    const p = join(bin, name)
    await writeFile(p, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> ${JSON.stringify(calls)}\n${body}\n`)
    await chmod(p, 0o755)
  }
  await stub('git', gitFails
    ? 'case "$1" in pull) echo "fatal: could not read from remote https://user:tok@example.invalid/x.git" >&2; exit 128;; esac\n' +
      'echo deadbeef'
    : 'case "$1" in rev-parse) echo deadbeef;; *) echo "Already up to date.";; esac')
  await stub('docker', `${buildSleepMs ? `sleep ${buildSleepMs / 1000}\n` : ''}echo "Container recreated. BUILD_COMMIT=$BUILD_COMMIT"`)

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  return {
    script,
    repo,
    config,
    work,
    calls,
    env,
    setDockerignore,
    callLines: () => readFile(calls, 'utf8').then(t => t.trim().split('\n').filter(Boolean), () => [])
  }
}

const exists = p => stat(p).then(() => true, () => false)
const fields = text => Object.fromEntries(text.split('\n')
  .map(l => /^([a-z][a-z0-9-]*)=(.*)$/i.exec(l)).filter(Boolean).map(m => [m[1], m[2]]))

test('host script: a run with no request writes the heartbeat and does nothing else', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const s = await stage(tmp)

  await run(s.script, [], { env: s.env })

  const hb = await readFile(join(s.config, 'update-heartbeat'), 'utf8')
  assert.match(fields(hb).at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'the heartbeat carries a UTC timestamp')
  assert.deepEqual(await s.callLines(), [], 'no request, no git and no docker — not even a pull')
  assert.equal(await exists(join(s.config, 'update-result')), false, 'and nothing that looks like a result')
  // Nothing was left lying around that a later run would trip over.
  assert.deepEqual((await readdir(s.config)).sort(), ['update-heartbeat'])
})

test('host script: a request runs the two fixed commands, and its content reaches none of them', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const s = await stage(tmp)

  // Everything an attacker who reached the admin area could try to smuggle in.
  // The script must treat all of it as "somebody pressed the button".
  await writeFile(join(s.config, 'update-request'),
    'requested-at=2026-01-01T00:00:00Z\n' +
    'requested-by=someone\n' +
    'branch=evil; touch ' + join(tmp, 'PWNED') + '\n' +
    '$(touch ' + join(tmp, 'PWNED2') + ')\n' +
    '`touch ' + join(tmp, 'PWNED3') + '`\n' +
    '--upload-pack=touch ' + join(tmp, 'PWNED4') + '\n')

  await run(s.script, [], { env: s.env })

  assert.deepEqual(await s.callLines(), [
    'git pull --ff-only',
    'git rev-parse --short HEAD',
    'docker compose up -d --build'
  ], 'exactly the hard-wired commands, with exactly the hard-wired arguments')
  for (const n of ['PWNED', 'PWNED2', 'PWNED3', 'PWNED4']) {
    assert.equal(await exists(join(tmp, n)), false, `${n}: the request file was interpreted`)
  }

  assert.equal(await exists(join(s.config, 'update-request')), false, 'the request is consumed')
  const res = fields(await readFile(join(s.config, 'update-result'), 'utf8'))
  assert.equal(res.status, 'ok')
  assert.match(res.started, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  assert.match(res.finished, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  const out = await readFile(join(s.config, 'update-result'), 'utf8')
  assert.match(out, /--- output ---/)
  assert.match(out, /BUILD_COMMIT=deadbeef/, 'the commit read from the checkout is handed to the build')
})

test('host script: a failed update is reported once and does not re-arm itself', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const s = await stage(tmp, { gitFails: true })

  await writeFile(join(s.config, 'update-request'), 'requested-at=2026-01-01T00:00:00Z\n')
  await assert.rejects(run(s.script, [], { env: s.env }), 'a failed update exits non-zero, so cron can mail it')

  const raw = await readFile(join(s.config, 'update-result'), 'utf8')
  assert.equal(fields(raw).status, 'failed')
  assert.match(raw, /could not read from remote/, 'stderr is part of the excerpt — that is where the reason is')
  assert.deepEqual(await s.callLines(), ['git pull --ff-only'], 'it stops at the failing step, it does not build the old tree')
  assert.equal(await exists(join(s.config, 'update-request')), false,
    'the request is gone even though the update failed — otherwise the host would rebuild every five minutes')

  // The second run is the one that matters: nothing asked for anything.
  await run(s.script, [], { env: s.env })
  assert.deepEqual(await s.callLines(), ['git pull --ff-only'], 'no retry without a new request')

  // And the excerpt the tool will publish is the one place a remote URL with
  // credentials in it turns up. The script does not redact — the server does —
  // so this only pins that the raw text is what the server's filter expects.
  const { redactOutput } = await import('./host-update.mjs')
  const shown = redactOutput(raw.slice(raw.indexOf('--- output ---')))
  assert.equal(shown.includes('user:tok@'), false, 'the server-side filter takes the credentials out of it')
  assert.match(shown, /https:\/\/\*\*\*@example\.invalid/)
})

test('host script: two runs never build at the same time, and the blocked one still beats', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const s = await stage(tmp, { buildSleepMs: 2000 })

  await writeFile(join(s.config, 'update-request'), 'requested-at=2026-01-01T00:00:00Z\n')
  const slow = run(s.script, [], { env: s.env })
  // Long enough for the first run to be inside `docker compose`, short enough
  // to be well within its 2 s stub build.
  await new Promise(r => setTimeout(r, 700))
  const hbBefore = (await stat(join(s.config, 'update-heartbeat'))).mtimeMs

  // A second request arrives mid-build — the every-5-minutes cron tick.
  await writeFile(join(s.config, 'update-request'), 'requested-at=2026-01-01T00:01:00Z\n')
  await new Promise(r => setTimeout(r, 1100))
  const second = await run(s.script, [], { env: s.env })
  assert.match(second.stdout, /another run is still working/)
  assert.ok((await stat(join(s.config, 'update-heartbeat'))).mtimeMs > hbBefore,
    'the blocked run refreshed the heartbeat — the UI must not call the updater dead during a long build')
  assert.equal(await exists(join(s.config, 'update-request')), true,
    'and it left the request for the next run rather than swallowing it')

  await slow
  assert.deepEqual((await s.callLines()).filter(l => l.startsWith('docker')), ['docker compose up -d --build'],
    'one build, not two')
})

// ---------------------------------------------------------------------------
// The shared directory as the attacker's ground. Everything below plants
// something in /config the way a compromised container could — the container
// runs as `node`, has no shell out here and no docker socket, but it does have
// write access to that one directory, and this script runs as root over it.
// ---------------------------------------------------------------------------

test('host script: a symlink where the staging file used to go overwrites nothing', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const s = await stage(tmp)

  // THE ATTACK, and it worked: the script staged through "<final name>.tmp" in
  // the shared directory and `cat >` follows a symlink. A predictable path plus
  // a root writer is an arbitrary-overwrite primitive — the content is only a
  // timestamp or a build log, but the target is anything root may write.
  const victim = join(tmp, 'root-owned-file')
  await writeFile(victim, 'untouched\n')
  await symlink(victim, join(s.config, 'update-heartbeat.tmp'))
  await symlink(victim, join(s.config, 'update-result.tmp'))
  await writeFile(join(s.config, 'update-request'), 'requested-at=2026-01-01T00:00:00Z\n')

  await run(s.script, [], { env: s.env })

  assert.equal(await readFile(victim, 'utf8'), 'untouched\n',
    'the file the symlink pointed at was written through — staging is back inside the shared volume')
  // The bait is still a symlink and still empty of any content of ours: the
  // script never went near it.
  assert.ok((await lstat(join(s.config, 'update-heartbeat.tmp'))).isSymbolicLink())
  // And the run itself did its job, through paths of its own.
  assert.match(await readFile(join(s.config, 'update-heartbeat'), 'utf8'), /^at=\d{4}-/)
  assert.match(await readFile(join(s.config, 'update-result'), 'utf8'), /status=ok/)
  assert.deepEqual(await s.callLines(), [
    'git pull --ff-only', 'git rev-parse --short HEAD', 'docker compose up -d --build'
  ])
  // Nothing was staged in the shared directory at all, under any name.
  assert.deepEqual((await readdir(s.config)).sort(),
    ['update-heartbeat', 'update-heartbeat.tmp', 'update-result', 'update-result.tmp'])
  // And nothing was left behind in the private one either.
  assert.deepEqual((await readdir(s.work)).sort(), [])
})

test('host script: a FIFO in the place of a file it writes stops the run instead of parking it', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const s = await stage(tmp)

  try {
    await run('mkfifo', [join(s.config, 'update-heartbeat')])
  } catch {
    t.skip('no mkfifo on this machine')
    return
  }

  // `cat > fifo` blocks until somebody reads. If the script opened this, every
  // run from now on would hang: no heartbeat ever again, and a cron tick piling
  // up every five minutes. The timeout is the assertion — a run that has to be
  // killed is a failure here, not a pass.
  const err = await run(s.script, [], { env: s.env, timeout: 20_000 }).then(() => null, e => e)
  assert.ok(err, 'a pipe where a file belongs must not be treated as a file')
  assert.equal(err.killed, false, 'the run hung on the FIFO instead of refusing it')
  assert.match(String(err.stderr), /not a plain file/)
  assert.deepEqual(await s.callLines(), [], 'and it got nowhere near the commands')
})

test('host script: a request that is not a plain file stops the run and says why', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const s = await stage(tmp)

  // A DIRECTORY named update-request: `rm -f` cannot remove it, `set -e` takes
  // the run down, and before this the button was dead forever with nothing on
  // the page or in the log to say so.
  await mkdir(join(s.config, 'update-request'))
  let err = await run(s.script, [], { env: s.env }).then(() => null, e => e)
  assert.ok(err, 'a directory in the place of the request is not a request')
  assert.match(String(err.stderr), /not a plain file/)
  assert.match(String(err.stderr), /shared with the container/, 'and it says what kind of state this is')
  assert.deepEqual(await s.callLines(), [])
  assert.match(await readFile(join(s.config, 'update-heartbeat'), 'utf8'), /^at=/,
    'the heartbeat still went out first — the tool has to keep hearing from the host')

  // A SYMLINK pointing out of the volume. `[ -e ]` follows it, so the old
  // script would have taken any existing file anywhere as "somebody asked".
  await rm(join(s.config, 'update-request'), { recursive: true })
  const outside = join(tmp, 'some-file-elsewhere')
  await writeFile(outside, 'not a request\n')
  await symlink(outside, join(s.config, 'update-request'))
  err = await run(s.script, [], { env: s.env }).then(() => null, e => e)
  assert.ok(err, 'a symlink is not a request either')
  assert.match(String(err.stderr), /not a plain file/)
  assert.deepEqual(await s.callLines(), [], 'no build was triggered by a file the script does not own')
  assert.equal(await exists(outside), true)
})

test('host script: a lock planted in the shared directory is not the lock', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const s = await stage(tmp)

  // The lock used to live in /config, so the container could create it once and
  // the updater would never run again — a switch for turning updates off, in
  // the one directory the container can write.
  await mkdir(join(s.config, 'update.lock'))
  await writeFile(join(s.config, 'update-request'), 'requested-at=2026-01-01T00:00:00Z\n')

  await run(s.script, [], { env: s.env })

  assert.deepEqual(await s.callLines(), [
    'git pull --ff-only', 'git rev-parse --short HEAD', 'docker compose up -d --build'
  ], 'the update ran — the real lock is out of reach of whoever put that there')
  assert.equal(await exists(join(s.config, 'update.lock')), true, 'and their directory was left alone, not "cleaned up"')
})

test('host script: a lock left by a dead run is reported in the heartbeat, not hidden behind it', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const s = await stage(tmp)

  // What a host reboot in the middle of a build leaves behind: the lock, with
  // nothing running that holds it. Every later run wrote its heartbeat and
  // exited here, so the page said "installed and healthy" while no request was
  // ever picked up again — until somebody thought to look in /config.
  await mkdir(s.work, { recursive: true })
  await mkdir(join(s.work, 'update.lock'))
  const threeHoursAgo = Math.floor(Date.now() / 1000) - 3 * 3600
  await writeFile(join(s.work, 'update.lock.started'), `${threeHoursAgo} 2026-01-01T00:00:00Z\n`)
  await writeFile(join(s.config, 'update-request'), 'requested-at=2026-01-01T04:00:00Z\n')

  const err = await run(s.script, [], { env: s.env }).then(() => null, e => e)
  assert.ok(err, 'an updater that cannot pick anything up exits non-zero, so cron can mail it')
  assert.match(String(err.stderr), /has been held since 2026-01-01T00:00:00Z/)
  assert.match(String(err.stderr), /rmdir /, 'and it says what to remove — the script does not break its own lock')

  const hb = await readFile(join(s.config, 'update-heartbeat'), 'utf8')
  assert.match(hb, /^at=\d{4}-/m, 'the heartbeat is still written: the updater is running, it is wedged')
  assert.equal(fields(hb)['stuck-since'], '2026-01-01T00:00:00Z',
    'and it carries the state the page turns into "stuck" instead of "healthy"')
  assert.deepEqual(await s.callLines(), [])
  assert.equal(await exists(join(s.config, 'update-request')), true, 'the request waits for the human, it is not eaten')

  // A lock that is merely young is a build in progress, and says nothing.
  await rm(join(s.work, 'update.lock'), { recursive: true })
  await rm(join(s.work, 'update.lock.started'))
  await run(s.script, [], { env: s.env })
  assert.equal(fields(await readFile(join(s.config, 'update-heartbeat'), 'utf8'))['stuck-since'], undefined)
  assert.deepEqual(await s.callLines(), [
    'git pull --ff-only', 'git rev-parse --short HEAD', 'docker compose up -d --build'
  ])
})

test('host script: it refuses to run at all when the checkout is inside the shared directory', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))

  // THE ONE MISCONFIGURATION THAT INVERTS THE DESIGN. With the CHECKOUT inside
  // the shared directory, the container can write docker-compose.yml and the
  // Dockerfile, and the next update builds them as root out here. Ignoring the
  // request file perfectly is worth nothing then.
  for (const layout of ['repo-in-config', 'same']) {
    const sub = await mkdtemp(join(tmp, `${layout}-`))
    const s = await stage(sub, { layout })
    await writeFile(join(s.config, 'update-request'), 'requested-at=2026-01-01T00:00:00Z\n')

    const err = await run(s.script, [], { env: s.env }).then(() => null, e => e)
    assert.ok(err, `${layout}: a script that would build a tree the container can write must not run`)
    assert.match(String(err.stderr), /is inside CONFIG_DIR|the same directory/)
    assert.match(String(err.stderr), /code execution on this host/, 'and it says why, so nobody "fixes" it by deleting the check')
    assert.deepEqual(await s.callLines(), [])
    assert.equal(await exists(join(s.config, 'update-heartbeat')), false,
      'not even a heartbeat: an updater in this state must read as absent, not as ready')
  }
})

test('host script: the arrangement every README install produces is accepted, not refused', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  // `git clone` + `docker compose up -d --build` and nothing else: the compose
  // file mounts `./config`, so the shared directory is a SUBDIRECTORY OF THE
  // CHECKOUT. The script used to reject exactly this, which made the feature
  // unusable for everyone who followed the instructions. The nesting hands the
  // container nothing — a bind mount goes one way, and the checkout it sits in
  // is not mounted anywhere.
  const s = await stage(tmp, { layout: 'config-in-repo' })
  assert.equal(s.config, join(s.repo, 'config'), 'the test is set up the way the README leaves a host')

  await writeFile(join(s.config, 'update-request'), 'requested-at=2026-01-01T00:00:00Z\n')
  await run(s.script, [], { env: s.env })

  assert.deepEqual(await s.callLines(), [
    'git pull --ff-only', 'git rev-parse --short HEAD', 'docker compose up -d --build'
  ], 'the update ran')
  assert.equal(fields(await readFile(join(s.config, 'update-result'), 'utf8')).status, 'ok')
  // And the work directory really is the one inside the checkout, which is the
  // reason the repository ignores that name for git AND for docker.
  assert.equal(s.work, join(s.repo, 'config.host-update'))
  assert.equal(await exists(s.work), true)

  // A .dockerignore that excludes both with one pattern instead of two literal
  // names is understood as well — the check reads the file the way docker does,
  // it does not look for a fixed line.
  await s.setDockerignore('# comment\nnode_modules\nconf*\n')
  await writeFile(join(s.config, 'update-request'), 'requested-at=2026-01-01T00:01:00Z\n')
  await run(s.script, [], { env: s.env })
  assert.equal((await s.callLines()).length, 6, 'the second run went through too')
})

test('host script: nested inside the checkout, it will not build what .dockerignore lets through', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-hostupd-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  // The price of the arrangement above: `docker compose up -d --build` sends
  // the whole checkout to the daemon minus what .dockerignore excludes, and the
  // config directory holds every user's POESESSID and the admin password. The
  // Dockerfile copies none of it today — but the build this script starts would
  // still hand it over, and the next COPY that reaches too wide would put it in
  // an image. So it does not start that build.
  const s = await stage(tmp, { layout: 'config-in-repo', dockerignore: null })
  await writeFile(join(s.config, 'update-request'), 'requested-at=2026-01-01T00:00:00Z\n')

  let err = await run(s.script, [], { env: s.env }).then(() => null, e => e)
  assert.ok(err, 'no .dockerignore at all means the config directory is in the context, provably')
  assert.match(String(err.stderr), /does not exclude it/)
  assert.match(String(err.stderr), /Add a line 'config'/, 'and it names the line to add')
  assert.deepEqual(await s.callLines(), [])

  // The work directory needs its own line: its staging files carry the RAW
  // build output, and the redaction of a failing `git`'s remote URL happens
  // later, in the server.
  await s.setDockerignore('config\n')
  err = await run(s.script, [], { env: s.env }).then(() => null, e => e)
  assert.ok(err, 'the config directory alone is not enough')
  assert.match(String(err.stderr), /Add a line 'config.host-update'/)
  assert.deepEqual(await s.callLines(), [])

  // A negation later in the file wins, the same way it does for docker.
  await s.setDockerignore('config\nconfig.host-update\n!config\n')
  err = await run(s.script, [], { env: s.env }).then(() => null, e => e)
  assert.ok(err, 're-included by a "!" line is not excluded')
  assert.match(String(err.stderr), /Add a line 'config'/)

  await s.setDockerignore('config\nconfig.host-update\n')
  await run(s.script, [], { env: s.env })
  assert.deepEqual(await s.callLines(), [
    'git pull --ff-only', 'git rev-parse --short HEAD', 'docker compose up -d --build'
  ], 'and with both excluded the same request goes through')
})
