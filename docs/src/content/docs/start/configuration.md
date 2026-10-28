---
title: 配置与环境变量
description: CyberOS TOML 配置、环境变量覆盖规则和安全默认值。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [packages/shared/src/config.ts, config.example.toml, packaging/etc/config.toml]
sidebar:
  order: 3
---

生产根目录固定为 `/cyberos`，配置固定为 `/cyberos/config/config.toml`；开发环境可以通过 `CYBEROS_ROOT` 和 `CYBEROS_CONFIG` 指向隔离目录。环境变量优先于 TOML；解析后会规范化路径、端口、超时、NAS roots、备份、Docker、VM、terminal、monitoring 和 health 设置。

最重要的约束是：API 只能绑定 loopback；生产 NAS root 默认要求 mount readiness；Docker 默认关闭；备份仓库必须显式初始化；provider secret 只返回“是否已配置”。完整字段和环境变量应以 `packages/shared/src/config.ts` 为准。

`CYBEROS_HOST_MUTATION_POLICY` 接受 `mutable` 或 `declarative`，默认是 `mutable`。Debian 部署保持默认行为；NixOS module 固定设置为 `declarative`。声明式模式只限制宿主机配置写入：共享、存储池、NetworkManager 和 Docker daemon 配置由外部系统管理，API 对这些写请求返回 501，读取与状态采集继续工作。不要在普通 Debian 安装上设置 `declarative`，除非另一个配置管理系统已经接管这些资源。

## 最小开发配置

不建议直接把带有生产路径和 VM 开关的 `config.example.toml` 当作开发配置。可以使用以下环境变量覆盖默认值：

```bash
CYBEROS_ENVIRONMENT=development
CYBEROS_ROOT=.cyberos/dev-root
CYBEROS_NAS_ROOTS=dev:开发 NAS:.cyberos/dev-root/data/primary
CYBEROS_API_HOST=127.0.0.1
CYBEROS_API_PORT=3010
CYBEROS_DOCKER_ENABLED=0
CYBEROS_VM_ENABLED=0
CYBEROS_BACKUP_ENABLED=0
```

## Monitoring

监控默认开启，指标库路径由 `CYBEROS_ROOT` 推导为 `${CYBEROS_ROOT}/state/metrics.sqlite`。生产默认值为：fast 10 秒、standard 30 秒、温度 5 分钟；raw 保留 48 小时、1m 保留 30 天、1h 保留 1 年；容量上限 512 MiB。

```toml
[monitoring]
enabled = true
fast_sample_interval_ms = 10000
standard_sample_interval_ms = 30000
temperature_sample_interval_ms = 300000
raw_retention_ms = 172800000
minute_retention_ms = 2592000000
hour_retention_ms = 31536000000
max_database_bytes = 536870912
```

同名 `CYBEROS_MONITORING_*` 环境变量优先于 TOML；容量只允许 64 MiB–4 GiB，采样和保留值必须满足配置校验。设置 `enabled = false` 后 monitor service 保持 active/idle，API 和页面显示 Disabled，Health 不生成 `monitoring_unavailable`，alerter 也不会求值 metric rules。修改监控配置后重启 `cyberos-api.service`、`cyberos-monitor.service` 和 `cyberos-alerter.service`。

SMTP 与 Health severity 路由通过 Settings > Alerts 或 `/api/monitoring/alerts/*` 管理并保存在主库，不写入 TOML。API 不返回 SMTP 密码；清空、轮换凭据和测试投递都应通过告警设置接口完成。

Agent worker 默认并行处理两个不同 session，同一 session 仍由数据库 lease 串行化。可通过 `[worker].concurrency` 或 `CYBEROS_WORKER_CONCURRENCY` 调整单个 worker 的并行度；多 worker 实例共享同一套 lease 约束。

`CYBEROS_NAS_ROOTS` 和 `CYBEROS_VM_ISO_ROOTS` 支持逗号分隔的多个路径；带冒号的 root 使用 `id:name:path` 格式。生产 NAS root 必须是 `/cyberos/data` 的直接子目录，且不能使用保留的 `/cyberos/data/backup`；backup repository、staging 和 NAS root 不能互相覆盖。

## Photos 离线地图镜像

默认地图资产来自 CyberOS 的固定 GitHub Release。只在设备无法访问 GitHub 时配置同字节 HTTPS 镜像：

```toml
[photostaff]
basemap_url = "https://mirror.example.com/cyberos/natural-earth-ii-3.2.0-raster.pmtiles"
```

环境变量 `CYBEROS_PHOTOSTAFF_BASEMAP_URL` 优先于 TOML。这里的 `photostaff` 是内部模块和数据目录标识；公开界面与 API 仍使用 Photos。该设置只替换下载地址，不能改变文件名、大小或 SHA-256；`http://`、不同版本和重新编码的文件都会被拒绝。成品写入 `${CYBEROS_ROOT}/state/photostaff/maps/`，生产路径为 `/cyberos/state/photostaff/maps/`，不写入 NAS root。

## 生产配置检查

修改 `/cyberos/config/config.toml` 后，先用只读 API 检查配置效果，再重启依赖服务：

```bash
sudo systemctl restart cyberos-api.service cyberos-worker@1.service
curl -fsS http://127.0.0.1:3010/api/roots/readiness
curl -fsS http://127.0.0.1:3010/api/system/health
```

不要把 `CYBEROS_API_HOST` 改为局域网地址。对外访问应由 Nginx 代理；当前版本没有登录认证，多用户或公网暴露不在安全边界内。
