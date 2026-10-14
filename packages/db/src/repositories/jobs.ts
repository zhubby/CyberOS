import { randomUUID } from "node:crypto";
import type {
  AgentEventAudience,
  AgentEventRecord,
  AgentEventType,
  AgentMessageRecord,
  JobRecord,
  JobStatus,
  OperationNotificationKind,
  OperationNotificationStatus
} from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import { mapEvent, mapJob, mapMessage } from "./agent-mappers.js";
import type { DbEventRow, DbJobRow, DbMessageRow } from "./repository-rows.js";
import {
  createOperationNotification,
  updateOperationNotificationForJob
} from "./operation-notifications.js";

export function createUserMessageAndJob(
  db: ZosDatabase,
  input: { sessionId: string; content: string; status?: JobStatus }
): { message: AgentMessageRecord; job: JobRecord } {
  const now = new Date().toISOString();
  const message: AgentMessageRecord = {
    id: randomUUID(),
    sessionId: input.sessionId,
    role: "user",
    content: input.content,
    createdAt: now
  };
  const job: JobRecord = {
    id: randomUUID(),
    sessionId: input.sessionId,
    messageId: message.id,
    kind: "agent",
    status: input.status ?? "queued",
    createdAt: now,
    updatedAt: now,
    error: null
  };

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO agent_messages (id, session_id, role, content, created_at)
      VALUES (@id, @sessionId, @role, @content, @createdAt)
    `).run(message);
    db.prepare(`
      INSERT INTO jobs (id, session_id, message_id, kind, status, error, created_at, updated_at)
      VALUES (@id, @sessionId, @messageId, @kind, @status, @error, @createdAt, @updatedAt)
    `).run(job);
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId);
  });

  tx();
  return { message, job };
}

export function createActionMessageAndJob(
  db: ZosDatabase,
  input: {
    sessionId: string;
    content: string;
    kind: OperationNotificationKind;
    status: Extract<JobStatus, "running" | "waiting_approval">;
  }
): { message: AgentMessageRecord; job: JobRecord; notification: ReturnType<typeof createOperationNotification> } {
  const now = new Date();
  const createdAt = now.toISOString();
  const message: AgentMessageRecord = {
    id: randomUUID(),
    sessionId: input.sessionId,
    role: "system",
    content: input.content,
    createdAt
  };
  const job: JobRecord = {
    id: randomUUID(),
    sessionId: input.sessionId,
    messageId: message.id,
    kind: "agent",
    status: input.status,
    createdAt,
    updatedAt: createdAt,
    error: null
  };

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO agent_messages (id, session_id, role, content, created_at)
      VALUES (@id, @sessionId, @role, @content, @createdAt)
    `).run(message);
    db.prepare(`
      INSERT INTO jobs (id, session_id, message_id, kind, status, error, created_at, updated_at)
      VALUES (@id, @sessionId, @messageId, @kind, @status, @error, @createdAt, @updatedAt)
    `).run(job);
    const notification = createOperationNotification(db, {
      jobId: job.id,
      sessionId: input.sessionId,
      kind: input.kind,
      status: input.status === "waiting_approval" ? "pending_approval" : "running",
      summary: input.content,
      now
    });
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(createdAt, input.sessionId);
    return notification;
  });

  return { message, job, notification: tx() };
}

export function getMessage(db: ZosDatabase, messageId: string): AgentMessageRecord | null {
  const row = db
    .prepare("SELECT id, session_id, role, content, created_at FROM agent_messages WHERE id = ?")
    .get(messageId) as DbMessageRow | undefined;
  return row ? mapMessage(row) : null;
}

export function getJob(db: ZosDatabase, jobId: string): JobRecord | null {
  const row = db
    .prepare("SELECT id, session_id, message_id, kind, status, created_at, updated_at, error FROM jobs WHERE id = ?")
    .get(jobId) as DbJobRow | undefined;
  return row ? mapJob(row) : null;
}

export function claimNextJob(db: ZosDatabase): JobRecord | null {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const row = db.prepare(`
      UPDATE jobs
      SET status = 'running', error = NULL, updated_at = ?
      WHERE id = (
        SELECT id
        FROM jobs
        WHERE kind = 'agent' AND status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
      )
      AND status = 'queued'
      RETURNING id, session_id, message_id, kind, status, created_at, updated_at, error
    `).get(now) as DbJobRow | undefined;
    if (row) {
      updateOperationNotificationForJob(db, {
        jobId: row.id,
        status: "running",
        now: new Date(now)
      });
    }
    return row;
  });
  const row = tx();

  return row ? mapJob(row) : null;
}

export function updateJobStatus(
  db: ZosDatabase,
  jobId: string,
  status: JobStatus,
  error: string | null = null,
  allowedFrom?: JobStatus[]
): boolean {
  const updatedAt = new Date().toISOString();
  const params: Array<string | null> = [status, error, updatedAt, jobId];
  const statusGuard = allowedFrom?.length
    ? ` AND status IN (${allowedFrom.map(() => "?").join(", ")})`
    : "";

  if (allowedFrom?.length) {
    params.push(...allowedFrom);
  }

  const tx = db.transaction(() => {
    const result = db
      .prepare(`UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?${statusGuard}`)
      .run(...params);
    if (result.changes === 1) {
      if (status === "cancelled") {
        db.prepare(`
          UPDATE pending_approvals
          SET status = 'expired', updated_at = ?
          WHERE job_id = ? AND status = 'pending'
        `).run(updatedAt, jobId);
      }
      const notificationStatus = notificationStatusForJob(status);
      if (notificationStatus) {
        updateOperationNotificationForJob(db, {
          jobId,
          status: notificationStatus,
          error,
          preserveRejected: status === "completed"
        });
      }
    }
    return result.changes === 1;
  });
  return tx();
}

export function appendEvent<TPayload>(
  db: ZosDatabase,
  input: {
    sessionId: string;
    jobId?: string | null;
    type: AgentEventType;
    payload: TPayload;
  }
): AgentEventRecord<TPayload> {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare(`
      INSERT INTO agent_events (session_id, job_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(input.sessionId, input.jobId ?? null, input.type, JSON.stringify(input.payload), createdAt);

  return {
    id: Number(result.lastInsertRowid),
    sessionId: input.sessionId,
    jobId: input.jobId ?? null,
    type: input.type,
    audience: eventAudience(db, input.jobId ?? null),
    payload: input.payload,
    createdAt
  };
}

export function listEvents(
  db: ZosDatabase,
  input: { sessionId: string; afterId?: number; limit?: number }
): AgentEventRecord[] {
  const rows = db
    .prepare(`
      SELECT
        agent_events.id,
        agent_events.session_id,
        agent_events.job_id,
        agent_events.type,
        agent_events.payload_json,
        agent_events.created_at,
        agent_messages.role AS message_role
      FROM agent_events
      LEFT JOIN jobs ON jobs.id = agent_events.job_id
      LEFT JOIN agent_messages ON agent_messages.id = jobs.message_id
      WHERE agent_events.session_id = ? AND agent_events.id > ?
      ORDER BY agent_events.id ASC
      LIMIT ?
    `)
    .all(input.sessionId, input.afterId ?? 0, input.limit ?? 100) as DbEventRow[];

  return rows.map(mapEvent);
}

function notificationStatusForJob(status: JobStatus): OperationNotificationStatus | null {
  if (status === "waiting_approval") return "pending_approval";
  if (status === "queued" || status === "running") return "running";
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return null;
}

function eventAudience(db: ZosDatabase, jobId: string | null): AgentEventAudience {
  if (!jobId) return "chat";
  const role = db.prepare(`
    SELECT agent_messages.role
    FROM jobs
    JOIN agent_messages ON agent_messages.id = jobs.message_id
    WHERE jobs.id = ?
  `).pluck().get(jobId) as AgentMessageRecord["role"] | undefined;
  return role === "system" ? "notification" : "chat";
}
