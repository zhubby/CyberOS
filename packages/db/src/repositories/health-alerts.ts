import { randomUUID } from "node:crypto";
import type {
  HealthAlertSeverity,
  HealthAlertStatus,
  IndexerAlert,
  SystemHealthSummary
} from "@zos/shared";
import type { ZosDatabase } from "../connection.js";
import type { DbAlertRow } from "./repository-rows.js";

export function upsertHealthAlert(db: ZosDatabase, input: { code: string; scope?: string; rootId?: string | null; severity: HealthAlertSeverity; details?: string | null; now?: Date }): IndexerAlert {
  const now = (input.now ?? new Date()).toISOString();
  const scope = input.scope ?? input.rootId ?? "system";
  const id = randomUUID();
  db.prepare(`
    INSERT INTO health_alerts (id, code, scope, root_id, severity, status, first_seen_at, last_seen_at, details)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(code, scope) DO UPDATE SET status = 'active', severity = excluded.severity,
      last_seen_at = excluded.last_seen_at, resolved_at = NULL, details = excluded.details
  `).run(id, input.code, scope, input.rootId ?? null, input.severity, now, now, input.details ?? null);
  const row = db.prepare("SELECT id, code, scope, root_id, severity, status, first_seen_at, last_seen_at, resolved_at, details FROM health_alerts WHERE code = ? AND scope = ?").get(input.code, scope) as DbAlertRow;
  return mapAlert(row);
}

export function resolveHealthAlert(db: ZosDatabase, input: { code: string; scope?: string; now?: Date }): boolean {
  const scope = input.scope ?? "system";
  const result = db.prepare("UPDATE health_alerts SET status = 'resolved', resolved_at = ?, last_seen_at = ? WHERE code = ? AND scope = ? AND status = 'active'").run((input.now ?? new Date()).toISOString(), (input.now ?? new Date()).toISOString(), input.code, scope);
  return result.changes === 1;
}

export function listHealthAlerts(db: ZosDatabase, input: { status?: HealthAlertStatus; limit?: number } = {}): IndexerAlert[] {
  const rows = input.status
    ? db.prepare("SELECT id, code, scope, root_id, severity, status, first_seen_at, last_seen_at, resolved_at, details FROM health_alerts WHERE status = ? ORDER BY last_seen_at DESC LIMIT ?").all(input.status, input.limit ?? 100)
    : db.prepare("SELECT id, code, scope, root_id, severity, status, first_seen_at, last_seen_at, resolved_at, details FROM health_alerts ORDER BY last_seen_at DESC LIMIT ?").all(input.limit ?? 100);
  return (rows as DbAlertRow[]).map(mapAlert);
}

export function reconcileHealthAlerts(
  db: ZosDatabase,
  input: {
    ownedCodes: readonly string[];
    issues: SystemHealthSummary["issues"];
    now?: Date;
  }
): void {
  const now = input.now ?? new Date();
  const ownedCodes = new Set(input.ownedCodes);
  const current = new Map<string, SystemHealthSummary["issues"][number]>();
  for (const issue of input.issues) {
    if (!ownedCodes.has(issue.code)) continue;
    current.set(`${issue.code}:${issue.rootId ?? "system"}`, issue);
  }

  const reconcile = db.transaction(() => {
    for (const issue of current.values()) {
      upsertHealthAlert(db, {
        code: issue.code,
        scope: issue.rootId ?? "system",
        rootId: issue.rootId ?? null,
        severity: issue.severity,
        details: issue.message,
        now
      });
    }

    if (input.ownedCodes.length === 0) return;
    const placeholders = input.ownedCodes.map(() => "?").join(", ");
    const activeRows = db.prepare(`
      SELECT code, scope FROM health_alerts
      WHERE status = 'active' AND code IN (${placeholders})
    `).all(...input.ownedCodes) as Array<{ code: string; scope: string }>;
    for (const row of activeRows) {
      if (!current.has(`${row.code}:${row.scope}`)) {
        resolveHealthAlert(db, { code: row.code, scope: row.scope, now });
      }
    }
  });
  reconcile.immediate();
}

function mapAlert(row: DbAlertRow): IndexerAlert {
  return { id: row.id, code: row.code, rootId: row.root_id, severity: row.severity, status: row.status, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, resolvedAt: row.resolved_at, details: row.details };
}
