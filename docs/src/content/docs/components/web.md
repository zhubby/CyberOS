---
title: Web UI
description: React/Vite 工作区、预览、设置和管理面板。
type: reference
status: current
audience: [developer]
sourceOfTruth: [apps/web/src/App.tsx, apps/web/src/api.ts, apps/web/src/components/workspace/WorkspacePane.tsx, apps/web/src/components/workspace/MonitoringPanel.tsx, apps/web/src/components/workspace/HttpDownloaderPanel.tsx, apps/web/package.json]
sidebar:
  order: 1
---

`apps/web` 是 React 19 + Vite 7 单页应用，负责文件浏览、预览、chat、approval、operations、monitoring、terminal、HTTP 下载、Docker/VM/share/storage 管理和设置。API 契约在 `apps/web/src/api.ts` 与共享类型中维护。

前端通过 REST 读取状态，通过 SSE 订阅 agent/job/download 事件，通过 WebSocket 连接终端和 console。文件预览有大小限制，视频可使用 API 的 FFmpeg cache，界面支持中英文和明暗主题。

顶层“监控”面板提供 `1h/6h/24h/7d/30d/1y` 范围，展示主机、容量、温度和 ZOS 状态。短范围每 10 秒刷新，长范围每 60 秒刷新；页面隐藏时暂停。指标缺口保持断线，面板分别呈现 disabled、starting、partial/degraded 和 offline/unavailable。

前端视觉、布局、交互和响应式约束见[前端设计语言](/docs/reference/frontend-design/)。该文档是新增或修改 Web UI 时的设计参考和验收基线。
