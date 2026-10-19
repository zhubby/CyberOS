---
title: SQLite 与迁移参考
description: SQLite WAL、表域和 migration policy。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [packages/db/src/schema.ts, packages/db/src/connection.ts, packages/db/src/migrations/core.ts, packages/db/src/migrations/production.ts, packages/monitoring/src/schema.ts, packages/monitoring/src/store.ts]
sidebar:
  order: 5
---

主 SQLite 位于 data directory，使用 WAL、foreign keys 和 busy timeout。迁移按递增 ID 执行并写入 `schema_migrations`；新增业务持久化状态必须同时更新 migration、repository、shared type 和测试。

FTS5 正文索引、照片资源与处理任务、index run history、backup runs、health alerts 和 execution locks 都属于同一数据库的运维状态，不应另起 Redis 或外部队列。

高频监控指标是明确例外：`${ZOS_ROOT}/state/metrics.sqlite` 使用独立 migration、WAL 和 incremental auto-vacuum，由 `zos-monitor` 独占写入，API/Health 只读。其固定表为 `metric_series`、`metric_samples_raw`、`metric_rollups_1m`、`metric_rollups_1h`、`collector_status` 与内部 metadata。程序拒绝打开高于自身支持版本的指标 schema；升级只执行轻量 schema 变更，不在启动事务中回填历史 rollup，缺少新增 counter 聚合字段的旧 rate 数据以空点呈现。每指标和全库序列数均有硬上限，完全过期的序列目录由保留任务清理。旧库转换 auto-vacuum 时若空间不足会保留原库，后续容量保护暂停写入而不删除无法回收的保留数据。该库是可重建缓存；损坏恢复只隔离最近一组带时间戳的指标库并创建新库，不得删除、迁移或修复 `zos.sqlite`。旧版本回滚可以忽略但应保留兼容版本的 `metrics.sqlite`，避免破坏再次升级后的历史数据。

Photos 图库配置保存在内部键 `system_settings.photostaff_library_settings`；`photostaff` 仅作为 Rust 服务、数据库表和数据目录标识。`photostaff_assets` 保持 root-relative 路径、hash、时间线、尺寸、source identity 和衍生图契约。`photostaff_asset_metadata` 保存规范字段、schema version、解析状态、警告和清洗后的来源分组 JSON；`photostaff_metadata_values` 按来源限定路径和类型保存标量，数组逐值索引；`photostaff_keywords`、`photostaff_metadata_fts` 与 `photostaff_geo_index` 分别承担关键词、FTS5 和 GPS RTree 查询。MakerNote、缩略图及二进制负载不进入数据库，每个资源受叶子数、单值、JSON 大小和深度限制。

旧版 `system_settings.photostaff_map_settings` 记录为代码回滚保留，但当前 API 与 Web 不再读取或更新它。托管离线地图不新增数据库表；状态由固定文件和进程内下载任务决定。

同一资源的规范字段、EAV、关键词、FTS 和 RTree 在一个短事务中替换，删除资源通过 foreign key 和 trigger 清理虚拟索引。旧版本元数据和 XMP sidecar 的新增、修改或删除会触发渐进重建；未带元数据条件的旧时间线继续可用，带条件查询只匹配当前 schema version。`photostaff_jobs` 保存完整扫描和路径刷新的租约与进度；上传通过 `photostaff_upload_reservations` 事务性预留媒体 hash 和目标路径。`photostaff_scan_entries`、`photostaff_publish_journal`、`photostaff_space_reservations` 和 `photostaff_workers` 分别保存扫描断点、发布恢复、空间预留和 worker 心跳。设置变化会失效旧资源和未完成任务，worker 只有在完整且挂载身份稳定的遍历后才清理 stale 资源与衍生图缓存。
