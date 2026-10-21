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
        machine.succeed("test $(stat -c %U /zos/state) = zos")
        machine.succeed("test $(stat -c %G /zos/state) = zos")
        machine.succeed("test -f /zos/state/zos.sqlite")
        machine.succeed("curl -fsS http://127.0.0.1:3010/api/settings/system-info | grep -F 'Nix Admin'")
        machine.succeed("getent passwd zos | grep -F ':/zos/home/termux:'")
        machine.succeed("systemctl show zos-api.service -p ReadWritePaths --value | tr ' ' '\\n' | grep -Fx /zos/state")
        machine.fail("systemctl show zos-api.service -p ReadWritePaths --value | tr ' ' '\\n' | grep -Fx /zos")
        machine.succeed("systemctl show zos-hostd.service -p ReadWritePaths --value | tr ' ' '\\n' | grep -Fx /zos/data")
        machine.fail("systemctl show zos-hostd.service -p ReadWritePaths --value | tr ' ' '\\n' | grep -Fx /etc")
        machine.succeed("systemctl show zos-hostd.service -p CapabilityBoundingSet --value | grep -F CAP_SYS_ADMIN")

        request = json.dumps({
            "version": 1,
            "id": str(uuid.uuid4()),
            "operation": "network.manager",
            "payload": {"action": "radio", "input": {"enabled": True, "confirmed": True}},
        })
        command = """python3 - <<'PY'
import json, socket
request = %s
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect('/run/zos/hostd.sock')
client.sendall((request + '\\n').encode())
client.shutdown(socket.SHUT_WR)
response = json.loads(client.makefile().readline())
assert response['error']['status'] == 501, response
assert response['error']['code'] == 'unsupported', response
PY""" % repr(request)
        machine.succeed(command)
        machine.succeed("test ! -e /zos/state/hostd/network-manager")

    generated.succeed("readlink /zos/config/config.toml | grep -F /nix/store/")
    external.succeed("test $(readlink /zos/config/config.toml) = /etc/zos-external.toml")
  '';
}
