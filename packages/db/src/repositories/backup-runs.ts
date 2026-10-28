import { randomUUID } from "node:crypto";
import type {
  BackupFailure,
  BackupRunKind,
  BackupRunStatus,
  BackupRunSummary
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import type { DbBackupFailureRow, DbBackupRunRow } from "./repository-rows.js";

export function startBackupRun(db: CyberOsDatabase, input: { kind: BackupRunKind; now?: Date }): BackupRunSummary {
  const now = (input.now ?? new Date()).toISOString();
  const id = randomUUID();
  db.prepare("UPDATE backup_runs SET status = 'interrupted', finished_at = ?, error = 'interrupted' WHERE status IN ('validating', 'running')").run(now);
  db.prepare("INSERT INTO backup_runs (id, kind, status, started_at) VALUES (?, ?, 'running', ?)").run(id, input.kind, now);
  return { id, kind: input.kind, status: "running", startedAt: now, finishedAt: null, snapshotIds: [], files: 0, bytes: 0, verified: false, error: null, failures: [] };
}

export function recordBackupFailure(db: CyberOsDatabase, input: { runId: string; rootId?: string | null; path?: string | null; code?: string | null; reason: string; now?: Date }): void {
  db.prepare("INSERT INTO backup_failures (id, run_id, root_id, path, code, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), input.runId, input.rootId ?? null, input.path ?? null, input.code ?? null, input.reason, (input.now ?? new Date()).toISOString());
}

export function finishBackupRun(db: CyberOsDatabase, input: { runId: string; status: Exclude<BackupRunStatus, "never_run" | "validating" | "running">; snapshotIds?: string[]; files?: number; bytes?: number; verified?: boolean; error?: string | null; finishedAt?: Date }): BackupRunSummary | null {
  const finishedAt = (input.finishedAt ?? new Date()).toISOString();
  const result = db.prepare(`UPDATE backup_runs SET status = ?, finished_at = ?, snapshot_ids_json = ?, files = ?, bytes = ?, verified = ?, error = ? WHERE id = ? AND status IN ('validating', 'running')`)
    .run(input.status, finishedAt, JSON.stringify(input.snapshotIds ?? []), input.files ?? 0, input.bytes ?? 0, input.verified ? 1 : 0, input.error ?? null, input.runId);
  if (result.changes !== 1) return null;
  return getBackupRun(db, input.runId);
}

export function getBackupRun(db: CyberOsDatabase, runId: string): BackupRunSummary | null {
  const row = db.prepare("SELECT id, kind, status, started_at, finished_at, snapshot_ids_json, files, bytes, verified, error FROM backup_runs WHERE id = ?")
    .get(runId) as DbBackupRunRow | undefined;
  return row ? mapBackupRun(db, row) : null;
}

export function listBackupRuns(db: CyberOsDatabase, limit = 30): BackupRunSummary[] {
  const rows = db.prepare("SELECT id, kind, status, started_at, finished_at, snapshot_ids_json, files, bytes, verified, error FROM backup_runs ORDER BY started_at DESC LIMIT ?").all(limit) as DbBackupRunRow[];
  return rows.map((row) => mapBackupRun(db, row));
}

function mapBackupRun(db: CyberOsDatabase, row: DbBackupRunRow): BackupRunSummary {
  const failures = db.prepare("SELECT root_id, path, code, reason FROM backup_failures WHERE run_id = ? ORDER BY created_at ASC, id ASC").all(row.id) as DbBackupFailureRow[];
  let snapshotIds: string[] = [];
  try {
    const parsed = JSON.parse(row.snapshot_ids_json) as unknown;
    if (Array.isArray(parsed)) {
      snapshotIds = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    snapshotIds = [];
  }
  return {
    id: row.id, kind: row.kind, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at,
    snapshotIds, files: row.files, bytes: row.bytes,
    verified: row.verified === 1, error: row.error,
    failures: failures.map((failure): BackupFailure => ({
      ...(failure.root_id ? { rootId: failure.root_id } : {}),
      ...(failure.path ? { path: failure.path } : {}),
      ...(failure.code ? { code: failure.code } : {}),
      reason: failure.reason
    }))
  };
}
