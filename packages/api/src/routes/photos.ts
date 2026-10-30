import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createTrashEntry,
  enqueuePhotosJob,
  getPhotosAsset,
  getPhotosLibrarySettings,
  getPhotosLibraryStatus,
  getPhotosWorkerHealth,
  getPhotosProcessingSettings,
  getPhotosMetadataDetail,
  getPhotosMetadataIndexStatus,
  hasCompletedPhotosScan,
  listPhotosAssets,
  photosQueryFingerprint,
  queryPhotosAssets,
  queryPhotosMap,
  recordAppliedOperation,
  releasePhotosUploadReservation,
  reservePhotosUpload,
  savePhotosLibrarySettings,
  savePhotosProcessingSettings,
  defaultPhotosProcessingSettings
} from "@cyberos/db";
import { applyFileMutation, isPathInside } from "@cyberos/storage-tools";
import {
  PHOTOS_DATA_DIRECTORY_NAME,
  PHOTOS_MAX_FILE_SIZE_BYTES,
  PHOTOS_METADATA_SCHEMA_VERSION,
  PHOTOS_XMP_EXTENSION,
  PHOTOS_XMP_MAX_FILE_SIZE_BYTES,
  photosExtension,
  photosMediaKind,
  type FileOperationProposal,
  type PhotoAssetRecord,
  type PhotoLocationBounds,
  type PhotoLocationNear,
  type PhotoMapQueryRequest,
  type PhotoProcessingSettingsRecord,
  type PhotoMetadataCondition,
  type PhotoQueryAsset,
  type PhotoQueryRequest,
  type PhotoQueryPage,
  type PhotoTimelinePage
} from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { sendFileStream } from "../lib/files.js";
import { PhotosMetadataFieldsReader } from "../lib/photos-metadata-fields.js";
import {
  defaultPhotosMapSource,
  PhotosMapArchiveError,
  PhotosMapArchiveManager
} from "../lib/photos-map.js";
import { ffmpegVideoTranscoder, VideoCache } from "../lib/video-cache.js";
import {
  resolveScopedExistingPath,
  resolveScopedTargetPath,
  resolveStoragePoolScope,
  StorageScopeError,
  validateStoragePoolProposal
} from "../lib/storage-scope.js";

const MAX_BATCH_SIZE = 100;
const PHOTO_QUERY_BODY_LIMIT = 64 * 1024;
const EXPORT_TTL_MS = 5 * 60 * 1_000;
interface PhotoExport {
  expiresAt: number;
  assetIds: string[];
  libraryUpdatedAt: string;
}

export function registerPhotoRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { db, system } = context;
  const dataRoot = context.config.paths.dataRoot;
  const exports = new Map<string, PhotoExport>();
  const metadataFields = new PhotosMetadataFieldsReader(db.name);
  server.addHook("preClose", async () => metadataFields.close());
  const videoCache = new VideoCache({
    dataDir: context.config.paths.stateDir,
    transcoder: context.videoTranscoder ?? ffmpegVideoTranscoder
  });
  const mapArchive = context.photosMap ?? new PhotosMapArchiveManager({
    dataDir: context.config.paths.stateDir,
    source: defaultPhotosMapSource(context.config.photos.baseMapUrl)
  });
  server.addHook("onClose", async () => mapArchive.close());

  server.get("/api/photos/settings", async () => ({ settings: getPhotosLibrarySettings(db) }));

  server.get("/api/settings/photos", async (_request, reply) => {
    try {
      reply.send({ settings: getPhotosProcessingSettings(db) ?? defaultPhotosProcessingSettings() });
    } catch (error) {
      reply.status(409).send({
        error: error instanceof Error ? error.message : "Photo settings are invalid",
        state: "attention"
      });
    }
  });

  server.patch<{ Body: Partial<Omit<PhotoProcessingSettingsRecord, "updatedAt">> }>(
    "/api/settings/photos",
    async (request, reply) => {
      try {
        let current;
        try {
          current = getPhotosProcessingSettings(db) ?? defaultPhotosProcessingSettings();
        } catch {
          current = defaultPhotosProcessingSettings();
        }
        const settings = savePhotosProcessingSettings(db, { ...current, ...request.body });
        reply.send({ settings });
      } catch (error) {
        reply.status(400).send({ error: error instanceof Error ? error.message : "Photo settings are invalid" });
      }
    }
  );

  server.put<{
    Body: { storagePoolId?: string; path?: string };
  }>("/api/photos/settings", async (request, reply) => {
    const scope = await resolveStoragePoolScope(dataRoot, system, request.body?.storagePoolId);
    const safe = await resolveScopedExistingPath(scope, request.body?.path ?? scope.mountpointPath);
    const directory = await stat(safe.realPath);
    if (!directory.isDirectory()) {
      reply.status(400).send({ error: "Photo library path must be a directory" });
      return;
    }
    const settings = savePhotosLibrarySettings(db, {
      storagePoolId: scope.pool.id,
      path: safe.relativePath
    });
    const job = enqueuePhotosJob(db, { settings });
    reply.send({ settings, job });
  });

  server.get<{
    Querystring: { cursor?: string; limit?: string };
  }>("/api/photos", async (request, reply) => {
    const settings = getPhotosLibrarySettings(db);
    if (!settings) {
      const empty: PhotoTimelinePage = { photos: [], nextCursor: null };
      reply.send(empty);
      return;
    }
    const cursor = decodeCursor(request.query.cursor);
    if (request.query.cursor && !cursor) {
      reply.status(400).send({ error: "Photo cursor is invalid" });
      return;
    }
    const requestedLimit = Number(request.query.limit ?? "60");
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 60;
    const result = listPhotosAssets(db, { libraryUpdatedAt: settings.updatedAt, limit, cursor });
    const last = result.photos.at(-1);
    reply.send({
      photos: result.photos,
      nextCursor: result.hasMore && last ? encodeCursor({ takenAt: last.takenAt, id: last.id }) : null
    } satisfies PhotoTimelinePage);
  });

  server.post<{ Body: PhotoQueryRequest }>(
    "/api/photos/query",
    { bodyLimit: PHOTO_QUERY_BODY_LIMIT },
    async (request, reply) => {
      const settings = getPhotosLibrarySettings(db);
      if (!settings) {
        reply.send({
          photos: [],
          nextCursor: null,
          total: 0,
          facets: null,
          metadataIndex: emptyMetadataIndexStatus()
        });
        return;
      }
      const query = validatePhotoQuery(request.body);
      if (!query.ok) {
        reply.status(400).send({ error: query.error });
        return;
      }
      const requestWithoutCursor = { ...query.value, cursor: undefined };
      const fingerprint = photosQueryFingerprint(requestWithoutCursor);
      const cursor = decodePhotoQueryCursor(query.value.cursor);
      if (query.value.cursor && (!cursor || cursor.fingerprint !== fingerprint)) {
        reply.status(400).send({ error: "Photo query cursor is invalid or belongs to another query" });
        return;
      }
      const result = queryPhotosAssets(db, {
        libraryUpdatedAt: settings.updatedAt,
        request: query.value,
        cursor
      });
      const last = result.photos.at(-1);
      reply.send({
        photos: result.photos,
        nextCursor: result.hasMore && last
          ? encodePhotoQueryCursor({ fingerprint, sortValue: photoSortValue(last, query.value), id: last.id })
          : null,
        total: result.total,
        facets: result.facets,
        metadataIndex: getPhotosMetadataIndexStatus(db, settings.updatedAt)
      } satisfies PhotoQueryPage);
    }
  );

  server.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/photos/metadata/fields",
    async (request, reply) => {
      const settings = getPhotosLibrarySettings(db);
      if (!settings) {
        reply.send({ fields: [] });
        return;
      }
      const requestedLimit = Number(request.query.limit ?? "100");
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 100;
      reply.send({
        fields: await metadataFields.list({
          libraryUpdatedAt: settings.updatedAt,
          ...(request.query.q !== undefined ? { query: request.query.q } : {}),
          limit
        })
      });
    }
  );

  server.get<{
    Params: { id: string };
    Querystring: { includeSensitive?: string };
  }>("/api/photos/:id/metadata", async (request, reply) => {
    const settings = getPhotosLibrarySettings(db);
    const detail = settings ? getPhotosMetadataDetail(db, {
      assetId: request.params.id,
      libraryUpdatedAt: settings.updatedAt,
      includeSensitive: request.query.includeSensitive === "1"
    }) : null;
    if (!detail) {
      reply.status(404).send({ error: "Photo not found" });
      return;
    }
    reply.send({ metadata: detail });
  });

  server.get<{ Params: { id: string } }>("/api/photos/:id/record", async (request, reply) => {
    const settings = getPhotosLibrarySettings(db);
    const asset = settings ? getPhotosAsset(db, request.params.id, settings.updatedAt) : null;
    if (!settings || !asset) {
      reply.status(404).send({ error: "Photo not found" });
      return;
    }
    const detail = getPhotosMetadataDetail(db, {
      assetId: asset.id,
      libraryUpdatedAt: settings.updatedAt,
      includeSensitive: false
    });
    reply.send({
      photo: {
        ...asset,
        metadata: detail?.summary ?? null,
        keywords: detail?.keywords ?? [],
        distanceMeters: null
      } satisfies PhotoQueryAsset
    });
  });

  server.post<{ Body: PhotoMapQueryRequest }>(
    "/api/photos/map/query",
    { bodyLimit: PHOTO_QUERY_BODY_LIMIT },
    async (request, reply) => {
      const settings = getPhotosLibrarySettings(db);
      if (!settings) {
        reply.send({ clusters: [], metadataIndex: emptyMetadataIndexStatus() });
        return;
      }
      const mapQuery = validatePhotoMapQuery(request.body);
      if (!mapQuery.ok) {
        reply.status(400).send({ error: mapQuery.error });
        return;
      }
      reply.send({
        clusters: queryPhotosMap(db, { libraryUpdatedAt: settings.updatedAt, request: mapQuery.value }),
        metadataIndex: getPhotosMetadataIndexStatus(db, settings.updatedAt)
      });
    }
  );

  server.get("/api/photos/map/settings", async (_request, reply) => {
    reply.send(await mapArchive.getStatus());
  });

  server.post("/api/photos/map/download", async (_request, reply) => {
    const status = await mapArchive.startDownload();
    reply.status(status.download.state === "ready" ? 200 : 202).send(status);
  });

  server.get("/api/photos/map/archive", async (request, reply) => {
    try {
      const archive = await mapArchive.getArchive();
      reply.header("Cache-Control", "private, max-age=86400");
      reply.header("ETag", `"${archive.settings.version}-${archive.settings.sizeBytes}"`);
      return sendFileStream(reply, request.headers.range, archive.filePath, "application/vnd.pmtiles");
    } catch (error) {
      if (error instanceof PhotosMapArchiveError) {
        reply.status(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  server.get("/api/photos/status", async (_request, reply) => {
    const settings = getPhotosLibrarySettings(db);
    const status = getPhotosLibraryStatus(db, settings);
    const workerHealth = getPhotosWorkerHealth(db);
    if (!settings) {
      reply.send({ status, workerHealth });
      return;
    }
    try {
      await resolveLibraryScope(context, settings);
      reply.send({ status, workerHealth });
    } catch (error) {
      if (error instanceof StorageScopeError) {
        reply.send({ status: { ...status, state: "offline", error: error.message }, workerHealth });
        return;
      }
      throw error;
    }
  });

  server.post("/api/photos/scans", async (_request, reply) => {
    const settings = getPhotosLibrarySettings(db);
    if (!settings) {
      reply.status(409).send({ error: "Photo library is not configured" });
      return;
    }
    await resolveLibraryScope(context, settings);
    reply.status(202).send({ job: enqueuePhotosJob(db, { settings }) });
  });

  server.get<{ Params: { id: string } }>("/api/photos/:id/thumbnail", async (request, reply) => {
    await sendDerivative(context, request.params.id, "thumbnail", reply);
  });

  server.get<{ Params: { id: string } }>("/api/photos/:id/preview", async (request, reply) => {
    await sendDerivative(context, request.params.id, "preview", reply);
  });

  server.get<{
    Params: { id: string };
    Querystring: { download?: string };
  }>("/api/photos/:id/original", async (request, reply) => {
    const resolved = await resolveCurrentAsset(context, request.params.id);
    if (!resolved) {
      reply.status(404).send({ error: "Photo not found" });
      return;
    }
    if (request.query.download === "1") {
      reply.header("Content-Disposition", contentDisposition(resolved.asset.name));
    }
    const fileStat = await stat(resolved.safe.realPath);
    reply.header("Content-Type", resolved.asset.mimeType);
    reply.header("Content-Length", String(fileStat.size));
    reply.header("ETag", etagFor(resolved.asset));
    return reply.send(createReadStream(resolved.safe.realPath));
  });

  server.get<{ Params: { id: string } }>("/api/photos/:id/video", async (request, reply) => {
    const resolved = await resolveCurrentAsset(context, request.params.id);
    if (!resolved) {
      reply.status(404).send({ error: "Photo not found" });
      return;
    }
    if (!resolved.asset.mimeType.startsWith("video/")) {
      reply.status(415).send({ error: "Photo asset is not a video" });
      return;
    }
    const sourceStat = await stat(resolved.safe.realPath);
    if (!sourceStat.isFile()) {
      reply.status(404).send({ error: "Photo not found" });
      return;
    }

    const extension = path.extname(resolved.safe.realPath).toLowerCase();
    if (extension === ".mp4" || extension === ".webm") {
      return sendFileStream(reply, request.headers.range, resolved.safe.realPath, resolved.asset.mimeType);
    }

    const source = {
      storagePoolId: resolved.asset.storagePoolId,
      relativePath: resolved.safe.relativePath,
      realPath: resolved.safe.realPath,
      sizeBytes: sourceStat.size,
      modifiedAtMs: sourceStat.mtimeMs
    };
    const cachePath = videoCache.pathFor(source);
    const release = videoCache.acquire(cachePath);
    try {
      await videoCache.ensure(source);
      const result = await sendFileStream(reply, request.headers.range, cachePath, "video/mp4", (stream) => {
        stream.once("close", release);
        stream.once("error", release);
      });
      if (reply.statusCode === 416) release();
      return result;
    } catch (error) {
      release();
      throw error;
    }
  });

  server.put<{
    Querystring: { name?: string; directory?: string };
  }>(
    "/api/photos/upload",
    { bodyLimit: PHOTOS_MAX_FILE_SIZE_BYTES },
    async (request, reply) => {
      const settings = getPhotosLibrarySettings(db);
      if (!settings) {
        reply.status(409).send({ error: "Photo library is not configured" });
        return;
      }
      if (!hasCompletedPhotosScan(db, settings.updatedAt)) {
        reply.status(409).send({ error: "Wait for the initial photo scan to finish before uploading" });
        return;
      }
      const fileName = normalizeUploadFileName(request.query.name);
      if (!fileName) {
        reply.status(400).send({ error: "A supported media or XMP file name is required" });
        return;
      }
      const isSidecar = photosExtension(fileName) === PHOTOS_XMP_EXTENSION;
      const uploadLimit = isSidecar ? PHOTOS_XMP_MAX_FILE_SIZE_BYTES : PHOTOS_MAX_FILE_SIZE_BYTES;
      const { scope, library } = await resolveLibraryScope(context, settings);
      const directory = await resolveScopedExistingPath(scope, request.query.directory ?? settings.path);
      if (!isPathInside(library.realPath, directory.realPath) || !(await stat(directory.realPath)).isDirectory()) {
        reply.status(400).send({ error: "Upload target must be a directory inside the photo library" });
        return;
      }
      const target = await resolveScopedTargetPath(scope, path.join(directory.relativePath, fileName));
      if (!isPathInside(library.realPath, target.absolutePath)) {
        reply.status(400).send({ error: "Upload target must stay inside the photo library" });
        return;
      }
      if (await exists(target.absolutePath)) {
        reply.status(409).send({ error: "Upload target already exists" });
        return;
      }

      const temporaryPath = path.join(directory.realPath, `.${randomUUID()}.cyberos-photos-upload`);
      const output = createWriteStream(temporaryPath, { flags: "wx" });
      const hash = createHash("sha256");
      let written = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.length;
          if (written > uploadLimit) {
            callback(Object.assign(new Error(isSidecar
              ? "XMP sidecar exceeds the 16 MiB upload limit"
              : "Photo exceeds the 512 MiB upload limit"), { statusCode: 413, expose: true }));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      let reservation: { id: string } | null = null;
      let published = false;
      try {
        await pipeline(request.body as NodeJS.ReadableStream, limiter, output);
        const contentHash = hash.digest("hex");
        if (!isSidecar) {
          const reserved = reservePhotosUpload(db, {
            settings,
            path: target.relativePath,
            contentHash
          });
          if (reserved.duplicate) {
            await unlink(temporaryPath);
            reply.status(409).send({
              error: reserved.conflict === "path" ? "Upload target already exists" : "This media already exists in the library",
              duplicate: reserved.duplicate
            });
            return;
          }
          reservation = reserved.reservation;
          if (!reservation) throw new Error("Photo upload reservation was not created");
        }
        try {
          await link(temporaryPath, target.absolutePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            if (reservation) releasePhotosUploadReservation(db, { id: reservation.id, libraryUpdatedAt: settings.updatedAt });
            reservation = null;
            await unlink(temporaryPath).catch(() => undefined);
            reply.status(409).send({ error: "Upload target already exists" });
            return;
          }
          throw error;
        }
        published = true;
        await unlink(temporaryPath).catch(() => undefined);
        enqueuePhotosJob(db, {
          settings,
          kind: "path_refresh",
          path: settings.path,
          queueAfterRunning: isSidecar
        });
        const operation = recordAppliedOperation(db, {
          operation: "upload",
          sourcePath: null,
          targetPath: target.relativePath,
          status: "applied",
          metadata: {
            storagePoolId: settings.storagePoolId,
            reversible: true,
            sizeBytes: written,
            contentHash
          }
        });
        reply.status(201).send({ path: target.relativePath, operation });
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        if (reservation && !published) {
          releasePhotosUploadReservation(db, { id: reservation.id, libraryUpdatedAt: settings.updatedAt });
        }
        throw error;
      }
    }
  );

  server.post<{
    Body: { assetIds?: string[]; operation?: "move" | "trash"; targetDirectory?: string };
  }>("/api/photos/actions", async (request, reply) => {
    const settings = getPhotosLibrarySettings(db);
    if (!settings) {
      reply.status(409).send({ error: "Photo library is not configured" });
      return;
    }
    const operation = request.body?.operation;
    if (operation !== "move" && operation !== "trash") {
      reply.status(400).send({ error: "Unsupported photo operation" });
      return;
    }
    const ids = uniqueIds(request.body?.assetIds);
    if (!ids.length || ids.length > MAX_BATCH_SIZE) {
      reply.status(400).send({ error: `Select between 1 and ${MAX_BATCH_SIZE} photos` });
      return;
    }
    const resolved = await Promise.all(ids.map((id) => resolveCurrentAsset(context, id)));
    if (resolved.some((item) => !item)) {
      reply.status(404).send({ error: "One or more photos no longer exist" });
      return;
    }
    const assets = resolved as Array<NonNullable<(typeof resolved)[number]>>;
    const operationFiles = await filesWithAssociatedSidecars(assets);
    const proposals: FileOperationProposal[] = [];
    if (operation === "trash") {
      for (const item of operationFiles) {
        proposals.push({
          operation: "trash",
          storagePoolId: settings.storagePoolId,
          sourcePath: item.relativePath,
          risk: "medium",
          reversible: true,
          summary: `Move ${item.relativePath} to CyberOS trash`
        });
      }
    } else {
      const { scope, library } = await resolveLibraryScope(context, settings);
      const targetDirectory = await resolveScopedExistingPath(scope, request.body?.targetDirectory ?? "");
      if (!isPathInside(library.realPath, targetDirectory.realPath) || !(await stat(targetDirectory.realPath)).isDirectory()) {
        reply.status(400).send({ error: "Move target must be a directory inside the photo library" });
        return;
      }
      const targetPaths = new Set<string>();
      for (const item of operationFiles) {
        const target = await resolveScopedTargetPath(scope, path.join(targetDirectory.relativePath, item.name));
        if (targetPaths.has(target.relativePath)) {
          reply.status(409).send({ error: `Multiple selected files would use the same target: ${item.name}` });
          return;
        }
        targetPaths.add(target.relativePath);
        if (await exists(target.absolutePath)) {
          reply.status(409).send({ error: `Move target already exists: ${item.name}` });
          return;
        }
        proposals.push({
          operation: "move",
          storagePoolId: settings.storagePoolId,
          sourcePath: item.relativePath,
          targetPath: target.relativePath,
          risk: "medium",
          reversible: true,
          summary: `Move ${item.relativePath} to ${target.relativePath}`
        });
      }
    }

    const scope = await resolveStoragePoolScope(dataRoot, system, settings.storagePoolId);
    const applied: ReturnType<typeof recordAppliedOperation>[] = [];
    try {
      for (const proposal of proposals) {
        await validateStoragePoolProposal(scope, proposal);
        const result = await applyFileMutation(scope.workspace, proposal, path.join(context.config.paths.stateDir, "trash"));
        if (result.proposal.operation === "trash" && result.metadata.trashEntryId && result.targetPath) {
          createTrashEntry(db, {
            id: String(result.metadata.trashEntryId),
            storagePoolId: scope.pool.id,
            originalPath: result.sourcePath ?? proposal.sourcePath ?? ".",
            trashPath: path.join(context.config.paths.stateDir, "trash", result.targetPath),
            metadata: { ...result.metadata, storagePoolId: settings.storagePoolId }
          });
        }
        applied.push(recordAppliedOperation(db, {
          operation: result.proposal.operation,
          sourcePath: result.sourcePath,
          targetPath: result.targetPath,
          status: "applied",
          metadata: {
            ...result.metadata,
            storagePoolId: settings.storagePoolId,
            reversible: proposal.reversible
          }
        }));
      }
    } catch (error) {
      if (applied.length) {
        enqueuePhotosJob(db, { settings, kind: "full_scan", path: settings.path });
      }
      const statusCode = error instanceof StorageScopeError ? error.statusCode : 400;
      reply.status(statusCode).send({ error: error instanceof Error ? error.message : String(error), operations: applied });
      return;
    }
    enqueuePhotosJob(db, { settings, kind: "full_scan", path: settings.path });
    reply.send({ operations: applied });
  });

  server.post<{
    Body: { assetIds?: string[] };
  }>("/api/photos/exports", async (request, reply) => {
    pruneExports(exports);
    const ids = uniqueIds(request.body?.assetIds);
    if (!ids.length || ids.length > MAX_BATCH_SIZE) {
      reply.status(400).send({ error: `Select between 1 and ${MAX_BATCH_SIZE} photos` });
      return;
    }
    const settings = getPhotosLibrarySettings(db);
    if (!settings) {
      reply.status(409).send({ error: "Photo library is not configured" });
      return;
    }
    const resolved = await Promise.all(ids.map((id) => resolveCurrentAsset(context, id)));
    if (resolved.some((item) => !item)) {
      reply.status(404).send({ error: "One or more photos no longer exist" });
      return;
    }
    if (ids.length === 1) {
      reply.send({ url: `/api/photos/${encodeURIComponent(ids[0]!)}/original?download=1`, expiresAt: null });
      return;
    }
    const token = randomUUID();
    const expiresAt = Date.now() + EXPORT_TTL_MS;
    exports.set(token, { assetIds: ids, libraryUpdatedAt: settings.updatedAt, expiresAt });
    reply.status(201).send({ url: `/api/photos/exports/${token}`, expiresAt: new Date(expiresAt).toISOString() });
  });

  server.get<{ Params: { token: string } }>("/api/photos/exports/:token", async (request, reply) => {
    pruneExports(exports);
    const photoExport = exports.get(request.params.token);
    const settings = getPhotosLibrarySettings(db);
    if (!photoExport || !settings || settings.updatedAt !== photoExport.libraryUpdatedAt) {
      reply.status(404).send({ error: "Photo export expired" });
      return;
    }
    exports.delete(request.params.token);
    const resolved = await Promise.all(photoExport.assetIds.map((id) => resolveCurrentAsset(context, id)));
    if (resolved.some((item) => !item)) {
      reply.status(404).send({ error: "One or more photos no longer exist" });
      return;
    }
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.once("error", (error: Error) => archive.destroy(error));
    const usedNames = new Set<string>();
    const exportFiles = await filesWithAssociatedSidecars(resolved as Array<NonNullable<(typeof resolved)[number]>>);
    for (const item of exportFiles) {
      archive.file(item.realPath, { name: uniqueArchiveName(item.name, usedNames) });
    }
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition("cyberos-photos.zip"));
    reply.send(archive);
    void archive.finalize();
    return reply;
  });
}

async function resolveLibraryScope(context: ApiRouteContext, settings: NonNullable<ReturnType<typeof getPhotosLibrarySettings>>) {
  const scope = await resolveStoragePoolScope(
    context.config.paths.dataRoot,
    context.system,
    settings.storagePoolId
  );
  const library = await resolveScopedExistingPath(scope, settings.path);
  if (!(await stat(library.realPath)).isDirectory()) throw new StorageScopeError("Photo library is unavailable", 503);
  return { scope, library };
}

async function resolveCurrentAsset(context: ApiRouteContext, id: string) {
  const settings = getPhotosLibrarySettings(context.db);
  if (!settings) return null;
  const asset = getPhotosAsset(context.db, id, settings.updatedAt);
  if (!asset || asset.storagePoolId !== settings.storagePoolId) return null;
  const { scope, library } = await resolveLibraryScope(context, settings);
  const safe = await resolveScopedExistingPath(scope, asset.path);
  if (!isPathInside(library.realPath, safe.realPath)) return null;
  return { settings, asset, scope, library, safe };
}

async function sendDerivative(
  context: ApiRouteContext,
  id: string,
  kind: "thumbnail" | "preview",
  reply: FastifyReply
): Promise<unknown> {
  const settings = getPhotosLibrarySettings(context.db);
  if (!settings) {
    reply.status(404).send({ error: "Photo not found" });
    return;
  }
  const asset = getPhotosAsset(context.db, id, settings.updatedAt);
  if (
    !asset ||
    asset.storagePoolId !== settings.storagePoolId ||
    asset.status !== "ready"
  ) {
    reply.status(404).send({ error: "Photo not found" });
    return;
  }
  if (kind === "preview" && asset.mimeType === "image/gif") {
    const resolved = await resolveCurrentAsset(context, id);
    if (!resolved) {
      reply.status(404).send({ error: "Photo not found" });
      return;
    }
    reply.header("Content-Type", "image/gif");
    reply.header("ETag", etagFor(asset));
    return reply.send(createReadStream(resolved.safe.realPath));
  }
  const key = kind === "thumbnail" ? asset.thumbnailKey : asset.previewKey;
  if (!key) {
    reply.status(404).send({ error: "Photo derivative is not available" });
    return;
  }
  const cacheRoot = path.join(context.config.paths.stateDir, PHOTOS_DATA_DIRECTORY_NAME);
  const candidatePath = path.resolve(cacheRoot, key);
  if (!isPathInside(cacheRoot, candidatePath)) {
    reply.status(404).send({ error: "Photo derivative is not available" });
    return;
  }
  let filePath: string;
  try {
    const [cacheRootRealPath, candidateRealPath] = await Promise.all([realpath(cacheRoot), realpath(candidatePath)]);
    if (!isPathInside(cacheRootRealPath, candidateRealPath)) {
      reply.status(404).send({ error: "Photo derivative is not available" });
      return;
    }
    filePath = candidateRealPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      reply.status(404).send({ error: "Photo derivative is not available" });
      return;
    }
    throw error;
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    reply.status(404).send({ error: "Photo derivative is not available" });
    return;
  }
  reply.header("Content-Type", "image/webp");
  reply.header("Content-Length", String(fileStat.size));
  reply.header("Cache-Control", "private, max-age=31536000, immutable");
  reply.header("ETag", `"${path.basename(key, ".webp")}"`);
  return reply.send(createReadStream(filePath));
}

function encodeCursor(cursor: { takenAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { takenAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.takenAt !== "string" || !Number.isFinite(Date.parse(parsed.takenAt)) || typeof parsed.id !== "string" || !parsed.id) return null;
    return { takenAt: parsed.takenAt, id: parsed.id };
  } catch {
    return null;
  }
}

function normalizeUploadFileName(value: string | undefined): string | null {
  const name = value?.trim() ?? "";
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  if (
    Buffer.byteLength(name, "utf8") > 255 ||
    (!photosMediaKind(name) && photosExtension(name) !== PHOTOS_XMP_EXTENSION)
  ) return null;
  return name;
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function etagFor(asset: PhotoAssetRecord): string {
  return `"${asset.contentHash ?? `${asset.sizeBytes}-${asset.mtimeMs}`}"`;
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/gu, "_").replace(/["\\]/gu, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function pruneExports(exports: Map<string, PhotoExport>): void {
  const now = Date.now();
  for (const [token, value] of exports) if (value.expiresAt <= now) exports.delete(token);
}

function uniqueArchiveName(fileName: string, used: Set<string>): string {
  if (!used.has(fileName)) {
    used.add(fileName);
    return fileName;
  }
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let index = 2;
  while (used.has(`${stem}-${index}${extension}`)) index += 1;
  const unique = `${stem}-${index}${extension}`;
  used.add(unique);
  return unique;
}

type ResolvedPhotoAsset = NonNullable<Awaited<ReturnType<typeof resolveCurrentAsset>>>;

async function filesWithAssociatedSidecars(assets: ResolvedPhotoAsset[]): Promise<Array<{
  relativePath: string;
  realPath: string;
  name: string;
}>> {
  const files = new Map<string, { relativePath: string; realPath: string; name: string }>();
  for (const item of assets) {
    files.set(item.asset.path, {
      relativePath: item.asset.path,
      realPath: item.safe.realPath,
      name: item.asset.name
    });
    const sidecar = await resolveAssociatedSidecar(item);
    if (sidecar) files.set(sidecar.relativePath, sidecar);
  }
  return [...files.values()];
}

async function resolveAssociatedSidecar(item: ResolvedPhotoAsset): Promise<{
  relativePath: string;
  realPath: string;
  name: string;
} | null> {
  const directoryPath = path.dirname(item.safe.realPath);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const actualByLower = new Map(names.map((name) => [name.toLocaleLowerCase("und"), name]));
  const exact = actualByLower.get(`${item.asset.name}.xmp`.toLocaleLowerCase("und"));
  let sidecarName = exact ?? null;
  if (!sidecarName) {
    const stem = path.parse(item.asset.name).name.toLocaleLowerCase("und");
    const shared = actualByLower.get(`${stem}.xmp`);
    if (shared) {
      const siblings = names.filter((name) => photosMediaKind(name) && path.parse(name).name.toLocaleLowerCase("und") === stem);
      const rawSiblings = siblings.filter((name) => photosMediaKind(name) === "raw");
      if (siblings.length === 1 || (rawSiblings.length === 1 && rawSiblings[0] === item.asset.name)) {
        sidecarName = shared;
      }
    }
  }
  if (!sidecarName) return null;
  const relativePath = path.join(path.dirname(item.asset.path), sidecarName);
  const sidecar = await resolveScopedExistingPath(item.scope, relativePath);
  if (!isPathInside(item.library.realPath, sidecar.realPath)) return null;
  const sidecarStat = await lstat(path.join(directoryPath, sidecarName));
  if (sidecarStat.isSymbolicLink() || !sidecarStat.isFile()) return null;
  return { relativePath: sidecar.relativePath, realPath: sidecar.realPath, name: sidecarName };
}

function emptyMetadataIndexStatus() {
  return { schemaVersion: PHOTOS_METADATA_SCHEMA_VERSION, total: 0, indexed: 0, partial: 0, pending: 0 };
}

function encodePhotoQueryCursor(cursor: { fingerprint: string; sortValue: string | number | null; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodePhotoQueryCursor(value: string | null | undefined): {
  fingerprint: string;
  sortValue: string | number | null;
  id: string;
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof parsed.fingerprint !== "string" || !parsed.fingerprint ||
      typeof parsed.id !== "string" || !parsed.id ||
      (parsed.sortValue !== null && typeof parsed.sortValue !== "string" && typeof parsed.sortValue !== "number")
    ) return null;
    return {
      fingerprint: parsed.fingerprint,
      sortValue: parsed.sortValue as string | number | null,
      id: parsed.id
    };
  } catch {
    return null;
  }
}

function photoSortValue(photo: PhotoQueryAsset, request: PhotoQueryRequest): string | number | null {
  switch (request.sort?.field ?? "captured_at") {
    case "indexed_at": return photo.indexedAt;
    case "name": return sqliteLower(photo.name);
    case "size_bytes": return photo.sizeBytes;
    case "rating": return photo.metadata?.rating ?? null;
    case "distance": return photo.distanceMeters;
    case "captured_at": return photo.metadata?.capturedAt ?? photo.metadata?.capturedAtLocal ?? photo.takenAt;
  }
}

function sqliteLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function validatePhotoQuery(body: unknown): ValidationResult<PhotoQueryRequest> {
  if (!isObject(body)) return invalid("Photo query body must be an object");
  if (!hasOnlyKeys(body, ["filters", "sort", "cursor", "limit", "includeFacets"])) {
    return invalid("Photo query body contains unknown fields");
  }
  const request = body as Partial<PhotoQueryRequest>;
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) {
    return invalid("Photo query limit must be an integer between 1 and 100");
  }
  if (request.cursor !== undefined && request.cursor !== null && typeof request.cursor !== "string") {
    return invalid("Photo query cursor must be a string");
  }
  if (request.includeFacets !== undefined && typeof request.includeFacets !== "boolean") {
    return invalid("includeFacets must be a boolean");
  }
  const sortFields = new Set(["captured_at", "indexed_at", "name", "size_bytes", "rating", "distance"]);
  if (request.sort && (!isObject(request.sort) || !hasOnlyKeys(request.sort, ["field", "direction"]) ||
    !sortFields.has(request.sort.field) || !["asc", "desc"].includes(request.sort.direction))) {
    return invalid("Photo query sort is invalid");
  }
  const filters = validatePhotoFilters(request.filters);
  if (!filters.ok) return filters;
  const normalized: PhotoQueryRequest = {
    ...(filters.value ? { filters: filters.value } : {}),
    ...(request.sort ? { sort: request.sort } : {}),
    ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
    ...(request.includeFacets !== undefined ? { includeFacets: request.includeFacets } : {})
  };
  if (normalized.sort?.field === "distance" && normalized.filters?.location?.kind !== "near") {
    return invalid("Distance sorting requires a nearby location filter");
  }
  return { ok: true, value: normalized };
}

function validatePhotoFilters(value: unknown): ValidationResult<PhotoQueryRequest["filters"]> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isObject(value)) return invalid("Photo filters must be an object");
  if (!hasOnlyKeys(value, [
    "text", "capturedAt", "mediaKinds", "cameraModels", "lensModels", "iso", "aperture",
    "exposureTimeSeconds", "focalLengthMm", "rating", "keywords", "hasLocation", "location", "advanced"
  ])) return invalid("Photo filters contain unknown fields");
  const filters = value as NonNullable<PhotoQueryRequest["filters"]>;
  if (filters.text !== undefined && (typeof filters.text !== "string" || filters.text.length > 512)) {
    return invalid("Photo text filter is invalid");
  }
  for (const [key, list] of Object.entries({
    mediaKinds: filters.mediaKinds,
    cameraModels: filters.cameraModels,
    lensModels: filters.lensModels,
    keywords: filters.keywords
  })) {
    if (list !== undefined && (!Array.isArray(list) || list.length > 100 || list.some((entry) => typeof entry !== "string" || !entry || entry.length > 512))) {
      return invalid(`${key} must be an array of at most 100 non-empty strings`);
    }
  }
  if (filters.mediaKinds?.some((kind) => !["image", "video", "raw"].includes(kind))) {
    return invalid("Photo media type filter is invalid");
  }
  for (const [key, range] of Object.entries({
    iso: filters.iso,
    aperture: filters.aperture,
    exposureTimeSeconds: filters.exposureTimeSeconds,
    focalLengthMm: filters.focalLengthMm,
    rating: filters.rating
  })) {
    const min = range?.min;
    const max = range?.max;
    if (range !== undefined && (!isObject(range) || !hasOnlyKeys(range, ["min", "max"]) ||
      !validOptionalNumber(min) || !validOptionalNumber(max) ||
      (typeof min === "number" && typeof max === "number" && min > max))) {
      return invalid(`${key} range is invalid`);
    }
  }
  if (filters.capturedAt !== undefined && (!isObject(filters.capturedAt) ||
    !hasOnlyKeys(filters.capturedAt, ["from", "to"]) ||
    !validOptionalDate(filters.capturedAt.from) || !validOptionalDate(filters.capturedAt.to) ||
    (typeof filters.capturedAt.from === "string" && typeof filters.capturedAt.to === "string" &&
      Date.parse(filters.capturedAt.from) > Date.parse(filters.capturedAt.to)))) {
    return invalid("Capture date range is invalid");
  }
  if (filters.hasLocation !== undefined && typeof filters.hasLocation !== "boolean") {
    return invalid("hasLocation must be a boolean");
  }
  if (filters.location !== undefined && !validLocation(filters.location)) {
    return invalid("Photo location filter is invalid");
  }
  if (filters.advanced !== undefined) {
    if (!isObject(filters.advanced) || !hasOnlyKeys(filters.advanced, ["mode", "conditions"]) ||
      !["all", "any"].includes(filters.advanced.mode) ||
      !Array.isArray(filters.advanced.conditions) || filters.advanced.conditions.length > 25) {
      return invalid("Advanced metadata filters must contain at most 25 conditions");
    }
    for (const condition of filters.advanced.conditions) {
      const conditionError = validateMetadataCondition(condition);
      if (conditionError) return invalid(conditionError);
    }
  }
  return { ok: true, value: filters };
}

function validateMetadataCondition(value: unknown): string | null {
  if (!isObject(value)) return "Metadata condition must be an object";
  if (!hasOnlyKeys(value, ["key", "operator", "value", "valueTo"])) return "Metadata condition contains unknown fields";
  const condition = value as Partial<PhotoMetadataCondition>;
  const operators = new Set(["eq", "contains", "prefix", "in", "exists", "not_exists", "lt", "lte", "gt", "gte", "between"]);
  if (typeof condition.key !== "string" || !/^[a-z0-9_.:-]{1,256}$/iu.test(condition.key)) return "Metadata field key is invalid";
  if (!condition.operator || !operators.has(condition.operator)) return "Metadata condition operator is invalid";
  if (condition.operator === "exists" || condition.operator === "not_exists") return null;
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  if (!values.length || values.length > 100 || values.some((entry) => !isMetadataScalar(entry))) return "Metadata condition value is invalid";
  if (condition.operator !== "in" && Array.isArray(condition.value)) return "Only set conditions accept multiple values";
  if (condition.operator === "in" && new Set(values.map((entry) => typeof entry)).size !== 1) {
    return "Metadata set values must have the same type";
  }
  if ((condition.operator === "contains" || condition.operator === "prefix") && typeof condition.value !== "string") {
    return "Metadata text conditions require a string value";
  }
  if (["lt", "lte", "gt", "gte", "between"].includes(condition.operator) && typeof condition.value === "boolean") {
    return "Metadata comparison value must be a number or date string";
  }
  if (condition.operator === "between" && (typeof condition.valueTo !== "string" && typeof condition.valueTo !== "number")) {
    return "Metadata between condition requires an upper value";
  }
  return null;
}

function validatePhotoMapQuery(body: unknown): ValidationResult<PhotoMapQueryRequest> {
  if (!isObject(body)) return invalid("Photo map bounds are invalid");
  if (!hasOnlyKeys(body, ["filters", "bounds", "columns", "rows"])) {
    return invalid("Photo map query contains unknown fields");
  }
  const bounds = body.bounds;
  if (!validLocation(bounds) || bounds.kind !== "bounds") {
    return invalid("Photo map bounds are invalid");
  }
  const filters = validatePhotoFilters(body.filters);
  if (!filters.ok) return filters;
  const columns = body.columns;
  const rows = body.rows;
  for (const [key, value] of Object.entries({ columns, rows })) {
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 64)) {
      return invalid(`${key} must be between 1 and 64`);
    }
  }
  return {
    ok: true,
    value: {
      ...(filters.value ? { filters: filters.value } : {}),
      bounds,
      ...(typeof columns === "number" ? { columns } : {}),
      ...(typeof rows === "number" ? { rows } : {})
    }
  };
}

function validLocation(value: unknown): value is PhotoLocationBounds | PhotoLocationNear {
  if (!isObject(value)) return false;
  if (value.kind === "bounds") {
    return hasOnlyKeys(value, ["kind", "west", "south", "east", "north"]) &&
      validLongitude(value.west) && validLongitude(value.east) && validLatitude(value.south) &&
      validLatitude(value.north) && value.south <= value.north;
  }
  return value.kind === "near" && hasOnlyKeys(value, ["kind", "latitude", "longitude", "radiusMeters"]) &&
    validLatitude(value.latitude) && validLongitude(value.longitude) &&
    typeof value.radiusMeters === "number" && Number.isFinite(value.radiusMeters) && value.radiusMeters > 0 && value.radiusMeters <= 40_100_000;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function validOptionalDate(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)));
}

function validLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

function validLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

function isMetadataScalar(value: unknown): value is string | number | boolean {
  return typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 64 * 1024);
}

function invalid<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}
