---
title: HDMI 本地播放
description: 在无桌面 Debian NAS 设备上使用 CyberOS 将视频直接输出到 HDMI。
type: how-to
status: current
audience: [user, operator]
sourceOfTruth: [crates/vod-player/src/controller.rs, packages/api/src/routes/vod-player.ts, packages/web/src/components/preview/VodPlayerControls.tsx, packaging/systemd/cyberos-vod-player.service, packaging/scripts/install.sh, packaging/scripts/cyberos-tv-prepare, packaging/scripts/cyberos-tv-weston]
sidebar:
  order: 2
---

## 启用播放器

标准安装已包含 Chromium、Weston、mpv、seatd、CEC、输入工具和 `cyberos-vod-player.service`，不需要传入安装参数或生成播放器配置文件。服务以固定的非 root `cyberos` 身份运行，只读访问 storage pool，socket、状态路径和超时参数均为代码安全常量。

TV 模式在全新安装中默认开启。在 Web 中打开“设置 > 媒体”，可以关闭 TV 模式，或选择音频设备、DRM connector 和硬件解码策略；保存后由 API 通过受限的 hostd 操作应用 systemd 状态。切换失败时不写入 SQLite，持久化失败时会尝试恢复之前的宿主状态。

## 使用 Web UI

在文件面板选择视频后，点击预览标题栏中的 HDMI 播放按钮。视频会由设备本机的 mpv 读取 NAS 文件并输出到 HDMI；浏览器中的视频预览仍然独立工作。

播放器条支持播放/暂停、停止、进度跳转、前进/后退 10 秒、音量以及音轨/字幕选择。VOD Player 会持久化当前会话和位置，并在服务重启、存储暂时离线或 HDMI/音频设备重新连接后自动恢复；首版不保存播放队列或字幕选择。

## 检查设备能力

TV 模式下 Weston 持有 DRM 会话，mpv 作为 Wayland 全屏客户端输出视频。先检查设备和服务：

```bash
ls -l /dev/dri /dev/snd
systemctl is-active cyberos-vod-player.service
journalctl -u cyberos-vod-player.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/vod-player/status
```

常见问题：

- `mpv is not installed`：确认 CyberOS Debian 包与依赖安装完整，再重新安装当前包。
- `No DRM device found`：内核没有暴露 `/dev/dri/card*`，或设备没有加载 GPU/HDMI 驱动。
- `permission denied`：确认固定的 `cyberos` 服务账号属于存在的 `video`、`render` 和 `audio` 组，然后重新安装包以恢复组配置。
- 没有声音：检查 `/proc/asound`，然后在“设置 > 媒体”选择对应的 ALSA/BlueALSA 设备。
- TV 模式黑屏且 `/sys/class/drm/card*-HDMI-A-*/status` 全部为 `disconnected`：部分显示器或转接器不提供 HPD/EDID。先连接支持 EDID 的显示器并在“设置 > 媒体”选择实际 connector；默认 fallback 只尝试 `HDMI-A-1`。

`auto-safe` 会优先尝试可用硬件解码，驱动不支持时由 mpv 回退软件解码。具体硬件的解码能力仍需在目标板卡上验证。
