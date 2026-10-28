import { randomUUID } from "node:crypto";
import type {
  DockerOperationProposal,
  DockerOperationRecord,
  DockerOperationStatus
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import {
  dockerProposalTargetId,
  mapDockerOperation
} from "./operation-mappers.js";
import type { DbDockerOperationRow } from "./repository-rows.js";

export function createDockerOperationRecord(
  db: CyberOsDatabase,
  input: { proposal: DockerOperationProposal }
): DockerOperationRecord {
  const now = new Date().toISOString();
  const operation: DockerOperationRecord = {
    id: randomUUID(),
    action: input.proposal.action,
    targetType: input.proposal.targetType,
    targetId: dockerProposalTargetId(input.proposal),
    status: "proposed",
    metadata: {
      proposal: input.proposal
    },
    createdAt: now,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO docker_operations (
      id, action, target_type, target_id, status, metadata_json, created_at, updated_at
    )
    VALUES (@id, @action, @targetType, @targetId, @status, @metadataJson, @createdAt, @updatedAt)
  `).run({
    ...operation,
    metadataJson: JSON.stringify(operation.metadata)
  });

  return operation;
}

export function getDockerOperation(db: CyberOsDatabase, operationId: string): DockerOperationRecord | null {
  const row = db
    .prepare(`
      SELECT id, action, target_type, target_id, status, metadata_json, created_at, updated_at
      FROM docker_operations
      WHERE id = ?
    `)
    .get(operationId) as DbDockerOperationRow | undefined;
  return row ? mapDockerOperation(row) : null;
}

export function listDockerOperations(
  db: CyberOsDatabase,
  input: { limit?: number } = {}
): DockerOperationRecord[] {
  const rows = db
    .prepare(`
      SELECT o.id, o.action, o.target_type, o.target_id, o.status, o.metadata_json, o.created_at, o.updated_at
      FROM docker_operations o
      ORDER BY o.created_at DESC
      LIMIT ?
    `)
    .all(input.limit ?? 100) as DbDockerOperationRow[];
  return rows.map(mapDockerOperation);
}

export function updateDockerOperationStatus(
  db: CyberOsDatabase,
  operationId: string,
  status: DockerOperationStatus,
  metadata: Record<string, unknown> = {}
): DockerOperationRecord | null {
  const existing = getDockerOperation(db, operationId);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const nextMetadata = {
    ...existing.metadata,
    ...metadata
  };
  const row = db
    .prepare(`
      UPDATE docker_operations
      SET status = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
      RETURNING id, action, target_type, target_id, status, metadata_json, created_at, updated_at
    `)
    .get(status, JSON.stringify(nextMetadata), now, operationId) as DbDockerOperationRow | undefined;
  return row ? mapDockerOperation(row) : null;
}
