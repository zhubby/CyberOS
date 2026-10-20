import { randomUUID } from "node:crypto";
import type { PendingApprovalRecord, VmOperationProposal, VmOperationRecord, VmOperationStatus } from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import { getJob } from "./jobs.js";
import { mapVmOperation } from "./operation-mappers.js";
import type { DbVmOperationRow } from "./repository-rows.js";
import { VM_CONSOLE_AUTHORIZATION_TTL_MS } from "./vm-console-authorizations.js";

const EXPIRED_CONSOLE_ERROR = "VM console approval expired before the console was opened";

export function createVmOperationApproval(
  db: ZosDatabase,
  input: { jobId: string; proposal: VmOperationProposal }
): { approval: PendingApprovalRecord; operation: VmOperationRecord } {
  const job = getJob(db, input.jobId);
  if (!job) throw new Error("Job not found");
  const now = new Date().toISOString();
  const approval: PendingApprovalRecord = {
    id: randomUUID(), jobId: job.id, sessionId: job.sessionId, kind: "vm_operation", status: "pending",
    proposal: [input.proposal], createdAt: now, updatedAt: now
  };
  const targetId = input.proposal.domainName ?? "new-vm";
  const operation: VmOperationRecord = {
    id: randomUUID(), approvalId: approval.id, action: input.proposal.action, targetId,
    status: "proposed", metadata: { proposal: input.proposal }, createdAt: now, updatedAt: now
  };
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO pending_approvals (id, job_id, kind, status, proposal_json, created_at, updated_at)
      VALUES (?, ?, 'vm_operation', 'pending', ?, ?, ?)`).run(
      approval.id, approval.jobId, JSON.stringify(approval.proposal), now, now
    );
    db.prepare(`INSERT INTO vm_operations (id, approval_id, action, target_id, status, metadata_json, created_at, updated_at)
      VALUES (@id, @approvalId, @action, @targetId, @status, @metadataJson, @createdAt, @updatedAt)`).run({
      ...operation, metadataJson: JSON.stringify(operation.metadata)
    });
  });
  tx();
  return { approval, operation };
}

export function createVmOperationRecord(
  db: ZosDatabase,
  input: { proposal: VmOperationProposal }
): VmOperationRecord {
  const now = new Date().toISOString();
  const operation: VmOperationRecord = {
    id: randomUUID(), approvalId: null, action: input.proposal.action,
    targetId: input.proposal.domainName ?? "new-vm", status: "proposed",
    metadata: { proposal: input.proposal }, createdAt: now, updatedAt: now
  };
  db.prepare(`INSERT INTO vm_operations (id, approval_id, action, target_id, status, metadata_json, created_at, updated_at)
    VALUES (@id, NULL, @action, @targetId, @status, @metadataJson, @createdAt, @updatedAt)`).run({
    ...operation, metadataJson: JSON.stringify(operation.metadata)
  });
  return operation;
}

export function getVmOperation(db: ZosDatabase, id: string): VmOperationRecord | null {
  const row = db.prepare(`SELECT id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
    FROM vm_operations WHERE id = ?`).get(id) as DbVmOperationRow | undefined;
  return row ? mapVmOperation(row) : null;
}

export function getVmOperationByApproval(db: ZosDatabase, approvalId: string): VmOperationRecord | null {
  const row = db.prepare(`SELECT id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
    FROM vm_operations WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1`).get(approvalId) as DbVmOperationRow | undefined;
  return row ? mapVmOperation(row) : null;
}

export function getProposedVmOperationForTarget(db: ZosDatabase, targetId: string): VmOperationRecord | null {
  const row = db.prepare(`SELECT id, approval_id, action, target_id, status, metadata_json, created_at, updated_at
    FROM vm_operations WHERE target_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1`)
    .get(targetId) as DbVmOperationRow | undefined;
  return row ? mapVmOperation(row) : null;
}

export function expireStaleVmConsoleOperations(db: ZosDatabase, now = new Date()): number {
  const timestamp = now.toISOString();
  const cutoff = new Date(now.getTime() - VM_CONSOLE_AUTHORIZATION_TTL_MS).toISOString();
  const rows = db.prepare(`SELECT o.id, o.approval_id, a.job_id
    FROM vm_operations o
    JOIN pending_approvals a ON a.id = o.approval_id
    JOIN jobs j ON j.id = a.job_id
    WHERE o.action = 'console' AND o.status = 'approved'
      AND a.status = 'approved' AND j.status = 'waiting_approval'
      AND o.updated_at <= ?`).all(cutoff) as Array<{ id: string; approval_id: string; job_id: string }>;

  const expire = db.transaction(() => {
    let expired = 0;
    for (const row of rows) {
      const approval = db.prepare(`UPDATE pending_approvals
        SET status = 'expired', updated_at = ?
        WHERE id = ? AND status = 'approved'`).run(timestamp, row.approval_id);
      if (approval.changes !== 1) continue;

      const operation = db.prepare(`UPDATE vm_operations
        SET status = 'failed',
            metadata_json = json_set(metadata_json, '$.error', ?, '$.failedAt', ?),
            updated_at = ?
        WHERE id = ? AND status = 'approved'`).run(EXPIRED_CONSOLE_ERROR, timestamp, timestamp, row.id);
      const job = db.prepare(`UPDATE jobs
        SET status = 'cancelled', error = ?, updated_at = ?
        WHERE id = ? AND status = 'waiting_approval'`).run(EXPIRED_CONSOLE_ERROR, timestamp, row.job_id);
      if (operation.changes !== 1 || job.changes !== 1) {
        throw new Error("Failed to expire a stale VM console operation atomically");
      }
      db.prepare(`UPDATE operation_notifications
        SET status = 'cancelled', error = ?, read_at = NULL, updated_at = ?
        WHERE job_id = ?`).run(EXPIRED_CONSOLE_ERROR, timestamp, row.job_id);
      expired += 1;
    }
    return expired;
  });

  return expire();
}

export function listVmOperations(db: ZosDatabase, input: { limit?: number } = {}): VmOperationRecord[] {
  const rows = db.prepare(`SELECT o.id, o.approval_id, o.action, o.target_id, o.status, o.metadata_json, o.created_at, o.updated_at
    FROM vm_operations o ORDER BY o.created_at DESC LIMIT ?`)
    .all(input.limit ?? 100) as DbVmOperationRow[];
  return rows.map(mapVmOperation);
}

export function updateVmOperationStatus(
  db: ZosDatabase, id: string, status: VmOperationStatus, metadata: Record<string, unknown> = {}
): VmOperationRecord | null {
  const existing = getVmOperation(db, id);
  if (!existing) return null;
  const nextMetadata = { ...existing.metadata, ...metadata };
  const row = db.prepare(`UPDATE vm_operations SET status = ?, metadata_json = ?, updated_at = ? WHERE id = ?
    RETURNING id, approval_id, action, target_id, status, metadata_json, created_at, updated_at`)
    .get(status, JSON.stringify(nextMetadata), new Date().toISOString(), id) as DbVmOperationRow | undefined;
  return row ? mapVmOperation(row) : null;
}
