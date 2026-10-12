---
title: Workspace 与服务矩阵
description: SigmaOS monorepo、应用、包和运行进程的对应关系。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [package.json, Cargo.toml, apps/api/package.json, apps/web/package.json, apps/photostaff/Cargo.toml, packages/db/package.json]
sidebar:
  order: 1
---

| 区域 | 责任 |
| --- | --- |
| `apps/web` | React/Vite 工作区与预览 |
| `apps/api` | Fastify REST、SSE、WebSocket 和静态服务 |
| `apps/worker` | agent job claim 与事件持久化 |
| `apps/photostaff` | Rust 图片、视频和 RAW 索引器，负责安全媒体探测、持久化扫描、元数据和 journaled WebP 衍生图 |
| `apps/indexer` | NAS 扫描与 FTS5 索引 |
| `apps/ops` / `apps/backup` | 健康评估、安全维护与 restic |
| `apps/hostd` / `apps/termux` | Rust 特权宿主机操作与非 root PTY/tmux 终端服务 |
| `packages/db` / `nas-tools` / `agent` / `shared` | 共享持久化、安全、agent 和配置契约 |
