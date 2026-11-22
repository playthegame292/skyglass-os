#!/bin/bash
# Build a flashable Skyglass OS image for the Raspberry Pi 5 from scratch:
# Debian trixie (arm64) + Raspberry Pi kernel/firmware + the Skyglass shell.
#
#   sudo ./build/build-image.sh                     -> skyglass-os-YYYYMMDD.img
#   sudo OUT=my.img SIZE=8G ./build/build-image.sh
#
# Works on an arm64 host natively, or on x86_64 with qemu-user binfmt.
# Arch host:   sudo pacman -S --needed debootstrap debian-archive-keyring qemu-user-static qemu-user-static-binfmt dosfstools e2fsprogs rsync
#              sudo systemctl restart systemd-binfmt
# Debian host: sudo apt install debootstrap qemu-user-static binfmt-support debian-archive-keyring dosfstools e2fsprogs rsync
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT_SRC=$(dirname "$HERE")
OUT=${OUT:-$ROOT_SRC/skyglass-os-$(date +%Y%m%d).img}
SIZE=${SIZE:-6G}
SUITE=${SUITE:-trixie}
MIRROR=${MIRROR:-http://deb.debian.org/debian}

die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
for t in debootstrap sfdisk mkfs.vfat mkfs.ext4 losetup curl gpg rsync; do command -v $t >/dev/null || die "missing tool: $t"; done
if [ "$(uname -m)" != aarch64 ] && [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
  die "no qemu-aarch64 binfmt handler: install qemu-user-static-binfmt, then: sudo systemctl restart systemd-binfmt"
fi
DEB_KEYRING=/usr/share/keyrings/debian-archive-keyring.gpg
[ -f "$DEB_KEYRING" ] || die "missing $DEB_KEYRING (install debian-archive-keyring)"

WORK=$(mktemp -d /tmp/skyglass-build.XXXX)
MNT=$WORK/mnt
LOOP=""
cleanup() {
  set +e
  for m in dev/pts dev proc sys run; do umount -l "$WORK/rootfs/$m" 2>/dev/null; done
  umount -R "$MNT" 2>/dev/null
  [ -n "$LOOP" ] && losetup -d "$LOOP"
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> Raspberry Pi archive key"
curl -fsSL https://archive.raspberrypi.com/debian/raspberrypi.gpg.key | gpg --dearmor >"$WORK/raspberrypi.gpg"

PKGS=$(grep -v '^\s*#' "$HERE/packages.txt" | grep -v '^\s*$' | tr '\n' ' ')
# WITH_ANDROID=1: also ship the 4K-page kernel (kernel8.img), so "skyglass-android setup"
# needs no kernel download. The Pi 5 still boots the default 16K kernel until setup switches.
[ "${WITH_ANDROID:-0}" = 1 ] && PKGS="$PKGS linux-image-rpi-v8"
R=$WORK/rootfs
HOOKS="/etc/kernel/postinst.d/z50-raspi-firmware /etc/initramfs/post-update.d/z50-raspi-firmware"

echo "==> Stage 1: Debian $SUITE arm64 base (slow under qemu, be patient)"
mkdir -p "$R"
debootstrap --arch=arm64 --components=main,contrib,non-free,non-free-firmware \
  --keyring="$DEB_KEYRING" --include=ca-certificates,gnupg "$SUITE" "$R" "$MIRROR"

echo "==> Stage 2: apt sources (Debian + Raspberry Pi kernel/firmware repo)"
cat >"$R/etc/apt/sources.list" <<SOURCES
deb $MIRROR $SUITE main contrib non-free non-free-firmware
deb $MIRROR $SUITE-updates main contrib non-free non-free-firmware
deb http://security.debian.org/debian-security $SUITE-security main contrib non-free non-free-firmware
deb http://archive.raspberrypi.com/debian $SUITE main
SOURCES
install -m 644 "$WORK/raspberrypi.gpg" "$R/etc/apt/trusted.gpg.d/raspberrypi.gpg"
rm -f "$R/etc/resolv.conf"
cp -L /etc/resolv.conf "$R/etc/resolv.conf" 2>/dev/null || echo "nameserver 1.1.1.1" >"$R/etc/resolv.conf"
# tailscale/systemd-resolved stub addresses don't work inside the chroot
grep -qE '^nameserver (127\.|100\.100\.100\.100)' "$R/etc/resolv.conf" && printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' >"$R/etc/resolv.conf"
mount --bind /dev "$R/dev"; mount --bind /dev/pts "$R/dev/pts"
mount -t proc proc "$R/proc"; mount -t sysfs sys "$R/sys"; mount -t tmpfs tmpfs "$R/run"
# don't start services inside the chroot
printf '#!/bin/sh\nexit 101\n' >"$R/usr/sbin/policy-rc.d"; chmod +x "$R/usr/sbin/policy-rc.d"
# the Pi firmware hook wants a mounted /boot/firmware; we copy the kernel ourselves below
mkdir -p "$R/etc/kernel/postinst.d" "$R/etc/initramfs/post-update.d"
for f in $HOOKS; do chroot "$R" dpkg-divert --local --rename --add "$f" >/dev/null; done

echo "==> Stage 3: installing packages"
chroot "$R" apt-get update
# shellcheck disable=SC2086
chroot "$R" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $PKGS

echo "==> Stage 4: Skyglass"
mkdir -p "$R/tmp/skyglass"; cp -a "$ROOT_SRC/rootfs" "$HERE/configure-rootfs.sh" "$R/tmp/skyglass/"
chroot "$R" bash /tmp/skyglass/configure-rootfs.sh /tmp/skyglass/rootfs
for f in $HOOKS; do chroot "$R" dpkg-divert --local --rename --remove "$f" >/dev/null 2>&1 || true; done
chroot "$R" apt-get clean
rm -rf "$R/tmp/skyglass" "$R/usr/sbin/policy-rc.d"
for m in dev/pts dev proc sys run; do umount -l "$R/$m"; done
ln -sf ../run/NetworkManager/resolv.conf "$R/etc/resolv.conf"


echo "==> Creating $SIZE image"
rm -f "$OUT"; truncate -s "$SIZE" "$OUT"
sfdisk -q "$OUT" <<EOF
label: dos
start=8192, size=1048576, type=c, bootable
start=1056768, type=83
EOF
LOOP=$(losetup -Pf --show "$OUT")
mkfs.vfat -F 32 -n BOOTFS "${LOOP}p1" >/dev/null
mkfs.ext4 -q -L rootfs "${LOOP}p2"
PTUUID=$(sfdisk --disk-id "$OUT" | sed 's/^0x//')

mkdir -p "$MNT"; mount "${LOOP}p2" "$MNT"
mkdir -p "$MNT/boot/firmware"; mount "${LOOP}p1" "$MNT/boot/firmware"
echo "==> Copying root filesystem"
rsync -aHAX --info=progress2 "$WORK/rootfs/" "$MNT/"

echo "==> Installing kernel, device trees and boot config for the Pi 5"
B=$MNT/boot/firmware
KVER=$(ls "$MNT/boot" | sed -n 's/^vmlinuz-\(.*-rpi-2712\)$/\1/p' | sort -V | tail -1)
[ -n "$KVER" ] || die "Pi 5 kernel (vmlinuz-*-rpi-2712) not found in rootfs"
cp "$MNT/boot/vmlinuz-$KVER" "$B/kernel_2712.img"
[ -f "$MNT/boot/initrd.img-$KVER" ] && cp "$MNT/boot/initrd.img-$KVER" "$B/initramfs_2712"
DTB=$(find "$MNT/usr/lib" -maxdepth 3 -path "*linux-image-$KVER*" -type d -name broadcom | head -1)
[ -n "$DTB" ] || die "device trees for $KVER not found"
cp "$DTB"/bcm2712*.dtb "$B/"
cp -r "$(dirname "$DTB")/overlays" "$B/"
[ -d "$MNT/usr/lib/raspi-firmware" ] && cp -rn "$MNT/usr/lib/raspi-firmware/." "$B/" 2>/dev/null || true
K8=$(ls "$MNT/boot" | sed -n 's/^vmlinuz-\(.*-rpi-v8\)$/\1/p' | sort -V | tail -1)
if [ -n "$K8" ]; then   # WITH_ANDROID=1
  cp "$MNT/boot/vmlinuz-$K8" "$B/kernel8.img"
  [ -f "$MNT/boot/initrd.img-$K8" ] && cp "$MNT/boot/initrd.img-$K8" "$B/initramfs8"
fi
cp "$ROOT_SRC/boot/config.txt" "$B/config.txt"
echo "console=serial0,115200 console=tty3 root=PARTUUID=${PTUUID}-02 rootfstype=ext4 fsck.repair=yes rootwait quiet loglevel=3 logo.nologo vt.global_cursor_default=0 cfg80211.ieee80211_regdom=US" >"$B/cmdline.txt"
cat >"$MNT/etc/fstab" <<EOF
proc                    /proc           proc  defaults          0 0
PARTUUID=${PTUUID}-01   /boot/firmware  vfat  defaults          0 2
PARTUUID=${PTUUID}-02   /               ext4  defaults,noatime  0 1
EOF

sync
echo
echo "==> Done: $OUT"
echo "    Flash it:  sudo dd if=$OUT of=/dev/sdX bs=4M conv=fsync status=progress"
echo "    (or use Raspberry Pi Imager > Use custom)"
