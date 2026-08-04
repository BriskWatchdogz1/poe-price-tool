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

# 1) Check prerequisites (don't auto-install -> requires sudo/pacman).
missing=()
for cmd in ydotool xdotool xprop xsel wl-paste curl python3; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
python3 -c 'import evdev' 2>/dev/null || missing+=("python-evdev")
python3 -c 'import tomllib' 2>/dev/null || missing+=("python>=3.11")
if [ "${#missing[@]}" -gt 0 ]; then
  warn "Missing prerequisites: ${missing[*]}"
  echo  "Install (Arch/Garuda):  sudo pacman -S ydotool wl-clipboard xsel xdotool xorg-xprop python-evdev curl"
  echo  "Then run this script again."
  exit 1
fi

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

# 5) Check the input group (evdev needs read access to /dev/input/event*).
if ! id -nG | grep -qw input; then
  warn "You are not in the 'input' group — the daemon won't see any keys otherwise."
  echo  "Fix (then log in again):  sudo usermod -aG input $USER"
fi

echo
say "Done."
[ "${NEED_EDIT:-0}" = 1 ] && echo "Next step: adjust backend/user in $CFG, then:  systemctl --user restart poe-price-daemon"
echo "View status:  systemctl --user status poe-price-daemon"
