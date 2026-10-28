import { randomUUID } from "node:crypto";
import type {
  PendingApprovalRecord,
  StorageOperationProposal,
  StorageOperationRecord,
  StorageOperationStatus
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import { getJob } from "./jobs.js";
import { mapStorageOperation } from "./operation-mappers.js";
import type { DbStorageOperationRow } from "./repository-rows.js";

export function createStorageOperationRecord(
  db: CyberOsDatabase,
  input: { proposal: StorageOperationProposal }
): StorageOperationRecord {
  const now = new Date().toISOString();
  const operation: StorageOperationRecord = {
    id: randomUUID(),
    approvalId: null,
    action: input.proposal.action,
    targetId: input.proposal.mountpoint,
    status: "proposed",
    metadata: { proposal: input.proposal },
    createdAt: now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO storage_operations (
      id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
    )
    VALUES (@id, NULL, @action, @targetId, @status, @metadataJson, @createdAt, @updatedAt)
  `).run({
    ...operation,
    metadataJson: JSON.stringify(operation.metadata)
  });

  return operation;
}

export function createStorageOperationApproval(
  db: CyberOsDatabase,
  input: { jobId: string; proposal: StorageOperationProposal }
): { approval: PendingApprovalRecord; operation: StorageOperationRecord } {
  const job = getJob(db, input.jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  const now = new Date().toISOString();
  const approval: PendingApprovalRecord = {
    id: randomUUID(),
    jobId: input.jobId,
    sessionId: job.sessionId,
    kind: "storage_operation",
    status: "pending",
    proposal: [input.proposal],
    createdAt: now,
    updatedAt: now
  };
  const operation: StorageOperationRecord = {
    id: randomUUID(),
    approvalId: approval.id,
    action: input.proposal.action,
    targetId: input.proposal.mountpoint,
    status: "proposed",
    metadata: { proposal: input.proposal },
    createdAt: now,
    updatedAt: now
  };

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO pending_approvals (id, job_id, kind, status, proposal_json, created_at, updated_at)
      VALUES (?, ?, 'storage_operation', 'pending', ?, ?, ?)
    `).run(approval.id, approval.jobId, JSON.stringify(approval.proposal), now, now);

    db.prepare(`
      INSERT INTO storage_operations (
        id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
      )
      VALUES (@id, @approvalId, @action, @targetId, @status, @metadataJson, @createdAt, @updatedAt)
    `).run({
      ...operation,
      metadataJson: JSON.stringify(operation.metadata)
    });
  });

  tx();
  return { approval, operation };
}

export function getStorageOperation(db: CyberOsDatabase, operationId: string): StorageOperationRecord | null {
  const row = db
    .prepare(`
      SELECT id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
      FROM storage_operations
      WHERE id = ?
    `)
    .get(operationId) as DbStorageOperationRow | undefined;
  return row ? mapStorageOperation(row) : null;
}

export function getStorageOperationByApproval(
  db: CyberOsDatabase,
  approvalId: string
): StorageOperationRecord | null {
  const row = db
    .prepare(`
      SELECT id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
      FROM storage_operations
      WHERE approval_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(approvalId) as DbStorageOperationRow | undefined;
  return row ? mapStorageOperation(row) : null;
}

export function listStorageOperations(
  db: CyberOsDatabase,
  input: { limit?: number } = {}
): StorageOperationRecord[] {
  const rows = db
    .prepare(`
      SELECT o.id, o.approval_id, o.action, o.target_id, o.status, o.metadata_json, o.created_at, o.updated_at
      FROM storage_operations o
      ORDER BY o.created_at DESC
      LIMIT ?
    `)
    .all(input.limit ?? 100) as DbStorageOperationRow[];
  return rows.map(mapStorageOperation);
}

export function updateStorageOperationStatus(
  db: CyberOsDatabase,
  operationId: string,
  status: StorageOperationStatus,
  metadata: Record<string, unknown> = {}
): StorageOperationRecord | null {
  const existing = getStorageOperation(db, operationId);
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
      UPDATE storage_operations
      SET status = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
      RETURNING id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
    `)
    .get(status, JSON.stringify(nextMetadata), now, operationId) as DbStorageOperationRow | undefined;
  return row ? mapStorageOperation(row) : null;
}
