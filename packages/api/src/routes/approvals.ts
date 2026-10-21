import type { FastifyInstance } from "fastify";
import { executeApprovedCapabilityRun } from "@zos/capability-runtime";
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
    Body: { sessionId?: string; decision?: "approved" | "rejected"; expectedRevision?: number; confirmed?: boolean };
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

    const decided = decideCapabilityApproval(db, {
      approvalId: approval.id,
      expectedRevision: expectedRevision!,
      decision,
      decidedBy: "local-admin",
      confirmed: request.body?.confirmed === true
    });
    if (!decided) {
      reply.status(409).send({ error: "Approval changed, expired, or requires explicit confirmation" });
      return;
    }

    if (decision === "approved") {
      const run = await executeApprovedCapabilityRun({ db, config }, decided.run.id);
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
