---
title: 运行时流程
description: AI job、审批、索引搜索和备份恢复的跨进程数据流。
type: explanation
status: current
audience: [developer, operator]
sourceOfTruth: [packages/api/src/routes/sessions.ts, packages/worker/src/processor.ts, packages/agent/src/pi-agent.ts, crates/indexer/src/service.rs, crates/indexer/src/scanner.rs, packages/backup/src/backup.ts]
sidebar:
  order: 2
---

AI 请求依次经过 `agent_messages -> jobs -> worker claim -> Pi agent -> agent_events -> SSE`。Pi 和 MCP 的能力调用统一创建 `capability_runs`；需要审批的 mutation 同时创建 `capability_approvals`，关联 job 进入 `waiting_approval`。批准时服务端重新校验策略、scope、资源 revision 和短时私有 payload，再执行一次并通过 `domain_operation_type/id` 关联领域 operation。

第一方 Web 操作不创建 capability run 或 capability approval。页面在危险操作前显式确认，API 继续执行输入、路径、挂载与 revision 校验，并把结果写入文件、Docker、VM、storage pool 或 share 的领域 operation。Docker/VM 控制台使用独立的短时一次性 authorization，不与 Agent 审批混用。

可见的用户消息、`agent.message` 和 `job.failed` 事件会在各自源记录的同一 SQLite 事务内写入 `agent_transcript_items`。该表的自增 `sequence` 是 API 快照、POST 回执和 SSE 共同使用的聊天顺序依据；`created_at` 只用于显示，同一时间点仍以 sequence 保持稳定顺序。

文件搜索使用 storage pool 和目录范围内的 `indexed_content_fts`。Indexer 与 API 通过同一个 SQLite WAL 数据库协作；execution lock 和 run status 防止周期任务重叠。

备份先生成在线 SQLite 快照和 manifest，再调用 restic；恢复只进入 staging，校验成功并不代表会自动 promote 到活动目录。
