// Every numeric setting server.mjs reads out of the environment, in ONE table:
// its default, its allowed range, and — the question the old
// `Number(env) || DEFAULT` idiom could not even ask — whether an explicitly set
// ZERO is a legal setting for it. env-number.mjs is the reader; this file is
// the answer sheet, and docs/admin.md says the same thing in operator language.
//
// WHY A TABLE AND NOT EIGHTEEN CLEVER LINES. The idiom was in the config block
// eighteen times, and each copy carried its default, its clamp and its silence
// at the read site. A default that lives next to the code that uses it drifts
// away from the documentation the first time somebody tunes it, and a clamp
// written as `Math.max(1, …)` is an overwrite nobody is told about. Here the
// default and the range are stated once, the reader enforces them, and a value
// that cannot be honoured is reported instead of quietly replaced.
//
// SEVEN MORE CAME LATER, and they are the reason to say "not a new read site"
// out loud. They sat further down server.mjs behind a helper of their own,
// `positiveEnvInt = (raw, fallback) => Math.max(1, Number(raw) || fallback)` —
// the same defect in another spelling, and it survived the first pass precisely
// because it did not look like the idiom being hunted. Five of the seven had a
// real meaning for zero that the helper was swallowing, and one of them,
// POE_MAX_REQUEUE_ON_RECONNECT, was handing back ten Trade-API searches to
// somebody asking for none (docs/bugs.md B13).
//
// ZERO IS DECIDED PER SETTING, and the two answers are not interchangeable:
//
//   honoured — zero says something the operator needs to be able to say.
//     `POE_CORPSE_BUDGET_PER_HOUR=0` is "ask the Trade API for nothing", and it
//     is the case that started all of this: it used to hand back 25 queries an
//     hour, silently, to somebody switching a background pricer off.
//
//   refused — zero is either meaningless or actively dangerous. A `*_INTERVAL`
//     or `*_REFRESH_MS` of zero is a loop with no pause in it, against GGG or
//     poe.ninja; `POE_NETWORTH_COOLDOWN_MS=0` throws away the backoff a 429
//     bought us; a TTL of zero makes a cache that never holds anything and
//     re-queries forever. Every one of those has a real off switch already
//     (`*_DISABLED=1`, `POE_NETWORTH_AUTOSYNC=0`), which the refusal names.
//
// The two settings whose defaults belong to another module import them, rather
// than repeating the number here: a second copy of a default is a second thing
// to keep in step. Two further readers live with their own module for the same
// reason and use the same reader — `guardOptionsFromEnv` (networth/price-guard)
// and `slowStepMsFromEnv` (networth/refresher); both honour zero, and both are
// documented where they are defined.
//
// THE REQUEST-VOLUME SETTINGS HAVE FLOORS, AND THE FLOORS ARE ARGUED, NOT FELT.
// Eight settings decide how often this tool asks somebody else's server, and
// since they became a form behind a password (config-overrides.mjs) their range
// is what stands between a curious click and a ban. They used to have none
// worth the name: an interval of ONE MILLISECOND passed, and so did a cooldown
// of one millisecond after GGG had answered 429.
//
// What raised the stakes is not a measurement in this repository but a reported
// observation, and it is written down as one: a GGG ban on this deployment
// applied to the whole ADDRESS, not to an account, and it ended by taking a new
// address rather than by sitting out the ~12h it would otherwise have cost.
// That removes the comfortable assumption that each path has a budget of its
// own — the trade API already publishes its limits under the rule name `Ip`
// (see trade-audit.mjs), and everything else leaving this address may well be
// counted next to it.
//
// So each of the eight carries a `min` (or, for the one budget, a `max`) that
// can be pointed at a line of code:
//   POE_CD_REFRESH_MS        NINJA_MIN_MS — server.mjs already lifts anything
//                            smaller to it, so a lower value did nothing at all.
//   POE_FAUSTUS_REFRESH_MS   the digests are hourly (faustus.mjs) — a shorter
//                            interval re-fetches files that cannot have changed.
//   POE_CORPSE_TTL_MS        the budget window is one rolling hour
//                            (corpse-pricer.mjs WINDOW_MS): below it the cache
//                            expires faster than the budget can refill.
//   POE_CORPSE_BUDGET_PER_HOUR  one hour / the interval floor = 30 queries, the
//                            most the pacing can deliver. Higher is a number
//                            that cannot be spent.
//   POE_CORPSE_INTERVAL_MS   the pricer's own documented pace (one name per
//                            2min), on the trade API this repo has two bans on.
//   POE_NETWORTH_SYNC_INTERVAL_MS  the 30s the whole one-tab-per-tick design is
//                            argued at (~2,880 steps/day, refresher.mjs).
//   POE_NETWORTH_COOLDOWN_MS the documented wait after a 429; shortening it is
//                            the direction that turns a rate limit into a ban.
//   POE_DATA_REFRESH_MS      one hour: the sources change on a patch cadence
//                            (weeks) and the catalogue call spends the shared
//                            trade budget.
// The last four are JUDGEMENTS bounded by the conservative side, not
// measurements — nothing here shows that 20s or a five-minute cooldown is
// unsafe, only that nothing argues they are safe. They are floors, so the
// direction they refuse is always the one that sends MORE.
//
// TWO OF THEM ARE NOT PERIODS BUT SHARES, and they are the first rows in this
// table that come from a MEASUREMENT rather than a judgement.
// POE_STASH_IP_BUDGET_SHARE and POE_STASH_ACCOUNT_BUDGET_SHARE say how much of
// a limit GGG publishes in its own response headers the stash path will spend;
// networth/stash-pacer.mjs derives the pace between two stash requests from
// that instead of from a constant. Their dangerous direction is UP, so they
// carry a `max` and no `min` — and they are deliberately NOT on the settings
// page: they are the two dials that decide how close this tool runs to a ban,
// and the derivation is floored at the old constant so that no value here can
// make it faster than it already was.
//
// A THIRD ROW BELONGS TO THE SAME DERIVATION AND POINTS THE OTHER WAY.
// POE_STASH_RULE_TTL_MS is how long a rule GGG published keeps counting after
// it was last published. The shares decide how much of a limit is spent; this
// decides how long a limit is believed — and forgetting one that still counts
// is the same mistake as claiming too much of it, so it carries a floor rather
// than a ceiling and its refused values fall back UP. Off the settings page for
// the same reason as the other two.
//
// AN EXISTING INSTALLATION CANNOT BREAK ON THIS. A compose value that is now
// out of range takes the same path every other unusable value takes: one loud
// [config] line naming the variable, the reason and the default, and the
// DEFAULT is used (env-number.mjs). Nothing throws, nothing refuses to start.
//
// THREE MORE FOLLOWED: POE_STASH_TIMEOUT_MS, POE_LANG_SKEW_WARN_RATIO and PORT.
// The first two were `Number(env) || 30000` and a hand-rolled finite check
// (an empty value read as 0). PORT was the odd one out on purpose: `PORT=0`
// is not an edge case but the normal path in the test suite (bind a random
// port, never the real 8788), which is why it used an explicit "is it set?"
// check instead of `||`. In the table it says the same thing as a row: zero is
// honoured, and a value that is not a port number is reported rather than
// handed to listen().

import {
  DEFAULT_INTERVAL_MS as DATA_REFRESH_DEFAULT_MS, DEFAULT_STALE_TICKS,
  DEFAULT_CHECK_NOW_COOLDOWN_MS as DATA_CHECK_NOW_COOLDOWN_DEFAULT_MS
} from './data-refresher.mjs'
import { HEARTBEAT_MAX_AGE_MS_DEFAULT } from './host-update.mjs'
import { REASON_MAX_CHARS_DEFAULT } from './check-failure.mjs'
// poe.ninja's own courtesy limit, and the number server.mjs already lifts
// POE_CD_REFRESH_MS to. Imported rather than restated for the usual reason.
import { NINJA_MIN_MS } from './ninja.mjs'
import { DEFAULT_MAX_COVERAGE_LOSS_RATIO } from './lang-derive.mjs'
import { DEFAULT_WARN_RATIO as SKEW_DEFAULT_WARN_RATIO } from './lang-skew.mjs'
import { createEnvNumbers } from './env-number.mjs'

const HOUR_MS = 60 * 60 * 1000

// The four defaults that are also their own floor. Named once so the row cannot
// say two different numbers, and so "the floor IS the documented default" stays
// readable as the deliberate statement it is: for these, the form and the
// compose file may slow the tool down and never speed it up.
const NETWORTH_SYNC_DEFAULT_MS = 30 * 1000
const NETWORTH_COOLDOWN_DEFAULT_MS = 10 * 60 * 1000
const FAUSTUS_REFRESH_DEFAULT_MS = HOUR_MS
const CORPSE_INTERVAL_DEFAULT_MS = 2 * 60 * 1000
// The most the corpse pricer can ever spend in an hour: one name per tick, and
// a tick can be no faster than CORPSE_INTERVAL_DEFAULT_MS. A budget above this
// is unreachable by construction.
const CORPSE_BUDGET_CEILING = Math.floor(HOUR_MS / CORPSE_INTERVAL_DEFAULT_MS)

// The longest rate-limit window GGG has been observed to publish on the stash
// endpoints: `Ip 180/7200s` (2026-08-13, 02:15 UTC). It is the floor under
// POE_STASH_RULE_TTL_MS for the reason spelt out at that row — a request can
// still be counted inside a window for as long as the window is — and the
// default is three times it, so a rule set has to be genuinely out of use
// before it is forgotten. Named here so the row cannot say two numbers.
const STASH_RULE_TTL_FLOOR_MS = 2 * HOUR_MS
const STASH_RULE_TTL_DEFAULT_MS = 3 * STASH_RULE_TTL_FLOOR_MS

// The RESOLUTION of GGG's rate-limit windows — the size of the buckets it sums
// requests in. Not in any header; stated by GGG's support and quoted in full at
// the two rows below. Both are also their own floor: these may lengthen a wait
// and never shorten one.
const STASH_BUCKET_SHORT_SEC_DEFAULT = 5
const STASH_BUCKET_LONG_SEC_DEFAULT = 60

export const NUMERIC_SETTINGS = [
  // ---- The listening port -------------------------------------------------
  {
    name: 'PORT',
    fallback: 8788,
    // ZERO HONOURED: PORT=0 asks the operating system for a free port. It is
    // the normal path of the test suite (never bind the real 8788) and the
    // reason this row cannot say `zero: false`. 65535 is the highest port
    // there is; anything else is reported and the default is used.
    zero: true,
    integer: true,
    min: 0,
    max: 65535
  },

  // ---- Observability ------------------------------------------------------
  {
    name: 'POE_TRADE_AUDIT_THRESHOLD',
    fallback: 0.8,
    // ZERO HONOURED: "tell me about every rate-limit window", the same setting
    // POE_NETWORTH_SLOW_STEP_MS=0 is for a stall hunt. The audit is pure
    // observation — it never sends a request and never changes pacing — and it
    // is edge-triggered per rule+window, so a threshold of 0 is one line per
    // window, not one per request. POE_TRADE_AUDIT=0 is the off switch.
    zero: true
  },

  // ---- Price check --------------------------------------------------------
  {
    name: 'POE_MAX_LISTINGS',
    fallback: 10,
    // The trade fetch endpoint (/api/trade/fetch/{ids}) refuses more than 10
    // ids and searchPreset fetches in ONE call, so 10 is a hard ceiling of
    // GGG's, not a preference. Zero would mean "search, then look at none of
    // the answers": every card unpriced, no request saved. The switch for that
    // is POE_PRICE_CHECK_DISABLED=1, which sends nothing at all.
    // 1…10 is also what the settings page enforces on the way in, and it is no
    // longer written twice to say so: config-overrides.mjs reads this row
    // through its `numeric()` helper. See the note on
    // POE_NETWORTH_SYNC_INTERVAL_MS below for what an entry there may still do
    // on top of what stands here.
    zero: false,
    min: 1,
    max: 10,
    integer: true,
    hint: 'Use POE_PRICE_CHECK_DISABLED=1 to switch the price check off.'
  },
  {
    name: 'POE_CD_RATIO',
    fallback: 215,
    // Chaos per divine, used when poe.ninja cannot be reached. Zero would make
    // a divine worth nothing and every chaos->divine conversion a division by
    // it; there is no reading of "0" that is a price.
    zero: false
  },
  {
    name: 'POE_CD_REFRESH_MS',
    fallback: NINJA_MIN_MS,
    // Zero is a poe.ninja fetch with no pause between iterations. Their courtesy
    // limit is the reason the default is 15 minutes in the first place.
    zero: false,
    // ...and it is also the floor, because server.mjs schedules the refresh at
    // `Math.max(CD_REFRESH_MS, NINJA_MIN_MS)`: every smaller value was already
    // lifted back to 15 minutes and did nothing but look like a setting. Of the
    // two ways to end that lie, this is the one that does not increase traffic
    // — the cap stays, the range stops pretending there is anything below it.
    min: NINJA_MIN_MS
  },

  // ---- Net-worth refresher ------------------------------------------------
  {
    name: 'POE_NETWORTH_SYNC_INTERVAL_MS',
    fallback: NETWORTH_SYNC_DEFAULT_MS,
    // Zero ticks against GGG's stash API without pause — the burst the whole
    // one-tab-per-tick design exists to avoid.
    //
    // The floor is the default, and this row used to say the opposite: "no
    // `min` here, narrowing it would be a behaviour change dressed up as a bug
    // fix". It is a behaviour change, and it is not dressed up as anything —
    // 30s is the ONLY pace this design has ever been argued at (refresher.mjs:
    // ~2,880 steps a day in total), a step can be 1+N requests on a folder tab,
    // and the stash budget may be counted against the same address as the trade
    // traffic. Nothing here measures 20s as unsafe; nothing argues it is safe
    // either, and the direction being refused is the one that sends more.
    // The allow-list may still NARROW further for the browser path
    // (config-overrides.mjs `numeric()`, which reads this table) — never widen.
    zero: false,
    min: NETWORTH_SYNC_DEFAULT_MS,
    hint: 'Use POE_NETWORTH_AUTOSYNC=0 to switch the background refresher off.'
  },
  {
    name: 'POE_STASH_IP_BUDGET_SHARE',
    fallback: 0.5,
    // How much of a rule GGG publishes under the name `Ip` the stash path will
    // spend. Not a period and not a count: the pace between two stash requests
    // is DERIVED from the published limits (networth/stash-pacer.mjs), and this
    // is the safety margin in that derivation — 0.5 means "hold to half the rate
    // GGG allows".
    //
    // Half, because an `Ip` budget is shared with everything else leaving this
    // address: the household's own browser on pathofexile.com, and this app's
    // trade path, which is not counted against the stash rules but is counted
    // against the address. None of it is visible from here. The measured rule
    // set is `Ip 45/60s ban 120s, Ip 180/1800s ban 600s`; the constant the tool
    // used before this dial existed ran at 89% of the first one.
    //
    // Zero would mean "spend nothing", i.e. an infinite spacing — the off switch
    // for the stash path is POE_NETWORTH_AUTOSYNC=0, which also stops the timer.
    // The dangerous direction is UP, so this row carries a ceiling and NO floor:
    // a refused value falls back to the default (env-number.mjs), and for a
    // ceiling that fallback is the conservative direction. Above 1 would claim
    // more than GGG publishes; the derivation is floored at the old constant
    // regardless, so no value here can make the tool send faster than it did.
    zero: false,
    max: 1,
    hint: 'Use POE_NETWORTH_AUTOSYNC=0 to switch the background stash reads off.'
  },
  {
    name: 'POE_STASH_ACCOUNT_BUDGET_SHARE',
    fallback: 0.75,
    // The same margin for the rules GGG publishes under the name `Account`
    // (measured: `Account 30/60s ban 60s, Account 100/1800s ban 600s` on one
    // endpoint group, `Account 15/10s ban 60s, Account 30/300s ban 300s` on the
    // other). Higher than the `Ip` share on purpose: this budget is spent by
    // this session, where the operator's own logged-in browsing is the only
    // other plausible consumer, while the address is shared with traffic the
    // tool cannot see at all. Which of the two rules ends up BINDING is GGG's
    // choice, not this one — on the measured set it is `Account 100/1800s`.
    //
    // Zero, the ceiling and the missing floor: exactly as above.
    zero: false,
    max: 1,
    hint: 'Use POE_NETWORTH_AUTOSYNC=0 to switch the background stash reads off.'
  },
  {
    name: 'POE_STASH_RULE_TTL_MS',
    fallback: STASH_RULE_TTL_DEFAULT_MS,
    // How long a published rule keeps counting after GGG last published it.
    // The pacer honours every rule it has been told about at once, so without a
    // way OUT of that table the pace was a one-way street: one strict rule set
    // — a server under load, a different policy answered once — slowed the tool
    // down until the process was restarted, and GGG going back to a looser set
    // changed nothing. The ordinary way out is the policy key (a response
    // replaces the set of its OWN policy, see networth/stash-pacer.mjs); this
    // is the fallback for the two cases that key cannot cover: a policy that is
    // never asked again, and a response with no policy header at all.
    //
    // ITS DANGEROUS DIRECTION IS DOWN — forgetting a rule that still counts is
    // forgetting a reason to wait — so it carries a floor and no ceiling, and a
    // refused value falls back UP to the default (env-number.mjs). Zero would
    // forget every rule on the spot and drop the pace back to the 1500ms
    // constant.
    //
    // THE FLOOR IS THE LONGEST WINDOW GGG HAS BEEN OBSERVED TO PUBLISH,
    // `Ip 180/7200s` (2026-08-13, 02:15 UTC). That is the arithmetic bar: a
    // request of ours can still be inside a window of length W for W after it
    // was sent, and a rule is only published in an answer to a request, so
    // dropping a set less than W after its last publication could drop a limit
    // that is still being counted. The pacer floors every single rule at its
    // OWN window on top of this, so a future rule with a longer window is
    // covered by arithmetic rather than by this number staying current.
    //
    // THE DEFAULT IS THREE TIMES THAT FLOOR. The margin is not decoration: it
    // absorbs the gap between a request going out and its answer coming back
    // (up to POE_STASH_TIMEOUT_MS, and a timed-out request counts against GGG
    // without ever refreshing what it published), and it means a policy has to
    // be genuinely out of use for six hours — twelve full rounds of a ~115-tab
    // account — before anything is forgotten. Expiry is the fallback, not the
    // mechanism; the mechanism answers within one response.
    zero: false,
    min: STASH_RULE_TTL_FLOOR_MS,
    integer: true,
    hint: 'Use POE_NETWORTH_AUTOSYNC=0 to switch the background stash reads off.'
  },
  {
    name: 'POE_STASH_BUCKET_SHORT_SEC',
    fallback: STASH_BUCKET_SHORT_SEC_DEFAULT,
    // THE ONE NUMBER IN THIS DERIVATION THAT IS IN NO HEADER AT ALL. GGG does
    // not count requests at the instant they arrive; it buckets them, and the
    // bucket size is published nowhere. From GGG's own support, to the
    // gerwaric/acquisition project, about a stash policy:
    //
    //   "That particular policy has a resolution of 5 seconds, which means that
    //    it buckets incoming requests in 5 second intervals. To be safe you'd
    //    have to add 5 more seconds rather than 2. This isn't exposed anywhere
    //    for you to have known."
    //
    // This is that resolution for the SHORT limit of the stash and character
    // policies. A limit is summed over whole buckets, so "45 per 60s" really
    // covers anything from 60s to 60s+bucket of wall clock depending on where
    // the present moment falls inside the current bucket; the pacer therefore
    // derives its rate against `windowSec + bucketSec`
    // (networth/stash-pacer.mjs). It is also what the reactive brake adds when
    // it waits a window out — the "5 more seconds" of the quote, literally.
    //
    // It explains something the arithmetic could not: pacing that is correct
    // against the published numbers still collecting the occasional 429.
    //
    // The dangerous direction is DOWN, and the floor is the documented default:
    // this dial may lengthen the surcharge and never shorten it. Zero would be
    // "the limiter has no resolution", which is the assumption GGG explicitly
    // corrected.
    zero: false,
    min: STASH_BUCKET_SHORT_SEC_DEFAULT,
    integer: true,
    hint: 'Use POE_NETWORTH_AUTOSYNC=0 to switch the background stash reads off.'
  },
  {
    name: 'POE_STASH_BUCKET_LONG_SEC',
    fallback: STASH_BUCKET_LONG_SEC_DEFAULT,
    // The same resolution for the SUSTAINED limit: one minute. It does two
    // things, and the second one is why there is no third setting for it —
    // WHICH bucket applies is derived rather than declared: a window no longer
    // than the sustained limit's own bucket cannot be a sustained limit. On
    // every rule set seen so far that splits exactly where it should, 10s and
    // 60s taking the short bucket and 300s, 1800s and 7200s the long one.
    //
    // The surcharge it adds is small where it lands — 1800s becomes 1860s, 3.3%
    // on the binding rule of the measured set (24.0s -> 24.8s). Adding a whole
    // minute to every derived GAP instead would be a 3.5x slowdown that nothing
    // here argues for; it is the WINDOW that is uncertain, not the gap.
    //
    // Floor, zero and direction exactly as above.
    zero: false,
    min: STASH_BUCKET_LONG_SEC_DEFAULT,
    integer: true,
    hint: 'Use POE_NETWORTH_AUTOSYNC=0 to switch the background stash reads off.'
  },
  {
    name: 'POE_STASH_TIMEOUT_MS',
    fallback: 30000,
    // Per-request timeout of one stash read (networth/stash-client.mjs). Zero
    // would abort every request before it can answer, so no tab could ever be
    // read; the refresher would spend its budget on timeouts, and a timed-out
    // request still counts against GGG. Below one second no real answer arrives
    // either. The switch for "no stash reads" is POE_NETWORTH_AUTOSYNC=0.
    zero: false,
    min: 1000,
    integer: true,
    hint: 'Use POE_NETWORTH_AUTOSYNC=0 to switch the background stash reads off.'
  },
  {
    name: 'POE_NETWORTH_LIST_TTL_MS',
    fallback: 15 * 60 * 1000,
    // Zero re-fetches the stash-tab LIST on every tick — and that is worse than
    // the "one extra request per user per tick" this comment used to claim, in
    // all three of its parts. A tick refreshes the list OR syncs one tab, never
    // both (networth/refresher.mjs: the list branch returns, "one request spent
    // — the tab syncs happen on following ticks"), and a tick belongs to ONE
    // user, walked round-robin. So a zero costs no extra request: it spends
    // every request the refresher will ever make on the list, no tab is ever
    // synced again, and the net worth freezes on whatever was in the store.
    // Silently — the request count in the log looks exactly as it should.
    zero: false
  },
  {
    name: 'POE_NETWORTH_COOLDOWN_MS',
    fallback: NETWORTH_COOLDOWN_DEFAULT_MS,
    // Zero is "retry immediately after GGG said 429". That is how a rate limit
    // becomes a ban, and this tool has been banned twice.
    //
    // Everything between zero and the default is the same mistake, only slower,
    // so the floor is the documented ten minutes: this dial may lengthen the
    // wait after a refusal and not shorten it. (A longer Retry-After from GGG
    // still wins over it — refresher.mjs takes the larger of the two.) The
    // alternative anchor, the 60s rate-limit-signal.mjs falls back to for a
    // ban with no duration in it, describes a first guess at an unknown wait,
    // not a considered backoff after GGG has already refused us.
    zero: false,
    min: NETWORTH_COOLDOWN_DEFAULT_MS
  },

  // ---- Faustus (GGG Currency Exchange, public CDN) ------------------------
  {
    name: 'POE_FAUSTUS_UNION_HOURS',
    // No number of its own: unset leaves faustus.mjs on its own documented
    // default (8), which is where that constant lives.
    fallback: undefined,
    // Zero unions no hours at all and derives no prices — the refresher would
    // run and produce nothing.
    zero: false,
    min: 1,
    integer: true,
    hint: 'Use POE_FAUSTUS_DISABLED=1 to switch the Faustus refresher off.'
  },
  {
    name: 'POE_FAUSTUS_REFRESH_MS',
    fallback: FAUSTUS_REFRESH_DEFAULT_MS,
    // Zero fetches the CDN in a loop. The underlying digest only changes
    // hourly, so it would buy nothing even if it were free.
    //
    // That last sentence is also the floor: faustus.mjs reads per-hour digests
    // and works on the last COMPLETED hour, so every pass inside the same hour
    // downloads files that cannot have changed since the previous one — one
    // pass is up to POE_FAUSTUS_UNION_HOURS files. This is the rare case where
    // "the smallest number at which the setting still does something" is an
    // arithmetic fact about the source rather than a judgement.
    zero: false,
    min: FAUSTUS_REFRESH_DEFAULT_MS,
    hint: 'Use POE_FAUSTUS_DISABLED=1 to switch the Faustus refresher off.'
  },
  {
    name: 'POE_FAUSTUS_TTL_MS',
    fallback: 48 * 60 * 60 * 1000,
    // Zero makes the store stale the instant it is written, so the refresher
    // keeps fetching and the valuator never uses a single price from it.
    zero: false,
    hint: 'Use POE_FAUSTUS_DISABLED=1 to fall through to poe.ninja instead.'
  },

  // ---- Corpses (Trade API, background priority) ---------------------------
  {
    name: 'POE_CORPSE_TTL_MS',
    fallback: 6 * HOUR_MS,
    // Zero means every cached corpse price is stale on arrival, so the pricer
    // spends its whole hourly budget re-asking questions it already has answers
    // to. Trade-API requests, i.e. the budget that gets accounts banned.
    //
    // The floor is one hour, the pricer's budget WINDOW (corpse-pricer.mjs):
    // under it an entry goes stale faster than the budget that produced it can
    // refill, which is the same "re-ask what you already know" as zero, merely
    // rationed. It is the smallest DEFENSIBLE floor rather than the honest one
    // — a full pass over the ~70 corpse names at the 30/h ceiling takes over
    // two hours, so anything below that already re-asks before it has finished
    // the round — but that number moves with the stash and cannot be stated as
    // a constant here. The default of six hours stays where it is.
    zero: false,
    min: HOUR_MS
  },
  {
    name: 'POE_CORPSE_BUDGET_PER_HOUR',
    fallback: 25,
    // ZERO HONOURED, and this is the case the whole change is about: 0 means
    // the corpse pricer asks the Trade API for NOTHING. It used to hand back
    // 25 queries an hour to an operator who was trying to stop it.
    zero: true,
    integer: true,
    // The one row here whose dangerous direction is UP, and it had no ceiling
    // at all. This one is arithmetic: the pricer prices one name per tick and a
    // tick cannot be faster than POE_CORPSE_INTERVAL_MS's floor, so 30 is the
    // most it can spend in a rolling hour. Everything above is a number that
    // reads like a raised limit and cannot be reached — and if the pacing floor
    // ever moves, this ceiling moves with it instead of drifting away from it.
    max: CORPSE_BUDGET_CEILING
  },
  {
    name: 'POE_CORPSE_INTERVAL_MS',
    fallback: CORPSE_INTERVAL_DEFAULT_MS,
    // Zero is a Trade-API tick with no pause. The hourly budget still caps the
    // total, but the pacing between queries is what keeps the shared queue free
    // for a manual search.
    //
    // The floor is that same documented pace of one name every two minutes
    // (corpse-pricer.mjs, "~30/h ceiling; budget is the real cap"). These are
    // requests to /api/trade/*, whose limits GGG publishes under the rule name
    // `Ip` and which this repository has two real bans on — the interval is not
    // the dial to experiment with downwards from a browser form.
    zero: false,
    min: CORPSE_INTERVAL_DEFAULT_MS,
    hint: 'Use POE_CORPSE_DISABLED=1 to switch the corpse pricer off, or POE_CORPSE_BUDGET_PER_HOUR=0 to leave it running without querying.'
  },

  // ---- Data auto-update ---------------------------------------------------
  {
    name: 'POE_DATA_REFRESH_MS',
    fallback: DATA_REFRESH_DEFAULT_MS,
    // Zero re-checks the data sources in a loop instead of ~daily.
    //
    // The floor is one hour, and it is a judgement with a reason rather than a
    // measurement: the sources change on a PATCH cadence (weeks), one check is
    // three sources, and one of them is a stat-catalogue call on the trade API
    // — the same budget the price check and the corpse pricer spend, published
    // by GGG under the rule name `Ip`. An hour still allows 24 rounds a day
    // against something that changes a few times a league, which is generous;
    // it is set there rather than at the daily default because a league launch
    // is a real reason to look more often than once a day.
    zero: false,
    min: HOUR_MS,
    hint: 'Use POE_DATA_REFRESH_DISABLED=1 to switch the data auto-update off.'
  },
  {
    name: 'POE_DATA_STALE_TICKS',
    fallback: DEFAULT_STALE_TICKS,
    // A count of missed checks. Zero would call every source stale the moment
    // it was refreshed, which is a status line that says nothing.
    zero: false,
    min: 1,
    integer: true
  },
  {
    name: 'POE_DATA_CHECK_NOW_COOLDOWN_MS',
    fallback: DATA_CHECK_NOW_COOLDOWN_DEFAULT_MS,
    // How long the admin area's "check now" button stays shut after a run.
    //
    // WHY IT HAS ONE AT ALL. The button exists so that a repair can be VERIFIED
    // instead of waited out: somebody who has just corrected POE_PATCH_VERSION
    // could otherwise not tell for up to 24 hours whether it worked, and that
    // is the first wall a stranger walks into. It is not a free button, though.
    // One press is a patch lookup, a conditional fetch of every upstream file,
    // and — when anything is out of date — a game-data export that pulls tens
    // of megabytes off the patch CDN and rebuilds the localized set. The moment
    // somebody is repairing something is exactly the moment they will press a
    // button that appears to do nothing, so an unguarded one turns a repair
    // into a self-inflicted flood against the very servers the repair needs.
    //
    // Five minutes: short enough that verifying a fix is not a wait worth
    // complaining about, long enough that holding the button down cannot become
    // a request stream. The floor is a minute rather than zero for the reason
    // POE_DATA_REFRESH_MS has one — this is settable from the page, and "no
    // cooldown" is not a configuration, it is the absence of the guard.
    //
    // The overlap guard is a separate thing and stays: a check that is already
    // running answers "already running" whatever the cooldown says.
    zero: false,
    min: 60 * 1000,
    integer: true
  },
  {
    name: 'POE_DATA_STATUS_REASON_MAX',
    fallback: REASON_MAX_CHARS_DEFAULT,
    // Characters of the LAST FAILURE REASON a data source's status line carries
    // (check-failure.mjs). Zero would put the duration back on screen without
    // the cause, which is the state this value exists to end; the floor of 40 is
    // the point below which the sentence no longer names what failed.
    zero: false,
    min: 40,
    integer: true
  },
  {
    name: 'POE_LANG_MAX_COVERAGE_LOSS_RATIO',
    fallback: DEFAULT_MAX_COVERAGE_LOSS_RATIO,
    // How much of what the localized data set ALREADY COVERED may fall away in
    // one regeneration before the run is thrown away (lang-derive.mjs,
    // validate()). ZERO HONOURED, and it is the strictest setting rather than
    // an off switch: "not one stat that has a German matcher today may lose
    // it". That is a real thing to want on an install where the localized
    // parser is the only one in use, and the direction it refuses is the safe
    // one — a run that would lose coverage is not adopted and the previous set
    // stays live.
    zero: true,
    // A share of the baseline, so above 1 it is not a share; at 1 it would
    // accept a set that covers nothing at all.
    max: 1
  },
  {
    name: 'POE_LANG_SKEW_WARN_RATIO',
    fallback: SKEW_DEFAULT_WARN_RATIO,
    // How far a localized data set may fall behind English before the admin
    // view calls it a warning, as a fraction of the English set. ZERO HONOURED:
    // "warn on any gap at all". Display only — it never sends a request and
    // never changes what is served. Above 1 it would be more than the whole
    // English set, so a warning could never fire.
    zero: true,
    max: 1
  },

  // ---- Gap reporting ------------------------------------------------------
  {
    name: 'POE_GAP_LOG_MAX',
    fallback: 200,
    // Entries kept per kind. Zero cannot mean "record nothing": gap-log.mjs
    // clamps its own cap to at least 1, so a 0 here would be overwritten a
    // second time, further away, and mean nothing either.
    zero: false,
    min: 1,
    integer: true
  },
  {
    name: 'POE_GAP_LOG_TEXT_MAX',
    fallback: 400,
    // Characters kept of a recorded text. Below ~40 the excerpt cannot show
    // enough of an item to identify what failed, which is the entire point of
    // recording it.
    zero: false,
    min: 40,
    integer: true
  },

  // ---- Rooms and the reconnect requeue ------------------------------------
  // The first two of the seven that stayed on `Math.max(1, Number(raw) || d)`
  // after the config block was converted (docs/bugs.md B13). Same trap in
  // another spelling: `0`, `''`, `abc` and `-1` all landed on the default and
  // none of them could be told from "not set" afterwards.
  {
    name: 'POE_MAX_ITEMS_PER_ROOM',
    fallback: 50,
    // Zero is refused. `enforceItemCap` evicts while `room.items.size > cap`,
    // so a cap of 0 deletes every card the instant it is created — the tool
    // still parses and prices, and nothing is ever on screen. There is no
    // reading of "hold no cards" that anybody wants; dismissing a card is how
    // a room is emptied.
    zero: false,
    min: 1,
    integer: true
  },
  {
    name: 'POE_MAX_REQUEUE_ON_RECONNECT',
    fallback: 10,
    // ZERO HONOURED, and this is the one of the seven that costs REQUESTS. A
    // re-queued card is an `auto` price search on the Trade API (server.mjs,
    // `enqueue({ kind: 'auto' })`), so `=0` — "re-queue nothing", the strongest
    // form of the flood cap this setting exists for — used to hand back the
    // default 10 searches per reconnect. Exactly the shape of
    // POE_CORPSE_BUDGET_PER_HOUR=0 handing back 25 an hour, only bounded by one
    // reconnect instead of repeating on a schedule.
    //
    // Which also puts this row in the small class where a REFUSAL sends more
    // than was asked for: `=none` or `=-1` falls back to 10. That is the same
    // trade as the corpse budget — the loud line is the protection, and
    // refusing to start over a typo removes the tool instead.
    zero: true,
    integer: true
  },

  // ---- The rate-limit banner ----------------------------------------------
  {
    name: 'POE_RATE_LIMIT_BANNER_MIN_SEC',
    fallback: 60,
    // ZERO HONOURED: "show the ban banner for every rate-limit wait, however
    // short". Display only — the banner neither sends nor suppresses a request,
    // the local backoff happens either way — so the cost of zero is a banner
    // that flickers for routine queue backpressure, which is a choice an
    // operator is allowed to make while watching a suspected ban.
    zero: true,
    // Whole seconds: the value is compared against the Retry-After GGG sends,
    // which is a whole number of seconds.
    integer: true
  },

  // ---- The ask-conflict marker (display only) ------------------------------
  // Four thresholds behind one marker on the item card ("Exchange — asks
  // disagree"). None of them sends anything; what they decide is whether the
  // card admits that two sources contradict each other. That is why three of
  // the four honour zero: "mark more" is a legitimate thing to ask for here in
  // a way that "poll faster" never is.
  {
    name: 'POE_ASK_CONFLICT_RATIO',
    fallback: 4,
    // Zero is refused, and so is anything below 1. The test is
    // `headline >= ratio * askMedian`: at 0 every headline "disagrees" with
    // every ask and the marker is on every card, which is the same as having no
    // marker. Below 1 it fires whenever the headline is merely near the asks —
    // the comparison stops meaning "these two contradict each other".
    zero: false,
    min: 1,
    hint: 'A large value (say 1000) silences the marker; 0 would mark everything, which says as little.'
  },
  {
    name: 'POE_ASK_CONFLICT_ABS_GAP_C',
    fallback: 5,
    // ZERO HONOURED: "no absolute gap required, the ratio alone decides". The
    // gap exists so near-floor items, where 1-chaos walls are endemic, do not
    // trip on granularity; an operator who wants the ratio to speak for itself
    // is asking for more markers, not for more traffic.
    zero: true
  },
  {
    name: 'POE_MIN_ASK_EVIDENCE',
    fallback: 5,
    // ZERO HONOURED: "no minimum listing count before the asks may contradict
    // the headline". The listings are already fetched when this is read — the
    // number is a confidence bar on data in hand, not a request cap.
    zero: true,
    integer: true
  },
  {
    name: 'POE_MIN_CONFLICT_HEADLINE_C',
    fallback: 1,
    // ZERO HONOURED: "mark sub-chaos headlines too". The default exists because
    // the trade site cannot list below 1 chaos, so a sub-chaos exchange
    // headline disagrees with its asks by construction; somebody investigating
    // exactly that can switch the floor off.
    zero: true
  },

  // ---- The update button --------------------------------------------------
  {
    name: 'POE_UPDATE_HEARTBEAT_MAX_AGE_MS',
    fallback: HEARTBEAT_MAX_AGE_MS_DEFAULT,
    // How old the host script's heartbeat may get before the admin area says no
    // updater is installed. Under a minute is shorter than any sane schedule
    // and would report an installed updater as missing; zero always would.
    zero: false,
    min: 60_000,
    integer: true
  }
]

const table = createEnvNumbers(NUMERIC_SETTINGS)

/** The specs by name — for tests and for documentation checks. */
export const NUMERIC_SETTINGS_BY_NAME = table.specs

/**
 * envNum('POE_…', { env, log }) -> number | undefined
 *
 * The only way server.mjs reads a number out of the environment. A name that is
 * not in the table above throws rather than resolving to `undefined`.
 */
export function envNum (name, opts) { return table.get(name, opts) }
