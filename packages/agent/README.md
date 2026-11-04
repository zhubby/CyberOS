# agent — Pi 会话、模型运行时与受控资源

`@cyberos/agent` 把 Pi Coding Agent SDK 封装为 CyberOS 的会话执行库。worker 提供用户输入、工作目录、模型设置、资源配置与持久化回调；本包负责创建或复用 SDK 会话、执行回合和命令、转换事件并释放资源。

这是嵌入 worker 的 Node 库。它不打开业务 SQLite，也不领取 job；任务竞争、租约和事件存储由 [worker](../worker/README.md) 与 [db](../db/README.md) 处理。

[返回工作空间总览](../README.md) · [包定义](package.json)

## 架构图

![Pi 会话、模型代次与受控资源架构](docs/architecture.svg)

会话宿主同时协调模型绑定与同会话串行调度。SDK 会话装配时只接入受控的 MCP、Skills 和项目资源，并把运行事件交还调用方保存。

## 源码导航

| 文件 | 职责 |
| --- | --- |
| [src/index.ts](src/index.ts) | 对外导出入口 |
| [src/pi-agent.ts](src/pi-agent.ts) | 回合/命令接口、会话宿主、SDK 装配、MCP 接入、事件投影与脱敏 |
| [src/agent-session-manager.ts](src/agent-session-manager.ts) | 按 sessionId 建立 actor、串行执行、指纹切换和空闲释放 |
| [src/model-runtime-manager.ts](src/model-runtime-manager.ts) | 根据 provider、模型和 generation 缓存运行时，绑定当前或会话快照设置 |
| [src/pi-resource-policy.ts](src/pi-resource-policy.ts) | 项目资源信任策略，固定关闭用户与项目扩展 |
| [src/fixtures](src/fixtures) | SDK 会话兼容性测试样本 |

## 一次回合的执行路径

1. `runPiAgentTurn` 把输入交给对应 state 目录下的 `PiAgentSessionHost`。
2. 宿主解析安全工作路径，要求目标为目录，并准备 Pi 会话和 agent state 目录。
3. `ModelRuntimeManager.get` 使用当前设置及已有 provider-session 快照确定运行时。缓存键含设置 generation、provider、base URL 与 model。
4. 宿主计算会话指纹，包含上下文代次、工作路径、模型代次、MCP/Skills 配置和资源信任状态。
5. `AgentSessionManager.run` 将同会话操作排到 Promise 链尾；指纹变化时先释放旧资源，再创建新 SDK 会话。
6. 新会话打开已有 session file 或创建 SDK session，绑定模型、工具、资源加载器和事件订阅。
7. 执行 prompt 或续接输入，转换 SDK 事件，调用 `emit` 和 `saveProviderSession` 等回调。
8. 需要能力审批时返回 `waiting_approval` 及 runId；worker 据此保存任务状态，之后由 continuation 恢复。

同会话串行不等于所有会话全局串行。独立 session 有独立 actor；同一 session 的排队任务完成后才启动空闲释放计时，默认空闲 TTL 为五分钟。

## 模型、会话与持久化

| 状态 | 所在位置 / 所有者 |
| --- | --- |
| 宿主、actor、当前 turn | 本进程内存，进程退出后重建 |
| Pi session 文件 | SDK 管理的 `state/pi-sessions`；保存模型上下文和会话条目 |
| Pi agent 配置/认证资源 | `state/pi-agent`；模型运行时读取其认证配置 |
| provider-session 绑定与投影游标 | 本包生成快照，调用方通过回调写入业务库 |
| Web transcript 与 Agent events | worker/db 持久化，不由本包直接写库 |

旧会话可以继续使用其模型代次。若旧代次缺少可用认证，本包明确报错，要求重新认证或显式切换模型；不会把当前设置的凭据无条件套到旧代次。

事件投影用 SDK 条目和已保存的 projection cursor 协调恢复。新增 SDK 事件类型或升级 Pi 时，要同时检查实时事件、恢复投影和公开事件字段，避免把同一条内容反复写入。

## 资源与工具边界

项目 Skills、Prompts、Context 是否允许加载由 `piResourcesTrusted` 决定；用户和项目扩展始终关闭。额外全局 Skills 来自受控配置；MCP server 列表、凭据和 generation 由 worker 装配。

内置 MCP 通向 CyberOS 的能力目录和审批流程；外部 MCP 使用受控网络传输。工具参数和会话文件路径在对外事件中有脱敏处理。项目资源被信任，只表示允许加载这些资源，不等于给予文件变更或主机操作的审批豁免。

运行期命令区分活动 turn 的命令和空闲会话命令。`steer`、`follow_up`、`abort` 等需要结合当前活动会话；不存在活动 turn 时的失败由专门错误表示，worker 决定是否重新排队。

## 错误与释放

资源加载失败会先发出资源诊断事件，再终止本次装配。取消监视器轮询调用方提供的取消判断。释放宿主时取消未结束 turn、取消事件订阅、dispose SDK 会话，并关闭受控 MCP runtime。

`AgentSessionManager` 的队尾 Promise 会吸收前次失败，避免一次失败永久阻塞该会话后续调度；执行失败仍会返回给当前调用方。

## 开发与验证

本包没有独立服务命令。完整链路通过独立开发根目录下的 API 和 worker 启动，见 [总览](../README.md)。在仓库根运行：

```bash
npx vitest run packages/agent
npm run typecheck
```

测试覆盖会话串行/释放、模型代次、资源策略、事件映射和 SDK 升级兼容性。测试中的假 runner 或 SDK 样本不证明远端 provider 和 MCP 服务实际可用。

继续阅读：[worker 调度](../worker/README.md)、[MCP 路由](../mcp/README.md)、[审批执行](../capability-runtime/README.md)。
