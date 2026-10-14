import { randomUUID } from "node:crypto";
import type {
  FileBatchItemStatus,
  FileBatchOperation,
  FileBatchRecord,
  JobStatus
} from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import { createOperationNotification, updateOperationNotificationForJob } from "./operation-notifications.js";

export interface FileBatchItemRecord {
  id: string;
  batchId: string;
  ordinal: number;
  sourcePath: string;
  targetPath: string | null;
  trashEntryId: string | null;
  operationId: string;
  status: FileBatchItemStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedFileBatchItem {
  batch: FileBatchRecord;
  item: FileBatchItemRecord;
}

interface FileBatchRow {
  id: string;
  job_id: string;
  session_id: string;
  root_id: string;
  storage_pool_id: string;
  operation: FileBatchOperation;
  target_directory: string | null;
  status: FileBatchRecord["status"];
  total_count: number;
  completed_count: number;
  success_count: number;
  failed_count: number;
  cancelled_count: number;
  current_source_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface FileBatchItemRow {
  id: string;
  batch_id: string;
  ordinal: number;
  source_path: string;
  target_path: string | null;
  trash_entry_id: string | null;
  operation_id: string;
  status: FileBatchItemStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const BATCH_COLUMNS = `
  b.id, b.job_id, b.session_id, b.root_id, b.storage_pool_id,
  b.operation, b.target_directory, j.status, b.total_count,
  b.completed_count, b.success_count, b.failed_count, b.cancelled_count,
  b.current_source_path, j.error, b.created_at, b.updated_at, b.finished_at
`;

const ITEM_COLUMNS = `
  id, batch_id, ordinal, source_path, target_path, trash_entry_id,
  operation_id, status, error, created_at, updated_at
`;

export function createFileBatch(
  db: ZosDatabase,
  input: {
    sessionId: string;
    rootId: string;
    storagePoolId: string;
    operation: FileBatchOperation;
    targetDirectory?: string | null;
    summary: string;
    items: Array<{
      sourcePath: string;
      targetPath?: string | null;
      trashEntryId?: string | null;
    }>;
  }
): FileBatchRecord {
  if (input.items.length === 0) {
    throw new Error("File batch must contain at least one item");
  }

  const now = new Date().toISOString();
  const messageId = randomUUID();
  const jobId = randomUUID();
  const batchId = randomUUID();
  const duplicateQuery = db.prepare(`
    SELECT i.source_path
    FROM file_batch_items i
    JOIN file_batches b ON b.id = i.batch_id
    JOIN jobs j ON j.id = b.job_id
    WHERE b.root_id = ? AND b.storage_pool_id = ? AND i.source_path = ?
      AND j.status IN ('queued', 'running')
    LIMIT 1
  `);

  const transaction = db.transaction(() => {
    const duplicatePaths = input.items
      .map((item) => duplicateQuery.pluck().get(input.rootId, input.storagePoolId, item.sourcePath) as string | undefined)
      .filter((sourcePath): sourcePath is string => Boolean(sourcePath));
    if (duplicatePaths.length > 0) {
      throw new FileBatchConflictError([...new Set(duplicatePaths)]);
    }

    db.prepare(`
      INSERT INTO agent_messages (id, session_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, ?)
    `).run(messageId, input.sessionId, input.summary, now);
    db.prepare(`
      INSERT INTO jobs (id, session_id, message_id, kind, status, error, created_at, updated_at)
      VALUES (?, ?, ?, 'file_batch', 'queued', NULL, ?, ?)
    `).run(jobId, input.sessionId, messageId, now, now);
    db.prepare(`
      INSERT INTO file_batches (
        id, job_id, session_id, root_id, storage_pool_id, operation,
        target_directory, total_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      jobId,
      input.sessionId,
      input.rootId,
      input.storagePoolId,
      input.operation,
      input.targetDirectory ?? null,
      input.items.length,
      now,
      now
    );

    const insertItem = db.prepare(`
      INSERT INTO file_batch_items (
        id, batch_id, ordinal, source_path, target_path, trash_entry_id,
        operation_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `);
    input.items.forEach((item, ordinal) => {
      insertItem.run(
        randomUUID(),
        batchId,
        ordinal,
        item.sourcePath,
        item.targetPath ?? null,
        item.trashEntryId ?? (input.operation === "trash" ? randomUUID() : null),
        randomUUID(),
        now,
        now
      );
    });

    createOperationNotification(db, {
      jobId,
      sessionId: input.sessionId,
      kind: "file",
      status: "running",
      summary: input.summary,
      now: new Date(now)
    });
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId);
  });
  transaction.immediate();
  return getRequiredFileBatch(db, batchId);
}

export class FileBatchConflictError extends Error {
  constructor(readonly sourcePaths: string[]) {
    super("One or more files already have an active batch operation");
    this.name = "FileBatchConflictError";
  }
}

export function getFileBatch(db: ZosDatabase, id: string): FileBatchRecord | null {
  const row = db.prepare(`
    SELECT ${BATCH_COLUMNS}
    FROM file_batches b
    JOIN jobs j ON j.id = b.job_id
    WHERE b.id = ?
  `).get(id) as FileBatchRow | undefined;
  return row ? mapFileBatch(db, row) : null;
}

export function listFileBatches(
  db: ZosDatabase,
  input: { sessionId?: string; rootId?: string; storagePoolId?: string; limit?: number } = {}
): FileBatchRecord[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (input.sessionId) {
    clauses.push("b.session_id = ?");
    values.push(input.sessionId);
  }
  if (input.rootId) {
    clauses.push("b.root_id = ?");
    values.push(input.rootId);
  }
  if (input.storagePoolId) {
    clauses.push("b.storage_pool_id = ?");
    values.push(input.storagePoolId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = db.prepare(`
    SELECT ${BATCH_COLUMNS}
    FROM file_batches b
    JOIN jobs j ON j.id = b.job_id
    ${where}
    ORDER BY b.created_at DESC
    LIMIT ?
  `).all(...values, limit) as FileBatchRow[];
  return rows.map((row) => mapFileBatch(db, row));
}

export function recoverInterruptedFileBatches(db: ZosDatabase): number {
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    const items = db.prepare(`
      UPDATE file_batch_items
      SET status = 'queued', error = NULL, updated_at = ?
      WHERE status = 'running'
        AND batch_id IN (
          SELECT b.id FROM file_batches b
          JOIN jobs j ON j.id = b.job_id
          WHERE j.kind = 'file_batch' AND j.status = 'running'
        )
    `).run(now).changes;
    db.prepare(`
      UPDATE jobs
      SET status = 'queued', updated_at = ?
      WHERE kind = 'file_batch' AND status = 'running'
    `).run(now);
    db.prepare(`
      UPDATE file_batches
      SET current_source_path = NULL, updated_at = ?
      WHERE job_id IN (SELECT id FROM jobs WHERE kind = 'file_batch' AND status = 'queued')
    `).run(now);
    return items;
  });
  return transaction.immediate();
}

export function claimNextFileBatchItem(db: ZosDatabase): ClaimedFileBatchItem | null {
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    const candidate = db.prepare(`
      SELECT i.id, i.batch_id
      FROM file_batch_items i
      JOIN file_batches b ON b.id = i.batch_id
      JOIN jobs j ON j.id = b.job_id
      WHERE i.status = 'queued' AND j.kind = 'file_batch'
        AND j.status IN ('queued', 'running')
      ORDER BY b.created_at ASC, i.ordinal ASC
      LIMIT 1
    `).get() as { id: string; batch_id: string } | undefined;
    if (!candidate) return null;

    const itemRow = db.prepare(`
      UPDATE file_batch_items
      SET status = 'running', error = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'
      RETURNING ${ITEM_COLUMNS}
    `).get(now, candidate.id) as FileBatchItemRow | undefined;
    if (!itemRow) return null;

    const batch = getRequiredFileBatch(db, candidate.batch_id);
    db.prepare(`
      UPDATE jobs SET status = 'running', error = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(now, batch.jobId);
    db.prepare(`
      UPDATE file_batches SET current_source_path = ?, updated_at = ? WHERE id = ?
    `).run(itemRow.source_path, now, batch.id);
    updateOperationNotificationForJob(db, { jobId: batch.jobId, status: "running", now: new Date(now) });

    return {
      batch: getRequiredFileBatch(db, batch.id),
      item: mapFileBatchItem(itemRow)
    };
  });
  return transaction.immediate();
}

export function finishFileBatchItem(
  db: ZosDatabase,
  input: { itemId: string; status: Extract<FileBatchItemStatus, "completed" | "failed">; error?: string | null }
): { batch: FileBatchRecord; finalStatus: Extract<JobStatus, "completed" | "failed" | "cancelled"> | null } {
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    const item = db.prepare(`SELECT ${ITEM_COLUMNS} FROM file_batch_items WHERE id = ?`)
      .get(input.itemId) as FileBatchItemRow | undefined;
    if (!item) throw new Error("File batch item not found");

    db.prepare(`
      UPDATE file_batch_items
      SET status = ?, error = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(input.status, input.error ?? null, now, item.id);

    const batch = getRequiredFileBatch(db, item.batch_id);
    const jobStatus = db.prepare("SELECT status FROM jobs WHERE id = ?").pluck().get(batch.jobId) as JobStatus;
    if (jobStatus === "cancelled") {
      db.prepare(`
        UPDATE file_batch_items SET status = 'cancelled', updated_at = ?
        WHERE batch_id = ? AND status = 'queued'
      `).run(now, batch.id);
    }
    refreshBatchCounts(db, batch.id, now);

    const activeCount = Number(db.prepare(`
      SELECT COUNT(*) FROM file_batch_items WHERE batch_id = ? AND status IN ('queued', 'running')
    `).pluck().get(batch.id) ?? 0);
    let finalStatus: Extract<JobStatus, "completed" | "failed" | "cancelled"> | null = null;
    if (activeCount === 0) {
      const refreshed = getRequiredFileBatch(db, batch.id);
      finalStatus = jobStatus === "cancelled" ? "cancelled" : refreshed.failedCount > 0 ? "failed" : "completed";
      const error = finalStatus === "failed"
        ? `${refreshed.failedCount} of ${refreshed.totalCount} file operations failed`
        : null;
      db.prepare(`
        UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?
      `).run(finalStatus, error, now, refreshed.jobId);
      db.prepare(`
        UPDATE file_batches SET current_source_path = NULL, finished_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, refreshed.id);
      updateOperationNotificationForJob(db, {
        jobId: refreshed.jobId,
        status: finalStatus === "completed" ? "succeeded" : finalStatus,
        error,
        now: new Date(now)
      });
    } else {
      db.prepare("UPDATE file_batches SET current_source_path = NULL, updated_at = ? WHERE id = ?")
        .run(now, batch.id);
    }
    return { batch: getRequiredFileBatch(db, batch.id), finalStatus };
  });
  return transaction.immediate();
}

export function cancelQueuedFileBatchItems(db: ZosDatabase, jobId: string): FileBatchRecord | null {
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    const row = db.prepare("SELECT id FROM file_batches WHERE job_id = ?").get(jobId) as { id: string } | undefined;
    if (!row) return null;
    db.prepare(`
      UPDATE file_batch_items SET status = 'cancelled', updated_at = ?
      WHERE batch_id = ? AND status = 'queued'
    `).run(now, row.id);
    refreshBatchCounts(db, row.id, now);
    const running = Number(db.prepare(`
      SELECT COUNT(*) FROM file_batch_items WHERE batch_id = ? AND status = 'running'
    `).pluck().get(row.id) ?? 0);
    if (running === 0) {
      db.prepare(`
        UPDATE file_batches SET current_source_path = NULL, finished_at = COALESCE(finished_at, ?), updated_at = ?
        WHERE id = ?
      `).run(now, now, row.id);
    }
    return getRequiredFileBatch(db, row.id);
  });
  return transaction.immediate();
}

function refreshBatchCounts(db: ZosDatabase, batchId: string, now: string): void {
  db.prepare(`
    UPDATE file_batches
    SET completed_count = (SELECT COUNT(*) FROM file_batch_items WHERE batch_id = ? AND status IN ('completed', 'failed', 'cancelled')),
        success_count = (SELECT COUNT(*) FROM file_batch_items WHERE batch_id = ? AND status = 'completed'),
        failed_count = (SELECT COUNT(*) FROM file_batch_items WHERE batch_id = ? AND status = 'failed'),
        cancelled_count = (SELECT COUNT(*) FROM file_batch_items WHERE batch_id = ? AND status = 'cancelled'),
        updated_at = ?
    WHERE id = ?
  `).run(batchId, batchId, batchId, batchId, now, batchId);
}

function getRequiredFileBatch(db: ZosDatabase, id: string): FileBatchRecord {
  const batch = getFileBatch(db, id);
  if (!batch) throw new Error("File batch not found");
  return batch;
}

function mapFileBatch(db: ZosDatabase, row: FileBatchRow): FileBatchRecord {
  const failures = db.prepare(`
    SELECT source_path, error
    FROM file_batch_items
    WHERE batch_id = ? AND status = 'failed' AND error IS NOT NULL
    ORDER BY ordinal ASC
    LIMIT 10
  `).all(row.id) as Array<{ source_path: string; error: string }>;
  return {
    id: row.id,
    jobId: row.job_id,
    sessionId: row.session_id,
    rootId: row.root_id,
    storagePoolId: row.storage_pool_id,
    operation: row.operation,
    targetDirectory: row.target_directory,
    status: row.status,
    totalCount: row.total_count,
    completedCount: row.completed_count,
    successCount: row.success_count,
    failedCount: row.failed_count,
    cancelledCount: row.cancelled_count,
    currentSourcePath: row.current_source_path,
    error: row.error,
    failures: failures.map((failure) => ({ sourcePath: failure.source_path, error: failure.error })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
  };
}

function mapFileBatchItem(row: FileBatchItemRow): FileBatchItemRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    ordinal: row.ordinal,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    trashEntryId: row.trash_entry_id,
    operationId: row.operation_id,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
