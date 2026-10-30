#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ARCH=$(dpkg --print-architecture 2>/dev/null || true)
NODE_MAJOR_REQUIRED=22
RUST_VERSION_REQUIRED=1.95.0
CYBEROS_APT_MIRROR=${CYBEROS_APT_MIRROR:-https://mirrors.aliyun.com/debian}
CYBEROS_APT_SECURITY_MIRROR=${CYBEROS_APT_SECURITY_MIRROR:-https://mirrors.aliyun.com/debian-security}
CYBEROS_RPI_MIRROR=${CYBEROS_RPI_MIRROR:-https://mirrors.aliyun.com/raspberrypi}
CYBEROS_NODE_MIRROR=${CYBEROS_NODE_MIRROR:-https://mirrors.aliyun.com/nodejs-release}
CYBEROS_NODE_VERSION=${CYBEROS_NODE_VERSION:-22.23.2}
CYBEROS_NPM_REGISTRY=${CYBEROS_NPM_REGISTRY:-https://registry.npmmirror.com}
CYBEROS_CARGO_REGISTRY=${CYBEROS_CARGO_REGISTRY:-sparse+https://rsproxy.cn/index/}
CYBEROS_RUSTUP_INIT_URL=${CYBEROS_RUSTUP_INIT_URL:-https://sh.rustup.rs}
CYBEROS_CARGO_HOME=${CYBEROS_CARGO_HOME:-/root/.cargo}
CYBEROS_RUSTUP_HOME=${CYBEROS_RUSTUP_HOME:-/root/.rustup}
CYBEROS_APT_BACKUP_DIR=${CYBEROS_APT_BACKUP_DIR:-/cyberos/system-backups/apt}
CYBEROS_LOCALE=${CYBEROS_LOCALE:-C.UTF-8}
NGINX_ENABLED=${CYBEROS_ENABLE_NGINX:-1}
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
export CARGO_HOME="$CYBEROS_CARGO_HOME"
export RUSTUP_HOME="$CYBEROS_RUSTUP_HOME"
PATH="$CARGO_HOME/bin:$PATH"
export PATH

CYBEROS_APT_MIRROR=${CYBEROS_APT_MIRROR%/}
CYBEROS_APT_SECURITY_MIRROR=${CYBEROS_APT_SECURITY_MIRROR%/}
CYBEROS_RPI_MIRROR=${CYBEROS_RPI_MIRROR%/}
CYBEROS_NODE_MIRROR=${CYBEROS_NODE_MIRROR%/}
CYBEROS_NPM_REGISTRY=${CYBEROS_NPM_REGISTRY%/}

log() {
  printf 'cyberos-install: %s\n' "$*"
}

die() {
  printf 'cyberos-install: error: %s\n' "$*" >&2
  exit 1
}

apt_install() {
  apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 \
    -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
    -o Dpkg::Options::=--force-confold "$@"
}

backup_apt_source() {
  source=$1
  install -d -m 0755 "$CYBEROS_APT_BACKUP_DIR"
  backup="$CYBEROS_APT_BACKUP_DIR/$(basename "$source")"
  [ -e "$backup" ] || cp -p "$source" "$backup"
}

rewrite_apt_uri() {
  old_uri=$1
  new_uri=$2
  for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [ -f "$source" ] || continue
    if grep -Fq "$old_uri" "$source"; then
      backup_apt_source "$source"
      sed -i "s|$old_uri|$new_uri|g" "$source"
      log "updated APT source in $source"
    fi
  done
}

disable_nodesource_sources() {
  for source in /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [ -f "$source" ] || continue
    grep -Eq '^[[:space:]]*[^#[:space:]].*deb\.nodesource\.com' "$source" || continue
    case "$source" in
      *.list)
        backup_apt_source "$source"
        sed -i '/deb\.nodesource\.com/s/^/# cyberos disabled NodeSource: /' "$source"
        log "disabled NodeSource entry in $source"
        ;;
      *.sources)
        backup_apt_source "$source"
        mv "$source" "$CYBEROS_APT_BACKUP_DIR/$(basename "$source").cyberos-disabled"
        log "disabled NodeSource source file $source"
        ;;
    esac
  done
}

configure_domestic_apt_mirrors() {
  log "configuring domestic APT mirrors"
  # Replace only known upstream URIs. Signed-By, suites, components, and any
  # unrelated administrator-managed sources remain unchanged.
  rewrite_apt_uri 'http://deb.debian.org/debian-security' "$CYBEROS_APT_SECURITY_MIRROR"
  rewrite_apt_uri 'https://deb.debian.org/debian-security' "$CYBEROS_APT_SECURITY_MIRROR"
  rewrite_apt_uri 'http://deb.debian.org/debian' "$CYBEROS_APT_MIRROR"
  rewrite_apt_uri 'https://deb.debian.org/debian' "$CYBEROS_APT_MIRROR"
  rewrite_apt_uri 'http://archive.raspberrypi.com/debian' "$CYBEROS_RPI_MIRROR"
  rewrite_apt_uri 'https://archive.raspberrypi.com/debian' "$CYBEROS_RPI_MIRROR"
  disable_nodesource_sources
}

[ "$(id -u)" -eq 0 ] || die "run as root (for example: sudo $0)"
[ -f /etc/debian_version ] || die "a Debian-family host is required"

case "$ARCH" in
  arm64|amd64) ;;
  *) die "unsupported Debian architecture: ${ARCH:-unknown}; use arm64 or amd64" ;;
esac

[ -n "$CYBEROS_APT_MIRROR" ] || die "CYBEROS_APT_MIRROR must not be empty"
[ -n "$CYBEROS_APT_SECURITY_MIRROR" ] || die "CYBEROS_APT_SECURITY_MIRROR must not be empty"
[ -n "$CYBEROS_RPI_MIRROR" ] || die "CYBEROS_RPI_MIRROR must not be empty"
[ -n "$CYBEROS_NODE_MIRROR" ] || die "CYBEROS_NODE_MIRROR must not be empty"
[ -n "$CYBEROS_NODE_VERSION" ] || die "CYBEROS_NODE_VERSION must not be empty"
[ -n "$CYBEROS_NPM_REGISTRY" ] || die "CYBEROS_NPM_REGISTRY must not be empty"
[ -n "$CYBEROS_CARGO_REGISTRY" ] || die "CYBEROS_CARGO_REGISTRY must not be empty"
[ -n "$CYBEROS_RUSTUP_INIT_URL" ] || die "CYBEROS_RUSTUP_INIT_URL must not be empty"
[ -n "$CYBEROS_CARGO_HOME" ] || die "CYBEROS_CARGO_HOME must not be empty"
[ -n "$CYBEROS_RUSTUP_HOME" ] || die "CYBEROS_RUSTUP_HOME must not be empty"
[ -n "$CYBEROS_APT_BACKUP_DIR" ] || die "CYBEROS_APT_BACKUP_DIR must not be empty"
[ -n "$CYBEROS_LOCALE" ] || die "CYBEROS_LOCALE must not be empty"
printf '%s\n' "$CYBEROS_CARGO_REGISTRY" \
  | grep -Eq '^sparse\+https://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+/$' \
  || die "CYBEROS_CARGO_REGISTRY must be a safe sparse HTTPS registry URL ending in /"

CYBEROS_APT_BACKUP_DIR=$(realpath -m -- "$CYBEROS_APT_BACKUP_DIR")
case "$CYBEROS_APT_BACKUP_DIR" in
  /cyberos/system-backups|/cyberos/system-backups/*) ;;
  *) die "CYBEROS_APT_BACKUP_DIR must be under /cyberos/system-backups" ;;
esac

case "$NGINX_ENABLED" in
  0|1) ;;
  *) die "CYBEROS_ENABLE_NGINX must be 0 or 1" ;;
esac
install_build_dependencies() {
  log "installing build prerequisites"
  apt_install update
  if dpkg-query -W -f='${Version}' nodejs 2>/dev/null | grep -qi 'nodesource'; then
    log "removing the obsolete NodeSource nodejs package"
    apt_install remove -y nodejs
  fi
  apt_install install -y --no-install-recommends \
    ca-certificates curl build-essential cargo rustc debhelper dh-dkms dpkg-dev fakeroot rsync \
    nodejs npm xz-utils
}

install_rust_toolchain() {
  if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    log "installing rustup"
    rustup_init=$(mktemp)
    curl -fsSL "$CYBEROS_RUSTUP_INIT_URL" -o "$rustup_init"
    sh "$rustup_init" -y --profile minimal --default-toolchain "$RUST_VERSION_REQUIRED"
    rm -f "$rustup_init"
  fi
  "$CARGO_HOME/bin/rustup" set auto-self-update disable
  if ! "$CARGO_HOME/bin/rustup" run "$RUST_VERSION_REQUIRED" rustc --version 2>/dev/null \
    | grep -Eq "^rustc ${RUST_VERSION_REQUIRED} "; then
    "$CARGO_HOME/bin/rustup" toolchain install "$RUST_VERSION_REQUIRED" --profile minimal
  fi
  "$CARGO_HOME/bin/rustup" default "$RUST_VERSION_REQUIRED"
  rustc --version | grep -Eq "^rustc ${RUST_VERSION_REQUIRED} " \
    || die "Rust ${RUST_VERSION_REQUIRED} is required; found $(rustc --version 2>/dev/null || printf 'none')"
}

ensure_vm_network() {
  command -v virsh >/dev/null 2>&1 || return 0

  if ! virsh -c qemu:///system net-info default >/dev/null 2>&1; then
    return 0
  fi

  virsh -c qemu:///system net-autostart default \
    || log "warning: could not mark libvirt default network for autostart"
  if ! virsh -c qemu:///system net-list --name | grep -Fxq default; then
    virsh -c qemu:///system net-start default \
      || log "warning: could not start libvirt default network"
  fi
}

read_tv_mode_setting() {
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:3010/api/settings/tv \
    | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const enabled = JSON.parse(input)?.settings?.enabled;
        if (typeof enabled !== "boolean") process.exit(1);
        process.stdout.write(enabled ? "enable" : "disable");
      });
    '
}

apply_tv_mode_setting() {
  attempt=1
  tv_mode_action=
  while [ "$attempt" -le 30 ]; do
    if tv_mode_action=$(read_tv_mode_setting); then
      break
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  [ -n "$tv_mode_action" ] || return 1

  log "applying TV mode system setting: $tv_mode_action"
  /usr/lib/cyberos/scripts/cyberos-tv-mode "$tv_mode_action"
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    printf '0'
    return
  fi

  node --version | sed 's/^v//' | cut -d. -f1
}

nodejs_from_nodesource() {
  dpkg-query -W -f='${Version}' nodejs 2>/dev/null | grep -qi 'nodesource'
}

install_node_22() {
  log "installing Node.js ${NODE_MAJOR_REQUIRED}"
  install_build_dependencies

  case "$ARCH" in
    arm64) node_arch=arm64 ;;
    amd64) node_arch=x64 ;;
  esac
  node_filename="node-v${CYBEROS_NODE_VERSION}-linux-${node_arch}.tar.xz"
  node_dir="/opt/cyberos/node/node-v${CYBEROS_NODE_VERSION}-linux-${node_arch}"
  node_tmp=$(mktemp -d)
  trap 'rm -rf "$node_tmp"' EXIT HUP INT TERM
  curl -fsSL "$CYBEROS_NODE_MIRROR/v${CYBEROS_NODE_VERSION}/$node_filename" \
    -o "$node_tmp/$node_filename"
  curl -fsSL "$CYBEROS_NODE_MIRROR/v${CYBEROS_NODE_VERSION}/SHASUMS256.txt" \
    -o "$node_tmp/SHASUMS256.txt"
  node_sha256=$(awk -v filename="$node_filename" '$2 == filename { print $1; exit }' "$node_tmp/SHASUMS256.txt")
  [ -n "$node_sha256" ] || die "Node.js checksum is missing for $node_filename"
  printf '%s  %s\n' "$node_sha256" "$node_tmp/$node_filename" | sha256sum -c - \
    || die "Node.js archive checksum did not match"
  install -d -m 0755 /opt/cyberos/node
  tar -xJf "$node_tmp/$node_filename" -C /opt/cyberos/node
  [ -x "$node_dir/bin/node" ] || die "Node.js archive did not contain $node_dir/bin/node"
  ln -sfn "$node_dir/bin/node" /usr/local/bin/node
  ln -sfn "$node_dir/bin/npm" /usr/local/bin/npm
  ln -sfn "$node_dir/bin/npx" /usr/local/bin/npx
}

configure_domestic_apt_mirrors

CYBEROS_LOCALE="$CYBEROS_LOCALE" \
  "$ROOT_DIR/packaging/scripts/cyberos-configure-locale.sh"

if [ "$(node_major)" -lt "$NODE_MAJOR_REQUIRED" ] 2>/dev/null || nodejs_from_nodesource || [ ! -x /usr/local/bin/node ]; then
  install_node_22
fi

node --version | grep -Eq '^v22\.' || die "Node.js 22 is required; found $(node --version 2>/dev/null || printf 'none')"
install_build_dependencies
install_rust_toolchain
# Only kernels without native LIO need external modules. Never replace a kernel
# or silently build against headers for a different running kernel.
if ! /usr/sbin/modinfo target_core_mod >/dev/null 2>&1; then
  case "$(uname -r)" in
    6.18.*+rpt-rpi-*)
      if [ ! -f "/lib/modules/$(uname -r)/build/Makefile" ]; then
        apt_install install -y --no-install-recommends "linux-headers-$(uname -r)"
      fi
      [ -f "/lib/modules/$(uname -r)/build/Makefile" ] \
        || die "iSCSI requires headers matching the running Raspberry Pi kernel"
      ;;
  esac
fi
npm config set registry "$CYBEROS_NPM_REGISTRY" --global
log "building the native ${ARCH} Debian package"
CYBEROS_CARGO_REGISTRY="$CYBEROS_CARGO_REGISTRY" \
  "$ROOT_DIR/packaging/scripts/build-deb.sh"

DEB_PATH=$(find "$ROOT_DIR/.cyberos" -maxdepth 1 -type f \
  -name "cyberos_*_${ARCH}.deb" ! -name '*dbgsym*' -print | sort | tail -n 1)
[ -n "$DEB_PATH" ] || die "could not find the ${ARCH} Debian package"

log "installing $DEB_PATH"
# The checkout build keeps the package version stable; force the local artifact
# to replace an already-installed package from an earlier checkout revision.
apt_install install -y --no-install-recommends --reinstall "$DEB_PATH"

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  /usr/lib/cyberos/scripts/cyberos-refresh-groups.sh
  systemctl enable --now docker.service
  systemctl enable cyberos-host-accessd.service
  for vm_unit in libvirtd.service virtqemud.socket; do
    if systemctl list-unit-files "$vm_unit" --no-legend 2>/dev/null | grep -q "$vm_unit"; then
      systemctl enable --now "$vm_unit" || true
    fi
  done
  ensure_vm_network
  systemctl enable \
    cyberos-state-init.service \
    cyberos-hostd.service \
    cyberos-terminald.service \
    cyberos-api.service \
    cyberos-vod-player.service \
    cyberos-media-streamer.service \
    cyberos-monitor.service \
    cyberos-alerter.service \
    cyberos-worker@1.service \
    cyberos-photos.service \
    cyberos-downloader.service \
    cyberos-bluetoothd.service \
    cyberos-indexer.service
  systemctl restart cyberos-state-init.service
  systemctl restart cyberos-hostd.service cyberos-terminald.service
  systemctl restart cyberos-host-accessd.service
  systemctl restart cyberos-api.service
  systemctl restart cyberos-vod-player.service cyberos-media-streamer.service
  if ! systemctl restart cyberos-monitor.service; then
    log "warning: monitoring service failed to start; core services remain available"
  fi
  if ! systemctl restart cyberos-alerter.service; then
    log "warning: alerting service failed to start; core services remain available"
  fi
  systemctl restart cyberos-worker@1.service cyberos-photos.service cyberos-downloader.service cyberos-bluetoothd.service cyberos-indexer.service
  systemctl enable --now \
    cyberos-maintenance.timer \
    cyberos-backup-daily.timer \
    cyberos-backup-weekly.timer \
    cyberos-health.timer
  systemctl start cyberos-health.service || \
    log "warning: initial health evaluation failed; the health timer will retry"
  apply_tv_mode_setting || \
    log "warning: TV mode setting could not be applied; use System Settings > Media to retry"
fi

if [ "$NGINX_ENABLED" = "1" ]; then
  log "installing Nginx reverse proxy"
  apt_install install -y --no-install-recommends nginx
  CYBEROS_NGINX_PORT=${CYBEROS_NGINX_PORT:-80} \
    /usr/lib/cyberos/scripts/cyberos-nginx.sh
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable nginx
    systemctl restart nginx
  fi
  log "installed successfully; web UI is available on http://<host>:${CYBEROS_NGINX_PORT:-80}"
else
  log "installed successfully; Nginx reverse proxy disabled"
  log "API listens on http://127.0.0.1:3010"
fi
