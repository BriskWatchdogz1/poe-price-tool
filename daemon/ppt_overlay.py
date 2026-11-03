#!/usr/bin/env python3
"""ppt_overlay — the click-through card over the game (poe-price-tool, MIT).

Started by poe-price-daemon.py as a child (ppt_display.OverlayLink); by hand
only with --probe (say which Qt it found and whether a window can be created,
without showing one, then exit), --demo (a test card at the mouse for 5 s),
--session (a sample session card, ppt_results.session_card, where whisper
cards stack, for 5 s) or --frame X,Y,W,H (the stash cell frame at that
rectangle for 3 s); ./daemon/selftest.sh --overlay runs the last three.
Written for this project; only the technique (an X11 window that bypasses the
window manager, on XWayland, above a game that is itself an X11 client) is
common knowledge.

Why a process of its own: the daemon must run without Qt, and nothing Qt does
(start-up, a crash, a hung X server) may stop the clipboard poll or the macros.
Why xcb: Path of Exile under Proton is an X11 client on XWayland; only a window
of the same X server can lie above it, so the platform is set before Qt loads
and OVERWRITES what the session set (QT_QPA_PLATFORM=wayland would open a
Wayland window); only the tests choose 'offscreen', through
PPT_OVERLAY_PLATFORM. Before Qt starts on xcb, a plain libxcb connect checks
that the X server takes a connection: Qt itself aborts the process when it
cannot open its platform, and an abort says nothing about why.

It only draws. Its windows let every click through and never take focus; it
reads nothing from the game and sends it nothing. Text is drawn as plain text
(QPainter.drawText), never as rich text, so nothing a card carries can render
as markup.

Protocol, one JSON object per line (backend/v2/daemon-overlay-qt.test.mjs).
daemon -> overlay (stdin):
  {"cmd":"item","key":"item:<id>","title":"Mageblood","lines":[["Mageblood","name"],["140 div (125–170)","price"]],"final":true,"again":false}
  {"cmd":"whisper","key":"whisper:<id>","title":"…","lines":[…]}
  {"cmd":"frame","key":"frame","x":226,"y":231,"w":53,"h":53,"label":"1/2 buyer 1 · tab \"Sale\" · left 5, top 3","hold_ms":20000}
  {"cmd":"hide","key":"…"}   {"cmd":"style", …}   {"cmd":"ping","n":7}   {"cmd":"quit"}
overlay -> daemon (stdout):
  {"type":"hello","binding":"PySide6","qt":"6.12.0","platform":"xcb","screens":1}
  {"type":"shown","key":"…","x":812,"y":440}   {"type":"hidden","key":"…"}
  {"type":"pong","n":7}   {"type":"error","message":"…"}
One item card at a time (the newest key wins), whisper cards stacked at a fixed
anchor, one stash cell frame (a border around the cell x, y, w, h in
screen pixels, its label under it, for hold_ms; ppt_stash_grid computes the
cell); where they go and when they leave is ppt_overlay_model. "hidden" is
said once for a window that goes while visible (its hold time, the cursor, a
hide command); the frame window answers to the key it was last shown with.
Exit: 0 quit or end of stdin (the daemon is gone), 3 PySide6 cannot be
imported, 4 the platform cannot start (no DISPLAY, no X server, no xcb plugin),
5 anything else. Every exit but 0 writes one line to stderr.
"""
import ctypes
import ctypes.util
import functools
import json
import operator
import os
import signal
import sys
import time

PLATFORM = os.environ.get("PPT_OVERLAY_PLATFORM") or "xcb"
os.environ["QT_QPA_PLATFORM"] = PLATFORM

from ppt_overlay_model import Cards, anchor_point, fit_lines, place, stack  # noqa: E402

EXIT_OK, EXIT_NO_QT, EXIT_NO_DISPLAY, EXIT_OTHER = 0, 3, 4, 5

FLAGS = ("FramelessWindowHint", "WindowStaysOnTopHint", "X11BypassWindowManagerHint",
         "WindowTransparentForInput", "WindowDoesNotAcceptFocus", "Tool")
ATTRS = ("WA_TranslucentBackground", "WA_ShowWithoutActivating")

# What a style command may set, with its type and default. The daemon sends
# the values from config.toml [results] after every hello.
STYLE = {
    "font_pt": (float, 13.0),
    "opacity": (float, 0.88),
    "max_width_px": (int, 420),
    "offset_px": (int, 24),
    "item_hold_ms": (int, 8000),
    "pending_hold_ms": (int, 60000),
    "hide_distance_px": (int, 220),
    "whisper_hold_ms": (int, 20000),
    "max_whispers": (int, 3),
}
DEFAULT_ANCHOR = (0.02, 0.35)
MARGIN = 8
PAD = 10
BAR = 3
MAX_LINES = 4
MAX_CHARS = 80  # the width cut (elide) is the real limit; this only bounds the work
LINE_MAX_BYTES = 65536
TICK_MS = 100
DEMO_S = 5
FRAME_DEMO_S = 3
FRAME_PEN = 3       # the border's width in pixels, drawn inside the cell
FRAME_GAP = 4       # between the cell and the label under it
FRAME_TONE = "price"
FRAME_MAX = 20000   # a frame side beyond any screen is refused
TONES = {
    "name": (236, 236, 236),
    "price": (232, 196, 104),
    "muted": (165, 165, 170),
    "good": (126, 204, 126),
    "warn": (232, 162, 72),
    "bad": (232, 96, 96),
}


def say(text):
    """The one stderr line of a failed start."""
    try:
        print(f"ppt_overlay: {text}", file=sys.stderr, flush=True)
    except OSError:
        pass


def platform_problem(platform, env=os.environ):
    """None when Qt can start on `platform`, else why not. Only xcb is
    checked: DISPLAY set, and libxcb gets a connection (with DISPLAY and
    XAUTHORITY, as Qt would)."""
    if platform != "xcb":
        return None
    if not env.get("DISPLAY"):
        return "DISPLAY is not set, so there is no X server to draw on"
    try:
        lib = ctypes.CDLL(ctypes.util.find_library("xcb") or "libxcb.so.1")
    except OSError as ex:
        return f"libxcb cannot be loaded ({ex})"
    lib.xcb_connect.restype = ctypes.c_void_p
    lib.xcb_connect.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_int)]
    lib.xcb_connection_has_error.restype = ctypes.c_int
    lib.xcb_connection_has_error.argtypes = [ctypes.c_void_p]
    lib.xcb_disconnect.restype = None
    lib.xcb_disconnect.argtypes = [ctypes.c_void_p]
    conn = lib.xcb_connect(None, None)
    try:
        err = lib.xcb_connection_has_error(conn) if conn else 1
    finally:
        if conn:
            lib.xcb_disconnect(conn)
    if err:
        return f"the X server at DISPLAY={env.get('DISPLAY')} does not take a connection (xcb error {err})"
    return None


def plugin_problem(QtCore, platform):
    """Qt's xcb platform plugin missing from the plugin directory -> why."""
    if platform != "xcb":
        return None
    try:
        base = QtCore.QLibraryInfo.path(QtCore.QLibraryInfo.LibraryPath.PluginsPath)
        names = os.listdir(os.path.join(base, "platforms"))
    except Exception:
        return None  # cannot tell; Qt will say
    if any(n.startswith("libqxcb") for n in names):
        return None
    return f"Qt's xcb platform plugin is not installed (no libqxcb in {base}/platforms)"


def clean_style(obj, style):
    """Merge the known keys of a style command into `style`; anything else, or
    a value of the wrong kind, is ignored."""
    for key, (kind, _) in STYLE.items():
        if key not in obj:
            continue
        try:
            value = kind(obj[key])
        except (TypeError, ValueError):
            continue
        if value > 0:
            style[key] = value
    if "opacity" in obj:
        style["opacity"] = min(1.0, max(0.1, style["opacity"]))
    anchor = obj.get("whisper_anchor")
    if isinstance(anchor, (list, tuple)) and len(anchor) == 2:
        try:
            fx, fy = float(anchor[0]), float(anchor[1])
            if 0 <= fx <= 1 and 0 <= fy <= 1:
                style["whisper_anchor"] = (fx, fy)
        except (TypeError, ValueError):
            pass
    return style


def default_style():
    style = {k: d for k, (_, d) in STYLE.items()}
    style["whisper_anchor"] = DEFAULT_ANCHOR
    return style


def card_lines(msg):
    """The card's lines; the title becomes the first line when no line is the
    name line."""
    lines = fit_lines(msg.get("lines") if isinstance(msg.get("lines"), list) else [], MAX_CHARS, MAX_LINES)
    if not any(tone == "name" for _, tone in lines):
        title = str(msg.get("title") or "")
        if title:
            lines = fit_lines([[title, "name"], *lines], MAX_CHARS, MAX_LINES)
    return lines


def frame_rect(msg):
    """(x, y, w, h) of a frame command, or None: whole numbers, w and h above 0."""
    vals = [msg.get(k) for k in ("x", "y", "w", "h")]
    if not all(isinstance(v, int) and not isinstance(v, bool) and abs(v) <= FRAME_MAX for v in vals):
        return None
    if vals[2] <= 0 or vals[3] <= 0:
        return None
    return tuple(vals)


def build(QtCore, QtGui, QtWidgets):
    """The window classes, made once PySide6 is imported."""
    Qt = QtCore.Qt

    class OverWindow(QtWidgets.QWidget):
        """A window over the game that lets every click through and never
        takes focus."""

        def __init__(self, style):
            super().__init__(None)
            flags = functools.reduce(operator.or_, (getattr(Qt.WindowType, n) for n in FLAGS))
            self.setWindowFlags(flags)
            for name in ATTRS:
                self.setAttribute(getattr(Qt.WidgetAttribute, name), True)
            self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            self.setWindowTitle("poe-price-tool")
            self.style_ = style

        def flag_names(self):
            have = self.windowFlags()
            out = []
            for n in FLAGS:
                f = getattr(Qt.WindowType, n)
                if (have & f) == f:
                    out.append(n)
            return out

        def attr_names(self):
            return [n for n in ATTRS if self.testAttribute(getattr(Qt.WidgetAttribute, n))]

    class CardWindow(OverWindow):
        def __init__(self, style):
            super().__init__(style)
            self.lines = []
            self.rows = []  # (text, tone, font, baseline)

        def set_card(self, lines, style):
            self.style_ = style
            self.lines = lines
            base = QtGui.QFont(self.font())
            base.setPointSizeF(float(style["font_pt"]))
            bold = QtGui.QFont(base)
            bold.setBold(True)
            max_text = max(40, int(style["max_width_px"]) - 2 * PAD - BAR)
            rows = []
            width = 0
            y = PAD
            for text, tone in lines:
                font = bold if tone == "name" else base
                fm = QtGui.QFontMetrics(font)
                shown = fm.elidedText(text, Qt.TextElideMode.ElideRight, max_text)
                width = max(width, fm.horizontalAdvance(shown))
                rows.append((shown, tone, font, y + fm.ascent()))
                y += fm.height() + 2
            self.rows = rows
            self.resize(width + 2 * PAD + BAR, max(y - 2 + PAD, 2 * PAD))
            self.update()

        def paintEvent(self, event):  # noqa: N802 (Qt's name)
            p = QtGui.QPainter(self)
            p.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing, True)
            alpha = int(255 * float(self.style_["opacity"]))
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QtGui.QColor(22, 22, 26, alpha))
            p.drawRoundedRect(QtCore.QRectF(self.rect()), 6, 6)
            accent = next((tone for _, tone, _, _ in self.rows if tone != "name"), "muted")
            p.setBrush(QtGui.QColor(*TONES.get(accent, TONES["muted"]), alpha))
            p.drawRect(QtCore.QRectF(0, 6, BAR, max(0, self.height() - 12)))
            for text, tone, font, baseline in self.rows:
                p.setFont(font)
                p.setPen(QtGui.QColor(*TONES.get(tone, TONES["muted"])))
                p.drawText(BAR + PAD, baseline, text)  # plain text, never markup
            p.end()

    class FrameWindow(OverWindow):
        """The stash cell frame: a border around one cell, its label under it.
        Only the border and the label are painted; the rest of the window is
        transparent, and every click goes through all of it."""

        def __init__(self, style):
            super().__init__(style)
            self.cell = (0, 0)
            self.label = ""
            self.font_ = None
            self.label_size = (0, 0)

        def set_frame(self, w, h, label, style):
            self.style_ = style
            self.cell = (int(w), int(h))
            font = QtGui.QFont(self.font())
            font.setPointSizeF(float(style["font_pt"]))
            fm = QtGui.QFontMetrics(font)
            max_text = max(40, int(style["max_width_px"]) - 2 * PAD)
            self.label = fm.elidedText(str(label or ""), Qt.TextElideMode.ElideRight, max_text) if label else ""
            self.font_ = font
            self.label_size = ((fm.horizontalAdvance(self.label) + 2 * PAD, fm.height() + PAD)
                               if self.label else (0, 0))
            lw, lh = self.label_size
            self.resize(max(self.cell[0], lw), self.cell[1] + (FRAME_GAP + lh if lh else 0))
            self.update()

        def paintEvent(self, event):  # noqa: N802 (Qt's name)
            p = QtGui.QPainter(self)
            p.setRenderHint(QtGui.QPainter.RenderHint.Antialiasing, True)
            w, h = self.cell
            pen = QtGui.QPen(QtGui.QColor(*TONES[FRAME_TONE]))
            pen.setWidth(FRAME_PEN)
            p.setPen(pen)
            p.setBrush(Qt.BrushStyle.NoBrush)
            half = FRAME_PEN / 2
            p.drawRect(QtCore.QRectF(half, half, max(0.0, w - FRAME_PEN), max(0.0, h - FRAME_PEN)))
            lw, lh = self.label_size
            if self.label and self.font_ is not None:
                alpha = int(255 * float(self.style_["opacity"]))
                p.setPen(Qt.PenStyle.NoPen)
                p.setBrush(QtGui.QColor(22, 22, 26, alpha))
                p.drawRoundedRect(QtCore.QRectF(0, h + FRAME_GAP, lw, lh), 4, 4)
                p.setFont(self.font_)
                p.setPen(QtGui.QColor(*TONES["name"]))
                fm = QtGui.QFontMetrics(self.font_)
                p.drawText(PAD, h + FRAME_GAP + PAD // 2 + fm.ascent(), self.label)  # plain text, never markup
            p.end()

    return CardWindow, FrameWindow


class Overlay:
    """The cards on screen, driven by the commands on stdin."""

    def __init__(self, QtCore, QtGui, QtWidgets, app, emit):
        self.QtGui = QtGui
        self.app = app
        self.emit = emit
        self.CardWindow, self.FrameWindow = build(QtCore, QtGui, QtWidgets)
        self.style = default_style()
        self.cards = Cards(**self._card_params())
        self.item_win = None
        self.whisper_wins = {}
        self.frame_win = None
        self.frame_win_key = None  # the key the frame window was last shown with

    def _card_params(self):
        s = self.style
        return dict(item_hold_ms=s["item_hold_ms"], pending_hold_ms=s["pending_hold_ms"],
                    hide_distance_px=s["hide_distance_px"], whisper_hold_ms=s["whisper_hold_ms"],
                    max_whispers=s["max_whispers"])

    def screens(self):
        out = []
        for s in self.app.screens():
            g = s.geometry()
            out.append((g.x(), g.y(), g.width(), g.height()))
        return out

    def cursor(self):
        pos = self.QtGui.QCursor.pos()
        return (pos.x(), pos.y())

    @staticmethod
    def now_ms():
        return int(time.monotonic() * 1000)

    def handle(self, msg):
        cmd = msg.get("cmd")
        if cmd == "item":
            self.item(msg)
        elif cmd == "whisper":
            self.whisper(msg)
        elif cmd == "frame":
            self.frame(msg)
        elif cmd == "hide":
            self.hide(str(msg.get("key") or ""))
        elif cmd == "style":
            clean_style(msg, self.style)
            for k, v in self._card_params().items():
                setattr(self.cards, k, v)
            for win in [self.item_win, *self.whisper_wins.values()]:
                if win is not None:
                    win.set_card(win.lines, self.style)
            if self.frame_win is not None:
                self.frame_win.set_frame(*self.frame_win.cell, self.frame_win.label, self.style)
            self._layout_whispers()
        elif cmd == "ping":
            self.emit({"type": "pong", "n": msg.get("n")})
        elif cmd == "quit":
            self.app.exit(EXIT_OK)
        else:
            self.emit({"type": "error", "message": f"unknown cmd {str(cmd)[:40]!r}"})

    def item(self, msg):
        key = str(msg.get("key") or "item")
        cursor = self.cursor()
        action = self.cards.item(key, {"final": bool(msg.get("final")), "again": bool(msg.get("again"))},
                                 self.now_ms(), cursor)
        if self.item_win is None:
            self.item_win = self.CardWindow(self.style)
        win = self.item_win
        win.set_card(card_lines(msg), self.style)
        if action in ("show", "reshow"):
            self._put(win, place(cursor, self.screens(), (win.width(), win.height()),
                                 self.style["offset_px"], MARGIN))
            self.emit({"type": "shown", "key": key, "x": win.x(), "y": win.y()})
        elif action == "update" and self.cards.item_at is not None:
            # A grown card stays on its screen; the place is still the one next
            # to where the cursor was when it appeared.
            self._put(win, place(self.cards.item_at, self.screens(), (win.width(), win.height()),
                                 self.style["offset_px"], MARGIN))

    def whisper(self, msg):
        key = str(msg.get("key") or "whisper")
        self.cards.whisper(key, msg, self.now_ms())
        win = self.whisper_wins.get(key)
        if win is None:
            win = self.whisper_wins[key] = self.CardWindow(self.style)
        win.set_card(card_lines(msg), self.style)
        self._layout_whispers()
        self.emit({"type": "shown", "key": key, "x": win.x(), "y": win.y()})

    def frame(self, msg):
        rect = frame_rect(msg)
        if rect is None:
            self.emit({"type": "error", "message": "frame needs whole numbers x, y and w, h above 0"})
            return
        key = str(msg.get("key") or "frame")
        try:
            hold_ms = int(msg.get("hold_ms") or self.style["whisper_hold_ms"])
        except (TypeError, ValueError):
            hold_ms = self.style["whisper_hold_ms"]
        if self.frame_win is None:
            self.frame_win = self.FrameWindow(self.style)
        x, y, w, h = rect
        self.frame_win.set_frame(w, h, msg.get("label"), self.style)
        self.cards.frame(key, self.now_ms(), hold_ms)
        self.frame_win_key = key
        self._put(self.frame_win, (x, y))
        self.emit({"type": "shown", "key": key, "x": self.frame_win.x(), "y": self.frame_win.y()})

    def _layout_whispers(self):
        keys = [k for k in self.cards.visible_whispers() if k in self.whisper_wins]
        if not keys:
            return
        wins = [self.whisper_wins[k] for k in keys]
        origin = anchor_point(self.screens(), self.cursor(), self.style["whisper_anchor"])
        for win, pos in zip(wins, stack(origin, [(w.width(), w.height()) for w in wins])):
            self._put(win, pos)

    @staticmethod
    def _put(win, pos):
        win.move(int(pos[0]), int(pos[1]))
        if not win.isVisible():
            win.show()
        win.raise_()

    def hide(self, key):
        self.cards.forget(key)
        self._hide_window(key)

    def _hide_window(self, key):
        if self.item_win is not None and key == self.cards.item_key:
            self._gone(self.item_win, key)
        if self.frame_win is not None and key == self.frame_win_key:
            self.frame_win_key = None
            self._gone(self.frame_win, key)
        win = self.whisper_wins.pop(key, None)
        if win is not None:
            self._gone(win, key)
            win.deleteLater()
            self._layout_whispers()

    def _gone(self, win, key):
        """A visible window goes, and says so ('hidden'); one hidden already
        says nothing."""
        if win.isVisible():
            win.hide()
            self.emit({"type": "hidden", "key": key})

    def tick(self):
        for key in self.cards.tick(self.now_ms(), self.cursor()):
            self._hide_window(key)


def main(argv=None):
    args = sys.argv[1:] if argv is None else list(argv)
    mode = ("probe" if "--probe" in args else "demo" if "--demo" in args
            else "session" if "--session" in args else "frame" if "--frame" in args else "run")
    frame = None
    if mode == "frame":
        i = args.index("--frame")
        parts = args[i + 1].split(",") if i + 1 < len(args) else []
        try:
            frame = tuple(int(v) for v in parts)
        except ValueError:
            frame = None
        if frame is None or len(frame) != 4 or frame_rect(dict(zip("xywh", frame))) is None:
            say("--frame needs x,y,w,h: four whole numbers, w and h above 0")
            return EXIT_OTHER
    # SIGTERM and SIGINT end the process at once; the X server removes its windows.
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    try:
        from PySide6 import QtCore, QtGui, QtWidgets
    except Exception as ex:  # ImportError, or a broken installation
        say(f"PySide6 cannot be imported ({type(ex).__name__}: {ex})")
        return EXIT_NO_QT
    problem = platform_problem(PLATFORM) or plugin_problem(QtCore, PLATFORM)
    if problem:
        say(problem)
        return EXIT_NO_DISPLAY
    try:
        return run(mode, QtCore, QtGui, QtWidgets, frame)
    except Exception as ex:
        say(f"{type(ex).__name__}: {ex}")
        return EXIT_OTHER


def run(mode, QtCore, QtGui, QtWidgets, frame=None):
    app = QtWidgets.QApplication(["ppt_overlay"])
    app.setQuitOnLastWindowClosed(False)
    gone = []

    def emit(obj):
        try:
            sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            gone.append(True)  # the daemon is gone
            app.exit(EXIT_OK)

    hello = {"type": "hello", "binding": "PySide6", "qt": QtCore.qVersion(),
             "platform": app.platformName(), "screens": len(app.screens())}
    overlay = Overlay(QtCore, QtGui, QtWidgets, app, emit)

    if mode == "probe":
        win = overlay.CardWindow(overlay.style)
        win.winId()  # creates the native window without showing it
        fwin = overlay.FrameWindow(overlay.style)
        fwin.winId()
        emit({**hello, "flags": win.flag_names(), "attrs": win.attr_names(),
              "frame_flags": fwin.flag_names(), "frame_attrs": fwin.attr_names()})
        win.deleteLater()
        fwin.deleteLater()
        return EXIT_OK

    emit(hello)
    timer = QtCore.QTimer()
    timer.timeout.connect(overlay.tick)
    timer.start(TICK_MS)

    if mode == "demo":
        overlay.style["hide_distance_px"] = 1 << 30
        overlay.cards.hide_distance_px = 1 << 30
        overlay.item({"key": "demo", "final": True, "lines": [
            ["poe-price-tool overlay", "name"],
            ["this card lies over the game", "price"],
            [f"it closes in {DEMO_S} s", "muted"]]})
        QtCore.QTimer.singleShot(DEMO_S * 1000, lambda: app.exit(EXIT_OK))
        return app.exec()

    if mode == "session":
        # The daemon's own words for a farm session that just started
        # (ppt_results is standard library, next to this file).
        from ppt_results import session_card
        card = session_card({"id": "demo", "kind": "farm", "state": "starting", "about": 6})
        overlay.whisper({"key": card["key"], "title": card["title"], "lines": card["lines"]})
        QtCore.QTimer.singleShot(DEMO_S * 1000, lambda: app.exit(EXIT_OK))
        return app.exec()

    if mode == "frame":
        x, y, w, h = frame
        overlay.frame({"key": "frame", "x": x, "y": y, "w": w, "h": h, "hold_ms": FRAME_DEMO_S * 1000,
                       "label": "poe-price-tool: cell 1,1 of your stash"})
        QtCore.QTimer.singleShot(FRAME_DEMO_S * 1000, lambda: app.exit(EXIT_OK))
        return app.exec()

    buf = bytearray()
    eof = []
    os.set_blocking(0, False)
    notifier = QtCore.QSocketNotifier(0, QtCore.QSocketNotifier.Type.Read)

    def on_stdin():
        while True:
            try:
                chunk = os.read(0, 65536)
            except (BlockingIOError, InterruptedError):
                break
            except OSError:
                chunk = b""
            if not chunk:  # end of stdin: the daemon is gone
                notifier.setEnabled(False)
                eof.append(True)
                app.exit(EXIT_OK)
                break
            buf.extend(chunk)
        while True:
            i = buf.find(b"\n")
            if i < 0:
                if len(buf) > LINE_MAX_BYTES:
                    del buf[:]
                    emit({"type": "error", "message": "line too long, dropped"})
                return
            line = bytes(buf[:i])
            del buf[:i + 1]
            if not line.strip():
                continue
            try:
                msg = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                emit({"type": "error", "message": "not JSON"})
                continue
            if not isinstance(msg, dict):
                emit({"type": "error", "message": "not an object"})
                continue
            try:
                overlay.handle(msg)
            except Exception as ex:  # one bad command never ends the overlay
                emit({"type": "error", "message": f"{type(ex).__name__}: {ex}"[:200]})

    notifier.activated.connect(on_stdin)
    on_stdin()  # anything that came before the notifier
    # app.exit() before app.exec() is not remembered: an end of stdin or a
    # closed stdout seen above ends here.
    return EXIT_OK if (gone or eof) else app.exec()


if __name__ == "__main__":
    sys.exit(main())
