# Contributing

How this repository is laid out and what to keep in mind when changing it. It
started as the working notes an AI assistant was given (see Credits in the
README) — the content is the same either way: where things live, how to run it
locally, and the rules that keep it honest.

Bugs are reported as GitHub issues:
<https://github.com/BriskWatchdogz1/poe-price-tool/issues> (security problems
as described in [`SECURITY.md`](SECURITY.md), not in a public issue).

## Where things live

- **`README.md`** — user-facing: what the tool does, how to install and run it.
- **`docs/admin.md`** — operator-facing: architecture, deployment, environment
  variables, the `/config` volume and Net-Worth internals.
- **`backend/v2/`** — the current backend (ES modules; Node 22 or newer, the
  image runs Node 24). Older files
  directly under `backend/` are a dead v1 and gitignored.
- **`deploy/`** — things that run on the DOCKER HOST rather than in the image.
  Today that is `host-update.sh`, the update button's host half. The directory
  is in `.dockerignore` on purpose: nothing in it belongs inside the container.
- **`renderer/`** — vendored Awakened PoE Trade renderer (MIT, kept verbatim
  where possible). It carries no LICENSE of its own; the repository root
  `LICENSE` covers it (its first copyright line is the upstream author's).
- **`docs/pricing-logic.md`** — describes **shipped** behaviour for how the
  Net-Worth tracker prices your stash. If it and the code ever disagree, the
  code wins — treat the mismatch as a doc bug, not as license to trust stale
  prose over what actually runs.

## Module map (`backend/v2/`)

- `server.mjs` — the whole backend: HTTP + WS server, routing, the shared
  trade queue, and the wiring for every subsystem below.
- `base-names-gen.mjs` — CLI that regenerates `networth/base-names.json` from
  RePoE (network required). Its `buildBaseNames`/`URLS` are also imported by
  `data-refresher.mjs`, which keeps that map fresh on its own; see the
  League-start runbook in `docs/admin.md`.
- `networth/` — Net-Worth tracker:
  - Stash read: `refresher.mjs` (the continuous background sync: one step per
    interval, the stalest tab of one user), `scan.mjs` (the per-tab scan core,
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
    (descriptor → chaos value through the cached fetchers), `aggregate.mjs`
    (valued entries → snapshot), `price-guard.mjs` (the implausible-price brake
    for the recorded history).
  - Prices: `faustus.mjs` (GGG Currency Exchange client: hourly digests →
    name → chaos), `faustus-store.mjs`, `faustus-refresher.mjs`,
    `faustus-age.mjs` (how old a Faustus price may be before it stops counting
    as current), `base-names.mjs` (loader of the metadata-id → name map),
    `trade-client.mjs` (minimal official Trade search + fetch for corpse
    pricing, on an injected transport), `corpse-pricer.mjs`,
    `corpse-store.mjs` (the corpse prices, name → chaos with a long TTL).
  - Persistence: `store.mjs` (the per-tab store), `history.mjs` (the append-only
    time series behind the History page), `history-items.mjs` (item breakdown
    of the last recorded point, so a delta survives a restart), `config.mjs`
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
- Test infrastructure — `run-tests.mjs` (the runner behind `npm test`),
  `test-net-guard.mjs` (the preloaded guard that blocks and records outbound
  requests), `test-quiet-env.mjs` (the switch list, see "Local dev").
- `log-timestamps.mjs` / `trade-audit.mjs` — observability of the shared trade
  budget: a central timestamp prefix on every console line, plus per-consumer
  rate-limit bookkeeping (one line at the 80% threshold, one on a 429). Both
  are pure observation — they must never add a request or change pacing.
- `ninja.mjs` — poe.ninja fetchers, shared by the price check and the
  net-worth valuation (one cache, keyed by league).
- `shims/`, `engine.mts`, `engine.bundle.mjs` — the headless APT engine glue
  (Node adaptations only; no APT source is changed — see `renderer/`).
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
  mistyped `/config` file cannot answer with its own content. The NUMBERS among
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
  himself, persisted in `/config` — it beats `POE_USER_LANGS`, and a stored
  entry the server cannot honour is dropped rather than fatal),
  `engine-instances.mjs` (the bundle loaded once per language;
  every non-primary instance is a frozen `{ parseItem }` and cannot reach the
  network — read its header before touching it), `mod-text-pairs.mjs` (the
  localized→English bridge that keeps the unknown-mod repair path working),
  `lang-skew.mjs` (how far a localized set trails the English one).
- **Language generator** — `lang-data-gen.mjs` (CLI `npm run gen-lang-data --
  --lang de`, also called by `data-refresher.mjs` as a post step of its APT
  check), with `lang-derive.mjs` (derivation + validation) and
  `lang-statdesc.mjs` (GGG's `*_stat_descriptions.txt` parser). Its output is
  gitignored on purpose: it is derived from GGG's game data and every
  installation generates its own.
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
  when it cannot, shown as "unknown", never guessed) and builds the User-Agent.
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
    banner); `networth.html` + `networth.js` — the Net Worth page;
    `history.html` + `history.js` — the History page; `settings.html` +
    `settings.js` — the settings page and admin area.
  - `shell.js` — the frame all pages share: brand, league selector, C:D tile and
    the keyed status line. `i18n.js` — the string tables, a classic script loaded
    first on every page.
  - Pure helpers, testable in node: `networth-sync.js` (the sync status line and
    the auto-sync counter of the Net Worth page), `tabs.js` (stash-tab identity),
    `history-chart.js` (chart geometry and number formatting), `highlight.js`
    (the stash-highlight search string).

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

It sits in the runner because the previous instrument could not work.
`server-no-network.test.mjs` replaces `globalThis.fetch` before importing the
server — inside **its own process**, and the runner starts one process per file.
It was measuring the single file that was already quiet and reporting on all of
them. Measured on 2026-08-18: a suite run sent **≈55 requests to poe.ninja**
from eleven files while that test was green (nothing went to GGG). See
`docs/bugs.md` B25.

**A test file that boots `server.mjs` does not write the switch list out.** It
imports it:

```js
import { QUIET_ENV } from './test-quiet-env.mjs'   // spawn: env: { ...process.env, ...QUIET_ENV, … }
import { quietEnv } from './test-quiet-env.mjs'    // in-process: quietEnv() BEFORE await import('./server.mjs')
```

Every file that wrote the list by hand left something out, twice. The switches
cover five different kinds of outbound traffic and knowing four of them is not
enough:

| Switch | Covers |
|---|---|
| `POE_FAUSTUS_DISABLED`, `POE_CORPSE_DISABLED`, `POE_DATA_REFRESH_DISABLED`, `POE_RELEASE_CHECK_DISABLED`, `POE_NETWORTH_AUTOSYNC=0` | the background **schedules** (the release check looks at `api.github.com` once a day, first about 10 minutes after boot) |
| `POE_REFERENCE_DISABLED` | the one-time reference warm-up **at boot** |
| `POE_REFERENCE_ON_CONNECT_DISABLED` | what a **WebSocket connect** sets off (`warmLeague`) — every browser test opens one, and this is the one that was missing everywhere (`docs/bugs.md` B12) |
| `POE_PRICE_CHECK_DISABLED` | the **foreground** price check |
| `POE_LEAGUE_LIST_DISABLED` | `GET /leagues`, a **request** the browser makes on every page load. No schedule switch touches it, which is why it outlived B12 |

Spread or call it **first**, so a file that deliberately needs one of them back
can say so — and then say so out loud. `exchange-price.test.mjs` prices and uses
the Faustus store on purpose, and now carries a `delete process.env.…` with the
reason next to it, instead of being quiet by omission.

`suite-network-silence.test.mjs` holds all of this to its word: it fails when a
file that boots the server has an incomplete list, when the runner stops
preloading the guard, and — the negative control — when the guard itself would
not block a real request or the runner would not recognise its report.

## Tests

Run the whole suite with `npm test`, or target one file with `node --test <path>`:

```bash
npm test
node --test backend/v2/server.test.mjs
node --test backend/v2/ninja.test.mjs
```

The suite is tracked in the repository. It needs the build artifacts first —
`node backend/v2/build.mjs` and the index generator
(`cd renderer && node src/assets/make-index-files.mjs`, after
`npm --prefix renderer ci`) — otherwise the engine bundle is missing and most
of it fails. The runtime Docker image deletes the
test files again (see the `find` in the Dockerfile).

`npm test` runs every test file in its own process
(`backend/v2/run-tests.mjs`) and prints a per-file table plus one total line of
this shape:

```
<n> files   <n> pass   0 fail   0 skip
```

The two counts on the left grow with the suite and are deliberately not written
out here — a number in a document ages at the next commit, and a stale one is
worse than none. **The columns that carry a claim are the two zeros**, plus the
absence of any `LEAK` or `CRASH` line; run it and read those.

Two consecutive runs produce byte-identical output. **That is the point**, and
it took a detour to get there. The package script used to be
`node --test --test-force-exit backend/v2`; that flag ends the process while
output is still flushing, so three consecutive runs of the same tree reported
916, 923 and 933 "passing", each with zero failures. Counting `^ok` lines does
not rescue it — that count moves too, and a directory run also emits one `ok`
per *file* on top of the real tests. The danger was never the wrong number: it
is that "all green" and "seventeen files never reported" print identically.

The flag existed because one shared process did not terminate. Per file that was
the exception, not the rule — `faustus.test.mjs` reports 43 of 43 without it
and 40 with it. So the runner drops the flag and uses a per-file timeout as the
backstop (`TEST_TIMEOUT_MS`, default 180 s), and distinguishes three outcomes
that must never be conflated: a failed assertion, a **crash** (non-zero exit
with no failed assertion — a load error must not read as a pass), and a
**leak** (the file's tests ran but the process would not exit; its count is a
lower bound).

No file leaks today, and the two that did are the worked example of why a LEAK
line is a bug report rather than a fact of life. `server.test.mjs` and
`server-langs.test.mjs` boot the real server, and every item they POST used to
be auto-priced against the live Trade API — which cost twice over: it broke the
"never price live" rule below, and APT's rate limiter then held a timer open for
the length of every window it had learned from GGG's headers, long after the
HTTP server was closed. The fix was the switch that had been missing all along,
`POE_PRICE_CHECK_DISABLED=1` (see `docs/admin.md`): the card is still created,
nothing goes out. The two files together took 360 s before — two per-file
timeouts — and take under three seconds now.

Those two were the whole of it: `node --test backend/v2` terminates again, and
`npm run test:fast` no longer carries `--test-force-exit`. Measured at the time,
three consecutive runs: 23 s each, the same pass count every time, and that
count equal to the one the runner reports. Its number is therefore quotable now
— what it still cannot do is say *which* file failed to exit, keep a load error
in one file from taking the rest with it, or stop a `process.env` one test sets
from applying to every file after it. That is what `npm test` is for; use
`test:fast` while iterating.

Most of the second-language tests build their own fixtures, but four of them
(`lang-dataset`, `mod-text-pairs`, `unknown-mod-repair`, `corpus-parity`) assert
against a real generated `renderer/public/data/de/`. That directory is
gitignored, so on a fresh clone they **skip** rather than fail. The runner
counts a skip as a skip, not as a pass, so a fresh clone reports fewer passes
and a non-zero skip column — the `0 skip` above assumes a generated `data/de`.
Run `npm run gen-lang-data -- --lang de` once if you want them to actually run.
Nothing in the suite ever calls the generator itself.

Defects, fixed and open, live in [`docs/bugs.md`](docs/bugs.md),
with where each one came from and whether it was deliberately deferred. Read it
before reporting something — and add to it rather than to a commit message when
you find something you are not fixing today.

## Releasing

The running release check compares the installed version with the tag of the
latest GitHub release, so a release has to be cut in a way it can read:

1. Bump `"version"` in `package.json` (semver `x.y.z`).
2. Publish the commit to the public repository the way the project's publishing
   rules describe, and push `main` there.
3. Tag that release commit `vX.Y.Z` and push the tag by name (never
   `--tags`), then create the GitHub release from the tag so that
   `releases/latest` answers.
4. A release whose tag is not of the form `x.y.z` or `vx.y.z` is not a version
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
  operator-facing → `docs/admin.md`, valuation behaviour → `docs/pricing-logic.md`,
  the WebSocket contract → `backend/v2/frontend/PROTOCOL.md`. Avoid duplicating
  the same fact in two of them, and check a claim against the code before
  writing it down — stale documentation is worse than none, because someone
  will act on it.
