import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREVIEW_FILE_SIZE_LIMIT_BYTES,
  MAX_PREVIEW_FILE_SIZE_LIMIT_BYTES,
  MIN_PREVIEW_FILE_SIZE_LIMIT_BYTES,
  PREVIEW_FILE_SIZE_LIMIT_STORAGE_KEY,
  clampPreviewFileSizeLimitBytes,
  previewFileSizeLimitBytesToMiB,
  previewFileSizeLimitMiBToBytes,
  isPreviewOverFileSizeLimit,
  readStoredPreviewFileSizeLimitBytes,
  writeStoredPreviewFileSizeLimitBytes
} from "./preview-settings.js";

describe("preview settings helpers", () => {
  it("clamps preview file size limits to a practical range", () => {
    expect(clampPreviewFileSizeLimitBytes(0)).toBe(MIN_PREVIEW_FILE_SIZE_LIMIT_BYTES);
    expect(clampPreviewFileSizeLimitBytes(Number.NaN)).toBe(DEFAULT_PREVIEW_FILE_SIZE_LIMIT_BYTES);
    expect(clampPreviewFileSizeLimitBytes(MAX_PREVIEW_FILE_SIZE_LIMIT_BYTES * 2)).toBe(
      MAX_PREVIEW_FILE_SIZE_LIMIT_BYTES
    );
  });

  it("converts preview file limits between bytes and MiB", () => {
    expect(previewFileSizeLimitMiBToBytes(12)).toBe(12 * 1024 * 1024);
    expect(previewFileSizeLimitBytesToMiB(12 * 1024 * 1024)).toBe(12);
  });

  it("only blocks previewable files that exceed the configured limit", () => {
    expect(
      isPreviewOverFileSizeLimit(
        {
          kind: "file",
          previewKind: "text",
          sizeBytes: 11 * 1024 * 1024
        },
        10 * 1024 * 1024
      )
    ).toBe(true);
    expect(
      isPreviewOverFileSizeLimit(
        {
          kind: "file",
          previewKind: "text",
          sizeBytes: 10 * 1024 * 1024
        },
        10 * 1024 * 1024
      )
    ).toBe(false);
    expect(
      isPreviewOverFileSizeLimit(
        {
          kind: "file",
          previewKind: "unsupported",
          sizeBytes: 50 * 1024 * 1024
        },
        10 * 1024 * 1024
      )
    ).toBe(false);
    expect(
      isPreviewOverFileSizeLimit(
        {
          kind: "file",
          previewKind: "video",
          sizeBytes: 50 * 1024 * 1024
        },
        10 * 1024 * 1024
      )
    ).toBe(false);
  });

  it("reads and writes persisted preview limits", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      }
    };

    expect(readStoredPreviewFileSizeLimitBytes(storage)).toBe(DEFAULT_PREVIEW_FILE_SIZE_LIMIT_BYTES);
    writeStoredPreviewFileSizeLimitBytes(24 * 1024 * 1024, storage);
    expect(values.get(PREVIEW_FILE_SIZE_LIMIT_STORAGE_KEY)).toBe(String(24 * 1024 * 1024));
    expect(readStoredPreviewFileSizeLimitBytes(storage)).toBe(24 * 1024 * 1024);
    values.set(PREVIEW_FILE_SIZE_LIMIT_STORAGE_KEY, "bad");
    expect(readStoredPreviewFileSizeLimitBytes(storage)).toBe(DEFAULT_PREVIEW_FILE_SIZE_LIMIT_BYTES);
  });

  it("keeps session-only behavior when storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      }
    };

    expect(readStoredPreviewFileSizeLimitBytes(storage)).toBe(DEFAULT_PREVIEW_FILE_SIZE_LIMIT_BYTES);
    expect(() => writeStoredPreviewFileSizeLimitBytes(2 * 1024 * 1024, storage)).not.toThrow();
  });
});
