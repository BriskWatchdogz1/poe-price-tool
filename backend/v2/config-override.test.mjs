// config-overrides.mjs — the file in /config that beats the environment.
//
// The claims that matter and would be expensive to discover in production:
//   1. the override wins over a real env value, and the view SAYS so,
//   2. the boot quarantine ends a restart loop after a BOUNDED number of failed
//      starts — and costs nothing after a single one, because a single one is
//      almost never the overrides' fault (a restart, a host reboot or an OOM
//      kill inside the boot window all look exactly the same from here),
//   3. nothing whose NAME could name a credential leaves through the view — not
//      even when it is smuggled into the allow-list itself,
//   4. no error message repeats the content of the file it failed to read,
//   5. the numbers on the list come from numeric-settings.mjs and are never
//      restated here — the browser path may narrow a range, never widen one,
//   6. importing this module still reads nothing out of the environment, which
//      is the promise config-boot.mjs is built on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  SETTABLE, SETTABLE_BY_NAME, SECRET_KEY_RE, QUARANTINE_AFTER_FAILED_STARTS,
  validateSetting, applyConfigOverrides, clearApplyingMarker,
  markerPathFor, rejectedPathFor,
  readOverrideFile, setOverride, configView, redactView
} from './config-overrides.mjs'
import { jsonErrorSummary } from './json-error.mjs'
import { NUMERIC_SETTINGS_BY_NAME } from './numeric-settings.mjs'
import { readEnvNumber, resetEnvNumberWarnings } from './env-number.mjs'

const exists = p => stat(p).then(() => true, () => false)
const quiet = { log: () => {}, warn: () => {} }
function recorder () {
  const warnings = []
  return { warnings, log: () => {}, warn: m => warnings.push(String(m)) }
}

test('the allow-list holds nothing secret and nothing that would orphan data', () => {
  for (const spec of SETTABLE) {
    assert.ok(!SECRET_KEY_RE.test(spec.name), `${spec.name} must not be settable from a web form`)
    assert.ok(spec.description, `${spec.name} needs a description — the settings page builds its label from it`)
    assert.ok(['live', 'restart'].includes(spec.apply), `${spec.name}: apply must be live or restart`)
    assert.ok(['bool', 'int', 'string', 'enum'].includes(spec.type), `${spec.name}: unknown type`)
    if (spec.type === 'enum') assert.ok(spec.values?.length, `${spec.name}: an enum needs its values`)
  }
  // POE_USERS keys the rooms, the stores and the credential file. One click in
  // a browser must not be able to orphan all of that.
  assert.equal(SETTABLE_BY_NAME.has('POE_USERS'), false)
  // No paths and no ports either.
  for (const spec of SETTABLE) assert.ok(!/_FILE$|_DIR$|_STORE$|_PATH$|^PORT$/.test(spec.name), spec.name)
})

// ---------------------------------------------------------------------------
// The settings that are deliberately absent. Each one was argued once (see the
// block above the validation in config-overrides.mjs and the same list in
// docs/admin.md); this is what keeps somebody from adding one back on a quiet
// afternoon because it "would be convenient".
// ---------------------------------------------------------------------------
test('the switches that would turn the tool against itself are not on the list', () => {
  // The main feature. Set from a web form it would leave every card unpriced
  // with nothing on the page explaining it.
  assert.equal(SETTABLE_BY_NAME.has('POE_PRICE_CHECK_DISABLED'), false)
  // The rate-limit audit exists BECAUSE of the two trade-API bans. A page that
  // can blind the tool to how full its windows are is the wrong page — and the
  // threshold has no upper bound, so a "2" in a form silences it just as well.
  assert.equal(SETTABLE_BY_NAME.has('POE_TRADE_AUDIT'), false)
  assert.equal(SETTABLE_BY_NAME.has('POE_TRADE_AUDIT_THRESHOLD'), false)
  // The one numeric setting with no default of its own: the page could not say
  // what clearing the field would give you.
  assert.equal(NUMERIC_SETTINGS_BY_NAME.get('POE_FAUSTUS_UNION_HOURS').fallback, undefined,
    'if this ever gains a default, the reason it is kept out has gone')
  assert.equal(SETTABLE_BY_NAME.has('POE_FAUSTUS_UNION_HOURS'), false)
})

// ---------------------------------------------------------------------------
// The two lists are one list. numeric-settings.mjs holds the default and the
// range; the allow-list holds who may see it and what it is for. A second copy
// of a default is a second thing to keep in step, and the copy that drifts is
// always the one nobody reads.
// ---------------------------------------------------------------------------
const numericSettable = SETTABLE.filter(s => NUMERIC_SETTINGS_BY_NAME.has(s.name))

test('every number on the allow-list comes out of the numeric table, and nothing else does', () => {
  assert.ok(numericSettable.length >= 15, 'the admin area is meant to reach most of that table')
  for (const spec of SETTABLE) {
    if (spec.type !== 'int') continue
    assert.ok(NUMERIC_SETTINGS_BY_NAME.has(spec.name),
      `${spec.name} is an int on the allow-list but not in numeric-settings.mjs — its default and range would live in two places`)
  }
  for (const spec of numericSettable) {
    const table = NUMERIC_SETTINGS_BY_NAME.get(spec.name)
    assert.equal(spec.defaultValue, String(table.fallback),
      `${spec.name}: the displayed default is not the one the server would fall back to`)
  }
})

test('the allow-list may narrow a range for the browser, never widen one', () => {
  for (const spec of numericSettable) {
    const table = NUMERIC_SETTINGS_BY_NAME.get(spec.name)
    // What env-number.mjs itself would accept as the smallest value.
    const floor = table.min != null ? table.min : (table.zero ? 0 : 1)
    assert.ok(spec.min != null && spec.min >= floor,
      `${spec.name}: the form accepts ${spec.min}, the reader's floor is ${floor}`)
    if (table.max != null) {
      assert.ok(spec.max != null && spec.max <= table.max,
        `${spec.name}: the form accepts up to ${spec.max}, the table stops at ${table.max}`)
    }
  }
  // The narrowing there is today, kept as a worked example: the table sets no
  // upper bound on the refresher interval — an hour between ticks is still a
  // refresher, and the environment may say so — while the browser path stops
  // there. The FLOOR of that same row is no longer an example of narrowing: it
  // moved into the table, because 5 s typed into a compose file is the same 720
  // stash reads an hour as 5 s typed into the form.
  const sync = SETTABLE_BY_NAME.get('POE_NETWORTH_SYNC_INTERVAL_MS')
  const syncTable = NUMERIC_SETTINGS_BY_NAME.get('POE_NETWORTH_SYNC_INTERVAL_MS')
  assert.equal(syncTable.max, undefined)
  assert.equal(sync.max, 3600000)
  assert.equal(validateSetting('POE_NETWORTH_SYNC_INTERVAL_MS', 7200000).ok, false,
    'the form must refuse what it narrowed away')
  assert.equal(readEnvNumber(syncTable, { env: { POE_NETWORTH_SYNC_INTERVAL_MS: '7200000' }, log: quiet }), 7200000,
    '...and the environment must still take it, or this is not a narrowing but a second range')
})

// ---------------------------------------------------------------------------
// The eight dials that decide how often somebody else's server gets asked are
// reachable through a web form behind a password. Their ranges are pinned HERE,
// each with the reason its number can be pointed at, so that widening one is a
// deliberate edit to a test that says why — never a side effect of tidying a
// table. The rule behind all of them: a ban has been reported to apply to the
// whole ADDRESS, so every path in this tool may be spending one budget. In
// doubt, fewer requests.
// ---------------------------------------------------------------------------
test('every request-volume setting has a floor (and the one budget a ceiling) that can be argued', () => {
  const expected = {
    // name: [min, max]   max null = "raising it only ever sends less"
    POE_NETWORTH_SYNC_INTERVAL_MS: [30_000, 3_600_000], // the pace the design is argued at
    POE_NETWORTH_COOLDOWN_MS: [600_000, null],          // the documented wait after a 429
    POE_CORPSE_INTERVAL_MS: [120_000, null],            // the pricer's own one-name-per-2min pace
    POE_CORPSE_TTL_MS: [3_600_000, null],               // the pricer's rolling budget window
    POE_CORPSE_BUDGET_PER_HOUR: [0, 30],                // 0 = ask nothing; 30 = all the pacing can deliver
    POE_FAUSTUS_REFRESH_MS: [3_600_000, null],          // the digests are hourly
    POE_CD_REFRESH_MS: [900_000, null],                 // NINJA_MIN_MS, which the server enforces anyway
    POE_DATA_REFRESH_MS: [3_600_000, null]              // patch-cadence sources, trade-budget catalogue call
  }
  // A SWITCH IS NOT IN THIS TABLE, and that is not an omission. "Floor" is a
  // statement about a number that can be turned down until it is dangerous; a
  // boolean has two states and both of them are bounded by being the only two.
  // What it still owes is the direction, which the next test checks. So the
  // request-volume settings are split here rather than the marking being
  // weakened, and a new SWITCH has to be named below to pass.
  const switches = SETTABLE.filter(s => s.traffic && s.type !== 'int').map(s => s.name).sort()
  assert.deepEqual(switches, ['POE_NETWORTH_SKIP_TIER_MAPS'],
    'a request-volume SWITCH appeared or vanished — name it here')

  assert.deepEqual(SETTABLE.filter(s => s.traffic && s.type === 'int').map(s => s.name).sort(), Object.keys(expected).sort(),
    'a request-volume setting appeared or vanished — give it a range and a reason here')

  for (const [name, [min, max]] of Object.entries(expected)) {
    const spec = SETTABLE_BY_NAME.get(name)
    assert.equal(spec.min, min, `${name}: floor changed`)
    assert.equal(spec.max ?? null, max, `${name}: ceiling changed`)
    // The form is not the only door. The compose file has to be bound by the
    // same number, or the tightening is theatre.
    const table = NUMERIC_SETTINGS_BY_NAME.get(name)
    if (min - 1 >= 0) {
      assert.equal(readEnvNumber(table, { env: { [name]: String(min - 1) }, log: quiet }), table.fallback,
        `${name}=${min - 1} was accepted out of the environment`)
    }
  }

  // The invariant those numbers serve, stated once: nothing reachable from the
  // browser can ask more often than every 30 seconds, and the one setting that
  // grows with its number is capped at all.
  for (const s of SETTABLE.filter(x => x.traffic === 'lower' && x.type === 'int')) {
    assert.ok(s.min >= 30_000, `${s.name}: a request-volume period of ${s.min}ms is reachable from a form`)
  }
  for (const s of SETTABLE.filter(x => x.traffic === 'higher')) {
    assert.ok(s.max != null, `${s.name}: a budget with no ceiling`)
  }
})

// The behaviour change these floors are: an installation whose compose file
// already holds a value that is now out of range. It must cost a log line, not
// a container. The rule is env-number.mjs's ordinary one — say so, use the
// default — and this is that rule applied to the case this change created.
test('an installation with a now-illegal value warns loudly and runs on the default', () => {
  const log = recorder()
  resetEnvNumberWarnings()
  const spec = NUMERIC_SETTINGS_BY_NAME.get('POE_CORPSE_INTERVAL_MS')
  assert.equal(readEnvNumber(spec, { env: { POE_CORPSE_INTERVAL_MS: '1' }, log }), spec.fallback,
    'the default is what runs')
  assert.equal(log.warnings.length, 1, 'exactly one line, not one per read')
  assert.match(log.warnings[0], /POE_CORPSE_INTERVAL_MS=1 /)
  assert.match(log.warnings[0], /below the minimum of 120000/)
  assert.match(log.warnings[0], /using 120000 instead/)
})

test('a value the form accepts is a value the reader accepts — no form can write a number the server then refuses', () => {
  for (const spec of numericSettable) {
    const table = NUMERIC_SETTINGS_BY_NAME.get(spec.name)
    const probes = [spec.min, spec.min + 1, Number(spec.defaultValue), spec.max, spec.max == null ? spec.min * 7 + 3 : spec.max - 1]
    for (const n of probes) {
      if (n == null || !Number.isInteger(n)) continue
      const check = validateSetting(spec.name, String(n))
      if (!check.ok) continue
      assert.equal(
        readEnvNumber(table, { env: { [spec.name]: check.value }, log: { warn: () => {} } }), n,
        `${spec.name}=${n} passes the settings page and is then thrown away by env-number.mjs`)
    }
    // ...and one step below the floor is refused by the form, so the round trip
    // above is not vacuously true.
    assert.equal(validateSetting(spec.name, String(spec.min - 1)).ok, false, `${spec.name}: ${spec.min - 1} should be refused`)
  }
})

test('the corpse budget can still be set to zero from the browser — the case the numeric table exists for', () => {
  const r = validateSetting('POE_CORPSE_BUDGET_PER_HOUR', 0)
  assert.deepEqual(r, { ok: true, value: '0' })
  assert.equal(SETTABLE_BY_NAME.get('POE_CORPSE_BUDGET_PER_HOUR').min, 0)
  // ...while zero on a setting the table refuses it for cannot be written here
  // either. Both answers come from that one table.
  assert.equal(validateSetting('POE_CORPSE_INTERVAL_MS', 0).ok, false)
  assert.equal(validateSetting('POE_NETWORTH_COOLDOWN_MS', 0).ok, false)
})

// ---------------------------------------------------------------------------
// The request-volume group. What it is worth is not that a heading renders: it
// is that the marking is honest in both directions, because a settings page
// that cries wolf on a harmless row teaches people to ignore the row that is
// not harmless.
// ---------------------------------------------------------------------------
test('the settings that change how often somebody else is asked are marked, and only those', () => {
  const marked = SETTABLE.filter(s => s.traffic).map(s => s.name).sort()
  for (const s of SETTABLE) {
    if (s.traffic == null) continue
    assert.ok(['higher', 'lower'].includes(s.traffic), `${s.name}: traffic must say WHICH direction`)
  }
  assert.deepEqual(marked, [
    'POE_CD_REFRESH_MS',            // poe.ninja
    'POE_CORPSE_BUDGET_PER_HOUR',   // trade API — the one that grows with the number
    'POE_CORPSE_INTERVAL_MS',       // trade API
    'POE_CORPSE_TTL_MS',            // trade API, by way of re-asking
    'POE_DATA_REFRESH_MS',          // the data sources
    'POE_FAUSTUS_REFRESH_MS',       // GGG's exchange CDN
    'POE_NETWORTH_COOLDOWN_MS',     // GGG's stash API, after a 429
    'POE_NETWORTH_SKIP_TIER_MAPS',  // GGG's stash API — the only switch in the group
    'POE_NETWORTH_SYNC_INTERVAL_MS' // GGG's stash API
  ])
  assert.equal(SETTABLE_BY_NAME.get('POE_NETWORTH_SKIP_TIER_MAPS').traffic, 'lower',
    'switching the skip ON is what sends less, so it runs the same way round as the intervals')
  assert.equal(SETTABLE_BY_NAME.get('POE_CORPSE_BUDGET_PER_HOUR').traffic, 'higher',
    'a budget is the one that grows with the number; everything else here shrinks')
  for (const name of ['POE_CD_REFRESH_MS', 'POE_CORPSE_INTERVAL_MS', 'POE_NETWORTH_SYNC_INTERVAL_MS']) {
    assert.equal(SETTABLE_BY_NAME.get(name).traffic, 'lower')
  }
  // The two that LOOK like traffic settings and are not. Marking them would be
  // the cheap move and would make the whole group less believable.
  //   POE_MAX_LISTINGS: all ten ids go out in ONE fetch call.
  //   POE_NETWORTH_LIST_TTL_MS: a tick refreshes the list OR syncs a tab, never
  //     both — a shorter life spends the same requests on the list instead of
  //     on a tab. The count does not move; the coverage does.
  assert.equal(SETTABLE_BY_NAME.get('POE_MAX_LISTINGS').traffic, undefined)
  assert.equal(SETTABLE_BY_NAME.get('POE_NETWORTH_LIST_TTL_MS').traffic, undefined)
  assert.equal(SETTABLE_BY_NAME.get('POE_FAUSTUS_TTL_MS').traffic, undefined)
})

test('the view carries the marking through, so the page never has to guess', () => {
  const view = configView({ state: null, env: {}, overrides: {} })
  const byName = Object.fromEntries(view.settings.map(s => [s.name, s]))
  assert.equal(byName.POE_CORPSE_BUDGET_PER_HOUR.traffic, 'higher')
  assert.equal(byName.POE_CORPSE_INTERVAL_MS.traffic, 'lower')
  assert.equal(byName.POE_APP_NAME.traffic, undefined)
  // The numbers reach the form too, or it cannot enforce anything.
  assert.equal(byName.POE_CORPSE_BUDGET_PER_HOUR.min, 0)
  assert.equal(byName.POE_CORPSE_BUDGET_PER_HOUR.defaultValue, '25')
  assert.equal(byName.POE_MAX_LISTINGS.max, 10)
})

// ---------------------------------------------------------------------------
// POE_PATCH_VERSION: the escape hatch that used to need the very SSH session it
// exists to save (docs/bugs.md B24). Two things have to hold — the form and the
// start have to agree about what a version is, and the value has to be in force
// without a restart.
// ---------------------------------------------------------------------------
test('the patch version is settable, and the form accepts exactly what the start accepts', async () => {
  const spec = SETTABLE_BY_NAME.get('POE_PATCH_VERSION')
  assert.ok(spec, 'the documented escape hatch is reachable from the admin area')
  assert.equal(spec.type, 'string')
  assert.equal(spec.defaultValue, '', 'unset is the normal state, and it is not dressed up as a value')

  for (const good of ['3.29.2.1', '3.29.3.1.2', '3.29', '4.1.0.1.2.3.4']) {
    assert.deepEqual(validateSetting('POE_PATCH_VERSION', good), { ok: true, value: good }, good)
    // ...and the reading side agrees, which is the whole point of the shared
    // expression: this is the module the server resolves the version through.
    const { resolvePatchVersion } = await import('./lang-data-gen.mjs')
    assert.equal(
      (await resolvePatchVersion({ env: { POE_PATCH_VERSION: good }, fetchImpl: async () => { throw new Error('no network') } })).patch,
      good)
  }
  for (const bad of ['latest', '3', '../../etc', '3.29.x', 'https://patch.poecdn.com/3.29.2.1/', '']) {
    assert.equal(validateSetting('POE_PATCH_VERSION', bad).ok, false, bad)
  }
  // A value the form takes must never be one the start refuses, so the error
  // even names the shape rather than "invalid".
  assert.match(validateSetting('POE_PATCH_VERSION', 'latest').error, /digits and dots/)
})

test('the patch version takes effect without a restart — checked at the read site', async () => {
  // `live` is a promise about WHERE the value is read: resolvePatchVersion()
  // reads process.env when it is CALLED, once per lang-data tick. Claiming
  // `live` for something read at module load would be worse than admitting
  // `restart`, so the claim is proven here rather than repeated.
  assert.equal(SETTABLE_BY_NAME.get('POE_PATCH_VERSION').apply, 'live')
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-patch-'))
  const path = join(dir, 'overrides.json')
  const before = process.env.POE_PATCH_VERSION
  try {
    const r = await setOverride({ path, state: { baseEnv: {}, applied: {} }, name: 'POE_PATCH_VERSION', value: '3.29.9.9' })
    assert.equal(r.applied, 'live')
    assert.equal(process.env.POE_PATCH_VERSION, '3.29.9.9')
    const { resolvePatchVersion } = await import('./lang-data-gen.mjs')
    // The saved value decides the very next resolution. The lookup is still
    // asked — for the second opinion the mismatch warning is built from — and
    // its answer changes nothing about which patch is used.
    const got = await resolvePatchVersion({ fetchImpl: async () => { throw new Error('the lookup is down') } })
    assert.equal(got.patch, '3.29.9.9', 'the very next lookup uses it')
    assert.equal(got.source, 'POE_PATCH_VERSION')
    assert.equal(got.mismatch, null, 'a lookup that did not answer is not a disagreement')
    // ...and removing it puts the lookup back.
    await setOverride({ path, state: { baseEnv: {}, applied: {} }, name: 'POE_PATCH_VERSION', value: null })
    assert.equal(process.env.POE_PATCH_VERSION, undefined)
  } finally {
    if (before === undefined) delete process.env.POE_PATCH_VERSION
    else process.env.POE_PATCH_VERSION = before
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// docs/admin.md names the allow-list in prose, for an operator who is reading
// the documentation rather than the page. Prose does not fail a build, so this
// is what stops it from describing last month's tool.
// ---------------------------------------------------------------------------
test('docs/admin.md lists exactly the settings the allow-list holds', async () => {
  const md = await readFile(fileURLToPath(new URL('../../docs/admin.md', import.meta.url)), 'utf8')
  const from = md.indexOf('**What can be set**')
  const to = md.indexOf('**What can never be set**', from)
  assert.ok(from > 0 && to > from, 'the section that names the allow-list is gone from the documentation')
  const named = [...new Set(md.slice(from, to).match(/POE_[A-Z0-9_]+/g) || [])].sort()
  assert.deepEqual(named, SETTABLE.map(s => s.name).sort(),
    'docs/admin.md and config-overrides.mjs disagree about what the admin area can change')

  // ...and the ones that are kept out on purpose are named as kept out, where
  // somebody looking for them will actually be reading.
  const never = md.slice(to, to + 4000)
  for (const name of ['POE_USERS', 'POE_PRICE_CHECK_DISABLED', 'POE_TRADE_AUDIT_THRESHOLD', 'POE_FAUSTUS_UNION_HOURS']) {
    assert.ok(never.includes(name), `docs/admin.md does not say why ${name} is not settable`)
  }
})

// ---------------------------------------------------------------------------
// config-boot.mjs's whole reason to exist: the overrides are in process.env
// BEFORE the first module-level POE_… read anywhere in the import graph. It can
// only keep that promise if importing config-overrides.mjs reads nothing
// itself — and this module's import graph grew when it started reading
// numeric-settings.mjs for its defaults and ranges. So the promise is measured
// instead of argued: a child process swaps process.env for a recording proxy,
// imports the module, and reports every POE_ name that was touched on the way.
// ---------------------------------------------------------------------------
function settingsReadWhileImporting (file) {
  const target = pathToFileURL(fileURLToPath(new URL(file, import.meta.url))).href
  const probe = `
    const real = process.env
    const seen = []
    process.env = new Proxy(real, {
      get (t, k) { if (typeof k === 'string' && /^(POE_|PORT$)/.test(k)) seen.push(k); return t[k] }
    })
    await import(${JSON.stringify(target)})
    process.env = real
    console.log('SEEN:' + JSON.stringify(seen))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], { encoding: 'utf8' })
  assert.equal(r.status, 0, `the probe did not run for ${file}:\n${r.stderr}`)
  const line = r.stdout.split('\n').find(l => l.startsWith('SEEN:'))
  assert.ok(line, `the probe printed nothing usable for ${file}:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(line.slice(5))
}

test('importing config-overrides.mjs reads no setting out of the environment', () => {
  // Negative control first: a probe that finds nothing looks exactly like a
  // probe that is broken. config-boot.mjs is the module whose ENTIRE job is to
  // read the environment at load, so it has to light this up.
  assert.ok(settingsReadWhileImporting('./config-boot.mjs').includes('POE_CONFIG_OVERRIDES'),
    'the probe cannot see an env read at all — it would pass on anything')

  assert.deepEqual(settingsReadWhileImporting('./config-overrides.mjs'), [],
    'a module in the import graph of config-overrides.mjs reads a setting at load time — ' +
    'it would read it BEFORE applyConfigOverrides() has put the /config file into the environment')
})

test('validation is per type and refuses instead of writing', () => {
  assert.deepEqual(validateSetting('POE_CORPSE_DISABLED', true), { ok: true, value: '1' })
  assert.deepEqual(validateSetting('POE_CORPSE_DISABLED', 'off'), { ok: true, value: '0' })
  assert.equal(validateSetting('POE_CORPSE_DISABLED', 'maybe').ok, false)

  assert.deepEqual(validateSetting('POE_MAX_LISTINGS', '7'), { ok: true, value: '7' })
  assert.equal(validateSetting('POE_MAX_LISTINGS', '11').ok, false, 'the trade API refuses more than 10')
  assert.equal(validateSetting('POE_MAX_LISTINGS', '2.5').ok, false)
  assert.equal(validateSetting('POE_MAX_LISTINGS', 'lots').ok, false)

  assert.equal(validateSetting('POE_LANG_DEFAULT', 'en').ok, true)
  assert.equal(validateSetting('POE_LANG_DEFAULT', 'kl').ok, false)

  assert.equal(validateSetting('POE_APP_NAME', 'x'.repeat(200)).ok, false)
  assert.equal(validateSetting('POE_APP_NAME', 'Line\nbreak').ok, false, 'this ends up in an env var and a log line')
  assert.deepEqual(validateSetting('POE_APP_NAME', '  Spaced  '), { ok: true, value: 'Spaced' })

  assert.equal(validateSetting('POE_SESSID', 'anything').ok, false, 'not on the list at all')
  assert.equal(validateSetting('POE_USERS', 'a,b').ok, false)
  assert.equal(validateSetting('POE_CORPSE_DISABLED', '').ok, false)
  assert.equal(validateSetting('POE_CORPSE_DISABLED', { a: 1 }).ok, false)
})

test('an override beats the environment, and the view names the source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  try {
    const path = join(dir, 'overrides.json')
    await writeFile(path, JSON.stringify({ POE_APP_NAME: 'From the browser', POE_MAX_LISTINGS: 5 }))
    // The compose file says something else for one of the two.
    const env = { POE_APP_NAME: 'From compose', POE_LEAGUE: 'Standard' }

    const state = applyConfigOverrides({ path, env, log: quiet })
    assert.equal(env.POE_APP_NAME, 'From the browser', 'the deliberate, newer value wins')
    assert.equal(env.POE_MAX_LISTINGS, '5')
    assert.deepEqual(state.shadowedEnv, ['POE_APP_NAME'])

    const view = configView({ state, env, overrides: await readOverrideFile(path), runtime: [] })
    const byName = Object.fromEntries(view.settings.map(s => [s.name, s]))
    assert.equal(byName.POE_APP_NAME.source, 'override')
    assert.equal(byName.POE_APP_NAME.shadowsEnv, true,
      'or somebody spends an afternoon wondering why their compose value does nothing')
    assert.equal(byName.POE_APP_NAME.envValue, 'From compose')
    assert.equal(byName.POE_MAX_LISTINGS.shadowsEnv, false, 'nothing was shadowed there')
    assert.equal(byName.POE_LEAGUE.source, 'env')
    assert.equal(byName.POE_LEAGUE.value, 'Standard')
    assert.equal(byName.POE_NETWORTH_DEBUG.source, 'default')
    assert.equal(byName.POE_NETWORTH_DEBUG.value, byName.POE_NETWORTH_DEBUG.defaultValue)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an entry that fails validation is ignored, the rest is applied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  try {
    const path = join(dir, 'overrides.json')
    await writeFile(path, JSON.stringify({
      POE_MAX_LISTINGS: 99,          // out of range
      POE_SESSID: 'nope',            // not settable at all
      POE_CORPSE_DISABLED: '1'       // fine
    }))
    const env = {}
    const log = recorder()
    const state = applyConfigOverrides({ path, env, log })
    assert.deepEqual(state.applied, { POE_CORPSE_DISABLED: '1' })
    assert.equal(env.POE_SESSID, undefined, 'a key outside the allow-list never reaches the environment')
    assert.equal(env.POE_MAX_LISTINGS, undefined)
    assert.equal(state.problems.length, 2)
    assert.ok(log.warnings.length >= 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('broken JSON is ignored without stopping the start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  try {
    const path = join(dir, 'overrides.json')
    await writeFile(path, '{ nope')
    const env = {}
    const state = applyConfigOverrides({ path, env, log: quiet })
    assert.deepEqual(state.applied, {})
    assert.equal(state.problems.length, 1)
    assert.equal(await exists(markerPathFor(path)), false, 'and no marker is left behind')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// The boot quarantine — the whole cycle, in order.
// ---------------------------------------------------------------------------
test('boot quarantine: ONE failed start keeps the configuration, a repeated one costs it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  try {
    const path = join(dir, 'overrides.json')
    const marker = markerPathFor(path)
    const rejected = rejectedPathFor(path)
    await writeFile(path, JSON.stringify({ POE_LEAGUE: 'Some League' }))

    // --- start 1: applies them, and the marker is up while it boots ---------
    let env = {}
    let state = applyConfigOverrides({ path, env, log: quiet })
    assert.equal(env.POE_LEAGUE, 'Some League')
    assert.equal(state.failedStarts, 0, 'nothing had failed before this one')
    assert.equal(await exists(marker), true, 'the marker is written BEFORE the values take effect')

    // ...and this start dies before it ever listens (no clearApplyingMarker).
    // A `docker compose restart` typed during the boot looks exactly like this,
    // and so does a host reboot and an OOM kill. Which is the whole reason the
    // next start must NOT throw the configuration away.

    // --- start 2: finds the marker, and gives the file another chance -------
    env = {}
    let log = recorder()
    state = applyConfigOverrides({ path, env, log })
    assert.equal(state.failedStarts, 1)
    assert.equal(state.quarantined, false,
      'one interrupted boot is not evidence that the overrides are to blame')
    assert.equal(env.POE_LEAGUE, 'Some League', 'so they are applied again')
    assert.equal(await exists(path), true, 'and the file stays where it is')
    assert.equal(await exists(rejected), false)
    assert.ok(log.warnings.some(w => w.includes("did not reach 'listening'")),
      'but it is said out loud, so a boot that really is dying is visible in the log')

    // ...and this one dies in the same window.

    // --- start 3: the count reaches the threshold -> quarantine -------------
    assert.equal(QUARANTINE_AFTER_FAILED_STARTS, 2,
      'the assertions below are written for this threshold')
    env = {}
    log = recorder()
    state = applyConfigOverrides({ path, env, log })
    assert.equal(state.failedStarts, QUARANTINE_AFTER_FAILED_STARTS)
    assert.equal(state.quarantined, true)
    assert.equal(env.POE_LEAGUE, undefined, 'this start runs on the compose/default configuration')
    assert.equal(await exists(path), false, 'the file is out of the way')
    assert.equal(await exists(rejected), true, 'but not lost — it can be inspected and put back')
    assert.deepEqual(JSON.parse(await readFile(rejected, 'utf8')), { POE_LEAGUE: 'Some League' })
    assert.equal(await exists(marker), false, 'and the marker is cleared with it')
    assert.ok(log.warnings.some(w => w.includes('did not come up')), 'loudly')
    assert.ok(state.quarantineProblems.length, 'and the page is told, not just the log')

    // ...this one comes up.
    clearApplyingMarker(state, { log: quiet })

    // --- start 4: nothing left to quarantine, nothing to apply --------------
    env = {}
    state = applyConfigOverrides({ path, env, log: quiet })
    assert.equal(state.quarantined, false)
    assert.deepEqual(state.applied, {})
    assert.equal(await exists(rejected), true, 'the rejected file is left alone')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('boot quarantine: a start that DID listen resets the count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  try {
    const path = join(dir, 'overrides.json')
    await writeFile(path, JSON.stringify({ POE_LEAGUE: 'Some League' }))

    // Fail, then succeed, then fail again: the two failures are not consecutive,
    // so they must not add up. Without this the quarantine would eventually
    // trigger on any box that is restarted often enough.
    let state = applyConfigOverrides({ path, env: {}, log: quiet })
    assert.equal(state.failedStarts, 0)

    state = applyConfigOverrides({ path, env: {}, log: quiet })
    assert.equal(state.failedStarts, 1)
    clearApplyingMarker(state, { log: quiet })   // this one listened

    const env = {}
    state = applyConfigOverrides({ path, env, log: quiet })
    assert.equal(state.failedStarts, 0, 'the successful start wiped the count')
    assert.equal(state.quarantined, false)
    assert.equal(env.POE_LEAGUE, 'Some League')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('boot quarantine: a successful start clears the marker, so the NEXT one keeps the overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  try {
    const path = join(dir, 'overrides.json')
    await writeFile(path, JSON.stringify({ POE_APP_NAME: 'Kept' }))

    let env = {}
    let state = applyConfigOverrides({ path, env, log: quiet })
    assert.equal(clearApplyingMarker(state, { log: quiet }), true)
    assert.equal(await exists(markerPathFor(path)), false)

    env = {}
    state = applyConfigOverrides({ path, env, log: quiet })
    assert.equal(state.quarantined, false)
    assert.equal(env.POE_APP_NAME, 'Kept', 'a working configuration survives every restart')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a leftover marker without an overrides file does not quarantine anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  try {
    const path = join(dir, 'overrides.json')
    await writeFile(markerPathFor(path), 'stale\n')
    const state = applyConfigOverrides({ path, env: {}, log: quiet })
    assert.equal(state.quarantined, false)
    assert.equal(await exists(markerPathFor(path)), false, 'the stale marker is cleaned up')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// Setting and removing at runtime
// ---------------------------------------------------------------------------
test('setOverride: live keys take effect now, restart keys are honest about it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  const before = process.env.POE_APP_NAME
  try {
    const path = join(dir, 'overrides.json')
    const state = applyConfigOverrides({ path, env: {}, log: quiet })

    let r = await setOverride({ path, state, name: 'POE_APP_NAME', value: 'Renamed' })
    assert.deepEqual(r, { ok: true, name: 'POE_APP_NAME', value: 'Renamed', applied: 'live' })
    assert.equal(process.env.POE_APP_NAME, 'Renamed', 'a live key really is live')
    assert.deepEqual(await readOverrideFile(path), { POE_APP_NAME: 'Renamed' })

    r = await setOverride({ path, state, name: 'POE_LEAGUE', value: 'Next League' })
    assert.equal(r.applied, 'restart-required', 'read once at startup — say so instead of pretending')
    assert.deepEqual(await readOverrideFile(path), { POE_APP_NAME: 'Renamed', POE_LEAGUE: 'Next League' })

    const view = configView({ state, env: process.env, overrides: await readOverrideFile(path) })
    const byName = Object.fromEntries(view.settings.map(s => [s.name, s]))
    assert.equal(byName.POE_LEAGUE.restartPending, true)
    assert.equal(byName.POE_APP_NAME.restartPending, false)
    assert.equal(view.restartPending, true)

    // The way back has to exist, or the first bad value needs an SSH session.
    r = await setOverride({ path, state, name: 'POE_APP_NAME', value: null })
    assert.equal(r.value, null)
    assert.deepEqual(await readOverrideFile(path), { POE_LEAGUE: 'Next League' })
    assert.equal(process.env.POE_APP_NAME, before,
      'removing an override restores what the process was STARTED with, it does not just unset it')

    // And an invalid value is refused without touching the file.
    const untouched = await readOverrideFile(path)
    r = await setOverride({ path, state, name: 'POE_MAX_LISTINGS', value: 99 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 400)
    assert.deepEqual(await readOverrideFile(path), untouched)

    r = await setOverride({ path, state, name: 'POE_SESSID', value: 'secret' })
    assert.equal(r.ok, false)
    assert.equal(r.status, 400)
  } finally {
    if (before === undefined) delete process.env.POE_APP_NAME
    else process.env.POE_APP_NAME = before
    await rm(dir, { recursive: true, force: true })
  }
})

test('a hand-edited file is read with the same normalisation as a saved one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  try {
    const path = join(dir, 'overrides.json')
    // What somebody writes by hand: a real JSON boolean, and a number.
    await writeFile(path, JSON.stringify({ POE_CORPSE_DISABLED: true, POE_MAX_LISTINGS: 5, POE_LEAGUE: 'x'.repeat(200) }))
    const env = {}
    const state = applyConfigOverrides({ path, env, log: quiet })
    assert.equal(env.POE_CORPSE_DISABLED, '1', 'true becomes the 1 the server checks for')

    const view = configView({ state, env, overrides: await readOverrideFile(path) })
    const byName = Object.fromEntries(view.settings.map(s => [s.name, s]))
    assert.equal(byName.POE_CORPSE_DISABLED.restartPending, false,
      '`true` on disk and `1` in the environment are the same value, not a pending change')
    assert.equal(byName.POE_MAX_LISTINGS.overrideValue, '5')
    // The over-long league name never made it into the environment, so it is
    // reported as what it is rather than drawn as a value in force.
    assert.equal(byName.POE_LEAGUE.source, 'default')
    assert.ok(byName.POE_LEAGUE.invalid)
    assert.equal(byName.POE_LEAGUE.restartPending, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('redactView drops anything that could name a credential, and says it did', () => {
  const log = recorder()
  const out = redactView([
    { name: 'POE_LEAGUE', value: 'Standard' },
    { name: 'POE_SESSID', value: 'x' },
    { name: 'POE_NETWORTH_ACCOUNT', value: 'x' },
    { name: 'POE_ADMIN_PASSWORD_FILE', value: '/config/admin-password' },
    { name: 'POE_NETWORTH_CONFIG', value: '/config/networth-users.json' },
    { name: 'SOME_API_KEY', value: 'x' },
    { name: 'A_TOKEN', value: 'x' },
    { name: 'MY_SECRET', value: 'x' }
  ], { log })
  assert.deepEqual(out.map(e => e.name), ['POE_LEAGUE'])
  // Six of the seven dropped entries are programming errors and are named as
  // such; POE_NETWORTH_CONFIG is on HIDDEN_KEYS, i.e. dropped on purpose, and
  // stays quiet.
  assert.equal(log.warnings.length, 6)
  assert.ok(log.warnings.every(w => /BUG/.test(w)))
  assert.equal(log.warnings.some(w => w.includes('POE_NETWORTH_CONFIG')), false)
})

// ---------------------------------------------------------------------------
// The claim that has to be true and not merely written down: NOTHING SECRET
// LEAVES THROUGH THE VIEW. The read-only half was already filtered; this is the
// other half, the one built from the allow-list in this very file.
// ---------------------------------------------------------------------------
test('a secret key smuggled into the allow-list does not reach the view', () => {
  const log = recorder()
  // What a careless addition looks like: somebody adds a key to SETTABLE that
  // happens to name a credential. The list is frozen, so the test passes its
  // own copy through the same parameter the server never uses.
  const settable = [
    ...SETTABLE,
    { name: 'POE_SESSID', description: 'careless', type: 'string', maxLength: 60, defaultValue: '', apply: 'live' },
    { name: 'POE_NETWORTH_ACCOUNT', description: 'careless', type: 'string', maxLength: 60, defaultValue: '', apply: 'live' }
  ]
  const view = configView({
    state: null,
    env: { POE_SESSID: 'a-real-looking-session-value', POE_NETWORTH_ACCOUNT: 'a-real-looking-name' },
    overrides: {},
    settable,
    log
  })
  const names = view.settings.map(s => s.name)
  assert.equal(names.includes('POE_SESSID'), false, 'not as a row')
  assert.equal(names.includes('POE_NETWORTH_ACCOUNT'), false)
  // Not as a value anywhere else in the answer either.
  const body = JSON.stringify(view)
  assert.equal(body.includes('a-real-looking-session-value'), false)
  assert.equal(body.includes('a-real-looking-name'), false)
  assert.equal(names.length, SETTABLE.length, 'and the honest entries are untouched')
  // Silently dropping it would leave the mistake in the code forever.
  assert.equal(log.warnings.length, 2)
  assert.ok(log.warnings.some(w => w.includes('POE_SESSID') && /BUG/.test(w)))
})

// ---------------------------------------------------------------------------
// The other way content escapes: through an error message.
// ---------------------------------------------------------------------------
test('a broken overrides file is reported by position, never by excerpt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  try {
    const path = join(dir, 'overrides.json')
    // Hand-written, mistyped, and with something in it that must not come back
    // out. V8's own SyntaxError for this quotes a slice of the file.
    const SECRET = 'sessionvalue0123456789abcdef'
    await writeFile(path, `{ "POE_LEAGUE": "Standard", "POESESSID": ${SECRET} }`)
    const log = recorder()
    const state = applyConfigOverrides({ path, env: {}, log })

    assert.deepEqual(state.applied, {}, 'the file is unusable, so nothing from it is applied')
    assert.equal(state.problems.length, 1)
    const published = JSON.stringify(configView({ state, env: {}, overrides: {}, log: quiet }))
    assert.equal(published.includes(SECRET), false,
      'the value must not travel out through /config-view in an error message')
    assert.equal(log.warnings.some(w => w.includes(SECRET)), false, 'nor into the log')
    assert.ok(/invalid JSON/.test(state.problems[0]), 'but the operator is still told what is wrong')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('jsonErrorSummary keeps the position and drops the quote', () => {
  const summarise = raw => { try { JSON.parse(raw); return null } catch (e) { return jsonErrorSummary(e) } }
  assert.match(summarise('{ nope'), /position \d+/)
  assert.match(summarise(''), /ends in the middle/)
  // The excerpt form: V8 reports no position for this one and quotes instead.
  const out = summarise('{"POESESSID": abc123secret}')
  assert.equal(out.includes('abc123secret'), false)
  assert.match(out, /invalid JSON/)
  // Our own messages are ours to keep — they quote nothing.
  assert.equal(jsonErrorSummary(new Error('overrides file must contain a JSON object')),
    'overrides file must contain a JSON object')
})

// ---------------------------------------------------------------------------
// Two states the view used to get wrong.
// ---------------------------------------------------------------------------
test('an override that repeats the compose value is not a pending restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  try {
    const path = join(dir, 'overrides.json')
    // The process was started with a league, and the operator types the SAME
    // league into the settings page. Nothing about the running process changes,
    // so nothing is waiting for a restart.
    const env = { POE_LEAGUE: 'Some League' }
    const state = applyConfigOverrides({ path, env, log: quiet })

    const r = await setOverride({ path, state, name: 'POE_LEAGUE', value: 'Some League' })
    assert.equal(r.ok, true)
    let byName = Object.fromEntries(
      configView({ state, env, overrides: await readOverrideFile(path), log: quiet })
        .settings.map(s => [s.name, s]))
    assert.equal(byName.POE_LEAGUE.source, 'override', 'it IS an override — it just changes nothing')
    assert.equal(byName.POE_LEAGUE.restartPending, false)
    assert.equal(byName.POE_LEAGUE.shadowsEnv, false, 'and it shadows nothing either')

    // A different value is still reported, or the flag would be useless.
    await setOverride({ path, state, name: 'POE_LEAGUE', value: 'Another League' })
    byName = Object.fromEntries(
      configView({ state, env, overrides: await readOverrideFile(path), log: quiet })
        .settings.map(s => [s.name, s]))
    assert.equal(byName.POE_LEAGUE.restartPending, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('saving again clears the quarantine alarm — it describes a file that is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppt-cfg-'))
  const before = process.env.POE_APP_NAME
  try {
    const path = join(dir, 'overrides.json')
    await writeFile(path, JSON.stringify({ POE_LEAGUE: 'Some League' }))
    // Two failed starts in a row: the third quarantines.
    applyConfigOverrides({ path, env: {}, log: quiet })
    applyConfigOverrides({ path, env: {}, log: quiet })
    const state = applyConfigOverrides({ path, env: {}, log: quiet })
    assert.equal(state.quarantined, true)
    let view = configView({ state, env: {}, overrides: await readOverrideFile(path), log: quiet })
    assert.equal(view.quarantined, true)
    assert.ok(view.problems.length, 'the alarm says why')

    // The operator reads the alarm and saves a value. That write IS the answer
    // to it; leaving the alarm up until the next restart would keep shouting
    // about a set of overrides that no longer exists.
    const r = await setOverride({ path, state, name: 'POE_APP_NAME', value: 'Named again' })
    assert.equal(r.ok, true)
    view = configView({ state, env: process.env, overrides: await readOverrideFile(path), log: quiet })
    assert.equal(view.quarantined, false)
    assert.equal(view.rejectedPath, null)
    assert.deepEqual(view.problems, [])
  } finally {
    if (before === undefined) delete process.env.POE_APP_NAME
    else process.env.POE_APP_NAME = before
    await rm(dir, { recursive: true, force: true })
  }
})
