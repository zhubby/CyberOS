import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  finishIndexRun,
  finishOpsRun,
  listHealthAlerts,
  openCyberOsDb,
  startIndexRun,
  startOpsRun,
  upsertHealthAlert,
  type CyberOsDatabase
} from "@cyberos/db";
import { MetricsFixture } from "@cyberos/monitoring/test-utils";
import { DEFAULT_MONITORING_CONFIG, loadCyberOsRuntime, type CyberOsRuntime } from "@cyberos/shared";
import { evaluateSystemHealth, runScheduledHealthEvaluation } from "./index.js";

let tempDir: string;
let rootDir: string;
let db: CyberOsDatabase;
let config: CyberOsRuntime;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-system-health-"));
  rootDir = path.join(tempDir, "data", "local");
  await mkdir(rootDir, { recursive: true });
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
  config = createConfig(tempDir, path.dirname(rootDir));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("shared system health evaluator", () => {
  it("discovers storage pools from the data namespace", async () => {
    const summary = await evaluateSystemHealth({
      db,
      config,
      now: new Date("2026-01-01T00:01:00.000Z")
    });
    expect(summary.storagePools).toMatchObject([{ storagePoolId: "local", status: "ready" }]);
    expect(summary.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "storage_pool_not_ready" })
    ]));
  });

  it("refreshes storage pools and atomically preserves alerts owned by other producers", async () => {
    upsertHealthAlert(db, {
      code: "storage_pool_not_ready",
      scope: "local",
      storagePoolId: "local",
      severity: "critical",
      details: "previous mount failure",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    upsertHealthAlert(db, {
      code: "index_enqueue_failed",
      severity: "warning",
      details: "mutation enqueue failed",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    const summary = await runScheduledHealthEvaluation({
      db,
      config,
      now: new Date("2026-01-01T00:01:00.000Z")
    });
    expect(summary.storagePools).toMatchObject([{ status: "ready" }]);
    expect(summary.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "index_enqueue_failed" })
    ]));
    expect(listHealthAlerts(db, { status: "active" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "index_enqueue_failed" })
    ]));
    expect(listHealthAlerts(db).find((alert) => alert.code === "storage_pool_not_ready"))
      .toMatchObject({ status: "resolved" });
  });

  it("reports consecutive full index failures and clears the alert after recovery", async () => {
    for (const hour of [1, 2]) {
      const run = startIndexRun(db, { storagePoolId: "local", now: new Date(`2026-01-01T0${hour}:00:00.000Z`) });
      finishIndexRun(db, {
        runId: run.id,
        status: "failed",
        scanned: 1,
        indexed: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        failed: 1,
        finishedAt: new Date(`2026-01-01T0${hour}:01:00.000Z`)
      });
    }
    expect((await evaluateSystemHealth({ db, config, now: new Date("2026-01-01T03:00:00.000Z") })).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "indexer_failed" })]));

    const recovery = startIndexRun(db, { storagePoolId: "local", now: new Date("2026-01-01T03:01:00.000Z") });
    finishIndexRun(db, {
      runId: recovery.id,
      status: "completed",
      scanned: 1,
      indexed: 1,
      unchanged: 0,
      removed: 0,
      skipped: 0,
      failed: 0,
      finishedAt: new Date("2026-01-01T03:02:00.000Z")
    });
    expect((await evaluateSystemHealth({ db, config, now: new Date("2026-01-01T03:03:00.000Z") })).issues)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "indexer_failed" })]));
  });

  it("maps stale and failed operation tasks to the required severities", async () => {
    const health = startOpsRun(db, { task: "health", now: new Date("2026-01-01T00:00:00.000Z") });
    finishOpsRun(db, {
      runId: health.id,
      status: "failed",
      error: "probe framework failed",
      finishedAt: new Date("2026-01-01T00:00:01.000Z")
    });
    const maintenance = startOpsRun(db, { task: "maintenance", now: new Date("2025-12-29T00:00:00.000Z") });
    finishOpsRun(db, {
      runId: maintenance.id,
      status: "completed",
      finishedAt: new Date("2025-12-29T00:00:01.000Z")
    });

    const summary = await evaluateSystemHealth({ db, config, now: new Date("2026-01-01T01:00:00.000Z") });
    expect(summary.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ops_health_unhealthy", severity: "critical" }),
      expect.objectContaining({ code: "ops_maintenance_unhealthy", severity: "warning" })
    ]));
  });

  it("adds a warning when enabled monitoring has stopped sampling", async () => {
    const sampledAt = Date.parse("2026-01-01T00:00:00.000Z");
    const writer = new MetricsFixture(config.paths.metricsDatabasePath!);
    writer.recordCollectorStatus({
      collector: "host",
      state: "ready",
      attemptedAtMs: sampledAt,
      durationMs: 1
    });
    writer.close();

    const summary = await evaluateSystemHealth({
      db,
      config,
      now: new Date(sampledAt + 31_000)
    });
    expect(summary.monitoring).toEqual({
      status: "unavailable",
      lastSampleAt: "2026-01-01T00:00:00.000Z"
    });
    expect(summary.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "monitoring_unavailable", severity: "warning" })
    ]));
  });
});

function createConfig(dataDir: string, dataRoot: string): CyberOsRuntime {
  const base = loadCyberOsRuntime({ CYBEROS_ROOT: dataDir }, dataDir);
  return {
    ...base,
    paths: {
      ...base.paths,
      dataRoot,
      databasePath: path.join(dataDir, "cyberos.sqlite"),
      metricsDatabasePath: path.join(dataDir, "metrics.sqlite")
    },
    monitoring: { ...DEFAULT_MONITORING_CONFIG },
    api: { host: "127.0.0.1", port: 3010, allowedOrigins: [] },
    worker: { pollMs: 50, concurrency: 1 },
    admin: { displayName: "Test Admin", authMode: "local-only" },
    docker: { enabled: false, socketPath: "/var/run/docker.sock", composeCommand: "docker", operationTimeoutMs: 120_000, consoleShells: ["/bin/sh"] },
    shares: { enabled: false, account: { username: "cyberos-share", password: null }, shares: [] },
    hostd: { socketPath: path.join(dataDir, "hostd.sock") },
    terminal: { user: "test-user", socketPath: path.join(dataDir, "terminald.sock"), sessionIdleTimeoutMs: 60_000, connectTimeoutMs: 1_000, maxSessions: 4 },
    vodPlayer: { enabled: false, socketPath: path.join(dataDir, "vod.sock"), statePath: path.join(dataDir, "vod.json"), commandTimeoutMs: 5000, startupTimeoutMs: 15000, checkpointIntervalMs: 5000, retryBaseDelayMs: 2000, retryMaxDelayMs: 60000, videoOutput: "drm", drmConnector: null, audioOutput: "alsa", audioDevice: null, hwdec: "auto-safe", user: "cyberos" },
    health: { staleIndexWarningMs: 2 * 60 * 60 * 1000, staleIndexCriticalMs: 6 * 60 * 60 * 1000, stalledRunMs: 15 * 60 * 1000, consecutiveFailureThreshold: 2, backupStaleMs: 26 * 60 * 60 * 1000 },
  };
}
