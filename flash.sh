#!/bin/bash
# Flash Skyglass OS onto an SD card (or USB/NVMe) in one go.
#
#   sudo ./flash.sh                  build the image if needed, pick the card, choose your PIN, flash
#   sudo ./flash.sh my.img           flash a specific image
#   sudo ./flash.sh my.img /dev/sdb  ...to a specific card (still asks before erasing)
#
# Optional extras it asks about: your lock-screen PIN and a Wi-Fi network, so the
# phone boots straight into a locked, online Skyglass.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || exec sudo -E "$0" "$@"

b=$'\e[1m'; c=$'\e[38;5;39m'; red=$'\e[31m'; r=$'\e[0m'
say() { echo "${c}==>${r} ${b}$*${r}"; }
die() { echo "${red}error:${r} $*" >&2; exit 1; }

# ---------------------------------------------------------------- image
IMG=${1:-}
if [ -z "$IMG" ]; then
  IMG=$(ls -t "$HERE"/skyglass-os-*.img 2>/dev/null | head -1 || true)
  if [ -z "$IMG" ]; then
    say "No Skyglass image yet."
    read -rp "Build one now? Takes 20-60 min and needs internet. [Y/n] " a
    [[ "${a:-y}" =~ ^[Yy] ]] || die "nothing to flash"
    "$HERE/build/build-image.sh"
    IMG=$(ls -t "$HERE"/skyglass-os-*.img | head -1)
  fi
fi
[ -f "$IMG" ] || die "image not found: $IMG"
say "Image: $IMG ($(du -h "$IMG" | cut -f1))"

# ---------------------------------------------------------------- target disk
sys_disks() {  # disks holding the running system: never offer these
  for m in / /boot /boot/efi /home /usr /var; do
    s=$(findmnt -no SOURCE "$m" 2>/dev/null) || continue
    lsblk -no PKNAME "$s" 2>/dev/null; lsblk -dno NAME "$s" 2>/dev/null
  done | sed 's|^|/dev/|' | sort -u
}
SYS=$(sys_disks)
DEV=${2:-}
if [ -z "$DEV" ]; then
  mapfile -t CANDS < <(lsblk -dpno NAME,RM,TYPE,TRAN | awk '$3=="disk" && ($2=="1" || $4=="usb" || $4=="mmc") {print $1}' | grep -vxF "$SYS" || true)
  [ ${#CANDS[@]} -gt 0 ] || die "no SD card / USB drive found. Insert one, or pass the device: sudo ./flash.sh $IMG /dev/sdX"
  echo; echo "Removable drives:"
  for i in "${!CANDS[@]}"; do
    printf '  %s) %s\n' "$((i + 1))" "$(lsblk -dno NAME,SIZE,MODEL,TRAN "${CANDS[$i]}" | xargs)"
  done
  if [ ${#CANDS[@]} -eq 1 ]; then n=1; else read -rp "Pick one [1-${#CANDS[@]}]: " n; fi
  [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le ${#CANDS[@]} ] || die "invalid choice"
  DEV=${CANDS[$((n - 1))]}
fi
[ -b "$DEV" ] && [ "$(lsblk -dno TYPE "$DEV")" = disk ] || die "$DEV is not a whole disk"
grep -qxF "$DEV" <<<"$SYS" && die "$DEV holds your running system. Refusing."
IMG_BYTES=$(stat -c %s "$IMG"); DEV_BYTES=$(lsblk -bdno SIZE "$DEV")
[ "$DEV_BYTES" -ge "$IMG_BYTES" ] || die "$DEV is smaller than the image"

# ---------------------------------------------------------------- PIN + Wi-Fi
echo
say "Lock-screen PIN"
echo "Choose the 4-8 digit PIN you'll type to unlock the phone."
echo "Leave it empty to choose it on the phone at first unlock instead."
PIN=""
while :; do
  read -rsp "PIN: " PIN; echo
  [ -z "$PIN" ] && break
  [[ "$PIN" =~ ^[0-9]{4,8}$ ]] || { echo "  4 to 8 digits, numbers only."; continue; }
  read -rsp "Again: " PIN2; echo
  [ "$PIN" = "$PIN2" ] && break
  echo "  Didn't match, try again."
done

echo
say "Wi-Fi (optional)"
read -rp "Network name (empty to skip): " SSID
WIFI_PW=""
[ -n "$SSID" ] && { read -rsp "Password (empty for open network): " WIFI_PW; echo; }

# ---------------------------------------------------------------- confirm + write
echo
echo "${red}${b}Everything on this drive will be erased:${r}"
lsblk -o NAME,SIZE,MODEL,FSTYPE,LABEL,MOUNTPOINTS "$DEV"
read -rp "Type ${b}yes${r} to flash $DEV: " ok
[ "$ok" = yes ] || die "cancelled"

say "Unmounting $DEV"
for p in $(lsblk -lnpo NAME "$DEV" | tail -n +2); do umount "$p" 2>/dev/null || true; done

say "Writing image (don't unplug!)"
dd if="$IMG" of="$DEV" bs=4M conv=fsync oflag=direct status=progress
sync
partprobe "$DEV" 2>/dev/null || blockdev --rereadpt "$DEV" 2>/dev/null || true
sleep 2; udevadm settle 2>/dev/null || true

# ---------------------------------------------------------------- personalise
if [ -n "$PIN" ] || [ -n "$SSID" ]; then
  say "Personalising"
  ROOTP=$(lsblk -lnpo NAME "$DEV" | sed -n 3p)
  [ -b "$ROOTP" ] || die "could not find the root partition on $DEV (image is flashed, but PIN/Wi-Fi not set — do it on the phone)"
  MNT=$(mktemp -d); trap 'umount "$MNT" 2>/dev/null; rmdir "$MNT" 2>/dev/null' EXIT
  mount "$ROOTP" "$MNT"
  IDS=$(awk -F: '$1=="skyglass"{print $3":"$4}' "$MNT/etc/passwd")
  [ -n "$IDS" ] || die "no 'skyglass' user in image"

  if [ -n "$PIN" ]; then
    D="$MNT/home/skyglass/.config/skyglass"
    mkdir -p "$D"
    PIN="$PIN" python3 -c '
import hashlib, json, os, sys
salt = os.urandom(16).hex()
h = hashlib.pbkdf2_hmac("sha256", os.environ["PIN"].encode(), bytes.fromhex(salt), 200000).hex()
json.dump({"salt": salt, "hash": h, "iter": 200000}, sys.stdout)' >"$D/pin.json"
    chmod 600 "$D/pin.json"
    chown -R "$IDS" "$MNT/home/skyglass/.config"
    echo "  PIN saved."
  fi

  if [ -n "$SSID" ]; then
    NM="$MNT/etc/NetworkManager/system-connections"
    mkdir -p "$NM"
    F="$NM/$(echo "$SSID" | tr -c 'A-Za-z0-9._-' '_').nmconnection"
    {
      echo "[connection]"; echo "id=$SSID"; echo "type=wifi"; echo "autoconnect=true"
      echo; echo "[wifi]"; echo "mode=infrastructure"; echo "ssid=$SSID"
      if [ -n "$WIFI_PW" ]; then echo; echo "[wifi-security]"; echo "key-mgmt=wpa-psk"; echo "psk=$WIFI_PW"; fi
      echo; echo "[ipv4]"; echo "method=auto"; echo; echo "[ipv6]"; echo "method=auto"
    } >"$F"
    chmod 600 "$F"; chown root:root "$F"
    echo "  Wi-Fi \"$SSID\" saved."
  fi
  sync; umount "$MNT"
fi

eject "$DEV" 2>/dev/null || true
echo
say "Done! Put the card in the Pi 5, plug in the Freenove screen (HDMI + USB) and power on."
[ -z "$PIN" ] && echo "    You'll choose your PIN the first time you swipe up."
exit 0
