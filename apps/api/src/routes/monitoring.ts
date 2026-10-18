import type { FastifyInstance } from "fastify";
import { MonitoringValidationError } from "@zos/monitoring";
import type { MonitoringQueryRequest } from "@zos/shared";
import type { ApiRouteContext } from "../context.js";

export function registerMonitoringRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  server.get("/api/monitoring/overview", async () => context.monitoring.overview());
  server.get("/api/monitoring/catalog", async () => context.monitoring.catalog());
  server.post<{ Body: MonitoringQueryRequest }>("/api/monitoring/query", async (request, reply) => {
    try {
      reply.send(context.monitoring.query(request.body));
    } catch (error) {
      if (error instanceof MonitoringValidationError) {
        reply.status(400).send({ error: error.message });
        return;
      }
      throw error;
    }
  });
}
