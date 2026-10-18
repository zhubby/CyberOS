---
title: HTTP、SSE 与 WebSocket 参考
description: API 传输面、端点分组和稳定契约。
type: reference
status: current
audience: [developer]
sourceOfTruth: [apps/api/src/routes/index.ts, apps/api/src/routes/files.ts, apps/api/src/routes/photos.ts, apps/api/src/routes/sessions.ts, apps/api/src/routes/downloads.ts, apps/api/src/routes/docker.ts, apps/api/src/routes/shares.ts, apps/api/src/routes/system.ts, apps/api/src/routes/terminal.ts, apps/api/src/routes/monitoring.ts, apps/api/src/lib/docker-daemon.ts, apps/api/src/lib/docker-registry.ts, apps/api/src/lib/network-manager.ts, apps/api/src/lib/ethernet-manager.ts, apps/web/src/api.ts]
sidebar:
  order: 2
---

REST 路由按 roots、files/search、photos、sessions/jobs/events、approvals/operations、indexer/readiness/health、monitoring、backup、settings、system、storage、shares、Docker、VM 和 terminal 分组。

Agent 事件通过 session SSE stream 传递；terminal、Docker console 和 VM console 使用 WebSocket。写操作的 approval 要求以 route 实现和 `packages/shared/src/types.ts` 为准；本页不复制易漂移的完整 JSON schema。

## Monitoring

- `GET /api/monitoring/overview` 返回 `disabled | starting | ready | degraded | unavailable`、最新核心值、collector 状态，以及 raw/1m/1h 保留期、数据库大小和是否暂停写入。
- `GET /api/monitoring/catalog` 返回固定指标定义、类型、base unit、允许标签及当前已存在序列。客户端不能提交任意指标名或标签。
- `POST /api/monitoring/query` 接收 ISO `start/end`、最多 12 个 `selectors` 和 `maxPoints`（2–720）。selector 包含 `metric`、可选的允许标签和 `value | rate`；`rate` 只适用于 counter。响应按序列给出实际 `raw | 1m | 1h` resolution、step 和有序点，缺口值为 `null`。

查询范围最多 366 天。无数据或监控关闭返回成功空结果；非法范围、指标、标签、转换或上限返回 `400`；指标库不可读时返回不包含路径或 SQLite 内部信息的 `503`。现有 `/api/system/network/traffic` 契约保持不变。

## Photos

- `GET/PUT /api/photos/settings` 读取或设置唯一照片库。设置请求必须携带 `rootId`、`storagePoolId` 和池内现有目录；变更后旧索引失效并排队完整扫描。
- `GET/PATCH /api/settings/photos` 读取或更新处理并发、扫描周期、自动重试、命令超时、大小/像素限制、scratch 上限和最低剩余空间。
- `GET /api/photos` 使用不透明 cursor 返回按 `takenAt DESC, id DESC` 稳定排序的页面；`GET /api/photos/status` 返回 `unconfigured/queued/discovering/processing/retrying/ready/degraded/offline` 状态与 worker health，`POST /api/photos/scans` 排队手动扫描。
- `POST /api/photos/query` 接收最多 64 KiB、25 个高级条件，支持文本、日期、媒体类型、相机、镜头、曝光、评分、关键词、位置和任意标量字段。排序 cursor 绑定查询指纹；响应包含精确总数、元数据升级进度、排除自身条件的分类分面和当前结果的数值范围。
- `GET /api/photos/metadata/fields` 返回可查询字段目录；`GET /api/photos/:id/metadata` 默认排除 GPS、设备/镜头序列号、联系信息和人物区域，只有显式 `includeSensitive=1` 才返回敏感组。
- `POST /api/photos/map/query` 在视口内返回最多 4096 个本地聚合点。地理查询先用 RTree 缩小候选，再用规范坐标或 Haversine 精确计算，支持反经线；距离排序必须提供附近查询中心。
- `GET /api/photos/map/settings` 返回固定 Natural Earth II 3.2.0 资产信息及 `not_downloaded/downloading/ready/failed`、已下载字节、总字节和错误；`POST /api/photos/map/download` 无请求体，幂等启动或返回当前下载任务。客户端不能提交 URL 或文件路径，旧 `PUT /api/photos/map/settings` 不再存在。
- `GET /api/photos/map/archive` 只在托管文件通过固定大小、SHA-256 和 PMTiles JPEG 头校验后提供 Range/`206`。下载使用同目录临时文件并原子发布到 `${ZOS_ROOT}/state/photostaff/maps/natural-earth-ii-3.2.0.pmtiles`；中断或失败会删除临时文件，重试从零开始。
- `GET /api/photos/:id/thumbnail|preview|original` 只解析当前照片库中的资源。缩略图和预览来自 data directory 的 hash-addressed WebP cache；GIF preview 保留动画原文件，视频 preview 是首帧海报。
- `GET /api/photos/:id/video` 为视频资源提供带 Range 的播放流；MP4/WebM 直接流式返回，其他支持容器通过 FFmpeg 缓存为 MP4。
- `PUT /api/photos/upload` 使用 `application/octet-stream`，查询参数传文件名和可选目录。媒体限制 512 MiB、原子发布并按 SHA-256 拒绝当前库中的重复内容；XMP sidecar 限制 16 MiB。
- Photos 支持图片 `.jpg`、`.jpeg`、`.png`、`.webp`、`.gif`、`.heic`、`.heif`，视频 `.mp4`、`.mov`、`.m4v`、`.avi`、`.mkv`、`.webm`、`.mpeg`、`.mpg`，以及 RAW `.cr2`、`.cr3`、`.crw`、`.nef`、`.nrw`、`.arw`、`.srf`、`.sr2`、`.dng`、`.raf`、`.orf`、`.rw2`、`.pef`、`.rwl`、`.3fr`、`.x3f`、`.erf`、`.kdc`、`.mos`、`.mrw`、`.bay`。
- `POST /api/photos/exports` 为单张原图或最多 100 张照片的短时 ZIP 创建下载地址；ZIP 会去重并包含关联 XMP，单张 original 仍只返回原媒体字节，token 使用一次后失效。
- `POST /api/photos/proposals` 为最多 100 张照片创建一组 move 或 trash 文件提案，并去重加入关联 XMP。目标必须仍在照片库内，执行前继续走现有 approval，不提供绕过入口。

JPEG、PNG、WebP、GIF、HEIC、HEIF、常见视频和 RAW 由内部 Rust `photostaff` 服务处理；`photostaff` 仅是模块和进程标识，公开产品与 HTTP 契约统一使用 Photos。ExifTool 提取 EXIF/IPTC/XMP/ICC/JFIF/RAW 标量，视频使用 `ffprobe`，libvips CLI 生成 WebP；同目录精确媒体名和同 stem XMP 按确定性规则关联，大小写冲突标记为 ambiguous。源文件由 storage-pool dirfd 与 `openat2` 打开后以继承 fd 交给子工具，发布使用空间预留、文件/目录 sync 和 journal。原图、视频流和文件变更每次访问都重新经过 root、storage pool、挂载、遍历和 symlink 校验；当前配置版本的缓存 WebP 缩略图与预览可以在存储池离线时继续读取。不要把索引记录当成原文件存在性的授权依据。

## 系统电源

- `POST /api/system/power` 接收 `{ action: "reboot" | "shutdown", confirmed: true }`。请求通过 hostd 转交 systemd 正常停止服务、同步并卸载文件系统，成功排队返回 `202` 与 `{ result: { action, accepted: true } }`。
- API 不直接运行电源命令，也不在 hostd 不可用时降级执行。缺少确认或动作不受支持返回 `400`，hostd/系统服务不可用返回对应安全错误，且不接受任意命令、参数或 unit 名称。

## 物理有线网口

- `GET /api/system/network/ethernet` 返回按永久 MAC 标识的物理 Ethernet 设备、当前连接、活动与期望配置、接管状态、revision、待应用标记及当前应用事务。虚拟接口、Bond、Bridge、VLAN 和 controller port 不进入托管列表。
- 状态会警告没有默认路由的地址族，以及位于同一子网但默认路由设置不对称的多个端口；后者允许保存，但响应流量可能从不同网口发出。高级或在读取后发生漂移的外部 profile 保持只读，不会被托管配置静默覆盖。
- `PUT /api/system/network/ethernet/:id` 只保存期望配置，不改动实时网络；请求携带 `expectedRevision`。IPv4 支持关闭、DHCP、静态，IPv6 支持关闭、自动、静态；每族最多三个 DNS，默认路由 metric 为 `1..65535`，同族默认路由不能使用相同 metric。
- `POST /api/system/network/ethernet/apply` 要求 `confirmed: true`，一次应用所有待生效网口并返回 `202`。成功后进入 90 秒确认窗口；`POST .../apply/:transactionId/confirm` 保留配置，`POST .../rollback` 立即恢复。
- `GET /api/system/network/ethernet/events` 立即发送 `system.ethernet.status`，每秒采样、仅变化时推送、每 15 秒 heartbeat，并给出 2 秒重连提示。断线后的旧状态不是实时状态。
- 应用使用 NetworkManager D-Bus checkpoint。超时、手工回滚、校验失败或 hostd 重启会恢复托管 keyfile 和运行连接。输入错误为 `400`，设备不存在为 `404`，revision、外部 profile 漂移或事务冲突为 `409`，应用/回滚失败为 `502`，NetworkManager、hostd 或 `busctl` 不可用为 `503`。

## Wi-Fi 与热点

- `GET /api/system/network` 同时返回内核接口/路由和 NetworkManager 无线摘要。`capabilities.backend` 为 `NetworkManager`、`systemd-networkd` 或 `unknown`；只有 NetworkManager 与 hostd 同时可用时才开放写操作。
- `POST /api/system/network/wifi/scan|connect|disconnect` 分别扫描、连接和断开；`PUT /api/system/network/wifi/radio` 切换全局 Wi-Fi radio。
- `PATCH/DELETE /api/system/network/wifi/profiles/:id` 只允许修改或遗忘 ZOS 创建的 profile。外部 profile 可以通过 `connect` 使用，但更新或删除返回 `409`。
- `PUT /api/system/network/wifi/hotspot` 保存 WPA2 热点；`POST .../hotspot/start|stop` 启停，`DELETE .../hotspot` 删除。热点使用 NetworkManager `ipv4.method=shared`，没有默认上行时仍提供本地网络。
- `GET /api/system/network/wifi/events` 是状态 SSE：立即发送 `system.wifi.status`，每秒采样、仅变化时推送，每 15 秒 heartbeat，重连提示 2 秒。扫描结果不进入 SSE。

写请求最多 64 KiB。SSID 为 1–32 字节；Personal 密码为 8–63 个可打印字符或 64 位十六进制。首期新连接只支持开放、WPA2 Personal 和 WPA3 Personal；WEP、802.1X 和隐藏网络返回 `400`。管理链路切换及破坏性操作要求 `confirmed: true`，它表示 UI 已完成二次确认而不是身份认证。

输入错误为 `400`，缺少设备/profile 为 `404`，外部配置或 revision 冲突为 `409`，NetworkManager 操作或恢复失败为 `502`，后端、hostd 或依赖不可用为 `503`。所有公开响应、日志和通知禁止包含 Wi-Fi 或热点密码。

## Terminal 标签与 WebSocket

- `GET /api/terminal/tabs?rootId=...` 返回指定 NAS root 的初始化状态、按创建顺序排列的标签、活动标签 ID 和整机会话上限。
- `POST /api/terminal/tabs/initialize` 接收 `rootId` 和可选的旧 `legacySessionId`，事务性地完成首次创建或旧会话导入；重复请求不会重复创建同一旧会话。
- `POST /api/terminal/tabs` 新建并激活标签；`PATCH /api/terminal/tabs/:id` 更新可空自定义名称；`POST /api/terminal/tabs/:id/activate` 更新整机共享的活动项。
- `POST /api/terminal/tabs/:id/restart` 销毁对应 tmux shell 但保留标签；`DELETE /api/terminal/tabs/:id` 先销毁 shell，再删除标签。销毁失败返回 `503` 且不修改标签元数据，客户端可以重试。

标签 ID 和旧会话 ID 必须是 UUID；名称去除首尾空格后为 1–64 个字符，也可传 `null` 恢复默认名称。无效 root、ID 或名称返回 `400/404`，会话上限或旧 ID 冲突返回 `409`。删除活动标签时优先激活右侧标签，其次左侧；删除最后一个标签后活动项为 `null`。

`GET /api/terminal?rootId=...` 使用 `zos-terminal-v1` 和 `zos-session.<uuid>` WebSocket subprotocol。已登记标签通过 Termux Protocol v1 以 persistent 模式打开；未登记 ID 保持旧客户端兼容并按空闲策略回收。一个标签只允许一个控制连接，新连接建立后旧连接收到 `{ "type": "taken_over" }`。内部 `session.open` 请求的 `persistent` 字段可选，省略时等同旧版非持久会话。

## 共享账号

- `PUT /api/shares/account` 直接更新 SMB、WebDAV 和 FTP 共用账号，不创建 approval、job 或 operation。请求包含 `username`、可选的新 `password` 和当前 `expectedUpdatedAt`；省略密码或传空字符串表示保留已有密码。
- API 串行执行所有共享配置写入，先通过受限 hostd 应用完整当前配置，成功后才更新数据库。revision 不匹配返回 `409`，输入错误返回 `400`，hostd 不可用返回 `503`，宿主应用失败返回脱敏后的 `502`。
- 响应只返回公开共享设置和 hostd 应用时间，密码永不回传。共享目录、协议、权限和全局启停仍通过 `POST /api/shares/proposals` 进入原有审批流程；审批执行时使用数据库中的最新账号，不能覆盖之后直接修改的凭证。

## HTTP 下载

- `POST /api/downloads` 接收 HTTP/HTTPS 地址、`rootId`、`storagePoolId`、目标目录、文件名和可选的 64 位 `sha256`；SHA-256 会归一化为小写。只接受无凭据的公网下载地址，目标同名或重复任务返回 `409`。
- `GET /api/downloads` 返回全局历史和 downloader worker health；任务记录包含 phase、单流/分段模式、checksum、稳定错误码、重试计数/时间、控制请求和分段数。`GET /api/downloads/events` 用 SSE 推送相同快照。
- `POST /api/downloads/:id/pause|cancel` 对运行任务写入协作式控制请求；`resume|retry` 按状态重新排队。发布已完成原子 rename 时最终状态始终为 `completed`。`DELETE /api/downloads/:id` 只移除非运行任务。
- `GET/PATCH /api/settings/downloads` 管理任务并发、每任务 Range 并发、分段阈值、自动重试/退避、连接/响应头/空闲读取超时、最低剩余空间和可选最大文件大小。旧的 `{ concurrency }` 设置会自动补齐默认值。
- Rust `zos-downloader.service` 从 SQLite 领取带 30 秒租约的任务，每 5 秒写 worker/任务心跳。服务使用逐跳 DNS 公网校验、固定地址、最多五次安全重定向、持久化分段、空间预留、dirfd/`openat2` 路径边界、SHA-256 和 publish journal；崩溃或掉电后不会覆盖 identity 不匹配的用户文件。

## Docker daemon

- `GET /api/docker/daemon/config` 返回固定路径、正文、内容 revision、文件是否存在和是否等待重启。
- `PUT /api/docker/daemon/config` 接收 `content`、`expectedRevision`、`restart` 和 `confirmed`。正文最多 256 KiB；revision 冲突返回 `409`，JSON 或 dockerd 校验失败返回 `400`，hostd 不可用返回 `503`，重启或回滚异常返回 `502` 并携带回滚结果。
- `GET /api/docker/daemon/events` 是独立 SSE stream。连接后立即发送 `docker.daemon.status`，服务端每秒采样 `docker.service`、仅在状态变化时推送，并每 15 秒发送 heartbeat。客户端重连提示为 2 秒。

配置正文、代理凭据和恢复基线不得写入日志或通知。`confirmed: true` 表示 UI 已完成二次确认，不是身份认证机制。

## Docker 镜像与 Registry

- `GET /api/docker/summary` 的 `images` 来自与镜像计数相同的一次 Engine 查询，包含 ID、tags、digests、创建时间、大小、共享大小和容器引用数。容器列表包含 `imageId`；元数据完整时，引用数按 ImageID 汇总全部容器（包括已停止容器），不按可变 tag 匹配。旧 Engine/适配器未提供完整 ImageID 时保留 Engine 计数，未知为 `null`，不是零。
- `POST /api/docker/images/pull` 接收 `reference`，同步等待 Engine 完成拉取。ZOS 按镜像引用选择匹配凭证，没有匹配项时匿名拉取。
- `POST /api/docker/images/remove` 接收 `reference` 和 `confirmed: true`。删除固定使用 `force=false`、`noprune=true`；被容器引用或存在多引用冲突时返回 `409`，不创建 approval 或 Docker operation。
- `GET /api/docker/registries` 返回凭证摘要；`POST /api/docker/registries`、`PATCH /api/docker/registries/:id`、`DELETE /api/docker/registries/:id` 管理单条记录。创建/更新正文最多 64 KiB，所有响应只包含 `credentialConfigured`，不会返回密码或 access token。

Registry 地址只接受 hostname/IP 和可选端口；Docker Hub 别名归一化为 `docker.io`。未限定 Registry 的镜像和 Docker Hub 别名匹配 `docker.io`；包含点号、端口、`localhost` 或 IP 的首段按私有 Registry 精确匹配。无效地址/引用返回 `400`，重复 Registry 或镜像占用返回 `409`，不存在返回 `404`，Engine 不可用返回脱敏后的 `502`。Registry CRUD 不依赖 Docker 管理开关或 Engine 状态。

## Docker 托管 Compose Apps

- `GET /api/docker/apps` 返回托管 App 摘要；`GET /api/docker/apps/:id` 额外返回 Compose YAML 和仅含键名/`valueConfigured` 的环境变量摘要，永不返回环境变量值。
- `POST /api/docker/apps/validate` 在隔离临时目录执行结构化 YAML 检查和 `docker compose config`。编辑已有 App 时可携带 `appId`、`expectedRevision`，环境变量省略 `value` 表示沿用数据库中的值。
- `POST /api/docker/apps`、`PUT /api/docker/apps/:id` 分别创建和更新 App；更新必须提供 `expectedRevision`。`projectKey` 创建后不可修改，托管路径固定为 `/zos/apps/<project-key>`。
- `DELETE /api/docker/apps/:id` 要求 `expectedRevision` 和 `confirmed: true`。Engine 不可查询或仍存在相同 Compose project label 的容器时拒绝删除；删除不会移除 images、named volumes、networks 或 NAS 数据。

App 请求正文最多 512 KiB。非法 YAML、保留环境变量、本地 `build/env_file/include` 等额外文件依赖、相对 bind mount 或越过在线 NAS root 的绝对 bind mount 返回 `400`；revision/project key 冲突返回 `409`，Compose CLI 不可用返回 `503`，运行副本发布失败返回 `502`。创建和编辑不依赖 Engine readiness；部署仍通过 `/api/docker/proposals` 的 Compose Up approval。proposal 只保存 App ID、名称、revision、服务与风险，不保存 YAML、托管路径或秘密。

## Docker 资源限制

`summary.engine.resourceCapabilities` 包含可空布尔字段 `memoryLimit`、`swapLimit`、`cpuQuota`、`cpuShares`、`cpuset`、`pidsLimit`，来自 Engine `/info`。CPU quota 要求 `CpuCfsQuota` 和 `CpuCfsPeriod` 同时为真；缺失或非布尔属性作为未知处理。

容器创建只接受宿主机明确支持的非空限制。内存硬限制和 reservation 要求 `memoryLimit`；swap 要求内存与 swap 均可用；CPU、cpuset、PID 限制要求各自能力。显式不支持或未知时返回 `400`，不创建容器、approval 或 operation。留空表示不请求该限制，仍可创建容器；不要把缺失内存统计解释成零使用量。
