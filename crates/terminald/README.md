# terminald — 基于 PTY 与 tmux 的终端服务

`cyberos-terminald` 为 Web Terminal 提供本地 Unix 流接口：API 转发请求和字节，terminald 创建或复用 tmux 会话，再通过 PTY 附着会话。浏览器连接、PTY 附着和 tmux Shell 是不同生命周期，使终端可以在连接断开后继续保留。

服务固定使用 `cyberos` 账号。它不通过客户端请求切换任意用户，也不读取 CyberOS 的业务数据库。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-terminald.service)

## 架构图

![terminald 流与持久会话架构](docs/architecture.svg)

图中的 Shell 身份来自系统 passwd 记录。输入输出始终经过本次连接的 PTY；tmux 负责保留实际会话状态。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/main.rs](src/main.rs) | 进程入口与日志 |
| [src/config.rs](src/config.rs) | 解析 cyberos 用户、HOME、Shell 和固定 socket/限制 |
| [src/protocol.rs](src/protocol.rs) | JSONL 请求、流命令、结果和事件，base64 字节编码 |
| [src/server.rs](src/server.rs) | UID 校验、会话控制、读写转发、关闭语义与回收调度 |
| [src/pty.rs](src/pty.rs) | PTY 创建、子进程启动、尺寸变更和终止 |
| [src/tmux.rs](src/tmux.rs) | 私有 tmux socket、会话标记、附着、尺寸与销毁 |
| [src/session_policy.rs](src/session_policy.rs) | 空闲回收与容量淘汰的纯策略 |
| [src/error.rs](src/error.rs) | 协议错误、超时、权限和不可用状态 |
| [tests/tmux_pty.rs](tests/tmux_pty.rs) | tmux 与 PTY 集成行为测试 |

## 打开与使用终端

1. 启动时解析 `cyberos` 账号，验证 UID、绝对 HOME 和可执行 Shell，并要求进程本身就以该 UID 运行。
2. 检查 tmux 可用，准备用户 HOME 下的私有 tmux 目录，绑定 `/run/cyberos/terminald.sock`。
3. API 连接后校验 peer UID，读取首个有界请求帧并验证协议。
4. `open` 创建或复用合法命名会话，写入 CyberOS 管理/持久标记，再启动 tmux attach 子进程并连接 PTY。
5. 返回新的 `streamId`、实际 user、cwd 和 shell。后续 input/resize 必须匹配此流标识。
6. 客户端输入由 base64 解码成字节写入 PTY；输出分块编码为事件，经 API 转回 WebSocket。
7. 窗口变化同时作用于终端和会话管理；子进程退出、协议错误或连接关闭进入收尾。

请求的 `user` 字段必须符合固定账号约束。返回的 cwd 由账号 HOME 决定，客户端不能借此指定任意工作目录。

## 接口与限制

| 类别 | 内容 |
| --- | --- |
| 协议 | version `1`，JSONL，区分 `request` 与 `command` |
| 请求 | `open`、`close`、`destroy` |
| 流命令 | `input`、`resize`，携带 `streamId` |
| 返回 | 请求响应和关联流的输出/退出/错误事件 |
| 最大帧 | 256 KiB |
| 单次输入 | 64 KiB 解码字节 |
| 输出块 | 最多 24 KiB 原始字节 |
| 窗口 | 列 2–500，行 1–200 |
| 最大连接 | 64 |
| 首请求超时 | 默认 10 秒 |
| 输入/写出超时 | 5 秒 |

## 连接关闭与会话销毁

`close` 的 `destroy` 字段区分分离与销毁。连接断开时结束本次 attach 子进程并标记 detached，不应把 attach 子进程退出直接等同于 tmux Shell 被销毁。

`persistent` 是回收策略属性：持久会话不参与普通空闲回收和容量淘汰。普通 detached 会话也可在回收前重新附着；默认 idle timeout 为 30 分钟，回收器每分钟检查一次。

最大受管会话数默认为 32。满额时仅选择未附着、非 persistent 且已有 detached 时间的最早会话作为淘汰候选；没有候选时返回 session limit，不能牺牲活跃会话。

tmux 管理操作串行执行，创建新会话后若初始化标记失败会尝试清理半成品。服务使用专用 tmux socket，不把任意用户已有的 tmux 会话纳入管理。

## 配置与持久性

| 项目 | 当前配置 |
| --- | --- |
| 服务账号 | 固定 `cyberos` |
| IPC socket | 固定 `/run/cyberos/terminald.sock` |
| tmux socket | passwd HOME 下 `.cyberos/tmux.sock` |
| HOME / cwd / Shell | 来自系统账号记录 |
| 数据库 | 无 |
| 会话属性 | tmux 用户选项及其运行状态 |

当前配置加载器没有通用 `CYBEROS_ROOT` 或客户端自定义 socket 路径开关。测试可构造配置对象，但这不等同于生产环境提供对应环境变量。

服务单元使用 `ProtectHome=tmpfs` 并显式绑定 `/home/cyberos`，只开放运行目录、存储池和该 HOME，禁止访问 state/logs。`KillMode=process` 也参与 tmux 与主进程的生命周期设计；改用户 HOME 时需同步检查 passwd、Environment、WorkingDirectory、BindPaths 和 ReadWritePaths。

## 安全与故障行为

- socket 权限与 peer UID 共同保护入口，协议层限制未知字段、会话名、尺寸和字节量。
- 终端本身允许用户运行 Shell，所以它的边界是 `cyberos` 身份及 systemd 沙箱，不是逐条命令白名单。
- 断连、destroy、child exit 的收尾状态分别记录，避免重复销毁或错误标记 detached。
- 慢客户端、读写超时和最大连接数有单独处理；持久会话不代表 API 连接永久存活。
- tmux 可保留会话，不意味着服务重启、系统重启和断电都具有相同恢复保证。

## 开发与验证

从仓库根目录执行：

```bash
cargo check --locked -p cyberos-terminald
cargo test --locked -p cyberos-terminald
npm run protocol:check
```

集成测试依赖 tmux 和 Unix/PTY 能力；实际服务还要求 cyberos 账号及正确 HOME/沙箱。开发根目录不会替换固定的生产 socket 与用户校验，不应按普通 NAS worker 的方式直接试跑。

```bash
systemctl status cyberos-terminald.service
journalctl -u cyberos-terminald.service -n 100 --no-pager
```

真实浏览器重连、中文/控制字符、窗口缩放和长输出背压需结合 [API terminal client](../../packages/api/src/lib/terminal-client.ts) 与 Web Terminal 验证。

## 继续阅读

- [协议定义](src/protocol.rs)、[会话策略](src/session_policy.rs)、[tmux 实现](src/tmux.rs)。
- [hostd](../hostd/README.md)：与终端身份不同的受限 root 操作服务。
