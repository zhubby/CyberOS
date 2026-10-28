# CyberOS Appliance Image Scaffold

This directory contains the v1 appliance image scaffold. It builds a minimal systemd rootfs, installs the CyberOS Debian package, and enables the runtime services and timers.

Inputs:

- `CYBEROS_DEB`: path to the built `cyberos` Debian package.
- `CYBEROS_IMAGE_OUT`: output directory, default `.cyberos/appliance`.
- `CYBEROS_BASE_SUITE`: Debian suite, default `bookworm`.
- `CYBEROS_TARGET_ARCH`: target architecture, default `arm64`.
- `CYBEROS_APT_MIRROR`: Debian mirror used by `mmdebstrap`, default `https://mirrors.aliyun.com/debian`.
- `CYBEROS_NODE_MIRROR`: Node.js release mirror, default `https://mirrors.aliyun.com/nodejs-release`.
- `CYBEROS_NODE_VERSION`: Node.js version to place in the image, default `22.23.2`.
- `CYBEROS_ENABLE_VOD_PLAYER`: set to `1` to enable native HDMI playback.
- `CYBEROS_ENABLE_TV_MODE`: set to `1` to boot into the CyberOS TV shell; this also enables VOD playback.

Required host tools:

- `node`
- `mmdebstrap`
- `systemd-nspawn`
- `tar`

When `CYBEROS_DEB` is omitted, the builder reads the product version from the root `package.json` and expects `.cyberos/appliance/cyberos_<version>_<arch>.deb`. The manifest records required runtime components: Node, Pi, SQLite, Nginx, Docker, libvirt/QEMU, systemd units, OCR helpers, media helpers, archive helpers, and NAS health tooling. Docker, VM management, VOD playback, and TV mode remain disabled by default. `CYBEROS_ENABLE_VOD_PLAYER=1` enables native playback only; `CYBEROS_ENABLE_TV_MODE=1` additionally enables the Weston/Chromium/CEC TV session and implies VOD playback. The image builder uses the configured domestic mirror for the base rootfs; pass `CYBEROS_APT_MIRROR` to use an internal mirror. The resulting rootfs tarball is the handoff point for board-specific image tooling.
