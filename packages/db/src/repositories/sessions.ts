import { randomUUID } from "node:crypto";
import type {
  AgentMessageRecord,
  AgentProviderSessionRecord,
  AgentSessionRecord,
  ModelProviderName
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import {
  mapMessage,
  mapSession
} from "./agent-mappers.js";
import { mapProviderSession } from "./operation-mappers.js";
import type {
  DbMessageRow,
  DbProviderSessionRow,
  DbSessionRow
} from "./repository-rows.js";

function hasSessionResourceTrust(db: CyberOsDatabase): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM pragma_table_info('agent_sessions')
    WHERE name = 'pi_resources_trusted'
  `).get());
}

function sessionColumns(db: CyberOsDatabase): string {
  const trustColumn = hasSessionResourceTrust(db)
    ? "pi_resources_trusted"
    : "0 AS pi_resources_trusted";
  return `id, current_path, ${trustColumn}, created_at, updated_at`;
}

export function createSession(
  db: CyberOsDatabase,
  input: { currentPath?: string }
): AgentSessionRecord {
  const now = new Date().toISOString();
  const session: AgentSessionRecord = {
    id: randomUUID(),
    currentPath: input.currentPath ?? ".",
    piResourcesTrusted: false,
    createdAt: now,
    updatedAt: now
  };

  if (hasSessionResourceTrust(db)) {
    db.prepare(`
      INSERT INTO agent_sessions (
        id, current_path, pi_resources_trusted, created_at, updated_at
      ) VALUES (@id, @currentPath, 0, @createdAt, @updatedAt)
    `).run(session);
  } else {
    db.prepare(`
      INSERT INTO agent_sessions (
        id, current_path, created_at, updated_at
      ) VALUES (@id, @currentPath, @createdAt, @updatedAt)
    `).run(session);
  }

  return session;
}

export function getSession(db: CyberOsDatabase, sessionId: string): AgentSessionRecord | null {
  const row = db
    .prepare(`
      SELECT ${sessionColumns(db)}
      FROM agent_sessions WHERE id = ?
    `)
    .get(sessionId) as DbSessionRow | undefined;
  return row ? mapSession(row) : null;
}

export function listSessions(
  db: CyberOsDatabase,
  input: { limit?: number } = {}
): AgentSessionRecord[] {
  const limit = input.limit ?? 50;
  const rows = db
    .prepare(`
      SELECT ${sessionColumns(db)}
      FROM agent_sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .all(limit) as DbSessionRow[];

  return rows.map(mapSession);
}

export function updateSessionPath(
  db: CyberOsDatabase,
  input: { sessionId: string; currentPath: string }
): AgentSessionRecord | null {
  const now = new Date().toISOString();
  const columns = sessionColumns(db);
  const row = db
    .prepare(`
      UPDATE agent_sessions
      SET current_path = ?, updated_at = ?
      WHERE id = ?
      RETURNING ${columns}
    `)
    .get(input.currentPath, now, input.sessionId) as DbSessionRow | undefined;

  return row ? mapSession(row) : null;
}

export function updateSessionResourceTrust(
  db: CyberOsDatabase,
  input: { sessionId: string; trusted: boolean }
): AgentSessionRecord | null {
  if (!hasSessionResourceTrust(db)) return getSession(db, input.sessionId);
  const now = new Date().toISOString();
  const row = db.prepare(`
    UPDATE agent_sessions
    SET pi_resources_trusted = ?, updated_at = ?
    WHERE id = ?
    RETURNING id, current_path, pi_resources_trusted, created_at, updated_at
  `).get(input.trusted ? 1 : 0, now, input.sessionId) as DbSessionRow | undefined;
  return row ? mapSession(row) : null;
}

export function hasActiveJobsForSession(db: CyberOsDatabase, sessionId: string): boolean {
  const row = db
    .prepare(`
      SELECT 1 AS marker
      WHERE EXISTS (
        SELECT 1 FROM jobs
        WHERE session_id = ?
          AND status IN ('queued', 'running', 'waiting_approval')
      ) OR EXISTS (
        SELECT 1 FROM agent_session_commands
        WHERE session_id = ? AND status IN ('queued', 'running')
      )
      LIMIT 1
    `)
    .get(sessionId, sessionId) as { marker: number } | undefined;
  return Boolean(row);
}

export function deleteSession(db: CyberOsDatabase, sessionId: string): boolean {
  const result = db.prepare("DELETE FROM agent_sessions WHERE id = ?").run(sessionId);
  return result.changes === 1;
}

export function getAgentProviderSession(
  db: CyberOsDatabase,
  sessionId: string
): AgentProviderSessionRecord | null {
  const row = db
    .prepare(`
      SELECT session_id, provider_session_id, session_file, provider_name, model,
        settings_snapshot_json, runtime_generation, runtime_provider, runtime_model,
        projection_cursor, created_at, updated_at
      FROM agent_provider_sessions
      WHERE session_id = ?
    `)
    .get(sessionId) as DbProviderSessionRow | undefined;
  return row ? mapProviderSession(row) : null;
}

export function saveAgentProviderSession(
  db: CyberOsDatabase,
  input: {
    sessionId: string;
    providerSessionId: string;
    sessionFile?: string | null;
    providerName: ModelProviderName;
    model: string;
    settingsSnapshot: Record<string, unknown>;
    runtimeGeneration?: number;
    runtimeProvider?: ModelProviderName;
    runtimeModel?: string;
    projectionCursor?: string | null;
  }
): AgentProviderSessionRecord {
  const existing = getAgentProviderSession(db, input.sessionId);
  const now = new Date().toISOString();
  const record: AgentProviderSessionRecord = {
    sessionId: input.sessionId,
    providerSessionId: input.providerSessionId,
    sessionFile: input.sessionFile ?? null,
    providerName: input.providerName,
    model: input.model,
    settingsSnapshot: input.settingsSnapshot,
    runtimeGeneration: input.runtimeGeneration ?? 1,
    runtimeProvider: input.runtimeProvider ?? input.providerName,
    runtimeModel: input.runtimeModel ?? input.model,
    projectionCursor: input.projectionCursor ?? existing?.projectionCursor ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO agent_provider_sessions (
      session_id, provider_session_id, session_file, provider_name, model,
      settings_snapshot_json, runtime_generation, runtime_provider, runtime_model,
      projection_cursor, created_at, updated_at
    )
    VALUES (
      @sessionId, @providerSessionId, @sessionFile, @providerName, @model,
      @settingsSnapshotJson, @runtimeGeneration, @runtimeProvider, @runtimeModel,
      @projectionCursor, @createdAt, @updatedAt
    )
    ON CONFLICT(session_id) DO UPDATE SET
      provider_session_id = excluded.provider_session_id,
      session_file = excluded.session_file,
      provider_name = excluded.provider_name,
      model = excluded.model,
      settings_snapshot_json = excluded.settings_snapshot_json,
      runtime_generation = excluded.runtime_generation,
      runtime_provider = excluded.runtime_provider,
      runtime_model = excluded.runtime_model,
      projection_cursor = excluded.projection_cursor,
      updated_at = excluded.updated_at
  `).run({
    ...record,
    settingsSnapshotJson: JSON.stringify(record.settingsSnapshot)
  });

  return record;
}

export function clearAgentProviderSession(
  db: CyberOsDatabase,
  sessionId: string,
  providerSessionId: string
): boolean {
  return db.prepare(`
    DELETE FROM agent_provider_sessions
    WHERE session_id = ? AND provider_session_id = ?
  `).run(sessionId, providerSessionId).changes === 1;
}

export function listMessages(
  db: CyberOsDatabase,
  input: { sessionId: string; limit?: number }
): AgentMessageRecord[] {
  const rows = db
    .prepare(`
      SELECT id, session_id, role, content, created_at
      FROM agent_messages
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `)
    .all(input.sessionId, input.limit ?? 100) as DbMessageRow[];

  return rows.map(mapMessage);
}
