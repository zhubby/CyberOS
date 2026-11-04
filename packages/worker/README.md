# worker — Agent 任务、会话命令与续接调度

`@cyberos/worker` 是常驻 Node 进程，从业务 SQLite 领取 Agent job 和会话命令，维护租约，调用 [agent](../agent/README.md)，并持久化运行事件、provider-session 快照和终态。API 接受请求与浏览器连接，worker 执行较长的模型回合。

[返回工作空间总览](../README.md) · [包定义](package.json) · [systemd 模板](../../packaging/systemd/cyberos-worker@.service)

## 架构图

![Worker、任务租约、会话命令与续接架构](docs/architecture.svg)

箭头从 worker 指向队列表，表示主动领取和续租。事件由 worker 落库后，API 再按游标读取成 SSE；worker 不持有浏览器连接。

## 源码导航

| 文件 | 职责 |
| --- | --- |
| [src/index.ts](src/index.ts) | 配置、数据库连接、workerId、两个处理循环及信号退出 |
| [src/processor.ts](src/processor.ts) | job/command 领取、心跳、取消、资源装配、状态转换和事件写入 |
| [src/processor.test.ts](src/processor.test.ts) | 租约、命令、失败、审批与续接行为测试 |

## 启动与并发模型

入口加载 bootstrap/runtime，打开数据库并恢复中断的会话命令。workerId 由主机名、PID 和 UUID 组成，用于区分并发实例。

进程有两个处理循环：job 按 worker `pollMs` 轮询，command 使用 `min(pollMs, 250ms)`。默认 job 轮询为 750ms，每个循环各自受 `concurrency` 限制，默认值为 2；它不是两个循环合计只有两个活动任务。

多个 systemd worker 实例可以共享业务库，依靠数据库的条件领取和租约协调。这里的并发限制属于当前进程，不能替代数据库层的任务所有权判断。

## Job 如何执行

1. 优先领取已具备能力执行结果的 continuation，否则领取普通 queued job。
2. 读取 session 和原始 message。引用缺失时记录失败，避免在不存在的会话中执行。
3. 启动租约心跳；默认租约 30 秒、心跳 10 秒，记录 `job.running`。
4. 创建取消判断：任务取消/失败、租约丢失或租约 owner 改变都会使执行停止。
5. 加载模型设置、能力策略、MCP 服务器、凭据和 Skills，调用 agent runner。
6. 将模型事件追加到 `agent_events`，保存 provider-session 信息；需要审批时把 job 转为 `waiting_approval` 并关联 capability run。
7. 回合完成、取消或失败后按允许的来源状态更新终态，并清理心跳。

Continuation 用能力结果构建内部续接消息，明确要求不要重复用户原始请求。它与重新执行原始 prompt 的语义不同。

## 会话命令路径

`processNextAgentCommand` 领取独立的持久命令。命令包括 `steer`、`follow_up`、`abort` 和模型/上下文管理操作；API 中的普通 prompt 仍走 job 路径。

命令携带 sessionId、可选 jobId 与幂等信息。worker 为命令单独续租，发出 running/completed/failed 事件。活动 turn 暂时不可用、且当前 job 仍由本 worker 运行时，特定错误可触发命令重新排队。

`abort` 会协调 job 状态和 Agent 的活动执行。不能仅凭取消命令已入队就认定模型回合或远端工具已经停止。

## 资源与状态所有权

| 资源 | 本包的使用方式 |
| --- | --- |
| 业务库 | 调用 db Repository 领取任务、续租、追加事件与保存快照 |
| `state/pi-sessions` / `state/pi-agent` | 交给 agent/SDK 管理会话和模型资源 |
| 内置 MCP | 从配置的 Pi token 文件读取配对凭据，连接 loopback API `/mcp` |
| 外部 MCP | 从受限秘密目录读取凭据，按已保存服务器配置装配 |
| Skills | 从持久设置和资源 generation 生成允许路径 |
| 存储池 | 当前会话工作路径通过 agent 和能力执行链的路径保护访问 |

worker 不直接执行文件审批。需要审批的能力通过 MCP 和 capability-runtime 生成提案，第一方批准并执行后再唤醒续接。

## 退出和恢复

SIGINT/SIGTERM 先阻止新 tick，清除两个 interval；已有任务退出后释放 Pi 宿主并关闭数据库。这个过程与立即杀死子进程不同。

任务租约和命令恢复由数据库 Repository 协调。租约过期不表示前一个进程已经物理停止所有外部副作用，具体领域操作仍需要自身幂等性、目标复查和完成记录。

## 开发与验证

在仓库根目录、独立开发数据目录下启动：

```bash
CYBEROS_ENVIRONMENT=development \
CYBEROS_ROOT="$PWD/.cyberos/dev-root" \
npm run dev -w @cyberos/worker
```

API 与内置 MCP 凭据需先就绪。构建和测试：

```bash
npx vitest run packages/worker packages/agent
npm run build -w @cyberos/worker
```

生产服务使用非 root `cyberos` 身份，state/logs/data 是指定可写路径。排查时结合 job、command、leaseOwner、capability run 和 API SSE 游标，不能只检查进程是否 active。
