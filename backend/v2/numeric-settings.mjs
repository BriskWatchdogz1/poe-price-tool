// Every numeric setting server.mjs reads out of the environment, in ONE table:
// its default, its allowed range, and whether an explicitly set ZERO is a legal
// setting for it (which `Number(env) || DEFAULT` cannot even ask).
// env-number.mjs is the reader; this file is the answer sheet, and
// docs/admin.md says the same thing in operator language. The default and the
// range are stated once, the reader enforces them, and a value that cannot be
// honoured is reported instead of quietly replaced. A new numeric setting gets
// a row here, not a new read site (a `Math.max(1, Number(raw) || fallback)`
// helper swallowed zero for POE_MAX_REQUEUE_ON_RECONNECT and handed back ten
// Trade-API searches to somebody asking for none, docs/bugs.md B13).
//
// ZERO IS DECIDED PER SETTING, and the two answers are not interchangeable:
//   honoured — zero says something the operator needs to be able to say:
//     `POE_CORPSE_BUDGET_PER_HOUR=0` is "ask the Trade API for nothing" (the
//     `||` idiom turned it into 25 queries an hour).
//   refused — zero is meaningless or dangerous: a `*_INTERVAL` or
//     `*_REFRESH_MS` of zero is a loop with no pause, against GGG or poe.ninja;
//     `POE_NETWORTH_COOLDOWN_MS=0` throws away the backoff a 429 bought; a TTL
//     of zero makes a cache that never holds anything and re-queries forever.
//     Each has a real off switch (`*_DISABLED=1`, `POE_NETWORTH_AUTOSYNC=0`),
//     which the refusal names.
// AN EXISTING INSTALLATION CANNOT BREAK ON THIS: an out-of-range compose value
// gets one loud [config] line naming the variable, the reason and the default,
// and the DEFAULT is used (env-number.mjs). Nothing throws or refuses to start.
//
// The two settings whose defaults belong to another module import them rather
// than repeating the number. Two further readers live with their own module
// and use the same reader — `guardOptionsFromEnv` (networth/price-guard) and
// `slowStepMsFromEnv` (networth/refresher); both honour zero and are
// documented where they are defined.
//
// THE REQUEST-VOLUME SETTINGS HAVE FLOORS, ARGUED, NOT FELT. Nine settings
// decide how often this tool asks somebody else's server, and as a form behind
// a password (config-overrides.mjs) their range is what stands between a
// curious click and a ban. A reported observation raises the stakes: a GGG ban
// on this deployment applied to the whole ADDRESS, not to an account, and ended
// by taking a new address rather than sitting out the ~12h. The trade API
// publishes its limits under the rule name `Ip` (see trade-audit.mjs), and
// everything else leaving this address may be counted next to it. Each of the
// nine carries a `min` (for POE_CORPSE_BUDGET_PER_HOUR a `max`, 30 queries)
// that its row's comment ties to a line of code: POE_CD_REFRESH_MS,
// POE_NINJA_MAP_TTL_MS, POE_FAUSTUS_REFRESH_MS, POE_CORPSE_TTL_MS,
// POE_CORPSE_BUDGET_PER_HOUR, POE_CORPSE_INTERVAL_MS,
// POE_NETWORTH_SYNC_INTERVAL_MS, POE_NETWORTH_COOLDOWN_MS, POE_DATA_REFRESH_MS.
// The last four are JUDGEMENTS bounded by the conservative side, not
// measurements: nothing shows that 20s or a five-minute cooldown is unsafe,
// only that nothing argues they are safe. As floors they always refuse the
// direction that sends MORE.
//
// THREE STASH ROWS COME FROM A MEASUREMENT, and are deliberately NOT on the
// settings page: they decide how close this tool runs to a ban.
// POE_STASH_IP_BUDGET_SHARE and POE_STASH_ACCOUNT_BUDGET_SHARE are the share of
// a limit GGG publishes in its response headers that the stash path spends
// (networth/stash-pacer.mjs derives the pace from it); their dangerous
// direction is UP, so they carry a `max` and no `min`, and the derivation is
// floored at the base spacing (baseMs, 1500ms), so no value here can make it
// faster than that.
// POE_STASH_RULE_TTL_MS is how long a published rule keeps counting after it
// was last published; forgetting a rule that still counts is the same mistake
// as claiming too much of it, so it carries a floor, and refused values fall
// back UP.
//
// Further rows: four came with the source status (docs/bugs.md B29) — how old a
// price source may get before the status line names it, how long an old
// poe.ninja answer is still served, how long the net-worth exchange map lives,
// how often a failing poe.ninja key is logged again. POE_STASH_TIMEOUT_MS
// (default 30000) and POE_LANG_SKEW_WARN_RATIO are rows too, and so is PORT:
// `PORT=0` is the normal path in the test suite (bind a random port, never the
// real 8788), so zero is honoured, and a value that is not a port number is
// reported rather than handed to listen().

import {
  DEFAULT_INTERVAL_MS as DATA_REFRESH_DEFAULT_MS, DEFAULT_STALE_TICKS,
  DEFAULT_CHECK_NOW_COOLDOWN_MS as DATA_CHECK_NOW_COOLDOWN_DEFAULT_MS
} from './data-refresher.mjs'
import { HEARTBEAT_MAX_AGE_MS_DEFAULT } from './host-update.mjs'
import { REASON_MAX_CHARS_DEFAULT } from './check-failure.mjs'
// poe.ninja's own courtesy limit, and the number server.mjs already lifts
// POE_CD_REFRESH_MS to. Imported rather than restated for the usual reason.
import {
  NINJA_MIN_MS, NINJA_MAX_AGE_DEFAULT_MS, NINJA_MAP_TTL_DEFAULT_MS, NINJA_FAIL_LOG_DEFAULT_MS
} from './ninja.mjs'
import { DEFAULT_MAX_COVERAGE_LOSS_RATIO } from './lang-derive.mjs'
import { DEFAULT_WARN_RATIO as SKEW_DEFAULT_WARN_RATIO } from './lang-skew.mjs'
// sessions.mjs reads no environment at import, so this stays a plain table.
import {
  SESSION_BASELINE_MAX_AGE_MS_DEFAULT, SESSION_RATE_MIN_MS_DEFAULT, SESSION_TOP_N_DEFAULT,
  SESSION_LIST_MAX_DEFAULT, SESSIONS_KEEP_DEFAULT, SESSION_FINALIZE_MAX_MS_DEFAULT
} from './networth/sessions.mjs'
// The two bars of the Net-Worth uncertainty marker belong to the modules that
// argue them. Neither module reads the environment or imports anything, so
// there is no cycle and config-overrides stays env-free.
import { SELL_MIN_QUOTE_TURNOVER_C } from './sell-side.mjs'
import { CORPSE_MIN_LISTINGS } from './networth/corpse-pricer.mjs'
// Sync follows the game: the idle share belongs to the refresher that argues it
// (WHO GETS THE TICK); it reads no environment at import.
import { DEFAULT_IDLE_EVERY } from './networth/refresher.mjs'
import { GAME_GAP_MS_DEFAULT } from './networth/session-control.mjs'
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
    // The floor is the default, and that is a deliberate behaviour limit:
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
    name: 'POE_NETWORTH_IDLE_EVERY',
    fallback: DEFAULT_IDLE_EVERY,
    // Sync follows the game (networth/refresher.mjs, WHO GETS THE TICK). Only
    // ever lowers the load: it decides which tick a user whose daemon reports
    // the game not running gets, never adds one. A value above max is refused
    // and lands on the default 10, which is more reads than were asked for
    // (one of the four such refusals, env-number.mjs). 1 is refused: every tick
    // would go to the idle users and the players would get none. Zero likewise
    // (with zero: true the reader would still refuse it below min). Resting
    // completely is POE_NETWORTH_IDLE_REST=1, a switch outside this table.
    zero: false,
    min: 2,
    max: 1000,
    integer: true,
    hint: 'Use POE_NETWORTH_IDLE_REST=1 to give users whose game is not running no tick at all.'
  },
  {
    name: 'POE_SYNC_AFTER_GAME_MAX_MS',
    fallback: HOUR_MS,
    // How long a player whose game just stopped keeps the playing pace at
    // most, until each of their tabs was read once since (daemon-presence.mjs
    // makeHoldAfterGame). Moves turns between users, never adds one. ZERO
    // HONOURED: a stopped game yields at once.
    zero: true,
    integer: true
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
    // set is `Ip 45/60s ban 120s, Ip 180/1800s ban 600s`; the base spacing
    // alone (1500ms) runs at 89% of the first one.
    //
    // Zero would mean "spend nothing", i.e. an infinite spacing — the off switch
    // for the stash path is POE_NETWORTH_AUTOSYNC=0, which also stops the timer.
    // The dangerous direction is UP, so this row carries a ceiling and NO floor:
    // a refused value falls back to the default (env-number.mjs), and for a
    // ceiling that fallback is the conservative direction. Above 1 would claim
    // more than GGG publishes; the derivation is floored at the base spacing
    // (baseMs, 1500ms) regardless, so no value here can make the tool send
    // faster than that.
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
    // "one extra request per user per tick", in all three of its parts. A tick
    // refreshes the list OR syncs one tab, never
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

  // ---- Price sources: status and poe.ninja ages (docs/bugs.md B29) ----------
  {
    name: 'POE_SOURCE_STALE_MS',
    fallback: 3 * HOUR_MS,
    // From this age of its last success the status line on every page names a
    // price source (Faustus, poe.ninja) as stale. Display only: no request
    // depends on it. Per source it is additionally raised to twice that
    // source's own refresh interval (server.mjs sourceStaleAfterMs), so a slow
    // schedule is not reported between two of its own ticks.
    //
    // The floor of one hour is Faustus' own pace: below it a healthy source
    // would be called stale between two ticks. Zero would be "always stale".
    zero: false,
    min: HOUR_MS
  },
  {
    name: 'POE_NINJA_MAX_AGE_MS',
    fallback: NINJA_MAX_AGE_DEFAULT_MS,
    // How long a poe.ninja answer is still served after refreshing it failed.
    // Past it the item is unpriced and falls through to the next source — a
    // wrong price is worse than none (ninja.mjs). An answer is up to 15 min old
    // by design, hence the floor; zero would serve nothing that is not
    // younger than this very instant.
    zero: false,
    min: NINJA_MIN_MS
  },
  {
    name: 'POE_NINJA_MAP_TTL_MS',
    fallback: NINJA_MAP_TTL_DEFAULT_MS,
    // How long the net-worth valuation keeps its merged exchange map before it
    // reads the 14 overview types again (networth/valuator.mjs). Below 15 min a
    // rebuild only re-reads the answers ninja.mjs still has cached; zero would
    // rebuild on every valuation.
    zero: false,
    min: NINJA_MIN_MS
  },
  {
    name: 'POE_NINJA_FAIL_LOG_MS',
    fallback: NINJA_FAIL_LOG_DEFAULT_MS,
    // How often a poe.ninja key that keeps failing is logged again (fail-log.mjs);
    // the start and the recovery are always logged. ZERO HONOURED: "one line per
    // failed attempt", which stays bounded because ninja.mjs does not ask the
    // same key again for 15 minutes after a failure.
    zero: true
  },

  // ---- Corpses (Trade API, background priority) ---------------------------
  {
    name: 'POE_CORPSE_TTL_MS',
    fallback: 6 * HOUR_MS,
    // Zero means every cached corpse price is stale on arrival, so the pricer
    // spends its whole hourly budget re-asking questions it already has answers
    // to. Trade-API requests, i.e. the budget that gets accounts banned.
    //
    // The floor is one hour, the pricer's budget WINDOW (corpse-pricer.mjs
    // WINDOW_MS):
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
    // ZERO HONOURED: 0 means the corpse pricer asks the Trade API for NOTHING,
    // not 25 queries an hour to an operator who is trying to stop it.
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
    // form of the flood cap this setting exists for — must not hand back the
    // default 10 searches per reconnect (the same shape as
    // POE_CORPSE_BUDGET_PER_HOUR=0, only bounded by one reconnect instead of
    // repeating on a schedule).
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

  // ---- The Net-Worth uncertainty marker (display only) ---------------------
  // Two bars behind the Confidence column of the Net-Worth table
  // (docs/pricing-logic.md, "Uncertain prices"). Like the ask-conflict block
  // above, neither sends anything and neither changes a price, a total or a
  // history point: they decide which rows the page marks. Both honour zero.
  {
    name: 'POE_NETWORTH_THIN_TURNOVER_C',
    fallback: SELL_MIN_QUOTE_TURNOVER_C,
    // ZERO HONOURED: mark nothing as "thin market". A very large value marks
    // every Faustus and poe.ninja exchange price; that is a choice, not a
    // danger, because nothing is subtracted.
    zero: true
  },
  {
    name: 'POE_NETWORTH_CORPSE_MIN_LISTINGS',
    fallback: CORPSE_MIN_LISTINGS,
    // ZERO HONOURED: never mark a corpse price. Above 10 (the most listings the
    // corpse pricer fetches) every corpse is marked.
    zero: true,
    integer: true
  },

  // ---- Farm sessions (display and bookkeeping only — none of these sends a request)
  {
    name: 'POE_SESSION_BASELINE_MAX_AGE_MS',
    fallback: SESSION_BASELINE_MAX_AGE_MS_DEFAULT,
    // Refused below a minute: the history records at most one point a minute,
    // so a shorter bar refuses starts while the sync runs normally. Zero
    // likewise.
    zero: false,
    min: 60_000,
    integer: true
  },
  {
    name: 'POE_SESSION_RATE_MIN_MS',
    fallback: SESSION_RATE_MIN_MS_DEFAULT,
    // ZERO HONOURED: an hourly figure for every session, however short.
    zero: true,
    integer: true
  },
  {
    name: 'POE_SESSION_TOP_N',
    fallback: SESSION_TOP_N_DEFAULT,
    // ZERO HONOURED: no item lists; the totals do not depend on it.
    zero: true,
    integer: true,
    max: 20
  },
  {
    name: 'POE_SESSION_LIST_MAX',
    fallback: SESSION_LIST_MAX_DEFAULT,
    zero: false,
    min: 1,
    max: 200,
    integer: true
  },
  {
    name: 'POE_SESSIONS_KEEP',
    fallback: SESSIONS_KEEP_DEFAULT,
    // At least the default list length, so the page never lists fewer than it
    // promises.
    zero: false,
    min: 20,
    max: 5000,
    integer: true
  },
  {
    name: 'POE_SESSION_FINALIZE_MAX_MS',
    fallback: SESSION_FINALIZE_MAX_MS_DEFAULT,
    // A round is tab count × users × the sync interval; below an hour a normal
    // stash would be closed as unconfirmed before its round could finish.
    zero: false,
    min: 3_600_000,
    integer: true
  },
  {
    name: 'POE_SESSION_GAME_GAP_MS',
    fallback: GAME_GAP_MS_DEFAULT,
    // How long the game has to be reported not running before a game session
    // ends (networth/session-control.mjs). Refused below a minute, zero
    // included: the daemon reports a change of the game state at once (it
    // looks every 10 s by default) and beats every 60 s while the game runs,
    // so a shorter gap would end the evening at a game restart.
    zero: false,
    min: 60_000,
    integer: true
  },
  {
    name: 'POE_DAEMON_SESSION_MAX_PER_MIN',
    fallback: 10,
    // POST /daemon/session requests accepted per user in any sliding minute;
    // one more is answered 429. Each accepted start or end writes the
    // sessions file. Zero would refuse the session key altogether.
    zero: false,
    min: 1,
    max: 120,
    integer: true
  },

  // ---- The hotkey daemon's channel (memory and LAN only — none of these sends a request to GGG)
  // daemon-feed.mjs (GET /daemon/events) and daemon-presence.mjs
  // (POST /daemon/heartbeat); frontend/PROTOCOL.md describes both routes.
  {
    name: 'POE_DAEMON_POLL_MAX_HOLD_MS',
    fallback: 30_000,
    // The longest a GET /daemon/events is held open. ZERO HONOURED: every
    // request is answered at once, and the daemon then paces its own asking.
    // At most 55 s, under the usual reverse-proxy read timeout of 60 s: a hold
    // the proxy cuts is a poll that never answers.
    zero: true,
    max: 55_000,
    integer: true
  },
  {
    name: 'POE_DAEMON_EVENTS_KEEP',
    fallback: 100,
    // Events (and followed cards) kept per user. Fewer than 10 would drop a
    // card's own events before a daemon that is one request behind reads them.
    zero: false,
    min: 10,
    max: 10_000,
    integer: true
  },
  {
    name: 'POE_DAEMON_WAITERS_MAX',
    fallback: 4,
    // Held requests per user; one per daemon instance anyway. Zero would
    // answer every daemon 429.
    zero: false,
    min: 1,
    max: 32,
    integer: true
  },
  {
    name: 'POE_DAEMON_FEED_MAX_AGE_MS',
    fallback: 120_000,
    // How long a card is followed after its final state, and the age past
    // which no event reaches the game. Zero would forget every card at once.
    zero: false,
    min: 10_000,
    integer: true
  },
  {
    name: 'POE_DAEMON_BEAT_STALE_MS',
    fallback: 180_000,
    // After this long without a heartbeat a daemon counts as silent (three
    // missed beats at a minute). Under a minute a daemon beating once a minute
    // would flicker between known and unknown; zero always would.
    zero: false,
    min: 60_000,
    integer: true
  },

  // ---- Buyer whispers (memory only; pricing reads cached poe.ninja/Faustus data, never the trade API)
  // whisper-price.mjs (POST /daemon/whisper); frontend/PROTOCOL.md describes the route.
  {
    name: 'POE_WHISPER_KEEP',
    fallback: 50,
    // Whispers kept per user for the Price Check page. ZERO HONOURED: nothing
    // is kept for the page; the daemon still gets its answer, and a late
    // result still reaches the page and the daemon.
    zero: true,
    max: 1000,
    integer: true
  },
  {
    name: 'POE_WHISPER_PRICE_DEADLINE_MS',
    fallback: 3000,
    // How long the answer to a whisper waits for the market value; a later
    // result follows over the page and the daemon's feed. ZERO HONOURED: every
    // answer is 'pending' at once. Below the daemon's 5 s curl limit
    // (ppt_link.post_json timeout_s), so an answer within the deadline also
    // reaches the daemon over HTTP.
    zero: true,
    max: 4000,
    integer: true
  },
  {
    name: 'POE_WHISPER_MAX_PER_MIN',
    fallback: 60,
    // Whispers accepted per user in any sliding minute. Zero would refuse every one.
    zero: false,
    min: 1,
    max: 600,
    integer: true
  },
  {
    name: 'POE_WHISPER_LOW_RATIO',
    fallback: 0.85,
    // Your listed price below this share of the market value is 'below'.
    // Also the threshold of the Net Worth page's "Listed below market" block.
    // Zero would never say 'below'; above 1 a fair price would be 'below'.
    zero: false,
    min: 0.1,
    max: 1
  },
  {
    name: 'POE_WHISPER_HIGH_RATIO',
    fallback: 1.15,
    // Your listed price above this multiple of the market value is 'above'.
    // Below 1 a fair price would be 'above'.
    zero: false,
    min: 1,
    max: 10
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
