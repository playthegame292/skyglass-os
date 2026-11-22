#!/usr/bin/env python3
"""Skyglass OS shell backend.

Pure Python standard library, no pip packages. Serves the web UI and a small
JSON API that talks to the hardware: Wi-Fi (NetworkManager), modem
(ModemManager), camera (rpicam-apps), the Pi 5 power button (evdev), the
display/backlight, terminals (pty), files and native Linux apps.

Listens on 127.0.0.1 only. Run it on a desktop for development:
    python3 server.py   ->  open http://127.0.0.1:7777
"""
import base64
import codecs
import configparser
import fcntl
import glob
import hashlib
import hmac
import json
import mimetypes
import random
import os
import pty
import re
import shlex
import signal
import socket
import struct
import subprocess
import termios
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = "1.0"
CODENAME = "Bubble"
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
HOME = os.path.expanduser("~")
PORT = int(os.environ.get("SKYGLASS_PORT", "7777"))
ON_DEVICE = os.path.exists("/etc/skyglass-release")
PICTURES = os.path.join(HOME, "Pictures", "Skyglass")
VIDEOS = os.path.join(HOME, "Videos", "Skyglass")


# --------------------------------------------------------------------------- helpers

PRIV = "/usr/local/sbin/skyglass-priv"


def priv(*args, timeout=30):
    """Root actions go through skyglass-priv: a fixed list of checked actions. It's the only thing
    that still runs without a password when sudo is set to ask for one (Settings › Developer)."""
    return run(["sudo", "-n", PRIV] + [str(a) for a in args], timeout=timeout)


def run(cmd, timeout=10, input=None):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=input)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired) as e:
        return 127, "", str(e)


def have(binary):
    return any(os.access(os.path.join(p, binary), os.X_OK) for p in os.environ.get("PATH", "").split(":"))


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def nm_split(line):
    """Split one `nmcli -t` line (colons escaped as \\:)."""
    return [p.replace("\\:", ":") for p in re.split(r"(?<!\\):", line)]


# --------------------------------------------------------------------------- events

class Events:
    """Tiny pub/sub that the UI long-polls (power button, app exit, ...)."""

    def __init__(self):
        self.cond = threading.Condition()
        self.items = []
        self.next_id = 1

    def emit(self, kind, **data):
        with self.cond:
            self.items.append({"id": self.next_id, "type": kind, **data})
            self.next_id += 1
            self.items = self.items[-50:]
            self.cond.notify_all()

    def wait(self, since, timeout=25):
        end = time.time() + timeout
        with self.cond:
            if since > self.next_id - 1:  # client is new (or the backend restarted): sync it up
                return [], self.next_id - 1
            while True:
                new = [e for e in self.items if e["id"] > since]
                if new:
                    return new, self.next_id - 1
                left = end - time.time()
                if left <= 0:
                    return [], max(since, self.next_id - 1)
                self.cond.wait(left)


EVENTS = Events()


# --------------------------------------------------------------------------- system info

_status_cache = {"t": 0, "data": None}


def battery():
    for ps in sorted(glob.glob("/sys/class/power_supply/*")):
        if read(ps + "/type") == "Battery":
            cap = read(ps + "/capacity", "")
            st = read(ps + "/status", "")
            return {"present": True, "percent": int(cap) if cap.isdigit() else None,
                    "charging": st in ("Charging", "Full")}
    return {"present": False, "percent": None, "charging": True}


def wifi_now():
    if not have("nmcli"):
        return {"available": False}
    code, out, _ = run(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "dev", "wifi"], timeout=4)
    if code != 0:
        return {"available": False}
    for line in out.splitlines():
        parts = nm_split(line)
        if len(parts) >= 3 and parts[0] == "yes":
            return {"available": True, "connected": True, "ssid": parts[1],
                    "signal": int(parts[2]) if parts[2].isdigit() else 0}
    return {"available": True, "connected": False}


_modem_cache = {"t": 0, "has": False}


def status():
    # Battery is a sysfs read (free). Wi-Fi and modem need nmcli/mmcli processes, so they are
    # cached: 15 s for Wi-Fi (connecting resets it), 60 s for "is a modem plugged in".
    now = time.time()
    if _status_cache["data"] and now - _status_cache["t"] < 15:
        d = dict(_status_cache["data"])
    else:
        if now - _modem_cache["t"] > 60:
            _modem_cache.update(t=now, has=modem_index() is not None)
        d = {"wifi": wifi_now(), "modem": _modem_cache["has"]}
        _status_cache.update(t=now, data=d)
        d = dict(d)
    d["battery"] = battery()
    d["native"] = any(p.poll() is None for p in APPS.stack)
    d["time"] = now
    return d


def cpu_temp():
    t = read("/sys/class/thermal/thermal_zone0/temp")
    return round(int(t) / 1000, 1) if t and t.isdigit() else None


def about():
    mem = {}
    for line in (read("/proc/meminfo", "") or "").splitlines():
        k, _, v = line.partition(":")
        mem[k] = int(v.split()[0]) if v.split() else 0
    st = os.statvfs("/")
    serial = ""
    for line in (read("/proc/cpuinfo", "") or "").splitlines():
        if line.lower().startswith("serial"):
            serial = line.split(":")[-1].strip()
    model = read("/proc/device-tree/model", "") or os.uname().machine
    mac = read("/sys/class/net/wlan0/address") or read("/sys/class/net/eth0/address") or "unknown"
    return {
        "os": f"Skyglass OS {VERSION} “{CODENAME}”",
        "base": (read("/etc/debian_version") and "Debian " + read("/etc/debian_version")) or "dev host",
        "model": model.replace("\x00", ""),
        "kernel": os.uname().release,
        "hostname": os.uname().nodename,
        "uptime": float((read("/proc/uptime", "0") or "0").split()[0]),
        "mem_total_mb": mem.get("MemTotal", 0) // 1024,
        "mem_free_mb": mem.get("MemAvailable", 0) // 1024,
        "disk_total_gb": round(st.f_blocks * st.f_frsize / 1e9, 1),
        "disk_free_gb": round(st.f_bavail * st.f_frsize / 1e9, 1),
        "cpu_temp": cpu_temp(),
        "serial": serial or "0000000000000000",
        "mac": mac,
        "on_device": ON_DEVICE,
        "sudo": run(["sudo", "-n", "true"], timeout=3)[0] == 0,
        "display": read("/etc/skyglass/display.conf", ""),
    }


# --------------------------------------------------------------------------- wifi

def wifi_scan():
    if not have("nmcli"):
        return {"error": "NetworkManager (nmcli) not installed", "networks": []}
    run(["nmcli", "dev", "wifi", "rescan"], timeout=8)
    code, out, err = run(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "dev", "wifi", "list"], timeout=8)
    nets = {}
    for line in out.splitlines():
        p = nm_split(line)
        if len(p) < 4 or not p[1]:
            continue
        sig = int(p[2]) if p[2].isdigit() else 0
        if p[1] not in nets or nets[p[1]]["signal"] < sig:
            nets[p[1]] = {"ssid": p[1], "signal": sig, "secure": p[3] not in ("", "--"),
                          "active": p[0] == "*"}
    return {"networks": sorted(nets.values(), key=lambda n: (-n["active"], -n["signal"]))}


def wifi_connect(ssid, password=None):
    cmd = ["nmcli", "dev", "wifi", "connect", ssid]
    if password:
        cmd += ["password", password]
    code, out, err = run(cmd, timeout=40)
    _status_cache["t"] = 0
    return {"ok": code == 0, "message": out or err}


# --------------------------------------------------------------------------- modem (ModemManager)

def modem_index():
    if not have("mmcli"):
        return None
    code, out, _ = run(["mmcli", "-L", "-J"], timeout=4)
    try:
        lst = json.loads(out).get("modem-list", [])
    except ValueError:
        return None
    return lst[0].rsplit("/", 1)[-1] if lst else None


def modem_call(number):
    m = modem_index()
    if m is None:
        return {"ok": False, "message": "No modem found. Plug in a 4G HAT (e.g. SIM7600) to make real calls."}
    number = re.sub(r"[^0-9+*#]", "", number)
    code, out, err = run(["mmcli", "-m", m, f"--voice-create-call=number={number}"])
    match = re.search(r"/Call/(\d+)", out)
    if not match:
        return {"ok": False, "message": err or out}
    call = match.group(1)
    code, out, err = run(["mmcli", "-m", m, "-o", call, "--start"])
    return {"ok": code == 0, "call": call, "message": err}


def modem_hangup(call):
    m = modem_index()
    if m is None:
        return {"ok": True}
    run(["mmcli", "-m", m, "-o", str(call), "--hangup"])
    return {"ok": True}


def sms_list():
    m = modem_index()
    if m is None:
        return {"modem": False, "messages": []}
    code, out, _ = run(["mmcli", "-m", m, "--messaging-list-sms", "-J"])
    msgs = []
    try:
        paths = json.loads(out).get("modem.messaging.sms", [])
    except ValueError:
        paths = []
    for p in paths:
        code, o, _ = run(["mmcli", "-s", p.rsplit("/", 1)[-1], "-J"])
        try:
            s = json.loads(o)["sms"]
            msgs.append({"number": s["content"]["number"], "text": s["content"]["text"],
                         "time": s["properties"].get("timestamp", ""),
                         "out": s["properties"].get("pdu-type") == "submit"})
        except (ValueError, KeyError):
            pass
    return {"modem": True, "messages": msgs}


def sms_send(number, text):
    m = modem_index()
    if m is None:
        return {"ok": False, "message": "No modem found."}
    number = re.sub(r"[^0-9+]", "", number)
    text = text.replace("'", "’").replace("\\", "/")
    code, out, err = run(["mmcli", "-m", m, f"--messaging-create-sms=text='{text}',number='{number}'"])
    match = re.search(r"/SMS/(\d+)", out)
    if not match:
        return {"ok": False, "message": err or out}
    code, out, err = run(["mmcli", "-s", match.group(1), "--send"], timeout=30)
    return {"ok": code == 0, "message": err}


# --------------------------------------------------------------------------- PIN lock

PIN_FILE = os.path.join(HOME, ".config", "skyglass", "pin.json")
PIN_ITER = 200_000
FAIL_FILE = os.path.join(HOME, ".config", "skyglass", "pin-fail.json")
try:  # lockout survives a reboot, so power-cycling doesn't buy extra guesses
    with open(FAIL_FILE) as _f:
        _saved = json.load(_f)
    _pin_fail = {"count": int(_saved["count"]), "until": float(_saved["until"])}
except (OSError, ValueError, KeyError):
    _pin_fail = {"count": 0, "until": 0.0}


def _save_fail():
    try:
        os.makedirs(os.path.dirname(FAIL_FILE), exist_ok=True)
        with open(FAIL_FILE, "w") as f:
            json.dump(_pin_fail, f)
    except OSError:
        pass


def pin_load():
    try:
        with open(PIN_FILE) as f:
            d = json.load(f)
        if isinstance(d, dict) and d.get("hash") and d.get("salt"):
            return d
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        pass
    if os.path.exists(PIN_FILE):
        # A damaged PIN file must keep the phone locked (no PIN matches), never unlock it.
        # Reset it from a keyboard or SSH: skyglass-pin reset
        print("pin.json is damaged: the phone stays locked until skyglass-pin reset", flush=True)
        return {"salt": "00", "hash": "-", "damaged": True}   # no PBKDF2 output ever equals "-"
    return None


def pin_hash(pin, salt, iters=PIN_ITER):
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), iters).hex()


def pin_valid_format(pin):
    return isinstance(pin, str) and pin.isdigit() and 4 <= len(pin) <= 8


def pin_check(pin):
    """Verify with a growing lockout after 5 wrong tries (30 s, 60 s, 120 s ... max 15 min)."""
    now = time.time()
    if now < _pin_fail["until"]:
        return {"ok": False, "locked_for": round(_pin_fail["until"] - now)}
    d = pin_load()
    if not d:
        return {"ok": True}
    good = isinstance(pin, str) and hmac.compare_digest(pin_hash(pin, d["salt"], d.get("iter", PIN_ITER)), d["hash"])
    if good:
        _pin_fail.update(count=0, until=0.0)
        _save_fail()
        return {"ok": True}
    _pin_fail["count"] += 1
    _save_fail()
    left = max(0, 5 - _pin_fail["count"])
    if _pin_fail["count"] >= 5:
        _pin_fail["until"] = now + min(900, 30 * 2 ** (_pin_fail["count"] - 5))
        _save_fail()
        return {"ok": False, "locked_for": round(_pin_fail["until"] - now)}
    return {"ok": False, "tries_left": left}


def pin_set(old, new):
    if pin_load():
        r = pin_check(old)
        if not r["ok"]:
            return {**r, "message": "Current PIN is wrong"}
    if new is None:
        try:
            os.remove(PIN_FILE)
        except OSError:
            pass
        return {"ok": True}
    if not pin_valid_format(new):
        return {"ok": False, "message": "PIN must be 4 to 8 digits"}
    salt = os.urandom(16).hex()
    os.makedirs(os.path.dirname(PIN_FILE), exist_ok=True)
    tmp = PIN_FILE + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump({"salt": salt, "hash": pin_hash(new, salt), "iter": PIN_ITER}, f)
    os.replace(tmp, PIN_FILE)
    return {"ok": True}


# --------------------------------------------------------------------------- display / sound / power

def backlight():
    for bl in glob.glob("/sys/class/backlight/*"):
        mx = int(read(bl + "/max_brightness", "0") or 0)
        cur = int(read(bl + "/brightness", "0") or 0)
        if mx:
            return bl, mx, cur
    return None, 0, 0


def set_brightness(pct):
    bl, mx, _ = backlight()
    if not bl:
        return {"hw": False}  # HDMI panel: the UI dims in software instead
    val = max(1, round(mx * pct / 100))
    priv("backlight", val)
    return {"hw": True}


def set_volume(pct):
    pct = max(0, min(100, int(pct)))
    if have("wpctl"):
        run(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", f"{pct}%"])
    elif have("amixer"):
        run(["amixer", "-q", "sset", "Master", f"{pct}%"])
    return {"ok": True}


UI_PID = int(os.environ.get("SKYGLASS_UI_PID", "0") or 0)
COMPOSITORS = ("labwc", "cage")
# labwc: apps open maximized and the squeekboard keyboard pushes them up (see skyglass-session)
LABWC = os.environ.get("SKYGLASS_COMPOSITOR") == "labwc"


def restart_session(delay=0.8):
    """Restart the whole UI: stop the compositor (labwc or cage, and with it the kiosk browser).
    skyglass-session notices it exited and starts everything fresh. Killing only the browser
    is not enough: a compositor can keep running with a dead client and a frozen screen."""
    def go():
        uid = str(os.getuid())
        for comp in COMPOSITORS:
            run(["pkill", "-TERM", "-u", uid, "-x", comp])
        time.sleep(4)
        for comp in COMPOSITORS:                                   # still there? it's hung
            run(["pkill", "-KILL", "-u", uid, "-x", comp])
        run(["pkill", "-KILL", "-u", uid, "-f", "chromium.*127.0.0.1:7777"])
    threading.Timer(delay, go).start()


# --------------------------------------------------------------------------- UI watchdog
# The UI pings /api/heartbeat every 5 s. If it stops (frozen page, crashed renderer, blank
# screen) while no Linux app is in front, restart the whole UI. Self-healing.

HEARTBEAT = {"last": 0.0, "started": time.time()}


# --------------------------------------------------------------------------- RGB LED
# skyglass-ledd (a root service) owns the LED pins; we just send it commands over its socket.

LED_SOCK = os.environ.get("SKYGLASS_LED_SOCK", "/run/skyglass-led/led.sock")
LED_LAYERS = ("flashlight", "party", "notify", "egg", "test")    # what the UI may set or clear


def led(cmd, timeout=2):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(LED_SOCK)
        s.sendall((json.dumps(cmd) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
        return json.loads(data or b"{}")
    except (OSError, ValueError):
        return {"ok": False, "offline": True, "message": "LED service not running"}
    finally:
        s.close()


def led_api(b):
    """POST /api/led from the UI: {"cmd": "set"|"clear"|"beat"|"prefs"|"test", ...}."""
    c = str(b.get("cmd", ""))
    if c in ("set", "clear"):
        layer = str(b.get("layer", ""))
        if layer not in LED_LAYERS and not (c == "clear" and layer.startswith("alert:")):
            return {"ok": False, "message": "not allowed"}
        keep = ("layer", "effect", "color", "speed", "brightness", "ttl")
        return led({"cmd": c, **{k: b[k] for k in keep if k in b}})
    if c == "beat":
        return led({"cmd": "beat", "level": b.get("level", 0)}, timeout=0.5)
    if c == "prefs":
        return led({"cmd": "prefs", "prefs": b.get("prefs") or {}})
    if c == "test":
        return led({"cmd": "test"})
    return {"ok": False, "message": "unknown command"}


def ui_watchdog_thread():
    if not (ON_DEVICE and UI_PID):
        return
    while True:
        time.sleep(10)
        native = any(p.poll() is None for p in APPS.stack)
        now = time.time()
        never = HEARTBEAT["last"] == 0 and now - HEARTBEAT["started"] > 90
        stale = HEARTBEAT["last"] and now - HEARTBEAT["last"] > 45
        if (never or stale) and not native:
            print(f"[watchdog] UI unresponsive (never={never}), restarting it", flush=True)
            led({"cmd": "set", "layer": "alert:ui", "effect": "blink-fast", "color": "red", "ttl": 30, "severity": 1})
            HEARTBEAT.update(last=0.0, started=now + 60)
            restart_session(0)


def power(action):
    if not ON_DEVICE:
        return {"ok": False, "message": f"dev mode: would {action}"}
    if action == "restart-shell":
        restart_session()
        return {"ok": True}
    what = {"reboot": "reboot", "shutdown": "poweroff"}.get(action)
    if not what:
        return {"ok": False}
    threading.Timer(0.8, lambda: priv("power", what)).start()
    return {"ok": True}


def screen(on):
    """Screen sleep that really saves power: the panel's backlight is switched off (bl_power) and,
    with wlopm, the display output too. Before, without wlopm, "off" was only a black overlay with
    the backlight still lit. The UI blacks out as well either way."""
    hw = False
    if on and have("wlopm"):
        run(["wlopm", "--on", "*"])
        hw = True
    bl, _, _ = backlight()
    if bl and os.path.exists(bl + "/bl_power"):
        priv("bl-power", "0" if on else "4")   # 4 = FB_BLANK_POWERDOWN
        hw = True
    if not on and have("wlopm"):
        run(["wlopm", "--off", "*"])
        hw = True
    return {"hw": hw}


ROT_PENDING = os.path.join(HOME, ".cache", "skyglass", "rotate-pending.json")
ROT_GRACE = 30  # seconds to press "Keep" after a rotation, or it goes back by itself


def current_rotation():
    m = re.search(r"^ROTATION=(\d+)", read("/etc/skyglass/display.conf", "") or "", re.M)
    return int(m.group(1)) if m else 0


def rotate(deg, confirm=True):
    deg = int(deg)
    if deg not in (0, 90, 180, 270):
        return {"ok": False}
    prev = current_rotation()
    code, out, err = priv("rotate", deg)
    if code == 0 and confirm and deg != prev:
        # like a PC monitor: if nobody confirms (touch broken, can't see) it reverts on its own
        os.makedirs(os.path.dirname(ROT_PENDING), exist_ok=True)
        with open(ROT_PENDING, "w") as f:
            json.dump({"prev": prev, "deg": deg, "deadline": time.time() + ROT_GRACE}, f)
    if code == 0 and ON_DEVICE:
        # touch calibration only re-applies when the compositor restarts
        restart_session()
    return {"ok": code == 0, "message": err or out}


def rotate_pending():
    try:
        with open(ROT_PENDING) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def rotate_watch_thread():
    while True:
        time.sleep(1 if os.path.exists(ROT_PENDING) else 3)
        p = rotate_pending()
        if p and time.time() > p.get("deadline", 0):
            try:
                os.remove(ROT_PENDING)
            except OSError:
                pass
            print(f"rotation {p.get('deg')} not confirmed: going back to {p.get('prev')}", flush=True)
            rotate(p.get("prev", 0), confirm=False)


# --------------------------------------------------------------------------- power button "driver"

KEY_POWER = 116
EV_KEY = 1
EVENT_FMT = "llHHi"
EVENT_SIZE = struct.calcsize(EVENT_FMT)


def power_button_thread():
    """Pi 5 power button -> short press: home/lock, long press: power menu."""
    dev = None
    for d in glob.glob("/sys/class/input/event*"):
        if read(d + "/device/name") in ("pwr_button", "gpio-keys", "skyglass-keys"):
            dev = "/dev/input/" + os.path.basename(d)
    if not dev:
        return
    try:
        f = open(dev, "rb")
    except OSError:
        return
    pressed = 0.0
    while True:
        data = f.read(EVENT_SIZE)
        if len(data) < EVENT_SIZE:
            return
        _, _, etype, code, value = struct.unpack(EVENT_FMT, data)
        if etype != EV_KEY or code != KEY_POWER:
            continue
        if value == 1:
            pressed = time.time()
        elif value == 0 and pressed:
            held = time.time() - pressed
            pressed = 0
            if held > 1.2:
                EVENTS.emit("power-long")
            elif APPS.close_top():
                EVENTS.emit("home")
            else:
                EVENTS.emit("power-short")


# --------------------------------------------------------------------------- touch calibration
# Reads the touchscreen's RAW coordinates straight from evdev (so it works even when the
# current calibration is wrong), then fits the libinput calibration matrix from 5 taps.

ABS_X, ABS_Y, ABS_MT_X, ABS_MT_Y, BTN_TOUCH, EV_ABS = 0x00, 0x01, 0x35, 0x36, 330, 3


def touch_device():
    for d in sorted(glob.glob("/sys/class/input/event*")):
        dev = read(d + "/dev", "")
        if read(f"/run/udev/data/c{dev}", "") and "E:ID_INPUT_TOUCHSCREEN=1" in read(f"/run/udev/data/c{dev}", ""):
            return "/dev/input/" + os.path.basename(d)
    return None


def abs_range(fd, code):
    buf = bytearray(24)
    fcntl.ioctl(fd, 0x80184540 + code, buf)  # EVIOCGABS(code) -> struct input_absinfo
    _, lo, hi, _, _, _ = struct.unpack("6i", buf)
    return lo, hi


class TouchCalibrator:
    def __init__(self):
        self.samples, self.active, self.dev, self.lock = [], False, None, threading.Lock()

    def start(self):
        self.dev = touch_device()
        if not self.dev:
            return {"ok": False, "message": "No touchscreen found"}
        with self.lock:
            self.samples = []
            if self.active:
                return {"ok": True, "device": self.dev}
            self.active = True
        threading.Thread(target=self._read, daemon=True).start()
        return {"ok": True, "device": self.dev}

    def _read(self):
        import select
        try:
            fd = os.open(self.dev, os.O_RDONLY | os.O_NONBLOCK)  # unbuffered: no event is ever held back
            xr, yr = abs_range(fd, ABS_X), abs_range(fd, ABS_Y)
        except OSError:
            self.active = False
            return
        x = y = None
        down_at = 0.0
        stop = time.time() + 180  # give up after 3 minutes
        try:
            while self.active and time.time() < stop:
                if not select.select([fd], [], [], 0.5)[0]:
                    continue
                try:
                    data = os.read(fd, EVENT_SIZE * 64)
                except BlockingIOError:
                    continue
                for off in range(0, len(data) - EVENT_SIZE + 1, EVENT_SIZE):
                    _, _, etype, code, value = struct.unpack_from(EVENT_FMT, data, off)
                    if etype == EV_ABS and code in (ABS_X, ABS_MT_X):
                        x = (value - xr[0]) / max(1, xr[1] - xr[0])
                    elif etype == EV_ABS and code in (ABS_Y, ABS_MT_Y):
                        y = (value - yr[0]) / max(1, yr[1] - yr[0])
                    elif etype == EV_KEY and code == BTN_TOUCH and value == 1:
                        down_at = time.time()
                    elif etype == EV_KEY and code == BTN_TOUCH and value == 0 and x is not None:
                        if time.time() - down_at < 2.5:  # ignore long drags/holds
                            with self.lock:
                                self.samples.append([round(x, 5), round(y, 5)])
        finally:
            os.close(fd)
            self.active = False

    def finish(self, points):
        """points: [[screen_x, screen_y, raw_x, raw_y], ...] all normalised 0..1."""
        self.active = False
        if len(points) < 3:
            return {"ok": False, "message": "need at least 3 taps"}
        # least squares for  sx = a*rx + b*ry + c,  sy = d*rx + e*ry + f
        def solve(target):
            A = [[0.0] * 3 for _ in range(3)]
            v = [0.0] * 3
            for p in points:
                row = (p[2], p[3], 1.0)
                for i in range(3):
                    v[i] += row[i] * p[target]
                    for j in range(3):
                        A[i][j] += row[i] * row[j]
            for i in range(3):  # Gauss-Jordan
                piv = max(range(i, 3), key=lambda k: abs(A[k][i]))
                A[i], A[piv], v[i], v[piv] = A[piv], A[i], v[piv], v[i]
                if abs(A[i][i]) < 1e-9:
                    raise ValueError("taps too close together")
                for k in range(3):
                    if k != i:
                        m = A[k][i] / A[i][i]
                        A[k] = [A[k][j] - m * A[i][j] for j in range(3)]
                        v[k] -= m * v[i]
            return [v[i] / A[i][i] for i in range(3)]
        try:
            a, b, c = solve(0)
            d, e, f = solve(1)
        except ValueError as err:
            return {"ok": False, "message": str(err)}
        def worst(m):
            a_, b_, c_, d_, e_, f_ = m
            return max(abs(a_ * p[2] + b_ * p[3] + c_ - p[0]) + abs(d_ * p[2] + e_ * p[3] + f_ - p[1]) for p in points)
        # the 8 ways a panel can be rotated/mirrored; real panels are almost always exactly one of these
        STANDARD = [(1, 0, 0, 0, 1, 0), (0, 1, 0, -1, 0, 1), (-1, 0, 1, 0, -1, 1), (0, -1, 1, 1, 0, 0),
                    (-1, 0, 1, 0, 1, 0), (1, 0, 0, 0, -1, 1), (0, 1, 0, 1, 0, 0), (0, -1, 1, -1, 0, 1)]
        fitted = (a, b, c, d, e, f)
        best = min(STANDARD, key=worst)
        if worst(best) < 0.25 and worst(best) <= worst(fitted) + 0.06:
            chosen, err = best, worst(best)       # clean orientation, immune to a sloppy tap
        elif worst(fitted) <= 0.08:
            chosen, err = fitted, worst(fitted)   # odd panel: use the precise fit
        else:
            return {"ok": False, "message": "Taps didn't line up — try once more, tapping the centre of each cross", "error": round(worst(fitted), 3)}
        matrix = " ".join(f"{v:.4f}" for v in chosen)
        code, out, errtxt = priv("touch-matrix", matrix)
        if code != 0:
            return {"ok": False, "message": errtxt or out or "could not save"}
        if ON_DEVICE:
            restart_session(2.5)  # libinput only reads the matrix when the compositor starts
        return {"ok": True, "matrix": matrix, "error": round(err, 4)}


CALIB = TouchCalibrator()


# --------------------------------------------------------------------------- Sky Search
# Suggestions and instant answers come from DuckDuckGo's public endpoints; full web
# results open the real duckduckgo.com in the browser (with the Aero skin + nav bar).

def ddg_get(url, timeout=6):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "SkyglassOS/1.0 (Sky Search)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(2_000_000).decode("utf-8", "replace"))


def sky_suggest(q):
    from urllib.parse import quote
    q = (q or "").strip()[:200]
    if not q:
        return {"suggestions": []}
    try:
        d = ddg_get("https://duckduckgo.com/ac/?type=list&q=" + quote(q), timeout=4)
        return {"suggestions": [str(x) for x in (d[1] if isinstance(d, list) and len(d) > 1 else [])][:8]}
    except Exception as e:  # offline etc.
        return {"suggestions": [], "error": str(e)}


def sky_answer(q):
    from urllib.parse import quote
    q = (q or "").strip()[:300]
    if not q:
        return {"ok": False}
    try:
        d = ddg_get("https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&t=skyglass&q=" + quote(q))
    except Exception as e:
        return {"ok": False, "offline": True, "error": str(e)}
    related = []
    def walk(items):
        for it in items or []:
            if "Topics" in it:
                walk(it["Topics"])
            elif it.get("Text") and it.get("FirstURL", "").startswith("https://"):
                related.append({"text": it["Text"], "url": it["FirstURL"]})
    walk(d.get("RelatedTopics"))
    img = d.get("Image") or ""
    if img.startswith("/"):
        img = "https://duckduckgo.com" + img
    return {"ok": True, "heading": d.get("Heading", ""), "abstract": d.get("AbstractText", ""),
            "source": d.get("AbstractSource", ""), "url": d.get("AbstractURL", ""),
            "answer": str(d.get("Answer", "") or ""), "definition": d.get("Definition", ""),
            "image": img if img.startswith("https://") else "", "related": related[:8]}


# --------------------------------------------------------------------------- native Linux apps

class NativeApps:
    def __init__(self):
        self.stack = []  # running Popen objects, newest last
        self.lock = threading.Lock()

    def list(self):
        apps = []
        seen = set()
        for path in sorted(glob.glob("/usr/share/applications/*.desktop") +
                           glob.glob(HOME + "/.local/share/applications/*.desktop")):
            cp = configparser.RawConfigParser(strict=False, interpolation=None)
            try:
                cp.read(path, encoding="utf-8")
                e = cp["Desktop Entry"]
            except Exception:
                continue
            if e.get("Type") != "Application" or e.get("NoDisplay", "false") == "true" \
                    or e.get("Terminal", "false") == "true" or "Exec" not in e:
                continue
            name = e.get("Name", os.path.basename(path))
            if name in seen:
                continue
            seen.add(name)
            apps.append({"id": os.path.basename(path), "name": name, "icon": e.get("Icon", ""),
                         "comment": e.get("Comment", "")})
        return apps

    def launch(self, app_id=None, argv=None):
        if app_id:
            path = None
            for base in ("/usr/share/applications", HOME + "/.local/share/applications"):
                if os.path.exists(os.path.join(base, app_id)) and "/" not in app_id:
                    path = os.path.join(base, app_id)
            if not path:
                return {"ok": False, "message": "unknown app"}
            cp = configparser.RawConfigParser(strict=False, interpolation=None)
            cp.read(path, encoding="utf-8")
            argv = [a for a in shlex.split(cp["Desktop Entry"]["Exec"]) if not re.fullmatch(r"%[a-zA-Z]", a)]
            # Android apps (Waydroid's .desktop files): start the container only while in use
            if argv[:1] == ["waydroid"] and have("skyglass-android"):
                pkg = argv[3] if argv[1:3] == ["app", "launch"] and len(argv) > 3 else ""
                argv = ["skyglass-android", "open"] + ([pkg] if pkg else [])
        try:
            p = subprocess.Popen(argv, start_new_session=True, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, cwd=HOME)
        except OSError as e:
            return {"ok": False, "message": str(e)}
        with self.lock:
            self.stack.append(p)
        threading.Thread(target=self._watch, args=(p,), daemon=True).start()
        return {"ok": True}

    def _watch(self, p):
        p.wait()
        with self.lock:
            if p in self.stack:
                self.stack.remove(p)
        EVENTS.emit("app-exit")

    def close_top(self):
        with self.lock:
            live = [p for p in self.stack if p.poll() is None]
            if not live:
                return False
            p = live[-1]
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except OSError:
            pass
        return True


APPS = NativeApps()
BROWSER = {"proc": None}
BROWSER_EXT = "/usr/lib/skyglass/browser-ext"


def browser_close():
    p = BROWSER["proc"]
    BROWSER["proc"] = None
    if not p or p.poll() is not None:
        return False
    try:
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
    run(["pkill", "-u", str(os.getuid()), "-x", "gcr-prompter"])  # stray keyring popups
    return True


def browser_open(url):
    """The full web browser: one Chromium window at a time, with the Skyglass nav bar
    (Close / Home / Back) injected by a built-in extension."""
    browser_close()
    prof = os.path.join(HOME, ".local/share/skyglass/browser")
    # the real binary: the Raspberry Pi OS wrapper forces renderer accessibility (costly) on every page
    exe = "/usr/lib/chromium/chromium" if os.access("/usr/lib/chromium/chromium", os.X_OK) else "chromium"
    argv = [exe, "--ozone-platform=wayland", "--use-angle=gles", "--disable-renderer-accessibility",
            "--disable-component-update", "--no-pings", "--disable-domain-reliability",
            f"--user-data-dir={prof}", "--no-first-run",
            "--no-default-browser-check", "--touch-events=enabled",
            "--password-store=basic",  # no "choose a keyring password" popup
            "--disk-cache-size=67108864",  # 64 MB cache cap
            "--noerrdialogs", "--disable-session-crashed-bubble", "--disable-infobars",
            "--check-for-update-interval=31536000", "--ignore-gpu-blocklist",
            "--disable-features=DisableLoadExtensionCommandLineSwitch,TranslateUI,MediaRouter"]
    if LABWC:
        # maximized, not fullscreen, so the on-screen keyboard can push the page up instead of
        # covering it; the Wayland IME flags make text fields pop squeekboard up (text-input v3)
        argv += ["--start-maximized", "--enable-wayland-ime", "--wayland-text-input-version=3"]
    else:
        argv.append("--start-fullscreen")
    ext = os.environ.get("SKYGLASS_BROWSER_EXT", BROWSER_EXT)
    if os.path.isfile(os.path.join(ext, "manifest.json")):
        argv.append(f"--load-extension={ext}")
    # phone-sized pages: ask websites for their mobile layout
    ver = (re.search(r"(\d+)\.", run(["chromium", "--version"])[1] or "") or [None, "140"])[1]
    argv.append(f"--user-agent=Mozilla/5.0 (Linux; Android 14; Skyglass Phone) AppleWebKit/537.36 "
                f"(KHTML, like Gecko) Chrome/{ver}.0.0.0 Mobile Safari/537.36")
    r = APPS.launch(argv=argv + [url])
    if r.get("ok"):
        with APPS.lock:
            BROWSER["proc"] = APPS.stack[-1] if APPS.stack else None
    return r


# --------------------------------------------------------------------------- notifications
# One list for the whole phone: SMS, battery, updates, Android, and any Linux app (through
# skyglass-notifyd, the org.freedesktop.Notifications bridge) or script (skyglass-notify).
# Kept on disk so they survive a restart. The UI decides what to show (Do Not Disturb, lock screen).

NOTIF_FILE = os.path.join(HOME, ".config", "skyglass", "notifications.json")
NOTIF_MAX = 100


class Notifications:
    def __init__(self):
        self.lock = threading.Lock()
        self.items = []
        self.next_id = 1
        try:
            with open(NOTIF_FILE) as f:
                d = json.load(f)
            self.items = [n for n in d.get("items", []) if isinstance(n, dict) and "id" in n][-NOTIF_MAX:]
            self.next_id = max([int(n["id"]) for n in self.items] + [0]) + 1
        except (OSError, ValueError, TypeError):
            pass

    def _save(self):
        try:
            os.makedirs(os.path.dirname(NOTIF_FILE), exist_ok=True)
            tmp = NOTIF_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"items": self.items}, f)
            os.replace(tmp, NOTIF_FILE)
        except OSError:
            pass

    def add(self, app, title, body="", icon="", open_app="", key="", urgency="normal"):
        clean = lambda v, n: re.sub(r"<[^>]*>", "", str(v or ""))[:n]   # notify-send bodies may carry markup
        n = {"app": clean(app, 40) or "System", "title": clean(title, 120), "body": clean(body, 600),
             "icon": clean(icon, 200), "open": clean(open_app, 40), "key": clean(key, 80),
             "urgency": urgency if urgency in ("low", "normal", "critical") else "normal",
             "time": int(time.time()), "read": False}
        if not n["title"] and not n["body"]:
            return None
        with self.lock:
            if n["key"]:   # replaces the older one with the same key (battery level, update count…)
                self.items = [x for x in self.items if x.get("key") != n["key"]]
            n["id"] = self.next_id
            self.next_id += 1
            self.items = (self.items + [n])[-NOTIF_MAX:]
            self._save()
        EVENTS.emit("notify", n=n)
        return n

    def list(self):
        with self.lock:
            items = list(reversed(self.items))
        return {"items": items, "unread": sum(1 for n in items if not n.get("read"))}

    def dismiss(self, nid=None, app=None):
        with self.lock:
            before = len(self.items)
            if nid is not None:
                self.items = [x for x in self.items if x.get("id") != nid]
            elif app:
                self.items = [x for x in self.items if x.get("app") != app]
            else:
                self.items = []
            gone = before - len(self.items)
            self._save()
        EVENTS.emit("notify-dismiss")
        return {"ok": True, "dismissed": gone}

    def mark_read(self):
        with self.lock:
            for n in self.items:
                n["read"] = True
            self._save()
        return {"ok": True}


NOTIFS = Notifications()


def notify(app, title, body="", **kw):
    return NOTIFS.add(app, title, body, **kw)


def battery_watch_thread():
    """Low battery at 20 / 10 / 5 %, and "fully charged", once each."""
    warned, full_said = 101, False
    while True:
        b = battery()
        if b.get("present") and isinstance(b.get("percent"), int):
            pct = b["percent"]
            if b.get("charging"):
                if warned <= 5:
                    led({"cmd": "clear", "layer": "alert:battery"})
                warned = 101
                if pct >= 100 and not full_said:
                    notify("Battery", "Fully charged", "You can unplug the charger.", icon="battery", key="battery")
                    full_said = True
            else:
                full_said = False
                for level in (5, 10, 20):
                    if pct <= level < warned:
                        warned = level
                        if level <= 5:
                            led({"cmd": "set", "layer": "alert:battery", "effect": "blink", "color": "red", "speed": 0.5})
                        notify("Battery", f"Battery low: {pct}%",
                               "Plug in the charger soon." if level > 5 else "The phone will switch off soon. Plug in now.",
                               icon="battery", key="battery", urgency="critical" if level <= 10 else "normal")
                        break
        time.sleep(60)


def sms_watch_thread():
    """New text messages become notifications (when a modem is attached)."""
    seen = None
    while True:
        time.sleep(30)
        if not have("mmcli") or modem_index() is None:
            continue
        msgs = [m for m in sms_list().get("messages", []) if not m.get("out")]
        sig = {(m["number"], m["time"], m["text"]) for m in msgs}
        if seen is not None:
            for m in msgs:
                if (m["number"], m["time"], m["text"]) not in seen:
                    notify("Messages", m["number"], m["text"], icon="messages", open_app="messages")
        seen = sig


# --------------------------------------------------------------------------- Bluetooth pairing

MAC_RE = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$", re.I)


def bt_devices():
    def parse(out):
        d = {}
        for line in (out or "").splitlines():
            m = re.match(r"Device ([0-9A-F:]{17}) (.*)", line.strip(), re.I)
            if m:
                d[m.group(1).upper()] = m.group(2)
        return d
    if not have("bluetoothctl"):
        return {"ok": False, "devices": [], "message": "bluetoothctl missing (sudo apt install bluez)"}
    _, all_out, _ = run(["bluetoothctl", "devices"], timeout=6)
    _, paired_out, _ = run(["bluetoothctl", "devices", "Paired"], timeout=6)
    _, conn_out, _ = run(["bluetoothctl", "devices", "Connected"], timeout=6)
    every, paired, conn = parse(all_out), parse(paired_out), parse(conn_out)
    devs = [{"mac": mac, "name": name, "paired": mac in paired, "connected": mac in conn}
            for mac, name in every.items()]
    devs.sort(key=lambda d: (not d["connected"], not d["paired"], d["name"].lower()))
    return {"ok": True, "devices": devs}


def bt_action(action, mac=None):
    if not have("bluetoothctl"):
        return {"ok": False, "message": "bluetoothctl missing"}
    if action == "scan":
        run(["bluetoothctl", "power", "on"], timeout=6)
        run(["bluetoothctl", "--timeout", "8", "scan", "on"], timeout=15)
        return bt_devices()
    if not mac or not MAC_RE.match(str(mac)):
        return {"ok": False, "message": "bad device address"}
    mac = mac.upper()
    if action == "pair":
        # "just works" pairing (headphones, speakers, mice). Keyboards that need a code print it here.
        code, out, err = run(["bluetoothctl", "--agent", "NoInputNoOutput", "--timeout", "20", "pair", mac], timeout=30)
        ok = "Pairing successful" in (out or "") or "AlreadyExists" in (out or "") + (err or "")
        if ok:
            run(["bluetoothctl", "trust", mac], timeout=6)
            run(["bluetoothctl", "--timeout", "10", "connect", mac], timeout=15)
        passkey = re.search(r"Passkey:?\s*(\d{4,6})", out or "")
        msg = "Paired" if ok else ("Type " + passkey.group(1) + " on the device, then Enter" if passkey
                                   else (out or err or "Pairing failed").strip().splitlines()[-1][:160])
        return {"ok": ok, "message": msg}
    if action in ("connect", "disconnect"):
        code, out, err = run(["bluetoothctl", "--timeout", "10", action, mac], timeout=15)
        last = ((out or err or "").strip().splitlines() or [""])[-1]
        return {"ok": code == 0 and "fail" not in (out or "").lower(), "message": last[:160]}
    if action == "forget":
        code, out, err = run(["bluetoothctl", "remove", mac], timeout=8)
        return {"ok": code == 0}
    return {"ok": False, "message": "unknown action"}


# --------------------------------------------------------------------------- software updates

UPDATES = {"running": False, "phase": "", "log": "", "packages": [], "checked": 0, "result": ""}


def updates_state():
    d = dict(UPDATES)
    d["log"] = d["log"][-3000:]
    return d


def _updates_job(install):
    UPDATES.update(running=True, log="", result="")

    def step(phase, cmd, timeout):
        UPDATES["phase"] = phase
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             env=dict(os.environ, DEBIAN_FRONTEND="noninteractive", LC_ALL="C"))
        try:
            for line in p.stdout:
                UPDATES["log"] = (UPDATES["log"] + line)[-20000:]
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            return 1
        return p.returncode

    try:
        if step("Checking for updates…", ["sudo", "-n", PRIV, "apt", "update"], 600) != 0:
            UPDATES["result"] = "Could not check for updates. Is the phone online?"
            return
        _, out, _ = run(["apt", "list", "--upgradable"], timeout=60)
        pk = [l.split("/")[0] for l in (out or "").splitlines() if "/" in l and "upgradable" in l]
        UPDATES.update(packages=pk, checked=int(time.time()))
        if not install:
            UPDATES["result"] = f"{len(pk)} update(s) available" if pk else "Skyglass is up to date"
            if pk:
                notify("Updates", f"{len(pk)} update(s) available", "Settings › Software updates",
                       icon="download", open_app="settings", key="updates", urgency="low")
            return
        if not pk:
            UPDATES["result"] = "Skyglass is up to date"
            return
        code = step("Installing updates…", ["sudo", "-n", PRIV, "apt", "full-upgrade"], 3600)
        if code == 0:
            UPDATES.update(packages=[], result=f"Installed {len(pk)} update(s)")
            reboot = os.path.exists("/var/run/reboot-required")
            notify("Updates", f"Installed {len(pk)} update(s)", "Restart the phone to finish." if reboot else "",
                   icon="download", key="updates", urgency="low")
        else:
            UPDATES["result"] = "Installing failed. See the log below, or run  sudo apt full-upgrade  in the Terminal."
    finally:
        UPDATES.update(running=False, phase="")


def updates_start(install):
    if UPDATES["running"]:
        return {"ok": False, "message": "already running"}
    threading.Thread(target=_updates_job, args=(bool(install),), daemon=True).start()
    return {"ok": True}


# --------------------------------------------------------------------------- Wi-Fi hotspot

HOTSPOT = "Skyglass Hotspot"


def hotspot_state():
    if not have("nmcli"):
        return {"ok": False, "on": False}
    _, out, _ = run(["nmcli", "-t", "-f", "NAME", "connection", "show", "--active"], timeout=5)
    on = HOTSPOT in (out or "").splitlines()
    _, conf, _ = run(["nmcli", "-s", "-t", "-g", "802-11-wireless.ssid,802-11-wireless-security.psk",
                      "connection", "show", HOTSPOT], timeout=5)
    lines = (conf or "").splitlines()
    return {"ok": True, "on": on, "ssid": lines[0] if lines else "", "password": lines[1] if len(lines) > 1 else ""}


def hotspot_set(on, ssid=None, password=None):
    if not have("nmcli"):
        return {"ok": False, "message": "NetworkManager missing"}
    if not on:
        run(["nmcli", "connection", "down", HOTSPOT], timeout=15)
        return {"ok": True}
    ssid = str(ssid or "Skyglass")[:32]
    password = str(password or "")
    if len(password) < 8 or len(password) > 63:
        return {"ok": False, "message": "The password needs 8 to 63 characters"}
    code, out, err = run(["nmcli", "device", "wifi", "hotspot", "con-name", HOTSPOT, "ssid", ssid,
                          "password", password], timeout=30)
    return {"ok": code == 0, "message": (err or out or "").strip()[:200]}


# --------------------------------------------------------------------------- keyboard & compositor

NO_OSK_FLAG = os.path.join(HOME, ".config", "skyglass", "no-squeekboard")
DISPLAY_CONF = "/etc/skyglass/display.conf"
LAYOUTS = ["us", "gb", "de", "fr", "es", "it", "pt", "br", "nl", "se", "no", "dk", "fi", "pl", "cz", "hu",
           "ro", "tr", "ru", "ua", "gr", "ch", "be", "jp", "kr", "latam", "ca"]


def display_conf_get(key):
    for line in (read(DISPLAY_CONF) or "").splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    return ""


def display_conf_set(key, value):
    return priv("conf-set", key, value or "")[0] == 0


def keyboard_state():
    comp = (read(os.path.join(HOME, ".cache", "skyglass", "compositor")) or "").strip() or \
        os.environ.get("SKYGLASS_COMPOSITOR", "")
    return {"compositor": comp, "choice": display_conf_get("COMPOSITOR") or "auto",
            "labwc": have("labwc"), "squeekboard": have("squeekboard"),
            "osk": not os.path.exists(NO_OSK_FLAG), "layout": display_conf_get("KEYBOARD_LAYOUT") or "us",
            "layouts": LAYOUTS}


def keyboard_set(b):
    if "osk" in b:
        if b["osk"]:
            try:
                os.remove(NO_OSK_FLAG)
            except OSError:
                pass
        else:
            os.makedirs(os.path.dirname(NO_OSK_FLAG), exist_ok=True)
            open(NO_OSK_FLAG, "w").close()
            run(["pkill", "-u", str(os.getuid()), "-x", "squeekboard"])
    if "layout" in b:
        lay = str(b["layout"])
        if lay not in LAYOUTS:
            return {"ok": False, "message": "unknown layout"}
        if not display_conf_set("KEYBOARD_LAYOUT", "" if lay == "us" else lay):
            return {"ok": False, "message": "could not save"}
    if "compositor" in b:
        c = str(b["compositor"])
        if c not in ("auto", "labwc", "cage"):
            return {"ok": False, "message": "unknown compositor"}
        if not display_conf_set("COMPOSITOR", "" if c == "auto" else c):
            return {"ok": False, "message": "could not save"}
    return {"ok": True}




# --------------------------------------------------------------------------- self-repair, power, updates

REPAIR_REPORT = "/run/skyglass-repair.json"
REPAIR_SEEN = os.path.join(HOME, ".config", "skyglass", "repair-seen")


def repair_report_once():
    """skyglass-repair ran at boot: show what it found or fixed, once per boot."""
    try:
        with open(REPAIR_REPORT) as f:
            rep = json.load(f)
    except (OSError, ValueError):
        return
    stamp = str(rep.get("time", ""))
    if read(REPAIR_SEEN) == stamp:
        return
    notes = [str(n) for n in rep.get("notes") or []]
    if notes:
        title = "Repaired after a power cut" if rep.get("unclean") else "Self-repair"
        notify("System", title, "\n".join(notes), icon="power", key="repair",
               urgency="normal")
    try:
        os.makedirs(os.path.dirname(REPAIR_SEEN), exist_ok=True)
        with open(REPAIR_SEEN, "w") as f:
            f.write(stamp)
    except OSError:
        pass


def power_watch_thread():
    """A weak power supply makes the Pi 5 lose power under load: say so, once per boot."""
    said = False
    while not said:
        time.sleep(30)
        if not have("vcgencmd"):
            return
        _, out, _ = run(["vcgencmd", "get_throttled"], timeout=4)
        try:
            v = int(out.split("=")[1], 16)
        except (IndexError, ValueError):
            continue
        if v & 0x50005:   # under-voltage now/since boot, or throttled because of it
            notify("System", "Weak power supply",
                   "The phone isn't getting enough power and may switch off under load. "
                   "Use the official Raspberry Pi 27 W USB-C supply.", icon="power", key="power", urgency="critical")
            said = True


SKYUP = {"t": 0, "data": None}
SKYUP_LOG = "/var/log/skyglass-update.log"


def skyglass_update_state(force=False):
    running = run(["systemctl", "is-active", "--quiet", "skyglass-update"], timeout=4)[0] == 0
    if force or not SKYUP["data"] or time.time() - SKYUP["t"] > 600:
        code, out, err = run(["skyglass-update", "--check"], timeout=30)
        d = {"ok": code == 0, "message": (err or out).strip()[-300:] if code else ""}
        for line in out.splitlines():
            if line.startswith("installed:"):
                d["installed"] = line.split(":", 1)[1].strip()
            elif line.startswith("latest:"):
                d["latest"] = line.split(":", 1)[1].split()[0]
                d["repo"] = line.split("(")[-1].rstrip(")") if "(" in line else ""
        d["available"] = "update available" in out
        SKYUP.update(t=time.time(), data=d)
    log = ""
    try:
        with open(SKYUP_LOG) as f:
            log = f.read()[-3000:]
    except OSError:
        pass
    return {**SKYUP["data"], "running": running, "log": log}


def skyglass_update_start(action):
    if action not in ("update", "rollback"):
        return {"ok": False, "message": "unknown action"}
    # its own systemd unit: the update restarts the UI and this backend, it must outlive both
    arg = "--rollback" if action == "rollback" else ""
    code, out, err = priv("skyglass-update", arg, timeout=15)
    SKYUP["t"] = 0
    return {"ok": code == 0, "message": (err or out).strip()[-200:]}


# --------------------------------------------------------------------------- root access (sudo)
# Settings › Developer › Root access: does sudo ask for the user's Linux password? Both
# directions need the lock-screen PIN; going back to passwordless also needs that password
# (skyglass-sudo-mode isn't on the no-password list, so sudo checks it).

SUDO_MODE = "/usr/local/sbin/skyglass-sudo-mode"


def sudo_state():
    full = run(["sudo", "-n", "true"], timeout=4)[0] == 0
    code, out, _ = priv("password-status", timeout=6)
    return {"mode": "full" if full else "strict", "password": out.strip() == "set",
            "helper": code == 0, "pin_set": bool(pin_load())}


def _pin_ok(pin):
    if not pin_load():
        return {"ok": False, "message": "Set a lock-screen PIN first (Settings › Lock screen & PIN)"}
    r = pin_check(pin if isinstance(pin, str) else "")
    return {"ok": True} if r.get("ok") else {"ok": False, "message": "Wrong PIN", **r}


def _as_root_with_password(args, password, stdin_rest=""):
    """sudo -S: the user's password comes in on stdin, never in a command line (ps shows those)."""
    st = sudo_state()
    if st["mode"] == "full":
        return run(["sudo", "-n"] + args, input=stdin_rest, timeout=30)
    if not isinstance(password, str) or not password:
        return 1, "", "Type your Linux password"
    code, out, err = run(["sudo", "-k", "-S", "-p", ""] + args, input=password + "\n" + stdin_rest, timeout=30)
    if code != 0 and ("incorrect password" in err or "try again" in err.lower() or "Sorry" in err):
        err = "Wrong Linux password"
    return code, out, err


def sudo_set(b):
    mode = b.get("mode")
    if mode not in ("full", "strict"):
        return {"ok": False, "message": "unknown mode"}
    r = _pin_ok(b.get("pin"))
    if not r["ok"]:
        return r
    code, out, err = _as_root_with_password([SUDO_MODE, mode], b.get("password"))
    return {"ok": code == 0, "message": (err or out).strip().replace("skyglass-sudo-mode: ", ""), **sudo_state()}


def user_password_set(b):
    new = b.get("new")
    if not isinstance(new, str) or len(new) < 6 or ":" in new or "\n" in new:
        return {"ok": False, "message": "Use at least 6 characters (no ':')"}
    r = _pin_ok(b.get("pin"))
    if not r["ok"]:
        return r
    code, out, err = _as_root_with_password([SUDO_MODE, "set-password"], b.get("current"), new + "\n")
    return {"ok": code == 0, "message": (err or out).strip().replace("skyglass-sudo-mode: ", ""), **sudo_state()}


def android_status():
    """Android (Waydroid): what's set up, so the Android app can say what's missing."""
    try:
        page = os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError):
        page = 0
    binder = "binder" in (read("/proc/filesystems") or "") or os.path.exists("/dev/binder") \
        or os.path.isdir("/dev/binderfs")
    installed = have("waydroid")
    # the config file appears before the ~1 GB download finishes: also need the images
    imgs = "/var/lib/waydroid/images"
    for line in (read("/var/lib/waydroid/waydroid.cfg") or "").splitlines():
        if line.replace(" ", "").startswith("images_path="):
            imgs = line.split("=", 1)[1].strip()
    ready = installed and any(os.path.getsize(os.path.join(d, "system.img")) > 0
                              for d in (imgs, "/etc/waydroid-extra/images")
                              if os.path.isfile(os.path.join(d, "system.img")))
    running = False
    if ready:
        _, out, _ = run(["waydroid", "status"], timeout=6)
        running = bool(re.search(r"Session:\s*RUNNING", out or ""))
    apps = [a for a in APPS.list() if a["id"].startswith("waydroid.")]
    return {"pagesize": page, "kernel_ok": page == 4096, "binder": binder, "installed": installed,
            "ready": ready and page == 4096, "running": running, "apps": apps,
            "helper": have("skyglass-android"),
            "windowed": os.path.exists(os.path.join(HOME, ".config", "skyglass", "android-windowed"))}


def android_action(action, b=None):
    b = b or {}
    if not have("skyglass-android"):
        return {"ok": False, "message": "skyglass-android is missing"}
    if action == "open":
        return APPS.launch(argv=["skyglass-android", "open"])
    if action == "stop":
        run(["skyglass-android", "stop"], timeout=30)
        return {"ok": True}
    if action == "windowed":
        code, out, err = run(["skyglass-android", "windowed", "on" if b.get("on") else "off"], timeout=20)
        return {"ok": code == 0, "message": out or err}
    if action == "settings":
        return APPS.launch(argv=["skyglass-android", "open", "com.android.settings"])
    if action == "install":
        path = os.path.realpath(str(b.get("path") or ""))
        if not path.lower().endswith(".apk") or not os.path.isfile(path) or \
                not (path.startswith(HOME + os.sep) or path.startswith(USB_ROOT + os.sep)):
            return {"ok": False, "message": "pick an .apk file from your phone or a USB drive"}

        def job():
            code, out, err = run(["skyglass-android", "install", path], timeout=600)
            name = os.path.basename(path)
            if code == 0:
                notify("Android", "App installed", f"{name} is ready in Android and Linux Apps.", icon="android", open_app="android")
            else:
                notify("Android", "Could not install " + name, (err or out or "")[-300:], icon="android")
        threading.Thread(target=job, daemon=True).start()
        return {"ok": True}
    return {"ok": False, "message": "unknown action"}


def find_icon(name):
    if not name:
        return None
    if os.path.isabs(name):   # a .desktop file's own icon: only real icon files, never any file
        ok = re.search(r"\.(png|svg|xpm|jpe?g|webp|ico)$", name, re.I) and os.path.isfile(name)
        return name if ok else None
    for theme in ("hicolor", "Adwaita", "breeze"):
        hits = glob.glob(f"/usr/share/icons/{theme}/*/apps/{glob.escape(name)}.*") + \
            glob.glob(f"{HOME}/.local/share/icons/{theme}/*/apps/{glob.escape(name)}.*")
        if hits:
            def score(p):
                size = p.split("/")[-3]
                return 10000 if size == "scalable" else int(size.split("x")[0]) if size.split("x")[0].isdigit() else 0
            return max(hits, key=score)
    for ext in ("png", "svg", "xpm"):
        if os.path.exists(f"/usr/share/pixmaps/{name}.{ext}"):
            return f"/usr/share/pixmaps/{name}.{ext}"
    return None


# --------------------------------------------------------------------------- terminals

class Term:
    def __init__(self):
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(HOME)
            os.environ.update(TERM="xterm-256color", COLORTERM="truecolor", SKYGLASS_TERM="1")
            os.execvp("bash", ["bash", "-l"])
        self.pid, self.fd = pid, fd
        self.out = ""
        self.base = 0  # absolute offset of self.out[0]
        self.cond = threading.Condition()
        self.alive = True
        self.touched = time.time()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        dec = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                data = b""
            with self.cond:
                if not data:
                    self.alive = False
                    self.cond.notify_all()
                    return
                self.out += dec.decode(data)
                if len(self.out) > 200_000:
                    cut = len(self.out) - 100_000
                    self.out = self.out[cut:]
                    self.base += cut
                self.cond.notify_all()

    def read(self, pos, timeout=20):
        end = time.time() + timeout
        self.touched = time.time()
        with self.cond:
            while self.alive and self.base + len(self.out) <= pos and time.time() < end:
                self.cond.wait(end - time.time())
            start = max(0, pos - self.base)
            return self.out[start:], self.base + len(self.out), self.alive

    def write(self, text):
        self.touched = time.time()
        os.write(self.fd, text.encode())

    def resize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGHUP)
        except OSError:
            pass


TERMS = {}


# --------------------------------------------------------------------------- camera (rpicam-apps)

class Camera:
    def __init__(self):
        self.proc = None
        self.frame = None
        self.cond = threading.Condition()
        self.clients = 0

    def available(self):
        return have("rpicam-vid") and have("rpicam-still")

    def _loop(self):
        p = subprocess.Popen(["rpicam-vid", "-n", "-t", "0", "--codec", "mjpeg", "--width", "640",
                              "--height", "480", "--framerate", "20", "-o", "-"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.proc = p
        buf = b""
        while True:
            chunk = p.stdout.read(32768)
            if not chunk:
                break
            buf += chunk
            while True:
                s = buf.find(b"\xff\xd8")
                e = buf.find(b"\xff\xd9", s + 2)
                if s < 0 or e < 0:
                    break
                with self.cond:
                    self.frame = buf[s:e + 2]
                    self.cond.notify_all()
                buf = buf[e + 2:]
        self.proc = None

    def start(self):
        if self.proc is None and self.available():
            threading.Thread(target=self._loop, daemon=True).start()

    def stop(self):
        if self.proc:
            self.proc.terminate()
            self.proc.wait()
            self.proc = None

    def snap(self, to=None, hq=False):
        folder = save_folder(to, PICTURES)
        if not folder:
            return {"ok": False, "message": "No USB drive connected"}
        name = time.strftime("IMG_%Y%m%d_%H%M%S.jpg")
        path = os.path.join(folder, name)
        if not self.available():
            return {"ok": False, "message": "No camera (rpicam-apps not found)."}
        if self.rec:
            return {"ok": False, "message": "Stop recording first"}
        if free_bytes(folder) < MIN_FREE // 10:
            return {"ok": False, "message": "Storage is full — free some space in Settings › Storage"}
        was = self.proc is not None
        self.stop()
        # Standard: 2304x1296 (about 1 MB). High quality: the sensor's full 12 MP (about 5 MB).
        size = [] if hq else ["--width", "2304", "--height", "1296"]
        code, _, err = run(["rpicam-still", "-n", "-t", "300", "-q", "90"] + size + ["-o", path], timeout=20)
        if was:
            self.start()
        if code == 0:
            os.sync()
        return {"ok": code == 0, "path": path, "message": err if code else ""}

    rec = None  # (Popen, path, started)

    def record_start(self, to=None):
        if not self.available():
            return {"ok": False, "message": "No camera (rpicam-apps not found)."}
        if self.rec:
            return {"ok": True, "path": self.rec[1], "started": self.rec[2]}
        folder = save_folder(to, VIDEOS)
        if not folder:
            return {"ok": False, "message": "No USB drive connected"}
        if free_bytes(folder) < MIN_FREE:
            return {"ok": False, "message": "Not enough space to record — free some in Settings › Storage"}
        path = os.path.join(folder, time.strftime("VID_%Y%m%d_%H%M%S.mp4"))
        self.stop()  # one camera user at a time: the live preview pauses while recording
        log = open(os.path.join(HOME, ".cache", "skyglass-record.log"), "wb") \
            if os.path.isdir(os.path.join(HOME, ".cache")) else subprocess.DEVNULL
        # The Pi 5 has no H.264 hardware encoder; libav encodes in software into a normal .mp4
        p = subprocess.Popen(["rpicam-vid", "-n", "-t", "0", "--codec", "libav", "--libav-format", "mp4", "--libav-video-codec", "libx264",
                              "--width", "1280", "--height", "720", "--framerate", "30", "-o", path],
                             stdout=subprocess.DEVNULL, stderr=log)
        time.sleep(1.2)
        if p.poll() is not None:
            self.start()
            tail = read(os.path.join(HOME, ".cache", "skyglass-record.log"), "")[-300:]
            return {"ok": False, "message": "Recording failed. " + tail.strip().split("\n")[-1]}
        self.rec = (p, path, time.time())
        threading.Thread(target=self._space_guard, args=(p, folder), daemon=True).start()
        return {"ok": True, "path": path, "started": self.rec[2]}

    def _space_guard(self, p, folder):
        while self.rec and self.rec[0] is p:
            if free_bytes(folder) < MIN_FREE // 2:
                r = self.record_stop()
                EVENTS.emit("rec-stopped", message="Storage almost full — recording stopped and saved", path=r.get("path", ""))
                return
            time.sleep(3)

    def record_stop(self):
        if not self.rec:
            return {"ok": False, "message": "not recording"}
        p, path, started = self.rec
        self.rec = None
        p.send_signal(signal.SIGINT)  # rpicam-vid finishes the .mp4 properly on Ctrl+C
        try:
            p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            p.kill()
        os.sync()
        self.start()
        ok = os.path.exists(path) and os.path.getsize(path) > 0
        return {"ok": ok, "path": path, "seconds": round(time.time() - started), "message": "" if ok else "Video was not saved"}


CAMERA = Camera()


# --------------------------------------------------------------------------- files

def list_dir(path):
    path = os.path.abspath(os.path.expanduser(path or HOME))
    try:
        names = os.listdir(path)
    except OSError as e:
        return {"path": path, "error": e.strerror, "entries": []}
    entries = []
    for n in names:
        full = os.path.join(path, n)
        try:
            st = os.stat(full)
        except OSError:
            continue
        entries.append({"name": n, "dir": os.path.isdir(full), "size": st.st_size, "mtime": st.st_mtime})
    entries.sort(key=lambda e: (not e["dir"], e["name"].startswith("."), e["name"].lower()))
    return {"path": path, "parent": os.path.dirname(path) if path != "/" else None, "entries": entries}


# --------------------------------------------------------------------------- USB drives
# Plug a USB stick in: it is mounted automatically under /media/skyglass-usb/<name> and the UI
# gets a "usb-added" event. Eject unmounts it (after flushing everything to the stick).
USB_ROOT = "/media/skyglass-usb"


def usb_drives():
    code, out, _ = run(["lsblk", "-J", "-b", "-o", "NAME,PATH,TRAN,RM,HOTPLUG,TYPE,FSTYPE,LABEL,SIZE,MOUNTPOINT,MODEL,SUBSYSTEMS"])
    if code != 0:
        return []
    try:
        tree = json.loads(out).get("blockdevices", [])
    except ValueError:
        return []
    truthy = lambda v: v in (True, 1, "1", "true")
    drives = []
    for disk in tree:
        kids = disk.get("children") or []
        mounts = [k.get("mountpoint") for k in kids] + [disk.get("mountpoint")]
        if any(m in ("/", "/boot", "/boot/firmware") for m in mounts):
            continue  # the system disk, even when it is a USB SSD
        is_usb = disk.get("tran") == "usb" or "usb" in str(disk.get("subsystems") or "")
        if not is_usb and not truthy(disk.get("hotplug")) and not truthy(disk.get("rm")):
            continue
        if disk.get("type") not in ("disk", None) or str(disk.get("name", "")).startswith(("loop", "zram", "ram")):
            continue
        for part in (kids or [disk]):
            if not part.get("fstype") or part.get("fstype") in ("swap", "crypto_LUKS", "LVM2_member"):
                continue
            mp = part.get("mountpoint")
            d = {"dev": part["path"], "label": part.get("label") or (disk.get("model") or "USB drive").strip(),
                 "fstype": part["fstype"], "size": int(part.get("size") or 0), "mounted": bool(mp), "mountpoint": mp}
            if mp:
                try:
                    st = os.statvfs(mp)
                    d["free"] = st.f_bavail * st.f_frsize
                except OSError:
                    pass
            drives.append(d)
    return drives


def usb_mount(dev):
    drive = next((d for d in usb_drives() if d["dev"] == dev), None)
    if not drive:
        return {"ok": False, "message": "That drive is gone"}
    if drive["mounted"]:
        return {"ok": True, "mountpoint": drive["mountpoint"]}
    # skyglass-priv checks it's really a USB drive, mounts it nosuid,nodev and picks the folder
    code, out, err = priv("usb-mount", dev, timeout=40)
    if code != 0:
        USB_STATE["last_error"] = f"{dev} ({drive['fstype']}): {err.strip()}"
        return {"ok": False, "message": "Could not open the drive: " + (err.strip().replace("skyglass-priv: ", "") or drive["fstype"])}
    return {"ok": True, "mountpoint": out.strip().splitlines()[-1]}


def usb_eject(dev):
    drive = next((d for d in usb_drives() if d["dev"] == dev), None)
    if not drive or not drive["mounted"]:
        return {"ok": True}
    if CAMERA.rec and CAMERA.rec[1].startswith(drive["mountpoint"] + "/"):
        CAMERA.record_stop()
    os.sync()
    code, _, err = priv("usb-umount", drive["mountpoint"], timeout=60)
    if code != 0:
        return {"ok": False, "message": "Drive is busy: " + err.strip().replace("skyglass-priv: ", "")}
    return {"ok": True, "message": "Safe to remove"}


def usb_folder():
    """Where photos/videos go on the first mounted USB drive (created on demand)."""
    for d in usb_drives():
        if d["mounted"]:
            path = os.path.join(d["mountpoint"], "Skyglass")
            try:
                os.makedirs(path, exist_ok=True)
                return path
            except OSError:
                continue
    return None


def save_folder(to, default):
    if to == "usb":
        return usb_folder()
    os.makedirs(default, exist_ok=True)
    return default


USB_STATE = {"last_error": "", "watching": False, "scans": 0}


def usb_debug():
    """Everything needed to see why a stick does not show up, in plain text."""
    lines = [f"USB watcher running: {'yes' if USB_STATE['watching'] else 'NO'}  (scans: {USB_STATE['scans']})"]
    lines.append("Drives Skyglass sees: " + (", ".join(f"{d['label']} {d['dev']} {d['fstype']} {'mounted' if d['mounted'] else 'not mounted'}" for d in usb_drives()) or "none"))
    if USB_STATE["last_error"]:
        lines.append("Last mount error: " + USB_STATE["last_error"])
    _, out, _ = run(["lsblk", "-o", "NAME,TRAN,RM,HOTPLUG,FSTYPE,SIZE,MOUNTPOINT"])
    lines += ["", "Disks (lsblk):", out.strip()]
    if have("lsusb"):
        _, out, _ = run(["lsusb"])
        lines += ["", "USB devices (lsusb):", out.strip()]
    code, out, _ = priv("dmesg", timeout=10)
    if code == 0:
        rel = [l for l in out.splitlines() if re.search(r"usb|sd[a-z]|scsi|uas|over-current|exfat|ntfs|fat", l, re.I)]
        lines += ["", "Kernel messages (last USB lines):"] + rel[-15:]
    return {"text": "\n".join(lines)}


def block_signature():
    """Names and sizes of block devices, straight from sysfs: no process to start. lsblk only
    runs when this changes (a drive or card plugged in, pulled out, or partitioned)."""
    sig = []
    try:
        for name in sorted(os.listdir("/sys/class/block")):
            if not name.startswith(("loop", "ram", "zram")):
                sig.append((name, read(f"/sys/class/block/{name}/size", "")))
    except OSError:
        return None
    return sig


def usb_watch_thread():
    known = {}
    USB_STATE["watching"] = True
    last_sig, last_full = object(), 0.0
    while True:
        time.sleep(2)
        sig = block_signature()
        # unchanged sysfs: skip, but still do a full check once a minute in case sysfs is odd
        if sig is not None and sig == last_sig and time.time() - last_full < 60:
            continue
        last_sig, last_full = sig, time.time()
        USB_STATE["scans"] += 1
        try:
            now = {d["dev"]: d for d in usb_drives()}
            for dev, d in now.items():
                if dev not in known:
                    r = usb_mount(dev) if not d["mounted"] else {"ok": True}
                    EVENTS.emit("usb-added", label=d["label"], ok=r.get("ok"), message=r.get("message", ""))
            for dev, d in known.items():
                if dev not in now:
                    EVENTS.emit("usb-removed", label=d["label"])
                    mp = d.get("mountpoint")
                    if mp and mp.startswith(USB_ROOT + "/"):  # yanked without eject: clean up
                        priv("usb-umount", mp, "lazy")
            known = now
        except Exception as e:  # noqa: BLE001 — never let the watcher die
            print("usb watch:", e, flush=True)


class CopyJob:
    """Copies (or moves) files in the background so big videos don't block anything."""
    jobs = {}

    def __init__(self, paths, dest, move=False):
        self.id = uuid.uuid4().hex[:12]
        self.paths, self.dest, self.move = paths, dest, move
        self.total = sum(os.path.getsize(p) for p in paths if os.path.isfile(p))
        self.done_bytes, self.count, self.current, self.error, self.finished = 0, 0, "", "", False
        CopyJob.jobs[self.id] = self
        threading.Thread(target=self._run, daemon=True).start()

    @staticmethod
    def free_name(folder, name):
        stem, ext = os.path.splitext(name)
        cand, n = os.path.join(folder, name), 1
        while os.path.exists(cand):
            cand = os.path.join(folder, f"{stem} ({n}){ext}")
            n += 1
        return cand

    def _run(self):
        import shutil
        try:
            for src in self.paths:
                if not os.path.isfile(src):
                    continue
                self.current = os.path.basename(src)
                dst = self.free_name(self.dest, self.current)
                with open(src, "rb") as fi, open(dst, "wb") as fo:
                    while True:
                        chunk = fi.read(1 << 20)
                        if not chunk:
                            break
                        fo.write(chunk)
                        self.done_bytes += len(chunk)
                try:
                    shutil.copystat(src, dst)  # keep the photo's original date
                except OSError:
                    pass  # FAT sticks can't store permissions; the copy is still fine
                if self.move:
                    os.remove(src)
                self.count += 1
            os.sync()
        except OSError as e:
            self.error = e.strerror or str(e)
            if getattr(e, "errno", 0) == 28:
                self.error = "The drive is full"
        self.finished = True

    def state(self):
        return {"id": self.id, "total": self.total, "done": self.done_bytes, "count": self.count,
                "files": len(self.paths), "current": self.current, "error": self.error, "finished": self.finished}


# --------------------------------------------------------------------------- media editing / delete
def safe_path(p):
    """Only files in the user's home or on a USB drive may be changed or deleted."""
    if not isinstance(p, str) or not p:
        return None
    p = os.path.realpath(os.path.expanduser(p))
    home = os.path.realpath(HOME)
    return p if p.startswith(home + "/") or p.startswith(USB_ROOT + "/") else None


def delete_files(paths):
    n, errors = 0, []
    for raw in paths or []:
        p = safe_path(raw)
        if not p or not os.path.isfile(p):
            errors.append(os.path.basename(str(raw)))
            continue
        try:
            os.remove(p)
            n += 1
        except OSError as e:
            errors.append(f"{os.path.basename(p)}: {e.strerror}")
    os.sync()
    return {"ok": not errors, "deleted": n, "message": "; ".join(errors[:3])}


def save_image(b):
    """Save an edited photo or a sketch. data is a data: URL from a canvas."""
    data = str(b.get("data", ""))
    m = re.match(r"data:image/(png|jpeg);base64,", data)
    if not m:
        return {"ok": False, "message": "bad image data"}
    raw = base64.b64decode(data[m.end():])
    if len(raw) > 60_000_000:
        return {"ok": False, "message": "image too big"}
    ext = ".png" if m.group(1) == "png" else ".jpg"
    if b.get("path"):
        src = safe_path(b["path"])
        if not src or not os.path.isfile(src):
            return {"ok": False, "message": "original not found"}
        if b.get("replace"):
            dst = os.path.splitext(src)[0] + ext
        else:
            dst = CopyJob.free_name(os.path.dirname(src), os.path.splitext(os.path.basename(src))[0] + "_edited" + ext)
    else:
        os.makedirs(PICTURES, exist_ok=True)
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", str(b.get("name") or "Image"))[:60]
        dst = CopyJob.free_name(PICTURES, os.path.splitext(name)[0] + ext)
    tmp = dst + ".tmp"
    with open(tmp, "wb") as f:
        f.write(raw)
    os.replace(tmp, dst)
    if b.get("path") and b.get("replace") and dst != src:
        os.remove(src)  # replaced a .png with a .jpg (or the other way round)
    os.sync()
    return {"ok": True, "path": dst}


class VideoJob:
    """Trim / rotate / mute a video with ffmpeg in the background, with progress."""
    jobs = {}

    def __init__(self, src, start, end, mute, rotate, replace):
        self.id = uuid.uuid4().hex[:12]
        self.src, self.length = src, max(0.1, end - start)
        self.progress, self.error, self.finished, self.path = 0.0, "", False, ""
        folder, name = os.path.split(src)
        stem = os.path.splitext(name)[0]
        self.dst = src if replace else CopyJob.free_name(folder, stem + "_edited.mp4")
        self.tmp = os.path.join(folder, "." + stem + ".editing.mp4")
        vf = {90: "transpose=1", 180: "transpose=1,transpose=1", 270: "transpose=2"}.get(rotate)
        self.cmd = (["ffmpeg", "-y", "-hide_banner", "-nostdin", "-ss", f"{start:.3f}", "-i", src,
                     "-t", f"{self.length:.3f}", "-map", "0:v:0"] + ([] if mute else ["-map", "0:a?"]) +
                    (["-vf", vf] if vf else []) +
                    ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p"] +
                    (["-an"] if mute else ["-c:a", "aac", "-b:a", "128k"]) +
                    ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", self.tmp])
        VideoJob.jobs[self.id] = self
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            p = subprocess.Popen(self.cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for line in p.stdout:
                if line.startswith("out_time_us=") and line.strip().split("=")[1].isdigit():
                    self.progress = min(1.0, int(line.strip().split("=")[1]) / 1e6 / self.length)
            err = p.stderr.read()
            if p.wait() != 0:
                self.error = (err.strip().splitlines() or ["ffmpeg failed"])[-1][:200]
            else:
                os.replace(self.tmp, self.dst)
                self.path, self.progress = self.dst, 1.0
                os.sync()
        except OSError as e:
            self.error = str(e)
        finally:
            if os.path.exists(self.tmp):
                os.remove(self.tmp)
            self.finished = True

    def state(self):
        return {"id": self.id, "progress": round(self.progress, 3), "error": self.error,
                "finished": self.finished, "path": self.path}


# --------------------------------------------------------------------------- music + system monitor
AUDIO_EXT = (".mp3", ".ogg", ".oga", ".flac", ".wav", ".m4a", ".aac", ".opus")


def list_music():
    roots = [os.path.join(HOME, "Music")] + [d["mountpoint"] for d in usb_drives() if d["mounted"]]
    out = []
    for root in roots:
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in sorted(files):
                if f.lower().endswith(AUDIO_EXT):
                    out.append({"path": os.path.join(dirpath, f), "name": os.path.splitext(f)[0],
                                "folder": os.path.basename(dirpath), "usb": root.startswith(USB_ROOT)})
                    if len(out) >= 2000:
                        return {"tracks": out}
    return {"tracks": out}


_cpu_prev = {}


def sysmon():
    cores = []
    for line in (read("/proc/stat", "") or "").splitlines():
        if not line.startswith("cpu"):
            continue
        f = line.split()
        vals = [int(x) for x in f[1:8]]
        idle, total = vals[3] + vals[4], sum(vals)
        prev = _cpu_prev.get(f[0])
        _cpu_prev[f[0]] = (idle, total)
        pct = 0.0 if not prev or total == prev[1] else round(100 * (1 - (idle - prev[0]) / (total - prev[1])), 1)
        cores.append({"name": f[0], "pct": max(0.0, pct)})
    mem = {}
    for line in (read("/proc/meminfo", "") or "").splitlines():
        k, _, v = line.partition(":")
        mem[k] = int(v.split()[0]) if v.split() else 0
    st = os.statvfs("/")
    procs = []
    code, out, _ = run(["ps", "-eo", "pid,comm,%cpu,%mem", "--sort=-%cpu", "--no-headers"])
    for line in out.splitlines()[:8]:
        f = line.split(None, 3)
        if len(f) == 4:
            procs.append({"pid": f[0], "name": f[1], "cpu": f[2], "mem": f[3]})
    return {"cpu": cores[0]["pct"] if cores else 0, "cores": [c["pct"] for c in cores[1:]],
            "mem_total": mem.get("MemTotal", 0) * 1024, "mem_avail": mem.get("MemAvailable", 0) * 1024,
            "disk_total": st.f_blocks * st.f_frsize, "disk_free": st.f_bavail * st.f_frsize,
            "temp": cpu_temp(), "load": os.getloadavg(), "uptime": float((read("/proc/uptime", "0") or "0").split()[0]),
            "procs": procs}


# --------------------------------------------------------------------------- thumbnails + storage
# Small cached JPEG previews (made with ffmpeg) so galleries never decode 12-megapixel photos
# or open a video player per tile. The cache is capped and cleaned automatically.
THUMBS = os.path.join(HOME, ".cache", "skyglass", "thumbs")
THUMB_CAP = 60 * 1024 * 1024
_thumb_gate = threading.Semaphore(2)  # at most 2 ffmpeg at once
MIN_FREE = 300 * 1024 * 1024          # refuse new photos/videos below this


def free_bytes(path):
    try:
        st = os.statvfs(path)
        return st.f_bavail * st.f_frsize
    except OSError:
        return 0


def prune_thumbs():
    try:
        files = [(e.stat().st_atime, e.stat().st_size, e.path) for e in os.scandir(THUMBS) if e.is_file()]
    except OSError:
        return
    total = sum(f[1] for f in files)
    for _, size, path in sorted(files):
        if total <= THUMB_CAP * 0.8:
            break
        try:
            os.remove(path)
            total -= size
        except OSError:
            pass


def thumb(path, size):
    src = os.path.abspath(os.path.expanduser(path or ""))
    try:
        st = os.stat(src)
    except OSError:
        return None
    size = 320 if size <= 320 else 1280
    key = hashlib.sha1(f"{src}|{st.st_mtime}|{st.st_size}|{size}".encode()).hexdigest()
    out = os.path.join(THUMBS, key + ".jpg")
    if os.path.exists(out):
        return out
    if not have("ffmpeg"):
        return src if not src.lower().endswith((".mp4", ".webm", ".mov", ".mkv")) else None
    os.makedirs(THUMBS, exist_ok=True)
    tmp = out + ".tmp.jpg"
    video = src.lower().endswith((".mp4", ".webm", ".mov", ".mkv"))
    with _thumb_gate:
        if os.path.exists(out):
            return out
        cmd = ["ffmpeg", "-v", "error", "-y"] + (["-ss", "0.5"] if video else []) + ["-i", src, "-frames:v", "1",
               "-vf", f"scale='min({size},iw)':'min({size},ih)':force_original_aspect_ratio=decrease", "-q:v", "5", tmp]
        code, _, _ = run(cmd, timeout=30)
        if code != 0 and video:  # very short clip: take the first frame
            code, _, _ = run([c for c in cmd if c not in ("-ss", "0.5")], timeout=30)
        if code != 0 or not os.path.exists(tmp):
            return src if not video else None
        os.replace(tmp, out)
    if random.random() < 0.05:
        prune_thumbs()
    return out


def du(path):
    code, out, _ = run(["du", "-sb", path], timeout=20)
    try:
        return int(out.split()[0]) if code == 0 else 0
    except (ValueError, IndexError):
        return 0


CACHE_DIRS = [THUMBS] + [os.path.join(HOME, ".local/share/skyglass", prof, "Default", sub)
                         for prof in ("shell-profile", "browser") for sub in ("Cache", "Code Cache", "GPUCache")]


def storage():
    st = os.statvfs("/")
    parts = {"Photos": du(os.path.join(HOME, "Pictures")), "Videos": du(os.path.join(HOME, "Videos")),
             "Music": du(os.path.join(HOME, "Music")), "Documents": du(os.path.join(HOME, "Documents")),
             "Caches": sum(du(d) for d in CACHE_DIRS if os.path.isdir(d)),
             "Browser data": du(os.path.join(HOME, ".local/share/skyglass/browser"))}
    return {"total": st.f_blocks * st.f_frsize, "free": st.f_bavail * st.f_frsize, "parts": parts}


def clean_caches():
    import shutil
    before = free_bytes("/")
    for d in CACHE_DIRS:
        shutil.rmtree(d, ignore_errors=True)
    priv("apt", "clean", timeout=60)
    priv("journal-vacuum", timeout=60)
    os.sync()
    return {"ok": True, "freed": max(0, free_bytes("/") - before)}


# --------------------------------------------------------------------------- settings helpers
def bluetooth_state():
    code, out, _ = run(["rfkill", "list", "bluetooth"])
    if code != 0 or not out.strip():
        return {"present": False, "on": False}
    return {"present": True, "on": "Soft blocked: yes" not in out}


def time_state():
    code, out, _ = run(["timedatectl", "show"])
    d = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    return {"timezone": d.get("Timezone", ""), "ntp": d.get("NTP", "no") == "yes"}


def list_zones():
    code, out, _ = run(["timedatectl", "list-timezones"])
    return {"zones": out.split()}


def list_photos():
    out = []
    for root in (os.path.join(HOME, "Pictures"), os.path.join(HOME, "Videos")):
        for dirpath, _, files in os.walk(root):
            for f in files:
                low = f.lower()
                if low.endswith((".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov", ".mkv")):
                    p = os.path.join(dirpath, f)
                    out.append({"path": p, "mtime": os.path.getmtime(p), "video": low.endswith((".mp4", ".webm", ".mov", ".mkv"))})
    out.sort(key=lambda x: -x["mtime"])
    return {"photos": out[:500]}


# --------------------------------------------------------------------------- hardware test mode (*#0*#)
# Each test returns {"ok": True/False/None, "rows": [[label, value], ...]}; ok None = nothing to judge.

THROTTLE_BITS = {0: "under-voltage now", 1: "ARM clock capped now", 2: "throttled now", 3: "soft temp limit now",
                 16: "under-voltage happened", 17: "ARM clock capped earlier", 18: "throttled earlier", 19: "soft temp limit earlier"}


def vcgen(*args):
    code, out, _ = run(["vcgencmd", *args], timeout=5)
    return out if code == 0 else ""


def throttled():
    m = re.search(r"0x([0-9a-fA-F]+)", vcgen("get_throttled"))
    v = int(m.group(1), 16) if m else 0
    return v, [txt for bit, txt in THROTTLE_BITS.items() if v >> bit & 1]


def test_sensors():
    rows, ok = [], True
    for z in sorted(glob.glob("/sys/class/thermal/thermal_zone*")):
        t = read(z + "/temp")
        if t and t.lstrip("-").isdigit():
            c = int(t) / 1000
            rows.append([f"Temperature ({read(z + '/type', 'zone')})", f"{c:.1f} °C"])
            ok = ok and c < 80
    for clk in ("arm", "core", "v3d"):
        m = re.search(r"=(\d+)", vcgen("measure_clock", clk))
        if m:
            rows.append([f"{clk.upper()} clock", f"{int(m.group(1)) / 1e6:.0f} MHz"])
    v = re.search(r"=([\d.]+)V", vcgen("measure_volts", "core"))
    if v:
        rows.append(["Core voltage", f"{float(v.group(1)):.3f} V"])
    for f in glob.glob("/sys/class/hwmon/hwmon*/fan1_input"):
        rows.append(["Fan", (read(f, "?") or "?") + " rpm"])
    val, flags = throttled()
    rows.append(["Throttling", ", ".join(flags) if flags else "none"])
    if val & 0xF:
        ok = False
    return {"ok": ok, "rows": rows}


def test_power():
    rows, ok = [], True
    volts, amps = {}, {}
    for line in vcgen("pmic_read_adc").splitlines():
        m = re.match(r"\s*(\S+?)_([VA])\s+\S+=([\d.]+)", line)
        if m:
            (volts if m.group(2) == "V" else amps)[m.group(1)] = float(m.group(3))
    if "EXT5V" in volts:
        rows.append(["USB-C input", f"{volts['EXT5V']:.2f} V"])
        ok = volts["EXT5V"] >= 4.8
    if amps:
        watts = sum(volts.get(k, 0) * a for k, a in amps.items())
        rows.append(["Board power (rails)", f"{watts:.2f} W"])
        for k in sorted(amps, key=lambda k: -volts.get(k, 0) * amps[k])[:8]:
            rows.append([k.replace("_", " "), f"{volts.get(k, 0):.3f} V · {amps[k] * 1000:.0f} mA"])
    val, _ = throttled()
    if val & 0x10001:
        ok = False
        rows.append(["Warning", "under-voltage seen: use the official 5 V / 5 A supply"])
    for ps in sorted(glob.glob("/sys/class/power_supply/*")):
        rows.append([os.path.basename(ps), f"{read(ps + '/type', '')} {read(ps + '/capacity', '')}% {read(ps + '/status', '')}".strip()])
    if not rows:
        return {"ok": None, "rows": [["Power", "no readings on this hardware"]]}
    return {"ok": ok, "rows": rows}


def ping_ms(host):
    c, o, _ = run(["ping", "-c", "3", "-i", "0.3", "-W", "2", host], timeout=8)
    m = re.search(r"= [\d.]+/([\d.]+)/", o)
    return f"{float(m.group(1)):.0f} ms" if c == 0 and m else "no answer"


def test_wifi():
    rows, ok = [], False
    _, out, _ = run(["iw", "dev"], timeout=4)
    m = re.search(r"Interface (\S+)", out)
    if not m:
        return {"ok": False, "rows": [["Wi-Fi", "no wireless adapter"]]}
    dev = m.group(1)
    _, link, _ = run(["iw", "dev", dev, "link"], timeout=4)
    if not link or "Not connected" in link:
        return {"ok": False, "rows": [["Wi-Fi", f"{dev}: not connected"]]}
    for label, rx in (("Network", r"SSID: (.+)"), ("Signal", r"signal: (.+)"), ("Speed", r"tx bitrate: (\S+ \S+)"), ("Band", r"freq: ([\d.]+)")):
        mm = re.search(rx, link)
        if mm:
            v = mm.group(1)
            rows.append([label, f"{float(v) / 1000:.1f} GHz" if label == "Band" else v])
    _, ipo, _ = run(["ip", "-4", "-o", "addr", "show", dev], timeout=3)
    mm = re.search(r"inet (\S+)", ipo)
    rows.append(["Address", mm.group(1) if mm else "none"])
    _, rt, _ = run(["ip", "route", "show", "default"], timeout=3)
    gw = re.search(r"via (\S+)", rt)
    if gw:
        rows.append(["Router ping", ping_ms(gw.group(1))])
    net = ping_ms("1.1.1.1")
    rows.append(["Internet ping", net])
    import socket
    try:
        socket.getaddrinfo("debian.org", 443)
        rows.append(["DNS", "works"])
        ok = net != "no answer"
    except OSError:
        rows.append(["DNS", "fails"])
    return {"ok": ok, "rows": rows}


def test_bluetooth():
    if not have("bluetoothctl"):
        return {"ok": None, "rows": [["Bluetooth", "bluetoothctl not installed"]]}
    _, show, _ = run(["bluetoothctl", "show"], timeout=5)
    if "Controller" not in show:
        return {"ok": False, "rows": [["Bluetooth", "no adapter found"]]}
    addr = re.search(r"Controller (\S+)", show).group(1)
    powered = "Powered: yes" in show
    rows = [["Adapter", addr], ["Powered", "yes" if powered else "no (turn it on in Settings › Bluetooth)"]]
    if powered:
        run(["bluetoothctl", "--timeout", "6", "scan", "on"], timeout=10)
        _, devs, _ = run(["bluetoothctl", "devices"], timeout=5)
        names = [l.split(" ", 2)[2] for l in devs.splitlines() if l.startswith("Device") and l.count(" ") >= 2]
        rows.append(["Devices nearby", str(len(names))])
        rows += [["", n] for n in names[:6]]
    return {"ok": powered, "rows": rows}


def test_modem():
    m = modem_index()
    if m is None:
        return {"ok": None, "rows": [["Modem", "no 4G modem attached"]]}
    _, out, _ = run(["mmcli", "-m", m], timeout=6)
    rows = []
    for label, key in (("Model", "model"), ("State", "state"), ("Signal", "signal quality"), ("Operator", "operator name"), ("SIM", "primary sim path")):
        mm = re.search(r"\|\s*" + key + r":\s*(.+)", out)
        if mm:
            rows.append([label, mm.group(1).strip()])
    return {"ok": "registered" in out or "connected" in out, "rows": rows}


def test_audio():
    _, play, _ = run(["aplay", "-l"], timeout=4)
    _, cap, _ = run(["arecord", "-l"], timeout=4)
    outs = re.findall(r"card \d+: \S+ \[([^\]]+)\]", play)
    ins = re.findall(r"card \d+: \S+ \[([^\]]+)\]", cap)
    rows = [["Output", n] for n in outs] or [["Output", "none"]]
    rows += [["Microphone", n] for n in ins] or [["Microphone", "none (plug in a USB mic or headset)"]]
    ok = bool(outs)
    if have("wpctl"):
        _, st, _ = run(["wpctl", "inspect", "@DEFAULT_AUDIO_SINK@"], timeout=4)
        mm = re.search(r'node.description = "([^"]+)"', st)
        default = mm.group(1) if mm else "none"
        rows.append(["Default output", default])
        if not mm or "Dummy" in default:
            # nothing that makes sound: the Pi 5 has no headphone jack and most panels no speaker
            ok = False
            rows.append(["Tip", "connect a USB or Bluetooth speaker/headphones, or an HDMI screen with speakers"])
    return {"ok": ok, "rows": rows, "mic": bool(ins)}


MIC_WAV = os.path.join(HOME, ".cache", "skyglass", "mictest.wav")


def test_mic():
    if not have("arecord"):
        return {"ok": None, "rows": [["Microphone", "arecord not installed"]]}
    _, cap, _ = run(["arecord", "-l"], timeout=4)
    if "card " not in cap:
        return {"ok": None, "rows": [["Microphone", "none fitted (plug in a USB mic or headset)"]]}
    os.makedirs(os.path.dirname(MIC_WAV), exist_ok=True)
    code, _, err = run(["arecord", "-q", "-d", "3", "-f", "S16_LE", "-r", "16000", "-c", "1", MIC_WAV], timeout=8)
    if code != 0:
        return {"ok": False, "rows": [["Microphone", (err.splitlines() or ["no microphone"])[-1][:120]]]}
    with open(MIC_WAV, "rb") as f:
        data = f.read()[44:]
    n = len(data) // 2
    samples = struct.unpack("<%dh" % n, data[:n * 2]) if n else ()
    peak = max((abs(x) for x in samples), default=0)
    rms = (sum(x * x for x in samples) / n) ** .5 if n else 0
    return {"ok": peak > 1500, "rows": [["Peak level", f"{peak * 100 / 32768:.0f} %"], ["Average level", f"{rms * 100 / 32768:.1f} %"]],
            "wav": "/api/test/mic.wav?v=" + str(int(time.time()))}


def test_storage():
    path = os.path.join(HOME, ".cache", "skyglass", "speedtest.bin")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    size, block = 64 * 1024 * 1024, os.urandom(1024 * 1024)
    try:
        t0 = time.time()
        with open(path, "wb") as f:
            for _ in range(size // len(block)):
                f.write(block)
            f.flush()
            os.fsync(f.fileno())
        w = size / (time.time() - t0) / 1e6
        priv("drop-caches", timeout=10)  # read from the card, not RAM
        t0 = time.time()
        with open(path, "rb") as f:
            while f.read(4 * 1024 * 1024):
                pass
        r = size / (time.time() - t0) / 1e6
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    st = os.statvfs(HOME)
    dev = "?"
    for line in (read("/proc/mounts", "") or "").splitlines():
        f = line.split()
        if len(f) > 1 and f[1] == "/":
            dev = f[0]
    return {"ok": w > 5 and r > 15, "rows": [["Write", f"{w:.0f} MB/s"], ["Read", f"{r:.0f} MB/s"], ["Device", dev],
            ["Free", f"{st.f_bavail * st.f_frsize / 1e9:.1f} of {st.f_blocks * st.f_frsize / 1e9:.1f} GB"]]}


def test_stress(seconds=10):
    """All cores busy for a few seconds: does it stay cool and keep its clock?"""
    n = os.cpu_count() or 4
    procs = [subprocess.Popen(["python3", "-c", "while True: pass"]) for _ in range(n)]
    series = []
    try:
        for _ in range(seconds):
            time.sleep(1)
            t = read("/sys/class/thermal/thermal_zone0/temp")
            f = read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq")
            series.append([round(int(t) / 1000, 1) if t and t.isdigit() else None, round(int(f) / 1000) if f and f.isdigit() else None])
    finally:
        for p in procs:
            p.kill()
        for p in procs:
            p.wait()
    temps = [s[0] for s in series if s[0] is not None]
    freqs = [s[1] for s in series if s[1] is not None]
    val, flags = throttled()
    ok = bool(temps) and max(temps) < 82 and not (val & 0xE)
    rows = [["Cores loaded", str(n)], ["Start → end", f"{temps[0]:.1f} → {temps[-1]:.1f} °C" if temps else "?"],
            ["Lowest clock", f"{min(freqs)} MHz" if freqs else "?"], ["Throttling", ", ".join(flags) if flags else "none"]]
    return {"ok": ok, "rows": rows, "series": series}


def test_camera():
    if not have("rpicam-hello"):
        return {"ok": None, "rows": [["Camera", "rpicam-apps not installed"]], "camera": False}
    _, out, err = run(["rpicam-hello", "--list-cameras"], timeout=10)
    cams = re.findall(r"^\s*\d+ : (\S+) \[([^\]]+)\]", out + "\n" + err, re.M)
    if not cams:
        return {"ok": False, "rows": [["Camera", "no camera module found"]], "camera": False}
    return {"ok": True, "rows": [[f"Camera {i}", f"{n} ({r})"] for i, (n, r) in enumerate(cams)], "camera": True}


def test_usb():
    _, out, _ = run(["lsusb"], timeout=5)
    rows = [["", re.sub(r"^Bus \d+ Device \d+: ID \S+ ", "", l)] for l in out.splitlines() if "root hub" not in l]
    rows += [["Drive", f"{d['label']} · {'mounted' if d['mounted'] else 'not mounted'}"] for d in usb_drives()]
    return {"ok": None, "rows": rows or [["USB", "nothing plugged in"]]}


def test_info():
    model = (read("/proc/device-tree/model", "") or "").rstrip("\x00")
    rows = [["Model", model or os.uname().machine]]
    for line in (read("/proc/cpuinfo", "") or "").splitlines():
        if line.startswith(("Serial", "Revision")):
            k, _, v = line.partition(":")
            rows.append([k.strip(), v.strip()])
    rows += [["Kernel", os.uname().release], ["Memory page", f"{os.sysconf('SC_PAGE_SIZE') // 1024} KB"],
             ["Skyglass", f"{VERSION} \"{CODENAME}\""]]
    fw = vcgen("version").splitlines()
    if fw:
        rows.append(["Firmware", fw[0]])
    if have("rpi-eeprom-update"):
        _, ee, _ = run(["rpi-eeprom-update"], timeout=8)
        mm = re.search(r"CURRENT: (.+)", ee)
        if mm:
            rows.append(["Bootloader", mm.group(1).strip()])
    if os.path.isdir("/sys/class/rtc/rtc0"):
        rows.append(["Real-time clock", f"{read('/sys/class/rtc/rtc0/date', '')} {read('/sys/class/rtc/rtc0/time', '')} UTC"])
    rows += [["Input", n] for n in re.findall(r'N: Name="([^"]+)"', read("/proc/bus/input/devices", "") or "") if "hdmi" not in n.lower()]
    if have("wlr-randr"):
        _, wr, _ = run(["wlr-randr"], timeout=4)
        mm = re.search(r"(\d+x\d+) px, ([\d.]+) Hz \([^)]*current", wr)
        if mm:
            rows.append(["Screen mode", f"{mm.group(1)} @ {float(mm.group(2)):.0f} Hz"])
    return {"ok": None, "rows": rows}


LED = "/sys/class/leds/ACT"


def test_led(on):
    if not os.path.isdir(LED):
        return {"ok": None, "rows": [["LED", "no activity LED"]]}
    # on: blink the green ACT LED; off: back to normal (flashes on SD card activity)
    priv("act-led", "timer" if on else "mmc0")
    return {"ok": True, "rows": []}


TESTS = {"sensors": test_sensors, "power": test_power, "wifi": test_wifi, "bluetooth": test_bluetooth, "modem": test_modem,
         "audio": test_audio, "mic": test_mic, "storage": test_storage, "stress": test_stress, "camera": test_camera,
         "usb": test_usb, "info": test_info}
_test_lock = threading.Lock()


def run_test(name, arg=False):
    if name == "led":
        return test_led(arg)
    fn = TESTS.get(name)
    if not fn:
        return {"ok": False, "rows": [["Error", "no such test"]]}
    if not _test_lock.acquire(blocking=False):  # stress / speed tests must not overlap
        return {"ok": None, "rows": [["Busy", "another test is still running"]]}
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 — a broken test must not break the menu
        return {"ok": False, "rows": [["Error", str(e)[:200]]]}
    finally:
        _test_lock.release()


# --------------------------------------------------------------------------- settings
# The UI keeps its settings in localStorage, but Chromium can lose recent localStorage writes
# when the kiosk is killed (restart, power cut). The backend keeps a copy on disk, written
# atomically, and hands it to the page before app.js runs (/api/settings.js).

SETTINGS_FILE = os.path.join(HOME, ".config", "skyglass", "settings.json")


def settings_load():
    try:
        with open(SETTINGS_FILE) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def settings_save(d):
    if d is None:  # "reset settings" in Developer
        try:
            os.remove(SETTINGS_FILE)
        except OSError:
            pass
        return {"ok": True}
    if not isinstance(d, dict):
        return {"ok": False, "message": "settings must be an object"}
    data = json.dumps(d)
    if len(data) > 65536:
        return {"ok": False, "message": "settings too large"}
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, SETTINGS_FILE)
    return {"ok": True}


# --------------------------------------------------------------------------- custom wallpaper
# The chosen picture is copied (and shrunk to screen size with ffmpeg, so the GPU never has to
# hold a 12-megapixel texture) to ~/.config/skyglass/wallpaper.jpg. The original stays untouched.

WALL_DIR = os.path.join(HOME, ".config", "skyglass")
WALL_SHIPPED = os.path.abspath(os.path.join(HERE, "..", "..", "..", "share", "skyglass", "wallpapers"))
WALL_EXT = (".jpg", ".jpeg", ".png", ".webp")


def wallpaper_file():
    for f in sorted(glob.glob(os.path.join(WALL_DIR, "wallpaper.*"))):
        if f.lower().endswith(WALL_EXT):
            return f
    return None


def wallpaper_set(path):
    src = os.path.abspath(os.path.expanduser(str(path or "")))
    if not src.lower().endswith(WALL_EXT):
        return {"ok": False, "message": "Pick a JPG, PNG or WebP picture"}
    try:
        st = os.stat(src)
    except OSError:
        return {"ok": False, "message": "That picture doesn't exist anymore"}
    if not os.path.isfile(src) or st.st_size > 80 * 1024 * 1024:
        return {"ok": False, "message": "That file can't be used as a wallpaper"}
    os.makedirs(WALL_DIR, exist_ok=True)
    tmp = os.path.join(WALL_DIR, ".wallpaper-new.jpg")
    ok = False
    if have("ffmpeg"):
        code, _, _ = run(["ffmpeg", "-v", "error", "-y", "-i", src, "-frames:v", "1", "-vf",
                          "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease",
                          "-q:v", "3", tmp], timeout=60)
        ok = code == 0 and os.path.exists(tmp)
    if not ok:  # no ffmpeg (or it failed): use the picture as it is
        tmp = os.path.join(WALL_DIR, ".wallpaper-new" + os.path.splitext(src)[1].lower())
        try:
            with open(src, "rb") as a, open(tmp, "wb") as b:
                b.write(a.read())
        except OSError as e:
            return {"ok": False, "message": str(e)}
    for old in glob.glob(os.path.join(WALL_DIR, "wallpaper.*")):
        try:
            os.remove(old)
        except OSError:
            pass
    os.replace(tmp, os.path.join(WALL_DIR, "wallpaper" + os.path.splitext(tmp)[1]))
    return {"ok": True, "v": int(time.time() * 1000)}


def wallpaper_list():
    """Pictures that can become the wallpaper: the ones shipped with Skyglass, then the
    user's (Pictures, Downloads, Desktop, USB drives), newest first."""
    def scan(root, depth=4):
        out = []
        root = os.path.abspath(root)
        base = root.count(os.sep)
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".")] if dirpath.count(os.sep) - base < depth else []
            for f in files:
                if f.lower().endswith(WALL_EXT) and not f.startswith("."):
                    fp = os.path.join(dirpath, f)
                    try:
                        out.append((os.path.getmtime(fp), fp))
                    except OSError:
                        pass
        return out
    shipped = sorted(p for _, p in scan(WALL_SHIPPED, 0))
    mine = []
    for root in ("Pictures", "Downloads", "Desktop"):
        mine += scan(os.path.join(HOME, root))
    if os.path.isdir(USB_ROOT):
        mine += scan(USB_ROOT, 3)
    mine.sort(reverse=True)
    return {"shipped": shipped, "photos": [p for _, p in mine[:300]], "custom": wallpaper_file() is not None}


# --------------------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "Skyglass/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("SKYGLASS_DEBUG"):
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, cache=False):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return self.send_json({"error": "not found"}, 404)
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except ValueError:
            return {}

    def guard(self):
        # Only the local shell may talk to us (blocks DNS-rebinding style tricks).
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        # Fetch metadata: Chromium marks every request with where it came from. A website open in
        # the browser may not use us at all, not even with GET through <img>/<script>/<audio>
        # (camera stream, files, settings.js). Our own UI is "same-origin"; typing the address
        # yourself is "none"; tools like curl send nothing.
        return self.headers.get("Sec-Fetch-Site") not in ("cross-site", "same-site")

    def same_origin(self):
        # A website open in the phone's browser could otherwise POST to 127.0.0.1:7777
        # (reboot, PIN, terminal...). Allow only the shell itself, our nav-bar extension,
        # and tools without an Origin (curl over ssh).
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        if origin.startswith("chrome-extension://"):   # the browser bar may only close the browser
            return urlparse(self.path).path == "/api/browser/close"
        return origin == "http://" + (self.headers.get("Host") or "")

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        self._safe(self._get)

    def do_POST(self):
        self._safe(self._post)

    def _safe(self, fn):
        try:
            fn()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001 — log it, answer, keep serving
            import traceback
            traceback.print_exc()
            try:
                self.send_json({"error": f"internal error: {e}"}, 500)
            except Exception:
                pass

    def _get(self):
        if not self.guard():
            return self.send_json({"error": "forbidden"}, 403)
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path

        if p == "/api/status":
            return self.send_json(status())
        if p == "/api/test/mic.wav":
            return self.send_file(MIC_WAV) if os.path.exists(MIC_WAV) else self.send_json({"error": "no recording"}, 404)
        if p == "/api/wallpaper":
            f = wallpaper_file()
            return self.send_file(f, cache=True) if f else self.send_json({"error": "no wallpaper"}, 404)
        if p == "/api/wallpapers":
            return self.send_json(wallpaper_list())
        if p == "/api/settings.js":
            body = ("window.SG_SAVED = " + json.dumps(settings_load()) + ";\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(body)
        if p == "/api/about":
            return self.send_json(about())
        if p == "/api/pin":
            return self.send_json({"set": pin_load() is not None,
                                   "locked_for": max(0, round(_pin_fail["until"] - time.time()))})
        if p == "/api/events":
            items, last = EVENTS.wait(int(q.get("since", 0)))
            return self.send_json({"events": items, "last": last})
        if p == "/api/wifi/scan":
            return self.send_json(wifi_scan())
        if p == "/api/sms":
            return self.send_json(sms_list())
        if p == "/api/apps":
            return self.send_json({"apps": APPS.list()})
        if p == "/api/icon":
            ic = find_icon(q.get("name", ""))
            return self.send_file(ic, cache=True) if ic else self.send_json({}, 404)
        if p == "/api/files":
            return self.send_json(list_dir(q.get("path")))
        if p == "/api/file":
            return self.send_file(os.path.abspath(os.path.expanduser(q.get("path", ""))))
        if p == "/api/touch/samples":
            with CALIB.lock:
                return self.send_json({"samples": list(CALIB.samples), "active": CALIB.active})
        if p == "/api/photos":
            return self.send_json(list_photos())
        if p == "/api/brightness":
            bl, mx, cur = backlight()
            return self.send_json({"hw": bool(bl), "percent": round(cur * 100 / mx) if mx else 100})
        if p == "/api/term/read":
            t = TERMS.get(q.get("id"))
            if not t:
                return self.send_json({"error": "gone", "alive": False})
            data, pos, alive = t.read(int(q.get("pos", 0)))
            return self.send_json({"data": data, "pos": pos, "alive": alive})
        if p == "/api/camera/stream":
            return self.stream_camera()
        if p == "/api/music":
            return self.send_json(list_music())
        if p == "/api/sysmon":
            return self.send_json(sysmon())
        if p == "/api/video/edit":
            job = VideoJob.jobs.get(q.get("id"))
            return self.send_json(job.state() if job else {"error": "no such job"})
        if p == "/api/rotate":
            pend = rotate_pending()
            return self.send_json({"rotation": current_rotation(), "pending": bool(pend),
                                   "left": max(0, round(pend["deadline"] - time.time())) if pend else 0})
        if p == "/api/skyglass-update":
            return self.send_json(skyglass_update_state(force=q.get("force") == "1"))
        if p == "/api/sudo":
            return self.send_json(sudo_state())
        if p == "/api/led":
            return self.send_json(led({"cmd": "status"}))
        if p == "/api/notifications":
            return self.send_json(NOTIFS.list())
        if p == "/api/bluetooth/devices":
            return self.send_json(bt_devices())
        if p == "/api/updates":
            return self.send_json(updates_state())
        if p == "/api/hotspot":
            return self.send_json(hotspot_state())
        if p == "/api/keyboard":
            return self.send_json(keyboard_state())
        if p == "/api/android":
            return self.send_json(android_status())
        if p == "/api/bluetooth":
            return self.send_json(bluetooth_state())
        if p == "/api/time":
            return self.send_json(time_state())
        if p == "/api/time/zones":
            return self.send_json(list_zones())
        if p == "/api/usb/debug":
            return self.send_json(usb_debug())
        if p == "/api/thumb":
            t = thumb(q.get("path", ""), int(q.get("size", "320") or 320))
            return self.send_file(t, cache=True) if t else self.send_json({"error": "no preview"}, 404)
        if p == "/api/storage":
            return self.send_json(storage())
        if p == "/api/usb":
            return self.send_json({"drives": usb_drives()})
        if p == "/api/files/copy":
            job = CopyJob.jobs.get(q.get("id"))
            return self.send_json(job.state() if job else {"error": "no such job"})
        if p == "/api/camera/record":
            r = CAMERA.rec
            return self.send_json({"recording": bool(r), "started": r[2] if r else None})
        if p == "/api/search/suggest":
            return self.send_json(sky_suggest(q.get("q")))
        if p == "/api/search/answer":
            return self.send_json(sky_answer(q.get("q")))

        # static files
        rel = "index.html" if p in ("/", "") else p.lstrip("/")
        full = os.path.abspath(os.path.join(WEB, rel))
        if not full.startswith(WEB + os.sep) or not os.path.isfile(full):
            return self.send_json({"error": "not found"}, 404)
        return self.send_file(full, cache="/vendor/" in full)

    def stream_camera(self):
        if not CAMERA.available():
            return self.send_json({"error": "no camera"}, 404)
        CAMERA.start()
        CAMERA.clients += 1
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        last = None
        try:
            while True:
                with CAMERA.cond:
                    CAMERA.cond.wait(2)
                    frame = CAMERA.frame
                if frame is None or frame is last:
                    continue
                last = frame
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(frame))
                self.wfile.write(frame + b"\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            CAMERA.clients -= 1
            if CAMERA.clients <= 0:
                CAMERA.stop()
            self.close_connection = True

    # ---------------------------------------------------------------- POST
    def _post(self):
        if not self.guard() or not self.same_origin():
            return self.send_json({"error": "forbidden"}, 403)
        p = urlparse(self.path).path
        b = self.body()

        if p == "/api/touch/calibrate/start":
            return self.send_json(CALIB.start())
        if p == "/api/touch/calibrate/finish":
            return self.send_json(CALIB.finish(b.get("points") or []))
        if p == "/api/touch/calibrate/cancel":
            CALIB.active = False
            return self.send_json({"ok": True})
        if p == "/api/touch/calibrate/request":  # open the calibration screen remotely (ssh/curl)
            EVENTS.emit("calibrate")
            return self.send_json({"ok": True})
        if p == "/api/heartbeat":
            if not HEARTBEAT["last"]:   # the UI is up: end the boot light (and an old "UI froze" error)
                threading.Thread(target=lambda: (led({"cmd": "clear", "layer": "boot"}),
                                                 led({"cmd": "clear", "layer": "alert:ui"})), daemon=True).start()
            HEARTBEAT["last"] = time.time()
            return self.send_json({"ok": True})
        if p == "/api/settings":
            return self.send_json(settings_save(b.get("settings")))
        if p == "/api/test":  # POST only: tests like the CPU stress must not be triggerable by a web page
            return self.send_json(run_test(str(b.get("name", "")), bool(b.get("on"))))
        if p == "/api/wallpaper":  # also works over ssh: curl -X POST -d '{"path":"..."}' 127.0.0.1:7777/api/wallpaper
            r = wallpaper_set(b.get("path"))
            if r.get("ok"):
                src = os.path.abspath(os.path.expanduser(str(b.get("path"))))
                saved = settings_load() or {}
                saved.update(wallpaper="custom", wallV=r["v"], wallSrc=src)  # sticks even if no UI is running
                settings_save(saved)
                EVENTS.emit("wallpaper", v=r["v"], path=src)
            return self.send_json(r)
        if p == "/api/pin/verify":
            return self.send_json(pin_check(b.get("pin")))
        if p == "/api/pin/set":
            return self.send_json(pin_set(b.get("old"), b.get("new")))
        if p == "/api/pin/clear":
            return self.send_json(pin_set(b.get("old"), None))
        if p == "/api/wifi/connect":
            return self.send_json(wifi_connect(b.get("ssid", ""), b.get("password")))
        if p == "/api/call":
            return self.send_json(modem_call(b.get("number", "")))
        if p == "/api/hangup":
            return self.send_json(modem_hangup(b.get("call", "")))
        if p == "/api/sms/send":
            return self.send_json(sms_send(b.get("number", ""), b.get("text", "")))
        if p == "/api/brightness":
            return self.send_json(set_brightness(int(b.get("percent", 100))))
        if p == "/api/volume":
            return self.send_json(set_volume(b.get("percent", 50)))
        if p == "/api/power":
            return self.send_json(power(b.get("action", "")))
        if p == "/api/screen":
            return self.send_json(screen(bool(b.get("on", True))))
        if p == "/api/rotate":
            return self.send_json(rotate(b.get("deg", 0)))
        if p == "/api/rotate/confirm":
            try:
                os.remove(ROT_PENDING)
            except OSError:
                pass
            return self.send_json({"ok": True})
        if p == "/api/rotate/revert":
            pend = rotate_pending()
            if pend:
                os.remove(ROT_PENDING)
                return self.send_json(rotate(pend.get("prev", 0), confirm=False))
            return self.send_json({"ok": False})
        if p == "/api/skyglass-update":
            return self.send_json(skyglass_update_start(str(b.get("action", "update"))))
        if p == "/api/sudo":  # {"mode": "full"|"strict", "pin", "password"}
            return self.send_json(sudo_set(b))
        if p == "/api/user-password":  # {"new", "pin", "current"}
            return self.send_json(user_password_set(b))
        if p == "/api/led":
            return self.send_json(led_api(b))
        if p == "/api/notify":  # also over ssh / scripts: curl -X POST -d '{"title":"Hi","body":"..."}' 127.0.0.1:7777/api/notify
            n = notify(b.get("app") or "System", b.get("title"), b.get("body"), icon=b.get("icon", ""),
                       open_app=b.get("open", ""), key=b.get("key", ""), urgency=b.get("urgency", "normal"))
            return self.send_json({"ok": bool(n), "id": n and n["id"]})
        if p == "/api/notifications/dismiss":
            nid = b.get("id")
            return self.send_json(NOTIFS.dismiss(nid=int(nid) if str(nid).isdigit() else None, app=b.get("app")))
        if p == "/api/notifications/read":
            return self.send_json(NOTIFS.mark_read())
        if p == "/api/bluetooth/device":
            return self.send_json(bt_action(str(b.get("action", "")), b.get("mac")))
        if p == "/api/updates":
            return self.send_json(updates_start(b.get("install")))
        if p == "/api/hotspot":
            return self.send_json(hotspot_set(bool(b.get("on")), b.get("ssid"), b.get("password")))
        if p == "/api/keyboard":
            return self.send_json(keyboard_set(b))
        if p == "/api/ui/restart":
            restart_session()
            return self.send_json({"ok": True})
        if p == "/api/android":  # POST {"action": "open"|"stop"}
            return self.send_json(android_action(str(b.get("action", "")), b))
        if p == "/api/apps/launch":
            return self.send_json(APPS.launch(app_id=b.get("id")))
        if p == "/api/browser":
            url = str(b.get("url") or "https://duckduckgo.com")
            if not re.match(r"https?://", url):
                return self.send_json({"ok": False, "message": "only web addresses can be opened"})
            return self.send_json(browser_open(url))
        if p == "/api/browser/close":
            closed = browser_close()
            if b.get("home"):
                EVENTS.emit("home")
            return self.send_json({"ok": closed})
        if p == "/api/camera/snap":
            return self.send_json(CAMERA.snap(b.get("to"), bool(b.get("hq"))))
        if p == "/api/camera/record/start":
            return self.send_json(CAMERA.record_start(b.get("to")))
        if p == "/api/camera/record/stop":
            return self.send_json(CAMERA.record_stop())
        if p == "/api/bluetooth":
            code, out, err = priv("bluetooth", "on" if b.get("on") else "off")
            return self.send_json({"ok": code == 0, "message": err.strip()})
        if p == "/api/time":
            if "timezone" in b:
                tz = str(b["timezone"])
                if tz not in list_zones()["zones"]:
                    return self.send_json({"ok": False, "message": "unknown time zone"})
                code, out, err = priv("timezone", tz)
            else:
                code, out, err = priv("ntp", "on" if b.get("ntp") else "off")
            return self.send_json({"ok": code == 0, "message": err.strip()})
        if p == "/api/hostname":
            name = str(b.get("name", "")).strip().lower()
            if not re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?", name):
                return self.send_json({"ok": False, "message": "Use letters, numbers and - only"})
            code, out, err = priv("hostname", name)
            return self.send_json({"ok": code == 0, "message": err.strip()})
        if p == "/api/storage/clean":
            return self.send_json(clean_caches())
        if p == "/api/files/delete":
            return self.send_json(delete_files(b.get("paths")))
        if p == "/api/photo/save":
            return self.send_json(save_image(b))
        if p == "/api/video/edit":
            src = safe_path(b.get("path"))
            if not src or not os.path.isfile(src):
                return self.send_json({"ok": False, "message": "video not found"})
            if not have("ffmpeg"):
                return self.send_json({"ok": False, "message": "Video editing needs ffmpeg:  sudo apt install ffmpeg"})
            try:
                start, end = float(b.get("start", 0)), float(b.get("end", 0))
                rot = int(b.get("rotate", 0)) % 360
            except (TypeError, ValueError):
                return self.send_json({"ok": False, "message": "bad trim values"})
            if end <= start:
                return self.send_json({"ok": False, "message": "the end must be after the start"})
            return self.send_json({"ok": True, **VideoJob(src, start, end, bool(b.get("mute")), rot, bool(b.get("replace"))).state()})
        if p == "/api/usb/mount":
            return self.send_json(usb_mount(str(b.get("dev", ""))))
        if p == "/api/usb/eject":
            return self.send_json(usb_eject(str(b.get("dev", ""))))
        if p == "/api/files/copy":
            paths = [os.path.abspath(os.path.expanduser(str(x))) for x in (b.get("paths") or []) if isinstance(x, str)]
            dest = b.get("dest")
            dest = usb_folder() if dest == "usb" else os.path.abspath(os.path.expanduser(str(dest or "")))
            if dest and not os.path.isdir(dest) and any(d["mounted"] and os.path.dirname(dest) == d["mountpoint"] for d in usb_drives()):
                os.makedirs(dest, exist_ok=True)  # e.g. <stick>/Skyglass
            if not dest or not os.path.isdir(dest):
                return self.send_json({"ok": False, "message": "No USB drive connected" if b.get("dest") == "usb" else "Destination not found"})
            if not os.access(dest, os.W_OK):
                return self.send_json({"ok": False, "message": "Can't write there (read-only drive?)"})
            paths = [x for x in paths if os.path.isfile(x)]
            if not paths:
                return self.send_json({"ok": False, "message": "Nothing to copy"})
            return self.send_json({"ok": True, "dest": dest, **CopyJob(paths, dest, bool(b.get("move"))).state()})
        if p == "/api/term/start":
            for tid, t in list(TERMS.items()):  # reap idle sessions
                if not t.alive or time.time() - t.touched > 3600:
                    t.kill()
                    TERMS.pop(tid, None)
            tid = uuid.uuid4().hex
            TERMS[tid] = Term()
            return self.send_json({"id": tid})
        if p == "/api/term/write":
            t = TERMS.get(b.get("id"))
            if t:
                t.write(b.get("data", ""))
            return self.send_json({"ok": bool(t)})
        if p == "/api/term/resize":
            t = TERMS.get(b.get("id"))
            if t:
                t.resize(int(b.get("cols", 80)), int(b.get("rows", 24)))
            return self.send_json({"ok": bool(t)})
        if p == "/api/file/write":
            path = os.path.abspath(os.path.expanduser(b.get("path", "")))
            if not path.startswith(HOME + os.sep):
                return self.send_json({"ok": False, "message": "only inside home"})
            with open(path, "wb") as f:
                f.write(base64.b64decode(b.get("b64", "")))
            return self.send_json({"ok": True})
        return self.send_json({"error": "unknown endpoint"}, 404)


def main():
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    threading.Thread(target=power_button_thread, daemon=True).start()
    threading.Thread(target=ui_watchdog_thread, daemon=True).start()
    if ON_DEVICE:
        threading.Thread(target=usb_watch_thread, daemon=True).start()
        threading.Thread(target=battery_watch_thread, daemon=True).start()
        threading.Thread(target=sms_watch_thread, daemon=True).start()
    threading.Thread(target=rotate_watch_thread, daemon=True).start()
    if ON_DEVICE:
        threading.Thread(target=power_watch_thread, daemon=True).start()
        threading.Timer(8, repair_report_once).start()
    ThreadingHTTPServer.allow_reuse_address = True
    for attempt in range(30):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
            break
        except OSError:
            time.sleep(0.5)
    else:
        raise SystemExit(f"port {PORT} busy")
    srv.daemon_threads = True
    print(f"Skyglass shell on http://127.0.0.1:{PORT}  (device mode: {ON_DEVICE})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
