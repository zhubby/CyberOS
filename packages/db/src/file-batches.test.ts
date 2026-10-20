import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelFileBatch,
  claimNextFileBatchItem,
  claimNextJob,
  createFileBatch,
  ensureNasRoots,
  FileBatchConflictError,
  finishFileBatchItem,
  getFileBatch,
  openZosDb,
  type ZosDatabase
} from "./index.js";

let tempDir: string;
let db: ZosDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-file-batches-"));
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: tempDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

function createBatch(sourcePaths = ["pool/a.txt", "pool/b.txt"]) {
  return createFileBatch(db, {
    rootId: "local",
    storagePoolId: "pool-1",
    operation: "trash",
    summary: "Trash selected items",
    items: sourcePaths.map((sourcePath) => ({ sourcePath }))
  });
}

describe("file batch repository", () => {
  it("keeps file batches out of the agent worker queue and aggregates partial failures", () => {
    createBatch();
    expect(claimNextJob(db)).toBeNull();

    const first = claimNextFileBatchItem(db)!;
    expect(first.batch.status).toBe("running");
    expect(finishFileBatchItem(db, { itemId: first.item.id, status: "completed" }).finalStatus).toBeNull();

    const second = claimNextFileBatchItem(db)!;
    const finished = finishFileBatchItem(db, {
      itemId: second.item.id,
      status: "failed",
      error: "permission denied"
    });
    expect(finished.finalStatus).toBe("failed");
    expect(finished.batch).toMatchObject({
      completedCount: 2,
      successCount: 1,
      failedCount: 1,
      cancelledCount: 0,
      status: "failed"
    });
    expect(finished.batch.failures).toEqual([
      { sourcePath: "pool/b.txt", error: "permission denied" }
    ]);
  });

  it("rejects a duplicate active source path", () => {
    createBatch(["pool/a.txt"]);
    expect(() => createBatch(["pool/a.txt"])).toThrow(FileBatchConflictError);
  });

  it("cancels queued items after the current filesystem item", () => {
    const batch = createBatch();
    const running = claimNextFileBatchItem(db)!;
    expect(cancelFileBatch(db, batch.id)?.status).toBe("cancelled");

    const finished = finishFileBatchItem(db, { itemId: running.item.id, status: "completed" });
    expect(finished.finalStatus).toBe("cancelled");
    expect(getFileBatch(db, batch.id)).toMatchObject({
      status: "cancelled",
      successCount: 1,
      cancelledCount: 1,
      completedCount: 2
    });
    expect(claimNextJob(db)).toBeNull();
  });
});
