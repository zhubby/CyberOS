---
title: 影视库与独立设备播放
description: 管理电影和剧集，在当前浏览器或 NAS 电视上播放，并了解共享音频和转码限制。
type: how-to
status: current
audience: [user, operator]
sourceOfTruth:
  - packages/api/src/routes/media.ts
  - packages/api/src/routes/playback.ts
  - packages/api/src/routes/media-stream.ts
  - packages/media-streamer/src/manager.ts
  - crates/vod-player/src/controller.rs
sidebar:
  order: 4
---

## 建立影视库

在 Workspace 的 Video 中打开管理入口，添加存储池内的电影或剧集目录。扫描使用文件名、本地 NFO 和海报；配置 TMDB 后补充简介、评分、演职员和电影合集。匹配错误时在详情中搜索并确认正确条目，随后重新扫描。扫描失败或存储离线保留已有资料，移除来源不会删除原文件。

Web 与 TV 共用首页、电影、剧集、合集和待看。首页依次显示继续观看、下一集、最近入库和待看。搜索支持来源、年份、流派、收藏和观看状态，列表使用游标加载更多。剧集可分季选集、切换文件版本并逐集标记已看。手动合集可以创建、重命名、增删成员和删除；TMDB 合集由扫描管理。

## 选择播放设备

Web 默认“在此播放”，声音来自当前浏览器的本地输出。选择“电视播放”才启动 NAS 的电视会话。公共播放条通过“此设备 / NAS”选择控制对象，每一端拥有自己的进度、音量和停止操作；全屏时使用视频控件。

NAS 同时只运行一个音乐或影视会话。跨类型播放需要确认，取消或过期确认不会接管；音乐队列和影视进度各自保留。电影结束不自动恢复音乐，关闭 TV 只停止当前 NAS 影视。浏览器电影与 NAS 音乐可并行运行，关闭浏览器流不会停止 NAS 音乐。音乐首版只提供 NAS 遥控。

音乐与 NAS 影视分别保存输出、音量和静音。影视默认使用 TV 配置，可明确切换到已连接的蓝牙音箱。默认设备变更只影响后续启动，当前会话使用“切换输出”。显式音箱断连或输出打开失败时暂停并保留现场，不自动换成其他扬声器。服务重启后等待手动续播。音画同步偏移只用于影视，按输出保存，不应用于音乐。

## 浏览器兼容播放

独立的 TypeScript 服务 `cyberos-media-streamer.service` 通过 Unix socket 提供媒体，不打开 NAS 音频设备，也不参与音乐／电视接管。它按实际探测结果选择 MP4 H.264/AAC 直放、HLS 重封装或 H.264/AAC 转码；可选择音轨、字幕和清晰度。文本与位图字幕在选择后烧录到视频，HDR 转码尝试色调映射。缺少解码器或 FFmpeg 字幕／色调映射滤镜时显示失败，需要更换音轨、清晰度或安装对应能力；界面不承诺未经验证的直放格式。

默认同时运行一个 FFmpeg 任务（含重封装），最多保留 8 个流会话，可停止排队。HLS 使用 4 秒片段和 12 片段滑动窗口；心跳停止 90 秒后清理会话，服务启动时清理旧缓存。缓存上限 2 GiB，超限停止编码并提示重新播放。systemd 将服务限制为 768 MiB 内存、150% CPU 和 64 个任务，FFmpeg 使用 2 个编码线程。CM5 上请优先直放或降低清晰度；不能保证任意源文件实时转码。

流会话与 NAS 播放会话使用独立 ID。切换质量、音轨、字幕或跳转 HLS 进度会重新建立流；HLS 暂停后续播也从保存位置重建，避免旧缓存回收后跳到其他位置。服务检查存储挂载、路径、文件身份及大小／修改时间，源文件变化后需要重扫并重新播放。播放进度约每 10 秒保存，显式停止前保存一次；意外断电可能丢失最后一小段进度。

## 运维与验收

```bash
systemctl is-active cyberos-vod-player.service cyberos-media-streamer.service
journalctl -u cyberos-vod-player.service -u cyberos-media-streamer.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/playback/status
curl -fsS http://127.0.0.1:3010/api/media/status
```

NAS 播放仍由非 root 的 `vod-player` 串行执行；公共状态和事件为 `/api/playback/status`、`/api/playback/events`，音乐与影视领域接口分别保持在 `/api/music/*`、`/api/media/*`。浏览器流位于 `/api/media/playback-sessions`。新增资料、个人状态和探测缓存通过增量迁移加入现有 SQLite，升级前先备份状态并停止数据库写入者。

在目标 Linux 主机验收 HDMI／BlueALSA 音频、双向接管、音箱断连无回退、输出切换保留位置、音画同步、TV 关闭以及服务重启。macOS 开发测试不能替代这些硬件验收。浏览器验收还应覆盖本地视频与 NAS 音乐并行、取消排队、直放／重封装／转码、音轨字幕、全屏、跨端进度和离线存储。
