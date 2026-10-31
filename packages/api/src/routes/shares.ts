import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  createShareOperationRecord,
  updateShareOperationStatus
} from "@cyberos/db";
import { isShareProtocol, type ShareDefinitionConfig, type ShareSettingsRecord, type ShareOperationProposal } from "@cyberos/shared";
import { checkShareRevision, mutateProtocolShares, ShareMutationError } from "../lib/share-protocol-mutations.js";
import type { ApiRouteContext } from "../context.js";
import { HostdRequestError } from "../lib/hostd-client.js";
import {
  normalizeShareSettingsInput,
  type ShareSettingsInput,
  type ShareStoragePool
} from "../lib/share-settings.js";
import {
  applyShareSettings,
  collectShareSummary,
  safeShareMessage,
  serializeShareMutation,
  toPublicShareOperation
} from "../lib/share-service.js";
import {
  loadEffectiveShareSettings,
  loadRepairableShareSettings,
  persistShareSettings,
  withoutSharePassword
} from "../lib/share-credentials.js";
import { toPublicShareSettings } from "../lib/settings.js";
import { collectSystemStorage } from "../lib/system-management.js";

export function registerShareRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { config, db } = context;

  server.get("/api/shares/summary", async () => {
    const settings = await loadEffectiveShareSettings(db, config);
    return {
      summary: await collectShareSummary(settings, context.shares)
    };
  });

  server.put<{
    Body: {
      username?: string;
      password?: string;
      expectedUpdatedAt?: string;
    };
  }>("/api/shares/account", async (request, reply) => {
    try {
      const response = await serializeShareMutation(async () => {
        const { username, password, expectedUpdatedAt } = request.body ?? {};
        if (typeof username !== "string" || typeof expectedUpdatedAt !== "string" || !expectedUpdatedAt) {
          throw new ShareAccountUpdateError(400, "Username and expected settings revision are required");
        }
        if (password !== undefined && typeof password !== "string") {
          throw new ShareAccountUpdateError(400, "Password must be a string");
        }

        const existing = await loadEffectiveShareSettings(db, config);
        if (existing.updatedAt !== expectedUpdatedAt) {
          throw new ShareAccountUpdateError(409, "Share settings changed; reload before saving the account");
        }
        const storagePools = await listShareStoragePools(context);
        let settings;
        try {
          settings = await normalizeShareSettingsInput({
            account: {
              username,
              ...(password ? { password } : {})
            }
          }, existing, storagePools);
        } catch (error) {
          throw new ShareAccountUpdateError(400, safeShareMessage(error));
        }

        let applied;
        try {
          applied = await applyShareSettings(config, settings, context.shares);
        } catch (error) {
          const statusCode = error instanceof HostdRequestError && error.statusCode === 503 ? 503 : 502;
          throw new ShareAccountUpdateError(statusCode, safeShareMessage(error));
        }

        let saved;
        try {
          saved = settings.account.username === existing.account.username && !password
            ? existing
            : await persistShareSettings(db, config, settings);
        } catch (error) {
          await applyShareSettings(config, existing, context.shares).catch(() => undefined);
          throw error;
        }
        return {
          settings: toPublicShareSettings(saved),
          appliedAt: applied.appliedAt
        };
      });
      reply.send(response);
    } catch (error) {
      if (error instanceof ShareAccountUpdateError) {
        reply.status(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  server.post<{
    Body: {
      settings?: ShareSettingsInput;
    };
  }>("/api/shares/settings", async (request, reply) => {
    try {
      const response = await serializeShareMutation(async () => {
        const existing = await loadRepairableShareSettings(db, config);
        const storagePools = await listShareStoragePools(context);
        const settings = await normalizeShareSettingsInput(request.body?.settings, existing, storagePools);
        return applyRecorded(settings, existing);
      });
      reply.send(response);
    } catch (error) {
      reply.status(400).send({ error: safeShareMessage(error) });
    }
  });
  async function applyRecorded(settings: ShareSettingsRecord, existing: ShareSettingsRecord) {
    const publicSettings = toPublicShareSettings(settings);
    const proposal: ShareOperationProposal = {
      action: "apply_settings",
      risk: "high",
      summary: shareProposalSummary(settings),
      settings: publicSettings
    };
    const operation = createShareOperationRecord(db, {
      proposal,
      settings: withoutSharePassword(settings)
    });
    try {
      const applied = await applyShareSettings(config, settings, context.shares);
      let saved;
      try {
        saved = await persistShareSettings(db, config, settings);
      } catch (error) {
        await applyShareSettings(config, existing, context.shares).catch(() => undefined);
        throw error;
      }
      const completed = updateShareOperationStatus(db, operation.id, "applied", {
        ...applied,
        settingsUpdatedAt: saved.updatedAt,
        appliedAt: new Date().toISOString()
      });
      return {
        settings: toPublicShareSettings(saved),
        operation: completed ? toPublicShareOperation(completed) : null
      };
    } catch (error) {
      const message = safeShareMessage(error);
      updateShareOperationStatus(db, operation.id, "failed", {
        error: message,
        failedAt: new Date().toISOString()
      });
      throw new ShareMutationError(error instanceof HostdRequestError && error.statusCode === 503 ? 503 : 502, message);
    }
  }

  type ProtocolBody = { expectedUpdatedAt?: string; share?: ShareDefinitionConfig; enabled?: boolean };
  for (const route of [
    { method: ["POST"] as const, url: "/api/shares/protocols/:protocol" },
    { method: ["PUT", "PATCH", "DELETE"] as const, url: "/api/shares/protocols/:protocol/:id" }
  ]) {
    server.route<{ Params: { protocol: string; id?: string }; Body: ProtocolBody }>({
      method: [...route.method], url: route.url,
      handler: async (request, reply) => {
        try {
          const response = await serializeShareMutation(async () => {
            const protocol = request.params.protocol;
            if (!isShareProtocol(protocol)) throw new ShareMutationError(400, "Unknown share protocol");
            const existing = await loadEffectiveShareSettings(db, config);
            checkShareRevision(existing, request.body?.expectedUpdatedAt);
            const shares = mutateProtocolShares(existing, protocol, request.params.id, request.method, request.body ?? {});
            const settings = await normalizeShareSettingsInput({ shares }, existing, await listShareStoragePools(context));
            return applyRecorded(settings, existing);
          });
          return reply.send(response);
        } catch (error) {
          return reply.status(error instanceof ShareMutationError ? error.statusCode : error instanceof HostdRequestError ? 502 : 400)
            .send({ error: safeShareMessage(error) });
        }
      }
    });
  }


}

async function listShareStoragePools(context: ApiRouteContext): Promise<ShareStoragePool[]> {
  if (!context.system) return [];
  const summary = await collectSystemStorage(context.system);
  const dataRoot = context.config.paths.dataRoot;
  return summary.pools.flatMap((pool) => {
    const expectedPath = path.join(dataRoot, pool.id);
    return pool.mountpoint && path.resolve(pool.mountpoint) === path.resolve(expectedPath)
      ? [{ id: pool.id, path: pool.mountpoint }]
      : [];
  });
}

class ShareAccountUpdateError extends Error {
  constructor(readonly statusCode: 400 | 409 | 502 | 503, message: string) {
    super(message);
    this.name = "ShareAccountUpdateError";
  }
}

function shareProposalSummary(settings: Awaited<ReturnType<typeof normalizeShareSettingsInput>>): string {
  const enabledProtocols = settings.shares.reduce(
    (count, share) =>
      count +
      Number(share.protocols.smb.enabled) +
      Number(share.protocols.webdav.enabled) +
      Number(share.protocols.ftp.enabled) +
      Number(share.protocols.nfs.enabled) +
      Number(share.protocols.dlna.enabled),
    0
  );
  return `Apply share services configuration for ${settings.shares.length} share${settings.shares.length === 1 ? "" : "s"} and ${enabledProtocols} enabled protocol${enabledProtocols === 1 ? "" : "s"}`;
}
