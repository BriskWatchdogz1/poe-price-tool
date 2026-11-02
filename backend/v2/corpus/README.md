# The acceptance corpus

Real item texts, straight out of the game client's clipboard, one directory per
item, one file per language. `corpus-parity.test.mjs` runs over whatever is in
here — so an item that lands here is checked from the next `npm test` on,
without a line of code being touched.

Item texts are Grinding Gear Games' content, included as test fixtures only.

This is **acceptance material**, not a demo. `daemon/selftest-items/` looks
similar and is a different thing: those two files are the sample the installer
pushes through the daemon to prove the hotkey path works end to end, they are
hand-trimmed for that purpose, and they are selected by language, not paired.
Do not merge the two.

## Layout

```
corpus/
  wanted.txt                     the checklist: which kinds of item the corpus needs
  <slug>/
    de.txt                       the German clipboard, byte for byte
    en.txt                       the SAME item, English client (optional today)
    covers.txt                   which categories from wanted.txt this item covers
```

## Adding an item

1. `mkdir corpus/<slug>` — the slug is free-form, it only names the test.
2. Copy the item in the game with **`Strg+Alt+C`** (advanced mod descriptions)
   and paste it into `de.txt` unchanged. No trimming, no reflowing, no stripping
   of trailing spaces — the parser sees exactly what the client wrote, and so
   must the test.
3. The same item on an English client into `en.txt`. Without it there is no
   pair, and without a pair there is no parity check: the test then only proves
   that the German text parses, and says so.
4. Put one category id per line into `covers.txt`. Only ids that exist in
   `wanted.txt` — the test rejects a typo instead of silently counting nothing.

Nothing else. No registry, no import, no test to extend.

## Why the texts look like this

Collected 2026-08-07 on a client temporarily switched to German, with
`Strg+Alt+C`, which is why every modifier carries a `{ … }` info line and every
roll its range (`+42(39-49)`).

- **Alt does not reach the clipboard.** Holding Alt shows the English name in
  the game, but what gets copied stays fully German — item name and base name
  included. There is exactly one text form per language, not two.
- **Several markers stay English.** `(augmented)`, `(enchant)` and `(unmet)`
  are untranslated in every German text collected so far — GGG's localization
  is not complete, and the parser has to cope with mixed lines.
- **Decimal rolls use a POINT.** `frieren Gegner für 0.2 Sekunden ein`
  (rare-ring-bone). No comma-decimal appears anywhere in the corpus. This was
  an open question with a silent-failure risk: every value regex in the project
  reads `\d+(?:\.\d+)?`, so a comma would have been truncated without an error.
  Settled by the German text alone — no English partner was needed.
- **`--------` is language neutral.**
- **Socket letters are language-independent.** Initially unproven — `R-B W-G`
  reads the same in both languages by coincidence. Settled with a different
  combination: `Fassungen: G-R-B-B-W W` (rare-body-armour-paladin), plus
  `B-B-B-R` and `B-B-R-W`. German Gruen/Rot/Blau/Weiss share their initials
  with Green/Red/Blue/White, and the client writes those initials.
- **Influence lines the data set has no string for** (`Brennender
  Exarch-Gegenstand`, `Weltenfresser-Gegenstand`) land in
  `item.unknownModifiers` — in English too, where the equivalent lines are
  missing from `client_strings.js` just the same. That is parity, not a gap.

## What the test checks

- every `de.txt` parses on the German engine instance — no `item.parse_error`,
  no `item.unknown`;
- for every complete pair: identical `refName`, identical set of recognised
  stat `ref`s, identical count of unknown modifiers, and an identical trade
  query, built through the engine's real `createTradeRequest` and caught before
  it can leave the machine;
- and it prints what is still missing rather than skipping it. A German text
  without its English partner, and a category from `wanted.txt` that no
  complete pair covers, are reported in plain text. Neither turns the suite
  red — the corpus is known to be incomplete. Red is for a text that stops
  parsing and for a pair that drifts apart.

The test needs the generated German data set (`renderer/public/data/de/`, made
by `npm run gen-lang-data`). Without it the parity part skips and says so; the
bookkeeping over this directory runs anyway.
