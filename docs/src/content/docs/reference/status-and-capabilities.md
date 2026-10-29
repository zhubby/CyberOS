---
title: 状态、能力与限制
description: Job、approval、operation、index、backup 和可用能力的当前状态。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [packages/shared/src/types.ts, packages/api/src/lib/docker-daemon.ts, packages/api/src/lib/docker-registry.ts, packages/api/src/lib/network-manager.ts, packages/api/src/lib/ethernet-manager.ts, packages/api/src/lib/bluetooth-manager.ts, packages/api/src/routes/bluetooth-transfers.ts, crates/bluetoothd/src/lib.rs, packages/db/src/repositories/capability-runs.ts, packages/db/src/repositories/index-run-status.ts, packages/db/src/repositories/backup-runs.ts]
sidebar:
  order: 4
---

Job 状态包括 `queued`、`running`、`waiting_approval`、`completed`、`failed`、`cancelled`。Agent/MCP mutation 的 capability approval 包括 `pending`、`approved`、`rejected`、`expired`、`failed`；文件领域 operation 记录 `proposed`、`applied`、`rolled_back`、`failed`。

当前已实现文件浏览、预览、上传、编辑、归档检查、搜索、照片完整标量元数据索引与多维查询、一键下载的 Natural Earth II 栅格 PMTiles 地图、视频播放、RAW 预览、XMP sidecar 联动、Agent 照片查询、capability approval、trash/restore、Docker/VM/share/terminal 控制、NetworkManager 物理 Ethernet/Wi-Fi/热点控制、indexer、restic backup 和健康 API。

## 宿主机能力

CyberOS 2.0 的 Debian/systemd 部署固定为可变更宿主模式，不再暴露可切换的宿主变更策略。网络、存储、共享和 Docker summary 中的 `can*` 标志由实际后端、硬件、systemd unit 与 `cyberos-hostd` 就绪状态推导。Web 可以用它们表达不可用原因，但服务端仍必须独立执行权限、路径、状态和确认校验。

storage pool 文件操作、Agent capability approval、Compose App、终端和电源控制各自保持原有安全边界；宿主能力可用不代表可以绕过这些检查。

照片能力不支持在线地图、矢量 PMTiles、地理编码、人物识别、语义图像搜索、手动相册、分享链接、媒体编辑或元数据写回。原媒体与 sidecar 不被修改，WebP 衍生图不保留元数据；“完整元数据”指防御性限额内的全部标量标签，不包含 MakerNote、嵌入缩略图和二进制负载。Agent 可按位置筛选，但结果不会向云模型返回精确 GPS、序列号、联系信息或人物区域。

## 网络后端与无线能力

接口、地址和路由始终来自内核 `ip` 数据；网络配置后端单独检测。NetworkManager 正常运行时，`canManageWifi` 要求 root `cyberos-hostd` 可用且至少存在一个无线设备；`canManageHotspot` 还要求设备声明 AP 能力。其他后端继续只读，界面不会把未知后端伪装为 `systemd-networkd`。

`canManageEthernet` 还要求至少一个独立物理 Ethernet 设备。链路有载波但尚无地址时通用接口状态为 `up`，只有取得地址后才是 `connected`。Ethernet 的 daemon/backend 可用性、单口链路与地址、托管状态以及 90 秒应用事务分别展示，不能互相代替。

无线设备状态通过 `system.wifi.status` SSE 独立更新。SSE 断开时界面显示 `reconnecting`，不把旧状态当作实时状态。扫描是显式请求，保留 BSSID 级结果；界面按 SSID 和安全模式分组并默认使用最强 AP。

Wi-Fi 的射频、连接、已保存网络和热点操作统一位于“设置 > 设备 > 无线网卡”。网络面板只显示连接状态和最近一次显式扫描结果；进入面板时仅在射频开启、NetworkManager 与 hostd 可用时自动扫描一次。射频关闭后网络卡片清空旧扫描结果并显示设置入口，不把缓存结果当作当前环境。

同一无线网卡不能同时作为客户端和热点；不同网卡互不影响。热点 autostart 默认关闭，停止热点会同时关闭 autostart 并尝试恢复启动热点前的客户端 profile。成功切换后不设置超时回滚，失败激活会执行即时恢复并公开恢复结果。

## 蓝牙设备管理

蓝牙状态以 BlueZ 系统 D-Bus 为唯一权威来源，CyberOS 不复制配对密钥、信任状态或连接状态。`cyberos-hostd` 通过专用 `bluetooth.manager` 协议枚举适配器和设备、控制射频与扫描，并执行配对、取消配对、信任、连接、断开和遗忘；API 通过 `system.bluetooth.status` SSE 发布变化。默认适配器偏好保存在 root-only `/cyberos/state/hostd/bluetooth/default-adapter`。

系统支持多个适配器，所有扫描和设备操作都携带适配器 ID 与规范化 MAC 地址，hostd 会重新解析 BlueZ 对象并拒绝未知对象。设置页的手动扫描默认持续约 15 秒；配对成功不会自动信任。没有蓝牙硬件、BlueZ 未运行或系统 D-Bus 不可用时，不影响其他 CyberOS 服务启动，页面会显示具体不可用原因。

蓝牙设备管理依赖 Debian `bluez`；音频和文件传输还依赖 `bluez-obexd`、`bluez-alsa-utils`、`libasound2-plugin-bluez`、用户会话 D-Bus 和非 root `cyberos-bluetoothd`。`cyberos-bluetoothd` 负责 OBEX 会话、逐文件队列、进度和持久传输记录，hostd 仍只负责需要系统权限的 BlueZ 控制。传输状态通过独立 SSE 发布并进入通知中心，不写入聊天流。接收内容先写入 `/cyberos/state/bluetooth/incoming`；传输服务对 `/cyberos/data` 只有读权限，API 在重新校验接收授权时选定的收件目录、挂载和文件名后完成最终落盘。

音频只改变 CyberOS/VOD 播放输出，不改变系统 UI 音频，也不支持手机向 CyberOS 输入音频。设置只保存枚举产生的稳定 `bluetooth:<adapter-id>/<MAC>` ID；API 和 VOD 都不接受任意 ALSA 设备字符串。选择从下一次播放生效；设备断开或 BlueALSA 打开失败时，VOD 立即回退到原有 ALSA/HDMI 输出，在播放器状态中保留原因，并按播放会话写入一条持久通知。

文件发送只接受已挂载 storage pool 内经安全解析的普通文件，批量任务逐文件记录 `queued`、`running`、`completed`、`failed` 或 `cancelled`。文件接收是用户明确开启的系统托管收件箱特例，不进入 Agent approval；只有已配对且手动标记为 Trusted 的设备可以发送。每次接收都会重新验证 storage pool、挂载源、目录可写性、符号链接/防穿越和可用空间；离线或空间不足时拒绝新传输。同名文件追加时间戳和序号，绝不覆盖现有文件。

## Docker 的两个状态信号

Docker daemon 状态来自 systemd 的 `LoadState`、`ActiveState`、`SubState` 和 `Result`，归一化为 `running`、`starting`、`stopping`、`stopped`、`failed`、`not_installed`；Web SSE 断线时显示 `reconnecting`。即使 CyberOS 的 Docker 管理开关关闭，daemon 状态仍会采集。

Docker Engine readiness 独立来自配置的 Unix socket。daemon 可以是 `running`，但 socket 因路径、权限或 API 协商问题不可访问；此时界面继续显示 daemon 为 Running，同时展示 Engine 异常并禁用容器、Compose 和控制台操作。不要用 `/api/docker/summary` 中的 Engine `ready` 代替 systemd service 状态，也不要用 daemon Running 推断容器 API 一定可用。

镜像列表、拉取和删除同样依赖 Engine readiness；Engine 不可用时界面保留镜像区域的错误状态并禁用这些操作。Registry 凭证是 CyberOS 本地设置，不依赖 daemon 或 Engine，可在 Docker 管理关闭时继续新增、轮换和删除。镜像删除需要 UI 二次确认和服务端 `confirmed: true`。容器生命周期与 Compose 动作也是第一方直接管理流程，使用页面确认、服务端校验和 Docker operation 审计，不创建 capability approval。

Registry 凭证会自动用于手动拉取、容器创建时的 `always/missing` 拉取，以及 Compose `pull/up`。首期不支持 push、tag、prune、导入导出、credential helper、自定义 CA、客户端证书、identity token 或逐层拉取进度。

托管 Compose App 的配置状态与 Engine readiness 也应分开判断。数据库和 Compose CLI 可用时，即使 Engine 离线或 Docker 管理关闭，仍可查看、创建、验证和编辑 App；部署、Down、Restart、Pull 及删除前容器检查需要 Engine。`needsDeploy` 比较当前 revision 与最近成功完成的全项目 Compose Up revision；Pull、Restart 和 Down 不会清除它。每次 action 都携带当前 revision，执行前发生漂移会返回 `409`，必须刷新后重试。

## Docker 资源与镜像占用

Engine ready 不代表内核支持全部资源控制。资源区和创建向导显示 CPU quota/shares、cpuset、内存、swap、PID 能力的可用、不支持、未知状态；只有明确可用的限制才能填写和提交。内存统计可能为 `null`，不应推断容器停止或使用量为零。CM5 上的缺失能力需要单独检查内核/cgroup 配置，不能靠填写容器内存值解决，也不会由 CyberOS 自动修改启动参数或重启设备。

镜像占用按容器 ImageID 统计，包括停止的容器；镜像 tag 变化不解除引用。ImageID 元数据不完整时保留 Engine 的计数，未知计数会禁用 UI 删除。服务端删除仍重新检查实时容器引用，Engine 的最终非强制删除是并发变化时的保护边界。
