#!/bin/sh
set -eu

CONFIG_PATH=${CYBEROS_CONFIG:-/cyberos/config/config.toml}
DROPIN_DIR=/etc/systemd/system/cyberos-termux.service.d
DROPIN_PATH="$DROPIN_DIR/identity.conf"

[ "$(id -u)" -eq 0 ] || {
  printf 'cyberos-termux: must run as root\n' >&2
  exit 1
}

terminal_user=${CYBEROS_TERMUX_USER:-cyberos}
termux_socket_path=${CYBEROS_TERMUX_SOCKET_PATH:-/run/cyberos/termux.sock}
session_idle_timeout_ms=${CYBEROS_TERMUX_SESSION_IDLE_TIMEOUT_MS:-1800000}
connect_timeout_ms=${CYBEROS_TERMUX_CONNECT_TIMEOUT_MS:-10000}
max_sessions=${CYBEROS_TERMUX_MAX_SESSIONS:-32}
if [ -f "$CONFIG_PATH" ] && [ -z "${CYBEROS_TERMUX_SOCKET_PATH:-}" ]; then
  termux_socket_path=$(awk '
    $0 == "[terminal]" { in_terminal = 1; next }
    in_terminal && /^\[/ { in_terminal = 0 }
    in_terminal && $0 ~ /^[[:space:]]*termux_socket_path[[:space:]]*=/ {
      value = $0
      sub(/^[[:space:]]*termux_socket_path[[:space:]]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^"|"[[:space:]]*$/, "", value)
      print value
      exit
    }
  ' "$CONFIG_PATH")
  termux_socket_path=${termux_socket_path:-/run/cyberos/termux.sock}
fi
if [ -f "$CONFIG_PATH" ] && [ -z "${CYBEROS_TERMUX_SESSION_IDLE_TIMEOUT_MS:-}" ]; then
  session_idle_timeout_ms=$(awk '
    $0 == "[terminal]" { in_terminal = 1; next }
    in_terminal && /^\[/ { in_terminal = 0 }
    in_terminal && $0 ~ /^[[:space:]]*session_idle_timeout_ms[[:space:]]*=/ {
      value = $0
      sub(/^[[:space:]]*session_idle_timeout_ms[[:space:]]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^"|"[[:space:]]*$/, "", value)
      print value
      exit
    }
  ' "$CONFIG_PATH")
  session_idle_timeout_ms=${session_idle_timeout_ms:-1800000}
fi
if [ -f "$CONFIG_PATH" ] && [ -z "${CYBEROS_TERMUX_CONNECT_TIMEOUT_MS:-}" ]; then
  connect_timeout_ms=$(awk '
    $0 == "[terminal]" { in_terminal = 1; next }
    in_terminal && /^\[/ { in_terminal = 0 }
    in_terminal && $0 ~ /^[[:space:]]*connect_timeout_ms[[:space:]]*=/ {
      value = $0
      sub(/^[[:space:]]*connect_timeout_ms[[:space:]]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^"|"[[:space:]]*$/, "", value)
      print value
      exit
    }
  ' "$CONFIG_PATH")
  connect_timeout_ms=${connect_timeout_ms:-10000}
fi
if [ -f "$CONFIG_PATH" ] && [ -z "${CYBEROS_TERMUX_MAX_SESSIONS:-}" ]; then
  max_sessions=$(awk '
    $0 == "[terminal]" { in_terminal = 1; next }
    in_terminal && /^\[/ { in_terminal = 0 }
    in_terminal && $0 ~ /^[[:space:]]*max_sessions[[:space:]]*=/ {
      value = $0
      sub(/^[[:space:]]*max_sessions[[:space:]]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      gsub(/^"|"[[:space:]]*$/, "", value)
      print value
      exit
    }
  ' "$CONFIG_PATH")
  max_sessions=${max_sessions:-32}
fi

[ "$terminal_user" = cyberos ] || {
  printf 'cyberos-termux: terminal user must be cyberos\n' >&2
  exit 1
}

case "$termux_socket_path" in
  /*)
    case "$termux_socket_path" in
      *[!a-zA-Z0-9_./-]*) printf 'cyberos-termux: socket path contains unsupported characters\n' >&2; exit 1 ;;
    esac
    ;;
  *) printf 'cyberos-termux: socket path must be absolute\n' >&2; exit 1 ;;
esac

case "$session_idle_timeout_ms" in ''|*[!0-9]*) printf 'cyberos-termux: invalid session idle timeout\n' >&2; exit 1 ;; esac
[ "$session_idle_timeout_ms" -gt 0 ] || { printf 'cyberos-termux: session idle timeout must be positive\n' >&2; exit 1; }
case "$connect_timeout_ms" in ''|*[!0-9]*) printf 'cyberos-termux: invalid connect timeout\n' >&2; exit 1 ;; esac
[ "$connect_timeout_ms" -gt 0 ] || { printf 'cyberos-termux: connect timeout must be positive\n' >&2; exit 1; }
case "$max_sessions" in ''|*[!0-9]*) printf 'cyberos-termux: invalid maximum session count\n' >&2; exit 1 ;; esac
[ "$max_sessions" -gt 0 ] || { printf 'cyberos-termux: maximum session count must be positive\n' >&2; exit 1; }

passwd_entry=$(getent passwd "$terminal_user") || {
  printf 'cyberos-termux: user %s does not exist\n' "$terminal_user" >&2
  exit 1
}

uid=$(printf '%s\n' "$passwd_entry" | awk -F: '{print $3}')
home=$(printf '%s\n' "$passwd_entry" | awk -F: '{print $6}')
shell=$(printf '%s\n' "$passwd_entry" | awk -F: '{print $7}')
case "$uid" in ''|*[!0-9]*) printf 'cyberos-termux: invalid uid for %s\n' "$terminal_user" >&2; exit 1 ;; esac
[ "$uid" -gt 0 ] || { printf 'cyberos-termux: root terminal user is not allowed\n' >&2; exit 1; }
case "$home" in /*) ;; *) printf 'cyberos-termux: user home must be absolute\n' >&2; exit 1 ;; esac
case "$shell" in /*) ;; *) printf 'cyberos-termux: user shell must be absolute\n' >&2; exit 1 ;; esac
[ -d "$home" ] || { printf 'cyberos-termux: home is not a directory: %s\n' "$home" >&2; exit 1; }
[ -x "$shell" ] || { printf 'cyberos-termux: shell is not executable: %s\n' "$shell" >&2; exit 1; }
[ "$shell" != /usr/sbin/nologin ] && [ "$shell" != /bin/false ] || {
  printf 'cyberos-termux: cyberos requires an interactive shell\n' >&2
  exit 1
}
[ "$home" = /cyberos/home/termux ] || {
  printf 'cyberos-termux: unexpected cyberos home: %s\n' "$home" >&2
  exit 1
}
getent group cyberos >/dev/null || { printf 'cyberos-termux: cyberos group does not exist\n' >&2; exit 1; }

escape_systemd_value() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g'
}

nas_paths=$(awk '
  /^\[\[nas_roots\]\]/ { in_root = 1; next }
  in_root && /^\[/ { in_root = 0 }
  in_root && $0 ~ /^[[:space:]]*path[[:space:]]*=/ {
    value = $0
    sub(/^[[:space:]]*path[[:space:]]*=[[:space:]]*/, "", value)
    sub(/[[:space:]]+#.*$/, "", value)
    gsub(/^"|"[[:space:]]*$/, "", value)
    if (value ~ /^\//) print value
  }
' "$CONFIG_PATH" 2>/dev/null || true)

install -d -m 0755 "$DROPIN_DIR"
tmp_path=$(mktemp "$DROPIN_DIR/.identity.XXXXXX")
trap 'rm -f "$tmp_path"' EXIT HUP INT TERM
{
  printf '[Service]\n'
  printf 'User=%s\n' "$terminal_user"
  printf 'Group=cyberos\n'
  printf 'Environment=CYBEROS_TERMUX_USER=%s\n' "$terminal_user"
  printf 'Environment=CYBEROS_TERMUX_SOCKET_PATH=%s\n' "$termux_socket_path"
  printf 'Environment=CYBEROS_TERMUX_SESSION_IDLE_TIMEOUT_MS=%s\n' "$session_idle_timeout_ms"
  printf 'Environment=CYBEROS_TERMUX_CONNECT_TIMEOUT_MS=%s\n' "$connect_timeout_ms"
  printf 'Environment=CYBEROS_TERMUX_MAX_SESSIONS=%s\n' "$max_sessions"
  printf 'Environment=HOME=%s\n' "$home"
  printf 'WorkingDirectory=%s\n' "$home"
  printf 'ReadWritePaths="%s"\n' "$(escape_systemd_value "$home")"
  printf '%s\n' "$nas_paths" | while IFS= read -r nas_path; do
    [ -n "$nas_path" ] && printf 'ReadWritePaths="%s"\n' "$(escape_systemd_value "$nas_path")"
  done
} > "$tmp_path"
chmod 0644 "$tmp_path"
mv -f "$tmp_path" "$DROPIN_PATH"
trap - EXIT HUP INT TERM

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi
