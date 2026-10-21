import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyReply } from "fastify";
import { queryIndexedText, type ZosDatabase } from "@zos/db";
import {
  inferMimeType,
  inferPreviewKind,
  resolveSafeExistingPath,
  type FileEntry
} from "@zos/nas-tools";

export async function getFilePreviewMeta(rootPath: string, requestedPath: string) {
  const safe = await resolveSafeExistingPath(rootPath, requestedPath);
  const safeStat = await stat(safe.realPath);
  const kind = safeStat.isDirectory()
    ? "directory"
    : safeStat.isFile()
      ? "file"
      : safeStat.isSymbolicLink()
        ? "symlink"
        : "other";
  const mimeType = kind === "directory" ? "inode/directory" : inferMimeType(safe.realPath);
  const previewKind = kind === "directory" ? "directory" : inferPreviewKind(mimeType);

  return {
    path: safe.relativePath,
    name: path.basename(safe.relativePath),
    kind,
    mimeType,
    previewKind,
    sizeBytes: safeStat.size,
    modifiedAt: safeStat.mtime.toISOString()
  };
}

export function clampPreviewBytes(raw: string | undefined): number {
  const parsed = Number(raw ?? 64 * 1024);
  if (!Number.isFinite(parsed)) {
    return 64 * 1024;
  }
  return Math.min(Math.max(0, Math.floor(parsed)), 128 * 1024);
}

export function parseRangeHeader(
  headerValue: string | string[] | undefined,
  size: number
): { start: number; end: number } | "invalid" | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/u.exec(raw.trim());
  if (!match) {
    return "invalid";
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return "invalid";
  }

  let start: number;
  let end: number;
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return "invalid";
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}

export async function sendFileStream(
  reply: FastifyReply,
  rangeHeader: string | string[] | undefined,
  filePath: string,
  mimeType: string,
  onStreamCreated?: (stream: ReturnType<typeof createReadStream>) => void
) {
  const fileStat = await stat(filePath);
  const range = parseRangeHeader(rangeHeader, fileStat.size);
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", mimeType);

  if (range === "invalid") {
    reply.header("Content-Range", `bytes */${fileStat.size}`);
    return reply.status(416).send();
  }

  const stream = range ? createReadStream(filePath, range) : createReadStream(filePath);
  onStreamCreated?.(stream);
  if (range) {
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${fileStat.size}`);
    reply.header("Content-Length", String(range.end - range.start + 1));
    return reply.status(206).send(stream);
  }

  reply.header("Content-Length", String(fileStat.size));
  return reply.send(stream);
}

export function safeQueryIndex(db: ZosDatabase, rootId: string, query: string, searchPath = ".") {
  try {
    return queryIndexedText(db, {
      rootId,
      query,
      path: searchPath,
      limit: 25
    });
  } catch {
    return [];
  }
}

export function indexMatchToFileEntry(match: {
  path: string;
  name: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
  mimeType: string | null;
}): FileEntry {
  return {
    name: match.name,
    path: match.path,
    kind: "file",
    ...(match.mimeType ? { mimeType: match.mimeType } : {}),
    sizeBytes: match.sizeBytes ?? 0,
    modifiedAt: new Date(match.mtimeMs ?? 0).toISOString(),
    isSafe: true
  };
}
