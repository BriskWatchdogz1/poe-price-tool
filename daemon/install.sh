#!/usr/bin/env bash
# poe-price-daemon — one-command installation (systemd --user).
# Checks prerequisites, creates the config, installs + starts the service.
set -euo pipefail

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"   # .../daemon
DAEMON="$DIR/poe-price-daemon.py"
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
CFG="$CFG_DIR/poe-price-daemon/config.toml"
UNIT="$CFG_DIR/systemd/user/poe-price-daemon.service"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

# 1) Check prerequisites (don't auto-install -> requires sudo/pacman). The list
# lives in selftest.sh — the very script the user runs later when something
# stops working, so there is ONE list instead of two that drift apart. It reads
# the config to decide what is actually required: with no [macros] section the
# chat-macro tools are not demanded here either.
if ! "$DIR/selftest.sh" --tools; then
  echo
  warn "Prerequisites are missing — nothing was installed."
  echo  "See README.md, \"Prerequisites\" — it lists what each tool is for, and has"
  echo  "its own table for immutable distributions (Bazzite, Silverblue, Kinoite),"
  echo  "where installing these the usual way is the WRONG move."
  echo
  echo  "Arch/Garuda, as one example:"
  echo  "  sudo pacman -S ydotool wl-clipboard xsel xdotool xorg-xprop python-evdev curl"
  echo  "Then run this script again."
  exit 1
fi

# Not prerequisites, so not gated above: the daemon runs without them. The
# tools check names a missing xdotool as a warning when game detection is on
# ([presence] report_game, the default), which does not stop the install.
echo "Optional: notify-send (libnotify) for results as a notification; PySide6 plus"
echo "xdotool and xprop (Arch: pyside6 xdotool xorg-xprop) for the overlay over the"
echo "game, which is shown only while the game has focus. xdotool also tells the"
echo "server whether your game runs, so the net-worth sync reads the stash of whoever"
echo "plays first (without it your sync keeps its normal pace). The self-test at the"
echo "end says which of them work."

# 2) Enable the ydotool daemon (used by the chat macros; price check itself
# needs no ydotool, just xsel (wl-paste fallback) + curl).
systemctl --user enable --now ydotool 2>/dev/null || warn "Could not enable ydotool service — is ydotoold running?"

# 3) Create config (only if none exists yet -> never overwrites).
if [ ! -f "$CFG" ]; then
  mkdir -p "$(dirname "$CFG")"
  cp "$DIR/config.example.toml" "$CFG"
  say "Config created: $CFG"
  NEED_EDIT=1
else
  echo "Config already present (untouched): $CFG"
fi

# 4) Write the systemd user unit (path points at THIS checkout -> not hardcoded).
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=poe-price-daemon — clipboard-watch price check + chat macros (poe-price-tool)
After=graphical-session.target ydotool.service
Wants=ydotool.service

[Service]
Type=simple
ExecStart=$(command -v python3) "$DAEMON"
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now poe-price-daemon.service
say "Service installed and started: poe-price-daemon.service"

# 5) Self-test: prove the installation instead of assuming it. This is the same
# script the user runs later when the tool "does nothing" — input group,
# clipboard, ydotoold, backend, and a real test parse in the language the
# backend reads for this user. It never exits the installer: the unit is
# already in place at this point, and a fresh install that still needs a config
# edit (step 3) is EXPECTED to have findings.
echo
say "Self-test:"
SELFTEST_RC=0
"$DIR/selftest.sh" || SELFTEST_RC=$?

echo
say "Done."
[ "${NEED_EDIT:-0}" = 1 ] && echo "Next step: adjust backend/user in $CFG, then:  systemctl --user restart poe-price-daemon"
[ "$SELFTEST_RC" != 0 ] && warn "The self-test found problems (see above). Re-run it any time:  ./daemon/selftest.sh"
echo "View status:  systemctl --user status poe-price-daemon"
