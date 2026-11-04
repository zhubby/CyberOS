# photos — 照片库扫描与衍生文件处理

`cyberos-photos` 是照片和视频素材的后台处理器：扫描配置的照片库，提取元数据，生成缩略图与预览，并把资产状态写回业务数据库。原片保持只读，衍生文件存入 `state/photos`。

它通过任务租约、扫描检查点、发布 journal 和文件身份核验协调数据库与文件系统，处理进程退出、存储掉线和原片变化等情况。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-photos.service)

## 架构图

![photos 扫描与发布架构](docs/architecture.svg)

处理结果先登记发布日志，再发布文件，最后完成资产记录。文件系统与 SQLite 不共享一个原子事务，journal 用于衔接这两个提交阶段。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/main.rs](src/main.rs) | 日志、配置、信号与 worker 启动 |
| [src/config.rs](src/config.rs) | 开发/生产路径、媒体工具检查、缓存相关基础操作 |
| [src/worker.rs](src/worker.rs) | 主循环、批次扫描、任务租约、并发处理、发布及恢复 |
| [src/db.rs](src/db.rs) | 配置、任务、检查点、资产、空间预留与发布日志 |
| [src/storage.rs](src/storage.rs) | `Library`、目录句柄、安全打开、挂载与文件身份 |
| [src/media.rs](src/media.rs) | 类型识别、元数据、旁路文件和衍生文件生成 |
| [src/command.rs](src/command.rs) | 有界外部媒体命令执行 |
| [src/publish.rs](src/publish.rs) | 缓存锁、无覆盖发布、文件同步与孤立文件清理 |
| [src/retry.rs](src/retry.rs) | 根据错误和处理设置计算重试延迟 |
| [src/error.rs](src/error.rs) | 错误码、可重试分类与消息 |
| [tests/indexing.rs](tests/indexing.rs) | 照片索引和恢复相关集成测试 |
| [tests/fake_tools.rs](tests/fake_tools.rs) | 替代媒体工具的测试支持 |

## 启动与工作循环

启动时先等待业务 schema，检查媒体工具，取得缓存清理锁并清理已知孤立临时文件，再恢复发布 journal。原存储暂不可用时记录等待状态；其他恢复错误可能阻止启动。

随后注册 worker 并报告 ready，同时运行心跳、watchdog 和历史清理任务。主循环约每秒执行一次 tick：恢复日志、读取照片库与处理设置、保证周期任务存在、领取任务、运行并按错误分类重试。

没有配置照片库时，worker 可以空闲等待，不会自行扫描所有存储池。

## 从扫描到资产可见

1. 领取 `photos_jobs` 后复核照片库版本、存储池和路径；设置已变化的旧任务不能继续发布。
2. `Library::resolve` 建立允许访问的库边界；生产模式还要求存储池挂载就绪。
3. 以批次和检查点推进遍历，保存已发现条目；路径刷新可在目标目录消失时退回最近有效祖先。
4. 打开原片及可用旁路元数据，记录文件身份，判断是否能重用已有衍生文件。
5. 按处理设置限制并发与空间预留，再调用媒体流水线生成元数据、缩略图和预览。
6. 处理完成后重新检查原片、旁路文件和租约。仅元数据变化且可重用衍生文件时，走较短的元数据提交路径。
7. 常规路径写入 `PublishRecord`，登记 journal，再同步和发布衍生文件。
8. 再次核验来源后，通过带 worker 所有权条件的数据库操作提交资产，并清理对应临时文件。
9. 完成有效扫描范围后才执行相应清理，避免不完整遍历把暂时不可见的素材当成删除。

## 发布日志与缓存锁

`CacheLock` 使用 `.cache.lock` 和文件锁协调处理、发布与清理。获取锁和耗时文件操作放到阻塞任务中，避免同步文件锁直接阻塞 Tokio 执行线程。

`publish_one` 校验缓存路径与预期文件身份，对源文件执行同步，再进行不覆盖目标的重命名并同步父目录。已有目标必须符合 journal 预期身份或内容，否则报告冲突。

重启恢复读取已保存的 journal，核验来源、衍生文件和当前库配置后决定完成或中止。不能仅凭某张缩略图存在就断言资产提交成功，也不能通过清空缓存绕过尚未完成的发布事务。

## 输入、输出与配置

| 项目 | 位置或来源 |
| --- | --- |
| 根目录 | `CYBEROS_ROOT`，生产固定 `/cyberos` |
| 业务库 | `${CYBEROS_ROOT}/state/cyberos.sqlite` |
| 原片 | `${CYBEROS_ROOT}/data` 下配置的照片库范围 |
| 缩略图和预览 | `${CYBEROS_ROOT}/state/photos` |
| 库配置、处理设置 | 业务数据库；由 API 设置和任务生产侧管理 |
| worker 身份 | 每次启动生成 UUID，用于心跳、领取和发布所有权 |

启动检查要求 PATH 中具有 `exiftool`、`vipsthumbnail`、`vipsheader`、`ffprobe`、`ffmpeg`、`dcraw_emu`、`heif-convert`。各媒体类型的具体调用路径由 [media.rs](src/media.rs) 决定，工具可执行不等于所有格式都已实机验收。

## 一致性、安全与故障行为

- 原片只读，资产索引与衍生文件分别存储。服务单元禁止网络访问，仅开放 Unix 地址族。
- 遍历和打开依赖相对路径、符号链接、库范围和挂载身份检查，不能直接拼接客户端绝对路径。
- worker 心跳和任务租约约每 5 秒续期；失去租约后停止后续提交。
- 缓存空间与文件身份在处理、发布和恢复阶段复核；磁盘不足或源变化要形成明确状态。
- 任务取消、库版本变化和扫描范围会影响收尾，不能全局清理未验证的素材。
- 元数据部分可用可携带 warning/partial 状态；这与完全无法处理的任务失败不同。

## 开发与验证

在仓库根目录运行：

```bash
cargo check --locked -p cyberos-photos
cargo test --locked -p cyberos-photos
```

开发运行需要独立开发根目录、已初始化业务 schema、测试照片库以及工具链；不要将生产路径作为测试目录。fake tools 测试验证调度和故障语义，真实 RAW、HEIF、视频解码质量以及 Linux 挂载保护需另外验证。

只读排查：

```bash
systemctl status cyberos-photos.service
journalctl -u cyberos-photos.service -n 100 --no-pager
```

定位问题时区分任务阶段、重试原因、库版本、缓存容量和 journal 状态。一次缩略图生成成功不能证明整库扫描和清理已完成。

## 继续阅读

- [worker 发布顺序](src/worker.rs) 与 [文件发布实现](src/publish.rs)。
- [API 照片路由](../../packages/api/src/routes/photos.ts)：任务和资产如何进入产品界面。
- [indexer](../indexer/README.md)：普通文件、影视和音乐索引。
