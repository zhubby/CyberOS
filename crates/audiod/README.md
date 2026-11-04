# audiod — 蓝牙语音输入与主机语音输出

`cyberos-audiod` 负责音频设备 I/O：读取受支持的 ATVV 蓝牙遥控器通知，把 IMA ADPCM 解码为 16kHz 单声道 WAV，并通过 Unix IPC 交给上层；播放侧接受 WAV，输出到 ALSA/BlueALSA 或受支持的自定义 BLE 播放设备。

它不在进程内运行 ASR、LLM 或 TTS，也不持久化用户录音。启动时语音输入默认关闭，上层需要显式配置设备并启用。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-audiod.service)

## 架构图

![audiod 音频输入、录音和输出架构](docs/architecture.svg)

录音在有界内存队列内暂存，读取与确认消费是两个独立动作。播放使用 generation 和取消信号，避免旧语音覆盖新一轮交互。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/main.rs](src/main.rs) | 进程与日志入口；当前日志过滤固定为 info |
| [src/server.rs](src/server.rs) | JSONL 请求、共享状态、配置、录音缓存、同 UID 校验与取消 |
| [src/bluez.rs](src/bluez.rs) | BlueZ 枚举、ATVV GATT 发现/连接、通知与录音收尾 |
| [src/protocol.rs](src/protocol.rs) | ATVV capability、IMA ADPCM 编解码、帧重组和 WAV 封装 |
| [src/output.rs](src/output.rs) | 输出设备枚举、WAV/设备校验、mpv ALSA 播放 |
| [src/ble_output.rs](src/ble_output.rs) | ffmpeg 转换和自定义 BLE 播放传输 |
| [src/playback.rs](src/playback.rs) | BLE 播放的 clip、CRC、分包、credit/ack 与完成校验 |
| [src/protocol_tests.rs](src/protocol_tests.rs) | 音频协议与帧处理测试 |
| [src/playback_tests.rs](src/playback_tests.rs) | 自定义播放协议和输出行为测试 |

这个 crate 当前只有 binary target。`server::Shared` 为 `Arc<Mutex<State>>`，设备任务和 IPC 操作通过同一状态协调。

## 输入设备与音频格式

ATVV 设备必须已配对且 trusted，并匹配受支持的标识或服务。关键 UUID 为：

| 角色 | UUID |
| --- | --- |
| ATVV service | `ab5e0001-5a21-4f05-bc7d-af01f617b664` |
| TX | `ab5e0002-5a21-4f05-bc7d-af01f617b664` |
| Audio | `ab5e0003-5a21-4f05-bc7d-af01f617b664` |
| Control | `ab5e0004-5a21-4f05-bc7d-af01f617b664` |

capability 必须满足支持版本、16kHz IMA ADPCM 与有界帧长。解码时每个字节先处理高半字节，再处理低半字节；predictor 和 step index 由同步信息建立，未同步的音频不会被当作有效录音解码。

输出 WAV 是 16kHz、单声道、16-bit PCM。单段录音限制为 1–30 秒，通知和帧长各有上限，避免外设数据无限扩张缓冲。

## 一次录音如何交付

1. 上层通过 `configure` 提交 `enabled`、`inputDeviceId` 和 `maxRecordingSeconds`。
2. 服务核验选择的输入设备，刷新配置时间；配置变化时中断旧一代播放。
3. BlueZ 任务建立受支持的 GATT 通道并处理控制/音频通知。
4. 开始采音时分配 UUID `recordingId`，推进 generation，并取消旧播放。
5. 帧重组和同步解码生成有界 PCM；停止、限制触达或相应结束条件进入收尾。
6. 有有效样本时把 WAV 放入录音队列；缺失同步或空录音产生明确错误。
7. 上层查询 status 得到录音 ID，再用 `recording` 取回 base64 WAV。
8. 上层处理后发 `ack` 移除该录音；未确认录音 5 分钟后到期。

队列最多保留 2 条录音；已有采音或待处理队列满时返回 busy。ID 与 generation 用于准确关联一次输入，不能凭“最近一段音频”推断其对应的 Agent 任务。

## Unix IPC

默认 `/run/cyberos/audiod.sock`，可用 `CYBEROS_AUDIO_SOCKET` 覆盖。socket 权限 `0600`，并要求 peer UID 与 daemon UID 一致；最多 8 个并行连接，每个连接处理一次以换行结束的请求。

| `type` | 行为 |
| --- | --- |
| `status` | 返回通道、连接、capture/recording、generation、播放与错误状态 |
| `devices` | 枚举受支持输入与输出 |
| `configure` | 设置输入启用、设备和录音长度 |
| `recording` | 按 ID 返回录音及设备 ID |
| `ack` | 按 ID 确认消费 |
| `play` | base64 WAV、输出设备、音量和 generation |
| `stop` | 中断当前播放并推进代次 |

请求帧上限为 9 MiB，读取超时 5 秒；响应为 `{ok:true,result:...}` 或 `{ok:false,error:...}`。它没有 hostd 那样的版本 envelope，不能直接复用其他服务协议。

## 播放的两条路径

ALSA 路径通过受控的 mpv 子进程读取标准输入 WAV，固定关闭视频与用户配置，使用指定设备并禁止静默降级到 null 输出。BlueALSA A2DP 设备可作为 ALSA 输出的一种设备标识。

自定义 BLE 路径先使用 ffmpeg 生成协议要求的音频片段，再按 `playback.rs` 的起始控制、CRC、分包序号、credit/ack 和终态校验传输。它是独立设备协议，不能把普通蓝牙音箱自动视作支持该协议。

播放前核验 generation 和数据；播放期间监听取消与客户端断开。上层的音频焦点、Agent 状态和 TTS 请求关联由进程外服务协调。

## 安全、生命周期与配置

- 不保存录音文件，不把 WAV 写入业务数据库；退出后内存录音消失。
- 只替换属于当前 UID 的失效 socket，拒绝覆盖普通文件或活跃实例；退出时复核 inode 再删除自己的 socket。
- GATT/D-Bus 调用、播放转换和输出有超时或取消边界；设备连接成功不等于收到有效音频。
- systemd 使用 `cyberos` 账号和 audio 附加组，清空 capability，只开放 Unix/Bluetooth，禁止 IP 网络。
- 当前服务主要配置来自 IPC，只有 socket 路径来自环境变量。不要假设 `CYBEROS_ROOT` 会决定录音落盘目录。

## 开发与验证

```bash
cargo check --locked -p cyberos-audiod
cargo test --locked -p cyberos-audiod
```

软件测试可覆盖 ADPCM、边界、录音状态、取消和 BLE 播放分包。完整验收必须使用真实遥控器按键/音频通知、实际 ASR/TTS 调用链及可听输出；设备枚举和合成 WAV 通过只能证明相应的软件层级。

```bash
systemctl status cyberos-audiod.service
journalctl -u cyberos-audiod.service -n 100 --no-pager
```

## 继续阅读

- [API AudioRuntime](../../packages/api/src/lib/audio-runtime.ts)：音频 IPC 客户端。
- [vod-player](../vod-player/README.md)：音乐/视频播放和音频焦点。
- [bluetoothd](../bluetoothd/README.md)：独立的 OBEX 文件传输。
