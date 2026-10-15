#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: zos-nas-acl --check|--apply --pool /path/to/mounted/pool [--root /path/to/nas/root]\n' >&2
  exit 2
}

mode= pool= root=/zos/data/primary
while (($#)); do
  case "$1" in
    --check|--apply) [[ -z "$mode" ]] || usage; mode=$1; shift ;;
    --pool|--root)
      (($# >= 2)) || usage
      if [[ "$1" == --pool ]]; then pool=$2; else root=$2; fi
      shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$mode" && -n "$pool" ]] || usage
[[ $(id -u) == 0 ]] || { printf 'run as root\n' >&2; exit 1; }
for command in findmnt find getfacl setfacl realpath stat; do
  command -v "$command" >/dev/null || { printf 'missing tool: %s\n' "$command" >&2; exit 1; }
done

zos_root=${ZOS_ROOT:-/zos}
case "$zos_root" in /*) ;; *) printf 'ZOS_ROOT must be absolute\n' >&2; exit 1 ;; esac
zos_root=$(realpath -m -- "$zos_root")
[ "$zos_root" != / ] || { printf 'ZOS_ROOT must not be the filesystem root\n' >&2; exit 1; }
backup_root=$(realpath -m -- "${ZOS_ACL_BACKUP_DIR:-$zos_root/system-backups/permissions}")
case "$backup_root" in
  "$zos_root/system-backups"|"$zos_root/system-backups"/*) ;;
  *) printf 'ZOS_ACL_BACKUP_DIR must be under %s/system-backups\n' "$zos_root" >&2; exit 1 ;;
esac

root=$(realpath -e -- "$root")
pool=$(realpath -e -- "$pool")
[[ "$pool" == "$root/"* ]] || { printf 'pool must be below NAS root\n' >&2; exit 1; }
[[ $(findmnt -rn --mountpoint "$pool" -o TARGET) == "$pool" ]] || {
  printf 'pool is not mounted: %s\n' "$pool" >&2; exit 1;
}
[[ $(findmnt -rn -R "$pool" -o TARGET | wc -l | tr -d '[:space:]') == 1 ]] || {
  printf 'nested mounts require a separate review: %s\n' "$pool" >&2; exit 1;
}
[[ ,$(findmnt -rn --mountpoint "$pool" -o OPTIONS), != *,ro,* ]] || {
  printf 'pool is read-only: %s\n' "$pool" >&2; exit 1;
}
printf 'pool: %s\nfiles and directories: ' "$pool"
find -P "$pool" -xdev \( -type f -o -type d \) -printf '.' | wc -c
printf 'pool ACL and owner before migration:\n'
getfacl --absolute-names -e -- "$pool"
printf 'planned change: grant zos rwx on directories (including default ACL), rw on files; preserve owners and existing effective ACL permissions\n'
items=$(mktemp)
trap 'rm -f "$items"' EXIT
find -P "$pool" -xdev \( -type f -o -type d \) -print0 > "$items"

mask_for_scope() {
  local acl=$1 scope=$2
  awk -v scope="$scope" '
    scope == "access" && /^mask::/ { print substr($1, 7); exit }
    scope == "default" && /^default:mask::/ { print substr($1, 15); exit }
  ' <<< "$acl"
}

permissions_include() {
  local permissions=$1 required=$2 permission
  for permission in r w x; do
    [[ "$required" != *"$permission"* || "$permissions" == *"$permission"* ]] || return 1
  done
}

merge_permissions() {
  local existing=$1 required=$2 permission merged=
  for permission in r w x; do
    if [[ "$existing" == *"$permission"* || "$required" == *"$permission"* ]]; then
      merged+=$permission
    else
      merged+=-
    fi
  done
  printf '%s\n' "$merged"
}

frozen_entries_spec() {
  local acl=$1 scope=$2 mask=$3
  awk -v scope="$scope" -v mask="$mask" '
    function effective(raw,  position, result) {
      result = ""
      for (position = 1; position <= 3; position++) {
        if (substr(raw, position, 1) != "-" && substr(mask, position, 1) != "-") {
          result = result substr(raw, position, 1)
        } else {
          result = result "-"
        }
      }
      return result
    }
    function append(value) {
      if (spec != "") spec = spec ","
      spec = spec value
    }
    {
      count = split($1, entry, ":")
      if (scope == "access") {
        if (count == 3 && entry[1] == "user" && entry[2] != "" && entry[2] != "zos") {
          append("u:" entry[2] ":" effective(entry[3]))
        } else if (count == 3 && entry[1] == "group") {
          append("g:" entry[2] ":" effective(entry[3]))
        }
      } else if (count == 4 && entry[1] == "default") {
        if (entry[2] == "user" && entry[3] != "" && entry[3] != "zos") {
          append("d:u:" entry[3] ":" effective(entry[4]))
        } else if (entry[2] == "group") {
          append("d:g:" entry[3] ":" effective(entry[4]))
        }
      }
    }
    END { printf "%s", spec }
  ' <<< "$acl"
}

acl_update_spec() {
  local acl=$1 scope=$2 required=$3 mask target mask_target frozen widened
  mask=$(mask_for_scope "$acl" "$scope")
  if [[ "$scope" == access ]]; then
    target="u:zos:$required"
  else
    target="d:u:zos:$required"
  fi
  if [[ -z "$mask" ]] || permissions_include "$mask" "$required"; then
    printf '%s\n' "$target"
    return
  fi

  widened=$(merge_permissions "$mask" "$required")
  frozen=$(frozen_entries_spec "$acl" "$scope" "$mask")
  if [[ "$scope" == access ]]; then mask_target="m::$widened"; else mask_target="d:m::$widened"; fi
  printf '%s%s%s,%s\n' "$frozen" "${frozen:+,}" "$target" "$mask_target"
}

plan_acl_update() {
  local item=$1 acl=$2 scope=$3 required=$4 mask widened
  mask=$(mask_for_scope "$acl" "$scope")
  if [[ -n "$mask" ]] && ! permissions_include "$mask" "$required"; then
    widened=$(merge_permissions "$mask" "$required")
    acl_update_spec "$acl" "$scope" "$required" >/dev/null
    printf 'planned %s ACL mask widening: %s -> %s; preserve existing effective permissions: %s\n' \
      "$scope" "$mask" "$widened" "$item"
  fi
}

apply_acl_update() {
  local item=$1 acl=$2 scope=$3 required=$4 mask spec
  mask=$(mask_for_scope "$acl" "$scope")
  spec=$(acl_update_spec "$acl" "$scope" "$required")
  if [[ -n "$mask" ]]; then
    setfacl -n -m "$spec" -- "$item"
  else
    setfacl -m "$spec" -- "$item"
  fi
}

# Widening a mask directly can grant unrelated principals rights that were previously
# ineffective. Freeze those entries to their current effective permissions first.
zos_uid=$(id -u zos)
while IFS= read -r -d '' item; do
  acl=$(getfacl --absolute-names -c -- "$item")
  if [[ $(stat -c %u -- "$item") == "$zos_uid" ]]; then owned=1; else owned=0; fi
  if [[ -d "$item" ]]; then
    if (( ! owned )); then plan_acl_update "$item" "$acl" access rwx; fi
    plan_acl_update "$item" "$acl" default rwx
  elif (( ! owned )); then
    plan_acl_update "$item" "$acl" access rw-
  fi
done < "$items"
[[ "$mode" == --apply ]] || exit 0

install -d -m 0700 -- "$backup_root"
backup=$(mktemp -d "$backup_root/acl.XXXXXXXX")
chmod 0700 "$backup"
find -P "$pool" -xdev \( -type f -o -type d \) -exec getfacl --absolute-names -- {} + > "$backup/acl.dump"
chmod 0600 "$backup/acl.dump"
mv -- "$items" "$backup/items"
chmod 0600 "$backup/items"
printf '%s\n' "$pool" > "$backup/pool"
printf 'original ACL saved: %s/acl.dump\n' "$backup"

errors=0
while IFS= read -r -d '' item; do
  acl=$(getfacl --absolute-names -c -- "$item")
  if [[ $(stat -c %u -- "$item") == "$zos_uid" ]]; then owned=1; else owned=0; fi
  if [[ -d "$item" ]]; then
    if (( ! owned )); then
      apply_acl_update "$item" "$acl" access rwx || errors=$((errors + 1))
    fi
    apply_acl_update "$item" "$acl" default rwx || errors=$((errors + 1))
  elif (( ! owned )); then
    apply_acl_update "$item" "$acl" access rw- || errors=$((errors + 1))
  fi
  if (( owned )); then
    if [[ -d "$item" ]]; then chmod u+rwx -- "$item"; else chmod u+rw -- "$item"; fi
  fi
  if (( ! owned )) && ! getfacl --absolute-names -c -e -- "$item" | awk -v required="$(if [[ -d "$item" ]]; then printf rwx; else printf rw; fi)" '
    /^user:zos:/ {
      permissions = $1
      sub(/^user:zos:/, "", permissions)
      if (index($0, "#effective:") != 0) {
        permissions = $0
        sub(/^.*#effective:/, "", permissions)
        sub(/[[:space:]].*$/, "", permissions)
      }
      for (i = 1; i <= length(required); i++) if (index(permissions, substr(required, i, 1)) == 0) exit 1
      found = 1
    }
    END { if (!found) exit 1 }
  '; then
    printf 'zos ACL is ineffective: %s\n' "$item" >&2
    errors=$((errors + 1))
  fi
done < "$backup/items"
if ((errors)); then
  printf '%s ACL updates failed; review the pool and restore with setfacl --restore=%s/acl.dump if necessary\n' "$errors" "$backup" >&2
  exit 1
fi
printf 'ACL migration complete; original ACL: %s/acl.dump\n' "$backup"
