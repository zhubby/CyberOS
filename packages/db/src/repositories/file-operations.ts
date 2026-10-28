import { randomUUID } from "node:crypto";
import type {
  FileMutationOperation,
  FileOperationRecord,
  FileOperationStatus,
  TrashEntryRecord
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import { mapOperation, mapTrashEntry } from "./operation-mappers.js";
import type { DbOperationRow, DbTrashEntryRow } from "./repository-rows.js";
import { enqueueIndexTask } from "./indexer-queue.js";

export function recordAppliedOperation(
  db: CyberOsDatabase,
  input: {
    id?: string;
    operation: FileMutationOperation;
    sourcePath?: string | null;
    targetPath?: string | null;
    status: FileOperationStatus;
    metadata?: Record<string, unknown>;
  }
): FileOperationRecord {
  const now = new Date().toISOString();
  const operation: FileOperationRecord = {
    id: input.id ?? randomUUID(),
    operation: input.operation,
    sourcePath: input.sourcePath ?? null,
    targetPath: input.targetPath ?? null,
    status: input.status,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO file_operations (
      id, operation, source_path, target_path, status, metadata_json, created_at, updated_at
    )
    VALUES (@id, @operation, @sourcePath, @targetPath, @status, @metadataJson, @createdAt, @updatedAt)
  `).run({
    ...operation,
    metadataJson: JSON.stringify(operation.metadata)
  });

  if (operation.status === "applied") {
    enqueueAppliedOperationPaths(db, operation);
  }

  return operation;
}

function enqueueAppliedOperationPaths(db: CyberOsDatabase, operation: FileOperationRecord): void {
  const storagePoolId = typeof operation.metadata.storagePoolId === "string"
    ? operation.metadata.storagePoolId
    : null;
  if (!storagePoolId) return;
  const paths = indexableOperationPaths(operation);
  for (const path of paths) {
    try {
      enqueueIndexTask(db, {
        storagePoolId,
        path,
        recursive: ["copy", "extract", "mkdir", "move", "rename", "restore", "trash"].includes(operation.operation),
        kind: "incremental"
      });
    } catch (error) {
      const now = new Date().toISOString();
      const scope = `${storagePoolId}:${path}`;
      db.prepare(`
        INSERT INTO health_alerts (
          id, code, scope, storage_pool_id, severity, status, first_seen_at, last_seen_at, details
        ) VALUES (?, 'index_enqueue_failed', ?, ?, 'warning', 'active', ?, ?, ?)
        ON CONFLICT(code, scope) DO UPDATE SET
          status = 'active', last_seen_at = excluded.last_seen_at,
          resolved_at = NULL, details = excluded.details
      `).run(
        randomUUID(),
        scope,
        storagePoolId,
        now,
        now,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

function indexableOperationPaths(operation: FileOperationRecord): string[] {
  const candidates = (() => {
    switch (operation.operation) {
      case "move":
      case "rename":
        return [operation.sourcePath, operation.targetPath];
      case "edit":
      case "tag":
      case "trash":
        return [operation.sourcePath];
      case "copy":
      case "download":
      case "extract":
      case "mkdir":
      case "restore":
      case "upload":
        return [operation.targetPath];
    }
  })();
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

export function getFileOperation(db: CyberOsDatabase, operationId: string): FileOperationRecord | null {
  const row = db
    .prepare(`
      SELECT id, operation, source_path, target_path, status, metadata_json, created_at, updated_at
      FROM file_operations
      WHERE id = ?
    `)
    .get(operationId) as DbOperationRow | undefined;
  return row ? mapOperation(row) : null;
}

export function markFileOperationRolledBack(
  db: CyberOsDatabase,
  operationId: string,
  metadata: Record<string, unknown>
): boolean {
  const existing = getFileOperation(db, operationId);
  if (!existing || existing.status !== "applied") {
    return false;
  }

  const result = db
    .prepare(`
      UPDATE file_operations
      SET status = 'rolled_back', metadata_json = ?, updated_at = ?
      WHERE id = ? AND status = 'applied'
    `)
    .run(
      JSON.stringify({
        ...existing.metadata,
        rollback: metadata
      }),
      new Date().toISOString(),
      operationId
    );
  return result.changes === 1;
}

export function createTrashEntry(
  db: CyberOsDatabase,
  input: {
    id?: string;
    storagePoolId: string;
    originalPath: string;
    trashPath: string;
    metadata?: Record<string, unknown>;
  }
): TrashEntryRecord {
  const now = new Date().toISOString();
  const entry: TrashEntryRecord = {
    id: input.id ?? randomUUID(),
    storagePoolId: input.storagePoolId,
    originalPath: input.originalPath,
    trashPath: input.trashPath,
    metadata: input.metadata ?? {},
    createdAt: now,
    restoredAt: null
  };

  db.prepare(`
    INSERT INTO trash_entries (
      id, storage_pool_id, original_path, trash_path, metadata_json, created_at, restored_at
    )
    VALUES (@id, @storagePoolId, @originalPath, @trashPath, @metadataJson, @createdAt, @restoredAt)
  `).run({
    ...entry,
    metadataJson: JSON.stringify(entry.metadata)
  });

  return entry;
}

export function getTrashEntry(db: CyberOsDatabase, trashEntryId: string): TrashEntryRecord | null {
  const row = db
    .prepare(`
      SELECT id, storage_pool_id, original_path, trash_path, metadata_json, created_at, restored_at
      FROM trash_entries
      WHERE id = ?
    `)
    .get(trashEntryId) as DbTrashEntryRow | undefined;
  return row ? mapTrashEntry(row) : null;
}

export function markTrashEntryRestored(db: CyberOsDatabase, trashEntryId: string): boolean {
  const result = db
    .prepare("UPDATE trash_entries SET restored_at = ? WHERE id = ? AND restored_at IS NULL")
    .run(new Date().toISOString(), trashEntryId);
  return result.changes === 1;
}

export function listFileOperations(
  db: CyberOsDatabase,
  input: { limit?: number } = {}
): FileOperationRecord[] {
  const limit = input.limit ?? 100;
  const rows = db
    .prepare(`
      SELECT id, operation, source_path, target_path, status, metadata_json, created_at, updated_at
      FROM file_operations
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as DbOperationRow[];
  return rows.map(mapOperation);
}
