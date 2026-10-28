---
title: Appliance 镜像构建
description: 构建 arm64 systemd rootfs，并将 CyberOS Debian 包交给板级镜像工具。
type: operation
status: current
audience: [operator, developer]
sourceOfTruth: [packaging/appliance/build-image.sh, packaging/appliance/manifest.toml, packaging/appliance/README.md, packaging/debian/rules]
sidebar:
  order: 3
---

Appliance builder 生成的是 systemd rootfs tarball，不是 CM5 可直接刷写的 SD 卡或 eMMC 镜像。板级工具需要自行完成分区、bootloader、网络和首次启动配置。

## 构建机要求

构建机需要 `mmdebstrap`、`systemd-nspawn`、`tar`、`curl` 和 `sha256sum`，并能创建目标架构 rootfs。默认目标为 Debian bookworm `arm64`，默认产物目录为 `.cyberos/appliance`。

先在与目标架构一致的环境构建 Debian 包：

```bash
./packaging/scripts/build-deb.sh
```

如果构建机不是目标架构，至少要把已经在目标架构构建并验证过的 `.deb` 作为 `CYBEROS_DEB` 传入；不要让 appliance builder 猜测错误版本。`build-image.sh` 的默认文件名仍是示例版本，显式传入路径更可靠。

## 生成 rootfs

```bash
CYBEROS_DEB="$PWD/.cyberos/cyberos_<version>_arm64.deb" \
CYBEROS_IMAGE_OUT="$PWD/.cyberos/appliance" \
CYBEROS_BASE_SUITE=bookworm \
CYBEROS_TARGET_ARCH=arm64 \
./packaging/appliance/build-image.sh
```

需要内部镜像时设置 `CYBEROS_APT_MIRROR`、`CYBEROS_NODE_MIRROR` 和 `CYBEROS_NODE_VERSION`。脚本会：

1. 用 `mmdebstrap` 创建最小 Debian rootfs；
2. 下载并校验 Node.js tarball；
3. 安装 CyberOS `.deb`；
4. 写入 Nginx 配置并启用 API、worker、hostd、Termux、VOD Player 和 timers；
5. 输出 `.cyberos/appliance/cyberos-rootfs-arm64.tar`。

检查产物：

```bash
tar -tf .cyberos/appliance/cyberos-rootfs-arm64.tar | \
  grep -E 'usr/lib/cyberos/(apps|docs)|lib/systemd/system/cyberos-api.service'
```

## 首次启动边界

镜像包含 Docker、libvirt/QEMU、restic、Nginx 和 NAS helper 包，但 `cyberos-first-boot.sh` 默认将 Docker、VM 和 backup 设为关闭。首次启动时应配置 `/cyberos/config/config.toml`、终端用户、NAS root 和挂载策略，再按需启用可选能力。

不要把 rootfs tarball 当作已经完成的生产部署。刷写后仍需：

- 配置板级网络、时钟和存储挂载；
- 确认 `/cyberos/data/primary` 与 `/cyberos/data/backup` 的 mount readiness；
- 设置 restic password file 并显式初始化 repository；
- 验证 Nginx、API、Web、`/docs/`、indexer 和 health；
- 保存首次启动前后的配置与 state 备份。
