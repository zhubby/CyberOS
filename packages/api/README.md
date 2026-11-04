# api — Fastify 入口与 NAS 服务编排

`@cyberos/api` 提供 CyberOS 的 HTTP API、SSE、终端 WebSocket、MCP 接入及生产 Web/文档静态资源。它把浏览器请求映射为数据库事务、受限文件操作、持久任务或 Linux 服务调用，并管理进程内的音频、文件批次与监控事件协调器。

生产 API 固定绑定 loopback，经 Nginx 提供 LAN 入口。主机特权操作交给受限的 hostd 等服务执行；API 进程本身使用非 root `cyberos` 身份。

[返回工作空间总览](../README.md) · [包定义](package.json) · [systemd 单元](../../packaging/systemd/cyberos-api.service)

## 架构图

![API 路由、状态存储与 Linux 服务编排架构](docs/architecture.svg)

图展示进程与依赖层级。具体业务路由分别选择读库、排队、文件操作或服务适配器；并非每个请求都会经过图中全部分支。

## 源码导航

| 文件 / 目录 | 职责 |
| --- | --- |
| [src/index.ts](src/index.ts) | runtime、数据库、构建信息、生产适配器、监听与优雅退出 |
| [src/server.ts](src/server.ts) | Fastify 插件、依赖装配、路由注册、MCP、恢复与关闭钩子 |
| [src/context.ts](src/context.ts) | 可注入的业务依赖和路由上下文，支持测试替身 |
| [src/routes/index.ts](src/routes/index.ts) | 业务路由注册清单 |
| [src/routes](src/routes) | 请求校验、协议响应、SSE/WS 与领域入口 |
| [src/lib](src/lib) | Docker、VM、存储、网络、音频、媒体、终端等适配器和协调器 |
| [src/errors.ts](src/errors.ts) | 对外错误处理 |
| [src/web-static.ts](src/web-static.ts) | Web、TV 和文档静态资源路由 |
| [src/state-init.ts](src/state-init.ts) | 安装/服务启动前的持久状态初始化入口 |

## 启动生命周期

1. 加载 runtime，打开 `cyberos.sqlite`，完成格式/schema 检查和相关初始化。
2. 注入 hostd、terminald、视频转码和 TV 模式等生产适配器。
3. `buildServer` 再次验证 loopback，注册限流、multipart、WebSocket 和统一错误处理。CORS 仅在配置了允许来源时注册。
4. 创建 FileBatchRunner、MonitoringReader、MonitoringEventBroker、能力 Adapter 和 AudioCoordinator，注册业务与 MCP 入口。
5. onReady 恢复 capability run，启动文件批次和音频协调器，协调受管 Compose 应用与 host-access 状态。
6. 若找到构建目录，注册 Web/文档静态资源，再开始监听。
7. 收到退出信号后关闭 Fastify、协调器和事件代理，最后关闭数据库。

## 主要业务域

| 领域 | 路由与实现入口 | 关键边界 |
| --- | --- | --- |
| Agent 会话 | [sessions](src/routes/sessions.ts)、[jobs](src/routes/jobs.ts)、[approvals](src/routes/approvals.ts) | 消息/job 入库，worker 异步执行；审批绑定会话与 revision |
| 文件与操作 | [files](src/routes/files.ts)、[operations](src/routes/operations.ts)、[file-batch-runner](src/lib/file-batch-runner.ts) | 存储池边界、授权、批次、回收与回滚记录 |
| 系统与存储 | [system](src/routes/system.ts)、[storage](src/routes/storage.ts)、[iscsi](src/routes/iscsi.ts) | 受限主机调用、挂载身份、破坏性操作确认 |
| 网络与设备 | [tailscale](src/routes/tailscale.ts)、[bluetooth-transfers](src/routes/bluetooth-transfers.ts)、[audio](src/routes/audio.ts) | revision、应用确认与服务状态协调 |
| 容器、VM 与共享 | [docker](src/routes/docker.ts)、[vms](src/routes/vms.ts)、[shares](src/routes/shares.ts) | Docker/libvirt/hostd、主机访问授权和异步操作状态 |
| 终端 | [terminal](src/routes/terminal.ts)、[terminal-client](src/lib/terminal-client.ts) | 浏览器 WS 与 terminald 协议桥接 |
| 媒体 | [media](src/routes/media.ts)、[music](src/routes/music.ts)、[playback](src/routes/playback.ts)、[media-stream](src/routes/media-stream.ts)、[photos](src/routes/photos.ts) | NAS 原生播放、浏览器流和照片衍生物分别管理 |
| 监控、健康、备份 | [monitoring](src/routes/monitoring.ts)、[monitoring-alerts](src/routes/monitoring-alerts.ts)、[health-status](src/routes/health-status.ts)、[backup](src/routes/backup.ts) | 业务库与指标库分离；API liveness 与业务 readiness 分离 |

## 聊天快照与实时事件

`GET /api/sessions/:id/transcript` 在同一个数据库读事务中获取 transcript、运行状态和 SSE 游标，避免 worker 在请求期间写入造成不同时间点混合。

Web 随后使用 `/api/sessions/:id/events?after=<cursor>` 订阅增量；服务也接受 `Last-Event-ID`。SSE handler 每 500ms 按 `agent_events.id` 读取一批记录，写出带 ID 和类型的事件，并在连接关闭时清除 timer。

这条链路是数据库持久事件到 HTTP SSE 的适配。监控、下载、播放等领域有各自事件实现，不能把聊天的轮询方式推广到所有 SSE 路由。

## 能力、审批与领域适配器

`createCapabilityAdapters` 把第一方业务动作接入统一能力协议。MCP 的写请求生成提案；第一方审批路由核对 session、expectedRevision 和 confirmed，随后由 capability-runtime 再检查策略、凭据和目标状态后执行。

需要密码等秘密的操作在第一方审批时收集，不能把秘密放入模型工具参数或公开提案。REST 的具体业务确认机制与 Agent 能力审批相互配合，不应通过新增路由绕过它们。

## 数据与运行边界

业务 SQLite 由 db 管理 schema；metrics.sqlite 通过 MonitoringReader 只读访问。API 不负责监控采样，Rust monitor 在提交后通过 Unix socket 向事件代理通知。

存储操作使用 pool 与相对路径。文件变更、数据库记录和 Linux 服务副作用并不构成一个全局事务，各领域用批次状态、执行锁、revision 和恢复流程协调。

`/health` 只表示 API liveness。判断系统就绪还要查看业务健康、存储挂载、worker 心跳、服务日志和实际操作结果。

## 开发与验证

```bash
CYBEROS_ENVIRONMENT=development \
CYBEROS_ROOT="$PWD/.cyberos/dev-root" \
npm run dev -w @cyberos/api
```

默认地址为 `127.0.0.1:3010`。单独启动 API 不会自动替你启动 worker 或全部 Rust 服务。

```bash
npx vitest run packages/api
npm run build -w @cyberos/api
```

测试用注入依赖验证路由与服务适配，不等同于真实 Docker、libvirt、声卡或挂载验收。修改文件接口需保留 `/api/files/meta` 与 `/api/files/text` 的协议；改动 shared/协议或领域服务时，检查所有消费方。
