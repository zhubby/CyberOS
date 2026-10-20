import { createHash, randomBytes } from "node:crypto";
import type { ZosDatabase } from "../connection.js";

export interface McpTransferRecord {
  clientId: string;
  rootId: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  modifiedAt: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

interface McpTransferRow {
  client_id: string;
  root_id: string;
  relative_path: string;
  mime_type: string;
  size_bytes: number;
  modified_at: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export function createMcpTransferToken(db: ZosDatabase, input: {
  clientId: string;
  rootId: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  modifiedAt: string;
  expiresAt: string;
}): { token: string; transfer: McpTransferRecord } {
  const token = `zos_transfer_${randomBytes(32).toString("base64url")}`;
  const createdAt = new Date().toISOString();
  if (input.expiresAt <= createdAt) throw new Error("Transfer expiry must be in the future");
  db.prepare(`
    INSERT INTO mcp_transfer_tokens(
      token_digest, client_id, root_id, relative_path, mime_type, size_bytes, modified_at, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    digest(token), input.clientId, input.rootId, input.relativePath, input.mimeType,
    input.sizeBytes, input.modifiedAt, input.expiresAt, createdAt
  );
  return {
    token,
    transfer: {
      clientId: input.clientId,
      rootId: input.rootId,
      relativePath: input.relativePath,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      modifiedAt: input.modifiedAt,
      expiresAt: input.expiresAt,
      usedAt: null,
      createdAt
    }
  };
}

export function consumeMcpTransferToken(
  db: ZosDatabase,
  input: { token: string; clientId: string; now?: string }
): McpTransferRecord | null {
  const now = input.now ?? new Date().toISOString();
  const row = db.prepare(`
    UPDATE mcp_transfer_tokens
    SET used_at = ?
    WHERE token_digest = ? AND client_id = ? AND used_at IS NULL AND expires_at > ?
    RETURNING client_id, root_id, relative_path, mime_type, size_bytes, modified_at, expires_at, used_at, created_at
  `).get(now, digest(input.token), input.clientId, now) as McpTransferRow | undefined;
  return row ? mapTransfer(row) : null;
}

export function deleteExpiredMcpTransferTokens(db: ZosDatabase, now = new Date().toISOString()): number {
  return db.prepare("DELETE FROM mcp_transfer_tokens WHERE expires_at <= ? OR used_at IS NOT NULL").run(now).changes;
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mapTransfer(row: McpTransferRow): McpTransferRecord {
  return {
    clientId: row.client_id,
    rootId: row.root_id,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    modifiedAt: row.modified_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at
  };
}
