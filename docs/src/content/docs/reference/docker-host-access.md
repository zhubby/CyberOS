---
title: Docker 宿主观测授权
description: Docker 面板 Host Access 的能力目录、安全边界、部署验收与暂不支持项。
type: reference
status: current
audience: [operator, developer]
sourceOfTruth:
  - packages/api/src/lib/docker-host-access.ts
  - packages/api/src/lib/docker-host-access-control.ts
  - crates/host-accessd/src/main.rs
  - crates/host-accessd/src/proxy.rs
  - crates/hostd/src/host_access.rs
  - packaging/systemd/cyberos-host-accessd.service
sidebar:
  order: 7
---

Host Access 为 Compose App 和单容器提供同一套宿主观测授权。它不是 Netdata 模板，也不会改写用户 Compose；Netdata 与 `prom/node-exporter` 只是兼容性验收对象。所有授权默认关闭，宿主来源由 API 固定，用户只能选择能力、Compose service、ready storage pool 和规范化的容器内绝对路径。

## 能力与当前状态

| 能力 | 固定来源 | 默认目标或注入 | 当前实现 |
| --- | --- | --- | --- |
| `host_os_identity` | `/etc/os-release`、`/etc/localtime`、`/etc/machine-id` | `/host/etc` | 可用，只读 |
| `host_processes` | `/proc` | `/host/proc` | rootful Docker 可用；不启用 host PID namespace |
| `host_sys` | `/sys` | `/host/sys` | rootful Docker 可用；userns 下标记降级 |
| `nas_capacity` | storage pool 内空的 `.cyberos-host-access-capacity` | `/host/nas/<storagePoolId>` | root ready 且锚点身份有效时可用 |
| `account_map` | `/etc/passwd`、`/etc/group` | `/host/etc` | 可用，只读 |
| `docker_metadata` | 字段白名单 Docker HTTP 代理 | `DOCKER_HOST` | 代码已实现，兼容测试通过前保持不可用 |
| `systemd_status` | 计划中的只读 D-Bus facade | `DBUS_SYSTEM_BUS_ADDRESS` | 尚未实现，保持不可用 |

`GET /api/docker/host-access` 返回策略版本、厂商无关的 `provides`/`requires`/`recommends`、coverage、storage pools 和 `available | degraded | unavailable` 原因。rootless Docker 会关闭 `/proc`、`/sys` 能力；user namespace 会把它们标为降级。页面和服务端都不得把降级或不可用能力静默提升为可用。

有授权的 service 固定使用 `cap_drop: [ALL]` 与 `no-new-privileges:true`，保留 Docker 默认 seccomp/AppArmor。策略拒绝 privileged、host network/PID/IPC/UTS/cgroup namespace、userns override、capability、device、security option，以及与受管挂载重叠的目标。Compose 会依次检查原始 YAML、插值后的配置和最后加载受管 override 的最终配置。

## 执行与状态

未请求 Host Access 的容器按普通创建流程执行。请求 Host Access 时，API 先拉取镜像、解析不可变 image ID，并在执行前重新检查策略、storage pool 身份、目标和完整指纹；环境值和宿主来源不进入公开响应或 operation metadata。Compose action 使用短时私有 draft 固定 image 与资源指纹，最后一个受管 override 会把获授权 service 的 `image` 固定为已校验的 image ID，避免校验后仍从可变标签启动。第一方页面负责显式确认，API 写入 Docker operation，不创建 capability approval。漂移返回 `409`，依赖或代理不可用返回 `503`。

Compose 沿用 `revision`、`deployedRevision` 和 `needsDeploy`。授权变化只能执行全项目 `up --force-recreate`，不能只应用一个 service。界面只显示“待应用”“已生效”“需修复”；运行态会 inspect Compose 容器并核对策略版本、授权摘要、完整指纹、实际 image ID 和代理 socket。已部署运行态仍完整匹配时显示“待应用”，部分重建、标签漂移或依赖不确定时显示“需修复”。展开详情和 coverage report 才显示 service 差异、降级原因与永久不支持项。单容器授权不可原地修改，撤销需删除并重新创建容器。

API 启动时会清理过期 draft，运行期间也会每分钟清理一次，并从运行中、由 CyberOS 管理且策略版本匹配的容器标签恢复代理 grant 目录。标签缺少 fingerprint、策略过期或不是 `io.cyberos.managed=true` 时不会触发恢复。

## 代理启用与验收

`cyberos-host-accessd.service` 以非 root `cyberos` 用户运行，只加入 `docker` 组，通过 Unix peer credential 接受 API 控制请求。容器挂载授权目录而不是原始 Docker socket inode；systemd 在服务 restart 期间保留该目录，daemon 启动时只扫描两层哈希授权目录并重建其中已有的代理 socket。代理只允许 `_ping`、version/info、容器与网络 list/inspect，重建响应 JSON 并删除环境、命令、敏感 labels 和宿主 mount source，同时限制方法、查询参数、并发、响应大小与超时。

包内 unit 默认设置 `CYBEROS_HOST_ACCESS_DOCKER_COMPATIBLE=0`。只有在目标机上用真实采集器通过 allow/deny、字段脱敏、重连和负载测试后，才能用 systemd drop-in 设置为 `1` 并重启服务：

```ini
[Service]
Environment=CYBEROS_HOST_ACCESS_DOCKER_COMPATIBLE=1
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart cyberos-host-accessd.service cyberos-api.service
sudo systemctl status cyberos-host-accessd.service --no-pager
sudo journalctl -u cyberos-host-accessd.service -u cyberos-api.service -n 200 --no-pager
curl -fsS http://127.0.0.1:3010/api/docker/host-access
```

验收必须用手写 Netdata Compose 与 `prom/node-exporter` 分别验证 CPU、内存、进程、物理网卡、cgroup、NAS 容量和 Docker 容器分组。拒绝日志中若出现采集器需要写操作、原始 socket 或未脱敏字段，保持能力不可用，不放宽代理。当前尚未在 `192.168.11.91` 完成这组真实设备验收，因此 Docker metadata 默认不可用是预期行为。

## 明确不开放与增强条件

以下能力当前不提供：任意宿主路径、宿主 `/`、完整 `/var/log`、原始 Docker socket、原始 system D-Bus、整个 `/dev`、任意设备直通、host network、host PID、journald 原始日志、SMART/NVMe、rootfs 容量、`SYS_ADMIN`、`SYS_PTRACE`、`SYS_RAWIO`、`cap_add: ALL`、unconfined AppArmor、debugfs、perf、IPMI、slabinfo 和低层内核指标。

后续增强必须逐项满足以下前置条件，不能用扩大容器权限替代：

1. systemd 状态：实现独立 facade，只允许 `ListUnits`、`ListUnitsByPatterns`、`GetUnit`、`GetUnitFileState` 和安全 Properties；加入 destination、method、property 与 signal 拒绝测试后再启用。
2. SMART/NVMe：先建立 `/dev/disk/by-id + major/minor + serial` 的稳定设备身份、热插拔漂移检测和只读 host helper 协议；不开放原始设备节点或 `SYS_RAWIO`。
3. journald：如有明确产品需求，新增字段白名单、unit 范围、时间窗、响应上限和敏感值过滤的查询代理；不挂载 journal 目录。
4. rootfs 容量：继续由 CyberOS 原生监控提供，不加入容器授权目录。NAS 只通过空容量锚点暴露文件系统容量，不暴露 NAS 文件。
5. 低层内核指标：只有在无需 debugfs/perf/额外 capability 的受控接口存在且经过采集器兼容测试时再单独立项；否则 coverage 永久显示不支持。

每次增强都要更新 catalog reason code、coverage、资源指纹、代理 allow/deny 测试、打包验收和本文，且必须保留 `400` 非法配置、`409` 漂移、`503` 宿主依赖不可用的错误语义。
