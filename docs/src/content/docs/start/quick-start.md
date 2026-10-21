---
title: 快速开始
description: 从源码启动 ZOS，并完成第一次文件浏览、索引和 agent 对话。
type: tutorial
status: current
audience: [developer, user]
sourceOfTruth: [README.md, package.json, config.example.toml, packages/shared/src/config.ts, packages/api/src/index.ts]
sidebar:
  order: 1
---

## 适用范围

本页面面向开发机或测试机。它使用独立的 `.zos/dev-root` 目录和测试 NAS root，不应直接用于生产数据。生产安装请改读[Debian 与 appliance 部署](/docs/operations/deployment/)。

## 准备依赖

需要 Node.js 22.12 或更高版本、npm 和 Git。若要让 agent 使用 Pi provider，还需要在主机上安装并配置 `pi`；没有 provider 时可以启用只读 fallback 验证文件浏览和搜索流程。

```bash
node --version
npm --version
git --version
```

在仓库根目录安装应用和文档依赖：

```bash
npm ci
npm --prefix docs ci
```

也可以执行 `make install` 完成同样的安装。

## 创建开发数据目录

```bash
mkdir -p .zos/dev-root/data/primary
printf 'hello ZOS\n' > .zos/dev-root/data/primary/README.txt
```

启动时显式指定数据目录和 NAS root，避免开发进程误读系统根目录：

```bash
ZOS_ENVIRONMENT=development \
ZOS_ROOT="$PWD/.zos/dev-root" \
ZOS_NAS_ROOTS="dev:开发 NAS:$PWD/.zos/dev-root/data/primary" \
ZOS_ENABLE_LOCAL_AGENT_FALLBACK=1 \
npm run dev
```

`ZOS_NAS_ROOTS` 每项可以写成 `id:name:path`，多个 root 使用逗号分隔。fallback 只提供受限的只读 agent turn，不能替代真实 Pi provider。

## 打开界面

分别访问：

- Web 开发服务器：`http://127.0.0.1:5173`
- API liveness：`http://127.0.0.1:3010/health`
- API 系统健康：`http://127.0.0.1:3010/api/system/health`
- 独立文档站：`http://127.0.0.1:4321/docs/`（执行 `npm run docs:dev` 时）

生产构建后的 Web 和文档由 API 同源提供，入口为 `http://127.0.0.1:3010/` 和 `http://127.0.0.1:3010/docs/`。

## 第一次验收

1. 在左侧选择测试 NAS root 和可用 storage pool，确认能看到 `README.txt`。
2. 点击文件查看 metadata 和文本预览；文件列表中的搜索只在当前 root/path 范围内执行。
3. 新建一个 agent session，询问当前目录内容，观察消息从 queued 到 running 再到 completed 的状态变化。
4. 执行 `npm run index` 触发一次索引，再访问 `/api/indexer/status` 查看运行结果。
5. 修改或移动文件时先检查 approval 卡片；审批前文件系统不应发生变化。

## 停止与清理

在运行 `npm run dev` 的终端按 `Ctrl-C`，然后按需删除测试数据：

```bash
rm -rf .zos/dev-root
```

不要把该命令指向 `/zos/data/primary`、`/zos/state` 或其他生产路径。
