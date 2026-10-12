---
title: 本地开发
description: 在开发机上运行 SigmaOS 的 API、worker、Web 和索引任务。
type: tutorial
status: current
audience: [developer]
sourceOfTruth: [README.md, package.json, apps/api/src/index.ts, apps/worker/src/index.ts, apps/photostaff/src/main.rs, apps/downloader/src/main.rs]
sidebar:
  order: 2
---

SigmaOS 使用 Node.js 22.12 或更高版本、npm workspaces、严格 TypeScript 和 `rust-toolchain.toml` 固定的 Rust 1.95。API 默认绑定 `127.0.0.1:3010`，Vite Web 默认运行在 `127.0.0.1:5173`。

开发时需要配置独立的 NAS root。`npm run dev` 启动 API、agent worker、Rust photostaff、Rust downloader、Rust VOD player 和 Web；这些 Rust 服务会等待 API 应用所需 migration 后再领取任务。Indexer 仍通过 `cargo run -p sigmaos-indexer` 单独启动，`npm run index` 则只运行一轮，便于观察队列与扫描结果；`npm run health` 和 `npm run maintenance` 分别执行一次 Ops 任务。Photostaff 需要 ExifTool 与 libvips CLI；Indexer 的 PDF/OCR 需要 Poppler 与 `chi_sim+eng` Tesseract 数据；视频海报和播放需要 `ffmpeg`。

完成开发验证后，应通过根级 typecheck、lint、test 和 build 检查所有 workspace 与文档站。
