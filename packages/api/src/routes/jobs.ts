import type { FastifyInstance } from "fastify";
import { appendEvent, getJob, updateJobStatus } from "@zos/db";
import type { ApiRouteContext } from "../context.js";

export function registerJobRoutes(server: FastifyInstance, { db }: ApiRouteContext): void {
  server.post<{
    Params: { id: string };
  }>("/api/jobs/:id/cancel", async (request, reply) => {
    const job = getJob(db, request.params.id);
    if (!job) {
      reply.status(404).send({ error: "Job not found" });
      return;
    }

    if (job.status === "cancelled") {
      reply.status(200).send({ status: "cancelled" });
      return;
    }

    if (!updateJobStatus(db, request.params.id, "cancelled", null, ["queued", "running", "waiting_approval"])) {
      reply.status(409).send({
        error: `Job is already ${job.status}`,
        status: job.status
      });
      return;
    }

    appendEvent(db, {
      sessionId: job.sessionId,
      jobId: request.params.id,
      type: "job.cancelled",
      payload: {
        jobId: request.params.id
      }
    });
    reply.status(202).send({ status: "cancelled" });
  });
}
