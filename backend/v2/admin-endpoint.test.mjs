// GET /admin/gaps against the REAL server (child process), all background jobs
// disabled, no GGG requests.
//
// Three claims are checked end to end, because each of them is a promise the
// design doc makes and none of them is visible in a unit test of the modules:
//
//  1. The partition holds and has no session behind it — no header is refused,
//     a wrong one is refused, the right one gets data, and rewriting the
//     password file changes the answer on the NEXT request, without a restart.
//  2. The gap list is really fed from the price-check path: a clipboard text the
//     engine refuses shows up in it, under the LANGUAGE of the user who sent it,
//     and the entries come out ordered by how often they happened.
//  3. The dataset offset is part of the same answer, and its threshold comes
//     from configuration.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { QUIET_ENV } from './test-quiet-env.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))

function freePort () {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

// Not an item text in any language — the engine has to refuse it, which is
// exactly the event the gap log exists for.
const GARBAGE_A = 'this is not an item text at all\nsecond line\n'
const GARBAGE_B = 'neither is this one\nzweite Zeile\n'

test('admin endpoint: password partition, gap list and dataset offset', { timeout: 180_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ppt-admin-ep-'))
  const port = await freePort()
  const pwPath = join(tmp, 'admin-password') // deliberately absent: the server creates it

  const srv = spawn(process.execPath, [join(ROOT, 'backend/v2/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      // The full set that keeps a booted server off the network — one list,
      // imported, because every file that wrote it out by hand got it wrong.
      // Spread first, so anything below may still override it deliberately.
      ...QUIET_ENV,
      PORT: String(port),
      POE_USERS: 'en1,de1',
      POE_USER_LANGS: 'de1:de',          // the language comes from configuration
      POE_ADMIN_PASSWORD_FILE: pwPath,
      POE_LANG_SKEW_WARN_RATIO: '0.02',  // so the threshold can be seen in the answer
      POE_NETWORTH_CONFIG: join(tmp, 'networth-users.json'),
      POE_NETWORTH_STORE: join(tmp, 'networth-store.json'),
      POE_NETWORTH_HISTORY: join(tmp, 'networth-history.ndjson'),
      POE_NETWORTH_AUTOSYNC: '0',
      POE_FAUSTUS_DISABLED: '1',
      POE_CORPSE_DISABLED: '1',
      POE_DATA_REFRESH_DISABLED: '1',
      POE_REFERENCE_DISABLED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const srvLog = []
  srv.stdout.on('data', d => srvLog.push(String(d)))
  srv.stderr.on('data', d => srvLog.push(String(d)))

  const base = `http://127.0.0.1:${port}`
  let up = false
  for (let i = 0; i < 900; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) { up = true; break } } catch {}
    await sleep(100)
  }

  const admin = pw => fetch(`${base}/admin/gaps`, pw == null ? undefined : { headers: { 'x-admin-password': pw } })

  try {
    assert.ok(up, 'server did not come up:\n' + srvLog.join(''))

    // ---- 1. the partition ---------------------------------------------------
    // The file did not exist; the server writes the documented default into it
    // so the operator can find the knob instead of having to know about it.
    assert.equal((await readFile(pwPath, 'utf8')).trim(), 'admin')

    let r = await admin(null)
    assert.equal(r.status, 401, 'no header at all')
    assert.equal((await r.json()).reason, 'missing')

    r = await admin('')
    assert.equal(r.status, 401, 'an empty header is the same as none')

    r = await admin('not-the-password')
    assert.equal(r.status, 401, 'a wrong password')
    assert.equal((await r.json()).reason, 'wrong')

    r = await admin('admin')
    assert.equal(r.status, 200, 'the right password gets the data')
    let body = await r.json()
    assert.ok(body.gaps && body.skew, 'and the answer carries both halves of the view')

    // No session was established by that: the very next request is checked
    // again, from the file, so an edit takes effect immediately.
    await writeFile(pwPath, 'changed-on-the-server\n')
    assert.equal((await admin('admin')).status, 401, 'the old password stops working without a restart')
    assert.equal((await admin('changed-on-the-server')).status, 200, 'the new one works immediately')
    await writeFile(pwPath, 'admin\n')

    // ---- 2. the gap list is fed by the real price-check path ----------------
    const post = (user, text) => fetch(`${base}/item`, {
      method: 'POST', headers: { 'x-user': user, 'content-type': 'text/plain' }, body: text
    })

    // English user: the same unusable text twice, a second one once. Two
    // entries, and their order is what the frequency claim is about.
    let res = await post('en1', GARBAGE_A)
    assert.ok(res.status >= 400, `the engine has to refuse this text (got ${res.status})`)
    await post('en1', GARBAGE_A)
    await post('en1', GARBAGE_B)
    // German user: one failure. Either the parser refuses the text, or the
    // German data set is not present in this checkout and there is no parser at
    // all — both are gaps for that user, and both are recorded under 'de'.
    await post('de1', GARBAGE_B)

    body = await (await admin('admin')).json()
    const parse = body.gaps.kinds.parse
    const langs = parse.languages.map(g => g.lang)
    assert.deepEqual(langs, ['de', 'en'], 'the list is separated by language')

    const en = parse.languages.find(g => g.lang === 'en').entries
    assert.equal(en.length, 2, 'the same text twice is one counted row, not two')
    assert.deepEqual(en.map(e => e.count), [2, 1], 'sorted by frequency, descending')
    assert.match(en[0].text, /this is not an item text at all/, 'the triggering text is kept')
    assert.ok(en[0].reason, 'and so is the reason the engine gave')

    const de = parse.languages.find(g => g.lang === 'de').entries
    assert.equal(de.length, 1)
    assert.equal(de[0].count, 1)

    // The other kind exists in the answer even while empty, so the page never
    // has to guess whether "nothing" means "no data" or "no such section".
    assert.ok(body.gaps.kinds.unknownMod, 'the unresolved-mod bucket is always present')
    assert.equal(typeof body.gaps.kinds.unknownMod.dropped, 'number')
    assert.equal(typeof body.limits.maxEntriesPerKind, 'number', 'the cap is reported, so a truncated list is honest')

    // ---- 3. the dataset offset ----------------------------------------------
    const skew = body.skew
    assert.equal(skew.base, 'en', 'English is the yardstick')
    assert.equal(skew.warnRatio, 0.02, 'the threshold comes from POE_LANG_SKEW_WARN_RATIO, not from the code')
    assert.deepEqual(body.languages, ['en', 'de'], 'the configured languages, base first')
    const deSkew = skew.languages.find(l => l.lang === 'de')
    assert.ok(deSkew, 'the second language has a row of its own')
    if (deSkew.present) {
      // A generated German set is present in this checkout — then every metric
      // is measured against English.
      assert.deepEqual(deSkew.metrics.map(m => m.key), ['items', 'stats', 'matchers', 'advanced'])
      for (const m of deSkew.metrics) {
        assert.equal(typeof m.ratio, 'number')
        assert.ok(m.base >= 0 && m.missing >= 0)
      }
    } else {
      // data/de is gitignored (generated per installation), so a fresh checkout
      // legitimately has none — and THAT is the loudest offset there is.
      assert.equal(deSkew.warn, true)
      assert.equal(skew.warn, true)
    }

    // ---- 4. where the localized set came from -------------------------------
    // The skew rows are a distance and say nothing about WHEN or FROM WHAT the
    // set was made — "is anything still generating this" used to be answerable
    // only from the container log.
    assert.ok(Array.isArray(body.langBuild), 'the answer carries the provenance block')
    assert.deepEqual(body.langBuild.map(b => b.lang), ['de'],
      'one row per generated language, English excluded — it has no run of its own')
    const deBuild = body.langBuild[0]
    if (deBuild.present) {
      // The set names what it was built from. Its run numbers may be absent —
      // a set generated before this bookkeeping has none — and then they are
      // reported as absent rather than invented as zeroes.
      assert.ok(deBuild.run === null || typeof deBuild.run === 'object')
      if (deBuild.run) {
        for (const k of ['statsEn', 'statsCovered', 'statsUncovered']) {
          assert.ok(deBuild.run[k] === null || typeof deBuild.run[k] === 'number', k)
        }
        assert.ok(Array.isArray(deBuild.run.unknownNamespaces))
      }
    } else {
      // Two ways to get here and both are "we do not know": no data set at all,
      // or one written before build-info.json existed (which is what a checkout
      // with an older generated data/de has). Neither becomes a row of zeroes.
      assert.equal(deBuild.patch, undefined)
      assert.equal(deBuild.run, undefined)
    }
  } finally {
    srv.kill('SIGTERM')
    await sleep(200)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
