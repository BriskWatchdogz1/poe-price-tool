#!/usr/bin/env bash
# poe-price-post — clipboard handler for poe-price-daemon.
#
# The daemon polls the clipboard and, on a NEW value, runs this script with
# that value on OUR stdin (polling, not `wl-paste --watch`, because XWayland
# game copies don't reliably fire change events). We:
#   1. read stdin,
#   2. ignore anything that isn't a PoE item ("Item Class: ..."),
#   3. skip if it's identical to the last item we posted (double-post guard),
#   4. POST it to the backend — same request the old inject-trigger used.
#
# Env (passed down by the daemon from config.toml):
#   PPT_BACKEND_URL  Backend base URL. Default http://127.0.0.1:8788.
#   PPT_USER         User identity for multi-user routing (header X-User).
set -uo pipefail

PPT_BACKEND_URL="${PPT_BACKEND_URL:-http://127.0.0.1:8788}"
PPT_USER="${PPT_USER:-player1}"

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
LASTFILE="$RUNTIME_DIR/ppt-last-posted"

# Empty or non-item stdin just falls through the case below and exits 0.
ITEM="$(cat)"

# Only PoE items -> ignore everything else that ever gets copied on the system.
case "$ITEM" in
  "Item Class: "*) ;;
  *) exit 0 ;;
esac

# Dedup against the last posted item (double-fire guard).
LAST=""
[ -r "$LASTFILE" ] && LAST="$(cat "$LASTFILE" 2>/dev/null || true)"
if [ "$ITEM" = "$LAST" ]; then
  exit 0
fi
printf '%s' "$ITEM" > "$LASTFILE" 2>/dev/null || true

printf '%s' "$ITEM" | curl -s --max-time 5 -X POST -H "X-User: $PPT_USER" --data-binary @- "${PPT_BACKEND_URL%/}/item" >/dev/null
