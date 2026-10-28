---
title: 索引与健康检查
description: 运行索引、查看 freshness、mount readiness 和健康告警。
type: how-to
status: current
audience: [developer, operator]
sourceOfTruth: [crates/indexer/src/service.rs, crates/indexer/src/scanner.rs, crates/indexer/src/watcher.rs, packages/api/src/routes/indexer.ts, packages/api/src/routes/health-status.ts]
sidebar:
  order: 3
---

Indexer 通过 mutation queue 与 inotify 持续处理每个 storage pool，并每 30 分钟做一次全量校准。它不跟随符号链接，使用完整 source identity 跳过未变化文件，把规范化正文写入 SQLite FTS5。文件读取或提取失败会保留最近一次成功正文；遍历不完整或 mount identity 改变时跳过 stale cleanup。

通过 `/api/indexer/status`、`/api/system/storage` 和 `/api/system/health` 检查运行计数、失败路径、mount 身份、worker heartbeat、watcher degraded、队列停滞和旧索引 rebuild。常驻服务应保持 `active`；用 `journalctl -u cyberos-indexer.service` 检查 watcher rebuild、提取器错误和重试。

手动请求全量重建：

```bash
curl -X POST http://127.0.0.1:3010/api/indexer/reindex \
  -H 'content-type: application/json' \
  -d '{"storagePoolId":"dev","recursive":true}'
```
