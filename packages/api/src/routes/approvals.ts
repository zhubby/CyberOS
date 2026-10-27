import type { FastifyInstance } from "fastify";
import {
  capabilityRunSecretRequirements,
  executeApprovedCapabilityRun,
  executeStartedSecretCapabilityRun,
  validateCapabilitySecretInput
} from "@zos/capability-runtime";
import {
  decideCapabilityApproval,
  deleteCapabilityRunPayload,
  expireCapabilityApprovals,
  getAgentCapabilityApproval,
  listPendingAgentCapabilityApprovals
} from "@zos/db";
import type { ApiRouteContext } from "../context.js";

export function registerApprovalRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  const { config, db } = context;
  const capabilityRuntime = context.capabilityRuntime ?? { db, config };

  server.get<{
    Querystring: { sessionId?: string };
  }>("/api/approvals", async (request, reply) => {
    if (!request.query.sessionId) {
      reply.status(400).send({ error: "sessionId is required" });
      return;
    }
    expireCapabilityApprovals(db);
    return {
      capabilityApprovals: listPendingAgentCapabilityApprovals(db, {
        sessionId: request.query.sessionId
      })
    };
  });

  server.post<{
    Params: { id: string };
    Body: {
      sessionId?: string;
      decision?: "approved" | "rejected";
      expectedRevision?: number;
      confirmed?: boolean;
      secretInput?: Record<string, string>;
    };
  }>("/api/capability-approvals/:id/decision", async (request, reply) => {
    const sessionId = request.body?.sessionId;
    const decision = request.body?.decision;
    const expectedRevision = request.body?.expectedRevision;
    if (!sessionId || (decision !== "approved" && decision !== "rejected") || !Number.isInteger(expectedRevision)) {
      reply.status(400).send({ error: "sessionId, a valid decision, and expectedRevision are required" });
      return;
    }

    const approval = getAgentCapabilityApproval(db, request.params.id);
    if (!approval || approval.sessionId !== sessionId) {
      reply.status(404).send({ error: "Agent approval not found" });
      return;
    }

    const secretRequirements = capabilityRunSecretRequirements(capabilityRuntime, approval.run.id);
    let secretInput: Readonly<Record<string, string>> = {};
    if (decision === "approved") {
      try {
        secretInput = validateCapabilitySecretInput(
          capabilityRunSecretRequirements(capabilityRuntime, approval.run.id),
          request.body?.secretInput
        );
      } catch (error) {
        reply.status(400).send({
          error: error instanceof Error ? error.message : "Required secret input is invalid",
          code: "SECRET_INPUT_REQUIRED"
        });
        return;
      }
    }

    const decided = decideCapabilityApproval(db, {
      approvalId: approval.id,
      expectedRevision: expectedRevision!,
      decision,
      decidedBy: "local-admin",
      confirmed: request.body?.confirmed === true,
      startRunning: decision === "approved" && secretRequirements.length > 0
    });
    if (!decided) {
      reply.status(409).send({ error: "Approval changed, expired, or requires explicit confirmation" });
      return;
    }

    if (decision === "approved") {
      if (secretRequirements.length === 0) {
        setImmediate(() => {
          void executeApprovedCapabilityRun(capabilityRuntime, decided.run.id).catch((error) => {
            server.log.error({ err: error, runId: decided.run.id }, "Capability run execution failed");
          });
        });
        reply.status(202).send(decided);
        return;
      }
      const run = await executeStartedSecretCapabilityRun(capabilityRuntime, decided.run.id, secretInput);
      if (run.state === "failed" || run.state === "cancelled" || run.state === "expired") {
        reply.status(422).send({
          error: run.errorMessage ?? "Approved Agent capability failed",
          ...(run.errorCode ? { code: run.errorCode } : {}),
          ...decided,
          run
        });
        return;
      }
      reply.status(run.state === "succeeded" ? 200 : 202).send({ ...decided, run });
      return;
    }

    deleteCapabilityRunPayload(db, decided.run.id);
    reply.status(200).send(decided);
  });
}
