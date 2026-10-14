import type {
  AgentEventRecord,
  AgentMessageRecord,
  AgentSessionRecord,
  JobRecord
} from "@zos/shared";
import type { DbEventRow, DbJobRow, DbMessageRow, DbSessionRow } from "./repository-rows.js";

export function mapSession(row: DbSessionRow): AgentSessionRecord {
  return {
    id: row.id,
    rootId: row.root_id,
    currentPath: row.current_path,
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
    error: row.error
  };
}

export function mapEvent(row: DbEventRow): AgentEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id,
    type: row.type,
    audience: row.message_role === "system" ? "notification" : "chat",
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at
  };
}
