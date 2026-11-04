# monitoring — 指标目录、只读查询与健康视图

`@cyberos/monitoring` 为 API 和健康检查提供 `metrics.sqlite` 的只读访问。它解释共享指标目录，检查 schema 身份，规划有界时间序列查询，并输出 overview、series 和采集健康状态。

采样、聚合落库和保留清理由 [Rust monitor](../../crates/monitor/README.md) 负责。此包不采集主机、不写指标，也不直接实现浏览器 SSE；API 的 MonitoringEventBroker 负责事件转发。

[返回工作空间总览](../README.md) · [包定义](package.json)

## 架构图

![Monitoring 只读指标查询与 Rust 写入边界](docs/architecture.svg)

读者和写者共同访问独立指标库。业务 `cyberos.sqlite` 中的任务与告警配置不是这里的时间序列存储。

## 源码导航

| 文件 / 目录 | 职责 |
| --- | --- |
| [src/reader.ts](src/reader.ts) | MonitoringReader、overview/health、连接重开与不可用处理 |
| [src/database.ts](src/database.ts) | 只读连接、series/collector 查询和数据库体积统计 |
| [src/query.ts](src/query.ts) | 参数验证、分辨率选择、gauge/counter 读取与桶聚合 |
| [src/catalog.ts](src/catalog.ts) | 加载并冻结指标定义，验证 kind 与 cadence |
| [src/schema.ts](src/schema.ts) | 指标 schema version/identity 检查 |
| [src/test-utils.ts](src/test-utils.ts) | 测试数据库与指标样本工具，独立子路径导出 |
| [contracts/metrics-catalog.json](contracts/metrics-catalog.json) | TypeScript/Rust 共用指标定义 |
| [contracts/migrations](contracts/migrations) | 指标 schema 契约 |
| [contracts/golden/metrics-parity.json](contracts/golden/metrics-parity.json) | 跨语言一致性样本 |

## Reader 生命周期

reader 延迟打开库，使用 readonly、fileMustExist 和 query_only，busy timeout 为五秒。打开时验证 schema 版本及 `cyberos-2.0` 身份，拒绝不支持的新版本和错误身份。

连接记录 dev/inode；文件被替换或暂时不可读时关闭并重新打开，避免继续读取旧 inode。查询出错会使连接失效并交由调用路径表达不可用，而不是在只读端创建空库或迁移。

禁用时 catalog 仍可返回静态指标定义、series 为空；overview 返回 disabled。尚未产生库时 overview 表达 starting，健康读取在失败时降为 unavailable。调用方不能把空结果解释为负载为零。

## 查询如何规划

1. 校验 ISO 时间、范围、selector、labels、transform 和 maxPoints。
2. 从已有 series 中筛选范围内有数据且匹配 selector 的项。
3. 验证 rate 只适用于 counter，限制返回 series 和总点数。
4. 根据时间跨度、采样周期和目标点数选择 raw/1m/1h，并按实际数据选择可用分辨率。
5. 将共享 kind/resolution/step 的计划合并读取，避免为每条曲线重复扫描。
6. 根据 gauge/counter 语义构建时间桶，输出带 resolution、stepMs 的 series。

当前上限为 12 个 selector、每条最多 720 点、最多 64 条返回 series、总计最多 24,000 点。请求范围和 label 也受校验；业务界面应发送有界查询，不能以客户端裁剪替代后端限制。

counter 的 rate/增量不能当 gauge 平均值计算，重置和缺样由专门逻辑处理。缺失数据保持其缺失语义，不补成虚构的零样本。

## Overview 与健康状态

overview 组合活跃指标、collector 状态、最后成功时间、writes_paused 和保留/容量信息。写入暂停或 collector error 可产生 degraded；最后成功采样超过当前 30 秒陈旧阈值时产生 unavailable。

静态指标定义、活跃 series、collector 状态是三种不同信息。某指标在 catalog 中存在，不表示当前设备一定提供它；温度等慢采样 cadence 也与快速主机指标不同。

## 使用方与边界

API 在启动时创建长期 reader，路由调用 catalog/overview/query，关闭钩子释放连接。system-health 使用 `readMonitoringHealth` 取得短生命周期健康摘要。

浏览器实时更新由 Rust monitor 提交后的通知进入 API，再触发受影响窗口的有界查询。本包没有直接消费这些事件，不应在这里加入第二个采样循环或独立写库路径。

## 开发与验证

```bash
npx vitest run packages/monitoring packages/api/src/routes/monitoring.test.ts
npm run build -w @cyberos/monitoring
```

Schema/parity 测试核对跨语言契约；查询测试覆盖窗口、重置、聚合与限额。真实 Linux collector 的设备覆盖与采样新鲜度要在 Rust monitor 和运行设备验证。
