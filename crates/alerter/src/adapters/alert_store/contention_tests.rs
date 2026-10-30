use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::mpsc;
use std::time::Duration;

use rusqlite::Connection;
use tempfile::{TempDir, tempdir};

use super::AlertStore;
use crate::domain::delivery::ClaimedDelivery;
use crate::error::AlerterError;

struct WriterRelease {
    release: mpsc::Sender<()>,
    committed: mpsc::Receiver<()>,
}

thread_local! {
    static WRITER_RELEASE: RefCell<Option<WriterRelease>> = const { RefCell::new(None) };
}

// Only the waiting writer path invokes SQLite's busy handler. Deferred
// read-to-write upgrades fail immediately instead. Release the other writer
// from this callback so the regression does not depend on a timed sleep.
fn release_contending_writer(_attempt: i32) -> bool {
    WRITER_RELEASE.with(|slot| {
        slot.borrow_mut().take().is_some_and(|writer| {
            writer.release.send(()).is_ok()
                && writer
                    .committed
                    .recv_timeout(Duration::from_secs(5))
                    .is_ok()
        })
    })
}

fn test_store() -> (TempDir, AlertStore, Connection) {
    let directory = tempdir().unwrap();
    let path = directory.path().join("cyberos.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE schema_migrations(id TEXT PRIMARY KEY);
             INSERT INTO schema_migrations VALUES ('001_cyberos_2_0');
             CREATE TABLE monitoring_alert_rules(
               id TEXT PRIMARY KEY, evaluation_error TEXT, last_evaluated_at TEXT
             );
             CREATE TABLE monitoring_alert_silences(
               rule_id TEXT, series_key TEXT, starts_at TEXT, ends_at TEXT, cancelled_at TEXT
             );
             CREATE TABLE monitoring_alerter_state(
               id INTEGER PRIMARY KEY, health_initialized INTEGER, last_delivery_at TEXT, updated_at TEXT
             );
             INSERT INTO monitoring_alerter_state(id, health_initialized) VALUES (1, 0);
             CREATE TABLE health_alerts(
               id TEXT PRIMARY KEY, code TEXT, scope TEXT, severity TEXT, details TEXT, status TEXT
             );
             CREATE TABLE monitoring_alert_incidents(
               id TEXT PRIMARY KEY, source TEXT, rule_id TEXT, health_alert_id TEXT, series_key TEXT,
               status TEXT, severity TEXT, title TEXT, firing_at TEXT, read_at TEXT,
               rule_snapshot_json TEXT, policy_snapshot_json TEXT, created_at TEXT, updated_at TEXT,
               resolved_at TEXT, close_reason TEXT, acknowledged_at TEXT, current_value REAL
             );
             CREATE TABLE monitoring_alert_incident_events(
               id INTEGER PRIMARY KEY, incident_id TEXT, type TEXT, details_json TEXT, created_at TEXT
             );
             CREATE TABLE monitoring_alert_instances(
               rule_id TEXT, series_key TEXT, labels_json TEXT, state TEXT, state_since TEXT,
               last_evaluated_at TEXT, last_value REAL, incident_id TEXT, error TEXT,
               PRIMARY KEY(rule_id, series_key)
             );
             CREATE TABLE monitoring_alert_contacts(id TEXT PRIMARY KEY, email TEXT, enabled INTEGER);
             CREATE TABLE monitoring_alert_deliveries(
               id TEXT PRIMARY KEY, incident_id TEXT, kind TEXT, stage_ordinal INTEGER,
               repeat_ordinal INTEGER, idempotency_key TEXT, message_id TEXT, recipients_json TEXT,
               subject TEXT, body_text TEXT, status TEXT, attempt_count INTEGER, due_at TEXT,
               created_at TEXT, updated_at TEXT, sent_at TEXT, last_error TEXT
             );
             CREATE TABLE monitoring_alert_delivery_attempts(
               delivery_id TEXT, attempt INTEGER, status TEXT, error TEXT, started_at TEXT, finished_at TEXT
             );",
        )
        .unwrap();
    drop(connection);
    let store = AlertStore::open(&path).unwrap();
    let writer = Connection::open(&path).unwrap();
    (directory, store, writer)
}

fn while_writer_is_active<T>(
    store: &mut AlertStore,
    writer: Connection,
    operation: impl FnOnce(&mut AlertStore) -> Result<T, AlerterError>,
) -> T {
    let (release, released) = mpsc::channel();
    let (committed, commit_done) = mpsc::channel();
    let writer_thread = std::thread::spawn(move || {
        released.recv_timeout(Duration::from_secs(5)).unwrap();
        writer.execute_batch("COMMIT").unwrap();
        let _ = committed.send(());
    });
    WRITER_RELEASE.with(|slot| {
        *slot.borrow_mut() = Some(WriterRelease {
            release: release.clone(),
            committed: commit_done,
        });
    });
    store
        .connection
        .busy_handler(Some(release_contending_writer))
        .unwrap();
    let result = operation(store);
    let waited = WRITER_RELEASE.with(|slot| slot.borrow_mut().take().is_none());
    // Also release on the old deferred failure path before asserting, so the
    // writer thread is always joined even when the regression is reproduced.
    let _ = release.send(());
    writer_thread.join().unwrap();
    let value = result.expect("the operation must wait for the concurrent writer before reading");
    assert!(
        waited,
        "the write lock must be acquired before reading state"
    );
    value
}

#[test]
fn health_sync_waits_for_a_concurrent_writer_and_reads_its_committed_alert() {
    let (_directory, mut store, writer) = test_store();
    writer
        .execute_batch(
            "BEGIN IMMEDIATE;
             INSERT INTO health_alerts VALUES ('health-1', 'storage', 'system', 'warning', NULL, 'active');",
        )
        .unwrap();

    while_writer_is_active(&mut store, writer, |store| {
        store.sync_health_incidents(60_000)
    });

    let id: String = store
        .connection
        .query_row(
            "SELECT health_alert_id FROM monitoring_alert_incidents",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(id, "health-1");
}

#[test]
fn metric_evaluation_waits_for_a_concurrent_writer_before_reading_the_instance() {
    let (_directory, mut store, writer) = test_store();
    writer
        .execute_batch(
            "BEGIN IMMEDIATE;
             INSERT INTO monitoring_alert_instances(rule_id, series_key, state, state_since, last_value)
             VALUES ('rule-1', '{}', 'normal', '1970-01-01T00:00:00Z', 5);",
        )
        .unwrap();
    let rule = crate::domain::rule::AlertRule {
        id: "rule-1".to_owned(),
        name: "Load".to_owned(),
        metric: "cyberos_host_load1".to_owned(),
        selector: BTreeMap::new(),
        transform: crate::domain::rule::MetricTransform::Value,
        aggregation: crate::domain::rule::Aggregation::Last,
        window: Duration::from_secs(60),
        comparator: crate::domain::rule::Comparator::Greater,
        trigger_threshold: 10.0,
        recovery_threshold: 9.0,
        trigger_duration: Duration::ZERO,
        recovery_duration: Duration::ZERO,
        severity: crate::domain::rule::Severity::Warning,
        no_data: crate::domain::rule::NoDataPolicy::Ignore,
    };

    while_writer_is_active(&mut store, writer, |store| {
        store.apply_metric_evaluation(&rule, "{}", &BTreeMap::new(), Some(6.0), 60_000)
    });

    let value: f64 = store
        .connection
        .query_row(
            "SELECT last_value FROM monitoring_alert_instances",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(value, 6.0);
}

#[test]
fn escalation_waits_for_a_concurrent_writer_before_resolving_recipients() {
    let (_directory, mut store, writer) = test_store();
    store.connection.execute_batch(
        "INSERT INTO monitoring_alert_contacts VALUES ('contact-1', 'old@example.test', 1);
         INSERT INTO monitoring_alert_incidents(id, series_key, title, status, firing_at, policy_snapshot_json)
         VALUES ('incident-1', '{}', 'Load', 'firing', '1970-01-01T00:00:00Z',
           '{\"stages\":[{\"ordinal\":0,\"delaySeconds\":0,\"repeatCount\":0,\"targets\":[{\"type\":\"contact\",\"id\":\"contact-1\"}]}]}');",
    ).unwrap();
    writer
        .execute_batch(
            "BEGIN IMMEDIATE;
             UPDATE monitoring_alert_contacts SET email = 'new@example.test' WHERE id = 'contact-1';",
        )
        .unwrap();

    while_writer_is_active(&mut store, writer, |store| {
        store.schedule_due_deliveries(60_000)
    });

    let recipients: String = store
        .connection
        .query_row(
            "SELECT recipients_json FROM monitoring_alert_deliveries",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(recipients, r#"["new@example.test"]"#);
}

#[test]
fn delivery_completion_waits_for_a_concurrent_writer_before_reading_context() {
    let (_directory, mut store, writer) = test_store();
    store.connection.execute_batch(
        "INSERT INTO monitoring_alert_deliveries(id, kind, status) VALUES ('delivery-1', 'test', 'sending');",
    ).unwrap();
    writer
        .execute_batch(
            "BEGIN IMMEDIATE;
             UPDATE monitoring_alert_deliveries SET updated_at = '1970-01-01T00:00:30Z' WHERE id = 'delivery-1';",
        )
        .unwrap();
    let delivery = ClaimedDelivery {
        id: "delivery-1".to_owned(),
        message_id: "<delivery-1@localhost>".to_owned(),
        recipients: vec!["operator@example.test".to_owned()],
        subject: "Test".to_owned(),
        body: "Test".to_owned(),
        attempt: 1,
    };

    while_writer_is_active(&mut store, writer, |store| {
        store.finish_delivery(&delivery, 60_000, Ok(()))
    });

    let status: String = store
        .connection
        .query_row(
            "SELECT status FROM monitoring_alert_deliveries",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "succeeded");
    let attempts: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM monitoring_alert_delivery_attempts WHERE status = 'succeeded'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(attempts, 1);
}
