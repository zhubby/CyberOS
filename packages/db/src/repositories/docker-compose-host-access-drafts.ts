import { randomUUID } from "node:crypto";
import type { CyberOsDatabase } from "../connection.js";

export interface DockerComposeHostAccessDraftRecord {
  id: string;
  revision: string;
  projectId: string;
  composeRevision: string;
  policyVersion: string;
  imageDigests: Array<{ service: string; digest: string }>;
  fingerprints: Array<{ service: string; fingerprint: string }>;
  createdAt: string;
  expiresAt: string;
}

export function createDockerComposeHostAccessDraft(
  db: CyberOsDatabase,
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
      id, revision, project_id, compose_revision,
      policy_version, image_digests_json, fingerprints_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  db: CyberOsDatabase,
  id: string
): DockerComposeHostAccessDraftRecord | null {
  const row = db.prepare(`
    SELECT id, revision, project_id, compose_revision,
           policy_version, image_digests_json, fingerprints_json, created_at, expires_at
    FROM docker_compose_host_access_drafts
    WHERE id = ?
  `).get(id) as DraftRow | undefined;
  return row ? mapDraft(row) : null;
}

export function deleteDockerComposeHostAccessDraft(db: CyberOsDatabase, id: string): boolean {
  return db.prepare("DELETE FROM docker_compose_host_access_drafts WHERE id = ?").run(id).changes === 1;
}

export function deleteExpiredDockerComposeHostAccessDrafts(db: CyberOsDatabase, now = new Date()): number {
  return db.prepare("DELETE FROM docker_compose_host_access_drafts WHERE expires_at <= ?")
    .run(now.toISOString()).changes;
}

interface DraftRow {
  id: string;
  revision: string;
  project_id: string;
  compose_revision: string;
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
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}
