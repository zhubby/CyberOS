---
title: 音乐库与 NAS 音箱播放
description: 添加本地音乐目录、浏览专辑与歌单，并遥控 NAS 音频输出。
type: how-to
status: current
audience: [user, operator]
sourceOfTruth:
  - packages/api/src/routes/music.ts
  - packages/db/src/migrations/music.ts
  - crates/indexer/src/music.rs
  - crates/vod-player/src/controller.rs
sidebar:
  order: 3
---

## 添加音乐

在 Workspace 打开 Music，通过来源设置选择存储池内的音乐目录。添加后自动扫描；后续文件变更触发增量扫描，也可以手动重扫。Music 只读取原始文件，不修改音乐标签，不从外网下载元数据。

支持 MP3、FLAC、M4A、AAC ADTS、Ogg、Opus、WAV 和 AIFF。专辑、艺术家和曲目顺序优先来自文件标签；多碟专辑可以放在专辑目录下的 `CD1`、`CD2` 等子目录中。封面优先使用内嵌图片，其次使用 `cover.jpg`、`cover.png`、`folder.jpg` 或 `folder.png`。歌词支持内嵌文本、LRC 以及同名 `.lrc`、`.txt` 文件。

扫描失败或存储池离线不会清空已有库。文件确实缺失后，歌曲会标记为不可播放；收藏、歌单和历史仍保留。移除音乐来源不会删除原始文件。

## 浏览与播放

概览显示最近添加、最近播放、常听和收藏。也可以按专辑、艺术家、歌曲或歌单浏览，并按年份、流派、来源和收藏筛选。

Music 遥控 NAS 本机播放，不在当前浏览器解码音频。点击播放后，应用底部出现全局控制条；切换到其他面板、切回 Agent 或关闭全部浏览器，NAS 仍会继续播放并自动换曲。

播放队列支持下一首插播、末尾追加、移除、排序、随机和循环，也可以保存成歌单。多个浏览器或手机控制同一套队列；若队列版本已变化，刷新当前状态后重新操作。

## 选择音箱与恢复播放

输出菜单可以选择本机默认音频输出或已配对的蓝牙音箱。新增蓝牙配对在系统蓝牙设置中完成。切换输出时保留当前歌曲、进度和队列；界面显示实际生效的输出。

音箱断开后音乐暂停，不会自动从其他扬声器响起。重新连接设备后手动续播。NAS 或播放服务重启也会保留队列与进度并等待手动续播；仅重启 API 不会停止音乐。

音乐与 NAS 电视影视共用一个活动播放会话；当前浏览器看电影使用独立流服务，可以与 NAS 音乐同时播放。浏览器的暂停、音量、停止和全屏不会控制 NAS。

公共控制条通过“此设备 / NAS”选择控制对象，浏览器播放时默认显示此设备。NAS 电影播放期间，音乐队列仍可在抽屉中维护，续播音乐需要确认接管。音乐与影视分别保存音量、静音和输出偏好；切换不会修改系统总音量。修改默认设备只影响后续启动，当前会话通过明确的切换输出操作生效。

启动另一类播放前需要确认切换，原音乐队列和进度会保留。影视结束后不会自动恢复音乐。开启或关闭 TV 模式不重启共享播放服务；关闭 TV 只停止当前影视会话。

## 运维检查

```bash
systemctl is-active cyberos-indexer.service cyberos-vod-player.service
journalctl -u cyberos-indexer.service -u cyberos-vod-player.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/music/status
curl -fsS http://127.0.0.1:3010/api/music/player
```

音乐播放不要求开启 TV 或连接显示器。服务仍以非 root `cyberos` 身份运行，通过受控文件描述符读取存储池文件。播放没有声音时，先核对控制条的实际输出、系统默认声卡以及蓝牙连接状态。

主机安装和部署流程会在 API 完成数据库恢复后启动常驻的 `cyberos-vod-player.service`，TV 关闭时仍保持运行。音乐现场位于 `/cyberos/state/vod-player/session.music.json`；备份状态目录时同时保留它与音乐数据库。内部播放协议为 v3，仍可读取当前 CyberOS 的 v2 影视检查点；升级时先停止播放服务和其他数据库写入者，完成数据库迁移后再启动服务。
