use rusqlite::params;

use super::AlertStore;
use super::codec::{iso, sanitize_error};
use crate::error::AlerterError;

impl AlertStore {
    pub(super) fn finish_cycle(
        &self,
        now_ms: i64,
        error: Option<&str>,
    ) -> Result<(), AlerterError> {
        let pending: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM monitoring_alert_deliveries WHERE status IN ('pending', 'retrying', 'sending')",
            [],
            |row| row.get(0),
        )?;
        let degraded = error.is_some() || pending >= 10_000;
        self.connection.execute(
            "UPDATE monitoring_alerter_state SET status = ?, last_evaluation_at = ?, \
             pending_deliveries = ?, error = ?, updated_at = ? WHERE id = 1",
            params![
                if degraded { "degraded" } else { "ready" },
                iso(now_ms),
                pending,
                error.map(sanitize_error),
                iso(now_ms)
            ],
        )?;
        Ok(())
    }

    pub(super) fn maintain(&self, now_ms: i64) -> Result<(), AlerterError> {
        let incident_cutoff = iso(now_ms.saturating_sub(90 * 86_400_000));
        let attempt_cutoff = iso(now_ms.saturating_sub(30 * 86_400_000));
        let now = iso(now_ms);
        self.connection.execute(
            "UPDATE monitoring_alert_deliveries SET status = 'cancelled', \
             last_error = 'SMTP delivery is disabled', updated_at = ? \
             WHERE kind = 'test' AND status IN ('pending', 'retrying') \
               AND COALESCE((SELECT json_extract(value_json, '$.enabled') \
                 FROM system_settings WHERE key = 'monitoring_smtp'), 0) = 0",
            [&now],
        )?;
        self.connection.execute(
            "DELETE FROM monitoring_alert_delivery_attempts WHERE finished_at < ?",
            [&attempt_cutoff],
        )?;
        self.connection.execute(
            "DELETE FROM monitoring_alert_deliveries \
             WHERE kind = 'test' AND status IN ('succeeded', 'failed', 'cancelled') \
               AND updated_at < ?",
            [&attempt_cutoff],
        )?;
        self.connection.execute(
            "DELETE FROM monitoring_alert_silences \
             WHERE CASE WHEN cancelled_at IS NOT NULL AND cancelled_at < ends_at \
               THEN cancelled_at ELSE ends_at END < ?",
            [&incident_cutoff],
        )?;
        self.connection.execute(
            "DELETE FROM monitoring_alert_incidents WHERE status = 'resolved' AND resolved_at < ? \
             AND NOT EXISTS (SELECT 1 FROM monitoring_alert_deliveries \
               WHERE incident_id = monitoring_alert_incidents.id AND status IN ('pending','retrying','sending'))",
            [&incident_cutoff],
        )?;
        Ok(())
    }
}
