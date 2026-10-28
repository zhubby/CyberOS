#!/bin/sh
set -eu

TEMPLATE_PATH="${CYBEROS_NGINX_TEMPLATE:-/usr/share/cyberos/nginx/cyberos.conf}"
SITE_PATH="${CYBEROS_NGINX_SITE_PATH:-/etc/nginx/sites-available/cyberos.conf}"
PORT="${CYBEROS_NGINX_PORT:-80}"

die() {
  printf 'cyberos-nginx: error: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -f "$TEMPLATE_PATH" ] || die "missing Nginx template: $TEMPLATE_PATH"
command -v nginx >/dev/null 2>&1 || die "Nginx is not installed"

case "$PORT" in
  ''|*[!0-9]*) die "invalid Nginx port: $PORT" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "Nginx port must be between 1 and 65535"

site_dir=$(dirname "$SITE_PATH")
enabled_dir=/etc/nginx/sites-enabled
install -d -m 0755 "$site_dir" "$enabled_dir"

temporary_path=$(mktemp "$site_dir/.cyberos.conf.XXXXXX")
trap 'rm -f "$temporary_path"' EXIT HUP INT TERM
sed "s/__CYBEROS_NGINX_PORT__/$PORT/g" "$TEMPLATE_PATH" > "$temporary_path"
install -m 0644 "$temporary_path" "$SITE_PATH"
rm -f "$enabled_dir/default"
ln -sfn "../sites-available/$(basename "$SITE_PATH")" "$enabled_dir/cyberos.conf"

nginx -t
printf 'CyberOS Nginx reverse proxy configured on port %s\n' "$PORT"
