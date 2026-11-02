# poe-price-tool

> One-key item prices for **Path of Exile 1** — straight from the game into your browser.

Hover an item, press your key, see the price. No manual copy-paste, and no hunting for the right modifiers on the official trade site. A small, self-hosted setup: a Docker backend plus a hotkey daemon on your machine — the result shows up in a browser tab you keep open (a second monitor helps, otherwise you still alt-tab to look at it).

I run an Unraid server at home for several PoE players on Linux desktops. Awakened PoE Trade never ran well for me there — and broke on about every other update — so this is my kind-of-fork: its parsing engine, headless, behind a server everyone in the house can reach. None of this would exist without APT: years of work went into parsing PoE's item text and talking to the trade API correctly, and that part is theirs, kept as-is. Credit and thanks to [SnosMe](https://github.com/SnosMe/awakened-poe-trade) — go use the original if you are on Windows.

**Built and tested on exactly one setup:** Garuda Linux (Arch-based) with KDE Plasma 6 on Wayland, Path of Exile via Proton Experimental under XWayland, backend in Docker on Unraid. The backend is plain Docker and should run anywhere; the hotkey daemon leans on that specific stack (clipboard under XWayland, window focus, the `input` group). On another distro or desktop the pieces exist too, but nobody has tried it — see [the note above the prerequisites](#setting-up-the-hotkey).

## Features

- **One-key price check** — hover an item in-game → press a key → the recognized item appears in the browser with current trade prices (range plus a median, so one outlier listing can't make a worthless item look valuable). Toggle mods on and off to refine the search.
  - **Linked sockets** are filtered by default, capped at the item's own largest link group.
  - **Weapon DPS split** (Elemental/Physical) is shown alongside Total DPS — a 205 all-elemental weapon prices nothing like a 205 all-physical one.
  - **Corrupted items default to a corrupted-only search** — corruption puts an item in a separate market from its cheap non-corrupted twins.
  - **One click opens the same search on the official trade site** — with exactly the mods you have selected. The link carries the query id the trade API just returned, so it is the search the tool ran, not a rebuilt approximation: tick a mod, hit *Trade*, and refine it further over there.
  - **Quality and item level** on white bases are shown as read-only chips, since the engine already filters by them.
  - **Mods the tool can't recognize** (e.g. an obscure corruption implicit) are resolved against GGG's own stat catalogue and searched where possible; anything still unresolved is shown read-only instead of silently vanishing. The extended copy form writes the roll together with its range (`+310(260-320) to Armour`); the range comes off for the lookup and becomes the row's slider, so the roll is still what the search filters on.
  - **Rate-limit safe** — if the shared trade queue hits a real GGG ban, an amber banner shows a live countdown and search is paused rather than firing more requests into the ban.
- **Market reference always in view** — live Chaos:Divine plus a rail of prices with mini histories. The current selection (Currency, Harvest Lifeforce, Einhar Beasts) is what *I* trade and watch; it is hardcoded in `backend/v2/server.mjs`, so a fork that cares about other things will want to change it.
- **Net-worth tracker** — read your whole stash (needs your POESESSID, see below) and get a total in Chaos and Divine, broken down per tab and category — no tab limits, unique stash included. Priced from the official GGG Currency Exchange (Faustus), poe.ninja, and the Trade API (itemised corpses) — how each category is valued: **[docs/pricing-logic.md](docs/pricing-logic.md)**. Server-side setup: **[docs/admin.md](docs/admin.md)**.
- **For multiple players** — one shared backend with a shared trade queue, separate rooms per user.
- **English or German client, in the same backend** — the language is a per-user setting each player switches **in the browser** (settings page, takes effect immediately, no restart and no admin needed); `POE_USER_LANGS` on the server is only the value he starts on. So one player can run a German client and another an English one without either of them noticing. A German player gets German item parsing *and* a German browser UI. The German data set is **not shipped**: every installation generates it from its own copy of GGG's game data, so nobody redistributes extracted game files. The net-worth tracker is unaffected by any of this — **GGG's stash API answers in English regardless of language settings** (measured, see [docs/admin.md](docs/admin.md#stash-api-language)), and the names it displays are translated on the way to the screen: a row keeps its English name for the value join, the trade link and every price lookup, and a name the generated data set has no entry for stays English rather than turning into a placeholder. Stash Highlight follows the same rule from its own side: the regex it builds is not display text but a string the **game** matches, so it is generated in the language the client runs in — names and the exclusion universe together, never half of each. That rests on the assumption that the game matches the regex against the displayed names; it is not yet confirmed in a German client ([`docs/bugs.md`](docs/bugs.md), B10). Setup and limits: **[docs/admin.md](docs/admin.md)**, open defects: **[docs/bugs.md](docs/bugs.md)**, and [Known issues](#known-issues) below.

## What it looks like

![Price Check page: a Watcher's Eye priced at 11–50 divine with a median of 32.5 across 24 trade listings, its modifier picker expanded so each unique modifier can be ticked on or off and its roll range narrowed with a slider; a rare body armour card beside it, and a left rail with the live Chaos:Divine ratio and poe.ninja reference prices.](docs/screenshots/price-check.png)

*Price Check — the item arrives from the hotkey, the mod picker decides what the trade search asks for.*

![Net Worth page: a total of 1,242.9 divine, a category overview splitting it into Currency & Stackables, Uniques, Divination Cards, Gems and Beasts, and a grouped table listing every item with tab, quantity, unit price and total.](docs/screenshots/net-worth.png)

*Net Worth — the whole stash valued, grouped by category, per tab and per item.*

![History page: a 24-hour net-worth curve rising in steps from about 1,179 to 1,243 divine, next to a "What moved" list naming the items behind each step with quantity and value change.](docs/screenshots/history.png)

*History — the curve over time, plus what actually moved in and out behind each step.*

## What is a POESESSID, and do I have to hand it over?

Only the net-worth tracker needs one — the price check works without any login.

`POESESSID` is the session cookie your browser gets when you log in at
pathofexile.com. It is what proves to GGG's servers that a request is *you*, so
it is worth treating like a password: whoever has it can act as your account on
the website for as long as it stays valid, including reading your stash. GGG has
no read-only variant, and their OAuth programme is closed to new developers, so
this cookie is the only way any third-party tool can see your stash at all —
that is a limitation of the platform, not a design choice here.

What this project does with it: it is stored in `/config/networth-users.json`
with `chmod 600`, it is used only to fetch your own stash tabs, and it is never
sent back to the browser, never logged and never included in any API response —
not even masked.

**Where it goes:** to `pathofexile.com` and nowhere else. The cookie is attached
in exactly one module in the code (`backend/v2/networth/stash-client.mjs`), on
the stash requests to GGG. The backend also talks to poe.ninja, GGG's
`web.poecdn.com` (the Currency Exchange feed), RePoE (item data, fetched from `repoe-fork.github.io`) and
`raw.githubusercontent.com` (the APT data auto-update, and RePoE's fallback
host) and `api.github.com` (the once-a-day release check, see below) — none of
those ever see it. An installation that serves a language other
than English adds two more, both only for the language generator: `ggpk.exposed`
(one line, the current patch version) and `patch.poecdn.com` (GGG's own game
data for that patch). There is no telemetry, no analytics, no phone-home: the
whole thing runs on your own machine or your own LAN, and the only reason it
reaches the internet at all is to ask those hosts for prices, game data and the
newest release. You
can paste it in the browser UI or drop it in the file yourself.

**It expires more often than you would expect.** Any fresh login invalidates the
old cookie — not just logging in on pathofexile.com, but also authorising a
third-party site through your PoE account (Filterblade and friends). So the
tracker stopping is usually not a bug: something re-authenticated somewhere and
your old POESESSID died with it. The tracker says so, pauses that user, and
picks up again once you paste the new value.

If you suspect the cookie has leaked, log in again on pathofexile.com (that
invalidates the old value) and check `/config/networth-users.json` and, if you pass `POE_SESSID` in the compose environment, that file too.

If that trade is not one you want to make: leave it out. Everything except the
net-worth page works without it.

## What it does in the background

Once running, the backend keeps working without a tab open: it syncs one stash
tab about every 30 seconds — that is the total rate, shared out round-robin
across the configured users rather than one stream each — and prices itemised corpses
at up to 25 trade-API requests per hour. Both go out over **your** IP —
the same one you browse pathofexile.com/trade with, and they count against the
same rate limit. Both can be switched off (`POE_NETWORTH_AUTOSYNC=0`,
`POE_CORPSE_DISABLED=1`, see [docs/admin.md](docs/admin.md)).

It also keeps its data current on its own, without touching the trade API:

- the **Faustus refresher** reads GGG's Currency Exchange digest from its CDN
  once an hour (`POE_FAUSTUS_DISABLED=1` turns it off);
- **poe.ninja** is asked for the Chaos:Divine ratio and reference prices at most
  every 15 minutes;
- the **daily data check** compares the bundled item and stat data with the
  Awakened PoE Trade upstream and RePoE, and, for a non-English client,
  regenerates the localized data set (`POE_DATA_REFRESH_DISABLED=1` turns it
  off).

Once a day the backend also asks `api.github.com` for the latest release of
this tool, so the pages can say when a newer one is out (a line on every page
and the Releases block on the settings page). The request body and headers carry nothing
but the installed version, inside the User-Agent (`poe-price-tool/<version>`), and the
ETag of the last answer; GitHub sees your IP address, as with any request. The check only reports — nothing is downloaded or installed. The state is kept
in `/config`, so a restart does not ask again the same day. Turn the automatic
check off with `POE_RELEASE_CHECK_DISABLED=1` or with the switch in the admin
area of the settings page; the **Check for updates** button there still works
when it is off. See [docs/admin.md](docs/admin.md#settings-page--admin-area-settingshtml).

Requests to the trade API also send a browser-like User-Agent. That is what the
vendored Awakened PoE Trade engine does; it is stated here so you know what runs
under your address.

## How it works

Two parts:

- a **backend** (Docker) that does the pricing and serves the web UI, and
- a small **hotkey daemon** that runs on each gaming desktop: it copies the hovered item and sends it to the backend.

The backend can run on the **same PC you game on**, or **centrally on a home server** for several players. That's the only real choice — pick an install path below.

## Before you install: no authentication

The backend has **no login of any kind**. It binds to every interface, and the
only "identity" is a cookie you set yourself in the browser — so anyone who can
reach the port can read your account name, spend your trade-API rate limit, and
overwrite the stored POESESSID (which is a full session token for your PoE
account).

**Run it on a trusted LAN only, and never expose the port to the internet.** If
you put it behind a reverse proxy, put authentication in front of it.

The settings page has an **admin area** behind a password, but that is a
partition, not a security boundary. It is created with the default password
`admin` on first boot — a password printed in this repository for everyone to
read — and it now guards more than a diagnostic view: the **restart button** and
the **server settings the next start reads** hang on the same password. Change
it (`/config/admin-password`) before this tool is reachable from anywhere but
your home network; see [docs/admin.md](docs/admin.md#the-admin-password). While
the default is still in force, the tool says so at every start (container log)
and in the admin area itself. It does not force a change: on a LAN tool, locking
you out of your own box is the worse failure.

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

**If a player runs a non-English PoE client, say so here too.** The client
language is a per-user server setting, and it decides which parser and which UI
language that player gets:

```yaml
      - POE_USERS=alice,bob
      - POE_USER_LANGS=bob:de       # bob plays a German client; alice stays English
```

With that line, `/users` reports `"langs":{"alice":"en","bob":"de"}`.

Everyone not listed uses `POE_LANG_DEFAULT` (`en`). Supported today: `en`, `de`.
A typo — unknown user, unsupported language, malformed pair — **stops the
startup on purpose**, because the wrong language does not fail by itself: it
returns a plausible, wrongly parsed item. The German data set is generated by
the container itself, in the background, from GGG's game data — it is not part
of the image. Until it exists, that player's price checks are **refused** (HTTP
503, one warning line in the log, one row in the admin view) instead of being
parsed as English; the first successful generation run fixes it without a
redeploy. Details: [docs/admin.md](docs/admin.md#data-auto-update-background).

> **Expect a scary-looking start the first time.** Switching a language on does
> not make it work that second: the snapshot the container is already running
> was written before the language existed, so the log greets you with
> `MISSING=[de]` and a `Cannot find module … /data/de/client_strings.js`. That
> is the refusal doing its job, not a broken install — **wait for the first data
> check (120 s after boot)**, which generates the set and reloads both parsers.
> The startup line then reads `parsers=[en, de]`. Only if it still says
> `MISSING=[de]` minutes later is something actually wrong.

Put it behind a reverse proxy with **websockets enabled**.

Full server walkthrough — reverse proxy, `/config` permissions, all env vars: **[docs/admin.md](docs/admin.md)**.

**On each gaming desktop** — you only need the tiny hotkey daemon, nothing else from the repo (no backend, no Dockerfile). Check out **only** the `daemon/` folder:

```bash
git clone --filter=blob:none --no-checkout https://github.com/BriskWatchdogz1/poe-price-tool.git
cd poe-price-tool
git sparse-checkout set --no-cone daemon
git checkout
```

This leaves you with just `daemon/` — nothing the client doesn't use. Then set up the hotkey ([see below](#setting-up-the-hotkey)) with `backend_url = https://your-server`.

## Setting up the hotkey

> Run the commands below from **inside** the `poe-price-tool/` folder you cloned above. (`cd poe-price-tool` only works from its parent — if you're already inside the repo, you're set.)

A small daemon watches your **clipboard** and prices whatever PoE item lands in it. The price check only reads the clipboard: it injects no key presses and does not touch your input. You bind your own key to PoE's own copy shortcut (Ctrl+Alt+C); the daemon just reacts to what you copy.

The optional [chat macros](#chat-macros-optional) are a separate part of the same daemon, and **they are active in the default config** that `install.sh` copies: with them, the daemon reads the keyboards that carry a macro key via evdev to see the macro keys (F5–F9) and types chat commands through `ydotool`. To run the price check alone, delete the `[macros]` and `[macros.keys]` blocks from `config.toml`; the daemon then opens no input device.

> **Everything in this section assumes the tested stack** (see the top of this
> file): Arch-based, KDE on Wayland, PoE under XWayland. On another distribution
> the package names differ (`apt`, `dnf`, …) but the tools are the same. On X11
> instead of Wayland the macros still use `ydotool`; only the clipboard and
> focus tools differ. Not tried. On GNOME or another desktop the "custom shortcut" step lives elsewhere
> in the settings. None of that has been tried, so treat the specifics as a
> starting point rather than as verified.

**1. Prerequisites** (Arch/Garuda — adapt the package manager for your distro):

```bash
sudo pacman -S ydotool wl-clipboard xsel xdotool xorg-xprop python-evdev curl
sudo usermod -aG input $USER      # only for the chat macros; then log out and back in once
```

Python 3.11 or newer is required (the daemon reads its config with `tomllib`).

> **On an immutable distribution (Bazzite, Silverblue, Kinoite): do not layer.**
> `rpm-ostree install` can leave a system that will not update or auto-login,
> and none of it is necessary here — everything the daemon needs is reachable
> without touching `/usr`:
>
> | need | how |
> |---|---|
> | `xdotool`, `ydotool` | already in the Bazzite image — check with `rpm -q`, do not install |
> | `xsel`, `xprop` | `brew install xsel xprop` (Homebrew is preinstalled, prebuilt bottles, no compiler) |
> | python `evdev` | `python3 -m pip install --user --break-system-packages evdev-binary` |
> | group `input` | `ujust add-user-to-input-group add`, then log out and back in |
>
> Two things are easy to get wrong there, and both were found before anyone
> stood at such a machine:
>
> - **`evdev-binary` is the right package**, not `python-evdev` — the latter is
>   source-only on PyPI and wants a compiler. It installs as `import evdev`, so
>   nothing in the daemon changes. The `--break-system-packages` flag is what
>   PEP 668 demands on Fedora-family systems; it still only writes to
>   `~/.local`, so it is not layering.
> - **Homebrew is on your login shell's `PATH`, not on the service manager's.**
>   The daemon runs under systemd, so it can be missing `xsel` while your
>   terminal finds it — and a missing `xsel` is a *silent* fallback to
>   `wl-paste`, which does not reliably see XWayland copies. The self-test asks
>   the service manager directly and says so if the two disagree; that line has
>   to be green, not just the tool line above it.
>
> Not verified: whether the Fedora `ydotool` package ships a user unit named
> `ydotool.service`. If `systemctl --user enable --now ydotool` says "unit not
> found", write one — `ydotoold` only needs access to `/dev/uinput`. This
> affects the [chat macros](#chat-macros-optional) only; the price check does
> not use ydotool.

(`ydotool`/`xdotool`/`xorg-xprop` are only needed for the optional [chat macros](#chat-macros-optional) below — but the shipped example config has `[macros]` switched on, so on the first run `install.sh` demands them. To install without macros, create `~/.config/poe-price-daemon/config.toml` yourself first, without `[macros]` (copy `daemon/config.example.toml` and delete the `[macros]` and `[macros.keys]` blocks); the installer then leaves it untouched and does not ask for the macro tools. `python-evdev` is imported unconditionally by the daemon, so it is required even if you never configure macros — the daemon will not start without it. The price check itself only needs `xsel` + `curl` at runtime — the daemon reads the clipboard via `xsel -b -o` first, since PoE runs under XWayland, and only falls back to `wl-clipboard`'s `wl-paste` if `xsel`/`DISPLAY` are unavailable. Installing all of it up front keeps this simple.)

**2. Install** — set up the daemon as a systemd user service:

```bash
./daemon/install.sh
```

The script writes the unit `~/.config/systemd/user/poe-price-daemon.service` (under `$XDG_CONFIG_HOME` if set), which points at **this checkout** — if you move or re-clone the folder, run `./daemon/install.sh` again. To uninstall: `systemctl --user disable --now poe-price-daemon`, then delete that unit file and `~/.config/poe-price-daemon/`.

As a side effect, the script also enables and starts the `ydotool` user service (`systemctl --user enable --now ydotool`) — it is what the optional chat macros use to type; harmless to leave running if you never configure macros.

The installer ends with a **self-test** ([what it checks](#daemon-troubleshooting)) — so a fresh install is proven, not assumed. On a first run it will still report the backend as unreachable, because step 3 below is where you point it at your backend; run `./daemon/selftest.sh` again after that.

**3. Configure — you must edit this.** `install.sh` already placed a config at `~/.config/poe-price-daemon/config.toml` (a copy of the example, with placeholder defaults). Note this is in your home directory — **not in the repo**: the repo only carries the `daemon/config.example.toml` template, while your live config lives outside it so `git pull` never overwrites your settings. **Open it and adjust it** — with the defaults it points at `127.0.0.1`, so for a server (Option B) it won't reach your backend until you change `backend_url`:

```toml
user = "player1"                        # must match a name in the server's POE_USERS (Option B step above)
backend_url = "http://127.0.0.1:8788"   # Option A (local); for a server use https://your-server
item_prefixes = ["Item Class: "]        # how a copied item starts — IN YOUR CLIENT'S LANGUAGE (see below)
poe_window_class = "steam_app_238960"   # PoE detection, used by the chat macros — leave as-is for PoE1 on Steam
```

> **`item_prefixes` is not optional on a non-English client.** The game writes
> the item-class line in the *client's* language, and the daemon posts only
> clipboard contents that start with one of these strings — everything else is
> dropped without a word, which is exactly what you want for every other Ctrl+C
> in the game. The default is the English `"Item Class: "`, so on a German
> client the daemon would silently discard **every** item:
>
> ```toml
> item_prefixes = ["Gegenstandsklasse: "]              # German client
> item_prefixes = ["Item Class: ", "Gegenstandsklasse: "]  # both, if you switch
> ```
>
> **Edit the line in place — do not append it to the end of the file.** In TOML
> a key belongs to the last section header above it, and this config ends with
> `[macros]` / `[macros.keys]`. A key appended at the bottom therefore becomes a
> *macro*, not a top-level setting: the daemon never sees it, falls back to the
> English default, and keeps discarding every item. It is a silent failure, and
> the daemon starts up perfectly happy. `daemon/selftest.sh` catches it — it
> reads the file the same way the daemon does, so a misplaced key shows up as
> `item_prefixes not set` even though the line is visibly there.
>
> Listing several costs nothing. The symptom of getting this wrong is the tool
> doing nothing at all, with no error anywhere — so if you switch client
> language later, this is the line to change. It has to match the server's
> `POE_USER_LANGS` for that user, but the two are separate settings: the daemon
> decides what to *send*, the server decides how to *read* it.

The daemon has no key binding of its own: it reacts to whatever lands in your clipboard, so the key is bound in the game (step 4). The file holds the rest — chat macros, ydotool socket — each with an inline comment. After editing, apply it:

```bash
systemctl --user restart poe-price-daemon
```

> **Behind a reverse proxy / HTTPS (Option B):** if `backend_url` points at an address the proxy forces onto HTTPS (http → 301 to https), **always write `https://`**. The POST deliberately does not follow redirects — with `http://` it receives the 301, does not follow it, and returns without ever reaching the backend. No error, no price, no log entry.

**4. Bind your key, in-game** (one-time): PoE keybind **"Advanced Mod Descriptions" = Alt** — that is the half of `Ctrl+Alt+C` that makes the game write the tier and range information the parser needs; with the plain `Ctrl+C` form no mod section is read at all. Then bind a key of your choice to PoE's **copy item** action (Ctrl+Alt+C) — either directly in the game's keybind settings, as a **KDE Custom Shortcut** of type *Command/URL* running `xdotool key ctrl+alt+c` (KDE has no built-in "send another key combo" action), or in the software of a programmable input device if you use one. Hover an item, press your key → the item appears in the browser automatically, no further action needed.

> **The client language no longer has to be English.** It used to: the parser
> read English item text and nothing else. Now the language is a per-user
> setting on the server — each player switches it himself on the settings page,
> and `POE_USER_LANGS` (see [Option B](#install--option-b-central-server-for-several-players)
> above; on a single-PC install it goes in the same
> `docker-compose.override.yml`) only decides what he starts on. The daemon is
> told separately what a copied item looks like in that language
> (`item_prefixes`, step 3).
> Set both to the language your client actually runs in and leave it there —
> neither is guessed per item, and the daemon's half is read at startup (switch
> the language in the browser, and `item_prefixes` has to follow). Supported today: English and
> German. And it does not matter whether you hold Alt while copying: the Alt
> effect is an in-game *display* thing, the clipboard text stays in the client
> language either way.

> **Why a daemon at all?** The clipboard has no "something was copied" signal a script could wait for, so something has to watch it. That is all the daemon does: it polls a few times a second, and when a PoE item shows up it POSTs it to the backend (`daemon/poe-price-post.sh`). It has to keep running for that. The chat macros are optional — delete the `[macros]` and `[macros.keys]` blocks from `config.toml` and it only watches the clipboard.
>
> **What it reacts to, and what it ignores.** The two halves behave differently:
> - **Chat macros** only fire while Path of Exile has focus (checked via `xdotool`/`xprop` against `poe_window_class`). Your macro keys stay inert in every other window — pressing them in a browser does nothing.
> - **The price check does not check focus.** It watches the clipboard regardless of which window is active, and what filters it is the *content*: anything that does not start with one of your configured `item_prefixes` (default `Item Class: `) is dropped. So copying normal text anywhere changes nothing — but copying a PoE item text from Discord or a wiki page **will** price it. That is deliberate: PoE runs under XWayland and its copies land in the X11 clipboard, which the daemon reads directly to sidestep a flaky clipboard bridge; adding a focus check would mean another `xdotool` call several times a second.

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

Only letters (a–z), digits, spaces and `/ - _` are typed; any other character in a macro is skipped.

Set `keyboard_layout` to match your in-game client keyboard layout — chat commands are typed via kernel-level key injection, which KWin then interprets according to the active layout, so it has to match to produce the right characters. Remove both blocks, `[macros]` and `[macros.keys]`, entirely to disable macros — the daemon then runs price-check only.

The daemon itself lives in `daemon/` in this repo, and every setting — backend, user, window class, macros — is in `config.toml` / [`daemon/config.example.toml`](daemon/config.example.toml): fully customizable, nothing hardcoded.

### Daemon troubleshooting

**Start here — run the self-test:**

```bash
./daemon/selftest.sh
```

It is the same check `install.sh` runs, and it is meant to be run again months
later by whoever has to fix the machine. It reads your `config.toml` — nothing
about your installation is baked into it — and then reports, in plain words,
on: the tools the daemon needs, clipboard access, the `input` group,
`ydotoold`, the daemon service, the backend, and finally a **real test parse**.
That last step sends a sample item, in the language your backend reads for your
user, through the actual filter (`daemon/poe-price-post.sh`) and on to the
backend.

The test parse is why this is worth running before anything else. Its filter
half is local and touches no network at all, so the two causes that look
identical from the outside — "nothing reaches the backend" — are told apart:

- **dropped by the filter** → `item_prefixes` doesn't match your client
  language. The backend is never contacted and nothing is logged anywhere; this
  is the failure that otherwise looks like a dead installation.
- **passed the filter, backend refused** → the answer is classified: unknown
  user (400), a configured language with no data set (503), or a genuine parse
  failure (400).

It changes nothing — no install, no config edit, no service enabled; where it
knows a fix it prints the command instead of running it. The one thing it does
do is POST **one** item to your backend, exactly like a single hotkey press
(one card in the browser, one trade search); `--offline` skips that half. With
no `[macros]` section in your config, the macro tools (`ydotool`, `xdotool`,
`xprop`) and the `input` group are reported as *not applicable* rather than
missing. And it runs on a machine where nothing is installed yet — that is the
state you diagnose from.

If you'd rather read the table, or want the daemon's own view:
`journalctl --user -u poe-price-daemon -f`

| Symptom | Likely cause / fix |
|---|---|
| Nothing happens on copy, no errors in the log | Wrong `backend_url` in `config.toml` — verify it's reachable (`curl <backend_url>/health` → `ok`). |
| The POST returns immediately, but no price appears and the backend log stays silent | `backend_url` is `http://` but the reverse proxy 301-redirects to `https://`. The daemon deliberately doesn't follow redirects, so curl accepts the 301 and stops there. Use `https://` in `config.toml` (see the note in step 3 above). |
| Chat macros don't fire | You're not in the `input` group (evdev needs `/dev/input/event*` access) — `sudo usermod -aG input $USER`, then log out and back in. |
| Price check works, but only when the game window has focus in an unusual way / feels less reliable than expected | `xsel` isn't installed, so the daemon fell back to `wl-paste`, which doesn't reliably see XWayland (PoE) clipboard changes — install `xsel` (see prerequisites above) and restart the daemon. |
| Nothing happens on copy, and the daemon log stays completely silent — no POST, no error | `item_prefixes` doesn't match your client language, so the daemon drops every copied item as "not an item" (step 3 above). The default is English. |
| Copying works for other players but not for this one, and the *backend* log says `no parser for language` | That user is configured for a language whose data set doesn't exist yet; the POST is answered with 503. The daemon discards curl's output, so this one is only visible on the server — and in the admin area of the settings page. See [docs/admin.md](docs/admin.md#data-auto-update-background). |

## Development

```bash
npm ci && npm --prefix renderer ci
node backend/v2/build.mjs                      # bundles the vendored APT engine
cd renderer && node src/assets/make-index-files.mjs && cd ..   # search indices
npm test
```

Both build steps are required before the first `npm test`: the engine bundle and
the `.index.bin` search indices are generated artifacts and are not checked in.
Node 22 or newer is required. The suite needs no network for the bulk of it.

The localized data set is a third generated artifact, and the only one that is
also generated on a running deployment:

```bash
npm run gen-lang-data -- --lang de             # writes renderer/public/data/de/
npm run gen-lang-data -- --lang de --dry-run   # report only, writes nothing
```

It downloads GGG's game data for the current patch, derives the German item
names and mod matchers from the English set already in the tree, and validates
the result before writing anything. **The output is gitignored and never
shipped** — the point of generating per installation is that no one
redistributes extracted game data. In a container the data refresher runs this
by itself; the CLI is for the repo copy and as an emergency hatch.

Repository layout, the module map and the conventions that apply when changing
things: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Changing settings later

Two kinds of setting do **not** need an editor on the server and a redeploy any
more. Both live on the settings page (`/settings.html`).

**Yours, no password:** your net-worth credentials and **your client language**.
The language is the first thing on the settings page, above the sync
credentials, because it is the one setting that can break the price check
without saying a word: it is the language your **game client** runs in, not the
language of the website (the pages follow it, but that is a side effect). Set it
to something your game is not, and a copied item is not priced wrongly — it is
not recognised at all: no card appears in the browser, and the game itself tells
you nothing.

Pick a language and the pages plus the item parsing follow immediately — every
tab you have open included, no save button and no restart. The choice is stored
per user in `/config/user-langs.json` and **wins over `POE_USER_LANGS`**: that
variable is only the value you start on, so an admin editing compose can no
longer silently put you back. Only languages the server has actually loaded a
parser for are offered; a language nobody has ever been configured for has no
data set yet and needs `POE_LANG_DEFAULT` set once (see below). On a server
without a writable `/config` the page says so — the choice then holds until the
next restart and no longer.

**The operator's, behind the admin password:** a configuration section that
writes a small file in the `/config` volume — display name, league, default
language, listings per search, and the on/off switches for the background jobs.
Every row names where its value comes from (this page / the compose file /
built-in default), marks the ones shadowing a compose value, and can be put back
with one **Reset**. Below it a read-only list of everything else this server
runs with, so reading the configuration no longer needs an SSH session.

Each setting says whether it takes effect *live* or needs a restart, and there
is a **Restart** button for the latter. That button has a precondition, and it
is the only action on the whole page that can make the page unreachable:

- **Docker with a restart policy** — the shipped `docker-compose.yml` has
  `restart: unless-stopped`. The container stops and is back within a second.
  This is the case the button is built for.
- **Docker without one** — your own compose file, a `docker run` without
  `--restart`, a different orchestrator. The container stops and **nothing
  starts it again**: the tool is off until you start it on the host, and the
  page you would have undone it from went down with it. From the browser this
  looks exactly like the case above, which is what makes it the dangerous one.
- **Started by hand** (`node backend/v2/server.mjs`) — the process ends, and
  starting it again is your job.

The tool cannot tell them apart: Docker does not tell a container its own
restart policy, and the socket that would is deliberately not mounted. So it
does not guess — the confirmation dialog names the condition before anything
happens, and if the server never answers again the page says what most likely
went wrong and what to do about it, and still says it after a reload.

Two things worth knowing before you go looking for a bug:

- **That file beats `docker-compose.override.yml`.** A setting changed in the
  browser is a deliberate, newer decision than the compose file the box started
  with, so it wins. The view marks every setting that is shadowing a compose
  value, and names the source (`override` / `env` / `default`) of all of them.
- **A set of overrides that breaks the start is thrown out automatically —
  after the second failure in a row, not the first.** A marker is written before
  they are applied and removed once the server is listening, and it counts the
  starts that never got that far. Two in a row and the file is moved to
  `overrides.rejected.json`, with the container booting on its compose defaults.
  No restart loop, nothing lost — and a single interrupted boot (a restart typed
  at the wrong second, a host reboot, an out-of-memory kill) costs you nothing,
  because it says nothing about your settings.
- **One `/config` volume belongs to one instance.** Two containers sharing one
  would count each other's boots and quarantine each other's settings.

Nothing secret is settable or shown there — no POESESSID, no account name, no
password. Details: **[docs/admin.md](docs/admin.md)**.

**Updating from the browser** is possible as well, and needs one thing set up
first: a small script (`deploy/host-update.sh`) running on the machine that
hosts Docker. Pulling code and rebuilding an image is not something a container
can do to itself, and handing it the Docker socket so that it could would mean
handing it the host. Until that script is installed, the update block simply
says so and its button stays disabled. The command line stays the normal way to
update. Setup and the reasoning behind it:
**[docs/admin.md → Update button](docs/admin.md#update-button-deployhost-updatesh)**.

## For admins

Architecture, example Unraid deployment (git-pull workflow), and server config: **[docs/admin.md](docs/admin.md)**.

## Known issues

- **KDE/Klipper + images:** copying an image (e.g. a screenshot) stalls the clipboard read until you open the clipboard history once (Meta+V). It's a KDE clipboard bug, not the tool — normal item-checking is unaffected.
- **A brand-new unique isn't recognised:** the bundled item database is older than the patch that added it. The container fetches the upstream data itself once a day (first check about 2 minutes after a start), so the item is usually picked up without a redeploy. `npm run update-apt-data` only refreshes the checked-in copies; it is the emergency exit — see [docs/admin.md](docs/admin.md#league-start-runbook).
- **`Intangibility` / `Immaterialität` is never parsed** (observed 2026-08 on a German client; no test pins it). The vendored engine has no anchor for that property line in *any* language (`Intangib` appears zero times in its client strings), so it is dropped from the item in English and German alike.
- **Some stats have no German matcher.** They are stats whose English text has two different German phrasings in GGG's data, where picking one would be a guess — so the generator picks neither, and such a line stays read-only rather than being searched as something it might not be. New gaps are reported (admin area of the settings page, language block); the current count is shown there. A run is only refused when it loses more than 1 % of the stats the previous German set already covered (`POE_LANG_MAX_COVERAGE_LOSS_RATIO`, [docs/admin.md](docs/admin.md)).
- **German Heist blueprints from the Robot Tunnels are misread — a bug in GGG's own data** (observed 2026-08 on a German client; no test pins it). Three client-string ids share the English reward line "Replicas or Experimented Items"; for one of them (`HeistBlueprintRewardRobotTunnels`) GGG's German table gives the translation belonging to a *different* reward, "Dieb-Schmuckstücke oder Währung" (Thieves' Trinkets or Currency). The tool pins the correct German wording from the other two ids, so blueprints from the Robot Tunnels are not recognised as that reward type. Guessing around it would mean accepting one reward's wording for another's — worse than not recognising it.
- **The admin view's gap list is memory-only.** A restart or a container update empties it. That is deliberate — a gap that matters recurs the next time that item is checked — but it does mean the list is not a record you can go back to.
- **The patch lookup has a single point of failure.** The language generator gets the current patch version from `ggpk.exposed`. If that service is down and `POE_PATCH_VERSION` is not set, the language source reports `failed` on every check — even when the data set it already has is perfectly current. It has happened once (2026-08-13 to 2026-08-17, [`docs/bugs.md`](docs/bugs.md) B22), and not because the service failed: it answered correctly and the tool refused the answer. English keeps updating throughout, so the outward sign is the `lang-data` line in the log and, after three days, the staleness note in the browser — which since 2026-08-18 carries the reason and says whether it is something to wait out or something to fix ([`docs/bugs.md`](docs/bugs.md) B24). `POE_PATCH_VERSION` is also settable from the admin area now, so the repair no longer needs a shell on the server.

**Not verified yet**, and stated here rather than left to be discovered:

- The corpus of real, collected German item texts is **ten items** ([`backend/v2/corpus/`](backend/v2/corpus/README.md)), and all ten are unpaired. They are checked in, and every `npm test` parses them against the generated German data set — with that data set present, all ten parse; on a fresh clone these tests are skipped until `npm run gen-lang-data -- --lang de` has been run. What is missing is the other half of each pair: none of them has been collected on an English client, so the parity check (same `refName`, same recognised stats, same trade query in both languages) still has nothing to compare, and no category on the corpus checklist counts as covered. **The two questions that could have shipped a silent bug are answered**, though, and by the German texts alone. Socket letters are language-independent — three different combinations show it (`G-R-B-B-W W`, `B-B-B-R`, `B-B-R-W`). Decimals use a **point**, not a comma (`0.2 Sekunden`), so the value regexes are right; that one rests on a single observation, in an enchant line, and no comma-decimal appears anywhere in the corpus — a second, plainer fractional roll would make it airtight. `corpus-parity.test.mjs` prints what is still missing on every run.
- The Bazzite install path has not been walked through on real hardware, and there was deliberately no VM rehearsal either. What was verified from here instead: the tools are in the image or reachable through Homebrew, `evdev-binary` really does install as `import evdev`, and `ujust add-user-to-input-group add` exists. What is left open is the `ydotool` user unit on Fedora — that one fails **loudly**, and it only affects the chat macros. The silent failure mode that would have mattered (Homebrew on the shell's `PATH` but not the service manager's) is now a self-test check rather than a surprise.
- The second player's side of the install — another machine, another person, a
  daemon talking to a backend somebody else runs — has not happened yet.
  Everything the German path does has been exercised by one person on one
  machine.

## Reporting problems

Report bugs at <https://github.com/BriskWatchdogz1/poe-price-tool/issues>, with the item text (copy it with Ctrl+Alt+C) and the log line. Security problems do not belong in a public issue; report them as described in [SECURITY.md](SECURITY.md).

## Credits

Item parsing and trade integration come from [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade) (MIT license, © Alexander Drozdov) and run here headless. See [LICENSE](LICENSE).

**This is AI-written code, and that is not hidden here.** The backend, the browser UI, the hotkey daemon, the tests and this documentation were written by Claude (Anthropic), working from my requirements, my bug reports and my judgement about what the tool should do — I specified, tested and decided; Claude wrote. Every design decision, every measurement quoted in the docs and every fix went through that loop. If that is a dealbreaker for you, you know it before you clone rather than after.

Price data comes from [poe.ninja](https://poe.ninja) (cached for at least 15
minutes, as their usage policy asks), from GGG's public Currency Exchange
digest, and from the official [PoE Trade API](https://www.pathofexile.com/trade).
Item and stat data derives from [RePoE](https://github.com/lvlvllvlvllvlvl/RePoE):
`backend/v2/networth/base-names.json` is derived from it, and
`renderer/public/data/en/` comes from the Awakened PoE Trade repository (MIT).

This is an unofficial fan-made tool. It is not affiliated with, endorsed by, or
sponsored by Grinding Gear Games. Path of Exile is a trademark of Grinding Gear
Games. Use it for your own account at your own risk.
