import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { createBluetoothSendTransfers, ensureNasRoots, openZosDb } from "@zos/db";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiRouteContext } from "../context.js";
import { registerNotificationRoutes } from "./notifications.js";

let tempDirectory: string | null = null;

afterEach(async () => {
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  tempDirectory = null;
});

describe("notification routes", () => {
  it("adds unread alert incidents to the combined summary without changing the operation list", async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "zos-notifications-"));
    const db = openZosDb(path.join(tempDirectory, "zos.sqlite"));
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO monitoring_alert_incidents(
        id, source, series_key, status, severity, title, firing_at,
        rule_snapshot_json, created_at, updated_at
      ) VALUES ('incident-1', 'system', 'monitor-stale', 'firing', 'critical',
        'Monitor stale', ?, '{}', ?, ?)
    `).run(now, now, now);

    const server = Fastify({ logger: false });
    registerNotificationRoutes(server, { db } as ApiRouteContext);
    server.addHook("onClose", async () => db.close());

    const summary = await server.inject({ method: "GET", url: "/api/notifications/summary" });
    expect(summary.json()).toEqual({
      unreadCount: 1,
      operations: 0,
      alerts: 1,
      bluetoothTransfers: 0
    });

    const operations = await server.inject({ method: "GET", url: "/api/notifications" });
    expect(operations.json()).toEqual({
      notifications: [],
      unreadCount: 0,
      bluetoothTransfers: [],
      bluetoothUnreadCount: 0
    });
    await server.close();
  });

  it("includes persistent Bluetooth transfers and reads them independently", async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "zos-notifications-"));
    const db = openZosDb(path.join(tempDirectory, "zos.sqlite"));
    ensureNasRoots(db, [{ id: "local", name: "Local", path: tempDirectory }]);
    const [transfer] = createBluetoothSendTransfers(db, {
      adapterId: "adapter-hci0",
      deviceAddress: "AA:BB:CC:DD:EE:FF",
      rootId: "local",
      storagePoolId: "/dev/md0",
      files: [{ relativePath: "photo.jpg", displayName: "photo.jpg", totalBytes: 128 }]
    });
    const server = Fastify({ logger: false });
    registerNotificationRoutes(server, { db } as ApiRouteContext);
    server.addHook("onClose", async () => db.close());

    const list = await server.inject({ method: "GET", url: "/api/notifications" });
    expect(list.json()).toMatchObject({
      unreadCount: 0,
      bluetoothUnreadCount: 1,
      bluetoothTransfers: [{ id: transfer!.id, status: "queued" }]
    });
    expect((await server.inject({ method: "GET", url: "/api/notifications/summary" })).json())
      .toMatchObject({ unreadCount: 1, bluetoothTransfers: 1 });

    const read = await server.inject({
      method: "PATCH",
      url: `/api/notifications/bluetooth/${transfer!.id}/read`
    });
    expect(read.json()).toMatchObject({ transfer: { readAt: expect.any(String) }, unreadCount: 0 });
    await server.close();
  });
});
