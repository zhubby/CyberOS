import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ZosDatabase } from "../connection.js";

export type McpClientKind = "pi" | "local" | "lan";

export interface McpClientRecord {
  id: string;
  name: string;
  kind: McpClientKind;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedMcpClient extends McpClientRecord {
  token: string;
}

interface McpClientRow {
  id: string;
  name: string;
  kind: McpClientKind;
  token_digest: string;
  token_prefix: string;
  scopes_json: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

const TOKEN_PREFIX = "zos_mcp_";
const DISPLAY_PREFIX_LENGTH = 16;

export function createMcpClient(
  db: ZosDatabase,
  input: { name: string; kind: McpClientKind; scopes: readonly string[]; expiresAt?: string | null }
): CreatedMcpClient {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new Error("Client name must contain 1-120 characters");
  const scopes = normalizeScopes(input.scopes);
  if (scopes.length === 0) throw new Error("At least one scope is required");
  const token = generateToken();
  const now = new Date().toISOString();
  const id = randomUUID();
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt && expiresAt <= now) throw new Error("Client expiry must be in the future");
  db.prepare(`
    INSERT INTO mcp_clients (
      id, name, kind, token_digest, token_prefix, scopes_json, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, input.kind, digestToken(token), token.slice(0, DISPLAY_PREFIX_LENGTH), JSON.stringify(scopes), expiresAt, now, now);
  return {
    id,
    name,
    kind: input.kind,
    token,
    tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    scopes,
    expiresAt,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

export function listMcpClients(db: ZosDatabase): McpClientRecord[] {
  const rows = db.prepare("SELECT * FROM mcp_clients ORDER BY created_at DESC, id DESC").all() as McpClientRow[];
  return rows.map(mapClient);
}

export function getMcpClient(db: ZosDatabase, clientId: string): McpClientRecord | null {
  const row = db.prepare("SELECT * FROM mcp_clients WHERE id = ?").get(clientId) as McpClientRow | undefined;
  return row ? mapClient(row) : null;
}

export function authenticateMcpClient(db: ZosDatabase, token: string, now = new Date().toISOString()): McpClientRecord | null {
  const client = findMcpClientByToken(db, token, now);
  if (!client) return null;
  db.prepare("UPDATE mcp_clients SET last_used_at = ?, updated_at = ? WHERE id = ?").run(now, now, client.id);
  return { ...client, lastUsedAt: now, updatedAt: now };
}

export function findMcpClientByToken(db: ZosDatabase, token: string, now = new Date().toISOString()): McpClientRecord | null {
  if (!token.startsWith(TOKEN_PREFIX) || token.length < 50) return null;
  const candidateDigest = digestToken(token);
  const rows = db.prepare(`
    SELECT * FROM mcp_clients
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
  `).all(now) as McpClientRow[];
  const row = rows.find((candidate) => safeDigestEqual(candidate.token_digest, candidateDigest));
  return row ? mapClient(row) : null;
}

export function rotateMcpClientToken(
  db: ZosDatabase,
  clientId: string,
  replacementToken?: string
): { client: McpClientRecord; token: string } {
  const token = replacementToken ?? generateToken();
  if (!isValidToken(token)) throw new Error("Replacement MCP token is invalid");
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE mcp_clients
    SET token_digest = ?, token_prefix = ?, updated_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(digestToken(token), token.slice(0, DISPLAY_PREFIX_LENGTH), now, clientId);
  if (result.changes !== 1) throw new Error("Active MCP client not found");
  const row = db.prepare("SELECT * FROM mcp_clients WHERE id = ?").get(clientId) as McpClientRow;
  return { client: mapClient(row), token };
}

export function revokeMcpClient(db: ZosDatabase, clientId: string): boolean {
  const now = new Date().toISOString();
  const revoke = db.transaction(() => {
    const result = db.prepare(`
      UPDATE mcp_clients SET revoked_at = ?, updated_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).run(now, now, clientId);
    if (result.changes !== 1) return false;
    const expiringRuns = db.prepare(`
      SELECT id FROM capability_runs
      WHERE client_id = ? AND state IN ('queued', 'waiting_approval')
    `).all(clientId) as Array<{ id: string }>;
    db.prepare(`
      UPDATE capability_runs
      SET state = 'expired', error_code = 'FORBIDDEN', error_message = 'Client credential revoked',
          cancellable = 0, finished_at = ?, updated_at = ?, revision = revision + 1
      WHERE client_id = ? AND state IN ('queued', 'waiting_approval')
    `).run(now, now, clientId);
    db.prepare(`
      UPDATE capability_approvals
      SET status = 'expired', updated_at = ?
      WHERE status = 'pending' AND run_id IN (
        SELECT id FROM capability_runs WHERE client_id = ? AND state = 'expired'
      )
    `).run(now, clientId);
    const insertEvent = db.prepare(`
      INSERT INTO capability_run_events(run_id, type, payload_json, created_at)
      VALUES (?, 'run.expired', '{"reason":"client_revoked"}', ?)
    `);
    for (const run of expiringRuns) insertEvent.run(run.id, now);
    return true;
  });
  return revoke();
}

export function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function isValidToken(token: string): boolean {
  return /^zos_mcp_[A-Za-z0-9_-]{43}$/u.test(token);
}

function safeDigestEqual(stored: string, candidate: string): boolean {
  const left = Buffer.from(stored, "hex");
  const right = Buffer.from(candidate, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function mapClient(row: McpClientRow): McpClientRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    tokenPrefix: row.token_prefix,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
