import { randomUUID } from "node:crypto";
import type {
  OperationNotificationKind,
  OperationNotificationRecord,
  OperationNotificationStatus
} from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import type { DbOperationNotificationRow } from "./repository-rows.js";

const NOTIFICATION_COLUMNS = `
  id, job_id, session_id, kind, status, summary, error, read_at, created_at, updated_at
`;

export function createOperationNotification(
  db: ZosDatabase,
  input: {
    jobId: string;
    sessionId: string;
    kind: OperationNotificationKind;
    status: OperationNotificationStatus;
    summary: string;
    now?: Date;
  }
): OperationNotificationRecord {
  const timestamp = (input.now ?? new Date()).toISOString();
  const record: OperationNotificationRecord = {
    id: randomUUID(),
    jobId: input.jobId,
    sessionId: input.sessionId,
    kind: input.kind,
    status: input.status,
    summary: input.summary,
    error: null,
    readAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  db.prepare(`
    INSERT INTO operation_notifications (
      id, job_id, session_id, kind, status, summary, error, read_at, created_at, updated_at
    ) VALUES (
      @id, @jobId, @sessionId, @kind, @status, @summary, @error, @readAt, @createdAt, @updatedAt
    )
  `).run(record);
  return record;
}

export function getOperationNotificationByJob(
  db: ZosDatabase,
  jobId: string
): OperationNotificationRecord | null {
  const row = db.prepare(`SELECT ${NOTIFICATION_COLUMNS} FROM operation_notifications WHERE job_id = ?`)
    .get(jobId) as DbOperationNotificationRow | undefined;
  return row ? mapOperationNotification(row) : null;
}

export function listOperationNotifications(
  db: ZosDatabase,
  input: { limit?: number; now?: Date } = {}
): OperationNotificationRecord[] {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  const cutoff = new Date((input.now ?? new Date()).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT ${NOTIFICATION_COLUMNS}
    FROM operation_notifications
    WHERE updated_at >= ?
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(cutoff, limit) as DbOperationNotificationRow[];
  return rows.map(mapOperationNotification);
}

export function countUnreadOperationNotifications(db: ZosDatabase, now = new Date()): number {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return Number(db.prepare(`
    SELECT COUNT(*)
    FROM operation_notifications
    WHERE read_at IS NULL AND updated_at >= ?
  `).pluck().get(cutoff) ?? 0);
}

export function markOperationNotificationRead(
  db: ZosDatabase,
  id: string,
  now = new Date()
): OperationNotificationRecord | null {
  const row = db.prepare(`
    UPDATE operation_notifications
    SET read_at = COALESCE(read_at, ?)
    WHERE id = ?
    RETURNING ${NOTIFICATION_COLUMNS}
  `).get(now.toISOString(), id) as DbOperationNotificationRow | undefined;
  return row ? mapOperationNotification(row) : null;
}

export function markAllOperationNotificationsRead(db: ZosDatabase, now = new Date()): number {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    UPDATE operation_notifications
    SET read_at = ?
    WHERE read_at IS NULL AND updated_at >= ?
  `).run(now.toISOString(), cutoff).changes;
}

export function updateOperationNotificationForJob(
  db: ZosDatabase,
  input: {
    jobId: string;
    status: OperationNotificationStatus;
    error?: string | null;
    now?: Date;
    preserveRejected?: boolean;
  }
): OperationNotificationRecord | null {
  const timestamp = (input.now ?? new Date()).toISOString();
  const rejectedGuard = input.preserveRejected ? " AND status <> 'rejected'" : "";
  const error = input.error ?? null;
  const row = db.prepare(`
    UPDATE operation_notifications
    SET status = ?, error = ?, read_at = NULL, updated_at = ?
    WHERE job_id = ?${rejectedGuard}
      AND (status <> ? OR error IS NOT ?)
    RETURNING ${NOTIFICATION_COLUMNS}
  `).get(input.status, error, timestamp, input.jobId, input.status, error) as DbOperationNotificationRow | undefined;
  return row ? mapOperationNotification(row) : null;
}

export function pruneOperationNotifications(db: ZosDatabase, now = new Date()): number {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare("DELETE FROM operation_notifications WHERE updated_at < ?").run(cutoff).changes;
}

function mapOperationNotification(row: DbOperationNotificationRow): OperationNotificationRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    error: row.error,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
