#!/usr/bin/env bash
# poe-price-selftest — says, in plain words, what is missing.
#
# Two jobs in one script:
#   1. `install.sh` runs it (as `--tools` up front, in full at the end), so a
#      fresh installation is proven rather than assumed.
#   2. It is what you run when the tool "does nothing" and you have no idea
#      why — including on someone else's machine, months later, without the
#      person who installed it.
#
# It checks, in this order:
#   0. the config the daemon would read (same search order as the daemon),
#   1. the tools the daemon needs — macro tools only if [macros] is configured;
#      xdotool also for game detection ([presence] report_game, on by default;
#      a warning, not a failure),
#   2. clipboard access (the price check has no other input),
#   3. the `input` group (evdev; macros only),
#   4. ydotoold + /dev/uinput (macros only),
#   5. the daemon service, and what the service manager hands it (PATH, DISPLAY, a real xsel read),
#   6. the backend,
#   7. a real test parse: the sample item text for YOUR language goes through
#      the real filter (poe-price-post.sh) and then to the backend, and the
#      answer is classified — prefix mismatch, unknown user, missing language
#      data and unreachable backend are four different diagnoses here, not one
#      shrug,
#   8. the back channel (GET /daemon/events?wait=0: does the server offer
#      in-game results),
#   9. notify-send and the session bus the service sees (and KDE's fullscreen
#      mute),
#  10. the overlay: xdotool and xprop for its focus check, ppt_overlay.py
#      --probe (PySide6, an X11 window on xcb; nothing is shown),
#  11. buyer whispers: is client_log ([whispers]) a readable file, how big
#      and how fresh is it, and does its last 1 MB hold incoming whispers
#      with a configured marker (counted, never printed). A path that does
#      not exist fails and lists the Client.txt files found under Steam
#      (with its other libraries), ~/Games/*/drive_c and ~/.wine/drive_c; a
#      client_log older than a day while one of those was written later is
#      a warning that lists them,
#  12. game detection: is a window of poe_window_class found (sync follows
#      the game; the same check the daemon makes, and it writes nothing),
#  13. the stash cell frame: the highlight key ([whispers] highlight_key; a
#      key name evdev knows, not a macro key, the input group) and the stash
#      grid ([stash_grid], read with the daemon's own code; in auto mode the
#      size of the game window xdotool finds, and where cell 1,1 lies),
#  14. the session key and the session cards ([session]: a key name evdev
#      knows, not a macro key or the highlight key, the input group, xdotool
#      and xprop for its focus gate; whether session cards show and whether
#      the back channel brings them),
#  15. the value key ([stash_grid] value_key: a key name evdev knows, no
#      other key's, the input group, xdotool and xprop for its focus gate;
#      value_min_c, value_hold_s and value_tabs read with the daemon's own
#      code; GET /daemon/stash-grid without a tab: does the server offer it,
#      which tabs it stores, and whether value_tabs names one it has not).
#
# The price check works without sections 8 to 15, so most of what they find
# is a warning: an older server without the back channel (404/405), anything
# about the notification, no PySide6 for the overlay. Section 8 fails only when
# the server answers the back channel with something else (an error status, a
# proxy's page) or not at all: step 6 reached it, so that is a fault in the
# backend or on the way. Section 10 fails when PySide6 is there but no X11
# window can be opened (DISPLAY is set, but the X server takes no connection,
# or Qt has no xcb platform), when Qt starts on another platform than xcb, or
# when overlay = "on" and PySide6 is missing; without DISPLAY in this shell it
# only warns that it cannot test from here. Section 11 fails only when
# client_log is set but is no readable file: the daemon would show no
# whisper; a client that writes no configured marker is a warning, and so is
# a marker of the whispers you send (@To, @An, ...) among incoming_markers.
# Section 12 never fails: a game detection that cannot tell only keeps the
# player's net-worth sync at its normal pace. Section 13 fails only for what
# would stop the daemon (a highlight key it does not know, one that is also a
# macro key, a [stash_grid] it refuses) and for a highlight key without the
# input group while [stash_grid] is not off (with mode = "off" the daemon does
# not watch the key); a grid it cannot find from here is a warning or a note.
# Section 14 fails for what would stop the daemon ([session] that is no table,
# a key that is no text, one it does not know or that another key uses, cards
# that are not true or false) and for a key the daemon could never act on
# (no input group, no xdotool or xprop for the focus gate). Section 15 fails
# the same way for the value key and its settings, and when the server
# answers GET /daemon/stash-grid with an error status or a page that is not
# the tab list, or not at all; a server without the route (404, 405), too
# many requests (429), a store without a tab with a grid, a value_tabs name
# no stored tab has and the overlay switched off are warnings.
#
# What it does NOT do: install anything, edit anything, enable anything. Where
# it knows a fix, it prints the command; running it stays your decision.
#
# Nothing about the installation is hardcoded here — backend, user, prefixes
# and whether macros exist all come from config.toml. The only fixed thing is
# the sample item corpus in selftest-items/, and even that is *selected* by the
# configured prefix and the language the backend reports, never by a guess in
# this file. A new language is one more file in that directory.
#
# The one side effect, stated up front: step 7 POSTs one real item — the same
# request your hotkey sends. One card in the browser, one trade search. Nothing
# is written to disk outside a temporary directory. `--offline` skips it.
#
# Usage:
#   ./daemon/selftest.sh              full run
#   ./daemon/selftest.sh --tools      tools only (what install.sh gates on)
#   ./daemon/selftest.sh --offline    everything except the backend steps
#   ./daemon/selftest.sh --overlay    the config and sections 10 and 13 only, then
#                                     after a 5 s countdown a test card at the
#                                     mouse for 5 s, a session card where
#                                     whisper cards stack for 5 s and, when
#                                     section 13 found the grid, a frame at
#                                     cell 1,1 of the stash for 3 s and a
#                                     sample value grid of 3 cells (one marked
#                                     uncertain) for 5 s;
#                                     switch to the game, open the stash and
#                                     watch for all four
#
# Exit: 0 = nothing broken, 1 = at least one FAIL, 2 = bad usage.
set -uo pipefail

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"   # .../daemon
POST="$DIR/poe-price-post.sh"
SAMPLE_DIR="$DIR/selftest-items"
EXAMPLE="$DIR/config.example.toml"
CFG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

MODE=full
for arg in "$@"; do
  case "$arg" in
    --tools)   MODE=tools ;;
    --offline) MODE=offline ;;
    --overlay) MODE=overlay ;;
    -h|--help) awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) printf 'poe-price-selftest: unknown option "%s" (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

# ---- output -----------------------------------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; DIM=$'\033[2m'; NC=$'\033[0m'
else
  B=''; RED=''; YEL=''; GRN=''; DIM=''; NC=''
fi
FAILS=0
WARNS=0
section() { printf '\n%s%s%s\n' "$B" "$*" "$NC"; }
ok()   { printf '  %s[ ok ]%s %-20s %s\n' "$GRN" "$NC" "$1" "${2-}"; }
warn() { printf '  %s[warn]%s %-20s %s\n' "$YEL" "$NC" "$1" "${2-}"; WARNS=$((WARNS + 1)); }
bad()  { printf '  %s[FAIL]%s %-20s %s\n' "$RED" "$NC" "$1" "${2-}"; FAILS=$((FAILS + 1)); }
na()   { printf '  %s[ -- ] %-20s %s%s\n' "$DIM" "$1" "${2-}" "$NC"; }
hint() { printf '         %s%s%s\n' "$DIM" "$*" "$NC"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ppt-selftest-XXXXXX")" || { echo "cannot create a temp dir" >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT

WHOAMI="$(id -un 2>/dev/null || echo "${USER:-?}")"
have() { command -v "$1" >/dev/null 2>&1; }
# Bound every external read so a hung X server or a black-holed backend can
# never turn the diagnosis itself into the hang it is supposed to explain.
run() { if have timeout; then timeout "$@"; else shift; "$@"; fi; }

printf '%spoe-price-daemon — self-test%s\n' "$B" "$NC"

# ---- 0. config --------------------------------------------------------------
# Same search order as the daemon (poe-price-daemon.py, CONFIG_PATHS), so this
# reads the file the daemon reads — not a second opinion about where it lives.
section "0. Configuration"
CFG=''
for candidate in \
  "$CFG_HOME/poe-price-daemon/config.toml" \
  "$HOME/.config/poe-price-daemon/config.toml" \
  "$DIR/config.toml"
do
  if [ -f "$candidate" ]; then CFG="$candidate"; break; fi
done

CFG_IS_EXAMPLE=0
if [ -n "$CFG" ]; then
  ok "config" "$CFG"
else
  CFG="$EXAMPLE"
  CFG_IS_EXAMPLE=1
  warn "config" "none installed yet — reading the shipped example"
  hint "The daemon would create $CFG_HOME/poe-price-daemon/config.toml from it on first start."
  hint "Values below are placeholders, so backend/user checks say little until you install."
fi

CFG_BACKEND=''
CFG_USER=''
CFG_WINCLASS=''
CFG_SOCKET=''
CFG_MACROS=0
CFG_MACRO_KEYS=0
PREFIXES=()
PREFIX_DEFAULTED=0
CFG_READ=0
CFG_BACK_CHANNEL=1   # the daemon's defaults when [link]/[results] are missing
CFG_NOTIFY=1
CFG_OVERLAY=auto
CFG_ONLY_IN_GAME=1
CFG_CLIENT_LOG=''
CFG_HIGHLIGHT=0      # [whispers] highlight_key set and [stash_grid] not off
CFG_MARKERS=()
CFG_REPORT_GAME=1    # [presence] report_game, on when the section is missing
CFG_SESSION=0        # [session] key set (a text that is not blank)
CFG_VALUE=0          # [stash_grid] value_key set and [stash_grid] not off

read_config() {
  python3 - "$1" <<'PY'
import sys, tomllib
with open(sys.argv[1], 'rb') as fh:
    cfg = tomllib.load(fh)
def emit(key, value):
    print(f"{key}\t{value}")
emit('backend_url', str(cfg.get('backend_url') or '').strip())
emit('user', str(cfg.get('user') or '').strip())
emit('poe_window_class', str(cfg.get('poe_window_class') or '').strip())
emit('ydotool_socket', str(cfg.get('ydotool_socket') or '').strip())
macros = cfg.get('macros')
emit('macros', '1' if isinstance(macros, dict) else '0')
emit('macro_keys', str(len((macros or {}).get('keys') or {})) if isinstance(macros, dict) else '0')
# [link] and [results], with the daemon's defaults when they are missing.
link = cfg.get('link') if isinstance(cfg.get('link'), dict) else {}
results = cfg.get('results') if isinstance(cfg.get('results'), dict) else {}
emit('back_channel', '0' if link.get('back_channel', True) is False else '1')
emit('notify', '0' if results.get('notify', True) is False else '1')
emit('overlay', str(results.get('overlay', 'auto')))
emit('overlay_only_in_game', '0' if results.get('overlay_only_in_game', True) is False else '1')
# [presence], with the daemon's default when it is missing.
presence = cfg.get('presence') if isinstance(cfg.get('presence'), dict) else {}
emit('report_game', '0' if presence.get('report_game', True) is False else '1')
# [whispers], with the daemon's defaults (poe-price-daemon.py, WHISPER_DEFAULTS).
whispers = cfg.get('whispers') if isinstance(cfg.get('whispers'), dict) else {}
client_log = whispers.get('client_log', '')
emit('client_log', client_log.strip() if isinstance(client_log, str) else '')
highlight_key = whispers.get('highlight_key', '')
# With [stash_grid] mode = "off" the daemon does not watch the key at all.
grid_sec = cfg.get('stash_grid') if isinstance(cfg.get('stash_grid'), dict) else {}
watched = isinstance(highlight_key, str) and highlight_key.strip() and grid_sec.get('mode', 'auto') != 'off'
emit('highlight', '1' if watched else '0')
value_key = grid_sec.get('value_key', '')
emit('value', '1' if isinstance(value_key, str) and value_key.strip() and grid_sec.get('mode', 'auto') != 'off' else '0')
# [session] key: the daemon watches it whenever it is a text that is not blank.
session_sec = cfg.get('session') if isinstance(cfg.get('session'), dict) else {}
session_key = session_sec.get('key', '')
emit('session', '1' if isinstance(session_key, str) and session_key.strip() else '0')
markers = whispers.get('incoming_markers', ['@From', '@Von', '@De', '@От кого'])
if isinstance(markers, str):
    markers = [markers]
for m in markers if isinstance(markers, list) else []:
    if isinstance(m, str) and m and '\t' not in m and '\n' not in m:
        emit('marker', m)
prefixes = cfg.get('item_prefixes') or []
if isinstance(prefixes, str):
    prefixes = [prefixes]
for p in prefixes:
    p = str(p)
    if p:
        emit('prefix', p)
PY
}

if ! have python3; then
  bad "config readable" "python3 is missing — neither this test nor the daemon can read the config"
elif ! read_config "$CFG" >"$TMP/cfg" 2>"$TMP/cfg.err"; then
  bad "config readable" "$(head -n 1 "$TMP/cfg.err")"
  hint "The daemon would fail the same way at startup. Fix the file, then run this again."
else
  CFG_READ=1
  while IFS=$'\t' read -r key value; do
    case "$key" in
      backend_url)      CFG_BACKEND="$value" ;;
      user)             CFG_USER="$value" ;;
      poe_window_class) CFG_WINCLASS="$value" ;;
      ydotool_socket)   CFG_SOCKET="$value" ;;
      macros)           CFG_MACROS="$value" ;;
      macro_keys)       CFG_MACRO_KEYS="$value" ;;
      prefix)           PREFIXES+=("$value") ;;
      back_channel)     CFG_BACK_CHANNEL="$value" ;;
      notify)           CFG_NOTIFY="$value" ;;
      overlay)          CFG_OVERLAY="$value" ;;
      overlay_only_in_game) CFG_ONLY_IN_GAME="$value" ;;
      client_log)       CFG_CLIENT_LOG="$value" ;;
      highlight)        CFG_HIGHLIGHT="$value" ;;
      marker)           CFG_MARKERS+=("$value") ;;
      report_game)      CFG_REPORT_GAME="$value" ;;
      session)          CFG_SESSION="$value" ;;
      value)            CFG_VALUE="$value" ;;
    esac
  done <"$TMP/cfg"

  # These three are read as required keys by the daemon (cfg["..."]) — a
  # missing one is not a default, it is a crash on the next start.
  [ -n "$CFG_BACKEND" ]  && ok "backend_url" "$CFG_BACKEND"  || bad "backend_url" "missing — the daemon will not start"
  [ -n "$CFG_USER" ]     && ok "user" "$CFG_USER"            || bad "user" "missing — the daemon will not start"
  [ -n "$CFG_WINCLASS" ] || bad "poe_window_class" "missing — the daemon will not start"

  if [ "${#PREFIXES[@]}" -eq 0 ]; then
    PREFIXES=("Item Class: ")   # mirrors the daemon's own fallback, not a second config
    PREFIX_DEFAULTED=1
    warn "item_prefixes" "not set — falling back to the English default like the daemon does"
  else
    ok "item_prefixes" "$(printf '"%s" ' "${PREFIXES[@]}")"
  fi

  if [ "$CFG_MACROS" = 1 ]; then
    ok "[macros]" "configured ($CFG_MACRO_KEYS key(s)) — macro tools are required below"
  else
    na "[macros]" "not configured — price check only, macro tools below do not apply"
  fi
fi

# ---- 10. overlay (a function: --overlay runs it right after the config) -----
# The card over the game is a child process of the daemon (ppt_overlay.py,
# PySide6) on Qt's xcb platform: the game is an X11 client on XWayland, and only
# a window of the same X server lies above it. --probe imports PySide6 and
# creates a window without showing it; nothing appears on the screen. Like
# section 2, it runs in THIS shell (without DISPLAY here it is not run);
# section 5 of the full run says whether the service has DISPLAY.
OVERLAY_OK=0
overlay_section() {
  section "10. Overlay"
  if [ "$CFG_OVERLAY" = off ]; then
    na "overlay" "off in config.toml ([results] overlay)"
    return
  fi
  if [ "$CFG_ONLY_IN_GAME" = 1 ] && { ! have xdotool || ! have xprop; }; then
    warn "overlay focus check" "xdotool/xprop missing — the overlay is shown only while the game has focus, and that cannot be checked; results come as notifications"
    hint "Install xdotool and xprop (Arch: xdotool xorg-xprop; Debian/Ubuntu: xdotool x11-utils),"
    hint "or set overlay_only_in_game = false in [results]."
  fi
  if ! have python3; then
    na "overlay" "python3 missing (see section 1)"
    return
  fi
  if [ -z "${DISPLAY:-}" ]; then
    warn "overlay" "DISPLAY is not set — cannot test the overlay's X11 window from here"
    if [ "$MODE" = overlay ]; then
      hint "Run this from a terminal in your desktop session; the full run (./daemon/selftest.sh) says in section 5 whether the service has DISPLAY."
    else
      hint "Run this from a terminal in your desktop session; section 5 says whether the service has DISPLAY."
    fi
    return
  fi
  local out rc first
  out="$(QT_QPA_PLATFORM=xcb run 10 python3 "$DIR/ppt_overlay.py" --probe 2>"$TMP/overlay.err")"
  rc=$?
  first="$(head -n 1 "$TMP/overlay.err" | cut -c1-160)"
  case "$rc" in
    0)
      if printf '%s\n' "$out" | head -n 1 | python3 -c '
import json, sys
h = json.loads(sys.stdin.readline())
print("\t".join(str(h.get(k, "?")) for k in ("binding", "qt", "platform", "screens")))
' >"$TMP/overlay.hello" 2>/dev/null; then
        IFS=$'\t' read -r o_binding o_qt o_platform o_screens <"$TMP/overlay.hello"
        if [ "$o_platform" = xcb ]; then
          ok "overlay" "$o_binding $o_qt on xcb, $o_screens screen(s)"
          OVERLAY_OK=1
        else
          bad "overlay" "wrong platform: Qt started on \"$o_platform\" instead of xcb — the card cannot lie above the game"
        fi
      else
        bad "overlay" "ppt_overlay.py --probe gave no hello line"
      fi ;;
    3)
      if [ "$CFG_OVERLAY" = on ]; then
        bad "overlay" "no PySide6 — overlay = \"on\" in config.toml, but results come as notifications"
      else
        warn "overlay" "no PySide6 — results come as notifications"
      fi
      hint "${first:-PySide6 cannot be imported}"
      hint "Arch: pyside6. Then restart the daemon: systemctl --user restart poe-price-daemon" ;;
    4|134)
      bad "overlay" "the X server takes no connection or Qt has no xcb platform — the overlay cannot open a window"
      [ -n "$first" ] && hint "$first"
      hint "From your desktop session:  systemctl --user import-environment DISPLAY XAUTHORITY" ;;
    124)
      bad "overlay" "ppt_overlay.py --probe did not finish within 10 s (a hung X server?)" ;;
    *)
      bad "overlay" "ppt_overlay.py --probe exited $rc: ${first:-no message}" ;;
  esac
}

overlay_demo() {
  section "Overlay test card"
  if [ "$OVERLAY_OK" != 1 ]; then
    na "test card" "not shown — fix the overlay finding above first"
    return
  fi
  printf '  Switch to the game now — in 5 seconds a test card appears at the mouse for 5 seconds.\n'
  printf '  Then a session card appears where whisper cards stack (left edge) for 5 seconds.\n'
  [ -n "$GRID_CELL" ] && printf '  Open your stash in the game: after the card, a frame marks cell 1,1 of it for 3 seconds.\n'
  [ -n "$GRID_RECT" ] && printf '  Then a sample value grid of 3 cells covers the stash for 5 seconds; the one with a dashed border and a ? shows how an uncertain price looks.\n'
  sleep 5
  QT_QPA_PLATFORM=xcb run 20 python3 "$DIR/ppt_overlay.py" --demo >/dev/null 2>"$TMP/overlay-demo.err"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "test card" "ppt_overlay.py --demo exited $rc: $(head -n 1 "$TMP/overlay-demo.err" | cut -c1-160)"
    return
  fi
  printf '  Did the card appear over the game? If not, set overlay = "off" in [results];\n'
  printf '  the notification then carries the result (README, Known issues).\n'
  QT_QPA_PLATFORM=xcb run 20 python3 "$DIR/ppt_overlay.py" --session >/dev/null 2>"$TMP/overlay-session.err"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "session card" "ppt_overlay.py --session exited $rc: $(head -n 1 "$TMP/overlay-session.err" | cut -c1-160)"
    return
  fi
  printf '  Did the session card appear? It stands where whisper cards stack by default; a\n'
  printf '  whisper_anchor of your own ([whispers]) moves the real ones.\n'
}

# ---- 13. stash cell frame (a function: --overlay runs it too) ----------------
# The highlight key ([whispers] highlight_key) frames a whisper's stash cell on
# the overlay; where the grid lies is [stash_grid], read with the daemon's own
# code (ppt_stash_grid.read_grid_config, so a value the daemon refuses fails
# here too). In auto mode the grid comes from the game window's size: here the
# largest window of poe_window_class that `xdotool search --class` finds (the
# daemon takes the focused window when the key is pressed). Prints sizes and
# positions, never a window id. GRID_CELL is cell 1,1 as x,y,w,h for the test
# frame of --overlay, GRID_RECT the grid for its sample value grid; both empty
# when the grid is not known.
GRID_CELL=''
GRID_RECT=''
grid_section() {
  section "13. Stash cell frame"
  if [ "$CFG_READ" != 1 ]; then
    na "stash cell frame" "config not readable (see section 0)"
    return
  fi
  if ! have python3; then
    na "stash cell frame" "python3 missing (see section 1)"
    return
  fi
  run 15 python3 -B - "$DIR" "$CFG" "${DISPLAY:-}" >"$TMP/grid" 2>"$TMP/grid.err" <<'PY'
import shutil, subprocess, sys, tomllib
sys.path.insert(0, sys.argv[1])
from ppt_stash_grid import read_grid_config, grid_rect, cell_rect, parse_geometry
with open(sys.argv[2], "rb") as fh:
    cfg = tomllib.load(fh)
def emit(*a):
    print("\t".join(str(x) for x in a))
w = cfg.get("whispers") if isinstance(cfg.get("whispers"), dict) else {}
key = w.get("highlight_key", "")
if not isinstance(key, str):
    emit("key", "bad", repr(key)[:40])
else:
    key = key.strip()
    if key:
        macros = cfg.get("macros")
        keys = macros.get("keys") if isinstance(macros, dict) else None
        try:
            from evdev import ecodes
            known = hasattr(ecodes, "KEY_" + key.upper())
        except Exception:
            known = None
        if isinstance(keys, dict) and any(str(k).upper() == key.upper() for k in keys):
            emit("key", "macro", key)
        elif known is None:
            emit("key", "no-evdev", key)
        else:
            emit("key", "ok" if known else "unknown", key)
    else:
        emit("key", "empty")
sec = cfg.get("stash_grid", {})
grid, err = read_grid_config(sec) if isinstance(sec, dict) else (None, "[stash_grid] must be a table")
if err:
    emit("grid", "error", err)
    sys.exit(0)
def where(r):
    return f"{r[2]}x{r[3]} px at {r[0]},{r[1]}"
def cell(r):
    c = cell_rect(r, 1, 1, False)
    emit("cell", ",".join(str(v) for v in c))
    emit("rect", ",".join(str(v) for v in r))
    return f"cell 1,1 is {c[2]}x{c[3]} at {c[0]},{c[1]}"
if grid["mode"] == "off":
    emit("grid", "off")
elif grid["mode"] == "manual":
    emit("grid", "manual", f"manual: {where(grid['rect'])}; {cell(grid['rect'])}")
else:
    xd = shutil.which("xdotool")
    if not xd:
        emit("grid", "no-xdotool")
    elif not sys.argv[3]:
        emit("grid", "no-display")
    else:
        try:
            r = subprocess.run([xd, "search", "--class", str(cfg.get("poe_window_class") or "")],
                               capture_output=True, text=True, timeout=5)
            ids = r.stdout.split()[:10] if r.returncode == 0 else []
            wins = []
            for wid in ids:
                g = subprocess.run([xd, "getwindowgeometry", "--shell", wid], capture_output=True, text=True, timeout=5)
                geo = parse_geometry(g.stdout) if g.returncode == 0 else None
                if geo:
                    wins.append(geo)
        except (OSError, subprocess.TimeoutExpired):
            ids, wins = [], []
        if not ids:
            emit("grid", "no-window")
        elif not wins:
            emit("grid", "no-geometry")
        else:
            win = max(wins, key=lambda g: g[2] * g[3])
            gr = grid_rect(win, grid["folders"])
            emit("grid", "auto", f"auto: game window {win[2]}x{win[3]} at {win[0]},{win[1]} — grid {where(gr)}; {cell(gr)}")
PY
  local k_state='' k_name='' g_state='' g_text=''
  while IFS=$'\t' read -r kind a b; do
    case "$kind" in
      key)  k_state="$a"; k_name="$b" ;;
      grid) g_state="$a"; g_text="$b" ;;
      cell) GRID_CELL="$a" ;;
      rect) GRID_RECT="$a" ;;
    esac
  done <"$TMP/grid"
  if [ -z "$k_state" ] && [ -z "$g_state" ]; then
    warn "stash cell frame" "the check itself failed: $(head -n 1 "$TMP/grid.err" | cut -c1-160)"
    return
  fi
  case "$k_state" in
    empty)    na "highlight key" "off ([whispers] highlight_key is empty)" ;;
    bad)      bad "highlight key" "highlight_key must be a text (got $k_name) — the daemon will not start" ;;
    macro)    bad "highlight key" "$k_name is also a key in [macros.keys] — the daemon will not start" ;;
    unknown)  bad "highlight key" "$k_name is not a key name evdev knows (names like F10, KP1, DOT) — the daemon will not start" ;;
    no-evdev) warn "highlight key" "$k_name cannot be checked: python-evdev is missing (see section 1)" ;;
    ok)       ok "highlight key" "$k_name (pressed while the game has focus)" ;;
  esac
  if { [ "$k_state" = ok ] || [ "$k_state" = no-evdev ]; } && [ "$g_state" = off ]; then
    na "highlight input" "[stash_grid] mode = \"off\": the daemon does not watch $k_name"
  elif [ "$k_state" = ok ] || [ "$k_state" = no-evdev ]; then
    if id -nG 2>/dev/null | grep -qw input; then
      ok "highlight input" "$WHOAMI is in the 'input' group"
    else
      bad "highlight input" "$WHOAMI is not in the 'input' group — the highlight key will never be seen"
      hint "Arch/Garuda:  sudo usermod -aG input $WHOAMI    (then log out and back in)"
    fi
    if [ -z "$CFG_CLIENT_LOG" ]; then
      warn "highlight whispers" "client_log is empty — there is never a whisper to frame (section 11)"
    fi
    if [ "$CFG_OVERLAY" = off ]; then
      warn "highlight overlay" "the overlay is off ([results] overlay = \"off\") — only the overlay draws the frame"
    fi
  fi
  case "$g_state" in
    error)       bad "stash grid" "$g_text — the daemon will not start" ;;
    off)         na "stash grid" "off ([stash_grid] mode = \"off\")" ;;
    manual|auto) ok "stash grid" "$g_text" ;;
    no-xdotool)  warn "stash grid" "auto needs xdotool to find the game window — install it, or set mode = \"manual\" with x, y, w, h" ;;
    no-display)  warn "stash grid" "auto: DISPLAY is not set — cannot read the game window from here"
                 hint "Run this from a terminal in your desktop session, with the game running." ;;
    no-window)   na "stash grid" "auto: no game window — start the game and run this again to see where the grid lies" ;;
    no-geometry) warn "stash grid" "auto: the game window was found, but xdotool gave no size for it"
                 hint "Set mode = \"manual\" with x, y, w, h in [stash_grid] of $CFG." ;;
  esac
}

# The frame of --overlay: cell 1,1 as section 13 found it, for 3 s.
grid_demo() {
  if [ "$OVERLAY_OK" != 1 ]; then
    na "test frame" "not shown — fix the overlay finding above first"
    return
  fi
  if [ -z "$GRID_CELL" ]; then
    na "test frame" "not shown — the grid is not known (see section 13)"
    return
  fi
  QT_QPA_PLATFORM=xcb run 20 python3 "$DIR/ppt_overlay.py" --frame "$GRID_CELL" >/dev/null 2>"$TMP/overlay-frame.err"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "test frame" "ppt_overlay.py --frame exited $rc: $(head -n 1 "$TMP/overlay-frame.err" | cut -c1-160)"
    return
  fi
  printf '  Did the frame sit on the top-left cell of your stash? If not, set folders, or mode = "manual"\n'
  printf '  with x, y, w, h, in [stash_grid] (README, Buyer whispers).\n'
  [ -n "$GRID_RECT" ] || return
  QT_QPA_PLATFORM=xcb run 20 python3 "$DIR/ppt_overlay.py" --grid "$GRID_RECT" >/dev/null 2>"$TMP/overlay-grid.err"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "test grid" "ppt_overlay.py --grid exited $rc: $(head -n 1 "$TMP/overlay-grid.err" | cut -c1-160)"
    return
  fi
  printf '  Did the three numbers sit in cells of your stash grid? Can you read them at your\n'
  printf '  resolution? The value grid uses the same grid as the frame.\n'
}

result() {
  section "Result"
  if [ "$FAILS" -gt 0 ]; then
    printf '  %s%s problem(s)%s, %s warning(s). Everything marked [FAIL] above has to be fixed.\n' "$RED" "$FAILS" "$NC" "$WARNS"
    exit 1
  fi
  if [ "$WARNS" -gt 0 ]; then
    printf '  %sNo failures%s, %s warning(s) — read them, they are usually "cannot be tested from here".\n' "$GRN" "$NC" "$WARNS"
    exit 0
  fi
  printf '  %sAll checks passed.%s\n' "$GRN" "$NC"
  exit 0
}

if [ "$MODE" = overlay ]; then
  overlay_section
  grid_section
  overlay_demo
  grid_demo
  result
fi

# ---- 1. tools ---------------------------------------------------------------
section "1. Tools"
if have python3; then
  ok "python3" "$(python3 -V 2>&1)"
  python3 -c 'import tomllib' 2>/dev/null \
    && ok "python tomllib" "" \
    || bad "python tomllib" "Python < 3.11 — the daemon cannot read its config"
  # evdev is imported unconditionally at the top of poe-price-daemon.py: the
  # daemon does not start without it, macros or no macros.
  if python3 -c 'import evdev' 2>/dev/null; then
    ok "python evdev" ""
  else
    bad "python evdev" "missing — the daemon will not start, even with no macros configured"
    hint "Distributions that ship it:  install their python-evdev package."
    hint "Otherwise the prebuilt wheels:  python3 -m pip install --user evdev-binary"
    hint "On a PEP 668 distribution (Fedora and derivatives) pip refuses that with"
    hint "\"externally-managed-environment\"; add --break-system-packages — it still"
    hint "only writes to ~/.local, so it does not touch an immutable /usr."
  fi
else
  bad "python3" "missing"
  bad "python tomllib" "no python3"
  bad "python evdev" "no python3"
fi

have curl && ok "curl" "" || bad "curl" "missing — nothing can be posted to the backend"

# xsel is not a preference. PoE runs under XWayland, its Ctrl+Alt+C lands in the
# X11 clipboard, and wl-paste does not reliably see that change. Without xsel
# the price check looks flaky rather than broken — the worst failure to debug.
if have xsel; then
  ok "xsel" ""
else
  bad "xsel" "missing — PoE copies land in the X11 clipboard (XWayland)"
  hint "The wl-paste fallback does not reliably see XWayland clipboard changes:"
  hint "the price check will work sometimes and not others; the daemon's journal names it"
  hint "(once a minute at first, then every 10 minutes)."
fi
have wl-paste && ok "wl-paste" "fallback present" || warn "wl-paste" "missing — no fallback if xsel/DISPLAY are unavailable"

for tool in ydotool xdotool xprop; do
  if [ "$CFG_MACROS" = 1 ]; then
    have "$tool" && ok "$tool" "" || bad "$tool" "missing — required by the configured chat macros"
  elif [ "$tool" = xdotool ] && [ "$CFG_REPORT_GAME" = 1 ]; then
    # Game detection ([presence], on by default) looks for the game's window
    # with xdotool. Without it the daemon runs on and reports 'unknown', and
    # the server keeps the normal net-worth pace: a warning, not a failure.
    if have xdotool; then
      ok "xdotool" "for game detection"
    else
      warn "xdotool" "needed for game detection (sync follows the game) — without it your sync keeps its normal pace"
      hint "Arch: xdotool; Debian/Ubuntu: xdotool. Or set report_game = false in [presence]."
    fi
  else
    na "$tool" "no [macros] section"
  fi
done

if [ "$MODE" = tools ]; then
  section "Result"
  if [ "$FAILS" -gt 0 ]; then
    printf '  %s%s missing prerequisite(s).%s\n' "$RED" "$FAILS" "$NC"
    exit 1
  fi
  printf '  %sTools complete.%s\n' "$GRN" "$NC"
  exit 0
fi

# ---- 2. clipboard -----------------------------------------------------------
# Read-only: we look at the clipboard, we never set it.
section "2. Clipboard access"
CLIP_OK=0
if have xsel && [ -n "${DISPLAY:-}" ]; then
  if run 3 xsel -b -o >"$TMP/clip" 2>"$TMP/clip.err"; then
    CLIP_OK=1
    if [ -s "$TMP/clip" ]; then
      ok "xsel -b -o" "X11 clipboard readable ($(wc -c <"$TMP/clip") bytes in it right now)"
    else
      ok "xsel -b -o" "X11 clipboard readable (currently empty — fine)"
    fi
  else
    bad "xsel -b -o" "failed on DISPLAY=$DISPLAY: $(head -n 1 "$TMP/clip.err")"
  fi
elif have xsel; then
  warn "xsel -b -o" "DISPLAY is not set — cannot test the X11 clipboard from here"
  hint "Expected over SSH or from a plain TTY. Run this inside your desktop session to test it."
else
  na "xsel -b -o" "xsel is missing (see above)"
fi

if have wl-paste && [ -n "${WAYLAND_DISPLAY:-}" ]; then
  if run 3 wl-paste -n -t text/plain >/dev/null 2>&1; then
    ok "wl-paste" "Wayland clipboard readable (fallback path)"
    CLIP_OK=1
  else
    warn "wl-paste" "returned an error — only matters if xsel is unavailable"
  fi
elif have wl-paste; then
  na "wl-paste" "WAYLAND_DISPLAY is not set"
fi
[ "$CLIP_OK" = 1 ] || warn "clipboard" "no clipboard could be read here — the price check has no other input"

# ---- 3. input group ---------------------------------------------------------
# evdev needs read access to /dev/input/event* — but only the macros, the
# highlight key, the session key and the value key ever open a device. Without
# [macros] this section does not apply; section 13 checks the group for the
# highlight key, section 14 for the session key, section 15 for the value key.
# Without any of them the daemon watches no
# keys at all, so the group is genuinely not applicable rather than quietly
# optional.
section "3. Input group (evdev)"
if [ "$CFG_MACROS" = 1 ]; then
  if id -nG 2>/dev/null | grep -qw input; then
    ok "group input" "$WHOAMI is a member"
  else
    bad "group input" "$WHOAMI is not in the 'input' group — macro keys will never be seen"
    hint "Arch/Garuda:  sudo usermod -aG input $WHOAMI    (then log out and back in)"
    hint "Bazzite:      ujust add-user-to-input-group add (handles the /usr/lib/group quirk)"
  fi
  readable=0
  for dev in /dev/input/event*; do
    [ -r "$dev" ] && { readable=$((readable + 1)); }
  done
  [ "$readable" -gt 0 ] \
    && ok "/dev/input" "$readable readable event device(s)" \
    || bad "/dev/input" "no readable event device — group membership may need a fresh login"
elif [ "$CFG_HIGHLIGHT" = 1 ]; then
  na "group input" "no [macros] section — section 13 checks it for the highlight key"
elif [ "$CFG_SESSION" = 1 ]; then
  na "group input" "no [macros] section — section 14 checks it for the session key"
elif [ "$CFG_VALUE" = 1 ]; then
  na "group input" "no [macros] section — section 15 checks it for the value key"
else
  na "group input" "no [macros] section — the daemon opens no input devices"
fi

# ---- 4. ydotool -------------------------------------------------------------
section "4. ydotool (chat macros)"
if [ "$CFG_MACROS" = 1 ]; then
  SOCKET="$CFG_SOCKET"
  [ -n "$SOCKET" ] || SOCKET="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/.ydotool_socket"
  if have systemctl; then
    state="$(systemctl --user is-active ydotool 2>/dev/null)"
    case "$state" in
      active) ok "ydotool.service" "active" ;;
      '')     warn "ydotool.service" "no systemd user session here — cannot tell" ;;
      *)      bad "ydotool.service" "$state"
              hint "Start it:  systemctl --user enable --now ydotool"
              hint "If that says \"unit not found\", the unit name is not universal — some"
              hint "distributions ship ydotool without any user unit at all. Check with"
              hint "  systemctl --user list-unit-files '*ydo*'"
              hint "and write one yourself if there is none; ydotoold only needs /dev/uinput." ;;
    esac
  else
    na "ydotool.service" "no systemctl"
  fi
  [ -S "$SOCKET" ] \
    && ok "ydotool socket" "$SOCKET" \
    || bad "ydotool socket" "$SOCKET does not exist — macros cannot type"
  if [ -e /dev/uinput ]; then
    [ -w /dev/uinput ] \
      && ok "/dev/uinput" "writable" \
      || warn "/dev/uinput" "not writable by $WHOAMI — fine if ydotoold runs as root, fatal otherwise"
  else
    bad "/dev/uinput" "missing — load the module (modprobe uinput) or ydotoold cannot start"
  fi
else
  na "ydotool" "no [macros] section"
fi

# ---- 5. the daemon itself ---------------------------------------------------
section "5. Daemon service"
if have systemctl; then
  state="$(systemctl --user is-active poe-price-daemon.service 2>/dev/null)"
  case "$state" in
    active)   ok "poe-price-daemon" "active" ;;
    inactive) bad "poe-price-daemon" "installed but not running"
              hint "Start it:  systemctl --user start poe-price-daemon" ;;
    failed)   bad "poe-price-daemon" "failed"
              hint "Why:  systemctl --user status poe-price-daemon" ;;
    '')       warn "poe-price-daemon" "not installed here (or no systemd user session)"
              hint "That is expected if you are only diagnosing — install with ./daemon/install.sh" ;;
    *)        warn "poe-price-daemon" "$state" ;;
  esac
else
  na "poe-price-daemon" "no systemctl"
fi

# The check above asks whether the unit runs. This one asks whether it can SEE
# what it needs — a different question, and the one that bites.
#
# Everything in section 1 was measured in THIS shell. The daemon does not run in
# this shell: systemd starts it with the user manager's environment, which is
# not the login shell's. A tool installed somewhere that only a profile.d
# snippet puts on PATH (Homebrew's /home/linuxbrew/.linuxbrew/bin is the common
# case) is therefore green up there and missing down here. The daemon then falls
# back to wl-paste and says so in its journal (poe-price-daemon.py,
# _read_clipboard) — but only once the unit runs; this asks before. The price
# check then works "sometimes". So: ask the user manager itself.
if have systemctl && have systemd-run && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  # Ask the service manager first. If show-environment fails (no user bus, the
  # 5 s bound), systemd-run below fails the same way, and neither says anything
  # about PATH or DISPLAY — so both checks are skipped with one line instead of
  # a FAIL whose advice would send the user nowhere.
  UNIT_DISPLAY=''
  UNIT_ENV_RC=0
  run 5 systemctl --user show-environment >"$TMP/unitenv" 2>"$TMP/unitenv.err" || UNIT_ENV_RC=$?
  if [ "$UNIT_ENV_RC" != 0 ]; then
    UNIT_ENV_WHY="$(head -n 1 "$TMP/unitenv.err" 2>/dev/null)"
    [ "$UNIT_ENV_RC" = 124 ] && UNIT_ENV_WHY="no answer within 5 s"
    na "unit environment" "could not ask the service manager (systemctl --user show-environment: ${UNIT_ENV_WHY:-exit $UNIT_ENV_RC}) — PATH and DISPLAY of the daemon not checked"
  else
    while IFS= read -r line; do
      case "$line" in DISPLAY=*) UNIT_DISPLAY="${line#DISPLAY=}" ;; esac
    done <"$TMP/unitenv"

    UNIT_XSEL=0
    for tool in xsel xdotool xprop; do
      # Only claim a problem for tools this installation actually needs.
      case "$tool" in
        xsel) needed=1 ;;
        *)    [ "$CFG_MACROS" = 1 ] && needed=1 || needed=0 ;;
      esac
      [ "$needed" = 1 ] || continue
      if ! have "$tool"; then continue; fi   # already reported as missing in section 1
      UNIT_RUN_RC=0
      run 10 systemd-run --user --collect --wait --pipe --quiet \
        /usr/bin/env sh -c "command -v $tool" >"$TMP/unitpath" 2>"$TMP/unitpath.err" || UNIT_RUN_RC=$?
      UNIT_RUN_WHY="$(head -n 1 "$TMP/unitpath.err" 2>/dev/null)"
      if [ "$UNIT_RUN_RC" = 0 ]; then
        ok "unit sees $tool" "$(head -n 1 "$TMP/unitpath")"
        [ "$tool" = xsel ] && UNIT_XSEL=1
      elif [ "$UNIT_RUN_RC" = 124 ] || [ -n "$UNIT_RUN_WHY" ]; then
        # `command -v` finding nothing prints nothing; a timeout or words on
        # stderr come from systemd-run itself (bus, start of the unit) and say
        # nothing about the unit's PATH.
        [ "$UNIT_RUN_RC" = 124 ] && UNIT_RUN_WHY="no answer within 10 s"
        na "unit sees $tool" "could not start a unit to look (systemd-run: $UNIT_RUN_WHY)"
      else
        bad "unit sees $tool" "$tool is on YOUR PATH but not the service manager's"
        hint "The daemon runs under systemd and will not find it. For xsel that means"
        hint "a fallback to wl-paste, which misses XWayland copies — the price"
        hint "check then works only sometimes (the daemon's journal names it)."
        hint "Fix it for the user manager, not for your shell:"
        hint "  mkdir -p ~/.config/environment.d"
        hint "  printf 'PATH=%s:\$PATH\\n' \"\$(dirname \"\$(command -v $tool)\")\" \\"
        hint "    > ~/.config/environment.d/10-poe-price-daemon-path.conf"
        hint "  systemctl --user daemon-reexec && systemctl --user restart poe-price-daemon"
        hint "Then run this self-test again — this line has to turn green."
      fi
    done

    # PATH is half of the unit's world; DISPLAY is the other. xsel without it
    # cannot reach the X11 clipboard PoE copies to, and this shell having one
    # (section 2 is green) says nothing about the service manager.
    if [ -z "$UNIT_DISPLAY" ]; then
      bad "unit DISPLAY" "the service manager has no DISPLAY — the daemon cannot read the X11 clipboard PoE copies to"
      hint "From your desktop session:"
      hint "  systemctl --user import-environment DISPLAY XAUTHORITY && systemctl --user restart poe-price-daemon"
      hint "If it is gone again after the next login, your desktop does not hand DISPLAY to systemd."
    elif [ "$UNIT_XSEL" = 1 ]; then
      if run 10 systemd-run --user --collect --wait --pipe --quiet \
           /usr/bin/env sh -c 'xsel -b -o >/dev/null' >/dev/null 2>"$TMP/unitclip.err"; then
        ok "unit clipboard" "xsel reads the X11 clipboard under the service manager (DISPLAY=$UNIT_DISPLAY)"
      else
        bad "unit clipboard" "xsel fails under the service manager (DISPLAY=$UNIT_DISPLAY): $(head -n 1 "$TMP/unitclip.err")"
        hint "Usually XAUTHORITY is missing there:  systemctl --user import-environment XAUTHORITY"
        hint "then:  systemctl --user restart poe-price-daemon"
      fi
    fi
  fi
elif have systemctl; then
  na "unit environment" "no systemd-run or no user session — cannot ask the service manager"
fi

# ---- 6. backend -------------------------------------------------------------
section "6. Backend"
BACKEND_UP=0
BACKEND_LANG=''
USER_KNOWN=''
BASE="${CFG_BACKEND%/}"

if [ "$MODE" = offline ]; then
  na "backend" "--offline"
elif [ -z "$BASE" ]; then
  bad "backend" "no backend_url in the config — nothing to reach"
elif ! have curl; then
  bad "backend" "curl is missing"
else
  code="$(run 10 curl -s -o "$TMP/health" -w '%{http_code}' "$BASE/health" 2>"$TMP/curl.err")"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "GET /health" "cannot reach $BASE (curl exit $rc)"
    hint "$(head -n 1 "$TMP/curl.err")"
    hint "Check that the backend runs and that backend_url points at it — on a server install"
    hint "the default 127.0.0.1 in the example config reaches nothing but your own machine."
  else
    case "$code" in
      200) ok "GET /health" "$BASE"; BACKEND_UP=1 ;;
      301|302|307|308)
        bad "GET /health" "$BASE answered $code (redirect)"
        hint "The POST deliberately does not follow redirects: with an http:// URL behind a proxy"
        hint "that forces HTTPS, every item is lost silently. Write https:// in backend_url." ;;
      *)   bad "GET /health" "$BASE answered $code" ;;
    esac
  fi

  if [ "$BACKEND_UP" = 1 ]; then
    if run 10 curl -s -o "$TMP/users" "$BASE/users" 2>/dev/null && [ -s "$TMP/users" ]; then
      if python3 - "$TMP/users" "$CFG_USER" >"$TMP/users.out" 2>/dev/null <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    data = json.load(fh)
me = sys.argv[2]
users = data.get('users') or []
langs = data.get('langs') or {}
print("users\t" + ", ".join(users))
print("known\t" + ("1" if me in users else "0"))
print("lang\t" + str(langs.get(me) or ''))
PY
      then
        while IFS=$'\t' read -r key value; do
          case "$key" in
            users) ALL_USERS="$value" ;;
            known) USER_KNOWN="$value" ;;
            lang)  BACKEND_LANG="$value" ;;
          esac
        done <"$TMP/users.out"
        if [ "$USER_KNOWN" = 1 ] && [ -n "$BACKEND_LANG" ]; then
          ok "user \"$CFG_USER\"" "known to the backend, reads its items as \"$BACKEND_LANG\""
        elif [ "$USER_KNOWN" = 1 ]; then
          ok "user \"$CFG_USER\"" "known to the backend (it names no language — a build from before per-user languages)"
        else
          bad "user \"$CFG_USER\"" "unknown to the backend — every item is rejected with 400"
          hint "The backend knows: ${ALL_USERS:-(none)}"
          hint "Either fix 'user' in $CFG or add it to POE_USERS on the server."
        fi
      else
        warn "GET /users" "answered, but the reply could not be read"
      fi
    else
      warn "GET /users" "no answer — an older backend without that endpoint?"
    fi
  fi
fi

# ---- 7. the real path -------------------------------------------------------
# The whole point of this script. Two stages on purpose, because the two
# failures look identical from the outside and are fixed in different places:
#
#   A. the filter in poe-price-post.sh — runs locally, no network at all. If the
#      sample is dropped here, the configured prefix does not match the language
#      the item is written in, and NOTHING would ever reach the backend.
#   B. the backend — only reached if A passed, so a failure here can never be
#      mistaken for a prefix problem.
section "7. Test parse (end to end)"

SAMPLE_FILE=''
SAMPLE_LANG=''
prefix_matches() {   # $1 = text; matches the way poe-price-post.sh matches
  local text="$1" p
  for p in "${PREFIXES[@]}"; do
    case "$text" in "$p"*) return 0 ;; esac
  done
  return 1
}

if [ "$CFG_READ" != 1 ]; then
  # Without the config we do not know the prefixes, and guessing them here
  # would make this script the second place that decides what an item looks
  # like — exactly the mistake the whole language change was about.
  na "test parse" "the config could not be read (see step 0) — nothing to test against"
elif [ ! -d "$SAMPLE_DIR" ]; then
  bad "sample" "$SAMPLE_DIR is missing — incomplete checkout?"
elif [ -n "$BACKEND_LANG" ] && [ -r "$SAMPLE_DIR/$BACKEND_LANG.txt" ]; then
  # The backend told us which language it reads this user's items in, so that
  # is the language the test has to be run in — not whichever sample happens
  # to match the configured prefix.
  SAMPLE_FILE="$SAMPLE_DIR/$BACKEND_LANG.txt"
  SAMPLE_LANG="$BACKEND_LANG"
  ok "sample" "$SAMPLE_LANG (the language the backend reads for \"$CFG_USER\")"
elif [ -n "$BACKEND_LANG" ]; then
  warn "sample" "the backend reads \"$CFG_USER\" as \"$BACKEND_LANG\", but there is no $BACKEND_LANG.txt here"
  hint "Add one to $SAMPLE_DIR to get an end-to-end check for that language."
fi

if [ "$CFG_READ" = 1 ] && [ -z "$SAMPLE_FILE" ] && [ -d "$SAMPLE_DIR" ]; then
  # No backend, or no sample for its language: fall back to whatever sample the
  # configured prefix matches. That still proves the filter half locally.
  for candidate in "$SAMPLE_DIR"/*.txt; do
    [ -r "$candidate" ] || continue
    if prefix_matches "$(head -n 1 "$candidate")"; then
      SAMPLE_FILE="$candidate"
      SAMPLE_LANG="$(basename "$candidate" .txt)"
      break
    fi
  done
  [ -n "$SAMPLE_FILE" ] && ok "sample" "$SAMPLE_LANG (chosen by the configured prefix)"
fi

if [ "$CFG_READ" = 1 ] && [ -z "$SAMPLE_FILE" ] && [ -d "$SAMPLE_DIR" ]; then
  bad "sample" "no sample item matches any configured prefix"
  hint "Configured: $(printf '"%s" ' "${PREFIXES[@]}")"
  hint "Samples here start with: $(for f in "$SAMPLE_DIR"/*.txt; do printf '"%s" ' "$(head -n 1 "$f" | cut -c1-24)"; done)"
fi

if [ -n "$SAMPLE_FILE" ]; then
  SAMPLE="$(cat "$SAMPLE_FILE")"
  FILTER_PASSED=0

  # --- stage A: the real filter, with the real configured prefixes -----------
  # A stub `curl` on PATH keeps this stage strictly local: the handler writes
  # its dedup marker just before POSTing, so the marker is the observable
  # "the filter let it through" — and the POST itself goes nowhere. The stub
  # has to answer 200: the handler removes the marker again after a POST that
  # failed, so a stub that answered nothing would read as "dropped". The
  # temporary XDG_RUNTIME_DIR keeps the live dedup marker untouched, or the
  # next real copy of this item would be swallowed as a duplicate.
  mkdir -p "$TMP/bin" "$TMP/runtime"
  cat >"$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
# Stage A's curl: swallows the item and answers like a backend that took it
# (poe-price-post.sh reads the status from the last line, see its -w).
cat >/dev/null
printf '{}\n200 '
STUB
  chmod +x "$TMP/bin/curl"
  printf '%s' "$SAMPLE" | PATH="$TMP/bin:$PATH" \
    XDG_RUNTIME_DIR="$TMP/runtime" \
    PPT_BACKEND_URL="$BASE" \
    PPT_USER="$CFG_USER" \
    PPT_ITEM_PREFIXES="$(printf '%s\n' "${PREFIXES[@]}")" \
    bash "$POST" >/dev/null 2>&1
  if [ -e "$TMP/runtime/ppt-last-posted" ]; then
    FILTER_PASSED=1
    ok "filter" "the $SAMPLE_LANG sample passes poe-price-post.sh"
  else
    bad "filter" "the $SAMPLE_LANG sample is DROPPED before it ever leaves this machine"
    hint "This is a prefix problem, not a backend problem — the backend is never contacted."
    hint "The item starts with: \"$(head -n 1 "$SAMPLE_FILE" | cut -c1-24)…\""
    hint "item_prefixes has:    $(printf '"%s" ' "${PREFIXES[@]}")"
    [ "$PREFIX_DEFAULTED" = 1 ] && hint "…because item_prefixes is not set at all and defaults to English."
    hint "Fix it in $CFG, then:  systemctl --user restart poe-price-daemon"
  fi

  # --- stage B: the backend --------------------------------------------------
  if [ "$MODE" = offline ]; then
    na "test parse" "--offline — the filter half above still ran"
  elif [ "$BACKEND_UP" != 1 ]; then
    na "test parse" "backend not reachable (see step 6) — the filter half above still ran"
  elif [ "$CFG_IS_EXAMPLE" = 1 ]; then
    na "test parse" "no installed config — would post as the example's placeholder user"
  else
    hint "posting one real item now — same request as your hotkey (one card, one trade search)"
    code="$(printf '%s' "$SAMPLE" | run 20 curl -s -o "$TMP/post" -w '%{http_code}' \
      -X POST -H "X-User: $CFG_USER" --data-binary @- "$BASE/item" 2>"$TMP/post.err")"
    rc=$?
    body="$(head -c 400 "$TMP/post" 2>/dev/null)"
    if [ "$rc" -ne 0 ]; then
      bad "POST /item" "cannot reach $BASE (curl exit $rc)"
    else
      case "$code" in
        200)
          ok "POST /item" "the backend parsed the $SAMPLE_LANG item"
          hint "A card for \"$(sed -n '3p' "$SAMPLE_FILE")\" should be in the browser now."
          case "$body" in *'"deduped":true'*) hint "(deduped — you ran this a moment ago; the existing card was re-asserted)" ;; esac
          ;;
        400)
          case "$body" in
            *'unknown user'*)
              bad "POST /item" "the backend does not know the user \"$CFG_USER\" (400)"
              hint "$body"
              hint "Fix 'user' in $CFG or add it to POE_USERS on the server." ;;
            *)
              bad "POST /item" "the backend could not parse the $SAMPLE_LANG item (400)"
              hint "$body"
              hint "The prefix and the user are fine — this is a parser or data problem."
              hint "The sample can also simply be older than the game data; check with a real item"
              hint "before concluding the installation is broken, and see the admin gap view." ;;
          esac ;;
        503)
          case "$body" in
            *'no parser for language'*)
              bad "POST /item" "language \"${BACKEND_LANG:-?}\" is configured but has no data set (503)"
              hint "$body"
              hint "The backend refuses rather than parsing German text with the English parser."
              hint "Server side: the data set for that language has to be generated — see docs/runbooks.md, \"A language was just switched on\"." ;;
            *)
              bad "POST /item" "503 — $body" ;;
          esac ;;
        *)
          bad "POST /item" "unexpected status $code"
          hint "$body" ;;
      esac
    fi
  fi

  if [ "$FILTER_PASSED" = 0 ] && [ "$BACKEND_UP" = 1 ]; then
    hint "Note the split above: the backend answered, so 'nothing happens in the browser'"
    hint "is the filter, not the connection."
  fi
fi

# ---- 8. the back channel ----------------------------------------------------
# A daemon new enough reads its results from GET /daemon/events, never from the
# browser's WebSocket. wait=0 answers at once; no heartbeat is sent from here
# (it would tell the server a daemon is running).
section "8. Back channel (results in the game)"
if [ "$CFG_BACK_CHANNEL" != 1 ]; then
  na "back channel" "off in config.toml ([link] back_channel) — results stay in the browser"
elif [ "$MODE" = offline ]; then
  na "back channel" "--offline"
elif [ "$BACKEND_UP" != 1 ]; then
  na "back channel" "backend not reachable (see step 6)"
else
  resp="$(run 5 curl -sS -H "X-User: $CFG_USER" -H 'X-PPT-Daemon: selftest' \
    -w '\n%{http_code}' "$BASE/daemon/events?wait=0" 2>"$TMP/events.err")"
  rc=$?
  code="${resp##*$'\n'}"
  ebody="${resp%$'\n'*}"
  if [ "$rc" -ne 0 ]; then
    bad "back channel" "GET /daemon/events: no answer (curl exit $rc): $(head -n 1 "$TMP/events.err")"
  else
    case "$code" in
      200)
        case "$ebody" in
          *'"v":1'*) ok "back channel" "available — prices also show in the game" ;;
          *) bad "back channel" "GET /daemon/events answered 200 with something else: $(printf '%s' "$ebody" | head -n 1 | cut -c1-120)"
             hint "A reverse proxy's page? backend_url must point at the backend itself." ;;
        esac ;;
      404|405)
        warn "back channel" "server older than this daemon — results only in the browser"
        hint "Whoever runs the server: update it (docs/admin.md, \"Update procedure\")." ;;
      *)
        bad "back channel" "GET /daemon/events answered $code: $(printf '%s' "$ebody" | head -n 1 | cut -c1-120)" ;;
    esac
  fi
fi

# ---- 9. notification --------------------------------------------------------
# What this shell sees is checked here; whether a notification sent by the
# service really appears can only be seen on the screen (README, Known issues).
section "9. Notification"
if [ "$CFG_NOTIFY" != 1 ]; then
  na "notification" "off in config.toml ([results] notify)"
else
  if have notify-send; then
    ok "notify-send" "$(command -v notify-send)"
  else
    warn "notify-send" "missing — results in the game need it; the price check works without"
    hint "It is part of libnotify (Arch: libnotify, Debian/Ubuntu: libnotify-bin)."
  fi
  # The service manager's environment, by NAME only: the address is never printed.
  SESSION_BUS=0
  if have systemctl && run 5 systemctl --user show-environment >"$TMP/busenv" 2>/dev/null \
     && grep -q '^DBUS_SESSION_BUS_ADDRESS=' "$TMP/busenv"; then
    SESSION_BUS=1
  elif [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then
    SESSION_BUS=1
  fi
  if [ "$SESSION_BUS" = 1 ]; then
    ok "session bus" "the service can reach the notification service"
  else
    warn "session bus" "the service sees no session bus — notifications cannot be shown"
    hint "From your desktop session:  systemctl --user import-environment DBUS_SESSION_BUS_ADDRESS"
  fi
  case "${XDG_CURRENT_DESKTOP:-}" in
    *KDE*|*kde*)
      if have kreadconfig6; then
        held="$(run 3 kreadconfig6 --file plasmanotifyrc --group DoNotDisturb --key WhenFullscreen --default true 2>/dev/null)"
        if [ "$held" = true ]; then
          warn "fullscreen" "KDE holds notifications back while a fullscreen window has focus"
          hint "With the game fullscreen, a result notification does not reach you (the overlay does). Switch it off:"
          hint "System Settings → Notifications → Do Not Disturb mode → Enable automatically:"
          hint "untick \"While a fullscreen application is focused\"."
        else
          ok "fullscreen" "KDE shows notifications over a fullscreen game"
        fi
      else
        na "fullscreen" "kreadconfig6 missing — cannot read KDE's Do Not Disturb setting"
      fi ;;
  esac
fi

overlay_section

# ---- 11. buyer whispers -----------------------------------------------------
# The daemon reads the game's Client.txt for incoming trade whispers. Checked
# here: the configured file (and whether another one found was written later),
# and in its last 1 MB how many lines are whispers and how many carry a
# configured incoming marker. The whispers you send (@To, @An, ...) prove nothing
# about the incoming marker, so a log with only those is "cannot be checked".
# Only counts, sizes, ages, markers and paths are printed: a line of the log
# names other players.
section "11. Whispers"
if [ "$CFG_READ" != 1 ]; then
  na "whispers" "config not readable (see section 0)"
else
  run 10 python3 - "$CFG_CLIENT_LOG" "${CFG_MARKERS[@]}" >"$TMP/whisper" 2>"$TMP/whisper.err" <<'PY'
import glob, os, re, stat, sys, time
path, markers = sys.argv[1], sys.argv[2:]
# The marker of the whispers YOU send: English "@To". German "@An", French
# "@À", Spanish and Portuguese "@Para" and Russian "@Кому" are from SlimTrade's
# patterns (LangRegex.java, MIT, (c) 2020 zmilla93), not seen in a real log;
# SlimTrade has them in lower case and compares without regard to case, so the
# capital first letter is assumed, after the English "@To". Compared exactly,
# like the incoming markers.
OUTGOING = ("@To", "@An", "@À", "@Para", "@Кому")
def emit(*a):
    print("\t".join(str(x) for x in a))
def ago(age):
    return ("just now" if age < 5 else f"{int(age)} s ago" if age < 60 else f"{int(age // 60)} min ago"
            if age < 3600 else f"{int(age // 3600)} h ago" if age < 86400 else f"{int(age // 86400)} d ago")
# Logs this machine has: Steam (its own library and the others it lists),
# Lutris/Wine prefixes under ~/Games, and ~/.wine. Paths only.
LOG = os.path.join("steamapps", "common", "Path of Exile", "logs", "Client.txt")
WINE = os.path.join("drive_c", "Program Files (x86)", "Grinding Gear Games", "Path of Exile", "logs", "Client.txt")
found, seen = [], set()
def add(p):
    try:
        if not os.path.isfile(p):
            return
        real = os.path.realpath(p)
    except OSError:
        return
    if real not in seen:
        seen.add(real)
        found.append(p)
for root in (os.path.expanduser("~/.steam/steam"), os.path.expanduser("~/.local/share/Steam")):
    add(os.path.join(root, LOG))
    try:
        with open(os.path.join(root, "steamapps", "libraryfolders.vdf"), encoding="utf-8", errors="replace") as fh:
            vdf = fh.read(1 << 20)
    except OSError:
        continue
    for lib in re.findall(r'"path"\s+"([^"]+)"', vdf):
        add(os.path.join(lib.replace("\\\\", "\\"), LOG))
for p in sorted(glob.glob(os.path.join(os.path.expanduser("~/Games"), "*", WINE))):
    add(p)
add(os.path.join(os.path.expanduser("~/.wine"), WINE))
for p in found:
    emit("found", p)
if not path:
    sys.exit(0)
path = os.path.expanduser(path)
try:
    st = os.stat(path)
except FileNotFoundError:
    emit("file", "missing", path); sys.exit(0)
except OSError as ex:
    emit("file", "unreadable", path, ex.strerror or type(ex).__name__); sys.exit(0)
if not stat.S_ISREG(st.st_mode):
    emit("file", "not-a-file", path); sys.exit(0)
try:
    with open(path, "rb") as fh:
        fh.seek(max(0, st.st_size - 1048576))
        tail = fh.read(1048576).decode("utf-8", "replace")
except OSError as ex:
    emit("file", "unreadable", path, ex.strerror or type(ex).__name__); sys.exit(0)
size = f"{st.st_size / 1048576:.1f} MB" if st.st_size >= 1048576 else f"{st.st_size / 1024:.1f} KB"
now = time.time()
age = max(0, now - st.st_mtime)
emit("file", "ok", path, size, ago(age))
# Older than a day while another log found was written later: client_log may
# name a log the game no longer writes (another library, an old prefix).
if age >= 86400:
    for p in found:
        try:
            other = os.stat(p)
            if os.path.realpath(p) != os.path.realpath(path) and other.st_mtime > st.st_mtime:
                emit("newer", p, ago(max(0, now - other.st_mtime)))
        except OSError:
            pass
lines = tail.splitlines()
# A whisper line is '] @<marker> [<GUILD> ]<name>: '; only the marker is kept.
# The Russian incoming marker has a space inside ("@От кого").
written = sorted({m.group(1) for m in (re.search(r"\] (@От кого|@[^\s:<>]{1,12}) (?:<[^>]*> )?[^\s:]+: ", l) for l in lines) if m})
whisper = [l for l in lines if "] @" in l]
sent = sum(1 for l in whisper if any(f"] {m} " in l for m in OUTGOING))
# Whisper lines that are not ones you sent, and the markers among them this
# config does not know.
emit("whispers", len(whisper) - sent, ", ".join(m for m in written if m not in OUTGOING and m not in markers))
emit("outgoing", sent, ", ".join(m for m in written if m in OUTGOING))
for marker in markers:
    if marker in OUTGOING:
        emit("sent-marker", marker)
    else:
        emit("marker", marker, sum(1 for l in lines if f"] {marker} " in l))
PY
  FOUND=()
  W_STATE=''; W_PATH=''; W_SIZE=''; W_WHEN=''; W_DETAIL=''; W_TOTAL=0; W_WRITTEN=''; W_HITS=()
  W_SENT=0; W_SENT_MARKERS=''; W_NEWER=(); W_SENT_CFG=()
  while IFS=$'\t' read -r kind a b c d; do
    case "$kind" in
      found)    FOUND+=("$a") ;;
      file)     W_STATE="$a"; W_PATH="$b"; W_SIZE="$c"; W_WHEN="$d"; W_DETAIL="$c" ;;
      newer)    W_NEWER+=("$a (written $b)") ;;
      whispers) W_TOTAL="$a"; W_WRITTEN="$b" ;;
      outgoing) W_SENT="$a"; W_SENT_MARKERS="$b" ;;
      marker)   [ "$b" -gt 0 ] 2>/dev/null && W_HITS+=("$b incoming whisper line(s) with $a") ;;
      sent-marker) W_SENT_CFG+=("$a") ;;
    esac
  done <"$TMP/whisper"
  list_found() {
    hint "Client.txt files found:"
    if [ "${#FOUND[@]}" -eq 0 ]; then
      hint "  none found — a game outside Steam, ~/Games and ~/.wine: set client_log by hand"
    else
      for f in "${FOUND[@]}"; do hint "  $f"; done
    fi
  }
  if [ -s "$TMP/whisper.err" ] && [ -z "$W_STATE" ] && [ -n "$CFG_CLIENT_LOG" ]; then
    warn "whispers" "the check itself failed: $(head -n 1 "$TMP/whisper.err" | cut -c1-160)"
  elif [ -z "$CFG_CLIENT_LOG" ]; then
    na "whispers" "off (client_log not set)"
    if [ "${#FOUND[@]}" -gt 0 ]; then
      hint "To check buyer whispers, set client_log in [whispers] of $CFG to one of:"
      for f in "${FOUND[@]}"; do hint "  $f"; done
    fi
  else
    case "$W_STATE" in
      ok)
        if [ "${#W_NEWER[@]}" -gt 0 ]; then
          warn "whispers" "$W_PATH ($W_SIZE, written $W_WHEN) — another Client.txt was written later"
          hint "client_log may name a log the game no longer writes (another Steam library, an old Wine prefix). Written later:"
          for f in "${W_NEWER[@]}"; do hint "  $f"; done
          hint "If the game runs from one of these, set client_log in [whispers] of $CFG to it, then: systemctl --user restart poe-price-daemon"
        else
          ok "whispers" "$W_PATH ($W_SIZE, written $W_WHEN)"
        fi
        for m in "${W_SENT_CFG[@]}"; do
          warn "outgoing marker" "$m in incoming_markers marks the whispers YOU send — your own would be checked as a buyer's"
          hint "Remove $m from incoming_markers in [whispers] of $CFG."
        done
        if [ "${#W_HITS[@]}" -gt 0 ]; then
          ok "incoming marker" "$(printf '%s; ' "${W_HITS[@]}" | sed 's/; $//') in its last 1 MB"
        elif [ "${W_TOTAL:-0}" -gt 0 ]; then
          warn "incoming marker" "your client writes ${W_WRITTEN:-@…} lines, but none with $(printf '%s ' "${CFG_MARKERS[@]}" | sed 's/ $//')"
          hint "Add the marker your client language writes to incoming_markers in [whispers] of $CFG."
        elif [ "${W_SENT:-0}" -gt 0 ]; then
          na "incoming marker" "only outgoing whispers (${W_SENT_MARKERS:-@To}) in its last 1 MB — the marker cannot be checked"
        else
          na "incoming marker" "no whisper lines in its last 1 MB yet — the marker cannot be checked"
        fi ;;
      missing)
        bad "whispers" "$W_PATH does not exist — no whisper is shown"
        list_found
        hint "Set client_log in [whispers] of $CFG, then: systemctl --user restart poe-price-daemon" ;;
      not-a-file)
        bad "whispers" "$W_PATH is not a file — point client_log at logs/Client.txt itself" ;;
      *)
        bad "whispers" "$W_PATH cannot be read (${W_DETAIL:-no detail})"
        hint "Check its permissions: ls -l \"$W_PATH\"" ;;
    esac
  fi
fi

# ---- 12. game detection -----------------------------------------------------
# The same check the daemon makes (ppt_presence.GameProbe.check_once): a window
# of poe_window_class on this display, by `xdotool search`. 'Not running' only
# counts after the daemon found the window once on this display (its seen
# file); before that it is "never seen", and the sync keeps its normal pace.
# Prints the verdict only, never a window id or another program's window name.
section "12. Game detection (sync follows the game)"
if [ "$CFG_READ" != 1 ]; then
  na "game detection" "config not readable (see section 0)"
elif [ "$CFG_REPORT_GAME" != 1 ]; then
  na "game detection" "off in config.toml ([presence] report_game = false)"
elif ! have python3; then
  na "game detection" "python3 missing (see section 1)"
else
  run 10 python3 -B - "$DIR" "$CFG_WINCLASS" >"$TMP/game" 2>"$TMP/game.err" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from ppt_presence import GameProbe
probe = GameProbe(sys.argv[2], None)
state = probe.check_once()
print(f"{state}\t{probe.reason()}")
PY
  G_STATE=''; G_REASON=''
  IFS=$'\t' read -r G_STATE G_REASON <"$TMP/game" 2>/dev/null
  case "$G_STATE" in
    running)
      ok "game window" "game window found (window class $CFG_WINCLASS)" ;;
    absent)
      na "game window" "no game window — start the game and run this again to see it found" ;;
    unknown)
      case "$G_REASON" in
        never-seen)
          warn "game window" "class $CFG_WINCLASS never seen yet — start the game once so the daemon learns the window; until then your sync keeps its normal pace"
          hint "With the game running, this section says \"game window found\". If it does not, poe_window_class in $CFG is not the game's window class."
          hint "If the daemon found the window before and this still says never seen, its journal names a game-seen.json it could not write." ;;
        no-display)
          warn "game window" "cannot tell (no-display) — the sync keeps its normal pace for you"
          hint "Run this from a terminal in your desktop session; section 5 says whether the service has DISPLAY." ;;
        no-xdotool)
          warn "game window" "cannot tell (no-xdotool) — the sync keeps its normal pace for you"
          hint "Install xdotool (see section 1), then: systemctl --user restart poe-price-daemon" ;;
        *)
          warn "game window" "cannot tell (${G_REASON:-error}) — the sync keeps its normal pace for you" ;;
      esac ;;
    *)
      warn "game detection" "the check itself failed: $(head -n 1 "$TMP/game.err" | cut -c1-160)" ;;
  esac
fi

grid_section

# ---- 14. session key --------------------------------------------------------
# [session] key starts or ends a farm session (POST /daemon/session). The
# daemon reads it through evdev like the macro keys, and acts on a press only
# while the game has focus, which it checks with xdotool and xprop. [session]
# cards: whether the server's session events (the baseline set, the end, the
# balance, the game sessions) show in the game; they come through the back
# channel ([link] back_channel). The rules are the daemon's own
# (poe-price-daemon.py, PriceDaemon.__init__); nothing is sent from here.
section "14. Session key"
if [ "$CFG_READ" != 1 ]; then
  na "session key" "config not readable (see section 0)"
elif ! have python3; then
  na "session key" "python3 missing (see section 1)"
else
  run 10 python3 -B - "$CFG" >"$TMP/session" 2>"$TMP/session.err" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as fh:
    cfg = tomllib.load(fh)
def emit(*a):
    print("\t".join(str(x) for x in a))
sec = cfg.get("session", {})
if not isinstance(sec, dict):
    emit("key", "table", "")
    sys.exit(0)
key = sec.get("key", "")
if not isinstance(key, str):
    emit("key", "bad", repr(key)[:40])
elif not key.strip():
    emit("key", "empty", "")
else:
    key = key.strip()
    macros = cfg.get("macros")
    keys = macros.get("keys") if isinstance(macros, dict) else None
    w = cfg.get("whispers") if isinstance(cfg.get("whispers"), dict) else {}
    hk = w.get("highlight_key", "")
    try:
        from evdev import ecodes
        known = hasattr(ecodes, "KEY_" + key.upper())
    except Exception:
        known = None
    if isinstance(keys, dict) and any(str(k).upper() == key.upper() for k in keys):
        emit("key", "macro", key)
    elif isinstance(hk, str) and hk.strip().upper() == key.upper():
        emit("key", "highlight", key)
    elif known is None:
        emit("key", "no-evdev", key)
    else:
        emit("key", "ok" if known else "unknown", key)
cards = sec.get("cards", True)
emit("cards", "on" if cards is True else "off" if cards is False else "bad", "")
PY
  S_KEY=''; S_NAME=''; S_CARDS=''
  while IFS=$'\t' read -r kind a b; do
    case "$kind" in
      key)   S_KEY="$a"; S_NAME="$b" ;;
      cards) S_CARDS="$a" ;;
    esac
  done <"$TMP/session"
  [ -n "$S_KEY" ] || warn "session key" "the check itself failed: $(head -n 1 "$TMP/session.err" | cut -c1-160)"
  case "$S_KEY" in
    table)     bad "session key" "[session] must be a table — the daemon will not start" ;;
    empty)     na "session key" "off ([session] key is empty)" ;;
    bad)       bad "session key" "[session] key must be a text (got $S_NAME) — the daemon will not start" ;;
    macro)     bad "session key" "$S_NAME is also a key in [macros.keys] — the daemon will not start" ;;
    highlight) bad "session key" "$S_NAME is also [whispers] highlight_key — the daemon will not start" ;;
    unknown)   bad "session key" "$S_NAME is not a key name evdev knows (names like F11, KP1, DOT) — the daemon will not start" ;;
    no-evdev)  warn "session key" "$S_NAME cannot be checked: python-evdev is missing (see section 1); without it the daemon does not start at all" ;;
    ok)        ok "session key" "$S_NAME (pressed while the game has focus: starts or ends a farm session)" ;;
  esac
  if [ "$S_KEY" = ok ] || [ "$S_KEY" = no-evdev ]; then
    if id -nG 2>/dev/null | grep -qw input; then
      ok "session input" "$WHOAMI is in the 'input' group"
    else
      bad "session input" "$WHOAMI is not in the 'input' group — the session key will never be seen"
      hint "Arch/Garuda:  sudo usermod -aG input $WHOAMI    (then log out and back in)"
    fi
    if have xdotool && have xprop; then
      ok "session focus" "xdotool and xprop present (the key works only while the game has focus)"
    else
      bad "session focus" "xdotool/xprop missing — the key works only while the game has focus, and that cannot be checked; the key does nothing"
      hint "Arch: xdotool xorg-xprop; Debian/Ubuntu: xdotool x11-utils."
    fi
  fi
  case "$S_CARDS" in
    bad) bad "session cards" "[session] cards must be true or false — the daemon will not start" ;;
    off) na "session cards" "off ([session] cards = false): only the answer to a press is shown" ;;
    on)
      if [ "$CFG_BACK_CHANNEL" = 0 ]; then
        warn "session cards" "the back channel is off ([link] back_channel = false) — only the answer to a press is shown"
      else
        ok "session cards" "on: game and farm sessions show in the game (overlay or notification)"
      fi ;;
  esac
fi

# ---- 15. value key ----------------------------------------------------------
# [stash_grid] value_key shows over the stash what each item of a tab is
# worth (GET /daemon/stash-grid: the server's store, never the stash API). The
# daemon reads the key through evdev like the macro keys and acts on a press
# only while the game has focus (xdotool and xprop). value_min_c, value_hold_s
# and value_tabs are read with the daemon's own code
# (ppt_value_grid.read_value_config). The route is asked once, without a tab,
# with the daemon headers, when the backend answered in step 6.
section "15. Value key"
if [ "$CFG_READ" != 1 ]; then
  na "value key" "config not readable (see section 0)"
elif ! have python3; then
  na "value key" "python3 missing (see section 1)"
else
  run 10 python3 -B - "$DIR" "$CFG" >"$TMP/value" 2>"$TMP/value.err" <<'PY'
import sys, tomllib
sys.path.insert(0, sys.argv[1])
from ppt_value_grid import read_value_config
with open(sys.argv[2], "rb") as fh:
    cfg = tomllib.load(fh)
def emit(*a):
    print("\t".join(str(x) for x in a))
sec = cfg.get("stash_grid", {})
if not isinstance(sec, dict):
    emit("key", "table", "")
    sys.exit(0)
emit("mode", "off" if sec.get("mode", "auto") == "off" else "on", "")
key = sec.get("value_key", "")
if not isinstance(key, str):
    emit("key", "bad", repr(key)[:40])
elif not key.strip():
    emit("key", "empty", "")
else:
    key = key.strip()
    macros = cfg.get("macros")
    keys = macros.get("keys") if isinstance(macros, dict) else None
    w = cfg.get("whispers") if isinstance(cfg.get("whispers"), dict) else {}
    hk = w.get("highlight_key", "")
    s = cfg.get("session") if isinstance(cfg.get("session"), dict) else {}
    sk = s.get("key", "")
    try:
        from evdev import ecodes
        known = hasattr(ecodes, "KEY_" + key.upper())
    except Exception:
        known = None
    if isinstance(keys, dict) and any(str(k).upper() == key.upper() for k in keys):
        emit("key", "macro", key)
    elif isinstance(hk, str) and hk.strip().upper() == key.upper():
        emit("key", "highlight", key)
    elif isinstance(sk, str) and sk.strip().upper() == key.upper():
        emit("key", "session", key)
    elif known is None:
        emit("key", "no-evdev", key)
    else:
        emit("key", "ok" if known else "unknown", key)
v, err = read_value_config({k: val for k, val in sec.items() if k != "value_key"})
if err:
    emit("settings", "bad", err)
else:
    tabs = ", ".join(f'"{t}"' for t in v["tabs"]) if v["tabs"] else "every tab with a grid"
    emit("settings", "ok", f"from {v['min_c']:g} c, {v['hold_s']:g} s a tab, {tabs}")
    for t in v["tabs"]:
        if "\t" not in t and "\n" not in t:
            emit("tab", t, "")
PY
  V_KEY=''; V_NAME=''; V_SET=''; V_SET_TEXT=''; V_MODE=''; V_TABS=()
  while IFS=$'\t' read -r kind a b; do
    case "$kind" in
      key)      V_KEY="$a"; V_NAME="$b" ;;
      settings) V_SET="$a"; V_SET_TEXT="$b" ;;
      mode)     V_MODE="$a" ;;
      tab)      V_TABS+=("$a") ;;
    esac
  done <"$TMP/value"
  [ -n "$V_KEY" ] || warn "value key" "the check itself failed: $(head -n 1 "$TMP/value.err" | cut -c1-160)"
  case "$V_KEY" in
    table)     na "value key" "[stash_grid] is no table (section 13 names it)" ;;
    empty)     na "value key" "off ([stash_grid] value_key is empty)" ;;
    bad)       bad "value key" "[stash_grid] value_key must be a text (got $V_NAME) — the daemon will not start" ;;
    macro)     bad "value key" "$V_NAME is also a key in [macros.keys] — the daemon will not start" ;;
    highlight) bad "value key" "$V_NAME is also [whispers] highlight_key — the daemon will not start" ;;
    session)   bad "value key" "$V_NAME is also [session] key — the daemon will not start" ;;
    unknown)   bad "value key" "$V_NAME is not a key name evdev knows (names like F9, KP1, DOT) — the daemon will not start" ;;
    no-evdev)  warn "value key" "$V_NAME cannot be checked: python-evdev is missing (see section 1); without it the daemon does not start at all" ;;
    ok)        ok "value key" "$V_NAME (pressed while the game has focus: what each item of a stash tab is worth)" ;;
  esac
  case "$V_SET" in
    bad) bad "value settings" "$V_SET_TEXT — the daemon will not start" ;;
    ok)  { [ "$V_KEY" = ok ] || [ "$V_KEY" = no-evdev ]; } && ok "value settings" "$V_SET_TEXT" ;;
  esac
  V_ON=0
  if { [ "$V_KEY" = ok ] || [ "$V_KEY" = no-evdev ]; } && [ "$V_MODE" = off ]; then
    na "value input" "[stash_grid] mode = \"off\": the daemon does not watch $V_NAME"
  elif [ "$V_KEY" = ok ] || [ "$V_KEY" = no-evdev ]; then
    V_ON=1
    if id -nG 2>/dev/null | grep -qw input; then
      ok "value input" "$WHOAMI is in the 'input' group"
    else
      bad "value input" "$WHOAMI is not in the 'input' group — the value key will never be seen"
      hint "Arch/Garuda:  sudo usermod -aG input $WHOAMI    (then log out and back in)"
    fi
    if have xdotool && have xprop; then
      ok "value focus" "xdotool and xprop present (the key works only while the game has focus)"
    else
      bad "value focus" "xdotool/xprop missing — the key works only while the game has focus, and that cannot be checked; the key does nothing"
      hint "Arch: xdotool xorg-xprop; Debian/Ubuntu: xdotool x11-utils."
    fi
    if [ "$CFG_OVERLAY" = off ]; then
      warn "value overlay" "the overlay is off ([results] overlay = \"off\") — the value grid comes as a notification of the 5 dearest items"
    fi
  fi
  if [ "$V_ON" = 1 ]; then
    if [ "$MODE" = offline ]; then
      na "value server" "--offline"
    elif [ "$BACKEND_UP" != 1 ]; then
      na "value server" "backend not reachable (see step 6)"
    else
      resp="$(run 5 curl -sS -H "X-User: $CFG_USER" -H 'X-PPT-Daemon: selftest' \
        -w '\n%{http_code}' "$BASE/daemon/stash-grid" 2>"$TMP/grid-route.err")"
      rc=$?
      code="${resp##*$'\n'}"
      printf '%s' "${resp%$'\n'*}" >"$TMP/grid-route.json"
      if [ "$rc" -ne 0 ]; then
        bad "value server" "GET /daemon/stash-grid: no answer (curl exit $rc): $(head -n 1 "$TMP/grid-route.err")"
      else
        case "$code" in
          200)
            if run 5 python3 -B - "$TMP/grid-route.json" "${V_TABS[@]}" >"$TMP/grid-route" 2>/dev/null <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)
tabs = data.get("tabs") if isinstance(data, dict) else None
if not isinstance(tabs, list):
    sys.exit(1)
tabs = [t for t in tabs if isinstance(t, dict)]
names = {t.get("name") for t in tabs}
print(f"count\t{len(tabs)}\t{sum(1 for t in tabs if t.get('grid') is True)}")
for n in sys.argv[2:]:
    if n not in names:
        print(f"unknown\t{n}\t")
PY
            then
              G_COUNT=''; G_GRID=''; G_UNKNOWN=()
              while IFS=$'\t' read -r kind a b; do
                case "$kind" in
                  count)   G_COUNT="$a"; G_GRID="$b" ;;
                  unknown) G_UNKNOWN+=("$a") ;;
                esac
              done <"$TMP/grid-route"
              if [ "${G_GRID:-0}" -gt 0 ]; then
                ok "value server" "$G_COUNT stored tab(s), $G_GRID with a grid"
              elif [ "${G_COUNT:-0}" -gt 0 ]; then
                warn "value server" "$G_COUNT stored tab(s), none with a grid yet — each gets its type and cells with its next sync read"
                hint "Only normal, premium and quad tabs have a grid; the Net Worth page shows the sync."
              else
                warn "value server" "no stored stash tab yet — the net-worth sync has not read your stash"
                hint "The Net Worth page shows the sync; a tab gets its cells with its next read."
              fi
              if [ "${#G_UNKNOWN[@]}" -gt 0 ]; then
                names="$(printf '"%s", ' "${G_UNKNOWN[@]}")"
                names="${names%, }"
                if [ "${#G_UNKNOWN[@]}" -eq 1 ]; then
                  warn "value tabs" "value_tabs names $names, which no stored tab has — the key skips it"
                else
                  warn "value tabs" "value_tabs names $names, which no stored tab has — the key skips them"
                fi
              fi
            else
              bad "value server" "GET /daemon/stash-grid answered 200 with something else: $(head -n 1 "$TMP/grid-route.json" | cut -c1-120)"
              hint "A reverse proxy's page? backend_url must point at the backend itself."
            fi ;;
          404|405)
            warn "value server" "server older than this daemon — the value key does nothing"
            hint "Whoever runs the server: update it (docs/runbooks.md, \"Update procedure\")." ;;
          429)
            warn "value server" "the server took too many value grid requests of $CFG_USER this minute — run this again in a minute" ;;
          *)
            bad "value server" "GET /daemon/stash-grid answered $code: $(head -n 1 "$TMP/grid-route.json" | cut -c1-120)" ;;
        esac
      fi
    fi
  fi
fi

# ---- result -----------------------------------------------------------------
result
