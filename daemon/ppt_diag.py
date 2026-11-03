"""ppt_diag — the hotkey daemon's journal: one line per failure, throttled,
and the wording of every failure the daemon can name.

A module of its own, standard library only, so the tests
(backend/v2/daemon-diag.test.mjs) can import it without python-evdev.
Nothing in here touches a device, the clipboard or the network: the daemon
runs the subprocesses and hands their results in; this module decides what the
journal says about them and how often.

Every text has the same shape: what happened, then "Next:" and what to do.
Every failure has a key, a tuple whose first element is its category
(post, item, backend, clipboard, ydotool, for the way a result comes back
to the game: downlink, heartbeat, notify, overlay, and for buyer whispers:
whisper, the POST of one, and clientlog, the game's log file it is read
from). The same key is the same failure
for the throttle; recovered(category) closes all keys of one category at once.
"item" holds the one fault that belongs to a single item, not to the POST
path: the backend answered 400 because it could not read that item.
"""
import json
import re
import sys
import time

PREFIX = "[poe-price-daemon] "

# Mirror of the exit contract in poe-price-post.sh (its header): 0 posted,
# 3 skipped (not an item, or a duplicate), 4 failed with one tagged line on
# stderr. Any other code means the handler itself is broken.
POST_POSTED = 0
POST_SKIPPED = 3
POST_FAILED = 4

_TAGGED = re.compile(r"^\[([a-z0-9-]+)\] (.+)$")

# Tags of poe-price-post.sh that name a fault of one item. They go into the
# category "item": the next item that posts fine closes them without a
# "works again" line, because nothing was broken.
ITEM_TAGS = frozenset({"http-400"})


def first_line(text):
    """The first non-empty line of `text`, stripped; '' if there is none."""
    for line in str(text or "").splitlines():
        line = line.strip()
        if line:
            return line
    return ""


def _stderr_line(line):
    print(line, file=sys.stderr, flush=True)


class ThrottledLog:
    """One journal line per failure, not one per occurrence.

    The first occurrence of a key is written at once. The same key again is
    written at most once per `interval` seconds, numbered, with how many
    occurrences in between were not written. After `slow_after` such repeats
    the interval becomes `slow_interval` (None: never), so a failure that never
    stops does not fill the journal with a line a minute. recovered() closes
    a category, and the next failure in it is written at once again.
    """

    def __init__(self, interval, clock=time.monotonic, emit=None,
                 slow_interval=None, slow_after=None):
        self.interval = float(interval)
        self.slow_interval = None if slow_interval is None else float(slow_interval)
        self.slow_after = None if slow_after is None else int(slow_after)
        self.clock = clock
        self.emit = emit or _stderr_line
        self._open = {}  # key -> {"last", "suppressed", "total", "repeats"}

    def _interval_for(self, st):
        if self.slow_interval is not None and self.slow_after is not None \
                and st["repeats"] >= self.slow_after:
            return self.slow_interval
        return self.interval

    def failure(self, key, text):
        """Report one occurrence. True if a line was written."""
        now = self.clock()
        st = self._open.get(key)
        if st is None:
            self._open[key] = {"last": now, "suppressed": 0, "total": 1, "repeats": 0}
            self.emit(PREFIX + text)
            return True
        st["total"] += 1
        elapsed = now - st["last"]
        if elapsed < self._interval_for(st):
            st["suppressed"] += 1
            return False
        st["repeats"] += 1
        notes = [f"repeat {st['repeats']}"]
        if st["suppressed"]:
            notes.append(f"and {st['suppressed']} more time(s) in the last {int(elapsed)} s")
        if self.slow_interval is not None and self.slow_after is not None \
                and st["repeats"] == self.slow_after:
            notes.append(f"from now on at most every {int(self.slow_interval)} s")
        self.emit(f"{PREFIX}{text} ({'; '.join(notes)})")
        st["last"] = now
        st["suppressed"] = 0
        return True

    def recovered(self, category):
        """Close every open failure of `category`. Returns how many occurrences
        they had in all (0: nothing was open). Writes nothing itself."""
        n = 0
        for key in [k for k in self._open if k[0] == category]:
            n += self._open.pop(key)["total"]
        return n

    def info(self, text):
        """A line that is not a failure: written at once, never throttled."""
        self.emit(PREFIX + text)


def post_outcome(returncode, stderr_text, handler):
    """poe-price-post.sh's exit status and stderr -> (state, key, text);
    state is 'ok', 'skipped' or 'failed'."""
    if returncode == POST_POSTED:
        return ("ok", None, None)
    if returncode == POST_SKIPPED:
        return ("skipped", None, None)
    line = first_line(stderr_text)
    if returncode == POST_FAILED:
        m = _TAGGED.match(line)
        if m:
            category = "item" if m.group(1) in ITEM_TAGS else "post"
            return ("failed", (category, m.group(1)), m.group(2))
        return ("failed", ("post", "untagged"),
                f"POST /item failed: {line or 'the handler gave no reason'}")
    return ("failed", ("post", "handler", returncode),
            f"The post handler {handler} exited {returncode}: {line or 'no output'}. "
            "Next: run ./daemon/selftest.sh, it runs the same handler and names what is missing")


def xsel_problem(problem, display, path, timeout_s):
    """A failed `xsel -b -o` -> (key, text). `problem` is 'missing',
    'timeout' or (returncode, stderr)."""
    if problem == "missing":
        return (("clipboard", "xsel-missing"),
                f"xsel is not on the daemon's PATH ({path}); the wl-paste fallback misses "
                "PoE's XWayland copies. Next: install xsel, or make it visible to the service "
                "manager (./daemon/selftest.sh prints the exact command), then: "
                "systemctl --user restart poe-price-daemon")
    if problem == "timeout":
        return (("clipboard", "xsel-timeout"),
                f"xsel did not answer within {timeout_s} s on DISPLAY={display}. Next: the X "
                "server (XWayland) is not responding; if this persists, log out and back in")
    rc, err = problem
    msg = first_line(err)
    if not display:
        return (("clipboard", "no-display"),
                "DISPLAY is not set in the daemon's environment, so xsel cannot reach the X11 "
                f"clipboard PoE copies to (xsel exit {rc}: {msg or 'no message'}). Next: from "
                "your desktop session run systemctl --user import-environment DISPLAY XAUTHORITY "
                "&& systemctl --user restart poe-price-daemon; ./daemon/selftest.sh checks the "
                "service environment")
    return (("clipboard", "xsel", rc, msg),
            f"xsel -b -o exited {rc} on DISPLAY={display}: {msg or 'no message'}. Next: check "
            "DISPLAY and XAUTHORITY of the service (systemctl --user show-environment); "
            "./daemon/selftest.sh checks both")


def ydotool_problem(problem, socket, config_path, timeout_s):
    """A failed ydotool call -> (key, text). `problem` is 'no-socket',
    'missing', 'timeout' or (returncode, stderr)."""
    if problem == "no-socket":
        return (("ydotool", "socket"),
                f"Chat macro not sent: the ydotool socket {socket} does not exist. Next: "
                f"systemctl --user enable --now ydotool, or set ydotool_socket in {config_path}; "
                "./daemon/selftest.sh checks socket and /dev/uinput")
    if problem == "missing":
        return (("ydotool", "missing"),
                "Chat macro not sent: ydotool is not on the daemon's PATH. Next: install ydotool, "
                "or make it visible to the service manager (./daemon/selftest.sh prints the exact "
                "command), then: systemctl --user restart poe-price-daemon")
    if problem == "timeout":
        return (("ydotool", "timeout"),
                f"Chat macro not sent: ydotool did not finish within {timeout_s} s. Next: "
                "systemctl --user restart ydotool")
    rc, err = problem
    msg = first_line(err)
    return (("ydotool", rc, msg),
            f"Chat macro not sent: ydotool exited {rc}: {msg or 'no message'}. Next: "
            "systemctl --user status ydotool; ./daemon/selftest.sh checks socket and /dev/uinput")


def health_report(rc, out, err, url, config_path):
    """The start-up GET /health -> (key or None, text). `rc` None means curl
    is missing; `out` is curl's "-w '%{http_code} %{redirect_url}'"."""
    if rc is None:
        return (("backend", "no-curl"),
                "Start-up check FAILED: curl is not on the daemon's PATH, so no item can be "
                "posted. Next: install curl, then: systemctl --user restart poe-price-daemon")
    if rc != 0:
        return (("backend", "unreachable", rc),
                f"Start-up check FAILED: cannot reach the backend at {url}: "
                f"{first_line(err) or 'no message from curl'} (curl exit {rc}). Items copied now "
                "are lost until it answers; each failed one gets its own line here. Next: start "
                f"the backend, or fix backend_url in {config_path}, then: "
                "systemctl --user restart poe-price-daemon")
    code, _, loc = str(out or "").strip().partition(" ")
    loc = loc.strip()
    if code.startswith("3"):
        return (("backend", "redirect", code),
                f"Start-up check FAILED: {url}/health answered {code}, a redirect to "
                f"{loc or '(no location)'}. Every item would be lost: the POST does not follow "
                f"redirects. Next: write the https:// address into backend_url in {config_path}, "
                "then: systemctl --user restart poe-price-daemon")
    if code != "200":
        return (("backend", "status", code),
                f"Start-up check FAILED: {url}/health answered HTTP {code or '(none)'} instead of "
                f"200. Next: check that backend_url in {config_path} points at the poe-price-tool "
                "backend")
    return (None, f"Start-up check: backend {url} answers.")


def users_report(rc, out, user, url, config_path):
    """The start-up GET /users -> (key or None, text), or None when the answer
    says nothing (no answer, not JSON, no `users` list: an older backend)."""
    if rc != 0:
        return None
    try:
        data = json.loads(out)
    except (TypeError, ValueError):
        return None
    users = data.get("users") if isinstance(data, dict) else None
    if not isinstance(users, list):
        return None
    users = [str(u) for u in users]
    if user in users:
        return (None, f'Start-up check: backend {url} answers and knows user "{user}".')
    return (("backend", "unknown-user"),
            f'Start-up check FAILED: the backend at {url} does not know user "{user}" '
            f'(it knows: {", ".join(users) or "nobody"}). Every item would be rejected with 400. '
            f"Next: set user in {config_path} to one of those, or add it to POE_USERS on the "
            "server; then: systemctl --user restart poe-price-daemon")


# --- the way back: ppt_link.py's channels and the notification -------------

LINK_ROUTES = {"downlink": "GET /daemon/events", "heartbeat": "POST /daemon/heartbeat",
               "whisper": "POST /daemon/whisper", "session": "POST /daemon/session"}
LINK_NAMES = {"downlink": "Back channel", "heartbeat": "Heartbeat", "whisper": "Whisper check",
              "session": "Session key"}
# What the player loses while the server is older than the daemon.
LINK_MISSING = {
    "downlink": "Prices stay in the browser; the game only shows that an item was sent",
    "heartbeat": "The server cannot see which parts of this daemon work",
    "whisper": "Whispers are shown without a market comparison",
    "session": "The session key does nothing",
}
DETAIL_MAX = 300


def _cut(text, n=DETAIL_MAX):
    text = first_line(text)
    return text if len(text) <= n else text[:n] + "…"


def link_problem(channel, verdict, url, config_path, reprobe_s=600, user=None):
    """A channel's verdict from ppt_link.classify() -> (key, text).
    verdict is ('unsupported', status) or ('failing', key, detail)."""
    route = LINK_ROUTES.get(channel, channel)
    path = route.split(" ", 1)[-1]
    if verdict[0] == "unsupported":
        return ((channel, "unsupported"),
                f"The backend at {url} has no {path} (HTTP {verdict[1]}): it is older than this "
                f"daemon. {LINK_MISSING.get(channel, 'This part of the daemon rests')}. Next: update "
                "the server (docs/admin.md, Update procedure); this daemon asks again every "
                f"{max(1, int(reprobe_s) // 60)} min.")
    _, key, detail = verdict
    if key == "not-json":
        return ((channel, key),
                f"{route} answered HTTP {detail} with something that is not JSON — a reverse "
                f"proxy's page? Next: check that backend_url in {config_path} points at the "
                "backend itself, not at a login or error page.")
    if key == "too-many-waiters":
        return ((channel, key),
                f'The backend holds the most result requests it allows for user "{user}". Next: '
                "check for a second daemon of this user (systemctl --user status poe-price-daemon "
                "on each machine).")
    if key.startswith("unreachable-"):
        rc = key.split("-", 1)[1]
        # The same words as poe-price-post.sh: only some exits mean that
        # nothing answered; on the others the exchange broke off.
        if rc in ("6", "7", "35", "60"):
            lead = f"cannot reach {url}"
        elif rc == "28":
            lead = f"no answer from {url} in time"
        else:
            lead = f"the exchange with {url} broke off"
        nxt = {
            "6": "the host name in backend_url does not resolve; fix backend_url in " + config_path,
            "7": f"nothing listens there; start the backend, or fix backend_url in {config_path}",
            "35": "the TLS handshake failed; check the reverse proxy's certificate",
            "60": "the TLS handshake failed; check the reverse proxy's certificate",
        }.get(rc, "check that the backend runs and that backend_url points at it")
        return ((channel, key),
                f"{route} failed: {lead} — {_cut(detail) or 'no message from curl'} (curl exit {rc}). "
                f"Next: {nxt}.")
    if key == "timeout":
        return ((channel, key),
                f"{route} failed: no answer from {url} in time. Next: check whether the backend "
                "is hung or overloaded (its container log); behind a reverse proxy its read "
                "timeout must be above 30 s.")
    # These two do not pass by themselves: the channel asks again only every
    # reprobe_s (ppt_link.LASTING), and the line says so.
    again = f" This daemon asks again every {max(1, int(reprobe_s) // 60)} min."
    if key == "unknown-user":
        return ((channel, key),
                f'{route} rejected: the backend does not know user "{user}". Next: set user in '
                f"{config_path} to one the backend knows, or add it to POE_USERS on the server; "
                "then: systemctl --user restart poe-price-daemon." + again)
    if key == "bad-request":
        return ((channel, key),
                f"{route} rejected: HTTP 400 {_cut(detail)}. Next: this daemon and the server "
                "disagree about the request; update both (docs/admin.md, Update procedure)." + again)
    if key == "too-large":
        return ((channel, key),
                f"{route} rejected: HTTP 413, the request is larger than the backend takes. "
                "Next: update this daemon and the server (docs/admin.md, Update procedure).")
    if key == "too-many-whispers":
        return ((channel, key),
                f'{route} rejected: HTTP 429, more whispers this minute for user "{user}" than the '
                "backend takes (POE_WHISPER_MAX_PER_MIN). Next: nothing, unless this repeats; then "
                "raise POE_WHISPER_MAX_PER_MIN on the server.")
    return ((channel, key),
            f"{route} failed: {key.replace('http-', 'HTTP ')} {_cut(detail)}".rstrip()
            + ". Next: check the backend log.")


def link_recovered(channel, n, was_unsupported=False):
    """The one line when a channel works again."""
    name = LINK_NAMES.get(channel, channel)
    if was_unsupported:
        return f"{name} is offered by the backend now ({LINK_ROUTES.get(channel, channel)})."
    return f"{name} works again ({n} failed attempt(s) before)."


def clientlog_problem(state, path, config_path, detail=""):
    """The game's log file that buyer whispers are read from (ppt_whisper.
    LogTailer) in a state that is not 'tailing' -> (key, text). state is
    'missing', 'unreadable', 'not-a-file', 'long-line' or 'resume'."""
    detail = _cut(str(detail or ""))
    if state == "missing":
        return (("clientlog", "missing"),
                f"Whispers are not read: {path} does not exist. Next: set client_log in [whispers] of "
                f"{config_path} to the game's logs/Client.txt (Steam: <library>/steamapps/common/Path of "
                "Exile/logs/Client.txt); ./daemon/selftest.sh lists the ones it finds under Steam, "
                "~/Games/*/drive_c and ~/.wine/drive_c; a game installed elsewhere is entered by hand. "
                "The daemon looks again every few seconds.")
    if state == "unreadable":
        return (("clientlog", "unreadable"),
                f"Whispers are not read: {path} cannot be opened ({detail or 'no detail'}). Next: check "
                f"its permissions (ls -l {path}).")
    if state == "not-a-file":
        return (("clientlog", "not-a-file"),
                f"Whispers are not read: {path} is not a file. Next: point client_log at logs/Client.txt "
                f"itself, in [whispers] of {config_path}.")
    if state == "long-line":
        return (("clientlog", "long-line"),
                f"A line of {path} longer than 64 KB was skipped; a whisper in it is not shown.")
    if state == "resume":
        return (("clientlog", "resume"),
                f"Could not keep the read position in $XDG_RUNTIME_DIR ({detail or 'no detail'}); after a "
                "restart the log is read from its end.")
    return (("clientlog", state), f"Whispers: {path} is in state {state} {detail}".rstrip() + ".")


def notify_problem(problem, detail=""):
    """A failed notify-send -> (key, text). problem is 'missing', 'timeout'
    or (returncode, stderr)."""
    if problem == "missing":
        return (("notify", "missing"),
                "Results cannot be shown as a notification: notify-send is not on the daemon's "
                "PATH. Next: install libnotify, then: systemctl --user restart poe-price-daemon")
    if problem == "timeout":
        return (("notify", "timeout"),
                "notify-send did not finish within 5 s; the notification service is not "
                "answering. Next: log out and back in if this persists")
    rc, err = problem
    msg = _cut(err)
    return (("notify", rc, msg),
            f"notify-send exited {rc}: {msg or 'no message'}. Next: ./daemon/selftest.sh "
            "(section 9 checks notify-send and the session bus the service sees)")


def overlay_problem(state, detail="", *, seconds=None, count=None):
    """The overlay process (ppt_display.OverlayLink) in a state that is not
    'ok' -> (key, text). seconds: when it is tried again (no-display: the
    earliest re-check; no-hello, hung, exited: the next restart); count: how
    many times it failed (failed)."""
    detail = _cut(str(detail or ""))
    if state == "no-qt":
        return (("overlay", "no-qt"),
                f"The overlay needs PySide6, which cannot be imported ({detail or 'no detail'}); "
                "results come as notifications. Next: install PySide6 (Arch: pyside6), then: "
                "systemctl --user restart poe-price-daemon; ./daemon/selftest.sh --overlay shows a test card")
    if state == "no-display":
        mins = max(1, int(seconds or 600) // 60)
        return (("overlay", "no-display"),
                f"The overlay cannot open a window: {detail or 'no DISPLAY or no xcb platform'}; it is "
                f"tried again at the next item, at the earliest in {mins} min. Next: systemctl --user "
                "import-environment DISPLAY XAUTHORITY && systemctl --user restart poe-price-daemon")
    if state == "no-focus-check":
        return (("overlay", "no-focus-check"),
                "The overlay is not used: it is shown only while the game has focus, and that check "
                "needs xdotool and xprop, which are not on the daemon's PATH; results come as "
                "notifications. Next: install xdotool and xprop (Arch: xdotool xorg-xprop) and restart "
                "the daemon, or set overlay_only_in_game = false; ./daemon/selftest.sh --overlay also checks "
                "PySide6, which the overlay needs too")
    if state == "wrong-platform":
        return (("overlay", "wrong-platform"),
                f'The overlay started on the Qt platform "{detail}" instead of xcb and cannot lie above '
                "the game; results come as notifications. Next: ./daemon/selftest.sh --overlay")
    again = f"it is started again in {int(seconds)} s" if seconds is not None else "it is started again"
    if state == "no-hello":
        return (("overlay", "no-hello"),
                f"The overlay process did not report within {detail or 'its start-up time'}; {again}, "
                "results meanwhile come as notifications. Next: if this repeats, ./daemon/selftest.sh --overlay")
    if state == "hung":
        return (("overlay", "hung"),
                f"The overlay stopped answering; {again}, results meanwhile come as notifications. "
                "Next: if this repeats, ./daemon/selftest.sh --overlay")
    if state == "exited":
        rc, msg = detail.split(" ", 1) if " " in detail else (detail, "")
        return (("overlay", "exited", rc),
                f"The overlay process ended with exit code {rc}: {msg or 'no message'}; {again}, results "
                "meanwhile come as notifications. Next: ./daemon/selftest.sh --overlay")
    if state == "failed":
        return (("overlay", "failed"),
                f"The overlay failed {count} times and stays off until the daemon restarts; results "
                "come as notifications. Next: journalctl --user -u poe-price-daemon for its error "
                "lines; ./daemon/selftest.sh --overlay")
    return (("overlay", state), f"The overlay is in state {state} {detail}".rstrip()
            + "; results come as notifications. Next: ./daemon/selftest.sh --overlay")


FULLSCREEN_NOTE = (
    "KDE holds notifications back while a fullscreen window has focus; with the game "
    "fullscreen a result notification does not reach you, only the overlay does. Switch: System Settings → "
    "Notifications → Do Not Disturb mode → Enable automatically: \"While a fullscreen "
    "application is focused\".")
