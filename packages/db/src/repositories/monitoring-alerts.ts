import { randomUUID } from "node:crypto";
import type {
  MonitoringAlertContact,
  MonitoringAlertContactGroup,
  MonitoringAlertContactGroupInput,
  MonitoringAlertContactInput,
  MonitoringAlertDelivery,
  MonitoringAlertIncident,
  MonitoringAlertIncidentDetail,
  MonitoringAlertIncidentEvent,
  MonitoringAlertRule,
  MonitoringAlertRuleInput,
  MonitoringAlertSilence,
  MonitoringAlertSilenceInput,
  MonitoringAlertSummary,
  MonitoringEscalationPolicy,
  MonitoringEscalationPolicyInput,
  MonitoringEscalationStage,
  MonitoringHealthRouting,
  MonitoringOncallOverride,
  MonitoringOncallSchedule,
  MonitoringOncallScheduleInput,
  MonitoringSmtpSettings,
  MonitoringSmtpSettingsInput
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";

const SMTP_KEY = "monitoring_smtp";
const HEALTH_ROUTING_KEY = "monitoring_health_routing";
const MAX_PENDING_DELIVERIES = 10_000;

export class MonitoringAlertRevisionConflictError extends Error {
  constructor() {
    super("Monitoring alert configuration changed; reload and try again");
    this.name = "MonitoringAlertRevisionConflictError";
  }
}

export class MonitoringAlertReferenceConflictError extends Error {
  constructor(resource: string) {
    super(`${resource} is still referenced`);
    this.name = "MonitoringAlertReferenceConflictError";
  }
}

export class MonitoringAlertDeliveryCapacityError extends Error {
  constructor() {
    super("Alert delivery queue is full");
    this.name = "MonitoringAlertDeliveryCapacityError";
  }
}

export class MonitoringSmtpUnavailableError extends Error {
  constructor() {
    super("SMTP delivery is disabled or incomplete");
    this.name = "MonitoringSmtpUnavailableError";
  }
}

export function listMonitoringAlertRules(db: CyberOsDatabase): MonitoringAlertRule[] {
  return (db.prepare(`
    SELECT * FROM monitoring_alert_rules WHERE deleted_at IS NULL ORDER BY builtin DESC, name, id
  `).all() as AlertRuleRow[]).map(mapRule);
}

export function getMonitoringAlertRule(db: CyberOsDatabase, id: string): MonitoringAlertRule | null {
  const row = db.prepare("SELECT * FROM monitoring_alert_rules WHERE id = ? AND deleted_at IS NULL")
    .get(id) as AlertRuleRow | undefined;
  return row ? mapRule(row) : null;
}

export function createMonitoringAlertRule(
  db: CyberOsDatabase,
  input: MonitoringAlertRuleInput
): MonitoringAlertRule {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO monitoring_alert_rules(
      id, name, enabled, builtin, metric, selector_json, transform, aggregation,
      window_seconds, comparator, trigger_threshold, recovery_threshold,
      trigger_duration_seconds, recovery_duration_seconds, severity, no_data_policy,
      escalation_policy_id, revision, created_at, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id, input.name.trim(), bool(input.enabled), input.metric, JSON.stringify(input.selector),
    input.transform, input.aggregation, input.windowSeconds, input.comparator,
    input.triggerThreshold, input.recoveryThreshold, input.triggerDurationSeconds,
    input.recoveryDurationSeconds, input.severity, input.noDataPolicy,
    input.escalationPolicyId, now, now
  );
  return getMonitoringAlertRule(db, id)!;
}

export function updateMonitoringAlertRule(
  db: CyberOsDatabase,
  id: string,
  expectedRevision: number,
  input: MonitoringAlertRuleInput
): MonitoringAlertRule | null {
  return db.transaction(() => {
    const current = getMonitoringAlertRule(db, id);
    if (!current) return null;
    if (current.revision !== expectedRevision) throw new MonitoringAlertRevisionConflictError();
    const now = new Date().toISOString();
    const evaluationChanged = ruleEvaluationKey(current) !== ruleEvaluationKey(input);
    const changes = db.prepare(`
      UPDATE monitoring_alert_rules SET
        name = ?, enabled = ?, metric = ?, selector_json = ?, transform = ?, aggregation = ?,
        window_seconds = ?, comparator = ?, trigger_threshold = ?, recovery_threshold = ?,
        trigger_duration_seconds = ?, recovery_duration_seconds = ?, severity = ?,
        no_data_policy = ?, escalation_policy_id = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL
    `).run(
      input.name.trim(), bool(input.enabled), input.metric, JSON.stringify(input.selector),
      input.transform, input.aggregation, input.windowSeconds, input.comparator,
      input.triggerThreshold, input.recoveryThreshold, input.triggerDurationSeconds,
      input.recoveryDurationSeconds, input.severity, input.noDataPolicy,
      input.escalationPolicyId, now, id, expectedRevision
    ).changes;
    if (changes !== 1) throw new MonitoringAlertRevisionConflictError();
    if (evaluationChanged || (current.enabled && !input.enabled)) {
      closeRuleIncidents(db, id, current.enabled && !input.enabled ? "disabled" : "rule_changed", now);
      db.prepare("DELETE FROM monitoring_alert_instances WHERE rule_id = ?").run(id);
    }
    if (evaluationChanged || current.enabled !== input.enabled) {
      db.prepare("UPDATE monitoring_alert_rules SET evaluation_error = NULL WHERE id = ?").run(id);
    }
    return getMonitoringAlertRule(db, id)!;
  })();
}

export function deleteMonitoringAlertRule(
  db: CyberOsDatabase,
  id: string,
  expectedRevision: number
): boolean {
  return db.transaction(() => {
    const current = getMonitoringAlertRule(db, id);
    if (!current) return false;
    if (current.revision !== expectedRevision) throw new MonitoringAlertRevisionConflictError();
    const now = new Date().toISOString();
    const changes = db.prepare(`
      UPDATE monitoring_alert_rules
      SET enabled = 0, deleted_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND deleted_at IS NULL AND builtin = 0
    `).run(now, now, id, expectedRevision).changes;
    if (current.builtin) return false;
    if (changes !== 1) throw new MonitoringAlertRevisionConflictError();
    closeRuleIncidents(db, id, "deleted", now);
    db.prepare("DELETE FROM monitoring_alert_instances WHERE rule_id = ?").run(id);
    return true;
  })();
}

export function listMonitoringAlertIncidents(
  db: CyberOsDatabase,
  options: { status?: "firing" | "resolved"; limit?: number; groupHealthEpisodes?: boolean } = {}
): MonitoringAlertIncident[] {
  const limit = Math.max(1, Math.min(200, options.limit ?? 100));
  const rows = options.groupHealthEpisodes
    ? db.prepare(`
        WITH health_incident_counts AS (
          SELECT series_key, COUNT(*) AS incident_count
          FROM monitoring_alert_incidents
          WHERE source = 'health'
          GROUP BY series_key
        ), health_event_counts AS (
          SELECT incidents.series_key, COUNT(*) AS event_count
          FROM monitoring_alert_incident_events events
          JOIN monitoring_alert_incidents incidents ON incidents.id = events.incident_id
          WHERE incidents.source = 'health' AND events.type = 'fired'
          GROUP BY incidents.series_key
        ), ranked AS (
          SELECT incidents.*,
            CASE WHEN incidents.source = 'health' THEN MAX(
              COALESCE(health_incident_counts.incident_count, 1),
              COALESCE(health_event_counts.event_count, 1)
            ) ELSE 1 END AS occurrence_count,
            ROW_NUMBER() OVER (
              PARTITION BY CASE WHEN incidents.source = 'health' THEN incidents.series_key ELSE incidents.id END
              ORDER BY incidents.firing_at DESC, incidents.id DESC
            ) AS episode_rank
          FROM monitoring_alert_incidents incidents
          LEFT JOIN health_incident_counts ON health_incident_counts.series_key = incidents.series_key
            AND incidents.source = 'health'
          LEFT JOIN health_event_counts ON health_event_counts.series_key = incidents.series_key
            AND incidents.source = 'health'
          ${options.status ? "WHERE incidents.status = ?" : ""}
        )
        SELECT * FROM ranked
        WHERE episode_rank = 1
        ORDER BY firing_at DESC LIMIT ?
      `).all(...(options.status ? [options.status, limit] : [limit]))
    : options.status
      ? db.prepare(`
          SELECT incidents.*,
            CASE WHEN incidents.source = 'health' THEN MAX(1,
              (SELECT COUNT(*) FROM monitoring_alert_incident_events events
                WHERE events.incident_id = incidents.id AND events.type = 'fired')
            ) ELSE 1 END AS occurrence_count
          FROM monitoring_alert_incidents incidents
          WHERE status = ? ORDER BY firing_at DESC LIMIT ?
        `)
        .all(options.status, limit)
      : db.prepare(`
          SELECT incidents.*,
            CASE WHEN incidents.source = 'health' THEN MAX(1,
              (SELECT COUNT(*) FROM monitoring_alert_incident_events events
                WHERE events.incident_id = incidents.id AND events.type = 'fired')
            ) ELSE 1 END AS occurrence_count
          FROM monitoring_alert_incidents incidents ORDER BY firing_at DESC LIMIT ?
        `).all(limit);
  return (rows as AlertIncidentRow[]).map(mapIncident);
}

export function getMonitoringAlertIncident(db: CyberOsDatabase, id: string): MonitoringAlertIncident | null {
  const row = db.prepare("SELECT * FROM monitoring_alert_incidents WHERE id = ?").get(id) as
    | AlertIncidentRow
    | undefined;
  return row ? mapIncident(row) : null;
}

export function getMonitoringAlertIncidentDetail(
  db: CyberOsDatabase,
  id: string
): MonitoringAlertIncidentDetail | null {
  const row = db.prepare("SELECT * FROM monitoring_alert_incidents WHERE id = ?")
    .get(id) as AlertIncidentRow | undefined;
  if (!row) return null;
  const deliveries = (db.prepare(`
    SELECT id, incident_id, kind, status, attempt_count, due_at, sent_at, last_error, created_at, updated_at
    FROM monitoring_alert_deliveries WHERE incident_id = ? ORDER BY created_at, id
  `).all(id) as DeliveryRow[]).map(mapDelivery);
  return {
    incident: mapIncident(row),
    events: listMonitoringAlertIncidentEvents(db, id),
    ruleSnapshot: parseObject(row.rule_snapshot_json),
    policySnapshot: row.policy_snapshot_json === null ? null : parseObject(row.policy_snapshot_json),
    deliveries
  };
}

export function listMonitoringAlertIncidentEvents(
  db: CyberOsDatabase,
  incidentId: string
): MonitoringAlertIncidentEvent[] {
  return (db.prepare(`
    SELECT id, incident_id, type, details_json, created_at
    FROM monitoring_alert_incident_events WHERE incident_id = ? ORDER BY created_at, id
  `).all(incidentId) as IncidentEventRow[]).map((row) => ({
    id: row.id,
    incidentId: row.incident_id,
    type: row.type,
    details: parseObject(row.details_json),
    createdAt: row.created_at
  }));
}

export function markMonitoringAlertIncidentRead(
  db: CyberOsDatabase,
  id: string
): MonitoringAlertIncident | null {
  return changeIncident(db, id, "read");
}

export function markAllMonitoringAlertIncidentsRead(db: CyberOsDatabase): number {
  return db.transaction(() => {
    const ids = db.prepare("SELECT id FROM monitoring_alert_incidents WHERE read_at IS NULL")
      .pluck().all() as string[];
    if (ids.length === 0) return 0;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE monitoring_alert_incidents SET read_at = ?, updated_at = ? WHERE read_at IS NULL
    `).run(now, now);
    const insert = db.prepare(`
      INSERT INTO monitoring_alert_incident_events(incident_id, type, details_json, created_at)
      VALUES (?, 'read', '{}', ?)
    `);
    for (const id of ids) insert.run(id, now);
    return ids.length;
  })();
}

export function acknowledgeMonitoringAlertIncident(
  db: CyberOsDatabase,
  id: string
): MonitoringAlertIncident | null {
  return changeIncident(db, id, "acknowledged");
}

export function listMonitoringAlertSilences(db: CyberOsDatabase): MonitoringAlertSilence[] {
  return (db.prepare("SELECT * FROM monitoring_alert_silences WHERE cancelled_at IS NULL ORDER BY ends_at DESC")
    .all() as SilenceRow[]).map(mapSilence);
}

export function createMonitoringAlertSilence(
  db: CyberOsDatabase,
  input: MonitoringAlertSilenceInput
): MonitoringAlertSilence {
  return db.transaction(() => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO monitoring_alert_silences(
        id, rule_id, series_key, starts_at, ends_at, reason, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, input.ruleId, input.seriesKey, input.startsAt, input.endsAt, input.reason.trim(), now, now);
    if (input.startsAt <= now && input.endsAt > now) {
      cancelSilencedDeliveries(db, id, now);
    }
    return mapSilence(db.prepare("SELECT * FROM monitoring_alert_silences WHERE id = ?").get(id) as SilenceRow);
  })();
}

export function deleteMonitoringAlertSilence(
  db: CyberOsDatabase,
  id: string,
  expectedRevision: number
): boolean {
  return db.transaction(() => {
    const current = db.prepare("SELECT revision, cancelled_at FROM monitoring_alert_silences WHERE id = ?")
      .get(id) as { revision: number; cancelled_at: string | null } | undefined;
    if (!current || current.cancelled_at !== null) return false;
    if (current.revision !== expectedRevision) throw new MonitoringAlertRevisionConflictError();
    const now = new Date().toISOString();
    const changes = db.prepare(`
      UPDATE monitoring_alert_silences
      SET cancelled_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND cancelled_at IS NULL
    `).run(now, now, id, expectedRevision).changes;
    if (changes !== 1) throw new MonitoringAlertRevisionConflictError();
    db.prepare(`
      INSERT INTO monitoring_alert_incident_events(incident_id, type, details_json, created_at)
      SELECT incidents.id, 'unsilenced', json_object('silenceId', silences.id), ?
      FROM monitoring_alert_silences silences
      JOIN monitoring_alert_incidents incidents ON incidents.rule_id = silences.rule_id
        AND (silences.series_key IS NULL OR silences.series_key = incidents.series_key)
      WHERE silences.id = ? AND incidents.status = 'firing'
    `).run(now, id);
    return true;
  })();
}

export function listMonitoringAlertContacts(db: CyberOsDatabase): MonitoringAlertContact[] {
  return (db.prepare("SELECT * FROM monitoring_alert_contacts ORDER BY name, id").all() as ContactRow[])
    .map(mapContact);
}

export function createMonitoringAlertContact(
  db: CyberOsDatabase,
  input: MonitoringAlertContactInput
): MonitoringAlertContact {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO monitoring_alert_contacts(id, name, email, enabled, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, input.name.trim(), input.email.trim().toLowerCase(), bool(input.enabled), now, now);
  return mapContact(db.prepare("SELECT * FROM monitoring_alert_contacts WHERE id = ?").get(id) as ContactRow);
}

export function updateMonitoringAlertContact(
  db: CyberOsDatabase,
  id: string,
  expectedRevision: number,
  input: MonitoringAlertContactInput
): MonitoringAlertContact | null {
  const current = db.prepare("SELECT revision FROM monitoring_alert_contacts WHERE id = ?").get(id) as
    | { revision: number }
    | undefined;
  if (!current) return null;
  if (current.revision !== expectedRevision) throw new MonitoringAlertRevisionConflictError();
  const now = new Date().toISOString();
  const changes = db.prepare(`
    UPDATE monitoring_alert_contacts
    SET name = ?, email = ?, enabled = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ?
  `).run(input.name.trim(), input.email.trim().toLowerCase(), bool(input.enabled), now, id, expectedRevision).changes;
  if (changes !== 1) throw new MonitoringAlertRevisionConflictError();
  return mapContact(db.prepare("SELECT * FROM monitoring_alert_contacts WHERE id = ?").get(id) as ContactRow);
}

export function deleteMonitoringAlertContact(db: CyberOsDatabase, id: string, expectedRevision: number): boolean {
  return deleteRevisioned(db, "monitoring_alert_contacts", id, expectedRevision, "Alert contact", () =>
    referenceExists(db, [
      ["monitoring_alert_group_members", "contact_id"],
      ["monitoring_oncall_members", "contact_id"],
      ["monitoring_oncall_overrides", "contact_id"]
    ], id) || escalationTargetExists(db, "contact", id));
}

const ALERTER_STALE_AFTER_MS = 30_000;

export function getMonitoringAlertSummary(
  db: CyberOsDatabase,
  now = new Date()
): MonitoringAlertSummary {
  const counts = db.prepare(`
    SELECT
      (
        SELECT COUNT(*) FROM (
          SELECT CASE WHEN source = 'health' THEN 'health:' || series_key ELSE id END AS notification_key
          FROM monitoring_alert_incidents
          WHERE read_at IS NULL
          GROUP BY notification_key
        ) unread_groups
      ) AS unread_count,
      SUM(CASE WHEN status = 'firing' THEN 1 ELSE 0 END) AS firing_count
    FROM monitoring_alert_incidents
  `).get() as { unread_count: number | null; firing_count: number | null };
  const state = db.prepare(`
    SELECT status, last_evaluation_at, pending_deliveries
    FROM monitoring_alerter_state WHERE id = 1
  `).get() as {
    status: Exclude<MonitoringAlertSummary["alerterStatus"], "unavailable">;
    last_evaluation_at: string | null;
    pending_deliveries: number;
  };
  const lastEvaluationMs = state.last_evaluation_at === null
    ? Number.NaN
    : Date.parse(state.last_evaluation_at);
  const alerterStatus = state.status === "starting" || !Number.isFinite(lastEvaluationMs)
    ? "starting"
    : now.getTime() - lastEvaluationMs > ALERTER_STALE_AFTER_MS
      ? "unavailable"
      : state.status;
  return {
    unreadCount: counts.unread_count ?? 0,
    firingCount: counts.firing_count ?? 0,
    alerterStatus,
    lastEvaluationAt: state.last_evaluation_at,
    pendingDeliveries: state.pending_deliveries
  };
}

export function getMonitoringAlertDelivery(db: CyberOsDatabase, id: string): MonitoringAlertDelivery | null {
  const row = db.prepare(`
    SELECT id, incident_id, kind, status, attempt_count, due_at, sent_at, last_error, created_at, updated_at
    FROM monitoring_alert_deliveries WHERE id = ?
  `).get(id) as DeliveryRow | undefined;
  return row ? mapDelivery(row) : null;
}

export function getMonitoringSmtpSettings(db: CyberOsDatabase): MonitoringSmtpSettings {
  const row = readSetting(db, SMTP_KEY);
  const value = parseObject(row.value_json);
  return {
    enabled: value.enabled === true,
    host: typeof value.host === "string" ? value.host : "",
    port: typeof value.port === "number" ? value.port : 587,
    security: value.security === "none" || value.security === "tls" ? value.security : "starttls",
    username: typeof value.username === "string" ? value.username : "",
    from: typeof value.from === "string" ? value.from : "",
    credentialConfigured: typeof value.password === "string" && value.password.length > 0,
    revision: settingRevision(value),
    updatedAt: row.updated_at
  };
}

export function saveMonitoringSmtpSettings(
  db: CyberOsDatabase,
  expectedRevision: number,
  input: MonitoringSmtpSettingsInput
): MonitoringSmtpSettings {
  const row = readSetting(db, SMTP_KEY);
  const current = parseObject(row.value_json);
  if (settingRevision(current) !== expectedRevision) throw new MonitoringAlertRevisionConflictError();
  const now = new Date().toISOString();
  const password = input.password?.trim() || (typeof current.password === "string" ? current.password : "");
  writeSetting(db, SMTP_KEY, {
    enabled: input.enabled,
    host: input.host.trim(),
    port: input.port,
    security: input.security,
    username: input.username.trim(),
    password,
    from: input.from.trim(),
    revision: expectedRevision + 1
  }, now);
  return getMonitoringSmtpSettings(db);
}

export function getMonitoringHealthRouting(db: CyberOsDatabase): MonitoringHealthRouting {
  const row = readSetting(db, HEALTH_ROUTING_KEY);
  const value = parseObject(row.value_json);
  return {
    warningPolicyId: stringOrNull(value.warningPolicyId),
    criticalPolicyId: stringOrNull(value.criticalPolicyId),
    revision: settingRevision(value),
    updatedAt: row.updated_at
  };
}

export function saveMonitoringHealthRouting(
  db: CyberOsDatabase,
  expectedRevision: number,
  input: Pick<MonitoringHealthRouting, "warningPolicyId" | "criticalPolicyId">
): MonitoringHealthRouting {
  const current = getMonitoringHealthRouting(db);
  if (current.revision !== expectedRevision) throw new MonitoringAlertRevisionConflictError();
  writeSetting(db, HEALTH_ROUTING_KEY, {
    warningPolicyId: input.warningPolicyId,
    criticalPolicyId: input.criticalPolicyId,
    revision: expectedRevision + 1
  }, new Date().toISOString());
  return getMonitoringHealthRouting(db);
}

export function enqueueMonitoringTestEmail(db: CyberOsDatabase, recipient: string): MonitoringAlertDelivery {
  const smtp = getMonitoringSmtpSettings(db);
  if (!smtp.enabled || !smtp.host || !smtp.from) throw new MonitoringSmtpUnavailableError();
  const pending = db.prepare(`
    SELECT COUNT(*) FROM monitoring_alert_deliveries
    WHERE status IN ('pending', 'retrying', 'sending')
  `).pluck().get() as number;
  if (pending >= MAX_PENDING_DELIVERIES) throw new MonitoringAlertDeliveryCapacityError();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO monitoring_alert_deliveries(
      id, incident_id, kind, idempotency_key, message_id, recipients_json, subject, body_text,
      status, attempt_count, due_at, created_at, updated_at
    ) VALUES (?, NULL, 'test', ?, ?, ?, 'CyberOS alert email test',
      'This is a test message from CyberOS monitoring.', 'pending', 0, ?, ?, ?)
  `).run(
    id,
    `test:${id}`,
    `<cyberos-alert-test-${id}@localhost>`,
    JSON.stringify([recipient.trim().toLowerCase()]),
    now,
    now,
    now
  );
  return getMonitoringAlertDelivery(db, id)!;
}

function closeRuleIncidents(
  db: CyberOsDatabase,
  ruleId: string,
  reason: "rule_changed" | "disabled" | "deleted",
  now: string
): void {
  const incidentIds = db.prepare(`
    SELECT id FROM monitoring_alert_incidents WHERE rule_id = ? AND status = 'firing'
  `).pluck().all(ruleId) as string[];
  db.prepare(`
    UPDATE monitoring_alert_incidents
    SET status = 'resolved', resolved_at = ?, close_reason = ?, updated_at = ?
    WHERE rule_id = ? AND status = 'firing'
  `).run(now, reason, now, ruleId);
  const insertEvent = db.prepare(`
    INSERT INTO monitoring_alert_incident_events(incident_id, type, details_json, created_at)
    VALUES (?, ?, '{}', ?)
  `);
  for (const incidentId of incidentIds) {
    insertEvent.run(incidentId, reason, now);
    const recipients = new Set<string>();
    const rows = db.prepare(`
      SELECT recipients_json FROM monitoring_alert_deliveries
      WHERE incident_id = ? AND status = 'succeeded'
    `).all(incidentId) as Array<{ recipients_json: string }>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.recipients_json) as unknown;
        if (Array.isArray(parsed)) {
          for (const recipient of parsed) if (typeof recipient === "string") recipients.add(recipient);
        }
      } catch {
        // A malformed historical recipient snapshot must not block rule changes.
      }
    }
    if (recipients.size > 0) {
      const deliveryId = randomUUID();
      db.prepare(`
        INSERT OR IGNORE INTO monitoring_alert_deliveries(
          id, incident_id, kind, idempotency_key, message_id, recipients_json,
          subject, body_text, status, attempt_count, due_at, created_at, updated_at
        ) SELECT ?, id, 'resolved', ?, ?, ?, 'CyberOS alert closed: ' || title,
          'CyberOS alert closed because the rule was ${reason}.', 'pending', 0, ?, ?, ?
        FROM monitoring_alert_incidents WHERE id = ?
      `).run(
        deliveryId,
        `${incidentId}:resolved:${reason}`,
        `<cyberos-alert-${incidentId}-resolved@localhost>`,
        JSON.stringify([...recipients]),
        now,
        now,
        now,
        incidentId
      );
    }
  }
  db.prepare(`
    UPDATE monitoring_alert_deliveries SET status = 'cancelled', updated_at = ?
    WHERE incident_id IN (
      SELECT id FROM monitoring_alert_incidents WHERE rule_id = ?
    ) AND kind <> 'resolved' AND status IN ('pending', 'retrying')
  `).run(now, ruleId);
}

function changeIncident(
  db: CyberOsDatabase,
  id: string,
  action: "read" | "acknowledged"
): MonitoringAlertIncident | null {
  return db.transaction(() => {
    const current = getMonitoringAlertIncident(db, id);
    if (!current) return null;
    if (action === "acknowledged" && current.acknowledgedAt !== null) {
      return current;
    }
    const now = new Date().toISOString();
    const ids = action === "read" && current.source === "health"
      ? db.prepare(`
          SELECT id FROM monitoring_alert_incidents
          WHERE source = 'health' AND series_key = ? AND read_at IS NULL
        `).pluck().all(current.seriesKey) as string[]
      : action === "read" && current.readAt !== null
        ? []
        : [id];
    if (ids.length === 0) return current;
    const column = action === "read" ? "read_at" : "acknowledged_at";
    const placeholders = ids.map(() => "?").join(", ");
    db.prepare(`UPDATE monitoring_alert_incidents SET ${column} = COALESCE(${column}, ?), updated_at = ? WHERE id IN (${placeholders})`)
      .run(now, now, ...ids);
    const insertEvent = db.prepare(`
      INSERT INTO monitoring_alert_incident_events(incident_id, type, details_json, created_at)
      VALUES (?, ?, '{}', ?)
    `);
    for (const incidentId of ids) insertEvent.run(incidentId, action, now);
    if (action === "acknowledged") {
      db.prepare(`
        UPDATE monitoring_alert_deliveries SET status = 'cancelled', updated_at = ?
        WHERE incident_id = ? AND status IN ('pending', 'retrying')
      `).run(now, id);
    }
    return getMonitoringAlertIncident(db, id)!;
  })();
}

function cancelSilencedDeliveries(db: CyberOsDatabase, silenceId: string, now: string): void {
  db.prepare(`
    INSERT INTO monitoring_alert_incident_events(incident_id, type, details_json, created_at)
    SELECT incidents.id, 'silenced', json_object('silenceId', silences.id), ?
    FROM monitoring_alert_silences silences
    JOIN monitoring_alert_incidents incidents ON incidents.rule_id = silences.rule_id
      AND (silences.series_key IS NULL OR silences.series_key = incidents.series_key)
    WHERE silences.id = ? AND incidents.status = 'firing'
  `).run(now, silenceId);
  db.prepare(`
    UPDATE monitoring_alert_deliveries SET status = 'cancelled', updated_at = ?
    WHERE status IN ('pending', 'retrying') AND incident_id IN (
      SELECT incidents.id
      FROM monitoring_alert_silences silences
      JOIN monitoring_alert_incidents incidents ON incidents.rule_id = silences.rule_id
        AND (silences.series_key IS NULL OR silences.series_key = incidents.series_key)
      WHERE silences.id = ?
    )
  `).run(now, silenceId);
}

function ruleEvaluationKey(rule: MonitoringAlertRuleInput): string {
  return JSON.stringify({
    metric: rule.metric,
    selector: rule.selector,
    transform: rule.transform,
    aggregation: rule.aggregation,
    windowSeconds: rule.windowSeconds,
    comparator: rule.comparator,
    triggerThreshold: rule.triggerThreshold,
    recoveryThreshold: rule.recoveryThreshold,
    triggerDurationSeconds: rule.triggerDurationSeconds,
    recoveryDurationSeconds: rule.recoveryDurationSeconds,
    noDataPolicy: rule.noDataPolicy
  });
}

function deleteRevisioned(
  db: CyberOsDatabase,
  table: string,
  id: string,
  expectedRevision: number,
  resource = "Monitoring alert configuration",
  isReferenced: () => boolean = () => false
): boolean {
  return db.transaction(() => {
    const current = db.prepare(`SELECT revision FROM ${table} WHERE id = ?`)
      .get(id) as { revision: number } | undefined;
    if (!current) return false;
    if (current.revision !== expectedRevision) throw new MonitoringAlertRevisionConflictError();
    if (isReferenced()) throw new MonitoringAlertReferenceConflictError(resource);
    const result = db.prepare(`DELETE FROM ${table} WHERE id = ? AND revision = ?`).run(id, expectedRevision);
    if (result.changes !== 1) throw new MonitoringAlertRevisionConflictError();
    return true;
  })();
}

function referenceExists(
  db: CyberOsDatabase,
  references: ReadonlyArray<readonly [table: string, column: string]>,
  id: string
): boolean {
  return references.some(([table, column]) => Boolean(
    db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(id)
  ));
}

function escalationTargetExists(
  db: CyberOsDatabase,
  targetType: "contact" | "group" | "oncall",
  id: string
): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM monitoring_escalation_targets
    WHERE target_type = ? AND target_id = ? LIMIT 1
  `).get(targetType, id));
}

function readSetting(db: CyberOsDatabase, key: string): SettingRow {
  const row = db.prepare("SELECT value_json, updated_at FROM system_settings WHERE key = ?")
    .get(key) as SettingRow | undefined;
  if (!row) throw new Error(`Required monitoring setting is missing: ${key}`);
  return row;
}

function writeSetting(db: CyberOsDatabase, key: string, value: Record<string, unknown>, updatedAt: string): void {
  db.prepare("UPDATE system_settings SET value_json = ?, updated_at = ? WHERE key = ?")
    .run(JSON.stringify(value), updatedAt, key);
}

function settingRevision(value: Record<string, unknown>): number {
  return Number.isInteger(value.revision) && Number(value.revision) > 0 ? Number(value.revision) : 1;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseStringRecord(value: string): Record<string, string> {
  const parsed = parseObject(value);
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

function mapRule(row: AlertRuleRow): MonitoringAlertRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    builtin: row.builtin === 1,
    metric: row.metric,
    selector: parseStringRecord(row.selector_json),
    transform: row.transform,
    aggregation: row.aggregation,
    windowSeconds: row.window_seconds,
    comparator: row.comparator,
    triggerThreshold: row.trigger_threshold,
    recoveryThreshold: row.recovery_threshold,
    triggerDurationSeconds: row.trigger_duration_seconds,
    recoveryDurationSeconds: row.recovery_duration_seconds,
    severity: row.severity,
    noDataPolicy: row.no_data_policy,
    escalationPolicyId: row.escalation_policy_id,
    evaluationError: row.evaluation_error,
    lastEvaluatedAt: row.last_evaluated_at,
    revision: row.revision,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapIncident(row: AlertIncidentRow): MonitoringAlertIncident {
  return {
    id: row.id,
    source: row.source,
    ruleId: row.rule_id,
    healthAlertId: row.health_alert_id,
    seriesKey: row.series_key,
    labels: parseStringRecord(row.labels_json),
    status: row.status,
    severity: row.severity,
    title: row.title,
    currentValue: row.current_value,
    firingAt: row.firing_at,
    resolvedAt: row.resolved_at,
    closeReason: row.close_reason,
    acknowledgedAt: row.acknowledged_at,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    occurrenceCount: row.occurrence_count ?? 1
  };
}

function mapSilence(row: SilenceRow): MonitoringAlertSilence {
  return {
    id: row.id,
    ruleId: row.rule_id,
    seriesKey: row.series_key,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    reason: row.reason,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapContact(row: ContactRow): MonitoringAlertContact {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDelivery(row: DeliveryRow): MonitoringAlertDelivery {
  return {
    id: row.id,
    incidentId: row.incident_id,
    kind: row.kind,
    status: row.status,
    attemptCount: row.attempt_count,
    dueAt: row.due_at,
    sentAt: row.sent_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface SettingRow { value_json: string; updated_at: string }
interface AlertRuleRow {
  id: string; name: string; enabled: number; builtin: number; metric: string; selector_json: string;
  transform: MonitoringAlertRule["transform"]; aggregation: MonitoringAlertRule["aggregation"];
  window_seconds: MonitoringAlertRule["windowSeconds"]; comparator: MonitoringAlertRule["comparator"];
  trigger_threshold: number; recovery_threshold: number; trigger_duration_seconds: number;
  recovery_duration_seconds: number; severity: MonitoringAlertRule["severity"];
  no_data_policy: MonitoringAlertRule["noDataPolicy"]; escalation_policy_id: string | null;
  evaluation_error: string | null; last_evaluated_at: string | null;
  revision: number; deleted_at: string | null; created_at: string; updated_at: string;
}
interface AlertIncidentRow {
  id: string; source: MonitoringAlertIncident["source"]; rule_id: string | null; health_alert_id: string | null;
  series_key: string; labels_json: string; status: MonitoringAlertIncident["status"];
  severity: MonitoringAlertIncident["severity"]; title: string; current_value: number | null;
  firing_at: string; resolved_at: string | null; close_reason: MonitoringAlertIncident["closeReason"];
  acknowledged_at: string | null; read_at: string | null; created_at: string; updated_at: string;
  rule_snapshot_json: string; policy_snapshot_json: string | null;
  occurrence_count?: number;
}
interface IncidentEventRow {
  id: number;
  incident_id: string;
  type: MonitoringAlertIncidentEvent["type"];
  details_json: string;
  created_at: string;
}
interface SilenceRow {
  id: string; rule_id: string; series_key: string | null; starts_at: string; ends_at: string;
  reason: string; revision: number; cancelled_at: string | null; created_at: string; updated_at: string;
}
interface ContactRow {
  id: string; name: string; email: string; enabled: number; revision: number; created_at: string; updated_at: string;
}
interface DeliveryRow {
  id: string; incident_id: string | null; kind: MonitoringAlertDelivery["kind"];
  status: MonitoringAlertDelivery["status"]; attempt_count: number; due_at: string;
  sent_at: string | null; last_error: string | null; created_at: string; updated_at: string;
}

// Aggregate-root functions below are kept with the alert repository so child rows are never updated independently.
export function listMonitoringAlertGroups(db: CyberOsDatabase): MonitoringAlertContactGroup[] {
  const groups = db.prepare("SELECT * FROM monitoring_alert_contact_groups ORDER BY name, id").all() as GroupRow[];
  const members = db.prepare("SELECT group_id, contact_id FROM monitoring_alert_group_members ORDER BY group_id, ordinal")
    .all() as Array<{ group_id: string; contact_id: string }>;
  return groups.map((row) => ({
    id: row.id,
    name: row.name,
    contactIds: members.filter((member) => member.group_id === row.id).map((member) => member.contact_id),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function saveMonitoringAlertGroup(
  db: CyberOsDatabase,
  id: string | null,
  expectedRevision: number | null,
  input: MonitoringAlertContactGroupInput
): MonitoringAlertContactGroup {
  return db.transaction(() => {
    const targetId = id ?? randomUUID();
    const now = new Date().toISOString();
    if (id === null) {
      db.prepare(`INSERT INTO monitoring_alert_contact_groups(id, name, revision, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)`).run(targetId, input.name.trim(), now, now);
    } else {
      const changes = db.prepare(`UPDATE monitoring_alert_contact_groups
        SET name = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
        .run(input.name.trim(), now, targetId, expectedRevision).changes;
      if (changes !== 1) throw new MonitoringAlertRevisionConflictError();
      db.prepare("DELETE FROM monitoring_alert_group_members WHERE group_id = ?").run(targetId);
    }
    const insert = db.prepare(`INSERT INTO monitoring_alert_group_members(group_id, contact_id, ordinal) VALUES (?, ?, ?)`);
    unique(input.contactIds).forEach((contactId, ordinal) => insert.run(targetId, contactId, ordinal));
    return listMonitoringAlertGroups(db).find((group) => group.id === targetId)!;
  })();
}

export function deleteMonitoringAlertGroup(db: CyberOsDatabase, id: string, expectedRevision: number): boolean {
  return deleteRevisioned(db, "monitoring_alert_contact_groups", id, expectedRevision, "Contact group", () =>
    escalationTargetExists(db, "group", id));
}

export function listMonitoringOncallSchedules(db: CyberOsDatabase): MonitoringOncallSchedule[] {
  const schedules = db.prepare("SELECT * FROM monitoring_oncall_schedules ORDER BY name, id").all() as ScheduleRow[];
  const members = db.prepare("SELECT schedule_id, contact_id FROM monitoring_oncall_members ORDER BY schedule_id, ordinal")
    .all() as Array<{ schedule_id: string; contact_id: string }>;
  const overrides = (db.prepare("SELECT * FROM monitoring_oncall_overrides ORDER BY starts_at")
    .all() as OverrideRow[]).map(mapOverride);
  return schedules.map((row) => ({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    handoffWeekday: row.handoff_weekday,
    handoffTime: row.handoff_time,
    anchorDate: row.anchor_date,
    contactIds: members.filter((member) => member.schedule_id === row.id).map((member) => member.contact_id),
    revision: row.revision,
    overrides: overrides.filter((override) => override.scheduleId === row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function saveMonitoringOncallSchedule(
  db: CyberOsDatabase,
  id: string | null,
  expectedRevision: number | null,
  input: MonitoringOncallScheduleInput
): MonitoringOncallSchedule {
  return db.transaction(() => {
    const targetId = id ?? randomUUID();
    const now = new Date().toISOString();
    if (id === null) {
      db.prepare(`INSERT INTO monitoring_oncall_schedules(
        id, name, timezone, handoff_weekday, handoff_time, anchor_date, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        targetId, input.name.trim(), input.timezone, input.handoffWeekday, input.handoffTime, input.anchorDate, now, now
      );
    } else {
      const changes = db.prepare(`UPDATE monitoring_oncall_schedules SET
        name = ?, timezone = ?, handoff_weekday = ?, handoff_time = ?, anchor_date = ?,
        revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
        .run(input.name.trim(), input.timezone, input.handoffWeekday, input.handoffTime,
          input.anchorDate, now, targetId, expectedRevision).changes;
      if (changes !== 1) throw new MonitoringAlertRevisionConflictError();
      db.prepare("DELETE FROM monitoring_oncall_members WHERE schedule_id = ?").run(targetId);
    }
    const insert = db.prepare(`INSERT INTO monitoring_oncall_members(schedule_id, contact_id, ordinal) VALUES (?, ?, ?)`);
    unique(input.contactIds).forEach((contactId, ordinal) => insert.run(targetId, contactId, ordinal));
    return listMonitoringOncallSchedules(db).find((schedule) => schedule.id === targetId)!;
  })();
}

export function createMonitoringOncallOverride(
  db: CyberOsDatabase,
  input: Omit<MonitoringOncallOverride, "id" | "revision" | "createdAt" | "updatedAt">
): MonitoringOncallOverride {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO monitoring_oncall_overrides(
    id, schedule_id, contact_id, starts_at, ends_at, reason, revision, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
    id, input.scheduleId, input.contactId, input.startsAt, input.endsAt, input.reason.trim(), now, now
  );
  return mapOverride(db.prepare("SELECT * FROM monitoring_oncall_overrides WHERE id = ?").get(id) as OverrideRow);
}

export function deleteMonitoringOncallSchedule(db: CyberOsDatabase, id: string, expectedRevision: number): boolean {
  return deleteRevisioned(db, "monitoring_oncall_schedules", id, expectedRevision, "On-call schedule", () =>
    escalationTargetExists(db, "oncall", id));
}

export function deleteMonitoringOncallOverride(db: CyberOsDatabase, id: string, expectedRevision: number): boolean {
  return deleteRevisioned(db, "monitoring_oncall_overrides", id, expectedRevision);
}

export function listMonitoringEscalationPolicies(db: CyberOsDatabase): MonitoringEscalationPolicy[] {
  const policies = db.prepare("SELECT * FROM monitoring_escalation_policies ORDER BY name, id").all() as PolicyRow[];
  const stages = db.prepare("SELECT * FROM monitoring_escalation_stages ORDER BY policy_id, ordinal").all() as StageRow[];
  const targets = db.prepare("SELECT * FROM monitoring_escalation_targets ORDER BY stage_id, ordinal").all() as TargetRow[];
  return policies.map((policy) => ({
    id: policy.id,
    name: policy.name,
    enabled: policy.enabled === 1,
    stages: stages.filter((stage) => stage.policy_id === policy.id).map((stage) => ({
      delaySeconds: stage.delay_seconds,
      repeatIntervalSeconds: stage.repeat_interval_seconds,
      repeatCount: stage.repeat_count,
      targets: targets.filter((target) => target.stage_id === stage.id)
        .map((target) => ({ type: target.target_type, id: target.target_id }))
    })),
    revision: policy.revision,
    createdAt: policy.created_at,
    updatedAt: policy.updated_at
  }));
}

export function saveMonitoringEscalationPolicy(
  db: CyberOsDatabase,
  id: string | null,
  expectedRevision: number | null,
  input: MonitoringEscalationPolicyInput
): MonitoringEscalationPolicy {
  return db.transaction(() => {
    const targetId = id ?? randomUUID();
    const now = new Date().toISOString();
    if (id === null) {
      db.prepare(`INSERT INTO monitoring_escalation_policies(id, name, enabled, revision, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)`).run(targetId, input.name.trim(), bool(input.enabled), now, now);
    } else {
      const changes = db.prepare(`UPDATE monitoring_escalation_policies
        SET name = ?, enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
        .run(input.name.trim(), bool(input.enabled), now, targetId, expectedRevision).changes;
      if (changes !== 1) throw new MonitoringAlertRevisionConflictError();
      db.prepare("DELETE FROM monitoring_escalation_stages WHERE policy_id = ?").run(targetId);
    }
    const insertStage = db.prepare(`INSERT INTO monitoring_escalation_stages(
      id, policy_id, ordinal, delay_seconds, repeat_interval_seconds, repeat_count
    ) VALUES (?, ?, ?, ?, ?, ?)`);
    const insertTarget = db.prepare(`INSERT INTO monitoring_escalation_targets(
      stage_id, target_type, target_id, ordinal
    ) VALUES (?, ?, ?, ?)`);
    input.stages.forEach((stage, ordinal) => {
      const stageId = randomUUID();
      insertStage.run(stageId, targetId, ordinal, stage.delaySeconds,
        stage.repeatIntervalSeconds, stage.repeatCount);
      uniqueTargets(stage).forEach((target, targetOrdinal) => {
        insertTarget.run(stageId, target.type, target.id, targetOrdinal);
      });
    });
    return listMonitoringEscalationPolicies(db).find((policy) => policy.id === targetId)!;
  })();
}

export function deleteMonitoringEscalationPolicy(db: CyberOsDatabase, id: string, expectedRevision: number): boolean {
  return deleteRevisioned(db, "monitoring_escalation_policies", id, expectedRevision, "Escalation policy", () =>
    Boolean(db.prepare(`
      SELECT 1 FROM monitoring_alert_rules
      WHERE escalation_policy_id = ? AND deleted_at IS NULL LIMIT 1
    `).get(id)) || Boolean(db.prepare(`
      SELECT 1 FROM system_settings
      WHERE key = ? AND (
        json_extract(value_json, '$.warningPolicyId') = ?
        OR json_extract(value_json, '$.criticalPolicyId') = ?
      )
      LIMIT 1
    `).get(HEALTH_ROUTING_KEY, id, id)));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueTargets(stage: MonitoringEscalationStage): MonitoringEscalationStage["targets"] {
  const seen = new Set<string>();
  return stage.targets.filter((target) => {
    const key = `${target.type}:${target.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mapOverride(row: OverrideRow): MonitoringOncallOverride {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    contactId: row.contact_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    reason: row.reason,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface GroupRow { id: string; name: string; revision: number; created_at: string; updated_at: string }
interface ScheduleRow {
  id: string; name: string; timezone: string; handoff_weekday: number; handoff_time: string;
  anchor_date: string; revision: number; created_at: string; updated_at: string;
}
interface OverrideRow {
  id: string; schedule_id: string; contact_id: string; starts_at: string; ends_at: string;
  reason: string; revision: number; created_at: string; updated_at: string;
}
interface PolicyRow { id: string; name: string; enabled: number; revision: number; created_at: string; updated_at: string }
interface StageRow {
  id: string; policy_id: string; ordinal: number; delay_seconds: number;
  repeat_interval_seconds: number | null; repeat_count: number;
}
interface TargetRow {
  stage_id: string; target_type: "contact" | "group" | "oncall"; target_id: string; ordinal: number;
}
