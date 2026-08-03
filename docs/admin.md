# poe-price-tool — Admin

Architecture, deployment, and server config. For usage (access, hotkey setup) see the [README](../README.md). For how the Net-Worth tracker prices your stash (source routing, Faustus mechanics, corpse rules) see [docs/pricing-logic.md](pricing-logic.md).

## Architecture

Four parts — client daemon, backend, browser, and a set of always-on background
jobs feeding the Net-Worth tracker:

```
[Clipboard watcher (client)]         [Backend (Docker, home server)]              [Browser tab]
 copy an item                         backend/v2/server.mjs                        • item cards + mod filter
 → you copy the item                  • serves pages + data                        • History page
 → the daemon reads it                • WS /events (per user room)                 • Net Worth page
 → POST /item ──────────────────────▶ • POST /item                                 • live C:D + reference bar
                                       • poe.ninja (C:D, reference prices)
                                       • PoE trade API via APT's RateLimiter ────▶ pathofexile.com/trade

[Net-Worth background jobs, 24/7]     • Stash API (POESESSID cookie) ──────────▶ pathofexile.com/character-window
 auto-refresher (one tab/tick)        • Faustus CDN (public, no auth) ─────────▶ web.poecdn.com/api/currency-exchange
 Faustus refresher (hourly)           • Corpse pricer (Trade API, background
 corpse pricer (budgeted/hour)          queue tier) ────────────────────────────▶ pathofexile.com/trade

[/config volume, persisted]           networth-store.json · faustus-store.json · corpse-store.json
```

- **Engine reuse:** APT's parser + trade layer (`renderer/`, MIT license, copyright Alexander Drozdov) run **headless** — bundled via esbuild into `backend/v2/engine.bundle.mjs` (no Electron). Only `ws` is a runtime dependency.
- **Multi-user:** cookie `ppt_user` (one user per person, from `POE_USERS`) → separate rooms; **one** shared trade queue via APT's RateLimiter. Three-tier priority: manual search > paste (`auto`) > background jobs (corpse pricer) — background work never blocks normal operation.
- **Frontend:** static — `index.html` / `app.js` (price check), `networth.html` / `networth.js`, `history.html` / `history.js`. Served directly by the backend (no bundler).
- **Unrecognized mods:** the vendored APT stat DB can lag GGG (e.g. it lists 25
  sibling "Socketed `<tag>` Gems" stats but not Physical) — a mod it can't map
  used to just vanish from the card. `backend/v2/trade-stats.mjs` resolves such
  mods against GGG's own public stat catalogue
  (`https://www.pathofexile.com/api/trade/data/stats`) and splices anything it
  can resolve back into the search as an active stat; anything still
  unresolved is shown read-only as "not searchable" rather than silently
  dropped. This is a **data** endpoint, not the trade search — it does not go
  through the shared search `RateLimiter` and cannot cause a search ban.
  Fetched lazily, at most once per 24h TTL, only when an item actually has
  unknown mods, with a 10min cooldown after a failed fetch; every failure
  degrades silently back to "unresolved".
- **Client daemon:** `poe-price-daemon` (per machine) **polls the clipboard** — on a new value it runs `daemon/poe-price-post.sh`, which filters for PoE items, de-dupes, and POSTs. Polling (not `wl-paste --watch`) because XWayland game copies don't reliably fire change events. No key injection: you bind your key to PoE's own Ctrl+Alt+C copy. Chat macros (F5–F9) still run via evdev + ydotool. Details in the README.

## Deploy

The backend runs as **one** container behind a reverse proxy with **websockets enabled** (the browser tab holds a WS connection on `/events` — without a WS proxy the UI won't connect). **LAN-only, no auth — do not expose to the internet.** The stores persist in the `/config` volume; the user list comes from `POE_USERS`.

> The steps below are a **concrete example** — my Unraid homelab, with its own paths
> (`/mnt/user/appdata/…`) and internal LAN addresses (`192.168.178.29`). The general approach
> (Docker behind a reverse proxy with websockets) is what matters; adjust the paths and addresses
> to your own environment.

### Background load (runs 24/7, whether or not anyone has a tab open)

Three background jobs poll continuously, independent of any browser tab being
open — worth knowing before deploying on a shared or metered connection:

- **Corpse pricer** — up to `POE_CORPSE_BUDGET_PER_HOUR` (default 25) anonymous
  trade searches/hour, budgeted and capped.
- **Net-Worth auto-refresher** — one stash-tab read per tick (default 30s) **per
  configured user with a POESESSID** ≈ **~2,880 stash reads/day/user**, using
  that user's live session cookie.

None of this backs off when the tool is unused — there's currently no
"nobody's watching, pause everything" mode. A future idle-shutdown for the
background jobs is a plausible improvement, not implemented today.

### Rate limiting & bans

All trade-API traffic (price check, corpse pricer) shares one
queue and one ban detector, `backend/v2/rate-limit-signal.mjs`. It used to be
two independently-drifted regexes (server / corpse) — the corpse pricer's
copy only recognised the harmless client-side wording, so a real GGG ban fell
through its "local error" branch, set no cooldown, and it kept firing one job
every 30s straight into the ban. That drift caused two real trade-API bans this
league; the shared module exists so it can't happen again.

`classifyRateLimit(err)` returns `{ seconds, kind }`:

- **`client`** — APT's own local backpressure ("Retry after N seconds"),
  thrown *before* any request leaves the app. Usually pure pacing: a short wait
  stays quiet and causes only a local backoff. From `CLIENT_GATE_MIN_SEC` (300s)
  upwards it DOES raise the gate — a client-side wait that long means GGG's
  headers taught the limiter about a real ban ("Retry after 13283 seconds" was
  reported as `client`), and treating that as pacing kept the app hammering.
- **`server`** — GGG's real 429 ("Please wait N seconds…" / "rate limit
  exceeded" / plain 429). A request hit GGG and was rejected.
- **`block`** — a 403 soft-ban, a Cloudflare/WAF HTML challenge, or a JSON-parse
  failure (the engine hides the HTTP status, so the message itself is sniffed).

`server` and `block` always raise the **global ban gate**, `client` from 300s
up (see above): while a real ban is
active, `pump()` holds the *entire* queue — price-check, paste and background
jobs alike — so the app can't extend the ban by firing more requests into it.
An unref'd timer resumes the queue the moment the ban's `Retry-After` expires.
The browser shows this as an amber banner with a live countdown; the Search
button is blocked while it's up (so a user can't stack duplicate jobs behind
the gate that all fire the instant it lifts).



### Reading the log after a rate limit

Two things make a rate-limit banner explainable after the fact — both are pure
observation, neither sends a single extra request:

- **Timestamps.** Every log line starts with `2026-07-31T14:03:21Z` (UTC, to
  the second), installed centrally in `backend/v2/log-timestamps.mjs`. Without
  it a log shows the order of events but not the time, so a banner could not be
  matched against the requests that caused it — or told apart from the tail of
  an older window.
- **Consumer bookkeeping** (`backend/v2/trade-audit.mjs`). Every response from
  `/api/trade/*` is attributed to the consumer that triggered it —
  `price-check`, `corpse-pricer`, `data-refresher`,
  `stat-catalogue` — via an AsyncLocalStorage tag set where the request is
  dispatched, so no caller signature changed. It logs **two** kinds of line and
  no others:

  ```
  [trade-audit] rate limit 80% reached — consumer=price-check policy=search rule=Ip 8/10 in 10s (ban 60s if exceeded)
  [trade-audit] 429 from GGG — consumer=price-check policy=search rule=Ip 15/15 window=60s wait=300s; own requests in that window: corpse-pricer=4 price-check=2 (total 6) — this app only, other traffic from this IP (e.g. the trade site in a browser) is not counted
  ```

  The threshold line is **edge-triggered** per rule+window: one line when a
  window first gets tight, nothing again until it has fallen back below.

The counts are deliberately marked as ours alone. Trade searches go out
**anonymously**, so GGG limits them **per IP** — and the container shares its
public address with everything else in the household, the user's own browser on
`pathofexile.com/trade` included. That traffic cannot be seen from here. A
*small* number next to a 429 is therefore the useful answer: the load was not
ours, and there is nothing to hunt for inside the app.

### What's in the image

Multi-stage build (`Dockerfile` in the repo root):

- **build** (`node:20`): installs the root deps (`ws`, plus the `esbuild`
  devDependency that does the bundling) and the renderer deps (`fnv1a`, for the
  search indices), builds the self-contained engine bundle
  (`node backend/v2/build.mjs` → `engine.bundle.mjs`) and generates the
  search indices (`*.index.bin`, gitignored → generated here).
- **runtime** (`node:20-slim`): only what's needed at runtime —
  `node_modules/ws`, `backend/v2/{server.mjs, engine.bundle.mjs, frontend/,
  data-refresher.mjs, apt-index.mjs, …}` and `renderer/public/data`. The data
  auto-update regenerates the search indices at runtime via `apt-index.mjs`
  (pure Node, no `renderer/node_modules` needed in the image). The path relation
  `backend/v2/` ↔ `renderer/public/data` is preserved (the default data path in
  `engine.mts` is relative). The server process runs as UID 1000; PID 1 starts
  as root and drops to it — see the /config permissions note below.

The only runtime dependency is `ws`; the bundle is self-contained.

### Build & run

```bash
cd /path/to/poe-price-tool
docker compose up -d --build
```

Verify:

```bash
curl -s http://127.0.0.1:8788/health     # → ok
curl -s http://127.0.0.1:8788/users      # → {"users":["player1","player2"]}
docker compose logs -f poe-price-tool
```

Then open `http://192.168.178.29:8788/` in your browser and pick the user once.

### Environment (all optional, defaults in the server)

In `docker-compose.yml` under `environment:` as a commented-out template:

| Env                 | Default    | Meaning                                                    |
|---------------------|------------|-------------------------------------------------------------|
| `PORT`              | `8788`     | Server port (must match the port mapping)                  |
| `POE_LEAGUE`        | `Standard` | Starting league (each user can switch it in the browser). **Faustus/Corpse pricing is pinned to this one league, not per-user** — see "Single-league coupling" below |
| `POE_USERS`         | `player1,player2` | fixed user list (no login, just routing)            |
| `POE_APP_NAME`      | `Trade Console` | display name in the header/title of the landing page; set e.g. `POE_APP_NAME=YourName` |
| `POE_MAX_LISTINGS`  | `10`       | trade listings per search (hard-capped at ≤10)             |
| `POE_CD_RATIO`      | `215`      | Chaos:Divine fallback when poe.ninja is unreachable        |
| `POE_CD_REFRESH_MS` | `900000`   | C:D refresh interval (min. 15min due to poe.ninja rule)    |
| `POE_NETWORTH_STORE` | `/config/networth-store.json` | path of the per-tab net-worth store (persistent in the /config volume) |
| `POE_NETWORTH_CONFIG` | `/config/networth-users.json` | path of the per-user credentials file (accountName + POESESSID) |
| `POE_NETWORTH_AUTOSYNC` | on | background auto-refresher for the net-worth store; `=0` disables it |
| `POE_NETWORTH_SYNC_INTERVAL_MS` | `30000` | delay between auto-refresher ticks (one tab refreshed per tick) |
| `POE_NETWORTH_LIST_TTL_MS` | `900000` | how long the cached stash-tab list is considered fresh |
| `POE_NETWORTH_COOLDOWN_MS` | `600000` | backoff after a 429 before retrying a user |
| `POE_NETWORTH_HISTORY` | `networth-history.ndjson` next to `POE_NETWORTH_STORE` (so `/config/networth-history.ndjson`) | path of the value-over-time series behind the History page. Its item sidecar is derived from this path (`…-items.json`) and cannot be set separately — see "History page" below |
| `POE_STASH_TIMEOUT_MS` | `30000` | per-request timeout for a stash read (~30s). Raise it only if the stash endpoint is genuinely slow for you; a timeout costs one tab, and the refresher picks that tab up again on a later tick |
| `POE_STASH_PROBE` | unset | **diagnostics only.** Set to a stash-tab index to run one folder-tab probe at startup, for the first configured net-worth user, logging the response keys and item count per addressing variant. Leave it unset in normal operation |
| `POE_NETWORTH_DEBUG` | unset | `1` logs one diagnostic line per scanned stash tab (`raw`/`priced`/`unpriced`/`skipped`) — use it to tell "the tab came back empty" apart from "every item was skipped" |
| `POE_FAUSTUS_STORE` | `/config/faustus-store.json` | path of the Faustus (GGG Currency Exchange) name→chaos store (persistent in the /config volume) |
| `POE_FAUSTUS_DISABLED` | *(off)* | `1` disables the Faustus background refresher entirely (fungible pricing falls back to poe.ninja) |
| `POE_FAUSTUS_UNION_HOURS` | `8` | how many completed hourly Faustus digests to union (most-recent market wins) before deriving prices |
| `POE_FAUSTUS_REFRESH_MS` | `3600000` | Faustus refresh interval; the underlying data itself only changes hourly, so refreshing faster gains nothing |
| `POE_FAUSTUS_TTL_MS` | `172800000` | max staleness (~48h) before the valuator treats the whole Faustus store as absent and falls through to poe.ninja; guards against the CDN feed silently freezing prices. Generous because the refresh is hourly and unions several completed hours |
| `POE_CORPSE_STORE` | `/config/corpse-store.json` | path of the itemised-corpse price store (name→chaos, Trade-API sourced; persistent in the /config volume) |
| `POE_CORPSE_DISABLED` | *(off)* | `1` disables the corpse background pricer entirely (corpses stay honestly unpriced) |
| `POE_CORPSE_TTL_MS` | `21600000` | how long a cached corpse price (or cached "no listings") stays fresh before a re-query (~6h; corpses move slowly) |
| `POE_CORPSE_BUDGET_PER_HOUR` | `25` | max distinct corpse names queried on the Trade API per rolling hour (stalest/unpriced first); caps the first-snapshot burst |
| `POE_CORPSE_INTERVAL_MS` | `120000` | delay between corpse pricer ticks (one name priced per tick) |
| `POE_REFERENCE_HISTORY` | `/config/reference-history.ndjson` | path of the reference rail's own price series (one point per reference refresh, i.e. ≥15min apart) — the sparklines next to the rail rows are drawn from it |
| `POE_RATE_LIMIT_STATE` | `/config/rate-limit.json` | path of the persisted ban gate, so a restart resumes an active cooldown instead of probing GGG blindly |
| `POE_MAX_ITEMS_PER_ROOM` | `50` | server-side cap on item cards held per room; the oldest is evicted (and an `item-removed` sent) when a new one arrives. A negative value is clamped to 1; `0` (like an unset or unparsable value) falls back to the default |
| `POE_MAX_REQUEUE_ON_RECONNECT` | `10` | how many priceless cards a single WS reconnect may re-queue (newest first). Caps the queue flood after a poe.ninja/Trade outage; the remaining cards replay as `queued` and can be searched on demand |
| `POE_RATE_LIMIT_BANNER_MIN_SEC` | `60` | a rate-limit wait shorter than this is handled quietly (local backoff only); from this many seconds up the browser shows the amber ban banner with a countdown |
| `POE_DATA_REFRESH_MS` | `86400000` | data auto-update interval (~daily): APT item/stat data and `base-names.json` — see "Data auto-update" below. Conditional requests, so an unchanged day transfers nothing |
| `POE_DATA_REFRESH_DISABLED` | *(off)* | `1` disables the data auto-update fetching; a valid snapshot already persisted under the refresh dir is still preferred at boot (wipe the dir to fully reset to the baked-in data) |
| `POE_DATA_REFRESH_DIR` | `/config/data-refresh` | where adopted data snapshots and the update state persist (survives redeploys) |
| `POE_LOG_TIMESTAMPS` | on | `0` drops the `2026-07-31T14:03:21Z` prefix from every log line (only useful when an outer log collector stamps them itself) |
| `POE_TRADE_AUDIT` | on | `0` disables the trade rate-limit bookkeeping (the two `[trade-audit]` lines). Observation only — it never influences pacing |
| `POE_TRADE_AUDIT_THRESHOLD` | `0.8` | fraction of a rate-limit window that triggers the "getting tight" line |
| `POE_DATA_STALE_TICKS` | `3` | how many missed checks make a source "stale" in the UI status line. Relative to `POE_DATA_REFRESH_MS` (3 × 24 h = 3 days), never an absolute duration |

> **Per-deployment settings go in a (gitignored) `docker-compose.override.yml`** next to the
> compose file — `git pull` never touches it, so they survive updates. Put your user list
> (`POE_USERS`), display name (`POE_APP_NAME`), and any other per-instance env here:
> ```yaml
> services:
>   poe-price-tool:
>     environment:
>       - POE_USERS=youruser,teammate
>       - POE_APP_NAME=YourName
> ```
> **Applying changes:** env-only changes take effect on the next `docker compose up -d` (the
> container is recreated and re-reads its env) — **no `--build` needed**. A code update needs the
> full `git pull && docker compose up -d --build`.

### Single-league coupling (multi-user pitfall)

`POE_LEAGUE` is a **single, server-wide** setting — but it's only the *starting*
league; each user can switch their own league in the browser (per-room, see
`set-league` in [PROTOCOL.md](../backend/v2/frontend/PROTOCOL.md)). Switching
only changes what the **price check** queries. It does
**not** move the Faustus store or the corpse store — both are pinned to whatever the
background jobs were configured with, effectively `POE_LEAGUE` at deploy
time.

**Net Worth pays for this silently.** If a user switches their browser league
away from the one the background jobs actually price, their net-worth
valuation quietly gets worse without any error:

- Fungibles (currency, essences, scarabs, …) lose the Faustus source entirely
  and fall back to poe.ninja only (Faustus has no per-league selector on our
  side — it's whatever the store was built from).
- Itemised corpses go **completely unpriced** — the corpse store only ever
  holds prices for the league the background pricer targets.

This mostly matters right at league start, when someone forgets to flip their
own browser league over from the previous one. There's no per-user override
today — if you run multiple leagues for different players, know that only
one of them gets full Net-Worth coverage.

**POESESSID:** the **price check** works **anonymously** — no cookie needed
(the shared RateLimiter queue suffices). The **Net Worth tracker** does need a per-user POESESSID —
see its section below (stored in `/config/networth-users.json`, never in the repo).

### `/config` volume

`./config:/config` is mounted for:

- **`networth-history.ndjson`** — the value-over-time series behind the History
  page: one appended line per user per minute, 15 days of retention. Its sidecar
  `networth-history-items.json` carries only the newest per-item breakdown, so a
  restart does not tear a hole into the series.
- **`reference-history.ndjson`** — the reference rail's own price series
  (`POE_REFERENCE_HISTORY`).
- **`rate-limit.json`** — the persisted ban gate (`POE_RATE_LIMIT_STATE`), so a
  restart resumes an active cooldown instead of probing GGG blindly.
- **`networth-store.json`** — the per-tab net-worth store; see the Net Worth section below.
  It holds the CURRENT snapshot. The value-over-time series lives beside it in
  `networth-history.ndjson` (plus its `networth-history-items.json` sidecar).
  Either way the answer is the same: back up `/config`, or accept that a volume
  loss erases both the snapshot and the history.
- **`faustus-store.json`** — the Faustus (GGG Currency Exchange) name→chaos map, refreshed
  hourly in the background. Persisted because GGG deletes old Faustus history — on boot the
  server loads this last-good map so fungible valuation works immediately, without waiting for
  the first hourly refresh.
- **`corpse-store.json`** — itemised-corpse prices (name→chaos), sourced from the official
  Trade API by a budgeted background pricer (`POE_CORPSE_BUDGET_PER_HOUR` names/hour, stalest
  first) and cached ~6h (`POE_CORPSE_TTL_MS`). Both prices **and** empty results (illiquid
  corpses) are cached so a snapshot never re-fires a slow, rate-limited search. The valuation
  route only reads this store — it never queries the Trade API inline. `Imperfect …` corpses
  are valued 0 without any query. An expired POESESSID trips a **circuit-breaker** (all corpse
  trade calls short-circuit until the cookie is renewed) rather than hammering GGG with 401s.
- **`data-refresh/`** — adopted data-source snapshots + update state of the background
  data auto-update (see the section below). Contains versioned copies of the APT
  item/stat data (`apt/v-…/`), plus `base-names.json` and
  `state.json` (the stored `ETag`/`Last-Modified` validators). Safe to delete as a
  whole — the server falls back to the image's baked-in data and re-fetches on the
  next check.
- persistent per-user config (POESESSID, later `state.json`). POESESSID is only needed
  if rate limits get too tight (anonymous is usually enough).

**How the container handles /config permissions.** PID 1 starts as **root** on
purpose (`docker-entrypoint.sh`) and drops to the service user itself; there is
no `USER` directive in the Dockerfile. The reason: docker creates a missing
bind-mount target as `root:root` (755), while the service runs as UID 1000 — so
out of the box every write failed with `EACCES` and nothing persisted, silently.

The entrypoint decides by OWNERSHIP, after checking whether the service user can
actually create a file there:

- **Owned by root** — that is the folder docker created because the bind-mount
  target did not exist. Nobody else has a claim on it, so the entrypoint takes
  it (`chown -R`).
- **Owned by anyone else** — a NAS share (Unraid uses `nobody:users`) or a
  deliberate choice by the operator. Ownership is then left alone: the
  entrypoint tries to join the folder's group instead, and if that does not
  work it says so in the log rather than rewriting the share behind your back.
  Taking over a share can break SMB access to the same folder, and the operator
  cannot easily undo it.

An earlier version tested writability with `test -w` and chowned whenever that
failed. On a share that is group-writable for a group the service is not in
(exactly the Unraid case) the test reports "not writable", so it rewrote the
share's ownership recursively — including every existing file. That is why the
owner, not the permission bits, decides.

Afterwards it `exec`s the server under UID 1000 via `setpriv`, so the server
itself never runs as root. Pinning `user:` in compose still wins: the script
then runs unprivileged and simply execs the command.

If the log says `/config is owned by uid N and not writable`, fix it once by
hand — the entrypoint deliberately does not:
```bash
ssh your-server 'chown -R 1000:1000 /mnt/user/appdata/poe-price-tool/config && docker restart poe-price-tool'
```
Never a blanket `chmod -R 777` on `/config`: that would make
`networth-users.json` (POESESSID session cookies — full account control if
leaked) world-readable *and* world-writable, contradicting the `chmod 600` it
needs (see the Net-Worth-Tracker section below).

Verify: `ls -la …/config` → the store files should appear shortly after start.

### Data auto-update (background)

The three vendored data sources go stale with every league patch, and the failure is
silent (an unknown unique parses as `item.unknown`, an unmapped metadata id drops out
of the net-worth valuation). The server therefore keeps them fresh **itself**
(`backend/v2/data-refresher.mjs`) — no manual step, no redeploy:

| Source | Feeds | Upstream |
|---|---|---|
| APT item/stat data (`renderer/public/data/en/*`) | price-check parser, mod matcher, net-worth item classification | Awakened PoE Trade `master` |
| `base-names.json` | Faustus metadata-id→name bridge | `repoe-fork.github.io/base_items.json` |

How it behaves:

- **~Daily checks** (`POE_DATA_REFRESH_MS`), plus one look **shortly after every boot**
  (staggered 2/7/12 min, so a restart right after a league patch picks the new data up
  within minutes). The three sources never fire at the same moment.
- **Conditional requests**: stored `ETag`/`Last-Modified` validators are sent along; on
  a day without upstream changes not a single payload byte flows.
- **Validate before adopt**: a download is parsed and schema-checked (the same join
  fields the net-worth bridge relies on, plausible line counts, importable
  `client_strings.js`, a non-collapsed seed) and its search indices are regenerated
  **before** anything is swapped in. A broken or truncated download is rejected with a
  warning and the old data stays — a dead upstream can never take the tool down.
- **Effective at runtime**: an adopted APT snapshot is hot-loaded into the engine
  (versioned dirs under `data-refresh/apt/`, engine reload with automatic rollback if
  the reload fails); a new base-names map reaches the Faustus pricer with its next
  hourly tick. No restart,
  no self-restart.
- **Persistent**: adopted snapshots live under `POE_DATA_REFRESH_DIR` in the `/config`
  volume and are preferred at the next boot, so updates survive redeploys. If the dir
  isn't writable (local run without the volume), the feature silently disables — like
  the other `/config` stores.
- **One line per check** — the whole point being that silence means "not running",
  never "nothing to do". Three sources checked once a day = three lines a day:

  ```
  [data-refresh] apt check updated — APT data updated (v-2026-07-31T04-02-11-903Z): items.ndjson 41988->42130 lines (+150/-8); upstream Tue, 29 Jul 2026 22:14:07 GMT -> Thu, 31 Jul 2026 03:41:52 GMT
  [data-refresh] base-names check unchanged — upstream reported no change (304); data from 2026-07-24T04:07:19.310Z
  ```

  The detailed `REJECTED` / `could not be applied` warnings appear above the
  outcome line — they carry the reason, the outcome line carries the outcome.
- **Visible when a source goes quiet**: every check persists its timestamp in
  `data-refresh/state.json`; the server hands the last **successful** check per source
  to the browser (`data-status`, see `frontend/PROTOCOL.md`). A source whose last
  success is older than `POE_DATA_REFRESH_MS × POE_DATA_STALE_TICKS` (default 3 ticks =
  3 days) shows up in the status line every page reserves under its heading —
  informational, the tool keeps running with the data it has. The ageing happens in
  the browser, so a schedule that died without ever sending another message still
  surfaces.

The manual CLIs (`npm run update-apt-data`, `node backend/v2/base-names-gen.mjs`)
still exist — as the way to refresh the **checked-in** copies in the repo (so a fresh
image also starts reasonably current), and as an emergency hatch. They are no longer
needed to keep a running deployment current.

### Net-Worth-Tracker (`/networth.html`)

Reads the whole stash via the legacy `character-window/get-stash-items` endpoint
using the **POESESSID** session cookie (ToS gray area, personal use only —
knowingly accepted).

**Folder tabs (Unique Collection, Map tab).** The legacy endpoint always answers
with an EMPTY `items` array for these — their items live in sub-folders it has
no address for (measured: `subIndex=0/1` and `tabs=1` return byte-identical
`items=0`; passing the tab id yields HTTP 404). Those two types therefore go
through the site's newer stash endpoint, same cookie session, two levels deep:

    GET /api/stash/<league>/<tabId>            -> { stash: { children: [{ id, … }] } }
    GET /api/stash/<league>/<tabId>/<childId>  -> { stash: { items: [ … ] } }

(`/api/stash/<league>` without an id answers 403, so the tab LIST still comes
from the legacy endpoint.) One such tab costs `1 + N` requests — the Unique
Collection tab has 17 sub-folders — but it runs through the same sequential
`requestUrl()` as everything else, so the rate-limit headers, the backoff and
the timeout all apply unchanged, and a tab only comes up every few minutes.
This endpoint is undocumented: anything unexpected degrades to "tab empty" and
logs a warning; only auth/rate-limit propagate (cookie and ban protection).

**The POESESSID is needed for this one feature only.** The price check works
fine without it (see "POESESSID" above), so the cookie is optional for the tool
as a whole and required just for the Net-Worth tracker.

Credentials per user live in `/config/networth-users.json` (in the
`./config` volume, **never in the repo**, `chmod 600`):

    {
      "player1":  { "accountName": "YourAccountName#1234",  "poesessid": "<cookie value>" },
      "player2": { "accountName": "OtherAccountName#5678", "poesessid": "<cookie value>" }
    }

The key of each entry must match a name in `POE_USERS` (the player's room).
**`accountName` must be the full name including the discriminator**, e.g.
`Name#1234` — the bare name without `#1234` is the most common cause of
`HTTP 403 (forbidden)` (you can only read your own stash, and the game
matches on the full name). If the name is definitely right and it still 403s,
one untested possibility is the account's profile privacy setting — this has
only ever been run against a **public** profile, so whether a private one can
read its own stash through this endpoint is unknown here. Multiple players = multiple entries, each gets
their own, separate snapshots. The file is **re-read every auto-sync
round** — adding a player or rotating a cookie needs no restart.

The container runs as UID 1000 (`node`) — the file must be **readable** by
that UID, otherwise the background sync fails with `EACCES: permission
denied`. Created it as `root`? Make sure UID 1000 can read it, e.g. via
`chown 1000:1000` (stays tight, e.g. `600`):

```bash
chown 1000:1000 config/networth-users.json
```

If ownership doesn't take effect (see the shfs caveat above), fall back to a
more permissive `chmod` (e.g. `644`) instead. Verify by checking the
background sync gets past the `EACCES` on its next tick (`docker compose
logs -f poe-price-tool`).

On a server without an editor, write the file over SSH — **avoid** a plain
`echo '{ ... poesessid ... }' | ssh …` one-liner: the whole cookie value ends
up as a literal argument on the local command line and lands in your shell
history (`history | grep poesessid` would surface it later). Write it to a
local file first (never as a command-line argument) and copy that over
instead, then remove the local copy:

```bash
cat > /tmp/networth-users.json <<'EOF'
{ "player1": { "accountName": "YourAccountName#1234", "poesessid": "<cookie>" } }
EOF
scp /tmp/networth-users.json <your-server>:/path/to/poe-price-tool/config/networth-users.json
rm /tmp/networth-users.json
ssh <your-server> "chmod 600 /path/to/poe-price-tool/config/networth-users.json"
```

(The heredoc body only exists in the local temp file, not as ssh/scp argv —
replace the placeholders with your real values before running it, and the
cookie should never end up in the repo.)

Getting the cookie: log in on pathofexile.com → browser DevTools → Cookies →
copy `POESESSID`. If the cookie expires (the background sync logs a
401/403 and pauses that user until the cookie is renewed), just refresh

**Why it expires so often:** every new login invalidates the previous
POESESSID — including logging in through your PoE account on a third-party
site (Filterblade and similar). A paused user after such a login is expected
behaviour, not a fault of the sync.
the value in the file — no restart needed (credentials are re-read every
sync round).

**Preferred way to set/renew credentials: the UI.** The Net Worth page has a
"Sync settings" dialog (button top right; the status line "POESESSID expired…"
opens it too) where the current user sets `accountName` + `POESESSID`
themselves. It writes the same `networth-users.json` atomically with `600`,
touching only that user's entry, and the refresher picks the change up on its
next tick. The stored POESESSID is never sent back to the browser in any form
(`GET /networth/credentials` returns account name + sync state only). The page
also shows the sync state per user (`ok` / `expired` / `cooldown` / `missing`)
in the global status line. Everything below (SSH/heredoc/docker-exec) remains
as the fallback for when the app itself is down. Note: if the env override
(`POE_SESSID`) is set for a user, it keeps winning over the file — a cookie
saved in the UI won't take effect for that user until the env var is removed.

**POESESSID lifecycle (per community reports/web, not officially documented
by GGG):** logging out invalidates the POESESSID, and logging back in issues
a fresh one. So after any re-login (browser, another device, session expiry),
the old cookie stops working and `networth-users.json` needs the new value.

**Rotate the cookie without an editor** (e.g. on Unraid): reads the new
POESESSID from a hidden prompt (never echoed, never in shell history) and writes
it via the container's own node — no editor needed, and the secret never touches
the command line. Replace `player1` with the target user. The background refresher
re-reads the file on its next cycle, so normally no restart is needed:

```bash
ssh -t your-server 'read -rsp "New POESESSID for player1: " S; echo; docker exec -e S="$S" poe-price-tool node -e "const fs=require(\"fs\"),f=\"/config/networth-users.json\",d=JSON.parse(fs.readFileSync(f));d.player1.poesessid=process.env.S.trim();fs.writeFileSync(f,JSON.stringify(d,null,2));console.log(\"ok, poesessid length\",d.player1.poesessid.length)"'
```

Never put the cookie on the command line, in an env you export interactively, or
into a chat — it is a full account session token; type it only into the hidden
`read` prompt. If the refresher is mid-cooldown after an expired-cookie pause and
you want it to retry the new cookie immediately, `docker restart poe-price-tool`.

Alternative via env: `POE_SESSID` + `POE_NETWORTH_ACCOUNT` (+
`POE_NETWORTH_USER`). The credentials file path itself is redirectable via
`POE_NETWORTH_CONFIG` (default `/config/networth-users.json`).

**Architecture — per-tab store + continuous auto-refresher (the only sync
path, 24/7):** every stash tab is written immediately to `POE_NETWORTH_STORE`
(`/config/networth-store.json`) as its own entry, so the store is never
all-or-nothing. A background auto-refresher (enabled by default,
`POE_NETWORTH_AUTOSYNC=0` disables it) continuously walks each configured
user's tabs **one tab per tick** (`POE_NETWORTH_SYNC_INTERVAL_MS`, default
30s), always picking the globally stalest tab next — the same low-load,
rate-limit-safe pattern as every other background consumer. The
stash-tab list itself is cached for `POE_NETWORTH_LIST_TTL_MS` (default
15min). On a 429 a user backs off for `POE_NETWORTH_COOLDOWN_MS` (default
10min) before the next try.

**Why a drip-feed and no manual full-scan button:** a standard-size stash
(~115 tabs) fetched back-to-back in one burst runs straight into GGG's
trade-API rate limit (429, aborts partway). The auto-refresher avoids this
entirely by spreading requests over time (one tab/~30s) instead of bursting
— there is no manual trigger; a full stash fills in over one refresher cycle
(~115 tabs × 30s ≈ 1h), then stays fresh in the background indefinitely.

The `/networth.html` page itself is **read-only** — it just displays
whatever the background auto-sync has built up so far, no button, no
user-triggered action. Priced: stackables (currency/fragments/essences/
scarabs/fossils/resonators/oils/tattoos/omens/delirium orbs/artifacts, via
Faustus first), div cards, unique items, gems, beasts,
incubators, vials, Maven's Invitations, and itemised corpses (via
the Trade API); **rare/magic gear and non-unique maps
are deliberately out of scope** and show up as "skipped". Full source
routing and the rules behind each category: [docs/pricing-logic.md](pricing-logic.md).

### History page (`/history.html`)

The History page draws the net-worth series over time — a trend chart plus the
stock movements behind it ("what came in, what went out"). It has no data
source of its own: it reads what the Net-Worth auto-refresher records as it
walks the stash, over three read-only endpoints (`/networth-trend`,
`/networth-events`, `/networth-detail`, identity via the same `ppt_user`
cookie). Selectable ranges are 1h, 6h, 24h, 7d and 14d.

**Where the data lives.** Two files in the `/config` volume:

- **`networth-history.ndjson`** (`POE_NETWORTH_HISTORY`) — the series itself,
  one JSON object per line, append-only. Each point carries the total in chaos,
  the C:D rate **of that moment** (so an old point is never re-derived with
  today's rate), a per-tab breakdown keyed by stash-tab index, and the biggest
  item movers since the previous point.
- **`networth-history-items.json`** — a sidecar holding only the **newest**
  per-item breakdown per user. It exists so a container restart does not tear a
  hole into the series: without it the first point after every deploy would
  carry no delta. Its path is derived from the NDJSON path and cannot be set
  separately.

Neither file contains an account name or a POESESSID — only the local routing
name from `POE_USERS`, item names, and tab indexes.

**How often a point is recorded.** The auto-refresher offers one after every
synced tab (i.e. roughly every 30s per user), but the history module throttles
that down to **at most one point per minute per user**. There is nothing to
schedule and no separate job.

**How long it is kept, and how big it gets.** Retention is **15 days** — the
longest selectable range (14d) plus a day of slack. At one point per minute
that is ~21,600 lines per user over the full window, which in practice means a
file of a few MB; the sidecar stays flat at roughly 130 KB per user because
only the newest breakdown is ever kept. Retention is applied on load and, while
running, about hourly: the file is only rewritten when there is actually
something to drop.

Everything here is rebuildable convenience data, not a backup. A missing,
empty, truncated or corrupt file never throws — unparsable lines are skipped
individually, so a hard container kill costs at most the half-written tail
point. Deleting both files simply starts the series over. If `/config` is not
writable, the series degrades to memory-only instead of erroring once a minute.

**Two protections against a wrong chart** (both in
`backend/v2/networth/price-guard.mjs`). They exist because of a real incident:
a 1-chaos divination card was valued at 174,039c for about an hour on an
unchanged stack of one, which put a mountain worth twelve times the whole
account into the trend and made the item panel blame a card that never moved.

- **A brake on implausible price jumps**, applied before a point is written. A
  jump has to clear **both** bars to count: the item's unit price grew by at
  least **20x**, *and* the resulting gain is at least **25 % of the previous
  total**. Ordinary market moves and cheap oddities therefore never trip it.
  The point is then recorded at the item's **previous** unit price and its total
  corrected by the same amount, with a `[networth]` warning naming the item,
  both prices and the share. Held prices are not held forever: after **6 hours**
  the brake lets go and accepts the new price as real (also logged). The brake
  guards the **history only** — the live Net Worth page keeps showing whatever
  the valuator produced, because a silent rewrite of the displayed net worth
  would hide the very bug this is meant to surface.
- **Removal of artefacts already on disk**, applied when the series is loaded.
  Points from before the brake existed are still in the file, and there they
  hurt the chart more than the numbers: the value axis has to span the peak, so
  everything real gets flattened against the bottom. A stretch is dropped only
  when it rises to at least **5x** the level right before it, comes back **down
  to within 2x** of that level afterwards, is **shorter than 6 hours**, and no
  stock movement explains the rise (a jump that stays up is someone getting
  richer, not a glitch). Each removal logs how many points went, the peak, the
  span and the level it returned to; the file is rewritten so the cleanup is
  permanent.

### Reverse proxy (NPM, optional)

Proxy host in Nginx Proxy Manager:

- Forward to the Docker host, port **8788**.
- **Websockets Support = ON** (mandatory). The browser tab holds a WS connection
  on `/events`; without a WS proxy the UI won't connect.
- Keep access LAN-only (no port forwarding, no public exposure).

### Update procedure

```bash
git pull
docker compose up -d --build      # rebuilds bundle + indices, replaces the container
docker image prune -f             # optional: clean up old layers
```

At league start, do the extra steps in the runbook below **before** this
rebuild.

## League-start runbook

A new challenge league changes currency, notables, and sometimes base types —
several pieces of checked-in/vendored data need a refresh, or pricing and
item recognition quietly degrade for the new league's items.

> **The running container handles steps 2–3 by itself** since the background
> data auto-update (see above): it picks up refreshed upstream data within a
> day (or minutes after a restart) without a rebuild. Run the manual commands
> below when you want the **checked-in** copies in the repo refreshed too (so
> the next image build starts current), or as an emergency hatch — they are no
> longer required to keep the deployment working. Steps 1 and 4 (league env +
> store wipe) remain manual by nature.

Do this once, shortly after the league goes live:

1. **Point the tool at the new league.** In your (gitignored)
   `docker-compose.override.yml` (full `services:`-nesting — the bare
   `environment:` block alone is not a valid compose file):
   ```yaml
   services:
     poe-price-tool:
       environment:
         - POE_LEAGUE=<New League Name>
   ```
   `POE_LEAGUE` is the default league users see in the browser (each can still
   switch locally) and the league the Faustus and corpse pricing are pinned to
   (see "Single-league coupling" above).

2. **Regenerate the RePoE-derived base-names map** — new leagues bring new
   currency types the checked-in map doesn't know about yet:
   ```bash
   node backend/v2/base-names-gen.mjs
   ```
   This fetches current RePoE data over the network and rewrites
   `backend/v2/networth/base-names.json` (the Faustus metadata-id→name bridge)
   — see
   [docs/pricing-logic.md](pricing-logic.md#metadata-id--name-bridge-repoe-build-time)
   for what it feeds. Review and commit it.

3. **Refresh the vendored APT item/stat data** — one command:
   ```bash
   npm run update-apt-data              # report + write + regenerate the indices
   npm run update-apt-data -- --dry-run # report only, touch nothing
   ```
   `renderer/public/data/en/` (`items.ndjson`, `stats.ndjson`,
   `client_strings.js`, `app_i18n.json`) is the item database the paste parser
   resolves names against and the stat text the mod matcher works on. It is
   vendored from the
   [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade) upstream
   repo's own `public/data/` tree (itself generated from RePoE/the game client,
   same underlying source as step 2, different pipeline).
   `backend/v2/apt-data-update.mjs` pulls those four files from upstream
   `master` and regenerates the `*.index.bin` next to them — those are
   **generated, never copied** (they are line offsets into *our* ndjson;
   upstream's would point at the wrong lines), and they are gitignored, so the
   Docker build regenerates them anyway.
   Only `en/` is refreshed: the server calls `engine.ready({ lang: 'en' })` and
   loads `en/` only — the other locales are not vendored at all.
   **How to tell this is needed:** new-league items paste as unrecognized (the
   parser fails with `item.unknown`), or mod matching in the picker looks
   wrong/incomplete — that's the usual symptom of stale vendored data, not a
   code bug. It is not tied to league start; a mid-league patch that adds
   uniques needs it too.
   **Before committing**, read what the command printed: line counts per file,
   the `items.ndjson` namespace counts old → new, and every entry upstream
   **removed**. Additions are free; a removal is the one direction that can
   silently break the parser or the net-worth bridge, so removals are listed in
   full. Then run `npm test` — the suite asserts the fields
   `backend/v2/networth/normalize.mjs` and `kinds.mjs` join on are still there.

4. **If you moved `POE_LEAGUE`, wipe the stale Net-Worth store** (correctness,
   not cosmetic). `config/networth-store.json` persists a per-tab snapshot of
   whatever league it last scanned and is **not** cleared on a league switch —
   so after changing `POE_LEAGUE` the Net Worth page keeps showing the
   **previous** league's snapshot, and on a fresh league (empty stash) there is
   nothing to overwrite it, so the stale numbers linger indefinitely. Delete it
   (and the itemised-corpse store, same league-pinning) before the first start
   on the new league; both rebuild from scratch:
   ```bash
   rm -f config/networth-store.json config/corpse-store.json
   ```
   **Only if you actually moved `POE_LEAGUE`.** If you keep
   `POE_LEAGUE=Standard` (Net Worth tracks your permanent Standard wealth),
   leave the Standard store intact and skip this step. (The Faustus store
   self-clears on a league switch and never needs a wipe.)

5. **Rebuild and deploy** — commit the regenerated/updated files from steps 2–3,
   then run the normal [update procedure](#update-procedure) above
   (`git pull && docker compose up -d --build`); the search indices rebuild
   automatically from the refreshed data.
