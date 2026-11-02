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
#   1. the tools the daemon needs — macro tools only if [macros] is configured,
#   2. clipboard access (the price check has no other input),
#   3. the `input` group (evdev; macros only),
#   4. ydotoold + /dev/uinput (macros only),
#   5. the daemon service,
#   6. the backend,
#   7. a real test parse: the sample item text for YOUR language goes through
#      the real filter (poe-price-post.sh) and then to the backend, and the
#      answer is classified — prefix mismatch, unknown user, missing language
#      data and unreachable backend are four different diagnoses here, not one
#      shrug.
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
    -h|--help) sed -n '2,43p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  hint "the price check will work sometimes and not others, with nothing in any log."
fi
have wl-paste && ok "wl-paste" "fallback present" || warn "wl-paste" "missing — no fallback if xsel/DISPLAY are unavailable"

for tool in ydotool xdotool xprop; do
  if [ "$CFG_MACROS" = 1 ]; then
    have "$tool" && ok "$tool" "" || bad "$tool" "missing — required by the configured chat macros"
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
# evdev needs read access to /dev/input/event* — but only the macros ever open a
# device. Without [macros] the daemon watches no keys at all, so the group is
# genuinely not applicable rather than quietly optional.
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
# back to wl-paste without a word (poe-price-daemon.py, _read_clipboard swallows
# FileNotFoundError), and the price check works "sometimes" — with nothing in
# any log to explain it. So: ask the user manager itself.
if have systemctl && have systemd-run && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  for tool in xsel xdotool xprop; do
    # Only claim a problem for tools this installation actually needs.
    case "$tool" in
      xsel) needed=1 ;;
      *)    [ "$CFG_MACROS" = 1 ] && needed=1 || needed=0 ;;
    esac
    [ "$needed" = 1 ] || continue
    if ! have "$tool"; then continue; fi   # already reported as missing in section 1
    if run 10 systemd-run --user --collect --wait --pipe --quiet \
         /usr/bin/env sh -c "command -v $tool" >"$TMP/unitpath" 2>"$TMP/unitpath.err"; then
      ok "unit sees $tool" "$(head -n 1 "$TMP/unitpath")"
    else
      bad "unit sees $tool" "$tool is on YOUR PATH but not the service manager's"
      hint "The daemon runs under systemd and will not find it. For xsel that means"
      hint "a silent fallback to wl-paste, which misses XWayland copies — the price"
      hint "check then works only sometimes, and nothing is logged."
      hint "Fix it for the user manager, not for your shell:"
      hint "  mkdir -p ~/.config/environment.d"
      hint "  printf 'PATH=%s:\$PATH\\n' \"\$(dirname \"\$(command -v $tool)\")\" \\"
      hint "    > ~/.config/environment.d/10-poe-price-daemon-path.conf"
      hint "  systemctl --user daemon-reexec && systemctl --user restart poe-price-daemon"
      hint "Then run this self-test again — this line has to turn green."
    fi
  done
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
  # "the filter let it through" — and the POST itself goes nowhere. The
  # temporary XDG_RUNTIME_DIR keeps the live dedup marker untouched, or the
  # next real copy of this item would be swallowed as a duplicate.
  mkdir -p "$TMP/bin" "$TMP/runtime"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$TMP/bin/curl"
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
              hint "Server side: the data set for that language has to be generated — see docs/admin.md." ;;
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

# ---- result -----------------------------------------------------------------
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
