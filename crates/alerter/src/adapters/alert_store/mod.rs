use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::domain::delivery::{ClaimedDelivery, SmtpSettings};
use crate::domain::rule::AlertRule;
use crate::error::AlerterError;
use crate::ports::{AlertEvaluationStore, DeliveryStore, EscalationStore, MaintenanceStore};

mod codec;
mod connection;
mod deliveries;
mod escalation;
mod incidents;
mod maintenance;
mod outbox;
mod rules;

#[cfg(test)]
use codec::{iso, parse_iso, retry_delay};
#[cfg(test)]
use deliveries::{
    missing_resolved_recipients, queue_resolved_delivery, queue_resolved_delivery_for_recipients,
};
#[cfg(test)]
use escalation::{escalation_delivery_identity, escalation_restart_at, weekly_rotation_index};
#[cfg(test)]
use rusqlite::params;
#[cfg(test)]
use serde_json::{Value, json};

pub struct AlertStore {
    connection: Connection,
}

impl AlertStore {
    pub fn open(path: &std::path::Path) -> Result<Self, AlerterError> {
        Ok(Self {
            connection: connection::open(path)?,
        })
    }
}

impl AlertEvaluationStore for AlertStore {
    fn enabled_rules(&self) -> Result<Vec<AlertRule>, AlerterError> {
        Self::enabled_rules(self)
    }

    fn apply_metric_evaluation(
        &mut self,
        rule: &AlertRule,
        series_key: &str,
        labels: &BTreeMap<String, String>,
        value: Option<f64>,
        now_ms: i64,
    ) -> Result<(), AlerterError> {
        Self::apply_metric_evaluation(self, rule, series_key, labels, value, now_ms)
    }

    fn mark_rule_error(
        &self,
        rule_id: &str,
        message: &str,
        now_ms: i64,
    ) -> Result<(), AlerterError> {
        Self::mark_rule_error(self, rule_id, message, now_ms)
    }

    fn clear_rule_error(&self, rule_id: &str, now_ms: i64) -> Result<(), AlerterError> {
        Self::clear_rule_error(self, rule_id, now_ms)
    }

    fn sync_health_incidents(&mut self, now_ms: i64) -> Result<(), AlerterError> {
        Self::sync_health_incidents(self, now_ms)
    }

    fn finish_cycle(&self, now_ms: i64, error: Option<&str>) -> Result<(), AlerterError> {
        Self::finish_cycle(self, now_ms, error)
    }
}

impl EscalationStore for AlertStore {
    fn schedule_due_deliveries(&mut self, now_ms: i64) -> Result<(), AlerterError> {
        Self::schedule_due_deliveries(self, now_ms)
    }
}

impl MaintenanceStore for AlertStore {
    fn maintain(&self, now_ms: i64) -> Result<(), AlerterError> {
        Self::maintain(self, now_ms)
    }
}

impl DeliveryStore for AlertStore {
    fn smtp_settings(&self) -> Result<SmtpSettings, AlerterError> {
        Self::smtp_settings(self)
    }

    fn claim_delivery(&mut self, now_ms: i64) -> Result<Option<ClaimedDelivery>, AlerterError> {
        Self::claim_delivery(self, now_ms)
    }

    fn finish_delivery(
        &mut self,
        delivery: &ClaimedDelivery,
        now_ms: i64,
        error: Option<&str>,
    ) -> Result<(), AlerterError> {
        Self::finish_delivery(self, delivery, now_ms, error.map_or(Ok(()), Err))
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
        assert!(matches!(result, Err(AlerterError::AlertRule(_))));
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
            Err(AlerterError::AlertSchemaUnavailable)
        ));
    }

    #[test]
    fn open_does_not_create_the_main_database_before_api_migration() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("zos.sqlite");

        assert!(matches!(
            AlertStore::open(&path),
            Err(AlerterError::AlertSchemaUnavailable)
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
    fn health_flaps_reopen_the_recent_incident_episode() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE monitoring_alerter_state(\
                   id INTEGER PRIMARY KEY, health_initialized INTEGER, updated_at TEXT\
                 );\
                 INSERT INTO monitoring_alerter_state VALUES (1, 1, '2026-03-10T00:00:00Z');\
                 CREATE TABLE system_settings(key TEXT PRIMARY KEY, value_json TEXT);\
                 INSERT INTO system_settings VALUES (\
                   'monitoring_health_routing', '{\"warningPolicyId\":null,\"criticalPolicyId\":null}'\
                 );\
                 CREATE TABLE health_alerts(\
                   id TEXT PRIMARY KEY, code TEXT, scope TEXT, severity TEXT, details TEXT, status TEXT\
                 );\
                 INSERT INTO health_alerts VALUES (\
                   'health-2', 'indexer_unavailable', 'system', 'warning', 'offline', 'active'\
                 );\
                 CREATE TABLE monitoring_alert_incidents(\
                   id TEXT PRIMARY KEY, source TEXT, rule_id TEXT, health_alert_id TEXT, series_key TEXT,\
                   status TEXT, severity TEXT, title TEXT, firing_at TEXT, read_at TEXT,\
                   rule_snapshot_json TEXT, policy_snapshot_json TEXT, created_at TEXT, updated_at TEXT,\
                   resolved_at TEXT, close_reason TEXT\
                 );\
                 INSERT INTO monitoring_alert_incidents VALUES (\
                   'incident-1', 'health', NULL, 'health-1', 'indexer_unavailable:system',\
                   'resolved', 'warning', 'Health: indexer_unavailable', '2026-03-10T00:00:00Z', NULL,\
                   '{}', NULL, '2026-03-10T00:00:00Z', '2026-03-10T00:10:00Z',\
                   '2026-03-10T00:10:00Z', 'health_resolved'\
                 );\
                 CREATE TABLE monitoring_alert_incident_events(\
                   id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT, type TEXT, details_json TEXT,\
                   created_at TEXT\
                 );\
                 CREATE TABLE monitoring_alert_deliveries(\
                   id TEXT PRIMARY KEY, incident_id TEXT, kind TEXT, status TEXT, recipients_json TEXT,\
                   updated_at TEXT\
                 );\
                 INSERT INTO monitoring_alert_deliveries VALUES (\
                   'resolved-pending', 'incident-1', 'resolved', 'pending', \
                   '[\"operator@example.test\"]', '2026-03-10T00:10:00Z'\
                 );",
            )
            .unwrap();
        let mut store = AlertStore { connection };

        store
            .sync_health_incidents(timestamp_ms("2026-03-10T00:30:00Z"))
            .unwrap();

        let row: (String, String, Option<String>, Option<String>) = store
            .connection
            .query_row(
                "SELECT status, health_alert_id, resolved_at, close_reason \
                 FROM monitoring_alert_incidents WHERE id = 'incident-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let details: String = store
            .connection
            .query_row(
                "SELECT details_json FROM monitoring_alert_incident_events WHERE incident_id = 'incident-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            row,
            ("firing".to_owned(), "health-2".to_owned(), None, None)
        );
        let delivery_status: String = store
            .connection
            .query_row(
                "SELECT status FROM monitoring_alert_deliveries WHERE id = 'resolved-pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(delivery_status, "cancelled");
        assert_eq!(
            serde_json::from_str::<Value>(&details).unwrap(),
            json!({ "reopened": true })
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

    #[test]
    fn maintenance_cancels_disabled_smtp_tests_and_prunes_old_terminal_tests() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE system_settings(key TEXT PRIMARY KEY, value_json TEXT);\
                 INSERT INTO system_settings VALUES ('monitoring_smtp', '{\"enabled\":false}');\
                 CREATE TABLE monitoring_alert_deliveries(\
                   id TEXT PRIMARY KEY, incident_id TEXT, kind TEXT, status TEXT, last_error TEXT, \
                   updated_at TEXT\
                 );\
                 INSERT INTO monitoring_alert_deliveries VALUES \
                   ('pending-test', NULL, 'test', 'pending', NULL, '2026-01-01T00:00:00Z'),\
                   ('old-test', NULL, 'test', 'failed', 'failed', '2026-01-01T00:00:00Z'),\
                   ('incident-mail', 'incident-1', 'firing', 'pending', NULL, '2026-01-01T00:00:00Z');\
                 CREATE TABLE monitoring_alert_delivery_attempts(finished_at TEXT);\
                 CREATE TABLE monitoring_alert_silences(cancelled_at TEXT, ends_at TEXT);\
                 CREATE TABLE monitoring_alert_incidents(\
                   id TEXT PRIMARY KEY, status TEXT, resolved_at TEXT\
                 );",
            )
            .unwrap();
        let store = AlertStore { connection };

        store
            .maintain(timestamp_ms("2026-03-10T00:00:00Z"))
            .unwrap();

        let pending: (String, Option<String>) = store
            .connection
            .query_row(
                "SELECT status, last_error FROM monitoring_alert_deliveries WHERE id = 'pending-test'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(pending.0, "cancelled");
        assert_eq!(pending.1.as_deref(), Some("SMTP delivery is disabled"));
        let old_exists: bool = store
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM monitoring_alert_deliveries WHERE id = 'old-test')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let incident_status: String = store
            .connection
            .query_row(
                "SELECT status FROM monitoring_alert_deliveries WHERE id = 'incident-mail'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!old_exists);
        assert_eq!(incident_status, "pending");
    }
}
