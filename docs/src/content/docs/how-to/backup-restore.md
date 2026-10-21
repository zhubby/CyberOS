---
title: 备份与恢复
description: 使用 restic 完成校验、初始化、日常备份、检查和 staging 恢复。
type: how-to
status: current
audience: [operator]
sourceOfTruth: [packages/backup/src/index.ts, packages/backup/src/backup.ts, packaging/systemd/zos-backup-daily.timer]
sidebar:
  order: 2
---

备份是显式 opt-in 能力。先配置 repository 和受保护的 password file，再执行 validate 和一次性的 init。daily/weekly timer 永远不会隐式初始化仓库。

备份包括 NAS roots、SQLite 在线快照、trash 状态和 manifest。恢复首先写入新的 0700 staging 目录，校验 root 映射与 SHA-256；v1 不会覆盖活动 NAS root、数据库目录或备份仓库。

## Docker 工作负载的数据

默认 Docker named volume 位于 `/var/lib/docker/volumes`，不属于 ZOS NAS roots，也不会因备份 SQLite 而被备份。设备状态备份保存的 Registry 凭证不等于容器数据备份，恢复目录或数据库也不会自动重建容器。生产 RustFS 等对象存储必须另外制定应用一致的数据备份策略，或使用经过规划的 NAS bind mount；不要在线复制活跃 volume 并声称已得到一致备份。

托管 Compose App 的 YAML、环境变量、元数据和 revision 位于 SQLite，因此会随设备状态备份恢复；环境变量是受限明文。`/zos/apps` 只是可重建运行副本，不需要单独纳入备份，API 启动后会从数据库重新发布。恢复 App 定义不会恢复 named volume 数据，也不会自动启动项目；恢复后先核对 NAS readiness、镜像 digest、挂载和秘密，再通过页面重新发起 Compose Up approval。

首次验收使用隔离的测试容器、独立 volume 和专用凭证，不修改现有 `rustfs-data`。写入小对象并记录 SHA-256，通过页面重启测试容器后重新下载校验；经确认删除并重建测试容器时复用测试 volume，再次校验，证明数据不依赖容器可写层。

备份恢复演练在维护窗口暂停测试工作负载写入，使用应用支持的备份或在停止测试容器后备份其 volume 数据，保留文件 UID/GID、权限和需要的元数据。保存镜像 digest、命令、挂载、网络与重建清单，凭证只保存在受限的独立材料中；备份仓库必须与源数据隔离。执行备份检查，再恢复到新的 staging 目录/新测试 volume，不覆盖原 volume；使用相同 digest 创建恢复容器并限制到测试端口，登录后下载原对象核对 SHA-256。仅 snapshot 创建成功不足以证明可恢复。

完成恢复读取和一致性验证前保留原数据与备份；清理测试容器、volume、对象和凭证须核实精确目标并经确认。现有失败的 backup service 必须记录原因并独立验收；不要 reset-failed 后把它当作健康，也不要让失败状态误归因于本次部署。生产验收要求至少一次真实备份检查和隔离恢复通过。

SQLite/state 和配置归档可能包含未加密 Registry 密码、代理凭据和其他密钥。归档应限制访问并使用加密备份仓库；日志、截图和故障报告不得包含数据库、认证配置或凭证正文。
