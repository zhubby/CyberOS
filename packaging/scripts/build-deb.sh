#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/.zos/deb-build"
ZOS_NPM_REGISTRY=${ZOS_NPM_REGISTRY:-https://registry.npmmirror.com}
export ZOS_NPM_REGISTRY

git_value() {
  git -C "$ROOT_DIR" "$@" 2>/dev/null || true
}

if [ -z "${ZOS_BUILD_COMMIT_SHA:-}" ]; then
  ZOS_BUILD_COMMIT_SHA=${GITHUB_SHA:-$(git_value rev-parse HEAD)}
fi
if [ -z "${ZOS_BUILD_TAG:-}" ]; then
  if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
    ZOS_BUILD_TAG=${GITHUB_REF_NAME:-}
  else
    ZOS_BUILD_TAG=$(git_value describe --tags --exact-match HEAD)
  fi
fi
if [ -z "${ZOS_BUILD_BRANCH:-}" ]; then
  if [ -n "${GITHUB_HEAD_REF:-}" ]; then
    ZOS_BUILD_BRANCH=$GITHUB_HEAD_REF
  elif [ "${GITHUB_REF_TYPE:-}" = "branch" ]; then
    ZOS_BUILD_BRANCH=${GITHUB_REF_NAME:-}
  else
    ZOS_BUILD_BRANCH=$(git_value branch --show-current)
  fi
fi
if [ -z "${ZOS_BUILD_DIRTY:-}" ] && git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git_value status --porcelain=v1 --untracked-files=normal)" ]; then
    ZOS_BUILD_DIRTY=true
  else
    ZOS_BUILD_DIRTY=false
  fi
fi
if [ -z "${ZOS_BUILD_SOURCE:-}" ]; then
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    if [ -n "${ZOS_BUILD_TAG:-}" ]; then
      ZOS_BUILD_SOURCE=release
    else
      ZOS_BUILD_SOURCE=ci
    fi
  elif [ -n "${ZOS_BUILD_COMMIT_SHA:-}" ]; then
    ZOS_BUILD_SOURCE=local
  else
    ZOS_BUILD_SOURCE=unknown
  fi
fi
export ZOS_BUILD_COMMIT_SHA ZOS_BUILD_TAG ZOS_BUILD_BRANCH ZOS_BUILD_SOURCE
if [ -n "${ZOS_BUILD_DIRTY:-}" ]; then
  export ZOS_BUILD_DIRTY
fi

rm -rf "$BUILD_DIR"
install -d "$BUILD_DIR"
rsync -a --exclude node_modules --exclude target --exclude .git --exclude .zos "$ROOT_DIR/" "$BUILD_DIR/"
cd "$BUILD_DIR"
cp -R packaging/debian debian
dpkg-buildpackage -us -uc -b

printf "Debian package artifacts written under %s\n" "$(dirname "$BUILD_DIR")"
