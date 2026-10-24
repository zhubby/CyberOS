import type { FastifyInstance } from "fastify";
import { getMonitoringAlertSummary } from "@zos/db";
import { MonitoringValidationError } from "@zos/monitoring";
import type { MonitoringQueryRequest } from "@zos/shared";
import type { ApiRouteContext } from "../context.js";

export function registerMonitoringRoutes(server: FastifyInstance, context: ApiRouteContext): void {
  server.get("/api/monitoring/events", async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    raw.write("retry: 2000\n\n: connected\n\n");
    let closed = false;
    const writeHeartbeat = () => {
      if (!closed && !raw.destroyed) raw.write(": heartbeat\n\n");
    };
    const heartbeat = setInterval(writeHeartbeat, 15_000);
    const unsubscribe = context.monitoringEvents?.subscribe((event) => {
      if (closed || raw.destroyed) return;
      const eventName = event.type === "samples"
        ? "monitoring.samples"
        : event.type === "alert_summary"
          ? "monitoring.alerts"
          : "monitoring.status";
      raw.write(`id: ${event.source}:${event.sequence}\n`);
      raw.write(`event: ${eventName}\n`);
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }) ?? (() => undefined);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
  });

  server.get("/api/monitoring/overview", async () => ({
    ...context.monitoring.overview(),
    alerts: context.db ? getMonitoringAlertSummary(context.db) : {
      unreadCount: 0,
      firingCount: 0,
      alerterStatus: "starting" as const,
      lastEvaluationAt: null,
      pendingDeliveries: 0
    }
  }));
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
