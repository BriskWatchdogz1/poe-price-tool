# Contributing

How this repository is laid out and what to keep in mind when changing it. It
started as the working notes an AI assistant was given (see Credits in the
README) — the content is the same either way: where things live, how to run it
locally, and the rules that keep it honest.

## Where things live

- **`README.md`** — user-facing: what the tool does, how to install and run it.
- **`docs/admin.md`** — operator-facing: architecture, deployment, environment
  variables, the `/config` volume and Net-Worth internals.
- **`backend/v2/`** — the current backend (ES modules, Node 20). Older files
  directly under `backend/` are a dead v1 and gitignored.
- **`renderer/`** — vendored Awakened PoE Trade renderer (MIT, kept verbatim
  where possible). It carries no LICENSE of its own; the repository root
  `LICENSE` covers it with dual attribution.
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
- `networth/` — Net-Worth tracker: `scan.mjs`/`stash-client.mjs` (stash
  read), `valuator.mjs`/`aggregate.mjs` (pricing + snapshot), `faustus*.mjs`
  (GGG Currency Exchange), `corpse-*.mjs` (Trade-API corpse pricing),
  `store.mjs` (persistence), `config.mjs` (credentials).
- `log-timestamps.mjs` / `trade-audit.mjs` — observability of the shared trade
  budget: a central timestamp prefix on every console line, plus per-consumer
  rate-limit bookkeeping (one line at the 80% threshold, one on a 429). Both
  are pure observation — they must never add a request or change pacing.
- `ninja.mjs` — poe.ninja fetchers, shared by the price check and the
  net-worth valuation (one cache, keyed by league).
- `shims/`, `engine.mts`, `engine.bundle.mjs` — the headless APT engine glue
  (Node adaptations only; no APT source is changed — see `renderer/`).
- `engine-cli.mjs` — dev-only debug CLI against the built bundle:
  `node backend/v2/engine-cli.mjs <item.txt> [--league <name>] [--parse-only]`.
  Nothing imports it and the runtime image does not ship it. Use `--parse-only`
  for offline work — the default path hits the live trade API.
- `frontend/` — the static UI plus
  [`PROTOCOL.md`](backend/v2/frontend/PROTOCOL.md), the WS `/events` message
  contract. Read it before touching anything that sends or receives a WS
  message — every message type, its fields, and its routing (per-room vs.
  global) are specified there, not just implied by the code.

## Architecture principle: the three-tier trade queue

Everything that talks to the PoE Trade API shares **one** queue through APT's
RateLimiter, at one of three priorities: `priority` (manual search) > `auto`
(item paste) > `background` (corpse pricer).
Background work must never starve or block a manual search — a new
background consumer always goes in at `background` tier.

## Local dev

```bash
POE_CORPSE_DISABLED=1 POE_FAUSTUS_DISABLED=1 POE_DATA_REFRESH_DISABLED=1 \
POE_NETWORTH_AUTOSYNC=0 \
POE_NETWORTH_STORE=./config/networth-store.json \
node backend/v2/server.mjs
```

**Local runs and tests must never crawl or price live.** Disable every
background job (`*_DISABLED=1`) and point stores at a local, gitignored
`./config/` rather than the real `/config` volume. `backend/v2/mock-server.mjs`
is a frontend dev server that stubs the external APIs; the test suite does not use it.

## Tests

Run the whole suite with `npm test`, or target one file with `node --test <path>`:

```bash
npm test
node --test backend/v2/server.test.mjs
node --test backend/v2/ninja.test.mjs
```

The suite is tracked in the repository. It needs the build artifacts first —
`node backend/v2/build.mjs` and the index generator — otherwise the engine
bundle is missing and most of it fails. The runtime Docker image deletes the
test files again (see the `find` in the Dockerfile).

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
