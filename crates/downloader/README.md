# downloader — 可恢复的 HTTP 与 BitTorrent 下载

`cyberos-downloader` 消费业务库中的下载任务，负责网络传输、进度检查点、暂停/取消响应、空间预留和最终发布。HTTP/HTTPS 与 BitTorrent 共用 worker 管理和产品状态，但各有传输引擎及网络策略。

服务以 `cyberos` 用户写入指定存储池，最终目标受到路径、挂载和禁止覆盖约束。它不开放自己的 HTTP 服务，产品控制通过 API 与 SQLite 任务状态进入后台。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-downloader.service)

## 架构图

![downloader 双通道传输与发布架构](docs/architecture.svg)

HTTP 单文件与 BT 目录使用各自的存储目标类型。图中把它们概括为受限发布层，具体恢复和文件布局仍分别实现。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/main.rs](src/main.rs) | 日志、配置、取消信号与启动 |
| [src/config.rs](src/config.rs) | 根目录、业务库、存储池根和生产约束 |
| [src/download.rs](src/download.rs) | 调度、HTTP 探测、续传/分段、检查点和发布恢复 |
| [src/network.rs](src/network.rs) | URL、DNS/IP、重定向、TLS、请求超时与 Range |
| [src/p2p.rs](src/p2p.rs) | librqbit 会话、种子预览、文件选择和 BT 任务执行 |
| [src/storage.rs](src/storage.rs) | `StorageTarget` / `TorrentStorageTarget`、挂载和句柄校验、发布 |
| [src/db.rs](src/db.rs) | 下载队列、worker、分段、预览、进度、预留与 journal |
| [src/retry.rs](src/retry.rs) | 指数退避、jitter、`Retry-After` 解析 |
| [src/error.rs](src/error.rs) | 稳定错误分类、可重试标记与存储错误识别 |

关键依赖是 Tokio、reqwest/rustls、rusqlite、sha2、nix，以及固定版本的 librqbit。

## 调度与所有权

启动等待业务 schema，注册 worker，回收过期任务并恢复发布 journal，再创建 BT 引擎。调度器以 750ms 为轮询间隔，心跳间隔为 5 秒，任务租约为 30 秒。

HTTP 可用槽位由设置并发数减去数据库中的运行任务数决定。BT 下载当前单独限制为一个运行槽位，预览解析也有独立任务集合；这些限制不能用 HTTP 并发参数替代。

任务执行过程中更新进度并续租，控制请求和所有权丢失会中断处理。退出时发出取消，最多等待一段收尾时间，再中止残留任务、重新排队本 worker 持有的任务并删除 worker 记录。

## HTTP 下载的完整路径

1. 从数据库领取任务，读取下载设置并解析安全目标路径。
2. 通过受控请求探测资源，检查长度、ETag、Last-Modified 和 Range 能力。
3. 对满足条件的资源选择分段传输；没有可靠长度或验证信息时使用适当的单流路径。
4. 续传请求附带 Range/If-Range，并验证响应状态、Content-Range 和资源验证器，避免把另一版本资源接到旧文件后。
5. 字节写入部分文件；进度和分段检查点按周期写回数据库。生产分段计划使用最小分段大小和最大分段数量约束。
6. 持续检查大小上限、磁盘预留、取消信号和租约。传输结束复核长度并同步数据。
7. 按任务要求进行完整性核验，准备发布 journal，应用目标目录所需权限，再禁止覆盖地发布。
8. 完成数据库状态和 journal 收尾。进程在文件已发布但数据库未完成时退出，可由恢复路径识别和收尾。

HTTP 传输字节完成、文件发布完成和任务状态完成是三个需要分别确认的阶段。

## HTTP 网络策略

`network.rs` 仅允许支持的 HTTP URL，解析主机后校验公网地址，并把校验过的地址固定到当前 reqwest 客户端。每次重定向都重新走 URL 和目标地址检查，最多 5 次；HTTPS 不允许降级到 HTTP。

客户端显式调用 `no_proxy()`，不继承环境代理，也不代表自动采用 CyberOS 系统代理设置。连接、响应头和读空闲分别有超时，`Accept-Encoding: identity` 保持 Range 与落盘字节含义一致。

可重试 HTTP 状态支持 `Retry-After`。普通退避包含指数增长与随机扰动，并受最大等待值约束；明确给出的服务器延迟也有上限。

## BitTorrent 通道

`TorrentEngine` 持有共享的 `librqbit::Session`。预览先解析元数据和文件列表，实际任务再根据选择的文件进入下载和目录发布。

当前会话不启用 librqbit 的持久化与 fastresume，UPnP 自动端口映射关闭。产品任务状态、文件选择及恢复由 CyberOS 自己的数据库和存储逻辑承接，不应假定外部引擎替它完成事务恢复。

HTTP 的公网 DNS、重定向和代理限制只在 HTTP 通道实施。BT 的 peer、tracker 和 DHT 行为需要按 `p2p.rs` 及引擎选项独立理解。

## 持久化与安全边界

| 数据 | 位置/作用 |
| --- | --- |
| 任务、控制、进度 | `${CYBEROS_ROOT}/state/cyberos.sqlite` |
| worker 与租约 | 判断运行者、过期回收和可否提交 |
| 分段检查点 | 每段范围与已完成位置，支持后续续传 |
| 发布 journal | 关联部分文件身份、目标和任务状态 |
| 下载内容 | `${CYBEROS_ROOT}/data` 下的目标池与目标目录 |

生产模式要求根目录 `/cyberos` 并检查池挂载。存储层使用目录句柄、相对路径和身份检查，拒绝路径穿越、危险符号链接及同名覆盖；HTTP 部分文件还通过文件锁协调。

空间预留与每次写入前的剩余空间检查用于保护容量，但不能防止其他进程同时消耗磁盘。磁盘不足必须进入明确错误路径。

## 开发与验证

从仓库根目录执行：

```bash
cargo check --locked -p cyberos-downloader
cargo test --locked -p cyberos-downloader
```

测试重点包括续传/Range 响应、重定向与地址策略、检查点、磁盘与路径约束、发布恢复以及隔离的 BT 场景。测试中的私网地址注入是测试能力，生产请求配置没有相同开关。

生产只读排查：

```bash
systemctl status cyberos-downloader.service
journalctl -u cyberos-downloader.service -n 100 --no-pager
```

真实公网源、tracker/peer 可达性、目标挂载和长时间断线恢复需在 Linux 运行环境另行验收。

## 继续阅读

- [HTTP 主流程](src/download.rs)、[网络约束](src/network.rs)、[存储发布](src/storage.rs)。
- [photos](../photos/README.md)：另一类数据库与文件发布 journal 的使用。
- [indexer](../indexer/README.md)：下载后的文件如何进入索引体系。
