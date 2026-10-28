import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  getFileOperation,
  listFileOperations,
  markFileOperationRolledBack,
  recordAppliedOperation
} from "@cyberos/db";
import type { ApiRouteContext } from "../context.js";
import { restoreTrashEntry, rollbackRegularOperation, rollbackTrashOperation } from "../lib/operations.js";

export function registerOperationRoutes(server: FastifyInstance, { config, db, system }: ApiRouteContext): void {
  server.get("/api/operations", async () => ({
    operations: listFileOperations(db, { limit: 100 })
  }));

  server.post<{
    Params: { id: string };
  }>("/api/trash/:id/restore", async (request, reply) => {
    const { entry, root, restored } = await restoreTrashEntry(db, request.params.id, system);
    const operation = recordAppliedOperation(db, {
      approvalId: null,
      operation: "restore",
      sourcePath: entry.trashPath,
      targetPath: restored.targetPath,
      status: "applied",
      metadata: {
        ...restored.metadata,
        rootId: root.id,
        ...(typeof entry.metadata.storagePoolId === "string"
          ? { storagePoolId: entry.metadata.storagePoolId }
          : {}),
        trashEntryId: entry.id,
        reversible: true
      }
    });

    reply.status(202).send({
      trashEntryId: entry.id,
      operation
    });
  });

  server.post<{
    Params: { id: string };
  }>("/api/operations/:id/rollback", async (request, reply) => {
    const operation = getFileOperation(db, request.params.id);
    if (!operation) {
      reply.status(404).send({ error: "File operation not found" });
      return;
    }
    if (operation.status !== "applied") {
      reply.status(409).send({ error: `Operation is already ${operation.status}` });
      return;
    }

    const trashRootPath = path.join(config.dataDir, "trash");
    try {
      const rolledBack =
        operation.operation === "trash"
          ? await rollbackTrashOperation(db, operation, system)
          : await rollbackRegularOperation(db, operation, trashRootPath, system);

      const rollbackRecord = recordAppliedOperation(db, {
        approvalId: null,
        operation: rolledBack.operation,
        sourcePath: rolledBack.sourcePath,
        targetPath: rolledBack.targetPath,
        status: "applied",
        metadata: {
          ...rolledBack.metadata,
          rollbackAction: true,
          reversible: false
        }
      });
      markFileOperationRolledBack(db, operation.id, {
        ...rolledBack.metadata,
        rollbackOperationId: rollbackRecord.id
      });

      reply.status(202).send({
        operationId: operation.id,
        status: "rolled_back",
        rollbackOperation: rollbackRecord
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = getErrorStatusCode(error, 400);
      reply.status(statusCode).send({ error: message });
    }
  });
}

function getErrorStatusCode(error: unknown, fallback: number): number {
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && ((statusCode >= 400 && statusCode < 500) || statusCode === 503)
    ? statusCode
    : fallback;
}
