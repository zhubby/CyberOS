use rusqlite::{Transaction, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::AlerterError;

pub(super) const MAX_PENDING_DELIVERIES: i64 = 10_000;

pub(super) fn queue_resolved_delivery(
    transaction: &Transaction<'_>,
    incident_id: &str,
    title: &str,
    now: &str,
) -> Result<(), AlerterError> {
    transaction.execute(
        "UPDATE monitoring_alert_deliveries SET status = 'cancelled', updated_at = ? \
         WHERE incident_id = ? AND kind <> 'resolved' AND status IN ('pending', 'retrying')",
        params![now, incident_id],
    )?;
    let recipients: Vec<String> = {
        let mut statement = transaction.prepare(
            "SELECT DISTINCT json_each.value FROM monitoring_alert_deliveries, \
             json_each(monitoring_alert_deliveries.recipients_json) \
             WHERE incident_id = ? AND status = 'succeeded'",
        )?;
        statement
            .query_map([incident_id], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    if recipients.is_empty() {
        return Ok(());
    }
    queue_resolved_delivery_for_recipients(
        transaction,
        incident_id,
        title,
        &recipients,
        "resolved",
        now,
    )
}

pub(super) fn missing_resolved_recipients(
    transaction: &Transaction<'_>,
    incident_id: &str,
    recipients: &[String],
) -> Result<Vec<String>, AlerterError> {
    let mut missing = Vec::new();
    for recipient in recipients {
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM monitoring_alert_deliveries delivery, \
                 json_each(delivery.recipients_json) recipient \
               WHERE delivery.incident_id = ? AND delivery.kind = 'resolved' \
                 AND delivery.status <> 'cancelled' AND recipient.value = ?\
             )",
            params![incident_id, recipient],
            |row| row.get(0),
        )?;
        if !exists {
            missing.push(recipient.clone());
        }
    }
    Ok(missing)
}

pub(super) fn queue_resolved_delivery_for_recipients(
    transaction: &Transaction<'_>,
    incident_id: &str,
    title: &str,
    recipients: &[String],
    key_suffix: &str,
    now: &str,
) -> Result<(), AlerterError> {
    if recipients.is_empty() {
        return Ok(());
    }
    let pending: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM monitoring_alert_deliveries \
         WHERE status IN ('pending', 'retrying', 'sending')",
        [],
        |row| row.get(0),
    )?;
    if pending >= MAX_PENDING_DELIVERIES {
        return Ok(());
    }
    let delivery_id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT OR IGNORE INTO monitoring_alert_deliveries(\
           id, incident_id, kind, idempotency_key, message_id, recipients_json, subject, body_text, \
           status, attempt_count, due_at, created_at, updated_at\
         ) VALUES (?, ?, 'resolved', ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
        params![
            delivery_id,
            incident_id,
            format!("{incident_id}:{key_suffix}"),
            format!("<zos-alert-{incident_id}-{key_suffix}@localhost>"),
            serde_json::to_string(recipients)?,
            format!("Resolved: {title}"),
            format!("ZOS alert resolved: {title}"),
            now,
            now,
            now
        ],
    )?;
    Ok(())
}

pub(super) fn add_event(
    transaction: &Transaction<'_>,
    incident_id: &str,
    kind: &str,
    now: &str,
) -> Result<(), AlerterError> {
    add_event_with_details(transaction, incident_id, kind, &json!({}), now)
}

pub(super) fn add_event_with_details(
    transaction: &Transaction<'_>,
    incident_id: &str,
    kind: &str,
    details: &Value,
    now: &str,
) -> Result<(), AlerterError> {
    transaction.execute(
        "INSERT INTO monitoring_alert_incident_events(incident_id, type, details_json, created_at) \
         VALUES (?, ?, ?, ?)",
        params![incident_id, kind, details.to_string(), now],
    )?;
    Ok(())
}
