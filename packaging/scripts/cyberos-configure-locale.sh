#!/bin/sh
set -eu

LOCALE_NAME=${CYBEROS_LOCALE:-C.UTF-8}
BACKUP_DIR=${CYBEROS_SYSTEM_BACKUP_DIR:-/cyberos/system-backups}

log() {
  printf 'cyberos-locale: %s\n' "$*"
}

die() {
  printf 'cyberos-locale: error: %s\n' "$*" >&2
  exit 1
}

backup_once() {
  source=$1
  [ -f "$source" ] || return 0
  install -d -m 0755 "$BACKUP_DIR"
  backup="$BACKUP_DIR/$(basename "$source")"
  [ -e "$backup" ] || cp -p "$source" "$backup"
}

configure_default_locale() {
  locale_file=/etc/default/locale
  backup_once "$locale_file"

  if command -v update-locale >/dev/null 2>&1; then
    update-locale LANG="$LOCALE_NAME"
  else
    install -d -m 0755 /etc/default
    printf 'LANG=%s\n' "$LOCALE_NAME" > "$locale_file"
  fi
  log "default locale set to $LOCALE_NAME"
}

configure_sshd_locale() {
  changed=0
  for config in /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf; do
    [ -f "$config" ] || continue
    grep -Eq '^[[:space:]]*AcceptEnv[[:space:]].*LC_\*' "$config" || continue
    backup_once "$config"
    sed -i -E \
      -e '/^[[:space:]]*AcceptEnv[[:space:]]+LC_\*[[:space:]]*$/d' \
      -e 's/[[:space:]]LC_\*//g' \
      "$config"
    changed=1
    log "stopped sshd from accepting wildcard LC_* values in $config"
  done

  [ "$changed" -eq 1 ] || return 0

  if command -v sshd >/dev/null 2>&1 && sshd -t >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl reload ssh.service >/dev/null 2>&1 \
        || systemctl reload sshd.service >/dev/null 2>&1 \
        || log "warning: sshd config is valid but could not be reloaded"
    fi
  else
    log "warning: sshd configuration validation failed; inspect the saved config before reloading"
  fi
}

[ "$(id -u)" -eq 0 ] || die "run as root"
case "$LOCALE_NAME" in
  *[!A-Za-z0-9._-]*) die "CYBEROS_LOCALE contains unsupported characters" ;;
esac
BACKUP_DIR=$(realpath -m -- "$BACKUP_DIR")
case "$BACKUP_DIR" in
  /cyberos/system-backups|/cyberos/system-backups/*) ;;
  *) die "CYBEROS_SYSTEM_BACKUP_DIR must be under /cyberos/system-backups" ;;
esac

configure_default_locale
configure_sshd_locale
