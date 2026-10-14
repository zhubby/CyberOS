#!/bin/bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "zos-relocate-mount.test: run as root inside an isolated mount namespace" >&2
  exit 1
fi

if [[ "${ZOS_MOUNT_TEST_NAMESPACE:-}" != isolated ]]; then
  echo "zos-relocate-mount.test: ZOS_MOUNT_TEST_NAMESPACE=isolated is required" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
relocator="$repo_root/packaging/scripts/zos-relocate-mount.sh"
test_root="$(mktemp -d)"
source_parent="$test_root/source"
source_mount="$source_parent/pool"
target_parent="$test_root/target"
target_mount="$target_parent/pool"

cleanup() {
  status=$?
  trap - EXIT
  set +e
  if mountpoint -q "$source_parent"; then
    mount --make-rprivate "$source_parent"
    umount --recursive "$source_parent"
  fi
  if mountpoint -q "$target_mount"; then
    umount --recursive "$target_mount"
  fi
  if mountpoint -q "$target_parent"; then
    mount --make-rprivate "$target_parent"
    umount --recursive "$target_parent"
  fi
  rm -rf -- "$test_root"
  exit "$status"
}

trap cleanup EXIT

mkdir -p "$source_mount" "$target_mount"
mount --bind "$source_parent" "$source_parent"
mount --make-shared "$source_parent"
mount --bind "$target_parent" "$target_parent"
mount --make-shared "$target_parent"
mount -t tmpfs -o size=1m zos-relocate-root "$source_mount"
mkdir -p "$source_mount/nested"
mount -t tmpfs -o size=1m zos-relocate-nested "$source_mount/nested"
printf 'root\n' > "$source_mount/root.txt"
printf 'nested\n' > "$source_mount/nested/nested.txt"

if mount --move "$source_mount" "$target_mount" 2>/dev/null; then
  echo "zos-relocate-mount.test: shared-parent setup unexpectedly allowed a direct move" >&2
  exit 1
fi

forward_output="$("$relocator" "$source_mount" "$target_mount")"
grep -Fq "using recursive bind relocation" <<< "$forward_output"
! findmnt -rn --mountpoint "$source_mount" >/dev/null
findmnt -rn --mountpoint "$target_mount" >/dev/null
findmnt -rn --mountpoint "$target_mount/nested" >/dev/null
grep -Fxq root "$target_mount/root.txt"
grep -Fxq nested "$target_mount/nested/nested.txt"
[[ "$(findmnt -rn -o PROPAGATION --mountpoint "$target_mount")" == private ]]

printf 'parent\n' > "$target_parent/parent.txt"
chown 1:1 "$target_parent/parent.txt" "$target_mount/root.txt" "$target_mount/nested/nested.txt"
find "$target_parent" -xdev -exec chown -h 0:0 -- {} +
[[ "$(stat -c %u "$target_parent/parent.txt")" -eq 0 ]]
[[ "$(stat -c %u "$target_mount/root.txt")" -eq 1 ]]
[[ "$(stat -c %u "$target_mount/nested/nested.txt")" -eq 1 ]]

mkdir -p "$source_mount"
"$relocator" "$target_mount" "$source_mount"
findmnt -rn --mountpoint "$source_mount" >/dev/null
findmnt -rn --mountpoint "$source_mount/nested" >/dev/null
! findmnt -rn --mountpoint "$target_mount" >/dev/null
grep -Fxq root "$source_mount/root.txt"
grep -Fxq nested "$source_mount/nested/nested.txt"

echo "zos-relocate-mount.test: passed"
