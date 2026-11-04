# mcp-cli — 本地 MCP 配对、Token 与 TLS 管理

`@cyberos/mcp-cli` 是主机管理员使用的一次性管理程序，构建后由 `cyberos-mcp` 包装脚本调用。它管理 MCP 客户端配对和 token 生命周期，并可准备 TLS 证书与 Nginx 入口。

它不是 stdio MCP 客户端或 HTTP 转发器。client 命令写业务数据库和必要的 Pi token 文件；tls 命令还会修改证书、Nginx 配置并校验/重载服务。

[返回工作空间总览](../README.md) · [包定义](package.json) · [安装包装脚本](../../packaging/scripts/cyberos-mcp)

## 架构图

![MCP CLI 配对管理、凭据文件与 TLS 架构](docs/architecture.svg)

配对与 TLS 是两条管理路径。完成证书配置不等于外部 MCP 已开启，API 仍检查 runtime 的 externalEnabled 和 HTTPS 条件。

## 实现与启动

实现集中在 [src/index.ts](src/index.ts)：顶部负责身份检查、runtime 与数据库生命周期，随后按命令分派到配对、TLS、文件安装和 Nginx 操作。

默认要求 root。`CYBEROS_MCP_ALLOW_NON_ROOT=1` 是显式的非 root 运行开关，不会自动提供访问生产数据库、秘密目录或 Nginx 的权限。普通开发不应通过它接触生产根目录。

## 配对命令

| 命令 | 行为 |
| --- | --- |
| `client create` | 创建客户端和随机 token，验证 scope，输出配对信息 |
| `client list` | 列出 ID、kind、tokenPrefix、scope、过期/撤销/最近使用时间，不重新显示原 token |
| `client rotate <id>` | 轮换 token；Pi 配对同时更新已安装凭据文件 |
| `client revoke <id>` | 撤销客户端，协调待处理 run；Pi 客户端还删除安装 token |

create 可用 `--name`、`--kind`、`--scopes`、`--expires`。默认 kind 为 lan；默认 scope 为 catalog read。Pi 使用专门的目录 scope 集合，并限制只能有一个未撤销的 Pi 客户端。

新 token 仅在创建/轮换结果中显示。应直接存入目标客户端，避免把命令 JSON 当普通调试日志公开。服务端认证记录由 [MCP clients Repository](../db/src/repositories/mcp-clients.ts) 管理。

## Pi Token 安装与恢复

create Pi 客户端后安装本机 token 文件；安装失败会撤销新客户端并清理对应文件，避免留下只完成一半的配对。

rotate 在改库前读取旧 Pi token，更新数据库后安装新 token。若文件安装失败，会尝试恢复旧数据库 token 和文件；恢复也失败时明确报告需修复配对，不能把这次轮换当成成功。

token 文件位置由 shared runtime 的 `mcp.piTokenFile` 决定。worker 从该位置读取凭据连接内置 MCP，路径或权限变化会影响 Agent 工具可用性。

## TLS 初始化

`tls init` 要求至少一个未撤销的 LAN 客户端。默认生成私有 CA 和服务证书，也可通过 `--cert`、`--key` 与可选 `--ca` 使用现有证书；hostname、端口、证书内容和可读性会被检查。

流程创建受限权限目录，拒绝覆盖已有证书目标，生成/复制文件，设置私钥权限，写入站点，运行 `nginx -t` 并 reload。Nginx 配置安装失败时恢复原站点/链接；TLS 外层失败清理由本次创建的目标。

证书在 `<root>/config/mcp-tls`，站点默认位于 `/etc/nginx/sites-available` 和 `sites-enabled`。Nginx 目录及跳过校验的环境开关用于显式受控环境，不能据此宣称真实 TLS 入口已经验收。

标准 runtime 保持 `externalEnabled=false`。即使生成 `https://<host>:8443/mcp` 配置，仍需受管的运行时启用链路；命令返回的 enabled/nextStep 要一并阅读。

## 构建与使用

在仓库根目录构建：

```bash
npm run build -w @cyberos/mcp-cli
```

安装后的只读客户端列表命令如下，也会打开/验证当前配置的业务库：

```bash
sudo cyberos-mcp client list
```

创建、轮换、撤销和 TLS 都属于实际状态变更，应使用明确的目标根目录与管理员上下文。CLI 没有单独的 dev server，也没有作为本包 script 暴露的 test 命令。

## 验证与排查

```bash
npm run typecheck
npx vitest run packages/db/src/capability-runs.test.ts packages/mcp
```

客户端 Repository 与 MCP 协议测试验证配对消费链路；CLI 的真实文件权限、OpenSSL、Nginx 校验/回退和服务重载需在隔离 Linux 环境验证。排查时区分数据库客户端状态、Pi token 文件、API 接入开关和外部 TLS 连通性。
