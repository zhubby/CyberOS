import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ZipArchive } from "archiver";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { JsonValue } from "@zos/capabilities";
import {
  createMcpResourceToken,
  getNasRoot,
  getPhotostaffAsset,
  getPhotostaffLibrarySettings,
  getRootReadiness,
  type McpResourceRecord,
  type ZosDatabase
} from "@zos/db";
import {
  assertNoSymlinkPathSegments,
  inferMimeType,
  isPathInside,
  resolveSafeExistingPath,
  StorageScopeSafetyError
} from "@zos/nas-tools";
import {
  PHOTOSTAFF_DATA_DIRECTORY_NAME,
  photostaffMediaKind,
  type PhotostaffAssetRecord,
  type ZosConfig
} from "@zos/shared";
import type { ApiRouteContext } from "../context.js";
import { sendFileStream } from "./files.js";
import { ffmpegVideoTranscoder, VideoCache } from "./video-cache.js";

const RESOURCE_TTL_MS = 60_000;
const MAX_EXPORT_ENTRIES = 20_000;

type PhotoVariant = "thumbnail" | "preview" | "original" | "video";

interface FileDescriptor {
  rootId: string;
  path: string;
}

interface FileExportDescriptor {
  rootId: string;
  paths: string[];
}

interface PhotoMediaDescriptor {
  assetId: string;
  variant: PhotoVariant;
}

interface PhotoExportDescriptor {
  assetIds: string[];
}

interface ArchiveEntry {
  realPath: string;
  archiveName: string;
  isDirectory: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

interface ResolvedPhotoAsset {
  asset: PhotostaffAssetRecord;
  settingsUpdatedAt: string;
  realPath: string;
  rootRealPath: string;
  libraryRealPath: string;
}

export class McpResourceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "McpResourceError";
  }
}

export async function createFileMcpResource(input: {
  db: ZosDatabase;
  clientId: string;
  baseUrl: string;
  rootId: string;
  relativePath: string;
}): Promise<JsonValue> {
  const root = requireReadyRoot(input.db, input.rootId);
  const safe = await resolveSafeExistingPath(root.path, input.relativePath);
  await assertNoSymlinkPathSegments(safe.rootRealPath, safe.absolutePath);
  const fileStat = await stat(safe.realPath);
  if (!fileStat.isFile()) throw new McpResourceError(400, "invalid_resource", "Resource links require a regular file");
  const expiresAt = resourceExpiry();
  const created = createMcpResourceToken(input.db, {
    clientId: input.clientId,
    kind: "file",
    descriptor: { rootId: root.id, path: safe.relativePath },
    revision: fileRevision(safe.relativePath, fileStat.size, fileStat.mtimeMs),
    mimeType: inferMimeType(safe.relativePath),
    fileName: path.basename(safe.relativePath),
    sizeBytes: fileStat.size,
    expiresAt
  });
  return resourceLink(input.baseUrl, created.token, created.resource);
}

export async function createFileExportMcpResource(input: {
  db: ZosDatabase;
  clientId: string;
  baseUrl: string;
  rootId: string;
  paths: string[];
  archiveName?: string;
}): Promise<JsonValue> {
  const root = requireReadyRoot(input.db, input.rootId);
  const snapshot = await snapshotFileExport(root.path, input.paths);
  const expiresAt = resourceExpiry();
  const created = createMcpResourceToken(input.db, {
    clientId: input.clientId,
    kind: "file_export",
    descriptor: { rootId: root.id, paths: snapshot.paths },
    revision: snapshot.revision,
    mimeType: "application/zip",
    fileName: zipName(input.archiveName ?? "zos-files.zip"),
    sizeBytes: null,
    expiresAt
  });
  return resourceLink(input.baseUrl, created.token, created.resource);
}

export async function fileExportResourceRevision(
  db: ZosDatabase,
  rootId: string,
  paths: string[]
): Promise<string> {
  const root = requireReadyRoot(db, rootId);
  return (await snapshotFileExport(root.path, paths)).revision;
}

export async function createPhotoMediaMcpResource(input: {
  db: ZosDatabase;
  config: ZosConfig;
  clientId: string;
  baseUrl: string;
  assetId: string;
  variant: PhotoVariant;
}): Promise<JsonValue> {
  const resolved = await resolvePhotoAsset(input.db, input.assetId);
  const media = await resolvePhotoMedia(input.config, resolved, input.variant);
  const expiresAt = resourceExpiry();
  const created = createMcpResourceToken(input.db, {
    clientId: input.clientId,
    kind: "photo_media",
    descriptor: { assetId: input.assetId, variant: input.variant },
    revision: media.revision,
    mimeType: media.mimeType,
    fileName: media.fileName,
    sizeBytes: media.sizeBytes,
    expiresAt
  });
  return resourceLink(input.baseUrl, created.token, created.resource);
}

export async function createPhotoExportMcpResource(input: {
  db: ZosDatabase;
  clientId: string;
  baseUrl: string;
  assetIds: string[];
  archiveName?: string;
}): Promise<JsonValue> {
  const snapshot = await snapshotPhotoExport(input.db, input.assetIds);
  const expiresAt = resourceExpiry();
  const created = createMcpResourceToken(input.db, {
    clientId: input.clientId,
    kind: "photo_export",
    descriptor: { assetIds: snapshot.assetIds },
    revision: snapshot.revision,
    mimeType: "application/zip",
    fileName: zipName(input.archiveName ?? "zos-photos.zip"),
    sizeBytes: null,
    expiresAt
  });
  return resourceLink(input.baseUrl, created.token, created.resource);
}

export async function photoExportResourceRevision(db: ZosDatabase, assetIds: string[]): Promise<string> {
  return (await snapshotPhotoExport(db, assetIds)).revision;
}

export function createMcpResourceResponder(
  context: Pick<ApiRouteContext, "config" | "db" | "videoTranscoder">
) {
  const videoCache = new VideoCache({
    dataDir: context.config.dataDir,
    transcoder: context.videoTranscoder ?? ffmpegVideoTranscoder
  });
  return async (resource: McpResourceRecord, request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    switch (resource.kind) {
      case "file":
        return serveFileResource(context.db, resource, request, reply);
      case "file_export":
        return serveFileExportResource(context.db, resource, reply);
      case "photo_media":
        return servePhotoMediaResource(context.db, context.config, videoCache, resource, request, reply);
      case "photo_export":
        return servePhotoExportResource(context.db, resource, reply);
    }
  };
}

async function serveFileResource(
  db: ZosDatabase,
  resource: McpResourceRecord,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const descriptor = fileDescriptor(resource.descriptor);
  const root = requireReadyRoot(db, descriptor.rootId);
  const safe = await resolveSafeExistingPath(root.path, descriptor.path);
  await assertNoSymlinkPathSegments(safe.rootRealPath, safe.absolutePath);
  const fileStat = await stat(safe.realPath);
  if (!fileStat.isFile() || fileRevision(safe.relativePath, fileStat.size, fileStat.mtimeMs) !== resource.revision) {
    throw new McpResourceError(409, "resource_changed", "Resource changed after the link was created");
  }
  reply.header("Cache-Control", "private, no-store");
  reply.header("Content-Disposition", contentDisposition(resource.fileName, true));
  return sendFileStream(reply, request.headers.range, safe.realPath, resource.mimeType);
}

async function serveFileExportResource(
  db: ZosDatabase,
  resource: McpResourceRecord,
  reply: FastifyReply
): Promise<unknown> {
  const descriptor = fileExportDescriptor(resource.descriptor);
  const root = requireReadyRoot(db, descriptor.rootId);
  const snapshot = await snapshotFileExport(root.path, descriptor.paths);
  if (snapshot.revision !== resource.revision) {
    throw new McpResourceError(409, "resource_changed", "Export sources changed after the link was created");
  }
  return streamArchive(snapshot.entries, resource.fileName, reply);
}

async function servePhotoMediaResource(
  db: ZosDatabase,
  config: ZosConfig,
  videoCache: VideoCache,
  resource: McpResourceRecord,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  const descriptor = photoMediaDescriptor(resource.descriptor);
  const resolved = await resolvePhotoAsset(db, descriptor.assetId);
  const media = await resolvePhotoMedia(config, resolved, descriptor.variant);
  if (media.revision !== resource.revision) {
    throw new McpResourceError(409, "resource_changed", "Photo changed after the link was created");
  }
  reply.header("Cache-Control", "private, no-store");
  reply.header("Content-Disposition", contentDisposition(resource.fileName, false));
  if (!media.transcode) {
    return sendFileStream(reply, request.headers.range, media.realPath, media.mimeType);
  }
  const sourceStat = await stat(resolved.realPath);
  const source = {
    rootId: resolved.asset.rootId,
    relativePath: resolved.asset.path,
    realPath: resolved.realPath,
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
}

async function servePhotoExportResource(
  db: ZosDatabase,
  resource: McpResourceRecord,
  reply: FastifyReply
): Promise<unknown> {
  const descriptor = photoExportDescriptor(resource.descriptor);
  const snapshot = await snapshotPhotoExport(db, descriptor.assetIds);
  if (snapshot.revision !== resource.revision) {
    throw new McpResourceError(409, "resource_changed", "Photo export changed after the link was created");
  }
  return streamArchive(snapshot.entries, resource.fileName, reply);
}

async function snapshotFileExport(rootPath: string, requestedPaths: string[]): Promise<{
  paths: string[];
  entries: ArchiveEntry[];
  revision: string;
}> {
  if (!requestedPaths.length || requestedPaths.length > 200) {
    throw new McpResourceError(400, "invalid_resource", "Select between 1 and 200 export sources");
  }
  const unique = new Set<string>();
  const topNames = new Set<string>();
  const entries: ArchiveEntry[] = [];
  const paths: string[] = [];
  try {
    for (const requestedPath of requestedPaths) {
      const safe = await resolveSafeExistingPath(rootPath, requestedPath);
      await assertNoSymlinkPathSegments(safe.rootRealPath, safe.absolutePath);
      if (unique.has(safe.relativePath)) throw new McpResourceError(400, "invalid_resource", "Export sources must be unique");
      unique.add(safe.relativePath);
      paths.push(safe.relativePath);
      const topName = uniqueArchiveName(path.basename(safe.relativePath), topNames);
      await collectArchiveEntries(safe.realPath, topName, entries);
    }
  } catch (error) {
    if (error instanceof StorageScopeSafetyError) {
      throw new McpResourceError(error.statusCode, "unsafe_resource", "Export source is outside the permitted storage boundary");
    }
    throw error;
  }
  entries.sort((left, right) => left.archiveName.localeCompare(right.archiveName));
  return { paths, entries, revision: archiveRevision(entries) };
}

async function collectArchiveEntries(realPathValue: string, archiveName: string, entries: ArchiveEntry[]): Promise<void> {
  if (entries.length >= MAX_EXPORT_ENTRIES) {
    throw new McpResourceError(413, "resource_too_large", `Export exceeds ${MAX_EXPORT_ENTRIES} entries`);
  }
  const fileStat = await lstat(realPathValue);
  if (fileStat.isSymbolicLink()) throw new McpResourceError(400, "unsafe_resource", "Export sources cannot contain symbolic links");
  if (!fileStat.isFile() && !fileStat.isDirectory()) {
    throw new McpResourceError(400, "invalid_resource", "Export sources must be files or directories");
  }
  entries.push({
    realPath: realPathValue,
    archiveName: archiveName.split(path.sep).join("/"),
    isDirectory: fileStat.isDirectory(),
    sizeBytes: fileStat.isFile() ? fileStat.size : 0,
    mtimeMs: fileStat.mtimeMs
  });
  if (!fileStat.isDirectory()) return;
  const children = await readdir(realPathValue, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    await collectArchiveEntries(path.join(realPathValue, child.name), path.join(archiveName, child.name), entries);
  }
}

async function snapshotPhotoExport(db: ZosDatabase, assetIds: string[]): Promise<{
  assetIds: string[];
  entries: ArchiveEntry[];
  revision: string;
}> {
  if (!assetIds.length || assetIds.length > 500 || new Set(assetIds).size !== assetIds.length) {
    throw new McpResourceError(400, "invalid_resource", "Photo export IDs must be unique and bounded");
  }
  const usedNames = new Set<string>();
  const files = new Map<string, { realPath: string; name: string }>();
  const assetRevisions: string[] = [];
  for (const assetId of assetIds) {
    const resolved = await resolvePhotoAsset(db, assetId);
    files.set(resolved.asset.path, { realPath: resolved.realPath, name: resolved.asset.name });
    const sidecar = await resolveAssociatedSidecar(resolved);
    if (sidecar) files.set(sidecar.relativePath, { realPath: sidecar.realPath, name: sidecar.name });
    assetRevisions.push(photoAssetRevision(resolved));
  }
  const entries: ArchiveEntry[] = [];
  for (const file of files.values()) {
    const fileStat = await lstat(file.realPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new McpResourceError(409, "resource_changed", "Photo export source is no longer a regular file");
    }
    entries.push({
      realPath: file.realPath,
      archiveName: uniqueArchiveName(file.name, usedNames),
      isDirectory: false,
      sizeBytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs
    });
  }
  entries.sort((left, right) => left.archiveName.localeCompare(right.archiveName));
  return {
    assetIds: [...assetIds],
    entries,
    revision: hashJson({ assets: assetRevisions, archive: archiveRevision(entries) })
  };
}

async function resolvePhotoAsset(db: ZosDatabase, assetId: string): Promise<ResolvedPhotoAsset> {
  const settings = getPhotostaffLibrarySettings(db);
  if (!settings) throw new McpResourceError(409, "not_ready", "Photo library is not configured");
  const asset = getPhotostaffAsset(db, assetId, settings.updatedAt);
  if (!asset || asset.rootId !== settings.rootId || asset.storagePoolId !== settings.storagePoolId || asset.status !== "ready") {
    throw new McpResourceError(404, "resource_not_found", "Photo asset was not found");
  }
  const root = requireReadyRoot(db, asset.rootId);
  const library = await resolveSafeExistingPath(root.path, settings.path);
  const safe = await resolveSafeExistingPath(root.path, asset.path);
  await assertNoSymlinkPathSegments(safe.rootRealPath, safe.absolutePath);
  if (!isPathInside(library.realPath, safe.realPath)) {
    throw new McpResourceError(404, "resource_not_found", "Photo asset is outside the configured library");
  }
  const fileStat = await stat(safe.realPath);
  if (!fileStat.isFile() || fileStat.size !== asset.sizeBytes || Math.trunc(fileStat.mtimeMs) !== Math.trunc(asset.mtimeMs)) {
    throw new McpResourceError(409, "resource_changed", "Photo asset no longer matches its index record");
  }
  return {
    asset,
    settingsUpdatedAt: settings.updatedAt,
    realPath: safe.realPath,
    rootRealPath: safe.rootRealPath,
    libraryRealPath: library.realPath
  };
}

async function resolvePhotoMedia(config: ZosConfig, resolved: ResolvedPhotoAsset, variant: PhotoVariant): Promise<{
  realPath: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number | null;
  transcode: boolean;
  revision: string;
}> {
  if (variant === "video") {
    if (!resolved.asset.mimeType.startsWith("video/")) {
      throw new McpResourceError(415, "unsupported_media", "Photo asset is not a video");
    }
    const extension = path.extname(resolved.realPath).toLowerCase();
    const compatible = extension === ".mp4" || extension === ".webm";
    return {
      realPath: resolved.realPath,
      mimeType: compatible ? resolved.asset.mimeType : "video/mp4",
      fileName: compatible ? resolved.asset.name : `${path.parse(resolved.asset.name).name}.mp4`,
      sizeBytes: compatible ? resolved.asset.sizeBytes : null,
      transcode: !compatible,
      revision: photoAssetRevision(resolved)
    };
  }
  if (variant === "original" || (variant === "preview" && resolved.asset.mimeType === "image/gif")) {
    return {
      realPath: resolved.realPath,
      mimeType: resolved.asset.mimeType,
      fileName: resolved.asset.name,
      sizeBytes: resolved.asset.sizeBytes,
      transcode: false,
      revision: photoAssetRevision(resolved)
    };
  }
  const key = variant === "thumbnail" ? resolved.asset.thumbnailKey : resolved.asset.previewKey;
  if (!key) throw new McpResourceError(404, "resource_not_found", "Photo derivative is not available");
  const cacheRoot = path.join(config.dataDir, PHOTOSTAFF_DATA_DIRECTORY_NAME);
  const candidate = path.resolve(cacheRoot, key);
  if (!isPathInside(cacheRoot, candidate)) throw new McpResourceError(404, "resource_not_found", "Photo derivative is invalid");
  const [cacheRealPath, candidateRealPath] = await Promise.all([realpath(cacheRoot), realpath(candidate)]);
  if (!isPathInside(cacheRealPath, candidateRealPath)) {
    throw new McpResourceError(404, "resource_not_found", "Photo derivative is outside the cache");
  }
  const derivativeStat = await stat(candidateRealPath);
  if (!derivativeStat.isFile()) throw new McpResourceError(404, "resource_not_found", "Photo derivative is not available");
  return {
    realPath: candidateRealPath,
    mimeType: "image/webp",
    fileName: `${path.parse(resolved.asset.name).name}-${variant}.webp`,
    sizeBytes: derivativeStat.size,
    transcode: false,
    revision: hashJson({
      asset: photoAssetRevision(resolved),
      variant,
      key,
      sizeBytes: derivativeStat.size,
      mtimeMs: derivativeStat.mtimeMs
    })
  };
}

async function resolveAssociatedSidecar(asset: ResolvedPhotoAsset): Promise<{
  relativePath: string;
  realPath: string;
  name: string;
} | null> {
  const directoryPath = path.dirname(asset.realPath);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const actualByLower = new Map(names.map((name) => [name.toLocaleLowerCase("und"), name]));
  const exact = actualByLower.get(`${asset.asset.name}.xmp`.toLocaleLowerCase("und"));
  let sidecarName = exact ?? null;
  if (!sidecarName) {
    const stem = path.parse(asset.asset.name).name.toLocaleLowerCase("und");
    const shared = actualByLower.get(`${stem}.xmp`);
    if (shared) {
      const siblings = names.filter((name) => photostaffMediaKind(name) && path.parse(name).name.toLocaleLowerCase("und") === stem);
      const rawSiblings = siblings.filter((name) => photostaffMediaKind(name) === "raw");
      if (siblings.length === 1 || (rawSiblings.length === 1 && rawSiblings[0] === asset.asset.name)) sidecarName = shared;
    }
  }
  if (!sidecarName) return null;
  const relativePath = path.join(path.dirname(asset.asset.path), sidecarName);
  const safe = await resolveSafeExistingPath(asset.rootRealPath, relativePath);
  await assertNoSymlinkPathSegments(safe.rootRealPath, safe.absolutePath);
  if (!isPathInside(asset.libraryRealPath, safe.realPath)) return null;
  const sidecarStat = await lstat(safe.realPath);
  if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) return null;
  return { relativePath: safe.relativePath, realPath: safe.realPath, name: sidecarName };
}

function streamArchive(entries: ArchiveEntry[], fileName: string, reply: FastifyReply): unknown {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.once("warning", (error: Error) => archive.destroy(error));
  archive.once("error", (error: Error) => archive.destroy(error));
  for (const entry of entries) {
    if (entry.isDirectory) archive.append("", { name: `${entry.archiveName.replace(/\/$/u, "")}/` });
    else archive.file(entry.realPath, { name: entry.archiveName });
  }
  reply.header("Content-Type", "application/zip");
  reply.header("Cache-Control", "private, no-store");
  reply.header("Content-Disposition", contentDisposition(fileName, true));
  reply.send(archive);
  void archive.finalize();
  return reply;
}

function resourceLink(baseUrl: string, token: string, resource: McpResourceRecord): JsonValue {
  return {
    url: `${baseUrl.replace(/\/$/u, "")}/mcp-resource/${token}`,
    mimeType: resource.mimeType,
    sizeBytes: resource.sizeBytes,
    fileName: resource.fileName,
    expiresAt: resource.expiresAt,
    oneTime: true
  };
}

function resourceExpiry(): string {
  return new Date(Date.now() + RESOURCE_TTL_MS).toISOString();
}

function requireReadyRoot(db: ZosDatabase, rootId: string) {
  const root = getNasRoot(db, rootId);
  if (!root || !root.enabled) throw new McpResourceError(404, "root_not_found", "NAS root was not found");
  if (root.mountPolicy === "required" && getRootReadiness(db, root.id)?.status !== "ready") {
    throw new McpResourceError(503, "root_not_ready", "NAS root is not ready");
  }
  return root;
}

function photoAssetRevision(resolved: ResolvedPhotoAsset): string {
  const asset = resolved.asset;
  return hashJson({
    libraryUpdatedAt: resolved.settingsUpdatedAt,
    id: asset.id,
    rootId: asset.rootId,
    storagePoolId: asset.storagePoolId,
    path: asset.path,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    mtimeMs: asset.mtimeMs,
    contentHash: asset.contentHash,
    thumbnailKey: asset.thumbnailKey,
    previewKey: asset.previewKey,
    derivativeSchemaVersion: asset.derivativeSchemaVersion,
    status: asset.status
  });
}

function fileRevision(relativePath: string, sizeBytes: number, mtimeMs: number): string {
  return hashJson({ relativePath, sizeBytes, modifiedAt: new Date(mtimeMs).toISOString() });
}

function archiveRevision(entries: ArchiveEntry[]): string {
  return hashJson(entries.map(({ archiveName, isDirectory, sizeBytes, mtimeMs }) => ({
    archiveName,
    isDirectory,
    sizeBytes,
    mtimeMs
  })));
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function contentDisposition(fileName: string, attachment: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/gu, "_").replace(/["\\]/gu, "_");
  return `${attachment ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function zipName(value: string): string {
  const base = path.basename(value.trim()).replace(/[\r\n\0]/gu, "").slice(0, 251) || "export";
  return base.toLowerCase().endsWith(".zip") ? base : `${base}.zip`;
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

function fileDescriptor(value: JsonValue): FileDescriptor {
  const object = descriptorObject(value);
  return { rootId: requiredDescriptorString(object.rootId), path: requiredDescriptorString(object.path) };
}

function fileExportDescriptor(value: JsonValue): FileExportDescriptor {
  const object = descriptorObject(value);
  return { rootId: requiredDescriptorString(object.rootId), paths: descriptorStringArray(object.paths) };
}

function photoMediaDescriptor(value: JsonValue): PhotoMediaDescriptor {
  const object = descriptorObject(value);
  const variant = requiredDescriptorString(object.variant);
  if (!(["thumbnail", "preview", "original", "video"] as string[]).includes(variant)) {
    throw new McpResourceError(400, "invalid_resource", "Photo resource variant is invalid");
  }
  return { assetId: requiredDescriptorString(object.assetId), variant: variant as PhotoVariant };
}

function photoExportDescriptor(value: JsonValue): PhotoExportDescriptor {
  const object = descriptorObject(value);
  return { assetIds: descriptorStringArray(object.assetIds) };
}

function descriptorObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpResourceError(400, "invalid_resource", "Resource descriptor is invalid");
  }
  return value as Record<string, JsonValue>;
}

function requiredDescriptorString(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !value) throw new McpResourceError(400, "invalid_resource", "Resource descriptor is invalid");
  return value;
}

function descriptorStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new McpResourceError(400, "invalid_resource", "Resource descriptor is invalid");
  }
  return value as string[];
}
