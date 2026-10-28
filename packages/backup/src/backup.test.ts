import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireExecutionLock,
  ensureNasRoots,
  isExecutionLockOwner,
  openCyberOsDb,
  releaseExecutionLock,
  type CyberOsDatabase
} from "@cyberos/db";
import type { CyberOsConfig } from "@cyberos/shared";
import { initBackup, restoreBackup, runBackup, shouldSkipScheduledBackup, validateBackup } from "./backup.js";

let tempDir: string | undefined;
let db: CyberOsDatabase | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function config(root: string, repository: string, passwordFile: string): CyberOsConfig {
  return {
    environment: "development",
    dataDir: path.join(path.dirname(root), "data"),
    databasePath: path.join(path.dirname(root), "cyberos.sqlite"),
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50 },
    admin: { displayName: "Test", authMode: "local-only" },
    model: { provider: "pi", piCommand: "pi", localEndpoint: null },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 120000, consoleShells: ["/bin/sh"] },
    hostd: { socketPath: "/tmp/hostd.sock" },
    shares: { enabled: false, account: { username: "share", password: null }, shares: [] },
    terminal: { user: "test-user", termuxSocketPath: "/tmp/termux.sock" },
    vodPlayer: { enabled: false, socketPath: "/tmp/vod-player.sock", statePath: "/tmp/vod-player-session.json", commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "cyberos" },
    nasRoots: [{ id: "local", name: "Local", path: root, mountPolicy: "optional" }],
    backup: { enabled: true, repositoryPath: repository, passwordFile, stagingPath: path.join(path.dirname(root), "staging"), requireMount: false, retryCount: 1, timeoutMs: 1000, keepDaily: 7, keepWeekly: 4 },
    health: { staleIndexWarningMs: 7200000, staleIndexCriticalMs: 21600000, stalledRunMs: 900000, consecutiveFailureThreshold: 2, backupStaleMs: 93600000 }
  };
}

describe("backup workflow", () => {
  it("skips scheduled runs when backup is disabled", () => {
    const cfg = config("/tmp/root", "/tmp/repo", "/tmp/password");

    expect(shouldSkipScheduledBackup({ ...cfg, backup: { ...cfg.backup!, enabled: false } }, "run")).toBe(true);
    expect(shouldSkipScheduledBackup(cfg, "run")).toBe(false);
    expect(shouldSkipScheduledBackup({ ...cfg, backup: { ...cfg.backup!, enabled: false } }, "validate")).toBe(false);
  });

  it("validates credentials and records a completed restic run", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-backup-"));
    const root = path.join(tempDir, "root");
    const repo = path.join(tempDir, "repo");
    await mkdir(root);
    await mkdir(repo);
    const password = path.join(tempDir, "password");
    await writeFile(password, "secret\n");
    db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
    ensureNasRoots(db, [{ id: "local", name: "Local", path: root }]);
    const calls: string[][] = [];
    let manifestVersion: number | undefined;
    const restic = { run: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "backup" && args.at(-1)?.includes(`${path.sep}staging${path.sep}run-`)) {
        const manifest = JSON.parse(await readFile(path.join(args.at(-1)!, "manifest.json"), "utf8")) as { version: number };
        manifestVersion = manifest.version;
      }
      if (args[0] === "snapshots") return { stdout: calls.filter((entry) => entry[0] === "backup").length ? '[{"id":"abc123"}]' : "[]", stderr: "", code: 0 };
      return { stdout: '{"id":"abc123"}\n', stderr: "", code: 0 };
    } };
    const cfg = config(root, repo, password);
    await expect(validateBackup({ db, config: cfg, restic })).resolves.toMatchObject({ ok: true });
    const result = await runBackup({ db, config: cfg, restic });
    expect(result).toMatchObject({ status: "completed", snapshotIds: ["abc123"], verified: true });
    expect(calls.some((args) => args[0] === "backup")).toBe(true);
    expect(manifestVersion).toBe(2);
  });

  it("restores only CyberOS v2 manifests", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-backup-"));
    const root = path.join(tempDir, "root");
    const repo = path.join(tempDir, "repo");
    await mkdir(root);
    await mkdir(repo);
    const password = path.join(tempDir, "password");
    await writeFile(password, "secret\n");
    db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
    ensureNasRoots(db, [{ id: "local", name: "Local", path: root }]);
    const cfg = config(root, repo, password);
    const databaseContents = "cyberos-v2-database";
    const checksum = createHash("sha256").update(databaseContents).digest("hex");
    const restic = {
      run: async (args: string[]) => {
        if (args[0] === "restore" && !args.includes("--dry-run")) {
          const target = args[args.indexOf("--target") + 1]!;
          const restored = path.join(target, "state");
          await mkdir(restored, { recursive: true });
          await writeFile(path.join(restored, "cyberos.sqlite"), databaseContents);
          await writeFile(path.join(restored, "manifest.json"), JSON.stringify({
            version: 2,
            runId: "run-v2",
            createdAt: new Date().toISOString(),
            roots: [{ rootId: "local", path: root }],
            database: "cyberos.sqlite",
            checksums: { "cyberos.sqlite": checksum }
          }));
        }
        return { stdout: "", stderr: "", code: 0 };
      }
    };

    await expect(restoreBackup({ db, config: cfg, restic, snapshot: "snapshot-v2" }))
      .resolves.toMatchObject({ verified: true });
  });

  it("rejects v1 backup manifests", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-backup-"));
    const root = path.join(tempDir, "root");
    const repo = path.join(tempDir, "repo");
    await mkdir(root);
    await mkdir(repo);
    const password = path.join(tempDir, "password");
    await writeFile(password, "secret\n");
    db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
    ensureNasRoots(db, [{ id: "local", name: "Local", path: root }]);
    const cfg = config(root, repo, password);
    const restic = {
      run: async (args: string[]) => {
        if (args[0] === "restore" && !args.includes("--dry-run")) {
          const target = args[args.indexOf("--target") + 1]!;
          await writeFile(path.join(target, "manifest.json"), JSON.stringify({
            version: 1,
            runId: "old-run",
            roots: [{ rootId: "local", path: root }],
            database: "cyberos.sqlite",
            checksums: {}
          }));
        }
        return { stdout: "", stderr: "", code: 0 };
      }
    };

    await expect(restoreBackup({ db, config: cfg, restic, snapshot: "snapshot-v1" }))
      .rejects.toThrow("restore manifest validation failed");
  });

  it("continues backing up ready roots but skips retention when another root is unavailable", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-backup-"));
    const badRoot = path.join(tempDir, "bad-root");
    const goodRoot = path.join(tempDir, "good-root");
    const repo = path.join(tempDir, "repo");
    await mkdir(badRoot);
    await mkdir(goodRoot);
    await mkdir(repo);
    const password = path.join(tempDir, "password");
    await writeFile(password, "secret\n");
    db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
    ensureNasRoots(db, [
      { id: "bad", name: "Bad", path: badRoot, mountPolicy: "required" },
      { id: "good", name: "Good", path: goodRoot, mountPolicy: "optional" }
    ]);
    const calls: string[][] = [];
    const restic = {
      run: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "snapshots") return { stdout: '[{"id":"visible"}]', stderr: "", code: 0 };
        return { stdout: '{"id":"visible"}\n', stderr: "", code: 0 };
      }
    };
    const base = config(goodRoot, repo, password);
    const cfg: CyberOsConfig = {
      ...base,
      nasRoots: [
        { id: "bad", name: "Bad", path: badRoot, mountPolicy: "required" },
        { id: "good", name: "Good", path: goodRoot, mountPolicy: "optional" }
      ]
    };
    const result = await runBackup({
      db,
      config: cfg,
      restic,
      mountCommandRunner: {
        run: async (_command, args) => JSON.stringify({
          filesystems: [{ source: "/dev/root", uuid: "root", fstype: "ext4", target: args[2] === badRoot ? "/" : badRoot }]
        })
      }
    });
    expect(result.status).toBe("failed");
    expect(result.failures).toEqual(expect.arrayContaining([{ rootId: "bad", path: ".", code: "ROOT_NOT_READY", reason: "path is not covered by a dedicated mount" }]));
    expect(calls.some((args) => args[0] === "backup" && args.at(-1) === goodRoot)).toBe(true);
    expect(calls.some((args) => args[0] === "forget")).toBe(false);
  });

  it("allows explicit init to create a repository directory that does not exist yet", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-backup-"));
    const root = path.join(tempDir, "root");
    const repo = path.join(tempDir, "nested", "repo");
    await mkdir(root);
    await mkdir(path.dirname(repo), { recursive: true });
    const password = path.join(tempDir, "password");
    await writeFile(password, "secret\n");
    db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
    ensureNasRoots(db, [{ id: "local", name: "Local", path: root }]);
    const calls: string[][] = [];
    const restic = {
      run: async (args: string[]) => {
        calls.push(args);
        return { stdout: "", stderr: "", code: 0 };
      }
    };

    await expect(initBackup({ db, config: config(root, repo, password), restic })).resolves.toBeUndefined();
    expect(calls).toEqual([["init", "--repo", repo]]);
  });

  it("serializes init with other backup operations", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-backup-"));
    const root = path.join(tempDir, "root");
    const repo = path.join(tempDir, "repo");
    await mkdir(root);
    await mkdir(repo);
    const password = path.join(tempDir, "password");
    await writeFile(password, "secret\n");
    db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
    ensureNasRoots(db, [{ id: "local", name: "Local", path: root }]);
    expect(acquireExecutionLock(db, { name: "backup", owner: "active-backup" })).toBe(true);
    const restic = { run: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })) };

    await expect(initBackup({ db, config: config(root, repo, password), restic }))
      .rejects.toThrow("backup already running");
    expect(restic.run).not.toHaveBeenCalled();
    expect(releaseExecutionLock(db, { name: "backup", owner: "active-backup" })).toBe(true);
  });

  it("does not release a replacement lease when init loses ownership", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-backup-"));
    const root = path.join(tempDir, "root");
    const repo = path.join(tempDir, "repo");
    await mkdir(root);
    await mkdir(repo);
    const password = path.join(tempDir, "password");
    await writeFile(password, "secret\n");
    db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
    ensureNasRoots(db, [{ id: "local", name: "Local", path: root }]);
    const restic = {
      run: vi.fn(async () => {
        db!.prepare("UPDATE execution_locks SET owner = ? WHERE name = 'backup'")
          .run("replacement-owner");
        return { stdout: "", stderr: "", code: 0 };
      })
    };

    await expect(initBackup({ db, config: config(root, repo, password), restic }))
      .rejects.toThrow("backup execution lease lost");
    expect(isExecutionLockOwner(db, { name: "backup", owner: "replacement-owner" })).toBe(true);
    expect(releaseExecutionLock(db, { name: "backup", owner: "replacement-owner" })).toBe(true);
  });
});
