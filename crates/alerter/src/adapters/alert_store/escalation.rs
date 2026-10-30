use std::collections::BTreeSet;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::AlertStore;
use super::codec::{iso, parse_iso};
use super::deliveries::MAX_PENDING_DELIVERIES;
use crate::error::AlerterError;

impl AlertStore {
    pub(super) fn schedule_due_deliveries(&mut self, now_ms: i64) -> Result<(), AlerterError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = iso(now_ms);
        let mut pending: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM monitoring_alert_deliveries WHERE status IN ('pending','retrying','sending')",
            [],
            |row| row.get(0),
        )?;
        if pending >= MAX_PENDING_DELIVERIES {
            return Err(AlerterError::AlertDeliveryCapacity);
        }
        let incidents = {
            let mut statement = transaction.prepare(
                "SELECT id, rule_id, series_key, title, firing_at, policy_snapshot_json \
                 FROM monitoring_alert_incidents WHERE status = 'firing' AND acknowledged_at IS NULL \
                 AND policy_snapshot_json IS NOT NULL ORDER BY firing_at",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (incident_id, rule_id, series_key, title, firing_at, snapshot_json) in incidents {
            if active_silence(&transaction, rule_id.as_deref(), &series_key, &now)? {
                continue;
            }
            let restart_at = escalation_restart_at(
                &transaction,
                rule_id.as_deref(),
                &series_key,
                &firing_at,
                &now,
            )?;
            let snapshot: PolicySnapshot = serde_json::from_str(&snapshot_json)?;
            for stage in &snapshot.stages {
                let repeat_total = if stage.repeat_count > 0 {
                    stage.repeat_count + 1
                } else {
                    1
                };
                for repeat in 0..repeat_total {
                    if pending >= MAX_PENDING_DELIVERIES {
                        transaction.commit()?;
                        return Err(AlerterError::AlertDeliveryCapacity);
                    }
                    let repeat_delay = if repeat == 0 {
                        0
                    } else {
                        stage.repeat_interval_seconds.unwrap_or_default() * i64::from(repeat)
                    };
                    let due_ms = parse_iso(&restart_at)
                        .saturating_add((stage.delay_seconds + repeat_delay).saturating_mul(1_000));
                    if due_ms > now_ms {
                        continue;
                    }
                    let (key, message_id) = escalation_delivery_identity(
                        &incident_id,
                        &restart_at,
                        stage.ordinal,
                        repeat,
                    );
                    let exists: bool = transaction.query_row(
                        "SELECT EXISTS(SELECT 1 FROM monitoring_alert_deliveries WHERE idempotency_key = ?)",
                        [&key],
                        |row| row.get(0),
                    )?;
                    if exists {
                        continue;
                    }
                    let recipients = resolve_targets(&transaction, &stage.targets, due_ms)?;
                    if recipients.is_empty() {
                        continue;
                    }
                    let id = Uuid::new_v4().to_string();
                    let kind = if repeat == 0 { "firing" } else { "reminder" };
                    transaction.execute(
                        "INSERT INTO monitoring_alert_deliveries(\
                           id, incident_id, kind, stage_ordinal, repeat_ordinal, idempotency_key, message_id, \
                           recipients_json, subject, body_text, status, attempt_count, due_at, created_at, updated_at\
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
                        params![
                            id,
                            incident_id,
                            kind,
                            stage.ordinal,
                            repeat,
                            key,
                            message_id,
                            serde_json::to_string(&recipients)?,
                            format!("CyberOS alert: {title}"),
                            format!("CyberOS alert is firing: {title}"),
                            iso(due_ms),
                            now,
                            now
                        ],
                    )?;
                    pending += 1;
                }
            }
        }
        transaction.commit()?;
        Ok(())
    }
}

pub(super) fn snapshot_policy(
    transaction: &Transaction<'_>,
    rule_id: &str,
) -> Result<Option<String>, AlerterError> {
    let policy_id: Option<String> = transaction.query_row(
        "SELECT escalation_policy_id FROM monitoring_alert_rules WHERE id = ?",
        [rule_id],
        |row| row.get(0),
    )?;
    let Some(policy_id) = policy_id else {
        return Ok(None);
    };
    snapshot_policy_id(transaction, &policy_id)
}

pub(super) fn snapshot_policy_id(
    transaction: &Transaction<'_>,
    policy_id: &str,
) -> Result<Option<String>, AlerterError> {
    let name: Option<String> = transaction
        .query_row(
            "SELECT name FROM monitoring_escalation_policies WHERE id = ? AND enabled = 1",
            [policy_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(name) = name else {
        return Ok(None);
    };
    let mut stages_statement = transaction.prepare(
        "SELECT id, ordinal, delay_seconds, repeat_interval_seconds, repeat_count \
         FROM monitoring_escalation_stages WHERE policy_id = ? ORDER BY ordinal",
    )?;
    let stages = stages_statement
        .query_map([policy_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut values = Vec::new();
    for (stage_id, ordinal, delay, repeat_interval, repeat_count) in stages {
        let mut target_statement = transaction.prepare(
            "SELECT target_type, target_id FROM monitoring_escalation_targets \
             WHERE stage_id = ? ORDER BY ordinal",
        )?;
        let targets = target_statement
            .query_map([stage_id], |row| {
                Ok(json!({
                    "type": row.get::<_, String>(0)?,
                    "id": row.get::<_, String>(1)?
                }))
            })?
            .collect::<Result<Vec<Value>, _>>()?;
        values.push(json!({
            "ordinal": ordinal,
            "delaySeconds": delay,
            "repeatIntervalSeconds": repeat_interval,
            "repeatCount": repeat_count,
            "targets": targets
        }));
    }
    Ok(Some(
        json!({ "id": policy_id, "name": name, "stages": values }).to_string(),
    ))
}

#[derive(Debug, Deserialize)]
pub(super) struct PolicySnapshot {
    pub(super) stages: Vec<PolicyStage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PolicyStage {
    pub(super) ordinal: i64,
    pub(super) delay_seconds: i64,
    pub(super) repeat_interval_seconds: Option<i64>,
    pub(super) repeat_count: i32,
    pub(super) targets: Vec<PolicyTarget>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PolicyTarget {
    #[serde(rename = "type")]
    kind: String,
    id: String,
}

pub(super) fn active_silence(
    transaction: &Transaction<'_>,
    rule_id: Option<&str>,
    series_key: &str,
    now: &str,
) -> Result<bool, AlerterError> {
    let Some(rule_id) = rule_id else {
        return Ok(false);
    };
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM monitoring_alert_silences \
             WHERE rule_id = ? AND (series_key IS NULL OR series_key = ?) \
             AND cancelled_at IS NULL AND starts_at <= ? AND ends_at > ?)",
            params![rule_id, series_key, now, now],
            |row| row.get(0),
        )
        .map_err(AlerterError::from)
}

pub(super) fn escalation_restart_at(
    transaction: &Transaction<'_>,
    rule_id: Option<&str>,
    series_key: &str,
    firing_at: &str,
    now: &str,
) -> Result<String, AlerterError> {
    let Some(rule_id) = rule_id else {
        return Ok(firing_at.to_owned());
    };
    let expired: Option<String> = transaction.query_row(
        "SELECT MAX(CASE WHEN cancelled_at IS NOT NULL AND cancelled_at < ends_at \
           THEN cancelled_at ELSE ends_at END) FROM monitoring_alert_silences \
         WHERE rule_id = ? AND (series_key IS NULL OR series_key = ?) \
         AND starts_at < CASE WHEN cancelled_at IS NOT NULL AND cancelled_at < ends_at \
           THEN cancelled_at ELSE ends_at END \
         AND CASE WHEN cancelled_at IS NOT NULL AND cancelled_at < ends_at \
           THEN cancelled_at ELSE ends_at END <= ? \
         AND CASE WHEN cancelled_at IS NOT NULL AND cancelled_at < ends_at \
           THEN cancelled_at ELSE ends_at END > ?",
        params![rule_id, series_key, now, firing_at],
        |row| row.get(0),
    )?;
    Ok(expired.unwrap_or_else(|| firing_at.to_owned()))
}

pub(super) fn escalation_delivery_identity(
    incident_id: &str,
    restart_at: &str,
    stage_ordinal: i64,
    repeat_ordinal: i32,
) -> (String, String) {
    let restart_epoch_ms = parse_iso(restart_at);
    (
        format!("{incident_id}:{restart_epoch_ms}:{stage_ordinal}:{repeat_ordinal}"),
        format!(
            "<cyberos-alert-{incident_id}-{restart_epoch_ms}-{stage_ordinal}-{repeat_ordinal}@localhost>"
        ),
    )
}

pub(super) fn resolve_targets(
    transaction: &Transaction<'_>,
    targets: &[PolicyTarget],
    now_ms: i64,
) -> Result<Vec<String>, AlerterError> {
    let mut recipients = BTreeSet::new();
    for target in targets {
        match target.kind.as_str() {
            "contact" => {
                if let Some(email) = contact_email(transaction, &target.id)? {
                    recipients.insert(email);
                }
            }
            "group" => {
                let mut statement = transaction.prepare(
                    "SELECT contacts.email FROM monitoring_alert_group_members members \
                     JOIN monitoring_alert_contacts contacts ON contacts.id = members.contact_id \
                     WHERE members.group_id = ? AND contacts.enabled = 1 ORDER BY members.ordinal",
                )?;
                for email in statement
                    .query_map([&target.id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?
                {
                    recipients.insert(email);
                }
            }
            "oncall" => {
                if let Some(contact_id) = oncall_contact(transaction, &target.id, now_ms)?
                    && let Some(email) = contact_email(transaction, &contact_id)?
                {
                    recipients.insert(email);
                }
            }
            _ => {}
        }
    }
    Ok(recipients.into_iter().collect())
}

fn contact_email(
    transaction: &Transaction<'_>,
    contact_id: &str,
) -> Result<Option<String>, AlerterError> {
    transaction
        .query_row(
            "SELECT email FROM monitoring_alert_contacts WHERE id = ? AND enabled = 1",
            [contact_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(AlerterError::from)
}

fn oncall_contact(
    transaction: &Transaction<'_>,
    schedule_id: &str,
    now_ms: i64,
) -> Result<Option<String>, AlerterError> {
    let now = iso(now_ms);
    let override_contact: Option<String> = transaction
        .query_row(
            "SELECT contact_id FROM monitoring_oncall_overrides \
             WHERE schedule_id = ? AND starts_at <= ? AND ends_at > ? \
             ORDER BY starts_at DESC, id DESC LIMIT 1",
            params![schedule_id, now, now],
            |row| row.get(0),
        )
        .optional()?;
    if override_contact.is_some() {
        return Ok(override_contact);
    }
    let schedule: Option<(String, i64, String, String)> = transaction
        .query_row(
            "SELECT timezone, handoff_weekday, handoff_time, anchor_date \
             FROM monitoring_oncall_schedules WHERE id = ?",
            [schedule_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((timezone, handoff_weekday, handoff_time, anchor_date)) = schedule else {
        return Ok(None);
    };
    let members = {
        let mut statement = transaction.prepare(
            "SELECT contact_id FROM monitoring_oncall_members WHERE schedule_id = ? ORDER BY ordinal",
        )?;
        statement
            .query_map([schedule_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    if members.is_empty() {
        return Ok(None);
    }
    let index = weekly_rotation_index(
        &timezone,
        handoff_weekday,
        &handoff_time,
        &anchor_date,
        now_ms,
        members.len(),
    )?;
    Ok(members.get(index).cloned())
}

pub(super) fn weekly_rotation_index(
    timezone: &str,
    handoff_weekday: i64,
    handoff_time: &str,
    anchor_date: &str,
    now_ms: i64,
    member_count: usize,
) -> Result<usize, AlerterError> {
    let anchor: jiff::civil::Date = anchor_date
        .parse()
        .map_err(|_| AlerterError::AlertRule("invalid on-call anchor date".to_owned()))?;
    let weekday = jiff::civil::Weekday::from_monday_one_offset(
        i8::try_from(handoff_weekday).unwrap_or_default(),
    )
    .map_err(|_| AlerterError::AlertRule("invalid on-call handoff weekday".to_owned()))?;
    if anchor.weekday() != weekday {
        return Err(AlerterError::AlertRule(
            "on-call anchor date does not match handoff weekday".to_owned(),
        ));
    }
    let handoff: jiff::civil::Time = format!("{handoff_time}:00")
        .parse()
        .map_err(|_| AlerterError::AlertRule("invalid on-call handoff time".to_owned()))?;
    let anchor = anchor
        .at(handoff.hour(), handoff.minute(), 0, 0)
        .in_tz(timezone)
        .map_err(|_| AlerterError::AlertRule("invalid on-call timezone".to_owned()))?;
    let now = jiff::Timestamp::new(
        now_ms.div_euclid(1_000),
        i32::try_from(now_ms.rem_euclid(1_000) * 1_000_000).unwrap_or_default(),
    )
    .map_err(|_| AlerterError::AlertRule("invalid on-call timestamp".to_owned()))?
    .in_tz(timezone)
    .map_err(|_| AlerterError::AlertRule("invalid on-call timezone".to_owned()))?;
    let weeks = now
        .datetime()
        .duration_since(anchor.datetime())
        .as_millis()
        .div_euclid(7 * 86_400_000);
    let count = i128::try_from(member_count).unwrap_or(1);
    Ok(usize::try_from(weeks.rem_euclid(count)).unwrap_or_default())
}
