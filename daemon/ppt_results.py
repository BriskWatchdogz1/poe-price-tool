"""ppt_results — what the player sees after a price check: one state per item
this daemon posted, turned into card lines and a notification text.

Standard library only, no clock of its own (now is passed in), no process:
backend/v2/daemon-results.test.mjs drives it with numbers.

The rule this module exists for: there is ALWAYS an answer. An item that never
gets a result ends as 'no result within N', a result the feed lost ends as
'missed', a missing back channel is said on the card itself, and a local
failure of the POST (unreadable item, server unreachable) is a card too.
Facts come from the server (GET /daemon/events, backend/v2/frontend/PROTOCOL.md),
words are made here, so an older server and a newer daemon still agree.

A card is {'key': str, 'title': str, 'lines': [[text, tone], ...], 'final': bool};
tone is one of TONES. The notification shows the title as its summary and the
other lines as its body (toast_for).

Buyer whispers (ppt_whisper) have cards of their own: whisper_card for an entry
of POST /daemon/whisper, whisper_failure_card for a POST that failed,
whisper_unsupported_card for a server without the route. Their first line
names the buyer on the overlay only; their title, and so the notification,
says the pseudonym ('Whisper from buyer 3'): whisper_toast_for. Every text
from an entry (item, tab, league, the buyer's note) is a stranger's and goes
into the card as plain text; the overlay draws plain text and the Notifier
escapes the body.

Farm and game sessions (ppt_session) have cards too: session_card for a
session as the feed's `session` event carries it, session_refusal_card and
session_problem_card for a press of the session key that changed nothing.
All of them share the key 'session', so each replaces the one before; they go
into the overlay's whisper stack (ppt_display.Display.show_session).
"""
import math
from collections import OrderedDict

TONES = ("name", "price", "muted", "good", "warn", "bad")
MAX_LINES = 4
MAX_CHARS = 48  # the name line; the other lines are this module's own short texts
DEFAULT_TITLE = "Price check"

# Why the price stays in the browser, per state of the downlink (ppt_link).
BROWSER_ONLY = {
    "unsupported": "the server is older than this daemon",
    "off": "back channel off in config.toml",
    "failing": "the back channel is failing, see the journal",
    "starting": "the back channel is not connected yet",
}

LOCAL_FAILURE = {
    "unreadable": "item not readable — listed in the admin view",
    "no-parser": "no data for this game language on the server",
    "unknown-user": "the server does not know this user",
    "unreachable": "server not reachable — the item was not sent",
    "failed": "not sent — see the daemon's journal",
}

GAP_REASONS = {"gap": "updates were dropped"}


def _finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _num(x, lang, decimals):
    s = f"{x:,.{decimals}f}"
    if decimals:
        s = s.rstrip("0").rstrip(".")
    if lang == "de":
        s = s.replace(",", "\0").replace(".", ",").replace("\0", ".")
    return s


def _decimals(x):
    x = abs(x)
    return 3 if x < 1 else 1 if x < 100 else 0


def _unit(chaos, cd, currency):
    if currency == "divine":
        return "div"
    return "div" if _finite(cd) and cd > 0 and _finite(chaos) and chaos >= cd else "c"


def _amount(value, unit, cd, currency, lang, decimals=None):
    """The number of `value` (in `currency`) written in `unit`."""
    v = value
    if unit == "div" and currency != "divine":
        v = value / cd
    return _num(v, lang, _decimals(v) if decimals is None else decimals)


def money(chaos, cd=None, lang="en", currency="chaos"):
    """'212 c'; from 1 div on and with cd known '1.4 div'; below 1 c three
    decimals ('0.018 c'); a value already in divine ('140 div'). de: '1.484 c',
    '1,4 div'. Anything that is not a number: '?'."""
    if not _finite(chaos):
        return "?"
    unit = _unit(chaos, cd, currency)
    return f"{_amount(chaos, unit, cd, currency, lang)} {unit}"


def _span(seconds):
    s = float(seconds)
    if s >= 3600:
        return f"{round(s / 3600):g} h"
    if s >= 60:
        return f"{round(s / 60):g} min"
    return f"{round(s):g} s"


def _wait_text(wait_s):
    w = int(wait_s)
    return f"{w // 60} min" if w >= 60 and w % 60 == 0 else f"{w} s"


def _cut(text, n=MAX_CHARS):
    return text if len(text) <= n else text[: n - 1] + "…"


def _title(st):
    name = st.get("name") or st.get("base") or "Item"
    stack = st.get("stack")
    if isinstance(stack, int) and not isinstance(stack, bool) and stack > 1:
        name = f"{name} ×{stack}"
    return _cut(str(name))


def _price_lines(price, stack, cd, lang):
    """-> (lines, priced). priced: a trade, exchange or ninja value is shown."""
    src = price.get("source")
    cur = price.get("currency") or "chaos"
    med = price.get("median")
    if src == "exchange" or src == "ninja":
        if not _finite(med):
            return [("no price — see the browser", "warn")], False
        main = money(med, cd, lang, cur)
        if src == "exchange" and isinstance(stack, int) and stack > 1:
            main = f"{main} each · {money(med * stack, cd, lang, cur)}"
        if src == "ninja":
            return [(main, "price"), ("poe.ninja", "muted")], True
        tail = "Currency Exchange"
        age = price.get("ageHours")
        if _finite(age) and age >= 1:
            tail += f" · rate {round(age):g} h old"
        return [(main, "price"), (tail, "muted")], True
    count = price.get("count")
    if not _finite(med) or count == 0:
        return [("no listings — no price", "warn")], False
    unit = _unit(med, cd, cur)
    main = f"{_amount(med, unit, cd, cur, lang)} {unit}"
    low, high = price.get("low"), price.get("high")
    if _finite(low) and _finite(high) and low != high:
        main += f" ({_amount(low, unit, cd, cur, lang)}–{_amount(high, unit, cd, cur, lang)})"
    lines = [(main, "price")]
    if _finite(count):
        tail = f"{_num(count, lang, 0)} listings"
        if price.get("conflict"):
            tail += " · asks disagree"
        lines.append((tail, "muted"))
    return lines, True


def item_lines(st, lang="en", wait_s=120):
    """[(text, tone)], at most MAX_LINES, for one item state (a feed event plus
    the closing marks _closed and _reason this module adds)."""
    lines = [(_title(st), "name")]
    cd = st.get("cd") if _finite(st.get("cd")) else None
    stack = st.get("stack") if isinstance(st.get("stack"), int) else None
    price = st.get("price") if isinstance(st.get("price"), dict) else None
    ref = st.get("ref") if isinstance(st.get("ref"), dict) else None
    ref_chaos = ref.get("chaos") if ref and _finite(ref.get("chaos")) else None
    status = st.get("status")
    closed = st.get("_closed")

    is_trade = False
    if price:
        plines, _ = _price_lines(price, stack, cd, lang)
        lines += plines
        is_trade = price.get("source") not in ("exchange", "ninja")
    elif ref_chaos is not None:
        lines.append((f"poe.ninja {money(ref_chaos, cd, lang)}", "price"))

    if closed == "timeout":
        lines.append((f"no result within {_wait_text(wait_s)} — see the browser", "warn"))
    elif closed == "missed":
        lines.append((f"result missed ({st.get('_reason') or 'unknown'}) — see the browser", "warn"))
    elif status == "queued":
        ahead = st.get("ahead")
        if isinstance(ahead, int) and not isinstance(ahead, bool) and ahead > 0:
            lines.append((f"queued · about {ahead} ahead", "muted"))
        elif ahead == 0:
            lines.append(("queued · next", "muted"))
        else:
            lines.append(("queued", "muted"))
    elif status == "searching":
        lines.append(("searching…", "muted"))
    elif status == "rate-limited":
        retry = st.get("retryAfterSec")
        pause = f" ~{_span(retry)}" if _finite(retry) and retry > 0 else ""
        lines.append((f"trade search paused{pause} (GGG limit)", "warn"))
    elif status == "error":
        lines.append(("search failed — see the browser", "bad"))
    elif status == "done" and not price:
        lines.append(("no price — see the browser", "warn"))

    if price and is_trade and ref_chaos is not None:
        lines.append((f"poe.ninja {money(ref_chaos, cd, lang)}", "muted"))
    return lines[:MAX_LINES]


def _priced(st):
    price = st.get("price") if isinstance(st.get("price"), dict) else None
    return bool(price) and _finite(price.get("median")) and price.get("count") != 0


def card_for(st, lang="en", wait_s=120):
    return {
        "key": f"item:{st.get('id')}",
        "title": _title(st),
        "lines": [[t, tone] for t, tone in item_lines(st, lang, wait_s)],
        "final": bool(st.get("final")) or st.get("_closed") is not None,
    }


def _message_card(key, title, text, tone):
    return {"key": key, "title": _cut(str(title or DEFAULT_TITLE)),
            "lines": [[_cut(str(title or DEFAULT_TITLE)), "name"], [text, tone]], "final": True}


def toast_for(card):
    """(summary, body): the title, and the other lines joined by newlines."""
    body = "\n".join(t for t, tone in card["lines"] if tone != "name")
    return (card["title"], body)


class ResultBook:
    """One state per item this daemon instance posted.

    BINDING a POST to its card: posted() adds one open POST (with its time).
    The server sends the card's first feed event BEFORE it writes the POST
    answer, so that event may be handled before poe-price-post.sh exits. Every
    item event of this instance with an id not seen before redeems the oldest
    open POST, also when it came up to bind_s BEFORE posted() (such ids are
    kept for bind_s and redeem the next posted()). An event marked `reassert`
    redeems the same way although its id is known: the server folded this
    POST into a card it already had (the double read of one copy, REPOST_DEDUP_MS
    in server.mjs) and replays that card's state. Two quick hotkeys: two open
    POSTs, the first two such events redeem them in order. 'no live answer' is
    shown for an open POST that nothing redeemed within bind_s, unless the book
    holds a card of an item of the same name that shows a price and had an
    event since then (the price beats the shrug, for that item only). A gap or
    a server restart ends the open POSTs at once as 'result missed'."""

    def __init__(self, instance, wait_s=120, bind_s=10, keep=20, lang="en"):
        self.instance = instance
        self.wait_s = float(wait_s)
        self.bind_s = float(bind_s)
        self.keep = int(keep)
        self.lang = lang
        self.items = OrderedDict()  # id -> {'st': event + _closed/_reason, 'opened': t, 'seen': t}
        self.open_posts = []        # [(t, name)]
        self.unbound = []           # [(t, id)]: redeeming events seen before their posted()
        self.notes = OrderedDict()  # name -> the last message card about it (post, local failure)
        self._n = 0

    def _card(self, st):
        return card_for(st, self.lang, self.wait_s)

    def _note(self, card, name):
        if name:
            self.notes.pop(name, None)
            self.notes[name] = card
            while len(self.notes) > self.keep:
                self.notes.popitem(last=False)
        return card

    def _next_key(self, kind):
        self._n += 1
        return f"{kind}:{self._n}"

    def _named(self, st, name):
        return bool(name) and name in (st.get("name"), st.get("base"))

    def _priced_since(self, name, since):
        return any(self._named(rec["st"], name) and _priced(rec["st"]) and rec["seen"] >= since
                   for rec in self.items.values())

    def posted(self, now, link_state, name=None):
        """poe-price-post.sh exited 0. With the downlink 'ok' the card comes
        from the feed: None. In any other state a card 'sent — the price shows
        in the browser only (<why>)' at once."""
        if link_state == "ok":
            self.unbound = [(t, i) for t, i in self.unbound if now - t <= self.bind_s]
            if self.unbound:
                self.unbound.pop(0)
            else:
                self.open_posts.append((now, name))
            return None
        why = BROWSER_ONLY.get(link_state, f"back channel {link_state}")
        return self._note(_message_card(self._next_key("post"), name,
                                        f"sent — the price shows in the browser only ({why})", "warn"), name)

    def local_failure(self, kind, name=None):
        """The POST did not reach the server, or was refused. kind: 'unreadable',
        'no-parser', 'unknown-user', 'unreachable' or 'failed'."""
        text = LOCAL_FAILURE.get(kind, LOCAL_FAILURE["failed"])
        return self._note(_message_card(self._next_key("local"), name, text, "bad"), name)

    def same_item(self, name=None):
        """poe-price-post.sh said 'same-item': the newest card of an item of
        that name (its current state), else the last note about that name.
        Without either (a daemon restarted since: the marker of post.sh lives
        on in XDG_RUNTIME_DIR) a card that says so; never None."""
        if name:
            for rec in sorted(self.items.values(), key=lambda r: r["seen"], reverse=True):
                if self._named(rec["st"], name):
                    return self._card(rec["st"])
            if name in self.notes:
                return self.notes[name]
        return _message_card(self._next_key("same"), name,
                             "same item as before — its price is in the browser", "muted")

    def event(self, ev, now):
        """One feed event. Only ev['by'] == instance is taken (another daemon
        of the same user is ignored). kind 'item' replaces the state of that
        id; kind 'item-removed' forgets it (no card). Returns the card or None."""
        if not isinstance(ev, dict) or ev.get("by") != self.instance:
            return None
        kind = ev.get("kind")
        iid = ev.get("id")
        if not isinstance(iid, str) or not iid:
            return None
        if kind == "item-removed":
            self.items.pop(iid, None)
            return None
        if kind != "item":
            return None
        rec = self.items.get(iid)
        if rec is None or ev.get("reassert") is True:
            if self.open_posts:
                self.open_posts.pop(0)
            else:
                self.unbound.append((now, iid))
        if rec is None:
            rec = {"st": {}, "opened": now, "seen": now}
            self.items[iid] = rec
            while len(self.items) > self.keep:
                self.items.popitem(last=False)
        elif rec["st"].get("_closed") or ev.get("reassert") is True:
            rec["opened"] = now  # a late answer, or the card asked for again: a fresh wait
        rec["seen"] = now
        rec["st"] = dict(ev)
        return self._card(rec["st"])

    def gap(self, now, reason):
        """The feed missed events or the server restarted: every open item
        closes as 'missed', and so does every open POST (its event may be
        among the lost ones; one that still comes shows its card over this).
        Returns their cards."""
        cards = []
        why = GAP_REASONS.get(reason, reason)
        for t, name in self.open_posts:
            cards.append(self._note(_message_card(
                self._next_key("post"), name, f"result missed ({why}) — see the browser", "warn"), name))
        self.open_posts = []
        for rec in self.items.values():
            st = rec["st"]
            if st.get("final") or st.get("_closed"):
                continue
            st["_closed"] = "missed"
            st["_reason"] = why
            cards.append(self._card(st))
        return cards

    def tick(self, now):
        """Close items open longer than wait_s; end open POSTs nothing
        redeemed within bind_s. Returns the cards to show."""
        cards = []
        while self.open_posts and now - self.open_posts[0][0] > self.bind_s:
            t, name = self.open_posts.pop(0)
            if not self._priced_since(name, t - self.bind_s):
                cards.append(self._note(_message_card(
                    self._next_key("post"), name,
                    "sent — no live answer, the price is in the browser", "warn"), name))
        self.unbound = [(t, i) for t, i in self.unbound if now - t <= self.bind_s]
        for rec in self.items.values():
            st = rec["st"]
            if st.get("final") or st.get("_closed"):
                continue
            if now - rec["opened"] > self.wait_s:
                st["_closed"] = "timeout"
                cards.append(self._card(st))
        return cards


# --- buyer whispers ------------------------------------------------------------

WHISPER_MAX_CHARS = 80  # a stranger's item text; the overlay elides to its width anyway
WHISPER_TAB_CHARS = 30
WHISPER_NOTE_CHARS = 40

# Why a POST /daemon/whisper went wrong, by the key of ppt_link.classify().
WHISPER_CAUSES = {
    "timeout": "no answer in time",
    "unreachable-28": "no answer in time",
    "too-large": "too long for the server",
    "too-many-whispers": "too many whispers this minute",
    "unknown-user": "the server did not accept it",
    "bad-request": "the server did not accept it",
    "http-400": "the server did not accept it",
}


def wait_text(wait_s):
    """'2 min' for 120, '90 s' for 90 (the words of a closed wait)."""
    return _wait_text(wait_s)


def whisper_cause(key):
    key = str(key or "")
    if key in WHISPER_CAUSES:
        return WHISPER_CAUSES[key]
    if key.startswith("unreachable-"):
        return "server not reachable"
    return "server error"


def _whisper_head(label, name, repeats):
    head = f"Whisper from {name or label}"
    if isinstance(repeats, int) and repeats > 0:
        head += f" ×{repeats + 1}"
    return [_cut(head, WHISPER_MAX_CHARS), "name"]


def _whisper_base(wid, label, name, repeats=0):
    label = str(label or "buyer")
    return {"key": f"whisper:{wid}", "title": f"Whisper from {label}",
            "lines": [_whisper_head(label, name, repeats)], "final": True}


def _listed(amount, unit, lang):
    if not _finite(amount):
        return "?"
    return f"{_num(amount, lang, _decimals(amount))} {unit or ''}".rstrip()


def _market_text(asked, chaos, lang):
    """The market value in the listing's unit when that unit is not chaos and
    its rate is known ('market 1.1 divine' next to 'your 1 divine'), else in
    chaos ('market 154 c')."""
    if not _finite(chaos):
        return None
    if isinstance(asked, dict):
        amount, unit, achaos = asked.get("amount"), asked.get("unit"), asked.get("chaos")
        if (unit and str(unit).lower() not in ("chaos", "chaos orb") and _finite(amount) and amount > 0
                and _finite(achaos) and achaos > 0):
            v = chaos / (achaos / amount)
            return f"{_num(v, lang, _decimals(v))} {unit}"
    return money(chaos, None, lang)


def _reading(chaos, lang):
    """A chaos number of the two readings: money(), but a positive one below
    the card's three decimals is '<0.001 c', never '0 c' (a price of 0)."""
    if _finite(chaos) and 0 < chaos < 0.001:
        return f"<{_num(0.001, lang, 3)} c"
    return money(chaos, None, lang)


# What would stop a verdict also doubts the two readings (`caveat` on a
# stack-unknown entry); short, it stands after the listed price on the item line.
STACK_CAVEATS = {"rate-unknown": "C:D rate unknown", "uncertain-price": "price uncertain"}
WHISPER_CAVEAT_CHARS = 30


def _stack_caveat(e):
    c = e.get("caveat")
    if c is None or c == "":
        return None
    return STACK_CAVEATS.get(c) or _cut(str(c), WHISPER_CAVEAT_CHARS)


def _stack_readings(e, asked, each, lang):
    """A single whisper for a stackable item (stack-unknown): both readings
    of 'listed for' in chaos per unit, '100 c each, or 5 c each as a stack of
    20 · market 0.4 c each'; the listed price itself stands on the item line.
    Short enough for the overlay's width (a card has 4 lines). The stack size
    comes from the server (the whisper's own text, or the last sync at that
    cell: then '(last sync)', since that stack may have changed); without
    one, or below 2, only the per-unit reading. None when the listed price
    has no chaos value (then the plain reason line)."""
    if not isinstance(asked, dict) or not _finite(asked.get("chaos")):
        return None
    st = e.get("stack") if isinstance(e.get("stack"), dict) else {}
    size, per = st.get("size"), st.get("chaosEach")
    market = f" · market {_reading(each, lang)} each" if _finite(each) else ""
    unit = f"{_reading(asked.get('chaos'), lang)} each"
    if isinstance(size, int) and not isinstance(size, bool) and size >= 2 and _finite(per):
        synced = " (last sync)" if st.get("from") == "sync" else ""
        return f"{unit}, or {_reading(per, lang)} each as a stack of {_num(size, lang, 0)}{synced}{market}"
    return f"{unit}{market} — stack size unknown"


def _whisper_reason(e, asked, market_text, each_text, lang):
    r = e.get("reason")
    unit = asked.get("unit") if isinstance(asked, dict) else None
    with_market = (lambda t: f"{t} · market {market_text}" if market_text else t)
    texts = {
        "rare": "rare, no market price",
        "magic-or-normal": "magic or normal item, no market price",
        "gem": "gem, corruption unknown",
        "variants": "several variants",
        "no-market": "no market price",
        "unknown-currency": f"price in {unit or '?'}: no rate",
        "no-rate": f"no price for {unit or '?'} right now",
        "other-league": f"listed in {_cut(str(e.get('league') or '?'), WHISPER_TAB_CHARS)}, not your league",
        "unknown-item": "item not recognised",
        "no-language-data": f"no {e.get('lang') or '?'} item data on the server",
        "stack-unknown": (f"market {each_text} each, per unit or per stack unknown" if each_text
                          else "per unit or per stack unknown"),
        "pricing-off": "price check is off on the server",
        "unpriced-listing": with_market("not listed with a price"),
        "rate-unknown": with_market("Chaos:Divine rate unknown or stale"),
        "uncertain-price": with_market("market price uncertain"),
        "error": "market check failed — see the server log",
    }
    return texts.get(r, str(r or "no reason given"))


def whisper_card(entry, name=None, note=None, lang="en", closed=None, repeats=0):
    """A card for one entry of POST /daemon/whisper (or its feed event).
    name: the buyer, known only on this PC (line 1 on the overlay; None -> the
    label). note: the buyer's own text after the template, from the daemon's
    copy (the server sends only its length). closed: the words that end a
    pending wait. repeats: how often the same whisper came again."""
    e = entry if isinstance(entry, dict) else {}
    card = _whisper_base(e.get("wid") or "?", e.get("label"), name, repeats)
    lines = card["lines"]
    verdict = e.get("verdict")
    card["final"] = verdict != "pending" or closed is not None
    if verdict == "unparsed":
        lines.append(["whisper not recognised — see the browser", "muted"])
        return card
    item = e.get("item") if isinstance(e.get("item"), dict) else {}
    text = str(item.get("text") or "?")
    asked = e.get("asked") if isinstance(e.get("asked"), dict) else None
    market = e.get("market") if isinstance(e.get("market"), dict) else {}
    bulk = e.get("kind") == "bulk"
    qty = e.get("qty") if _finite(e.get("qty")) and e.get("qty") > 0 else 1
    readings = (_stack_readings(e, asked, market.get("chaosEach"), lang)
                if verdict == "not-compared" and e.get("reason") == "stack-unknown" else None)
    if bulk:
        line2 = f"{_num(qty, lang, 0)} × {text}"
        if asked:
            line2 += f" for {_listed(asked.get('amount'), asked.get('unit'), lang)}"
    elif readings:
        line2 = f"{text} for {_listed(asked.get('amount'), asked.get('unit'), lang)}"
        caveat = _stack_caveat(e)
        if caveat:
            line2 += f" · {caveat}"
    else:
        line2 = text
    lines.append([_cut(line2, WHISPER_MAX_CHARS), "name"])

    yours = None
    if asked:
        amount = asked.get("amount")
        if bulk and _finite(amount):
            yours = f"your {_listed(amount / qty, asked.get('unit'), lang)} each"
        else:
            yours = f"your {_listed(amount, asked.get('unit'), lang)}"
    each = market.get("chaosEach")
    total = each if bulk else market.get("chaos")
    mtext = _market_text(asked, total, lang)
    if mtext and bulk:
        mtext += " each"
    each_text = money(each, None, lang) if _finite(each) else None

    if closed:
        lines.append([closed, "warn"])
    elif verdict == "pending":
        lines.append(["checking the market…", "muted"])
    elif verdict in ("fair", "below", "above"):
        pct = e.get("pct")
        pct_text = _num(pct, lang, 0) if _finite(pct) else "?"
        tail = {"fair": "fair", "below": f"{pct_text} % below market",
                "above": f"{pct_text} % above market"}[verdict]
        tone = "bad" if verdict == "below" else "good"
        lines.append([f"{yours or 'your ?'} · market {mtext or '?'} — {tail}", tone])
    else:
        reason = _whisper_reason(e, asked, mtext, each_text, lang)
        tone = "warn" if e.get("reason") == "other-league" else "muted"
        if readings:
            lines.append([readings, "warn" if _stack_caveat(e) else tone])
        else:
            lines.append([f"{yours} · {reason} — not compared" if yours else f"{reason} — not compared", tone])

    tab = e.get("tab")
    if isinstance(tab, str) and tab:
        left = e.get("left") if isinstance(e.get("left"), int) else "?"
        top = e.get("top") if isinstance(e.get("top"), int) else "?"
        lines.append([f'tab "{_cut(tab, WHISPER_TAB_CHARS)}" · left {left}, top {top}', "muted"])
    elif note:
        lines.append([f"note: {_cut(str(note), WHISPER_NOTE_CHARS)}", "muted"])
    card["lines"] = lines[:MAX_LINES]
    return card


def whisper_failure_card(wid, label, key, name=None, lang="en", repeats=0):
    """The POST of a whisper failed (key from ppt_link.classify)."""
    card = _whisper_base(wid, label, name, repeats)
    card["lines"] += [[f"whisper not checked: {whisper_cause(key)}", "warn"], ["see the journal", "muted"]]
    return card


def whisper_unsupported_card(wid, label, name=None, lang="en", repeats=0):
    """The server has no POST /daemon/whisper (older than this daemon)."""
    card = _whisper_base(wid, label, name, repeats)
    card["lines"].append(["whisper seen — this server cannot check whispers yet", "muted"])
    return card


def whisper_toast_for(card, show_name=False):
    """(summary, body) of a whisper card: the title ('Whisper from buyer 3'),
    never the buyer's name unless show_name ([whispers] toast_shows_name);
    the body is every line after the first."""
    lines = card.get("lines") or []
    summary = lines[0][0] if show_name and lines else card.get("title")
    return (summary, "\n".join(t for t, _ in lines[1:]))


def whisper_toast(entry, lang="en", note=None):
    """(summary, body) for an entry, with the label, never the name."""
    return whisper_toast_for(whisper_card(entry, None, note, lang))


# --- farm and game sessions ------------------------------------------------------

SESSION_KEY = "session"  # one slot: each session card replaces the one before

# The session's title per kind and state (backend/v2/frontend/PROTOCOL.md, the
# feed's `session` event). A game session's baseline is no card: the game
# evening started on its own, and its start was said already.
SESSION_TITLES = {
    ("farm", "starting"): "Farm session started",
    ("farm", "running"): "Baseline set, session running",
    ("farm", "preliminary"): "Session ended",
    ("farm", "final"): "Session balance",
    ("farm", "unfinished"): "Session closed unfinished",
    ("game", "starting"): "Game session started",
    ("game", "preliminary"): "Game session ended",
    ("game", "final"): "Game session balance",
    ("game", "unfinished"): "Game session closed unfinished",
}

# Why the server refused a press (409 of POST /daemon/session).
SESSION_REFUSALS = {
    "sync-off": "the server's stash sync is off",
    "no-baseline": "no recent read of your stash, see the Net Worth page",
    "already-running": "a farm session runs already",
    "not-running": "no farm session runs",
}

# What went wrong with a press, by kind (ppt_session.SessionKey).
SESSION_PROBLEMS = {
    "unsupported": ("the server is older than this daemon (no session key)", "warn"),
    "too-many": ("too many presses this minute, try again shortly", "warn"),
    "unreachable": ("server not reachable, nothing changed", "bad"),
    "no-answer": ("no answer from the server, see the History page", "bad"),
    "unknown-user": ("the server does not know this user", "bad"),
    "failed": ("the server did not take it, see the journal", "bad"),
}


def _session_card(title, lines):
    return {"key": SESSION_KEY, "title": title, "lines": [[title, "name"], *lines], "final": True}


def _minutes(about):
    """The server's whole minutes until a full read, or None when it cannot say."""
    return about if isinstance(about, int) and not isinstance(about, bool) and about > 0 else None


def _signed(chaos, div, lang):
    """'+2.5 div' when the divine figure is there, else '+340 c'; '?' without either."""
    if _finite(div):
        v, unit = div, "div"
    elif _finite(chaos):
        v, unit = chaos, "c"
    else:
        return "?"
    sign = "+" if v > 0 else "-" if v < 0 else ""
    return f"{sign}{_num(abs(v), lang, _decimals(v))} {unit}"


def _balance_lines(b, lang):
    if not isinstance(b, dict):
        return [["no balance, see the History page", "warn"]]
    if b.get("stashChanged"):
        return [["stash tabs changed, no loot figure", "warn"]]
    loot = _signed(b.get("loot"), b.get("lootDiv"), lang)
    market = _signed(b.get("market"), b.get("marketDiv"), lang)
    hour = b.get("lootPerHour"), b.get("lootPerHourDiv")
    per_hour = (f"per hour {_signed(*hour, lang)}" if _finite(hour[0]) or _finite(hour[1])
                else "per hour: session too short")
    return [[f"loot {loot}, market {market}", "price"], [per_hour, "muted"]]


def session_card(s, lang="en"):
    """A farm or game session as the feed's `session` event (or the answer of
    POST /daemon/session) carries it -> its card, or None: a game session's
    baseline, a state or kind this daemon does not know, anything that is not
    a session. Numbers in the card's format (lang)."""
    if not isinstance(s, dict):
        return None
    kind, state = s.get("kind"), s.get("state")
    title = SESSION_TITLES.get((kind, state))
    if title is None:
        return None
    lines = []
    n = _minutes(s.get("about"))
    # The server took the copy from the start, not a full read after it
    # (none came in time, or the session ended before one): said on the
    # running card and again on the cards at the end, whose figures rest on it.
    # A game session has no press; its copy is the stash at its start.
    at_press = ([f"baseline: the stash at the {'press' if kind == 'farm' else 'start'} (no full read in time)", "warn"]
                if s.get("baseline") == "at-press" else None)
    if state == "starting" and kind == "farm":
        lines.append(["baseline with the next full read" + (f" (about {n} min)" if n else ""), "muted"])
    elif state == "running" and at_press:
        lines.append(at_press)
    elif state == "preliminary":
        if kind == "farm":
            lines.append(["put your loot in the stash first", "warn"])
        lines.append([f"balance in about {n} min" if n else "balance after the next full read", "muted"])
        if at_press:
            lines.append(at_press)
    elif state == "final":
        lines += _balance_lines(s.get("balance"), lang)
        if at_press:
            lines.append(at_press)
    elif state == "unfinished":
        lines.append(["no full read after its end, see the History page", "warn"])
    return _session_card(title, lines)


def session_refusal_card(action, error):
    """The server refused a press (409): action is the one it tried, 'start'
    or 'end'."""
    title = "Farm session not ended" if action == "end" else "Farm session not started"
    text = SESSION_REFUSALS.get(error, f"refused by the server ({error})")
    return _session_card(title, [[text, "warn"]])


def session_problem_card(kind):
    """A press that did not reach a session: kind is a key of SESSION_PROBLEMS."""
    text, tone = SESSION_PROBLEMS.get(kind, SESSION_PROBLEMS["failed"])
    return _session_card("Session key", [[text, tone]])
