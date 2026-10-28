import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureNasRoots, listOperationNotifications, openCyberOsDb, saveBluetoothSettings, type CyberOsDatabase } from "@cyberos/db";
import type { CyberOsConfig, VodPlayerStatus } from "@cyberos/shared";
import { VodPlayerRuntimeError, type VodPlayerRuntime } from "../lib/vod-player.js";
import { buildServer } from "../server.js";

const poolId = "/dev/md/test-pool";
let tempDir: string | null = null;
let db: CyberOsDatabase | null = null;

afterEach(async () => {
  db?.close();
  db = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("VOD Player API", () => {
  it("passes only scoped identifiers and a relative path to the daemon", async () => {
    const { server, root } = await setup();
    const calls: unknown[] = [];
    const app = await buildServer({
      config: testConfig(root, true),
      db: db!,
      system: storageSystem(root),
      vodPlayer: fakeRuntime(calls)
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/vod-player/command",
      payload: { type: "play", rootId: "local", storagePoolId: poolId, path: "clip.mp4" }
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{ type: "play", rootId: "local", storagePoolId: poolId, relativePath: "clip.mp4" }]);
    await app.close();

    const traversal = await server.inject({
      method: "POST",
      url: "/api/vod-player/command",
      payload: { type: "play", rootId: "local", storagePoolId: poolId, path: "../clip.mp4" }
    });
    expect(traversal.statusCode).toBe(400);
    await server.close();
  });

  it("uses only the Bluetooth audio device selected in system settings", async () => {
    const { root } = await setup();
    const calls: unknown[] = [];
    saveBluetoothSettings(db!, { defaultAudioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF" });
    const app = await buildServer({
      config: testConfig(root, true),
      db: db!,
      system: storageSystem(root),
      vodPlayer: fakeRuntime(calls)
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/vod-player/command",
      payload: { type: "play", rootId: "local", storagePoolId: poolId, path: "clip.mp4" }
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([expect.objectContaining({
      type: "play",
      audioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF"
    })]);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/vod-player/command",
      payload: {
        type: "play",
        rootId: "local",
        storagePoolId: poolId,
        path: "clip.mp4",
        audioDeviceId: "alsa/hw:0"
      }
    });
    expect(rejected.statusCode).toBe(400);
    expect(calls).toHaveLength(1);
    await app.close();
  });

  it("removes the old player routes and exposes disabled status", async () => {
    const { server } = await setup();
    expect((await server.inject({ method: "GET", url: "/api/player/status" })).statusCode).toBe(404);
    const status = await server.inject({ method: "GET", url: "/api/vod-player/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json().status.errorCode).toBe("VOD_PLAYER_DISABLED");
    await server.close();
  });

  it("rejects unsupported media before contacting the daemon", async () => {
    const { server, root } = await setup();
    await writeFile(path.join(root, "notes.txt"), "text");
    const app = await buildServer({
      config: testConfig(root, true),
      db: db!,
      system: storageSystem(root),
      vodPlayer: fakeRuntime([])
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/vod-player/command",
      payload: { type: "play", rootId: "local", storagePoolId: poolId, path: "notes.txt" }
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA" });
    await app.close();
    await server.close();
  });

  it("maps storage inventory failures to a stable unavailable error", async () => {
    const { server, root } = await setup();
    const app = await buildServer({
      config: testConfig(root, true),
      db: db!,
      vodPlayer: fakeRuntime([])
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/vod-player/command",
      payload: { type: "play", rootId: "local", storagePoolId: poolId, path: "clip.mp4" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await app.close();
    await server.close();
  });

  it("requires session-bound controls and maps daemon conflicts", async () => {
    const { server, root } = await setup();
    const conflict: VodPlayerRuntime = {
      async getStatus() { return vodPlayerStatus(); },
      async command() { throw new VodPlayerRuntimeError("Playback session changed", 409, "SESSION_CONFLICT"); }
    };
    const app = await buildServer({ config: testConfig(root, true), db: db!, vodPlayer: conflict });
    const missing = await app.inject({
      method: "POST",
      url: "/api/vod-player/command",
      payload: { type: "pause" }
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: "SESSION_CONFLICT" });

    const stale = await app.inject({
      method: "POST",
      url: "/api/vod-player/command",
      payload: { type: "pause", sessionId: "stale-session" }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "SESSION_CONFLICT" });
    await app.close();
    await server.close();
  });

  it("reports recovering playback as degraded health", async () => {
    const { server, root } = await setup();
    const runtime = fakeRuntime([]);
    runtime.getStatus = async () => ({
      ...vodPlayerStatus(),
      state: "recovering",
      retryCount: 2,
      nextRetryAt: new Date(Date.now() + 2_000).toISOString(),
      error: "DRM output is unavailable",
      errorCode: "DRM_UNAVAILABLE"
    });
    const app = await buildServer({ config: testConfig(root, true), db: db!, vodPlayer: runtime });
    const health = await app.inject({ method: "GET", url: "/api/system/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      vodPlayer: { status: "degraded", state: "recovering", errorCode: "DRM_UNAVAILABLE" }
    });
    expect(health.json().issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "vod_player_recovering", severity: "warning" })
    ]));
    await app.close();
    await server.close();
  });

  it("persists one notification per playback session when Bluetooth audio falls back", async () => {
    const { server, root } = await setup();
    const runtime = fakeRuntime([]);
    runtime.getStatus = async () => ({
      ...vodPlayerStatus(),
      audioDeviceId: "bluetooth:adapter-hci0/AA:BB:CC:DD:EE:FF",
      audioFallbackReason: "BlueALSA device unavailable"
    });
    const app = await buildServer({ config: testConfig(root, true), db: db!, vodPlayer: runtime });

    await app.inject({ method: "GET", url: "/api/vod-player/status" });
    await app.inject({ method: "GET", url: "/api/vod-player/status" });

    expect(listOperationNotifications(db!)).toEqual([
      expect.objectContaining({
        operationId: "vod-audio-fallback:session-1",
        kind: "media",
        status: "failed",
        error: "BlueALSA device unavailable"
      })
    ]);
    await app.close();
    await server.close();
  });
});

async function setup(): Promise<{ server: Awaited<ReturnType<typeof buildServer>>; root: string }> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-vod-player-api-"));
  const root = path.join(tempDir, "root");
  await mkdir(root);
  await writeFile(path.join(root, "clip.mp4"), "video");
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: root }]);
  const server = await buildServer({ config: testConfig(root, false), db, system: storageSystem(root) });
  return { server, root };
}

function testConfig(root: string, enabled: boolean): CyberOsConfig {
  return {
    environment: "development",
    dataDir: path.dirname(root),
    databasePath: path.join(path.dirname(root), "cyberos.sqlite"),
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50 },
    admin: { displayName: "Test", authMode: "local-only" },
    model: { provider: "pi", piCommand: "pi", localEndpoint: null },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1000, consoleShells: [] },
    hostd: { socketPath: "/tmp/hostd.sock" },
    shares: { enabled: false, account: { username: "share", password: null }, shares: [] },
    terminal: { user: "test-user", termuxSocketPath: "/tmp/termux.sock" },
    vodPlayer: {
      enabled,
      socketPath: "/tmp/vod-player.sock",
      statePath: "/tmp/vod-player-session.json",
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
    },
    nasRoots: [{ id: "local", name: "Local", path: root }]
  };
}

function storageSystem(root: string) {
  return {
    commandRunner: {
      async run(command: string) {
        if (command === "findmnt") return JSON.stringify({ filesystems: [{ source: poolId, target: root, fstype: "ext4", size: 1000, used: 100, avail: 900, "use%": "10%" }] });
        if (command === "mdadm") return "ARRAY /dev/md/test-pool name=test UUID=test";
        if (command === "smartctl") return JSON.stringify({ devices: [] });
        return JSON.stringify({ blockdevices: [] });
      }
    }
  };
}

function fakeRuntime(calls: unknown[]): VodPlayerRuntime {
  return {
    async getStatus() { return vodPlayerStatus(); },
    async command(command) {
      calls.push(command);
      return vodPlayerStatus();
    }
  };
}

function vodPlayerStatus(): VodPlayerStatus {
  return {
    state: "playing",
    sessionId: "session-1",
    serviceInstanceId: "instance-1",
    revision: 1,
    rootId: "local",
    storagePoolId: poolId,
    relativePath: "clip.mp4",
    fileName: "clip.mp4",
    mediaFileId: null,
    videoOutput: "drm",
    positionSeconds: 0,
    durationSeconds: null,
    volume: 100,
    retryCount: 0,
    nextRetryAt: null,
    audioDeviceId: null,
    effectiveAudioDeviceId: null,
    audioFallbackReason: null,
    audioTracks: [],
    subtitleTracks: [],
    selectedAudioTrackId: null,
    selectedSubtitleTrackId: null,
    capabilities: { mpvAvailable: true, drmAvailable: true, audioAvailable: true, hardwareDecode: "unknown", error: null },
    error: null,
    errorCode: null,
    updatedAt: new Date().toISOString()
  };
}
