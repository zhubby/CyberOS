# system-health — NAS 就绪状态聚合与告警协调

`@cyberos/system-health` 聚合存储池、索引器、下载/照片 worker、备份、运维任务、监控和 VOD 服务状态，生成统一 `SystemHealthSummary`。API 可以即时读取摘要，Ops 的定时评估还会协调本模块拥有的健康告警。

它是可复用 Node 库，没有自己的 HTTP 端口或定时循环。服务 liveness、任务完成和业务 readiness 是不同判断。

[返回工作空间总览](../README.md) · [包定义](package.json)

## 架构图

![系统健康证据聚合与定时告警协调架构](docs/architecture.svg)

评估器主动读取业务状态和监控健康视图，并检查存储与播放器；只有定时入口执行所属告警的持久协调。

## 源码与公共接口

实现集中在 [src/index.ts](src/index.ts)，测试在 [src/index.test.ts](src/index.test.ts)。

| 接口 | 行为 |
| --- | --- |
| `evaluateSystemHealth` | 读取/探测各项证据，返回摘要，不做本模块告警对账 |
| `runScheduledHealthEvaluation` | 额外探测备份目标，评估后调用 reconcileHealthAlerts |
| `inspectStoragePools` | 枚举数据根中的 pool 目录并判断就绪 |
| `HEALTH_OWNED_ALERT_CODES` | 限定定时评估负责协调的告警码集合 |

## 评估步骤

1. 枚举存储池，构建就绪列表；数据根不可读时返回配置问题条目。
2. 载入活动告警，保留其他领域负责的告警；按 code 与 pool 去重。
3. 根据索引历史和运行状态判断连续失败、索引陈旧、扫描停滞、队列停滞及 watcher 降级。
4. 检查启用备份的最近计划运行、最近成功备份和仓库检查，判断失败与陈旧。
5. 读取 downloader、indexer、photos 心跳及队列状态，决定不可用问题的严重度。
6. 合并持久 TV 设置，查询 VOD runtime 的运行状态。
7. 读取 health/maintenance 任务概况与 Monitoring 健康视图。
8. 有 critical issue 则 failed；否则有 issue 则 degraded；没有 issue 才 ready。

摘要中的索引 freshness 取已知 pool 值的最大值；备份 freshness 从最近成功的 daily/weekly 完成时间计算。缺失值保留 null，不应在界面中当成零延迟。

## 证据来源和限制

| 来源 | 实际检查 | 不能据此推断 |
| --- | --- | --- |
| 存储池 | 目录、symlink、realpath；生产核对 mountinfo | 每个文件可读写、磁盘全面无故障 |
| 索引 | 业务库的心跳、队列、历史和更新时间 | 所有文件已提取成功 |
| 备份 | 运行/失败记录、成功时间；定时探测目标访问权限 | 当前可完整灾难恢复 |
| 下载/照片 | worker 心跳与任务计数 | 某个用户任务或资产处理已完成 |
| VOD | runtime 报告的状态及恢复情况 | 显示器有画面或扬声器有声音 |
| Monitoring | 独立指标库中的采集状态与新鲜度 | 所有物理传感器都存在且准确 |

备份目标的本模块检查是可访问性检查；backup 真正执行时有更严格的路径与挂载验证。即时评估未传入新的备份目标就绪信息时，可保留已有相关告警，避免一次轻量查询误清掉定时检查结果。

## 告警所有权

本模块的 owned codes 包括存储池、索引、下载/照片 worker、VOD、备份、Ops 和 monitoring 相关问题。定时入口只对这些码执行 reconcile，避免清除其他告警来源仍然有效的问题。

这与 [monitoring-alerts](../db/src/repositories/monitoring-alerts.ts) 的指标规则、事件、联系人和升级策略不同。system-health 主要提供系统运行就绪摘要，不承担整个告警投递引擎。

## 配置与调用方

健康阈值来自 runtime：索引警告/严重陈旧时间、停滞时间、连续失败阈值和备份陈旧时间。VOD 配置还会合并业务库中的 TV 设置；最终结果必须结合调用方传入的有效配置理解。

[Ops](../ops/README.md) 负责定时执行与运行记录；[API](../api/README.md) 负责对外响应；[monitoring](../monitoring/README.md) 负责指标库只读健康视图。本包不自动修复挂载、重启服务或执行备份。

## 开发与验证

```bash
npx vitest run packages/system-health packages/ops
npm run typecheck
```

测试可注入时间、VOD runtime 和备份目标状态，验证严重度和告警协调。生产挂载与设备结果仍须结合 Linux 环境、日志和实际业务检查。
