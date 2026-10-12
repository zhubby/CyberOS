import type { FastifyInstance, FastifyReply } from "fastify";
import { getSystemOperations, isOpsTask } from "@sigmaos/db";
import type { OpsTask, SystemOperationsResponse } from "@sigmaos/shared";
import type { ApiRouteContext } from "../context.js";
import {
  HostdSystemOperationsRuntime,
  safeOperationsMessage,
  SystemOperationsRequestError
} from "../lib/operations-management.js";

const MAX_OPERATIONS_BODY_BYTES = 1024;

export function registerSystemOperationsRoutes(
  server: FastifyInstance,
  context: ApiRouteContext
): void {
  const runtime = context.system?.operations
    ?? new HostdSystemOperationsRuntime(context.config.hostd.socketPath);

  server.get<{ Querystring: { task?: string; limit?: string } }>(
    "/api/system/operations",
    async (request, reply): Promise<SystemOperationsResponse | void> => {
      try {
        const task = parseOptionalTask(request.query.task);
        const limit = parseLimit(request.query.limit);
        return getSystemOperations(context.db, {
          ...(task ? { task } : {}),
          limit
        });
      } catch (error) {
        sendOperationsError(reply, error);
      }
    }
  );

  server.post<{ Params: { task: string }; Body: { confirmed?: boolean } }>(
    "/api/system/operations/:task/run",
    { bodyLimit: MAX_OPERATIONS_BODY_BYTES },
    async (request, reply) => {
      try {
        if (!isOpsTask(request.params.task)) {
          throw new SystemOperationsRequestError("Operation task must be health or maintenance", 400);
        }
        validateRunBody(request.body);
        const confirmed = request.body?.confirmed === true;
        if (request.params.task === "maintenance" && !confirmed) {
          throw new SystemOperationsRequestError("Maintenance confirmation is required", 400);
        }
        reply.status(202).send({
          result: await runtime.run(request.params.task, confirmed)
        });
      } catch (error) {
        sendOperationsError(reply, error);
      }
    }
  );
}

function parseOptionalTask(value: string | undefined): OpsTask | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isOpsTask(value)) {
    throw new SystemOperationsRequestError("Operation task must be health or maintenance", 400);
  }
  return value;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined || value === "") return 50;
  if (!/^\d+$/u.test(value)) {
    throw new SystemOperationsRequestError("Operations limit must be an integer from 1 to 100", 400);
  }
  const limit = Number(value);
  if (limit < 1 || limit > 100) {
    throw new SystemOperationsRequestError("Operations limit must be an integer from 1 to 100", 400);
  }
  return limit;
}

function validateRunBody(body: { confirmed?: boolean } | undefined): void {
  if (body === undefined || body === null) return;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new SystemOperationsRequestError("Invalid operations request", 400);
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "confirmed") || (body.confirmed !== undefined && typeof body.confirmed !== "boolean")) {
    throw new SystemOperationsRequestError("Invalid operations request", 400);
  }
}

function sendOperationsError(reply: FastifyReply, error: unknown): void {
  reply.status(error instanceof SystemOperationsRequestError ? error.statusCode : 503).send({
    error: safeOperationsMessage(error)
  });
}
