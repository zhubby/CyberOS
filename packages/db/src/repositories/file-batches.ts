import { randomUUID } from "node:crypto";
import type { FileBatchItemStatus, FileBatchOperation, FileBatchRecord } from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import {
  createOperationNotification,
  updateOperationNotificationForOperation
} from "./operation-notifications.js";

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
  id, root_id, storage_pool_id, operation, target_directory, status,
  total_count, completed_count, success_count, failed_count, cancelled_count,
  current_source_path, error, created_at, updated_at, finished_at
`;

const ITEM_COLUMNS = `
  id, batch_id, ordinal, source_path, target_path, trash_entry_id,
  operation_id, status, error, created_at, updated_at
`;

export function createFileBatch(
  db: ZosDatabase,
  input: {
    rootId: string;
    storagePoolId: string;
    operation: FileBatchOperation;
    targetDirectory?: string | null;
    summary: string;
    items: Array<{ sourcePath: string; targetPath?: string | null; trashEntryId?: string | null }>;
  }
): FileBatchRecord {
  if (!input.items.length) throw new Error("File batch must contain at least one item");
  const now = new Date().toISOString();
  const batchId = randomUUID();
  const duplicateQuery = db.prepare(`
    SELECT i.source_path
    FROM file_batch_items i JOIN file_batches b ON b.id = i.batch_id
    WHERE b.root_id = ? AND b.storage_pool_id = ? AND i.source_path = ?
      AND b.status IN ('queued', 'running')
    LIMIT 1
  `);

  db.transaction(() => {
    const duplicatePaths = input.items
      .map((item) => duplicateQuery.pluck().get(input.rootId, input.storagePoolId, item.sourcePath) as string | undefined)
      .filter((sourcePath): sourcePath is string => Boolean(sourcePath));
    if (duplicatePaths.length) throw new FileBatchConflictError([...new Set(duplicatePaths)]);

    db.prepare(`
      INSERT INTO file_batches (
        id, root_id, storage_pool_id, operation, target_directory, status,
        total_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      batchId, input.rootId, input.storagePoolId, input.operation,
      input.targetDirectory ?? null, input.items.length, now, now
    );
    const insertItem = db.prepare(`
      INSERT INTO file_batch_items (
        id, batch_id, ordinal, source_path, target_path, trash_entry_id,
        operation_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `);
    input.items.forEach((item, ordinal) => {
      insertItem.run(
        randomUUID(), batchId, ordinal, item.sourcePath, item.targetPath ?? null,
        item.trashEntryId ?? (input.operation === "trash" ? randomUUID() : null),
        randomUUID(), now, now
      );
    });
    createOperationNotification(db, {
      operationId: batchId,
      kind: "file",
      status: "running",
      summary: input.summary,
      now: new Date(now)
    });
  }).immediate();
  return getRequiredFileBatch(db, batchId);
}

export class FileBatchConflictError extends Error {
  constructor(readonly sourcePaths: string[]) {
    super("One or more files already have an active batch operation");
    this.name = "FileBatchConflictError";
  }
}

export function getFileBatch(db: ZosDatabase, id: string): FileBatchRecord | null {
  const row = db.prepare(`SELECT ${BATCH_COLUMNS} FROM file_batches WHERE id = ?`).get(id) as FileBatchRow | undefined;
  return row ? mapFileBatch(db, row) : null;
}

export function listFileBatches(
  db: ZosDatabase,
  input: { rootId?: string; storagePoolId?: string; limit?: number } = {}
): FileBatchRecord[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (input.rootId) { clauses.push("root_id = ?"); values.push(input.rootId); }
  if (input.storagePoolId) { clauses.push("storage_pool_id = ?"); values.push(input.storagePoolId); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = db.prepare(`
    SELECT ${BATCH_COLUMNS} FROM file_batches ${where}
    ORDER BY created_at DESC LIMIT ?
  `).all(...values, limit) as FileBatchRow[];
  return rows.map((row) => mapFileBatch(db, row));
}

export function recoverInterruptedFileBatches(db: ZosDatabase): number {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const items = db.prepare(`
      UPDATE file_batch_items SET status = 'queued', error = NULL, updated_at = ?
      WHERE status = 'running' AND batch_id IN (SELECT id FROM file_batches WHERE status = 'running')
    `).run(now).changes;
    db.prepare(`
      UPDATE file_batches SET status = 'queued', current_source_path = NULL, updated_at = ?
      WHERE status = 'running'
    `).run(now);
    return items;
  }).immediate();
}

export function claimNextFileBatchItem(db: ZosDatabase): ClaimedFileBatchItem | null {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const candidate = db.prepare(`
      SELECT i.id, i.batch_id
      FROM file_batch_items i JOIN file_batches b ON b.id = i.batch_id
      WHERE i.status = 'queued' AND b.status IN ('queued', 'running')
      ORDER BY b.created_at, i.ordinal LIMIT 1
    `).get() as { id: string; batch_id: string } | undefined;
    if (!candidate) return null;
    const itemRow = db.prepare(`
      UPDATE file_batch_items SET status = 'running', error = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued' RETURNING ${ITEM_COLUMNS}
    `).get(now, candidate.id) as FileBatchItemRow | undefined;
    if (!itemRow) return null;
    db.prepare(`
      UPDATE file_batches SET status = 'running', current_source_path = ?, error = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(itemRow.source_path, now, candidate.batch_id);
    updateOperationNotificationForOperation(db, {
      operationId: candidate.batch_id,
      status: "running",
      now: new Date(now)
    });
    return { batch: getRequiredFileBatch(db, candidate.batch_id), item: mapFileBatchItem(itemRow) };
  }).immediate();
}

export function finishFileBatchItem(
  db: ZosDatabase,
  input: { itemId: string; status: Extract<FileBatchItemStatus, "completed" | "failed">; error?: string | null }
): { batch: FileBatchRecord; finalStatus: Extract<FileBatchRecord["status"], "completed" | "failed" | "cancelled"> | null } {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const item = db.prepare(`SELECT ${ITEM_COLUMNS} FROM file_batch_items WHERE id = ?`)
      .get(input.itemId) as FileBatchItemRow | undefined;
    if (!item) throw new Error("File batch item not found");
    db.prepare(`
      UPDATE file_batch_items SET status = ?, error = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(input.status, input.error ?? null, now, item.id);

    const batch = getRequiredFileBatch(db, item.batch_id);
    if (batch.status === "cancelled") {
      db.prepare(`UPDATE file_batch_items SET status = 'cancelled', updated_at = ?
        WHERE batch_id = ? AND status = 'queued'`).run(now, batch.id);
    }
    refreshBatchCounts(db, batch.id, now);
    const activeCount = Number(db.prepare(`
      SELECT COUNT(*) FROM file_batch_items WHERE batch_id = ? AND status IN ('queued', 'running')
    `).pluck().get(batch.id) ?? 0);
    let finalStatus: Extract<FileBatchRecord["status"], "completed" | "failed" | "cancelled"> | null = null;
    if (activeCount === 0) {
      const refreshed = getRequiredFileBatch(db, batch.id);
      finalStatus = batch.status === "cancelled" ? "cancelled" : refreshed.failedCount ? "failed" : "completed";
      const error = finalStatus === "failed"
        ? `${refreshed.failedCount} of ${refreshed.totalCount} file operations failed`
        : null;
      db.prepare(`
        UPDATE file_batches SET status = ?, error = ?, current_source_path = NULL,
          finished_at = ?, updated_at = ? WHERE id = ?
      `).run(finalStatus, error, now, now, batch.id);
      updateOperationNotificationForOperation(db, {
        operationId: batch.id,
        status: finalStatus === "completed" ? "succeeded" : finalStatus,
        error,
        now: new Date(now)
      });
    } else {
      db.prepare("UPDATE file_batches SET current_source_path = NULL, updated_at = ? WHERE id = ?").run(now, batch.id);
    }
    return { batch: getRequiredFileBatch(db, batch.id), finalStatus };
  }).immediate();
}

export function cancelFileBatch(db: ZosDatabase, batchId: string): FileBatchRecord | null {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const batch = getFileBatch(db, batchId);
    if (!batch) return null;
    if (batch.status === "completed" || batch.status === "failed") return batch;
    db.prepare(`UPDATE file_batches SET status = 'cancelled', error = NULL, updated_at = ? WHERE id = ?`).run(now, batch.id);
    db.prepare(`UPDATE file_batch_items SET status = 'cancelled', updated_at = ?
      WHERE batch_id = ? AND status = 'queued'`).run(now, batch.id);
    refreshBatchCounts(db, batch.id, now);
    const running = Number(db.prepare(`
      SELECT COUNT(*) FROM file_batch_items WHERE batch_id = ? AND status = 'running'
    `).pluck().get(batch.id) ?? 0);
    if (!running) {
      db.prepare(`UPDATE file_batches SET current_source_path = NULL,
        finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = ?`).run(now, now, batch.id);
    }
    updateOperationNotificationForOperation(db, {
      operationId: batch.id,
      status: "cancelled",
      now: new Date(now)
    });
    return getRequiredFileBatch(db, batch.id);
  }).immediate();
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
    SELECT source_path, error FROM file_batch_items
    WHERE batch_id = ? AND status = 'failed' AND error IS NOT NULL
    ORDER BY ordinal LIMIT 10
  `).all(row.id) as Array<{ source_path: string; error: string }>;
  return {
    id: row.id,
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
