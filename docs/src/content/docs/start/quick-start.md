---
title: 快速开始
description: 从源码启动 CyberOS，并完成第一次文件浏览、索引和 agent 对话。
type: tutorial
status: current
audience: [developer, user]
sourceOfTruth: [README.md, package.json, packages/shared/src/config.ts, packages/shared/src/paths.ts, packages/api/src/index.ts]
sidebar:
  order: 1
---

## 适用范围

本页面面向开发机或测试机。它使用独立的 `.cyberos/dev-root` 目录和测试 storage pool，不应直接用于生产数据。生产安装请改读[Debian 部署](/docs/operations/deployment/)。

## 准备依赖

需要 Node.js 22.12 或更高版本、npm 和 Git。Agent turn 还需要在设置中配置 OpenAI 或 Anthropic provider、model 和 API key。

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
mkdir -p .cyberos/dev-root/data/pool-1
printf 'hello CyberOS\n' > .cyberos/dev-root/data/pool-1/README.txt
```

启动时显式指定数据目录和 storage pool，避免开发进程误读系统根目录：

```bash
CYBEROS_ENVIRONMENT=development \
CYBEROS_ROOT="$PWD/.cyberos/dev-root" \
npm run dev
```

CyberOS 将 `data` 的一级真实目录作为存储池，目录名就是 `storagePoolId`。

## 打开界面

分别访问：

- Web 开发服务器：`http://127.0.0.1:5173`
- API liveness：`http://127.0.0.1:3010/health`
- API 系统健康：`http://127.0.0.1:3010/api/system/health`
- 独立文档站：`http://127.0.0.1:4321/docs/`（执行 `npm run docs:dev` 时）

生产构建后的 Web 和文档由 API 同源提供，入口为 `http://127.0.0.1:3010/` 和 `http://127.0.0.1:3010/docs/`。

## 第一次验收

1. 在左侧选择 `pool-1`，确认能看到 `README.txt`。
2. 点击文件查看 metadata 和文本预览；文件列表中的搜索只在当前存储池路径范围内执行。
3. 新建一个 agent session，询问当前目录内容，观察消息从 queued 到 running 再到 completed 的状态变化。
4. 执行 `npm run index` 触发一次索引，再访问 `/api/indexer/status` 查看运行结果。
5. 在 Workspace 修改或移动文件时核对确认对话框与目标路径；Agent mutation 则检查 capability approval 卡片，批准前目标资源不应发生变化。

## 停止与清理

在运行 `npm run dev` 的终端按 `Ctrl-C`，然后按需删除测试数据：

```bash
rm -rf .cyberos/dev-root
```

不要把该命令指向 `/cyberos/data/pool-1`、`/cyberos/state` 或其他生产路径。
