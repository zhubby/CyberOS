# capabilities — 统一能力目录、契约与注册表

`@cyberos/capabilities` 定义 CyberOS 向 Agent/MCP 暴露的能力：稳定 ID、领域、输入输出 Schema、风险、scope、审批策略、结果格式和错误码。它也维护能力与 REST/界面结果的映射，供实现、测试和接入层核对。

本包是 Node 契约与注册库。具体领域动作由消费方注入 executor；提案持久化和批准后执行属于 [capability-runtime](../capability-runtime/README.md)。

[返回工作空间总览](../README.md) · [包定义](package.json)

## 架构图

![能力目录、请求 Schema 与注册执行架构](docs/architecture.svg)

MCP runtime 从目录生成描述符，补入执行器后注册。注册表在调用时执行 scope、可用性及输出上限检查；这层与持久审批状态机分开。

## 源码导航

| 文件 | 职责 |
| --- | --- |
| [src/index.ts](src/index.ts) | 公共导出 |
| [src/contracts.ts](src/contracts.ts) | descriptor/context/execution/result/error 和状态联合类型 |
| [src/parity-manifest.ts](src/parity-manifest.ts) | 能力 ID、REST、UI outcome、风险和审批映射；一致性校验 |
| [src/catalog.ts](src/catalog.ts) | 从 manifest 构造目录描述符，推导 scope、annotations 与限额 |
| [src/request-contracts.ts](src/request-contracts.ts) | 按能力 ID 提供输入 Schema |
| [src/media-contracts.ts](src/media-contracts.ts) | 媒体领域输入契约 |
| [src/schemas.ts](src/schemas.ts) | 严格对象、路径和分页的共享 Schema 片段 |
| [src/registry.ts](src/registry.ts) | 描述符注册、查询、scope 过滤和调用 |

## 能力描述符包含什么

| 字段 | 作用 |
| --- | --- |
| `id` | `cyberos.<domain>.<action>` 格式的能力身份 |
| `inputSchema` / `outputSchema` | 协议可检查的输入输出定义 |
| `risk` | read、low、medium、high、critical |
| `requiredScopes` | 客户端必须全部具备的权限集合 |
| `approval` | none、owner_control、first_party、first_party_confirm |
| `idempotency` | 无、可选或必需的幂等策略声明 |
| `maxOutputBytes` | 执行结果序列化后的字节上限 |
| `availability` / `execute` | 消费方可注入的可用性判断和执行函数 |

scope 通常按领域与 read/propose 生成；catalog、shell、关键电源操作和 owner-controlled run 取消有专门映射。应调用目录生成函数取得结果，避免在多个消费方分别复制这套规则。

## 注册与调用流程

1. `createCatalogDescriptors` 读取 manifest 和各能力请求 Schema，生成没有具体领域执行器的 descriptor。
2. 消费方根据运行环境和客户端策略装配 `availability`/`execute`。
3. `register` 拒绝非法 ID、重复 ID、非严格对象输入和非正输出上限。
4. 非 read 能力不能使用 `approval: none`；owner_control 只允许 runs 域的低风险控制。
5. `listForScopes` 过滤客户端可见能力；`invoke` 再次检查 scope，防止直接按 ID 绕过目录过滤。
6. 调用 availability；不可用或未注入执行器时返回 `NOT_READY`。
7. 执行器返回 `CapabilityExecution`，注册表检查 UTF-8 JSON 输出字节数。
8. 调用方用 `capabilityResult` 封装 schemaVersion、warnings、page、runId 和 traceId。

`invoke` 不运行通用 JSON Schema 验证器，也不自动执行第一方审批。输入解析由 MCP Schema/领域解析器共同承担，审批由 runtime 承担；声明契约不能替代这两层实现。

## 错误与状态

`CapabilityError` 提供稳定 code、retryable 与可选 runId。错误格式化函数保留 traceId，使协议层能区分输入错误、权限拒绝、未就绪、冲突、审批拒绝/过期、取消、限流和内部失败。

契约中的运行状态为 `queued`、`running`、`waiting_approval`、`succeeded`、`failed`、`cancelled`、`expired`。本包只定义状态集合；合法转换、revision 条件和持久化由 db/runtime 实现。

目录默认输出上限是 256 KiB。它限制协议返回体，不能替代文件下载流、分页或底层查询的资源限制。

## 增加能力时的配套修改

先在 manifest 写清可观察的 UI outcome、REST 映射、风险和审批，再添加请求 Schema。随后在 MCP/runtime 或 API 注入真实适配器；只写目录项不会产生可执行功能，目录应明确返回不可用状态。

不能新增让 MCP 自己批准提案的能力。外部读目录、内置 Pi 提案、第一方审批是不同角色；`validateParityManifest` 会检查一部分静态约束，实际接入还需协议测试。

## 开发与验证

```bash
npx vitest run packages/capabilities
npm run typecheck
```

[registry 测试](src/registry.test.ts) 验证注册与权限检查；[parity-routes 测试](src/parity-routes.test.ts) 对照 REST；[media-contracts 测试](src/media-contracts.test.ts) 覆盖媒体输入。

本包不启动端口、不读写业务库。调试完整工具链时继续查看 [MCP](../mcp/README.md)、[审批执行](../capability-runtime/README.md) 和 [API](../api/README.md)。
