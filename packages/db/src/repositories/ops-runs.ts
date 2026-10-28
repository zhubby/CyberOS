import { randomUUID } from "node:crypto";
import {
  OPS_TASKS,
  type OpsRunRecord,
  type OpsTask,
  type OpsTaskOverview,
  type SystemOperationsResponse
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import type { DbOpsRunRow } from "./repository-rows.js";

const OPS_RUN_COLUMNS = `
  id, task, status, started_at, heartbeat_at, finished_at, summary_json, error
`;
const STALE_HEARTBEAT_MS = 2 * 60 * 1000;
const SUCCESS_MAX_AGE_MS: Record<OpsTask, number> = {
  health: 45 * 60 * 1000,
  maintenance: 48 * 60 * 60 * 1000
};

export function recoverStaleOpsRuns(
  db: CyberOsDatabase,
  input: { now?: Date; staleAfterMs?: number } = {}
): number {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - (input.staleAfterMs ?? STALE_HEARTBEAT_MS)).toISOString();
  return db.prepare(`
    UPDATE ops_runs
    SET status = 'interrupted', finished_at = ?,
      error = COALESCE(error, 'run heartbeat expired')
    WHERE status = 'running' AND heartbeat_at < ?
  `).run(now.toISOString(), cutoff).changes;
}

export function startOpsRun(
  db: CyberOsDatabase,
  input: { task: OpsTask; now?: Date }
): OpsRunRecord {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const start = db.transaction(() => {
    recoverStaleOpsRuns(db, { now });
    const running = db.prepare(`
      SELECT ${OPS_RUN_COLUMNS} FROM ops_runs
      WHERE task = ? AND status = 'running'
      ORDER BY started_at DESC LIMIT 1
    `).get(input.task) as DbOpsRunRow | undefined;
    if (running) throw new Error(`${input.task} operation is already running`);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO ops_runs (id, task, status, started_at, heartbeat_at)
      VALUES (?, ?, 'running', ?, ?)
    `).run(id, input.task, timestamp, timestamp);
    return mapOpsRun(db.prepare(`SELECT ${OPS_RUN_COLUMNS} FROM ops_runs WHERE id = ?`).get(id) as DbOpsRunRow);
  });
  return start.immediate();
}

export function heartbeatOpsRun(
  db: CyberOsDatabase,
  input: { runId: string; now?: Date }
): boolean {
  return db.prepare(`
    UPDATE ops_runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'
  `).run((input.now ?? new Date()).toISOString(), input.runId).changes === 1;
}

export function finishOpsRun(
  db: CyberOsDatabase,
  input: {
    runId: string;
    status: "completed" | "failed";
    summary?: Record<string, unknown> | null;
    error?: string | null;
    finishedAt?: Date;
  }
): OpsRunRecord | null {
  const finish = db.transaction(() => {
    const timestamp = (input.finishedAt ?? new Date()).toISOString();
    const result = db.prepare(`
      UPDATE ops_runs
      SET status = ?, heartbeat_at = ?, finished_at = ?, summary_json = ?, error = ?
      WHERE id = ? AND status = 'running'
    `).run(
      input.status,
      timestamp,
      timestamp,
      input.summary === undefined || input.summary === null ? null : JSON.stringify(input.summary),
      input.error ?? null,
      input.runId
    );
    if (result.changes !== 1) return null;
    const row = db.prepare(`SELECT ${OPS_RUN_COLUMNS} FROM ops_runs WHERE id = ?`)
      .get(input.runId) as DbOpsRunRow;
    retainOpsRuns(db, row.task);
    return mapOpsRun(row);
  });
  return finish.immediate();
}

export function listOpsRuns(
  db: CyberOsDatabase,
  input: { task?: OpsTask; limit?: number } = {}
): OpsRunRecord[] {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
  const rows = input.task
    ? db.prepare(`
        SELECT ${OPS_RUN_COLUMNS} FROM ops_runs
        WHERE task = ? ORDER BY started_at DESC, id DESC LIMIT ?
      `).all(input.task, limit)
    : db.prepare(`
        SELECT ${OPS_RUN_COLUMNS} FROM ops_runs
        ORDER BY started_at DESC, id DESC LIMIT ?
      `).all(limit);
  return (rows as DbOpsRunRow[]).map(mapOpsRun);
}

export function getOpsTaskOverview(
  db: CyberOsDatabase,
  task: OpsTask,
  now = new Date()
): OpsTaskOverview {
  const rows = db.prepare(`
    SELECT ${OPS_RUN_COLUMNS} FROM ops_runs
    WHERE task = ? ORDER BY started_at DESC, id DESC
  `).all(task) as DbOpsRunRow[];
  const latest = rows[0];
  const latestSuccess = rows.find((row) => row.status === "completed");
  if (!latest) return emptyOverview(task);

  const lastSuccessAt = latestSuccess?.finished_at ?? null;
  const lastDurationMs = latest.finished_at
    ? Math.max(0, Date.parse(latest.finished_at) - Date.parse(latest.started_at))
    : null;
  let status: OpsTaskOverview["status"];
  if (latest.status === "running") {
    status = now.getTime() - Date.parse(latest.heartbeat_at) > STALE_HEARTBEAT_MS ? "stale" : "running";
  } else if (latest.status === "failed" || latest.status === "interrupted") {
    status = "failed";
  } else if (!lastSuccessAt || now.getTime() - Date.parse(lastSuccessAt) > SUCCESS_MAX_AGE_MS[task]) {
    status = "stale";
  } else {
    status = "ready";
  }

  return {
    task,
    status,
    lastRunAt: latest.started_at,
    lastSuccessAt,
    lastDurationMs,
    error: latest.error
  };
}

export function getSystemOperations(
  db: CyberOsDatabase,
  input: { task?: OpsTask; limit?: number; now?: Date } = {}
): SystemOperationsResponse {
  const now = input.now ?? new Date();
  return {
    tasks: {
      health: getOpsTaskOverview(db, "health", now),
      maintenance: getOpsTaskOverview(db, "maintenance", now)
    },
    runs: listOpsRuns(db, input)
  };
}

function retainOpsRuns(db: CyberOsDatabase, task: OpsTask): void {
  db.prepare(`
    DELETE FROM ops_runs
    WHERE task = ? AND id IN (
      SELECT id FROM ops_runs
      WHERE task = ? AND status <> 'running'
      ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET 30
    )
  `).run(task, task);
}

function emptyOverview(task: OpsTask): OpsTaskOverview {
  return {
    task,
    status: "never_run",
    lastRunAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    error: null
  };
}

function mapOpsRun(row: DbOpsRunRow): OpsRunRecord {
  return {
    id: row.id,
    task: row.task,
    status: row.status,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    summary: parseSummary(row.summary_json),
    error: row.error
  };
}

function parseSummary(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function isOpsTask(value: string): value is OpsTask {
  return (OPS_TASKS as readonly string[]).includes(value);
}
