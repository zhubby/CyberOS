import { randomUUID } from "node:crypto";
import type { IndexRunKind, IndexRunStatus } from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import type { DbIndexFailureRow, DbIndexRunRow } from "./repository-rows.js";

export function recoverInterruptedIndexRuns(
  db: CyberOsDatabase,
  input: { storagePoolId?: string; now?: Date } = {}
): number {
  const now = (input.now ?? new Date()).toISOString();
  const tx = db.transaction(() => {
    const rootRows = input.storagePoolId
      ? ([{ storage_pool_id: input.storagePoolId }] as Array<{ storage_pool_id: string }>)
      : (db.prepare("SELECT DISTINCT storage_pool_id FROM index_runs").all() as Array<{
          storage_pool_id: string;
        }>);
    const result = input.storagePoolId
      ? db
          .prepare(`
            UPDATE index_runs
            SET status = 'failed', finished_at = ?, error = 'interrupted/superseded'
            WHERE storage_pool_id = ? AND status = 'running'
          `)
          .run(now, input.storagePoolId)
      : db
          .prepare(`
            UPDATE index_runs
            SET status = 'failed', finished_at = ?, error = 'interrupted/superseded'
            WHERE status = 'running'
          `)
          .run(now);

    for (const row of rootRows) {
      retainLatestFinalizedIndexRun(db, row.storage_pool_id);
    }
    return result.changes;
  });
  return tx.immediate();
}

function retainLatestFinalizedIndexRun(db: CyberOsDatabase, storagePoolId: string): void {
  const runs = db
    .prepare(`
      SELECT id, kind
      FROM index_runs
      WHERE storage_pool_id = ? AND status <> 'running'
      ORDER BY COALESCE(finished_at, started_at) DESC, started_at DESC, rowid DESC
    `)
    .all(storagePoolId) as Array<{ id: string; kind: IndexRunKind }>;
  const retained = new Set([
    runs[0]?.id,
    runs.find((run) => run.kind === "full")?.id
  ].filter((id): id is string => Boolean(id)));
  const staleRunIds = runs.filter((run) => !retained.has(run.id)).map((run) => run.id);
  if (staleRunIds.length > 0) {
    for (const run of staleRunIds) archiveIndexRun(db, run);
    const placeholders = staleRunIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM index_failures WHERE run_id IN (${placeholders})`).run(...staleRunIds);
    db.prepare(`DELETE FROM index_runs WHERE id IN (${placeholders})`).run(...staleRunIds);
  }
  const archivedStale = db.prepare("SELECT id FROM index_run_history WHERE storage_pool_id = ? ORDER BY started_at DESC LIMIT -1 OFFSET 29").all(storagePoolId) as Array<{ id: string }>;
  for (const { id } of archivedStale) db.prepare("DELETE FROM index_run_history WHERE id = ?").run(id);
}

function archiveIndexRun(db: CyberOsDatabase, runId: string): void {
  const row = db.prepare(`SELECT id, storage_pool_id, status, started_at, finished_at, scanned, indexed, unchanged, removed, skipped, failed, error, duration_ms, bytes, file_count, text_file_count, phase, current_path, last_progress_at, kind FROM index_runs WHERE id = ? AND status <> 'running'`).get(runId) as (DbIndexRunRow & { kind: IndexRunKind }) | undefined;
  if (!row) return;
  const failures = db.prepare("SELECT path, reason FROM index_failures WHERE run_id = ? ORDER BY created_at ASC, id ASC").all(runId) as DbIndexFailureRow[];
  db.prepare(`INSERT OR REPLACE INTO index_run_history (id, storage_pool_id, status, started_at, finished_at, scanned, indexed, unchanged, removed, skipped, failed, error, duration_ms, bytes, file_count, text_file_count, phase, current_path, last_progress_at, failures_json, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.storage_pool_id, row.status, row.started_at, row.finished_at, row.scanned, row.indexed, row.unchanged, row.removed, row.skipped, row.failed, row.error, row.duration_ms, row.bytes, row.file_count, row.text_file_count, row.phase, row.current_path, row.last_progress_at, JSON.stringify(failures), row.kind);
}

export function startIndexRun(
  db: CyberOsDatabase,
  input: { storagePoolId: string; kind?: IndexRunKind; now?: Date }
): { id: string; storagePoolId: string; startedAt: string } {
  recoverInterruptedIndexRuns(db, {
    storagePoolId: input.storagePoolId,
    ...(input.now ? { now: input.now } : {})
  });
  const id = randomUUID();
  const startedAt = (input.now ?? new Date()).toISOString();
  db.prepare(`
    INSERT INTO index_runs (id, storage_pool_id, status, started_at, kind)
    VALUES (?, ?, 'running', ?, ?)
  `).run(id, input.storagePoolId, startedAt, input.kind ?? "full");
  return { id, storagePoolId: input.storagePoolId, startedAt };
}

export function isIndexRunRunning(db: CyberOsDatabase, runId: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM index_runs WHERE id = ? AND status = 'running'")
      .get(runId)
  );
}

export function recordIndexFailure(
  db: CyberOsDatabase,
  input: { runId: string; storagePoolId?: string; path: string; reason: string; now?: Date }
): void {
  const run = db
    .prepare("SELECT storage_pool_id FROM index_runs WHERE id = ?")
    .get(input.runId) as { storage_pool_id: string } | undefined;
  if (!run) {
    throw new Error("Index run not found");
  }
  if (input.storagePoolId !== undefined && run.storage_pool_id !== input.storagePoolId) {
    throw new Error("Index failure storage pool does not match index run");
  }
  db.prepare(`
    INSERT INTO index_failures (id, run_id, storage_pool_id, path, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), input.runId, run.storage_pool_id, input.path, input.reason, (input.now ?? new Date()).toISOString());
}

export function finishIndexRun(
  db: CyberOsDatabase,
  input: {
    runId: string;
    status: Exclude<IndexRunStatus, "never_run" | "running">;
    scanned: number;
    indexed: number;
    unchanged: number;
    removed: number;
    skipped: number;
    failed: number;
    error?: string | null;
    durationMs?: number | null;
    bytes?: number;
    fileCount?: number;
    textFileCount?: number;
    phase?: string | null;
    currentPath?: string | null;
    lastProgressAt?: string | null;
    finishedAt?: Date;
  }
): boolean {
  const finishedAt = (input.finishedAt ?? new Date()).toISOString();
  const tx = db.transaction(() => {
    const run = db
      .prepare("SELECT storage_pool_id FROM index_runs WHERE id = ?")
      .get(input.runId) as { storage_pool_id: string } | undefined;
    if (!run) {
      // A superseded run may be cleaned up by the newer run before it reaches
      // its finalization point. Treat that as an already-finalized no-op so an
      // interrupted indexer cannot reject the whole process.
      return false;
    }

    const update = db.prepare(`
      UPDATE index_runs
      SET status = ?, finished_at = ?, scanned = ?, indexed = ?, unchanged = ?, removed = ?, skipped = ?, failed = ?, error = ?, duration_ms = ?, bytes = ?, file_count = ?, text_file_count = ?, phase = ?, current_path = ?, last_progress_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      input.status,
      finishedAt,
      input.scanned,
      input.indexed,
      input.unchanged,
      input.removed,
      input.skipped,
      input.failed,
      input.error ?? null,
      input.durationMs ?? null,
      input.bytes ?? 0,
      input.fileCount ?? input.indexed,
      input.textFileCount ?? 0,
      input.phase ?? null,
      input.currentPath ?? null,
      input.lastProgressAt ?? finishedAt,
      input.runId
    );

    if (update.changes === 0) {
      return false;
    }

    retainLatestFinalizedIndexRun(db, run.storage_pool_id);
    return true;
  });
  return tx.immediate();
}

export function updateIndexRunProgress(
  db: CyberOsDatabase,
  input: {
    runId: string;
    scanned: number;
    indexed: number;
    unchanged: number;
    removed: number;
    skipped: number;
    failed: number;
    phase?: string | null;
    currentPath?: string | null;
    bytes?: number;
    fileCount?: number;
    textFileCount?: number;
    at?: Date;
  }
): boolean {
  const at = (input.at ?? new Date()).toISOString();
  const result = db.prepare(`
    UPDATE index_runs
    SET scanned = ?, indexed = ?, unchanged = ?, removed = ?, skipped = ?, failed = ?,
      phase = ?, current_path = ?, bytes = ?, file_count = ?, text_file_count = ?, last_progress_at = ?
    WHERE id = ? AND status = 'running'
  `).run(
    input.scanned, input.indexed, input.unchanged, input.removed, input.skipped, input.failed,
    input.phase ?? null, input.currentPath ?? null, input.bytes ?? 0, input.fileCount ?? input.indexed,
    input.textFileCount ?? 0, at, input.runId
  );
  return result.changes === 1;
}
