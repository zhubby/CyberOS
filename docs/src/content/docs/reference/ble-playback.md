---
title: BLE 播放协议 v1
description: CyberController StickS3 与 audiod 的逐段完整接收播放协议。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth:
  - crates/audiod/src/playback.rs
  - crates/audiod/src/ble_output.rs
sidebar:
  order: 18
---

## 边界与服务

产品是 CyberController，StickS3 是设备适配器。标准 ATVV 仅上行；下行在同一条
BLE 连接中使用独立服务。本页是两端的二进制契约，不新增 HTTP 接口、会话或迁移。
输入由标准 ATVV UUID 发现，不使用 StickS3 厂商白名单，不注册 HID 或冒充小米。

| 项目 | UUID | 属性 |
| --- | --- | --- |
| 播放服务 | `d9870001-bc7a-4c40-8c98-781a66a7b401` | 主服务 |
| 控制 | `d9870002-bc7a-4c40-8c98-781a66a7b401` | write，要求加密及 MITM 认证 |
| 数据 | `d9870003-bc7a-4c40-8c98-781a66a7b401` | write，要求加密及 MITM 认证 |
| 状态 | `d9870004-bc7a-4c40-8c98-781a66a7b401` | read / notify，要求加密及 MITM 认证 |

所有多字节整数是**无符号小端**。版本固定 `1`，播放 ID 为非零随机 `u32`。
主机必须先订阅状态，再 START。输入 ID `bluez:<Device1 路径>` 与输出 ID
`ble-playback:<同一路径>` 必须匹配；设备必须 paired、trusted、connected。
输出名称明确包含“StickS3 内置扬声器”。每次重新发现服务，不保存 characteristic 路径。

## 音频与完整性

编码 `1` 明确定义为 **16000 Hz、单声道、每样本 4 bit IMA-ADPCM**；不是 WAV
IMA 分块格式。每段 predictor=0、step index=0，高半字节在前，连续更新状态。
每个输入 PCM 样本产生一个半字节；奇数样本最后一个低半字节补零、不解码。
不在帧或分片间重置。CRC32 使用 IEEE / ISO-HDLC：多项式 `0xEDB88320`（反射）、
初值 `0xFFFFFFFF`、最终异或 `0xFFFFFFFF`，覆盖所有压缩字节（包括末尾填充）。

样本数范围 1–2080000（最长 130 秒），压缩长度必须恰好为 `ceil(samples/2)`，
且不超过 2097152 字节。固件用 PSRAM 收完整段，验证长度、序号和 CRC 后才能开扬声器。
已验证的压缩段解码为有界 PCM；尾部追加 100 ms 静音，等待扬声器队列和尾部排空，
停输出、释放 PCM 后才发送 COMPLETED。这仍不是人耳或声压实测的替代品。

## 控制

START 恰好 20 字节，兼容最小 ATT MTU=23：

| 偏移 | 类型 | 内容 |
| --- | --- | --- |
| 0 | u8 | version=1 |
| 1 | u8 | opcode=1（START） |
| 2 | u32 | playback ID |
| 6 | u32 | PCM 样本数 |
| 10 | u32 | 压缩字节数 |
| 14 | u32 | CRC32 |
| 18 | u8 | 音量百分比，0–100 |
| 19 | u8 | codec=1，包含固定采样率和声道参数 |

END（opcode=2）和 CANCEL（opcode=3）恰好 6 字节：version、opcode、playback ID。
END 不是成功：设备先校验并开始播放，只有 COMPLETED 才成功。
CANCEL 幂等清除同 ID 的缓冲、停止扬声器；不匹配的旧 CANCEL 不干扰当前录音。
不得在上一段仍接收或播放时 START 新段。重复、跳号、越界或不支持的格式报错并清缓冲。

## 数据和流控

DATA = `playback ID:u32` + `sequence:u32` + 1 个或更多压缩字节，序号从 0 连续递增。
ATT 写入有效载荷最多 `min(MTU-3, 512)`（同时遵守属性值上限），故每片压缩数据最多
`min(MTU-3, 512)-8`；以实际协商 MTU 为准，
主机不能读到 MTU 时保守使用 23。最后一片可以较短，不假定 2M PHY。
主机使用带响应的 GATT write，应用层仍要求状态确认。

状态恰好 20 字节：

| 偏移 | 类型 | 内容 |
| --- | --- | --- |
| 0 | u8 | version=1 |
| 1 | u8 | 状态：1 receiving，2 playing，3 completed，4 cancelled，5 error |
| 2 | u32 | playback ID（空闲缓存状态可为 0，主机忽略其他 ID） |
| 6 | u32 | 下一期望分片序号 |
| 10 | u32 | 已收压缩字节数 |
| 14 | u16 | credits，0–8；receiving 时通常为 8 |
| 16 | u16 | 错误码，正常为 0 |
| 18 | u16 | 保留，必须为 0 |

START 确认后主机最多发送 credits 个分片，然后等待确认。设备每 8 片或收齐时通知；
credits 是从该确认序号起可再发送的数量。主机扣掉确认之后已发送的在途分片，不能用
重复/迟到确认扩大窗口。确认的序号、累计长度必须与发送量一致。发 END 前必须获得
全量接收确认，完成确认也必须含相同 ID、最终序号和长度。仅 playing 不能判定成功。

错误码：1 invalid，2 busy，3 sequence/length，4 checksum，5 allocation，6 timeout，
7 audio initialization/playback，8 disconnected。错误或取消后不自动重试或改用主机音箱。

## 超时、打断和安全

设备接收期限从 START 起 120 秒；主机 BLE 下发总期限也是 120 秒，单次进度确认等待
最多 10 秒。播放期限为样本时长加 5 秒；主机还限制转换 10 秒、整次 BLE 操作 265 秒，
Unix 客户端只在 BLE 输出分支放宽至 270 秒。ALSA 仍是 130 秒播放、135 秒 IPC。
主机取消、调用者断连、蓝牙断连、超时和校验失败均失败且清理，不触发 Agent 重跑。

按下 A 先停止本地扬声器、清接收段，再请求 ATVV 录音；松开结束。断连丢弃尚未
投递的录音，不排队等以后自动发送。录音和扬声器互斥；输入或输出改变会抑制旧轮次
播报，迟到结果留在历史，不转送新设备。固件没有 CyberAudio 地址或 Token。

配对须按住 B 2 秒进入 60 秒显式模式（USB 诊断命令 PAIR 同样是显式开启）；屏幕显示
六位验证码。Secure Connections、MITM 和 bonding 必须成功；非配对模式拒绝未知设备。
绑定保存在 ESP32 NVS。不要共享验证码、固件 dump 或声学样本；取消配对在系统蓝牙页
移除绑定，重新配对前须再次显式开启模式。首次验收从低音量开始，固件另有 64/255 硬上限。

## 独立参考向量

- CRC32(`123456789`) = `0xCBF43926`；空字节串 CRC32=0。
- PCM `[1, 4, 15, 17, -8, -64]` 编码为 `12 70 FF`；初始状态 0/0，依次解码结果相同。
- 3 个零样本编码为 `00 00`，CRC32=`0x41D912FF`。
- ID=`0x12345678`、3 个零样本、音量 7 的 START：

```text
01 01 78 56 34 12 03 00 00 00 02 00 00 00 FF 12 D9 41 07 01
```

- ID=42、seq=0、两个零字节的 DATA：`2A 00 00 00 00 00 00 00 00 00`。
- 对应 END：`01 02 2A 00 00 00`；CANCEL：`01 03 2A 00 00 00`。
- 对应 COMPLETED：

```text
01 03 2A 00 00 00 01 00 00 00 02 00 00 00 00 00 00 00 00 00
```

Rust 和固件原生测试分别固定这些字节，不使用另一端实现生成预期结果。
ATVV 控制协商、开麦、同步和结束使用标准服务 `ab5e0001-5a21-4f05-bc7d-af01f617b664`；
ATVV 的 predictor 同步是**大端 i16**，不要与本下行协议的小端混用。帧为 120 压缩字节，
上行按协商 MTU 切成通知，但编码状态跨片连续；能力通知 `0B 01 00 02 00 00 78`，
开麦通知 `04 00 00 <stream>`，同步 `0A 00 00 <stream> 00 00 00`，松开通知 `00`。
