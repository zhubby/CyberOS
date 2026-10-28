import type { FastifyInstance } from "fastify";
import { PathSafetyError } from "@cyberos/storage-tools";

export function registerErrorHandler(server: FastifyInstance): void {
  server.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof PathSafetyError) {
      reply.status(400).send({ error: error.message });
      return;
    }

    const filesystemError = error as NodeJS.ErrnoException;
    if (filesystemError.code === "ENOENT" || filesystemError.code === "ENOTDIR") {
      reply.status(404).send({ error: "Path not found" });
      return;
    }
    if (filesystemError.code === "EACCES" || filesystemError.code === "EPERM") {
      reply.status(403).send({ error: "Path is not accessible" });
      return;
    }

    const fastifyError = error as { statusCode?: number; message?: string };
    const exposedError = error as { expose?: boolean };
    const statusCode =
      fastifyError.statusCode && fastifyError.statusCode >= 400 ? fastifyError.statusCode : 500;
    reply.status(statusCode).send({
      error: statusCode >= 500 && !exposedError.expose ? "Internal server error" : fastifyError.message
    });
  });
}
