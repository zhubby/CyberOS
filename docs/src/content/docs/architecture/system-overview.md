---
title: 系统总览
description: ZOS 的系统上下文、容器边界和主要依赖方向。
type: explanation
status: current
audience: [developer, operator]
sourceOfTruth: [README.md, packages/api/src/server.ts, packages/worker/src/processor.ts, crates/monitor/src/application/monitor.rs, crates/alerter/src/application/evaluation.rs, crates/monitoring-contracts/src/lib.rs, packages/db/src/connection.ts, packages/monitoring/contracts/metrics-catalog.json]
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
  Alerter[zos-alerter] -->|只读查询| Metrics
  Alerter -->|规则 / incident / outbox| DB
  Alerter -->|SMTP| Mail[邮件服务器]
  Backup[Backup] --> DB
  API -->|JSONL Unix socket| Hostd[Rust hostd]
  API -->|Unix socket| Terminal[Terminal helper]
  Tools --> NAS[Configured NAS roots]
```

依赖方向是 `web -> api`，`api -> db/nas-tools/shared/system-health/monitoring`，`worker -> agent/db/shared`。Rust downloader、indexer、monitor 与 alerter 使用由 TypeScript migration catalog 管理的主 SQLite schema；monitor 只读主库并独占写入可重建的指标库，alerter 只读指标库并把规则、incident 和投递 outbox 写入主库。API 不采集指标、不评估规则、不发送邮件。systemd timers 仍是运维任务的唯一周期调度层；指标采样和告警求值由各自常驻进程使用单调时钟调度。ZOS 是多进程原生服务，不使用 Docker 作为自身部署边界。
