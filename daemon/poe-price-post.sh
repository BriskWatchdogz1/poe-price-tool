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
# Exit status, as poe-price-daemon.py reads it (ppt_diag.post_outcome):
#   0  posted, the backend answered 2xx.
#   3  skipped: not a PoE item, or the same item as last time. Silent; with
#      PPT_DAEMON_VERSION set, a duplicate prints the one word same-item on
#      stdout (nothing else ever goes to stdout).
#   4  the POST failed. Exactly one line on stderr, of the form
#        [<kind>] <what happened>. Next: <what to do>
#      <kind> is stable per cause (unreachable-<curl exit>, http-<status>,
#      http-400-unknown-user, http-503-no-parser, no-curl), so the daemon can
#      throttle repeats of the same cause in its journal. unreachable-<curl
#      exit> covers every curl failure, also those where the server answered
#      and the exchange broke off (18, 56); the text tells them apart. The
#      line is bounded: quoted answers and curl's message are cut to
#      PPT_ERROR_BODY_MAX characters.
#   any other code: this handler itself is broken.
#
# Env (passed down by the daemon from config.toml):
#   PPT_BACKEND_URL     Backend base URL. Default http://127.0.0.1:8788.
#   PPT_USER            User identity for multi-user routing (header X-User).
#   PPT_ITEM_PREFIXES   Newline-separated clipboard prefixes that mark a PoE
#                       item. The game writes that line in the CLIENT's language
#                       ("Item Class: " English, "Gegenstandsklasse: " German),
#                       so it comes from config.toml — never from this script.
#   PPT_ERROR_BODY_MAX  How many characters of the server's answer a failure
#                       line quotes. Default 300.
#   PPT_POST_TIMEOUT    Seconds curl waits for the backend. Default 5.
#   PPT_DAEMON_VERSION  Set by a daemon new enough to read the back channel
#                       (GET /daemon/events). Only then are the headers
#                       X-PPT-Daemon and X-PPT-Instance sent and is a skipped
#                       duplicate named on stdout. An older daemon that is still
#                       running after a git pull does not set it, and this
#                       script then sends neither header. A value with
#                       other characters than letters, digits and . _ + - is
#                       sent as `unknown`.
#   PPT_INSTANCE        The daemon's random id for this run (header
#                       X-PPT-Instance). Letters and digits only, else unset.
set -uo pipefail

PPT_BACKEND_URL="${PPT_BACKEND_URL:-http://127.0.0.1:8788}"
PPT_USER="${PPT_USER:-player1}"
PPT_ITEM_PREFIXES="${PPT_ITEM_PREFIXES:-Item Class: }"
PPT_ERROR_BODY_MAX="${PPT_ERROR_BODY_MAX:-300}"
case "$PPT_ERROR_BODY_MAX" in ''|*[!0-9]*) PPT_ERROR_BODY_MAX=300 ;; esac
PPT_POST_TIMEOUT="${PPT_POST_TIMEOUT:-5}"
PPT_DAEMON_VERSION="${PPT_DAEMON_VERSION:-}"
case "$PPT_DAEMON_VERSION" in *[!A-Za-z0-9._+-]*) PPT_DAEMON_VERSION=unknown ;; esac
PPT_INSTANCE="${PPT_INSTANCE:-}"
case "$PPT_INSTANCE" in *[!A-Za-z0-9]*) PPT_INSTANCE='' ;; esac
DAEMONHDR=()
if [ -n "$PPT_DAEMON_VERSION" ]; then
  DAEMONHDR=(-H "X-PPT-Daemon: $PPT_DAEMON_VERSION")
  [ -n "$PPT_INSTANCE" ] && DAEMONHDR+=(-H "X-PPT-Instance: $PPT_INSTANCE")
fi

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
LASTFILE="$RUNTIME_DIR/ppt-last-posted"

# Empty or non-item stdin just falls through the case below and exits 3.
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
[ "$MATCHED" = 1 ] || exit 3

# Dedup against the last posted item (double-fire guard). Still silent: a
# double read of one copy lands here. A daemon that reads its back channel
# (PPT_DAEMON_VERSION) gets one word on stdout, so it can show the last result
# again without a request.
LAST=""
[ -r "$LASTFILE" ] && LAST="$(cat "$LASTFILE" 2>/dev/null || true)"
if [ "$ITEM" = "$LAST" ]; then
  [ -n "$PPT_DAEMON_VERSION" ] && printf 'same-item\n'
  exit 3
fi
# Written BEFORE the POST, so a second trigger during a running POST is caught.
printf '%s' "$ITEM" > "$LASTFILE" 2>/dev/null || true

URL="${PPT_BACKEND_URL%/}"

# One line on stderr, then exit 4 (the daemon logs it, throttled). The marker
# goes: a POST that failed did not post, so copying the same item again after
# the fix must not be swallowed as a duplicate.
fail () {
  rm -f "$LASTFILE" 2>/dev/null
  printf '[%s] %s\n' "$1" "$2" >&2
  exit 4
}

command -v curl >/dev/null 2>&1 || fail no-curl "POST /item failed: curl is not on the daemon's PATH. Next: install curl, then: systemctl --user restart poe-price-daemon"

# -sS: no progress meter, but curl's own message when it fails. The body and,
# LAST, status and redirect target (-w) go to stdout; curl's message goes to a
# file of its own. Mixed into one stream, a body cut off mid-transfer (curl exit
# 18, 56) came first and was quoted whole instead of curl's message. The file
# lives in the runtime dir (no mktemp: the daemon's PATH may be minimal); if
# that is not writable, curl's message is dropped rather than the POST.
# pipefail is off inside the substitution so that a reader closing stdin early
# cannot turn a delivered POST into a failure.
ERRFILE=/dev/null
if [ -d "$RUNTIME_DIR" ] && [ -w "$RUNTIME_DIR" ]; then
  ERRFILE="$RUNTIME_DIR/ppt-post-err.$$"
  trap 'rm -f "$ERRFILE" 2>/dev/null' EXIT
fi
RESP="$(set +o pipefail; printf '%s' "$ITEM" | curl -sS --max-time "$PPT_POST_TIMEOUT" -X POST \
  -H "X-User: $PPT_USER" ${DAEMONHDR[@]+"${DAEMONHDR[@]}"} --data-binary @- -w '\n%{http_code} %{redirect_url}' "$URL/item" 2>"$ERRFILE")"
RC=$?

if [ "$RC" -ne 0 ]; then
  # curl's message: its first non-empty line, cut like a server answer.
  WHY=""
  if [ "$ERRFILE" != /dev/null ] && [ -r "$ERRFILE" ]; then
    while IFS= read -r LINE || [ -n "$LINE" ]; do
      LINE="${LINE//$'\r'/}"
      [ -n "$LINE" ] && { WHY="$LINE"; break; }
    done < "$ERRFILE"
  fi
  [ "${#WHY}" -gt "$PPT_ERROR_BODY_MAX" ] && WHY="${WHY:0:$PPT_ERROR_BODY_MAX}…"
  # Only some exits mean that nothing answered; on the others (18, 52, 56, ...)
  # the server did answer, and the exchange broke off.
  case "$RC" in
    6|7|35|60) LEAD="cannot reach $URL" ;;
    28)        LEAD="no answer from $URL in time" ;;
    *)         LEAD="the exchange with $URL broke off" ;;
  esac
  case "$RC" in
    6)     NEXT="the host name in backend_url does not resolve; fix backend_url in config.toml" ;;
    7)     NEXT="nothing listens there; start the backend, or fix backend_url in config.toml ($URL/health must answer ok)" ;;
    28)    NEXT="the backend did not answer within ${PPT_POST_TIMEOUT} s; check whether it is hung or overloaded (its container log)" ;;
    35|60) NEXT="the TLS handshake failed; check the reverse proxy's certificate, or use the address the proxy really serves" ;;
    *)     NEXT="check that the backend runs and that backend_url in config.toml points at it" ;;
  esac
  fail "unreachable-$RC" "POST /item failed: $LEAD — ${WHY:-no message from curl} (curl exit $RC). Next: $NEXT."
fi

TAIL="${RESP##*$'\n'}"      # "<status> <redirect url>"
CODE="${TAIL%% *}"
LOCATION="${TAIL#* }"
BODY="${RESP%$'\n'*}"
case "$CODE" in 2??) exit 0 ;; esac

# The server's error answers are one short JSON object (server.mjs, POST
# /item) — quoted whole. Anything longer (a proxy's HTML error page) is cut.
BODY="${BODY//$'\r'/}"; BODY="${BODY//$'\n'/ }"
[ "${#BODY}" -gt "$PPT_ERROR_BODY_MAX" ] && BODY="${BODY:0:$PPT_ERROR_BODY_MAX}…"
[ -n "$BODY" ] || BODY="(empty answer)"

case "$CODE" in
  3??) fail "http-$CODE" "POST /item failed: $URL answered $CODE, a redirect to ${LOCATION:-(no location)}. Items are lost: the POST does not follow redirects. Next: write the https:// address into backend_url in config.toml, then: systemctl --user restart poe-price-daemon" ;;
  400) case "$BODY" in
         *'unknown user'*) fail http-400-unknown-user "POST /item rejected: HTTP 400 $BODY. Next: set user in config.toml to one of the users listed, or add \"$PPT_USER\" to POE_USERS on the server; then: systemctl --user restart poe-price-daemon" ;;
         *) fail http-400 "POST /item rejected: HTTP 400 $BODY. Next: the backend could not read this item; it is listed in the admin area of the settings page. If every item fails, run ./daemon/selftest.sh" ;;
       esac ;;
  503) case "$BODY" in
         *'no parser for language'*) fail http-503-no-parser "POST /item rejected: HTTP 503 $BODY. Next: the server has no data set for this user's client language yet; whoever runs the server: docs/admin.md, data auto-update" ;;
         *) fail http-503 "POST /item failed: HTTP 503 $BODY. Next: check the backend log" ;;
       esac ;;
  000) fail http-000 "POST /item failed: no HTTP answer from $URL. Next: check that backend_url points at the poe-price-tool backend" ;;
  *)   fail "http-$CODE" "POST /item failed: HTTP $CODE $BODY. Next: check that backend_url points at the poe-price-tool backend, and the backend log" ;;
esac
