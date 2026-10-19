---
title: 数据模型与持久化
description: SQLite 表分组、迁移顺序和 WAL 并发边界。
type: explanation
status: current
audience: [developer, operator]
sourceOfTruth: [packages/db/src/migrations/core.ts, packages/db/src/migrations/operations.ts, packages/db/src/migrations/indexer.ts, packages/db/src/migrations/production.ts, packages/db/src/connection.ts, packages/monitoring/src/schema.ts, packages/monitoring/src/store.ts]
sidebar:
  order: 4
---

ZOS 使用两个职责分离的 SQLite 数据库。主库 `zos.sqlite` 开启 WAL、foreign keys 和 busy timeout，表按身份与 roots、sessions/jobs/events、approvals/operations、indexed files/FTS/trash、Photos 资源/任务/扫描断点/发布 journal、readiness/index history、backup、health alerts 和 execution locks 分组。

迁移由有序 ID 驱动，首次打开数据库时逐个事务执行并记录到 `schema_migrations`。TypeScript migration catalog 是 schema 权威；内部 Rust `photostaff` 服务只等待 migration 023 就绪，不维护另一份完整 schema。Photos job 使用独立租约与 worker heartbeat，其他周期任务通过 execution lock 和 systemd 调度避免互相覆盖。

指标库 `metrics.sqlite` 使用独立的 `monitoring_schema_migrations`，包含 `metric_series`、`metric_samples_raw`、`metric_rollups_1m`、`metric_rollups_1h`、`collector_status` 和内部 metadata。样本与 rollup 采用 `(series_id, timestamp/bucket)` 主键和 `WITHOUT ROWID`；rollup 保存 first/last/min/max/sum/count 以及 counter 的累计增量，使原始样本过期后仍可正确处理重置并计算速率。迁移只添加可空聚合字段，不在服务启动时扫描或重写历史数据；旧 rollup 缺少可靠累计增量时，rate 查询返回空点。monitor 是唯一写入者，API 和 Health 仅以只读连接查询。指标库损坏时先改名隔离再重建，绝不修改或删除主库。
