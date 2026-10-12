---
title: systemd 服务与 Timer
description: 服务身份、周期和关键 hardening 配置。
type: reference
status: current
audience: [operator]
sourceOfTruth: [packaging/systemd/sigmaos-api.service, packaging/systemd/sigmaos-worker@.service, packaging/systemd/sigmaos-indexer.service, packaging/systemd/sigmaos-health.service, packaging/systemd/sigmaos-health.timer, packaging/systemd/sigmaos-maintenance.service, packaging/systemd/sigmaos-maintenance.timer]
sidebar:
  order: 3
---

核心服务默认以 `sigmaos` 身份运行并使用 `ProtectSystem=strict`、`NoNewPrivileges=yes` 和资源上限。`sigmaos-hostd` 是唯一的 root daemon；为原子创建可配置的 Unix 共享账号，它显式放行 `/etc`、ACL 备份目录和 Samba 私有密码库。Rust `sigmaos-termux` 固定以 `sigmaos` 身份启动，使用独立家目录 `/var/lib/sigmaos-termux`；`KillMode=process` 使 daemon 重启时 tmux session 保持运行。它对配置、数据库与日志路径的屏蔽仅防误操作，同 UID 终端不是后台服务的安全隔离边界。Rust downloader 与 photostaff 只写 `/var/lib/sigmaos`、日志和配置的 NAS roots；两者都在 API 迁移后启动，并在 30 秒 systemd 停止时限内持久化进度、终止子进程和归还租约。Photostaff 使用 ExifTool、libvips、`heif-convert`、`dcraw_emu`、`ffmpeg` 和 `ffprobe`，其 unit 不依赖硬编码 `/srv/nas` mount，因此存储离线时 daemon 仍能报告健康与恢复状态。

hostd 在 `local-fs.target`、tmpfiles 和 `NetworkManager.service` 之后启动，并排在 `network-online.target` 之前，以便先恢复未完成的 Ethernet checkpoint 事务。它继续使用既有 `/etc` 和 `/var/lib/sigmaos/network-manager` 写边界；API 不获得 root、capability 或 NetworkManager keyfile 写权限。

Rust Indexer 是 `Type=notify` 常驻服务，带 watchdog、失败重启、1 GiB cgroup 内存上限和只读 NAS 映射；内部每 30 分钟校准。systemd 是唯一调度层：health 每 15 分钟运行并带最多 2 分钟随机延迟，maintenance 每日 04:30 运行并带最多 30 分钟随机延迟，backup daily/weekly 分别按日历运行。只有这些 oneshot 任务完成后显示 `inactive (dead)` 才是正常状态。

查看全部运行状态：

```bash
systemctl --no-pager --type=service --type=timer 'sigmaos-*'
journalctl -u sigmaos-api.service -u sigmaos-worker@1.service -u sigmaos-photostaff.service -u sigmaos-downloader.service -n 100 --no-pager
journalctl -u sigmaos-indexer.service -u sigmaos-health.service -n 100 --no-pager
```

手动索引使用 API 或 `sigmaos-indexer --once`；其他手动任务启动对应 oneshot service，而不是直接运行 systemd timer：

```bash
sudo -u sigmaos /usr/lib/sigmaos/bin/sigmaos-indexer --once
sudo systemctl start sigmaos-maintenance.service
sudo systemctl start sigmaos-health.service
```

修改 unit、drop-in 或 `/etc/sigmaos/config.toml` 后执行 `systemctl daemon-reload`，再重启受影响的常驻服务。停用 timer 前确认没有正在执行的同类 oneshot，避免 SQLite 写入并发。
