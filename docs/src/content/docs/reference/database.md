---
title: SQLite 与迁移参考
description: SQLite WAL、表域和 migration policy。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [packages/db/src/schema.ts, packages/db/src/connection.ts, packages/db/src/migrations/current.ts, packages/monitoring/contracts/migrations, crates/monitor/src/adapters/metrics_sqlite.rs, crates/alerter/src/adapters/alert_store]
sidebar:
  order: 5
---

主 SQLite 位于 `/cyberos/state/cyberos.sqlite`，使用 WAL、foreign keys 和 busy timeout。CyberOS 2.0 只接受由单一 `001_cyberos_2_0` 基线创建的数据库；后续 2.x 迁移按递增 ID 执行并写入 `schema_migrations`。新增业务持久化状态必须同时更新 migration、repository、shared type 和测试。

FTS5 正文索引、照片资源与处理任务、index run history、backup runs、health alerts 和 execution locks 都属于同一数据库的运维状态，不应另起 Redis 或外部队列。

高频监控指标是明确例外：`${CYBEROS_ROOT}/state/metrics.sqlite` 使用独立的 CyberOS 2.0 基线、WAL 和 incremental auto-vacuum，由 `cyberos-monitor` 独占写入，API/Health 只读。其固定表为 `metric_series`、`metric_samples_raw`、`metric_rollups_1m`、`metric_rollups_1h`、`collector_status` 与内部 metadata。数据库必须同时携带当前 schema version 和 `cyberos-2.0` identity；缺少 identity 的旧库与高于当前支持版本的未来库都会被拒绝，不执行转换或历史 rollup 回填。每指标和全库序列数均有硬上限，完全过期的序列目录由保留任务清理。该库是可重建缓存；只有 SQLite 明确报告损坏时才隔离最近一组带时间戳的指标库并创建新库，不得删除、迁移或修复 `cyberos.sqlite`。

告警不是第三个数据库。`monitoring_alert_rules`、`monitoring_alert_instances`、`monitoring_alert_incidents`、事件与静默、联系人/组、值班/override、升级策略/阶段/目标、delivery/attempt 和 `monitoring_alerter_state` 都位于主库，由 TypeScript API migration 创建。规则表保存最近一次求值时间与脱敏后的规则级错误，即使规则尚未生成 instance 也能展示展开超限等失败。API 管理配置并使用整数 revision 做乐观并发控制；Rust alerter 不创建或迁移主库，schema 未就绪时退避。SMTP secret 和 Health severity 路由保存在 `system_settings`，密码不进入 API 响应、日志或 delivery 错误。

Photos 图库配置保存在内部键 `system_settings.photos_library_settings`；`photos` 仅作为 Rust 服务、数据库表和数据目录标识。`photos_assets` 使用 `storage_pool_id + relative_path` 标识文件，并保存 hash、时间线、尺寸、source identity 和衍生图契约。`photos_asset_metadata` 保存规范字段、schema version、解析状态、警告和清洗后的来源分组 JSON；`photos_metadata_values` 按来源限定路径和类型保存标量，数组逐值索引；`photos_keywords`、`photos_metadata_fts` 与 `photos_geo_index` 分别承担关键词、FTS5 和 GPS RTree 查询。MakerNote、缩略图及二进制负载不进入数据库，每个资源受叶子数、单值、JSON 大小和深度限制。

托管离线地图不新增数据库表；状态由固定文件和进程内下载任务决定。

同一资源的规范字段、EAV、关键词、FTS 和 RTree 在一个短事务中替换，删除资源通过 foreign key 和 trigger 清理虚拟索引。旧版本元数据和 XMP sidecar 的新增、修改或删除会触发渐进重建；未带元数据条件的旧时间线继续可用，带条件查询只匹配当前 schema version。`photos_jobs` 保存完整扫描和路径刷新的租约与进度；上传通过 `photos_upload_reservations` 事务性预留媒体 hash 和目标路径。`photos_scan_entries`、`photos_publish_journal`、`photos_space_reservations` 和 `photos_workers` 分别保存扫描断点、发布恢复、空间预留和 worker 心跳。设置变化会失效旧资源和未完成任务，worker 只有在完整且挂载身份稳定的遍历后才清理 stale 资源与衍生图缓存。

Photos worker 中先验证租约或查询状态、再写入的事务使用 `BEGIN IMMEDIATE`，在读取前取得写锁；与 API、indexer 等进程竞争时按 30 秒 busy timeout 等待。不要依赖 deferred 事务读后升级写锁：WAL 下遇到其他写入者或过期快照时，升级可能立即返回 `database is locked`，跳过 busy timeout。事务内只执行数据库操作，文件遍历与媒体处理放在事务外；只读缓存快照继续使用 deferred 事务。

`006_photos_scan_contention` 为 pending 与可重试失败条目分别增加 partial index。worker 必须等此迁移完成后启动，领取条目时分别通过对应索引取候选，再按路径比较，保持原有顺序，避免在写事务中反复遍历已完成条目。目录发现结果每批最多 128 条提交，整批校验租约并原子写入；中断后重读目录时按主键幂等去重。不要把文件遍历放进批量事务，也不要通过延长 busy timeout 掩盖持续抢占写锁。
