use std::collections::BTreeMap;
use std::time::Duration;

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use uuid::Uuid;

use super::AlertStore;
use super::codec::{
    instance_state, iso, parse_aggregation, parse_comparator, parse_instance_state, parse_iso,
    parse_no_data, parse_severity, parse_transform, sanitize_error, severity,
};
use super::deliveries::{add_event, queue_resolved_delivery};
use super::escalation::snapshot_policy;
use crate::domain::rule::{AlertInstance, AlertRule, EvaluationOutcome, InstanceState};
use crate::error::AlerterError;

const MAX_ACTIVE_INSTANCES: i64 = 2_048;

impl AlertStore {
    pub(super) fn enabled_rules(&self) -> Result<Vec<AlertRule>, AlerterError> {
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
            .map_err(AlerterError::from)
    }

    pub(super) fn apply_metric_evaluation(
        &mut self,
        rule: &AlertRule,
        series_key: &str,
        labels: &BTreeMap<String, String>,
        value: Option<f64>,
        now_ms: i64,
    ) -> Result<(), AlerterError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
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
                return Err(AlerterError::AlertCapacity);
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

    pub(super) fn mark_rule_error(
        &self,
        rule_id: &str,
        message: &str,
        now_ms: i64,
    ) -> Result<(), AlerterError> {
        self.connection.execute(
            "UPDATE monitoring_alert_rules SET evaluation_error = ?, last_evaluated_at = ? WHERE id = ?",
            params![sanitize_error(message), iso(now_ms), rule_id],
        )?;
        Ok(())
    }

    pub(super) fn clear_rule_error(&self, rule_id: &str, now_ms: i64) -> Result<(), AlerterError> {
        self.connection.execute(
            "UPDATE monitoring_alert_rules SET evaluation_error = NULL, last_evaluated_at = ? WHERE id = ?",
            params![iso(now_ms), rule_id],
        )?;
        Ok(())
    }
}

fn read_instance(
    transaction: &Transaction<'_>,
    rule_id: &str,
    series_key: &str,
) -> Result<Option<AlertInstance>, AlerterError> {
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
        .map_err(AlerterError::from)
}

fn active_incident_id(
    transaction: &Transaction<'_>,
    rule_id: &str,
    series_key: &str,
) -> Result<Option<String>, AlerterError> {
    transaction
        .query_row(
            "SELECT id FROM monitoring_alert_incidents \
             WHERE rule_id = ? AND series_key = ? AND status = 'firing'",
            params![rule_id, series_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(AlerterError::from)
}
