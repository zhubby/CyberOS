---
title: Operations、Backup 与 Health
description: 运维任务生命周期、健康评估、安全维护和 restic 备份。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [packages/ops/src/runner.ts, packages/ops/src/maintenance.ts, packages/backup/src/backup.ts, packages/system-health/src/index.ts, packaging/systemd/zos-health.timer, packaging/systemd/zos-maintenance.timer]
sidebar:
  order: 5
---

systemd timers 是唯一周期调度层。`packages/ops` 是严格的 one-shot CLI，只接受 `health` 或 `maintenance`：health 每 15 分钟运行，maintenance 每日 04:30 运行；Web 运维页的手动执行经 API 和 hostd 固定 allowlist 启动相同的两个 unit，不接受任意 unit、参数或命令。

每次运行都写入 `ops_runs`，包含开始、heartbeat、结束、结构化摘要和安全错误。运行中每 5 秒 heartbeat；超过 2 分钟未更新会在下一次启动时标记为 `interrupted`。每类任务保留最近 30 条，`GET /api/system/operations` 汇总 `never_run`、`running`、`ready`、`failed` 或 `stale` 状态并返回历史。

Health 共用 `packages/system-health` 评估 root readiness、Indexer、Downloader、Photos 的内部 `photostaff` worker、VOD、backup、repo check 和 Ops 状态。定时任务主动刷新 mount 与 backup target；`GET /api/system/health` 只读缓存，避免 API 请求执行 `findmnt`。健康结论为 degraded/failed 仍是一次成功完成的评估；只有探测框架、数据库或程序异常才将 Ops run 标记为 failed。

Maintenance 使用独立 `ops:maintenance` lease，执行非阻塞 `wal_checkpoint(PASSIVE)`、`PRAGMA optimize`、历史裁剪和超过 7 天的 `restore-*` staging 清理。清理 staging 前必须取得 `backup` lease 并检查 symlink 与目录边界；backup 正在运行时只记录 deferred。Trash 只统计数据库中未恢复条目，不扫描且不永久删除 NAS 或 trash 文件。

Backup CLI 与 daily/weekly timers 使用 restic，并通过独立 `backup` lease 与 init/check/restore 串行化。旧 scheduler 生成的 `/zos/state/reports/*.json` 在升级时保留为历史文件，但不再读取或更新；重复文件报告能力已移除。
