---
title: Debian 部署
description: 原生 Debian 包、systemd 服务、Nginx 和 CM5 部署。
type: operation
status: current
audience: [operator]
sourceOfTruth: [packaging/debian/rules, packaging/debian/install, packaging/scripts/cyberos-deploy, packaging/systemd/cyberos-api.service, packaging/systemd/cyberos-host-accessd.service, packaging/systemd/cyberos-monitor.service, packaging/systemd/cyberos-alerter.service]
sidebar:
  order: 1
---

生产部署使用 Debian package、Node.js 22 和 Rust 1.95，不把 CyberOS 自身放入 Docker。API、monitor、alerter、worker、downloader、indexer、hostd、terminal 是常驻服务；启用 Docker 时还会启动非 root `cyberos-host-accessd`。maintenance、health、backup 由 oneshot service 和 timer 驱动。

`cyberos-host-accessd` 的 Docker collector 兼容标记默认关闭。部署 helper 会保留并诊断这个可选服务，但不会把未验证代理标为可用。目标机完成真实 Netdata/node-exporter 兼容测试后，才可通过 systemd drop-in 设置 `CYBEROS_HOST_ACCESS_DOCKER_COMPATIBLE=1`；步骤、验收项和回退边界见 [Docker 宿主观测授权](/docs/reference/docker-host-access/)。

Nginx 只反向代理到 loopback API。程序文件位于 `/usr/lib/cyberos`，持久数据统一位于 `/cyberos`，运行时 socket 位于 `/run/cyberos`。API 静态提供 React Web 与 `/docs/` 文档站。

## 安装前检查

安装脚本支持 Debian 系的 `amd64` 和 `arm64`，必须由 root 执行。CyberOS 终端固定使用由包管理的 `cyberos` 身份，不依赖宿主机登录用户。生产存储池必须直接挂载到 `/cyberos/data/<pool-id>`；系统不创建默认池，且默认不启用 Docker、VM 和 restic backup。TV 模式默认启用。

确认：

```bash
dpkg --print-architecture
findmnt /cyberos/data/<pool-id>
```

安装脚本会调整已知 Debian、Raspberry Pi 和 NodeSource 源，并把原文件备份到 `/cyberos/system-backups/apt`。在受管控主机上运行前，应先审阅 `CYBEROS_APT_*` 和 `CYBEROS_*_MIRROR` 参数。

## 从源码构建 Debian 包

在目标架构主机上执行构建，让 Rust hostd/terminal 和 `better-sqlite3` 等原生产物与运行环境一致。Rust 版本由 `rust-toolchain.toml` 固定为 1.95.0：

```bash
npm ci
npm --prefix docs ci
npm run build
./packaging/scripts/build-deb.sh
```

构建产物位于 `.cyberos/`。Debian rules 会重新安装 root 与 docs 依赖并执行完整构建，因此不要把 `node_modules` 或 `dist` 手工复制进包。

## 安装与首次启动

标准安装无需产品配置参数：

```bash
sudo ./packaging/scripts/install.sh
```

只有安装器自身的 Nginx 选项在安装前生效：

```bash
sudo CYBEROS_ENABLE_NGINX=1 \
  ./packaging/scripts/install.sh
```

脚本会安装 Node.js 22 和 Rust 1.95.0、构建并安装本架构 `.deb`，创建固定的 `/cyberos/state`、`/cyberos/home/terminal`、`/cyberos/data`、`/cyberos/backup` 和 `/cyberos/iso` 目录，再先运行 `cyberos-state-init.service` 创建并校验主数据库，然后启动 API 及其他数据库消费进程。缺失的设置在运行时使用代码默认值，不会为了填充默认值而写库。安装不会创建存储池，也不会探测或迁移 CyberOS 2.0 之前的目录、设置、数据库或服务。

Docker Engine、Compose、QEMU、libvirt、Chromium、Weston、mpv、seatd、CEC 与输入工具都是 CyberOS 的安装依赖。安装器会启动 Docker 与 libvirt、准备默认 libvirt 网络，并在 API 就绪后按数据库设置应用 TV 模式。CyberOS 默认不开放 Docker 与虚拟机管理能力；安装完成后分别在“系统设置 > Docker”和“系统设置 > 虚拟机”中启用。TV 模式默认开启，可在“系统设置 > 媒体”中关闭或调整输出设备和硬件解码。KVM 硬件加速由宿主内核提供，启用虚拟机管理后仍需检查 `/dev/kvm`；缺失时页面会显示宿主降级，而不是把 QEMU/libvirt 误报为未安装。

安装器默认通过 `sparse+https://rsproxy.cn/index/` 下载 Rust crate；可用 `CYBEROS_CARGO_REGISTRY` 指向其他以 `/` 结尾的 sparse HTTPS registry。该设置只写入一次性 Debian 构建副本，不覆盖 root 用户已有的 Cargo 配置。源码 checkout 和 `.cyberos/deb-build` 必须位于有足够空间的持久文件系统；不要在容量较小的 `/tmp` tmpfs 中执行完整构建。

核心服务会被 `enable --now`：

```bash
sudo systemctl status cyberos-api.service cyberos-monitor.service cyberos-alerter.service cyberos-worker@1.service cyberos-downloader.service cyberos-indexer.service
sudo systemctl status cyberos-hostd.service cyberos-terminald.service
```

Indexer 会立即作为常驻服务启动；maintenance、health 和 backup timers 默认只启用。需要立即刷新索引时使用 API，health 仍可从运维设置页或 systemd 手动启动：

```bash
curl -X POST http://127.0.0.1:3010/api/indexer/reindex \
  -H 'content-type: application/json' -d '{"storagePoolId":"local","recursive":true}'
sudo systemctl start cyberos-health.service
```

## Nginx 与验收

启用 Nginx 后，`cyberos-nginx.sh` 会生成 `/etc/nginx/sites-available/cyberos.conf`，删除默认站点并代理到 `127.0.0.1:3010`。默认端口为 80，可通过 `CYBEROS_NGINX_PORT` 修改。

```bash
curl -fsS http://127.0.0.1:3010/health
curl -I http://<host>/
curl -I http://<host>/docs/
curl -fsS http://127.0.0.1:3010/api/system/storage
curl -fsS http://127.0.0.1:3010/api/system/health
curl -fsS http://127.0.0.1:3010/api/monitoring/overview
```

验收至少包含：Web 首页、`/docs/`、存储池挂载状态、文件浏览、终端身份、一次索引、一次 health run，以及监控在启动 30 秒内从 `starting` 进入 `ready` 或明确的 `degraded`。`/health` 返回成功只表示 API liveness，不表示存储池、监控、索引或 backup 已就绪。

## 安装与重装

CyberOS 2.0 不提供旧产品配置、数据库、服务或浏览器状态的原地迁移。旧设备必须先备份 NAS 数据，然后全新安装或重新制作镜像；不要把旧配置或 SQLite 文件复制到 `/cyberos`。重装 CyberOS 时，先停止会访问 SQLite 或 NAS 的服务与 timers，并保留需要恢复的用户数据：

```bash
sudo systemctl stop cyberos-maintenance.timer cyberos-health.timer \
  cyberos-backup-daily.timer cyberos-backup-weekly.timer
sudo systemctl stop cyberos-downloader.service cyberos-worker@1.service \
  cyberos-indexer.service cyberos-alerter.service cyberos-monitor.service cyberos-vod-player.service cyberos-api.service cyberos-terminald.service \
  cyberos-hostd.service
sudo dpkg -i .cyberos/cyberos_<version>_<arch>.deb
sudo systemctl daemon-reload
findmnt /cyberos/data/pool1
```

安装新包不等于修复已有池权限。重启下载器及开放文件写入前，逐池执行：

```bash
sudo /usr/lib/cyberos/scripts/cyberos-nas-acl.sh --check --pool /cyberos/data/pool1
sudo /usr/lib/cyberos/scripts/cyberos-nas-acl.sh --apply --pool /cyberos/data/pool1
```

对其他已挂载池分别执行。工具只接受 `/cyberos/data` 的直接子目录，只处理已挂载、没有嵌套挂载的池，保留现有所有者并为 `cyberos` 增加访问和默认 ACL；属于 `cyberos` 的私有文件无需新增 ACL，仍保持原有 mask。只读快照、ACL 不支持或路径失败会明确报错。预览会检查已有 ACL mask；若新增授权可能放宽其他身份的有效权限，会拒绝整池应用，须先逐路径审查，不能强行放宽 mask。每次成功进入 `--apply` 阶段都会将原 ACL 保存于输出所示的 `/cyberos/system-backups/permissions/acl.*/acl.dump`，应先查明原因，再在停止写入的状态下以 `setfacl --restore=<exact-backup-path>` 回滚；不要对池运行递归 `chown`。

共享服务只在启用的共享路径获得 ACL。hostd 应用共享设置时备份受影响路径的 ACL，服务重载失败会恢复；可写 NFS 客户端被映射为 `cyberos-nfs`，不继承客户端 UID。

完成挂载和 ACL 验证后启动服务：

```bash
sudo systemctl start cyberos-hostd.service cyberos-terminald.service \
  cyberos-api.service cyberos-monitor.service cyberos-alerter.service cyberos-worker@1.service cyberos-downloader.service cyberos-indexer.service \
  cyberos-vod-player.service
sudo systemctl --failed
sudo journalctl -u cyberos-hostd.service -u cyberos-terminald.service -n 100 --no-pager
```

确认新安装通过验收后再重新启用 timers。CyberOS 主数据库迁移没有通用反向迁移；后续 CyberOS 版本如改变 schema，回滚时必须同时恢复与旧包匹配的主库/state 备份。旧版本不认识 `metrics.sqlite` 时应忽略并保留它；指标库可重建，不参与主库反向迁移。

## GitHub Actions 与 Tailscale 自动升级

公开仓库使用 GitHub-hosted runner 构建并发布双架构 Debian 包，再由独立 workflow 通过 Tailscale OIDC 临时节点连接 CM5。CM5 不运行 self-hosted runner，不需要公网 IP、端口转发、SSH 私钥或保存在 GitHub 中的主机密码。

完整的一次性配置、tag 发布步骤、manifest 校验链、幂等重试和故障处理见[GitHub Actions 发布与 CM5 自动部署](/docs/operations/github-actions-release/)。自动部署只接受稳定的 `vX.Y.Z` tag；不要使用 `latest`、移动已发布 tag 或绕过部署程序的 checksum、版本与数据库回滚边界。

若依赖配置失败，CyberOS 可能已解包但尚未完成 Debian 配置。部署流程只允许对版本与随包 release 构建信息一致、数据库校验通过的 `unpacked` / `half-configured` 安装重试；移除中、损坏或未知安装仍拒绝部署。`verify_only` 始终要求包已完整配置，不会把服务能够响应当作安装成功。

构建前先运行 `npm run version:check`。构建过程会在源码复制到 Debian staging 之前冻结 commit、tag/branch、构建时间、来源和 dirty 状态，并将 `/usr/lib/cyberos/build-info.json` 随包安装。运行中的 API 通过 `/api/system/build-info` 暴露可公开的追溯字段，Web 设置的“版本”分类展示同一份信息。

发布 tag 必须严格匹配根 `package.json`、所有 workspace、docs、Cargo crates 和 Debian changelog 中的统一 SemVer。使用 `npm run release -- patch|minor|major --note "..."` 只准备版本差异；commit、tag、push 和发布仍由维护者单独执行。
