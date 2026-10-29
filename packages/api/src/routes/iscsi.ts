import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createOperationNotification, updateOperationNotificationForOperation } from "@cyberos/db";
import { parseIscsiSummary, type IscsiAction, type IscsiSummary } from "@cyberos/shared";
import type { ApiRouteContext } from "../context.js";
import { HostdRequestError } from "../lib/hostd-client.js";
import { HostdIscsiRuntime, publicIscsiError, validateIscsiAction, type IscsiRuntime } from "../lib/iscsi-manager.js";

export function registerIscsiRoutes(server: FastifyInstance, context: ApiRouteContext, dependency?: IscsiRuntime): void {
  const runtime = dependency ?? new HostdIscsiRuntime(context.config.hostd.socketPath);
  server.get("/api/storage/iscsi", async (_request, reply) => {
    try {
      reply.send({ summary: publicSnapshot(await runtime.read()) });
    } catch (error) {
      const failure = publicIscsiError(error);
      reply.status(failure.status).send({ error: failure.message, code: failure.code });
    }
  });

  server.post<{ Body: unknown }>("/api/storage/iscsi/actions", async (request, reply) => {
    const input = validateIscsiAction(request.body);
    if (!input) {
      reply.status(400).send({ error: "A confirmed iSCSI action with valid fields and a current revision is required", code: "validation" });
      return;
    }
    const operationId = randomUUID();
    createOperationNotification(context.db, {
      operationId, kind: "storage", status: "running", summary: operationSummary(input.action)
    });
    try {
      const summary = publicSnapshot(await runtime.mutate(input));
      updateOperationNotificationForOperation(context.db, { operationId, status: "succeeded" });
      reply.send({ summary });
    } catch (error) {
      const failure = publicIscsiError(error);
      updateOperationNotificationForOperation(context.db, { operationId, status: "failed", error: failure.message });
      reply.status(failure.status).send({ error: failure.message, code: failure.code });
    }
  });
}

function publicSnapshot(value: IscsiSummary): IscsiSummary {
  const summary = parseIscsiSummary(value);
  if (!summary) throw new HostdRequestError("Invalid iSCSI response", 502, "protocol_error");
  return summary;
}

function operationSummary(action: IscsiAction["action"]): string {
  const labels: Record<IscsiAction["action"], string> = {
    create_target: "Create iSCSI target", update_target: "Update iSCSI target access",
    set_target_enabled: "Change iSCSI target state", delete_target: "Delete iSCSI target",
    create_lun: "Create iSCSI disk", attach_lun: "Attach iSCSI disk", detach_lun: "Remove iSCSI LUN",
    destroy_image: "Destroy retained iSCSI disk"
  };
  return labels[action];
}
