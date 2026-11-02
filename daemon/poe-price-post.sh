#!/usr/bin/env bash
# poe-price-post — clipboard handler for poe-price-daemon.
#
# The daemon polls the clipboard and, on a NEW value, runs this script with
# that value on OUR stdin (polling, not `wl-paste --watch`, because XWayland
# game copies don't reliably fire change events). We:
#   1. read stdin,
#   2. ignore anything that isn't a PoE item (see PPT_ITEM_PREFIXES),
#   3. skip if it's identical to the last item we posted (double-post guard),
#   4. POST it to the backend (POST /item with the X-User header).
#
# Env (passed down by the daemon from config.toml):
#   PPT_BACKEND_URL    Backend base URL. Default http://127.0.0.1:8788.
#   PPT_USER           User identity for multi-user routing (header X-User).
#   PPT_ITEM_PREFIXES  Newline-separated clipboard prefixes that mark a PoE
#                      item. The game writes that line in the CLIENT's language
#                      ("Item Class: " English, "Gegenstandsklasse: " German),
#                      so it comes from config.toml — never from this script.
set -uo pipefail

PPT_BACKEND_URL="${PPT_BACKEND_URL:-http://127.0.0.1:8788}"
PPT_USER="${PPT_USER:-player1}"
PPT_ITEM_PREFIXES="${PPT_ITEM_PREFIXES:-Item Class: }"

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
LASTFILE="$RUNTIME_DIR/ppt-last-posted"

# Empty or non-item stdin just falls through the case below and exits 0.
ITEM="$(cat)"

# Only PoE items -> ignore everything else that ever gets copied on the system.
# Still silent on a miss: every Ctrl+C in the game lands here. The installer
# self-test is what proves the path end-to-end with a real item.
MATCHED=0
while IFS= read -r PREFIX; do
  [ -n "$PREFIX" ] || continue
  case "$ITEM" in
    "$PREFIX"*) MATCHED=1; break ;;
  esac
done <<< "$PPT_ITEM_PREFIXES"
[ "$MATCHED" = 1 ] || exit 0

# Dedup against the last posted item (double-fire guard).
LAST=""
[ -r "$LASTFILE" ] && LAST="$(cat "$LASTFILE" 2>/dev/null || true)"
if [ "$ITEM" = "$LAST" ]; then
  exit 0
fi
printf '%s' "$ITEM" > "$LASTFILE" 2>/dev/null || true

printf '%s' "$ITEM" | curl -s --max-time 5 -X POST -H "X-User: $PPT_USER" --data-binary @- "${PPT_BACKEND_URL%/}/item" >/dev/null
