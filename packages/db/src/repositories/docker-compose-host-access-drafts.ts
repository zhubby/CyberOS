import { randomUUID } from "node:crypto";
import type { ZosDatabase } from "../connection.js";

export interface DockerComposeHostAccessDraftRecord {
  id: string;
  revision: string;
  projectId: string;
  composeRevision: string;
  policyVersion: string;
  imageDigests: Array<{ service: string; digest: string }>;
  fingerprints: Array<{ service: string; fingerprint: string }>;
  approvalId: string | null;
  operationId: string | null;
  jobId: string | null;
  createdAt: string;
  expiresAt: string;
}

export function createDockerComposeHostAccessDraft(
  db: ZosDatabase,
  input: {
    projectId: string;
    composeRevision: string;
    policyVersion: string;
    imageDigests: Array<{ service: string; digest: string }>;
    fingerprints: Array<{ service: string; fingerprint: string }>;
    expiresAt: Date | string;
  }
): DockerComposeHostAccessDraftRecord {
  const id = randomUUID();
  const revision = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt;
  db.prepare(`
    INSERT INTO docker_compose_host_access_drafts (
      id, revision, project_id, compose_revision, approval_id, operation_id, job_id,
      policy_version, image_digests_json, fingerprints_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
  `).run(
    id,
    revision,
    input.projectId,
    input.composeRevision,
    input.policyVersion,
    JSON.stringify(input.imageDigests),
    JSON.stringify(input.fingerprints),
    createdAt,
    expiresAt
  );
  return getDockerComposeHostAccessDraft(db, id)!;
}

export function getDockerComposeHostAccessDraft(
  db: ZosDatabase,
  id: string
): DockerComposeHostAccessDraftRecord | null {
  const row = db.prepare(`
    SELECT id, revision, project_id, compose_revision, approval_id, operation_id, job_id,
           policy_version, image_digests_json, fingerprints_json, created_at, expires_at
    FROM docker_compose_host_access_drafts
    WHERE id = ?
  `).get(id) as DraftRow | undefined;
  return row ? mapDraft(row) : null;
}

export function getDockerComposeHostAccessDraftByApproval(
  db: ZosDatabase,
  approvalId: string
): DockerComposeHostAccessDraftRecord | null {
  const row = db.prepare(`
    SELECT id, revision, project_id, compose_revision, approval_id, operation_id, job_id,
           policy_version, image_digests_json, fingerprints_json, created_at, expires_at
    FROM docker_compose_host_access_drafts
    WHERE approval_id = ?
  `).get(approvalId) as DraftRow | undefined;
  return row ? mapDraft(row) : null;
}

export function linkDockerComposeHostAccessDraft(
  db: ZosDatabase,
  id: string,
  expectedRevision: string,
  links: { approvalId: string; operationId: string; jobId: string }
): boolean {
  return db.prepare(`
    UPDATE docker_compose_host_access_drafts
    SET approval_id = ?, operation_id = ?, job_id = ?
    WHERE id = ? AND revision = ?
  `).run(links.approvalId, links.operationId, links.jobId, id, expectedRevision).changes === 1;
}

export function deleteDockerComposeHostAccessDraft(db: ZosDatabase, id: string): boolean {
  return db.prepare("DELETE FROM docker_compose_host_access_drafts WHERE id = ?").run(id).changes === 1;
}

export function deleteExpiredDockerComposeHostAccessDrafts(db: ZosDatabase, now = new Date()): number {
  return db.transaction(() => {
    const expired = db.prepare(`
      SELECT approval_id, operation_id, job_id
      FROM docker_compose_host_access_drafts
      WHERE expires_at <= ?
    `).all(now.toISOString()) as Array<{
      approval_id: string | null;
      operation_id: string | null;
      job_id: string | null;
    }>;
    const timestamp = now.toISOString();
    for (const draft of expired) {
      if (draft.approval_id) {
        db.prepare("UPDATE pending_approvals SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('pending', 'approved')")
          .run(timestamp, draft.approval_id);
      }
      if (draft.operation_id) {
        db.prepare(`
          UPDATE docker_operations
          SET status = 'failed', metadata_json = json_set(metadata_json, '$.expired', 1, '$.expiredAt', ?), updated_at = ?
          WHERE id = ? AND status IN ('proposed', 'approved')
        `).run(timestamp, timestamp, draft.operation_id);
      }
      if (draft.job_id) {
        db.prepare(`
          UPDATE jobs SET status = 'failed', error = 'Docker Host Access draft expired', updated_at = ?
          WHERE id = ? AND status = 'waiting_approval'
        `).run(timestamp, draft.job_id);
      }
    }
    if (expired.length) {
      db.prepare("DELETE FROM docker_compose_host_access_drafts WHERE expires_at <= ?").run(now.toISOString());
    }
    return expired.length;
  }).immediate();
}

interface DraftRow {
  id: string;
  revision: string;
  project_id: string;
  compose_revision: string;
  approval_id: string | null;
  operation_id: string | null;
  job_id: string | null;
  policy_version: string;
  image_digests_json: string;
  fingerprints_json: string;
  created_at: string;
  expires_at: string;
}

function mapDraft(row: DraftRow): DockerComposeHostAccessDraftRecord {
  return {
    id: row.id,
    revision: row.revision,
    projectId: row.project_id,
    composeRevision: row.compose_revision,
    policyVersion: row.policy_version,
    imageDigests: JSON.parse(row.image_digests_json) as Array<{ service: string; digest: string }>,
    fingerprints: JSON.parse(row.fingerprints_json) as Array<{ service: string; fingerprint: string }>,
    approvalId: row.approval_id,
    operationId: row.operation_id,
    jobId: row.job_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}
