import type { AgentEventRecord, AgentMessageRecord } from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import { mapEvent, mapMessage } from "./agent-mappers.js";
import type { DbEventRow, DbMessageRow } from "./repository-rows.js";

export interface AgentTranscriptItemRecord {
  sequence: number;
  message: AgentMessageRecord | null;
  event: AgentEventRecord | null;
}

type DbTranscriptRow = {
  sequence: number;
  message_id: string | null;
  message_session_id: string | null;
  message_role: AgentMessageRecord["role"] | null;
  message_content: string | null;
  message_created_at: string | null;
  event_id: number | null;
  event_session_id: string | null;
  event_job_id: string | null;
  event_type: AgentEventRecord["type"] | null;
  event_payload_json: string | null;
  event_created_at: string | null;
  event_source: string | null;
  event_source_id: string | null;
  event_run_id: string | null;
  event_sequence: number | null;
  event_message_role: AgentMessageRecord["role"] | null;
};

export function listTranscriptItems(
  db: CyberOsDatabase,
  input: { sessionId: string; limit?: number }
): AgentTranscriptItemRecord[] {
  const rows = db.prepare(`
    SELECT
      transcript.sequence,
      message.id AS message_id,
      message.session_id AS message_session_id,
      message.role AS message_role,
      message.content AS message_content,
      message.created_at AS message_created_at,
      event.id AS event_id,
      event.session_id AS event_session_id,
      event.job_id AS event_job_id,
      event.type AS event_type,
      event.payload_json AS event_payload_json,
      event.created_at AS event_created_at,
      event.source AS event_source,
      event.source_id AS event_source_id,
      event.run_id AS event_run_id,
      event.sequence AS event_sequence,
      event_message.role AS event_message_role
    FROM agent_transcript_items AS transcript
    LEFT JOIN agent_messages AS message ON message.id = transcript.message_id
    LEFT JOIN agent_events AS event ON event.id = transcript.event_id
    LEFT JOIN jobs AS event_job ON event_job.id = event.job_id
    LEFT JOIN agent_messages AS event_message ON event_message.id = event_job.message_id
    WHERE transcript.session_id = ?
    ORDER BY transcript.sequence ASC
    LIMIT ?
  `).all(input.sessionId, input.limit ?? 100) as DbTranscriptRow[];

  return rows.map((row) => ({
    sequence: row.sequence,
    message: row.message_id === null ? null : mapMessage({
      id: row.message_id,
      session_id: row.message_session_id as string,
      role: row.message_role as AgentMessageRecord["role"],
      content: row.message_content as string,
      created_at: row.message_created_at as string
    } satisfies DbMessageRow),
    event: row.event_id === null ? null : mapEvent({
      id: row.event_id,
      session_id: row.event_session_id as string,
      job_id: row.event_job_id,
      type: row.event_type as AgentEventRecord["type"],
      payload_json: row.event_payload_json as string,
      created_at: row.event_created_at as string,
      source: row.event_source as string,
      source_id: row.event_source_id,
      run_id: row.event_run_id as string,
      sequence: row.event_sequence as number,
      message_role: row.event_message_role,
      transcript_sequence: row.sequence
    } satisfies DbEventRow)
  }));
}
