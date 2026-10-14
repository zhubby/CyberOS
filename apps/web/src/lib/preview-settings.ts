import type { FileMeta } from "../api.js";

export const BYTES_PER_MEBIBYTE = 1024 * 1024;
export const DEFAULT_PREVIEW_FILE_SIZE_LIMIT_BYTES = 10 * BYTES_PER_MEBIBYTE;
export const MIN_PREVIEW_FILE_SIZE_LIMIT_BYTES = BYTES_PER_MEBIBYTE;
export const MAX_PREVIEW_FILE_SIZE_LIMIT_BYTES = 1024 * BYTES_PER_MEBIBYTE;
export const PREVIEW_FILE_SIZE_LIMIT_STORAGE_KEY = "zos:preview-file-size-limit-bytes";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function clampPreviewFileSizeLimitBytes(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PREVIEW_FILE_SIZE_LIMIT_BYTES;
  }

  return Math.min(
    Math.max(Math.floor(value), MIN_PREVIEW_FILE_SIZE_LIMIT_BYTES),
    MAX_PREVIEW_FILE_SIZE_LIMIT_BYTES
  );
}

export function previewFileSizeLimitBytesToMiB(value: number): number {
  return Math.round(clampPreviewFileSizeLimitBytes(value) / BYTES_PER_MEBIBYTE);
}

export function previewFileSizeLimitMiBToBytes(value: number): number {
  return clampPreviewFileSizeLimitBytes(value * BYTES_PER_MEBIBYTE);
}

export function isPreviewOverFileSizeLimit(
  meta: Pick<FileMeta, "kind" | "previewKind" | "sizeBytes">,
  limitBytes: number
): boolean {
  return (
    meta.kind === "file" &&
    meta.previewKind !== "unsupported" &&
    meta.previewKind !== "video" &&
    meta.sizeBytes > clampPreviewFileSizeLimitBytes(limitBytes)
  );
}

export function readStoredPreviewFileSizeLimitBytes(
  storage: StorageLike | null = browserStorage()
): number {
  try {
    const raw = storage?.getItem(PREVIEW_FILE_SIZE_LIMIT_STORAGE_KEY);
    const parsed = Number(raw ?? DEFAULT_PREVIEW_FILE_SIZE_LIMIT_BYTES);
    return clampPreviewFileSizeLimitBytes(parsed);
  } catch {
    return DEFAULT_PREVIEW_FILE_SIZE_LIMIT_BYTES;
  }
}

export function writeStoredPreviewFileSizeLimitBytes(
  value: number,
  storage: StorageLike | null = browserStorage()
): void {
  try {
    storage?.setItem(PREVIEW_FILE_SIZE_LIMIT_STORAGE_KEY, String(clampPreviewFileSizeLimitBytes(value)));
  } catch {
    // The current session can still apply the updated limit when storage is unavailable.
  }
}
