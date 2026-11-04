"""ppt_value_grid — the value key ([stash_grid] value_key): what each item in a
stash tab is worth, drawn over the open tab, so the player can decide what to
sell, keep or move to a sale tab.

The cells come from the server (GET /daemon/stash-grid,
backend/v2/frontend/PROTOCOL.md): the read the net-worth sync makes anyway, so
a press reads the server's store and never the stash API, and a tab shows what
its last sync saw. The stash API does not say which tab is open in the game,
so the key steps through the tabs: the first press shows the tab of the newest
buyer whisper (within whisper_hold_s, when that tab is in the run), else the
tab shown last when its grid went because value_hold_s ran out, else the first
of the run; each further press within value_hold_s goes to the next tab, and
after the last the grid goes and the next press starts afresh (the newest
whisper's tab, else the first).
The run is value_tabs, or every stored tab with a grid in stash order.

The tab list is asked at most every TABS_EVERY_S (and taken from every cells
answer, which carries it); the cells once per press. One request at a time: a
press while one runs is not sent. The grid is the stash cell frame's
(ppt_stash_grid: grid_rect, cell_rect, the auto and manual modes); the server's
x/y count from 0, so left = x + 1 and top = y + 1, and w/h are cells. An
item's right and bottom edge are where the cell after it starts (span_rect):
one rounded cell width times w would reach a pixel past the grid at its edge,
and the overlay drops a cell that is not inside the grid.

A cell the server marks u (its price is uncertain, the Net Worth page's
Confidence mark) gets a '?' after its value, in the grid and the notification,
and u on its overlay cell, which the overlay draws with a dashed border; the
tab line says how many of the cells drawn are such, after their count and
before the tab total, which a line too wide for the grid loses first. A wrong
price is worse than none, so the grid does not show it as a bare number.

Where it goes: Display.show_grid, the overlay while it is up and the game has
focus, else a notification of the dearest cells. Every case without a grid is
a card titled 'Value grid' that says why; a server without the route (404 or
405) is one journal line and, until it is asked again after reprobe_s, a card
without a request (ppt_link.Capability, like the session key).

Standard library only; no clock or process of its own, so
backend/v2/daemon-value-grid.test.mjs drives it with a fake pool.
"""
import json
import math

from ppt_link import REPROBE_S, Capability, classify, get_json
from ppt_results import _num
from ppt_stash_grid import cell_rect, grid_rect, is_quad, jround, parse_geometry

GRID_KEY = "grid"
CARD_KEY = "value-grid"
TITLE = "Value grid"
TABS_EVERY_S = 60
GEOMETRY_TIMEOUT_S = 1
TOAST_LINES = 5
TAB_CHARS = 30
NAME_CHARS = 40
DEFAULTS = {"value_key": "", "value_min_c": 5, "value_hold_s": 20, "value_tabs": []}
# curl exits that mean the request never reached the server (ppt_session).
NOT_SENT_RC = ("6", "7", "35", "60")

PROBLEMS = {
    "unsupported": "server too old for the value grid",
    "too-many": "too many presses, wait a moment",
    "unreachable": "server not reachable",
    "no-answer": "no answer from the server, see the journal",
    "unknown-user": "the server does not know this user",
    "failed": "the server did not answer as expected, see the journal",
    "no-tabs": "no stash tab stored yet: the net-worth sync has not read your stash",
    "no-run": "no stash tab with a grid stored",
    "no-named": "none of [stash_grid] value_tabs is a stored tab",
    "no-xdotool": "the value grid needs xdotool to find the game window (or [stash_grid] mode = \"manual\")",
    "geometry": "the game window's size could not be read",
}


def _finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _whole(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _json(text):
    try:
        data = json.loads(text) if text else None
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _cut(text, n):
    text = str(text)
    return text if len(text) <= n else text[: n - 1] + "…"


def read_value_config(sec):
    """The value keys of [stash_grid] -> ({key, min_c, hold_s, tabs}, None) or
    (None, the message). The key's name is checked by the daemon (evdev)."""
    key = sec.get("value_key", DEFAULTS["value_key"])
    if not isinstance(key, str):
        return None, f"[stash_grid] value_key must be a text (got {key!r})"
    min_c = sec.get("value_min_c", DEFAULTS["value_min_c"])
    if not _finite(min_c) or min_c < 0:
        return None, f"[stash_grid] value_min_c must be a number of at least 0 (got {min_c!r})"
    hold_s = sec.get("value_hold_s", DEFAULTS["value_hold_s"])
    if not _finite(hold_s) or hold_s <= 0:
        return None, f"[stash_grid] value_hold_s must be a positive number (got {hold_s!r})"
    tabs = sec.get("value_tabs", DEFAULTS["value_tabs"])
    if isinstance(tabs, str):
        tabs = [tabs]
    if not (isinstance(tabs, list) and all(isinstance(t, str) and t for t in tabs)):
        return None, f"[stash_grid] value_tabs must be a list of non-empty texts (got {sec.get('value_tabs')!r})"
    return {"key": key.strip(), "min_c": min_c, "hold_s": float(hold_s), "tabs": list(tabs)}, None


def value_text(chaos, cd=None, lang="en"):
    """As on the cards: below 1 divine in chaos without decimals ('12c'),
    from 1 divine in divine with one decimal at most ('1.5d', '2d': a
    trailing zero goes, as on the cards, which saves room in a small cell),
    always chaos without a rate. Whether it is 1 divine is asked of the
    rounded chaos, so 179.6 at 180 is '1d', never '180c'."""
    whole = math.floor(chaos + 0.5)
    if _finite(cd) and cd > 0 and whole >= cd:
        return f"{_num(chaos / cd, lang, 1)}d"
    return f"{_num(whole, lang, 0)}c"


def span_rect(grid, left, top, w, h, quad):
    """(x, y, w, h) of an item of w x h cells whose top-left cell is (left,
    top), counted from 1; None when it does not lie inside the grid. The far
    edges are rounded like the near ones, so an item at the grid's edge ends
    on it."""
    count = 24 if quad else 12
    start = cell_rect(grid, left, top, quad)
    if start is None or not (_whole(w) and _whole(h) and w > 0 and h > 0) or \
            left - 1 + w > count or top - 1 + h > count:
        return None
    gx, gy, gw, gh = grid
    right = gx + jround(gw * (left - 1 + w) / count)
    bottom = gy + jround(gh * (top - 1 + h) / count)
    return (start[0], start[1], right - start[0], bottom - start[1])


class TabCycle:
    """Which tab a press shows. press(now, order, whisper=None) -> an index
    into order (tab indexes of the run), or None: the grid goes (after the
    last tab, or an empty run). Within hold_s of the last press the next tab;
    else whisper's tab when it is in the run, else the tab shown last (when
    the grid went because hold_s ran out), else the first. A run that went
    past its last tab starts afresh: whisper's tab, else the first."""

    def __init__(self, hold_s):
        self.hold_s = float(hold_s)
        self.current = None
        self.last = None
        self.shown = None

    def press(self, now, order, whisper=None):
        order = list(order)
        if not order:
            self.current = self.last = None
            return None
        if self.last is not None and now - self.last < self.hold_s and self.current in order:
            i = order.index(self.current) + 1
            if i >= len(order):
                # The run is over: the next press starts it afresh (the
                # whisper's tab, else the first), not at the last one shown.
                self.current = self.last = self.shown = None
                return None
        elif whisper is not None and whisper in order:
            i = order.index(whisper)
        elif self.shown in order:
            i = order.index(self.shown)
        else:
            i = 0
        self.current = self.shown = order[i]
        self.last = now
        return i


def _card(text):
    return {"key": CARD_KEY, "title": TITLE, "lines": [[TITLE, "name"], [text, "muted"]],
            "final": True, "again": True}


def _tab_name(tab):
    return _cut(tab.get("name") or f"#{tab.get('index')}", TAB_CHARS)


class ValueGrid:
    """The value key's work. press(now) chooses the tab and asks for its
    cells; tick(now) takes the answers and hands the grid to show_grid(grid,
    toast), or a card to show_card. start(now) asks for the tab list once
    (the daemon's start: a value_tabs name no stored tab has is one line).

    grid: read_grid_config's {mode, folders, rect}; cfg: read_value_config's;
    positions() -> ppt_whisper.Whispers.positions (newest first, with 'at');
    hide_grid(key) takes the grid away after the last tab."""

    def __init__(self, *, pool, base_url, hdrs, log, grid, cfg, whisper_hold_s, positions, show_grid,
                 hide_grid, show_card, xdotool, lang="en", config_path="", user=None, reprobe_s=REPROBE_S,
                 timeout_s=5):
        self.pool = pool
        self.base = str(base_url).rstrip("/")
        self.hdrs = list(hdrs)
        self.log = log
        self.grid = dict(grid)
        self.min_c = cfg["min_c"]
        self.hold_s = float(cfg["hold_s"])
        self.names = list(cfg["tabs"])
        self.whisper_hold_s = float(whisper_hold_s)
        self.positions = positions
        self.show_grid = show_grid
        self.hide_grid = hide_grid
        self.show_card = show_card
        self.xdotool = xdotool
        self.lang = lang
        self.config_path = config_path
        self.timeout_s = float(timeout_s)
        self.cap = Capability("valuegrid", log, None, reprobe_s, self.base, config_path, user)
        self.cycle = TabCycle(self.hold_s)
        self._tabs = None
        self._tabs_at = None
        self._said_unknown = set()
        self._list_job = None
        self._list_press = False   # the list was asked for a press
        self._cells_job = None
        self._geo_job = None
        self._geo = None           # the CurlResult of xdotool, once there
        self._cells = None         # the CurlResult of the cells request, once there
        self._pick = None          # (tab, i, n) of the press under way
        self._problem = None       # the card a press gets while the server is not asked again
        self._showing = False      # a grid is up (as far as this module knows)

    # --- requests ---------------------------------------------------------------

    def _busy(self):
        return any(j is not None for j in (self._list_job, self._cells_job, self._geo_job))

    def start(self, now):
        if not self._busy():
            self._list_job = get_json(self.pool, self.base, "/daemon/stash-grid", self.hdrs,
                                      timeout_s=self.timeout_s, tag="valuegrid")
            self._list_press = False

    def press(self, now):
        if self._busy():
            return  # the answer to the last press is still to come
        if self.cap.waits() and not self.cap.due(now):
            self._say(self._problem or "failed")
            return
        if self._tabs is not None and self._tabs_at is not None and now - self._tabs_at < TABS_EVERY_S:
            self._choose(now)
            return
        self._list_job = get_json(self.pool, self.base, "/daemon/stash-grid", self.hdrs,
                                  timeout_s=self.timeout_s, tag="valuegrid")
        self._list_press = True

    def _say(self, kind_or_text):
        if self._showing:
            self._showing = False
            self.hide_grid(GRID_KEY)
        self.show_card(_card(PROBLEMS.get(kind_or_text, kind_or_text)))

    # --- the run ------------------------------------------------------------------

    def _run(self):
        """The tabs a press steps through, and the card when there are none."""
        tabs = [t for t in (self._tabs or []) if isinstance(t, dict) and _whole(t.get("index"))]
        if not tabs:
            return [], "no-tabs"
        if not self.names:
            run = [t for t in tabs if t.get("grid") is True]
            return run, None if run else "no-run"
        run = []
        for name in self.names:
            run += [t for t in tabs if t.get("name") == name and t not in run]
        return run, None if run else "no-named"

    def _note_unknown(self):
        known = {t.get("name") for t in (self._tabs or []) if isinstance(t, dict)}
        new = [n for n in self.names if n not in known and n not in self._said_unknown]
        if not new:
            return
        self._said_unknown.update(new)
        names = ", ".join(f'"{n}"' for n in new)
        self.log.info(f"Value grid: [stash_grid] value_tabs names {names}, which no stored stash tab has; the "
                      f"value key skips {'it' if len(new) == 1 else 'them'}.")

    def _whisper_tab(self, now, run):
        try:
            entries = [e for e in (self.positions() or []) if isinstance(e, dict)]
        except Exception:
            return None
        if not entries:
            return None
        newest = entries[0]
        at = newest.get("at")
        if not _finite(at) or now - at >= self.whisper_hold_s:
            return None
        return next((t["index"] for t in run if t.get("name") == newest.get("tab")), None)

    def _choose(self, now):
        run, empty = self._run()
        if empty:
            self.cycle.press(now, [])
            self._say(empty)
            return
        order = [t["index"] for t in run]
        i = self.cycle.press(now, order, self._whisper_tab(now, run))
        if i is None:
            if self._showing:
                self._showing = False
                self.hide_grid(GRID_KEY)
            return
        tab = run[i]
        if tab.get("grid") is not True:
            self._say(f'tab "{_tab_name(tab)}": no value grid for this tab type')
            return
        if self.grid["mode"] != "manual" and not self.xdotool:
            self._say("no-xdotool")
            return
        self._pick = (tab, i, len(run))
        self._cells = self._geo = None
        self._cells_job = get_json(self.pool, self.base, f"/daemon/stash-grid?tab={tab['index']}", self.hdrs,
                                   timeout_s=self.timeout_s, tag="valuegrid")
        if self.grid["mode"] != "manual":
            self._geo_job = self.pool.start_cmd([self.xdotool, "getwindowfocus", "getwindowgeometry", "--shell"],
                                                timeout_s=GEOMETRY_TIMEOUT_S, tag="valuegrid")

    # --- answers ------------------------------------------------------------------

    def _verdict(self, res, now):
        """A CurlResult -> ('ok', data) or ('card', kind or text). Journal
        lines through the capability; too many presses and a tab that is gone
        are answers, not faults."""
        data = _json(res.body) if (res.rc == 0 and not res.timed_out and res.status in (404, 429)) else None
        if res.status == 429 and data is not None:
            self.cap.note(("ok", data), now)
            self._problem = None
            return ("card", "too-many")
        if res.status == 404 and data is not None and data.get("error") == "no such tab":
            self.cap.note(("ok", data), now)
            self._problem = None
            self._tabs_at = None
            return ("card", "gone")
        verdict = classify(res)
        if verdict[0] == "ok" and not isinstance(verdict[1].get("tabs"), list):
            verdict = ("failing", "not-json", str(res.status))
        self.cap.note(verdict, now)
        if verdict[0] == "ok":
            self._problem = None
            self._tabs = [t for t in verdict[1]["tabs"] if isinstance(t, dict)]
            self._tabs_at = now
            return verdict
        if verdict[0] == "unsupported":
            kind = "unsupported"
        elif verdict[1] == "unknown-user":
            kind = "unknown-user"
        elif verdict[1].startswith("unreachable-") and verdict[1].split("-", 1)[1] in NOT_SENT_RC:
            kind = "unreachable"
        elif verdict[1] == "timeout" or verdict[1].startswith("unreachable-"):
            kind = "no-answer"
        else:
            kind = "failed"
        self._problem = kind
        return ("card", kind)

    def tick(self, now):
        job = self._list_job
        if job is not None and job.result is not None:
            self._list_job = None
            verdict = self._verdict(job.result, now)
            if verdict[0] == "ok":
                self._note_unknown()
                if self._list_press:
                    self._choose(now)
            elif self._list_press:
                self._say(verdict[1])
        for name in ("_cells_job", "_geo_job"):
            job = getattr(self, name)
            if job is not None and job.result is not None:
                setattr(self, name, None)
                setattr(self, "_cells" if name == "_cells_job" else "_geo", job.result)
        if self._pick is None or self._cells_job is not None or self._geo_job is not None or self._cells is None:
            return
        pick, cells, geo = self._pick, self._cells, self._geo
        self._pick = self._cells = self._geo = None
        verdict = self._verdict(cells, now)
        if verdict[0] != "ok":
            if verdict[1] == "gone":
                self._say(f'tab "{_tab_name(pick[0])}" is gone from the stash; press again')
            else:
                self._say(verdict[1])
            return
        if self.grid["mode"] == "manual":
            rect = self.grid["rect"]
        else:
            rect = self._window(geo)
            if rect is None:
                return
        self._draw(rect, verdict[1], pick)

    def _window(self, res):
        window = parse_geometry(res.body) if (res is not None and not res.timed_out and res.rc == 0) else None
        if window is not None:
            return grid_rect(window, self.grid["folders"])
        if res is None or res.timed_out:
            why, tag = f"no answer within {GEOMETRY_TIMEOUT_S} s", "timeout"
        else:
            detail = str(res.err or "").strip().splitlines()
            why = (f"exit {res.rc}: {detail[0][:120]}" if detail and res.rc != 0 else
                   f"exit {res.rc}" if res.rc != 0 else "no X, Y, WIDTH and HEIGHT in its answer")
            tag = f"exit-{res.rc}"
        self.log.failure(("valuegrid", "geometry", tag),
                         f"Value grid: the game window's size could not be read with xdotool ({why}). Next: run "
                         f"./daemon/selftest.sh with the game running (section 13), or set [stash_grid] mode = "
                         f"\"manual\" with x, y, w, h in {self.config_path}")
        self._say("geometry")
        return None

    def _draw(self, rect, data, pick):
        tab = data.get("tab") if isinstance(data.get("tab"), dict) else pick[0]
        name = _tab_name(tab)
        if tab.get("grid") is not True:
            self._say(f'tab "{name}": no value grid for this tab type')
            return
        raw = data.get("cells")
        if not isinstance(raw, list):
            self._say(f'tab "{name}": read again with the next sync')
            return
        cd = data.get("chaosPerDivine") if _finite(data.get("chaosPerDivine")) else None
        good = [c for c in raw if isinstance(c, dict)
                and all(_whole(c.get(k)) for k in ("x", "y", "w", "h")) and _finite(c.get("c"))
                and c["x"] >= 0 and c["y"] >= 0 and c["w"] > 0 and c["h"] > 0]
        quad = tab.get("quad") is True or any(is_quad(c["x"] + 1, c["y"] + 1) for c in good)
        count = 24 if quad else 12
        cells, rows = [], []
        uncertain = 0
        for c in sorted(good, key=lambda c: -c["c"]):
            if c["c"] < self.min_c or c["x"] + c["w"] > count or c["y"] + c["h"] > count:
                continue
            left, top = c["x"] + 1, c["y"] + 1
            x, y, w, h = span_rect(rect, left, top, c["w"], c["h"], quad)
            text = value_text(c["c"], cd, self.lang)
            cell = {"x": x, "y": y, "w": w, "h": h, "label": text}
            if c.get("u") is True:
                # The price the Net Worth page marks uncertain: a '?' after
                # the value, and the overlay draws the cell's border dashed.
                text += "?"
                cell.update(label=text, u=True)
                uncertain += 1
            cells.append(cell)
            rows.append(f"left {left}, top {top}: {text} {_cut(c.get('n') or 'item', NAME_CHARS)}")
        i, n = pick[1], pick[2]
        floor = f"{_num(self.min_c, self.lang, 1)}c"
        label = f'{i + 1}/{n} tab "{name}" · '
        label += (f"{len(cells)} item{'' if len(cells) == 1 else 's'} from {floor}" if cells
                  else f"nothing from {floor}")
        if uncertain:
            # Beside the count it is part of, and before the total: the
            # overlay cuts a line too wide for the grid at its end.
            label += f" · {uncertain} uncertain"
        total = data.get("totalChaos")
        if _finite(total) and total > 0:
            # The server's sum over every stored cell (from 1 c), not only the
            # ones drawn: the whole tab's worth.
            label += f" · tab total {value_text(total, cd, self.lang)}"
        grid = {"key": GRID_KEY, "x": rect[0], "y": rect[1], "w": rect[2], "h": rect[3], "cells": cells,
                "label": label, "hold_ms": int(self.hold_s * 1000)}
        body = "\n".join(rows[:TOAST_LINES]) if rows else f"nothing worth {floor} or more"
        self._showing = True
        self.show_grid(grid, (f'Value grid · tab "{name}"', body))
