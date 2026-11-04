# hostd — 受限的主机特权操作服务

`cyberos-hostd` 是 CyberOS 与 Linux 特权能力之间的执行边界。API 通过本地 Unix socket 提交类型明确的操作，hostd 校验调用者、协议和输入，再执行存储、共享、网络、蓝牙、Tailscale 与系统管理操作。

它以 root 运行，但不提供任意 Shell 命令接口。产品层的用户授权与 Agent 审批仍由调用侧负责；hostd 再实施独立的主机身份和操作约束。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-hostd.service)

## 架构图

![hostd 权限与执行架构](docs/architecture.svg)

协议入口、按域互斥和实际系统操作分开。恢复任务也通过相应领域锁执行，避免定时恢复和用户变更同时改写同一资源。

## 运行边界

| 项目 | 约定 |
| --- | --- |
| 进程身份 | root，由 `cyberos-hostd.service` 启动 |
| IPC | `/run/cyberos/hostd.sock`，JSONL v1 |
| 允许调用 UID | root 与 `cyberos` 用户；具体值由配置加载器解析 |
| socket 组 | `cyberos` |
| 最大请求帧 | 1 MiB |
| 连接数量 | 最多 64 个并行连接任务 |
| 帧与响应写入超时 | 各 5 秒；实际操作另有各模块超时 |
| 数据范围 | `CYBEROS_ROOT/data`，生产根目录固定 `/cyberos` |

业务数据库由 API 等进程管理；hostd 的主要持久化是受管系统配置、状态文件、备份和恢复事务。

## 源码结构与操作域

| 路径 | 职责与外部系统 |
| --- | --- |
| [src/main.rs](src/main.rs)、[src/config.rs](src/config.rs) | 服务启动、日志和允许身份/路径 |
| [src/protocol.rs](src/protocol.rs) | 请求/响应 envelope、版本、UUID、操作和契约映射 |
| [src/server.rs](src/server.rs) | Unix listener、peer credentials、分域锁、派发与恢复调度 |
| [src/command.rs](src/command.rs) | `CommandRunner` 抽象、固定参数进程执行、输出上限和超时 |
| [src/storage.rs](src/storage.rs)、[storage/](src/storage/) | 存储查询、建池/删池、块设备占用、fstab 与挂载配置 |
| [src/shares.rs](src/shares.rs)、[shares/](src/shares/) | 共享配置校验、渲染、ACL、账号凭证、文件替换与恢复 |
| [src/iscsi.rs](src/iscsi.rs) | 校验 iSCSI 请求，调用固定 root helper 并对账 LIO 状态 |
| [src/docker_daemon.rs](src/docker_daemon.rs)、[docker_daemon/](src/docker_daemon/) | Docker daemon 配置的版本检查、保存、重启和回滚 |
| [src/network_manager.rs](src/network_manager.rs)、[network_manager/](src/network_manager/) | NetworkManager、Wi-Fi/热点、以太网应用与确认事务 |
| [src/bluetooth.rs](src/bluetooth.rs) | BlueZ 设备操作、扫描、配对挑战与连接 |
| [src/tailscale/](src/tailscale/) | tailscaled LocalAPI、服务状态、登录和配置确认事务 |
| [src/power.rs](src/power.rs)、[src/ops.rs](src/ops.rs) | 固定的电源与运维操作 |
| [src/tv.rs](src/tv.rs) | 调用固定 TV 模式脚本 |
| [src/host_access.rs](src/host_access.rs) | 存储池容量访问锚点的受限创建和对账 |
| [src/error.rs](src/error.rs) | 稳定错误码、HTTP 风格状态、细节与敏感信息清理 |

## 一次请求的生命周期

1. API 的 [HostdClient](../../packages/api/src/lib/hostd-client.ts) 连接本地 socket。
2. 服务检查内核提供的 peer UID，拒绝非允许身份。
3. 在帧大小和读取超时范围内读取一个 JSONL 请求。
4. 验证 `version`、UUID `id`、`operation`，再反序列化为对应的严格类型 payload。
5. 按操作域取得锁。共享、存储、Docker、网络、蓝牙、Tailscale、电源、运维和 TV 各有对应锁；iSCSI 与存储操作共享存储锁。
6. 模块先校验参数、路径、当前状态或配置 revision，再调用固定命令或 D-Bus/LocalAPI。
7. 必要时登记恢复事务、备份旧配置、执行变更并检查结果；失败按模块协议回滚或返回待恢复状态。
8. 返回携带原请求 `id` 的成功结果或结构化错误，然后结束本次连接处理。

UID 校验不等于产品审批完成；它说明调用进程身份允许进入特权服务。新增 operation 必须同时考虑 API 权限、payload 校验、执行器、回滚和 TypeScript 契约。

## 公开操作族

| operation | 用途 |
| --- | --- |
| `shares.apply` | 应用共享定义、服务配置、账号与 ACL |
| `iscsi.manager` | iSCSI 管理与状态 |
| `storage.command` | 受限存储查询命令 |
| `storage.operation` | 存储变更操作 |
| `docker.daemon` | Docker 配置读取、保存与应用 |
| `network.manager` | 网络状态、配置与连接控制 |
| `bluetooth.manager` | 蓝牙扫描、配对与连接 |
| `tailscale.manager` | Tailscale 状态、登录、设置和确认 |
| `system.power` | 系统电源操作 |
| `system.ops` | 固定运维任务 |
| `system.tv` | TV 模式切换 |

嵌套 action 与字段以各模块类型为准，不能把 `operation` 名称当作任意子命令入口。部分无变更的探测请求可走不持有变更锁的分支。

## 变更事务与恢复

**网络配置。** 以太网管理保存目标配置与事务，设置确认窗口（当前 checkpoint 常量为 90 秒），应用后检查运行结果，未确认或到期进入恢复。启动时先恢复未完成的以太网事务，失败可能阻止服务开始监听。

**Tailscale。** 应用前比较当前 revision，先持久化变更意图，再调整转发配置和 LocalAPI prefs。当前确认期限为 60 秒；确认时复核设备身份、目标配置和转发文件，变化或超时会触发回滚。

**Docker。** 保存前校验 revision 与配置内容，再原子替换并维护基线。保存和重启是不同动作；重启失败会尝试恢复最近应用的配置，并返回回滚结果。

**共享与存储。** 共享模块组合配置文件快照、凭证、ACL 与服务应用；存储模块检查设备占用、现有阵列和挂载目标。iSCSI 调用固定的 [iscsi.py](../../packaging/helpers/iscsi.py)，并与存储操作互斥。各模块的恢复范围不同，不能假定所有主机副作用都具有统一的反向事务。

运行循环还定期处理网络/Tailscale 到期事务、iSCSI 对账和容量锚点对账。设备状态恢复与请求返回属于不同时间范围，排查时需要结合日志和持久化事务。

## 安全设计与扩展约束

- 客户端提交结构化输入，执行器构造固定程序与参数；不把用户字符串拼成 Shell 命令。
- 请求 schema 和各领域校验共同限制设备路径、共享路径、标识符、配置内容和允许状态。
- 读取命令与长时变更使用不同超时/输出约束；错误消息清理敏感信息。
- systemd 使用 `ProtectSystem=strict`、有限可写目录和有限 capability 集。它仍是高权限进程，不能扩大成通用远程执行服务。
- 动态账号、Samba、fstab、NetworkManager 和 configfs 的文件权限/沙箱条件属于架构的一部分，不能只改 Rust 调用代码。
- 新增协议时还需检查 [协议生成脚本](../../scripts/generate-protocol-bindings.mjs) 及 API 消费端，保持跨语言类型一致。

## 开发与验证

在仓库根目录执行只针对软件的检查：

```bash
cargo check --locked -p cyberos-hostd
cargo test --locked -p cyberos-hostd
npm run protocol:check
```

`CommandRunner` 和可注入路径用于隔离测试。hostd 包含真实主机变更，不应把设置 `CYBEROS_ROOT` 视作所有 `/etc`、systemd 和设备操作都已隔离，也不应直接以 root 在日常 Mac/主机上试跑变更。

Linux 部署验收应使用受控测试设备，分别验证服务权限、协议、目标操作和失败恢复；模拟命令通过不证明 RAID、网络切换、蓝牙配对或共享客户端实际可用。

```bash
systemctl status cyberos-hostd.service
journalctl -u cyberos-hostd.service -n 100 --no-pager
```

## 继续阅读

- [host-accessd](../host-accessd/README.md)：容器元数据读取代理，与 root 执行器不同。
- [bluetoothd](../bluetoothd/README.md)：OBEX 文件传输；[audiod](../audiod/README.md)：蓝牙音频 I/O。
- [CyberMachine 操作指南](../../docs/src/content/docs/operations/cybermachine.md)：组件部署与实机验证。
