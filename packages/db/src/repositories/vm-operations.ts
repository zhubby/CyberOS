import { randomUUID } from "node:crypto";
import type { VmOperationProposal, VmOperationRecord, VmOperationStatus } from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import { mapVmOperation } from "./operation-mappers.js";
import type { DbVmOperationRow } from "./repository-rows.js";

export function createVmOperationRecord(
  db: CyberOsDatabase,
  input: { proposal: VmOperationProposal }
): VmOperationRecord {
  const now = new Date().toISOString();
  const operation: VmOperationRecord = {
    id: randomUUID(), action: input.proposal.action,
    targetId: input.proposal.domainName ?? "new-vm", status: "proposed",
    metadata: { proposal: input.proposal }, createdAt: now, updatedAt: now
  };
  db.prepare(`INSERT INTO vm_operations (id, action, target_id, status, metadata_json, created_at, updated_at)
    VALUES (@id, @action, @targetId, @status, @metadataJson, @createdAt, @updatedAt)`).run({
    ...operation, metadataJson: JSON.stringify(operation.metadata)
  });
  return operation;
}

export function getVmOperation(db: CyberOsDatabase, id: string): VmOperationRecord | null {
  const row = db.prepare(`SELECT id, action, target_id, status, metadata_json, created_at, updated_at
    FROM vm_operations WHERE id = ?`).get(id) as DbVmOperationRow | undefined;
  return row ? mapVmOperation(row) : null;
}

export function getProposedVmOperationForTarget(db: CyberOsDatabase, targetId: string): VmOperationRecord | null {
  const row = db.prepare(`SELECT id, action, target_id, status, metadata_json, created_at, updated_at
    FROM vm_operations WHERE target_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1`)
    .get(targetId) as DbVmOperationRow | undefined;
  return row ? mapVmOperation(row) : null;
}

export function listVmOperations(db: CyberOsDatabase, input: { limit?: number } = {}): VmOperationRecord[] {
  const rows = db.prepare(`SELECT o.id, o.action, o.target_id, o.status, o.metadata_json, o.created_at, o.updated_at
    FROM vm_operations o ORDER BY o.created_at DESC LIMIT ?`)
    .all(input.limit ?? 100) as DbVmOperationRow[];
  return rows.map(mapVmOperation);
}

export function updateVmOperationStatus(
  db: CyberOsDatabase, id: string, status: VmOperationStatus, metadata: Record<string, unknown> = {}
): VmOperationRecord | null {
  const existing = getVmOperation(db, id);
  if (!existing) return null;
  const nextMetadata = { ...existing.metadata, ...metadata };
  const row = db.prepare(`UPDATE vm_operations SET status = ?, metadata_json = ?, updated_at = ? WHERE id = ?
    RETURNING id, action, target_id, status, metadata_json, created_at, updated_at`)
    .get(status, JSON.stringify(nextMetadata), new Date().toISOString(), id) as DbVmOperationRow | undefined;
  return row ? mapVmOperation(row) : null;
}
