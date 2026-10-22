{ self }:
{ config, lib, pkgs, ... }:

let
  inherit (lib) mkEnableOption mkIf mkMerge mkOption types;
  cfg = config.services.zos;
  toml = pkgs.formats.toml { };
  generatedConfig = toml.generate "zos-config.toml" cfg.settings;
  configSource = if cfg.configFile != null then cfg.configFile else toString generatedConfig;
  packageRoot = "${cfg.package}/lib/zos";
  node = "${pkgs.nodejs_22}/bin/node";
  baseEnvironment = {
    ZOS_ROOT = "/zos";
    ZOS_CONFIG = "/zos/config/config.toml";
    ZOS_HOST_MUTATION_POLICY = "declarative";
    ZOS_BUILD_INFO_PATH = "${packageRoot}/build-info.json";
    NODE_PATH = "${packageRoot}/node_modules";
    SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
  };
  runtimePath = with pkgs; [
    bashInteractive
    coreutils
    dbus
    findutils
    gnugrep
    gnused
    util-linux
    iproute2
    procps
    git
    tmux
    sqlite
    mdadm
    smartmontools
    restic
    acl
    systemd
  ] ++ lib.optionals cfg.integrations.docker.enable [ docker ]
    ++ lib.optionals cfg.integrations.virtualMachines.enable [ libvirt qemu ]
    ++ lib.optionals cfg.integrations.vodPlayer.enable [ mpv ]
    ++ lib.optionals cfg.integrations.tvMode.enable [ chromium curl seatd v4l-utils weston wtype ];
  photostaffRuntimePath = runtimePath ++ (with pkgs; [ exiftool ffmpeg libheif libraw vips ]);
  hardenedService = {
    User = "zos";
    Group = "zos";
    WorkingDirectory = "/zos/state";
    Restart = "on-failure";
    RestartSec = "2s";
    NoNewPrivileges = true;
    PrivateTmp = true;
    ProtectHome = "read-only";
    ProtectSystem = "strict";
    CapabilityBoundingSet = "";
  };
  nodeService = {
    description,
    workspace,
    arguments ? "",
    after ? [ ],
    before ? [ ],
    wants ? [ ],
    requires ? [ ],
    requiresMountsFor ? [ ],
    wantedBy ? [ "multi-user.target" ],
    environment ? { },
    serviceConfig ? { }
  }:
    {
      inherit description after before wants requires wantedBy;
      environment = baseEnvironment // environment;
      path = runtimePath;
      unitConfig = lib.optionalAttrs (requiresMountsFor != [ ]) {
        RequiresMountsFor = requiresMountsFor;
      };
      serviceConfig = hardenedService // {
        ExecStart = "${node} ${packageRoot}/apps/${workspace}/dist/index.js${lib.optionalString (arguments != "") " ${arguments}"}";
      } // serviceConfig;
    };
  rustService = {
    description,
    binary,
    after ? [ ],
    before ? [ ],
    wants ? [ ],
    requires ? [ ],
    requiresMountsFor ? [ ],
    wantedBy ? [ "multi-user.target" ],
    root ? false,
    path ? runtimePath,
    environment ? { },
    serviceConfig ? { }
  }:
    {
      inherit description after before wants requires wantedBy;
      environment = baseEnvironment // environment;
      inherit path;
      unitConfig = lib.optionalAttrs (requiresMountsFor != [ ]) {
        RequiresMountsFor = requiresMountsFor;
      };
      serviceConfig = hardenedService // {
        ExecStart = "${packageRoot}/bin/${binary}";
      } // serviceConfig // lib.optionalAttrs root {
        User = "root";
        Group = "root";
      };
    };
  componentOption = description: default: {
    enable = mkOption {
      type = types.bool;
      inherit default description;
    };
  };
  timerOption = description: default: {
    enable = mkOption {
      type = types.bool;
      inherit default description;
    };
  };
  workerServices = lib.listToAttrs (lib.genList
    (index: lib.nameValuePair "zos-worker@${toString (index + 1)}"
      (nodeService {
        description = "ZOS agent worker ${toString (index + 1)}";
        workspace = "worker";
        after = [ "zos-api.service" ];
        requires = lib.optional cfg.components.api.enable "zos-api.service";
        serviceConfig = {
          ReadWritePaths = [ "/zos/state" "/zos/logs" "/zos/data" ];
          MemoryMax = "768M";
          CPUQuota = "200%";
          TasksMax = 256;
        };
      }))
    cfg.workerInstances);
in {
  options.services.zos = {
    enable = mkEnableOption "ZOS NAS appliance services";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "self.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "Combined ZOS package to run.";
    };

    settings = mkOption {
      type = toml.type;
      default = { };
      description = "Non-secret ZOS configuration rendered as TOML.";
    };

    configFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/run/secrets/zos-config.toml";
      description = "Absolute path to an external, secret-bearing TOML configuration file.";
    };

    workerInstances = mkOption {
      type = types.ints.between 1 64;
      default = 1;
      description = "Number of ZOS worker service instances.";
    };

    components = {
      api = componentOption "the API and web service" true;
      worker = componentOption "agent workers" true;
      monitor = componentOption "metrics collection" true;
      alerter = componentOption "alert evaluation" true;
      indexer = componentOption "NAS indexing" true;
      photostaff = componentOption "media indexing" true;
      downloader = componentOption "HTTP downloads" true;
      hostd = componentOption "the privileged host integration daemon" true;
      termux = componentOption "the terminal daemon" true;
      hostAccessd = componentOption "restricted container host access" false;
      bluetooth = componentOption "Bluetooth management" false;
      vodPlayer = componentOption "HDMI VOD playback" false;
      backup = componentOption "backup jobs" true;
      health = componentOption "health evaluation" true;
      maintenance = componentOption "maintenance jobs" true;
    };

    timers = {
      health = timerOption "periodic health evaluation" true;
      maintenance = timerOption "daily maintenance" true;
      backupDaily = timerOption "daily backup" false;
      backupWeekly = timerOption "weekly backup verification and retention" false;
    };

    nginx = {
      enable = mkEnableOption "the ZOS Nginx reverse proxy" // { default = true; };
      port = mkOption {
        type = types.port;
        default = 80;
        description = "LAN port for the ZOS reverse proxy.";
      };
      openFirewall = mkOption {
        type = types.bool;
        default = false;
        description = "Whether to open the configured Nginx port in the NixOS firewall.";
      };
    };

    integrations = {
      docker.enable = mkEnableOption "Docker integration";
      virtualMachines.enable = mkEnableOption "libvirt virtual machine integration";
      vodPlayer.enable = mkEnableOption "DRM/ALSA VOD playback integration";
      tvMode.enable = mkEnableOption "the local Weston and Chromium TV shell";
    };
  };

  config = mkIf cfg.enable (mkMerge [
    {
      assertions = [
        {
          assertion = cfg.configFile == null || cfg.settings == { };
          message = "services.zos.settings and services.zos.configFile are mutually exclusive";
        }
        {
          assertion = cfg.configFile == null || lib.hasPrefix "/" cfg.configFile;
          message = "services.zos.configFile must be an absolute path";
        }
        {
          assertion = !cfg.components.hostAccessd.enable || cfg.integrations.docker.enable;
          message = "services.zos.components.hostAccessd requires services.zos.integrations.docker";
        }
        {
          assertion = !cfg.components.vodPlayer.enable || cfg.integrations.vodPlayer.enable;
          message = "services.zos.components.vodPlayer requires services.zos.integrations.vodPlayer";
        }
        {
          assertion = !cfg.integrations.tvMode.enable || cfg.components.api.enable;
          message = "services.zos.integrations.tvMode requires services.zos.components.api";
        }
        {
          assertion = !cfg.integrations.tvMode.enable || cfg.components.vodPlayer.enable;
          message = "services.zos.integrations.tvMode requires services.zos.components.vodPlayer";
        }
        {
          assertion = !cfg.integrations.tvMode.enable || cfg.integrations.vodPlayer.enable;
          message = "services.zos.integrations.tvMode requires services.zos.integrations.vodPlayer";
        }
      ];

      users.groups.zos = { };
      users.users.zos = {
        isSystemUser = true;
        group = "zos";
        home = "/zos/home/termux";
        createHome = true;
        shell = pkgs.bashInteractive;
        extraGroups = lib.optional cfg.integrations.docker.enable "docker"
          ++ lib.optional cfg.integrations.virtualMachines.enable "libvirtd"
          ++ lib.optionals cfg.integrations.vodPlayer.enable [ "audio" "render" "video" ]
          ++ lib.optionals cfg.integrations.tvMode.enable [ "input" "seat" ];
      };

      systemd.tmpfiles.rules = [
        "d /zos 0755 root root -"
        "d /zos/config 0750 root zos -"
        "d /zos/state 0750 zos zos -"
        "d /zos/logs 0750 zos zos -"
        "d /zos/data 0750 zos zos -"
        "d /zos/apps 0750 zos zos -"
        "d /zos/iso 0750 zos zos -"
        "d /zos/vm 0750 zos zos -"
        "d /zos/backup 0750 zos zos -"
        "d /zos/home 0750 zos zos -"
        "d /zos/home/termux 0750 zos zos -"
        "d /zos/state/bluetooth 0750 zos zos -"
        "d /zos/state/hostd 0755 root root -"
        "d /zos/state/hostd/bluetooth 0700 root root -"
        "d /zos/state/vod-player 0750 zos zos -"
        "d /zos/state/tv 0750 zos zos -"
        "d /zos/state/tv/chromium 0750 zos zos -"
        "d /zos/system-backups 0750 root root -"
        "d /zos/system-backups/permissions 0700 root root -"
        "d /run/zos 0770 root zos -"
        "L+ /zos/config/config.toml - - - - ${configSource}"
      ];

      environment.etc."zos/host-mutation-policy".text = "declarative\n";

      networking.firewall.allowedTCPPorts = lib.optional
        (cfg.nginx.enable && cfg.nginx.openFirewall)
        cfg.nginx.port;

      services.nginx = mkIf cfg.nginx.enable {
        enable = true;
        virtualHosts.zos = {
          listen = [ { addr = "0.0.0.0"; port = cfg.nginx.port; } ];
          locations."/" = {
            proxyPass = "http://127.0.0.1:3010";
            proxyWebsockets = true;
            extraConfig = ''
              client_max_body_size 4g;
              proxy_read_timeout 3600s;
              proxy_send_timeout 3600s;
              proxy_buffering off;
            '';
          };
          locations."= /mcp".return = "404";
          locations."^~ /mcp-transfer/".return = "404";
        };
      };

      systemd.services = mkMerge [
        (mkIf cfg.components.hostd.enable {
          zos-hostd = rustService {
            description = "ZOS privileged host integration daemon";
            binary = "zos-hostd";
            root = true;
            after = [ "local-fs.target" "systemd-tmpfiles-setup.service" ]
              ++ lib.optional cfg.components.bluetooth.enable "bluetooth.service";
            before = [ "network-online.target" ];
            wants = lib.optional cfg.components.bluetooth.enable "bluetooth.service";
            serviceConfig = {
              TimeoutStopSec = "180s";
              ReadWritePaths = [
                "/run/zos"
                "/zos/data"
                "/zos/state/hostd/bluetooth"
                "/zos/system-backups/permissions"
              ];
              CapabilityBoundingSet = [
                "CAP_CHOWN"
                "CAP_DAC_OVERRIDE"
                "CAP_FOWNER"
                "CAP_MKNOD"
                "CAP_SYS_ADMIN"
                "CAP_SYS_RAWIO"
              ];
              MemoryMax = "128M";
              CPUQuota = "50%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.components.api.enable {
          zos-api = nodeService {
            description = "ZOS API and web UI";
            workspace = "api";
            after = [ "network-online.target" "local-fs.target" ]
              ++ lib.optional cfg.components.hostd.enable "zos-hostd.service";
            wants = [ "network-online.target" ];
            environment = {
              ZOS_WEB_DIST = "${packageRoot}/apps/web/dist";
              ZOS_DOCS_DIST = "${packageRoot}/docs/dist";
            } // lib.optionalAttrs cfg.integrations.tvMode.enable {
              ZOS_VOD_PLAYER_ENABLED = "1";
            };
            serviceConfig = {
              ReadWritePaths = [ "/zos/state" "/zos/logs" "/zos/data" "/zos/vm" "/zos/iso" "/zos/apps" ];
              MemoryMax = "512M";
              CPUQuota = "150%";
              TasksMax = 256;
            };
          };
        })
        (mkIf cfg.components.worker.enable workerServices)
        (mkIf cfg.components.monitor.enable {
          zos-monitor = rustService {
            description = "ZOS metrics collector";
            binary = "zos-monitor";
            after = [ "local-fs.target" ] ++ lib.optional cfg.components.api.enable "zos-api.service";
            wants = lib.optional cfg.components.api.enable "zos-api.service";
            serviceConfig = {
              Type = "notify";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadOnlyPaths = [ "-/zos/data" ];
              ReadWritePaths = [ "/zos/state" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              MemoryMax = "256M";
              TasksMax = 64;
            };
          };
        })
        (mkIf cfg.components.alerter.enable {
          zos-alerter = rustService {
            description = "ZOS alert evaluator";
            binary = "zos-alerter";
            after = [ "network-online.target" "local-fs.target" ]
              ++ lib.optional cfg.components.api.enable "zos-api.service"
              ++ lib.optional cfg.components.monitor.enable "zos-monitor.service";
            wants = [ "network-online.target" ]
              ++ lib.optional cfg.components.api.enable "zos-api.service"
              ++ lib.optional cfg.components.monitor.enable "zos-monitor.service";
            serviceConfig = {
              Type = "notify";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadOnlyPaths = [ "-/zos/data" ];
              ReadWritePaths = [ "/zos/state" ];
              RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
              MemoryMax = "256M";
              TasksMax = 64;
            };
          };
        })
        (mkIf cfg.components.indexer.enable {
          zos-indexer = rustService {
            description = "ZOS NAS indexer";
            binary = "zos-indexer";
            after = [ "local-fs.target" ] ++ lib.optional cfg.components.api.enable "zos-api.service";
            requiresMountsFor = [ "/zos/data" ];
            serviceConfig = {
              Type = "notify";
              WatchdogSec = "20s";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadOnlyPaths = [ "/zos/data" ];
              ReadWritePaths = [ "/zos/state" "/zos/logs" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              MemoryMax = "1G";
              CPUQuota = "250%";
              TasksMax = 256;
            };
          };
        })
        (mkIf cfg.components.photostaff.enable {
          zos-photostaff = rustService {
            description = "ZOS media worker";
            binary = "zos-photostaff";
            path = photostaffRuntimePath;
            after = [ "local-fs.target" ] ++ lib.optional cfg.components.api.enable "zos-api.service";
            wants = lib.optional cfg.components.api.enable "zos-api.service";
            serviceConfig = {
              Type = "notify";
              NotifyAccess = "main";
              WatchdogSec = "20s";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadOnlyPaths = [ "-/zos/data" ];
              ReadWritePaths = [ "/zos/state" "/zos/logs" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              IPAddressDeny = "any";
              MemoryMax = "1G";
              CPUQuota = "250%";
              TasksMax = 256;
            };
          };
        })
        (mkIf cfg.components.downloader.enable {
          zos-downloader = rustService {
            description = "ZOS HTTP downloader";
            binary = "zos-downloader";
            after = [ "network-online.target" "local-fs.target" ]
              ++ lib.optional cfg.components.api.enable "zos-api.service";
            wants = [ "network-online.target" ];
            requires = lib.optional cfg.components.api.enable "zos-api.service";
            requiresMountsFor = [ "/zos/data" ];
            serviceConfig = {
              TimeoutStopSec = "30s";
              ReadWritePaths = [ "/zos/state" "/zos/logs" "/zos/data" ];
              MemoryMax = "512M";
              CPUQuota = "150%";
              TasksMax = 256;
            };
          };
        })
        (mkIf cfg.components.termux.enable {
          zos-termux = rustService {
            description = "ZOS terminal daemon";
            binary = "zos-termux";
            after = [ "local-fs.target" "systemd-tmpfiles-setup.service" ];
            wants = [ "local-fs.target" ];
            environment = {
              HOME = "/zos/home/termux";
              ZOS_TERMUX_USER = "zos";
              ZOS_TERMUX_SOCKET_PATH = "/run/zos/termux.sock";
              ZOS_TERMUX_SESSION_IDLE_TIMEOUT_MS = "1800000";
              ZOS_TERMUX_CONNECT_TIMEOUT_MS = "10000";
              ZOS_TERMUX_MAX_SESSIONS = "32";
            };
            serviceConfig = {
              WorkingDirectory = "/zos/home/termux";
              KillMode = "process";
              UMask = "0007";
              ProtectHome = "tmpfs";
              ReadWritePaths = [ "/run/zos" "/zos/data" "/zos/home/termux" ];
              InaccessiblePaths = [ "/zos/config" "/zos/state" "/zos/logs" ];
              RestrictSUIDSGID = true;
              MemoryMax = "256M";
              CPUQuota = "100%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.components.bluetooth.enable {
          zos-bluetoothd = rustService {
            description = "ZOS Bluetooth service";
            binary = "zos-bluetoothd";
            after = [ "dbus.service" "bluetooth.service" "local-fs.target" ]
              ++ lib.optional cfg.components.api.enable "zos-api.service";
            wants = [ "bluetooth.service" ];
            requires = lib.optional cfg.components.api.enable "zos-api.service";
            requiresMountsFor = [ "/zos/data" ];
            environment = {
              HOME = "/zos/state/bluetooth";
              XDG_CACHE_HOME = "/zos/state/bluetooth/cache";
            };
            serviceConfig = {
              ExecStart = "${pkgs.dbus}/bin/dbus-run-session -- ${packageRoot}/bin/zos-bluetoothd";
              WorkingDirectory = "/zos/state/bluetooth";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadWritePaths = [
                "/zos/state/bluetooth"
                "/zos/state/zos.sqlite"
                "-/zos/state/zos.sqlite-shm"
                "-/zos/state/zos.sqlite-wal"
              ];
              ReadOnlyPaths = [ "/zos/data" ];
              PrivateDevices = true;
              RestrictAddressFamilies = [ "AF_UNIX" "AF_BLUETOOTH" ];
              IPAddressDeny = "any";
              MemoryMax = "256M";
              CPUQuota = "100%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.components.vodPlayer.enable {
          zos-vod-player = rustService {
            description = "ZOS VOD player";
            binary = "zos-vod-player";
            after = [ "local-fs.target" "systemd-tmpfiles-setup.service" ]
              ++ lib.optional cfg.components.api.enable "zos-api.service";
            wants = lib.optional cfg.components.api.enable "zos-api.service";
            environment = { HOME = "/zos/state/vod-player"; }
              // lib.optionalAttrs cfg.integrations.tvMode.enable {
                ZOS_VOD_PLAYER_ENABLED = "1";
                ZOS_VOD_PLAYER_VIDEO_OUTPUT = "wayland";
                XDG_RUNTIME_DIR = "/run/zos-tv";
                WAYLAND_DISPLAY = "wayland-0";
              };
            serviceConfig = {
              Type = "notify";
              NotifyAccess = "main";
              WatchdogSec = "20s";
              WorkingDirectory = "/zos/state/vod-player";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadOnlyPaths = [ "/zos/data" ];
              ReadWritePaths = [ "/run/zos" "/zos/state/vod-player" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              IPAddressDeny = "any";
              MemoryMax = "512M";
              CPUQuota = "150%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.integrations.tvMode.enable {
          zos-tv-prepare = {
            description = "Prepare the ZOS TV runtime";
            partOf = [ "zos-tv.target" ];
            before = [ "zos-tv-weston.service" "zos-tv-chromium.service" "zos-tv-cec.service" ];
            path = runtimePath;
            environment = baseEnvironment;
            serviceConfig = {
              Type = "oneshot";
              ExecStart = "${packageRoot}/scripts/zos-tv-prepare";
              RemainAfterExit = true;
              RuntimeDirectory = "zos-tv";
              RuntimeDirectoryMode = "0700";
              RuntimeDirectoryPreserve = "restart";
              ProtectSystem = "strict";
              ProtectHome = true;
              ReadWritePaths = [ "/run/zos-tv" ];
              NoNewPrivileges = true;
              PrivateTmp = true;
              CapabilityBoundingSet = [ "CAP_CHOWN" "CAP_DAC_OVERRIDE" "CAP_FOWNER" ];
            };
          };
          zos-tv-weston = {
            description = "ZOS TV Weston kiosk compositor";
            partOf = [ "zos-tv.target" ];
            requires = [ "zos-tv-prepare.service" ];
            wants = [ "seatd.service" ];
            after = [ "zos-tv-prepare.service" "seatd.service" ];
            conflicts = [ "getty@tty1.service" ];
            path = runtimePath;
            environment = baseEnvironment // {
              XDG_RUNTIME_DIR = "/run/zos-tv";
              LIBSEAT_BACKEND = "seatd";
              ZOS_TV_SCRIPT_DIR = "${packageRoot}/scripts";
            };
            serviceConfig = hardenedService // {
              ExecStart = "${packageRoot}/scripts/zos-tv-weston";
              SupplementaryGroups = [ "video" "render" "input" "seat" ];
              TimeoutStopSec = "15s";
              TTYPath = "/dev/tty1";
              StandardInput = "tty";
              TTYReset = true;
              TTYVHangup = true;
              TTYVTDisallocate = true;
              ProtectHome = true;
              ReadWritePaths = [ "/run/zos-tv" ];
              PrivateDevices = false;
              DevicePolicy = "closed";
              DeviceAllow = [ "char-drm rw" "char-input r" "/dev/tty1 rw" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              MemoryMax = "256M";
              TasksMax = 128;
            };
          };
          zos-tv-chromium = {
            description = "ZOS TV Chromium shell";
            partOf = [ "zos-tv.target" ];
            requires = [ "zos-tv-weston.service" "zos-api.service" ];
            after = [ "zos-tv-weston.service" "zos-api.service" ];
            path = runtimePath;
            environment = baseEnvironment // {
              HOME = "/zos/state/tv";
              XDG_RUNTIME_DIR = "/run/zos-tv";
              WAYLAND_DISPLAY = "wayland-0";
              ZOS_TV_SCRIPT_DIR = "${packageRoot}/scripts";
            };
            serviceConfig = hardenedService // {
              ExecStart = "${packageRoot}/scripts/zos-tv-chromium";
              TimeoutStopSec = "20s";
              ProtectHome = true;
              ReadWritePaths = [ "/run/zos-tv" "/zos/state/tv" ];
              RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
              IPAddressDeny = "any";
              IPAddressAllow = "localhost";
              MemoryMax = "1G";
              CPUQuota = "250%";
              TasksMax = 512;
            };
          };
          zos-tv-cec = {
            description = "ZOS TV HDMI-CEC remote input";
            partOf = [ "zos-tv.target" ];
            requires = [ "zos-tv-prepare.service" ];
            wants = [ "zos-tv-weston.service" ];
            after = [ "zos-tv-prepare.service" "zos-tv-weston.service" ];
            path = runtimePath;
            environment = baseEnvironment // {
              XDG_RUNTIME_DIR = "/run/zos-tv";
              WAYLAND_DISPLAY = "wayland-0";
              ZOS_TV_SCRIPT_DIR = "${packageRoot}/scripts";
            };
            serviceConfig = hardenedService // {
              ExecStart = "${packageRoot}/scripts/zos-tv-cec";
              SupplementaryGroups = [ "video" "input" ];
              Restart = "always";
              RestartSec = "3s";
              TimeoutStopSec = "10s";
              ProtectHome = true;
              ReadWritePaths = [ "/run/zos-tv" ];
              PrivateDevices = false;
              DevicePolicy = "closed";
              DeviceAllow = [ "char-cec rw" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              MemoryMax = "64M";
              TasksMax = 32;
            };
          };
        })
        (mkIf cfg.components.hostAccessd.enable {
          zos-host-accessd = rustService {
            description = "ZOS restricted host access proxy";
            binary = "zos-host-accessd";
            after = [ "docker.service" "local-fs.target" ];
            wants = [ "docker.service" ];
            environment = {
              ZOS_HOST_ACCESS_RUNTIME_ROOT = "/run/zos/host-access";
              ZOS_DOCKER_SOCKET = "/var/run/docker.sock";
              ZOS_HOST_ACCESS_DOCKER_COMPATIBLE = "0";
            };
            serviceConfig = {
              RuntimeDirectory = "zos/host-access";
              RuntimeDirectoryMode = "0700";
              RuntimeDirectoryPreserve = "restart";
              PrivateDevices = true;
              ProtectHome = true;
              ProtectKernelTunables = true;
              ProtectKernelModules = true;
              ProtectControlGroups = true;
              RestrictAddressFamilies = [ "AF_UNIX" ];
              LockPersonality = true;
              MemoryDenyWriteExecute = true;
              UMask = "0027";
              MemoryMax = "128M";
              CPUQuota = "50%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.components.health.enable {
          zos-health = nodeService {
            description = "ZOS health evaluator";
            workspace = "ops";
            arguments = "health";
            after = [ "local-fs.target" ];
            wantedBy = [ ];
            serviceConfig = {
              Type = "oneshot";
              Restart = "no";
              TimeoutStartSec = "2min";
              ReadWritePaths = [ "/zos/state" "/zos/logs" "/zos/data" "/zos/data/backup" ];
              MemoryMax = "512M";
              CPUQuota = "100%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.components.maintenance.enable {
          zos-maintenance = nodeService {
            description = "ZOS maintenance";
            workspace = "ops";
            arguments = "maintenance";
            after = [ "local-fs.target" ];
            wantedBy = [ ];
            serviceConfig = {
              Type = "oneshot";
              Restart = "no";
              TimeoutStartSec = "2h";
              ReadWritePaths = [ "/zos/state" "/zos/logs" "/zos/data" "/zos/data/backup" ];
              MemoryMax = "512M";
              CPUQuota = "100%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.components.backup.enable {
          zos-backup-daily = nodeService {
            description = "ZOS daily backup";
            workspace = "backup";
            arguments = "run --kind daily";
            after = [ "local-fs.target" ];
            requiresMountsFor = [ "/zos/data" "/zos/data/backup" ];
            wantedBy = [ ];
            serviceConfig = {
              Type = "oneshot";
              Restart = "no";
              ReadWritePaths = [ "/zos/state" "/zos/data" "/zos/data/backup" ];
              MemoryMax = "1G";
              CPUQuota = "250%";
              TasksMax = 256;
            };
          };
          zos-backup-weekly = nodeService {
            description = "ZOS weekly backup";
            workspace = "backup";
            arguments = "run --kind weekly";
            after = [ "local-fs.target" ];
            requiresMountsFor = [ "/zos/data" "/zos/data/backup" ];
            wantedBy = [ ];
            serviceConfig = {
              Type = "oneshot";
              Restart = "no";
              ReadWritePaths = [ "/zos/state" "/zos/data" "/zos/data/backup" ];
              MemoryMax = "1G";
              CPUQuota = "250%";
              TasksMax = 256;
            };
          };
        })
      ];

      systemd.timers = {
        zos-health = mkIf (cfg.components.health.enable && cfg.timers.health.enable) {
          wantedBy = [ "timers.target" ];
          timerConfig = { OnBootSec = "6min"; OnUnitActiveSec = "15min"; Persistent = true; };
        };
        zos-maintenance = mkIf (cfg.components.maintenance.enable && cfg.timers.maintenance.enable) {
          wantedBy = [ "timers.target" ];
          timerConfig = { OnCalendar = "*-*-* 04:30:00"; RandomizedDelaySec = "30min"; Persistent = true; };
        };
        zos-backup-daily = mkIf (cfg.components.backup.enable && cfg.timers.backupDaily.enable) {
          wantedBy = [ "timers.target" ];
          timerConfig = { OnCalendar = "daily"; Persistent = true; };
        };
        zos-backup-weekly = mkIf (cfg.components.backup.enable && cfg.timers.backupWeekly.enable) {
          wantedBy = [ "timers.target" ];
          timerConfig = { OnCalendar = "Sun 03:30"; Persistent = true; };
        };
      };
    }
    {
      services.zos.components.hostAccessd.enable = lib.mkDefault cfg.integrations.docker.enable;
      services.zos.components.vodPlayer.enable = lib.mkDefault cfg.integrations.vodPlayer.enable;
    }
    (mkIf cfg.integrations.tvMode.enable {
      services.seatd.enable = true;
      fonts.packages = with pkgs; [ noto-fonts noto-fonts-cjk-sans noto-fonts-color-emoji ];
      environment.etc."zos/tv-mode/enabled".text = "declarative\n";
      systemd.targets.zos-tv = {
        description = "ZOS TV appliance session";
        wantedBy = [ "multi-user.target" ];
        requires = [
          "zos-tv-prepare.service"
          "zos-tv-weston.service"
          "zos-tv-chromium.service"
          "zos-vod-player.service"
        ];
        wants = [ "zos-tv-cec.service" ];
        after = [
          "zos-api.service"
          "zos-vod-player.service"
          "zos-tv-weston.service"
          "zos-tv-chromium.service"
        ];
        before = [ "display-manager.service" ];
        conflicts = [ "display-manager.service" ];
        unitConfig.AllowIsolate = true;
      };
    })
    (mkIf cfg.integrations.docker.enable {
      virtualisation.docker.enable = true;
    })
    (mkIf cfg.integrations.virtualMachines.enable {
      virtualisation.libvirtd.enable = true;
    })
    (mkIf cfg.components.bluetooth.enable {
      hardware.bluetooth.enable = true;
    })
  ]);
}
