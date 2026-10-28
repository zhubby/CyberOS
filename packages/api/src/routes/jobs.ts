import type { FastifyInstance } from "fastify";
import { appendEvent, createUserMessageAndJob, getJob, updateJobStatus } from "@cyberos/db";
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

  server.post<{
    Params: { id: string };
    Body: { idempotencyKey?: string };
  }>("/api/jobs/:id/retry", async (request, reply) => {
    const job = getJob(db, request.params.id);
    if (!job) {
      reply.status(404).send({ error: "Job not found" });
      return;
    }
    if (job.status !== "failed" || job.errorCode !== "WORKER_INTERRUPTED") {
      reply.status(409).send({ error: "Only interrupted Agent jobs can be retried" });
      return;
    }
    const idempotencyKey = request.body?.idempotencyKey?.trim() || `retry:${job.id}`;
    const result = createUserMessageAndJob(db, {
      sessionId: job.sessionId,
      content: "Continue from the interrupted turn using the persisted Pi session. Do not repeat actions that already completed.",
      workingPath: job.workingPath,
      commandIdempotencyKey: idempotencyKey
    });
    reply.status(202).send({
      job: result.job,
      command: result.command,
      transcriptMessage: {
        id: `message:${result.message.id}`,
        role: "user",
        content: result.message.content,
        createdAt: result.message.createdAt,
        sequence: result.transcriptSequence
      }
    });
  });
}
