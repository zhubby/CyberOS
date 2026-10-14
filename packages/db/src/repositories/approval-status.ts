import type { ApprovalStatus, PendingApprovalRecord } from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import { mapApproval } from "./operation-mappers.js";
import type { DbApprovalRow } from "./repository-rows.js";
import { updateOperationNotificationForJob } from "./operation-notifications.js";

export function listPendingApprovals(db: ZosDatabase): PendingApprovalRecord[] {
  const rows = db
    .prepare(`
      SELECT a.id, a.job_id, a.kind, a.status, a.proposal_json, a.created_at, a.updated_at, j.session_id
      FROM pending_approvals a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.status = 'pending'
      ORDER BY a.created_at ASC
    `)
    .all() as DbApprovalRow[];
  return rows.map(mapApproval);
}

export function updateApprovalStatus(
  db: ZosDatabase,
  approvalId: string,
  status: ApprovalStatus,
  allowedFrom?: ApprovalStatus[]
): boolean {
  const params: string[] = [status, new Date().toISOString(), approvalId];
  const statusGuard = allowedFrom?.length
    ? ` AND status IN (${allowedFrom.map(() => "?").join(", ")})`
    : "";
  if (allowedFrom?.length) {
    params.push(...allowedFrom);
  }

  const tx = db.transaction(() => {
    const row = db
      .prepare(`
        UPDATE pending_approvals
        SET status = ?, updated_at = ?
        WHERE id = ?${statusGuard}
        RETURNING job_id
      `)
      .get(...params) as { job_id: string } | undefined;
    if (!row) return false;

    updateOperationNotificationForJob(db, {
      jobId: row.job_id,
      status:
        status === "pending"
          ? "pending_approval"
          : status === "approved"
            ? "running"
            : status === "applied"
              ? "succeeded"
              : status === "rejected"
                ? "rejected"
                : status === "expired"
                  ? "cancelled"
                  : "failed"
    });
    return true;
  });
  return tx();
}
