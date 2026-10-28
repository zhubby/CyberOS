---
title: hostd 与终端服务
description: Rust hostd 和 terminal 的 Unix socket、权限与进程边界。
type: reference
status: current
audience: [developer, operator]
sourceOfTruth: [crates/hostd/src/server.rs, crates/hostd/src/shares.rs, crates/hostd/src/storage.rs, crates/hostd/src/docker_daemon.rs, crates/hostd/src/network_manager.rs, crates/terminald/src/server.rs, crates/terminald/src/pty.rs, crates/terminald/src/session_policy.rs, packages/shared/src/terminal-protocol.ts, packaging/systemd/cyberos-hostd.service, packaging/systemd/cyberos-terminald.service]
sidebar:
  order: 6
---

`cyberos-hostd` 是 Rust root daemon，默认只在 `/run/cyberos/hostd.sock` 接受版本化 JSONL 单请求，并验证 Unix peer UID。systemd unit 与 API 共同读取 `/cyberos/config/config.toml` 的 `[hostd].socket_path`，不会用 unit 环境变量覆盖配置路径；自定义路径若超出 `/run/cyberos`，还必须同步调整 unit 的 `ReadWritePaths`。操作名、命令、参数和配置目标均使用 allowlist；共享路径只能引用 hostd 自己从配置读取的 storage pools，请求中的 data root 只用于与 hostd 配置做一致性校验。

`cyberos-terminald` 是非 root Rust daemon，默认在 `/run/cyberos/terminald.sock` 接受 Terminal Protocol v1 JSONL 长连接，并验证 Unix peer UID。协议用 request、response、stream ID 关联控制请求和 PTY 流，以 Base64 传输原始字节；未知版本、字段、重复 attach 和超限输入都会返回结构化错误。API 与 terminal 均以 `cyberos` 运行，terminal 在 `/cyberos/home/terminal` 保存 tmux socket，并通过 native PTY attach。session 名称由规范化 data root workspace key 和标签 ID 稳定生成，因此 API 或 WebSocket 重连只会重新 attach，不会重复创建 shell。两者共用 UID，不能把 systemd 路径屏蔽视为安全隔离边界。

API 在已登记标签的 `open` 请求中发送 `persistent: true`。terminal 把该状态写入 tmux session 的 `@cyberos_persistent` 选项；空闲 reaper 和容量淘汰都会跳过这些 session。整机上所有 session 共同受 `terminal.maxSessions` 限制，连接上限与 session 上限分开计算。

关闭或重启标签时，API 使用稳定 session 名称向 terminal 发送 destroy，即使当前没有 WebSocket 连接也会终止 tmux session。销毁失败时 API 保留 SQLite 标签，避免元数据宣称进程已结束。API/terminal 进程重启不会影响仍由 tmux 承载的 shell；主机重启会终止 tmux，之后同一标签首次连接时创建新 shell，不恢复旧进程或 scrollback。

API 通过 Unix socket 调用 hostd 和 terminal；浏览器永远不直接连接宿主机 socket。

## 共享账号与 systemd 写边界

共享账号名可配置，因此应用凭据时 hostd 可能调用 `useradd`，原子更新 `/etc/passwd`、`/etc/shadow`、`/etc/group` 及其锁和备份文件；只放行几个现有文件会让首次创建账号失败。hostd unit 在 `ProtectSystem=strict` 下显式放行 `/etc`；`smbpasswd` 还需要 Samba 的 `/run/samba` 锁目录、`/var/lib/samba` 状态库、`/var/cache/samba` 缓存和 `/var/log/samba` 日志目录，tmpfiles 在 hostd 启动前创建 `/run/samba`。请求仍只能写代码中固定的 CyberOS 配置文件，账号名经过 system-safe 校验，命令与参数由 hostd 组装，客户端不能提交路径或任意命令。

hostd 不获得 `/cyberos/state` 共享父目录或 `/cyberos/logs` 的写权限；Docker 与 NetworkManager 恢复材料只写各自的 root-only `StateDirectory` 子目录。`/etc` 是这里最宽的剩余边界，部署时应把 hostd socket、peer UID 校验和 approval 流程视为同一条安全边界。

共享配置由 hostd 渲染，但协议服务必须显式读取：Samba 使用保留原 `/etc/samba/smb.conf` 的包装配置并导入 CyberOS share，vsftpd 与 MiniDLNA 的 systemd drop-in 指向各自托管配置。WebDAV 由独立的非 root `cyberos-webdav.service` 启动，在配置的高端口监听，不启动默认占用 80 端口的 Apache；其配置可由 `www-data` 读取，DAV 锁只写入独立 RuntimeDirectory。NFS 由 `nfs-server.service` 加载 `/etc/exports.d/cyberos.exports`。不要以 systemd 的 active 代替协议客户端实际读写验收。

## Docker daemon 配置边界

hostd 提供固定的 Docker daemon 配置操作。它只允许读写 `/etc/docker/daemon.json`，只允许重启 `docker.service`，请求不能传入路径、unit 或任意命令。API 进程仍以 `cyberos` 用户运行，不获得 root 或 capabilities。

保存前 API 与 hostd 都会解析 JSON 并要求顶层为对象；hostd 随后运行 `dockerd --validate --config-file`。目标若为符号链接或非普通文件会被拒绝。写入使用 `/etc/docker` 同目录临时文件、`0644 root:root` 权限和原子 rename，并以内容 SHA-256 revision 防止覆盖 SSH 或其他进程的并发修改。

第一次保存待应用配置时，hostd 在 root 专用的 `/cyberos/state/hostd/docker-daemon/`（`0700 root:root`）保存最后已生效的基线和事务元数据。继续保存只更新待应用版本，不覆盖基线。重启成功后事务材料会清理；重启失败时 hostd 恢复基线并再次启动 Docker。若回滚启动也失败，恢复材料会保留供人工处理。

## NetworkManager 配置边界

Wi-Fi 与热点写操作使用 hostd 的 `network.manager` 操作。请求只能选择扫描、连接、断开、radio、CyberOS profile 和热点动作，不能传入命令、路径、systemd unit 或任意参数数组。API 保持 `cyberos` 用户身份且不获得网络 capabilities。

CyberOS 只写 `/etc/NetworkManager/system-connections/cyberos-*.nmconnection`，拒绝符号链接和非普通文件，使用同目录临时文件、`0600 root:root` 与原子 rename。编辑使用内容 SHA-256 revision；Netplan 或其他工具建立的外部 profile 可以连接和断开，但 hostd 不允许编辑或删除。

基础 keyfile 由 `nmcli --offline` 生成，密码只在 hostd 内存和 root-only keyfile 中出现，不放入命令参数、日志、错误或 API 响应。公开状态只返回 `credentialConfigured`。这些凭据没有应用层静态加密，备份 `/etc` 时必须按秘密材料保护。

同一网卡的客户端和热点模式互斥。启动热点前，hostd 将待恢复的客户端 UUID 写入 `/cyberos/state/hostd/network-manager/state.json`（目录 `0700`、文件 `0600`）；热点激活失败或正常停止时尝试恢复。恢复失败会保留状态并返回 `502`，不会谎报连接已恢复。
