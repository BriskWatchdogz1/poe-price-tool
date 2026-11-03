"""ppt_session — the session key ([session] key) and the session cards.

The daemon's part of farm and game sessions (the server's side is
backend/v2/networth/session-control.mjs). A press of the key while the game has
focus (the daemon checks the focus, as for the macro keys) is one
POST /daemon/session {"action": "toggle"}: the server ends the user's running
farm session, else starts one, and answers with the session as it is now. The
server puts that state into the feed as well (GET /daemon/events, kind
'session'), and every later one: the baseline set, the end, the final balance,
and the game sessions it starts and ends from the game detection. The answer
and the feed event of one state are one card (ppt_results.session_card). A
session belongs to the user, not to one daemon: an event caused by another
daemon of the user, by the History page or by the game detection (by null) is
shown too.

At most one request in flight: a press while it runs is not sent. A refusal
(409: no stash sync, no recent read, already running, not running) and too
many presses (429) are cards without a journal line: they are answers, not
faults. A server without the route (404 or 405) is one journal line and, at
every press until it is asked again after reprobe_s, a card without a
request; so is a user the server does not know. Any other failure is a
journal line (throttled, through ppt_diag.link_problem) and a card.

Standard library only; no clock or process of its own, so
backend/v2/daemon-session-key.test.mjs drives it with a fake pool.
"""
import json
from collections import OrderedDict

from ppt_link import REPROBE_S, Capability, classify, post_json
from ppt_results import session_card, session_problem_card, session_refusal_card

# curl exits that mean the request never reached the server (no name, nothing
# listening, no TLS): nothing changed there. After any other failure the
# server may have toggled the session before the answer was lost.
NOT_SENT_RC = ("6", "7", "35", "60")


def _json(text):
    try:
        data = json.loads(text) if text else None
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


class SessionKey:
    """press(now) sends a toggle; tick(now) and event(ev, now) return the
    cards to show (a list, mostly of one). lang is the cards' number format;
    the daemon sets it after its start-up check, like the result cards'."""

    def __init__(self, *, pool, base_url, hdrs, log, clock=None, lang="en", config_path="", user=None,
                 reprobe_s=REPROBE_S, timeout_s=5, keep=32):
        self.pool = pool
        self.base = str(base_url).rstrip("/")
        self.hdrs = list(hdrs)
        self.lang = lang
        self.timeout_s = float(timeout_s)
        self.keep = int(keep)
        self.cap = Capability("session", log, clock, reprobe_s, self.base, config_path, user)
        self._job = None
        self._problem = None          # the card a press gets while the server is not asked again
        self._shown = OrderedDict()   # (id, state) of the session cards shown

    def press(self, now):
        if self._job is not None:
            return []  # the answer to the last press is still to come
        if self.cap.waits() and not self.cap.due(now):
            return [session_problem_card(self._problem or "failed")]
        self._job = post_json(self.pool, self.base, "/daemon/session", {"action": "toggle"}, self.hdrs,
                              timeout_s=self.timeout_s, tag="session")
        return []

    def _card(self, session):
        """The card of one state of a session, once: the answer and the feed
        carry the same state."""
        key = (session.get("id"), session.get("state"))
        if key in self._shown:
            return []
        self._shown[key] = True
        while len(self._shown) > self.keep:
            self._shown.popitem(last=False)
        card = session_card(session, self.lang)
        return [card] if card is not None else []

    def _answered(self, res, now):
        data = _json(res.body)
        if res.rc == 0 and not res.timed_out and res.status in (409, 429) and data is not None:
            self.cap.note(("ok", data), now)
            self._problem = None
            if res.status == 429:
                return [session_problem_card("too-many")]
            return [session_refusal_card(data.get("action"), str(data.get("error") or ""))]
        verdict = classify(res)
        if verdict[0] == "ok" and not isinstance(verdict[1].get("session"), dict):
            verdict = ("failing", "not-json", str(res.status))
        self.cap.note(verdict, now)
        if verdict[0] == "ok":
            self._problem = None
            return self._card(verdict[1]["session"])
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
        return [session_problem_card(kind)]

    def tick(self, now):
        if self._job is None or self._job.result is None:
            return []
        res, self._job = self._job.result, None
        return self._answered(res, now)

    def event(self, ev, now):
        """One feed event: kind 'session' -> its card, unless that state was
        shown already; anything else -> []."""
        if not isinstance(ev, dict) or ev.get("kind") != "session":
            return []
        session = ev.get("session")
        if not isinstance(session, dict):
            return []
        return self._card(session)
