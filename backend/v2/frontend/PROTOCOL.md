# WS `/events` protocol — Trade Console v2

The frontend opens a single WebSocket to `/events` (same origin, `ws://` or
`wss://` matching the page). All traffic is JSON, one object per frame.

**Every message carries a `type` discriminator** (the single channel needs it);
the remaining fields are exactly as specified below. There are **18 distinct
`type` values**: 15 that the backend (`server.mjs`) sends to the frontend and 4
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
  and reconnects once the cookie is set). `GET /users` → `{ "users": [...] }`
  offers the list for that picker.
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
  "mods": [
    {
      "text": "+36 to Dexterity",
      "kind": "explicit",          // implicit | explicit | prefix | suffix | fractured | crafted
      "tier": 6,                   // optional; number -> "Tier 6", string -> shown as-is
      "valueRange": [30, 50],      // optional; drives the slider min/max
      "value": 36,                 // optional; current roll + slider start; bolded inline in the text
      "selected": true             // pre-ticked in the mod picker
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
- `mods` are grouped in the picker by `kind` in the order implicit → fractured → prefix → suffix → explicit → crafted, each with a heading.
- A mod with `valueRange` gets a range slider (start = `value`); without it, a plain checkbox.

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
  "display": "single",             // single | bulk
  "currency": "divine",            // divine|div -> gold, chaos -> teal, exalted, mirror, ...
  "priceLow": 125,
  "priceHigh": 170,
  "count": 259,                    // listings (single) / sellers (bulk)
  "listings": [
    { "price": 128, "currency": "divine", "seller": "@Exilequeen", "ageMinutes": 4 }
  ]
}
```
Sets the item's status to `done`, fills the price block + listing rows, and flashes
the hit counter. `display:"bulk"` renders a `215 : 1` exchange ratio instead of a range.

### `queue-status` — the "Price queue" panel
```json
{
  "type": "queue-status",
  "depth": 3,                      // background queue depth
  "priorityActive": true,          // a priority (user) search is running
  "rateLimits": [
    { "policy": "trade-search", "used": 6, "limit": 8, "windowSec": 10 }
  ]
}
```
`rateLimits` render as coloured dots: green < 60 %, amber ≥ 60 %, red ≥ 85 % of `used/limit`.

### `rate-limit` — shared trade-queue ban banner (backend → frontend)
```json
{ "type": "rate-limit", "active": true, "retryAfterSec": 11538,
  "until": 1721740000000, "message": "GGG's trade API rate-limited the app — searches are paused (retry-after). Common at league launch under heavy load." }
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
  "refreshedAt": 1721745600000,
  "currency": [
    { "name": "Mirror of Kalandra", "display": "1710 div", "sparkline": [...], "invert": false, "src": "ninja" },
    { "name": "Dead Man's Sulphur", "display": "174 / div", "sparkline": [...], "invert": true, "src": "faustus" }
  ],
  "lifeforce": [
    { "name": "Vivid Lifeforce", "display": "1571 / div", "sparkline": [...], "invert": true, "src": "faustus" },
    { "name": "Wild Lifeforce",  "display": "11 / c",     "sparkline": [...], "invert": true, "src": "faustus" },
    { "name": "Primal Lifeforce","display": "—",          "sparkline": [],    "invert": true }
  ],
  "beasts": [
    { "name": "Vivid Vulture", "display": "9 div", "sparkline": [...], "invert": false, "src": "ninja" }
  ]
}
```
Feeds the left rail's three reference sections. Each row renders **name** (left),
**display** value (right, with its source marker) and a **mini sparkline** (same
`sparkSvg` helper as `ninja-ref`). An empty section array is simply omitted.

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
  `sell` badge — `src` describes the number, the badge carries its own stamp in
  its own tooltip.
- **refreshedAt** — epoch ms of the poe.ninja fetch behind this message, baked
  in server-side so a cache hit keeps the real time instead of "now". It stamps
  the `src: "ninja"` rows only.
- **sell** (optional, currency + lifeforce rows only) — the sell-side hint: which
  currency pays a SELLER of this item more right now. Derived from the
  SEPARATED Faustus per-market rates (X↔Chaos vs X↔Divine, matched-trade
  volumes — see `backend/v2/sell-side.mjs`) bridged at `cd`, the tool's single
  shared C:D. Shape:
  `{ "better": "chaos"|"divine"|null, "only": "chaos"|"divine"|null,
     "edgePct": 6.2|null, "viaChaos": 0.03841|null, "viaDivine": 0.03616|null,
     "cd": 172, "updatedAt": 1721745600000 }`
  - `better` + `edgePct` — a claimed comparison: both markets carry enough
    matched volume; the badge shows e.g. `c +6%`.
  - `only` — exactly one side is attested (the other is too thin or missing):
    the badge names that side WITHOUT a percentage, no comparison is claimed.
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
  object (`better` side, or the single attested `only` side) — so number, badge and
  sparkline all come from ONE source. Auto unit: `perChaos = 1/priceC`,
  `perDiv = ratio/priceC`; if `perChaos ≥ LIFEFORCE_PER_CHAOS_MIN` (server const, default 5) →
  `"N / c"`, else → `"N / div"` (much-per-chaos → per c; scarce-per-chaos → per div).
  No attested side (stale/foreign-league/disabled Faustus, or both markets too thin) →
  `display` is `"—"`, no `sell` field, `sparkline` `[]`. The row claims nothing; it never
  falls back to poe.ninja's market value, because the section is headed "Selling".
  These rows key their history under `s:<faustus name>`; the pre-sell-side `j:` points
  (poe.ninja market middles) are deliberately NOT reused and simply age out.
- **beasts** — from `stash/current/item/overview?type=Beast` (value in
  `chaosValue`/`divineValue`). Filtered `listingCount ≥ 100` (drops poe.ninja's
  untraded placeholders), sorted by `chaosValue` desc, top 5. Display `round(divineValue) div`
  when `divineValue ≥ 1`, else `round(chaosValue) c`.

Sent on **connect** (cached snapshot to the fresh client), on the **≥15 min poll**
(broadcast), and after a **`set-league`** switch (re-fetched + broadcast). Best-effort:
poe.ninja errors never throw; a missing section falls back to `[]`.

### `networth-sync-status` — background-sync state for the page status line
```json
{ "type": "networth-sync-status", "state": "expired", "until": 1721740000000 }
```
The **page status line** is the one-line slot every page reserves directly under
its heading (`#appStatus`); it stays collapsed while no sender has anything to
say.

Per-room. Sent on **connect** and whenever the net-worth refresher's state for
this user changes (auth pause entered/lifted, 429 cooldown entered) or the
user's credentials are saved through the settings dialog. `state` is one of:

- `ok` — background sync is running (the status line stays empty),
- `expired` — the stored POESESSID failed auth; the refresher paused this user
  until a new cookie is saved,
- `cooldown` — a 429 paused this user; `until` (epoch ms, only present here)
  is when syncing resumes on its own,
- `missing` — no credentials are configured for this user.

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
  "at": 1721745600000,             // when the aggregate was computed
  "league": "Standard",
  "accountName": "YourName#1234",  // may be null
  "cdRatio": 215,                  // chaos per divine used for this snapshot
  "totalChaos": 18240.5,
  "totalDivine": 84.8,
  "tabs":       [ { "index": 3, "name": "Currency", "chaos": 9120.2, "items": 44 } ],
  "categories": { "currency": { "chaos": 9120.2, "items": 44 } },
  "topItems":   [ { "name": "Divine Orb", "kind": "currency", "count": 42,
                    "chaosEach": 215, "chaosTotal": 9030, "tabs": ["Currency"] } ],
  "items":      [ { "name": "Divine Orb", "kind": "currency", "tab": "Currency",
                    "tabIndex": 3, "qty": 42, "chaosEach": 215, "chaosTotal": 9030 } ],
  "unpriced":   [ { "name": "Some Corpse", "kind": "corpse", "count": 2 } ],
  "counts":     { "priced": 812, "unpriced": 40, "skipped": 1907 }
}
```

`tabs` is in in-game order (by `index`), `topItems` / `items` descend by
`chaosTotal` (`topItems` capped, `items` complete). `counts` are the original
GGG item counts, so "skipped" (rare/magic gear, non-unique maps) stays visible
instead of silently vanishing. The POESESSID never appears anywhere in it.

### `networth-result` — a refreshed snapshot after a tab sync
```json
{ "type": "networth-result", "snapshot": { … } }
```
Per-room. Broadcast every time the background auto-refresher has finished
syncing **one** stash tab (default every 30s per configured user), so an open
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

### `league-state` — the active league
```json
{ "type": "league-state", "active": "Standard" }
```
Sent on connect and whenever any client changes the league (see `set-league`). The
frontend syncs its league dropdown to `active`.

### `data-status` — freshness of the auto-updated data sources (page status line)
```json
{ "type": "data-status", "enabled": true, "intervalMs": 86400000, "staleAfterMs": 259200000,
  "since": 1721600000000, "now": 1722400000000,
  "sources": [ { "source": "apt", "lastSuccessAt": 1722398000000, "lastOutcome": "unchanged" } ] }
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

The status slot is **shared**: `Shell.setStatus(text, key)` keeps one message
per key (`sync` for `networth-sync-status`, `data` for this one), renders them
in a fixed order and collapses the slot only when the last one is gone.

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
