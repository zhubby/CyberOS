import { describe, expect, it } from "vitest";
import {
  createUploadBatch,
  joinNasPath,
  normalizeNasPath,
  normalizeUploadRelativePath,
  pruneUploadBatchHistory,
  type UploadBatchState,
  type UploadStatus
} from "./uploads.js";

describe("upload path helpers", () => {
  it("normalizes browser relative paths while preserving nested folders", () => {
    expect(normalizeUploadRelativePath("album\\day-one/./photostaff.jpg")).toBe("album/day-one/photostaff.jpg");
    expect(normalizeNasPath("./docs//incoming")).toBe("docs/incoming");
    expect(joinNasPath("docs/incoming", "album/photostaff.jpg")).toBe("docs/incoming/album/photostaff.jpg");
  });

  it("rejects traversal outside the selected root", () => {
    expect(() => normalizeUploadRelativePath("album/../secret.txt")).toThrow(
      "Upload paths cannot escape the selected folder"
    );
    expect(() => normalizeNasPath("../outside")).toThrow("Upload target cannot escape the selected root");
  });
});

describe("upload batches", () => {
  it("builds queued items with normalized nested target paths", () => {
    const file = new File(["photostaff"], "photostaff.jpg", { type: "image/jpeg" });
    const batch = createUploadBatch({
      id: "batch-1",
      rootId: "root-1",
      storagePoolId: "pool-1",
      currentPath: "docs/incoming",
      sources: [{ file, relativePath: "album\\day-one/photostaff.jpg" }]
    });

    expect(batch).toMatchObject({
      id: "batch-1",
      rootId: "root-1",
      storagePoolId: "pool-1",
      targetPath: "docs/incoming",
      status: "queued",
      currentItemId: "batch-1:0",
      items: [
        {
          id: "batch-1:0",
          name: "photostaff.jpg",
          relativePath: "album/day-one/photostaff.jpg",
          targetPath: "docs/incoming/album/day-one/photostaff.jpg",
          sizeBytes: 10,
          uploadedBytes: 0,
          status: "queued"
        }
      ]
    });
  });

  it("keeps active batches and only the newest terminal history", () => {
    const batches = [
      makeBatch("older", "completed", "2026-08-26T10:00:00.000Z"),
      makeBatch("active", "uploading", "2026-08-25T10:00:00.000Z"),
      makeBatch("newest", "failed", "2026-08-28T10:00:00.000Z"),
      makeBatch("middle", "completed", "2026-08-27T10:00:00.000Z")
    ];

    expect(pruneUploadBatchHistory(batches, 2).map((batch) => batch.id)).toEqual(["active", "newest", "middle"]);
  });
});

function makeBatch(id: string, status: UploadStatus, createdAt: string): UploadBatchState {
  return {
    id,
    rootId: "root-1",
    storagePoolId: "pool-1",
    targetPath: ".",
    createdAt,
    status,
    items: [],
    currentItemId: null,
    error: null
  };
}
