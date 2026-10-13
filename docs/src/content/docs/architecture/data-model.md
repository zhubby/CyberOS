---
title: 数据模型与持久化
description: SQLite 表分组、迁移顺序和 WAL 并发边界。
type: explanation
status: current
audience: [developer, operator]
sourceOfTruth: [packages/db/src/migrations/core.ts, packages/db/src/migrations/operations.ts, packages/db/src/migrations/indexer.ts, packages/db/src/migrations/production.ts, packages/db/src/connection.ts]
sidebar:
  order: 4
---

SQLite 是唯一持久化存储，开启 WAL、foreign keys 和 busy timeout。表按身份与 roots、sessions/jobs/events、approvals/operations、indexed files/FTS/trash、Photos 资源/任务/扫描断点/发布 journal、readiness/index history、backup、health alerts 和 execution locks 分组。

迁移由有序 ID 驱动，首次打开数据库时逐个事务执行并记录到 `schema_migrations`。TypeScript migration catalog 是 schema 权威；内部 Rust `photostaff` 服务只等待 migration 023 就绪，不维护另一份完整 schema。Photos job 使用独立租约与 worker heartbeat，其他周期任务通过 execution lock 和 systemd 调度避免互相覆盖。
