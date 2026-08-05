// Sell-side comparison for the reference rail: given an item's SEPARATED
// Faustus rates (chaos market vs divine market, see faustus.mjs detail.sell /
// faustus-store.mjs getSell), which currency pays the seller more right now —
// and is that comparison even trustworthy?
//
//   revenue via chaos  = chaosPerItem
//   revenue via divine = divinePerItem * chaosPerDivine
//
// `chaosPerDivine` MUST be the tool's single shared C:D source (the
// currency-exchange divine rate, see chaosPerDivineFallback in
// networth/faustus.mjs) — never a second, private ratio.
//
// These rates come from MATCHED trade volumes (what the hour actually filled),
// not from asks or bids. The absolute numbers are therefore estimates — but
// the chaos-vs-divine COMPARISON is sound, because both sides are estimated by
// the exact same procedure and carry the same bias. Do not read more into the
// per-side numbers than that.
//
// ---------------------------------------------------------------------------
// The outlier case (mandatory, not optional): a side can pass the pricer's
// quote-volume floor and still be far too thin to compare against — one lone
// 10-divine trade "prices" the divine side and the rail would then claim a
// +118 % edge that no real seller can collect. Same disease chooseBulkSlice in
// engine.mts treats with BULK_EXTREME_SPLIT: when the numbers scream, follow
// the evidence, not the price. Here the evidence is the digest's own
// volume_traded, and the consequence is stricter: a side that is not attested
// does not get compared at all (we show the attested side and drop the claim),
// because a displayed percentage IS the product here — a wrong one is worse
// than none.
//
// Attestation thresholds, measured on the live Allflame digest (2026-07-31,
// 8h union, 187 items with BOTH a chaos and a divine market, C:D 174.4).
// Sides whose estimate was demonstrably wrong (vs poe.ninja / the other,
// liquid side) versus the thinnest sides whose estimate held up:
//
//   item                        thin side   volX   quote-turnover(→c)  claimed gap
//   The Apothecary              chaos          1       1900c              +277 %  bogus
//   The Demon                   chaos          1       1423c               +61 %  bogus
//   Divine Justice              chaos          2        920c              +162 %  bogus
//   Rogue's Marker              divine    715000       1918c              +384 %  bogus
//   Tainted Exalted Orb         divine        21       1744c              +102 %  bogus
//   Tattoo o.t. Ramako Shaman   divine        12       1744c               +53 %  bogus
//   --- below: thin but consistent with the liquid side -------------------
//   Corroded Fossil             divine       207       2441c              0.4 %
//   Bestiary Scarab o.t. Herd   divine       396       1744c              2.4 %
//   Outfoxed                    divine         3       1744c              5.6 %
//
// Two independent failure modes, two floors (a side must clear BOTH):
//   - volX >= 10: single/double trades of the item itself say nothing
//     (Apothecary/Demon/Divine Justice — 1-2 cards traded). 10 mirrors the
//     divine quote floor QUOTE_VOL_MIN and cleared every bogus card side.
//   - quote turnover >= 5000 chaos-equivalent: every bogus side above sat at
//     <= 2441c (mostly exactly the 10-divine floor ~1744c — i.e. potentially
//     ONE trade), while from 5000c upward no gap beyond 78 % was observed and
//     from 30000c none beyond 20 %. 5000 sits in the empty band above the
//     bogus outlier, ~2x its top.
//   The thin-but-honest rows land below the floors too — they are suppressed
//   as well, which only costs an "~even" claim nobody needed. Better silent
//   than confidently wrong.
// ---------------------------------------------------------------------------

export const SELL_MIN_UNITS = 10 // items traded on that side (volX floor)
export const SELL_MIN_QUOTE_TURNOVER_C = 5000 // quote turnover in chaos-equivalents

// Divine bias with hysteresis (both-sides-attested path only): the owner
// prefers to hold divine, and a symmetric "whoever pays more wins" rule makes
// the DISPLAYED UNIT (perPieceDisplay in server.mjs follows `better`) flip
// back and forth whenever the two markets sit within noise of each other.
// Chaos has to clear a bar to take the recommendation away from divine, and a
// lower bar to keep it once it already holds it — see compareSellSides below.
export const CHAOS_TAKEOVER_PCT = 5 // chaos must beat divine by this much to take over
export const CHAOS_HOLD_PCT = 2 // once chaos is recommended, it holds until its edge drops below this

// Is one side ({ perItem, volX, volQuote }) attested enough to take part in a
// comparison? `chaosPerQuote` converts the quote turnover to chaos (1 for the
// chaos side, C:D for the divine side).
export function isAttested (side, chaosPerQuote) {
  if (!side || typeof side.perItem !== 'number' || !isFinite(side.perItem) || side.perItem <= 0) return false
  if (typeof chaosPerQuote !== 'number' || !isFinite(chaosPerQuote) || chaosPerQuote <= 0) return false
  if ((side.volX ?? 0) < SELL_MIN_UNITS) return false
  if ((side.volQuote ?? 0) * chaosPerQuote < SELL_MIN_QUOTE_TURNOVER_C) return false
  return true
}

// Attestation for a DIFFERENT question: not "does this side pay a seller more"
// (isAttested, above, whose answer becomes a claim in the UI) but "is this side
// evidenced well enough to SET THE PRICE" — the faustus bridge's decision. Same
// turnover bar, NO unit floor. Two call sites, two questions; conflating them
// is how the bug below got in.
//
// Why dropping the unit floor is safe HERE, checked row by row against the
// measurement table at the top of this file — every bogus side in it fails on
// turnover, and two of them clear the unit floor comfortably:
//
//   The Apothecary       1 unit    1900c   both floors reject
//   The Demon            1 unit    1423c   both floors reject
//   Divine Justice       2 units    920c   both floors reject
//   Rogue's Marker  715000 units   1918c   UNIT FLOOR PASSES, turnover rejects
//   Tainted Exalted     21 units   1744c   UNIT FLOOR PASSES, turnover rejects
//   Tattoo o.t. Ramako  12 units   1744c   UNIT FLOOR PASSES, turnover rejects
//
// So the unit floor catches nothing in that measurement the turnover floor does
// not already catch. What it does catch is the opposite mistake: Father's Love,
// a card trading at ~44 divine, moved 7 cards for 305 divine (59 117 chaos of
// turnover, 11.8x the bar) and was rejected for being 3 units short — so a
// single 153-chaos sale set the price of a 8500-chaos card, a 98% underpricing
// that no fallback could correct, because a confident wrong price blocks the
// fallback that an unpriced item would have got.
//
// A flat item count punishes expensive items. That is the same lesson as
// MIN_EXCHANGE_UNITS in networth/valuator.mjs and the QUOTE_VOL_MIN comment in
// networth/faustus.mjs, arrived at a third time from a third direction.
//
// Turnover here is the QUOTE side's own traded volume (divine actually changed
// hands), not the item price under test, so it does not validate itself the way
// a turnover bar denominated in the estimated price would.
export function isTurnoverAttested (side, chaosPerQuote) {
  if (!side || typeof side.perItem !== 'number' || !isFinite(side.perItem) || side.perItem <= 0) return false
  if (typeof chaosPerQuote !== 'number' || !isFinite(chaosPerQuote) || chaosPerQuote <= 0) return false
  return (side.volQuote ?? 0) * chaosPerQuote >= SELL_MIN_QUOTE_TURNOVER_C
}

/**
 * compareSellSides(sell, chaosPerDivine, prevBetter = null) -> {
 *   viaChaos:  chaos revenue per item via the chaos market | null,
 *   viaDivine: chaos revenue per item via the divine market (bridged) | null,
 *   better:    'chaos' | 'divine' | null,  // null = no comparison claimed
 *   edgePct:   the honest edge, or null — see below,
 *   only:      'chaos' | 'divine' | null   // the single attested side, when
 *                                          // exactly one is — show it, claim nothing
 * } | null when nothing usable is left.
 *
 * `sell` is faustus-store's getSell() shape ({ chaos, divine }, either null).
 * Without a usable chaosPerDivine the divine side cannot be bridged NOR
 * attested — it is treated as absent (never compared at a bogus ratio).
 *
 * `prevBetter` is the caller's remembered verdict for THIS row from the
 * previous comparison ('chaos' | 'divine' | null) — see CHAOS_HOLD_PCT above.
 * It only affects the both-sides-attested path; the `only` path is unaffected
 * by, and never updates, the remembered side (see railSellFor in server.mjs).
 *
 * `edgePct` is deliberately not just "how far apart the two sides are": when
 * `better === 'divine'` because chaos failed to take over (not because divine
 * actually pays more), printing a percentage would claim an advantage divine
 * does not have. That case reports `edgePct: null` — callers get the
 * recommended side and nothing else.
 */
export function compareSellSides (sell, chaosPerDivine, prevBetter = null) {
  if (!sell || typeof sell !== 'object') return null
  const cd = (typeof chaosPerDivine === 'number' && isFinite(chaosPerDivine) && chaosPerDivine > 0)
    ? chaosPerDivine : null

  const c = sell.chaos && typeof sell.chaos.perItem === 'number' &&
    isFinite(sell.chaos.perItem) && sell.chaos.perItem > 0 ? sell.chaos : null
  const d = cd != null && sell.divine && typeof sell.divine.perItem === 'number' &&
    isFinite(sell.divine.perItem) && sell.divine.perItem > 0 ? sell.divine : null

  const viaChaos = c ? c.perItem : null
  const viaDivine = d ? d.perItem * cd : null
  if (viaChaos == null && viaDivine == null) return null

  const cOk = c ? isAttested(c, 1) : false
  const dOk = d ? isAttested(d, cd) : false

  const out = { viaChaos, viaDivine, better: null, edgePct: null, only: null }
  if (cOk && dOk) {
    // Both sides carry real volume -> the comparison may be claimed. Biased
    // toward divine, with hysteresis: chaos needs a bigger edge to take the
    // recommendation away from divine (CHAOS_TAKEOVER_PCT) than to keep it
    // once it already has it (CHAOS_HOLD_PCT) — see the constants above.
    const chaosEdge = (viaChaos / viaDivine - 1) * 100
    const threshold = prevBetter === 'chaos' ? CHAOS_HOLD_PCT : CHAOS_TAKEOVER_PCT
    if (chaosEdge >= threshold) {
      out.better = 'chaos'
      out.edgePct = chaosEdge
    } else {
      out.better = 'divine'
      // Divine only gets a printed edge when it genuinely pays more. Inside
      // the deadband (chaos pays the same or more, just not enough to take
      // over) there is no honest number to show — see the note above.
      out.edgePct = viaDivine > viaChaos ? (viaDivine / viaChaos - 1) * 100 : null
    }
  } else if (cOk || dOk) {
    // Exactly one attested side: show it, drop the comparison (a market that
    // is missing entirely lands here too — same treatment by design).
    out.only = cOk ? 'chaos' : 'divine'
  }
  return out
}
