"""ppt_stash_grid — the stash cell frame: a border around the stash cell a
buyer whisper names, shown by the overlay when the player presses
highlight_key ([whispers]). Not the Stash Highlight of the net-worth page (a
search string for the game's stash search field). The first press frames the cell of the newest whisper with a
stash position; each press within whisper_hold_s goes one whisper older, and
after the oldest back to the newest.

Where the grid lies ([stash_grid] in config.toml) follows SlimTrade
(POEWindow.kt and ScaledRect.kt in https://github.com/zmilla93/SlimTrade, MIT,
(c) 2020 zmilla93; its copyright and permission notice is in the head comment
of backend/v2/whisper.mjs): on a 1920x1080 game window the Path of Exile 1 stash grid
is the rectangle x 15, y 125, 634x634 px (y 133 when the player uses stash
tab folders and sells from tabs outside them, y 167 when the tabs sold from
are inside a folder; SlimTrade's usingStashFolder and tradesAreInsideFolders),
kept as fractions of that window: x by
the window's width, y by its height, width and height both by its height (the
game's interface does not stretch sideways), rounded half up like Java's
Math.round. A cell is a twelfth of the grid, a twenty-fourth in a quad tab
(StashHighlighterFramePoe1.java). Not compared with a running game here.

  mode "auto"    the grid from the focused game window's geometry
                 (`xdotool getwindowfocus getwindowgeometry --shell`, through
                 the curl pool, never waited for)
  mode "manual"  the grid is x, y, w, h in screen pixels from the config
  mode "off"     no frame

A tab is quad when the server says so (the whisper entry's `quad`, from the
tab type the last net-worth sync stored) or when the whisper's left or top is
above 12 (SlimTrade's rule in StashHighlighterFrame.java: a 12x12 tab has no
such cell).

Plain functions over numbers plus one class that is handed its pool, its log
and its two ways out, so backend/v2/daemon-stash-grid.test.mjs runs it without
a display. Standard library only.
"""
import math

REFERENCE = (1920, 1080)
# SlimTrade's POE_1_PERCENT_STASH_* rectangles, in pixels of REFERENCE.
GRID_AT_REFERENCE = {
    "none": (15, 125, 634, 634),
    "outside": (15, 133, 634, 634),
    "inside": (15, 167, 634, 634),
}
MODES = ("auto", "manual", "off")
FOLDERS = ("none", "outside", "inside")
MANUAL_KEYS = ("x", "y", "w", "h")
GEOMETRY_TIMEOUT_S = 1
FRAME_KEY = "frame"
CARD_KEY = "highlight"
TITLE = "Stash cell frame"
TAB_CHARS = 30


def jround(v):
    """Half up, like Java's Math.round (Python's round() rounds half to even)."""
    return int(math.floor(v + 0.5))


def grid_rect(window, folders="none"):
    """(x, y, w, h) of the 12x12 stash grid on the screen, for a game window
    (x, y, width, height) in screen pixels."""
    wx, wy, ww, wh = (int(v) for v in window)
    rx, ry, rw, rh = GRID_AT_REFERENCE[folders]
    ref_w, ref_h = REFERENCE
    return (wx + jround(rx / ref_w * ww), wy + jround(ry / ref_h * wh),
            jround(rw / ref_h * wh), jround(rh / ref_h * wh))


def _whole(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_quad(left, top, quad=None):
    """24x24 cells: the server's `quad` is True, or the cell lies beyond 12."""
    if quad is True:
        return True
    return any(_whole(v) and v > 12 for v in (left, top))


def cell_rect(grid, left, top, quad):
    """(x, y, w, h) of the whisper's cell (left and top count from 1), or None
    when it is not a cell of that grid."""
    count = 24 if quad else 12
    if not (_whole(left) and _whole(top) and 1 <= left <= count and 1 <= top <= count):
        return None
    gx, gy, gw, gh = grid
    return (gx + jround(gw * (left - 1) / count), gy + jround(gh * (top - 1) / count),
            jround(gw / count), jround(gh / count))


def parse_geometry(text):
    """`xdotool getwindowgeometry --shell` -> (x, y, width, height), or None."""
    vals = {}
    for line in str(text or "").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            vals[key.strip()] = value.strip()
    try:
        x, y, w, h = (int(vals[k]) for k in ("X", "Y", "WIDTH", "HEIGHT"))
    except (KeyError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    return (x, y, w, h)


def read_grid_config(sec):
    """[stash_grid] -> ({mode, folders, rect}, None) or (None, the message).
    Every key is checked in every mode; manual needs all four of x, y, w, h."""
    def choice(key, default, choices):
        raw = sec.get(key, default)
        if raw not in choices:
            allowed = ", ".join(f'"{c}"' for c in choices)
            return None, f"[stash_grid] {key} must be one of {allowed} (got {raw!r})"
        return raw, None

    mode, err = choice("mode", "auto", MODES)
    if err:
        return None, err
    folders, err = choice("folders", "none", FOLDERS)
    if err:
        return None, err
    rect = []
    for key in MANUAL_KEYS:
        if key not in sec:
            continue
        raw = sec[key]
        least = 0 if key in ("x", "y") else 1
        whole = (isinstance(raw, (int, float)) and not isinstance(raw, bool)
                 and math.isfinite(raw) and float(raw).is_integer())
        if not whole or raw < least:
            what = "of at least 0" if least == 0 else "above 0"
            return None, f"[stash_grid] {key} must be a whole number {what} (got {raw!r})"
        rect.append(int(raw))
    if mode == "manual" and len(rect) != 4:
        return None, ("[stash_grid] mode = \"manual\" needs x, y, w and h (the grid's top-left corner and "
                      "size in screen pixels)")
    return {"mode": mode, "folders": folders, "rect": rect if len(rect) == 4 else None}, None


class HighlightCycle:
    """Which whisper a press shows. press(now, wids) -> an index into wids
    (newest first), or None when there is none: the newest, unless the last
    press was less than hold_s ago and its whisper is still in the list, then
    the one after it, and after the last the first again."""

    def __init__(self, hold_s):
        self.hold_s = float(hold_s)
        self.current = None
        self.last = None

    def press(self, now, wids):
        wids = list(wids)
        if not wids:
            self.current = None
            return None
        i = 0
        if self.last is not None and now - self.last < self.hold_s and self.current in wids:
            i = (wids.index(self.current) + 1) % len(wids)
        self.current = wids[i]
        self.last = now
        return i


def _card(text):
    return {"key": CARD_KEY, "title": TITLE, "lines": [[TITLE, "name"], [text, "muted"]],
            "final": True, "again": True}


def _cut(text, n=TAB_CHARS):
    text = str(text)
    return text if len(text) <= n else text[: n - 1] + "…"


class Highlighter:
    """The highlight key's work. press(now) picks the whisper (HighlightCycle)
    and, with a manual grid, hands the frame to show_frame at once; with an
    auto grid it starts xdotool through the pool and tick(now) hands the frame
    over once the geometry is there. Whatever stops it is a card
    (show_card): no whisper with a position, no xdotool, a geometry that cannot
    be read (also one throttled journal line), no overlay (show_frame returned
    False).

    positions() -> [{wid, label, tab, left, top, quad}], newest first
    (ppt_whisper.Whispers.positions). The frame: {key 'frame', x, y, w, h,
    label, hold_ms}; the label names the pseudonym, never the buyer's name."""

    def __init__(self, *, log, pool, grid, hold_s, positions, show_frame, show_card, xdotool, config_path=""):
        self.log = log
        self.pool = pool
        self.grid = dict(grid)
        self.hold_s = float(hold_s)
        self.positions = positions
        self.show_frame = show_frame
        self.show_card = show_card
        self.xdotool = xdotool
        self.config_path = config_path
        self.cycle = HighlightCycle(self.hold_s)
        self._job = None
        self._pending = None  # (entry, index, count) waiting for the geometry

    def press(self, now):
        entries = [e for e in (self.positions() or []) if isinstance(e, dict)]
        i = self.cycle.press(now, [e.get("wid") for e in entries])
        if i is None:
            self.show_card(_card("no whisper with a stash position yet"))
            return
        pick = (entries[i], i, len(entries))
        if self.grid["mode"] == "manual":
            self._frame(self.grid["rect"], *pick)
            return
        if not self.xdotool:
            self.show_card(_card("the stash cell frame needs xdotool to find the game window "
                                 "(or [stash_grid] mode = \"manual\")"))
            return
        self._pending = pick
        self._job = self.pool.start_cmd([self.xdotool, "getwindowfocus", "getwindowgeometry", "--shell"],
                                        timeout_s=GEOMETRY_TIMEOUT_S, tag="highlight")

    def tick(self, now):
        if self._job is None:
            return
        res = self._job.poll(now)
        if res is None:
            return
        self._job = None
        pick, self._pending = self._pending, None
        window = parse_geometry(res.body) if (not res.timed_out and res.rc == 0) else None
        if window is None:
            if res.timed_out:
                why = f"no answer within {GEOMETRY_TIMEOUT_S} s"
                tag = "timeout"
            else:
                detail = str(res.err or "").strip().splitlines()
                why = f"exit {res.rc}: {detail[0][:120]}" if detail and res.rc != 0 else \
                    f"exit {res.rc}" if res.rc != 0 else "no X, Y, WIDTH and HEIGHT in its answer"
                tag = f"exit-{res.rc}"
            self.log.failure(("highlight", "geometry", tag),
                             f"Stash cell frame: the game window's size could not be read with xdotool ({why}). "
                             f"Next: run ./daemon/selftest.sh with the game running (section 13), or set "
                             f"[stash_grid] mode = \"manual\" with x, y, w, h in {self.config_path}")
            self.show_card(_card("the game window's size could not be read"))
            return
        if pick is not None:
            self._frame(grid_rect(window, self.grid["folders"]), *pick)

    def _frame(self, grid, entry, i, n):
        left, top = entry.get("left"), entry.get("top")
        quad = is_quad(left, top, entry.get("quad"))
        rect = cell_rect(grid, left, top, quad)
        if rect is None:
            self.show_card(_card(f"no stash cell at left {left}, top {top}"))
            return
        label = f'{i + 1}/{n} {entry.get("label") or "buyer"} · tab "{_cut(entry.get("tab") or "")}" · left {left}, top {top}'
        frame = {"key": FRAME_KEY, "x": rect[0], "y": rect[1], "w": rect[2], "h": rect[3], "label": label,
                 "hold_ms": int(self.hold_s * 1000)}
        if not self.show_frame(frame):
            self.show_card(_card("the stash cell frame needs the overlay over the game "
                                 "(./daemon/selftest.sh --overlay)"))
