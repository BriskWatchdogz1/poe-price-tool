// lang-data-gen.mjs — the CLI side of the localized data set generator.
//
// No network and no game data here: what is pinned is the checked-in hand
// table, the export config the generator writes, and the guards that keep a
// silently empty export from being mistaken for a successful run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  LANGUAGE_NAMES, STAT_DESCRIPTION_FILES, TABLE_COLUMNS,
  exportGameData, loadGameData, classifyExportFailure,
  resolvePatchVersion, buildFingerprint, buildRunSummary, PATCH_VERSION_URL, PATCH_SOURCE_PIN
} from './lang-data-gen.mjs'
import { REQUIRED_TABLES } from './lang-derive.mjs'
import { AGENT_BASE } from './version.mjs'
import { FAIL_KIND, kindOf } from './check-failure.mjs'
// The exporter's own URL builder — imported, not re-implemented, so the test
// speaks about the code that actually downloads the game data. Pure string
// work, no network.
import { toCdnUrl } from 'pathofexile-dat/bundles.js'

const PSEUDO = new URL('./lang-pseudo-matchers.json', import.meta.url)

test('the pseudo matcher hand table covers every entry for German', async () => {
  const { matchers } = JSON.parse(await readFile(PSEUDO, 'utf8'))
  const keys = Object.keys(matchers)
  // 126 in the local and in the current upstream set; they practically never
  // change, so a different number is worth looking at.
  assert.equal(keys.length, 126)
  const withoutDe = keys.filter(k => matchers[k].de == null)
  assert.deepEqual(withoutDe, [])
})

test('the trailing space is preserved on both sides of the hand table', () => {
  // It is what identifies a pseudo matcher, and it carries meaning: a matcher
  // string ending in a space can never match real game text.
  return readFile(PSEUDO, 'utf8').then(text => {
    const { matchers } = JSON.parse(text)
    for (const [en, byLang] of Object.entries(matchers)) {
      assert.ok(en.endsWith(' '), `English key without trailing space: ${JSON.stringify(en)}`)
      for (const [lang, value] of Object.entries(byLang)) {
        assert.ok(value.endsWith(' '), `${lang} value without trailing space: ${JSON.stringify(value)}`)
      }
    }
  })
})

test('the hand table carries ru and ko as the cross-check yardstick', async () => {
  const { matchers } = JSON.parse(await readFile(PSEUDO, 'utf8'))
  const values = Object.values(matchers)
  assert.equal(values.filter(v => v.ru != null).length, values.length)
  assert.equal(values.filter(v => v.ko != null).length, values.length)
  // And they are not just copies of the English key.
  const [en, first] = Object.entries(matchers)[0]
  assert.notEqual(first.ru, en)
  assert.notEqual(first.de, en)
})

test('every language code maps to a name pathofexile-dat accepts', () => {
  // The list is hardcoded in its CLI; a name outside it filters the language
  // list empty and the export exits 0 with no output.
  const accepted = ['English', 'French', 'German', 'Japanese', 'Korean',
    'Portuguese', 'Russian', 'Spanish', 'Thai', 'Traditional Chinese']
  for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
    assert.ok(accepted.includes(name), `${code} -> ${name} is not an accepted language name`)
  }
  assert.equal(LANGUAGE_NAMES.de, 'German')
})

test('the export config asks for every table the derivation needs', async () => {
  const dir = path.join(tmpdir(), `lang-gen-test-${process.pid}-config`)
  await rm(dir, { recursive: true, force: true })
  const calls = []
  await exportGameData({
    workDir: dir,
    languageName: 'German',
    patch: '3.29.2.1',
    run: (...args) => { calls.push(args); return { status: 0 } }
  })
  const config = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'))
  assert.equal(config.patch, '3.29.2.1')
  assert.deepEqual(config.translations, ['English', 'German'])
  assert.deepEqual(config.tables.map(t => t.name).sort(), [...REQUIRED_TABLES].sort())
  for (const t of config.tables) {
    if (TABLE_COLUMNS[t.name]) assert.deepEqual(t.columns, TABLE_COLUMNS[t.name])
  }
  assert.equal(config.files.length, STAT_DESCRIPTION_FILES.length)
  assert.ok(config.files.every(f => f.startsWith('Metadata/StatDescriptions/')))
  assert.equal(calls.length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('the description file list has no duplicates and covers the templates', () => {
  assert.equal(new Set(STAT_DESCRIPTION_FILES).size, STAT_DESCRIPTION_FILES.length)
  // The name-slot templates and the pre-expanded advanced texts live in these
  // two; pulling only stat_descriptions.txt would lose them.
  assert.ok(STAT_DESCRIPTION_FILES.includes('stat_descriptions.txt'))
  assert.ok(STAT_DESCRIPTION_FILES.includes('advanced_mod_stat_descriptions.txt'))
})

test('a missing patch version fails instead of producing an empty export', async () => {
  await assert.rejects(
    exportGameData({ workDir: tmpdir(), languageName: 'German', run: () => ({ status: 0 }) }),
    /patch version is missing/
  )
})

test('an export without the target language files is refused', async () => {
  // The trap: a misspelled language name leaves the tool at exit 0 with no
  // output at all. The exit code is never trusted, the files are.
  const dir = path.join(tmpdir(), `lang-gen-test-${process.pid}-empty`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(path.join(dir, 'tables/English'), { recursive: true })
  await mkdir(path.join(dir, 'files'), { recursive: true })
  for (const t of REQUIRED_TABLES) {
    await writeFile(path.join(dir, 'tables/English', `${t}.json`), '[]')
  }
  await assert.rejects(loadGameData(dir, 'German'), /export incomplete/)
  await rm(dir, { recursive: true, force: true })
})

test('a row count mismatch between the two exports is refused', async () => {
  // The join is the row index. Different lengths would pair the wrong names
  // together without anything failing.
  const dir = path.join(tmpdir(), `lang-gen-test-${process.pid}-rows`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(path.join(dir, 'tables/English'), { recursive: true })
  await mkdir(path.join(dir, 'tables/German'), { recursive: true })
  await mkdir(path.join(dir, 'files'), { recursive: true })
  for (const t of REQUIRED_TABLES) {
    await writeFile(path.join(dir, 'tables/English', `${t}.json`), '[]')
    await writeFile(path.join(dir, 'tables/German', `${t}.json`), '[]')
  }
  await writeFile(path.join(dir, 'tables/German', 'ItemClasses.json'), '[{"Name":"Ring"}]')
  await assert.rejects(loadGameData(dir, 'German'), /row count differs/)
  await rm(dir, { recursive: true, force: true })
})

test('an export without description files is refused', async () => {
  const dir = path.join(tmpdir(), `lang-gen-test-${process.pid}-nofiles`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(path.join(dir, 'tables/English'), { recursive: true })
  await mkdir(path.join(dir, 'tables/German'), { recursive: true })
  await mkdir(path.join(dir, 'files'), { recursive: true })
  for (const t of REQUIRED_TABLES) {
    await writeFile(path.join(dir, 'tables/English', `${t}.json`), '[]')
    await writeFile(path.join(dir, 'tables/German', `${t}.json`), '[]')
  }
  await assert.rejects(loadGameData(dir, 'German'), /no description files/)
  await rm(dir, { recursive: true, force: true })
})

// --- where the patch version comes from -------------------------------------
// It is the one input a run cannot derive from anything it already has, and
// getting it wrong is not loud: pathofexile-dat would happily build a CDN path
// for a patch that never existed. So the lookup is pinned here, answer shape
// included.

const patchRes = (body, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body
})

test('the patch version is read out of the CDN base the lookup answers with', async () => {
  const seen = []
  const got = await resolvePatchVersion({
    env: {},
    fetchImpl: async (url, opts) => { seen.push({ url, opts }); return (await patchRes('https://patch.poecdn.com/3.29.2.1/\n')()) }
  })
  assert.equal(got.patch, '3.29.2.1')
  assert.equal(got.source, PATCH_VERSION_URL)
  assert.equal(seen[0].url, PATCH_VERSION_URL)
  assert.equal(seen[0].opts.headers['User-Agent'], `${AGENT_BASE} (language data generator, personal LAN tool)`)
})

test('however many parts the version has, it is read — a five-part one included', async () => {
  // Measured, not invented: this is the string the lookup answered with from
  // 2026-08-13 on (a hotfix on a hotfix), and a pattern that expected at most
  // four parts refused it for four days. See docs/bugs.md, B22.
  for (const [body, patch] of [
    ['https://patch.poecdn.com/3.29.3.1.2/', '3.29.3.1.2'],
    ['https://patch.poecdn.com/3.29.3.1/', '3.29.3.1'],
    ['https://patch.poecdn.com/3.29/', '3.29'],
    ['https://patch.poecdn.com/4.1.0.1.2.3.4/', '4.1.0.1.2.3.4']
  ]) {
    const got = await resolvePatchVersion({ env: {}, fetchImpl: patchRes(body + '\n') })
    assert.equal(got.patch, patch, body)
    // Same shape through the escape hatch, or the two would drift apart.
    assert.deepEqual(
      await resolvePatchVersion({ env: { POE_PATCH_VERSION: patch }, fetchImpl: patchRes(body + '\n') }),
      { patch, source: PATCH_SOURCE_PIN, pinned: patch, lookedUp: patch, mismatch: null },
      patch
    )
  }
})

test('what is not a version is still refused, on both paths', async () => {
  // The counterweight to the unbounded part count: the string is pasted into a
  // CDN path, so a path segment, a letter or no digit at all must not pass.
  for (const bad of ['3', 'latest', '3.29.x', '3.29.', '.3.29', '3..29', '3.29.3.1.2b', '../../etc', '3 29']) {
    await assert.rejects(
      () => resolvePatchVersion({ env: {}, fetchImpl: patchRes(`https://patch.poecdn.com/${bad}/`) }),
      /no patch version in that path|expected a https:\/\/patch\.poecdn\.com\/<patch>\/ URL/,
      bad
    )
    await assert.rejects(
      () => resolvePatchVersion({ env: { POE_PATCH_VERSION: bad }, fetchImpl: async () => { throw new Error('must not be called') } }),
      /not a patch version/,
      bad
    )
  }
})

test('a five-part version survives the export config and the CDN path built from it', async () => {
  // The other half of the repair: recognising the version is worth nothing if
  // the generation cannot carry it. The exporter interpolates it into
  // <patch>/Bundles2/… and names its bundle cache after it, so a part count it
  // did not expect would surface here — the URL is built offline, nothing is
  // fetched.
  const dir = path.join(tmpdir(), `lang-gen-test-${process.pid}-five-part`)
  await rm(dir, { recursive: true, force: true })
  await exportGameData({
    workDir: dir,
    languageName: 'German',
    patch: '3.29.3.1.2',
    run: () => ({ status: 0 })
  })
  const config = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'))
  assert.equal(config.patch, '3.29.3.1.2', 'verbatim, no normalising of the part count')
  assert.equal(
    toCdnUrl(config.patch, '_.index.bin'),
    'https://patch.poecdn.com/3.29.3.1.2/Bundles2/_.index.bin'
  )
  await rm(dir, { recursive: true, force: true })
})

test('POE_PATCH_VERSION wins outright — and the lookup is asked anyway', async () => {
  // The pin decides. It is not the only opinion asked, though, and that is the
  // whole point of the second request: a pin that is valid and wrong, or valid
  // and merely old, is invisible without one.
  const got = await resolvePatchVersion({
    env: { POE_PATCH_VERSION: ' 3.30.0.1 ' },
    fetchImpl: patchRes('https://patch.poecdn.com/3.30.0.1/')
  })
  assert.deepEqual(got, {
    patch: '3.30.0.1', source: PATCH_SOURCE_PIN, pinned: '3.30.0.1', lookedUp: '3.30.0.1', mismatch: null
  })
})

test('a pin the lookup disagrees with is reported — as a difference, not as a correction', async () => {
  const got = await resolvePatchVersion({
    env: { POE_PATCH_VERSION: '3.29.2.1' },
    fetchImpl: patchRes('https://patch.poecdn.com/3.30.0.1/')
  })
  assert.equal(got.patch, '3.29.2.1', 'the pin still wins — nothing here may overrule a human')
  assert.equal(got.lookedUp, '3.30.0.1')
  assert.match(got.mismatch, /3\.29\.2\.1/)
  assert.match(got.mismatch, /3\.30\.0\.1/)
  // "The pin is stale" and "the lookup is wrong again" look identical from
  // here, so the sentence must not decide which of them it is.
  assert.ok(!/(should|probably|out of date|outdated|stale)/i.test(got.mismatch),
    `a difference is a finding, not a verdict: ${got.mismatch}`)
})

test('a lookup that is down while a pin stands costs nothing and claims nothing', async () => {
  // The situation the pin was set for. It must not turn a working tick into a
  // failing one, and it must not invent a mismatch out of a missing answer.
  const got = await resolvePatchVersion({
    env: { POE_PATCH_VERSION: '3.29.2.1' },
    fetchImpl: async () => { throw new Error('ENOTFOUND') }
  })
  assert.equal(got.patch, '3.29.2.1')
  assert.equal(got.lookedUp, null)
  assert.equal(got.mismatch, null)
})

test('a nonsense POE_PATCH_VERSION fails instead of ending up in a CDN path', async () => {
  await assert.rejects(
    () => resolvePatchVersion({ env: { POE_PATCH_VERSION: '../../etc' }, fetchImpl: async () => {} }),
    /not a patch version/
  )
})

test('an answer from anywhere but the patch CDN is refused', async () => {
  // The string ends up inside a URL that downloads game data. A redirected or
  // rewritten answer must not be able to point it somewhere else.
  for (const body of [
    'https://evil.example/3.29.2.1/',
    'https://patch.poecdn.com/',
    'not a url at all',
    ''
  ]) {
    await assert.rejects(
      () => resolvePatchVersion({ env: {}, fetchImpl: patchRes(body) }),
      /expected a https:\/\/patch\.poecdn\.com\/<patch>\/ URL|no patch version in that path/,
      JSON.stringify(body)
    )
  }
})

test('a dead lookup states what happened and prescribes nothing', async () => {
  // It used to append "Set POE_PATCH_VERSION to the current patch to keep going
  // without it" — advice, in a sentence the status line prints the CLASS's
  // advice next to. One question, two authorities. The remedy belongs to the
  // class and to the settings row that offers it; this says what was seen.
  for (const fetchImpl of [patchRes('nope', 503), async () => { throw new Error('ENOTFOUND') }]) {
    const err = await resolvePatchVersion({ env: {}, fetchImpl }).then(() => null, e => e)
    assert.ok(err)
    assert.match(err.message, /could not be looked up/)
    assert.equal(kindOf(err), FAIL_KIND.UNREACHABLE)
    assert.ok(!/\bSet POE_PATCH_VERSION\b/.test(err.message),
      `no advice in a reason: ${err.message}`)
  }
})

// --- the exit code of the exporter (docs/bugs.md B24) -----------------------
// It was ignored outright, so every way the child can die arrived at the
// operator as loadGameData()'s advice about a misspelled language name.

test('a schema the exporter cannot read is its own state, and it points at the update button', async () => {
  // The timed bomb: pathofexile-dat compares the downloaded schema against the
  // SCHEMA_VERSION compiled into it and exits 1. Its wording is quoted from
  // node_modules/pathofexile-dat/dist/cli/export-tables.js.
  const dir = path.join(tmpdir(), `lang-gen-test-${process.pid}-schema`)
  await rm(dir, { recursive: true, force: true })
  const run = () => ({
    status: 1,
    stderr: 'Schema has format not compatible with this package. Check for "pathofexile-dat" updates.\n'
  })
  const err = await exportGameData({ workDir: dir, languageName: 'German', patch: '3.29.2.1', run })
    .then(() => null, e => e)
  assert.ok(err, 'a dead export must not pass for a finished one')
  assert.equal(kindOf(err), FAIL_KIND.INCOMPATIBLE)
  assert.match(err.message, /schema/i)
  // The remedy is the CLASS's to state. A reason that also argues it puts two
  // authorities on one question, and the class is the one the page reads.
  assert.ok(!/update the container|admin area/i.test(err.message),
    `no advice in a reason: ${err.message}`)
  assert.ok(!/language/i.test(err.message),
    'it must not send the reader after a language name')
  await rm(dir, { recursive: true, force: true })
})

test('a CDN refusal is an ANSWER — and with no pin in force, waiting is right', async () => {
  // Measured against the library, not assumed: pathofexile-dat prints this on
  // exactly one branch, `!response.ok` (dist/cli/bundle-loaders.js). A request
  // nobody answered throws out of the fetch instead and never reaches it. So
  // "the CDN answered and refused" is a fact the reason may state.
  const got = classifyExportFailure({
    status: 1, stderr: 'Failed to fetch _.index.bin from CDN.\n', patch: '3.29.2.1', patchSource: 'https://example.invalid/version'
  })
  assert.equal(got.kind, FAIL_KIND.UNREACHABLE)
  assert.match(got.reason, /_\.index\.bin/)
  assert.match(got.reason, /refused/)
  assert.ok(!/tries again|nothing to fix/i.test(got.reason), `no advice in a reason: ${got.reason}`)
})

test('the same refusal under a PIN is not weather — it names the pin and is not unreachable', async () => {
  // The silent failure this pass exists for: `3.29.9.9` passes PATCH_RE, the
  // CDN refuses every file for it, and the operator was told "nothing to do,
  // the next check tries again" — for ever, about a value they typed in
  // themselves.
  const got = classifyExportFailure({
    status: 1,
    stderr: 'Failed to fetch _.index.bin from CDN.\n',
    patch: '3.29.9.9',
    patchSource: PATCH_SOURCE_PIN
  })
  assert.notEqual(got.kind, FAIL_KIND.UNREACHABLE)
  assert.equal(got.kind, FAIL_KIND.REJECTED)
  assert.match(got.reason, /POE_PATCH_VERSION/)
  assert.match(got.reason, /3\.29\.9\.9/)
})

test('a mark only counts on the line the exporter printed it on', async () => {
  // `includes` over the whole excerpt is a false positive waiting to be quoted
  // into existence: the export names every file it fetches, and one carrying
  // the schema sentence would turn a CDN refusal into a version conflict.
  const got = classifyExportFailure({
    status: 1,
    stderr: 'Loading from CDN: Schema has format not compatible with this package.bin ...\n' +
      'Failed to fetch Schema has format not compatible with this package.bin from CDN.\n'
  })
  assert.equal(got.kind, FAIL_KIND.UNREACHABLE, `classified as ${got.kind}: ${got.reason}`)
})

test('a column the schema no longer has names the table and the column', async () => {
  const got = classifyExportFailure({
    status: 1,
    stderr: 'Table "BaseItemTypes" doesn\'t have a column named "Name".\n'
  })
  assert.equal(got.kind, FAIL_KIND.INCOMPATIBLE)
  assert.match(got.reason, /BaseItemTypes/)
  assert.match(got.reason, /"Name"/)
})

test('a failure nobody recognises quotes what it printed and claims nothing', async () => {
  const got = classifyExportFailure({ status: 3, stderr: 'RangeError: out of memory\n' })
  assert.equal(got.kind, FAIL_KIND.UNKNOWN)
  assert.match(got.reason, /exited with code 3/)
  assert.match(got.reason, /RangeError: out of memory/)
  // A killed child is not an exit code, and is not dressed up as one either.
  const killed = classifyExportFailure({ status: null, signal: 'SIGKILL', stderr: '' })
  assert.equal(killed.kind, FAIL_KIND.UNKNOWN)
  assert.match(killed.reason, /killed by SIGKILL/)
})

test('a clean exit stays a clean exit — the file checks remain the proof', async () => {
  assert.equal(classifyExportFailure({ status: 0, stderr: 'noise' }), null)
  assert.equal(classifyExportFailure({}), null, 'a test double that reports nothing is still legal')
})

test('an export with English but no target language says THAT, and only then blames the name', async () => {
  const dir = path.join(tmpdir(), `lang-gen-test-${process.pid}-langname`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(path.join(dir, 'tables/English'), { recursive: true })
  await mkdir(path.join(dir, 'files'), { recursive: true })
  for (const t of REQUIRED_TABLES) await writeFile(path.join(dir, 'tables/English', `${t}.json`), '[]')
  await assert.rejects(loadGameData(dir, 'German'), /did not accept "German" as a translation name/)

  // ...and with NEITHER side there it is not about the language at all.
  await rm(path.join(dir, 'tables/English'), { recursive: true, force: true })
  await assert.rejects(loadGameData(dir, 'German'), /not about the language name/)
  await rm(dir, { recursive: true, force: true })
})

test('the lookup says WHICH kind of failure it was, so the status line can advise', async () => {
  // "The service is away" is waited out; "the service answered something else"
  // and "the value you set is not a version" are not. The status line prints a
  // different sentence for each, and it must not have to read the wording to
  // tell them apart (check-failure.mjs, docs/bugs.md B24).
  const kind = async fn => {
    try { await fn(); assert.fail('should have thrown') } catch (e) { return kindOf(e) }
  }
  assert.equal(
    await kind(() => resolvePatchVersion({ env: {}, fetchImpl: patchRes('nope', 503) })),
    FAIL_KIND.UNREACHABLE)
  assert.equal(
    await kind(() => resolvePatchVersion({ env: {}, fetchImpl: async () => { throw new Error('ENOTFOUND') } })),
    FAIL_KIND.UNREACHABLE)
  assert.equal(
    await kind(() => resolvePatchVersion({ env: {}, fetchImpl: patchRes('<html>captive portal</html>') })),
    FAIL_KIND.REJECTED)
  assert.equal(
    await kind(() => resolvePatchVersion({ env: {}, fetchImpl: patchRes('https://patch.poecdn.com/latest/') })),
    FAIL_KIND.REJECTED)
  assert.equal(
    await kind(() => resolvePatchVersion({ env: { POE_PATCH_VERSION: 'latest' }, fetchImpl: async () => {} })),
    FAIL_KIND.REJECTED)
})

test('the run summary carries the numbers the run measured, and nothing it did not', () => {
  const run = {
    result: {
      counts: {
        statsEn: 9278, statsDe: 9278, covered: 8773, uncovered: 505,
        baselineCovered: 8770, regressedRefs: ['a'], newGapRefs: ['b', 'c']
      }
    },
    items: { report: { total: 4891, translated: 4888, kept: ['x', 'y', 'z'], unknownNamespaces: [{ namespace: 'CHARM', lines: 12 }] } }
  }
  assert.deepEqual(buildRunSummary(run), {
    statsEn: 9278,
    statsCovered: 8773,
    statsUncovered: 505,
    baselineCovered: 8770,
    regressed: 1,
    newGaps: 2,
    itemsTotal: 4891,
    itemsTranslated: 4888,
    itemsKeptEnglish: 3,
    unknownNamespaces: [{ namespace: 'CHARM', lines: 12 }]
  })
  // A first build has no baseline. `null` and not `0`: the admin area prints
  // "first build" for the one and a measured loss for the other.
  const first = buildRunSummary({
    result: { counts: { statsEn: 10, covered: 9, uncovered: 1, baselineCovered: null, regressedRefs: [], newGapRefs: ['q'] } }
  })
  assert.equal(first.baselineCovered, null)
  assert.equal(first.itemsTotal, null, 'a half report reports halves, it does not invent the other half')
  assert.equal(buildRunSummary(undefined), null, 'nothing measured, nothing claimed')
  assert.equal(buildRunSummary({ ok: true }), null)
})

test('the fingerprint tracks the skeleton and nothing else', () => {
  const a = buildFingerprint('items\n', 'stats\n')
  assert.equal(a, buildFingerprint('items\n', 'stats\n'))
  assert.notEqual(a, buildFingerprint('items!\n', 'stats\n'))
  assert.notEqual(a, buildFingerprint('items\n', 'stats!\n'))
  // Not concatenation-ambiguous: the two halves cannot be shifted into each
  // other without changing the result.
  assert.notEqual(buildFingerprint('ab', 'c'), buildFingerprint('a', 'bc'))
})
