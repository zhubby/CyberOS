---
title: 故障排查
description: API、静态资源、terminal、timer、indexer、backup 和 SQLite 故障排查入口。
type: operation
status: current
audience: [operator]
sourceOfTruth: [packages/api/src/routes/health-status.ts, packages/api/src/routes/monitoring.ts, packages/api/src/routes/monitoring-alerts.ts, crates/monitor/src/adapters/metrics_sqlite.rs, crates/alerter/src/adapters/alert_store, packages/api/src/lib/docker-daemon.ts, packages/api/src/lib/network-manager.ts, packages/api/src/lib/ethernet-manager.ts, crates/hostd/src/docker_daemon.rs, crates/hostd/src/network_manager.rs, crates/hostd/src/network_manager/ethernet.rs, crates/bluetoothd/src/lib.rs, packaging/systemd/cyberos-hostd.service, packaging/systemd/cyberos-bluetoothd.service, packaging/systemd/cyberos-monitor.service, packaging/systemd/cyberos-alerter.service, packaging/systemd/cyberos-api.service, packaging/systemd/cyberos-indexer.service, packages/api/src/web-static.ts]
sidebar:
  order: 4
---

优先查看对应 service 的 journald，再检查 `/health`、`/api/system/health`、`/api/indexer/status`、`/api/system/storage` 和 `/api/backup/status`。`/health` 只代表 API liveness，不代表 NAS、索引或 backup 已就绪。

`SQLITE_BUSY` 通常表示 oneshot 任务并发；应停止相关 timers，确认任务退出后串行运行。静态页面停在 Loading 时，先确认 API 提供当前 Web asset，且不存在的 `/assets/*` 没有被 SPA fallback 返回。

## 监控无数据或降级

先区分配置关闭、刚启动、collector 局部失败和指标库不可读：

```bash
sudo systemctl status cyberos-monitor.service --no-pager
sudo journalctl -u cyberos-monitor.service -u cyberos-api.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/monitoring/overview
sudo -u cyberos sqlite3 /cyberos/state/metrics.sqlite 'PRAGMA quick_check;'
sudo systemctl show cyberos-monitor.service -p MemoryCurrent -p CPUUsageNSec -p NRestarts
```

`disabled` 只表示 `[monitoring].enabled = false`；`starting` 在首次样本前正常，但不应超过 30 秒；`degraded` 表示 collector 失败或容量保护暂停写入；`unavailable` 表示 API 无法安全读取指标库。温度 collector 的 `unsupported` 在没有 thermal sensor 的主机上是正常状态。先检查 `/proc`、`/sys`、NAS mount、systemd D-Bus 和 `/cyberos/state` 权限，不要扩大 service capabilities。

容量到达配置上限时 monitor 依次裁剪 raw、1m、1h；仍无法降到限制内才暂停写入。先确认磁盘和 WAL/checkpoint 状态，再调整 64 MiB–4 GiB 范围内的 `max_database_bytes` 或缩短保留期。指标库可重建，但主库不可替代：如自动隔离失败，只能在停止 `cyberos-monitor.service` 后移动精确的 `metrics.sqlite` 及其 WAL/SHM 文件再启动服务，绝不能移动、删除或修复 `/cyberos/state/cyberos.sqlite`。

## 告警未求值或邮件未发送

先检查 alerter、告警 summary 和主库 outbox，不要从 API 进程直接重发邮件：

```bash
sudo systemctl status cyberos-alerter.service --no-pager
sudo journalctl -u cyberos-alerter.service -u cyberos-monitor.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/monitoring/alerts/summary
sudo -u cyberos sqlite3 /cyberos/state/cyberos.sqlite \
  'select status,count(*) from monitoring_alert_deliveries group by status;'
```

`starting` 通常表示 alerter 正等待 API migration；`degraded` 应结合 pending delivery 数量和日志检查。acknowledged、有效静默、禁用规则和已恢复 incident 都会取消后续升级。`none` 模式如果解析出任一公网或 unspecified 地址会被拒绝；`starttls`/`tls` 证书失败不会降级为明文。修复 SMTP 或 DNS 后保留 outbox，让既有重试调度继续处理，避免手工复制 delivery。

## 媒体扫描与解码

相册面板长时间停在 queued/discovering/processing/retrying 或出现 degraded 时，先检查内部 photos worker、图库状态和目录挂载：

```bash
sudo systemctl status cyberos-photos.service --no-pager
sudo journalctl -u cyberos-photos.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/photos/status
curl -fsS http://127.0.0.1:3010/api/photos/map/settings
command -v exiftool
command -v vipsthumbnail
command -v heif-convert
command -v dcraw_emu
command -v ffmpeg
command -v ffprobe
```

`offline` 表示照片设置对应的 root、storage pool 或目录当前不可用；先恢复相同挂载，不要把其他目录挂到原路径伪装成照片库。元数据 `pending` 长时间不下降时检查 worker 日志中的 schema/sidecar 解析警告并手动排队一次扫描；单个资源 `partial` 不会阻止浏览。XMP 超过 16 MiB、结构化元数据超过限额或 sidecar 关联有歧义时会记录警告而不猜测。

单个 HEIC/HEIF 失败时确认 `libheif-examples` 已安装；单个 RAW 失败时确认 `libraw-bin`/`dcraw_emu` 可执行并验证源文件；视频海报或播放失败时确认 `ffmpeg` 和 `ffprobe` 已安装。JPEG/PNG 等全部失败时检查 `/cyberos/state/photos` 与照片目录对 `cyberos` 用户的读写权限。WebP 衍生图位于 `/cyberos/state/photos/thumbnail` 和 `/cyberos/state/photos/preview`，视频转码缓存位于 `/cyberos/state/media-cache/videos`。单个文件解码失败只会将该媒体标记为 `failed`，其他媒体继续处理，原文件仍可下载；完整遍历失败不会清理未确认的旧资源。

修复解码器后，已有不可重试的 `failed` 条目不会因服务重启立即重试。当前扫描尚在运行时，普通 Scan 会复用该任务；等本轮完成后再发起 Scan，或等待后续周期扫描，失败资源会重新处理，未变化的 `ready` 资源仍可跳过。不要直接修改生产任务表或删除原文件来触发重试。

## 离线地图下载

地图下载失败时先读取托管状态和 API journal，再检查固定目录的空间与权限：

```bash
curl -fsS http://127.0.0.1:3010/api/photos/map/settings
sudo journalctl -u cyberos-api.service -n 100 --no-pager
sudo -u cyberos test -w /cyberos/state/photos/maps
df -h /cyberos/state
curl -fsS -H 'Range: bytes=0-7' http://127.0.0.1:3010/api/photos/map/archive
```

`ready` 时最后一个请求应返回 `206`；`not_downloaded` 时归档接口返回 `404`。网络、长度、23,141,432 字节固定大小、SHA-256 或 PMTiles/JPEG 校验失败会进入 `failed`，无效 `.part` 文件会自动删除，界面“重试”从零下载。不要手工放入同名文件来绕过校验；若固定成品损坏，保留 journal 信息后移走该单一文件，再从界面重试。

Photos 地图底图使用 CyberOS 固定、带校验的发行资源，不支持通过环境变量或产品配置改写下载地址。受限网络环境应在出口代理或镜像层透明提供同一资产；校验失败时修复镜像内容，不能修改本机校验值。Natural Earth II 最高仅到 `z6`，放大后缺少街道细节是预期行为。

## 服务目录所有权与启动顺序

root hostd 不声明 `StateDirectory` 或 `LogsDirectory`，只通过 `ReadWritePaths` 放行 `/cyberos/state/hostd/docker-daemon`、`/cyberos/state/hostd/network-manager` 和所需宿主路径；它不得写 `/cyberos/state` 父目录或 `/cyberos/logs`。否则 hostd 可能改动共享状态，导致非 root API/worker 无法打开 SQLite。动态共享账号需要 `useradd` 原子更新账号数据库，因此 unit 会显式放行 `/etc`；Samba 的 `smbpasswd` 还需要 `/run/samba`、`/var/lib/samba`、`/var/cache/samba` 和 `/var/log/samba` 可写。不要用反复递归 chown 或赋予 API root 权限掩盖问题。

```bash
sudo systemctl show cyberos-hostd.service -p StateDirectory -p StateDirectoryMode -p LogsDirectory
sudo stat -c '%U:%G %a %n' /cyberos/state /cyberos/state/hostd/docker-daemon /cyberos/state/hostd/network-manager /cyberos/logs
sudo systemctl cat cyberos-hostd.service
```

Debian 部署的共享父目录保持 `cyberos:cyberos 750`，Docker 与 NetworkManager 恢复子目录保持 `root:root 700`。升级后检查现有 drop-in 不得重新引入共享父目录声明。CM5 上已有的 `deployment-state.conf` 如设置相同的嵌套目录，可保留。修复权限前停止 timers 和所有数据库写入进程，先保存一致备份；仅修复核实错误的目标，不改变恢复材料权限。

在维护窗口分别验证 hostd→API/worker 和 API/worker→hostd 两种启动顺序，以及 hostd 单独重启后 API 仍可访问数据库。查看 `Permission denied`、`SQLITE_CANTOPEN` 和重启计数；不能只检查一次 `/health`。设备重启验收须另行安排，不能用服务重启代替。

## 下载目录权限

下载服务以 `cyberos` 用户运行。新建存储池挂载后会将池根目录归属设为 `cyberos:cyberos`，但已有存储池及其子目录的所有权不会自动更改。若下载任务报 `EACCES`，先确认实际挂载和目标目录权限：

```bash
findmnt -T /cyberos/data/pool1/Downloads
namei -l /cyberos/data/pool1/Downloads
sudo -u cyberos test -w /cyberos/data/pool1/Downloads
```

仅在确认目标目录应由 CyberOS 管理后，针对报错的目录修复所有权，例如 `sudo chown cyberos:cyberos /cyberos/data/pool1/Downloads`。不要递归更改整个存储池或绕过挂载检查；如果目录由共享用户管理，应先核对共享访问策略，再为 `cyberos` 授予所需的目录写入权限。修复后在下载面板重试失败任务。

## Wi-Fi 与热点

界面显示只读或没有无线设备时，先区分后端、radio、驱动与 hostd：

```bash
nmcli -t -f RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI general
nmcli device status
iw dev
sudo systemctl status NetworkManager.service cyberos-hostd.service --no-pager
sudo journalctl -u NetworkManager.service -u cyberos-hostd.service -n 100 --no-pager
```

非 NetworkManager 主机不会自动迁移。`wlan0` 为 unmanaged 时检查 NetworkManager 配置和已有 Netplan renderer，不要直接删除外部 profile。扫描失败但状态可读通常表示 hostd、radio 或权限异常；确认 `/run/cyberos/hostd.sock`、unit 的 `/etc/NetworkManager/system-connections` 写路径以及 `iw` 是否安装。

热点启动失败时，检查 `/cyberos/state/hostd/network-manager/state.json` 和 NetworkManager journal。该文件只记录待恢复 profile UUID，不含密码；不要手工编辑正在使用的状态。若自动恢复失败，使用 `nmcli connection up uuid <uuid> ifname <device>` 恢复，确认客户端连接后再移除对应状态。Wi-Fi/热点密码位于 root-only `.nmconnection` 文件中，不要把文件正文复制到日志或工单。

## 蓝牙、BlueZ 与配对

“设置 > 设备 > 蓝牙”显示无适配器或 BlueZ 不可用时，依次检查系统总线、BlueZ 服务、控制器和 hostd：

```bash
sudo systemctl status dbus.service bluetooth.service cyberos-hostd.service --no-pager
sudo journalctl -u bluetooth.service -u cyberos-hostd.service -n 120 --no-pager
busctl --system tree org.bluez
bluetoothctl list
rfkill list bluetooth
```

CyberOS 通过 BlueZ D-Bus 操作设备，不解析 `bluetoothctl` 输出；`bluetoothctl` 只用于人工诊断。存在控制器但页面为空时，确认 `org.bluez.Adapter1` 对象可见，以及 `/run/cyberos/hostd.sock` 可访问。扫描立即停止通常是适配器未上电、被 rfkill 阻止或已有其他进程持有 discovery；先解除硬件阻止，再从页面重新启动 15 秒扫描。

默认适配器偏好位于 `/cyberos/state/hostd/bluetooth/default-adapter`，不包含密钥。配对密钥和 Trusted 标志由 BlueZ 保存，不要复制 `/var/lib/bluetooth` 到日志或工单。配对挑战过期后应重新发起配对，不要重复提交旧 challenge ID。

音频无声或发生回退时，分别检查 BlueALSA、ALSA 插件和 VOD 日志：

```bash
dpkg-query -W bluez-alsa-utils libasound2-plugin-bluez
sudo systemctl status bluealsa.service cyberos-vod-player.service --no-pager
sudo journalctl -u bluealsa.service -u cyberos-vod-player.service -n 120 --no-pager
sudo -u cyberos aplay -L | sed -n '/bluealsa/,+4p'
```

设置页只允许枚举出的 `bluetooth:<adapter-id>/<MAC>`，不要把 `hw:*`、`bluealsa:*` 或其他 ALSA 字符串直接写入数据库。输出设备断开或 ALSA 打开失败时，VOD 应继续使用原有 ALSA/HDMI，在播放器条显示回退原因，并在通知中心留下该播放会话的回退记录。蓝牙设备重新连接后，重新开始一次播放才会再次选择它。

文件传输异常时检查 OBEX、独立传输服务、持久队列和目标存储：

```bash
dpkg-query -W bluez-obexd dbus-user-session
sudo systemctl status cyberos-bluetoothd.service bluetooth.service --no-pager
sudo journalctl -u cyberos-bluetoothd.service -u bluetooth.service -n 160 --no-pager
sudo -u cyberos sqlite3 /cyberos/state/cyberos.sqlite \
  'select direction,status,count(*) from bluetooth_transfers group by direction,status;'
findmnt -T /cyberos/data/pool-1
df -h /cyberos/data/pool-1
```

`cyberos-bluetoothd` 通过自己的用户会话 D-Bus 激活 `bluez-obexd`。服务反复退出时检查 `dbus-run-session`、OBEX D-Bus activation 文件及 `/cyberos/state/bluetooth` 所有权，不要改为 root。收件被拒绝时确认发送设备同时为 Paired 和 Trusted、收件开关已开启、所选 NAS 目录仍属于同一挂载源且 `cyberos` 可写。目录离线、空间不足、出现符号链接或挂载源变化都会拒绝新文件；修复后重新从发送端发起，不要手工把失败记录改为完成。接收完成后会短暂显示“正在保存”，API 从 `/cyberos/state/bluetooth/incoming` 将文件安全落入接收授权时选定的收件目录；长期停留在该状态时同时检查 `cyberos-api` 日志和暂存目录。接收文件重名会自动追加时间戳或序号，不覆盖原文件。

## 多网口 Ethernet 与 checkpoint

有载波但没有地址的网口应显示为“链路已建立”，不是“已连接”。先同时检查永久 MAC、活动 profile、地址与默认路由：

```bash
nmcli -t -f DEVICE,TYPE,STATE,CONNECTION,CON-UUID device status
ip -j address show
ip -j route show default
sudo journalctl -u NetworkManager.service -u cyberos-hostd.service -n 120 --no-pager
```

CyberOS 托管文件固定为 `/etc/NetworkManager/system-connections/cyberos-ethernet-<mac>.nmconnection`，期望配置与事务位于 root-only `/cyberos/state/hostd/network-manager`。保存不会切换网络；只有全局应用会创建 checkpoint、发布全部 pending keyfile 并启动 90 秒确认窗口。高级 802.1X、多地址、自定义路由、Bond/Bridge/VLAN controller port 保持外部只读，不应通过删除外部 profile 强制接管。

若页面断线，先从其他网口或本机重新打开页面并确认同一 transaction。超时后 NetworkManager 会恢复运行连接，hostd 会恢复磁盘 keyfile；hostd 启动时也会恢复未完成事务。若状态为“回滚失败”，保留 `/cyberos/state/hostd/network-manager/ethernet-transaction.json`，不要删除恢复材料。使用部署前保存的外部 profile UUID逐口恢复：

```bash
sudo nmcli connection reload
sudo nmcli connection up uuid <external-profile-uuid> ifname <interface>
```

降级到不识别 Ethernet 类型的旧 hostd 前，先恢复外部 profile、确认管理链路与默认路由，再删除已核实的 `cyberos-ethernet-*` 文件并 reload。不要删除未知管理员或 Netplan profile。

## Docker 拉取与资源能力

分别检查设备到镜像源的 DNS/TLS、镜像代理 `/v2/` 和实际镜像拉取。`/v2/` 返回 `200` 或认证挑战 `401` 只能证明网络可达，不能证明镜像存在或凭证有效。Registry mirror 在 daemon JSON 中配置，例如 `https://docker.zhubby.com`；CyberOS Registry 凭证匹配仍按镜像引用，而不是自动改为 mirror 地址。

检查 Engine `/info` 的 `MemoryLimit`、`SwapLimit`、`CpuCfsQuota`、`CpuCfsPeriod` 等属性及内核/cgroup 配置。能力未知或不支持时清空对应限制，不绕过 API 校验。修改 CM5 内核启动参数需备份原配置并有独立维护窗口；本功能不会自动更改宿主机。资源统计 `null` 与资源能力 `false` 是不同信号。

## Docker daemon 配置恢复

先分别检查 service 与 Engine socket，不要把两者混为一个故障：

```bash
sudo systemctl show docker.service -p LoadState -p ActiveState -p SubState -p Result
sudo journalctl -u docker.service -u cyberos-hostd.service -n 100 --no-pager
sudo dockerd --validate --config-file /etc/docker/daemon.json
curl -fsS http://127.0.0.1:3010/api/docker/summary
```

若界面报告自动回滚失败，停止继续保存，查看 `/cyberos/state/hostd/docker-daemon/transaction.json`。当其中 `baselineExists` 为 `true` 且 `baseline.json` 存在时，可人工恢复：

```bash
sudo install -o root -g root -m 0644 /cyberos/state/hostd/docker-daemon/baseline.json /etc/docker/daemon.json
sudo dockerd --validate --config-file /etc/docker/daemon.json
sudo systemctl restart docker.service
```

若 `baselineExists` 为 `false`，基线代表原先没有配置文件，应移走当前 `/etc/docker/daemon.json` 后再启动。确认 Docker 恢复前保留事务目录；恢复完成后再删除其中的 `transaction.json` 和 `baseline.json`。不要把这些文件的正文复制到日志或工单，它们可能包含 registry、proxy 或 credential 配置。

## 托管 Compose App 恢复

SQLite 是托管 App 的唯一数据源，`/cyberos/apps` 不单独备份。API 启动时会按数据库重建带匹配 App ID 标记的目录；它不会覆盖未知目录、跟随符号链接或删除管理员手工留下的目录。运行副本异常时先检查所有权和标记，不要直接递归删除整个 `/cyberos/apps`：

```bash
sudo stat -c '%U:%G %a %n' /cyberos/apps /cyberos/apps/* 2>/dev/null
sudo systemctl show cyberos-api.service -p ReadWritePaths
sudo journalctl -u cyberos-api.service -n 100 --no-pager
sudo systemctl restart cyberos-api.service
```

预期 `/cyberos/apps` 为 `cyberos:cyberos 0750`，API unit 仅新增该路径的写权限。生产环境的 storage pool 不得与 `/cyberos/apps` 上下级重叠，因此该目录不会进入文件面板或普通文件操作。若某项目目录缺少 `.cyberos-app.json`、标记 App ID 不匹配或目录是符号链接，API 会拒绝覆盖；把未知目录移到经确认的隔离位置后再重启 API。不要在日志或工单中粘贴 `.env`、SQLite 行或完整 Compose 解析结果。

CyberOS 2.0 只管理数据库中登记并发布到 `/cyberos/apps/<project-key>` 的 App，不发现或导入其他 Compose 目录。不要把外部目录直接复制进 `/cyberos/apps`；应在页面创建 App，并在部署前重新核对 YAML、环境变量和数据挂载。
