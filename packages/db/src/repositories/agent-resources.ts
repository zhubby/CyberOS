import { randomUUID } from "node:crypto";
import type {
  AgentMcpAuthMode,
  AgentMcpExposure,
  AgentMcpServerRecord,
  AgentMcpTestStatus,
  AgentSkillRecord,
  AgentSkillSourceType
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";

interface AgentMcpServerRow {
  id: string;
  name: string;
  description: string;
  url: string;
  timeout_seconds: number;
  exposure: AgentMcpExposure;
  auth_mode: AgentMcpAuthMode;
  credential_header_names_json: string;
  enabled: number;
  allow_insecure_http: number;
  test_status: AgentMcpTestStatus;
  tool_count: number;
  last_tested_at: string | null;
  last_error: string | null;
  trusted_at: string | null;
  generation: number;
  created_at: string;
  updated_at: string;
}

interface AgentSkillRow {
  id: string;
  name: string;
  description: string;
  version: string | null;
  source_type: AgentSkillSourceType;
  source_url: string | null;
  source_ref: string | null;
  source_subdirectory: string | null;
  source_storage_pool_id: string | null;
  source_path: string | null;
  resolved_commit: string | null;
  digest: string;
  enabled: number;
  diagnostics_json: string;
  generation: number;
  created_at: string;
  updated_at: string;
}

export interface AgentMcpServerInput {
  name: string;
  description: string;
  url: string;
  timeoutSeconds: number;
  exposure: AgentMcpExposure;
  authMode: AgentMcpAuthMode;
  credentialHeaderNames?: string[];
  enabled?: boolean;
  allowInsecureHttp: boolean;
  testStatus?: AgentMcpTestStatus;
  toolCount?: number;
  lastTestedAt?: string | null;
  lastError?: string | null;
  trustedAt?: string | null;
}

export interface AgentSkillInput {
  name: string;
  description: string;
  version: string | null;
  sourceType: AgentSkillSourceType;
  sourceUrl: string | null;
  sourceRef: string | null;
  sourceSubdirectory: string | null;
  sourceStoragePoolId: string | null;
  sourcePath: string | null;
  resolvedCommit: string | null;
  digest: string;
  enabled: boolean;
  diagnostics: string[];
}

export function getAgentResourceGeneration(db: CyberOsDatabase): number {
  return Number(db.prepare("SELECT generation FROM agent_resource_generation WHERE id = 1").pluck().get() ?? 1);
}

export function listAgentMcpServers(db: CyberOsDatabase): AgentMcpServerRecord[] {
  const rows = db.prepare("SELECT * FROM agent_mcp_servers ORDER BY name COLLATE NOCASE").all() as AgentMcpServerRow[];
  return rows.map(mapMcpServer);
}

export function getAgentMcpServer(db: CyberOsDatabase, id: string): AgentMcpServerRecord | null {
  const row = db.prepare("SELECT * FROM agent_mcp_servers WHERE id = ?").get(id) as AgentMcpServerRow | undefined;
  return row ? mapMcpServer(row) : null;
}

export function createAgentMcpServer(
  db: CyberOsDatabase,
  input: AgentMcpServerInput,
  id: string = randomUUID()
): AgentMcpServerRecord {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const generation = bumpAgentResourceGeneration(db, now);
    db.prepare(`
      INSERT INTO agent_mcp_servers (
        id, name, description, url, timeout_seconds, exposure, auth_mode,
        credential_header_names_json, enabled, allow_insecure_http, test_status,
        tool_count, last_tested_at, last_error, trusted_at, generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.description,
      input.url,
      input.timeoutSeconds,
      input.exposure,
      input.authMode,
      JSON.stringify(input.credentialHeaderNames ?? []),
      input.enabled ? 1 : 0,
      input.allowInsecureHttp ? 1 : 0,
      input.testStatus ?? "untested",
      input.toolCount ?? 0,
      input.lastTestedAt ?? null,
      input.lastError ?? null,
      input.trustedAt ?? null,
      generation,
      now,
      now
    );
    return getRequiredMcpServer(db, id);
  }).immediate();
}

export function updateAgentMcpServer(
  db: CyberOsDatabase,
  id: string,
  input: AgentMcpServerInput
): AgentMcpServerRecord | null {
  return db.transaction(() => {
    if (!getAgentMcpServer(db, id)) return null;
    const now = new Date().toISOString();
    const generation = bumpAgentResourceGeneration(db, now);
    db.prepare(`
      UPDATE agent_mcp_servers SET
        name = ?, description = ?, url = ?, timeout_seconds = ?, exposure = ?, auth_mode = ?,
        credential_header_names_json = ?, enabled = ?, allow_insecure_http = ?, test_status = ?,
        tool_count = ?, last_tested_at = ?, last_error = ?, trusted_at = ?, generation = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name,
      input.description,
      input.url,
      input.timeoutSeconds,
      input.exposure,
      input.authMode,
      JSON.stringify(input.credentialHeaderNames ?? []),
      input.enabled ? 1 : 0,
      input.allowInsecureHttp ? 1 : 0,
      input.testStatus ?? "untested",
      input.toolCount ?? 0,
      input.lastTestedAt ?? null,
      input.lastError ?? null,
      input.trustedAt ?? null,
      generation,
      now,
      id
    );
    return getRequiredMcpServer(db, id);
  }).immediate();
}

export function deleteAgentMcpServer(db: CyberOsDatabase, id: string): boolean {
  return db.transaction(() => {
    const result = db.prepare("DELETE FROM agent_mcp_servers WHERE id = ?").run(id);
    if (result.changes > 0) bumpAgentResourceGeneration(db, new Date().toISOString());
    return result.changes > 0;
  }).immediate();
}

export function listAgentSkills(db: CyberOsDatabase): AgentSkillRecord[] {
  const rows = db.prepare("SELECT * FROM agent_skills ORDER BY name COLLATE NOCASE").all() as AgentSkillRow[];
  return rows.map(mapSkill);
}

export function getAgentSkill(db: CyberOsDatabase, id: string): AgentSkillRecord | null {
  const row = db.prepare("SELECT * FROM agent_skills WHERE id = ?").get(id) as AgentSkillRow | undefined;
  return row ? mapSkill(row) : null;
}

export function createAgentSkill(
  db: CyberOsDatabase,
  input: AgentSkillInput,
  id: string = randomUUID()
): AgentSkillRecord {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const generation = bumpAgentResourceGeneration(db, now);
    insertSkill(db, id, input, generation, now, now);
    return getRequiredSkill(db, id);
  }).immediate();
}

export function updateAgentSkill(db: CyberOsDatabase, id: string, input: AgentSkillInput): AgentSkillRecord | null {
  return db.transaction(() => {
    const existing = getAgentSkill(db, id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const generation = bumpAgentResourceGeneration(db, now);
    db.prepare(`
      UPDATE agent_skills SET
        name = ?, description = ?, version = ?, source_type = ?, source_url = ?, source_ref = ?,
        source_subdirectory = ?, source_storage_pool_id = ?, source_path = ?, resolved_commit = ?,
        digest = ?, enabled = ?, diagnostics_json = ?, generation = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name,
      input.description,
      input.version,
      input.sourceType,
      input.sourceUrl,
      input.sourceRef,
      input.sourceSubdirectory,
      input.sourceStoragePoolId,
      input.sourcePath,
      input.resolvedCommit,
      input.digest,
      input.enabled ? 1 : 0,
      JSON.stringify(input.diagnostics),
      generation,
      now,
      id
    );
    return getRequiredSkill(db, id);
  }).immediate();
}

export function deleteAgentSkill(db: CyberOsDatabase, id: string): boolean {
  return db.transaction(() => {
    const result = db.prepare("DELETE FROM agent_skills WHERE id = ?").run(id);
    if (result.changes > 0) bumpAgentResourceGeneration(db, new Date().toISOString());
    return result.changes > 0;
  }).immediate();
}

function insertSkill(
  db: CyberOsDatabase,
  id: string,
  input: AgentSkillInput,
  generation: number,
  createdAt: string,
  updatedAt: string
): void {
  db.prepare(`
    INSERT INTO agent_skills (
      id, name, description, version, source_type, source_url, source_ref, source_subdirectory,
      source_storage_pool_id, source_path, resolved_commit, digest, enabled, diagnostics_json,
      generation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.description,
    input.version,
    input.sourceType,
    input.sourceUrl,
    input.sourceRef,
    input.sourceSubdirectory,
    input.sourceStoragePoolId,
    input.sourcePath,
    input.resolvedCommit,
    input.digest,
    input.enabled ? 1 : 0,
    JSON.stringify(input.diagnostics),
    generation,
    createdAt,
    updatedAt
  );
}

function bumpAgentResourceGeneration(db: CyberOsDatabase, updatedAt: string): number {
  const row = db.prepare(`
    UPDATE agent_resource_generation
    SET generation = generation + 1, updated_at = ?
    WHERE id = 1
    RETURNING generation
  `).get(updatedAt) as { generation: number };
  return row.generation;
}

function getRequiredMcpServer(db: CyberOsDatabase, id: string): AgentMcpServerRecord {
  const server = getAgentMcpServer(db, id);
  if (!server) throw new Error("Agent MCP server was not persisted");
  return server;
}

function getRequiredSkill(db: CyberOsDatabase, id: string): AgentSkillRecord {
  const skill = getAgentSkill(db, id);
  if (!skill) throw new Error("Agent Skill was not persisted");
  return skill;
}

function mapMcpServer(row: AgentMcpServerRow): AgentMcpServerRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: row.url,
    timeoutSeconds: row.timeout_seconds,
    exposure: row.exposure,
    authMode: row.auth_mode,
    credentialHeaderNames: parseStringArray(row.credential_header_names_json),
    enabled: row.enabled === 1,
    allowInsecureHttp: row.allow_insecure_http === 1,
    testStatus: row.test_status,
    toolCount: row.tool_count,
    lastTestedAt: row.last_tested_at,
    lastError: row.last_error,
    trustedAt: row.trusted_at,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSkill(row: AgentSkillRow): AgentSkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    sourceRef: row.source_ref,
    sourceSubdirectory: row.source_subdirectory,
    sourceStoragePoolId: row.source_storage_pool_id,
    sourcePath: row.source_path,
    resolvedCommit: row.resolved_commit,
    digest: row.digest,
    enabled: row.enabled === 1,
    diagnostics: parseStringArray(row.diagnostics_json),
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Agent resource string list is invalid");
  }
  return parsed;
}
