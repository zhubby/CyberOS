import type { DockerRegistryCredentialRecord } from "@zos/db";
import { normalizeDockerRegistryServerAddress, parseDockerImageReference, type DockerRegistryCredentialSummary } from "@zos/shared";

const DOCKER_HUB = "docker.io";
const MAX_IMAGE_REFERENCE_LENGTH = 512;

export class DockerRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerRegistryValidationError";
  }
}

export function normalizeDockerRegistryAddress(value: unknown): string {
  const candidate = requiredText(value, "Registry server address", 255).toLowerCase();
  const normalized = normalizeDockerRegistryServerAddress(candidate);
  if (!normalized) {
    throw new DockerRegistryValidationError("Registry server address must be a hostname or IP with an optional port");
  }
  return normalized;
}

export function normalizeDockerImageReference(value: unknown): string {
  const reference = requiredText(value, "Docker image reference", MAX_IMAGE_REFERENCE_LENGTH);
  if (!parseDockerImageReference(reference)) {
    throw new DockerRegistryValidationError("Docker image reference is invalid");
  }
  return reference;
}

export function dockerRegistryForImage(referenceValue: unknown): string {
  const reference = normalizeDockerImageReference(referenceValue);
  return parseDockerImageReference(reference)!.serverAddress;
}

export function findDockerRegistryCredential(
  records: DockerRegistryCredentialRecord[],
  imageReference: unknown
): DockerRegistryCredentialRecord | null {
  const serverAddress = dockerRegistryForImage(imageReference);
  return records.find((record) => record.serverAddress === serverAddress) ?? null;
}

export function dockerRegistryAuthHeader(record: DockerRegistryCredentialRecord): string {
  const encoded = Buffer.from(JSON.stringify({
    username: record.username,
    password: record.password,
    serveraddress: record.serverAddress
  }), "utf8").toString("base64");
  return encoded.replaceAll("+", "-").replaceAll("/", "_");
}

export function dockerConfigAuths(records: DockerRegistryCredentialRecord[]): Record<string, { auth: string }> {
  return Object.fromEntries(records.map((record) => [
    dockerConfigServerAddress(record.serverAddress),
    { auth: Buffer.from(`${record.username}:${record.password}`, "utf8").toString("base64") }
  ]));
}

export function toPublicDockerRegistryCredential(
  record: DockerRegistryCredentialRecord
): DockerRegistryCredentialSummary {
  return {
    id: record.id,
    name: record.name,
    serverAddress: record.serverAddress,
    username: record.username,
    credentialConfigured: Boolean(record.password),
    updatedAt: record.updatedAt
  };
}

export function redactDockerRegistrySecrets(
  value: unknown,
  records: DockerRegistryCredentialRecord[] = [],
  maxLength = 500
): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const record of records) {
    if (record.password) {
      const representations = [
        record.password,
        JSON.stringify(record.password).slice(1, -1),
        encodeURIComponent(Buffer.from(record.password).toString("utf8")),
        Buffer.from(`${record.username}:${record.password}`).toString("base64"),
        dockerRegistryAuthHeader(record)
      ];
      for (const secret of new Set(representations)) {
        message = message.split(secret).join("[redacted]");
      }
    }
  }
  return message
    .replace(/(X-Registry-Auth\s*[:=]\s*)\S+/giu, "$1[redacted]")
    .replace(/(Basic|Bearer)\s+\S+/giu, "$1 [redacted]")
    .slice(0, maxLength);
}

export function requiredRegistryText(value: unknown, label: string, maxLength: number): string {
  return requiredText(value, label, maxLength);
}

function dockerConfigServerAddress(serverAddress: string): string {
  return serverAddress === DOCKER_HUB ? "https://index.docker.io/v1/" : serverAddress;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new DockerRegistryValidationError(`${label} is required`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new DockerRegistryValidationError(`${label} is required`);
  }
  if (normalized.length > maxLength) {
    throw new DockerRegistryValidationError(`${label} is too long`);
  }
  return normalized;
}
