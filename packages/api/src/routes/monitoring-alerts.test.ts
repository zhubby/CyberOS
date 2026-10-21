import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { openZosDb } from "@zos/db";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiRouteContext } from "../context.js";
import { registerMonitoringAlertRoutes } from "./monitoring-alerts.js";

let tempDirectory: string | null = null;

afterEach(async () => {
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  tempDirectory = null;
});

describe("monitoring alert routes", () => {
  it("creates validated rules and rejects counter value rules", async () => {
    const server = await buildRoutes();
    const created = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/rules",
      payload: validRule()
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().rule).toMatchObject({ revision: 1, metric: "zos_host_cpu_usage_ratio" });

    const invalidCounter = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/rules",
      payload: { ...validRule(), metric: "zos_host_network_receive_bytes_total", transform: "value" }
    });
    expect(invalidCounter.statusCode).toBe(400);
    await server.close();
  });

  it("uses optimistic revisions for configuration resources", async () => {
    const server = await buildRoutes();
    const rule = (await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/rules",
      payload: validRule()
    })).json().rule;
    const update = await server.inject({
      method: "PATCH",
      url: `/api/monitoring/alerts/rules/${rule.id}`,
      payload: { expectedRevision: 1, rule: { ...validRule(), name: "CPU sustained" } }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().rule.revision).toBe(2);
    const conflict = await server.inject({
      method: "PATCH",
      url: `/api/monitoring/alerts/rules/${rule.id}`,
      payload: { expectedRevision: 1, rule: validRule() }
    });
    expect(conflict.statusCode).toBe(409);
    await server.close();
  });

  it("returns persisted rule evaluation failures", async () => {
    const { server, db } = await buildRoutesWithDb();
    const rule = (await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/rules",
      payload: validRule()
    })).json().rule;
    db.prepare(`
      UPDATE monitoring_alert_rules
      SET evaluation_error = 'Alert rule expands beyond 64 series',
        last_evaluated_at = '2026-03-10T00:00:00.000Z'
      WHERE id = ?
    `).run(rule.id);

    const response = await server.inject({ method: "GET", url: "/api/monitoring/alerts/rules" });
    expect(response.json().rules).toContainEqual(expect.objectContaining({
      id: rule.id,
      evaluationError: "Alert rule expands beyond 64 series",
      lastEvaluatedAt: "2026-03-10T00:00:00.000Z"
    }));
    await server.close();
  });

  it("marks the alerter unavailable when its last evaluation is stale", async () => {
    const { server, db } = await buildRoutesWithDb();
    db.prepare(`
      UPDATE monitoring_alerter_state
      SET status = 'ready', last_evaluation_at = '2026-01-01T00:00:00.000Z'
      WHERE id = 1
    `).run();

    const response = await server.inject({
      method: "GET",
      url: "/api/monitoring/alerts/summary"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      alerterStatus: "unavailable",
      lastEvaluationAt: "2026-01-01T00:00:00.000Z"
    });
    await server.close();
  });

  it("never returns the SMTP password and queues tests through the outbox", async () => {
    const server = await buildRoutes();
    const saved = await server.inject({
      method: "PATCH",
      url: "/api/monitoring/alerts/smtp",
      payload: {
        expectedRevision: 1,
        smtp: {
          enabled: true,
          host: "smtp.internal",
          port: 587,
          security: "starttls",
          username: "zos",
          password: "secret-value",
          from: "zos@example.test"
        }
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("secret-value");
    expect(saved.json().smtp).toMatchObject({ credentialConfigured: true, revision: 2 });

    const queued = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/test-email",
      payload: { recipient: "operator@example.test" }
    });
    expect(queued.statusCode).toBe(202);
    const delivery = await server.inject({
      method: "GET",
      url: `/api/monitoring/alerts/deliveries/${queued.json().deliveryId}`
    });
    expect(delivery.json().delivery).toMatchObject({ kind: "test", status: "pending" });
    await server.close();
  });

  it("rejects test email while SMTP delivery is disabled", async () => {
    const server = await buildRoutes();

    const response = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/test-email",
      payload: { recipient: "operator@example.test" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "SMTP delivery is disabled or incomplete" });
    await server.close();
  });

  it("rejects test email when the outbox reaches its pending limit", async () => {
    const { server, db } = await buildRoutesWithDb();
    const smtp = await server.inject({
      method: "PATCH",
      url: "/api/monitoring/alerts/smtp",
      payload: {
        expectedRevision: 1,
        smtp: {
          enabled: true,
          host: "smtp.internal",
          port: 587,
          security: "starttls",
          username: "zos",
          password: "secret-value",
          from: "zos@example.test"
        }
      }
    });
    expect(smtp.statusCode).toBe(200);
    const now = new Date().toISOString();
    db.prepare(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 10000
      )
      INSERT INTO monitoring_alert_deliveries(
        id, incident_id, kind, idempotency_key, message_id, recipients_json, subject, body_text,
        status, attempt_count, due_at, created_at, updated_at
      )
      SELECT 'capacity-' || value, NULL, 'test', 'capacity-key-' || value,
        '<capacity-' || value || '@localhost>', '["operator@example.test"]', 'Alert', 'Alert',
        'pending', 0, ?, ?, ? FROM sequence
    `).run(now, now, now);

    const response = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/test-email",
      payload: { recipient: "operator@example.test" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Alert delivery queue is full" });
    await server.close();
  });

  it("acknowledges incidents separately from read state and cancels queued delivery", async () => {
    const { server, db } = await buildRoutesWithDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO monitoring_alert_incidents(
        id, source, series_key, status, severity, title, firing_at,
        rule_snapshot_json, created_at, updated_at
      ) VALUES ('incident-1', 'system', 'monitor-stale', 'firing', 'critical',
        'Monitor stale', ?, '{}', ?, ?)
    `).run(now, now, now);
    db.prepare(`
      INSERT INTO monitoring_alert_deliveries(
        id, incident_id, kind, idempotency_key, message_id, recipients_json,
        subject, body_text, status, attempt_count, due_at, created_at, updated_at
      ) VALUES ('delivery-1', 'incident-1', 'firing', 'incident-1:0', '<incident-1@localhost>',
        '["operator@example.test"]', 'Alert', 'Alert', 'pending', 0, ?, ?, ?)
    `).run(now, now, now);

    const acknowledged = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/incidents/incident-1/acknowledge"
    });
    expect(acknowledged.json().incident).toMatchObject({
      acknowledgedAt: expect.any(String),
      readAt: null,
      status: "firing"
    });
    expect(db.prepare("SELECT status FROM monitoring_alert_deliveries WHERE id = 'delivery-1'").pluck().get())
      .toBe("cancelled");
    await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/incidents/incident-1/acknowledge"
    });
    expect(db.prepare(`
      SELECT COUNT(*) FROM monitoring_alert_incident_events
      WHERE incident_id = 'incident-1' AND type = 'acknowledged'
    `).pluck().get()).toBe(1);
    const detail = await server.inject({
      method: "GET",
      url: "/api/monitoring/alerts/incidents/incident-1"
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      incident: { id: "incident-1" },
      ruleSnapshot: {},
      policySnapshot: null,
      events: expect.arrayContaining([expect.objectContaining({ type: "acknowledged" })]),
      deliveries: [expect.objectContaining({ id: "delivery-1", status: "cancelled" })]
    });
    await server.close();
  });

  it("marks every unread incident in one transaction", async () => {
    const { server, db } = await buildRoutesWithDb();
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO monitoring_alert_incidents(
        id, source, series_key, status, severity, title, firing_at,
        rule_snapshot_json, created_at, updated_at
      ) VALUES (?, 'system', ?, 'firing', 'warning', 'System alert', ?, '{}', ?, ?)
    `);
    insert.run("incident-read-1", "system-1", now, now, now);
    insert.run("incident-read-2", "system-2", now, now, now);

    const response = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/incidents/read-all"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ updated: 2 });
    expect(db.prepare("SELECT COUNT(*) FROM monitoring_alert_incidents WHERE read_at IS NULL").pluck().get())
      .toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM monitoring_alert_incident_events WHERE type = 'read'").pluck().get())
      .toBe(2);
    await server.close();
  });

  it("groups repeated health episodes and reads the group together", async () => {
    const { server, db } = await buildRoutesWithDb();
    const insert = db.prepare(`
      INSERT INTO monitoring_alert_incidents(
        id, source, series_key, status, severity, title, firing_at, resolved_at,
        close_reason, rule_snapshot_json, created_at, updated_at
      ) VALUES (?, 'health', 'indexer_unavailable:system', 'resolved', 'warning',
        'Health: indexer_unavailable', ?, ?, 'health_resolved', '{}', ?, ?)
    `);
    insert.run(
      "health-episode-1",
      "2026-03-10T00:00:00.000Z",
      "2026-03-10T00:05:00.000Z",
      "2026-03-10T00:00:00.000Z",
      "2026-03-10T00:05:00.000Z"
    );
    insert.run(
      "health-episode-2",
      "2026-03-10T01:00:00.000Z",
      "2026-03-10T01:05:00.000Z",
      "2026-03-10T01:00:00.000Z",
      "2026-03-10T01:05:00.000Z"
    );
    const insertFired = db.prepare(`
      INSERT INTO monitoring_alert_incident_events(incident_id, type, details_json, created_at)
      VALUES (?, 'fired', ?, ?)
    `);
    insertFired.run("health-episode-1", "{}", "2026-03-10T00:00:00.000Z");
    insertFired.run("health-episode-2", "{}", "2026-03-10T01:00:00.000Z");
    insertFired.run("health-episode-2", JSON.stringify({ reopened: true }), "2026-03-10T01:02:00.000Z");

    const grouped = await server.inject({
      method: "GET",
      url: "/api/monitoring/alerts/incidents?groupHealth=true"
    });
    expect(grouped.statusCode).toBe(200);
    expect(grouped.json().incidents).toEqual([
      expect.objectContaining({ id: "health-episode-2", occurrenceCount: 3 })
    ]);
    expect((await server.inject({ method: "GET", url: "/api/monitoring/alerts/summary" })).json().unreadCount)
      .toBe(1);

    await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/incidents/health-episode-2/read"
    });
    expect(db.prepare(`
      SELECT COUNT(*) FROM monitoring_alert_incidents
      WHERE series_key = 'indexer_unavailable:system' AND read_at IS NULL
    `).pluck().get()).toBe(0);
    expect((await server.inject({ method: "GET", url: "/api/monitoring/alerts/summary" })).json().unreadCount)
      .toBe(0);
    await server.close();
  });

  it("cancels queued delivery transactionally and retains an ended silence", async () => {
    const { server, db } = await buildRoutesWithDb();
    const rule = (await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/rules",
      payload: validRule()
    })).json().rule;
    const now = new Date();
    const startsAt = new Date(now.getTime() - 60_000).toISOString();
    const endsAt = new Date(now.getTime() + 60_000).toISOString();
    const timestamp = now.toISOString();
    db.prepare(`
      INSERT INTO monitoring_alert_incidents(
        id, source, rule_id, series_key, status, severity, title, firing_at,
        rule_snapshot_json, created_at, updated_at
      ) VALUES ('incident-silenced', 'metric', ?, 'series-a', 'firing', 'warning',
        'High CPU', ?, '{}', ?, ?)
    `).run(rule.id, timestamp, timestamp, timestamp);
    db.prepare(`
      INSERT INTO monitoring_alert_deliveries(
        id, incident_id, kind, idempotency_key, message_id, recipients_json,
        subject, body_text, status, attempt_count, due_at, created_at, updated_at
      ) VALUES ('delivery-silenced', 'incident-silenced', 'firing', 'incident-silenced:0',
        '<incident-silenced@localhost>', '["operator@example.test"]', 'Alert', 'Alert',
        'pending', 0, ?, ?, ?)
    `).run(timestamp, timestamp, timestamp);

    const created = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/silences",
      payload: {
        ruleId: rule.id,
        seriesKey: "series-a",
        startsAt,
        endsAt,
        reason: "Investigating"
      }
    });
    expect(created.statusCode).toBe(201);
    expect(db.prepare("SELECT status FROM monitoring_alert_deliveries WHERE id = 'delivery-silenced'").pluck().get())
      .toBe("cancelled");
    expect(db.prepare(`
      SELECT type FROM monitoring_alert_incident_events
      WHERE incident_id = 'incident-silenced' ORDER BY id DESC LIMIT 1
    `).pluck().get()).toBe("silenced");

    const silence = created.json().silence;
    const deleted = await server.inject({
      method: "DELETE",
      url: `/api/monitoring/alerts/silences/${silence.id}?expectedRevision=${silence.revision}`
    });
    expect(deleted.statusCode).toBe(204);
    expect(db.prepare("SELECT cancelled_at FROM monitoring_alert_silences WHERE id = ?").pluck().get(silence.id))
      .toEqual(expect.any(String));
    expect(db.prepare(`
      SELECT details_json FROM monitoring_alert_incident_events
      WHERE incident_id = 'incident-silenced' AND type = 'unsilenced'
    `).pluck().get()).toBe(JSON.stringify({ silenceId: silence.id }));
    const listed = await server.inject({ method: "GET", url: "/api/monitoring/alerts/silences" });
    expect(listed.json().silences).toEqual([]);
    await server.close();
  });

  it("rejects invalid on-call timezones and anchor weekdays", async () => {
    const server = await buildRoutes();
    const invalidZone = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/schedules",
      payload: {
        name: "Primary",
        timezone: "Not/A_Zone",
        handoffWeekday: 1,
        handoffTime: "09:00",
        anchorDate: "2026-03-02",
        contactIds: ["missing"]
      }
    });
    expect(invalidZone.statusCode).toBe(400);
    const mismatchedWeekday = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/schedules",
      payload: {
        name: "Primary",
        timezone: "Asia/Shanghai",
        handoffWeekday: 2,
        handoffTime: "09:00",
        anchorDate: "2026-03-02",
        contactIds: ["missing"]
      }
    });
    expect(mismatchedWeekday.statusCode).toBe(400);
    await server.close();
  });

  it("rejects missing aggregate references instead of surfacing SQLite errors", async () => {
    const server = await buildRoutes();
    const schedule = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/schedules",
      payload: {
        name: "Primary",
        timezone: "Asia/Shanghai",
        handoffWeekday: 1,
        handoffTime: "09:00",
        anchorDate: "2026-03-02",
        contactIds: ["missing-contact"]
      }
    });
    expect(schedule.statusCode).toBe(400);
    expect(schedule.json()).toEqual({ error: "Contact not found" });

    const policy = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/policies",
      payload: {
        name: "Primary escalation",
        enabled: true,
        stages: [{
          delaySeconds: 0,
          repeatIntervalSeconds: null,
          repeatCount: 0,
          targets: [{ type: "group", id: "missing-group" }]
        }]
      }
    });
    expect(policy.statusCode).toBe(400);
    expect(policy.json()).toEqual({ error: "Escalation target not found" });
    await server.close();
  });

  it("rejects deletion while alert configuration resources are referenced", async () => {
    const server = await buildRoutes();
    const contact = (await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/contacts",
      payload: { name: "Primary operator", email: "operator@example.test", enabled: true }
    })).json().contact;
    const group = (await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/groups",
      payload: { name: "Operators", contactIds: [contact.id] }
    })).json().group;
    const schedule = (await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/schedules",
      payload: {
        name: "Primary",
        timezone: "Asia/Shanghai",
        handoffWeekday: 1,
        handoffTime: "09:00",
        anchorDate: "2026-03-02",
        contactIds: [contact.id]
      }
    })).json().schedule;
    const policy = (await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/policies",
      payload: {
        name: "Primary escalation",
        enabled: true,
        stages: [{
          delaySeconds: 0,
          repeatIntervalSeconds: null,
          repeatCount: 0,
          targets: [
            { type: "contact", id: contact.id },
            { type: "group", id: group.id },
            { type: "oncall", id: schedule.id }
          ]
        }]
      }
    })).json().policy;
    const rule = await server.inject({
      method: "POST",
      url: "/api/monitoring/alerts/rules",
      payload: { ...validRule(), escalationPolicyId: policy.id }
    });
    expect(rule.statusCode).toBe(201);

    const cases = [
      ["contacts", contact, "Alert contact is still referenced"],
      ["groups", group, "Contact group is still referenced"],
      ["schedules", schedule, "On-call schedule is still referenced"],
      ["policies", policy, "Escalation policy is still referenced"]
    ] as const;
    for (const [resource, item, message] of cases) {
      const response = await server.inject({
        method: "DELETE",
        url: `/api/monitoring/alerts/${resource}/${item.id}?expectedRevision=${item.revision}`
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: message });
    }
    await server.close();
  });
});

async function buildRoutes() {
  return (await buildRoutesWithDb()).server;
}

async function buildRoutesWithDb() {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "zos-monitoring-alerts-"));
  const db = openZosDb(path.join(tempDirectory, "zos.sqlite"));
  const server = Fastify({ logger: false });
  registerMonitoringAlertRoutes(server, { db } as ApiRouteContext);
  server.addHook("onClose", async () => db.close());
  return { server, db };
}

function validRule() {
  return {
    name: "High CPU",
    enabled: true,
    metric: "zos_host_cpu_usage_ratio",
    selector: {},
    transform: "value",
    aggregation: "avg",
    windowSeconds: 300,
    comparator: ">",
    triggerThreshold: 0.9,
    recoveryThreshold: 0.8,
    triggerDurationSeconds: 60,
    recoveryDurationSeconds: 120,
    severity: "warning",
    noDataPolicy: "ignore",
    escalationPolicyId: null
  };
}
