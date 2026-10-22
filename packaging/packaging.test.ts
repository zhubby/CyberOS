import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const execFileAsync = promisify(execFile);

describe("native packaging artifacts", () => {
  it("uses the offline importNpmLock contract for Nix production builds", async () => {
    const packages = await readFile(path.join(repoRoot, "nix/packages.nix"), "utf8");
    const module = await readFile(path.join(repoRoot, "nix/module.nix"), "utf8");

    expect(packages).toContain("rootNpmDeps = pkgs.importNpmLock {");
    expect(packages).toContain("node22NpmHooks = pkgs.callPackage");
    expect(packages).toContain('{ nodejs = pkgs.nodejs_22; };');
    expect(packages).toContain("npmDeps = rootNpmDeps;");
    expect(packages).toContain("docsNpmDeps = pkgs.importNpmLock {");
    expect(packages).toContain("importNpmLock.npmConfigHook");
    expect(packages).toContain("node22NpmHooks.npmConfigHook");
    expect(packages).not.toContain("importNpmLock.buildNodeModules");
    expect(packages).toContain("rm -rf $out/lib/zos/node_modules/@zos");
    expect(packages).toContain("const Database = require('better-sqlite3')");
    expect(packages).toContain(
      "../../packages/agent/node_modules/@earendil-works/pi-coding-agent"
    );
    expect(packages).toContain("import.meta.resolve('@earendil-works/pi-coding-agent')");
    expect(packages).toContain("nativeBuildInputs = [ pkgs.coreutils pkgs.pkg-config ];");
    expect(packages).toContain("for candidate in target/*/release; do");
    expect(packages).toContain('SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";');
    expect(module).toContain('SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";');
    expect(module).toContain("photostaffRuntimePath = runtimePath ++");
    expect(module).toContain("path = photostaffRuntimePath;");
  });

  it("builds monitor and alerter as independent Rust applications", async () => {
    const workspace = await readFile(path.join(repoRoot, "Cargo.toml"), "utf8");
    const monitor = await readFile(path.join(repoRoot, "crates/monitor/Cargo.toml"), "utf8");
    const alerter = await readFile(path.join(repoRoot, "crates/alerter/Cargo.toml"), "utf8");
    const contracts = await readFile(
      path.join(repoRoot, "crates/monitoring-contracts/Cargo.toml"),
      "utf8"
    );

    expect(workspace).toContain('members = ["crates/*"]');
    expect(monitor).toContain('name = "zos-monitor"');
    expect(monitor).not.toContain('name = "zos-alerter"');
    expect(monitor).not.toContain("lettre.workspace");
    expect(monitor).not.toContain("jiff.workspace");
    expect(alerter).toContain('name = "zos-alerter"');
    expect(alerter).toContain("lettre.workspace");
    expect(alerter).not.toContain("zos-monitor =");
    expect(contracts).not.toContain("tokio.workspace");
    expect(contracts).not.toContain("rusqlite.workspace");
    expect(contracts).toContain("publish = false");
  });

  it("defines hardened systemd services and timers", async () => {
    const serviceNames = [
      "zos-api.service",
      "zos-monitor.service",
      "zos-alerter.service",
      "zos-worker@.service",
      "zos-indexer.service",
      "zos-maintenance.service",
      "zos-backup-daily.service",
      "zos-backup-weekly.service",
      "zos-health.service"
    ];

    for (const serviceName of serviceNames) {
      const unit = await readPackagingFile("systemd", serviceName);
      expect(unit).toContain("User=zos");
      expect(unit).toContain("ProtectSystem=strict");
      expect(unit).toContain("NoNewPrivileges=yes");
      expect(unit).toContain("CapabilityBoundingSet=");
      expect(unit).toContain("ReadWritePaths=/zos/state");
      expect(unit).toContain("Environment=ZOS_ROOT=/zos");
      if (["zos-monitor.service", "zos-alerter.service", "zos-indexer.service"].includes(serviceName)) {
        expect(unit).toContain("ExecStart=/usr/lib/zos/bin/zos-");
      } else {
        expect(unit).toContain("ExecStart=/usr/local/bin/node");
        expect(unit).not.toContain("ExecStart=/usr/bin/node");
      }
      expect(unit).not.toContain("RuntimeDirectory=zos");
    }

    await expect(readPackagingFile("systemd", "zos-api.service")).resolves.toContain(
      "After=network-online.target local-fs.target"
    );
    const monitorUnit = await readPackagingFile("systemd", "zos-monitor.service");
    expect(monitorUnit).toContain("After=local-fs.target zos-api.service");
    expect(monitorUnit).toContain("Type=notify");
    expect(monitorUnit).toContain("ExecStart=/usr/lib/zos/bin/zos-monitor");
    expect(monitorUnit).toContain("ReadOnlyPaths=-/zos/data");
    expect(monitorUnit).toContain("ReadWritePaths=/zos/state");
    expect(monitorUnit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(monitorUnit).toContain("MemoryMax=256M");
    expect(monitorUnit).toContain("CPUWeight=20");
    expect(monitorUnit).toContain("IOWeight=20");
    const alerterUnit = await readPackagingFile("systemd", "zos-alerter.service");
    expect(alerterUnit).toContain("After=network-online.target local-fs.target zos-api.service zos-monitor.service");
    expect(alerterUnit).toContain("Wants=network-online.target zos-api.service zos-monitor.service");
    expect(alerterUnit).not.toContain("Requires=zos-monitor.service");
    expect(alerterUnit).toContain("Type=notify");
    expect(alerterUnit).toContain("ExecStart=/usr/lib/zos/bin/zos-alerter");
    expect(alerterUnit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    expect(alerterUnit).toContain("MemoryMax=256M");
    await expect(readPackagingFile("systemd", "zos-downloader.service")).resolves.toContain(
      "RequiresMountsFor=/zos/data"
    );
    await expect(readPackagingFile("systemd", "zos-downloader.service")).resolves.toContain(
      "ExecStart=/usr/lib/zos/bin/zos-downloader"
    );
    await expect(readPackagingFile("systemd", "zos-downloader.service")).resolves.toContain(
      "TimeoutStopSec=30"
    );
    await expect(readPackagingFile("systemd", "zos-downloader.service")).resolves.toContain(
      "User=zos"
    );
    await expect(readPackagingFile("systemd", "zos-downloader.service")).resolves.toContain(
      "Environment=ZOS_ROOT=/zos"
    );
    await expect(readPackagingFile("systemd", "zos-downloader.service")).resolves.toContain(
      "ProtectSystem=strict"
    );
    await expect(readPackagingFile("systemd", "zos-downloader.service")).resolves.toContain(
      "NoNewPrivileges=yes"
    );
    await expect(readPackagingFile("systemd", "zos-hostd.service")).resolves.toContain(
      "After=local-fs.target systemd-tmpfiles-setup.service NetworkManager.service"
    );
    await expect(readPackagingFile("systemd", "zos-hostd.service")).resolves.toContain(
      "Before=network-online.target"
    );
    const vodPlayerUnit = await readPackagingFile("systemd", "zos-vod-player.service");
    expect(vodPlayerUnit).toContain("ExecStart=/usr/lib/zos/bin/zos-vod-player");
    expect(vodPlayerUnit).toContain("Type=notify");
    expect(vodPlayerUnit).toContain("WatchdogSec=20s");
    expect(vodPlayerUnit).toContain("TimeoutStopSec=30s");
    expect(vodPlayerUnit).toContain("ProtectSystem=strict");
    expect(vodPlayerUnit).toContain("/zos/state/zos.sqlite-wal");
    expect(vodPlayerUnit).toContain("Wants=zos-api.service bluetooth.service bluealsa.service");
    expect(vodPlayerUnit).not.toContain("RequiresMountsFor=/zos/data");
    const tvTarget = await readPackagingFile("systemd", "zos-tv.target");
    expect(tvTarget).toContain("Requires=zos-tv-prepare.service zos-tv-weston.service zos-tv-chromium.service zos-vod-player.service");
    expect(tvTarget).toContain("Conflicts=display-manager.service");
    const tvPrepare = await readPackagingFile("systemd", "zos-tv-prepare.service");
    expect(tvPrepare).toContain("PartOf=zos-tv.target");
    expect(tvPrepare).toContain("RuntimeDirectoryMode=0700");
    const tvWeston = await readPackagingFile("systemd", "zos-tv-weston.service");
    expect(tvWeston).toContain("PartOf=zos-tv.target");
    expect(tvWeston).toContain("User=zos");
    expect(tvWeston).toContain("DeviceAllow=char-drm rw");
    expect(tvWeston).toContain("DeviceAllow=char-input r");
    const tvChromium = await readPackagingFile("systemd", "zos-tv-chromium.service");
    expect(tvChromium).toContain("PartOf=zos-tv.target");
    expect(tvChromium).toContain("IPAddressAllow=localhost");
    expect(tvChromium).not.toContain("--no-sandbox");
    await expect(readPackagingFile("systemd", "zos-tv-cec.service")).resolves.toContain("PartOf=zos-tv.target");
    await expect(readPackagingFile("scripts", "zos-tv-prepare")).resolves.toContain("install -d -m 0700");
    const mpvInput = await readPackagingFile("etc", "mpv-input.conf");
    expect(mpvInput).toContain("LEFT seek -10 relative+exact");
    expect(mpvInput).toContain("UP cycle aid");
    expect(mpvInput).toContain("DOWN cycle sid");
    expect(mpvInput).toContain("ENTER cycle pause");
    expect(mpvInput).toContain("ESC quit");
    const bluetoothUnit = await readPackagingFile("systemd", "zos-bluetoothd.service");
    expect(bluetoothUnit).toContain("User=zos");
    expect(bluetoothUnit).toContain("ExecStart=/usr/bin/dbus-run-session -- /usr/lib/zos/bin/zos-bluetoothd");
    expect(bluetoothUnit).toContain("RequiresMountsFor=/zos/data");
    expect(bluetoothUnit).toContain("ReadWritePaths=/zos/state/bluetooth");
    expect(bluetoothUnit).toContain("ReadOnlyPaths=/zos/data");
    expect(bluetoothUnit).not.toMatch(/ReadWritePaths=.*(?:^|\s)\/zos\/data(?:\s|$)/mu);
    expect(bluetoothUnit).toContain("RestrictAddressFamilies=AF_UNIX AF_BLUETOOTH");
    expect(bluetoothUnit).toContain("CapabilityBoundingSet=");
    const photostaffUnit = await readPackagingFile("systemd", "zos-photostaff.service");
    expect(photostaffUnit).toContain("ExecStart=/usr/lib/zos/bin/zos-photostaff");
    expect(photostaffUnit).toContain("Type=notify");
    expect(photostaffUnit).toContain("WatchdogSec=20s");
    expect(photostaffUnit).toContain("TimeoutStopSec=30s");
    expect(photostaffUnit).toContain("KillMode=control-group");
    expect(photostaffUnit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(photostaffUnit).not.toContain("RequiresMountsFor=/zos/data");
    await expect(readPackagingFile("systemd", "zos-photo-worker.service")).rejects.toMatchObject({ code: "ENOENT" });

    const maintenanceUnit = await readPackagingFile("systemd", "zos-maintenance.service");
    expect(maintenanceUnit).toContain("ExecStart=/usr/local/bin/node /usr/lib/zos/apps/ops/dist/index.js maintenance");
    expect(maintenanceUnit).toContain("TimeoutStartSec=2h");
    expect(maintenanceUnit).not.toContain("RequiresMountsFor=");
    const maintenanceTimer = await readPackagingFile("systemd", "zos-maintenance.timer");
    expect(maintenanceTimer).toContain("OnCalendar=*-*-* 04:30:00");
    expect(maintenanceTimer).toContain("RandomizedDelaySec=30min");
    expect(maintenanceTimer).toContain("Persistent=true");
    const indexerUnit = await readPackagingFile("systemd", "zos-indexer.service");
    expect(indexerUnit).toContain("Type=notify");
    expect(indexerUnit).toContain("WatchdogSec=20s");
    expect(indexerUnit).toContain("Restart=on-failure");
    expect(indexerUnit).toContain("ReadOnlyPaths=/zos/data");
    expect(indexerUnit).toContain("MemoryMax=1G");
    expect(indexerUnit).toContain("KillMode=control-group");
    await expect(readPackagingFile("systemd", "zos-indexer.timer")).rejects.toMatchObject({ code: "ENOENT" });
    const healthUnit = await readPackagingFile("systemd", "zos-health.service");
    expect(healthUnit).toContain("ExecStart=/usr/local/bin/node /usr/lib/zos/apps/ops/dist/index.js health");
    expect(healthUnit).toContain("TimeoutStartSec=2min");
    const healthTimer = await readPackagingFile("systemd", "zos-health.timer");
    expect(healthTimer).toContain("OnBootSec=6min");
    expect(healthTimer).toContain("OnUnitActiveSec=15min");
    expect(healthTimer).toContain("RandomizedDelaySec=2min");
    expect(healthTimer).toContain("Persistent=true");
    await expect(readPackagingFile("systemd", "zos-scheduler.service")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readPackagingFile("systemd", "zos-scheduler.timer")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readPackagingFile("debian", "postinst")).resolves.toContain("zos-refresh-groups.sh");
    await expect(readPackagingFile("scripts", "zos-refresh-groups.sh")).resolves.toContain("optional-groups.conf");
    await expect(readPackagingFile("scripts", "zos-refresh-groups.sh")).resolves.toContain("kvm");
    await expect(readPackagingFile("scripts", "zos-refresh-groups.sh")).resolves.toContain(
      "org.libvirt.unix.manage"
    );
    await expect(readPackagingFile("debian", "postrm")).resolves.toContain(
      "49-zos-libvirt.rules"
    );
    await expect(readPackagingFile("systemd", "zos-api.service")).resolves.toContain(
      "BindReadOnlyPaths=-/run/libvirt/libvirt-sock"
    );
    await expect(readPackagingFile("systemd", "zos-backup-daily.service")).resolves.toContain("LoadCredential=restic-password");
    await expect(readPackagingFile("systemd", "zos-backup-daily.service")).resolves.toContain("ConditionPathExists=/zos/config/restic-password");
    await expect(readPackagingFile("systemd", "zos-backup-weekly.service")).resolves.toContain("ConditionPathExists=/zos/config/restic-password");
    await expect(readPackagingFile("systemd", "zos-backup-weekly.timer")).resolves.toContain("OnCalendar=Sun");
  });

  it("declares Debian install paths required by the spec", async () => {
    const install = await readPackagingFile("debian", "install");
    const links = await readPackagingFile("debian", "links");
    const maintscript = await readPackagingFile("debian", "zos.maintscript");
    const control = await readPackagingFile("debian", "control");
    const tmpfiles = await readPackagingFile("tmpfiles.d", "zos.conf");

    expect(install).toContain("usr/lib/zos/apps/api/dist/");
    expect(install).toContain("target/release/zos-monitor usr/lib/zos/bin/");
    expect(install).toContain("target/release/zos-alerter usr/lib/zos/bin/");
    expect(install).not.toContain("crates/monitor/dist/");
    expect(install).toContain("target/release/zos-hostd usr/lib/zos/bin/");
    expect(install).toContain("target/release/zos-host-accessd usr/lib/zos/bin/");
    expect(install).toContain("target/release/zos-termux usr/lib/zos/bin/");
    expect(install).not.toContain("packages/terminal-helper");
    expect(install).toContain("usr/lib/zos/apps/worker/dist/");
    expect(install).toContain("target/release/zos-photostaff usr/lib/zos/bin/");
    expect(install).not.toContain("packages/photo-worker");
    expect(install).not.toContain("crates/photostaff/dist/");
    expect(install).toContain("target/release/zos-indexer usr/lib/zos/bin/");
    expect(install).not.toContain("crates/indexer/dist/");
    expect(install).toContain("usr/lib/zos/apps/backup/dist/");
    expect(install).toContain("usr/lib/zos/apps/ops/dist/");
    expect(install).not.toContain("packages/scheduler");
    expect(install).toContain("target/release/zos-vod-player usr/lib/zos/bin/");
    expect(install).toContain("packaging/scripts/zos-tv-mode usr/lib/zos/scripts/");
    expect(install).toContain("packaging/systemd/*.target lib/systemd/system/");
    expect(install).toContain("target/release/zos-bluetoothd usr/lib/zos/bin/");
    expect(install).not.toContain("packages/player-helper");
    expect(install).toContain("target/release/zos-downloader usr/lib/zos/bin/");
    expect(install).not.toContain("crates/downloader/dist/");
    expect(install).toContain("node_modules/* usr/lib/zos/node_modules/");
    expect(install).toContain(
      "packages/agent/node_modules/* usr/lib/zos/packages/agent/node_modules/"
    );
    expect(links).toContain(
      "usr/lib/zos/packages/agent/node_modules/@earendil-works/pi-coding-agent usr/lib/zos/node_modules/@earendil-works/pi-coding-agent"
    );
    expect(maintscript).toContain(
      "dir_to_symlink /usr/lib/zos/node_modules/@earendil-works/pi-coding-agent ../../packages/agent/node_modules/@earendil-works/pi-coding-agent 0.9.17~"
    );
    expect(links).not.toContain("zos-photo-worker.service");
    expect(install).toContain("docs/dist/* usr/lib/zos/docs/dist/");
    expect(install).toContain(".zos/build-info.json usr/lib/zos/");
    expect(install).not.toContain("docs/node_modules");
    await expect(readPackagingFile("systemd", "zos-api.service")).resolves.toContain(
      "Environment=ZOS_DOCS_DIST=/usr/lib/zos/docs/dist"
    );
    await expect(readPackagingFile("systemd", "zos-api.service")).resolves.toContain(
      "Environment=ZOS_BUILD_INFO_PATH=/usr/lib/zos/build-info.json"
    );
    await expect(readPackagingFile("systemd", "zos-api.service")).resolves.toContain(
      "ReadWritePaths=/zos/state /zos/logs /zos/data /zos/vm /zos/iso /zos/apps"
    );
    const hostAccessUnit = await readPackagingFile("systemd", "zos-host-accessd.service");
    expect(hostAccessUnit).toContain("User=zos");
    expect(hostAccessUnit).toContain("SupplementaryGroups=docker");
    expect(hostAccessUnit).toContain("ZOS_HOST_ACCESS_DOCKER_COMPATIBLE=0");
    expect(hostAccessUnit).toContain("RuntimeDirectoryPreserve=restart");
    expect(hostAccessUnit).toContain("NoNewPrivileges=yes");
    expect(install).toContain("packaging/scripts/zos-nginx.sh usr/lib/zos/scripts/");
    expect(install).toContain("packaging/scripts/zos-configure-locale.sh usr/lib/zos/scripts/");
    expect(install).toContain("packaging/scripts/zos-refresh-termux.sh usr/lib/zos/scripts/");
    expect(install).toContain("packaging/scripts/zos-nas-acl.sh usr/lib/zos/scripts/");
    expect(install).toContain("packaging/scripts/zos-share-acl.mjs usr/lib/zos/scripts/");
    expect(install).toContain("packaging/etc/samba.conf usr/share/zos/");
    expect(install).toContain("packaging/systemd/smbd.service.d/zos.conf lib/systemd/system/smbd.service.d/");
    expect(install).toContain("packaging/systemd/vsftpd.service.d/zos.conf lib/systemd/system/vsftpd.service.d/");
    expect(install).toContain("packaging/systemd/minidlna.service.d/zos.conf lib/systemd/system/minidlna.service.d/");
    expect(install).toContain("packaging/scripts/zos-refresh-vod-player.sh usr/lib/zos/scripts/");
    expect(install).toContain("packaging/scripts/zos-deploy-bootstrap.sh usr/lib/zos/scripts/");
    expect(install).toContain("packaging/scripts/zos-deploy usr/lib/zos/scripts/");
    expect(install).toContain("packages/mcp-cli/dist/* usr/lib/zos/apps/mcp-cli/dist/");
    expect(install).toContain("packaging/scripts/zos-mcp usr/lib/zos/scripts/");
    expect(install).toContain("packaging/nginx/zos.conf usr/share/zos/nginx/");
    expect(install).toContain("packaging/etc/config.toml zos/config/");
    expect(install).toContain("lib/systemd/system/");
    expect(install).toContain("tmpfiles.d/zos.conf");
    expect(tmpfiles).toContain("/run/zos");
    expect(tmpfiles).toContain("/run/mdadm");
    expect(tmpfiles).toContain("d /run/samba 0755 root root -");
    expect(control).toContain("Depends: nodejs (>= 20), sqlite3, tmux, util-linux, acl, adduser, openssl, network-manager, wpasupplicant, dnsmasq-base, wireless-regdb, iw, bluez");
    expect(control).toMatch(/^Depends:.*poppler-utils.*tesseract-ocr-chi-sim.*tesseract-ocr-eng/m);
    expect(control).toMatch(/^Depends:.*libheif-examples/m);
    expect(control).not.toContain("Recommends: libheif-examples");
    expect(control).toContain("Build-Depends: debhelper-compat (= 13), nodejs, npm, cargo, rustc, acl");
    expect(control).toMatch(/^Depends:.*bluez-obexd.*bluez-alsa-utils.*libasound2-plugin-bluez.*dbus-user-session/m);
    expect(control).toContain("mpv");
    expect(control).toContain("libheif-examples");
    expect(control).toContain("libimage-exiftool-perl");
    expect(control).toContain("libvips-tools");
    expect(control).toMatch(/^Depends:.*ffmpeg.*libraw-bin/m);
    expect(control).toMatch(/^Depends:.*chromium.*weston.*mpv.*v4l-utils.*wtype/m);
    expect(control).not.toMatch(/^Suggests:.*ffmpeg/m);
    expect(control).toContain("Suggests:");
    expect(control).toContain("git");
    expect(control).toContain("ffmpeg");
    expect(control).toContain("samba");
    expect(control).toContain("nfs-kernel-server");
    expect(control).toContain("minidlna");
    expect(control).toContain("restic");
    expect(control).toContain("nginx");
    expect(control).not.toMatch(/^Depends:.*samba/m);
    const postrm = await readPackagingFile("debian", "postrm");
    const postinst = await readPackagingFile("debian", "postinst");
    const defaultConfig = await readPackagingFile("etc", "config.toml");
    const refreshVodPlayer = await readPackagingFile("scripts", "zos-refresh-vod-player.sh");
    expect(postinst).toContain("zos-migrate-sigmaos.sh apply");
    expect(postinst).toContain("ZOS_DEPLOY_USER=sigmaos-deploy");
    expect(postinst).toContain("install -d -o root -g zos -m 0751 /zos");
    expect(postinst).toContain("install -d -o root -g zos -m 0750 /zos/config");
    expect(postinst).toContain("ln -sfn /usr/lib/zos/scripts/zos-mcp /usr/local/sbin/zos-mcp");
    expect(postinst).toContain("ln -sfn /usr/lib/zos/scripts/zos-tv-mode /usr/local/sbin/zos-tv-mode");
    expect(postinst).toContain("/zos/state/tv/control");
    expect(postinst).not.toContain("install -d -o root -g zos -m 0755 /zos");
    expect(postinst).toContain("/zos/state/hostd/docker-daemon");
    expect(postinst).toContain("/zos/state/hostd/network-manager");
    expect(postinst).toContain("/zos/state/bluetooth");
    expect(defaultConfig).toContain("[monitoring]");
    expect(defaultConfig).toContain("[mcp]");
    expect(defaultConfig).toContain("external_enabled = false");
    expect(defaultConfig).toContain("max_database_bytes = 536870912");
    expect(refreshVodPlayer).toContain("ZOS_VOD_PLAYER_SOCKET_PATH");
    expect(refreshVodPlayer).toContain("ZOS_VOD_PLAYER_STATE_PATH");
    expect(refreshVodPlayer).toContain("ReadWritePaths=");
    expect(refreshVodPlayer).toContain("private temporary directory");
    expect(refreshVodPlayer).toContain("state path must be under /zos/state/vod-player");
    expect(refreshVodPlayer).not.toContain("ZOS_ENABLE_PLAYER");
    expect(postrm.indexOf("optional-groups.conf")).toBeLessThan(postrm.indexOf("systemctl daemon-reload"));
    expect(postrm).toContain("zos-termux.service.d/identity.conf");
    expect(postrm).toContain("zos-vod-player.service.d/identity.conf");
    expect(postrm).toContain("zos-vod-player.service.d/50-zos-tv-mode.conf");
    await expect(readPackagingFile("debian", "prerm")).resolves.toContain("zos-tv-mode disable");
  });

  it("ships first-boot and appliance image scaffolding", async () => {
    const firstBoot = await readPackagingFile("scripts", "zos-first-boot.sh");
    const manifest = await readPackagingFile("appliance", "manifest.toml");
    const buildImage = await readPackagingFile("appliance", "build-image.sh");

    expect(firstBoot).toContain("ZOS_ADMIN_DISPLAY_NAME");
    expect(firstBoot).toContain("ZOS_DOCKER_ENABLED");
    expect(firstBoot).toContain("ZOS_VM_ENABLED");
    expect(firstBoot).toContain("ZOS_VOD_PLAYER_ENABLED");
    expect(firstBoot).toContain("[vod_player]");
    expect(firstBoot).toContain("ZOS_TERMUX_USER");
    expect(firstBoot).not.toContain("chown -R zos:zos");
    expect(firstBoot).toContain('environment = "production"');
    expect(firstBoot).toContain('chown -R root:root "$STATE_DIR/hostd"');
    expect(firstBoot).toContain("[[nas_roots]]");
    expect(firstBoot).toContain("[model]");
    expect(firstBoot).toContain("[hostd]");
    expect(firstBoot).toContain("[monitoring]");
    expect(firstBoot).toContain("[shares]");
    expect(firstBoot).toContain('[ -e "$CONFIG_PATH" ]');
    expect(firstBoot).toContain('ZOS_FIRST_BOOT_FORCE:-0');
    expect(manifest).toContain("nodejs");
    expect(manifest).toContain("sqlite3");
    expect(manifest).toContain("tmux");
    expect(manifest).toContain("nginx");
    expect(manifest).toContain("docker-cli");
    expect(manifest).toContain("nginx.service");
    expect(manifest).toContain("git");
    expect(manifest).toContain("zos-hostd.service");
    expect(manifest).toContain("zos-monitor.service");
    expect(manifest).toContain("zos-alerter.service");
    expect(manifest).not.toContain("zos-share-helper.service");
    expect(manifest).toContain("zos-termux.service");
    expect(manifest).not.toContain("zos-terminal-helper.service");
    expect(manifest).toContain("zos-downloader.service");
    expect(manifest).toContain("zos-photostaff.service");
    expect(manifest).toContain("zos-vod-player.service");
    expect(manifest).toContain("zos-tv.target");
    expect(manifest).toContain("zos-tv-weston.service");
    expect(manifest).toContain("zos-bluetoothd.service");
    expect(manifest).not.toContain("zos-player-helper.service");
    expect(manifest).toContain("mpv");
    expect(manifest).toContain("chromium");
    expect(manifest).toContain("weston");
    expect(manifest).toContain("wtype");
    expect(manifest).toContain("samba");
    expect(buildImage).toMatch(/--include=.*(^|,)git(,|\\|\s)/s);
    expect(buildImage).toMatch(/--include=.*(^|,)samba(,|\\|\s)/s);
    expect(buildImage).toMatch(/--include=.*(^|,)bluez(,|\\|\s)/s);
    expect(buildImage).toMatch(/--include=.*(^|,)bluez-obexd(,|\\|\s)/s);
    expect(buildImage).toContain("bluez-alsa-utils");
    expect(buildImage).toContain("libasound2-plugin-bluez");
    expect(buildImage).toContain("dbus-user-session");
    expect(buildImage).toContain("ZOS_ENABLE_TV_MODE");
    expect(buildImage).toContain("systemctl enable zos-tv.target");
    expect(manifest).toContain("tesseract-ocr");
    expect(manifest).toContain("tesseract-ocr-chi-sim");
    expect(manifest).toContain("tesseract-ocr-eng");
    expect(manifest).toContain("zos-indexer.service");
    expect(manifest).not.toContain("zos-indexer.timer");
    expect(manifest).toContain("libheif-examples");
    expect(manifest).toContain("libimage-exiftool-perl");
    expect(manifest).toContain("libvips-tools");
    expect(manifest).toContain("ffmpeg");
    expect(manifest).toContain("libraw-bin");
    expect(buildImage).toContain("libheif-examples");
    expect(buildImage).toContain("libimage-exiftool-perl");
    expect(buildImage).toContain("libvips-tools");
    expect(buildImage).toContain("ffmpeg");
    expect(buildImage).toContain("libraw-bin");
    expect(manifest).toContain("mdadm");
    expect(manifest).toContain("btrfs-progs");
    expect(manifest).toContain("smartmontools");
    expect(buildImage).toContain("btrfs-progs");
    expect(manifest).toContain("unzip");
    expect(manifest).toContain("unrar-free");
    expect(manifest).toContain("zos-maintenance.timer");
    expect(manifest).not.toContain("zos-scheduler");
    expect(manifest).toContain("zos-backup-daily.timer");
    expect(manifest).toContain("zos-backup-weekly.timer");
    expect(manifest).toContain("zos-health.timer");
    expect(buildImage).toContain("zos-backup-daily.timer");
    expect(buildImage).toContain("zos-backup-weekly.timer");
    expect(buildImage).toContain("zos-health.timer");
    expect(buildImage).toContain("zos-monitor.service");
    expect(buildImage).toContain("zos-alerter.service");
    expect(buildImage).not.toContain("zos-scheduler");
    expect(buildImage).toContain("zos-nginx.sh");
    expect(buildImage).toContain("ZOS_NODE_MIRROR");
    expect(buildImage).toContain("SHASUMS256.txt");
    expect(buildImage).toContain("/usr/local/bin/node");
    expect(buildImage).toContain("PRODUCT_VERSION");
    expect(buildImage).not.toContain("zos_0.1.0");
    expect(firstBoot).toContain('password_file = "$ROOT_DIR/config/restic-password"');
    expect(firstBoot).not.toContain("restic-password\" =");
    await expect(readPackagingFile("systemd", "zos-share-helper.service")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an existing first-boot configuration", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-first-boot-"));
    const configPath = path.join(tempDir, "config.toml");
    const sentinel = "# operator-owned configuration\n";
    await writeFile(configPath, sentinel);

    try {
      await execFileAsync("sh", [path.join(repoRoot, "packaging/scripts/zos-first-boot.sh")], {
        env: { ...process.env, ZOS_CONFIG: configPath }
      });
      await expect(readFile(configPath, "utf8")).resolves.toBe(sentinel);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ships an ARM-friendly host installer", async () => {
    const installer = await readPackagingFile("scripts", "install.sh");
    const localeScript = await readPackagingFile("scripts", "zos-configure-locale.sh");
    const buildDeb = await readPackagingFile("scripts", "build-deb.sh");
    const rules = await readPackagingFile("debian", "rules");
    const control = await readPackagingFile("debian", "control");
    const postinst = await readPackagingFile("debian", "postinst");
    const firstBoot = await readPackagingFile("scripts", "zos-first-boot.sh");
    const releaseWorkflow = await readRepoFile(".github", "workflows", "package-release.yml");
    const deployWorkflow = await readRepoFile(".github", "workflows", "deploy-cm5.yml");
    const migrationPreflight = await readRepoFile(".github", "workflows", "cm5-migration-preflight.yml");

    expect(installer).toContain("dpkg --print-architecture");
    expect(installer).toContain("ZOS_APT_MIRROR");
    expect(installer).toContain("ZOS_APT_SECURITY_MIRROR");
    expect(installer).toContain("ZOS_RPI_MIRROR");
    expect(installer).toContain("ZOS_NODE_MIRROR");
    expect(installer).toContain("mirrors.aliyun.com/nodejs-release");
    expect(installer).toContain("SHASUMS256.txt");
    expect(installer).toContain("ZOS_NPM_REGISTRY");
    expect(installer).toContain("ZOS_RUSTUP_INIT_URL");
    expect(installer).toContain("RUST_VERSION_REQUIRED=1.95.0");
    expect(installer).toContain("ZOS_APT_BACKUP_DIR");
    expect(installer).toContain("/zos/system-backups/apt");
    expect(installer).toContain("ZOS_APT_BACKUP_DIR must be under /zos/system-backups");
    expect(localeScript).toContain("ZOS_CONFIG_BACKUP_DIR must be under /zos/system-backups");
    expect(installer).toContain("mirrors.aliyun.com/debian");
    expect(installer).toContain("mirrors.aliyun.com/raspberrypi");
    expect(installer).toContain("disable_nodesource_sources");
    expect(installer).not.toContain("deb.nodesource.com/node_22.x");
    expect(installer).toContain("packaging/scripts/build-deb.sh");
    expect(installer).toContain("zos-first-boot.sh");
    expect(installer).toContain("ZOS_CONFIG_EXISTS=0");
    expect(installer).toContain("[ -e /zos/config/config.toml ]");
    expect(installer).toContain('if [ "$ZOS_CONFIG_EXISTS" = "0" ]; then');
    expect(installer).not.toContain("ZOS_EXISTING_INSTALL");
    expect(installer).toContain("ZOS_ENABLE_NGINX");
    expect(installer).toContain("ZOS_ENABLE_DOCKER");
    expect(installer).toContain("docker-cli");
    expect(installer).toContain("ZOS_ENABLE_VM");
    expect(installer).toContain("TERMINAL_USER=${ZOS_TERMUX_USER:-zos}");
    expect(installer).not.toContain("${SUDO_USER:-}");
    expect(installer).toContain("ZOS_LOCALE");
    expect(localeScript).toContain("AcceptEnv");
    expect(localeScript).toContain("LC_*");
    expect(localeScript).toContain("C.UTF-8");
    expect(installer).toContain("Acquire::ForceIPv4=true");
    expect(installer).toContain("Acquire::http::Timeout=30");
    expect(installer).toContain("Acquire::https::Timeout=30");
    expect(installer).toContain("--force-confold");
    expect(installer).toContain("--reinstall");
    expect(installer).toContain("qemu-system-arm");
    expect(installer).toContain("qemu-efi-aarch64");
    expect(installer).toContain("ipxe-qemu");
    expect(installer).toContain("net-autostart default");
    expect(installer).toContain("net-start default");
    expect(installer).toContain("libvirt-daemon-system");
    expect(installer).toContain("zos-nginx.sh");
    expect(installer).toContain("systemctl restart nginx");
    expect(installer).toContain("systemctl enable --now");
    expect(installer).toContain("systemctl restart zos-monitor.service");
    expect(installer).toContain("systemctl restart zos-alerter.service");
    expect(installer).toContain("systemctl start zos-health.service");
    expect(buildDeb).toContain("registry.npmmirror.com");
    expect(buildDeb).toContain("ZOS_BUILD_COMMIT_SHA");
    expect(buildDeb).toContain("ZOS_BUILD_DIRTY");
    expect(buildDeb).toContain("ZOS_BUILD_SOURCE");
    expect(buildDeb).toContain("--exclude target");
    expect(rules).toContain("npm ci --registry");
    expect(rules).toContain("rm -rf debian/zos/usr/lib/zos/node_modules/@zos");
    expect(rules).toContain("override_dh_strip:");
    expect(rules).toContain("dh_strip --exclude=.bare");
    expect(rules).toContain("override_dh_shlibdeps:");
    expect(rules).toContain("dh_shlibdeps --exclude=.bare --exclude=linuxmusl");
    expect(control).toContain("Build-Depends: debhelper-compat (= 13), nodejs, npm, cargo, rustc");
    // Production runs the separately managed Node.js 22 binary in /usr/local;
    // Debian stable only needs to satisfy the package-level Node dependency.
    expect(control).toContain("Depends: nodejs (>= 20)");
    expect(control).toContain("qemu-efi-aarch64");
    expect(control).toContain("ipxe-qemu");
    expect(postinst).toContain("-m 0711 /zos/vm");
    expect(firstBoot).toContain("-m 0711 \"$ROOT_DIR/vm\" \"$ROOT_DIR/iso\"");
    expect(releaseWorkflow).not.toContain("dtolnay/rust-toolchain@1.95.0");
    expect(releaseWorkflow.match(/uses: dtolnay\/rust-toolchain@[0-9a-f]{40}/gu)).toHaveLength(3);
    expect(releaseWorkflow.match(/toolchain: 1\.95\.0/gu)).toHaveLength(3);
    expect(releaseWorkflow).toMatch(/package-arm64:[\s\S]*?apt-get install[\s\S]*?\n\s+acl \\/u);
    for (const workflow of [deployWorkflow, migrationPreflight]) {
      expect(workflow).toContain('repository_name="${GITHUB_REPOSITORY#*/}"');
      expect(workflow).toContain(
        'expected_subject="repo:${GITHUB_REPOSITORY_OWNER}@${GITHUB_REPOSITORY_OWNER_ID}/${repository_name}@${GITHUB_REPOSITORY_ID}:environment:production"'
      );
      expect(workflow).toContain('EXPECTED_SUBJECT="$expected_subject" OIDC_TOKEN="$oidc_token" node');
      expect(workflow).not.toContain("EXPECTED_SUBJECT: repo:");
    }
    expect(deployWorkflow).not.toContain('failed_units="$(systemctl --failed --no-legend --plain || true)"');
    expect(deployWorkflow).toContain("awk '$1 ~ /^zos-/ { print }'");
    expect(deployWorkflow).toContain("[ -x /usr/local/bin/node ]");
    expect(deployWorkflow).toContain("CM5 runtime requires Node.js 22");
    expect(deployWorkflow).toContain("zos-indexer.service");
    expect(deployWorkflow.match(/zos-monitor\.service/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(deployWorkflow.match(/zos-alerter\.service/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(deployWorkflow).toContain("/api/monitoring/overview");
    expect(deployWorkflow).toContain("monitoring did not produce a usable sample");
    expect(deployWorkflow).toContain("/api/indexer/status");
    expect(deployWorkflow).toContain("payload?.queue?.stalled === false");
    expect(deployWorkflow).toContain("wait_for_indexer_ready()");
    expect(deployWorkflow).toContain('while [ "$attempt" -le 120 ]');
    expect(deployWorkflow).toMatch(/- name: Verify CM5 services and build metadata\n\s+timeout-minutes: 20/u);
    expect(deployWorkflow).not.toContain("releases/download/$RELEASE_TAG/$RELEASE_ASSET");
    expect(deployWorkflow).toContain('local_parts_dir="$release_dir/parts-$upload_name"');
    expect(deployWorkflow).toContain('remote_parts_dir="$incoming_dir/package.deb.$RELEASE_SHA256.parts"');
    expect(deployWorkflow).toContain('split -b 4m -d -a 4');
    expect(deployWorkflow).toContain('partial_package="$incoming_dir/package.deb.$RELEASE_SHA256.download"');
    expect(deployWorkflow).toContain('if [ -L "$remote_parts_dir" ] || { [ -e "$remote_parts_dir" ] && [ ! -d "$remote_parts_dir" ]; }');
    expect(deployWorkflow).toContain('if [ ! -e "$part_path" ]; then');
    expect(deployWorkflow).toContain(': > "$part_path"');
    expect(deployWorkflow).toContain('upload_part()');
    expect(deployWorkflow).toContain('expected_size="$(stat --format=%s "$part_path")"');
    expect(deployWorkflow).toContain('expected_sha256="$(sha256sum "$part_path"');
    expect(deployWorkflow).toContain('actual_size="$(stat --format=%s "$remote_part_path")"');
    expect(deployWorkflow).toContain('[ "$actual_sha256" = "$expected_sha256" ]');
    expect(deployWorkflow).toContain("printf '%s\\n' complete");
    expect(deployWorkflow).toContain('for attempt in 1 2 3; do');
    expect(deployWorkflow).toContain("timeout --signal=TERM --kill-after=30s 900");
    expect(deployWorkflow).toContain('sftp -B 131072 -R 16 -b - "${ssh_options[@]}"');
    expect(deployWorkflow).toContain('reput "$part_path" "$remote_parts_dir/$part_name"');
    expect(deployWorkflow).toContain("SFTP upload of %s attempt %s failed; preserving part for resume");
    expect(deployWorkflow).toContain('assembled_package="$partial_package.assemble.$$"');
    expect(deployWorkflow).toContain('cat "$part_path" >> "$assembled_package"');
    expect(deployWorkflow).toContain('actual_sha256="$(sha256sum "$assembled_package"');
    expect(deployWorkflow).toContain('rm -rf "$remote_parts_dir"');
    expect(deployWorkflow).toContain('mv -f "$partial_package" "$incoming_dir/package.deb"');
    expect(deployWorkflow).toContain("ServerAliveInterval=15");
    expect(deployWorkflow).not.toContain("--continue-at -");
    expect(deployWorkflow).toContain(
      "printf 'N\\\\n' | sudo -n /usr/local/sbin/zos-deploy --no-upgrade-backup"
    );
    expect(deployWorkflow).toContain('> "$RUNNER_TEMP/cm5-config.sha256"');
    expect(deployWorkflow).toContain('> "$RUNNER_TEMP/cm5-migration-status"');
    expect(deployWorkflow).toContain('> "$RUNNER_TEMP/cm5-staging-channel"');
    expect(deployWorkflow).toContain('> "$RUNNER_TEMP/cm5-migration-source-config.sha256"');
    expect(deployWorkflow).toContain('if [[ "$staging_channel" == legacy ]]');
    expect(deployWorkflow).toContain('--arg repository "zhubby/SigmaOS"');
    expect(deployWorkflow).toContain("'.repository = $repository | .asset = $asset'");
    expect(deployWorkflow).toContain("Legacy migration recovery was not explicitly authorized");
    expect(deployWorkflow).toContain("ZOS staging recovery requires legacy services to remain masked");
    expect(deployWorkflow).toContain('[ "$previous_migration_status" = rolled_back ]');
    expect(deployWorkflow).toContain('"${baseline[5]:-}" == rolled_back');
    expect(deployWorkflow).toContain('[ "$installed_status" = "install ok installed" ]');
    expect(deployWorkflow).toContain('[ "$actual_config_sha256" = "$expected_config_sha256" ]');
    expect(deployWorkflow).toContain("sudo -n /usr/local/sbin/zos-deploy --config-sha256");
    expect(deployWorkflow).not.toContain("[ -r /zos/config/config.toml ]");
    expect(deployWorkflow).toContain('expected_migration_status=pending');
    expect(deployWorkflow).toContain('status.status !== expectedStatus');
    expect(deployWorkflow).toContain('status.sourceConfigSha256 !== expectedMigrationSourceConfigSha256');
    expect(deployWorkflow).not.toContain('status.sourceConfigSha256 !== expectedConfigSha256');
    expect(deployWorkflow).toContain('status.backupPath.startsWith("/zos/system-backups/legacy-sigmaos-")');
    expect(deployWorkflow).toContain("sudo -n /usr/local/sbin/zos-deploy --database-check");
    expect(deployWorkflow).toContain("/usr/lib/zos/bin/zos-termux");
    expect(deployWorkflow).toContain("zos-health.timer");
    expect(deployWorkflow).toContain("NextElapseUSecMonotonic");
    expect(deployWorkflow).toContain('payload?.operations?.health?.status !== "ready"');
    expect(deployWorkflow).toContain('runtime_before="$(runtime_fingerprint)"');
    expect(deployWorkflow).toContain('runtime_after="$(runtime_fingerprint)"');
    expect(deployWorkflow).toContain("sleep 30");
    expect(deployWorkflow).toContain('payload?.alerts?.alerterStatus !== "ready"');
    expect(deployWorkflow).toContain("Date.now() - lastEvaluationAt > 30_000");
    expect(deployWorkflow).toContain("payload.series.some");
    expect(deployWorkflow).toContain("series.points.length > 720");
    expect(deployWorkflow).toContain("responseBytes > 4 * 1024 * 1024");
    expect(deployWorkflow).toContain("elapsedMs > 500");
    expect(deployWorkflow).not.toContain("zos-terminal-helper.service");
    expect(migrationPreflight).toContain("/api/vms/summary");
    expect(migrationPreflight).toContain("recovery_audit");
    expect(migrationPreflight).toContain("--migration-backup-check");
    expect(migrationPreflight).toContain('migration_backup_check="$(sudo -n');
    expect(migrationPreflight).toContain("package_zos=");
    expect(migrationPreflight).toContain("/zos/system-backups");
    expect(migrationPreflight).toContain("vm_summary_unavailable=true");
    expect(migrationPreflight).toContain("mounted_storage_capacity_begin");
    expect(migrationPreflight).toContain("vm_legacy_disk_references");
    expect(migrationPreflight).toContain("vm_legacy_running_count");
    expect(migrationPreflight).toContain("vm_legacy_migration_eligible=true");
    expect(deployWorkflow).not.toContain('cp "$package_path" "$release_dir/package.deb"');
    expect(deployWorkflow).not.toContain('"$release_dir/package.deb" \\\n            "$release_dir/release-manifest.json"');
  });

  it("ships a loopback API reverse proxy for LAN access", async () => {
    const nginx = await readPackagingFile("nginx", "zos.conf");
    const nginxScript = await readPackagingFile("scripts", "zos-nginx.sh");

    expect(nginx).toContain("listen __ZOS_NGINX_PORT__;");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3010;");
    expect(nginx).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(nginx).toContain("client_max_body_size 4g;");
    expect(nginx).toContain("gzip on;");
    expect(nginx).toContain("gzip_types application/json;");
    expect(nginx).not.toContain("gzip_types text/event-stream");
    expect(nginx).toContain("location = /mcp");
    expect(nginx).toMatch(/location = \/mcp \{\s+return 404;/u);
    expect(nginxScript).toContain("nginx -t");
    expect(nginxScript).toContain("enabled_dir=/etc/nginx/sites-enabled");
    expect(nginxScript).toContain("ln -sfn");
  });

  it("ships a constrained native host daemon", async () => {
    const install = await readPackagingFile("debian", "install");
    const unit = await readPackagingFile("systemd", "zos-hostd.service");

    expect(unit).toContain("User=root");
    expect(unit).not.toContain("StateDirectory=");
    expect(unit).not.toContain("LogsDirectory=");
    expect(unit).not.toContain("RuntimeDirectory=zos");
    expect(unit).toContain("systemd-tmpfiles-setup.service");
    expect(unit).toContain("Wants=NetworkManager.service");
    expect(unit).not.toContain("Wants=network-online.target");
    expect(unit).toContain("Environment=ZOS_CONFIG=/zos/config/config.toml");
    expect(unit).toContain("Environment=ZOS_ROOT=/zos");
    expect(unit).not.toContain("ZOS_HOSTD_SOCKET_PATH=");
    expect(unit).toContain("ExecStart=/usr/lib/zos/bin/zos-hostd");
    expect(unit).not.toContain("/node");
    expect(unit).toContain("TimeoutStopSec=180");
    expect(unit).toContain("/run/mdadm");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=/etc /run/zos /run/mdadm /zos/config /zos/data");
    expect(unit).toContain("ReadWritePaths=-/run/samba -/var/lib/samba -/var/cache/samba -/var/log/samba");
    expect(unit).toContain("ReadWritePaths=-/zos/state/hostd/docker-daemon /zos/state/hostd/network-manager /zos/state/hostd/bluetooth");
    expect(unit).not.toMatch(/ReadWritePaths=.*(?:^|\s)\/var\/lib\/zos(?:\s|$)/mu);
    expect(unit).not.toContain("/zos/logs");
    expect(unit).toContain("CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER");
    expect(unit).toContain("CAP_MKNOD");
    expect(unit).toContain("CAP_SYS_ADMIN");
    expect(unit).toContain("CAP_SYS_RAWIO");
    const apiUnit = await readPackagingFile("systemd", "zos-api.service");
    expect(apiUnit).toContain("User=zos");
    expect(apiUnit).toContain("CapabilityBoundingSet=");
    expect(apiUnit).not.toContain("/etc/docker");
    expect(apiUnit).not.toContain("/etc/NetworkManager");
    const postinst = await readPackagingFile("debian", "postinst");
    expect(postinst).toContain("zos-migrate-sigmaos.sh apply");
    expect(postinst).toContain("/zos/state/hostd/docker-daemon");
    expect(postinst).toContain("/zos/state/hostd/network-manager");
    expect(postinst).toContain("/zos/state/hostd/bluetooth");
    expect(postinst).toContain("/zos/home/share");
    expect(postinst).toContain("usermod --home /zos/home/share zos-share");
    expect(postinst).toContain("/zos/apps");
    expect(install).toContain("zos-migrate-config.mjs usr/lib/zos/scripts/");
    expect(install).toContain("zos-migrate-share-acl.mjs usr/lib/zos/scripts/");
    expect(install).toContain("zos-migrate-fstab.mjs usr/lib/zos/scripts/");
    expect(install).toContain("zos-migrate-libvirt.mjs usr/lib/zos/scripts/");
    expect(install).toContain("zos-relocate-mount.sh usr/lib/zos/scripts/");
    expect(install).toContain("zos-migrate-sigmaos.sh usr/lib/zos/scripts/");
    expect(install).toContain("zos-migration-copy-growth.mjs usr/lib/zos/scripts/");
    expect(install).toContain("zos-migration-recovery.mjs usr/lib/zos/scripts/");
    expect(apiUnit).toContain("ReadWritePaths=/zos/state /zos/logs /zos/data /zos/vm /zos/iso /zos/apps");
    expect(apiUnit).toContain("CapabilityBoundingSet=\n");
  });

  it("loads managed shares through each protocol's actual service entrypoint", async () => {
    const samba = await readPackagingFile("etc", "samba.conf");
    const smbd = await readPackagingFile("systemd", "smbd.service.d", "zos.conf");
    const vsftpd = await readPackagingFile("systemd", "vsftpd.service.d", "zos.conf");
    const minidlna = await readPackagingFile("systemd", "minidlna.service.d", "zos.conf");
    const webdav = await readPackagingFile("systemd", "zos-webdav.service");

    expect(samba).not.toContain("include = /etc/samba/smb.conf\n");
    expect(samba).toContain("map to guest = Bad User");
    expect(samba).toContain("include = /etc/samba/smb.conf.d/zos-shares.conf");
    expect(smbd).toContain("--configfile=/usr/share/zos/samba.conf");
    expect(vsftpd).toContain("/etc/vsftpd.d/zos-shares.conf");
    expect(minidlna).toContain("-f /etc/minidlna.d/zos.conf");
    expect(webdav).toContain("User=www-data");
    expect(webdav).toContain("-f /etc/apache2/sites-available/zos-webdav.conf");
    expect(webdav).toContain("RuntimeDirectory=zos-webdav");
    expect(webdav).toContain("ReadWritePaths=/run/zos-webdav /zos/data");
    expect(webdav).not.toContain("/run/zos/webdav");
  });

  it("ships an isolated Rust Termux daemon", async () => {
    const unit = await readPackagingFile("systemd", "zos-termux.service");
    const refresh = await readPackagingFile("scripts", "zos-refresh-termux.sh");

    expect(unit).toContain("User=zos");
    expect(unit).toContain("Environment=ZOS_ROOT=/zos");
    expect(unit).toContain("ProtectHome=tmpfs");
    expect(unit).toContain("RestrictSUIDSGID=yes");
    expect(unit).toContain("termux.sock");
    expect(unit).toContain("CapabilityBoundingSet=");
    expect(unit).toContain("InaccessiblePaths=/zos/config /zos/state /zos/logs");
    expect(unit).toContain("ReadWritePaths=/run/zos /zos/data /zos/home/termux");
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("ExecStart=/usr/lib/zos/bin/zos-termux");
    expect(unit).not.toContain("/node");
    expect(refresh).toContain("User=%s\\n");
    expect(refresh).toContain("WorkingDirectory=%s\\n");
    expect(refresh).not.toContain("BindPaths=%s\\n");
    expect(refresh).toContain("ZOS_TERMUX_SOCKET_PATH");
    expect(refresh).toContain("ZOS_TERMUX_CONNECT_TIMEOUT_MS");
    expect(refresh).toContain("terminal user must be zos");
    expect(refresh).toContain("escape_systemd_value()");
    expect(refresh).toContain("s/%/%%/g");
    expect(refresh).toContain('ReadWritePaths="%s"\\n');
    const postinst = await readPackagingFile("debian", "postinst");
    expect(postinst).toContain("ln -sfn /usr/lib/zos/scripts/zos-deploy /usr/local/sbin/zos-deploy");
    expect(postinst).not.toContain("legacy_termux_home");
    expect(await readPackagingFile("scripts", "zos-nas-acl.sh")).toContain("findmnt -rn --mountpoint");
    expect(await readPackagingFile("scripts", "zos-nas-acl.sh")).toContain("getfacl --absolute-names");
  });

  it("ships a constrained CM5 deployment helper", async () => {
    const deploy = await readPackagingFile("scripts", "zos-deploy");
    const bootstrap = await readPackagingFile("scripts", "zos-deploy-bootstrap.sh");
    const migration = await readPackagingFile("scripts", "zos-migrate-sigmaos.sh");
    const mountRelocator = await readPackagingFile("scripts", "zos-relocate-mount.sh");
    const nasAcl = await readPackagingFile("scripts", "zos-nas-acl.sh");

    expect(deploy).toContain("flock -n 9");
    expect(deploy).toContain("ZOS_DEPLOY_DIR must be under /zos/deploy");
    expect(deploy).toContain("package checksum does not match release manifest");
    expect(deploy).toContain("refusing to downgrade");
    expect(deploy).not.toContain("tar -C /etc -czf");
    expect(deploy).not.toContain("tar -C /var/lib -czf");
    expect(deploy).toContain('command -v apt-get >/dev/null 2>&1 || die "apt-get is required"');
    expect(deploy).toContain("apt-get install --yes --no-remove");
    expect(deploy).toContain("Dpkg::Options::=--force-confdef");
    expect(deploy).toContain("Dpkg::Options::=--force-confold");
    expect(deploy).not.toContain('dpkg -i "$work_dir/package.deb"');
    expect(deploy).toContain("systemctl daemon-reload");
    expect(deploy).toContain('--activate-runtime "$work_dir" "$state_dir"');
    expect(deploy).toContain('flock -n 9 || die "internal runtime activation requires the parent deployment lock"');
    expect(deploy).toContain("activating runtime with the newly installed deployment helper");
    expect(deploy.indexOf('"$work_dir/package.deb"')).toBeLessThan(
      deploy.lastIndexOf('/usr/lib/zos/scripts/zos-deploy --activate-runtime "$work_dir" "$state_dir"')
    );
    expect(deploy).toContain("restore_unit_state \"$unit\" \"$state_dir\"");
    expect(deploy).toContain("activate_runtime");
    expect(deploy).not.toContain("systemctl restart $RUNTIME_SERVICES");
    expect(deploy).not.toContain("systemctl enable --now $TIMERS");
    expect(deploy).toContain("systemctl start zos-health.service");
    expect(deploy).toContain('RUNTIME_SERVICES="$CORE_RUNTIME_SERVICES zos-monitor.service zos-alerter.service"');
    const activateRuntime = deploy.slice(
      deploy.indexOf("activate_runtime() {"),
      deploy.indexOf("\nverify_runtime() {")
    );
    const activationOrder = [
      "for unit in $TIMERS $WRITERS; do",
      "systemctl enable $RUNTIME_SERVICES",
      "start_service_stably zos-hostd.service",
      "start_service_stably zos-termux.service",
      'restore_unit_state zos-vod-player.service "$state_dir"',
      "start_service_stably zos-api.service",
      "wait_for_url http://127.0.0.1:3010/health",
      "start_service_stably zos-monitor.service",
      "start_service_stably zos-alerter.service",
      "systemctl start zos-health.service",
      "start_service_stably zos-worker@1.service",
      "start_service_stably zos-photostaff.service",
      "start_service_stably zos-downloader.service",
      "start_service_stably zos-bluetoothd.service",
      "start_service_stably zos-indexer.service",
      "systemctl enable $TIMERS",
      "systemctl start $TIMERS"
    ];
    for (let index = 1; index < activationOrder.length; index += 1) {
      expect(activateRuntime.indexOf(activationOrder[index - 1]!)).toBeGreaterThanOrEqual(0);
      expect(activateRuntime.indexOf(activationOrder[index]!)).toBeGreaterThan(
        activateRuntime.indexOf(activationOrder[index - 1]!)
      );
    }
    expect(deploy).toContain('activate_runtime "$state_dir"');
    expect(deploy).toContain("/api/monitoring/overview");
    expect(deploy).toContain("monitoring did not produce a usable sample");
    expect(deploy).toContain('for unit in $RUNTIME_SERVICES; do');
    expect(deploy).toContain('systemctl is-active --quiet "$unit" || die "timer is not active: $unit"');
    expect(deploy).toContain("NextElapseUSecMonotonic");
    expect(deploy).toContain('health?.operations?.health?.status === "ready"');
    expect(deploy).toContain("wait_for_health_operation_ready");
    expect(deploy).toContain("refresh_share_configuration");
    expect(deploy).toContain("/api/settings/shares");
    expect(deploy).toContain("/api/shares/account");
    expect(deploy).toContain("--write-out '%{http_code}'");
    expect(deploy).toContain("response did not contain a safe error message");
    expect(deploy).toContain("share configuration refresh returned HTTP");
    expect(deploy).toContain("runtime_before=$(runtime_fingerprint)");
    expect(deploy).toContain("sleep 30");
    expect(deploy).toContain(
      "CORE_RUNTIME_SERVICES='zos-hostd.service zos-termux.service zos-api.service zos-worker@1.service zos-photostaff.service zos-downloader.service zos-bluetoothd.service zos-indexer.service'"
    );
    expect(deploy).toContain('systemctl is-enabled --quiet "$unit"');
    expect(deploy).toContain('die "one or more services restarted during stabilization"');
    expect(deploy).toContain('version $manifest_version is already installed; recovering runtime and release state');
    const sameVersionRecovery = deploy.slice(
      deploy.indexOf('version $manifest_version is already installed; recovering runtime and release state'),
      deploy.indexOf('log "recovered $manifest_tag successfully"')
    );
    expect(sameVersionRecovery.indexOf("zos-migrate-sigmaos.sh apply")).toBeGreaterThanOrEqual(0);
    expect(sameVersionRecovery.indexOf('/usr/lib/zos/scripts/zos-deploy --activate-runtime "$work_dir" "$state_dir"')).toBeGreaterThan(
      sameVersionRecovery.indexOf("zos-migrate-sigmaos.sh apply")
    );
    expect(deploy).toContain('record_release "$manifest_tag" "$manifest_version" "$manifest_commit_sha"');
    expect(deploy).toContain('record_release "$manifest_tag" "$manifest_version" "$manifest_commit_sha"\n    cleanup_deployment_artifacts');
    expect(deploy).toContain("awk '$1 ~ /^zos-/ { print }'");
    expect(deploy).toContain('failure_dir="$BACKUP_DIR/${manifest_tag}-retry-${retry_timestamp}"');
    expect(deploy).toContain('capture_runtime_diagnostics "$failure_dir"');
    expect(deploy).toContain("SHARE_SERVICES='smbd.service nmbd.service zos-webdav.service vsftpd.service nfs-server.service minidlna.service'");
    expect(deploy).toContain("systemctl status $RUNTIME_SERVICES $OPTIONAL_RUNTIME_SERVICES $SHARE_SERVICES");
    expect(deploy).toContain("-u vsftpd.service -u nfs-server.service -u minidlna.service");
    expect(deploy).toContain('cat "$target_diagnostics_path/services-status.txt" >&2');
    expect(deploy).toContain('cat "$target_diagnostics_path/services-journal.txt" >&2');
    expect(deploy).toContain("cleanup_deployment_artifacts");
    expect(deploy).toContain("zos-migrate-sigmaos.sh rollback");
    expect(deploy).toContain("zos-migrate-sigmaos.sh commit");
    expect(deploy.indexOf("zos-migrate-sigmaos.sh rollback")).toBeLessThan(
      deploy.indexOf('restore_unit_state "$unit" "$state_dir"')
    );
    expect(deploy).toContain("--migration-status)");
    expect(deploy).toContain("--config-sha256");
    expect(deploy).toContain("--database-check");
    expect(deploy).toContain("--migration-backup-check");
    expect(deploy).toContain("--no-upgrade-backup)");
    expect(deploy).toContain('log "upgrade backups disabled for this deployment"');
    expect(deploy).toContain('if [ "$create_upgrade_backup" -eq 1 ]; then');
    expect(deploy).toContain("configure_backup_dir");
    expect(deploy).toContain("using mounted storage for deployment backups");
    expect(deploy).toContain("zos-migration-recovery.mjs");
    expect(deploy).toContain("ZOS configuration must be a regular file");
    expect(deploy).toContain("ZOS database must be a regular file");
    expect(deploy).toContain("Keep the active release and one previous package");
    expect(deploy).toContain("Retention is an explicit operator action");
    expect(deploy).not.toContain('find "$BACKUP_DIR"');
    expect(deploy).toContain('find "$INCOMING_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +');
    expect(deploy).toContain("traverse outside BASE_DIR");
    expect(deploy).toContain('find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d -name \'work.*\'');
    expect(deploy).not.toContain("zos-share-helper.service");
    expect(deploy).not.toContain("zos-terminal-helper.service");
    expect(deploy).not.toContain("zos-player-helper.service");
    expect(deploy).toContain('tar -C /zos -czf "$backup_path/config.tgz" config');
    expect(deploy).toContain('tar -C /zos -czf "$backup_path/state.tgz" state home');
    expect(deploy).toContain("zos-termux");
    expect(deploy).toContain("package.deb must be a regular file");
    expect(deploy).toContain("/api/roots/readiness");
    expect(deploy).toContain("/api/indexer/status");
    expect(deploy).toContain('status?.queue?.stalled === false');
    expect(deploy).toContain("/api/system/build-info");
    expect(bootstrap).toContain("/usr/local/sbin/zos-deploy");
    expect(bootstrap).toContain("/usr/lib/zos/scripts/zos-deploy");
    expect(bootstrap).toContain("ZOS_DEPLOY_DIR must be under /zos/deploy");
    expect(bootstrap).toContain("NOPASSWD: /usr/local/sbin/zos-deploy");
    expect(bootstrap).toContain('install -d -o root -g "$DEPLOY_USER" -m 0750 "$BASE_DIR"');
    expect(bootstrap).toContain("install -d -o root -g \"$DEPLOY_USER\" -m 0730");
    expect(bootstrap).toContain("chmod 0751 /zos");
    expect(bootstrap).toContain("/zos must be a real directory");
    expect(bootstrap).not.toContain("chmod 0755 /zos");
    expect(bootstrap).toContain("visudo -cf");
    expect(migration).toContain("PRAGMA integrity_check");
    expect(migration).toContain("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(migration).toContain("legacy database WAL was not truncated");
    expect(migration).toContain("zos-migrate-database.mjs");
    expect(migration).toContain("zos-migrate-share-acl.mjs");
    expect(migration).toContain('share ACL state migration: $share_acl_report');
    expect(migration).toContain('/zos/config/share-acl.json "$backup_dir/path-mappings.tsv"');
    expect(migration.indexOf('/zos/config/share-acl.json "$backup_dir/path-mappings.tsv"')).toBeLessThan(
      migration.lastIndexOf("  move_legacy_mounts")
    );
    expect(migration).toContain("tar --one-file-system");
    expect(migration).toContain("SHARE_SERVICES=");
    expect(migration).toContain("verify_capacity");
    expect(migration).toContain("--apparent-size");
    expect(migration).toContain("select_mounted_cold_backup");
    expect(migration).toContain("zos-migration-copy-growth.mjs");
    expect(migration).toContain("zos-migration-recovery.mjs");
    expect(migration).toContain("recover_rolled_back_pointer");
    expect(migration).toContain('write_pointer "$PREVIOUS_BACKUP_DIR"');
    expect(migration).toContain("relocate_deployment_archives");
    expect(migration).toContain("verify_relocated_deployment_archives_after_mount_move");
    expect(migration).toContain("deployment-archives");
    expect(migration).toContain("archive_sha256");
    expect(migration).toContain(".zos/system-backups");
    expect(migration).toContain("cold-backup.json");
    expect(migration).toContain("verify_cold_backup_after_mount_move");
    expect(migration).toContain("harden_mounted_cold_backup");
    expect(migration.indexOf("-xdev -exec chown -h zos:zos")).toBeLessThan(
      migration.lastIndexOf("harden_mounted_cold_backup")
    );
    expect(migration).toContain("backup-check)");
    expect(nasAcl).toContain('-path "$pool/.zos" -prune');
    expect(migration).toContain("prepare_libvirt_migration");
    expect(migration).toContain("refusing to copy live disks");
    expect(migration).toContain("managed save image");
    expect(migration).toContain("define_migrated_libvirt_domains");
    expect(migration).toContain("restore_original_libvirt_domains");
    expect(migration.indexOf('log "stopping legacy writers and services"')).toBeLessThan(
      migration.lastIndexOf('  prepare_libvirt_migration')
    );
    expect(migration.indexOf('write_status pending')).toBeLessThan(migration.indexOf('  commit)'));
    expect(migration.indexOf('  commit)')).toBeLessThan(
      migration.indexOf('define_migrated_libvirt_domains || die')
    );
    expect(migration).toContain('MOUNT_RELOCATOR=/usr/lib/zos/scripts/zos-relocate-mount.sh');
    expect(migration).toContain('[ -x "$MOUNT_RELOCATOR" ] || die "mount relocator is missing"');
    expect(migration).toContain('"$MOUNT_RELOCATOR" "$mount_target" "$new_mount_target"');
    expect(mountRelocator).toContain('if mount --move "$source_mount" "$target_mount"');
    expect(mountRelocator).toContain('mount --rbind "$source_mount" "$target_mount"');
    expect(mountRelocator).toContain('mount --make-rprivate "$target_mount"');
    expect(mountRelocator).toContain('umount --recursive "$source_mount"');
    expect(migration).toContain('if [ "$old_mounted" -eq 1 ] && [ "$new_mounted" -eq 1 ]');
    expect(migration).toContain('umount --recursive "$new_target" || return 1');
    expect(migration).toContain("-xdev -exec chown -h zos:zos -- {} +");
    expect(migration).toContain("chmod 0751 /zos");
    expect(migration).toContain("chmod 0750 /zos/config");
    expect(migration).toContain('ZOS_ACL_BACKUP_DIR="$backup_dir/nas-acl"');
    expect(migration).toContain('"$NAS_ACL_MIGRATOR" --apply --pool "$new_target" --root "$nas_root"');
    expect(migration).toContain('setfacl --restore="$acl_dump"');
    expect(migration.indexOf("restore_nas_acls")).toBeLessThan(migration.indexOf("restore_mounts"));
    expect(migration).not.toContain("chown -R --one-file-system");
    expect(migration).toContain('chown root:root "$POINTER_PATH"');
    expect(migration).toContain('systemctl mask --force "$unit"');
    expect(migration).toContain("zos-migrate-fstab.mjs");
    expect(migration).toContain("write_status pending");
    expect(migration).toContain("rollback_migration");
  });
});

function readPackagingFile(...segments: string[]): Promise<string> {
  return readFile(path.join(repoRoot, "packaging", ...segments), "utf8");
}

function readRepoFile(...segments: string[]): Promise<string> {
  return readFile(path.join(repoRoot, ...segments), "utf8");
}
