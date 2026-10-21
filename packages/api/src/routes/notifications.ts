import type { FastifyInstance } from "fastify";
import {
  countUnreadBluetoothTransfers,
  countUnreadOperationNotifications,
  expireStaleVmConsoleOperations,
  getMonitoringAlertSummary,
  listBluetoothTransfers,
  listOperationNotifications,
  markAllBluetoothTransfersRead,
  markAllOperationNotificationsRead,
  markBluetoothTransferRead,
  markOperationNotificationRead
} from "@zos/db";
import type { ApiRouteContext } from "../context.js";

export function registerNotificationRoutes(server: FastifyInstance, { db }: ApiRouteContext): void {
  server.get("/api/notifications/summary", async () => {
    const operations = countUnreadOperationNotifications(db);
    const alerts = getMonitoringAlertSummary(db).unreadCount;
    const bluetoothTransfers = countUnreadBluetoothTransfers(db);
    return {
      unreadCount: operations + alerts + bluetoothTransfers,
      operations,
      alerts,
      bluetoothTransfers
    };
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
      unreadCount: countUnreadOperationNotifications(db),
      bluetoothTransfers: listBluetoothTransfers(db, { limit }),
      bluetoothUnreadCount: countUnreadBluetoothTransfers(db)
    });
  });

  server.patch<{
    Params: { id: string };
  }>("/api/notifications/bluetooth/:id/read", async (request, reply) => {
    const transfer = markBluetoothTransferRead(db, request.params.id);
    if (!transfer) {
      reply.status(404).send({ error: "Bluetooth transfer notification not found" });
      return;
    }
    reply.send({
      transfer,
      unreadCount: countUnreadBluetoothTransfers(db)
    });
  });

  server.post("/api/notifications/bluetooth/read-all", async (_request, reply) => {
    reply.send({ updated: markAllBluetoothTransfersRead(db) });
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
