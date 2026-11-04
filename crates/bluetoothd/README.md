# bluetoothd — BlueZ OBEX 文件传输

`cyberos-bluetoothd` 负责蓝牙文件的发送与接收。它从业务库领取发送任务，通过 BlueZ OBEX Object Push 传输；接收文件先进入 state 暂存区，再由 API 收尾逻辑发布到配置的 NAS 收件箱。

设备扫描、配对和连接管理由 hostd 的 Bluetooth 模块负责，语音采集和播放由 audiod 负责。本 crate 专注 OBEX 文件传输。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-bluetoothd.service)

## 架构图

![bluetoothd 文件传输与 API 收尾边界](docs/architecture.svg)

最后一段箭头表示暂存文件交给 API 收尾。实际向 NAS 写入最终文件的是 API，不是持有只读存储池权限的蓝牙服务。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/main.rs](src/main.rs) | 日志、配置与服务启动 |
| [src/lib.rs](src/lib.rs) | 服务组装、重启恢复、发送任务轮询与心跳 |
| [src/config.rs](src/config.rs) | 根目录、业务库、原文件根与 incoming 目录 |
| [src/db.rs](src/db.rs) | 传输队列、接收记录、进度、取消、心跳和中断恢复 |
| [src/obex.rs](src/obex.rs) | OBEX Agent、发送 Client、设备信任检查和进度监测 |
| [src/safety.rs](src/safety.rs) | 存储池、挂载、相对路径、符号链接、文件名和空间检查 |
| [src/error.rs](src/error.rs) | 传输错误 |
| [API bluetooth-transfers](../../packages/api/src/routes/bluetooth-transfers.ts) | 产品路由、最终文件名分配和接收收尾 |

## 两条 D-Bus 连接

`ObexRuntime` 同时建立 session bus 与 system bus 连接。session bus 上访问 `org.bluez.obex` 并注册 `/org/cyberos/BluetoothObexAgent`；system bus 上访问 BlueZ 的设备与适配器信息。

服务单元用 `dbus-run-session` 启动，提供专属会话总线。不能仅检查系统 BlueZ 服务 active，就断言 OBEX 会话总线和 Agent 已注册成功。

## 发送流程

1. API 创建 `direction=send`、`status=queued` 的业务传输记录。
2. `claim_send` 条件更新并返回一条任务，转为 running。
3. 校验存储池直接位于数据根下、不是符号链接且生产挂载有效；校验并打开相对源文件。
4. 根据任务的 adapter ID 查询适配器地址，通过 OBEX `CreateSession` 指定 `Target=opp` 和源适配器。
5. 对 `ObjectPush1` 调用 `SendFile`，轮询 `Transfer1` 状态、已传输字节与总大小。
6. 收到产品取消请求则调用 OBEX Cancel；完成或出错后回写任务结果并移除临时 OBEX session。

进度监测约每 500ms 检查一次。传输表是产品状态来源，OBEX 的对象路径只是运行期关联信息。

## 接收与发布流程

1. 远端发起 Object Push，OBEX 调用本服务 `Agent1.AuthorizePush`。
2. 检查接收开关、配置的池/收件箱、远端是否已配对且受信任，以及适配器归属。
3. 校验单文件名、收件箱范围及收件箱/暂存区空间，登记接收记录。
4. 返回 `${incoming_path}/<transfer-id>.part` 给 OBEX，实际接收发生在该暂存路径。
5. 后台监测传输完成与字节状态，再把接收记录交给 finalizing 阶段。
6. API 周期收尾重新验证暂存文件和当前收件箱配置，分配无冲突目标名并发布到 NAS。
7. API 更新最终相对路径与传输结果，清理相应暂存文件。

`complete` 的 OBEX 状态只说明蓝牙传输阶段完成。用户在 NAS 中看到的最终文件还依赖 API 收尾成功。

## 重启与失败恢复

服务启动时先处理遗留记录。运行中的发送任务回到 queued；运行中的接收任务只有在已知总大小、进度和暂存大小足以证明完成时才交给收尾，否则标记失败并尝试清理部分文件。

接收目标必须是预期 UUID 暂存文件。恢复和清理失败会保留明确错误，不能用“文件看起来存在”替代传输完成证据。

服务没有 downloader 那样的完整 HTTP 分段/租约体系。不要把其他 worker 的重试语义直接套到 OBEX 任务上。

## 配置与数据

| 项目 | 位置或默认 |
| --- | --- |
| 根目录 | `CYBEROS_ROOT`；生产固定 `/cyberos` |
| 业务库 | `state/cyberos.sqlite` |
| 发送源 | `data/<storage-pool-id>/<relative-path>` |
| 接收暂存 | `state/bluetooth/incoming/<UUID>.part` |
| 产品配置 | 接收开关、收件箱池与路径来自业务库 |
| 进程身份 | `cyberos`，`Type=simple` |
| systemd 文件权限 | `data` 只读，`state` 可写 |

生产单元设置蓝牙专用 HOME/cache，限制地址族为 Unix 与 Bluetooth，并禁止 IP 网络访问。它依赖现有 CyberOS schema、BlueZ、OBEX 以及正确的 D-Bus/用户权限。

## 安全约束

- 存储池 ID 必须是合法的单路径组件，且池是数据根的直接真实子目录。
- 相对路径必须保持在存储池内，路径遍历和符号链接会被拒绝。
- 接收名称必须是单个合法文件名，不能把远端路径当成本地路径。
- 接收必须启用并指定目标库，且远端满足配对/信任条件。
- 最终发布在 API 再校验一次，避免把接收开始时的旧配置当作收尾时的授权。

## 开发与验证

```bash
cargo check --locked -p cyberos-bluetoothd
cargo test --locked -p cyberos-bluetoothd
```

本地测试可验证路径、表状态和恢复条件，真实发送/接收仍需要 Linux、可用适配器、OBEX 会话和另一台设备。查看服务心跳、一次模拟传输或蓝牙设备枚举都不能证明真实文件已到达 NAS。

```bash
systemctl status cyberos-bluetoothd.service
journalctl -u cyberos-bluetoothd.service -n 100 --no-pager
```

## 继续阅读

- [hostd 蓝牙管理](../hostd/src/bluetooth.rs)：扫描、配对与连接。
- [API 接收收尾](../../packages/api/src/routes/bluetooth-transfers.ts)。
- [audiod](../audiod/README.md)：与文件传输独立的音频服务。
