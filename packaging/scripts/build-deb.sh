#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/.cyberos/deb-build"
CYBEROS_NPM_REGISTRY=${CYBEROS_NPM_REGISTRY:-https://registry.npmmirror.com}
export CYBEROS_NPM_REGISTRY

if [ -n "${CYBEROS_CARGO_REGISTRY:-}" ]; then
  printf '%s\n' "$CYBEROS_CARGO_REGISTRY" \
    | grep -Eq '^sparse\+https://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+/$' \
    || {
      printf 'build-deb: CYBEROS_CARGO_REGISTRY must be a safe sparse HTTPS registry URL ending in /\n' >&2
      exit 1
    }
fi

git_value() {
  git -C "$ROOT_DIR" "$@" 2>/dev/null || true
}

if [ -z "${CYBEROS_BUILD_COMMIT_SHA:-}" ]; then
  CYBEROS_BUILD_COMMIT_SHA=${GITHUB_SHA:-$(git_value rev-parse HEAD)}
fi
if [ -z "${CYBEROS_BUILD_TAG:-}" ]; then
  if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
    CYBEROS_BUILD_TAG=${GITHUB_REF_NAME:-}
  else
    CYBEROS_BUILD_TAG=$(git_value describe --tags --exact-match HEAD)
  fi
fi
if [ -z "${CYBEROS_BUILD_BRANCH:-}" ]; then
  if [ -n "${GITHUB_HEAD_REF:-}" ]; then
    CYBEROS_BUILD_BRANCH=$GITHUB_HEAD_REF
  elif [ "${GITHUB_REF_TYPE:-}" = "branch" ]; then
    CYBEROS_BUILD_BRANCH=${GITHUB_REF_NAME:-}
  else
    CYBEROS_BUILD_BRANCH=$(git_value branch --show-current)
  fi
fi
if [ -z "${CYBEROS_BUILD_DIRTY:-}" ] && git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git_value status --porcelain=v1 --untracked-files=normal)" ]; then
    CYBEROS_BUILD_DIRTY=true
  else
    CYBEROS_BUILD_DIRTY=false
  fi
fi
if [ -z "${CYBEROS_BUILD_SOURCE:-}" ]; then
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    if [ -n "${CYBEROS_BUILD_TAG:-}" ]; then
      CYBEROS_BUILD_SOURCE=release
    else
      CYBEROS_BUILD_SOURCE=ci
    fi
  elif [ -n "${CYBEROS_BUILD_COMMIT_SHA:-}" ]; then
    CYBEROS_BUILD_SOURCE=local
  else
    CYBEROS_BUILD_SOURCE=unknown
  fi
fi
export CYBEROS_BUILD_COMMIT_SHA CYBEROS_BUILD_TAG CYBEROS_BUILD_BRANCH CYBEROS_BUILD_SOURCE
if [ -n "${CYBEROS_BUILD_DIRTY:-}" ]; then
  export CYBEROS_BUILD_DIRTY
fi

rm -rf "$BUILD_DIR"
install -d "$BUILD_DIR"
rsync -a --exclude node_modules --exclude target --exclude .git --exclude .cyberos "$ROOT_DIR/" "$BUILD_DIR/"
cd "$BUILD_DIR"

if [ -n "${CYBEROS_CARGO_REGISTRY:-}" ]; then
  install -d .cargo
  {
    printf '%s\n' '[source.crates-io]'
    printf '%s\n\n' 'replace-with = "cyberos-mirror"'
    printf '%s\n' '[source.cyberos-mirror]'
    printf 'registry = "%s"\n' "$CYBEROS_CARGO_REGISTRY"
  } > .cargo/config.toml
fi

cp -R packaging/debian debian
dpkg-buildpackage -us -uc -b

printf "Debian package artifacts written under %s\n" "$(dirname "$BUILD_DIR")"
