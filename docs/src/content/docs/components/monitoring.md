---
title: 内置监控
description: 指标采集、独立时序存储、查询和 Web 监控面板。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [apps/monitor/src/service.ts, packages/monitoring/src/catalog.ts, packages/monitoring/src/store.ts, packages/monitoring/src/query.ts, apps/api/src/routes/monitoring.ts, apps/web/src/components/workspace/MonitoringPanel.tsx, packaging/systemd/zos-monitor.service]
sidebar:
  order: 6
---

`zos-monitor.service` 是唯一指标写入者。它从 `/proc`、`/sys`、文件系统、固定 systemd unit allowlist 和只读的 ZOS 主库采集主机及应用状态；单个 collector 失败只留下数据断点并更新 collector 状态，不会停止其他采集器或核心服务。服务使用单调时钟调度且不重叠执行，同一轮样本共享时间戳。

指标保存在 `/zos/state/metrics.sqlite`，不写入主库 `/zos/state/zos.sqlite`。指标库使用 WAL、短批量事务、`synchronous=NORMAL`、独立 migration、增量 vacuum 和定期 checkpoint。旧指标库首次打开时会一次性转换为 incremental auto-vacuum，同时保留已有样本；若临时空间不足，服务继续使用旧库并在无法物理回收时暂停超限写入，不会陷入重启循环。schema 升级只执行轻量结构变更，不在启动路径全表回填；旧 rollup 无法可靠重建的 rate 会显示为空点，后续新采样生成完整聚合。高于当前程序支持版本的 schema 会被拒绝，旧程序不会继续写入新格式数据库。raw、1 分钟和 1 小时层默认分别保留 48 小时、30 天和 1 年；容量默认上限 512 MiB。达到上限时依次裁剪 raw、1m、1h 到目标水位，仍不能降到限制内则暂停采样写入并报告 `degraded`。

指标目录是固定、低基数的 OpenMetrics 风格名字。首期覆盖 CPU/load、内存/Swap、磁盘与网络累计字节、NAS/state 容量、温度、固定 ZOS 服务、worker heartbeat、队列、索引新鲜度、最近成功任务、Health 问题和 monitor 自身状态。路径、任务 ID、会话 ID 不允许成为标签；临时容器/虚拟机网卡不进入主机网络序列。每个指标最多保留 64 条序列，全库最多 512 条；各层数据全部过期后会清理对应序列目录。counter 在查询层转换为速率并处理重置；缺失 bucket 返回 `null`，Web 以断线显示而不插值。

API 只用惰性只读连接访问指标库。`overview` 状态为 `disabled`、`starting`、`ready`、`degraded` 或 `unavailable`；禁用和暂时无数据时返回成功空结果，库不可读时返回脱敏的 `503`。单次查询最多 12 个 selector、64 条展开序列、24,000 个总点，每条序列最多 720 点、范围最多 366 天。查询先按跨度选择候选层，再比较 raw、1m、1h 的实际覆盖，避免 raw 已过期时返回空历史。

损坏库会先改名隔离再重建，最多保留最近一组 `.corrupt-*` 文件，避免可重建的诊断副本持续占用 `/zos/state`。

第一阶段不提供通用告警、通知、PromQL、node_exporter 抓取、OpenMetrics 导出、Docker/VM 明细和多设备汇总。后续告警评估器应复用同一 catalog 与受控查询接口；node_exporter adapter 只能显式映射低基数指标。
