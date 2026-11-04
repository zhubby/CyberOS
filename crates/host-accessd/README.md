# host-accessd — 容器的受限主机元数据代理

`cyberos-host-accessd` 在 CyberOS API 和 Docker daemon 之间创建按授权目录组织的 Unix 代理，让获准容器读取经过路由白名单和字段裁剪的 Docker 元数据。

它以 `cyberos` 身份运行，通过附加的 `docker` 组访问上游。当前服务不是通用 Docker API 转发器，也没有实现可用的 systemd 状态代理；包内默认还关闭 Docker 兼容性开关。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-host-accessd.service)

## 架构图

![host-accessd 控制面与元数据代理](docs/architecture.svg)

控制面先核验 UID 与能力开关，再建立代理目录。容器的数据请求通过另一个 socket 进入 HTTP 白名单，与控制面的 JSON 协议不同。

## 两个接口与两道边界

| 接口 | 调用方 | 保护方式 |
| --- | --- | --- |
| `control.sock` | API 等允许身份 | peer UID、固定 version/action、名称和 capability 校验 |
| `grants/<scope-hash>/<service-hash>/docker.sock` | 获得挂载的容器 | 授权目录挂载隔离、HTTP 路由限制、请求/响应上限与字段裁剪 |
| 上游 Docker socket | host-accessd | 由服务用户的 docker 组权限访问 |

scope/service 哈希用于稳定组织代理目录，不能理解为 Docker 返回结果自动按这些标识过滤。代理限制的是可用端点与可见字段，并不提供每个容器一套完整独立的 Docker 视图。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/main.rs](src/main.rs) | 环境配置、控制 listener、UID 校验、兼容标记、哈希授权目录、代理恢复与启动 |
| [src/proxy.rs](src/proxy.rs) | HTTP 解析、端点白名单、上游请求重建、响应解码、JSON 字段裁剪与限流 |
| [API 控制客户端](../../packages/api/src/lib/docker-host-access-control.ts) | 发送 reconcile 请求并处理错误 |
| [API 授权策略](../../packages/api/src/lib/docker-host-access.ts) | 宿主访问能力、代理目录挂载和环境配置 |

该 crate 没有 library target，也不使用 SQLite。控制状态主要体现在运行目录、兼容标记与正在监听的 socket 集合中。

## 授权目录如何出现

1. 启动创建 runtime root 与 `grants`，写入当前兼容性标记，绑定权限为 `0660` 的控制 socket。
2. 控制请求先校验允许 UID，并在 16 KiB、5 秒范围内读取 JSON。
3. 仅接受 version `1`、action `reconcile`、合法的 `scopeId`/`service` 与已知能力名。
4. `systemd_status` 当前返回 `503 systemd_proxy_unverified`；Docker 能力在开关未打开时返回 `503 docker_proxy_unverified`。
5. 验证通过后，用 scope/service 的哈希生成目录，绑定其中的 `docker.sock` 并启动代理。
6. API 把该授权目录只读挂载到容器的 `/run/cyberos-host-access`，并按能力配置连接环境。
7. 服务重启时，在兼容性开启的前提下，仅恢复符合哈希目录规则和类型检查的既有代理目录。

创建代理不等于容器已经获得访问；还需要 API 的能力策略和实际挂载。控制接口不是任意创建文件、指定上游或执行命令的接口。

## 数据请求如何通过

代理接受请求后，先解析完整 HTTP 头并检查方法、路径、查询参数和不允许的请求头。通过后连接固定上游，重建只包含必要字段的新请求，不原样透传客户端头部。

| 端点类别 | 当前允许的范围 |
| --- | --- |
| 健康 | `/_ping`，允许 GET/HEAD |
| 引擎信息 | GET `/version`、`/info` |
| 容器 | GET `/containers/json` 和合法标识符的 inspect 路径 |
| 网络 | GET `/networks` 和合法标识符的单网络路径 |
| API 版本前缀 | 可识别合法的 `/v1.<数字>/...` 形式 |

不允许 POST/DELETE、exec、日志流或任意其他端点。请求中的编码路径穿越、请求体相关头、升级连接等会被拒绝。容器列表查询也限制可出现的参数键。

上游响应在有界读取后处理 Content-Length/chunked 等形式，再按端点裁剪 JSON 字段并重建响应。请求目标白名单与字段裁剪必须一起维护，否则只读端点仍可能暴露环境变量等敏感数据。

## 配置与资源限制

| 配置/限制 | 默认值 |
| --- | --- |
| `CYBEROS_HOST_ACCESS_RUNTIME_ROOT` | `/run/cyberos/host-access` |
| `CYBEROS_DOCKER_SOCKET` | `/var/run/docker.sock` |
| `CYBEROS_HOST_ACCESS_ALLOWED_UIDS` | 逗号分隔 UID；默认 root 和当前 UID |
| `CYBEROS_HOST_ACCESS_DOCKER_COMPATIBLE` | 仅字符串 `1` 开启；包内设置 `0` |
| 控制请求上限 | 16 KiB |
| HTTP 请求头上限 | 64 KiB |
| 上游响应上限 | 4 MiB |
| HTTP I/O 超时 | 5 秒 |
| 单代理并行请求 | 32，超额返回 429 |

代理 socket 当前权限为 `0666`，安全边界依赖宿主运行目录访问和容器挂载控制；数据面不重复控制面的 UID 白名单。不能把 socket 只读挂载误解为“客户端无法发送写请求”，真正阻止写操作的是 HTTP 方法与路由白名单。

## 故障与运行策略

- 默认不宣称兼容。必须通过实际采集器兼容验证后，才能由部署配置显式启用。
- Docker 不可达返回受控的 unavailable，格式错误或端点不允许分别进入拒绝路径。
- 请求和响应都受大小、超时和并发约束，避免长流与大响应占满服务。
- 服务只开放 Unix 地址族并受 systemd 文件系统、设备和 capability 限制，但上游 docker 组权限仍是高权限边界。
- 该服务不能代替 hostd，也不能从未实现的 `systemd_status` 能力推导已有 systemd 访问支持。

## 开发与验证

```bash
cargo check --locked -p cyberos-host-accessd
cargo test --locked -p cyberos-host-accessd
```

单元测试可使用临时 Unix socket 和伪造上游，验证端点限制、响应裁剪与恢复目录。实际 Docker 版本、采集器兼容、挂载权限和容器可见数据需另行测试。

```bash
systemctl status cyberos-host-accessd.service
journalctl -u cyberos-host-accessd.service -n 100 --no-pager
```

## 继续阅读

- [HTTP 授权与裁剪](src/proxy.rs)。
- [API 宿主访问策略](../../packages/api/src/lib/docker-host-access.ts)。
- [hostd](../hostd/README.md)：受限特权变更的执行边界。
