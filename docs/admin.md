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

- **Engine reuse:** APT's parser + trade layer (`renderer/`, MIT license, copyright Alexander Drozdov) run **headless** — bundled via esbuild into `backend/v2/engine.bundle.mjs` (no Electron). `ws` is the server's only runtime dependency; `pathofexile-dat` and its two dependencies are in the image for the language generator alone (see "Data auto-update").
- **Two engine instances, one network path** (`backend/v2/engine-instances.mjs`):
  the bundle keeps its item/stat database in module-level closures that
  `initData(lang)` reassigns, so **one instance can serve exactly one
  language**. A second language therefore means importing the bundle a second
  time under a different specifier, which gives Node a second module graph with
  its own closures. Two consequences that are not style:
  - **Both languages live in the same versioned snapshot directory.** `ready()`
    sets the data root *process-wide*, so two instances pointed at different
    roots would read each other's data — and the localized load path still
    reads `data/en/client_strings.js`. `data/de` sits **next to** `data/en`,
    never instead of it. Loads and reloads run strictly serially for the same
    reason: a `Promise.all` over the two would be a race, not a speed-up.
  - **The second instance is handed out as a frozen object with exactly one key,
    `parseItem`.** Rate-limit state is per module graph: the second instance
    starts on the virgin default (1 request / 5 s) and knows nothing about the
    windows the primary has learned, while the shared queue and the ban gate
    only guard calls made through the primary. One accidental `searchPreset`
    there is the ban path this project has already paid for once — so
    `searchPreset`, `bulkPriceItem` and `searchRaw` are *not reachable*, not
    merely discouraged, and a test pins the key set so a function added later
    fails the build instead of quietly widening the surface. `parseItem` itself
    is verified network-free by a test that puts a fetch spy around a complete
    parse.
- **Multi-user:** cookie `ppt_user` (one user per person, from `POE_USERS`) → separate rooms; **one** shared trade queue via APT's RateLimiter. Three-tier priority: manual search > paste (`auto`) > background jobs (corpse pricer) — background work never blocks normal operation. The same cookie also carries the client language, which decides the parse instance and the UI language — from `/config/user-langs.json` if the user has chosen one on the settings page, otherwise from `POE_USER_LANGS`.
- **Frontend:** static — `index.html` / `app.js` (price check), `networth.html` / `networth.js`, `history.html` / `history.js`, `settings.html` / `settings.js` (client language + sync credentials + admin area, the last one including the runtime configuration form and the restart button). Served directly by the backend (no bundler). All user-visible text goes through `frontend/i18n.js`, one string table per language; a page learns its language from `GET /users` on load and follows a change over the `league-state` message (`shell.js` applies it, so every open tab of that user switches at once), never from `Accept-Language` — a player on a German client wants a German page on an English system too. A key missing from one table is a hard test failure.
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
  **For a non-English client the line takes one detour first.** That catalogue
  is English, so a German mod line could never match it — which would leave the
  freshly generated German set without the very repair path that bridges a
  lagging data set. `backend/v2/mod-text-pairs.mjs` brings the line to its
  English form through `data/de/text-pairs.ndjson`, a by-product of the language
  generator that covers *every* German description line of the current patch,
  not just the ones that made it into the data set; only that English form is
  looked up. Going through the German data set instead would be circular — an
  unresolved line is by definition one that data set does not know. The table is
  read lazily, per language, out of the active snapshot and dropped whenever a
  new snapshot is adopted, so table and data set are always from the same
  generator run; on an English-only installation it is never read at all.
  **A line that maps to more than one English text resolves to nothing** — it
  stays read-only and lands in the gap view, because a confident wrong price
  costs more than a missing one. Same outcome when the patch is newer than the
  last generator run and the line is not in the table either; that is exactly
  what happens on English when data set *and* catalogue both miss.
- **Client daemon:** `poe-price-daemon` (per machine) **polls the clipboard** — on a new value it runs `daemon/poe-price-post.sh`, which filters for PoE items, de-dupes, and POSTs. Polling (not `wl-paste --watch`) because XWayland game copies don't reliably fire change events. No key injection: you bind your key to PoE's own Ctrl+Alt+C copy. Chat macros (F5–F9) still run via evdev + ydotool. Details in the README.

## Deploy

The backend runs as **one** container behind a reverse proxy with **websockets enabled** (the browser tab holds a WS connection on `/events` — without a WS proxy the UI won't connect). **LAN-only, no auth — do not expose to the internet.** The stores persist in the `/config` volume; the user list comes from `POE_USERS`.

> The steps below are a **concrete example** — my Unraid homelab, with its own paths
> (`/mnt/user/appdata/…`) and internal LAN addresses (`192.168.178.29`). The general approach
> (Docker behind a reverse proxy with websockets) is what matters; adjust the paths and addresses
> to your own environment.

### Background load (runs 24/7, whether or not anyone has a tab open)

Three background jobs poll continuously, independent of any browser tab being
open — worth knowing before deploying on a shared or metered connection. Three
lighter ones run beside them and are listed after the three.

- **Corpse pricer** — up to `POE_CORPSE_BUDGET_PER_HOUR` (default 25) anonymous
  trade searches/hour, budgeted and capped.
- **Faustus refresher** — one pass every `POE_FAUSTUS_REFRESH_MS` (default 1h)
  over GGG's public Currency Exchange feed, and a pass walks back up to
  `POE_FAUSTUS_UNION_HOURS` (default 8) completed hours, one file each: on the
  order of **~200 CDN reads/day**. No session cookie and no trade API — it is a
  public CDN and a budget of its own, separate from the trade searches above
  and the stash reads below.
- **Net-Worth auto-refresher** — one step per tick (default 30s) ≈ **~2,880
  steps/day in TOTAL**, using the configured users' live session cookies.
  **That is not a per-user rate.** There is one refresher, one request in flight
  at a time, and the configured users are walked round-robin: a second user does
  not add a second stream, it halves how often each user's turn comes round. One
  user therefore gets ~2,880 reads/day and revisits a ~115-tab account roughly
  hourly; with three users it is still ~2,880 reads/day in total and each tab is
  revisited roughly every three hours. The load does not grow with the number of
  users. **A step is one request**, folder tabs included. A **folder tab**
  (Unique/Map stash) costs `1 + N` requests, because its items live in
  sub-folders on a different endpoint — 1+18 for the unique stash and 1+43 for
  the map stash on the account they were measured on (2026-08-19; the map stash
  had about 30 sub-tabs when first measured on 2026-08-11) — so it is `1 + N` *steps*, one sub-tab per tick,
  and two folder tabs per lap put the daily *request* count a few percent above
  what a lap of ordinary tabs would cost. Since 2026-08-11 those requests are
  **spread at the pace GGG's own published limits allow** instead of leaving as
  a burst (see "The pace between two stash requests"), and since 2026-08-13 they
  are spread over their own ticks instead of being held inside one: a folder tab
  no longer stops every other tab and every other user for the length of its
  walk. The request count is identical either way. The ordinary one-request step
  is unaffected: 30 s between ticks is already slower than the derived spacing.

Three lighter jobs run next to those:

- **poe.ninja** — Chaos:Divine ratio and the reference rail, refreshed every
  `POE_CD_REFRESH_MS` (default and minimum 15 minutes) for each league in use;
  no cookie.
- **Data check** — once a day (`POE_DATA_REFRESH_MS`) the item/stat data and the
  base-name list are compared with their sources by conditional request, so an
  unchanged day transfers almost nothing (see "Data auto-update").
- **Release check** — once a day, one request to `api.github.com` asking for the
  latest release of this tool (`POE_RELEASE_CHECK_DISABLED=1` turns it off).

None of this backs off when the tool is unused — there's currently no
"nobody's watching, pause everything" mode. A future idle-shutdown for the
background jobs is a plausible improvement, not implemented today.

What all three *do* back off for is a ban: while the global trade ban gate is up
the corpse pricer is held with the rest of the queue, and the net-worth
refresher stops with it (see "Rate limiting & bans"). And the dials above have
floors now — the settings page cannot be used to ask more often than every 30
seconds, whatever is typed into it (see "Configuration from the admin area").

### Rate limiting & bans

All trade-API traffic (price check, corpse pricer) shares one
queue and one ban detector, `backend/v2/rate-limit-signal.mjs`. Two separately
maintained copies of the detection drifted apart once, and a real GGG ban was
read as a harmless local error by the corpse pricer, which kept firing into it
(two real trade-API bans during development, `docs/bugs.md`); the shared module
exists so the wording is recognised in one place.

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

**The gate stops the net-worth refresher as well**, even though that path uses a
different endpoint and a different credential. This is the one place where an
operator's account of an incident beats what the code can measure: **a GGG ban
on this deployment applied to the whole address rather than to an account** — it
was not sat out but ended by taking a new address, the alternative being roughly
twelve hours. A ban aimed at an address does not care which cookie the next
request carries, so while one is up the stash reads stop too. The price is paid
knowingly: the net worth freezes for the length of the ban and the history
series gets a gap in it. That heals the moment the ban lifts; a ban does not,
and it costs every user of the deployment at once. `docs/bugs.md` B14 carries
the full argument, including the direction that is deliberately *not* coupled —
a stash 429 does **not** hold the trade queue, because a full window on one rule
group says nothing about another rule group's window, even when both are keyed
to the same address.

#### The stash path has its own budget — and its own answer to a 429

Everything above is the **trade** API. The net-worth refresher spends a
different budget on different endpoints (`character-window/get-stash-items` and
`/api/stash/…`), authenticated with a POESESSID rather than anonymous, and it
has its own rules:

- **A 429 costs exactly one request.** `stash-client.mjs` does not retry it:
  the first 429 is propagated straight to the refresher, and the *refresher's*
  cooldown does the waiting. The cooldown is `POE_NETWORTH_COOLDOWN_MS` (default 10min) or the
  `Retry-After` GGG named, whichever is **longer** — never shorter.
- **A pacing wait longer than 90s is not slept out either.** When the response
  headers say a window is nearly full, the client normally slows down (4× the
  base pace, or the rest of the window). Past 90s it stops instead of
  truncating the wait and sending anyway, and hands the wait to the same
  cooldown — so no request goes into a window GGG's own headers call full.
- **A 429 pauses every configured user, not just the one who got it.** This was
  caution while nothing could say whether the stash limit was counted per
  session or per address; the rule names below settle it — `Ip 45/60s` and
  `Ip 180/1800s` are part of the same budget, so a full window really is
  everybody's. The status line distinguishes the two cases: the refused user
  sees "rate-limited by GGG", everyone else sees "another user was
  rate-limited — syncing pauses for everyone until …". The other user is never
  named.
- **A trade ban stops this path too** (since 2026-08-11 — see above and
  `docs/bugs.md` B14), and the status line says so in its own words: a stash 429
  reads as "rate-limited by GGG", a trade ban as "the GGG trade API has blocked
  this app — stash syncing pauses with it until …". Different causes, different
  remedies: one is about this deployment's stash reads, the other is waited out.
  The reverse coupling does not exist — a stash 429 leaves the trade queue
  running, deliberately.

Once per process, the first stash response logs which rules GGG measures this
budget by. That line has now answered the per-IP question with evidence:

```
[stash-client] GGG rate-limit rules for the stash endpoints (policy backend-item-request-limit): Account 30/60s ban 60s, Account 100/1800s ban 600s, Ip 45/60s ban 120s, Ip 180/1800s ban 600s — the rule NAME says what the budget belongs to (Ip = shared with everything else from this address, Account = this session) — derived minimum spacing between two stash requests: 24.8s
```

It is pure observation (headers that arrived anyway, no extra request) and
repeats only if GGG publishes a *different* rule set — which the two stash
endpoints do: the newer `/api/stash/…` one answers with
`Account 15/10s ban 60s, Account 30/300s ban 300s`, so there are normally two
lines per process and not one.

#### The pace between two stash requests

**The rules above are measured, and the pace is derived from them.** It used to
be a constant of 1500 ms, and the arithmetic against the measurement is the
whole reason this changed:

- 1500 ms is **40 requests a minute**. `Ip 45/60s` is the tightest short window
  — so the tool ran at **89 %** of a limit whose only brake (`delayFor`) opens at
  80 % and is *reactive*: it reads a state counter off a response, by which time
  the requests it reacts to are already out.
- The **long windows were not counted at all.** `Ip 180/1800s` is 6 requests a
  minute averaged over half an hour, `Account 100/1800s` is 3.3. The ordinary
  cadence fits comfortably (one step per 30 s = 60 requests per 1800 s), but a
  **folder tab** does not: it spends 1 + N requests inside *one* step, and the
  map stash was measured on 2026-08-11 at 30 sub-tabs = **31 requests in 46 s**.
- That last number was **over a published limit outright**, and it needs no
  assumption to see: a folder tab is walked on the newer `/api/stash/…`
  endpoint, whose own rule set is `Account 15/10s` and `Account 30/300s`. 31
  requests inside 46 s is past `30/300s` on its own — before any other request
  to that endpoint in the same five minutes is counted, and the unique stash
  adds 19 more on the next turn.
- Against the *first* endpoint's windows the same burst is a violation only
  under the conservative reading, and it is worth stating as such: on an 18-tab
  account the round-robin reaches both folder tabs about three times per half
  hour, ~214 requests per 1800 s. Only ~52 of those go to the first endpoint, so
  its `Account 100/1800s` is safe if the two rule sets really do count
  separately — and the whole 214 is past `Ip 180/1800s` if they do not. Nothing
  in the headers says which, and the one incident this deployment has an
  operator's account of was a ban that reached the whole address.

So `backend/v2/networth/stash-pacer.mjs` derives the spacing instead of guessing
it. Every rule states a mean rate — `hits` per `windowSec` is one request every
`windowSec/hits` seconds — and the strictest one wins, after the share this tool
allows itself:

```
spacing = max( 1500 ms , max over all published rules of  (windowSec + bucketSec) × 1000 / (hits × share) )
```

- **All rules are honoured at once**, both windows and both endpoint groups. A
  response replaces the rule set of **its own policy** and leaves every other
  policy standing: a folder tab is walked entirely on the second endpoint, whose
  rules do not mention the 1800 s windows the walk is at risk of filling, so
  dropping the first endpoint's set while walking it would remove exactly the
  limit that measures the walk. See "A rule set GGG has withdrawn stops
  counting" below for why that is keyed on the policy rather than simply
  accumulated.
- **The share is `POE_STASH_IP_BUDGET_SHARE` (0.5) or
  `POE_STASH_ACCOUNT_BUDGET_SHARE` (0.75)**, by rule name — an address is shared
  with traffic this tool cannot see, a session is not. An unknown rule name is
  treated as `Ip`. On the measured set the binding rule is `Account 100/1800s`:
  against a window of 1800 s **plus its one-minute bucket** that is 18.6 s a
  request, of which the tool takes three quarters → **24.8 s**.
- **`bucketSec` is the window's RESOLUTION, and it is in no header.** GGG sums
  requests in buckets rather than counting them as they arrive — 5 s on the
  short limit, one minute on the sustained one — so a published `45 per 60s`
  really covers 60–65 s of wall clock. The rate is derived against the longer
  reading. See `POE_STASH_BUCKET_SHORT_SEC` above for the quote it comes from;
  it costs 3.3 % on the measured set and can only ever lengthen a gap.
- **The 1500 ms constant stays as the floor and as the fallback.** Before any
  response has been seen — the first request after a start — it *is* the pace,
  and no rule set and no share can derive anything shorter. That is what makes
  this unable to send more than it did before, in any constellation.
- **The state is process-wide, not per client.** The server builds a fresh stash
  client every tick; the pacer does not, because an `Ip` budget belongs to the
  address (shared across configured users) and a 1800 s window outlives any
  number of 30 s ticks. The reactive brake now survives a tick with it, so a
  nearly-full window no longer gets a free first request at the start of the
  next one.

What it costs and what it buys, at 24.8 s: the ordinary cadence is
**unchanged** — 30 s between ticks already covers the spacing, so an ordinary
step never waits. A folder tab with 30 sub-tabs (the measurement of 2026-08-11) takes **~13 minutes instead of
~46 seconds** (the same 31 requests, no longer as a burst), and since
2026-08-13 those requests are spread over one tick each rather than held inside
one step, so nothing else stops while it happens (see "Background load" and
"When the refresher goes quiet"). Sequentially, the whole process cannot exceed
72 requests per 1800 s: 40 % of `Ip 180/1800s`, 5.4 % of `Ip 45/60s`, and 73 %
of the account window — which is the share, by construction.

Nothing here sends an extra request to learn a rule: the limits are in the
responses that arrive anyway.

#### A rule set GGG has withdrawn stops counting

**GGG varies the rule set, in both directions.** Over two days, one account on
one address was answered with three different sets:

```
12.08. 14:12 UTC   Account 30/60s ban 60s, Account 100/1800s ban 600s,
                   Ip 45/60s ban 120s,     Ip 180/1800s ban 600s       -> 24.8 s
12.08. 14:13 UTC   Account 15/10s ban 60s, Account 30/300s ban 300s    (the folder endpoint)
13.08. 02:15 UTC   Ip 30/60s ban 120s, Ip 90/1800s ban 600s,
                   Ip 180/7200s ban 3600s                              -> 80.7 s
13.08. 11:28 UTC   the 14:12 set again                                 -> still 80.7 s
```

That last line is the defect. The rule table was keyed on `rule:window` and
**nothing was ever removed from it**, so the strict set of 02:15 — with a
two-hour window nothing had published before — kept deriving 80 s hours after
GGG had gone back to the set that asks for 24.8 s, and would have done so until
the container was restarted. Strictly one-way: any single strict answer was
permanent, and taking a new address did not help either.

**And the 02:15 set is not a punishment — it is a dead session.** That matters
for how the whole table is read, so it is worth being precise about. The legacy
stash endpoint answers the *same* policy in two forms: `Account,Ip` when the
POESESSID was accepted, and `Ip`-only when it was not, with the address limit
roughly halved in the second. The `gerwaric/acquisition` project measured
exactly that on the same endpoint on 28.07.2026, and a GGG web developer
described the mechanism in the official forum back in 2018 — with a session id
the budget is counted per account, and the IP limit is then twice as generous.
Our two forms are that, digit for digit:

| rule | authenticated (11:28) | 02:15 | factor |
|---|---|---|---|
| `Ip` / 60 s | 45 | 30 | 1.5× |
| `Ip` / 1800 s | 180 | 90 | **exactly 2×** |
| `Account` rules | present | **absent** | — |
| a 7200 s window | — | 180, ban 3600 | only unauthenticated |

02:15 UTC is a night-time round with an expired cookie that nobody was awake to
notice. **So the change of form is an alarm, not a reason to slow down**, and
the tool now says so — see "The rule names are also a session check" below. The
pacing side is still right to honour the `Ip`-only limits while they are what
GGG published: that request really was measured against them. What was wrong was
never letting go of them afterwards.

**Nothing here has been tightened on suspicion.** The authenticated set above is
digit for digit what a third party measured on 18.07.2026 from another account,
another address and another continent — it is what GGG ships to everybody, not a
number aimed at this deployment. GGG's penalties are binary (a timed lock, a
withdrawn credential, a Cloudflare block); a quietly smaller set of numbers is
not one of them.

**The fix is GGG's own `X-Rate-Limit-Policy` header**, which names the budget a
set belongs to and was not being read at all. That is GGG's documented meaning
of it rather than a convenient reading: *"Policies may be the same across
different API endpoints but are treated the same for rate limiting purposes."*
Same policy name, one shared counter; different names, independent counters. It
is now part of the key, so a response is the whole truth about *its* budget and
about nothing else: the
folder endpoint's set can be restated thirty-one times during a walk without
touching the ordinary endpoint's 1800 s windows, and a rule GGG has stopped
publishing stops counting on the next response. Getting **faster** is therefore
only ever GGG's decision, never a lapse of memory — which is the one direction
that has to be argued for in this tool.

Two fallbacks sit behind it, both in the conservative direction:

- **A response with no policy header replaces nothing.** It is added to the
  union, exactly as before. A header that is missing must not be able to make
  two endpoints look like one budget and take a window away from a walk.
- **A rule expires if it is not re-published for `POE_STASH_RULE_TTL_MS`**
  (6 h), which covers a policy that is never asked again. It is a fallback, not
  the mechanism — the policy key answers within one response. The floor under
  that setting is 2 h, the longest window ever seen here, because a request can
  still be counted inside a window for as long as the window is; and each rule
  is kept for at least its own window whatever the setting says. **A rule set
  that keeps arriving never expires**, however long the process runs.

The rule-set log line names the policy for the same reason:

```
[stash-client] GGG rate-limit rules for the stash endpoints (policy backend-item-request-limit): Ip 30/60s ban 120s, Ip 90/1800s ban 600s, Ip 180/7200s ban 3600s — the rule NAME says what the budget belongs to (…) — derived minimum spacing between two stash requests: 80.7s
```

Without it, two sets carrying the same rule *names* could not be told apart
after the fact — and whether a changed set is the same budget being restated or
a second budget standing next to the first is the whole question.

#### The rule names are also a session check

The `Account` rules disappearing from a policy that had them means the request
was **not authenticated** — see the table above. Before 2026-08-13 the tool's
entire reaction to that was to get slower, silently, for as long as it lasted.
It now says so, once per change of state and in both directions:

```
[stash-client] the stash session is NOT being counted per account any more (policy backend-item-request-limit): GGG published only Ip rules, which is the form it answers an unauthenticated request with — the POESESSID is expired or was not accepted. Renew it in networth-users.json. The Ip-only limits are stricter, so the pace lengthens with them; that is a symptom, not the problem
[stash-client] the stash session is being counted per account again (policy backend-item-request-limit) — the POESESSID is being accepted
```

It is **observation only** — it sends nothing, changes no pacing and throws
nothing — and that is deliberate. An unauthenticated request cannot read a
private stash, so it is refused, and the refusal already travels the existing
auth path: `401`/`403` → the refresher pauses *that user*, logs `cookie expired
for <user> — renew it on the settings page (Sync settings) or in networth-users.json` and reports `state: "expired"` for them in the status line. Turning
a header observation into a second pause would attach a per-user consequence to
a signal that is process-wide and cannot name a user, and a false positive would
freeze a healthy refresher until somebody edited a cookie. What was missing was
the sentence that explains the change of pace, not another way to stop.

A policy that has *never* published `Account` rules says nothing: only the
transition is evidence. The check is per policy, so the folder endpoint and the
ordinary one cannot accuse each other of losing a scope.

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

- **build** (`node:24`): installs the root deps (`ws`, plus the `esbuild`
  devDependency that does the bundling) and the renderer deps (`fnv1a`, for the
  search indices), builds the self-contained engine bundle
  (`node backend/v2/build.mjs` → `engine.bundle.mjs`) and generates the
  search indices (`*.index.bin`, gitignored → generated here).
- **runtime** (`node:24-slim`): only what's needed at runtime —
  `node_modules/ws`, `backend/v2/{server.mjs, engine.bundle.mjs, frontend/,
  data-refresher.mjs, apt-index.mjs, …}` and `renderer/public/data`. The data
  auto-update regenerates the search indices at runtime via `apt-index.mjs`
  (pure Node, no `renderer/node_modules` needed in the image). The path relation
  `backend/v2/` ↔ `renderer/public/data` is preserved (the default data path in
  `engine.mts` is relative). The server process runs as UID 1000; PID 1 starts
  as root and drops to it — see the /config permissions note below. Every
  `*.test.mjs` under `backend/` is deleted from the image (tests live in the
  repository, and the ones under `frontend/` would otherwise be served over
  HTTP).
- **health check**: `GET /health` every 30 s with a 5 s timeout, a 45 s start
  period (the server warms its caches on boot) and 3 retries before the
  container is reported unhealthy.

The bundle is self-contained and `ws` is the server's only dependency. The
images pin Node 24; `package.json` declares `engines` `node >=22` for running
the server or the tests outside Docker (Node 20 reached end of life on
2026-04-30). The image
additionally carries `pathofexile-dat` (with `pathofexile-dat-schema` and
`ooz-wasm`, ~600 KB together) because the language generator spawns its CLI to
export GGG's game data — dead weight on an English-only install, and the
alternative is a German install whose generation run fails on a deployed
container.

> **Files directly under `backend/v2/` are copied one by one.** A module added
> to the server's import graph but not to the Dockerfile makes the container
> crash on boot with `ERR_MODULE_NOT_FOUND` — and the test suite cannot see it,
> because it runs against the source tree where every file exists.
> `backend/v2/dockerfile-closure.test.mjs` walks the real import graph and fails
> when a file in it has no `COPY` line, plus the two things the graph walk
> cannot see: `lang-pseudo-matchers.json` (read, not imported) and
> `pathofexile-dat` (resolved at call time).

### Build & run

```bash
cd /path/to/poe-price-tool
docker compose up -d --build
```

Verify:

```bash
curl -s http://127.0.0.1:8788/health     # → ok
curl -s http://127.0.0.1:8788/users      # → {"users":["player1","player2"],"appName":"Trade Console","langs":{"player1":"en","player2":"en"}}
docker compose logs -f poe-price-tool
```

Then open `http://192.168.178.29:8788/` in your browser and pick the user once.

### Environment (all optional, defaults in the server)

Some of them stand in `docker-compose.yml` under `environment:` as a commented-out template; all are settable through the environment:

| Env                 | Default    | Meaning                                                    |
|---------------------|------------|-------------------------------------------------------------|
| `PORT`              | `8788`     | Server port (must match the port mapping). **`0` is honoured** and asks the operating system for a free port — the test suite's normal path, not a deployment value. Anything that is not a whole number from 0 to 65535 is reported and `8788` is used (the container `HEALTHCHECK` reads the raw value, `process.env.PORT||8788`, so with an unusable value the server listens on `8788` while the probe asks the raw value) |
| `POE_LEAGUE`        | `Standard` | Starting league (each user can switch it in the browser). **Faustus/Corpse pricing is pinned to this one league, not per-user** — see "Single-league coupling" below |
| `POE_USERS`         | `player1,player2` | fixed user list (no login, just routing)            |
| `POE_USER_LANGS`    | *(unset)*  | client language per user, e.g. `bob:de` (comma-separated pairs). **Only the starting value**: a language the user has picked himself on the settings page lives in `/config/user-langs.json` and wins over this — see "Client language at runtime" below. Everyone unlisted and with no stored choice uses `POE_LANG_DEFAULT`. A typo — unknown user, unsupported language, malformed pair — **fails the startup**: a wrong language does not fail by itself, it produces a plausible wrong item |
| `POE_USER_LANG_STORE` | `/config/user-langs.json` | where the per-user language choices are stored. A `{ "<user>": "<lang>" }` file, written by the settings page |
| `POE_LANG_DEFAULT`  | `en`       | language for every user without an explicit entry. Supported: `en`, `de` |
| `POE_CONFIG_OVERRIDES` | `/config/overrides.json` | where the admin area writes the settings it may change at runtime. **The file wins over this whole table** — see "Configuration from the admin area" below |
| `POE_PATCH_VERSION` | *(unset — looked up)* | the PoE patch the localized data set is generated from, e.g. `3.29.2.1`. Normally **not set**: it is resolved at `https://ggpk.exposed/version?poe=1` (see "Data auto-update"). Set it when that lookup is unavailable, wrong, or answers something the tool refuses — it then wins outright, and it is the one-line repair for every failure of the lookup (see "Data auto-update", "When the lookup or its answer is what failed"). Only relevant on an install that serves a language beyond `en` |
| `POE_APP_NAME`      | `Trade Console` | display name in the header/title of the landing page; set e.g. `POE_APP_NAME=YourName` |
| `POE_MAX_LISTINGS`  | `10`       | trade listings per search (hard-capped at ≤10). **`0` is refused** — searching and then reading none of the answers saves no request; `POE_PRICE_CHECK_DISABLED=1` is the off switch. Anything outside 1–10 is refused too, rather than clamped |
| `POE_PRICE_CHECK_DISABLED` | *(off)* | `1` turns the item price check off: a pasted item still parses and still becomes a card, but nothing is searched for it — no Trade-API call, no poe.ninja reference — and the card shows as having no price. This is the only switch for the **foreground** path; the four `*_DISABLED` further down cover background schedules. Deliberately not settable from the admin area: it disables the tool's main function. The test suite sets it so that booting the real server costs no live request |
| `POE_CD_RATIO`      | `215`      | Chaos:Divine fallback when poe.ninja is unreachable. **`0` is refused** — a divine worth nothing is not a price, and every chaos↔divine conversion divides by it |
| `POE_CD_REFRESH_MS` | `900000`   | C:D refresh interval. **15 min is the minimum and anything below it is refused** — the server schedules the refresh at `max(this, 15min)` following poe.ninja's courtesy limit, so a smaller value never did anything but look like a setting. `0` included |
| `POE_NETWORTH_STORE` | `/config/networth-store.json` | path of the per-tab net-worth store (persistent in the /config volume) |
| `POE_NETWORTH_CONFIG` | `/config/networth-users.json` | path of the per-user credentials file (accountName + POESESSID) |
| `POE_NETWORTH_AUTOSYNC` | on | background auto-refresher for the net-worth store; `=0` disables it |
| `POE_NETWORTH_SYNC_INTERVAL_MS` | `30000` | delay between auto-refresher ticks (one tab refreshed per tick, in total — the users share the ticks round-robin). **30000 is the minimum; anything below it is refused**, `0` included. 30 s is the only pace this design has been argued at (~2,880 steps/day), a folder tab is 1+N requests inside one tick, and the stash budget may be counted against the same address as the trade traffic. Raising it is always allowed; `POE_NETWORTH_AUTOSYNC=0` is the off switch |
| `POE_NETWORTH_LIST_TTL_MS` | `900000` | how long the cached stash-tab list is considered fresh. A tick refreshes the list **or** syncs one tab, never both, so this does not change how many requests go out — it changes how many of them reach a tab at all. **`0` is refused** for that reason: every tick would go on the list, no tab would ever be synced again and the net worth would freeze silently. (This entry used to say "one extra GGG request per user per tick", which is wrong three times over: not extra, not per user, and not an addition to the request count.) |
| `POE_NETWORTH_COOLDOWN_MS` | `600000` | backoff after a 429 before the refresher tries again. Applies to **all** configured users, not only the one that was refused, and a longer `Retry-After` from GGG wins over it. **600000 is the minimum; anything below it is refused**, `0` included — retrying sooner after GGG said 429 is how a rate limit becomes a ban. This dial may lengthen the wait, not shorten it |
| `POE_NETWORTH_SLOW_STEP_MS` | `120000` | how long ONE refresher step may run before the log says so (2 min). **Not a timeout**: nothing is aborted and nothing is released, the line is pure observation — see "When the refresher goes quiet" below. **`0`** reports every step that is still running when the next tick arrives, which is what you want while hunting a stall |
| `POE_NETWORTH_HISTORY` | `networth-history.ndjson` next to `POE_NETWORTH_STORE` (so `/config/networth-history.ndjson`) | path of the value-over-time series behind the History page. Its item sidecar is derived from this path (`…-items.json`) and cannot be set separately — see "History page" below |
| `POE_NETWORTH_GUARD_FACTOR` | `20` | implausible-price brake in front of the series: how far an item's unit price has to jump between two recorded points before the history stops trusting it. **`0` is honoured and is not an off switch** — it takes this bar out as a *filter*: every price then counts as a big enough jump, and only the share bar still decides anything |
| `POE_NETWORTH_GUARD_SHARE` | `0.25` | …and how much of the previous total the resulting gain has to be. Both bars have to clear; the point is then recorded at the old price. **`0` is honoured the same way**: every gain then counts as large enough, and only the factor bar still decides. **Both bars at `0` together hold everything** — every priced item with a reference whose unit price has not fallen is pinned to its previous price at every recorded point, so no price rise ever reaches the series again (stock moving in and out still does). It is allowed rather than refused because it is anything but silent: it is one `implausible price jump` line per priced item per point |
| `POE_NETWORTH_GUARD_HOLD_MS` | `21600000` | how long a suspicious price has to STAND before it is accepted as real after all (6h) — standing means present in every point recorded in that window, not six hours on the clock, and a point in which the item is there but carries no price of its own counts for neither side: it pushes the deadline out by exactly that gap. Also how long the brake remembers a price it accepted for a name (in memory; a restart forgets it), and how long a withheld arrival stays out of the series. **`0` is honoured and does NOT mean "no hold"** — the window is the unit standing is measured in, so with zero there is nothing to stand through: the release is never reached, the suspicious price is corrected (and logged) again at every following point, and the memory of accepted prices, which ages with the same window, is off with it. The brake then never lets go |
| `POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE` | `20` | an item ENTERING the stash has no previous price to be measured against. One worth at least this many divine **and** at least `POE_NETWORTH_GUARD_SHARE` of the previous total is recorded at no value until it has stood for the hold window, then enters the series as stock arriving. The floor is what keeps a fresh account — where every drop is a large share of a small total — out of the brake's reach. **`0` switches the arrival bar off.** See [pricing-logic.md](pricing-logic.md#history-what-a-recorded-point-is-protected-against) |
| `POE_STASH_IP_BUDGET_SHARE` | `0.5` | how much of a rate-limit rule GGG publishes under the name **`Ip`** the stash path will spend. Not a period and not a count: the delay between two stash requests is *derived* from the limits in GGG's own response headers (see "The pace between two stash requests" below), and this is the safety margin in that derivation. Half, because an `Ip` budget is shared with everything else leaving this address — the household's browser on pathofexile.com, and this app's own trade traffic — none of which is visible from here. **`0` is refused**: it would mean an infinite spacing, i.e. a refresher that ticks and never sends; `POE_NETWORTH_AUTOSYNC=0` is the off switch. **1 is the maximum** (never claim more than GGG publishes), and there is deliberately no minimum: lowering it only ever sends less. Not settable from the admin area |
| `POE_STASH_ACCOUNT_BUDGET_SHARE` | `0.75` | the same margin for the rules published under the name **`Account`**. Higher than the `Ip` share because that budget is spent by this session, where the operator's own logged-in browsing is the only other plausible consumer. Which rule ends up *binding* is GGG's choice, not this one — on the measured set it is `Account 100/1800s`. **`0` is refused**, 1 is the maximum, no minimum, not settable from the admin area — all exactly as above |
| `POE_STASH_RULE_TTL_MS` | `21600000` | how long a rate-limit rule GGG published keeps counting after it was last published (6 h). The ordinary way a rule stops counting is the **policy**: a response replaces the rule set of its own budget and leaves every other budget alone (see "The pace between two stash requests"). This is the fallback for the two cases a key cannot cover — a policy that is never asked again, and a response with no `X-Rate-Limit-Policy` header at all. **Its dangerous direction is DOWN**: forgetting a limit that still counts is the same mistake as claiming too much of one, so it carries a floor and no ceiling, and a refused value falls back *up* to the default. **`0` is refused** — it would forget every rule on the spot and drop the pace back to the 1500 ms constant; `POE_NETWORTH_AUTOSYNC=0` is the off switch. The **minimum is 7200000**, the longest window GGG has been observed to publish here (`Ip 180/7200s`): a request can still be counted inside a window for as long as the window is. Each rule is additionally kept for at least *its own* window whatever this says, so a future longer window is covered by arithmetic rather than by this number staying current. Not settable from the admin area |
| `POE_STASH_BUCKET_SHORT_SEC` | `5` | the **resolution** of GGG's *short* rate-limit window, in seconds — the size of the buckets it sums requests in. This is in **no header at all**; it comes from GGG's own support, to the `gerwaric/acquisition` project: *"That particular policy has a resolution of 5 seconds, which means that it buckets incoming requests in 5 second intervals. To be safe you'd have to add 5 more seconds rather than 2. This isn't exposed anywhere for you to have known."* A limit is summed over whole buckets, so `45 per 60s` really covers 60–65 s of wall clock; the pace is therefore derived against `windowSec + bucketSec`, and the reactive brake adds it when it waits a window out. It is what explains pacing that is arithmetically correct against the published numbers still collecting the odd 429. **`0` is refused** — it is the assumption GGG explicitly corrected — and the **floor is the default**: this dial may lengthen a wait and never shorten one. Not settable from the admin area |
| `POE_STASH_BUCKET_LONG_SEC` | `60` | the same resolution for the *sustained* window. It also decides **which** bucket applies, so there is no third setting for that: a window no longer than this cannot be a sustained limit, which on every rule set observed splits exactly where it should (10 s and 60 s take the short bucket; 300 s, 1800 s and 7200 s the long one). The surcharge is small where it lands — 1800 s counts as 1860 s, i.e. **3.3 %** on the binding rule of the measured set (24.0 s → 24.8 s). Adding a whole minute to every derived *gap* instead would be a 3.5× slowdown that nothing argues for: it is the window that is uncertain, not the gap. **`0` is refused**, the floor is the default, there is no ceiling — exactly as above |
| `POE_STASH_TIMEOUT_MS` | `30000` | per-request timeout for a stash read (~30s). **1000 is the minimum; anything below it is refused**, `0` included — a timeout of zero would abort every request before it can answer. Raise it only if the stash endpoint is genuinely slow for you; a timeout costs one tab, and the refresher picks that tab up again on a later tick |
| `POE_STASH_PROBE` | unset | **diagnostics only.** Set to a stash-tab index to run one folder-tab probe at startup, for the first configured net-worth user, logging the response keys and item count per addressing variant. Leave it unset in normal operation |
| `POE_NETWORTH_SKIP_TIER_MAPS` | `1` | `1` reads only the **Unique** and **Special** pages of the map stash and passes over the per-tier pages (`tier1`…`tier16`), which GGG labels itself in `metadata.map.section`. Normal maps are never priced, and those pages are most of what the map tab costs: 14 of 43 sub-tabs measured, one derived spacing each. A page whose section is missing or unrecognised is **read**, so an account shaped differently loses nothing. Every walk logs how many sub-tabs it passed over and which sections they were. `0` reads the whole map stash |
| `POE_NETWORTH_DEBUG` | unset | `1` logs one diagnostic line per scanned stash tab (`raw`/`priced`/`unpriced`/`skipped`) — use it to tell "the tab came back empty" apart from "every item was skipped" |
| `POE_FAUSTUS_STORE` | `/config/faustus-store.json` | path of the Faustus (GGG Currency Exchange) name→chaos store (persistent in the /config volume) |
| `POE_FAUSTUS_DISABLED` | *(off)* | `1` disables the Faustus background refresher entirely (fungible pricing falls back to poe.ninja) |
| `POE_FAUSTUS_UNION_HOURS` | `8` | how many completed hourly Faustus digests to union (most-recent market wins) before deriving prices. **`0` is refused** — a union of no hours derives no prices; `POE_FAUSTUS_DISABLED=1` is the off switch |
| `POE_FAUSTUS_REFRESH_MS` | `3600000` | Faustus refresh interval. The digests are hourly and a pass works on the last *completed* hour, so a second pass inside the same hour re-downloads files that cannot have changed — **3600000 is therefore the minimum, and anything below it is refused**, `0` included. `POE_FAUSTUS_DISABLED=1` is the off switch |
| `POE_FAUSTUS_TTL_MS` | `172800000` | max staleness (~48h) before the valuator treats the whole Faustus store as absent and falls through to poe.ninja; guards against the CDN feed silently freezing prices. Generous because the refresh is hourly and unions several completed hours. **`0` is refused** — the store would be stale the instant it was written, so the refresher would keep fetching and the valuator would never use a price from it; `POE_FAUSTUS_DISABLED=1` is the way to fall through to poe.ninja |
| `POE_FAUSTUS_MAX_AGE_HOURS` | `6` | how old the OBSERVATION behind ONE Faustus price may be, counted from the end of the digest hour it came from. A different question from `POE_FAUSTUS_TTL_MS`, which only asks whether the refresher is still running: the union walk hands out prices observed hours apart in the same tick, and a price from a quiet hour eight hours ago is not a current one. Past this age the item falls through to the poe.ninja fallback the chain already has, at no extra request. **`0` is refused**, and so is anything under 3 — a served price is never fresher than one digest hour plus one refresh interval, so a tighter gate would reject every price there is; the gate is additionally floored against the refresh interval actually configured. Set it to `POE_FAUSTUS_UNION_HOURS` or higher to switch the gate off (no observation can be older than the hours walked); `POE_FAUSTUS_DISABLED=1` switches Faustus off entirely |
| `POE_CORPSE_STORE` | `/config/corpse-store.json` | path of the itemised-corpse price store (name→chaos, Trade-API sourced; persistent in the /config volume) |
| `POE_CORPSE_DISABLED` | *(off)* | `1` disables the corpse background pricer entirely (corpses stay honestly unpriced) |
| `POE_CORPSE_TTL_MS` | `21600000` | how long a cached corpse price (or cached "no listings") stays fresh before a re-query (~6h; corpses move slowly). **3600000 (1h) is the minimum; anything below it is refused**, `0` included — one hour is the pricer's own budget window, and under it an entry goes stale faster than the budget that produced it can refill, i.e. the whole hourly budget goes on re-asking questions that already have answers |
| `POE_CORPSE_BUDGET_PER_HOUR` | `25` | max distinct corpse names queried on the Trade API per rolling hour (stalest/unpriced first); caps the first-snapshot burst. **`0` means exactly that: no Trade-API query is made at all**, and already-cached prices are still served. It is the setting for "stop asking" without turning the store off, and it is honoured — it used to hand back 25, silently. **30 is the maximum**: the pricer queries one name per tick and a tick is at least two minutes, so nothing above 30 can be spent in an hour |
| `POE_CORPSE_INTERVAL_MS` | `120000` | delay between corpse pricer ticks (one name priced per tick). **120000 is the minimum; anything below it is refused**, `0` included — that is the pricer's documented pace, these are Trade-API requests (the budget GGG publishes under the rule name `Ip`, and the one this tool has two real bans on), and the pacing is what keeps the shared queue free for a manual search. Use `POE_CORPSE_DISABLED=1`, or `POE_CORPSE_BUDGET_PER_HOUR=0` to leave the pricer running without querying |
| `POE_REFERENCE_HISTORY` | `/config/reference-history.ndjson` | path of the reference rail's own price series (one point per reference refresh, i.e. ≥15min apart) — the sparklines next to the rail rows are drawn from it |
| `POE_REFERENCE_DISABLED` | *(off)* | `1` skips the one-time C:D ratio + reference rail warm-up done at boot (both stay on their fallback value until the periodic background refresh reaches them). It covers the BOOT warm-up only — the row below is the other half |
| `POE_LEAGUE_LIST_DISABLED` | *(off)* | `1` stops `GET /leagues` from asking poe.ninja for the current league list; the dropdown is then filled from what this installation already knows — the leagues the configured users are on, plus `Standard`/`Hardcore`. The **third** kind of outbound traffic, and the one no other switch reaches: it is neither a schedule nor a warm-up nor the price check but a **request**, made by the browser on every page load, so disabling every background job never silenced it (`docs/bugs.md` B25). Useful beyond the test suite: an installation with no route to poe.ninja otherwise pays for a failing fetch before the dropdown can be drawn. Not settable from the admin area |
| `POE_REFERENCE_ON_CONNECT_DISABLED` | *(off)* | `1` skips the same warm-up when a **connected client** triggers it: a WS connection whose league has no warm cache, and a room switching leagues. Both send two poe.ninja requests; with this set the room opens on the fallback C:D ratio and an empty reference rail until the periodic refresh reaches that league. It exists for the same reason `POE_PRICE_CHECK_DISABLED` does — "boot the real server and let it reach nothing" was not expressible, and the test suite was quietly reaching poe.ninja because of it (`docs/bugs.md`, B12). Not settable from the admin area |
| `POE_RATE_LIMIT_STATE` | `/config/rate-limit.json` | path of the persisted ban gate, so a restart resumes an active cooldown instead of probing GGG blindly |
| `POE_MAX_ITEMS_PER_ROOM` | `50` | server-side cap on item cards held per room; the oldest is evicted (and an `item-removed` sent) when a new one arrives. **`0` is refused**, and so is anything below 1 or fractional: the eviction loop runs while `size > cap`, so a cap of 0 deletes every card as fast as it is created. Dismissing a card is how a room is emptied |
| `POE_MAX_REQUEUE_ON_RECONNECT` | `10` | how many priceless cards a single WS reconnect may re-queue (newest first). Caps the queue flood after a poe.ninja/Trade outage; the remaining cards replay as `queued` and can be searched on demand. **`0` means re-queue nothing**, and it is honoured — a re-queued card is an `auto` Trade-API search, so a `0` that fell back to 10 was ten searches per reconnect nobody asked for. Whole numbers only, and note the direction of a refusal: an unparsable value lands on 10, i.e. MORE than was asked for |
| `POE_RATE_LIMIT_BANNER_MIN_SEC` | `60` | a rate-limit wait shorter than this is handled quietly (local backoff only); from this many seconds up the browser shows the amber ban banner with a countdown. **`0` means banner every wait, however short** — display only, it neither sends nor suppresses a request. Whole seconds (it is compared against GGG's `Retry-After`) |
| `POE_DATA_REFRESH_MS` | `86400000` | data auto-update interval (~daily): APT item/stat data and `base-names.json` — see "Data auto-update" below. Conditional requests, so an unchanged day transfers nothing. **3600000 (1h) is the minimum; anything below it is refused**, `0` included: the sources change on a patch cadence and one round includes a stat-catalogue call on the shared trade budget. An hour is deliberately below the daily default — a league launch is a real reason to look more often. `POE_DATA_REFRESH_DISABLED=1` is the off switch |
| `POE_DATA_REFRESH_DISABLED` | *(off)* | `1` disables the data auto-update fetching; a valid snapshot already persisted under the refresh dir is still preferred at boot (wipe the dir to fully reset to the baked-in data) |
| `POE_DATA_REFRESH_DIR` | `/config/data-refresh` | where adopted data snapshots and the update state persist (survives redeploys) |
| `POE_RELEASE_CHECK_DISABLED` | *(off)* | `1` turns off the automatic once-a-day check for a newer release of this tool (see the `release-status` message in `backend/v2/frontend/PROTOCOL.md`). Read at each tick, so changing it in the admin area takes effect **live**; the manual check in the admin area keeps working |
| `POE_RELEASE_REPO` | `BriskWatchdogz1/poe-price-tool` | the GitHub repository whose latest release is looked up (`api.github.com/repos/<repo>/releases/latest`); a fork points it at itself. Restart to change |
| `POE_RELEASE_CHECK_STATE` | `/config/release-check.json` | where the check keeps when it last asked, what GitHub answered and the ETag, so a restart does not ask again the same day |
| `POE_ADMIN_PASSWORD_FILE` | `/config/admin-password` | plaintext file holding the password for the admin area of the settings page. Created with the default `admin` on first boot if it does not exist. **Read on every request** — editing it takes effect immediately, no restart. See "Settings page & admin area" below, including when you MUST change it |
| `POE_GAP_LOG_MAX` | `200` | how many distinct gaps the admin view keeps per kind (failed parses / unresolved mod lines). Over the cap the least frequent entry is dropped and the view says so. Bounds the memory a long-running server spends on user input. **`0` is refused** (as is anything below 1): it cannot mean "record nothing", because `gap-log.mjs` clamps its own cap to at least 1 as well |
| `POE_GAP_LOG_TEXT_MAX` | `400` | how many characters of a recorded text are kept; longer texts are truncated visibly. **Anything below 40 is refused**, `0` included — a shorter excerpt cannot show enough of an item to identify what failed |
| `POE_LANG_SKEW_WARN_RATIO` | `0.005` | how far a localized data set may fall behind English before the admin view calls it a warning, as a **fraction** of the English set (0.005 = 0.5 %). **`0` is honoured** and means "warn on any gap at all"; anything above 1 is refused. A ratio, not a count: "12 missing" means something different in 8 000 stats than in 40 |
| `POE_LANG_MAX_COVERAGE_LOSS_RATIO` | `0.01` | how much of what the localized data set ALREADY COVERS may fall away in one regeneration before the run is thrown away and the previous set kept (0.01 = 1 %). Measured against the stats the live localized set has a matcher for — **not** against the English set: English comes from an upstream that ships on its own schedule, and stats it adds that the game data of the current patch has no text for are a gap no refusal can close (see "Data auto-update" below and `docs/bugs.md` B23). On a FIRST build there is no previous set, and the same fraction then applies to the English set as a whole. **`0` is honoured** and is the strictest setting rather than an off switch: "not one stat that has a German matcher today may lose it". Above `1` it is not a share and falls back to the default |
| `POE_LOG_TIMESTAMPS` | on | `0` drops the `2026-07-31T14:03:21Z` prefix from every log line (only useful when an outer log collector stamps them itself) |
| `POE_TRADE_AUDIT` | on | `0` disables the trade rate-limit bookkeeping (the two `[trade-audit]` lines). Observation only — it never influences pacing |
| `POE_TRADE_AUDIT_THRESHOLD` | `0.8` | fraction of a rate-limit window that triggers the "getting tight" line. **`0` is honoured** and means "report every window": the line is edge-triggered per rule+window, so it is one line per window and not one per request, and the audit never sends a request of its own. `POE_TRADE_AUDIT=0` is the off switch |
| `POE_DATA_STALE_TICKS` | `3` | how many missed checks make a source "stale" in the UI status line. Relative to `POE_DATA_REFRESH_MS` (3 × 24 h = 3 days), never an absolute duration. **Anything below 1 is refused**, `0` included — it would call every source stale the moment it was refreshed |
| `POE_DATA_STATUS_REASON_MAX` | `300` | how many characters of the **last failure reason** a data source's status line carries. The note used to say only how long a source had been quiet, so "the endpoint is briefly away" and "this build cannot read the format any more" read identically for days (`docs/bugs.md` B24). The reason is foreign text and is filtered before it is stored (credentials in a URL masked, a line naming something that could be a credential dropped whole) and then cut to this length. **Anything below 40 is refused**, `0` included — a shorter sentence no longer names what failed, which is the one thing it is there for |
| `POE_DATA_CHECK_NOW_COOLDOWN_MS` | `300000` (5 min) | how long the admin area's **"Check now"** button stays shut after a run. The button exists because every repair this page offers — the patch version above all — otherwise takes until the next daily check to show any effect, and until then "my fix did not work" and "my fix has not been tried yet" look identical. It is not free: one press is a patch lookup, a conditional fetch of every upstream file, and, when something is out of date, a game-data export that pulls tens of megabytes from the patch CDN. The person most likely to press it repeatedly is the one in the middle of a repair, which is what the cooldown is for. **Anything below 60000 is refused**, `0` included — "no cooldown" is not a setting, it is the absence of the guard. A check that is already running is refused separately and always (HTTP 409), whatever this says |
| `POE_ASK_CONFLICT_RATIO` | `4` | how far an exchange headline and the trade-site asks must diverge before the card marks them as disagreeing (`Exchange — asks disagree`). Measured against the ask MEDIAN when the headline is the higher one, against the CHEAPEST ask when it is the lower one. **`0` is refused, and so is anything below 1**: at 0 every card is marked, and below 1 the test fires when the headline is merely near the asks. A large value silences the marker |
| `POE_ASK_CONFLICT_ABS_GAP_C` | `5` | absolute chaos gap required on top of that ratio, so near-floor items — where 1-chaos walls are endemic — do not trip it. **`0` means no absolute gap: the ratio alone decides.** Fractional values are allowed (half a chaos is a real gap) |
| `POE_MIN_ASK_EVIDENCE` | `5` | minimum listing count before the asks may contradict the headline at all; below that the ask median is itself noise. **`0` means no minimum.** The listings are already fetched when this is read, so it is a confidence bar and never a request cap. Whole numbers |
| `POE_MIN_CONFLICT_HEADLINE_C` | `1` | headlines below this are never marked: the trade site cannot list under 1 chaos, so sub-chaos fungibles would trip on granularity alone. **`0` means mark sub-chaos headlines too** — for investigating exactly that case. Fractional values are allowed |
| `POE_SESSID` | unset | POESESSID for a single user, as an alternative to `networth-users.json`. Only takes effect together with `POE_NETWORTH_ACCOUNT` |
| `POE_NETWORTH_ACCOUNT` | unset | account name in full `Name#1234` form belonging to `POE_SESSID`; the short name alone gets a 403 |
| `POE_NETWORTH_USER` | first entry of `POE_USERS` | which user the `POE_SESSID`/`POE_NETWORTH_ACCOUNT` pair belongs to |
| `POE_UPDATE_DIR` | `/config` | where the update button leaves its request and reads the host script's heartbeat and result. Must be the same directory `deploy/host-update.sh` has as its `CONFIG_DIR` — see "Update button" below |
| `POE_UPDATE_HEARTBEAT_MAX_AGE_MS` | `1200000` (20 min) | how old the host script's heartbeat may get before the admin area says no updater is installed. 20 min = three missed 5-minute runs plus slack; raise it if you run the script less often. **Anything below 60000 (1 min) is refused**, `0` included — it would report an installed updater as missing |
| `POE_BUILD_COMMIT` | unset → `unknown` | which commit the image was built from, shown in the admin area. Normally not set by hand — it comes from the `BUILD_COMMIT` **build argument** (see "Which version is running") |

### How a number in this table is read

Every numeric setting above goes through one reader
(`backend/v2/env-number.mjs`, with the table of defaults and ranges in
`numeric-settings.mjs`), and it follows one rule you only have to learn once:

- **Unset, empty or whitespace** means "not configured" and quietly uses the
  default in the table. An empty compose line must not switch anything off.
- **A usable value** is used as given.
- **A value that cannot be honoured** — a typo, a negative number, something
  outside the stated range, or a `0` on a setting that has no meaning for one —
  is **reported in the log, and the default is used**. It is never silently
  replaced, and it never stops the container from starting: for the settings
  that decide request volume the default is the conservative direction anyway
  (see the two exceptions below), and a boot loop would leave you with no admin
  area to correct the setting from. The line names the variable, the value, the
  reason and what is being used instead:

  ```
  [config] POE_NETWORTH_COOLDOWN_MS=0 is not a usable value (zero is not a
  setting here; allowed: numbers >= 600000) — using 600000 instead.
  ```

  **What it falls back to is the DEFAULT, not the nearest allowed value**, so
  expect a jump rather than a nudge: `POE_CORPSE_TTL_MS=1800000` (30 min) runs
  on six hours, not on the one-hour minimum, and `POE_CORPSE_BUDGET_PER_HOUR=50`
  runs on 25, not on the ceiling of 30. The number actually in use is always in
  the log line — read that, not the compose file.

  **Three settings fall back to MORE traffic than the value that was refused**,
  because their dangerous direction is up rather than down:
  `POE_CORPSE_BUDGET_PER_HOUR` (a typo like `0.5` or `none` lands on 25
  Trade-API queries an hour — a plain `0` is honoured and really does mean
  none), `POE_FAUSTUS_UNION_HOURS` (a refused value lands on 8, i.e. one hourly
  CDN digest fetched per unioned hour) and, since 2026-08-11,
  `POE_MAX_REQUEUE_ON_RECONNECT` (a refused value lands on 10 `auto` Trade-API
  searches per reconnect; a plain `0` is honoured and re-queues nothing). All
  three say so in the log, and no other setting read through this reader
  answers a refusal with more requests than were asked for.

- **The seven request-volume settings have floors, and the one budget a
  ceiling.** `POE_NETWORTH_SYNC_INTERVAL_MS`, `POE_NETWORTH_COOLDOWN_MS`,
  `POE_CORPSE_INTERVAL_MS`, `POE_CORPSE_TTL_MS`, `POE_FAUSTUS_REFRESH_MS`,
  `POE_CD_REFRESH_MS` and `POE_DATA_REFRESH_MS` refuse anything below the
  minimum named in their row; `POE_CORPSE_BUDGET_PER_HOUR` refuses anything
  above 30. Each number is argued in its row, and at length in the range note at
  the top of `numeric-settings.mjs`. This is **tighter than before 2026-08-11**,
  when all of them accepted an interval of one millisecond, and the reason is
  the same ban that couples the two paths (see "Rate limiting & bans"): if a ban
  reaches the whole address, no path here has a request volume that is somebody
  else's problem.

  **An existing installation cannot break on this.** A compose value that is now
  out of range takes exactly the path above — one loud `[config]` line, and the
  **default** is used. Nothing throws, the container starts, the admin area
  still answers. If you have tuned one of these below its new floor, the log
  after the next `docker compose up -d` names it, and until you change it the
  tool runs on the documented default, which is the conservative value.

- **`0` is decided per setting, and the table says which it is.** It is
  honoured where it means something an operator needs to be able to say —
  `POE_CORPSE_BUDGET_PER_HOUR=0` ("query nothing"), `PORT=0` ("any free
  port"), `POE_LANG_SKEW_WARN_RATIO=0` ("warn on any gap"),
  `POE_MAX_REQUEUE_ON_RECONNECT=0` ("re-queue nothing"),
  `POE_TRADE_AUDIT_THRESHOLD=0`, `POE_NETWORTH_SLOW_STEP_MS=0`, the three
  display thresholds of the ask-conflict marker
  (`POE_ASK_CONFLICT_ABS_GAP_C`, `POE_MIN_ASK_EVIDENCE`,
  `POE_MIN_CONFLICT_HEADLINE_C`), `POE_RATE_LIMIT_BANNER_MIN_SEC=0`, and all
  four `POE_NETWORTH_GUARD_*` bars, of which
  `POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE=0` switches the arrival bar off. It is
  refused where it would mean a loop with no pause against GGG or poe.ninja, a
  cache that never holds anything, a backoff of no length, a stash request
  timeout that expires before any answer, a room that evicts every card as fast
  as it is created, or a marker that fires on everything.

This replaces the `Number(x) || default` idiom, which could tell neither "set to
zero" from "not set" nor a typo from either: `POE_CORPSE_BUDGET_PER_HOUR=0` used
to hand back 25 Trade-API queries an hour to somebody switching the corpse
pricer off, and said nothing about it.

**There is no second idiom left either for a setting with a default.** Seven settings were read further
down `server.mjs` through a helper of their own,
`Math.max(1, Number(raw) || fallback)` — the same trap in another spelling.
`POE_MAX_ITEMS_PER_ROOM`, `POE_MAX_REQUEUE_ON_RECONNECT`,
`POE_RATE_LIMIT_BANNER_MIN_SEC`, `POE_ASK_CONFLICT_RATIO`,
`POE_ASK_CONFLICT_ABS_GAP_C`, `POE_MIN_ASK_EVIDENCE` and
`POE_MIN_CONFLICT_HEADLINE_C` now go through the same reader as everything else,
five of them honouring a zero that used to be swallowed. The last three
hand-rolled reads of a setting with a default, `PORT`, `POE_LANG_SKEW_WARN_RATIO` and `POE_STASH_TIMEOUT_MS`,
go through it as well. `POE_STASH_PROBE` (a diagnostic tab index with no default) is the deliberate exception and is still read by hand. Defaults are unchanged, and a test with hand-written
literals is what says so — see
[bugs.md](bugs.md#b13--seven-more-settings-could-not-express-zero-fixed).

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

> **⚠ A value set in the admin area beats this file.** Some of the settings
> above can also be changed from the browser; those are stored in
> `/config/overrides.json` and are folded into the environment **before** the
> server reads anything, so they win over `docker-compose.override.yml`. If a
> compose value appears to do nothing, that is the first thing to check — the
> admin area's configuration section marks every such setting with
> *overrides your compose value*. Read "Configuration from the admin area"
> below before editing compose for one of them.

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
- **`user-langs.json`** — which client language each user picked for himself
  (`POE_USER_LANG_STORE`). `{ "player1": "en", "player2": "de" }`. **Beats
  `POE_USER_LANGS`**; delete the file to fall back to the environment for
  everyone.
- **`overrides.json`** — the settings changed from the admin area
  (`POE_CONFIG_OVERRIDES`). **Beats the environment.** Two siblings belong to
  it: `overrides.applying` (present only while a start is in progress; it holds
  `failedStarts=N`, the number of starts in a row that never got as far as
  listening) and `overrides.rejected.json` (a set of overrides that broke
  repeated starts, parked so it can be inspected). Delete `overrides.json` to go
  back to compose/defaults entirely.
- **`update-request` / `update-heartbeat` / `update-result`** — the three files
  of the update button (`POE_UPDATE_DIR`). They only exist where
  `deploy/host-update.sh` is installed on the host, or where somebody has
  pressed the button at least once; a plain installation has none of them. See
  "Update button" below. Safe to delete: the request is a pending ask, the other
  two are a report.
  **Not here: the host script's lock and its staging files.** Those live in a
  directory of the script's own, next to this one (`…/config.host-update`), and
  deliberately not in here — this directory is writable by the container, and
  the script runs as root over it. See "Update button" below.
- **`admin-password`** — one plaintext line, the password for the admin area of
  the settings page (`POE_ADMIN_PASSWORD_FILE`). Created with the default `admin`
  on first boot. **Change it before exposing the tool beyond the LAN** — see
  "Settings page & admin area" below.
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
- **`release-check.json`** — the release check's memory (`POE_RELEASE_CHECK_STATE`):
  when GitHub was last asked, when it may be asked again, what it answered (the
  latest release's version, tag, link and date), and the `ETag` for the next
  conditional request. Safe to delete: the check starts empty and asks again
  about 10 minutes after the next start. A file that cannot be read is logged
  once and treated as empty (`[release-check] state file … is not usable` when
  the content is not a JSON object, `… could not be read` when the file cannot
  be opened); it never stops the server from starting.
- **`networth-users.json`** — the per-user credentials (`accountName` +
  POESESSID; path `POE_NETWORTH_CONFIG`). Only Net Worth needs it: the stash
  reads use the session cookie, the price check does not. It holds
  secrets: see "Net-Worth-Tracker" below.

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

Ownership decides, not the permission bits: on a share that is group-writable
for a group the service is not in (exactly the Unraid case) `test -w` reports
"not writable", and chowning on that basis would rewrite the share's ownership
recursively, including every existing file.

Afterwards it `exec`s the server under UID 1000 via `setpriv`, so the server
itself never runs as root. Pinning `user:` in compose still wins: the script
then runs unprivileged and simply execs the command.

If the log says `/config is owned by uid N and not writable`, fix it once by
hand — the entrypoint deliberately does not:
```bash
ssh your-server 'chown -R 1000:1000 /path/to/poe-price-tool/config && docker restart poe-price-tool'
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
| localized data set (`data/de/*`) | the second parser — a user on a German client | **none. Generated locally** from the English set above plus GGG's game data (`patch.poecdn.com`). Only exists when `POE_USER_LANGS`/`POE_LANG_DEFAULT` or a stored per-user choice (`/config/user-langs.json`) name a language beyond `en` |

How it behaves:

- **~Daily checks** (`POE_DATA_REFRESH_MS`), plus one look **shortly after every boot**
  (the APT data after 2 min, the base names after 7 min, so a restart right after a
  league patch picks the new data up within minutes and the two never fire at the same
  moment). The localized set has no timer of its own: it is checked as a follow-up step
  of every APT check, and only when a language beyond `en` is in use.
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
- **Bilingual snapshots**: a snapshot dir holds `data/en` and, once a localized set
  exists, `data/de` **next to it** — never instead of it (the localized load path still
  reads `data/en/client_strings.js`, and both engine instances share one process-wide
  data root). The localized set has no upstream: it is generated locally, so **every
  adoption carries the existing one forward unchanged**, exactly like
  `item-drop.json`/`patrons.json`. English may therefore run ahead while the localized
  set stays on its last good state. The boot check demands `data/de` exactly when the
  snapshot was adopted with one, so an English-only install is unaffected and a
  half-written localized tree is still rejected. If a snapshot ever lost a set that a
  live parser needs, the reload vetoes the adoption and both languages stay on the
  previous snapshot.
- **The localized set regenerates itself** — as a **post step of the `apt` check**, not
  on a timer of its own (the generator reads the active snapshot, and a concurrent
  `apt` check is free to prune it away underneath; riding along inherits that check's
  overlap guard). What triggers a run is **not an event but a comparison**: every set
  carries a `build-info.json` saying which **patch version** and which **English
  skeleton** it was built from, and every tick recomputes both and compares. Equal →
  nothing happens. Different → generate. That is deliberately a level and not an edge:
  after a run that failed, an event-driven trigger would report "patch unchanged,
  nothing to do" the next day, the source would count as healthy forever and the skew
  would never become visible. With the comparison the difference simply stands, so
  every tick either retries or reports `failed`, and the source ages into the stale
  note below like any other. A successful run writes a **complete new snapshot**
  (English tree byte for byte, aux files, the new localized tree) and swaps it in
  through the same validated reload-with-rollback path as an upstream adoption.
  The game-data export works in `POE_DATA_REFRESH_DIR/lang-work` and caches ~32 MiB
  of GGG bundles under it (the exporter clears that cache itself on a patch change) —
  worth knowing when sizing the `/config` volume, and the reason it lives there rather
  than in a container-local tmp dir that every restart would throw away.
- **Skew policy**: English comes from upstream and is adopted **immediately**, even
  when the localized set cannot follow — English users do not lose currency over a
  language they do not use. The localized set catches up on the next generation run;
  until then the old tree stays live (carried forward, see above) and its own row says
  so. Whether the localized set has fallen behind in CONTENT is a different question
  and a different mechanism — the settings page's skew view, `lang-skew.mjs`.
- **What makes a generated set unusable, and what only makes it INCOMPLETE.** These
  are two different findings and since 2026-08-18 they are two different answers
  (`docs/bugs.md` B23). A run is thrown away — nothing written, previous set stays
  live — when it would **lose** coverage the live set already has: stats that carry a
  German matcher today and would not afterwards. That is a broken derivation, and the
  bar is `POE_LANG_MAX_COVERAGE_LOSS_RATIO` (1 % of what the live set covers).
  A run is **kept** when the only stats without a German matcher are ones the previous
  set had no matcher for either — English lines whose text the derivation has no source
  for, because upstream has run ahead of the patch or because it has started shipping a
  kind of matcher the derivation does not know yet. That gap is real and it is reported,
  but refusing the run does not close a single one of them: the set that would stay live
  does not carry those stats **at all**, and a stat with an empty matcher list and a
  stat that is missing outright are the same thing to every reader of this data. So the
  incomplete-but-newer set wins, and the log says how incomplete:

  ```
  [data-refresh] data/de (the English snapshot moved on; 8773 of 9278 stats carry a
  matcher, 505 do not) generated from patch 3.29.3.1.2 (…) into v-…
  ```

  The container log additionally lists every affected ref in full, under two headings
  that are the same distinction again — `COVERAGE LOST against <dir>` (what this run
  gave up, the actionable half) and `COVERAGE GAP (new, the previous set did not carry
  these either)`. The unresolved matcher strings are listed too, split into "on stats
  the previous set already had" (a defect here) and "on stats that are new since the
  previous set" (no source for them yet) — that split is what identified the second half
  of B23, where the new matchers turned out to be plain skill and gem names and the
  tables holding those names in German were being exported on every run and never read.
  In the browser the same distance is the skew view's `matchers` row (`lang-skew.mjs`),
  which warns above `POE_LANG_SKEW_WARN_RATIO` — and that is where a gap that never
  closes becomes visible, because the generator will keep succeeding.
- **Where the patch version comes from.** The generator needs it to build the CDN path
  (`patch.poecdn.com/<patch>/Bundles2/…`), and it is the one input nothing local
  provides. There is no endpoint of GGG's this tool may ask: the CDN answers 404/403 to
  every guess at a listing, and `pathofexile.com` is off limits here (ban history).
  It is therefore looked up at **`https://ggpk.exposed/version?poe=1`**, which answers
  with one line — the CDN base of the current patch. That is the same endpoint the
  `repoe-fork` export pipeline resolves its own version with, and that pipeline's
  output (`base_items.json`) is already a daily dependency of this tool, so it is not a
  new party to trust. The answer is validated, not believed: the host has to be
  `patch.poecdn.com` and the version has to be digits and dots — **however many
  parts** it carries. Four is the usual shape, five happens (a hotfix on a hotfix),
  and a pattern that expected at most four once froze the German set for four days;
  see `docs/bugs.md`, B22. What is still refused is everything without the shape of a
  version — a letter, an empty path, a path segment like `../../etc` — because the
  string is pasted straight into a CDN path.
  **`POE_PATCH_VERSION` overrides the lookup outright** — set it when the service is
  gone or answers wrong, either in the compose file or, since 2026-08-18, **in the
  admin area** (Settings → admin area → server settings). It takes effect at the
  next check without a restart, and the field validates it with the same pattern the
  start does. Without either, the check reports `failed` (never a guessed
  version), which is correct but blunt: an installation that cannot determine the
  patch can no longer keep its localized set current, so it says so rather than
  pretending.
- **When the lookup or its answer is what failed**, this is what it looks like from
  the outside and where to start. In the browser the staleness note names the source,
  the age, **the reason and what to do about it** (see "Visible when a source goes
  quiet", `docs/bugs.md` B24):

  ```
  Data auto-update: no successful check of lang-data for 5 days — the tool keeps
  running with the data it has. Last attempt for lang-data failed: https://ggpk.exposed/version?poe=1
  answered "…" — no patch version in that path. An answer arrived and this tool
  refused it. That does not fix itself: see the admin area on the settings page and
  the container log.
  ```

  The same sentence is in the container log once a day, in the `lang-data` check line:

  ```
  [data-refresh] lang-data check failed (kept last good state): https://ggpk.exposed/version?poe=1 answered "…" — no patch version in that path; last success 2026-08-13T02:17:45.212Z
  ```

  Read it as follows. `could not be looked up` = the service did not answer at all
  (down, DNS, blocked egress) — that is the class the note calls "nothing to do here",
  and the next check retries by itself. `expected a https://patch.poecdn.com/<patch>/ URL` =
  it answered something that is not a CDN base — a captive portal or an error page
  looks like this. `no patch version in that path` = it answered a CDN base whose
  last path segment is not a version. The last two are the class the note calls
  "this tool refused it": waiting does not help. If that last segment plainly IS the
  current patch, the tool is wrong, not the service — fix the
  validation (`PATCH_RE` in `backend/v2/patch-version.mjs`) rather than working
  around it. **In every one of the three, `POE_PATCH_VERSION=<version>` gets the
  localized set current again** — see "Pinning the patch version" directly below for
  what the pin costs and what watches it. English is unaffected throughout — it
  comes from upstream and is adopted whatever the localized side is doing, which is
  precisely why this can run for days without anything looking broken.
- **Pinning the patch version, and what watches the pin.** `POE_PATCH_VERSION` is
  the escape hatch, and since it became settable from the admin form it is also the
  easiest thing on this page to get quietly wrong. It has two failure modes, and
  both are easy to miss:

  - **Valid, but not a real patch.** `3.29.9.9` passes the pattern. The CDN then
    refuses every file the export asks for, and a retry cannot
    fix a value somebody typed in themselves, so the class is `rejected` rather
    than `unreachable` ("the next check tries again"), and the
    reason names the pin: *"the game-data export asked the patch CDN for … and was
    refused. The patch version 3.29.9.9 it asked for comes from POE_PATCH_VERSION,
    not from the lookup — every check repeats the same request until that pin is
    changed or cleared."* The distinction is not a guess: `pathofexile-dat` prints
    that line on exactly one branch, `!response.ok`, so an answer did arrive. What
    the line does **not** carry is the status code, so a 404 and a 503 look alike —
    and that is precisely where the pin decides, because with a pin every retry
    asks for the same version and with none the version came from the lookup.
  - **Valid and right, until the next patch.** Then nothing is wrong with any
    check: they succeed, report `unchanged`, and the localized set is frozen on
    last league's data with no age warning anywhere, because a source that is
    checked daily never goes stale.

    So **the lookup is asked even when the pin wins**, and a disagreement is
    reported as a warning on a check that otherwise succeeded:

    ```
    Note on lang-data: POE_PATCH_VERSION pins the patch to 3.29.2.1;
    https://ggpk.exposed/version?poe=1 reports 3.30.0.1. The localized set is
    built from 3.29.2.1 until the pin is changed or cleared.
    ```

    The pin still wins — nothing here overrules a human, and "the pin is stale" and
    "the lookup is wrong again" produce the identical difference. The message says
    what was seen, not what it means. A lookup that is **down** while a pin stands
    costs nothing and says nothing: that is the situation the pin was set for.
- **Verifying a repair without waiting a day.** The checks run once a day, so a pin
  that was just cleared, corrected or set changes nothing on screen until the next
  one — and "my fix did not work" and "my fix has not been tried yet" look the same
  from the outside. **Settings → admin area → server settings → "Check now"** runs
  every check immediately and redraws the status line with the result. It sits
  behind the admin password like the restart button, because it starts outbound
  traffic on demand. It refuses while a check is already running (HTTP 409) and for
  `POE_DATA_CHECK_NOW_COOLDOWN_MS` after one finished (HTTP 429, with the remaining
  wait in the answer), because one press is a lookup, five conditional fetches (the four APT files
  and `base_items.json`) and
  possibly a multi-megabyte CDN download. `POE_DATA_REFRESH_DISABLED=1` turns it
  off along with everything else it would trigger.
- **When the game-data export is what failed.** The export is a child process
  (`pathofexile-dat`). Its exit code and stderr are read, so the ways it can die
  are told apart instead of arriving as the message for a *misspelled language
  name* (`docs/bugs.md` B24):

  | What the check says | What it means | What to do |
  |---|---|---|
  | `the game-data export refuses this build: … the dat schema has a format its version cannot read` | GGG changed the dat format and the exporter in **this image** predates the change. Nothing about the data or the configuration is wrong | **Update the container** (admin area, "Update to a newer version"). This is the one that will happen eventually and by itself |
  | `the game-data export found no column "X" in table "Y"` | Same family: the column list this build asks for no longer matches the schema | Update the container; if it survives that, `TABLE_COLUMNS` in `lang-data-gen.mjs` has to move |
  | `the game-data export asked the patch CDN for … and was refused` | The CDN refused a file of that patch. Without a `POE_PATCH_VERSION` pin the version came from the lookup, so the patch exists and the CDN is unwell (class `unreachable`). With a pin the message says so, and the class is `rejected`: the pinned version itself is what is refused | Without a pin: nothing — the next check tries again. With a pin: change or clear `POE_PATCH_VERSION`, because every check repeats the same request until then |
  | `exited with code N: …` | Not recognised. The last lines it printed are quoted verbatim and **no cause is claimed** | Read the quoted lines, then the container log |
  | `export incomplete: … has English but no German` | The exporter exited 0 and wrote nothing for the target language: it did not accept the translation name | Compare `LANGUAGE_NAMES` in `lang-data-gen.mjs` with the list in `pathofexile-dat/dist/cli/export-tables.js` |
  | `export incomplete: … holds neither English nor German` | The exporter wrote no tables at all. **Not** a language problem | Container log — the export's own output is in it, line by line |
- **A language configured without data** (`POE_USER_LANGS` names `de`, but no
  `data/de` exists yet — a *stored* choice for such a language is dropped at
  startup instead, see "Client language at runtime"): English keeps working,
  and that user's `POST /item` is
  answered with **503** plus one warning line at startup. It is deliberately not
  parsed as English — a wrong-language parse comes back as a plausible item, not as an
  error. The first generation run after that fixes it without a redeploy.

  **This is what you will see the first time you switch a language on, and it
  looks worse than it is.** The already-adopted snapshot was written before the
  language existed, so it has no `data/de` — and the engine says so in the
  bluntest possible way:

  ```
  [engine] parsers=[en]  snapshot languages=[en]  MISSING=[de] — those users get an error instead of an English parse
  [engine] no parser for language "de" (Cannot find module '/config/data-refresh/apt/v-…/data/de/client_strings.js'
           imported from /app/backend/v2/engine.bundle.mjs) — items from users on that language are rejected loudly
  ```

  A `Cannot find module` at boot reads like a crash; it is not. Nothing is
  broken and nothing needs reinstalling. The **first apt check after boot**
  (120 s by default, see the startup line `first checks in apt:120s`) generates
  the set, adopts a snapshot carrying both languages, and reloads both parsers.
  After that the startup line reads `parsers=[en, de]`. If it still says
  `MISSING=[de]` several minutes later, then something did fail — check the
  `lang-data` line for the reason.
- **One line per check** — the whole point being that silence means "not running",
  never "nothing to do". Three sources checked once a day = three lines a day
  (`lang-data` only on an install that serves a second language):

  ```
  [data-refresh] apt check updated — APT data updated (v-2026-07-31T04-02-11-903Z): items.ndjson 41988->42130 lines (+150/-8); upstream Tue, 29 Jul 2026 22:14:07 GMT -> Thu, 31 Jul 2026 03:41:52 GMT
  [data-refresh] lang-data check unchanged — data/de built from patch 3.29.2.1 and the current English snapshot; data from 2026-07-31T04:03:44.118Z
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
- **…and it says WHY, and whether that is yours to fix.** The reason of the last
  failed check is persisted with it and travels into that note, together with the
  CLASS of the failure. There are four, and the fourth is the important one:

  | Class | The note adds | Meaning |
  |---|---|---|
  | `unreachable` | "The other side did not answer — nothing to do here, the next check tries again on its own." | An upstream or the patch lookup was away; or the patch CDN refused a file for a patch version that came from the lookup |
  | `rejected` | "An answer arrived and this tool refused it. That does not fix itself…" | A snapshot that failed validation, a lookup answering something that is not a version — **or the patch CDN refusing a file for a version that `POE_PATCH_VERSION` pinned**, because every retry then asks for the same one |
  | `incompatible` | "The data format has moved past this build — update the container…" | The game-data export cannot read the current format with this image. Shown **immediately**, without waiting for the source to go stale: that diagnosis is certain the moment it is made, and three silent days on a known cause is the defect this line exists to remove |
  | `unknown` | **nothing** | Nobody classified this failure. The reason is shown as it is and no remedy is claimed |

  **The reason is a finding; the advice belongs to the class.** The reasons used to
  argue their own remedy ("update the container", "nothing to fix here, the next
  check tries again") while the page printed the class's advice next to them — two
  authorities for one question, and the reason was the one that could not be right
  when the class changed. They state what was seen now, and nothing else. Where a
  class-level sentence is not enough, the detail is here in the documentation:
  a repeated `incompatible` on a missing COLUMN after a container update means
  `TABLE_COLUMNS` in `lang-data-gen.mjs` is what has to move.

  **A fourth thing a check can say: a warning.** It is not an outcome. A check can
  succeed and still have something to report, and the case it was built for is a
  pinned patch version — see "Pinning the patch version" below. A warning is shown
  whatever the outcome and whether or not anything is stale, and it carries **no**
  advice: it is a finding the check made about itself, and inventing a remedy for
  it would be the same mistake in a new place.

  The class is set where the failure happens and is never derived from the wording
  of the message afterwards, which is why `unknown` exists at all: a status line
  that guessed would be worse than one that says the sentence and stops. The reason
  is foreign text — it is filtered and cut to `POE_DATA_STATUS_REASON_MAX`
  characters before it is stored, **and filtered again when it is read back out of
  `state.json`**, because that file outlives the build that wrote it.

  The filter works at VALUE granularity, which is not the same filter the update
  block's host output goes through. That one drops a whole LINE that names
  anything credential-shaped, which is right for a multi-line build log and wrong
  for a text that IS one line: a reason saying `key count` or `Unexpected token`
  came out of it as nothing but the placeholder — the cause deleted, and a
  credential warning asserted in its place. Here the VALUE a credential-shaped
  name is handed is masked (`token=***`, `Authorization: Bearer ***`,
  `POESESSID ***`) and the words around it stay. Same limit as ever, stated so
  nobody reads more into it: it catches names and shapes, and a bare secret on a
  line that names nothing passes both filters alike.

The manual CLIs (`npm run update-apt-data`, `node backend/v2/base-names-gen.mjs`)
refresh the **checked-in** copies in the repo (so a fresh image also starts
reasonably current), and serve as an emergency hatch. They are no longer needed to
keep a running deployment current. `npm run gen-lang-data -- --lang de` is a
different kind of tool: it generates the localized set **locally** and does not
refresh a checked-in copy — the generated `items.ndjson`, `stats.ndjson` and
`text-pairs.ndjson` are not part of the repository
(`renderer/public/data/.gitignore`). It looks the patch version up like the
background run does; `--patch 3.29.2.1` and `--dry-run` are there when you want to
pin or just look.

### Settings page & admin area (`/settings.html`)

One page for everything that gets configured, plus the place where the tool
reports what it could not do.

**Client language** is the first section, deliberately above the credentials: it
is the only user-facing setting whose wrong value fails silently (the item is
not parsed at all — no card, and no error in the game either), so it is placed
where it is read without scrolling and carries the explanation of what it
actually selects. It is a switch, not a form: choosing a language saves it. See
"Client language at runtime" below for the storage and precedence rules.

**Sync settings** (middle) are the net-worth credentials — account name and
POESESSID for the user the `ppt_user` cookie names. The Net Worth page has no
credentials dialog of its own: its "Sync settings" button and its sync status
line link to this page. The stored POESESSID is never delivered to the browser in any form, an empty field
keeps it, and a save takes effect on the next background sync tick.

**Releases** sits between the sync settings and the admin area and is visible
without the password: the installed version of this server (or "unknown" when it
cannot read its own), the latest release GitHub reported (version, date, link to
its page; or "No release published yet" / "Not checked yet"), when the last
check ran and what it found, and one sentence on a failed check (GitHub not
reachable, the request refused — usually its rate limit —, or an answer that
could not be read, e.g. a tag that is not a version number). It ends with the
reminder that the server is updated by whoever runs it and that every player's
hotkey daemon is its own clone. The same facts reach every page as one line in
the status line when a newer release exists. See "Release check" under "Which
version is running" below.

**Admin area** (bottom) is behind a password. It holds the blocks below — the
last three of them (offset, provenance, display texts) are one block on the page,
because they answer three halves of the same question: how far apart the language
data sets are, where the localized one came from, and whether the texts around it
followed. The configuration section has its own chapter, "Configuration from the
admin area", below, and the update block one of its own, "Update button":

- **Server settings** — the allow-listed configuration this installation can
  change while it runs, in three blocks: what takes effect immediately, what
  needs a restart, and — set apart with its own explanation — the settings that
  decide how often the tool asks GGG, poe.ninja and the data sources. Plus the
  **Restart** button. If repeated starts with
  those settings failed, an alarm sits above everything else in the area saying
  they were quarantined and are not in effect; saving anything clears it, since
  the file it describes has then been replaced. Under the alarm, and only while
  it applies, sits the notice that the admin password is still the default —
  which now guards this section and the restart button, not just a read-only
  view.
- **Update to a newer version** — a block of its own, not a second button beside
  the restart: a restart is harmless and frequent, an update replaces the running
  code. It shows which commit this container was built from, asks a script on the
  host to `git pull` and rebuild, and reports how that went. Disabled with an
  explanation where that script is not installed — which is every installation
  until somebody installs it. Its own chapter: "Update button".
- **Check for a newer release** — a block of its own next to the update block:
  the **Check for updates** button asks GitHub now (`POST /admin/release-check`)
  and prints one sentence — up to date, `<version>` is available, no release
  published yet, or the failure. It only reports; it installs nothing and it
  works whether or not the daily automatic check is switched on. One check at a
  time, and 60 seconds between two manual checks.
- **Everything else this server runs with** — a read-only list at the end of the
  area, so the effective configuration can be read without a shell on the
  server. Filtered by name; nothing that could be a credential is in it.

- **Gaps the tool found by itself** — collected while price-checking, grouped by
  language, sorted by frequency:
  - *Failed parses:* the engine refused a clipboard text. No card ever reached
    the browser. The row carries the item-class header as its signature, the
    engine's reason, and the full triggering text behind a disclosure so the
    failure can be reproduced. Two items of the same class failing for the same
    reason are ONE counted row — the rolls are not part of the identity.
  - *Unresolved mod lines:* the item parsed, but a line matched neither the
    vendored data set nor GGG's stat catalogue. The card shows it read-only and
    the search ignores it, so the returned price is the price of a different
    item. This is the more dangerous of the two, because nothing looks broken.
  - **Lifetime and size:** in memory only. The list starts empty after a restart
    (a gap that matters recurs the next time that item is checked), and it is
    capped at `POE_GAP_LOG_MAX` entries per kind. Over the cap the *least
    frequent* entry is dropped — the recurring gap is the one worth keeping —
    and the view prints how many were dropped, so a truncated list never
    pretends to be complete.
- **Dataset offset between the languages** — how much of the English set a
  localized one failed to carry: item names, stat entries, stats without any
  matcher, and stats whose extended (`Ctrl+Alt+C`) mod description is missing.
  Each row is measured against the English set the container is *actually*
  serving, and turns into a warning above `POE_LANG_SKEW_WARN_RATIO`. Two states
  need no threshold: a configured language with no data set at all, and refs
  that exist only in the localized set (zero by construction — anything else
  means the generator left its own design). This is a comparison between two
  sources; the `data-status` staleness note cannot make one, it only reports
  each source against itself.
- **Where the localized set comes from** — in the same block, under the offset
  rows, because the offset is a *distance* and says nothing about whether anything
  is still producing the set. Read out of `build-info.json` next to the data the
  container is serving right now: when it was generated, from which game patch, how
  many stats carry a matcher, how many the run **lost** against the set it replaced
  (that is the number a regression shows up in), how many are newly without one, and
  the item side — translated, kept English. A set generated before this bookkeeping
  existed says so; its numbers are shown as absent, never as zeroes.
  - A line in warning colour appears when the run met an **item namespace with no
    name source at all**. Every entry of such a namespace keeps its English name and
    nothing else on this page moves — not the offset rows (the entries exist, their
    refs match), not the coverage numbers (those are about stats). It is the quietest
    gap the data set has, which is why it gets a sentence of its own.
- **Display texts (`client_strings.js`)** — last in the block, and a different
  question from everything above it: the English file is refreshed from upstream
  every day, the localized one is hand written and ships **with the image**. When
  upstream adds a key, that key is simply absent for the other language, and if the
  parser reads it the failure lands on a user of that language as an unexplained
  parse error. The key sets are compared at every English adoption and the
  difference is named here and in the log. Note what is claimed: the tool knows
  which keys differ, not which of them the parser reads — so it says "any of them
  the parser reads is missing", never that something will fail. **A container update
  closes this; a data refresh cannot.**

**What this is not.** It is a page you have to open. The tool sends nothing on
its own — no mail, no push. Compared with reading container logs that is a step
forward, but it is the same kind of mechanism: you do not have to *search*, you
do have to *look*.

#### The admin password

Plaintext, one line, in `POE_ADMIN_PASSWORD_FILE` (default
`/config/admin-password`). The file is created with the default value `admin` on
first boot if it is not there. It is read on **every** request, so changing it
takes effect on the next click — no restart, no cache to clear:

```bash
printf 'your-own-password\n' > ./config/admin-password
```

> **Change it before this tool is reachable from anywhere but your home
> network.** The default is `admin`, and it is printed in this repository for
> everyone to read — so on an exposed instance it is not a weak password, it is
> a published one. That is doubly true because everything else in `/config` is
> plaintext as well: `networth-users.json` holds POESESSID session cookies, and
> those are full account control if they leak.

**What it guards grew.** This partition started in front of a read-only
diagnostic view. The same password now also ends the process (the **Restart**
button) and writes the configuration file the next start reads (the **server
settings** section). The trust model is unchanged and stays unchanged — LAN, no
authentication, one plaintext password — but the default being in force is no
longer a small thing, so the tool says so in two places while it is:

- a block of `[admin]` lines in the container log at **every** start,
- a notice in the admin area itself, above the settings it guards.

Both disappear on the next request after the file is changed. Nothing is forced:
a tool that demanded a new password before it would run could lock you out of
your own box on a LAN it was never exposed on, which is the worse failure.

The mechanism is deliberately a **partition, not a security boundary**. This
backend has no authentication at all (identity is a freely settable cookie, the
LAN is the trust boundary), and the admin area does not add one: its job is to
keep the ordinary user out of a view that is none of their business, and to let
whoever runs the box in without ceremony.

The state model, so nobody reinvents it as something bigger: the browser keeps
the password in `sessionStorage` and sends it as the `X-Admin-Password` header
on every admin request. There is **no session on the server**, no token and no
expiry — closing the tab is the logout, and rewriting the password file locks
every open tab out at its next request.

### Client language at runtime

The language a user's game client runs in decides which parser his pasted items
go through. The player sets it himself on the settings page, without shell
access or a restart; `POE_USER_LANGS` is only the starting value.

It is a control on the settings page now, above his own POESESSID, and
deliberately **not** behind the admin password for the same reason. On the page
it is a plain selector with no save button — selecting a language is the save —
and the paragraph over it says what the setting actually is, because the failure
mode is silent: a user who picks the language of the *website* rather than of
his *game* gets no card and no error when he copies an item. When only one
parser is live the selector is shown disabled with that reason next to it rather
than hidden, and when `/config` is not writable the page says out loud that the
choice will not survive a restart.

**The file beats the environment.** The choice is stored in
`/config/user-langs.json` (`POE_USER_LANG_STORE`); `POE_USER_LANGS` is only the
value a user starts on until he has chosen once. Rounded that way on purpose: if
the environment won, the next deploy would silently revert somebody's own
choice, and a setting that quietly goes back a week later is worse than one that
never existed.

```json
{ "player1": "en", "player2": "de" }
```

- A **stored entry the server cannot honour is dropped, never fatal**: a user
  who is no longer in `POE_USERS`, a language the tool does not support, or a
  language this container has no loaded parser for. Each drop prints one warning
  naming the user, the value and the reason, and that user falls back to his
  `POE_USER_LANGS`/`POE_LANG_DEFAULT` value. (`POE_USER_LANGS` itself stays a
  hard startup error — it is written by hand, this file is not.)
- **Broken JSON does not stop the start.** The file is moved to
  `user-langs.json.broken` and the server comes up without it, loudly.
- The switch is immediate: the value is persisted first, then applied, then
  pushed to every open tab of that user over the WebSocket. No restart.

**Which languages can be chosen** is what the server has a *live parser* for,
not the list it supports in principle. At boot it loads one parser per language
whose data set is in the active snapshot, so a language somebody once configured
stays selectable even after the last user has left it. A language that has
**never** been configured has no data set and therefore cannot be picked — set
`POE_LANG_DEFAULT` (compose, or the admin area's configuration section) to it
once and restart; the data auto-update generates the set, and from then on every
user can switch to it in the browser.

**Everything selectable is kept up to date.** The data auto-update refreshes the
same set of languages the switch offers — configured *plus* chosen by a user
*plus* present in the active snapshot — not just the configured ones. Otherwise
a language nobody is configured for any more would stay pickable while its data
set quietly aged, and whoever picked it would get parsed against a stale set
with nothing on screen saying so. The set is fixed once per boot, which is
enough: a language only becomes selectable by having a parser, parsers are
loaded at boot, and `POE_LANG_DEFAULT` is a *restart* setting — every way to
make a new language selectable goes through a start.

### Configuration from the admin area

The configuration section of the admin area writes `/config/overrides.json` and
folds it into the process environment at the next start — or immediately, for
the settings that are read at use time.

**The override wins over the real environment.** `docker-compose.override.yml`
is what the box was started with; the override file is what a human deliberately
submitted through the running tool. If the environment won, a button in the web
UI would silently do nothing whenever the same key happened to be set in
compose, which is the failure this exists to remove. The price is that a compose
value can sit there doing nothing, so the view names the **source** of every
setting (`override` / `env` / `default`) and marks the ones that are shadowing
an environment value. When something does not behave like compose says it
should, look here first.

The section is grouped by that answer — *takes effect immediately* above, *needs
a restart* below — and a value that has been written but is not in force yet is
marked on its own row and once more above the table. A row also shows where its
value comes from in words rather than as the raw `source` token, and an entry
that is in the file but fails validation is labelled as such instead of being
drawn as if it were the value in force.

**Below both of those sits a third block: *How often this tool asks other
people's servers*.** The settings in it decide how much traffic the background
jobs send to the trade API, to poe.ninja, to GGG's exchange feed and to the data
sources, and they are kept out of the ordinary groups on purpose — a number that
raises request volume must not sit flush against the display name and the league
picker as though it were the same kind of dial. The block carries one paragraph
saying why, and every row in it says which direction adds requests (a budget
grows with the number, an interval or a cache lifetime with the *smaller* one).
Nothing but the request COUNT gets in: `POE_MAX_LISTINGS` looks like a traffic
setting and is not, because all ten listings arrive in one call, and
`POE_NETWORTH_LIST_TTL_MS` is not one either — see its row in the table above.
Which rows belong there is served by the endpoint like everything else, so the
page cannot hold a stale opinion about it.

> The **ranges** behind those fields are the ones the environment accepts
> (`numeric-settings.mjs`), not tighter ones invented for the browser. They are
> tight because a ban was reported to apply to the whole address: the floors are
> 30 s between refresher ticks, 10 min for the post-429 cooldown, 2 min between
> corpse queries, 1 h for the corpse cache, the Faustus pass and the data check,
> and 15 min for the C:D refresh (poe.ninja's limit); the corpse budget stops at
> 30 an hour, which is all its pacing can deliver anyway. Every field can still be
> moved in the direction that sends *less*. Treat the defaults as the tested
> configuration and change them by factors, not by orders of magnitude.

Per setting the view shows whether a change is `live` or needs a `restart`.
Nothing is guessed: a value the server reads once into a constant at startup is
declared `restart`, and the page says so rather than pretending. **Restart** is
a button of its own — it answers, then ends the process cleanly. There is
deliberately **no docker socket** mounted for this: handing a container that has
no authentication control over its own host daemon is a far bigger hole than a
restart button is worth.

**Whether the tool comes back is a property of your deployment, not of the
tool.** Three cases, and only the first is the one the button was built for:

| how it was started | what the button does |
|---|---|
| the shipped `docker-compose.yml` (`restart: unless-stopped`) | the container stops and the daemon starts it again within a second |
| docker **without** a restart policy — your own compose file, `docker run` without `--restart`, another orchestrator | the container stops and **stays stopped** until somebody starts it on the host |
| by hand (`node backend/v2/server.mjs`) | the process ends; starting it again is your job |

The middle row is the dangerous one, because from the browser it is
indistinguishable from the first: it runs in a container, so it looks like
something will bring it back. Nothing will, the web UI goes down with the
process, and without access to the host there is then nothing left to undo it
from.

The tool does **not** try to work out which case it is in. Docker gives a
container no way to read its own restart policy, and the one thing that could
answer it is the socket that is deliberately not mounted — a heuristic that is
right most of the time would be worse here than no answer at all. So the
condition is *named* rather than checked: the confirmation dialog spells it out
before anything happens, and when the page's wait for the server runs out it
says that nothing appears to have restarted the container, what to run on the
host, and to add a restart policy so the button works next time. That last
message survives a page reload, because whoever needs it has just lost the page
it was written on.

If you keep the restart button but not the shipped compose file, add the policy:

```yaml
services:
  poe-price-tool:
    restart: unless-stopped
```

Every override can be **removed** again (the UI's *reset*), which puts the
setting back on the compose value it was started with, or on the built-in
default if there was none. The way back always exists — otherwise the first bad
value would need an SSH session.

**Boot quarantine — the restart loop that cannot happen.** An override that kills
the process at startup would restart forever and leave no web UI to undo it. So
applying the file is bracketed: `overrides.applying` is written **before** the
values reach the environment and deleted the moment the server is listening.

That marker **counts, it does not switch.** What it can observe is "the last
start did not reach `listen`" — never "the overrides were to blame". The whole
expensive boot sits inside that window (the engine instances load serially, the
data refresher initialises), and so does everything from outside that can end a
process in it: a `docker compose restart` typed at the wrong second, a host
reboot, an out-of-memory kill. Meanwhile only validated values reach the file
through the UI and none of the allow-listed keys can realistically kill a boot,
so a one-strike rule would have thrown away a **working** configuration far more
often than a poisonous one. The marker therefore carries the number of
consecutive failed starts:

| starts in a row that never listened | what the next start does |
|---|---|
| 1 | applies the overrides again and says so in the log (`did not reach 'listening' (1 of 2 …)`) |
| 2 | moves the file to `overrides.rejected.json` and boots on the compose/default configuration |

A start that reaches `listen` deletes the marker and with it the count, so two
failures a week apart never add up. Nothing is lost either way — inspect the
rejected file and put it back by hand if the problem was elsewhere:

```bash
docker logs poe-price-tool | grep config-overrides
ls -la ./config/overrides*            # overrides.rejected.json is the parked one
cat ./config/overrides.applying       # exists only during a boot: failedStarts=N
```

Saving anything on the settings page **clears the quarantine alarm**: the alarm
describes a file that was put aside, and that write replaces it. The parked
`overrides.rejected.json` stays where it is — nothing but you puts it back.

> **One `/config` volume belongs to exactly one instance.** Two containers on
> the same volume share this marker (and the override file, and the language
> store), so they count each other's boots as their own failures — two instances
> started together are enough to quarantine a perfectly good configuration. This
> is deliberately not defended against with a lock: a lock brings its own
> stale-holder problem, for a case that is a deployment mistake to begin with.
> Give each instance its own volume.

**What can be set** is a fixed allow-list, validated by type on the way in
(a value that fails is refused with a `400`, not written). Today, in the three
blocks the page draws them in:

- *Identity and display* — `POE_APP_NAME`, `POE_LEAGUE`, `POE_LANG_DEFAULT`,
  `POE_PATCH_VERSION`, `POE_MAX_LISTINGS`, `POE_NETWORTH_DEBUG`, `POE_CD_RATIO`.
  `POE_PATCH_VERSION` is the odd one in that group and is there for a reason: it
  is the documented repair for a patch lookup that has failed, and until
  2026-08-18 it could only be set in the compose file — so the escape hatch that
  exists to save an SSH session needed one. It is **empty by default** (the
  version is looked up), takes effect at the **next check** without a restart,
  and is validated with the generator's own pattern, so the form cannot accept a
  value the next start would refuse. Clear it again after the following patch, or
  the localized set stays on the version you pinned.
- *The background jobs, as switches* — `POE_NETWORTH_AUTOSYNC`,
  `POE_FAUSTUS_DISABLED`, `POE_CORPSE_DISABLED`, `POE_DATA_REFRESH_DISABLED`,
  `POE_REFERENCE_DISABLED`. Their dangerous direction is "on", which is also
  the default and is written on the label, so they stay in the ordinary groups.
  `POE_RELEASE_CHECK_DISABLED` is a switch of the same kind but not dangerous
  either way: "on" costs one request a day to GitHub and nothing towards the
  trade API.
- *Bars and limits that cost nobody a request* — `POE_NETWORTH_LIST_TTL_MS`,
  `POE_FAUSTUS_TTL_MS`, `POE_DATA_STALE_TICKS`, `POE_GAP_LOG_MAX`,
  `POE_GAP_LOG_TEXT_MAX`, `POE_UPDATE_HEARTBEAT_MAX_AGE_MS`.
- *How often this tool asks other people's servers* (its own block, above) —
  `POE_NETWORTH_SYNC_INTERVAL_MS`, `POE_NETWORTH_COOLDOWN_MS`,
  `POE_CORPSE_BUDGET_PER_HOUR`, `POE_CORPSE_INTERVAL_MS`, `POE_CORPSE_TTL_MS`,
  `POE_FAUSTUS_REFRESH_MS`, `POE_CD_REFRESH_MS`, `POE_DATA_REFRESH_MS`,
  `POE_NETWORTH_SKIP_TIER_MAPS`. The last one is the only switch in that block:
  it is **on by default** and passes over the per-tier pages of the map stash,
  which is 14 of 43 sub-tabs on the account it was measured on — normal maps
  carry no price here, so what it saves is requests and what it costs is
  nothing that was ever part of the number. Turning it **off** reads the whole
  map stash and makes a full round markedly longer.

The list itself is served by the endpoint (`backend/v2/config-overrides.mjs`),
so the page and the server cannot disagree about it — and a test compares the
names above against that list, so this paragraph cannot quietly go stale either.
The **defaults and ranges** of every numeric row are read out of
`numeric-settings.mjs`, the same table the server reads the value through: there
is one answer to "what is the default" and one to "what is allowed", and the
allow-list may only narrow a range for the browser path, never widen it.

**What can never be set**, and why:

- `POE_USERS` — rooms, the per-tab net-worth store, the credential file and the
  language mapping are all keyed by those names. One click in a browser must not
  be able to orphan all of that. It stays in compose.
- **Paths and ports** — a wrong one takes the tool off the air with nothing left
  to fix it from.
- `POE_PRICE_CHECK_DISABLED`, `POE_REFERENCE_ON_CONNECT_DISABLED` and
  `POE_LEAGUE_LIST_DISABLED` — they
  exist for the test suite and for a deployment that deliberately runs without
  the price check or without client-triggered reference traffic. Offered as
  checkboxes they would switch off the tool's main feature and the rail beside
  it, and every card afterwards would be unpriced with nothing on the page
  saying why.
- `POE_TRADE_AUDIT` and `POE_TRADE_AUDIT_THRESHOLD` — the rate-limit audit is
  the observability that exists *because* of the two bans. A page that can blind
  the tool to how full its rate-limit windows are is the wrong page, and the
  threshold follows its switch: it is a fraction with no upper bound, so a `2`
  typed into a form would silence the audit as effectively as the switch, and
  without saying so.
- `POE_FAUSTUS_UNION_HOURS` — the one numeric setting with no default of its
  own: unset means "faustus.mjs decides" (8), which is the normal state, so the
  page could not answer *what do I get if I clear this*, the one thing every
  other row can. It also multiplies the CDN fetches of every refresh pass, which
  makes compose the safer home for it.
- **Anything secret.** No POESESSID, no account name, no password. Not settable,
  and not *shown* either: the read-only block that lists the remaining effective
  settings so you do not have to go looking over SSH is filtered by name, and a
  test walks the entire response and fails on any key that could name a
  credential.

### Which version is running

The admin area's update block prints the commit the running image was built
from. Docker has no idea what git thinks and the build context does not even
contain `.git`, so the only source is whoever starts the build:

```bash
BUILD_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
```

Without it the block says **unknown**, and that is on purpose — a plausible
made-up value is worse than no value for the one question every update starts
with. `deploy/host-update.sh` (below) passes it by itself, so an update through
the button always records its commit.

The commit line stays; beside it the server knows its **version number**, the
`"version"` field of the `package.json` the image carries (the `Dockerfile` copies
it into the runtime image). When that file is missing or has no `x.y.z` version,
the Releases block on the settings page says **unknown** instead of guessing.

#### Release check

Once a day (24 hours after the last check, whatever it found, success or
failure; first check about 10 minutes after a start with no state) the backend
asks `https://api.github.com/repos/<POE_RELEASE_REPO>/releases/latest` for the
latest release and compares its tag with the installed version. The tag must look
like `1.2.3` or `v1.2.3`; anything else — a pre-release suffix, four numbers, no
tag — is an answer that cannot be read, not a silent "current".

- **What it sends:** a GET with `Accept: application/vnd.github+json`, an
  `If-None-Match` with the stored `ETag`, and the installed version inside the
  User-Agent (`poe-price-tool/<version> (release check)`). Nothing else, no
  credentials. A request that gets no answer within 10 seconds counts as
  unreachable.
- **What comes of it:** when the latest release is newer, every page shows one
  line saying so and the settings page names both versions and links the release
  page. Equal or older (a development build) is silent; the manual check then
  says "up to date". A failure is silent when automatic; the last good answer
  stays in `release-check.json`. Whether a release is newer is worked out each time
  the status is read, so a freshly updated server stops reporting it at boot.
- **It never installs anything.** Updating stays "Update procedure" below.
- **Turn it off:** `POE_RELEASE_CHECK_DISABLED=1`, or the switch in the admin
  area (read at each tick, so it takes effect live). The manual button works
  either way.
- **Fork:** `POE_RELEASE_REPO` points the check at another repository.
- **Wire format:** `release-status` message and `GET /release-status` in
  `backend/v2/frontend/PROTOCOL.md`.

### Update button (`deploy/host-update.sh`)

The admin area has an **Update** block below the restart button. It pulls the
newest code on the server and rebuilds the container — but only if you have
installed a small script on the host first. **Without that script nothing about
this installation changes**: the button is visible, disabled, and says what
would have to happen. Nothing new is written into `/config`, nothing new runs at
startup.

#### Why it works this way round, and not with the Docker socket

The restart button can end its own process; the container supervisor brings it
back. An update cannot work like that: `git pull && docker compose up -d --build`
needs a checkout and a Docker daemon, and both live on the host.

The obvious shortcut is to bind-mount `/var/run/docker.sock` into the container.
That is deliberately not done, and it is worth being blunt about why:
**the Docker socket is unauthenticated root on the host.** Anything that can
reach it can start a container with `/` bind-mounted and own the machine. What
would be handed that power here is a tool with **no authentication at all** (LAN
by design), whose admin area sits behind one plaintext password whose default is
published in a public repository, and which parses foreign text off the internet
all day. That trade — the whole host for the convenience of a button — is not
one this project makes.

So the direction is reversed: **the container asks, the host decides.**

```
  container                       /config volume                 host (cron)
  ─────────                       ──────────────                 ───────────
  POST /update-request  ──────▶   update-request     ──────▶     host-update.sh
                                                                   ├ writes heartbeat
                                                                   ├ deletes the request
                                                                   ├ git pull --ff-only
                                                                   └ docker compose up -d --build
  GET /update-status    ◀──────   update-heartbeat   ◀──────     (every run)
                        ◀──────   update-result      ◀──────     (after a run)
```

**The security property everything hangs on:** the script reads the request file
only to learn *that* somebody asked, never *what* to do. Directory and command
are constants at the head of the script. No branch, no tag, no path, no argument
travels out of that file into a command — it is never sourced, expanded or
evaluated. Writing that file is exactly what an attacker who reached the admin
area can do, and the most it can achieve is "the host rebuilds the code the host
already has". The moment a value from the file reached the command line, the
request would become an instruction and that would be remote code execution on
the host. If you edit the script, keep it that way; the same warning is in its
header.

**The second half of the same argument, about files rather than commands:** the
shared directory is writable by the container and the script runs as root over
it, so the script trusts no *name* in there to be what it looks like either. It
stages nothing inside that directory (a predictable path there plus a root
writer is a way to have root overwrite a file somewhere else, and a FIFO there
is a way to hang the updater for good), it keeps its lock outside it (in there,
the container could occupy the lock once and no update would ever run again),
and anything in there that exists but is not a plain file stops the run with a
message instead of being worked around. Publishing into the directory is a
`rename()`, which follows no symlink and opens nothing.

#### Before you install it: three things that must be true

1. **The checkout must not be reachable from the container.** This is the one
   misconfiguration that turns the whole design around: whoever takes over the
   container can then rewrite `docker-compose.yml`, the `Dockerfile` and the
   source, and the next update builds and runs that, as root, on the host.
   Ignoring the request file perfectly is worth nothing then. **The direction
   of the nesting decides**; an overlap as such is not the danger, and the
   shipped compose file produces one of the harmless ones on every install:

   - **`REPO_DIR` inside `CONFIG_DIR`, or the two being the same** — dangerous.
     The container may write anywhere in the config directory, so the checkout
     would be its to edit. **The script refuses to run at all in this case.**
   - **`CONFIG_DIR` inside `REPO_DIR`** — **normal, and allowed.** This is what
     `git clone` plus `docker compose up -d --build` gives you, because the
     shipped compose file mounts `./config`, a subdirectory of the checkout. A
     bind mount goes one way: the container sees the directory that was mounted
     into it, not the tree that directory was taken from. It cannot reach
     `docker-compose.yml` one level up. Earlier versions of the script refused
     this too, which made the button unusable for every install that followed
     the README.
   - **The checkout bind-mounted into the container under some other path** —
     dangerous, and **the script cannot see this one**. To answer it, it would
     have to know every compose file, override and template that took part in
     starting the container, and it knows none of them. That part is on you:
     the shipped `docker-compose.yml` mounts `./config` and nothing else, and
     this is the reason to keep it that way.

2. **The build context must exclude what the container writes.** The permitted
   nesting has a price: `docker compose up -d --build` sends the whole checkout
   to the Docker daemon minus what `.dockerignore` excludes, so a config
   directory inside the checkout is in that context — with every configured
   user's POESESSID (`networth-users.json`) and the admin password
   (`admin-password`) in it. The `Dockerfile` copies none of it, so nothing of
   it reaches the image today, but sending secrets to the daemon on every build
   is exposure nobody asked for, and one later `COPY` that reaches wider than
   it meant to would put them in an image.

   The repository's `.dockerignore` therefore excludes `config` and
   `config.host-update` (the work directory from point 3, whose staging files
   hold the *unredacted* build output). **The script checks this before it
   builds** — it reads `.dockerignore` the way Docker does and refuses to start
   a build that would ship those directories. If you renamed either directory,
   add its name to `.dockerignore`; the refusal names the line to add.

3. **The script needs a directory of its own** for its lock and its staging
   files, and the container must not be able to reach that one. By default it
   is a sibling of the config directory — `…/config.host-update` — which is
   outside the volume (only `CONFIG_DIR` itself is mounted) and on the same
   filesystem, and being on the same filesystem is what makes publishing into
   the volume an atomic rename rather than a copy a reader can catch halfway.
   Adjust `WORK_DIR` only to somewhere with both properties — `/var/lib/…` is
   tidier and wrong, because it is usually a different filesystem.

   In the standard arrangement it lands **inside the checkout**, next to
   `config/`. That is why the repository ignores it twice: `.gitignore` keeps it
   out of `git status`, `.dockerignore` out of the build context.

#### Installing it

The script is `deploy/host-update.sh` in this repository. It is POSIX `sh`, and
short enough to read before you install it — do that, because you are about to
run it as root on a schedule. Most of its length is the argument for why it is
shaped the way it is; the code itself is around a hundred lines.

1. Copy it onto the Docker host and `chmod +x` it — **a copy outside the
   checkout, not the file in `deploy/`**. The checkout is already on the host,
   so running it where it lies is the obvious move and it is the wrong one:
   this script's whole job is to `git pull` that checkout, and a pull can
   replace the script file while the shell is still reading it. `sh` reads a
   script incrementally, by byte offset — a file swapped mid-run resumes at the
   old offset in new content, which does not fail cleanly. It also keeps your
   two edited constants out of the way of the next pull.
2. Edit the two constants at the top:

   ```sh
   REPO_DIR="/mnt/user/appdata/poe-price-tool"           # the checkout with docker-compose.yml
   CONFIG_DIR="/mnt/user/appdata/poe-price-tool/config"  # the HOST side of the /config volume
   ```

   Those example paths are from an Unraid box; use your own. They show the
   arrangement you get by following the README — the checkout, and its own
   `config/` subdirectory, because that is what the compose file mounts. You do
   not have to rebuild your deployment into two sibling directories.

   `CONFIG_DIR` must be the same directory the compose file mounts as `/config`
   (and the same one `POE_UPDATE_DIR` names inside the container, if you changed
   it). The checkout must not sit inside it, and `.dockerignore` must exclude
   it — see above.
3. Run it every 5 minutes, as a user that may use `docker` and write in the
   checkout — usually root. Any of these:

   - **Unraid, "User Scripts" plugin** — add a script, paste the file in, set the
     schedule to *Custom* with `*/5 * * * *`.
   - **plain cron** — `crontab -e`:
     ```
     */5 * * * * /path/to/host-update.sh >/dev/null 2>&1
     ```
   - **systemd timer** — a `poe-price-tool-update.service` of `Type=oneshot`
     calling the script, plus a `.timer` with `OnBootSec=5min` and
     `OnUnitActiveSec=5min`. **One difference from the other two, and it is
     visible in the admin area:** cron and User Scripts start every tick as its
     own process, so the ticks that arrive during a long build still refresh the
     heartbeat. systemd does not start a second run of a `Type=oneshot` service
     while the first is still in the build — nothing refreshes the heartbeat
     until it finishes, and a build longer than the tool's window (20 minutes by
     default) makes the admin area say "no updater is set up" in the middle of
     the update it was asked for. It corrects itself on the next run. If your
     builds get anywhere near that, either raise
     `POE_UPDATE_HEARTBEAT_MAX_AGE_MS` past your worst one or use cron.

4. Open the admin area. Within five minutes the update block stops saying "no
   update script is set up" and the button becomes usable.

Nothing else is needed inside the container: `POE_UPDATE_DIR` defaults to
`/config`, which is where the volume already is.

#### What the script does, exactly

- **Refuses to run** if the checkout sits inside the shared directory (or is the
  same directory), if a directory it is about to send to the Docker daemon is
  not excluded by `.dockerignore`, or if it cannot create its own work directory
  outside the shared one. All three are the preconditions above, checked rather
  than only written down — a comment cannot refuse to run.
- **Writes its heartbeat on every run that gets past the precondition checks** — including the
  runs that find nothing to do, and including the ones that exit immediately
  because a build is already running. That is what the admin area reads
  "an updater is installed" from. (With a systemd `Type=oneshot` timer there are
  no such runs during a build; see the note at the install step.)
- **Does nothing without a request.** There is no daily pull, no "while we are
  here anyway". Nobody presses, nothing updates.
- **Stops with a message if anything in the shared directory is not a plain
  file** — a symlink, a directory or a pipe where one of its three files
  belongs. That is not a state to work around; it is somebody having been in
  the volume, and the run says so instead of continuing.
- **Deletes the request before it starts working.** A failed build must not be
  retried every five minutes for as long as nobody looks; a failure is reported
  and waits for a human to press again.
- **Takes a lock** (`update.lock`, a directory — `mkdir` is atomic) so two cron
  ticks can never build at the same time. The lock lives in the script's work
  directory, not in the shared one: in there the container could create it once
  and no update would ever run again.
- **Reports a lock nobody is holding.** If a run is killed hard — a host reboot
  in the middle of a build — the lock stays behind and every later run exits at
  it. Once it is older than two hours (far past any build), the script writes
  that into the heartbeat and exits non-zero on every run, and the admin area
  disables the button and says the updater is stuck. It does **not** break the
  lock by itself: that would mean guessing that the run holding it is dead, and
  guessing wrong means two builds of the same image at once. See "When the
  updater is stuck" below.
- **Runs exactly two commands** in `REPO_DIR`: `git pull --ff-only` and
  `docker compose up -d --build`, with `BUILD_COMMIT` read from the checkout
  after the pull so the new image knows its own commit.
- **Writes the result**: outcome, start and finish time, and the tail of the
  output (4 000 bytes). Written by staging it in the work directory and renaming
  it into place, so a reader never sees half a file.

#### Reading it back in the browser

The admin area shows the last result and, on a failure, the end of the output.
That excerpt is **text from the host**, so it is treated as foreign: bounded on
the way in, put into the page as text and never as markup, and run through the
same name filter `/config-view` uses — a line that names a credential is
**dropped** and replaced by a visible marker, and credentials inside a URL
(`https://user:token@host/…`, which a failing `git` will happily print) are
masked. A dropped line in a build log costs nothing; a leaked token does.

**That filter is not a guarantee, and the page says so under the excerpt.** It
catches names and shapes: a line that *names* something like a credential, a URL
with a credential where credentials go. A **bare token on a line that names
nothing and forms no URL** — an id echoed by a build step, a key printed on its
own — goes straight through, and nothing that would catch it reliably would also
leave the error message readable. Treat the excerpt as text that may still hold
a secret: that is what it is.

"An updater is installed" means: a heartbeat that is **less than 20 minutes**
old (`POE_UPDATE_HEARTBEAT_MAX_AGE_MS`). At the recommended 5-minute schedule
that is three missed runs plus a cushion for a busy host or a clock a minute
off. A missing heartbeat is reported as **"not set up"**, never as "broken" —
the tool cannot tell a script that was never installed from one that was
removed an hour ago, and it does not pretend it can.

#### When nothing comes back

The page waits up to 15 minutes and then says so. The likely reasons, in order:

```bash
cat config/update-result          # the host tried: status=failed plus the tail of the output
ls -la config/update-request      # still there -> nothing picked it up: the script is not running
cat config/update-heartbeat       # a "stuck-since=" line means the lock below
```

If the request file is still sitting there, the script never ran: check the
cron/User-Scripts schedule and that the user it runs as may use `docker`.

#### When the updater is stuck

A run killed hard — a host reboot in the middle of a build, a `SIGKILL` — leaves
the lock behind, and every later run writes its heartbeat and then exits at that
lock. The updater is alive by every measure and picks nothing up.

The admin area says so: the button is **disabled** and the block says the update
script is stuck. The script says the same, to stderr, on every run, and exits
non-zero — so cron mails it, if you did not redirect that away. To clear it, on
the host (the work directory is the sibling of your config directory):

```bash
ls -la /mnt/user/appdata/poe-price-tool/config.host-update   # look before you delete
rm -f  /mnt/user/appdata/poe-price-tool/config.host-update/update.lock.started
rmdir  /mnt/user/appdata/poe-price-tool/config.host-update/update.lock
```

Check that no build really is running first — that is exactly the check the
script cannot do for you, which is why it reports the lock instead of breaking
it. The next run picks up the waiting request, if there still is one.

#### It does not replace the command line

The button exists for the case where you are not at a shell. **The normal way to
update stays [`git pull && docker compose up -d --build`](#update-procedure) on
the server**, and everything the runbooks say about league starts and manual
data refreshes is unchanged — those steps have no button and are not going to
get one.

### Net-Worth-Tracker (`/networth.html`)

Reads the whole stash via the legacy `character-window/get-stash-items` endpoint
using the **POESESSID** session cookie (ToS gray area, personal use only —
knowingly accepted).

<a id="stash-api-language"></a>
**Stash API language — measured, 2026-08-10.** The tracker joins GGG's
`typeLine` against the English `refName` of the item database
(`backend/v2/networth/normalize.mjs`), so a localized response would break the
whole valuation. It does not: the API answers **English regardless of language
settings**. Verified by switching all three in turn and watching a full
refresher cycle after each:

| Setting | Result |
|---|---|
| Game client → German, account still English | a full cycle, nothing changed |
| Account *Preferred Language* → German **and** the site to `de.pathofexile.com` | 18 of 18 tabs re-fetched, **870 item names, zero carrying German characters** |

That matches what the code and GGG's own wording predict: the client sends no
`Accept-Language` (`backend/v2/networth/stash-client.mjs`), and the account
preference is described by GGG as governing "automated messages and emails" —
not API payloads. So a German player needs **no translation step** here.

Two caveats. This is one account, and GGG could start localizing these payloads
without notice. The symptom would be unmistakable — the assignment rate
collapses for that user and the unpriced list fills with German names — and it
is visible per user in the admin area's gap view, which is part of why that view
exists.

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

<a id="folder-subtab-shape"></a>
**Every sub-tab is read except the map stash's tier pages, and the log says
which those were.** A folder tab is read whole: every child the parent response
lists and that carries an `id` is requested — with one exception, and the way
that exception is drawn is the whole story.

On 2026-08-13 there briefly was a different one. The map stash's per-tier
sub-folders hold only normal maps, which are never priced, so a *name pattern*
passed them over. GGG does not name those children after their section. It names
them **`"1"`, `"2"`, …, page numbers**, so the pattern matched all 39 of them and
the whole map stash went unread, `Unique Maps` and `Special Maps` with it, for
about 165 chaos of net worth that the history then recorded as missing. It was
reverted the same day (`docs/bugs.md`, B19), and what shipped in its place was
the measurement below.

That measurement answered on **2026-08-19**: the children carry
`metadata.map.section`, which is GGG's own label — `unique`, `special` or
`tier<N>`. The skip came back on that field and runs the other way round:
**only an explicit `tier<N>` is passed over**, so a missing `metadata`, an
unrecognised section or a stash shaped differently is read exactly as before.
The worst a misreading can now do is cost requests; the name rule's worst case
cost a whole tab. On the account it was measured on that is 14 of 43 sub-tabs,
one derived spacing each.

It is a setting — `POE_NETWORTH_SKIP_TIER_MAPS`, on by default, `0` reads the
whole map stash — and it is not a silent one. Every walk that passes anything
over says so in the ordinary log, without a debug flag:

    [stash-client] folder tab "Maps": 14 of 43 sub-tabs not read — GGG lists
    them as tier16 x2, tier11, tier12, … , i.e. pages of normal maps, which
    carry no price. That saves 14 of the 44 requests this tab costs.
    POE_NETWORTH_SKIP_TIER_MAPS=0 reads them too.

A switch whose *on* state silently deletes value from the net worth would not be
a setting. This one deletes nothing that was ever a priced number — normal maps
are unpriced stock either way, so what changes is that they stop appearing in
the *unpriced* list — and it says out loud what it left out.

**What is left is the measurement that should have come first.** The first time
a process walks a given folder tab it prints the children exactly as GGG
returned them — one line per folder tab per process, never per walk, and it
costs no request because the parent response is already in hand:

    [stash-client] folder tab "Maps" (MapStash) sub-tab shape as GGG returns it,
    once per process: 39 children, entry fields: id,parent,name,type,metadata —
    parent response keys: stash; parent stash fields: …; parent metadata: {…} —
    "1" type=MapStash metadata={…}, "2" type=MapStash metadata={…}, …

It reports the union of the child entry field names, each child's `name`, `type`
and the **content** of its `metadata` as JSON, every other field of a child by
value — so a `folder`, `page` or sort field nobody predicted shows up by itself —
and the parent's own fields and `metadata`, in case the structure is explained a
level up. `id` and `parent` are named but never printed: they are opaque
addressing tokens and say nothing about a section. Everything is foreign data,
so every value goes through the same credential filter that guards
`/config-view` (a key that could name a credential prints as `[redacted]`),
control characters are stripped, and each part is length-capped.

**What it is for.** Reading a folder tab cheaply needs one thing this response
has not yet been shown to carry: a marker saying which **section** a child
belongs to. `name` is a page number and `type` is the parent's type repeated on
every child — both measured, neither of them an answer. If `metadata` turns out
to carry one, a skip can be built on evidence; if it does not, the request count
of that tab is simply what it is, and the throughput has to come from somewhere
else. Guessing again is not on the list.

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

If ownership doesn't take effect (see "How the container handles /config
permissions" above — a NAS share the entrypoint deliberately won't take over),
fall back to a more permissive `chmod` (e.g. `644`) instead. Verify by checking the
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
the value in the file — no restart needed (credentials are re-read every
sync round).

**Why it expires so often:** every new login invalidates the previous
POESESSID — including logging in through your PoE account on a third-party
site (Filterblade and similar). A paused user after such a login is expected
behaviour, not a fault of the sync.

**Preferred way to set/renew credentials: the UI.** The Net Worth page has a
"Sync settings" section of the settings page (`/settings.html`; the Net Worth
page links to it from a button and from its sync status line) where the current
user sets `accountName` + `POESESSID` themselves. It writes the same `networth-users.json` atomically with `600`,
touching only that user's entry, and the refresher picks the change up on its
next tick. The stored POESESSID is never sent back to the browser in any form
(`GET /networth/credentials` returns account name + sync state only). The page
also shows the sync state per user (`ok` / `expired` / `cooldown` / `missing`)
in the global status line: the Net Worth page and the settings page show every
state in their own wording, while the History and Price Check pages show only
`expired` ("Background sync is paused: the stored POESESSID has expired. Renew it
on the settings page.") and leave the line empty otherwise. Everything below (SSH/heredoc/docker-exec) remains
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
`POE_NETWORTH_AUTOSYNC=0` disables it) continuously walks the configured users'
tabs **one tab per tick** (`POE_NETWORTH_SYNC_INTERVAL_MS`, default 30s) —
one tick is one tab for ONE user, taken round-robin, so the tick rate is the
whole load and does not multiply with the number of users — always picking that
user's stalest tab next; the same low-load, rate-limit-safe pattern as every
other background consumer. The stash-tab list itself is cached for
`POE_NETWORTH_LIST_TTL_MS` (default 15min). On a 429 **every** user backs off
for `POE_NETWORTH_COOLDOWN_MS` (default 10min), or for the `Retry-After` GGG
named if that is longer, before the next try — see "The stash path has its own
budget" above for why the pause is not limited to the user who got the 429.

**Why a drip-feed and no manual full-scan button:** a large stash (example:
~115 tabs) fetched back-to-back in one burst runs straight into GGG's
trade-API rate limit (429, aborts partway). The auto-refresher avoids this
entirely by spreading requests over time (one tab/~30s) instead of bursting
— there is no manual trigger; a full stash of that size fills in over one
refresher cycle (~115 tabs × 30s ≈ 1h), then stays fresh in the background
indefinitely.

The `/networth.html` page itself is **read-only** — it just displays
whatever the background auto-sync has built up so far, with no button that
starts a sync. A counter above the list reads
`{recent}/{total} tabs synced in the last 10 min · oldest tab synced {mins} min ago`;
the 10-minute window is fixed, not derived from the sync interval. Priced: stackables (currency/fragments/essences/
scarabs/fossils/resonators/oils/tattoos/omens/delirium orbs/artifacts, via
Faustus first), div cards, unique items, gems, beasts,
incubators, vials, Maven's Invitations, and itemised corpses (via
the Trade API); **rare/magic gear and non-unique maps
are deliberately out of scope** and show up as "skipped". Full source
routing and the rules behind each category: [docs/pricing-logic.md](pricing-logic.md).

A stash tab in the sidebar that is worth nothing now says **why**: hovering the
row gives `N priced · N unpriced · N skipped`, and the row itself carries a `⨯N`
when everything that arrived was skipped, or a `∅` when nothing arrived at all.
The two are told apart because "0c" alone cannot distinguish them (`docs/bugs.md`,
B7). The numbers come from the per-tab store.

#### When the refresher goes quiet

Before reading any of the below: check the ban banner. Since 2026-08-11 an
active **trade-API ban** stops this refresher as well, and it says so in the
status line ("the GGG trade API has blocked this app — stash syncing pauses with
it until …"). That is a quiet refresher doing the right thing; there is nothing
to diagnose and nothing to restart.

Otherwise: **one tick does one request**, and a tick is guarded so only one is
ever in flight. A **folder tab** (Unique/Map stash) costs `1 + N` requests, so
it is `1 + N` ticks: one sub-tab per turn, with every other tab and every other
user taking their turns in between exactly as usual.

**A folder tab does not hold the refresher for its whole walk.** Held inside
ONE step, as it was until 2026-08-13, it would occupy the global busy flag for the
whole of it. Measured on the container at a 24 s spacing: the map stash held its step for **913 s** (38 requests: the sub-tab
list plus ~37 sub-tabs) and the unique stash for **457 s** (19 = 1 + 18) — and
at the 80 s an unauthenticated rule set derives, the map stash would have held
it for **50 minutes**. Nothing else moved in that time, including other users,
so a deployment with several of them measured a full round in days rather than
hours. The walk is a piece of state the refresher puts down between ticks:
**the same requests, in the same order, at the same pace**, spread over their
own turns. What one folder tab now costs another user is one step.

These observations report all of this, all of them read-only:

| Where | What it says | How often it fires |
|---|---|---|
| `networth-sync-status` (WS) | `lastTab` — when a tab was last written for this user, and which. `current` — the step in flight: phase, since when, the tab name when it belongs to this user, and `child`/`childTotal` inside a folder tab | on connect and on every state change, as today. Nothing is pushed *during* a step — reload the page to take a fresh reading |
| `networth-sync-status` (WS) | `folderTab` — the folder tab being walked right now: which one, `done` of `total` sub-tabs, and since when. **Answerable between ticks**, which `current` is not: a walk is no longer a step, so most of the time there is no step to report | on connect and on every state change, while a walk is open |
| `[stash-client] folder tab "X" (MapStash): reading sub-tabs` | a folder tab has started | once per folder-tab turn, i.e. once per full round of the round-robin |
| `[stash-client] folder tab "X" (MapStash) sub-tab shape as GGG returns it, once per process: N children, entry fields: … — "…" type=… metadata={…}` | what the children really are: the field names, each child's name, type and `metadata` content, any further field by value, and the parent's own fields and metadata. Credential-filtered, control characters stripped, length-capped. It decides nothing itself — the rule that reads `metadata.map.section` is a separate module (`networth/map-sections.mjs`) | **once per folder tab per process**, never per walk. It costs no request — the response was already in hand |
| `[stash-client] folder tab "X" (MapStash) yielded 0 items — N sub-tabs, …` | a folder tab came back empty **without failing**. Names the sub-tab count, how many of them answered in the expected shape, how many were non-empty, and how many carry children of their own | never while folder tabs deliver, which is the state since the pace is derived (`docs/bugs.md`, B7 — the map stash reads full again). One line per turn of a folder tab that does come back empty |
| `[networth-refresher] folder tab "X" (index N) for <user>: M sub-tabs over S steps in Ts` | the closing bracket of a walk, and the counterpart to the `still busy` pair a folder tab no longer produces. Says `(K of them not read — see the line above)` when the tier-page skip was in force | once per folder-tab turn |
| `[stash-client] folder tab "X": K of M sub-tabs not read — GGG lists them as tier16 x2, …` | the tier pages of the map stash were passed over (`POE_NETWORTH_SKIP_TIER_MAPS`, on by default). Unconditional: value left out of a tab on purpose has to be visible without a debug flag | once per folder-tab turn, while the skip is on |
| `[networth-refresher] still busy: tab "X" … has been running for Ns` | one step has held the tick longer than `POE_NETWORTH_SLOW_STEP_MS` (2 min). A second line follows when it finally returns | **never in normal operation again.** A folder tab used to fire it every turn; a step is one request now, so this is back to meaning what it says — one genuinely stuck step, one line, not one per skipped tick |
| `[stash-client] folder tab "X" (MapStash) was NOT read in full — N sub-tabs, …` | a walk finished, nothing threw, and a sub-tab still said nothing about itself: it answered HTTP 200 with a body carrying no items array, or GGG listed an entry the walk cannot address. The same counts as the `yielded 0 items` line, plus how many answered with something else and how many could not be addressed. **Nothing is written** — the tab keeps the contents it was last really read with | never while folder tabs deliver; one line per folder-tab turn that hits it |
| `[networth-refresher] a tab of <user> was NOT read and is left as it was stored (no point is recorded from this step): …` | the refresher's end of the same thing, and it covers ordinary tabs too: GGG answered without contents, so the tab is not overwritten and no history point comes out of this step | never in normal operation; one line per affected turn |
| `[networth-history] the stash tabs <user> is summed over changed (N now, M before) — one point is skipped …` | the snapshot's set of stash tabs is not the one the last point was summed over: a tab was pruned out of the store, or one that had never been read has just been read. One point is skipped and the item diff starts over, because a tab appearing or disappearing is not stock moving | on a genuine tab deletion or a first reading; otherwise never |
| `[networth-history] recording for <user> over N of M tabs — K have been tried and never yielded a reading` | points are being written over less than the whole account. Allowed on purpose — a tab that never becomes readable must not stop the series for good, and its absence is then a constant in every point rather than a dip in one — but never silently. A `every tab of <user> reads again` line follows when it clears | on the transition only, not per tab |

**No watchdog releases a step, and none is needed for a folder tab any more.**
Forcing the busy flag back would put a second request against GGG in flight next
to the first and break the strict sequentiality the whole rate-limit discipline
rests on; this project has a ban history. What changed is not the guard but the
size of what it guards: a step is one request again (`docs/bugs.md`, B5).

**A half-read folder tab is never written to the store.** The walk lives in the
refresher's memory, so the previous *complete* contents of the tab keep counting
towards the snapshot until the new reading is finished, and a restart in the
middle of a walk simply walks it again from the beginning. A failure mid-walk
drops the walk and writes nothing; a 429 keeps it, so the cooldown costs the
remaining sub-tabs rather than all of them — and it costs the refused sub-tab
too, which the walk goes back to rather than stepping over: a walk with a hole
in it is not written at all any more, so skipping it would have made resuming
pointless.

**And "half-read" now includes a walk that finished without answers.** A
sub-tab can reply HTTP 200 with a body that carries no items array — the shape
B7 measured, and the only way it could name for a full tab to come back empty
with no error line anywhere. Such a walk is not accepted as the tab: a *subset*
would leave the store with a tab missing items nobody had moved, and the history
would record that as stock leaving the stash (`docs/bugs.md`, B2). The walk says
so in the log and writes nothing.

**A stored tab is only dropped when two consecutive tab lists agree it is gone.**
Two lines say so:

| Line | What happened |
|---|---|
| `[networth-store] a live tab list of L would drop N of M stored tabs for <user> — held back until a second list agrees` | one short (or empty) answer. **Nothing was deleted.** If the next list is whole again, nothing ever will be |
| `[networth-store] pruning N of M stored tabs for <user> (live tab list: L) — two consecutive lists agree they are gone` | the drop was carried out, for the tabs BOTH lists were missing |

Before 2026-08-11 the first line did not exist and the second fired on a single
answer, so one bad response could delete a user's entire stored stash — the last
known route into the partial-store window of B2. The price of the second opinion
is that a tab you really did delete in game keeps showing its stored value for
one more list interval (`POE_NETWORTH_LIST_TTL_MS`, 15 min by default); it costs
no extra request, because the second list is the one the refresher fetches on
that schedule anyway. There is deliberately **no threshold** on "how much
shorter": nobody has measured how often GGG answers short, and a number invented
on top of that would guard a guess with a guess.

### History page (`/history.html`)

The History page draws the net-worth series over time — a trend chart plus the
stock movements behind it ("what came in, what went out"). It has no data
source of its own: it reads what the Net-Worth auto-refresher records as it
walks the stash, over two read-only endpoints the page actually calls
(`/networth-trend`, `/networth-events`, identity via the same `ppt_user`
cookie). Selectable ranges are 1h, 6h, 24h, 7d and 14d. A third endpoint,
`/networth-detail` (per-point item detail), exists on the server but is not
called by the current frontend.

**What the chart is measured in.** Divine, and every point is converted with
**the C:D rate it was recorded at** — never with today's, which is why a figure
on this page cannot change any more once it has been recorded. One consequence
is worth knowing before it gets reported as a bug: when the divine grows more
expensive faster than the stash grows, the curve falls although nothing left the
stash. The rate of the shown window is therefore on screen — as a `C:D` row in
the rail and as a pale line across the plot (own scale, no second axis) — and an
**(i)** at the chart explains it on request. A window in which no point carries
a rate at all is labelled in chaos instead of guessing one; see
[`pricing-logic.md`](pricing-logic.md#what-a-figure-on-the-history-page-means).

**Where the data lives.** Two files in the `/config` volume:

- **`networth-history.ndjson`** (`POE_NETWORTH_HISTORY`) — the series itself,
  one JSON object per line, append-only. Each point carries the total in chaos,
  the C:D rate **of that moment** (so an old point is never re-derived with
  today's rate), and the biggest item movers since the previous point. Lines
  recorded before mid-2026 also hold a per-tab chaos breakdown; nothing reads it
  any more, it is no longer written, and such lines are still read normally
  until retention drops them.
- **`networth-history-items.json`** — a sidecar holding only the **newest**
  per-item breakdown per user: every name in the stash, the priced ones with
  their chaos value and the **unpriced ones at zero** (that is what lets the
  next diff tell an item that left the stash from one that only lost its price
  — `docs/bugs.md` B2). *Every* unpriced name goes in, not just the 100 the
  Net-Worth page lists: the names that cap drops are the thinly traded items the
  distinction is for. The file grows by those names and nothing else — a name and
  two numbers each. It exists so a container restart does not tear a hole
  into the series: without it the first point after every deploy would carry no
  delta. Its path is derived from the NDJSON path and cannot be set separately.

Neither file contains an account name or a POESESSID — only the local routing
name from `POE_USERS` and item names.

**How often a point is recorded.** The auto-refresher offers one after every
synced tab (i.e. roughly every 30s per user), but the history module throttles
that down to **at most one point per minute per user**. There is nothing to
schedule and no separate job.

An offer is also **refused while the refresher has not been past every live
stash tab yet** — on a fresh install, or after a tab list that came back short
pruned the stored tabs. Until then the snapshot is a sum over a subset of the
account, and recording it would put a dip into the curve that nothing
afterwards can tell apart from a real one. Expect no points for up to one full
round (tab count × `POE_NETWORTH_SYNC_INTERVAL_MS`) after the store is empty.

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

  **An arrival bar covers the item that has no previous price.** An item
  entering the stash cannot be compared with anything, so the jump bar cannot
  see it. One worth at least `POE_NETWORTH_GUARD_ARRIVAL_MIN_DIVINE` (default
  **20** divine) *and* at least `POE_NETWORTH_GUARD_SHARE` (25 %) of the previous
  total is recorded at no value until it has stood for the hold window (the same
  6 hours), and then enters the series as stock arriving, visible in the event
  list rather than as an unexplained jump. The divine floor keeps a fresh
  account, where every drop is a large share of a small total, out of its reach;
  `0` switches the arrival bar off.
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

**This is the normal way to update**, and it stays that way. Prefix the rebuild
with `BUILD_COMMIT=$(git rev-parse --short HEAD)` if you want the running
container to be able to name its own commit in the admin area (see "Which
version is running") — without it the tool honestly says `unknown`, nothing
else changes.

At league start, do the extra steps in the runbook below **before** this
rebuild.

Whether there is anything to update to is what the release notice says (a line on
every page, details in the Releases block of the settings page; see "Release
check" under "Which version is running"). It only tells; it never installs.

> **There is also a button**, for when you are not at a shell: the admin area's
> update block asks a small script on the host to run exactly the two commands
> above. It has to be installed first and does nothing without it — see
> ["Update button"](#update-button-deployhost-updatesh). It is a convenience,
> not a replacement: it cannot do league-start steps, it cannot review a diff,
> and it only ever runs the fixed commands.

> **The daemon does not come along.** This updates the *backend* — the checkout
> the compose file lives in, on the server. Every player's hotkey daemon runs
> from its own clone on its own machine and keeps running the code it was
> started with. A backend feature that needs a newer daemon (the
> language-dependent `item_prefixes` filter is the current example) stays
> inert until each client does its own:
>
> ```bash
> cd <their clone> && git pull && systemctl --user restart poe-price-daemon
> ```
>
> Worth checking rather than assuming: a clone that has been running happily
> for months can be hundreds of commits behind without anything looking wrong,
> because the daemon only ever talks to the backend over HTTP. `git log -1` in
> their clone, and `daemon/selftest.sh` for the rest.

### Client self-test (`daemon/selftest.sh`)

When a player says "it does nothing", have them run this on **their** machine
before you go looking at the server:

```bash
./daemon/selftest.sh
```

It is also what `install.sh` runs, up front (`--tools`) and again at the end.
It reads the player's `config.toml` and reports on tools, clipboard access, the
`input` group, `ydotoold`, the daemon service, the backend — and then does a
real test parse with a sample item in the language **this** backend says it
reads for that user (`GET /users` → `langs`).

Why it matters for you: it separates causes that reach you looking identical.

| Self-test says | Where the fix is |
|---|---|
| `[FAIL] filter … DROPPED` | The client. `item_prefixes` doesn't match the client language, so the item never leaves their machine — you will find **nothing** in the server log, because nothing was sent. |
| `[FAIL] GET /health … cannot reach` | Network/URL: nothing answered at `backend_url`. |
| `[FAIL] GET /health … answered 301 (redirect)` | The `http://` → 301 → `https://` trap, which otherwise loses every item silently: the POST does not follow redirects. Write `https://` in `backend_url`. |
| `[FAIL] POST /item … does not know the user` | You. Their `user` is not in `POE_USERS`, and the server answers 400 (it deliberately does not route the item to the first user). |
| `[FAIL] POST /item … no data set (503)` | You. That user has a language in `POE_USER_LANGS` whose data set is missing from the snapshot; the server refuses rather than parsing it with the English parser. See the data auto-update section above and the admin gap view. |
| `[ ok ] POST /item` | The path works end to end. If they still see nothing, look at the browser side (user cookie, WS connection), not at the daemon. |

Two things to know before you ask for a run:

- The test parse **posts one real item** — one card in that player's browser,
  one trade search. `--offline` skips it and still checks everything local,
  including the filter half.
- It never installs, edits or enables anything. Suggested fixes are printed as
  text.

The sample items live in `daemon/selftest-items/<lang>.txt`, one per language,
and are picked by the language the backend reports plus the configured prefix —
so **a new language is one more file there**, not a change to the script. If a
sample ever goes stale against new game data, the self-test reports a 400 parse
failure and says so in the hint; check with a real item before concluding the
installation is broken.

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

**Between the end of the old league and the start of the new one**
`POE_LEAGUE` stays on the old league. The background pricers keep running for a
league that no longer has a market: the Faustus refresher then finds no market
row for it and logs `[faustus-refresher] no market matched league=<x> in the
digest window — keeping the previous store` on every pass, and poe.ninja may stop
answering for it. Two ways through the gap: switch `POE_LEAGUE` to `Standard`
(then the store reset of step 4 happens once, when you move to the new league), or
accept those errors until the start. Do **not** enter the new league before it
exists: a name nothing answers for is the same failure with a typo's face. As an
example of the dates to plan with: GGG announced the end of 3.29 (Allflame) for
2026-11-09 13:00 PST in the forum thread "Path of Exile 1 3.30 Expansion Timeline"
(<https://www.pathofexile.com/forum/view-thread/4010618>, 2026-10-12) and the start
of 3.30 for 2026-11-13 PST in "Play Path of Exile: Covens of Umbra on November 13 PST"
(<https://www.pathofexile.com/forum/view-thread/4012420>, 2026-11-01).

Do this once, shortly after the league goes live:

1. **Point the tool at the new league.** Take the id from GGG's league list,
   not from the name in the announcement: open
   `https://www.pathofexile.com/api/leagues?type=main&realm=pc` and use the
   `id` field (the vendored renderer reads the same list, `renderer/src/web/background/Leagues.ts`), or
   copy it from the league selector on the trade site. The id is usually one short
   word ("Settlers" for "Settlers of Kalguur", "Allflame" for "Curse of the
   Allflame"); the hardcore variant is `Hardcore <Name>`. In your (gitignored)
   `docker-compose.override.yml` (full `services:`-nesting — the bare
   `environment:` block alone is not a valid compose file):
   ```yaml
   services:
     poe-price-tool:
       environment:
         - POE_LEAGUE=<LeagueId>
   ```
   A value with several words is written in quotes in the list form
   (`- "POE_LEAGUE=Hardcore <LeagueId>"`). `POE_LEAGUE` is the default league
   users see in the browser (each can still switch locally) and the league the
   Faustus and corpse pricing are pinned to (see "Single-league coupling" above).

   **If the admin area has saved a `POE_LEAGUE` of its own**, the compose change
   does nothing: the entry in `/config/overrides.json` wins over the
   environment. The admin area's settings view names the origin of every value in
   its `source` column (`override`, `env` or `default`); change the value there,
   or remove the override with its reset, and the compose value applies.

2. **Regenerate the RePoE-derived base-names map** — new leagues bring new
   currency types the checked-in map doesn't know about yet:
   ```bash
   node backend/v2/base-names-gen.mjs
   ```
   This fetches current RePoE data over the network and rewrites
   `backend/v2/networth/base-names.json` (the Faustus metadata-id→name bridge)
   — see
   [docs/pricing-logic.md](pricing-logic.md#metadata-id--name-bridge-repoe)
   for what it feeds. After writing the file it checks the result against the
   public Faustus feed (`web.poecdn.com/api/currency-exchange/…`, the last 8
   completed hours) and prints either `Faustus coverage: all N priced ids resolve
   to a name` or a `Faustus coverage GAP` list of the ids the exchange prices and
   the map cannot name. Read that line before committing: a gap is an item
   priced by the exchange that stays unpriced here. Review and commit the file.

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

4. **If you moved `POE_LEAGUE`, reset the Net-Worth store** (correctness,
   not cosmetic). `config/networth-store.json` persists a per-tab snapshot of
   whatever league it last scanned and is **not** cleared on a league switch —
   so after changing `POE_LEAGUE` the Net Worth page keeps showing the
   **previous** league's snapshot, and on a fresh league (empty stash) there is
   nothing to overwrite it, so the stale numbers linger indefinitely. The order
   matters, because a running container writes its stores again straight away:
   stop it, delete the file, make the change of step 1, start it:
   ```bash
   docker compose stop
   rm -f config/networth-store.json     # as the owner of config/ (UID 1000), or with sudo
   # ... edit docker-compose.override.yml (step 1) ...
   docker compose up -d                 # add --build only after a git pull (step 5)
   ```
   **Only if you actually moved `POE_LEAGUE`.** If you keep
   `POE_LEAGUE=Standard` (Net Worth tracks your permanent Standard wealth),
   leave the Standard store intact and skip this step.

   What does **not** need deleting: the Faustus store (it is league-guarded and a
   run that finds no market for the configured league keeps the old file, which
   ages out through `POE_FAUSTUS_TTL_MS`) and `corpse-store.json` (it empties
   itself when the first price of the new league is stored, and the valuator
   ignores a store of another league meanwhile; only a file written before the
   store recorded a league keeps its entries, and that one is worth deleting).

   What **cannot** be reset by this step: the Net-Worth history.
   `networth-history.ndjson` and `networth-history-items.json` record no league,
   so the History page shows the change of league as a jump in the chart. Whoever
   wants a clean start deletes both files as well, in the same stopped window as
   above; that is a decision for the operator, and the old curve goes with them.

5. **Rebuild and deploy** — commit the regenerated/updated files from steps 2–3,
   then run the normal [update procedure](#update-procedure) above
   (`git pull && docker compose up -d --build`); the search indices rebuild
   automatically from the refreshed data.

6. **Check, after the first hour or two.**
   - The **Chaos:Divine tile** must say `live · poe.ninja`, not `fallback`.
     poe.ninja often knows a new league only after some hours, and a failed
     attempt is cached negatively for 15 minutes (`NINJA_MIN_MS` in
     `backend/v2/ninja.mjs`), so give it time. While it says `fallback`, set
     `POE_CD_RATIO` in the admin area to a realistic starting value (it applies
     after a restart, which the admin area offers).
   - The log must **not** contain `[faustus-refresher] no market matched
     league=`. If it does, the league id is misspelled or the exchange has no
     market for it yet. A currency card showing the source Currency Exchange
     is the positive confirmation.
   - The league dropdown is filled from poe.ninja (`/poe1/api/economy/leagues`,
     served as `GET /leagues`), not from GGG. Once, after the start, compare
     `GET /leagues` with the list from step 1.
