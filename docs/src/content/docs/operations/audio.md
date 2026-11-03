---
title: 蓝牙语音通道
description: 配置系统语音会话、CyberAudio、可信遥控器和主机语音输出。
type: operation
status: current
audience: [operator, developer]
sourceOfTruth:
  - crates/audiod/src/main.rs
  - crates/audiod/src/bluez.rs
  - packages/api/src/lib/audio-coordinator.ts
  - packages/api/src/routes/audio.ts
  - packages/db/src/migrations/audio.ts
  - packaging/systemd/cyberos-audiod.service
sidebar:
  order: 8
---

## 支持边界

系统语音通道默认关闭。首版实现小米 ATVV 1.0 / 16 kHz IMA ADPCM
设备适配器，通过 BlueZ GATT 接收按住说话的录音，不拦截普通 HID 按键。
协议测试和模拟闭环不代表某一遥控器固件已经通过真实收音验收。
遥控器不可用时可以先配置和检查服务，但不要以其他麦克风替代其验收。

模型调用在 API 内协调；非 root 的 `cyberos-audiod` 只负责 GATT、音频解码、
有界录音和主机输出，不持有 CyberAudio 凭据。浏览器不采集、播放或转发语音。

## 配置

1. 在蓝牙页面配对、信任并连接遥控器。Audio 只列出已配对且可信的支持设备。
2. 在 **设置 → Audio** 保存 CyberAudio 基础地址和 Token。Token 留空保留，
   清除必须显式操作；读取 API 只返回 `tokenConfigured`。
3. 测试服务，分别确认地址可达、鉴权成功以及 STT、TTS 就绪，读取服务音色。
   `/ready` 不鉴权，不能代替 Token 测试。
4. 选择可信输入和明确的主机输出设备，设置录音上限（1–30 秒）、语言、音色、
   朗读指令、播报开关和音量。输出离线不会切到其他扬声器。
5. 保存后执行录音测试和语音输出测试。录音测试只显示转写，不创建 Agent 消息；
   输出进程正常退出也不等于人耳已确认实际出声。
6. 启用语音通道，按住语音键说话、松开投递。Agent 列表中的麦克风入口和
   Audio 的“打开语音历史”进入同一个系统语音会话。

首次启用创建唯一系统语音会话；跨重启保留 ID 和上下文。普通聊天仍为 `chat`，
语音会话为 `voice`。只能重置其模型上下文，不能普通删除；重置保留历史，
清除持久化 provider 映射并递增上下文代数，工作进程下次执行前丢弃旧运行时。
存在录音、识别、排队、运行或审批中的任务时拒绝重置。

## 播放与审批

- 新录音打断旧播报，但不自动取消正在执行的 Agent 任务。旧结果仍留在历史，
  被打断轮次的后续语音不再抢播。最多两个未完成轮次，超出明确报忙。
- 录音和播报使用 15 秒媒体占用凭证，API 持续续约。VOD player 退出当前 MPV
  进程以真正释放 ALSA；保留原媒体、位置和暂停状态。到期或结束时仅在凭证
  仍有效且未被用户或 Agent 的新媒体操作替代时恢复。API/播放连接断开会停止语音。
- 只从已关联 `jobId` 的 `agent.completed` 最终回复生成语音。不播放思考、工具
  参数或普通聊天的结果。Markdown、链接目标和代码块移除后按句有界分段，
  每段不超过 500 个 Unicode 字符，串行合成非流式 WAV。
- 蓝牙来源不是身份认证。权限规则与普通 Agent 完全相同；待审批时在语音会话
  审核，不能用一句口头确认绕过审批。

## 故障诊断

Audio 显示设备连接、协议、服务鉴权、独立模型就绪、最近轮次阶段、错误和耗时。
`sttMs` 为识别调用耗时，`ttsMs` 为首段合成到播放投递的耗时，`replyMs` 为
轮次登记到首段播放投递的耗时；这些不是声学实测的首次出声时间。

STT 失败或空转写不创建 Agent 任务。TTS/输出失败不重跑 Agent；查看会话中的
文字。429 按 `Retry-After` 有限重试，连接和响应体有超时及大小限制；重定向不
转发凭据。录音唯一 ID、事务和命令幂等键防止重复投递。

原始 WAV 仅暂存在 daemon 内存，识别后确认清除，未消费录音最长保留五分钟。
API 重启保留已有任务关联，但抑制旧轮次播报；不重播可能已经播放的内容。
蓝牙重连后重新发现特征并订阅，不复用旧 GATT 路径。

本地诊断接口（与其他管理 API 一样仅由 loopback API 和既有 Nginx 入口提供）：

| 接口 | 用途 |
| --- | --- |
| `GET/PATCH /api/settings/audio` | 兼容原服务地址的配置与凭据写入 |
| `GET /api/audio/status` | 会话 ID、设备状态、轮次、审批及录音测试结果 |
| `GET /api/audio/devices` | 可信输入和显式主机输出枚举 |
| `POST /api/audio/test/service` | 分别检查服务、鉴权、STT、TTS 和音色 |
| `POST /api/audio/test/recording` | 45 秒内对下一段遥控器录音做仅测试转写 |
| `POST /api/audio/test/speech` | 使用已保存配置在主机测试播报 |
| `POST /api/audio/stop` | 打断播报，不取消 Agent |
| `POST /api/audio/session/reset` | 空闲时重置默认语音上下文 |

```bash
systemctl status cyberos-audiod.service cyberos-vod-player.service cyberos-api.service
journalctl -u cyberos-audiod.service -u cyberos-api.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/audio/status
curl -fsS http://127.0.0.1:3010/api/audio/devices
```

## 升级与实机验收

本功能新增数据库迁移及 systemd 单元，必须走 Debian 包升级，不可用组件热替换。
升级前停索引及维护/健康/备份定时器，备份匹配旧包和 SQLite/state，再执行包升级、
重启及稳定性检查。回滚二进制不会自动逆转迁移；恢复旧包可能也需要恢复匹配 state。

真实验收仍需：遥控器生成可听 WAV、带 Token 的 STT/TTS、指定输出实际出声、
方向/返回等 HID 无回归，以及至少 20 轮对话、断连重连、审批、媒体暂停恢复、
手动切换媒体不被覆盖和输出离线不误播。无遥控器时只能报告这些项目尚未验证。
