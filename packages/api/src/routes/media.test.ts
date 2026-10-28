import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openCyberOsDb,
  replaceMediaArtwork,
  saveBluetoothSettings,
  upsertMediaCatalogEntry,
  type CyberOsDatabase
} from "@cyberos/db";
import { loadConfig, type VodPlayerStatus, type CyberOsConfig } from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import type { VodPlayerRuntime } from "../lib/vod-player.js";
import { registerMediaRoutes } from "./media.js";

const poolId = "pool-1";
const poolDevice = "/dev/md/pool-1";
let temporaryDirectory: string;
let root: string;
let db: CyberOsDatabase;
let server: FastifyInstance;
let playerCommands: unknown[];
let candidateSearches: unknown[];

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cyberos-media-api-"));
  root = path.join(temporaryDirectory, "data", poolId);
  await mkdir(path.join(root, "Movies"), { recursive: true });
  db = openCyberOsDb(path.join(temporaryDirectory, "cyberos.sqlite"));
  playerCommands = [];
  candidateSearches = [];
  server = Fastify();
  registerMediaRoutes(server, {
    config: testConfig(),
    db,
    system: storageSystem(),
    vodPlayer: fakePlayer(playerCommands)
  } as unknown as ApiRouteContext, {
    searchTmdb: async (input) => {
      candidateSearches.push(input);
      return [{
        tmdbId: 329865,
        kind: input.kind,
        title: "Arrival",
        originalTitle: "Arrival",
        overview: "First contact",
        year: 2016,
        releaseDate: "2016-11-11",
        originalLanguage: "en",
        posterUrl: "https://image.tmdb.org/t/p/w500/arrival.jpg",
        backdropUrl: null,
        popularity: 42
      }];
    }
  });
});

afterEach(async () => {
  await server.close();
  db.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Media API", () => {
  it("redacts TMDB credentials and validates source paths", async () => {
    const saved = await server.inject({
      method: "PATCH",
      url: "/api/media/settings",
      payload: { tmdbReadAccessToken: "secret-token", language: "zh-CN", region: "CN" }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ settings: expect.objectContaining({ tmdbTokenConfigured: true, language: "zh-CN", region: "CN" }) });
    expect(saved.payload).not.toContain("secret-token");
    expect((await server.inject({ method: "GET", url: "/api/media/settings" })).payload).not.toContain("secret-token");

    const traversal = await server.inject({
      method: "POST",
      url: "/api/media/sources",
      payload: { name: "Movies", kind: "movie",  storagePoolId: poolId, path: "../outside" }
    });
    expect(traversal.statusCode).toBe(400);

    const created = await createSource();
    expect(created.statusCode).toBe(201);
    expect(created.json().source).toEqual(expect.objectContaining({ path: "Movies", kind: "movie" }));
    expect(created.json().scan.status).toBe("queued");
  });

  it("serves the TV catalog, records progress, corrects matches, and starts playback", async () => {
    const source = (await createSource()).json().source;
    const stored = upsertMediaCatalogEntry(db, {
      sourceId: source.id,
      generation: "generation-1",
      title: {
        kind: "movie",
        sourcePath: "Movies/Arrival (2016)",
        title: "Arrival",
        year: 2016,
        metadataSource: "filename",
        matchStatus: "unmatched"
      },
      file: {
        relativePath: "Movies/Arrival.2016.mkv",
        name: "Arrival.2016.mkv",
        mimeType: "video/x-matroska",
        sizeBytes: 5,
        mtimeMs: 1
      }
    });
    await writeFile(path.join(root, "Movies", "Arrival.2016.mkv"), "video");

    const home = await server.inject({ method: "GET", url: "/api/media/home" });
    expect(home.statusCode).toBe(200);
    expect(home.json().movies).toEqual([expect.objectContaining({ id: stored.title.id, title: "Arrival" })]);
    const detail = await server.inject({ method: "GET", url: `/api/media/titles/${stored.title.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().title.files[0].id).toBe(stored.file.id);

    const filtered = await server.inject({ method: "GET", url: "/api/media/titles?matchStatus=unmatched" });
    expect(filtered.json().titles).toEqual([expect.objectContaining({ id: stored.title.id })]);
    expect((await server.inject({ method: "GET", url: "/api/media/titles?matchStatus=invalid" })).statusCode).toBe(400);

    const missingToken = await server.inject({
      method: "GET",
      url: `/api/media/titles/${stored.title.id}/match-candidates`
    });
    expect(missingToken.statusCode).toBe(409);
    await server.inject({
      method: "PATCH",
      url: "/api/media/settings",
      payload: { tmdbReadAccessToken: "secret-token", language: "zh-CN", region: "CN" }
    });
    const candidates = await server.inject({
      method: "GET",
      url: `/api/media/titles/${stored.title.id}/match-candidates?query=Arrival`
    });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json().candidates).toEqual([expect.objectContaining({ tmdbId: 329865 })]);
    expect(candidateSearches).toEqual([expect.objectContaining({
      token: "secret-token",
      kind: "movie",
      query: "Arrival",
      language: "zh-CN",
      region: "CN",
      limit: 10
    })]);

    const progress = await server.inject({
      method: "POST",
      url: `/api/media/files/${stored.file.id}/progress`,
      payload: { positionSeconds: 900, durationSeconds: 1_000 }
    });
    expect(progress.json().progress.completed).toBe(true);

    const matched = await server.inject({
      method: "PUT",
      url: `/api/media/titles/${stored.title.id}/match`,
      payload: { tmdbId: 329865 }
    });
    expect(matched.json().title).toEqual(expect.objectContaining({ tmdbId: 329865, matchStatus: "matched" }));

    saveBluetoothSettings(db, { defaultAudioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF" });
    const played = await server.inject({
      method: "POST",
      url: `/api/media/files/${stored.file.id}/play`,
      payload: { startPositionSeconds: 120 }
    });
    expect(played.statusCode).toBe(200);
    expect(playerCommands).toEqual([expect.objectContaining({
      type: "play",
            storagePoolId: poolId,
      relativePath: "Movies/Arrival.2016.mkv",
      mediaFileId: stored.file.id,
      audioDeviceId: "bluetooth:AA:BB:CC:DD:EE:FF",
      startPositionSeconds: 120
    })]);
  });

  it("serves local artwork only from inside its configured source", async () => {
    const source = (await createSource()).json().source;
    const stored = upsertMediaCatalogEntry(db, {
      sourceId: source.id,
      generation: "generation-1",
      title: {
        kind: "movie",
        sourcePath: "Movies/Poster",
        title: "Poster",
        metadataSource: "filename",
        matchStatus: "unmatched"
      },
      file: {
        relativePath: "Movies/poster.mkv",
        name: "poster.mkv",
        mimeType: "video/x-matroska",
        sizeBytes: 1,
        mtimeMs: 1
      }
    });
    await writeFile(path.join(root, "Movies", "poster.jpg"), "poster-image");
    const [artwork] = replaceMediaArtwork(db, {
      titleId: stored.title.id,
      artwork: [{
        kind: "poster",
        source: "local",
        sourceUrl: null,
        cacheKey: `local/${source.id}/Movies/poster.jpg`,
        width: null,
        height: null,
        language: null,
        primary: true
      }]
    });
    const response = await server.inject({ method: "GET", url: `/api/media/artwork/${artwork!.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.payload).toBe("poster-image");

    db.prepare("UPDATE media_artwork SET cache_key = ? WHERE id = ?")
      .run(`local/${source.id}/../outside.jpg`, artwork!.id);
    expect((await server.inject({ method: "GET", url: `/api/media/artwork/${artwork!.id}` })).statusCode).toBe(404);
  });
});

async function createSource() {
  return await server.inject({
    method: "POST",
    url: "/api/media/sources",
    payload: { name: "Movies", kind: "movie",  storagePoolId: poolId, path: "Movies" }
  });
}

function fakePlayer(commands: unknown[]): VodPlayerRuntime {
  return {
    async getStatus() {
      return playerStatus();
    },
    async command(command) {
      commands.push(command);
      return playerStatus();
    }
  };
}

function playerStatus(): VodPlayerStatus {
  return {
    state: "playing",
    sessionId: "session-1",
    serviceInstanceId: "instance-1",
    revision: 1,
        storagePoolId: poolId,
    relativePath: "Movies/Arrival.2016.mkv",
    fileName: "Arrival.2016.mkv",
    mediaFileId: null,
    videoOutput: "drm",
    positionSeconds: 120,
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

function storageSystem() {
  return {
    commandRunner: {
      async run(command: string) {
        if (command === "findmnt") {
          return JSON.stringify({ filesystems: [{ source: poolDevice, target: root, fstype: "ext4", size: 1000, used: 100, avail: 900, "use%": "10%" }] });
        }
        if (command === "mdadm") return `ARRAY ${poolDevice} name=${poolId} UUID=test`;
        if (command === "smartctl") return JSON.stringify({ devices: [] });
        return JSON.stringify({ blockdevices: [] });
      }
    }
  };
}

function testConfig(): CyberOsConfig {
  const rootDir = temporaryDirectory;
  const base = loadConfig({ CYBEROS_CONFIG: path.join(rootDir, "missing.toml"), CYBEROS_ROOT: rootDir }, rootDir);
  return {
    ...base,
    paths: { ...base.paths, dataRoot: path.dirname(root), databasePath: path.join(rootDir, "cyberos.sqlite") },
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50, concurrency: 1 },
    admin: { displayName: "Test", authMode: "local-only" },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1000, consoleShells: [] },
    hostd: { socketPath: "/tmp/hostd.sock", mutationPolicy: "mutable" },
    shares: { enabled: false, account: { username: "share", password: null }, shares: [] },
    terminal: { user: "test-user", socketPath: "/tmp/terminald.sock", sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: {
      enabled: true,
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
  };
}
