#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
OUT_DIR="${SIGMAOS_IMAGE_OUT:-$ROOT_DIR/.sigmaos/appliance}"
SUITE="${SIGMAOS_BASE_SUITE:-bookworm}"
ARCH="${SIGMAOS_TARGET_ARCH:-arm64}"
MIRROR="${SIGMAOS_APT_MIRROR:-https://mirrors.aliyun.com/debian}"
MIRROR="${MIRROR%/}"
NODE_MIRROR="${SIGMAOS_NODE_MIRROR:-https://mirrors.aliyun.com/nodejs-release}"
NODE_MIRROR="${NODE_MIRROR%/}"
NODE_VERSION="${SIGMAOS_NODE_VERSION:-22.23.2}"
VOD_PLAYER_ENABLED="${SIGMAOS_ENABLE_VOD_PLAYER:-0}"

legacy_player_environment=$(env | awk -F= '$1 == "SIGMAOS_ENABLE_PLAYER" || $1 ~ /^SIGMAOS_PLAYER_/ { print $1; exit }')
if [ -n "$legacy_player_environment" ]; then
  printf "%s is no longer supported; use SIGMAOS_ENABLE_VOD_PLAYER\n" "$legacy_player_environment" >&2
  exit 1
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf "Missing required command: %s\n" "$1" >&2
    exit 1
  fi
}

need node
PRODUCT_VERSION=$(node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(value.version);' "$ROOT_DIR/package.json")
DEB_PATH="${SIGMAOS_DEB:-$OUT_DIR/sigmaos_${PRODUCT_VERSION}_${ARCH}.deb}"
ROOTFS="$OUT_DIR/rootfs"
TARBALL="$OUT_DIR/sigmaos-rootfs-${ARCH}.tar"

need mmdebstrap
need systemd-nspawn
need tar
need curl
need sha256sum

case "$VOD_PLAYER_ENABLED" in
  0|1) ;;
  *) printf "SIGMAOS_ENABLE_VOD_PLAYER must be 0 or 1\n" >&2; exit 1 ;;
esac

if [ ! -f "$DEB_PATH" ]; then
  printf "Missing SigmaOS deb at %s. Build it first with packaging/scripts/build-deb.sh or set SIGMAOS_DEB.\n" "$DEB_PATH" >&2
  exit 1
fi

rm -rf "$ROOTFS"
install -d "$OUT_DIR"

mmdebstrap \
  --architectures="$ARCH" \
  --variant=minbase \
  --include=systemd-sysv,ca-certificates,curl,nodejs,npm,sqlite3,tmux,nginx,restic,git,rsync,network-manager,wpasupplicant,dnsmasq-base,wireless-regdb,iw,docker.io,docker-cli,docker-compose,libvirt-daemon-system,libvirt-clients,qemu-system-arm,qemu-efi-aarch64,qemu-utils,virtinst,ipxe-qemu,gzip,unzip,libarchive-tools,unrar-free,mdadm,btrfs-progs,tesseract-ocr,tesseract-ocr-chi-sim,tesseract-ocr-eng,poppler-utils,ffmpeg,libraw-bin,imagemagick,libheif-examples,libimage-exiftool-perl,libvips-tools,mpv,seatd,smartmontools,samba,apache2,apache2-utils,vsftpd,libpam-pwdfile,nfs-kernel-server,minidlna \
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
node_dir="/opt/sigmaos/node/node-v${NODE_VERSION}-linux-${node_arch}"
install -d -m 0755 "$ROOTFS/opt/sigmaos/node" "$ROOTFS/usr/local/bin"
tar -xJf "$node_tmp/$node_filename" -C "$ROOTFS/opt/sigmaos/node"
ln -sfn "$node_dir/bin/node" "$ROOTFS/usr/local/bin/node"
ln -sfn "$node_dir/bin/npm" "$ROOTFS/usr/local/bin/npm"
ln -sfn "$node_dir/bin/npx" "$ROOTFS/usr/local/bin/npx"

cp "$DEB_PATH" "$ROOTFS/tmp/sigmaos.deb"
systemd-nspawn -D "$ROOTFS" /bin/sh -eu -c "apt-get update && apt-get install -y /tmp/sigmaos.deb && rm /tmp/sigmaos.deb"
systemd-nspawn -D "$ROOTFS" /usr/lib/sigmaos/scripts/sigmaos-nginx.sh
if [ "$VOD_PLAYER_ENABLED" = "1" ]; then
  systemd-nspawn -D "$ROOTFS" /bin/sh -eu -c \
    'sed -i "/^\\[vod_player\\]/,/^\\[/ s/^enabled = false$/enabled = true/" /etc/sigmaos/config.toml'
  systemd-nspawn -D "$ROOTFS" systemctl enable nginx.service sigmaos-hostd.service sigmaos-termux.service sigmaos-vod-player.service sigmaos-api.service sigmaos-worker@1.service sigmaos-photostaff.service sigmaos-downloader.service sigmaos-indexer.service sigmaos-scheduler.timer sigmaos-maintenance.timer sigmaos-backup-daily.timer sigmaos-backup-weekly.timer sigmaos-health.timer
else
  systemd-nspawn -D "$ROOTFS" systemctl enable nginx.service sigmaos-hostd.service sigmaos-termux.service sigmaos-api.service sigmaos-worker@1.service sigmaos-photostaff.service sigmaos-downloader.service sigmaos-indexer.service sigmaos-scheduler.timer sigmaos-maintenance.timer sigmaos-backup-daily.timer sigmaos-backup-weekly.timer sigmaos-health.timer
fi

tar --numeric-owner -C "$ROOTFS" -cpf "$TARBALL" .
printf "SigmaOS appliance rootfs written to %s\n" "$TARBALL"
