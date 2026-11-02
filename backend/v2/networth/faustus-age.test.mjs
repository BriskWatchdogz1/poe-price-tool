// How old a Faustus price is, and how old it may be.
//
// The bug this covers, in one line: the store carried ONE timestamp for the
// whole map (when the refresher ran), the union walk hands out prices observed
// up to POE_FAUSTUS_UNION_HOURS apart, and nothing anywhere could tell the two
// apart. Two live cards of the same league at the same minute (Allflame,
// 2026-08-13) came out 10 % LOW and 40 % HIGH against the in-game exchange
// through the identical code path — see the header of faustus-age.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resetEnvNumberWarnings } from '../env-number.mjs'
import {
  FAUSTUS_MAX_AGE_HOURS, FAUSTUS_AGE_SPEC, faustusMaxAgeHoursFromEnv,
  observationAgeMs, unavoidableLagMs, maxAgeMs, isTooOld, staleHours
} from './faustus-age.mjs'

const HOUR = 60 * 60 * 1000
const silent = { warn () {}, error () {}, log () {} }
const recorder = () => { const lines = []; return { lines, warn: (...a) => lines.push(a.join(' ')), error () {}, log () {} } }
// A digest hour that STARTED `h` hours before `now` (so it CLOSED h-1 hours
// before now). Unix seconds, hour-aligned, exactly what faustus.mjs stores.
const hourStartedAgo = (h, now) => Math.floor((now - h * HOUR) / 1000)

test('age is counted from the END of the digest hour, not its start', () => {
  const now = 1_760_000_000_000
  // Started 4h ago -> closed 3h ago -> three hours old.
  assert.equal(observationAgeMs(hourStartedAgo(4, now), now), 3 * HOUR)
  // Started 1h ago: the hour has only just closed, so it is as fresh as this
  // source ever gets — zero, never a negative number.
  assert.equal(observationAgeMs(hourStartedAgo(1, now), now), 0)
  // An hour that has not closed yet cannot be "negative old" either.
  assert.equal(observationAgeMs(hourStartedAgo(0.5, now), now), 0)
})

test('an unusable stamp is UNKNOWN age, and unknown is never fresh and never old', () => {
  for (const bad of [null, undefined, 0, -1, NaN, Infinity, '1760000000']) {
    assert.equal(observationAgeMs(bad, Date.now()), null, `${String(bad)} was read as an age`)
    // The consequence that matters: an unknown age must not silently blank a
    // price. Stores written before `hours` existed hold none, and a deploy that
    // dropped every one of their prices would be a far bigger change than the
    // gate is for.
    assert.equal(isTooOld(bad), false, `${String(bad)} was treated as too old`)
    assert.equal(staleHours(bad), null, `${String(bad)} produced an age label`)
  }
})

test('the lag nobody can tune away is one digest hour plus one refresh interval', () => {
  assert.equal(unavoidableLagMs(HOUR), 2 * HOUR, 'default hourly refresh')
  assert.equal(unavoidableLagMs(3 * HOUR), 4 * HOUR, 'a slower refresh makes it worse, not better')
  // Garbage falls back to the documented hourly interval rather than to zero,
  // which would make the gate below reject everything.
  for (const bad of [0, -1, NaN, undefined, 'an hour']) assert.equal(unavoidableLagMs(bad), 2 * HOUR)
})

test('the gate can never be tighter than that lag — arithmetic, not a preference', () => {
  // At the default hourly refresh the configured six hours simply stand.
  assert.equal(maxAgeMs(6, HOUR), 6 * HOUR)
  // With a refresh interval of eight hours the freshest possible price is nine
  // hours old, so a six-hour gate would refuse EVERY price there is. Floored.
  assert.equal(maxAgeMs(6, 8 * HOUR), 9 * HOUR)
  assert.equal(maxAgeMs(3, HOUR), 3 * HOUR, 'the smallest usable setting still stands')
})

test('too old means the price is not served, not that it is wrong', () => {
  const now = 1_760_000_000_000
  const limit = maxAgeMs(FAUSTUS_MAX_AGE_HOURS, HOUR) // 6h
  // Observed in the hour that closed one hour ago: comfortably inside.
  assert.equal(isTooOld(hourStartedAgo(2, now), { now, maxMs: limit }), false)
  // Closed six hours ago: exactly at the limit is still admitted — the gate is
  // "older than", so the boundary hour is not thrown away on a rounding edge.
  assert.equal(isTooOld(hourStartedAgo(7, now), { now, maxMs: limit }), false)
  // Closed seven hours ago: out.
  assert.equal(isTooOld(hourStartedAgo(8, now), { now, maxMs: limit }), true)
})

test('the age LABEL appears only past the unavoidable lag, so it stays worth reading', () => {
  const now = 1_760_000_000_000
  // Fresh (0h old) and one hour old: nothing to say, both are inside the lag
  // the pipeline imposes on every price it can possibly hold.
  assert.equal(staleHours(hourStartedAgo(1, now), { now, refreshMs: HOUR }), null)
  assert.equal(staleHours(hourStartedAgo(2, now), { now, refreshMs: HOUR }), null)
  assert.equal(staleHours(hourStartedAgo(3, now), { now, refreshMs: HOUR }), null, 'exactly at the lag is still normal')
  // Past it, the whole hours are named.
  assert.equal(staleHours(hourStartedAgo(4, now), { now, refreshMs: HOUR }), 3)
  assert.equal(staleHours(hourStartedAgo(8, now), { now, refreshMs: HOUR }), 7)
  // A slower refresh raises the bar with it: the same 3h-old price is normal
  // for an installation that only refreshes every three hours.
  assert.equal(staleHours(hourStartedAgo(4, now), { now, refreshMs: 3 * HOUR }), null)
})

test('POE_FAUSTUS_MAX_AGE_HOURS: default 6, zero refused, below the usable floor refused', () => {
  resetEnvNumberWarnings()
  assert.equal(faustusMaxAgeHoursFromEnv({}, { log: silent }), 6)
  assert.equal(FAUSTUS_MAX_AGE_HOURS, 6, 'the documented default is the one in the code')
  assert.equal(faustusMaxAgeHoursFromEnv({ POE_FAUSTUS_MAX_AGE_HOURS: '4' }, { log: silent }), 4)

  // Zero would reject every price including one from the hour that just closed
  // — and it has to SAY so, because silence is the defect env-number.mjs exists
  // for. Same for anything under the floor.
  for (const bad of ['0', '1', '2', '-1', 'six']) {
    resetEnvNumberWarnings()
    const log = recorder()
    assert.equal(faustusMaxAgeHoursFromEnv({ POE_FAUSTUS_MAX_AGE_HOURS: bad }, { log }), 6, `"${bad}" was honoured`)
    assert.equal(log.lines.length, 1, `"${bad}" fell back in silence`)
    assert.match(log.lines[0], /POE_FAUSTUS_MAX_AGE_HOURS/)
  }
})

test('docs/admin.md carries the row, and it says what a 0 means', () => {
  // The same promise numeric-settings.test.mjs makes for the table it owns.
  // This setting lives with its own module (like guardOptionsFromEnv and
  // slowStepMsFromEnv), so the operator documentation is asserted here.
  const md = readFileSync(fileURLToPath(new URL('../../../docs/admin.md', import.meta.url)), 'utf8')
  const row = md.split('\n').find(l => l.startsWith('| `POE_FAUSTUS_MAX_AGE_HOURS`'))
  assert.ok(row, 'POE_FAUSTUS_MAX_AGE_HOURS has no row in docs/admin.md')
  assert.match(row, /`0`/, 'the row does not say what a 0 means')
  assert.match(row, /`6`/, 'the row does not state the default')
})

test('the off switch is a value the walk can never exceed, and the hint says so', () => {
  resetEnvNumberWarnings()
  // "No age gate" is spelled as a number above the union window, because no
  // observation can be older than the hours that were walked. 24 is such a
  // value for every default; it must be accepted, not refused.
  assert.equal(faustusMaxAgeHoursFromEnv({ POE_FAUSTUS_MAX_AGE_HOURS: '24' }, { log: silent }), 24)
  assert.match(FAUSTUS_AGE_SPEC.hint, /POE_FAUSTUS_UNION_HOURS/)
  assert.match(FAUSTUS_AGE_SPEC.hint, /POE_FAUSTUS_DISABLED=1/)
  assert.equal(FAUSTUS_AGE_SPEC.zero, false)
  assert.equal(FAUSTUS_AGE_SPEC.min, 3)
})
