use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::error::AlerterError;

pub(super) fn open(path: &Path) -> Result<Connection, AlerterError> {
    if !path.exists() {
        return Err(AlerterError::AlertSchemaUnavailable);
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;

    let alerts_ready: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'monitoring_alert_rules')",
        [],
        |row| row.get(0),
    )?;
    let silence_cancellation_ready: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('monitoring_alert_silences') WHERE name = 'cancelled_at')",
        [],
        |row| row.get(0),
    )?;
    let rule_evaluation_ready: bool = connection.query_row(
        "SELECT COUNT(*) = 2 FROM pragma_table_info('monitoring_alert_rules') WHERE name IN ('evaluation_error', 'last_evaluated_at')",
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
    if !alerts_ready
        || !silence_cancellation_ready
        || !rule_evaluation_ready
        || !unsilenced_event_ready
    {
        return Err(AlerterError::AlertSchemaUnavailable);
    }
    Ok(connection)
}
