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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-map-"));
    const missingConfig = path.join(tempDir, "missing.toml");
    expect(loadConfig({ SIGMAOS_CONFIG: missingConfig } as NodeJS.ProcessEnv, tempDir).photostaff).toEqual({
      baseMapUrl: PHOTOSTAFF_BASE_MAP_RELEASE_URL
    });

    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, `[photostaff]\nbasemap_url = "https://mirror.example.test/from-toml.pmtiles"\n`);
    expect(loadConfig({ SIGMAOS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir).photostaff).toEqual({
      baseMapUrl: "https://mirror.example.test/from-toml.pmtiles"
    });
    expect(loadConfig({
      SIGMAOS_CONFIG: configPath,
      SIGMAOS_PHOTOSTAFF_BASEMAP_URL: "https://mirror.example.test/from-env.pmtiles"
    } as NodeJS.ProcessEnv, tempDir).photostaff).toEqual({
      baseMapUrl: "https://mirror.example.test/from-env.pmtiles"
    });
    expect(() => loadConfig({
      SIGMAOS_CONFIG: configPath,
      SIGMAOS_PHOTOSTAFF_BASEMAP_URL: "http://mirror.example.test/map.pmtiles"
    } as NodeJS.ProcessEnv, tempDir!)).toThrow("must use HTTPS");
  });

  it("defaults file access to the system root when no roots are configured", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-"));
    const config = loadConfig(
      {
        SIGMAOS_CONFIG: path.join(tempDir, "missing.toml")
      } as NodeJS.ProcessEnv,
      tempDir
    );

    expect(config.nasRoots).toEqual([
      {
        id: "local",
        name: "System root",
        path: path.parse(path.resolve(tempDir)).root
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
        username: "sigma-share",
        password: null
      },
      shares: []
    });
    expect(config.hostd).toEqual({ socketPath: "/run/sigmaos/hostd.sock" });
    expect(config.terminal).toEqual({
      user: null,
      termuxSocketPath: "/run/sigmaos/termux.sock",
      sessionIdleTimeoutMs: 1_800_000,
      connectTimeoutMs: 10_000,
      maxSessions: 32
    });
    expect(config.vodPlayer).toEqual({
      enabled: false,
      socketPath: "/run/sigmaos/vod-player.sock",
      statePath: "/var/lib/sigmaos-vod-player/session.json",
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
      user: "sigmaos"
    });
  });

  it("loads VOD Player settings from TOML and environment overrides", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      `
        [vod_player]
        enabled = true
        socket_path = "/run/custom/vod-player.sock"
        state_path = "/var/lib/custom-vod-player/session.json"
        drm_connector = "HDMI-A-1"
        audio_device = "alsa/plughw:1,0"
        hwdec = "auto"
        user = "operator"
      `
    );

    expect(loadConfig({ SIGMAOS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir).vodPlayer).toMatchObject({
      enabled: true,
      socketPath: "/run/custom/vod-player.sock",
      statePath: "/var/lib/custom-vod-player/session.json",
      drmConnector: "HDMI-A-1",
      audioDevice: "alsa/plughw:1,0",
      hwdec: "auto",
      user: "operator"
    });
    expect(loadConfig({
      SIGMAOS_CONFIG: configPath,
      SIGMAOS_VOD_PLAYER_ENABLED: "0",
      SIGMAOS_VOD_PLAYER_SOCKET_PATH: "/run/override-vod-player.sock"
    } as NodeJS.ProcessEnv, tempDir).vodPlayer).toMatchObject({
      enabled: false,
      socketPath: "/run/override-vod-player.sock"
    });
  });

  it("rejects unsafe or internally inconsistent VOD Player settings", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-player-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, `[vod_player]\nuser = "root"\nsocket_path = "relative.sock"\n`);
    expect(() => loadConfig({ SIGMAOS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir!))
      .toThrow("socket_path and state_path must be absolute");
    await writeFile(configPath, `[vod_player]\nretry_base_delay_ms = 1000\nretry_max_delay_ms = 500\n`);
    expect(() => loadConfig({ SIGMAOS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir!))
      .toThrow("retry_max_delay_ms must be at least retry_base_delay_ms");
    await writeFile(configPath, `[vod_player]\nhwdec = "unsafe"\n`);
    expect(() => loadConfig({ SIGMAOS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir!))
      .toThrow("output configuration is invalid");
    await writeFile(configPath, `[vod_player]\nsocket_path = "/tmp/vod-player.sock"\n`);
    expect(() => loadConfig({ SIGMAOS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir!))
      .toThrow("cannot use /tmp or /var/tmp");
  });

  it("rejects removed player environment variables", () => {
    expect(() => loadConfig({ SIGMAOS_PLAYER_ENABLED: "1" } as NodeJS.ProcessEnv, process.cwd()))
      .toThrow("SIGMAOS_PLAYER_ENABLED is no longer supported");
  });

  it("loads Docker settings from TOML", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-"));
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

        [[docker.compose_roots]]
        id = "apps"
        name = "Apps"
        path = "compose/apps"
      `
    );

    const config = loadConfig({ SIGMAOS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir);

    expect(config.docker).toMatchObject({
      enabled: true,
      socketPath: "/tmp/docker.sock",
      composeCommand: "/usr/bin/docker",
      operationTimeoutMs: 45_000,
      consoleShells: ["/bin/sh"]
    });
  });

  it("loads the terminal user and Termux socket from TOML and environment", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      `
        [terminal]
        user = "zhubby"
        termux_socket_path = "/tmp/termux.sock"
      `
    );

    expect(loadConfig({ SIGMAOS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir).terminal).toEqual({
      user: "zhubby",
      termuxSocketPath: "/tmp/termux.sock",
      sessionIdleTimeoutMs: 1_800_000,
      connectTimeoutMs: 10_000,
      maxSessions: 32
    });
    expect(loadConfig({
      SIGMAOS_CONFIG: configPath,
      SIGMAOS_TERMUX_USER: "operator",
      SIGMAOS_TERMUX_SOCKET_PATH: "/run/operator-termux.sock"
    } as NodeJS.ProcessEnv, tempDir).terminal).toEqual({
      user: "operator",
      termuxSocketPath: "/run/operator-termux.sock",
      sessionIdleTimeoutMs: 1_800_000,
      connectTimeoutMs: 10_000,
      maxSessions: 32
    });
  });

  it("lets the hostd socket environment override the TOML value", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, `[hostd]\nsocket_path = "/tmp/toml-hostd.sock"\n`);

    expect(loadConfig({ SIGMAOS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir).hostd).toEqual({
      socketPath: "/tmp/toml-hostd.sock"
    });
    expect(loadConfig({
      SIGMAOS_CONFIG: configPath,
      SIGMAOS_HOSTD_SOCKET_PATH: "/run/override-hostd.sock"
    } as NodeJS.ProcessEnv, tempDir).hostd).toEqual({
      socketPath: "/run/override-hostd.sock"
    });
  });

  it("loads Docker settings from environment overrides", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-"));
    const config = loadConfig(
      {
        SIGMAOS_CONFIG: path.join(tempDir, "missing.toml"),
        SIGMAOS_DOCKER_ENABLED: "1",
        SIGMAOS_DOCKER_SOCKET_PATH: "/tmp/env-docker.sock",
        SIGMAOS_DOCKER_COMPOSE_COMMAND: "/opt/bin/docker",
        SIGMAOS_DOCKER_OPERATION_TIMEOUT_MS: "90000",
        SIGMAOS_DOCKER_CONSOLE_SHELLS: "/bin/sh,/bin/bash",
        SIGMAOS_DOCKER_COMPOSE_ROOTS: "media:Media:compose/media,lab:Lab:/srv/lab"
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-"));
    const config = loadConfig(
      {
        SIGMAOS_CONFIG: path.join(tempDir, "missing.toml"),
        SIGMAOS_ENVIRONMENT: "production",
        SIGMAOS_NAS_ROOTS: "primary:Primary:/srv/nas"
      } as NodeJS.ProcessEnv,
      tempDir
    );

    expect(config.nasRoots).toEqual([
      {
        id: "primary",
        name: "Primary",
        path: "/srv/nas",
        mountPolicy: "required",
        expectedSource: null,
        expectedUuid: null,
        expectedFstype: null
      }
    ]);
  });

  it("rejects production NAS roots that expose the managed Docker Apps path", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-"));
    const configDir = tempDir;
    const environment = {
      SIGMAOS_CONFIG: path.join(configDir, "missing.toml"),
      SIGMAOS_ENVIRONMENT: "production"
    } as NodeJS.ProcessEnv;

    expect(() => loadConfig({
      ...environment,
      SIGMAOS_NAS_ROOTS: "system:System:/srv"
    }, configDir)).toThrow("must not overlap /srv/apps");
    expect(() => loadConfig({
      ...environment,
      SIGMAOS_NAS_ROOTS: "apps:Apps:/srv/apps/data"
    }, configDir)).toThrow("must not overlap /srv/apps");
  });

  it("loads share settings from TOML", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-config-"));
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      `
        [hostd]
        socket_path = "/tmp/hostd.sock"

        [shares]
        enabled = true
        account_username = "sigma-share"

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
        friendly_name = "Sigma Media"
      `
    );

    const config = loadConfig({ SIGMAOS_CONFIG: configPath } as NodeJS.ProcessEnv, tempDir);

    expect(config.hostd).toEqual({ socketPath: "/tmp/hostd.sock" });
    expect(config.shares).toMatchObject({
      enabled: true,
      account: {
        username: "sigma-share",
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
              friendlyName: "Sigma Media"
            }
          }
        }
      ]
    });
  });
});
