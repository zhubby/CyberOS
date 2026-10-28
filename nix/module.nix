{ self }:
{ config, lib, pkgs, ... }:

let
  inherit (lib) mkEnableOption mkIf mkMerge mkOption types;
  cfg = config.services.cyberos;
  toml = pkgs.formats.toml { };
  generatedConfig = toml.generate "cyberos-config.toml" cfg.settings;
  configSource = if cfg.configFile != null then cfg.configFile else toString generatedConfig;
  packageRoot = "${cfg.package}/lib/cyberos";
  node = "${pkgs.nodejs_22}/bin/node";
  baseEnvironment = {
    CYBEROS_ROOT = "/cyberos";
    CYBEROS_CONFIG = "/cyberos/config/config.toml";
    CYBEROS_HOST_MUTATION_POLICY = "declarative";
    CYBEROS_BUILD_INFO_PATH = "${packageRoot}/build-info.json";
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
    User = "cyberos";
    Group = "cyberos";
    WorkingDirectory = "/cyberos/state";
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
    (index: lib.nameValuePair "cyberos-worker@${toString (index + 1)}"
      (nodeService {
        description = "CyberOS agent worker ${toString (index + 1)}";
        workspace = "worker";
        after = [ "cyberos-api.service" ];
        requires = lib.optional cfg.components.api.enable "cyberos-api.service";
        serviceConfig = {
          ReadWritePaths = [ "/cyberos/state" "/cyberos/logs" "/cyberos/data" ];
          MemoryMax = "768M";
          CPUQuota = "200%";
          TasksMax = 256;
        };
      }))
    cfg.workerInstances);
in {
  options.services.cyberos = {
    enable = mkEnableOption "CyberOS NAS appliance services";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "self.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "Combined CyberOS package to run.";
    };

    settings = mkOption {
      type = toml.type;
      default = { };
      description = "Non-secret CyberOS configuration rendered as TOML.";
    };

    configFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/run/secrets/cyberos-config.toml";
      description = "Absolute path to an external, secret-bearing TOML configuration file.";
    };

    workerInstances = mkOption {
      type = types.ints.between 1 64;
      default = 1;
      description = "Number of CyberOS worker service instances.";
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
      enable = mkEnableOption "the CyberOS Nginx reverse proxy" // { default = true; };
      port = mkOption {
        type = types.port;
        default = 80;
        description = "LAN port for the CyberOS reverse proxy.";
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
          message = "services.cyberos.settings and services.cyberos.configFile are mutually exclusive";
        }
        {
          assertion = cfg.configFile == null || lib.hasPrefix "/" cfg.configFile;
          message = "services.cyberos.configFile must be an absolute path";
        }
        {
          assertion = !cfg.components.hostAccessd.enable || cfg.integrations.docker.enable;
          message = "services.cyberos.components.hostAccessd requires services.cyberos.integrations.docker";
        }
        {
          assertion = !cfg.components.vodPlayer.enable || cfg.integrations.vodPlayer.enable;
          message = "services.cyberos.components.vodPlayer requires services.cyberos.integrations.vodPlayer";
        }
        {
          assertion = !cfg.integrations.tvMode.enable || cfg.components.api.enable;
          message = "services.cyberos.integrations.tvMode requires services.cyberos.components.api";
        }
        {
          assertion = !cfg.integrations.tvMode.enable || cfg.components.vodPlayer.enable;
          message = "services.cyberos.integrations.tvMode requires services.cyberos.components.vodPlayer";
        }
        {
          assertion = !cfg.integrations.tvMode.enable || cfg.integrations.vodPlayer.enable;
          message = "services.cyberos.integrations.tvMode requires services.cyberos.integrations.vodPlayer";
        }
      ];

      users.groups.cyberos = { };
      users.users.cyberos = {
        isSystemUser = true;
        group = "cyberos";
        home = "/cyberos/home/termux";
        createHome = true;
        shell = pkgs.bashInteractive;
        extraGroups = lib.optional cfg.integrations.docker.enable "docker"
          ++ lib.optional cfg.integrations.virtualMachines.enable "libvirtd"
          ++ lib.optionals cfg.integrations.vodPlayer.enable [ "audio" "render" "video" ]
          ++ lib.optionals cfg.integrations.tvMode.enable [ "input" "seat" ];
      };

      systemd.tmpfiles.rules = [
        "d /cyberos 0755 root root -"
        "d /cyberos/config 0750 root cyberos -"
        "d /cyberos/config/mcp 0700 cyberos cyberos -"
        "f+ /cyberos/config/host-mutation-policy 0644 root cyberos - declarative"
        "d /cyberos/state 1770 root cyberos -"
        "d /cyberos/logs 0750 cyberos cyberos -"
        "d /cyberos/data 0750 cyberos cyberos -"
        "d /cyberos/apps 0750 cyberos cyberos -"
        "d /cyberos/iso 0750 cyberos cyberos -"
        "d /cyberos/vm 0750 cyberos cyberos -"
        "d /cyberos/backup 0750 cyberos cyberos -"
        "d /cyberos/home 0750 cyberos cyberos -"
        "d /cyberos/home/termux 0750 cyberos cyberos -"
        "d /cyberos/state/bluetooth 0750 cyberos cyberos -"
        "d /cyberos/state/hostd 0755 root root -"
        "d /cyberos/state/hostd/bluetooth 0700 root root -"
        "d /cyberos/state/vod-player 0750 cyberos cyberos -"
        "d /cyberos/state/tv 0750 cyberos cyberos -"
        "d /cyberos/state/tv/chromium 0750 cyberos cyberos -"
        "d /cyberos/system-backups 0750 root root -"
        "d /cyberos/system-backups/permissions 0700 root root -"
        "d /run/cyberos 0770 root cyberos -"
        "L+ /cyberos/config/config.toml - - - - ${configSource}"
      ];

      networking.firewall.allowedTCPPorts = lib.optional
        (cfg.nginx.enable && cfg.nginx.openFirewall)
        cfg.nginx.port;

      services.nginx = mkIf cfg.nginx.enable {
        enable = true;
        virtualHosts.cyberos = {
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
          cyberos-hostd = rustService {
            description = "CyberOS privileged host integration daemon";
            binary = "cyberos-hostd";
            root = true;
            after = [ "local-fs.target" "systemd-tmpfiles-setup.service" ]
              ++ lib.optional cfg.components.bluetooth.enable "bluetooth.service";
            before = [ "network-online.target" ];
            wants = lib.optional cfg.components.bluetooth.enable "bluetooth.service";
            requires = [ "systemd-tmpfiles-setup.service" ];
            serviceConfig = {
              TimeoutStopSec = "180s";
              ReadWritePaths = [
                "/run/cyberos"
                "/cyberos/data"
                "/cyberos/state/hostd/bluetooth"
                "/cyberos/system-backups/permissions"
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
          cyberos-api = nodeService {
            description = "CyberOS API and web UI";
            workspace = "api";
            after = [ "network-online.target" "local-fs.target" ]
              ++ lib.optional cfg.components.hostd.enable "cyberos-hostd.service";
            wants = [ "network-online.target" ];
            environment = {
              CYBEROS_WEB_DIST = "${packageRoot}/apps/web/dist";
              CYBEROS_DOCS_DIST = "${packageRoot}/docs/dist";
            } // lib.optionalAttrs cfg.integrations.tvMode.enable {
              CYBEROS_VOD_PLAYER_ENABLED = "1";
            };
            serviceConfig = {
              ReadWritePaths = [ "/run/cyberos" "/cyberos/state" "/cyberos/logs" "/cyberos/data" "/cyberos/vm" "/cyberos/iso" "/cyberos/apps" "/cyberos/config/mcp" ];
              MemoryMax = "512M";
              CPUQuota = "150%";
              TasksMax = 256;
            };
          };
        })
        (mkIf cfg.components.worker.enable workerServices)
        (mkIf cfg.components.monitor.enable {
          cyberos-monitor = rustService {
            description = "CyberOS metrics collector";
            binary = "cyberos-monitor";
            after = [ "local-fs.target" ] ++ lib.optional cfg.components.api.enable "cyberos-api.service";
            wants = lib.optional cfg.components.api.enable "cyberos-api.service";
            serviceConfig = {
              Type = "notify";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadOnlyPaths = [ "-/cyberos/data" ];
              ReadWritePaths = [ "/run/cyberos" "/cyberos/state" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              MemoryMax = "256M";
              TasksMax = 64;
            };
          };
        })
        (mkIf cfg.components.alerter.enable {
          cyberos-alerter = rustService {
            description = "CyberOS alert evaluator";
            binary = "cyberos-alerter";
            after = [ "network-online.target" "local-fs.target" ]
              ++ lib.optional cfg.components.api.enable "cyberos-api.service"
              ++ lib.optional cfg.components.monitor.enable "cyberos-monitor.service";
            wants = [ "network-online.target" ]
              ++ lib.optional cfg.components.api.enable "cyberos-api.service"
              ++ lib.optional cfg.components.monitor.enable "cyberos-monitor.service";
            serviceConfig = {
              Type = "notify";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadOnlyPaths = [ "-/cyberos/data" ];
              ReadWritePaths = [ "/run/cyberos" "/cyberos/state" ];
              RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
              MemoryMax = "256M";
              TasksMax = 64;
            };
          };
        })
        (mkIf cfg.components.indexer.enable {
          cyberos-indexer = rustService {
            description = "CyberOS NAS indexer";
            binary = "cyberos-indexer";
            after = [ "local-fs.target" ] ++ lib.optional cfg.components.api.enable "cyberos-api.service";
            requiresMountsFor = [ "/cyberos/data" ];
            serviceConfig = {
              Type = "notify";
              WatchdogSec = "20s";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadOnlyPaths = [ "/cyberos/data" ];
              ReadWritePaths = [ "/cyberos/state" "/cyberos/logs" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              MemoryMax = "1G";
              CPUQuota = "250%";
              TasksMax = 256;
            };
          };
        })
        (mkIf cfg.components.photostaff.enable {
          cyberos-photostaff = rustService {
            description = "CyberOS media worker";
            binary = "cyberos-photostaff";
            path = photostaffRuntimePath;
            after = [ "local-fs.target" ] ++ lib.optional cfg.components.api.enable "cyberos-api.service";
            wants = lib.optional cfg.components.api.enable "cyberos-api.service";
            serviceConfig = {
              Type = "notify";
              NotifyAccess = "main";
              WatchdogSec = "20s";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadOnlyPaths = [ "-/cyberos/data" ];
              ReadWritePaths = [ "/cyberos/state" "/cyberos/logs" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              IPAddressDeny = "any";
              MemoryMax = "1G";
              CPUQuota = "250%";
              TasksMax = 256;
            };
          };
        })
        (mkIf cfg.components.downloader.enable {
          cyberos-downloader = rustService {
            description = "CyberOS HTTP downloader";
            binary = "cyberos-downloader";
            after = [ "network-online.target" "local-fs.target" ]
              ++ lib.optional cfg.components.api.enable "cyberos-api.service";
            wants = [ "network-online.target" ];
            requires = lib.optional cfg.components.api.enable "cyberos-api.service";
            requiresMountsFor = [ "/cyberos/data" ];
            serviceConfig = {
              TimeoutStopSec = "30s";
              ReadWritePaths = [ "/cyberos/state" "/cyberos/logs" "/cyberos/data" ];
              MemoryMax = "512M";
              CPUQuota = "150%";
              TasksMax = 256;
            };
          };
        })
        (mkIf cfg.components.termux.enable {
          cyberos-termux = rustService {
            description = "CyberOS terminal daemon";
            binary = "cyberos-termux";
            after = [ "local-fs.target" "systemd-tmpfiles-setup.service" ];
            wants = [ "local-fs.target" ];
            environment = {
              HOME = "/cyberos/home/termux";
              CYBEROS_TERMUX_USER = "cyberos";
              CYBEROS_TERMUX_SOCKET_PATH = "/run/cyberos/termux.sock";
              CYBEROS_TERMUX_SESSION_IDLE_TIMEOUT_MS = "1800000";
              CYBEROS_TERMUX_CONNECT_TIMEOUT_MS = "10000";
              CYBEROS_TERMUX_MAX_SESSIONS = "32";
            };
            serviceConfig = {
              WorkingDirectory = "/cyberos/home/termux";
              KillMode = "process";
              UMask = "0007";
              ProtectHome = "tmpfs";
              ReadWritePaths = [ "/run/cyberos" "/cyberos/data" "/cyberos/home/termux" ];
              InaccessiblePaths = [ "/cyberos/config" "/cyberos/state" "/cyberos/logs" ];
              RestrictSUIDSGID = true;
              MemoryMax = "256M";
              CPUQuota = "100%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.components.bluetooth.enable {
          cyberos-bluetoothd = rustService {
            description = "CyberOS Bluetooth service";
            binary = "cyberos-bluetoothd";
            after = [ "dbus.service" "bluetooth.service" "local-fs.target" ]
              ++ lib.optional cfg.components.api.enable "cyberos-api.service";
            wants = [ "bluetooth.service" ];
            requires = lib.optional cfg.components.api.enable "cyberos-api.service";
            requiresMountsFor = [ "/cyberos/data" ];
            environment = {
              HOME = "/cyberos/state/bluetooth";
              XDG_CACHE_HOME = "/cyberos/state/bluetooth/cache";
            };
            serviceConfig = {
              ExecStart = "${pkgs.dbus}/bin/dbus-run-session -- ${packageRoot}/bin/cyberos-bluetoothd";
              WorkingDirectory = "/cyberos/state/bluetooth";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadWritePaths = [
                "/cyberos/state/bluetooth"
                "/cyberos/state/cyberos.sqlite"
                "-/cyberos/state/cyberos.sqlite-shm"
                "-/cyberos/state/cyberos.sqlite-wal"
              ];
              ReadOnlyPaths = [ "/cyberos/data" ];
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
          cyberos-vod-player = rustService {
            description = "CyberOS VOD player";
            binary = "cyberos-vod-player";
            after = [ "local-fs.target" "systemd-tmpfiles-setup.service" ]
              ++ lib.optional cfg.components.api.enable "cyberos-api.service";
            wants = lib.optional cfg.components.api.enable "cyberos-api.service";
            environment = { HOME = "/cyberos/state/vod-player"; }
              // lib.optionalAttrs cfg.integrations.tvMode.enable {
                CYBEROS_VOD_PLAYER_ENABLED = "1";
                CYBEROS_VOD_PLAYER_VIDEO_OUTPUT = "wayland";
                XDG_RUNTIME_DIR = "/run/cyberos-tv";
                WAYLAND_DISPLAY = "wayland-0";
              };
            serviceConfig = {
              Type = "notify";
              NotifyAccess = "main";
              WatchdogSec = "20s";
              WorkingDirectory = "/cyberos/state/vod-player";
              TimeoutStopSec = "30s";
              KillMode = "control-group";
              ReadOnlyPaths = [ "/cyberos/data" ];
              ReadWritePaths = [ "/run/cyberos" "/cyberos/state/vod-player" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              IPAddressDeny = "any";
              MemoryMax = "512M";
              CPUQuota = "150%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.integrations.tvMode.enable {
          cyberos-tv-prepare = {
            description = "Prepare the CyberOS TV runtime";
            partOf = [ "cyberos-tv.target" ];
            before = [ "cyberos-tv-weston.service" "cyberos-tv-chromium.service" "cyberos-tv-cec.service" "cyberos-tv-gamepad.service" ];
            path = runtimePath;
            environment = baseEnvironment;
            serviceConfig = {
              Type = "oneshot";
              ExecStart = "${packageRoot}/scripts/cyberos-tv-prepare start";
              ExecStop = "${packageRoot}/scripts/cyberos-tv-prepare stop";
              RemainAfterExit = true;
              RuntimeDirectory = "cyberos-tv";
              RuntimeDirectoryMode = "0700";
              RuntimeDirectoryPreserve = "restart";
              ProtectSystem = "strict";
              ProtectHome = true;
              ReadWritePaths = [ "/run/cyberos-tv" "/sys/class/drm" ];
              NoNewPrivileges = true;
              PrivateTmp = true;
              CapabilityBoundingSet = [ "CAP_CHOWN" "CAP_DAC_OVERRIDE" "CAP_FOWNER" ];
            };
          };
          cyberos-tv-weston = {
            description = "CyberOS TV Weston kiosk compositor";
            partOf = [ "cyberos-tv.target" ];
            requires = [ "cyberos-tv-prepare.service" ];
            wants = [ "seatd.service" ];
            after = [ "cyberos-tv-prepare.service" "seatd.service" ];
            conflicts = [ "getty@tty1.service" ];
            path = runtimePath;
            environment = baseEnvironment // {
              XDG_RUNTIME_DIR = "/run/cyberos-tv";
              XDG_CACHE_HOME = "/run/cyberos-tv/cache";
              LIBSEAT_BACKEND = "seatd";
              CYBEROS_TV_SCRIPT_DIR = "${packageRoot}/scripts";
            };
            serviceConfig = hardenedService // {
              ExecStart = "${packageRoot}/scripts/cyberos-tv-weston";
              SupplementaryGroups = [ "video" "render" "input" "seat" ];
              TimeoutStopSec = "15s";
              TTYPath = "/dev/tty1";
              StandardInput = "tty";
              TTYReset = true;
              TTYVHangup = true;
              TTYVTDisallocate = true;
              ProtectHome = true;
              ReadWritePaths = [ "/run/cyberos-tv" ];
              PrivateDevices = false;
              DevicePolicy = "closed";
              DeviceAllow = [ "char-drm rw" "char-input r" "/dev/tty1 rw" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              MemoryMax = "256M";
              TasksMax = 128;
            };
          };
          cyberos-tv-chromium = {
            description = "CyberOS TV Chromium shell";
            partOf = [ "cyberos-tv.target" ];
            requires = [ "cyberos-tv-weston.service" "cyberos-api.service" ];
            after = [ "cyberos-tv-weston.service" "cyberos-api.service" ];
            path = runtimePath;
            environment = baseEnvironment // {
              HOME = "/cyberos/state/tv";
              XDG_RUNTIME_DIR = "/run/cyberos-tv";
              WAYLAND_DISPLAY = "wayland-0";
              CYBEROS_TV_SCRIPT_DIR = "${packageRoot}/scripts";
            };
            serviceConfig = hardenedService // {
              ExecStart = "${packageRoot}/scripts/cyberos-tv-chromium";
              TimeoutStopSec = "20s";
              ProtectHome = true;
              ReadWritePaths = [ "/run/cyberos-tv" "/cyberos/state/tv" ];
              RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
              IPAddressDeny = "any";
              IPAddressAllow = "localhost";
              MemoryMax = "1G";
              CPUQuota = "250%";
              TasksMax = 512;
            };
          };
          cyberos-tv-cec = {
            description = "CyberOS TV HDMI-CEC remote input";
            partOf = [ "cyberos-tv.target" ];
            requires = [ "cyberos-tv-prepare.service" ];
            wants = [ "cyberos-tv-weston.service" ];
            after = [ "cyberos-tv-prepare.service" "cyberos-tv-weston.service" ];
            path = runtimePath;
            environment = baseEnvironment // {
              XDG_RUNTIME_DIR = "/run/cyberos-tv";
              WAYLAND_DISPLAY = "wayland-0";
              CYBEROS_TV_SCRIPT_DIR = "${packageRoot}/scripts";
            };
            serviceConfig = hardenedService // {
              ExecStart = "${packageRoot}/scripts/cyberos-tv-cec";
              SupplementaryGroups = [ "video" "input" ];
              Restart = "always";
              RestartSec = "3s";
              TimeoutStopSec = "10s";
              ProtectHome = true;
              ReadWritePaths = [ "/run/cyberos-tv" ];
              PrivateDevices = false;
              DevicePolicy = "closed";
              DeviceAllow = [ "char-cec rw" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              MemoryMax = "64M";
              TasksMax = 32;
            };
          };
          cyberos-tv-gamepad = {
            description = "CyberOS TV gamepad input";
            partOf = [ "cyberos-tv.target" ];
            requires = [ "cyberos-tv-prepare.service" ];
            wants = [ "cyberos-tv-weston.service" ];
            after = [ "cyberos-tv-prepare.service" "cyberos-tv-weston.service" ];
            path = runtimePath;
            environment = baseEnvironment // {
              XDG_RUNTIME_DIR = "/run/cyberos-tv";
              WAYLAND_DISPLAY = "wayland-0";
              CYBEROS_TV_STATUS_WRITER = "${packageRoot}/scripts/cyberos-tv-write-status";
            };
            serviceConfig = hardenedService // {
              ExecStart = "${packageRoot}/bin/cyberos-tv-gamepad";
              SupplementaryGroups = [ "input" ];
              Restart = "always";
              RestartSec = "3s";
              TimeoutStopSec = "10s";
              ProtectHome = true;
              ReadWritePaths = [ "/run/cyberos-tv" ];
              PrivateDevices = false;
              DevicePolicy = "closed";
              DeviceAllow = [ "char-input r" ];
              RestrictAddressFamilies = [ "AF_UNIX" ];
              MemoryMax = "64M";
              TasksMax = 32;
            };
          };
        })
        (mkIf cfg.components.hostAccessd.enable {
          cyberos-host-accessd = rustService {
            description = "CyberOS restricted host access proxy";
            binary = "cyberos-host-accessd";
            after = [ "docker.service" "local-fs.target" ];
            wants = [ "docker.service" ];
            environment = {
              CYBEROS_HOST_ACCESS_RUNTIME_ROOT = "/run/cyberos/host-access";
              CYBEROS_DOCKER_SOCKET = "/var/run/docker.sock";
              CYBEROS_HOST_ACCESS_DOCKER_COMPATIBLE = "0";
            };
            serviceConfig = {
              RuntimeDirectory = "cyberos/host-access";
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
          cyberos-health = nodeService {
            description = "CyberOS health evaluator";
            workspace = "ops";
            arguments = "health";
            after = [ "local-fs.target" ];
            wantedBy = [ ];
            serviceConfig = {
              Type = "oneshot";
              Restart = "no";
              TimeoutStartSec = "2min";
              ReadWritePaths = [ "/cyberos/state" "/cyberos/logs" "/cyberos/data" "/cyberos/data/backup" ];
              MemoryMax = "512M";
              CPUQuota = "100%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.components.maintenance.enable {
          cyberos-maintenance = nodeService {
            description = "CyberOS maintenance";
            workspace = "ops";
            arguments = "maintenance";
            after = [ "local-fs.target" ];
            wantedBy = [ ];
            serviceConfig = {
              Type = "oneshot";
              Restart = "no";
              TimeoutStartSec = "2h";
              ReadWritePaths = [ "/cyberos/state" "/cyberos/logs" "/cyberos/data" "/cyberos/data/backup" ];
              MemoryMax = "512M";
              CPUQuota = "100%";
              TasksMax = 128;
            };
          };
        })
        (mkIf cfg.components.backup.enable {
          cyberos-backup-daily = nodeService {
            description = "CyberOS daily backup";
            workspace = "backup";
            arguments = "run --kind daily";
            after = [ "local-fs.target" ];
            requiresMountsFor = [ "/cyberos/data" "/cyberos/data/backup" ];
            wantedBy = [ ];
            serviceConfig = {
              Type = "oneshot";
              Restart = "no";
              ReadWritePaths = [ "/cyberos/state" "/cyberos/data" "/cyberos/data/backup" ];
              MemoryMax = "1G";
              CPUQuota = "250%";
              TasksMax = 256;
            };
          };
          cyberos-backup-weekly = nodeService {
            description = "CyberOS weekly backup";
            workspace = "backup";
            arguments = "run --kind weekly";
            after = [ "local-fs.target" ];
            requiresMountsFor = [ "/cyberos/data" "/cyberos/data/backup" ];
            wantedBy = [ ];
            serviceConfig = {
              Type = "oneshot";
              Restart = "no";
              ReadWritePaths = [ "/cyberos/state" "/cyberos/data" "/cyberos/data/backup" ];
              MemoryMax = "1G";
              CPUQuota = "250%";
              TasksMax = 256;
            };
          };
        })
      ];

      systemd.timers = {
        cyberos-health = mkIf (cfg.components.health.enable && cfg.timers.health.enable) {
          wantedBy = [ "timers.target" ];
          timerConfig = { OnBootSec = "6min"; OnUnitActiveSec = "15min"; Persistent = true; };
        };
        cyberos-maintenance = mkIf (cfg.components.maintenance.enable && cfg.timers.maintenance.enable) {
          wantedBy = [ "timers.target" ];
          timerConfig = { OnCalendar = "*-*-* 04:30:00"; RandomizedDelaySec = "30min"; Persistent = true; };
        };
        cyberos-backup-daily = mkIf (cfg.components.backup.enable && cfg.timers.backupDaily.enable) {
          wantedBy = [ "timers.target" ];
          timerConfig = { OnCalendar = "daily"; Persistent = true; };
        };
        cyberos-backup-weekly = mkIf (cfg.components.backup.enable && cfg.timers.backupWeekly.enable) {
          wantedBy = [ "timers.target" ];
          timerConfig = { OnCalendar = "Sun 03:30"; Persistent = true; };
        };
      };
    }
    {
      services.cyberos.components.hostAccessd.enable = lib.mkDefault cfg.integrations.docker.enable;
      services.cyberos.components.vodPlayer.enable = lib.mkDefault cfg.integrations.vodPlayer.enable;
    }
    (mkIf cfg.integrations.tvMode.enable {
      services.seatd.enable = true;
      fonts.packages = with pkgs; [ noto-fonts noto-fonts-cjk-sans noto-fonts-color-emoji ];
      systemd.tmpfiles.rules = [
        "d /cyberos/config/tv-mode 0755 root cyberos -"
        "f+ /cyberos/config/tv-mode/enabled 0644 root cyberos - declarative"
      ];
      systemd.targets.cyberos-tv = {
        description = "CyberOS TV appliance session";
        wantedBy = [ "multi-user.target" ];
        requires = [
          "cyberos-tv-prepare.service"
          "cyberos-tv-weston.service"
          "cyberos-tv-chromium.service"
          "cyberos-vod-player.service"
        ];
        wants = [ "cyberos-tv-cec.service" "cyberos-tv-gamepad.service" ];
        after = [
          "cyberos-api.service"
          "cyberos-vod-player.service"
          "cyberos-tv-weston.service"
          "cyberos-tv-chromium.service"
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
