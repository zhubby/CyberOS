#!/bin/sh
set -eu
export LC_ALL=C

log() {
  printf 'zos-relocate-mount: %s\n' "$*"
}

die() {
  log "error: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || die "usage: zos-relocate-mount.sh <source-mount> <target-mount>"

source_mount=$1
target_mount=$2

case "$source_mount:$target_mount" in
  /*:/*) ;;
  *) die "mount paths must be absolute" ;;
esac

[ "$source_mount" != "$target_mount" ] || die "source and target mounts must differ"
findmnt -rn --mountpoint "$source_mount" >/dev/null 2>&1 || \
  die "source is not a mountpoint: $source_mount"
[ -d "$target_mount" ] || die "target directory does not exist: $target_mount"
if findmnt -rn --mountpoint "$target_mount" >/dev/null 2>&1; then
  die "target is already a mountpoint: $target_mount"
fi

target_bound=0

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$target_bound" -eq 1 ]; then
    umount --recursive "$target_mount" >/dev/null 2>&1 || true
  fi
  exit "$status"
}

trap cleanup EXIT HUP INT TERM

if mount --move "$source_mount" "$target_mount" 2>/dev/null; then
  findmnt -rn --mountpoint "$target_mount" >/dev/null 2>&1 || \
    die "target mount is missing after direct relocation: $target_mount"
  if findmnt -rn --mountpoint "$source_mount" >/dev/null 2>&1; then
    die "source mount remains after direct relocation: $source_mount"
  fi
  exit 0
fi

log "direct move is unavailable; using recursive bind relocation"
mount --rbind "$source_mount" "$target_mount"
target_bound=1

# Detach the cloned tree from shared propagation before unmounting the source.
# Otherwise an unmount event can propagate to the new location as well.
mount --make-rprivate "$target_mount"
findmnt -rn --mountpoint "$target_mount" >/dev/null 2>&1 || \
  die "target mount is missing after recursive bind: $target_mount"

umount --recursive "$source_mount"
if findmnt -rn --mountpoint "$source_mount" >/dev/null 2>&1; then
  die "source mount remains after recursive bind relocation: $source_mount"
fi
findmnt -rn --mountpoint "$target_mount" >/dev/null 2>&1 || \
  die "target mount disappeared after recursive bind relocation: $target_mount"

target_bound=0
