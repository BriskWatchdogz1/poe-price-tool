"""ppt_whisper — incoming trade whispers from the game's Client.txt.

The daemon's part of the buyer-whisper check: follow the game's log, find
the whispers other players send you, send the ones that start like a
trade-site template to POST /daemon/whisper, and turn the server's answer into
a card (ppt_results.whisper_card). The server reads the template and values
the goods (backend/v2/whisper.mjs, whisper-price.mjs); this module never
parses a template, so a server update fixes every daemon.

Standard library only; no clock or file system it is not handed, so
backend/v2/daemon-whisper.test.mjs drives it against a file in a temp dir and
a fake curl pool.

PRIVACY, the rule this module is built around: another player's name is
returned to the caller and kept in memory only (Pseudonyms, the whisper
book). It is never written to the journal, never sent to the server, never
stored on disk. The journal says 'whisper w12 (buyer 3)'. Only a line that
starts like a trade-site template leaves this PC; a private whisper never
does, and one that only looks like a trade offer is counted, not sent (one
journal line an hour, without text and name). The tool never invites,
answers or clicks.

  LogTailer   follows the log like `tail -F`, by polling (stat + read), so a
              Proton prefix or a Windows drive works too.
  parse_line  an incoming whisper -> (name, text).
  Pseudonyms  name -> 'buyer N' for this run.
  WhisperGate at most per_min POSTs a minute; the same text of the same buyer
              within same_s is one POST with a repeat count.
  Whispers    tail, read, filter, post, show: what the daemon calls; also the
              whispers with a stash cell for the stash cell frame (positions).
"""
import json
import os
import re
import stat as statmod
import time
from collections import OrderedDict, deque

from ppt_diag import clientlog_problem, link_problem, link_recovered
from ppt_link import REPROBE_S, classify, post_json
from ppt_results import (wait_text, whisper_card, whisper_failure_card, whisper_toast_for,
                         whisper_unsupported_card)

# 'YYYY/MM/DD HH:MM:SS <n> <hex> [INFO Client <n>] <message>'
LINE = re.compile(r"^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2} \d+ [0-9a-fA-F]+ \[[A-Z]+ Client \d+\] (.*)$")
# What the server takes (backend/v2/frontend/PROTOCOL.md, POST /daemon/whisper:
# 4096 bytes of request, 2000 characters of text as JavaScript counts them, in
# UTF-16 units), with room for the JSON around the text. cut_body() counts the
# text the way the server sees it: bytes after JSON escaping, UTF-16 units.
MAX_BODY_CHARS = 1500
MAX_BODY_BYTES = 3500
HINT_EVERY_S = 3600
REOPEN_NOTE_S = 600  # at most one 'was replaced' line in this time; the others are counted
PROBLEM_STATES = ("missing", "unreadable", "not-a-file")


class LogTailer:
    """Follows a growing text file like `tail -F`, without blocking and without
    reading it whole: starts at the END; resumes from `resume_file`
    (XDG_RUNTIME_DIR, holds {dev, ino, offset, at}, no text) when it names the
    same device and inode and is younger than resume_max_s; a file that got
    SHORTER is read again from 0 ('reread'); a different inode at the path
    ('reopened'), or a file that appears after it was missing, is read from 0;
    each of these three from its end instead when it is larger than fresh_max,
    so a log is never read whole. A missing or unreadable file is a state
    ('missing', 'unreadable', 'not-a-file'); when the SAME file (device and
    inode) comes back, reading goes on where it stopped, so a short fault never
    delivers old lines again. A path whose inode changes churn_n times within
    churn_s is taken to be one file whose inode is not stable ('churning'):
    reading goes on at the position rather than from 0. At most max_read bytes
    per poll, a partial last line waits, a line longer than max_line is
    dropped and counted. UTF-8 with errors='replace', CR stripped.

    clock is WALL time (time.time): `at` in the resume file must survive a
    suspend, which time.monotonic does not count. poll() saves the position
    when it changed, at most every save_every_s, so a SIGKILL or an OOM kill
    loses at most that much; save() writes it at once (the daemon's exit)."""

    def __init__(self, path, *, max_read=262144, max_line=65536, fresh_max=1048576,
                 resume_file=None, resume_max_s=600, save_every_s=30, clock=time.time,
                 stat=os.stat, opener=open, churn_n=5, churn_s=60):
        self.path = str(path)
        self.max_read = int(max_read)
        self.max_line = int(max_line)
        self.fresh_max = int(fresh_max)
        self.resume_file = str(resume_file) if resume_file else None
        self.resume_max_s = float(resume_max_s)
        self.save_every_s = float(save_every_s)
        self.clock = clock
        self.stat = stat
        self.opener = opener
        self.churn_n = int(churn_n)
        self.churn_s = float(churn_s)
        self.churning = False    # the inode changed churn_n times within churn_s
        self._reopens = deque()  # clock() of each change of inode
        self.state = "starting"
        self.detail = ""
        self.started = None      # how reading began at the last open: 'end', 'resume', 'start' or 'continue'
        self.size_at_open = 0
        self.offset = 0          # bytes read from the open file (the partial line included)
        self.dev = None
        self.ino = None
        self.save_error = None   # the last failed save, as text; None after a good one
        self._fh = None
        self._buf = bytearray()
        self._skipping = False   # inside a line longer than max_line
        self._first = True
        self._saved = None       # (dev, ino, position) last written
        self._last_save = None

    def _close(self):
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass
        self._fh = None

    def _problem(self, state, detail=""):
        self._close()
        self._first = False
        # Keep (dev, ino) and the position of the last whole line: when the
        # same file comes back, _open() goes on from there.
        self.offset -= len(self._buf)
        self._buf.clear()
        self._skipping = False
        self.state = state
        self.detail = detail
        return (state, [], 0, None)

    def _resume(self, st):
        if not self.resume_file:
            return None
        try:
            with open(self.resume_file, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            dev, ino, offset, at = data["dev"], data["ino"], data["offset"], data["at"]
        except (OSError, ValueError, KeyError, TypeError):
            return None
        if not all(isinstance(x, int) and not isinstance(x, bool) for x in (dev, ino, offset)):
            return None
        if not isinstance(at, (int, float)) or isinstance(at, bool):
            return None
        if (dev, ino) != (st.st_dev, st.st_ino):
            return None
        if not 0 <= self.clock() - at <= self.resume_max_s:
            return None
        if not 0 <= offset <= st.st_size:
            return None
        return offset

    def _fresh(self, size):
        """Where a file seen for the first time, or got shorter, is read from:
        0, or its end when it is larger than fresh_max."""
        self.offset = 0 if size <= self.fresh_max else size
        self.started = "start" if self.offset == 0 else "end"

    def _churn(self):
        """Count one change of inode; True when they come churn_n times within churn_s."""
        now = self.clock()
        self._reopens.append(now)
        while self._reopens and now - self._reopens[0] > self.churn_s:
            self._reopens.popleft()
        self.churning = len(self._reopens) >= self.churn_n
        return self.churning

    def _open(self, st):
        """-> None or a note when opened, else a problem tuple."""
        try:
            fh = self.opener(self.path, "rb")
        except IsADirectoryError:
            return self._problem("not-a-file")
        except OSError as ex:
            return self._problem("unreadable", ex.strerror or type(ex).__name__)
        replaced = self._fh is not None
        same = self.dev is not None and (st.st_dev, st.st_ino) == (self.dev, self.ino)
        last = self.offset - len(self._buf)  # the position of the last whole line
        self._close()
        self._fh = fh
        self._buf.clear()
        self._skipping = False
        self.size_at_open = st.st_size
        note = None
        if self._first:
            resumed = self._resume(st)
            self.offset = st.st_size if resumed is None else resumed
            self.started = "end" if resumed is None else "resume"
        elif same:
            # The same file after a fault: on from where it stopped, or as a
            # file that got shorter.
            if last <= st.st_size:
                self.offset = last
                self.started = "continue"
            else:
                self._fresh(st.st_size)
                note = "reread"
        else:
            churning = self.dev is not None and self._churn()
            if churning and last <= st.st_size:
                self.offset = last
                self.started = "continue"
            else:
                self._fresh(st.st_size)
            if replaced:
                note = "reopened"
        self.dev, self.ino = st.st_dev, st.st_ino
        self._first = False
        return note

    def _split(self, data, lines):
        dropped = 0
        self._buf += data
        while True:
            i = self._buf.find(b"\n")
            if i < 0:
                break
            raw = bytes(self._buf[:i])
            del self._buf[:i + 1]
            if self._skipping:
                self._skipping = False  # the end of a line already counted
                continue
            if len(raw) > self.max_line:
                dropped += 1
                continue
            lines.append(raw.rstrip(b"\r").decode("utf-8", "replace"))
        if len(self._buf) > self.max_line:
            if not self._skipping:
                dropped += 1
            self._skipping = True
            self._buf.clear()
        return dropped

    def poll(self):
        """-> (state, [lines], dropped_long_lines, note); note is None,
        'reopened' or 'reread'."""
        try:
            st = self.stat(self.path)
        except FileNotFoundError:
            return self._problem("missing")
        except OSError as ex:
            return self._problem("unreadable", ex.strerror or type(ex).__name__)
        if not statmod.S_ISREG(st.st_mode):
            return self._problem("not-a-file")
        note = None
        if self._fh is None or (st.st_dev, st.st_ino) != (self.dev, self.ino):
            opened = self._open(st)
            if isinstance(opened, tuple):
                return opened
            note = opened
        elif st.st_size < self.offset:
            self._fresh(st.st_size)
            self._buf.clear()
            self._skipping = False
            note = "reread"
        lines = []
        dropped = 0
        if st.st_size > self.offset:
            try:
                self._fh.seek(self.offset)
                data = self._fh.read(min(self.max_read, st.st_size - self.offset))
            except OSError as ex:
                return self._problem("unreadable", ex.strerror or type(ex).__name__)
            self.offset += len(data)
            dropped = self._split(data, lines)
        self.state = "tailing"
        self.detail = ""
        self._autosave()
        return ("tailing", lines, dropped, note)

    def _position(self):
        return (self.dev, self.ino, self.offset - len(self._buf))

    def _autosave(self):
        if not self.resume_file or self.dev is None:
            return
        if self._position() == self._saved:
            return
        now = self.clock()
        if self._last_save is not None and now - self._last_save < self.save_every_s:
            return
        self.save()

    def save(self):
        """Write the read position to resume_file (atomically, mode 0600).
        Returns an error text instead of raising; None when it worked or there
        is nothing to save."""
        if not self.resume_file or self.dev is None:
            return None
        dev, ino, pos = self._position()
        now = self.clock()
        self._last_save = now
        tmp = f"{self.resume_file}.tmp"
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"dev": dev, "ino": ino, "offset": pos, "at": now}, fh)
            os.replace(tmp, self.resume_file)
        except OSError as ex:
            self.save_error = f"{type(ex).__name__}: {ex.strerror or ex}"
            return self.save_error
        self._saved = (dev, ino, pos)
        self.save_error = None
        return None

    def close(self):
        self._close()


def parse_line(line, incoming_markers):
    """-> (name, body) for an INCOMING whisper, else None.
    '2026/11/03 20:11:46 123 abcd [INFO Client 77] @From <GLD> Name: Hi, …' -> ('Name', 'Hi, …').
    The guild tag in angle brackets is cut off. Outgoing ones (@To, @An) and
    every other line: None."""
    m = LINE.match(str(line))
    if not m:
        return None
    rest = m.group(1)
    for marker in incoming_markers:
        if marker and rest.startswith(marker + " "):
            after = rest[len(marker) + 1:]
            break
    else:
        return None
    if after.startswith("<"):
        j = after.find("> ")
        if j < 0:
            return None
        after = after[j + 2:]
    name, sep, body = after.partition(": ")
    if not sep or not name or any(c.isspace() for c in name):
        return None
    return (name, body)


def is_trade(body, prefixes):
    """The text starts with one of the template beginnings (trade_prefixes)."""
    return any(p and str(body).startswith(p) for p in prefixes)


def looks_like_trade(body, hints):
    """A word from trade_hints, case-insensitive. LOCAL counting only."""
    low = str(body).lower()
    return any(h and str(h).lower() in low for h in hints)


def cut_body(body, max_chars=MAX_BODY_CHARS, max_bytes=MAX_BODY_BYTES):
    """-> (text, truncated): the longest start of body that is at most
    max_chars UTF-16 units (a character beyond U+FFFF, an emoji, is 2: the
    server's JavaScript counts so) and at most max_bytes bytes once written
    as a JSON string in UTF-8 (a quote or backslash is 2 bytes there, a
    control character 6). Never splits a character."""
    body = str(body)
    units = size = end = 0
    for ch in body:
        u = 2 if ord(ch) > 0xFFFF else 1
        b = len(json.dumps(ch, ensure_ascii=False).encode("utf-8")) - 2
        if units + u > max_chars or size + b > max_bytes:
            break
        units += u
        size += b
        end += 1
    out = body[:end]
    return out, out != body


class Pseudonyms:
    """name -> 'buyer N' for this daemon run, at most keep names (the oldest
    forgotten; it gets a new number when it comes back). Never persisted,
    never logged."""

    def __init__(self, keep=200):
        self.keep = int(keep)
        self._names = OrderedDict()
        self._n = 0

    def label(self, name):
        if name in self._names:
            self._names.move_to_end(name)
            return self._names[name]
        self._n += 1
        label = f"buyer {self._n}"
        self._names[name] = label
        while len(self._names) > self.keep:
            self._names.popitem(last=False)
        return label


class WhisperGate:
    """At most per_min posts in any minute; the same (buyer, body) within
    same_s is collapsed into a repeat of the first one.
    admit(buyer, body, now, wid) -> ('post', wid) | ('repeat', earlier wid) | ('drop', None)."""

    def __init__(self, per_min=30, same_s=60):
        self.per_min = int(per_min)
        self.same_s = float(same_s)
        self._posts = deque()
        self._recent = OrderedDict()  # (buyer, body) -> (wid, first time)

    def admit(self, buyer, body, now, wid):
        for k in [k for k, (_, t) in self._recent.items() if now - t > self.same_s]:
            del self._recent[k]
        seen = self._recent.get((buyer, body))
        if seen is not None:
            return ("repeat", seen[0])
        while self._posts and now - self._posts[0] >= 60:
            self._posts.popleft()
        if len(self._posts) >= self.per_min:
            return ("drop", None)
        self._posts.append(now)
        self._recent[(buyer, body)] = (wid, now)
        return ("post", wid)


class Whispers:
    """The daemon's part: tail, read, filter, post, show.

    tick(now) polls the tailer every poll_s; for each incoming whisper that
    is_trade(): wid = 'w<n>', label = pseudonyms.label(name); {wid: name,
    label, text} is kept in memory (at most `keep`, oldest dropped); the text
    is cut by cut_body() (then 'truncated': True) and
    POSTed as UTF-8 through the pool (tag 'whisper', 5 s). The answer, a feed
    event (kind 'whisper', this instance, the same wid) and every failure
    become a card: tick() and event() return [(card, toast)]. A pending
    verdict older than result_wait_s is closed as 'no market check within …'.
    A server without the route: one line, a card per whisper without a POST,
    asked again every reprobe_s. Not is_trade() but looks_like_trade(): counted
    only, one line an hour.

    state() -> 'off' is the daemon's (no client_log); here 'starting', 'ok',
    'missing', 'unreadable', 'not-a-file' or 'unsupported' (server too old)."""

    def __init__(self, path, *, pool, base_url, hdrs, log, clock, instance, incoming_markers,
                 trade_prefixes, trade_hints, poll_s=0.5, resume_file=None, result_wait_s=120,
                 keep=50, wall_clock=time.time, config_path="", user=None, lang="en",
                 toast_shows_name=False, per_min=30, same_s=60, reprobe_s=REPROBE_S, tailer=None):
        self.path = str(path)
        self.pool = pool
        self.base = str(base_url).rstrip("/")
        self.hdrs = list(hdrs)
        self.log = log
        self.clock = clock
        self.instance = instance
        self.markers = [str(m) for m in incoming_markers]
        self.prefixes = [str(p) for p in trade_prefixes]
        self.hint_words = [str(h) for h in trade_hints]
        self.poll_s = float(poll_s)
        self.result_wait_s = float(result_wait_s)
        self.keep = int(keep)
        self.config_path = config_path
        self.user = user
        self.lang = lang
        self.toast_shows_name = bool(toast_shows_name)
        self.reprobe_s = float(reprobe_s)
        self.per_min = int(per_min)
        self.tailer = tailer or LogTailer(self.path, resume_file=resume_file, clock=wall_clock)
        self.pseudonyms = Pseudonyms()
        self.gate = WhisperGate(per_min, same_s)
        self.recs = OrderedDict()   # wid -> record (memory only)
        self.hints = 0              # whispers that looked like trade offers, since the last hint line
        self._hint_due = None
        self._n = 0
        self._next_poll = None
        self._tstate = "starting"
        self._said_start = False
        self._said_save_error = None
        self._reopen_said_at = None  # clock() of the last 'was replaced' line
        self._reopen_quiet = 0       # replacements since then without a line
        self._said_churn = False
        self._link = "unknown"      # 'unknown' | 'ok' | 'failing' | 'unsupported'
        self._recheck_at = 0.0

    # --- state -----------------------------------------------------------------
    def state(self):
        t = self._tstate
        if t in PROBLEM_STATES or t == "starting":
            return t
        return "unsupported" if self._link == "unsupported" else "ok"

    # --- the log ---------------------------------------------------------------
    def _start_line(self):
        t = self.tailer
        if t.started == "resume":
            self.log.info(f"Whispers: reading {self.path} from where the last run stopped.")
        elif t.started == "start":
            self.log.info(f"Whispers: reading {self.path} from its start.")
        else:
            mb = t.size_at_open / 1048576
            self.log.info(f"Whispers: reading {self.path} from its end ({mb:.1f} MB); "
                          "whispers from before this start are not shown.")

    def _note(self, state, note, dropped):
        prev = self._tstate
        if state != prev:
            if state in PROBLEM_STATES:
                self.log.failure(*clientlog_problem(state, self.path, self.config_path, self.tailer.detail))
            elif state == "tailing":
                self.log.recovered("clientlog")
                if prev in PROBLEM_STATES:
                    self.log.info(f"Whispers are read again from {self.path}.")
                elif not self._said_start:
                    self._start_line()
        self._said_start = True
        self._tstate = state
        if note == "reopened":
            self._reopened()
        elif note == "reread":
            if self.tailer.started == "end":
                self.log.info(f"Whispers: {self.path} got shorter but is still large; reading on from its "
                              "end, whispers already in it are not shown.")
            else:
                self.log.info(f"Whispers: {self.path} got shorter, reading it again from the start.")
        churning = bool(getattr(self.tailer, "churning", False))
        if churning and not self._said_churn:
            self.log.info(f"Whispers: {self.path} keeps getting a new inode (several times a minute), as "
                          "if the file system did not keep it stable; it is read on from the same position "
                          "as one file. Next: nothing, unless whispers go missing or come twice; then find "
                          f"what keeps replacing it (ls -li {self.path} shows the inode).")
        self._said_churn = churning
        if dropped:
            self.log.failure(*clientlog_problem("long-line", self.path, self.config_path))
        err = self.tailer.save_error
        if err and err != self._said_save_error:
            self.log.failure(*clientlog_problem("resume", self.path, self.config_path, err))
        self._said_save_error = err

    def _reopened(self):
        """'was replaced': one line, then at most one per REOPEN_NOTE_S with the count."""
        now = self.clock()
        if self._reopen_said_at is not None and now - self._reopen_said_at < REOPEN_NOTE_S:
            self._reopen_quiet += 1
            return
        more = (f" ({self._reopen_quiet} more time(s) since the last such line)"
                if self._reopen_quiet else "")
        self.log.info(f"Whispers: {self.path} was replaced, reading the new file{more}.")
        self._reopen_said_at = now
        self._reopen_quiet = 0

    def _poll(self, now):
        state, lines, dropped, note = self.tailer.poll()
        self._note(state, note, dropped)
        out = []
        for line in lines:
            parsed = parse_line(line, self.markers)
            if parsed is None:
                continue
            name, body = parsed
            if is_trade(body, self.prefixes):
                out += self._trade(name, body, now)
            elif looks_like_trade(body, self.hint_words):
                self.hints += 1
                if self._hint_due is None:
                    self._hint_due = now + HINT_EVERY_S
        return out

    # --- one whisper -------------------------------------------------------------
    def _render(self, wid, rec):
        name = rec["name"]
        if rec.get("failure") == "unsupported":
            card = whisper_unsupported_card(wid, rec["label"], name, self.lang, rec["repeats"])
        elif rec.get("failure"):
            card = whisper_failure_card(wid, rec["label"], rec["failure"], name, self.lang, rec["repeats"])
        else:
            card = whisper_card(rec["entry"], name, rec.get("note"), self.lang, rec.get("closed"),
                                rec["repeats"])
        return (card, whisper_toast_for(card, self.toast_shows_name))

    def _shown(self, rec):
        return rec.get("entry") is not None or rec.get("failure") is not None

    def _trade(self, name, body, now):
        label = self.pseudonyms.label(name)
        decision, wid = self.gate.admit(name, body, now, f"w{self._n + 1}")
        if decision == "drop":
            self.log.failure(("whisper-rate", "drop"),
                             f"More than {self.per_min} trade whispers in a minute: the rest of this minute "
                             "is not checked (the game's chat shows them as usual). Next: nothing, unless "
                             "this repeats.")
            return []
        if decision == "repeat":
            rec = self.recs.get(wid)
            if rec is None:
                return []
            rec["repeats"] += 1
            return [self._render(wid, rec)] if self._shown(rec) else []
        self._n += 1
        text, truncated = cut_body(body)
        rec = {"name": name, "label": label, "body": text, "note": None, "entry": None, "job": None,
               "sig": None, "repeats": 0, "pending_since": None, "failure": None, "closed": None, "at": now}
        self.recs[wid] = rec
        while len(self.recs) > self.keep:
            self.recs.popitem(last=False)
        if self._link == "unsupported" and now < self._recheck_at:
            rec["failure"] = "unsupported"
            return [self._render(wid, rec)]
        payload = {"v": 1, "wid": wid, "body": text, "label": label}
        if truncated:
            payload["truncated"] = True
        rec["job"] = post_json(self.pool, self.base, "/daemon/whisper", payload, self.hdrs,
                               timeout_s=5, tag="whisper", ensure_ascii=False)
        return []

    def _link_ok(self):
        if self._link == "unsupported":
            self.log.info(link_recovered("whisper", 0, was_unsupported=True))
        else:
            n = self.log.recovered("whisper")
            if n:
                self.log.info(link_recovered("whisper", n))
        self._link = "ok"

    def _answered(self, wid, rec, res, now):
        verdict = classify(res)
        if verdict[0] == "ok" and not isinstance(verdict[1].get("entry"), dict):
            verdict = ("failing", "not-json", str(res.status))
        if verdict[0] == "ok":
            self._link_ok()
            return self._take(wid, rec, verdict[1]["entry"], now)
        if self._shown(rec) and rec.get("failure") is None:
            return []  # the feed brought its entry already; the HTTP answer is not needed
        if verdict[0] == "unsupported":
            if self._link != "unsupported":
                self.log.failure(*link_problem("whisper", verdict, self.base, self.config_path,
                                               self.reprobe_s, self.user))
            self._link = "unsupported"
            self._recheck_at = now + self.reprobe_s
            rec["failure"] = "unsupported"
            return [self._render(wid, rec)]
        key, text = link_problem("whisper", verdict, self.base, self.config_path, self.reprobe_s, self.user)
        self.log.failure(key, f"Whisper {wid} ({rec['label']}) not checked: {text}")
        self._link = "failing"
        rec["failure"] = verdict[1]
        return [self._render(wid, rec)]

    def _take(self, wid, rec, entry, now):
        sig = (entry.get("verdict"), entry.get("reason"))
        if entry.get("verdict") == "pending" and rec.get("entry") is not None \
                and rec["entry"].get("verdict") != "pending":
            return []  # a final card never falls back to pending
        if rec.get("failure") is None and rec.get("closed") is None and rec.get("sig") == sig:
            rec["entry"] = entry
            return []  # the server sends every entry as the answer and into the feed
        rec.update(entry=entry, sig=sig, failure=None, closed=None)
        ext = entry.get("extraLen")
        body = rec["body"]
        if isinstance(ext, int) and not isinstance(ext, bool) and 0 < ext <= len(body):
            rec["note"] = body[len(body) - ext:].strip() or None
        rec["pending_since"] = now if entry.get("verdict") == "pending" else None
        return [self._render(wid, rec)]

    def event(self, ev, now):
        """One feed event. Only kind 'whisper' of this instance for a wid this
        run posted -> [(card, toast)], or [] when the card shown for that wid
        already says this verdict and reason."""
        if not isinstance(ev, dict) or ev.get("kind") != "whisper" or ev.get("by") != self.instance:
            return []
        entry = ev.get("entry")
        if not isinstance(entry, dict):
            return []
        wid = ev.get("wid") or entry.get("wid")
        rec = self.recs.get(wid) if isinstance(wid, str) else None
        if rec is None:
            return []  # not this run's, or dropped from memory: no name, no text to show
        return self._take(wid, rec, entry, now)

    # --- once per loop round --------------------------------------------------
    def tick(self, now):
        out = []
        for wid, rec in list(self.recs.items()):
            job = rec.get("job")
            if job is not None and job.result is not None:
                rec["job"] = None
                out += self._answered(wid, rec, job.result, now)
        if self._next_poll is None or now >= self._next_poll:
            self._next_poll = now + self.poll_s
            out += self._poll(now)
        for wid, rec in self.recs.items():
            since = rec.get("pending_since")
            if since is not None and now - since > self.result_wait_s:
                rec["pending_since"] = None
                rec["closed"] = f"no market check within {wait_text(self.result_wait_s)}"
                out.append(self._render(wid, rec))
        if self.hints and self._hint_due is not None and now >= self._hint_due:
            self.log.info(f"{self.hints} whisper(s) that looked like trade offers did not start like a "
                          "trade-site template and stayed on this PC. Next: if your client writes another "
                          f"template, add its first words to trade_prefixes in {self.config_path}.")
            self.hints = 0
            self._hint_due = None
        return out

    def positions(self):
        """The whispers of this run whose server entry names a stash cell,
        newest first: [{wid, label, tab, left, top, quad, at}] for the stash
        cell frame (ppt_stash_grid) and the value key (ppt_value_grid). quad
        is the entry's (True, False or None); at is when the whisper was read
        (the daemon's monotonic clock). The buyer's name is not part of it."""
        out = []
        for wid, rec in reversed(self.recs.items()):
            e = rec.get("entry")
            if not isinstance(e, dict):
                continue
            tab, left, top = e.get("tab"), e.get("left"), e.get("top")
            if not (isinstance(tab, str) and all(isinstance(v, int) and not isinstance(v, bool) for v in (left, top))):
                continue
            quad = e.get("quad")
            out.append({"wid": wid, "label": rec["label"], "tab": tab, "left": left, "top": top,
                        "quad": quad if isinstance(quad, bool) else None, "at": rec.get("at")})
        return out

    def close(self):
        """Save the read position (the daemon's exit). Returns an error text or None."""
        err = self.tailer.save()
        self.tailer.close()
        return err
