#!/bin/bash
# Skyglass test suite: run before every flash.   ./tests/run.sh
# Checks script syntax, the backend API (with a throwaway home folder) and the whole UI.
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD; fails=0; PORT=7788
ok()  { echo "  ✔ $1"; }
bad() { echo "  ✘ $1"; fails=$((fails + 1)); }

echo "Syntax"
for f in install-on-pi.sh flash.sh preview.sh build/*.sh tools/*.sh rootfs/usr/local/bin/* rootfs/usr/local/sbin/*; do
  head -1 "$f" | grep -q bash || continue
  bash -n "$f" 2>/dev/null && ok "$f" || bad "$f has a syntax error"
done
python3 -m py_compile rootfs/usr/lib/skyglass/shell/server.py && ok "server.py" || bad "server.py"
for py in rootfs/usr/local/sbin/skyglass-ledd rootfs/usr/local/bin/skyglass-led rootfs/usr/local/bin/skyglass-notifyd rootfs/usr/lib/skyglass/android-fetch.py; do
  python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$py" && ok "$(basename "$py")" || bad "$py has a syntax error"
done
python3 -c "import struct,sys; sys.path.insert(0,'rootfs/usr/local/sbin'); import importlib.machinery as m; d=m.SourceFileLoader('ledd','rootfs/usr/local/sbin/skyglass-ledd').load_module(); assert struct.calcsize(d.REQ_FMT)==592 and d.GPIO_V2_GET_LINE_IOCTL==0xC250B407 and d.GPIO_V2_LINE_SET_VALUES_IOCTL==0xC010B40F" 2>/dev/null \
  && ok "GPIO ioctl layouts match the kernel's" || bad "GPIO ioctl struct sizes wrong"
for js in rootfs/usr/lib/skyglass/shell/web/*.js rootfs/usr/lib/skyglass/shell/web/games/*.js; do node --check "$js" && ok "$(basename "$js")" || bad "$js"; done
python3 -c "import sys, xml.dom.minidom as m; [m.parse(f) for f in sys.argv[1:]]" rootfs/etc/skyglass/labwc/rc.xml rootfs/etc/skyglass/labwc/menu.xml \
  && ok "labwc config is valid XML" || bad "labwc config broken (the UI would fall back to cage)"
grep -q 'screen-keyboard-enabled=true' rootfs/usr/share/glib-2.0/schemas/90_skyglass.gschema.override && [ -s rootfs/usr/share/skyglass/squeekboard/style.css ] \
  && ok "squeekboard pop-up setting + Aero theme" || bad "squeekboard files missing"
# config.txt has no end-of-line comments: "kernel=kernel8.img  # note" made the firmware look for a
# file with that whole name and silently boot the default kernel (Android setup then looped forever)
! grep -nE '^[A-Za-z0-9_]+=[^#]*[[:space:]]#' boot/config.txt && ! grep -nE "printf .*\\n[A-Za-z0-9_]+=[^\\]*[[:space:]]#" install-on-pi.sh rootfs/usr/local/bin/skyglass-android \
  && ok "boot config lines have no trailing comments" || bad "trailing comment in a config.txt line (the Pi firmware breaks on it)"
# updates must never clear the password: passwd -d only for a brand-new user
python3 - <<'PYEOF' && ok "updates keep the password (cleared only on first install)" || bad "an update could clear the user's password"
import re, sys
src = open("build/configure-rootfs.sh").read()
blocks = re.findall(r'if ! id "\$USER_NAME".*?\nfi', src, re.S)
outside = src
for b in blocks: outside = outside.replace(b, "")
sys.exit(0 if blocks and "passwd -d" in blocks[0] and not re.search(r"passwd -d|chpasswd|usermod -p", outside) else 1)
PYEOF
if command -v visudo >/dev/null; then   # both sudo modes must be valid sudoers files (a broken one locks sudo)
  for m in full strict; do
    T=$(mktemp)
    (U=skyglass; eval "$(sed -n '/^template() {/,/^}/p' rootfs/usr/local/sbin/skyglass-sudo-mode)"; template $m) >"$T"
    visudo -cf "$T" >/dev/null && grep -q '^skyglass ALL' "$T" && ok "sudoers ($m mode) is valid" || bad "sudoers $m mode invalid (would break sudo!)"; rm -f "$T"
  done
fi
grep -q 'NOPASSWD: /usr/local/sbin/skyglass-priv" ;;' rootfs/usr/local/sbin/skyglass-sudo-mode && ! grep -q 'NOPASSWD:.*skyglass-sudo-mode' rootfs/usr/local/sbin/skyglass-sudo-mode \
  && ok "strict mode: only skyglass-priv runs without a password (not the mode switch)" || bad "strict mode lets more than skyglass-priv run without a password"
! grep -rn '"sudo", "-n", "\(tee\|sh\|mount\|umount\|systemctl\|apt-get\|rfkill\|timedatectl\|hostnamectl\|sed\|mkdir\|rmdir\|chown\|dmesg\|journalctl\)"' rootfs/usr/lib/skyglass/shell/server.py \
  && ok "the backend only uses root through skyglass-priv" || bad "the backend runs a raw command as root (use skyglass-priv)"
find rootfs -name __pycache__ -exec rm -rf {} + 2>/dev/null

echo "Self-repair"
R=$(mktemp -d)
mkdir -p "$R/state/source/rootfs$R/sys" "$R/sys" "$R/boot"
echo good >"$R/state/source/rootfs$R/sys/app.conf"; echo good >"$R/sys/app.conf"
echo "#!/bin/sh" >"$R/state/source/rootfs$R/sys/gone.sh"; cp "$R/state/source/rootfs$R/sys/gone.sh" "$R/sys/gone.sh"
(cd / && sha256sum "$R/sys/app.conf" "$R/sys/gone.sh") >"$R/state/manifest.sha256"
printf 'kernel=kernel8.img\n' >"$R/boot/config.txt"; mkdir -p "$R/state/boot-backup"; cp "$R/boot/config.txt" "$R/state/boot-backup/"
printf 'console=tty1 root=PARTUUID=x\n' >"$R/boot/cmdline.txt"; cp "$R/boot/cmdline.txt" "$R/state/boot-backup/"
date +%s >"$R/state/running"                       # the last boot never shut down cleanly
echo "garbled" >"$R/sys/app.conf"; rm "$R/sys/gone.sh"; : >"$R/boot/config.txt"; printf '\x00\x00' >"$R/boot/cmdline.txt"
RENV="SKYGLASS_STATE=$R/state SKYGLASS_BOOT=$R/boot SKYGLASS_REPAIR_REPORT=$R/report.json"
env $RENV bash rootfs/usr/local/sbin/skyglass-repair >/dev/null 2>&1
[ "$(cat "$R/sys/app.conf")" = good ] && [ -f "$R/sys/gone.sh" ] && ok "damaged and missing files restored from the known-good copy" || bad "file repair"
grep -q kernel8 "$R/boot/config.txt" && grep -q root= "$R/boot/cmdline.txt" && ok "emptied/garbled boot config restored" || bad "boot config repair"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['unclean'] and any('Repaired 2' in n for n in d['notes'])" "$R/report.json" && ok "power cut noticed and reported" || bad "repair report"
env $RENV bash rootfs/usr/local/sbin/skyglass-repair --shutdown; env $RENV bash rootfs/usr/local/sbin/skyglass-repair >/dev/null 2>&1
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert not d['unclean'] and not d['notes']" "$R/report.json" && ok "clean shutdown: nothing to report" || bad "clean shutdown detection"
[ -z "$(env $RENV bash rootfs/usr/local/sbin/skyglass-repair --check | grep -v 'all good')" ] && ok "--check on a running system: no false power-cut alarm" || bad "--check reports a power cut on a healthy running system"
echo "# edited" >>"$R/boot/config.txt"; env $RENV bash rootfs/usr/local/sbin/skyglass-repair >/dev/null 2>&1
grep -q edited "$R/state/boot-backup/config.txt" && ok "your own config.txt edits become the new backup" || bad "boot backup update"
rm -rf "$R"

echo "Root helper (skyglass-priv refuses anything outside its list)"
priv_refuses() {   # runs the helper as if root, but only with arguments it must reject before doing anything
  python3 - "$@" <<'PYEOF' >/dev/null 2>&1
import importlib.machinery, os, sys
os.geteuid = lambda: 0
os.environ["SUDO_USER"] = os.environ.get("USER", "nobody")
m = importlib.machinery.SourceFileLoader("priv", "rootfs/usr/local/sbin/skyglass-priv").load_module()
try:
    m.main(sys.argv[1:])
except SystemExit as e:
    sys.exit(0 if e.code == 2 else 1)
sys.exit(1)
PYEOF
}
for bad_args in "rm -rf /" "power now" "rotate 45" "touch-matrix 1;reboot" "apt install evil" "conf-set PATH /tmp" "conf-set COMPOSITOR \$(reboot)" \
                "usb-mount /dev/mmcblk0p2" "usb-mount /dev/../etc/shadow" "usb-umount /" "usb-umount /media/skyglass-usb/../../etc" \
                "timezone ../../etc/passwd" "hostname a;reboot" "act-led evil" "bluetooth maybe" "skyglass-update --evil" "waydroid-container restart"; do
  # shellcheck disable=SC2086
  priv_refuses $bad_args && ok "refuses: skyglass-priv $bad_args" || bad "skyglass-priv accepted: $bad_args"
done
rm -rf rootfs/usr/local/sbin/__pycache__

echo "Backend API"
TMPH=$(mktemp -d)
# the RGB LED service, simulated (no GPIO): the backend talks to it like on the phone
printf 'LEDS="17,27,22 5,6,13"\nBACKEND=sim\n' >"$TMPH/led.conf"
export SKYGLASS_LED_SOCK=$TMPH/led.sock
# a service restart long after boot (an update) must not bring back the blue boot light
printf 'LEDS="17,27,22"\nBACKEND=sim\n' >"$TMPH/led2.conf"
SKYGLASS_LED_CONF=$TMPH/led2.conf SKYGLASS_LED_SOCK=$TMPH/led2.sock SKYGLASS_LED_PREFS=$TMPH/led2.json SKYGLASS_LED_UPTIME=3600 \
  python3 rootfs/usr/local/sbin/skyglass-ledd 2>/dev/null & LEDD2=$!
for _ in $(seq 30); do [ -S "$TMPH/led2.sock" ] && break; sleep 0.1; done
SKYGLASS_LED_SOCK=$TMPH/led2.sock python3 rootfs/usr/local/bin/skyglass-led status | grep -q '"active": null' && ok "LED: no boot light when the service restarts later (updates)" || bad "LED boot light after a service restart"
kill $LEDD2 2>/dev/null
SKYGLASS_LED_CONF=$TMPH/led.conf SKYGLASS_LED_PREFS=$TMPH/led-prefs.json SKYGLASS_LED_UPTIME=10 python3 rootfs/usr/local/sbin/skyglass-ledd 2>"$TMPH/led.log" &
LEDD=$!
HOME=$TMPH SKYGLASS_PORT=$PORT python3 rootfs/usr/lib/skyglass/shell/server.py >"$TMPH/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV $LEDD 2>/dev/null; rm -rf "$TMPH"; find "$ROOT/rootfs" -name __pycache__ -exec rm -rf {} + 2>/dev/null' EXIT
for _ in $(seq 50); do curl -fs "127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && break; sleep 0.1; done
get()  { curl -fs -m 15 "127.0.0.1:$PORT$1"; }
post() { curl -s -m 15 -X POST -H 'Content-Type: application/json' -d "$2" "127.0.0.1:$PORT$1"; }
for ep in /api/status /api/about /api/pin /api/apps /api/files /api/photos /api/brightness /api/sms; do
  get "$ep" | python3 -c 'import sys,json; json.load(sys.stdin)' 2>/dev/null && ok "GET $ep" || bad "GET $ep"
done
get / | grep -q '<title>Skyglass' && ok "UI page served" || bad "UI page"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.com' "127.0.0.1:$PORT/api/status")" = 403 ] && ok "foreign Host header blocked" || bad "Host check"
for ep in "/api/settings.js" "/api/camera/stream" "/api/file?path=/etc/hostname" "/api/status"; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Sec-Fetch-Site: cross-site' "127.0.0.1:$PORT$ep")" = 403 ] || { bad "a website can GET $ep"; continue; }
  ok "websites can't GET $ep (img/script tricks)"
done
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Sec-Fetch-Site: same-origin' "127.0.0.1:$PORT/api/status")" = 200 ] && ok "the phone's own UI still gets through" || bad "same-origin requests blocked"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: chrome-extension://abc' -d '{}' "127.0.0.1:$PORT/api/term/start")" = 403 ] && ok "the browser extension may only close the browser" || bad "extension origin can start a terminal"
[ "$(curl -s -o /dev/null -w '%{http_code}' "127.0.0.1:$PORT/../../etc/passwd")" = 404 ] && ok "path traversal blocked" || bad "path traversal"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -d '{}' "127.0.0.1:$PORT/api/power")" = 403 ] && ok "websites can't send commands to the phone" || bad "cross-site POST allowed"
post /api/pin/set '{"new":"12"}' | grep -q '"ok": false' && ok "too-short PIN refused" || bad "short PIN accepted"
post /api/pin/set '{"new":"2468"}' | grep -q '"ok": true' && ok "PIN set" || bad "PIN set"
post /api/pin/verify '{"pin":"0000"}' | grep -q '"ok": false' && ok "wrong PIN rejected" || bad "wrong PIN accepted!"
post /api/pin/verify '{"pin":"2468"}' | grep -q '"ok": true' && ok "right PIN accepted" || bad "right PIN rejected"
# right after a good PIN (the wrong-try counter is at 0): this one wrong try can't add up to a lockout
cp "$TMPH/.config/skyglass/pin.json" "$TMPH/pin.bak"; printf '{"salt": "x", "ha' >"$TMPH/.config/skyglass/pin.json"
get /api/pin | grep -q '"set": true' && post /api/pin/verify '{"pin":"2468"}' | grep -q '"ok": false' && ok "a damaged PIN file keeps the phone locked" || bad "a damaged PIN file unlocks the phone!"
mv "$TMPH/pin.bak" "$TMPH/.config/skyglass/pin.json"
post /api/pin/verify '{"pin":"2468"}' >/dev/null   # a right PIN resets the wrong-try counter (it lives in the backend's memory)
post /api/pin/set '{"old":"9999","new":"1357"}' | grep -q '"ok": false' && ok "PIN change needs the old PIN" || bad "PIN changed without old PIN!"
post /api/pin/verify '{"pin":["not","a","string"]}' | python3 -c 'import sys,json; json.load(sys.stdin)' && ok "garbage input handled" || bad "garbage input crashed a request"
curl -s -m 5 -X POST -H 'Content-Type: application/json' -d '{not json' "127.0.0.1:$PORT/api/pin/verify" | grep -q '"ok"' && ok "malformed JSON handled" || bad "malformed JSON"
WP="$ROOT/rootfs/usr/share/skyglass/wallpapers/aero-lagoon.jpg"
get /api/wallpapers | grep -q 'aero-lagoon.jpg' && ok "shipped wallpapers listed" || bad "shipped wallpapers missing"
post /api/wallpaper "{\"path\":\"$WP\"}" | grep -q '"ok": true' && ok "custom wallpaper set" || bad "custom wallpaper"
[ "$(curl -s -o /dev/null -w '%{content_type}' "127.0.0.1:$PORT/api/wallpaper")" = image/jpeg ] && ok "custom wallpaper served" || bad "custom wallpaper not served"
post /api/wallpaper '{"path":"/etc/passwd"}' | grep -q '"ok": false' && ok "non-picture wallpaper refused" || bad "non-picture accepted as wallpaper"
get /api/settings.js | grep -q '"wallpaper": "custom"' && ok "wallpaper choice saved on disk" || bad "wallpaper choice not saved"
post /api/settings '{"settings":{"theme":"aqua"}}' | grep -q '"ok": true' && get /api/settings.js | grep -q '"theme": "aqua"' && ok "settings survive a browser restart" || bad "settings not saved"
post /api/test '{"name":"info"}' | grep -q '"rows"' && ok "test mode backend answers" || bad "test mode backend"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -d '{"name":"stress"}' "127.0.0.1:$PORT/api/test")" = 403 ] && ok "websites can't start hardware tests" || bad "cross-site test allowed"
post /api/settings '{"settings":null}' >/dev/null; get /api/settings.js | grep -q 'SG_SAVED = null' && ok "settings reset" || bad "settings reset"
TID=$(post /api/term/start '{}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
post /api/term/write "{\"id\":\"$TID\",\"data\":\"echo sky$((6*7))\\r\"}" >/dev/null; sleep 1
get "/api/term/read?id=$TID&pos=0" | grep -q sky42 && ok "terminal runs commands" || bad "terminal"
LAST=$(get "/api/events?since=999999999" | python3 -c 'import sys,json; print(json.load(sys.stdin)["last"])')
( sleep 1; post /api/touch/calibrate/request '{}' >/dev/null ) &
get "/api/events?since=$LAST" | grep -q '"calibrate"' && ok "events reach the UI (power button etc.)" || bad "event channel broken"
mkdir -p "$TMPH/Pictures" "$TMPH/dest"; head -c 3000000 /dev/urandom >"$TMPH/Pictures/test.jpg"
JOB=$(post /api/files/copy "{\"paths\":[\"$TMPH/Pictures/test.jpg\"],\"dest\":\"$TMPH/dest\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))')
for _ in $(seq 30); do get "/api/files/copy?id=$JOB" | grep -q '"finished": true' && break; sleep 0.2; done
cmp -s "$TMPH/Pictures/test.jpg" "$TMPH/dest/test.jpg" && ok "copying files works (phone → USB path)" || bad "file copy"
JOB=$(post /api/files/copy "{\"paths\":[\"$TMPH/Pictures/test.jpg\"],\"dest\":\"$TMPH/dest\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))'); sleep 1
[ -f "$TMPH/dest/test (1).jpg" ] && ok "copy never overwrites (test (1).jpg)" || bad "copy overwrote a file"
post /api/files/copy '{"paths":[],"dest":"usb"}' | grep -q '"ok": false' && ok "copy to a missing USB drive is refused" || bad "usb copy check"
get /api/usb | python3 -c 'import sys,json; assert "drives" in json.load(sys.stdin)' && ok "GET /api/usb" || bad "GET /api/usb"
rm -rf "$TMPH/dest"
if command -v ffmpeg >/dev/null; then
  ffmpeg -loglevel error -f lavfi -i testsrc2=size=3000x2000 -frames:v 1 "$TMPH/Pictures/big.jpg"
  BYTES=$(curl -s "127.0.0.1:$PORT/api/thumb?size=320&path=$TMPH/Pictures/big.jpg" | wc -c)
  [ "$BYTES" -gt 1000 ] && [ "$BYTES" -lt 60000 ] && ok "photo previews are small ($BYTES bytes)" || bad "thumbnail ($BYTES bytes)"
fi
[ "$(curl -s -o /dev/null -w '%{http_code}' "127.0.0.1:$PORT/assets/3DBenchy.stl.gz")" = 200 ] && ok "3D model served compressed" || bad "Benchy .gz missing"
PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
SAVED=$(post /api/photo/save "{\"name\":\"Sketch_test\",\"data\":\"$PNG\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("path",""))')
[ -f "$SAVED" ] && ok "saving an edited photo / sketch" || bad "photo save"
post /api/files/delete "{\"paths\":[\"$SAVED\"]}" | grep -q '"deleted": 1' && [ ! -f "$SAVED" ] && ok "deleting a photo" || bad "delete"
post /api/files/delete '{"paths":["/etc/hostname"]}' | grep -q '"deleted": 0' && [ -f /etc/hostname ] && ok "can't delete system files" || bad "deleted outside home!"
NID=$(post /api/notify '{"app":"Test","title":"Hi","body":"<b>markup</b> removed"}' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id") or "")')
[ -n "$NID" ] && get /api/notifications | grep -q '"body": "markup removed"' && ok "notifications stored (markup stripped)" || bad "notify"
post /api/notify '{"title":"Battery","key":"k1"}' >/dev/null; post /api/notify '{"title":"Battery 2","key":"k1"}' >/dev/null
[ "$(get /api/notifications | grep -o '"key": "k1"' | wc -l)" = 1 ] && ok "a notification with the same key replaces the old one" || bad "notification key replace"
post /api/notifications/dismiss "{\"id\":$NID}" | grep -q '"dismissed": 1' && ok "dismiss one notification" || bad "dismiss"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -d '{"title":"phish"}' "127.0.0.1:$PORT/api/notify")" = 403 ] && ok "websites can't post notifications" || bad "cross-site notify allowed"
post /api/notifications/dismiss '{}' | grep -q '"ok": true' && ok "clear all notifications" || bad "clear all"
for ep in /api/keyboard /api/updates /api/hotspot /api/bluetooth/devices; do get "$ep" | python3 -c 'import sys,json; json.load(sys.stdin)' && ok "GET $ep" || bad "GET $ep"; done
post /api/keyboard '{"layout":"../../etc"}' | grep -q '"ok": false' && ok "bad keyboard layout refused" || bad "keyboard layout check"
post /api/bluetooth/device '{"action":"pair","mac":"; reboot"}' | grep -q '"ok": false' && ok "bad Bluetooth address refused" || bad "bluetooth address check"
post /api/android '{"action":"install","path":"/etc/passwd"}' | grep -q '"ok": false' && ok "only .apk files install into Android" || bad "android install check"
led_now() { get /api/led | python3 -c 'import sys,json; print(json.load(sys.stdin).get("active"))'; }
[ "$(led_now)" = boot ] && ok "LED service: boot light on start" || bad "LED boot light"
post /api/heartbeat '{}' >/dev/null; sleep 0.3
[ "$(led_now)" = None ] && ok "LED: boot light ends when the UI is up" || bad "LED boot light not cleared"
post /api/led '{"cmd":"set","layer":"party","effect":"rainbow"}' | grep -q '"ok": true' && post /api/led '{"cmd":"set","layer":"flashlight","effect":"solid","color":"white"}' >/dev/null
[ "$(led_now)" = flashlight ] && ok "LED: flashlight beats party" || bad "LED priorities"
post /api/led '{"cmd":"clear","layer":"flashlight"}' >/dev/null; [ "$(led_now)" = party ] && ok "LED: party comes back after the flashlight" || bad "LED layer restore"
post /api/led '{"cmd":"set","layer":"alert:fake","effect":"blink"}' | grep -q '"ok": false' && ok "UI can't fake an error light" || bad "LED alert from UI allowed"
post /api/led '{"cmd":"set","layer":"party","effect":"nope"}' | grep -q '"ok": false' && ok "unknown LED effect refused" || bad "LED effect check"
SKYGLASS_LED_SOCK=$SKYGLASS_LED_SOCK python3 rootfs/usr/local/bin/skyglass-led error backup && [ "$(led_now)" = alert:backup ] && ok "skyglass-led error shows the error light" || bad "skyglass-led error"
SKYGLASS_LED_SOCK=$SKYGLASS_LED_SOCK python3 rootfs/usr/local/bin/skyglass-led clear 'alert:*' && post /api/led '{"cmd":"clear","layer":"party"}' >/dev/null
post /api/led '{"cmd":"prefs","prefs":{"notify":false}}' | grep -q '"notify": false' && post /api/led '{"cmd":"set","layer":"notify","effect":"flash"}' >/dev/null && [ "$(led_now)" = None ] && ok "LED: notification light can be switched off" || bad "LED prefs"
post /api/led '{"cmd":"prefs","prefs":{"notify":true}}' >/dev/null; post /api/led '{"cmd":"clear","layer":"notify"}' >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -d '{"cmd":"set","layer":"party","effect":"strobe"}' "127.0.0.1:$PORT/api/led")" = 403 ] && ok "websites can't control the LED" || bad "cross-site LED allowed"
get /api/android | python3 -c 'import sys,json; d=json.load(sys.stdin); assert "ready" in d and "apps" in d' && ok "GET /api/android" || bad "GET /api/android"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -d '{"action":"open"}' "127.0.0.1:$PORT/api/android")" = 403 ] && ok "websites can't start Android" || bad "cross-site Android start allowed"
for ep in /api/music /api/sysmon /api/rotate /api/storage /api/usb/debug /api/time /api/bluetooth; do get "$ep" | python3 -c 'import sys,json; json.load(sys.stdin)' && ok "GET $ep" || bad "GET $ep"; done
rm -f "$TMPH/.config/skyglass/pin.json" "$TMPH/.config/skyglass/pin-fail.json"
kill -0 $SRV 2>/dev/null && ok "backend survived everything" || bad "backend crashed (see log)"

echo "UI (headless Chromium)"
if command -v node >/dev/null && { command -v chromium >/dev/null || command -v google-chrome >/dev/null; }; then
  node tests/ui-test.mjs $PORT | sed 's/^/ /' ; [ "${PIPESTATUS[0]}" = 0 ] || fails=$((fails + 1))
else
  echo "  - skipped (needs node + chromium)"
fi

echo
[ "$fails" = 0 ] && echo "ALL TESTS PASSED ✔" || { echo "$fails FAILURE(S) ✘"; exit 1; }
