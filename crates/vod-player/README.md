# vod-player — 统一的本机音乐与视频播放引擎

`cyberos-vod-player` 以单个控制循环管理本机 mpv，统一处理 TV 视频、无界面音乐、播放队列、输出设备、音频焦点和恢复检查点。API 通过本地 socket 控制它；媒体从 NAS 安全打开后以文件描述符交给 mpv。

它负责本机屏幕/声卡播放。浏览器媒体流、远程转码和 HTTP 内容分发由其他模块处理，不能把本服务理解为 Web 视频服务。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-vod-player.service)

## 架构图

![vod-player 控制循环与播放架构](docs/architecture.svg)

音乐与视频共享一个播放所有者和 mpv 生命周期。状态快照经 watch channel 提供，变更命令经队列由单个 Controller 串行执行。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/main.rs](src/main.rs) | CLI 限制、配置、日志和服务启动 |
| [src/config.rs](src/config.rs) | 根目录、账号、TV/蓝牙设置、输出与超时 |
| [src/server.rs](src/server.rs) | Unix listener、UID/帧校验、连接限制与 watchdog |
| [src/protocol.rs](src/protocol.rs) | v3 请求、命令、状态、能力和输入校验 |
| [src/controller.rs](src/controller.rs) | Controller actor、播放所有权、会话冲突、音频焦点、重试和检查点 |
| [src/music_controller.rs](src/music_controller.rs) | Controller 的音乐队列操作、接管、切曲与历史收尾 |
| [src/music.rs](src/music.rs) | 队列模型、版本、持久化和播放历史 |
| [src/mpv.rs](src/mpv.rs) | mpv 参数、FD 传递、JSON IPC、事件、能力探测与错误分类 |
| [src/storage.rs](src/storage.rs) | 音频/视频的存储池、安全打开和文件身份 |
| [src/session.rs](src/session.rs) | 视频会话检查点、原子写入与损坏隔离 |
| [src/preferences.rs](src/preferences.rs) | 播放偏好的独立保存 |
| [src/progress.rs](src/progress.rs) | SQLite 观看进度 |
| [src/tv_controls.rs](src/tv_controls.rs) | 内嵌原生 TV 控制脚本的管理 |
| [tests/tv_controls.lua](tests/tv_controls.lua) | 原生控制脚本行为验证 |

`music_controller.rs` 作为 Controller 的子模块组织，音乐和视频并不是两个互相独立的 daemon。

## 一次视频播放请求

1. API 连接 `/run/cyberos/vod-player.sock`，发送 version `3` 的 JSONL 请求。
2. server 验证 peer UID、帧大小、命令结构、字段和参数；并发连接受 semaphore 限制。
3. 状态请求直接读取快照，其余命令通过有界 channel 进入 Controller，使用 oneshot 返回结果。
4. Controller 检查会话、服务实例和接管条件，解析当前视频设置，并安全打开存储池中的目标文件。
5. 根据媒体身份和目标状态启动 mpv，用固定 FD 传递媒体与 JSON IPC，避免让 mpv 重新解析客户端提供的任意路径。
6. mpv 事件和控制 tick 更新播放、时长、轨道、输出和错误状态，必要时安排重试。
7. 定期保存会话与观看进度；stop、退出和切换所有者执行相应清理。

父进程保持源 FD 的 CLOEXEC，仅在子进程 pre-exec 时复制到固定描述符，防止并行启动的其他进程继承本次媒体或 IPC。

## 音乐队列与播放所有权

音乐队列携带 `queueVersion`，所有变更命令先校验客户端期望版本。追加、插播、移除、重排、跳转、上一首/下一首、循环和随机等操作由同一个 Controller 执行，避免多个 API 请求互相覆盖。

队列最多 1000 项。队列项保存业务 track ID、存储池、相对路径和显示元数据；显示数据不能替代实际文件打开检查。

音乐与视频接管需要检查当前会话。命令可以使用 `expectedSessionId`，通用 guarded 包装还校验 `serviceInstanceId`，防止旧界面对新进程或新会话施加操作。

音频焦点使用带期限的 lease 记录临时占用和先前播放状态，供语音等上层协调使用。焦点释放和恢复仍需确认对应会话，不能无条件恢复已经被用户切换掉的播放。

## 恢复、检查点与进度

| 数据 | 存储方式 |
| --- | --- |
| 视频会话 | `state/vod-player/session.json`，包含会话、位置、音量、轨道和源文件身份 |
| 音乐队列/检查点 | state/vod-player 下由 `music.rs` 计算的检查点路径 |
| 播放偏好 | 由 `preferences.rs` 独立保存 |
| 观看/音乐历史 | 业务 SQLite 中的对应记录 |

JSON 检查点采用临时文件、文件同步、重命名和父目录同步。损坏的视频会话会隔离为带时间和 UUID 的 corrupt 文件，不当作有效会话继续使用。

重启后加载已有音乐或视频状态，恢复为暂停，等待明确继续操作。位置与身份用于后续恢复校验，不能只凭相同文件名继续播放变化后的文件。

## 协议与运行参数

| 项目 | 当前值/来源 |
| --- | --- |
| IPC | `/run/cyberos/vod-player.sock`，权限 `0660`，允许配置中的 cyberos UID |
| 协议 | JSONL v3，每连接一次请求，最大帧 1 MiB |
| 最大并发连接 | 32 |
| IPC 读/写超时 | 各 5 秒 |
| mpv 启动超时 | 15 秒 |
| 会话检查点间隔 | 5 秒 |
| 重试延迟范围 | 配置默认基准 2 秒，最大 60 秒 |
| 视频输出 | TV 设置选择 Wayland/DRM 等支持路径 |
| 音频输出 | ALSA，可选择普通设备或受支持 BlueALSA 标识 |
| 硬件解码 | 默认 `auto-safe`，实际能力需探测 |

`CYBEROS_ROOT` 控制数据库、媒体根和 state 路径，生产固定 `/cyberos`。播放账号固定为 cyberos；开发环境有当前 UID 的特定回退，但 socket 路径仍是固定默认值。

TV 禁用不会关闭整个 daemon：无界面音乐仍需要共享引擎，视频能力与生命周期分开判断。Wayland/DRM、BlueZ/BlueALSA 和 ALSA 的实际可用性受设备与部署权限影响。

## 原生 TV 控制与隔离

mpv 的原生 TV 控制使用随程序内嵌的 Lua 脚本，在播放时写入私有临时文件并通过 `--script` 传入；生命周期结束清理临时脚本。浏览器控件不会覆盖原生全屏 mpv，所以原生输入与显示需要单独实现和验证。

服务单元限制数据池只读、state/run 可写，禁止 IP 网络并仅开放 Unix 地址族。mpv 使用受控参数与本地 FD，服务不应接受任意 URL 或通过浏览器数据请求绕开存储池限制。

## 故障处理与开发验证

启动探测的能力、会话状态、mpv 实际开始播放和可见/可听输出属于不同证据。读取失败、设备不可用、命令拒绝、mpv 退出和源文件变化有各自错误路径，不能统一当作成功或无限重试。

从仓库根目录执行：

```bash
cargo check --locked -p cyberos-vod-player
cargo test --locked -p cyberos-vod-player
npm run protocol:check
```

测试使用 fake mpv 验证 IPC、会话、队列、超时和恢复，也有原生脚本契约测试。真实解码、硬件加速、字幕、音轨、蓝牙输出和 TV 遥控需在 Linux 设备实际播放验证。

```bash
systemctl status cyberos-vod-player.service
journalctl -u cyberos-vod-player.service -n 100 --no-pager
```

## 继续阅读

- [Controller](src/controller.rs)、[音乐控制](src/music_controller.rs)、[mpv 适配器](src/mpv.rs)。
- [tv-gamepad](../tv-gamepad/README.md)：手柄输入桥接；[audiod](../audiod/README.md)：语音 I/O。
- [indexer](../indexer/README.md)：影视和音乐目录的数据来源。
