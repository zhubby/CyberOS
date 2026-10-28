---
title: systemd 服务与 Timer
description: 服务身份、周期和关键 hardening 配置。
type: reference
status: current
audience: [operator]
sourceOfTruth: [packaging/systemd/cyberos-api.service, packaging/systemd/cyberos-monitor.service, packaging/systemd/cyberos-alerter.service, packaging/systemd/cyberos-worker@.service, packaging/systemd/cyberos-indexer.service, packaging/systemd/cyberos-health.service, packaging/systemd/cyberos-health.timer, packaging/systemd/cyberos-maintenance.service, packaging/systemd/cyberos-maintenance.timer]
sidebar:
  order: 3
---

核心服务默认以 `cyberos` 身份运行并使用 `ProtectSystem=strict`、`NoNewPrivileges=yes` 和资源上限。`cyberos-hostd` 是唯一的 root daemon；为原子创建可配置的 Unix 共享账号，它显式放行 `/etc`、ACL 备份目录和 Samba 私有密码库。Rust `cyberos-terminald` 固定以 `cyberos` 身份启动，使用独立家目录 `/cyberos/home/terminal`；`KillMode=process` 使 daemon 重启时 tmux session 保持运行。它对配置、数据库与日志路径的屏蔽仅防误操作，同 UID 终端不是后台服务的安全隔离边界。Rust downloader 与内部 `photos` 服务只写 `/cyberos/state`、日志和配置的 storage pools；两者都在 API 迁移后启动，并在 30 秒 systemd 停止时限内持久化进度、终止子进程和归还租约。Photos 的内部 `photos` 服务使用 ExifTool、libvips、`heif-convert`、`dcraw_emu`、`ffmpeg` 和 `ffprobe`，其 unit 不依赖硬编码 `/cyberos/data/pool-1` mount，因此存储离线时 daemon 仍能报告健康与恢复状态。

hostd 在 `local-fs.target` 和 `NetworkManager.service` 之后启动，并显式依赖 tmpfiles setup 完成，再排在 `network-online.target` 之前，以便先创建 root-only 状态目录并恢复未完成的 Ethernet checkpoint 事务。Debian 包由 `postinst` 在启动服务前安全创建状态子树。hostd 继续使用既有 `/etc` 和 `/cyberos/state/hostd/network-manager` 写边界；API 不获得 root、capability 或 NetworkManager keyfile 写权限。

`cyberos-monitor.service` 在 API 完成主库 migration 后启动，以 `cyberos` 身份运行，只写 `/cyberos/state` 并只读 NAS。unit 使用 `Type=notify`，仅允许 `AF_UNIX`、清空 capabilities、限制 `MemoryMax=256M`，并使用较低 CPU/IO weight。它是指标库唯一写入者；启动失败只令监控与 Health 降级，不应拉停 API、文件、索引或备份服务。

`cyberos-alerter.service` 同样在 API migration 后启动，并以 `Wants=cyberos-monitor.service` 表达弱依赖：monitor 失败不会停止 alerter，Health incident 和已有 outbox 仍可处理。为 SMTP 它单独允许 `AF_UNIX/AF_INET/AF_INET6`，其余身份、capability、NAS 只读和 256 MiB 内存边界与 monitor 一致。升级停服时先停止 alerter，再停止 monitor 和 API；启动顺序相反。

Rust Indexer 是 `Type=notify` 常驻服务，带 watchdog、失败重启、1 GiB cgroup 内存上限和只读 NAS 映射；内部每 30 分钟校准。systemd 是唯一调度层：health 每 15 分钟运行并带最多 2 分钟随机延迟，maintenance 每日 04:30 运行并带最多 30 分钟随机延迟，backup daily/weekly 分别按日历运行。只有这些 oneshot 任务完成后显示 `inactive (dead)` 才是正常状态。

查看全部运行状态：

```bash
systemctl --no-pager --type=service --type=timer 'cyberos-*'
journalctl -u cyberos-api.service -u cyberos-monitor.service -u cyberos-alerter.service -u cyberos-worker@1.service -u cyberos-photos.service -u cyberos-downloader.service -n 100 --no-pager
journalctl -u cyberos-indexer.service -u cyberos-health.service -n 100 --no-pager
```

手动索引使用 API 或 `cyberos-indexer --once`；其他手动任务启动对应 oneshot service，而不是直接运行 systemd timer：

```bash
sudo -u cyberos /usr/lib/cyberos/bin/cyberos-indexer --once
sudo systemctl start cyberos-maintenance.service
sudo systemctl start cyberos-health.service
```

修改 unit、drop-in 或 `/cyberos/config/config.toml` 后执行 `systemctl daemon-reload`，再重启受影响的常驻服务。停用 timer 前确认没有正在执行的同类 oneshot，避免 SQLite 写入并发。
