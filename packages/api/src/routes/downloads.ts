import { constants as fsConstants } from "node:fs";
import { access, lstat, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createDownloadTask,
  createTorrentDownloadTask,
  createTorrentPreview,
  deleteTorrentPreview,
  deleteDownloadTask,
  getDownloadTask,
  getDownloadWorkerHealth,
  getTorrentPreview,
  listDownloadTaskFiles,
  listDownloadTasks,
  requestDownloadTaskControl,
  transitionDownloadTask,
  type CyberOsDatabase
} from "@cyberos/db";
import { type DownloadTaskRecord, type DownloadTaskStatus } from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import {
  resolveScopedExistingPath,
  resolveScopedTargetPath,
  resolveStoragePoolScope,
  StorageScopeError,
  type StoragePoolScope
} from "../lib/storage-scope.js";

const MAX_URL_LENGTH = 8192;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_TARGET_DIRECTORY_LENGTH = 4096;
const MAX_TORRENT_FILE_COUNT = 10_000;
const MAX_TORRENT_UPLOAD_BYTES = 16 * 1024 * 1024;

export function registerDownloadRoutes(server: FastifyInstance, { config, db, system }: ApiRouteContext): void {
  const dataRoot = config.paths.dataRoot;
  server.post<{
    Body: {
      url?: string;
      storagePoolId?: string;
      targetDirectory?: string;
      fileName?: string;
      sha256?: string;
      torrentPreviewId?: string;
      selectedFileIndices?: number[];
      seedRatioLimit?: number;
      seedTimeLimitSeconds?: number;
    };
  }>("/api/downloads", async (request, reply) => {
    if (request.body?.torrentPreviewId !== undefined) {
      await createTorrentTaskFromPreview(db, dataRoot, system, request.body, reply);
      return;
    }
    const url = normalizeDownloadUrl(request.body?.url);
    const targetDirectory = normalizeTargetDirectory(request.body?.targetDirectory);
    const fileName = normalizeFileName(request.body?.fileName);
    const sha256 = normalizeSha256(request.body?.sha256);
    if ("error" in url) {
      reply.status(400).send({ error: url.error });
      return;
    }
    if ("error" in targetDirectory) {
      reply.status(400).send({ error: targetDirectory.error });
      return;
    }
    if ("error" in fileName) {
      reply.status(400).send({ error: fileName.error });
      return;
    }
    if ("error" in sha256) {
      reply.status(400).send({ error: sha256.error });
      return;
    }

    let scope: StoragePoolScope;
    try {
      scope = await resolveStoragePoolScope(dataRoot, system, request.body?.storagePoolId);
    } catch (error) {
      sendDownloadError(reply, error);
      return;
    }

    try {
      const directory = await resolveScopedExistingPath(scope, targetDirectory.path);
      const directoryStat = await stat(directory.realPath);
      if (!directoryStat.isDirectory()) {
        reply.status(400).send({ error: "Download target directory must be a directory" });
        return;
      }
      try {
        await access(directory.realPath, fsConstants.W_OK | fsConstants.X_OK);
      } catch (error) {
        if (isPermissionError(error)) {
          reply.status(403).send({ error: "Download target directory is not writable" });
          return;
        }
        throw error;
      }

      const normalizedDirectory = directory.relativePath;
      const targetPath = path.join(normalizedDirectory, fileName.name);
      const target = await resolveScopedTargetPath(scope, targetPath);
      if (await exists(target.absolutePath)) {
        reply.status(409).send({ error: "Download target already exists" });
        return;
      }

      const task = createDownloadTask(db, {
        url: url.value,
        storagePoolId: scope.pool.id,
        targetDirectory: normalizedDirectory,
        targetFileName: fileName.name,
        targetPath,
        expectedSha256: sha256.value
      });
      reply.status(201).send({ task });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        reply.status(409).send({ error: "Download target already has a task" });
        return;
      }
      sendDownloadError(reply, error);
    }
  });

  server.post<{
    Body: { magnet?: string };
  }>("/api/downloads/torrent-previews", async (request, reply) => {
    if (request.isMultipart()) {
      const file = await request.file({
        limits: { fields: 0, files: 1, fileSize: MAX_TORRENT_UPLOAD_BYTES, parts: 1 }
      });
      if (!file || file.fieldname !== "torrent") {
        reply.status(400).send({ error: "Torrent file is required" });
        return;
      }
      const metainfo = await file.toBuffer();
      if (!file.filename.toLowerCase().endsWith(".torrent")) {
        reply.status(400).send({ error: "Uploaded file must use the .torrent extension" });
        return;
      }
      if (!metainfo.length) {
        reply.status(400).send({ error: "Torrent file is empty" });
        return;
      }
      const preview = createTorrentPreview(db, {
        sourceKind: "torrent",
        metainfo
      });
      reply.status(202).send({ preview: { ...preview, files: [] } });
      return;
    }
    const magnet = normalizeMagnet(request.body?.magnet);
    if ("error" in magnet) {
      reply.status(400).send({ error: magnet.error });
      return;
    }
    const preview = createTorrentPreview(db, {
      sourceKind: "magnet",
      sourceUri: magnet.value
    });
    reply.status(202).send({ preview: { ...preview, files: [] } });
  });

  server.get<{
    Params: { id: string };
  }>("/api/downloads/torrent-previews/:id", async (request, reply) => {
    const preview = getTorrentPreview(db, request.params.id);
    if (!preview) {
      reply.status(404).send({ error: "Torrent preview not found" });
      return;
    }
    reply.send({ preview });
  });

  server.delete<{
    Params: { id: string };
  }>("/api/downloads/torrent-previews/:id", async (request, reply) => {
    if (deleteTorrentPreview(db, request.params.id)) {
      reply.status(204).send();
      return;
    }
    const preview = getTorrentPreview(db, request.params.id);
    if (!preview) {
      reply.status(404).send({ error: "Torrent preview not found" });
      return;
    }
    reply.status(409).send({ error: "Torrent preview is currently resolving" });
  });

  server.get("/api/downloads", async () => ({
    tasks: listDownloadTasks(db, { limit: 500 }),
    health: getDownloadWorkerHealth(db)
  }));

  server.get<{
    Params: { id: string };
  }>("/api/downloads/:id/files", async (request, reply) => {
    const task = getDownloadTask(db, request.params.id);
    if (!task) {
      reply.status(404).send({ error: "Download task not found" });
      return;
    }
    reply.send({ files: listDownloadTaskFiles(db, task.id) });
  });

  server.post<{
    Params: { id: string };
  }>("/api/downloads/:id/pause", async (request, reply) => {
    const task = getDownloadTask(db, request.params.id);
    if (!task) {
      reply.status(404).send({ error: "Download task not found" });
      return;
    }
    if (task.status === "running" || task.status === "seeding") {
      const requested = requestDownloadTaskControl(db, { id: task.id, request: "pause" });
      reply.send({ task: requested ?? task });
      return;
    }
    await transitionTaskStatus(db, dataRoot, system, request.params.id, { from: ["queued"], to: "paused" }, reply);
  });

  server.post<{
    Params: { id: string };
  }>("/api/downloads/:id/resume", async (request, reply) => {
    await transitionTaskStatus(db, dataRoot, system, request.params.id, {
      from: ["paused"],
      to: "queued"
    }, reply);
  });

  server.post<{
    Params: { id: string };
  }>("/api/downloads/:id/cancel", async (request, reply) => {
    const task = getDownloadTask(db, request.params.id);
    if (!task) {
      reply.status(404).send({ error: "Download task not found" });
      return;
    }
    const wasRunning = task.status === "running";
    if (wasRunning) {
      const requested = requestDownloadTaskControl(db, { id: task.id, request: "cancel" });
      reply.send({ task: requested ?? task });
      return;
    }
    const cancelled = transitionDownloadTask(db, {
      id: task.id,
      from: ["queued", "running", "paused"],
      to: "cancelled",
      error: null
    });
    if (!cancelled) {
      reply.status(409).send({ error: `Download task cannot be cancelled while ${task.status}` });
      return;
    }
    if (!wasRunning) {
      if (!(await removePartialFile(dataRoot, system, cancelled))) {
        reply.status(409).send({ error: "Download partial file could not be removed" });
        return;
      }
    }
    reply.send({ task: getDownloadTask(db, task.id) ?? cancelled });
  });

  server.post<{
    Params: { id: string };
  }>("/api/downloads/:id/stop-seeding", async (request, reply) => {
    const task = getDownloadTask(db, request.params.id);
    if (!task) {
      reply.status(404).send({ error: "Download task not found" });
      return;
    }
    if (task.status !== "seeding") {
      reply.status(409).send({ error: `Download task cannot stop seeding while ${task.status}` });
      return;
    }
    const requested = requestDownloadTaskControl(db, { id: task.id, request: "stop_seeding" });
    reply.send({ task: requested ?? task });
  });

  server.post<{
    Params: { id: string };
  }>("/api/downloads/:id/retry", async (request, reply) => {
    const task = getDownloadTask(db, request.params.id);
    if (!task) {
      reply.status(404).send({ error: "Download task not found" });
      return;
    }
    const resetProgress = task.status === "cancelled" || task.errorCode === "checksum_mismatch";
    if (resetProgress && !(await removePartialFile(dataRoot, system, task))) {
      reply.status(409).send({ error: "Download partial file could not be removed" });
      return;
    }
    const retried = transitionDownloadTask(db, {
      id: task.id,
      from: ["failed", "cancelled"],
      to: "queued",
      error: null,
      resetProgress
    });
    if (!retried) {
      reply.status(409).send({ error: `Download task cannot be retried while ${task.status}` });
      return;
    }
    reply.send({ task: retried });
  });

  server.delete<{
    Params: { id: string };
  }>("/api/downloads/:id", async (request, reply) => {
    const originalTask = getDownloadTask(db, request.params.id);
    if (!originalTask) {
      reply.status(404).send({ error: "Download task not found" });
      return;
    }
    if (originalTask.status === "running") {
      reply.status(409).send({ error: "Running download tasks cannot be removed" });
      return;
    }
    let task = originalTask;
    if (task.status !== "completed" && task.status !== "cancelled") {
      const isolated = transitionDownloadTask(db, {
        id: task.id,
        from: ["queued", "paused", "failed"],
        to: "cancelled",
        error: null
      });
      if (!isolated) {
        const current = getDownloadTask(db, task.id);
        if (!current) {
          reply.status(404).send({ error: "Download task not found" });
          return;
        }
        if (current.status === "running") {
          reply.status(409).send({ error: "Running download tasks cannot be removed" });
          return;
        }
        if (current.status === "completed") {
          task = current;
        } else if (current.status === "cancelled") {
          task = current;
        } else {
          reply.status(409).send({ error: `Download task cannot be removed while ${current.status}` });
          return;
        }
      } else {
        task = isolated;
      }
    }
    if (task.status !== "completed" && !(await removePartialFile(dataRoot, system, task))) {
      reply.status(409).send({ error: "Download partial file could not be removed" });
      return;
    }
    if (!deleteDownloadTask(db, task.id)) {
      reply.status(409).send({ error: "Download task could not be removed" });
      return;
    }
    reply.status(204).send();
  });

  server.get("/api/downloads/events", async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    let lastSnapshot = "";
    const flush = () => {
      if (raw.destroyed) {
        return;
      }
      const snapshot = {
        tasks: listDownloadTasks(db, { limit: 500 }),
        health: getDownloadWorkerHealth(db)
      };
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSnapshot) {
        return;
      }
      lastSnapshot = serialized;
      raw.write(`event: snapshot\n`);
      raw.write(`data: ${serialized}\n\n`);
    };

    raw.write(": connected\n\n");
    flush();
    const timer = setInterval(flush, 1_000);
    request.raw.on("close", () => clearInterval(timer));
  });
}

async function createTorrentTaskFromPreview(
  db: CyberOsDatabase,
  dataRoot: string,
  system: ApiRouteContext["system"],
  body: {
    torrentPreviewId?: string;
    selectedFileIndices?: number[];
    storagePoolId?: string;
    targetDirectory?: string;
    fileName?: string;
    seedRatioLimit?: number;
    seedTimeLimitSeconds?: number;
  },
  reply: FastifyReply
): Promise<void> {
  const previewId = body.torrentPreviewId?.trim() ?? "";
  const targetDirectory = normalizeTargetDirectory(body.targetDirectory);
  const fileName = normalizeFileName(body.fileName);
  const selectedFileIndices = normalizeSelectedFileIndices(body.selectedFileIndices);
  const seedRatioLimit = normalizeSeedRatioLimit(body.seedRatioLimit);
  const seedTimeLimitSeconds = normalizeSeedTimeLimit(body.seedTimeLimitSeconds);
  if ("error" in targetDirectory) {
    reply.status(400).send({ error: targetDirectory.error });
    return;
  }
  if ("error" in fileName) {
    reply.status(400).send({ error: fileName.error });
    return;
  }
  if ("error" in selectedFileIndices) {
    reply.status(400).send({ error: selectedFileIndices.error });
    return;
  }
  if ("error" in seedRatioLimit) {
    reply.status(400).send({ error: seedRatioLimit.error });
    return;
  }
  if ("error" in seedTimeLimitSeconds) {
    reply.status(400).send({ error: seedTimeLimitSeconds.error });
    return;
  }
  if (!previewId) {
    reply.status(400).send({ error: "Torrent preview is required" });
    return;
  }

  let scope: StoragePoolScope;
  try {
    scope = await resolveStoragePoolScope(dataRoot, system, body.storagePoolId);
    const directory = await resolveScopedExistingPath(scope, targetDirectory.path);
    const directoryStat = await stat(directory.realPath);
    if (!directoryStat.isDirectory()) {
      reply.status(400).send({ error: "Download target directory must be a directory" });
      return;
    }
    await access(directory.realPath, fsConstants.W_OK | fsConstants.X_OK);
    const targetPath = path.join(directory.relativePath, fileName.name);
    const target = await resolveScopedTargetPath(scope, targetPath);
    if (await exists(target.absolutePath)) {
      reply.status(409).send({ error: "Download target already exists" });
      return;
    }
    const task = createTorrentDownloadTask(db, {
      previewId,
      selectedFileIndices: selectedFileIndices.value,
      storagePoolId: scope.pool.id,
      targetDirectory: directory.relativePath,
      targetFileName: fileName.name,
      targetPath,
      seedRatioLimit: seedRatioLimit.value,
      seedTimeLimitSeconds: seedTimeLimitSeconds.value
    });
    reply.status(201).send({ task });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      reply.status(409).send({ error: "Torrent or download target already has an active task" });
      return;
    }
    sendDownloadError(reply, error);
  }
}

async function transitionTaskStatus(
  db: CyberOsDatabase,
  dataRoot: string,
  system: ApiRouteContext["system"],
  id: string,
  input: { from: DownloadTaskStatus[]; to: DownloadTaskStatus },
  reply: FastifyReply
): Promise<void> {
  const task = getDownloadTask(db, id);
  if (!task) {
    reply.status(404).send({ error: "Download task not found" });
    return;
  }
  const updated = transitionDownloadTask(db, {
    id,
    from: input.from,
    to: input.to,
    error: null
  });
  if (!updated) {
    reply.status(409).send({ error: `Download task cannot transition from ${task.status} to ${input.to}` });
    return;
  }
  if (input.to === "cancelled") {
    await removePartialFile(dataRoot, system, updated);
  }
  reply.send({ task: updated });
}

async function removePartialFile(
  dataRoot: string,
  system: ApiRouteContext["system"],
  task: DownloadTaskRecord
): Promise<boolean> {
  if (!system) {
    return false;
  }
  try {
    const scope = await resolveStoragePoolScope(dataRoot, system, task.storagePoolId);
    const partial = await resolveScopedTargetPath(scope, task.partialPath);
    if (task.sourceKind !== "http") {
      const metadata = await lstat(partial.absolutePath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        return false;
      }
      await rm(partial.absolutePath, { recursive: true });
      return true;
    }
    await unlink(partial.absolutePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return true;
    }
    return false;
  }
}

function normalizeDownloadUrl(raw: string | undefined): { value: string } | { error: string } {
  const value = raw?.trim() ?? "";
  if (!value || value.length > MAX_URL_LENGTH) {
    return { error: "Download URL is required" };
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: "Only HTTP and HTTPS downloads are supported" };
    }
    if (url.username || url.password) {
      return { error: "Download URLs with credentials are not supported" };
    }
    return { value: url.toString() };
  } catch {
    return { error: "Download URL is invalid" };
  }
}

function normalizeMagnet(raw: string | undefined): { value: string } | { error: string } {
  const value = raw?.trim() ?? "";
  if (!value || value.length > MAX_URL_LENGTH) {
    return { error: "Magnet link is required" };
  }
  try {
    const magnet = new URL(value);
    if (magnet.protocol !== "magnet:") {
      return { error: "Magnet link is invalid" };
    }
    const exactTopics = magnet.searchParams.getAll("xt");
    const supported = exactTopics.some((topic) =>
      /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/iu.test(topic)
      || /^urn:btmh:1220[a-f0-9]{64}$/iu.test(topic)
    );
    if (!supported) {
      return { error: "Magnet link must contain a supported BitTorrent info hash" };
    }
    return { value };
  } catch {
    return { error: "Magnet link is invalid" };
  }
}

function normalizeSelectedFileIndices(raw: number[] | undefined): { value: number[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TORRENT_FILE_COUNT) {
    return { error: "Select at least one torrent file" };
  }
  if (raw.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return { error: "Torrent file selection is invalid" };
  }
  return { value: [...new Set(raw)].sort((a, b) => a - b) };
}

function normalizeSeedRatioLimit(raw: number | undefined): { value: number } | { error: string } {
  if (raw !== undefined && raw !== 1) {
    return { error: "Seed ratio limit is fixed at 1.0" };
  }
  return { value: 1 };
}

function normalizeSeedTimeLimit(raw: number | undefined): { value: number } | { error: string } {
  if (raw !== undefined && raw !== 7_200) {
    return { error: "Seed time limit is fixed at 7200 seconds" };
  }
  return { value: 7_200 };
}

function normalizeTargetDirectory(raw: string | undefined): { path: string } | { error: string } {
  const value = raw?.trim() ?? "";
  if (!value || value.length > MAX_TARGET_DIRECTORY_LENGTH) {
    return { error: "Download target directory is required" };
  }
  return { path: value };
}

function normalizeFileName(raw: string | undefined): { name: string } | { error: string } {
  const name = raw?.trim() ?? "";
  if (!name || name.length > MAX_FILE_NAME_LENGTH || Buffer.byteLength(name, "utf8") > MAX_FILE_NAME_LENGTH) {
    return { error: "Download file name is required" };
  }
  if (name === "." || name === ".." || name.includes("\0") || name.includes("/") || name.includes("\\")) {
    return { error: "Download file name must be a single file name" };
  }
  return { name };
}

function normalizeSha256(raw: string | undefined): { value: string | null } | { error: string } {
  const value = raw?.trim().toLowerCase() ?? "";
  if (!value) {
    return { value: null };
  }
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    return { error: "SHA-256 must be exactly 64 hexadecimal characters" };
  }
  return { value };
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "SQLITE_CONSTRAINT_UNIQUE";
}

function sendDownloadError(reply: FastifyReply, error: unknown): void {
  if (error instanceof StorageScopeError) {
    reply.status(error.statusCode).send({ error: error.message });
    return;
  }
  if (isPermissionError(error)) {
    reply.status(403).send({ error: "Download target is not accessible" });
    return;
  }
  if (isMissingPathError(error)) {
    reply.status(404).send({ error: "Download target path not found" });
    return;
  }
  reply.status(400).send({ error: error instanceof Error ? error.message : String(error) });
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}
