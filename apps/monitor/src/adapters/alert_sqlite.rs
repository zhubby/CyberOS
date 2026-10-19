use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domain::alert::{
    Aggregation, AlertInstance, AlertRule, Comparator, EvaluationOutcome, InstanceState,
    MetricTransform, NoDataPolicy, Severity,
};
use crate::domain::delivery::{ClaimedDelivery, SmtpSecurity, SmtpSettings};
use crate::error::MonitorError;
use crate::ports::AlertRepository;

const MAX_ACTIVE_INSTANCES: i64 = 2_048;
const MAX_DELIVERY_ATTEMPTS: i64 = 12;
const RETRY_DELAYS_SECONDS: &[i64] = &[60, 300, 900, 3_600, 14_400, 43_200, 86_400];
const MAX_PENDING_DELIVERIES: i64 = 10_000;

pub struct AlertStore {
    connection: Connection,
}

impl AlertStore {
    pub fn open(path: &Path) -> Result<Self, MonitorError> {
        if !path.exists() {
            return Err(MonitorError::AlertSchemaUnavailable);
        }
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let ready: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'monitoring_alert_rules')",
            [],
            |row| row.get(0),
        )?;
        let silence_cancellation_ready: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('monitoring_alert_silences') \
             WHERE name = 'cancelled_at')",
            [],
            |row| row.get(0),
        )?;
        let rule_evaluation_ready: bool = connection.query_row(
            "SELECT COUNT(*) = 2 FROM pragma_table_info('monitoring_alert_rules') \
             WHERE name IN ('evaluation_error', 'last_evaluated_at')",
            [],
            |row| row.get(0),
        )?;
        let migrations_ready: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
            [],
            |row| row.get(0),
        )?;
        let unsilenced_event_ready = migrations_ready
            && connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = '031_monitoring_unsilenced_event')",
                [],
                |row| row.get::<_, bool>(0),
            )?;
        if !ready
            || !silence_cancellation_ready
            || !rule_evaluation_ready
            || !unsilenced_event_ready
        {
            return Err(MonitorError::AlertSchemaUnavailable);
        }
        Ok(Self { connection })
    }

    pub fn enabled_rules(&self) -> Result<Vec<AlertRule>, MonitorError> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, metric, selector_json, transform, aggregation, window_seconds, \
             comparator, trigger_threshold, recovery_threshold, trigger_duration_seconds, \
             recovery_duration_seconds, severity, no_data_policy \
             FROM monitoring_alert_rules WHERE enabled = 1 AND deleted_at IS NULL ORDER BY id",
        )?;
        statement
            .query_map([], |row| {
                let selector_json: String = row.get(3)?;
                Ok(AlertRule {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    metric: row.get(2)?,
                    selector: serde_json::from_str(&selector_json).unwrap_or_default(),
                    transform: parse_transform(row.get::<_, String>(4)?.as_str()),
                    aggregation: parse_aggregation(row.get::<_, String>(5)?.as_str()),
                    window: Duration::from_secs(
                        u64::try_from(row.get::<_, i64>(6)?).unwrap_or_default(),
                    ),
                    comparator: parse_comparator(row.get::<_, String>(7)?.as_str()),
                    trigger_threshold: row.get(8)?,
                    recovery_threshold: row.get(9)?,
                    trigger_duration: Duration::from_secs(
                        u64::try_from(row.get::<_, i64>(10)?).unwrap_or_default(),
                    ),
                    recovery_duration: Duration::from_secs(
                        u64::try_from(row.get::<_, i64>(11)?).unwrap_or_default(),
                    ),
                    severity: parse_severity(row.get::<_, String>(12)?.as_str()),
                    no_data: parse_no_data(row.get::<_, String>(13)?.as_str()),
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(MonitorError::from)
    }

    pub fn apply_metric_evaluation(
        &mut self,
        rule: &AlertRule,
        series_key: &str,
        labels: &BTreeMap<String, String>,
        value: Option<f64>,
        now_ms: i64,
    ) -> Result<(), MonitorError> {
        let transaction = self.connection.transaction()?;
        let existing = read_instance(&transaction, &rule.id, series_key)?;
        let was_active = existing.as_ref().is_some_and(|instance| {
            matches!(
                instance.state,
                InstanceState::Pending | InstanceState::Firing | InstanceState::Recovering
            )
        });
        let mut instance = existing.unwrap_or_else(|| AlertInstance::normal(now_ms));
        let outcome = instance.evaluate(rule, value, now_ms);
        let is_active = matches!(
            instance.state,
            InstanceState::Pending | InstanceState::Firing | InstanceState::Recovering
        );
        if !was_active && is_active {
            let count: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM monitoring_alert_instances WHERE state IN ('pending', 'firing', 'recovering')",
                [],
                |row| row.get(0),
            )?;
            if count >= MAX_ACTIVE_INSTANCES {
                return Err(MonitorError::AlertCapacity);
            }
        }
        let now = iso(now_ms);
        let labels_json = serde_json::to_string(labels)?;
        let mut incident_id = active_incident_id(&transaction, &rule.id, series_key)?;
        match outcome {
            EvaluationOutcome::Fired => {
                if incident_id.is_none() {
                    let id = Uuid::new_v4().to_string();
                    let snapshot = serde_json::to_string(rule)?;
                    let policy = snapshot_policy(&transaction, &rule.id)?;
                    transaction.execute(
                        "INSERT INTO monitoring_alert_incidents(\
                           id, source, rule_id, series_key, labels_json, status, severity, title, current_value, \
                           firing_at, rule_snapshot_json, policy_snapshot_json, created_at, updated_at\
                         ) VALUES (?, 'metric', ?, ?, ?, 'firing', ?, ?, ?, ?, ?, ?, ?, ?)",
                        params![
                            id,
                            rule.id,
                            series_key,
                            labels_json,
                            severity(rule.severity),
                            rule.name,
                            value,
                            now,
                            snapshot,
                            policy,
                            now,
                            now
                        ],
                    )?;
                    add_event(&transaction, &id, "fired", &now)?;
                    incident_id = Some(id);
                }
            }
            EvaluationOutcome::Resolved => {
                if let Some(id) = incident_id.as_deref() {
                    transaction.execute(
                        "UPDATE monitoring_alert_incidents SET status = 'resolved', resolved_at = ?, \
                         close_reason = 'recovered', current_value = ?, updated_at = ? WHERE id = ?",
                        params![now, value, now, id],
                    )?;
                    add_event(&transaction, id, "recovered", &now)?;
                    queue_resolved_delivery(&transaction, id, &rule.name, &now)?;
                }
            }
            EvaluationOutcome::Unchanged | EvaluationOutcome::StateChanged(_) => {
                if let Some(id) = incident_id.as_deref() {
                    transaction.execute(
                        "UPDATE monitoring_alert_incidents SET current_value = ?, updated_at = ? WHERE id = ?",
                        params![value, now, id],
                    )?;
                }
            }
        }
        transaction.execute(
            "INSERT INTO monitoring_alert_instances(\
               rule_id, series_key, labels_json, state, state_since, last_evaluated_at, last_value, incident_id, error\
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) \
             ON CONFLICT(rule_id, series_key) DO UPDATE SET \
               labels_json = excluded.labels_json, state = excluded.state, state_since = excluded.state_since, \
               last_evaluated_at = excluded.last_evaluated_at, last_value = excluded.last_value, \
               incident_id = excluded.incident_id, error = NULL",
            params![
                rule.id,
                series_key,
                labels_json,
                instance_state(instance.state),
                iso(instance.state_since_ms),
                now,
                value,
                incident_id
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_rule_error(
        &self,
        rule_id: &str,
        message: &str,
        now_ms: i64,
    ) -> Result<(), MonitorError> {
        self.connection.execute(
            "UPDATE monitoring_alert_rules SET evaluation_error = ?, last_evaluated_at = ? WHERE id = ?",
            params![sanitize_error(message), iso(now_ms), rule_id],
        )?;
        Ok(())
    }

    pub fn clear_rule_error(&self, rule_id: &str, now_ms: i64) -> Result<(), MonitorError> {
        self.connection.execute(
            "UPDATE monitoring_alert_rules SET evaluation_error = NULL, last_evaluated_at = ? WHERE id = ?",
            params![iso(now_ms), rule_id],
        )?;
        Ok(())
    }

    pub fn sync_health_incidents(&mut self, now_ms: i64) -> Result<(), MonitorError> {
        let transaction = self.connection.transaction()?;
        let initialized: bool = transaction.query_row(
            "SELECT health_initialized FROM monitoring_alerter_state WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let now = iso(now_ms);
        let active = {
            let mut statement = transaction.prepare(
                "SELECT id, code, scope, severity, details FROM health_alerts WHERE status = 'active'",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (health_id, code, scope, severity, details) in &active {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM monitoring_alert_incidents WHERE health_alert_id = ? AND status = 'firing')",
                [health_id],
                |row| row.get(0),
            )?;
            if exists {
                continue;
            }
            let id = Uuid::new_v4().to_string();
            let series_key = format!("{code}:{scope}");
            let title = format!("Health: {code}");
            let snapshot = json!({ "code": code, "scope": scope, "details": details });
            let policy_snapshot = if initialized {
                let setting: String = transaction.query_row(
                    "SELECT value_json FROM system_settings WHERE key = 'monitoring_health_routing'",
                    [],
                    |row| row.get(0),
                )?;
                let setting: Value = serde_json::from_str(&setting)?;
                let key = if severity == "critical" {
                    "criticalPolicyId"
                } else {
                    "warningPolicyId"
                };
                setting
                    .get(key)
                    .and_then(Value::as_str)
                    .map(|policy_id| snapshot_policy_id(&transaction, policy_id))
                    .transpose()?
                    .flatten()
            } else {
                None
            };
            transaction.execute(
                "INSERT INTO monitoring_alert_incidents(\
                   id, source, health_alert_id, series_key, status, severity, title, firing_at, read_at, \
                   rule_snapshot_json, policy_snapshot_json, created_at, updated_at\
                 ) VALUES (?, 'health', ?, ?, 'firing', ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    id,
                    health_id,
                    series_key,
                    severity,
                    title,
                    now,
                    if initialized { None::<String> } else { Some(now.clone()) },
                    snapshot.to_string(),
                    policy_snapshot,
                    now,
                    now
                ],
            )?;
            if initialized {
                add_event(&transaction, &id, "fired", &now)?;
            } else {
                add_event_with_details(
                    &transaction,
                    &id,
                    "fired",
                    &json!({ "imported": true }),
                    &now,
                )?;
            }
        }
        let resolved = {
            let mut statement = transaction.prepare(
                "SELECT id, title FROM monitoring_alert_incidents \
                 WHERE source = 'health' AND status = 'firing' AND health_alert_id NOT IN (\
                   SELECT id FROM health_alerts WHERE status = 'active'\
                 )",
            )?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (incident_id, title) in resolved {
            transaction.execute(
                "UPDATE monitoring_alert_incidents SET status = 'resolved', resolved_at = ?, \
                 close_reason = 'health_resolved', updated_at = ? WHERE id = ?",
                params![now, now, incident_id],
            )?;
            add_event(&transaction, &incident_id, "recovered", &now)?;
            queue_resolved_delivery(&transaction, &incident_id, &title, &now)?;
        }
        transaction.execute(
            "UPDATE monitoring_alerter_state SET health_initialized = 1, updated_at = ? WHERE id = 1",
            [&now],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn schedule_due_deliveries(&mut self, now_ms: i64) -> Result<(), MonitorError> {
        let transaction = self.connection.transaction()?;
        let now = iso(now_ms);
        let mut pending: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM monitoring_alert_deliveries WHERE status IN ('pending','retrying','sending')",
            [],
            |row| row.get(0),
        )?;
        if pending >= MAX_PENDING_DELIVERIES {
            return Err(MonitorError::AlertDeliveryCapacity);
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
                        return Err(MonitorError::AlertDeliveryCapacity);
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
                            format!("ZOS alert: {title}"),
                            format!("ZOS alert is firing: {title}"),
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

    pub fn finish_cycle(&self, now_ms: i64, error: Option<&str>) -> Result<(), MonitorError> {
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

    pub fn smtp_settings(&self) -> Result<SmtpSettings, MonitorError> {
        let value: String = self.connection.query_row(
            "SELECT value_json FROM system_settings WHERE key = 'monitoring_smtp'",
            [],
            |row| row.get(0),
        )?;
        let value: Value = serde_json::from_str(&value)?;
        let port = value.get("port").and_then(Value::as_u64).unwrap_or(587);
        Ok(SmtpSettings {
            enabled: value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            host: json_string(&value, "host"),
            port: u16::try_from(port).unwrap_or(587),
            security: match value.get("security").and_then(Value::as_str) {
                Some("none") => SmtpSecurity::None,
                Some("tls") => SmtpSecurity::Tls,
                _ => SmtpSecurity::StartTls,
            },
            username: json_string(&value, "username"),
            password: json_string(&value, "password"),
            from: json_string(&value, "from"),
        })
    }

    pub fn claim_delivery(&mut self, now_ms: i64) -> Result<Option<ClaimedDelivery>, MonitorError> {
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

    pub fn finish_delivery(
        &mut self,
        delivery: &ClaimedDelivery,
        now_ms: i64,
        result: Result<(), &str>,
    ) -> Result<(), MonitorError> {
        let transaction = self.connection.transaction()?;
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

    pub fn maintain(&self, now_ms: i64) -> Result<(), MonitorError> {
        let incident_cutoff = iso(now_ms.saturating_sub(90 * 86_400_000));
        let attempt_cutoff = iso(now_ms.saturating_sub(30 * 86_400_000));
        self.connection.execute(
            "DELETE FROM monitoring_alert_delivery_attempts WHERE finished_at < ?",
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

impl AlertRepository for AlertStore {
    fn enabled_rules(&self) -> Result<Vec<AlertRule>, MonitorError> {
        Self::enabled_rules(self)
    }

    fn apply_metric_evaluation(
        &mut self,
        rule: &AlertRule,
        series_key: &str,
        labels: &BTreeMap<String, String>,
        value: Option<f64>,
        now_ms: i64,
    ) -> Result<(), MonitorError> {
        Self::apply_metric_evaluation(self, rule, series_key, labels, value, now_ms)
    }

    fn mark_rule_error(
        &self,
        rule_id: &str,
        message: &str,
        now_ms: i64,
    ) -> Result<(), MonitorError> {
        Self::mark_rule_error(self, rule_id, message, now_ms)
    }

    fn clear_rule_error(&self, rule_id: &str, now_ms: i64) -> Result<(), MonitorError> {
        Self::clear_rule_error(self, rule_id, now_ms)
    }

    fn sync_health_incidents(&mut self, now_ms: i64) -> Result<(), MonitorError> {
        Self::sync_health_incidents(self, now_ms)
    }

    fn schedule_due_deliveries(&mut self, now_ms: i64) -> Result<(), MonitorError> {
        Self::schedule_due_deliveries(self, now_ms)
    }

    fn maintain(&self, now_ms: i64) -> Result<(), MonitorError> {
        Self::maintain(self, now_ms)
    }

    fn finish_cycle(&self, now_ms: i64, error: Option<&str>) -> Result<(), MonitorError> {
        Self::finish_cycle(self, now_ms, error)
    }

    fn smtp_settings(&self) -> Result<SmtpSettings, MonitorError> {
        Self::smtp_settings(self)
    }

    fn claim_delivery(&mut self, now_ms: i64) -> Result<Option<ClaimedDelivery>, MonitorError> {
        Self::claim_delivery(self, now_ms)
    }

    fn finish_delivery(
        &mut self,
        delivery: &ClaimedDelivery,
        now_ms: i64,
        error: Option<&str>,
    ) -> Result<(), MonitorError> {
        Self::finish_delivery(self, delivery, now_ms, error.map_or(Ok(()), Err))
    }
}

fn read_instance(
    transaction: &Transaction<'_>,
    rule_id: &str,
    series_key: &str,
) -> Result<Option<AlertInstance>, MonitorError> {
    transaction
        .query_row(
            "SELECT state, state_since, last_value FROM monitoring_alert_instances \
             WHERE rule_id = ? AND series_key = ?",
            params![rule_id, series_key],
            |row| {
                let state: String = row.get(0)?;
                let since: String = row.get(1)?;
                Ok(AlertInstance {
                    state: parse_instance_state(&state),
                    state_since_ms: parse_iso(&since),
                    last_value: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(MonitorError::from)
}

fn active_incident_id(
    transaction: &Transaction<'_>,
    rule_id: &str,
    series_key: &str,
) -> Result<Option<String>, MonitorError> {
    transaction
        .query_row(
            "SELECT id FROM monitoring_alert_incidents \
             WHERE rule_id = ? AND series_key = ? AND status = 'firing'",
            params![rule_id, series_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(MonitorError::from)
}

fn snapshot_policy(
    transaction: &Transaction<'_>,
    rule_id: &str,
) -> Result<Option<String>, MonitorError> {
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

fn snapshot_policy_id(
    transaction: &Transaction<'_>,
    policy_id: &str,
) -> Result<Option<String>, MonitorError> {
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
struct PolicySnapshot {
    stages: Vec<PolicyStage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyStage {
    ordinal: i64,
    delay_seconds: i64,
    repeat_interval_seconds: Option<i64>,
    repeat_count: i32,
    targets: Vec<PolicyTarget>,
}

#[derive(Debug, Deserialize)]
struct PolicyTarget {
    #[serde(rename = "type")]
    kind: String,
    id: String,
}

fn active_silence(
    transaction: &Transaction<'_>,
    rule_id: Option<&str>,
    series_key: &str,
    now: &str,
) -> Result<bool, MonitorError> {
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
        .map_err(MonitorError::from)
}

fn escalation_restart_at(
    transaction: &Transaction<'_>,
    rule_id: Option<&str>,
    series_key: &str,
    firing_at: &str,
    now: &str,
) -> Result<String, MonitorError> {
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

fn escalation_delivery_identity(
    incident_id: &str,
    restart_at: &str,
    stage_ordinal: i64,
    repeat_ordinal: i32,
) -> (String, String) {
    let restart_epoch_ms = parse_iso(restart_at);
    (
        format!("{incident_id}:{restart_epoch_ms}:{stage_ordinal}:{repeat_ordinal}"),
        format!(
            "<zos-alert-{incident_id}-{restart_epoch_ms}-{stage_ordinal}-{repeat_ordinal}@localhost>"
        ),
    )
}

fn resolve_targets(
    transaction: &Transaction<'_>,
    targets: &[PolicyTarget],
    now_ms: i64,
) -> Result<Vec<String>, MonitorError> {
    let mut recipients = std::collections::BTreeSet::new();
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
) -> Result<Option<String>, MonitorError> {
    transaction
        .query_row(
            "SELECT email FROM monitoring_alert_contacts WHERE id = ? AND enabled = 1",
            [contact_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(MonitorError::from)
}

fn oncall_contact(
    transaction: &Transaction<'_>,
    schedule_id: &str,
    now_ms: i64,
) -> Result<Option<String>, MonitorError> {
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

fn weekly_rotation_index(
    timezone: &str,
    handoff_weekday: i64,
    handoff_time: &str,
    anchor_date: &str,
    now_ms: i64,
    member_count: usize,
) -> Result<usize, MonitorError> {
    let anchor: jiff::civil::Date = anchor_date
        .parse()
        .map_err(|_| MonitorError::AlertRule("invalid on-call anchor date".to_owned()))?;
    let weekday = jiff::civil::Weekday::from_monday_one_offset(
        i8::try_from(handoff_weekday).unwrap_or_default(),
    )
    .map_err(|_| MonitorError::AlertRule("invalid on-call handoff weekday".to_owned()))?;
    if anchor.weekday() != weekday {
        return Err(MonitorError::AlertRule(
            "on-call anchor date does not match handoff weekday".to_owned(),
        ));
    }
    let handoff: jiff::civil::Time = format!("{handoff_time}:00")
        .parse()
        .map_err(|_| MonitorError::AlertRule("invalid on-call handoff time".to_owned()))?;
    let anchor = anchor
        .at(handoff.hour(), handoff.minute(), 0, 0)
        .in_tz(timezone)
        .map_err(|_| MonitorError::AlertRule("invalid on-call timezone".to_owned()))?;
    let now = jiff::Timestamp::new(
        now_ms.div_euclid(1_000),
        i32::try_from(now_ms.rem_euclid(1_000) * 1_000_000).unwrap_or_default(),
    )
    .map_err(|_| MonitorError::AlertRule("invalid on-call timestamp".to_owned()))?
    .in_tz(timezone)
    .map_err(|_| MonitorError::AlertRule("invalid on-call timezone".to_owned()))?;
    let weeks = now
        .datetime()
        .duration_since(anchor.datetime())
        .as_millis()
        .div_euclid(7 * 86_400_000);
    let count = i128::try_from(member_count).unwrap_or(1);
    Ok(usize::try_from(weeks.rem_euclid(count)).unwrap_or_default())
}

fn queue_resolved_delivery(
    transaction: &Transaction<'_>,
    incident_id: &str,
    title: &str,
    now: &str,
) -> Result<(), MonitorError> {
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

fn missing_resolved_recipients(
    transaction: &Transaction<'_>,
    incident_id: &str,
    recipients: &[String],
) -> Result<Vec<String>, MonitorError> {
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

fn queue_resolved_delivery_for_recipients(
    transaction: &Transaction<'_>,
    incident_id: &str,
    title: &str,
    recipients: &[String],
    key_suffix: &str,
    now: &str,
) -> Result<(), MonitorError> {
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

fn add_event(
    transaction: &Transaction<'_>,
    incident_id: &str,
    kind: &str,
    now: &str,
) -> Result<(), MonitorError> {
    add_event_with_details(transaction, incident_id, kind, &json!({}), now)
}

fn add_event_with_details(
    transaction: &Transaction<'_>,
    incident_id: &str,
    kind: &str,
    details: &Value,
    now: &str,
) -> Result<(), MonitorError> {
    transaction.execute(
        "INSERT INTO monitoring_alert_incident_events(incident_id, type, details_json, created_at) \
         VALUES (?, ?, ?, ?)",
        params![incident_id, kind, details.to_string(), now],
    )?;
    Ok(())
}

fn iso(timestamp_ms: i64) -> String {
    let seconds = timestamp_ms.div_euclid(1_000);
    let milliseconds = timestamp_ms.rem_euclid(1_000);
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|value| value.replace_millisecond(milliseconds as u16).ok())
        .and_then(|value| {
            value
                .format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_owned())
}

fn parse_iso(value: &str) -> i64 {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .ok()
        .and_then(|value| i64::try_from(value.unix_timestamp_nanos() / 1_000_000).ok())
        .unwrap_or_default()
}

fn sanitize_error(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.to_ascii_lowercase().contains("password") {
        return "Alert operation failed".to_owned();
    }
    normalized.chars().take(240).collect()
}

fn json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn retry_delay(attempt: i64) -> i64 {
    let index = usize::try_from(attempt.saturating_sub(1)).unwrap_or_default();
    *RETRY_DELAYS_SECONDS
        .get(index)
        .unwrap_or(RETRY_DELAYS_SECONDS.last().expect("retry delays"))
}

fn parse_transform(value: &str) -> MetricTransform {
    if value == "rate" {
        MetricTransform::Rate
    } else {
        MetricTransform::Value
    }
}
fn parse_aggregation(value: &str) -> Aggregation {
    match value {
        "avg" => Aggregation::Avg,
        "min" => Aggregation::Min,
        "max" => Aggregation::Max,
        _ => Aggregation::Last,
    }
}
fn parse_comparator(value: &str) -> Comparator {
    match value {
        ">=" => Comparator::GreaterOrEqual,
        "<" => Comparator::Less,
        "<=" => Comparator::LessOrEqual,
        _ => Comparator::Greater,
    }
}
fn parse_severity(value: &str) -> Severity {
    if value == "critical" {
        Severity::Critical
    } else {
        Severity::Warning
    }
}
fn parse_no_data(value: &str) -> NoDataPolicy {
    if value == "firing" {
        NoDataPolicy::Firing
    } else {
        NoDataPolicy::Ignore
    }
}
fn parse_instance_state(value: &str) -> InstanceState {
    match value {
        "pending" => InstanceState::Pending,
        "firing" => InstanceState::Firing,
        "recovering" => InstanceState::Recovering,
        "resolved" => InstanceState::Resolved,
        _ => InstanceState::Normal,
    }
}
fn instance_state(value: InstanceState) -> &'static str {
    match value {
        InstanceState::Normal => "normal",
        InstanceState::Pending => "pending",
        InstanceState::Firing => "firing",
        InstanceState::Recovering => "recovering",
        InstanceState::Resolved => "resolved",
    }
}
fn severity(value: Severity) -> &'static str {
    match value {
        Severity::Warning => "warning",
        Severity::Critical => "critical",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn timestamp_ms(value: &str) -> i64 {
        parse_iso(value)
    }

    #[test]
    fn weekly_rotation_uses_local_civil_weeks_across_dst() {
        assert_eq!(
            weekly_rotation_index(
                "America/New_York",
                1,
                "09:00",
                "2026-03-02",
                timestamp_ms("2026-03-09T13:00:00Z"),
                3,
            )
            .unwrap(),
            1
        );
        assert_eq!(
            weekly_rotation_index(
                "America/New_York",
                1,
                "09:00",
                "2026-03-02",
                timestamp_ms("2026-03-16T13:00:00Z"),
                3,
            )
            .unwrap(),
            2
        );
    }

    #[test]
    fn weekly_rotation_rejects_a_misaligned_anchor_date() {
        let result = weekly_rotation_index(
            "Asia/Shanghai",
            2,
            "09:00",
            "2026-03-02",
            timestamp_ms("2026-03-09T01:00:00Z"),
            2,
        );
        assert!(matches!(result, Err(MonitorError::AlertRule(_))));
    }

    #[test]
    fn retry_schedule_caps_at_twenty_four_hours() {
        assert_eq!(retry_delay(1), 60);
        assert_eq!(retry_delay(7), 86_400);
        assert_eq!(retry_delay(12), 86_400);
    }

    #[test]
    fn open_waits_for_the_latest_alert_migrations() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("zos.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE monitoring_alert_rules(id TEXT PRIMARY KEY);\
                 CREATE TABLE monitoring_alert_silences(\
                   id TEXT PRIMARY KEY, rule_id TEXT, starts_at TEXT, ends_at TEXT\
                 );",
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            AlertStore::open(&path),
            Err(MonitorError::AlertSchemaUnavailable)
        ));
    }

    #[test]
    fn open_does_not_create_the_main_database_before_api_migration() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("zos.sqlite");

        assert!(matches!(
            AlertStore::open(&path),
            Err(MonitorError::AlertSchemaUnavailable)
        ));
        assert!(!path.exists());
    }

    #[test]
    fn rule_errors_are_persisted_without_an_existing_instance() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE monitoring_alert_rules(\
                   id TEXT PRIMARY KEY, evaluation_error TEXT, last_evaluated_at TEXT\
                 );\
                 INSERT INTO monitoring_alert_rules(id) VALUES ('rule-1');",
            )
            .unwrap();
        let store = AlertStore { connection };
        let now_ms = timestamp_ms("2026-03-10T00:00:00Z");

        store
            .mark_rule_error("rule-1", "Alert rule expands beyond 64 series", now_ms)
            .unwrap();
        let error: Option<String> = store
            .connection
            .query_row(
                "SELECT evaluation_error FROM monitoring_alert_rules WHERE id = 'rule-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            error.as_deref(),
            Some("Alert rule expands beyond 64 series")
        );

        store.clear_rule_error("rule-1", now_ms + 10_000).unwrap();
        let row: (Option<String>, String) = store
            .connection
            .query_row(
                "SELECT evaluation_error, last_evaluated_at FROM monitoring_alert_rules WHERE id = 'rule-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, (None, "2026-03-10T00:00:10Z".to_owned()));
    }

    #[test]
    fn first_health_sync_marks_active_incidents_as_imported_and_read() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE monitoring_alerter_state(\
                   id INTEGER PRIMARY KEY, health_initialized INTEGER, updated_at TEXT\
                 );\
                 INSERT INTO monitoring_alerter_state VALUES (1, 0, '2026-03-10T00:00:00Z');\
                 CREATE TABLE health_alerts(\
                   id TEXT PRIMARY KEY, code TEXT, scope TEXT, severity TEXT, details TEXT, status TEXT\
                 );\
                 INSERT INTO health_alerts VALUES (\
                   'health-1', 'nas_unavailable', 'primary', 'critical', 'offline', 'active'\
                 );\
                 CREATE TABLE monitoring_alert_incidents(\
                   id TEXT PRIMARY KEY, source TEXT, rule_id TEXT, health_alert_id TEXT, series_key TEXT,\
                   status TEXT, severity TEXT, title TEXT, firing_at TEXT, read_at TEXT,\
                   rule_snapshot_json TEXT, policy_snapshot_json TEXT, created_at TEXT, updated_at TEXT,\
                   resolved_at TEXT, close_reason TEXT\
                 );\
                 CREATE TABLE monitoring_alert_incident_events(\
                   id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT, type TEXT, details_json TEXT,\
                   created_at TEXT\
                 );\
                 CREATE TABLE monitoring_alert_deliveries(\
                   id TEXT PRIMARY KEY, incident_id TEXT, status TEXT, recipients_json TEXT\
                 );",
            )
            .unwrap();
        let mut store = AlertStore { connection };

        store
            .sync_health_incidents(timestamp_ms("2026-03-10T00:00:00Z"))
            .unwrap();

        let read_at: Option<String> = store
            .connection
            .query_row(
                "SELECT read_at FROM monitoring_alert_incidents WHERE health_alert_id = 'health-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let details: String = store
            .connection
            .query_row(
                "SELECT details_json FROM monitoring_alert_incident_events WHERE type = 'fired'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(read_at.is_some());
        assert_eq!(
            serde_json::from_str::<Value>(&details).unwrap(),
            json!({ "imported": true })
        );
    }

    #[test]
    fn claim_cancels_delivery_covered_by_an_active_silence() {
        let mut store = delivery_test_store();
        let now_ms = timestamp_ms("2026-03-10T00:00:00Z");
        let now = iso(now_ms);
        store
            .connection
            .execute(
                "INSERT INTO monitoring_alert_incidents(id, rule_id, series_key) \
                 VALUES ('incident-1', 'rule-1', 'series-1')",
                [],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO monitoring_alert_silences(\
                   id, rule_id, series_key, starts_at, ends_at, cancelled_at\
                 ) VALUES ('silence-1', 'rule-1', NULL, ?, ?, NULL)",
                params![iso(now_ms - 60_000), iso(now_ms + 60_000),],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO monitoring_alert_deliveries(\
                   id, incident_id, message_id, recipients_json, subject, body_text, attempt_count, \
                   status, due_at, created_at, updated_at\
                 ) VALUES ('delivery-1', 'incident-1', '<delivery-1@localhost>', '[\"a@example.test\"]', \
                   'Alert', 'Alert', 0, 'pending', ?, ?, ?)",
                params![now, now, now],
            )
            .unwrap();

        assert!(store.claim_delivery(now_ms).unwrap().is_none());
        let status: String = store
            .connection
            .query_row(
                "SELECT status FROM monitoring_alert_deliveries WHERE id = 'delivery-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "cancelled");
    }

    #[test]
    fn escalation_restarts_when_an_active_silence_is_ended_early() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE monitoring_alert_silences(\
                   id TEXT PRIMARY KEY, rule_id TEXT, series_key TEXT, starts_at TEXT, ends_at TEXT, \
                   cancelled_at TEXT\
                 );\
                 INSERT INTO monitoring_alert_silences VALUES (\
                   'silence-1', 'rule-1', NULL, '2026-03-10T00:05:00Z', \
                   '2026-03-10T02:00:00Z', '2026-03-10T00:30:00Z'\
                 );",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();

        let restart = escalation_restart_at(
            &transaction,
            Some("rule-1"),
            "series-1",
            "2026-03-10T00:00:00Z",
            "2026-03-10T00:45:00Z",
        )
        .unwrap();

        assert_eq!(restart, "2026-03-10T00:30:00Z");
    }

    #[test]
    fn escalation_restart_uses_a_distinct_stable_delivery_identity() {
        let first = escalation_delivery_identity("incident-1", "2026-03-10T00:00:00Z", 0, 0);
        let restarted = escalation_delivery_identity("incident-1", "2026-03-10T00:30:00Z", 0, 0);

        assert_eq!(
            first,
            escalation_delivery_identity("incident-1", "2026-03-10T00:00:00Z", 0, 0)
        );
        assert_ne!(first.0, restarted.0);
        assert_ne!(first.1, restarted.1);

        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE deliveries(idempotency_key TEXT UNIQUE, message_id TEXT UNIQUE);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO deliveries(idempotency_key, message_id) VALUES (?, ?)",
                params![first.0, first.1],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO deliveries(idempotency_key, message_id) VALUES (?, ?)",
                params![restarted.0, restarted.1],
            )
            .unwrap();
    }

    #[test]
    fn resolving_an_incident_cancels_stale_alert_mail_and_notifies_only_delivered_recipients() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE monitoring_alert_deliveries(\
                   id TEXT PRIMARY KEY, incident_id TEXT, kind TEXT, stage_ordinal INTEGER, \
                   repeat_ordinal INTEGER, idempotency_key TEXT UNIQUE, message_id TEXT UNIQUE, \
                   recipients_json TEXT, subject TEXT, body_text TEXT, status TEXT, \
                   attempt_count INTEGER, due_at TEXT, sent_at TEXT, last_error TEXT, \
                   created_at TEXT, updated_at TEXT\
                 );\
                 INSERT INTO monitoring_alert_deliveries(\
                   id, incident_id, kind, idempotency_key, message_id, recipients_json, subject, \
                   body_text, status, attempt_count, due_at, created_at, updated_at\
                 ) VALUES\
                   ('sent', 'incident-1', 'firing', 'sent-key', '<sent@localhost>', \
                    '[\"sent@example.test\"]', 'Alert', 'Alert', 'succeeded', 1, \
                    '2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z'),\
                   ('queued', 'incident-1', 'reminder', 'queued-key', '<queued@localhost>', \
                    '[\"queued@example.test\"]', 'Alert', 'Alert', 'pending', 0, \
                    '2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z');",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();

        queue_resolved_delivery(
            &transaction,
            "incident-1",
            "High CPU",
            "2026-03-10T00:01:00Z",
        )
        .unwrap();
        transaction.commit().unwrap();

        let queued_status: String = connection
            .query_row(
                "SELECT status FROM monitoring_alert_deliveries WHERE id = 'queued'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let recipients: String = connection
            .query_row(
                "SELECT recipients_json FROM monitoring_alert_deliveries \
                 WHERE incident_id = 'incident-1' AND kind = 'resolved'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued_status, "cancelled");
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&recipients).unwrap(),
            vec!["sent@example.test"]
        );
    }

    #[test]
    fn a_late_success_gets_a_deduplicated_supplemental_resolution() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE monitoring_alert_deliveries(\
                   id TEXT PRIMARY KEY, incident_id TEXT, kind TEXT, stage_ordinal INTEGER, \
                   repeat_ordinal INTEGER, idempotency_key TEXT UNIQUE, message_id TEXT UNIQUE, \
                   recipients_json TEXT, subject TEXT, body_text TEXT, status TEXT, \
                   attempt_count INTEGER, due_at TEXT, sent_at TEXT, last_error TEXT, \
                   created_at TEXT, updated_at TEXT\
                 );\
                 INSERT INTO monitoring_alert_deliveries(\
                   id, incident_id, kind, idempotency_key, message_id, recipients_json, subject, \
                   body_text, status, attempt_count, due_at, created_at, updated_at\
                 ) VALUES (\
                   'resolved-existing', 'incident-1', 'resolved', 'incident-1:resolved', \
                   '<existing@localhost>', '[\"first@example.test\"]', 'Resolved', 'Resolved', \
                   'pending', 0, '2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z', \
                   '2026-03-10T00:00:00Z'\
                 );",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        let recipients = missing_resolved_recipients(
            &transaction,
            "incident-1",
            &[
                "first@example.test".to_owned(),
                "late@example.test".to_owned(),
            ],
        )
        .unwrap();
        queue_resolved_delivery_for_recipients(
            &transaction,
            "incident-1",
            "High CPU",
            &recipients,
            "resolved-after-firing-2",
            "2026-03-10T00:01:00Z",
        )
        .unwrap();
        transaction.commit().unwrap();

        let supplemental: String = connection
            .query_row(
                "SELECT recipients_json FROM monitoring_alert_deliveries \
                 WHERE idempotency_key = 'incident-1:resolved-after-firing-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&supplemental).unwrap(),
            vec!["late@example.test"]
        );
    }

    fn delivery_test_store() -> AlertStore {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE monitoring_alert_incidents(\
                   id TEXT PRIMARY KEY, rule_id TEXT, series_key TEXT, status TEXT, acknowledged_at TEXT\
                 );\
                 CREATE TABLE monitoring_alert_silences(\
                   id TEXT PRIMARY KEY, rule_id TEXT, series_key TEXT, starts_at TEXT, ends_at TEXT, \
                   cancelled_at TEXT\
                 );\
                 CREATE TABLE monitoring_alert_deliveries(\
                   id TEXT PRIMARY KEY, incident_id TEXT, kind TEXT, message_id TEXT, recipients_json TEXT, \
                   subject TEXT, body_text TEXT, attempt_count INTEGER, status TEXT, due_at TEXT, \
                   created_at TEXT, updated_at TEXT, last_error TEXT\
                 );\
                 CREATE TABLE monitoring_alert_delivery_attempts(\
                   delivery_id TEXT, attempt INTEGER, status TEXT, error TEXT, started_at TEXT, \
                   finished_at TEXT, UNIQUE(delivery_id, attempt)\
                 );",
            )
            .unwrap();
        AlertStore { connection }
    }

    #[test]
    fn claim_cancels_a_retry_when_the_incident_was_acknowledged_in_flight() {
        let mut store = delivery_test_store();
        let now_ms = timestamp_ms("2026-03-10T00:10:00Z");
        let now = iso(now_ms);
        store
            .connection
            .execute(
                "INSERT INTO monitoring_alert_incidents(\
                   id, rule_id, series_key, status, acknowledged_at\
                 ) VALUES ('incident-acked', 'rule-1', 'series-1', 'firing', ?)",
                [&now],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO monitoring_alert_deliveries(\
                   id, incident_id, kind, message_id, recipients_json, subject, body_text, \
                   attempt_count, status, due_at, created_at, updated_at\
                 ) VALUES ('delivery-acked', 'incident-acked', 'firing', '<acked@localhost>', \
                   '[\"a@example.test\"]', 'Alert', 'Alert', 1, 'retrying', ?, ?, ?)",
                params![now, now, now],
            )
            .unwrap();

        assert!(store.claim_delivery(now_ms).unwrap().is_none());
        let status: String = store
            .connection
            .query_row(
                "SELECT status FROM monitoring_alert_deliveries WHERE id = 'delivery-acked'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "cancelled");
    }

    #[test]
    fn stale_final_delivery_attempt_is_failed_instead_of_stuck_retrying() {
        let mut store = delivery_test_store();
        let now_ms = timestamp_ms("2026-03-10T00:10:00Z");
        store
            .connection
            .execute(
                "INSERT INTO monitoring_alert_deliveries(\
                   id, message_id, recipients_json, subject, body_text, attempt_count, status, due_at, \
                   created_at, updated_at\
                 ) VALUES ('delivery-final', '<final@localhost>', '[\"a@example.test\"]', 'Alert', \
                   'Alert', 12, 'sending', ?, ?, ?)",
                params![
                    iso(now_ms - 600_000),
                    iso(now_ms - 600_000),
                    iso(now_ms - 600_000)
                ],
            )
            .unwrap();

        assert!(store.claim_delivery(now_ms).unwrap().is_none());
        let row: (String, Option<String>) = store
            .connection
            .query_row(
                "SELECT status, last_error FROM monitoring_alert_deliveries \
                 WHERE id = 'delivery-final'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0, "failed");
        assert_eq!(
            row.1.as_deref(),
            Some("Delivery interrupted after final attempt")
        );
    }
}
