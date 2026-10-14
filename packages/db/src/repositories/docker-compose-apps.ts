import { randomUUID } from "node:crypto";
import type { DockerComposeAppRisk } from "@zos/shared";
import type { ZosDatabase } from "../connection.js";

export interface DockerComposeAppEnvironmentRecord {
  key: string;
  value: string;
}

export interface DockerComposeAppRecord {
  id: string;
  name: string;
  projectKey: string;
  composeContent: string;
  environment: DockerComposeAppEnvironmentRecord[];
  services: string[];
  warnings: string[];
  risk: DockerComposeAppRisk;
  revision: string;
  deployedRevision: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DockerComposeAppSummaryRecord = Omit<DockerComposeAppRecord, "composeContent" | "environment">;

export interface DockerComposeAppWriteInput {
  name: string;
  projectKey: string;
  composeContent: string;
  environment: DockerComposeAppEnvironmentRecord[];
  services: string[];
  warnings: string[];
  risk: DockerComposeAppRisk;
}

export class DockerComposeAppConflictError extends Error {
  constructor(message = "Docker Compose App changed in another request") {
    super(message);
    this.name = "DockerComposeAppConflictError";
  }
}

export class DockerComposeAppProjectKeyConflictError extends Error {
  constructor() {
    super("Docker Compose project key is already in use");
    this.name = "DockerComposeAppProjectKeyConflictError";
  }
}

export function listDockerComposeApps(db: ZosDatabase): DockerComposeAppRecord[] {
  const rows = db.prepare(`
    SELECT id, name, project_key, compose_content, services_json, warnings_json, risk,
           revision, deployed_revision, created_at, updated_at
    FROM docker_apps
    ORDER BY name COLLATE NOCASE, project_key COLLATE NOCASE
  `).all() as DockerComposeAppRow[];
  const environment = environmentByApp(db, rows.map((row) => row.id));
  return rows.map((row) => mapApp(row, environment.get(row.id) ?? []));
}

export function listDockerComposeAppSummaries(db: ZosDatabase): DockerComposeAppSummaryRecord[] {
  return (db.prepare(`
    SELECT id, name, project_key, services_json, warnings_json, risk,
           revision, deployed_revision, created_at, updated_at
    FROM docker_apps
    ORDER BY name COLLATE NOCASE, project_key COLLATE NOCASE
  `).all() as DockerComposeAppSummaryRow[]).map(mapAppSummary);
}

export function getDockerComposeApp(db: ZosDatabase, id: string): DockerComposeAppRecord | null {
  const row = db.prepare(`
    SELECT id, name, project_key, compose_content, services_json, warnings_json, risk,
           revision, deployed_revision, created_at, updated_at
    FROM docker_apps
    WHERE id = ?
  `).get(id) as DockerComposeAppRow | undefined;
  return row ? mapApp(row, environmentByApp(db, [id]).get(id) ?? []) : null;
}

export function getDockerComposeAppSummary(
  db: ZosDatabase,
  id: string
): DockerComposeAppSummaryRecord | null {
  const row = db.prepare(`
    SELECT id, name, project_key, services_json, warnings_json, risk,
           revision, deployed_revision, created_at, updated_at
    FROM docker_apps
    WHERE id = ?
  `).get(id) as DockerComposeAppSummaryRow | undefined;
  return row ? mapAppSummary(row) : null;
}

export function createDockerComposeApp(
  db: ZosDatabase,
  input: DockerComposeAppWriteInput
): DockerComposeAppRecord {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const id = randomUUID();
    const revision = randomUUID();
    try {
      db.prepare(`
        INSERT INTO docker_apps (
          id, name, project_key, compose_content, services_json, warnings_json, risk,
          revision, deployed_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        id,
        input.name,
        input.projectKey,
        input.composeContent,
        JSON.stringify(input.services),
        JSON.stringify(input.warnings),
        input.risk,
        revision,
        now,
        now
      );
    } catch (error) {
      if (isUniqueConstraint(error)) throw new DockerComposeAppProjectKeyConflictError();
      throw error;
    }
    replaceEnvironment(db, id, input.environment, now);
    return getDockerComposeApp(db, id)!;
  })();
}

export function updateDockerComposeApp(
  db: ZosDatabase,
  id: string,
  expectedRevision: string,
  input: Omit<DockerComposeAppWriteInput, "projectKey" | "environment"> & {
    environment: Array<{ key: string; value?: string }>;
  }
): DockerComposeAppRecord | null {
  return db.transaction(() => {
    const current = getDockerComposeApp(db, id);
    if (!current) return null;
    if (current.revision !== expectedRevision) throw new DockerComposeAppConflictError();
    const currentValues = new Map(current.environment.map((entry) => [entry.key, entry.value]));
    const environment = input.environment.map((entry) => {
      if (entry.value !== undefined) return { key: entry.key, value: entry.value };
      const value = currentValues.get(entry.key);
      if (value === undefined) {
        throw new DockerComposeAppConflictError(`Environment value for ${entry.key} is no longer available`);
      }
      return { key: entry.key, value };
    });
    const now = new Date().toISOString();
    const revision = randomUUID();
    const result = db.prepare(`
      UPDATE docker_apps
      SET name = ?, compose_content = ?, services_json = ?, warnings_json = ?, risk = ?,
          revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      input.name,
      input.composeContent,
      JSON.stringify(input.services),
      JSON.stringify(input.warnings),
      input.risk,
      revision,
      now,
      id,
      expectedRevision
    );
    if (result.changes !== 1) throw new DockerComposeAppConflictError();
    replaceEnvironment(db, id, environment, now);
    return getDockerComposeApp(db, id)!;
  })();
}

export function markDockerComposeAppDeployed(
  db: ZosDatabase,
  id: string,
  revision: string
): DockerComposeAppRecord | null {
  const updatedAt = new Date().toISOString();
  const result = db.prepare(`
    UPDATE docker_apps
    SET deployed_revision = ?, updated_at = ?
    WHERE id = ? AND revision = ?
  `).run(revision, updatedAt, id, revision);
  return result.changes === 1 ? getDockerComposeApp(db, id) : null;
}

export function restoreDockerComposeApp(
  db: ZosDatabase,
  expectedRevision: string,
  app: DockerComposeAppRecord
): DockerComposeAppRecord {
  return db.transaction(() => {
    const result = db.prepare(`
      UPDATE docker_apps
      SET name = ?, compose_content = ?, services_json = ?, warnings_json = ?, risk = ?,
          revision = ?, deployed_revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      app.name,
      app.composeContent,
      JSON.stringify(app.services),
      JSON.stringify(app.warnings),
      app.risk,
      app.revision,
      app.deployedRevision,
      app.updatedAt,
      app.id,
      expectedRevision
    );
    if (result.changes !== 1) throw new DockerComposeAppConflictError("Docker Compose App rollback conflicted");
    replaceEnvironment(db, app.id, app.environment, app.updatedAt);
    return getDockerComposeApp(db, app.id)!;
  })();
}

export function deleteDockerComposeApp(
  db: ZosDatabase,
  id: string,
  expectedRevision: string
): "deleted" | "not_found" | "conflict" {
  const current = db.prepare("SELECT revision FROM docker_apps WHERE id = ?").get(id) as { revision: string } | undefined;
  if (!current) return "not_found";
  if (current.revision !== expectedRevision) return "conflict";
  const result = db.prepare("DELETE FROM docker_apps WHERE id = ? AND revision = ?").run(id, expectedRevision);
  return result.changes === 1 ? "deleted" : "conflict";
}

interface DockerComposeAppRow {
  id: string;
  name: string;
  project_key: string;
  compose_content: string;
  services_json: string;
  warnings_json: string;
  risk: DockerComposeAppRisk;
  revision: string;
  deployed_revision: string | null;
  created_at: string;
  updated_at: string;
}

type DockerComposeAppSummaryRow = Omit<DockerComposeAppRow, "compose_content">;

function environmentByApp(
  db: ZosDatabase,
  appIds: string[]
): Map<string, DockerComposeAppEnvironmentRecord[]> {
  const result = new Map<string, DockerComposeAppEnvironmentRecord[]>();
  if (!appIds.length) return result;
  const placeholders = appIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT app_id, key, value
    FROM docker_app_environment
    WHERE app_id IN (${placeholders})
    ORDER BY key COLLATE NOCASE
  `).all(...appIds) as Array<{ app_id: string; key: string; value: string }>;
  for (const row of rows) {
    const entries = result.get(row.app_id) ?? [];
    entries.push({ key: row.key, value: row.value });
    result.set(row.app_id, entries);
  }
  return result;
}

function replaceEnvironment(
  db: ZosDatabase,
  appId: string,
  environment: DockerComposeAppEnvironmentRecord[],
  updatedAt: string
): void {
  db.prepare("DELETE FROM docker_app_environment WHERE app_id = ?").run(appId);
  const insert = db.prepare(`
    INSERT INTO docker_app_environment (app_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const entry of environment) insert.run(appId, entry.key, entry.value, updatedAt);
}

function mapApp(
  row: DockerComposeAppRow,
  environment: DockerComposeAppEnvironmentRecord[]
): DockerComposeAppRecord {
  return {
    ...mapAppSummary(row),
    composeContent: row.compose_content,
    environment
  };
}

function mapAppSummary(row: DockerComposeAppSummaryRow): DockerComposeAppSummaryRecord {
  return {
    id: row.id,
    name: row.name,
    projectKey: row.project_key,
    services: parseStringArray(row.services_json),
    warnings: parseStringArray(row.warnings_json),
    risk: row.risk,
    revision: row.revision,
    deployedRevision: row.deployed_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: docker_apps\.project_key/u.test(error.message);
}
