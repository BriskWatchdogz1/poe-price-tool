// The state of each price source, as facts: when it last answered, when it last
// failed, why, and which kind of failure that was.
//
// WHY. The tool has four upstreams it prices with — Faustus (GGG's Currency
// Exchange digests), poe.ninja's Chaos:Divine answer, poe.ninja's other price
// overviews, and the Trade API — and until this module none of them could tell
// a page how old its numbers were. A poe.ninja outage left the C:D tile on
// "live · poe.ninja" for as long as the outage lasted, and the only trace of a
// broken Faustus feed was one log line an hour (docs/bugs.md B29).
//
// THE SAME DIVISION OF LABOUR AS data-status. The failure site sets the reason
// and its class (check-failure.mjs: never derived from the wording afterwards);
// this module keeps them; the CLIENT decides what is stale, against the server
// clock, so a page left open keeps ageing without a message. Nothing here logs
// (that stays at the failure sites, fail-log.mjs) and nothing here judges.
//
// Pure: no environment, no network, no timer.
import { cleanReason, isFailKind, FAIL_KIND, REASON_MAX_CHARS_DEFAULT } from './check-failure.mjs'

/** Every source the status message carries, in the order it carries them. */
export const SOURCE_IDS = Object.freeze(['faustus', 'ninja-cd', 'ninja-overview', 'trade'])
/** The ones a price is read from. Trade is a search, not a price feed. */
export const PRICE_SOURCES = Object.freeze(['faustus', 'ninja-cd', 'ninja-overview'])

const isFailing = r => r.lastFailureAt != null && (r.lastSuccessAt == null || r.lastFailureAt > r.lastSuccessAt)

/**
 * createSourceHealth({ now, reasonMaxChars, onChange }) ->
 *   { seed, ok, fail, get, snapshot }
 *
 * onChange(source, { started }) after every fail(), started = true when the
 * source was not failing before; onChange(source, { recovered }) after every
 * ok(), recovered = true when it was. The server sends a state change at once
 * and bundles the rest.
 */
export function createSourceHealth ({ now = Date.now, reasonMaxChars = REASON_MAX_CHARS_DEFAULT, onChange = () => {} } = {}) {
  const records = new Map(SOURCE_IDS.map(id => [id, {
    lastSuccessAt: null, lastFailureAt: null, reason: null, failKind: null, failures: 0
  }]))

  function rec (source) {
    const r = records.get(source)
    if (!r) throw new Error('unknown source ' + source)
    return r
  }

  /** The last success known from before this process (Faustus persists it). Silent. */
  function seed (source, { lastSuccessAt } = {}) {
    const r = rec(source)
    if (typeof lastSuccessAt === 'number') r.lastSuccessAt = Math.max(r.lastSuccessAt ?? lastSuccessAt, lastSuccessAt)
  }

  function ok (source, { at } = {}) {
    const r = rec(source)
    const wasFailing = isFailing(r)
    const t = typeof at === 'number' ? at : now()
    r.lastSuccessAt = r.lastSuccessAt == null ? t : Math.max(r.lastSuccessAt, t)
    r.failures = 0
    // reason and failKind stay: the settings table shows the last failure as
    // diagnosis even after the source recovered.
    onChange(source, { recovered: wasFailing })
  }

  function fail (source, reason, kind = FAIL_KIND.UNKNOWN, { at } = {}) {
    const r = rec(source)
    const wasFailing = isFailing(r)
    r.lastFailureAt = typeof at === 'number' ? at : now()
    r.reason = cleanReason(reason, { maxChars: reasonMaxChars }) || null
    r.failKind = isFailKind(kind) ? kind : FAIL_KIND.UNKNOWN
    r.failures++
    onChange(source, { started: !wasFailing })
  }

  function get (source) {
    return { source, ...rec(source) }
  }

  function snapshot () {
    return SOURCE_IDS.map(get)
  }

  return { seed, ok, fail, get, snapshot }
}
