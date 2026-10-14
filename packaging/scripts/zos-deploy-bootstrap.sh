#!/bin/sh
set -eu

DEPLOY_USER=${ZOS_DEPLOY_USER:-zos-deploy}
BASE_DIR=${ZOS_DEPLOY_DIR:-/zos/deploy}
BASE_DIR=$(realpath -m -- "$BASE_DIR")
case "$BASE_DIR" in
  /zos/deploy|/zos/deploy/*) ;;
  *) printf 'zos-deploy-bootstrap: ZOS_DEPLOY_DIR must be under /zos/deploy\n' >&2; exit 1 ;;
esac
SUDOERS_PATH=/etc/sudoers.d/zos-deploy

[ "$(id -u)" -eq 0 ] || {
  printf 'zos-deploy-bootstrap: must run as root\n' >&2
  exit 1
}

case "$DEPLOY_USER" in
  ''|*[!a-zA-Z0-9._-]*|root|zos)
    printf 'zos-deploy-bootstrap: invalid deployment user\n' >&2
    exit 1
    ;;
esac

command -v adduser >/dev/null 2>&1 || {
  printf 'zos-deploy-bootstrap: adduser is required\n' >&2
  exit 1
}
command -v addgroup >/dev/null 2>&1 || {
  printf 'zos-deploy-bootstrap: addgroup is required\n' >&2
  exit 1
}
command -v visudo >/dev/null 2>&1 || {
  printf 'zos-deploy-bootstrap: visudo is required\n' >&2
  exit 1
}
command -v passwd >/dev/null 2>&1 || {
  printf 'zos-deploy-bootstrap: passwd is required\n' >&2
  exit 1
}
[ -x /usr/lib/zos/scripts/zos-deploy ] || {
  printf 'zos-deploy-bootstrap: packaged deployment helper is missing\n' >&2
  exit 1
}
[ -d /zos ] && [ ! -L /zos ] || {
  printf 'zos-deploy-bootstrap: /zos must be a real directory\n' >&2
  exit 1
}

# Permit the unprivileged deployment identity to traverse to its private
# staging directory without granting directory listing access to /zos.
chmod 0751 /zos

install -d -o root -g root -m 0755 /usr/local/sbin
ln -sfn /usr/lib/zos/scripts/zos-deploy /usr/local/sbin/zos-deploy

if ! getent group "$DEPLOY_USER" >/dev/null 2>&1; then
  addgroup --system "$DEPLOY_USER"
fi
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --system --ingroup "$DEPLOY_USER" --home "$BASE_DIR" --shell /bin/sh "$DEPLOY_USER"
elif ! id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -Fxq "$DEPLOY_USER"; then
  adduser "$DEPLOY_USER" "$DEPLOY_USER"
fi

install -d -o root -g "$DEPLOY_USER" -m 0750 "$BASE_DIR"
install -d -o root -g "$DEPLOY_USER" -m 0730 "$BASE_DIR/incoming"
install -d -o root -g root -m 0700 "$BASE_DIR/backups" "$BASE_DIR/releases"
install -d -o root -g root -m 0755 /etc/sudoers.d

tmp_sudoers=$(mktemp /etc/sudoers.d/.zos-deploy.XXXXXX)
trap 'rm -f "$tmp_sudoers"' EXIT HUP INT TERM
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/zos-deploy\n' "$DEPLOY_USER" > "$tmp_sudoers"
chmod 0440 "$tmp_sudoers"
visudo -cf "$tmp_sudoers"
mv -f "$tmp_sudoers" "$SUDOERS_PATH"
trap - EXIT HUP INT TERM

passwd -l "$DEPLOY_USER" >/dev/null 2>&1
printf 'zos-deploy-bootstrap: configured %s with Tailscale SSH and constrained sudo\n' "$DEPLOY_USER"
