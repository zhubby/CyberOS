import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { openZosDb } from "@zos/db";
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
    expect(summary.json()).toEqual({ unreadCount: 1, operations: 0, alerts: 1 });

    const operations = await server.inject({ method: "GET", url: "/api/notifications" });
    expect(operations.json()).toEqual({ notifications: [], unreadCount: 0 });
    await server.close();
  });
});
