import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createMediaSource,
  defaultMediaLibrarySettings,
  deleteMediaSource,
  enqueueMediaScan,
  getBluetoothSettings,
  getMediaArtwork,
  getMediaFile,
  getMediaHome,
  getMediaLibrarySettings,
  getMediaLibraryStatus,
  getMediaSource,
  getMediaTitle,
  listMediaScans,
  listMediaSources,
  listMediaTitles,
  saveMediaLibrarySettings,
  saveMediaProgress,
  setMediaMatchOverride,
  toPublicMediaLibrarySettings,
  updateMediaSource
} from "@cyberos/db";
import { inferMimeType } from "@cyberos/storage-tools";
import {
  type MediaMatchCandidate,
  type MediaMatchStatus,
  type MediaSourceKind
} from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { searchTmdbCandidates, type TmdbCandidateSearchInput } from "../lib/tmdb-client.js";
import { resolveVodPlayerRuntime } from "../lib/vod-player.js";
import { StorageScopeError, resolveScopedExistingPath, resolveStoragePoolScope } from "../lib/storage-scope.js";

const ARTWORK_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_PROFILE_ID = "local-admin";

interface MediaRouteDependencies {
  searchTmdb?: (input: TmdbCandidateSearchInput) => Promise<MediaMatchCandidate[]>;
}

export function registerMediaRoutes(
  server: FastifyInstance,
  context: ApiRouteContext,
  dependencies: MediaRouteDependencies = {}
): void {
  const { db } = context;
  const dataRoot = context.config.paths.dataRoot;
  const searchTmdb = dependencies.searchTmdb ?? searchTmdbCandidates;

  server.get("/api/media/settings", async (_request, reply) => {
    try {
      reply.send({
        settings: toPublicMediaLibrarySettings(getMediaLibrarySettings(db) ?? defaultMediaLibrarySettings())
      });
    } catch (error) {
      reply.status(409).send({
        error: error instanceof Error ? error.message : "Media settings are invalid",
        state: "attention"
      });
    }
  });

  server.patch<{
    Body: { tmdbReadAccessToken?: string | null; language?: string; region?: string | null };
  }>("/api/media/settings", async (request, reply) => {
    try {
      let current;
      try {
        current = getMediaLibrarySettings(db) ?? defaultMediaLibrarySettings();
      } catch {
        current = defaultMediaLibrarySettings();
      }
      const settings = saveMediaLibrarySettings(db, {
        tmdbReadAccessToken: request.body?.tmdbReadAccessToken === undefined
          ? current.tmdbReadAccessToken
          : request.body.tmdbReadAccessToken,
        language: request.body?.language ?? current.language,
        region: request.body?.region === undefined ? current.region : request.body.region
      });
      reply.send({ settings: toPublicMediaLibrarySettings(settings) });
    } catch (error) {
      sendMediaError(reply, error, "Media settings are invalid");
    }
  });

  server.get("/api/media/sources", async () => ({ sources: listMediaSources(db) }));

  server.post<{
    Body: { name?: string; kind?: MediaSourceKind; storagePoolId?: string; path?: string };
  }>("/api/media/sources", async (request, reply) => {
    try {
      const scope = await resolveStoragePoolScope(dataRoot, context.system, request.body?.storagePoolId);
      const safe = await resolveScopedExistingPath(scope, request.body?.path ?? scope.mountpointPath);
      if (!(await stat(safe.realPath)).isDirectory()) throw new Error("Media source must be a directory");
      const source = createMediaSource(db, {
        name: request.body?.name ?? "",
        kind: request.body?.kind as MediaSourceKind,
        storagePoolId: scope.pool.id,
        path: safe.relativePath
      });
      const scan = enqueueMediaScan(db, source.id);
      reply.status(201).send({ source, scan });
    } catch (error) {
      sendMediaError(reply, error, "Media source is invalid");
    }
  });

  server.patch<{
    Params: { id: string };
    Body: { name?: string; enabled?: boolean };
  }>("/api/media/sources/:id", async (request, reply) => {
    try {
      const source = updateMediaSource(db, request.params.id, request.body ?? {});
      if (!source) return reply.status(404).send({ error: "Media source not found" });
      reply.send({ source });
    } catch (error) {
      sendMediaError(reply, error, "Media source is invalid");
    }
  });

  server.delete<{ Params: { id: string } }>("/api/media/sources/:id", async (request, reply) => {
    if (!deleteMediaSource(db, request.params.id)) return reply.status(404).send({ error: "Media source not found" });
    reply.status(204).send();
  });

  server.post<{ Params: { id: string } }>("/api/media/sources/:id/scan", async (request, reply) => {
    try {
      if (!getMediaSource(db, request.params.id)) return reply.status(404).send({ error: "Media source not found" });
      reply.status(202).send({ scan: enqueueMediaScan(db, request.params.id) });
    } catch (error) {
      sendMediaError(reply, error, "Media scan could not be queued");
    }
  });

  server.get<{ Querystring: { sourceId?: string; limit?: string } }>("/api/media/scans", async (request) => ({
    scans: listMediaScans(db, request.query.sourceId, numericLimit(request.query.limit, 20, 100))
  }));

  server.get("/api/media/status", async () => ({ status: getMediaLibraryStatus(db) }));
  server.get("/api/media/home", async () => getMediaHome(db, DEFAULT_PROFILE_ID));

  server.get<{
    Querystring: { kind?: string; matchStatus?: string; query?: string; limit?: string };
  }>("/api/media/titles", async (request, reply) => {
    if (request.query.kind !== undefined && request.query.kind !== "movie" && request.query.kind !== "series") {
      return reply.status(400).send({ error: "Media kind must be movie or series" });
    }
    if (request.query.matchStatus !== undefined && !isMediaMatchStatus(request.query.matchStatus)) {
      return reply.status(400).send({ error: "Media match status is invalid" });
    }
    reply.send({
      titles: listMediaTitles(db, {
        ...(request.query.kind ? { kind: request.query.kind } : {}),
        ...(request.query.matchStatus ? { matchStatus: request.query.matchStatus } : {}),
        ...(request.query.query ? { query: request.query.query } : {}),
        limit: numericLimit(request.query.limit, 40, 100),
        profileId: DEFAULT_PROFILE_ID
      }),
      nextCursor: null
    });
  });

  server.get<{ Params: { id: string } }>("/api/media/titles/:id", async (request, reply) => {
    const title = getMediaTitle(db, request.params.id);
    if (!title) return reply.status(404).send({ error: "Media title not found" });
    reply.send({ title });
  });

  server.get<{
    Params: { id: string };
    Querystring: { query?: string };
  }>("/api/media/titles/:id/match-candidates", async (request, reply) => {
    const title = getMediaTitle(db, request.params.id);
    if (!title) return reply.status(404).send({ error: "Media title not found" });
    const settings = getMediaLibrarySettings(db) ?? defaultMediaLibrarySettings();
    if (!settings.tmdbReadAccessToken) {
      return reply.status(409).send({ error: "TMDB token is not configured" });
    }
    try {
      const candidates = await searchTmdb({
        token: settings.tmdbReadAccessToken,
        kind: title.kind,
        query: request.query.query?.trim() || title.title,
        language: settings.language,
        region: settings.region,
        limit: 10
      });
      reply.send({ candidates });
    } catch {
      reply.status(502).send({ error: "TMDB search is unavailable" });
    }
  });

  server.get<{
    Params: { id: string; kind: "poster" | "backdrop" | "still" };
  }>("/api/media/titles/:id/artwork/:kind", async (request, reply) => {
    if (!["poster", "backdrop", "still"].includes(request.params.kind)) {
      return reply.status(400).send({ error: "Artwork kind is invalid" });
    }
    const title = getMediaTitle(db, request.params.id);
    const artwork = title?.artwork.find((item) => item.kind === request.params.kind && item.primary)
      ?? title?.artwork.find((item) => item.kind === request.params.kind);
    if (!artwork) return reply.status(404).send({ error: "Artwork not found" });
    try {
      return await sendArtwork(context, artwork.id, reply);
    } catch (error) {
      sendMediaError(reply, error, "Artwork is unavailable");
    }
  });

  server.put<{
    Params: { id: string };
    Body: { tmdbId?: number | null; excluded?: boolean };
  }>("/api/media/titles/:id/match", async (request, reply) => {
    try {
      const title = setMediaMatchOverride(db, {
        titleId: request.params.id,
        ...(request.body?.tmdbId === undefined ? {} : { tmdbId: request.body.tmdbId }),
        ...(request.body?.excluded === undefined ? {} : { excluded: request.body.excluded })
      });
      if (!title) return reply.status(404).send({ error: "Media title not found" });
      reply.send({ title });
    } catch (error) {
      sendMediaError(reply, error, "Media match is invalid");
    }
  });

  server.post<{
    Params: { id: string };
    Body: { positionSeconds?: number; durationSeconds?: number | null };
  }>("/api/media/files/:id/progress", async (request, reply) => {
    try {
      if (typeof request.body?.positionSeconds !== "number") {
        return reply.status(400).send({ error: "Media position is required" });
      }
      const progress = saveMediaProgress(db, {
        fileId: request.params.id,
        positionSeconds: request.body.positionSeconds,
        ...(request.body.durationSeconds === undefined ? {} : { durationSeconds: request.body.durationSeconds }),
        profileId: DEFAULT_PROFILE_ID
      });
      reply.send({ progress });
    } catch (error) {
      sendMediaError(reply, error, "Media progress is invalid");
    }
  });

  server.post<{
    Params: { id: string };
    Body: { startPositionSeconds?: number };
  }>("/api/media/files/:id/play", async (request, reply) => {
    try {
      const file = getMediaFile(db, request.params.id);
      if (!file) return reply.status(404).send({ error: "Media file not found" });
      const startPositionSeconds = request.body?.startPositionSeconds;
      if (startPositionSeconds !== undefined && (!Number.isFinite(startPositionSeconds) || startPositionSeconds < 0)) {
        return reply.status(400).send({ error: "Start position must be non-negative" });
      }
      const scope = await resolveStoragePoolScope(dataRoot, context.system, file.storagePoolId);
      const safe = await resolveScopedExistingPath(scope, file.relativePath);
      if (!(await stat(safe.realPath)).isFile()) return reply.status(404).send({ error: "Media file not found" });
      const audioDeviceId = getBluetoothSettings(db)?.defaultAudioDeviceId ?? null;
      const status = await resolveVodPlayerRuntime(context).command({
        type: "play",
        storagePoolId: file.storagePoolId,
        relativePath: safe.relativePath,
        mediaFileId: file.id,
        ...(audioDeviceId ? { audioDeviceId } : {}),
        ...(startPositionSeconds === undefined ? {} : { startPositionSeconds })
      });
      reply.send({ status });
    } catch (error) {
      sendMediaError(reply, error, "Media playback could not start");
    }
  });

  server.get<{ Params: { id: string } }>("/api/media/artwork/:id", async (request, reply) => {
    try {
      return await sendArtwork(context, request.params.id, reply);
    } catch (error) {
      sendMediaError(reply, error, "Artwork is unavailable");
    }
  });

  server.get("/api/media/events", async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    raw.write(": connected\n\n");
    let previous = "";
    const flush = () => {
      if (raw.destroyed) return;
      const snapshot = JSON.stringify({
        status: getMediaLibraryStatus(db),
        sources: listMediaSources(db),
        scans: listMediaScans(db, undefined, 20)
      });
      if (snapshot === previous) return;
      previous = snapshot;
      raw.write("event: snapshot\n");
      raw.write(`data: ${snapshot}\n\n`);
    };
    flush();
    const timer = setInterval(flush, 1_000);
    request.raw.on("close", () => clearInterval(timer));
  });
}

async function sendArtwork(context: ApiRouteContext, id: string, reply: FastifyReply): Promise<unknown> {
  const artwork = getMediaArtwork(context.db, id);
  if (!artwork) return reply.status(404).send({ error: "Artwork not found" });
  if (artwork.source === "local") {
    const title = getMediaTitle(context.db, artwork.titleId);
    const source = title ? getMediaSource(context.db, title.sourceId) : null;
    if (!source) return reply.status(404).send({ error: "Artwork source not found" });
    const prefix = `local/${source.id}/`;
    if (!artwork.cacheKey.startsWith(prefix)) return reply.status(404).send({ error: "Artwork path is invalid" });
    const relativePath = artwork.cacheKey.slice(prefix.length);
    if (source.path !== "." && relativePath !== source.path && !relativePath.startsWith(`${source.path}/`)) {
      return reply.status(404).send({ error: "Artwork path is outside its media source" });
    }
    const scope = await resolveStoragePoolScope(
      context.config.paths.dataRoot,
      context.system,
      source.storagePoolId
    );
    const safe = await resolveScopedExistingPath(scope, relativePath);
    const metadata = await stat(safe.realPath);
    if (!metadata.isFile()) return reply.status(404).send({ error: "Artwork not found" });
    reply.header("Content-Type", inferMimeType(safe.realPath));
    reply.header("Content-Length", String(metadata.size));
    reply.header("Cache-Control", "private, max-age=3600");
    return reply.send(createReadStream(safe.realPath));
  }

  const cachePath = await cacheTmdbArtwork(context, artwork.id, artwork.sourceUrl);
  const metadata = await stat(cachePath);
  reply.header("Content-Type", inferMimeType(cachePath));
  reply.header("Content-Length", String(metadata.size));
  reply.header("Cache-Control", "public, max-age=604800, immutable");
  return reply.send(createReadStream(cachePath));
}

async function cacheTmdbArtwork(context: ApiRouteContext, artworkId: string, sourceUrl: string | null): Promise<string> {
  if (!sourceUrl) throw new Error("TMDB artwork URL is missing");
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:" || url.hostname !== "image.tmdb.org") throw new Error("TMDB artwork URL is invalid");
  const extension = imageExtension(url.pathname);
  const directory = path.join(context.config.paths.stateDir, "media-cache", "tv");
  const outputPath = path.join(directory, `${artworkId}${extension}`);
  try {
    if ((await stat(outputPath)).isFile()) return outputPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) throw new Error(`TMDB artwork returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > ARTWORK_MAX_BYTES) throw new Error("TMDB artwork exceeds the size limit");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ARTWORK_MAX_BYTES) {
      await reader.cancel();
      throw new Error("TMDB artwork exceeds the size limit");
    }
    chunks.push(value);
  }
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${artworkId}.${randomUUID()}.part`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    for (const chunk of chunks) await handle.write(chunk);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return outputPath;
}

function imageExtension(pathname: string): string {
  const extension = path.extname(pathname).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp"].includes(extension) ? extension : ".jpg";
}

function numericLimit(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

function isMediaMatchStatus(value: string): value is MediaMatchStatus {
  return value === "matched" || value === "pending" || value === "unmatched" || value === "excluded";
}

function sendMediaError(reply: FastifyReply, error: unknown, fallback: string): void {
  const status = error instanceof StorageScopeError
    ? error.statusCode
    : typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 400;
  reply.status(status).send({ error: error instanceof Error ? error.message : fallback });
}
