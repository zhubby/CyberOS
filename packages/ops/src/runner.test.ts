import { mkdir, mkdtemp, rm, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireExecutionLock,
  createTrashEntry,
  getSystemOperations,
  openCyberOsDb,
  releaseExecutionLock,
  type CyberOsDatabase
} from "@cyberos/db";
import { loadConfig, type CyberOsConfig } from "@cyberos/shared";
import { cleanupRestoreStaging, runMaintenance } from "./maintenance.js";
import { runHealthTask } from "./runner.js";

let tempDir: string;
let rootDir: string;
let stagingDir: string;
let db: CyberOsDatabase;
let config: CyberOsConfig;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-ops-"));
  rootDir = path.join(tempDir, "nas");
  stagingDir = path.join(tempDir, "backup-staging");
  await mkdir(rootDir);
  await mkdir(stagingDir);
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
  config = createConfig(tempDir, rootDir, stagingDir);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("operations runner", () => {
  it("records unhealthy system conclusions as completed health runs", async () => {
    const summary = await runHealthTask({
      db,
      config,
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(summary.status).not.toBe("ready");
    expect(getSystemOperations(db).runs[0]).toMatchObject({
      task: "health",
      status: "completed"
    });
  });

  it("runs passive SQLite maintenance and counts only unrestored trash rows", async () => {
    const active = createTrashEntry(db, {
      storagePoolId: "local",
      originalPath: "one.txt",
      trashPath: ".trash/one.txt"
    });
    createTrashEntry(db, {
      storagePoolId: "local",
      originalPath: "two.txt",
      trashPath: ".trash/two.txt"
    });
    db.prepare("UPDATE trash_entries SET restored_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", active.id);

    const summary = await runMaintenance({
      db,
      config,
      now: new Date("2026-01-08T00:00:00.000Z")
    });
    expect(summary.walCheckpoint).toEqual({
      busy: expect.any(Number),
      logFrames: expect.any(Number),
      checkpointedFrames: expect.any(Number)
    });
    expect(summary.trash.unrestoredEntries).toBe(1);
  });

  it("removes only old real restore directories and ignores symlinks", async () => {
    const oldDirectory = path.join(stagingDir, "restore-old");
    const freshDirectory = path.join(stagingDir, "restore-fresh");
    const outside = path.join(tempDir, "outside");
    await mkdir(oldDirectory);
    await mkdir(freshDirectory);
    await mkdir(outside);
    await symlink(outside, path.join(stagingDir, "restore-link"));
    await utimes(oldDirectory, new Date("2025-12-01T00:00:00.000Z"), new Date("2025-12-01T00:00:00.000Z"));

    const result = await cleanupRestoreStaging(db, config, new Date("2026-01-08T00:00:00.000Z"));
    expect(result).toMatchObject({ status: "completed", removed: 1 });
    await expect(mkdir(oldDirectory)).resolves.toBeUndefined();
    await expect(mkdir(freshDirectory)).rejects.toThrow();
    await expect(mkdir(outside)).rejects.toThrow();
  });

  it("defers staging cleanup while backup owns its lease", async () => {
    expect(acquireExecutionLock(db, { name: "backup", owner: "backup-worker" })).toBe(true);
    await expect(cleanupRestoreStaging(db, config)).resolves.toMatchObject({
      status: "deferred",
      removed: 0
    });
    expect(releaseExecutionLock(db, { name: "backup", owner: "backup-worker" })).toBe(true);
  });
});

function createConfig(dataDir: string, rootPath: string, stagingPath: string): CyberOsConfig {
  const base = loadConfig({ CYBEROS_CONFIG: path.join(dataDir, "missing.toml"), CYBEROS_ROOT: dataDir }, dataDir);
  return {
    ...base,
    paths: { ...base.paths, dataRoot: rootPath, databasePath: path.join(dataDir, "cyberos.sqlite") },
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50, concurrency: 1 },
    admin: { displayName: "Test Admin", authMode: "local-only" },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 120_000, consoleShells: ["/bin/sh"] },
    shares: { enabled: false, account: { username: "cyberos-share", password: null }, shares: [] },
    hostd: { socketPath: path.join(dataDir, "hostd.sock"), mutationPolicy: "mutable" },
    terminal: { user: "test-user", socketPath: path.join(dataDir, "terminald.sock"), sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: path.join(dataDir, "vod.sock"), statePath: path.join(dataDir, "vod.json"), commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "cyberos" },
    backup: { enabled: false, repositoryPath: null, passwordFile: null, stagingPath, requireMount: false, retryCount: 1, timeoutMs: 1000, keepDaily: 7, keepWeekly: 4 },
  };
}
