---
title: 本地开发
description: 在开发机上运行 ZOS 的 API、worker、Web 和索引任务。
type: tutorial
status: current
audience: [developer]
sourceOfTruth: [README.md, package.json, packages/api/src/index.ts, packages/worker/src/index.ts, crates/monitor/src/bin/zos-monitor.rs, crates/alerter/src/main.rs, crates/photostaff/src/main.rs, crates/downloader/src/main.rs]
sidebar:
  order: 2
---

ZOS 使用 Node.js 22.12 或更高版本、npm workspaces、严格 TypeScript 和 `rust-toolchain.toml` 固定的 Rust 1.95。API 默认绑定 `127.0.0.1:3010`，Vite Web 默认运行在 `127.0.0.1:5173`。

开发时需要配置独立的 NAS root。`npm run dev` 启动 API、agent worker、Rust monitor、Rust alerter、内部 Rust `photostaff` 服务、Rust downloader、Rust VOD player 和 Web；这些后台服务会等待或读取 API 应用后的主库 schema。指标写入隔离在 `.zos/dev-root/state/metrics.sqlite`，告警配置和状态保存在同目录的 `zos.sqlite`。Indexer 仍通过 `cargo run -p zos-indexer` 单独启动，`npm run index` 则只运行一轮，便于观察队列与扫描结果；`npm run health` 和 `npm run maintenance` 分别执行一次 Ops 任务。Photos 媒体处理需要 ExifTool 与 libvips CLI；Indexer 的 PDF/OCR 需要 Poppler 与 `chi_sim+eng` Tesseract 数据；视频海报和播放需要 `ffmpeg`。

完成开发验证后，应通过根级 typecheck、lint、test 和 build 检查所有 workspace 与文档站。

## Nix 开发环境

在 Linux 或 macOS 上可使用 flake 提供的 Node.js 22、Rust 1.95、`pkg-config`、Python、Make 与 Git：

```bash
nix develop
npm ci
npm --prefix docs ci
make ci
```

dev shell 只提供工具链，不会替代 npm 安装，也不会自动创建 `.zos/dev-root`。Linux shell 额外包含 SQLite 与 ACL 工具；Nix package 和 NixOS module 只在 `x86_64-linux`、`aarch64-linux` 导出，macOS 仅支持开发 shell。
