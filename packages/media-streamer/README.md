# media-streamer — 浏览器视频流会话与转码

`@cyberos/media-streamer` 是面向浏览器的常驻视频流服务。它根据媒体库文件和浏览器能力选择 direct、remux 或 transcode，管理临时流会话、安全文件句柄、FFprobe/FFmpeg 子进程和 HLS 缓存，再由 API 代理给浏览器。

它通过 Unix socket 提供本地 HTTP，不直接开放 LAN 端口。NAS 上的原生 mpv 播放由 [Rust vod-player](../../crates/vod-player/README.md) 处理；两个执行路径分别管理。

[返回工作空间总览](../README.md) · [包定义](package.json) · [systemd 单元](../../packaging/systemd/cyberos-media-streamer.service)

## 架构图

![浏览器媒体流的安全打开、规划与 HLS 架构](docs/architecture.svg)

Planner 只计算处理方案，实际文件打开与子进程调度由 StreamManager 完成。direct 使用已验证的文件句柄响应字节范围，处理模式才生成 HLS。

## 源码导航

| 文件 | 职责 |
| --- | --- |
| [src/index.ts](src/index.ts) | runtime、只读业务库、manager/server 和退出信号 |
| [src/server.ts](src/server.ts) | Unix socket 占用检查、HTTP 会话接口、资源 Range 响应与关闭 |
| [src/manager.ts](src/manager.ts) | 会话、容量、safeOpen、probe、FFmpeg、文件身份、过期和缓存清理 |
| [src/planner.ts](src/planner.ts) | 轨道提取、direct/remux/transcode 决策和 FFmpeg 参数 |
| [shared 流客户端](../shared/src/media-stream-client.ts) | API 使用的 Unix HTTP 客户端与 socket 路径 |

## 一次播放请求

1. 浏览器请求 API 创建播放会话；API 通过 Unix HTTP 把 fileId 和播放选项传给本服务。
2. manager 检查选项、会话容量、媒体条目、启用来源和排除状态，先返回 queued session。
3. pump 串行探测 queued 项，safeOpen 校验文件和存储身份，记录 dev/ino/size/mtime/ctime 等信息。
4. FFprobe 得到容器、时长和轨道，Planner 选择模式，检查请求的音轨/字幕是否存在。
5. direct 直接变为 ready；处理模式在编码容量可用时启动 FFmpeg，首个 playlist 可用后进入 ready。
6. 浏览器查询 session，随后通过 API 读取 direct 字节或 m3u8/ts 分片。
7. 关闭、过期、错误或退出时释放子进程/句柄，清理对应缓存。

## 三种模式

| 模式 | 条件与行为 |
| --- | --- |
| direct | 保守接受 MP4/H.264、兼容像素格式/非 HDR、AAC 或无音轨、无强制轨道重映射等条件；直接读取文件 |
| remux | 视频可兼容且无需画面处理，但容器/音频需要适配；视频 copy，输出 HLS |
| transcode | 编码不兼容、质量选择、字幕烧录、HDR/像素格式等条件要求处理；编码为浏览器可用输出 |

HEVC 支持由浏览器显式能力输入参与决策。字幕可走文本字幕滤镜或图形字幕 overlay；HDR 处理依赖 zscale/tonemap。缺少所需滤镜时明确失败，不将不兼容内容冒充成功输出。

转码默认使用 CPU `libx264`，编码线程和分辨率有界。`quality=original` 不意味着所有输入都原封不动输出，仍需遵守浏览器兼容性决策。

## 容量和生命周期

最多保留八个会话；最多一个 FFmpeg 编码/重封装进程。direct 不占编码槽，但仍占会话容量。queued/preparing/ready/error 是 session 状态，不是持久数据库队列。

session 在进程内存；缓存位于 `state/media-streamer/<uuid>`，启动清理旧 UUID 缓存，后台周期清扫过期/容量问题。进程重启后旧 session 不会恢复，客户端需要重新创建。

查询 ready session 时会复核路径和打开句柄身份；文件变化或 pool 离线使该 session 失败，需要重新扫描/播放。退出时关闭 HTTP 连接，停止所有会话，再关闭只读数据库。

## 路径与资源保护

safeOpen 限制 fileId 对应的库条目和已启用来源；拒绝越界语法、pool symlink、来源外文件、嵌套挂载以及不匹配的文件元数据。生产还检查 mountinfo，打开使用 O_NOFOLLOW，并在 Linux 经 `/proc/self/fd` 复核实际句柄路径。

FFmpeg 读取继承的文件描述符，使用参数数组和受限协议白名单；资源只允许 direct 或固定形式的 playlist/segment 文件名。Range 响应不把共享 direct 句柄的所有权交给单次请求，避免连接关闭误伤后续播放。

本服务只读业务库和用户媒体，不保存观看进度；API 的媒体业务路径负责进度持久化。systemd 仅允许 Unix 地址族，数据根只读，state 与运行目录可写。

## 开发与验证

```bash
CYBEROS_ENVIRONMENT=development \
CYBEROS_ROOT="$PWD/.cyberos/dev-root" \
npm run dev -w @cyberos/media-streamer
npx vitest run packages/media-streamer packages/api/src/routes/media-stream.test.ts
npm run build -w @cyberos/media-streamer
```

需要已有业务 schema/媒体目录及 FFprobe、FFmpeg。测试覆盖模式选择和会话边界；真实视频、字幕、HDR、浏览器解码与连续播放需分别验收。
