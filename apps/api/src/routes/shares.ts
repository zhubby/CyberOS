import type { FastifyInstance } from "fastify";
import {
  appendEvent,
  createShareOperationApproval,
  createActionMessageAndJob,
  getSession,
  getShareSettings,
  listNasRoots,
  saveShareSettings
} from "@zos/db";
import type { ShareOperationProposal } from "@zos/shared";
import type { ApiRouteContext } from "../context.js";
import { HostdRequestError } from "../lib/hostd-client.js";
import { normalizeShareSettingsInput, type ShareSettingsInput } from "../lib/share-settings.js";
import {
  applyShareSettings,
  collectShareSummary,
  safeShareMessage,
  serializeShareMutation,
  toPublicShareOperation
} from "../lib/share-service.js";
import { defaultShareSettings, toPublicShareSettings } from "../lib/settings.js";

export function registerShareRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { config, db } = context;

  server.get("/api/shares/summary", async () => {
    const settings = getShareSettings(db) ?? defaultShareSettings(config);
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

        const existing = getShareSettings(db) ?? defaultShareSettings(config);
        if (existing.updatedAt !== expectedUpdatedAt) {
          throw new ShareAccountUpdateError(409, "Share settings changed; reload before saving the account");
        }
        const roots = listNasRoots(db);
        let settings;
        try {
          settings = await normalizeShareSettingsInput({
            account: {
              username,
              ...(password ? { password } : {})
            }
          }, existing, roots);
        } catch (error) {
          throw new ShareAccountUpdateError(400, safeShareMessage(error));
        }

        let applied;
        try {
          applied = await applyShareSettings(config, settings, roots, context.shares);
        } catch (error) {
          const statusCode = error instanceof HostdRequestError && error.statusCode === 503 ? 503 : 502;
          throw new ShareAccountUpdateError(statusCode, safeShareMessage(error));
        }

        const { updatedAt: _normalizedAt, ...settingsToSave } = settings;
        const saved = saveShareSettings(db, settingsToSave);
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
      sessionId?: string;
      settings?: ShareSettingsInput;
    };
  }>("/api/shares/proposals", async (request, reply) => {
    const session = getSession(db, request.body?.sessionId ?? "");
    if (!session) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }

    const existing = getShareSettings(db) ?? defaultShareSettings(config);
    const roots = listNasRoots(db);
    try {
      const settings = await normalizeShareSettingsInput(request.body?.settings, existing, roots);
      const publicSettings = toPublicShareSettings(settings);
      const proposal: ShareOperationProposal = {
        action: "apply_settings",
        risk: "high",
        summary: shareProposalSummary(settings),
        settings: publicSettings
      };
      const { message, job } = createActionMessageAndJob(db, {
        sessionId: session.id,
        content: proposal.summary,
        kind: "share",
        status: "waiting_approval"
      });
      const { approval, operation } = createShareOperationApproval(db, {
        jobId: job.id,
        proposal,
        settings
      });
      appendEvent(db, {
        sessionId: session.id,
        jobId: job.id,
        type: "approval.pending",
        payload: {
          approvalId: approval.id,
          proposal: approval.proposal,
          summary: `Created share approval ${approval.id}: ${proposal.summary}. No share service was changed.`
        }
      });

      reply.status(202).send({
        message,
        job,
        approval,
        operation: toPublicShareOperation(operation)
      });
    } catch (error) {
      reply.status(400).send({ error: safeShareMessage(error) });
    }
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
