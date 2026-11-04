# mcp — Stateless MCP 接入、能力目录与资源传输

`@cyberos/mcp` 把 CyberOS 的能力目录接入 MCP HTTP 协议。它嵌入 Fastify API，负责客户端认证、Host/Origin 检查、并发/速率限制、按 scope 与 Agent 策略过滤目录，以及工具调用和资源传输。

本包提供服务注册函数，不单独监听端口。默认内置 Pi 使用 loopback `/mcp`；LAN 客户端需要配对凭据和另外启用的受管 HTTPS 入口。

[返回工作空间总览](../README.md) · [包定义](package.json)

## 架构图

![MCP 认证、按客户端装配与能力分派架构](docs/architecture.svg)

认证后的请求生成当前客户端专属 runtime。目录可见性、执行授权和审批提案分别检查，不能用“工具在列表里”替代调用时的权限判断。

## 源码导航

| 文件 | 职责 |
| --- | --- |
| [src/server.ts](src/server.ts) | Fastify 注册、HTTP guard、SDK server/tool/resource 装配和资源传输端点 |
| [src/runtime.ts](src/runtime.ts) | 客户端上下文、目录过滤、领域读取、提案与 run 查询/控制 |
| [src/index.ts](src/index.ts) | 公共导出 |

## HTTP 与认证边界

| 入口 | 行为 |
| --- | --- |
| `POST /mcp` | Stateless MCP；校验 Bearer token 后创建请求 runtime |
| `GET /mcp` / `DELETE /mcp` | 返回 405，不提供持久 MCP session 管理 |
| `GET /mcp-transfer/:token` | 配对客户端认证，再消费所属客户端的短期传输 token，核对文件身份 |
| `GET /mcp-resource/:token` | 认证并消费资源 token，交给领域 responder 或文件回退处理 |

默认 Host 和 Origin 允许 loopback。MCP 请求体上限 1 MiB，每客户端默认并发 4、每分钟请求 120；Fastify 层还设路由限流。

标记为外部入口的请求要求 `externalEnabled`，并要求转发协议为 HTTPS。该标记和转发头依赖受控代理配置；不能让任意外部请求直接访问未经保护的 loopback API。

## 请求如何变成能力调用

1. `registerMcp` 检查开关，安装 guard、认证和限流，建立 SDK handler。
2. `createClientRuntime` 生成 subject、scopes 与 trace 上下文，读取当前 Agent 能力策略。
3. 从 capabilities 目录构造 descriptor。非 Pi 客户端不安装第一方写提案能力；被禁用的 Pi 能力和关闭的 shell 也被过滤。
4. 按内置实现、readAdapter 或 domain Adapter 注入 executor；未安装实现的能力保留不可用原因。
5. `catalogForClient` 再按 scope 输出目录与 availability；调用时注册表重查权限。
6. `executeImplemented` 根据 ID 和策略分派读取、资源链接、文件提案、领域提案或拥有者 run 操作。
7. 执行结果统一封装 schemaVersion、data、warnings、page、runId、traceId；错误转为稳定能力错误格式。

Pi 的读取策略可以要求批准；文件 resource-link 只有自动读取策略下才可用。文件写能力始终生成提案，实际变更由第一方审批后交给 runtime 执行。

## 资源与大数据传输

工具响应有字节限额，较大文件和媒体使用资源/传输端点。传输 token 与 clientId 绑定；请求还需正常 Bearer 认证，不能把 URL 自身视为长期公开下载地址。

文件传输重新解析 pool 内路径，打开文件后检查类型、大小和修改时间；变化时返回冲突，避免把旧元数据对应到新文件。资源 responder 可由 API 注入，以支持照片等领域资源。

资源 token、凭据和 capability run 位于业务库；每客户端并发和速率计数在进程内存，进程重启后重建。请求关闭时会释放活跃计数和 SDK handler。

## 与相邻模块的关系

| 模块 | 本包从它取得什么 |
| --- | --- |
| [capabilities](../capabilities/README.md) | 目录、Schema、风险、scope、注册表和结果格式 |
| [capability-runtime](../capability-runtime/README.md) | 文件读能力、提案准备与批准后执行机制 |
| [db](../db/README.md) | 配对认证、设置、run、资源和传输 token |
| [API](../api/README.md) | 领域 readAdapter、domain Adapter、资源 responder 和宿主 HTTP 进程 |
| [mcp-cli](../mcp-cli/README.md) | 管理员配对、token 生命周期和 TLS 配置 |

本包不向外部 MCP 客户端开放批准入口。`cyberos.runs.cancel` 只能控制其拥有且允许取消的 run，不表示拥有所有运行的管理权限。

## 开发与验证

```bash
npx vitest run packages/mcp packages/capabilities
npm run typecheck
```

测试覆盖认证、协议、目录、scope、资源和提案分派。调试真实 Pi 链路需同时运行 API/worker 并安装有效 Pi 配对 token；外部客户端 TLS、代理与网络连通性需要独立验收。
