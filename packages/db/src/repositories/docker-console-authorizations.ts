import { randomUUID } from "node:crypto";
import type {
  DockerConsoleAuthorizationRecord
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import { mapDockerConsoleAuthorization } from "./operation-mappers.js";
import type { DbDockerConsoleAuthorizationRow } from "./repository-rows.js";

export function createDockerConsoleAuthorization(
  db: CyberOsDatabase,
  input: {
    operationId: string;
    approvalId?: string | null;
    containerId: string;
    shell: string;
    ttlMs?: number;
  }
): DockerConsoleAuthorizationRecord {
  const approvalId = input.approvalId ?? null;
  const approvedOperation = db.prepare(`
    SELECT 1
    FROM docker_operations o
    LEFT JOIN pending_approvals a ON a.id = o.approval_id
    WHERE o.id = ?
      AND o.action = 'console'
      AND o.status = 'approved'
      AND (
        (? IS NULL AND o.approval_id IS NULL)
        OR (o.approval_id = ? AND a.status = 'approved')
      )
    LIMIT 1
  `).get(input.operationId, approvalId, approvalId);
  if (!approvedOperation) {
    throw new Error("Approved console operation not found");
  }

  const now = new Date();
  const authorization: DockerConsoleAuthorizationRecord = {
    id: randomUUID(),
    operationId: input.operationId,
    approvalId,
    containerId: input.containerId,
    shell: input.shell,
    status: "active",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlMs ?? 5 * 60_000)).toISOString(),
    usedAt: null
  };

  db.prepare(`
    INSERT INTO docker_console_authorizations (
      id, operation_id, approval_id, container_id, shell, status, created_at, expires_at, used_at
    )
    VALUES (@id, @operationId, @approvalId, @containerId, @shell, @status, @createdAt, @expiresAt, @usedAt)
  `).run(authorization);

  return authorization;
}

export function consumeDockerConsoleAuthorization(
  db: CyberOsDatabase,
  authorizationId: string
): DockerConsoleAuthorizationRecord | null {
  const row = db
    .prepare(`
      SELECT id, operation_id, approval_id, container_id, shell, status, created_at, expires_at, used_at
      FROM docker_console_authorizations
      WHERE id = ?
    `)
    .get(authorizationId) as DbDockerConsoleAuthorizationRow | undefined;
  if (!row) {
    return null;
  }

  const authorization = mapDockerConsoleAuthorization(row);
  const now = new Date();
  if (authorization.status !== "active") {
    return null;
  }
  if (Date.parse(authorization.expiresAt) <= now.getTime()) {
    db.prepare("UPDATE docker_console_authorizations SET status = 'expired' WHERE id = ?").run(authorization.id);
    return null;
  }

  const usedAt = now.toISOString();
  const updated = db
    .prepare(`
      UPDATE docker_console_authorizations
      SET status = 'used', used_at = ?
      WHERE id = ? AND status = 'active'
      RETURNING id, operation_id, approval_id, container_id, shell, status, created_at, expires_at, used_at
    `)
    .get(usedAt, authorization.id) as DbDockerConsoleAuthorizationRow | undefined;
  return updated ? mapDockerConsoleAuthorization(updated) : null;
}

export function markDockerConsoleAuthorizationFailed(db: CyberOsDatabase, authorizationId: string): boolean {
  const result = db
    .prepare("UPDATE docker_console_authorizations SET status = 'failed' WHERE id = ? AND status IN ('active', 'used')")
    .run(authorizationId);
  return result.changes === 1;
}
