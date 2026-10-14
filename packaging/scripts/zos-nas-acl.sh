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
printf 'planned change: grant zos rwx on directories (including default ACL), rw on files; preserve owners\n'
items=$(mktemp)
trap 'rm -f "$items"' EXIT
find -P "$pool" -xdev \( -type f -o -type d \) -print0 > "$items"

check_masks() {
  local item=$1 kind=$2 owned=$3
  getfacl --absolute-names -c -- "$item" | awk -v item="$item" -v kind="$kind" -v owned="$owned" '
    /^mask::/ { access_mask = substr($1, 7) }
    /^default:mask::/ { default_mask = substr($1, 15) }
    /^group::|^group:[^:]+:|^user:[^:]+:/ {
      if ($1 !~ /^user:zos:/) access_entries = access_entries " " substr($1, length($1) - 2)
    }
    /^default:group::|^default:group:[^:]+:|^default:user:[^:]+:/ {
      if ($1 !~ /^default:user:zos:/) default_entries = default_entries " " substr($1, length($1) - 2)
    }
    END {
      if (owned != 1 && access_mask != "" && !safe(access_mask, kind == "directory" ? "rwx" : "rw", access_entries)) {
        printf "existing access ACL mask needs separate review: %s\n", item > "/dev/stderr"
        exit 1
      }
      if (kind == "directory" && default_mask != "" && !safe(default_mask, "rwx", default_entries)) {
        printf "existing default ACL mask needs separate review: %s\n", item > "/dev/stderr"
        exit 1
      }
    }
    function safe(mask, required, entries,  i, j, parts) {
      for (i = 1; i <= length(required); i++) if (index(mask, substr(required, i, 1)) == 0) return 0
      split(entries, parts, " ")
      for (i in parts) for (j = 1; j <= length(parts[i]); j++) {
        if (index(mask, substr(parts[i], j, 1)) == 0 && substr(parts[i], j, 1) != "-") return 0
      }
      return 1
    }
  '
}

# Recomputing an existing ACL mask can grant unrelated principals previously masked rights.
zos_uid=$(id -u zos)
preflight_errors=0
while IFS= read -r -d '' item; do
  if [[ -d "$item" ]]; then kind=directory; else kind=file; fi
  if [[ $(stat -c %u -- "$item") == "$zos_uid" ]]; then owned=1; else owned=0; fi
  check_masks "$item" "$kind" "$owned" || preflight_errors=$((preflight_errors + 1))
done < "$items"
if ((preflight_errors)); then
  printf '%s paths require ACL mask review; no ACL was changed\n' "$preflight_errors" >&2
  exit 1
fi
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
      if [[ "$acl" == *$'\nmask::'* ]]; then mask_option=-n; else mask_option=; fi
      setfacl ${mask_option:+"$mask_option"} -m u:zos:rwx -- "$item" || errors=$((errors + 1))
    fi
    if [[ "$acl" == *$'\ndefault:mask::'* ]]; then mask_option=-n; else mask_option=; fi
    setfacl ${mask_option:+"$mask_option"} -m d:u:zos:rwx -- "$item" || errors=$((errors + 1))
  elif (( ! owned )); then
    if [[ "$acl" == *$'\nmask::'* ]]; then mask_option=-n; else mask_option=; fi
    setfacl ${mask_option:+"$mask_option"} -m u:zos:rw- -- "$item" || errors=$((errors + 1))
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
