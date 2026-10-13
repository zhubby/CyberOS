import type { IndexFailure, IndexRootStatus } from "@sigmaos/shared";
import type { SigmaDatabase } from "../connection.js";
import type {
  DbIndexFailureRow,
  DbIndexHistoryRow,
  DbIndexRunRow
} from "./repository-rows.js";

export function listIndexRunHistory(db: SigmaDatabase, rootId: string, limit = 30): IndexRootStatus[] {
  const currentRows = db.prepare(`
    SELECT id, root_id, status, started_at, finished_at, scanned, indexed, unchanged, removed, skipped, failed, error,
      duration_ms, bytes, file_count, text_file_count, phase, current_path, last_progress_at
    FROM index_runs WHERE root_id = ?
  `).all(rootId) as DbIndexRunRow[];
  const archivedRows = db.prepare(`SELECT id, root_id, status, started_at, finished_at, scanned, indexed, unchanged, removed, skipped, failed, error, duration_ms, bytes, file_count, text_file_count, phase, current_path, last_progress_at, failures_json FROM index_run_history WHERE root_id = ? ORDER BY started_at DESC LIMIT ?`).all(rootId, limit) as DbIndexHistoryRow[];
  const rows = [...currentRows.map((row) => ({ row, failures: db.prepare("SELECT path, reason FROM index_failures WHERE run_id = ? ORDER BY created_at ASC, id ASC").all(row.id) as DbIndexFailureRow[] })), ...archivedRows.map((row) => ({ row, failures: JSON.parse(row.failures_json) as DbIndexFailureRow[] }))].sort((a, b) => b.row.started_at.localeCompare(a.row.started_at)).slice(0, limit);
  return rows.map(({ row, failures }) => {
    return mapIndexRun(row, failures);
  });
}

export function listIndexRootStatuses(db: SigmaDatabase, rootIds: string[]): IndexRootStatus[] {
  return rootIds.map((rootId) => getIndexRootStatus(db, rootId));
}

export function getIndexRootStatus(db: SigmaDatabase, rootId: string, now = new Date()): IndexRootStatus {
  const row = db
    .prepare(`
      SELECT id, root_id, status, started_at, finished_at, scanned, indexed, unchanged, removed, skipped, failed, error,
        duration_ms, bytes, file_count, text_file_count, phase, current_path, last_progress_at,
        NULL AS failures_json, 0 AS archived
      FROM index_runs
      WHERE root_id = ? AND kind = 'full'
      UNION ALL
      SELECT id, root_id, status, started_at, finished_at, scanned, indexed, unchanged, removed, skipped, failed, error,
        duration_ms, bytes, file_count, text_file_count, phase, current_path, last_progress_at,
        failures_json, 1 AS archived
      FROM index_run_history
      WHERE root_id = ? AND kind = 'full'
      ORDER BY started_at DESC
      LIMIT 1
    `)
    .get(rootId, rootId) as (DbIndexRunRow & { failures_json: string | null; archived: number }) | undefined;

  if (!row) {
    return {
      rootId,
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
    };
  }

  const failures = row.archived
    ? JSON.parse(row.failures_json ?? "[]") as DbIndexFailureRow[]
    : db
        .prepare(`
          SELECT path, reason
          FROM index_failures
          WHERE run_id = ?
          ORDER BY created_at ASC, id ASC
        `)
        .all(row.id) as DbIndexFailureRow[];

  const status = mapIndexRun(row, failures);
  if (status.metrics) {
    status.metrics.indexSizeBytes = getIndexSizeBytes(db);
    status.metrics.consecutiveFailures = countConsecutiveIndexFailures(db, rootId);
    status.metrics.freshnessMs = getIndexFreshnessMs(db, rootId, now);
  }
  return status;
}

function countConsecutiveIndexFailures(db: SigmaDatabase, rootId: string): number {
  const rows = db.prepare("SELECT status, started_at FROM index_runs WHERE root_id = ? AND kind = 'full' UNION ALL SELECT status, started_at FROM index_run_history WHERE root_id = ? AND kind = 'full' ORDER BY started_at DESC LIMIT 30").all(rootId, rootId) as Array<{ status: string; started_at: string }>;
  let count = 0;
  for (const row of rows) {
    if (row.status !== "failed") break;
    count += 1;
  }
  return count;
}

function getIndexFreshnessMs(db: SigmaDatabase, rootId: string, now = new Date()): number | null {
  const row = db
    .prepare(`
      SELECT MAX(finished_at) AS finished_at
      FROM (
        SELECT finished_at FROM index_runs WHERE root_id = ? AND kind = 'full' AND status = 'completed'
        UNION ALL
        SELECT finished_at FROM index_run_history WHERE root_id = ? AND kind = 'full' AND status = 'completed'
      )
    `)
    .get(rootId, rootId) as { finished_at: string | null } | undefined;
  if (!row?.finished_at) return null;
  const timestamp = Date.parse(row.finished_at);
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : null;
}

function getIndexSizeBytes(db: SigmaDatabase): number | null {
  try {
    const pageCount = Number(db.pragma("page_count", { simple: true }));
    const pageSize = Number(db.pragma("page_size", { simple: true }));
    const size = pageCount * pageSize;
    return Number.isSafeInteger(size) ? size : null;
  } catch {
    return null;
  }
}

function mapIndexRun(row: DbIndexRunRow, failures: DbIndexFailureRow[]): IndexRootStatus {
  const durationMs = row.duration_ms ?? (row.finished_at ? Math.max(0, Date.parse(row.finished_at) - Date.parse(row.started_at)) : null);
  const freshnessMs = row.finished_at ? Math.max(0, Date.now() - Date.parse(row.finished_at)) : null;
  return {
    rootId: row.root_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    scanned: row.scanned,
    indexed: row.indexed,
    unchanged: row.unchanged,
    removed: row.removed,
    skipped: row.skipped,
    failed: row.failed,
    failures: failures.map((failure): IndexFailure => ({ path: failure.path, reason: failure.reason })),
    progress: {
      phase: row.phase,
      currentPath: row.current_path,
      lastProgressAt: row.last_progress_at
    },
    metrics: {
      durationMs,
      scanRate: durationMs && durationMs > 0 ? row.scanned / (durationMs / 1000) : null,
      bytes: row.bytes,
      fileCount: row.file_count,
      textFileCount: row.text_file_count,
      indexSizeBytes: null,
      freshnessMs,
      consecutiveFailures: 0
    }
  };
}
