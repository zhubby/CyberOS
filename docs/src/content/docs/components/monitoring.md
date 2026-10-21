---
title: 内置监控
description: Rust 指标采集、独立时序存储、查询、告警与 Web 处置界面。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [crates/monitor/src, crates/alerter/src, crates/monitoring-contracts/src/lib.rs, packages/monitoring/contracts/metrics-catalog.json, packages/monitoring/src/query.ts, packages/api/src/routes/monitoring.ts, packages/api/src/routes/monitoring-alerts.ts, packages/web/src/components/workspace/MonitoringPanel.tsx, packaging/systemd/zos-monitor.service, packaging/systemd/zos-alerter.service]
sidebar:
  order: 6
---

`crates/monitor` 与 `crates/alerter` 是两个互不依赖的 Rust 应用 crate，分别生成 `zos-monitor` 和 `zos-alerter`。两者都按无 I/O 的 `domain`、用例编排 `application`、边界 trait `ports`、真实 I/O `adapters` 和进程装配 `runtime` 分层；SQLite 同步操作只在 blocking worker 中执行。`crates/monitoring-contracts` 只共享固定指标 catalog、schema version 和采样周期值对象，不承载运行时、存储或告警模型。

`zos-monitor.service` 是唯一指标写入者。它从 `/proc`、`/sys`、文件系统、固定 systemd unit allowlist 和只读的 ZOS 主库采集主机及应用状态；单个 collector 失败只留下数据断点并更新 collector 状态，不会停止其他采集器或核心服务。服务使用单调时钟调度且 collector 不重叠执行，同一轮样本共享时间戳。`packages/monitoring` 的生产能力只包含共享 catalog、schema version 检查和只读查询。

指标保存在 `/zos/state/metrics.sqlite`，不写入主库 `/zos/state/zos.sqlite`。指标库使用 WAL、短批量事务、`synchronous=NORMAL`、独立 migration、增量 vacuum 和定期 checkpoint。旧指标库首次打开时会一次性转换为 incremental auto-vacuum，同时保留已有样本；若临时空间不足，服务继续使用旧库并在无法物理回收时暂停超限写入，不会陷入重启循环。schema 升级只执行轻量结构变更，不在启动路径全表回填；旧 rollup 无法可靠重建的 rate 会显示为空点，后续新采样生成完整聚合。高于当前程序支持版本的 schema 会被拒绝，旧程序不会继续写入新格式数据库。raw、1 分钟和 1 小时层默认分别保留 48 小时、30 天和 1 年；容量默认上限 512 MiB。达到上限时依次裁剪 raw、1m、1h 到目标水位，仍不能降到限制内则暂停采样写入并报告 `degraded`。

指标目录来自语言无关的 `packages/monitoring/contracts/metrics-catalog.json`，使用固定、低基数的 OpenMetrics 风格名字。它覆盖 CPU/load、内存/Swap、磁盘与网络累计字节、NAS/state 容量、温度、固定 ZOS 服务、worker heartbeat、队列、索引新鲜度、最近成功任务、Health 问题、monitor 自监控，以及用于阈值规则的内存/文件系统使用率。路径、任务 ID、会话 ID 不允许成为标签；临时容器/虚拟机网卡不进入主机网络序列。每个指标最多保留 64 条序列，全库最多 512 条。counter 在查询和告警层先转换为 reset-aware rate；缺失 bucket 返回 `null`，Web 以断线显示而不插值。

API 只用惰性只读连接访问指标库。`overview` 状态为 `disabled`、`starting`、`ready`、`degraded` 或 `unavailable`；禁用和暂时无数据时返回成功空结果，库不可读时返回脱敏的 `503`。单次查询最多 12 个 selector、64 条展开序列、24,000 个总点，每条序列最多 720 点、范围最多 366 天。查询先按跨度选择候选层，再比较 raw、1m、1h 的实际覆盖，避免 raw 已过期时返回空历史。

只有实际的 `SQLITE_CORRUPT`/`SQLITE_NOTADB` 会触发隔离重建，且最多保留最近一组 `.corrupt-*` 文件。权限、磁盘满和未来 schema 版本只报告错误，不能移动数据库。reader 按 inode 变化重新打开，确保隔离或替换后不继续读取旧文件句柄。

`zos-alerter.service` 每 10 秒只读指标库，对固定窗口、比较符、聚合和 `value | rate` 规则求值。每条完整 label series 独立维护 `normal -> pending -> firing -> recovering -> resolved` 状态；只有 firing 创建 incident。规则、incident、静默、值班、升级策略和邮件 outbox 位于主库。acknowledge 会取消后续邮件但不会伪造恢复；静默期间状态继续演进；resolved 邮件只发给已成功收到该 incident 的收件人。

邮件先事务性写入 outbox 再由 alerter 发送，使用稳定 Message-ID 和幂等键。SMTP 安全模式为 `none | starttls | tls`，不自动降级；明文只允许解析结果全部属于 loopback、RFC1918、ULA 或链路本地的目标。密码只写入受限 `system_settings`，API 仅返回 `credentialConfigured`。SMTP 的协议限制意味着崩溃窗口可能重复投递，但已入队消息不会静默丢失。

当前仍不提供 PromQL、node_exporter 抓取、OpenMetrics 导出、Docker/VM 明细和多设备汇总。
