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

### 音乐、影视与 NAS 播放

媒体工具复用现有媒体库和共享播放器，不启动独立 MCP 服务，也不控制某个浏览器的播放。

| 工具 | 用途 |
| --- | --- |
| `cyberos.music.query` | 按 `entity: tracks/albums/artists/playlists` 搜索，支持现有筛选、排序和游标分页 |
| `cyberos.music.get` | 按实体和 ID 读取详情；`entity: lyrics` 读取有界歌词 |
| `cyberos.music.status` | `view: home/sources/scans/library`，默认音乐库状态 |
| `cyberos.music.manage-propose` | 收藏、歌单、媒体源和扫描审批 |
| `cyberos.music.control-propose` | NAS 音乐播放、队列、音量、模式和已有音频输出控制审批 |
| `cyberos.media.query` | 搜索影片／剧集，支持个人状态、合集及匹配状态筛选 |
| `cyberos.media.get` | `entity: titles/next/match-candidates`，读取季集、文件版本、下一集及匹配候选 |
| `cyberos.media.status` | `view: home/sources/scans/library/collections/settings`，默认影视库状态 |
| `cyberos.media.manage-propose` | 个人状态、进度、合集、媒体源、扫描、匹配纠错及非敏感设置审批 |
| `cyberos.media.play-propose` | 按 `fileId` 在 NAS 播放，可指定 `startPositionSeconds` |
| `cyberos.playback.status` | 读取共享播放器 owner、实例、会话及音乐队列 |
| `cyberos.playback.outputs` | 查询系统默认输出及已有可用蓝牙音频设备；不配对设备 |
| `cyberos.playback.control-propose` | 暂停、恢复、停止、定位、音量、输出、音轨、字幕及音频延迟控制审批 |

音乐、影视、播放分别使用 `cyberos:music:read`、`cyberos:media:read`、`cyberos:playback:read`。申请变更使用对应域的 `:propose` scope，且仅内置 Pi 可以调用；外部客户端即使误授予 propose scope 也没有写工具。既有外部身份不自动新增权限，管理员必须显式重新授权需要的只读 scopes。内置 Pi 沿用现有 capability 目录同步机制。

查询默认每页 40、上限 100。音乐查询返回 `items/nextCursor`，影视查询返回 `titles/nextCursor`；查询下一页时原样传入 `cursor`。详情、首页及队列使用 `limit` 限制嵌套数组；长歌词、嵌套详情和达到总输出预算的结果会返回 `truncated: true` 和 `truncation` 路径／数量说明，不能把截断队列当作完整队列提交重排。媒体文件和图片二进制不进入工具结果。

播放操作必须先读取 `cyberos.playback.status`，将 `status.serviceInstanceId` 和 `status.sessionId` 分别作为 `serviceInstanceId`、`playbackSessionId` 传入。音乐命令还必须携带 `status.music.queueVersion` 对应的 `expectedQueueVersion`；统一播放控制额外携带目标 `sessionId`。没有播放会话时 `playbackSessionId` 为 `null`。

例如，搜索并申请播放歌曲：

```json
{"entity":"tracks","query":"歌曲名","limit":40}
```

```json
{
  "request": {
    "operation": "replace",
    "trackIds": ["查询得到的歌曲 ID"],
    "serviceInstanceId": "刚读取的播放器实例 ID",
    "playbackSessionId": null,
    "expectedQueueVersion": 0
  },
  "idempotencyKey": "play-music-request-001"
}
```

上述值必须取自实际状态，不能照抄示例。所有播放变更都要求第一方明确确认；跨音乐／影视接管会中断当前播放，但保留音乐队列。审批返回的 `runId` 沿用现有 `cyberos.runs.*` 查询流程。审批期间实例、会话、队列或目标文件改变后返回冲突，必须重新读取状态并发起新审批，不能自动更新抢占条件重试。正常播放进度推进不会使审批失效。

管理操作使用明确的 `operation`：音乐支持 `favorite`、`playlist_create/update/delete`，两种库均支持 `source_create/update/delete` 和 `scan`；影视另支持 `title_state`、`episode_state`、`progress`、`collection_create/update/delete`、`match`、`settings`。移除媒体源不删除原始文件。`settings` 仅接受语言和地区；TMDB Token 仍在第一方设置中配置，不能通过 MCP 提交或读取。NAS 播放器不可用时仍可查询媒体库。

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
