---
title: 系统总览
description: ZOS 的系统上下文、容器边界和主要依赖方向。
type: explanation
status: current
audience: [developer, operator]
sourceOfTruth: [README.md, apps/api/src/server.ts, apps/worker/src/processor.ts, apps/monitor/src/service.ts, packages/db/src/connection.ts, packages/monitoring/src/store.ts]
sidebar:
  order: 1
---

```mermaid
flowchart LR
  Browser[浏览器] -->|REST / SSE / WebSocket| API[Fastify API]
  API <--> DB[(SQLite WAL + FTS5)]
  API -->|只读查询| Metrics[(metrics.sqlite raw / 1m / 1h)]
  API --> Tools[Path-safe NAS tools]
  Worker[Agent worker] <--> DB
  Worker --> Agent[Pi agent / local fallback]
  Agent --> Tools
  Downloader[Rust HTTP downloader] <--> DB
  Downloader -->|dirfd / openat2| NAS
  Indexer[Indexer] -->|扫描与增量写入| DB
  Ops[Ops health / maintenance] --> DB
  Monitor[zos-monitor] -->|唯一写入者| Metrics
  Monitor -->|只读状态| DB
  Monitor --> Host["/proc / /sys / statfs / systemd"]
  Backup[Backup] --> DB
  API -->|JSONL Unix socket| Hostd[Rust hostd]
  API -->|Unix socket| Terminal[Terminal helper]
  Tools --> NAS[Configured NAS roots]
```

依赖方向是 `web -> api`，`api -> db/nas-tools/shared/system-health/monitoring`，`worker -> agent/db/shared`；Rust downloader 与 Rust indexer 直接使用由 TypeScript migration catalog 管理的主 SQLite schema，并通过 dirfd/`openat2` 访问 NAS。Ops 与 backup 共享主库。`zos-monitor` 独占可重建的指标库写入，API 与 Health 只读该库，因此高频采样和损坏隔离不会影响文件、索引、任务或备份状态。systemd timers 仍是运维任务的唯一周期调度层；监控采样由常驻 monitor 自身调度。ZOS 是多进程原生服务，不使用 Docker 作为自身部署边界。
