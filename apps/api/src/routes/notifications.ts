import type { FastifyInstance } from "fastify";
import {
  countUnreadOperationNotifications,
  expireStaleVmConsoleOperations,
  listOperationNotifications,
  markAllOperationNotificationsRead,
  markOperationNotificationRead,
  getMonitoringAlertSummary
} from "@zos/db";
import type { ApiRouteContext } from "../context.js";

export function registerNotificationRoutes(server: FastifyInstance, { db }: ApiRouteContext): void {
  server.get("/api/notifications/summary", async () => {
    const operations = countUnreadOperationNotifications(db);
    const alerts = getMonitoringAlertSummary(db).unreadCount;
    return { unreadCount: operations + alerts, operations, alerts };
  });
  server.get<{
    Querystring: { limit?: string };
  }>("/api/notifications", async (request, reply) => {
    const limit = request.query.limit === undefined ? 100 : Number.parseInt(request.query.limit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      reply.status(400).send({ error: "Notification limit must be between 1 and 100" });
      return;
    }
    expireStaleVmConsoleOperations(db);
    const notifications = listOperationNotifications(db, { limit });
    reply.send({
      notifications,
      unreadCount: countUnreadOperationNotifications(db)
    });
  });

  server.patch<{
    Params: { id: string };
  }>("/api/notifications/:id/read", async (request, reply) => {
    const notification = markOperationNotificationRead(db, request.params.id);
    if (!notification) {
      reply.status(404).send({ error: "Notification not found" });
      return;
    }
    reply.send({
      notification,
      unreadCount: countUnreadOperationNotifications(db)
    });
  });

  server.post("/api/notifications/read-all", async (_request, reply) => {
    reply.send({ updated: markAllOperationNotificationsRead(db) });
  });
}
