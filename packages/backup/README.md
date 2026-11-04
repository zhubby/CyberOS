# backup — Restic 备份、仓库检查与恢复暂存

`@cyberos/backup` 提供一次性 CLI 和可复用备份函数。它从数据库读取备份设置，以执行锁协调任务，生成 SQLite/回收站状态快照和 manifest，调用 Restic 备份数据与状态，并记录结果。灾难恢复先落到独立暂存目录，再验证内容。

[返回工作空间总览](../README.md) · [包定义](package.json) · [每日服务](../../packaging/systemd/cyberos-backup-daily.service) · [每周服务](../../packaging/systemd/cyberos-backup-weekly.service)

## 架构图

![备份编排、数据状态快照与 Restic 仓库架构](docs/architecture.svg)

业务数据库既是运行记录的存储，也是需要备份的状态。数据与状态分别生成 Restic snapshot，成功条件还包括返回 snapshot ID、仓库中可见及相应检查通过。

## 源码导航

| 文件 | 职责 |
| --- | --- |
| [src/index.ts](src/index.ts) | validate/init/run/check/restore 命令解析及退出码 |
| [src/backup.ts](src/backup.ts) | 设置合并、路径/挂载验证、锁、快照、manifest、保留和恢复校验 |
| [src/restic.ts](src/restic.ts) | 可替换的 Restic runner，子进程超时、输出上限和错误摘要 |
| [src/restore.ts](src/restore.ts) | 恢复函数再导出 |
| [src/backup.test.ts](src/backup.test.ts) | 备份与恢复行为、失败和边界测试 |

## 备份执行流程

1. 从业务库读取设置并合并 runtime；未启用时定时 `run` 跳过，其余操作按各自条件处理。
2. 校验仓库、数据根、state 与 staging 的路径不重叠，检查凭据与访问权限。
3. 取得 `backup` 执行锁，创建运行记录并每五秒续租。
4. 按配置核验仓库和存储池挂载。生产要求通过 Linux mountinfo 确认，不能把同名普通目录当成挂载成功。
5. 在 backup-staging 下创建本次暂存，使用数据库快照 API 保存 SQLite，复制回收站状态并生成 manifest。
6. Restic 备份整个数据根，排除托管 iSCSI 镜像目录；再备份本次状态暂存。
7. 收集两次结果中的 snapshot ID，再查询仓库确认这些 snapshot 可见。
8. 每周任务额外执行 `check` 和按 daily/weekly 保留策略的 `forget --prune`。
9. 写 completed 或 failed，清除本次临时目录并释放锁。关键阶段再次检查租约归属。

这不是存储池级瞬时快照：SQLite 有独立一致性快照，用户数据仍由 Restic 在运行期间读取。不要把整个数据树描述成与数据库完全同一时刻冻结。

## 恢复语义

`restore` 使用显式 repository、password-file 和 snapshot，不先打开在线业务库。它先运行仓库 check，再 dry-run 和实际恢复到 `backup-staging/restore-*`，查找并验证 manifest，成功返回 `{ stagingPath, verified: true }`。

成功的暂存目录保留供后续人工/运维流程使用；失败会清理该目录。此命令不直接替换在线 SQLite、覆盖数据根或重启服务。数据快照和状态快照是分开的，恢复时必须理解所选 snapshot 的内容；manifest 验证成功不证明整个 NAS 已完成灾难恢复。

## 配置与持久化

| 项目 | 来源 / 默认路径 |
| --- | --- |
| 启用、仓库、保留、requireMount | 数据库备份设置 |
| Restic 密码文件 | `state/secrets/backup/restic-password` |
| staging | `state/backup-staging` |
| 运行与失败记录 | 业务库 backup runs/failures Repository |
| 数据源 | `data/`，排除托管 iSCSI 镜像 |
| 默认保留 | daily 7、weekly 4，持久设置可覆盖 |

Restic 通过参数数组执行，默认命令超时五分钟，输出有上限。密码使用文件/进程环境传递，不放进公开命令参数或日志。失败摘要会压缩输出，但处理秘密时仍应检查调用层日志。

## CLI 与定时运行

以下命令从仓库根目录执行；真实运行需独立开发根、可访问仓库、密码文件和相应设置：

```bash
npm run dev -w @cyberos/backup -- validate
npm run dev -w @cyberos/backup -- run --kind daily
npm run dev -w @cyberos/backup -- check
```

`init` 创建仓库；`restore` 要求 `--repository`、`--password-file`、`--snapshot`。根 `npm run backup` 只启动 CLI，不会隐式选定备份动作。

生产由 daily/weekly timer 启动 oneshot service。服务完成后 inactive 是正常状态，应检查退出码、run 记录和日志。清理过期 restore 暂存由 [ops](../ops/README.md) 完成，并与 backup 锁协调。

## 开发与验证

```bash
npx vitest run packages/backup
npm run build -w @cyberos/backup
```

可注入 runner 测试命令顺序和失败语义；真实 Restic 仓库、Linux 挂载与隔离恢复另行验证。不可仅凭一次 run completed 认定业务数据库与所有用户文件都已经成功恢复。
