---
title: HDMI 本地播放
description: 在无桌面 Debian NAS 设备上使用 CyberOS 将视频直接输出到 HDMI。
type: how-to
status: current
audience: [user, operator]
sourceOfTruth: [crates/vod-player/src/controller.rs, packages/api/src/routes/vod-player.ts, packages/web/src/components/preview/VodPlayerControls.tsx, packaging/systemd/cyberos-vod-player.service, packaging/scripts/cyberos-tv-prepare, packaging/scripts/cyberos-tv-weston]
sidebar:
  order: 2
---

## 启用播放器

通用安装默认不启用 HDMI 播放器。安装或重新安装时显式启用：

```bash
sudo CYBEROS_ENABLE_VOD_PLAYER=1 \
  CYBEROS_VOD_PLAYER_USER=cyberos \
  CYBEROS_NAS_ROOT_PATH=/cyberos/data/primary \
  ./packaging/scripts/install.sh
```

安装脚本会安装 `mpv` 和 `seatd`，生成 `cyberos-vod-player.service` 的权限 drop-in，并启用 VOD Player。服务以非 root 用户运行，只读访问配置的 NAS root。

构建 appliance rootfs 时使用 `CYBEROS_ENABLE_VOD_PLAYER=1`，镜像会启用播放器配置和 systemd 服务；默认值为 `0`。

如果只是修改配置，可以在 `/cyberos/config/config.toml` 中设置：

```toml
[vod_player]
enabled = true
socket_path = "/run/cyberos/vod-player.sock"
state_path = "/cyberos/state/vod-player/session.json"
command_timeout_ms = 5000
startup_timeout_ms = 15000
checkpoint_interval_ms = 5000
retry_base_delay_ms = 2000
retry_max_delay_ms = 60000
video_output = "drm"
drm_connector = ""
audio_output = "alsa"
audio_device = ""
hwdec = "auto-safe"
user = "cyberos"
```

`socket_path` 必须位于 `/run` 等 API 与 VOD Player 共同可见的目录，`state_path` 必须位于持久存储；两者都不能放在 `/tmp` 或 `/var/tmp`。systemd 为两个服务启用了独立的临时目录命名空间，并且临时目录无法保存整机重启后的播放位置。

修改后执行：

```bash
sudo /usr/lib/cyberos/scripts/cyberos-refresh-vod-player.sh
sudo systemctl daemon-reload
sudo systemctl restart cyberos-vod-player.service
```

## 使用 Web UI

在文件面板选择视频后，点击预览标题栏中的 HDMI 播放按钮。视频会由设备本机的 mpv 读取 NAS 文件并输出到 HDMI；浏览器中的视频预览仍然独立工作。

播放器条支持播放/暂停、停止、进度跳转、前进/后退 10 秒、音量以及音轨/字幕选择。VOD Player 会持久化当前会话和位置，并在服务重启、存储暂时离线或 HDMI/音频设备重新连接后自动恢复；首版不保存播放队列或字幕选择。

## 检查设备能力

仅启用 VOD Player 时，播放器使用 mpv 的 DRM/KMS 视频输出，不依赖 X11 或 Wayland。CM5 启用[电视模式](/docs/operations/cm5/#hdmi-电视模式)后，Weston 持有 DRM 会话，mpv 改为 Wayland 全屏客户端。先检查设备和服务：

```bash
ls -l /dev/dri /dev/snd
systemctl is-active cyberos-vod-player.service
journalctl -u cyberos-vod-player.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/vod-player/status
```

常见问题：

- `mpv is not installed`：安装 `mpv`，或用 `CYBEROS_ENABLE_VOD_PLAYER=1` 重新运行安装脚本。
- `No DRM device found`：内核没有暴露 `/dev/dri/card*`，或设备没有加载 GPU/HDMI 驱动。
- `permission denied`：确认播放器用户属于存在的 `video`、`render` 和 `audio` 组，并重新运行 `cyberos-refresh-vod-player.sh`。
- 没有声音：检查 `/proc/asound`，然后把 `audio_device` 设置为对应的 ALSA HDMI 设备。
- TV 模式黑屏且 `/sys/class/drm/card*-HDMI-A-*/status` 全部为 `disconnected`：部分显示器或转接器不提供 HPD/EDID。TV 模式会在没有任何已连接 HDMI 时临时强制 `HDMI-A-1`，停止 TV 模式后恢复自动检测。若使用第二个接口，在 `cyberos-tv-prepare.service` drop-in 中设置 `Environment=CYBEROS_TV_HDMI_CONNECTOR=HDMI-A-2`；设置 `Environment=CYBEROS_TV_FORCE_HDMI=never` 可禁用 fallback。

`hwdec = "auto-safe"` 会优先尝试可用硬件解码，驱动不支持时由 mpv 回退软件解码。具体硬件的解码能力仍需在目标板卡上验证。
