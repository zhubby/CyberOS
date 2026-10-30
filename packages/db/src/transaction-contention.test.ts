import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCapabilityProposal,
  createMcpClient,
  createMonitoringAlertRule,
  createOperationNotification,
  createSession,
  createUserMessageAndJob,
  enqueuePhotosJob,
  getCapabilityApprovalByRun,
  getJob,
  getMonitoringAlertRule,
  getOperationNotificationByJob,
  listOwnedCapabilityRuns,
  MonitoringAlertRevisionConflictError,
  openCyberOsDb,
  savePhotosLibrarySettings,
  updateJobStatus,
  updateMonitoringAlertRule,
  type CyberOsDatabase
} from "./index.js";

let directory: string;
let databasePath: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cyberos-wal-contention-"));
  databasePath = path.join(directory, "cyberos.sqlite");
  db = openCyberOsDb(databasePath);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

// A separate process can commit while the synchronous repository call is
// waiting. Keeping its write transaction open lets DEFERRED readers establish
// a snapshot that cannot be upgraded, while IMMEDIATE waits before reading.
async function withConcurrentWriter<T>(
  statements: Array<{ sql: string; parameters: Array<string | number | null> }>,
  operation: () => T
): Promise<T> {
  const writer = spawn(process.execPath, ["--eval", `
    const Database = require("better-sqlite3");
    const { databasePath, statements } = JSON.parse(process.argv[1]);
    const connection = new Database(databasePath);
    connection.pragma("foreign_keys = ON");
    connection.exec("BEGIN IMMEDIATE");
    for (const { sql, parameters } of statements) connection.prepare(sql).run(...parameters);
    process.send("locked");
    process.once("message", () => {
      setTimeout(() => {
        connection.exec("COMMIT");
        connection.close();
        process.disconnect();
      }, 100);
    });
  `, JSON.stringify({ databasePath, statements })], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  writer.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const finished = new Promise<void>((resolve, reject) => {
    writer.once("error", reject);
    writer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Concurrent writer exited ${code}: ${stderr}`)));
  });
  const locked = new Promise<void>((resolve, reject) => {
    writer.once("message", (message) => message === "locked" ? resolve() : reject(new Error("Writer did not acquire its lock")));
    writer.once("error", reject);
    writer.once("exit", () => reject(new Error(`Concurrent writer exited before acquiring its lock: ${stderr}`)));
  });
  try {
    await locked;
    writer.send("continue");
    return operation();
  } finally {
    await finished;
  }
}

const unrelatedWrite = {
  sql: "INSERT INTO system_settings(key, value_json, updated_at) VALUES (?, '{}', ?)",
  parameters: ["contention_fixture", "2026-10-30T00:00:00.000Z"]
};

describe("repository writes under WAL contention", () => {
  it("waits before checking Photos scan deduplication and keeps library/path scope", async () => {
    const settings = savePhotosLibrarySettings(db, { storagePoolId: "pool-a", path: "Photos" });
    const other = enqueuePhotosJob(db, { settings, path: "Photos/other" });
    const timestamp = "2026-10-30T00:00:00.000Z";

    const result = await withConcurrentWriter([{
      sql: `INSERT INTO photos_jobs(
        id, kind, status, storage_pool_id, path, library_updated_at, scan_generation, created_at, updated_at
      ) VALUES (?, 'full_scan', 'queued', ?, ?, ?, ?, ?, ?)`,
      parameters: ["concurrent-scan", settings.storagePoolId, settings.path, settings.updatedAt,
        "concurrent-scan", timestamp, timestamp]
    }], () => enqueuePhotosJob(db, { settings }));

    expect(result).toMatchObject({ id: "concurrent-scan", status: "queued", path: "Photos" });
    expect(enqueuePhotosJob(db, { settings })).toEqual(result);
    expect(enqueuePhotosJob(db, { settings, path: "Photos/other" }).id).toBe(other.id);
    expect(db.prepare("SELECT COUNT(*) FROM photos_jobs").pluck().get()).toBe(2);
  });

  it("reads the committed alert revision before enforcing the existing conflict contract", async () => {
    const rule = createMonitoringAlertRule(db, {
      name: "Concurrent rule", enabled: true, metric: "cyberos_host_cpu_usage_ratio", selector: {},
      transform: "value", aggregation: "avg", windowSeconds: 300, comparator: ">",
      triggerThreshold: 0.9, recoveryThreshold: 0.8, triggerDurationSeconds: 60,
      recoveryDurationSeconds: 120, severity: "warning", noDataPolicy: "ignore", escalationPolicyId: null
    });

    await withConcurrentWriter([{
      sql: "UPDATE monitoring_alert_rules SET name = ?, revision = revision + 1 WHERE id = ?",
      parameters: ["Writer revision", rule.id]
    }], () => {
      expect(() => updateMonitoringAlertRule(db, rule.id, rule.revision, {
        ...rule, name: "Stale replacement"
      })).toThrow(MonitoringAlertRevisionConflictError);
    });

    expect(getMonitoringAlertRule(db, rule.id)).toMatchObject({
      name: "Writer revision", revision: rule.revision + 1
    });
    expect(updateMonitoringAlertRule(db, "missing-rule", 1, rule)).toBeNull();
  });

  it("updates only the requested job and preserves guarded transition results", async () => {
    const target = createUserMessageAndJob(db, { sessionId: createSession(db, {}).id, content: "Target" }).job;
    const other = createUserMessageAndJob(db, { sessionId: createSession(db, {}).id, content: "Other" }).job;
    for (const job of [target, other]) {
      createOperationNotification(db, {
        jobId: job.id, sessionId: job.sessionId, kind: "file", status: "running", summary: "Pending job"
      });
    }

    expect(await withConcurrentWriter([unrelatedWrite], () =>
      updateJobStatus(db, target.id, "completed", null, ["queued"]))).toBe(true);

    expect(getJob(db, target.id)?.status).toBe("completed");
    expect(getJob(db, other.id)?.status).toBe("queued");
    expect(getOperationNotificationByJob(db, target.id)?.status).toBe("succeeded");
    expect(getOperationNotificationByJob(db, other.id)?.status).toBe("running");
    expect(updateJobStatus(db, target.id, "failed", "stale", ["queued"])).toBe(false);
    expect(updateJobStatus(db, "missing-job", "completed")).toBe(false);
    expect(getJob(db, target.id)?.status).toBe("completed");
  });

  it("reserves the outer proposal transaction before nested idempotency reads", async () => {
    const client = createMcpClient(db, { name: "Pi", kind: "pi", scopes: ["cyberos:files:propose"] });
    const otherClient = createMcpClient(db, { name: "Other Pi", kind: "pi", scopes: ["cyberos:files:propose"] });
    const input = {
      clientId: client.id,
      subjectId: client.id,
      subjectKind: "pi" as const,
      capabilityId: "cyberos.files.mutate",
      risk: "high" as const,
      redactedInput: { operation: "mkdir", path: "Photos" },
      proposal: { operation: "mkdir", path: "Photos" },
      idempotencyKey: "create-photos",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };

    const created = await withConcurrentWriter([unrelatedWrite], () => createCapabilityProposal(db, input));

    expect(created.run).toMatchObject({ clientId: client.id, state: "waiting_approval" });
    expect(created.approval).toMatchObject({ runId: created.run.id, status: "pending" });
    expect(createCapabilityProposal(db, input)).toEqual(created);
    expect(getCapabilityApprovalByRun(db, created.run.id)?.id).toBe(created.approval.id);
    expect(listOwnedCapabilityRuns(db, { clientId: client.id }).map((run) => run.id)).toEqual([created.run.id]);
    expect(listOwnedCapabilityRuns(db, { clientId: otherClient.id })).toEqual([]);
    expect(() => createCapabilityProposal(db, {
      ...input, redactedInput: { operation: "mkdir", path: "Other" }
    })).toThrow("Idempotency key conflicts");
  });
});
