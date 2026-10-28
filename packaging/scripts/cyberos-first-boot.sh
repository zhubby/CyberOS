#!/bin/sh
set -eu

CONFIG_PATH="${CYBEROS_CONFIG:-/cyberos/config/config.toml}"
ROOT_DIR="${CYBEROS_ROOT:-/cyberos}"
STATE_DIR="$ROOT_DIR/state"
DATABASE_PATH="$STATE_DIR/cyberos.sqlite"
ADMIN_DISPLAY_NAME="${CYBEROS_ADMIN_DISPLAY_NAME:-}"
DOCKER_ENABLED="${CYBEROS_DOCKER_ENABLED:-0}"
VM_ENABLED="${CYBEROS_VM_ENABLED:-0}"
VOD_PLAYER_ENABLED="${CYBEROS_VOD_PLAYER_ENABLED:-${CYBEROS_ENABLE_VOD_PLAYER:-0}}"
VOD_PLAYER_USER="${CYBEROS_VOD_PLAYER_USER:-cyberos}"
TERMINAL_USER="${CYBEROS_TERMINALD_USER:-cyberos}"

if [ -e "$CONFIG_PATH" ] && [ "${CYBEROS_FIRST_BOOT_FORCE:-0}" != "1" ]; then
  printf "CyberOS configuration already exists at %s; preserving it\n" "$CONFIG_PATH"
  exit 0
fi

[ "$ROOT_DIR" = "/cyberos" ] || {
  printf "CYBEROS_ROOT must be /cyberos for production first boot\n" >&2
  exit 1
}
[ "$CONFIG_PATH" = "/cyberos/config/config.toml" ] || {
  printf "CYBEROS_CONFIG must be /cyberos/config/config.toml for production first boot\n" >&2
  exit 1
}
[ ! -e "$DATABASE_PATH" ] && [ ! -L "$DATABASE_PATH" ] || {
  printf "CyberOS first boot requires a new database; remove %s before installation\n" "$DATABASE_PATH" >&2
  exit 1
}

[ "$TERMINAL_USER" = cyberos ] || {
  printf "CYBEROS_TERMINALD_USER must be cyberos\n" >&2
  exit 1
}

case "$DOCKER_ENABLED" in
  0|1) ;;
  *) printf "CYBEROS_DOCKER_ENABLED must be 0 or 1\n" >&2; exit 1 ;;
esac
case "$VM_ENABLED" in
  0|1) ;;
  *) printf "CYBEROS_VM_ENABLED must be 0 or 1\n" >&2; exit 1 ;;
esac
case "$VOD_PLAYER_ENABLED" in
  0|1) ;;
  *) printf "CYBEROS_VOD_PLAYER_ENABLED must be 0 or 1\n" >&2; exit 1 ;;
esac
case "$VOD_PLAYER_USER" in
  *[!a-zA-Z0-9._-]*|root) printf "CYBEROS_VOD_PLAYER_USER must name a non-root local user\n" >&2; exit 1 ;;
esac
getent passwd "$VOD_PLAYER_USER" >/dev/null || {
  printf "VOD player user does not exist: %s\n" "$VOD_PLAYER_USER" >&2
  exit 1
}

DOCKER_ENABLED_BOOL=false
VM_ENABLED_BOOL=false
VOD_PLAYER_ENABLED_BOOL=false
[ "$DOCKER_ENABLED" = "1" ] && DOCKER_ENABLED_BOOL=true
[ "$VM_ENABLED" = "1" ] && VM_ENABLED_BOOL=true
[ "$VOD_PLAYER_ENABLED" = "1" ] && VOD_PLAYER_ENABLED_BOOL=true

ask_default() {
  prompt="$1"
  default="$2"
  if [ -t 0 ]; then
    printf "%s [%s]: " "$prompt" "$default" >&2
    read -r answer || answer=""
    if [ -n "$answer" ]; then
      printf "%s" "$answer"
      return
    fi
  fi
  printf "%s" "$default"
}

if [ -z "$ADMIN_DISPLAY_NAME" ]; then
  ADMIN_DISPLAY_NAME="$(ask_default "Admin display name" "CyberOS Admin")"
fi

install -d -m 0750 "$ROOT_DIR" "$ROOT_DIR/config" "$STATE_DIR" "$STATE_DIR/trash" \
  "$STATE_DIR/reports" "$STATE_DIR/pi-sessions" "$STATE_DIR/pi-agent" \
  "$STATE_DIR/photos" "$STATE_DIR/media-cache" "$STATE_DIR/backup-staging" \
  "$STATE_DIR/vod-player" "$STATE_DIR/bluetooth" "$ROOT_DIR/logs" "$ROOT_DIR/home" \
  "$ROOT_DIR/home/terminal" "$ROOT_DIR/apps" "$ROOT_DIR/deploy" \
  "$ROOT_DIR/system-backups" "$ROOT_DIR/data" "$ROOT_DIR/backup"
install -d -m 0700 "$ROOT_DIR/config/mcp"
install -d -m 0711 "$ROOT_DIR/vm" "$ROOT_DIR/iso"
install -d -m 0755 "$ROOT_DIR/home/share" "$STATE_DIR/hostd"
install -d -m 0700 "$STATE_DIR/hostd/docker-daemon" \
  "$STATE_DIR/hostd/network-manager" "$STATE_DIR/hostd/bluetooth" "$ROOT_DIR/system-backups/permissions"

umask 077
cat > "$CONFIG_PATH" <<EOF_CONFIG
root_dir = "$ROOT_DIR"
environment = "production"

[api]
host = "127.0.0.1"
port = 3010
allowed_origins = []

[mcp]
enabled = true
pi_enabled = false
pi_token_file = "mcp/pi.token"
external_enabled = false
shell_enabled = false
allowed_hosts = ["localhost", "127.0.0.1", "[::1]"]
allowed_origins = ["localhost", "127.0.0.1", "[::1]"]
max_concurrent_per_client = 4

[worker]
poll_ms = 750
concurrency = 2

[monitoring]
enabled = true
fast_sample_interval_ms = 10000
standard_sample_interval_ms = 30000
temperature_sample_interval_ms = 300000
raw_retention_ms = 172800000
minute_retention_ms = 2592000000
hour_retention_ms = 31536000000
max_database_bytes = 536870912

[admin]
display_name = "$ADMIN_DISPLAY_NAME"
auth_mode = "local-only"

[docker]
enabled = $DOCKER_ENABLED_BOOL
socket_path = "/var/run/docker.sock"
compose_command = "docker"
operation_timeout_ms = 120000
console_shells = ["/bin/sh", "/bin/bash"]

[vm]
enabled = $VM_ENABLED_BOOL
libvirt_uri = "qemu:///system"
storage_path = "$ROOT_DIR/vm"
network_name = "default"
iso_roots = ["$ROOT_DIR/iso"]
operation_timeout_ms = 120000
console_mode = "serial"

[hostd]
socket_path = "/run/cyberos/hostd.sock"

[shares]
enabled = false
account_username = "cyberos-share"

[terminal]
user = "$TERMINAL_USER"
socket_path = "/run/cyberos/terminald.sock"
session_idle_timeout_ms = 1800000
connect_timeout_ms = 10000
max_sessions = 32

[vod_player]
enabled = $VOD_PLAYER_ENABLED_BOOL
socket_path = "/run/cyberos/vod-player.sock"
state_path = "$STATE_DIR/vod-player/session.json"
command_timeout_ms = 5000
startup_timeout_ms = 15000
checkpoint_interval_ms = 5000
retry_base_delay_ms = 2000
retry_max_delay_ms = 60000
video_output = "drm"
drm_connector = ""
audio_output = "alsa"
audio_device = ""
hwdec = "auto-safe"
user = "$VOD_PLAYER_USER"

[backup]
enabled = false
repository = "$ROOT_DIR/backup"
password_file = "$ROOT_DIR/config/restic-password"
staging_path = "$STATE_DIR/backup-staging"
require_mount = true
retry_count = 2
timeout_ms = 300000
keep_daily = 7
keep_weekly = 4

[health]
stale_index_warning_ms = 7200000
stale_index_critical_ms = 21600000
stalled_run_ms = 900000
consecutive_failure_threshold = 2
backup_stale_ms = 93600000
EOF_CONFIG

if id cyberos >/dev/null 2>&1; then
  chown root:cyberos "$ROOT_DIR" "$ROOT_DIR/config"
  chown cyberos:cyberos "$ROOT_DIR/config/mcp"
  chown cyberos:cyberos "$STATE_DIR" "$STATE_DIR/trash" "$STATE_DIR/reports" \
    "$STATE_DIR/pi-sessions" "$STATE_DIR/pi-agent" "$STATE_DIR/photos" \
    "$STATE_DIR/media-cache" "$STATE_DIR/backup-staging" "$STATE_DIR/vod-player" "$STATE_DIR/bluetooth" \
    "$ROOT_DIR/logs" \
    "$ROOT_DIR/home" "$ROOT_DIR/home/terminal" "$ROOT_DIR/apps" "$ROOT_DIR/deploy" \
    "$ROOT_DIR/system-backups" "$ROOT_DIR/data" "$ROOT_DIR/backup" \
    "$ROOT_DIR/vm" "$ROOT_DIR/iso"
  chown root:cyberos "$CONFIG_PATH"
fi
chown -R root:root "$STATE_DIR/hostd" "$ROOT_DIR/system-backups/permissions"
chmod 0640 "$CONFIG_PATH"

printf "CyberOS first boot initialized %s with data namespace %s\n" "$CONFIG_PATH" "$ROOT_DIR/data"
