import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createActionMessageAndJob,
  createSession,
  finishBackupRun,
  listHealthAlerts,
  openCyberOsDb,
  resolveHealthAlert,
  runOpsMaintenanceRetention,
  startBackupRun,
  upsertHealthAlert,
  type CyberOsDatabase
} from "./index.js";

let tempDir: string;
let db: CyberOsDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "cyberos-ops-maintenance-"));
  db = openCyberOsDb(path.join(tempDir, "cyberos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("operations maintenance repository", () => {
  it("prunes old resolved alerts while preserving active alerts", () => {
    const old = new Date("2026-01-01T00:00:00.000Z");
    upsertHealthAlert(db, { code: "old_resolved", severity: "warning", now: old });
    resolveHealthAlert(db, { code: "old_resolved", now: old });
    upsertHealthAlert(db, { code: "old_active", severity: "critical", now: old });

    const result = runOpsMaintenanceRetention(db, new Date("2026-02-02T00:00:00.000Z"));

    expect(result.resolvedAlertsRemoved).toBe(1);
    expect(listHealthAlerts(db)).toEqual([
      expect.objectContaining({ code: "old_active", status: "active" })
    ]);
  });

  it("rolls back all retention deletes when a later step fails", () => {
    const session = createSession(db, { });
    const action = createActionMessageAndJob(db, {
      sessionId: session.id,
      content: "Old operation",
      kind: "file",
      status: "running"
    });
    db.prepare("UPDATE operation_notifications SET updated_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", action.notification.id);

    for (let index = 0; index < 31; index += 1) {
      const startedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0));
      const run = startBackupRun(db, { kind: "daily", now: startedAt });
      finishBackupRun(db, {
        runId: run.id,
        status: "completed",
        finishedAt: new Date(startedAt.getTime() + 1_000)
      });
    }
    db.exec(`
      CREATE TRIGGER block_ops_backup_retention
      BEFORE DELETE ON backup_runs
      BEGIN
        SELECT RAISE(ABORT, 'retention blocked');
      END;
    `);

    expect(() => runOpsMaintenanceRetention(db, new Date("2026-02-02T00:00:00.000Z")))
      .toThrow("retention blocked");
    expect(db.prepare("SELECT COUNT(*) FROM operation_notifications WHERE id = ?").pluck()
      .get(action.notification.id)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM backup_runs").pluck().get()).toBe(31);
  });
});
