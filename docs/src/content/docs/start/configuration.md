---
title: 配置与环境变量
description: SigmaOS TOML 配置、环境变量覆盖规则和安全默认值。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [packages/shared/src/config.ts, config.example.toml, packaging/etc/config.toml]
sidebar:
  order: 3
---

生产配置默认位于 `/etc/sigmaos/config.toml`，可通过 `SIGMAOS_CONFIG` 覆盖。环境变量优先于 TOML；解析后会规范化路径、端口、超时、NAS roots、备份、Docker、VM、terminal 和 health 设置。开发环境建议通过环境变量显式指定 `.sigmaos/dev-data` 和测试 NAS root，避免使用仓库所在磁盘的根路径。

最重要的约束是：API 只能绑定 loopback；生产 NAS root 默认要求 mount readiness；Docker 默认关闭；备份仓库必须显式初始化；provider secret 只返回“是否已配置”。完整字段和环境变量应以 `packages/shared/src/config.ts` 为准。

## 最小开发配置

不建议直接把带有生产路径和 VM 开关的 `config.example.toml` 当作开发配置。可以使用以下环境变量覆盖默认值：

```bash
SIGMAOS_ENVIRONMENT=development
SIGMAOS_DATA_DIR=.sigmaos/dev-data
SIGMAOS_NAS_ROOTS=dev:开发 NAS:.sigmaos/dev-data/nas
SIGMAOS_API_HOST=127.0.0.1
SIGMAOS_API_PORT=3010
SIGMAOS_DOCKER_ENABLED=0
SIGMAOS_VM_ENABLED=0
SIGMAOS_BACKUP_ENABLED=0
```

`SIGMAOS_NAS_ROOTS` 和 `SIGMAOS_VM_ISO_ROOTS` 支持逗号分隔的多个路径；带冒号的 root 使用 `id:name:path` 格式。生产模式会额外校验 NAS root 和 backup repository 必须位于允许的 `/srv` 范围内，且 backup、staging、data directory 不能互相覆盖。

## Photos 离线地图镜像

默认地图资产来自 SigmaOS 的固定 GitHub Release。只在设备无法访问 GitHub 时配置同字节 HTTPS 镜像：

```toml
[photostaff]
basemap_url = "https://mirror.example.com/sigmaos/natural-earth-ii-3.2.0-raster.pmtiles"
```

环境变量 `SIGMAOS_PHOTOSTAFF_BASEMAP_URL` 优先于 TOML。这里的 `photostaff` 是内部模块和数据目录标识；公开界面与 API 仍使用 Photos。该设置只替换下载地址，不能改变文件名、大小或 SHA-256；`http://`、不同版本和重新编码的文件都会被拒绝。成品仍写入 `${SIGMAOS_DATA_DIR}/photostaff/maps/`，不写入 NAS root。

## 生产配置检查

修改 `/etc/sigmaos/config.toml` 后，先用只读 API 检查配置效果，再重启依赖服务：

```bash
sudo systemctl restart sigmaos-api.service sigmaos-worker@1.service
curl -fsS http://127.0.0.1:3010/api/roots/readiness
curl -fsS http://127.0.0.1:3010/api/system/health
```

不要把 `SIGMAOS_API_HOST` 改为局域网地址。对外访问应由 Nginx 代理；当前版本没有登录认证，多用户或公网暴露不在安全边界内。
