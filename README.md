# poe-price-tool

> One-key item prices for **Path of Exile 1** — straight from the game into your browser.

Hover an item, press your key, see the price. No manual copy-paste, and no hunting for the right modifiers on the official trade site. A small, self-hosted setup: a Docker backend plus a hotkey daemon on your machine — the full result shows up in a browser tab you keep open, and the price also shows on the game PC, as a small card over the game or as a desktop notification ([how](#the-price-in-the-game-optional)).

I run an Unraid server at home for several PoE players on Linux desktops. Awakened PoE Trade never ran well for me there — and broke on about every other update — so this is my kind-of-fork: its parsing engine, headless, behind a server everyone in the house can reach. None of this would exist without APT: years of work went into parsing PoE's item text and talking to the trade API correctly, and that part is theirs, vendored under `renderer/` with as few changes as possible ([what differs](#credits)). Credit and thanks to [SnosMe](https://github.com/SnosMe/awakened-poe-trade) — go use the original if you are on Windows.

**Built and tested on exactly one setup:** Garuda Linux (Arch-based) with KDE Plasma 6 on Wayland, Path of Exile via Proton Experimental under XWayland, backend in Docker on Unraid. The backend is plain Docker and should run anywhere; the hotkey daemon leans on that specific stack (clipboard under XWayland, window focus, and for the optional chat macros the `input` group). On another distro or desktop the pieces exist too, but nobody has tried it — see [the note above the prerequisites](#setting-up-the-hotkey).

## Features

- **One-key price check** — hover an item in-game → press a key → the recognized item appears in the browser with current trade prices (range plus a median, so one outlier listing can't make a worthless item look valuable). Toggle mods on and off to refine the search.
  - **Linked sockets** are filtered by default, capped at the item's own largest link group.
  - **Weapon DPS split** (Elemental/Physical) is shown alongside Total DPS — a 205 all-elemental weapon prices nothing like a 205 all-physical one.
  - **Corrupted items default to a corrupted-only search** — corruption puts an item in a separate market from its cheap non-corrupted twins.
  - **One click opens the same search on the official trade site** — with exactly the mods you have selected. The link carries the query id the trade API just returned, so it is the search the tool ran, not a rebuilt approximation: tick a mod, hit *Trade*, and refine it further over there.
  - **Quality and item level** on white bases are shown as read-only chips, since the engine already filters by them.
  - **Mods the tool can't recognize** (e.g. an obscure corruption implicit) are resolved against GGG's own stat catalogue and searched where possible; anything still unresolved is shown read-only instead of silently vanishing. The extended copy form writes the roll together with its range (`+310(260-320) to Armour`); the range comes off for the lookup and becomes the row's slider, so the roll is still what the search filters on.
  - **Rate-limit safe** — if the shared trade queue hits a real GGG ban, an amber banner shows a live countdown and search is paused rather than firing more requests into the ban.
- **Market reference always in view** — live Chaos:Divine plus a rail of prices with mini histories. The selection (Currency, Harvest Lifeforce, Einhar Beasts) is what *I* trade and watch; it is hardcoded in `backend/v2/server.mjs`, so a fork that cares about other things will want to change it.
- **Net-worth tracker** — read your whole stash (needs your POESESSID, see below) and get a total in Chaos and Divine, broken down per tab and category — no tab limits, unique stash included. Priced from the official GGG Currency Exchange (Faustus), poe.ninja, and the Trade API (itemised corpses) — how each category is valued: **[docs/pricing-logic.md](docs/pricing-logic.md)**. Prices the tool knows to be shaky (very thin trading, a guessed gem or unique variant, a corpse priced from one offer) are marked in a Confidence column, and the total says how much of it rests on them. Server-side setup: **[docs/admin.md](docs/admin.md)**.
  - **Listed below market** — a block on the Net Worth page lists every item in a premium tab that you have put up for sale with a price note (`~price` or `~b/o`, the item's own or its tab's) under the tool's market value, by the same rule and threshold as a buyer whisper's *below market*: item, tab, position, your price and the market price in chaos, and the ratio, the biggest loss first (the 100 biggest; the block says how many more there are). It covers all premium tabs whatever the tab selection, reads nothing extra from GGG (the note comes with the stash read the sync does anyway) and only shows in the browser. A note in divine is converted at the current Chaos:Divine rate, and not compared while that rate is the fallback or stale; a note in another currency or on an item with an uncertain market price is not compared either, and the block counts those by reason. An item without a market price, or without a price note, does not appear. A note on a stack is read as a price per unit. Details: [docs/pricing-logic.md](docs/pricing-logic.md#listed-below-market).
- **Farm sessions** — press *Start farm session* and *End farm session* on the History page and get the session's balance: loot (stock change at the prices at the start), market movement, loot per hour in Chaos and Divine, and the biggest additions and removals. The balance starts from the first full read of your stash after the start and becomes final with the first full read after the end; the page gives the server's estimate of the minutes until each, and when no full read came in time it says that the stash at the start is the baseline. With game detection on, the server also keeps a **game session** for each evening, and the History page lists each farm session started during an evening indented under it, every session with its state (starting, running, preliminary, final, never confirmed). The running farm session, else the game session, shows in every page's status line. The hotkey daemon can start and end a farm session from the game with a key of its own and shows its start, baseline and balance there ([Farm sessions in the game](#farm-sessions-in-the-game-optional)). It counts the stash only — loot in your inventory counts once you have stashed it — and trading or crafting during a session shows up in it. Details: [docs/pricing-logic.md](docs/pricing-logic.md#what-a-farm-session-balance-means).
- **Buyer whispers** (optional) — when a buyer whispers you through the trade site, the game PC shows your listed price against the market price and where the item lies; the buyer's name never leaves your PC. See [Buyer whispers](#buyer-whispers-optional).
- **For multiple players** — one shared backend with a shared trade queue, separate rooms per user.
- **English or German client, in the same backend** — the language is a per-user setting each player switches in the browser ([Changing settings later](#changing-settings-later)), so one player can run a German client and another an English one. A German player gets German item parsing *and* a German browser UI. The German data set is **not shipped**: every installation generates it from its own copy of GGG's game data, so nobody redistributes extracted game files. The net-worth tracker is unaffected: **GGG's stash API answers in English regardless of language settings** (measured, see [docs/admin.md](docs/admin.md#stash-api-language)), and names are translated on the way to the screen — a row keeps its English name for the value join, the trade link and every price lookup, and a name the generated data set has no entry for stays English rather than turning into a placeholder. The Stash Highlight regex is not display text but a string the **game** matches, so it is generated in the language the client runs in — names and the exclusion universe together, never half of each; that the game matches it against the displayed names is not yet confirmed in a German client ([`docs/bugs.md`](docs/bugs.md), B10). Setup and limits: **[docs/admin.md](docs/admin.md)**, open defects: **[docs/bugs.md](docs/bugs.md)**, and [Known issues](#known-issues) below.

## What it looks like

![Price Check page: a Watcher's Eye priced at 11–50 divine with a median of 32.5 across 24 trade listings, its modifier picker expanded so each unique modifier can be ticked on or off and its roll range narrowed with a slider; a rare body armour card beside it, and a left rail with the live Chaos:Divine ratio and poe.ninja reference prices.](docs/screenshots/price-check.png)

*Price Check — the item arrives from the hotkey, the mod picker decides what the trade search asks for.*

![Net Worth page: a total of 1,242.9 divine, a category overview splitting it into Currency & Stackables, Uniques, Divination Cards, Gems and Beasts, and a grouped table listing every item with tab, quantity, unit price and total.](docs/screenshots/net-worth.png)

*Net Worth — the whole stash valued, grouped by category, per tab and per item.*

![History page: a 24-hour net-worth curve rising in steps from about 1,179 to 1,243 divine, next to a "What moved" list naming the items behind each step with quantity and value change.](docs/screenshots/history.png)

*History — the curve over time, plus what actually moved in and out behind each step.*

## What is a POESESSID, and do I have to hand it over?

Only the net-worth tracker needs one — the price check works without any login.

`POESESSID` is the session cookie your browser gets when you log in at pathofexile.com. It proves to GGG's servers that a request is *you*, so treat it like a password: whoever has it can act as your account on the website for as long as it stays valid, including reading your stash. GGG has no read-only variant, and their OAuth programme is closed to new developers, so this cookie is the only way any third-party tool can see your stash at all — a limitation of the platform, not a design choice here.

What this project does with it: it is stored in `/config/networth-users.json` with `chmod 600`, used only to fetch your own stash tabs, and never sent back to the browser, never logged and never included in any API response — not even masked. You can paste it in the browser UI or drop it in the file yourself.

**Where it goes:** to `pathofexile.com` and nowhere else. The cookie is attached in exactly one module (`backend/v2/networth/stash-client.mjs`), on the stash requests to GGG. The backend also talks to poe.ninja, GGG's `web.poecdn.com` (the Currency Exchange feed), RePoE (item data, fetched from `repoe-fork.github.io`), `raw.githubusercontent.com` (the APT data auto-update, and RePoE's fallback host) and `api.github.com` (the once-a-day release check, see below) — none of those ever see it. An installation that serves a language other than English adds two more, both only for the language generator: `ggpk.exposed` (one line, the current patch version) and `patch.poecdn.com` (GGG's own game data for that patch). There is no telemetry, no analytics, no phone-home: the whole thing runs on your own machine or your own LAN, and it reaches the internet only to ask those hosts for prices, game data and the newest release.

**It expires more often than you would expect.** Any fresh login invalidates the old cookie — not just logging in on pathofexile.com, but also authorising a third-party site through your PoE account (Filterblade and friends). So the tracker stopping is usually not a bug: something re-authenticated somewhere and your old POESESSID died with it. The tracker says so, pauses that user, and picks up again once you paste the new value. If you suspect the cookie has leaked, log in again on pathofexile.com (that invalidates the old value) and check `/config/networth-users.json` and, if you pass `POE_SESSID` in the compose environment, that file too.

If that trade is not one you want to make, leave it out: everything except the net-worth page works without it.

## What it does in the background

Once running, the backend keeps working without a tab open: it syncs one stash tab about every 30 seconds — that is the total rate, shared out round-robin across the configured users rather than one stream each — and prices itemised corpses at up to 25 trade-API requests per hour. Both go out over **your** IP — the same one you browse pathofexile.com/trade with — and count against the same rate limit. Both can be switched off (`POE_NETWORTH_AUTOSYNC=0`, `POE_CORPSE_DISABLED=1`, see [docs/admin.md](docs/admin.md)). With hotkey daemons that report whether the game runs ([below](#game-detection-on-by-default)), the stash sync reads the stash of whoever is playing first and slows down to about one tab every 5 minutes while nobody plays; it never reads more than without them.

A trade-API ban has been reported to reach the whole IP address, not one account (reported by the operator, not measured), and during development a background crawler (about one trade search every 30 seconds, since removed) got this tool's address banned from the trade API twice, for hours. So every trade request goes through one shared queue, background work only at its lowest priority, and while a ban is up the queue holds everything, the stash sync included. Details: [docs/admin.md](docs/admin.md#rate-limiting--bans).

It also keeps its data current on its own, without touching the trade API:

- the **Faustus refresher** reads GGG's Currency Exchange digest from its CDN once an hour (`POE_FAUSTUS_DISABLED=1` turns it off);
- **poe.ninja** is asked for the Chaos:Divine ratio and reference prices at most every 15 minutes;
- the **daily data check** compares the bundled item and stat data with the Awakened PoE Trade upstream and RePoE, and, for a non-English client, regenerates the localized data set (`POE_DATA_REFRESH_DISABLED=1` turns it off).

When a price source falls behind, every page says so in its status line, and the settings page shows in its **Sources** block when each source last answered and why it failed.

Once a day the backend also asks `api.github.com` for the latest release of this tool, so the pages can say when a newer one is out (a line on every page and the Releases block on the settings page). The request carries nothing but the installed version, inside the User-Agent (`poe-price-tool/<version> (release check)`), and the ETag of the last answer; GitHub sees your IP address, as with any request. The check only reports — nothing is downloaded or installed. The state is kept in `/config`, so a restart does not ask again the same day. Turn it off with `POE_RELEASE_CHECK_DISABLED=1` or with the switch in the admin area of the settings page; the **Check for updates** button there still works when it is off. See [docs/admin.md](docs/admin.md#settings-page--admin-area-settingshtml).

The trade searches and the stash reads send a browser-like User-Agent (`Mozilla/5.0 (X11; Linux x86_64) … Chrome/126.0.0.0 …`). This project sets it, not Awakened PoE Trade: `backend/v2/shims/ipc-host.mjs` replaces the engine's request module and adds it, and `backend/v2/networth/stash-client.mjs` sends the same string. Every other request the server makes names the tool, its installed version and the purpose (`poe-price-tool/<version> (personal LAN tool)`, for example; `unknown` instead of a version that cannot be read), GGG's stat catalogue on pathofexile.com included; the game-data download of the language generator goes through the `pathofexile-dat` package, which sets no User-Agent of its own. The two manual scripts `npm run update-apt-data` and `node backend/v2/base-names-gen.mjs` name the tool the same way in every download. No setting changes any of them.

## How it works

Two parts: a **backend** (Docker) that does the pricing and serves the web UI, and a small **hotkey daemon** that runs on each gaming desktop: it copies the hovered item, sends it to the backend, and shows the price it gets back over the game or as a notification. The backend can run on the **same PC you game on**, or **centrally on a home server** for several players. That's the only real choice — pick an install path below.

## Before you install: no authentication

The backend has **no login of any kind**. It binds to every interface, and the only "identity" is a cookie you set yourself in the browser — so anyone who can reach the port can read your account name, spend your trade-API rate limit, and overwrite the stored POESESSID (which is a full session token for your PoE account).

**Run it on a trusted LAN only, and never expose the port to the internet.** If you put it behind a reverse proxy, put authentication in front of it.

With the buyer-whisper check in use, the item, your listed price and the stash position of each incoming trade whisper (never the buyer's name, which stays on the game PC) are readable the same way: by any program on the LAN that names your user.

The settings page has an **admin area** behind a password, but that is a partition, not a security boundary. It is created with the default password `admin` on first boot — a password printed in this repository for everyone to read — and it guards more than a diagnostic view: the **restart button** and the **server settings the next start reads** hang on the same password. Change it (`/config/admin-password`) before this tool is reachable from anywhere but your home network; see [docs/admin.md](docs/admin.md#the-admin-password). While the default is still in force, the tool says so at every start (container log) and in the admin area itself. It does not force a change: on a LAN tool, locking you out of your own box is the worse failure.

## Install — Option A: everything on one PC

Backend and hotkey on the same Linux machine. The simplest setup.

1. Clone and start the backend (needs only Docker):

   ```bash
   git clone https://github.com/BriskWatchdogz1/poe-price-tool.git
   cd poe-price-tool
   docker compose up -d --build              # → http://127.0.0.1:8788
   ```

2. Open in your browser:

   |  |  |
   |---|---|
   | **Price Check** | <http://127.0.0.1:8788/> |
   | **History** | <http://127.0.0.1:8788/history.html> |
   | **Net Worth** | <http://127.0.0.1:8788/networth.html> |
   | **Settings** | <http://127.0.0.1:8788/settings.html> — net-worth credentials and your client language, plus an admin area holding what the tool could not parse or price and the server settings that can be changed at runtime |

3. Set up the hotkey ([see below](#setting-up-the-hotkey)) with `backend_url = http://127.0.0.1:8788`.

## Install — Option B: central server for several players

One shared backend on a home server (e.g. Unraid), each player on their own Linux desktop.

**On the server** — clone, set your player names, then build:

```bash
git clone https://github.com/BriskWatchdogz1/poe-price-tool.git
cd poe-price-tool
```

Set one room per player via `POE_USERS`, in a `docker-compose.override.yml`. You need to create this file yourself — it's already listed in `.gitignore`, so `git pull` stays clean. **These names are exactly what each player's daemon `user` must match** (step 3 below). Without this file the rooms default to `player1,player2`:

```bash
cat > docker-compose.override.yml <<'EOF'
services:
  poe-price-tool:
    environment:
      - POE_USERS=alice,bob        # your players' names
EOF
docker compose up -d --build                 # first build + start
curl -s http://127.0.0.1:8788/users          # → {"users":["alice","bob"],"appName":"Trade Console","langs":{"alice":"en","bob":"en"}}
```

**If a player runs a non-English PoE client, say so here too.** The client language is a per-user server setting, and it decides which parser and which UI language that player gets; on a single-PC install the line goes in the same `docker-compose.override.yml`:

```yaml
      - POE_USERS=alice,bob
      - POE_USER_LANGS=bob:de       # bob plays a German client; alice stays English
```

With that line, `/users` reports `"langs":{"alice":"en","bob":"de"}`. Everyone not listed uses `POE_LANG_DEFAULT` (`en`). Supported today: `en`, `de`. `POE_USER_LANGS` is only the value a player starts on; he can switch it himself on the settings page ([Changing settings later](#changing-settings-later)). A typo — unknown user, unsupported language, malformed pair — **stops the startup on purpose**, because the wrong language does not fail by itself: it returns a plausible, wrongly parsed item. The German data set is generated by the container itself, in the background, from GGG's game data — it is not part of the image. Until it exists, that player's price checks are **refused** (HTTP 503, one warning line in the log, one row in the admin view) instead of being parsed as English; the first successful generation run fixes it without a redeploy. Details: [docs/admin.md](docs/admin.md#data-auto-update-background).

> **Expect a scary-looking start the first time.** The snapshot the container is already running was written before the language existed, so the log greets you with `MISSING=[de]` and a `Cannot find module … /data/de/client_strings.js`. That is the refusal doing its job, not a broken install — **wait for the first data check (120 s after boot)**, which generates the set and reloads both parsers. The startup line then reads `parsers=[en, de]`. Only if it still says `MISSING=[de]` minutes later is something actually wrong.

A reverse proxy is optional. If you use one, enable **websockets** and give it a read timeout above 30 s, which the daemon's back channel needs ([docs/runbooks.md](docs/runbooks.md#reverse-proxy-npm-optional)). Server reference — `/config`, permissions, all env vars: **[docs/admin.md](docs/admin.md)**. Procedures — install, update, reverse proxy, backup, league start, troubleshooting: **[docs/runbooks.md](docs/runbooks.md)**.

**On each gaming desktop** — you only need the tiny hotkey daemon, nothing else from the repo (no backend, no Dockerfile). Check out **only** the `daemon/` folder:

```bash
git clone --filter=blob:none --no-checkout https://github.com/BriskWatchdogz1/poe-price-tool.git
cd poe-price-tool
git sparse-checkout set --no-cone daemon
git checkout
```

This leaves you with just `daemon/`. Then set up the hotkey ([see below](#setting-up-the-hotkey)) with `backend_url` pointing at the server: `http://192.0.2.10:8788` (the server's address on your LAN and the port from `docker-compose.yml`), or `https://your-server` behind a reverse proxy.

## Setting up the hotkey

> Run the commands below from **inside** the `poe-price-tool/` folder you cloned above. (`cd poe-price-tool` only works from its parent — if you're already inside the repo, you're set.)

A small daemon watches your **clipboard** and prices whatever PoE item lands in it. The price check only reads the clipboard: it injects no key presses and does not touch your input. You bind your own key to PoE's own copy shortcut (Ctrl+Alt+C); the daemon just reacts to what you copy.

The optional [chat macros](#chat-macros-optional) are a separate part of the same daemon, and **they are active in the default config** that `install.sh` copies: with them, the daemon reads the keyboards that carry a macro key via evdev to see the macro keys (F5–F9) and types chat commands through `ydotool`. To run the price check alone, delete the `[macros]` and `[macros.keys]` blocks from `config.toml`; the daemon then opens no input device.

> **Everything in this section assumes the tested stack** (see the top of this file): Arch-based, KDE on Wayland, PoE under XWayland. On another distribution the package names differ (`apt`, `dnf`, …) but the tools are the same. On X11 instead of Wayland the macros still use `ydotool`; only the clipboard and focus tools differ. On GNOME or another desktop the "custom shortcut" step lives elsewhere in the settings. None of that has been tried, so treat the specifics as a starting point rather than as verified.

**1. Prerequisites** (Arch/Garuda — adapt the package manager for your distro):

```bash
sudo pacman -S ydotool wl-clipboard xsel xdotool xorg-xprop python-evdev curl
sudo usermod -aG input $USER      # only for the chat macros; then log out and back in once
```

On Debian 13 (trixie) or Ubuntu 26.04 LTS — **not tested on a Debian or Ubuntu machine**; the names come from packages.debian.org and packages.ubuntu.com:

```bash
sudo apt install ydotool wl-clipboard xsel xdotool x11-utils python3-evdev curl
sudo apt install libnotify-bin python3-pyside6.qtcore python3-pyside6.qtgui python3-pyside6.qtwidgets   # optional, the price in the game
sudo usermod -aG input $USER      # only for the chat macros; then log out and back in once
```

`x11-utils` carries `xprop`, `libnotify-bin` carries `notify-send`. On Ubuntu, everything except `x11-utils`, `libnotify-bin` and `curl` is in `universe`. Debian 13 has `ydotool` only in `trixie-backports`, not in the release itself, so there the first line fails as it stands: take `ydotool` from backports, or drop it from the line and leave the chat macros out of the config (see below). Python 3.11 or newer is required (the daemon reads its config with `tomllib`).

> **On an immutable distribution (Bazzite, Silverblue, Kinoite): do not layer.** `rpm-ostree install` can leave a system that will not update or auto-login, and none of it is necessary here — everything the daemon needs is reachable without touching `/usr`:
>
> | need | how |
> |---|---|
> | `xdotool`, `ydotool` | already in the Bazzite image — check with `rpm -q`, do not install |
> | `xsel`, `xprop` | `brew install xsel xprop` (Homebrew is preinstalled, prebuilt bottles, no compiler) |
> | python `evdev` | `python3 -m pip install --user --break-system-packages evdev-binary` |
> | group `input` (chat macros only) | `ujust add-user-to-input-group add`, then log out and back in |
>
> - **`evdev-binary` is the right package**, not `python-evdev` — the latter is source-only on PyPI and wants a compiler. It installs as `import evdev`, so nothing in the daemon changes. The `--break-system-packages` flag is what PEP 668 demands on Fedora-family systems; it still only writes to `~/.local`, so it is not layering.
> - **Homebrew is on your login shell's `PATH`, not on the service manager's.** The daemon runs under systemd, so it can be missing `xsel` while your terminal finds it — and a missing `xsel` means a fallback to `wl-paste` (the journal names it, once a minute at first, then every 10 minutes), which does not reliably see XWayland copies. The self-test asks the service manager directly and says so if the two disagree; that line has to be green, not just the tool line above it.
>
> Not verified: whether the Fedora `ydotool` package ships a user unit named `ydotool.service`. If `systemctl --user enable --now ydotool` says "unit not found", write one — `ydotoold` only needs access to `/dev/uinput`. This affects the [chat macros](#chat-macros-optional) only; the price check does not use ydotool.

What each tool is for: `ydotool` only for the [chat macros](#chat-macros-optional); `xdotool`/`xorg-xprop` for the chat macros and for the overlay in the game, which is shown only while the game has focus — but the shipped example config has `[macros]` switched on, so on the first run `install.sh` demands them. To install without macros, create `~/.config/poe-price-daemon/config.toml` yourself first, without `[macros]` (copy `daemon/config.example.toml` and delete the `[macros]` and `[macros.keys]` blocks); the installer then leaves it untouched and does not ask for the macro tools. `python-evdev` is imported unconditionally by the daemon, so it is required even if you never configure macros — the daemon will not start without it. The price check itself only needs `xsel` + `curl` at runtime: the daemon reads the clipboard via `xsel -b -o` first, since PoE runs under XWayland, and only falls back to `wl-clipboard`'s `wl-paste` if `xsel`/`DISPLAY` are unavailable. Optional for [the price in the game](#the-price-in-the-game-optional): `libnotify` (`notify-send`) for a notification, `pyside6` (with `xdotool` and `xorg-xprop`) for the overlay; the daemon runs without them, and `./daemon/selftest.sh` says which of them work. `xdotool` is also used to see whether the game runs (`[presence]`, on by default, see [game detection](#game-detection-on-by-default)); without it the net-worth sync simply keeps its normal pace.

**2. Install** — set up the daemon as a systemd user service:

```bash
./daemon/install.sh
```

The script writes the unit `~/.config/systemd/user/poe-price-daemon.service` (under `$XDG_CONFIG_HOME` if set), which points at **this checkout** — if you move or re-clone the folder, run `./daemon/install.sh` again. To uninstall: `systemctl --user disable --now poe-price-daemon`, then delete that unit file and `~/.config/poe-price-daemon/`. As a side effect, the script also enables and starts the `ydotool` user service (`systemctl --user enable --now ydotool`) — it is what the optional chat macros use to type; harmless to leave running if you never configure macros. The installer ends with a **self-test** ([what it checks](#daemon-troubleshooting)), so a fresh install is proven, not assumed. On a first run it will still report the backend as unreachable, because step 3 below is where you point it at your backend; run `./daemon/selftest.sh` again after that.

**3. Configure — you must edit this.** `install.sh` already placed a config at `~/.config/poe-price-daemon/config.toml` (a copy of the example, with placeholder defaults). It lives in your home directory, **not in the repo**: the repo only carries the `daemon/config.example.toml` template, so `git pull` never overwrites your settings. **Open it and adjust it** — with the defaults it points at `127.0.0.1`, so for a server (Option B) it won't reach your backend until you change `backend_url`:

```toml
user = "player1"                        # must match a name in the server's POE_USERS (Option B step above)
backend_url = "http://127.0.0.1:8788"   # Option A (local); a server without proxy: "http://192.0.2.10:8788", behind a proxy: "https://your-server"
item_prefixes = ["Item Class: "]        # how a copied item starts — IN YOUR CLIENT'S LANGUAGE (see below)
poe_window_class = "steam_app_238960"   # PoE detection, used by the chat macros — leave as-is for PoE1 on Steam
```

> **`item_prefixes` is not optional on a non-English client.** The game writes the item-class line in the *client's* language, and the daemon posts only clipboard contents that start with one of these strings — everything else is dropped without a word, which is exactly what you want for every other Ctrl+C in the game. The default is the English `"Item Class: "`, so on a German client the daemon would silently discard **every** item:
>
> ```toml
> item_prefixes = ["Gegenstandsklasse: "]              # German client
> item_prefixes = ["Item Class: ", "Gegenstandsklasse: "]  # both, if you switch
> ```
>
> **Edit the line in place — do not append it to the end of the file.** In TOML a key belongs to the last section header above it, and this config ends with `[macros]` / `[macros.keys]`. A key appended at the bottom therefore becomes a *macro*, not a top-level setting: the daemon never sees it, falls back to the English default, and keeps discarding every item, while it starts up perfectly happy. `daemon/selftest.sh` catches it — it reads the file the same way the daemon does, so a misplaced key shows up as `item_prefixes not set` even though the line is visibly there.
>
> Listing several costs nothing. The symptom of getting this wrong is the tool doing nothing at all, with no error anywhere. It has to match the language the server reads for that user (`POE_USER_LANGS`, set as in [Option B](#install--option-b-central-server-for-several-players) — on a single-PC install it goes in a `docker-compose.override.yml` the same way — or the player's choice on the settings page), but the two are separate settings: the daemon decides what to *send*, the server decides how to *read* it. Set both to the language your client actually runs in and leave it there — neither is guessed per item, and the daemon's half is read at startup (switch the language in the browser, and `item_prefixes` has to follow). Supported today: English and German. It does not matter whether you hold Alt while copying: the Alt effect is an in-game *display* thing, the clipboard text stays in the client language either way.

The daemon has no key binding of its own: it reacts to whatever lands in your clipboard, so the key is bound in the game (step 4). The file holds the rest — chat macros, ydotool socket — each with an inline comment. After editing, apply it:

```bash
systemctl --user restart poe-price-daemon
```

> **Behind a reverse proxy / HTTPS (Option B):** if `backend_url` points at an address the proxy forces onto HTTPS (http → 301 to https), **always write `https://`**. The POST deliberately does not follow redirects — with `http://` it receives the 301, does not follow it, and returns without ever reaching the backend. No error, no price, no log entry.

**4. Bind your key, in-game** (one-time): PoE keybind **"Advanced Mod Descriptions" = Alt** — that is the half of `Ctrl+Alt+C` that makes the game write the tier and range information the parser needs; with the plain `Ctrl+C` form no mod section is read at all. Then bind a key of your choice to PoE's **copy item** action (Ctrl+Alt+C) — either directly in the game's keybind settings, as a **KDE Custom Shortcut** of type *Command/URL* running `xdotool key ctrl+alt+c` (KDE has no built-in "send another key combo" action), or in the software of a programmable input device if you use one. Hover an item, press your key → the item appears in the browser automatically, no further action needed.

> **Why a daemon at all?** The clipboard has no "something was copied" signal a script could wait for, so something has to watch it. The daemon polls a few times a second, and when a PoE item shows up it POSTs it to the backend (`daemon/poe-price-post.sh`); it has to keep running for that. The two halves react differently:
> - **Chat macros** only fire while Path of Exile has focus (checked via `xdotool`/`xprop` against `poe_window_class`). Your macro keys stay inert in every other window — pressing them in a browser does nothing.
> - **The price check does not check focus.** It watches the clipboard regardless of which window is active, and what filters it is the *content*: anything that does not start with one of your configured `item_prefixes` (default `Item Class: `) is dropped. So copying normal text anywhere changes nothing — but copying a PoE item text from Discord or a wiki page **will** price it. That is deliberate: PoE runs under XWayland and its copies land in the X11 clipboard, which the daemon reads directly to sidestep a flaky clipboard bridge; a focus check would mean another `xdotool` call several times a second. (The overlay below does check focus, but only to decide where a result is shown, never whether an item is priced.)

### The price in the game (optional)

After the hotkey the price also shows on the game PC, so you need not leave the game. The card says *queued* at once and is replaced in place when the price arrives: a Currency Exchange rate comes at once, a unique shows its poe.ninja value while the trade search runs, and a result with listings reads like `140 div (125–170)` with the number of listings under it. It comes one of two ways:

- **An overlay** (needs PySide6, `xdotool` and `xprop`; on Arch the packages `pyside6`, `xdotool`, `xorg-xprop`): a small card next to the mouse pointer, over the game, shown only while the game has focus (`overlay_only_in_game`): when another window takes the focus, the card goes and a result still to come arrives as a notification. It lets every click through and never takes focus. Move the mouse away (`hide_distance_px`, 220 px) and the card goes; a finished price also goes after `item_hold_s` (8 s), a card still waiting for its result after `pending_hold_s` (60 s). A result that arrives after the card went brings it back at the mouse.
- **A notification** (needs `notify-send`, part of libnotify) with the same lines, replaced in place. It carries every card the overlay cannot show: while the game does not have focus, without PySide6 or the focus tools, and while the overlay process is starting again after a fault.

Only items your own daemon sent are shown; a search you start in the browser does not pop up. Every price check gets an answer there: an item that cannot be read, a server that does not answer, a paused trade search, a result that does not come within 2 minutes (`result_wait_s`), a result lost while the server restarted and a server too old to send results back are said on the card too. An item that is copied again, with nothing but other text copied in between, brings that item's card back without a new request (the very same clipboard twice in a row is no new copy for the daemon); after a restart of the daemon, which forgets its cards, it says that this was the same item as before and that its price is in the browser.

Try the overlay: run `./daemon/selftest.sh --overlay`, switch to the game, and a test card appears at the mouse for 5 seconds, then a session card where whisper cards stack. The overlay is an X11 window, like the game under Proton on XWayland; the daemon starts it on Qt's xcb platform whatever the desktop session sets. KDE Plasma holds notifications back while a fullscreen window has focus, and the game counts as one. Untick System Settings → Notifications → Do Not Disturb mode → Enable automatically: *While a fullscreen application is focused*, or use the overlay; `./daemon/selftest.sh` says whether it is on. Settings: `[results]` and `[link]` in `config.toml` (both may be left out; the defaults switch both ways on).

### Buyer whispers (optional)

Set `client_log` in `[whispers]` of `config.toml` to the game's `logs/Client.txt` (`./daemon/selftest.sh` lists the ones it finds). When a buyer whispers you through the trade site, the overlay (a stack on the left side of the screen, `whisper_anchor`) or a notification shows the item, **your listed price against the market price**, and where the item lies (stash tab, left/top). The price in such a whisper is your own: the buyer's trade site copies your listing into it, so *below market* means you are selling cheap. The whisper is in the buyer's trade-site language: English, German, French, Russian, Spanish and Portuguese ones are read. Item names are known in English and, once the server has generated the German data set, German; in a French, Russian, Spanish or Portuguese whisper an item is compared only when its name is exactly an English or German one, else it is shown as written, with your listed price but without a market price (*no item data for this language*). The Price Check page lists the whispers of the session. Rares, magic and normal items and gems have no market price here and say so, as does every other whisper that is not compared ([docs/pricing-logic.md](docs/pricing-logic.md#what-a-buyer-whisper-verdict-means)). A single whisper for something that stacks gets no verdict, because it is not known whether its price is for one unit or for the whole stack; it shows both readings in chaos per unit next to the market price per unit (in the game: `100 c each, or 5 c each as a stack of 20 · market 0.4 c each`), with the stack size from the whisper, else from the last net-worth sync at that tab and cell (marked `(last sync)`, as that stack may have changed since), else per unit only. When the Chaos:Divine rate behind a price in divine is the fallback or stale, or the market price is uncertain, the card says so after the listed price (`C:D rate unknown`, `price uncertain`) and the Price Check page after the numbers: those are the cases a verdict would not be given, and the readings are only as good as that rate or price. The tool never invites, answers or clicks.

Only whispers that start like a trade-site template leave your PC (`trade_prefixes`); a whisper that only looks like a trade offer is counted, not sent, and the journal says at most once an hour how many stayed on the PC. The buyer's name never leaves your PC: it is shown on the overlay card only, kept in the daemon's memory and not stored anywhere; the notification, the browser and the server see a pseudonym such as *buyer 3* (`toast_shows_name = true` puts the name into the notification too). The game is found under Steam; a game installed with Lutris or Wine has its `Client.txt` under `drive_c/Program Files (x86)/Grinding Gear Games/Path of Exile/logs/`. The daemon reads the file from its end, so whispers from before its start are not shown; after a restart within 10 minutes, or when the file was gone or unreadable for a moment, it goes on where it stopped.

**Stash cell frame** (not the Stash Highlight search string of the net-worth page). Set `highlight_key` in `[whispers]` (for example `"F10"`) and press it in the game: the overlay draws a frame around the stash cell of the newest whisper that names one, with a label such as `1/2 buyer 1 · tab "Sale" · left 5, top 3`, for `whisper_hold_s` (20 s). Each further press within that time goes one whisper older, after the oldest back to the newest; without such a whisper the card says *no whisper with a stash position yet*. Open the tab yourself; the frame only shows where in it to look. The key is read like the chat macro keys (your user in the `input` group), works only while the game has focus, and the frame goes when the game loses it, like the cards. Where the grid lies is `[stash_grid]`: `mode = "auto"` takes it from the game window's size (`xdotool`), as [SlimTrade](https://github.com/zmilla93/SlimTrade) does: on a 1920×1080 window a 634×634 px grid at x 15, y 125, scaled with the window (`folders = "outside"` or `"inside"` when you use stash tab folders); `mode = "manual"` takes `x`, `y`, `w`, `h` in screen pixels; `mode = "off"` switches it off. A quad tab has 24×24 cells: the server knows it from the tab type of the last net-worth sync, and a left or top above 12 means quad as well. `./daemon/selftest.sh --overlay` shows a frame at cell 1,1 of your stash to check the grid (section 13 says where it found it).

### Game detection (on by default)

The daemon also tells the server whether your game is running (it looks for the game's window, nothing else). With several players on one server, the net-worth sync then reads the stash of whoever is playing first, and slows down for those whose game is not running; the status line says so: "Sync yields: your game is not running — about one tab every 5 min." while others play, "Sync rests: no game running anywhere — about one tab every 5 min." while nobody plays. It never reads more often than without game detection. It needs `xdotool` (also without chat macros) and says "not running" only after it has seen the game's window once on your display, so a wrong `poe_window_class` never slows you down. Switch it off with `report_game = false` under `[presence]`; `./daemon/selftest.sh` shows whether the game window is found while the game runs (section 12).

### Farm sessions in the game (optional)

The History page's farm sessions can be started and ended from the game. Set `key` under `[session]` in `config.toml` (for example `"F11"`) and press it while the game has focus: the first press starts a farm session, the next one ends it, like the History page's Start and End buttons. The key is read like the chat macro keys (your user in the `input` group, `xdotool` and `xprop` for the focus check), does nothing in other windows, and is not taken away from the game: pick one the game does not use. A card answers each press and follows the session, in the stack where whisper cards stand (`whisper_anchor`) while the game has focus, else as a notification:

- *Farm session started* — *baseline with the next full read (about 6 min)*: the balance starts from the first full read of your stash after the press, not from the stash at the moment of the press. The minutes are the server's estimate.
- *Baseline set, session running*; when no full read came in time, the card adds that the stash at the press is the baseline, and so do the cards at the end (also when the session ended before the first full read).
- *Session ended* — *put your loot in the stash first*, *balance in about 4 min*: the balance waits for the next full read after the end, and only the stash is read, so loot still in your inventory then does not count.
- *Session balance* — *loot +2.5 div, market +0.36 div*, *per hour +1.4 div* (in divine when the server has a rate, else in chaos; numbers in the card's format, `lang` under `[results]`).
- *Session closed unfinished* (*Game session closed unfinished* for a game session) — *no full read after its end, see the History page*: the stash was not read completely in time after the end, so the History page lists the session as *never confirmed*, with the figures it had.

With game detection on, the server also keeps a game session for the whole evening, unless whoever runs the server switches game sessions off (`POE_SESSION_AUTO_GAME=0`): *Game session started* when the game runs, *Game session ended* with *balance in about N min* once it has not run for 10 minutes (the server's `POE_SESSION_GAME_GAP_MS`), then *Game session balance*. A farm session started during the evening belongs to it. These cards come without a key, through the back channel (`[link]`); `cards = false` under `[session]` keeps only the answer to your own press. A press the server refuses says why on a *Farm session not started* or *Farm session not ended* card (for example *the server's stash sync is off*, or *no recent read of your stash* when the sync has not read it lately); a server too old for the key says so on a *Session key* card. `./daemon/selftest.sh` checks the key (section 14); `--overlay` shows a session card.

### Chat macros (optional)

The same daemon can also bind keys to chat commands — open chat, type the command, send it — like APT/SlimTrade's macro keys. Configured in the same `config.toml`, `[macros]` section:

```toml
[macros]
keyboard_layout = "us"     # "us" | "de" — so chat commands type correctly under KWin
chat_open_delay_ms = 45
keystroke_delay_ms = 12
[macros.keys]              # key -> chat command (freely extendable)
F5 = "/hideout"
F6 = "/kingsmarch"
F7 = "/delve"
F8 = "/menagerie"
F9 = "/monastery"
```

Only letters (a–z), digits, spaces and `/ - _` are typed; any other character in a macro is skipped. Set `keyboard_layout` to match your in-game client keyboard layout — chat commands are typed via kernel-level key injection, which KWin then interprets according to the active layout, so it has to match to produce the right characters. Removing both blocks disables macros ([setting up the hotkey](#setting-up-the-hotkey)).

The daemon lives in `daemon/` in this repo, and every setting — backend, user, window class, macros — is in `config.toml` / [`daemon/config.example.toml`](daemon/config.example.toml): fully customizable, nothing hardcoded. A macro whose ydotool call fails is not sent half-typed: the daemon stops at the failing step and writes one line to its journal (missing socket, missing ydotool, ydotool's exit code).

### Daemon troubleshooting

**Start here — run the self-test:**

```bash
./daemon/selftest.sh
```

It is the same check `install.sh` runs, and it is meant to be run again months later by whoever has to fix the machine. It reads your `config.toml` — nothing about your installation is baked into it — and reports, in plain words, on: the tools the daemon needs, clipboard access, the `input` group, `ydotoold`, the daemon service, the backend, a **real test parse**, the way a price comes back to the game, and the game detection. The test parse sends a sample item, in the language your backend reads for your user, through the actual filter (`daemon/poe-price-post.sh`) and on to the backend. The later sections ask whether the server offers the back channel (8), check `notify-send`, the session bus the service sees and, on KDE, the fullscreen mute (9), probe the overlay: PySide6, an X11 window on xcb, `xdotool` and `xprop` for its focus check (10), check the game's log for buyer whispers: `client_log`, whether another `Client.txt` was written later, and whether its whisper lines carry a configured incoming marker, printing only counts (11), look for the game's window (12), check the stash cell frame: the key, the `input` group for it, and where `[stash_grid]` puts the grid, in auto mode from the game window `xdotool` finds (13), and check the session key (`[session]`): the key name, the `input` group, `xdotool` and `xprop`, and whether session cards are on and the back channel brings them (14). Pricing works without sections 8 to 14, so they mostly warn; when each of them fails is listed in [docs/runbooks.md → Client self-test](docs/runbooks.md#client-self-test-daemonselftestsh) (section 12 never fails). `./daemon/selftest.sh --overlay` shows a test card at the mouse, a session card where whisper cards stack and, when the grid is known, a frame at cell 1,1 of the stash.

The test parse is why this is worth running before anything else. Its filter half is local and touches no network at all, so the two causes that look identical from the outside — "nothing reaches the backend" — are told apart:

- **dropped by the filter** → `item_prefixes` doesn't match your client language. The backend is never contacted and nothing is logged anywhere (the empty Price Check page only says that no item has arrived); this is the failure that otherwise looks like a dead installation.
- **passed the filter, backend refused** → the answer is classified: unknown user (400), a configured language with no data set (503), or a genuine parse failure (400).

It changes nothing — no install, no config edit, no service enabled; where it knows a fix it prints the command instead of running it. The one thing it does do is POST **one** item to your backend, exactly like a single hotkey press (one card in the browser, one trade search); `--offline` skips that half. With no `[macros]` section in your config, the macro tools (`ydotool`, `xdotool`, `xprop`) and the `input` group are reported as *not applicable* rather than missing. And it runs on a machine where nothing is installed yet — that is the state you diagnose from.

The daemon's journal names every failure in one line, with what happened and what to do next. It repeats the same failure at most once a minute (`error_repeat_s` in `config.toml`), with a count, after 10 repeats at most every 10 minutes (`error_repeat_slow_after`, `error_repeat_slow_s`), and says when it works again: `journalctl --user -u poe-price-daemon -f`. At start it checks once whether the backend answers and knows your user, whether it offers the back channel for results in the game, and whether the clipboard can be read, and it says in one line how results reach the game. In the browser, the empty Price Check page says when the last item from your daemon arrived, or that none has since the server started. The self-test's test item counts as such an item too: the server cannot tell the two apart.

| Symptom | Likely cause / fix |
|---|---|
| The journal says `POST /item failed: cannot reach …` | Nothing answers at `backend_url`: start the backend or fix the URL (`curl <backend_url>/health` → `ok`). |
| The journal says `answered 301, a redirect to https://…` | `backend_url` is `http://` but the reverse proxy forces `https://`. The POST deliberately does not follow redirects. Use `https://` in `config.toml` (see the note in step 3 above). |
| The journal says `DISPLAY is not set in the daemon's environment` | The service manager started the daemon without `DISPLAY`. From your desktop session: `systemctl --user import-environment DISPLAY XAUTHORITY && systemctl --user restart poe-price-daemon`; the self-test checks it. |
| Chat macros, the highlight key (`highlight_key`) or the session key (`[session] key`) do nothing | You're not in the `input` group (evdev needs `/dev/input/event*` access) — `sudo usermod -aG input $USER`, then log out and back in. |
| Price check works, but only when the game window has focus in an unusual way / feels less reliable than expected, and the journal says `xsel is not on the daemon's PATH` | `xsel` isn't installed, so the daemon fell back to `wl-paste`, which doesn't reliably see XWayland (PoE) clipboard changes — install `xsel` (see prerequisites above) and restart the daemon. |
| Nothing happens on copy, the journal stays silent, and the Price Check page says no item has arrived (or names only the time of a self-test run) | `item_prefixes` doesn't match your client language, so the daemon drops every copied item as "not an item" (step 3 above). The default is English. The self-test's own POST is not filtered and counts as the last item, so its time on the page does not prove that the daemon's copies arrive; its `filter` line does. |
| The card appears in the browser, but nothing shows in the game | Run `./daemon/selftest.sh`: section 8 says whether the server offers the back channel (an older one does not: update it), sections 9 and 10 check the notification and the overlay. The daemon's journal names the cause in one line: `journalctl --user -u poe-price-daemon -n 50`. |
| The journal says `The backend at … has no /daemon/events … older than this daemon` | The server is older than the daemon. Pricing works; the price stays in the browser, and the game only shows that the item was sent. Update the server; the daemon asks again every 10 minutes and needs no restart. |
| The session key shows no card | Run `./daemon/selftest.sh`: section 14 says whether the key is known, your user is in the `input` group, and `xdotool` and `xprop` are there (the key works only while the game has focus). Every press that reaches the server gets a card, a refusal included; a second press while the first one still waits for its answer is ignored, with no card and no journal line. When no card comes for a single press, the journal names the cause: `journalctl --user -u poe-price-daemon -n 50`. |
| Trade whispers show nothing in the game | Run `./daemon/selftest.sh`; section 11 says whether `client_log` is found, whether another `Client.txt` was written later than it, and whether your client writes a known incoming marker. The journal names the cause per whisper without the buyer's name (`Whisper w12 (buyer 3) not checked: …`): `journalctl --user -u poe-price-daemon -n 50`. |
| The stash cell frame is not on the item | Run `./daemon/selftest.sh --overlay` with the game running and the stash open: the frame should sit on the top-left cell. If it does not, set `folders` in `[stash_grid]` to how you use stash tab folders, or `mode = "manual"` with the grid's `x`, `y`, `w`, `h` in screen pixels. A frame on the right cell of the wrong tab is the tab you have open: the label names the whisper's tab. |
| The journal says `HTTP 503 … no parser for language` | That user is configured for a language whose data set doesn't exist yet, and the server answers the POST with 503. Whoever runs the server: see [docs/admin.md](docs/admin.md#data-auto-update-background). |

## Updating

The server and every daemon are clones of their own; each is updated where it runs. On a one-PC install it is one clone: one `git pull`, then the other commands of both blocks.

**Server**, in its clone:

```bash
git pull
docker compose up -d --build
```

**Daemon**, in the clone on each game PC (a `daemon/`-only clone stays one):

```bash
git pull
systemctl --user restart poe-price-daemon
./daemon/selftest.sh
```

The self-test sends one test item to the server, like one key press (`--offline` skips that). Then read the *Upgrade notes* of every release you skipped in [CHANGELOG.md](CHANGELOG.md): new settings, new files, what a reverse proxy or a daemon needs. The Releases block on the settings page shows the server's version and whether your daemon is older than the latest release. More on the server side: [docs/runbooks.md](docs/runbooks.md#update-procedure).

## League switch

`POE_LEAGUE` (default `Standard`) is the league every player starts on and the one league the background pricing (Currency Exchange, corpses) works for. A player can switch his own league in the browser; that choice holds until the server restarts, and his net worth in another league is valued without those two sources ([docs/admin.md](docs/admin.md#single-league-coupling-multi-user-pitfall)). At a new league, once it is live: stop the server, delete `config/networth-store.json` (the old league's stash snapshot), set `POE_LEAGUE=<LeagueId>` in `docker-compose.override.yml` and start it again; every player then starts on the new league. The commands, where to find the id, the data refresh and what to check afterwards are in [docs/runbooks.md](docs/runbooks.md#league-start-runbook) (steps 1 and 4), and so is what the switch leaves behind: the Currency Exchange and corpse prices are kept per league, never used for another, and fill for the new one by themselves, except a `corpse-store.json` written before the store recorded its league, whose entries the new league takes over, so delete it; the price brake's memory (`networth-history-guard.json`) starts empty by itself; the history (`networth-history.ndjson`, `networth-history-items.json`) records no league, so the chart shows the switch as a jump unless you delete both while the server is stopped; and a `POE_LEAGUE` saved in the admin area wins over the compose file, so change it there.

## Development

```bash
npm ci && npm --prefix renderer ci
node backend/v2/build.mjs                      # bundles the vendored APT engine
cd renderer && node src/assets/make-index-files.mjs && cd ..   # search indices
npm test
```

Both build steps are required before the first `npm test`: the engine bundle and the `.index.bin` search indices are generated artifacts and are not checked in. Node 22 or newer is required. The suite needs no network for the bulk of it. Its browser tests need Google Chrome: `google-chrome-stable` on the `PATH`, or the binary named in `CHROME_BIN` (CONTRIBUTING.md, "Tests"). The localized data set is a third generated artifact, and the only one that is also generated on a running deployment:

```bash
npm run gen-lang-data -- --lang de             # writes renderer/public/data/de/
npm run gen-lang-data -- --lang de --dry-run   # report only, writes nothing
```

It downloads GGG's game data for the current patch, derives the German item names and mod matchers from the English set already in the tree, and validates the result before writing anything. **The output is gitignored and never shipped**, so no one redistributes extracted game data. In a container the data refresher runs this by itself; the CLI is for the repo copy and as an emergency hatch. Repository layout, the module map and the conventions that apply when changing things: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Changing settings later

Two kinds of setting need no editor on the server and no redeploy. Both live on the settings page (`/settings.html`).

**Yours, no password:** your net-worth credentials and **your client language**. The language is the first thing on the page, above the sync credentials, because it is the one setting that can break the price check without saying a word: it is the language your **game client** runs in, not the language of the website (the pages follow it, but that is a side effect). Set it to something your game is not, and a copied item is not priced wrongly — it is not recognised at all: no card appears in the browser, and the game itself tells you nothing. Pick a language and the pages plus the item parsing follow immediately — every tab you have open included, no save button, no restart and no admin needed. The choice is stored per user in `/config/user-langs.json` and **wins over `POE_USER_LANGS`**: that variable is only the value you start on, so an edit to compose does not silently put you back. Only languages the server has actually loaded a parser for are offered; a language nobody has ever been configured for has no data set yet and needs `POE_LANG_DEFAULT` set once ([docs/admin.md](docs/admin.md#client-language-at-runtime)). On a server without a writable `/config` the page says so — the choice then holds until the next restart and no longer. The daemon's `item_prefixes` has to follow a switch (step 3 above).

**The operator's, behind the admin password:** a configuration section that writes a small file in the `/config` volume — display name, league, default language, listings per search, and the on/off switches for the background jobs. Every row names where its value comes from (this page / the compose file / built-in default), marks the ones shadowing a compose value, and can be put back with one **Reset**. Below it a read-only list of everything else this server runs with, so reading the configuration needs no SSH session. Nothing secret is settable or shown there — no POESESSID, no account name, no password.

Each setting says whether it takes effect *live* or needs a restart, and there is a **Restart** button for the latter. That button has a precondition, a restart policy, and it is the only action on the whole page that can make the page unreachable. With the shipped `docker-compose.yml` (`restart: unless-stopped`) the container stops and is back within a second. With Docker without a restart policy — your own compose file, a `docker run` without `--restart`, a different orchestrator — the container stops and **nothing starts it again**: the tool is off until you start it on the host, and the page you would have undone it from went down with it. From the browser this looks exactly like the first case, which is what makes it the dangerous one. Started by hand (`node backend/v2/server.mjs`), the process ends and starting it again is your job. The tool cannot tell them apart (Docker does not tell a container its own restart policy, and the socket that would is deliberately not mounted), so the confirmation dialog names the condition before anything happens, and if the server never answers again the page says what most likely went wrong and what to do about it, and still says it after a reload.

Before you go looking for a bug:

- **That file beats `docker-compose.override.yml`.** A setting changed in the browser is a deliberate, newer decision than the compose file the box started with, so it wins; the view names the source (`override` / `env` / `default`) of every setting.
- **A set of overrides that breaks the start is thrown out automatically — after the second failure in a row, not the first.** A marker written before they are applied and removed once the server is listening counts the starts that never got that far. Two in a row and the file is moved to `overrides.rejected.json`, with the container booting on its compose defaults. No restart loop, nothing lost, and a single interrupted boot (a restart typed at the wrong second, a host reboot, an out-of-memory kill) costs you nothing.
- **One `/config` volume belongs to one instance.** Two containers sharing one would count each other's boots and quarantine each other's settings.

Details: **[docs/admin.md → Configuration from the admin area](docs/admin.md#configuration-from-the-admin-area)**.

**Updating from the browser** needs a small script (`deploy/host-update.sh`) running on the machine that hosts Docker: a container cannot pull code and rebuild its own image, and handing it the Docker socket so that it could would mean handing it the host. Until that script is installed, the update block says so and its button stays disabled. The command line stays the normal way to update ([Updating](#updating)). Setup: **[docs/runbooks.md → Install the update script](docs/runbooks.md#install-the-update-script)**; the reasoning behind it: **[docs/admin.md → Update button](docs/admin.md#update-button-deployhost-updatesh)**.

## For admins

Architecture and server config: **[docs/admin.md](docs/admin.md)**. Example Unraid deployment (git-pull workflow) and every other procedure: **[docs/runbooks.md](docs/runbooks.md)**.

## Known issues

- **KDE/Klipper + images:** copying an image (e.g. a screenshot) stalls the clipboard read until you open the clipboard history once (Meta+V). It's a KDE clipboard bug, not the tool — normal item-checking is unaffected.
- **A brand-new unique isn't recognised:** the bundled item database is older than the patch that added it. The container fetches the upstream data itself once a day (first check about 2 minutes after a start), so the item is usually picked up without a redeploy. `npm run update-apt-data` only refreshes the checked-in copies; it is the emergency exit — see [docs/runbooks.md](docs/runbooks.md#league-start-runbook).
- **`Intangibility` / `Immaterialität` is never parsed** (observed 2026-08 on a German client; no test pins it). The vendored engine has no anchor for that property line in *any* language (`Intangib` appears zero times in its client strings), so it is dropped from the item in English and German alike.
- **Some stats have no German matcher.** Their English text has two different German phrasings in GGG's data, where picking one would be a guess — so the generator picks neither, and such a line stays read-only rather than being searched as something it might not be. New gaps are reported (admin area of the settings page, language block); the current count is shown there. A run is only refused when it loses more than 1 % of the stats the previous German set already covered (`POE_LANG_MAX_COVERAGE_LOSS_RATIO`, [docs/admin.md](docs/admin.md)).
- **German Heist blueprints from the Robot Tunnels are misread — a bug in GGG's own data** (observed 2026-08 on a German client; no test pins it). Three client-string ids share the English reward line "Replicas or Experimented Items"; for one of them (`HeistBlueprintRewardRobotTunnels`) GGG's German table gives the translation belonging to a *different* reward, "Dieb-Schmuckstücke oder Währung" (Thieves' Trinkets or Currency). The tool pins the correct German wording from the other two ids, so blueprints from the Robot Tunnels are not recognised as that reward type. Guessing around it would mean accepting one reward's wording for another's — worse than not recognising it.
- **A session balance does not see everything.** It does not see loot in your character's inventory: the tool reads stash tabs only and never asks for the inventory, so loot counts once it is in the stash and its tab has been read, and loot still in the inventory when the read after the end reaches that tab is not in the balance. Nor does it see trading and crafting, loot stashed during a session round into a tab not read yet, loot put into the sub-tabs already read of a **folder tab** (Unique/Map stash) whose walk began before the start or the end (the tab counts as read after it), or an arrival the price brake holds at no value. The full list: [docs/pricing-logic.md](docs/pricing-logic.md#what-a-farm-session-balance-means).
- **The admin view's gap list is memory-only.** A restart or a container update empties it. That is deliberate — a gap that matters recurs the next time that item is checked — but it means the list is not a record you can go back to.
- **The patch lookup has a single point of failure.** The language generator gets the current patch version from `ggpk.exposed`. If that service is down and `POE_PATCH_VERSION` is not set, the language source reports `failed` on every check — even when the data set it already has is perfectly current. It has happened once (2026-08-13 to 2026-08-17, [`docs/bugs.md`](docs/bugs.md) B22), and not because the service failed: it answered correctly and the tool refused the answer. English keeps updating throughout, so the outward sign is the `lang-data` line in the log and, after three days, the staleness note in the browser — which carries the reason and says whether it is something to wait out or something to fix ([`docs/bugs.md`](docs/bugs.md) B24). `POE_PATCH_VERSION` is settable from the admin area, so the repair needs no shell on the server.
- **A divination card nobody is buying can be valued far too high.** Where the in-game Currency Exchange has no bid for an item, the tool still prices it from the last trades that filled, and that was measured at 30–70× the real selling price for two cards (2026-08-13), while cards with a bid landed at 0.9–1.4×. Neither GGG's exchange feed nor poe.ninja publishes bids, so from here a dead market and a rare one look the same, and the tool does not unprice either on a guess. Instead the Net-Worth table marks prices with little trading behind them as *thin market* in its Confidence column, and the total says how much of it rests on uncertain prices. Check those rows in game before you sell. Cards are where this is common, but every stackable priced from the exchange can hit it. Details: [`docs/bugs.md`](docs/bugs.md) B20.

**Not verified yet**, and stated here rather than left to be discovered:

- The corpus of real, collected German item texts is **ten items** ([`backend/v2/corpus/`](backend/v2/corpus/README.md)), and all ten are unpaired. They are checked in, and every `npm test` parses them against the generated German data set — with that data set present, all ten parse; on a fresh clone these tests are skipped until `npm run gen-lang-data -- --lang de` has been run. None of them has been collected on an English client, so the parity check (same `refName`, same recognised stats, same trade query in both languages) still has nothing to compare, and no category on the corpus checklist counts as covered; `corpus-parity.test.mjs` prints what is still missing on every run. **The two questions that could have shipped a silent bug are answered** by the German texts alone. Socket letters are language-independent — three different combinations show it (`G-R-B-B-W W`, `B-B-B-R`, `B-B-R-W`). Decimals use a **point**, not a comma (`0.2 Sekunden`), so the value regexes are right; that one rests on a single observation, in an enchant line, and no comma-decimal appears anywhere in the corpus — a second, plainer fractional roll would make it airtight.
- The Bazzite install path has not been walked through on real hardware, and there was deliberately no VM rehearsal either. Verified instead: the tools are in the image or reachable through Homebrew, `evdev-binary` really does install as `import evdev`, and `ujust add-user-to-input-group add` exists. Open is the `ydotool` user unit on Fedora — that one fails **loudly**, and it only affects the chat macros. The silent failure mode (Homebrew on the shell's `PATH` but not the service manager's) is a self-test check.
- The notification in the game was tested with a stand-in for `notify-send`, not on a screen: whether a notification sent by the daemon *service* really appears (the service needs the session bus), and how it looks over the game in borderless and in exclusive fullscreen, has not been watched yet. If none appears, `journalctl --user -u poe-price-daemon -n 50` names the cause, and the self-test's section 9 checks the session bus.
- The overlay was tested on Qt's offscreen platform, not over a running game. Not tried yet: whether its card lies above the game in borderless and in exclusive fullscreen, with fractional display scaling, and on several monitors with different scaling; whether the card hides when the mouse moves over a native Wayland window (the overlay sees the pointer through XWayland; the card then still goes after `item_hold_s` or `pending_hold_s`, and when the game loses focus); whether a daemon started at login before XWayland is up gets its overlay at a later item (after `no-display` it tries again at the next item, at the earliest after 10 minutes); and gamescope, which gives the game an X server of its own. If the test card of `./daemon/selftest.sh --overlay` does not appear over the game, set `overlay = "off"`; the notification then carries the result.
- Buyer whispers were tested against a log file in a temp directory and a stand-in server, not with a running game. Only English whispers have been seen in a real log: the German, French, Russian, Spanish and Portuguese templates and incoming markers are from SlimTrade's patterns, not seen in a real log, and a German gem wording is not read at all (`./daemon/selftest.sh` counts the markers your log really has). SlimTrade has the markers in lower case and compares without regard to case; the daemon compares exactly, so the capital first letter of `@Von`, `@De` and `@От кого` (and of the outgoing markers the self-test knows) is assumed, after the English `@From`. Not tried yet either: whether a `Client.txt` in a Proton prefix or on a Windows drive keeps its inode while it grows (if not, the journal says `… was replaced, reading the new file`, at most once in 10 minutes; a whisper in a file over 1 MB that was replaced is missed, because a replaced large file is read from its end, until the inode has changed 5 times within a minute: then the journal says `… keeps getting a new inode` and the file is read on from the same position as one file); where the whisper stack lies on several monitors and with display scaling; and whether Plasma keeps whisper notifications in its history although they are sent as transient (the notification shows the pseudonym, not the name, either way). For a single whisper for something that stacks, it is open whether GGG's "listed for" means one unit or the whole stack, so both readings are shown; a stack size in front of the item name (`20 Orb of Alchemy`) has not been seen in a real whisper, and the size from the sync was tried only with stored rows, not with a real stash. Not checked either: whether the trade site's left/top are GGG's cell x/y plus 1, which the tool assumes, also in a special tab (Currency, Fragment and the like); if not, a whisper for an item in such a tab never gets a stack size from the sync.
- The stash cell frame was tested with stand-ins (a fixed window size, Qt's offscreen platform), not over a running game. Not tried yet: whether SlimTrade's grid fractions put the frame on the right cell of Path of Exile 1 at your resolution, with stash tab folders, in windowed mode and with display scaling; whether `xdotool getwindowfocus getwindowgeometry` gives the game window's position in the same screen pixels the overlay draws in under XWayland; whether the frame lies above the game in exclusive fullscreen; and whether the tab type the stash API gives a quad tab is `QuadStash`, which the tool reads as quad (a left or top above 12 makes a tab quad either way). `./daemon/selftest.sh --overlay` shows where cell 1,1 lands; `[stash_grid] mode = "manual"` places the grid by hand.
- The session key and the session cards were tested with stand-in key events, a stand-in server and Qt's offscreen platform, not with a running game. Not tried yet: a press in a running game (read through evdev like the chat macro keys), the session card over the game, and a whole farm session against a real stash, from the press to the final balance.
- Game sessions, and the sync reading every tab once after a session's start or end, were tested with a stand-in daemon and a stand-in sync, not with a running game and a real stash. Not tried yet: the start and end from game detection, the 10-minute gap across a real game restart or crash, the split of two evenings after the PC was shut down with the game running, and how well the minutes on the cards (*about N min*) match the reads of a real stash.
- The History page's session list (both kinds, farm sessions under their game evening, the states, the baseline at start, the game session's Discard) was tested with stored sessions in a browser against the server, not with sessions from a real stash and a running game.
- **Listed below market** was tested with stored price notes, not with a real stash: no stash response recorded here carries a price note, so it is not yet seen that GGG's stash answer gives a priced item its `note`, nor how a price set for a whole tab arrives (the tool reads a tab whose name is a price note, such as `~price 1 chaos`, as the price of every item in it without its own). Whether GGG means a note on a stack per unit or per stack is open as well; the tool reads it per unit, which never lists a stack that is not below the market under both readings.
- Game detection was tested with a stand-in for `xdotool`, not with a running game. Not tried yet: whether `xdotool search --class` finds the window of Path of Exile under Proton on XWayland by `poe_window_class` (the same key the chat macros' focus check uses), and gamescope, which gives the game an X server of its own. Run `./daemon/selftest.sh` with the game running: section 12 says `game window found`; after the game is closed, `no game window`. If it never finds the window, the daemon reports "unknown (never-seen)" and your sync keeps its normal pace — no harm, only no saving.
- The second player's side of the install — another machine, another person, a daemon talking to a backend somebody else runs — has not happened yet. Everything the German path does has been exercised by one person on one machine.

## Reporting problems

Report bugs at <https://github.com/BriskWatchdogz1/poe-price-tool/issues>; the bug report form asks for the versions (Settings page, block "Releases"), the output of `./daemon/selftest.sh`, the daemon's journal, the server log and, for one item, the item text (copy it with Ctrl+Alt+C). Never paste your POESESSID, your account name or `Client.txt` lines with names. Security problems do not belong in a public issue; report them as described in [SECURITY.md](SECURITY.md). Pull requests are welcome for bug fixes and small additions; [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests) says which ones are taken.

## Credits

Item parsing and trade integration come from [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade) (MIT license, © Alexander Drozdov) and run here headless. See [LICENSE](LICENSE). What `renderer/` changes against the upstream tree it was taken from:

- one later upstream fix applied (commit `7d53dea5`, item names read from the translated column; `Parser.ts`, `magic-name.ts`);
- `make-index-files.mjs` builds search indices for English and German only;
- the Russian, Korean and Chinese data sets, fonts and images are removed, and `patrons.json` is empty;
- `renderer/public/data/de/client_strings.js` is added, written by hand; the rest of the German data set is generated per installation and not checked in.

The browser-only modules (Vue, the request module, the config) are replaced at build time by the shims in `backend/v2/shims/`; the files themselves stay unchanged.

The buyer-whisper patterns in German, French, Russian, Spanish and Portuguese in `backend/v2/whisper.mjs` and the daemon's incoming markers and template beginnings for those languages are adapted from the patterns of [SlimTrade](https://github.com/zmilla93/SlimTrade) (MIT license, © 2020 zmilla93), and the stash cell frame's grid (`daemon/ppt_stash_grid.py`: where the stash lies in the game window, the cell size, the quad-tab rule) follows SlimTrade's; its copyright and permission notice is in the head comment of `backend/v2/whisper.mjs`.

**This is AI-written code, and that is not hidden here.** The backend, the browser UI, the hotkey daemon, the tests and this documentation were written by Claude (Anthropic), working from my requirements, my bug reports and my judgement about what the tool should do — I specified, tested and decided; Claude wrote. Every design decision, every measurement quoted in the docs and every fix went through that loop. If that is a dealbreaker for you, you know it before you clone rather than after.

Price data comes from [poe.ninja](https://poe.ninja) (cached for at least 15 minutes, as their usage policy asks), from GGG's public Currency Exchange digest, and from the official [PoE Trade API](https://www.pathofexile.com/trade). Item and stat data derives from [RePoE](https://github.com/lvlvllvlvllvlvl/RePoE): `backend/v2/networth/base-names.json` is derived from it, and `renderer/public/data/en/` comes from the Awakened PoE Trade repository (MIT).

This is an unofficial fan-made tool. It is not affiliated with, endorsed by, or sponsored by Grinding Gear Games. Path of Exile is a trademark of Grinding Gear Games. Use it for your own account at your own risk.
