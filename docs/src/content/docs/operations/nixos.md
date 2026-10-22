---
title: NixOS 部署
description: 使用 flake packages 和 NixOS module 构建、配置、升级与验收 ZOS。
type: operation
status: current
audience: [developer, operator]
sourceOfTruth: [flake.nix, flake.lock, nix/packages.nix, nix/module.nix, nix/tests/nixos-module.nix]
sidebar:
  order: 2
---

ZOS flake 为 `x86_64-linux` 和 `aarch64-linux` 导出可复现 package、checks 与 NixOS module；Linux 和 macOS 同时获得开发 shell。module 运行原生 Node.js/Rust 进程和 systemd units，不使用 Docker 承载 ZOS 本身。程序位于只读 Nix store，配置与状态位于 `/zos`，socket 位于 `/run/zos`。

## Flake 输出

```bash
nix flake show
nix flake check --print-build-logs
nix build .#zos
```

`packages.<system>` 包含组合包 `zos`、Rust 二进制 `zos-rust`、Node.js 应用 `zos-node` 和文档站 `zos-docs`。Nix 构建元数据使用 `source: nix`、`reproducible: true`，API 通过 `/api/system/build-info` 暴露同一公共字段。

`nix flake check` 在每个 Linux 架构构建三个 package 和 workspace-layout check；`x86_64-linux` 还启动 NixOS VM，验证生成式与外部配置、API/Nginx/docs、systemd 服务、目录所有权以及声明式模式的 501 拒绝。跨架构产物应在对应原生 runner 上验证，尤其是 `better-sqlite3`。

## 引入 module

在系统 flake 中跟随同一 nixpkgs，并导入 `nixosModules.default`：

```nix
{
  inputs.zos.url = "github:zhubby9190779/ZOS";
  inputs.zos.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { self, nixpkgs, zos, ... }: {
    nixosConfigurations.nas = nixpkgs.lib.nixosSystem {
      system = "aarch64-linux";
      modules = [
        zos.nixosModules.default
        ({ pkgs, ... }: {
          services.zos = {
            enable = true;
            package = zos.packages.${pkgs.stdenv.hostPlatform.system}.default;
            workerInstances = 1;

            settings = {
              root_dir = "/zos";
              environment = "production";
              api = { host = "127.0.0.1"; port = 3010; };
              admin = { display_name = "ZOS Admin"; auth_mode = "local-only"; };
              docker.enabled = false;
              vm.enabled = false;
              monitoring.enabled = true;
              nas_roots = [
                {
                  id = "primary";
                  name = "Primary NAS";
                  path = "/zos/data/primary";
                  mount_policy = "required";
                }
              ];
            };

            nginx = { enable = true; port = 80; openFirewall = true; };
            integrations = {
              docker.enable = false;
              virtualMachines.enable = false;
              vodPlayer.enable = false;
            };
          };
        })
      ];
    };
  };
}
```

NAS root 必须由系统的 `fileSystems`、硬件配置或其他存储 module 单独声明，并实际挂载到 `/zos/data/<id>`。ZOS module 只创建目录，不会格式化磁盘、组建 RAID 或替你声明挂载。

## 配置与 secrets

`services.zos.settings` 使用 Nix attrset 生成 TOML，适合非秘密配置。生成文件位于 Nix store，不能放 provider key、SMTP 密码、restic 密码或其他 secret。

secret-bearing 配置应由 agenix、sops-nix 或等价机制生成到绝对运行时路径，再使用：

```nix
services.zos = {
  enable = true;
  configFile = "/run/secrets/zos-config.toml";
};
```

`settings` 与 `configFile` 互斥。外部文件应允许 `zos` group 读取，并在 ZOS 服务启动前存在；module 将 `/zos/config/config.toml` 链接到所选来源。不要把 secret 文件通过 `builtins.readFile`、Nix path 或字符串插值写入 store。

## 组件、timer 与集成

`services.zos.components` 可分别启停 API、worker、monitor、alerter、indexer、photostaff、downloader、hostd、termux、host-accessd、Bluetooth、VOD、backup、health 与 maintenance。`workerInstances` 控制 `zos-worker@N.service` 数量。

`services.zos.timers` 管理 health、maintenance、daily backup 与 weekly backup；timer 只有在对应 component 同时启用时才创建。Docker、libvirt/QEMU 和 VOD 的宿主依赖由 `services.zos.integrations` 显式启用，默认不会开放 Docker 或虚拟机权限。`hostAccessd` 与 VOD component 不能脱离对应 integration 单独启用；Bluetooth component 会启用 NixOS BlueZ 服务。

Nginx 默认启用并代理 loopback API；`/mcp` 与 `/mcp-transfer/` 不对 LAN 暴露。`services.zos.nginx.openFirewall` 默认为 `false`，只有明确设置为 `true` 才会把所选端口加入 NixOS firewall。也可以保持该选项关闭，由站点级 firewall 规则统一开放端口。

module 沿用 Debian units 的分服务写权限：API、worker、索引、下载、备份和终端只获得各自需要的 `/zos` 子目录，root hostd 也不会获得整个 `/zos` 或 `/etc` 的写权限。`/zos/state` 使用 `root:zos 1770`；sticky bit 允许 `zos` 服务写入自己的 SQLite 和运行状态，同时防止它们替换 root-owned `/zos/state/hostd` 子树，并避免 systemd-tmpfiles 拒绝不安全的所有权过渡。终端账户固定使用 `/zos/home/termux` 与 Bash；VOD integration 只在启用时加入 `audio`、`render`、`video` 组。

## 声明式宿主机边界

module 固定注入 `ZOS_HOST_MUTATION_POLICY=declarative`。以下操作继续提供状态读取，但不允许从 ZOS 写入：

| 资源 | ZOS 行为 | 配置所有者 |
| --- | --- | --- |
| NetworkManager Ethernet、Wi-Fi、热点 | capability 为 false，API 返回 501，hostd 返回 `unsupported` | NixOS networking / NetworkManager 配置 |
| 存储池创建与删除 | 只读发现，写请求返回 501 | `fileSystems`、RAID/磁盘 module |
| SMB/WebDAV/FTP/NFS/DLNA 共享 | 页面只读，应用配置返回 501 | 对应 NixOS service options |
| Docker daemon 配置 | daemon 状态可见，配置按钮禁用，更新返回 501 | `virtualisation.docker.*` |

hostd 在此模式下不会执行 NetworkManager 启动恢复或周期事务恢复写入。API 层和 root hostd 都实施拒绝，UI 禁用只用于表达状态，不是安全边界。

这个策略不是全局只读模式。NAS 文件、SQLite 状态、approval、备份、索引、终端、Compose App 运行副本和电源动作仍按各自策略工作。`services.zos.settings.shares` 不会自动翻译为 NixOS Samba/NFS 配置；宿主服务必须独立声明。

## 部署与验收

先在仓库或锁文件更新 PR 上运行：

```bash
nix flake check --print-build-logs
sudo nixos-rebuild dry-activate --flake .#nas
sudo nixos-rebuild switch --flake .#nas
```

切换后检查完整运行面，而不只检查 `/health`：

```bash
sudo systemctl --failed
sudo systemctl is-active zos-api.service zos-hostd.service zos-worker@1.service
sudo systemctl list-timers 'zos-*'
sudo journalctl -u zos-api.service -u zos-hostd.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3010/health
curl -fsS http://127.0.0.1:3010/api/roots/readiness
curl -fsS http://127.0.0.1:3010/api/system/health
curl -fsS http://127.0.0.1:3010/api/system/build-info
```

再验证 Web、`/docs/`、NAS mount readiness、一次 index/health run，以及声明式资源的 capability 为 false。对任一宿主配置写接口发出测试请求时，预期结果是 HTTP 501，而不是静默成功。

## 升级与回退

升级通常是更新输入 revision/`flake.lock` 后执行 `nixos-rebuild switch`。切换前停止或避开并发 SQLite 写入，保存 `/zos/config`、`/zos/state` 和必要 NAS 元数据，并记录当前 generation 与 ZOS 版本。

NixOS generation 回退只能恢复 package、unit 和声明式配置，不能逆转已经执行的 SQLite migration，也不会恢复 NAS 数据。新版本启动并迁移数据库后，若旧版本不兼容，必须同时恢复与旧 package 匹配的 `/zos/state` 备份。不要仅运行 `nixos-rebuild --rollback` 就假定数据层已回退。

出现故障时先保留 journal 与 build-info，再决定回退 generation 或修复配置。若错误仅是声明式写请求返回 501，这是预期策略，不应通过 systemd environment override 把 module 改回 `mutable`。
