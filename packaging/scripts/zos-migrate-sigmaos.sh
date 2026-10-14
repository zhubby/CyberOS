#!/bin/sh
set -eu

ACTION=${1:-apply}
LEGACY_CONFIG=/etc/sigmaos/config.toml
LEGACY_STATE=/var/lib/sigmaos
LEGACY_DATABASE=$LEGACY_STATE/sigmaos.sqlite
ZOS_ROOT=/zos
POINTER_PATH=$ZOS_ROOT/state/.legacy-migration-backup
MIGRATION_ROOT=$ZOS_ROOT/system-backups
CONFIG_MIGRATOR=/usr/lib/zos/scripts/zos-migrate-config.mjs
FSTAB_MIGRATOR=/usr/lib/zos/scripts/zos-migrate-fstab.mjs
DATABASE_MIGRATOR=/usr/lib/zos/scripts/zos-migrate-database.mjs

LEGACY_TIMERS='sigmaos-maintenance.timer sigmaos-health.timer sigmaos-backup-daily.timer sigmaos-backup-weekly.timer'
LEGACY_SERVICES='sigmaos-hostd.service sigmaos-termux.service sigmaos-vod-player.service sigmaos-webdav.service sigmaos-api.service sigmaos-worker@1.service sigmaos-photostaff.service sigmaos-downloader.service sigmaos-indexer.service sigmaos-maintenance.service sigmaos-health.service sigmaos-backup-daily.service sigmaos-backup-weekly.service'
SHARE_SERVICES='smbd.service nmbd.service vsftpd.service nfs-server.service minidlna.service'
ZOS_SERVICES='zos-hostd.service zos-termux.service zos-vod-player.service zos-webdav.service zos-api.service zos-worker@1.service zos-photostaff.service zos-downloader.service zos-indexer.service'

backup_dir=
state_file=
status_file=
rollback_required=0
preparation_required=0

log() {
  printf 'zos-migrate-sigmaos: %s\n' "$*"
}

die() {
  log "error: $*" >&2
  exit 1
}

unit_exists() {
  systemctl cat "$1" >/dev/null 2>&1
}

record_unit_state() {
  unit=$1
  unit_exists "$unit" || return 0
  enabled_state=$(systemctl is-enabled "$unit" 2>/dev/null || true)
  if [ "$enabled_state" = enabled ]; then
    : > "$backup_dir/systemd-state/$unit.enabled"
  fi
  if [ "$enabled_state" = masked ]; then
    : > "$backup_dir/systemd-state/$unit.masked"
  fi
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    : > "$backup_dir/systemd-state/$unit.active"
  fi
}

restore_unit_state() {
  unit=$1
  unit_exists "$unit" || return 0
  was_masked=0
  if [ -f "$backup_dir/systemd-state/$unit.masked" ]; then
    was_masked=1
    systemctl unmask "$unit" >/dev/null
  fi
  if [ -f "$backup_dir/systemd-state/$unit.enabled" ]; then
    systemctl enable "$unit" >/dev/null
  else
    systemctl disable "$unit" >/dev/null 2>&1 || true
  fi
  if [ -f "$backup_dir/systemd-state/$unit.active" ]; then
    systemctl start "$unit"
  else
    systemctl stop "$unit" >/dev/null 2>&1 || true
  fi
  if [ "$was_masked" -eq 1 ]; then
    systemctl mask --force "$unit" >/dev/null
  fi
}

load_state() {
  [ -f "$POINTER_PATH" ] && [ ! -L "$POINTER_PATH" ] || return 1
  backup_dir=$(sed -n '1p' "$POINTER_PATH")
  case "$backup_dir" in
    /zos/system-backups/legacy-sigmaos-*) ;;
    *) die "invalid migration backup pointer" ;;
  esac
  state_file=$backup_dir/state.env
  status_file=$backup_dir/status.json
  [ -f "$state_file" ] && [ ! -L "$state_file" ] || die "migration state is missing"
  # The state file is root-owned and contains only values generated below.
  . "$state_file"
}

write_status() {
  migration_status=$1
  node --input-type=module - "$status_file" "$migration_status" "$LEGACY_VERSION" \
    "$SOURCE_CONFIG_SHA256" "$STARTED_AT" "$backup_dir" <<'NODE'
import fs from "node:fs";

const [file, status, sourceVersion, sourceConfigSha256, startedAt, backupPath] = process.argv.slice(2);
const payload = {
  status,
  sourcePackage: "sigmaos",
  sourceVersion,
  sourceConfigSha256,
  startedAt,
  backupPath,
  updatedAt: new Date().toISOString()
};
const temporary = `${file}.tmp.${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, file);
NODE
}

status_value() {
  [ -f "$status_file" ] || return 1
  node --input-type=module - "$status_file" <<'NODE'
import fs from "node:fs";
const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (typeof value.status !== "string") process.exit(1);
process.stdout.write(value.status);
NODE
}

copy_tree() {
  source=$1
  target=$2
  [ -d "$source" ] || return 0
  install -d -m 0750 "$target"
  cp -a --one-file-system "$source/." "$target/"
}

append_mapping() {
  source=$1
  target=$2
  [ -n "$source" ] && [ -n "$target" ] || die "empty path mapping"
  case "$source:$target" in
    /*:/*) ;;
    *) die "path mappings must be absolute" ;;
  esac
  [ "$source" != / ] && [ "$target" != / ] || die "filesystem root cannot be migrated"
  printf '%s\t%s\n' "$source" "$target" >> "$backup_dir/path-mappings.tsv"
}

prepare_path_mappings() {
  : > "$backup_dir/path-mappings.tsv"
  node --input-type=module - "$backup_dir/config-report.json" <<'NODE' >> "$backup_dir/path-mappings.tsv"
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const mapping of report.nasRootMappings ?? []) {
  if (typeof mapping.source !== "string" || typeof mapping.target !== "string") process.exit(1);
  process.stdout.write(`${mapping.source}\t${mapping.target}\n`);
}
NODE
  append_mapping /srv/backup /zos/data/backup
  append_mapping /srv/apps /zos/apps
  append_mapping /srv/iso /zos/iso
  append_mapping /var/lib/sigmaos/vmstore /zos/vm
  awk -F '\t' '
    NF != 2 || $1 !~ /^\// || $2 !~ /^\/zos\// ||
    $1 == "/" || $1 == "/zos" || index($1, "/zos/") == 1 ||
    seen_source[$1]++ || seen_target[$2]++ { exit 1 }
    { source[NR] = $1 }
    END {
      for (left = 1; left <= NR; left++) {
        for (right = left + 1; right <= NR; right++) {
          if (index(source[left], source[right] "/") == 1 ||
              index(source[right], source[left] "/") == 1) exit 1
        }
      }
    }
  ' "$backup_dir/path-mappings.tsv" || \
    die "invalid generated path mappings"
}

replace_fstab() {
  fstab_source=$1
  fstab_temp=$(mktemp /etc/.fstab.zos-migrate.XXXXXX)
  if ! install -o root -g root -m 0644 "$fstab_source" "$fstab_temp"; then
    rm -f "$fstab_temp"
    return 1
  fi
  mv -f "$fstab_temp" /etc/fstab
}

copy_managed_paths() {
  while IFS="$(printf '\t')" read -r source target; do
    [ -d "$source" ] || continue
    copy_tree "$source" "$target"
  done < "$backup_dir/path-mappings.tsv"
}

path_size_bytes() {
  [ -d "$1" ] || {
    printf '0\n'
    return 0
  }
  du -sx --apparent-size --block-size=1 "$1" | awk '{ print $1 }'
}

verify_capacity() {
  required_bytes=1073741824
  for source_path in \
    /var/lib/sigmaos \
    /var/lib/sigmaos-termux \
    /var/lib/sigmaos-vod-player \
    /var/lib/sigmaos-share; do
    source_size=$(path_size_bytes "$source_path")
    required_bytes=$((required_bytes + source_size * 2))
  done
  while IFS="$(printf '\t')" read -r source _target; do
    source_size=$(path_size_bytes "$source")
    required_bytes=$((required_bytes + source_size))
  done < "$backup_dir/path-mappings.tsv"
  available_bytes=$(df -B1 --output=avail "$ZOS_ROOT" | awk 'NR == 2 { print $1 }')
  case "$available_bytes" in
    ''|*[!0-9]*) die "unable to determine free space for migration" ;;
  esac
  [ "$available_bytes" -ge "$required_bytes" ] || \
    die "migration needs at least $required_bytes free bytes under /zos; only $available_bytes are available"
  log "capacity check passed: required=$required_bytes available=$available_bytes"
}

verify_legacy_libvirt_paths() {
  [ -d /etc/libvirt/qemu ] || return 0
  reference_count=0
  for domain_xml in /etc/libvirt/qemu/*.xml; do
    [ -f "$domain_xml" ] && [ ! -L "$domain_xml" ] || continue
    while IFS="$(printf '\t')" read -r source _target; do
      [ -n "$source" ] || continue
      if grep -Fq -- "$source" "$domain_xml"; then
        reference_count=$((reference_count + 1))
      fi
    done < "$backup_dir/path-mappings.tsv"
  done
  [ "$reference_count" -eq 0 ] || \
    die "registered VM definitions contain $reference_count legacy storage path references"
}

move_legacy_mounts() {
  : > "$backup_dir/mount-moves.tsv"
  while IFS="$(printf '\t')" read -r source target; do
    candidates=$backup_dir/mount-candidates.tsv
    : > "$candidates"
    findmnt -rn -o TARGET | while IFS= read -r mount_target; do
        case "$mount_target" in
          "$source"|"$source"/*)
            depth=$(printf '%s\n' "$mount_target" | awk -F/ '{ print NF }')
            printf '%s\t%s\n' "$depth" "$mount_target" >> "$candidates"
            ;;
        esac
      done
    sort -n -k1,1 "$candidates" | cut -f2- | while IFS= read -r mount_target; do
        # Moving a parent mount also moves its submounts. Skip stale child
        # paths emitted by the snapshot above after their parent has moved.
        findmnt -rn --mountpoint "$mount_target" >/dev/null 2>&1 || continue
        suffix=${mount_target#"$source"}
        new_mount_target=$target$suffix
        install -d -o zos -g zos -m 0750 "$new_mount_target"
        log "moving mount $mount_target to $new_mount_target"
        printf '%s\t%s\n' "$mount_target" "$new_mount_target" >> "$backup_dir/mount-moves.tsv"
        mount --move "$mount_target" "$new_mount_target"
      done
    rm -f "$candidates"
  done < "$backup_dir/path-mappings.tsv"
}

restore_mounts() {
  [ -f "$backup_dir/mount-moves.tsv" ] || return 0
  reverse_moves=$backup_dir/mount-moves.reverse.tsv
  tac "$backup_dir/mount-moves.tsv" > "$reverse_moves"
  while IFS="$(printf '\t')" read -r old_target new_target; do
    [ -n "$old_target" ] && [ -n "$new_target" ] || continue
    if findmnt -rn --mountpoint "$old_target" >/dev/null 2>&1; then
      continue
    elif findmnt -rn --mountpoint "$new_target" >/dev/null 2>&1; then
      install -d -m 0750 "$old_target"
      log "restoring mount $new_target to $old_target"
      mount --move "$new_target" "$old_target"
    else
      log "error: migrated mount is missing from both $old_target and $new_target" >&2
      return 1
    fi
  done < "$reverse_moves"
  rm -f "$reverse_moves"
}

rollback_migration() {
  for unit in $ZOS_SERVICES; do
    systemctl stop "$unit" >/dev/null 2>&1 || true
  done
  if ! restore_mounts; then
    write_status rollback_failed || true
    log "error: mount rollback failed; legacy services remain stopped for data safety" >&2
    return 1
  fi
  if [ -f "$backup_dir/fstab" ]; then
    replace_fstab "$backup_dir/fstab"
  fi
  restore_failed=0
  for unit in $LEGACY_SERVICES $LEGACY_TIMERS; do
    unit_exists "$unit" || continue
    if ! systemctl unmask "$unit" >/dev/null 2>&1; then
      log "error: failed to unmask $unit during rollback" >&2
      restore_failed=1
    fi
  done
  if ! systemctl daemon-reload >/dev/null 2>&1; then
    log "error: systemd daemon reload failed during rollback" >&2
    restore_failed=1
  fi
  for unit in $LEGACY_SERVICES $LEGACY_TIMERS $SHARE_SERVICES; do
    if ! restore_unit_state "$unit" >/dev/null 2>&1; then
      log "error: failed to restore $unit during rollback" >&2
      restore_failed=1
    fi
  done
  if [ "$restore_failed" -ne 0 ]; then
    write_status rollback_failed || true
    return 1
  fi
  write_status rolled_back
  rollback_required=0
  log "legacy layout restored; migrated copies remain under /zos for diagnosis"
}

rollback_on_failure() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$rollback_required" -eq 1 ] && [ -n "$backup_dir" ]; then
    log "migration failed; restoring legacy mounts, fstab, and services" >&2
    rollback_migration || true
  elif [ "$preparation_required" -eq 1 ] && [ -n "$backup_dir" ]; then
    rm -f "$POINTER_PATH"
    log "migration preparation failed before legacy data was changed; retry is safe" >&2
  fi
  exit "$status"
}

apply_migration() {
  [ -f "$LEGACY_CONFIG" ] || {
    log "legacy configuration is absent; no migration required"
    return 0
  }
  if load_state; then
    current_status=$(status_value || true)
    case "$current_status" in
      pending|committed)
        log "migration is already $current_status"
        return 0
        ;;
      rolled_back)
        log "starting a new migration attempt after the previous rollback"
        rm -f "$POINTER_PATH"
        backup_dir=
        state_file=
        status_file=
        ;;
      *) die "existing migration state is $current_status; inspect $backup_dir before retrying" ;;
    esac
  fi

  command -v node >/dev/null 2>&1 || die "Node.js is required"
  command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is required"
  command -v findmnt >/dev/null 2>&1 || die "findmnt is required"
  command -v mount >/dev/null 2>&1 || die "mount is required"
  command -v systemctl >/dev/null 2>&1 || die "systemd is required"
  [ -x "$CONFIG_MIGRATOR" ] || die "configuration migrator is missing"
  [ -x "$FSTAB_MIGRATOR" ] || die "fstab migrator is missing"
  [ -x "$DATABASE_MIGRATOR" ] || die "database migrator is missing"
  [ -f "$LEGACY_DATABASE" ] || die "legacy database is missing"

  LEGACY_VERSION=$(dpkg-query -W -f='${Version}' sigmaos 2>/dev/null || true)
  case "$LEGACY_VERSION" in
    ''|*[!0-9A-Za-z.+:~-]*) die "legacy package version is invalid" ;;
  esac
  STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_dir=$(mktemp -d "$MIGRATION_ROOT/legacy-sigmaos-$timestamp.XXXXXX")
  state_file=$backup_dir/state.env
  status_file=$backup_dir/status.json
  chown root:root "$backup_dir"
  chmod 0700 "$backup_dir"
  install -d -o root -g root -m 0700 "$backup_dir/systemd-state"
  printf '%s\n' "$backup_dir" > "$POINTER_PATH"
  chmod 0600 "$POINTER_PATH"
  preparation_required=1
  trap rollback_on_failure EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  /usr/local/bin/node "$CONFIG_MIGRATOR" "$LEGACY_CONFIG" \
    "$backup_dir/config.toml" "$backup_dir/config-report.json"
  SOURCE_CONFIG_SHA256=$(node --input-type=module - "$backup_dir/config-report.json" <<'NODE'
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (typeof report.sourceConfigSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(report.sourceConfigSha256)) process.exit(1);
process.stdout.write(report.sourceConfigSha256);
NODE
  )
  cat > "$state_file" <<EOF
LEGACY_VERSION='$LEGACY_VERSION'
SOURCE_CONFIG_SHA256='$SOURCE_CONFIG_SHA256'
STARTED_AT='$STARTED_AT'
EOF
  chmod 0600 "$state_file"
  write_status preparing
  prepare_path_mappings
  command -v du >/dev/null 2>&1 || die "du is required"
  command -v df >/dev/null 2>&1 || die "df is required"
  command -v grep >/dev/null 2>&1 || die "grep is required"
  verify_capacity
  verify_legacy_libvirt_paths

  for unit in $LEGACY_SERVICES $LEGACY_TIMERS $SHARE_SERVICES; do
    record_unit_state "$unit"
  done
  preparation_required=0
  rollback_required=1

  log "stopping legacy writers and services"
  for unit in $LEGACY_TIMERS $LEGACY_SERVICES $SHARE_SERVICES; do
    unit_exists "$unit" && systemctl stop "$unit"
  done

  database_check=$(sqlite3 "$LEGACY_DATABASE" 'PRAGMA integrity_check;')
  [ "$database_check" = ok ] || die "legacy database integrity check failed: $database_check"
  checkpoint_result=$(sqlite3 -separator '|' "$LEGACY_DATABASE" 'PRAGMA wal_checkpoint(TRUNCATE);')
  case "$checkpoint_result" in
    0\|*) ;;
    *) die "legacy database WAL checkpoint failed or remained busy: $checkpoint_result" ;;
  esac
  [ ! -s "$LEGACY_DATABASE-wal" ] || die "legacy database WAL was not truncated"
  database_check=$(sqlite3 "$LEGACY_DATABASE" 'PRAGMA integrity_check;')
  [ "$database_check" = ok ] || die "legacy database integrity check failed after checkpoint: $database_check"
  printf '%s\n' "$database_check" > "$backup_dir/database-integrity.txt"

  log "creating cold migration backup"
  tar --one-file-system -C /etc -cf "$backup_dir/config.tar" sigmaos
  state_paths=sigmaos
  [ -d /var/lib/sigmaos-termux ] && state_paths="$state_paths sigmaos-termux"
  [ -d /var/lib/sigmaos-vod-player ] && state_paths="$state_paths sigmaos-vod-player"
  [ -d /var/lib/sigmaos-share ] && state_paths="$state_paths sigmaos-share"
  # shellcheck disable=SC2086
  tar --one-file-system -C /var/lib -cf "$backup_dir/state.tar" $state_paths
  cp -p /etc/fstab "$backup_dir/fstab"

  log "copying legacy state into the ZOS layout"
  copy_tree /etc/sigmaos /zos/config
  copy_tree /var/lib/sigmaos /zos/state
  copy_tree /var/lib/sigmaos-termux /zos/home/termux
  copy_tree /var/lib/sigmaos-vod-player /zos/state/vod-player
  copy_tree /var/lib/sigmaos-share /zos/home/share
  copy_managed_paths

  cp -p "$LEGACY_DATABASE" /zos/state/zos.sqlite
  rm -f /zos/state/zos.sqlite-wal /zos/state/zos.sqlite-shm
  rm -f /zos/state/sigmaos.sqlite /zos/state/sigmaos.sqlite-wal /zos/state/sigmaos.sqlite-shm
  /usr/local/bin/node "$DATABASE_MIGRATOR" /zos/state/zos.sqlite \
    "$backup_dir/path-mappings.tsv" "$backup_dir/database-migration.json"
  if [ -d /zos/state/docker-daemon ]; then
    copy_tree /zos/state/docker-daemon /zos/state/hostd/docker-daemon
    rm -rf /zos/state/docker-daemon
  fi
  if [ -d /zos/state/network-manager ]; then
    copy_tree /zos/state/network-manager /zos/state/hostd/network-manager
    rm -rf /zos/state/network-manager
  fi
  rm -rf /zos/state/vmstore
  install -o root -g zos -m 0640 "$backup_dir/config.toml" /zos/config/config.toml
  if [ -f /zos/config/restic-password ]; then
    chown root:zos /zos/config/restic-password
    chmod 0640 /zos/config/restic-password
  fi

  move_legacy_mounts
  /usr/local/bin/node "$FSTAB_MIGRATOR" /etc/fstab \
    "$backup_dir/path-mappings.tsv" "$backup_dir/fstab.migrated"
  replace_fstab "$backup_dir/fstab.migrated"

  # Never descend into migrated NAS mounts while normalizing ownership.
  chown -R --one-file-system zos:zos \
    /zos/state /zos/logs /zos/home/termux /zos/apps /zos/data /zos/vm /zos/iso
  chown -R root:root /zos/state/hostd /zos/system-backups
  chown root:root "$POINTER_PATH"
  chmod 0600 "$POINTER_PATH"
  chown root:zos /zos /zos/config /zos/config/config.toml
  chmod 0750 /zos /zos/config
  chmod 0640 /zos/config/config.toml

  log "masking legacy services until ZOS verification commits the migration"
  for unit in $LEGACY_SERVICES $LEGACY_TIMERS; do
    unit_exists "$unit" || continue
    systemctl disable "$unit" >/dev/null 2>&1 || true
    systemctl mask --force "$unit" >/dev/null
  done
  systemctl daemon-reload
  write_status pending
  rollback_required=0
  trap - EXIT HUP INT TERM
  log "migration staged; waiting for ZOS runtime verification"
}

[ "$(id -u)" -eq 0 ] || die "must run as root"

case "$ACTION" in
  apply)
    apply_migration
    ;;
  status)
    if load_state && [ -f "$status_file" ]; then
      cat "$status_file"
    else
      printf '%s\n' '{"status":"none"}'
    fi
    ;;
  commit)
    if load_state && [ "$(status_value)" = pending ]; then
      write_status committed
      log "migration committed"
    fi
    ;;
  rollback)
    if load_state && [ "$(status_value)" = pending ]; then
      rollback_required=1
      rollback_migration
    fi
    ;;
  *)
    die "usage: zos-migrate-sigmaos.sh [apply|status|commit|rollback]"
    ;;
esac
