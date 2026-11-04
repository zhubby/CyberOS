# monitor — Linux 主机与 CyberOS 运行指标采集

`cyberos-monitor` 持续采集主机、文件系统、温度、systemd 服务和 CyberOS 任务状态，把时间序列写入独立的 `metrics.sqlite`，并向 API 发布实时事件。它使用非 root 的 `cyberos` 身份运行，业务数据库 `cyberos.sqlite` 是设置与运行状态的读取来源。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-monitor.service)

## 架构图

![monitor 采集与持久化架构](docs/architecture.svg)

采集任务并发调度，SQLite 操作通过写入器队列串行执行。实时通知由写入器在保存采集结果后发出，API 再负责对外分发。

## 系统位置与数据所有权

| 边界 | 内容 |
| --- | --- |
| 输入 | `/proc`、`/sys`、文件系统容量、固定 systemd 单元、业务库状态 |
| 持久化输出 | `/cyberos/state/metrics.sqlite`，包括原始样本、聚合与采集器状态 |
| 实时输出 | 连接 API 的 `/run/cyberos/monitoring-events.sock` |
| 业务库使用 | 读取 `system_settings`、任务队列、worker 心跳及备份/运维结果 |
| 运行方式 | `cyberos-monitor.service`，`Type=notify`，非 root |

monitor 自己初始化和维护指标库；它不负责建立整个 CyberOS 的业务数据库，也不执行告警邮件投递。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/bin/cyberos-monitor.rs](src/bin/cyberos-monitor.rs) | 日志、加载配置、安装退出信号、启动服务 |
| [src/runtime/monitor.rs](src/runtime/monitor.rs) | 服务组装、配置刷新与采集任务代次切换 |
| [src/runtime/config.rs](src/runtime/config.rs) | 环境路径与 `monitoring_settings` 读取、校验 |
| [src/domain/config.rs](src/domain/config.rs) | 采样、保留期及容量限制模型 |
| [src/domain/metric.rs](src/domain/metric.rs) | 样本、采集结果与采集器状态 |
| [src/ports.rs](src/ports.rs) | `Collector`、`Clock`、`MetricsStorePort` 抽象 |
| [src/application/monitor.rs](src/application/monitor.rs) | 独立采集循环与维护循环 |
| [src/adapters/collectors.rs](src/adapters/collectors.rs) | Linux 与业务库的具体采集器 |
| [src/adapters/metrics_sqlite.rs](src/adapters/metrics_sqlite.rs) | 有界写队列、样本事务、聚合、容量维护与损坏隔离 |
| [src/adapters/monitoring_events.rs](src/adapters/monitoring_events.rs) | 事件编码、有界队列与 Unix 连接 |
| [src/adapters/catalog.rs](src/adapters/catalog.rs) | 使用共享指标目录 |

整体采用领域模型、应用循环、端口和外部适配器分层。采集器可独立替换，测试不必依赖真实系统命令或生产数据库。

## 一次采集的完整路径

1. `MonitorService` 加载根目录与业务库中的监控设置，启动事件发布器并发送 systemd readiness。
2. 每个 collector 使用自己的采样间隔运行；维护任务独立运行。
3. collector 读取观测源并返回 `Collection`，其中包括样本和状态。采集失败也要记录尝试时间、耗时与错误。
4. `MetricsStoreHandle` 把操作放入容量为 64 的 channel，由阻塞任务持有 SQLite 连接并依次处理。
5. 写入前校验指标目录、标签和值；原始样本写入 `metric_samples_raw`，并更新受影响的分钟、小时聚合。
6. 更新 `collector_status` 和 monitor 自身指标；成功返回的采集提交结果用于发布实时事件。
7. API 的 [MonitoringEventBroker](../../packages/api/src/lib/monitoring-events.ts) 接收事件，再提供给前端消费者。

CPU 利用率等差分指标需要上次读数作为基线。第一次读到计数器不等于已经得到有效的利用率。

## 调度、配置刷新与关闭

监控设置每秒检查一次。有效设置发生变化后，服务取消当前代次的采集任务，等待退出并停止旧写入器，再建立新代次。监控关闭时保留服务循环，等待设置重新开启。

配置读取失败时保留最近一次有效设置并记录日志。退出信号通过 `CancellationToken` 传递到采集和维护循环，最终通知 systemd stopping。

| 配置项 | 默认或来源 |
| --- | --- |
| `CYBEROS_ENVIRONMENT` | `production` 时执行生产根目录约束 |
| `CYBEROS_ROOT` | 生产 `/cyberos`；开发为当前目录下 `.cyberos/dev-root`，须为绝对路径 |
| `CYBEROS_MONITORING_EVENTS_SOCKET` | 可覆盖事件 socket；开发默认位于 state 目录 |
| 采样间隔 | fast 10 秒、standard 30 秒、temperature 5 分钟 |
| 原始数据保留 | 默认 48 小时 |
| 分钟聚合保留 | 默认 30 天 |
| 小时聚合保留 | 默认 365 天 |
| 指标库容量 | 默认 512 MiB；设置校验范围 16 MiB 至 16 GiB |

保留期和容量来自 `system_settings.monitoring_settings`；采样档位当前使用共享契约默认值。

## 持久化与故障处理

- 指标库使用 WAL，并检查 schema 版本及产品身份。未来版本不会被静默降级。
- 已识别的 SQLite 损坏进入隔离与重建路径；这只适用于指标库，不能推广到业务数据恢复。
- 每个指标最多 64 个序列，整体最多 512 个序列，避免标签变化无限扩大数据库。
- 容量维护负责保留期清理与空间回收；容量保护可能暂停样本写入，此时采集器状态会说明失败。
- 事件队列是有界实时通知通道。事件推送失败不等于持久化数据丢失，历史查询仍应以指标库为依据。
- systemd 查询有超时；温度源不存在可体现为不支持，而不是伪造零温度。

## 安全与运行边界

服务单元仅开放 Unix 地址族，限制可写目录为 state 与 run，清空 capability 集。读取业务库时不应引入任意 SQL 写入或 hostd 特权执行。

服务 active、readiness 或某次采样成功，只能证明对应层级可用。存储池是否真实挂载、备份是否成功以及告警能否送达，需要分别检查实际数据和其他服务。

## 开发与验证

从仓库根目录运行：

```bash
cargo check --locked -p cyberos-monitor
cargo test --locked -p cyberos-monitor
```

本地运行前应先按[总览中的开发前提](../README.md#开发与验证)初始化隔离的开发状态。Linux 采集器、systemd 和真实设备指标需在 Linux 环境验证。

生产只读排查：

```bash
systemctl status cyberos-monitor.service
journalctl -u cyberos-monitor.service -n 100 --no-pager
```

测试覆盖采集数据解析、调度、指标写入与聚合、配置校验和事件行为；阅读测试时应区分伪造观测源与真实主机验收。

## 继续阅读

- [monitoring-contracts](../monitoring-contracts/README.md)：指标目录与采样定义。
- [alerter](../alerter/README.md)：从指标到告警和邮件。
- [指标库迁移](../../packages/monitoring/contracts/migrations/001_cyberos_2_0.sql)：物理存储结构。
