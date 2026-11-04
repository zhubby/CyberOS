# db — 业务 SQLite、迁移与领域 Repository

`@cyberos/db` 为 CyberOS 提供基于 `better-sqlite3` 的同步数据库访问。它定义业务 schema 和增量迁移，把会话、任务、索引、审批、媒体、设备、设置及操作记录封装为领域 Repository，并承载多进程协作所需的租约、revision 与事务。

本包不是数据库服务器。API、worker、Ops、backup 各自打开连接，共享 `state/cyberos.sqlite`；Rust 消费方也遵循相同持久契约。指标时间序列位于独立的 `metrics.sqlite`，由 monitor/monitoring 管理。

[返回工作空间总览](../README.md) · [包定义](package.json)

## 架构图

![业务数据库连接、事务仓库与迁移架构](docs/architecture.svg)

连接建立与业务查询是两条相关路径：可写打开先验证格式并完成迁移，之后调用领域 Repository。数据库不会直接向浏览器发送事件，API 负责读取和发送 SSE。

## 源码导航

| 文件 / 目录 | 职责 |
| --- | --- |
| [src/connection.ts](src/connection.ts) | 连接、格式身份、WAL 协商、超时、外键和只读模式 |
| [src/schema.ts](src/schema.ts) | 迁移序列及逐条事务执行 |
| [src/migrations](src/migrations) | 当前基线与 Agent、下载、音乐、视频、照片、音频等迁移 |
| [src/repositories.ts](src/repositories.ts) | Repository 导出汇总 |
| [src/repositories](src/repositories) | 领域查询、事务和记录映射 |
| [src/index.ts](src/index.ts) | 公共导出 |

## 打开数据库的两种方式

`openCyberOsDb` 创建父目录并打开可写连接。它要求 `PRAGMA user_version=3`；只有完全空白数据库可以初始化为该格式，不会发现或导入早期产品数据库。格式检查在 immediate 事务中重新读取，避免并发首次启动误判。

接着配置 30 秒 busy timeout，协商 WAL，开启外键并执行迁移。WAL 协商碰到 SQLITE_BUSY/SQLITE_LOCKED 时使用有界退避；超时或其他错误会关闭连接并抛出。

`openCyberOsDbReadOnly` 要求文件已存在，验证格式，设置 `query_only=ON`，不创建目录、不切换 WAL、不执行迁移。媒体流服务等消费者使用这条路径。

## 迁移机制

每个 migration 有唯一 ID、SQL 和可选 prepare。`schema_migrations` 记录已应用条目。外层先快速查询，再在每条 immediate 写事务内重新检查；只有取得锁后仍未应用的迁移才执行并记账。

这是同一 CyberOS 数据格式内的 schema 演进，不是旧产品迁移工具。迁移序列无通用反向路径，发布或降级时需要匹配的业务状态备份。不要在应用启动之外并发运行临时 SQL 写入器。

## Repository 按领域组织

| 领域 | 代表入口 | 数据与一致性关注点 |
| --- | --- | --- |
| Agent | [sessions](src/repositories/sessions.ts)、[jobs](src/repositories/jobs.ts)、[transcript](src/repositories/transcript.ts)、[commands](src/repositories/agent-session-commands.ts) | 消息/job、事件游标、turn 顺序、租约、continuation |
| 能力与 MCP | [capability-runs](src/repositories/capability-runs.ts)、[mcp-clients](src/repositories/mcp-clients.ts)、[mcp-resource-tokens](src/repositories/mcp-resource-tokens.ts) | subject 归属、幂等、审批 revision、短期令牌 |
| 文件与索引 | [file-operations](src/repositories/file-operations.ts)、[file-batches](src/repositories/file-batches.ts)、[indexer-queue](src/repositories/indexer-queue.ts)、[index-search](src/repositories/index-search.ts) | 批次、回收记录、任务代次、全文查询 |
| 媒体 | [photos](src/repositories/photos.ts)、[media-library](src/repositories/media-library.ts)、[music](src/repositories/music.ts)、[video-library](src/repositories/video-library.ts) | 资产/目录、来源、元数据、播放进度与版本 |
| 系统管理 | [settings](src/repositories/settings.ts)、[storage-operations](src/repositories/storage-operations.ts)、[docker-operations](src/repositories/docker-operations.ts)、[vm-operations](src/repositories/vm-operations.ts) | 设置与秘密隔离、异步操作状态、目标 revision |
| 运维与告警 | [ops-runs](src/repositories/ops-runs.ts)、[backup-runs](src/repositories/backup-runs.ts)、[health-alerts](src/repositories/health-alerts.ts)、[monitoring-alerts](src/repositories/monitoring-alerts.ts) | 执行锁、心跳、历史保留、事件与告警生命周期 |

## 关键一致性模式

任务领取和续租使用 owner/lease 等条件；能力 run 的状态转换使用 expectedRevision 与允许来源状态。它们用于防止旧 worker 或重复请求覆盖较新的任务状态。

能力幂等记录按 client、capability 和 idempotency key 查找，并比较输入摘要。同一键对应不同输入是冲突，不能作为成功重放。

Transcript 查询把用户消息与事件条目归入 turnSequence，再按条目 sequence 排序。API 在同一读事务中获取 transcript、运行状态与事件快照；把这些查询拆到多个时间点会破坏恢复边界。

同步 SQLite 事务内应保持工作短小。网络、子进程或文件复制不能被当成可由 SQL rollback 撤回的副作用，应由运行状态与领域恢复机制协调。

## 使用方式

```ts
import { openCyberOsDb, listSessions } from "@cyberos/db";

const db = openCyberOsDb(databasePath);
try {
  const sessions = listSessions(db, { limit: 50 });
  // 由调用方返回或处理 sessions。
} finally {
  db.close();
}
```

调用方负责连接生命周期。包直接导出 TypeScript 源文件，由消费方构建；它没有独立 `dev`/`start` 服务。

## 开发与验证

```bash
npx vitest run packages/db
npm run typecheck
```

重点测试包括 [schema](src/schema.test.ts)、[并发事务](src/transaction-contention.test.ts)、[capability run](src/capability-runs.test.ts) 和各领域 Repository。原生 SQLite 模块必须匹配 Node ABI 和目标架构，macOS `node_modules` 不能直接复制到 Linux。
