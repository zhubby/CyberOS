import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMcpClient,
  ensureNasRoots,
  openZosDb,
  savePhotostaffLibrarySettings,
  upsertPhotostaffAsset,
  type ZosDatabase
} from "@zos/db";
import { registerMcp } from "@zos/mcp";
import { PHOTOSTAFF_DATA_DIRECTORY_NAME, type ZosConfig } from "@zos/shared";
import {
  createFileExportMcpResource,
  createMcpResourceResponder,
  createPhotoExportMcpResource,
  createPhotoMediaMcpResource,
  McpResourceError
} from "./mcp-resources.js";

let tempDir: string;
let rootDir: string;
let db: ZosDatabase;
let app: ReturnType<typeof Fastify>;
let config: ZosConfig;
let client: ReturnType<typeof createMcpClient>;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-mcp-resources-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir, { recursive: true });
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "primary", name: "Primary", path: rootDir }]);
  client = createMcpClient(db, { name: "Resource client", kind: "local", scopes: ["zos:files:read", "zos:photos:read"] });
  config = testConfig(tempDir, rootDir);
  app = Fastify();
  registerMcp(app, {
    db,
    config,
    resourceResponder: createMcpResourceResponder({ db, config })
  }, { enabled: true });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("MCP resource responder", () => {
  it("streams a bounded file ZIP and rejects changed export sources", async () => {
    await mkdir(path.join(rootDir, "docs"));
    await writeFile(path.join(rootDir, "docs", "one.txt"), "one", "utf8");
    const first = await createFileExportMcpResource({
      db,
      clientId: client.id,
      baseUrl: "http://127.0.0.1:3010",
      rootId: "primary",
      paths: ["docs"],
      archiveName: "docs"
    }) as { url: string };

    const download = await downloadResource(first.url);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/zip");
    expect(download.rawPayload.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(download.rawPayload.toString("latin1")).toContain("docs/one.txt");

    const changed = await createFileExportMcpResource({
      db,
      clientId: client.id,
      baseUrl: "http://127.0.0.1:3010",
      rootId: "primary",
      paths: ["docs"]
    }) as { url: string };
    await writeFile(path.join(rootDir, "docs", "one.txt"), "changed content", "utf8");
    const stale = await downloadResource(changed.url);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "resource_changed" });
  });

  it("rejects symlinks in file exports before issuing a token", async () => {
    await writeFile(path.join(rootDir, "source.txt"), "source", "utf8");
    await symlink(path.join(rootDir, "source.txt"), path.join(rootDir, "linked.txt"));
    await expect(createFileExportMcpResource({
      db,
      clientId: client.id,
      baseUrl: "http://127.0.0.1:3010",
      rootId: "primary",
      paths: ["linked.txt"]
    })).rejects.toBeInstanceOf(McpResourceError);
  });

  it("serves indexed originals, derivatives, compatible video, and photo ZIPs", async () => {
    const settings = savePhotostaffLibrarySettings(db, {
      rootId: "primary",
      storagePoolId: "pool-1",
      path: "Photos"
    });
    await mkdir(path.join(rootDir, "Photos"));
    const photo = await addAsset(settings, "image.jpg", Buffer.from("original-image"), "image/jpeg", {
      thumbnailKey: "thumbnail/image.webp",
      previewKey: "preview/image.webp"
    });
    const video = await addAsset(settings, "clip.mp4", Buffer.from("compatible-video"), "video/mp4");
    const thumbnailPath = path.join(tempDir, PHOTOSTAFF_DATA_DIRECTORY_NAME, "thumbnail", "image.webp");
    await mkdir(path.dirname(thumbnailPath), { recursive: true });
    await writeFile(thumbnailPath, "thumbnail", "utf8");

    const original = await createPhotoMediaMcpResource({
      db, config, clientId: client.id, baseUrl: "http://127.0.0.1:3010", assetId: photo.id, variant: "original"
    }) as { url: string };
    expect((await downloadResource(original.url)).body).toBe("original-image");

    const thumbnail = await createPhotoMediaMcpResource({
      db, config, clientId: client.id, baseUrl: "http://127.0.0.1:3010", assetId: photo.id, variant: "thumbnail"
    }) as { url: string };
    const thumbnailDownload = await downloadResource(thumbnail.url);
    expect(thumbnailDownload.body).toBe("thumbnail");
    expect(thumbnailDownload.headers["content-type"]).toContain("image/webp");

    const videoLink = await createPhotoMediaMcpResource({
      db, config, clientId: client.id, baseUrl: "http://127.0.0.1:3010", assetId: video.id, variant: "video"
    }) as { url: string };
    expect((await downloadResource(videoLink.url)).body).toBe("compatible-video");

    const archive = await createPhotoExportMcpResource({
      db,
      clientId: client.id,
      baseUrl: "http://127.0.0.1:3010",
      assetIds: [photo.id, video.id]
    }) as { url: string };
    const archiveDownload = await downloadResource(archive.url);
    expect(archiveDownload.rawPayload.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(archiveDownload.rawPayload.toString("latin1")).toContain("image.jpg");
    expect(archiveDownload.rawPayload.toString("latin1")).toContain("clip.mp4");
  });
});

async function addAsset(
  settings: ReturnType<typeof savePhotostaffLibrarySettings>,
  name: string,
  body: Buffer,
  mimeType: string,
  derivatives: { thumbnailKey?: string; previewKey?: string } = {}
) {
  const relativePath = path.join("Photos", name);
  const absolutePath = path.join(rootDir, relativePath);
  await writeFile(absolutePath, body);
  const metadata = await stat(absolutePath);
  return upsertPhotostaffAsset(db, {
    settings,
    path: relativePath,
    name,
    mimeType,
    sizeBytes: metadata.size,
    mtimeMs: metadata.mtimeMs,
    contentHash: createHash("sha256").update(body).digest("hex"),
    width: mimeType.startsWith("image/") ? 100 : null,
    height: mimeType.startsWith("image/") ? 80 : null,
    orientation: mimeType.startsWith("image/") ? 1 : null,
    takenAt: "2026-01-01T00:00:00.000Z",
    takenAtSource: "file_mtime",
    thumbnailKey: derivatives.thumbnailKey ?? null,
    previewKey: derivatives.previewKey ?? null,
    status: "ready",
    error: null
  });
}

async function downloadResource(url: string) {
  return app.inject({
    method: "GET",
    url: new URL(url).pathname,
    headers: { host: "127.0.0.1", authorization: `Bearer ${client.token}` }
  });
}

function testConfig(dataDir: string, root: string): ZosConfig {
  return {
    environment: "development",
    dataDir,
    databasePath: path.join(dataDir, "zos.sqlite"),
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 100 },
    admin: { displayName: "Admin", authMode: "local-only" },
    model: { provider: "pi", piCommand: "pi", localEndpoint: null },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 1_000, consoleShells: ["/bin/sh"] },
    hostd: { socketPath: path.join(dataDir, "hostd.sock") },
    shares: { enabled: false, account: { username: "zos", password: null }, shares: [] },
    terminal: { user: "zos", termuxSocketPath: path.join(dataDir, "termux.sock"), sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: path.join(dataDir, "vod.sock"), statePath: path.join(dataDir, "vod.json"), commandTimeoutMs: 1_000, startupTimeoutMs: 1_000, checkpointIntervalMs: 1_000, retryBaseDelayMs: 100, retryMaxDelayMs: 1_000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: "default", hwdec: "auto-safe", user: "zos" },
    nasRoots: [{ id: "primary", name: "Primary", path: root }]
  };
}
