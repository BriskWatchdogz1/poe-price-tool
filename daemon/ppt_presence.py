"""ppt_presence — is the game running on this machine (sync follows the game).

The answer goes to the server with the heartbeat (ppt_link.Heartbeat, field
`game`), and the server's net-worth sync reads the stash of players whose game
runs first (backend/v2/networth/refresher.mjs, "WHO GETS THE TICK").

Why the window: the daemon already finds the game by its window class
(poe_window_class) for the macros' focus gate, and needs an X11 display anyway
(the clipboard). The same key and the same tool, so there is one thing to
configure. `xdotool search --class` compares without case.

THE THIRD ANSWER: when xdotool is missing, DISPLAY is not set, the call times
out or says anything on stderr, the answer is 'unknown', never 'absent'. The
backend treats 'unknown' exactly as it behaved before heartbeats existed, so a
failing probe can never slow anybody's net-worth sync.

NEVER SEEN IS NOT ABSENT: a clean miss (exit 1, no output) looks the same for a
game that is not running, a wrong poe_window_class, and a game on another X
server (gamescope's own Xwayland). So 'absent' needs a window of this class to
have been found on this display before; until then the answer is 'unknown' with
the reason 'never-seen'. The fact is kept per class and display in seen_file
(no window ids, no window names), so it survives a daemon restart. A file that
cannot be written is said once through on_problem (the daemon's journal):
after a restart the answer is 'never-seen' again until the window is found.

NO FLICKER: a change away from 'running' counts only when two checks in a row
show it, so one slow xdotool under load does not turn a player idle.

NEVER BLOCKING: xdotool runs through CurlPool.start_cmd (ppt_link); tick()
starts a check and reads its result later, like every other tick in the
daemon's loop. check_once() is the blocking variant for selftest.sh only.

Standard library only (backend/v2/daemon-presence-probe.test.mjs).
"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

CHECK_S = 10
TIMEOUT_S = 1
REASONS = ("no-xdotool", "no-display", "timeout", "error", "never-seen")
# POSIX ERE, the dialect xdotool's search uses: these and nothing else carry a
# meaning. re.escape would also escape a space ('path\ of\ exile'), which ERE
# leaves undefined.
_ERE_SPECIAL = set(".[]()*+?{}|^$\\")
_DISPLAY_SCREEN = re.compile(r"^(.*:\d+)\.\d+$")


def ere_escape(text):
    return "".join("\\" + c if c in _ERE_SPECIAL else c for c in str(text))


def default_seen_file(environ=None):
    """$XDG_STATE_HOME/poe-price-daemon/game-seen.json, else
    ~/.local/state/poe-price-daemon/game-seen.json."""
    environ = os.environ if environ is None else environ
    base = environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return Path(base) / "poe-price-daemon" / "game-seen.json"


def _display_key(display):
    """':1.0' and ':1' are the same X server."""
    d = str(display or "").strip()
    m = _DISPLAY_SCREEN.match(d)
    return m.group(1) if m else d


class GameProbe:
    """state(): 'running' | 'absent' | 'unknown' (the last, debounced answer;
    'unknown' before the first). reason(): why the last answer was 'unknown'
    (one of REASONS, '' otherwise and before the first answer). feature(): the
    word for the heartbeat's features: 'ok', 'starting' or the reason."""

    def __init__(self, window_class, pool, *, env=None, check_s=CHECK_S, timeout_s=TIMEOUT_S,
                 seen_file=None, which=shutil.which, on_problem=None):
        self.window_class = str(window_class).strip().lower()
        self.pattern = ere_escape(self.window_class)
        self.pool = pool
        self.env = os.environ if env is None else env
        self.check_s = float(check_s)
        self.timeout_s = float(timeout_s)
        self.seen_file = Path(seen_file) if seen_file is not None else default_seen_file(self.env)
        self.which = which
        self.on_problem = on_problem  # text -> None; the daemon's journal, or nothing
        self._state = "unknown"
        self._reason = ""
        self._answered = False
        self._away = False   # one check away from 'running' has been seen
        self._job = None
        self._stage = None
        self._next = 0.0
        self._seen = self._load_seen()

    # ---- what the daemon reads ----------------------------------------------
    def state(self):
        return self._state

    def reason(self):
        return self._reason

    def feature(self):
        if not self._answered:
            return "starting"
        return self._reason or "ok"

    # ---- the seen file ------------------------------------------------------
    def _load_seen(self):
        try:
            data = json.loads(self.seen_file.read_text(encoding="utf-8"))
            return {(str(e["class"]), str(e["display"])) for e in data.get("seen", [])
                    if isinstance(e, dict) and "class" in e and "display" in e}
        except (OSError, ValueError, TypeError, AttributeError):
            return set()

    def _key(self):
        return (self.window_class, _display_key(self.env.get("DISPLAY")))

    def _remember(self):
        """Keep 'a window of this class was found on this display'. A file
        that cannot be written keeps the fact for this run only, and says so
        once (each class and display is written at most once per run)."""
        key = self._key()
        if key in self._seen:
            return
        self._seen.add(key)
        try:
            self.seen_file.parent.mkdir(parents=True, exist_ok=True)
            body = {"v": 1, "seen": [{"class": c, "display": d} for c, d in sorted(self._seen)]}
            tmp = self.seen_file.with_name(self.seen_file.name + ".tmp")
            tmp.write_text(json.dumps(body), encoding="utf-8")
            os.replace(tmp, self.seen_file)
        except OSError as ex:
            if self.on_problem is not None:
                self.on_problem(f"Game detection: {self.seen_file} not writable ({ex.strerror or ex}); the game "
                                f"window is known for this run only. After a restart the detection says "
                                f"never-seen (the server keeps the normal net-worth sync pace) until the "
                                f"window is found again.")

    # ---- one answer ---------------------------------------------------------
    def _argv(self, xdotool, stage):
        return [xdotool, "search", "--limit", "1", f"--{stage}", self.pattern]

    @staticmethod
    def _verdict(rc, out, err, timed_out):
        """'hit' | 'miss' | a reason for 'unknown'."""
        if timed_out:
            return "timeout"
        if rc == 127:
            return "no-xdotool"
        lines = [l.strip() for l in str(out or "").splitlines() if l.strip()]
        if rc == 0 and lines and lines[0].isdigit():
            return "hit"
        if rc == 1 and not lines and not str(err or "").strip():
            return "miss"
        return "error"

    def _answer(self, state, reason="", debounce=True):
        self._answered = True
        if debounce and self._state == "running" and state != "running" and not self._away:
            self._away = True   # the first check away from 'running' does not count yet
            return
        self._away = False
        self._state = state
        self._reason = reason if state == "unknown" else ""

    def _settle(self, verdict, debounce=True):
        """Turns a final verdict of one check into the answer."""
        if verdict == "hit":
            self._remember()
            self._answer("running", debounce=debounce)
        elif verdict == "miss":
            if self._key() in self._seen:
                self._answer("absent", debounce=debounce)
            else:
                self._answer("unknown", "never-seen", debounce=debounce)
        else:
            self._answer("unknown", verdict, debounce=debounce)

    def _preflight(self):
        """None when a check can run, else the reason it cannot."""
        if not str(self.env.get("DISPLAY") or "").strip():
            return "no-display"
        if not self.which("xdotool"):
            return "no-xdotool"
        return None

    # ---- the daemon's loop --------------------------------------------------
    def tick(self, now):
        """At most every check_s start a check; read a finished one. Never
        waits: a job that has not ended is read on a later tick."""
        if self._job is None:
            if now < self._next:
                return
            self._next = now + self.check_s
            why = self._preflight()
            if why is not None:
                self._settle(why)
                return
            self._stage = "class"
            self._job = self.pool.start_cmd(self._argv(self.which("xdotool"), "class"),
                                            timeout_s=self.timeout_s, tag="game")
        while self._job is not None:
            res = self._job.poll(now)
            if res is None:
                return
            self._job = None
            verdict = self._verdict(res.rc, res.body, res.err, res.timed_out)
            if verdict == "miss" and self._stage == "class":
                # No window with that class; the name half of WM_CLASS next.
                self._stage = "classname"
                self._job = self.pool.start_cmd(self._argv(self.which("xdotool") or "xdotool", "classname"),
                                                timeout_s=self.timeout_s, tag="game")
                continue
            self._settle(verdict)

    def check_once(self, run=subprocess.run):
        """The same check, blocking, for selftest.sh (python3 -c). Never used
        by the daemon. Writes nothing (the self-test changes nothing)."""
        why = self._preflight()
        if why is not None:
            self._settle(why, debounce=False)
            return self._state
        xdotool = self.which("xdotool")
        verdict = "miss"
        for stage in ("class", "classname"):
            try:
                r = run(self._argv(xdotool, stage), capture_output=True, text=True,
                        timeout=self.timeout_s, env=dict(self.env))
                verdict = self._verdict(r.returncode, r.stdout, r.stderr, False)
            except FileNotFoundError:
                verdict = "no-xdotool"
            except subprocess.TimeoutExpired:
                verdict = "timeout"
            except OSError:
                verdict = "error"
            if verdict != "miss":
                break
        if verdict == "hit":
            self._answer("running", debounce=False)  # not remembered: no write
        else:
            self._settle(verdict, debounce=False)
        return self._state
