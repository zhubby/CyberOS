---
title: 数据模型与持久化
description: SQLite 表分组、迁移顺序和 WAL 并发边界。
type: explanation
status: current
audience: [developer, operator]
sourceOfTruth: [packages/db/src/migrations/core.ts, packages/db/src/migrations/operations.ts, packages/db/src/migrations/indexer.ts, packages/db/src/migrations/production.ts, packages/db/src/connection.ts, packages/monitoring/contracts/migrations, apps/monitor/src/adapters/metrics_sqlite.rs, apps/alerter/src/adapters/alert_store]
sidebar:
  order: 4
---

ZOS 使用两个职责分离的 SQLite 数据库。主库 `zos.sqlite` 开启 WAL、foreign keys 和 busy timeout，表按身份与 roots、sessions/jobs/events、approvals/operations、indexed files/FTS/trash、Photos 资源/任务/扫描断点/发布 journal、readiness/index history、backup、health alerts、monitoring alert 配置/incident/outbox 和 execution locks 分组。

迁移由有序 ID 驱动，首次打开数据库时逐个事务执行并记录到 `schema_migrations`。TypeScript migration catalog 是主库 schema 权威；内部 Rust 服务只等待各自要求的 migration 就绪，不迁移主库。告警 API 使用 revision 乐观并发，alerter 以聚合根事务维护 instance、incident、事件和 outbox。Photos job 使用独立租约与 worker heartbeat，其他周期任务通过 execution lock 和 systemd 调度避免互相覆盖。

指标库 `metrics.sqlite` 使用共享 SQL 契约中的独立 `monitoring_schema_migrations`，包含 `metric_series`、`metric_samples_raw`、`metric_rollups_1m`、`metric_rollups_1h`、`collector_status` 和内部 metadata。样本与 rollup 采用 `(series_id, timestamp/bucket)` 主键和 `WITHOUT ROWID`；rollup 保存 first/last/min/max/sum/count 以及 counter 的累计增量，使原始样本过期后仍可正确处理重置并计算速率。迁移只添加可空聚合字段，不在服务启动时扫描或重写历史数据；旧 rollup 缺少可靠累计增量时，rate 查询返回空点。Rust monitor 是唯一写入者，API、Health 和 Rust alerter 仅以只读连接查询。指标库只有在 SQLite 明确报告损坏时才隔离重建，绝不修改或删除主库。
