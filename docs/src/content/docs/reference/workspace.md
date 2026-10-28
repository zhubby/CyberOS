---
title: Workspace 与服务矩阵
description: CyberOS monorepo、应用、包和运行进程的对应关系。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [package.json, Cargo.toml, packages/api/package.json, packages/web/package.json, crates/photos/Cargo.toml, packages/db/package.json]
sidebar:
  order: 1
---

| 区域 | 责任 |
| --- | --- |
| `packages/web` | React/Vite 工作区与预览 |
| `packages/api` | Fastify REST、SSE、WebSocket 和静态服务 |
| `packages/worker` | agent job claim 与事件持久化 |
| `crates/photos` | Rust 图片、视频和 RAW 索引器，负责安全媒体探测、持久化扫描、元数据和 journaled WebP 衍生图 |
| `crates/indexer` | storage pool 扫描与 FTS5 索引 |
| `packages/ops` / `packages/backup` | 健康评估、安全维护与 restic |
| `crates/hostd` / `crates/terminald` | Rust 特权宿主机操作与非 root PTY/tmux 终端服务 |
| `crates/monitor` / `crates/alerter` | Rust 指标采集、保留、告警求值与投递 |
| `crates/downloader` / `crates/vod-player` / `crates/bluetoothd` | 下载、HDMI 播放与蓝牙集成 |
| `crates/host-accessd` | 非 root、白名单化的 Docker 宿主观测代理 |
| `packages/db` / `packages/storage-tools` / `packages/agent` / `packages/shared` | 共享持久化、安全、agent 和配置契约 |
| `packages/mcp` / `packages/mcp-cli` / `packages/capabilities` / `packages/capability-runtime` | MCP 服务、命令行与能力注册表 |

源码树不包含 `apps/`。所有 TypeScript workspace 由根 `package.json` 的 `packages/*` 管理；所有 Rust workspace member 由根 `Cargo.toml` 的 `crates/*` 管理。`/usr/lib/cyberos/apps/*` 是 Debian 安装产物的稳定运行时路径，`/cyberos/apps` 是托管 Compose App 的运行副本目录，两者都不是源码 workspace。
