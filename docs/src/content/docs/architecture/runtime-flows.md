---
title: 运行时流程
description: AI job、审批、索引搜索和备份恢复的跨进程数据流。
type: explanation
status: current
audience: [developer, operator]
sourceOfTruth: [apps/api/src/routes/sessions.ts, apps/worker/src/processor.ts, packages/agent/src/pi-agent.ts, apps/indexer/src/service.rs, apps/indexer/src/scanner.rs, apps/backup/src/backup.ts]
sidebar:
  order: 2
---

AI 请求依次经过 `agent_messages -> jobs -> worker claim -> Pi/local agent -> agent_events -> SSE`。需要 approval 的 tool call 会创建 pending approval，worker 进入 `waiting_approval`，只有 API 审批路径才执行变更。

文件搜索优先使用 root 和目录范围内的 FTS5 查询，必要时回退到文件名搜索。Indexer 与 API 通过同一个 SQLite WAL 数据库协作；execution lock 和 run status 防止周期任务重叠。

备份先生成在线 SQLite 快照和 manifest，再调用 restic；恢复只进入 staging，校验成功并不代表会自动 promote 到活动目录。
