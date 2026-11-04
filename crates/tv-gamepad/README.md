# tv-gamepad — 手柄到 TV 界面的输入桥接

`cyberos-tv-gamepad` 从 Linux evdev 读取手柄事件，转换为固定键盘操作，再通过 `wtype` 注入当前 Wayland 会话。它把设备扫描、输入策略、按键注入和健康状态分开，使 USB/蓝牙手柄最终都能通过 Linux 输入设备进入同一条路径。

它不访问 SQLite、不开放网络接口，也不负责蓝牙配对。只有 TV target 启用并具备输入设备与 Wayland 会话时，系统服务才进入正常工作环境。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-tv-gamepad.service)

## 架构图

![tv-gamepad 输入与 Wayland 注入架构](docs/architecture.svg)

输入策略是纯 Rust 状态机，Linux 设备和进程调用位于 binary 主循环。健康信息描述设备读取和按键注入状态，不直接证明界面已处理按键。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/lib.rs](src/lib.rs) | 能力识别、轴归一化、按钮/方向策略、重复节奏、InputHub 和健康分级 |
| [src/main.rs](src/main.rs) | evdev 热插拔、设备读取任务、代次过滤、wtype 和状态脚本 |

library target 不直接打开设备或执行命令，便于对输入策略做确定性测试；binary target 处理真实 Linux/Wayland 运行环境。

## 从设备到界面的流程

1. 主循环每秒扫描 `/dev/input` 中的 `event*` 设备。
2. 打开设备后读取按键和绝对轴能力，仅接纳满足支持条件的手柄。
3. 每个设备启动独立异步读取任务，把按钮和支持的轴事件送入容量为 256 的 channel。
4. 设备路径和 generation 一起随事件传递，重连后丢弃旧任务迟到的事件。
5. `InputHub` 按设备保存状态，处理按下/释放、摇杆归一化、hat 和 D-pad，再输出固定键名。
6. 主循环调用有 2 秒超时的 `wtype`，向 Wayland 注入按键。
7. 每 20ms 驱动一次重复检查，每 5 秒汇总设备和注入健康，调用状态写入脚本。

断开设备时移除对应状态和读取任务关联，不把旧设备保持的方向继续当作新设备输入。

## 设备能力与方向策略

受支持设备至少具有 South/East 两个面键，并具有以下任一方向输入：X/Y 摇杆、HAT0X/HAT0Y，或四个 D-pad 按钮。单纯存在一个 evdev 节点不代表它会被识别为手柄。

绝对轴按照设备报告的最小/最大值映射到 `[-1,1]`。摇杆采用不同的激活与释放阈值，减少中点噪声导致的方向抖动，并按主要轴决定单个方向。

| 参数 | 当前值 |
| --- | --- |
| 摇杆激活阈值 | 0.55 |
| 摇杆释放阈值 | 0.35 |
| 长按首次重复等待 | 350ms |
| 后续重复间隔 | 120ms |
| 重复检查 tick | 20ms |

设备原生 repeat 值与应用自己的重复节奏需要区分；输入策略负责避免无意重复触发面键动作。

## 固定按键映射

| Linux 按钮/输入 | 输出键 |
| --- | --- |
| 摇杆 / hat / D-pad | `Up`、`Down`、`Left`、`Right` |
| `BTN_SOUTH` | `Return` |
| `BTN_EAST` | `Escape` |
| `BTN_TL` | `F6` |
| `BTN_TR` | `F7` |
| `BTN_START` | `F8` |
| `BTN_WEST` | `F9` |
| `BTN_NORTH` | `F10` |

F6–F10 的产品语义由当前前端或播放器输入绑定决定。本 crate 只生成键名，不把它们固定解释为某个页面动作。

## 运行配置与健康状态

| 项目 | 当前约定 |
| --- | --- |
| CLI | 不接受参数，额外参数返回用法错误 |
| 输入目录 | 固定 `/dev/input` |
| 按键工具 | PATH 中的 `wtype` |
| 状态工具 | `/usr/lib/cyberos/scripts/cyberos-tv-write-status` |
| Wayland | `XDG_RUNTIME_DIR` 与 `WAYLAND_DISPLAY`，服务内默认 `/run/cyberos-tv` / `wayland-0` |
| 账号与组 | `cyberos`，附加 `input` 组 |
| 服务归属 | `cyberos-tv.target`，要求 TV prepare，跟随 Weston |

`runtime_preflight` 检查 wtype 和 Wayland socket。存在运行或读取错误时为 unavailable；没有受支持手柄时为 degraded；至少一个受支持手柄且无相应错误时为 ready。

ready 说明本服务的设备和注入条件满足。某个窗口是否有焦点、页面是否处理按键或真实用户操作是否正确，仍需在 TV 界面验证。

## 安全与故障隔离

- 仅输出固定按键，不接受外部传入任意程序或命令参数。
- systemd 限制输入设备为只读，地址族为 Unix，使用非 root 身份与最小运行目录写入。
- 设备扫描、读取错误和注入错误分别保留，避免“没有手柄”和“Wayland 不可用”混成同一个状态。
- 注入进程有超时，事件队列有容量，单个迟到设备任务由 generation 校验隔离。
- 不配置蓝牙协议、不改变系统键位，也不代替 Weston 和前端的焦点管理。

## 开发与验证

```bash
cargo check --locked -p cyberos-tv-gamepad
cargo test --locked -p cyberos-tv-gamepad
```

纯状态机测试可验证轴范围、阈值、方向/面键、重复、重连和健康判断。实际运行依赖 Linux evdev、设备权限和支持 wtype 的 Wayland compositor；合成事件不能证明真实手柄已控制 TV 页面。

```bash
systemctl status cyberos-tv-gamepad.service
journalctl -u cyberos-tv-gamepad.service -n 100 --no-pager
```

## 继续阅读

- [输入策略与映射](src/lib.rs) 和 [Linux 主循环](src/main.rs)。
- [vod-player](../vod-player/README.md)：本机媒体的遥控输入和原生播放。
- [hostd TV 操作](../hostd/src/tv.rs)：TV 模式启停入口。
