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
Trade search) — the same two auth mechanisms the price check uses. There is no
separate credential for pricing.

**No manual scan.** The net-worth view is read-only: a 24/7 background
auto-sync walks your stash tabs and fills the store continuously (see
"Net-Worth-Tracker" in [docs/admin.md](admin.md)). Prices likewise arrive in
the background — Faustus refreshes hourly, corpses are priced a few names at
a time. There's nothing to click to "start" a valuation.

## Source-routing table

| Category | Primary source | Fallback(s) |
|---|---|---|
| Currency, Fragments, Essences, Scarabs, Fossils, Resonators, Oils, Delirium Orbs, Tattoos, Omens, Artifacts, Runegrafts, Allflame Embers, Astrolabes (stackables) | **Faustus** (GGG Currency Exchange) | poe.ninja `exchange/current/overview` → poe.ninja `stash/current/currency/overview` (Currency, then Fragment; `chaosEquivalent`, an exact `1.0` is treated as a placeholder and rejected) |
| Divination Cards | **Faustus** | poe.ninja `exchange/current/overview?type=DivinationCard` |
| Uniques (weapon/armour/accessory/flask/jewel/map) | poe.ninja `stash/current/item/overview` (`Unique{Weapon,Armour,Accessory,Flask,Jewel,Map}`) | — |
| Gems | poe.ninja `stash/current/item/overview?type=SkillGem` (level/quality/corrupted variant matching) | — |
| Beasts (Einhar captures) | poe.ninja `stash/current/item/overview?type=Beast` | — |
| Incubators | poe.ninja `stash/current/item/overview?type=Incubator` | — |
| Vials | poe.ninja `stash/current/item/overview?type=Vial` | — |
| Maven's Invitations | poe.ninja `stash/current/item/overview?type=Invitation` | — |
| Itemised corpses | **Official Trade API** (search + fetch, POESESSID-free/anonymous) | — |
| Rare/magic gear, non-unique maps | *(none — deliberately unpriced, see below)* | — |

Chaos Orb itself is hardcoded to `1` (the numeraire; it has no exchange line of
its own). Divine Orb is the one stackable that does not start at Faustus: the
whole UI converts chaos into divine with the C:D rate of the poe.ninja exchange,
so the Divine Orb row asks that exchange first (`source: exchange`) and only
falls back to the normal chain if the exchange has no line for it; through
Faustus (the in-game rate, which differs) one Divine Orb would not be 1 div.

**How old a poe.ninja price may be.** The stackables' poe.ninja stage reads one
merged map of the 14 exchange overview types; that map lives at most
`POE_NINJA_MAP_TTL_MS` (default 1 h) and is never kept when it is empty or a
type did not load, so it is rebuilt on the next valuation. When poe.ninja stops
answering, every poe.ninja stage keeps serving its last good answer, but only up
to `POE_NINJA_MAX_AGE_MS` (default 24 h) after poe.ninja gave it; past that the
item is unpriced (or falls through to the next stage). The status line on every
page names a price source that is getting old (`docs/admin.md`, Sources).

Whichever source wins, `null` means **honestly unpriced** — excluded from the
net-worth sum and shown in an "unpriced" bucket, never silently counted as 0.
The one hardcoded exception is documented below (`Imperfect ` corpses).

### Thresholds measured on a recording

`backend/v2/networth/recorded-thresholds.test.mjs` measures these thresholds
again on the recording of 2026-11-03 (`backend/v2/fixtures/2026-11-03/`), each
between a market that trips it and one that does not; the rules are below.

| threshold (section) | value | what the recording shows |
|---|---|---|
| quote floor (Faustus, "Quote-side volume floor") | 50 chaos / 10 divine of quote volume in the hour | 49 chaos in an hour are rejected and 50 priced, 9 divine rejected and 10 priced |
| `THIN_X_UNITS` (Faustus, "Cross-hour sanity check on the direct chaos path") | fewer than 10 units of the item in the winning hour | pinned exactly: a 9-unit hour 3.56× away from a 51-unit hour is discarded, a 10-unit hour 2.23× away from a 62-unit hour keeps its price |
| `DEEP_HOUR_DISAGREE_RATIO` (same) | rates more than 2× apart | the bar sits between 1.98× and 2.02×: one resonator 2.02× away from a 17-unit hour is discarded, a card 1.98× away from a 129-unit hour keeps its price |
| `DEEP_HOUR_VOL_RATIO` (same) | the other hour traded at least 3× the units | only bracketed between 2.75× and 3.75×, because the recording has nothing closer: a 4-unit hour beside a 15-unit one is discarded, one beside an hour 2.75× deeper keeps its price; a 16-unit hour and a deepest hour of 7 units keep their price as well |
| takeover units (Faustus, "A worse-evidenced chaos market does not outrank a better-evidenced divine one") | divine side traded at least 3× the chaos side's units | exactly 3× the units bridges and 2.8× does not |
| takeover turnover, `isTurnoverAttested` (same) | at least 5000 chaos of divine-side turnover | 5504 chaos of divine turnover bridges and 3931 does not |
| `count` (poe.ninja `count` confidence filter) | `count >= 5` | count-4 lines (a Vaal Clarity at 238.6c, a unique map) are passed over, count-5 lines are priced, and a 64,016c Heavy Strike off count 2 is never a price |
| `MIN_EXCHANGE_UNITS` (poe.ninja exchange volume floor) | 10 traded units | 9.50 units are rejected and 10.33 priced |
| `MIN_EXCHANGE_TURNOVER_C` (same) | 2000 chaos of turnover | 1937 chaos of turnover is short and 3201 enough |
| `MIN_EXCHANGE_TURNOVER_UNITS` (same) | one completed trade behind a turnover pass | 0.83 units are rejected even behind 22,341 chaos |

## The price check follows the same order

The price-check card uses the same order as the net-worth valuator: **if Faustus
knows the item, its rate is the price** — not "only for bulk items", not "only
when the trade search came back empty". The trade site shows **asking** prices
with huge spreads, and for currency almost nobody lists in chaos, so divine asks
would set the headline (up to 2.4x too high, measured in Allflame:
[pricing-measurements.md](pricing-measurements.md#price-check-and-poeninja-lines)).
The trade result keeps its listings list and its "Open Trade" link, and its
price is shown underneath as a `Trade-Ask:` line (`withExchangeMain` in
`backend/v2/server.mjs`). Items Faustus doesn't quote — rares, uniques, gear —
stay trade-priced.

### What each number on the card is, and why three cards can look different

| on the card | where it comes from | what it is |
|---|---|---|
| the headline + `EXCHANGE` | Faustus | the **volume-weighted average of the trades that matched** in one digest hour. Between the sell and the buy side, never a side of its own |
| `rate is N h old` | Faustus | how old that hour is. **Only shown past the unavoidable lag** — a fresh price says nothing, because a label on every card stops being read |
| `that hour L–H c` | Faustus | the low and high of **that one hour**, not the span of the hours the union walk searched. The headline is that hour's average, so it lies inside this |
| `Trade-Ask: … · N listings` | official Trade API | what sellers are **asking**, the cheapest offers this search fetched. Not a price anything sold at |

Which shape a card takes follows the source order, and each shape names its
source: **`EXCHANGE`** — Faustus has a rate for the item, inside the age gate;
**poe.ninja label** — Faustus has none, but the item is in `NINJA_BULK_CLASSES`
and poe.ninja carries it (a single aggregated value, no listings to count);
**`TRADE`** — neither did: the trade site's own offers, listed one by one
below. *The Trial* lands at `TRADE`: its poe.ninja line is rejected by the
exchange volume floor (1359c off 906 chaos of turnover, 0.67 units — see below)
and Faustus does not price it either.

### The early answer for the game

When a hotkey daemon that reads its feed (`GET /daemon/events`,
`backend/v2/frontend/PROTOCOL.md`) posts an item Faustus knows, `POST /item`
(`backend/v2/server.mjs`) also puts the Currency Exchange rate already held into
that daemon's feed, marked `price.early`, before the card is searched: the same
functions with the same league, freshness and age guards the queued job reads
first (`faustusChaosFor`, `faustusRangeFor`, `faustusStaleHoursFor`), never a
request, and replaced by the job's own result. Both round alike (`roundExchange`
in `backend/v2/ninja.mjs`: three significant digits below 1 c, one decimal
above). The browser card stays `queued` until the job runs; when the rate
changes in between, the game sees two numbers in turn.

## Faustus (GGG Currency Exchange) — the primary fungible source

Faustus is GGG's own in-game currency exchange, mirrored to a **public CDN
endpoint** (`https://web.poecdn.com/api/currency-exchange/<hour>`, no auth,
no rate-limit risk). It's the primary source for every fungible category it
carries; poe.ninja is the fallback for names Faustus didn't price in the current
window. Ratio semantics are not officially documented by GGG; the derivation
below was reverse-engineered empirically and is pinned by `faustus.test.mjs`.
The measurements behind the values are in
[pricing-measurements.md](pricing-measurements.md#faustus).

- **Hourly, last-completed-hour.** `id` is a unix hour timestamp; the feed for
  the *current* (still-open) hour doesn't exist yet, so the client always
  requests `floor(now/3600)*3600 - 3600` (the last fully-closed hour).
- **Multi-hour union.** A single hour only contains markets that traded that
  hour, so the client walks back up to `POE_FAUSTUS_UNION_HOURS` (default 8)
  completed hours and unions them by market pair, newest hour wins on overlap.
  An unready hour (missing, empty `markets`, or `next_change_id` equal to the
  requested id — none of which GGG documents) counts as "step back one more
  hour," with a generous step-back budget so gaps in the feed don't stall
  pricing.
- **Idle-hour placeholders are ignored.** GGG publishes entries with all ratios
  and volumes at zero for a pair that did not trade that hour; one would shadow
  the real, older entry in the union walk. A market only counts as "seen" if a ratio can be derived from
  it or it saw volume.
- **Ratio → chaos: volume-weighted first, midpoint second.** Each market gives
  a `lowest_ratio`/`highest_ratio` pair (the hour's **extremes**, not
  percentiles) plus `volume_traded` for both sides. The primary estimator is
  quote-volume divided by X-volume, the average the hour actually traded at;
  the extremes midpoint is only the fallback, because the extremes lie far apart
  and the ratio fields are INTEGER pairs, which quantise anything trading near
  or below one chaos. Pair order is normalised (GGG's internal hash order isn't
  lowest-first). Anything that only trades against Divine Orbs is bridged
  through the live Divine:Chaos ratio from the Divine↔Chaos Faustus market,
  falling back to the **shared currency-exchange Divine rate** (poe.ninja's
  `currencyoverview?type=Currency` divine line, the value the price check and
  the net-worth aggregate use) when that market is missing this window, never a
  hardcoded constant. This is the **one** Chaos:Divine value the whole tool
  shares, so Faustus items, corpses and the aggregate sum never disagree on it.
- **Spread guard.** If the two implied rates (from `lowest_ratio` and
  `highest_ratio`) differ by more than 4×, the hour is rejected as
  outlier-skewed (a single troll trade shouldn't set the price).
- **Quote-side volume floor.** A market only counts if its *quote*-side
  traded volume clears **50** on the chaos side, **10** on the divine side.
  One-sided on purpose: an expensive item legitimately trades only 1–3
  units/hour while the chaos side is huge, so a floor on both sides would
  unprice exactly the high-value items.
- **Cross-hour sanity check on the direct chaos path.** How much quote currency
  moved depends on the price under test, so an inflated thin sample buys its
  own credibility. When the hour behind a market's rate traded fewer than 10
  units of the item (**THIN_X_UNITS**, the sell-side comparison's floor), some
  other hour of the window traded at least 3× more (**DEEP_HOUR_VOL_RATIO**)
  while itself clearing 10 units, and the two volume-weighted rates disagree by
  more than 2× (**DEEP_HOUR_DISAGREE_RATIO**), the thin hour's price is
  **discarded, not replaced** — the item falls through to poe.ninja. Because
  the deeper hour must *itself* clear THIN_X_UNITS, an item that trades 1–3
  units in *every* hour keeps its price; this is not a two-sided floor.
- **A worse-evidenced chaos market does not outrank a better-evidenced divine
  one.** The item's own chaos market wins unless the divine market traded at
  least **3× as many units** of the item *and* moved at least **5000 chaos of
  turnover** on that side (`isTurnoverAttested`, the sell-side comparison's bar
  **without its companion 10-unit floor**, which punishes whatever is
  expensive); the bridged price still has to pass the envelope below. The other
  guards cannot see a single chaos trade beside a deep divine market: one trade
  of an expensive item clears 50 chaos, and the spread guard cannot fire on
  `lowest_ratio === highest_ratio`. Requiring attestation on the DIVINE side
  too keeps cheap cards out, where the coarse "1 div : N cards" quantisation
  makes the divine quote the worse number.
- **Bridged prices get a plausibility envelope.** If an item also has a chaos
  market, a divine-bridged price must land within 4× of the range that chaos
  market spanned — even a market too noisy to price from pins the order of
  magnitude. On the takeover path the envelope is the range **all hours of the
  union window together** spanned, and a degenerate one (`min === max`) is
  ignored: the check abstains rather than veto on one trade. The purely bridged
  path (no chaos price at all) keeps the **single-hour** envelope. Without a
  chaos market there is no envelope, so the bridge requires more than one traded
  unit on the item's side; "10 divine of turnover" can be a single trade (one
  card sold for 10 divine, while the card really goes for 1 chaos).
- **What the number MEANS: a matched-trade average, not a market side.** Both
  estimators come from `volume_traded`, i.e. trades that filled. Neither the
  Faustus digest nor poe.ninja's `exchange/current/overview` carries a bid and
  an ask, so nothing this tool fetches can reproduce the in-game window's two
  sides ("I have X, I want Chaos" against "I want X, I have Chaos"); a Faustus
  rate sits *somewhere between* them, and the tool claims nothing else. A
  liquidation discount is **not** built: the measurement refutes it as the
  dominant effect ([pricing-measurements.md](pricing-measurements.md#faustus),
  row "no liquidation discount"). The residual side bias is real but smaller
  than, and of inconsistent sign against, the effect below; `docs/bugs.md` B17
  says what would settle it.
- **NOTHING here knows whether anybody is BIDDING, and that is the largest
  pricing error this tool knows of.** `volume_traded` — and everything derived
  from it, `detail.sell` included — describes trades that **filled**;
  `sell.chaos` and `sell.divine` are two *markets*, not a bid and an ask, and no
  field carries open orders or stock. Reading the order book would mean a third
  request against GGG for every name, which this tool does not spend. Measured
  on 2026-08-13 (Allflame, four cards,
  [pricing-measurements.md](pricing-measurements.md#no-bid-on-the-in-game-exchange)):
  where a bid exists the tool lands at 0.9–1.4x of it, where the exchange says
  "No Stock" **30–70x** high. The quote-volume floor (50 chaos in ONE of the
  eight walked hours) is the only absolute bar, and the cross-hour check only
  *starts* below ten PIECES, which a cheap item clears with 0.8 chaos of
  merchandise: **a market that stopped trading keeps the last price at which
  somebody's order was filled**, indistinguishable from a rare item that trades
  once a day. **No threshold was invented for it** (four cards bound only the
  wrong side, a bar between them would be a guess); the defect, the two refused
  candidate fixes and the store dump that decides between them are in
  `docs/bugs.md` B20.
- **How OLD the number is — carried per item, and gated.** The union walk takes
  the newest hour in which each market was informative, so **two prices written
  by the same refresh tick can be hours apart**; the store's `updatedAt` says
  when the refresher ran. `detail.at` records the unix hour a price was
  **observed** in — for a divine-bridged price the divine market's hour — per
  item (`hours` in the store, additive, no schema bump).
  `backend/v2/networth/faustus-age.mjs` reads it for the card's age label and
  for **the age gate**: an observation older than `POE_FAUSTUS_MAX_AGE_HOURS`
  (default 6, counted from the END of its digest hour) is not served as a
  current price; the item takes the poe.ninja fallback of a name Faustus never
  quoted (no extra request: those overviews are cached ≥15min per
  league|type), else it is honestly unpriced. Card and net-worth valuator apply
  the identical gate. The default is a **judgement bounded on the conservative
  side**, not a measurement; it sits **inside** the 8-hour union window, so it
  only redirects to a fallback and never shortens the walk (lowering
  `POE_FAUSTUS_UNION_HOURS` would be the wrong dial: those hours get a thin
  market a rate at all). `lastHour` is already up to an hour behind and the
  refresher ticks hourly, so **no served price is ever fresher than one digest
  hour plus one refresh interval**; the gate is floored there in code.
- **Local persistence.** GGG deletes old Faustus history, so the derived
  name→chaos map is persisted to `/config/faustus-store.json`
  (`POE_FAUSTUS_STORE`) and reloaded on boot; valuation works right after a
  restart.
- **Staleness gate.** The whole store carries a single `updatedAt`. If it goes
  older than `POE_FAUSTUS_TTL_MS` (default ~48h — generous, since the refresh
  is hourly and unions several completed hours), the valuator treats Faustus as
  absent and falls through to poe.ninja instead of serving a silently-frozen
  map forever — the safety net for the undocumented CDN feed breaking without
  any error.

## Metadata-ID → name bridge (RePoE)

Faustus keys everything by GGG's internal Metadata-ID
(`Metadata/Items/Currency/CurrencyRerollRare`), not the display name the rest of
this tool works with. The bridge is built from RePoE's `base_items.json`
(`backend/v2/base-names-gen.mjs`). The copy checked in as
`backend/v2/networth/base-names.json` is the starting value; the data
auto-update (`backend/v2/data-refresher.mjs`) checks
`repoe-fork.github.io/base_items.json` once a day with a conditional request
(ETag) and adopts a validated result into `/config/data-refresh`. It takes
effect at once (the running Faustus pricer swaps the map in, used from its next
hourly run) and is read from there at every boot. A download that does not
validate (not an object, no `Metadata/` ids, implausibly shrunk) is rejected and
the previous map stays. See "Data auto-update" in [docs/admin.md](admin.md).

- Only `release_state === 'released'` entries are kept; known non-priceable
  prefixes (`MicrotransactionCurrency`, `QuestItems`, `Classic`, `Hideout`,
  `Masters`, `TradeProxy`, `NecropolisPacks`) and entries whose name is empty
  (RePoE's ~420 `RandomFossilOutcome*` placeholders) are dropped.
- **Oils are `Metadata/Items/Currency/Mushrune*`**, not `*Oil*`; **Fossils are
  `Metadata/Items/Currency/CurrencyDelveCrafting*`** — read RePoE, don't guess
  the id pattern.
- **Atlas-mission Astrolabes** are `Metadata/Items/Currency/Astrolabe*` (e.g.
  `AstrolabeAbyss` = "Lightless Astrolabe"); the `repoe-fork` export carries
  them, the older `lvlvllvlvl/RePoE` mirror (last updated 2024) does not.
- Any Faustus-priced Metadata-ID with no entry in this map is logged (by its
  `Metadata/Items/<segment>/` prefix) as a coverage gap rather than silently
  dropped, so a renamed/new item path surfaces in the logs.

The CLI is the manual route: `node backend/v2/base-names-gen.mjs` (network
required) rewrites `base-names.json` in the repository, falling back to the
stale mirror with a loud warning when the fork is unreachable; the auto-update
has no such fallback and keeps the previous map instead.

## poe.ninja `count` confidence filter

poe.ninja's `stash/current/item/overview` lines are a mix of solid and
paper-thin sample sizes. The site greys out (and hides by default) "low
confidence" rows; the per-line `count` (sample size) is that signal, and it is
**not** `listingCount` (visible listings), which does not catch
manipulated/troll prices (a Bear Trap at 369,000 chaos with `listingCount: 21`
had `count: 3`,
[pricing-measurements.md](pricing-measurements.md#price-check-and-poeninja-lines)).
The valuator requires `count >= 5` before a line can win a match (uniques and
gems both go through this gate); a name/variant that only clears low-count lines
falls through to honestly-unpriced. Faustus and the exchange-overview routes use
the volume-based mechanisms above and below instead.

## poe.ninja exchange volume floor

The `exchange/current/overview` routes (divination cards, stackable fallback)
have no `count`; their `volumePrimaryValue` is the line's traded volume in
chaos, so `volumePrimaryValue / primaryValue` is the number of ITEMS behind it. A line may win by clearing EITHER of
two floors: **10 traded units** (`MIN_EXCHANGE_UNITS`, the same bar
`backend/v2/sell-side.mjs` uses for the reference rail) or **2000 chaos of
turnover** (`MIN_EXCHANGE_TURNOVER_C`). The turnover floor exists because a flat
item count punishes expensive items (the `QUOTE_VOL_MIN` comment in
`faustus.mjs`: "an expensive X legitimately trades 1-3/hour while the chaos side
is huge"). It may never vouch for a line **alone**, because turnover is units ×
price and the price is the number under test, so the turnover branch also
requires at least one COMPLETED trade (`MIN_EXCHANGE_TURNOVER_UNITS`) — the same
disease the cross-hour check above was built for.

The unit count is a quotient of two rounded numbers (at most 2 decimals between
1 and 100), so a line within about 0.01 of 10 units cannot be placed on either
side of the floor; the floor holds for the numbers as stated, and Deafening
Essence of Torment at 9.995 units stays unpriced, because an unpriced line falls
back to the next source and a wrong price does not. A count that misses a floor
only by floating-point error reaches it (`reachesFloor` in
`backend/v2/sell-side.mjs` allows a billionth of the floor), so Jagged Fossil,
whose 200.1 / 20.01 computes to 9.999999999999998, is priced at exactly 10
units (B36 in `docs/bugs.md`).

The cases behind both floors (The Trial at 0.67 units, Father's Love) and their
live effect: [pricing-measurements.md](pricing-measurements.md#poeninja-exchange-volume-floor).

## Unique variants — matched by mod text, not by the variant string

poe.ninja lists a variant-carrying unique once per variant, and the item side of
the API gives no variant id, and its `variant` string is unusable as a key
(hundreds of spellings for a handful of variants,
[pricing-measurements.md](pricing-measurements.md#price-check-and-poeninja-lines)).
So the valuator matches on the **mod texts**: every mod line of the stash
item and of the candidate ninja line is normalised — numbers and ranges
collapse to `#` — and the line whose mod shape fits best wins; a roll that
falls outside a candidate's range disqualifies it.

### Unique maps — the tier is part of the base line, on both sides

Unique **maps** are priced too (`UniqueMap`), with the map tier taken into
account. The tier is baked into the **base line** on both sides:

- GGG hands out `typeLine: "Map (Tier 16)"` instead of a map base name, and
  every unique map's base in the bridge data is the single generic base `Map`
  (`items.ndjson`, `unique.base` — all of them, without exception). A direct
  base join therefore finds nothing; it would fall back to the item's `Map
  Tier` property, and without that the unique has no category, `ninjaTypeFor`
  returns `null`, and the map lands in `unpriced` (`docs/bugs.md`, B15).
- So the join **retries without a trailing parenthesised decoration**:
  `Map (Tier 16)` → `Map` → category `Map`. The direct join still wins first.
  No base name in the bridge data contains a parenthesis (asserted in
  `normalize.test.mjs`), so the retry cannot resolve to some other item class.
- The decoration is **kept** on `baseType`, because poe.ninja spells its
  `UniqueMap` lines' `baseType` exactly the same way, so the generic baseType
  tiebreak in `fromItemOverview` *is* the map-tier match: a Tier 15 item picks
  the Tier 15 line even when the Tier 16 line is the more liquid one.

**Unidentified** unique maps stay unpriced on purpose (GGG blanks the name
until identification), labelled `Unidentified Map (Tier N)`, and fire no request.

## Itemised corpses — Trade API

poe.ninja and Faustus don't carry itemised corpses (e.g. "Perfect Forest
Tiger", "Pain Artist"), the one category priced via the official **Trade API**.

- **`Imperfect ` corpses are hardcoded to `each = 0`, no query.** This is a
  **stated assumption** (Imperfect corpses are effectively worthless on the
  live market), not an observed price — the *one* documented exception to
  "null, never a silent 0" anywhere in this tool.
- Everything else: an **anonymous** trade search (`type: <corpse name>`,
  `status: online`, `sale_type: priced`, sorted by price ascending), fetch
  the cheapest results (≤10), normalise each buyout to chaos (chaos 1:1;
  divine via the same shared currency-exchange Chaos:Divine rate the Faustus
  bridge and the aggregate use; any other listed currency, e.g. exalted or
  mirror, is discarded rather than risk mis-booking it as chaos), then
  **average the 5 cheapest** normalisable buyouts. Fewer than 5 results →
  average of what exists. Zero results → `null`. How many usable listings the
  average had is stored with it, so a price from a single offer is marked
  `few-listings` (see "Uncertain prices").
- **Both prices and nulls are cached** in `/config/corpse-store.json`
  (`POE_CORPSE_TTL_MS`, default ~6h), so a snapshot does not re-fire a search
  for every illiquid corpse name.
- Pricing happens entirely **in the background**, at **background priority** on
  the shared `RateLimiter` queue the price check uses (manual price checks and
  pasted items always go first): a pricer ticks one corpse name at a time
  (`POE_CORPSE_INTERVAL_MS`), stalest/never-priced name first, capped at
  `POE_CORPSE_BUDGET_PER_HOUR` (default 25) distinct names/hour so the ~70
  possible first-snapshot queries never burst. The valuation route only ever
  *reads* the store — it never queries the Trade API inline.
- **Self-healing ban backoff.** An IP-side GGG soft-ban (HTTP 403), a
  Cloudflare HTML challenge (an unparseable JSON body) or a run of repeated 429s
  trips a cooldown (12min base, exponentially escalating up to 1h on repeat
  trips) during which corpse trade calls short-circuit without touching the
  network; the first success afterwards clears the streak, no restart or manual
  reset. A single transient 429 does not trip it (the shared RateLimiter
  handles ordinary backoff).

## History: what a recorded point is protected against

The value-over-time series on `/history.html` is recorded from the same
valuation, but not blindly:

- **A change in what a price MEANS moves the curve, and the file cannot be
  rebased.** A change such as the age gate above steps the total once on the
  deploy that ships it. Recorded points hold a total and the previous point's
  item breakdown, not every per-item price, so nothing is rewritten. The guard
  below holds only a 20×/25 % **rise**, so a fallback that prices something far
  too high is caught; a step **down** is not held, and should not be; the
  artefact cleanup below does not touch a one-time step.
- **Implausible price jumps are held back.** A jump has to clear BOTH bars to
  count as implausible: the unit price grew at least **20×**
  (`POE_NETWORTH_GUARD_FACTOR`) AND the resulting gain is at least **25 %**
  (`POE_NETWORTH_GUARD_SHARE`) of the previous total. Then the point is recorded
  at the item's previous unit price, the point's total is corrected by the same
  amount, and a log line names the item, both prices, the factor, the quantity,
  the share **and which source produced the number**. If the high price holds
  for 6 hours (`POE_NETWORTH_GUARD_HOLD_MS`) it is accepted after all (also
  logged) rather than freezing the series forever. The incident behind it,
  **The Scavenger** recorded at 174,039c for a 1-chaos card, is in
  [pricing-measurements.md](pricing-measurements.md#history-brake).
- **"Holds" means it was there every time we looked**, counted in *recorded
  points*, not wall-clock hours. A hold ends the moment the item is **missing**
  from a recorded point; a name that comes back is judged again from the
  beginning. A point in which the item is there but carries no price of its own
  counts **neither way**: it neither ends the hold nor moves it along, and the
  deadline slides out by exactly the blind stretch.
- **Which feed priced an item survives the valuation.** Every row of a snapshot
  carries a `source` (`faustus`, `exchange`, `exchange:DivinationCard`,
  `ninja:currency`, `item:<type>`, `corpse:trade`, …), persisted with the
  per-tab store and quoted by the brake's log line, and `uncertain` (see
  "Uncertain prices" below), which the log line appends, e.g.
  `source faustus [uncertain: thin-market]`. The Net-Worth table's last column
  prints that same identifier per row (also `chaos`; an em dash for a row stored
  before the field existed) — deliberately the raw identifier, not a translated
  label: it is the string the store, the guard's log line and this document
  use. It changes no price; it lets a report name the feed behind a wrong
  number (`docs/bugs.md` B20).
- **The guard remembers prices it has accepted**, for as long as a hold may
  last, so an item that left the stash and comes back is measured against what
  this tool last saw for that name. That memory **survives a restart**, for as
  long as it would have lived in the process: it is kept next to the series
  (`networth-history-guard.json`) with every running hold and the last C:D
  rate. Only names the history-items sidecar does not already carry with a
  price are written; a name that was in the last recorded point is judged
  against that point's price, which goes back into the memory at start, at
  that point's time. A running hold continues after a restart, and the downtime
  counts like a point without a price (it moves the deadline out). A change of
  league starts the memory empty, and the sidecar's prices are not taken back
  either (the sidecar records no league). Known gap, listed in
  [`bugs.md`](bugs.md#b1--a-cheap-divination-card-was-priced-at-a-fortune-and-where-that-came-from-is-still-unknown):
  when the sidecar does not match the series' newest point after a restart,
  the first point afterwards is recorded without the brake.
- **Items ENTERING the snapshot that the guard has never seen** have nothing to
  compare against, and a unit-price ceiling per category cannot help: the
  divination-card overview carries The Doctor and The Apothecary at thousands of
  chaos apiece. So an arrival worth at least **25 %** of the previous total AND
  at least **20 divine** (`POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE`) is recorded at
  **no value at all** until it has stood for the hold window, then accepted and
  **booked as stock arriving**, not as a price move: the stored delta carries
  the value on the quantity side, the events list shows an inflow, and the
  retro-cleanup sees that stock explains the rise. The floor is in divine, so it
  does not drift with a league's chaos scale; it is converted with the point's
  own C:D, or with the newest rate the brake has seen, and a brake that has
  never seen a rate has no floor and the arrival bar abstains. Without the floor
  every drop early in a league is a large share of a small total. The default
  is a judgement call bounded by one case, **The Twilight Moon** recorded at
  55.2 divine for a card worth about one chaos
  ([pricing-measurements.md](pricing-measurements.md#history-brake)), not a
  measured optimum. Known limits, in
  [`bugs.md`](bugs.md#b1--a-cheap-divination-card-was-priced-at-a-fortune-and-where-that-came-from-is-still-unknown):
  **the arrival bar does not exist below 20 divine on any account, however
  small the account is**, and several arrivals under the floor in one point are
  still judged one by one; closing either needs a second number no measurement
  supports yet.
- **All four bars are settable, including to 0**, which is what switches the
  arrival bar off (`POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE=0` means "no floor,
  no bar"). An unset or unusable value falls back to the default above.
- **A point belongs to a completed sync.** The refresher walks ONE stash tab per
  tick, so the snapshot is the union of what the per-tab store holds. After an
  empty store (a fresh install, or a short tab list that pruned the stored
  tabs), no point is written until the refresher has been past every tab of the
  current live tab list; a tab that cannot be read at all counts as "been past",
  because its absence is then a constant rather than a dip. Nothing is averaged
  or interpolated: the series has no point for that stretch.
- **Already-recorded artefacts are removed on load.** A stretch that rises to at
  least 5× the level before it, comes back down to near that level, is shorter
  than 6 hours, and is explained by NO stock movement, is dropped and the file
  rewritten: real wealth arrives as stock and the stored delta says so. A jump
  that stays up is never touched.
- **Events are stock movements only.** The list next to the chart counts a row
  when its QUANTITY changed; pure price moves are in the curve's height. A
  movement is valued at its unit price (`dv - priceShare`), not at the whole
  value change, and must be worth at least **1 divine** by default — the bar is
  settable in the rail from "everything recorded" to 10 divine.
- **And "quantity" means stock, priced or not.** The breakdown a point is diffed
  against holds the priced rows with their value and the **unpriced names at a
  value of zero**, so an item that loses its price or gets one back comes out as
  **quantity 0 with the whole value change on the price side**: in the curve and
  the detail panel's price column, in no event list, and never as a mirror-image
  inflow/outflow pair
  ([`bugs.md`, B2](bugs.md#b2--a-momentary-drop-in-the-curve-with-no-matching-event)).
  An item in neither list is gone and booked as an outflow. A withheld arrival
  also stands at zero, but it *entered* the stash; which of the two a zero is,
  is decided by the guard's own release note, never read back out of the value.
- **The recorder gets every unpriced name; the page gets a hundred.** The
  unpriced list *in the snapshot* is capped at **100 names** (ranked by piece
  count) so the block under the Net-Worth table stays readable; the cap applies
  there and nowhere else, because the names it drops are the thinly traded ones
  that drift in and out of being priced. Each tab's stored unpriced list is
  written **uncapped** (`scan.mjs` passes `unpricedMax: Infinity`), bounded by
  the tab's own slots, and the recorder reads the account-wide fold of those
  lists (`aggregate.mjs`, `unpricedStock`: `{name, count}` per name,
  server-side only); the snapshot the browser gets keeps its cap and size. A tab
  stored with the 100-name cap carries at most 100 names until the refresher
  writes it again — **tab by tab**, one round-robin lap; no stored file is
  invalidated and no re-scan is forced. **Nothing rewrites the file**: a phantom
  departure already on disk is byte-identical to a real sale and stays in the
  list until retention drops it (15 days).
- **A tab that did not answer is not an empty tab** — a stash TAB is stock too.
  GGG replying HTTP 200 with a body that carries no items array, or a folder tab
  in which a sub-tab did not answer, is *no reading at all*: the tab keeps its
  stored contents, nothing is written, and no point comes out of that step.
  Only an actual `items: []` is an empty tab, recorded like any other.
- **A point is not diffed across a change in which tabs it was summed over.**
  When a tab is pruned out of the store, or one never read before is read for
  the first time, that single point is skipped and the item diff starts over on
  the new set, so a tab deleted in game cannot stop the recording. Recording
  deliberately does **not** stop while a tab stays unreadable: its contents are
  then missing from *every* point, a constant rather than a dip. The log says so
  once when it starts and once when it clears ([`admin.md`](admin.md), the
  net-worth log table).

### What a figure on the history page means

**Divine, at the rate of its own point**, like the Net-Worth page; chaos only
where there is no rate at all. Every point carries the C:D rate it was recorded
at, and **that** is the rate it is converted with: the curve plots `chaos / cd`
per point, the value axis is labelled in divine, an event's rows and its sum use
the rate its bucket was stamped with, and the window's net change values each
end at its own rate. Nothing is recomputed and no stored line is touched, so a
recorded figure cannot change — and the rate is no constant (173 on 31 July, 195
two weeks later, 100 → 150 → ~220 → ~195 over the league).

- **A point with no rate** (`cd: 0`, written when none was known that minute)
  borrows the rate of the **nearest point in the same window**, not today's. If
  no point in the window has one, the whole window is labelled in chaos — an
  honest `30.2k c` instead of a guess.
- **The net change of a window can be negative while its chaos total rose**,
  when the divine got more expensive faster than the stash grew. **So the rate
  is on screen**: a `C:D` row in the rail (`173 → 195 (+13%)`, for the shown
  window) and a pale line across the plot on its own min/max, with two small
  edge labels and deliberately no second value axis (the rail's C:D sparkline
  is not aligned to the chart's window). An **(i)** at the chart explains it on request.

The line's colour turns direction only once the movement against it, measured
from the last extreme, exceeds **2 % of the plotted span** (a hysteresis in the
displayed unit; a named drawing constant in `frontend/history-chart.js`, not an
environment setting).

### What a farm-session balance means

A **farm session** runs from Start to End (the History page's buttons or the
hotkey daemon's session key). A **game session** runs from the moment the
player's hotkey daemon reports the game running to the moment it stopped, once
it has not run for `POE_SESSION_GAME_GAP_MS` (10 min); a farm session started
during it belongs to it and is listed under it, and each keeps its own balance.

Both (History page, `backend/v2/networth/sessions.mjs`) compare two item
breakdowns of the history — every name in the stash, priced ones with their
value, unpriced ones at zero, after the price brake: the **baseline**, recorded
first after every stash tab was read (or tried) once after the start, and the
one recorded first after every tab was read once more after the end. Until the
baseline is there the session is *starting* and has no figures; until the end
is confirmed the balance is *preliminary*. After a start and after an end the
sync reads the player's tabs once before any twice (a session round), within
the player's own share of the reads, so the wait is about tab count ×
`POE_NETWORTH_SYNC_INTERVAL_MS` divided by that share; the page and the hotkey
daemon's cards give the server's estimate in minutes. When no such point comes
within `POE_SESSION_FINALIZE_MAX_MS` (24 h), or the session ends before it
came, or it was recorded after the end (a game session's end is dated back to
the moment the game stopped), the baseline is the breakdown recorded last
before the start (**baseline at start**, `at-press`), and the page says so;
most of its tabs were read some time before the start, so what was stashed or
taken out in between counts in the session. A game session keeps that breakdown
only when it was younger than `POE_SESSION_BASELINE_MAX_AGE_MS` at the start;
without it the session closes without figures.

| figure | what it is |
|---|---|
| **Total change** | end total − start total |
| **Loot** | for every item whose quantity changed, the change × its **unit price at the start**. An item that had no price at the start (new to the stash, or unpriced then) is valued at its price at the end; an item that has a price at neither end counts **0** and is counted as "came in without a price" — unless the price brake holds it: that one has a price and is named as withheld instead. A pure price move (quantity unchanged) is never loot |
| **Market movement** | total − loot: price moves on what was already there, plus rounding |
| **in divine** | loot at the start's C:D rate (it is in start prices); the total values each end at its own rate, as the window net on the History page does; market movement is the difference, so a C:D move lands there. Without a rate at the start the loot has no divine figure, without one at either end the total has none — never a guess |
| **Loot per hour** | loot divided by the time between the start and the end (not the baseline), in chaos and divine, from `POE_SESSION_RATE_MIN_MS` (10 min) on. On the loot, not the total, so a dearer divine does not look like good farming |

What it cannot see, and says on the page: the **character's inventory** — the
tool reads stash tabs only and never asks for the inventory, so loot counts
once it is in the stash and its tab has been read with it inside; loot still in
the inventory when the round after the end reads the tab it goes to is not in
the balance, which is why the page and the daemon's card ask for it to be
stashed after a farm session's End; **trading and crafting** (a sale books the
item out at its start price and the currency in, a craft books currency out for
an item that may be unpriced); loot stashed **during a session round into a tab
not read yet** (after the start it becomes part of the baseline and is missed,
after the end it still counts); a **folder tab** whose walk began before the
start or the end counts as read after it; and an arrival the **price brake**
holds at no value (`POE_NETWORTH_GUARD_HOLD_MS`) — it is named instead of
counted. A session during which the set of stash tabs changed (a tab added,
removed or read for the first time, or a league switch) is flagged and gets no
hourly figure, and the status line shows no loot figure for it: the whole tab
would count as a change.

## Uncertain prices — marked, and still counted

Some prices in the Net-Worth table rest on a guess or on thin evidence: not
unpriced (the fallback chain found its best number), but marked, so a player
knows which rows to check in game before selling. Each such row carries one
reason (`items[].uncertain` in the snapshot, see `backend/v2/frontend/PROTOCOL.md`);
a row without one has no KNOWN reason for doubt, which is not a verified price
(the cause of `docs/bugs.md` B1 is still unknown), so the page leaves that cell
blank and never prints "ok".

| reason | when | decided in |
|---|---|---|
| `thin-market` | the trading behind a Faustus or poe.ninja exchange price moved less than `POE_NETWORTH_THIN_TURNOVER_C` chaos (default 5000). For Faustus that is the quote side of the one hour the price came from (a divine-bridged price counts its divine side at that refresh's C:D); for a poe.ninja exchange line its `volumePrimaryValue`. A poe.ninja line without a volume field, priced only because the volume floor fails open, counts as thin | `valuator.mjs` `thinMarket` |
| `gem-guessed` | poe.ninja has no line for the gem's exact level, quality and corruption; the nearest line, or the cheapest, was used | `fromGem` |
| `variant-guessed` | several poe.ninja lines carry the name and nothing on the item decides; the cheapest one was used (the most traded one for an item without mods) | `fromItemOverview` |
| `links-guessed` | no line for the item's own link count; another link count's line was used | `fromItemOverview` |
| `few-listings` | a corpse price averaged from fewer usable trade listings than `POE_NETWORTH_CORPSE_MIN_LISTINGS` (default 2, i.e. one listing) | `fromCorpseStore`, count written by `corpse-pricer.mjs` |

**Why 5000 chaos.** It is this repository's bar for "may this market side set
a price" (`isTurnoverAttested`, `backend/v2/sell-side.mjs`), from the one
relation between turnover and price quality on record: below it, sides were off
by up to +384 %; from 5000c upward no gap beyond 78 % was observed. It is not
calibrated against the no-bid cards of `docs/bugs.md` B20 (that needs the store
dump B20 names), so it is a setting, and it only marks.

**Counted, not set aside.** An uncertain row counts in the total, the category
bars and the per-tab values like any other row, and the page states under the
total how much of it rests on uncertain rows ("incl. X uncertain", for the
selected tabs). A headline without them would step whenever an item crosses the
turnover bar, with no stock moving (the shape of `docs/bugs.md` B2), so the
history records the same total with and without the marker. The price guard's
log line names the doubt next to the source. A row folded from several stash
entries (same item, same price, same tab) is uncertain as soon as one of them
is, so the line under the total can slightly overstate the uncertain share. The
"Uncertain only" button narrows the table and Stash Highlight to the marked
rows. **Data stored before these fields existed reads as unmarked** until it is
written again — a stored row until its tab is synced again (one refresher lap),
a Faustus price until the next hourly refresh writes the turnover behind it, a
corpse price until the corpse pricer prices it again (at most
`POE_CORPSE_TTL_MS`, 6 h) and stores how many listings it had — and until then
the line under the total understates the uncertain share; no price changes.

**Deliberately not marked:** `ninja:currency` / `ninja:fragment` (the last
resort of the fungible chain; listing-based, but no guess is made there and the
1.0 placeholder is already rejected), `Imperfect` corpses (a stated value of 0,
which adds nothing to any total), and a unique whose base or map tier matches no
poe.ninja line when the name has only that one line (its price then comes from a
line of another base or tier; how often that happens is not measured). When the
base or tier matches no line and several lines of the name remain, the variant
rule applies: unless the item's mods pick one of them, the price is marked
`variant-guessed`.

## What's deliberately left unpriced

- **Rare/magic gear and gems** below the priceable rarity, and **non-unique
  maps** (white/magic/rare) — poe.ninja doesn't carry a reliable rare-gear price
  feed, and mod-rolling makes bulk pricing meaningless without a build-aware
  appraiser. **Cluster Jewels** have no price route either.
- **IncursionTemple items (Chronicle of Atzoatl)** and **Memory items** have
  no classifier at all today — they fall through to the generic
  `unknown`/`skip` bucket. Nothing routes them to a price source yet.

None of these are silently counted as 0 or folded into the total; each is
counted and reported in one of two buckets per stash tab:

- **`unpriced`** — the item was classified, but no source had a price for it
  (cluster jewels, a corpse with no listing, a unique nobody sells). Listed by
  name in the "unpriced" block of the Net-Worth page.
- **`skipped`** — the classifier claimed the item and dropped it on purpose
  (rare/magic gear, non-unique maps), or could not place it at all (`unknown`,
  which is where the Temple and Memory items go). A count, no names.

Both counts travel per tab (`snapshot.tabs[].unpriced` / `.skipped`) and for
the whole snapshot (`counts`); the per-tab `skipped` tells a `0c` tab that got
nothing from GGG from one whose every item was dropped (`docs/bugs.md`, B7).
The Net-Worth sidebar marks them `∅` and `⨯N` respectively.

### These counts are ENTRIES, and the unpriced list is PIECES

`counts.priced` / `.unpriced` / `.skipped` and their per-tab twins count **GGG
stash entries** — one slot, whatever it holds. The unpriced list's `×N` counts
**pieces**, the sum of the stack sizes behind a name (a stack of five is one
entry, five pieces); they travel as `counts.unpricedPieces` (whole snapshot)
and `tabs[].unpricedPieces` (per tab). The summary line states the pieces and
names it shows and appends how many pieces the 100-name display cap kept out
(`docs/bugs.md`, B18), so it cannot contradict the list beneath it.

## What a buyer-whisper verdict means

The price in a trade whisper is the seller's own listed price: the buyer's
trade site copies it into the template. A verdict therefore answers "am I
selling below the market?", not "is the buyer's offer fair". `below` means the
listed price is under `POE_WHISPER_LOW_RATIO` (0.85) of the market value,
`above` over `POE_WHISPER_HIGH_RATIO` (1.15) of it, `fair` in between
(`backend/v2/whisper-price.mjs`). The market side uses the routes above and
nothing else, never the trade API:

- **Fungibles** through the valuator (Faustus, then poe.ninja, with the same
  confidence floors), from a descriptor built from the name alone
  (`descriptorForName`, the same classifiers a stash item goes through), so a
  whisper and the Net Worth page give the same item the same price (below 1 c
  the whisper shows three significant digits where the Net Worth row rounds to
  one decimal).
- **A unique** only when exactly one poe.ninja line exists for that name on that
  base, after the `count` confidence filter; no link count or variant is chosen,
  because the whisper names neither, so several lines are `not-compared` with
  reason `variants`. A captured beast is one item per slot (its classifier pins
  the stack to 1, `SINGLE_ITEM_KINDS` in `networth/kinds.mjs`), so a single
  whisper for one is compared like a unique.
- **Never** a rare, a magic or normal item, or a gem (the whisper does not say
  whether a gem is corrupted). A whisper's item text is read by its shape: a
  name and a base split at the last `, ` are a unique when the catalogue knows
  that unique on that base, else a rare; `level N N% <gem>` is a gem.
- **Languages.** Item names are read in the whisper's language, the buyer's
  trade-site language. The server has names for English and, once generated,
  German. A French, Russian, Spanish or Portuguese whisper is read all the same,
  but its item counts only when its whole name (or the name behind a stack
  size) is exactly one the loaded languages know, a catalogue item, a unique on
  its base, or a gem in the English wording whose name is in the catalogue; a
  shape alone (a rare from a cut at `, `, a magic item from a base inside the
  text, gem-shaped text with an unknown name) says nothing about a foreign name.
  Anything else is `no-language-data`: the item as written, the listed price in
  chaos where its currency is known, no market price.
- **A single whisper for an item that stacks** is not compared
  (`stack-unknown`): whether its "listed for" is the price of one unit or of the
  whole stack is not known. It shows both readings in chaos per unit next to the
  market price per unit: per unit (the listed price itself) and per stack (the
  listed price divided by the stack size). The stack size is the number in front
  of the item name when the whisper has one (`20 Orb of Alchemy`; read only when
  the rest is a name that stacks), else the size the last sync stored for an
  item of that name at the whisper's tab and cell (the price-note rows of
  "Listed below market" below, so it costs no request; only while the store
  holds the whisper's league, tabs of the same name that disagree give none, and
  it is marked "last sync", since that stack may have changed), else there is
  only the per-unit reading. A stack of one adds no second reading. When the
  Chaos:Divine rate behind a listing in divine is the fallback or stale, or the
  market price (or the price of the listing's currency) is uncertain, the
  readings carry that caveat (`caveat` in the whisper entry).
- **A bulk whisper** names both quantities: the listed total is compared with
  the market value of the same quantity, from unrounded prices, and the
  listing's currency is converted unrounded too. Rounded unit prices would
  misjudge currency traded in thousands: 1000 Transmutations for one divine at
  150 c is 0.15 c each against a market of 0.149 c, a fair offer, but rounded
  to one decimal it reads 0.2 against 0.1.

A whisper for another league than the player's is not compared and costs no
poe.ninja request. Neither is one whose price needs the Chaos:Divine rate while
that rate is the configured fallback (`POE_CD_RATIO`) or older than its
freshness limit (`rate-unknown`): divine-listed items are the valuable ones, and
a wrong 'below market' is worse than none. For the same reason a market price
that carries an `uncertain` marker (see "Uncertain prices — marked, and still
counted" above: `thin-market` for an exchange price, `few-listings` for a
corpse), or a listing currency whose own price carries one, gives no verdict
(`uncertain-price`); the market value and its marker stay in the entry as
information. A currency this tool does not know is `unknown-currency`; a known
one without a price right now is `no-rate`. Every case without a number has a
named reason, so no number is never read as "fair".

## Listed below market

The Net Worth page lists the items whose price note is under this tool's market
value. The rule is the buyer-whisper verdict `below` itself, not a copy of it:
`networth/listing-audit.mjs` calls `verdictFor` from `whisper-price.mjs` with the
same `POE_WHISPER_LOW_RATIO` (0.85), so a whisper and the block cannot disagree
about one price. Both compare unrounded prices: the market value kept with a
note is the valuator's price before the 0.1 c display rounding, the number a
whisper is judged on, so a Chaos Shard at 0.05 c listed at 1/20 chaos is fair,
not half the market. Only premium tabs count: a normal tab cannot be put up for
sale, so neither its name nor a note on an item in it is read. The note is
`~price <n> <currency>` or `~b/o <n> <currency>` (`<n>` may be a fraction such
as `1/20`), the item's own `note` or, for an item without one, the name of its
tab when that is a price note; it is kept in the per-tab store with the market
value of the same sync, so the block costs no request. An item without a market
value is not kept: with no market there is nothing to be below, so it neither
appears nor is counted. Chaos counts as it is, divine at the current
Chaos:Divine rate; with that rate the fallback or stale (`rate-unknown`), with
another currency (`unknown-currency`) or with an `uncertain` market price
(`uncertain-price`) a note is not compared, and the block counts each reason. A
note on a stack is read as a price per unit, the dearer of the two readings,
so a stack listed here is below the market whichever one GGG means. Rows are
sorted by the chaos lost (market value minus listed price, for the whole stack);
the snapshot carries the 100 biggest losses and the number of the others.
