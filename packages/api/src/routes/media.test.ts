import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openCyberOsDb,
  replaceMediaArtwork,
  saveBluetoothSettings,
  upsertMediaCatalogEntry,
  type CyberOsDatabase
} from "@cyberos/db";
import { loadCyberOsRuntime, type VodPlayerStatus, type CyberOsRuntime } from "@cyberos/shared";
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
  it("defaults old TMDB settings to direct and requires a configured proxy before enabling", async () => {
    const initial = await server.inject({ method: "GET", url: "/api/media/settings" });
    expect(initial.json().settings.tmdbUseProxy).toBe(false);
    const missing = await server.inject({ method: "PATCH", url: "/api/media/settings", payload: { tmdbUseProxy: true } });
    expect(missing.statusCode).toBe(409);
    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
      "system_proxy_settings", JSON.stringify({ protocol: "http", host: "127.0.0.1", port: 7890, updatedAt: new Date().toISOString() }), new Date().toISOString()
    );
    const saved = await server.inject({ method: "PATCH", url: "/api/media/settings", payload: { tmdbUseProxy: true, tmdbReadAccessToken: "secret-token" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.tmdbUseProxy).toBe(true);
    const edit = await server.inject({ method: "PATCH", url: "/api/media/settings", payload: { language: "en-US" } });
    expect(edit.json().settings).toMatchObject({ tmdbUseProxy: true, tmdbTokenConfigured: true });
    expect((await server.inject({ method: "PATCH", url: "/api/media/settings", payload: { tmdbUseProxy: "yes" } })).statusCode).toBe(400);
  });

  it("reports damaged settings and allows PATCH repair", async () => {
    db.prepare("INSERT INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
      "media_library_settings",
      JSON.stringify({ language: 42 }),
      new Date().toISOString()
    );

    const damaged = await server.inject({ method: "GET", url: "/api/media/settings" });
    expect(damaged.statusCode).toBe(409);
    expect(damaged.json()).toMatchObject({ state: "attention" });

    const repaired = await server.inject({
      method: "PATCH",
      url: "/api/media/settings",
      payload: { language: "en-US", region: "US" }
    });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().settings).toMatchObject({ language: "en-US", region: "US" });
  });

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
    const filters = await server.inject({ method: "GET", url: "/api/media/filter-options" });
    expect(filters.statusCode).toBe(200);
    expect(filters.json()).toEqual({ years: [2016], genres: [] });
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
    expect(candidates.json().candidates[0].posterUrl).toBe("/api/media/tmdb/images/w500/arrival.jpg");
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
      payload: { startPositionSeconds: 120, expectedSessionId: "music-session" }
    });
    expect(played.statusCode).toBe(200);
    expect(playerCommands).toEqual([expect.objectContaining({
      type: "play",
            storagePoolId: poolId,
      relativePath: "Movies/Arrival.2016.mkv",
      mediaFileId: stored.file.id,
      startPositionSeconds: 120,
      expectedSessionId: "music-session"
    })]);
    expect(playerCommands[0]).not.toHaveProperty("audioDeviceId");
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

  it("routes search, candidate images and uncached artwork through the configured proxy", async () => {
    const destinations: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      destinations.push(request.url!);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const port = (proxy.address() as AddressInfo).port;
    db.prepare("INSERT INTO system_settings (key,value_json,updated_at) VALUES ('system_proxy_settings',?,'now')").run(JSON.stringify({ protocol: "http", host: "127.0.0.1", port, updatedAt: new Date().toISOString() }));
    await server.inject({ method: "PATCH", url: "/api/media/settings", payload: { tmdbReadAccessToken: "test-only-token", tmdbUseProxy: true } });
    const source = (await createSource()).json().source;
    const stored = upsertMediaCatalogEntry(db, {
      sourceId: source.id, generation: "proxy-test",
      title: { kind: "movie", sourcePath: "Movies/Proxy", title: "Proxy", metadataSource: "filename", matchStatus: "unmatched" },
      file: { relativePath: "Movies/proxy.mkv", name: "proxy.mkv", mimeType: "video/x-matroska", sizeBytes: 1, mtimeMs: 1 }
    });
    const [art] = replaceMediaArtwork(db, { titleId: stored.title.id, artwork: [{ kind: "poster", source: "tmdb", sourceUrl: "https://image.tmdb.org/t/p/w500/test.jpg", cacheKey: "tmdb/w500/test.jpg", width: null, height: null, language: null, primary: true }] });
    const actual = Fastify();
    registerMediaRoutes(actual, { config: testConfig(), db, system: storageSystem() } as unknown as ApiRouteContext);
    try {
      for (const url of [`/api/media/titles/${stored.title.id}/match-candidates`, "/api/media/tmdb/images/w500/test.jpg", `/api/media/artwork/${art!.id}`]) {
        expect((await actual.inject({ method: "GET", url })).statusCode).toBe(502);
      }
      expect(destinations).toEqual(["api.themoviedb.org:443", "image.tmdb.org:443", "image.tmdb.org:443"]);
    } finally {
      await actual.close();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("bounds candidate images and rejects arbitrary hosts and traversal paths", async () => {
    const requests: string[] = [];
    const actual = Fastify();
    registerMediaRoutes(actual, { config: testConfig(), db } as unknown as ApiRouteContext, {
      fetchTmdb: async (url) => {
        requests.push(String(url));
        return requests.length === 1 ? new Response("test-image") : new Response("x", { headers: { "content-length": String(16 * 1024 * 1024) } });
      }
    });
    try {
      const image = await actual.inject({ method: "GET", url: "/api/media/tmdb/images/w500/test.jpg" });
      expect(image.statusCode).toBe(200);
      expect(image.payload).toBe("test-image");
      expect((await actual.inject({ method: "GET", url: "/api/media/tmdb/images/w500/large.jpg" })).statusCode).toBe(502);
      for (const url of ["/api/media/tmdb/images/original/test.jpg", "/api/media/tmdb/images/w500/http%3A%2F%2F127.0.0.1.jpg", "/api/media/tmdb/images/w500/..%2Ftest.jpg"]) {
        expect((await actual.inject({ method: "GET", url })).statusCode).toBe(400);
      }
      expect(requests).toEqual(["https://image.tmdb.org/t/p/w500/test.jpg", "https://image.tmdb.org/t/p/w500/large.jpg"]);
    } finally {
      await actual.close();
    }
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

function testConfig(): CyberOsRuntime {
  const rootDir = temporaryDirectory;
  const base = loadCyberOsRuntime({ CYBEROS_ROOT: rootDir }, rootDir);
  return {
    ...base,
    paths: { ...base.paths, dataRoot: path.dirname(root), databasePath: path.join(rootDir, "cyberos.sqlite") },
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50, concurrency: 1 },
    admin: { displayName: "Test", authMode: "local-only" },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1000, consoleShells: [] },
    hostd: { socketPath: "/tmp/hostd.sock" },
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
