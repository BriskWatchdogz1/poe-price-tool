#!/usr/bin/env python3
"""poe-price-daemon — clipboard-polling price check, plus optional configurable
chat macros.

Price check: the daemon polls the clipboard (the X11 clipboard via xsel, since
PoE runs under XWayland; wl-paste fallback) a few times a second
and, on a new value, hands it to poe-price-post.sh on stdin; that script
filters for PoE items ("Item Class: ..."), de-dupes, and POSTs to the backend.
Polling (a direct read) rather than `wl-paste --watch` (an event) is
deliberate: XWayland game selections don't reliably fire change events until
materialized, but a direct read pulls them on demand. No key injection is
involved — bind your key (a hardware macro device, e.g. a keypad with extra
buttons, or a KDE shortcut) to PoE's own Ctrl+Alt+C copy, and this daemon
prices whatever lands in the clipboard.

Optionally (config `[macros]` section), the daemon also binds evdev keys to
chat commands: on press, it opens chat, types the command layout-aware via
ydotool, and sends it — e.g. F5 -> "/hideout". No `[macros]` section -> the
daemon runs price-check only: no input device is opened (the python-evdev
module must still be installed, the import is unconditional).

Why a daemon instead of "just" a shortcut? For the macros, it checks PoE
focus (so the key doesn't interfere outside the game) and copes with USB
hotplug (e.g. a device that re-enumerates, as some macro keypads do). For the
price check, it polls the clipboard so PoE (XWayland) copies are caught
reliably.

Everything comes from config.toml — nothing is hardcoded.
"""
import os
import sys
import time
import subprocess
import selectors
import tomllib
from pathlib import Path

import evdev
from evdev import ecodes as e

CONFIG_PATHS = [
    Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "poe-price-daemon" / "config.toml",
    Path.home() / ".config" / "poe-price-daemon" / "config.toml",
    Path(__file__).resolve().parent / "config.toml",
]

DEFAULT_CONFIG = (Path(__file__).resolve().parent / "config.example.toml")
RESCAN_INTERVAL = 2.0  # seconds between device rescans (hotplug)
CLIP_POLL_INTERVAL = 0.1  # seconds between clipboard polls (price check; xsel is ~4ms)


def load_config():
    for p in CONFIG_PATHS:
        if p.is_file():
            with open(p, "rb") as f:
                return tomllib.load(f), p
    # No config found -> copy the example to the first default path.
    dest = CONFIG_PATHS[0]
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(DEFAULT_CONFIG.read_text())
    print(f"[poe-price-daemon] Default config created: {dest} — adjust backend/user there.")
    with open(dest, "rb") as f:
        return tomllib.load(f), dest


def keycode(name):
    """evdev key name -> code. E.g. 'F24', 'DOT' (for '.'), 'KP1'."""
    return getattr(e, f"KEY_{name.upper()}")


def build_keymap(layout):
    """char -> (shift_needed, evdev KEY name). Kernel-injected keys are
    interpreted by KWin according to the active layout -> we must send the
    positional keys that produce the desired character under THIS layout."""
    m = {}
    for d in "0123456789":
        m[d] = (False, d)          # digits are the same on de/us
    m[" "] = (False, "SPACE")
    if layout == "de":
        for c in "abcdefghijklmnopqrstuvwx":
            m[c] = (False, c.upper())
        m["y"] = (False, "Z")      # y sits on the Z key
        m["z"] = (False, "Y")
        m["/"] = (True, "7")       # / = Shift+7
        m["-"] = (False, "SLASH")
        m["_"] = (True, "SLASH")
    else:  # us
        for c in "abcdefghijklmnopqrstuvwxyz":
            m[c] = (False, c.upper())
        m["/"] = (False, "SLASH")
        m["-"] = (False, "MINUS")
        m["_"] = (True, "MINUS")
    return m


class PriceDaemon:
    def __init__(self, cfg):
        self.poe_class = str(cfg["poe_window_class"]).lower()

        # Deprecated: 'key' used to bind the injected price-check trigger.
        # Price check is now clipboard-driven -> tolerate a leftover 'key' in
        # old configs (don't crash), just note it's unused.
        if cfg.get("key"):
            print("[poe-price-daemon] Note: 'key' in config.toml is deprecated and ignored — "
                  "price check now runs via clipboard watch (see README).", file=sys.stderr)

        sock = str(cfg.get("ydotool_socket") or "").strip()
        if not sock:
            sock = str(Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")) / ".ydotool_socket")
        self.socket = os.path.expanduser(sock)

        # poe-price-post.sh: fed the clipboard text on stdin by poll_clipboard()
        # -> filter for PoE items, de-dupe, POST.
        self.post_handler = str(Path(__file__).resolve().parent / "poe-price-post.sh")

        # Backend URL + user -> passed to poe-price-post.sh by poll_clipboard()
        # (it reads PPT_BACKEND_URL/PPT_USER).
        self.backend_url = str(cfg["backend_url"]).strip()
        self.user = str(cfg["user"]).strip()

        # Which clipboard contents count as a PoE item. The game writes the
        # item-class line in the CLIENT's language ("Item Class: " on English,
        # "Gegenstandsklasse: " on German), so this must not live in the code --
        # a second hardcoded line would be the same mistake again, in German.
        # A list, so one config can cover a client whose language is switched.
        prefixes = cfg.get("item_prefixes") or ["Item Class: "]
        if isinstance(prefixes, str):  # tolerate a single string in the config
            prefixes = [prefixes]
        self.item_prefixes = [str(p) for p in prefixes if str(p)]
        if not self.item_prefixes:
            raise SystemExit("[poe-price-daemon] item_prefixes is set but empty — "
                             "nothing would ever be posted")

        # Chat macros (optional): key -> chat command, e.g. F5 -> "/hideout".
        # No [macros] section in the config -> self.macros stays empty and the
        # daemon runs price-check only (graceful, no crash).
        macros_cfg = cfg.get("macros") or {}
        self.keyboard_layout = str(macros_cfg.get("keyboard_layout", "us"))
        self.chat_open_delay = macros_cfg.get("chat_open_delay_ms", 45) / 1000.0
        self.keystroke_delay = int(macros_cfg.get("keystroke_delay_ms", 12))
        self.keymap = build_keymap(self.keyboard_layout)
        self.macros = {keycode(k): v for k, v in (macros_cfg.get("keys") or {}).items()}

        self._focus_cache = (0.0, False)
        self._focus_warned = False
        self.last_clip = self._read_clipboard()  # baseline -> startup won't re-post
        self._posts = []  # in-flight POST subprocesses (non-blocking; reaped in poll)

    def is_poe_focused(self):
        now = time.monotonic()
        if now - self._focus_cache[0] < 0.25:  # cache briefly -> don't call xdotool on every event
            return self._focus_cache[1]
        res = False
        try:
            wid = subprocess.run(
                ["xdotool", "getwindowfocus"],
                capture_output=True, text=True, timeout=1,
            ).stdout.strip()
            if wid:
                cls = subprocess.run(
                    ["xprop", "-id", wid, "WM_CLASS"],
                    capture_output=True, text=True, timeout=1,
                ).stdout.lower()
                res = self.poe_class in cls
        except Exception as ex:
            if not self._focus_warned:
                print(f"[poe-price-daemon] Focus check failed ({ex}) — is xdotool/xprop present, is DISPLAY set?",
                      file=sys.stderr)
                self._focus_warned = True
            res = False
        self._focus_cache = (now, res)
        return res

    def ydo(self, *args):
        env = dict(os.environ)
        env["YDOTOOL_SOCKET"] = self.socket
        return subprocess.run(["ydotool", *args], env=env, capture_output=True, text=True)

    def do_type(self, text):
        """Types text layout-aware via ydotool (positional keycodes per layout)."""
        seq = []
        shift = str(e.KEY_LEFTSHIFT)
        for ch in text:
            entry = self.keymap.get(ch) or self.keymap.get(ch.lower())
            if entry is None:
                continue
            need_shift, keyname = entry
            code = getattr(e, f"KEY_{keyname}")
            if need_shift:
                seq.append(f"{shift}:1")
            seq += [f"{code}:1", f"{code}:0"]
            if need_shift:
                seq.append(f"{shift}:0")
        if seq:
            self.ydo("key", "--key-delay", str(self.keystroke_delay), *seq)

    def do_macro(self, cmd):
        self.ydo("key", "28:1", "28:0")  # Enter -> open chat
        time.sleep(self.chat_open_delay)
        self.do_type(cmd)
        time.sleep(self.chat_open_delay)
        self.ydo("key", "28:1", "28:0")  # Enter -> send

    def handle(self, ev):
        if ev.type != e.EV_KEY:
            return
        # Chat macros: fire on PRESS (value==1); macros trigger only while
        # PoE is focused (keeps macro keys inert everywhere else). Price
        # check does not use an input device — see poll_clipboard().
        if ev.value == 1 and ev.code in self.macros:
            if self.is_poe_focused():
                self.do_macro(self.macros[ev.code])
            return

    def _read_clipboard(self):
        """Read the current clipboard text, or None. Primary source is the X11
        CLIPBOARD via `xsel`: Path of Exile runs under XWayland (it's an X11
        app), so its Ctrl+Alt+C copies land in the X11 clipboard. Reading that
        DIRECTLY bypasses the flaky X11->Wayland clipboard bridge — on KWin that
        bridge stalls after a native Wayland app (e.g. a screenshot tool) takes
        the clipboard, and only re-syncs when something forces it (Klipper /
        Meta+V), which is what froze the price check. Needs DISPLAY (set for the
        XWayland session; the daemon inherits it). A non-text selection (image)
        offers no text target -> xsel returns empty -> skipped. Falls back to
        the native Wayland clipboard (`wl-paste`) if xsel/DISPLAY are absent."""
        try:
            r = subprocess.run(["xsel", "-b", "-o"],
                               capture_output=True, text=True, timeout=1)
            if r.returncode == 0 and r.stdout:
                return r.stdout
        except FileNotFoundError:
            pass  # xsel not installed -> fall back
        except Exception:
            return None
        # Fallback (non-XWayland setups): native Wayland clipboard, text only.
        try:
            r = subprocess.run(["wl-paste", "-n", "-t", "text/plain"],
                               capture_output=True, text=True, timeout=1)
            return r.stdout if (r.returncode == 0 and r.stdout) else None
        except Exception:
            return None

    def poll_clipboard(self):
        """Poll the clipboard; on a NEW value, hand it to poe-price-post.sh on
        stdin (filter for PoE items, de-dupe, POST). The POST runs as a
        NON-BLOCKING subprocess: a slow backend must never stall polling, or we
        miss the next copies (the clipboard only holds the latest value).
        Called every CLIP_POLL_INTERVAL from the main loop."""
        self._posts = [p for p in self._posts if p.poll() is None]  # reap finished
        content = self._read_clipboard()
        if not content or content == self.last_clip:
            return
        self.last_clip = content
        env = dict(os.environ)
        env["PPT_BACKEND_URL"] = self.backend_url
        env["PPT_USER"] = self.user
        # Newline-separated: prefixes contain spaces and colons, a newline is
        # the only separator an item-class line can never contain.
        env["PPT_ITEM_PREFIXES"] = "\n".join(self.item_prefixes)
        try:
            p = subprocess.Popen([self.post_handler], stdin=subprocess.PIPE, text=True, env=env)
            p.stdin.write(content)  # item text is small -> won't block; post.sh reads it at once
            p.stdin.close()
            self._posts.append(p)
        except Exception as ex:
            print(f"[poe-price-daemon] post handler failed: {ex}", file=sys.stderr)


def find_keyboards(keycodes):
    """Devices exposing a macro key (they may live on different physical
    keyboards, e.g. a hardware macro keypad plus the F5-F9 row). Only relevant
    for macros — without a [macros] section no device is opened."""
    kbs = []
    for path in evdev.list_devices():
        try:
            d = evdev.InputDevice(path)
        except Exception:
            continue
        if "ydotool" in d.name.lower():  # skip our own virtual device
            continue
        caps = d.capabilities().get(e.EV_KEY, [])
        if any(k in caps for k in keycodes):
            kbs.append(d)
        else:
            d.close()
    return kbs


def main():
    cfg, path = load_config()
    app = PriceDaemon(cfg)
    # price check: the clipboard is polled in the main loop (poll_clipboard).
    # Macro keys only: they may sit on different physical devices (e.g. a
    # macro keypad plus the F5-F9 row), all must be watched. Empty if no [macros].
    relevant_keys = set(app.macros.keys())
    sel = selectors.DefaultSelector()
    registered = {}  # path -> InputDevice

    def drop(dev):
        for fn in (lambda: sel.unregister(dev), dev.close):
            try:
                fn()
            except Exception:
                pass
        registered.pop(dev.path, None)
        print(f"[poe-price-daemon] Device unregistered: {dev.path}", file=sys.stderr, flush=True)

    def register_new():
        for d in find_keyboards(relevant_keys):
            if d.path in registered:
                d.close()  # already registered -> close duplicate
                continue
            registered[d.path] = d
            sel.register(d, selectors.EVENT_READ)
            print(f"[poe-price-daemon] Device registered: {d.name} ({d.path})", flush=True)

    def prune_dead():
        # Detect unplugged OR re-enumerated devices (the event node gets
        # reused -> the inode at the path changes, the old handle is dead).
        for p, dev in list(registered.items()):
            try:
                if os.stat(p).st_ino != os.fstat(dev.fileno()).st_ino:
                    drop(dev)
            except OSError:
                drop(dev)

    register_new()
    print(f"[poe-price-daemon] active. Config: {path}  Backend: {app.backend_url}  User: {app.user}")
    print(f"[poe-price-daemon] Price check: clipboard polling active (every {CLIP_POLL_INTERVAL}s)")
    if app.macros:
        print(f"[poe-price-daemon] Chat macros active ({app.keyboard_layout} layout): "
              + ", ".join(f"{k}" for k in cfg.get('macros', {}).get('keys', {})))
        if not registered:
            print("[poe-price-daemon] No matching keyboard found yet for macros — waiting for devices "
                  "(is the user in the 'input' group?).", file=sys.stderr)

    last_scan = time.monotonic()
    while True:
        for key, _ in sel.select(timeout=CLIP_POLL_INTERVAL):
            dev = key.fileobj
            try:
                for ev in dev.read():
                    app.handle(ev)
            except OSError:
                # Device disappeared (unplug / re-enumeration) -> unregister,
                # the rest keeps running. NO exit -> no systemd restart brick.
                drop(dev)
        app.poll_clipboard()  # price check: catch new clipboard items
        now = time.monotonic()
        if now - last_scan >= RESCAN_INTERVAL:
            last_scan = now
            prune_dead()
            register_new()


if __name__ == "__main__":
    main()
