"""ppt_link — the daemon's HTTP channels to the backend besides POST /item,
all through curl, none of them blocking the main loop.

Every channel is a small state machine (starting, ok, failing, unsupported,
or off when switched off) with its own journal category; a server older than
the daemon is a state with a re-check every 10 min, not an error loop.
Standard library only, so backend/v2/daemon-link.test.mjs can load it with
python3.

The channels (backend/v2/frontend/PROTOCOL.md, "the hotkey daemon's own
channel"):
  Downlink   GET /daemon/events, a long-poll: the cards this daemon posted, as
             the server prices them. Never the WebSocket /events: a connect
             there re-queues priceless cards as trade searches.
  Heartbeat  POST /daemon/heartbeat: version, game state and which parts of
             the daemon work, so the browser can show it.
  POST /daemon/whisper goes through post_json too; its state machine lives in
  ppt_whisper.Whispers. So does POST /daemon/session (the session key), in
  ppt_session.SessionKey. GET /daemon/stash-grid (the value key) goes through
  get_json; its state lives in ppt_value_grid.ValueGrid.

Processes: CurlPool starts curl (and other short commands) as children with
non-blocking pipes and a deadline; reap() is called once per loop round and
stores each finished job's CurlResult on the job (job.result), where the
channel that started it finds it in its own tick().
"""
import json
import os
import re
import secrets
import signal
import subprocess
import time
import urllib.parse
from collections import namedtuple
from pathlib import Path

from ppt_diag import link_problem, link_recovered

DAEMON_VERSION_FALLBACK = "unknown"
# The rule the server applies to X-PPT-Daemon (backend/v2/daemon-user.mjs).
_TOKEN = re.compile(r"^[A-Za-z0-9._+-]{1,32}$")
REPROBE_S = 600
BACKOFF_S = (2, 4, 8, 16, 32, 60)
# Refusals that asking again soon cannot change: the user is fixed for this
# run, and a request the server does not take now it will not take in a
# minute. Like 'unsupported': one line, then asked again every reprobe_s.
LASTING = ("unknown-user", "bad-request")
FEED_VERSION = 1


def read_version(repo_root):
    """The daemon's version: "version" from <repo_root>/package.json (the
    daemon lives in the same checkout). A checkout of the daemon/ folder alone
    (README, sparse checkout) has no package.json; then the newest release tag
    git knows (`git describe --tags --abbrev=0`, without the leading v), which
    needs no file contents. 'unknown' on any error; never raises."""
    try:
        data = json.loads((Path(repo_root) / "package.json").read_text(encoding="utf-8"))
        version = str(data.get("version") or "").strip()
        return version if _TOKEN.match(version) else DAEMON_VERSION_FALLBACK
    except Exception:
        pass
    try:
        r = subprocess.run(["git", "-C", str(repo_root), "describe", "--tags", "--abbrev=0"],
                           capture_output=True, text=True, timeout=2,
                           env={**os.environ, "GIT_NO_LAZY_FETCH": "1"})
        tag = r.stdout.strip() if r.returncode == 0 else ""
        tag = tag[1:] if tag.startswith("v") else tag
        if _TOKEN.match(tag):
            return tag
    except Exception:
        pass
    return DAEMON_VERSION_FALLBACK


def new_instance():
    """A random id per daemon start (header X-PPT-Instance): keeps two daemons
    of one user apart. No host or user name."""
    return secrets.token_hex(4)


def headers(user, version, instance):
    """curl arguments for the three daemon headers."""
    return ["-H", f"X-User: {user}", "-H", f"X-PPT-Daemon: {version}",
            "-H", f"X-PPT-Instance: {instance}"]


CurlResult = namedtuple("CurlResult", "rc status body err timed_out")


def split_status(out):
    """curl's stdout with -w '\\n%{http_code}' -> (status or None, body). The
    status is the last line, as in poe-price-post.sh; 000 (no HTTP answer)
    is None."""
    head, sep, tail = str(out or "").rpartition("\n")
    code = tail.strip().split(" ")[0] if tail.strip() else ""
    if not code.isdigit():
        return (None, out)
    return (int(code) or None, head if sep else "")


class CurlJob:
    """One child process. stdout and stderr are read without blocking (each
    kept up to `keep` bytes, the rest read and dropped, so a chatty child never
    blocks on a full pipe); past the deadline it is ended (SIGTERM) and
    reported as timed_out. `status` is parsed from the last stdout line when
    the job ran curl with -w '\\n%{http_code}'."""

    def __init__(self, popen, deadline, keep=65536, tag=None, http=True):
        self.proc = popen
        self.deadline = deadline
        self.keep = keep
        self.tag = tag
        self.http = http
        self.result = None
        self._out = bytearray()
        self._err = bytearray()
        for f in (popen.stdout, popen.stderr):
            if f is not None:
                os.set_blocking(f.fileno(), False)

    def _drain(self):
        for f, buf in ((self.proc.stdout, self._out), (self.proc.stderr, self._err)):
            if f is None or f.closed:
                continue
            while True:
                try:
                    chunk = os.read(f.fileno(), 65536)
                except (BlockingIOError, InterruptedError):
                    break
                except OSError:
                    break
                if not chunk:
                    break
                room = self.keep - len(buf)
                if room > 0:
                    buf += chunk[:room]

    def _close_pipes(self):
        for f in (self.proc.stdout, self.proc.stderr):
            try:
                if f is not None:
                    f.close()
            except OSError:
                pass

    def poll(self, now):
        """The result once the child has ended (also stored as self.result),
        else None. A child past its deadline is ended and reported now."""
        if self.result is not None:
            return self.result
        self._drain()
        if self.proc.poll() is None:
            if now < self.deadline:
                return None
            try:
                self.proc.terminate()
            except OSError:
                pass
            self._close_pipes()
            self.result = CurlResult(None, None, "", "", True)
            return self.result
        self._drain()
        self._close_pipes()
        out = bytes(self._out).decode("utf-8", "replace")
        err = bytes(self._err).decode("utf-8", "replace")
        status, body = split_status(out) if self.http else (None, out)
        self.result = CurlResult(self.proc.returncode, status, body, err, False)
        return self.result


class CurlPool:
    """Starts children and reaps them without waiting. spawn and clock are
    injectable (tests); `curl` is the program start() runs."""

    def __init__(self, clock=time.monotonic, spawn=subprocess.Popen, env=None, curl="curl"):
        self.clock = clock
        self.spawn = spawn
        self.env = env
        self.curl = curl
        self._jobs = []
        self._dying = []  # ended past their deadline, waiting to be reaped

    def _start(self, argv, stdin_bytes, timeout_s, tag, http):
        try:
            p = self.spawn(argv, stdin=subprocess.PIPE if stdin_bytes is not None else subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        except FileNotFoundError:
            job = _Failed(tag, 127, f"{argv[0]}: not found")
            return job
        except Exception as ex:
            return _Failed(tag, 126, f"{argv[0]}: {type(ex).__name__}: {ex}")
        if stdin_bytes is not None:
            try:
                p.stdin.write(stdin_bytes)  # small (a heartbeat, a whisper): fits the pipe
            except OSError:
                pass
            try:
                p.stdin.close()
            except OSError:
                pass
        job = CurlJob(p, self.clock() + float(timeout_s), tag=tag, http=http)
        self._jobs.append(job)
        return job

    def start(self, args, stdin_bytes=None, timeout_s=10, tag=None):
        """curl -sS <args>; the caller passes -w '\\n%{http_code}'."""
        return self._start([self.curl, "-sS", *args], stdin_bytes, timeout_s, tag, True)

    def start_cmd(self, argv, timeout_s=1, tag=None):
        """Any other short command, with the same non-blocking handling."""
        return self._start(list(argv), None, timeout_s, tag, False)

    def reap(self):
        """[(job, CurlResult)] for every job that ended since the last call;
        ends overdue jobs."""
        now = self.clock()
        done, running = [], []
        for job in self._jobs:
            res = job.poll(now)
            if res is None:
                running.append(job)
                continue
            done.append((job, res))
            if res.timed_out:
                self._dying.append(job.proc)
        self._jobs = running
        self._dying = [p for p in self._dying if p.poll() is None]
        return done

    def close(self):
        """SIGTERM to every running child (daemon shutdown)."""
        for job in self._jobs:
            try:
                job.proc.terminate()
            except OSError:
                pass
        for p in self._dying:
            try:
                p.terminate()
            except OSError:
                pass
        self._jobs = []


class _Failed:
    """A job whose program could not be started: its result is there at once,
    like a curl that exited at once (rc 127: not found)."""

    def __init__(self, tag, rc, err):
        self.tag = tag
        self.proc = None
        self.result = CurlResult(rc, None, "", err, False)

    def poll(self, now):
        return self.result


def classify(result):
    """CurlResult -> ('ok', data) | ('unsupported', status) | ('failing', key, detail).
    The status is read first, the JSON second, so an old server or a proxy page
    never raises."""
    if result.timed_out:
        return ("failing", "timeout", "")
    if result.rc != 0:
        return ("failing", f"unreachable-{result.rc}", result.err)
    status = result.status
    if status in (404, 405):
        return ("unsupported", status)  # an older server: serveStatic's 404 or the router's 405
    data = None
    try:
        data = json.loads(result.body) if result.body else None
    except ValueError:
        data = None
    if status is not None and 200 <= status < 300:
        if isinstance(data, dict):
            return ("ok", data)
        return ("failing", "not-json", str(status))
    error = str(data.get("error") or "") if isinstance(data, dict) else ""
    if status == 400:
        if error.startswith("unknown user"):
            return ("failing", "unknown-user", error)
        if error.startswith("missing X-"):
            return ("failing", "bad-request", error)
        return ("failing", "http-400", error or result.body)
    if status == 413:
        return ("failing", "too-large", "")
    if status == 429:
        if error in ("too-many-waiters", "too-many-whispers"):
            return ("failing", error, error)
        return ("failing", "http-429", result.body)
    return ("failing", f"http-{status if status is not None else '000'}", error or result.body)


class Capability:
    """One channel's state and its journal lines: unknown (shown as
    'starting') -> ok | failing | unsupported. A failure goes through the
    throttled log; 'unsupported' and a LASTING refusal (state 'failing') are
    written once when they begin (asked again every reprobe_s, and an
    unchanged answer is no news); the way back to 'ok' is one line."""

    def __init__(self, name, log, clock, reprobe_s=REPROBE_S, url="", config_path="", user=None):
        self.name = name
        self.log = log
        self.clock = clock
        self.reprobe_s = reprobe_s
        self.url = url
        self.config_path = config_path
        self.user = user
        self._state = "unknown"
        self._next = 0.0
        self._lasting = None  # the LASTING key of the current failure, else None

    def due(self, now):
        return now >= self._next

    def state(self):
        return "starting" if self._state == "unknown" else self._state

    def waits(self):
        """True while the next question waits reprobe_s: an older server, or
        a LASTING refusal."""
        return self._state == "unsupported" or self._lasting is not None

    def note(self, verdict, now):
        """Record a verdict from classify(); writes at most one line."""
        kind = verdict[0]
        if kind == "ok":
            was = self._state
            n = self.log.recovered(self.name)
            if was == "unsupported":
                self.log.info(link_recovered(self.name, n, was_unsupported=True))
            elif n:
                self.log.info(link_recovered(self.name, n))
            self._state = "ok"
            self._lasting = None
            return
        key, text = link_problem(self.name, verdict, self.url, self.config_path,
                                 self.reprobe_s, self.user)
        if kind == "unsupported":
            if self._state != "unsupported":
                self.log.failure(key, text)
            self._state = "unsupported"
            self._lasting = None
            self._next = now + self.reprobe_s
            return
        lasting = verdict[1] if verdict[1] in LASTING else None
        if lasting is None or not (self._state == "failing" and self._lasting == lasting):
            self.log.failure(key, text)
        self._state = "failing"
        self._lasting = lasting
        if lasting is not None:
            self._next = now + self.reprobe_s


class Downlink:
    """GET /daemon/events long-poll. One request in flight at most; boot and
    since are kept in memory: reset -> since = seq, nothing replayed; gap ->
    on_gap('gap'); a changed boot -> on_gap('server restarted').

    Failures back off 2, 4, 8, 16, 32, 60 s (never a tight loop); a LASTING
    refusal (unknown user) waits reprobe_s, like an older server. Success
    cannot loop either: an answer without events that came back sooner than
    hold_s / 2 (POE_DAEMON_POLL_MAX_HOLD_MS=0 on the server, or a proxy that
    ends held requests with an empty 200) is followed by a pause of min_gap_s
    before the next request; an answer with events is followed at once.
    enabled=False (config back_channel = false) -> state 'off', never asks."""

    def __init__(self, base_url, hdrs, pool, log, clock, *, hold_s=25, min_gap_s=2,
                 on_events=None, on_gap=None, enabled=True, reprobe_s=REPROBE_S,
                 config_path="", user=None):
        self.base = str(base_url).rstrip("/")
        self.hdrs = list(hdrs)
        self.pool = pool
        self.clock = clock
        self.hold_s = float(hold_s)
        self.min_gap_s = float(min_gap_s)
        self.on_events = on_events or (lambda events: None)
        self.on_gap = on_gap or (lambda reason: None)
        self.enabled = bool(enabled)
        self.cap = Capability("downlink", log, clock, reprobe_s, self.base, config_path, user)
        self.boot = None
        self.since = None
        self._job = None
        self._started = 0.0
        self._next = 0.0
        self._fails = 0

    def state(self):
        return self.cap.state() if self.enabled else "off"

    def _url(self):
        q = {"wait": str(int(self.hold_s * 1000))}
        if self.boot is not None and self.since is not None:
            q = {"since": str(self.since), "boot": self.boot, **q}
        return f"{self.base}/daemon/events?" + urllib.parse.urlencode(q)

    def note_startup(self, verdict, now):
        """The daemon's start-up check asked the same route once: take its
        failure as this channel's own (one journal line, not two), and do
        not ask an older server again before reprobe_s."""
        self.cap.note(verdict, now)
        if self.cap.waits():
            self._next = now + self.cap.reprobe_s

    def _handle(self, res, now):
        verdict = classify(res)
        quick = now - self._started < self.hold_s / 2
        if verdict[0] == "unsupported":
            self.cap.note(verdict, now)
            self._fails = 0
            self._next = now + self.cap.reprobe_s
            return
        if verdict[0] == "failing":
            self.cap.note(verdict, now)
            if self.cap.waits():
                self._fails = 0
                self._next = now + self.cap.reprobe_s
                return
            # Counted from the request's start: a request that hung for its
            # whole hold has waited already.
            self._next = self._started + BACKOFF_S[min(self._fails, len(BACKOFF_S) - 1)]
            self._fails += 1
            return
        data = verdict[1]
        self.cap.note(verdict, now)
        self._fails = 0
        boot = data.get("boot")
        seq = data.get("seq")
        events = data.get("events") if isinstance(data.get("events"), list) else []
        if data.get("reset"):
            if self.boot is not None:
                self.on_gap("server restarted" if boot != self.boot else "gap")
            events = []
        elif data.get("gap"):
            self.on_gap("gap")
        if isinstance(boot, str):
            self.boot = boot
        if isinstance(seq, int) and seq >= 0:
            self.since = seq
        if events:
            self.on_events(events)
            self._next = now
        elif quick:
            self._next = now + self.min_gap_s
        else:
            self._next = now

    def tick(self, now):
        if not self.enabled:
            return
        if self._job is not None:
            if self._job.result is None:
                return
            res, self._job = self._job.result, None
            self._handle(res, now)
        if now >= self._next:
            self._started = now
            self._job = self.pool.start(["--max-time", f"{self.hold_s + 10:g}", "-w", "\n%{http_code}",
                                         *self.hdrs, self._url()],
                                        timeout_s=self.hold_s + 12, tag="downlink")


def get_json(pool, base_url, path, hdrs, timeout_s=5, tag=None):
    """GET a small JSON answer through the pool, with the daemon headers -> the job."""
    return pool.start(["--max-time", f"{timeout_s:g}", *hdrs, "-w", "\n%{http_code}",
                       f"{str(base_url).rstrip('/')}{path}"],
                      timeout_s=timeout_s + 2, tag=tag)


def post_json(pool, base_url, path, body, hdrs, timeout_s=5, tag=None, ensure_ascii=True):
    """POST a small JSON body through the pool -> the job. ensure_ascii=False
    sends text as UTF-8 (an umlaut is 2 bytes, not the 6 of \\u00fc): a
    whisper's text must stay under the server's byte limit."""
    data = json.dumps(body, separators=(",", ":"), ensure_ascii=ensure_ascii).encode("utf-8")
    return pool.start(["--max-time", f"{timeout_s:g}", "-X", "POST",
                       "-H", "Content-Type: application/json", *hdrs,
                       "--data-binary", "@-", "-w", "\n%{http_code}",
                       f"{str(base_url).rstrip('/')}{path}"],
                      stdin_bytes=data, timeout_s=timeout_s + 2, tag=tag)


class Heartbeat:
    """POST /daemon/heartbeat: at start, at once when game() or features()
    change, else every idle_interval_s while game() says 'absent' and every
    interval_s otherwise ('running', and 'unknown' too: the server keeps a
    beat fresh for 3 x everyS, so a daemon that stopped drops out after 3 min,
    not 15). One request in flight. game() is the daemon's GameProbe.state
    (ppt_presence), or always 'unknown' with [presence] report_game = false,
    so such a daemon never changes the server's sync pace. A
    server without the route, or a LASTING refusal, is asked again only every
    reprobe_s, a change included."""

    def __init__(self, pool, base_url, hdrs, log, clock, *, game=lambda: "unknown",
                 features=lambda: {}, interval_s=60, idle_interval_s=300, enabled=True,
                 reprobe_s=REPROBE_S, config_path="", user=None):
        self.pool = pool
        self.base = str(base_url).rstrip("/")
        self.hdrs = list(hdrs)
        self.clock = clock
        self.game = game
        self.features = features
        self.interval_s = float(interval_s)
        self.idle_interval_s = float(idle_interval_s)
        self.enabled = bool(enabled)
        self.cap = Capability("heartbeat", log, clock, reprobe_s, self.base, config_path, user)
        self._job = None
        self._next = 0.0
        self._sent = None  # (game, features) of the last beat sent

    def state(self):
        return self.cap.state() if self.enabled else "off"

    def tick(self, now):
        if not self.enabled:
            return
        if self._job is not None:
            if self._job.result is None:
                return
            res, self._job = self._job.result, None
            verdict = classify(res)
            self.cap.note(verdict, now)
            if self.cap.waits():
                self._next = now + self.cap.reprobe_s
        game = str(self.game() or "unknown")
        feats = dict(self.features() or {})
        changed = self._sent is not None and self._sent != (game, feats)
        if self.cap.waits() and now < self._next:
            return
        if not (now >= self._next or changed):
            return
        every = self.idle_interval_s if game == "absent" else self.interval_s
        self._sent = (game, feats)
        self._next = now + every
        self._job = post_json(self.pool, self.base, "/daemon/heartbeat",
                              {"v": FEED_VERSION, "game": game, "everyS": int(every), "features": feats},
                              self.hdrs, timeout_s=5, tag="heartbeat")
