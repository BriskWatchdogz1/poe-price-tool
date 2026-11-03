# Market fixtures, 2026-11-03

A cut of one recording of public market data, read by
`backend/v2/networth/recorded-thresholds.test.mjs`. The test measures the volume
and confidence thresholds of `docs/pricing-logic.md` against it. Market data
only: no account, character or stash data.

## Recording

- League: Allflame (the league field of every Faustus market kept here, and
  `league=Allflame` in every poe.ninja request).
- Date: 2026-11-03. The Faustus digests are the eight completed hours
  02:00 to 09:00 UTC (unix hours 1793671200 to 1793696400), so the command ran
  between 10:00 and 11:00 UTC.
- Recorded on the server that runs the tool, with this command (the host name
  replaced by `<server>`, the config directory by `<config dir>`, the local
  target directory by `.`):

```sh
ssh <server> 'd=/tmp/ppt-snap; L=Allflame; UA="poe-price-tool fixture snapshot"; mkdir -p $d; h=$(( $(date +%s) / 3600 * 3600 )); for k in 1 2 3 4 5 6 7 8; do id=$(( h - k * 3600 )); curl -s -A "$UA" -o $d/faustus-$id.json "https://web.poecdn.com/api/currency-exchange/$id"; done; for t in Currency Fragment Scarab Essence Fossil Resonator Oil DeliriumOrb Astrolabe Omen Tattoo Runegraft AllflameEmber Artifact DivinationCard Incubator Vial; do curl -s -A "$UA" -o $d/exchange-$t.json "https://poe.ninja/poe1/api/economy/exchange/current/overview?league=$L&type=$t"; done; for t in Currency Fragment; do curl -s -A "$UA" -o $d/currency-$t.json "https://poe.ninja/poe1/api/economy/stash/current/currency/overview?league=$L&type=$t"; done; for t in UniqueAccessory UniqueArmour UniqueFlask UniqueJewel UniqueMap UniqueWeapon SkillGem Beast Incubator Vial DivinationCard; do curl -s -A "$UA" -o $d/item-$t.json "https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=$L&type=$t"; done; ls $d | wc -l'
scp -r <server>:/tmp/ppt-snap .
scp <server>:<config dir>/faustus-store.json ppt-snap/
```

The 39 raw files sit in `../raw/2026-11-03/`, which git ignores. They are cut
into this directory with

```sh
node backend/v2/fixtures/cut.mjs 2026-11-03
```

which keeps whole entries as recorded and only shortens the lists. The names
it keeps are listed in `cut.mjs`.

## What is kept, and why

Each threshold sits between a kept market that clears it and one that does
not. Moving the threshold out of that bracket, or changing its rule, moves one
of them across and turns a test red; a move inside the bracket stays green.
Each bracket below was checked by setting the constant to just outside both
ends (a test fails each time) and just inside them (all pass). For the two
cross-hour ratios, the two windows the test walks hold no closer pair in the
whole digests; the other brackets are as narrow as the examples picked.

| Threshold (`docs/pricing-logic.md`) | Bracket the test pins | Example below, example above |
|---|---|---|
| Faustus quote floor, chaos side, 50 | over 49, up to 50 | Memory of Reverence, Deafening Essence of Torment |
| Faustus quote floor, divine side, 10 | over 9, up to 10 | Cosmic Fragment in two hours |
| Cross-hour check, 10 units (`THIN_X_UNITS`) | exactly 10 | Memory of Loneliness, Deafening Essence of Wrath |
| Cross-hour check, 2x apart (`DEEP_HOUR_DISAGREE_RATIO`) | over 1.98, up to 2.02 | Matryoshka, Prime Chaotic Resonator |
| Cross-hour check, 3x deeper (`DEEP_HOUR_VOL_RATIO`) | over 2.75, up to 3.75 | Fragment of the Phoenix, Shuddering Fossil |
| Divine bridge, 3x the units | over 2.8, up to 3 | Fine Delirium Orb, Devouring Fragment |
| Divine bridge, 5000 chaos of turnover | over about 3931, up to about 5504 (10 and 14 divine at 393.12c) | Zorath's Eye of the Endless, Exalted Orb |
| poe.ninja count filter, 5 | exactly 5 | Vaal Clarity, the two unique maps |
| poe.ninja exchange floor, 10 units | over 9.99493 (9.995 rounded), up to 10 | Deafening Essence of Torment, Jagged Fossil (both carried in the test); Essence of Delirium (9.50), Damnation and Essence of Hysteria (10.33) further out |
| poe.ninja exchange floor, 2000 chaos of turnover | over 1937, up to 3201 | Divine Beauty, Mawr Blaidd |
| poe.ninja exchange floor, one whole trade | over 0.83, up to 2.83 | The Slumbering Beast and Veiled Exalted Orb, Mawr Blaidd |

`faustus-<hour>.json` (8 files, 21 to 27 of 935 to 1081 markets each): every
hour's Allflame market of the names below against Chaos or Divine, and the
Divine<->Chaos market, which sets the Chaos:Divine rate of the window. Keeping
every hour of a pair keeps the union walk, the envelope and the deepest hour as
they were; when the cut was made, the pricer gave each kept name the same result
on the cut as on the whole digests, for the full window and for the window one
hour earlier.

| Name | Threshold | What the recording shows |
|---|---|---|
| Memory of Reverence | quote floor, 50 chaos | 11 units for 49 chaos at 06:00 UTC, rejected |
| Deafening Essence of Torment | quote floor, 50 chaos | 10 units for exactly 50 chaos at 08:00 UTC, priced at 5c |
| Cosmic Fragment | quote floor, 10 divine | 18 units for 9 divine at 09:00 UTC rejected, 13 for 10 divine at 04:00 UTC priced |
| Fragment of the Phoenix | quote floor in the union; cross-hour 3x | newest hour 30 chaos: unpriced; one hour earlier 4 units at 15c beside 11 units at 6.4c (2.75x deeper): kept |
| Memory of Loneliness | cross-hour, 10 units | 9 units at 9.6c beside 51 units at 2.7c: discarded |
| Shuddering Fossil | cross-hour, 3x | 4 units beside 15 units (3.75x), 3.55x apart: discarded |
| Matryoshka | cross-hour, 2x apart | 5 units at 60c beside 129 units at 118.6c (1.98x apart): kept |
| Prime Chaotic Resonator | cross-hour, 2x apart | one hour before the newest: 1 unit at 104c beside 17 units at 209.8c (2.02x apart): discarded |
| Timeless Templar Emblem | cross-hour, 10 units | 16 units at 74c beside 255 units at 16.3c: kept, no check |
| Deafening Essence of Wrath | cross-hour, 10 units | one hour before the newest: 10 units at 5c beside 62 units at 2.24c (2.23x apart): kept, no check |
| Tattoo of the Ramako Fleetfoot | cross-hour, deep hour >= 10 units | 1 unit at 62c beside 7 units at 134.7c: kept |
| Devouring Fragment | bridge, 3x units | 18 divine-side units against 6 (exactly 3x), 15 divine: bridged |
| Fine Delirium Orb | bridge, 3x units | 1417 against 506 (2.8x), 111 divine: own chaos market |
| Exalted Orb | bridge, 5000c turnover | 14 divine (5504c): bridged |
| Zorath's Eye of the Endless | bridge, 5000c turnover | 4 against 1 unit, 10 divine (3931c): the one chaos sale stands |

`exchange-DivinationCard.json` (5 of 157 lines): Damnation (10.33 units,
priced), Divine Beauty (9.0 units, 1937c of turnover: under both floors), Mawr
Blaidd (2.83 units, 3201c: rescued by turnover), The Slumbering Beast (0.83
units, 22,341c: under one trade, rejected), Lost Worlds (12 units at 0.125c: a
cheap card that clears on units).

`exchange-Essence.json` (2 of 49): Essence of Delirium (9.50 units, 600c of
turnover, rejected), Essence of Hysteria (10.33 units, priced). The recording
carries `primaryValue` and `volumePrimaryValue` with at most 2 decimals between
1 and 100, so a unit count near 10 is only good to about 0.01. The two lines
within that distance of 10 are left out of the cut: Deafening Essence of
Torment (5.92 and 59.17, 9.995 units, anywhere from 9.986 to 10.004 before
rounding, rejected) and Jagged Fossil (`exchange-Fossil.json`, 20.01 and 200.1,
exactly 10 units, priced). The test carries both lines itself, copied from the
raw files, for B36 in `docs/bugs.md`.

`exchange-Currency.json` (2 of 100): Orb of Dominance (9.17 units, 13,805c:
rescued), Veiled Exalted Orb (0.83 units, 3601c: rejected).

`item-SkillGem.json` (10 of 5486 lines): every line of Vaal Clarity (the 20/20
corrupted line at 238.6c has count 4, the level 1 line at 4.6c count 5) and of
Heavy Strike (a 21/23 corrupted line at 64,016c off count 2).

`item-UniqueMap.json` (2 of 26): Replica Pillars of Arun (count 4, unpriced)
and Replica Poorjoy's Asylum (count 5, 720c).

## What is not kept

- `exchange-Incubator.json` and `exchange-Vial.json`: poe.ninja answered with
  no lines for either type. `item-Incubator.json`: no lines either.
  `item-DivinationCard.json`: an HTTP 404 problem body; the tool reads cards
  from the exchange overview, not from this one.
- `faustus-store.json`: the server's Faustus store, written at 09:15 UTC for
  the window 01:00 to 08:00 UTC, one hour behind the digests above. Derived
  market data; no test reads it.
- The other raw files (the remaining exchange and item overviews, and the two
  stash currency overviews with 5 and 8 lines): no threshold test reads them.
