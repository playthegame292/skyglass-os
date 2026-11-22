#!/bin/bash
# Turns a Debian (arm64) root filesystem into Skyglass OS.
# Runs as root INSIDE the target: either in the image builder's chroot or on a live Pi.
#   configure-rootfs.sh /path/to/skyglass-os/rootfs
set -euo pipefail
OVERLAY=${1:?usage: configure-rootfs.sh <overlay dir>}
USER_NAME=${SKYGLASS_USER:-skyglass}
HOST_NAME=${SKYGLASS_HOSTNAME:-skyglass}

echo ">> copying Skyglass files"
cp -a --no-preserve=ownership "$OVERLAY"/. /   # files must be root-owned (sudo refuses otherwise)
chmod 0440 /etc/sudoers.d/010-skyglass
chmod +x /usr/local/bin/* /usr/local/sbin/* /usr/lib/skyglass/shell/server.py

echo ">> user '$USER_NAME' (no password, passwordless sudo)"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -c "Skyglass" "$USER_NAME"
  passwd -d "$USER_NAME" >/dev/null   # only for a new user: an update keeps a password you set
fi
for g in sudo video render input audio netdev plugdev dialout gpio i2c spi bluetooth; do
  getent group "$g" >/dev/null && usermod -aG "$g" "$USER_NAME"
done
cp -n /etc/skel/.bash_profile "/home/$USER_NAME/.bash_profile" 2>/dev/null || true
grep -q skyglass-session "/home/$USER_NAME/.bash_profile" || cat /etc/skel/.bash_profile >>"/home/$USER_NAME/.bash_profile"
if [ "$USER_NAME" != skyglass ]; then
  sed -i "s/^skyglass /$USER_NAME /" /etc/sudoers.d/010-skyglass
  sed -i "s/--autologin skyglass/--autologin $USER_NAME/" /etc/systemd/system/getty@tty1.service.d/autologin.conf
fi
mkdir -p "/home/$USER_NAME/Pictures/Skyglass"
chown -R "$USER_NAME:$USER_NAME" "/home/$USER_NAME"
visudo -cf /etc/sudoers.d/010-skyglass >/dev/null

echo ">> identity"
echo "$HOST_NAME" >/etc/hostname
grep -q "$HOST_NAME" /etc/hosts || echo "127.0.1.1 $HOST_NAME" >>/etc/hosts
# Keep ID=debian so every Debian tool still works; just rebrand the pretty name.
if [ -L /etc/os-release ] || ! grep -q Skyglass /etc/os-release; then
  src=$(readlink -f /etc/os-release); tmp=$(mktemp)
  sed -e 's/^PRETTY_NAME=.*/PRETTY_NAME="Skyglass OS 1.0 (Bubble) — Debian based"/' "$src" >"$tmp"
  rm -f /etc/os-release; mv "$tmp" /etc/os-release; chmod 644 /etc/os-release
fi
cat >/etc/issue <<'EOF'

   .-~~~-.     Skyglass OS 1.0 "Bubble"
  ( o  o  )    \n on \l
   '-._.-'     the shell starts on the touchscreen (tty1)

EOF
cat >/etc/motd <<'EOF'

  ~ Skyglass OS ~  Debian underneath, bubbles on top.
  skyfetch · aero · skyglass-display info

EOF

echo ">> locale"
if [ -f /etc/locale.gen ]; then
  sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen
  locale-gen >/dev/null 2>&1 || true
  echo 'LANG=en_US.UTF-8' >/etc/default/locale
fi

echo ">> on-screen keyboard (squeekboard pops up on text fields)"
command -v glib-compile-schemas >/dev/null && glib-compile-schemas /usr/share/glib-2.0/schemas 2>/dev/null || true

echo ">> services"
mkdir -p /etc/skyglass; touch /etc/skyglass/display.conf
# the LED pins are yours to change: never overwrite an existing led.conf
[ -f /etc/skyglass/led.conf ] || cp /usr/share/skyglass/led.conf.default /etc/skyglass/led.conf
[ "$USER_NAME" != skyglass ] && sed -i "s/^SOCKET_GROUP=.*/SOCKET_GROUP=$USER_NAME/" /etc/skyglass/led.conf
grep -q '^ROTATION=' /etc/skyglass/display.conf || echo 'ROTATION=0' >>/etc/skyglass/display.conf
systemctl enable NetworkManager ssh skyglass-firstboot skyglass-led skyglass-repair 2>/dev/null || true
systemctl set-default multi-user.target
# Quiet, fast boot to the shell
systemctl mask systemd-networkd-wait-online.service NetworkManager-wait-online.service 2>/dev/null || true

echo ">> power: switch off what a phone never uses"
# printing, NFS, nightly apt/man-db runs (apt is still there: sudo apt update / install anytime)
for u in cups.service cups.socket cups.path cups-browsed.service rpcbind.service rpcbind.socket nfs-blkmap.service \
         nfs-client.target man-db.timer apt-daily.timer apt-daily-upgrade.timer packagekit.service; do
  systemctl disable "$u" >/dev/null 2>&1 || true
done
# cloud-init only matters on the very first boot of a Raspberry Pi Imager card; after that it just slows boot
[ -d /etc/cloud ] && touch /etc/cloud/cloud-init.disabled

echo ">> self-repair: known-good copy, checksums, boot backup"
# skyglass-repair restores damaged Skyglass files from this copy after a power cut, and
# skyglass-update keeps the previous one for --rollback
SRCTREE=$(cd "$OVERLAY/.." && pwd)
STATE=/var/lib/skyglass; mkdir -p "$STATE"
if [ "$SRCTREE" != "$STATE/source" ]; then
  rm -rf "$STATE/source.new"; mkdir -p "$STATE/source.new"
  tar -C "$SRCTREE" --exclude=./.git --exclude=__pycache__ --exclude='./build/*.img*' --exclude=./build/work \
    --exclude='./purchasings*.txt' -cf - . | tar -C "$STATE/source.new" -xf -
  if [ -d "$STATE/source" ] && ! cmp -s "$STATE/source/VERSION" "$STATE/source.new/VERSION" 2>/dev/null; then
    rm -rf "$STATE/source.prev"; mv "$STATE/source" "$STATE/source.prev"
  fi
  rm -rf "$STATE/source"; mv "$STATE/source.new" "$STATE/source"
fi
install -D -m 644 "$STATE/source/VERSION" /usr/share/skyglass/VERSION 2>/dev/null || true
# checksums of every file Skyglass installs (not your own config files in /etc/skyglass)
(cd "$STATE/source/rootfs" && find . -type f ! -path './etc/skyglass/*' -printf '/%P\n' | sort) |
  while IFS= read -r f; do [ -f "$f" ] && sha256sum "$f"; done >"$STATE/manifest.sha256"
BOOT=/boot/firmware; [ -d $BOOT ] || BOOT=/boot
mkdir -p "$STATE/boot-backup"
for f in config.txt cmdline.txt; do [ -s "$BOOT/$f" ] && cp "$BOOT/$f" "$STATE/boot-backup/$f"; done
[ -f /etc/skyglass/update.conf ] || cp /usr/share/skyglass/update.conf.default /etc/skyglass/update.conf
# keep the system log across reboots: after a power cut it shows what happened before
mkdir -p /var/log/journal

echo ">> Skyglass configured"
