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
  it("builds monitor and alerter as independent Rust applications", async () => {
    const workspace = await readFile(path.join(repoRoot, "Cargo.toml"), "utf8");
    const monitor = await readFile(path.join(repoRoot, "crates/monitor/Cargo.toml"), "utf8");
    const alerter = await readFile(path.join(repoRoot, "crates/alerter/Cargo.toml"), "utf8");
    const contracts = await readFile(
      path.join(repoRoot, "crates/monitoring-contracts/Cargo.toml"),
      "utf8"
    );

    expect(workspace).toContain('members = ["crates/*"]');
    expect(monitor).toContain('name = "cyberos-monitor"');
    expect(monitor).not.toContain('name = "cyberos-alerter"');
    expect(monitor).not.toContain("lettre.workspace");
    expect(monitor).not.toContain("jiff.workspace");
    expect(alerter).toContain('name = "cyberos-alerter"');
    expect(alerter).toContain("lettre.workspace");
    expect(alerter).not.toContain("cyberos-monitor =");
    expect(contracts).not.toContain("tokio.workspace");
    expect(contracts).not.toContain("rusqlite.workspace");
    expect(contracts).toContain("publish = false");
  });

  it("defines hardened systemd services and timers", async () => {
    const serviceNames = [
      "cyberos-api.service",
      "cyberos-monitor.service",
      "cyberos-alerter.service",
      "cyberos-worker@.service",
      "cyberos-indexer.service",
      "cyberos-maintenance.service",
      "cyberos-backup-daily.service",
      "cyberos-backup-weekly.service",
      "cyberos-health.service"
    ];

    for (const serviceName of serviceNames) {
      const unit = await readPackagingFile("systemd", serviceName);
      expect(unit).toContain("User=cyberos");
      expect(unit).toContain("ProtectSystem=strict");
      expect(unit).toContain("NoNewPrivileges=yes");
      expect(unit).toContain("CapabilityBoundingSet=");
      expect(unit).toMatch(/ReadWritePaths=.*\/cyberos\/state/);
      if (["cyberos-api.service", "cyberos-monitor.service", "cyberos-alerter.service"].includes(serviceName)) {
        expect(unit).toMatch(/ReadWritePaths=.*\/run\/cyberos/);
      }
      expect(unit).toContain("Environment=CYBEROS_ROOT=/cyberos");
      if (["cyberos-monitor.service", "cyberos-alerter.service", "cyberos-indexer.service"].includes(serviceName)) {
        expect(unit).toContain("ExecStart=/usr/lib/cyberos/bin/cyberos-");
      } else {
        expect(unit).toContain("ExecStart=/usr/local/bin/node");
        expect(unit).not.toContain("ExecStart=/usr/bin/node");
      }
      expect(unit).not.toContain("RuntimeDirectory=cyberos");
    }

    await expect(readPackagingFile("systemd", "cyberos-api.service")).resolves.toContain(
      "After=network-online.target local-fs.target"
    );
    const monitorUnit = await readPackagingFile("systemd", "cyberos-monitor.service");
    expect(monitorUnit).toContain("After=local-fs.target cyberos-api.service");
    expect(monitorUnit).toContain("Type=notify");
    expect(monitorUnit).toContain("ExecStart=/usr/lib/cyberos/bin/cyberos-monitor");
    expect(monitorUnit).toContain("ReadOnlyPaths=-/cyberos/data");
    expect(monitorUnit).toMatch(/ReadWritePaths=.*\/run\/cyberos/);
    expect(monitorUnit).toMatch(/ReadWritePaths=.*\/cyberos\/state/);
    expect(monitorUnit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(monitorUnit).toContain("MemoryMax=256M");
    expect(monitorUnit).toContain("CPUWeight=20");
    expect(monitorUnit).toContain("IOWeight=20");
    const alerterUnit = await readPackagingFile("systemd", "cyberos-alerter.service");
    expect(alerterUnit).toContain("After=network-online.target local-fs.target cyberos-api.service cyberos-monitor.service");
    expect(alerterUnit).toContain("Wants=network-online.target cyberos-api.service cyberos-monitor.service");
    expect(alerterUnit).not.toContain("Requires=cyberos-monitor.service");
    expect(alerterUnit).toContain("Type=notify");
    expect(alerterUnit).toContain("ExecStart=/usr/lib/cyberos/bin/cyberos-alerter");
    expect(alerterUnit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    expect(alerterUnit).toContain("MemoryMax=256M");
    await expect(readPackagingFile("systemd", "cyberos-downloader.service")).resolves.toContain(
      "RequiresMountsFor=/cyberos/data"
    );
    await expect(readPackagingFile("systemd", "cyberos-downloader.service")).resolves.toContain(
      "ExecStart=/usr/lib/cyberos/bin/cyberos-downloader"
    );
    await expect(readPackagingFile("systemd", "cyberos-downloader.service")).resolves.toContain(
      "TimeoutStopSec=30"
    );
    await expect(readPackagingFile("systemd", "cyberos-downloader.service")).resolves.toContain(
      "User=cyberos"
    );
    await expect(readPackagingFile("systemd", "cyberos-downloader.service")).resolves.toContain(
      "Environment=CYBEROS_ROOT=/cyberos"
    );
    await expect(readPackagingFile("systemd", "cyberos-downloader.service")).resolves.toContain(
      "Environment=CYBEROS_ENVIRONMENT=production"
    );
    await expect(readPackagingFile("systemd", "cyberos-downloader.service")).resolves.toContain(
      "ProtectSystem=strict"
    );
    await expect(readPackagingFile("systemd", "cyberos-downloader.service")).resolves.toContain(
      "NoNewPrivileges=yes"
    );
    await expect(readPackagingFile("systemd", "cyberos-hostd.service")).resolves.toContain(
      "After=local-fs.target systemd-tmpfiles-setup.service NetworkManager.service"
    );
    await expect(readPackagingFile("systemd", "cyberos-hostd.service")).resolves.toContain(
      "Before=network-online.target"
    );
    const vodPlayerUnit = await readPackagingFile("systemd", "cyberos-vod-player.service");
    expect(vodPlayerUnit).toContain("ExecStart=/usr/lib/cyberos/bin/cyberos-vod-player");
    expect(vodPlayerUnit).toContain("Type=notify");
    expect(vodPlayerUnit).toContain("WatchdogSec=20s");
    expect(vodPlayerUnit).toContain("TimeoutStopSec=30s");
    expect(vodPlayerUnit).toContain("ProtectSystem=strict");
    expect(vodPlayerUnit).toContain("/cyberos/state/cyberos.sqlite-wal");
    expect(vodPlayerUnit).toContain("Wants=cyberos-api.service bluetooth.service bluealsa.service");
    expect(vodPlayerUnit).toContain("Environment=CYBEROS_ENVIRONMENT=production");
    expect(vodPlayerUnit).not.toContain("RequiresMountsFor=/cyberos/data");
    const tvTarget = await readPackagingFile("systemd", "cyberos-tv.target");
    expect(tvTarget).toContain("Requires=cyberos-tv-prepare.service cyberos-tv-weston.service cyberos-tv-chromium.service cyberos-vod-player.service");
    expect(tvTarget).toContain("Conflicts=display-manager.service");
    const tvPrepare = await readPackagingFile("systemd", "cyberos-tv-prepare.service");
    expect(tvPrepare).toContain("PartOf=cyberos-tv.target");
    expect(tvPrepare).toContain("RuntimeDirectoryMode=0700");
    expect(tvPrepare).toContain("ExecStart=/usr/lib/cyberos/scripts/cyberos-tv-prepare start");
    expect(tvPrepare).toContain("ExecStop=/usr/lib/cyberos/scripts/cyberos-tv-prepare stop");
    expect(tvPrepare).toContain("ReadWritePaths=/run/cyberos-tv /sys/class/drm");
    const tvWeston = await readPackagingFile("systemd", "cyberos-tv-weston.service");
    expect(tvWeston).toContain("PartOf=cyberos-tv.target");
    expect(tvWeston).toContain("User=cyberos");
    expect(tvWeston).toContain("DeviceAllow=char-drm rw");
    expect(tvWeston).toContain("DeviceAllow=char-input r");
    expect(tvWeston).toContain("RestrictAddressFamilies=AF_UNIX AF_NETLINK");
    expect(tvWeston).not.toContain("StandardInput=tty");
    expect(tvWeston).not.toContain("TTYVHangup=yes");
    const tvWestonScript = await readPackagingFile("scripts", "cyberos-tv-weston");
    expect(tvWestonScript).toContain("--backend=drm-backend.so");
    expect(tvWestonScript).not.toMatch(/--tty(?:=|\s)/);
    expect(tvWestonScript).toContain("trap terminate HUP INT TERM");
    const tvChromium = await readPackagingFile("systemd", "cyberos-tv-chromium.service");
    expect(tvChromium).toContain("PartOf=cyberos-tv.target");
    expect(tvChromium).toContain("SupplementaryGroups=video render");
    expect(tvChromium).toContain("IPAddressAllow=localhost");
    expect(tvChromium).not.toContain("--no-sandbox");
    await expect(readPackagingFile("scripts", "cyberos-tv-chromium"))
      .resolves.toContain("trap terminate HUP INT TERM");
    const tvCec = await readPackagingFile("systemd", "cyberos-tv-cec.service");
    expect(tvCec).toContain("PartOf=cyberos-tv.target");
    expect(tvCec).toContain("CapabilityBoundingSet=CAP_NET_ADMIN");
    expect(tvCec).toContain("AmbientCapabilities=CAP_NET_ADMIN");
    expect(tvCec).toContain("KillMode=mixed");
    const tvCecScript = await readPackagingFile("scripts", "cyberos-tv-cec");
    expect(tvCecScript).toContain("trap terminate HUP INT TERM");
    expect(tvCecScript).toContain('wtype -k F24');
    expect(tvCecScript).toContain("Wayland virtual keyboard input is unavailable");
    expect(tvCecScript).toContain('"$status_writer" cec degraded');
    expect(tvCecScript).toContain('wait "$cec_pid" 2>/dev/null || true');
    expect(tvCecScript).toContain('wait "$heartbeat_pid" 2>/dev/null || true');
    const tvGamepad = await readPackagingFile("systemd", "cyberos-tv-gamepad.service");
    expect(tvTarget).toContain("Wants=cyberos-tv-cec.service cyberos-tv-gamepad.service");
    expect(tvGamepad).toContain("User=cyberos");
    expect(tvGamepad).toContain("SupplementaryGroups=input");
    expect(tvGamepad).toContain("DevicePolicy=closed");
    expect(tvGamepad).toContain("DeviceAllow=char-input r");
    expect(tvGamepad).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(tvGamepad).not.toContain("/dev/uinput");
    expect(tvGamepad).not.toMatch(/AF_INET|AF_BLUETOOTH/);
    const tvPrepareScript = await readPackagingFile("scripts", "cyberos-tv-prepare");
    expect(tvPrepareScript).toContain("install -d -m 0700");
    expect(tvPrepareScript).toContain('card*-HDMI-A-*/status');
    expect(tvPrepareScript).toContain('on-digital > "$connector_status"');
    expect(tvPrepareScript).toContain('"$runtime_dir/weston.log"');
    expect(tvPrepareScript).toContain('"$runtime_dir/status/gamepad.json"');
    await expect(readPackagingFile("scripts", "cyberos-tv-write-status")).resolves.toContain("weston|chromium|cec|gamepad");
    const mpvInput = await readPackagingFile("etc", "mpv-input.conf");
    expect(mpvInput).toContain("LEFT seek -10 relative+exact");
    expect(mpvInput).toContain("UP cycle aid");
    expect(mpvInput).toContain("DOWN cycle sid");
    expect(mpvInput).toContain("F6 seek -10 relative+exact");
    expect(mpvInput).toContain("F10 cycle sid");
    expect(mpvInput).toContain("ENTER cycle pause");
    expect(mpvInput).toContain("ESC quit");
    const bluetoothUnit = await readPackagingFile("systemd", "cyberos-bluetoothd.service");
    expect(bluetoothUnit).toContain("User=cyberos");
    expect(bluetoothUnit).toContain("ExecStart=/usr/bin/dbus-run-session -- /usr/lib/cyberos/bin/cyberos-bluetoothd");
    expect(bluetoothUnit).toContain("RequiresMountsFor=/cyberos/data");
    expect(bluetoothUnit).toContain("Environment=CYBEROS_ENVIRONMENT=production");
    expect(bluetoothUnit).toContain("ReadWritePaths=/cyberos/state/bluetooth");
    expect(bluetoothUnit).toContain("ReadOnlyPaths=/cyberos/data");
    expect(bluetoothUnit).not.toMatch(/ReadWritePaths=.*(?:^|\s)\/cyberos\/data(?:\s|$)/mu);
    expect(bluetoothUnit).toContain("RestrictAddressFamilies=AF_UNIX AF_BLUETOOTH");
    expect(bluetoothUnit).toContain("CapabilityBoundingSet=");
    const photosUnit = await readPackagingFile("systemd", "cyberos-photos.service");
    expect(photosUnit).toContain("ExecStart=/usr/lib/cyberos/bin/cyberos-photos");
    expect(photosUnit).toContain("Type=notify");
    expect(photosUnit).toContain("WatchdogSec=20s");
    expect(photosUnit).toContain("TimeoutStopSec=30s");
    expect(photosUnit).toContain("KillMode=control-group");
    expect(photosUnit).toContain("Environment=CYBEROS_ENVIRONMENT=production");
    expect(photosUnit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(photosUnit).not.toContain("RequiresMountsFor=/cyberos/data");
    await expect(readPackagingFile("systemd", "cyberos-photo-worker.service")).rejects.toMatchObject({ code: "ENOENT" });

    const maintenanceUnit = await readPackagingFile("systemd", "cyberos-maintenance.service");
    expect(maintenanceUnit).toContain("ExecStart=/usr/local/bin/node /usr/lib/cyberos/apps/ops/dist/index.js maintenance");
    expect(maintenanceUnit).toContain("TimeoutStartSec=2h");
    expect(maintenanceUnit).not.toContain("RequiresMountsFor=");
    const maintenanceTimer = await readPackagingFile("systemd", "cyberos-maintenance.timer");
    expect(maintenanceTimer).toContain("OnCalendar=*-*-* 04:30:00");
    expect(maintenanceTimer).toContain("RandomizedDelaySec=30min");
    expect(maintenanceTimer).toContain("Persistent=true");
    const indexerUnit = await readPackagingFile("systemd", "cyberos-indexer.service");
    expect(indexerUnit).toContain("Type=notify");
    expect(indexerUnit).toContain("WatchdogSec=20s");
    expect(indexerUnit).toContain("Restart=on-failure");
    expect(indexerUnit).toContain("Environment=CYBEROS_ENVIRONMENT=production");
    expect(indexerUnit).toContain("ReadOnlyPaths=/cyberos/data");
    expect(indexerUnit).toContain("MemoryMax=1G");
    expect(indexerUnit).toContain("KillMode=control-group");
    await expect(readPackagingFile("systemd", "cyberos-indexer.timer")).rejects.toMatchObject({ code: "ENOENT" });
    const healthUnit = await readPackagingFile("systemd", "cyberos-health.service");
    expect(healthUnit).toContain("ExecStart=/usr/local/bin/node /usr/lib/cyberos/apps/ops/dist/index.js health");
    expect(healthUnit).toContain("TimeoutStartSec=2min");
    const healthTimer = await readPackagingFile("systemd", "cyberos-health.timer");
    expect(healthTimer).toContain("OnBootSec=6min");
    expect(healthTimer).toContain("OnUnitActiveSec=15min");
    expect(healthTimer).toContain("RandomizedDelaySec=2min");
    expect(healthTimer).toContain("Persistent=true");
    await expect(readPackagingFile("systemd", "cyberos-scheduler.service")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readPackagingFile("systemd", "cyberos-scheduler.timer")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readPackagingFile("debian", "postinst")).resolves.toContain("cyberos-refresh-groups.sh");
    await expect(readPackagingFile("scripts", "cyberos-refresh-groups.sh")).resolves.toContain("optional-groups.conf");
    await expect(readPackagingFile("scripts", "cyberos-refresh-groups.sh")).resolves.toContain("kvm");
    await expect(readPackagingFile("scripts", "cyberos-refresh-groups.sh")).resolves.toContain(
      "org.libvirt.unix.manage"
    );
    await expect(readPackagingFile("debian", "postrm")).resolves.toContain(
      "49-cyberos-libvirt.rules"
    );
    await expect(readPackagingFile("systemd", "cyberos-api.service")).resolves.toContain(
      "BindReadOnlyPaths=-/run/libvirt/libvirt-sock"
    );
    await expect(readPackagingFile("systemd", "cyberos-backup-daily.service")).resolves.toContain("LoadCredential=restic-password");
    await expect(readPackagingFile("systemd", "cyberos-backup-daily.service")).resolves.toContain("ConditionPathExists=/cyberos/config/restic-password");
    await expect(readPackagingFile("systemd", "cyberos-backup-weekly.service")).resolves.toContain("ConditionPathExists=/cyberos/config/restic-password");
    await expect(readPackagingFile("systemd", "cyberos-backup-weekly.timer")).resolves.toContain("OnCalendar=Sun");
  });

  it("declares Debian install paths required by the spec", async () => {
    const install = await readPackagingFile("debian", "install");
    const links = await readPackagingFile("debian", "links");
    const control = await readPackagingFile("debian", "control");
    const tmpfiles = await readPackagingFile("tmpfiles.d", "cyberos.conf");

    expect(install).toContain("usr/lib/cyberos/apps/api/dist/");
    expect(install).toContain("target/release/cyberos-monitor usr/lib/cyberos/bin/");
    expect(install).toContain("target/release/cyberos-alerter usr/lib/cyberos/bin/");
    expect(install).not.toContain("crates/monitor/dist/");
    expect(install).toContain("target/release/cyberos-hostd usr/lib/cyberos/bin/");
    expect(install).toContain("target/release/cyberos-host-accessd usr/lib/cyberos/bin/");
    expect(install).toContain("target/release/cyberos-terminald usr/lib/cyberos/bin/");
    expect(install).not.toContain("packages/terminal-helper");
    expect(install).toContain("usr/lib/cyberos/apps/worker/dist/");
    expect(install).toContain("target/release/cyberos-photos usr/lib/cyberos/bin/");
    expect(install).not.toContain("packages/photo-worker");
    expect(install).not.toContain("crates/photos/dist/");
    expect(install).toContain("target/release/cyberos-indexer usr/lib/cyberos/bin/");
    expect(install).not.toContain("crates/indexer/dist/");
    expect(install).toContain("usr/lib/cyberos/apps/backup/dist/");
    expect(install).toContain("usr/lib/cyberos/apps/ops/dist/");
    expect(install).not.toContain("packages/scheduler");
    expect(install).toContain("target/release/cyberos-vod-player usr/lib/cyberos/bin/");
    expect(install).toContain("packaging/scripts/cyberos-tv-mode usr/lib/cyberos/scripts/");
    expect(install).toContain("packaging/systemd/*.target lib/systemd/system/");
    expect(install).toContain("target/release/cyberos-bluetoothd usr/lib/cyberos/bin/");
    expect(install).not.toContain("packages/player-helper");
    expect(install).toContain("target/release/cyberos-downloader usr/lib/cyberos/bin/");
    expect(install).not.toContain("crates/downloader/dist/");
    expect(install).toContain("node_modules/* usr/lib/cyberos/node_modules/");
    expect(install).toContain(
      "packages/agent/node_modules/* usr/lib/cyberos/packages/agent/node_modules/"
    );
    expect(links).toContain(
      "usr/lib/cyberos/packages/agent/node_modules/@earendil-works/pi-coding-agent usr/lib/cyberos/node_modules/@earendil-works/pi-coding-agent"
    );
    await expect(readPackagingFile("debian", "cyberos.maintscript")).rejects.toMatchObject({ code: "ENOENT" });
    expect(links).not.toContain("cyberos-photo-worker.service");
    expect(install).toContain("docs/dist/* usr/lib/cyberos/docs/dist/");
    expect(install).toContain(".cyberos/build-info.json usr/lib/cyberos/");
    expect(install).not.toContain("docs/node_modules");
    await expect(readPackagingFile("systemd", "cyberos-api.service")).resolves.toContain(
      "Environment=CYBEROS_DOCS_DIST=/usr/lib/cyberos/docs/dist"
    );
    await expect(readPackagingFile("systemd", "cyberos-api.service")).resolves.toContain(
      "Environment=CYBEROS_BUILD_INFO_PATH=/usr/lib/cyberos/build-info.json"
    );
    const apiUnit = await readPackagingFile("systemd", "cyberos-api.service");
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/run\/cyberos/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/state/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/logs/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/data/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/vm/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/iso/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/apps/);
    const hostAccessUnit = await readPackagingFile("systemd", "cyberos-host-accessd.service");
    expect(hostAccessUnit).toContain("User=cyberos");
    expect(hostAccessUnit).toContain("SupplementaryGroups=docker");
    expect(hostAccessUnit).toContain("CYBEROS_HOST_ACCESS_DOCKER_COMPATIBLE=0");
    expect(hostAccessUnit).toContain("RuntimeDirectoryPreserve=restart");
    expect(hostAccessUnit).toContain("NoNewPrivileges=yes");
    expect(install).toContain("packaging/scripts/cyberos-nginx.sh usr/lib/cyberos/scripts/");
    expect(install).toContain("packaging/scripts/cyberos-configure-locale.sh usr/lib/cyberos/scripts/");
    expect(install).toContain("packaging/scripts/cyberos-refresh-terminald.sh usr/lib/cyberos/scripts/");
    expect(install).toContain("packaging/scripts/cyberos-nas-acl.sh usr/lib/cyberos/scripts/");
    expect(install).toContain("packaging/scripts/cyberos-share-acl.mjs usr/lib/cyberos/scripts/");
    expect(install).toContain("packaging/etc/samba.conf usr/share/cyberos/");
    expect(install).toContain("packaging/systemd/smbd.service.d/cyberos.conf lib/systemd/system/smbd.service.d/");
    expect(install).toContain("packaging/systemd/vsftpd.service.d/cyberos.conf lib/systemd/system/vsftpd.service.d/");
    expect(install).toContain("packaging/systemd/minidlna.service.d/cyberos.conf lib/systemd/system/minidlna.service.d/");
    expect(install).toContain("packaging/scripts/cyberos-refresh-vod-player.sh usr/lib/cyberos/scripts/");
    expect(install).toContain("packaging/scripts/cyberos-deploy-bootstrap.sh usr/lib/cyberos/scripts/");
    expect(install).toContain("packaging/scripts/cyberos-deploy usr/lib/cyberos/scripts/");
    expect(install).toContain("packages/mcp-cli/dist/* usr/lib/cyberos/apps/mcp-cli/dist/");
    expect(install).toContain("target/release/cyberos-tv-gamepad usr/lib/cyberos/bin/");
    expect(install).toContain("packaging/scripts/cyberos-mcp usr/lib/cyberos/scripts/");
    expect(install).toContain("packaging/nginx/cyberos.conf usr/share/cyberos/nginx/");
    expect(install).toContain("packaging/etc/config.toml cyberos/config/");
    expect(install).toContain("lib/systemd/system/");
    expect(install).toContain("tmpfiles.d/cyberos.conf");
    expect(tmpfiles).toContain("/run/cyberos");
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
    const refreshVodPlayer = await readPackagingFile("scripts", "cyberos-refresh-vod-player.sh");
    expect(postinst).not.toContain("migrate-");
    expect(postinst).toContain("install -d -o root -g cyberos -m 0751 /cyberos");
    expect(postinst).toContain("install -d -o root -g cyberos -m 0750 /cyberos/config");
    expect(postinst).toContain("install -d -o cyberos -g cyberos -m 0700 /cyberos/config/mcp");
    expect(postinst).toContain("ln -sfn /usr/lib/cyberos/scripts/cyberos-mcp /usr/local/sbin/cyberos-mcp");
    expect(postinst).toContain("ln -sfn /usr/lib/cyberos/scripts/cyberos-tv-mode /usr/local/sbin/cyberos-tv-mode");
    expect(postinst).toContain("/cyberos/state/tv/control");
    expect(postinst).not.toContain("install -d -o root -g cyberos -m 0755 /cyberos");
    expect(postinst).toContain("/cyberos/state/hostd/docker-daemon");
    expect(postinst).toContain("/cyberos/state/hostd/network-manager");
    expect(postinst).toContain("/cyberos/state/bluetooth");
    expect(defaultConfig).toContain("[monitoring]");
    expect(defaultConfig).toContain("[mcp]");
    expect(defaultConfig).toContain("external_enabled = false");
    expect(defaultConfig).toContain("max_database_bytes = 536870912");
    expect(refreshVodPlayer).toContain("CYBEROS_VOD_PLAYER_SOCKET_PATH");
    expect(refreshVodPlayer).toContain("CYBEROS_VOD_PLAYER_STATE_PATH");
    expect(refreshVodPlayer).toContain("ReadWritePaths=");
    expect(refreshVodPlayer).toContain("private temporary directory");
    expect(refreshVodPlayer).toContain("state path must be under /cyberos/state/vod-player");
    expect(refreshVodPlayer).not.toContain("CYBEROS_ENABLE_PLAYER");
    expect(postrm.indexOf("optional-groups.conf")).toBeLessThan(postrm.indexOf("systemctl daemon-reload"));
    expect(postrm).toContain("cyberos-terminald.service.d/identity.conf");
    expect(postrm).toContain("cyberos-vod-player.service.d/identity.conf");
    expect(postrm).toContain("cyberos-vod-player.service.d/50-cyberos-tv-mode.conf");
    await expect(readPackagingFile("debian", "prerm")).resolves.toContain("cyberos-tv-mode disable");
  });

  it("ships strict first-boot configuration for clean Debian installs", async () => {
    const firstBoot = await readPackagingFile("scripts", "cyberos-first-boot.sh");

    expect(firstBoot).toContain("CYBEROS_ADMIN_DISPLAY_NAME");
    expect(firstBoot).toContain("CYBEROS_DOCKER_ENABLED");
    expect(firstBoot).toContain("CYBEROS_VM_ENABLED");
    expect(firstBoot).toContain("CYBEROS_VOD_PLAYER_ENABLED");
    expect(firstBoot).toContain("[vod_player]");
    expect(firstBoot).toContain("CYBEROS_TERMINALD_USER");
    expect(firstBoot).not.toContain("chown -R cyberos:cyberos");
    expect(firstBoot).toContain('environment = "production"');
    expect(firstBoot).toContain('chown -R root:root "$STATE_DIR/hostd"');
    expect(firstBoot).toContain('repository = "$ROOT_DIR/backup"');
    expect(firstBoot).not.toContain("[model]");
    expect(firstBoot).toContain("[hostd]");
    expect(firstBoot).toContain("[monitoring]");
    expect(firstBoot).toContain("[shares]");
    expect(firstBoot).toContain('[ -e "$CONFIG_PATH" ]');
    expect(firstBoot).toContain('CYBEROS_FIRST_BOOT_FORCE:-0');
    expect(firstBoot).toContain('password_file = "$ROOT_DIR/config/restic-password"');
    expect(firstBoot).not.toContain("restic-password\" =");
    expect(firstBoot).toContain('[ ! -e "$DATABASE_PATH" ] && [ ! -L "$DATABASE_PATH" ]');
    expect(firstBoot).toContain("CyberOS first boot requires a new database");
    expect(firstBoot).not.toContain("PRAGMA user_version");
    expect(firstBoot).not.toContain('sqlite3 "$DATABASE_PATH"');
    await expect(readPackagingFile("systemd", "cyberos-share-helper.service")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an existing first-boot configuration", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-first-boot-"));
    const configPath = path.join(tempDir, "config.toml");
    const sentinel = "# operator-owned configuration\n";
    await writeFile(configPath, sentinel);

    try {
      await execFileAsync("sh", [path.join(repoRoot, "packaging/scripts/cyberos-first-boot.sh")], {
        env: { ...process.env, CYBEROS_CONFIG: configPath }
      });
      await expect(readFile(configPath, "utf8")).resolves.toBe(sentinel);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ships an ARM-friendly host installer", async () => {
    const installer = await readPackagingFile("scripts", "install.sh");
    const localeScript = await readPackagingFile("scripts", "cyberos-configure-locale.sh");
    const buildDeb = await readPackagingFile("scripts", "build-deb.sh");
    const rules = await readPackagingFile("debian", "rules");
    const control = await readPackagingFile("debian", "control");
    const postinst = await readPackagingFile("debian", "postinst");
    const firstBoot = await readPackagingFile("scripts", "cyberos-first-boot.sh");
    const releaseWorkflow = await readRepoFile(".github", "workflows", "package-release.yml");
    const deployWorkflow = await readRepoFile(".github", "workflows", "deploy-cm5.yml");

    expect(installer).toContain("dpkg --print-architecture");
    expect(installer).toContain("CYBEROS_APT_MIRROR");
    expect(installer).toContain("CYBEROS_APT_SECURITY_MIRROR");
    expect(installer).toContain("CYBEROS_RPI_MIRROR");
    expect(installer).toContain("CYBEROS_NODE_MIRROR");
    expect(installer).toContain("mirrors.aliyun.com/nodejs-release");
    expect(installer).toContain("SHASUMS256.txt");
    expect(installer).toContain("CYBEROS_NPM_REGISTRY");
    expect(installer).toContain("CYBEROS_RUSTUP_INIT_URL");
    expect(installer).toContain("RUST_VERSION_REQUIRED=1.95.0");
    expect(installer).toContain('rustup" set auto-self-update disable');
    expect(installer).toContain("CYBEROS_APT_BACKUP_DIR");
    expect(installer).toContain("/cyberos/system-backups/apt");
    expect(installer).toContain("CYBEROS_APT_BACKUP_DIR must be under /cyberos/system-backups");
    expect(localeScript).toContain("CYBEROS_CONFIG_BACKUP_DIR must be under /cyberos/system-backups");
    expect(installer).toContain("mirrors.aliyun.com/debian");
    expect(installer).toContain("mirrors.aliyun.com/raspberrypi");
    expect(installer).toContain("disable_nodesource_sources");
    expect(installer).not.toContain("deb.nodesource.com/node_22.x");
    expect(installer).toContain("packaging/scripts/build-deb.sh");
    expect(installer).toContain("cyberos-first-boot.sh");
    expect(installer).toContain("CYBEROS_CONFIG_EXISTS=0");
    expect(installer).toContain("[ -e /cyberos/config/config.toml ]");
    expect(installer).toContain('if [ "$CYBEROS_CONFIG_EXISTS" = "0" ]; then');
    expect(installer).not.toContain("CYBEROS_EXISTING_INSTALL");
    expect(installer).toContain("CYBEROS_ENABLE_NGINX");
    expect(installer).toContain("CYBEROS_ENABLE_DOCKER");
    expect(installer).toContain("docker-cli");
    expect(installer).toContain("CYBEROS_ENABLE_VM");
    expect(installer).toContain("TERMINAL_USER=${CYBEROS_TERMINALD_USER:-cyberos}");
    expect(installer).not.toContain("${SUDO_USER:-}");
    expect(installer).toContain("CYBEROS_LOCALE");
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
    expect(installer).toContain("cyberos-nginx.sh");
    expect(installer).toContain("systemctl restart nginx");
    expect(installer).toContain("systemctl enable --now");
    expect(installer).toContain("systemctl restart cyberos-monitor.service");
    expect(installer).toContain("systemctl restart cyberos-alerter.service");
    expect(installer).toContain("systemctl start cyberos-health.service");
    expect(deployWorkflow).toContain("wait_for_alerter_ready");
    expect(deployWorkflow).toContain("after database checks");
    expect(deployWorkflow).toContain("===== CyberOS service journal =====");
    expect(deployWorkflow).toContain("-u cyberos-alerter.service");
    expect(buildDeb).toContain("registry.npmmirror.com");
    expect(buildDeb).toContain("CYBEROS_BUILD_COMMIT_SHA");
    expect(buildDeb).toContain("CYBEROS_BUILD_DIRTY");
    expect(buildDeb).toContain("CYBEROS_BUILD_SOURCE");
    expect(buildDeb).toContain("--exclude target");
    expect(rules).toContain("npm ci --registry");
    expect(rules).toContain("rm -rf debian/cyberos/usr/lib/cyberos/node_modules/@cyberos");
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
    expect(postinst).toContain("-m 0711 /cyberos/vm");
    expect(firstBoot).toContain("-m 0711 \"$ROOT_DIR/vm\" \"$ROOT_DIR/iso\"");
    expect(releaseWorkflow).not.toContain("dtolnay/rust-toolchain@1.95.0");
    expect(releaseWorkflow.match(/uses: dtolnay\/rust-toolchain@[0-9a-f]{40}/gu)).toHaveLength(3);
    expect(releaseWorkflow.match(/toolchain: 1\.95\.0/gu)).toHaveLength(3);
    expect(releaseWorkflow).toMatch(/package-arm64:[\s\S]*?apt-get install[\s\S]*?\n\s+acl \\/u);
    expect(deployWorkflow).toContain('repository_name="${GITHUB_REPOSITORY#*/}"');
    expect(deployWorkflow).toContain(
      'expected_subject="repo:${GITHUB_REPOSITORY_OWNER}@${GITHUB_REPOSITORY_OWNER_ID}/${repository_name}@${GITHUB_REPOSITORY_ID}:environment:production"'
    );
    expect(deployWorkflow).toContain('EXPECTED_SUBJECT="$expected_subject" OIDC_TOKEN="$oidc_token" node');
    expect(deployWorkflow).not.toContain("EXPECTED_SUBJECT: repo:");
    expect(deployWorkflow).not.toContain('failed_units="$(systemctl --failed --no-legend --plain || true)"');
    expect(deployWorkflow).toContain("awk '$1 ~ /^cyberos-/ { print }'");
    expect(deployWorkflow).toContain("[ -x /usr/local/bin/node ]");
    expect(deployWorkflow).toContain("CM5 runtime requires Node.js 22");
    expect(deployWorkflow).toContain("cyberos-indexer.service");
    expect(deployWorkflow.match(/cyberos-monitor\.service/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(deployWorkflow.match(/cyberos-alerter\.service/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
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
      "printf 'N\\\\n' | sudo -n /usr/local/sbin/cyberos-deploy --no-upgrade-backup"
    );
    expect(deployWorkflow).toContain('> "$RUNNER_TEMP/cm5-config.sha256"');
    expect(deployWorkflow).not.toContain("allow_legacy_migration");
    expect(deployWorkflow).not.toContain("migration-status");
    expect(deployWorkflow).not.toContain("staging_channel");
    expect(deployWorkflow).toContain('[ "$installed_status" = "install ok installed" ]');
    expect(deployWorkflow).toContain('[ "$actual_config_sha256" = "$expected_config_sha256" ]');
    expect(deployWorkflow).toContain("sudo -n /usr/local/sbin/cyberos-deploy --config-sha256");
    expect(deployWorkflow).toContain("sudo -n /usr/local/sbin/cyberos-deploy --database-check");
    expect(deployWorkflow).toContain("/usr/lib/cyberos/bin/cyberos-terminald");
    expect(deployWorkflow).toContain("cyberos-health.timer");
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
    expect(deployWorkflow).toContain("for (let attempt = 1; attempt <= 3; attempt += 1)");
    expect(deployWorkflow).toContain("const bestElapsedMs = Math.min(...latencySamplesMs)");
    expect(deployWorkflow).toContain("bestElapsedMs > 1000");
    expect(deployWorkflow).not.toContain("cyberos-terminal-helper.service");
    expect(deployWorkflow).not.toContain('cp "$package_path" "$release_dir/package.deb"');
    expect(deployWorkflow).not.toContain('"$release_dir/package.deb" \\\n            "$release_dir/release-manifest.json"');
  });

  it("ships a loopback API reverse proxy for LAN access", async () => {
    const nginx = await readPackagingFile("nginx", "cyberos.conf");
    const nginxScript = await readPackagingFile("scripts", "cyberos-nginx.sh");

    expect(nginx).toContain("listen __CYBEROS_NGINX_PORT__;");
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
    const unit = await readPackagingFile("systemd", "cyberos-hostd.service");

    expect(unit).toContain("User=root");
    expect(unit).not.toContain("StateDirectory=");
    expect(unit).not.toContain("LogsDirectory=");
    expect(unit).not.toContain("RuntimeDirectory=cyberos");
    expect(unit).toContain("systemd-tmpfiles-setup.service");
    expect(unit).toContain("Wants=NetworkManager.service");
    expect(unit).not.toContain("Wants=network-online.target");
    expect(unit).toContain("Environment=CYBEROS_CONFIG=/cyberos/config/config.toml");
    expect(unit).toContain("Environment=CYBEROS_ROOT=/cyberos");
    expect(unit).not.toContain("CYBEROS_HOSTD_SOCKET_PATH=");
    expect(unit).toContain("ExecStart=/usr/lib/cyberos/bin/cyberos-hostd");
    expect(unit).not.toContain("/node");
    expect(unit).toContain("TimeoutStopSec=180");
    expect(unit).toContain("/run/mdadm");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=/etc /run/cyberos /run/mdadm /cyberos/config /cyberos/data");
    expect(unit).toContain("ReadWritePaths=-/run/samba -/var/lib/samba -/var/cache/samba -/var/log/samba");
    expect(unit).toContain("ReadWritePaths=-/cyberos/state/hostd/docker-daemon /cyberos/state/hostd/network-manager /cyberos/state/hostd/bluetooth");
    expect(unit).not.toMatch(/ReadWritePaths=.*(?:^|\s)\/var\/lib\/cyberos(?:\s|$)/mu);
    expect(unit).not.toContain("/cyberos/logs");
    expect(unit).toContain("CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER");
    expect(unit).toContain("CAP_MKNOD");
    expect(unit).toContain("CAP_SYS_ADMIN");
    expect(unit).toContain("CAP_SYS_RAWIO");
    const apiUnit = await readPackagingFile("systemd", "cyberos-api.service");
    expect(apiUnit).toContain("User=cyberos");
    expect(apiUnit).toContain("CapabilityBoundingSet=");
    expect(apiUnit).not.toContain("/etc/docker");
    expect(apiUnit).not.toContain("/etc/NetworkManager");
    const postinst = await readPackagingFile("debian", "postinst");
    expect(postinst).not.toContain("migrate-");
    expect(postinst).toContain("/cyberos/state/hostd/docker-daemon");
    expect(postinst).toContain("/cyberos/state/hostd/network-manager");
    expect(postinst).toContain("/cyberos/state/hostd/bluetooth");
    expect(postinst).toContain("/cyberos/home/share");
    expect(postinst).toContain("usermod --home /cyberos/home/share cyberos-share");
    expect(postinst).toContain("/cyberos/apps");
    expect(install).not.toContain("migrate-");
    expect(install).not.toContain("migration-");
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/run\/cyberos/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/state/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/logs/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/data/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/vm/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/iso/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/apps/);
    expect(apiUnit).toMatch(/ReadWritePaths=.*\/cyberos\/config\/mcp/);
    expect(apiUnit).toContain("CapabilityBoundingSet=\n");
  });

  it("loads managed shares through each protocol's actual service entrypoint", async () => {
    const samba = await readPackagingFile("etc", "samba.conf");
    const smbd = await readPackagingFile("systemd", "smbd.service.d", "cyberos.conf");
    const vsftpd = await readPackagingFile("systemd", "vsftpd.service.d", "cyberos.conf");
    const minidlna = await readPackagingFile("systemd", "minidlna.service.d", "cyberos.conf");
    const webdav = await readPackagingFile("systemd", "cyberos-webdav.service");

    expect(samba).not.toContain("include = /etc/samba/smb.conf\n");
    expect(samba).toContain("map to guest = Bad User");
    expect(samba).toContain("include = /etc/samba/smb.conf.d/cyberos-shares.conf");
    expect(smbd).toContain("--configfile=/usr/share/cyberos/samba.conf");
    expect(vsftpd).toContain("/etc/vsftpd.d/cyberos-shares.conf");
    expect(minidlna).toContain("-f /etc/minidlna.d/cyberos.conf");
    expect(webdav).toContain("User=www-data");
    expect(webdav).toContain("-f /etc/apache2/sites-available/cyberos-webdav.conf");
    expect(webdav).toContain("RuntimeDirectory=cyberos-webdav");
    expect(webdav).toContain("ReadWritePaths=/run/cyberos-webdav /cyberos/data");
    expect(webdav).not.toContain("/run/cyberos/webdav");
  });

  it("ships an isolated Rust Terminal daemon", async () => {
    const unit = await readPackagingFile("systemd", "cyberos-terminald.service");
    const refresh = await readPackagingFile("scripts", "cyberos-refresh-terminald.sh");

    expect(unit).toContain("User=cyberos");
    expect(unit).toContain("Environment=CYBEROS_ROOT=/cyberos");
    expect(unit).toContain("ProtectHome=tmpfs");
    expect(unit).toContain("RestrictSUIDSGID=yes");
    expect(unit).toContain("terminald.sock");
    expect(unit).toContain("CapabilityBoundingSet=");
    expect(unit).toContain("InaccessiblePaths=/cyberos/config /cyberos/state /cyberos/logs");
    expect(unit).toContain("ReadWritePaths=/run/cyberos /cyberos/data /cyberos/home/terminal");
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("ExecStart=/usr/lib/cyberos/bin/cyberos-terminald");
    expect(unit).not.toContain("/node");
    expect(refresh).toContain("User=%s\\n");
    expect(refresh).toContain("WorkingDirectory=%s\\n");
    expect(refresh).not.toContain("BindPaths=%s\\n");
    expect(refresh).toContain("CYBEROS_TERMINALD_SOCKET_PATH");
    expect(refresh).toContain("CYBEROS_TERMINALD_CONNECT_TIMEOUT_MS");
    expect(refresh).toContain("terminal user must be cyberos");
    expect(refresh).toContain("escape_systemd_value()");
    expect(refresh).toContain("s/%/%%/g");
    expect(refresh).toContain('ReadWritePaths="%s"\\n');
    const postinst = await readPackagingFile("debian", "postinst");
    expect(postinst).toContain("ln -sfn /usr/lib/cyberos/scripts/cyberos-deploy /usr/local/sbin/cyberos-deploy");
    expect(postinst).not.toContain("legacy_terminal_home");
    expect(await readPackagingFile("scripts", "cyberos-nas-acl.sh")).toContain("findmnt -rn --mountpoint");
    expect(await readPackagingFile("scripts", "cyberos-nas-acl.sh")).toContain("getfacl --absolute-names");
  });

  it("ships a constrained CM5 deployment helper", async () => {
    const deploy = await readPackagingFile("scripts", "cyberos-deploy");
    const bootstrap = await readPackagingFile("scripts", "cyberos-deploy-bootstrap.sh");
    const nasAcl = await readPackagingFile("scripts", "cyberos-nas-acl.sh");

    expect(deploy).toContain("flock -n 9");
    expect(deploy).toContain("CYBEROS_DEPLOY_DIR must be under /cyberos/deploy");
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
      deploy.lastIndexOf('/usr/lib/cyberos/scripts/cyberos-deploy --activate-runtime "$work_dir" "$state_dir"')
    );
    expect(deploy).toContain("restore_unit_state \"$unit\" \"$state_dir\"");
    expect(deploy).toContain('STATEFUL_RUNTIME_UNITS="$TV_RUNTIME_TARGET $TIMERS $WRITERS"');
    expect(deploy).toContain(': > "$state_dir/$unit.recorded"');
    expect(deploy).toContain('restore_tv_runtime_state "$state_dir"');
    expect(deploy).toContain('restore_unit_state "$TV_RUNTIME_TARGET" "$state_dir"');
    expect(deploy).toContain("activate_runtime");
    expect(deploy).not.toContain("systemctl restart $RUNTIME_SERVICES");
    expect(deploy).not.toContain("systemctl enable --now $TIMERS");
    expect(deploy).toContain("systemctl start cyberos-health.service");
    expect(deploy).toContain('RUNTIME_SERVICES="$CORE_RUNTIME_SERVICES cyberos-monitor.service cyberos-alerter.service"');
    const activateRuntime = deploy.slice(
      deploy.indexOf("activate_runtime() {"),
      deploy.indexOf("\nverify_runtime() {")
    );
    const activationOrder = [
      "for unit in $STATEFUL_RUNTIME_UNITS; do",
      "systemctl enable $RUNTIME_SERVICES",
      "start_service_stably cyberos-hostd.service",
      "start_service_stably cyberos-terminald.service",
      "start_service_stably cyberos-api.service",
      "wait_for_url http://127.0.0.1:3010/health",
      'restore_unit_state cyberos-vod-player.service "$state_dir"',
      "start_service_stably cyberos-monitor.service",
      "start_service_stably cyberos-alerter.service",
      "systemctl start cyberos-health.service",
      "start_service_stably cyberos-worker@1.service",
      "start_service_stably cyberos-photos.service",
      "start_service_stably cyberos-downloader.service",
      "start_service_stably cyberos-bluetoothd.service",
      "start_service_stably cyberos-indexer.service",
      "systemctl enable $TIMERS",
      "systemctl start $TIMERS",
      'restore_tv_runtime_state "$state_dir"'
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
      "CORE_RUNTIME_SERVICES='cyberos-hostd.service cyberos-terminald.service cyberos-api.service cyberos-worker@1.service cyberos-photos.service cyberos-downloader.service cyberos-bluetoothd.service cyberos-indexer.service'"
    );
    expect(deploy).toContain('systemctl is-enabled --quiet "$unit"');
    expect(deploy).toContain('die "one or more services restarted during stabilization"');
    expect(deploy).toContain('version $manifest_version is already installed; recovering runtime and release state');
    const sameVersionRecovery = deploy.slice(
      deploy.indexOf('version $manifest_version is already installed; recovering runtime and release state'),
      deploy.indexOf('log "recovered $manifest_tag successfully"')
    );
    expect(sameVersionRecovery).toContain(
      '/usr/lib/cyberos/scripts/cyberos-deploy --activate-runtime "$work_dir" "$state_dir"'
    );
    expect(sameVersionRecovery).not.toContain("migrate-");
    expect(deploy).toContain('record_release "$manifest_tag" "$manifest_version" "$manifest_commit_sha"');
    expect(deploy).toContain('record_release "$manifest_tag" "$manifest_version" "$manifest_commit_sha"\n    cleanup_deployment_artifacts');
    expect(deploy).toContain("awk '$1 ~ /^cyberos-/ { print }'");
    expect(deploy).toContain('failure_dir="$BACKUP_DIR/${manifest_tag}-retry-${retry_timestamp}"');
    expect(deploy).toContain('capture_runtime_diagnostics "$failure_dir"');
    expect(deploy).toContain("SHARE_SERVICES='smbd.service nmbd.service cyberos-webdav.service vsftpd.service nfs-server.service minidlna.service'");
    expect(deploy).toContain("systemctl status $RUNTIME_SERVICES $OPTIONAL_RUNTIME_SERVICES cyberos-vod-player.service $SHARE_SERVICES");
    expect(deploy).toContain("-u cyberos-vod-player.service -u smbd.service");
    expect(deploy).toContain("-u vsftpd.service -u nfs-server.service -u minidlna.service");
    expect(deploy).toContain('cat "$target_diagnostics_path/services-status.txt" >&2');
    expect(deploy).toContain('cat "$target_diagnostics_path/services-journal.txt" >&2');
    expect(deploy).toContain("cleanup_deployment_artifacts");
    expect(deploy).not.toContain("migrate-");
    expect(deploy).not.toContain("migration-status");
    expect(deploy).toContain("--config-sha256");
    expect(deploy).toContain("--database-check");
    expect(deploy).toContain("PRAGMA user_version;");
    expect(deploy).toContain('database_format" = 3');
    expect(deploy).toContain("CyberOS database format must be 3");
    expect(deploy).toContain("--no-upgrade-backup)");
    expect(deploy).toContain('log "upgrade backups disabled for this deployment"');
    expect(deploy).toContain('if [ "$create_upgrade_backup" -eq 1 ]; then');
    expect(deploy).toContain("CyberOS configuration must be a regular file");
    expect(deploy).toContain("CyberOS database must be a regular file");
    expect(deploy).toContain("Keep the active release and one previous package");
    expect(deploy).toContain("Retention is an explicit operator action");
    expect(deploy).not.toContain('find "$BACKUP_DIR"');
    expect(deploy).toContain('find "$INCOMING_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +');
    expect(deploy).toContain("traverse outside BASE_DIR");
    expect(deploy).toContain('find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d -name \'work.*\'');
    expect(deploy).not.toContain("cyberos-share-helper.service");
    expect(deploy).not.toContain("cyberos-terminal-helper.service");
    expect(deploy).not.toContain("cyberos-player-helper.service");
    expect(deploy).toContain('tar -C /cyberos -czf "$backup_path/config.tgz" config');
    expect(deploy).toContain('tar -C /cyberos -czf "$backup_path/state.tgz" state home');
    expect(deploy).toContain("cyberos-terminald");
    expect(deploy).toContain("package.deb must be a regular file");
    expect(deploy).toContain("/api/system/storage");
    expect(deploy).toContain("/api/indexer/status");
    expect(deploy).toContain('status?.queue?.stalled === false');
    expect(deploy).toContain("/api/system/build-info");
    expect(bootstrap).toContain("/usr/local/sbin/cyberos-deploy");
    expect(bootstrap).toContain("/usr/lib/cyberos/scripts/cyberos-deploy");
    expect(bootstrap).toContain("CYBEROS_DEPLOY_DIR must be under /cyberos/deploy");
    expect(bootstrap).toContain("NOPASSWD: /usr/local/sbin/cyberos-deploy");
    expect(bootstrap).toContain('install -d -o root -g "$DEPLOY_USER" -m 0750 "$BASE_DIR"');
    expect(bootstrap).toContain("install -d -o root -g \"$DEPLOY_USER\" -m 0730");
    expect(bootstrap).toContain("chmod 0751 /cyberos");
    expect(bootstrap).toContain("/cyberos must be a real directory");
    expect(bootstrap).not.toContain("chmod 0755 /cyberos");
    expect(bootstrap).toContain("visudo -cf");
    expect(nasAcl).toContain('-path "$pool/.cyberos" -prune');
  });
});

function readPackagingFile(...segments: string[]): Promise<string> {
  return readFile(path.join(repoRoot, "packaging", ...segments), "utf8");
}

function readRepoFile(...segments: string[]): Promise<string> {
  return readFile(path.join(repoRoot, ...segments), "utf8");
}
