---
title: 故障排查
description: API、静态资源、terminal、timer、indexer、backup 和 SQLite 故障排查入口。
type: operation
status: current
audience: [operator]
sourceOfTruth: [apps/api/src/routes/health-status.ts, apps/api/src/lib/docker-daemon.ts, apps/api/src/lib/network-manager.ts, apps/api/src/lib/ethernet-manager.ts, apps/hostd/src/docker_daemon.rs, apps/hostd/src/network_manager.rs, apps/hostd/src/network_manager/ethernet.rs, packaging/systemd/sigmaos-hostd.service, packaging/systemd/sigmaos-api.service, packaging/systemd/sigmaos-indexer.service, apps/api/src/web-static.ts]
sidebar:
  order: 4
---

优先查看对应 service 的 journald，再检查 `/health`、`/api/system/health`、`/api/indexer/status`、`/api/roots/readiness` 和 `/api/backup/status`。`/health` 只代表 API liveness，不代表 NAS、索引或 backup 已就绪。

`SQLITE_BUSY` 通常表示 oneshot 任务并发；应停止相关 timers，确认任务退出后串行运行。静态页面停在 Loading 时，先确认 API 提供当前 Web asset，且不存在的 `/assets/*` 没有被 SPA fallback 返回。

## 媒体扫描与解码

Photostaff 面板长时间停在 queued/discovering/processing/retrying 或出现 degraded 时，先检查 worker、库状态和目录挂载：

```bash
sudo systemctl status sigmaos-photostaff.service --no-pager
sudo journalctl -u sigmaos-photostaff.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/photostaff/status
curl -fsS http://127.0.0.1:3010/api/photostaff/map/settings
command -v exiftool
command -v vipsthumbnail
command -v heif-convert
command -v dcraw_emu
command -v ffmpeg
command -v ffprobe
```

`offline` 表示照片设置对应的 root、storage pool 或目录当前不可用；先恢复相同挂载，不要把其他目录挂到原路径伪装成照片库。元数据 `pending` 长时间不下降时检查 worker 日志中的 schema/sidecar 解析警告并手动排队一次扫描；单个资源 `partial` 不会阻止浏览。XMP 超过 16 MiB、结构化元数据超过限额或 sidecar 关联有歧义时会记录警告而不猜测。

单个 HEIC/HEIF 失败时确认 `libheif-examples` 已安装；单个 RAW 失败时确认 `libraw-bin`/`dcraw_emu` 可执行并验证源文件；视频海报或播放失败时确认 `ffmpeg` 和 `ffprobe` 已安装。JPEG/PNG 等全部失败时检查 `/var/lib/sigmaos/photostaff` 与照片目录对 `sigmaos` 用户的读写权限。WebP 衍生图位于 `/var/lib/sigmaos/photostaff/thumbnail` 和 `/var/lib/sigmaos/photostaff/preview`，视频转码缓存位于 `/var/lib/sigmaos/media-cache/videos`。单个文件解码失败只会将该媒体标记为 `failed`，其他媒体继续处理，原文件仍可下载；完整遍历失败不会清理未确认的旧资源。

## 离线地图下载

地图下载失败时先读取托管状态和 API journal，再检查固定目录的空间与权限：

```bash
curl -fsS http://127.0.0.1:3010/api/photostaff/map/settings
sudo journalctl -u sigmaos-api.service -n 100 --no-pager
sudo -u sigmaos test -w /var/lib/sigmaos/photostaff/maps
df -h /var/lib/sigmaos
curl -fsS -H 'Range: bytes=0-7' http://127.0.0.1:3010/api/photostaff/map/archive
```

`ready` 时最后一个请求应返回 `206`；`not_downloaded` 时归档接口返回 `404`。网络、长度、23,141,432 字节固定大小、SHA-256 或 PMTiles/JPEG 校验失败会进入 `failed`，无效 `.part` 文件会自动删除，界面“重试”从零下载。不要手工放入同名文件来绕过校验；若固定成品损坏，保留 journal 信息后移走该单一文件，再从界面重试。

受限网络可把 `SIGMAOS_PHOTOSTAFF_BASEMAP_URL` 或 TOML `[photostaff].basemap_url` 指向 HTTPS 镜像。镜像必须逐字节提供同一资产，内置 SHA-256 不可覆盖；镜像校验失败时修复镜像内容，而不是修改本机校验值。Natural Earth II 最高仅到 `z6`，放大后缺少街道细节是预期行为。

## 服务目录所有权与启动顺序

root hostd 只声明 `StateDirectory=sigmaos/docker-daemon` 和 `StateDirectory=sigmaos/network-manager`（均为 `0700 root:root`），不声明共享的 `StateDirectory=sigmaos` 或 `LogsDirectory=sigmaos`，`ReadWritePaths` 也不得包含 `/var/lib/sigmaos` 父目录或 `/var/log/sigmaos`。否则 hostd 可能改动共享状态，或 systemd 在启动时重设父目录及子文件的所有权，导致非 root API/worker 无法打开 SQLite。动态共享账号需要 `useradd` 原子更新账号数据库，因此 unit 会显式放行 `/etc`；Samba 的 `smbpasswd` 还需要 `/run/samba`、`/var/lib/samba`、`/var/cache/samba` 和 `/var/log/samba` 可写。不要用反复递归 chown 或赋予 API root 权限掩盖问题。

```bash
sudo systemctl show sigmaos-hostd.service -p StateDirectory -p StateDirectoryMode -p LogsDirectory
sudo stat -c '%U:%G %a %n' /var/lib/sigmaos /var/lib/sigmaos/docker-daemon /var/lib/sigmaos/network-manager /var/log/sigmaos
sudo systemctl cat sigmaos-hostd.service
```

共享父目录保持 `sigmaos:sigmaos`，Docker 与 NetworkManager 恢复子目录保持 `root:root 700`。升级后检查现有 drop-in 不得重新引入共享父目录声明。CM5 上已有的 `deployment-state.conf` 如设置相同的嵌套目录，可保留；恢复文件无需迁移。修复权限前停止 timers 和所有数据库写入进程，先保存一致备份；仅修复核实错误的目标，不改变恢复材料权限。

在维护窗口分别验证 hostd→API/worker 和 API/worker→hostd 两种启动顺序，以及 hostd 单独重启后 API 仍可访问数据库。查看 `Permission denied`、`SQLITE_CANTOPEN` 和重启计数；不能只检查一次 `/health`。设备重启验收须另行安排，不能用服务重启代替。

## 下载目录权限

下载服务以 `sigmaos` 用户运行。新建存储池挂载后会将池根目录归属设为 `sigmaos:sigmaos`，但已有存储池及其子目录的所有权不会自动更改。若下载任务报 `EACCES`，先确认实际挂载和目标目录权限：

```bash
findmnt -T /srv/nas/pool1/Downloads
namei -l /srv/nas/pool1/Downloads
sudo -u sigmaos test -w /srv/nas/pool1/Downloads
```

仅在确认目标目录应由 SigmaOS 管理后，针对报错的目录修复所有权，例如 `sudo chown sigmaos:sigmaos /srv/nas/pool1/Downloads`。不要递归更改整个存储池或绕过挂载检查；如果目录由共享用户管理，应先核对共享访问策略，再为 `sigmaos` 授予所需的目录写入权限。修复后在下载面板重试失败任务。

## Wi-Fi 与热点

界面显示只读或没有无线设备时，先区分后端、radio、驱动与 hostd：

```bash
nmcli -t -f RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI general
nmcli device status
iw dev
sudo systemctl status NetworkManager.service sigmaos-hostd.service --no-pager
sudo journalctl -u NetworkManager.service -u sigmaos-hostd.service -n 100 --no-pager
```

非 NetworkManager 主机不会自动迁移。`wlan0` 为 unmanaged 时检查 NetworkManager 配置和已有 Netplan renderer，不要直接删除外部 profile。扫描失败但状态可读通常表示 hostd、radio 或权限异常；确认 `/run/sigmaos/hostd.sock`、unit 的 `/etc/NetworkManager/system-connections` 写路径以及 `iw` 是否安装。

热点启动失败时，检查 `/var/lib/sigmaos/network-manager/state.json` 和 NetworkManager journal。该文件只记录待恢复 profile UUID，不含密码；不要手工编辑正在使用的状态。若自动恢复失败，使用 `nmcli connection up uuid <uuid> ifname <device>` 恢复，确认客户端连接后再移除对应状态。Wi-Fi/热点密码位于 root-only `.nmconnection` 文件中，不要把文件正文复制到日志或工单。

## 多网口 Ethernet 与 checkpoint

有载波但没有地址的网口应显示为“链路已建立”，不是“已连接”。先同时检查永久 MAC、活动 profile、地址与默认路由：

```bash
nmcli -t -f DEVICE,TYPE,STATE,CONNECTION,CON-UUID device status
ip -j address show
ip -j route show default
sudo journalctl -u NetworkManager.service -u sigmaos-hostd.service -n 120 --no-pager
```

SigmaOS 托管文件固定为 `/etc/NetworkManager/system-connections/sigmaos-ethernet-<mac>.nmconnection`，期望配置与事务位于 root-only `/var/lib/sigmaos/network-manager`。保存不会切换网络；只有全局应用会创建 checkpoint、发布全部 pending keyfile 并启动 90 秒确认窗口。高级 802.1X、多地址、自定义路由、Bond/Bridge/VLAN controller port 保持外部只读，不应通过删除外部 profile 强制接管。

若页面断线，先从其他网口或本机重新打开页面并确认同一 transaction。超时后 NetworkManager 会恢复运行连接，hostd 会恢复磁盘 keyfile；hostd 启动时也会恢复未完成事务。若状态为“回滚失败”，保留 `/var/lib/sigmaos/network-manager/ethernet-transaction.json`，不要删除恢复材料。使用部署前保存的外部 profile UUID逐口恢复：

```bash
sudo nmcli connection reload
sudo nmcli connection up uuid <external-profile-uuid> ifname <interface>
```

降级到不识别 Ethernet 类型的旧 hostd 前，先恢复外部 profile、确认管理链路与默认路由，再删除已核实的 `sigmaos-ethernet-*` 文件并 reload。不要删除未知管理员或 Netplan profile。

## Docker 拉取与资源能力

分别检查设备到镜像源的 DNS/TLS、镜像代理 `/v2/` 和实际镜像拉取。`/v2/` 返回 `200` 或认证挑战 `401` 只能证明网络可达，不能证明镜像存在或凭证有效。Registry mirror 在 daemon JSON 中配置，例如 `https://docker.zhubby.com`；SigmaOS Registry 凭证匹配仍按镜像引用，而不是自动改为 mirror 地址。

检查 Engine `/info` 的 `MemoryLimit`、`SwapLimit`、`CpuCfsQuota`、`CpuCfsPeriod` 等属性及内核/cgroup 配置。能力未知或不支持时清空对应限制，不绕过 API 校验。修改 CM5 内核启动参数需备份原配置并有独立维护窗口；本功能不会自动更改宿主机。资源统计 `null` 与资源能力 `false` 是不同信号。

## Docker daemon 配置恢复

先分别检查 service 与 Engine socket，不要把两者混为一个故障：

```bash
sudo systemctl show docker.service -p LoadState -p ActiveState -p SubState -p Result
sudo journalctl -u docker.service -u sigmaos-hostd.service -n 100 --no-pager
sudo dockerd --validate --config-file /etc/docker/daemon.json
curl -fsS http://127.0.0.1:3010/api/docker/summary
```

若界面报告自动回滚失败，停止继续保存，查看 `/var/lib/sigmaos/docker-daemon/transaction.json`。当其中 `baselineExists` 为 `true` 且 `baseline.json` 存在时，可人工恢复：

```bash
sudo install -o root -g root -m 0644 /var/lib/sigmaos/docker-daemon/baseline.json /etc/docker/daemon.json
sudo dockerd --validate --config-file /etc/docker/daemon.json
sudo systemctl restart docker.service
```

若 `baselineExists` 为 `false`，基线代表原先没有配置文件，应移走当前 `/etc/docker/daemon.json` 后再启动。确认 Docker 恢复前保留事务目录；恢复完成后再删除其中的 `transaction.json` 和 `baseline.json`。不要把这些文件的正文复制到日志或工单，它们可能包含 registry、proxy 或 credential 配置。

## 托管 Compose App 恢复

SQLite 是托管 App 的唯一数据源，`/srv/apps` 不单独备份。API 启动时会按数据库重建带匹配 App ID 标记的目录；它不会覆盖未知目录、跟随符号链接或删除管理员手工留下的目录。运行副本异常时先检查所有权和标记，不要直接递归删除整个 `/srv/apps`：

```bash
sudo stat -c '%U:%G %a %n' /srv/apps /srv/apps/* 2>/dev/null
sudo systemctl show sigmaos-api.service -p ReadWritePaths
sudo journalctl -u sigmaos-api.service -n 100 --no-pager
sudo systemctl restart sigmaos-api.service
```

预期 `/srv/apps` 为 `sigmaos:sigmaos 0750`，API unit 仅新增该路径的写权限。生产环境的 NAS root 不得与 `/srv/apps` 上下级重叠，因此该目录不会进入文件面板或普通文件操作。若某项目目录缺少 `.sigmaos-app.json`、标记 App ID 不匹配或目录是符号链接，API 会拒绝覆盖；把未知目录移到经确认的隔离位置后再重启 API。不要在日志或工单中粘贴 `.env`、SQLite 行或完整 Compose 解析结果。

升级前配置的旧 Compose roots 会被忽略，旧文件和容器不会自动删除。需要重新纳管时在页面使用相同 `projectKey` 创建 App，以重新关联带相同 Compose project label 的容器；先核对 YAML、环境变量和数据挂载，不能把旧目录直接复制进 `/srv/apps`。
