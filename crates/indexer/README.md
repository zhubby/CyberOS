# indexer — 文件全文索引、影视目录与音乐元数据

`cyberos-indexer` 把存储池中的文件变成可查询的文件记录、全文内容、影视目录与音乐目录。常驻模式结合文件事件和周期校准；`--once` 模式把指定范围加入任务队列并执行一次处理。

原文件位于存储池，索引与任务状态位于业务 SQLite，音乐封面缓存位于 state。索引器读取用户文件，不承担用户文件的编辑或删除操作。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-indexer.service)

## 架构图

![indexer 任务调度与索引架构](docs/architecture.svg)

图中索引、影视和音乐处理共用进程和业务库，但各有数据模型与队列处理路径。目录扫描在独立异步任务中推进，避免普通大文件索引长期阻塞媒体目录更新。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/main.rs](src/main.rs) | CLI、日志、退出信号 |
| [src/config.rs](src/config.rs) | 根目录、数据库、存储池目录及生产模式 |
| [src/service.rs](src/service.rs) | 模式切换、存储池发现、任务领取、心跳、watchdog 与租约 |
| [src/watcher.rs](src/watcher.rs) | notify 事件、路径合并与目录变动提示 |
| [src/scanner.rs](src/scanner.rs) | 有界并发遍历、身份核验、增量跳过与扫描代次清理 |
| [src/storage.rs](src/storage.rs) | 基于目录句柄的安全打开、相对路径与挂载身份校验 |
| [src/extractor.rs](src/extractor.rs) | SHA-256、文本与文档提取、可选 OCR、检索词归一化 |
| [src/db.rs](src/db.rs) | 索引队列、租约、文件/FTS 发布、影视扫描与运行记录 |
| [src/media.rs](src/media.rs) | 影视发现、文件名/NFO 解析、TMDB 匹配与目录条目 |
| [src/http_proxy.rs](src/http_proxy.rs) | 影视 HTTP 客户端的显式代理策略 |
| [src/music.rs](src/music.rs) | 音乐来源扫描与条目分批处理 |
| [src/music_metadata.rs](src/music_metadata.rs) | Lofty 标签、工具补充信息、歌词与封面缓存 |
| [src/music_db.rs](src/music_db.rs) | 音乐扫描队列、缓存与发布 |
| [src/error.rs](src/error.rs) | 稳定错误码、是否可重试与错误清理 |

## 普通文件索引如何工作

1. 等待业务 schema，发现已配置布局下的存储池，读取索引设置。
2. API、文件事件或周期校准把路径写入 `index_queue`；手动 CLI 也走排队路径。
3. 领取任务时保存 worker 与代次等所有权条件，运行期间每 5 秒续租。
4. 扫描器通过 `StoragePoolStorage` 打开目录和文件，检查路径、符号链接、文件及挂载身份。
5. 对身份未变且已有内容的文件跳过重新提取，只更新需要的扫描代次。
6. 对变化文件计算哈希，按类型提取文本；PDF 可按设置进入 OCR，OOXML 在条目数、XML 大小等限制内解析。
7. 再次检查文件与池身份后，在事务中发布 `indexed_files` 与 `indexed_content_fts`。
8. 成功扫描的范围进入代次清理，处理已消失文件；未完整验证的扫描不能当作全库删除依据。

文件提取失败会保存可定位的提取错误，单个坏文件不应伪装成成功的空文本。扫描忽略 `.git`、`.cyberos`、`node_modules`、`dist`、`coverage` 等内部目录。

## 影视目录与音乐目录

影视路径由 `run_media_scan` 发现视频、解析名称和集数、读取受限大小的 NFO、收集本地封面，并按配置请求 TMDB。匹配覆盖项、语言、代理等与扫描任务一起使用，发布目录和普通 FTS 索引的语义不同。

音乐扫描读取来源配置并使用租约。元数据层优先处理音频标签，结合文件及旁路信息生成签名、专辑归属、歌词和封面；数据库层分批发布并记录扫描完成状态。封面缓存位于 `state/music/artwork`。

影视网络代理是显式策略：关闭代理时禁用环境代理继承；启用代理失败时不自动改为直连。该策略属于影视 HTTP 客户端，不应推广为其他 crate 的网络行为。

## 队列、事件与恢复

- 常驻模式注册 worker 心跳，维护 watchdog，并刷新设置与校准任务。
- notify 初始化失败时记录 watcher degraded，并补排全量校准任务。
- 文件事件只是增量提示；路径合并与周期校准共同处理重复事件或漏报。
- 任务续租失败会触发取消；完成和失败回写带所有权条件，避免失去租约的任务覆盖新任务。
- 失败按错误的可重试属性进入重试或终止路径；退出时取消子任务并释放 worker 状态。

这套机制保证的是可恢复的任务推进，不是磁盘内容在扫描期间永远静止。源身份复核用于识别读取中途的变化。

## 配置、CLI 与存储

| 项目 | 值或来源 |
| --- | --- |
| `CYBEROS_ROOT` | 生产固定 `/cyberos`；开发默认当前目录下 `.cyberos/dev-root` |
| 业务库 | `${CYBEROS_ROOT}/state/cyberos.sqlite` |
| 存储池根 | `${CYBEROS_ROOT}/data` |
| 索引设置 | 业务库 `system_settings`；由 `IndexerSettings` 校验 |
| 常驻启动 | 不传 CLI 参数 |
| 一次处理 | `--once` |
| 范围参数 | `--storage-pool ID`、`--path PATH`、`--recursive`，必须与 `--once` 一起使用 |

在仓库根目录查看帮助：

```bash
cargo run --locked -p cyberos-indexer -- --help
```

开发运行需要先初始化独立开发数据库和测试存储池。例如下列命令会实际索引指定开发范围：

```bash
CYBEROS_ENVIRONMENT=development \
CYBEROS_ROOT="$PWD/.cyberos/dev-root" \
cargo run --locked -p cyberos-indexer -- \
  --once --storage-pool pool-1 --path . --recursive
```

生产服务通过 systemd 把存储池设为只读，state/logs 可写，并限制地址族为 Unix 与 IP；提取工具和网络访问还需遵守服务沙箱。

## 开发与验证

```bash
cargo check --locked -p cyberos-indexer
cargo test --locked -p cyberos-indexer
```

测试包括路径与挂载保护、提取限制、数据库队列、文件变化、媒体及音乐扫描。真实文件系统事件、Linux 挂载和外部 TMDB 可用性仍需在对应环境验证。

排查时先区分 worker 心跳、watcher 状态、任务状态、提取错误和目录扫描状态，避免把一个层级的成功当作整个索引链路已完成。

## 继续阅读

- [文件提取实现](src/extractor.rs)、[事务发布](src/db.rs)、[挂载保护](src/storage.rs)。
- [photos](../photos/README.md)：照片专用元数据和衍生文件流水线。
- [downloader](../downloader/README.md)：下载写入及发布与索引读取的职责差异。
