# monitoring-contracts — 监控系统的共享契约

`cyberos-monitoring-contracts` 是 monitor 与 alerter 共同链接的 Rust 库。它把指标名称、类型、标签、采样节奏和指标库身份集中到一处，使采集端和告警端按照相同定义理解数据。

它没有二进制入口、后台任务、socket 或数据库连接。`publish = false` 表示它随当前 workspace 一起维护。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [公共接口](src/lib.rs)

## 架构图

![monitoring-contracts 共享定义与消费者](docs/architecture.svg)

图中的箭头表示定义的来源与使用关系。目录 JSON 在编译时进入库，运行时不会重新读取仓库中的 JSON 文件。

## 为什么单独成为一个 crate

| 共享内容 | 解决的问题 |
| --- | --- |
| `MetricDefinition` | 同一个指标的单位、标签和采样分类保持一致 |
| `MetricKind` | 明确区分瞬时值 `Gauge` 与累计值 `Counter` |
| `MetricCadence` | 把指标归入 `Fast`、`Standard`、`Temperature` 三种节奏 |
| `SamplingIntervals` | 采集调度与告警新鲜度判断使用同一组间隔 |
| `METRICS_SCHEMA_VERSION`、`METRICS_SCHEMA_IDENTITY` | 指标库结构版本与产品身份使用相同常量 |

共享的是契约，采样实现、SQL 查询和告警规则仍由各自 crate 负责。TypeScript 与 Rust 的目录来源是 [metrics-catalog.json](../../packages/monitoring/contracts/metrics-catalog.json)；这里只定义 Rust 侧的反序列化和访问方式。

## 源码结构

当前实现集中在 [src/lib.rs](src/lib.rs)：

| 代码区域 | 职责 |
| --- | --- |
| 常量与枚举 | 指标库身份、指标类型和采样分类 |
| `MetricDefinition` | 解析目录中的 `name`、`description`、`kind`、`unit`、`labelKeys`、`cadence` |
| `SamplingIntervals::validate` | 校验三档间隔的范围与先后关系 |
| `SamplingIntervals::for_cadence` | 把分类映射到实际 `Duration` |
| `catalog()` | 用 `include_str!` 内嵌 JSON，并用 `OnceLock` 缓存解析结果 |
| `metric(name)` | 延迟建立名称到目录下标的索引，返回静态引用 |
| `tests` | 验证目录可解析、默认采样间隔合法及错误边界 |

库依赖仅包括 `serde` 和 `serde_json`，不依赖 Tokio、SQLite 或网络运行时。

## 数据如何进入消费者

1. Cargo 编译时，`include_str!` 读取 `packages/monitoring/contracts/metrics-catalog.json`。
2. 第一次调用 `catalog()` 时，`serde_json` 把文本解析为 `Vec<MetricDefinition>`。
3. `OnceLock` 保存解析结果；后续调用共享同一份只读目录。
4. 第一次调用 `metric(name)` 时建立 `HashMap<String, usize>`，避免每次线性遍历。
5. monitor 使用目录校验写入样本；alerter 使用共享定义和采样间隔解释查询结果。

`catalog()` 假定内嵌文件合法，解析失败会触发 `expect`。这是构建输入错误，不能当作可忽略的运行时缺失指标；修改目录后应先运行测试。

## 采样间隔契约

| 字段 | 默认值 | 校验规则 |
| --- | --- | --- |
| `fast` | 10 秒 | 1 秒至 5 分钟 |
| `standard` | 30 秒 | 不小于 `fast`，且不超过 15 分钟 |
| `temperature` | 5 分钟 | 不小于 `standard`，且不超过 1 小时 |

`validate(self)` 成功时返回原值，失败时返回 `SamplingIntervalsError`。错误的 `field()` 提供固定字段名，便于配置层生成一致的错误信息。

指标目录使用 `camelCase` 字段名，枚举值使用小写字符串。Rust 类型名不是 JSON 字段名，变更时需要同时考虑 TypeScript 消费者。

## 版本与演进

当前指标库常量为版本 `1`、身份 `cyberos-2.0`。它们描述指标数据库，不代表 Cargo 包版本或整个 CyberOS 的发布版本。

新增指标时，应同时检查目录、monitor 的样本生产者、存储校验和 alerter 的查询语义。仅在目录中加入名称不会自动产生采集实现。

采样值允许作为库内对象传入；当前 monitor、alerter 的设置加载器使用 `SamplingIntervals::default()`。不要因为类型支持自定义间隔，就假定当前设置 API 已开放所有采样字段。

## 开发与验证

在仓库根目录执行：

```bash
cargo check --locked -p cyberos-monitoring-contracts
cargo test --locked -p cyberos-monitoring-contracts
```

涉及指标定义变更时，再运行消费者测试：

```bash
cargo test --locked -p cyberos-monitor -p cyberos-alerter
```

这些测试验证契约和软件行为；不证明某台 Linux 主机具备全部采集源。

## 继续阅读

- [monitor 架构](../monitor/README.md)：采集器如何使用目录并写入指标库。
- [alerter 架构](../alerter/README.md)：指标如何进入状态机与邮件投递。
- [monitor 的指标存储适配器](../monitor/src/adapters/metrics_sqlite.rs)：样本校验与数据库版本检查。
- [alerter 的配置适配器](../alerter/src/adapters/config.rs)：共享采样间隔的使用位置。
