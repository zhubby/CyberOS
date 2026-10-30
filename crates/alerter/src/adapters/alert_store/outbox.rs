use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;

use super::AlertStore;
use super::codec::{iso, retry_delay, sanitize_error};
use super::deliveries::{
    add_event, missing_resolved_recipients, queue_resolved_delivery_for_recipients,
};
use crate::domain::delivery::{ClaimedDelivery, SmtpSecurity, SmtpSettings};
use crate::error::AlerterError;

const MAX_DELIVERY_ATTEMPTS: i64 = 12;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSmtpSettings {
    enabled: bool,
    host: String,
    port: u16,
    security: String,
    username: String,
    password: String,
    from: String,
    #[serde(default)]
    revision: Option<u64>,
}

impl AlertStore {
    pub(super) fn smtp_settings(&self) -> Result<SmtpSettings, AlerterError> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM system_settings WHERE key = 'monitoring_smtp'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(value) = value else {
            return Ok(SmtpSettings {
                enabled: false,
                host: String::new(),
                port: 587,
                security: SmtpSecurity::StartTls,
                username: String::new(),
                password: String::new(),
                from: String::new(),
            });
        };
        let value: StoredSmtpSettings = serde_json::from_str(&value)?;
        let security = match value.security.as_str() {
            "none" => SmtpSecurity::None,
            "starttls" => SmtpSecurity::StartTls,
            "tls" => SmtpSecurity::Tls,
            _ => {
                return Err(AlerterError::Config(
                    "SMTP security mode is invalid".to_owned(),
                ));
            }
        };
        let _revision = value.revision;
        Ok(SmtpSettings {
            enabled: value.enabled,
            host: value.host,
            port: value.port,
            security,
            username: value.username,
            password: value.password,
            from: value.from,
        })
    }

    pub(super) fn claim_delivery(
        &mut self,
        now_ms: i64,
    ) -> Result<Option<ClaimedDelivery>, AlerterError> {
        let transaction = self.connection.transaction()?;
        let now = iso(now_ms);
        let stale_before = iso(now_ms.saturating_sub(5 * 60_000));
        transaction.execute(
            "INSERT OR IGNORE INTO monitoring_alert_delivery_attempts(\
               delivery_id, attempt, status, error, started_at, finished_at\
             ) SELECT id, attempt_count, 'failed', 'Delivery interrupted after final attempt', \
               updated_at, ? FROM monitoring_alert_deliveries \
             WHERE status = 'sending' AND updated_at < ? AND attempt_count >= ?",
            params![now, stale_before, MAX_DELIVERY_ATTEMPTS],
        )?;
        transaction.execute(
            "UPDATE monitoring_alert_deliveries SET status = 'failed', \
             last_error = 'Delivery interrupted after final attempt', updated_at = ? \
             WHERE status = 'sending' AND updated_at < ? AND attempt_count >= ?",
            params![now, stale_before, MAX_DELIVERY_ATTEMPTS],
        )?;
        transaction.execute(
            "UPDATE monitoring_alert_deliveries SET status = 'retrying', due_at = ?, updated_at = ? \
             WHERE status = 'sending' AND updated_at < ? AND attempt_count < ?",
            params![now, now, stale_before, MAX_DELIVERY_ATTEMPTS],
        )?;
        transaction.execute(
            "UPDATE monitoring_alert_deliveries SET status = 'failed', \
             last_error = 'Delivery attempt limit reached', updated_at = ? \
             WHERE status IN ('pending', 'retrying') AND attempt_count >= ?",
            params![now, MAX_DELIVERY_ATTEMPTS],
        )?;
        transaction.execute(
            "UPDATE monitoring_alert_deliveries SET status = 'cancelled', updated_at = ? \
             WHERE status IN ('pending', 'retrying') AND kind <> 'resolved' AND incident_id IN (\
               SELECT id FROM monitoring_alert_incidents \
               WHERE acknowledged_at IS NOT NULL OR status = 'resolved'\
             )",
            [&now],
        )?;
        transaction.execute(
            "UPDATE monitoring_alert_deliveries SET status = 'cancelled', updated_at = ? \
             WHERE status IN ('pending', 'retrying') AND incident_id IN (\
               SELECT incidents.id FROM monitoring_alert_incidents incidents \
               JOIN monitoring_alert_silences silences ON silences.rule_id = incidents.rule_id \
                 AND (silences.series_key IS NULL OR silences.series_key = incidents.series_key) \
               WHERE silences.cancelled_at IS NULL AND silences.starts_at <= ? AND silences.ends_at > ?\
             )",
            params![now, now, now],
        )?;
        let row: Option<(String, String, String, String, String, i64)> = transaction
            .query_row(
                "SELECT id, message_id, recipients_json, subject, body_text, attempt_count \
                 FROM monitoring_alert_deliveries \
                 WHERE status IN ('pending', 'retrying') AND due_at <= ? AND attempt_count < ? \
                 ORDER BY due_at, created_at LIMIT 1",
                params![now, MAX_DELIVERY_ATTEMPTS],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((id, message_id, recipients_json, subject, body, attempts)) = row else {
            transaction.commit()?;
            return Ok(None);
        };
        transaction.execute(
            "UPDATE monitoring_alert_deliveries SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ? \
             WHERE id = ? AND status IN ('pending', 'retrying')",
            params![now, id],
        )?;
        transaction.commit()?;
        Ok(Some(ClaimedDelivery {
            id,
            message_id,
            recipients: serde_json::from_str(&recipients_json)?,
            subject,
            body,
            attempt: attempts + 1,
        }))
    }

    pub(super) fn finish_delivery(
        &mut self,
        delivery: &ClaimedDelivery,
        now_ms: i64,
        result: Result<(), &str>,
    ) -> Result<(), AlerterError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = iso(now_ms);
        let delivery_context: Option<(Option<String>, String)> = transaction
            .query_row(
                "SELECT incident_id, kind FROM monitoring_alert_deliveries WHERE id = ?",
                [&delivery.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let incident_id = delivery_context
            .as_ref()
            .and_then(|(incident_id, _)| incident_id.as_deref());
        match result {
            Ok(()) => {
                transaction.execute(
                    "UPDATE monitoring_alert_deliveries SET status = 'succeeded', sent_at = ?, \
                     last_error = NULL, updated_at = ? WHERE id = ? AND status = 'sending'",
                    params![now, now, delivery.id],
                )?;
                if let Some(incident_id) = incident_id {
                    add_event(&transaction, incident_id, "delivery_succeeded", &now)?;
                    if delivery_context
                        .as_ref()
                        .is_some_and(|(_, kind)| kind != "resolved")
                    {
                        let resolved_title: Option<String> = transaction
                            .query_row(
                                "SELECT title FROM monitoring_alert_incidents \
                                 WHERE id = ? AND status = 'resolved'",
                                [incident_id],
                                |row| row.get(0),
                            )
                            .optional()?;
                        if let Some(title) = resolved_title {
                            let recipients = missing_resolved_recipients(
                                &transaction,
                                incident_id,
                                &delivery.recipients,
                            )?;
                            queue_resolved_delivery_for_recipients(
                                &transaction,
                                incident_id,
                                &title,
                                &recipients,
                                &format!("resolved-after-{}", delivery.id),
                                &now,
                            )?;
                        }
                    }
                }
                transaction.execute(
                    "INSERT INTO monitoring_alert_delivery_attempts(\
                       delivery_id, attempt, status, started_at, finished_at\
                     ) VALUES (?, ?, 'succeeded', ?, ?)",
                    params![delivery.id, delivery.attempt, now, now],
                )?;
                transaction.execute(
                    "UPDATE monitoring_alerter_state SET last_delivery_at = ?, updated_at = ? WHERE id = 1",
                    params![now, now],
                )?;
            }
            Err(error) => {
                let safe_error = sanitize_error(error);
                let exhausted = delivery.attempt >= MAX_DELIVERY_ATTEMPTS;
                let delay = retry_delay(delivery.attempt);
                let next = iso(now_ms.saturating_add(delay * 1_000));
                transaction.execute(
                    "UPDATE monitoring_alert_deliveries SET status = ?, due_at = ?, last_error = ?, updated_at = ? \
                     WHERE id = ? AND status = 'sending'",
                    params![
                        if exhausted { "failed" } else { "retrying" },
                        next,
                        safe_error,
                        now,
                        delivery.id
                    ],
                )?;
                transaction.execute(
                    "INSERT INTO monitoring_alert_delivery_attempts(\
                       delivery_id, attempt, status, error, started_at, finished_at\
                     ) VALUES (?, ?, 'failed', ?, ?, ?)",
                    params![delivery.id, delivery.attempt, safe_error, now, now],
                )?;
                if exhausted && let Some(incident_id) = incident_id {
                    add_event(&transaction, incident_id, "delivery_failed", &now)?;
                }
            }
        }
        transaction.commit()?;
        Ok(())
    }
}
