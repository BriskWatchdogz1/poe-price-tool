# WS `/events` protocol — Trade Console v2

The frontend opens a single WebSocket to `/events` (same origin, `ws://` or
`wss://` matching the page). All traffic is JSON, one object per frame.

**Every message carries a `type` discriminator** (the single channel needs it);
the remaining fields are exactly as specified below. There are **19 distinct
`type` values**: 16 that the backend (`server.mjs`) sends to the frontend and 4
that the frontend sends back — `networth-history` is the one name used in both
directions (the request and its answer share it). Every type added since the
original six is additive, so unknown types are ignored by older clients.

Unknown `type` values are ignored by the frontend, so the protocol can be
extended without breaking older clients.

---

## Multi-user routing

Several users (`POE_USERS`, default `player1,player2`) share **one** backend and **one**
global price queue, but each has their own **room**: their own item cards, their
own league, their own reference / C:D rail. No auth, no password — identity is
used **only for routing** (LAN, trusted).

- **Browser identity** — cookie `ppt_user=<user>`. Sent same-origin on the WS
  handshake; the server reads it from `req.headers.cookie`. A valid user (in
  `POE_USERS`) joins that room. Missing/unknown cookie → the server sends
  `need-identity` and does **not** join a room (the frontend then shows a picker
  and reconnects once the cookie is set). `GET /users` →
  `{ "users": [...], "appName": "Trade Console", "langs": { "player1": "en" } }`
  offers the list for that picker; `appName` is the display name (`POE_APP_NAME`)
  and `langs` maps each user to the client language their items are parsed in.
- **Daemon identity** — header `X-User: <user>` on `POST /item`. **Missing** header
  → defaults to `POE_USERS[0]` (so the existing header-less trigger keeps working
  for the first user); the item lands in that user's room. A header that is
  **present but names an unknown user** (typo in the daemon's `PPT_USER`) is
  **rejected** with `400 {"error":"unknown user \"…\"","users":[…]}` and logged
  server-side — it is *not* silently routed to `POE_USERS[0]` (which would pollute
  the first user's room and hide the typo). The daemon POSTs fire-and-forget, so
  the 4xx surfaces the misconfiguration without breaking it.

**Message routing:** `queue-status` is **global** — the queue is shared, so
every client of every room sees the same depth / rate-limits. **Everything else**
(`league-state`, `cd-ratio`, `reference`, `item-added`, `price-result`,
`ninja-ref`, `networth-latest`, `networth-result`, `networth-history`,
`networth-sync-status`) is **per-room** — a client only ever receives messages
for its own user. `set-league` changes only the sending user's league. poe.ninja
caches are keyed by league, so two users on the same league share them.

### `need-identity` — server could not route this connection (backend → frontend)
```json
{ "type": "need-identity", "users": ["player1", "player2"] }
```
Sent right after a WS connect when the `ppt_user` cookie is missing or unknown.
The connection is **not** placed in a room and receives no further messages until
the client reconnects with a valid cookie. The frontend responds by showing the
identity picker (buttons from `users`).

---

## Backend → Frontend

### `item-added` — a card (upsert by `id`)
Adds a new item card, or updates an existing one with the same `id` (used to move
a card `queued → searching` before the price lands). Re-sending it never clobbers
the user's in-progress mod edits — only the price/status block is refreshed.

```json
{
  "type": "item-added",
  "id": "mageblood",
  "name": "Mageblood",
  "itemClass": "Belt",
  "rarity": "unique",              // unique | rare | magic | normal | currency | gem | divination
  "baseType": "Heavy Belt",
  "corrupted": false,              // optional
  "priceStatus": "queued",         // queued | searching | done | error | rate-limited
  "facts": ["Quality: 27%"],       // optional: read-only filters the search applies that are not mods
  "mods": [
    {
      "text": "+36 to Dexterity",
      "kind": "explicit",          // implicit | explicit | prefix | suffix | fractured | crafted | links | unknown
      "tier": 6,                   // optional; number -> "Tier 6", string -> shown as-is
      "valueRange": [30, 50],      // optional; drives the slider min/max
      "value": 36,                 // optional; current roll + slider start; bolded inline in the text
      "selected": true,            // pre-ticked in the mod picker
      "searchable": false          // optional: false = shown only, not part of the search (see below)
    }
  ],
  "selection": {                   // optional; see below
    "corrupted": "no",
    "mods": [ { "text": "+36 to Dexterity", "min": 36 } ]
  }
}
```

Rendering notes:
- `rarity` drives the top-border colour + name colour (`unique/rare/magic/currency/gem/normal/divination`). `unique` cards render full-width.
- `mods` are grouped in the picker by `kind` in the order links → unknown → implicit → fractured → prefix → suffix → explicit → crafted, each with a heading.
- A mod with `valueRange` gets a range slider (start = `value`); without it, a plain checkbox.
- `kind: "links"` is the synthetic "Linked sockets" row (a slider up to the item's
  largest link group); it is left out of the summary chips.
- `kind: "unknown"` with `searchable: false` is a modifier the engine could not map to a
  trade stat. It is rendered read-only (no checkbox, no slider) with a "not searchable"
  badge, because it exists on the item but is not part of the price search. The
  frontend never sends it back in a `search`.
- `facts` are plain strings such as `"Quality: 27%"` or `"Item Level: 57"` (gems:
  level and quality): filters the search applies that are not mods. They appear as
  summary chips only and have no editor row.

**`selection`** (optional) — the selection the card's CURRENT price was searched
with: the server's echo of the last `search` payload for this `id`, in exactly
that shape (`corrupted` plus the ticked `mods` with their optional `min`/`max`,
an omitted bound meaning "handle at its stop"). Present only once the user has
run a manual search; the initial automatic search *is* the default selection
that `mods[].selected` already describes, so nothing is echoed for it.

`mods` keeps carrying the item's DEFAULTS either way — `selection` is applied on
top of them, and only when a card is rendered from scratch (first appearance or
the reconnect replay). A re-send onto a card that is already on screen still
touches nothing but the price/status block, so in-progress mod edits survive.
Without this field a reload re-rendered the picker at the defaults while the
price block kept the user's own, differently-filtered result — a listing count
next to a selection that never produced it. The reload applies the selection
only; it never re-runs the search (that would spend trade-API budget on a page
refresh).

### `item-removed` — server dropped a card (backend → frontend)
```json
{ "type": "item-removed", "id": "mageblood" }
```
Sent when the backend evicts a card on its own — currently only when a room hits
its server-side item cap (`POE_MAX_ITEMS_PER_ROOM`, default 50) and the oldest
card is pushed out to make room for a new one. The frontend removes that card
(same fade-out as a user dismiss) **without** echoing a `dismiss` back (the server
has already forgotten it). Additive: older clients ignore the unknown type and
keep showing the stale card until they reconnect.

### `price-result` — prices for one item
```json
{
  "type": "price-result",
  "id": "mageblood",
  "display": "single",             // single | bulk | ninja
  "currency": "divine",            // divine|div -> gold, chaos -> teal, exalted, mirror, ...
  "priceLow": 125,
  "priceHigh": 170,
  "priceMedian": 140,
  "count": 259,                    // listings (single) / sellers (bulk)
  "listings": [
    { "price": 128, "currency": "divine", "seller": "@Exilequeen", "ageMinutes": 4 }
  ],

  "priceSource": "exchange",       // optional: "exchange" | "ninja" — absent for a plain trade-search price
  "sourceLabel": "Exchange",       // optional: label shown under the headline when priceSource is set
  "tradeAsk": {                    // optional: the real trade-site ask, demoted to a secondary line
    "low": 0.7, "high": 1, "currency": "divine",
    "chaosLow": 74.2, "chaosHigh": 106, "chaosMedian": 106
  },
  "exchangeRange": { "low": 10, "high": 17.1 }, // optional: low/high of the ONE exchange hour the rate comes from
  "exchangeAgeHours": 6,           // optional: how old that hour is — ONLY past the unavoidable lag
  "askConflict": { "dir": "over", "factor": 22 }, // optional: headline vs. tradeAsk disagree, see below

  "tradeId": "aB3dEf",             // trade-site query id; null when no trade query stands behind the price
  "tradeKind": "search",           // search | exchange | null — which trade page tradeId opens
  "league": "Standard",           // league the price was taken in
  "sourceNote": null,              // display = ninja only: short note shown next to sourceLabel
  "ninjaUrl": null                 // display = ninja only: poe.ninja page for the item, or null
}
```
Sets the item's status to `done`, fills the price block + listing rows, and flashes
the hit counter. `display:"bulk"` renders a `215 : 1` exchange ratio instead of a range.
`display:"ninja"` is a single aggregated market value (poe.ninja, or the Currency
Exchange for fungibles the bulk exchange did not answer): `priceLow` equals
`priceHigh`, `listings` is empty and there is no `tradeId`/`tradeKind` (both `null`).
`count` is poe.ninja's number of data points, or `null` for an exchange row.

`tradeId` and `tradeKind` build the "Open Trade" link
(`/trade/<tradeKind>/<league>/<tradeId>`); with `tradeId: null` the button is disabled,
unless `ninjaUrl` is set, in which case it opens that poe.ninja page. `sourceNote` is
`"market rate"` for a Currency Exchange row and `null` for poe.ninja.

`priceSource: "exchange"` means the GGG Currency Exchange rate (Faustus) was
promoted to the headline (`priceLow`/`priceHigh`/`priceMedian` all equal that
rate, in chaos) — see `withExchangeMain` in `server.mjs`. In that case the real
trade-site ask is not discarded, it moves to `tradeAsk`: `low`/`high` in the
listing's own currency, plus `chaosLow`/`chaosHigh`/`chaosMedian` converted at
the same C:D rate the card uses (`null` when the ask currency isn't chaos or
divine — no C:D rate to convert by). `chaosMedian` is the median of the
fetched trade-search listings (in chaos), distinct from `chaosLow`/`chaosHigh`
which are the cheapest/10th-cheapest of that same fetch, not a market low/high.
`exchangeRange`, when present, is the {low, high} of the ONE digest hour the
rate was derived from — **not** the span of the hours the union walk searched,
and not necessarily the last hour: the walk takes the newest hour in which that
market was informative, and a quiet market keeps an older one
(`networth/faustus.mjs`). Shown in place of the listing count for an
exchange-priced item.

`exchangeAgeHours` says how old that hour is, in whole hours counted from when
it closed. It is present **only** when the observation is older than the lag the
pipeline cannot avoid — one digest hour plus one refresh interval — so its
absence means "as fresh as this source gets" and its presence is itself the
statement. The frontend renders it above the headline; a fresh price gets no
marker, because a label on every card stops being read. Past
`POE_FAUSTUS_MAX_AGE_HOURS` the rate is not sent as a headline at all and the
item routes like one Faustus never quoted — so this field describes prices
between the two bars, never a price the valuation has already dropped. See
`networth/faustus-age.mjs` and `docs/bugs.md` B17.

`askConflict` fires when the headline and the trade-site ask disagree enough to
matter (thresholds `ASK_CONFLICT_RATIO`/`ASK_CONFLICT_ABS_GAP_C`/
`MIN_ASK_EVIDENCE`/`MIN_CONFLICT_HEADLINE_C` in `server.mjs`, all overridable
via `POE_*` env vars): `dir: "over"` means the headline may be too high (the
ask median sits well below it); `dir: "under"` means the headline may be too
low (even the cheapest ask sits well above it). `factor` is the ratio between
the two, rounded to 1 decimal — logged server-side on every firing, but the
frontend never renders the number, only the fact of disagreement (`.psrc`
suffix "— asks disagree" + a `title` tooltip on the price). This is disclosure,
not correction: the headline is never overridden, and the marker never says
which side is right — both real numbers are already on the card.

### `queue-status` — shared queue load (backend → frontend)
```json
{
  "type": "queue-status",
  "depth": 3,                      // waiting foreground jobs
  "bgDepth": 0,                    // waiting background jobs
  "priorityActive": true,          // a priority (user) search is running
  "rateLimits": [
    { "policy": "trade-search", "used": 6, "limit": 8, "windowSec": 10 }
  ]
}
```
`depth` counts the foreground jobs waiting in the shared queue (`priority` and `auto`
tiers); `bgDepth` counts the waiting `background` jobs. There is no queue panel and no
per-policy dots any more: the frontend reads only `rateLimits`, and as soon as the
worst `used / limit` reaches 85 % it shows a soft warning in the rate-limit banner
("Trade API rate limit almost exhausted"). A hard ban (`rate-limit` below) wins over
that warning.

### `rate-limit` — shared trade-queue ban banner (backend → frontend)
```json
{ "type": "rate-limit", "active": true, "retryAfterSec": 11538,
  "until": 1792948400000, "message": "GGG's trade API rate-limited the app — searches are paused (retry-after). Common at league launch under heavy load." }
```
Raised when a price job hits a **long** trade Retry-After (GGG soft-ban / league-launch
throttle). The RateLimiter + anonymous IP are **shared**, so this is queue-wide, not
per-card — the message is broadcast to **all rooms** (same rationale as `queue-status`)
and rendered as a single amber warning banner above the item grid, with `until` driving
a live "Retry in ~Xh Ym" countdown. Only Retry-Afters **≥ `POE_RATE_LIMIT_BANNER_MIN_SEC`**
(default 60 s) banner — routine multi-second serial-queue backpressure does not. Cleared
with `{ "type": "rate-limit", "active": false }` when a search gets through again; the
banner also self-hides once `until` elapses. Sent on **connect** (active or inactive
snapshot). Additive — older clients ignore the unknown type. The affected card's
`item-added` also carries `priceStatus: "rate-limited"` (+ `retryAfterSec`) instead of a
silent `queued`.

### `cd-ratio` — the Chaos : Divine headline
```json
{ "type": "cd-ratio", "chaosPerDivine": 1265, "trendHint": "live · poe.ninja",
  "sparkline": [-0.63, -2.28, 5.53, 5.5, 20.12, 80.35, 75.97] }
```
`trendHint` is optional free text shown under the ratio. `sparkline` (optional) is
the 7-day C:D trend (poe.ninja) and drives the left-rail spark. The real ratio comes
from poe.ninja's **currency EXCHANGE** (Faustus) endpoint (`exchange/current/overview`,
`lines[]` with `id:"divine"` → `primaryValue`), not the player-trade stash overview.
Falls back to `POE_CD_RATIO` (215) when poe.ninja is unreachable.

### `ninja-ref` — poe.ninja reference price for a card (F3, optional)
```json
{ "type": "ninja-ref", "id": "mageblood", "chaos": 6492024, "divine": 5132,
  "sparkline": [0, 0, 0, 0, 0, 0, 0.47] }
```
Sent (best-effort, after `item-added`) only for **uniques** that match a line in
poe.ninja's `stash/current/item/overview`. Renders a small reference price + mini
7-day sparkline on the card. No match → not sent.

### `reference` — the left-rail currency reference (live, poe.ninja + Faustus)
```json
{
  "type": "reference",
  "league": "Standard",
  "refreshedAt": 1792954000000,
  "currency": [
    { "name": "Mirror of Kalandra", "display": "1710 div", "sparkline": [...], "invert": false, "src": "ninja" },
    { "name": "Dead Man's Sulphur", "refName": "Dead Man's Sulphur", "display": "174 / div", "sparkline": [...], "invert": true, "src": "faustus" }
  ],
  "lifeforce": [
    { "name": "Vivid Lifeforce", "refName": "Vivid Crystallised Lifeforce", "display": "1,571 / div", "sparkline": [...], "invert": true, "src": "faustus" },
    { "name": "Wild Lifeforce",  "refName": "Wild Crystallised Lifeforce",  "display": "11 / c",      "sparkline": [...], "invert": true, "src": "faustus" },
    { "name": "Primal Lifeforce","refName": "Primal Crystallised Lifeforce","display": "—",           "sparkline": [],    "invert": true }
  ],
  "beasts": [
    { "name": "Vivid Vulture", "display": "9 div", "sparkline": [...], "invert": false, "src": "ninja" }
  ]
}
```
Feeds the left rail's three reference sections. Each row renders **name** (left),
**display** value (right, with its source marker) and a **mini sparkline** (same
`sparkSvg` helper as `ninja-ref`). An empty section array is simply omitted.

- **refName** (optional) — the row's ENGLISH reference name, present only where
  `name` is a shortened wording that exists in no data set (the Faustus-priced
  rows: `Vivid Lifeforce` for `Vivid Crystallised Lifeforce`). It is what the
  localized-name table of `GET /item-name-map` is keyed by, so without it those
  rows would be the only ones on the rail that could not be shown in the user's
  language. Everywhere else `name` already IS the reference name; the frontend
  reads `refName || name`.

- **sparkline** — the server's OWN series (`reference-history.mjs`), already
  converted into the unit the row's `display` is printed in, downsampled to ≤30
  points. **Not** poe.ninja's `sparkline` field: that one is not consistently
  oriented across rows (the `divine` row tracks its chaos value, the lifeforce
  rows their divine value), so it can't be coloured honestly. Less than two
  recorded points → `[]` → no line is drawn at all (the state right after a
  deploy; a point is recorded per reference refresh, i.e. ≥15 min apart).
- **invert** — `true` when a RISING displayed number is bad news, which flips the
  green/red colouring. Set statically per row type: lifeforce rows print a quantity
  per currency unit (`"44 / c"` — rising means the lifeforce got cheaper → red),
  currency and beast rows print a price (rising → green).
- **src** (optional) — which feed the row's DISPLAYED NUMBER comes from:
  `"ninja"` (poe.ninja exchange/overview, fetched at the message's
  `refreshedAt`) or `"faustus"` (Faustus sell side, refreshed on the store's own
  hourly clock, stamped in the row's `sell.updatedAt`). **Absent** on a row that
  prints `"—"`: it has no number, so no source may be attributed to it.
  The two feeds are mixed *inside* a section (Mirror is `ninja`, the Sulphur row
  right below it is `faustus`) and run on different clocks — which is why the
  rail shows a marker per row (filled dot = poe.ninja, ring = Faustus, full text
  in the dot's tooltip) and a footer with **one timestamp per source**, never a
  single shared "updated HH:MM". A source appears in that footer only if at
  least one row actually uses it.
  Note on Mirror: `src` is `"ninja"` although the row also carries a Faustus
  `sell` object — `src` describes the DISPLAYED number, which for Mirror is
  poe.ninja's; `sell` is separate provenance with its own timestamp
  (`sell.updatedAt`) and does not change what `src` reports.
- **refreshedAt** — epoch ms of the poe.ninja fetch behind this message, baked
  in server-side so a cache hit keeps the real time instead of "now". It stamps
  the `src: "ninja"` rows only.
- **sell** (optional, currency + lifeforce rows only) — informational
  provenance for the row's sell-side comparison: which currency pays a
  SELLER of this item more right now. The client does not render this object
  (no badge — the shipped UI does not display it directly); what it actually
  does is decide the row's UNIT, via `better`/`only` — see the `display`/
  `sparkline` note under **lifeforce** below. Derived from the SEPARATED
  Faustus per-market rates (X↔Chaos vs X↔Divine, matched-trade volumes — see
  `backend/v2/sell-side.mjs`) bridged at `cd`, the tool's single shared C:D.
  Shape:
  `{ "better": "chaos"|"divine"|null, "only": "chaos"|"divine"|null,
     "edgePct": 6.2|null, "viaChaos": 0.03841|null, "viaDivine": 0.03616|null,
     "cd": 172, "updatedAt": 1792954000000 }`
  - `better` + `edgePct` — a claimed comparison: both markets carry enough
    matched volume. The decision is biased toward divine with hysteresis
    (`CHAOS_TAKEOVER_PCT`/`CHAOS_HOLD_PCT` in `sell-side.mjs`, defaults 5%/2%):
    chaos must beat divine by the takeover margin to become `better`, and once
    it is, it keeps the recommendation until its edge drops below the (smaller)
    hold margin.
  - `better === "divine"` with `edgePct: null` — the deadband: chaos pays the
    same or marginally more but did not clear its takeover/hold bar, so
    divine is recommended anyway as the currency worth holding. No percentage
    is reported (reporting one would claim an advantage divine does not
    have).
  - `only` — exactly one side is attested (the other is too thin or missing):
    that side is named, WITHOUT a percentage, and no comparison is claimed.
  - Field absent — no attested side, Faustus store stale/foreign-league, or
    Faustus disabled. Mirror then renders exactly as before (its number is
    poe.ninja's); the lifeforce/Sulphur rows lose their number too (`"—"`), because
    for them the `sell` object IS the number.
  Beast rows never carry `sell` (no exchange market exists for them).

Field/derivation notes:
- **currency** — Mirror of Kalandra from poe.ninja's currency **exchange**
  (`exchange/current/overview`, same single cached fetch that drives `cd-ratio`, no extra
  request), in divine (`round(primaryValue / ratio) div`, ratio = current C:D).
  Dead Man's Sulphur is NOT a poe.ninja exchange row — it is derived exactly like the
  lifeforce rows below (Faustus sell side).
- **lifeforce** (and Dead Man's Sulphur) — **sell side, not market middle.** `priceC` is the
  chaos a seller collects per piece on the better market, read from the row's own `sell`
  object (`better` side, or the single attested `only` side) — so number and
  sparkline both come from ONE source. The UNIT FOLLOWS THE RECOMMENDATION (`sell.better`
  or `sell.only`), not a scarcity threshold — one statement per row, which market to sell
  on and the rate on that market: side `"chaos"` → `1/priceC` pieces per chaos, `"N / c"`;
  side `"divine"` → `ratio/priceC` pieces per divine, `"N / div"`. Bridged divine-side
  numbers are routinely five digits, so both units group thousands with commas
  (`"31,208 / div"`).
  No attested side (stale/foreign-league/disabled Faustus, or both markets too thin) →
  `display` is `"—"`, no `sell` field, `sparkline` `[]`. The row claims nothing; it never
  falls back to poe.ninja's market value, because the section is headed "Selling".
  These rows key their history under `s:<faustus name>`; the pre-sell-side `j:` points
  (poe.ninja market middles) are deliberately NOT reused and simply age out.
- **beasts** — from `stash/current/item/overview?type=Beast` (value in
  `chaosValue`/`divineValue`). Filtered `count ≥ 15` (poe.ninja's number of data
  points, not `listingCount`, which does not separate confidence): poe.ninja floors
  low-confidence beasts to about one divine and the "never traded" placeholder has a
  `count` of 1–4, so this reproduces poe.ninja's default view with "show low confidence"
  off. Sorted by `chaosValue` desc, top 5. Display `round(divineValue) div`
  when `divineValue ≥ 1`, else `round(chaosValue) c`.

Sent on **connect** (cached snapshot to the fresh client), on the **≥15 min poll**
(broadcast), and after a **`set-league`** switch (re-fetched + broadcast). Best-effort:
poe.ninja errors never throw; a missing section falls back to `[]`.

### `networth-sync-status` — background-sync state for the page status line
```json
{ "type": "networth-sync-status", "state": "expired", "until": 1792948400000 }
```
The **page status line** is the one-line slot every page reserves directly under
its heading (`#appStatus`); it stays collapsed while no sender has anything to
say.

Per-room. Sent on **connect** and whenever the net-worth refresher's state for
this user changes (auth pause entered/lifted, 429 cooldown entered, trade-API
ban gate raised or lifted) or the user's credentials are saved through the
settings dialog. `state` is one of:

- `ok` — background sync is running (the status line stays empty),
- `expired` — the stored POESESSID failed auth; the refresher paused this user
  until a new cookie is saved,
- `cooldown` — syncing is on hold; `until` (epoch ms, only present here) is when
  it resumes on its own. **Two different things produce it**, and one field each
  says which:
  - a **stash 429**, which pauses the refresher for *every* configured user —
    nothing in GGG's answer says whether the limit is counted per session or per
    IP, so the conservative reading is taken. That is what `mine` is for: `true`
    when GGG refused *this* user's request, `false` when this room is a
    bystander waiting out somebody else's 429. The other user is never named. A
    message without `mine` reads as `true`.
  - a **trade-API ban**, marked `tradeBan: true`: GGG has blocked this
    deployment's trade traffic, a ban has been reported to reach the whole
    address, and the stash path stops with it (`docs/bugs.md` B14). No `mine`
    comes with it — it belongs to nobody's session — and `until` is the ban's
    own end time, absent only if the gate could not name one.
- `missing` — no credentials are configured for this user.

Three further fields describe what the refresher is *doing*, because `state` alone
cannot: `ok` used to mean both "walking the stash tab by tab" and "one step has
been stuck for ten minutes" (see `docs/bugs.md`, B5). All of them are
**optional** and only present when there is something to report:

```json
{
  "type": "networth-sync-status", "state": "ok",
  "lastTab": { "at": 1792948400000, "index": 2, "name": "Maps" },
  "current": { "phase": "tab", "since": 1792948430000, "mine": true, "tab": "Maps", "tabIndex": 2, "child": 12, "childTotal": 37 },
  "folderTab": { "tab": "Maps", "tabIndex": 2, "done": 12, "total": 37, "since": 1792947600000 }
}
```

- **`lastTab`** — when a tab was last written for this user (`at`, epoch ms),
  and which one. Taken from the per-tab store, so it survives a restart and is
  the same stamp the page's "oldest synced X min ago" line is built from.
- **`current`** — the step in flight, if any. `phase` is `"list"` (fetching the
  stash-tab list) or `"tab"` (fetching one tab); `since` is epoch ms. The
  refresher runs ONE step at a time across all users, so a step belonging to
  another user is why this room's tabs are not moving and is therefore reported
  too — but then with `mine: false` and **without** `tab`/`tabIndex`: stash-tab
  names do not cross rooms. Inside a folder tab it also carries `child` (how
  many sub-tabs have been read) and `childTotal`, on the same terms.
- **`folderTab`** — a folder tab (Unique/Map stash) being walked right now, for
  THIS user. Its items live in sub-folders on a second endpoint, so it costs
  `1 + N` requests and is therefore `1 + N` ticks, one sub-tab each: `done` of
  `total`, plus `since` (epoch ms) for when the walk started. `total` is absent
  until the sub-tab list itself has arrived. This is the field to read while a
  folder tab is open — `current` reports the step in flight, and between two
  ticks of a walk there is no step at all. Only ever this user's own walk;
  another user's folder tab is not reported here in any form.

All three are a snapshot of the moment the message is sent. Nothing pushes a new
one while a step is running, so a page that has been open through a stall sees
it on its next connect, not live.

The stored POESESSID value itself **never** appears in this message (nor in any
other message or HTTP response) — not masked, not truncated, not as a length.
Credentials are read/written over HTTP instead: `GET /networth/credentials` →
`{ user, accountName, status }` (account name + state only), and
`POST /networth/credentials` with `{ "accountName": "...", "poesessid": "..." }`
(empty `poesessid` = keep the stored one) → `{ ok, accountName, status }`.
Identity for both: the same `ppt_user` cookie as `/events`.

### `networth-latest` — the stored net-worth snapshot, on connect
```json
{ "type": "networth-latest", "snapshot": { … } }
```
Per-room, sent **once per WS connect**, right in the opening burst. It carries
whatever the background auto-refresher has accumulated in the per-tab store so
far — there is no manual scan trigger, so this is how a freshly opened Net Worth
page gets its numbers. `snapshot` is `null` when the store holds no tab for this
user yet (nothing configured, or the very first refresher cycle is still
running); the page then shows its "no result yet" state instead of a total.

The snapshot is the aggregate over all stored tabs (`networth/aggregate.mjs`),
not raw stash data:

```json
{
  "at": 1792954000000,             // when the aggregate was computed
  "league": "Standard",
  "accountName": "YourName#1234",  // may be null
  "cdRatio": 215,                  // chaos per divine used for this snapshot
  "totalChaos": 18240.5,
  "totalDivine": 84.8,
  "tabs":       [ { "index": 3, "name": "Currency", "chaos": 9120.2, "items": 44,
                    "priced": 51, "unpriced": 6, "unpricedPieces": 9,
                    "skipped": 0 } ],
  "categories": { "currency": { "chaos": 9120.2, "items": 44 } },
  "topItems":   [ { "name": "Divine Orb", "kind": "currency", "count": 42,
                    "chaosEach": 215, "chaosTotal": 9030, "tabs": ["Currency"] } ],
  "items":      [ { "name": "Divine Orb", "kind": "currency", "tab": "Currency",
                    "tabIndex": 3, "qty": 42, "chaosEach": 215, "chaosTotal": 9030,
                    "source": "faustus" } ],
  "unpriced":   [ { "name": "Some Corpse", "kind": "corpse", "count": 2,
                    "tabIndex": 3 } ],
  "counts":     { "priced": 812, "unpriced": 40, "unpricedPieces": 44,
                  "skipped": 1907 }
}
```

`items[].source` names the feed that produced the price (`faustus`, `exchange`,
`ninja:currency`, `item:<type>`, `corpse:trade`, `chaos`, …); `null` for a row stored
before the field existed. The values are listed in `docs/pricing-logic.md`
("Which feed priced an item").

`tabs` is in in-game order (by `index`), `topItems` / `items` descend by
`chaosTotal` (`topItems` capped, `items` complete). `counts` are the original
GGG item counts, so "skipped" (rare/magic gear, non-unique maps) stays visible
instead of silently vanishing. The POESESSID never appears anywhere in it.

**Three units live in this object and they are not interchangeable.** Reading
one as another is what put "40 unpriced items" over a list adding up to 39:

| unit | what it counts | where |
| --- | --- | --- |
| **entries** | GGG stash entries — one slot, whatever it holds | `counts.priced` / `.unpriced` / `.skipped`, `tabs[].priced` / `.unpriced` / `.skipped` |
| **pieces** | the summed stack sizes of those entries | `items[].qty`, `topItems[].count`, `unpriced[].count`, `counts.unpricedPieces`, `tabs[].unpricedPieces` |
| **rows** | grouped display lines (`kind\|name\|price\|tab`) | `tabs[].items`, `categories[].items` |

`tabs[].items` counts rows and not entries because that is all the round trip
through the per-tab store can reconstruct: thirty Divine Orbs that arrived as
three stash entries come back as one row. `tabs[].priced` carries the stored
entry count next to it, so the page's per-tab tooltip can state three numbers in
the same unit.

`unpriced` carries one row per name **and tab** (`tabIndex`, the same key
`items[]` uses), so the page can apply its stash-tab selection to the unpriced
block as well; the list is capped at 100 names, ranked by total count. The cap
is account-wide, so a name with a single piece in one tab can be ranked out by
100 busier names in **other** tabs — which is why the row list alone cannot
state a faithful total. `counts.unpricedPieces` (whole snapshot) and
`tabs[].unpricedPieces` (per tab) can, and the summary line uses them to say how
many pieces the list is not showing. The line itself states the pieces and names
it *does* show, so it can never disagree with the list under it.

**That cap is a display limit, and it stops at the wire.** The net-worth history
recorder needs *every* unpriced name — a name in that set is proof the item is
still in the stash, which is how a lost price is told apart from an item leaving
(`docs/bugs.md` B2) — and a name the cap ranks out was invisible to it. The
recorder runs in the server and now folds the per-tab store directly
(`aggregate.mjs`, `unpricedStock`), so **no uncapped list was added to this
message**: `unpriced` is the same 100-name display list it has always been, and
snapshots stay the size they were.

`tabs[].skipped` is there for one question the page could not answer at all
before: a tab reading `chaos: 0, items: 0` means either that **nothing arrived**
from GGG or that everything arrived and the classifier dropped it (rare/magic
gear, non-unique maps). Those two look identical without this number — which is
why the empty map stash (`docs/bugs.md`, B7) could not be judged from the
screen. The classification itself is unchanged; only the count now travels.

### `networth-result` — a refreshed snapshot after a tab sync
```json
{ "type": "networth-result", "snapshot": { … } }
```
Per-room. Broadcast every time the background auto-refresher has finished
syncing **one** stash tab (default every 30s in total, shared round-robin
across the configured users — not once per user), so an open
page follows along live without polling. `snapshot` has exactly the shape shown
under `networth-latest` — the only difference is the trigger: `networth-latest`
answers a connect, `networth-result` announces a change.

The Net Worth page re-renders and then asks for `networth-history` again (the
new tab may have moved the total). The History page treats the message as a
plain "something changed" signal and re-fetches its series over HTTP
(`/networth-trend`, `/networth-events`), because the full series is far too
large to ride along on every 30s broadcast.

The frontend also tolerates `partial: true` plus an `error` string on this
message (render what is there, show the error above it) — a leftover from the
retired manual full-scan path, which could abort halfway. Nothing sends it
today.

### `networth-history` — the coarse total-over-time list (both directions)
```json
{ "type": "networth-history" }
```
Frontend → backend, no fields. Sent by the Net Worth page on connect and again
after every `networth-result`.

```json
{ "type": "networth-history", "items": [
  { "at": "2026-07-31T14:03:21.004Z", "totalChaos": 18240.5,
    "totalDivine": 84.8, "league": "Standard" } ] }
```
Backend → frontend, per-room, sent only as the answer to the request above.
`items` is ascending by time and holds **at most the last 50** points from the
`history` array that `networth-store.json` keeps alongside the tabs — a short
"recent totals" list for the Net Worth page, nothing more.

**In practice `items` is empty today.** Nothing on the server writes that array
any more (`store.appendHistory()` has no caller outside its own test), so it
only ever holds leftovers from an older store file. An empty list simply keeps
the page's recent-totals section hidden, which is why the message is still
exchanged: the real series moved elsewhere.

That real series is **not** this message. It lives in
`networth-history.ndjson`, is far denser (a point per minute, 15 days of
retention) and is fetched over HTTP (`/networth-trend`, `/networth-events`) by
the History page. Same idea, two different resolutions. A third endpoint,
`/networth-detail` (item detail behind one stretch of the trend line), also
exists server-side but is not called by the current History page — no shipped
frontend file references it.

**All three carry a RATE, and it is not decoration.**

```
/networth-trend    points: [[at, chaos, cd], …]     cd = chaos per divine at `at`
/networth-events   events: [{ at, from, points, c, cd, items, v }]
                                                    cd = the rate of the point the
                                                    bucket is stamped with (like `c`)
/networth-detail   { …, rateFrom, rateTo }          the rates at both ends of the interval
```

`cd` is `0` when no rate was known at that minute. The rule for a reader is the
same in all three: **a figure is converted with the rate of its own point**, and
a point that carries none borrows the nearest point of the same window that
does — never the newest rate of the series, and never a constant. That is the
whole reason the rate is stored per point (`networth/history.mjs`): a recorded
value must not be able to change afterwards. The History page therefore plots
divine (`chaos / cd`, per point) rather than chaos, and falls back to chaos only
for a window in which not one point carries a rate.

### `league-state` — the active league
```json
{ "type": "league-state", "active": "Standard", "lang": "en" }
```
Sent on connect and whenever any client changes the league (see `set-league`). The
frontend syncs its league dropdown to `active`.

`lang` is the client language of this user. It rides on the **opening** message
(the one sent right after the room assignment) and again on every **language
change** made through `POST /user-lang` — a `set-league` broadcast leaves it out,
because the league changed and the language did not. A page that has no WS
connection yet finds the same mapping in the `langs` object of `GET /users`.

The language is per user and changeable at runtime: it comes from
`/config/user-langs.json` if the user has ever chosen one, otherwise from
`POE_USER_LANGS` (see `docs/admin.md`). A page that receives a `league-state`
with a `lang` different from the one it is rendering in should re-read its
string table — the switch is meant to be visible without a reload.

### `data-status` — freshness of the auto-updated data sources (page status line)
```json
{ "type": "data-status", "enabled": true, "intervalMs": 86400000, "staleAfterMs": 259200000,
  "since": 1792808400000, "now": 1793608400000,
  "sources": [ { "source": "apt", "lastSuccessAt": 1793606400000, "lastOutcome": "unchanged",
                 "reason": null, "failKind": null, "warning": null } ] }
```
Broadcast on **connect** and after **every** check of the data auto-update
(`data-refresher.mjs`, one per source per day). Facts only — the page decides:
a source whose `lastSuccessAt` (fallback `since`, the first boot of the config
dir) is older than `staleAfterMs` gets an informational line in the page status
slot. `lastOutcome` is `updated` | `unchanged` | `failed`, `enabled` is false
when the auto-update is off or its dir isn't writable (the page then says
nothing). The client ages the timestamps itself against the server clock
(offset from `now` at arrival) and re-evaluates every minute, so a backend
whose schedule died without sending anything else still turns the line on.

`reason` and `failKind` describe the **last** check and are `null` unless it
failed. `reason` is the sentence the container log carries, filtered and capped
on the server (`check-failure.mjs`, `POE_DATA_STATUS_REASON_MAX`); `failKind` is
one of `unreachable` | `rejected` | `incompatible` | `unknown`, set at the site
that failed and never derived from the wording. The page prints the reason and
adds the sentence that belongs to the class — and for `unknown`, or a class it
does not know, it adds **nothing**: a duration plus a guessed cause is what this
field exists to replace (`docs/bugs.md` B24). A `failKind` the server does not
recognise never leaves the server at all — it is sent as `null`.

Two of them are shown **before** the source goes stale. `incompatible` is one:
that diagnosis is certain the moment it is made, and holding it back for three
days is the silence the whole field exists to end. `unreachable`, `rejected` and
`unknown` still wait, because there the age IS the information — an upstream
away for a minute is not news.

`warning` is the other, and it is **not** a failure. A check can succeed and
still have something to report; the case it was built for is a pinned
`POE_PATCH_VERSION` that the lookup disagrees with, where every check succeeds,
nothing ever goes stale, and the data set is frozen (`docs/bugs.md` B25). It is
filtered and capped exactly like `reason`, it is shown whatever `lastOutcome`
says and whatever the age is, and it carries **no** advice: it has no class, and
inventing a remedy for it would be the same mistake in a new place.

The status slot is **shared**: `Shell.setStatus(text, key)` keeps one message
per key (`sync` for `networth-sync-status`, `data` for this one, `release` for
`release-status`), renders them in the fixed order `sync`, `data`, `release` and
collapses the slot only when the last one is gone.

Which page draws which `networth-sync-status` state: the Net Worth and Settings
pages write the `sync` key themselves with their own, richer line (cooldown times,
`mine`, `tradeBan`). The History and Price Check pages use the shared line and show
`networth-sync-status` **only for `state: "expired"`** ("Background sync is paused:
the stored POESESSID has expired. Renew it on the settings page."); every other state
clears the key there, because cooldowns lift by themselves and `missing` is not a
pause.

### `release-status` — is a newer release of this tool out (page status line, settings page)
```json
{ "type": "release-status", "enabled": true, "installed": "0.1.0", "repo": "owner/name",
  "lastCheckAt": 1793606400000, "nextCheckAt": 1793692800000,
  "lastOutcome": "ok", "lastFailKind": null, "lastReason": null,
  "latest": { "version": "0.2.0", "tag": "v0.2.0", "url": "https://github.com/owner/name/releases/tag/v0.2.0",
              "publishedAt": "2026-11-01T00:00:00Z", "name": "0.2.0" },
  "comparison": "newer", "cooldownMs": 60000 }
```
Sent on **connect** and broadcast after **every** check of the release check
(`release-check.mjs`: automatic once a day, or the admin area's button). Facts
only — the page decides what to show.

- `enabled` — false when the automatic check is switched off (`POE_RELEASE_CHECK_DISABLED`); the manual check works anyway.
- `installed` — the root `package.json` version this server runs, or `null` when it could not be read (shown as "unknown", never guessed).
- `repo` — the GitHub repository asked (`POE_RELEASE_REPO`).
- `lastCheckAt`, `nextCheckAt` — epoch ms of the last check and of the next automatic one (always 24 h after the last, whatever its outcome); `null` before the first check.
- `lastOutcome` — `ok` | `none` (no release published yet) | `unchanged` (GitHub answered 304) | `failed`; `null` before the first check.
- `lastFailKind`, `lastReason` — set only when the last check failed. `lastFailKind` is `unreachable` | `rejected` (GitHub refused, usually its rate limit) | `incompatible` (the answer could not be read) | `unknown`; `lastReason` is the filtered, capped sentence the log carries. A failed check keeps the previous `latest`.
- `latest` — the latest release as last read, or `null`: `version` (without a `v`), `tag`, `url` (`null` if GitHub sent none), `publishedAt`, `name`.
- `comparison` — `newer` (latest is above installed) | `current` (equal or lower) | `unknown` (either side missing). Derived whenever the status is read, so a freshly updated server stops reporting `newer` at boot without waiting for the next check.
- `cooldownMs` — how long the manual check stays shut after a run.

---

## Frontend → Backend

Three of the four live here; the fourth, the `networth-history` **request**, is
documented above next to the answer it triggers.

### `search` — on-demand requery (never automatic)
Sent **only** when the user clicks a card's **Search** button. Carries the ticked
mods and their chosen roll range; the backend should give it priority over the
background queue and answer with a fresh `price-result` (and typically a
`queue-status` with `priorityActive:true`).

```json
{
  "type": "search",
  "id": "mageblood",
  "corrupted": "any",              // "any" | "yes" | "no"  (default "any" = unconstrained)
  "selectedMods": [
    { "text": "+36 to Dexterity", "min": 36, "max": 44 }   // `min`/`max` optional
  ]
}
```

`corrupted` sets the trade/APT misc corruption filter for this search: `"no"` →
only uncorrupted, `"yes"` → only corrupted, `"any"` → unconstrained. Demonstrably
changes the hit count (e.g. Mageblood/Standard: any 5365 = no 867 + yes 4498).

Each ticked mod with a slider carries a **dual range** (two handles: min + max):

- `min` — lower bound; **omitted** when the lower handle sits at the roll floor
  (no lower constraint).
- `max` — upper bound; **omitted** when the upper handle sits at the roll ceiling
  ("open upward", no upper constraint).

The backend writes both into the stat filter (`filter.value.min` /
`filter.value.max`); an omitted bound leaves that side unconstrained. A mod with
neither bound present is required but its roll is unconstrained.

The backend also keeps this payload with the card and hands it back as
`item-added.selection`, so a reconnect can re-render the picker the way the user
left it next to the price it produced.

### `set-league` — switch the active league
```json
{ "type": "set-league", "league": "Hardcore" }
```
Sets the **sending user's** league (per-room, see Multi-user routing) used for
trade queries **and** poe.ninja. The backend re-fetches the C:D + reference and
broadcasts `league-state` + `cd-ratio` + `reference` **only into that user's room**
(the other user's league is untouched; `queue-status` is unaffected). The league
list is offered over HTTP: `GET /leagues` → `{ "leagues": [...], "active": "..." }`
(from poe.ninja `economy/leagues`, cached ≥15 min, fallback `["Standard","Hardcore"]`;
`active` is `POE_USERS[0]`'s league — clients take their own from `league-state`).

### `dismiss` — user closed a card (`×` or "Clear all")
```json
{ "type": "dismiss", "id": "mageblood" }
```
The frontend removes the card immediately; the backend should drop any pending
work for that `id`.

## `GET /item-name-map` — item names for the page's language (HTTP)

```json
{ "lang": "de", "names": { "Chaos Orb": "Chaossphäre", "Mirror of Kalandra": "Spiegel von Kalandra" } }
```

Item names are not in the frontend string table and never will be — there are
thousands of them and they come out of the game data. Every message on the
socket carries an item under its **English reference name**, because that is
what the value join, the trade links and every price source are keyed by. This
endpoint delivers the display side of that: `refName → localized name`, read out
of `data/<lang>/items.ndjson` of the snapshot the engine currently parses with.

- **Identity** is the same `ppt_user` cookie as `/events`; the language comes
  from the same `POE_USER_LANGS` mapping `GET /users` answers with. No language
  is ever named in the URL. Unknown or missing user → `400`.
- **Primary language → `"names": {}`.** Not an identity table: there is nothing
  to translate, and the page skips the lookup in one branch. English pages never
  request it at all.
- **A name with no entry stays English** — no placeholder, no empty cell. A
  reference name whose localized name is ambiguous (two data lines disagree) is
  left out for the same reason.
- `cache-control: no-store` — a data-refresh swaps the snapshot underneath.

Applied in the renderer and nowhere else: net-worth rows, the *What moved* list
and the reference rail print the localized name while the row's English name
still drives the trade link and every lookup.

## `GET /item-names` — every item name, in the language the GAME runs in (HTTP)

```json
{ "lang": "de", "names": ["Cortex", "…"], "byRef": { "Chaos Orb": "Chaossphäre" } }
```

The exclusion universe for the **Stash Highlight** on the net-worth page, plus
the table that moves the wanted names into the same language. Not a display
answer: the string this feeds is pasted into the **game's** stash search, and
the game matches the names it prints (`docs/bugs.md`, B10).

- **The universe is `names ∪ values(byRef)`.** The two are disjoint — `names`
  carries only the spellings that need no translation — so no localized name is
  in the payload twice. `byRef` maps the **English reference name** a snapshot
  row travels under to the spelling the client prints.
- **Both halves, one answer, one language.** The generator shortens each wanted
  name against the universe; a wanted list in one language and a universe in
  another yields fragments that are unambiguous in a universe nobody searches.
  The page therefore derives both lists from this one object, and treats a
  missing/failed answer as "everything English on both sides".
- **Names only — and the game searches more than names.** The stash search reads
  the whole item text, flavour text included, and neither this answer nor any
  file in the data set maps a name to its flavour text. The generator therefore refuses
  fragments that look like everyday English words rather than proving them
  collision-free: a reduction of the risk, not a guarantee (`docs/bugs.md`,
  B21).
- **Identity** is the same `ppt_user` cookie as `/item-name-map`; the language
  is the same setting (`POE_USER_LANGS`, per-user override via `/user-lang`),
  read through its own accessor because it answers a different question.
  Unknown or missing user → `400`.
- **Primary language → `"byRef": {}`** and `names` is the plain full list.
- `cache-control: no-store` — the body is user-specific, and a data refresh
  swaps the snapshot underneath.

## `GET`/`POST /user-lang` — the user's own client language (HTTP)

```json
{ "user": "player1", "lang": "de", "available": ["en", "de"], "persisted": true }
```

The settings page reads this to draw the language selector and writes it back as
`POST /user-lang` with `{ "lang": "de" }`. Identity is the same `ppt_user`
cookie as `/events`; unknown or missing user → `400`.

- **No admin password.** This is the user's own setting, on the same page as his
  own POESESSID. Gating it behind the operator's password would put back exactly
  the problem it removes.
- `available` is the set of languages this server has a **live parser** for, not
  the set it supports in principle. A `lang` outside it → `400
  { "error": "…not available…", "available": [...] }` — moving a user onto a
  language with no parser would turn every item he pastes into a `503`.
- `persisted: false` means `/config` is not writable (a local run): the switch
  applies for the lifetime of the process and will not survive a restart.
- A successful `POST` answers `{ "ok": true, "user", "lang", "available",
  "persisted" }` **and** broadcasts `league-state` (with the new `lang`) into
  that user's room, so every open tab of his follows immediately.
- The value is written to `/config/user-langs.json` before the response goes
  out, and that file **beats `POE_USER_LANGS`** on the next start.

## `GET /config-view`, `POST /config-override`, `POST /restart` — runtime configuration (HTTP)

All three are behind the **same plaintext password** as `/admin/gaps`
(`X-Admin-Password`, checked per request, same two 401 bodies).

`GET /config-view`:

```json
{
  "settings": [
    { "name": "POE_APP_NAME", "description": "Display name in …", "type": "string",
      "maxLength": 60, "apply": "live", "defaultValue": "Trade Console",
      "value": "Trade Console", "overrideValue": null, "source": "default",
      "shadowsEnv": false, "envValue": null, "restartPending": false }
  ],
  "runtime": [ { "name": "POE_USERS", "value": "player1,player2" } ],
  "overridesPath": "/config/overrides.json",
  "quarantined": false, "rejectedPath": null, "problems": [],
  "restartPending": false,
  "adminGateIsDefault": true
}
```

- `settings` is the **allow-list** of keys the UI may write, and it is the one
  source the form is built from — `type` is `bool` | `int` | `string` | `enum`
  (with `values`, `min`, `max`, `maxLength` where they apply). Do not maintain a
  second copy in the frontend.
- `source` is `override` (the file in `/config`) | `env` (compose) | `default`.
  `shadowsEnv: true` means an override is winning over a value that is really
  set in the environment — show it, or somebody will spend an afternoon on it.
- `apply` is `live` (in force on the next request/tick) or `restart` (written
  now, in force after a restart); `restartPending` says a written value is
  waiting for one — it compares what the file asks for against what the process
  is really running with, so writing the compose value into the file is not
  announced as a pending change.
- `runtime` is a **read-only** list of the remaining effective settings so
  nobody has to go looking over SSH. It never contains anything secret — no
  POESESSID, account name, password or path to the credential file, in no form.
  Both halves are filtered by the same expression on the way out, and an entry
  whose name could name a credential is dropped **and** logged as the
  programming error it is.
- `quarantined` means repeated starts with these overrides never reached
  `listen` and the file was put aside (`rejectedPath`); saving anything clears
  it. `problems` carries the alarm's own text only while it stands, and never
  quotes the content of a file that failed to parse.
- `adminGateIsDefault` says the admin password is still the documented default.
  Named after the gate rather than the password because this endpoint refuses
  every field whose **name** could name a credential — no exceptions, not even
  for a field that holds none.

`POST /config-override` `{ "key": "POE_APP_NAME", "value": "Something" }` →
`200 { "ok": true, "name", "value", "applied": "live" | "restart-required" }`.
`"value": null` **removes** the override and falls back to compose/default.
An unknown key or a value that fails validation → `400 { "error": … }`, and
nothing is written.

`POST /restart` → `200 { "ok": true, "restarting": true }`, then the process
ends cleanly. Under docker `restart: unless-stopped` starts it again within a
second; run by hand it simply stops (there is no docker socket involved — see
the comment on the route).

## `GET /release-status`, `POST /admin/release-check` — the release check (HTTP)

`GET /release-status` → `200` with the same object as the WS message (without
`type`). **Open**: no admin header; it carries the installed version of a public
tool and the latest public release.

`POST /admin/release-check` runs the check now. Behind the admin password
(`X-Admin-Password`, see `GET /admin/gaps` below), and **not** locked by
`POE_RELEASE_CHECK_DISABLED`: that switch only stops the automatic check.

- `200 { "ok": true, "status": { … } }` — the check ran; a GitHub failure is in `status.lastOutcome` (`failed`), not in the status code.
- `409 { "running": true, "cooldownMs" }` — a check is already in flight.
- `429 { "retryAfterMs", "cooldownMs" }` — inside the 60 s cooldown after the previous manual check.
- `401` — missing or wrong admin password.

## `POST /admin/data-check` — run the data auto-update now (HTTP)

Behind the admin password (`X-Admin-Password`, see `GET /admin/gaps` below). Starts
the checks of the data auto-update (`data-refresher.mjs`) outside their daily
schedule, so an operator who has just corrected a setting need not wait for the next
tick. The guards live in the refresher, not in the route.

```json
{ "ok": true, "running": false, "retryAfterMs": null, "cooldownMs": 300000,
  "status": { "type": "data-status", … } }
```

- `200` — the check ran (`ok: true`); a failed source is in `status.sources[].lastOutcome`, not in the status code.
- `409` — a check is already running (`running: true`).
- `429` — inside the cooldown after the previous manual run; `retryAfterMs` says how long is left.
- `503` — nothing was run: the auto-update is switched off (`POE_DATA_REFRESH_DISABLED`) or its directory under `/config` is not writable.
- `401` — missing or wrong admin password.

`status` is the `data-status` object, so the page can redraw the answer it just
caused. `cooldownMs` is the configured cooldown (`POE_DATA_CHECK_NOW_COOLDOWN_MS`, default 5 min); it starts when a run finishes.

## `GET /update-status`, `POST /update-request` — the update button (HTTP)

Both behind the admin password. They are the container half of the update button
(`host-update.mjs`); the script that does the work runs on the Docker host
(`deploy/host-update.sh`, `docs/admin.md`).

- `POST /update-request` writes the request file into `/config` and builds no command →
  `200 { "ok": true, "requestedAt": "<ISO time>" }`, or `500 { "error": … }` when the
  file could not be written. The user cookie is recorded only if it names a
  configured user.
- `GET /update-status` → `200` with the three things the host leaves behind:
  `updater` (`installed`, `heartbeatAt`, `heartbeatAgeMs`, `maxAgeMs`, `pollMinutes`,
  `stuck`, `stuckSince`), `request` (`pending`, `requestedAt`, `requestedBy`) and
  `lastResult` (`status` `ok` | `failed` | `unknown`, `at`, `startedAt`, `finishedAt`,
  `output`, `truncated`; `null` before the first run). `build.commit` is the commit
  the image was built from, or `null`; `dir` and `requestPath` name the shared
  directory. `output` is host text, bounded and filtered, not a guarantee.

## `GET /health` — liveness (HTTP)

`200` with the plain-text body `ok`. No identity, no admin header; it touches no
state and starts no outbound request.

## `GET /admin/gaps` — the admin view (HTTP, not a WS message)

Not part of the socket at all: the settings page pulls it once when the admin
area is opened and again on "Reload". It carries what the tool could not do
(design doc, section 6) plus the offset between the language data sets.

Behind a **plaintext password** read from a file on the server
(`POE_ADMIN_PASSWORD_FILE`, default `/config/admin-password`, initial value
`admin`). The password is sent as the request header `X-Admin-Password` and
checked **on every request** — there is no session, no token and no expiry, and
no `/login` to go with it. The browser keeps the value in `sessionStorage`, so
the state ends with the tab and the server holds none at all.

- missing header → `401 { "error": "admin password required", "reason": "missing" }`
- wrong password → `401 { "error": "wrong admin password", "reason": "wrong" }`

```json
{
  "gaps": {
    "kinds": {
      "parse":      { "dropped": 0, "languages": [ { "lang": "de", "entries": [ … ] } ] },
      "unknownMod": { "dropped": 0, "languages": [ … ] }
    },
    "languages": ["de", "en"]
  },
  "skew": {
    "base": "en", "basePresent": true, "warnRatio": 0.005, "warn": false,
    "languages": [
      { "lang": "de", "present": true, "warn": false, "extra": 0,
        "metrics": [ { "key": "items", "base": 4738, "covered": 4738, "missing": 0, "ratio": 0, "warn": false } ] }
    ],
    "generatedAt": 1765200000000
  },
  "langBuild": [
    { "lang": "de", "present": true, "patch": "3.28.0", "builtAt": "2026-11-01T04:10:00Z", "run": { … } }
  ],
  "clientStrings": {
    "at": 1793606400000,
    "langs": { "de": { "enKeys": 2410, "langKeys": 2408, "missing": ["…"], "missingCount": 2,
                       "extra": [], "extraCount": 0 } }
  },
  "languages": ["en", "de"],
  "liveLanguages": ["en", "de"],
  "limits": { "maxEntriesPerKind": 200, "maxTextLength": 400 }
}
```

A gap entry is `{ kind, lang, text, reason, sample, count, firstAt, lastAt }`.
Entries arrive **already sorted by `count`** (descending, most recent first on a
tie) and grouped per language, so the page and the endpoint cannot disagree
about the order. `text` is the signature the count belongs to — the item-class
header for a parse failure, the mod line itself for an unresolved mod — and
`sample` is the full triggering text, truncated to `limits.maxTextLength`.

The list lives in memory only and is capped at `limits.maxEntriesPerKind` per
kind; `dropped` says how many rarer entries were evicted, so a truncated list is
never mistaken for a complete one. `skew.metrics[].key` is one of `items`,
`stats`, `matchers`, `advanced`.

`langBuild` has one entry per non-primary language: where the live localized set
came from (`build-info.json` in the active snapshot). A set without that file is
`{ "lang", "present": false }` — "unknown", not "nothing translated"; `run` is the
generator's own summary and `null` for a set older than it. `clientStrings` is the
drift of the localized `client_strings.js` against the English one (daily
refreshed): per language the key counts, and the first keys `missing` / `extra`
with their full counts; a language whose localized file could not be read is
`{ "unreadable": "<error>" }` instead. It is `null` when no check has produced one.
