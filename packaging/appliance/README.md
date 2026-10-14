# ZOS Appliance Image Scaffold

This directory contains the v1 appliance image scaffold. It builds a minimal systemd rootfs, installs the ZOS Debian package, and enables the runtime services and timers.

Inputs:

- `ZOS_DEB`: path to the built `zos` Debian package.
- `ZOS_IMAGE_OUT`: output directory, default `.zos/appliance`.
- `ZOS_BASE_SUITE`: Debian suite, default `bookworm`.
- `ZOS_TARGET_ARCH`: target architecture, default `arm64`.
- `ZOS_APT_MIRROR`: Debian mirror used by `mmdebstrap`, default `https://mirrors.aliyun.com/debian`.
- `ZOS_NODE_MIRROR`: Node.js release mirror, default `https://mirrors.aliyun.com/nodejs-release`.
- `ZOS_NODE_VERSION`: Node.js version to place in the image, default `22.23.2`.

Required host tools:

- `node`
- `mmdebstrap`
- `systemd-nspawn`
- `tar`

When `ZOS_DEB` is omitted, the builder reads the product version from the root `package.json` and expects `.zos/appliance/zos_<version>_<arch>.deb`. The manifest records required runtime components: Node, Pi, SQLite, Nginx, Docker, libvirt/QEMU, systemd units, OCR helpers, media helpers, archive helpers, and NAS health tooling. Docker, VM management, and VOD playback remain disabled by default; set `ZOS_ENABLE_VOD_PLAYER=1` when building an appliance with a connected display to enable the VOD Player configuration and service. The image builder uses the configured domestic mirror for the base rootfs; pass `ZOS_APT_MIRROR` to use an internal mirror. The resulting rootfs tarball is the handoff point for board-specific image tooling.
