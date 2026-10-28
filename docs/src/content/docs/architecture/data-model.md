---
title: 数据模型与持久化
description: SQLite 表分组、迁移顺序和 WAL 并发边界。
type: explanation
status: current
audience: [developer, operator]
sourceOfTruth: [packages/db/src/migrations/current.ts, packages/db/src/connection.ts, packages/monitoring/contracts/migrations, crates/monitor/src/adapters/metrics_sqlite.rs, crates/alerter/src/adapters/alert_store]
sidebar:
  order: 4
---

CyberOS 使用两个职责分离的 SQLite 数据库。主库 `cyberos.sqlite` 开启 WAL、foreign keys 和 busy timeout，表按身份与设置、Agent session/message/job/event/command、capability run/approval、领域 operation/notification、indexed files/FTS/trash、Photos 资源/任务/扫描断点/发布 journal、storage-pool index history、backup、health alerts、monitoring alert 配置/incident/outbox 和 execution locks 分组。

主库以单一 `001_cyberos_2_0` 空白基线创建，未来 2.x 变更继续使用有序 migration，并在事务内记录到 `schema_migrations`。TypeScript migration catalog 是主库 schema 权威；内部 Rust 服务只等待所需 schema 就绪，不迁移主库。告警 API 使用 revision 乐观并发，alerter 以聚合根事务维护 instance、incident、事件和 outbox。Photos job 使用独立租约与 worker heartbeat，其他周期任务通过 execution lock 和 systemd 调度避免互相覆盖。

指标库 `metrics.sqlite` 使用独立的 CyberOS 2.0 schema 和版本记录，包含 `metric_series`、`metric_samples_raw`、`metric_rollups_1m`、`metric_rollups_1h`、`collector_status` 和内部 metadata。样本与 rollup 采用 `(series_id, timestamp/bucket)` 主键和 `WITHOUT ROWID`；rollup 保存 first/last/min/max/sum/count 以及 counter 的累计增量，使原始样本过期后仍可正确处理重置并计算速率。Rust monitor 是唯一写入者，API、Health 和 Rust alerter 仅以只读连接查询。高于当前版本的 schema 会被拒绝；只有 SQLite 明确报告损坏时才隔离并重建指标库，绝不修改或删除主库。
