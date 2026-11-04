# capability-runtime — 能力提案、审批后执行与恢复

`@cyberos/capability-runtime` 把统一能力契约连接到实际文件操作和领域 Adapter。它负责准备可审查提案、持久化运行参数、在第一方批准后复查授权与目标状态，执行动作并保存结果。

它由 API/MCP 等调用方嵌入，不是独立进程。模型可以请求提案，审批决定来自第一方界面；执行成功以后，worker 通过持久续接恢复 Agent 对话。

[返回工作空间总览](../README.md) · [包定义](package.json)

## 架构图

![能力提案、第一方审批与条件执行架构](docs/architecture.svg)

批准后的箭头带有版本与状态条件。审批时看到的目标发生变化，或者策略/客户端权限被撤销，都会使执行失败或要求重新提案。

## 源码导航

| 文件 | 职责 |
| --- | --- |
| [src/orchestrator.ts](src/orchestrator.ts) | 文件/领域提案、批准后执行、状态推进、恢复、清理与错误收敛 |
| [src/adapters.ts](src/adapters.ts) | Adapter 四阶段接口、持久 payload/proposal、秘密输入验证 |
| [src/file-read.ts](src/file-read.ts) | 扩展文件读取、检索、查找、Git 与归档检查 |
| [src/storage-pools.ts](src/storage-pools.ts) | pool 解析与就绪检查 |
| [src/restricted-shell.ts](src/restricted-shell.ts) | 默认关闭的受限只读命令适配器 |
| [src/index.ts](src/index.ts) | 公共导出 |

## 三种提案路径

| 入口 | 内容与前置检查 |
| --- | --- |
| `proposeFileMutation` | 只允许内置 Pi；解析 mkdir/move/copy/rename/trash，验证 pool 和路径，记录文件目标 revision |
| `proposeDomainCapability` | 读取 descriptor 和已注入 Adapter，调用 prepare，保存摘要、目标、changes、revision 与私有 payload |
| `proposePiMcpFileCapability` | 当 Pi 读取策略需要批准时，为读取能力生成提案，而非直接读取 |

提案默认 TTL 为 15 分钟。公开摘要与私有执行 payload 分开存储；幂等键用于识别同一客户端的重复请求，同键不同输入返回冲突。

## 第一方批准后如何执行

1. API 的 [审批路由](../api/src/routes/approvals.ts) 核对会话、expectedRevision、decision 和必要的 confirmed。
2. `executeApprovedCapabilityRun` 仅从 queued 开始；读取批准记录，核对其关联的是 Pi Agent 会话。
3. 重新读取能力策略；禁用或新增加的确认要求不能被旧提案绕过。
4. 重新检查客户端类型、撤销/过期状态和 required scope。
5. 文件提案重新解析 pool、源/目标，并计算 revision；与批准目标不一致时返回 `CONFLICT`。
6. 领域 Adapter 重新检查 availability 和 `revalidate`，包括目标或运行环境变化。
7. 以 expectedRevision 条件将 run 从 queued 转成 running；竞争失败时读取现有状态。
8. 调用 storage-tools 或 Adapter.execute，保存 succeeded/failed、领域 operation ID 和结果，删除不再需要的私有 payload。

文件系统或远端副作用与业务库不是一个跨系统原子事务。中途失败必须根据实际领域操作和运行记录处理，不能把 run 的最终失败自动解释为所有外部变更已回滚。

## 领域 Adapter 合约

| 阶段 | 责任 |
| --- | --- |
| `availability` | 判断该服务和当前配置是否支持此动作 |
| `prepare` | 解析输入，生成可审查摘要和私有执行计划，避免提前执行变更 |
| `revalidate` | 在执行前确认目标、revision、约束和环境仍满足计划 |
| `execute` | 使用已准备的计划和第一方秘密输入执行，返回结果与可选领域 operation 关联 |

API 在 [capability-adapters.ts](../api/src/lib/capability-adapters.ts) 注入领域实现。此包只依赖接口，避免为每个领域复制审批状态机。

## 秘密输入与受限命令

密码等秘密通过 `requiredSecrets` 声明，由第一方审批提供。验证拒绝缺项、未知项及不满足长度的值；普通工具请求会拒绝疑似秘密字段。需要秘密的执行有单独入口，避免把它们写进公开提案或普通续接内容。

受限 shell 不是交互终端。默认 `mcp.shellEnabled=false`，可用时只接受固定命令清单、经过检查的参数、pool 内 cwd、超时和输出上限。通过 `execFile` 执行参数数组，禁止重定向、展开、越界路径和若干危险选项；这不授予任意 shell 或 root 权限。

## 数据、恢复与取消

`capability_runs`、审批和私有 payload 位于业务库；文件变更另记录 file operation 与必要 trash entry。公开 run 关联 subject/client，供拥有者查询或在允许阶段取消。

`recoverCapabilityRuns` 在 API 启动时协调过期批准、被中断执行和可继续的已批准 run。已经进入不可取消的动作不能靠修改界面状态撤销；领域服务必须报告实际结果。

## 开发与验证

```bash
npx vitest run packages/capability-runtime packages/db/src/capability-runs.test.ts
npm run typecheck
```

测试覆盖目标变化、策略撤销、scope、秘密输入、文件读取和受限命令。增加 Adapter 时还要验证真实领域端的失败/重试语义，不能仅用模拟 execute 证明主机动作已完成。

继续阅读：[能力契约](../capabilities/README.md)、[MCP 接入](../mcp/README.md)、[worker 续接](../worker/README.md)。
