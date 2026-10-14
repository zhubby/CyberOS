import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { NasRootRecord } from "@zos/shared";
import { resolveSafeExistingPath } from "./path-safety.js";

export interface FileMetadata {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  mtimeMs: number;
  modifiedAt: string;
}

export interface DuplicateCandidate {
  hash: string;
  paths: string[];
  sizeBytes: number;
}

export async function hashFile(root: NasRootRecord, requestedPath: string): Promise<string> {
  const safe = await resolveSafeExistingPath(root.path, requestedPath);
  const entryStat = await stat(safe.realPath);
  if (!entryStat.isFile()) {
    throw new Error("Path is not a file");
  }

  return hashAbsoluteFile(safe.realPath);
}

export async function hashAbsoluteFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function extractMetadata(
  root: NasRootRecord,
  requestedPath: string
): Promise<FileMetadata> {
  const safe = await resolveSafeExistingPath(root.path, requestedPath);
  const entryStat = await stat(safe.realPath);
  return {
    path: safe.relativePath,
    name: path.basename(safe.relativePath),
    mimeType: inferMimeType(safe.realPath),
    sizeBytes: entryStat.size,
    mtimeMs: entryStat.mtimeMs,
    modifiedAt: entryStat.mtime.toISOString()
  };
}

export function inferMimeType(filePath: string): string {
  const fileName = path.basename(filePath).toLocaleLowerCase();
  if (isSpecialTextFileName(fileName)) {
    return "text/plain";
  }

  const ext = path.extname(fileName);
  switch (ext) {
    case ".txt":
    case ".md":
    case ".markdown":
    case ".mdx":
    case ".log":
    case ".csv":
    case ".tsv":
    case ".json":
    case ".jsonc":
    case ".toml":
    case ".yaml":
    case ".yml":
    case ".xml":
    case ".ini":
    case ".conf":
    case ".cfg":
    case ".env":
    case ".properties":
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".py":
    case ".rb":
    case ".rs":
    case ".go":
    case ".java":
    case ".c":
    case ".h":
    case ".cpp":
    case ".hpp":
    case ".sh":
    case ".zsh":
    case ".bash":
    case ".sql":
    case ".css":
    case ".html":
    case ".htm":
      return "text/plain";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
      return "audio/ogg";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".m4v":
      return "video/mp4";
    case ".avi":
      return "video/x-msvideo";
    case ".mkv":
      return "video/x-matroska";
    case ".mpeg":
    case ".mpg":
      return "video/mpeg";
    case ".mov":
      return "video/quicktime";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".zip":
      return "application/zip";
    case ".gz":
      return "application/gzip";
    case ".tar":
      return "application/x-tar";
    case ".tgz":
      return "application/gzip";
    case ".7z":
      return "application/x-7z-compressed";
    case ".rar":
      return "application/vnd.rar";
    case ".dmg":
      return "application/x-apple-diskimage";
    case ".exe":
      return "application/vnd.microsoft.portable-executable";
    default:
      return "application/octet-stream";
  }
}

function isSpecialTextFileName(fileName: string): boolean {
  return (
    fileName === "dockerfile" ||
    fileName.startsWith("dockerfile.") ||
    fileName === "makefile" ||
    fileName === "gnumakefile" ||
    fileName === "bsdmakefile" ||
    fileName.startsWith("makefile.") ||
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName === ".bashrc" ||
    fileName === ".bash_profile" ||
    fileName === ".zshrc" ||
    fileName === ".zprofile" ||
    fileName === ".profile" ||
    fileName === ".gitignore" ||
    fileName === ".dockerignore" ||
    fileName === ".npmrc"
  );
}

export type FilePreviewKind =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "unsupported";

export function inferPreviewKind(mimeType: string): FilePreviewKind {
  if (mimeType.startsWith("text/")) {
    return "text";
  }
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType === "application/pdf") {
    return "pdf";
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "document";
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return "spreadsheet";
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return "presentation";
  }
  if (mimeType === "application/octet-stream") {
    return "text";
  }
  return "unsupported";
}

export function ocrDocument(_root: NasRootRecord, requestedPath: string): { path: string; text: string; available: false } {
  return {
    path: requestedPath,
    text: "",
    available: false
  };
}
