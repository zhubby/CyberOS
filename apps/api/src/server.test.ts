import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHOTOSTAFF_SUPPORTED_EXTENSIONS, resolveZosPaths } from "@zos/shared";
import {
  appendEvent,
  createActionMessageAndJob,
  createCapabilityProposal,
  createPendingApproval,
  createDockerRegistryCredential,
  createSession,
  createUserMessageAndJob,
  ensureNasRoots,
  finishBackupRun,
  finishIndexRun,
  getDockerSettings,
  getFileOperation,
  getFileBatch,
  getJob,
  getSession,
  getShareSettings,
  getTrashEntry,
  listEvents,
  listDockerOperations,
  listDockerRegistryCredentials,
  listFileOperations,
  listMessages,
  listPendingApprovals,
  listOperationNotifications,
  listShareOperations,
  linkAgentJobToCapabilityRun,
  openZosDb,
  recordIndexFailure,
  saveDockerSettings,
  savePhotostaffLibrarySettings,
  saveShareSettings,
  startBackupRun,
  startIndexRun,
  upsertIndexedFile,
  upsertHealthAlert,
  updateJobStatus,
  updateDockerRegistryCredential,
  type DockerRegistryCredentialRecord,
  type ZosDatabase
} from "@zos/db";
import type {
  DockerComposeProjectSummary,
  DockerContainerSummary,
  DockerDaemonConfigSnapshot,
  DockerDaemonConfigUpdateInput,
  DockerDaemonConfigUpdateResult,
  DockerDaemonStatus,
  DockerImageSummary,
  DockerNetworkDetails,
  DockerOperationProposal,
  DockerResourceCapabilities,
  DockerVolumeDetails,
  ShareApplyRequest,
  ShareApplyResult,
  ShareSettingsRecord,
  ZosConfig,
  SystemEthernetApplyTransaction,
  SystemEthernetStatus,
  SystemEthernetUpdateInput,
  SystemPowerAction,
  SystemPowerResult,
  SystemWifiConnectInput,
  SystemWifiHotspotActionInput,
  SystemWifiHotspotUpdateInput,
  SystemWifiProfileUpdateInput,
  SystemWifiRadioInput,
  SystemWifiScanInput,
  SystemWifiStatus,
  SystemWifiSummary,
  BluetoothStatus,
  StorageOperationProposal
} from "@zos/shared";
import { DockerComposeService, type DockerComposeRuntime } from "./lib/docker-compose.js";
import { DockerRequestError, type DockerEngineRuntime, type DockerExecStream } from "./lib/docker-client.js";
import { DockerDaemonRequestError, type DockerDaemonRuntime } from "./lib/docker-daemon.js";
import { DockerHostAccessPolicy } from "./lib/docker-host-access.js";
import type { NetworkManagerRuntime } from "./lib/network-manager.js";
import type { BluetoothManagerRuntime } from "./lib/bluetooth-manager.js";
import { EthernetManagerRequestError, type EthernetManagerRuntime } from "./lib/ethernet-manager.js";
import { SystemPowerRequestError, type SystemPowerRuntime } from "./lib/power-management.js";
import { streamDockerDaemonEvents } from "./routes/docker.js";
import { streamBluetoothEvents, streamEthernetEvents, streamWifiEvents } from "./routes/system.js";
import type { SystemCommandRunner } from "./lib/system-management.js";
import { buildServer as buildApiServer, type ServerDependencies } from "./server.js";

const execFileAsync = promisify(execFile);
const TEST_STORAGE_POOL_ID = "/dev/md/test-pool";
const TEST_WIFI_PROFILE_ID = "12345678-1234-4123-8123-123456789abc";

let tempDir: string;
let rootDir: string;
let db: ZosDatabase;

async function buildServer(dependencies: ServerDependencies) {
  return await buildApiServer({
    ...dependencies,
    system: dependencies.system ?? { commandRunner: testStorageCommandRunner() }
  });
}

function testStorageCommandRunner(): SystemCommandRunner {
  return testStorageCommandRunnerFor(rootDir, TEST_STORAGE_POOL_ID);
}

function testStorageCommandRunnerFor(target: string, poolId = TEST_STORAGE_POOL_ID): SystemCommandRunner {
  return {
    async run(command, args) {
      if (command === "lsblk") {
        return JSON.stringify({ blockdevices: [] });
      }
      if (command === "findmnt") {
        return JSON.stringify({
          filesystems: [
            {
              source: poolId,
              target,
              fstype: "ext4",
              size: 1024,
              used: 128,
              avail: 896,
              "use%": "12.5%"
            }
          ]
        });
      }
      if (command === "mdadm" && args[0] === "--detail" && args[1] === "--scan") {
        return `ARRAY ${poolId} name=test-pool UUID=test-pool`;
      }
      if (command === "mdadm" && args[0] === "--detail") {
        return [
          "Name : test-pool",
          "Raid Level : raid1",
          "State : clean",
          "UUID : test-pool",
          "Array Size : 1024 KiB"
        ].join("\n");
      }
      if (command === "smartctl") {
        return JSON.stringify({ devices: [] });
      }
      return JSON.stringify({});
    }
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "zos-api-"));
  rootDir = path.join(tempDir, "root");
  await mkdir(rootDir);
  await writeFile(path.join(rootDir, "hello.txt"), "hello");
  db = openZosDb(path.join(tempDir, "zos.sqlite"));
  ensureNasRoots(db, [{ id: "local", name: "Local", path: rootDir }]);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("API server", () => {
  it("rate-limits repeated database requests", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const first = await server.inject({
      method: "GET",
      url: "/api/monitoring/alerts/summary"
    });

    expect(first.statusCode).toBe(200);
    const limit = Number(first.headers["x-ratelimit-limit"]);
    expect(limit).toBeGreaterThan(0);

    for (let request = 1; request < limit; request += 1) {
      const response = await server.inject({
        method: "GET",
        url: "/api/monitoring/alerts/summary"
      });
      expect(response.statusCode).toBe(200);
    }

    const blocked = await server.inject({
      method: "GET",
      url: "/api/monitoring/alerts/summary"
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("reports indexer status for configured roots", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const neverRun = await server.inject({
      method: "GET",
      url: "/api/indexer/status"
    });

    expect(neverRun.statusCode).toBe(200);
    expect(neverRun.json()).toMatchObject({
      roots: [
        {
          rootId: "local",
          status: "never_run",
          startedAt: null,
          finishedAt: null,
          scanned: 0,
          indexed: 0,
          unchanged: 0,
          removed: 0,
          skipped: 0,
          failed: 0,
          failures: []
        }
      ]
    });
    expect(neverRun.json()).toMatchObject({
      service: { status: "unavailable" },
      watcher: { status: "starting" },
      queue: { queued: 0, stalled: false },
      rebuild: { status: "legacy" }
    });

    const run = startIndexRun(db, { rootId: "local" });
    finishIndexRun(db, {
      runId: run.id,
      status: "completed",
      scanned: 4,
      indexed: 1,
      unchanged: 3,
      removed: 0,
      skipped: 0,
      failed: 0
    });
    const completed = await server.inject({
      method: "GET",
      url: "/api/indexer/status?rootId=local"
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      roots: [{ rootId: "local", status: "completed", scanned: 4, unchanged: 3 }]
    });

    const failedRun = startIndexRun(db, { rootId: "local" });
    recordIndexFailure(db, {
      runId: failedRun.id,
      path: "docs/private.txt",
      reason: "permission denied"
    });
    finishIndexRun(db, {
      runId: failedRun.id,
      status: "failed",
      scanned: 1,
      indexed: 0,
      unchanged: 0,
      removed: 0,
      skipped: 0,
      failed: 1,
      error: "one or more files failed"
    });
    const failed = await server.inject({
      method: "GET",
      url: "/api/indexer/status?rootId=local"
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({
      roots: [
        {
          rootId: "local",
          status: "failed",
          failed: 1,
          failures: [{ path: "docs/private.txt", reason: "permission denied" }]
        }
      ]
    });

    const missing = await server.inject({
      method: "GET",
      url: "/api/indexer/status?rootId=missing"
    });
    expect(missing.statusCode).toBe(404);
    await server.close();
  });

  it("validates indexer settings and persists OCR root selection", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });

    const defaults = await server.inject({ method: "GET", url: "/api/settings/indexer" });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().settings).toMatchObject({
      scanConcurrency: 4,
      extractionConcurrency: 2,
      reconciliationIntervalMs: 30 * 60 * 1_000,
      ocrRootIds: []
    });

    const saved = await server.inject({
      method: "PATCH",
      url: "/api/settings/indexer",
      payload: { scanConcurrency: 6, extractionConcurrency: 3, ocrRootIds: ["local"] }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings).toMatchObject({
      scanConcurrency: 6,
      extractionConcurrency: 3,
      ocrRootIds: ["local"]
    });

    const invalidLimit = await server.inject({
      method: "PATCH",
      url: "/api/settings/indexer",
      payload: { scanConcurrency: 0 }
    });
    const invalidRoot = await server.inject({
      method: "PATCH",
      url: "/api/settings/indexer",
      payload: { ocrRootIds: ["missing"] }
    });
    expect(invalidLimit.statusCode).toBe(400);
    expect(invalidRoot.statusCode).toBe(400);
    await server.close();
  });

  it("queues safe root and path-level manual reindex requests", async () => {
    await mkdir(path.join(rootDir, "docs"));
    const server = await buildServer({ config: testConfig(tempDir), db });

    const pathRequest = await server.inject({
      method: "POST",
      url: "/api/indexer/reindex",
      payload: { rootId: "local", path: "docs", recursive: true }
    });
    expect(pathRequest.statusCode).toBe(202);
    expect(db.prepare(`
      SELECT root_id, path, recursive, kind, priority, status
      FROM index_queue WHERE id = ?
    `).get(pathRequest.json().task.id)).toEqual({
      root_id: "local",
      path: "docs",
      recursive: 1,
      kind: "manual",
      priority: 100,
      status: "queued"
    });

    const rootRequest = await server.inject({
      method: "POST",
      url: "/api/indexer/reindex",
      payload: { rootId: "local" }
    });
    const traversal = await server.inject({
      method: "POST",
      url: "/api/indexer/reindex",
      payload: { rootId: "local", path: "../outside" }
    });
    const missingRoot = await server.inject({
      method: "POST",
      url: "/api/indexer/reindex",
      payload: { rootId: "missing" }
    });
    expect(rootRequest.statusCode).toBe(202);
    expect(rootRequest.json().task).toMatchObject({ status: "queued" });
    expect(traversal.statusCode).toBe(400);
    expect(missingRoot.statusCode).toBe(404);
    await server.close();
  });

  it("exposes P0 readiness, backup, and aggregate health as read-only status", async () => {
    const repositoryPath = path.join(tempDir, "backup-repository");
    const passwordFile = path.join(tempDir, "restic-password");
    await mkdir(repositoryPath);
    await writeFile(passwordFile, "test-secret\n");
    upsertHealthAlert(db, {
      code: "backup_failed",
      severity: "critical",
      details: "latest backup failed"
    });
    const failedBackup = startBackupRun(db, {
      kind: "daily",
      now: new Date(Date.now() - 60_000)
    });
    finishBackupRun(db, {
      runId: failedBackup.id,
      status: "failed",
      error: "latest backup failed",
      finishedAt: new Date(Date.now() - 59_000)
    });
    const config = {
      ...testConfig(tempDir),
      environment: "development" as const,
      backup: {
        enabled: true,
        repositoryPath,
        passwordFile,
        stagingPath: path.join(tempDir, "backup-staging"),
        requireMount: false,
        retryCount: 1,
        timeoutMs: 1_000,
        keepDaily: 7,
        keepWeekly: 4
      }
    };
    const server = await buildServer({ config, db });

    const readiness = await server.inject({ method: "GET", url: "/api/roots/readiness" });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({
      roots: [{ rootId: "local", status: "unknown", reason: "never checked" }]
    });

    const backup = await server.inject({ method: "GET", url: "/api/backup/status" });
    expect(backup.statusCode).toBe(200);
    expect(backup.json()).toMatchObject({
      enabled: true,
      repositoryConfigured: true,
      repositoryAvailable: true,
      passwordConfigured: true,
      alerts: [{ code: "backup_failed", severity: "critical" }]
    });
    expect(JSON.stringify(backup.json())).not.toContain("test-secret");

    const health = await server.inject({ method: "GET", url: "/api/system/health" });
    expect(health.statusCode).toBe(200);
    const healthBody = health.json();
    expect(healthBody).toMatchObject({
      status: "failed",
      roots: [{ rootId: "local", status: "unknown" }],
      downloader: {
        status: "unavailable",
        freshWorkers: 0,
        activeTasks: 0,
        queuedTasks: 0
      },
      photostaff: {
        status: "unavailable",
        freshWorkers: 0,
        activeJobs: 0,
        queuedJobs: 0,
        retryingJobs: 0
      },
      vodPlayer: { status: "disabled", state: null, errorCode: "VOD_PLAYER_DISABLED" }
    });
    expect(healthBody.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "backup_failed", severity: "critical" }),
        expect.objectContaining({ code: "downloader_unavailable", severity: "warning" }),
        expect.objectContaining({ code: "photostaff_unavailable", severity: "warning" })
      ])
    );

    const unknownRoot = await server.inject({ method: "GET", url: "/api/roots/readiness?rootId=missing" });
    expect(unknownRoot.statusCode).toBe(404);
    await server.close();
  });

  it("does not report a configured backup password when the file is missing", async () => {
    const repositoryPath = path.join(tempDir, "backup-repository");
    await mkdir(repositoryPath);
    const config = {
      ...testConfig(tempDir),
      backup: {
        enabled: false,
        repositoryPath,
        passwordFile: path.join(tempDir, "missing-restic-password"),
        stagingPath: path.join(tempDir, "backup-staging"),
        requireMount: false,
        retryCount: 1,
        timeoutMs: 1_000,
        keepDaily: 7,
        keepWeekly: 4
      }
    };
    const server = await buildServer({ config, db });

    const response = await server.inject({ method: "GET", url: "/api/backup/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: false,
      repositoryConfigured: true,
      repositoryAvailable: true,
      passwordConfigured: false
    });
    await server.close();
  });

  it("does not allow cross-origin access by default", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: "/api/roots",
      headers: {
        origin: "https://example.test"
      }
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await server.close();
  });

  it("lists files from a configured NAS root", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=.`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      git: null,
      entries: [
        {
          name: "hello.txt",
          kind: "file",
          isSafe: true
        }
      ]
    });

    await server.close();
  });

  it("requires a mounted storage pool and matching NAS root for file access", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });

    const missingPool = await server.inject({
      method: "GET",
      url: "/api/files?rootId=local&path=."
    });
    const unknownPool = await server.inject({
      method: "GET",
      url: "/api/files?rootId=local&storagePoolId=missing&path=."
    });

    const baseRunner = testStorageCommandRunner();
    const unmountedServer = await buildServer({
      config: testConfig(tempDir),
      db,
      system: {
        commandRunner: {
          async run(command, args) {
            if (command === "findmnt") {
              return JSON.stringify({ filesystems: [] });
            }
            return await baseRunner.run(command, args);
          }
        }
      }
    });
    const unmountedPool = await unmountedServer.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=.`
    });
    await unmountedServer.close();

    const otherRoot = path.join(tempDir, "other-root");
    await mkdir(otherRoot);
    ensureNasRoots(db, [{ id: "other", name: "Other", path: otherRoot }]);
    const mismatchedRoot = await server.inject({
      method: "GET",
      url: `/api/files?rootId=other&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=.`
    });

    expect(missingPool.statusCode).toBe(400);
    expect(unknownPool.statusCode).toBe(404);
    expect(unmountedPool.statusCode).toBe(404);
    expect(mismatchedRoot.statusCode).toBe(403);
    await server.close();
  });

  it("isolates listings and mutations to the selected storage pool", async () => {
    const poolDir = path.join(rootDir, "pool");
    await mkdir(poolDir);
    await writeFile(path.join(poolDir, "inside.txt"), "inside");
    await writeFile(path.join(rootDir, "outside.txt"), "outside");
    await symlink(path.join(rootDir, "outside.txt"), path.join(poolDir, "escape.txt"));
    await writeFile(path.join(rootDir, "outside-index.txt"), "match outside");
    upsertIndexedFile(db, {
      rootId: "local",
      path: "pool/../outside-index.txt",
      name: "outside-index.txt",
      mimeType: "text/plain",
      sizeBytes: 14,
      mtimeMs: Date.now(),
      hash: "outside-index",
      body: "match outside"
    });
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner: testStorageCommandRunnerFor(poolDir) }
    });

    const listing = await server.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=pool`
    });
    const traversal = await server.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=pool/../outside.txt`
    });
    const absolute = await server.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=${encodeURIComponent(path.join(rootDir, "outside.txt"))}`
    });
    const symlinkEscape = await server.inject({
      method: "GET",
      url: `/api/files/meta?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=pool/escape.txt`
    });
    const session = createSession(db, { rootId: "local" });
    const crossPoolProposal = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        sessionId: session.id,
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "copy",
        sourcePath: "pool/inside.txt",
        targetPath: "outside.txt"
      }
    });
    const scopedSearch = await server.inject({
      method: "GET",
      url: `/api/search?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=pool&q=match`
    });
    const scopedAdvancedSearch = await server.inject({
      method: "POST",
      url: "/api/search",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        path: "pool",
        query: "match"
      }
    });

    expect(listing.statusCode).toBe(200);
    expect(listing.json().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "inside.txt", path: "pool/inside.txt", isSafe: true }),
        expect.objectContaining({ name: "escape.txt", path: "pool/escape.txt", isSafe: false })
      ])
    );
    expect(traversal.statusCode).toBe(400);
    expect(absolute.statusCode).toBe(400);
    expect(symlinkEscape.statusCode).toBe(403);
    expect(crossPoolProposal.statusCode).toBe(403);
    expect(scopedSearch.statusCode).toBe(200);
    expect(scopedSearch.json().files).toEqual([]);
    expect(scopedAdvancedSearch.statusCode).toBe(200);
    expect(scopedAdvancedSearch.json().files).toEqual([]);
    await server.close();
  });

  it("does not cross into a nested mounted storage pool", async () => {
    const parentDir = path.join(rootDir, "parent");
    const childDir = path.join(parentDir, "child");
    await mkdir(childDir, { recursive: true });
    await writeFile(path.join(parentDir, "parent.txt"), "parent");
    await writeFile(path.join(childDir, "child.txt"), "child");

    const parentPoolId = "/dev/md/parent-pool";
    const childPoolId = "/dev/md/child-pool";
    const nestedRunner: SystemCommandRunner = {
      async run(command, args) {
        if (command === "lsblk") {
          return JSON.stringify({ blockdevices: [] });
        }
        if (command === "findmnt") {
          return JSON.stringify({
            filesystems: [
              { source: parentPoolId, target: parentDir, fstype: "ext4", size: 1024, used: 1, avail: 1023, "use%": "0.1%" },
              { source: childPoolId, target: childDir, fstype: "btrfs", size: 512, used: 1, avail: 511, "use%": "0.2%" }
            ]
          });
        }
        if (command === "mdadm" && args[0] === "--detail" && args[1] === "--scan") {
          return `ARRAY ${parentPoolId} name=parent-pool UUID=parent\nARRAY ${childPoolId} name=child-pool UUID=child`;
        }
        if (command === "mdadm" && args[0] === "--detail") {
          const isChild = args[1] === childPoolId;
          return [
            `Name : ${isChild ? "child-pool" : "parent-pool"}`,
            "Raid Level : raid1",
            "State : clean",
            `UUID : ${isChild ? "child" : "parent"}`,
            "Array Size : 1024 KiB"
          ].join("\n");
        }
        if (command === "smartctl") {
          return JSON.stringify({ devices: [] });
        }
        return JSON.stringify({});
      }
    };
    const server = await buildServer({ config: testConfig(tempDir), db, system: { commandRunner: nestedRunner } });

    const parentListing = await server.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(parentPoolId)}&path=parent`
    });
    const parentSearch = await server.inject({
      method: "GET",
      url: `/api/search?rootId=local&storagePoolId=${encodeURIComponent(parentPoolId)}&path=parent&q=child`
    });
    const childListing = await server.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(childPoolId)}&path=parent/child`
    });

    expect(parentListing.statusCode).toBe(200);
    expect(parentListing.json().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "parent.txt", isSafe: true }),
        expect.objectContaining({ name: "child", isSafe: false })
      ])
    );
    expect(parentSearch.statusCode).toBe(200);
    expect(parentSearch.json().files).toEqual([]);
    expect(childListing.statusCode).toBe(200);
    expect(childListing.json().entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "child.txt", isSafe: true })])
    );
    await server.close();
  });

  it("rechecks storage pool boundaries during rollback and trash restore", async () => {
    const poolDir = path.join(rootDir, "pool");
    const alternateMount = path.join(rootDir, "alternate");
    await mkdir(poolDir);
    await mkdir(alternateMount);
    await writeFile(path.join(poolDir, "rollback.txt"), "rollback");
    let mountpoint = poolDir;
    const commandRunner: SystemCommandRunner = {
      ...testStorageCommandRunnerFor(poolDir),
      async run(command, args) {
        if (command === "findmnt") {
          return JSON.stringify({
            filesystems: [
              {
                source: TEST_STORAGE_POOL_ID,
                target: mountpoint,
                fstype: "ext4",
                size: 1024,
                used: 128,
                avail: 896,
                "use%": "12.5%"
              }
            ]
          });
        }
        return await testStorageCommandRunnerFor(poolDir).run(command, args);
      }
    };
    const server = await buildServer({ config: testConfig(tempDir), db, system: { commandRunner } });

    const upload = await server.inject({
      method: "PUT",
      url: `/api/files/upload?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=pool/rollback-upload.txt`,
      headers: { "content-type": "application/octet-stream" },
      payload: "uploaded"
    });
    expect(upload.statusCode).toBe(201);

    mountpoint = alternateMount;
    const rollback = await server.inject({
      method: "POST",
      url: `/api/operations/${upload.json().operation.id}/rollback`
    });
    expect(rollback.statusCode).toBe(403);
    await expect(readFile(path.join(poolDir, "rollback-upload.txt"), "utf8")).resolves.toBe("uploaded");

    mountpoint = poolDir;
    const applied = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "trash",
        sourcePath: "pool/rollback.txt"
      }
    });
    expect(applied.statusCode).toBe(201);
    const trashEntryId = applied.json().operation.metadata.trashEntryId as string;
    expect(getTrashEntry(db, trashEntryId)?.metadata.storagePoolId).toBe(TEST_STORAGE_POOL_ID);

    mountpoint = alternateMount;
    const restore = await server.inject({
      method: "POST",
      url: `/api/trash/${trashEntryId}/restore`
    });
    expect(restore.statusCode).toBe(403);
    await server.close();
  });

  it("lists Git status for files inside a repository", async () => {
    await git(["init", "-b", "main"]);
    await writeFile(path.join(rootDir, "clean.txt"), "clean");
    await writeFile(path.join(rootDir, "tracked.txt"), "tracked");
    await git(["add", "."]);
    await gitCommit("initial");
    await writeFile(path.join(rootDir, "tracked.txt"), "changed");
    await writeFile(path.join(rootDir, "new.txt"), "new");

    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=.`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      git: {
        repositoryName: "root",
        repositoryPath: ".",
        currentPath: ".",
        branch: "main",
        dirty: true,
        summary: {
          modified: 1,
          untracked: 1
        }
      },
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: "clean.txt",
          gitStatus: "tracked"
        }),
        expect.objectContaining({
          name: "tracked.txt",
          gitStatus: "modified"
        }),
        expect.objectContaining({
          name: "new.txt",
          gitStatus: "untracked"
        })
      ])
    });

    await server.close();
  });

  it("returns Git status for search results inside a repository", async () => {
    await git(["init", "-b", "main"]);
    await writeFile(path.join(rootDir, "tracked-match.txt"), "tracked");
    await git(["add", "."]);
    await gitCommit("initial");
    await writeFile(path.join(rootDir, "tracked-match.txt"), "changed");

    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/search?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=.&q=match`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      git: {
        repositoryName: "root",
        branch: "main",
        dirty: true,
        summary: {
          modified: 1
        }
      },
      files: [
        expect.objectContaining({
          name: "tracked-match.txt",
          gitStatus: "modified"
        })
      ]
    });

    await server.close();
  });

  it("keeps file listing available when Git metadata is invalid", async () => {
    await mkdir(path.join(rootDir, "broken"));
    await writeFile(path.join(rootDir, "broken", ".git"), "gitdir: /missing/zos/repo");
    await writeFile(path.join(rootDir, "broken", "visible.txt"), "visible");
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=broken`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      git: null,
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: ".git"
        }),
        expect.objectContaining({
          name: "visible.txt"
        })
      ])
    });

    await server.close();
  });

  it("keeps file listing available when Git status times out", async () => {
    await mkdir(path.join(rootDir, ".git"));
    await writeFile(path.join(rootDir, "visible.txt"), "visible");
    const fakeBinPath = path.join(tempDir, "fake-bin");
    await mkdir(fakeBinPath);
    const fakeGitPath = path.join(fakeBinPath, "git");
    await writeFile(fakeGitPath, `#!/bin/sh\nexec "${process.execPath}" -e "setTimeout(() => {}, 10000)"\n`);
    await chmod(fakeGitPath, 0o755);

    const originalPath = process.env.PATH;
    const server = await buildServer({ config: testConfig(tempDir), db });
    try {
      process.env.PATH = fakeBinPath;
      const response = await server.inject({
        method: "GET",
        url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=.`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        git: null,
        entries: expect.arrayContaining([
          expect.objectContaining({
            name: "visible.txt"
          })
        ])
      });
    } finally {
      process.env.PATH = originalPath;
      await server.close();
    }
  });

  it("reports missing file paths without leaking an internal error", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=missing`
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Path not found" });

    await server.close();
  });

  it("exposes a user home shortcut path for roots that contain it", async () => {
    const systemRoot = path.parse(os.homedir()).root;
    ensureNasRoots(db, [{ id: "local", name: "System root", path: systemRoot }]);
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: "/api/roots"
    });
    const [rootRealPath, homeRealPath] = await Promise.all([realpath(systemRoot), realpath(os.homedir())]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      roots: [
        {
          id: "local",
          name: "System root",
          path: systemRoot,
          homePath: path.relative(rootRealPath, homeRealPath) || "."
        }
      ]
    });

    await server.close();
  });

  it("returns default model provider settings without exposing secrets", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: "/api/settings/model-provider"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      settings: {
        providerName: "openai",
        baseUrl: null,
        model: "",
        apiKeyConfigured: false
      }
    });
    expect(response.payload).not.toContain("\"apiKey\":\"");
    await server.close();
  });

  it("returns detailed system information without exposing environment values", async () => {
    process.env.ZOS_TEST_SECRET = "do-not-leak-from-system-info";
    const server = await buildServer({ config: testConfig(tempDir), db });
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/settings/system-info"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        info: {
          identity: {
            hostname: expect.any(String),
            adminDisplayName: "Test Admin",
            authMode: "local-only"
          },
          operatingSystem: {
            platform: expect.any(String),
            arch: expect.any(String)
          },
          hardware: {
            cpuThreads: expect.any(Number),
            memory: {
              totalBytes: expect.any(Number)
            }
          },
          zos: {
            dataDir: tempDir,
            databasePath: path.join(tempDir, "zos.sqlite"),
            photostaff: {
              dataDir: path.join(tempDir, "photostaff"),
              maxFileSizeBytes: 512 * 1024 * 1024,
              thumbnailSizePx: 512,
              previewMaxEdgePx: 2048,
              supportedExtensions: [...PHOTOSTAFF_SUPPORTED_EXTENSIONS]
            },
            nasRoots: [{ id: "local", name: "Local", path: rootDir }]
          }
        }
      });
      expect(response.json().info.storage.volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "data-dir" }),
          expect.objectContaining({ id: "database" }),
          expect.objectContaining({ id: "nas-root-local", rootId: "local" })
        ])
      );
      expect(response.json().info.hardware.cpuThreads).toBeGreaterThan(0);
      expect(response.json().info.hardware.memory.totalBytes).toBeGreaterThan(0);
      expect(response.payload).not.toContain("do-not-leak-from-system-info");
    } finally {
      delete process.env.ZOS_TEST_SECRET;
      await server.close();
    }
  });

  it("returns immutable public build information for deployment traceability", async () => {
    process.env.ZOS_TEST_SECRET = "do-not-leak-from-build-info";
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      buildInfo: {
        version: "0.2.0",
        commitSha: "abcdef0123456789",
        commitShortSha: "abcdef012345",
        tag: "v0.2.0",
        branch: "main",
        builtAt: "2026-09-14T00:00:00.000Z",
        source: "release",
        dirty: false
      }
    });
    try {
      const response = await server.inject({ method: "GET", url: "/api/system/build-info" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        build: {
          version: "0.2.0",
          commitSha: "abcdef0123456789",
          commitShortSha: "abcdef012345",
          tag: "v0.2.0",
          branch: "main",
          builtAt: "2026-09-14T00:00:00.000Z",
          source: "release",
          dirty: false
        }
      });
      expect(response.payload).not.toContain("do-not-leak-from-build-info");
    } finally {
      delete process.env.ZOS_TEST_SECRET;
      await server.close();
    }
  });

  it("requires confirmation and a supported action before requesting a system power transition", async () => {
    const power = new FakeSystemPowerRuntime();
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner: testStorageCommandRunner(), power }
    });

    const unconfirmed = await server.inject({
      method: "POST",
      url: "/api/system/power",
      payload: { action: "reboot", confirmed: false }
    });
    const unsupported = await server.inject({
      method: "POST",
      url: "/api/system/power",
      payload: { action: "hibernate", confirmed: true }
    });
    const reboot = await server.inject({
      method: "POST",
      url: "/api/system/power",
      payload: { action: "reboot", confirmed: true }
    });

    expect(unconfirmed.statusCode).toBe(400);
    expect(unsupported.statusCode).toBe(400);
    expect(reboot.statusCode).toBe(202);
    expect(reboot.json()).toEqual({ result: { action: "reboot", accepted: true } });
    expect(power.actions).toEqual(["reboot"]);
    await server.close();
  });

  it("preserves safe power service failures", async () => {
    const power = new FakeSystemPowerRuntime();
    power.error = new SystemPowerRequestError("hostd is unavailable", 503);
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner: testStorageCommandRunner(), power }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/system/power",
      payload: { action: "shutdown", confirmed: true }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "hostd is unavailable" });
    expect(power.actions).toEqual(["shutdown"]);
    await server.close();
  });

  it("returns read-only network management summary from host commands", async () => {
    const commandRunner = new FakeSystemCommandRunner({
      "ip -j link": JSON.stringify([
        {
          ifindex: 1,
          ifname: "lo",
          flags: ["LOOPBACK", "UP", "LOWER_UP"],
          mtu: 65536,
          operstate: "UNKNOWN",
          link_type: "loopback",
          address: "00:00:00:00:00:00"
        },
        {
          ifindex: 2,
          ifname: "enp1s0",
          flags: ["BROADCAST", "MULTICAST", "UP", "LOWER_UP"],
          mtu: 1500,
          operstate: "UP",
          link_type: "ether",
          address: "52:54:00:12:34:56"
        }
      ]),
      "ip -j addr": JSON.stringify([
        {
          ifname: "lo",
          addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8, scope: "host", label: "lo" }]
        },
        {
          ifname: "enp1s0",
          addr_info: [
            { family: "inet", local: "192.168.50.10", prefixlen: 24, scope: "global", label: "enp1s0" },
            { family: "inet6", local: "fe80::5054", prefixlen: 64, scope: "link", label: "enp1s0" }
          ]
        }
      ]),
      "ip -j route": JSON.stringify([
        { dst: "default", gateway: "192.168.50.1", dev: "enp1s0", protocol: "dhcp" },
        { dst: "192.168.50.0/24", dev: "enp1s0", prefsrc: "192.168.50.10", scope: "link" }
      ]),
      "systemctl is-active systemd-networkd.service": "active\n"
    });
    const server = await buildServer({ config: testConfig(tempDir), db, system: { commandRunner } });
    const response = await server.inject({
      method: "GET",
      url: "/api/system/network"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      network: {
        status: "ready",
        capabilities: {
          backend: "systemd-networkd",
          canApplyConfiguration: false
        },
        metrics: {
          interfaces: 2,
          connected: 2,
          addresses: 3,
          defaultRoutes: 1
        },
        interfaces: expect.arrayContaining([
          expect.objectContaining({
            name: "enp1s0",
            kind: "ethernet",
            state: "connected",
            mac: "52:54:00:12:34:56",
            mtu: 1500,
            hasDefaultRoute: true,
            addresses: expect.arrayContaining([
              expect.objectContaining({ family: "inet", cidr: "192.168.50.10/24" })
            ])
          })
        ]),
        routes: expect.arrayContaining([
          expect.objectContaining({ destination: "default", gateway: "192.168.50.1", device: "enp1s0" })
        ]),
        issues: []
      }
    });
    await server.close();
  });

  it("returns unavailable network summary when ip command collection fails", async () => {
    const commandRunner = new FakeSystemCommandRunner({});
    const server = await buildServer({ config: testConfig(tempDir), db, system: { commandRunner } });
    const response = await server.inject({
      method: "GET",
      url: "/api/system/network"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      network: {
        status: "unavailable",
        metrics: {
          interfaces: 0,
          connected: 0,
          addresses: 0,
          defaultRoutes: 0
        },
        interfaces: [],
        routes: []
      }
    });
    expect(response.json().network.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "network links" }),
        expect.objectContaining({ source: "network addresses" }),
        expect.objectContaining({ source: "network routes" })
      ])
    );
    await server.close();
  });

  it("reports carrier without an address as up instead of connected", async () => {
    const commandRunner = new FakeSystemCommandRunner({
      "ip -j link": JSON.stringify([{
        ifindex: 2,
        ifname: "eth0",
        flags: ["BROADCAST", "MULTICAST", "UP", "LOWER_UP"],
        mtu: 1500,
        operstate: "UP",
        link_type: "ether",
        address: "2c:cf:67:c9:68:07"
      }]),
      "ip -j addr": JSON.stringify([{ ifname: "eth0", addr_info: [] }]),
      "ip -j route": "[]",
      "systemctl is-active systemd-networkd.service": "active\n"
    });
    const server = await buildServer({ config: testConfig(tempDir), db, system: { commandRunner } });
    const response = await server.inject({ method: "GET", url: "/api/system/network" });

    expect(response.statusCode).toBe(200);
    expect(response.json().network.interfaces).toEqual([expect.objectContaining({ name: "eth0", state: "up", addresses: [] })]);
    expect(response.json().network.metrics.connected).toBe(0);
    await server.close();
  });

  it("keeps interface data when the Wi-Fi summary fails", async () => {
    const commandRunner = new FakeSystemCommandRunner({
      "ip -j link": JSON.stringify([
        {
          ifindex: 2,
          ifname: "eth0",
          flags: ["BROADCAST", "MULTICAST", "UP", "LOWER_UP"],
          mtu: 1500,
          operstate: "UP",
          link_type: "ether",
          address: "52:54:00:12:34:56"
        }
      ]),
      "ip -j addr": JSON.stringify([
        {
          ifname: "eth0",
          addr_info: [{ family: "inet", local: "192.168.11.91", prefixlen: 24, scope: "global", label: "eth0" }]
        }
      ]),
      "ip -j route": JSON.stringify([
        { dst: "default", gateway: "192.168.11.1", dev: "eth0", protocol: "dhcp" }
      ])
    });
    const networkManager = new FakeNetworkManager();
    networkManager.summaryError = new Error("nmcli failed: password=do-not-leak");
    const ethernetManager = new FakeEthernetManager();
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner, networkManager, ethernetManager }
    });

    const response = await server.inject({ method: "GET", url: "/api/system/network" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      network: {
        status: "partial",
        interfaces: [expect.objectContaining({ name: "eth0", state: "connected" })],
        ethernet: { backend: "NetworkManager", hostdReady: true },
        wifi: { backend: "unknown", hostdReady: false, devices: [] },
        capabilities: {
          backend: "NetworkManager",
          hostdReady: true,
          canApplyConfiguration: true,
          canManageEthernet: false
        },
        issues: [expect.objectContaining({ source: "Wi-Fi status" })]
      }
    });
    expect(response.body).not.toContain("do-not-leak");
    await server.close();
  });

  it("returns lightweight per-interface network traffic counters", async () => {
    const commandRunner = new FakeSystemCommandRunner({
      "cat /proc/net/dev": [
        "Inter-|   Receive                                                |  Transmit",
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
        "    lo: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0",
        " enp1s0: 987654 42 0 0 0 0 0 1 456789 31 0 0 0 0 0 0"
      ].join("\n")
    });
    const server = await buildServer({ config: testConfig(tempDir), db, system: { commandRunner } });
    const response = await server.inject({ method: "GET", url: "/api/system/network/traffic" });

    expect(response.statusCode).toBe(200);
    expect(response.json().traffic).toMatchObject({
      interfaces: [
        { id: "lo", name: "lo", rxBytes: 1000, txBytes: 2000 },
        { id: "enp1s0", name: "enp1s0", rxBytes: 987654, txBytes: 456789 }
      ]
    });
    expect(response.json().traffic.collectedAt).toEqual(expect.any(String));
    await server.close();
  });

  it("scans and connects Wi-Fi while enforcing management-path confirmation", async () => {
    const networkManager = new FakeNetworkManager();
    networkManager.status.devices[0]!.managementPath = true;
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner: new FakeSystemCommandRunner({}), networkManager }
    });

    const scan = await server.inject({
      method: "POST",
      url: "/api/system/network/wifi/scan",
      payload: { device: "wlan0" }
    });
    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({ scan: { device: "wlan0", accessPoints: [{ ssid: "Home" }] } });

    const unsafeConnect = await server.inject({
      method: "POST",
      url: "/api/system/network/wifi/connect",
      payload: { device: "wlan0", profileId: TEST_WIFI_PROFILE_ID, confirmed: false }
    });
    expect(unsafeConnect.statusCode).toBe(400);
    expect(networkManager.connectCalls).toHaveLength(0);

    const confirmedConnect = await server.inject({
      method: "POST",
      url: "/api/system/network/wifi/connect",
      payload: { device: "wlan0", profileId: TEST_WIFI_PROFILE_ID, confirmed: true }
    });
    expect(confirmedConnect.statusCode).toBe(200);
    expect(networkManager.connectCalls).toHaveLength(1);
    await server.close();
  });

  it("requires confirmation for Wi-Fi deletion and dispatches hotspot actions", async () => {
    const networkManager = new FakeNetworkManager();
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner: new FakeSystemCommandRunner({}), networkManager }
    });

    const unconfirmedDelete = await server.inject({
      method: "DELETE",
      url: `/api/system/network/wifi/profiles/${TEST_WIFI_PROFILE_ID}`,
      payload: { confirmed: false }
    });
    expect(unconfirmedDelete.statusCode).toBe(400);

    const confirmedDelete = await server.inject({
      method: "DELETE",
      url: `/api/system/network/wifi/profiles/${TEST_WIFI_PROFILE_ID}`,
      payload: { confirmed: true }
    });
    expect(confirmedDelete.statusCode).toBe(200);
    expect(networkManager.deletedProfiles).toEqual([TEST_WIFI_PROFILE_ID]);

    const hotspot = await server.inject({
      method: "POST",
      url: "/api/system/network/wifi/hotspot/start",
      payload: { device: "wlan0", confirmed: true }
    });
    expect(hotspot.statusCode).toBe(200);
    expect(networkManager.hotspotActions).toEqual(["start:wlan0"]);
    await server.close();
  });

  it("streams initial and changed Wi-Fi states, heartbeats, and stops on close", async () => {
    vi.useFakeTimers();
    try {
      const networkManager = new FakeNetworkManager();
      const closeSignal = new EventEmitter();
      const chunks: string[] = [];
      await streamWifiEvents(
        closeSignal,
        { write: (chunk) => chunks.push(chunk) },
        networkManager,
        { sampleMs: 100, heartbeatMs: 250 }
      );

      expect(chunks.join("")).toContain("retry: 2000");
      expect(chunks.join("")).toContain('"backend":"NetworkManager"');
      expect(chunks.filter((chunk) => chunk === "event: system.wifi.status\n")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(chunks.filter((chunk) => chunk === "event: system.wifi.status\n")).toHaveLength(1);
      networkManager.status.radioEnabled = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(chunks.filter((chunk) => chunk === "event: system.wifi.status\n")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(chunks).toContain(": heartbeat\n\n");

      const callsAtClose = networkManager.statusCalls;
      closeSignal.emit("close");
      await vi.advanceTimersByTimeAsync(500);
      expect(networkManager.statusCalls).toBe(callsAtClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves Bluetooth state and dispatches adapter and device operations", async () => {
    const bluetoothManager = new FakeBluetoothManager();
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner: new FakeSystemCommandRunner({}), bluetoothManager }
    });

    const status = await server.inject({ method: "GET", url: "/api/system/bluetooth" });
    const scan = await server.inject({ method: "POST", url: "/api/system/bluetooth/scan/start", payload: { adapterId: "adapter-hci0" } });
    const trust = await server.inject({ method: "PUT", url: "/api/system/bluetooth/devices/trust", payload: { adapterId: "adapter-hci0", address: "AA:BB:CC:DD:EE:FF", trusted: true } });
    const connect = await server.inject({ method: "POST", url: "/api/system/bluetooth/devices/connect", payload: { adapterId: "adapter-hci0", address: "AA:BB:CC:DD:EE:FF" } });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ bluetooth: { backend: "BlueZ", available: true } });
    expect(scan.statusCode).toBe(200);
    expect(trust.statusCode).toBe(200);
    expect(connect.statusCode).toBe(200);
    expect(bluetoothManager.calls).toEqual(["scan:adapter-hci0", "trust:AA:BB:CC:DD:EE:FF:true", "connect:AA:BB:CC:DD:EE:FF"]);
    await server.close();
  });

  it("streams changed Bluetooth state without duplicating unchanged samples", async () => {
    vi.useFakeTimers();
    try {
      const bluetoothManager = new FakeBluetoothManager();
      const closeSignal = new EventEmitter();
      const chunks: string[] = [];
      await streamBluetoothEvents(closeSignal, { write: (chunk) => chunks.push(chunk) }, bluetoothManager, { sampleMs: 100, heartbeatMs: 250 });
      expect(chunks.filter((chunk) => chunk === "event: system.bluetooth.status\n")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(chunks.filter((chunk) => chunk === "event: system.bluetooth.status\n")).toHaveLength(1);
      bluetoothManager.status.adapters[0]!.powered = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(chunks.filter((chunk) => chunk === "event: system.bluetooth.status\n")).toHaveLength(2);
      closeSignal.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves Ethernet status and the save/apply/confirm/rollback lifecycle", async () => {
    const ethernetManager = new FakeEthernetManager();
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner: new FakeSystemCommandRunner({}), ethernetManager }
    });

    const status = await server.inject({ method: "GET", url: "/api/system/network/ethernet" });
    const saved = await server.inject({
      method: "PUT",
      url: "/api/system/network/ethernet/2ccf67c96807",
      payload: { config: testEthernetConfig(), expectedRevision: "a".repeat(64) }
    });
    const unconfirmed = await server.inject({ method: "POST", url: "/api/system/network/ethernet/apply", payload: { confirmed: false } });
    const applied = await server.inject({ method: "POST", url: "/api/system/network/ethernet/apply", payload: { confirmed: true } });
    const transactionId = applied.json().transaction.id as string;
    const confirmed = await server.inject({ method: "POST", url: `/api/system/network/ethernet/apply/${transactionId}/confirm` });
    const rolledBack = await server.inject({ method: "POST", url: `/api/system/network/ethernet/apply/${transactionId}/rollback` });

    expect(status.statusCode).toBe(200);
    expect(saved.statusCode).toBe(200);
    expect(unconfirmed.statusCode).toBe(400);
    expect(applied.statusCode).toBe(202);
    expect(confirmed.json().transaction.status).toBe("confirmed");
    expect(rolledBack.json().transaction.status).toBe("rolled_back");
    expect(ethernetManager.saved).toEqual(["2ccf67c96807"]);
    await server.close();
  });

  it("streams changed Ethernet states, heartbeats, and stops on close", async () => {
    vi.useFakeTimers();
    try {
      const ethernetManager = new FakeEthernetManager();
      const closeSignal = new EventEmitter();
      const chunks: string[] = [];
      await streamEthernetEvents(closeSignal, { write: (chunk) => chunks.push(chunk) }, ethernetManager, { sampleMs: 100, heartbeatMs: 250 });

      expect(chunks.join("")).toContain("retry: 2000");
      expect(chunks.filter((chunk) => chunk === "event: system.ethernet.status\n")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(chunks.filter((chunk) => chunk === "event: system.ethernet.status\n")).toHaveLength(1);
      ethernetManager.status.warnings = ["route warning"];
      await vi.advanceTimersByTimeAsync(100);
      expect(chunks.filter((chunk) => chunk === "event: system.ethernet.status\n")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(chunks).toContain(": heartbeat\n\n");
      const callsAtClose = ethernetManager.statusCalls;
      closeSignal.emit("close");
      await vi.advanceTimersByTimeAsync(500);
      expect(ethernetManager.statusCalls).toBe(callsAtClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns read-only storage management summary from block, RAID, mount, and SMART commands", async () => {
    const commandRunner = storageCommandRunner({
      smartSdb: JSON.stringify({
        smart_status: { passed: false },
        smart_support: { available: true, enabled: true },
        device: { protocol: "ATA" },
        firmware_version: "FW-2026",
        temperature: { current: 42, min: 18, max: 59 },
        power_on_time: { hours: 20_100 },
        power_cycle_count: 321,
        ata_smart_data: { self_test: { status: { string: "Completed without error" } } },
        ata_smart_error_log: { summary: { count: 3 } },
        ata_smart_attributes: {
          table: [
            {
              id: 5,
              name: "Reallocated_Sector_Ct",
              value: 98,
              worst: 97,
              thresh: 10,
              when_failed: "",
              flags: { string: "PO--CK" },
              raw: { value: 2, string: "2" }
            }
          ]
        },
        ata_smart_self_test_log: {
          standard: {
            table: [
              {
                num: 1,
                type: { string: "Short offline" },
                status: { string: "Completed without error" },
                remaining_percent: 0,
                lifetime_hours: 20_000,
                lba: null
              }
            ]
          }
        }
      })
    });
    const server = await buildServer({ config: testConfig(tempDir), db, system: { commandRunner } });
    const response = await server.inject({
      method: "GET",
      url: "/api/system/storage"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      storage: {
        status: "ready",
        capabilities: {
          backend: "mdadm",
          canCreatePool: true,
          canDeletePool: true
        },
        metrics: {
          pools: 1,
          arrays: 1,
          disks: 2,
          totalBytes: 2000,
          usedBytes: 800,
          availableBytes: 1200,
          smartPassed: 1,
          smartFailed: 1
        },
        pools: [
          expect.objectContaining({
            name: "nas:0",
            raidPath: "/dev/md0",
            raidLevel: "raid1",
            status: "ready",
            mountpoint: "/mnt/storage",
            filesystem: "ext4",
            usedPercent: 0.4,
            memberDevices: ["/dev/sda1", "/dev/sdb1"]
          })
        ],
        disks: expect.arrayContaining([
          expect.objectContaining({
            path: "/dev/sdb",
            smart: expect.objectContaining({
              health: "failed",
              available: true,
              enabled: true,
              protocol: "ATA",
              firmwareVersion: "FW-2026",
              temperatureCelsius: 42,
              temperatureMinCelsius: 18,
              temperatureMaxCelsius: 59,
              powerOnHours: 20100,
              powerCycleCount: 321,
              errorCount: 3,
              selfTestStatus: "Completed without error",
              attributes: [
                expect.objectContaining({ id: 5, name: "Reallocated_Sector_Ct", current: 98, raw: "2", flags: "PO--CK" })
              ],
              selfTests: [
                expect.objectContaining({ number: 1, type: "Short offline", lifetimeHours: 20000 })
              ]
            })
          })
        ]),
        issues: []
      }
    });
    await server.close();
  });

  it("maps NVMe controller SMART data to its namespace disk", async () => {
    const commandRunner = new FakeSystemCommandRunner({
      "lsblk --json --bytes --output NAME,KNAME,PATH,TYPE,SIZE,MODEL,SERIAL,TRAN,ROTA,FSTYPE,LABEL,UUID,MOUNTPOINTS,PKNAME": JSON.stringify({
        blockdevices: [
          {
            name: "nvme0n1",
            path: "/dev/nvme0n1",
            type: "disk",
            size: 512_000,
            model: "NVMe Disk",
            serial: "nvme-a",
            tran: "nvme",
            rota: false,
            mountpoints: []
          }
        ]
      }),
      "findmnt --json --bytes --output SOURCE,TARGET,FSTYPE,SIZE,USED,AVAIL,USE%": JSON.stringify({ filesystems: [] }),
      "mdadm --detail --scan": "",
      "smartctl --scan-open --json": JSON.stringify({
        devices: [{ name: "/dev/nvme0", type: "nvme", protocol: "NVMe" }]
      }),
      "smartctl --all --json -d nvme /dev/nvme0": JSON.stringify({
        smart_status: { passed: true },
        smart_support: { available: true, enabled: true },
        device: { protocol: "NVMe" },
        firmware_version: "NVME-1",
        temperature: { current: 318 },
        power_on_time: { hours: 6260 },
        power_cycle_count: 839,
        nvme_smart_health_information_log: {
          available_spare: 100,
          available_spare_threshold: 10,
          percentage_used: 4,
          data_units_read: 40_738_318,
          data_units_written: 51_196_721,
          host_reads: 560_796_155,
          host_writes: 2_010_927_049,
          controller_busy_time: 2700,
          unsafe_shutdowns: 33,
          media_errors: 0,
          num_err_log_entries: 1,
          critical_warning: 0,
          warning_temp_time: 2,
          critical_comp_time: 0
        }
      })
    });
    const server = await buildServer({ config: testConfig(tempDir), db, system: { commandRunner } });
    const response = await server.inject({ method: "GET", url: "/api/system/storage" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      storage: {
        metrics: { smartPassed: 1, smartUnknown: 0 },
        disks: [
          expect.objectContaining({
            path: "/dev/nvme0n1",
            rotational: false,
            smart: expect.objectContaining({
              health: "passed",
              protocol: "NVMe",
              firmwareVersion: "NVME-1",
              temperatureCelsius: 45,
              powerOnHours: 6260,
              percentageUsed: 4,
              availableSparePercent: 100,
              availableSpareThresholdPercent: 10,
              unsafeShutdowns: 33,
              hostReadCommands: 560796155,
              hostWriteCommands: 2010927049,
              controllerBusyMinutes: 2700,
              warningTemperatureTimeMinutes: 2,
              criticalTemperatureTimeMinutes: 0,
              errorCount: 0,
              errorLogEntries: 1,
              criticalWarning: 0
            })
          })
        ],
        issues: []
      }
    });
    await server.close();
  });

  it("keeps storage summary available when mdadm and SMART commands are missing", async () => {
    const commandRunner = new FakeSystemCommandRunner({
      "lsblk --json --bytes --output NAME,KNAME,PATH,TYPE,SIZE,MODEL,SERIAL,TRAN,ROTA,FSTYPE,LABEL,UUID,MOUNTPOINTS,PKNAME": JSON.stringify({
        blockdevices: [
          {
            name: "sda",
            path: "/dev/sda",
            type: "disk",
            size: 1000,
            model: "TestDisk",
            serial: "disk-a",
            tran: "sata",
            rota: 1,
            mountpoints: []
          }
        ]
      }),
      "findmnt --json --bytes --output SOURCE,TARGET,FSTYPE,SIZE,USED,AVAIL,USE%": JSON.stringify({
        filesystems: [{ source: "/dev/sda1", target: "/mnt/storage", fstype: "ext4", size: 1000, used: 250, avail: 750, "use%": "25%" }]
      })
    });
    const server = await buildServer({ config: testConfig(tempDir), db, system: { commandRunner } });
    const response = await server.inject({
      method: "GET",
      url: "/api/system/storage"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      storage: {
        status: "partial",
        metrics: {
          disks: 1,
          arrays: 0,
          pools: 0,
          totalBytes: 1000,
          usedBytes: null,
          availableBytes: null,
          smartUnknown: 1
        },
        disks: [
          expect.objectContaining({
            path: "/dev/sda",
            smart: expect.objectContaining({ health: "unknown" })
          })
        ],
        pools: []
      }
    });
    expect(response.json().storage.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "mdadm scan" }),
        expect.objectContaining({ source: "SMART scan" })
      ])
    );
    await server.close();
  });

  it("creates storage pools directly after explicit confirmation", async () => {
    const config = testConfig(tempDir);
    const socketPath = path.join(tempDir, "hostd.sock");
    config.hostd.socketPath = socketPath;
    let hostdProposal: unknown = null;
    const hostdServer = await createHostdTestServer(socketPath, (request) => {
      hostdProposal = request.payload;
      return {
        action: "create_pool",
        name: "media",
        raidLevel: "1",
        devices: ["/dev/sda", "/dev/sdb"],
        filesystem: "ext4",
        mountpoint: "/zos/data/media",
        mdDevice: "/dev/md/media",
        uuid: "11111111-2222-3333-4444-555555555555"
      };
    });

    const server = await buildServer({
      config,
      db,
      system: { commandRunner: availableStorageCommandRunner() }
    });

    const missingConfirmation = await server.inject({
      method: "POST",
      url: "/api/storage/actions",
      payload: {
        name: "media",
        raidLevel: "1",
        devices: ["/dev/sda", "/dev/sdb"]
      }
    });
    expect(missingConfirmation.statusCode).toBe(400);
    expect(missingConfirmation.json()).toEqual({
      error: "Storage operation requires explicit confirmation"
    });

    const proposed = await server.inject({
      method: "POST",
      url: "/api/storage/actions",
      payload: {
        name: "media",
        raidLevel: "1",
        devices: ["/dev/sda", "/dev/sdb"],
        confirm: true
      }
    });
    expect(proposed.statusCode).toBe(202);
    expect(proposed.json()).toMatchObject({
      operation: {
        action: "create_pool",
        status: "applied"
      }
    });
    expect(hostdProposal).toMatchObject({ action: "create_pool", name: "media" });
    expect(listPendingApprovals(db)).toHaveLength(0);
    expect(listOperationNotifications(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM jobs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM agent_messages").pluck().get()).toBe(0);

    const unsafe = await server.inject({
      method: "POST",
      url: "/api/storage/actions",
      payload: {
        name: "system",
        raidLevel: "1",
        devices: ["/dev/nvme0n1", "/dev/sda"],
        confirm: true
      }
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json()).toEqual({ error: expect.stringContaining("not present") });

    await server.close();
    await closeNetServer(hostdServer);
  });

  it("requires an exact pool confirmation before deleting a storage pool", async () => {
    const config = testConfig(tempDir);
    const socketPath = path.join(tempDir, "hostd-delete.sock");
    config.hostd.socketPath = socketPath;
    let hostdProposal: StorageOperationProposal | null = null;
    const hostdServer = await createHostdTestServer(socketPath, (request) => {
      hostdProposal = request.payload as StorageOperationProposal;
      return {
        action: "delete_pool",
        name: "storage",
        mountpoint: "/mnt/storage",
        mdDevice: "/dev/md0",
        devices: ["/dev/sda1", "/dev/sdb1"]
      };
    });

    const server = await buildServer({
      config,
      db,
      system: { commandRunner: storageCommandRunner({ mountpoint: "/zos/data/storage" }) }
    });

    const missingConfirmation = await server.inject({
      method: "POST",
      url: "/api/storage/actions",
      payload: {
        action: "delete_pool",
        poolId: "/dev/md0",
        confirmation: "storage"
      }
    });
    expect(missingConfirmation.statusCode).toBe(400);
    expect(missingConfirmation.json()).toEqual({
      error: "Storage operation requires explicit confirmation"
    });

    const missingPool = await server.inject({
      method: "POST",
      url: "/api/storage/actions",
      payload: {
        action: "delete_pool",
        poolId: "/dev/md-missing",
        confirmation: "storage",
        confirm: true
      }
    });
    expect(missingPool.statusCode).toBe(400);
    expect(missingPool.json()).toEqual({ error: "Storage pool is no longer available; refresh the inventory" });

    const wrongConfirmation = await server.inject({
      method: "POST",
      url: "/api/storage/actions",
      payload: {
        action: "delete_pool",
        poolId: "/dev/md0",
        confirmation: "wrong",
        confirm: true
      }
    });
    expect(wrongConfirmation.statusCode).toBe(400);
    expect(wrongConfirmation.json()).toEqual({ error: "Type storage to confirm storage pool deletion" });

    const deleted = await server.inject({
      method: "POST",
      url: "/api/storage/actions",
      payload: {
        action: "delete_pool",
        poolId: "/dev/md0",
        confirmation: "storage",
        confirm: true
      }
    });
    expect(deleted.statusCode).toBe(202);
    expect(deleted.json()).toMatchObject({
      operation: {
        action: "delete_pool",
        status: "applied"
      }
    });
    expect(hostdProposal).toMatchObject({
      action: "delete_pool",
      name: "storage",
      mdDevice: "/dev/md0",
      mountpoint: "/zos/data/storage"
    });

    await server.close();
    await closeNetServer(hostdServer);
  });

  it("scopes SMART command failures to the affected disk", async () => {
    const commandRunner = storageCommandRunner({
      failSmartSdb: true
    });
    const server = await buildServer({ config: testConfig(tempDir), db, system: { commandRunner } });
    const response = await server.inject({
      method: "GET",
      url: "/api/system/storage"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().storage).toMatchObject({
      status: "partial",
      metrics: {
        smartPassed: 1,
        smartFailed: 1
      },
      disks: expect.arrayContaining([
        expect.objectContaining({
          path: "/dev/sda",
          smart: expect.objectContaining({ health: "passed" })
        }),
        expect.objectContaining({
          path: "/dev/sdb",
          smart: expect.objectContaining({ health: "error" })
        })
      ])
    });
    expect(response.json().storage.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "SMART /dev/sdb" })])
    );
    await server.close();
  });

  it("returns and stores Docker settings through the settings API", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const initial = await server.inject({
      method: "GET",
      url: "/api/settings/docker"
    });
    const saved = await server.inject({
      method: "PATCH",
      url: "/api/settings/docker",
      payload: {
        enabled: true,
        socketPath: "/tmp/docker.sock",
        composeCommand: "/usr/bin/docker",
        operationTimeoutMs: 90_000,
        consoleShells: ["/bin/sh"]
      }
    });
    const loaded = await server.inject({
      method: "GET",
      url: "/api/settings/docker"
    });

    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      settings: {
        enabled: false,
        socketPath: "/var/run/docker.sock",
        composeCommand: "docker",
        operationTimeoutMs: 120_000,
        consoleShells: ["/bin/sh", "/bin/bash"]
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      settings: {
        enabled: true,
        socketPath: "/tmp/docker.sock",
        composeCommand: "/usr/bin/docker",
        operationTimeoutMs: 90_000,
        consoleShells: ["/bin/sh"]
      }
    });
    expect(loaded.json()).toMatchObject({
      settings: {
        enabled: true,
        socketPath: "/tmp/docker.sock",
        composeCommand: "/usr/bin/docker"
      }
    });
    expect(getDockerSettings(db)).toMatchObject({ enabled: true });
    await server.close();
  });

  it("returns default share settings without exposing passwords", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: "/api/settings/shares"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      settings: {
        enabled: false,
        account: {
          username: "zos-share",
          passwordConfigured: false
        },
        shares: []
      }
    });
    expect(response.payload).not.toContain("password\":\"");
    await server.close();
  });

  it("updates the share account directly without creating an approval", async () => {
    await mkdir(path.join(rootDir, "media"));
    const existing = saveShareSettings(db, shareSettingsPayload("old-secret"));
    const hostd = new FakeShareHostd();
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      shares: { hostd }
    });

    const updated = await server.inject({
      method: "PUT",
      url: "/api/shares/account",
      payload: {
        username: "media-share",
        password: "new-secret",
        expectedUpdatedAt: existing.updatedAt
      }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      settings: {
        account: {
          username: "media-share",
          passwordConfigured: true
        }
      },
      appliedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(updated.payload).not.toContain("new-secret");
    expect(hostd.requests).toHaveLength(1);
    expect(hostd.requests[0]?.settings.account).toEqual({
      username: "media-share",
      password: "new-secret"
    });
    expect(getShareSettings(db)?.account).toEqual({
      username: "media-share",
      password: "new-secret"
    });
    expect(listPendingApprovals(db)).toEqual([]);

    const retained = await server.inject({
      method: "PUT",
      url: "/api/shares/account",
      payload: {
        username: "archive-share",
        password: "",
        expectedUpdatedAt: updated.json().settings.updatedAt
      }
    });
    expect(retained.statusCode).toBe(200);
    expect(getShareSettings(db)?.account).toEqual({
      username: "archive-share",
      password: "new-secret"
    });

    const stale = await server.inject({
      method: "PUT",
      url: "/api/shares/account",
      payload: {
        username: "stale-share",
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z"
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(hostd.requests).toHaveLength(2);
    await server.close();
  });

  it("keeps the saved share account when direct host application fails", async () => {
    await mkdir(path.join(rootDir, "media"));
    const existing = saveShareSettings(db, shareSettingsPayload("old-secret"));
    const hostd = new FakeShareHostd();
    hostd.failApply = true;
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      shares: { hostd }
    });

    const response = await server.inject({
      method: "PUT",
      url: "/api/shares/account",
      payload: {
        username: "media-share",
        password: "new-secret",
        expectedUpdatedAt: existing.updatedAt
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.payload).not.toContain("new-secret");
    expect(getShareSettings(db)?.account).toEqual({
      username: "zos-share",
      password: "old-secret"
    });
    expect(listPendingApprovals(db)).toEqual([]);
    await server.close();
  });

  it("applies share settings directly without creating Agent records", async () => {
    await mkdir(path.join(rootDir, "media"));
    const hostd = new FakeShareHostd();
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      shares: {
        hostd
      }
    });

    const proposed = await server.inject({
      method: "POST",
      url: "/api/shares/settings",
      payload: {
        settings: shareSettingsPayload("secret")
      }
    });

    expect(proposed.statusCode).toBe(200);
    expect(hostd.requests).toHaveLength(1);
    expect(proposed.payload).not.toContain("secret");
    expect(proposed.json()).toMatchObject({
      settings: {
        account: {
          username: "zos-share",
          passwordConfigured: true
        }
      },
      operation: {
        action: "apply_settings",
        status: "applied"
      }
    });
    expect(hostd.requests[0]?.settings.account.password).toBe("secret");
    expect(hostd.requests[0]?.roots).toEqual([
      expect.objectContaining({ id: "local", name: "Local", path: rootDir })
    ]);
    expect(getShareSettings(db)).toMatchObject({
      enabled: true,
      account: {
        username: "zos-share",
        password: "secret"
      },
      shares: [
        {
          id: "media",
          path: "media",
          protocols: {
            smb: {
              enabled: true,
              readOnly: false
            },
            nfs: {
              allowedCidrs: ["192.168.1.0/24"]
            },
            dlna: {
              bindInterface: "eth0"
            }
          }
        }
      ]
    });
    expect(listPendingApprovals(db)).toEqual([]);
    expect(listOperationNotifications(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM jobs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM agent_messages").pluck().get()).toBe(0);
    await server.close();
  });

  it("lets a direct account update follow a direct share settings update", async () => {
    await mkdir(path.join(rootDir, "media"));
    const hostd = new FakeShareHostd();
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      shares: { hostd }
    });
    const proposed = await server.inject({
      method: "POST",
      url: "/api/shares/settings",
      payload: {
        settings: shareSettingsPayload("approval-secret")
      }
    });
    expect(proposed.statusCode).toBe(200);
    const current = getShareSettings(db);
    expect(current).not.toBeNull();
    const accountUpdated = await server.inject({
      method: "PUT",
      url: "/api/shares/account",
      payload: {
        username: "latest-share",
        password: "latest-secret",
        expectedUpdatedAt: current!.updatedAt
      }
    });

    expect(accountUpdated.statusCode).toBe(200);
    expect(hostd.requests).toHaveLength(2);
    expect(hostd.requests[1]?.settings.account).toEqual({
      username: "latest-share",
      password: "latest-secret"
    });
    expect(getShareSettings(db)?.account).toEqual({
      username: "latest-share",
      password: "latest-secret"
    });
    await server.close();
  });

  it("keeps saved share settings unchanged when hostd application fails", async () => {
    await mkdir(path.join(rootDir, "media"));
    const hostd = new FakeShareHostd();
    hostd.failApply = true;
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      shares: {
        hostd
      }
    });
    const proposed = await server.inject({
      method: "POST",
      url: "/api/shares/settings",
      payload: {
        settings: shareSettingsPayload("secret")
      }
    });

    expect(proposed.statusCode).toBe(400);
    expect(getShareSettings(db)).toBeNull();
    expect(listShareOperations(db)).toEqual([expect.objectContaining({
      status: "failed"
    })]);
    await server.close();
  });

  it("rejects unsafe share paths and invalid CIDRs before applying settings", async () => {
    await mkdir(path.join(rootDir, "media"));
    const server = await buildServer({ config: testConfig(tempDir), db });
    const payload = shareSettingsPayload("secret");
    const share = payload.shares[0];
    if (!share) {
      throw new Error("test share payload missing share");
    }

    const unsafePath = await server.inject({
      method: "POST",
      url: "/api/shares/settings",
      payload: {
        settings: {
          ...payload,
          shares: [
            {
              ...share,
              path: "../outside"
            }
          ]
        }
      }
    });
    const invalidCidr = await server.inject({
      method: "POST",
      url: "/api/shares/settings",
      payload: {
        settings: {
          ...payload,
          shares: [
            {
              ...share,
              protocols: {
                ...share.protocols,
                nfs: {
                  ...share.protocols.nfs,
                  allowedCidrs: ["0.0.0.0/0"]
                }
              }
            }
          ]
        }
      }
    });

    expect(unsafePath.statusCode).toBe(400);
    expect(invalidCidr.statusCode).toBe(400);
    expect(listPendingApprovals(db)).toEqual([]);
    await server.close();
  });

  it("returns a stable disabled Docker summary", async () => {
    const daemon = new FakeDockerDaemon();
    const server = await buildServer({ config: testConfig(tempDir), db, docker: { daemon } });
    const response = await server.inject({
      method: "GET",
      url: "/api/docker/summary"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      summary: {
        enabled: false,
        daemon: { state: "running", activeState: "active" },
        engine: {
          status: "disabled",
          error: null
        },
        metrics: {
          containers: {
            total: 0
          }
        },
        containers: [],
        composeProjects: []
      }
    });
    await server.close();
  });

  it("publishes the Host Access catalog and returns 503 for unavailable Compose grants", async () => {
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      hostAccess: {
        policy: new DockerHostAccessPolicy(db, { platform: "darwin", daemonAvailable: false })
      }
    });
    const catalog = await server.inject({ method: "GET", url: "/api/docker/host-access" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      hostAccess: {
        policyVersion: expect.stringMatching(/^2026-/u),
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            id: "host_processes",
            availability: { status: "unavailable", reasonCodes: ["not_linux"] }
          })
        ])
      }
    });

    const validation = await server.inject({
      method: "POST",
      url: "/api/docker/apps/validate",
      payload: {
        projectKey: "observer",
        composeContent: "services:\n  collector:\n    image: alpine\n",
        environment: [],
        hostAccess: [{ service: "collector", grants: [{ capability: "host_processes" }] }]
      }
    });
    expect(validation.statusCode).toBe(503);
    expect(validation.json()).toMatchObject({
      issues: [expect.objectContaining({ code: "capability_unavailable", service: "collector" })]
    });
    await server.close();
  });

  it("reads and updates Docker daemon configuration through the privileged runtime", async () => {
    const daemon = new FakeDockerDaemon();
    const server = await buildServer({ config: testConfig(tempDir), db, docker: { daemon } });
    const loaded = await server.inject({ method: "GET", url: "/api/docker/daemon/config" });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({ config: { path: "/etc/docker/daemon.json", exists: true } });

    const updated = await server.inject({
      method: "PUT",
      url: "/api/docker/daemon/config",
      payload: {
        content: '{"live-restore":true}\n',
        expectedRevision: "a".repeat(64),
        restart: true,
        confirmed: true
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(daemon.updates).toHaveLength(1);
    expect(updated.json()).toMatchObject({ result: { restarted: true, rollback: "not_required" } });

    const missingConfirmation = await server.inject({
      method: "PUT",
      url: "/api/docker/daemon/config",
      payload: {
        content: "{}",
        expectedRevision: "a".repeat(64),
        restart: true,
        confirmed: false
      }
    });
    expect(missingConfirmation.statusCode).toBe(400);
    expect(daemon.updates).toHaveLength(1);

    const nonObjectJson = await server.inject({
      method: "PUT",
      url: "/api/docker/daemon/config",
      payload: {
        content: "[]",
        expectedRevision: "a".repeat(64),
        restart: false,
        confirmed: false
      }
    });
    expect(nonObjectJson.statusCode).toBe(400);
    expect(daemon.updates).toHaveLength(1);
    await server.close();
  });

  it("returns 503 without exposing hostd details when daemon configuration is unavailable", async () => {
    const daemon = new FakeDockerDaemon();
    daemon.getError = new DockerDaemonRequestError("hostd token=private", 503);
    const server = await buildServer({ config: testConfig(tempDir), db, docker: { daemon } });

    const response = await server.inject({ method: "GET", url: "/api/docker/daemon/config" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "hostd token: [redacted]" });
    await server.close();
  });

  it("preserves hostd conflict and rollback failure status codes", async () => {
    const daemon = new FakeDockerDaemon();
    daemon.updateError = new DockerDaemonRequestError("changed", 409);
    const server = await buildServer({ config: testConfig(tempDir), db, docker: { daemon } });
    const conflict = await server.inject({
      method: "PUT",
      url: "/api/docker/daemon/config",
      payload: {
        content: "{}",
        expectedRevision: "a".repeat(64),
        restart: false,
        confirmed: false
      }
    });
    expect(conflict.statusCode).toBe(409);

    daemon.updateError = new DockerDaemonRequestError("restart failed", 502, {
      snapshot: daemon.snapshot,
      restarted: false,
      rollback: "failed",
      error: "manual recovery required"
    });
    const restartFailure = await server.inject({
      method: "PUT",
      url: "/api/docker/daemon/config",
      payload: {
        content: "{}",
        expectedRevision: "a".repeat(64),
        restart: true,
        confirmed: true
      }
    });
    expect(restartFailure.statusCode).toBe(502);
    expect(restartFailure.json()).toMatchObject({ result: { rollback: "failed" } });
    await server.close();
  });

  it("streams initial and changed daemon states, heartbeats, and stops on close", async () => {
    vi.useFakeTimers();
    try {
      const daemon = new FakeDockerDaemon();
      const closeSignal = new EventEmitter();
      const chunks: string[] = [];
      await streamDockerDaemonEvents(
        closeSignal,
        { write: (chunk) => chunks.push(chunk) },
        daemon,
        { sampleMs: 100, heartbeatMs: 250 }
      );

      expect(chunks.join("")).toContain("retry: 2000");
      expect(chunks.join("")).toContain('"state":"running"');
      expect(chunks.filter((chunk) => chunk === "event: docker.daemon.status\n")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(chunks.filter((chunk) => chunk === "event: docker.daemon.status\n")).toHaveLength(1);

      daemon.status.state = "stopped";
      daemon.status.activeState = "inactive";
      daemon.status.subState = "dead";
      await vi.advanceTimersByTimeAsync(100);
      expect(chunks.filter((chunk) => chunk === "event: docker.daemon.status\n")).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(50);
      expect(chunks).toContain(": heartbeat\n\n");

      const callsAtClose = daemon.statusCalls;
      closeSignal.emit("close");
      await vi.advanceTimersByTimeAsync(500);
      expect(daemon.statusCalls).toBe(callsAtClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unavailable Docker sockets without failing the route", async () => {
    const config = dockerEnabledConfig(tempDir, {
      socketPath: path.join(tempDir, "missing-docker.sock")
    });
    const server = await buildServer({ config, db });
    const response = await server.inject({
      method: "GET",
      url: "/api/docker/summary"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      summary: {
        enabled: true,
        engine: {
          status: "unavailable",
          error: expect.any(String)
        }
      }
    });
    await server.close();
  });

  it("manages Docker registry credentials while Docker is disabled without exposing secrets", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const created = await server.inject({
      method: "POST",
      url: "/api/docker/registries",
      payload: {
        name: "Private Registry",
        serverAddress: "REGISTRY.EXAMPLE.COM:5000",
        username: "builder",
        password: "registry-secret"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      registry: {
        name: "Private Registry",
        serverAddress: "registry.example.com:5000",
        username: "builder",
        credentialConfigured: true
      }
    });
    expect(created.body).not.toContain("registry-secret");

    const duplicate = await server.inject({
      method: "POST",
      url: "/api/docker/registries",
      payload: {
        name: "Duplicate",
        serverAddress: "registry.example.com:5000",
        username: "other",
        password: "other-secret"
      }
    });
    expect(duplicate.statusCode).toBe(409);

    const id = created.json().registry.id as string;
    const updated = await server.inject({
      method: "PATCH",
      url: `/api/docker/registries/${id}`,
      payload: { name: "Primary Registry", password: "" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain("registry-secret");
    expect(listDockerRegistryCredentials(db)).toMatchObject([
      { id, name: "Primary Registry", password: "registry-secret" }
    ]);

    const listed = await server.inject({ method: "GET", url: "/api/docker/registries" });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain("registry-secret");
    expect(listed.json().registries).toHaveLength(1);

    const deleted = await server.inject({ method: "DELETE", url: `/api/docker/registries/${id}` });
    expect(deleted.statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/docker/registries" })).json().registries).toEqual([]);
    await server.close();
  });

  it("manages Compose Apps as database-backed definitions without exposing environment values", async () => {
    const composeCommand = await writeComposeTestCommand();
    const appsRoot = path.join(tempDir, "apps");
    const config = {
      ...testConfig(tempDir),
      docker: { ...testConfig(tempDir).docker, composeCommand }
    };
    const compose = new DockerComposeService(() => config.docker, db, appsRoot);
    const engine = new FakeDockerEngine();
    const server = await buildServer({ config, db, docker: { compose, engine, daemon: new FakeDockerDaemon() } });

    const created = await server.inject({
      method: "POST",
      url: "/api/docker/apps",
      payload: {
        name: "Managed Media",
        projectKey: "managed-media",
        composeContent: "services:\n  app:\n    image: alpine\n",
        environment: [{ key: "APP_TOKEN", value: "compose-secret" }]
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("compose-secret");
    expect(created.json()).toMatchObject({ app: {
      name: "Managed Media",
      projectKey: "managed-media",
      managedPath: path.join(appsRoot, "managed-media"),
      environment: [{ key: "APP_TOKEN", valueConfigured: true }],
      needsDeploy: true
    } });
    const appId = created.json().app.id as string;
    const revision = created.json().app.revision as string;

    const listed = await server.inject({ method: "GET", url: "/api/docker/apps" });
    const detail = await server.inject({ method: "GET", url: `/api/docker/apps/${appId}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain("compose-secret");
    expect(detail.body).not.toContain("compose-secret");

    const validated = await server.inject({
      method: "POST",
      url: "/api/docker/apps/validate",
      payload: {
        appId,
        expectedRevision: revision,
        projectKey: "managed-media",
        composeContent: "services:\n  app:\n    image: alpine:3\n",
        environment: [{ key: "APP_TOKEN" }]
      }
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.body).not.toContain("compose-secret");

    const updated = await server.inject({
      method: "PUT",
      url: `/api/docker/apps/${appId}`,
      payload: {
        name: "Managed Media Updated",
        composeContent: "services:\n  app:\n    image: alpine:3\n",
        environment: [{ key: "APP_TOKEN" }],
        expectedRevision: revision
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain("compose-secret");
    const nextRevision = updated.json().app.revision as string;

    const conflict = await server.inject({
      method: "PUT",
      url: `/api/docker/apps/${appId}`,
      payload: {
        name: "Stale",
        composeContent: "services:\n  app:\n    image: alpine\n",
        environment: [],
        expectedRevision: revision
      }
    });
    expect(conflict.statusCode).toBe(409);
    expect((await server.inject({
      method: "PUT",
      url: `/api/docker/apps/${appId}`,
      payload: {}
    })).statusCode).toBe(400);
    expect((await server.inject({
      method: "POST",
      url: "/api/docker/apps"
    })).statusCode).toBe(400);
    expect((await server.inject({
      method: "DELETE",
      url: `/api/docker/apps/${appId}`,
      payload: { expectedRevision: nextRevision, confirmed: true }
    })).statusCode).toBe(503);
    await server.close();

    const enabledConfig = { ...config, docker: { ...config.docker, enabled: true } };
    const occupiedEngine = new FakeDockerEngine();
    occupiedEngine.listContainers = async () => [{
      ...(await new FakeDockerEngine().listContainers())[0]!,
      composeProject: "managed-media"
    }];
    const enabledServer = await buildServer({
      config: enabledConfig,
      db,
      docker: { compose, engine: occupiedEngine, daemon: new FakeDockerDaemon() }
    });
    expect((await enabledServer.inject({
      method: "DELETE",
      url: `/api/docker/apps/${appId}`,
      payload: { expectedRevision: nextRevision, confirmed: false }
    })).statusCode).toBe(400);
    expect((await enabledServer.inject({
      method: "DELETE",
      url: `/api/docker/apps/${appId}`,
      payload: { expectedRevision: nextRevision, confirmed: true }
    })).statusCode).toBe(409);
    occupiedEngine.listContainers = async () => [];
    expect((await enabledServer.inject({
      method: "DELETE",
      url: `/api/docker/apps/${appId}`,
      payload: { confirmed: true }
    })).statusCode).toBe(400);
    expect((await enabledServer.inject({
      method: "DELETE",
      url: `/api/docker/apps/${appId}`,
      payload: { expectedRevision: nextRevision, confirmed: true }
    })).statusCode).toBe(200);
    await expect(access(path.join(appsRoot, "managed-media"))).rejects.toThrow();
    await enabledServer.close();
  });

  it("uses the configured apps directory for the default Compose runtime", async () => {
    const composeCommand = await writeComposeTestCommand();
    const paths = resolveZosPaths(path.join(tempDir, "configured-zos-root"));
    const config = {
      ...testConfig(tempDir),
      paths,
      docker: { ...testConfig(tempDir).docker, composeCommand }
    };
    const server = await buildServer({ config, db });

    const created = await server.inject({
      method: "POST",
      url: "/api/docker/apps",
      payload: {
        name: "Configured Root",
        projectKey: "configured-root",
        composeContent: "services:\n  app:\n    image: alpine\n",
        environment: []
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().app.managedPath).toBe(path.join(paths.appsRoot, "configured-root"));
    await expect(readFile(path.join(paths.appsRoot, "configured-root", "compose.yaml"), "utf8"))
      .resolves.toContain("image: alpine");
    await server.close();
  });

  it("deploys the current Compose App revision directly without exposing secrets", async () => {
    const composeCommand = await writeComposeTestCommand();
    const config = dockerEnabledConfig(tempDir, { composeCommand });
    const compose = new DockerComposeService(() => config.docker, db, path.join(tempDir, "apps"));
    const server = await buildServer({
      config,
      db,
      docker: { compose, engine: new FakeDockerEngine(), daemon: new FakeDockerDaemon() }
    });
    const created = await server.inject({ method: "POST", url: "/api/docker/apps", payload: {
      name: "Managed App",
      projectKey: "managed-app",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: [{ key: "APP_TOKEN", value: "approval-secret" }]
    } });
    const app = created.json().app as { id: string; revision: string };
    const deployed = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
      action: "compose_up",
      composeProjectId: app.id
    } });
    expect(deployed.statusCode).toBe(202);
    expect(deployed.body).not.toContain("approval-secret");
    expect(deployed.body).not.toContain("managedPath");
    expect(deployed.body).not.toContain("composeContent");
    expect(deployed.json()).toMatchObject({ operation: { status: "applied" } });
    expect(db.prepare("SELECT COUNT(*) FROM jobs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM agent_messages").pluck().get()).toBe(0);
    expect(listPendingApprovals(db)).toEqual([]);
    await server.close();
  });

  it("enforces the managed Compose App request body limit", async () => {
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      docker: { compose: new FakeDockerCompose(), daemon: new FakeDockerDaemon() }
    });
    const response = await server.inject({ method: "POST", url: "/api/docker/apps", payload: {
      name: "Oversized",
      projectKey: "oversized",
      composeContent: `services:\n  app:\n    image: alpine\n#${"x".repeat(520 * 1024)}`,
      environment: []
    } });
    expect(response.statusCode).toBe(413);
    await server.close();
  });

  it("returns service unavailable when the Compose CLI cannot validate an App", async () => {
    const config = testConfig(tempDir);
    const compose = new DockerComposeService(
      () => ({ ...config.docker, composeCommand: path.join(tempDir, "missing-docker") }),
      db,
      path.join(tempDir, "apps")
    );
    const server = await buildServer({
      config,
      db,
      docker: { compose, daemon: new FakeDockerDaemon() }
    });
    const response = await server.inject({ method: "POST", url: "/api/docker/apps", payload: {
      name: "Unavailable",
      projectKey: "unavailable",
      composeContent: "services:\n  app:\n    image: alpine\n",
      environment: []
    } });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Docker Compose CLI is unavailable" });
    await server.close();
  });

  it("lists, pulls, and removes Docker images with matched Registry credentials", async () => {
    const engine = new FakeDockerEngine();
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: { engine, compose: new FakeDockerCompose(), daemon: new FakeDockerDaemon() }
    });
    await server.inject({
      method: "POST",
      url: "/api/docker/registries",
      payload: {
        name: "Private",
        serverAddress: "registry.example.com",
        username: "builder",
        password: "pull-secret"
      }
    });

    const summary = await server.inject({ method: "GET", url: "/api/docker/summary" });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().summary.images).toEqual(engine.images);

    const pulled = await server.inject({
      method: "POST",
      url: "/api/docker/images/pull",
      payload: { reference: "registry.example.com/team/app:latest" }
    });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json()).toEqual({ result: { reference: "registry.example.com/team/app:latest" } });
    const auth = JSON.parse(Buffer.from(engine.pullInputs[0]!.registryAuth!, "base64url").toString("utf8")) as Record<string, string>;
    expect(auth).toEqual({
      username: "builder",
      password: "pull-secret",
      serveraddress: "registry.example.com"
    });

    await server.inject({
      method: "POST",
      url: "/api/docker/images/pull",
      payload: { reference: "nginx:latest" }
    });
    expect(engine.pullInputs[1]).toEqual({ image: "nginx:latest" });

    const unconfirmed = await server.inject({
      method: "POST",
      url: "/api/docker/images/remove",
      payload: { reference: "jellyfin:latest", confirmed: false }
    });
    expect(unconfirmed.statusCode).toBe(400);
    const removed = await server.inject({
      method: "POST",
      url: "/api/docker/images/remove",
      payload: { reference: "jellyfin:latest", confirmed: true }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ result: { reference: "jellyfin:latest" } });

    engine.removeError = new DockerRequestError("image is being used", 409);
    const conflict = await server.inject({
      method: "POST",
      url: "/api/docker/images/remove",
      payload: { reference: "jellyfin:latest", confirmed: true }
    });
    expect(conflict.statusCode).toBe(409);
    await server.close();
  });

  it("returns Docker network and volume inspect details with stable error statuses", async () => {
    const engine = new FakeDockerEngine();
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: { engine, compose: new FakeDockerCompose(), daemon: new FakeDockerDaemon() }
    });

    const network = await server.inject({ method: "GET", url: "/api/docker/networks/network-1" });
    expect(network.statusCode).toBe(200);
    expect(network.json()).toMatchObject({ network: {
      id: "network-1",
      name: "media-net",
      enableIPv4: true,
      containers: [{ name: "media", ipv4Address: "172.20.0.2/16" }]
    } });

    const volume = await server.inject({ method: "GET", url: "/api/docker/volumes/media-data" });
    expect(volume.statusCode).toBe(200);
    expect(volume.json()).toMatchObject({ volume: {
      name: "media-data",
      sizeBytes: 4096,
      referenceCount: 1
    } });

    expect((await server.inject({ method: "GET", url: "/api/docker/networks/missing" })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/api/docker/volumes/missing" })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/api/docker/networks/broken" })).statusCode).toBe(502);
    expect((await server.inject({ method: "GET", url: "/api/docker/volumes/broken" })).statusCode).toBe(502);
    await server.close();
  });

  it("keeps Docker inspect details disabled with the rest of Docker management", async () => {
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      docker: { engine: new FakeDockerEngine(), compose: new FakeDockerCompose(), daemon: new FakeDockerDaemon() }
    });

    expect((await server.inject({ method: "GET", url: "/api/docker/networks/network-1" })).statusCode).toBe(503);
    expect((await server.inject({ method: "GET", url: "/api/docker/volumes/media-data" })).statusCode).toBe(503);
    await server.close();
  });

  it("rejects invalid image input before Engine calls and redacts pull errors", async () => {
    const engine = new FakeDockerEngine();
    const server = await buildServer({ config: dockerEnabledConfig(tempDir), db, docker: { engine, compose: new FakeDockerCompose(), daemon: new FakeDockerDaemon() } });
    const registry = createDockerRegistryCredential(db, { name: "Private", serverAddress: "registry.example.com:80", username: "builder", password: "pull-secret" });
    for (const reference of ["team//app", "app:", "app@sha256:abc"]) {
      const response = await server.inject({ method: "POST", url: "/api/docker/images/pull", payload: { reference } });
      expect(response.statusCode).toBe(400);
    }
    expect(engine.pullInputs).toEqual([]);
    const emptyPassword = await server.inject({ method: "PATCH", url: `/api/docker/registries/${registry.id}`, payload: { password: "" } });
    expect(emptyPassword.statusCode).toBe(200);
    expect(listDockerRegistryCredentials(db)[0]?.password).toBe("pull-secret");
    const duplicate = await server.inject({ method: "POST", url: "/api/docker/registries", payload: { name: "Duplicate", serverAddress: "REGISTRY.EXAMPLE.COM:080", username: "builder", password: "other-secret" } });
    expect(duplicate.statusCode).toBe(409);
    const invalidUsername = await server.inject({ method: "POST", url: "/api/docker/registries", payload: { name: "Invalid", serverAddress: "docker.io", username: "user:name", password: "secret" } });
    expect(invalidUsername.statusCode).toBe(400);
    engine.pullImage = async () => { throw new DockerRequestError("denied pull-secret", 500); };
    const failed = await server.inject({ method: "POST", url: "/api/docker/images/pull", payload: { reference: "registry.example.com:80/team/app" } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: "denied [redacted]" });
    await server.close();
  });

  it("keeps image operations disabled while Registry management remains available", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db, docker: { engine: new FakeDockerEngine(), daemon: new FakeDockerDaemon() } });
    for (const action of ["pull", "remove"]) {
      const response = await server.inject({ method: "POST", url: `/api/docker/images/${action}`, payload: { reference: "alpine:latest", confirmed: true } });
      expect(response.statusCode).toBe(503);
    }
    expect((await server.inject({ method: "GET", url: "/api/docker/registries" })).statusCode).toBe(200);
    await server.close();
  });

  it("resolves CM5 image occupancy and rejects unavailable limits through the real socket/API chain", async () => {
    const socketPath = path.join(tempDir, "engine.sock");
    const mutations: string[] = [];
    const upstream = http.createServer((request, response) => {
      const url = request.url ?? "";
      response.setHeader("Content-Type", "application/json");
      const replies: Record<string, unknown> = {
        "/version": { Version: "26.1.5", ApiVersion: "1.45", MinAPIVersion: "1.24", Arch: "arm64" },
        "/v1.45/info": { MemoryLimit: false, SwapLimit: false, CpuCfsQuota: true, CpuCfsPeriod: true },
        "/v1.45/containers/json?all=1": [
          { Id: "running", Image: "rustfs/rustfs:old", ImageID: "sha256:rustfs", State: "running" },
          { Id: "stopped", Image: "rustfs/rustfs:older", ImageID: "sha256:rustfs", State: "exited" }
        ],
        "/v1.45/containers/running/stats?stream=false": { memory_stats: {} },
        "/v1.45/images/json?shared-size=true&containers=true": [
          { Id: "sha256:rustfs", RepoTags: ["rustfs/rustfs:latest"], Containers: -1 },
          { Id: "sha256:unused", RepoTags: null, Containers: -1 }
        ],
        "/v1.45/images/rustfs%2Frustfs%3Alatest/json": { Id: "sha256:rustfs" },
        "/v1.45/networks": [],
        "/v1.45/volumes": { Volumes: [] }
      };
      if (request.method !== "GET") mutations.push(`${request.method} ${url}`);
      if (!(url in replies)) response.statusCode = 404;
      response.end(JSON.stringify(replies[url] ?? { message: "Unexpected Engine request" }));
    });
    await listenOnUnixSocket(upstream, socketPath);
    const server = await buildServer({ config: dockerEnabledConfig(tempDir, { socketPath }), db,
      docker: { daemon: new FakeDockerDaemon(), compose: new FakeDockerCompose() } });
    try {
      const summary = await server.inject({ method: "GET", url: "/api/docker/summary" });
      expect(summary.statusCode).toBe(200);
      expect(summary.json()).toMatchObject({ summary: {
        engine: { status: "ready", architecture: "arm64", resourceCapabilities: {
          memoryLimit: false, swapLimit: false, cpuQuota: true, cpuShares: null, cpuset: null, pidsLimit: null
        } },
        images: [{ id: "sha256:rustfs", containerCount: 2 }, { id: "sha256:unused", containerCount: 0 }],
        metrics: { images: 2, memoryUsageBytes: null }
      } });
      const session = createSession(db, { rootId: "local" });
      for (const limit of [{ memoryLimitBytes: 8_388_608 }, { memoryReservationBytes: 8_388_608 },
        { memorySwapBytes: -1 }, { cpuShares: 512 }, { cpusetCpus: "0-1" }, { pidsLimit: 128 }]) {
        const rejected = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
          sessionId: session.id, action: "create", targetType: "container", name: "unsupported", image: "rustfs/rustfs", ...limit
        } });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json().error).toContain("Host resource control is unsupported or unknown");
      }
      const occupied = await server.inject({ method: "POST", url: "/api/docker/images/remove", payload: {
        reference: "rustfs/rustfs:latest", confirmed: true
      } });
      expect(occupied.statusCode).toBe(409);
      expect(mutations).toEqual([]);
      expect(listDockerOperations(db)).toEqual([]);
      expect(listPendingApprovals(db)).toEqual([]);
      expect(listMessages(db, { sessionId: session.id })).toEqual([]);
      expect(listEvents(db, { sessionId: session.id })).toEqual([]);
    } finally {
      await server.close();
      await closeHttpServer(upstream);
    }
  });

  it("allows supported resource limits and rejects unavailable CPU and swap controls", async () => {
    const engine = new FakeDockerEngine();
    const session = createSession(db, { rootId: "local" });
    const server = await buildServer({ config: dockerEnabledConfig(tempDir), db, docker: {
      engine, daemon: new FakeDockerDaemon(), compose: new FakeDockerCompose()
    } });
    try {
      for (const flag of [false, null]) {
        engine.resourceCapabilities = { ...engine.resourceCapabilities, cpuQuota: flag, memoryLimit: flag };
        for (const limit of [{ cpuLimit: 2 }, { memorySwapBytes: -1 }]) {
          const rejected = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
            sessionId: session.id, action: "create", targetType: "container", name: "limits", image: "alpine", ...limit
          } });
          expect(rejected.statusCode).toBe(400);
        }
      }
      expect(engine.calls).toEqual([]);
      expect(listDockerOperations(db)).toEqual([]);
      engine.resourceCapabilities = { memoryLimit: true, swapLimit: true, cpuQuota: true, cpuShares: true, cpuset: true, pidsLimit: true };
      const accepted = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
        sessionId: session.id, action: "create", targetType: "container", name: "limits", image: "alpine", start: false,
        cpuLimit: 2, cpuShares: 512, cpusetCpus: "0-1", memoryLimitBytes: 8_388_608,
        memoryReservationBytes: 4_194_304, memorySwapBytes: -1, pidsLimit: 128
      } });
      expect(accepted.statusCode).toBe(202);
      expect(engine.calls).toEqual(["image-exists", "create-container"]);
    } finally { await server.close(); }
  });

  it("executes Docker actions directly without creating Agent records", async () => {
    const engine = new FakeDockerEngine();
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: {
        engine,
        compose: new FakeDockerCompose()
      }
    });

    const proposed = await server.inject({
      method: "POST",
      url: "/api/docker/actions",
      payload: {
        action: "start",
        containerId: "container-1"
      }
    });

    expect(proposed.statusCode).toBe(202);
    expect(engine.calls).toEqual(["start:container-1"]);
    expect(proposed.json()).toMatchObject({
      operation: {
        action: "start",
        targetType: "container",
        status: "applied"
      }
    });
    expect(listOperationNotifications(db)).toEqual([]);
    expect(listPendingApprovals(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM jobs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM agent_messages").pluck().get()).toBe(0);
    await server.close();
  });

  it("executes direct container actions without creating an approval", async () => {
    const engine = new FakeDockerEngine();
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: {
        engine,
        compose: new FakeDockerCompose()
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/docker/containers/container-1/actions",
      payload: { action: "restart" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ action: "restart", containerId: "container-1" });
    expect(engine.calls).toContain("restart:container-1");
    expect(listDockerOperations(db)).toEqual([]);
    await server.close();
  });

  it("creates Docker resources directly and redacts sensitive audit values", async () => {
    const engine = new FakeDockerEngine();
    const server = await buildServer({ config: dockerEnabledConfig(tempDir), db, docker: { engine, compose: new FakeDockerCompose() } });
    const response = await server.inject({
      method: "POST",
      url: "/api/docker/actions",
      payload: {
        action: "create",
        targetType: "container",
        name: "new-container",
        image: "nginx",
        environment: { SECRET_TOKEN: "hidden" },
        labels: { purpose: "test" },
        start: false
      }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      operation: { status: "applied" },
      result: { kind: "container", created: true, started: false }
    });
    const operation = response.json().operation;
    expect(JSON.stringify(operation.metadata)).not.toContain("hidden");
    expect(engine.calls).toContain("create-container");
    await server.close();
  });

  it("keeps direct Host Access container input private", async () => {
    const engine = new FakeDockerEngine();
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: { engine, compose: new FakeDockerCompose() },
      hostAccess: { policy: new DockerHostAccessPolicy(db, { platform: "linux" }) }
    });
    const proposed = await server.inject({
      method: "POST",
      url: "/api/docker/actions",
      payload: {
        action: "create",
        targetType: "container",
        name: "host-observer",
        image: "collector:latest",
        start: false,
        environment: { SECRET_TOKEN: "private-value" },
        hostAccess: [{ capability: "host_processes" }]
      }
    });
    expect(proposed.statusCode).toBe(202);
    expect(engine.calls).toEqual(expect.arrayContaining(["pull", "resolve-image"]));
    expect(engine.calls).toContain("create-container");
    expect(proposed.json()).toMatchObject({
      operation: { status: "applied" },
      result: { kind: "container", created: true }
    });
    expect(JSON.stringify(proposed.json())).not.toContain("private-value");
    expect(JSON.stringify(proposed.json())).not.toContain("/proc");
    expect(JSON.stringify(proposed.json())).not.toContain("fingerprint");
    expect(JSON.stringify(proposed.json())).not.toContain("hostAccessDraft");

    expect(listPendingApprovals(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM jobs").pluck().get()).toBe(0);
    await server.close();
  });

  it("creates Docker volumes and networks directly with applied operation records", async () => {
    const engine = new FakeDockerEngine();
    const server = await buildServer({ config: dockerEnabledConfig(tempDir), db, docker: { engine, compose: new FakeDockerCompose() } });

    const volume = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
      action: "create", targetType: "volume", name: "archive", labels: { purpose: "backup" }
    } });
    const network = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
      action: "create",
      targetType: "network",
      name: "services",
      driver: "bridge",
      enableIpv4: true,
      enableIpv6: false,
      ipam: [{ subnet: "172.30.0.0/24", gateway: "172.30.0.1" }],
      labels: { zone: "services" }
    } });

    expect(volume.statusCode).toBe(202);
    expect(volume.json()).toMatchObject({ operation: { status: "applied", targetType: "volume" }, result: { kind: "volume", name: "archive", created: true } });
    expect(network.statusCode).toBe(202);
    expect(network.json()).toMatchObject({ operation: { status: "applied", targetType: "network" }, result: { kind: "network", name: "services", created: true } });
    expect(engine.calls).toEqual(["create-volume:archive", "create-network"]);
    await server.close();
  });

  it("always pulls images without requiring an image inspect first", async () => {
    const engine = new FakeDockerEngine();
    const server = await buildServer({ config: dockerEnabledConfig(tempDir), db, docker: { engine, compose: new FakeDockerCompose() } });
    await server.inject({ method: "POST", url: "/api/docker/registries", payload: {
      name: "Private", serverAddress: "registry.example.com", username: "builder", password: "create-secret"
    } });
    const response = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
      action: "create", targetType: "container", name: "always-pull",
      image: "registry.example.com/team/nginx", pullPolicy: "always", start: false
    } });

    expect(response.statusCode).toBe(202);
    expect(engine.calls).toEqual(["pull", "create-container"]);
    expect(engine.pullInputs[0]?.registryAuth).toBeTruthy();
    expect(JSON.stringify(response.json())).not.toContain("create-secret");
    await server.close();
  });

  it("reads rotated credentials after the missing-image check and before pulling", async () => {
    const engine = new FakeDockerEngine();
    const credential = createDockerRegistryCredential(db, { name: "Private", serverAddress: "registry.example.com", username: "builder", password: "old-secret" });
    engine.imageExists = async () => {
      updateDockerRegistryCredential(db, credential.id, { password: "rotated-secret" });
      return false;
    };
    const server = await buildServer({ config: dockerEnabledConfig(tempDir), db, docker: { engine, compose: new FakeDockerCompose(), daemon: new FakeDockerDaemon() } });
    const response = await server.inject({ method: "POST", url: "/api/docker/actions", payload: { action: "create", targetType: "container", name: "rotated-pull", image: "registry.example.com/team/app", pullPolicy: "missing", start: false } });
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(Buffer.from(engine.pullInputs[0]!.registryAuth!, "base64url").toString("utf8"))).toMatchObject({ password: "rotated-secret" });
    expect(response.body).not.toContain("rotated-secret");
    const invalid = await server.inject({ method: "POST", url: "/api/docker/actions", payload: { action: "create", targetType: "container", name: "invalid-pull", image: "team//app", pullPolicy: "always" } });
    expect(invalid.statusCode).toBe(400);
    expect(listDockerOperations(db)).toHaveLength(1);
    await server.close();
  });

  it("keeps a created container when automatic start fails", async () => {
    const engine = new FakeDockerEngine();
    engine.failStart = true;
    const server = await buildServer({ config: dockerEnabledConfig(tempDir), db, docker: { engine, compose: new FakeDockerCompose() } });
    const response = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
      action: "create", targetType: "container", name: "partial-container", image: "nginx"
    } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ result: { partialSuccess: true, started: false, id: "created-container" }, operation: { status: "failed" } });
    await server.close();
  });

  it("rejects duplicate Docker resource names and unknown create fields", async () => {
    const engine = new FakeDockerEngine();
    const server = await buildServer({ config: dockerEnabledConfig(tempDir), db, docker: { engine, compose: new FakeDockerCompose() } });
    const duplicate = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
      action: "create", targetType: "container", name: "media", image: "nginx"
    } });
    expect(duplicate.statusCode).toBe(409);
    const unknown = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
      action: "create", targetType: "volume", name: "other", driverOpts: {}
    } });
    expect(unknown.statusCode).toBe(400);
    const invalidRestart = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
      action: "create", targetType: "container", name: "other", image: "nginx",
      restartPolicy: "always", restartMaxRetries: 3
    } });
    expect(invalidRestart.statusCode).toBe(400);
    await server.close();
  });

  it("rejects bind mounts that expose the configured Docker socket through a parent directory", async () => {
    const engine = new FakeDockerEngine();
    const config = dockerEnabledConfig(tempDir, { socketPath: path.join(rootDir, "docker.sock") });
    saveDockerSettings(db, config.docker);
    const server = await buildServer({
      config,
      db,
      docker: { engine, compose: new FakeDockerCompose() }
    });
    const response = await server.inject({ method: "POST", url: "/api/docker/actions", payload: {
      action: "create",
      targetType: "container",
      name: "unsafe-bind",
      image: "nginx",
      start: false,
      mounts: [{ type: "bind", rootId: "local", sourcePath: ".", target: "/host", readOnly: true }]
    } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("Docker socket") });
    expect(engine.calls).not.toContain("create-container");
    await server.close();
  });

  it("records direct Docker action failures without creating Agent records", async () => {
    const engine = new FakeDockerEngine();
    engine.failStart = true;
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: {
        engine,
        compose: new FakeDockerCompose()
      }
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/docker/actions",
      payload: {
        action: "start",
        containerId: "container-1"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(listDockerOperations(db)).toEqual([expect.objectContaining({
      status: "failed"
    })]);
    expect(listPendingApprovals(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM jobs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM agent_messages").pluck().get()).toBe(0);
    await server.close();
  });

  it("rejects Compose actions outside configured projects", async () => {
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: {
        engine: new FakeDockerEngine(),
        compose: new FakeDockerCompose([])
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/docker/actions",
      payload: {
        action: "compose_up",
        composeProjectId: "missing"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Compose project is not configured" });
    await server.close();
  });

  it("loads current Registry credentials when a direct Compose pull executes", async () => {
    const compose = new FakeDockerCompose();
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: { engine: new FakeDockerEngine(), compose }
    });
    await server.inject({ method: "POST", url: "/api/docker/registries", payload: {
      name: "Private", serverAddress: "registry.example.com", username: "builder", password: "compose-secret"
    } });
    const response = await server.inject({
      method: "POST",
      url: "/api/docker/actions",
      payload: {
        action: "compose_pull",
        composeProjectId: "compose-root:compose.yml"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(compose.registryCredentials).toMatchObject([[
      { serverAddress: "registry.example.com", password: "compose-secret" }
    ]]);
    expect(response.body).not.toContain("compose-secret");
    await server.close();
  });

  it("rejects Compose service targets that are not part of the configured project", async () => {
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: {
        engine: new FakeDockerEngine(),
        compose: new FakeDockerCompose()
      }
    });

    const unknownService = await server.inject({
      method: "POST",
      url: "/api/docker/actions",
      payload: {
        action: "compose_restart",
        composeProjectId: "compose-root:compose.yml",
        service: "missing"
      }
    });
    const optionLikeService = await server.inject({
      method: "POST",
      url: "/api/docker/actions",
      payload: {
        action: "compose_restart",
        composeProjectId: "compose-root:compose.yml",
        service: "--profile"
      }
    });

    expect(unknownService.statusCode).toBe(400);
    expect(unknownService.json()).toEqual({ error: "Compose service is not part of the configured project" });
    expect(optionLikeService.statusCode).toBe(400);
    expect(optionLikeService.json()).toEqual({ error: "Compose service name is not allowed" });
    await server.close();
  });

  it("requires a full-project apply when Compose Host Access needs repair", async () => {
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: {
        engine: new FakeDockerEngine(),
        compose: new FakeDockerCompose([{
          id: "compose-root:compose.yml",
          name: "media",
          projectKey: "media",
          managedPath: "/zos/apps/media",
          services: ["jellyfin"],
          warnings: [],
          risk: "high",
          revision: "revision-1",
          deployedRevision: "revision-1",
          needsDeploy: false,
          hostAccessState: "needs_repair",
          containerCount: 1,
          runningCount: 1,
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }])
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/docker/actions",
      payload: {
        action: "compose_up",
        composeProjectId: "compose-root:compose.yml",
        service: "jellyfin"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Host Access changes or repairs require applying the entire Compose project"
    });
    await server.close();
  });

  it("creates console sessions from direct Docker console actions", async () => {
    const server = await buildServer({
      config: dockerEnabledConfig(tempDir),
      db,
      docker: {
        engine: new FakeDockerEngine(),
        compose: new FakeDockerCompose()
      }
    });
    const proposed = await server.inject({
      method: "POST",
      url: "/api/docker/actions",
      payload: {
        action: "console",
        containerId: "container-1",
        shell: "/bin/sh"
      }
    });
    const operationId = proposed.json().operation.id;
    const created = await server.inject({
      method: "POST",
      url: "/api/docker/console-sessions",
      payload: {
        operationId
      }
    });

    expect(proposed.statusCode).toBe(202);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      consoleSession: {
        operationId,
        containerId: "container-1",
        shell: "/bin/sh",
        websocketUrl: expect.stringContaining("/api/docker/console/")
      }
    });
    expect(listDockerOperations(db)).toEqual([expect.objectContaining({
      status: "approved",
      metadata: expect.objectContaining({
        consoleSessionId: created.json().consoleSession.id
      })
    })]);
    expect(listPendingApprovals(db)).toEqual([]);
    await server.close();
  });

  it("saves and masks third-party model provider settings", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const saved = await server.inject({
      method: "PATCH",
      url: "/api/settings/model-provider",
      payload: {
        providerName: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "anthropic/claude-sonnet-4",
        apiKey: "secret-token"
      }
    });
    const loaded = await server.inject({
      method: "GET",
      url: "/api/settings/model-provider"
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      settings: {
        providerName: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "anthropic/claude-sonnet-4",
        apiKeyConfigured: true
      }
    });
    expect(saved.payload).not.toContain("secret-token");
    expect(loaded.json()).toMatchObject({
      settings: {
        apiKeyConfigured: true
      }
    });
    await server.close();
  });

  it("clears saved model provider model names", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    await server.inject({
      method: "PATCH",
      url: "/api/settings/model-provider",
      payload: {
        providerName: "anthropic",
        baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
        model: "qwen3.8-max",
        apiKey: "secret-token"
      }
    });

    const response = await server.inject({
      method: "PATCH",
      url: "/api/settings/model-provider",
      payload: {
        model: ""
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      settings: {
        providerName: "anthropic",
        baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
        model: "",
        apiKeyConfigured: true
      }
    });
    expect(response.payload).not.toContain("secret-token");
    await server.close();
  });

  it("rejects unsupported model provider names", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "PATCH",
      url: "/api/settings/model-provider",
      payload: {
        providerName: "openrouter",
        model: "anthropic/claude-sonnet-4"
      }
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("clears saved model provider API keys", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    await server.inject({
      method: "PATCH",
      url: "/api/settings/model-provider",
      payload: {
        providerName: "anthropic",
        apiKey: "secret-token"
      }
    });

    const response = await server.inject({
      method: "PATCH",
      url: "/api/settings/model-provider",
      payload: {
        clearApiKey: true
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      settings: {
        providerName: "anthropic",
        apiKeyConfigured: false
      }
    });
    await server.close();
  });

  it("saves Agent capability policies and rejects unknown modes", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const defaults = await server.inject({
      method: "GET",
      url: "/api/settings/agent-capability-policy"
    });
    const saved = await server.inject({
      method: "PATCH",
      url: "/api/settings/agent-capability-policy",
      payload: {
        policies: {
          "zos.files.read": "approve",
          "zos.shell.run": "disabled"
        }
      }
    });
    const invalid = await server.inject({
      method: "PATCH",
      url: "/api/settings/agent-capability-policy",
      payload: {
        policies: {
          "zos.shell.run": "unknown"
        }
      }
    });

    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({
      settings: {
        policies: {
          "zos.files.list": "auto",
          "zos.files.read": "auto",
          "zos.files.search": "auto",
          "zos.files.grep": "auto",
          "zos.files.find": "auto",
          "zos.files.mutate": "approve",
          "zos.files.edit": "approve",
          "zos.files.write": "approve",
          "zos.shell.run": "confirm"
        }
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      settings: {
        policies: {
          "zos.files.read": "approve",
          "zos.shell.run": "disabled"
        }
      }
    });
    expect(invalid.statusCode).toBe(400);
    await server.close();
  });

  it("rejects escaped file paths", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=..`
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("validates session paths before persisting them", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        rootId: "local",
        path: ".."
      }
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("lists recent sessions for a root", async () => {
    const session = createSession(db, { rootId: "local", currentPath: "." });
    createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "Summarize downloads"
    });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "GET",
      url: "/api/sessions?rootId=local"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessions: [
        {
          id: session.id,
          rootId: "local",
          currentPath: ".",
          firstMessage: "Summarize downloads",
          lastMessage: "Summarize downloads"
        }
      ]
    });
    await server.close();
  });

  it("updates session paths through safe directory validation", async () => {
    await mkdir(path.join(rootDir, "docs"));
    const session = createSession(db, { rootId: "local", currentPath: "." });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const updated = await server.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: {
        path: "docs"
      }
    });
    const escaped = await server.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: {
        path: ".."
      }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      session: {
        id: session.id,
        currentPath: "docs"
      }
    });
    expect(escaped.statusCode).toBe(400);
    await server.close();
  });

  it("isolates Pi capability approvals to their source Agent session", async () => {
    const firstSession = createSession(db, { rootId: "local" });
    const secondSession = createSession(db, { rootId: "local" });
    const firstJob = createUserMessageAndJob(db, {
      sessionId: firstSession.id,
      content: "Create the first folder",
      status: "waiting_approval"
    }).job;
    const secondJob = createUserMessageAndJob(db, {
      sessionId: secondSession.id,
      content: "Create the second folder",
      status: "waiting_approval"
    }).job;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
    const first = createCapabilityProposal(db, {
      subjectId: "pi:first",
      subjectKind: "pi",
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: { operation: "mkdir", targetPath: "first" },
      proposal: { summary: "Create first", targetPath: "first" },
      expiresAt
    });
    const second = createCapabilityProposal(db, {
      subjectId: "pi:second",
      subjectKind: "pi",
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: { operation: "mkdir", targetPath: "second" },
      proposal: { summary: "Create second", targetPath: "second" },
      expiresAt
    });
    const unlinked = createCapabilityProposal(db, {
      subjectId: "pi:unlinked",
      subjectKind: "pi",
      capabilityId: "zos.files.mutate",
      risk: "high",
      redactedInput: { operation: "mkdir", targetPath: "unlinked" },
      proposal: { summary: "Create unlinked", targetPath: "unlinked" },
      expiresAt
    });
    linkAgentJobToCapabilityRun(db, { jobId: firstJob.id, runId: first.run.id });
    linkAgentJobToCapabilityRun(db, { jobId: secondJob.id, runId: second.run.id });
    const server = await buildServer({ config: testConfig(tempDir), db });

    expect((await server.inject({ method: "GET", url: "/api/approvals" })).statusCode).toBe(400);
    const firstApprovals = await server.inject({
      method: "GET",
      url: `/api/approvals?sessionId=${firstSession.id}`
    });
    const secondApprovals = await server.inject({
      method: "GET",
      url: `/api/approvals?sessionId=${secondSession.id}`
    });
    expect(firstApprovals.json().capabilityApprovals).toEqual([
      expect.objectContaining({ id: first.approval.id, sessionId: firstSession.id })
    ]);
    expect(secondApprovals.json().capabilityApprovals).toEqual([
      expect.objectContaining({ id: second.approval.id, sessionId: secondSession.id })
    ]);

    const sessions = await server.inject({ method: "GET", url: "/api/sessions?rootId=local" });
    expect(sessions.json().sessions.find((session: { id: string }) => session.id === firstSession.id))
      .toMatchObject({ pendingApprovalCount: 1 });
    expect(sessions.json().sessions.find((session: { id: string }) => session.id === secondSession.id))
      .toMatchObject({ pendingApprovalCount: 1 });

    const unlinkedDecision = await server.inject({
      method: "POST",
      url: `/api/capability-approvals/${unlinked.approval.id}/decision`,
      payload: { sessionId: firstSession.id, decision: "rejected", expectedRevision: unlinked.approval.revision }
    });
    expect(unlinkedDecision.statusCode).toBe(404);

    const crossSessionDecision = await server.inject({
      method: "POST",
      url: `/api/capability-approvals/${first.approval.id}/decision`,
      payload: { sessionId: secondSession.id, decision: "rejected", expectedRevision: first.approval.revision }
    });
    expect(crossSessionDecision.statusCode).toBe(404);

    const rejected = await server.inject({
      method: "POST",
      url: `/api/capability-approvals/${first.approval.id}/decision`,
      payload: { sessionId: firstSession.id, decision: "rejected", expectedRevision: first.approval.revision }
    });
    expect(rejected.statusCode).toBe(200);
    const refreshed = await server.inject({ method: "GET", url: "/api/sessions?rootId=local" });
    expect(refreshed.json().sessions.find((session: { id: string }) => session.id === firstSession.id))
      .toMatchObject({ pendingApprovalCount: 0 });
    expect(refreshed.json().sessions.find((session: { id: string }) => session.id === secondSession.id))
      .toMatchObject({ pendingApprovalCount: 1 });
    await server.close();
  });

  it("protects sessions waiting for approval and cascades rows after work completes", async () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "Summarize downloads"
    });
    appendEvent(db, {
      sessionId: session.id,
      jobId: job.id,
      type: "agent.completed",
      payload: { summary: "done" }
    });
    createPendingApproval(db, {
      jobId: job.id,
      proposal: [
        {
          operation: "rename",
          rootId: "local",
          sourcePath: "hello.txt",
          targetPath: "renamed.txt",
          risk: "low",
          reversible: true,
          summary: "Rename hello.txt"
        }
      ]
    });
    updateJobStatus(db, job.id, "waiting_approval");
    const server = await buildServer({ config: testConfig(tempDir), db });

    const activeResponse = await server.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}`
    });

    expect(activeResponse.statusCode).toBe(409);
    expect(activeResponse.json()).toEqual({ error: "Session has active work" });
    expect(getSession(db, session.id)).toMatchObject({ id: session.id });
    expect(listPendingApprovals(db)).toHaveLength(1);

    updateJobStatus(db, job.id, "completed");
    const completedResponse = await server.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}`
    });

    expect(completedResponse.statusCode).toBe(204);
    expect(getSession(db, session.id)).toBeNull();
    expect(listMessages(db, { sessionId: session.id })).toEqual([]);
    expect(listEvents(db, { sessionId: session.id })).toEqual([]);
    expect(getJob(db, job.id)).toBeNull();
    expect(listPendingApprovals(db)).toEqual([]);
    expect(listFileOperations(db)).toHaveLength(1);
    await server.close();
  });

  it("rejects deleting sessions with active work", async () => {
    const session = createSession(db, { rootId: "local" });
    createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "Summarize downloads"
    });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}`
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Session has active work" });
    expect(getSession(db, session.id)).toMatchObject({ id: session.id });
    await server.close();
  });

  it("reconstructs chat transcripts from user messages and agent events", async () => {
    const session = createSession(db, { rootId: "local" });
    const first = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List this folder"
    });
    const firstReply = appendEvent(db, {
      sessionId: session.id,
      jobId: first.job.id,
      type: "agent.message",
      payload: {
        role: "assistant",
        content: "hello.txt is available"
      }
    });
    const second = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "Open it"
    });
    const failure = appendEvent(db, {
      sessionId: session.id,
      jobId: second.job.id,
      type: "job.failed",
      payload: { error: "Preview unavailable" }
    });
    db.prepare("UPDATE agent_messages SET created_at = ? WHERE id = ?")
      .run("2099-01-01T00:00:00.000Z", first.message.id);
    db.prepare("UPDATE agent_events SET created_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", firstReply.id);
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/transcript`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().transcript).toEqual([
      {
        id: `message:${first.message.id}`,
        role: "user",
        content: "List this folder",
        createdAt: "2099-01-01T00:00:00.000Z",
        sequence: first.transcriptSequence
      },
      {
        id: `event:${firstReply.id}`,
        role: "assistant",
        content: "hello.txt is available",
        createdAt: "2000-01-01T00:00:00.000Z",
        sequence: firstReply.transcriptSequence
      },
      {
        id: `message:${second.message.id}`,
        role: "user",
        content: "Open it",
        createdAt: second.message.createdAt,
        sequence: second.transcriptSequence
      },
      {
        id: `event:${failure.id}`,
        role: "assistant",
        content: "Agent failed: Preview unavailable",
        createdAt: failure.createdAt,
        sequence: failure.transcriptSequence
      }
    ]);
    await server.close();
  });

  it("includes failed jobs in chat transcripts without duplicating agent failure events", async () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "hello"
    });
    appendEvent(db, {
      sessionId: session.id,
      jobId: job.id,
      type: "agent.failed",
      payload: {
        provider: "pi",
        error: "Pi model is unavailable"
      }
    });
    appendEvent(db, {
      sessionId: session.id,
      jobId: job.id,
      type: "job.failed",
      payload: {
        error: "Pi model is unavailable"
      }
    });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/transcript`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      transcript: [
        {
          role: "user",
          content: "hello"
        },
        {
          role: "assistant",
          content: "Agent failed: Pi model is unavailable"
        }
      ]
    });
    await server.close();
  });

  it("keeps internal action failures out of chat titles and transcripts", async () => {
    const session = createSession(db, { rootId: "local" });
    const action = createActionMessageAndJob(db, {
      sessionId: session.id,
      content: "Restart container alpha",
      kind: "docker",
      status: "running"
    });
    appendEvent(db, {
      sessionId: session.id,
      jobId: action.job.id,
      type: "job.failed",
      payload: { jobId: action.job.id, error: "Docker is unavailable" }
    });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const transcript = await server.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/transcript`
    });
    const sessions = await server.inject({ method: "GET", url: "/api/sessions?rootId=local" });

    expect(transcript.statusCode).toBe(200);
    expect(transcript.json().transcript).toEqual([]);
    expect(sessions.json().sessions[0]).toMatchObject({ firstMessage: null, lastMessage: null });
    expect(listEvents(db, { sessionId: session.id }).at(-1)).toMatchObject({ audience: "notification" });
    await server.close();
  });

  it("persists composer messages as user chat messages", async () => {
    const session = createSession(db, { rootId: "local" });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: { content: "Show disk usage" }
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.message).toMatchObject({ role: "user", content: "Show disk usage" });
    expect(body).not.toHaveProperty("transcriptSequence");
    expect(body.transcriptMessage).toEqual({
      id: `message:${body.message.id}`,
      role: "user",
      content: "Show disk usage",
      createdAt: body.message.createdAt,
      sequence: expect.any(Number)
    });
    expect(listMessages(db, { sessionId: session.id })).toMatchObject([
      { role: "user", content: "Show disk usage" }
    ]);
    await server.close();
  });

  it("streams transcript sequence metadata with chat events", async () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createUserMessageAndJob(db, { sessionId: session.id, content: "Hello" });
    const event = appendEvent(db, {
      sessionId: session.id,
      jobId: job.id,
      type: "agent.message",
      payload: { content: "Hi" }
    });
    const server = await buildServer({ config: testConfig(tempDir), db });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP listener");
    }
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${session.id}/events`, {
        signal: controller.signal
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      let streamText = "";
      while (!streamText.includes(`id: ${event.id}\n`)) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        streamText += new TextDecoder().decode(chunk.value, { stream: true });
      }
      const dataLine = streamText.split("\n").find((line) => line.startsWith("data: "));
      expect(dataLine).toBeDefined();
      expect(JSON.parse(dataLine?.slice(6) ?? "{}")).toMatchObject({
        id: event.id,
        transcriptSequence: event.transcriptSequence
      });
    } finally {
      controller.abort();
      await server.close();
    }
  });

  it("lists and marks persistent operation notifications", async () => {
    const session = createSession(db, { rootId: "local" });
    const first = createActionMessageAndJob(db, {
      sessionId: session.id,
      content: "Move report.txt",
      kind: "file",
      status: "waiting_approval"
    });
    createActionMessageAndJob(db, {
      sessionId: session.id,
      content: "Apply share settings",
      kind: "share",
      status: "waiting_approval"
    });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const listed = await server.inject({ method: "GET", url: "/api/notifications?limit=100" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ unreadCount: 2, notifications: expect.any(Array) });

    const read = await server.inject({ method: "PATCH", url: `/api/notifications/${first.notification.id}/read` });
    expect(read.statusCode).toBe(200);
    expect(read.json().notification.readAt).not.toBeNull();
    expect(read.json().unreadCount).toBe(1);

    const allRead = await server.inject({ method: "POST", url: "/api/notifications/read-all" });
    expect(allRead.statusCode).toBe(200);
    expect(allRead.json()).toEqual({ updated: 1 });
    expect(listOperationNotifications(db).every((notification) => notification.readAt !== null)).toBe(true);

    const missing = await server.inject({ method: "PATCH", url: "/api/notifications/missing/read" });
    const invalidLimit = await server.inject({ method: "GET", url: "/api/notifications?limit=101" });
    expect(missing.statusCode).toBe(404);
    expect(invalidLimit.statusCode).toBe(400);
    await server.close();
  });

  it("marks a cancelled action notification without creating chat output", async () => {
    const session = createSession(db, { rootId: "local" });
    const action = createActionMessageAndJob(db, {
      sessionId: session.id,
      content: "Move archive",
      kind: "file",
      status: "waiting_approval"
    });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const cancelled = await server.inject({ method: "POST", url: `/api/jobs/${action.job.id}/cancel` });
    const transcript = await server.inject({ method: "GET", url: `/api/sessions/${session.id}/transcript` });

    expect(cancelled.statusCode).toBe(202);
    expect(listOperationNotifications(db)).toMatchObject([
      { jobId: action.job.id, status: "cancelled", readAt: null }
    ]);
    expect(listPendingApprovals(db)).toEqual([]);
    expect(transcript.json().transcript).toEqual([]);
    await server.close();
  });

  it("returns file preview metadata", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files/meta?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=hello.txt`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      meta: {
        name: "hello.txt",
        kind: "file",
        mimeType: "text/plain",
        previewKind: "text",
        sizeBytes: 5
      }
    });
    await server.close();
  });

  it.each([
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
    ["budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "spreadsheet"],
    ["roadmap.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "presentation"]
  ] as const)("returns Office preview metadata for %s", async (name, mimeType, previewKind) => {
    await writeFile(path.join(rootDir, name), "placeholder");
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files/meta?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=${name}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ meta: { name, mimeType, previewKind } });
    await server.close();
  });

  it("caps text previews", async () => {
    await writeFile(path.join(rootDir, "long.txt"), "abcdef");
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files/text?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=long.txt&maxBytes=3`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      path: "long.txt",
      content: "abc",
      truncated: true,
      maxBytes: 3
    });
    await server.close();
  });

  it("previews generic octet-stream files as text", async () => {
    await writeFile(path.join(rootDir, "payload.bin"), "raw payload");
    const server = await buildServer({ config: testConfig(tempDir), db });
    const metaResponse = await server.inject({
      method: "GET",
      url: `/api/files/meta?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=payload.bin`
    });
    const textResponse = await server.inject({
      method: "GET",
      url: `/api/files/text?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=payload.bin&maxBytes=64`
    });

    expect(metaResponse.statusCode).toBe(200);
    expect(metaResponse.json()).toMatchObject({
      meta: {
        name: "payload.bin",
        mimeType: "application/octet-stream",
        previewKind: "text"
      }
    });
    expect(textResponse.statusCode).toBe(200);
    expect(textResponse.json()).toMatchObject({
      path: "payload.bin",
      content: "raw payload",
      truncated: false
    });
    await server.close();
  });

  it("writes editable text without edit approval", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const editable = await server.inject({
      method: "GET",
      url: `/api/files/edit-text?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=hello.txt`
    });
    const save = await server.inject({
      method: "PUT",
      url: "/api/files/edit-text",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        path: "hello.txt",
        content: "changed",
        expectedModifiedAt: editable.json().modifiedAt
      }
    });

    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({
      meta: {
        path: "hello.txt",
        previewKind: "text"
      },
      textPreview: {
        path: "hello.txt",
        content: "changed",
        truncated: false
      },
      operation: {
        operation: "edit",
        approvalId: null,
        status: "applied",
        sourcePath: "hello.txt"
      }
    });
    await expect(readFile(path.join(rootDir, "hello.txt"), "utf8")).resolves.toBe("changed");
    expect(db.prepare(`
      SELECT storage_pool_id, path, recursive, kind, status
      FROM index_queue WHERE root_id = 'local' AND path = 'hello.txt'
    `).get()).toEqual({
      storage_pool_id: TEST_STORAGE_POOL_ID,
      path: "hello.txt",
      recursive: 0,
      kind: "incremental",
      status: "queued"
    });
    await server.close();
  });

  it("uploads files directly into nested directories", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "PUT",
      url: `/api/files/upload?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=docs/uploads/notes.txt`,
      headers: {
        "content-type": "application/octet-stream"
      },
      payload: "uploaded body"
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      meta: {
        path: "docs/uploads/notes.txt",
        name: "notes.txt"
      },
      operation: {
        operation: "upload",
        targetPath: "docs/uploads/notes.txt",
        status: "applied",
        metadata: {
          rootId: "local",
          reversible: true
        }
      }
    });
    await expect(readFile(path.join(rootDir, "docs", "uploads", "notes.txt"), "utf8")).resolves.toBe("uploaded body");
    expect(db.prepare(`
      SELECT storage_pool_id, path, recursive, kind, status
      FROM index_queue WHERE root_id = 'local' AND path = 'docs/uploads/notes.txt'
    `).get()).toEqual({
      storage_pool_id: TEST_STORAGE_POOL_ID,
      path: "docs/uploads/notes.txt",
      recursive: 0,
      kind: "incremental",
      status: "queued"
    });
    await server.close();
  });

  it("rejects upload target conflicts", async () => {
    await writeFile(path.join(rootDir, "existing.txt"), "old");
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "PUT",
      url: `/api/files/upload?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=existing.txt`,
      headers: {
        "content-type": "application/octet-stream"
      },
      payload: "new"
    });

    expect(response.statusCode).toBe(409);
    await expect(readFile(path.join(rootDir, "existing.txt"), "utf8")).resolves.toBe("old");
    await server.close();
  });

  it("applies file panel mutations directly without creating approvals", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });

    const folder = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "mkdir",
        targetPath: "projects"
      }
    });
    expect(folder.statusCode).toBe(201);
    expect(folder.json()).toMatchObject({
      operation: {
        approvalId: null,
        operation: "mkdir",
        targetPath: "projects",
        status: "applied"
      },
      targetPath: "projects"
    });
    await expect(stat(path.join(rootDir, "projects"))).resolves.toMatchObject({});

    const rename = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "rename",
        sourcePath: "hello.txt",
        targetName: "renamed.txt"
      }
    });
    expect(rename.statusCode).toBe(201);
    expect(rename.json().operation).toMatchObject({
      approvalId: null,
      operation: "rename",
      sourcePath: "hello.txt",
      targetPath: "renamed.txt",
      status: "applied"
    });
    await expect(stat(path.join(rootDir, "hello.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(rootDir, "renamed.txt"), "utf8")).resolves.toBe("hello");

    const copy = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "copy",
        sourcePath: "renamed.txt",
        targetPath: "projects/copied.txt"
      }
    });
    expect(copy.statusCode).toBe(201);
    expect(copy.json().operation).toMatchObject({
      approvalId: null,
      operation: "copy",
      sourcePath: "renamed.txt",
      targetPath: "projects/copied.txt",
      status: "applied"
    });
    await expect(readFile(path.join(rootDir, "renamed.txt"), "utf8")).resolves.toBe("hello");
    await expect(readFile(path.join(rootDir, "projects", "copied.txt"), "utf8")).resolves.toBe("hello");

    expect(listPendingApprovals(db)).toHaveLength(0);
    expect(listOperationNotifications(db)).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) FROM jobs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM agent_messages").pluck().get()).toBe(0);
    expect(listFileOperations(db)).toHaveLength(3);
    await server.close();
  });

  it("keeps direct file mutations inside the selected storage pool", async () => {
    const poolDir = path.join(rootDir, "pool");
    await mkdir(poolDir);
    await writeFile(path.join(poolDir, "inside.txt"), "inside");
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner: testStorageCommandRunnerFor(poolDir) }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "copy",
        sourcePath: "pool/inside.txt",
        targetPath: "outside.txt"
      }
    });

    expect(response.statusCode).toBe(403);
    await expect(stat(path.join(rootDir, "outside.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(listFileOperations(db)).toHaveLength(0);
    expect(listPendingApprovals(db)).toHaveLength(0);
    await server.close();
  });

  it("keeps a successful file mutation successful when photo refresh enqueue fails", async () => {
    await mkdir(path.join(rootDir, "photos"));
    savePhotostaffLibrarySettings(db, {
      rootId: "local",
      storagePoolId: TEST_STORAGE_POOL_ID,
      path: "photos"
    });
    db.exec(`
      CREATE TRIGGER reject_photostaff_job_insert
      BEFORE INSERT ON photostaff_jobs
      BEGIN
        SELECT RAISE(ABORT, 'photo queue unavailable');
      END
    `);
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "mkdir",
        targetPath: "photos/new-album"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().operation).toMatchObject({
      approvalId: null,
      operation: "mkdir",
      targetPath: "photos/new-album",
      status: "applied"
    });
    await expect(stat(path.join(rootDir, "photos", "new-album"))).resolves.toMatchObject({});
    expect(listPendingApprovals(db)).toHaveLength(0);
    await server.close();
  });

  it("queues direct file batches without creating approvals", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/batches",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "trash",
        sourcePaths: ["hello.txt"]
      }
    });

    expect(response.statusCode).toBe(202);
    const batchId = response.json().batch.id as string;
    expect(getFileBatch(db, batchId)).toMatchObject({
      operation: "trash",
      totalCount: 1
    });
    expect(listPendingApprovals(db)).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) FROM jobs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM agent_messages").pluck().get()).toBe(0);

    await vi.waitFor(() => {
      expect(getFileBatch(db, batchId)?.status).toBe("completed");
    });
    await expect(stat(path.join(rootDir, "hello.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(listFileOperations(db).find((operation) => operation.metadata.fileBatchId === batchId)).toMatchObject({
      approvalId: null,
      operation: "trash",
      status: "applied"
    });
    await server.close();
  });

  it("extracts an archive directly without creating an approval", async () => {
    await execFileAsync("zip", ["-q", path.join(rootDir, "bundle.zip"), "hello.txt"], { cwd: rootDir });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/extract",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        path: "bundle.zip"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      operation: {
        operation: "extract",
        approvalId: null,
        sourcePath: "bundle.zip",
        targetPath: "bundle",
        status: "applied"
      }
    });
    await expect(readFile(path.join(rootDir, "bundle", "hello.txt"), "utf8")).resolves.toBe("hello");
    expect(listPendingApprovals(db)).toHaveLength(0);
    await server.close();
  });

  it("keeps extraction out of the generic mutation endpoint", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "extract",
        sourcePath: "bundle.zip"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Unsupported direct file mutation operation" });
    expect(listPendingApprovals(db)).toHaveLength(0);
    await server.close();
  });

  it("rejects moving or copying a folder into itself", async () => {
    await mkdir(path.join(rootDir, "folder", "child"), { recursive: true });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "copy",
        sourcePath: "folder",
        targetPath: "folder/child/folder"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Cannot transfer a folder into itself" });
    await server.close();
  });

  it("refuses direct file mutations against the NAS root itself", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "trash",
        sourcePath: "."
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Cannot mutate the storage pool root" });
    await server.close();
  });

  it("refuses stale editable text saves", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const editable = await server.inject({
      method: "GET",
      url: `/api/files/edit-text?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=hello.txt`
    });
    await writeFile(path.join(rootDir, "hello.txt"), "external");

    const save = await server.inject({
      method: "PUT",
      url: "/api/files/edit-text",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        path: "hello.txt",
        content: "changed",
        expectedModifiedAt: editable.json().modifiedAt
      }
    });

    expect(save.statusCode).toBe(409);
    await expect(readFile(path.join(rootDir, "hello.txt"), "utf8")).resolves.toBe("external");
    await server.close();
  });

  it("refuses editable text access through symlinks", async () => {
    await symlink(path.join(rootDir, "hello.txt"), path.join(rootDir, "hello-link.txt"));
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files/edit-text?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=hello-link.txt`
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Refusing to edit through a symlink" });
    await server.close();
  });

  it("streams file blobs", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files/blob?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=hello.txt`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.payload).toBe("hello");
    await server.close();
  });

  it("downloads file blobs with an attachment filename", async () => {
    const fileName = "报告.txt";
    await writeFile(path.join(rootDir, fileName), "report");
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files/blob?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=${encodeURIComponent(fileName)}&download=1`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="__.txt"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    expect(response.payload).toBe("report");
    await server.close();
  });

  it("streams folders and mixed selections as one-time zip exports", async () => {
    const folderName = "报告";
    await mkdir(path.join(rootDir, folderName));
    await mkdir(path.join(rootDir, folderName, "empty"));
    await writeFile(path.join(rootDir, folderName, ".hidden.txt"), "hidden");
    const server = await buildServer({ config: testConfig(tempDir), db });

    const created = await server.inject({
      method: "POST",
      url: "/api/files/exports",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        sourcePaths: [folderName, "hello.txt"]
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      fileName: "test-pool-selection.zip"
    });
    expect(created.json().url).toMatch(/^\/api\/files\/exports\//u);
    expect(created.json().expiresAt).toMatch(/Z$/u);

    const archive = await server.inject({ method: "GET", url: created.json().url });
    expect(archive.statusCode).toBe(200);
    expect(archive.headers["content-type"]).toBe("application/zip");
    expect(archive.headers["cache-control"]).toBe("no-store");
    expect(archive.headers["content-disposition"]).toContain("test-pool-selection.zip");
    expect(archive.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(archive.rawPayload.includes(Buffer.from(`${folderName}/`))).toBe(true);
    expect(archive.rawPayload.includes(Buffer.from(`${folderName}/empty/`))).toBe(true);
    expect(archive.rawPayload.includes(Buffer.from(`${folderName}/.hidden.txt`))).toBe(true);
    expect(archive.rawPayload.includes(Buffer.from("hello.txt"))).toBe(true);

    const reused = await server.inject({ method: "GET", url: created.json().url });
    expect(reused.statusCode).toBe(404);
    await server.close();
  });

  it("names pool-root selections after the visible mountpoint", async () => {
    const poolDir = path.join(rootDir, "pool1");
    await mkdir(poolDir);
    await writeFile(path.join(poolDir, "first.txt"), "first");
    await writeFile(path.join(poolDir, "second.txt"), "second");
    const poolId = "/dev/md/pool1";
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner: testStorageCommandRunnerFor(poolDir, poolId) }
    });

    const created = await server.inject({
      method: "POST",
      url: "/api/files/exports",
      payload: {
        rootId: "local",
        storagePoolId: poolId,
        sourcePaths: ["pool1/first.txt", "pool1/second.txt"]
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().fileName).toBe("pool1-selection.zip");
    await server.close();
  });

  it("names single-folder exports after the selected folder and expires unused tokens", async () => {
    await mkdir(path.join(rootDir, "photos"));
    const server = await buildServer({ config: testConfig(tempDir), db });
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    const created = await server.inject({
      method: "POST",
      url: "/api/files/exports",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        sourcePaths: ["photos"]
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().fileName).toBe("photos.zip");

    nowSpy.mockReturnValue(now + 5 * 60 * 1_000 + 1);
    const expired = await server.inject({ method: "GET", url: created.json().url });
    expect(expired.statusCode).toBe(404);
    nowSpy.mockRestore();
    await server.close();
  });

  it("renames duplicate top-level archive entries in stable source order", async () => {
    await mkdir(path.join(rootDir, "one"));
    await mkdir(path.join(rootDir, "two"));
    await writeFile(path.join(rootDir, "one", "report.txt"), "first");
    await writeFile(path.join(rootDir, "two", "report.txt"), "second");
    const server = await buildServer({ config: testConfig(tempDir), db });

    const created = await server.inject({
      method: "POST",
      url: "/api/files/exports",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        sourcePaths: ["one/report.txt", "two/report.txt"]
      }
    });
    const archive = await server.inject({ method: "GET", url: created.json().url });

    expect(archive.statusCode).toBe(200);
    expect(archive.rawPayload.includes(Buffer.from("report.txt"))).toBe(true);
    expect(archive.rawPayload.includes(Buffer.from("report-2.txt"))).toBe(true);
    await server.close();
  });

  it("consumes the export token when a source disappears before download", async () => {
    await writeFile(path.join(rootDir, "temporary.txt"), "temporary");
    const server = await buildServer({ config: testConfig(tempDir), db });
    const created = await server.inject({
      method: "POST",
      url: "/api/files/exports",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        sourcePaths: ["temporary.txt"]
      }
    });
    await rm(path.join(rootDir, "temporary.txt"));

    const missing = await server.inject({ method: "GET", url: created.json().url });
    const reused = await server.inject({ method: "GET", url: created.json().url });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "One or more export sources no longer exist" });
    expect(reused.statusCode).toBe(404);
    await server.close();
  });

  it("rejects empty, duplicate, traversing, and symlink file exports", async () => {
    await symlink(path.join(rootDir, "hello.txt"), path.join(rootDir, "hello-link.txt"));
    const server = await buildServer({ config: testConfig(tempDir), db });
    const basePayload = { rootId: "local", storagePoolId: TEST_STORAGE_POOL_ID };

    const empty = await server.inject({
      method: "POST",
      url: "/api/files/exports",
      payload: { ...basePayload, sourcePaths: [] }
    });
    const duplicate = await server.inject({
      method: "POST",
      url: "/api/files/exports",
      payload: { ...basePayload, sourcePaths: ["hello.txt", "./hello.txt"] }
    });
    const traversal = await server.inject({
      method: "POST",
      url: "/api/files/exports",
      payload: { ...basePayload, sourcePaths: ["../outside.txt"] }
    });
    const link = await server.inject({
      method: "POST",
      url: "/api/files/exports",
      payload: { ...basePayload, sourcePaths: ["hello-link.txt"] }
    });

    expect(empty.statusCode).toBe(400);
    expect(duplicate.statusCode).toBe(400);
    expect(traversal.statusCode).toBe(400);
    expect(link.statusCode).toBe(400);
    await server.close();
  });

  it("does not cross nested storage pools while exporting directories", async () => {
    const exportDirectory = path.join(rootDir, "exported");
    const nestedPool = path.join(exportDirectory, "nested-pool");
    await mkdir(nestedPool, { recursive: true });
    await writeFile(path.join(exportDirectory, "visible.txt"), "visible");
    await writeFile(path.join(nestedPool, "private.txt"), "private");
    const nestedPoolId = "/dev/md/nested-pool";
    const nestedRunner: SystemCommandRunner = {
      async run(command, args) {
        if (command === "lsblk") return JSON.stringify({ blockdevices: [] });
        if (command === "findmnt") {
          return JSON.stringify({
            filesystems: [
              { source: TEST_STORAGE_POOL_ID, target: rootDir, fstype: "ext4", size: 1024, used: 128, avail: 896, "use%": "12.5%" },
              { source: nestedPoolId, target: nestedPool, fstype: "ext4", size: 512, used: 64, avail: 448, "use%": "12.5%" }
            ]
          });
        }
        if (command === "mdadm" && args[0] === "--detail" && args[1] === "--scan") {
          return `ARRAY ${TEST_STORAGE_POOL_ID} name=test-pool UUID=test-pool\nARRAY ${nestedPoolId} name=nested-pool UUID=nested-pool`;
        }
        if (command === "mdadm" && args[0] === "--detail") {
          const nested = args[1] === nestedPoolId;
          return [
            `Name : ${nested ? "nested-pool" : "test-pool"}`,
            "Raid Level : raid1",
            "State : clean",
            `UUID : ${nested ? "nested-pool" : "test-pool"}`,
            "Array Size : 1024 KiB"
          ].join("\n");
        }
        if (command === "smartctl") return JSON.stringify({ devices: [] });
        return JSON.stringify({});
      }
    };
    const server = await buildServer({
      config: testConfig(tempDir),
      db,
      system: { commandRunner: nestedRunner }
    });

    const created = await server.inject({
      method: "POST",
      url: "/api/files/exports",
      payload: { rootId: "local", storagePoolId: TEST_STORAGE_POOL_ID, sourcePaths: ["exported"] }
    });
    expect(created.statusCode).toBe(201);
    const archive = await server.inject({ method: "GET", url: created.json().url });
    expect(archive.statusCode).toBe(200);
    expect(archive.rawPayload.includes(Buffer.from("exported/visible.txt"))).toBe(true);
    expect(archive.rawPayload.includes(Buffer.from("private.txt"))).toBe(false);
    await server.close();
  });

  it("streams byte ranges for file blobs", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files/blob?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=hello.txt`,
      headers: {
        range: "bytes=1-3"
      }
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 1-3/5");
    expect(response.payload).toBe("ell");
    await server.close();
  });

  it("rejects invalid byte ranges", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files/blob?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=hello.txt`,
      headers: {
        range: "bytes=99-120"
      }
    });

    expect(response.statusCode).toBe(416);
    expect(response.headers["content-range"]).toBe("bytes */5");
    await server.close();
  });

  it("streams native videos and supports byte ranges", async () => {
    await writeFile(path.join(rootDir, "clip.mp4"), "native-video");
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files/video?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=clip.mp4`,
      headers: {
        range: "bytes=1-5"
      }
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-type"]).toContain("video/mp4");
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-range"]).toBe("bytes 1-5/12");
    expect(response.payload).toBe("ative");
    await server.close();
  });

  it("transcodes non-native videos once and reuses the cached MP4", async () => {
    await writeFile(path.join(rootDir, "clip.mkv"), "source-video");
    const transcode = vi.fn(async (_inputPath: string, outputPath: string) => {
      await writeFile(outputPath, "converted-video");
    });
    const server = await buildServer({ config: testConfig(tempDir), db, videoTranscoder: { transcode } });

    const [first, second] = await Promise.all([
      server.inject({ method: "GET", url: `/api/files/video?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=clip.mkv` }),
      server.inject({ method: "GET", url: `/api/files/video?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=clip.mkv` })
    ]);

    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("video/mp4");
    expect(first.payload).toBe("converted-video");
    expect(second.payload).toBe("converted-video");
    expect(transcode).toHaveBeenCalledTimes(1);

    await writeFile(path.join(rootDir, "clip.mkv"), "changed-source-video");
    const changed = await server.inject({ method: "GET", url: `/api/files/video?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=clip.mkv` });
    expect(changed.statusCode).toBe(200);
    expect(transcode).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("returns a service error and removes failed transcode output", async () => {
    await writeFile(path.join(rootDir, "broken.avi"), "source-video");
    const transcode = vi.fn(async () => {
      throw new Error("unsupported codec");
    });
    const server = await buildServer({ config: testConfig(tempDir), db, videoTranscoder: { transcode } });

    const response = await server.inject({
      method: "GET",
      url: `/api/files/video?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=broken.avi`
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Video transcoding failed" });
    await expect(readdir(path.join(tempDir, "media-cache", "videos"))).resolves.toEqual([]);
    await server.close();
  });

  it("rejects non-video files and traversal attempts on the video route", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const nonVideo = await server.inject({
      method: "GET",
      url: `/api/files/video?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=hello.txt`
    });
    const traversal = await server.inject({
      method: "GET",
      url: `/api/files/video?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=..`
    });

    expect(nonVideo.statusCode).toBe(415);
    expect(traversal.statusCode).toBe(400);
    await server.close();
  });

  it("rejects traversal attempts for preview endpoints", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/files/blob?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=..`
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it("keeps indexed search results visible in the file result shape", async () => {
    db.prepare(`
      INSERT INTO indexed_text (file_id, root_id, path, name, body)
      VALUES ('file-1', 'local', 'docs/readme.txt', 'readme.txt', 'alpha beta')
    `).run();
    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "GET",
      url: `/api/search?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&q=alpha`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      git: null,
      files: [
        {
          name: "readme.txt",
          path: "docs/readme.txt",
          kind: "file",
          sizeBytes: 0,
          modifiedAt: new Date(0).toISOString()
        }
      ]
    });
    await server.close();
  });

  it("scopes filename fallback and validates the requested search directory", async () => {
    await mkdir(path.join(rootDir, "docs"));
    await mkdir(path.join(rootDir, "docs-old"));
    await writeFile(path.join(rootDir, "docs", "alpha-note.txt"), "inside");
    await writeFile(path.join(rootDir, "docs-old", "alpha-note.txt"), "outside");
    const server = await buildServer({ config: testConfig(tempDir), db });

    const scoped = await server.inject({
      method: "GET",
      url: `/api/search?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=docs&q=alpha`
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toMatchObject({
      indexed: [],
      files: [{ path: "docs/alpha-note.txt" }]
    });

    const traversal = await server.inject({
      method: "GET",
      url: `/api/search?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=..&q=alpha`
    });
    expect(traversal.statusCode).toBe(400);

    const filePath = await server.inject({
      method: "GET",
      url: `/api/search?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=hello.txt&q=alpha`
    });
    expect(filePath.statusCode).toBe(400);
    await server.close();
  });

  it("scopes indexed search to the requested directory and returns stored metadata", async () => {
    await mkdir(path.join(rootDir, "docs"));
    await mkdir(path.join(rootDir, "docs-old"));
    await writeFile(path.join(rootDir, "docs", "readme.txt"), "alpha docs");
    await writeFile(path.join(rootDir, "docs-old", "readme.txt"), "alpha old docs");
    upsertIndexedFile(db, {
      rootId: "local",
      path: "docs/readme.txt",
      name: "readme.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      mtimeMs: 1_700_000_000_000,
      hash: "docs-hash",
      body: "alpha docs"
    });
    upsertIndexedFile(db, {
      rootId: "local",
      path: "docs-old/readme.txt",
      name: "readme.txt",
      mimeType: "text/plain",
      sizeBytes: 14,
      mtimeMs: 1_700_000_001_000,
      hash: "docs-old-hash",
      body: "alpha old docs"
    });
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "GET",
      url: `/api/search?rootId=local&storagePoolId=${encodeURIComponent(TEST_STORAGE_POOL_ID)}&path=docs&q=alpha`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      files: [
        {
          name: "readme.txt",
          path: "docs/readme.txt",
          kind: "file",
          mimeType: "text/plain",
          sizeBytes: 10,
          modifiedAt: new Date(1_700_000_000_000).toISOString()
        }
      ]
    });
    await server.close();
  });

  it("supports filtered advanced search with safe snippets and query-bound cursors", async () => {
    await mkdir(path.join(rootDir, "docs"));
    await writeFile(path.join(rootDir, "docs", "alpha.txt"), "alpha plain body");
    await writeFile(path.join(rootDir, "docs", "report.pdf"), "alpha report body");
    const textId = upsertIndexedFile(db, {
      rootId: "local",
      path: "docs/alpha.txt",
      name: "alpha.txt",
      mimeType: "text/plain",
      sizeBytes: 16,
      mtimeMs: 1_700_000_000_000,
      hash: "advanced-text",
      body: "alpha plain body"
    });
    const pdfId = upsertIndexedFile(db, {
      rootId: "local",
      path: "docs/report.pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 32,
      mtimeMs: 1_710_000_000_000,
      hash: "advanced-pdf",
      body: "alpha report body"
    });
    db.prepare(`
      UPDATE indexed_files
      SET extraction_source = CASE id WHEN ? THEN 'plain_text' ELSE 'pdftotext' END,
          extraction_status = 'ready'
      WHERE id IN (?, ?)
    `).run(textId, textId, pdfId);
    const server = await buildServer({ config: testConfig(tempDir), db });

    const filtered = await server.inject({
      method: "POST",
      url: "/api/search",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        path: "docs",
        query: "ＡＬＰＨＡ",
        mimeTypes: ["application/pdf"],
        categories: ["pdf"],
        modifiedFrom: "2024-01-01T00:00:00.000Z",
        modifiedTo: "2025-01-01T00:00:00.000Z",
        sizeMin: 20,
        sizeMax: 40,
        extractionSources: ["pdftotext"],
        extractionStatuses: ["ready"],
        sort: { field: "size", direction: "desc" }
      }
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({
      files: [{
        path: "docs/report.pdf",
        mimeType: "application/pdf",
        extractionSource: "pdftotext",
        extractionStatus: "ready",
        snippet: expect.stringContaining("alpha"),
        highlightRanges: [expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) })]
      }],
      nextCursor: null
    });
    expect(filtered.json().files[0].snippet).not.toContain("<mark>");

    const firstPage = await server.inject({
      method: "POST",
      url: "/api/search",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        path: "docs",
        query: "alpha",
        sort: { field: "name", direction: "asc" },
        limit: 1
      }
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({
      files: [{ path: "docs/alpha.txt" }],
      nextCursor: expect.any(String)
    });
    const secondPage = await server.inject({
      method: "POST",
      url: "/api/search",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        path: "docs",
        query: "alpha",
        sort: { field: "name", direction: "asc" },
        limit: 1,
        cursor: firstPage.json().nextCursor
      }
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()).toMatchObject({ files: [{ path: "docs/report.pdf" }], nextCursor: null });

    const mismatchedCursor = await server.inject({
      method: "POST",
      url: "/api/search",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        path: "docs",
        query: "alpha",
        sort: { field: "size", direction: "asc" },
        limit: 1,
        cursor: firstPage.json().nextCursor
      }
    });
    const literalOperators = await server.inject({
      method: "POST",
      url: "/api/search",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        path: "docs",
        query: "alpha OR nonexistent"
      }
    });
    expect(mismatchedCursor.statusCode).toBe(400);
    expect(literalOperators.statusCode).toBe(200);
    expect(literalOperators.json().files).toEqual([]);
    await server.close();
  });

  it("continues advanced search past out-of-scope index rows", async () => {
    await writeFile(path.join(rootDir, "valid.txt"), "alpha valid");
    for (const [indexPath, name] of [
      ["../outside-a.txt", "a.txt"],
      ["../outside-b.txt", "b.txt"],
      ["valid.txt", "z.txt"]
    ] as const) {
      const fileId = upsertIndexedFile(db, {
        rootId: "local",
        path: indexPath,
        name,
        mimeType: "text/plain",
        sizeBytes: 10,
        mtimeMs: 1_700_000_000_000,
        body: "alpha body"
      });
      db.prepare(`
        INSERT INTO indexed_content_fts (file_id, root_id, path, name, body, terms)
        VALUES (?, 'local', ?, ?, 'alpha body', 'alpha body')
      `).run(fileId, indexPath, name);
    }
    db.prepare(`
      INSERT INTO index_content_state (root_id, status, updated_at)
      VALUES ('local', 'ready', ?)
      ON CONFLICT(root_id) DO UPDATE SET status = 'ready', updated_at = excluded.updated_at
    `).run(new Date().toISOString());
    const server = await buildServer({ config: testConfig(tempDir), db });

    const response = await server.inject({
      method: "POST",
      url: "/api/search",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        query: "alpha",
        sort: { field: "name", direction: "asc" },
        limit: 1
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ files: [{ path: "valid.txt" }], nextCursor: null });
    await server.close();
  });

  it("does not cancel terminal jobs", async () => {
    const session = createSession(db, { rootId: "local" });
    const { job } = createUserMessageAndJob(db, {
      sessionId: session.id,
      content: "List files"
    });
    updateJobStatus(db, job.id, "completed");

    const server = await buildServer({ config: testConfig(tempDir), db });
    const response = await server.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/cancel`
    });

    expect(response.statusCode).toBe(409);
    await server.close();
  });

  it("rolls back an applied move operation", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const mutation = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "move",
        sourcePath: "hello.txt",
        targetPath: "moved.txt"
      }
    });
    expect(mutation.statusCode).toBe(201);
    const applied = mutation.json().operation;

    const response = await server.inject({
      method: "POST",
      url: `/api/operations/${applied?.id}/rollback`
    });

    expect(response.statusCode).toBe(202);
    await expect(readFile(path.join(rootDir, "hello.txt"), "utf8")).resolves.toBe("hello");
    await expect(stat(path.join(rootDir, "moved.txt"))).rejects.toThrow();
    expect(applied ? getFileOperation(db, applied.id)?.status : null).toBe("rolled_back");
    expect(db.prepare(`
      SELECT path, recursive, generation FROM index_queue
      WHERE root_id = 'local' AND path IN ('hello.txt', 'moved.txt') ORDER BY path
    `).all()).toEqual([
      { path: "hello.txt", recursive: 1, generation: 2 },
      { path: "moved.txt", recursive: 1, generation: 2 }
    ]);
    await server.close();
  });

  it("rolls back an applied trash operation by restoring from ZOS trash", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const mutation = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "trash",
        sourcePath: "hello.txt"
      }
    });
    expect(mutation.statusCode).toBe(201);
    const applied = mutation.json().operation;
    await expect(stat(path.join(rootDir, "hello.txt"))).rejects.toThrow();

    const response = await server.inject({
      method: "POST",
      url: `/api/operations/${applied?.id}/rollback`
    });

    expect(response.statusCode).toBe(202);
    await expect(readFile(path.join(rootDir, "hello.txt"), "utf8")).resolves.toBe("hello");
    expect(applied ? getFileOperation(db, applied.id)?.status : null).toBe("rolled_back");
    await server.close();
  });

  it("restores a trash entry directly through the trash API", async () => {
    const server = await buildServer({ config: testConfig(tempDir), db });
    const mutation = await server.inject({
      method: "POST",
      url: "/api/files/mutations",
      payload: {
        rootId: "local",
        storagePoolId: TEST_STORAGE_POOL_ID,
        operation: "trash",
        sourcePath: "hello.txt"
      }
    });
    expect(mutation.statusCode).toBe(201);
    const applied = mutation.json().operation;
    const trashEntryId = applied?.metadata.trashEntryId;
    expect(typeof trashEntryId).toBe("string");
    if (typeof trashEntryId !== "string") {
      throw new Error("Missing trash entry id");
    }
    await expect(stat(path.join(rootDir, "hello.txt"))).rejects.toThrow();

    const response = await server.inject({
      method: "POST",
      url: `/api/trash/${trashEntryId}/restore`
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      trashEntryId,
      operation: {
        operation: "restore",
        status: "applied",
        targetPath: "hello.txt"
      }
    });
    await expect(readFile(path.join(rootDir, "hello.txt"), "utf8")).resolves.toBe("hello");
    expect(getTrashEntry(db, trashEntryId)?.restoredAt).toEqual(expect.any(String));
    expect(
      listFileOperations(db).some(
        (operation) => operation.operation === "restore" && operation.metadata.trashEntryId === trashEntryId
      )
    ).toBe(true);
    expect(db.prepare(`
      SELECT path, recursive, generation FROM index_queue
      WHERE root_id = 'local' ORDER BY path
    `).all()).toEqual([{ path: "hello.txt", recursive: 1, generation: 2 }]);
    await server.close();
  });

});

class FakeSystemCommandRunner implements SystemCommandRunner {
  constructor(private readonly outputs: Record<string, string>) {}

  async run(command: string, args: string[]): Promise<string> {
    const key = [command, ...args].join(" ");
    const output = this.outputs[key];
    if (output === undefined) {
      throw new Error(`${key} unavailable`);
    }
    return output;
  }
}

class FakeSystemPowerRuntime implements SystemPowerRuntime {
  actions: SystemPowerAction[] = [];
  error: Error | null = null;

  async request(action: SystemPowerAction): Promise<SystemPowerResult> {
    this.actions.push(action);
    if (this.error) throw this.error;
    return { action, accepted: true };
  }
}

function testEthernetConfig(): SystemEthernetUpdateInput["config"] {
  return {
    enabled: true,
    ipv4: { mode: "dhcp", address: null, prefixLength: null, gateway: null, dnsMode: "automatic", dns: [], useDefaultRoute: true, routeMetric: 100 },
    ipv6: { mode: "automatic", address: null, prefixLength: null, gateway: null, dnsMode: "automatic", dns: [], useDefaultRoute: false, routeMetric: 600 }
  };
}

class FakeEthernetManager implements EthernetManagerRuntime {
  statusCalls = 0;
  saved: string[] = [];
  status: SystemEthernetStatus = {
    collectedAt: "2026-10-12T00:00:00.000Z",
    backend: "NetworkManager",
    hostdReady: true,
    devices: [],
    transaction: null,
    warnings: []
  };

  async getStatus(): Promise<SystemEthernetStatus> {
    this.statusCalls += 1;
    return structuredClone(this.status);
  }

  async save(deviceId: string, _input: SystemEthernetUpdateInput): Promise<SystemEthernetStatus> {
    this.saved.push(deviceId);
    return this.getStatus();
  }

  async apply(confirmed: boolean): Promise<SystemEthernetApplyTransaction> {
    if (!confirmed) throw new EthernetManagerRequestError("Ethernet apply confirmation is required", 400);
    return this.transaction("awaiting_confirmation");
  }

  async confirm(_transactionId: string): Promise<SystemEthernetApplyTransaction> {
    return this.transaction("confirmed");
  }

  async rollback(_transactionId: string): Promise<SystemEthernetApplyTransaction> {
    return { ...this.transaction("rolled_back"), rollback: "succeeded" };
  }

  private transaction(status: SystemEthernetApplyTransaction["status"]): SystemEthernetApplyTransaction {
    return {
      id: "550e8400-e29b-41d4-a716-446655440010",
      status,
      deviceIds: ["2ccf67c96807"],
      createdAt: "2026-10-12T00:00:00.000Z",
      deadlineAt: status === "awaiting_confirmation" ? "2026-10-12T00:01:30.000Z" : null,
      rollback: "not_required",
      error: null
    };
  }
}

class FakeNetworkManager implements NetworkManagerRuntime {
  statusCalls = 0;
  connectCalls: SystemWifiConnectInput[] = [];
  deletedProfiles: string[] = [];
  hotspotActions: string[] = [];
  summaryError: Error | null = null;
  status: SystemWifiStatus = {
    collectedAt: "2026-09-20T00:00:00.000Z",
    backend: "NetworkManager",
    radioEnabled: true,
    hostdReady: true,
    devices: [
      {
        id: "wlan0",
        name: "wlan0",
        mac: "00:11:22:33:44:55",
        driver: "brcmfmac",
        state: "connected",
        mode: "client",
        activeConnectionId: TEST_WIFI_PROFILE_ID,
        activeConnectionName: "Home",
        ssid: "Home",
        signal: 80,
        frequencyMHz: 5180,
        channel: 36,
        managementPath: false,
        capabilities: { accessPoint: true, bands: ["2.4", "5"], channels: [1, 6, 11, 36, 40] }
      }
    ],
    hotspots: []
  };

  async getStatus(): Promise<SystemWifiStatus> {
    this.statusCalls += 1;
    return structuredClone(this.status);
  }

  async getSummary(): Promise<SystemWifiSummary> {
    if (this.summaryError) throw this.summaryError;
    return {
      ...(await this.getStatus()),
      profiles: [
        {
          id: TEST_WIFI_PROFILE_ID,
          name: "Home",
          ssid: "Home",
          device: "wlan0",
          security: "wpa2",
          autoconnect: true,
          active: true,
          managed: false,
          credentialConfigured: true,
          revision: null
        }
      ]
    };
  }

  async scan(input: SystemWifiScanInput) {
    return {
      device: input.device,
      scannedAt: "2026-09-20T00:00:00.000Z",
      accessPoints: [
        {
          ssid: "Home",
          bssid: "AA:BB:CC:DD:EE:FF",
          signal: 80,
          frequencyMHz: 5180,
          channel: 36,
          band: "5" as const,
          security: "wpa2" as const,
          active: true,
          savedProfileId: TEST_WIFI_PROFILE_ID
        }
      ]
    };
  }

  async connect(input: SystemWifiConnectInput) {
    this.connectCalls.push(input);
    return this.operationResult();
  }

  async disconnect(_input: { device: string; confirmed: boolean }) {
    return this.operationResult();
  }

  async setRadio(input: SystemWifiRadioInput) {
    this.status.radioEnabled = input.enabled;
    return this.operationResult();
  }

  async updateProfile(_profileId: string, _input: SystemWifiProfileUpdateInput) {
    return this.operationResult();
  }

  async deleteProfile(profileId: string, _confirmed: boolean) {
    this.deletedProfiles.push(profileId);
    return this.operationResult();
  }

  async updateHotspot(_input: SystemWifiHotspotUpdateInput) {
    return this.operationResult();
  }

  async startHotspot(input: SystemWifiHotspotActionInput) {
    this.hotspotActions.push(`start:${input.device}`);
    return this.operationResult();
  }

  async stopHotspot(input: SystemWifiHotspotActionInput) {
    this.hotspotActions.push(`stop:${input.device}`);
    return this.operationResult();
  }

  async deleteHotspot(input: SystemWifiHotspotActionInput) {
    this.hotspotActions.push(`delete:${input.device}`);
    return this.operationResult();
  }

  private async operationResult() {
    return { status: await this.getStatus(), rollback: "not_required" as const, message: null };
  }
}

class FakeBluetoothManager implements BluetoothManagerRuntime {
  calls: string[] = [];
  status: BluetoothStatus = {
    collectedAt: "2026-10-20T00:00:00.000Z",
    backend: "BlueZ",
    available: true,
    adapters: [{ id: "adapter-hci0", address: "00:11:22:33:44:55", name: "hci0", alias: "ZOS", state: "powered", powered: true, discovering: false, defaultAdapter: true }],
    devices: [{ adapterId: "adapter-hci0", address: "AA:BB:CC:DD:EE:FF", name: "Headphones", alias: null, type: "headset", rssi: -42, paired: true, trusted: false, connected: false, servicesResolved: true, lastSeenAt: null }],
    scan: { active: false, adapterId: null, startedAt: null, endsAt: null },
    challenge: null,
    error: null
  };

  async getStatus() { return structuredClone(this.status); }
  async setAdapterPower(input: { adapterId: string; powered: boolean }) { this.calls.push(`power:${input.adapterId}:${input.powered}`); return this.result(); }
  async setDefaultAdapter(input: { adapterId: string }) { this.calls.push(`default:${input.adapterId}`); return this.result(); }
  async startScan(input: { adapterId: string }) { this.calls.push(`scan:${input.adapterId}`); return this.result(); }
  async stopScan(input: { adapterId: string }) { this.calls.push(`stop:${input.adapterId}`); return this.result(); }
  async pair(input: { adapterId: string; address: string }) { this.calls.push(`pair:${input.address}`); return this.result(); }
  async cancelPairing(input: { adapterId: string; address: string }) { this.calls.push(`cancel:${input.address}`); return this.result(); }
  async answerChallenge(input: { adapterId: string; address: string; challengeId: string; accept: boolean }) { this.calls.push(`challenge:${input.accept}`); return this.result(); }
  async trust(input: { adapterId: string; address: string; trusted: boolean }) { this.calls.push(`trust:${input.address}:${input.trusted}`); return this.result(); }
  async connect(input: { adapterId: string; address: string }) { this.calls.push(`connect:${input.address}`); return this.result(); }
  async disconnect(input: { adapterId: string; address: string }) { this.calls.push(`disconnect:${input.address}`); return this.result(); }
  async unpair(input: { adapterId: string; address: string }) { this.calls.push(`unpair:${input.address}`); return this.result(); }
  private async result() { return { status: await this.getStatus(), message: null }; }
}

function storageCommandRunner({
  smartSdb,
  failSmartSdb = false,
  mountpoint = "/mnt/storage"
}: {
  smartSdb?: string;
  failSmartSdb?: boolean;
  mountpoint?: string;
}): FakeSystemCommandRunner {
  return new FakeSystemCommandRunner({
    "lsblk --json --bytes --output NAME,KNAME,PATH,TYPE,SIZE,MODEL,SERIAL,TRAN,ROTA,FSTYPE,LABEL,UUID,MOUNTPOINTS,PKNAME": JSON.stringify({
      blockdevices: [
        {
          name: "sda",
          path: "/dev/sda",
          type: "disk",
          size: 1000,
          model: "Disk A",
          serial: "disk-a",
          tran: "sata",
          rota: 1,
          mountpoints: [],
          children: [
            {
              name: "sda1",
              path: "/dev/sda1",
              type: "part",
              size: 1000,
              fstype: "linux_raid_member",
              uuid: "part-a",
              mountpoints: []
            }
          ]
        },
        {
          name: "sdb",
          path: "/dev/sdb",
          type: "disk",
          size: 1000,
          model: "Disk B",
          serial: "disk-b",
          tran: "sata",
          rota: 1,
          mountpoints: [],
          children: [
            {
              name: "sdb1",
              path: "/dev/sdb1",
              type: "part",
              size: 1000,
              fstype: "linux_raid_member",
              uuid: "part-b",
              mountpoints: []
            }
          ]
        }
      ]
    }),
    "findmnt --json --bytes --output SOURCE,TARGET,FSTYPE,SIZE,USED,AVAIL,USE%": JSON.stringify({
      filesystems: [
        {
          source: "/dev/md0",
          target: mountpoint,
          fstype: "ext4",
          size: 2000,
          used: 800,
          avail: 1200,
          "use%": "40%"
        }
      ]
    }),
    "mdadm --detail --scan": "ARRAY /dev/md0 metadata=1.2 name=nas:0 UUID=raid-uuid\n",
    "mdadm --detail /dev/md0": `
/dev/md0:
           Version : 1.2
        Raid Level : raid1
        Array Size : 2 (2.00 KiB 2.05 KB)
      Raid Devices : 2
     Total Devices : 2
             State : clean
    Active Devices : 2
    Failed Devices : 0
     Spare Devices : 0
              Name : nas:0
              UUID : raid-uuid

    Number   Major   Minor   RaidDevice State
       0       8        1        0      active sync   /dev/sda1
       1       8       17        1      active sync   /dev/sdb1
`,
    "smartctl --scan-open --json": JSON.stringify({
      devices: [
        { name: "/dev/sda", type: "sat", protocol: "ATA" },
        { name: "/dev/sdb", type: "sat", protocol: "ATA" }
      ]
    }),
    "smartctl --all --json -d sat /dev/sda": JSON.stringify({
      smart_status: { passed: true },
      temperature: { current: 35 },
      power_on_time: { hours: 1200 },
      ata_smart_error_log: { summary: { count: 0 } }
    }),
    ...(failSmartSdb
      ? {}
      : {
          "smartctl --all --json -d sat /dev/sdb":
            smartSdb ??
            JSON.stringify({
              smart_status: { passed: true },
              temperature: { current: 36 },
              power_on_time: { hours: 1220 },
              ata_smart_error_log: { summary: { count: 0 } }
            })
        })
  });
}

function availableStorageCommandRunner(): FakeSystemCommandRunner {
  return new FakeSystemCommandRunner({
    "lsblk --json --bytes --output NAME,KNAME,PATH,TYPE,SIZE,MODEL,SERIAL,TRAN,ROTA,FSTYPE,LABEL,UUID,MOUNTPOINTS,PKNAME": JSON.stringify({
      blockdevices: [
        { name: "sda", path: "/dev/sda", type: "disk", size: 1000, model: "Disk A", serial: "disk-a", tran: "sata", rota: 1, mountpoints: [] },
        { name: "sdb", path: "/dev/sdb", type: "disk", size: 1000, model: "Disk B", serial: "disk-b", tran: "sata", rota: 1, mountpoints: [] },
        { name: "sdc", path: "/dev/sdc", type: "disk", size: 1000, model: "Disk C", serial: "disk-c", tran: "sata", rota: 1, mountpoints: [] },
        { name: "sdd", path: "/dev/sdd", type: "disk", size: 1000, model: "Disk D", serial: "disk-d", tran: "sata", rota: 1, mountpoints: [] }
      ]
    }),
    "findmnt --json --bytes --output SOURCE,TARGET,FSTYPE,SIZE,USED,AVAIL,USE%": JSON.stringify({ filesystems: [] }),
    "mdadm --detail --scan": "",
    "smartctl --scan-open --json": JSON.stringify({ devices: [] })
  });
}

async function listenOnUnixSocket(server: http.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createHostdTestServer(
  socketPath: string,
  respond: (request: Record<string, unknown>) => unknown
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      socket.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: respond(request) })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function closeNetServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function testConfig(dataDir: string): ZosConfig {
  return {
    dataDir,
    databasePath: path.join(dataDir, "zos.sqlite"),
    api: {
      host: "127.0.0.1",
      port: 3010,
      allowedOrigins: []
    },
    worker: {
      pollMs: 50
    },
    admin: {
      displayName: "Test Admin",
      authMode: "local-only"
    },
    model: {
      provider: "pi",
      piCommand: "pi",
      localEndpoint: null
    },
    docker: {
      enabled: false,
      socketPath: "/var/run/docker.sock",
      composeCommand: "docker",
      operationTimeoutMs: 120_000,
      consoleShells: ["/bin/sh", "/bin/bash"],
    },
    hostd: {
      socketPath: "/run/zos/hostd.sock"
    },
    shares: {
      enabled: false,
      account: {
        username: "zos-share",
        password: null
      },
      shares: []
    },
    terminal: {
      user: "test-user",
      termuxSocketPath: "/tmp/termux.sock"
    },
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
      user: "zos"
    },
    nasRoots: [{ id: "local", name: "Local", path: rootDir }]
  };
}

function shareSettingsPayload(password: string): Omit<ShareSettingsRecord, "updatedAt"> {
  return {
    enabled: true,
    account: {
      username: "zos-share",
      password
    },
    shares: [
      {
        id: "media",
        name: "Media",
        rootId: "local",
        path: "media",
        description: "Media share",
        protocols: {
          smb: {
            enabled: true,
            readOnly: false,
            browseable: true,
            allowGuest: false
          },
          webdav: {
            enabled: true,
            readOnly: true,
            allowGuest: false,
            port: 8088,
            pathPrefix: "/shares/media"
          },
          ftp: {
            enabled: true,
            readOnly: true,
            allowGuest: false,
            port: 2121,
            passivePortStart: 50000,
            passivePortEnd: 50100
          },
          nfs: {
            enabled: true,
            readOnly: true,
            allowedCidrs: ["192.168.1.0/24"],
            rootSquash: true
          },
          dlna: {
            enabled: true,
            mediaTypes: ["audio", "video"],
            bindInterface: "eth0",
            bindAddress: null,
            friendlyName: "Media"
          }
        }
      }
    ]
  };
}

function dockerEnabledConfig(dataDir: string, overrides: Partial<ZosConfig["docker"]> = {}): ZosConfig {
  const config = testConfig(dataDir);
  return {
    ...config,
    docker: {
      ...config.docker,
      enabled: true,
      ...overrides
    }
  };
}

class FakeDockerDaemon implements DockerDaemonRuntime {
  readonly status: DockerDaemonStatus = {
    state: "running",
    loadState: "loaded",
    activeState: "active",
    subState: "running",
    result: "success",
    collectedAt: "2026-09-16T00:00:00.000Z"
  };
  readonly snapshot: DockerDaemonConfigSnapshot = {
    path: "/etc/docker/daemon.json",
    content: "{}\n",
    revision: "a".repeat(64),
    exists: true,
    restartPending: false
  };
  updates: DockerDaemonConfigUpdateInput[] = [];
  statusCalls = 0;
  getError: Error | null = null;
  updateError: Error | null = null;

  async getStatus(): Promise<DockerDaemonStatus> {
    this.statusCalls += 1;
    return this.status;
  }

  async getConfig(): Promise<DockerDaemonConfigSnapshot> {
    if (this.getError) throw this.getError;
    return this.snapshot;
  }

  async updateConfig(input: DockerDaemonConfigUpdateInput): Promise<DockerDaemonConfigUpdateResult> {
    this.updates.push(input);
    if (this.updateError) throw this.updateError;
    return {
      snapshot: { ...this.snapshot, content: input.content, restartPending: !input.restart },
      restarted: input.restart,
      rollback: "not_required",
      error: null
    };
  }
}

class FakeDockerEngine implements DockerEngineRuntime {
  resourceCapabilities: DockerResourceCapabilities = {
    memoryLimit: true, swapLimit: true, cpuQuota: true, cpuShares: true, cpuset: true, pidsLimit: true
  };
  calls: string[] = [];
  pullInputs: Array<{ image: string; registryAuth?: string }> = [];
  removedImages: string[] = [];
  failStart = false;
  removeError: Error | null = null;
  readonly images: DockerImageSummary[] = [
    {
      id: "sha256:image-1",
      shortId: "image-1",
      tags: ["jellyfin:latest"],
      digests: ["jellyfin@sha256:digest-1"],
      createdAt: new Date(0).toISOString(),
      sizeBytes: 4096,
      sharedSizeBytes: 1024,
      architecture: "amd64",
      containerCount: 1
    }
  ];

  async getInfo() {
    return {
      version: "27.1.0",
      apiVersion: "1.55",
      negotiatedApiVersion: "1.55",
      operatingSystem: "Test Linux",
      architecture: "amd64",
      dockerRootDir: "/var/lib/docker",
      resourceCapabilities: this.resourceCapabilities
    };
  }

  async getCounts() {
    return {
      images: this.images.length,
      imageDetails: this.images,
      networks: 1,
      volumes: 3
    };
  }

  async listImages(): Promise<DockerImageSummary[]> {
    return this.images;
  }

  async getImageArchitecture(): Promise<string | null> {
    return "amd64";
  }

  async getNetworkDetails(networkId: string): Promise<DockerNetworkDetails> {
    if (networkId === "missing") throw new DockerRequestError("No such network", 404);
    if (networkId === "broken") throw new DockerRequestError("network inspect failed", 500);
    return {
      id: networkId,
      name: "media-net",
      createdAt: "2026-09-17T12:00:00.000Z",
      driver: "bridge",
      scope: "local",
      containerCount: 1,
      enableIPv4: true,
      enableIPv6: false,
      internal: false,
      attachable: true,
      ingress: false,
      ipam: { driver: "default", configs: [{ subnet: "172.20.0.0/16", ipRange: null, gateway: "172.20.0.1", auxiliaryAddresses: {} }] },
      options: {},
      labels: { environment: "test" },
      containers: [{ id: "container-1", name: "media", endpointId: "endpoint-1", macAddress: "02:42:ac:14:00:02", ipv4Address: "172.20.0.2/16", ipv6Address: null }]
    };
  }

  async getVolumeDetails(volumeName: string): Promise<DockerVolumeDetails> {
    if (volumeName === "missing") throw new DockerRequestError("No such volume", 404);
    if (volumeName === "broken") throw new DockerRequestError("volume inspect failed", 500);
    return {
      name: volumeName,
      createdAt: "2026-09-17T12:00:00.000Z",
      driver: "local",
      scope: "local",
      mountpoint: `/var/lib/docker/volumes/${volumeName}/_data`,
      labels: { role: "media" },
      options: {},
      status: { availability: "active" },
      sizeBytes: 4096,
      referenceCount: 1
    };
  }

  async listContainers(): Promise<DockerContainerSummary[]> {
    return [
      {
        id: "container-1",
        shortId: "container-1",
        name: "media",
        image: "jellyfin:latest",
        state: "running",
        status: "Up",
        ports: ["8096/tcp"],
        composeProject: "media",
        composeService: "jellyfin",
        cpuPercent: 10,
        memoryUsageBytes: 1024,
        memoryLimitBytes: 4096,
        memoryPercent: 25,
        createdAt: new Date(0).toISOString()
      }
    ];
  }

  async imageExists(): Promise<boolean> {
    this.calls.push("image-exists");
    return true;
  }

  async resolveImageId(): Promise<string> {
    this.calls.push("resolve-image");
    return "sha256:image-1";
  }

  async pullImage(input: { image: string; registryAuth?: string }): Promise<void> {
    this.calls.push("pull");
    this.pullInputs.push(input);
  }

  async removeImage(image: string) {
    this.calls.push(`remove-image:${image}`);
    this.removedImages.push(image);
    if (this.removeError) {
      throw this.removeError;
    }
    return { reference: image, deleted: ["sha256:image-1"], untagged: [image] };
  }

  async createContainer(): Promise<{ id: string; warnings: string[] }> {
    this.calls.push("create-container");
    return { id: "created-container", warnings: [] };
  }

  async createVolume(input: { name: string }): Promise<{ name: string; labels: Record<string, string> }> {
    this.calls.push(`create-volume:${input.name}`);
    return { name: input.name, labels: {} };
  }

  async createNetwork(): Promise<{ id: string; warning: string | null }> {
    this.calls.push("create-network");
    return { id: "created-network", warning: null };
  }

  async getContainerLogs(containerId: string): Promise<string> {
    this.calls.push(`logs:${containerId}`);
    return "hello";
  }

  async startContainer(containerId: string): Promise<void> {
    this.calls.push(`start:${containerId}`);
    if (this.failStart) {
      throw new Error("start failed");
    }
  }

  async stopContainer(containerId: string): Promise<void> {
    this.calls.push(`stop:${containerId}`);
  }

  async restartContainer(containerId: string): Promise<void> {
    this.calls.push(`restart:${containerId}`);
  }

  async removeContainer(containerId: string): Promise<void> {
    this.calls.push(`remove:${containerId}`);
  }

  async createExec(containerId: string): Promise<string> {
    this.calls.push(`exec:${containerId}`);
    return "exec-1";
  }

  async startExec(): Promise<DockerExecStream> {
    throw new Error("not implemented in API tests");
  }

  async resizeExec(): Promise<void> {
    this.calls.push("resize");
  }
}

class FakeShareHostd {
  requests: ShareApplyRequest[] = [];
  failApply = false;

  async apply(input: ShareApplyRequest): Promise<ShareApplyResult> {
    this.requests.push(input);
    if (this.failApply) {
      throw new Error("share apply failed");
    }
    return {
      appliedAt: "2026-01-01T00:00:00.000Z",
      files: ["/etc/samba/smb.conf.d/zos-shares.conf"],
      services: ["smbd.service", "nmbd.service"]
    };
  }
}

class FakeDockerCompose implements DockerComposeRuntime {
  calls: string[] = [];
  registryCredentials: DockerRegistryCredentialRecord[][] = [];

  constructor(
    private readonly projects: DockerComposeProjectSummary[] = [
      {
        id: "compose-root:compose.yml",
        name: "media",
        projectKey: "media",
        managedPath: "/zos/apps/media",
        services: ["jellyfin"],
        warnings: [],
        risk: "medium",
        revision: "revision-1",
        deployedRevision: "revision-1",
        needsDeploy: false,
        containerCount: 1,
        runningCount: 1,
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  ) {}

  async listProjects(): Promise<DockerComposeProjectSummary[]> {
    return this.projects;
  }

  async getProject(projectId: string): Promise<DockerComposeProjectSummary | null> {
    return this.projects.find((project) => project.id === projectId) ?? null;
  }

  async getApp(projectId: string) {
    const project = await this.getProject(projectId);
    return project ? { ...project, composeContent: "services: {}\n", environment: [] } : null;
  }

  async validateApp() {
    return { services: ["jellyfin"], warnings: [], risk: "medium" as const };
  }

  async createApp(): Promise<never> {
    throw new Error("not implemented in API tests");
  }

  async updateApp(): Promise<null> {
    return null;
  }

  async deleteApp(): Promise<"not_found"> {
    return "not_found";
  }

  async reconcileAll(): Promise<void> {}

  async runProjectAction(
    proposal: DockerOperationProposal,
    registryCredentials: DockerRegistryCredentialRecord[] = []
  ): Promise<{ output: string }> {
    this.calls.push(`${proposal.action}:${proposal.composeProjectId}`);
    this.registryCredentials.push(registryCredentials);
    return { output: "done" };
  }
}

async function writeComposeTestCommand(): Promise<string> {
  const command = path.join(tempDir, "docker-compose-test-command");
  await writeFile(command, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("config")) process.stdout.write(JSON.stringify({ services: { app: { image: "alpine" } } }));
else process.stdout.write("done\\n");
`);
  await chmod(command, 0o755);
  return command;
}

async function git(args: string[], cwd = rootDir): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0"
    }
  });
}

async function gitCommit(message: string, cwd = rootDir): Promise<void> {
  await git(["-c", "user.name=ZOS", "-c", "user.email=zos@example.test", "commit", "-m", message], cwd);
}
