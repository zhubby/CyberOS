#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ARCH=$(dpkg --print-architecture 2>/dev/null || true)
NODE_MAJOR_REQUIRED=22
RUST_VERSION_REQUIRED=1.95.0
SIGMAOS_APT_MIRROR=${SIGMAOS_APT_MIRROR:-https://mirrors.aliyun.com/debian}
SIGMAOS_APT_SECURITY_MIRROR=${SIGMAOS_APT_SECURITY_MIRROR:-https://mirrors.aliyun.com/debian-security}
SIGMAOS_RPI_MIRROR=${SIGMAOS_RPI_MIRROR:-https://mirrors.aliyun.com/raspberrypi}
SIGMAOS_NODE_MIRROR=${SIGMAOS_NODE_MIRROR:-https://mirrors.aliyun.com/nodejs-release}
SIGMAOS_NODE_VERSION=${SIGMAOS_NODE_VERSION:-22.23.2}
SIGMAOS_NPM_REGISTRY=${SIGMAOS_NPM_REGISTRY:-https://registry.npmmirror.com}
SIGMAOS_RUSTUP_INIT_URL=${SIGMAOS_RUSTUP_INIT_URL:-https://sh.rustup.rs}
SIGMAOS_CARGO_HOME=${SIGMAOS_CARGO_HOME:-/root/.cargo}
SIGMAOS_RUSTUP_HOME=${SIGMAOS_RUSTUP_HOME:-/root/.rustup}
SIGMAOS_APT_BACKUP_DIR=${SIGMAOS_APT_BACKUP_DIR:-/var/backups/sigmaos-apt}
SIGMAOS_LOCALE=${SIGMAOS_LOCALE:-C.UTF-8}
NGINX_ENABLED=${SIGMAOS_ENABLE_NGINX:-1}
DOCKER_ENABLED=${SIGMAOS_ENABLE_DOCKER:-0}
VM_ENABLED=${SIGMAOS_ENABLE_VM:-0}
VOD_PLAYER_ENABLED=${SIGMAOS_ENABLE_VOD_PLAYER:-0}
VOD_PLAYER_USER=${SIGMAOS_VOD_PLAYER_USER:-sigmaos}
TERMINAL_USER=${SIGMAOS_TERMUX_USER:-sigmaos}
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
export CARGO_HOME="$SIGMAOS_CARGO_HOME"
export RUSTUP_HOME="$SIGMAOS_RUSTUP_HOME"
PATH="$CARGO_HOME/bin:$PATH"
export PATH

SIGMAOS_APT_MIRROR=${SIGMAOS_APT_MIRROR%/}
SIGMAOS_APT_SECURITY_MIRROR=${SIGMAOS_APT_SECURITY_MIRROR%/}
SIGMAOS_RPI_MIRROR=${SIGMAOS_RPI_MIRROR%/}
SIGMAOS_NODE_MIRROR=${SIGMAOS_NODE_MIRROR%/}
SIGMAOS_NPM_REGISTRY=${SIGMAOS_NPM_REGISTRY%/}

log() {
  printf 'sigmaos-install: %s\n' "$*"
}

die() {
  printf 'sigmaos-install: error: %s\n' "$*" >&2
  exit 1
}

legacy_player_environment=$(env | awk -F= '$1 == "SIGMAOS_ENABLE_PLAYER" || $1 ~ /^SIGMAOS_PLAYER_/ { print $1; exit }')
[ -z "$legacy_player_environment" ] || die "$legacy_player_environment is no longer supported; use SIGMAOS_VOD_PLAYER_*"

apt_install() {
  apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=3 \
    -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
    -o Dpkg::Options::=--force-confold "$@"
}

backup_apt_source() {
  source=$1
  install -d -m 0755 "$SIGMAOS_APT_BACKUP_DIR"
  backup="$SIGMAOS_APT_BACKUP_DIR/$(basename "$source")"
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
        sed -i '/deb\.nodesource\.com/s/^/# sigmaos disabled NodeSource: /' "$source"
        log "disabled NodeSource entry in $source"
        ;;
      *.sources)
        backup_apt_source "$source"
        mv "$source" "$SIGMAOS_APT_BACKUP_DIR/$(basename "$source").sigmaos-disabled"
        log "disabled NodeSource source file $source"
        ;;
    esac
  done
}

configure_domestic_apt_mirrors() {
  log "configuring domestic APT mirrors"
  # Replace only known upstream URIs. Signed-By, suites, components, and any
  # unrelated administrator-managed sources remain unchanged.
  rewrite_apt_uri 'http://deb.debian.org/debian-security' "$SIGMAOS_APT_SECURITY_MIRROR"
  rewrite_apt_uri 'https://deb.debian.org/debian-security' "$SIGMAOS_APT_SECURITY_MIRROR"
  rewrite_apt_uri 'http://deb.debian.org/debian' "$SIGMAOS_APT_MIRROR"
  rewrite_apt_uri 'https://deb.debian.org/debian' "$SIGMAOS_APT_MIRROR"
  rewrite_apt_uri 'http://archive.raspberrypi.com/debian' "$SIGMAOS_RPI_MIRROR"
  rewrite_apt_uri 'https://archive.raspberrypi.com/debian' "$SIGMAOS_RPI_MIRROR"
  disable_nodesource_sources
}

[ "$(id -u)" -eq 0 ] || die "run as root (for example: sudo $0)"
[ -f /etc/debian_version ] || die "a Debian-family host is required"

case "$ARCH" in
  arm64|amd64) ;;
  *) die "unsupported Debian architecture: ${ARCH:-unknown}; use arm64 or amd64" ;;
esac

[ -n "$SIGMAOS_APT_MIRROR" ] || die "SIGMAOS_APT_MIRROR must not be empty"
[ -n "$SIGMAOS_APT_SECURITY_MIRROR" ] || die "SIGMAOS_APT_SECURITY_MIRROR must not be empty"
[ -n "$SIGMAOS_RPI_MIRROR" ] || die "SIGMAOS_RPI_MIRROR must not be empty"
[ -n "$SIGMAOS_NODE_MIRROR" ] || die "SIGMAOS_NODE_MIRROR must not be empty"
[ -n "$SIGMAOS_NODE_VERSION" ] || die "SIGMAOS_NODE_VERSION must not be empty"
[ -n "$SIGMAOS_NPM_REGISTRY" ] || die "SIGMAOS_NPM_REGISTRY must not be empty"
[ -n "$SIGMAOS_RUSTUP_INIT_URL" ] || die "SIGMAOS_RUSTUP_INIT_URL must not be empty"
[ -n "$SIGMAOS_CARGO_HOME" ] || die "SIGMAOS_CARGO_HOME must not be empty"
[ -n "$SIGMAOS_RUSTUP_HOME" ] || die "SIGMAOS_RUSTUP_HOME must not be empty"
[ -n "$SIGMAOS_APT_BACKUP_DIR" ] || die "SIGMAOS_APT_BACKUP_DIR must not be empty"
[ -n "$SIGMAOS_LOCALE" ] || die "SIGMAOS_LOCALE must not be empty"
[ "$TERMINAL_USER" = sigmaos ] || die "SIGMAOS_TERMUX_USER must be sigmaos"

case "$NGINX_ENABLED" in
  0|1) ;;
  *) die "SIGMAOS_ENABLE_NGINX must be 0 or 1" ;;
esac
case "$DOCKER_ENABLED" in
  0|1) ;;
  *) die "SIGMAOS_ENABLE_DOCKER must be 0 or 1" ;;
esac
case "$VM_ENABLED" in
  0|1) ;;
  *) die "SIGMAOS_ENABLE_VM must be 0 or 1" ;;
esac
case "$VOD_PLAYER_ENABLED" in
  0|1) ;;
  *) die "SIGMAOS_ENABLE_VOD_PLAYER must be 0 or 1" ;;
esac
case "$VOD_PLAYER_USER" in
  *[!a-zA-Z0-9._-]*|root) die "SIGMAOS_VOD_PLAYER_USER must name a non-root local user" ;;
esac

install_build_dependencies() {
  log "installing build prerequisites"
  apt_install update
  if dpkg-query -W -f='${Version}' nodejs 2>/dev/null | grep -qi 'nodesource'; then
    log "removing the obsolete NodeSource nodejs package"
    apt_install remove -y nodejs
  fi
  apt_install install -y --no-install-recommends \
    ca-certificates curl build-essential cargo rustc debhelper dpkg-dev fakeroot rsync \
    nodejs npm xz-utils
}

install_rust_toolchain() {
  if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    log "installing rustup"
    rustup_init=$(mktemp)
    curl -fsSL "$SIGMAOS_RUSTUP_INIT_URL" -o "$rustup_init"
    sh "$rustup_init" -y --profile minimal --default-toolchain "$RUST_VERSION_REQUIRED"
    rm -f "$rustup_init"
  fi
  "$CARGO_HOME/bin/rustup" toolchain install "$RUST_VERSION_REQUIRED" --profile minimal
  "$CARGO_HOME/bin/rustup" default "$RUST_VERSION_REQUIRED"
  rustc --version | grep -Eq "^rustc ${RUST_VERSION_REQUIRED} " \
    || die "Rust ${RUST_VERSION_REQUIRED} is required; found $(rustc --version 2>/dev/null || printf 'none')"
}

install_optional_runtime() {
  runtime_packages=""
  if [ "$DOCKER_ENABLED" = "1" ]; then
    # docker.io recommends the CLI, but does not pull it when the installer
    # deliberately disables recommends. Keep the engine and client explicit.
    runtime_packages="$runtime_packages docker.io docker-cli docker-compose"
  fi
  if [ "$VM_ENABLED" = "1" ]; then
    runtime_packages="$runtime_packages ipxe-qemu"
    case "$ARCH" in
      arm64) runtime_packages="$runtime_packages libvirt-daemon-system libvirt-clients qemu-system-arm qemu-efi-aarch64 qemu-utils virtinst" ;;
      amd64) runtime_packages="$runtime_packages libvirt-daemon-system libvirt-clients qemu-system-x86 qemu-utils virtinst" ;;
    esac
  fi
  if [ "$VOD_PLAYER_ENABLED" = "1" ]; then
    runtime_packages="$runtime_packages mpv seatd"
  fi
  if [ -n "$runtime_packages" ]; then
    log "installing optional runtime components:$runtime_packages"
    apt_install update
    # shellcheck disable=SC2086
    apt_install install -y --no-install-recommends $runtime_packages
  fi
}

ensure_vm_network() {
  [ "$VM_ENABLED" = "1" ] || return 0
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
  node_filename="node-v${SIGMAOS_NODE_VERSION}-linux-${node_arch}.tar.xz"
  node_dir="/opt/sigmaos/node/node-v${SIGMAOS_NODE_VERSION}-linux-${node_arch}"
  node_tmp=$(mktemp -d)
  trap 'rm -rf "$node_tmp"' EXIT HUP INT TERM
  curl -fsSL "$SIGMAOS_NODE_MIRROR/v${SIGMAOS_NODE_VERSION}/$node_filename" \
    -o "$node_tmp/$node_filename"
  curl -fsSL "$SIGMAOS_NODE_MIRROR/v${SIGMAOS_NODE_VERSION}/SHASUMS256.txt" \
    -o "$node_tmp/SHASUMS256.txt"
  node_sha256=$(awk -v filename="$node_filename" '$2 == filename { print $1; exit }' "$node_tmp/SHASUMS256.txt")
  [ -n "$node_sha256" ] || die "Node.js checksum is missing for $node_filename"
  printf '%s  %s\n' "$node_sha256" "$node_tmp/$node_filename" | sha256sum -c - \
    || die "Node.js archive checksum did not match"
  install -d -m 0755 /opt/sigmaos/node
  tar -xJf "$node_tmp/$node_filename" -C /opt/sigmaos/node
  [ -x "$node_dir/bin/node" ] || die "Node.js archive did not contain $node_dir/bin/node"
  ln -sfn "$node_dir/bin/node" /usr/local/bin/node
  ln -sfn "$node_dir/bin/npm" /usr/local/bin/npm
  ln -sfn "$node_dir/bin/npx" /usr/local/bin/npx
}

configure_domestic_apt_mirrors

SIGMAOS_LOCALE="$SIGMAOS_LOCALE" \
  "$ROOT_DIR/packaging/scripts/sigmaos-configure-locale.sh"

if [ "$(node_major)" -lt "$NODE_MAJOR_REQUIRED" ] 2>/dev/null || nodejs_from_nodesource || [ ! -x /usr/local/bin/node ]; then
  install_node_22
fi

node --version | grep -Eq '^v22\.' || die "Node.js 22 is required; found $(node --version 2>/dev/null || printf 'none')"
install_build_dependencies
install_rust_toolchain
npm config set registry "$SIGMAOS_NPM_REGISTRY" --global
install_optional_runtime

SIGMAOS_CONFIG_EXISTS=0
if [ -e /etc/sigmaos/config.toml ]; then
  SIGMAOS_CONFIG_EXISTS=1
fi

log "building the native ${ARCH} Debian package"
"$ROOT_DIR/packaging/scripts/build-deb.sh"

DEB_PATH=$(find "$ROOT_DIR/.sigmaos" -maxdepth 1 -type f \
  -name "sigmaos_*_${ARCH}.deb" ! -name '*dbgsym*' -print | sort | tail -n 1)
[ -n "$DEB_PATH" ] || die "could not find the ${ARCH} Debian package"

log "installing $DEB_PATH"
# The checkout build keeps the package version stable; force the local artifact
# to replace an already-installed package from an earlier checkout revision.
apt_install install -y --no-install-recommends --reinstall "$DEB_PATH"

if [ "$SIGMAOS_CONFIG_EXISTS" = "0" ]; then
  log "initializing SigmaOS configuration"
  SIGMAOS_FIRST_BOOT_FORCE=1 \
  SIGMAOS_ADMIN_DISPLAY_NAME=${SIGMAOS_ADMIN_DISPLAY_NAME:-SigmaOS Admin} \
  SIGMAOS_NAS_ROOT_PATH=${SIGMAOS_NAS_ROOT_PATH:-/srv/nas} \
  SIGMAOS_DOCKER_ENABLED="$DOCKER_ENABLED" \
  SIGMAOS_VM_ENABLED="$VM_ENABLED" \
  SIGMAOS_VOD_PLAYER_ENABLED="$VOD_PLAYER_ENABLED" \
  SIGMAOS_VOD_PLAYER_USER="$VOD_PLAYER_USER" \
  SIGMAOS_TERMUX_USER="$TERMINAL_USER" \
    /usr/lib/sigmaos/scripts/sigmaos-first-boot.sh
else
  log "preserving existing SigmaOS configuration"
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  /usr/lib/sigmaos/scripts/sigmaos-refresh-groups.sh
  /usr/lib/sigmaos/scripts/sigmaos-refresh-termux.sh
  SIGMAOS_VOD_PLAYER_USER="$VOD_PLAYER_USER" /usr/lib/sigmaos/scripts/sigmaos-refresh-vod-player.sh
  if [ "$DOCKER_ENABLED" = "1" ]; then
    systemctl enable --now docker.service
  fi
  if [ "$VM_ENABLED" = "1" ]; then
    for vm_unit in libvirtd.service virtqemud.socket; do
      if systemctl list-unit-files "$vm_unit" --no-legend 2>/dev/null | grep -q "$vm_unit"; then
        systemctl enable --now "$vm_unit" || true
      fi
    done
    ensure_vm_network
  fi
  systemctl enable --now \
    sigmaos-hostd.service \
    sigmaos-termux.service \
    sigmaos-api.service \
    sigmaos-worker@1.service \
    sigmaos-photostaff.service \
    sigmaos-downloader.service \
    sigmaos-indexer.service
  systemctl restart sigmaos-hostd.service sigmaos-termux.service \
    sigmaos-api.service sigmaos-worker@1.service sigmaos-photostaff.service sigmaos-downloader.service sigmaos-indexer.service
  if [ "$VOD_PLAYER_ENABLED" = "1" ]; then
    systemctl enable --now sigmaos-vod-player.service
  fi
  systemctl enable \
    sigmaos-maintenance.timer \
    sigmaos-backup-daily.timer \
    sigmaos-backup-weekly.timer \
    sigmaos-health.timer
fi

if [ "$NGINX_ENABLED" = "1" ]; then
  log "installing Nginx reverse proxy"
  apt_install install -y --no-install-recommends nginx
  SIGMAOS_NGINX_PORT=${SIGMAOS_NGINX_PORT:-80} \
    /usr/lib/sigmaos/scripts/sigmaos-nginx.sh
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable nginx
    systemctl restart nginx
  fi
  log "installed successfully; web UI is available on http://<host>:${SIGMAOS_NGINX_PORT:-80}"
else
  log "installed successfully; Nginx reverse proxy disabled"
  log "API listens on http://127.0.0.1:3010"
fi
