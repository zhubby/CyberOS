---
title: Debian 与 appliance 部署
description: 原生 Debian 包、systemd 服务、Nginx 和 appliance 构建。
type: operation
status: current
audience: [operator]
sourceOfTruth: [packaging/debian/rules, packaging/debian/install, packaging/scripts/zos-deploy, packaging/systemd/zos-api.service, packaging/systemd/zos-host-accessd.service, packaging/systemd/zos-monitor.service, packaging/systemd/zos-alerter.service, packaging/appliance/manifest.toml]
sidebar:
  order: 1
---

生产部署使用 Debian package、Node.js 22 和 Rust 1.95，不把 ZOS 自身放入 Docker。API、monitor、alerter、worker、downloader、indexer、hostd、termux 是常驻服务；启用 Docker 时还会启动非 root `zos-host-accessd`。maintenance、health、backup 由 oneshot service 和 timer 驱动。

NixOS 使用同一组原生进程，但由 flake module 声明 package、用户、目录、systemd、timer 和 Nginx。NixOS 的安装与升级流程、模块选项以及声明式宿主机边界见 [NixOS 部署](/docs/operations/nixos/)；本页其余步骤针对 Debian package 与 appliance。

`zos-host-accessd` 的 Docker collector 兼容标记默认关闭。部署 helper 会保留并诊断这个可选服务，但不会把未验证代理标为可用。目标机完成真实 Netdata/node-exporter 兼容测试后，才可通过 systemd drop-in 设置 `ZOS_HOST_ACCESS_DOCKER_COMPATIBLE=1`；步骤、验收项和回退边界见 [Docker 宿主观测授权](/docs/reference/docker-host-access/)。

Nginx 只反向代理到 loopback API。程序文件位于 `/usr/lib/zos`，持久数据统一位于 `/zos`，运行时 socket 位于 `/run/zos`。API 静态提供 React Web 与 `/docs/` 文档站。

## 安装前检查

安装脚本支持 Debian 系的 `amd64` 和 `arm64`，必须由 root 执行。ZOS 终端固定使用由包管理的 `zos` 身份，不依赖宿主机登录用户。生产 NAS 池必须直接挂载到 `/zos/data/<pool-id>`；默认池为 `/zos/data/primary`，默认不启用 Docker、VM 和 restic backup。

确认：

```bash
dpkg --print-architecture
findmnt /zos/data/primary
```

安装脚本会调整已知 Debian、Raspberry Pi 和 NodeSource 源，并把原文件备份到 `/zos/system-backups/apt`。在受管控主机上运行前，应先审阅 `ZOS_APT_*` 和 `ZOS_*_MIRROR` 参数。

## 从源码构建 Debian 包

在目标架构主机上执行构建，让 Rust hostd/termux 和 `better-sqlite3` 等原生产物与运行环境一致。Rust 版本由 `rust-toolchain.toml` 固定为 1.95.0：

```bash
npm ci
npm --prefix docs ci
npm run build
./packaging/scripts/build-deb.sh
```

构建产物位于 `.zos/`。Debian rules 会重新安装 root 与 docs 依赖并执行完整构建，因此不要把 `node_modules` 或 `dist` 手工复制进包。

## 安装与首次启动

最小安装示例：

```bash
sudo ./packaging/scripts/install.sh
```

常用开关：

```bash
sudo ZOS_ENABLE_NGINX=1 \
  ZOS_ENABLE_DOCKER=0 \
  ZOS_ENABLE_VM=0 \
  ZOS_ENABLE_VOD_PLAYER=0 \
  ZOS_NAS_ROOT_PATH=/zos/data/primary \
  ./packaging/scripts/install.sh
```

脚本会安装 Node.js 22 和 Rust 1.95.0、构建并安装本架构 `.deb`，然后仅在新安装时执行 `zos-first-boot.sh`。首次初始化会创建 `/zos/config/config.toml`、`/zos/state`、`/zos/home/termux`、`/zos/state/vod-player`、`/zos/data/primary`、`/zos/iso` 和本地管理员记录。它不会探测或迁移 ZOS 之前的目录、配置、数据库或服务。

核心服务会被 `enable --now`：

```bash
sudo systemctl status zos-api.service zos-monitor.service zos-alerter.service zos-worker@1.service zos-downloader.service zos-indexer.service
sudo systemctl status zos-hostd.service zos-termux.service
```

Indexer 会立即作为常驻服务启动；maintenance、health 和 backup timers 默认只启用。需要立即刷新索引时使用 API，health 仍可从运维设置页或 systemd 手动启动：

```bash
curl -X POST http://127.0.0.1:3010/api/indexer/reindex \
  -H 'content-type: application/json' -d '{"rootId":"local","recursive":true}'
sudo systemctl start zos-health.service
```

## Nginx 与验收

启用 Nginx 后，`zos-nginx.sh` 会生成 `/etc/nginx/sites-available/zos.conf`，删除默认站点并代理到 `127.0.0.1:3010`。默认端口为 80，可通过 `ZOS_NGINX_PORT` 修改。

```bash
curl -fsS http://127.0.0.1:3010/health
curl -I http://<host>/
curl -I http://<host>/docs/
curl -fsS http://127.0.0.1:3010/api/roots/readiness
curl -fsS http://127.0.0.1:3010/api/system/health
curl -fsS http://127.0.0.1:3010/api/monitoring/overview
```

验收至少包含：Web 首页、`/docs/`、root readiness、文件浏览、终端身份、一次索引、一次 health run，以及监控在启动 30 秒内从 `starting` 进入 `ready` 或明确的 `degraded`。`/health` 返回成功只表示 API liveness，不表示 NAS、监控、索引或 backup 已就绪。

## 安装与重装

ZOS 1.0 不提供旧产品配置、数据库、服务或浏览器状态的原地迁移。旧设备必须先备份 NAS 数据，然后全新安装或重新制作镜像；不要把旧配置或 SQLite 文件复制到 `/zos`。重装 ZOS 时，先停止会访问 SQLite 或 NAS 的服务与 timers，并保留需要恢复的用户数据：

```bash
sudo systemctl stop zos-maintenance.timer zos-health.timer \
  zos-backup-daily.timer zos-backup-weekly.timer
sudo systemctl stop zos-downloader.service zos-worker@1.service \
  zos-indexer.service zos-alerter.service zos-monitor.service zos-vod-player.service zos-api.service zos-termux.service \
  zos-hostd.service
sudo dpkg -i .zos/zos_<version>_<arch>.deb
sudo systemctl daemon-reload
findmnt /zos/data/pool1
```

安装新包不等于修复已有池权限。重启下载器及开放文件写入前，逐池执行：

```bash
sudo /usr/lib/zos/scripts/zos-nas-acl.sh --check --pool /zos/data/pool1
sudo /usr/lib/zos/scripts/zos-nas-acl.sh --apply --pool /zos/data/pool1
```

对其他已挂载池分别执行；自定义 NAS root 还需传入 `--root <configured-root>`。工具只处理已挂载、没有嵌套挂载的池，保留现有所有者并为 `zos` 增加访问和默认 ACL；属于 `zos` 的私有文件无需新增 ACL，仍保持原有 mask。只读快照、ACL 不支持或路径失败会明确报错。预览会检查已有 ACL mask；若新增授权可能放宽其他身份的有效权限，会拒绝整池迁移，须先逐路径审查，不能强行放宽 mask。每次成功进入 `--apply` 阶段都会将原 ACL 保存于输出所示的 `/zos/system-backups/permissions/acl.*/acl.dump`，应先查明原因，再在停止写入的状态下以 `setfacl --restore=<exact-backup-path>` 回滚；不要对旧池运行递归 `chown`。

共享服务只在启用的共享路径获得 ACL。hostd 应用共享设置时备份受影响路径的 ACL，服务重载失败会恢复；可写 NFS 客户端被映射为 `zos-nfs`，不继承客户端 UID。

完成挂载和 ACL 验证后启动服务：

```bash
sudo systemctl start zos-hostd.service zos-termux.service \
  zos-api.service zos-monitor.service zos-alerter.service zos-worker@1.service zos-downloader.service zos-indexer.service \
  zos-vod-player.service
sudo systemctl --failed
sudo journalctl -u zos-hostd.service -u zos-termux.service -n 100 --no-pager
```

确认新安装通过验收后再重新启用 timers。ZOS 主数据库迁移没有通用反向迁移；后续 ZOS 版本如改变 schema，回滚时必须同时恢复与旧包匹配的主库/state 备份。旧版本不认识 `metrics.sqlite` 时应忽略并保留它；指标库可重建，不参与主库反向迁移。

## GitHub Actions 与 Tailscale 自动升级

公开仓库使用 GitHub-hosted runner 构建并发布双架构 Debian 包，再由独立 workflow 通过 Tailscale OIDC 临时节点连接 CM5。CM5 不运行 self-hosted runner，不需要公网 IP、端口转发、SSH 私钥或保存在 GitHub 中的主机密码。

完整的一次性配置、tag 发布步骤、manifest 校验链、幂等重试和故障处理见[GitHub Actions 发布与 CM5 自动部署](/docs/operations/github-actions-release/)。自动部署只接受稳定的 `vX.Y.Z` tag；不要使用 `latest`、移动已发布 tag 或绕过部署程序的 checksum、版本与数据库回滚边界。

构建前先运行 `npm run version:check`。构建过程会在源码复制到 Debian staging 之前冻结 commit、tag/branch、构建时间、来源和 dirty 状态，并将 `/usr/lib/zos/build-info.json` 随包安装。运行中的 API 通过 `/api/system/build-info` 暴露可公开的追溯字段，Web 设置的“版本”分类展示同一份信息。

发布 tag 必须严格匹配根 `package.json`、所有 workspace、Debian changelog 和 appliance manifest 中的统一 SemVer。使用 `npm run release -- patch|minor|major --note "..."` 只准备版本差异；commit、tag、push 和发布仍由维护者单独执行。
