# packages — 16 个 TypeScript 工作空间架构

CyberOS 的 TypeScript 代码分为浏览器应用、常驻服务、一次性管理程序和共享库。它们与 [Rust 工作空间](../crates/README.md) 共同组成原生 Linux NAS 系统，由 systemd 管理进程。npm workspace 的源码根是 `packages/`；安装后的 `/usr/lib/cyberos/apps` 是运行时目录。

每个工作空间的 `README.md` 都包含架构图、源码导航、关键执行流程、状态归属和验证入口。图中的外部组件用于解释调用边界，不表示该组件属于当前包。

## 工作空间导航

| 工作空间 | 运行形态 | 核心职责 | 架构文档 |
| --- | --- | --- | --- |
| `@cyberos/web` | 浏览器应用，Web/TV 双入口 | React 界面、移动导航、业务面板和播放控制 | [web](web/README.md) |
| `@cyberos/api` | Node 常驻进程 | Fastify HTTP、SSE、WebSocket、静态资源和服务编排 | [api](api/README.md) |
| `@cyberos/worker` | Node 常驻进程 | 领取 Agent 任务与会话命令、续租、事件持久化 | [worker](worker/README.md) |
| `@cyberos/agent` | worker 嵌入的 Node 库 | Pi SDK 会话、模型代次、受控 MCP/Skills 资源 | [agent](agent/README.md) |
| `@cyberos/capabilities` | Node 契约库 | 能力目录、Schema、风险、scope、注册表与结果格式 | [capabilities](capabilities/README.md) |
| `@cyberos/capability-runtime` | API 等消费方嵌入的 Node 库 | 提案、审批后执行、目标复查和领域适配器 | [capability-runtime](capability-runtime/README.md) |
| `@cyberos/mcp` | API 嵌入的协议接入库 | Stateless MCP、认证、目录过滤、资源和传输 | [mcp](mcp/README.md) |
| `@cyberos/mcp-cli` | 本地主机 CLI | 配对客户端、token 生命周期和 TLS/Nginx 配置 | [mcp-cli](mcp-cli/README.md) |
| `@cyberos/db` | Node 同步 SQLite 库 | 业务 schema、迁移、Repository、租约与状态转换 | [db](db/README.md) |
| `@cyberos/storage-tools` | Node 文件系统库 | 存储边界、文件读取、元数据、变更与回滚原语 | [storage-tools](storage-tools/README.md) |
| `@cyberos/shared` | 条件导出的共享库 | 类型、协议、Node 配置/客户端、浏览器子集和 HUD tokens | [shared](shared/README.md) |
| `@cyberos/media-streamer` | Node 常驻进程 | 浏览器视频 direct/remux/transcode 会话与 HLS | [media-streamer](media-streamer/README.md) |
| `@cyberos/monitoring` | Node 只读指标库 | 指标目录、查询规划、时间聚合和采集健康视图 | [monitoring](monitoring/README.md) |
| `@cyberos/system-health` | Node 评估库 | 存储、索引、备份和服务状态聚合；定时协调告警 | [system-health](system-health/README.md) |
| `@cyberos/ops` | Node 一次性任务 | 带运行记录的健康检查与维护 | [ops](ops/README.md) |
| `@cyberos/backup` | Node 一次性任务与可复用库 | Restic 备份、仓库检查和恢复暂存验证 | [backup](backup/README.md) |

## 从一次用户操作理解分层

普通聊天从 Web 进入 API，API 把用户消息和 job 写进业务库；worker 领取并续租，调用 agent 执行 Pi 回合。Agent 的事件经回调落库，API 按游标读取事件并通过 SSE 提供给 Web。数据库是共享状态载体，事件发送者是 API。

Agent 工具调用经过 MCP 和能力目录。读取按 scope、策略和可用性处理；需要审批的操作先生成持久提案，由第一方界面作决定。capability-runtime 在执行前再次检查策略、客户端凭据、scope 和目标修订，随后调用 storage-tools 或领域 Adapter。能力完成后的 continuation 让 worker 继续会话。

文件界面、容器、VM、网络、共享和终端通过 API 的领域适配器访问 Linux 服务。`hostd` 执行受限主机操作，`terminald` 管理终端，Rust indexer/photos/downloader 推进各自任务。Web 不直接打开 SQLite、Unix socket 或主机设备。

## 数据所有权

| 状态或资源 | 主要所有者 / 访问方式 |
| --- | --- |
| `state/cyberos.sqlite` | db 定义业务 schema；API、worker、Ops、backup 及相关 Rust 服务按领域读写 |
| `state/metrics.sqlite` | Rust monitor 写入；monitoring 只读，业务库不承载采样序列 |
| 存储池 `data/<pool>` | 文件操作按 pool 和相对路径限制；挂载与路径检查由实际执行链完成 |
| Pi 会话文件 | agent 通过 SDK 在 state 下维护；业务会话与事件仍在业务库 |
| 浏览器播放会话 | Web 持有界面状态；media-streamer 持有临时会话、文件句柄和 HLS 缓存 |
| NAS 播放状态 | Rust vod-player 及其 API 适配器；音乐与原生视频协调播放所有权 |
| 备份 | backup 编排 Restic 仓库与 manifest；恢复结果保留在独立暂存目录 |

`shared` 定义 bootstrap 与默认运行配置；持久业务设置由上层读取数据库后合并。不要从包名推断它一定是独立服务，也不要把默认配置当成最终生效设置。

## 开发入口

Node.js 要求至少 22.19.0。依赖在仓库根目录安装；开发数据使用独立目录：

```bash
npm ci
npm --prefix docs ci
mkdir -p .cyberos/dev-root/data/pool-1
CYBEROS_ENVIRONMENT=development \
CYBEROS_ROOT="$PWD/.cyberos/dev-root" \
npm run dev
```

根 `dev` 同时编排 API、worker、若干 Rust 服务、media-streamer 与 Vite。Indexer 和一次性维护任务有单独入口。只调试某个进程时，可使用对应包的 `dev` script；纯库没有单独启动命令。

| 用途 | 根目录命令 |
| --- | --- |
| Web | `npm run dev -w @cyberos/web`，默认 `127.0.0.1:5173` |
| API | `npm run dev -w @cyberos/api`，默认 `127.0.0.1:3010` |
| Agent Worker | `npm run dev -w @cyberos/worker` |
| 浏览器媒体流服务 | `npm run dev -w @cyberos/media-streamer` |
| 一次索引 | `npm run index` |
| 健康 / 维护 | `npm run health` / `npm run maintenance` |

## 修改与验证

协议改动先查看 [shared](shared/README.md) 和根 `protocol:check`；能力改动同时查看 [capabilities](capabilities/README.md)、[MCP](mcp/README.md) 和 [capability-runtime](capability-runtime/README.md)；数据库改动需考虑所有并发消费者；前端改动遵循 [前端设计规范](../docs/src/content/docs/reference/frontend-design.md)。

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`make ci` 汇总检查和构建；文档站的 `npm run docs:browser` 是独立烟测。单元测试、构建和架构图检查只能覆盖各自范围，真实 Linux 挂载、音视频输出、远端 MCP 和灾难恢复需要相应环境验收。
