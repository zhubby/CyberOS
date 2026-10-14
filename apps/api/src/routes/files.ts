import { createWriteStream } from "node:fs";
import { lstat, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import {
  inferMimeType,
  inferPreviewKind,
  applyFileMutation,
  archiveKindForPath,
  defaultExtractionTarget,
  isPathInside,
  listDir,
  readText,
  resolveSafeExistingPath,
  resolveSafeTargetPath,
  searchFiles,
  type FileEntry
} from "@sigmaos/nas-tools";
import {
  appendEvent,
  createActionMessageAndJob,
  createFileBatch,
  createPendingApproval,
  FileBatchConflictError,
  getSession,
  listFileBatches,
  queryIndexAdvanced,
  recordAppliedOperation
} from "@sigmaos/db";
import type { FileOperationProposal, IndexSearchRequest, NasRootRecord } from "@sigmaos/shared";
import type { ApiRouteContext } from "../context.js";
import {
  clampPreviewBytes,
  getFilePreviewMeta,
  indexMatchToFileEntry,
  sendFileStream,
  safeQueryIndex
} from "../lib/files.js";
import { getDirectoryGitView } from "../lib/git.js";
import {
  resolveScopedExistingPath,
  resolveScopedTargetPath,
  resolveStoragePoolScope,
  type StoragePoolScope
} from "../lib/storage-scope.js";
import { VideoCache } from "../lib/video-cache.js";

const MAX_EDIT_TEXT_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ADVANCED_SEARCH_SCOPE_PAGES = 20;

export function registerFileRoutes(server: FastifyInstance, { config, db, system, videoTranscoder, fileBatches }: ApiRouteContext): void {
  const videoCache = videoTranscoder
    ? new VideoCache({ dataDir: config.dataDir, transcoder: videoTranscoder })
    : new VideoCache({ dataDir: config.dataDir });
  server.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  server.get<{
    Querystring: { rootId?: string; storagePoolId?: string; path?: string };
  }>("/api/files", async (request, reply) => {
    const scope = await resolveStoragePoolScope(db, system, request.query.rootId, request.query.storagePoolId);
    const root = scope.root;
    const safe = await resolveScopedExistingPath(scope, request.query.path ?? scope.mountpointPath);
    const entries = await listDir(root, safe.relativePath);
    const scopedEntries = await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isSafe) {
          return entry;
        }
        try {
          await resolveScopedExistingPath(scope, entry.path);
          return entry;
        } catch {
          return { ...entry, isSafe: false };
        }
      })
    );
    const gitView = await getDirectoryGitView(root.path, safe.relativePath, scopedEntries, scope.mountpointRealPath);
    reply.send({
      root,
      path: safe.relativePath,
      entries: gitView.entries,
      git: gitView.git
    });
  });

  server.get<{
    Querystring: { rootId?: string; storagePoolId?: string; path?: string };
  }>("/api/files/meta", async (request, reply) => {
    const scope = await resolveStoragePoolScope(db, system, request.query.rootId, request.query.storagePoolId);
    const root = scope.root;
    const safe = await resolveScopedExistingPath(scope, request.query.path ?? scope.mountpointPath);
    const meta = await getFilePreviewMeta(root.path, safe.relativePath);
    reply.send({
      root,
      meta
    });
  });

  server.get<{
    Querystring: { rootId?: string; storagePoolId?: string; path?: string; maxBytes?: string };
  }>("/api/files/text", async (request, reply) => {
    const scope = await resolveStoragePoolScope(db, system, request.query.rootId, request.query.storagePoolId);
    const root = scope.root;
    const safe = await resolveScopedExistingPath(scope, request.query.path ?? scope.mountpointPath);
    const meta = await getFilePreviewMeta(root.path, safe.relativePath);
    if (meta.previewKind !== "text") {
      reply.status(415).send({ error: "File is not text-previewable" });
      return;
    }

    const maxBytes = clampPreviewBytes(request.query.maxBytes);
    const preview = await readText(root, safe.relativePath, maxBytes);
    reply.send({
      ...preview,
      maxBytes
    });
  });

  server.get<{
    Querystring: { rootId?: string; storagePoolId?: string; path?: string };
  }>("/api/files/edit-text", async (request, reply) => {
    const scope = await resolveStoragePoolScope(db, system, request.query.rootId, request.query.storagePoolId);
    const root = scope.root;
    const target = await getEditableTextTarget(root, scope, request.query.path ?? scope.mountpointPath);
    if ("error" in target) {
      reply.status(target.statusCode).send({ error: target.error });
      return;
    }

    const preview = await readText(root, target.meta.path, MAX_EDIT_TEXT_BYTES);
    reply.send({
      ...preview,
      modifiedAt: target.meta.modifiedAt,
      sizeBytes: target.meta.sizeBytes,
      maxBytes: MAX_EDIT_TEXT_BYTES
    });
  });

  server.put<{
    Body: {
      rootId?: string;
      storagePoolId?: string;
      path?: string;
      content?: string;
      expectedModifiedAt?: string | null;
    };
  }>("/api/files/edit-text", async (request, reply) => {
    const scope = await resolveStoragePoolScope(db, system, request.body?.rootId, request.body?.storagePoolId);
    const root = scope.root;

    const content = request.body?.content;
    if (typeof content !== "string") {
      reply.status(400).send({ error: "Content is required" });
      return;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_EDIT_TEXT_BYTES) {
      reply.status(413).send({ error: "Edited content is too large" });
      return;
    }

    const target = await getEditableTextTarget(root, scope, request.body?.path ?? scope.mountpointPath);
    if ("error" in target) {
      reply.status(target.statusCode).send({ error: target.error });
      return;
    }

    const expectedModifiedAt = request.body?.expectedModifiedAt;
    if (expectedModifiedAt && expectedModifiedAt !== target.meta.modifiedAt) {
      reply.status(409).send({
        error: "File changed since the editor loaded",
        modifiedAt: target.meta.modifiedAt
      });
      return;
    }

    await writeFile(target.safe.realPath, content, "utf8");
    const meta = await getFilePreviewMeta(root.path, target.meta.path);
    const preview = await readText(root, meta.path, MAX_EDIT_TEXT_BYTES);
    const operation = recordAppliedOperation(db, {
      approvalId: null,
      operation: "edit",
      sourcePath: meta.path,
      status: "applied",
      metadata: {
        rootId: root.id,
        storagePoolId: scope.pool.id,
        reversible: false,
        realtimeSave: true,
        sizeBytes: meta.sizeBytes
      }
    });

    reply.send({
      meta,
      textPreview: {
        ...preview,
        maxBytes: MAX_EDIT_TEXT_BYTES
      },
      operation
    });
  });

  server.put<{
    Querystring: { rootId?: string; storagePoolId?: string; path?: string };
  }>(
    "/api/files/upload",
    {
      bodyLimit: MAX_UPLOAD_BYTES
    },
    async (request, reply) => {
      const scope = await resolveStoragePoolScope(db, system, request.query.rootId, request.query.storagePoolId);
      const root = scope.root;
      const requestedPath = request.query.path ?? scope.mountpointPath;
      const target = await prepareUploadTarget(scope, requestedPath);
      if (target.exists) {
        reply.status(409).send({ error: "Upload target already exists" });
        return;
      }

      await ensureUploadParents(target.safe.rootRealPath, path.dirname(target.safe.absolutePath));

      const output = createWriteStream(target.safe.absolutePath, { flags: "wx" });
      let ownsTarget = false;
      output.once("open", () => {
        ownsTarget = true;
      });
      try {
        await pipeline(
          request.body as NodeJS.ReadableStream,
          createUploadLimitStream(MAX_UPLOAD_BYTES),
          output
        );
      } catch (error) {
        const bodyStream = request.body as NodeJS.ReadableStream & { destroy?: () => void };
        if (typeof bodyStream.destroy === "function") {
          bodyStream.destroy();
        }
        if (ownsTarget) {
          await unlinkIfExists(target.safe.absolutePath);
        }
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          reply.status(409).send({ error: "Upload target already exists" });
          return;
        }
        throw error;
      }

      const meta = await getFilePreviewMeta(root.path, target.safe.relativePath);
      const operation = recordAppliedOperation(db, {
        approvalId: null,
        operation: "upload",
        sourcePath: null,
        targetPath: meta.path,
        status: "applied",
        metadata: {
          rootId: root.id,
          storagePoolId: scope.pool.id,
          reversible: true,
          sizeBytes: meta.sizeBytes,
          mimeType: meta.mimeType,
          previewKind: meta.previewKind
        }
      });

      reply.status(201).send({
        meta,
        operation
      });
    }
  );

  server.post<{
    Body: {
      sessionId?: string;
      rootId?: string;
      storagePoolId?: string;
      operation?: "mkdir" | "rename" | "trash" | "move" | "copy";
      sourcePath?: string;
      targetName?: string;
      targetPath?: string;
    };
  }>("/api/files/proposals", async (request, reply) => {
    const session = getSession(db, request.body?.sessionId ?? "");
    if (!session) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }

    const scope = await resolveStoragePoolScope(db, system, request.body?.rootId, request.body?.storagePoolId);
    const root = scope.root;
    if (session.rootId !== root.id) {
      reply.status(400).send({ error: "Session root does not match proposal root" });
      return;
    }

    const operation = request.body?.operation;
    if (
      operation !== "mkdir" &&
      operation !== "rename" &&
      operation !== "trash" &&
      operation !== "move" &&
      operation !== "copy"
    ) {
      reply.status(400).send({ error: "Unsupported file proposal operation" });
      return;
    }

    let proposal:
      | {
          proposal: FileOperationProposal;
        }
      | { statusCode: number; error: string };
    if (operation === "mkdir") {
      proposal = await buildMkdirProposal(root, scope, request.body?.targetPath);
    } else {
      const source = await getMutableSource(root, scope, request.body?.sourcePath ?? scope.mountpointPath);
      if ("error" in source) {
        reply.status(source.statusCode).send({ error: source.error });
        return;
      }

      proposal =
        operation === "rename"
          ? await buildRenameProposal(root, scope, source.safe.relativePath, request.body?.targetName)
          : operation === "trash"
            ? buildTrashProposal(root, source.safe.relativePath)
            : await buildTransferProposal(root, scope, source.safe, operation, request.body?.targetPath);
    }
    if ("error" in proposal) {
      reply.status(proposal.statusCode).send({ error: proposal.error });
      return;
    }
    proposal.proposal.storagePoolId = scope.pool.id;

    const summary = proposal.proposal.summary;
    const { message, job } = createActionMessageAndJob(db, {
      sessionId: session.id,
      content: summary,
      kind: "file",
      status: "waiting_approval"
    });
    const approval = createPendingApproval(db, {
      jobId: job.id,
      proposal: [proposal.proposal]
    });
    appendEvent(db, {
      sessionId: session.id,
      jobId: job.id,
      type: "approval.pending",
      payload: {
        approvalId: approval.id,
        proposal: approval.proposal,
        summary: `Created approval ${approval.id}: ${summary}. No files were changed.`
      }
    });

    reply.status(202).send({
      message,
      job,
      approval
    });
  });

  server.get<{
    Querystring: { sessionId?: string; rootId?: string; storagePoolId?: string; limit?: string };
  }>("/api/files/batches", async (request, reply) => {
    const rawLimit = request.query.limit === undefined ? 50 : Number.parseInt(request.query.limit, 10);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      reply.status(400).send({ error: "File batch limit must be between 1 and 100" });
      return;
    }
    reply.send({
      batches: listFileBatches(db, {
        ...(request.query.sessionId ? { sessionId: request.query.sessionId } : {}),
        ...(request.query.rootId ? { rootId: request.query.rootId } : {}),
        ...(request.query.storagePoolId ? { storagePoolId: request.query.storagePoolId } : {}),
        limit: rawLimit
      })
    });
  });

  server.post<{
    Body: {
      sessionId?: string;
      rootId?: string;
      storagePoolId?: string;
      operation?: "move" | "trash";
      sourcePaths?: string[];
      targetDirectory?: string;
    };
  }>("/api/files/batches", { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const session = getSession(db, request.body?.sessionId ?? "");
    if (!session) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }
    const operation = request.body?.operation;
    if (operation !== "move" && operation !== "trash") {
      reply.status(400).send({ error: "Unsupported file batch operation" });
      return;
    }
    const sourcePaths = request.body?.sourcePaths;
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || sourcePaths.some((item) => typeof item !== "string" || !item.trim())) {
      reply.status(400).send({ error: "At least one source path is required" });
      return;
    }
    const normalizedSources = sourcePaths.map((item) => item.trim());
    if (new Set(normalizedSources).size !== normalizedSources.length) {
      reply.status(400).send({ error: "Source paths must be unique" });
      return;
    }

    const scope = await resolveStoragePoolScope(db, system, request.body?.rootId, request.body?.storagePoolId);
    if (session.rootId !== scope.root.id) {
      reply.status(400).send({ error: "Session root does not match batch root" });
      return;
    }

    let targetDirectory: string | null = null;
    if (operation === "move") {
      const target = await resolveScopedExistingPath(scope, request.body?.targetDirectory ?? "");
      const targetStat = await stat(target.realPath);
      if (!targetStat.isDirectory()) {
        reply.status(400).send({ error: "Move target must be a directory" });
        return;
      }
      targetDirectory = target.relativePath;
    }

    const items: Array<{ sourcePath: string; targetPath?: string }> = [];
    const targetPaths = new Set<string>();
    for (const requestedSource of normalizedSources) {
      const source = await getMutableSource(scope.root, scope, requestedSource);
      if ("error" in source) {
        reply.status(source.statusCode).send({ error: source.error, sourcePath: requestedSource });
        return;
      }
      if (operation === "trash") {
        items.push({ sourcePath: source.safe.relativePath });
        continue;
      }
      const requestedTarget = path.join(targetDirectory!, path.basename(source.safe.relativePath));
      const proposal = await buildTransferProposal(scope.root, scope, source.safe, "move", requestedTarget);
      if ("error" in proposal) {
        reply.status(proposal.statusCode).send({ error: proposal.error, sourcePath: requestedSource });
        return;
      }
      const targetPath = proposal.proposal.targetPath!;
      if (targetPaths.has(targetPath)) {
        reply.status(409).send({ error: "Multiple selected files resolve to the same target", targetPath });
        return;
      }
      targetPaths.add(targetPath);
      items.push({ sourcePath: source.safe.relativePath, targetPath });
    }

    try {
      const batch = createFileBatch(db, {
        sessionId: session.id,
        rootId: scope.root.id,
        storagePoolId: scope.pool.id,
        operation,
        targetDirectory,
        summary: operation === "move"
          ? `Move ${items.length} item${items.length === 1 ? "" : "s"} to ${targetDirectory}`
          : `Move ${items.length} item${items.length === 1 ? "" : "s"} to SigmaOS trash`,
        items
      });
      fileBatches?.wake();
      reply.status(202).send({ batch });
    } catch (error) {
      if (error instanceof FileBatchConflictError) {
        reply.status(409).send({ error: error.message, sourcePaths: error.sourcePaths });
        return;
      }
      throw error;
    }
  });

  server.post<{
    Body: {
      rootId?: string;
      storagePoolId?: string;
      path?: string;
    };
  }>("/api/files/extract", async (request, reply) => {
    const scope = await resolveStoragePoolScope(db, system, request.body?.rootId, request.body?.storagePoolId);
    const root = scope.root;
    const source = await resolveScopedExistingPath(scope, request.body?.path ?? scope.mountpointPath);
    const proposal = await buildExtractProposal(root, scope, source);
    if ("error" in proposal) {
      reply.status(proposal.statusCode).send({ error: proposal.error });
      return;
    }

    try {
      const result = await applyFileMutation(root, proposal.proposal, path.join(config.dataDir, "trash"));
      const operation = recordAppliedOperation(db, {
        approvalId: null,
        operation: result.proposal.operation,
        sourcePath: result.sourcePath,
        targetPath: result.targetPath,
        status: "applied",
        metadata: {
          ...result.metadata,
          rootId: root.id,
          storagePoolId: scope.pool.id,
          reversible: proposal.proposal.reversible
        }
      });

      reply.status(201).send({
        operation,
        targetPath: result.targetPath
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.status(400).send({ error: message });
    }
  });

  server.get<{
    Querystring: { rootId?: string; storagePoolId?: string; path?: string; download?: string };
  }>("/api/files/blob", async (request, reply) => {
    const scope = await resolveStoragePoolScope(db, system, request.query.rootId, request.query.storagePoolId);
    const safe = await resolveScopedExistingPath(scope, request.query.path ?? scope.mountpointPath);
    const safeStat = await stat(safe.realPath);
    if (!safeStat.isFile()) {
      reply.status(400).send({ error: "Path is not a file" });
      return;
    }

    if (request.query.download === "1") {
      reply.header("Content-Disposition", contentDisposition(path.basename(safe.relativePath)));
    }

    return sendFileStream(reply, request.headers.range, safe.realPath, inferMimeType(safe.realPath));
  });

  server.get<{
    Querystring: { rootId?: string; storagePoolId?: string; path?: string };
  }>("/api/files/video", async (request, reply) => {
    const scope = await resolveStoragePoolScope(db, system, request.query.rootId, request.query.storagePoolId);
    const root = scope.root;
    const safe = await resolveScopedExistingPath(scope, request.query.path ?? scope.mountpointPath);
    const sourceStat = await stat(safe.realPath);
    if (!sourceStat.isFile()) {
      reply.status(400).send({ error: "Path is not a file" });
      return;
    }

    const mimeType = inferMimeType(safe.realPath);
    if (inferPreviewKind(mimeType) !== "video") {
      reply.status(415).send({ error: "File is not video-previewable" });
      return;
    }

    const extension = path.extname(safe.realPath).toLocaleLowerCase();
    if (extension === ".mp4" || extension === ".webm") {
      return sendFileStream(reply, request.headers.range, safe.realPath, mimeType);
    }

    const source = {
      rootId: root.id,
      relativePath: safe.relativePath,
      realPath: safe.realPath,
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
      if (reply.statusCode === 416) {
        release();
      }
      return result;
    } catch (error) {
      release();
      throw error;
    }
  });

  server.get<{
    Querystring: { q?: string; rootId?: string; storagePoolId?: string; path?: string };
  }>("/api/search", async (request, reply) => {
    const scope = await resolveStoragePoolScope(db, system, request.query.rootId, request.query.storagePoolId);
    const root = scope.root;

    const query = request.query.q?.trim();
    if (!query) {
      reply.status(400).send({ error: "Search query is required" });
      return;
    }

    const searchPath = request.query.path ?? scope.mountpointPath;
    const safeSearchPath = await resolveScopedExistingPath(scope, searchPath);
    const searchStat = await stat(safeSearchPath.realPath);
    if (!searchStat.isDirectory()) {
      reply.status(400).send({ error: "Search path must be a directory" });
      return;
    }

    const indexed = safeQueryIndex(db, root.id, query, safeSearchPath.relativePath);
    const scopedIndexed = [];
    for (const match of indexed) {
      try {
        await resolveScopedTargetPath(scope, match.path);
        try {
          await resolveScopedExistingPath(scope, match.path);
        } catch (error) {
          if (!isMissingPathError(error)) {
            throw error;
          }
        }
        scopedIndexed.push(match);
      } catch {
        // Stale or malicious index rows must not widen the selected pool scope.
      }
    }
    const files = scopedIndexed.length
      ? scopedIndexed.map(indexMatchToFileEntry)
      : await filterScopedSearchResults(
          scope,
          await searchFiles(root, {
            query,
            path: safeSearchPath.relativePath,
            limit: 50
          })
        );
    const gitView = await getDirectoryGitView(root.path, safeSearchPath.relativePath, files, scope.mountpointRealPath);

    reply.send({
      root,
      query,
      indexed: scopedIndexed,
      files: gitView.entries,
      git: gitView.git
    });
  });

  server.post<{ Body: Partial<IndexSearchRequest> }>("/api/search", async (request, reply) => {
    try {
      const scope = await resolveStoragePoolScope(db, system, request.body?.rootId, request.body?.storagePoolId);
      const searchPath = request.body?.path ?? scope.mountpointPath;
      const safeSearchPath = await resolveScopedExistingPath(scope, searchPath);
      const searchStat = await stat(safeSearchPath.realPath);
      if (!searchStat.isDirectory()) {
        reply.status(400).send({ error: "Search path must be a directory" });
        return;
      }
      const requestedLimit = request.body?.limit ?? 50;
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
        throw new Error("Search limit must be an integer between 1 and 100");
      }
      const files = [];
      let cursor = request.body?.cursor ?? null;
      let nextCursor: string | null = cursor;
      for (let pageNumber = 0; pageNumber < MAX_ADVANCED_SEARCH_SCOPE_PAGES && files.length < requestedLimit; pageNumber += 1) {
        const page = queryIndexAdvanced(db, {
          ...request.body,
          rootId: scope.root.id,
          storagePoolId: scope.pool.id,
          path: safeSearchPath.relativePath,
          limit: requestedLimit - files.length,
          cursor
        });
        for (const file of page.files) {
          try {
            await resolveScopedTargetPath(scope, file.path);
            try {
              await resolveScopedExistingPath(scope, file.path);
            } catch (error) {
              if (!isMissingPathError(error)) throw error;
            }
            files.push(file);
          } catch {
            // Never let stale or malicious index rows escape the selected storage pool.
          }
        }
        nextCursor = page.nextCursor;
        if (!nextCursor) {
          break;
        }
        cursor = nextCursor;
      }
      reply.send({ files, nextCursor });
    } catch (error) {
      reply.status(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/gu, "_").replace(/["\\]/gu, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

async function filterScopedSearchResults(scope: StoragePoolScope, matches: FileEntry[]): Promise<FileEntry[]> {
  const scoped: FileEntry[] = [];
  for (const match of matches) {
    if (!match.isSafe) {
      scoped.push(match);
      continue;
    }
    try {
      await resolveScopedExistingPath(scope, match.path);
      scoped.push(match);
    } catch {
      // Do not expose results that cross a nested pool or other scope boundary.
    }
  }
  return scoped;
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function buildExtractProposal(
  root: NasRootRecord,
  scope: StoragePoolScope,
  source: Awaited<ReturnType<typeof resolveSafeExistingPath>>
): Promise<
  | { proposal: FileOperationProposal }
  | { statusCode: number; error: string }
> {
  const kind = archiveKindForPath(source.relativePath);
  if (!kind) {
    return { statusCode: 400, error: "File is not a supported archive" };
  }
  const sourceLinkStat = await lstat(source.absolutePath);
  if (sourceLinkStat.isSymbolicLink()) {
    return { statusCode: 400, error: "Refusing to extract through a symlink" };
  }
  const sourceStat = await stat(source.realPath);
  if (!sourceStat.isFile()) {
    return { statusCode: 400, error: "Archive source must be a file" };
  }

  const targetPath = defaultExtractionTarget(source.relativePath, kind);
  if (!targetPath) {
    return { statusCode: 400, error: "Unable to determine extraction target" };
  }
  const target = await resolveScopedTargetPath(scope, targetPath);
  if (target.relativePath === ".") {
    return { statusCode: 400, error: "Extraction target must be inside the selected storage pool" };
  }
  if (await pathExistsNoSymlink(target.absolutePath)) {
    return { statusCode: 409, error: "Extraction target already exists" };
  }
  const destination = await resolveScopedExistingPath(scope, path.dirname(target.relativePath));
  const destinationLinkStat = await lstat(destination.absolutePath);
  if (destinationLinkStat.isSymbolicLink()) {
    return { statusCode: 400, error: "Refusing to extract into a symlinked folder" };
  }
  const destinationStat = await stat(destination.realPath);
  if (!destinationStat.isDirectory()) {
    return { statusCode: 400, error: "Extraction destination must be a folder" };
  }

  return {
    proposal: {
      operation: "extract",
      rootId: root.id,
      sourcePath: source.relativePath,
      targetPath: target.relativePath,
      risk: "medium",
      reversible: true,
      summary: `Extract ${source.relativePath} to ${target.relativePath}`
    }
  };
}

function createUploadLimitStream(maxBytes: number): Transform {
  let receivedBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        callback(new Error("Upload is too large"));
        return;
      }
      callback(null, chunk);
    }
  });
}

async function getEditableTextTarget(
  root: NasRootRecord,
  scope: StoragePoolScope,
  requestedPath: string
): Promise<
  | {
      safe: Awaited<ReturnType<typeof resolveSafeExistingPath>>;
      meta: Awaited<ReturnType<typeof getFilePreviewMeta>>;
    }
  | { statusCode: number; error: string }
> {
  const safe = await resolveScopedExistingPath(scope, requestedPath);
  const linkStat = await lstat(safe.absolutePath);
  if (linkStat.isSymbolicLink()) {
    return { statusCode: 400, error: "Refusing to edit through a symlink" };
  }

  const meta = await getFilePreviewMeta(root.path, safe.relativePath);
  if (meta.kind !== "file") {
    return { statusCode: 400, error: "Edit target must be a file" };
  }
  if (meta.previewKind !== "text" || inferPreviewKind(inferMimeType(safe.realPath)) !== "text") {
    return { statusCode: 415, error: "File is not text-editable" };
  }
  if (meta.sizeBytes > MAX_EDIT_TEXT_BYTES) {
    return { statusCode: 413, error: "File is too large to edit inline" };
  }

  return { safe, meta };
}

async function getMutableSource(
  root: NasRootRecord,
  scope: StoragePoolScope,
  requestedPath: string
): Promise<
  | {
      safe: Awaited<ReturnType<typeof resolveSafeExistingPath>>;
    }
  | { statusCode: number; error: string }
> {
  const safe = await resolveScopedExistingPath(scope, requestedPath);
  if (safe.relativePath === "." || safe.relativePath === scope.mountpointPath) {
    return { statusCode: 400, error: "Cannot mutate the storage pool root" };
  }
  const linkStat = await lstat(safe.absolutePath);
  if (linkStat.isSymbolicLink()) {
    return { statusCode: 400, error: "Refusing to mutate through a symlink" };
  }

  return { safe };
}

async function buildMkdirProposal(
  root: NasRootRecord,
  scope: StoragePoolScope,
  rawTargetPath: string | undefined
): Promise<
  | {
      proposal: FileOperationProposal;
    }
  | { statusCode: number; error: string }
> {
  const normalizedTarget = normalizeMkdirTargetPath(rawTargetPath);
  if ("error" in normalizedTarget) {
    return normalizedTarget;
  }

  const target = await resolveScopedTargetPath(scope, normalizedTarget.path);
  if (target.relativePath === "." || target.relativePath === scope.mountpointPath) {
    return { statusCode: 400, error: "New folder must be inside the selected storage pool" };
  }
  if (await pathExistsNoSymlink(target.absolutePath)) {
    return { statusCode: 409, error: "Mutation target already exists" };
  }

  const destination = await resolveScopedExistingPath(scope, path.dirname(target.relativePath));
  const destinationLinkStat = await lstat(destination.absolutePath);
  if (destinationLinkStat.isSymbolicLink()) {
    return { statusCode: 400, error: "Refusing to create a folder inside a symlinked folder" };
  }
  const destinationStat = await stat(destination.realPath);
  if (!destinationStat.isDirectory()) {
    return { statusCode: 400, error: "New folder destination must be a folder" };
  }

  return {
    proposal: {
      operation: "mkdir",
      rootId: root.id,
      targetPath: target.relativePath,
      risk: "low",
      reversible: true,
      summary: `Create folder ${target.relativePath}`
    }
  };
}

async function buildRenameProposal(
  root: NasRootRecord,
  scope: StoragePoolScope,
  sourcePath: string,
  rawTargetName: string | undefined
): Promise<
  | {
      proposal: FileOperationProposal;
    }
  | { statusCode: number; error: string }
> {
  const targetName = normalizeTargetName(rawTargetName);
  if ("error" in targetName) {
    return targetName;
  }

  const sourceName = path.basename(sourcePath);
  if (targetName.name === sourceName) {
    return { statusCode: 400, error: "New name must be different" };
  }

  const parentPath = path.dirname(sourcePath);
  const targetPath = parentPath === "." ? targetName.name : path.join(parentPath, targetName.name);
  const target = await resolveScopedTargetPath(scope, targetPath);
  const targetExists = await pathExists(target.absolutePath);
  if (targetExists) {
    return { statusCode: 409, error: "Mutation target already exists" };
  }

  return {
    proposal: {
      operation: "rename",
      rootId: root.id,
      sourcePath,
      targetPath: target.relativePath,
      risk: "medium",
      reversible: true,
      summary: `Rename ${sourcePath} to ${target.relativePath}`
    }
  };
}

async function buildTransferProposal(
  root: NasRootRecord,
  scope: StoragePoolScope,
  source: Awaited<ReturnType<typeof resolveSafeExistingPath>>,
  operation: "move" | "copy",
  rawTargetPath: string | undefined
): Promise<
  | {
      proposal: FileOperationProposal;
    }
  | { statusCode: number; error: string }
> {
  const normalizedTarget = normalizeTransferTargetPath(rawTargetPath);
  if ("error" in normalizedTarget) {
    return normalizedTarget;
  }

  const target = await resolveScopedTargetPath(scope, normalizedTarget.path);
  if (target.relativePath === source.relativePath) {
    return { statusCode: 400, error: "Transfer target must be different from the source" };
  }
  if (await pathExists(target.absolutePath)) {
    return { statusCode: 409, error: "Mutation target already exists" };
  }

  const destination = await resolveScopedExistingPath(scope, path.dirname(target.relativePath));
  const destinationLinkStat = await lstat(destination.absolutePath);
  if (destinationLinkStat.isSymbolicLink()) {
    return { statusCode: 400, error: "Refusing to transfer into a symlinked folder" };
  }
  const destinationStat = await stat(destination.realPath);
  if (!destinationStat.isDirectory()) {
    return { statusCode: 400, error: "Transfer destination must be a folder" };
  }
  const sourceStat = await stat(source.realPath);
  if (sourceStat.isDirectory() && isPathInside(source.realPath, destination.realPath)) {
    return { statusCode: 400, error: "Cannot transfer a folder into itself" };
  }

  const verb = operation === "move" ? "Move" : "Copy";
  return {
    proposal: {
      operation,
      rootId: root.id,
      sourcePath: source.relativePath,
      targetPath: target.relativePath,
      risk: "medium",
      reversible: true,
      summary: `${verb} ${source.relativePath} to ${target.relativePath}`
    }
  };
}

function buildTrashProposal(
  root: NasRootRecord,
  sourcePath: string
): {
  proposal: FileOperationProposal;
} {
  return {
    proposal: {
      operation: "trash",
      rootId: root.id,
      sourcePath,
      risk: "medium",
      reversible: true,
      summary: `Move ${sourcePath} to SigmaOS trash`
    }
  };
}

function normalizeMkdirTargetPath(rawTargetPath: string | undefined): { path: string } | { statusCode: number; error: string } {
  const targetPath = rawTargetPath?.trim() ?? "";
  if (!targetPath) {
    return { statusCode: 400, error: "New folder path is required" };
  }
  if (targetPath.includes("\0") || path.isAbsolute(targetPath)) {
    return { statusCode: 400, error: "New folder path must be relative inside the NAS root" };
  }
  return { path: targetPath };
}

function normalizeTargetName(rawTargetName: string | undefined): { name: string } | { statusCode: number; error: string } {
  const name = rawTargetName?.trim() ?? "";
  if (!name) {
    return { statusCode: 400, error: "New name is required" };
  }
  if (name === "." || name === ".." || path.isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    return { statusCode: 400, error: "New name must stay in the same folder" };
  }
  return { name };
}

function normalizeTransferTargetPath(
  rawTargetPath: string | undefined
): { path: string } | { statusCode: number; error: string } {
  const targetPath = rawTargetPath?.trim() ?? "";
  if (!targetPath) {
    return { statusCode: 400, error: "Transfer target is required" };
  }
  if (targetPath.includes("\0") || path.isAbsolute(targetPath)) {
    return { statusCode: 400, error: "Transfer target must be a relative path inside the NAS root" };
  }
  return { path: targetPath };
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function prepareUploadTarget(scope: StoragePoolScope, requestedPath: string): Promise<{
  safe: Awaited<ReturnType<typeof resolveSafeTargetPath>>;
  exists: boolean;
}> {
  const safe = await resolveScopedTargetPath(scope, requestedPath);
  const exists = await pathExistsNoSymlink(safe.absolutePath);
  return { safe, exists };
}

async function ensureUploadParents(rootRealPath: string, absoluteDirPath: string): Promise<void> {
  const relativePath = path.relative(rootRealPath, absoluteDirPath);
  if (!relativePath || relativePath === ".") {
    return;
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  let currentPath = rootRealPath;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    try {
      const entry = await lstat(currentPath);
      if (entry.isSymbolicLink()) {
        throw new Error("Refusing to upload through a symlink");
      }
      if (!entry.isDirectory()) {
        throw new Error("Upload target parent is not a directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      try {
        await mkdir(currentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      const created = await lstat(currentPath);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("Upload target parent is not a directory");
      }
    }
  }
}

async function pathExistsNoSymlink(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function unlinkIfExists(absolutePath: string): Promise<void> {
  try {
    await unlink(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
