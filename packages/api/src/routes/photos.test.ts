import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimNextPhotosJob,
  enqueuePhotosJob,
  finishPhotosJob,
  getPhotosLibrarySettings,
  openCyberOsDb,
  upsertPhotosAsset,
  type PhotosMetadataWriteInput,
  type CyberOsDatabase
} from "@cyberos/db";
import { loadCyberOsRuntime, PHOTOS_METADATA_SCHEMA_VERSION, type PhotosLibrarySettingsRecord, type CyberOsRuntime } from "@cyberos/shared";
import { buildServer } from "../server.js";
import {
  PhotosMapArchiveManager,
  type PhotosMapArchiveSource
} from "../lib/photos-map.js";

const poolId = "pool-1";
const poolDevice = "/dev/md/pool-1";
let tempDir: string | null = null;
let db: CyberOsDatabase | null = null;

afterEach(async () => {
  db?.close();
  db = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("photos API", () => {
  it("serves and validates processing settings and worker health", async () => {
    const { app } = await setup();

    const defaults = await app.inject({ method: "GET", url: "/api/settings/photos" });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().settings).toMatchObject({
      processingConcurrency: 1,
      maxAutoRetries: 5,
      commandTimeoutMs: 120_000,
      maxDecodedPixels: 268_402_689
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/settings/photos",
      payload: { processingConcurrency: 4, maxAutoRetries: 8, minFreeSpaceBytes: 1024 }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings).toMatchObject({
      processingConcurrency: 4,
      maxAutoRetries: 8,
      minFreeSpaceBytes: 1024
    });

    const rejected = await app.inject({
      method: "PATCH",
      url: "/api/settings/photos",
      payload: { processingConcurrency: 5 }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("between 1 and 4");

    const heartbeatAt = new Date().toISOString();
    db!.prepare(`
      INSERT INTO photos_workers (worker_id, version, started_at, heartbeat_at)
      VALUES ('worker-1', 'test', ?, ?)
    `).run(heartbeatAt, heartbeatAt);
    const status = await app.inject({ method: "GET", url: "/api/photos/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: { state: "unconfigured" },
      workerHealth: { status: "ready", freshWorkers: 1, lastHeartbeatAt: heartbeatAt }
    });

    await configure(app);
    db!.prepare("DELETE FROM photos_workers").run();
    const health = await app.inject({ method: "GET", url: "/api/system/health" });
    expect(health.json()).toMatchObject({
      status: "failed",
      photos: { status: "unavailable", queuedJobs: 1 }
    });
    expect(health.json().issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "photos_unavailable", severity: "critical" })
    ]));
    await app.close();
  });

  it("configures a library, reports scan state, and returns a stable timeline", async () => {
    const { app, root } = await setup();
    const configured = await configure(app);
    expect(configured.statusCode).toBe(200);
    expect(configured.json().settings.path).toBe("Photos");

    const settings = getPhotosLibrarySettings(db!)!;
    completeInitialScan(settings);
    const firstAsset = await addPhotos(root, settings, "one.jpg", "2025-01-02T00:00:00.000Z");
    await addPhotos(root, settings, "two.jpg", "2025-01-01T00:00:00.000Z");

    const status = await app.inject({ method: "GET", url: "/api/photos/status" });
    expect(status.json().status).toMatchObject({ state: "ready", total: 2 });
    const first = await app.inject({ method: "GET", url: "/api/photos?limit=1" });
    expect(first.statusCode).toBe(200);
    expect(first.json().photos.map((photo: { name: string }) => photo.name)).toEqual(["one.jpg"]);
    expect(first.json().nextCursor).toEqual(expect.any(String));
    const second = await app.inject({ method: "GET", url: `/api/photos?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}` });
    expect(second.json().photos.map((photo: { name: string }) => photo.name)).toEqual(["two.jpg"]);
    const record = await app.inject({ method: "GET", url: `/api/photos/${firstAsset.id}/record` });
    expect(record.json()).toMatchObject({ photo: { id: firstAsset.id, name: "one.jpg" } });
    expect(record.json()).not.toHaveProperty("photos");
    expect((await app.inject({ method: "GET", url: "/api/photos?cursor=bad" })).statusCode).toBe(400);
    await app.close();
  });

  it("paginates filename sorting with the same SQLite case folding used by the cursor", async () => {
    const { app, root } = await setup();
    await configure(app);
    const settings = getPhotosLibrarySettings(db!)!;
    completeInitialScan(settings);
    await addPhotos(root, settings, "Ä-first.jpg", "2025-01-02T00:00:00.000Z");
    await addPhotos(root, settings, "Ö-second.jpg", "2025-01-01T00:00:00.000Z");

    const first = await app.inject({
      method: "POST",
      url: "/api/photos/query",
      payload: { sort: { field: "name", direction: "asc" }, limit: 1 }
    });
    expect(first.json().photos.map((photo: { name: string }) => photo.name)).toEqual(["Ä-first.jpg"]);
    const second = await app.inject({
      method: "POST",
      url: "/api/photos/query",
      payload: {
        sort: { field: "name", direction: "asc" },
        limit: 1,
        cursor: first.json().nextCursor
      }
    });
    expect(second.json().photos.map((photo: { name: string }) => photo.name)).toEqual(["Ö-second.jpg"]);
    await app.close();
  });

  it("streams originals and rejects duplicate uploads after the initial scan", async () => {
    const { app, root } = await setup();
    await configure(app);
    const settings = getPhotosLibrarySettings(db!)!;
    const earlyUpload = await app.inject({
      method: "PUT",
      url: "/api/photos/upload?name=too-early.jpg",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("too-early")
    });
    expect(earlyUpload.statusCode).toBe(409);
    expect(earlyUpload.json().error).toContain("initial photo scan");
    completeInitialScan(settings);

    const uploadedVideo = await app.inject({
      method: "PUT",
      url: "/api/photos/upload?name=clip.MP4",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("video-upload")
    });
    expect(uploadedVideo.statusCode).toBe(201);
    const uploadedRaw = await app.inject({
      method: "PUT",
      url: "/api/photos/upload?name=camera.CR3",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("raw-upload")
    });
    expect(uploadedRaw.statusCode).toBe(201);
    const unsupported = await app.inject({
      method: "PUT",
      url: "/api/photos/upload?name=notes.txt",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("text-upload")
    });
    expect(unsupported.statusCode).toBe(400);

    const body = Buffer.from("jpeg-like-test-data");
    const existing = await addPhotos(root, settings, "existing.jpg", "2025-01-01T00:00:00.000Z", body);

    const original = await app.inject({ method: "GET", url: `/api/photos/${existing.id}/original?download=1` });
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload).toEqual(body);
    expect(original.headers["content-disposition"]).toContain("existing.jpg");

    const duplicate = await app.inject({
      method: "PUT",
      url: "/api/photos/upload?name=copy.jpg",
      headers: { "content-type": "application/octet-stream" },
      payload: body
    });
    expect(duplicate.statusCode).toBe(409);

    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/photos/upload?name=new.jpg",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("new-photos")
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().path).toBe(path.join("Photos", "new.jpg"));
    const secondUpload = await app.inject({
      method: "PUT",
      url: "/api/photos/upload?name=second.jpg",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("second-photos")
    });
    expect(secondUpload.statusCode).toBe(201);
    const pendingDuplicate = await app.inject({
      method: "PUT",
      url: "/api/photos/upload?name=new-copy.jpg",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("new-photos")
    });
    expect(pendingDuplicate.statusCode).toBe(409);
    expect(pendingDuplicate.json().duplicate).toMatchObject({ path: path.join("Photos", "new.jpg") });
    await app.close();
  });

  it("streams native photos videos and reuses the transcode cache for other containers", async () => {
    const { app, root } = await setup();
    await configure(app);
    const settings = getPhotosLibrarySettings(db!)!;
    completeInitialScan(settings);
    const native = await addPhotos(root, settings, "native.mp4", "2025-01-01T00:00:00.000Z", Buffer.from("native-video"), "video/mp4");
    const webm = await addPhotos(root, settings, "native.webm", "2025-01-01T00:00:00.000Z", Buffer.from("native-webm"), "video/webm");
    const converted = await addPhotos(root, settings, "converted.mkv", "2025-01-01T00:00:00.000Z", Buffer.from("source-video"), "video/x-matroska");
    const broken = await addPhotos(root, settings, "broken.avi", "2025-01-01T00:00:00.000Z", Buffer.from("broken-video"), "video/x-msvideo");
    const raw = await addPhotos(root, settings, "camera.cr3", "2025-01-01T00:00:00.000Z", Buffer.from("raw-source"), "image/x-canon-cr3");
    const escaped = await addPhotos(root, settings, "../outside.mp4", "2025-01-01T00:00:00.000Z", Buffer.from("outside-video"), "video/mp4");
    let transcodeCalls = 0;
    const transcode = async (inputPath: string, outputPath: string) => {
      if (inputPath.endsWith("broken.avi")) {
        await writeFile(outputPath, "partial-video");
        throw new Error("transcode failed");
      }
      transcodeCalls += 1;
      await writeFile(outputPath, `converted-video-${transcodeCalls}`);
    };
    await app.close();

    const server = await buildServer({
      config: testConfig(root),
      db: db!,
      system: storageSystem(root, { mounted: true }),
      videoTranscoder: { transcode }
    });
    const nativeResponse = await server.inject({
      method: "GET",
      url: `/api/photos/${native.id}/video`,
      headers: { range: "bytes=1-5" }
    });
    expect(nativeResponse.statusCode).toBe(206);
    expect(nativeResponse.headers["content-type"]).toContain("video/mp4");
    expect(nativeResponse.payload).toBe("ative");
    const webmResponse = await server.inject({
      method: "GET",
      url: `/api/photos/${webm.id}/video`,
      headers: { range: "bytes=0-5" }
    });
    expect(webmResponse.statusCode).toBe(206);
    expect(webmResponse.headers["content-type"]).toContain("video/webm");
    expect(webmResponse.payload).toBe("native");
    const rawOriginal = await server.inject({ method: "GET", url: `/api/photos/${raw.id}/original?download=1` });
    expect(rawOriginal.statusCode).toBe(200);
    expect(rawOriginal.headers["content-type"]).toContain("image/x-canon-cr3");
    expect(rawOriginal.payload).toBe("raw-source");
    expect((await server.inject({ method: "GET", url: `/api/photos/${raw.id}/video` })).statusCode).toBe(415);
    expect((await server.inject({ method: "GET", url: `/api/photos/${escaped.id}/video` })).statusCode).toBe(404);

    const [first, second] = await Promise.all([
      server.inject({ method: "GET", url: `/api/photos/${converted.id}/video` }),
      server.inject({ method: "GET", url: `/api/photos/${converted.id}/video` })
    ]);
    expect(first.statusCode).toBe(200);
    expect(first.payload).toBe("converted-video-1");
    expect(second.payload).toBe("converted-video-1");
    expect(transcodeCalls).toBe(1);

    await writeFile(path.join(root, "Photos", "converted.mkv"), "changed-source-video");
    const changed = await server.inject({ method: "GET", url: `/api/photos/${converted.id}/video` });
    expect(changed.statusCode).toBe(200);
    expect(changed.payload).toBe("converted-video-2");
    expect(transcodeCalls).toBe(2);

    const failed = await server.inject({ method: "GET", url: `/api/photos/${broken.id}/video` });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error).toBe("Video transcoding failed");
    const cacheEntries = await readdir(path.join(tempDir!, "state", "media-cache", "videos"));
    expect(cacheEntries).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.part$/u)]));
    await server.close();
  });

  it("serves cached derivatives while the configured storage pool is offline", async () => {
    const storageState = { mounted: true };
    const { app, root } = await setup(storageState);
    await configure(app);
    const settings = getPhotosLibrarySettings(db!)!;
    completeInitialScan(settings);
    const photos = await addPhotos(root, settings, "cached.jpg", "2025-01-01T00:00:00.000Z");
    const video = await addPhotos(root, settings, "offline.mp4", "2025-01-01T00:00:00.000Z", Buffer.from("video"), "video/mp4");
    const thumbnail = Buffer.from("cached-webp");
    const thumbnailPath = path.join(tempDir!, "state", "photos", "thumbnail", "cached.jpg.webp");
    await mkdir(path.dirname(thumbnailPath), { recursive: true });
    await writeFile(thumbnailPath, thumbnail);

    storageState.mounted = false;
    const response = await app.inject({ method: "GET", url: `/api/photos/${photos.id}/thumbnail` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.rawPayload).toEqual(thumbnail);
    expect((await app.inject({ method: "GET", url: `/api/photos/${photos.id}/preview` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/photos/${photos.id}/original` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/photos/${video.id}/video` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/photos/missing/video" })).statusCode).toBe(404);
    await app.close();
  });

  it("moves photo batches directly and streams multi-photo zip exports", async () => {
    const { app, root } = await setup();
    await configure(app);
    const settings = getPhotosLibrarySettings(db!)!;
    completeInitialScan(settings);
    const first = await addPhotos(root, settings, "one.jpg", "2025-01-02T00:00:00.000Z");
    const second = await addPhotos(root, settings, "two.jpg", "2025-01-01T00:00:00.000Z");
    await mkdir(path.join(root, "Photos", "Archive"));
    const createExport = await app.inject({
      method: "POST",
      url: "/api/photos/exports",
      payload: { assetIds: [first.id, second.id] }
    });
    expect(createExport.statusCode).toBe(201);
    expect(createExport.json().url).toMatch(/^\/api\/photos\/exports\//u);
    const archive = await app.inject({ method: "GET", url: createExport.json().url });
    expect(archive.statusCode).toBe(200);
    expect(archive.headers["content-type"]).toBe("application/zip");
    expect(archive.rawPayload.subarray(0, 2).toString()).toBe("PK");

    const moved = await app.inject({
      method: "POST",
      url: "/api/photos/actions",
      payload: {
        assetIds: [first.id, second.id],
        operation: "move",
        targetDirectory: path.join("Photos", "Archive")
      }
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().operations).toHaveLength(2);
    expect(db!.prepare("SELECT COUNT(*) FROM jobs").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM agent_messages").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM capability_approvals").pluck().get()).toBe(0);
    expect(claimNextPhotosJob(db!, { workerId: "test", leaseMs: 30_000 })).toMatchObject({ kind: "full_scan" });
    await app.close();
  });

  it("rejects a batch move when selected photos share the same target name", async () => {
    const { app, root } = await setup();
    await configure(app);
    const settings = getPhotosLibrarySettings(db!)!;
    completeInitialScan(settings);
    const first = await addPhotos(root, settings, path.join("A", "same.jpg"), "2025-01-02T00:00:00.000Z", Buffer.from("first"));
    const second = await addPhotos(root, settings, path.join("B", "same.jpg"), "2025-01-01T00:00:00.000Z", Buffer.from("second"));
    await mkdir(path.join(root, "Photos", "Archive"));
    const response = await app.inject({
      method: "POST",
      url: "/api/photos/actions",
      payload: {
        assetIds: [first.id, second.id],
        operation: "move",
        targetDirectory: path.join("Photos", "Archive")
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("same target");
    await app.close();
  });

  it("queries indexed metadata with stable cursors and redacts sensitive details by default", async () => {
    const { app, root } = await setup();
    await configure(app);
    const settings = getPhotosLibrarySettings(db!)!;
    completeInitialScan(settings);
    const first = await addPhotos(
      root,
      settings,
      "metadata-one.jpg",
      "2025-01-02T00:00:00.000Z",
      Buffer.from("metadata-one"),
      "image/jpeg",
      indexedMetadata({ cameraModel: "Alpha 1", iso: 800, gpsLatitude: 31.23, gpsLongitude: 121.47 })
    );
    await addPhotos(
      root,
      settings,
      "metadata-two.jpg",
      "2025-01-01T00:00:00.000Z",
      Buffer.from("metadata-two"),
      "image/jpeg",
      indexedMetadata({ cameraModel: "Alpha 7", iso: 100 })
    );

    const query = await app.inject({
      method: "POST",
      url: "/api/photos/query",
      payload: {
        filters: { iso: { min: 400 } },
        sort: { field: "captured_at", direction: "desc" },
        includeFacets: true,
        limit: 1
      }
    });
    expect(query.statusCode).toBe(200);
    expect(query.json()).toMatchObject({
      total: 1,
      photos: [{ id: first.id, metadata: { cameraModel: "Alpha 1", hasLocation: true } }],
      metadataIndex: { total: 2, indexed: 2, pending: 0 }
    });
    const firstPage = await app.inject({
      method: "POST",
      url: "/api/photos/query",
      payload: { sort: { field: "name", direction: "asc" }, limit: 1, includeFacets: true }
    });
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));
    const secondPage = await app.inject({
      method: "POST",
      url: "/api/photos/query",
      payload: { sort: { field: "name", direction: "asc" }, limit: 2, includeFacets: false, cursor: firstPage.json().nextCursor }
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().photos[0].id).not.toBe(firstPage.json().photos[0].id);
    const mismatchedCursor = await app.inject({
      method: "POST",
      url: "/api/photos/query",
      payload: { filters: { text: "different" }, sort: { field: "name", direction: "asc" }, limit: 1, cursor: firstPage.json().nextCursor }
    });
    expect(mismatchedCursor.statusCode).toBe(400);

    const fields = await app.inject({ method: "GET", url: "/api/photos/metadata/fields?q=ISO" });
    expect(fields.json().fields).toContainEqual(expect.objectContaining({ key: "exif.ISO", count: 2 }));
    const redacted = await app.inject({ method: "GET", url: `/api/photos/${first.id}/metadata` });
    expect(redacted.json().metadata).toMatchObject({ sensitiveOmitted: true });
    expect(redacted.json().metadata.sensitiveGroups).toBeUndefined();
    const revealed = await app.inject({ method: "GET", url: `/api/photos/${first.id}/metadata?includeSensitive=1` });
    expect(revealed.json().metadata.sensitiveGroups.exif.GPSLatitude).toEqual([31.23]);

    const tooManyConditions = await app.inject({
      method: "POST",
      url: "/api/photos/query",
      payload: {
        filters: {
          advanced: {
            mode: "all",
            conditions: Array.from({ length: 26 }, () => ({ key: "exif.ISO", operator: "exists" }))
          }
        }
      }
    });
    expect(tooManyConditions.statusCode).toBe(400);
    const unknownField = await app.inject({
      method: "POST",
      url: "/api/photos/query",
      payload: { filters: { iso: { min: 100, typo: true } } }
    });
    expect(unknownField.statusCode).toBe(400);
    await app.close();
  });

  it("uploads XMP sidecars, pairs them for operations and exports, and serves managed PMTiles ranges", async () => {
    const mapFixture = pmtilesFixture(2);
    const { app, root, mapManager } = await setup({ mounted: true }, mapFixture);
    await configure(app);
    const settings = getPhotosLibrarySettings(db!)!;
    completeInitialScan(settings);
    const first = await addPhotos(root, settings, "paired.jpg", "2025-01-02T00:00:00.000Z");
    const second = await addPhotos(root, settings, "other.jpg", "2025-01-01T00:00:00.000Z");
    const runningRefresh = enqueuePhotosJob(db!, { settings, kind: "path_refresh", path: settings.path });
    expect(claimNextPhotosJob(db!, { workerId: "upload-race", leaseMs: 30_000 })?.id).toBe(runningRefresh.id);
    const sidecarBody = Buffer.from("<x:xmpmeta>paired</x:xmpmeta>");
    const upload = await app.inject({
      method: "PUT",
      url: "/api/photos/upload?name=paired.jpg.xmp",
      headers: { "content-type": "application/octet-stream" },
      payload: sidecarBody
    });
    expect(upload.statusCode).toBe(201);
    finishPhotosJob(db!, { id: runningRefresh.id, workerId: "upload-race" });
    expect(claimNextPhotosJob(db!, { workerId: "follow-up", leaseMs: 30_000 })).toMatchObject({
      kind: "path_refresh",
      path: settings.path,
      status: "running"
    });

    const exportRequest = await app.inject({
      method: "POST",
      url: "/api/photos/exports",
      payload: { assetIds: [first.id, second.id] }
    });
    const archive = await app.inject({ method: "GET", url: exportRequest.json().url });
    expect(archive.rawPayload.includes(Buffer.from("paired.jpg.xmp"))).toBe(true);

    const trashed = await app.inject({
      method: "POST",
      url: "/api/photos/actions",
      payload: { assetIds: [first.id], operation: "trash" }
    });
    expect(trashed.statusCode).toBe(200);
    expect(trashed.json().operations.map((item: { sourcePath: string }) => item.sourcePath)).toEqual([
      path.join("Photos", "paired.jpg"),
      path.join("Photos", "paired.jpg.xmp")
    ]);

    expect((await app.inject({ method: "GET", url: "/api/photos/map/settings" })).json()).toMatchObject({
      map: { name: "Test map", version: "1", sizeBytes: mapFixture.length },
      settings: null,
      download: { state: "not_downloaded", receivedBytes: 0, totalBytes: mapFixture.length }
    });
    const started = await app.inject({ method: "POST", url: "/api/photos/map/download" });
    expect(started.statusCode).toBe(202);
    expect(started.json().download.state).toBe("downloading");
    await mapManager!.waitForIdle();
    expect((await app.inject({ method: "GET", url: "/api/photos/map/settings" })).json()).toMatchObject({
      settings: { name: "Test map", version: "1", tileType: "png" },
      download: { state: "ready", receivedBytes: mapFixture.length, totalBytes: mapFixture.length }
    });
    const range = await app.inject({
      method: "GET",
      url: "/api/photos/map/archive",
      headers: { range: "bytes=0-7" }
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.toString()).toBe("PMTiles\u0003");
    await app.close();
  });
});

async function setup(storageState = { mounted: true }, mapFixture?: Buffer) {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-photos-api-"));
  const root = path.join(tempDir, "data", poolId);
  await mkdir(path.join(root, "Photos"), { recursive: true });
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
  const mapManager = mapFixture ? new PhotosMapArchiveManager({
    dataDir: tempDir,
    source: testMapSource(mapFixture),
    fetchImpl: async () => new Response(new Uint8Array(mapFixture))
  }) : null;
  const app = await buildServer({
    config: testConfig(root),
    db,
    system: storageSystem(root, storageState),
    ...(mapManager ? { photosMap: mapManager } : {})
  });
  return { app, root, mapManager };
}

async function configure(app: Awaited<ReturnType<typeof buildServer>>) {
  return await app.inject({
    method: "PUT",
    url: "/api/photos/settings",
    payload: {  storagePoolId: poolId, path: "Photos" }
  });
}

function completeInitialScan(settings: PhotosLibrarySettingsRecord) {
  const job = claimNextPhotosJob(db!, { workerId: "test", leaseMs: 30_000 });
  expect(job).not.toBeNull();
  finishPhotosJob(db!, { id: job!.id, workerId: "test" });
  expect(getPhotosLibrarySettings(db!)).toEqual(settings);
}

async function addPhotos(
  root: string,
  settings: PhotosLibrarySettingsRecord,
  name: string,
  takenAt: string,
  body = Buffer.from(name),
  mimeType = "image/jpeg",
  metadata?: PhotosMetadataWriteInput
) {
  const photosPath = path.join(root, "Photos", name);
  await mkdir(path.dirname(photosPath), { recursive: true });
  await writeFile(photosPath, body);
  const fileName = path.basename(name);
  return upsertPhotosAsset(db!, {
    settings,
    path: path.join("Photos", name),
    name: fileName,
    mimeType,
    sizeBytes: body.length,
    mtimeMs: Date.parse(takenAt),
    contentHash: createHash("sha256").update(body).digest("hex"),
    width: 100,
    height: 80,
    orientation: mimeType.startsWith("video/") ? null : 1,
    takenAt,
    takenAtSource: "exif",
    thumbnailKey: `thumbnail/${fileName}.webp`,
    previewKey: `preview/${fileName}.webp`,
    status: "ready",
    error: null,
    ...(metadata ? { metadata } : {})
  });
}

function indexedMetadata(overrides: {
  cameraModel: string;
  iso: number;
  gpsLatitude?: number;
  gpsLongitude?: number;
}): PhotosMetadataWriteInput {
  const latitude = overrides.gpsLatitude ?? null;
  const longitude = overrides.gpsLongitude ?? null;
  return {
    schemaVersion: PHOTOS_METADATA_SCHEMA_VERSION,
    status: "ready",
    mediaKind: "image",
    capturedAt: "2025-01-02T00:00:00.000Z",
    capturedAtLocal: "2025-01-02T08:00:00",
    captureOffsetMinutes: 480,
    captureSource: "exif",
    durationMs: null,
    container: null,
    videoCodec: null,
    audioCodec: null,
    cameraMake: "Sony",
    cameraModel: overrides.cameraModel,
    software: null,
    bodySerial: null,
    lensMake: "Sony",
    lensModel: "35mm F1.4",
    lensSerial: null,
    iso: overrides.iso,
    exposureTimeSeconds: 0.01,
    aperture: 2.8,
    focalLengthMm: 35,
    focalLength35Mm: 35,
    exposureBiasEv: 0,
    exposureProgram: null,
    meteringMode: null,
    flash: null,
    whiteBalance: null,
    title: null,
    description: null,
    creator: null,
    copyright: null,
    rating: 4,
    gpsLatitude: latitude,
    gpsLongitude: longitude,
    gpsAltitudeM: null,
    gpsDirectionDeg: null,
    rawMetadata: {
      exif: {
        ISO: [overrides.iso],
        ...(latitude !== null ? { GPSLatitude: [latitude] } : {}),
        ...(longitude !== null ? { GPSLongitude: [longitude] } : {})
      }
    },
    warnings: [],
    keywords: ["Travel"],
    values: [
      { source: "exif", key: "exif.ISO", valueType: "number", value: overrides.iso, sensitive: false, ordinal: 0 },
      ...(latitude !== null ? [{ source: "exif", key: "exif.GPSLatitude", valueType: "number" as const, value: latitude, sensitive: true, ordinal: 0 }] : []),
      ...(longitude !== null ? [{ source: "exif", key: "exif.GPSLongitude", valueType: "number" as const, value: longitude, sensitive: true, ordinal: 0 }] : [])
    ],
    sidecarPath: null,
    sidecarSizeBytes: null,
    sidecarMtimeMs: null
  };
}

function pmtilesFixture(tileType: 1 | 2): Buffer {
  const buffer = Buffer.alloc(133);
  buffer.write("PMTiles", 0, "ascii");
  buffer.writeUInt8(3, 7);
  buffer.writeBigUInt64LE(127n, 8);
  buffer.writeBigUInt64LE(5n, 16);
  buffer.writeBigUInt64LE(132n, 24);
  buffer.writeBigUInt64LE(0n, 32);
  buffer.writeBigUInt64LE(132n, 40);
  buffer.writeBigUInt64LE(0n, 48);
  buffer.writeBigUInt64LE(132n, 56);
  buffer.writeBigUInt64LE(1n, 64);
  buffer.writeBigUInt64LE(1n, 72);
  buffer.writeBigUInt64LE(1n, 80);
  buffer.writeBigUInt64LE(1n, 88);
  buffer.writeUInt8(1, 96);
  buffer.writeUInt8(1, 97);
  buffer.writeUInt8(1, 98);
  buffer.writeUInt8(tileType, 99);
  buffer.writeUInt8(0, 100);
  buffer.writeUInt8(4, 101);
  buffer.writeInt32LE(-1800000000, 102);
  buffer.writeInt32LE(-850000000, 106);
  buffer.writeInt32LE(1800000000, 110);
  buffer.writeInt32LE(850000000, 114);
  buffer.writeUInt8(2, 118);
  buffer.set([1, 0, 1, 1, 1], 127);
  buffer.writeUInt8(0, 132);
  return buffer;
}

function testMapSource(body: Buffer): PhotosMapArchiveSource {
  return {
    name: "Test map",
    version: "1",
    fileName: "test-map.pmtiles",
    url: "https://example.test/test-map.pmtiles",
    sha256: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.length,
    attribution: "Test"
  };
}

function testConfig(root: string): CyberOsRuntime {
  const rootDir = tempDir!;
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
    vodPlayer: { enabled: false, socketPath: "/tmp/vod-player.sock", statePath: "/tmp/vod-player-session.json", commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "cyberos" },
  };
}

function storageSystem(root: string, state: { mounted: boolean }) {
  return {
    commandRunner: {
      async run(command: string) {
        if (command === "findmnt") {
          return JSON.stringify({
            filesystems: state.mounted
              ? [{ source: poolDevice, target: root, fstype: "ext4", size: 1000, used: 100, avail: 900, "use%": "10%" }]
              : []
          });
        }
        if (command === "mdadm") return `ARRAY ${poolDevice} name=${poolId} UUID=photos`;
        if (command === "smartctl") return JSON.stringify({ devices: [] });
        return JSON.stringify({ blockdevices: [] });
      }
    }
  };
}
