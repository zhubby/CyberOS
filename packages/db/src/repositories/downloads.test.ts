import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimNextDownloadTask,
  claimNextTorrentPreview,
  completeTorrentPreview,
  createDownloadTask,
  createTorrentDownloadTask,
  createTorrentPreview,
  deleteDownloadTask,
  getDownloadTask,
  getTorrentPreview,
  getDownloadWorkerHealth,
  listDownloadTaskFiles,
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
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("download reliability repository", () => {
  it("resolves a torrent preview and atomically creates a selected-file task", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const preview = createTorrentPreview(db, {
      sourceKind: "magnet",
      sourceUri: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
      now
    });
    expect(preview).toMatchObject({ sourceKind: "magnet", status: "queued" });

    const claimed = claimNextTorrentPreview(db, {
      workerId: "torrent-worker",
      leaseMs: 30_000,
      now
    });
    expect(claimed).toMatchObject({ id: preview.id, status: "resolving", workerId: "torrent-worker" });

    const ready = completeTorrentPreview(db, {
      id: preview.id,
      workerId: "torrent-worker",
      infoHash: "0123456789012345678901234567890123456789",
      name: "release",
      metainfo: Buffer.from("torrent fixture"),
      totalBytes: 60,
      isPrivate: false,
      files: [
        { fileIndex: 0, path: "release/a.bin", sizeBytes: 10 },
        { fileIndex: 1, path: "release/b.bin", sizeBytes: 20 },
        { fileIndex: 2, path: "release/c.bin", sizeBytes: 30 }
      ],
      now
    });
    expect(ready).toMatchObject({ status: "ready", fileCount: 3, totalBytes: 60 });
    expect(ready.files.map((file) => file.path)).toEqual([
      "release/a.bin",
      "release/b.bin",
      "release/c.bin"
    ]);

    const task = createTorrentDownloadTask(db, {
      previewId: preview.id,
      selectedFileIndices: [0, 2],
      storagePoolId: "pool-1",
      targetDirectory: "downloads",
      targetFileName: "release",
      targetPath: "downloads/release",
      now
    });
    expect(task).toMatchObject({
      sourceKind: "magnet",
      torrentInfoHash: "0123456789012345678901234567890123456789",
      torrentName: "release",
      selectedFileCount: 2,
      totalBytes: 40,
      seedRatioLimit: 1,
      seedTimeLimitSeconds: 7_200
    });
    expect(listDownloadTaskFiles(db, task.id)).toEqual([
      expect.objectContaining({ fileIndex: 0, selected: true }),
      expect.objectContaining({ fileIndex: 1, selected: false }),
      expect.objectContaining({ fileIndex: 2, selected: true })
    ]);
    expect(getTorrentPreview(db, preview.id)).toBeNull();
  });

  it("maps existing HTTP tasks to the extended download contract", () => {
    const task = createTask("legacy-http.bin");

    expect(task).toMatchObject({
      sourceKind: "http",
      torrentInfoHash: null,
      selectedFileCount: 0,
      uploadedBytes: 0,
      uploadSpeedBytesPerSecond: 0,
      peerCount: 0,
      seedRatioLimit: 1,
      seedTimeLimitSeconds: 7_200,
      contentCompletedAt: null,
      seedStartedAt: null
    });
  });

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

  it("keeps the legacy HTTP claim path isolated from torrent tasks", () => {
    const torrent = createTorrentTask(new Date("2026-01-01T00:00:00.000Z"));
    db.prepare(`
      UPDATE download_tasks
      SET status = 'running', worker_id = 'torrent-worker', lease_expires_at = ?
      WHERE id = ?
    `).run("2026-01-01T00:00:01.000Z", torrent.id);
    const http = createDownloadTask(db, {
      url: "https://example.com/http-only.bin",
      storagePoolId: "pool-1",
      targetDirectory: ".",
      targetFileName: "http-only.bin",
      targetPath: "http-only.bin",
      now: new Date("2026-01-01T00:00:02.000Z")
    });

    expect(claimNextDownloadTask(db, {
      workerId: "http-worker",
      leaseMs: 30_000,
      now: new Date("2026-01-01T00:00:03.000Z")
    })?.id).toBe(http.id);
    expect(getDownloadTask(db, torrent.id)).toMatchObject({
      status: "running",
      workerId: "torrent-worker"
    });
  });

  it("does not delete an active seeding task", () => {
    const torrent = createTorrentTask(new Date("2026-01-01T00:00:00.000Z"));
    db.prepare("UPDATE download_tasks SET status = 'seeding' WHERE id = ?").run(torrent.id);

    expect(deleteDownloadTask(db, torrent.id)).toBe(false);
    expect(getDownloadTask(db, torrent.id)?.status).toBe("seeding");
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
    storagePoolId: "pool-1",
    targetDirectory: ".",
    targetFileName: fileName,
    targetPath: fileName
  });
}

function createTorrentTask(now: Date) {
  const preview = createTorrentPreview(db, {
    sourceKind: "magnet",
    sourceUri: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
    now
  });
  claimNextTorrentPreview(db, { workerId: "preview-worker", leaseMs: 30_000, now });
  completeTorrentPreview(db, {
    id: preview.id,
    workerId: "preview-worker",
    infoHash: "0123456789012345678901234567890123456789",
    name: "release",
    metainfo: Buffer.from("torrent fixture"),
    totalBytes: 10,
    isPrivate: false,
    files: [{ fileIndex: 0, path: "release.bin", sizeBytes: 10 }],
    now
  });
  return createTorrentDownloadTask(db, {
    previewId: preview.id,
    selectedFileIndices: [0],
    storagePoolId: "pool-1",
    targetDirectory: ".",
    targetFileName: "release",
    targetPath: "release",
    now
  });
}
