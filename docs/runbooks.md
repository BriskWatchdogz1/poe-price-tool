# poe-price-tool — Runbooks

Step-by-step procedures for whoever runs the server: one sequence per task. What each setting, file and log line means is in the reference, **[docs/admin.md](admin.md)**; player-side setup is in the [README](../README.md). About the example paths and addresses: [admin.md → Deploy](admin.md#deploy).

## Install and deploy

The backend is **one** container on port 8788, LAN-only (operating model: [admin.md → Deploy](admin.md#deploy)).

1. Put per-deployment settings — at least your user list (`POE_USERS`) and display name (`POE_APP_NAME`) — into a gitignored `docker-compose.override.yml` next to the compose file ([admin.md → How a number in this table is read](admin.md#how-a-number-in-this-table-is-read) shows the file; every variable is in the [environment table](admin.md#environment-all-optional-defaults-in-the-server)).
2. Build and start:

   ```bash
   cd /path/to/poe-price-tool
   docker compose up -d --build
   ```

   To let the admin area name the commit it runs, prefix it with `BUILD_COMMIT=$(git rev-parse --short HEAD)` (see [Update procedure](#update-procedure)).
3. Verify:

   ```bash
   curl -s http://127.0.0.1:8788/health     # → ok
   curl -s http://127.0.0.1:8788/users      # → {"users":["player1","player2"],"appName":"Trade Console","langs":{"player1":"en","player2":"en"}}
   docker compose logs -f poe-price-tool
   ```

4. Check that `/config` is writable: `ls -la …/config` → the store files should appear shortly after start. If the log says `/config is owned by uid N and not writable`, see [/config is not writable](#config-is-not-writable).
5. Open `http://<server-address>:8788/` in your browser and pick the user once.
6. Change the admin password before the tool is reachable from anywhere but your home network ([Set the admin password](#set-the-admin-password)).
7. Optional: a reverse proxy ([Reverse proxy](#reverse-proxy-npm-optional)), Net-Worth credentials per player ([Net-Worth credentials](#net-worth-credentials)), the update script on the host ([Install the update script](#install-the-update-script)).

Changing a setting later: when it takes effect and what wins over compose is in [admin.md → How a number in this table is read](admin.md#how-a-number-in-this-table-is-read) and [Configuration from the admin area](admin.md#configuration-from-the-admin-area).

## Update procedure

```bash
git pull
docker compose up -d --build      # rebuilds bundle + indices, replaces the container
docker image prune -f             # optional: clean up old layers
```

1. **At league start**, do the extra steps of the [League-start runbook](#league-start-runbook) **before** this rebuild.
2. Run the commands above on the server. **This is the normal way to update.** Prefix the rebuild with `BUILD_COMMIT=$(git rev-parse --short HEAD)` if you want the running container to name its own commit in the admin area ([admin.md → Which version is running](admin.md#which-version-is-running)) — without it the tool honestly says `unknown`, nothing else changes.
3. **Update every player's daemon.** This updates the *backend* — the checkout the compose file lives in, on the server. Every player's hotkey daemon runs from its own clone on its own machine and keeps running the code it was started with. A backend feature that needs a newer daemon (the language-dependent `item_prefixes` filter is the current example) stays inert until each client does its own:

   ```bash
   cd <their clone> && git pull && systemctl --user restart poe-price-daemon
   ```

   Check rather than assume: a clone that has been running happily for months can be hundreds of commits behind without anything looking wrong, because the daemon only ever talks to the backend over HTTP. `git log -1` in their clone, and `daemon/selftest.sh` for the rest.

Whether there is anything to update to is what the release notice says (a line on every page, details in the Releases block of the settings page; [admin.md → Release check](admin.md#release-check)). It only tells; it never installs.

> **There is also a button**, for when you are not at a shell: the admin area's update block asks a small script on the host to run exactly the two commands above ([admin.md → Update button](admin.md#update-button-deployhost-updatesh); installing it: [Install the update script](#install-the-update-script)). It does nothing without the script, it cannot do league-start steps, it cannot review a diff, and it only ever runs the fixed commands.

## Reverse proxy (NPM, optional)

Proxy host in Nginx Proxy Manager:

1. Forward to the Docker host, port **8788**.
2. **Websockets Support = ON** (mandatory). The browser tab holds a WS connection on `/events`; without a WS proxy the UI won't connect.
3. The hotkey daemon's `GET /daemon/events` is held open for up to 30 s (`POE_DAEMON_POLL_MAX_HOLD_MS`). A read timeout above 30 s covers it, the usual 60 s included; a shorter one cuts every held poll.
4. Keep access LAN-only (no port forwarding, no public exposure).

## Net-Worth credentials

What the credentials file holds and its rules (full `Name#1234` account name, key = a `POE_USERS` name, re-read every round): [admin.md → Net-Worth-Tracker](admin.md#net-worth-tracker-networthhtml).

1. **Get the cookie:** log in on pathofexile.com → browser DevTools → Cookies → copy `POESESSID`.
2. **Enter it in the UI (preferred):** the player opens the settings page (`/settings.html`), section "Sync settings", and enters `accountName` + `POESESSID`. The refresher picks it up on its next tick. If `POE_SESSID` is set for that user in the environment, remove it first ([admin.md → Net-Worth-Tracker](admin.md#net-worth-tracker-networthhtml)).
3. **When the cookie expires** (the background sync logs a 401/403 and pauses that user until the cookie is renewed; every new login, also through a third-party site such as Filterblade, invalidates the previous one), enter the new value the same way, or refresh it in the file — no restart needed (credentials are re-read every sync round). If the refresher is mid-cooldown after an expired-cookie pause and you want it to retry the new cookie immediately, `docker restart poe-price-tool`.

**Fallbacks for when the app itself is down:**

- **File permissions** (the background sync fails with `EACCES: permission denied`; the rule is in [admin.md → Net-Worth-Tracker](admin.md#net-worth-tracker-networthhtml)). Created the file as `root`? Give it to UID 1000 with `chown` (stays tight, e.g. `600`):

  ```bash
  chown 1000:1000 config/networth-users.json
  ```

  If ownership doesn't take effect (a NAS share the entrypoint deliberately won't take over, see [admin.md → `/config` volume](admin.md#config-volume)), fall back to a more permissive `chmod` (e.g. `644`) instead. Verify that the background sync gets past the `EACCES` on its next tick (`docker compose logs -f poe-price-tool`).
- **Write the file over SSH** — **avoid** a plain `echo '{ ... poesessid ... }' | ssh …` one-liner: the whole cookie value ends up as a literal argument on the local command line and lands in your shell history (`history | grep poesessid` would surface it later). Write it to a local file first (never as a command-line argument), copy that over, then remove the local copy:

  ```bash
  cat > /tmp/networth-users.json <<'EOF'
  { "player1": { "accountName": "YourAccountName#1234", "poesessid": "<cookie>" } }
  EOF
  scp /tmp/networth-users.json <your-server>:/path/to/poe-price-tool/config/networth-users.json
  rm /tmp/networth-users.json
  ssh <your-server> "chmod 600 /path/to/poe-price-tool/config/networth-users.json"
  ```

  (The heredoc body only exists in the local temp file, not as ssh/scp argv — replace the placeholders with your real values before running it, and the cookie should never end up in the repo.)
- **Rotate the cookie without an editor** (e.g. on Unraid): reads the new POESESSID from a hidden prompt (never echoed, never in shell history) and writes it via the container's own node, so the secret never touches the command line. Replace `player1` with the target user; the refresher re-reads the file on its next cycle, so normally no restart is needed:

  ```bash
  ssh -t your-server 'read -rsp "New POESESSID for player1: " S; echo; docker exec -e S="$S" poe-price-tool node -e "const fs=require(\"fs\"),f=\"/config/networth-users.json\",d=JSON.parse(fs.readFileSync(f));d.player1.poesessid=process.env.S.trim();fs.writeFileSync(f,JSON.stringify(d,null,2));console.log(\"ok, poesessid length\",d.player1.poesessid.length)"'
  ```

  Never put the cookie on the command line, in an env you export interactively, or into a chat — it is a full account session token; type it only into the hidden `read` prompt.

## Set the admin password

```bash
printf 'your-own-password\n' > ./config/admin-password
```

It is read on every request, so it takes effect on the next click; the `[admin]` warning lines in the log and the notice in the admin area disappear with it. Background: [admin.md → The admin password](admin.md#the-admin-password).

## Backup and restore

Only a few files in `/config` hold something the tool cannot get back by itself:

| File | If it is lost |
|---|---|
| `admin-password` | recreated with the default `admin`: the admin area is open with the documented password until you set your own again |
| `networth-users.json` | every user has to enter account name and POESESSID again |
| `overrides.json` | every setting changed in the admin area falls back to compose/defaults |
| `user-langs.json` | every user falls back to `POE_USER_LANGS` / `POE_LANG_DEFAULT` |
| `networth-history.ndjson` | the History curve starts over; past points cannot be fetched again |
| `networth-sessions.json` | every farm and game session is forgotten: the running ones, the ones waiting for confirmation and the list of finished ones. The summaries cannot be rebuilt from the history, which keeps only 15 days and no per-session start |
| `networth-history-items.json` | only the next point has no item movers and skips the price guard ("Two protections against a wrong chart" in admin.md): the sidecar holds just the newest per-item breakdown. The brake's memory also loses the prices of the names in it, which `networth-history-guard.json` leaves to the sidecar. Back it up together with the series; a sidecar that does not match the series' newest point is not used |

Everything else is a cache the tool refills on its own: `networth-store.json` (the stash is read again, one tab per `POE_NETWORTH_SYNC_INTERVAL_MS`), `faustus-store.json` (the next refresh), `corpse-store.json` (queried again within `POE_CORPSE_BUDGET_PER_HOUR`), `networth-history-guard.json` (the brake then starts as after a first start: for up to `POE_NETWORTH_GUARD_HOLD_MS` only the arrival bar protects a name that had left the stash, and a running hold starts its window over), `reference-history.ndjson` (the sparklines refill over 7 days), `data-refresh/` (back to the image's data until the next check), `release-check.json` and the update files. One cache must not be deleted at the wrong moment: `rate-limit.json` while a ban cooldown is running, because it is what keeps a restart from probing GGG blindly.

1. **Back up** the files of the table, `networth-history.ndjson` and `networth-history-items.json` together. `networth-users.json` and `admin-password` are secrets in plaintext: keep the copy as private as the original (`chmod 600`).
2. **Restore** with the container stopped, because a running container writes its stores again straight away. UID 1000 must **own** the restored files, or at least be able to read and write them: read access is not enough, because `networth-history.ndjson` is appended to in place, and with a history file it cannot write every new point stays in memory only, without an error. The entrypoint only steps in when `/config` itself is not writable, not for single files in it.

   ```bash
   docker compose stop
   # copy the backed-up files back into config/, then:
   chown -R 1000:1000 config
   docker compose up -d
   ```

   On a share the entrypoint deliberately does not take over, the same command is the fix ([/config is not writable](#config-is-not-writable)).

What each file is: [admin.md → `/config` volume](admin.md#config-volume).

## Install the update script

The update button needs `deploy/host-update.sh` on the Docker host; design and security model: [admin.md → Update button](admin.md#update-button-deployhost-updatesh).

**Before you install it: three things that must be true.**

1. **The checkout must not be reachable from the container.** This is the one misconfiguration that turns the whole design around: whoever takes over the container can then rewrite `docker-compose.yml`, the `Dockerfile` and the source, and the next update builds and runs that, as root, on the host. **The direction of the nesting decides**; an overlap as such is not the danger, and the shipped compose file produces one of the harmless ones on every install:
   - **`REPO_DIR` inside `CONFIG_DIR`, or the two being the same** — dangerous. The container may write anywhere in the config directory, so the checkout would be its to edit. **The script refuses to run at all in this case.**
   - **`CONFIG_DIR` inside `REPO_DIR`** — **normal, and allowed.** This is what `git clone` plus `docker compose up -d --build` gives you, because the shipped compose file mounts `./config`, a subdirectory of the checkout. A bind mount goes one way: the container sees the directory that was mounted into it, not the tree it was taken from, and cannot reach `docker-compose.yml` one level up.
   - **The checkout bind-mounted into the container under some other path** — dangerous, and **the script cannot see this one** (it would have to know every compose file, override and template that took part in starting the container). That part is on you: the shipped `docker-compose.yml` mounts `./config` and nothing else; keep it that way.
2. **The build context must exclude what the container writes.** `docker compose up -d --build` sends the whole checkout to the Docker daemon minus what `.dockerignore` excludes, so a config directory inside the checkout is in that context — with every configured user's POESESSID (`networth-users.json`) and the admin password (`admin-password`) in it. The `Dockerfile` copies none of it, but sending secrets to the daemon on every build is exposure nobody asked for, and one later `COPY` that reaches wider than meant would put them in an image. The repository's `.dockerignore` therefore excludes `config` and `config.host-update` (the work directory of point 3, whose staging files hold the *unredacted* build output). **The script checks this before it builds** — it reads `.dockerignore` the way Docker does and refuses to start a build that would ship those directories. If you renamed either directory, add its name to `.dockerignore`; the refusal names the line to add.
3. **The script needs a directory of its own** for its lock and its staging files, which the container must not be able to reach. By default it is a sibling of the config directory — `…/config.host-update` — outside the volume (only `CONFIG_DIR` itself is mounted) and on the same filesystem, which makes publishing into the volume an atomic rename rather than a copy a reader can catch halfway. Adjust `WORK_DIR` only to somewhere with both properties — `/var/lib/…` is tidier and wrong, because it is usually a different filesystem. In the standard arrangement it lands **inside the checkout**, next to `config/`, which is why the repository ignores it twice: `.gitignore` keeps it out of `git status`, `.dockerignore` out of the build context.

**Installing it.** The script is POSIX `sh`, and short enough to read before you install it — do that, because you are about to run it as root on a schedule. Most of its length is the argument for its shape; the code itself is around a hundred lines.

1. Copy it onto the Docker host and `chmod +x` it — **a copy outside the checkout, not the file in `deploy/`**. The script's job is to `git pull` that checkout, and a pull can replace the script file while the shell is still reading it: `sh` reads a script incrementally, by byte offset, and a file swapped mid-run resumes at the old offset in new content, which does not fail cleanly. A copy also keeps your two edited constants out of the way of the next pull.
2. Edit the two constants at the top:

   ```sh
   REPO_DIR="/mnt/user/appdata/poe-price-tool"           # the checkout with docker-compose.yml
   CONFIG_DIR="/mnt/user/appdata/poe-price-tool/config"  # the HOST side of the /config volume
   ```

   Those example paths are from an Unraid box; use your own. They show the arrangement the README gives you — the checkout, and its own `config/` subdirectory, because that is what the compose file mounts; no need to rebuild your deployment into two sibling directories. `CONFIG_DIR` must be the same directory the compose file mounts as `/config` (and the same one `POE_UPDATE_DIR` names inside the container, if you changed it). The checkout must not sit inside it, and `.dockerignore` must exclude it — see above.
3. Run it every 5 minutes, as a user that may use `docker` and write in the checkout — usually root. Any of these:
   - **Unraid, "User Scripts" plugin** — add a script, paste the file in, set the schedule to *Custom* with `*/5 * * * *`.
   - **plain cron** — `crontab -e`:
     ```
     */5 * * * * /path/to/host-update.sh >/dev/null 2>&1
     ```
   - **systemd timer** — a `poe-price-tool-update.service` of `Type=oneshot` calling the script, plus a `.timer` with `OnBootSec=5min` and `OnUnitActiveSec=5min`. **One difference from the other two, visible in the admin area:** cron and User Scripts start every tick as its own process, so the ticks that arrive during a long build still refresh the heartbeat. systemd does not start a second run of a `Type=oneshot` service while the first is still in the build, so nothing refreshes the heartbeat until it finishes, and a build longer than the tool's window (20 minutes by default) makes the admin area say "no updater is set up" in the middle of the update it was asked for. It corrects itself on the next run. If your builds get anywhere near that, either raise `POE_UPDATE_HEARTBEAT_MAX_AGE_MS` past your worst one or use cron.
4. Open the admin area. Within five minutes the update block stops saying "no update script is set up" and the button becomes usable. Nothing else is needed inside the container: `POE_UPDATE_DIR` defaults to `/config`, which is where the volume already is.

## League-start runbook

A new challenge league changes currency, notables, and sometimes base types — several pieces of checked-in/vendored data need a refresh, or pricing and item recognition quietly degrade for the new league's items.

> **The running container handles steps 2–3 by itself** through the background data auto-update ([admin.md → Data auto-update](admin.md#data-auto-update-background)): it picks up refreshed upstream data within a day (or minutes after a restart) without a rebuild. Run the manual commands below when you want the **checked-in** copies in the repo refreshed too (so the next image build starts current), or as an emergency hatch — they are not required to keep the deployment working. Steps 1 and 4 (league env + store wipe) remain manual by nature.

**Between the end of the old league and the start of the new one** `POE_LEAGUE` stays on the old league. The background pricers keep running for a league that no longer has a market: the Faustus refresher then finds no market row for it and logs `[faustus-refresher] no market matched league=<x> in the digest window — keeping the previous store` on every pass, and poe.ninja may stop answering for it. Two ways through the gap: switch `POE_LEAGUE` to `Standard` (then the store reset of step 4 happens once, when you move to the new league), or accept those errors until the start. Do **not** enter the new league before it exists: a name nothing answers for is the same failure with a typo's face. As a dated example of what to plan with (the switch to 3.30, as of 2026-11-03; for a later switch, look up GGG's current announcements): GGG announced the end of 3.29 (Allflame) for 2026-11-09 13:00 PST in the forum thread "Path of Exile 1 3.30 Expansion Timeline" (<https://www.pathofexile.com/forum/view-thread/4010618>, 2026-10-12) and the start of 3.30 for 2026-11-13 PST in "Play Path of Exile: Covens of Umbra on November 13 PST" (<https://www.pathofexile.com/forum/view-thread/4012420>, 2026-11-01).

Do this once, shortly after the league goes live:

1. **Point the tool at the new league.** Take the id from GGG's league list, not from the name in the announcement: open `https://www.pathofexile.com/api/leagues?type=main&realm=pc` and use the `id` field (the vendored renderer reads the same list, `renderer/src/web/background/Leagues.ts`), or copy it from the league selector on the trade site. The id is usually one short word ("Settlers" for "Settlers of Kalguur", "Allflame" for "Curse of the Allflame"); the hardcore variant is `Hardcore <Name>`. In your (gitignored) `docker-compose.override.yml` (full `services:`-nesting — the bare `environment:` block alone is not a valid compose file):
   ```yaml
   services:
     poe-price-tool:
       environment:
         - POE_LEAGUE=<LeagueId>
   ```
   A value with several words is written in quotes in the list form (`- "POE_LEAGUE=Hardcore <LeagueId>"`). `POE_LEAGUE` is the default league users see in the browser (each can still switch locally) and the league the Faustus and corpse pricing are pinned to ([admin.md → Single-league coupling](admin.md#single-league-coupling-multi-user-pitfall)).

   **If the admin area has saved a `POE_LEAGUE` of its own**, the compose change does nothing: the entry in `/config/overrides.json` wins over the environment. The admin area's settings view names the origin of every value in its `source` column (`override`, `env` or `default`); change the value there, or remove the override with its reset, and the compose value applies.

2. **Regenerate the RePoE-derived base-names map** — new leagues bring new currency types the checked-in map doesn't know about yet:
   ```bash
   node backend/v2/base-names-gen.mjs
   ```
   This fetches current RePoE data over the network and rewrites `backend/v2/networth/base-names.json` (the Faustus metadata-id→name bridge) — see [docs/pricing-logic.md](pricing-logic.md#metadata-id--name-bridge-repoe) for what it feeds. After writing the file it checks the result against the public Faustus feed (`web.poecdn.com/api/currency-exchange/…`, the last 8 completed hours) and prints either `Faustus coverage: all N priced ids resolve to a name` or a `Faustus coverage GAP` list of the ids the exchange prices and the map cannot name. Read that line before committing: a gap is an item priced by the exchange that stays unpriced here. Review and commit the file.

3. **Refresh the vendored APT item/stat data** — one command:
   ```bash
   npm run update-apt-data              # report + write + regenerate the indices
   npm run update-apt-data -- --dry-run # report only, touch nothing
   ```
   `renderer/public/data/en/` (`items.ndjson`, `stats.ndjson`, `client_strings.js`, `app_i18n.json`) is the item database the paste parser resolves names against and the stat text the mod matcher works on. It is vendored from the [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade) upstream repo's own `public/data/` tree (itself generated from RePoE/the game client, same underlying source as step 2, different pipeline). `backend/v2/apt-data-update.mjs` pulls those four files from upstream `master` and regenerates the `*.index.bin` next to them — those are **generated, never copied** (they are line offsets into *our* ndjson; upstream's would point at the wrong lines), and they are gitignored, so the Docker build regenerates them anyway. Only `en/` is refreshed: the server calls `engine.ready({ lang: 'en' })` and loads `en/` only — the other locales are not vendored at all.
   **How to tell this is needed:** new-league items paste as unrecognized (the parser fails with `item.unknown`), or mod matching in the picker looks wrong/incomplete — the usual symptom of stale vendored data, not a code bug. It is not tied to league start; a mid-league patch that adds uniques needs it too.
   **Before committing**, read what the command printed: line counts per file, the `items.ndjson` namespace counts old → new, and every entry upstream **removed**. Additions are free; a removal is the one direction that can silently break the parser or the net-worth bridge, so removals are listed in full. Then run `npm test` — the suite asserts the fields `backend/v2/networth/normalize.mjs` and `kinds.mjs` join on are still there.

4. **If you moved `POE_LEAGUE`, reset the Net-Worth store** (correctness, not cosmetic). `config/networth-store.json` persists a per-tab snapshot of whatever league it last scanned and is **not** cleared on a league switch — so after changing `POE_LEAGUE` the Net Worth page keeps showing the **previous** league's snapshot, and on a fresh league (empty stash) there is nothing to overwrite it, so the stale numbers linger indefinitely. The order matters, because a running container writes its stores again straight away: stop it, delete the file, make the change of step 1, start it:
   ```bash
   docker compose stop
   rm -f config/networth-store.json     # as the owner of config/ (UID 1000), or with sudo
   # ... edit docker-compose.override.yml (step 1) ...
   docker compose up -d                 # add --build only after a git pull (step 5)
   ```
   **Only if you actually moved `POE_LEAGUE`.** If you keep `POE_LEAGUE=Standard` (Net Worth tracks your permanent Standard wealth), leave the Standard store intact and skip this step.

   What does **not** need deleting: the Faustus store (it is league-guarded and a run that finds no market for the configured league keeps the old file, which ages out through `POE_FAUSTUS_TTL_MS`), `corpse-store.json` (it empties itself when the first price of the new league is stored, and the valuator ignores a store of another league meanwhile; only a file written before the store recorded a league keeps its entries, and that one is worth deleting), and `networth-history-guard.json` (it records its league and starts empty when that differs — without the prices it would otherwise take back from `networth-history-items.json` at start, because those are the old league's).

   What **cannot** be reset by this step: the Net-Worth history. `networth-history.ndjson` and `networth-history-items.json` record no league, so the History page shows the change of league as a jump in the chart. Whoever wants a clean start deletes both files as well, in the same stopped window as above; that is a decision for the operator, and the old curve goes with them.

5. **Rebuild and deploy** — commit the regenerated/updated files from steps 2–3, then run the normal [update procedure](#update-procedure) (`git pull && docker compose up -d --build`); the search indices rebuild automatically from the refreshed data.

6. **Check, after the first hour or two.**
   - The **Chaos:Divine tile** must say `live · poe.ninja`, not `fallback`. It knows three states: `live · poe.ninja`, `stale · poe.ninja · <age>` (the last value poe.ninja gave, older than the threshold) and `fallback` (`POE_CD_RATIO`, poe.ninja never answered for this league). poe.ninja often knows a new league only after some hours, and a failed attempt — a network error too — is not repeated for 15 minutes (`NINJA_MIN_MS` in `backend/v2/ninja.mjs`), so give it time. While it says `fallback`, set `POE_CD_RATIO` in the admin area to a realistic starting value (it applies after a restart, which the admin area offers).
   - poe.ninja's log lines come per type and league, one at the start of a failure and one at its end: `[ninja] <what> failing: <reason>`, then at most once per `POE_NINJA_FAIL_LOG_MS` `… still failing after <duration> (<n> attempts): …`, and `… recovered after <duration> (<n> failed attempts)`. Faustus logs every failed tick and, after failures, `[faustus-refresher] refresh succeeded again after <duration> (<n> failed ticks)`. The Sources block on the settings page shows the same state without the log.
   - The log must **not** contain `[faustus-refresher] no market matched league=`. If it does, the league id is misspelled or the exchange has no market for it yet. A currency card showing the source Currency Exchange is the positive confirmation.
   - The league dropdown is filled from poe.ninja (`/poe1/api/economy/leagues`, served as `GET /leagues`), not from GGG. Once, after the start, compare `GET /leagues` with the list from step 1.

## Troubleshooting

### /config is not writable

The log says `/config is owned by uid N and not writable`: the entrypoint found a folder it deliberately does not take over (why: [admin.md → How the container handles /config permissions](admin.md#config-volume)). Fix it once by hand:

```bash
ssh your-server 'chown -R 1000:1000 /path/to/poe-price-tool/config && docker restart poe-price-tool'
```

Never a blanket `chmod -R 777` on `/config`: that would make `networth-users.json` (POESESSID session cookies — full account control if leaked) world-readable *and* world-writable, contradicting the `chmod 600` it needs. Verify as in step 4 of [Install and deploy](#install-and-deploy).

### The overrides were quarantined

The admin area shows the quarantine alarm, or the log shows `config-overrides` lines about failed starts (the mechanism: [admin.md → Configuration from the admin area](admin.md#configuration-from-the-admin-area)). Inspect:

```bash
docker logs poe-price-tool | grep config-overrides
ls -la ./config/overrides*            # overrides.rejected.json is the parked one
cat ./config/overrides.applying       # exists only during a boot: failedStarts=N
```

If the problem was elsewhere, put `overrides.rejected.json` back by hand; nothing else does. Saving anything on the settings page clears the alarm.

### The update button gets no answer

The page waits up to 15 minutes and then says so. The likely reasons, in order:

```bash
cat config/update-result          # the host tried: status=failed plus the tail of the output
ls -la config/update-request      # still there -> nothing picked it up: the script is not running
cat config/update-heartbeat       # a "stuck-since=" line means the lock below
```

If the request file is still sitting there, the script never ran: check the cron/User-Scripts schedule and that the user it runs as may use `docker`.

### The updater is stuck

A run killed hard — a host reboot in the middle of a build, a `SIGKILL` — leaves the lock behind, and every later run writes its heartbeat and then exits at that lock: alive by every measure, and it picks nothing up. The admin area disables the button and says the update script is stuck; the script says the same, to stderr, on every run, and exits non-zero — so cron mails it, if you did not redirect that away.

1. Check that no build really is running — the check the script cannot do for you, which is why it reports the lock instead of breaking it.
2. Clear the lock on the host (the work directory is the sibling of your config directory):

   ```bash
   ls -la /mnt/user/appdata/poe-price-tool/config.host-update   # look before you delete
   rm -f  /mnt/user/appdata/poe-price-tool/config.host-update/update.lock.started
   rmdir  /mnt/user/appdata/poe-price-tool/config.host-update/update.lock
   ```

3. The next run picks up the waiting request, if there still is one.

### The patch lookup failed

In the browser the staleness note names the source, the age, **the reason and what to do about it** ([admin.md → Data auto-update](admin.md#data-auto-update-background), `docs/bugs.md` B24):

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

1. Read the reason:
   - `could not be looked up` = the service did not answer at all (down, DNS, blocked egress) — the class the note calls "nothing to do here"; the next check retries by itself.
   - `expected a https://patch.poecdn.com/<patch>/ URL` = it answered something that is not a CDN base — a captive portal or an error page looks like this.
   - `no patch version in that path` = it answered a CDN base whose last path segment is not a version.

   The last two are the class the note calls "this tool refused it": waiting does not help. If that last segment plainly IS the current patch, the tool is wrong, not the service — fix the validation (`PATCH_RE` in `backend/v2/patch-version.mjs`) rather than working around it.
2. **In every one of the three, `POE_PATCH_VERSION=<version>` gets the localized set current again** — in compose or in the admin area (Settings → admin area → server settings). What the pin costs and what watches it: "Pinning the patch version" in [admin.md → Data auto-update](admin.md#data-auto-update-background).
3. Press **Settings → admin area → server settings → "Check now"** to verify the repair without waiting for the next daily check.
4. Clear the pin again after the following patch, or the localized set stays on the version you pinned.

English is unaffected throughout — it comes from upstream and is adopted whatever the localized side is doing, which is why this can run for days without anything looking broken.

### The game-data export failed

The export is a child process (`pathofexile-dat`); its exit code and stderr decide what the check says (`docs/bugs.md` B24):

| What the check says | What it means | What to do |
|---|---|---|
| `the game-data export refuses this build: … the dat schema has a format its version cannot read` | GGG changed the dat format and the exporter in **this image** predates the change. Nothing about the data or the configuration is wrong | **Update the container** (admin area, "Update to a newer version"). This is the one that will happen eventually and by itself |
| `the game-data export found no column "X" in table "Y"` | Same family: the column list this build asks for no longer matches the schema | Update the container; if it survives that, `TABLE_COLUMNS` in `lang-data-gen.mjs` has to move |
| `the game-data export asked the patch CDN for … and was refused` | The CDN refused a file of that patch. Without a `POE_PATCH_VERSION` pin the version came from the lookup, so the patch exists and the CDN is unwell (class `unreachable`). With a pin the message says so, and the class is `rejected`: the pinned version itself is what is refused | Without a pin: nothing — the next check tries again. With a pin: change or clear `POE_PATCH_VERSION`, because every check repeats the same request until then |
| `exited with code N: …` | Not recognised. The last lines it printed are quoted verbatim and **no cause is claimed** | Read the quoted lines, then the container log |
| `export incomplete: … has English but no German` | The exporter exited 0 and wrote nothing for the target language: it did not accept the translation name | Compare `LANGUAGE_NAMES` in `lang-data-gen.mjs` with the list in `pathofexile-dat/dist/cli/export-tables.js` |
| `export incomplete: … holds neither English nor German` | The exporter wrote no tables at all. **Not** a language problem | Container log — the export's own output is in it, line by line |

### A language was just switched on

The first time you switch a language on, the log looks worse than it is. The already-adopted snapshot was written before the language existed, so it has no `data/de`, and the engine says so bluntly:

```
[engine] parsers=[en]  snapshot languages=[en]  MISSING=[de] — those users get an error instead of an English parse
[engine] no parser for language "de" (Cannot find module '/config/data-refresh/apt/v-…/data/de/client_strings.js'
         imported from /app/backend/v2/engine.bundle.mjs) — items from users on that language are rejected loudly
```

A `Cannot find module` at boot reads like a crash; it is not. Nothing is broken and nothing needs reinstalling.

1. Wait for the **first apt check after boot** (120 s by default, see the startup line `first checks in apt:120s`). It generates the set, adopts a snapshot carrying both languages, and reloads both parsers.
2. After that the startup line reads `parsers=[en, de]`. Meanwhile that user's `POST /item` is answered with `503`.
3. If it still says `MISSING=[de]` several minutes later, something did fail — check the `lang-data` line for the reason ([The game-data export failed](#the-game-data-export-failed), [The patch lookup failed](#the-patch-lookup-failed)).

### Client self-test (`daemon/selftest.sh`)

When a player says "it does nothing", have them run this on **their** machine before you go looking at the server:

```bash
./daemon/selftest.sh
```

It is also what `install.sh` runs, up front (`--tools`) and again at the end. It reads the player's `config.toml` and reports on tools, clipboard access, the `input` group, `ydotoold`, the daemon service, the backend — and then does a real test parse with a sample item in the language **this** backend says it reads for that user (`GET /users` → `langs`), checks the way a result comes back to the game, the game's log for buyer whispers, whether the game's window is found (game detection), the stash cell frame and the session key.

It separates causes that reach you looking identical. Between runs, the player's daemon journal (`journalctl --user -u poe-price-daemon`) gives the same verdicts for every real copy: one line per cause, at most one repeat a minute (after 10 repeats, one every 10 minutes).

Two things to know before you ask for a run:

- The test parse **posts one real item** — one card in that player's browser, one trade search. `--offline` skips it and still checks everything local, including the filter half.
- It never installs, edits or enables anything. Suggested fixes are printed as text.

Verdicts and where the fix is:

| Self-test says | Where the fix is |
|---|---|
| `[FAIL] filter … DROPPED` | The client. `item_prefixes` doesn't match the client language, so the item never leaves their machine — you will find **nothing** in the server log, because nothing was sent. |
| `[FAIL] GET /health … cannot reach` | Network/URL: nothing answered at `backend_url`. |
| `[FAIL] GET /health … answered 301 (redirect)` | The `http://` → 301 → `https://` trap, which loses every item: the POST does not follow redirects (the daemon's journal names the redirect target). Write `https://` in `backend_url`. |
| `[FAIL] unit DISPLAY` | The client. The service manager has no `DISPLAY`, so the daemon cannot read the X11 clipboard PoE copies to; its journal says the same. `systemctl --user import-environment DISPLAY XAUTHORITY` plus a daemon restart fixes the running session; if it returns after every login, the desktop does not hand `DISPLAY` to systemd. |
| `[ -- ] unit environment … could not ask the service manager` | The client, but no verdict on the daemon's `PATH` or `DISPLAY`: `systemctl --user show-environment` itself failed (no user session bus, or no answer within 5 s), and the line quotes its message. Both checks are skipped, because `systemd-run` fails the same way. Run the self-test from the player's desktop session, not over a plain SSH login. |
| `[ -- ] unit sees … could not start a unit` | The client, but no verdict on that tool: `systemd-run` itself failed (its message is quoted) or gave no answer within 10 s. A tool the unit's `PATH` lacks is a `[FAIL] unit sees` instead, with the `environment.d` fix. |
| `[FAIL] unit clipboard` | The client. `DISPLAY` is there, but `xsel` fails under the service manager; usually `XAUTHORITY` is missing there. |
| `[FAIL] POST /item … does not know the user` | You. Their `user` is not in `POE_USERS`, and the server answers 400 (it deliberately does not route the item to the first user). |
| `[FAIL] POST /item … no data set (503)` | You. That user has a language in `POE_USER_LANGS` whose data set is missing from the snapshot; the server refuses rather than parsing it with the English parser. See [admin.md → Data auto-update](admin.md#data-auto-update-background) and [A language was just switched on](#a-language-was-just-switched-on), plus the admin gap view. |
| `[ ok ] POST /item` | The path from the server on works: a card for the test item is on their Price Check page. If they still see nothing, look at the browser side (user cookie, WS connection), not at the daemon. This POST comes from the self-test, not from the daemon, and it counts as the last item: after *Clear all* the empty page names its time even while the daemon drops every copy. Whether the daemon's own copies arrive, the filter line above and the daemon journal say. |
| `[ ok ] whispers` | Nothing to fix: `client_log` is readable; its size and last write are shown. |
| `[warn] whispers … another Client.txt was written later` | The client, perhaps. `client_log` was last written more than a day ago, and a `Client.txt` found under Steam, `~/Games/*/drive_c` or `~/.wine/drive_c` was written after it (listed under the line). The daemon may be following a log the game no longer writes (a second Steam library, an old Wine prefix): no whisper would ever show. If the game runs from a listed one, point `client_log` at it. |
| `[ -- ] whispers … off (client_log not set)` | The client, by choice: the whisper check is off. To use it, the player sets `client_log` in `[whispers]` (the `Client.txt` files found are listed under the line). |
| `[FAIL] whispers … does not exist` | The client. The configured path does not exist; the `Client.txt` files found under Steam (with the libraries in `libraryfolders.vdf`), `~/Games/*/drive_c` and `~/.wine/drive_c` follow. Point `client_log` at one of them, or enter a game installed elsewhere by hand. |
| `[warn] incoming marker` | The client. Its log has `@…` whisper lines that are not ones the player sent, but none with a configured marker, so no whisper is read. Add the marker the client language writes to `incoming_markers`. |
| `[ -- ] incoming marker … only outgoing whispers` | Nothing to fix yet: the last 1 MB holds only whispers the player sent (`@To`; `@An`, `@À`, `@Para`, `@Кому` in the other client languages, from SlimTrade's patterns, not seen in a real log; SlimTrade has them in lower case and compares without regard to case, the self-test compares exactly, so the capital first letter is assumed), which say nothing about the incoming marker. Never add those to `incoming_markers`. |
| `[warn] outgoing marker` | The client. `incoming_markers` holds one of those outgoing markers (`@To`, `@An`, `@À`, `@Para`, `@Кому`), the marker of the whispers the player sends: the daemon would check the player's own purchase whispers as a buyer's. Remove it. |
| `[ ok ] game window … found` | Nothing to fix: with the game running, a window of `poe_window_class` was found, so the daemon reports the game state and the net-worth sync follows it. |
| `[ -- ] game window … no game window` | Nothing to fix: the daemon found the game's window before, and the game is not running now. Run it again with the game running to see it found. |
| `[warn] game window … never seen yet` | The client, perhaps. No window of `poe_window_class` was ever found on this display. Normal before the first game start; if it stays so while the game runs, `poe_window_class` is not the game's window class (or the game runs on another X server, such as gamescope). The daemon then reports "unknown" and the player's sync keeps its normal pace. If the game did run with the daemon and this stays, the daemon journal has a line `Game detection: …/game-seen.json not writable`: the daemon keeps the fact for that run only (its state directory, `$XDG_STATE_HOME/poe-price-daemon/` or `~/.local/state/poe-price-daemon/`, is not writable). |
| `[warn] xdotool … needed for game detection` | The client, by choice or not: without `xdotool` the daemon cannot tell whether the game runs and reports "unknown" (normal pace). Install it, or set `report_game = false` under `[presence]`. Not a failure, so `install.sh` still installs. |
| `[FAIL] highlight key` | The client. `highlight_key` in `[whispers]` is not a text, not a key name evdev knows (names like `F10`, `KP1`, `DOT`), or also a key in `[macros.keys]`: the daemon will not start. Correct the name, or empty it to switch the stash cell frame off. |
| `[warn] highlight key … cannot be checked` | The client. `python-evdev` is missing (section 1), so the key name is not checked. |
| `[FAIL] highlight input` | The client. A highlight key is set and `[stash_grid]` is not `mode = "off"`, but the player is not in the `input` group, so the key is never seen. The line prints the `usermod` command; log out and back in after it. With `mode = "off"` the line is `[ -- ]`: the daemon does not watch the key then. |
| `[warn] highlight whispers` | The client. A highlight key is watched, but `client_log` is empty: there is never a whisper to frame (section 11). |
| `[warn] highlight overlay` | The client. A highlight key is watched, but `[results] overlay = "off"`, and only the overlay draws the frame. |
| `[FAIL] stash grid` | The client. `[stash_grid]` holds a value the daemon refuses (the line quotes the rule), so the daemon will not start. |
| `[warn] stash grid … needs xdotool` | The client. `mode = "auto"` finds the game window with `xdotool`: install it, or set `mode = "manual"` with `x`, `y`, `w`, `h`. |
| `[warn] stash grid … DISPLAY is not set` | Nothing to fix in the config: the self-test ran in a shell without `DISPLAY` and cannot read the game window. Run it from a terminal in the desktop session, with the game running. |
| `[ -- ] stash grid … no game window` | Nothing to fix: no game window was found. Run it again with the game running to see where the grid lies. |
| `[warn] stash grid … gave no size` | The client. `xdotool` found the game window but gave no size for it: set `mode = "manual"` with `x`, `y`, `w`, `h`. |
| `[FAIL] test frame` | The client, only with `--overlay`: the overlay check passed, but `ppt_overlay.py --frame` exited with an error (the line quotes it). With the overlay finding not fixed or the grid not known, the line is `[ -- ]` and no frame is shown. |
| `[FAIL] session card` | The client, only with `--overlay`: the test card was shown, but `ppt_overlay.py --session` exited with an error (the line quotes it). |
| `[FAIL] session key` | The client. `[session]` is not a table, or its `key` is not a text, not a key name evdev knows (names like `F11`, `KP1`, `DOT`), or also a key in `[macros.keys]` or the `highlight_key`: the daemon will not start. Correct it, or empty `key` to switch the session key off. |
| `[warn] session key … cannot be checked` | The client. `python-evdev` is missing (section 1), so the key name is not checked; without it the daemon does not start at all. |
| `[FAIL] session input` | The client. A session key is set, but the player is not in the `input` group, so the key is never seen. The line prints the `usermod` command; log out and back in after it. |
| `[FAIL] session focus` | The client. A session key is set, but `xdotool` or `xprop` is missing: the daemon acts on the key only while the game has focus and cannot check that, so the key does nothing. |
| `[FAIL] session cards` | The client. `cards` under `[session]` is not `true` or `false`: the daemon will not start. |
| `[warn] session cards … the back channel is off` | The client, by choice: `[link] back_channel = false`, so a press shows only its own answer; the baseline, the end of a game session and the balances do not reach the game. |

Section 11 checks the game's log for buyer whispers: whether `client_log` is a readable file (its size and last write are shown, and whether another `Client.txt` found was written later), and how many lines in its last 1 MB are whispers not sent by the player and carry a configured incoming marker (rows in the table above); only counts are printed, never a line of the log. A `[FAIL]` there stops nothing but the whisper check.

Section 12 runs the daemon's own game check once (`xdotool search` for a window of `poe_window_class`, reading the daemon's record of where it has seen the window and writing nothing) and prints only the verdict, never a window id or another program's window name. It never fails: a game detection that cannot tell only keeps that player's sync at its normal pace.

Sections 8 to 10 check the way a result reaches the game: whether the server offers the back channel (`GET /daemon/events?wait=0` with the daemon headers; an older server answers 404 or 405, and the fix is to update it), `notify-send` and the session bus the service sees (and, on KDE, whether notifications are held back while a fullscreen window has focus), and the overlay (`xdotool` and `xprop`, which it needs to know the game has focus, and `ppt_overlay.py --probe`: whether PySide6 imports and an X11 window can be created on xcb; nothing is shown). Pricing works without them, so what they find is mostly a warning. Section 8 is a `[FAIL]` when the server answers neither with the back channel nor with 404/405 (an error status such as 500 or 502, a 200 that is not the feed — a reverse proxy's page — or no answer at all): step 6 reached the backend, so that is a fault in the backend or on the way to it.

Section 10 is a `[FAIL]` when PySide6 is there but no X11 window can be opened (`DISPLAY` is set, but the X server takes no connection, or Qt has no xcb platform), when Qt starts on another platform than xcb, or when `overlay = "on"` and PySide6 is missing; without `DISPLAY` in the shell the self-test runs in, it only warns that it cannot test from there.

Section 13 checks the stash cell frame: the highlight key (one evdev knows, not a macro key, the `input` group) and where `[stash_grid]` puts the grid, in auto mode from the size of the game window `xdotool` finds; it fails only for what would stop the daemon and for a key without the `input` group (with `[stash_grid] mode = "off"` the daemon does not watch the key, so the group is not asked for).

Section 14 checks the session key (`[session] key`): a key name evdev knows, not a macro key and not `[whispers] highlight_key`, the `input` group, and `xdotool` and `xprop` for the focus check the key needs; then whether `[session] cards` is on and the back channel (`[link] back_channel`) brings the cards. It reads only the config and sends nothing. It fails for what would stop the daemon (a `[session]` that is no table, a key that is no text, one evdev does not know or another key uses, `cards` that is not true or false) and for a key the daemon could never act on (no `input` group, no `xdotool` or `xprop`); an empty key is not applicable, and session cards with the back channel off are a warning.

No heartbeat is sent from the self-test, so it does not show up as a running daemon. `./daemon/selftest.sh --overlay` checks only the config, the overlay and the stash grid and then, after a 5-second countdown, shows a test card at the mouse for 5 seconds, a session card where whisper cards stack for 5 seconds and, when the grid is known, a frame at cell 1,1 of the stash for 3 seconds, to be watched in the game with the stash open.

The sample items live in `daemon/selftest-items/<lang>.txt`, one per language, and are picked by the language the backend reports plus the configured prefix — so **a new language is one more file there**, not a change to the script. If a sample ever goes stale against new game data, the self-test reports a 400 parse failure and says so in the hint; check with a real item before concluding the installation is broken.
