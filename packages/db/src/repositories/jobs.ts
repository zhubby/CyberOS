import { randomUUID } from "node:crypto";
import type {
  AgentEventAudience,
  AgentEventRecord,
  AgentEventType,
  AgentMessageRecord,
  AgentSessionCommandRecord,
  JobRecord,
  JobStatus,
  OperationNotificationKind,
  OperationNotificationStatus
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import { mapEvent, mapJob, mapMessage } from "./agent-mappers.js";
import type { DbEventRow, DbJobRow, DbMessageRow } from "./repository-rows.js";
import {
  createOperationNotification,
  updateOperationNotificationForJob
} from "./operation-notifications.js";
import { cancelAgentCapabilityRunsForJob } from "./capability-runs.js";
import {
  createAgentSessionCommand,
  failQueuedActiveTurnCommands,
  getAgentSessionCommandByKey
} from "./agent-session-commands.js";

const JOB_COLUMNS = `
  id, session_id, message_id, kind, status, created_at, updated_at, error,
  error_code, attempt, lease_owner, lease_until, heartbeat_at, working_path
`;

export interface ClaimAgentJobInput {
  workerId: string;
  leaseMs: number;
  now?: Date;
}

export function createUserMessageAndJob(
  db: CyberOsDatabase,
  input: {
    sessionId: string;
    content: string;
    status?: JobStatus;
    workingPath?: string;
    commandIdempotencyKey?: string;
  }
): {
  message: AgentMessageRecord;
  job: JobRecord;
  transcriptSequence: number;
  command: AgentSessionCommandRecord | null;
} {
  const now = new Date().toISOString();
  const storedPath = db.prepare("SELECT current_path FROM agent_sessions WHERE id = ?")
    .pluck().get(input.sessionId);
  const workingPath = input.workingPath ?? (typeof storedPath === "string" ? storedPath : ".");
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
    error: null,
    errorCode: null,
    attempt: 0,
    leaseOwner: null,
    leaseUntil: null,
    heartbeatAt: null,
    workingPath
  };

  const tx = db.transaction(() => {
    if (input.commandIdempotencyKey) {
      const existingCommand = getAgentSessionCommandByKey(
        db,
        input.sessionId,
        input.commandIdempotencyKey.trim()
      );
      if (existingCommand?.jobId) {
        const existingJob = getJob(db, existingCommand.jobId);
        const existingMessage = existingJob ? getMessage(db, existingJob.messageId) : null;
        const existingSequence = existingMessage
          ? db.prepare("SELECT sequence FROM agent_transcript_items WHERE message_id = ?").pluck().get(existingMessage.id)
          : null;
        if (existingJob && existingMessage && typeof existingSequence === "number") {
          return {
            message: existingMessage,
            job: existingJob,
            transcriptSequence: existingSequence,
            command: existingCommand
          };
        }
      }
    }
    db.prepare(`
      INSERT INTO agent_messages (id, session_id, role, content, created_at)
      VALUES (@id, @sessionId, @role, @content, @createdAt)
    `).run(message);
    db.prepare(`
      INSERT INTO jobs (id, session_id, message_id, kind, status, error, created_at, updated_at)
      VALUES (@id, @sessionId, @messageId, @kind, @status, @error, @createdAt, @updatedAt)
    `).run(job);
    if (job.workingPath !== ".") {
      db.prepare("UPDATE jobs SET working_path = ? WHERE id = ?").run(job.workingPath, job.id);
    }
    const transcriptResult = db.prepare(`
      INSERT INTO agent_transcript_items (session_id, message_id)
      VALUES (?, ?)
    `).run(input.sessionId, message.id);
    db.prepare("UPDATE agent_sessions SET current_path = ?, updated_at = ? WHERE id = ?")
      .run(job.workingPath, now, input.sessionId);
    const command = input.commandIdempotencyKey
      ? createAgentSessionCommand(db, {
          sessionId: input.sessionId,
          idempotencyKey: input.commandIdempotencyKey,
          type: "prompt",
          payload: { content: input.content, workingPath: job.workingPath },
          jobId: job.id,
          status: "completed",
          result: { jobId: job.id, status: job.status }
        })
      : null;
    return {
      message,
      job,
      transcriptSequence: Number(transcriptResult.lastInsertRowid),
      command
    };
  });

  return tx.immediate();
}

export function createActionMessageAndJob(
  db: CyberOsDatabase,
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
    error: null,
    errorCode: null,
    attempt: 0,
    leaseOwner: null,
    leaseUntil: null,
    heartbeatAt: null,
    workingPath: "."
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

export function getMessage(db: CyberOsDatabase, messageId: string): AgentMessageRecord | null {
  const row = db
    .prepare("SELECT id, session_id, role, content, created_at FROM agent_messages WHERE id = ?")
    .get(messageId) as DbMessageRow | undefined;
  return row ? mapMessage(row) : null;
}

export function getJob(db: CyberOsDatabase, jobId: string): JobRecord | null {
  const row = db
    .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`)
    .get(jobId) as DbJobRow | undefined;
  return row ? mapJob(row) : null;
}

export function getActiveAgentJobForSession(db: CyberOsDatabase, sessionId: string): JobRecord | null {
  const row = db.prepare(`
    SELECT ${JOB_COLUMNS}
    FROM jobs
    WHERE jobs.session_id = ? AND jobs.kind = 'agent'
      AND jobs.status = 'running'
      AND EXISTS (
        SELECT 1 FROM agent_messages
        WHERE agent_messages.id = jobs.message_id AND agent_messages.role = 'user'
      )
    ORDER BY jobs.updated_at DESC
    LIMIT 1
  `).get(sessionId) as DbJobRow | undefined;
  return row ? mapJob(row) : null;
}

export function getCurrentAgentJobForSession(db: CyberOsDatabase, sessionId: string): JobRecord | null {
  const row = db.prepare(`
    SELECT ${JOB_COLUMNS}
    FROM jobs
    WHERE jobs.session_id = ? AND jobs.kind = 'agent'
      AND jobs.status IN ('queued', 'running', 'waiting_approval')
      AND EXISTS (
        SELECT 1 FROM agent_messages
        WHERE agent_messages.id = jobs.message_id AND agent_messages.role = 'user'
      )
    ORDER BY
      CASE jobs.status WHEN 'running' THEN 0 WHEN 'waiting_approval' THEN 1 ELSE 2 END,
      jobs.created_at ASC,
      jobs.rowid ASC
    LIMIT 1
  `).get(sessionId) as DbJobRow | undefined;
  return row ? mapJob(row) : null;
}

export function claimNextJob(
  db: CyberOsDatabase,
  input: ClaimAgentJobInput
): JobRecord | null {
  const nowDate = input.now ?? new Date();
  recoverExpiredAgentJobs(db, nowDate);
  const now = nowDate.toISOString();
  const leaseUntil = new Date(nowDate.getTime() + input.leaseMs).toISOString();
  const tx = db.transaction(() => {
    const row = db.prepare(`
      UPDATE jobs
      SET status = 'running', error = NULL, error_code = NULL,
        attempt = attempt + 1, lease_owner = ?, lease_until = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = (
        SELECT queued.id
        FROM jobs queued
        JOIN agent_messages queued_message ON queued_message.id = queued.message_id
        WHERE queued.kind = 'agent' AND queued.status = 'queued' AND queued_message.role = 'user'
          AND NOT EXISTS (
            SELECT 1
            FROM jobs active
            JOIN agent_messages active_message ON active_message.id = active.message_id
            WHERE active.session_id = queued.session_id
              AND active.kind = 'agent'
              AND active_message.role = 'user'
              AND active.status IN ('running', 'waiting_approval')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM agent_session_commands active_command
            WHERE active_command.session_id = queued.session_id
              AND active_command.status = 'running'
              AND active_command.lease_until > ?
          )
        ORDER BY queued.created_at ASC, queued.rowid ASC
        LIMIT 1
      )
      AND status = 'queued'
      RETURNING ${JOB_COLUMNS}
    `).get(input.workerId, leaseUntil, now, now, now) as DbJobRow | undefined;
    if (row) {
      updateOperationNotificationForJob(db, {
        jobId: row.id,
        status: "running",
        now: new Date(now)
      });
    }
    return row;
  });
  const row = tx.immediate();

  return row ? mapJob(row) : null;
}

export function renewAgentJobLease(
  db: CyberOsDatabase,
  input: { jobId: string; workerId: string; leaseMs: number; now?: Date }
): boolean {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const leaseUntil = new Date(nowDate.getTime() + input.leaseMs).toISOString();
  return db.prepare(`
    UPDATE jobs
    SET lease_until = ?, heartbeat_at = ?, updated_at = ?
    WHERE id = ? AND kind = 'agent' AND status = 'running'
      AND lease_owner = ? AND lease_until > ?
  `).run(leaseUntil, now, now, input.jobId, input.workerId, now).changes === 1;
}

export function ownsAgentJobLease(
  db: CyberOsDatabase,
  input: { jobId: string; workerId: string; now?: Date }
): boolean {
  const marker = db.prepare(`
    SELECT 1
    FROM jobs
    WHERE id = ? AND kind = 'agent' AND status = 'running'
      AND lease_owner = ? AND lease_until > ?
  `).pluck().get(input.jobId, input.workerId, (input.now ?? new Date()).toISOString());
  return Boolean(marker);
}

export function recoverExpiredAgentJobs(db: CyberOsDatabase, nowDate = new Date()): number {
  const now = nowDate.toISOString();
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT ${JOB_COLUMNS.replaceAll(/\b(id|session_id|message_id|kind|status|created_at|updated_at|error|error_code|attempt|lease_owner|lease_until|heartbeat_at|working_path)\b/gu, "jobs.$1")}
      FROM jobs
      JOIN agent_messages ON agent_messages.id = jobs.message_id
      WHERE jobs.kind = 'agent' AND jobs.status = 'running' AND agent_messages.role = 'user'
        AND (jobs.lease_until IS NULL OR jobs.lease_until <= ?)
      ORDER BY jobs.created_at, jobs.id
    `).all(now) as DbJobRow[];
    const fail = db.prepare(`
      UPDATE jobs
      SET status = 'failed', error = ?, error_code = 'WORKER_INTERRUPTED',
        lease_owner = NULL, lease_until = NULL, heartbeat_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'
        AND (lease_until IS NULL OR lease_until <= ?)
    `);
    let recovered = 0;
    for (const row of rows) {
      const error = "Agent worker stopped before the turn completed; retry explicitly to continue";
      if (fail.run(error, now, row.id, now).changes !== 1) continue;
      failPendingActiveTurnCommands(db, {
        sessionId: row.session_id,
        jobId: row.id,
        error: "Active agent turn was interrupted before the command could run",
        now: nowDate
      });
      appendEvent(db, {
        sessionId: row.session_id,
        jobId: row.id,
        type: "job.failed",
        payload: {
          jobId: row.id,
          error,
          errorCode: "WORKER_INTERRUPTED",
          retryable: true,
          attempt: row.attempt
        }
      });
      recovered += 1;
    }
    return recovered;
  });
  return tx.immediate();
}

export function updateJobStatus(
  db: CyberOsDatabase,
  jobId: string,
  status: JobStatus,
  error: string | null = null,
  allowedFrom?: JobStatus[]
): boolean {
  const updatedAt = new Date().toISOString();
  const statusGuard = allowedFrom?.length
    ? ` AND status IN (${allowedFrom.map(() => "?").join(", ")})`
    : "";

  const tx = db.transaction(() => {
    const jobSessionId = db.prepare("SELECT session_id FROM jobs WHERE id = ?")
      .pluck().get(jobId);
    const result = db
      .prepare(`
        UPDATE jobs
        SET status = ?, error = ?, updated_at = ?,
          lease_owner = CASE WHEN ? = 'running' THEN lease_owner ELSE NULL END,
          lease_until = CASE WHEN ? = 'running' THEN lease_until ELSE NULL END,
          heartbeat_at = CASE WHEN ? = 'running' THEN heartbeat_at ELSE NULL END
        WHERE id = ?${statusGuard}
      `)
      .run(status, error, updatedAt, status, status, status, jobId, ...(allowedFrom ?? []));
    if (result.changes === 1) {
      if (status === "cancelled") {
        cancelAgentCapabilityRunsForJob(db, jobId, updatedAt);
      }
      if (
        typeof jobSessionId === "string"
        && (status === "completed" || status === "failed" || status === "cancelled")
      ) {
        failPendingActiveTurnCommands(db, {
          sessionId: jobSessionId,
          jobId,
          error: "Active agent turn ended before the command could run",
          now: new Date(updatedAt)
        });
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
  return tx.immediate();
}

function failPendingActiveTurnCommands(
  db: CyberOsDatabase,
  input: { sessionId: string; jobId: string; error: string; now: Date }
): void {
  const commands = failQueuedActiveTurnCommands(db, input);
  for (const command of commands) {
    appendEvent(db, {
      sessionId: input.sessionId,
      jobId: input.jobId,
      type: "command.failed",
      runId: `command:${command.id}`,
      sourceId: `command:${command.id}:failed`,
      payload: {
        commandId: command.id,
        type: command.type,
        error: input.error
      }
    });
  }
}

export function appendEvent<TPayload>(
  db: CyberOsDatabase,
  input: {
    sessionId: string;
    jobId?: string | null;
    type: AgentEventType;
    payload: TPayload;
    source?: string;
    sourceId?: string | null;
    runId?: string | null;
    sequence?: number;
  }
): AgentEventRecord<TPayload> {
  const createdAt = new Date().toISOString();
  const jobId = input.jobId ?? null;
  const audience = eventAudience(db, jobId);
  const source = input.source ?? "cyberos";
  const sourceId = input.sourceId ?? null;
  const runId = input.runId ?? (jobId ? `job:${jobId}` : `session:${input.sessionId}`);
  const tx = db.transaction(() => {
    if (sourceId) {
      const existing = db.prepare(`
        SELECT
          agent_events.id, agent_events.session_id, agent_events.job_id, agent_events.type,
          agent_events.payload_json, agent_events.created_at, agent_events.source,
          agent_events.source_id, agent_events.run_id, agent_events.sequence,
          agent_messages.role AS message_role,
          agent_transcript_items.sequence AS transcript_sequence,
          job_transcript.sequence AS transcript_turn_sequence
        FROM agent_events
        LEFT JOIN jobs ON jobs.id = agent_events.job_id
        LEFT JOIN agent_messages ON agent_messages.id = jobs.message_id
        LEFT JOIN agent_transcript_items ON agent_transcript_items.event_id = agent_events.id
        LEFT JOIN agent_transcript_items AS job_transcript ON job_transcript.message_id = jobs.message_id
        WHERE agent_events.session_id = ? AND agent_events.source = ? AND agent_events.source_id = ?
      `).get(input.sessionId, source, sourceId) as DbEventRow | undefined;
      if (existing) return mapEvent(existing) as AgentEventRecord<TPayload>;
    }
    const sequence = input.sequence ?? Number(db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1
      FROM agent_events
      WHERE session_id = ? AND run_id = ?
    `).pluck().get(input.sessionId, runId));
    const result = db
      .prepare(`
        INSERT INTO agent_events (
          session_id, job_id, type, payload_json, source, source_id, run_id, sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.sessionId,
        jobId,
        input.type,
        JSON.stringify(input.payload),
        source,
        sourceId,
        runId,
        sequence,
        createdAt
      );
    const eventId = Number(result.lastInsertRowid);
    let transcriptSequence: number | null = null;
    if (audience === "chat" && (input.type === "agent.message" || input.type === "job.failed")) {
      const transcriptResult = db.prepare(`
        INSERT INTO agent_transcript_items (session_id, event_id)
        VALUES (?, ?)
      `).run(input.sessionId, eventId);
      transcriptSequence = Number(transcriptResult.lastInsertRowid);
    }
    const transcriptTurnSequence = jobId
      ? db.prepare(`
          SELECT transcript.sequence
          FROM jobs
          JOIN agent_transcript_items AS transcript ON transcript.message_id = jobs.message_id
          WHERE jobs.id = ?
        `).pluck().get(jobId)
      : null;
    return {
      schemaVersion: 1,
      id: eventId,
      sessionId: input.sessionId,
      jobId,
      type: input.type,
      audience,
      transcriptSequence,
      transcriptTurnSequence: typeof transcriptTurnSequence === "number"
        ? transcriptTurnSequence
        : transcriptSequence,
      source,
      sourceId,
      runId,
      sequence,
      payload: input.payload,
      createdAt
    } satisfies AgentEventRecord<TPayload>;
  });
  return tx.immediate();
}

export function listEvents(
  db: CyberOsDatabase,
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
        agent_events.source,
        agent_events.source_id,
        agent_events.run_id,
        agent_events.sequence,
        agent_messages.role AS message_role,
        agent_transcript_items.sequence AS transcript_sequence,
        job_transcript.sequence AS transcript_turn_sequence
      FROM agent_events
      LEFT JOIN jobs ON jobs.id = agent_events.job_id
      LEFT JOIN agent_messages ON agent_messages.id = jobs.message_id
      LEFT JOIN agent_transcript_items ON agent_transcript_items.event_id = agent_events.id
      LEFT JOIN agent_transcript_items AS job_transcript ON job_transcript.message_id = jobs.message_id
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

function eventAudience(db: CyberOsDatabase, jobId: string | null): AgentEventAudience {
  if (!jobId) return "chat";
  const role = db.prepare(`
    SELECT agent_messages.role
    FROM jobs
    JOIN agent_messages ON agent_messages.id = jobs.message_id
    WHERE jobs.id = ?
  `).pluck().get(jobId) as AgentMessageRecord["role"] | undefined;
  return role === "system" ? "notification" : "chat";
}
