# poe-price-tool v2 — backend as ONE container (deploy target: home server, LAN-only).
#
# Two stages:
#  - build:   installs the root deps (ws + the esbuild devDependency) and the
#             renderer deps (fnv1a, for the search indices),
#             builds the self-contained engine bundle and generates the search indices.
#  - runtime: slim node:24-slim, only what's needed at runtime. The path relation
#             backend/v2/ <-> renderer/public/data MUST be preserved because the
#             default data path in engine.mts is relative
#             (new URL('../../renderer/public/', import.meta.url) from backend/v2).

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:24 AS build
WORKDIR /app

# Copy only the manifests first (layer cache: deps only rebuild on manifest change).
COPY package.json package-lock.json ./
RUN npm ci

# Renderer deps: the bundle inputs live under renderer/src, and fnv1a builds the
# search indices. esbuild itself is a devDependency of the ROOT package.
# devDeps are needed -> do NOT install with --omit=dev.
COPY renderer/package.json renderer/package-lock.json ./renderer/
RUN npm --prefix renderer ci

# Sources for bundling + index generation.
COPY ipc/ ./ipc/
COPY renderer/src/ ./renderer/src/
COPY renderer/public/ ./renderer/public/
COPY backend/ ./backend/

# Build the engine bundle (esbuild is a devDependency of the ROOT package) -> engine.bundle.mjs.
RUN node backend/v2/build.mjs

# Generate search index files (*.index.bin) — these are gitignored, a fresh
# checkout doesn't have them, so generate them during the build. The script uses
# relative paths (./public/data/...), so it must be started from within renderer/.
RUN cd renderer && node src/assets/make-index-files.mjs

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8788

# Which commit this image was built from — the first question anybody asks
# before updating, and until now unanswerable from the running container.
#
# It is EMPTY unless the build is given one, and that is on purpose: docker has
# no idea what git thinks, the build context does not even contain .git (see
# .dockerignore), so the only honest source is whoever starts the build. The
# admin area prints "unknown" when it is empty rather than inventing a value.
#
#   docker compose up -d --build                              -> unknown
#   BUILD_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
#   deploy/host-update.sh                                     -> sets it itself
ARG BUILD_COMMIT=""
ENV POE_BUILD_COMMIT=$BUILD_COMMIT

# Only what's needed at runtime. The engine bundle is self-contained, so the
# server itself needs only `ws`; the three packages below it belong to the
# LANGUAGE GENERATOR (lang-data-gen.mjs resolves `pathofexile-dat/dat.js` at
# call time and spawns its CLI to export GGG's game data). They are dead weight
# on an English-only install and ~600 KB in total, which is cheaper than a
# German install failing every generation run.
# The backend/v2 <-> renderer/public/data path relation is preserved.
COPY --from=build --chown=node:node /app/node_modules/ws                ./node_modules/ws
COPY --from=build --chown=node:node /app/node_modules/pathofexile-dat        ./node_modules/pathofexile-dat
COPY --from=build --chown=node:node /app/node_modules/pathofexile-dat-schema ./node_modules/pathofexile-dat-schema
COPY --from=build --chown=node:node /app/node_modules/ooz-wasm              ./node_modules/ooz-wasm
COPY --from=build --chown=node:node /app/backend/v2/server.mjs          ./backend/v2/server.mjs
# The installed version shown in the browser and named in the tool's own
# User-Agent comes from package.json (read by version.mjs); without it the
# server says "unknown".
COPY --from=build --chown=node:node /app/package.json                     ./package.json
COPY --from=build --chown=node:node /app/backend/v2/version.mjs           ./backend/v2/version.mjs
# Once-a-day release check against GitHub (the module server.mjs imports).
COPY --from=build --chown=node:node /app/backend/v2/release-check.mjs     ./backend/v2/release-check.mjs
# Runtime configuration overrides from the /config volume. config-boot.mjs is
# server.mjs's FIRST import and must be in the image, or the container dies on
# boot before it has read a single setting.
COPY --from=build --chown=node:node /app/backend/v2/config-boot.mjs      ./backend/v2/config-boot.mjs
COPY --from=build --chown=node:node /app/backend/v2/config-overrides.mjs ./backend/v2/config-overrides.mjs
# The "could this name be a credential" expression. Its own module so that
# config-overrides.mjs -> numeric-settings.mjs -> host-update.mjs is not a cycle.
COPY --from=build --chown=node:node /app/backend/v2/secret-keys.mjs      ./backend/v2/secret-keys.mjs
# What counts as a patch version. Its own module for the same reason: the
# settings page validates POE_PATCH_VERSION with the expression the generator
# uses, without dragging the whole derivation into the boot path.
COPY --from=build --chown=node:node /app/backend/v2/patch-version.mjs    ./backend/v2/patch-version.mjs
# Why a background check failed, in a form the status line can act on (the class
# of the failure plus the filter its reason passes through).
COPY --from=build --chown=node:node /app/backend/v2/check-failure.mjs    ./backend/v2/check-failure.mjs
# The state of each price source (source-status message) and the per-key
# failure log behind poe.ninja's log lines: one at the start, one at recovery.
COPY --from=build --chown=node:node /app/backend/v2/source-health.mjs    ./backend/v2/source-health.mjs
COPY --from=build --chown=node:node /app/backend/v2/fail-log.mjs         ./backend/v2/fail-log.mjs
# The hotkey daemon's own channel (GET /daemon/events, POST /daemon/heartbeat):
# the feed of its cards, what the daemons report about themselves, the caller
# rule of those routes and their bounded request bodies.
COPY --from=build --chown=node:node /app/backend/v2/daemon-feed.mjs      ./backend/v2/daemon-feed.mjs
COPY --from=build --chown=node:node /app/backend/v2/daemon-presence.mjs  ./backend/v2/daemon-presence.mjs
COPY --from=build --chown=node:node /app/backend/v2/daemon-user.mjs      ./backend/v2/daemon-user.mjs
COPY --from=build --chown=node:node /app/backend/v2/http-body.mjs        ./backend/v2/http-body.mjs
# Buyer whispers (POST /daemon/whisper): the templates and the verdict.
COPY --from=build --chown=node:node /app/backend/v2/whisper.mjs          ./backend/v2/whisper.mjs
COPY --from=build --chown=node:node /app/backend/v2/whisper-price.mjs    ./backend/v2/whisper-price.mjs
# The numeric half of the configuration: the one reader for "a number out of the
# environment" plus the table of defaults, ranges and which settings accept a
# literal 0. server.mjs reads every number in its config block through them.
COPY --from=build --chown=node:node /app/backend/v2/env-number.mjs       ./backend/v2/env-number.mjs
COPY --from=build --chown=node:node /app/backend/v2/numeric-settings.mjs ./backend/v2/numeric-settings.mjs
# Summarises a JSON.parse failure WITHOUT quoting the file it failed on. Used by
# every reader of a JSON file in /config that reports a parse failure
# (config-overrides, user-lang-store, store-file).
COPY --from=build --chown=node:node /app/backend/v2/json-error.mjs       ./backend/v2/json-error.mjs
# How a /config store reads its file: an unusable one is moved aside, a newer one
# left alone (networth/*-store.mjs and user-lang-store.mjs import it).
COPY --from=build --chown=node:node /app/backend/v2/store-file.mjs       ./backend/v2/store-file.mjs
COPY --from=build --chown=node:node /app/backend/v2/rate-limit-signal.mjs ./backend/v2/rate-limit-signal.mjs
# GGG's X-Rate-Limit headers, parsed. Its own module so the trade audit can read
# them without importing the net-worth stack — see the note in the file.
COPY --from=build --chown=node:node /app/backend/v2/rate-limit-headers.mjs ./backend/v2/rate-limit-headers.mjs
COPY --from=build --chown=node:node /app/backend/v2/trade-stats.mjs      ./backend/v2/trade-stats.mjs
# Sell-side comparison for the reference rail (server.mjs imports ./sell-side.mjs).
COPY --from=build --chown=node:node /app/backend/v2/sell-side.mjs        ./backend/v2/sell-side.mjs
# Observability: timestamps on every log line + trade rate-limit bookkeeping
# (server.mjs imports both, data-refresher.mjs imports trade-audit.mjs).
COPY --from=build --chown=node:node /app/backend/v2/log-timestamps.mjs   ./backend/v2/log-timestamps.mjs
COPY --from=build --chown=node:node /app/backend/v2/trade-audit.mjs      ./backend/v2/trade-audit.mjs
COPY --from=build --chown=node:node /app/backend/v2/engine.bundle.mjs   ./backend/v2/engine.bundle.mjs
# Reference rail history (server.mjs imports ./reference-history.mjs). Files
# directly under backend/v2/ are copied ONE BY ONE here — a new top-level module
# that isn't listed makes the container crash on boot with ERR_MODULE_NOT_FOUND.
COPY --from=build --chown=node:node /app/backend/v2/reference-history.mjs ./backend/v2/reference-history.mjs
# Data auto-update (server.mjs imports ./data-refresher.mjs, which imports
# ./apt-data-update.mjs for the upstream constants/diff and ./apt-index.mjs to
# regenerate the *.index.bin files at runtime — no renderer/node_modules needed).
COPY --from=build --chown=node:node /app/backend/v2/data-refresher.mjs      ./backend/v2/data-refresher.mjs
COPY --from=build --chown=node:node /app/backend/v2/apt-data-update.mjs     ./backend/v2/apt-data-update.mjs
COPY --from=build --chown=node:node /app/backend/v2/apt-index.mjs           ./backend/v2/apt-index.mjs
COPY --from=build --chown=node:node /app/backend/v2/base-names-gen.mjs   ./backend/v2/base-names-gen.mjs
# Second language: the parse-only engine instance, the user->language map, the
# de->en bridge for the repair path, the gap log, the skew view and the admin
# gate (all imported by server.mjs), plus the generator the data-refresher runs
# as a post step of its APT check and its hand-maintained pseudo-matcher table.
# `dockerfile-closure.test.mjs` pins this list against what server.mjs actually
# imports, so the next module cannot go missing here unnoticed.
COPY --from=build --chown=node:node /app/backend/v2/engine-instances.mjs     ./backend/v2/engine-instances.mjs
COPY --from=build --chown=node:node /app/backend/v2/user-langs.mjs           ./backend/v2/user-langs.mjs
COPY --from=build --chown=node:node /app/backend/v2/user-lang-store.mjs      ./backend/v2/user-lang-store.mjs
COPY --from=build --chown=node:node /app/backend/v2/mod-text-pairs.mjs       ./backend/v2/mod-text-pairs.mjs
COPY --from=build --chown=node:node /app/backend/v2/gap-log.mjs              ./backend/v2/gap-log.mjs
COPY --from=build --chown=node:node /app/backend/v2/lang-skew.mjs            ./backend/v2/lang-skew.mjs
COPY --from=build --chown=node:node /app/backend/v2/admin-auth.mjs           ./backend/v2/admin-auth.mjs
# The update button's container half: it writes a request into the /config
# volume and reads back what the host script left there. The SCRIPT itself
# (deploy/host-update.sh) deliberately does NOT travel into the image — it runs
# on the host, where the checkout and the docker daemon are.
COPY --from=build --chown=node:node /app/backend/v2/host-update.mjs          ./backend/v2/host-update.mjs
COPY --from=build --chown=node:node /app/backend/v2/lang-data-gen.mjs        ./backend/v2/lang-data-gen.mjs
COPY --from=build --chown=node:node /app/backend/v2/lang-derive.mjs          ./backend/v2/lang-derive.mjs
COPY --from=build --chown=node:node /app/backend/v2/lang-statdesc.mjs        ./backend/v2/lang-statdesc.mjs
COPY --from=build --chown=node:node /app/backend/v2/lang-pseudo-matchers.json ./backend/v2/lang-pseudo-matchers.json
# Net-worth tracker: extracted ninja fetchers + networth modules (server.mjs
# imports ./ninja.mjs and ./networth/*). Without this, startup crashes.
COPY --from=build --chown=node:node /app/backend/v2/ninja.mjs            ./backend/v2/ninja.mjs
COPY --from=build --chown=node:node /app/backend/v2/networth             ./backend/v2/networth
COPY --from=build --chown=node:node /app/backend/v2/frontend            ./backend/v2/frontend
COPY --from=build --chown=node:node /app/renderer/public/data           ./renderer/public/data

# /config: mount point for per-user config + the stores (POESESSID, net-worth
# history, rate-limit state).
RUN mkdir -p /config && chown -R node:node /config

# Entrypoint runs as ROOT on purpose and drops to `node` itself: a bind-mounted
# ./config that docker had to create is root-owned, and the service could not
# write into it (see docker-entrypoint.sh). Pinning `user:` in compose still
# wins — the script then runs unprivileged and just execs the command.
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# The two COPYs above take WHOLE directories, so the tests that live beside the
# sources came along — 32 files, and the ones under frontend/ were served over
# HTTP (GET /highlight.test.mjs answered 200). Tests belong in the repository,
# not in the runtime image.
RUN find ./backend -name '*.test.mjs' -delete

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
EXPOSE 8788

# Healthcheck via the /health endpoint (node:24-slim has no curl -> global fetch).
# Generous start-period: the server warms the data DB + poe.ninja caches on boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/v2/server.mjs"]
