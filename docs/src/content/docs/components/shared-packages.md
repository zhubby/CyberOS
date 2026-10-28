---
title: 共享包
description: db、storage-tools、agent 和 shared 包的边界。
type: reference
status: current
audience: [developer]
sourceOfTruth: [packages/db/src/index.ts, packages/storage-tools/src/index.ts, packages/agent/src/index.ts, packages/shared/src/index.ts]
sidebar:
  order: 7
---

- `packages/db`：连接初始化、2.x migrations、repositories、jobs、capability runs/approvals、领域 operations、索引和健康状态。
- `packages/storage-tools`：storage-pool-relative 路径安全、读操作、metadata、归档检查和文件 mutation primitives。
- `packages/agent`：Pi SDK 集成、provider session、storage-pool-scoped tools 和 policy/approval 协调。
- `packages/shared`：TOML/env 配置、共享 domain/API 类型、下载任务类型、terminal broker 协议。
- `packages/storage-tools`：路径安全、存储池范围和可回滚文件操作；API 与独立 downloader 共用同一套存储范围校验。
