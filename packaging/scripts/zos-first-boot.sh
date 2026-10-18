#!/bin/sh
set -eu

CONFIG_PATH="${ZOS_CONFIG:-/zos/config/config.toml}"
ROOT_DIR="${ZOS_ROOT:-/zos}"
STATE_DIR="$ROOT_DIR/state"
DATABASE_PATH="$STATE_DIR/zos.sqlite"
ADMIN_DISPLAY_NAME="${ZOS_ADMIN_DISPLAY_NAME:-}"
NAS_ROOT_ID="${ZOS_NAS_ROOT_ID:-primary}"
NAS_ROOT_NAME="${ZOS_NAS_ROOT_NAME:-Primary NAS}"
NAS_ROOT_PATH="${ZOS_NAS_ROOT_PATH:-}"
MODEL_PROVIDER="${ZOS_MODEL_PROVIDER:-pi}"
PI_COMMAND="${ZOS_PI_COMMAND:-pi}"
LOCAL_ENDPOINT="${ZOS_LOCAL_ENDPOINT:-}"
DOCKER_ENABLED="${ZOS_DOCKER_ENABLED:-0}"
VM_ENABLED="${ZOS_VM_ENABLED:-0}"
VOD_PLAYER_ENABLED="${ZOS_VOD_PLAYER_ENABLED:-${ZOS_ENABLE_VOD_PLAYER:-0}}"
VOD_PLAYER_USER="${ZOS_VOD_PLAYER_USER:-zos}"
TERMINAL_USER="${ZOS_TERMUX_USER:-zos}"

if [ -e "$CONFIG_PATH" ] && [ "${ZOS_FIRST_BOOT_FORCE:-0}" != "1" ]; then
  printf "ZOS configuration already exists at %s; preserving it\n" "$CONFIG_PATH"
  exit 0
fi

[ "$ROOT_DIR" = "/zos" ] || {
  printf "ZOS_ROOT must be /zos for production first boot\n" >&2
  exit 1
}
[ "$CONFIG_PATH" = "/zos/config/config.toml" ] || {
  printf "ZOS_CONFIG must be /zos/config/config.toml for production first boot\n" >&2
  exit 1
}

[ "$TERMINAL_USER" = zos ] || {
  printf "ZOS_TERMUX_USER must be zos\n" >&2
  exit 1
}

case "$DOCKER_ENABLED" in
  0|1) ;;
  *) printf "ZOS_DOCKER_ENABLED must be 0 or 1\n" >&2; exit 1 ;;
esac
case "$VM_ENABLED" in
  0|1) ;;
  *) printf "ZOS_VM_ENABLED must be 0 or 1\n" >&2; exit 1 ;;
esac
case "$VOD_PLAYER_ENABLED" in
  0|1) ;;
  *) printf "ZOS_VOD_PLAYER_ENABLED must be 0 or 1\n" >&2; exit 1 ;;
esac
case "$VOD_PLAYER_USER" in
  *[!a-zA-Z0-9._-]*|root) printf "ZOS_VOD_PLAYER_USER must name a non-root local user\n" >&2; exit 1 ;;
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
  ADMIN_DISPLAY_NAME="$(ask_default "Admin display name" "ZOS Admin")"
fi

if [ -z "$NAS_ROOT_PATH" ]; then
  NAS_ROOT_PATH="$(ask_default "NAS root path" "/zos/data/primary")"
fi

[ "$(dirname "$NAS_ROOT_PATH")" = "$ROOT_DIR/data" ] || {
  printf "ZOS_NAS_ROOT_PATH must be a direct child of /zos/data\n" >&2
  exit 1
}
[ "$NAS_ROOT_PATH" != "$ROOT_DIR/data/backup" ] || {
  printf "ZOS_NAS_ROOT_PATH must not use the reserved backup directory\n" >&2
  exit 1
}

install -d -m 0750 "$ROOT_DIR" "$ROOT_DIR/config" "$STATE_DIR" "$STATE_DIR/trash" \
  "$STATE_DIR/reports" "$STATE_DIR/pi-sessions" "$STATE_DIR/pi-agent" \
  "$STATE_DIR/photostaff" "$STATE_DIR/media-cache" "$STATE_DIR/backup-staging" \
  "$STATE_DIR/vod-player" "$ROOT_DIR/logs" "$ROOT_DIR/home" \
  "$ROOT_DIR/home/termux" "$ROOT_DIR/apps" "$ROOT_DIR/deploy" \
  "$ROOT_DIR/system-backups" "$ROOT_DIR/data" "$ROOT_DIR/data/backup" "$NAS_ROOT_PATH"
install -d -m 0711 "$ROOT_DIR/vm" "$ROOT_DIR/iso"
install -d -m 0755 "$ROOT_DIR/home/share" "$STATE_DIR/hostd"
install -d -m 0700 "$STATE_DIR/hostd/docker-daemon" \
  "$STATE_DIR/hostd/network-manager" "$ROOT_DIR/system-backups/permissions"

umask 077
cat > "$CONFIG_PATH" <<EOF_CONFIG
root_dir = "$ROOT_DIR"
environment = "production"

[api]
host = "127.0.0.1"
port = 3010
allowed_origins = []

[worker]
poll_ms = 750

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

[model]
provider = "$MODEL_PROVIDER"
pi_command = "$PI_COMMAND"
local_endpoint = "$LOCAL_ENDPOINT"

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
socket_path = "/run/zos/hostd.sock"

[shares]
enabled = false
account_username = "zos-share"

[terminal]
user = "$TERMINAL_USER"
termux_socket_path = "/run/zos/termux.sock"
session_idle_timeout_ms = 1800000
connect_timeout_ms = 10000
max_sessions = 32

[vod_player]
enabled = $VOD_PLAYER_ENABLED_BOOL
socket_path = "/run/zos/vod-player.sock"
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

[[nas_roots]]
id = "$NAS_ROOT_ID"
name = "$NAS_ROOT_NAME"
path = "$NAS_ROOT_PATH"
mount_policy = "required"

[backup]
enabled = false
repository_path = "$ROOT_DIR/data/backup/restic"
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

if id zos >/dev/null 2>&1; then
  chown root:zos "$ROOT_DIR" "$ROOT_DIR/config"
  chown zos:zos "$STATE_DIR" "$STATE_DIR/trash" "$STATE_DIR/reports" \
    "$STATE_DIR/pi-sessions" "$STATE_DIR/pi-agent" "$STATE_DIR/photostaff" \
    "$STATE_DIR/media-cache" "$STATE_DIR/backup-staging" "$STATE_DIR/vod-player" \
    "$ROOT_DIR/logs" \
    "$ROOT_DIR/home" "$ROOT_DIR/home/termux" "$ROOT_DIR/apps" "$ROOT_DIR/deploy" \
    "$ROOT_DIR/system-backups" "$ROOT_DIR/data" "$ROOT_DIR/data/backup" \
    "$ROOT_DIR/vm" "$ROOT_DIR/iso" "$NAS_ROOT_PATH"
  chown root:zos "$CONFIG_PATH"
fi
chown -R root:root "$STATE_DIR/hostd" "$ROOT_DIR/system-backups/permissions"
chmod 0640 "$CONFIG_PATH"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATABASE_PATH" <<EOF_SQL
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO users (id, display_name, created_at)
VALUES ('local-admin', '$ADMIN_DISPLAY_NAME', datetime('now'));
EOF_SQL
  if id zos >/dev/null 2>&1; then
    chown zos:zos "$DATABASE_PATH" "$DATABASE_PATH"-* 2>/dev/null || true
  fi
fi

printf "ZOS first boot initialized %s with NAS root %s\n" "$CONFIG_PATH" "$NAS_ROOT_PATH"
