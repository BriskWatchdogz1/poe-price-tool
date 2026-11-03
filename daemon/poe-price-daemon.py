#!/usr/bin/env python3
"""poe-price-daemon — clipboard-polling price check, plus optional configurable
chat macros. Everything comes from config.toml — nothing is hardcoded.

Price check: the daemon polls the clipboard (the X11 clipboard via xsel, since
PoE runs under XWayland; wl-paste fallback) a few times a second and hands a
new value on stdin to poe-price-post.sh, which filters for PoE items ("Item
Class: ..."), de-dupes, and POSTs to the backend. Polling (a direct read)
rather than `wl-paste --watch` is deliberate: XWayland game selections don't
reliably fire change events until materialized. No key injection: bind your
key (a hardware macro device, e.g. a keypad with extra buttons, or a KDE
shortcut) to PoE's own Ctrl+Alt+C copy, and this daemon prices whatever lands
in the clipboard.

Macros (config `[macros]`, optional): evdev keys bound to chat commands; on
press it opens chat, types the command layout-aware via ydotool, and sends it
(e.g. F5 -> "/hideout"), only while PoE has focus, and copes with USB hotplug
(a device that re-enumerates, as some macro keypads do). No `[macros]`
section, no highlight key and no session key -> no input device is opened
(python-evdev must still be installed, the import is unconditional).

Failures go to the journal (stderr) as one line each, with cause and next
step, through ppt_diag.ThrottledLog: the first at once, the same one again at
most every `error_repeat_s` seconds (default 60) with a count, after
`error_repeat_slow_after` repeats (default 10) at most every
`error_repeat_slow_s` seconds (default 600, never shorter than
`error_repeat_s`), and one line when it works again (not after a single item
the backend could not read: that is no outage). At start the daemon checks
the backend (GET /health, GET /users) and the clipboard once, then asks
whether the backend offers the back channel (GET /daemon/events?wait=0),
starts the overlay process, and logs one line on how results reach the game
(the notification and the overlay, and KDE's fullscreen mute when it applies).

Results in the game (config `[link]`, `[results]`; both optional, with
defaults): after a POST the price also shows on this PC, as a card that says
"queued" at once and is replaced by the price — on the overlay (ppt_overlay.py, a PySide6 child
process on xcb, started at start-up unless overlay = "off") while it works
and, with overlay_only_in_game, while the game has focus; else as a desktop
notification. The result comes over the daemon's own long-poll
(ppt_link.Downlink), never over the browser's WebSocket; ppt_results turns it
into card lines, ppt_display shows them. A server older than the daemon, a
missing notify-send, an overlay without PySide6 or without a display, or an
item without a result each give one journal line and a card that says so;
pricing goes on in every case. A heartbeat (POST /daemon/heartbeat) tells the
server the daemon's version and which of these parts work.

Game detection (config `[presence]`; report_game on by default): ppt_presence
looks for a window of poe_window_class with `xdotool search` every
game_check_s; the heartbeat carries running, absent or unknown, every
idle_heartbeat_s while absent, every heartbeat_s otherwise, at once on a
change. The server's net-worth sync reads the stash of players whose game
runs first and slows down while nobody plays; 'unknown' (no xdotool, no
DISPLAY, a class never seen on this display) keeps the normal pace.
report_game = false reports 'unknown' always.

Buyer whispers (config `[whispers]`; client_log empty = off): ppt_whisper
follows the game's Client.txt, sends each incoming whisper that starts like a
trade-site template to POST /daemon/whisper with a pseudonym ('buyer 3')
instead of the buyer's name, and shows the verdict on your listed price as a
card (overlay stack at whisper_anchor, or a notification per whisper). The
name stays in this process's memory; the journal, the server and the disk
never see it. The read position is kept in
$XDG_RUNTIME_DIR/ppt-whisper-offset.json (no text) for a quick restart.
Stash cell frame ([whispers] highlight_key, [stash_grid]; empty key = off):
an evdev key; while the game has focus, ppt_stash_grid frames the stash cell
of the newest whisper with a position on the overlay; each further press
within whisper_hold_s goes one whisper older.

Farm and game sessions (config [session]; key empty = off): an evdev key
pressed while the game has focus sends POST /daemon/session
{"action": "toggle"} (ppt_session): the server starts the user's farm
session, or ends the running one. The answer and the feed's 'session' events
(baseline set, end, final balance, and the game sessions the server starts
and ends from the game detection) become cards in the overlay's whisper stack
or notifications (ppt_results.session_card); cards = false shows only the
answer to a press.

Each loop round calls tick(): the curl pool, the long-poll, the game probe,
the heartbeat, the result cards, the whispers, the stash cell frame, the
session key's answer and the display (with the overlay's focus check); none of
them waits for a child process. is_poe_focused() serves the macros, the
highlight key and the session key only.
"""
import json
import math
import os
import shutil
import signal
import sys
import time
import subprocess
import selectors
import tomllib
from pathlib import Path

import evdev
from evdev import ecodes as e

# Next to this file; the script's own directory is sys.path[0] when systemd
# (or anyone) starts it directly.
from ppt_diag import (ThrottledLog, post_outcome, xsel_problem, ydotool_problem,
                      health_report, users_report, clientlog_problem, FULLSCREEN_NOTE)
from ppt_link import (read_version, new_instance, headers, CurlPool, CurlResult, Downlink,
                      Heartbeat, classify, split_status)
from ppt_results import ResultBook
from ppt_whisper import Whispers
from ppt_session import SessionKey
from ppt_display import Notifier, Display, OverlayLink, FocusProbe, kde_fullscreen_mute
from ppt_presence import GameProbe
from ppt_stash_grid import Highlighter, read_grid_config

REPO_ROOT = Path(__file__).resolve().parent.parent
DAEMON_VERSION = read_version(REPO_ROOT)

CONFIG_PATHS = [
    Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "poe-price-daemon" / "config.toml",
    Path.home() / ".config" / "poe-price-daemon" / "config.toml",
    Path(__file__).resolve().parent / "config.toml",
]

DEFAULT_CONFIG = (Path(__file__).resolve().parent / "config.example.toml")
RESCAN_INTERVAL = 2.0  # seconds between device rescans (hotplug)
CLIP_POLL_INTERVAL = 0.1  # seconds between clipboard polls (price check; xsel is ~4ms)
XSEL_TIMEOUT = 1  # seconds; unchanged from the earlier inline value
YDOTOOL_TIMEOUT = 10  # seconds; a long macro at 12 ms per key stays well under it
BACKEND_CHECK_TIMEOUT = 5  # seconds, same as the POST's default (PPT_POST_TIMEOUT)
POST_STDERR_KEEP = 8192  # bytes of a post handler's stderr kept; the rest is read and dropped
POST_STDOUT_KEEP = 256  # its stdout carries at most the word same-item
# [link] and [results] defaults (config.example.toml says what each does).
DEFAULT_HOLD_S = 25
MAX_HOLD_S = 50  # the server holds a request at most POE_DAEMON_POLL_MAX_HOLD_MS (default 30 s)
DEFAULT_MIN_GAP_S = 2
DEFAULT_NOTIFY_TIMEOUT_MS = 8000
DEFAULT_RESULT_WAIT_S = 120
OVERLAY_CHOICES = ("auto", "on", "off")
# [presence] defaults (config.example.toml says what each does). The server
# clamps a heartbeat's announced interval to 10 to 600 s
# (backend/v2/daemon-presence.mjs), so the daemon asks for no more.
DEFAULT_HEARTBEAT_S = 60
DEFAULT_IDLE_HEARTBEAT_S = 300
HEARTBEAT_S_RANGE = (10, 600)
DEFAULT_GAME_CHECK_S = 10
GAME_CHECK_S_RANGE = (1, 600)
# The overlay's look and timing ([results]); sent to ppt_overlay.py as its style.
OVERLAY_STYLE_DEFAULTS = {
    "item_hold_s": (8, float),
    "pending_hold_s": (60, float),
    "hide_distance_px": (220, int),
    "offset_px": (24, int),
    "font_pt": (13, float),
    "opacity": (0.88, float),
    "max_width_px": (420, int),
}
# [whispers] defaults (config.example.toml says what each does). Only the
# English ones were seen in a real log; the German, French, Russian, Spanish
# and Portuguese markers and template beginnings are from SlimTrade's patterns
# (LangRegex.java, ChatParser.kt in https://github.com/zmilla93/SlimTrade, MIT,
# (c) 2020 zmilla93), not seen in a real log. "@De" is the French, Spanish and
# Portuguese one; "@От кого" has a space inside. SlimTrade has the markers in
# lower case and compares without regard to case; ppt_whisper.parse_line compares exactly,
# so the capital first letter is assumed, after the English "@From". The
# self-test counts the markers a log really has.
WHISPER_DEFAULTS = {
    "incoming_markers": ["@From", "@Von", "@De", "@От кого"],
    "trade_prefixes": ["Hi, I would like to buy your", "Hi, I'd like to buy your", "Hi, ich möchte '",
                       "Bonjour, je souhaiterais t'acheter", "Bonjour, je voudrais t'acheter",
                       "Здравствуйте, хочу купить у вас", "Hola, quisiera comprar tu", "Hola, me gustaría comprar tu(s)",
                       "Olá, eu gostaria de comprar"],
    "trade_hints": ["buy your", "kaufen", "acheter", "купить", "comprar"],
}
DEFAULT_WHISPER_ANCHOR = (0.02, 0.35)
DEFAULT_WHISPER_HOLD_S = 20
DEFAULT_MAX_WHISPERS = 3
DEFAULT_WHISPER_KEEP = 50
DEFAULT_WHISPER_POLL_S = 0.5
WHISPER_RESUME_FILE = "ppt-whisper-offset.json"
OVERLAY_SCRIPT = Path(__file__).resolve().parent / "ppt_overlay.py"
LANG_CHOICES = ("", "en", "de")
# Journal throttle defaults (config.toml: error_repeat_s, error_repeat_slow_s,
# error_repeat_slow_after). A failure that never stops is written once a
# minute for ten minutes, then once every ten minutes: 154 lines a day
# instead of 1.440.
DEFAULT_ERROR_REPEAT_S = 60
DEFAULT_ERROR_REPEAT_SLOW_S = 600
DEFAULT_ERROR_REPEAT_SLOW_AFTER = 10


def load_config():
    for p in CONFIG_PATHS:
        if p.is_file():
            with open(p, "rb") as f:
                return tomllib.load(f), p
    # No config found -> copy the example to the first default path.
    dest = CONFIG_PATHS[0]
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(DEFAULT_CONFIG.read_text())
    print(f"[poe-price-daemon] Default config created: {dest} — adjust backend/user there.")
    with open(dest, "rb") as f:
        return tomllib.load(f), dest


def _positive(cfg, key, default, kind=float, label=None):
    """A positive number from the config, or SystemExit naming the key.
    With kind=int a number with a fraction (2.5) is refused, not cut to 2.
    TOML's nan and inf are refused too: nan passes `<= 0` and every later
    comparison (the throttle would write every repeat), and int(inf) raises."""
    raw = cfg.get(key, default)
    try:
        value = kind(raw)
    except (TypeError, ValueError, OverflowError):
        value = 0
    finite = math.isfinite(value)
    fraction = kind is int and isinstance(raw, float) and not raw.is_integer()
    if isinstance(raw, bool) or not finite or value <= 0 or fraction:
        raise SystemExit(f"[poe-price-daemon] {label or key} must be a positive "
                         f"{'whole ' if kind is int else ''}number (got {raw!r})")
    return value


def _section(cfg, name):
    """An optional [name] table; missing -> {} (an old config.toml runs as before)."""
    sec = cfg.get(name)
    if sec is None:
        return {}
    if not isinstance(sec, dict):
        raise SystemExit(f"[poe-price-daemon] [{name}] must be a table (got {sec!r})")
    return sec


def _bool(sec, key, default, label):
    raw = sec.get(key, default)
    if not isinstance(raw, bool):
        raise SystemExit(f"[poe-price-daemon] {label} must be true or false (got {raw!r})")
    return raw


def _choice(sec, key, default, choices, label):
    raw = sec.get(key, default)
    if raw not in choices:
        allowed = ", ".join(f'"{c}"' for c in choices)
        raise SystemExit(f"[poe-price-daemon] {label} must be one of {allowed} (got {raw!r})")
    return raw


def _texts(sec, key, default, label, allow_empty=False):
    """A list of texts; a single text is taken as a list of one."""
    raw = sec.get(key, default)
    if isinstance(raw, str):
        raw = [raw] if not allow_empty else None
    ok = isinstance(raw, list) and all(isinstance(x, str) for x in raw)
    if ok and not allow_empty:
        ok = bool(raw) and all(x for x in raw)
    if not ok:
        what = "a list of texts" if allow_empty else "a list of non-empty texts"
        raise SystemExit(f"[poe-price-daemon] {label} must be {what} (got {sec.get(key)!r})")
    return list(raw)


def _anchor(sec, key, default, label):
    raw = sec.get(key, list(default))
    ok = (isinstance(raw, list) and len(raw) == 2
          and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and 0 <= x <= 1
                  for x in raw))
    if not ok:
        raise SystemExit(f"[poe-price-daemon] {label} must be two numbers from 0 to 1 (got {raw!r})")
    return [float(raw[0]), float(raw[1])]


def _item_name(text):
    """The third line of a copied item (Item Class, Rarity, name), for a card
    about a POST that never reached the server; None if there is none."""
    lines = str(text or "").splitlines()
    if len(lines) > 2:
        name = lines[2].strip()
        if name and not name.startswith("--"):
            return name
    return None


def _failure_kind(key):
    """A failed POST's journal key -> the kind of card ResultBook shows."""
    if key == ("item", "http-400"):
        return "unreadable"
    tag = str(key[1]) if len(key) > 1 else ""
    if tag == "http-503-no-parser":
        return "no-parser"
    if tag == "http-400-unknown-user":
        return "unknown-user"
    if tag.startswith("unreachable-") or tag in ("http-000", "no-curl"):
        return "unreachable"
    return "failed"


def keycode(name):
    """evdev key name -> code. E.g. 'F24', 'DOT' (for '.'), 'KP1'."""
    return getattr(e, f"KEY_{name.upper()}")


def build_keymap(layout):
    """char -> (shift_needed, evdev KEY name). Kernel-injected keys are
    interpreted by KWin according to the active layout -> we must send the
    positional keys that produce the desired character under THIS layout."""
    m = {}
    for d in "0123456789":
        m[d] = (False, d)          # digits are the same on de/us
    m[" "] = (False, "SPACE")
    if layout == "de":
        for c in "abcdefghijklmnopqrstuvwx":
            m[c] = (False, c.upper())
        m["y"] = (False, "Z")      # y sits on the Z key
        m["z"] = (False, "Y")
        m["/"] = (True, "7")       # / = Shift+7
        m["-"] = (False, "SLASH")
        m["_"] = (True, "SLASH")
    else:  # us
        for c in "abcdefghijklmnopqrstuvwxyz":
            m[c] = (False, c.upper())
        m["/"] = (False, "SLASH")
        m["-"] = (False, "MINUS")
        m["_"] = (True, "MINUS")
    return m


class PriceDaemon:
    def __init__(self, cfg, config_path):
        self.config_path = str(config_path)
        # The journal first: everything below may already have something to say.
        repeat_s = _positive(cfg, "error_repeat_s", DEFAULT_ERROR_REPEAT_S)
        repeat_slow_s = _positive(cfg, "error_repeat_slow_s", DEFAULT_ERROR_REPEAT_SLOW_S)
        if repeat_slow_s < repeat_s:
            # The slow stage would write more often than the first one.
            raise SystemExit(f"[poe-price-daemon] error_repeat_slow_s ({repeat_slow_s:g}) must not "
                             f"be shorter than error_repeat_s ({repeat_s:g})")
        self.log = ThrottledLog(
            repeat_s,
            slow_interval=repeat_slow_s,
            slow_after=_positive(cfg, "error_repeat_slow_after", DEFAULT_ERROR_REPEAT_SLOW_AFTER, int),
        )
        self.poe_class = str(cfg["poe_window_class"]).lower()

        # Deprecated: 'key' bound an injected price-check trigger. The price
        # check is clipboard-driven -> tolerate a leftover 'key' in old configs
        # (don't crash), just note it's unused.
        if cfg.get("key"):
            print("[poe-price-daemon] Note: 'key' in config.toml is deprecated and ignored — "
                  "price check now runs via clipboard watch (see README).", file=sys.stderr)

        sock = str(cfg.get("ydotool_socket") or "").strip()
        if not sock:
            sock = str(Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")) / ".ydotool_socket")
        self.socket = os.path.expanduser(sock)

        # poe-price-post.sh: fed the clipboard text on stdin by poll_clipboard()
        # -> filter for PoE items, de-dupe, POST.
        self.post_handler = str(Path(__file__).resolve().parent / "poe-price-post.sh")

        # Backend URL + user -> passed to poe-price-post.sh by poll_clipboard()
        # (it reads PPT_BACKEND_URL/PPT_USER).
        self.backend_url = str(cfg["backend_url"]).strip()
        self.user = str(cfg["user"]).strip()

        # Which clipboard contents count as a PoE item. The game writes the
        # item-class line in the CLIENT's language ("Item Class: " on English,
        # "Gegenstandsklasse: " on German), so this must not live in the code --
        # a second hardcoded line would be the same mistake again, in German.
        # A list, so one config can cover a client whose language is switched.
        prefixes = cfg.get("item_prefixes") or ["Item Class: "]
        if isinstance(prefixes, str):  # tolerate a single string in the config
            prefixes = [prefixes]
        self.item_prefixes = [str(p) for p in prefixes if str(p)]
        if not self.item_prefixes:
            raise SystemExit("[poe-price-daemon] item_prefixes is set but empty — "
                             "nothing would ever be posted")

        # Chat macros (optional): key -> chat command, e.g. F5 -> "/hideout".
        # No [macros] section in the config -> self.macros stays empty and the
        # daemon runs price-check only (graceful, no crash).
        macros_cfg = cfg.get("macros") or {}
        self.keyboard_layout = str(macros_cfg.get("keyboard_layout", "us"))
        self.chat_open_delay = macros_cfg.get("chat_open_delay_ms", 45) / 1000.0
        self.keystroke_delay = int(macros_cfg.get("keystroke_delay_ms", 12))
        self.keymap = build_keymap(self.keyboard_layout)
        self.macros = {keycode(k): v for k, v in (macros_cfg.get("keys") or {}).items()}
        # The stash cell frame's key ([whispers] highlight_key; empty: off) and
        # where the stash grid lies ([stash_grid]); read further down.
        self.highlight_key = ""
        self.highlight_code = None
        self.highlighter = None

        self._focus_cache = (0.0, False)
        self._focus_warned = False
        # Baseline -> startup won't re-post. Not reported: startup_checks() says
        # how the clipboard is right after, and a failure logged here would
        # throttle that line away.
        self.last_clip = self._read_clipboard(report=False)
        self._posts = []  # in-flight POST subprocesses (non-blocking; reaped in poll)
        self._post_err = {}  # Popen -> the start of its stderr (POST_STDERR_KEEP bytes)
        self._post_out = {}  # Popen -> its stdout (POST_STDOUT_KEEP bytes)
        self._post_name = {}  # Popen -> the item's name, for a card about a failed POST

        # Results in the game. Both sections are optional: an old config.toml
        # gets the defaults (back channel and notification on).
        link = _section(cfg, "link")
        results = _section(cfg, "results")
        back_channel = _bool(link, "back_channel", True, "[link] back_channel")
        hold_s = _positive(link, "hold_s", DEFAULT_HOLD_S, label="[link] hold_s")
        if hold_s > MAX_HOLD_S:
            raise SystemExit(f"[poe-price-daemon] [link] hold_s must be at most {MAX_HOLD_S} (got {hold_s:g})")
        min_gap_s = _positive(link, "min_gap_s", DEFAULT_MIN_GAP_S, label="[link] min_gap_s")
        notify = _bool(results, "notify", True, "[results] notify")
        notify_timeout_ms = _positive(results, "notify_timeout_ms", DEFAULT_NOTIFY_TIMEOUT_MS, int,
                                      label="[results] notify_timeout_ms")
        # The overlay: a child process (ppt_overlay.py, PySide6), started in
        # startup_checks(); "off" starts nothing.
        self.overlay_setting = _choice(results, "overlay", "auto", OVERLAY_CHOICES, "[results] overlay")
        only_in_game = _bool(results, "overlay_only_in_game", True, "[results] overlay_only_in_game")
        style = {}
        for key, (default, kind) in OVERLAY_STYLE_DEFAULTS.items():
            style[key] = _positive(results, key, default, kind, label=f"[results] {key}")
        if style["opacity"] > 1:
            raise SystemExit(f"[poe-price-daemon] [results] opacity must be at most 1 (got {style['opacity']:g})")
        # Buyer whispers: optional; every key is checked even without
        # client_log, because the overlay's style carries the whisper stack.
        whispers = _section(cfg, "whispers")
        client_log = whispers.get("client_log", "")
        if not isinstance(client_log, str):
            raise SystemExit(f"[poe-price-daemon] [whispers] client_log must be a text (got {client_log!r})")
        markers = _texts(whispers, "incoming_markers", WHISPER_DEFAULTS["incoming_markers"],
                         "[whispers] incoming_markers")
        trade_prefixes = _texts(whispers, "trade_prefixes", WHISPER_DEFAULTS["trade_prefixes"],
                                "[whispers] trade_prefixes")
        trade_hints = _texts(whispers, "trade_hints", WHISPER_DEFAULTS["trade_hints"], "[whispers] trade_hints",
                             allow_empty=True)
        toast_shows_name = _bool(whispers, "toast_shows_name", False, "[whispers] toast_shows_name")
        whisper_anchor = _anchor(whispers, "whisper_anchor", DEFAULT_WHISPER_ANCHOR, "[whispers] whisper_anchor")
        whisper_hold_s = _positive(whispers, "whisper_hold_s", DEFAULT_WHISPER_HOLD_S,
                                   label="[whispers] whisper_hold_s")
        max_whispers = _positive(whispers, "max_whispers", DEFAULT_MAX_WHISPERS, int,
                                 label="[whispers] max_whispers")
        whisper_keep = _positive(whispers, "keep", DEFAULT_WHISPER_KEEP, int, label="[whispers] keep")
        whisper_poll_s = _positive(whispers, "poll_s", DEFAULT_WHISPER_POLL_S, label="[whispers] poll_s")
        highlight_key = whispers.get("highlight_key", "")
        if not isinstance(highlight_key, str):
            raise SystemExit(f"[poe-price-daemon] [whispers] highlight_key must be a text (got {highlight_key!r})")
        highlight_key = highlight_key.strip()
        grid, err = read_grid_config(_section(cfg, "stash_grid"))
        if err:
            raise SystemExit(f"[poe-price-daemon] {err}")
        self.grid = grid
        if highlight_key:
            try:
                code = keycode(highlight_key)
            except AttributeError:
                raise SystemExit(f"[poe-price-daemon] [whispers] highlight_key {highlight_key!r} is not a key "
                                 f"name evdev knows (names like \"F10\", \"KP1\", \"DOT\")") from None
            if code in self.macros:
                raise SystemExit(f"[poe-price-daemon] [whispers] highlight_key {highlight_key} is also a key in "
                                 "[macros.keys]; one key cannot do both")
            self.highlight_key = highlight_key
            if grid["mode"] != "off":
                self.highlight_code = code
        # The session key ([session] key; empty: off): read through evdev like
        # the macro keys, a press while the game has focus toggles the farm
        # session. [session] cards: whether the server's session events show.
        session = _section(cfg, "session")
        session_key = session.get("key", "")
        if not isinstance(session_key, str):
            raise SystemExit(f"[poe-price-daemon] [session] key must be a text (got {session_key!r})")
        session_key = session_key.strip()
        self.session_cards = _bool(session, "cards", True, "[session] cards")
        self.session_key = session_key
        self.session_code = None
        if session_key:
            try:
                code = keycode(session_key)
            except AttributeError:
                raise SystemExit(f"[poe-price-daemon] [session] key {session_key!r} is not a key name evdev "
                                 f"knows (names like \"F11\", \"KP1\", \"DOT\")") from None
            if code in self.macros:
                raise SystemExit(f"[poe-price-daemon] [session] key {session_key} is also a key in "
                                 "[macros.keys]; one key cannot do both")
            if highlight_key and code == keycode(highlight_key):
                raise SystemExit(f"[poe-price-daemon] [session] key {session_key} is also [whispers] "
                                 "highlight_key; one key cannot do both")
            self.session_code = code
        overlay_style = {
            "item_hold_ms": int(style.pop("item_hold_s") * 1000),
            "pending_hold_ms": int(style.pop("pending_hold_s") * 1000),
            **style,
            "whisper_anchor": whisper_anchor,
            "whisper_hold_ms": int(whisper_hold_s * 1000),
            "max_whispers": max_whispers,
        }
        self.overlay_style = overlay_style
        result_wait_s = _positive(results, "result_wait_s", DEFAULT_RESULT_WAIT_S,
                                  label="[results] result_wait_s")
        lang = _choice(results, "lang", "", LANG_CHOICES, "[results] lang")
        self._lang_from_server = not lang
        # Game detection: optional; an old config.toml gets report_game on.
        presence = _section(cfg, "presence")
        report_game = _bool(presence, "report_game", True, "[presence] report_game")
        heartbeat_s = _positive(presence, "heartbeat_s", DEFAULT_HEARTBEAT_S, label="[presence] heartbeat_s")
        idle_heartbeat_s = _positive(presence, "idle_heartbeat_s", DEFAULT_IDLE_HEARTBEAT_S,
                                     label="[presence] idle_heartbeat_s")
        game_check_s = _positive(presence, "game_check_s", DEFAULT_GAME_CHECK_S, label="[presence] game_check_s")
        lo, hi = HEARTBEAT_S_RANGE
        for key, value in (("heartbeat_s", heartbeat_s), ("idle_heartbeat_s", idle_heartbeat_s)):
            if not lo <= value <= hi:
                raise SystemExit(f"[poe-price-daemon] [presence] {key} must be from {lo} to {hi} (got {value:g})")
        if idle_heartbeat_s < heartbeat_s:
            raise SystemExit(f"[poe-price-daemon] [presence] idle_heartbeat_s ({idle_heartbeat_s:g}) must not be "
                             f"shorter than heartbeat_s ({heartbeat_s:g})")
        lo, hi = GAME_CHECK_S_RANGE
        if not lo <= game_check_s <= hi:
            raise SystemExit(f"[poe-price-daemon] [presence] game_check_s must be from {lo} to {hi} (got {game_check_s:g})")
        self.heartbeat_s = heartbeat_s
        self.idle_heartbeat_s = idle_heartbeat_s

        self.instance = new_instance()
        self.pool = CurlPool()
        self.hdrs = headers(self.user, DAEMON_VERSION, self.instance)
        self.downlink = Downlink(self.backend_url, self.hdrs, self.pool, self.log, time.monotonic,
                                 hold_s=hold_s, min_gap_s=min_gap_s, on_events=self._on_events,
                                 on_gap=self._on_gap, enabled=back_channel,
                                 config_path=self.config_path, user=self.user)
        # Is the game running (ppt_presence): the heartbeat carries it. Off:
        # no probe, the heartbeat says 'unknown' and the server keeps the
        # normal net-worth pace for this player.
        self.game = (GameProbe(self.poe_class, self.pool, check_s=game_check_s,
                               on_problem=lambda text: self.log.failure(("game", "seen-file"), text))
                     if report_game else None)
        self._game_said = False  # the first answer is one journal line
        # The heartbeat runs with the back channel off too: the server still
        # learns the version and what works.
        self.heartbeat = Heartbeat(self.pool, self.backend_url, self.hdrs, self.log, time.monotonic,
                                   game=self.game.state if self.game is not None else (lambda: "unknown"),
                                   features=self.features, interval_s=heartbeat_s,
                                   idle_interval_s=idle_heartbeat_s, config_path=self.config_path,
                                   user=self.user)
        self.results = ResultBook(self.instance, wait_s=result_wait_s, lang=lang or "en")
        # client_log empty: no whisper part at all, state 'off', no line.
        self.whispers = None
        if client_log.strip():
            runtime = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
            self.whispers = Whispers(os.path.expanduser(client_log.strip()), pool=self.pool,
                                     base_url=self.backend_url, hdrs=self.hdrs, log=self.log,
                                     clock=time.monotonic, wall_clock=time.time, instance=self.instance,
                                     incoming_markers=markers, trade_prefixes=trade_prefixes,
                                     trade_hints=trade_hints, poll_s=whisper_poll_s,
                                     resume_file=runtime / WHISPER_RESUME_FILE, result_wait_s=result_wait_s,
                                     keep=whisper_keep, config_path=self.config_path, user=self.user,
                                     lang=lang or "en", toast_shows_name=toast_shows_name)
        # The session key's requests and the session cards: always there, so
        # the server's game and farm sessions show without a key too.
        self.session = SessionKey(pool=self.pool, base_url=self.backend_url, hdrs=self.hdrs, log=self.log,
                                  clock=time.monotonic, lang=lang or "en", config_path=self.config_path,
                                  user=self.user)
        overlay = None
        if self.overlay_setting != "off":
            # The overlay's environment is the daemon's (DISPLAY, XAUTHORITY);
            # OverlayLink overwrites QT_QPA_PLATFORM with xcb in it.
            # Only the tests name another platform (offscreen), through
            # PPT_OVERLAY_PLATFORM.
            overlay = OverlayLink(self.log, time.monotonic, argv=[sys.executable, str(OVERLAY_SCRIPT)],
                                  env=os.environ, style=overlay_style,
                                  platform=os.environ.get("PPT_OVERLAY_PLATFORM") or "xcb",
                                  required=self.overlay_setting == "on")
        # is_poe_focused() stays for the macros, the highlight key and the
        # session key; the display never calls it: its focus check runs
        # through the curl pool and never waits.
        self.display = Display(self.log,
                               notifier=Notifier(self.log, time.monotonic,
                                                 expire_ms=notify_timeout_ms) if notify else None,
                               overlay=overlay,
                               focus=FocusProbe(self.poe_class, self.pool, time.monotonic),
                               only_in_game=only_in_game)
        if self.highlight_code is not None:
            self.highlighter = Highlighter(
                log=self.log, pool=self.pool, grid=grid, hold_s=whisper_hold_s,
                positions=lambda: self.whispers.positions() if self.whispers is not None else [],
                show_frame=self.display.show_frame, show_card=self._show,
                xdotool=shutil.which("xdotool"), config_path=self.config_path)

    def watched_keys(self):
        """The evdev key codes the daemon opens input devices for: the macro
        keys, the highlight key and the session key. Empty: no device is
        opened."""
        keys = set(self.macros)
        for code in (self.highlight_code, self.session_code):
            if code is not None:
                keys.add(code)
        return keys

    def _session_line(self):
        """The journal line at start about the session key and the session
        cards, or None when [session] sets neither (cards on, no key)."""
        if not self.session_key and self.session_cards:
            return None
        if self.session_key:
            line = (f"Session key: {self.session_key}, pressed while the game has focus: starts or ends a "
                    "farm session")
        else:
            line = "Session key: off ([session] key is empty)"
        if not self.session_cards:
            line += "; session cards off ([session] cards = false)"
            return line + (": only the answer to a press is shown." if self.session_key else ".")
        if not self.downlink.enabled:
            return line + ("; session cards: the back channel is off ([link] back_channel = false), so only "
                           "the answer to a press is shown.")
        return line + "; session cards on."

    def _highlight_line(self):
        """The journal line at start about the highlight key, or None without one."""
        if not self.highlight_key:
            return None
        g = self.grid
        if g["mode"] == "off":
            return (f"Stash cell frame: off ([stash_grid] mode = \"off\"); the key {self.highlight_key} is not "
                    "watched.")
        if g["mode"] == "manual":
            x, y, w, h = g["rect"]
            where = f"manual (x {x}, y {y}, {w}x{h} px)"
        else:
            where = f"auto (folders {g['folders']}, from the game window's size)"
        line = f"Stash cell frame: key {self.highlight_key}, grid {where}"
        if self.whispers is None:
            line += "; but whispers are off ([whispers] client_log is empty), so there is no cell to show"
        if self.overlay_setting == "off":
            line += "; but the overlay is off ([results] overlay = \"off\"), and only the overlay draws the frame"
        return line + "."

    def features(self):
        """What the heartbeat reports: one state word per part."""
        return {"downlink": self.downlink.state(), **self.display.features(),
                "whispers": self.whispers.state() if self.whispers is not None else "off",
                "game": self.game.feature() if self.game is not None else "off"}

    def _show(self, card):
        """Hand a card to the display. A fault in there must never stop the
        price check: one throttled line instead."""
        if card is None:
            return
        try:
            self.display.show_item(card)
        except Exception as ex:
            self.log.failure(("notify", "internal", type(ex).__name__),
                             f"A result could not be shown: {type(ex).__name__}: {ex}. "
                             "Next: journalctl --user -u poe-price-daemon; the price is in the browser")

    def _show_whisper(self, shown):
        """(card, toast) pairs from ppt_whisper to the display, guarded like _show."""
        for card, toast in shown:
            try:
                self.display.show_whisper(card, toast)
            except Exception as ex:
                self.log.failure(("notify", "internal", type(ex).__name__),
                                 f"A whisper card could not be shown: {type(ex).__name__}: {ex}. "
                                 "Next: journalctl --user -u poe-price-daemon; the whisper is in the browser")

    def _show_session(self, cards):
        """Session cards from ppt_session to the display, guarded like _show."""
        for card in cards:
            try:
                self.display.show_session(card)
            except Exception as ex:
                self.log.failure(("notify", "internal", type(ex).__name__),
                                 f"A session card could not be shown: {type(ex).__name__}: {ex}. "
                                 "Next: journalctl --user -u poe-price-daemon; the session is on the History page")

    def _on_events(self, events):
        now = time.monotonic()
        for ev in events:
            if not isinstance(ev, dict):
                continue
            if ev.get("kind") in ("item", "item-removed"):
                self._show(self.results.event(ev, now))
            elif ev.get("kind") == "whisper" and self.whispers is not None:
                self._show_whisper(self.whispers.event(ev, now))
            elif ev.get("kind") == "session" and self.session_cards:
                self._show_session(self.session.event(ev, now))

    def _on_gap(self, reason):
        for card in self.results.gap(time.monotonic(), reason):
            self._show(card)

    def tick(self, now):
        """Once per loop round, after poll_clipboard(): reap the curl pool,
        then the long-poll, the heartbeat, the result cards and the display.
        Nothing in here waits for a child process."""
        self.pool.reap()
        self.downlink.tick(now)
        if self.game is not None:
            self.game.tick(now)
            if not self._game_said and self.game.feature() != "starting":
                self._game_said = True
                self.log.info(self._game_line())
        self.heartbeat.tick(now)
        for card in self.results.tick(now):
            self._show(card)
        if self.whispers is not None:
            self._show_whisper(self.whispers.tick(now))
        if self.highlighter is not None:
            self.highlighter.tick(now)
        self._show_session(self.session.tick(now))
        self.display.tick(now)

    def _game_line(self):
        """The journal line of game detection: its first answer, or off."""
        if self.game is None:
            return ("Game detection: off ([presence] report_game = false); the server keeps the normal "
                    "net-worth sync pace for you.")
        st = self.game.state()
        what = f"unknown ({self.game.reason()})" if st == "unknown" else st
        return (f"Game detection: window class {self.poe_class}: {what}; heartbeat every "
                f"{self.heartbeat_s:g} s while the game runs or the daemon cannot tell, every "
                f"{self.idle_heartbeat_s:g} s while it is not running.")

    def is_poe_focused(self):
        now = time.monotonic()
        if now - self._focus_cache[0] < 0.25:  # cache briefly -> don't call xdotool on every event
            return self._focus_cache[1]
        res = False
        try:
            wid = subprocess.run(
                ["xdotool", "getwindowfocus"],
                capture_output=True, text=True, timeout=1,
            ).stdout.strip()
            if wid:
                cls = subprocess.run(
                    ["xprop", "-id", wid, "WM_CLASS"],
                    capture_output=True, text=True, timeout=1,
                ).stdout.lower()
                res = self.poe_class in cls
        except Exception as ex:
            if not self._focus_warned:
                print(f"[poe-price-daemon] Focus check failed ({ex}) — is xdotool/xprop present, is DISPLAY set?",
                      file=sys.stderr)
                self._focus_warned = True
            res = False
        self._focus_cache = (now, res)
        return res

    def ydo(self, *args):
        """One ydotool call. True if it worked; otherwise one (throttled)
        journal line and False. Never raises, so a missing ydotool cannot crash
        the daemon out of handle()."""
        if not os.path.exists(self.socket):
            # Checked up front: what ydotool itself does without its daemon's
            # socket differs between versions (an exit code, or 0 and a warning).
            self.log.failure(*ydotool_problem("no-socket", self.socket, self.config_path, YDOTOOL_TIMEOUT))
            return False
        env = dict(os.environ)
        env["YDOTOOL_SOCKET"] = self.socket
        try:
            r = subprocess.run(["ydotool", *args], env=env, capture_output=True, text=True,
                               timeout=YDOTOOL_TIMEOUT)
        except FileNotFoundError:
            problem = "missing"
        except subprocess.TimeoutExpired:
            problem = "timeout"
        else:
            problem = None if r.returncode == 0 else (r.returncode, r.stderr or r.stdout)
        if problem is not None:
            self.log.failure(*ydotool_problem(problem, self.socket, self.config_path, YDOTOOL_TIMEOUT))
            return False
        n = self.log.recovered("ydotool")
        if n:
            self.log.info(f"Chat macros work again ({n} failed attempt(s) before).")
        return True

    def do_type(self, text):
        """Types text layout-aware via ydotool (positional keycodes per layout)."""
        seq = []
        shift = str(e.KEY_LEFTSHIFT)
        for ch in text:
            entry = self.keymap.get(ch) or self.keymap.get(ch.lower())
            if entry is None:
                continue
            need_shift, keyname = entry
            code = getattr(e, f"KEY_{keyname}")
            if need_shift:
                seq.append(f"{shift}:1")
            seq += [f"{code}:1", f"{code}:0"]
            if need_shift:
                seq.append(f"{shift}:0")
        if not seq:
            return True
        return self.ydo("key", "--key-delay", str(self.keystroke_delay), *seq)

    def do_macro(self, cmd):
        # Each step only if the one before worked: the chat then stays open
        # with what was typed so far, instead of a broken command being sent.
        if not self.ydo("key", "28:1", "28:0"):  # Enter -> open chat
            return
        time.sleep(self.chat_open_delay)
        if not self.do_type(cmd):
            return
        time.sleep(self.chat_open_delay)
        self.ydo("key", "28:1", "28:0")  # Enter -> send

    def handle(self, ev):
        if ev.type != e.EV_KEY:
            return
        # Chat macros: fire on PRESS (value==1); macros trigger only while
        # PoE is focused (keeps macro keys inert everywhere else). Price
        # check does not use an input device — see poll_clipboard().
        if ev.value == 1 and ev.code in self.macros:
            if self.is_poe_focused():
                self.do_macro(self.macros[ev.code])
            return
        # The highlight key: the same focus gate as the macros.
        if ev.value == 1 and self.highlighter is not None and ev.code == self.highlight_code:
            if self.is_poe_focused():
                self.highlighter.press(time.monotonic())
            return
        # The session key: the same focus gate; a press toggles the farm session.
        if ev.value == 1 and ev.code == self.session_code and self.session_code is not None:
            if self.is_poe_focused():
                self._show_session(self.session.press(time.monotonic()))
            return

    def _run_xsel(self):
        """`xsel -b -o` -> (problem, text). problem is None on success, else
        'missing', 'timeout' or (returncode, stderr)."""
        try:
            r = subprocess.run(["xsel", "-b", "-o"],
                               capture_output=True, text=True, timeout=XSEL_TIMEOUT)
        except FileNotFoundError:
            return ("missing", None)
        except subprocess.TimeoutExpired:
            return ("timeout", None)
        except Exception as ex:
            return ((-1, f"{type(ex).__name__}: {ex}"), None)
        if r.returncode != 0:
            return ((r.returncode, r.stderr), None)
        return (None, r.stdout)

    def _read_clipboard(self, report=True):
        """Read the current clipboard text, or None. Primary source is the X11
        CLIPBOARD via `xsel`: Path of Exile runs under XWayland (it's an X11
        app), so its Ctrl+Alt+C copies land in the X11 clipboard. Reading that
        DIRECTLY bypasses the flaky X11->Wayland clipboard bridge — on KWin that
        bridge stalls after a native Wayland app (e.g. a screenshot tool) takes
        the clipboard, and only re-syncs when something forces it (Klipper /
        Meta+V), which is what froze the price check. Needs DISPLAY (set for the
        XWayland session; the daemon inherits it). A non-text selection (image)
        offers no text target -> xsel returns empty -> skipped. Falls back to
        the native Wayland clipboard (`wl-paste`) if xsel/DISPLAY are absent.
        A failure of the primary path is reported to the journal (throttled),
        not swallowed; the wl-paste fallback stays quiet, because its exit 1
        also just means "empty"."""
        problem, text = self._run_xsel()
        if problem is None:
            n = self.log.recovered("clipboard")
            if n:
                self.log.info(f"Clipboard readable again via xsel ({n} failed read(s) before).")
            if text:
                return text
        else:
            if report:
                key, body = xsel_problem(problem, os.environ.get("DISPLAY", ""),
                                         os.environ.get("PATH", ""), XSEL_TIMEOUT)
                self.log.failure(key, "Clipboard not readable: " + body)
            if problem == "timeout" or (isinstance(problem, tuple) and problem[0] == -1):
                # As before: a hung X server or an unexpected error gets no
                # wl-paste read on top, which would only double the stall.
                return None
        # Fallback (non-XWayland setups): native Wayland clipboard, text only.
        try:
            r = subprocess.run(["wl-paste", "-n", "-t", "text/plain"],
                               capture_output=True, text=True, timeout=1)
            return r.stdout if (r.returncode == 0 and r.stdout) else None
        except Exception:
            return None

    def poll_clipboard(self):
        """Poll the clipboard; on a NEW value, hand it to poe-price-post.sh on
        stdin (filter for PoE items, de-dupe, POST). The POST runs as a
        NON-BLOCKING subprocess: a slow backend must never stall polling, or we
        miss the next copies (the clipboard only holds the latest value).
        Called every CLIP_POLL_INTERVAL from the main loop."""
        self._reap_posts()
        content = self._read_clipboard()
        if not content or content == self.last_clip:
            return
        self.last_clip = content
        env = dict(os.environ)
        env["PPT_BACKEND_URL"] = self.backend_url
        env["PPT_USER"] = self.user
        # Newline-separated: prefixes contain spaces and colons, a newline is
        # the only separator an item-class line can never contain.
        env["PPT_ITEM_PREFIXES"] = "\n".join(self.item_prefixes)
        # Only a daemon that reads the back channel sets these: poe-price-post.sh
        # then sends the daemon headers and names a skipped duplicate on stdout.
        env["PPT_DAEMON_VERSION"] = DAEMON_VERSION
        env["PPT_INSTANCE"] = self.instance
        try:
            # stdout and stderr are drained on every poll (_drain_post), not
            # only once the handler has ended: a handler writing more than a
            # pipe holds would otherwise block on that write for good, and its
            # failure would never reach the journal. The pipes are non-blocking
            # for that.
            p = subprocess.Popen([self.post_handler], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=env)
            os.set_blocking(p.stderr.fileno(), False)
            os.set_blocking(p.stdout.fileno(), False)
            self._post_err[p] = bytearray()
            self._post_out[p] = bytearray()
            self._post_name[p] = _item_name(content)
            p.stdin.write(content.encode("utf-8"))  # item text is small -> won't block; post.sh reads it at once
            p.stdin.close()
            self._posts.append(p)
        except Exception as ex:
            self.log.failure(("post", "spawn", type(ex).__name__),
                             f"The post handler {self.post_handler} could not be started: {ex}. "
                             "Next: check that the file exists and is executable (chmod +x), "
                             "then: systemctl --user restart poe-price-daemon")
            self._show(self.results.local_failure("failed", _item_name(content)))

    def _drain_post(self, p):
        """Read whatever handler `p` has written so far, without blocking.
        Keeps the first POST_STDERR_KEEP bytes of stderr and POST_STDOUT_KEEP
        of stdout, drops the rest."""
        for stream, buf, keep in ((p.stderr, self._post_err.setdefault(p, bytearray()), POST_STDERR_KEEP),
                                  (p.stdout, self._post_out.setdefault(p, bytearray()), POST_STDOUT_KEEP)):
            if stream is None or stream.closed:
                continue
            while True:
                try:
                    chunk = os.read(stream.fileno(), 65536)
                except (BlockingIOError, InterruptedError):
                    break
                except OSError:
                    break
                if not chunk:
                    break
                room = keep - len(buf)
                if room > 0:
                    buf += chunk[:room]

    def _reap_posts(self):
        """Collect finished POST handlers and turn their exit status into journal
        lines (poe-price-post.sh: 0 posted, 3 skipped, 4 one tagged line)."""
        running = []
        for p in self._posts:
            self._drain_post(p)
            if p.poll() is None:
                running.append(p)
                continue
            self._drain_post(p)  # what it wrote between the read above and its exit
            p.stderr.close()
            if p.stdout is not None:
                p.stdout.close()
            err = bytes(self._post_err.pop(p, b"")).decode("utf-8", "replace")
            out = bytes(self._post_out.pop(p, b"")).decode("utf-8", "replace")
            name = self._post_name.pop(p, None)
            state, key, text = post_outcome(p.returncode, err, self.post_handler)
            now = time.monotonic()
            if state == "ok":
                self._show(self.results.posted(now, self.downlink.state(), name))
                # One unreadable item (category "item") was no outage: closed
                # silently, so the next unreadable item is written at once.
                self.log.recovered("item")
                n = self.log.recovered("post")
                if n:
                    self.log.info(f"POST /item works again ({n} failed attempt(s) before this one).")
                if self.log.recovered("backend"):
                    # The start-up check failed (the backend was not up yet, say).
                    # Without this line that failure stays the last word on the
                    # backend in the journal, though items now arrive.
                    self.log.info("Backend answers now: an item was posted (the start-up check had failed).")
            elif state == "skipped":
                if out.strip() == "same-item":
                    # The same item again: its card again (or a card that says so),
                    # without a request; `again` brings a hidden overlay card back.
                    self._show(dict(self.results.same_item(name), again=True))
            elif state == "failed":
                self.log.failure(key, text)
                self._show(self.results.local_failure(_failure_kind(key), name))
        self._posts = running

    def _curl(self, args):
        """One bounded curl call for the start-up check -> (rc or None, out, err);
        rc None means curl is missing."""
        try:
            r = subprocess.run(["curl", "-sS", "--max-time", str(BACKEND_CHECK_TIMEOUT), *args],
                               capture_output=True, text=True, timeout=BACKEND_CHECK_TIMEOUT + 2)
        except FileNotFoundError:
            return (None, "", "")
        except subprocess.TimeoutExpired:
            return (28, "", f"no answer within {BACKEND_CHECK_TIMEOUT} s")
        return (r.returncode, r.stdout, r.stderr)

    def startup_checks(self):
        """Once at start: does the backend answer and know this user, can the
        clipboard be read, and (with macros) does the ydotool socket exist?
        One line each; failures go through the same throttled log with the
        same keys as at runtime."""
        url = self.backend_url.rstrip("/")
        rc, out, err = self._curl(["-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", f"{url}/health"])
        key, text = health_report(rc, out, err, url, self.config_path)
        if key is not None:
            self.log.failure(key, text)
        else:
            rc, out, _ = self._curl([f"{url}/users"])
            verdict = users_report(rc, out, self.user, url, self.config_path)
            if verdict is None:
                self.log.info(text)  # an older backend without /users: /health is all we know
            elif verdict[0] is None:
                self.log.info(verdict[1])
            else:
                self.log.failure(*verdict)
            if self._lang_from_server and rc == 0:
                # [results] lang empty: the cards follow the language the
                # server reads this user's items in.
                try:
                    lang = (json.loads(out).get("langs") or {}).get(self.user)
                except (TypeError, ValueError, AttributeError):
                    lang = None
                if lang in ("en", "de"):
                    self.results.lang = lang
                    self.session.lang = lang
                    if self.whispers is not None:
                        self.whispers.lang = lang
            if self.downlink.enabled and (verdict is None or verdict[0] is None):
                self._check_back_channel(url)

        notifier = self.display.notifier

        problem, _ = self._run_xsel()
        if problem is None:
            self.log.info(f"Start-up check: clipboard readable via xsel (DISPLAY={os.environ.get('DISPLAY', '')}).")
        else:
            key, body = xsel_problem(problem, os.environ.get("DISPLAY", ""),
                                     os.environ.get("PATH", ""), XSEL_TIMEOUT)
            self.log.failure(key, "Start-up check FAILED: clipboard not readable: " + body)

        if self.macros and not os.path.exists(self.socket):
            self.log.failure(*ydotool_problem("no-socket", self.socket, self.config_path, YDOTOOL_TIMEOUT))

        if self.game is None:
            self.log.info(self._game_line())
        for line in (self._highlight_line(), self._session_line()):
            if line:
                self.log.info(line)
        self.display.start(time.monotonic())  # the overlay process; its hello comes in tick()
        features = self.display.features()
        self.log.info(f"Results in the game: notification {features['notify']}, overlay {features['overlay']}.")
        if notifier is not None:
            notifier.check()  # the one line when notify-send is missing
            if kde_fullscreen_mute():
                self.log.info(FULLSCREEN_NOTE)

    def _check_back_channel(self, url):
        """GET /daemon/events?wait=0 once at start. A failure or an older
        server goes into the downlink's own state, so its first request does
        not write the same line again; 'available' is a line of its own (the
        downlink stays 'starting' until its own first answer)."""
        rc, out, err = self._curl([*self.hdrs, "-w", "\n%{http_code}", f"{url}/daemon/events?wait=0"])
        if rc is None:
            return  # no curl: the /health line said so
        status, body = split_status(out)
        verdict = classify(CurlResult(rc, status, body, err, False))
        if verdict[0] == "ok":
            self.log.info("Start-up check: back channel available (in-game results on).")
        else:
            self.downlink.note_startup(verdict, time.monotonic())


def find_keyboards(keycodes):
    """Devices exposing a macro key, the highlight key or the session key (they
    may live on different physical keyboards, e.g. a hardware macro keypad plus
    the F5-F9 row). Without a [macros] section, a highlight key and a session
    key no device is opened."""
    kbs = []
    for path in evdev.list_devices():
        try:
            d = evdev.InputDevice(path)
        except Exception:
            continue
        if "ydotool" in d.name.lower():  # skip our own virtual device
            continue
        caps = d.capabilities().get(e.EV_KEY, [])
        if any(k in caps for k in keycodes):
            kbs.append(d)
        else:
            d.close()
    return kbs


def main():
    # Under systemd stdout is a pipe and block-buffered: the start-up lines
    # would reach the journal late, or after a crash not at all.
    sys.stdout.reconfigure(line_buffering=True)
    cfg, path = load_config()
    app = PriceDaemon(cfg, path)
    # price check: the clipboard is polled in the main loop (poll_clipboard).
    # Macro keys, the highlight key and the session key: they may sit on
    # different physical devices (e.g. a macro keypad plus the F5-F9 row), all
    # must be watched. Empty without [macros], a highlight key and a session key.
    relevant_keys = app.watched_keys()
    sel = selectors.DefaultSelector()
    registered = {}  # path -> InputDevice

    def drop(dev):
        for fn in (lambda: sel.unregister(dev), dev.close):
            try:
                fn()
            except Exception:
                pass
        registered.pop(dev.path, None)
        print(f"[poe-price-daemon] Device unregistered: {dev.path}", file=sys.stderr, flush=True)

    def register_new():
        for d in find_keyboards(relevant_keys):
            if d.path in registered:
                d.close()  # already registered -> close duplicate
                continue
            registered[d.path] = d
            sel.register(d, selectors.EVENT_READ)
            print(f"[poe-price-daemon] Device registered: {d.name} ({d.path})", flush=True)

    def prune_dead():
        # Detect unplugged OR re-enumerated devices (the event node gets
        # reused -> the inode at the path changes, the old handle is dead).
        for p, dev in list(registered.items()):
            try:
                if os.stat(p).st_ino != os.fstat(dev.fileno()).st_ino:
                    drop(dev)
            except OSError:
                drop(dev)

    register_new()
    print(f"[poe-price-daemon] active (version {DAEMON_VERSION}). Config: {path}  Backend: {app.backend_url}  User: {app.user}")
    print(f"[poe-price-daemon] Price check: clipboard polling active (every {CLIP_POLL_INTERVAL}s)")
    if app.macros:
        print(f"[poe-price-daemon] Chat macros active ({app.keyboard_layout} layout): "
              + ", ".join(f"{k}" for k in cfg.get('macros', {}).get('keys', {})))
    if relevant_keys and not registered:
        print("[poe-price-daemon] No keyboard with a macro, highlight or session key found yet — waiting for devices "
              "(is the user in the 'input' group?).", file=sys.stderr)
    app.startup_checks()

    # systemd stops the service with SIGTERM: leave through `finally`, so no
    # curl or notify-send child outlives the daemon.
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
    last_scan = time.monotonic()
    try:
        while True:
            for key, _ in sel.select(timeout=CLIP_POLL_INTERVAL):
                dev = key.fileobj
                try:
                    for ev in dev.read():
                        app.handle(ev)
                except OSError:
                    # Device disappeared (unplug / re-enumeration) -> unregister,
                    # the rest keeps running. NO exit -> no systemd restart brick.
                    drop(dev)
            app.poll_clipboard()  # price check: catch new clipboard items
            now = time.monotonic()
            try:
                app.tick(now)  # results in the game: never allowed to stop the price check
            except Exception as ex:
                app.log.failure(("tick", type(ex).__name__, str(ex)),
                                f"Results in the game hit an internal error: {type(ex).__name__}: {ex}. "
                                "Prices still go to the browser. Next: report this line")
            if now - last_scan >= RESCAN_INTERVAL:
                last_scan = now
                prune_dead()
                register_new()
    finally:
        if app.whispers is not None:
            err = app.whispers.close()  # the read position, for a quick restart
            if err:
                app.log.failure(*clientlog_problem("resume", app.whispers.path, app.config_path, err))
        app.display.close()
        app.pool.close()


if __name__ == "__main__":
    main()
