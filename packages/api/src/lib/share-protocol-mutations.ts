import { isShareProtocol, SHARE_PROTOCOLS, type ShareDefinitionConfig, type ShareProtocol, type ShareSettingsRecord } from "@cyberos/shared";

export class ShareMutationError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 502 | 503, message: string) {
    super(message);
  }
}

export function checkShareRevision(existing: ShareSettingsRecord, expectedUpdatedAt: unknown): void {
  if (typeof expectedUpdatedAt !== "string" || !expectedUpdatedAt) {
    throw new ShareMutationError(400, "Expected settings revision is required");
  }
  if (existing.updatedAt !== expectedUpdatedAt) {
    throw new ShareMutationError(409, "Share settings changed; refresh before saving");
  }
}

export function mutateProtocolShares(
  existing: ShareSettingsRecord,
  protocol: ShareProtocol,
  id: string | undefined,
  method: string,
  input: { share?: ShareDefinitionConfig; enabled?: boolean }
): ShareDefinitionConfig[] {
  const target = id ? existing.shares.find((share) => share.id === id && share.protocol === protocol) : undefined;
  if (id && !target) throw new ShareMutationError(404, "Share not found in this protocol");
  if (method === "DELETE") return existing.shares.filter((share) => share !== target);
  if (method === "PATCH") {
    if (!target || typeof input.enabled !== "boolean") throw new ShareMutationError(400, "Enabled must be a boolean");
    return existing.shares.map((share) => share === target ? {
      ...share, protocols: { ...share.protocols, [protocol]: { ...share.protocols[protocol], enabled: input.enabled } }
    } : share);
  }
  const next = input.share;
  if (!next || typeof next !== "object" || !next.protocols || (!isShareProtocol(next.protocol) || next.protocol !== protocol)) {
    throw new ShareMutationError(400, "A share for the selected protocol is required");
  }
  if (SHARE_PROTOCOLS.some((other) => other !== protocol && next.protocols[other]?.enabled)) {
    throw new ShareMutationError(400, "A protocol share cannot enable another protocol");
  }
  if (target && next.id !== target.id) throw new ShareMutationError(400, "Share ID cannot be changed");
  if (!target && existing.shares.some((share) => share.id === next.id)) throw new ShareMutationError(400, "Share ID already exists");
  const replacement = { ...next, protocol };
  return target ? existing.shares.map((share) => share === target ? replacement : share) : [...existing.shares, replacement];
}
