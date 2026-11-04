# shared — 跨模块类型、协议、运行配置与 HUD Tokens

`@cyberos/shared` 是 CyberOS 多个 TypeScript 工作空间的公共基础。它既包含类型、协议和验证函数，也包含 Node 运行配置、路径解析、本地服务客户端以及共享 CSS；不能把整个包当成纯类型包或全部可在浏览器执行的工具库。

包使用条件导出：浏览器解析根导入时选择 `browser.ts`，Node 选择 `index.ts`。两者共享契约子集，Node 入口额外开放文件系统配置和 Unix socket 客户端。

[返回工作空间总览](../README.md) · [包定义及 exports](package.json)

## 架构图

![Shared 条件导出、协议与运行时边界](docs/architecture.svg)

本图箭头表示模块依赖和导出，不是 RPC。真正的本地服务请求由 Node 客户端在调用时发出；CSS 通过独立子路径导入。

## 源码导航

| 文件 / 文件组 | 职责 |
| --- | --- |
| [src/index.ts](src/index.ts)、[src/browser.ts](src/browser.ts) | Node 与浏览器入口 |
| [src/types.ts](src/types.ts) | 跨工作空间业务类型和运行配置结构 |
| [src/config.ts](src/config.ts)、[src/paths.ts](src/paths.ts) | bootstrap、默认 runtime、固定持久路径与目录边界 |
| [src/hostd-protocol.ts](src/hostd-protocol.ts)、[src/terminal-protocol.ts](src/terminal-protocol.ts)、[src/vod-player-protocol.ts](src/vod-player-protocol.ts) | 本地服务请求/响应契约与解析 |
| [src/generated](src/generated) | 从协议源生成的绑定，配合根 protocol 脚本维护 |
| [src/vod-player-client.ts](src/vod-player-client.ts)、[src/playback-client.ts](src/playback-client.ts)、[src/media-stream-client.ts](src/media-stream-client.ts) | Node 本地媒体服务客户端 |
| [src/mcp-network.ts](src/mcp-network.ts)、[src/mcp-credentials.ts](src/mcp-credentials.ts) | 受控 MCP 网络和凭据合约 |
| [src/system-proxy.ts](src/system-proxy.ts) | 系统代理配置与网络行为辅助 |
| [src/monitoring.ts](src/monitoring.ts)、[src/monitoring-alerts.ts](src/monitoring-alerts.ts) | 指标查询、采集和告警领域类型 |
| [src/music.ts](src/music.ts)、[src/video.ts](src/video.ts)、[src/playback.ts](src/playback.ts)、[src/media-stream.ts](src/media-stream.ts) | 音乐、影视、共享播放和浏览器流类型 |
| [src/iscsi.ts](src/iscsi.ts)、[src/tailscale.ts](src/tailscale.ts)、[src/share-protocols.ts](src/share-protocols.ts) | 存储/网络共享领域合约 |
| [src/hud-tokens.css](src/hud-tokens.css) | Web、TV、文档复用的字体、色彩、间距、动效与几何变量 |

## 条件导出如何使用

```ts
import type { CyberOsRuntime } from "@cyberos/shared";
// Node 入口：
import { loadCyberOsRuntime } from "@cyberos/shared";
```

```css
@import "@cyberos/shared/hud-tokens.css";
```

浏览器入口不导出 config、paths 或 Node socket 客户端，video/playback/media-stream 等部分只导出类型。新增公共函数要检查其依赖是否安全进入浏览器，不能为了复用把 `node:fs`、凭据读取或 HTTP Unix socket 客户端加入 browser 入口。

独立子路径包括 vod-player-client、docker-images、docker-resources、photos-config、mcp-network 和 HUD CSS。显式子路径本身仍有运行环境要求，不等于自动获得 browser 条件隔离。

## Bootstrap 与业务设置

`loadBootstrap` 读取环境/根目录/API 监听配置；`createCyberOsRuntime` 构造默认功能配置；`loadCyberOsRuntime` 组合两者。API host 必须为 loopback，生产根固定 `/cyberos`，开发根默认仓库下 `.cyberos/dev-root`。

持久业务设置由 API、worker 等上层读取数据库并合并。许多旧的 `CYBEROS_*` 功能配置变量已移除，loader 会拒绝它们，要求通过产品设置修改。不要新增 README 示例继续使用这些旧开关。

| 路径 | 用途 |
| --- | --- |
| `<root>/data` | 存储池 namespace |
| `<root>/state/cyberos.sqlite` | 业务数据库 |
| `<root>/state/metrics.sqlite` | 独立指标库 |
| `<root>/state/secrets` | 分领域秘密文件 |
| `<root>/state/pi-agent` | Pi agent 资源 |
| `<root>/backup`、`apps`、`iso`、`vm` | 备份、受管 Compose、ISO 与 VM 数据 |
| `/run/cyberos` | 易失运行目录；某些客户端在开发使用 state 下 socket |

运行时路径不是源码目录；源码 `packages/` 与安装目录中的 `apps/` 不能相互替换。

## 协议与视觉契约

hostd/terminal/vod-player 协议包装生成类型并提供运行时解析、边界和帧限制。TypeScript 类型在编译后消失，所以不能用类型断言代替收到消息后的验证。

HUD tokens 是底层变量。Web 的 base.css 再映射语义变量，业务 CSS 和响应式层继续使用它们；公共设计变更需同步 [前端设计规范](../../docs/src/content/docs/reference/frontend-design.md)。当前产品是统一深色 HUD，图集自身的明暗切换不代表产品支持浅色主题。

## 开发与验证

本包直接导出源文件，由消费方打包，没有独立运行进程。

```bash
npx vitest run packages/shared
npm run protocol:check
npm run typecheck
```

修改生成协议应使用根 `protocol:generate` 并检查差异；修改 browser 导出、HUD tokens 或消费方协议后运行完整构建，防止只通过 Node 测试却破坏浏览器打包。
