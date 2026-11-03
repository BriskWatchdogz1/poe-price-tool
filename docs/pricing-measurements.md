# Pricing measurements — the numbers behind the thresholds

The measurements behind the rules in [pricing-logic.md](pricing-logic.md),
taken on live Faustus digests and live poe.ninja overviews; an error figure
("% off") is against poe.ninja, and a league or date is named where the record
names one. They are records of the day they were taken and are not measured
again; the thresholds a test measures again on a recording are listed in
pricing-logic.md, "Thresholds measured on a recording". The rules themselves,
and what each value does, are in pricing-logic.md; where the two disagree,
pricing-logic.md and the code win.

## Price check and poe.ninja lines

| rule | measurement |
|---|---|
| the card follows the source order | Allflame (1 div = 106c): Valdo's Puzzle Box asked 0.7–1 div (75–107c) on the trade site against 56c on the in-game exchange, Templar Astrolabe a flat 1 div (107c) against 45c — up to 2.4x too high |
| `count`, not `listingCount` | a level-20/0%-quality **Bear Trap** at 369,000 chaos with `listingCount: 21` but `count: 3`, and **Soulwrest** (realistically ~5c) at 1.8M chaos with `count: 1` |
| variants by mod text | a live overview carried 399 distinct `variant` spellings for what are only a handful of real variants; 143 of its 1389 unique names are variant-carrying. **Foulborn Soul Tether** was valued at 5 divine off the wrong variant and is really worth about 2 chaos |

## Faustus

"102 hours" is 102 anchor hours of digests: 72.9k priced lines with
a poe.ninja reference, of which 2238 lines change between the gate variants.

| rule | measurement |
|---|---|
| volume-weighted first | over 703 chaos markets of a live digest the median spread between the extremes is 2.0× and p90 is 5.0×; on the same digest the volume-weighted rate fell inside the hour's own extremes band in 700 of 700 markets that had usable volume. From its extremes a ~1c Ducat came out at 0.33..2.0, was rejected by the spread guard, and fell through to the trade-site ask at 110c |
| divine floor 10 | across a league's 74 divine-quoted markets in one hour the median volume was 5, so a floor of 2 admitted single trades: one lone "2 divine for 30 regal" priced a Regal Orb at 5.67c |
| cross-hour check | 2026-08-05: the divination card *Broken Truce* traded 3 cards for 66 chaos in one hour (22c/card), clearing the 50-chaos quote floor and the spread guard (a single ratio trivially agrees with itself); poe.ninja said 6.4c, the trade-site ask was 1c/218 listings, GGG's in-game Currency Exchange showed "No Stock". The hour before, it traded 61 units for 346 chaos = 5.67c/card — 20× the volume, a fraction of the price |
| discard, not replace | over 302 thin-winning-hour Allflame divination-card samples (13 sliding union windows) the three-part gate fires 16 times, 15 of them with a winning-hour error ≥ 30 % (mean 366 %, up to 970 %). The deeper hour has the lower error in 14 of 16, but *Temperance*'s deeper hour (67 units) priced 179 % off against the thin hour's 39 %: the two hours are two real trades, and nothing in the digest says which is closer. Only 1 of the 16 firings (*Keeper's Corruption*, 9 % off) did not need discarding |
| never fires on 1–3 units every hour | unchanged in all 13 windows: Mirror of Kalandra, Mirror Shard, The Doctor, The Apothecary, Awakener's Orb, Hinekora's Lock, Voidborn Reliquary Key |
| no 10-unit floor on the takeover | Father's Love, a card worth ~44 divine, traded 7 of itself for 305 divine and was rejected 3 units short of 10, so a single 153-chaos sale priced it at 153 instead of ~8500. Every bogus side in the sell-side measurement table fails on turnover anyway, and three of them clear the unit floor comfortably, so dropping it costs no guard |
| takeover factor 3 | over 102 hours, see the gate table below. Every factor from 2.25 to 6 keeps the >100 % count at zero, below 2.25 those lines come back, and the >50 % count bottoms out exactly at 3 |
| single-trade chaos market | *The Progeny of Lunaris* had ONE chaos trade (1132c) beside a divine market of 40 cards steady at 12–13 div; the single trade priced it at 6.4 div against a real ~12.4, while the in-game order book, the divine market and poe.ninja all agreed on 12. Over a live digest, 19 of 38 dual-quoted cards were more than 25 % low and exactly 1 high |
| relative, not absolute | *Desecrated Virtue* has a small chaos market (6 traded units) spanning 220.0..221.0c; the absolute gate threw it away (524c and 495c against a real ~240c), and its divine side (13 and 12 units) is better evidenced but not 3× better, so it keeps its own price: both hours at 8 %, item worst case 118 % → 40 %. Item medians against no branch: *The Progeny of Lunaris* 7.5 % against 38.1 %, *The Apothecary* 10.5 % against 26.5 %; *The Immortal* 17.5 % (absolute) → 11.6 % (relative) |
| known limit of factor 3 | *One Last Score* stays wrong: its chaos market under-quotes in 91 of 102 hours (median 131c, low 62c, against a real ~192c); item median 36.7 % → 34.6 %, worst case unchanged at 67.5 %. In 38 of the 102 hours it has no usable divine market at all (mean error 31 %); of the 64 that do, the rule fires in 10 (mean error 23 %) and the chaos market keeps its underquote in 54 (mean error 32 %). A lower factor would catch more and cost *over*-quoted lines elsewhere (Tainted Exalted Orb 155c against 83c, Luminous Trove 183c against 110c), the worse direction for a net-worth number, so the factor stays at 3. What remains wrong at factor 3: three lines above 50 % in 102 hours, at most 64 % off, all but one *under*-quoted |
| multi-hour envelope | with the newest informative hour alone, 926 of 1402 firings had `min === max` (the accepted band `[p/4, p×4]` a 16× hole, set by the very trade the gate called under-evidenced), and all 8 rejections over 102 hours were wrong, each keeping a chaos price 72–89 % off and discarding a bridge 4–27 % off (The Fiend kept 121c where the bridge said 1059c and the real price was 1107c; Omen of Fortune 500c against ~2450c bridged and 3093c real). The union of the walked hours checks 1474 of 1750 firings against a genuine multi-hour band (in the remaining 276 even eight hours collapse to one point); worth mean 15.1 % → 13.8 %, 10 → 2 lines above 50 % on the disagreeing lines, zero wrong rejections |
| tolerance 4 | a bridged price legitimately sits *above* the chaos market: over the 2036 rows the rule fires on, bridged/chaos has a median of 1.20 (p10 1.01, p90 1.89). With the multi-hour envelope, tolerance 3 gives 4 lines above 50 % and tolerance 2 gives 11, against 2 at tolerance 4 |
| single-hour envelope on the pure bridge | over the same 102 hours widening it, tightening it, or removing it produced byte-identical output, so nothing justifies weakening the guard that caught the Regal Orb case |
| no liquidation discount | the first two rows of the table under [No bid on the in-game exchange](#no-bid-on-the-in-game-exchange): *Imperfect Memories* sits 10 % **below** the side a seller collects, *The Chosen* 40 % above **both** sides. A side offset cannot produce a number below the bid, and a haircut calibrated on the second card would push the first one further wrong. *The Chosen* came from an hour that spanned 142–300c with a volume-weighted average of 206.6 and had since been overtaken by a market at 147/180 — the age gap `detail.at` carries |

The takeover gate over 102 hours (the 2238 lines on which the variants
disagree):

| gate | median | mean | >50 % off | >100 % off | fires |
|---|---|---|---|---|---|
| no branch at all | 22.3 % | 24.8 % | 135 | 0 | 0 |
| absolute, chaos < 10 units | 13.2 % | 16.0 % | 12 | 2 | 1402 |
| **relative, divine ≥ 3× chaos** | **12.6 %** | **15.3 %** | **3** | **0** | 1750 |


## No bid on the in-game exchange

The evidence behind "NOTHING here knows whether anybody is BIDDING" in
pricing-logic.md: four cards against the in-game Currency Exchange (Allflame,
2026-08-13, all at the same minute).

| card | this tool | in-game sell | in-game buy | bid there? |
|---|---|---|---|---|
| Imperfect Memories | 19 c | 21 c | 38 c | yes |
| The Chosen | 206.6 c | 147 c | 180 c | yes |
| Imperial Legacy | ~4.6 c | 1 c per 14 pieces ≈ 0.07 c | 1 c | **"No Stock"** |
| The Fathomless Depths | 15 c | 1 c per 2 pieces = 0.5 c | — | **"No Stock"** |

## poe.ninja exchange volume floor

| rule | measurement |
|---|---|
| 10 units, not 0.5 | **The Trial** was listed at 1359c off a volume of 906, i.e. 0.67 units — two thirds of a single card, enough under the 0.5-unit floor this one replaced to enter a stash at 7 divine per card |
| a turnover branch | **Father's Love** trades only ~4 times in the window while moving 41 607 chaos, because one card costs ~44 divine; units cannot tell "few trades because nobody wants it" from "few trades because each one is expensive", total chaos moved can |
| one completed trade | The Trial at 1359c/0.67 units yields 906 and is rejected, but the same 0.67 units at an inflated 3000c would yield 2010 and pass |
| live effect | Allflame, 916 lines across ten types: 189 fail the unit floor, 9 of them are rescued by turnover — Father's Love (8608c/41 607), The Miracle (3020c/11 074), Lucky Bastion (1918c/15 348), Pearls Before Swine, Choking Guilt, Brother's Gift, Outfoxed, Journey Tattoo of the Mind, Runegraft of the Angler. The most expensive line still rejected is The Sacrifice at 200c off 33 chaos of turnover. Across Currency/Fragment/Scarab/Fossil/Oil essentially no genuinely liquid line falls below 10 units |

## History brake

| rule | case |
|---|---|
| the implausible-jump brake | **The Scavenger**, a 1-chaos divination card on an unchanged stack of one, was recorded at 174,039c — exactly 1000 divine at that hour's rate, twelve times the whole account — and fell back 40 minutes later. Neither Faustus (the card is below the volume floor in every recoverable hourly digest) nor poe.ninja (1c) carries a number anywhere near it, and the container had been rebuilt, so the log of that night was gone; the brake's log line is what makes the cause findable next time |
| the arrival floor of 20 divine | **The Twilight Moon**, a card that trades at about one chaos, entered a ~94 divine account as a quantity change of +1 and was recorded at 55.2 divine (~11,700c at 212 c/div). Two other cards in the same window (The Demoness at 7.8 divine, Enmity's Embrace at 12.9 divine) sit below the floor and are deliberately not caught: neither was ever shown to be wrong, and suppressing a 10-divine arrival for six hours on suspicion alone costs more than it buys |
