"""ppt_overlay_model — where the overlay's cards go and when they leave, as plain
functions over numbers, so the tests run without a display and without Qt
(backend/v2/daemon-overlay-model.test.mjs). The overlay process
(ppt_overlay.py) only paints what this decides.

Coordinates are pixels of the X server the overlay runs on; a screen is
(x, y, width, height), a box is (width, height), a cursor is (x, y). Times are
milliseconds and always passed in; nothing in here has a clock of its own.

Standard library only.
"""
import math

ELLIPSIS = "…"


def screen_of(cursor, screens):
    """The screen holding the cursor; the first one when none does (a cursor
    outside every screen: the pointer sits over a window XWayland does not
    see). None without screens."""
    if not screens:
        return None
    cx, cy = cursor
    for s in screens:
        x, y, w, h = s
        if x <= cx < x + w and y <= cy < y + h:
            return tuple(s)
    return tuple(screens[0])


def _clamp(v, low, high):
    # A box wider than the screen keeps its left/top edge on the screen.
    return max(low, min(v, high)) if high >= low else low


def place(cursor, screens, box, offset=24, margin=8):
    """Top-left (x, y) for an item card of size box=(w, h) next to the mouse.
    screens: [(x, y, w, h)]; the one holding the cursor wins, the first one when
    none does. Below-right of the cursor, flipped left/up where it would leave
    that screen, then clamped inside it with margin."""
    cx, cy = int(cursor[0]), int(cursor[1])
    w, h = int(box[0]), int(box[1])
    s = screen_of((cx, cy), screens)
    x, y = cx + offset, cy + offset
    if s is None:
        return (x, y)
    sx, sy, sw, sh = s
    if x + w > sx + sw - margin:
        x = cx - offset - w
    if y + h > sy + sh - margin:
        y = cy - offset - h
    x = _clamp(x, sx + margin, sx + sw - margin - w)
    y = _clamp(y, sy + margin, sy + sh - margin - h)
    return (x, y)


def anchor_point(screens, cursor, frac):
    """Origin of the whisper stack: frac=(fx, fy) of the cursor's screen."""
    s = screen_of(cursor, screens)
    if s is None:
        return (0, 0)
    sx, sy, sw, sh = s
    return (int(sx + float(frac[0]) * sw), int(sy + float(frac[1]) * sh))


def stack(origin, sizes, gap=8):
    """Top-left of each whisper card, downwards from origin in the order given
    (the caller passes the newest first, so the newest is on top)."""
    x, y = int(origin[0]), int(origin[1])
    out = []
    for _, h in sizes:
        out.append((x, y))
        y += int(h) + gap
    return out


def cut(text, max_chars):
    text = str(text)
    return text if len(text) <= max_chars else text[:max(0, max_chars - 1)] + ELLIPSIS


def fit_lines(lines, max_chars=48, max_lines=4):
    """At most max_lines [text, tone] pairs, each text at most max_chars long
    (cut with an ellipsis). Malformed entries are skipped, never raised on."""
    out = []
    for entry in lines or []:
        if len(out) >= max_lines:
            break
        if isinstance(entry, (list, tuple)) and entry:
            text = entry[0]
            tone = entry[1] if len(entry) > 1 else "muted"
        elif isinstance(entry, str):
            text, tone = entry, "muted"
        else:
            continue
        out.append([cut(text, max_chars), str(tone)])
    return out


class Cards:
    """What is visible: ONE item card (the newest hotkey wins), up to
    max_whispers whisper cards and ONE stash cell frame (the newest press
    wins; it leaves its own hold_ms after it was shown). Time (ms) and cursor
    are passed in.

    The item card leaves when the cursor is more than hide_distance_px from
    where it was shown, item_hold_ms after its result, or pending_hold_ms after
    it was shown without one. An update of a hidden card stays hidden, except a
    late result (the card turns final) or a card marked `again` (the player
    asked for it again): those come back at the cursor."""

    def __init__(self, *, item_hold_ms=8000, pending_hold_ms=60000, hide_distance_px=220,
                 whisper_hold_ms=20000, max_whispers=3):
        self.item_hold_ms = item_hold_ms
        self.pending_hold_ms = pending_hold_ms
        self.hide_distance_px = hide_distance_px
        self.whisper_hold_ms = whisper_hold_ms
        self.max_whispers = max_whispers
        self.item_key = None
        self.item_visible = False
        self.item_final = False
        self.item_at = None        # cursor when shown
        self.item_shown_ms = 0
        self.item_final_ms = 0
        self.whispers = []         # [(key, since_ms)], oldest first
        self.frame_key = None      # the stash cell frame, while shown
        self.frame_until_ms = 0

    def item(self, key, card, now_ms, cursor):
        """'show' (new key, replaces the item card) | 'update' (same key,
        visible) | 'reshow' (same key, hidden before: a late result or a card
        asked for again comes back at the cursor) | 'hidden' (same key, hidden,
        and nothing that would bring it back)."""
        final = bool(card.get("final"))
        if key != self.item_key:
            self._show_item(key, final, now_ms, cursor)
            return "show"
        if self.item_visible:
            if final and not self.item_final:
                self.item_final_ms = now_ms
            self.item_final = final
            return "update"
        if (final and not self.item_final) or card.get("again"):
            self._show_item(key, final, now_ms, cursor)
            return "reshow"
        self.item_final = final
        return "hidden"

    def _show_item(self, key, final, now_ms, cursor):
        self.item_key = key
        self.item_visible = True
        self.item_final = final
        self.item_at = (cursor[0], cursor[1])
        self.item_shown_ms = now_ms
        self.item_final_ms = now_ms

    def whisper(self, key, card, now_ms):
        self.whispers = [(k, t) for k, t in self.whispers if k != key]
        self.whispers.append((key, now_ms))

    def frame(self, key, now_ms, hold_ms):
        """The stash cell frame is shown (again) at now_ms."""
        self.frame_key = key
        self.frame_until_ms = now_ms + max(1, int(hold_ms))

    def visible_whispers(self):
        """Whisper keys, newest first (the order of the stack)."""
        return [k for k, _ in reversed(self.whispers)]

    def forget(self, key):
        """The daemon hid a card itself ({"cmd":"hide"})."""
        if key == self.item_key:
            self.item_visible = False
        if key == self.frame_key:
            self.frame_key = None
        self.whispers = [(k, t) for k, t in self.whispers if k != key]

    def tick(self, now_ms, cursor):
        """Keys to hide now."""
        out = []
        if self.item_visible:
            gone = False
            if self.item_at is not None and cursor is not None:
                d = math.hypot(cursor[0] - self.item_at[0], cursor[1] - self.item_at[1])
                gone = d > self.hide_distance_px
            if self.item_final:
                gone = gone or now_ms - self.item_final_ms >= self.item_hold_ms
            else:
                gone = gone or now_ms - self.item_shown_ms >= self.pending_hold_ms
            if gone:
                self.item_visible = False
                out.append(self.item_key)
        if self.frame_key is not None and now_ms >= self.frame_until_ms:
            out.append(self.frame_key)
            self.frame_key = None
        keep = []
        for k, t in self.whispers:
            if now_ms - t >= self.whisper_hold_ms:
                out.append(k)
            else:
                keep.append((k, t))
        while len(keep) > self.max_whispers:
            out.append(keep.pop(0)[0])
        self.whispers = keep
        return out
