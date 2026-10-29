---
title: 设置与启动环境
description: CyberOS 零配置安装、SQLite 系统设置和启动环境变量。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [packages/shared/src/config.ts, packages/shared/src/paths.ts, packages/db/src/repositories/settings.ts, packages/api/src/routes/settings.ts]
sidebar:
  order: 3
---

CyberOS 不使用产品配置文件。标准 Debian 安装无需参数即可启动，固定目录由安装包创建，用户可调设置保存在 `/cyberos/state/cyberos.sqlite` 的 `system_settings` 中。设置缺失时使用代码默认值但不会自动写库；设置记录损坏时读取接口返回 attention/error，PATCH 仍可用有效数据覆盖修复。

生产根目录固定为 `/cyberos`，API 只允许绑定 loopback。服务 socket、账号、重试、超时、采样频率和 Photos 地图发行资源属于代码常量，不提供隐藏高级编辑器。Docker、VM 和 Backup 默认关闭，必须在系统设置中显式启用；Backup 还必须先保存凭据并验证仓库。TV 模式默认开启，也由系统设置控制。

## 启动环境变量

常驻进程只接受启动 SQLite 前必须确定的变量：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `CYBEROS_ENVIRONMENT` | `development` 或 `production` | `development` |
| `CYBEROS_ROOT` | 开发根目录；生产必须为 `/cyberos` | 开发为 `.cyberos/dev-root` |
| `CYBEROS_API_HOST` | API 监听地址，只接受 loopback | `127.0.0.1` |
| `CYBEROS_API_PORT` | API 监听端口 | `3010` |
| `CYBEROS_ALLOWED_ORIGINS` | 逗号分隔的显式 CORS origin | 空 |

打包资产路径和进程间 socket 变量只供 systemd/构建内部使用，不是产品设置。安装器的镜像、registry、Nginx 端口等变量仅影响一次安装流程，不会写入产品设置。

开发环境示例：

```bash
mkdir -p .cyberos/dev-root/data/pool-1
CYBEROS_ENVIRONMENT=development \
CYBEROS_ROOT="$PWD/.cyberos/dev-root" \
npm run dev
```

## 系统设置

以下设置通过 Web 设置页或 `/api/settings/*` 管理，并由 API、worker、Agent/MCP 与对应 daemon 在操作时读取：

- System Profile：管理员显示名。
- Model Providers：模型端点和密钥。
- Pi Agent：capability 执行/审批策略与项目资源信任。
- MCP：默认开启的 CyberOS 内置 MCP，以及经测试和确认的第三方 Streamable HTTP Server。第三方凭据只写 `/cyberos/state/secrets/mcp`。
- Skills：安装在 `/cyberos/state/pi-agent/skills` 的全局 Skills，以及当前项目 `.agents/skills` 的只读信任状态。
- Docker 与虚拟机：只公开产品能力开关；socket、命令和超时固定。
- Monitoring：启用状态、raw/minute/hour 保留周期和指标库空间上限。采样频率固定，monitor 根据 `updated_at` 热重载。
- Backup：启用状态、仓库、挂载要求和 daily/weekly 保留策略。密码只写 `/cyberos/state/secrets/backup/restic-password`，读取响应只返回 `passwordConfigured`。
- Media / TV：TV 开关、输出模式、DRM connector、音频设备和硬件解码。TV 切换由 typed hostd 操作原子应用，失败不写库。
- Shares、Indexer、Photos 与 Downloads：继续使用各自的 typed SQLite 设置。共享账户密码只写 `/cyberos/state/secrets/share/account-password`，数据库、operation metadata 和读取响应均不保存或返回明文。

存储池不是设置记录。CyberOS 发现 `${CYBEROS_ROOT}/data` 下的一级真实目录，并使用目录名作为 `storagePoolId`；生产池必须直接挂载到 `/cyberos/data/<pool-id>`。

## Backup 恢复

定时备份从 SQLite 读取设置，保存设置不会隐式初始化仓库。灾难恢复可能发生在主库不存在时，因此只接受显式 CLI 参数：

```bash
cyberos-backup restore \
  --repository /path/to/repository \
  --password-file /path/to/password-file \
  --snapshot latest
```

CLI 不接受明文密码参数，也不会恢复任何全局产品配置文件。

## 运维检查

设置更新通常无需重启服务。修改 systemd unit 或 drop-in 后才需要 `daemon-reload`：

```bash
sudo systemctl daemon-reload
sudo systemctl restart cyberos-api.service
curl -fsS http://127.0.0.1:3010/api/system/health
```

不要把 `CYBEROS_API_HOST` 改为局域网地址。对外访问应由 Nginx 代理；当前版本没有登录认证，多用户或公网暴露不在安全边界内。
