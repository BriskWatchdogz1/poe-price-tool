# poe-price-tool v2 — backend as ONE container (deploy target: home server, LAN-only).
#
# Two stages:
#  - build:   installs the root deps (ws + the esbuild devDependency) and the
#             renderer deps (fnv1a, for the search indices),
#             builds the self-contained engine bundle and generates the search indices.
#  - runtime: slim node:20-slim, only what's needed at runtime. The path relation
#             backend/v2/ <-> renderer/public/data MUST be preserved because the
#             default data path in engine.mts is relative
#             (new URL('../../renderer/public/', import.meta.url) from backend/v2).

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:20 AS build
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
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8788

# Only what's needed at runtime. Runtime needs ONLY `ws` (the bundle is self-contained)
# + the data. The backend/v2 <-> renderer/public/data path relation is preserved.
COPY --from=build --chown=node:node /app/node_modules/ws                ./node_modules/ws
COPY --from=build --chown=node:node /app/backend/v2/server.mjs          ./backend/v2/server.mjs
COPY --from=build --chown=node:node /app/backend/v2/rate-limit-signal.mjs ./backend/v2/rate-limit-signal.mjs
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

# Healthcheck via the /health endpoint (node:20-slim has no curl -> global fetch).
# Generous start-period: the server warms the data DB + poe.ninja caches on boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/v2/server.mjs"]
