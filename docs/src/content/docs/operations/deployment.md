---
title: Debian 与 appliance 部署
description: 原生 Debian 包、systemd 服务、Nginx 和 appliance 构建。
type: operation
status: current
audience: [operator]
sourceOfTruth: [packaging/debian/rules, packaging/debian/install, packaging/scripts/sigmaos-deploy, packaging/systemd/sigmaos-api.service, packaging/appliance/manifest.toml]
sidebar:
  order: 1
---

生产部署使用 Debian package、Node.js 22 和 Rust 1.95，不把 SigmaOS 自身放入 Docker。API、worker、downloader、indexer、hostd、termux 是常驻服务；maintenance、health、backup 由 oneshot service 和 timer 驱动。

Nginx 只反向代理到 loopback API。运行时路径主要是 `/usr/lib/sigmaos`、`/etc/sigmaos`、`/var/lib/sigmaos`、`/run/sigmaos` 和配置的 `/srv` roots。API 静态提供 React Web 与 `/docs/` 文档站。

## 安装前检查

安装脚本支持 Debian 系的 `amd64` 和 `arm64`，必须由 root 执行。SigmaOS 终端固定使用由包管理的 `sigmaos` 身份，不依赖宿主机登录用户。生产 NAS 应先挂载到 `/srv` 下的路径；脚本默认使用 `/srv/nas`，默认不启用 Docker、VM 和 restic backup。

确认：

```bash
dpkg --print-architecture
findmnt /srv/nas
```

安装脚本会调整已知 Debian、Raspberry Pi 和 NodeSource 源，并把原文件备份到 `/var/backups/sigmaos-apt`。在受管控主机上运行前，应先审阅 `SIGMAOS_APT_*` 和 `SIGMAOS_*_MIRROR` 参数。

## 从源码构建 Debian 包

在目标架构主机上执行构建，让 Rust hostd/termux 和 `better-sqlite3` 等原生产物与运行环境一致。Rust 版本由 `rust-toolchain.toml` 固定为 1.95.0：

```bash
npm ci
npm --prefix docs ci
npm run build
./packaging/scripts/build-deb.sh
```

构建产物位于 `.sigmaos/`。Debian rules 会重新安装 root 与 docs 依赖并执行完整构建，因此不要把 `node_modules` 或 `dist` 手工复制进包。

## 安装与首次启动

最小安装示例：

```bash
sudo ./packaging/scripts/install.sh
```

常用开关：

```bash
sudo SIGMAOS_ENABLE_NGINX=1 \
  SIGMAOS_ENABLE_DOCKER=0 \
  SIGMAOS_ENABLE_VM=0 \
  SIGMAOS_ENABLE_VOD_PLAYER=0 \
  SIGMAOS_NAS_ROOT_PATH=/srv/nas \
  ./packaging/scripts/install.sh
```

脚本会安装 Node.js 22 和 Rust 1.95.0、构建并安装本架构 `.deb`，然后仅在新安装时执行 `sigmaos-first-boot.sh`。首次初始化会创建 `/etc/sigmaos/config.toml`、`/var/lib/sigmaos`、`/var/lib/sigmaos-termux`、`/var/lib/sigmaos-vod-player`、`/srv/nas`、`/srv/iso` 和本地管理员记录。升级会迁移 Termux 和 VOD Player 配置，并分别保留 `config.toml.pre-termux.bak` 与 `config.toml.pre-vod-player.bak`。若仅存在旧终端家目录，`/var/lib/sigmaos-terminal` 会原子迁移为 `/var/lib/sigmaos-termux`；新旧目录同时存在时安装会拒绝合并，要求运维人员先核对数据。

核心服务会被 `enable --now`：

```bash
sudo systemctl status sigmaos-api.service sigmaos-worker@1.service sigmaos-downloader.service sigmaos-indexer.service
sudo systemctl status sigmaos-hostd.service sigmaos-termux.service
```

Indexer 会立即作为常驻服务启动；maintenance、health 和 backup timers 默认只启用。需要立即刷新索引时使用 API，health 仍可从运维设置页或 systemd 手动启动：

```bash
curl -X POST http://127.0.0.1:3010/api/indexer/reindex \
  -H 'content-type: application/json' -d '{"rootId":"local","recursive":true}'
sudo systemctl start sigmaos-health.service
```

## Nginx 与验收

启用 Nginx 后，`sigmaos-nginx.sh` 会生成 `/etc/nginx/sites-available/sigmaos.conf`，删除默认站点并代理到 `127.0.0.1:3010`。默认端口为 80，可通过 `SIGMAOS_NGINX_PORT` 修改。

```bash
curl -fsS http://127.0.0.1:3010/health
curl -I http://<host>/
curl -I http://<host>/docs/
curl -fsS http://127.0.0.1:3010/api/roots/readiness
curl -fsS http://127.0.0.1:3010/api/system/health
```

验收至少包含：Web 首页、`/docs/`、root readiness、文件浏览、终端身份、一次索引和一次 health run。`/health` 返回成功只表示 API liveness，不表示 NAS 已挂载或备份可用。

## 升级与回滚

升级前保留当前 `.deb`、`/etc/sigmaos/config.toml`、`/var/lib/sigmaos` 和数据库备份；先暂停会访问 SQLite 或 NAS 的服务与 timers。完成包安装后，先确认挂载、运行 ACL 预览和迁移，最后再启动服务：

```bash
sudo systemctl stop sigmaos-maintenance.timer sigmaos-health.timer \
  sigmaos-backup-daily.timer sigmaos-backup-weekly.timer
sudo systemctl stop sigmaos-downloader.service sigmaos-worker@1.service \
  sigmaos-indexer.service sigmaos-vod-player.service sigmaos-api.service sigmaos-termux.service \
  sigmaos-hostd.service
sudo dpkg -i .sigmaos/sigmaos_<version>_<arch>.deb
sudo systemctl daemon-reload
findmnt /srv/nas/pool1
```

安装新包不等于修复旧池权限。升级后、重启下载器及开放文件写入前，逐池执行：

```bash
sudo /usr/lib/sigmaos/scripts/sigmaos-nas-acl.sh --check --pool /srv/nas/pool1
sudo /usr/lib/sigmaos/scripts/sigmaos-nas-acl.sh --apply --pool /srv/nas/pool1
```

对其他已挂载池分别执行；自定义 NAS root 还需传入 `--root <configured-root>`。工具只处理已挂载、没有嵌套挂载的池，保留现有所有者并为 `sigmaos` 增加访问和默认 ACL；属于 `sigmaos` 的私有文件无需新增 ACL，仍保持原有 mask。只读快照、ACL 不支持或路径失败会明确报错。预览会检查已有 ACL mask；若新增授权可能放宽其他身份的有效权限，会拒绝整池迁移，须先逐路径审查，不能强行放宽 mask。每次成功进入 `--apply` 阶段都会将原 ACL 保存于输出所示的 `/var/backups/sigmaos-permissions/acl.*/acl.dump`，应先查明原因，再在停止写入的状态下以 `setfacl --restore=<exact-backup-path>` 回滚；不要对旧池运行递归 `chown`。

共享服务只在启用的共享路径获得 ACL。hostd 应用共享设置时备份受影响路径的 ACL，服务重载失败会恢复；可写 NFS 客户端被映射为 `sigmaos-nfs`，不继承客户端 UID。

从旧版升级时，`postinst` 会先确认新旧终端家目录不存在冲突，再停止旧 helper。随后运行 hostd、termux 和 VOD Player 的幂等配置迁移，并停用 `sigmaos-share-helper.service` 与 `sigmaos-player-helper.service`。VOD Player 迁移把 `[player]` 改为 `[vod_player]`、把 `helper_socket_path` 改为 `socket_path`，并写入可靠性默认值；若新旧播放器配置同时存在且不等价，安装会拒绝覆盖。`.pre-hostd.bak`、`.pre-termux.bak` 和 `.pre-vod-player.bak` 只在首次修改时创建且不会重复覆盖。完成 ACL 验证后启动服务：

```bash
sudo systemctl start sigmaos-hostd.service sigmaos-termux.service \
  sigmaos-api.service sigmaos-worker@1.service sigmaos-downloader.service sigmaos-indexer.service \
  sigmaos-vod-player.service
sudo systemctl --failed
sudo journalctl -u sigmaos-hostd.service -u sigmaos-termux.service -n 100 --no-pager
```

确认新版本通过验收后再重新启用 timers。回滚到 `0.7.x` 还需停止 termux，将 `/var/lib/sigmaos-termux` 恢复为旧包使用的 `/var/lib/sigmaos-terminal`，并恢复 `config.toml.pre-termux.bak`；不要在两个目录都存在时合并。迁移脚本没有通用的数据库反向迁移；若新版本已改变 schema，应使用升级前的 SQLite 备份和对应版本包一起恢复。

## GitHub Actions 与 Tailscale 自动升级

公开仓库使用 GitHub-hosted runner 构建并发布双架构 Debian 包，再由独立 workflow 通过 Tailscale OIDC 临时节点连接 CM5。CM5 不运行 self-hosted runner，不需要公网 IP、端口转发、SSH 私钥或保存在 GitHub 中的主机密码。

完整的一次性配置、tag 发布步骤、manifest 校验链、幂等重试和故障处理见[GitHub Actions 发布与 CM5 自动部署](/docs/operations/github-actions-release/)。自动部署只接受稳定的 `vX.Y.Z` tag；不要使用 `latest`、移动已发布 tag 或绕过部署程序的 checksum、版本与数据库回滚边界。

构建前先运行 `npm run version:check`。构建过程会在源码复制到 Debian staging 之前冻结 commit、tag/branch、构建时间、来源和 dirty 状态，并将 `/usr/lib/sigmaos/build-info.json` 随包安装。运行中的 API 通过 `/api/system/build-info` 暴露可公开的追溯字段，Web 设置的“版本”分类展示同一份信息。

发布 tag 必须严格匹配根 `package.json`、所有 workspace、Debian changelog 和 appliance manifest 中的统一 SemVer。使用 `npm run release -- patch|minor|major --note "..."` 只准备版本差异；commit、tag、push 和发布仍由维护者单独执行。
