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

Chaos Orb itself is hardcoded to `1` (it's the numeraire; it has no exchange
line of its own to look up).

Divine Orb is the one stackable that does not start at Faustus: the whole UI
converts chaos into divine with the C:D rate of the poe.ninja exchange, so the
Divine Orb row asks that exchange first (`source: exchange`) and only falls back
to the normal chain if the exchange has no line for it. Through Faustus (the in-game
rate, which differs) one Divine Orb would convert to something other than 1 div.

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

### What each number on the card is, and why three cards can look different

The card can carry four numbers from three different places, and until they were
labelled a reader had no way to tell which was which — the report that started
this was three divination cards rendering three different ways with nothing
saying why.

| on the card | where it comes from | what it is |
|---|---|---|
| the headline + `EXCHANGE` | Faustus | the **volume-weighted average of the trades that matched** in one digest hour. Between the sell and the buy side, never a side of its own |
| `rate is N h old` | Faustus | how old that hour is. **Only shown past the unavoidable lag** — a fresh price says nothing, because a label on every card stops being read |
| `that hour L–H c` | Faustus | the low and high of **that one hour**, not the span of the hours the union walk searched. The headline is that hour's average, so it lies inside this |
| `Trade-Ask: … · N listings` | official Trade API | what sellers are **asking**, the cheapest offers this search fetched. Not a price anything sold at |

Which shape a card takes follows the source order above, and each shape now names
its source:

- **`EXCHANGE`** — Faustus has a rate for the item, inside the age gate.
- **poe.ninja label** — Faustus has none, but the item is in `NINJA_BULK_CLASSES`
  and poe.ninja carries it (a single aggregated value, no listings to count).
- **`TRADE`** — neither did. The number is the trade site's own offers, listed
  one by one below. This is where *The Trial* lands: the poe.ninja card line for
  it is rejected by the exchange volume floor (1359c off 906 chaos of turnover,
  0.67 units — see below) and Faustus does not price it either.

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
  divine market traded at least **3× as many units** of the item *and* moved at
  least **5000 chaos of turnover** on that side (`isTurnoverAttested`). The
  bridged price still has to pass the envelope below.

  That turnover bar is the sell-side comparison's, but **without its companion
  10-unit floor**, which the bridge deliberately does not apply. The two ask
  different questions — the comparison claims which currency pays a seller more,
  the bridge decides which side sets the price — and a flat unit count punishes
  whatever is expensive: Father's Love, a card worth ~44 divine, traded 7 of
  itself for 305 divine and was rejected 3 units short of 10, so a single
  153-chaos sale priced it at 153 instead of ~8500. Every bogus side in the
  sell-side measurement table fails on turnover anyway, and three of them clear
  the unit floor comfortably, so dropping it here costs no guard.

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
- **What the number MEANS: a matched-trade average, not a market side.** Both
  estimators above are derived from `volume_traded`, i.e. from trades that
  actually filled. Neither the Faustus digest nor poe.ninja's
  `exchange/current/overview` carries a bid and an ask — one market, one number,
  no side. The in-game Currency Exchange window shows two ("I have X, I want
  Chaos" against "I want X, I have Chaos"), and nothing this tool fetches can
  reproduce that split. So a Faustus rate sits *somewhere between* the two sides
  by construction, and the tool does not claim otherwise anywhere.

  A liquidation discount to close that gap was considered and **not** built,
  because the measurement refutes it as the dominant effect. Two cards of the
  same league at the same minute (Allflame, 2026-08-13), both through this exact
  path: *Imperfect Memories* at 19c against an in-game sell of 21c and buy of 38c
  — 10 % **below** the side a seller collects — and *The Chosen* at 206.6c
  against a sell of 147c and a buy of 180c, 40 % above **both**. A systematic
  side offset cannot produce a number below the bid, and a haircut calibrated on
  the second card would push the first one further wrong. The residual side bias
  is real but smaller than, and of inconsistent sign against, the effect below;
  see `docs/bugs.md` B17 for what would settle it.
- **NOTHING here knows whether anybody is BIDDING, and that is the largest
  pricing error this tool knows of.** The digest's `volume_traded` — and
  everything derived from it, `detail.sell` included — describes trades that
  **filled**. `sell.chaos` and `sell.divine` are one item's two *markets*, not a
  bid and an ask; no field anywhere carries open orders or stock. Reading the
  order book would mean a third request against GGG for every name, which this
  tool does not spend.

  Measured in the same league at the same minute as the two cards above
  (Allflame, 2026-08-13), against the in-game Currency Exchange:

  | card | this tool | in-game sell | in-game buy | bid there? |
  |---|---|---|---|---|
  | Imperfect Memories | 19 c | 21 c | 38 c | yes |
  | The Chosen | 206.6 c | 147 c | 180 c | yes |
  | Imperial Legacy | ~4.6 c | 1 c per 14 pieces ≈ 0.07 c | 1 c | **"No Stock"** |
  | The Fathomless Depths | 15 c | 1 c per 2 pieces = 0.5 c | — | **"No Stock"** |

  Where a bid exists the tool lands at 0.9–1.4x of it. Where the exchange says
  "No Stock" it lands **30–70x** high — a step, not a slope, which is why
  neither the market side nor the age of the hour explains it. What lets it
  through is how little the direct chaos path demands: the quote-volume floor
  above (50 chaos in ONE of the eight walked hours) is the only absolute bar,
  and the cross-hour check below only *starts* when the winning hour traded
  fewer than ten PIECES — which a cheap item clears with 0.8 chaos of
  merchandise. **A market that stopped trading keeps the last price at which
  somebody's order was filled**, and from here that state is indistinguishable
  from a genuinely rare item that trades once a day.

  **No threshold was invented for it.** Those four rows bound only the wrong
  side of the comparison — they say what it took to be priced at all, not what
  stands behind a price that is right — so a bar drawn between them would be a
  guess. The defect, the two candidate fixes that were weighed and refused, and
  the single store dump that decides between them are written down in
  `docs/bugs.md` B20 instead of being papered over with a constant.
- **How OLD the number is — carried per item, and gated.** The union walk takes
  the newest hour in which each market was informative, so **two prices written
  by the same refresh tick can be hours apart**. The store used to carry one
  `updatedAt` for the whole map (when the refresher ran), which says nothing
  about any individual price, and that is the difference between the two cards
  above: *Imperfect Memories* traded in a recent hour, *The Chosen* in an hour
  that spanned 142–300c with a volume-weighted average of 206.6 and had since
  been overtaken by a market at 147/180.

  So `detail.at` now records the unix hour a price was **observed** in — the hour
  of the market the price came from, which for a divine-bridged price is the
  divine market's hour, not the chaos market's — and it is persisted per item
  (`hours` in the store, additive, no schema bump).

  Two things read it (`backend/v2/networth/faustus-age.mjs`):

  - **The age gate.** An observation older than `POE_FAUSTUS_MAX_AGE_HOURS`
    (default 6, counted from the END of its digest hour) is not served as a
    current price. The item then takes the *same* poe.ninja fallback the chain
    already uses for a name Faustus never quoted — no extra request, because
    those overviews are fetched per league|type and cached ≥15min either way.
    Where the fallback has nothing either, the item is honestly unpriced.
    The card and the net-worth valuator apply the identical gate, deliberately:
    two pages disagreeing about one item is worse than either being wrong alone.
  - **The age label on the price-check card**, described below.

  Three things about the default are worth stating plainly. It is a **judgement
  bounded on the conservative side**, not a measurement: the direction it refuses
  is presenting an old GGG observation as a current price. It sits **inside** the
  8-hour union window on purpose, so it can only ever redirect an item to a
  fallback, never shorten the walk — lowering `POE_FAUSTUS_UNION_HOURS` would be
  the wrong dial, because those eight hours are what gets a thin market a rate at
  all. And it cannot be set below the lag the pipeline cannot avoid: `lastHour`
  is already up to an hour behind and the refresher ticks hourly, so **no served
  price is ever fresher than one digest hour plus one refresh interval** — the
  gate is floored there in code, because a tighter one would reject every price
  there is.
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

## Metadata-ID → name bridge (RePoE)

Faustus keys everything by GGG's internal Metadata-ID
(`Metadata/Items/Currency/CurrencyRerollRare`), not the display name the
rest of this tool works with. The bridge is built from RePoE's
`base_items.json` (`backend/v2/base-names-gen.mjs`). The copy checked in as
`backend/v2/networth/base-names.json` is the starting value; the data
auto-update (`backend/v2/data-refresher.mjs`) then checks
`repoe-fork.github.io/base_items.json` once a day with a conditional request
(ETag) and adopts a validated result into `/config/data-refresh`. It takes effect at once
(the running Faustus pricer swaps the map in, used from its next hourly run) and is
read from there at every boot. A download that does not validate (not an object,
no `Metadata/` ids, implausibly shrunk) is rejected and the previous map stays.
See "Data auto-update" in [docs/admin.md](admin.md).

- Only `release_state === 'released'` entries are kept, and known
  non-priceable prefixes are dropped (`MicrotransactionCurrency`,
  `QuestItems`, `Classic`, `Hideout`, `Masters`, `TradeProxy`,
  `NecropolisPacks`), along with entries whose name is empty (RePoE's
  ~420 `RandomFossilOutcome*` placeholders).
- **Oils are `Metadata/Items/Currency/Mushrune*`**, not `*Oil*` — easy to get
  wrong by guessing the id pattern instead of reading RePoE.
- **Fossils are `Metadata/Items/Currency/CurrencyDelveCrafting*`.**
- **Atlas-mission Astrolabes** are `Metadata/Items/Currency/Astrolabe*`
  (e.g. `AstrolabeAbyss` = "Lightless Astrolabe"). The older
  `lvlvllvlvl/RePoE` mirror, last updated 2024, does not carry them; the
  `repoe-fork` export does.
- Any Faustus-priced Metadata-ID with no entry in this map is logged (by its
  `Metadata/Items/<segment>/` prefix) as a coverage gap rather than silently
  dropped, so a renamed/new item path surfaces in the logs instead of just
  vanishing from pricing.

The CLI is the manual route: `node backend/v2/base-names-gen.mjs` (network
required) rewrites `base-names.json` in the repository. It falls back to the
stale mirror with a loud warning when the fork is unreachable; the
auto-update has no such fallback and keeps the previous map instead.

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

### Unique maps — the tier is part of the base line, on both sides

Unique **maps** are priced too (`UniqueMap`), with the map tier taken into
account — some are genuinely expensive, and leaving them unpriced understated
the stash.

The tier is not a separate field anywhere in this path; it is baked into the
**base line** on both sides, and that is what makes it usable:

- GGG hands out `typeLine: "Map (Tier 16)"` instead of a map base name. Every
  unique map's base in the bridge data is the single generic base `Map`
  (`items.ndjson`, `unique.base` — all of them, without exception), so the base
  join is looking up a name that does not exist and comes back empty. It then
  falls back to the item's `Map Tier` property, and where *that* is absent too
  the unique has no category, `ninjaTypeFor` returns `null`, and the map lands
  in `unpriced`. That is what put a whole map stash into the unpriced list the
  day B7 started delivering items (see `docs/bugs.md`, B15).
- So the join **retries without a trailing parenthesised decoration**:
  `Map (Tier 16)` → `Map` → category `Map`. The direct join still wins first,
  so nothing that was priced before changes. No base name in the bridge data
  contains a parenthesis (asserted in `normalize.test.mjs`), so the retry cannot
  resolve to some other item class.
- The decoration is **kept** on `baseType`, because poe.ninja spells its
  `UniqueMap` lines' `baseType` exactly the same way. The generic baseType
  tiebreak in `fromItemOverview` therefore *is* the map-tier match here: a Tier
  15 item picks the Tier 15 line even when the Tier 16 line is the more liquid
  one.

**Unidentified** unique maps stay unpriced on purpose — GGG blanks the name
field until identification, so which unique it is is unknowable and no lookup
could be honest. They are labelled `Unidentified Map (Tier N)` and fire no
request at all.

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

**A change in what a price MEANS moves the curve, and the file cannot be
rebased.** The age gate above changes which source prices some items, so the
total steps once on the deploy that ships it — in whichever direction the
fallback happens to differ. That step is a definition change, not a wealth
change, and none of the machinery below can tell the difference for you:

- Recorded points hold a total and the previous point's item breakdown, not the
  per-item prices of the whole history, so there is nothing to recompute an old
  point from. Nothing is rewritten, and nothing pretends to be.
- The direction that could do harm is already covered: the guard below holds a
  20×/25 % **rise**, so a fallback that prices something far too high is caught
  exactly as any other bad price would be. A step **down** is not held, and
  should not be — a series that suppressed drops would be useless.
- The artefact cleanup further down does not touch it either: it removes a
  stretch that rises and comes back, and a one-time step does neither.

**Implausible price jumps are held back.** A jump has to clear BOTH bars to
count as implausible: the unit price grew at least **20×**
(`POE_NETWORTH_GUARD_FACTOR`) AND the resulting gain is at least **25 %**
(`POE_NETWORTH_GUARD_SHARE`) of the previous total. Then the point is recorded
at the item's previous unit price, the point's total is corrected by the same
amount, and a log line names the item, both prices, the factor, the quantity,
the share **and which source produced the number**. If the high price holds for
6 hours (`POE_NETWORTH_GUARD_HOLD_MS`) it is accepted after all (also logged)
rather than freezing the series forever.

**"Holds" means it was there every time we looked**, not that six hours have
gone by. A hold ends the moment the item is **missing** from a recorded point;
if the name comes back it is judged again from the beginning. Without that the
window measures a wall clock: an item that vanished and returned seven hours
later would be accepted on the second sight of it. The unit is *recorded
points*, because that is what the brake can observe — a stretch in which
nothing was recorded proves nothing either way.

**A point in which the item is there but carries no price of its own does not
count — either way.** Being gone is evidence: the item did not stand. Having no
price is the absence of evidence: the valuation had nothing for that name this
minute, which says nothing about whether the suspicious price was real. Such a
point therefore neither ends the hold nor moves it along — the deadline slides
out by exactly the blind stretch, so the six hours are still six hours of
points that actually carried a price. Before that, a flickering price feed
restarted the window at every gap, and an item over the arrival floor in an
affected tab could stand in the series at zero indefinitely, writing a fresh
withholding line each time it started over.

This exists because of a real incident: **The Scavenger**, a 1-chaos divination
card on an unchanged stack of one, was recorded at 174,039c — exactly 1000
divine at that hour's rate, twelve times the whole account — and fell back 40
minutes later. Neither Faustus (the card is below the volume floor in every
recoverable hourly digest) nor poe.ninja (1c) carries a number anywhere near it,
and the container had been rebuilt, so the log of that night was gone. The brake
guards the series; the log line is what makes the cause findable next time.

**Which feed priced an item survives the valuation.** Every row of a snapshot
carries a `source` (`faustus`, `exchange`, `exchange:DivinationCard`,
`ninja:currency`, `item:<type>`, `corpse:trade`, …), it is persisted with the
per-tab store, and it is what the brake's log line quotes. Before that the
source was thrown away the moment a tab was valued, which is why the Scavenger
night could never be reconstructed: the number was on the chart, and nothing
anywhere said whether it came from Faustus below its volume floor or from a
poe.ninja line that matched the wrong row. Both are named in the log now.

**And on the page, in its own column.** The Net-Worth table's last column prints
that same identifier per row (`faustus`, `exchange`, `exchange:DivinationCard`,
`ninja:currency`, `item:<type>`, `corpse:trade`, `chaos`; an em dash for a row
stored before the field existed). It is deliberately the raw identifier and not
a translated label — it is the string the store, the guard's log line and this
document use, and a report is worth what the name it can quote is worth. The
column changes no price. It exists because a wrong number was reported from
that very table and, without it, nobody could say which feed produced it
(`docs/bugs.md` B20).

**Items ENTERING the snapshot are judged too.** The bars above compare an item
against its own previous unit price, so on their own they only protect what was
already there. Two things cover a name that arrives:

- **The guard remembers prices it has accepted**, for as long as a hold may
  last. An item that left the stash and comes back is therefore still measured
  against what this tool last saw for that name, and a 20×/25 % jump across that
  gap is held exactly like one between two consecutive points.

  That memory is **in the process, and it is gone after a restart** — including
  the container rebuild that erased the Scavenger night's evidence. What does
  survive a restart is the *previous point's* breakdown, in the history-items
  sidecar, so a name that was in the last recorded point still has a previous
  unit price to be measured against; only a name that was absent from it loses
  its reference and re-enters through the arrival bar below. The gap is
  therefore narrow, but it is real and it is listed in
  [`bugs.md`](bugs.md#b1--a-cheap-divination-card-was-priced-at-a-fortune-and-where-that-came-from-is-still-unknown)
  rather than papered over.
- **A name the guard has never seen has nothing to compare against at all**, and
  no bar can decide from one number whether it is right. A unit-price ceiling
  per category cannot do it either: the same divination-card overview carries
  The Doctor and The Apothecary at thousands of chaos apiece, so a ceiling low
  enough to catch a wrong card blanks the expensive ones that are real — the
  same "a flat bar punishes whatever is expensive" failure the volume floors
  above are built around. So the arrival bar does not rule on the price, it
  rules on whether the series may lean on it yet: an arrival worth at least
  **25 %** of the previous total AND at least **20 divine**
  (`POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE`) is recorded at **no value at all**
  until it has stood for the hold window, then accepted. An unpriced item is
  honest; a wrongly priced one is not.

  **The acceptance is booked as stock arriving, not as a price move.** Nothing
  was ever counted for that name while it was withheld, so when the guard lets
  it in, the whole stock *enters* the series at that point: the stored delta
  carries the value on the quantity side, the events list shows it as an
  inflow, and the retro-cleanup below can see that stock explains the rise.
  Booked the other way it would be a revaluation of stock the series never had
  — invisible in every list, and then a jump in the curve that nothing accounts
  for, which is the very shape of defect this brake exists to prevent.

  The floor is in divine, like the event threshold below, so it does not drift
  with a league's chaos scale. It is converted with the point's own C:D, or with
  the newest rate the brake has seen when a single point arrives without one; a
  brake that has never seen a rate at all has no floor and the arrival bar
  abstains rather than guess. Without the floor every drop is a large share of a
  small total early in a league and the brake would suppress the first hours of
  a fresh account.

  The live case it was measured against: **The Twilight Moon**, a card that
  trades at about one chaos, entered a ~94 divine account as a quantity change
  of +1 and was recorded at 55.2 divine (~11,700c at 212 c/div). The default
  floor is a judgement call bounded by that one case, not a measured optimum —
  two other cards in the same window (The Demoness at 7.8 divine, Enmity's
  Embrace at 12.9 divine) sit below it and are deliberately not caught: neither
  was ever shown to be wrong, and suppressing a 10-divine arrival for six hours
  on suspicion alone costs more than it buys.

  Because that floor is absolute and both bars have to clear, **the arrival bar
  does not exist below 20 divine on any account, however small the account is**,
  and several arrivals under the floor in one point are still judged one by one.
  Both are known limits, written down in
  [`bugs.md`](bugs.md#b1--a-cheap-divination-card-was-priced-at-a-fortune-and-where-that-came-from-is-still-unknown):
  closing either one needs a second number that no measurement supports yet.

  All four bars are settable, **including to 0**, which is what switches the
  arrival bar off (`POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE=0` means "no floor,
  no bar"). An unset or unusable value falls back to the default above.

**A point belongs to a completed sync.** The background refresher walks ONE stash
tab per tick, so the snapshot is the union of whatever the per-tab store holds at
that moment. Between an empty store — a fresh install, or a tab list that came
back short and pruned the stored tabs — and the end of the first full pass, that
union is a sum over a subset of the account. No point is written until the
refresher has been past every tab of the current live tab list; a tab that
cannot be read at all counts as "been past", because its absence is then a
constant rather than a dip. Nothing is averaged or interpolated afterwards: the
series simply has no point for that stretch.

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

**And "quantity" means stock, priced or not.** The breakdown a point is diffed
against holds every name that is in the stash: the priced rows with their value,
and the **unpriced names at a value of zero**. That second half is
not cosmetic. Without it the breakdown was a list of PRICED items, and an item
that merely lost its price left that list and read as an item leaving the stash;
getting a price back read as one arriving. On an evening nobody played, that put
mirror-image pairs into a list whose whole promise is that it shows stock — an
inflow and an outflow of the same name, the same count and the same chaos to the
decimal ([`bugs.md`, B2](bugs.md#b2--a-momentary-drop-in-the-curve-with-no-matching-event)).

With the unpriced names in the map, both directions come out as **quantity 0
with the whole value change on the price side**: it lands in the curve, in the
detail panel's price column, and in no event list. That is the same split the
rest of this section makes — the list is for stock, the curve is for what things
are worth — applied to the one case where the value change is not a market move
at all but the tool losing its ability to say. An item that is in neither list
is gone, and is booked as the outflow it is.

The withheld arrival above is the case that looks the same and is not. Both
stand in the previous breakdown at a value of zero, but a withheld arrival
*entered* the stash and was only valued late, so letting it in is a stock
movement the series owes the player; an item whose price went away never went
anywhere. Which of the two a zero is, is decided by the guard's own release
note and by nothing that could be read back out of the value.

**The recorder gets every unpriced name; the page gets a hundred.** The unpriced
list *in the snapshot* is capped at **100 names** (ranked by piece count) so the
block under the Net-Worth table stays a list a person can read. That cap used to
reach the diff as well, and the names it drops are the rarest ones — thinly
traded items that drift in and out of being priced, i.e. precisely the ones this
correction exists for. A name ranked out of the list was missing from the proof
that it is still in the stash and fell straight back into the old reading; in
production that left two phantom rows per block standing after the four the
paragraphs above had taken away.

The cap therefore applies where the list is drawn and nowhere else:

- Each tab's stored unpriced list is written **uncapped** (`scan.mjs` passes
  `unpricedMax: Infinity`), bounded by the tab's own slots — the priced rows
  stored next to it have never been capped either.
- The recorder reads the account-wide fold of those stored lists
  (`aggregate.mjs`, `unpricedStock`): `{name, count}` per name, and it never
  leaves the server. **The snapshot the browser gets is unchanged**, cap and size
  included — no second list travels the wire for the recorder's benefit.
- A tab stored before this carries at most 100 names of its own, and no fold can
  invent what is not there. Completeness returns **tab by tab** as the refresher
  writes each one again — one round-robin lap, and nothing behaves worse than
  before in the meantime. No stored file is invalidated and no re-scan is forced:
  it is the same field, only no longer cut short.

One limit remains:

- The correction applies to points recorded from now on. **Nothing rewrites the
  file**, and a movement already on disk cannot be told apart afterwards: the
  stored row for a phantom departure is byte-identical to one for a real sale.
  Recorded phantoms stay in the list until retention drops them (15 days).

**And a stash TAB is stock too.** The same reasoning one level up: a point is
summed over the tabs the per-tab store can answer for, so a tab that drops out
of that set takes every name in it along, at its full stock and its full value —
a whole tab's worth of stock "leaving" and, a round-robin lap later, "arriving".
Two rules keep that out of the list:

- **A tab that did not answer is not an empty tab.** GGG replying HTTP 200 with
  a body that carries no items array, or a folder tab in which a sub-tab did not
  answer, is *no reading at all*: the tab keeps its stored contents, nothing is
  written, and no point comes out of that step. Only an actual `items: []` is an
  empty tab, and an empty tab is recorded like any other — owning one is
  ordinary and must never block the series.
- **A point is not diffed across a change in which tabs it was summed over.**
  When a tab is pruned out of the store, or one that had never been read is read
  for the first time, that single point is skipped and the item diff starts over
  on the new set. Exactly one point, so a tab deleted in game cannot stop the
  recording.

The one thing this deliberately does **not** do is stop recording while a tab
stays unreadable. Its contents are then missing from *every* point, which is a
constant rather than a dip, and the alternative — a series that stops for good
over one bad tab — is worse. The log says so once when it starts and once when
it clears ([`admin.md`](admin.md), the net-worth log table).

### What a figure on the history page means

**Divine, at the rate of its own point.** The page prints divine because that is
the unit purchasing power is thought in — "150d" is a Mageblood, "30k c" is
nothing anybody owns a picture of — and the Net-Worth page prints divine too, so
a number means the same thing on both. Chaos is not an alternative unit to
switch to; it is what the page says when it has no rate at all.

Every point carries the C:D rate it was recorded at, and **that** is the rate it
is converted with: the curve plots `chaos / cd` per point, the value axis is
labelled in divine, an event's rows and its sum use the rate its bucket was
stamped with, and the window's net change values each end at its own rate.
Nothing is recomputed and no stored line is touched — the file already holds
everything this needs.

Until this was fixed, the page did the one thing the recorder's own header
forbids: it divided every chaos figure by the rate of the **newest** point.
Axis, tooltips, event rows, event sums and the window net were therefore
re-valued whenever the rate ticked, and the rate is not a constant — 173 on
31 July, 195 two weeks later, and 100 → 150 → ~220 → ~195 over the league. A
historical event cannot change by definition; that page changed all of them
several times a day.

Three consequences worth knowing:

- **A point with no rate** (`cd: 0`, written when none was known that minute)
  borrows the rate of the **nearest point in the same window**, not today's. If
  no point in the window has one, the whole window is labelled in chaos — an
  honest `30.2k c` instead of a guess.
- **The net change of a window can be negative while its chaos total rose.**
  When the divine got more expensive faster than the stash grew, the stash buys
  less than it did, and that is the true statement rather than a defect.
- **So the rate is on screen**: as a `C:D` row in the rail (`173 → 195 (+13%)`,
  for the shown window) and as a pale line across the plot on its own min/max,
  with two small edge labels and deliberately no second value axis. Without it a
  drop is unreadable — stash or market, one cannot tell. The rail's C:D
  sparkline does not answer it either: it is not aligned to the chart's window.
  An **(i)** at the chart says the same thing in three sentences, on request.

The line's colour is decided with a hysteresis rather than by the sign of each
step: the direction turns only once the movement against it, measured from the
last extreme, exceeds **2 % of the plotted span**. A bare sign test made a
14-day curve a red/green patchwork, and a plain tolerance does not help — a
series wobbling around the tolerance keeps flipping. The threshold is measured
in the displayed unit, so it keeps meaning the same thing now that the plot is
drawn in divine. It is a drawing constant of one SVG in one browser and is
therefore not an environment setting; it is a named constant in
`frontend/history-chart.js`.

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

None of these are silently counted as 0 — every one of them is counted and
reported, never folded into the total.

They do not all land in the same bucket, though, and the difference is now
visible **per stash tab**:

- **`unpriced`** — the item was classified, but no source had a price for it
  (cluster jewels, a corpse with no listing, a unique nobody sells). Listed by
  name in the "unpriced" block of the Net-Worth page.
- **`skipped`** — the classifier claimed the item and dropped it on purpose
  (rare/magic gear, non-unique maps), or could not place it at all (`unknown`,
  which is where the Temple and Memory items go). A count, no names.

Both counts travel per tab (`snapshot.tabs[].unpriced` / `.skipped`) as well as
for the whole snapshot (`counts`). The per-tab `skipped` exists for one reason:
a tab worth `0c` with `0` priced items means either that nothing arrived from
GGG or that a full tab arrived and every item was dropped — two states that
looked identical until the count was carried through (`docs/bugs.md`, B7). The
Net-Worth sidebar marks them `∅` and `⨯N` respectively.

### These counts are ENTRIES, and the unpriced list is PIECES

`counts.priced` / `.unpriced` / `.skipped` and their per-tab twins count **GGG
stash entries** — one slot, whatever it holds. The unpriced list under the
Net-Worth table counts **pieces**: its `×N` is the sum of the stack sizes behind
a name. A stack of five is one entry and five pieces, so the two numbers agree
only while every stack is one, and the summary line above the list used to print
the first over a list of the second and call both "items".

It therefore travels in both units: `counts.unpricedPieces` for the whole
snapshot and `tabs[].unpricedPieces` per tab, alongside the entry counts. The
summary line states the pieces and names it actually shows and appends how many
pieces the 100-name display cap kept out (`docs/bugs.md`, B18), so it cannot
contradict the list beneath it. Nothing about pricing or the total changed —
these are display counts of items that were never in the sum to begin with.
