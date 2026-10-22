{ pkgs, self }:

let
  commonSettings = {
    environment = "production";
    root_dir = "/zos";
    api = {
      host = "127.0.0.1";
      port = 3010;
    };
    admin = {
      display_name = "Nix Admin";
      auth_mode = "local-only";
    };
    docker.enabled = false;
    vm.enabled = false;
    monitoring.enabled = false;
    nas_roots = [ ];
  };
  minimalComponents = {
    monitor.enable = false;
    alerter.enable = false;
    indexer.enable = false;
    photostaff.enable = false;
    downloader.enable = false;
    termux.enable = false;
    hostAccessd.enable = false;
    bluetooth.enable = false;
    vodPlayer.enable = false;
    backup.enable = false;
    maintenance.enable = false;
  };
in pkgs.testers.runNixOSTest {
  name = "zos-nixos-module";

  nodes = {
    generated = { ... }: {
      imports = [ self.nixosModules.zos ];
      services.zos = {
        enable = true;
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        settings = commonSettings;
        components = minimalComponents;
        timers.maintenance.enable = false;
        nginx = { enable = true; port = 8080; openFirewall = true; };
      };
      environment.systemPackages = [ pkgs.curl pkgs.python3 pkgs.sqlite ];
    };

    external = { ... }: {
      imports = [ self.nixosModules.zos ];
      environment.etc."zos-external.toml".text = ''
        environment = "production"
        root_dir = "/zos"
        nas_roots = []
        [api]
        host = "127.0.0.1"
        port = 3010
        [admin]
        display_name = "Nix Admin"
        auth_mode = "local-only"
        [docker]
        enabled = false
        [vm]
        enabled = false
        [monitoring]
        enabled = false
      '';
      services.zos = {
        enable = true;
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        configFile = "/etc/zos-external.toml";
        components = minimalComponents;
        timers.maintenance.enable = false;
        nginx = { enable = true; port = 8080; };
      };
      environment.systemPackages = [ pkgs.curl pkgs.python3 pkgs.sqlite ];
    };

    tv = { lib, ... }: {
      imports = [ self.nixosModules.zos ];
      services.zos = {
        enable = true;
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        settings = commonSettings;
        components = minimalComponents // { vodPlayer.enable = true; };
        integrations = {
          vodPlayer.enable = true;
          tvMode.enable = true;
        };
        timers.maintenance.enable = false;
        nginx.enable = false;
      };
      # The VM validates the declarative graph without requiring virtual DRM/CEC hardware.
      systemd.targets.zos-tv.wantedBy = lib.mkForce [ ];
      systemd.services.zos-vod-player.wantedBy = lib.mkForce [ ];
      environment.systemPackages = [ pkgs.curl ];
    };
  };

  testScript = ''
    import json
    import uuid

    start_all()

    for machine in (generated, external):
        machine.wait_for_unit("zos-hostd.service")
        machine.wait_for_unit("zos-api.service")
        machine.wait_for_unit("zos-worker@1.service")
        machine.wait_for_unit("zos-health.timer")
        machine.wait_until_succeeds("curl -fsS http://127.0.0.1:3010/health")
        machine.wait_until_succeeds("curl -fsS http://127.0.0.1:8080/health")
        machine.wait_until_succeeds("curl -fsS http://127.0.0.1:8080/docs/")
        machine.succeed("test $(stat -c '%U:%G:%a' /zos/state) = root:zos:1770")
        machine.succeed("test $(stat -c '%U:%G:%a' /zos/state/hostd) = root:root:755")
        machine.succeed("test $(stat -c '%U:%G:%a' /zos/state/hostd/bluetooth) = root:root:700")
        machine.succeed("test -f /zos/state/zos.sqlite")
        machine.succeed("curl -fsS http://127.0.0.1:3010/api/settings/system-info | grep -F 'Nix Admin'")
        machine.succeed("getent passwd zos | grep -F ':/zos/home/termux:'")
        machine.succeed("systemctl show zos-api.service -p ReadWritePaths --value | tr ' ' '\\n' | grep -Fx /zos/state")
        machine.fail("systemctl show zos-api.service -p ReadWritePaths --value | tr ' ' '\\n' | grep -Fx /zos")
        machine.succeed("systemctl show zos-hostd.service -p ReadWritePaths --value | tr ' ' '\\n' | grep -Fx /zos/data")
        machine.fail("systemctl show zos-hostd.service -p ReadWritePaths --value | tr ' ' '\\n' | grep -Fx /etc")
        machine.succeed("systemctl show zos-hostd.service -p Requires --value | tr ' ' '\\n' | grep -Fx systemd-tmpfiles-setup.service")
        machine.succeed("systemctl show zos-hostd.service -p CapabilityBoundingSet --value | grep -Fi CAP_SYS_ADMIN")

        request = json.dumps({
            "version": 1,
            "id": str(uuid.uuid4()),
            "operation": "network.manager",
            "payload": {"action": "radio", "input": {"enabled": True, "confirmed": True}},
        })
        command = (
            "python3 - <<'PY'\n"
            "import json, socket\n"
            "request = %s\n"
            "client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
            "client.connect('/run/zos/hostd.sock')\n"
            "client.sendall((request + '\\n').encode())\n"
            "client.shutdown(socket.SHUT_WR)\n"
            "response = json.loads(client.makefile().readline())\n"
            "assert response['error']['status'] == 501, response\n"
            "assert response['error']['code'] == 'unsupported', response\n"
            "PY"
        ) % repr(request)
        machine.succeed(command)
        machine.succeed("test ! -e /zos/state/hostd/network-manager")

    generated.succeed("readlink /zos/config/config.toml | grep -F /nix/store/")
    external.succeed("test $(readlink /zos/config/config.toml) = /etc/zos-external.toml")

    tv.wait_for_unit("zos-api.service")
    tv.succeed("test $(cat /etc/zos/host-mutation-policy) = declarative")
    tv.succeed("test $(cat /etc/zos/tv-mode/enabled) = declarative")
    tv.succeed("systemctl show zos-tv.target -p Requires --value | grep -F zos-tv-weston.service")
    tv.succeed("systemctl show zos-tv-prepare.service -p RuntimeDirectoryMode --value | grep -Fx 0700")
    tv.succeed("systemctl show zos-tv-weston.service -p PartOf --value | grep -F zos-tv.target")
    tv.succeed("systemctl show zos-tv-chromium.service -p PartOf --value | grep -F zos-tv.target")
    tv.succeed("systemctl show zos-tv-chromium.service -p User --value | grep -Fx zos")
    tv.succeed("systemctl show zos-vod-player.service -p Environment --value | grep -F ZOS_VOD_PLAYER_VIDEO_OUTPUT=wayland")
    tv.succeed("systemctl show zos-api.service -p Environment --value | grep -F ZOS_VOD_PLAYER_ENABLED=1")
    tv.fail("${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/zos-tv-mode enable")
  '';
}
