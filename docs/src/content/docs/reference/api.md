---
title: HTTP、SSE 与 WebSocket 参考
description: API 传输面、端点分组和稳定契约。
type: reference
status: current
audience: [developer]
sourceOfTruth: [packages/api/src/routes/index.ts, packages/api/src/routes/files.ts, packages/api/src/routes/photos.ts, packages/api/src/routes/sessions.ts, packages/api/src/routes/downloads.ts, packages/api/src/routes/docker.ts, packages/api/src/routes/shares.ts, packages/api/src/routes/settings.ts, packages/api/src/routes/agent-resources.ts, packages/api/src/routes/system.ts, packages/api/src/routes/terminal.ts, packages/api/src/routes/monitoring.ts, packages/api/src/routes/monitoring-alerts.ts, packages/api/src/routes/notifications.ts, packages/api/src/lib/agent-mcp-settings.ts, packages/api/src/lib/agent-mcp-service.ts, packages/api/src/lib/agent-skills.ts, packages/api/src/lib/docker-daemon.ts, packages/api/src/lib/docker-registry.ts, packages/api/src/lib/network-manager.ts, packages/api/src/lib/ethernet-manager.ts, packages/web/src/api.ts]
sidebar:
  order: 2
---

REST 路由按 storage pools、files/search、Photos、sessions/jobs/events、capability approvals/operations、indexer/health、monitoring、backup、settings、system、shares、Docker、VM、media、downloads、Bluetooth transfers 和 terminal 分组。

Agent 事件通过 session SSE stream 传递；terminal、Docker console 和 VM console 使用 WebSocket。Agent/MCP mutation 统一走 capability run/approval；第一方 Web mutation 使用页面确认、服务端校验和领域 operation 审计，不创建 capability approval。本页不复制易漂移的完整 JSON schema。

## Pi Agent、MCP 与 Skills

- `GET/PATCH /api/settings/agent-capability-policy` 管理 Pi Agent 每项 CyberOS capability 的自动、审批、二次确认和禁用策略。
- `GET /api/settings/mcp` 返回内置 MCP、第三方 Streamable HTTP Server 的脱敏状态及共享 generation；`PATCH /api/settings/mcp/servers/builtin` 只允许启停内置 MCP。
- `POST /api/settings/mcp/servers` 与 `PATCH/DELETE /api/settings/mcp/servers/:id` 管理第三方 Server。`POST .../:id/test` 完成工具发现并建立信任；测试成功且凭据就绪后才能启用。
- `PUT/DELETE /api/settings/mcp/servers/:id/credentials` 管理受限 secret 文件。响应只返回 `credentialsConfigured` 和 Header 名称，不返回 Bearer Token 或 Header 值。
- `GET /api/settings/skills?sessionId=...` 分开返回全局 Skills 与当前项目只读 Skills。`POST .../import` 从 storage pool ZIP 安装，`POST .../install-git` 从公开 HTTPS Git 安装；`PATCH/DELETE .../:id` 和 `POST .../:id/update` 负责启停、删除和 Git 更新。

第三方只支持 MCP Streamable HTTP，不支持旧 SSE 或 stdio。第三方工具调用按用户信任直接执行，不创建逐次 CyberOS capability approval；Server 配置和 Skill 安装仍要求高风险确认。

## Docker 与虚拟机开关

- `GET/PATCH /api/settings/docker` 管理 CyberOS 的 Docker 能力开关，PATCH 只接受 `{ enabled: boolean }`。Engine socket、Compose 命令、操作超时和控制台 shell 是固定运行时常量。运行时由安装器预先安装；关闭开关后 Docker API 与 Agent/MCP mutation 不可用。
- `GET/PATCH /api/settings/vm` 管理独立的虚拟机能力开关，PATCH 只接受 `{ enabled: boolean }`。运行时由安装器预先安装；该值动态控制 VM 页面、API 与 Agent/MCP capability。
- `GET /api/vms/summary` 在开关关闭时返回 `enabled: false` 与 `host.status: "disabled"`，不把未探测的 KVM 状态报告成宿主机故障。

## Monitoring

- `GET /api/monitoring/overview` 返回 `disabled | starting | ready | degraded | unavailable`、最新核心值、collector 状态，以及 raw/1m/1h 保留期、数据库大小和是否暂停写入。
- `GET /api/monitoring/catalog` 返回固定指标定义、类型、base unit、允许标签及当前已存在序列；每条序列包含 `active` 和 `lastSampleAt`，历史序列不会冒充当前可用数据。客户端不能提交任意指标名或标签。
- `POST /api/monitoring/query` 接收 ISO `start/end`、最多 12 个 `selectors` 和 `maxPoints`（2–720）。selector 包含 `metric`、可选的允许标签和 `value | rate`；`rate` 只适用于 counter。响应按序列给出实际 `raw | 1m | 1h` resolution、step 和有序点，缺口值为 `null`。

查询范围最多 366 天。无数据或监控关闭返回成功空结果；非法范围、指标、标签、转换或上限返回 `400`；指标库不可读时返回不包含路径或 SQLite 内部信息的 `503`。现有 `/api/system/network/traffic` 契约保持不变。

## Monitoring alerts

- `/api/monitoring/alerts/rules`、`contacts`、`groups`、`schedules`、`policies` 和 `silences` 提供受控告警配置 CRUD；更新和删除必须携带整数 `expectedRevision`，过期 revision 返回 `409`。组成员、值班成员和策略阶段按聚合根在一个事务中替换。规则响应通过 `evaluationError` 和 `lastEvaluatedAt` 暴露最近一次求值状态。
- `/api/monitoring/alerts/incidents` 提供 firing/resolved 事件及独立的 `read`、`read-all`、`acknowledge` 动作。列表可用 `groupHealth=true` 按 health series 合并重复 episode，并通过 `occurrenceCount` 返回次数；读取其中一条会读掉同 series 的历史 episode。单条详情额外返回 timeline、规则/策略快照和 delivery 状态。acknowledge 取消未发送和后续升级邮件，但不会把 firing 改为 resolved。
- `/api/monitoring/alerts/smtp` 只返回 `credentialConfigured`，不返回密码。只有已保存且启用、host/from 完整的 SMTP 配置才能调用 `POST .../test-email`，否则返回 `409`；成功请求通过同一 outbox 返回 `202 + deliveryId`，客户端用 delivery endpoint 查询异步结果。
- `/api/monitoring/alerts/health-routing` 把 warning/critical Health incident 绑定到可选升级策略；站内 incident 不依赖邮件路由。
- `GET /api/notifications/summary` 返回 Operations 与 Alerts 的独立和合并未读数。现有 `/api/notifications` 列表及 read 合同不变。

规则只接受 catalog 中的 metric/labels、固定窗口 `1m/5m/15m/30m/1h`、`value | rate`、`last | avg | min | max` 和 `> >= < <=`。输入错误返回 `400`，资源不存在返回 `404`，revision 冲突返回 `409`。summary 返回 `lastEvaluationAt`；超过 30 秒没有成功求值时 `alerterStatus` 为 `unavailable`。SMTP 测试 API 不直接建立第二条邮件发送路径。

## Photos

- `GET/PUT /api/photos/settings` 读取或设置唯一照片库。设置请求必须携带 `storagePoolId` 和池内现有目录；变更后旧索引失效并排队完整扫描。
- `GET/PATCH /api/settings/photos` 读取或更新处理并发、扫描周期、自动重试、命令超时、大小/像素限制、scratch 上限和最低剩余空间。
- `GET /api/photos` 使用不透明 cursor 返回按 `takenAt DESC, id DESC` 稳定排序的页面；`GET /api/photos/status` 返回 `unconfigured/queued/discovering/processing/retrying/ready/degraded/offline` 状态与 worker health，`POST /api/photos/scans` 排队手动扫描。
- `POST /api/photos/query` 接收最多 64 KiB、25 个高级条件，支持文本、日期、媒体类型、相机、镜头、曝光、评分、关键词、位置和任意标量字段。排序 cursor 绑定查询指纹；响应包含精确总数、元数据升级进度、排除自身条件的分类分面和当前结果的数值范围。
- `GET /api/photos/metadata/fields` 在独立只读工作线程中返回可查询字段目录，避免大库聚合阻塞状态与健康检查；只合并同时进行的相同查询，不缓存已完成结果；`GET /api/photos/:id/metadata` 默认排除 GPS、设备/镜头序列号、联系信息和人物区域，只有显式 `includeSensitive=1` 才返回敏感组。
- `POST /api/photos/map/query` 在视口内返回最多 4096 个本地聚合点。地理查询先用 RTree 缩小候选，再用规范坐标或 Haversine 精确计算，支持反经线；距离排序必须提供附近查询中心。
- `GET /api/photos/map/settings` 返回固定 Natural Earth II 3.2.0 资产信息及 `not_downloaded/downloading/ready/failed`、已下载字节、总字节和错误；`POST /api/photos/map/download` 无请求体，幂等启动或返回当前下载任务。客户端不能提交 URL 或文件路径，旧 `PUT /api/photos/map/settings` 不再存在。
- `GET /api/photos/map/archive` 只在托管文件通过固定大小、SHA-256 和 PMTiles JPEG 头校验后提供 Range/`206`。下载使用同目录临时文件并原子发布到 `${CYBEROS_ROOT}/state/photos/maps/natural-earth-ii-3.2.0.pmtiles`；中断或失败会删除临时文件，重试从零开始。
- `GET /api/photos/:id/thumbnail|preview|original` 只解析当前照片库中的资源。缩略图和预览来自 data directory 的 hash-addressed WebP cache；GIF preview 保留动画原文件，视频 preview 优先使用一秒处海报，没有可用输出时回退首帧。
- `GET /api/photos/:id/video` 为视频资源提供带 Range 的播放流；MP4/WebM 直接流式返回，其他支持容器通过 FFmpeg 缓存为 MP4。
- `PUT /api/photos/upload` 使用 `application/octet-stream`，查询参数传文件名和可选目录。媒体限制 512 MiB、原子发布并按 SHA-256 拒绝当前库中的重复内容；XMP sidecar 限制 16 MiB。
- Photos 支持图片 `.jpg`、`.jpeg`、`.png`、`.webp`、`.gif`、`.heic`、`.heif`，视频 `.mp4`、`.mov`、`.m4v`、`.avi`、`.mkv`、`.webm`、`.mpeg`、`.mpg`，以及 RAW `.cr2`、`.cr3`、`.crw`、`.nef`、`.nrw`、`.arw`、`.srf`、`.sr2`、`.dng`、`.raf`、`.orf`、`.rw2`、`.pef`、`.rwl`、`.3fr`、`.x3f`、`.erf`、`.kdc`、`.mos`、`.mrw`、`.bay`。
- `POST /api/photos/exports` 为单张原图或最多 100 张照片的短时 ZIP 创建下载地址；ZIP 会去重并包含关联 XMP，单张 original 仍只返回原媒体字节，token 使用一次后失效。
- `POST /api/photos/actions` 对最多 100 张照片执行 move 或 trash，并去重加入关联 XMP。目标必须仍在照片库内；第一方页面先完成显式确认，API 重新校验资源与路径并为每个结果写入文件 operation。

JPEG、PNG、WebP、GIF、HEIC、HEIF、常见视频和 RAW 由内部 Rust `photos` 服务处理；`photos` 仅是模块和进程标识，公开产品与 HTTP 契约统一使用 Photos。ExifTool 提取 EXIF/IPTC/XMP/ICC/JFIF/RAW 标量，视频使用 `ffprobe`，libvips CLI 生成 WebP；同目录精确媒体名和同 stem XMP 按确定性规则关联，大小写冲突标记为 ambiguous。源文件由 storage-pool dirfd 与 `openat2` 打开后以继承 fd 交给子工具，发布使用空间预留、文件/目录 sync 和 journal。原图、视频流和文件变更每次访问都重新经过 storage pool、挂载、遍历和 symlink 校验；当前配置版本的缓存 WebP 缩略图与预览可以在存储池离线时继续读取。不要把索引记录当成原文件存在性的授权依据。

支持的扩展名用于选择媒体大类，验证内容属于同一大类后按 MIME 选择图像解码器；JPEG 内容即使命名为 `.HEIC` 也不调用 HEIF 解码器。GIF 尺寸读取 ExifTool 的 GIF 分组并应用相同像素上限。视频海报必须是非空普通文件才进入衍生图处理；回退首帧不放宽子进程资源、源文件或尺寸限制。

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
- `PATCH/DELETE /api/system/network/wifi/profiles/:id` 只允许修改或遗忘 CyberOS 创建的 profile。外部 profile 可以通过 `connect` 使用，但更新或删除返回 `409`。
- `PUT /api/system/network/wifi/hotspot` 保存 WPA2 热点；`POST .../hotspot/start|stop` 启停，`DELETE .../hotspot` 删除。热点使用 NetworkManager `ipv4.method=shared`，没有默认上行时仍提供本地网络。
- `GET /api/system/network/wifi/events` 是状态 SSE：立即发送 `system.wifi.status`，每秒采样、仅变化时推送，每 15 秒 heartbeat，重连提示 2 秒。扫描结果不进入 SSE。

写请求最多 64 KiB。SSID 为 1–32 字节；Personal 密码为 8–63 个可打印字符或 64 位十六进制。首期新连接只支持开放、WPA2 Personal 和 WPA3 Personal；WEP、802.1X 和隐藏网络返回 `400`。管理链路切换及破坏性操作要求 `confirmed: true`，它表示 UI 已完成二次确认而不是身份认证。

输入错误为 `400`，缺少设备/profile 为 `404`，外部配置或 revision 冲突为 `409`，NetworkManager 操作或恢复失败为 `502`，后端、hostd 或依赖不可用为 `503`。所有公开响应、日志和通知禁止包含 Wi-Fi 或热点密码。

## Terminal 标签与 WebSocket

- `GET /api/terminal/tabs` 返回全局终端工作区的初始化状态、按创建顺序排列的标签、活动标签 ID 和整机会话上限。
- `POST /api/terminal/tabs/initialize` 事务性地完成首次 tab 创建；重复请求不会创建额外 tab。
- `POST /api/terminal/tabs` 新建并激活标签；`PATCH /api/terminal/tabs/:id` 更新可空自定义名称；`POST /api/terminal/tabs/:id/activate` 更新整机共享的活动项。
- `POST /api/terminal/tabs/:id/restart` 销毁对应 tmux shell 但保留标签；`DELETE /api/terminal/tabs/:id` 先销毁 shell，再删除标签。销毁失败返回 `503` 且不修改标签元数据，客户端可以重试。

标签 ID 必须是已登记的 UUID；名称去除首尾空格后为 1–64 个字符，也可传 `null` 恢复默认名称。无效 ID 或名称返回 `400/404`，会话上限返回 `409`。删除活动标签时优先激活右侧标签，其次左侧；删除最后一个标签后活动项为 `null`。

`GET /api/terminal` 只接受 `cyberos-terminal-v1` 和 `cyberos-session.<registered-tab-uuid>` WebSocket subprotocol，并以 `/cyberos/data` 作为全局工作区。不接受 query 参数、临时 session 或未登记 UUID。Terminal Protocol v1 始终以 persistent 模式打开；一个标签只允许一个控制连接，新连接建立后旧连接收到 `{ "type": "taken_over" }`。

## 共享账号

- `PUT /api/shares/account` 直接更新 SMB、WebDAV 和 FTP 共用账号，不创建 approval、job 或 operation。请求包含 `username`、可选的新 `password` 和当前 `expectedUpdatedAt`；省略密码或传空字符串表示保留已有密码。
- API 串行执行所有共享配置写入，先通过受限 hostd 应用完整当前配置，成功后才更新数据库。revision 不匹配返回 `409`，输入错误返回 `400`，hostd 不可用返回 `503`，宿主应用失败返回脱敏后的 `502`。
- 响应只返回公开共享设置和 hostd 应用时间，密码永不回传。密码以 `0600` 文件保存到 `/cyberos/state/secrets/share/account-password`，不会写入 SQLite 或 share operation metadata。共享目录、协议、权限和全局启停通过 `POST /api/shares/settings` 直接应用，并写入 share operation；Agent/MCP 发起同类变更时仍由 capability run/approval 调用相同领域校验。

## 下载

- `POST /api/downloads` 接收 HTTP/HTTPS 地址、`storagePoolId`、目标目录、文件名和可选的 64 位 `sha256`；SHA-256 会归一化为小写。只接受无凭据的公网下载地址，目标同名或重复任务返回 `409`。
- `POST /api/downloads/torrent-previews` 接收 JSON Magnet 链接或字段名为 `torrent` 的单个 multipart `.torrent` 文件，上传上限 16 MiB。`GET /api/downloads/torrent-previews/:id` 返回解析状态与文件列表；解析完成后，`POST /api/downloads` 使用 `torrentPreviewId`、选中的文件索引、目标目录和输出文件夹名称创建 BT 任务。只支持公网非私有种子；私有种子、危险路径、本地/私网 tracker 与电驴链接均不接受。
- `GET /api/downloads` 返回全局历史和 downloader worker health；任务记录包含 phase、单流/分段/BT 模式、checksum、稳定错误码、重试计数/时间、控制请求、上传字节/速率、peer 数和做种时间。`GET /api/downloads/:id/files` 返回 BT 文件级进度，`GET /api/downloads/events` 用 SSE 推送任务快照。
- `POST /api/downloads/:id/pause|cancel` 对下载任务写入协作式控制请求；做种任务可暂停，`POST /api/downloads/:id/stop-seeding` 手动结束做种，`resume|retry` 按状态重新排队。发布已完成原子 rename 时最终内容不会被停止做种或暂停删除。`DELETE /api/downloads/:id` 只移除非运行、非做种任务。
- `GET/PATCH /api/settings/downloads` 管理 HTTP 任务并发、每任务 Range 并发、分段阈值、自动重试/退避、连接/响应头/空闲读取超时、最低剩余空间和可选最大文件大小。BT 使用独立的单下载槽；已完成内容不占该槽，默认做种到分享率 1.0 或 2 小时，以先到者为准。
- Rust `cyberos-downloader.service` 从 SQLite 领取带 30 秒租约的任务。HTTP 使用逐跳 DNS 公网校验、固定地址、安全重定向、持久化分段、空间预留、dirfd/`openat2` 路径边界、SHA-256 和 publish journal。BT 使用内嵌 `librqbit`，关闭 WebUI、HTTP API、持久化和 UPnP，在隐藏目录续传并以不覆盖 rename 发布；SQLite 始终是任务事实源，崩溃后未发布内容从暂存目录恢复，已发布内容从最终目录恢复做种。

## Docker daemon

- `GET /api/docker/host-access` 返回固定 Host Access 策略版本、能力目录、coverage、运行环境 availability 和可选 storage pools，不返回受管宿主路径或审批指纹。非法目标与冲突返回 `400`，revision/image/resource 漂移返回 `409`，受限代理或宿主依赖不可用返回 `503`。
- Compose validate/create/update 与单容器 create 可选接收 `hostAccess`；省略表示不请求宿主观测授权。单容器创建会在执行前解析不可变 image ID 并重新校验授权策略；Compose action 使用短时私有 draft 固定 image 与资源指纹，不创建 capability approval。

- `GET /api/docker/daemon/config` 返回固定路径、正文、内容 revision、文件是否存在和是否等待重启。
- `PUT /api/docker/daemon/config` 接收 `content`、`expectedRevision`、`restart` 和 `confirmed`。正文最多 256 KiB；revision 冲突返回 `409`，JSON 或 dockerd 校验失败返回 `400`，hostd 不可用返回 `503`，重启或回滚异常返回 `502` 并携带回滚结果。
- `GET /api/docker/daemon/events` 是独立 SSE stream。连接后立即发送 `docker.daemon.status`，服务端每秒采样 `docker.service`、仅在状态变化时推送，并每 15 秒发送 heartbeat。客户端重连提示为 2 秒。

配置正文、代理凭据和恢复基线不得写入日志或通知。`confirmed: true` 表示 UI 已完成二次确认，不是身份认证机制。

## Docker 镜像与 Registry

- `GET /api/docker/summary` 的 `images` 来自与镜像计数相同的一次 Engine 查询，包含 ID、tags、digests、创建时间、大小、共享大小和容器引用数。容器列表始终包含可空 `imageId`；存在 ImageID 时按其汇总全部容器（包括已停止容器），不按可变 tag 匹配。Engine 不能提供可靠计数时返回 `null`，不是零。
- `POST /api/docker/images/pull` 接收 `reference`，同步等待 Engine 完成拉取。CyberOS 按镜像引用选择匹配凭证，没有匹配项时匿名拉取。
- `POST /api/docker/images/remove` 接收 `reference` 和 `confirmed: true`。删除固定使用 `force=false`、`noprune=true`；被容器引用或存在多引用冲突时返回 `409`，不创建 approval 或 Docker operation。
- `GET /api/docker/registries` 返回凭证摘要；`POST /api/docker/registries`、`PATCH /api/docker/registries/:id`、`DELETE /api/docker/registries/:id` 管理单条记录。创建/更新正文最多 64 KiB，所有响应只包含 `credentialConfigured`，不会返回密码或 access token。

Registry 地址只接受 hostname/IP 和可选端口；Docker Hub 别名归一化为 `docker.io`。未限定 Registry 的镜像和 Docker Hub 别名匹配 `docker.io`；包含点号、端口、`localhost` 或 IP 的首段按私有 Registry 精确匹配。无效地址/引用返回 `400`，重复 Registry 或镜像占用返回 `409`，不存在返回 `404`，Engine 不可用返回脱敏后的 `502`。Registry CRUD 不依赖 Docker 管理开关或 Engine 状态。

## Docker 托管 Compose Apps

- `GET /api/docker/apps` 返回托管 App 摘要；`GET /api/docker/apps/:id` 额外返回 Compose YAML 和仅含键名/`valueConfigured` 的环境变量摘要，永不返回环境变量值。
- `POST /api/docker/apps/validate` 在隔离临时目录执行结构化 YAML 检查和 `docker compose config`。编辑已有 App 时可携带 `appId`、`expectedRevision`，环境变量省略 `value` 表示沿用数据库中的值。
- `POST /api/docker/apps`、`PUT /api/docker/apps/:id` 分别创建和更新 App；更新必须提供 `expectedRevision`。`projectKey` 创建后不可修改，托管路径固定为 `/cyberos/apps/<project-key>`。
- `DELETE /api/docker/apps/:id` 要求 `expectedRevision` 和 `confirmed: true`。Engine 不可查询或仍存在相同 Compose project label 的容器时拒绝删除；删除不会移除 images、named volumes、networks 或 NAS 数据。

App 请求正文最多 512 KiB。非法 YAML、保留环境变量、本地 `build/env_file/include` 等额外文件依赖、相对 bind mount 或越过在线 storage pool 的绝对 bind mount 返回 `400`；revision/project key 冲突返回 `409`，Compose CLI 不可用返回 `503`，运行副本发布失败返回 `502`。创建和编辑不依赖 Engine readiness；Up、Down、Restart 和 Pull 由第一方页面确认后直接执行，写入 Docker operation，秘密不进入公开响应或审计 metadata。

## Docker 资源限制

`summary.engine.resourceCapabilities` 包含可空布尔字段 `memoryLimit`、`swapLimit`、`cpuQuota`、`cpuShares`、`cpuset`、`pidsLimit`，来自 Engine `/info`。CPU quota 要求 `CpuCfsQuota` 和 `CpuCfsPeriod` 同时为真；缺失或非布尔属性作为未知处理。

容器创建只接受宿主机明确支持的非空限制。内存硬限制和 reservation 要求 `memoryLimit`；swap 要求内存与 swap 均可用；CPU、cpuset、PID 限制要求各自能力。显式不支持或未知时返回 `400`，不创建容器、approval 或 operation。留空表示不请求该限制，仍可创建容器；不要把缺失内存统计解释成零使用量。
