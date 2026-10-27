import { randomUUID } from "node:crypto";
import type {
  AgentSessionCommandRecord,
  AgentSessionCommandStatus,
  AgentSessionCommandType
} from "@zos/shared";
import type { ZosDatabase } from "../connection.js";

type DbCommandRow = {
  id: string;
  idempotency_key: string;
  session_id: string;
  job_id: string | null;
  type: AgentSessionCommandType;
  payload_json: string;
  status: AgentSessionCommandStatus;
  result_json: string | null;
  error: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
};

const COMMAND_COLUMNS = `
  id, idempotency_key, session_id, job_id, type, payload_json, status,
  result_json, error, lease_owner, lease_until, heartbeat_at, created_at, updated_at
`;

const ACTIVE_TURN_COMMAND_TYPES = new Set<AgentSessionCommandType>([
  "steer",
  "follow_up",
  "abort"
]);

export class AgentSessionCommandStateError extends Error {
  readonly code = "SESSION_NOT_ACTIVE";

  constructor() {
    super("Command requires an active agent turn");
    this.name = "AgentSessionCommandStateError";
  }
}

export function createAgentSessionCommand(
  db: ZosDatabase,
  input: {
    sessionId: string;
    idempotencyKey: string;
    type: AgentSessionCommandType;
    payload?: Record<string, unknown>;
    jobId?: string | null;
    status?: AgentSessionCommandStatus;
    result?: unknown;
  }
): AgentSessionCommandRecord {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 256) {
    throw new Error("Command idempotency key must be between 1 and 256 characters");
  }

  const create = () => {
    const existing = getAgentSessionCommandByKey(db, input.sessionId, idempotencyKey);
    if (existing) return existing;

    const now = new Date().toISOString();
    let jobId = input.jobId ?? null;
    if (ACTIVE_TURN_COMMAND_TYPES.has(input.type)) {
      const activeJobId = db.prepare(`
        SELECT active.id
        FROM jobs active
        JOIN agent_messages message ON message.id = active.message_id
        WHERE active.session_id = ? AND active.kind = 'agent' AND message.role = 'user'
          AND active.status = 'running' AND active.lease_until > ?
        ORDER BY active.updated_at DESC
        LIMIT 1
      `).pluck().get(input.sessionId, now);
      if (typeof activeJobId !== "string" || (jobId !== null && jobId !== activeJobId)) {
        throw new AgentSessionCommandStateError();
      }
      jobId = activeJobId;
    }

    const row: DbCommandRow = {
      id: randomUUID(),
      idempotency_key: idempotencyKey,
      session_id: input.sessionId,
      job_id: jobId,
      type: input.type,
      payload_json: JSON.stringify(input.payload ?? {}),
      status: input.status ?? "queued",
      result_json: input.result === undefined ? null : JSON.stringify(input.result),
      error: null,
      lease_owner: null,
      lease_until: null,
      heartbeat_at: null,
      created_at: now,
      updated_at: now
    };
    db.prepare(`
      INSERT INTO agent_session_commands (${COMMAND_COLUMNS})
      VALUES (
        @id, @idempotency_key, @session_id, @job_id, @type, @payload_json, @status,
        @result_json, @error, @lease_owner, @lease_until, @heartbeat_at, @created_at, @updated_at
      )
      ON CONFLICT(session_id, idempotency_key) DO NOTHING
    `).run(row);
    return getAgentSessionCommandByKey(db, input.sessionId, idempotencyKey) as AgentSessionCommandRecord;
  };

  return ACTIVE_TURN_COMMAND_TYPES.has(input.type)
    ? db.transaction(create).immediate()
    : create();
}

export function getAgentSessionCommand(
  db: ZosDatabase,
  commandId: string
): AgentSessionCommandRecord | null {
  const row = db.prepare(`SELECT ${COMMAND_COLUMNS} FROM agent_session_commands WHERE id = ?`)
    .get(commandId) as DbCommandRow | undefined;
  return row ? mapCommand(row) : null;
}

export function getAgentSessionCommandByKey(
  db: ZosDatabase,
  sessionId: string,
  idempotencyKey: string
): AgentSessionCommandRecord | null {
  const row = db.prepare(`
    SELECT ${COMMAND_COLUMNS}
    FROM agent_session_commands
    WHERE session_id = ? AND idempotency_key = ?
  `).get(sessionId, idempotencyKey) as DbCommandRow | undefined;
  return row ? mapCommand(row) : null;
}

export function listAgentSessionCommands(
  db: ZosDatabase,
  input: { sessionId: string; limit?: number }
): AgentSessionCommandRecord[] {
  const rows = db.prepare(`
    SELECT ${COMMAND_COLUMNS}
    FROM agent_session_commands
    WHERE session_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(input.sessionId, input.limit ?? 100) as DbCommandRow[];
  return rows.map(mapCommand);
}

export function claimNextAgentSessionCommand(
  db: ZosDatabase,
  input: { workerId: string; leaseMs?: number; now?: Date }
): AgentSessionCommandRecord | null {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const leaseUntil = new Date(nowDate.getTime() + (input.leaseMs ?? 30_000)).toISOString();
  const row = db.transaction(() => {
    recoverInterruptedAgentSessionCommands(db, nowDate);
    return db.prepare(`
    UPDATE agent_session_commands AS claimed
    SET status = 'running', error = NULL, lease_owner = ?, lease_until = ?,
      heartbeat_at = ?, updated_at = ?
    WHERE id = (
      SELECT command.id
      FROM agent_session_commands command
      WHERE command.status = 'queued' AND command.type <> 'prompt'
        AND NOT EXISTS (
          SELECT 1
          FROM agent_session_commands active_command
          WHERE active_command.session_id = command.session_id
            AND active_command.status = 'running'
        )
        AND (
          (
            command.type IN ('steer', 'follow_up', 'abort')
            AND EXISTS (
              SELECT 1 FROM jobs active
              JOIN agent_messages message ON message.id = active.message_id
              WHERE active.session_id = command.session_id AND active.id = command.job_id
                AND active.kind = 'agent' AND message.role = 'user'
                AND active.status = 'running' AND active.lease_owner = ?
                AND active.lease_until > ?
            )
          ) OR (
            command.type NOT IN ('steer', 'follow_up', 'abort')
            AND NOT EXISTS (
              SELECT 1 FROM jobs active
              JOIN agent_messages message ON message.id = active.message_id
              WHERE active.session_id = command.session_id
                AND active.kind = 'agent' AND message.role = 'user'
                AND active.status IN ('running', 'waiting_approval')
            )
          )
        )
      ORDER BY command.created_at, command.rowid
      LIMIT 1
    ) AND status = 'queued'
    RETURNING ${COMMAND_COLUMNS}
  `).get(
      input.workerId,
      leaseUntil,
      now,
      now,
      input.workerId,
      now
    ) as DbCommandRow | undefined;
  }).immediate();
  return row ? mapCommand(row) : null;
}

export function renewAgentSessionCommandLease(
  db: ZosDatabase,
  input: { commandId: string; workerId: string; leaseMs: number; now?: Date }
): boolean {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const leaseUntil = new Date(nowDate.getTime() + input.leaseMs).toISOString();
  return db.prepare(`
    UPDATE agent_session_commands
    SET lease_until = ?, heartbeat_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?
  `).run(leaseUntil, now, now, input.commandId, input.workerId, now).changes === 1;
}

export function finishAgentSessionCommand(
  db: ZosDatabase,
  input: {
    commandId: string;
    workerId: string;
    status: Extract<AgentSessionCommandStatus, "completed" | "failed" | "cancelled">;
    result?: unknown;
    error?: string | null;
    now?: Date;
  }
): AgentSessionCommandRecord | null {
  const now = (input.now ?? new Date()).toISOString();
  const row = db.prepare(`
    UPDATE agent_session_commands
    SET status = ?, result_json = ?, error = ?, lease_owner = NULL,
      lease_until = NULL, heartbeat_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?
    RETURNING ${COMMAND_COLUMNS}
  `).get(
    input.status,
    input.result === undefined ? null : JSON.stringify(input.result),
    input.error ?? null,
    now,
    input.commandId,
    input.workerId,
    now
  ) as DbCommandRow | undefined;
  return row ? mapCommand(row) : null;
}

export function requeueAgentSessionCommand(
  db: ZosDatabase,
  input: { commandId: string; workerId: string; now?: Date }
): AgentSessionCommandRecord | null {
  const now = (input.now ?? new Date()).toISOString();
  const row = db.prepare(`
    UPDATE agent_session_commands
    SET status = 'queued', error = NULL, lease_owner = NULL,
      lease_until = NULL, heartbeat_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?
    RETURNING ${COMMAND_COLUMNS}
  `).get(now, input.commandId, input.workerId, now) as DbCommandRow | undefined;
  return row ? mapCommand(row) : null;
}

export function failQueuedActiveTurnCommands(
  db: ZosDatabase,
  input: { sessionId: string; jobId: string; error: string; now?: Date }
): AgentSessionCommandRecord[] {
  const rows = db.prepare(`
    UPDATE agent_session_commands
    SET status = 'failed', error = ?, updated_at = ?
    WHERE session_id = ? AND job_id = ? AND status = 'queued'
      AND type IN ('steer', 'follow_up', 'abort')
    RETURNING ${COMMAND_COLUMNS}
  `).all(
    input.error,
    (input.now ?? new Date()).toISOString(),
    input.sessionId,
    input.jobId
  ) as DbCommandRow[];
  return rows.map(mapCommand);
}

export function recoverInterruptedAgentSessionCommands(db: ZosDatabase, nowDate = new Date()): number {
  const now = nowDate.toISOString();
  return db.prepare(`
    UPDATE agent_session_commands
    SET status = 'failed', error = 'Agent worker stopped while executing this command',
      lease_owner = NULL, lease_until = NULL, heartbeat_at = NULL, updated_at = ?
    WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ?)
  `).run(now, now).changes;
}

function mapCommand(row: DbCommandRow): AgentSessionCommandRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    sessionId: row.session_id,
    jobId: row.job_id,
    type: row.type,
    payload: parseRecord(row.payload_json),
    status: row.status,
    result: row.result_json === null ? null : JSON.parse(row.result_json) as unknown,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}
