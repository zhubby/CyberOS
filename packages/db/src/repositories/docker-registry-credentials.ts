import { randomUUID } from "node:crypto";
import type { CyberOsDatabase } from "../connection.js";
import type { DbSystemSettingRow } from "./repository-rows.js";

const DOCKER_REGISTRY_CREDENTIALS_KEY = "docker_registry_credentials";

export interface DockerRegistryCredentialRecord {
  id: string;
  name: string;
  serverAddress: string;
  username: string;
  password: string;
  createdAt: string;
  updatedAt: string;
}

export class DockerRegistryCredentialConflictError extends Error {
  constructor() {
    super("Docker registry credentials already exist for this server");
    this.name = "DockerRegistryCredentialConflictError";
  }
}

export function listDockerRegistryCredentials(db: CyberOsDatabase): DockerRegistryCredentialRecord[] {
  const row = db
    .prepare("SELECT key, value_json, updated_at FROM system_settings WHERE key = ?")
    .get(DOCKER_REGISTRY_CREDENTIALS_KEY) as DbSystemSettingRow | undefined;
  if (!row) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value_json) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((value) => registryRecord(value, row.updated_at))
    .filter((value): value is DockerRegistryCredentialRecord => value !== null);
}

export function createDockerRegistryCredential(
  db: CyberOsDatabase,
  input: Pick<DockerRegistryCredentialRecord, "name" | "serverAddress" | "username" | "password">
): DockerRegistryCredentialRecord {
  return db.transaction(() => {
    const records = listDockerRegistryCredentials(db);
    assertUniqueServer(records, input.serverAddress);
    const now = new Date().toISOString();
    const record: DockerRegistryCredentialRecord = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now
    };
    saveRecords(db, [...records, record], now);
    return record;
  })();
}

export function updateDockerRegistryCredential(
  db: CyberOsDatabase,
  id: string,
  input: Partial<Pick<DockerRegistryCredentialRecord, "name" | "serverAddress" | "username" | "password">>
): DockerRegistryCredentialRecord | null {
  return db.transaction(() => {
    const records = listDockerRegistryCredentials(db);
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) {
      return null;
    }
    const current = records[index]!;
    const serverAddress = input.serverAddress ?? current.serverAddress;
    assertUniqueServer(records, serverAddress, id);
    const updatedAt = new Date().toISOString();
    const updated: DockerRegistryCredentialRecord = {
      ...current,
      ...input,
      password: input.password?.trim() ? input.password : current.password,
      serverAddress,
      updatedAt
    };
    records[index] = updated;
    saveRecords(db, records, updatedAt);
    return updated;
  })();
}

export function deleteDockerRegistryCredential(db: CyberOsDatabase, id: string): boolean {
  return db.transaction(() => {
    const records = listDockerRegistryCredentials(db);
    const remaining = records.filter((record) => record.id !== id);
    if (remaining.length === records.length) {
      return false;
    }
    saveRecords(db, remaining, new Date().toISOString());
    return true;
  })();
}

function assertUniqueServer(records: DockerRegistryCredentialRecord[], serverAddress: string, exceptId?: string): void {
  if (records.some((record) => record.id !== exceptId && record.serverAddress === serverAddress)) {
    throw new DockerRegistryCredentialConflictError();
  }
}

function saveRecords(db: CyberOsDatabase, records: DockerRegistryCredentialRecord[], updatedAt: string): void {
  db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(DOCKER_REGISTRY_CREDENTIALS_KEY, JSON.stringify(records), updatedAt);
}

function registryRecord(value: unknown, fallbackUpdatedAt: string): DockerRegistryCredentialRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<DockerRegistryCredentialRecord>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.serverAddress !== "string" ||
    typeof candidate.username !== "string" ||
    typeof candidate.password !== "string"
  ) {
    return null;
  }
  return {
    id: candidate.id,
    name: candidate.name,
    serverAddress: candidate.serverAddress,
    username: candidate.username,
    password: candidate.password,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : fallbackUpdatedAt,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : fallbackUpdatedAt
  };
}
