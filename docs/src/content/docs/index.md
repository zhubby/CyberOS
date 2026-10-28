---
title: CyberOS 技术文档
description: CyberOS Linux NAS appliance 的开发、架构与运维文档。
type: reference
status: current
audience: [developer, operator, user]
sourceOfTruth: [README.md, AGENTS.md]
sidebar:
  order: 1
---

CyberOS 是面向个人设备的原生 Linux NAS appliance。它以 React/Vite 提供工作区，以 Fastify 提供本地 API，以 SQLite 保存状态，并通过 systemd 管理 API、agent worker、索引、备份和维护任务。

从这里开始：

- [快速开始](/docs/start/quick-start/)
- [Web 工作区使用指南](/docs/how-to/web-workspace/)
- [本地开发](/docs/start/local-development/)
- [配置与运行时边界](/docs/start/configuration/)
- [系统架构](/docs/architecture/system-overview/)
- [部署与恢复](/docs/operations/deployment/)
