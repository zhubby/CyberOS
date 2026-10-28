import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimNextDownloadTask,
  createDownloadTask,
  ensureNasRoots,
  getDownloadWorkerHealth,
  openCyberOsDb,
  renewDownloadTaskLease,
  requestDownloadTaskControl,
  type CyberOsDatabase
} from "../index.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-download-repository-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: tempDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("download reliability repository", () => {
  it("claims retry-wait tasks only after their due time", () => {
    const task = createTask("retry.bin");
    const dueAt = new Date("2026-01-01T00:01:00.000Z");
    db.prepare(`
      UPDATE download_tasks
      SET phase = 'retry_wait', retry_count = 1, next_retry_at = ?
      WHERE id = ?
    `).run(dueAt.toISOString(), task.id);

    expect(claimNextDownloadTask(db, {
      workerId: "worker-early",
      leaseMs: 30_000,
      now: new Date("2026-01-01T00:00:59.999Z")
    })).toBeNull();
    expect(claimNextDownloadTask(db, {
      workerId: "worker-due",
      leaseMs: 30_000,
      now: dueAt
    })).toMatchObject({ id: task.id, status: "running", retryCount: 1, nextRetryAt: null });
  });

  it("classifies worker heartbeats at ready, stale, and unavailable thresholds", () => {
    const now = new Date("2026-01-01T00:02:00.000Z");
    const insertWorker = db.prepare(`
      INSERT INTO download_workers (worker_id, version, started_at, heartbeat_at)
      VALUES (?, 'test', ?, ?)
    `);
    insertWorker.run("unavailable", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:59.999Z");
    expect(getDownloadWorkerHealth(db, now).status).toBe("unavailable");

    insertWorker.run("stale", "2026-01-01T00:01:00.000Z", "2026-01-01T00:01:30.000Z");
    expect(getDownloadWorkerHealth(db, now).status).toBe("stale");

    insertWorker.run("ready", "2026-01-01T00:02:00.000Z", "2026-01-01T00:02:00.000Z");
    expect(getDownloadWorkerHealth(db, now)).toMatchObject({ status: "ready", freshWorkers: 1 });
  });

  it("does not claim a task fenced by a publish journal", () => {
    const task = createTask("publishing.bin");
    db.prepare(`
      INSERT INTO download_publish_journal (
        task_id, operation_id, worker_id, device, inode, size_bytes, created_at
      ) VALUES (?, ?, 'old-worker', 1, 2, 3, ?)
    `).run(task.id, `download:${task.id}`, new Date().toISOString());

    expect(claimNextDownloadTask(db, {
      workerId: "new-worker",
      leaseMs: 30_000
    })).toBeNull();
  });

  it("keeps cancel dominant and stops lease renewal after a control request", () => {
    const task = createTask("control.bin");
    const running = claimNextDownloadTask(db, {
      workerId: "worker",
      leaseMs: 30_000
    });
    expect(running?.id).toBe(task.id);
    expect(requestDownloadTaskControl(db, { id: task.id, request: "cancel" })?.controlRequested).toBe("cancel");
    expect(requestDownloadTaskControl(db, { id: task.id, request: "pause" })?.controlRequested).toBe("cancel");
    expect(renewDownloadTaskLease(db, {
      id: task.id,
      workerId: "worker",
      leaseMs: 30_000
    })).toBe(false);
  });
});

function createTask(fileName: string) {
  return createDownloadTask(db, {
    url: `https://example.com/${fileName}`,
    rootId: "local",
    storagePoolId: "/dev/test",
    targetDirectory: ".",
    targetFileName: fileName,
    targetPath: fileName
  });
}
