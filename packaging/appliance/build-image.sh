#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
OUT_DIR="${CYBEROS_IMAGE_OUT:-$ROOT_DIR/.cyberos/appliance}"
SUITE="${CYBEROS_BASE_SUITE:-bookworm}"
ARCH="${CYBEROS_TARGET_ARCH:-arm64}"
MIRROR="${CYBEROS_APT_MIRROR:-https://mirrors.aliyun.com/debian}"
MIRROR="${MIRROR%/}"
NODE_MIRROR="${CYBEROS_NODE_MIRROR:-https://mirrors.aliyun.com/nodejs-release}"
NODE_MIRROR="${NODE_MIRROR%/}"
NODE_VERSION="${CYBEROS_NODE_VERSION:-22.23.2}"
VOD_PLAYER_ENABLED="${CYBEROS_ENABLE_VOD_PLAYER:-0}"
TV_MODE_ENABLED="${CYBEROS_ENABLE_TV_MODE:-0}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf "Missing required command: %s\n" "$1" >&2
    exit 1
  fi
}

need node
PRODUCT_VERSION=$(node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.version);' "$ROOT_DIR/package.json")
DEB_PATH="${CYBEROS_DEB:-$OUT_DIR/cyberos_${PRODUCT_VERSION}_${ARCH}.deb}"
ROOTFS="$OUT_DIR/rootfs"
TARBALL="$OUT_DIR/cyberos-rootfs-${ARCH}.tar"

need mmdebstrap
need systemd-nspawn
need tar
need curl
need sha256sum

case "$VOD_PLAYER_ENABLED" in
  0|1) ;;
  *) printf "CYBEROS_ENABLE_VOD_PLAYER must be 0 or 1\n" >&2; exit 1 ;;
esac
case "$TV_MODE_ENABLED" in
  0|1) ;;
  *) printf "CYBEROS_ENABLE_TV_MODE must be 0 or 1\n" >&2; exit 1 ;;
esac
if [ "$TV_MODE_ENABLED" = "1" ]; then
  VOD_PLAYER_ENABLED=1
fi

if [ ! -f "$DEB_PATH" ]; then
  printf "Missing CyberOS deb at %s. Build it first with packaging/scripts/build-deb.sh or set CYBEROS_DEB.\n" "$DEB_PATH" >&2
  exit 1
fi

rm -rf "$ROOTFS"
install -d "$OUT_DIR"

mmdebstrap \
  --architectures="$ARCH" \
  --variant=minbase \
  --include=systemd-sysv,ca-certificates,curl,nodejs,npm,sqlite3,tmux,nginx,restic,git,rsync,network-manager,wpasupplicant,dnsmasq-base,wireless-regdb,iw,bluez,bluez-obexd,bluez-alsa-utils,libasound2-plugin-bluez,dbus-user-session,docker.io,docker-cli,docker-compose,libvirt-daemon-system,libvirt-clients,qemu-system-arm,qemu-efi-aarch64,qemu-utils,virtinst,ipxe-qemu,gzip,unzip,libarchive-tools,unrar-free,mdadm,btrfs-progs,tesseract-ocr,tesseract-ocr-chi-sim,tesseract-ocr-eng,poppler-utils,ffmpeg,libraw-bin,imagemagick,libheif-examples,libimage-exiftool-perl,libvips-tools,mpv,seatd,chromium,weston,v4l-utils,wtype,fonts-noto-core,fonts-noto-cjk,fonts-noto-color-emoji,smartmontools,samba,apache2,apache2-utils,vsftpd,libpam-pwdfile,nfs-kernel-server,minidlna \
  "$SUITE" "$ROOTFS" "$MIRROR"

case "$ARCH" in
  arm64) node_arch=arm64 ;;
  amd64) node_arch=x64 ;;
  *) printf "Unsupported Node.js architecture: %s\n" "$ARCH" >&2; exit 1 ;;
esac
node_filename="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
node_tmp=$(mktemp -d)
trap 'rm -rf "$node_tmp"' EXIT HUP INT TERM
curl -fsSL "$NODE_MIRROR/v${NODE_VERSION}/$node_filename" -o "$node_tmp/$node_filename"
curl -fsSL "$NODE_MIRROR/v${NODE_VERSION}/SHASUMS256.txt" -o "$node_tmp/SHASUMS256.txt"
node_sha256=$(awk -v filename="$node_filename" '$2 == filename { print $1; exit }' "$node_tmp/SHASUMS256.txt")
[ -n "$node_sha256" ] || { printf "Missing Node.js checksum for %s\n" "$node_filename" >&2; exit 1; }
printf '%s  %s\n' "$node_sha256" "$node_tmp/$node_filename" | sha256sum -c -
node_dir="/opt/cyberos/node/node-v${NODE_VERSION}-linux-${node_arch}"
install -d -m 0755 "$ROOTFS/opt/cyberos/node" "$ROOTFS/usr/local/bin"
tar -xJf "$node_tmp/$node_filename" -C "$ROOTFS/opt/cyberos/node"
ln -sfn "$node_dir/bin/node" "$ROOTFS/usr/local/bin/node"
ln -sfn "$node_dir/bin/npm" "$ROOTFS/usr/local/bin/npm"
ln -sfn "$node_dir/bin/npx" "$ROOTFS/usr/local/bin/npx"

cp "$DEB_PATH" "$ROOTFS/tmp/cyberos.deb"
systemd-nspawn -D "$ROOTFS" /bin/sh -eu -c "apt-get update && apt-get install -y /tmp/cyberos.deb && rm /tmp/cyberos.deb"
systemd-nspawn -D "$ROOTFS" /usr/lib/cyberos/scripts/cyberos-nginx.sh
if [ "$VOD_PLAYER_ENABLED" = "1" ]; then
  systemd-nspawn -D "$ROOTFS" /bin/sh -eu -c \
    'sed -i "/^\\[vod_player\\]/,/^\\[/ s/^enabled = false$/enabled = true/" /cyberos/config/config.toml'
  systemd-nspawn -D "$ROOTFS" systemctl enable nginx.service cyberos-hostd.service cyberos-termux.service cyberos-vod-player.service cyberos-bluetoothd.service cyberos-api.service cyberos-monitor.service cyberos-alerter.service cyberos-worker@1.service cyberos-photostaff.service cyberos-downloader.service cyberos-indexer.service cyberos-maintenance.timer cyberos-backup-daily.timer cyberos-backup-weekly.timer cyberos-health.timer
else
  systemd-nspawn -D "$ROOTFS" systemctl enable nginx.service cyberos-hostd.service cyberos-termux.service cyberos-bluetoothd.service cyberos-api.service cyberos-monitor.service cyberos-alerter.service cyberos-worker@1.service cyberos-photostaff.service cyberos-downloader.service cyberos-indexer.service cyberos-maintenance.timer cyberos-backup-daily.timer cyberos-backup-weekly.timer cyberos-health.timer
fi

if [ "$TV_MODE_ENABLED" = "1" ]; then
  install -d -m 0755 "$ROOTFS/cyberos/config/tv-mode" \
    "$ROOTFS/etc/systemd/system/cyberos-vod-player.service.d" \
    "$ROOTFS/etc/systemd/system/cyberos-api.service.d"
  install -d -m 0700 "$ROOTFS/cyberos/state/tv/control"
  printf 'enabled\n' > "$ROOTFS/cyberos/config/tv-mode/enabled"
  cat > "$ROOTFS/etc/systemd/system/cyberos-vod-player.service.d/50-cyberos-tv-mode.conf" <<'EOF'
[Service]
Environment=CYBEROS_VOD_PLAYER_ENABLED=1
Environment=CYBEROS_VOD_PLAYER_VIDEO_OUTPUT=wayland
Environment=XDG_RUNTIME_DIR=/run/cyberos-tv
Environment=WAYLAND_DISPLAY=wayland-0
EOF
  cat > "$ROOTFS/etc/systemd/system/cyberos-api.service.d/50-cyberos-tv-mode.conf" <<'EOF'
[Service]
Environment=CYBEROS_VOD_PLAYER_ENABLED=1
EOF
  cat > "$ROOTFS/cyberos/state/tv/control/desktop-state" <<'EOF'
DM_UNIT=none
DM_ENABLED=not-found
DM_ACTIVE=0
DM_MASKED=0
VOD_ACTIVE=1
API_ACTIVE=1
EOF
  chmod 0600 "$ROOTFS/cyberos/state/tv/control/desktop-state"
  systemd-nspawn -D "$ROOTFS" systemctl enable cyberos-tv.target
fi

tar --numeric-owner -C "$ROOTFS" -cpf "$TARBALL" .
printf "CyberOS appliance rootfs written to %s\n" "$TARBALL"
