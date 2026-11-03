// backend/v2/networth/faustus-age.mjs
// HOW OLD IS A FAUSTUS PRICE, and how old may it be before the tool stops
// presenting it as a current one. The store's `updatedAt` says when the
// REFRESHER last ran, nothing about the number: faustus.mjs walks back up to
// POE_FAUSTUS_UNION_HOURS (default 8) completed hours and takes the newest
// hour in which a market was informative, so an item that last traded eight
// hours ago and one from the last completed hour arrive in the same refresh,
// indistinguishable. Measured on two live cards of the same league at the same
// minute (Allflame, 2026-08-13):
//
//   card                tool     in-game sell   in-game buy   hour range shown
//   Imperfect Memories    19c        21c            38c       none (single ratio)
//   The Chosen          206.6c       147c           180c      142..300c
//
// Same code path, 10 % low against 40 % high: no systematic market-SIDE error
// does that (a rate between bid and ask would land above 21 for the first
// card). What separates them is the observation — an hour that traded 142..300
// with a volume-weighted average of 206.6, against a single ratio — and nothing
// on screen said the two were from different times.
//
// THE AGE is measured from the END of the digest hour the price was observed
// in: `at` is the hour's unix START (faustus.mjs `detail.at`), the hour closes
// 3600s later. Age 0 = the hour has just closed.
//
// THE LAG NOBODY CAN TUNE AWAY: faustus.mjs asks for the last COMPLETED hour
// (`lastHour`), so at the fetch the observation is up to one hour old, and the
// refresher ticks every POE_FAUSTUS_REFRESH_MS (default 1h), so up to one
// further interval passes before the next fetch replaces it. The freshest a
// served price can be is `HOUR + refreshMs` old; a gate below that would reject
// every price, so `maxAgeMs` below is floored at it.
import { readEnvNumber } from '../env-number.mjs'

const HOUR_MS = 60 * 60 * 1000

// How old the OBSERVATION behind a Faustus price may be before the valuator
// stops using it and the fungible chain's existing poe.ninja fallback takes
// over. In hours, counted from the end of the digest hour.
//
// SIX IS A JUDGEMENT BOUNDED ON THE CONSERVATIVE SIDE, not a measurement, and
// it is written down as one:
//   - the union walk is 8 completed hours, so no observation is ever much older
//     than that; a gate INSIDE the window can only redirect an item to the
//     fallback the chain already has, and costs no request that is not already
//     being made (the poe.ninja exchange overviews are fetched per league|type
//     and cached >= 15min — see ninja.mjs — whether or not this gate fires).
//     Where that fallback has nothing either, the item is honestly unpriced,
//     which is what this tool already does for anything nobody has a price for.
//   - 6 leaves the freshest possible observation (under 2h with the default
//     hourly refresh, see above) plus four further hours of genuine market
//     quiet before a number is treated as history.
//   - lowering POE_FAUSTUS_UNION_HOURS instead would be the wrong dial: the
//     eight hours exist so that thin markets get a rate AT ALL, and shortening
//     the walk unprices them rather than ageing them.
// The direction this refuses is presenting an old GGG observation as a current
// price. The price-check card now prints the age whenever it exceeds the
// unavoidable lag, so this value can be calibrated from what is on screen
// instead of from a guess.
export const FAUSTUS_MAX_AGE_HOURS = 6

export const FAUSTUS_AGE_SPEC = {
  name: 'POE_FAUSTUS_MAX_AGE_HOURS',
  fallback: FAUSTUS_MAX_AGE_HOURS,
  // Zero is refused: it would reject every price including one observed in the
  // hour that just closed, because a served price is never newer than
  // `HOUR + refreshMs` (see above). The switch for "no Faustus prices at all"
  // is POE_FAUSTUS_DISABLED=1; the switch for "no age gate" is a value at or
  // above POE_FAUSTUS_UNION_HOURS, which no observation can exceed.
  zero: false,
  // Below the unavoidable lag at the DEFAULT refresh interval (1h digest
  // granularity + 1h refresh = 2h) the gate would reject everything, so the
  // smallest value that can still admit a price is 3. `maxAgeMs` floors the
  // result again against the interval actually configured.
  min: 3,
  hint: 'Set it to POE_FAUSTUS_UNION_HOURS or higher to switch the age gate off; POE_FAUSTUS_DISABLED=1 switches Faustus off entirely.'
}

/** POE_FAUSTUS_MAX_AGE_HOURS as read from an environment (hours). */
export function faustusMaxAgeHoursFromEnv (env = process.env, { log } = {}) {
  return readEnvNumber(FAUSTUS_AGE_SPEC, { env, ...(log ? { log } : {}) })
}

/**
 * How old a price observed in the digest hour starting at `atSec` is at `now`,
 * in ms, counted from the END of that hour. Never negative — an hour that has
 * not closed yet is as fresh as it gets, not "negative old".
 * `null` for anything that is not a usable hour stamp, which callers must read
 * as "unknown", never as "fresh".
 */
export function observationAgeMs (atSec, now = Date.now()) {
  if (typeof atSec !== 'number' || !isFinite(atSec) || atSec <= 0) return null
  if (typeof now !== 'number' || !isFinite(now)) return null
  return Math.max(0, now - (atSec + 3600) * 1000)
}

/**
 * The lag the pipeline cannot avoid: one hour of digest granularity plus one
 * refresh interval. A price is never fresher than this, so it is both the floor
 * under the age gate and the bar above which an age is worth printing.
 */
export function unavoidableLagMs (refreshMs = HOUR_MS) {
  const r = (typeof refreshMs === 'number' && isFinite(refreshMs) && refreshMs > 0) ? refreshMs : HOUR_MS
  return HOUR_MS + r
}

/**
 * The effective age gate in ms: the configured hours, never tighter than the
 * lag above. Floored rather than trusted, because a gate below the lag rejects
 * every price the tool can ever hold — including the one observed in the hour
 * that just closed.
 */
export function maxAgeMs (hours = FAUSTUS_MAX_AGE_HOURS, refreshMs = HOUR_MS) {
  const h = (typeof hours === 'number' && isFinite(hours) && hours > 0) ? hours : FAUSTUS_MAX_AGE_HOURS
  return Math.max(h * HOUR_MS, unavoidableLagMs(refreshMs))
}

/**
 * Is a price observed at `atSec` too old to be served as a current one?
 * An UNKNOWN age is never too old: stores written before `at` existed hold no
 * hour, and blanking every one of their prices on a deploy would be a far
 * bigger change than the one this gate is for. They age out with the next
 * refresh tick, which writes the hours.
 */
export function isTooOld (atSec, { now = Date.now(), maxMs } = {}) {
  const age = observationAgeMs(atSec, now)
  if (age == null) return false
  const limit = (typeof maxMs === 'number' && isFinite(maxMs) && maxMs > 0) ? maxMs : maxAgeMs()
  return age > limit
}

/**
 * Whole hours of age worth SHOWING, or null when the price is as fresh as the
 * pipeline allows. Deliberately null in the normal case: a label that is always
 * there is not read, and only the deviation from normal earns the space.
 */
export function staleHours (atSec, { now = Date.now(), refreshMs = HOUR_MS } = {}) {
  const age = observationAgeMs(atSec, now)
  if (age == null) return null
  const lag = unavoidableLagMs(refreshMs)
  if (age <= lag) return null
  return Math.floor(age / HOUR_MS)
}
