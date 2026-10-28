import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { PHOTOSTAFF_BASE_MAP_RELEASE_URL } from "./photostaff-config.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("loadConfig", () => {
  it("loads the fixed Photostaff base map URL and allows only HTTPS mirrors", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-map-"));
    const missingConfig = path.join(tempDir, "missing.toml");
    expect(loadConfig({ CYBEROS_CONFIG: missingConfig } as NodeJS.ProcessEnv, tempDir).photostaff).toEqual({
      baseMapUrl: PHOTOSTAFF_BASE_MAP_RELEASE_URL
    });

    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, `[photostaff]\nbasemap_url = "https://mirror.example.test/from-toml.pmtiles"\n`);
    expect(loadConfig({ CYBEROS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir).photostaff).toEqual({
      baseMapUrl: "https://mirror.example.test/from-toml.pmtiles"
    });
    expect(loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_PHOTOSTAFF_BASEMAP_URL: "https://mirror.example.test/from-env.pmtiles"
    } as NodeJS.ProcessEnv, tempDir).photostaff).toEqual({
      baseMapUrl: "https://mirror.example.test/from-env.pmtiles"
    });
    expect(() => loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_PHOTOSTAFF_BASEMAP_URL: "http://mirror.example.test/map.pmtiles"
    } as NodeJS.ProcessEnv, tempDir!)).toThrow("must use HTTPS");
  });

  it("defaults development paths to the isolated CyberOS root", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const config = loadConfig(
      {
        CYBEROS_CONFIG: path.join(tempDir, "missing.toml")
      } as NodeJS.ProcessEnv,
      tempDir
    );

    const rootDir = path.join(tempDir, ".cyberos", "dev-root");
    expect(config).toMatchObject({
      rootDir,
      stateDir: path.join(rootDir, "state"),
      dataDir: path.join(rootDir, "state"),
      databasePath: path.join(rootDir, "state", "cyberos.sqlite"),
      metricsDatabasePath: path.join(rootDir, "state", "metrics.sqlite"),
      dataRoot: path.join(rootDir, "data"),
      appsRoot: path.join(rootDir, "apps"),
      isoRoot: path.join(rootDir, "iso"),
      vmRoot: path.join(rootDir, "vm"),
      backupRoot: path.join(rootDir, "data", "backup")
    });
    expect(config.monitoring).toEqual({
      enabled: true,
      fastSampleIntervalMs: 10_000,
      standardSampleIntervalMs: 30_000,
      temperatureSampleIntervalMs: 300_000,
      rawRetentionMs: 172_800_000,
      minuteRetentionMs: 2_592_000_000,
      hourRetentionMs: 31_536_000_000,
      maxDatabaseBytes: 536_870_912
    });
    expect(config.nasRoots).toEqual([
      {
        id: "primary",
        name: "Primary data",
        path: path.join(rootDir, "data", "primary")
      }
    ]);
    expect(config.docker).toMatchObject({
      enabled: false,
      socketPath: "/var/run/docker.sock",
      composeCommand: "docker",
      operationTimeoutMs: 120_000,
      consoleShells: ["/bin/sh", "/bin/bash"]
    });
    expect(config.shares).toMatchObject({
      enabled: false,
      account: {
        username: "cyberos-share",
        password: null
      },
      shares: []
    });
    expect(config.hostd).toEqual({ socketPath: "/run/cyberos/hostd.sock", mutationPolicy: "mutable" });
    expect(config.terminal).toEqual({
      user: null,
      termuxSocketPath: "/run/cyberos/termux.sock",
      sessionIdleTimeoutMs: 1_800_000,
      connectTimeoutMs: 10_000,
      maxSessions: 32
    });
    expect(config.vodPlayer).toEqual({
      enabled: false,
      socketPath: "/run/cyberos/vod-player.sock",
      statePath: path.join(rootDir, "state", "vod-player", "session.json"),
      commandTimeoutMs: 5_000,
      startupTimeoutMs: 15_000,
      checkpointIntervalMs: 5_000,
      retryBaseDelayMs: 2_000,
      retryMaxDelayMs: 60_000,
      videoOutput: "drm",
      drmConnector: null,
      audioOutput: "alsa",
      audioDevice: null,
      hwdec: "auto-safe",
      user: "cyberos"
    });
  });

  it("loads VOD Player settings from TOML and environment overrides", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      `
        [vod_player]
        enabled = true
        socket_path = "/run/custom/vod-player.sock"
        state_path = "${path.join(tempDir, ".cyberos", "dev-root", "state", "vod-player", "session.json")}"
        drm_connector = "HDMI-A-1"
        audio_device = "alsa/plughw:1,0"
        hwdec = "auto"
        user = "operator"
      `
    );

    expect(loadConfig({ CYBEROS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir).vodPlayer).toMatchObject({
      enabled: true,
      socketPath: "/run/custom/vod-player.sock",
      statePath: path.join(tempDir, ".cyberos", "dev-root", "state", "vod-player", "session.json"),
      drmConnector: "HDMI-A-1",
      audioDevice: "alsa/plughw:1,0",
      hwdec: "auto",
      user: "operator"
    });
    expect(loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_VOD_PLAYER_ENABLED: "0",
      CYBEROS_VOD_PLAYER_SOCKET_PATH: "/run/override-vod-player.sock"
    } as NodeJS.ProcessEnv, tempDir).vodPlayer).toMatchObject({
      enabled: false,
      socketPath: "/run/override-vod-player.sock"
    });
  });

  it("rejects unsafe or internally inconsistent VOD Player settings", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-player-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, `[vod_player]\nuser = "root"\nsocket_path = "relative.sock"\n`);
    expect(() => loadConfig({ CYBEROS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir!))
      .toThrow("socket_path and state_path must be absolute");
    await writeFile(configPath, `[vod_player]\nretry_base_delay_ms = 1000\nretry_max_delay_ms = 500\n`);
    expect(() => loadConfig({ CYBEROS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir!))
      .toThrow("retry_max_delay_ms must be at least retry_base_delay_ms");
    await writeFile(configPath, `[vod_player]\nhwdec = "unsafe"\n`);
    expect(() => loadConfig({ CYBEROS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir!))
      .toThrow("output configuration is invalid");
    expect(() => loadConfig({
      CYBEROS_CONFIG: "/cyberos/config/config.toml",
      CYBEROS_ENVIRONMENT: "production",
      CYBEROS_VOD_PLAYER_SOCKET_PATH: "/tmp/vod-player.sock"
    } as NodeJS.ProcessEnv, tempDir!))
      .toThrow("cannot use /tmp or /var/tmp");
  });

  it("loads Docker settings from TOML", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      `
        [docker]
        enabled = true
        socket_path = "/tmp/docker.sock"
        compose_command = "/usr/bin/docker"
        operation_timeout_ms = 45000
        console_shells = ["/bin/sh"]
      `
    );

    const config = loadConfig({ CYBEROS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir);

    expect(config.docker).toMatchObject({
      enabled: true,
      socketPath: "/tmp/docker.sock",
      composeCommand: "/usr/bin/docker",
      operationTimeoutMs: 45_000,
      consoleShells: ["/bin/sh"]
    });
  });

  it("loads the terminal user and Termux socket from TOML and environment", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      `
        [terminal]
        user = "zhubby"
        termux_socket_path = "/tmp/termux.sock"
      `
    );

    expect(loadConfig({ CYBEROS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir).terminal).toEqual({
      user: "zhubby",
      termuxSocketPath: "/tmp/termux.sock",
      sessionIdleTimeoutMs: 1_800_000,
      connectTimeoutMs: 10_000,
      maxSessions: 32
    });
    expect(loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_TERMUX_USER: "operator",
      CYBEROS_TERMUX_SOCKET_PATH: "/run/operator-termux.sock"
    } as NodeJS.ProcessEnv, tempDir).terminal).toEqual({
      user: "operator",
      termuxSocketPath: "/run/operator-termux.sock",
      sessionIdleTimeoutMs: 1_800_000,
      connectTimeoutMs: 10_000,
      maxSessions: 32
    });
  });

  it("lets the hostd socket environment override the TOML value", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, `[hostd]\nsocket_path = "/tmp/toml-hostd.sock"\n`);

    expect(loadConfig({ CYBEROS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir).hostd).toEqual({
      socketPath: "/tmp/toml-hostd.sock",
      mutationPolicy: "mutable"
    });
    expect(loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_HOSTD_SOCKET_PATH: "/run/override-hostd.sock"
    } as NodeJS.ProcessEnv, tempDir).hostd).toEqual({
      socketPath: "/run/override-hostd.sock",
      mutationPolicy: "mutable"
    });
  });

  it("loads and validates the host mutation policy", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, "");

    expect(loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_HOST_MUTATION_POLICY: "declarative"
    } as NodeJS.ProcessEnv, tempDir!).hostd.mutationPolicy).toBe("declarative");
    expect(() => loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_HOST_MUTATION_POLICY: "automatic"
    } as NodeJS.ProcessEnv, tempDir!)).toThrow("CYBEROS_HOST_MUTATION_POLICY");
  });

  it("loads Docker settings from environment overrides", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const config = loadConfig(
      {
        CYBEROS_CONFIG: path.join(tempDir, "missing.toml"),
        CYBEROS_DOCKER_ENABLED: "1",
        CYBEROS_DOCKER_SOCKET_PATH: "/tmp/env-docker.sock",
        CYBEROS_DOCKER_COMPOSE_COMMAND: "/opt/bin/docker",
        CYBEROS_DOCKER_OPERATION_TIMEOUT_MS: "90000",
        CYBEROS_DOCKER_CONSOLE_SHELLS: "/bin/sh,/bin/bash"
      } as NodeJS.ProcessEnv,
      tempDir
    );

    expect(config.docker).toMatchObject({
      enabled: true,
      socketPath: "/tmp/env-docker.sock",
      composeCommand: "/opt/bin/docker",
      operationTimeoutMs: 90_000,
      consoleShells: ["/bin/sh", "/bin/bash"]
    });
  });

  it("defaults environment-configured production roots to required mounts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const config = loadConfig(
      {
        CYBEROS_CONFIG: "/cyberos/config/config.toml",
        CYBEROS_ENVIRONMENT: "production",
        CYBEROS_NAS_ROOTS: "primary:Primary:/cyberos/data/primary"
      } as NodeJS.ProcessEnv,
      tempDir
    );

    expect(config.nasRoots).toEqual([
      {
        id: "primary",
        name: "Primary",
        path: "/cyberos/data/primary",
        mountPolicy: "required",
        expectedSource: null,
        expectedUuid: null,
        expectedFstype: null
      }
    ]);
    expect(config).toMatchObject({
      rootDir: "/cyberos",
      stateDir: "/cyberos/state",
      databasePath: "/cyberos/state/cyberos.sqlite",
      metricsDatabasePath: "/cyberos/state/metrics.sqlite",
      dataRoot: "/cyberos/data",
      appsRoot: "/cyberos/apps",
      isoRoot: "/cyberos/iso",
      vmRoot: "/cyberos/vm",
      backupRoot: "/cyberos/data/backup"
    });
  });

  it("loads and validates monitoring settings", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-monitoring-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, `
      [monitoring]
      enabled = false
      fast_sample_interval_ms = 5000
      standard_sample_interval_ms = 15000
      temperature_sample_interval_ms = 60000
      raw_retention_ms = 7200000
      minute_retention_ms = 10800000
      hour_retention_ms = 14400000
      max_database_bytes = 67108864
    `);

    expect(loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_MONITORING_ENABLED: "1",
      CYBEROS_MONITORING_FAST_SAMPLE_INTERVAL_MS: "6000"
    } as NodeJS.ProcessEnv, tempDir).monitoring).toEqual({
      enabled: true,
      fastSampleIntervalMs: 6000,
      standardSampleIntervalMs: 15000,
      temperatureSampleIntervalMs: 60000,
      rawRetentionMs: 7200000,
      minuteRetentionMs: 10800000,
      hourRetentionMs: 14400000,
      maxDatabaseBytes: 67108864
    });

    expect(() => loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_MONITORING_MAX_DATABASE_BYTES: "1048576"
    } as NodeJS.ProcessEnv, tempDir!)).toThrow("max_database_bytes");
    expect(() => loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_MONITORING_STANDARD_SAMPLE_INTERVAL_MS: "1000"
    } as NodeJS.ProcessEnv, tempDir!)).toThrow("standard_sample_interval_ms");
    expect(() => loadConfig({
      CYBEROS_CONFIG: configPath,
      CYBEROS_MONITORING_MINUTE_RETENTION_MS: "3600000"
    } as NodeJS.ProcessEnv, tempDir!)).toThrow("minute_retention_ms");
  });

  it("rejects noncanonical production root and config paths", () => {
    expect(() => loadConfig({
      CYBEROS_CONFIG: "/cyberos/config/config.toml",
      CYBEROS_ENVIRONMENT: "production",
      CYBEROS_ROOT: "/opt/cyberos"
    } as NodeJS.ProcessEnv, process.cwd())).toThrow("Production CyberOS root must be /cyberos");
    expect(() => loadConfig({
      CYBEROS_CONFIG: "/tmp/cyberos-config.toml",
      CYBEROS_ENVIRONMENT: "production"
    } as NodeJS.ProcessEnv, process.cwd())).toThrow("Production CyberOS config must be /cyberos/config/config.toml");
  });

  it("rejects production NAS roots outside direct /cyberos/data children", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const configDir = tempDir;
    const environment = {
      CYBEROS_CONFIG: "/cyberos/config/config.toml",
      CYBEROS_ENVIRONMENT: "production"
    } as NodeJS.ProcessEnv;

    expect(() => loadConfig({
      ...environment,
      CYBEROS_NAS_ROOTS: "system:System:/outside"
    }, configDir)).toThrow("must be direct children of /cyberos/data");
    expect(() => loadConfig({
      ...environment,
      CYBEROS_NAS_ROOTS: "nested:Nested:/cyberos/data/primary/nested"
    }, configDir)).toThrow("must be direct children of /cyberos/data");
    expect(() => loadConfig({
      ...environment,
      CYBEROS_NAS_ROOTS: "backup:Backup:/cyberos/data/backup"
    }, configDir)).toThrow("must be direct children of /cyberos/data");
    expect(() => loadConfig({
      ...environment,
      CYBEROS_NAS_ROOTS: "apps:Apps:/cyberos/apps/data"
    }, configDir)).toThrow("must not overlap /cyberos/apps");
  });

  it("rejects production VM, VOD Player, and backup paths outside their CyberOS directories", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-paths-"));
    const base = {
      CYBEROS_CONFIG: "/cyberos/config/config.toml",
      CYBEROS_ENVIRONMENT: "production",
      CYBEROS_NAS_ROOTS: "primary:Primary:/cyberos/data/primary"
    } as NodeJS.ProcessEnv;

    expect(() => loadConfig({ ...base, CYBEROS_VM_STORAGE_PATH: "/cyberos/state/vms" }, tempDir!))
      .toThrow("VM storage must be under /cyberos/vm");
    expect(() => loadConfig({ ...base, CYBEROS_VM_ISO_ROOTS: "/cyberos/data/primary/iso" }, tempDir!))
      .toThrow("VM ISO roots must be under /cyberos/iso");
    expect(() => loadConfig({ ...base, CYBEROS_VOD_PLAYER_STATE_PATH: "/cyberos/state/player.json" }, tempDir!))
      .toThrow("VOD Player state must be under /cyberos/state/vod-player");
    expect(() => loadConfig({
      ...base,
      CYBEROS_BACKUP_ENABLED: "1",
      CYBEROS_BACKUP_REPOSITORY: "/cyberos/data/primary/backups"
    }, tempDir!)).toThrow("Production backup repository must be configured under /cyberos/data/backup");
    expect(() => loadConfig({
      ...base,
      CYBEROS_BACKUP_ENABLED: "1",
      CYBEROS_BACKUP_REPOSITORY: "/cyberos/data/backup/restic",
      CYBEROS_BACKUP_STAGING_PATH: "/cyberos/logs/backup-staging"
    }, tempDir!)).toThrow("Backup staging must be under /cyberos/state");

    const passwordFile = path.join(tempDir, "restic-password");
    await writeFile(passwordFile, "secret\n");
    expect(() => loadConfig({
      ...base,
      CYBEROS_BACKUP_ENABLED: "1",
      CYBEROS_BACKUP_REPOSITORY: "/cyberos/data/backup/restic",
      CYBEROS_BACKUP_PASSWORD_FILE: passwordFile
    }, tempDir!)).toThrow("Backup password file must be under /cyberos/config");
  });

  it("rejects removed data and database path overrides", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const cwd = tempDir;
    expect(() => loadConfig({
      CYBEROS_ROOT: path.join(cwd, "root"),
      CYBEROS_DATA_DIR: path.join(cwd, "state")
    } as NodeJS.ProcessEnv, cwd)).toThrow("CYBEROS_DATA_DIR");
    expect(() => loadConfig({
      CYBEROS_ROOT: path.join(cwd, "root"),
      CYBEROS_DATABASE_PATH: path.join(cwd, "db.sqlite")
    } as NodeJS.ProcessEnv, cwd)).toThrow("CYBEROS_DATABASE_PATH");
  });

  it("loads share settings from TOML", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-config-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      `
        [hostd]
        socket_path = "/tmp/hostd.sock"

        [shares]
        enabled = true
        account_username = "cyberos-share"

        [[shares.items]]
        id = "media"
        name = "Media"
        root_id = "primary"
        path = "media"
        description = "LAN media"

        [shares.items.smb]
        enabled = true
        read_only = false
        browseable = true

        [shares.items.webdav]
        enabled = true
        port = 8090
        path_prefix = "/dav/media"

        [shares.items.ftp]
        enabled = true
        port = 2021
        passive_port_start = 51000
        passive_port_end = 51010

        [shares.items.nfs]
        enabled = true
        allowed_cidrs = ["192.168.1.0/24"]

        [shares.items.dlna]
        enabled = true
        media_types = ["audio", "video"]
        bind_interface = "eth0"
        friendly_name = "CyberOS Media"
      `
    );

    const config = loadConfig({ CYBEROS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir);

    expect(config.hostd).toEqual({ socketPath: "/tmp/hostd.sock", mutationPolicy: "mutable" });
    expect(config.shares).toMatchObject({
      enabled: true,
      account: {
        username: "cyberos-share",
        password: null
      },
      shares: [
        {
          id: "media",
          name: "Media",
          rootId: "primary",
          path: "media",
          description: "LAN media",
          protocols: {
            smb: {
              enabled: true,
              readOnly: false,
              browseable: true,
              allowGuest: false
            },
            webdav: {
              enabled: true,
              port: 8090,
              pathPrefix: "/dav/media"
            },
            ftp: {
              enabled: true,
              port: 2021,
              passivePortStart: 51000,
              passivePortEnd: 51010
            },
            nfs: {
              enabled: true,
              allowedCidrs: ["192.168.1.0/24"],
              rootSquash: true
            },
            dlna: {
              enabled: true,
              mediaTypes: ["audio", "video"],
              bindInterface: "eth0",
              friendlyName: "CyberOS Media"
            }
          }
        }
      ]
    });
  });
});
