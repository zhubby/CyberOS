import { createHash, randomBytes } from "node:crypto";
import type { JsonValue } from "@zos/capabilities";
import type { ZosDatabase } from "../connection.js";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;

export type McpResourceKind = "file" | "file_export" | "photo_media" | "photo_export";

export interface McpResourceRecord {
  clientId: string;
  kind: McpResourceKind;
  descriptor: JsonValue;
  revision: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number | null;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

interface McpResourceRow {
  client_id: string;
  kind: McpResourceKind;
  descriptor_json: string;
  revision: string;
  mime_type: string;
  file_name: string;
  size_bytes: number | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export function createMcpResourceToken(db: ZosDatabase, input: {
  clientId: string;
  kind: McpResourceKind;
  descriptor: JsonValue;
  revision: string;
  mimeType: string;
  fileName: string;
  sizeBytes?: number | null;
  expiresAt: string;
}): { token: string; resource: McpResourceRecord } {
  const createdAt = new Date().toISOString();
  if (input.expiresAt <= createdAt) throw new Error("Resource expiry must be in the future");
  if (!input.revision || input.revision.length > 512) throw new Error("Resource revision is invalid");
  if (!input.mimeType || input.mimeType.length > 255) throw new Error("Resource MIME type is invalid");
  if (!input.fileName || input.fileName.length > 255 || /[\r\n\0]/u.test(input.fileName)) {
    throw new Error("Resource file name is invalid");
  }
  const sizeBytes = input.sizeBytes ?? null;
  if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
    throw new Error("Resource size is invalid");
  }
  const descriptorJson = JSON.stringify(input.descriptor);
  if (Buffer.byteLength(descriptorJson, "utf8") > MAX_DESCRIPTOR_BYTES) {
    throw new Error("Resource descriptor is too large");
  }
  const token = `zos_resource_${randomBytes(32).toString("base64url")}`;
  db.prepare(`
    INSERT INTO mcp_resource_tokens(
      token_digest, client_id, kind, descriptor_json, revision, mime_type,
      file_name, size_bytes, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    digest(token), input.clientId, input.kind, descriptorJson, input.revision,
    input.mimeType, input.fileName, sizeBytes, input.expiresAt, createdAt
  );
  return {
    token,
    resource: {
      clientId: input.clientId,
      kind: input.kind,
      descriptor: input.descriptor,
      revision: input.revision,
      mimeType: input.mimeType,
      fileName: input.fileName,
      sizeBytes,
      expiresAt: input.expiresAt,
      usedAt: null,
      createdAt
    }
  };
}

export function consumeMcpResourceToken(
  db: ZosDatabase,
  input: { token: string; clientId: string; now?: string }
): McpResourceRecord | null {
  const now = input.now ?? new Date().toISOString();
  const row = db.prepare(`
    UPDATE mcp_resource_tokens
    SET used_at = ?
    WHERE token_digest = ? AND client_id = ? AND used_at IS NULL AND expires_at > ?
    RETURNING client_id, kind, descriptor_json, revision, mime_type, file_name,
      size_bytes, expires_at, used_at, created_at
  `).get(now, digest(input.token), input.clientId, now) as McpResourceRow | undefined;
  return row ? mapResource(row) : null;
}

export function deleteExpiredMcpResourceTokens(db: ZosDatabase, now = new Date().toISOString()): number {
  return db.prepare("DELETE FROM mcp_resource_tokens WHERE expires_at <= ? OR used_at IS NOT NULL").run(now).changes;
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mapResource(row: McpResourceRow): McpResourceRecord {
  return {
    clientId: row.client_id,
    kind: row.kind,
    descriptor: JSON.parse(row.descriptor_json) as JsonValue,
    revision: row.revision,
    mimeType: row.mime_type,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at
  };
}
