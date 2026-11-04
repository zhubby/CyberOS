# alerter — 告警规则求值与可靠通知

`cyberos-alerter` 把监控样本和健康告警转换为持久化事件，再通过独立的投递循环发送邮件。规则求值、告警状态、通知调度和实际 SMTP 发送分开处理，避免慢邮件服务器阻塞规则计算，也保留重启后的待发送任务。

[返回 Rust 模块总览](../README.md) · [Cargo 定义](Cargo.toml) · [服务单元](../../packaging/systemd/cyberos-alerter.service)

## 架构图

![alerter 规则与通知架构](docs/architecture.svg)

指标查询读取独立的 `metrics.sqlite`。告警规则、实例、事件和投递 outbox 都在业务库 `cyberos.sqlite` 中，SMTP 位于数据库事务之外。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| [src/main.rs](src/main.rs) | 进程入口、日志、配置和信号 |
| [src/runtime/service.rs](src/runtime/service.rs) | 首次求值等待、10 秒评估循环、1 秒投递循环与事件发布 |
| [src/domain/rule.rs](src/domain/rule.rs) | 规则参数校验、比较器、状态机和无数据策略 |
| [src/domain/delivery.rs](src/domain/delivery.rs) | SMTP 设置和已领取投递模型 |
| [src/ports.rs](src/ports.rs) | 指标读取、规则存储、升级调度、邮件传输等接口 |
| [src/application/evaluation.rs](src/application/evaluation.rs) | 按顺序组合规则求值、健康事件同步、升级通知和清理 |
| [src/adapters/metrics_sqlite.rs](src/adapters/metrics_sqlite.rs) | 指标窗口查询与变换 |
| [src/adapters/alert_store/](src/adapters/alert_store/) | 规则、实例、事件、outbox、投递尝试与保留期 SQL |
| [src/adapters/smtp.rs](src/adapters/smtp.rs) | Lettre 邮件传输、DNS/TLS 策略和超时 |
| [src/adapters/config.rs](src/adapters/config.rs) | 路径和监控设置读取 |
| [src/adapters/alerter_events.rs](src/adapters/alerter_events.rs) | 向 API 发布告警摘要 |

规则状态机不直接依赖 SQLite 或邮件库，外部副作用通过端口交给适配器实现。

## 一轮规则求值

1. 启动后等待业务告警 schema 可用，完成第一次评估才报告 ready。
2. 每 10 秒读取最新监控开关和默认采样契约，取得启用的规则。
3. 规则先验证指标、窗口、阈值和持续时间，再查询指标窗口并应用变换、聚合与比较。
4. 每条规则最多展开 64 个标签序列。超限或无效规则被记录错误，其余规则继续求值。
5. 每个序列更新自己的 `AlertInstance`；触发和恢复产生事件及通知任务。
6. 同步已有健康告警，处理到期升级通知和保留期维护，最后保存本轮状态。
7. 将告警摘要发送给 API 事件代理，供界面刷新计数与状态。

监控开关关闭时会跳过指标规则求值；健康事件同步等步骤仍在评估周期中执行。

## 告警状态机

| 当前状态 | 条件 | 后续状态 |
| --- | --- | --- |
| `Normal` / `Resolved` | 达到触发条件 | `Pending`；触发持续时间为零时直接 `Firing` |
| `Pending` | 持续达到触发时长 | `Firing` |
| `Pending` | 触发条件消失 | `Normal` |
| `Firing` | 达到恢复阈值 | `Recovering`；恢复时间为零时直接 `Resolved` |
| `Recovering` | 连续满足恢复时长 | `Resolved` |
| `Recovering` | 再次触发或不再满足恢复条件 | `Firing` |

触发阈值与恢复阈值形成回差，持续时间减少瞬时抖动。无数据采用 `Ignore` 时保持实例状态；采用触发策略时按触发持续时间推进，不能把缺失样本当作数值零。

## 邮件 outbox 与并发边界

投递循环每秒尝试处理一条任务：在阻塞任务内打开业务库、读取 SMTP 设置并领取投递，释放数据库操作后通过异步 transport 发送，再重新打开存储记录结果。

状态存储负责待发送、发送中、重试、成功、失败和取消之间的转换；规则恢复、用户确认或静默等条件还会影响后续投递。`idempotency_key` 和稳定的邮件 `Message-ID` 用来关联同一通知，但不能把 SMTP 的外部接收效果解释为严格的 exactly-once。

恢复通知会取消仍排队的旧告警邮件，并只发给已有成功投递记录的接收人。对于在恢复时仍在途、稍后才发送成功的邮件，存储层还有补充恢复通知的去重处理。

outbox 的待处理数量有上限，投递尝试与历史记录也有清理逻辑，避免失败通知无限增长。

## 配置与运行

| 项目 | 来源或默认 |
| --- | --- |
| 业务库 | `${CYBEROS_ROOT}/state/cyberos.sqlite` |
| 指标库 | `${CYBEROS_ROOT}/state/metrics.sqlite` |
| 根目录 | 生产固定 `/cyberos`；开发默认 `.cyberos/dev-root` 的绝对路径 |
| 监控开关 | `system_settings.monitoring_settings` |
| SMTP 配置 | 业务库设置；发送前重新读取 |
| 事件 socket | `CYBEROS_MONITORING_EVENTS_SOCKET`；生产默认 `/run/cyberos/monitoring-events.sock` |
| DNS 超时 | 10 秒 |
| 邮件投递超时 | 30 秒 |

服务使用 `cyberos` 账号与 `Type=notify`，具备邮件所需的网络地址族。它检查业务表结构并等待迁移，不自行接管主数据库迁移。

SMTP 支持的传输安全模式由配置和适配器决定。明文模式仅允许受限的私有地址范围；TLS/STARTTLS 失败不会自动降级为明文。

## 故障行为与排查

- 首次缺少告警 schema 时等待重试；其他不可恢复的初始化错误导致启动失败。
- 运行期间单条规则或单次投递失败会记录状态和日志，不能用进程 active 代替规则、数据或邮件验收。
- 数据过旧、窗口不足和无数据策略共同影响求值，应先检查 monitor 与指标库。
- 配置热加载失败保留最近有效配置；SMTP 是否启用在领取投递时判断。
- 停机通过取消令牌退出两个循环；持久化 outbox 保留后续恢复所需状态。

只读检查：

```bash
systemctl status cyberos-alerter.service
journalctl -u cyberos-alerter.service -n 100 --no-pager
```

## 开发与验证

从仓库根目录执行：

```bash
cargo check --locked -p cyberos-alerter
cargo test --locked -p cyberos-alerter
```

测试重点包括规则回差与持续时间、无数据策略、SQL 争用、投递领取与恢复、SMTP 安全和超时。测试邮件服务器通过，不代表用户邮箱已经收到真实告警。

## 继续阅读

- [monitor](../monitor/README.md) 与 [monitoring-contracts](../monitoring-contracts/README.md)。
- [状态机实现](src/domain/rule.rs) 与 [评估顺序](src/application/evaluation.rs)。
- [投递 outbox](src/adapters/alert_store/outbox.rs) 与 [SMTP 适配器](src/adapters/smtp.rs)。
