"""ppt_display — shows a result card on this PC: through the overlay process
while it works and the game has focus, else as a desktop notification. Never
blocks the daemon: both are child processes, read and reaped in tick(). Every
way this can fail is a state with one journal line (categories notify,
overlay), never silence.

Notifier     notify-send, one notification per slot that replaces itself
             ('item' for the price check, 'whisper:<wid>' per buyer whisper,
             'session' for the farm and game session cards, 'grid' for the
             value grid).
OverlayLink  the daemon's side of ppt_overlay.py (PySide6, a process of its
             own, JSON lines on its stdin and stdout). Exit 3 (no PySide6) and
             a hello on another platform than xcb are final until the daemon
             restarts; exit 4 or an abort before the hello (no display) is
             tried again at the next card, at the earliest after reprobe_s;
             anything else is restarted after RESTART_STEPS_S, then 'failed'.
FocusProbe   has the game the keyboard focus? xdotool and xprop as children
             through the CurlPool; the display reads only the last answer.
Display      where a card goes: the overlay while it is 'ok' and (with
             overlay_only_in_game) the game has focus, else the notification.
             An item card goes next to the mouse, a whisper card
             (show_whisper) and a session card (show_session) into the
             overlay's stack at a fixed anchor, the stash cell frame
             (show_frame) to the overlay only, the value grid (show_grid)
             over the stash, else as a notification of its dearest cells.

Why notify-send: the standard library has no D-Bus, and notify-send is part of
libnotify on every desktop that shows notifications. A fact it cannot see:
KDE Plasma holds notifications back while a fullscreen window has focus unless
the user switched that off (plasmanotifyrc, [DoNotDisturb] WhenFullscreen);
notify-send still succeeds. kde_fullscreen_mute() reads the switch once,
at start.

Why the overlay's platform is set here: Path of Exile under Proton is an X11
client on XWayland, and only a window of the same X server can lie above it.
The child's QT_QPA_PLATFORM is OVERWRITTEN with `platform` (xcb), never
inherited: a session's QT_QPA_PLATFORM=wayland would open a Wayland window
below the game. Only tests pass platform='offscreen'.

Standard library only (backend/v2/daemon-display.test.mjs).
"""
import json
import os
import shutil
import signal
import subprocess
import time
from collections import OrderedDict

from ppt_diag import first_line, notify_problem, overlay_problem
from ppt_link import CurlPool
from ppt_results import toast_for

NOTIFY_DEADLINE_S = 5
# The overlay process: its hello within HELLO_S of the start, a ping every
# PING_EVERY_S answered within PONG_S, restarts after RESTART_STEPS_S, and a
# run of RESTART_RESET_S without a fault forgets the earlier faults.
HELLO_S = 5
PING_EVERY_S = 30
PONG_S = 5
RESTART_STEPS_S = (5, 30, 120)
RESTART_RESET_S = 600
OVERLAY_REPROBE_S = 600
SEND_BUFFER_MAX = 256 * 1024  # bytes waiting for an overlay that reads slowly; beyond, cards are dropped
READ_KEEP = 65536
FOCUS_EVERY_S = 0.25
FOCUS_DEADLINE_S = 1


def _escape(text):
    # Notification servers may read markup in the body; a text from the server
    # (or, later, a buyer's whisper) must never render as markup.
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Notifier:
    """notify-send as a child process, one notification per slot that
    replaces itself (--replace-id with the id --print-id gave). Slots: 'item'
    for the price check, 'whisper:<wid>' for each buyer whisper, so a late
    result of one whisper never replaces the notification of another. At
    most max_slots ids are remembered, the oldest whisper slot is forgotten
    first ('item' only when nothing else is left). While a call of a slot
    runs, only the newest text for it waits (no queue)."""

    def __init__(self, log, clock=time.monotonic, *, program="notify-send", app_name="poe-price-tool",
                 expire_ms=8000, max_slots=8, spawn=subprocess.Popen, which=shutil.which,
                 deadline_s=NOTIFY_DEADLINE_S):
        self.log = log
        self.app_name = app_name
        self.expire_ms = int(expire_ms)
        self.max_slots = int(max_slots)
        self.deadline_s = float(deadline_s)
        self.path = which(program)
        self.pool = CurlPool(clock=clock, spawn=spawn)
        self._state = "ok" if self.path else "missing"
        self._said_missing = False
        self.ids = OrderedDict()   # slot -> notification id
        self.running = {}          # slot -> job
        self.waiting = {}          # slot -> (summary, body)

    def state(self):
        return self._state

    def check(self):
        """Write the one 'missing' line now, if notify-send is missing (the
        start-up check calls this, so the line is there before any item)."""
        if self._state == "missing" and not self._said_missing:
            self._said_missing = True
            self.log.failure(*notify_problem("missing"))

    def args(self, summary, body, replace_id=None):
        a = [f"--app-name={self.app_name}", f"--expire-time={self.expire_ms}", "--urgency=normal",
             "--transient", "--print-id"]
        if replace_id is not None:
            a.append(f"--replace-id={replace_id}")
        return a + ["--", str(summary), _escape(body)]

    def show(self, slot, summary, body):
        if self._state == "missing":
            self.check()
            return
        if slot in self.running:
            self.waiting[slot] = (summary, body)
            return
        self._spawn(slot, summary, body)

    def _spawn(self, slot, summary, body):
        job = self.pool.start_cmd([self.path, *self.args(summary, body, self.ids.get(slot))],
                                  timeout_s=self.deadline_s, tag=slot)
        if job.proc is None:  # could not be started at all (removed since the start)
            self._state = "missing"
            self.check()
            return
        self.running[slot] = job

    def _trim(self):
        while len(self.ids) > self.max_slots:
            old = next((k for k in self.ids if k != "item"), None)
            if old is None:
                self.ids.popitem(last=False)
            else:
                del self.ids[old]

    def tick(self, now=None):
        if not self.running:
            return
        self.pool.reap()
        for slot, job in list(self.running.items()):
            res = job.result
            if res is None:
                continue
            del self.running[slot]
            if res.timed_out:
                self._state = "failing"
                self.log.failure(*notify_problem("timeout"))
            elif res.rc != 0:
                self._state = "failing"
                self.log.failure(*notify_problem((res.rc, res.err)))
            else:
                line = first_line(res.body)
                if line.isdigit():
                    self.ids[slot] = int(line)
                    self.ids.move_to_end(slot)
                    self._trim()
                n = self.log.recovered("notify")
                if n:
                    self.log.info(f"Notifications work again ({n} failed attempt(s) before).")
                self._state = "ok"
            nxt = self.waiting.pop(slot, None)
            if nxt is not None and self._state != "missing":
                self._spawn(slot, *nxt)

    def close(self):
        self.pool.close()


class OverlayLink:
    """The daemon's side of ppt_overlay.py. The pipe to the child is
    non-blocking: what does not fit (an overlay that stopped reading) waits in
    a bounded buffer, and a command beyond it is dropped, counted and answered
    False, so the caller uses the notification; a drop also starts the pong
    deadline, so an overlay that stopped reading counts as hung.

    States: 'off' (not started, or closed), 'starting' (waiting for hello),
    'ok', 'no-qt' (exit 3: no restart, it would fail the same way),
    'no-display' (exit 4, an abort before the hello, or no DISPLAY at all:
    started again at the next card, at the earliest reprobe_s later; the
    service can start at login before XWayland is up), 'wrong-platform' (a
    hello naming another platform than `platform`), 'restarting' (after an
    exit, a missing hello or a missing pong; restarts after restart_steps),
    'failed' (all steps used; off until the daemon restarts).

    env: a copy of the daemon's (DISPLAY, XAUTHORITY) with QT_QPA_PLATFORM and
    PPT_OVERLAY_PLATFORM set to `platform`. required: [results] overlay = "on"
    makes a missing PySide6 a failure line; "auto" an info line."""

    def __init__(self, log, clock=time.monotonic, *, argv, env, style=None, platform="xcb",
                 reprobe_s=OVERLAY_REPROBE_S, spawn=subprocess.Popen, restart_steps=RESTART_STEPS_S,
                 hello_s=HELLO_S, ping_every_s=PING_EVERY_S, pong_s=PONG_S, required=False):
        self.log = log
        self.clock = clock
        self.argv = list(argv)
        self.env = dict(env)
        self.platform = platform
        self.reprobe_s = float(reprobe_s)
        self.spawn = spawn
        self.restart_steps = tuple(restart_steps)
        self.hello_s = float(hello_s)
        self.ping_every_s = float(ping_every_s)
        self.pong_s = float(pong_s)
        self.required = bool(required)
        self._style = dict(style) if style else None
        self._state = "off"
        self._proc = None
        self._dying = []
        self._out = bytearray()   # what waits for the child's stdin
        self._in = bytearray()    # the child's stdout, up to the next newline
        self._err = []            # the child's last stderr lines
        self._errbuf = bytearray()
        self.failures = 0
        self.dropped = 0
        self.hello = None
        self.last_shown = None    # the overlay's last 'shown' answer (where a card went)
        self._said_ready = False
        self._deadline = 0.0      # hello deadline while starting
        self._retry_at = None     # no-display: earliest re-check; restarting: the restart
        self._ok_since = None
        self._ping_n = 0
        self._ping_wait = None    # pong deadline
        self._next_ping = 0.0

    def state(self):
        return self._state

    # --- start and stop -------------------------------------------------------
    def child_env(self):
        env = dict(self.env)
        env["QT_QPA_PLATFORM"] = self.platform
        env["PPT_OVERLAY_PLATFORM"] = self.platform
        return env

    def start(self, now):
        if self._proc is not None:
            return
        if self.platform == "xcb" and not self.env.get("DISPLAY"):
            self._no_display(now, "DISPLAY is not set for the daemon service")
            return
        try:
            p = self.spawn(self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=self.child_env())
        except Exception as ex:
            self._fail(now, "exited", f"- {type(ex).__name__}: {ex}")
            return
        for f in (p.stdin, p.stdout, p.stderr):
            os.set_blocking(f.fileno(), False)
        self._proc = p
        self._out.clear()
        self._in.clear()
        self._errbuf.clear()
        self._err = []
        self._state = "starting"
        self._deadline = now + self.hello_s
        self._ping_wait = None
        self.hello = None

    def _stop_child(self, quit_first=False):
        p, self._proc = self._proc, None
        if p is None:
            return
        if quit_first:
            try:
                os.write(p.stdin.fileno(), b'{"cmd":"quit"}\n')
            except OSError:
                pass
        for f in (p.stdin, p.stdout, p.stderr):
            try:
                f.close()
            except OSError:
                pass
        if not quit_first:
            try:
                p.terminate()
            except OSError:
                pass
        self._dying.append(p)

    def close(self):
        """quit, end of stdin, up to 1 s for the child to go, then SIGTERM."""
        p = self._proc
        self._stop_child(quit_first=True)
        if p is not None:
            try:
                p.wait(timeout=1)
            except Exception:
                pass
        for d in self._dying:
            if d.poll() is None:
                try:
                    d.terminate()
                except OSError:
                    pass
        self._dying = []
        self._state = "off"

    # --- faults ---------------------------------------------------------------
    def _no_display(self, now, detail):
        self._stop_child()
        self._state = "no-display"
        self._retry_at = now + self.reprobe_s
        self.log.failure(*overlay_problem("no-display", detail, seconds=self.reprobe_s))

    def _fail(self, now, kind, detail=""):
        """A fault that a restart may cure: the next step, or 'failed'."""
        self._stop_child()
        self.failures += 1
        if self.failures > len(self.restart_steps):
            self._state = "failed"
            self._retry_at = None
            self.log.failure(*overlay_problem("failed", count=self.failures))
            return
        wait = self.restart_steps[self.failures - 1]
        self._state = "restarting"
        self._retry_at = now + wait
        self.log.failure(*overlay_problem(kind, detail, seconds=wait))

    def _exited(self, now, rc):
        detail = self._err[-1] if self._err else ""
        if rc == 3:
            self._stop_child()
            self._state = "no-qt"
            key, text = overlay_problem("no-qt", detail)
            if self.required:
                self.log.failure(key, text)
            else:
                self.log.info(text)
        elif rc == 4 or (rc == -signal.SIGABRT and self.hello is None):
            # Qt aborts the process when it cannot open its platform.
            self._no_display(now, detail or "Qt stopped while opening its platform (SIGABRT)")
        else:
            self._fail(now, "exited", f"{rc} {detail}".strip())

    # --- the pipe -------------------------------------------------------------
    def send(self, obj):
        """One command to the overlay. False when it is not 'ok' or the
        command was dropped: then the caller uses the notification."""
        if self._state != "ok" or self._proc is None:
            return False
        line = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        self._flush()
        if len(self._out) + len(line) > SEND_BUFFER_MAX:
            self.dropped += 1
            if self._ping_wait is None:
                # The pong cannot come either: a hung overlay is noticed by it.
                self._ping_wait = self.clock() + self.pong_s
            return False
        self._out += line
        return self._flush()

    def _flush(self):
        """Write what waits, as far as the pipe takes it. False when the
        child's stdin is gone (it ended; tick() sees the exit)."""
        if not self._out or self._proc is None:
            return self._proc is not None
        try:
            n = os.write(self._proc.stdin.fileno(), self._out)
            del self._out[:n]
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            self._out.clear()
            return False
        return True

    def style(self, obj):
        """Remembered and sent after EVERY hello, so a restarted overlay keeps it."""
        self._style = dict(obj)
        self.send({"cmd": "style", **self._style})

    def hide(self, key):
        """Take a card off the screen (the Display: the game lost focus, or a
        later card went to the notification). False when it did not go out."""
        return self.send({"cmd": "hide", "key": key})

    def show(self, card):
        """The Display's slot: the item card, True when it went out."""
        if self._state == "no-display" and self._retry_at is not None and self.clock() >= self._retry_at:
            self.start(self.clock())
            return False
        return self.send({"cmd": "item", "key": card.get("key"), "title": card.get("title"),
                          "lines": card.get("lines") or [], "final": bool(card.get("final")),
                          "again": bool(card.get("again"))})

    def show_whisper(self, card):
        """A whisper card into the overlay's stack (the anchor and the hold
        time come with the style); True when it went out."""
        if self._state == "no-display" and self._retry_at is not None and self.clock() >= self._retry_at:
            self.start(self.clock())
            return False
        return self.send({"cmd": "whisper", "key": card.get("key"), "title": card.get("title"),
                          "lines": card.get("lines") or []})

    def show_frame(self, frame):
        """The stash cell frame (ppt_stash_grid); True when it went out.
        Display.show_frame calls it only while the overlay is 'ok'; a missing
        display is re-checked by the card that says the frame could not be
        shown (show)."""
        return self.send({"cmd": "frame", "key": frame.get("key"), "x": frame.get("x"), "y": frame.get("y"),
                          "w": frame.get("w"), "h": frame.get("h"), "label": frame.get("label"),
                          "hold_ms": frame.get("hold_ms")})

    def show_grid(self, grid):
        """The value grid (ppt_value_grid); True when it went out."""
        if self._state == "no-display" and self._retry_at is not None and self.clock() >= self._retry_at:
            self.start(self.clock())
            return False
        return self.send({"cmd": "grid", "key": grid.get("key"), "x": grid.get("x"), "y": grid.get("y"),
                          "w": grid.get("w"), "h": grid.get("h"), "cells": grid.get("cells") or [],
                          "label": grid.get("label"), "hold_ms": grid.get("hold_ms")})

    def _read(self):
        p = self._proc
        for f, buf in ((p.stdout, self._in), (p.stderr, self._errbuf)):
            while True:
                try:
                    chunk = os.read(f.fileno(), 65536)
                except (BlockingIOError, InterruptedError):
                    break
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                if len(buf) > READ_KEEP and b"\n" not in buf:
                    buf.clear()  # one endless line: dropped
        while b"\n" in self._errbuf:
            i = self._errbuf.index(b"\n")
            text = self._errbuf[:i].decode("utf-8", "replace").strip()
            del self._errbuf[:i + 1]
            if text:
                self._err = (self._err + [text])[-3:]
        msgs = []
        while b"\n" in self._in:
            i = self._in.index(b"\n")
            raw = bytes(self._in[:i])
            del self._in[:i + 1]
            try:
                msg = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(msg, dict):
                msgs.append(msg)
        return msgs

    # --- once per loop round ---------------------------------------------------
    def tick(self, now):
        self._dying = [d for d in self._dying if d.poll() is None]
        if self._state in ("restarting",) and self._retry_at is not None and now >= self._retry_at:
            self.start(now)
        if self._proc is None:
            return
        for msg in self._read():
            self._on_message(now, msg)
            if self._proc is None:
                return
        rc = self._proc.poll()
        if rc is not None:
            self._read()  # its last stderr line names the cause
            self._exited(now, rc)
            return
        if self._state == "starting" and now >= self._deadline:
            self._fail(now, "no-hello", f"{self.hello_s:g} s")
            return
        if self._state != "ok":
            return
        self._flush()
        if self._ok_since is not None and now - self._ok_since >= RESTART_RESET_S:
            self.failures = 0
        if self._ping_wait is not None:
            if now >= self._ping_wait:
                self._fail(now, "hung")
            return
        if now >= self._next_ping:
            self._ping_n += 1
            self._ping_wait = now + self.pong_s
            self.send({"cmd": "ping", "n": self._ping_n})

    def _on_message(self, now, msg):
        kind = msg.get("type")
        if kind == "hello" and self._state == "starting":
            self.hello = msg
            platform = str(msg.get("platform") or "")
            if platform != self.platform:
                self._stop_child(quit_first=True)
                self._state = "wrong-platform"
                self.log.failure(*overlay_problem("wrong-platform", platform))
                return
            self._state = "ok"
            self._ok_since = now
            self._next_ping = now + self.ping_every_s
            self._ping_wait = None
            n = self.log.recovered("overlay")
            if n:
                self.log.info(f"The overlay works again ({n} failed attempt(s) before).")
            elif not self._said_ready:
                self.log.info(f"Overlay ready: {msg.get('binding')} {msg.get('qt')} on {platform}, "
                              f"{msg.get('screens')} screen(s).")
            self._said_ready = True
            if self._style:
                self.send({"cmd": "style", **self._style})
        elif kind == "shown":
            self.last_shown = msg
        elif kind == "pong" and msg.get("n") == self._ping_n:
            self._ping_wait = None
            self._next_ping = now + self.ping_every_s


class FocusProbe:
    """Has the game the keyboard focus? The same test as the daemon's
    is_poe_focused (xdotool getwindowfocus, then xprop -id <wid> WM_CLASS, the
    window class as a lower-case substring), but started through the CurlPool:
    tick() starts a check at most every every_s and reads its answer when it is
    there; state() only returns the last answer and never waits. xprop runs
    only for a window id not seen before (a successful answer per id is kept;
    a failed xprop is asked again at the next check).

    States: 'focused', 'not-focused', 'unknown' (no answer yet, the last
    check timed out, or xprop failed), 'no-focus-check' (xdotool or xprop
    missing)."""

    def __init__(self, window_class, pool, clock=time.monotonic, *, every_s=FOCUS_EVERY_S,
                 which=shutil.which, deadline_s=FOCUS_DEADLINE_S):
        self.window_class = str(window_class).lower()
        self.pool = pool
        self.clock = clock
        self.every_s = float(every_s)
        self.deadline_s = float(deadline_s)
        self.xdotool = which("xdotool")
        self.xprop = which("xprop")
        self._state = "unknown" if (self.xdotool and self.xprop) else "no-focus-check"
        self._job = None
        self._stage = None
        self._wid = None
        self._seen = (None, False)  # (window id, is the game)
        self._next = 0.0

    def state(self):
        return self._state

    def tick(self, now):
        if self._state == "no-focus-check":
            return
        if self._job is None:
            if now >= self._next:
                self._stage = "wid"
                self._job = self.pool.start_cmd([self.xdotool, "getwindowfocus"],
                                                timeout_s=self.deadline_s, tag="focus")
            return
        res = self._job.poll(now)
        if res is None:
            return
        self._job = None
        if res.rc == 127:  # removed since the start
            self._state = "no-focus-check"
            return
        if res.timed_out:
            self._state = "unknown"
            self._next = now + self.every_s
            return
        if self._stage == "wid":
            wid = first_line(res.body)
            if res.rc != 0 or not wid:
                self._state = "not-focused"  # no focused window
                self._next = now + self.every_s
                return
            if wid == self._seen[0]:
                self._state = "focused" if self._seen[1] else "not-focused"
                self._next = now + self.every_s
                return
            self._wid = wid
            self._stage = "class"
            self._job = self.pool.start_cmd([self.xprop, "-id", wid, "WM_CLASS"],
                                            timeout_s=self.deadline_s, tag="focus")
            return
        self._next = now + self.every_s
        if res.rc != 0:
            # xprop failed (a window gone meanwhile, a short X error): no
            # answer for this id, so it is not kept; the next tick asks again.
            self._state = "unknown"
            return
        is_game = self.window_class in str(res.body).lower()
        self._seen = (self._wid, is_game)
        self._state = "focused" if is_game else "not-focused"


class Display:
    """Where a card goes: the overlay while it is 'ok' and takes the card (with
    only_in_game: only while focus says 'focused'), else the notification.
    notifier None: notifications switched off ([results] notify = false);
    overlay None: no overlay (state 'off'); focus None: no focus check (the
    overlay is used whenever it is 'ok').

    A card the overlay shows is hidden again when the game loses focus (with
    only_in_game) and when a later card goes to the notification, so the
    overlay never shows an older state than the notification, nor stands over
    another window. Whisper cards (show_whisper) follow the same rules, each
    under its own key; the notification slot is the card's key."""

    WHISPER_KEYS_KEPT = 16

    def __init__(self, log, *, notifier=None, overlay=None, focus=None, only_in_game=True):
        self.log = log
        self.notifier = notifier
        self.overlay = overlay
        self.focus = focus
        self.only_in_game = bool(only_in_game)
        self._said_focus = False
        self._on_overlay = None  # key of the item card the overlay took last
        self._whispers_on_overlay = OrderedDict()  # keys of whisper cards the overlay took
        self._frame_on_overlay = None  # key of the stash cell frame the overlay took
        self._grid_on_overlay = None   # key of the value grid the overlay took

    def _focus_missing(self):
        return (self.overlay is not None and self.only_in_game and self.focus is not None
                and self.focus.state() == "no-focus-check")

    def check(self):
        """The one line when the overlay can never be used because the focus
        check is missing (start-up calls this; show_item too): a failure with
        overlay = "on", an info line with "auto"."""
        if self._focus_missing() and not self._said_focus:
            self._said_focus = True
            key, text = overlay_problem("no-focus-check")
            # Like a missing PySide6: a failure only when overlay = "on" asked for it.
            if getattr(self.overlay, "required", True):
                self.log.failure(key, text)
            else:
                self.log.info(text)

    def start(self, now):
        """Start the overlay process, unless it could never be used."""
        if self.overlay is None:
            return
        if self._focus_missing():
            self.check()
            return
        start = getattr(self.overlay, "start", None)
        if start is not None:
            start(now)

    def _use_overlay(self):
        if self.overlay is None or self.overlay.state() != "ok":
            return False
        if self.focus is None or not self.only_in_game:
            return True
        st = self.focus.state()
        if st == "no-focus-check":
            self.check()
            return False
        return st == "focused"

    def show_item(self, card):
        if card is None:
            return
        if self._use_overlay():
            try:
                if self.overlay.show(card):
                    self._on_overlay = card.get("key")
                    return
            except Exception:
                pass  # the overlay's own state says what broke; the card still goes out below
        self._hide_overlay()
        if self.overlay is not None and self.overlay.state() == "no-display":
            try:
                self.overlay.show(card)  # only re-checks the display when it is due
            except Exception:
                pass
        if self.notifier is not None:
            self.notifier.show("item", *toast_for(card))

    def show_whisper(self, card, toast):
        """A buyer-whisper card; toast is its (summary, body) for the
        notification (ppt_results.whisper_toast_for: the pseudonym, not the
        name). Slot and overlay key: the card's key."""
        if card is None:
            return
        key = card.get("key")
        if self._use_overlay():
            try:
                if self.overlay.show_whisper(card):
                    self._whispers_on_overlay.pop(key, None)
                    self._whispers_on_overlay[key] = True
                    while len(self._whispers_on_overlay) > self.WHISPER_KEYS_KEPT:
                        self._whispers_on_overlay.popitem(last=False)
                    return
            except Exception:
                pass  # the overlay's own state says what broke; the card still goes out below
        if self._whispers_on_overlay.pop(key, None):
            self._send_hide(key)
        if self.overlay is not None and self.overlay.state() == "no-display":
            try:
                self.overlay.show_whisper(card)  # only re-checks the display when it is due
            except Exception:
                pass
        if self.notifier is not None:
            self.notifier.show(key, *toast)

    def show_session(self, card):
        """A farm or game session card (ppt_results.session_card): into the
        overlay's stack, like a whisper card, else the notification slot
        'session'; each one replaces the one before."""
        if card is None:
            return
        self.show_whisper(card, toast_for(card))

    def show_frame(self, frame):
        """The stash cell frame: only to the overlay (a notification
        cannot point at a cell). False when the overlay cannot take it now:
        not 'ok', the game not focused (with only_in_game), or the send
        failed; the caller then says so on a card."""
        if not self._use_overlay():
            return False
        show = getattr(self.overlay, "show_frame", None)
        try:
            ok = bool(show(frame)) if show is not None else False
        except Exception:
            ok = False
        if ok:
            self._frame_on_overlay = frame.get("key")
        return ok

    def show_grid(self, grid, toast):
        """The value grid: to the overlay while it can take it (the same
        choice as for a price card), else toast (summary, body) into the
        notification slot 'grid'. -> 'overlay', 'notification' or None
        (neither is on)."""
        if self._use_overlay():
            try:
                if self.overlay.show_grid(grid):
                    self._grid_on_overlay = grid.get("key")
                    return "overlay"
            except Exception:
                pass  # the overlay's own state says what broke; the grid still goes out below
        if self._grid_on_overlay is not None:
            key, self._grid_on_overlay = self._grid_on_overlay, None
            self._send_hide(key)
        if self.overlay is not None and self.overlay.state() == "no-display":
            try:
                self.overlay.show_grid(grid)  # only re-checks the display when it is due
            except Exception:
                pass
        if self.notifier is None:
            return None
        self.notifier.show("grid", *toast)
        return "notification"

    def hide_grid(self, key):
        """The value grid goes (the press after the last tab)."""
        if self._grid_on_overlay is not None and self._grid_on_overlay == key:
            self._grid_on_overlay = None
            self._send_hide(key)

    def _send_hide(self, key):
        if key is None or self.overlay is None or self.overlay.state() != "ok":
            return  # an overlay that is not 'ok' was stopped and shows nothing
        hide = getattr(self.overlay, "hide", None)
        if hide is not None:
            try:
                hide(key)
            except Exception:
                pass

    def _hide_overlay(self):
        """The overlay's item card goes (if it still shows one): the card is
        now the notification's, or the game lost focus."""
        key, self._on_overlay = self._on_overlay, None
        self._send_hide(key)

    def _hide_whispers(self):
        keys = list(self._whispers_on_overlay)
        self._whispers_on_overlay.clear()
        for key in keys:
            self._send_hide(key)

    def tick(self, now):
        if (self.focus is not None and self.overlay is not None and self.only_in_game
                and self.overlay.state() in ("ok", "starting")):
            self.focus.tick(now)
            if self.focus.state() == "not-focused":
                if self._on_overlay is not None:
                    self._hide_overlay()
                if self._whispers_on_overlay:
                    self._hide_whispers()
                if self._frame_on_overlay is not None:
                    key, self._frame_on_overlay = self._frame_on_overlay, None
                    self._send_hide(key)
                if self._grid_on_overlay is not None:
                    key, self._grid_on_overlay = self._grid_on_overlay, None
                    self._send_hide(key)
        for part in (self.notifier, self.overlay):
            if part is not None:
                part.tick(now)

    def features(self):
        if self.overlay is None:
            overlay = "off"
        elif self._focus_missing():
            overlay = "no-focus-check"
        else:
            overlay = self.overlay.state()
        return {"notify": self.notifier.state() if self.notifier is not None else "off",
                "overlay": overlay}

    def close(self):
        for part in (self.overlay, self.notifier):
            if part is not None:
                try:
                    part.close()
                except Exception:
                    pass


def kde_fullscreen_mute(env=os.environ, run=subprocess.run, which=shutil.which):
    """Is Plasma's switch on that mutes notifications under a focused
    fullscreen window? True or False as kreadconfig6 reads it (its default is
    on); None when the desktop is not KDE, kreadconfig6 is not there, or the
    read fails. The self-test (section 9) asks the same switch."""
    if "KDE" not in str(env.get("XDG_CURRENT_DESKTOP", "")).upper():
        return None
    prog = which("kreadconfig6")
    if not prog:
        return None
    try:
        r = run([prog, "--file", "plasmanotifyrc", "--group", "DoNotDisturb", "--key", "WhenFullscreen",
                 "--default", "true"], capture_output=True, text=True, timeout=3)
    except Exception:
        return None
    value = str(getattr(r, "stdout", "") or "").strip().lower()
    return True if value == "true" else False if value == "false" else None
