// backend/v2/networth/price-guard.mjs
// Implausible-price brake for the recorded history.
//
// Live case (02.08., 05:50-06:47 local): "The Scavenger", a 1-chaos divination
// card, was recorded at 174,039c — exactly 1000 divine at that hour's rate — on
// an unchanged stack of one, then fell back 40 minutes later. The trend line got
// a mountain worth twelve times the whole account, and the item panel blamed a
// card that never moved. Reconstruction afterwards was impossible: the container
// had been rebuilt, so that night's log was gone, and neither Faustus (the card
// is below its volume floor in every one of the 19 recoverable hourly digests)
// nor poe.ninja (1c) carries a number anywhere near it.
//
// So this module does two things, in this order of importance:
//   1. LOG the jump with everything needed to identify the source next time —
//      including WHICH price source produced the number (`opts.sourceOf`,
//      carried per item from the snapshot through history.mjs). That is the
//      one thing the Scavenger night could not answer.
//   2. Record the point at the item's PREVIOUS unit price instead of the new
//      one, and correct the point's total by the same amount. An item that has
//      no previous price is covered by the arrival bar further down.
//
// It deliberately guards the HISTORY only — the live snapshot keeps showing
// whatever the valuator produced. A brake that silently rewrote the displayed
// net worth would hide exactly the bug we are trying to catch.
'use strict'

// The shared "read a number out of the environment" rule, used by
// guardOptionsFromEnv further down. The defaults stay here, with the prose that
// argues them; only the parsing is shared.
import { readEnvNumber } from '../env-number.mjs'

// A jump must clear BOTH bars to count as implausible, so that ordinary market
// moves and cheap items are never touched:
//   factor — unit price grew at least this much. Real fungibles do not go 20x
//            between two recorded points; the observed case was 174,039x.
//   share  — and the resulting gain is at least this fraction of the previous
//            total. Without it a 20x on a 2-chaos oddity would trip the brake,
//            which is noise, not corruption.
export const GUARD_FACTOR = 20
export const GUARD_SHARE = 0.25
// A held price is a guess about the future: it assumes the spike is wrong. If a
// price really did jump and stays up, the brake must let go rather than freeze
// the series forever — after this long the new price is accepted (and logged).
export const GUARD_MAX_HOLD_MS = 6 * 60 * 60 * 1000

/* ---- the second bar: items ENTERING the snapshot ---------------------------
 * The bars above compare an item against its own previous unit price, so they
 * only ever protect items that were already there. On 2026-08-10 that gap was
 * hit head-on: "The Twilight Moon", a divination card that trades at about one
 * chaos, entered the stash as a quantity change of +1 and was recorded at
 * ~11,700c (55.2 divine at that hour's 212 c/div). It had no entry in the
 * previous map, so there was no previous price, and nothing for `factor` to
 * measure against. The brake never saw it.
 *
 * TWO things close that gap, in this order:
 *
 * 1. THE GUARD REMEMBERS PRICES IT HAS ACCEPTED (`known` below), for as long as
 *    a hold may last. An item that left the stash and comes back is therefore
 *    still judged against what this very tool last paid attention to for that
 *    name — the "same source's own history for that name" — instead of
 *    arriving unexamined. This is the cheap half and it costs no new threshold.
 *    It survives a restart (guard-state.mjs).
 *
 * 2. FOR A NAME THE GUARD HAS NEVER SEEN there is, by construction, nothing to
 *    compare against. No factor applies, and a unit-price ceiling per category
 *    cannot work either: the same divination-card overview legitimately carries
 *    The Doctor and The Apothecary at thousands of chaos apiece, so a ceiling
 *    that catches an 11,700c Twilight Moon blanks the expensive cards that are
 *    real — the "a flat bar punishes whatever is expensive" failure the volume
 *    floors in faustus.mjs and valuator.mjs are already full of.
 *
 *    So the arrival bar does not decide whether the price is right. It decides
 *    whether the series may lean on it YET, and the answer for a big unknown is
 *    "not until it has stood for a while": the item is recorded at NO value at
 *    all until it stands through `maxHoldMs` — present in every point recorded
 *    in that window, not merely six hours older than the suspicion — and is
 *    then accepted. That follows the rule the rest of this tool prices by — an
 *    unpriced item is honest, a wrongly priced one is not — and it is the same
 *    shape as the hold above, so a real arrival is late in the series rather
 *    than missing from it.
 *
 *    LATE IS ONLY HONEST IF IT IS ALSO VISIBLE. Withholding is one half; the
 *    other is how the acceptance is booked. Nothing was ever counted for this
 *    name, so the moment it is accepted the whole stock ENTERS the series — an
 *    inflow, at the point where it becomes countable, not a revaluation of
 *    stock the series already carried. Booked the other way (the value change
 *    on the price side, quantity delta zero) a 25-divine find appears in no
 *    event list at all and then jumps into the curve unexplained, which is the
 *    exact defect this brake exists to prevent. `apply` reports the release in
 *    `notes` and history.mjs does the booking; see `withoutReleased` there.
 *
 *    It fires only when BOTH hold:
 *      share  — the arrival is worth at least `share` of the previous total
 *               (the same yardstick as the jump bar), and
 *      floor  — it is worth at least GUARD_ARRIVAL_MIN_DIVINE divine.
 *
 *    The floor is what keeps the bar out of ordinary play. Without it every
 *    drop is a large share of a small total early in a league, and the brake
 *    would suppress the first hours of every fresh account. It is denominated
 *    in DIVINE, like EVENT_MIN_DIVINE in history.mjs, so it does not drift as
 *    the chaos scale of a league moves; the point's own C:D converts it.
 *
 *    The default is a judgement call bounded by the one measured case, not a
 *    measured optimum: the observed artefact entered at 55 divine on a ~94
 *    divine account, and the two other suspicious cards in that same window
 *    (The Demoness at 7.8 divine, Enmity's Embrace at 12.9 divine) are BELOW
 *    this floor and would not be caught. That is deliberate — neither of those
 *    two was ever shown to be wrong, and suppressing a 10-divine arrival for
 *    six hours on suspicion alone costs more than it buys.
 */
export const GUARD_ARRIVAL_MIN_DIVINE = 20

// At most this many remembered prices (`known`) go into the guard's memory file
// (guard-state.mjs); running holds and the rate are never cut. A judgement, not
// a measurement. The file only carries names the history-items sidecar does not
// already carry with a price (see exportState), normally a few dozen. The bound
// only bites when whole accounts' names are uncovered at once — a change in
// the set of stash tabs drops that user's sidecar entry (history.mjs,
// `tabsChanged`), and a sidecar that is left alone or whose write just failed
// covers no user at all. At roughly 50 bytes a row that is about 0.5 MB at the
// bound.
export const GUARD_STATE_MAX_NAMES = 10000

/**
 * guardOptionsFromEnv(env, { log })
 *   -> { factor, share, maxHoldMs, arrivalMinDivine, stateMaxNames }
 *
 * Reads the four bars, and the bound on the memory file, out of an environment. It lives here rather than in
 * server.mjs because the module constants above are the documented defaults and
 * a second reader would drift from them — but the READING itself is the shared
 * one (env-number.mjs), so these four obey the same rule as every other numeric
 * setting: unset and blank fall back in silence, an unusable value falls back
 * and says so, and whether zero is legal is stated rather than implied.
 *
 * WHY NOT `Number(env) || DEFAULT`: because that cannot express ZERO, and zero
 * is a meaningful setting for at least one of these — `arrivalMinDivine = 0`
 * removes the arrival bar's floor, which switches the bar off entirely (see the
 * `arrivalFloor` line in `apply`). With `||` an operator who sets it to 0 gets
 * 20 back and no error, so "every bar is settable" was true for every value
 * except the one that turns a bar off. All five take zero, which is why every
 * spec below says `zero: true` (for the memory bound, 0 writes no remembered
 * price; holds and the rate still go to the file).
 */
// Exported so a documentation test can ask the same question of these five that
// it asks of numeric-settings.mjs's table: does docs/admin.md say what a 0 means
// for each of them? They all take one, and all five answers are surprising in
// their own way (see the rows in that table).
export const GUARD_SPECS = [
  ['factor', { name: 'POE_NETWORTH_GUARD_FACTOR', fallback: GUARD_FACTOR, zero: true }],
  ['share', { name: 'POE_NETWORTH_GUARD_SHARE', fallback: GUARD_SHARE, zero: true }],
  ['maxHoldMs', { name: 'POE_NETWORTH_GUARD_HOLD_MS', fallback: GUARD_MAX_HOLD_MS, zero: true }],
  ['arrivalMinDivine', { name: 'POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE', fallback: GUARD_ARRIVAL_MIN_DIVINE, zero: true }],
  ['stateMaxNames', { name: 'POE_NETWORTH_GUARD_STATE_MAX_NAMES', fallback: GUARD_STATE_MAX_NAMES, zero: true, integer: true }]
]

export function guardOptionsFromEnv (env = process.env, { log } = {}) {
  const out = {}
  for (const [key, spec] of GUARD_SPECS) out[key] = readEnvNumber(spec, { env, ...(log ? { log } : {}) })
  return out
}

const unit = (v, q) => (q > 0 ? v / q : null)
const round1 = n => Math.round(n * 10) / 10

/**
 * createPriceGuard({ factor, share, maxHoldMs, arrivalMinDivine, stateMaxNames, now, log })
 *   -> { apply, held, known, exportState, importState }
 *
 * apply(user, prevMap, curMap, prevTotal, opts) -> { items, adjust, notes }
 *   prevMap/curMap: folded item maps (name -> [qty, chaos]) as used by
 *     history.mjs; curMap is never mutated.
 *   prevTotal: the previous point's chaos total — the yardstick for `share`.
 *   opts.cdRatio:  chaos per divine AT THIS POINT. Without it the arrival bar
 *     cannot convert its divine floor and abstains (see the block above).
 *   opts.sourceOf: Map(name -> price source, e.g. "faustus"), purely so the log
 *     line can name where the number came from. Missing -> "unknown".
 *   items:  the map to record (a corrected COPY, or curMap itself when clean)
 *   adjust: chaos to add to the point's total (<= 0)
 *   notes:  one entry per decision, for tests and callers. `withheld` marks the
 *     arrival case, where there is no old price to fall back to; `released`
 *     marks the point at which such an arrival is accepted. A release corrects
 *     NOTHING (adjust stays 0) and still has to be reported — history.mjs books
 *     the accepted stock as an inflow off the back of it, and that is the whole
 *     difference between a find that shows up in "what moved" and one that does
 *     not (see the comment at `withoutReleased` in history.mjs).
 */
/* ---- retro-cleanup of ALREADY RECORDED spikes ------------------------------
 * The brake above only protects points recorded from now on. The Scavenger
 * mountain was already on disk, and it wrecked the chart far worse there than
 * in the numbers: the value axis has to span the peak, so a stash moving
 * between 83 and 85 divine was drawn as a flat line at the bottom of a plot
 * scaled to 1156 divine.
 *
 * What separates an artefact from a real mountain is not its height — it is
 * whether anything MOVED. Real wealth arrives as stock: items come in, items go
 * out, and the stored delta says so. A price artefact rises and falls with the
 * stock untouched. So a range is only removed when all of this holds:
 *   - it rises to at least `factor` times the level right before it,
 *   - it comes back DOWN to near that level afterwards (a jump that stays is
 *     someone getting richer, not a glitch),
 *   - it is shorter than `maxSpanMs`, and
 *   - no stock movement explains the rise.
 */
export const SPIKE_FACTOR = 5
export const SPIKE_RETURN = 2          // "back down" = within 2x the old level
export const SPIKE_MAX_SPAN_MS = 6 * 60 * 60 * 1000

// How much of a point's value change is carried by stock moving in or out.
// Stored delta rows are [name, dq, dv, priceShare]; dv - priceShare is the part
// the quantity carries (same derivation the history page's events use).
export function stockMove (point) {
  const rows = point && point.d && Array.isArray(point.d.i) ? point.d.i : []
  let sum = 0
  for (const [, dq, dv, priceShare] of rows) {
    if (!dq) continue
    sum += Math.abs((Number(dv) || 0) - (Number(priceShare) || 0))
  }
  return sum
}

/**
 * findSpikeRanges(points, opts) -> [{ from, to, base, peak, spanMs }]
 * `points` must be ONE user's points, ascending by `at`. Indexes are inclusive.
 */
export function findSpikeRanges (points, {
  factor = SPIKE_FACTOR,
  returnRatio = SPIKE_RETURN,
  maxSpanMs = SPIKE_MAX_SPAN_MS
} = {}) {
  const pts = Array.isArray(points) ? points : []
  const out = []
  for (let i = 1; i < pts.length - 1; i++) {
    const base = Number(pts[i - 1].c)
    if (!(base > 0) || !(Number(pts[i].c) >= base * factor)) continue

    let j = i
    while (j + 1 < pts.length && Number(pts[j + 1].c) >= base * factor) j++
    const after = pts[j + 1]
    // No point after the range: it may simply still be going on — leave it.
    if (!after || !(Number(after.c) <= base * returnRatio)) { i = j; continue }
    if (pts[j].at - pts[i].at > maxSpanMs) { i = j; continue }

    // Did stock actually move? Compare against the rise it would have to carry.
    let moved = 0
    for (let k = i; k <= j; k++) moved += stockMove(pts[k])
    const rise = Number(pts[i].c) - base
    if (moved >= rise * 0.5) { i = j; continue } // real: the items were there

    let peak = 0
    for (let k = i; k <= j; k++) peak = Math.max(peak, Number(pts[k].c) || 0)
    out.push({ from: i, to: j, base, peak, spanMs: pts[j].at - pts[i].at })
    i = j
  }
  return out
}

export function createPriceGuard ({
  factor = GUARD_FACTOR,
  share = GUARD_SHARE,
  maxHoldMs = GUARD_MAX_HOLD_MS,
  arrivalMinDivine = GUARD_ARRIVAL_MIN_DIVINE,
  stateMaxNames = GUARD_STATE_MAX_NAMES,
  now = () => Date.now(),
  log = (...a) => console.warn(...a)
} = {}) {
  // `${user}|${name}` -> { user, name, since, seen, price } for items currently
  // held back. A `price` of 0 is the ARRIVAL case: there is no old price to fall
  // back to, so the item is recorded at no value at all while the hold lasts.
  // `seen` is the last point at which the item was observed WITH a price of its
  // own; the sweep below moves `since` by the gap between two such points when
  // one in between carried no price, so the window counts only what was
  // actually observed. `user`/`name` are carried in the record rather than
  // parsed back out of the key, because an item name may contain anything.
  // Kept across restarts through exportState/importState (networth/
  // guard-state.mjs); a restored hold treats the downtime as blind.
  const held = new Map()
  // `${user}|${name}` -> { user, name, at, price }: the newest unit price the
  // guard let through for this name. This is what makes an item that LEFT the
  // stash and came back judgeable at all — prevMap only knows the one point
  // before.
  //
  // Kept across restarts for as long as it would have lived in memory, but
  // only where the history sidecar does not already carry the name with a
  // price — see exportState for why that is the whole gap and not a shortcut,
  // and importState for how the covered names come back. Aged with the hold
  // window in both places: an opinion older than the longest hold is not
  // evidence any more.
  const known = new Map()
  const remember = (user, name, price, at) => known.set(`${user}|${name}`, { user, name, at, price })
  // The newest chaos-per-divine this guard has been handed. The arrival bar's
  // floor is denominated in divine and a single point can arrive without a rate
  // (poe.ninja unreachable at that minute); abstaining then means the bar is
  // missing exactly when the feeds are shaky. A rate from a few minutes ago is
  // a far better conversion than none. Only when NO rate has ever been seen —
  // the true cold start — does the bar still abstain.
  let lastRatio = 0
  let lastRatioAt = 0
  // The rate as exportState hands it to the memory file. apply() renews
  // lastRatioAt at every point with a rate, so exporting it as is would change
  // the file at every point. The exported time is renewed only when the rate
  // changes or the exported one is half a hold window old; a restored rate is
  // then at most that much older than it really was, and expires that much
  // sooner — it is a fallback for a point that arrives without a rate.
  let ratioMark = null
  // exportState says it once per process when the bound cuts, not once a save.
  let cutSaid = false

  function apply (user, prevMap, curMap, prevTotal, { cdRatio = 0, sourceOf = null } = {}) {
    const clean = { items: curMap, adjust: 0, notes: [] }
    if (!(prevMap instanceof Map) || !(curMap instanceof Map)) return clean
    const total = Number(prevTotal)
    if (!Number.isFinite(total) || total <= 0) return clean

    const t = now()
    for (const [k, v] of known) if (t - v.at > maxHoldMs) known.delete(k)
    // A RESTART IS A STRETCH NOTHING WAS RECORDED IN. A hold restored from the
    // guard's file (importState) last saw its item before the process stopped;
    // the time in between proves nothing either way, exactly like a point in
    // which the item carried no price (see the sweep below). So the deadline
    // moves out by that stretch, once, on this user's first point after the
    // restart — before the reaper, which measures from `since` too.
    for (const h of held.values()) {
      if (h.user !== user || !h.restored) continue
      h.since += t - h.seen
      h.seen = t
      delete h.restored
    }
    // Holds of users that stopped reporting altogether would otherwise
    // accumulate forever. Twice the window, so an item that IS still there is
    // always released (and logged) by its own branch below first. `since` moves
    // with the blind points the sweep below discounts, so this cannot reap a
    // hold whose item is still being observed — for a user who keeps reporting
    // it is the item that ends the hold, never the clock. A restored hold whose
    // user has not reported since the restart is measured from `seen`, the rule
    // importState applies: its downtime has not been moved out yet, and another
    // user's point must not reap it for that.
    for (const [k, v] of held) if (t - (v.restored ? v.seen : v.since) > 2 * maxHoldMs) held.delete(k)

    // A HOLD IS A CLAIM ABOUT STANDING, NOT ABOUT THE WALL CLOCK. `since` alone
    // says how long ago the suspicion started, and that is not the promise the
    // brake makes: "it stood for six hours, so it is real". An item that left
    // the snapshot in between did not stand — and because `held` was only swept
    // at twice the window, one that disappeared and came back after seven hours
    // was accepted on the second sight of it. So a hold ends with its item: a
    // snapshot without the name drops the hold, and a returning name is judged
    // from the beginning. "Present in every recorded point of the window" is the
    // whole of the promise; recording is what the guard can observe, so it is
    // also the unit it can honestly count in.
    //
    // AND A POINT THAT SAYS NOTHING ENDS NOTHING. An item that is in the
    // snapshot but carries NO PRICE OF ITS OWN is a third observation, not the
    // second one: `cur` tells "gone" and "here, unpriced" apart, and the two
    // must not collapse into "the hold is over". Absence is evidence — the item
    // did not stand. A missing price is the absence of evidence: the valuator
    // had nothing for that name this minute, and the guard learns neither that
    // the suspicious price is real nor that it is not. Ending the hold on it
    // would restart the window at every flicker of a price feed, so an arrival
    // over the divine floor could stand in the series at zero for as long as
    // the flicker lasts and write a fresh withholding line at every restart.
    // So such a point simply DOES NOT COUNT: the deadline moves out by exactly
    // the blind interval — `since` is what `maxHoldMs` is measured from, and
    // `seen` is the last point that carried a price — which neither restarts
    // the window nor lets the wall clock run through a stretch that proves
    // nothing. It needs no third kind of hold: the record already distinguishes
    // a jump (`price > 0`) from a withheld arrival (`price === 0`), and this is
    // a shift of the same deadline, not a new state. The hours both release
    // lines print are that same measure — observed window, not wall clock.
    for (const [k, h] of held) {
      if (h.user !== user) continue
      const cur = curMap.get(h.name)
      const p = cur ? unit(cur[1], cur[0]) : null
      if (p != null && p > 0) { h.seen = t; continue }
      if (cur && cur[0] > 0) { h.since += t - h.seen; h.seen = t; continue }
      // A JUMP hold carries the price the series is being recorded at, and that
      // opinion does not become wrong because the item left the stash. Hand it
      // to `known` on the way out, so a name that vanishes for a minute and
      // returns at the same spike is still measured against it instead of
      // falling through to the arrival bar. A withheld ARRIVAL (price 0) has no
      // opinion to hand over and hands over nothing.
      if (h.price > 0) remember(h.user, h.name, h.price, t)
      held.delete(k)
    }

    // Absolute floor of the arrival bar, converted into chaos. THIS point's
    // rate first, otherwise the newest one this guard has seen; only a guard
    // that has never seen a rate has no floor, and then the arrival bar
    // abstains entirely rather than fall back to a share-only test that would
    // suppress ordinary play on a small account.
    const ratio = Number(cdRatio)
    if (Number.isFinite(ratio) && ratio > 0) { lastRatio = ratio; lastRatioAt = t }
    const arrivalFloor = (lastRatio > 0 && arrivalMinDivine > 0)
      ? lastRatio * arrivalMinDivine
      : null
    const srcOf = name => (sourceOf instanceof Map ? sourceOf.get(name) : null) || 'unknown'

    let out = null
    let adjust = 0
    const notes = []
    const corrected = (name, qty, value) => {
      if (!out) out = new Map(curMap)
      out.set(name, [qty, value])
    }

    for (const [name, cur] of curMap) {
      const [q1, v1] = cur
      const p1 = unit(v1, q1)
      if (p1 == null || !(p1 > 0)) continue

      const key = `${user}|${name}`
      const hold = held.get(key)
      const prev = prevMap.get(name)
      const p0 = prev ? unit(prev[1], prev[0]) : null
      const memo = known.get(key)
      // The price this item is judged against, best evidence first:
      //   1. the price we are already HOLDING — otherwise a held spike becomes
      //      its own baseline on the very next point and the brake releases
      //      after one interval,
      //   2. the previous point's unit price,
      //   3. the last unit price the guard accepted for this name.
      // A hold at price 0 is a withheld arrival and carries no reference.
      let ref = null
      if (hold) ref = hold.price > 0 ? hold.price : null
      else if (p0 != null && p0 > 0) ref = p0
      else if (memo && memo.price > 0) ref = memo.price

      // ---- a price to compare against: the original jump bar ----------------
      if (ref != null) {
        const gain = v1 - q1 * ref

        if (!(p1 >= ref * factor) || !(gain >= total * share)) {
          if (hold) held.delete(key) // back to normal -> stop holding
          remember(user, name, p1, t)
          continue
        }

        if (hold && t - hold.since >= maxHoldMs) {
          held.delete(key)
          remember(user, name, p1, t)
          log('[networth] price hold released after %dh: "%s" stays at %sc/ea (was %sc/ea, source %s) — recording it as real',
            Math.round((t - hold.since) / 3600000), name, round1(p1), round1(ref), srcOf(name))
          continue
        }
        if (!hold) held.set(key, { user, name, since: t, seen: t, price: ref })

        const value = q1 * ref
        corrected(name, q1, value)
        adjust += value - v1
        notes.push({ name, qty: q1, oldPrice: ref, newPrice: p1, dropped: round1(v1 - value), source: srcOf(name) })
        log('[networth] implausible price jump ignored for the trend: "%s" %sc/ea -> %sc/ea (x%s, %s in stock, +%sc = %d%% of the previous total %sc, source %s); recorded at the old price',
          name, round1(ref), round1(p1), round1(p1 / ref), q1, round1(v1 - value),
          Math.round((gain / total) * 100), round1(total), srcOf(name))
        continue
      }

      // ---- no price to compare against: the arrival bar ---------------------
      if (arrivalFloor == null) continue
      const suspect = v1 >= total * share && v1 >= arrivalFloor

      if (!suspect) {
        if (hold) held.delete(key)
        remember(user, name, p1, t)
        continue
      }
      if (hold && t - hold.since >= maxHoldMs) {
        held.delete(key)
        remember(user, name, p1, t)
        // The note is what makes this visible. Nothing is corrected here, so
        // without it the caller sees an unchanged map and books the accepted
        // value as a revaluation of stock it never counted — a price move with
        // a quantity delta of zero, which the events list drops and the spike
        // detector reads as "no stock explains this rise".
        notes.push({ name, qty: q1, oldPrice: null, newPrice: p1, dropped: 0, released: true, source: srcOf(name) })
        log('[networth] withheld arrival accepted after %dh: "%s" is still here at %sc/ea (%s in stock, source %s) — recording it as real, as stock arriving now',
          Math.round((t - hold.since) / 3600000), name, round1(p1), q1, srcOf(name))
        continue
      }
      if (!hold) {
        held.set(key, { user, name, since: t, seen: t, price: 0 })
        // Logged when the hold STARTS and when it is released, not once per
        // point: the line below already carries everything needed to chase the
        // number down, and repeating it every minute for six hours adds nothing.
        log('[networth] new item withheld from the trend until it holds: "%s" arrived at %sc/ea (%s in stock, %sc = %d%% of the previous total %sc, source %s); recorded at no value for up to %dh',
          name, round1(p1), q1, round1(v1), Math.round((v1 / total) * 100), round1(total),
          srcOf(name), Math.round(maxHoldMs / 3600000))
      }
      corrected(name, q1, 0)
      adjust -= v1
      notes.push({ name, qty: q1, oldPrice: null, newPrice: p1, dropped: round1(v1), withheld: true, source: srcOf(name) })
    }

    // NOT `out ? … : clean`: a release corrects nothing and still has to be
    // reported. Dropping the notes with the correction is how the acceptance of
    // a withheld arrival became invisible to the caller in the first place.
    return { items: out || curMap, adjust: round1(adjust), notes }
  }

  /**
   * exportState({ covered }) -> { ratio: [value, at] | null,
   *   users: { [user]: { held: [[name, since, seen, price]], known: [[name, at, price]] } },
   *   cut: <remembered prices left out by stateMaxNames> }
   *
   * covered: Map(user -> Map(name -> [qty, chaos])) — the breakdown history.mjs
   *   keeps as the previous point (lastItems, mirrored by the sidecar), or
   *   null when the sidecar was not written at that moment, because it is left
   *   alone or its write failed (then every name is written). A
   *   remembered price for a name that is in it with a unit price > 0 is left
   *   out: after a restart apply() judges that name against the sidecar's
   *   previous price (`p0`) first, and importState({ covered }) puts the same
   *   price back into `known` for the case where the name is gone on the first
   *   point afterwards. Names at 0 there (withheld arrivals, present-but-
   *   unpriced) are NOT covered and are written.
   *   THIS IS A COUPLING, stated once here: it holds because history.mjs runs
   *   the guard only against the sidecar's breakdown and apply() takes `p0`
   *   before `known`. Change either and the file lacks the covered names
   *   (history-restart.test.mjs, "a name that left the stash …", catches it).
   * Holds are always written in full; the bound only cuts remembered prices,
   * newest kept. Rows are sorted by user, then name, so an unchanged memory
   * serialises to the same bytes and the file is not rewritten. The rate's
   * time moves in steps of half a hold window (see ratioMark), or it alone
   * would change the export at every point.
   */
  function exportState ({ covered = null } = {}) {
    const t = now()
    const isCovered = (user, name) => {
      const row = covered instanceof Map ? covered.get(user)?.get(name) : null
      const p = row ? unit(row[1], row[0]) : null
      return p != null && p > 0
    }
    const users = new Map()
    const slot = user => {
      let u = users.get(user)
      if (!u) users.set(user, (u = { held: [], known: [] }))
      return u
    }
    for (const h of held.values()) slot(h.user).held.push([h.name, h.since, h.seen, h.price])
    let mem = []
    for (const v of known.values()) {
      if (t - v.at > maxHoldMs || isCovered(v.user, v.name)) continue
      mem.push(v)
    }
    const cap = Math.max(0, Math.floor(Number(stateMaxNames) || 0))
    let cut = 0
    if (mem.length > cap) {
      const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
      mem.sort((a, b) => (b.at - a.at) || cmp(a.user, b.user) || cmp(a.name, b.name))
      cut = mem.length - cap
      // 0 is the operator saying "none", not a bound being hit: no line then.
      if (!cutSaid && cap > 0) {
        cutSaid = true
        log('[networth-guard] kept the newest %d of %d remembered prices (POE_NETWORTH_GUARD_STATE_MAX_NAMES); the rest is forgotten at the next restart', cap, mem.length)
      }
      mem = mem.slice(0, cap)
    }
    for (const v of mem) slot(v.user).known.push([v.name, v.at, v.price])
    const byName = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    const out = {}
    for (const user of [...users.keys()].sort()) {
      const u = users.get(user)
      out[user] = { held: u.held.sort(byName), known: u.known.sort(byName) }
    }
    if (lastRatio > 0 && (!ratioMark || ratioMark[0] !== lastRatio || lastRatioAt - ratioMark[1] >= maxHoldMs / 2)) {
      ratioMark = [lastRatio, lastRatioAt]
    }
    return { ratio: lastRatio > 0 ? [...ratioMark] : null, users: out, cut }
  }

  /**
   * importState(doc, { covered }) -> { held, known, expired, skipped, fromSidecar }
   *
   * Meant for a fresh guard before its first apply(); entries already in memory
   * win. Applies the expiry apply() would apply now(): a remembered price older
   * than maxHoldMs, a hold whose item was last SEEN more than 2 * maxHoldMs ago
   * (seen, not since: the downtime is blind), a rate older than maxHoldMs. A row
   * with a non-string/empty name, a non-finite number, a timestamp in the
   * future, since > seen, a remembered price <= 0 or a held price < 0 is skipped.
   * Every restored hold is marked `restored` (see the block at the top of apply).
   *
   * covered: Map(user -> { at, items: Map(name -> [qty, chaos]) }) — the
   *   breakdown the history adopted from its sidecar, with the point it is
   *   anchored on. exportState left those names out; an uninterrupted guard
   *   would remember each of them at that point's unit price, so they are put
   *   back here at exactly that (`fromSidecar`). Without this, a name that is
   *   in the sidecar but gone on the first point after the restart would lose
   *   its reference. Same expiry, same "memory wins", and not for a name that
   *   is being held (the hold carries its own price).
   */
  function importState (doc, { covered = null } = {}) {
    const t = now()
    const r = { held: 0, known: 0, expired: 0, skipped: 0, fromSidecar: 0 }
    const okName = n => typeof n === 'string' && n !== ''
    const okNum = x => typeof x === 'number' && Number.isFinite(x)
    const okTime = x => okNum(x) && x <= t
    const users = doc && typeof doc === 'object' && doc.users && typeof doc.users === 'object' && !Array.isArray(doc.users)
      ? doc.users
      : {}
    for (const [user, rec] of Object.entries(users)) {
      const heldRows = Array.isArray(rec?.held) ? rec.held : []
      const knownRows = Array.isArray(rec?.known) ? rec.known : []
      if (!okName(user)) { r.skipped += heldRows.length + knownRows.length; continue }
      for (const row of heldRows) {
        const [name, since, seen, price] = Array.isArray(row) ? row : []
        if (!okName(name) || !okTime(since) || !okTime(seen) || since > seen || !okNum(price) || price < 0) { r.skipped++; continue }
        if (t - seen > 2 * maxHoldMs) { r.expired++; continue }
        const key = `${user}|${name}`
        if (held.has(key)) continue
        held.set(key, { user, name, since, seen, price, restored: true })
        r.held++
      }
      for (const row of knownRows) {
        const [name, at, price] = Array.isArray(row) ? row : []
        if (!okName(name) || !okTime(at) || !okNum(price) || price <= 0) { r.skipped++; continue }
        if (t - at > maxHoldMs) { r.expired++; continue }
        if (known.has(`${user}|${name}`)) continue
        remember(user, name, price, at)
        r.known++
      }
    }
    const ratio = Array.isArray(doc?.ratio) ? doc.ratio : null
    if (ratio && lastRatio === 0) {
      const [value, at] = ratio
      if (!okNum(value) || !(value > 0) || !okTime(at)) r.skipped++
      else if (t - at > maxHoldMs) r.expired++
      else { lastRatio = value; lastRatioAt = at; ratioMark = [value, at] }
    }
    if (covered instanceof Map) {
      for (const [user, rec] of covered) {
        const at = rec?.at
        if (!okName(user) || !(rec?.items instanceof Map) || !okTime(at) || t - at > maxHoldMs) continue
        for (const [name, v] of rec.items) {
          const p = Array.isArray(v) ? unit(v[1], v[0]) : null
          if (!(p > 0) || !okName(name)) continue
          const key = `${user}|${name}`
          if (known.has(key) || held.has(key)) continue
          remember(user, name, p, at)
          r.fromSidecar++
        }
      }
    }
    return r
  }

  return { apply, held, known, exportState, importState }
}
