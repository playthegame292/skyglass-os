#!/bin/bash
# Turn an existing Raspberry Pi 5 running Debian trixie / Raspberry Pi OS Lite (64-bit,
# trixie) into Skyglass OS. The quickest way to get going: flash "Raspberry Pi OS Lite
# (64-bit)" with Raspberry Pi Imager, boot it, copy this folder over, then:
#
#   sudo ./install-on-pi.sh
#
# For a from-scratch image instead (no Raspberry Pi OS at all), use build/build-image.sh.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"
grep -q 'Raspberry Pi 5' /proc/device-tree/model 2>/dev/null || echo "warning: this does not look like a Raspberry Pi 5 — continuing anyway"

echo "==> Installing packages"
apt-get update
# packages.txt targets a bare Debian; on a running Pi skip the kernel/boot bits it already has
PKGS=$(grep -v '^\s*#' "$HERE/build/packages.txt" | grep -v '^\s*$' |
  grep -Ev '^(linux-image-rpi-2712|raspi-firmware|initramfs-tools|systemd-sysv|cloud-guest-utils)$')
# shellcheck disable=SC2086
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $PKGS

echo "==> Configuring"
bash "$HERE/build/configure-rootfs.sh" "$HERE/rootfs"
systemctl disable skyglass-firstboot 2>/dev/null || true   # partition is already grown on a live system
systemctl restart systemd-logind 2>/dev/null || true
systemctl restart skyglass-led 2>/dev/null || true   # the RGB LED (see /etc/skyglass/led.conf)

BOOT=/boot/firmware; [ -d $BOOT ] || BOOT=/boot
if ! grep -q skyglass-panel $BOOT/config.txt; then
  printf '\n# Skyglass OS\n# skyglass-panel\nhdmi_force_hotplug=1\ndisable_splash=1\n' >>$BOOT/config.txt
fi
grep -q 'vt.global_cursor_default=0' $BOOT/cmdline.txt || sed -i '1s/$/ quiet loglevel=3 logo.nologo vt.global_cursor_default=0 console=tty3/' $BOOT/cmdline.txt
# Raspberry Pi OS starts its own desktop/login manager; Skyglass replaces it on tty1
systemctl disable lightdm 2>/dev/null || true
systemctl set-default multi-user.target

echo
echo "==> Health check"
/usr/local/bin/skyglass-doctor || true
echo
echo "==> Skyglass OS installed. Reboot to start:  sudo reboot"
