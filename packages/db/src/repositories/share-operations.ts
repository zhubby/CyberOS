import { randomUUID } from "node:crypto";
import type {
  ShareOperationProposal,
  ShareOperationRecord,
  ShareOperationStatus,
  ShareSettingsRecord
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import { mapShareOperation } from "./operation-mappers.js";
import type { DbShareOperationRow } from "./repository-rows.js";

export function createShareOperationRecord(
  db: CyberOsDatabase,
  input: { proposal: ShareOperationProposal; settings: ShareSettingsRecord }
): ShareOperationRecord {
  const now = new Date().toISOString();
  const operation: ShareOperationRecord = {
    id: randomUUID(),
    action: input.proposal.action,
    targetId: "share-settings",
    status: "proposed",
    metadata: { proposal: input.proposal, settings: input.settings },
    createdAt: now,
    updatedAt: now
  };
  db.prepare(`
    INSERT INTO share_operations (
      id, action, target_id, status, metadata_json, created_at, updated_at
    ) VALUES (@id, @action, @targetId, @status, @metadataJson, @createdAt, @updatedAt)
  `).run({ ...operation, metadataJson: JSON.stringify(operation.metadata) });
  return operation;
}

export function getShareOperation(db: CyberOsDatabase, operationId: string): ShareOperationRecord | null {
  const row = db
    .prepare(`
      SELECT id, action, target_id, status, metadata_json, created_at, updated_at
      FROM share_operations
      WHERE id = ?
    `)
    .get(operationId) as DbShareOperationRow | undefined;
  return row ? mapShareOperation(row) : null;
}

export function listShareOperations(
  db: CyberOsDatabase,
  input: { limit?: number } = {}
): ShareOperationRecord[] {
  const rows = db
    .prepare(`
      SELECT o.id, o.action, o.target_id, o.status, o.metadata_json, o.created_at, o.updated_at
      FROM share_operations o
      ORDER BY o.created_at DESC
      LIMIT ?
    `)
    .all(input.limit ?? 100) as DbShareOperationRow[];
  return rows.map(mapShareOperation);
}

export function updateShareOperationStatus(
  db: CyberOsDatabase,
  operationId: string,
  status: ShareOperationStatus,
  metadata: Record<string, unknown> = {}
): ShareOperationRecord | null {
  const existing = getShareOperation(db, operationId);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const nextMetadata = {
    ...existing.metadata,
    ...metadata
  };
  const row = db
    .prepare(`
      UPDATE share_operations
      SET status = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
      RETURNING id, action, target_id, status, metadata_json, created_at, updated_at
    `)
    .get(status, JSON.stringify(nextMetadata), now, operationId) as DbShareOperationRow | undefined;
  return row ? mapShareOperation(row) : null;
}
