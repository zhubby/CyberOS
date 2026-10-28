import type {
  AgentEventRecord,
  AgentMessageRecord,
  AgentSessionRecord,
  JobRecord
} from "@cyberos/shared";
import type { DbEventRow, DbJobRow, DbMessageRow, DbSessionRow } from "./repository-rows.js";

export function mapSession(row: DbSessionRow): AgentSessionRecord {
  return {
    id: row.id,
    rootId: row.root_id,
    currentPath: row.current_path,
    piResourcesTrusted: row.pi_resources_trusted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapMessage(row: DbMessageRow): AgentMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at
  };
}

export function mapJob(row: DbJobRow): JobRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
    errorCode: row.error_code,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    heartbeatAt: row.heartbeat_at,
    workingPath: row.working_path
  };
}

export function mapEvent(row: DbEventRow): AgentEventRecord {
  return {
    schemaVersion: 1,
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id,
    type: row.type,
    audience: row.message_role === "system" ? "notification" : "chat",
    transcriptSequence: row.transcript_sequence ?? null,
    source: row.source,
    sourceId: row.source_id,
    runId: row.run_id ?? (row.job_id ? `job:${row.job_id}` : `session:${row.session_id}`),
    sequence: row.sequence ?? row.id,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at
  };
}
