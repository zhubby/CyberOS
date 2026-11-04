# ops — 带运行记录的健康与维护任务

`@cyberos/ops` 执行 `health` 或 `maintenance` 一次性任务，并统一记录开始、心跳、结果和失败。生产调度由 systemd timer 负责，本包运行完成后退出；它不承担常驻指标采集。

[返回工作空间总览](../README.md) · [包定义](package.json) · [健康服务](../../packaging/systemd/cyberos-health.service) · [维护服务](../../packaging/systemd/cyberos-maintenance.service)

## 架构图

![Ops 一次性任务、生命周期记录与维护架构](docs/architecture.svg)

Tracked runner 为两条执行路径提供共同生命周期。health 委托 system-health；maintenance 在租约内维护数据库并清理特定恢复暂存。

## 源码导航

| 文件 | 职责 |
| --- | --- |
| [src/index.ts](src/index.ts) | 参数校验、runtime/数据库、JSON 输出、退出码和连接关闭 |
| [src/runner.ts](src/runner.ts) | runTrackedTask、五秒心跳、完成/失败记录和错误路径脱敏 |
| [src/maintenance.ts](src/maintenance.ts) | 执行锁、WAL 检查点、optimize、保留清理与 restore 暂存清理 |
| [src/runner.test.ts](src/runner.test.ts) | 任务生命周期和维护边界测试 |

## 任务生命周期

CLI 只接受 `health` 或 `maintenance`，额外参数或未知命令以退出码 2 结束。合法命令打开业务库后调用 runner，执行异常输出失败 JSON 并设退出码 1，最后关闭连接。

`runTrackedTask` 创建 ops run，每五秒刷新心跳，执行领域函数并保存 completed 摘要。若生命周期已经被其他逻辑中断，完成回写失败会抛出错误；异常保存 failed 后继续抛给 CLI。finally 总会清理心跳。

持久失败信息会把数据根、state 和数据库路径替换成 `<path>`，压缩空白并截断。CLI 的异常输出是另一条日志路径，不能假定所有上层输出都经过同一脱敏函数。

## Health 路径

`runHealthTask` 调用 [system-health](../system-health/README.md) 的 `runScheduledHealthEvaluation`：检查存储和各服务状态，计算健康摘要，并协调本模块拥有的告警。Ops 再把摘要保存到 run 中。

任务执行完成与健康状态为 ready 是两个维度：一次成功评估可以得出 failed/degraded 的业务健康结论。排查时同时看 ops run 生命周期和摘要中的 issues。

## Maintenance 路径

1. 获取 `ops:maintenance` 执行锁并续租，拒绝重叠维护。
2. 检查 lease owner，执行 `wal_checkpoint(PASSIVE)` 和 `PRAGMA optimize`。
3. 尝试清理过期恢复暂存，再执行数据库历史保留清理。
4. 返回检查点计数、未恢复 trash 数量、暂存清理状态和 retention 摘要。
5. 清除心跳并释放维护锁。

PASSIVE checkpoint 的 busy、logFrames、checkpointedFrames 都保留在摘要中；它不是强制排空 WAL。回收站这里仅统计未恢复条目，不会把用户回收站当成临时目录直接删除。

## Restore 暂存清理

清理前还要取得 `backup` 锁；备份正在运行时返回 `deferred`。只处理配置 staging 下名字匹配 `restore-*`、真实目录且修改时间超过七天的项目。

删除前复查 realpath 是否仍在 staging 内，并比对 dev/inode，拒绝符号链接和中途替换。真正删除的是已验证的恢复暂存目录，不是业务数据根或在线数据库。

数据库保留规则集中在 [ops-maintenance Repository](../db/src/repositories/ops-maintenance.ts)。新增保留对象时，应同时考虑活动任务、外键引用和业务恢复需要，不能仅按创建时间粗删。

## 运行与验证

在已初始化的独立开发根目录下，从仓库根执行：

```bash
CYBEROS_ENVIRONMENT=development CYBEROS_ROOT="$PWD/.cyberos/dev-root" npm run health
CYBEROS_ENVIRONMENT=development CYBEROS_ROOT="$PWD/.cyberos/dev-root" npm run maintenance
npx vitest run packages/ops packages/db/src/ops-maintenance.test.ts
npm run build -w @cyberos/ops
```

生产分别由 [health timer](../../packaging/systemd/cyberos-health.timer) 和 [maintenance timer](../../packaging/systemd/cyberos-maintenance.timer) 启动。oneshot 成功后 inactive 属正常现象，应读取退出码和最近 run；真实挂载与 Linux 服务状态需要设备环境验证。
