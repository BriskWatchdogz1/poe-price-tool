# Contributing

How this repository is laid out and what to keep in mind when changing it. It
started as the working notes an AI assistant was given (see Credits in the
README) — the content is the same either way: where things live, how to run it
locally, and the rules that keep it honest.

Bugs are reported as GitHub issues:
<https://github.com/BriskWatchdogz1/poe-price-tool/issues>, through one of the
two forms there (bug report, feature request); security problems as described
in [`SECURITY.md`](SECURITY.md), not in a public issue. Pull requests: see
"Pull requests" below.

## Where things live

- **`README.md`** — user-facing: what the tool does, how to install and run it.
- **`CHANGELOG.md`** — what each release changed for players and operators,
  with its upgrade notes. A change they notice gets a line under
  `[Unreleased]` in the same commit or series; see "Releasing" below.
- **`docs/admin.md`** — operator reference: architecture, environment
  variables, the `/config` volume, routes, data sources, rate limits and
  Net-Worth internals.
- **`docs/runbooks.md`** — operator procedures, one step sequence each:
  install and deploy, update, league start, reverse proxy, backup and restore,
  the host update script, troubleshooting (including the client self-test).
- **`backend/v2/`** — the current backend (ES modules; Node 22 or newer, the
  image runs Node 24). Older files
  directly under `backend/` are a dead v1 and gitignored.
- **`.github/`** — the CI workflow (`workflows/ci.yml`, see "Tests") and the
  issue forms (`ISSUE_TEMPLATE/`).
- **`deploy/`** — things that run on the DOCKER HOST rather than in the image.
  Today that is `host-update.sh`, the update button's host half. The directory
  is in `.dockerignore` on purpose: nothing in it belongs inside the container.
- **`daemon/`** — the hotkey daemon that runs on the game PC:
  `poe-price-daemon.py` (clipboard polling, chat macros, start-up check),
  `poe-price-post.sh` (filter, dedupe, POST; its exit status and its one
  stderr line are a contract the daemon reads, written down in its header),
  `ppt_diag.py` (the throttled journal and the classification of failures, in
  a module of its own so `backend/v2/daemon-diag.test.mjs` can import it
  without python-evdev), `ppt_link.py` (the daemon's HTTP channels through
  curl children that never block the loop: the long-poll for results and the
  heartbeat, one state machine each; tests `daemon-link.test.mjs`),
  `ppt_results.py` (what the player sees after a price check: one state per
  posted item, the card lines and the notification text; there is always an
  answer, a timeout included; also the buyer-whisper cards and the farm and
  game session cards; tests `daemon-results.test.mjs`, the session cards in
  `daemon-session-key.test.mjs`), `ppt_session.py` (the session key: a press
  is one `POST /daemon/session` toggle, the answer and the feed's `session`
  event of one state become one card; tests `daemon-session-key.test.mjs`),
  `ppt_whisper.py` (buyer whispers: follows
  `Client.txt` like `tail -F` by polling, finds incoming trade whispers, keeps
  the buyer's name in memory only and sends the text with a pseudonym to
  `POST /daemon/whisper`; tests `daemon-whisper.test.mjs`),
  `ppt_presence.py` (is the game running: its window by `poe_window_class`
  through `xdotool search` in the curl pool; 'unknown' whenever it cannot
  tell, 'absent' only for a class once seen on this display; the heartbeat
  carries it; tests `daemon-presence-probe.test.mjs`),
  `ppt_display.py` (where a card goes: notify-send as a child, one
  notification per slot that replaces itself, one slot per whisper; the OverlayLink to the overlay
  process with its states and restarts; the FocusProbe, xdotool and xprop
  through the curl pool; and the Display, which uses the overlay while it works
  and the game has focus, else the notification; tests
  `daemon-display.test.mjs`), `ppt_overlay_model.py` (where the overlay's cards
  go and when they leave, as plain functions over numbers; tests
  `daemon-overlay-model.test.mjs`), `ppt_stash_grid.py` (the stash cell
  frame: where a whisper's stash cell lies on the screen, after
  SlimTrade's grid, and the highlight key's cycle through the whispers; tests
  `daemon-stash-grid.test.mjs`), `ppt_overlay.py` (the optional overlay
  process: PySide6 on Qt's xcb platform, click-through windows that never take
  focus, JSON lines on stdin and stdout; tests `daemon-overlay-qt.test.mjs` on
  the offscreen platform, skipped without PySide6), `selftest.sh` (tests
  `daemon-selftest.test.mjs`), `install.sh` (which copies
  `config.example.toml`, the daemon's config template, to the player's config
  when there is none). The `ppt_*.py` modules other than `ppt_overlay.py` are standard library only (the daemon itself also needs python-evdev);
  `ppt_overlay.py` is the only file that imports Qt, and the daemon runs
  without it. The tests for all of it live under `backend/v2/`
  (`daemon-*.test.mjs`), because `npm test` only runs that directory.
- **`renderer/`** — vendored Awakened PoE Trade renderer (MIT, kept verbatim
  where possible). It carries no LICENSE of its own; the repository root
  `LICENSE` covers it (its first copyright line is the upstream author's).
- **`docs/pricing-logic.md`** — describes **shipped** behaviour for how the
  Net-Worth tracker prices your stash. If it and the code ever disagree, the
  code wins — treat the mismatch as a doc bug.
- **`docs/pricing-measurements.md`** — the dated measurements behind the
  thresholds of `docs/pricing-logic.md`: records of the day they were taken,
  not measured again.

## Module map (`backend/v2/`)

- `server.mjs` — the whole backend: HTTP + WS server, routing, the shared
  trade queue, and the wiring for every subsystem below.
- `base-names-gen.mjs` — CLI that regenerates `networth/base-names.json` from
  RePoE (network required). Its `buildBaseNames`/`URLS` are also imported by
  `data-refresher.mjs`, which keeps that map fresh on its own; see the
  League-start runbook in `docs/runbooks.md`.
- `networth/` — Net-Worth tracker:
  - Stash read: `refresher.mjs` (the continuous background sync: one step per
    interval, the stalest tab of one user; which user gets a tick follows the
    game — `presenceOf` from `daemon-presence.mjs`: playing/idle/unknown,
    unknown = plain round-robin — still one step per tick; its `roundSince()` says how
    many live tabs were read since a moment, which is what sets a session's
    baseline and makes its balance final, `prioritize()` reads every tab of a
    user once from a session's start or end within that user's own ticks, and
    `etaFor()` estimates how long that takes), `scan.mjs` (the per-tab scan core,
    all I/O injected so tests make no GGG request), `stash-client.mjs` (the
    legacy POESESSID stash API: tab list, one tab's items), `stash-pacer.mjs`
    (the wait between two stash requests, derived from the limits GGG
    publishes), `folder-walk.mjs` (one folder tab as plain data that can be put
    down between requests), `map-sections.mjs` (which map-stash section a
    sub-tab belongs to, read from GGG's field), `subtab-shape.mjs` (logs the
    shape of folder-tab children once per tab and process; observation only).
  - Valuation: `normalize.mjs` (stash item JSON → priceable descriptor),
    `kinds.mjs` (the single source of truth for item categories: classifier
    rules, valuation routes, the fungible fallback chain), `valuator.mjs`
    (descriptor → chaos value through the cached fetchers, and whether that
    value is a guess: `uncertain`, see `docs/pricing-logic.md`), `aggregate.mjs`
    (valued entries → snapshot), `listing-audit.mjs` (price notes from the
    stash against the market value: "Listed below market", by the whisper
    verdict's rule; also the stored stack size at a whisper's tab and cell),
    `price-guard.mjs` (the implausible-price brake for the
    recorded history).
  - Prices: `faustus.mjs` (GGG Currency Exchange client: hourly digests →
    name → chaos), `faustus-store.mjs`, `faustus-refresher.mjs`,
    `faustus-age.mjs` (how old a Faustus price may be before it stops counting
    as current), `base-names.mjs` (loader of the metadata-id → name map),
    `trade-client.mjs` (minimal official Trade search + fetch for corpse
    pricing, on an injected transport), `corpse-pricer.mjs`,
    `corpse-store.mjs` (the corpse prices, name → chaos with a long TTL).
  - Persistence: `store.mjs` (the per-tab store), `history.mjs` (the append-only
    time series behind the History page), `history-items.mjs` (item breakdown
    of the last recorded point, so a delta survives a restart),
    `guard-state.mjs` (the price guard's memory across restarts, next to the
    series), `sessions.mjs`
    (farm and game sessions: the states from `starting` to `final`, the
    baseline breakdown, the balance at baseline prices, the summaries in
    `/config/networth-sessions.json`; its pure `balance()`/`hourly()` are where
    the arithmetic lives), `session-control.mjs` (what starts and ends a
    session — the History page's buttons, `POST /daemon/session`, the game's
    presence with its gap — and what each start and end does: the refresher's
    round, the daemon feed's `session` event, the `networth-session`
    message), `config.mjs`
    (read path of the per-user credentials) and `credentials.mjs` (write path;
    the POESESSID is never returned, logged or echoed).
- `data-refresher.mjs` — the data auto-update: the APT data, `base-names.json`
  and the localized data set, checked daily with conditional requests,
  validated before adoption, persisted under `/config/data-refresh`.
  `check-failure.mjs` turns a failed check into the reason and class the status
  line shows. `apt-data-update.mjs` (`npm run update-apt-data`) is the manual
  CLI for the vendored APT data; `apt-index.mjs` regenerates the `*.index.bin`
  search indices at runtime after an adopted snapshot.
- `build.mjs` — bundles the APT modules and the engine into
  `engine.bundle.mjs` with esbuild.
- Trade-queue helpers — `rate-limit-headers.mjs` (GGG's rate-limit headers
  parsed, nothing else), `rate-limit-signal.mjs` (the one place that decides
  whether an error is a trade rate limit or ban and how long to back off),
  `trade-stats.mjs` (resolves mod texts APT could not map against GGG's public
  stat catalogue).
- Reference rail — `reference-history.mjs` (the tool's own price series behind
  the rail's sparklines), `sell-side.mjs` (which currency pays a seller more,
  from the separated Faustus chaos and divine markets).
- `patch-version.mjs` — what counts as a PoE patch version; one expression read
  by `lang-data-gen.mjs` and `config-overrides.mjs`.
- Test infrastructure — `run-tests.mjs` (the runner behind `npm test`; its
  `MIN_TESTS` floor is tested in `run-tests-min.test.mjs`, the exit 1 on a
  file that does not exit in `run-tests-leak.test.mjs`),
  `test-net-guard.mjs` (the preloaded guard that blocks and records outbound
  requests), `test-quiet-env.mjs` (the switch list, see "Local dev").
- Market fixtures — `fixtures/<date>/` (a tracked cut of one recording of
  Faustus digests and poe.ninja overviews; where it came from and why each
  entry is kept is in its `README.md`) and `fixtures/cut.mjs` (makes that cut
  from the gitignored raw recording in `fixtures/raw/<date>/`). Read by
  `networth/recorded-thresholds.test.mjs`, which measures the thresholds of
  `docs/pricing-logic.md` against it. Neither is part of the image.
- `log-timestamps.mjs` / `trade-audit.mjs` — observability of the shared trade
  budget: a central timestamp prefix on every console line, plus per-consumer
  rate-limit bookkeeping (one line at the 80% threshold, one on a 429). Both
  are pure observation — they must never add a request or change pacing.
- `ninja.mjs` — poe.ninja fetchers, shared by the price check and the
  net-worth valuation (one cache, keyed by league). Reports every outcome
  through `configureNinja({ onOutcome })`; a failure waits 15 minutes like an
  answer and keeps the last good answer, served up to `POE_NINJA_MAX_AGE_MS`.
- Price-source status — `source-health.mjs` (per source: last success, last
  failure, reason and class; the data of the `source-status` message. It logs
  nothing and judges nothing — the page ages the facts, like `data-status`) and
  `fail-log.mjs` (one log line when a key starts failing, one when it recovers,
  at most one per interval in between).
- The hotkey daemon's own channel (`GET /daemon/events`, `POST
  /daemon/heartbeat`, `POST /daemon/session`; `frontend/PROTOCOL.md`) —
  `daemon-feed.mjs` (the result feed per room: only cards a daemon posted
  itself, filled from `broadcast()`, plus whisper verdicts and session
  changes, read by the long-poll; it never queues anything), `daemon-presence.mjs` (what
  the daemons report about themselves: version, features, game as
  `playing`/`idle`/`unknown`, where `unknown` means the plain round-robin, as
  for a user without such a daemon; `syncPresenceOf` and `makeHoldAfterGame` are the answer the
  net-worth refresher gets, with a stopped game held at the playing pace until
  its round is complete), `daemon-user.mjs` (the caller rule of every `/daemon/*` route:
  `X-PPT-Daemon` and `X-User` required) and `http-body.mjs` (bounded request
  bodies for those routes).
- Buyer whispers (`POST /daemon/whisper`; `frontend/PROTOCOL.md`) —
  `whisper.mjs` (the trade site's whisper templates as data, read back into
  fields, in six languages; pure, every template tested against its sample) and
  `whisper-price.mjs` (your listed price against the market through the
  net-worth valuator, never the trade API; the route's logic without HTTP, the
  per-user rate gate and the session's whisper list, memory only). The buyer's
  name never reaches the server; nothing of a whisper's text is logged. The
  daemon's side is `daemon/ppt_whisper.py`.
- `shims/`, `engine.mts`, `engine.bundle.mjs` — the headless APT engine glue
  (Node adaptations: the shims replace browser-only modules at build time —
  `config.mjs` for APT's `@/web/Config`, `ipc-host.mjs` for
  `@/web/background/IPC` (server-side the backend fetches directly), `vue.mjs`
  plain stand-ins for Vue's reactivity primitives; the few changes to
  `renderer/` itself are listed in README → Credits).
- **Runtime configuration** — `config-overrides.mjs` (the allow-list of keys the
  admin area may set, their validation, and the `/config/overrides.json` file
  that is folded into `process.env`) plus `config-boot.mjs`, which is
  `server.mjs`'s **first** import and exists only to make that happen before any
  module body reads a `POE_…` variable. The override deliberately beats the real
  environment, and a set of overrides that breaks *repeated* starts is
  quarantined — the boot marker counts consecutive failed starts instead of
  switching on the first one, because what it can observe is "the last start did
  not listen", never "the overrides were to blame". Both are argued in the
  module header and documented in `docs/admin.md`. `json-error.mjs` beside it is
  one rule in one function: a message about a file never quotes the file, so a
  mistyped `/config` file cannot answer with its own content. `store-file.mjs`
  is how a `/config` store with a `schema_version` reads its file: what it
  cannot use (broken JSON, a wrong shape, an older version with no migration)
  is moved to `<name>.broken-<timestamp>` with one warning, and a file from a
  NEWER release is left alone while the store runs in memory — a store never
  writes over a file it could not read. `user-lang-store.mjs`,
  `networth/history-items.mjs` and the `state.json` load in
  `data-refresher.mjs` use its `moveAside()` and stop writing when their file
  cannot be read or moved. The NUMBERS among
  the settings go through `env-number.mjs` (one reader: default, range, and
  whether an explicit `0` is legal for that variable) and `numeric-settings.mjs`
  (the table server.mjs reads through). `Number(process.env.X) || DEFAULT` is
  not to come back: it cannot express zero, so an operator switching a
  background pricer off with `POE_CORPSE_BUDGET_PER_HOUR=0` got 25 Trade-API
  queries an hour and no warning. A new numeric setting is a row in that table,
  not a new read site — and the allow-list **reads** that table (`numeric()`)
  rather than restating a default or a range, so an entry there says only who
  may see the setting, what it is for, whether it is `live` or `restart`, and
  whether it moves outbound request volume (`traffic`). An entry may narrow a
  range for the browser path; it may never widen one. `secret-keys.mjs` holds
  the one "could this name be a credential" expression, on its own so that
  `config-overrides.mjs → numeric-settings.mjs → host-update.mjs` is not an
  import cycle. Importing `config-overrides.mjs` must keep reading **nothing**
  out of the environment, or `config-boot.mjs` cannot do its job; a test
  measures that with a recording proxy rather than trusting the comment.
- **Second client language** — `user-langs.mjs` (the `POE_USER_LANGS` map, and
  the startup validation that refuses a typo instead of parsing an item in the
  wrong language), `user-lang-store.mjs` (the language a USER picked for
  himself, persisted in `/config` — it beats `POE_USER_LANGS`, a stored
  entry the server cannot honour is dropped rather than fatal, and one whose
  parser is not live is parked in the file until it is),
  `engine-instances.mjs` (the bundle loaded once per language;
  every non-primary instance is a frozen `{ parseItem }` and cannot reach the
  network — read its header before touching it), `mod-text-pairs.mjs` (the
  localized→English bridge that keeps the unknown-mod repair path working),
  `lang-skew.mjs` (how far a localized set trails the English one).
- **Language generator** — `lang-data-gen.mjs` (CLI `npm run gen-lang-data --
  --lang de`, also called by `data-refresher.mjs` as a post step of its APT
  check), with `lang-derive.mjs` (derivation + validation),
  `lang-statdesc.mjs` (GGG's `*_stat_descriptions.txt` parser) and
  `lang-pseudo-matchers.json` (APT's own pseudo stat matchers, which have no
  counterpart in the game data, kept by hand per language). Its output is
  gitignored on purpose: it is derived from GGG's game data and every
  installation generates its own. `generatorVersion()` hashes the generator's
  files (`GENERATOR_INPUTS`) and the exporter package versions at runtime; the
  refresher compares that hash with `build-info.json`, so any change to those
  files rebuilds every installation's localized set once. A new input file
  belongs in `GENERATOR_INPUTS` and in the Dockerfile.
  `lang-data-gen-version.test.mjs` checks the Dockerfile, and it fails when a
  generator module imports or reads a local file that is neither an input nor
  one of the exceptions it names with their reason (`NOT_INPUTS`): moving part
  of the derivation into a new module forces that decision.
- `corpus/` — the acceptance corpus: real item texts out of the game client,
  one directory per item, `de.txt`/`en.txt`/`covers.txt`. `corpus-parity.test.mjs`
  iterates over whatever is in there, so growing it never touches code. See
  [`corpus/README.md`](backend/v2/corpus/README.md) — and do not confuse it with
  `daemon/selftest-items/`, which is the installer's diagnostic sample.
- `gap-log.mjs` / `admin-auth.mjs` — what the tool could not parse or resolve,
  aggregated in memory, behind the settings page's password-gated admin area.
- `host-update.mjs` — the container half of the update button: it writes a
  request into the `/config` volume and reads back the heartbeat and result that
  `deploy/host-update.sh` leaves there. **Read its header before touching it.**
  The one property the whole design rests on is that nothing from the request
  file ever reaches the command the host runs. The second is that the shared
  directory is writable by the container while the script out there runs as
  root, so that script trusts no name in it to be what it looks like and keeps
  its lock and its staging outside it. The third is that the host's output is
  foreign text and leaves this module bounded and filtered — filtered by names
  and shapes, which has a known gap and is written down as a gap everywhere it
  is mentioned, never as a guarantee. None of the three is a convention you can
  weaken without making the feature pointless.
- `version.mjs` / `release-check.mjs` — the release notice. `version.mjs` reads
  the installed version from the root `package.json` once at import (`null`
  when it cannot, shown as "unknown", never guessed) and exports `AGENT_BASE`,
  `poe-price-tool/<version>`, the one source of the tool's own User-Agent: every
  module that names the tool appends its purpose to it, the release check
  included. A new request in the tool's name uses it rather than a string of
  its own.
  `release-check.mjs` asks `api.github.com` for the latest release at most once
  in 24 hours, keeps its state in `/config/release-check.json`, and derives
  newer / current / unknown on every read. It has the shape of
  `data-refresher.mjs` on purpose: fetch, clock and timers are injected, so the
  tests never touch the network. It is not part of the trade queue — GitHub is
  not GGG. Wire format in `PROTOCOL.md` (`release-status`); read the module
  header for what each failure class means here.
- `dockerfile-closure.test.mjs` — guards the runtime image: files under
  `backend/v2/` get individual `COPY` lines, so a new module that isn't listed
  crashes the container on boot while the whole suite stays green.
- `engine-cli.mjs` — dev-only debug CLI against the built bundle:
  `node backend/v2/engine-cli.mjs <item.txt> [--league <name>] [--parse-only]`.
  Nothing imports it and the runtime image does not ship it. Use `--parse-only`
  for offline work — the default path hits the live trade API.
- `frontend/` — the static UI plus
  [`PROTOCOL.md`](backend/v2/frontend/PROTOCOL.md), the WS `/events` message
  contract. Read it before touching anything that sends or receives a WS
  message — every message type, its fields, and its routing (per-room vs.
  global) are specified there, not just implied by the code.
  `settings.js` builds its configuration form entirely from `GET /config-view`
  and the language selector entirely from `GET /user-lang`: no list of keys,
  types, ranges or languages is kept in the page, because a second copy of the
  allow-list would drift away from `config-overrides.mjs` the first time
  somebody adds a key. The files:
  - `index.html` + `app.js` — the Price Check page (cards, mod picker, rate-limit
    banner, buyer whispers); `networth.html` + `networth.js` — the Net Worth page;
    `history.html` + `history.js` — the History page (chart, events, farm and
    game sessions); `settings.html` +
    `settings.js` — the settings page and admin area.
  - `shell.js` — the frame all pages share: brand, league selector, C:D tile and
    the keyed status line (keys `blind`, `sync`, `sources`, `session`, `daemon`,
    `data`, `release`, in that order; `Shell.sourceView` is the one derivation of a price source's
    state, also used by the settings page's Sources block, which takes the
    word per row from `Shell.sourceState`). `i18n.js` — the
    string tables, a classic script loaded first on every page.
  - Pure helpers, testable in node: `networth-sync.js` (the sync status line,
    its session-round sentence and the auto-sync counter of the Net Worth page), `tabs.js` (stash-tab identity),
    `history-chart.js` (chart geometry and number formatting), `highlight.js`
    (the stash-highlight search string), `whispers.js` (the rows of the buyer
    whisper list, every field escaped).

## Architecture principle: the three-tier trade queue

Everything that talks to the PoE Trade API shares **one** queue through APT's
RateLimiter, at one of three priorities: `priority` (manual search) > `auto`
(item paste) > `background` (corpse pricer).
Background work must never starve or block a manual search — a new
background consumer always goes in at `background` tier.

## Local dev

```bash
POE_CORPSE_DISABLED=1 POE_FAUSTUS_DISABLED=1 POE_DATA_REFRESH_DISABLED=1 \
POE_REFERENCE_DISABLED=1 POE_REFERENCE_ON_CONNECT_DISABLED=1 \
POE_LEAGUE_LIST_DISABLED=1 POE_RELEASE_CHECK_DISABLED=1 \
POE_RELEASE_CHECK_STATE=./config/release-check.json \
POE_NETWORTH_AUTOSYNC=0 \
POE_NETWORTH_STORE=./config/networth-store.json \
node backend/v2/server.mjs
```

The switches are `QUIET_ENV` from `backend/v2/test-quiet-env.mjs` (minus the
price check, see below); the two `…_STORE`/`…_STATE` paths redirect the files a
local run would otherwise write to `/config`. Without the switches a page that
is merely opened asks poe.ninja for the reference rail and the league list, and
after 10 minutes the server asks GitHub for the latest release.

**Local runs and tests must never crawl or price live.** Disable every
background job (`*_DISABLED=1`) and point stores at a local, gitignored
`./config/` rather than the real `/config` volume. The command above leaves the
foreground price check on, because that is usually the thing being worked on;
add `POE_PRICE_CHECK_DISABLED=1` when it is not, and a pasted item then produces
a card and no request. Tests always set it. `backend/v2/mock-server.mjs`
is a standalone frontend dev server: it serves `frontend/` and plays a simulated
price-check session over `/events`. It shares no state with `server.mjs`; the test
suite does not use it.

**That rule has an instrument behind it, and the instrument is the runner.**
`run-tests.mjs` preloads `test-net-guard.mjs` into every process it starts —
and, through `NODE_OPTIONS`, into every process those start, so a test that
spawns the real server as a child is watched inside the server too. The guard
lets loopback through (the suite boots real servers and talks to them) and
**blocks** everything else, recording what was attempted. A file that reached
out is marked `NET`, listed under *REACHED OUTSIDE THE MACHINE*, and turns the
run red.

It sits in the runner because a test cannot watch the other files:
`server-no-network.test.mjs` replaces `globalThis.fetch` before importing the
server — inside **its own process**, and the runner starts one process per file.
On 2026-08-18 a suite run sent **≈55 requests to poe.ninja** from eleven files
while that test was green (nothing went to GGG; `docs/bugs.md` B25).

**A test file that boots `server.mjs` does not write the switch list out.** It
imports it:

```js
import { QUIET_ENV } from './test-quiet-env.mjs'   // spawn: env: { ...process.env, ...QUIET_ENV, … }
import { quietEnv } from './test-quiet-env.mjs'    // in-process: quietEnv() BEFORE await import('./server.mjs')
```

Hand-written lists have missed one, more than once: the switches cover five
different kinds of outbound traffic, and knowing four of them is not enough:

| Switch | Covers |
|---|---|
| `POE_FAUSTUS_DISABLED`, `POE_CORPSE_DISABLED`, `POE_DATA_REFRESH_DISABLED`, `POE_RELEASE_CHECK_DISABLED`, `POE_NETWORTH_AUTOSYNC=0` | the background **schedules** (the release check looks at `api.github.com` once a day, first about 10 minutes after boot) |
| `POE_REFERENCE_DISABLED` | the one-time reference warm-up **at boot** |
| `POE_REFERENCE_ON_CONNECT_DISABLED` | what a **WebSocket connect** sets off (`warmLeague`) — every browser test opens one (`docs/bugs.md` B12) |
| `POE_PRICE_CHECK_DISABLED` | the **foreground** price check |
| `POE_LEAGUE_LIST_DISABLED` | `GET /leagues`, a **request** the browser makes on every page load. No schedule switch touches it |

Spread or call it **first**, so a file that deliberately needs one of them back
can say so — and then say so out loud. `exchange-price.test.mjs` prices and uses
the Faustus store on purpose, and `whisper-stack-sync.test.mjs` prices a buyer
whisper from a Faustus store seeded in a temp directory; both carry a
`delete process.env.…` with the reason next to it, instead of being quiet by
omission.

`suite-network-silence.test.mjs` holds all of this to its word: it fails when a
file that boots the server has an incomplete list, when the runner stops
preloading the guard, and — the negative control — when the guard itself would
not block a real request or the runner would not recognise its report.

## Tests

Run the whole suite with `npm test`. To run one file, hand the runner a filter:
it runs only the files whose path contains it.

```bash
npm test
npm test -- backend/v2/server.test.mjs
npm test -- networth
```

Go through the runner for a single file too, not through a bare
`node --test <path>`. Only the runner preloads the network guard
(`test-net-guard.mjs`), so a bare `node --test` runs the file unguarded, and a
test that misses a mock sends its request for real.
If you need Node's own runner directly (a debugger, a `--test-name-pattern`),
preload the guard yourself:

```bash
node --import=./backend/v2/test-net-guard.mjs --test backend/v2/ninja.test.mjs
```

`suite-network-silence.test.mjs` fails when a `node --test` command in this
file's code blocks lacks that `--import`.

The suite is tracked in the repository. It needs the build artifacts first —
`node backend/v2/build.mjs` and the index generator
(`cd renderer && node src/assets/make-index-files.mjs`, after
`npm --prefix renderer ci`) — otherwise the engine bundle is missing and most
of it fails. The runtime Docker image deletes the
test files again (see the `find` in the Dockerfile).

`npm test` runs every test file in its own process
(`backend/v2/run-tests.mjs`), with the TAP reporter named explicitly — the
counts are TAP `ok` lines, and Node 24 would otherwise pick the spec reporter
and the runner would count nothing (`docs/bugs.md` B26) — and prints a
per-file table plus one total line of this shape:

```
<n> files   <n> pass   0 fail   0 skip
```

The two counts on the left grow with the suite and are deliberately not written
out here — a number in a document ages at the next commit, and a stale one is
worse than none. **The columns that carry a claim are the two zeros**, plus the
absence of any `LEAK` or `CRASH` line; run it and read those.

Two consecutive runs give the same counts, per file and in total (the
diagnostic lines under a file carry log timestamps, so the output is not byte
for byte the same). **That is the point**: "all green" and "seventeen files
never reported" must not print identically. The runner therefore does not use
`--test-force-exit`, which ends the process while output is still flushing
(measured on 2026-08-10, when the flag was dropped: three runs of the same tree
reported 916, 923 and 933 "passing", each with zero failures, and
`faustus.test.mjs`, then 43 tests, reported 43 without the flag and 40 with
it), and
it does not count `^ok` lines of a directory run (that count moves too, and
includes one `ok` per *file*). The backstop is a per-file timeout
(`TEST_TIMEOUT_MS`, default 180 s), and three outcomes are never conflated: a
failed assertion, a **crash** (non-zero exit with no failed assertion — a load
error must not read as a pass), and a **leak** (the file's tests ran but the
process would not exit; its count is a lower bound). Each of the three ends the
run with exit 1, a leak included.

No file leaks today, and a LEAK line is a bug report: a server-booting file
whose items are auto-priced against the live Trade API breaks the "never price
live" rule above, and APT's rate limiter then holds a timer open for every
window it learned from GGG's headers, long after the HTTP server closed.
`POE_PRICE_CHECK_DISABLED=1` (see `docs/admin.md`) prevents it: the card is
still created, nothing goes out. `server.test.mjs` and `server-langs.test.mjs`
took 360 s (two per-file timeouts) with live pricing and take under three
seconds with the switch.

There is no single-process script: `node --test backend/v2` runs without the
runner and therefore without the network guard, and on Node 24 does not start
at all, since a directory argument is not expanded
(`ERR_UNSUPPORTED_DIR_IMPORT`). Snapshot of 2026-08-11 on Node 20, outside
today's `engines` range (`node >=22`): it terminated (three runs, 23-24 s, 1009
passing each time, the total the runner reported then). One process for the
whole suite also cannot say *which* file failed to exit, keep a load error in
one file from taking the rest with it, or stop a `process.env` one test sets
from applying to every file after it. To iterate on part of the suite, hand `npm test` a filter (above).
`suite-network-silence.test.mjs` fails when a `package.json` script starts
`node --test` without the guard.

Most of the second-language tests build their own fixtures, but some assert
against a real generated `renderer/public/data/de/`: `lang-dataset`,
`mod-text-pairs`, `unknown-mod-repair` and `corpus-parity`, and the browser
tests `frontend/i18n-dynamic` and `frontend/settings-runtime`. That directory is
gitignored, so on a fresh clone they **skip** rather than fail. The runner
counts a skip as a skip, not as a pass, so a fresh clone reports fewer passes
and a non-zero skip column — the `0 skip` above assumes a generated `data/de` (and PySide6, see below).
Run `npm run gen-lang-data -- --lang de` once if you want them to actually run.
Nothing in the suite ever calls the generator itself.

**The browser tests need Google Chrome.** The files under
`backend/v2/frontend/` that drive a page start headless Chrome over its
debugging port: the binary named by `CHROME_BIN`, or `google-chrome-stable` on
the `PATH` when it is unset. Without it they fail; they do not skip. Many of
them also stay up until the per-file timeout (`TEST_TIMEOUT_MS`), because the
server they started is left running, and the runner then lists them under "did
not exit" as well; not all of them do, and not always the same ones.
Point `CHROME_BIN` at another Chrome or Chromium binary if yours has another
name.

The daemon's optional tools are not needed; `python3`, `bash` and `curl` are.
The overlay tests that need PySide6 skip without it
(`daemon-overlay-qt.test.mjs`, one test in `daemon-diag.test.mjs`), and the
daemon tests run the daemon and `selftest.sh` against stand-in tools on a
`PATH` of their own and a stand-in for python-evdev, so `xsel`, `xdotool`,
`xprop`, `notify-send`, `wl-paste`, `ydotool` and python-evdev need not be
installed.

**`MIN_TESTS=<n> npm test`** turns the run red (exit 1) when fewer than `n`
tests passed, even with no failure; skips do not count. A value that is not a
whole number stops the run before the first file. It is for a job that reads
only the exit code: a filter that matched fewer files than meant, or a group of
tests skipped by the environment, also ends with `0 fail`.

**CI.** `.github/workflows/ci.yml` runs on GitHub for every push and pull
request: the steps above on Ubuntu with Node 22 and 24 (`npm ci`, the renderer
dependencies, the bundle and the indices, then `npm test` with `MIN_TESTS` and
`CHROME_BIN` set), `python3 -m py_compile` for `daemon/*.py`, `bash -n` for
`daemon/*.sh` and `sh -n` for the two `/bin/sh` scripts, and a `docker build`
that is not pushed. The floor in the workflow is a round number below what a
fresh clone passes on a machine without PySide6 and without the generated
German data; raise it when the suite has grown well past it.

Defects, fixed and open, live in [`docs/bugs.md`](docs/bugs.md),
with where each one came from and whether it was deliberately deferred. Read it
before reporting something — and add to it rather than to a commit message when
you find something you are not fixing today.

## Pull requests

Pull requests are welcome for bug fixes and small additions. For anything
larger, open an issue first, so the change can be discussed before the work is
done. A pull request is taken when:

- it is about one thing;
- `npm test` is green, and the change comes with a test of its own;
- the documentation it affects is changed with it (see "Conventions");
- it changes nothing under `renderer/`, unless it brings that tree in line with
  the Awakened PoE Trade upstream;
- it sends no more requests to the Trade API or the Stash API than before. A
  trade ban can cover the whole IP address, and the tool keeps that load low on
  purpose (README, "What it does in the background"; the queue rules under
  "Architecture principle" above);
- its fixtures hold no secrets and no player data: no POESESSID, no account or
  character names, no `Client.txt` lines with names;
- it is written in English (code, comments, documentation, commit messages).

There is no promise of a reply within any time. There is no contributor
license agreement: contributions are under the MIT license of the repository
([`LICENSE`](LICENSE)).

## Releasing

The running release check compares the installed version with the tag of the
latest GitHub release, so a release has to be cut in a way it can read:

1. In `CHANGELOG.md`, move everything under `## [Unreleased]` into a new
   section `## [X.Y.Z] - YYYY-MM-DD` with the release date (its *Upgrade
   notes* included), leave an empty `## [Unreleased]` above it, and update the
   compare links at the end of the file.
2. Bump `"version"` in `package.json` (semver `x.y.z`).
3. Publish the commit to the public repository the way the project's publishing
   rules describe, and push `main` there.
4. Tag that release commit `vX.Y.Z` and push the tag by name (never
   `--tags`), then create the GitHub release from the tag so that
   `releases/latest` answers.
5. A release whose tag is not of the form `x.y.z` or `vx.y.z` is not a version
   to the check: it is reported as an answer that could not be read, not
   ignored.

## Conventions

- ES modules throughout the v2 backend (`.mjs`, `import`/`export`).
- The frontend is static — plain HTML/JS served directly by the backend, no
  bundler, no framework build step.
- No secrets in the repo, ever. Credentials (POESESSID, account names) live
  only in the gitignored `/config` volume at runtime, never hardcoded or
  committed. Scan any new script or doc for hardcoded secrets before committing.
- Keep documentation changes in the right place: user-facing → `README.md`,
  operator reference → `docs/admin.md`, operator procedures →
  `docs/runbooks.md`, valuation behaviour → `docs/pricing-logic.md` (its dated
  measurements → `docs/pricing-measurements.md`), the WebSocket contract →
  `backend/v2/frontend/PROTOCOL.md`. Avoid duplicating
  the same fact in two of them, and check a claim against the code before
  writing it down — stale documentation is worse than none, because someone
  will act on it.
