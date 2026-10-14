import type { ZosDatabase } from "../connection.js";

export interface OpsMaintenanceRetentionResult {
  operationNotificationsRemoved: number;
  backupRunsRemoved: number;
  resolvedAlertsRemoved: number;
}

export function runOpsMaintenanceRetention(
  db: ZosDatabase,
  now = new Date()
): OpsMaintenanceRetentionResult {
  const notificationCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const alertCutoff = notificationCutoff;
  const prune = db.transaction(() => {
    const operationNotificationsRemoved = db.prepare(`
      DELETE FROM operation_notifications WHERE updated_at < ?
    `).run(notificationCutoff).changes;
    const backupRunsRemoved = db.prepare(`
      DELETE FROM backup_runs
      WHERE status NOT IN ('running', 'validating') AND id IN (
        SELECT id FROM backup_runs
        WHERE status NOT IN ('running', 'validating')
        ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET 30
      )
    `).run().changes;
    const resolvedAlertsRemoved = db.prepare(`
      DELETE FROM health_alerts
      WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?
    `).run(alertCutoff).changes;
    return { operationNotificationsRemoved, backupRunsRemoved, resolvedAlertsRemoved };
  });
  return prune.immediate();
}

export function countUnrestoredTrashEntries(db: ZosDatabase): number {
  return Number(db.prepare(`
    SELECT COUNT(*) FROM trash_entries WHERE restored_at IS NULL
  `).pluck().get() ?? 0);
}
