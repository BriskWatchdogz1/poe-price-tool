# Changelog

What changed from one release to the next, as a player or an operator notices
it, and what to do when updating. How to update is in the README, section
[Updating](README.md#updating). Read the **Upgrade notes** of every release you
skipped.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-11-04

### Added

- **Value grid over the stash.** With `value_key` set under `[stash_grid]` in
  the daemon's `config.toml`, a press while the game has focus draws over the
  open stash tab what each item there is worth (from `value_min_c`, default
  5 c), with the tab and its total under the grid, for `value_hold_s` (20 s);
  each further press within that time shows the next tab (`value_tabs`, or
  every normal, premium and quad tab in stash order), because the game does
  not say which tab is open. Without the overlay it is a notification of the 5
  dearest items. An item whose price is uncertain (the Net Worth page's
  Confidence mark) has a dashed border and a `?` after its value (`12c?`),
  and the line under the grid counts them. The values are the Net Worth
  page's: the server keeps, for every such tab, where each priced item lies
  and what it is worth (1 c and up, the dearest 600 per tab), from the stash
  read the background sync makes anyway, and serves it at
  `GET /daemon/stash-grid` (at most 60 requests per player and minute). A
  press reads the server's store: no extra request to GGG, poe.ninja or
  Faustus. `./daemon/selftest.sh` checks the key (section 15), `--overlay`
  shows a sample grid. Not tried over a running game yet. See
  [Value grid over the stash](README.md#value-grid-over-the-stash-optional)
  and [Value grid](docs/admin.md#value-grid).

### Upgrade notes

**Server**

- No setting has to change; the route's limit is a fixed number, not a new
  environment variable. `networth-store.json` keeps `schema_version: 2`.
- After the update, each stash tab needs one read by the background sync
  before the value grid can show it; until then the server answers
  `not-read-since-update` for that tab and the daemon's card says *read again
  with the next sync*. A tab stored before the server kept the tab type (and
  not read since) is listed with `grid: false` until that read: the key skips
  it, says *no stash tab with a grid stored* when no other tab is left, and
  *no value grid for this tab type* when `value_tabs` names it. Nothing to do:
  the sync reaches every tab within one pass through the stash.
- **Own frontends:** a new daemon route `GET /daemon/stash-grid`, whose
  cells carry an optional `u: true` for an uncertain price; nothing else
  changes ([PROTOCOL.md](backend/v2/frontend/PROTOCOL.md)).

**Daemon**

- Restart the daemon after `git pull` (`systemctl --user restart
  poe-price-daemon`) and run `./daemon/selftest.sh`. An older daemon with this
  server works as before; this daemon with an older server says *server too
  old for the value grid* on a press and prices as before.
- `[stash_grid]` gains four optional keys; a file without them runs with these
  defaults (all in `daemon/config.example.toml`): `value_key = ""`, which
  means off, `value_min_c = 5`, `value_hold_s = 20`, `value_tabs = []` (every
  tab with a grid). A value key that is not a text or not a key name evdev
  knows, one that is also a macro key, the `highlight_key` or the `[session]
  key`, or a wrong value in the other three stops the daemon and names the
  key.

## [0.3.0] - 2026-11-03

### Added

- **The price in the game.** After the hotkey, the hotkey daemon also shows the
  price on the game PC: as a small click-through card next to the mouse while
  the game has focus (the overlay), otherwise as a desktop notification. Only
  items your own daemon sent are shown, and every hotkey check gets an answer
  there, if only that the price is in the browser. See
  [The price in the game](README.md#the-price-in-the-game-optional).
- **Buyer whispers.** With `client_log` set under `[whispers]` in the daemon's
  `config.toml`, the daemon reads the game's log and shows, for each incoming
  trade whisper, your listed price against the market (`below`, `fair`,
  `above`, or why it was not compared), in the game and in a "Buyer whispers
  (this session)" block on the Price Check page. Only whispers that start like
  a trade-site template leave the PC, with a pseudonym instead of the buyer's
  name. The check never uses the trade API. Whispers from English, German,
  French, Russian, Spanish and Portuguese trade sites are read (all but the
  English ones from SlimTrade's patterns, not seen in a real log); item names
  are known in English and German, so in the other languages an item is
  compared only when its name is exactly an English or German one. A
  `config.toml` that sets its own `incoming_markers` or `trade_prefixes` keeps
  them; the defaults cover every language above. See
  [Buyer whispers](README.md#buyer-whispers-optional).
- **Game detection, and a net-worth sync that follows the game.** The daemon
  tells the server whether the game is running (`[presence]`, on by default).
  With several players, the sync reads the stash of whoever plays first and
  slows down for players whose game is not running; the status line says when
  it yields or rests. It never reads more often than without game detection,
  and a daemon that cannot tell keeps the normal pace. See
  [Game detection](README.md#game-detection-on-by-default).
- **Farm sessions** on the History page: Start farm session and End farm
  session, a balance card (loot at the prices of the start, market movement,
  loot per hour from 10 minutes on, the biggest additions and removals) and a
  list of the sessions with their kind and state (starting, running,
  preliminary, final, never confirmed), each farm session started during a
  game session indented under it. The running farm session, else the game
  session, shows in the status line of every page, and the sync line says
  "Reading every tab once for the session (k of n)" while a session round runs
  and the sync is not paused. Needs the background net-worth sync. A session's
  start is the first full read of the stash after Start, not the last reading
  before it; until then it is "starting", and when that read does not come in
  time, or the session ends first, it starts from the reading at the press and
  says so (the card explains it, the list says "baseline at start"); a
  starting session's card gives the server's estimate of the minutes until its
  baseline, an ended one's until it is final, and after a farm session's end
  it asks for the loot still in the inventory to be stashed. After a start and
  after an end the sync reads that player's tabs once before any twice, within
  the player's own share of the reads (never more often than before).
- **Game sessions.** With game detection on in the hotkey daemon, a game
  evening becomes a session of its own: it starts when the game runs and ends
  10 minutes after the game stopped (`POE_SESSION_GAME_GAP_MS`), dated to the
  stop, so a game restart or crash does not split it. A PC shut down with the
  game running does not join two evenings: when the game is reported running
  again after 10 minutes or more without any report, the old evening ends at
  the last report and a new one starts. A game evening shorter than the first
  full read is struck against the reading at its start, never against a read
  from after the game stopped. A farm session started during it belongs to it.
  A running game session can be discarded on its card on the History page (it
  has no Start or End). `POE_SESSION_AUTO_GAME=0` switches it off. A hotkey
  daemon can start and end farm sessions through `POST /daemon/session` (at
  most `POE_DAEMON_SESSION_MAX_PER_MIN` requests a minute, 10 by default), and
  hears of every session start, end and balance in its feed. Not tried over a
  running game yet.
- **Farm sessions from the game.** With `key` set under `[session]` in the
  daemon's `config.toml` (for example `"F11"`), a press while the game has
  focus starts a farm session or ends the running one. Cards in the overlay's
  whisper stack, or notifications, follow it: *Farm session started* (baseline
  with the next full read, about N min), *Baseline set, session running*,
  *Session ended* (put your loot in the stash first; balance in about N min)
  and *Session balance* (loot, market, per hour), and for the game evening
  *Game session started*, *Game session ended* and its balance; `cards =
  false` keeps only the answer to a press. Section 14 of `./daemon/selftest.sh`
  checks the key, and `--overlay` shows a session card. Not tried over a
  running game yet. See
  [Farm sessions in the game](README.md#farm-sessions-in-the-game-optional).
- **Uncertain prices are marked** on the Net Worth page: a Confidence column
  with the reason (`thin-market`, `gem-guessed`, `variant-guessed`,
  `links-guessed`, `few-listings`), such amounts in the warning colour, how much
  of the headline rests on them, and an "Uncertain only" filter for the table
  and Stash Highlight. Marked rows still count in the total.
- **Price-source status.** The status line of every page names Faustus or
  poe.ninja when its prices are getting old, with the age and the reason; the
  Chaos:Divine tile turns `stale` instead of staying on `live`; the settings
  page lists every price source, the trade API included, with its last success
  and last failure.
- **What the daemon reports, in the browser.** The empty Price Check page says
  when the last item from your hotkey daemon (or its self-test) arrived, or that
  none did since the server started. The status line names parts of your
  daemon that do not work (for example `overlay — no PySide6`), and the settings
  page shows the daemon's version and how to update it when it is behind the
  latest release.
- **The daemon says what fails.** One journal line per cause with the next step
  (`journalctl --user -u poe-price-daemon`), repeated at most every 60 s and,
  after 10 repeats, every 10 minutes, and one line when it works again. At start
  it checks the backend, the user name and the clipboard. A chat macro that
  fails is stopped instead of being sent half-typed.
- **More in the self-test.** `./daemon/selftest.sh` checks `DISPLAY` and a real
  clipboard read under the service manager, the back channel to the server
  (section 8), notifications and KDE's fullscreen setting (9), the overlay (10),
  the whisper log (11) and the game detection (12). `--overlay` shows a test
  card at the mouse.
- **Issue forms.** A new issue is a bug report or a feature request; the bug
  report asks for the versions from the settings page, the self-test output,
  the daemon's journal and the server log. Pull requests: CONTRIBUTING.md,
  section [Pull requests](CONTRIBUTING.md#pull-requests).
- **Listed below market.** The Net Worth page lists every item in a premium
  tab whose price note (`~price` or `~b/o`, the item's own or its tab's) is
  under the tool's market value, by the same rule and `POE_WHISPER_LOW_RATIO`
  as a buyer whisper's *below market*, with tab, position, both prices in
  chaos and the ratio, the biggest loss first (the 100 biggest, and how many
  more). No extra stash request; notes are kept in
  `networth-store.json` and appear tab by tab as the sync reads them again. See
  [docs/pricing-logic.md](docs/pricing-logic.md#listed-below-market).

- **Stash cell frame** (not the net-worth page's Stash Highlight). With
  `highlight_key` set under `[whispers]` (for example `"F10"`), a press in the game frames, on the overlay, the stash cell
  of the newest buyer whisper that names one; each further press within
  `whisper_hold_s` goes one whisper older. Where the grid lies is
  `[stash_grid]` (`auto` from the game window's size as SlimTrade computes it,
  `manual` in screen pixels, or `off`); a quad tab is known from the last
  net-worth sync. `./daemon/selftest.sh --overlay` shows a frame at cell 1,1,
  and section 13 checks the key and the grid. Not tried over a running game
  yet. See [Buyer whispers](README.md#buyer-whispers-optional).

### Changed

- poe.ninja: after a failed request the tool waits 15 minutes before asking
  again and serves the last good answer for up to 24 hours; a server error no
  longer replaces good prices with none. A request times out after 15 s, and
  lookups that need the same answer share one request. The net-worth exchange
  map is read again after an hour and never kept empty.
- The sparklines in the left rail no longer get a new point from an old answer.
- The price brake keeps its memory across restarts
  (`networth-history-guard.json`): a running hold keeps its window, and a name
  that left the stash is still judged against its remembered price. After a
  league switch the memory starts empty.
- A `/config` file a store cannot use is moved to `<name>.broken-<timestamp>`
  with one warning instead of being written over, and a file from a newer
  release (met after a rollback) is left untouched while that store runs in
  memory only. Details in
  [docs/admin.md](docs/admin.md#config-volume).
- The German data set is rebuilt when a release changed the code that builds
  it, not only at the next game patch.
- Every request the tool sends in its own name carries the installed version
  in its User-Agent (`poe-price-tool/<version> (<purpose>)`); most of them sent
  a fixed `0.1` before, and the GitHub downloads of the two manual data scripts
  sent Node's default.
- A buyer's single whisper for something that stacks still gets no verdict,
  but the card, the notification and the Price Check page now show both
  readings of its price in chaos per unit, per unit and per stack, next to the
  market price per unit. The stack size comes from the whisper when it names
  one, else from the last net-worth sync at that tab and cell (then marked
  "last sync"); without either, only the per-unit reading. When the
  Chaos:Divine rate behind a price in divine is the fallback or stale, or the
  market price is uncertain, the readings say so.
- The operator documentation is split in two: `docs/admin.md` is the
  reference (settings, `/config` files, routes, data sources, limits), and the
  procedures — install and deploy, update, league start, reverse proxy, backup
  and restore, the host update script, troubleshooting — are in
  [docs/runbooks.md](docs/runbooks.md).
- The `test:fast` script is removed: it ran the suite without the network
  guard, and on Node 24 it did not start. `npm test -- <filter>` runs part of
  the suite.

### Fixed

- A fungible worth under 1 c was shown as 0 c when the bulk exchange search
  came back empty, and every page reconnect re-queued it as a trade search
  ([B30](docs/bugs.md#b30--a-fungible-under-1-c-was-shown-as-0-c-fixed)).
- The Chaos:Divine tile said `live · poe.ninja` through a poe.ninja outage
  ([B29](docs/bugs.md#b29--price-sources-aged-silently-and-some-old-data-was-stamped-as-new-fixed)).
- `networth-history-items.json` and `data-refresh/state.json` were written over
  when they could not be read
  ([B31](docs/bugs.md#b31--two-config-files-were-still-reset-without-a-word-fixed)).
- A language a player chose on the settings page was erased from
  `user-langs.json` by the next save when its parser was not loaded at the
  start; it now waits in the file and applies again once the parser is live
  ([B32](docs/bugs.md#b32--a-stored-client-language-was-erased-while-its-parser-was-down-fixed)).
- After a failed write of `networth-history-items.json`, a restart lost the
  price brake's memory of the names in the newest point, and a price jump of
  such a name went into the series
  ([B34](docs/bugs.md#b34--the-price-brake-forgot-names-after-a-failed-sidecar-write-fixed)).
  A failed write of that file is now logged, once per error code.
- A language a player had chosen was erased from `user-langs.json` by the next
  save while he was not in `POE_USERS`; it now stays in the file and applies
  again at a start with him back in the list
  ([B33](docs/bugs.md#b33--the-stored-language-of-a-user-taken-out-of-poe_users-was-erased-at-the-next-save-fixed)).
- After a change in the set of stash tabs whose write of
  `networth-history-items.json` failed, a restart took the dropped item
  breakdown back, and the first point afterwards diffed across the change of
  tabs
  ([B35](docs/bugs.md#b35--a-breakdown-dropped-at-a-change-of-stash-tabs-came-back-after-a-restart-when-the-sidecar-write-failed-fixed)).
- A poe.ninja exchange line at exactly 10 traded units was left unpriced,
  because the division came out a hair under 10; the same arithmetic error no
  longer moves the Currency Exchange cross-hour check or the left rail's choice
  between selling for chaos or divine at their bars
  ([B36](docs/bugs.md#b36--an-exchange-line-at-exactly-10-units-failed-the-10-unit-floor-fixed)).
- `npm test` on Node 24 reported a green run with no tests in it
  ([B26](docs/bugs.md#b26--the-test-runner-reported-a-green-run-with-no-tests-in-it-on-node-24-fixed)).

### Upgrade notes

**Server**

- No setting has to change. Every new environment variable has a default
  (rows in the [environment table](docs/admin.md#environment-all-optional-defaults-in-the-server)):
  - price sources: `POE_SOURCE_STALE_MS` 10800000 (3 h),
    `POE_NINJA_MAX_AGE_MS` 86400000 (24 h), `POE_NINJA_MAP_TTL_MS` 3600000
    (1 h), `POE_NINJA_FAIL_LOG_MS` 3600000 (1 h);
  - net worth: `POE_NETWORTH_THIN_TURNOVER_C` 5000,
    `POE_NETWORTH_CORPSE_MIN_LISTINGS` 2, `POE_NETWORTH_GUARD_STATE_MAX_NAMES`
    10000, `POE_NETWORTH_IDLE_EVERY` 10, `POE_NETWORTH_IDLE_REST` off,
    `POE_SYNC_AFTER_GAME_MAX_MS` 3600000 (1 h);
  - farm and game sessions: `POE_NETWORTH_SESSIONS` (`networth-sessions.json`
    next to `POE_NETWORTH_STORE`), `POE_SESSION_BASELINE_MAX_AGE_MS` 600000
    (10 min), `POE_SESSION_RATE_MIN_MS` 600000 (10 min),
    `POE_SESSION_FINALIZE_MAX_MS` 86400000 (24 h), `POE_SESSIONS_KEEP` 200,
    `POE_SESSION_LIST_MAX` 20, `POE_SESSION_TOP_N` 5,
    `POE_SESSION_GAME_GAP_MS` 600000 (10 min), `POE_SESSION_AUTO_GAME` on;
  - the daemon's channel: `POE_DAEMON_POLL_MAX_HOLD_MS` 30000 (30 s),
    `POE_DAEMON_EVENTS_KEEP` 100, `POE_DAEMON_WAITERS_MAX` 4,
    `POE_DAEMON_FEED_MAX_AGE_MS` 120000 (2 min), `POE_DAEMON_BEAT_STALE_MS`
    180000 (3 min), `POE_DAEMON_SESSION_MAX_PER_MIN` 10;
  - buyer whispers: `POE_WHISPER_KEEP` 50, `POE_WHISPER_PRICE_DEADLINE_MS` 3000
    (3 s), `POE_WHISPER_MAX_PER_MIN` 60, `POE_WHISPER_LOW_RATIO` 0.85,
    `POE_WHISPER_HIGH_RATIO` 1.15.
- **Reverse proxy:** the daemon's `GET /daemon/events` is held open for up to
  30 s, so the proxy needs a read timeout above 30 s (nginx's default of 60 s
  is enough). Without a proxy nothing changes.
- **New files in `/config`:** `networth-sessions.json` (farm and game
  sessions; back it up, the summaries cannot be rebuilt) and
  `networth-history-guard.json` (the price brake's memory; a cache). A
  `<name>.broken-<timestamp>` file is one the server could not use: nothing
  reads it again, look at it and delete it.
- With a German data set, the first data check after the update rebuilds it
  once; the previous set stays live until the new one passes its checks.
- Prices stored before the update carry no uncertainty marker until they are
  written again: a stash tab at its next sync, Faustus prices at the next
  refresh, a corpse when it is priced again. The same holds for the stash tab
  type a buyer whisper's `quad` is read from: a tab says nothing about it until
  its next sync.
- **Own frontends:** new WebSocket messages `daemon-status`, `source-status`,
  `networth-session`, `whisper` and `whispers`; new fields `asOf`, `now` and
  `staleAfterMs` on `cd-ratio`, `items[].uncertain` and `belowMarket` on the
  net-worth snapshot, `pace` and `sessionRound` on `networth-sync-status`. A
  whisper entry carries `quad`, `stack` and `caveat` among its fields, and its
  `lang` is one of `en`, `de`, `fr`, `ru`, `es` and `pt`. New HTTP routes
  `GET /source-status`, `GET /networth-sessions`, `POST
  /networth-session/start`, `/end` and `/discard`, and the daemon's `GET
  /daemon/events`, `POST /daemon/heartbeat`, `POST /daemon/whisper` and `POST
  /daemon/session`; the daemon's feed carries `kind: "session"` events. All of
  it is additive
  ([PROTOCOL.md](backend/v2/frontend/PROTOCOL.md)).

**Daemon**

- Restart the daemon after `git pull` (`systemctl --user restart
  poe-price-daemon`) and run `./daemon/selftest.sh`. A daemon that is still
  running keeps working as before until it is restarted. A new daemon with an
  older server keeps pricing, says in the game that the price is in the browser
  only, and asks again every 10 minutes; an older daemon with this server
  works as before.
- `config.toml` gains six optional sections; a file without them runs with
  these defaults (all keys in `daemon/config.example.toml`):
  - `[link]`: `back_channel = true`, `hold_s = 25`, `min_gap_s = 2`;
  - `[results]`: `notify = true`, `overlay = "auto"` (on when PySide6 is
    installed), `overlay_only_in_game = true`, `item_hold_s = 8`,
    `pending_hold_s = 60`, `result_wait_s = 120`, and the card's look;
  - `[whispers]`: `client_log = ""`, which means off;
  - `[presence]`: `report_game = true`, `heartbeat_s = 60`,
    `idle_heartbeat_s = 300`, `game_check_s = 10`;
  - `[stash_grid]`: `mode = "auto"`, `folders = "none"`; with `[whispers]`
    `highlight_key = ""`, which means off. A highlight key evdev does not
    know, one that is also a macro key, or a wrong `[stash_grid]` value stops
    the daemon and names the key;
  - `[session]`: `key = ""`, which means off, and `cards = true`: an updated
    daemon shows the server's game and farm session cards without a key
    (`cards = false` switches them off). A session key evdev does not know,
    one that is also a macro key or the highlight key, or a `cards` that is
    not true or false stops the daemon and names the key.
  The three optional top-level keys `error_repeat_s` (60),
  `error_repeat_slow_after` (10) and `error_repeat_slow_s` (600) set how often
  a failure repeats in the journal; a wrong value there stops the daemon and
  names the key.
- Optional packages: `notify-send` (libnotify) for the notification; PySide6,
  `xdotool` and `xprop` for the overlay; `xdotool` also for the game detection,
  without it the sync keeps its normal pace. On Arch: `libnotify`, `pyside6`,
  `xdotool`, `xorg-xprop`; other distributions in the
  [README](README.md#setting-up-the-hotkey).
- On KDE Plasma, notifications are held back while a fullscreen game has focus;
  section 9 of the self-test says how to change that, or use the overlay.
- Once it has found the game's window, the daemon keeps `game-seen.json` under
  `~/.local/state/poe-price-daemon/` (or `$XDG_STATE_HOME`); with `[whispers]`
  on, it keeps its read position in the log under `$XDG_RUNTIME_DIR`.

## [0.2.1] - 2026-11-02

### Fixed

- `npm test` in a fresh clone is green: the tests that need the server to offer
  German, which it does only with the German data set built per installation,
  skip without it.

### Upgrade notes

- Nothing changes for the server or the daemon; the update only moves the
  version the release check compares.

## [0.2.0] - 2026-11-02

The first release, with everything since the first public tree
(version 0.1.0, 2026-08-07).

### Added

- Settings page: a client language per user, and a password-protected admin
  area for runtime configuration, with restart and update buttons.
- German client support: a German data set generated per installation from
  GGG's own data, never redistributed; the daemon's clipboard filter follows
  the client language (`item_prefixes`).
- The data auto-update also builds and refreshes the German set, and the status
  line now gives the reason and the class of a failed check instead of only
  saying that a source is stale.
- A release check against GitHub once a day: one line on every page when a
  newer release exists, a Releases block and a manual check on the settings
  page.
- `daemon/selftest.sh`, which checks the environment the daemon's service runs
  in.

### Changed

- Net worth: the stash pace follows GGG's rate-limit headers, folder tabs are
  read one request per step, map tier pages are skipped by their metadata, the
  price brake also judges arrivals, every priced row names its source, and a
  Faustus price carries the hour it was observed in.
- History: an item that only loses its price is a price move, not a sale.
- The image runs on Node 24. The daemon's installer no longer hands every
  distribution an Arch command.

### Upgrade notes

- Rebuild the image (`docker compose up -d --build`): it is based on Node 24
  now. Running the server or the tests outside Docker needs Node 22 or newer.
- The admin area's password is in `/config/admin-password`, created with the
  default `admin` on first start: change it before the tool is reachable beyond
  your LAN ([docs/admin.md](docs/admin.md#settings-page--admin-area-settingshtml)).
- The update button works only with `deploy/host-update.sh` installed on the
  host ([docs/admin.md](docs/admin.md#update-button-deployhost-updatesh)).
- The release check asks GitHub once a day; `POE_RELEASE_CHECK_DISABLED=1`
  switches it off.
- For a German client, name the player in `POE_USER_LANGS` (for example
  `player2:de`): the server then builds the German data set at its first data
  check. In that player's daemon `config.toml`, add `"Gegenstandsklasse: "` to
  `item_prefixes`. Each player can also switch his language himself on the
  settings page; that choice wins over `POE_USER_LANGS`.

[Unreleased]: https://github.com/BriskWatchdogz1/poe-price-tool/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/BriskWatchdogz1/poe-price-tool/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/BriskWatchdogz1/poe-price-tool/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/BriskWatchdogz1/poe-price-tool/compare/07e01da...v0.2.1
[0.2.0]: https://github.com/BriskWatchdogz1/poe-price-tool/compare/48cc3b0...07e01da
