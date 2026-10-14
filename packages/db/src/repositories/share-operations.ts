import { randomUUID } from "node:crypto";
import type {
  PendingApprovalRecord,
  ShareOperationProposal,
  ShareOperationRecord,
  ShareOperationStatus,
  ShareSettingsRecord
} from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import { getJob } from "./jobs.js";
import { mapShareOperation } from "./operation-mappers.js";
import type { DbShareOperationRow } from "./repository-rows.js";

export function createShareOperationApproval(
  db: ZosDatabase,
  input: { jobId: string; proposal: ShareOperationProposal; settings: ShareSettingsRecord }
): { approval: PendingApprovalRecord; operation: ShareOperationRecord } {
  const job = getJob(db, input.jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  const now = new Date().toISOString();
  const approval: PendingApprovalRecord = {
    id: randomUUID(),
    jobId: input.jobId,
    sessionId: job.sessionId,
    kind: "share_operation",
    status: "pending",
    proposal: [input.proposal],
    createdAt: now,
    updatedAt: now
  };
  const operation: ShareOperationRecord = {
    id: randomUUID(),
    approvalId: approval.id,
    action: input.proposal.action,
    targetId: "share-settings",
    status: "proposed",
    metadata: {
      proposal: input.proposal,
      settings: input.settings
    },
    createdAt: now,
    updatedAt: now
  };

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO pending_approvals (id, job_id, kind, status, proposal_json, created_at, updated_at)
      VALUES (?, ?, 'share_operation', 'pending', ?, ?, ?)
    `).run(approval.id, approval.jobId, JSON.stringify(approval.proposal), now, now);

    db.prepare(`
      INSERT INTO share_operations (
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

export function getShareOperation(db: ZosDatabase, operationId: string): ShareOperationRecord | null {
  const row = db
    .prepare(`
      SELECT id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
      FROM share_operations
      WHERE id = ?
    `)
    .get(operationId) as DbShareOperationRow | undefined;
  return row ? mapShareOperation(row) : null;
}

export function getShareOperationByApproval(
  db: ZosDatabase,
  approvalId: string
): ShareOperationRecord | null {
  const row = db
    .prepare(`
      SELECT id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
      FROM share_operations
      WHERE approval_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(approvalId) as DbShareOperationRow | undefined;
  return row ? mapShareOperation(row) : null;
}

export function listShareOperations(
  db: ZosDatabase,
  input: { sessionId?: string; limit?: number } = {}
): ShareOperationRecord[] {
  const rows = db
    .prepare(`
      SELECT o.id, o.approval_id, o.action, o.target_id, o.status, o.metadata_json, o.created_at, o.updated_at
      FROM share_operations o
      LEFT JOIN pending_approvals a ON a.id = o.approval_id
      LEFT JOIN jobs j ON j.id = a.job_id
      WHERE (? IS NULL OR j.session_id = ?)
      ORDER BY o.created_at DESC
      LIMIT ?
    `)
    .all(input.sessionId ?? null, input.sessionId ?? null, input.limit ?? 100) as DbShareOperationRow[];
  return rows.map(mapShareOperation);
}

export function updateShareOperationStatus(
  db: ZosDatabase,
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
      RETURNING id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
    `)
    .get(status, JSON.stringify(nextMetadata), now, operationId) as DbShareOperationRow | undefined;
  return row ? mapShareOperation(row) : null;
}
