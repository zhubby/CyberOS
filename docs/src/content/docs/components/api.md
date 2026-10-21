---
title: Fastify API
description: HTTP 路由、SSE、WebSocket 和静态资源服务。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [packages/api/src/server.ts, packages/api/src/routes/index.ts, packages/api/src/routes/files.ts, packages/api/src/routes/sessions.ts]
sidebar:
  order: 2
---

路由按领域拆分为 health、roots、indexer、readiness、backup、settings、system、storage、sessions、jobs、files、approvals、operations、Docker、shares、terminal 和 VMs。

HTTP 面包含 REST、SSE 和 WebSocket，没有 OpenAPI 生成层。文档只记录端点用途、传输方式、审批要求和源码位置；`/api/files/meta` 与 `/api/files/text` 的响应形状由现有测试保护。

生产模式下 API 还提供 React Web dist 和同源 `/docs/` 静态站点。
