---
title: Tailscale
description: 安装、登录、节点与网关管理，以及网络配置的确认回退。
type: operation
status: current
audience: [operator, user]
sourceOfTruth: [crates/hostd/src/tailscale/mod.rs, crates/hostd/src/tailscale/transaction.rs, packages/api/src/routes/tailscale.ts, packages/web/src/components/settings/SettingsTailscalePage.tsx, packaging/scripts/cyberos-configure-tailscale.sh, packaging/helpers/tailscale_forwarding.py]
---

Tailscale 是 CyberOS 的原生系统组件，使用官方 stable 签名 APT 仓库，支持 `amd64` 和 `arm64`。进入 **系统设置 → Tailscale** 查看服务、本机信息、网络节点和网络配置。

## 安装与升级

全新安装会安装 Tailscale 并启用 `tailscaled.service` 开机启动，等待用户登录。已有设备保留 `/var/lib/tailscale` 中的身份、现有偏好和服务启用状态，包括已配置的 Tailscale SSH。

安装器先准备官方签名仓库并检查软件包可用性；升级部署器还会模拟依赖安装，完成后才停止 CyberOS 服务。仓库或依赖失败时先恢复 APT 访问，再重试。不要使用 `trusted=yes` 或跳过签名检查。

尚未包含 `cyberos-configure-tailscale.sh` 的旧部署器不能自行准备新依赖。首次升级请使用当前源码的安装入口：

```bash
sudo ./packaging/scripts/install.sh
```

此变更涉及包依赖、systemd 单元和转发 helper，必须走完整 Debian 包安装或升级流程。组件快速替换不能代替包升级。升级前保存旧包和 `/cyberos/state`，停止索引器及维护、健康、备份定时器，按现有升级流程检查后恢复此前运行的单元。

## 登录与连接

默认控制服务器为 `https://controlplane.tailscale.com`。使用 Headscale 时，在登录前填写其 HTTP(S) 服务地址。推荐 HTTPS；HTTP 仅适合可信的隔离网络。

- **网页授权**：点击登录，打开返回的授权页面，按控制面的要求完成授权。页面持续更新登录与设备审批状态。
- **Auth key**：输入控制面签发的 key 后登录。输入提交后立即从表单清除；CyberOS 不将 key 写入数据库、日志或浏览器存储。Tailscale 自身负责保存设备身份。
- **连接开关**：保留身份的断开和重新连接。断开、注销和重启服务都需要明确确认。
- **切换控制服务器**：先注销，再填写新服务器地址并重新登录。

通过 Tailscale 远程管理设备时，断开、注销或重启会影响当前连接。先准备局域网或其他管理入口。不要用生产设备的唯一管理连接测试注销或切换控制面。

新设备默认接受 DNS，不接受其他节点发布的子网路由；网关与出口节点功能默认关闭。已有设备以 Tailscale 的真实配置为准。此页面不管理 Tailscale SSH、Serve、Funnel 或控制面 ACL。

## 节点与网络配置

页面展示节点名称、操作系统、地址、在线状态、活动的直连或中继、流量与出口节点资格。没有活动连接时不会仅凭节点有 DERP 区域就将它标记为正在中继。

网络配置支持 Tailscale 设备名称、接受 DNS、接受子网路由、选择出口节点和保留本地 LAN 访问。保存时仅提交修改的字段；如果其他客户端改变了配置，页面保留草稿并要求重新核对。

所有网络配置变更都启动 **60 秒确认窗口**。检查连接后点击 **保留变更**；点击 **恢复原设置** 可提前撤销。未确认的变更由 hostd 持久化恢复，关闭浏览器或重启 hostd 不会取消恢复责任。如果 Tailscale 暂时不可达，恢复会继续重试。

回退只恢复此次修改且仍与本次应用值一致的字段，保留其他客户端的后续修改。如果身份或配置发生冲突，页面提示核对实际状态。Tailscale LocalAPI 不提供跨客户端原子比较交换，CyberOS 在应用前核对版本，并使用字段掩码减少与外部客户端的冲突。

## 子网与出口网关

子网列表每行填写一个规范网络 CIDR，例如 `192.168.20.0/24` 或 `fd00::/64`，不能填写默认路由。`0.0.0.0/0` 和 `::/0` 由 **将本机作为出口节点** 开关统一管理。

使用其他出口节点和将本机作为出口节点互斥。启用网关时，固定的 systemd oneshot helper 应用 `/etc/sysctl.d/99-cyberos-tailscale.conf` 中由 CyberOS 管理的转发配置。IPv6 转发启用前，将原本接受路由通告的接口保留为可接受路由通告；显式关闭 RA 的接口保持关闭。

关闭网关会撤销对应路由发布并删除专属转发配置；不会将主机的共享转发开关关掉，以保留 Docker 和虚拟机的网络。已启用的运行时转发可能持续到系统重启，其他网络组件仍可按自身配置管理它。

**已发布不代表已生效。** 子网和出口节点通常需要 Tailscale 或 Headscale 控制面审批，也受 ACL、目标路由及防火墙限制。本机无法确定审批时显示需控制台核验。即使控制面报告主路由，也应使用第二节点验证目标服务和实际出口地址。

## 运维检查

```bash
sudo systemctl status tailscaled.service cyberos-hostd.service --no-pager
sudo journalctl -u tailscaled.service -u cyberos-hostd.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/api/system/tailscale
sudo systemctl status cyberos-tailscale-forwarding.service --no-pager
```

API 返回经过白名单整理的状态；不要将 LocalAPI 的原始 `prefs` 输出到日志或问题报告，其中可能包含身份密钥。API 保持 loopback 监听，通过原有 Nginx 入口访问。hostd 仅连接固定 Unix socket，系统服务操作仅限 `tailscaled.service` 和专用转发 helper。
