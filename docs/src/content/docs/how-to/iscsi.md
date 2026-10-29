---
title: iSCSI 网络磁盘
description: 在 Storage 面板创建 Target、LUN 和受控的网络磁盘连接。
type: how-to
status: current
audience: [operator]
sourceOfTruth: [packages/shared/src/iscsi.ts, crates/hostd/src/iscsi.rs, packaging/helpers/iscsi.py, packaging/systemd/cyberos-hostd.service]
sidebar:
  order: 4
---

CyberOS 使用 Linux LIO 作为 iSCSI Target，向 Windows、ESXi 等连接端提供块设备。Storage 面板的 iSCSI 卡片管理多个 Target、每个 Target 的多个 LUN、连接会话及保留的镜像。CyberOS 不充当连接远端磁盘的 Initiator。

安装包包含 `python3-rtslib-fb` 和所需模块的加载规则。Raspberry Pi 6.18 内核默认未启用 `CONFIG_TARGET_CORE`，安装包通过 DKMS 构建缺失的 LIO 模块，不替换内核；必须安装与运行内核匹配的 headers。原生包含 LIO 的内核继续使用发行版模块。模块源代码固定为 Linux 6.18.34 并逐文件验证 SHA256，完整对应源码和许可安装在 `/usr/src/cyberos-lio-6.18.34`，安装过程无需联网拉取驱动源码。

Debian 的 `rtslib-fb-targetctl` 恢复服务仅在 LIO 已就绪时启动，避免依赖配置早于 DKMS 编译时导致安装失败。安装前脚本会刷新这一条件，安装成功后移除临时条件文件；不启动服务、不修改已有 Target 配置。部署会在安装完成后的正常激活阶段重新运行模块准备服务，再启动 hostd，避免前一次失败安装留下的已完成状态跳过新模块加载。

如果恢复服务最近因 LIO 条件不满足而跳过，部署激活会清除它遗留的历史失败状态；真正执行恢复后失败的状态会保留，便于诊断。

## 创建和连接

1. 确认存储池已挂载且有足够可用空间。iSCSI 必须具备内核 `target_core_mod`、`target_core_file`、`iscsi_target_mod` 和 configfs 支持；缺少能力时卡片显示不可用原因。
2. 新建 Target，输入名称，选择本机监听地址和端口（默认 `3260`），填写连接端的 Initiator IQN 白名单。Target IQN 自动生成，创建后保持稳定。
3. CHAP 默认开启。设置专用用户名和密码，随后在连接端配置相同凭据；保存后页面只显示凭据是否已配置。仅在明确需要时关闭 CHAP。
4. 在 Target 详情中创建 LUN，选择存储池并设置 GiB 容量。创建时预留全部容量；空间不足或预分配不受支持时创建失败，不自动改用稀疏镜像。
5. 在连接端使用选定的监听地址、端口和 Target IQN 发现并登录，再由连接端初始化磁盘与文件系统。不要让多个主机同时写入普通单机文件系统。

配置修改、添加或移除 LUN、停用及删除 Target 前，先在连接端卸载文件系统并注销 iSCSI 会话。存在活动会话时 CyberOS 拒绝这些操作。卡片提供会话、状态和失败原因；操作失败后刷新状态再重试。

## 保留、重新挂接与销毁

移除 LUN 或删除 Target 默认只移除导出配置，镜像继续占用原存储池空间。保留镜像列在卡片中，可重新挂接到另一个 Target；同一镜像只允许挂接一次。销毁需要显式选择并输入对应名称确认，成功后无法通过文件回收站找回。

镜像固定存放在存储池的 `.cyberos/iscsi` 中，配置和 CHAP 凭据位于 root 专用的 `/cyberos/state/hostd/iscsi`。不要手工移动、编辑、共享或删除这些路径。普通文件操作无法访问镜像；有导出或保留镜像的存储池不能删除。NFS 共享必须启用 root squashing，避免通过存储池共享访问内部文件。

启用 iSCSI 后，存储池 `.cyberos` 目录的直接条目保留给系统，并使用内核 immutable 属性保护，避免可写共享重命名内部镜像目录。普通池文件仍可读写；已有内部子目录内容和普通元数据备份不受此限制。销毁全部镜像后该内部目录仍保持保护，不要手工移除属性。

## 重启与备份

hostd 启动后恢复已启用的 Target。池或监听地址未就绪时保持降级，后续重新检查并恢复；恢复仅管理 CyberOS 创建的对象。

普通 restic 文件备份排除 LUN 镜像，也不包含 root 专用 Target 配置。iSCSI 数据应在连接端采用一致性备份。首版不提供快照、克隆、在线扩容、精简置备、多路径或 LUN 一致性备份。
