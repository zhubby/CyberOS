---
title: 照片索引性能验收
description: 大图库 SQL 规模回归、恢复验证与 Linux 设备对比方法。
type: how-to
status: current
audience: [developer, operator]
sourceOfTruth: [crates/photos/src/db/scan_tests.rs, crates/photos/tests/indexing.rs, crates/photos/src/worker.rs]
sidebar:
  order: 12
---

## 可重复的规模回归

在仓库根目录执行：

```bash
cargo test --locked -p cyberos-photos scheduling_sql_work -- --nocapture
cargo test --locked -p cyberos-photos --test indexing
```

2026-10-29 在 macOS 开发机上，以真实 SQLite schema、生产任务领取及 XMP 点查 SQL 测得：

| 合成媒体数 | XMP 数 | 调度及完成标记 SQL VM steps |
| --- | --- | --- |
| 10,000 | 10,000 | 1,640,000 |
| 100,000 | 100,000 | 16,400,000 |

数据扩大 10 倍，总 SQL 步骤扩大 10 倍，验收上限为 15 倍。测试在每次领取和 XMP 查询后检查步骤数，因此同时覆盖开始、中段和接近结束的任务。另有 99,999 条已完成记录后的领取回归。该指标不包含图像解码、真实磁盘 I/O、迁移耗时或端到端吞吐，不能换算成每秒处理照片数。

子进程测试运行真实 worker，覆盖父目录先发布而子目录遍历失败、扫描期间新增文件的后续刷新、进程重启后的目录恢复、XMP 更新不调用渲染工具、缺失缓存补建、目录消失后的祖先回退，以及图库为存储池根目录时的 ID 稳定性。媒体命令使用受控假工具；真实格式与工具版本仍需设备验证。

## Linux 实机对比

使用同一台设备、同一份图片/RAW/视频/XMP 混合媒体副本和相同并发、资源限制，对比旧版与新版。为两个版本分别创建隔离状态目录，每次从空库开始，避免互相复用缓存。不要在生产状态目录上做此实验。

记录 worker 启动到首张 `ready` 资源的时间、完整扫描耗时、SQLite/WAL 写入量、进程内存峰值及扫描期间查询 API 的延迟分布。首屏可浏览时间需要同时计入前端最多 5 秒的刷新间隔。再分别修改 XMP、移走一组目录、删除一张缓存并重扫，记录渲染命令次数和资源 ID。当前开发环境未进行真实 Linux 设备对比，不预设吞吐提升比例。

## 运行后检查

升级前备份匹配版本的 `/cyberos/state`，由 API 应用迁移后启动 Photos 服务。首次大扫描期间及结束后检查：

```bash
sudo systemctl status cyberos-photos.service
sudo journalctl -u cyberos-photos.service --since '30 minutes ago' --no-pager
curl -fsS http://127.0.0.1:3010/api/photos/status
```

正常信号是持续增长的进度、逐步出现的照片、`Photos scan completed` 日志，以及结束后逐批下降的已完成任务明细数。任务摘要保留规则见 [SQLite 与迁移参考](/docs/reference/database/)。重启恢复不应重复增加已完成项计数；离线挂载、遍历失败或租约丢失不应触发失效资源清理。若出现错误清理、进度重复或持续数据库错误，停止 Photos 服务并保存日志与状态快照；回退应用时恢复匹配版本的数据库备份。
