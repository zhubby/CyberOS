import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimNextFileBatchItem,
  createFileBatch,
  createSession,
  ensureNasRoots,
  getFileBatch,
  listEvents,
  listFileOperations,
  listPendingApprovals,
  openSigmaDb,
  recoverInterruptedFileBatches,
  type SigmaDatabase
} from "@sigmaos/db";
import type { SigmaConfig } from "@sigmaos/shared";
import type { SystemCommandRunner } from "./system-management.js";
import { FileBatchRunner, processNextFileBatchItem } from "./file-batch-runner.js";

let tempDir: string;
let rootDir: string;
let db: SigmaDatabase;
let sessionId: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-file-runner-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir);
  db = openSigmaDb(path.join(tempDir, "sigmaos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: rootDir }]);
  sessionId = createSession(db, { rootId: "local" }).id;
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("file batch runner", () => {
  it("moves every item without creating approvals", async () => {
    await mkdir(path.join(rootDir, "dest"));
    await writeFile(path.join(rootDir, "a.txt"), "a");
    await writeFile(path.join(rootDir, "b.txt"), "b");
    const batch = createFileBatch(db, {
      sessionId,
      rootId: "local",
      storagePoolId: "pool-1",
      operation: "move",
      targetDirectory: "dest",
      summary: "Move two items",
      items: [
        { sourcePath: "a.txt", targetPath: "dest/a.txt" },
        { sourcePath: "b.txt", targetPath: "dest/b.txt" }
      ]
    });

    await drain();

    await expect(readFile(path.join(rootDir, "dest/a.txt"), "utf8")).resolves.toBe("a");
    await expect(readFile(path.join(rootDir, "dest/b.txt"), "utf8")).resolves.toBe("b");
    expect(getFileBatch(db, batch.id)).toMatchObject({ status: "completed", successCount: 2, failedCount: 0 });
    expect(listPendingApprovals(db)).toHaveLength(0);
    expect(listFileOperations(db)).toHaveLength(2);
  });

  it("continues after an item fails and reports the failure", async () => {
    await writeFile(path.join(rootDir, "present.txt"), "present");
    const batch = createFileBatch(db, {
      sessionId,
      rootId: "local",
      storagePoolId: "pool-1",
      operation: "trash",
      summary: "Trash two items",
      items: [{ sourcePath: "missing.txt" }, { sourcePath: "present.txt" }]
    });

    await drain();

    expect(getFileBatch(db, batch.id)).toMatchObject({
      status: "failed",
      successCount: 1,
      failedCount: 1,
      completedCount: 2
    });
    await expect(stat(path.join(rootDir, "present.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a move completed before its database status was persisted", async () => {
    await mkdir(path.join(rootDir, "dest"));
    await writeFile(path.join(rootDir, "recover.txt"), "recover");
    const batch = createFileBatch(db, {
      sessionId,
      rootId: "local",
      storagePoolId: "pool-1",
      operation: "move",
      targetDirectory: "dest",
      summary: "Move one item",
      items: [{ sourcePath: "recover.txt", targetPath: "dest/recover.txt" }]
    });
    expect(claimNextFileBatchItem(db)?.item.status).toBe("running");
    await rename(path.join(rootDir, "recover.txt"), path.join(rootDir, "dest/recover.txt"));

    expect(recoverInterruptedFileBatches(db)).toBe(1);
    await drain();

    expect(getFileBatch(db, batch.id)).toMatchObject({ status: "completed", successCount: 1 });
    expect(listFileOperations(db)[0]?.metadata.recovered).toBe(true);
  });

  it("publishes a running event when an item starts and a terminal event when the batch finishes", async () => {
    await writeFile(path.join(rootDir, "events.txt"), "events");
    const batch = createFileBatch(db, {
      sessionId,
      rootId: "local",
      storagePoolId: "pool-1",
      operation: "trash",
      summary: "Trash one item",
      items: [{ sourcePath: "events.txt" }]
    });
    const runner = new FileBatchRunner({
      db,
      config: testConfig(),
      system: { commandRunner: storageCommandRunner() }
    });

    runner.start();
    await runner.stop();

    expect(listEvents(db, { sessionId }).map((event) => ({ type: event.type, payload: event.payload }))).toMatchObject([
      { type: "job.running", payload: { fileBatchId: batch.id } },
      { type: "job.completed", payload: { fileBatchId: batch.id } }
    ]);
  });
});

async function drain(): Promise<void> {
  while (await processNextFileBatchItem({
    db,
    config: testConfig(),
    system: { commandRunner: storageCommandRunner() }
  })) {
    // Process until the persistent queue is empty.
  }
}

function storageCommandRunner(): SystemCommandRunner {
  return {
    async run(command, args) {
      if (command === "findmnt") {
        return JSON.stringify({
          filesystems: [{ source: "pool-1", target: rootDir, fstype: "ext4", size: 1024, used: 128, avail: 896, "use%": "12.5%" }]
        });
      }
      if (command === "mdadm" && args[0] === "--detail" && args[1] === "--scan") {
        return "ARRAY pool-1 name=test-pool UUID=test-pool";
      }
      if (command === "mdadm" && args[0] === "--detail") {
        return "Name : test-pool\nRaid Level : raid1\nState : clean\nUUID : test-pool\nArray Size : 1024 KiB";
      }
      if (command === "smartctl") return JSON.stringify({ devices: [] });
      return JSON.stringify({ blockdevices: [] });
    }
  };
}

function testConfig(): SigmaConfig {
  return {
    dataDir: tempDir,
    databasePath: path.join(tempDir, "sigmaos.sqlite"),
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50 },
    admin: { displayName: "Test Admin", authMode: "local-only" },
    model: { provider: "pi", piCommand: "pi", localEndpoint: null },
    docker: {
      enabled: false,
      socketPath: "/var/run/docker.sock",
      composeCommand: "docker",
      operationTimeoutMs: 120_000,
      consoleShells: ["/bin/sh"]
    },
    hostd: { socketPath: "/run/sigmaos/hostd.sock" },
    shares: { enabled: false, account: { username: "sigma-share", password: null }, shares: [] },
    terminal: { user: "test-user", termuxSocketPath: "/tmp/termux.sock" },
    vodPlayer: {
      enabled: false,
      socketPath: "/tmp/vod-player.sock",
      statePath: "/tmp/vod-player-session.json",
      commandTimeoutMs: 5_000,
      startupTimeoutMs: 15_000,
      checkpointIntervalMs: 5_000,
      retryBaseDelayMs: 2_000,
      retryMaxDelayMs: 60_000,
      videoOutput: "drm",
      drmConnector: null,
      audioOutput: "alsa",
      audioDevice: null,
      hwdec: "auto-safe",
      user: "sigmaos"
    },
    nasRoots: [{ id: "local", name: "Local", path: rootDir }]
  };
}
