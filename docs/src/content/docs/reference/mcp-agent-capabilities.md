---
title: Pi Agent、MCP 与 Skills
description: 管理 Pi Agent 策略、内置与第三方 MCP，以及全局和项目 Skills 的信任边界。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth:
  - packages/agent/src/pi-agent.ts
  - packages/worker/src/processor.ts
  - packages/api/src/routes/agent-resources.ts
  - packages/api/src/lib/agent-mcp-service.ts
  - packages/api/src/lib/agent-skills.ts
  - packages/shared/src/mcp-network.ts
  - packages/capabilities/src/parity-manifest.ts
  - packages/mcp/src/server.ts
  - packages/web/src/components/settings/SettingsMcpPage.tsx
  - packages/web/src/components/settings/SettingsSkillsPage.tsx
---

CyberOS 把 AI 设置拆成模型 Provider、Pi Agent、MCP 和 Skills 四个同级页面。所有产品设置保存在 SQLite；MCP secret 和已安装 Skill 使用固定的受限 state 目录，不需要产品配置文件。

## Pi Agent

**设置 > Pi Agent** 只管理 Pi 的 capability 执行策略、审批策略和项目资源信任。`auto` 直接返回有界结果，`approve` 和 `confirm` 创建持久 capability run/approval，`disabled` 从 Pi 工具目录移除能力。文件 mutation 仍通过 `capability_runs` 与 `capability_approvals`，不会因为启用了第三方 MCP 或 Skill 而绕过 CyberOS 的文件与宿主机边界。

当前会话信任项目后，Pi 才会加载项目中的 `.agents/skills`。信任只影响项目资源，不影响由 CyberOS 管理的全局 Skills。

## CyberOS 内置 MCP

CyberOS 内置 MCP 缺少设置记录时默认开启。**设置 > MCP** 可以启停它，但不能修改地址、认证或删除。首次启用或受保护 token 丢失时，API 创建或修复 `Built-in Pi` 身份，并把 token 以 `0600` 写入 `/cyberos/state/mcp/pi.token`；数据库只保存 token 摘要。

内置 MCP 把 CyberOS capability registry 作为 Streamable HTTP 暴露给 Pi。Pi 的 mutation 继续遵循 capability policy 和审批。配置 generation 改变后，worker 在下一轮对话重建 MCP 与 Skill 资源，不中断正在执行的 turn。

CyberOS 也保留 `/mcp` 作为已配对外部客户端的只读能力入口。API 仍绑定 loopback；需要 LAN 访问时使用专用 TLS listener，不能把本地 REST API 直接暴露到公网。

## 第三方 MCP Server

第三方只支持 MCP Streamable HTTP，不支持旧 SSE、stdio 或自定义 transport。每个 Server 使用 1–63 位小写 slug 作为稳定工具命名空间，可选择：

- `codemode`：优先通过 Codemode 聚合工具。
- `deferred`：工具按需发现和加载。
- `direct`：直接注册为可调用工具。

第三方 MCP 工具是用户信任后的外部执行能力，调用时**不创建 CyberOS capability approval**。新增、修改、启用和凭据变更属于高风险设置操作；Server 必须测试成功后才能启用。修改 URL、认证方式或明文 HTTP 策略会立即清除测试与信任状态并关闭 Server。

公网 Server 必须使用 HTTPS。明文 HTTP 只允许用户明确确认后的 loopback 或 RFC1918/ULA 私有地址。连接层阻止 link-local、云 metadata、危险 Header、跨 origin 重定向、DNS rebinding 和解析地址漂移。

Bearer Token 或自定义 Secret Headers 原子写入 `/cyberos/state/secrets/mcp/<server-id>.json`，目录权限为 `0700`，文件权限为 `0600`。SQLite 和公开 API 只保存或返回认证类型、Header 名称和 `credentialsConfigured`；secret 内容不得进入 Agent 上下文、日志、错误、通知或设置响应。

## Skills

全局 Skills 安装在 `/cyberos/state/pi-agent/skills/<skill-id>/`，由 CyberOS 负责安装、校验、启停、更新、替换和删除：

- ZIP 必须从 storage pool 选择。导入限制压缩包大小、展开大小和文件数量，并在解压前拒绝 traversal、符号链接、硬链接、设备、socket 与特殊文件。
- Git 只允许无凭据的公开 HTTPS 仓库，可指定 ref 和仓库子目录。安装使用浅克隆、禁止重定向和本地协议，并记录实际解析 commit。
- 每个来源必须且只能包含一个有效 `SKILL.md`；名称、描述、目录结构、可读性、嵌套压缩包和重复名称都在临时目录中校验。
- 校验通过后才原子替换正式目录；数据库失败时恢复原版本。

安装或启用 Skill 前必须确认：Skill 能改变 Pi 的工具选择，并可能引用或执行仓库中的脚本。项目 `.agents/skills` 只读展示，系统设置不会修改项目文件；项目未获信任时只禁用项目 Skills，全局 Skills 仍按自身开关加载。

## Capability parity

`cyberos.settings.public` 返回脱敏后的内置 MCP 状态、第三方 Server 摘要、全局 Skills 摘要和共享 generation。`cyberos.settings.update-propose` 提供 MCP/Skills 的 CRUD、测试、启停、安装与更新操作。凭据由审批 UI 的 secret input 通道注入，永远不成为模型工具参数。

外部 MCP 客户端可以用 `cyberos.runs.get`、`cyberos.runs.list` 和 `cyberos.runs.wait` 观察自己拥有的持久 run；`cyberos.runs.cancel` 只能取消同一客户端拥有且可中断的 run。MCP 不提供 approve 工具，审批只能由第一方 UI 完成。

## 运维检查

```bash
sudo systemctl restart cyberos-api.service cyberos-worker@1.service
sudo journalctl -u cyberos-api.service -u cyberos-worker@1.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/health
curl -fsS http://127.0.0.1:3010/api/settings/mcp
```

排障时只记录 Server ID、测试状态、工具数量、generation 和脱敏错误。不要复制 token、Secret Header、MCP secret 文件或 Skill 中的私密内容。
