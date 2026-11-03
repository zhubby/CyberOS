#!/bin/sh
set -eu

die() { printf 'cyberos-tailscale: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 0 ] || die "this helper takes no arguments"
[ "$(id -u)" -eq 0 ] || die "run as root"
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) die "unsupported architecture" ;; esac

# This is an administrator-owned operating-system file, never user input.
. /etc/os-release
case "${ID:-}" in
  debian|raspbian) distribution=debian; suite=${VERSION_CODENAME:-} ;;
  ubuntu) distribution=ubuntu; suite=${VERSION_CODENAME:-} ;;
  *) die "unsupported distribution; configure the official Tailscale stable repository before installing CyberOS" ;;
esac
case "$suite" in ''|*[!a-z0-9]*) die "unsupported distribution codename" ;; esac

source_path=/etc/apt/sources.list.d/cyberos-tailscale.list
keyring_path=/usr/share/keyrings/cyberos-tailscale-archive-keyring.gpg
existing=0
for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [ -f "$source" ] || continue
  if grep -Eq '^[[:space:]]*[^#].*https://pkgs\.tailscale\.com/stable/' "$source"; then existing=1; fi
done
if [ "$existing" -eq 0 ]; then
  [ ! -e "$source_path" ] && [ ! -L "$source_path" ] || die "existing Tailscale repository file requires administrator review"
  [ ! -e "$keyring_path" ] && [ ! -L "$keyring_path" ] || die "existing Tailscale keyring requires administrator review"
  install -d -m 0755 /etc/apt/sources.list.d /usr/share/keyrings
  key_tmp=$(mktemp /usr/share/keyrings/.cyberos-tailscale.XXXXXX)
  source_tmp=$(mktemp /etc/apt/sources.list.d/.cyberos-tailscale.XXXXXX)
  trap 'rm -f "$key_tmp" "$source_tmp"' EXIT HUP INT TERM
  curl --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 --retry 3 -fsSL \
    "https://pkgs.tailscale.com/stable/$distribution/$suite.noarmor.gpg" -o "$key_tmp"
  [ -s "$key_tmp" ] || die "Tailscale signing key is empty"
  printf '# Managed by CyberOS Tailscale\ndeb [signed-by=%s] https://pkgs.tailscale.com/stable/%s %s main\n' \
    "$keyring_path" "$distribution" "$suite" > "$source_tmp"
  chmod 0644 "$key_tmp" "$source_tmp"
  mv "$key_tmp" "$keyring_path"
  mv "$source_tmp" "$source_path"
fi
apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
  || die "APT repository update failed; running CyberOS services were not stopped"
apt-cache show tailscale >/dev/null 2>&1 || die "Tailscale package is unavailable for this distribution"
