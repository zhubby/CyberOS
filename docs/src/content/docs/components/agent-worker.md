---
title: Agent 与 Worker
description: Pi agent、job queue 和 capability approval 状态机。
type: explanation
status: current
audience: [developer]
sourceOfTruth: [packages/worker/src/processor.ts, packages/agent/src/pi-agent.ts, packages/db/src/repositories/jobs.ts, packages/db/src/repositories/capability-runs.ts]
sidebar:
  order: 3
---

API 只写入 message 和 queued job。worker 负责 claim、取消检测、provider session、事件持久化和最终 job 状态。只有 Pi 在 Agent 对话中按策略请求能力时才会创建 approval；Workspace 右侧面板调用各自的 REST 操作并直接返回结果，不进入 Agent approval 状态机。

一次 Pi turn 可以并行产生多个 approval。worker 会关联全部 capability run，等待它们全部进入终态，再把完整结果集合交回同一个 provider session 继续对话。取消 Agent job 会同时过期仍待处理的 approval，并删除对应的私有执行 payload。

Pi 工具按 `read`、`grep`、`find`、`ls`、`bash`、`edit`、`write` 分组，策略可配置。模型和凭据由数据库及设置界面管理；没有可用模型时，Pi turn 明确失败。

Agent 设置中的 MCP 开关保存在 SQLite。开启时 API 自动创建或修复受保护的 `Built-in Pi` 身份和 `0600` token；worker 在每次领取 job 时读取最新值，因此新任务无需重启即可启用 capability registry。关闭后 Agent 不再获得 capability tools；主机级 `[mcp].enabled` 仍是不可由页面绕过的总开关。

当 session root 与配置的 Photos 图库 root 一致时，worker 额外注入只读 `search_photos` 和 `get_photos_metadata`。工具名中的 `photos` 是内部模块标识；两者复用 Photos 数据库查询服务并强制限制到当前库版本。位置可以作为筛选条件，但工具输出再次移除精确 GPS、设备/镜头序列号、联系信息和人物区域，避免敏感元数据进入云模型上下文。
