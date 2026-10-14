import type { FastifyInstance } from "fastify";
import {
  appendEvent,
  createStorageOperationRecord,
  createActionMessageAndJob,
  getJob,
  getSession,
  updateJobStatus,
  updateStorageOperationStatus
} from "@zos/db";
import type { StorageOperationProposal } from "@zos/shared";
import type { ApiRouteContext } from "../context.js";
import {
  applyStoragePoolOperation,
  buildStoragePoolDeleteProposal,
  buildStoragePoolProposal
} from "../lib/storage-service.js";
import { collectSystemStorage } from "../lib/system-management.js";

export function registerStorageRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { db } = context;

  server.post<{
    Body: {
      sessionId?: string;
      action?: "create_pool" | "delete_pool";
      name?: string;
      raidLevel?: string;
      devices?: string[];
      filesystem?: string;
      poolId?: string;
      confirmation?: string;
      confirm?: boolean;
    };
  }>("/api/storage/proposals", async (request, reply) => {
    const session = getSession(db, request.body?.sessionId ?? "");
    if (!session) {
      reply.status(404).send({ error: "Session not found" });
      return;
    }
    if (request.body?.confirm !== true) {
      reply.status(400).send({ error: "Storage operation requires explicit confirmation" });
      return;
    }

    try {
      const summary = await collectSystemStorage(context.system);
      const proposal: StorageOperationProposal = request.body?.action === "delete_pool"
        ? buildStoragePoolDeleteProposal(request.body, summary)
        : buildStoragePoolProposal(request.body ?? {}, summary);
      const { message, job } = createActionMessageAndJob(db, {
        sessionId: session.id,
        content: proposal.summary,
        kind: "storage",
        status: "running"
      });
      const operation = createStorageOperationRecord(db, {
        jobId: job.id,
        proposal
      });
      appendEvent(db, {
        sessionId: session.id,
        jobId: job.id,
        type: "job.running",
        payload: {
          jobId: job.id,
          storageOperation: operation
        }
      });

      try {
        const metadata = await applyStoragePoolOperation(context.config.hostd.socketPath, proposal);
        const applied = updateStorageOperationStatus(db, operation.id, "applied", {
          ...metadata,
          appliedAt: new Date().toISOString()
        });
        if (!applied) {
          throw new Error("Storage operation record disappeared before completion");
        }
        updateJobStatus(db, job.id, "completed", null, ["running"]);
        appendEvent(db, {
          sessionId: session.id,
          jobId: job.id,
          type: "job.completed",
          payload: {
            jobId: job.id,
            storageOperation: applied
          }
        });
        reply.status(202).send({
          message,
          job: getJob(db, job.id) ?? job,
          operation: applied
        });
      } catch (error) {
        const message = safeStorageMessage(error);
        const failed = updateStorageOperationStatus(db, operation.id, "failed", {
          error: message,
          failedAt: new Date().toISOString()
        });
        updateJobStatus(db, job.id, "failed", message, ["running"]);
        appendEvent(db, {
          sessionId: session.id,
          jobId: job.id,
          type: "job.failed",
          payload: {
            jobId: job.id,
            error: message,
            storageOperation: failed
          }
        });
        reply.status(400).send({ error: message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.status(400).send({ error: message });
    }
  });
}

function safeStorageMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/password["']?\s*[:=]\s*["'][^"']+["']/giu, "password: [redacted]");
}
