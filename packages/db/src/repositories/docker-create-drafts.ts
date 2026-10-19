import { randomUUID } from "node:crypto";
import type { DockerContainerCreateInput, DockerHostAccessCapabilityId, DockerHostAccessRisk } from "@zos/shared";
import type { ZosDatabase } from "../connection.js";

export interface DockerCreateDraftGrantSummary {
  capability: DockerHostAccessCapabilityId;
  rootId?: string;
  risk: DockerHostAccessRisk;
}

export interface DockerCreateDraftRecord {
  id: string;
  revision: string;
  input: DockerContainerCreateInput;
  policyVersion: string;
  grants: DockerCreateDraftGrantSummary[];
  fingerprint: string;
  imageDigest: string;
  approvalId: string | null;
  operationId: string | null;
  jobId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface DockerCreateDraftInput {
  id?: string;
  revision?: string;
  input: DockerContainerCreateInput;
  policyVersion: string;
  grants: DockerCreateDraftGrantSummary[];
  fingerprint: string;
  imageDigest: string;
  expiresAt: Date | string;
}

export function createDockerCreateDraft(db: ZosDatabase, input: DockerCreateDraftInput): DockerCreateDraftRecord {
  const id = input.id ?? randomUUID();
  const revision = input.revision ?? randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt;
  db.prepare(`
    INSERT INTO docker_create_drafts (
      id, revision, approval_id, operation_id, job_id, input_json, policy_version,
      grant_summary_json, fingerprint, image_digest, created_at, expires_at
    ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    revision,
    JSON.stringify(input.input),
    input.policyVersion,
    JSON.stringify(input.grants),
    input.fingerprint,
    input.imageDigest,
    createdAt,
    expiresAt
  );
  return getDockerCreateDraft(db, id)!;
}

export function getDockerCreateDraft(db: ZosDatabase, id: string): DockerCreateDraftRecord | null {
  const row = db.prepare(`
    SELECT id, revision, approval_id, operation_id, job_id, input_json, policy_version, grant_summary_json, fingerprint,
           image_digest, created_at, expires_at
    FROM docker_create_drafts
    WHERE id = ?
  `).get(id) as DockerCreateDraftRow | undefined;
  return row ? mapDraft(row) : null;
}

export function getDockerCreateDraftByApproval(
  db: ZosDatabase,
  approvalId: string
): DockerCreateDraftRecord | null {
  const row = db.prepare(`
    SELECT id, revision, approval_id, operation_id, job_id, input_json, policy_version, grant_summary_json, fingerprint,
           image_digest, created_at, expires_at
    FROM docker_create_drafts
    WHERE approval_id = ?
  `).get(approvalId) as DockerCreateDraftRow | undefined;
  return row ? mapDraft(row) : null;
}

export function linkDockerCreateDraft(
  db: ZosDatabase,
  id: string,
  expectedRevision: string,
  links: { approvalId: string; operationId: string; jobId: string }
): boolean {
  return db.prepare(`
    UPDATE docker_create_drafts
    SET approval_id = ?, operation_id = ?, job_id = ?
    WHERE id = ? AND revision = ?
  `).run(links.approvalId, links.operationId, links.jobId, id, expectedRevision).changes === 1;
}

export function consumeDockerCreateDraft(
  db: ZosDatabase,
  id: string,
  expectedRevision: string,
  now = new Date()
): DockerCreateDraftRecord | null {
  return db.transaction(() => {
    const draft = getDockerCreateDraft(db, id);
    if (!draft || draft.revision !== expectedRevision || Date.parse(draft.expiresAt) <= now.getTime()) {
      if (draft && Date.parse(draft.expiresAt) <= now.getTime()) {
        db.prepare("DELETE FROM docker_create_drafts WHERE id = ?").run(id);
      }
      return null;
    }
    const result = db.prepare("DELETE FROM docker_create_drafts WHERE id = ? AND revision = ?").run(id, expectedRevision);
    return result.changes === 1 ? draft : null;
  }).immediate();
}

export function deleteDockerCreateDraft(db: ZosDatabase, id: string): boolean {
  return db.prepare("DELETE FROM docker_create_drafts WHERE id = ?").run(id).changes === 1;
}

export function deleteExpiredDockerCreateDrafts(db: ZosDatabase, now = new Date()): number {
  return db.transaction(() => {
    const expired = db.prepare(`
      SELECT id, approval_id, operation_id, job_id
      FROM docker_create_drafts
      WHERE expires_at <= ?
    `).all(now.toISOString()) as Array<{
      id: string;
      approval_id: string | null;
      operation_id: string | null;
      job_id: string | null;
    }>;
    const timestamp = now.toISOString();
    for (const draft of expired) {
      if (draft.approval_id) {
        db.prepare(`
          UPDATE pending_approvals SET status = 'failed', updated_at = ?
          WHERE id = ? AND status IN ('pending', 'approved')
        `).run(timestamp, draft.approval_id);
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
      db.prepare("DELETE FROM docker_create_drafts WHERE expires_at <= ?").run(now.toISOString());
    }
    return expired.length;
  }).immediate();
}

interface DockerCreateDraftRow {
  id: string;
  revision: string;
  approval_id: string | null;
  operation_id: string | null;
  job_id: string | null;
  input_json: string;
  policy_version: string;
  grant_summary_json: string;
  fingerprint: string;
  image_digest: string;
  created_at: string;
  expires_at: string;
}

function mapDraft(row: DockerCreateDraftRow): DockerCreateDraftRecord {
  return {
    id: row.id,
    revision: row.revision,
    approvalId: row.approval_id,
    operationId: row.operation_id,
    jobId: row.job_id,
    input: JSON.parse(row.input_json) as DockerContainerCreateInput,
    policyVersion: row.policy_version,
    grants: JSON.parse(row.grant_summary_json) as DockerCreateDraftGrantSummary[],
    fingerprint: row.fingerprint,
    imageDigest: row.image_digest,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}
