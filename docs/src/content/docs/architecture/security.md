---
title: 安全与信任模型
description: ZOS 的 loopback、NAS root、审批和宿主机权限边界。
type: explanation
status: current
audience: [developer, operator]
sourceOfTruth: [packages/api/src/server.ts, packages/api/src/lib/docker-registry.ts, packages/api/src/lib/docker-compose.ts, packages/api/src/lib/docker-host-access.ts, crates/host-accessd/src/proxy.rs, packages/db/src/repositories/docker-registry-credentials.ts, packages/db/src/repositories/docker-compose-apps.ts, packages/nas-tools/src/path-safety.ts, crates/hostd/src/server.rs, crates/hostd/src/network_manager/ethernet.rs, crates/termux/src/server.rs, crates/termux/src/pty.rs]
sidebar:
  order: 3
---

v1 假设可信的单用户设备，没有多用户认证边界。API 强制绑定 loopback；Nginx 可以把它代理到局域网，但这不等于增加了认证。

所有 NAS 路径都相对于已配置 root 解析，拒绝 traversal、绝对路径和不安全的符号链接逃逸。Pi 的文件与 shell 能力遵循 Agent 策略中的 `auto`、`approve`、`confirm`、`disabled` 四档；MCP 文件 mutation 仍创建不可变 approval proposal。approval 只属于 Agent 对话，Workspace 面板操作不会创建 approval。trash 是可恢复隔离区，v1 不永久删除。

Docker socket 近似 root 权限。Rust `hostd` 通过受限 root Unix socket 执行 allowlist 配置与命令；Rust `termux` 验证 Unix peer UID，并以固定的非 root `zos` 用户运行 native PTY。systemd 使用 `ProtectSystem=strict`、`NoNewPrivileges` 和最小 capability 集合。

NixOS module 把 `ZOS_HOST_MUTATION_POLICY` 固定为 `declarative`。API 和 hostd 双层拒绝共享、持久存储、Docker daemon 与 NetworkManager 配置写入，返回 HTTP 501 / hostd `unsupported`；hostd 也不会执行 NetworkManager 启动恢复和周期恢复写入。读取、扫描和状态汇总仍可用。该边界要求操作者通过 NixOS 配置管理宿主资源，但不会把 `/zos`、NAS 数据或应用状态变成不可写。

Docker Host Access 不把原始 Docker socket、system D-Bus、宿主根目录或设备节点交给容器。固定只读宿主来源由策略解析器物化；Docker metadata 经过非 root `zos-host-accessd` 的方法与字段白名单代理，兼容标记默认关闭。Host Access service 强制 drop all capabilities 与 no-new-privileges，并拒绝 privileged、host namespace、device、capability 和 security option 冲突。完整授权指纹、环境值与宿主路径只保存在权限受限的服务端状态，公开审批只返回能力、风险和 image digest 摘要。完整边界见 [Docker 宿主观测授权](/docs/reference/docker-host-access/)。

Ethernet 管理只允许按探测到的永久 MAC 写入固定 `zos-ethernet-<mac>.nmconnection`，D-Bus 调用固定为 NetworkManager checkpoint 的 create/destroy/rollback，调用方不能传入任意 service、对象、方法、unit 或文件路径。期望配置、备份和事务清单位于 root-only NetworkManager StateDirectory；API 只能经 hostd 协议提交结构化配置，不获得 `/etc/NetworkManager` 写权限。该保护仍不能阻止拥有 SSH root 权限的管理员直接修改网络。

Docker Registry 密码和 access token 按产品选择以未加密形式保存在权限受限的 SQLite `system_settings` 记录中；数据库文件权限是静态保护边界，设备状态备份可能包含这些凭证。公开 API 只返回是否已配置，不回传明文；日志、operation metadata、错误与通知不得包含密码或认证头。

Engine 拉取使用内存中的 `X-Registry-Auth`，不会调用 `docker login`。Compose `pull/up` 在 systemd `PrivateTmp` 内创建 `0700` 临时目录和 `0600 config.json`，只通过子进程 `DOCKER_CONFIG` 注入，并在成功、失败或超时后清理；没有 Registry 记录时也注入空认证配置，避免继承宿主机的旧凭证。不要在故障报告中粘贴 SQLite 记录或临时认证配置正文。该能力不修改 hostd、systemd capability 或 `/etc/docker/daemon.json` 的权限边界。

托管 Compose App 的 YAML、环境变量与 revision 以 SQLite 为唯一数据源。环境变量同样是受限明文，设备状态备份可能包含这些值；公开接口只返回键名和是否配置。API 仅能写 `/zos/apps` 这一新增路径，以 `zos:zos 0750` 目录、`0640` Compose 文件、`0600` `.env` 和 App ID 管理标记发布运行副本，不获得 root、capability 或 hostd 权限。结构化校验拒绝额外本地项目文件和相对 bind mount；绝对 bind mount 必须落在已配置且在线的 NAS root。该边界防止 ZOS UI 误删，不能阻止拥有 SSH root 权限的管理员修改 `/zos/apps`。

镜像删除必须显式确认。服务端先解析目标镜像 ID 并检查全部容器的引用，再以 `force=false`、`noprune=true` 请求 Engine；即使目标只是多标签镜像中的一个 tag，也拒绝操作被容器引用的镜像。
