# Pricing logic — how the Net-Worth tracker values your stash

How each item category in `/networth.html` gets a chaos value, and why. For the
architecture around this (stores, background refreshers, envs), see
[docs/admin.md](admin.md). The history page's own guarantees are at the end of
this document. This document describes the **shipped** behaviour —
if it ever disagrees with the code, the code wins; please file that as a bug.

**Auth reality:** GGG's OAuth applications are closed to new developers, so
this tool never uses `account:*`/`service:*` scopes. Every price comes from
either a **public/CDN endpoint** (the Faustus currency-exchange feed,
poe.ninja) or the **POESESSID session cookie** (legacy stash read, official
Trade search) — the same two auth mechanisms the rest of the tool already
uses for the price check. There is no separate credential
for pricing.

**No manual scan.** The net-worth view is read-only: a 24/7 background
auto-sync walks your stash tabs and fills the store continuously (see
"Net-Worth-Tracker" in [docs/admin.md](admin.md)). Prices likewise arrive in
the background — Faustus refreshes hourly, corpses are priced a few names at
a time. There's nothing to click to "start" a valuation.

## Source-routing table

| Category | Primary source | Fallback(s) |
|---|---|---|
| Currency, Fragments, Essences, Scarabs, Fossils, Resonators, Oils, Delirium Orbs, Tattoos, Omens, Artifacts, Runegrafts, Allflame Embers, Astrolabes (stackables) | **Faustus** (GGG Currency Exchange) | poe.ninja `stash/current/currency/overview` (Currency/Fragment only, `chaosEquivalent`) → poe.ninja `exchange/current/overview` |
| Divination Cards | **Faustus** | poe.ninja `exchange/current/overview?type=DivinationCard` |
| Uniques (weapon/armour/accessory/flask/jewel/map) | poe.ninja `stash/current/item/overview` (`Unique{Weapon,Armour,Accessory,Flask,Jewel,Map}`) | — |
| Gems | poe.ninja `stash/current/item/overview?type=SkillGem` (level/quality/corrupted variant matching) | — |
| Beasts (Einhar captures) | poe.ninja `stash/current/item/overview?type=Beast` | — |
| Incubators | poe.ninja `stash/current/item/overview?type=Incubator` | — |
| Vials | poe.ninja `stash/current/item/overview?type=Vial` | — |
| Maven's Invitations | poe.ninja `stash/current/item/overview?type=Invitation` | — |
| Itemised corpses | **Official Trade API** (search + fetch, POESESSID-free/anonymous) | — |
| Rare/magic gear, non-unique maps | *(none — deliberately unpriced, see below)* | — |

Chaos Orb itself is hardcoded to `1` (it's the numeraire; it has no exchange
line of its own to look up).

Whichever source wins, `null` means **honestly unpriced** — the item is
excluded from the net-worth sum and shown in an "unpriced" bucket, never
silently counted as 0. The one hardcoded exception is documented below
(`Imperfect ` corpses).

## The price check follows the same order

The price-check card used to be trade-only for anything with listings, which
overstated fungibles badly: the trade site shows **asking** prices with huge
spreads, and for currency almost nobody lists in chaos, so a page full of
divine asks became the headline. Measured in Allflame (1 div = 106c): Valdo's
Puzzle Box asked 0.7–1 div (75–107c) against 56c on the in-game exchange,
Templar Astrolabe a flat 1 div (107c) against 45c — up to 2.4x too high.

So the card now uses the same order as the net-worth valuator: **if Faustus
knows the item, its rate is the price** — not "only for bulk items", not "only
when the trade search came back empty". The trade result keeps its listings
list and its "Open Trade" link, and its price is shown underneath as a
`Trade-Ask:` line (`withExchangeMain` in `backend/v2/server.mjs`). Items
Faustus doesn't quote — rares, uniques, gear — are untouched and stay
trade-priced.

## Faustus (GGG Currency Exchange) — the primary fungible source

Faustus is GGG's own in-game currency exchange, mirrored to a **public CDN
endpoint** (`https://web.poecdn.com/api/currency-exchange/<hour>`, no auth,
no rate-limit risk). It's the primary source for every fungible category
Faustus carries — poe.ninja becomes the fallback only for names Faustus
didn't happen to price in the current window.

- **Hourly, last-completed-hour.** `id` is a unix hour timestamp; the feed for
  the *current* (still-open) hour doesn't exist yet, so the client always
  requests `floor(now/3600)*3600 - 3600` (the last fully-closed hour).
- **Multi-hour union.** A single hour only contains markets that actually
  traded that hour — many fungibles (a specific essence tier, a rare oil)
  go quiet for stretches. The client walks back up to `POE_FAUSTUS_UNION_HOURS`
  (default 8) completed hours and unions them by market pair, newest hour
  wins on overlap. It also treats an unready hour (missing, empty `markets`,
  or `next_change_id` equal to the requested id — none of which GGG
  documents) as "step back one more hour," with a generous step-back budget
  so temporary gaps in the feed don't stall pricing.
- **Ratio → chaos: volume-weighted first, midpoint second.** Each market gives
  a `lowest_ratio`/`highest_ratio` pair (the hour's **extremes**, not
  percentiles) plus `volume_traded` for both sides. The primary estimator is
  the volume-weighted rate — quote-volume divided by X-volume, i.e. the average
  the hour actually traded at. The extremes midpoint is only the fallback.

  The order is load-bearing, not cosmetic. Measured over 703 chaos markets of a
  live digest, the median spread between the extremes is 2.0× and p90 is 5.0× —
  far too wide for a two-point mean to be the better number. Worse, the ratio
  fields are INTEGER pairs, so anything trading near or below one chaos is
  quantised into extremes that are far apart by construction (a ~1c Ducat came
  out at 0.33..2.0 and was rejected by the spread guard, then fell through to
  the trade-site ask and showed as 110c). Sanity-checked against the same
  digest: the volume-weighted rate fell inside the hour's own extremes band in
  700 of 700 markets that had usable volume.

  The client normalises pair order (GGG's internal hash order isn't
  lowest-first) and bridges anything that only trades against
  Divine Orbs through the live Divine:Chaos ratio (from the Divine↔Chaos
  Faustus market itself, falling back to the **shared currency-exchange
  Divine rate** — poe.ninja's `currencyoverview?type=Currency` divine line,
  the same value the price check and the net-worth aggregate both
  use — if that market is missing this window, never a hardcoded constant).
  This is the **one** Chaos:Divine value the whole tool shares, so no two
  subsystems (Faustus items, corpses, the aggregate sum) ever silently
  disagree on the exchange rate.
- **Quote-side volume floor.** A market only counts if its *quote*-side
  traded volume clears a floor: **50** on the chaos side, **10** on the divine
  side. The floor is one-sided on purpose — an expensive item legitimately
  trades only 1–3 units/hour while the chaos side is huge, so a floor on both
  sides would unprice exactly the high-value items. The divine floor was 2 and
  is 10 now: measured across a league's 74 divine-quoted markets in one hour the
  median volume was 5, so a floor of 2 admitted single trades — which is how one
  lone "2 divine for 30 regal" priced a Regal Orb at 5.67c.
- **Cross-hour sanity check on the direct chaos path.** The quote-side floor
  above is denominated in the quote currency, and how much quote currency
  moved depends on the very price under test — an inflated thin sample buys
  its own credibility. Live case: on 2026-08-05 the divination card *Broken
  Truce* traded 3 cards for 66 chaos in one hour (22c/card), clearing the
  50-chaos quote floor and the spread guard (a single ratio trivially agrees
  with itself) — poe.ninja said 6.4c, the trade-site ask was 1c/218 listings,
  and GGG's own in-game Currency Exchange showed "No Stock" for it. The hour
  immediately before, the same card traded 61 units for 346 chaos = 5.67c/card
  — 20× the volume, a fraction of the price.

  The fix: when the hour that produced a market's rate traded fewer than 10
  units of the item itself (**THIN_X_UNITS**, the same "one/two trades say
  nothing" floor the sell-side comparison already uses), and some other hour
  in the same union window traded at least 3× more of the item
  (**DEEP_HOUR_VOL_RATIO**) while itself clearing that same 10-unit floor, and
  the two hours' volume-weighted rates disagree by more than 2×
  (**DEEP_HOUR_DISAGREE_RATIO**), the thin hour's price is **discarded, not
  replaced** — the item falls through to the poe.ninja fallback rather than
  being priced from either hour.

  Discarding instead of preferring the deeper hour was a measured choice, not
  a default to "safe": over 302 thin-winning-hour Allflame divination-card
  samples (13 sliding union windows, live digests, checked against poe.ninja),
  this three-part gate fires 16 times, 15 of which have a winning-hour error
  ≥ 30 % (mean 366 %, up to 970 %) — but the deeper hour is not reliably
  better. It usually is (lower error in 14 of 16), except when it isn't:
  *Temperance*'s deeper hour (67 units) priced 179 % off poe.ninja against the
  thin hour's 39 % — replacing would have made that item *more* wrong. The two
  hours are two different real trades, not one true value and one error, and
  nothing in the digest itself says which is closer without an outside
  reference. Only 1 of the 16 firings (*Keeper's Corruption*, 9 % off) was a
  price that did not need discarding at all — an acceptable cost for zero
  chance of making a price worse.

  Requiring the deeper hour to *itself* clear THIN_X_UNITS (not just beat the
  thin hour proportionally) is what keeps this from becoming the two-sided
  floor the quote-volume-floor note above warns against: an item that trades
  1–3 units in *every* hour of the window never has a "deeper" hour to compare
  against, so the check never fires and the item keeps its price — confirmed
  against Mirror of Kalandra, Mirror Shard, The Doctor, The Apothecary,
  Awakener's Orb, Hinekora's Lock and Voidborn Reliquary Key across the same 13
  windows: unchanged in every one.
- **A worse-evidenced chaos market does not outrank a better-evidenced divine
  one.** The item's own chaos market normally wins. It stops winning when the
  divine market traded at least **3× as many units** of the item *and* is itself
  **attested** — attested meaning at least 10 traded units AND 5000 chaos of
  turnover on that side, the same bar the sell-side comparison uses. The bridged
  price still has to pass the envelope below.

  The comparison is *relative*. It used to be an absolute bar ("the chaos side
  traded fewer than 10 units"), which never asked which of the two sides was the
  better evidenced one. Measured over 102 anchor hours of digests (72.9k priced
  lines with a poe.ninja reference; the table is over the 2238 lines on which
  the variants disagree at all):

  | gate | median | mean | >50 % off | >100 % off | fires |
  |---|---|---|---|---|---|
  | no branch at all | 22.3 % | 24.8 % | 135 | 0 | 0 |
  | absolute, chaos < 10 units | 13.2 % | 16.0 % | 12 | 2 | 1402 |
  | **relative, divine ≥ 3× chaos** | **12.6 %** | **15.3 %** | **3** | **0** | 1750 |

  The factor 3 is a measured plateau, not a guess: every value from 2.25 to 6
  keeps the >100 % count at zero, below 2.25 those lines come back, and the
  >50 % count bottoms out exactly at 3.

  Live case: *The Progeny of Lunaris* had ONE chaos trade (1132c) beside a
  divine market of 40 cards steady at 12–13 div, and the single trade set the
  price — 6.4 div against a real ~12.4, while the in-game order book, the
  divine market and poe.ninja all agreed on 12. None of the other guards can
  see this: the volume floor measures the chaos QUOTE side, where one trade of
  an expensive item clears 50 effortlessly, and the spread guard cannot fire
  because a single trade has `lowest_ratio === highest_ratio`, which looks
  maximally consistent. Measured over a live digest, 19 of 38 dual-quoted cards
  were more than 25 % low and exactly 1 high — one-sided, and concentrated on
  the expensive names. Requiring attestation on the DIVINE side too is what
  keeps cheap cards out, where the coarse "1 div : N cards" quantisation makes
  the divine quote the worse number.

  Going relative fixed the case the absolute bar got backwards: *Desecrated
  Virtue* has a small chaos market (6 traded units) that is nevertheless
  near-perfect, spanning 220.0..221.0c, and the absolute gate threw it away for
  being small — 524c and 495c against a real ~240c. Its divine side carried 13
  and 12 units in those two hours, better evidenced than 6 but not 3× better, so
  the card now keeps its own price and both hours land at 8 % (item worst case
  118 % → 40 %). The wins of the absolute gate are unchanged: *The Progeny of
  Lunaris* stays at an item median of 7.5 % against 38.1 % without the branch,
  *The Apothecary* at 10.5 % against 26.5 %, and *The Immortal* improves further
  from 17.5 % to 11.6 %.

  Known limit, measured over the same 102 hours: *One Last Score* stays wrong.
  Its chaos market under-quotes in 91 of the 102 hours (median 131c, low 62c,
  against a real ~192c); item median 36.7 % → 34.6 %, worst case unchanged at
  67.5 %. Most of that is
  out of this rule's reach — in 38 of the 102 hours the card has no usable divine
  market at all (mean error 31 %), and nothing can bridge what does not exist. Of
  the 64 hours that do have one, the rule fires in 10 (mean error 23 %) and the
  chaos market keeps its underquote in the other 54 (mean error 32 %). A lower
  factor would catch more of those and cost *over*-quoted lines elsewhere
  (Tainted Exalted Orb 155c against 83c, Luminous Trove 183c against 110c) — the
  worse direction for a net-worth number, so the trade was declined. What remains
  wrong at factor 3 is one-sided and mild: three lines above 50 % in 102 hours,
  at most 64 % off, and all but one *under*-quoted.
- **Idle-hour placeholders are ignored.** GGG publishes entries with all ratios
  and volumes at zero for a pair that did not trade that hour. In the union walk
  such an entry used to shadow the real, older entry for the same pair — the
  market then looked unpriceable and, worse, lost the plausibility envelope
  described below, which let a single divine trade set the price. A market now
  only counts as "seen" if a ratio can be derived from it or it saw volume.
- **Bridged prices get a plausibility envelope.** If an item also has a chaos
  market, a divine-bridged price must land within 4× of the range that chaos
  market actually spanned — even when that market was itself too noisy to price
  from, it still pins the order of magnitude. Without a chaos market there is no
  envelope, so the bridge additionally requires more than one traded unit on the
  item's side; "10 divine of turnover" can be a single trade (one card sold for
  10 divine, while the card really goes for 1 chaos).

  On the *takeover* path above (the item has a chaos price, the divine side is
  better evidenced) the envelope is the range **all hours of the union window
  together** spanned, and a degenerate one is ignored. It used to be the newest
  informative hour alone, and that made it worthless exactly there: in 926 of
  1402 firings `min === max`, i.e. the "range" was a single chaos trade and the
  accepted band `[p/4, p×4]` a 16× hole. Worse, it was the very trade the gate
  had just called under-evidenced, vetoing its own replacement — and all 8
  rejections it made over 102 hours were wrong, each keeping a chaos price
  72–89 % off and discarding a bridge 4–27 % off (The Fiend kept 121c where the
  bridge said 1059c and the real price was 1107c; Omen of Fortune 500c against
  ~2450c bridged and 3093c real). Unioning the walked hours gives it a real
  range wherever one exists: 1474 of 1750 firings are now checked against a
  genuine multi-hour band, and in the remaining 276 even eight hours collapse to
  a single point, where the check abstains rather than veto on one trade. Worth
  mean 15.1 % → 13.8 % and 10 → 2 lines above 50 % on the disagreeing lines, and
  it drops the wrong rejections to zero.

  The 4× tolerance stays. Tightening it was measured and is worse in both the
  old and the new shape, because a bridged price legitimately sits *above* the
  chaos market — over the 2036 rows the rule fires on, bridged/chaos has a median
  of 1.20 (p10 1.01, p90 1.89). With the multi-hour envelope, tolerance 3 gives
  4 lines above 50 % and tolerance 2 gives 11, against 2 at tolerance 4.
  The purely bridged path (no chaos price at all) keeps the **single-hour**
  envelope: over the same 102 hours widening it, tightening it, or removing it
  produced byte-identical output, so there is no measurement that would justify
  weakening the guard that caught the Regal Orb case.
- **Spread guard.** If the two implied rates (from `lowest_ratio` and
  `highest_ratio`) differ by more than 4×, the hour is rejected as
  outlier-skewed (a single troll trade shouldn't set the price).
- **Local persistence.** GGG deletes old Faustus history, so the derived
  name→chaos map is persisted to `/config/faustus-store.json`
  (`POE_FAUSTUS_STORE`) and reloaded on boot — valuation works immediately
  after a restart instead of waiting for the first hourly refresh.
- **Staleness gate.** The whole store carries a single `updatedAt`. If it goes
  older than `POE_FAUSTUS_TTL_MS` (default ~48h — generous, since the refresh
  is hourly and unions several completed hours), the valuator treats Faustus as
  absent and falls through to poe.ninja instead of serving a silently-frozen
  map forever. This is the safety net for the undocumented CDN feed breaking
  without any error.

Ratio semantics are not officially documented by GGG; the derivation above
was reverse-engineered empirically and is pinned by `faustus.test.mjs`.

## Metadata-ID → name bridge (RePoE, build-time)

Faustus keys everything by GGG's internal Metadata-ID
(`Metadata/Items/Currency/CurrencyRerollRare`), not the display name the
rest of this tool works with. The bridge is generated at **build time** from
RePoE's `base_items.json` (`backend/v2/base-names-gen.mjs`) and checked in as
`backend/v2/networth/base-names.json` — no network call at runtime.

- Only `release_state === 'released'` entries are kept, and known
  non-priceable prefixes are dropped (`MicrotransactionCurrency`,
  `QuestItems`, `Classic`, `Hideout`, `Masters`, `TradeProxy`,
  `NecropolisPacks`), along with entries whose name is empty (RePoE's
  ~420 `RandomFossilOutcome*` placeholders).
- **Oils are `Metadata/Items/Currency/Mushrune*`**, not `*Oil*` — easy to get
  wrong by guessing the id pattern instead of reading RePoE.
- **Fossils are `Metadata/Items/Currency/CurrencyDelveCrafting*`.**
- **Atlas-mission Astrolabes** (`Metadata/Items/Currency/Astrolabe*`, e.g.
  `AstrolabeGeneric` = "Templar Astrolabe") are **not in RePoE at all**, so
- Any Faustus-priced Metadata-ID with no entry in this map is logged (by its
  `Metadata/Items/<segment>/` prefix) as a coverage gap rather than silently
  dropped, so a renamed/new item path surfaces in the logs instead of just
  vanishing from pricing.

Regenerate with `node backend/v2/base-names-gen.mjs` (network required) and
commit the resulting `base-names.json`.

## poe.ninja `count` confidence filter

poe.ninja's `stash/current/item/overview` lines are a mix of solid and
paper-thin sample sizes. The site itself greys out (and hides by default)
"low confidence" rows — the per-line `count` (sample size) is that signal,
and it is **not** the same as `listingCount` (visible listings), which does
not catch manipulated/troll prices. Real examples that motivated this
filter: a level-20/0%-quality **Bear Trap** at 369,000 chaos with
`listingCount: 21` but `count: 3`, and **Soulwrest** (realistically ~5c) at
1.8M chaos with `count: 1`.

The valuator requires `count >= 5` before a line can win a match (uniques and
gems both go through this gate). A name/variant that only clears low-count
lines falls through to honestly-unpriced rather than reporting a fake price.
This does not apply to Faustus or the exchange-overview routes, which use a
different (volume-based) confidence mechanism — see above.

## poe.ninja exchange volume floor

The `exchange/current/overview` routes (used for divination cards and as the
stackable fallback) have no `count`. They carry `volumePrimaryValue` — that
line's traded volume expressed in chaos — so `volumePrimaryValue / primaryValue`
is the number of ITEMS behind the price. A line may win by clearing EITHER of
two floors: **10 traded units** (`MIN_EXCHANGE_UNITS`, the same bar
`backend/v2/sell-side.mjs` uses for the reference rail) or **2000 chaos of
turnover** (`MIN_EXCHANGE_TURNOVER_C`).

The case that motivated replacing an earlier 0.5-unit floor: **The Trial** was
listed at 1359c off a volume of 906, i.e. 0.67 units — two thirds of a single
card traded in the whole window, enough under the old floor to enter a stash at
7 divine per card.

Why two floors and not just the unit count: a flat item count punishes
expensive items systematically. **Father's Love** trades only ~4 times in the
window while moving 41 607 chaos, because one card costs ~44 divine. A
unit-only floor blanked exactly those lines — the same failure the
`QUOTE_VOL_MIN` comment in `faustus.mjs` warns about ("an expensive X
legitimately trades 1-3/hour while the chaos side is huge"). Units cannot tell
"few trades because nobody wants it" from "few trades because each one is
expensive"; total chaos moved can.

The turnover floor may never vouch for a line **alone**, because turnover is
units × price and the price is the number under test — an inflated price
manufactures the turnover that backs it. The Trial at 1359c/0.67 units yields
906 and is rejected, but the same 0.67 units at an inflated 3000c would yield
2010 and pass. So the turnover branch additionally requires at least one
COMPLETED trade (`MIN_EXCHANGE_TURNOVER_UNITS`). This is the same structural
disease the cross-hour check above was built for.

Measured live (Allflame, 916 lines across ten types): 189 lines fail the unit
floor, 9 of them are rescued by turnover — Father's Love (8608c/41 607),
The Miracle (3020c/11 074), Lucky Bastion (1918c/15 348), Pearls Before Swine,
Choking Guilt, Brother's Gift, Outfoxed, Journey Tattoo of the Mind, Runegraft
of the Angler. The most expensive line still rejected is The Sacrifice at 200c
off 33 chaos of turnover — a fraction of one trade, the same shape as The
Trial. Bulk markets are untouched: across Currency/Fragment/Scarab/Fossil/Oil
essentially no genuinely liquid line falls below 10 units.

## Unique variants — matched by mod text, not by the variant string

poe.ninja lists a variant-carrying unique once per variant, and the item side of
the API gives no variant id. Its `variant` string is unusable as a key: a live
overview carried 399 distinct spellings for what are only a handful of real
variants.

So the valuator matches on the **mod texts** instead. Every mod line of the
stash item and of the candidate ninja line is normalised — numbers and ranges
collapse to `#` — and the line whose mod shape fits best wins; a roll that falls
outside a candidate's range disqualifies it. 143 of 1389 unique names in a live
overview are variant-carrying, so this is not an edge case. It fixed e.g.
**Foulborn Soul Tether**, which was valued at 5 divine off the wrong variant and
is really worth about 2 chaos.

Unique **maps** are priced too (`UniqueMap`), with the map tier taken into
account — some are genuinely expensive, and leaving them unpriced understated
the stash.

## Itemised corpses — Trade API

poe.ninja and Faustus don't carry itemised corpses (e.g. "Perfect Forest
Tiger", "Pain Artist"), so they're the one category priced via the official
**Trade API** instead of a bulk feed.

- **`Imperfect ` corpses are hardcoded to `each = 0`, no query.** This is a
  **stated assumption** (Imperfect corpses are effectively worthless on the
  live market), not an observed price — it is the *one* documented exception
  to "null, never a silent 0" anywhere in this tool.
- Everything else: an **anonymous** trade search (`type: <corpse name>`,
  `status: online`, `sale_type: priced`, sorted by price ascending), fetch
  the cheapest results (≤10), normalise each buyout to chaos (chaos 1:1;
  divine via the same shared currency-exchange Chaos:Divine rate the Faustus
  bridge and the aggregate use — any other listed currency, e.g. exalted or
  mirror, is discarded rather than risk mis-booking it as chaos), then
  **average the 5 cheapest** normalisable
  buyouts. Fewer than 5 results → average of what exists. Zero results →
  `null`.
- **Both prices and nulls are cached** in `/config/corpse-store.json`
  (`POE_CORPSE_TTL_MS`, default ~6h) — corpses move slowly, and without
  caching *nulls* too, every snapshot would re-fire a search for every
  illiquid corpse name.
- Pricing happens entirely **in the background**: a pricer ticks one corpse
  name at a time (`POE_CORPSE_INTERVAL_MS`), picking the stalest/never-priced
  name first, capped at `POE_CORPSE_BUDGET_PER_HOUR` (default 25) distinct
  names/hour so the ~70 possible first-snapshot queries never burst. The
  valuation route itself only ever *reads* the store — it never queries the
  Trade API inline.
- Queries run at **background priority** on the same shared `RateLimiter`
  queue the price check uses — manual price checks and
  pasted items always go first; corpse pricing never blocks them.
- **Self-healing ban backoff.** Corpse searches are anonymous (no
  POESESSID), so the failure mode isn't an expired cookie — it's an
  IP-side GGG soft-ban (HTTP 403), a Cloudflare HTML challenge (surfaces as
  an unparseable JSON body), or a run of repeated 429s. Any of those trips a
  cooldown (12min base, exponentially escalating up to 1h on repeat trips)
  during which corpse trade calls short-circuit without touching the
  network at all; the first success afterwards clears the streak
  automatically — no restart or manual reset needed. A single transient 429
  does not trip it; the shared RateLimiter already handles ordinary backoff.

## History: what a recorded point is protected against

The value-over-time series on `/history.html` is recorded from the same
valuation, but it does not record it blindly.

**Implausible price jumps are held back.** A jump has to clear BOTH bars to
count as implausible: the unit price grew at least **20×** AND the resulting
gain is at least **25 %** of the previous total. Then the point is recorded at
the item's previous unit price, the point's total is corrected by the same
amount, and a log line names the item, both prices, the factor, the quantity
and the share. If the high price holds for 6 hours it is accepted after all
(also logged) rather than freezing the series forever.

This exists because of a real incident: **The Scavenger**, a 1-chaos divination
card on an unchanged stack of one, was recorded at 174,039c — exactly 1000
divine at that hour's rate, twelve times the whole account — and fell back 40
minutes later. Neither Faustus (the card is below the volume floor in every
recoverable hourly digest) nor poe.ninja (1c) carries a number anywhere near it,
and the container had been rebuilt, so the log of that night was gone. The brake
guards the series; the log line is what makes the cause findable next time.

**Already-recorded artefacts are removed on load.** A stretch that rises to at
least 5× the level before it, comes back down to near that level, is shorter
than 6 hours, and is explained by NO stock movement, is dropped and the file
rewritten. The last condition is the one that matters: real wealth arrives as
stock — items come in, items go out, and the stored delta says so. A price
artefact rises and falls with the stock untouched. A jump that stays up is
someone getting richer and is never touched.

**Events are stock movements only.** The list next to the chart counts a row
when its QUANTITY changed; pure price moves are in the curve's height, not in
the list. A movement is valued at its unit price (`dv - priceShare`), not at the
whole value change, and must be worth at least **1 divine** by default — the bar
is settable in the rail from "everything recorded" to 10 divine.

## What's deliberately left unpriced

- **Rare/magic gear and gems** below the priceable rarity aren't in scope —
  poe.ninja doesn't carry a reliable rare-gear price feed, and mod-rolling
  makes bulk pricing meaningless without a build-aware appraiser.
- **Non-unique maps** (white/magic/rare) — same reasoning as rare gear.
- **Cluster Jewels.** They used to be valued through a poe.ninja ClusterJewel
  route that came with the Cluster Crafter; both were removed, so cluster jewels
  now land in the unpriced bucket like rare gear.
- **IncursionTemple items (Chronicle of Atzoatl)** and **Memory items** have
  no classifier at all today — they fall through to the generic
  `unknown`/`skip` bucket. Nothing routes them to a price source yet.

None of these are silently counted as 0 — they land in the same honest
"unpriced" bucket as any name that misses every source above.
