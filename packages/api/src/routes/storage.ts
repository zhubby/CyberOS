import type { FastifyInstance } from "fastify";
import {
  createStorageOperationRecord,
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
      action?: "create_pool" | "delete_pool";
      name?: string;
      raidLevel?: string;
      devices?: string[];
      filesystem?: string;
      poolId?: string;
      confirmation?: string;
      confirm?: boolean;
    };
  }>("/api/storage/actions", async (request, reply) => {
    if ((context.config.hostd.mutationPolicy ?? "mutable") === "declarative") {
      reply.status(501).send({ error: "Persistent storage configuration is managed declaratively on this host" });
      return;
    }
    if (request.body?.confirm !== true) {
      reply.status(400).send({ error: "Storage operation requires explicit confirmation" });
      return;
    }

    try {
      const summary = await collectSystemStorage({
        ...context.system,
        mutationPolicy: context.config.hostd.mutationPolicy ?? "mutable"
      });
      const proposal: StorageOperationProposal = request.body?.action === "delete_pool"
        ? buildStoragePoolDeleteProposal(request.body, summary)
        : buildStoragePoolProposal(request.body ?? {}, summary);
      const operation = createStorageOperationRecord(db, {
        proposal
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
        reply.status(202).send({
          operation: applied
        });
      } catch (error) {
        const message = safeStorageMessage(error);
        updateStorageOperationStatus(db, operation.id, "failed", {
          error: message,
          failedAt: new Date().toISOString()
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
