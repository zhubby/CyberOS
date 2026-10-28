import { randomUUID } from "node:crypto";
import type {
  FileOperationProposal,
  PendingApprovalRecord,
  PiToolCallApproval
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import { getJob } from "./jobs.js";
import { mapApproval } from "./operation-mappers.js";
import type { DbApprovalRow } from "./repository-rows.js";

export function createPendingApproval(
  db: CyberOsDatabase,
  input: { jobId: string; proposal: FileOperationProposal[] }
): PendingApprovalRecord {
  const job = getJob(db, input.jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  const now = new Date().toISOString();
  const approval: PendingApprovalRecord = {
    id: randomUUID(),
    jobId: input.jobId,
    sessionId: job.sessionId,
    kind: "file_operation",
    status: "pending",
    proposal: input.proposal,
    createdAt: now,
    updatedAt: now
  };

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO pending_approvals (id, job_id, kind, status, proposal_json, created_at, updated_at)
      VALUES (?, ?, 'file_operation', 'pending', ?, ?, ?)
    `).run(approval.id, approval.jobId, JSON.stringify(approval.proposal), now, now);

    const insertOperation = db.prepare(`
      INSERT INTO file_operations (
        id, approval_id, operation, source_path, target_path, status, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)
    `);

    for (const proposed of input.proposal) {
      insertOperation.run(
        randomUUID(),
        approval.id,
        proposed.operation,
        proposed.sourcePath ?? null,
        proposed.targetPath ?? proposed.tag ?? proposed.trashEntryId ?? null,
        JSON.stringify({ proposal: proposed }),
        now,
        now
      );
    }
  });

  tx();
  return approval;
}

export function createPiToolCallApproval(
  db: CyberOsDatabase,
  input: { jobId: string; proposal: PiToolCallApproval }
): PendingApprovalRecord {
  const job = getJob(db, input.jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  const now = new Date().toISOString();
  const approval: PendingApprovalRecord = {
    id: randomUUID(),
    jobId: input.jobId,
    sessionId: job.sessionId,
    kind: "pi_tool_call",
    status: "pending",
    proposal: [input.proposal],
    createdAt: now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO pending_approvals (id, job_id, kind, status, proposal_json, created_at, updated_at)
    VALUES (?, ?, 'pi_tool_call', 'pending', ?, ?, ?)
  `).run(approval.id, approval.jobId, JSON.stringify(approval.proposal), now, now);

  return approval;
}

export function getApproval(db: CyberOsDatabase, approvalId: string): PendingApprovalRecord | null {
  const row = db
    .prepare(`
      SELECT a.id, a.job_id, a.kind, a.status, a.proposal_json, a.created_at, a.updated_at, j.session_id
      FROM pending_approvals a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ?
    `)
    .get(approvalId) as DbApprovalRow | undefined;
  return row ? mapApproval(row) : null;
}
