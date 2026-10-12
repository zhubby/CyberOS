import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  finishOpsRun,
  getOpsTaskOverview,
  getSystemOperations,
  heartbeatOpsRun,
  listOpsRuns,
  openSigmaDb,
  recoverStaleOpsRuns,
  startOpsRun,
  type SigmaDatabase
} from "./index.js";

let tempDir: string;
let db: SigmaDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "sigmaos-ops-runs-"));
  db = openSigmaDb(path.join(tempDir, "sigmaos.sqlite"));
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("operations run repository", () => {
  it("tracks start, heartbeat, completion, and task freshness", () => {
    const run = startOpsRun(db, {
      task: "health",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(getOpsTaskOverview(db, "health", new Date("2026-01-01T00:00:01.000Z")).status)
      .toBe("running");
    expect(heartbeatOpsRun(db, {
      runId: run.id,
      now: new Date("2026-01-01T00:00:05.000Z")
    })).toBe(true);

    expect(finishOpsRun(db, {
      runId: run.id,
      status: "completed",
      summary: { status: "ready" },
      finishedAt: new Date("2026-01-01T00:00:10.000Z")
    })).toMatchObject({ status: "completed", summary: { status: "ready" } });
    expect(getOpsTaskOverview(db, "health", new Date("2026-01-01T00:44:59.000Z")))
      .toMatchObject({ status: "ready", lastDurationMs: 10_000 });
    expect(getOpsTaskOverview(db, "health", new Date("2026-01-01T00:45:11.000Z")).status)
      .toBe("stale");
  });

  it("recovers expired heartbeats and rejects a duplicate live task run", () => {
    const stale = startOpsRun(db, {
      task: "maintenance",
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(recoverStaleOpsRuns(db, { now: new Date("2026-01-01T00:02:01.000Z") })).toBe(1);
    expect(listOpsRuns(db, { task: "maintenance" })[0]).toMatchObject({
      id: stale.id,
      status: "interrupted",
      error: "run heartbeat expired"
    });

    const active = startOpsRun(db, {
      task: "maintenance",
      now: new Date("2026-01-01T00:02:02.000Z")
    });
    expect(() => startOpsRun(db, {
      task: "maintenance",
      now: new Date("2026-01-01T00:02:03.000Z")
    })).toThrow("maintenance operation is already running");
    expect(active.status).toBe("running");
  });

  it("prioritizes a latest failure over an older successful run", () => {
    const success = startOpsRun(db, { task: "health", now: new Date("2026-01-01T00:00:00.000Z") });
    finishOpsRun(db, {
      runId: success.id,
      status: "completed",
      finishedAt: new Date("2026-01-01T00:00:01.000Z")
    });
    const failure = startOpsRun(db, { task: "health", now: new Date("2026-01-01T00:01:00.000Z") });
    finishOpsRun(db, {
      runId: failure.id,
      status: "failed",
      error: "database unavailable",
      finishedAt: new Date("2026-01-01T00:01:01.000Z")
    });

    expect(getOpsTaskOverview(db, "health", new Date("2026-01-01T00:02:00.000Z")))
      .toMatchObject({ status: "failed", error: "database unavailable" });
  });

  it("retains thirty finalized runs for each task", () => {
    for (let index = 0; index < 35; index += 1) {
      const startedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0));
      const run = startOpsRun(db, { task: "health", now: startedAt });
      finishOpsRun(db, {
        runId: run.id,
        status: "completed",
        finishedAt: new Date(startedAt.getTime() + 1000)
      });
    }
    expect(db.prepare("SELECT COUNT(*) FROM ops_runs WHERE task = 'health'").pluck().get()).toBe(30);
  });

  it("ignores malformed persisted summaries when listing API state", () => {
    const run = startOpsRun(db, { task: "health" });
    finishOpsRun(db, { runId: run.id, status: "completed" });
    db.prepare("UPDATE ops_runs SET summary_json = ? WHERE id = ?").run("{broken", run.id);

    expect(getSystemOperations(db).runs[0]).toMatchObject({ id: run.id, summary: null });
  });
});
