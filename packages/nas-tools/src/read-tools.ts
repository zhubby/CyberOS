import { createReadStream } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { NasRootRecord } from "@cyberos/shared";
import { isPathInside, resolveSafeExistingPath } from "./path-safety.js";

export interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  mimeType?: string;
  sizeBytes: number;
  modifiedAt: string;
  isSafe: boolean;
}

export interface FileStat {
  path: string;
  kind: FileEntry["kind"];
  sizeBytes: number;
  modifiedAt: string;
  createdAt: string;
}

export interface TextPreview {
  path: string;
  content: string;
  truncated: boolean;
}

export async function listDir(root: NasRootRecord, requestedPath = "."): Promise<FileEntry[]> {
  const safe = await resolveSafeExistingPath(root.path, requestedPath);
  const directoryStat = await stat(safe.realPath);
  if (!directoryStat.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const entries = await readdir(safe.realPath, { withFileTypes: true });
  const hydrated = await Promise.all(
    entries.map(async (entry): Promise<FileEntry> => {
      const absoluteEntryPath = path.join(safe.realPath, entry.name);
      const entryStat = await lstat(absoluteEntryPath);
      const relativePath = path.join(safe.relativePath, entry.name);
      const kind = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : entry.isSymbolicLink()
            ? "symlink"
            : "other";
      const isSafe = await isEntrySafe(safe.rootRealPath, absoluteEntryPath);

      return {
        name: entry.name,
        path: relativePath,
        kind,
        sizeBytes: entryStat.size,
        modifiedAt: entryStat.mtime.toISOString(),
        isSafe
      };
    })
  );

  return hydrated.sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") {
      return -1;
    }
    if (left.kind !== "directory" && right.kind === "directory") {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export async function statPath(root: NasRootRecord, requestedPath: string): Promise<FileStat> {
  const safe = await resolveSafeExistingPath(root.path, requestedPath);
  const entryStat = await lstat(safe.realPath);
  return {
    path: safe.relativePath,
    kind: entryStat.isDirectory() ? "directory" : entryStat.isFile() ? "file" : entryStat.isSymbolicLink() ? "symlink" : "other",
    sizeBytes: entryStat.size,
    modifiedAt: entryStat.mtime.toISOString(),
    createdAt: entryStat.birthtime.toISOString()
  };
}

export async function readText(
  root: NasRootRecord,
  requestedPath: string,
  maxBytes = 64 * 1024
): Promise<TextPreview> {
  const safe = await resolveSafeExistingPath(root.path, requestedPath);
  const entryStat = await stat(safe.realPath);
  if (!entryStat.isFile()) {
    throw new Error("Path is not a file");
  }

  const byteLimit = Math.max(0, maxBytes);
  const handle = await open(safe.realPath, "r");
  try {
    const buffer = Buffer.alloc(byteLimit + 1);
    const { bytesRead } = await handle.read(buffer, 0, byteLimit + 1, 0);
    const slice = buffer.subarray(0, Math.min(bytesRead, byteLimit));

    return {
      path: safe.relativePath,
      content: slice.toString("utf8"),
      truncated: bytesRead > byteLimit
    };
  } finally {
    await handle.close();
  }
}

export function previewFile(
  root: NasRootRecord,
  requestedPath: string,
  maxBytes = 16 * 1024
): Promise<TextPreview> {
  return readText(root, requestedPath, maxBytes);
}

export async function searchFiles(
  root: NasRootRecord,
  input: { query: string; path?: string; limit?: number; maxDepth?: number }
): Promise<FileEntry[]> {
  const safe = await resolveSafeExistingPath(root.path, input.path ?? ".");
  const query = input.query.toLocaleLowerCase();
  const limit = input.limit ?? 50;
  const maxDepth = input.maxDepth ?? 6;
  const matches: FileEntry[] = [];

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (matches.length >= limit || depth > maxDepth) {
      return;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= limit) {
        return;
      }

      const absoluteEntryPath = path.join(currentPath, entry.name);
      const entryStat = await lstat(absoluteEntryPath);
      const safeEntry = await isEntrySafe(safe.rootRealPath, absoluteEntryPath);
      const relativePath = path.relative(safe.rootRealPath, absoluteEntryPath) || ".";
      const kind = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : entry.isSymbolicLink()
            ? "symlink"
            : "other";

      if (entry.name.toLocaleLowerCase().includes(query)) {
        matches.push({
          name: entry.name,
          path: relativePath,
          kind,
          sizeBytes: entryStat.size,
          modifiedAt: entryStat.mtime.toISOString(),
          isSafe: safeEntry
        });
      }

      if (entry.isDirectory() && safeEntry) {
        await walk(absoluteEntryPath, depth + 1);
      }
    }
  }

  await walk(safe.realPath, 0);
  return matches;
}

export async function readFirstLines(filePath: string, maxLines = 12): Promise<string[]> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines: string[] = [];
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of reader) {
    lines.push(line);
    if (lines.length >= maxLines) {
      reader.close();
      stream.close();
      break;
    }
  }

  return lines;
}

async function isEntrySafe(rootRealPath: string, absoluteEntryPath: string): Promise<boolean> {
  try {
    const entryRealPath = await import("node:fs/promises").then((fs) => fs.realpath(absoluteEntryPath));
    return isPathInside(rootRealPath, entryRealPath);
  } catch {
    return false;
  }
}
