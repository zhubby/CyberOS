use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::error::TransferError;

#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

#[derive(Clone)]
pub struct SendTask {
    pub id: String,
    pub adapter_id: String,
    pub device_address: String,
    pub root_path: PathBuf,
    pub storage_pool_id: String,
    pub relative_path: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub receive_enabled: bool,
    pub inbox_root_id: Option<String>,
    pub inbox_storage_pool_id: Option<String>,
    pub inbox_path: Option<String>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, TransferError> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "busy_timeout", 30_000)?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    pub fn heartbeat(&self, error: Option<&str>) -> Result<(), TransferError> {
        self.connection()?.execute(
            "INSERT INTO bluetooth_transfer_service_state(id, heartbeat_at, error) VALUES ('primary', ?, ?) ON CONFLICT(id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, error = excluded.error",
            params![now(), error],
        )?;
        Ok(())
    }

    pub fn claim_send(&self) -> Result<Option<SendTask>, TransferError> {
        let connection = self.connection()?;
        let row = connection.query_row(
            "UPDATE bluetooth_transfers SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?, error = NULL WHERE id = (SELECT id FROM bluetooth_transfers WHERE direction = 'send' AND status = 'queued' ORDER BY created_at LIMIT 1) AND status = 'queued' RETURNING id, adapter_id, device_address, root_id, storage_pool_id, relative_path",
            params![now(), now()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?)),
        ).optional()?;
        let Some((id, adapter_id, device_address, root_id, storage_pool_id, relative_path)) = row
        else {
            return Ok(None);
        };
        let root_path = connection
            .query_row(
                "SELECT path FROM nas_roots WHERE id = ? AND enabled = 1",
                [root_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(root_path) = root_path else {
            let timestamp = now();
            connection.execute(
                "UPDATE bluetooth_transfers SET status = 'failed', error = 'NAS root is unavailable', control_requested = NULL, read_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?",
                params![timestamp, timestamp, id],
            )?;
            return Ok(None);
        };
        Ok(Some(SendTask {
            id,
            adapter_id,
            device_address,
            root_path: PathBuf::from(root_path),
            storage_pool_id,
            relative_path,
        }))
    }

    pub fn recover_interrupted(&self) -> Result<(), TransferError> {
        let connection = self.connection()?;
        let interrupted_receives = {
            let mut statement = connection.prepare(
                "SELECT bluetooth_transfers.id, nas_roots.path, bluetooth_transfers.relative_path FROM bluetooth_transfers JOIN nas_roots ON nas_roots.id = bluetooth_transfers.root_id WHERE bluetooth_transfers.direction = 'receive' AND bluetooth_transfers.status = 'running'",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        PathBuf::from(row.get::<_, String>(1)?),
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let timestamp = now();
        connection.execute(
            "UPDATE bluetooth_transfers SET status = 'queued', started_at = NULL, obex_transfer_path = NULL, control_requested = NULL, error = 'Transfer service restarted before completion', updated_at = ? WHERE direction = 'send' AND status = 'running'",
            [&timestamp],
        )?;
        connection.execute(
            "UPDATE bluetooth_transfers SET status = 'failed', error = 'Transfer service restarted before receive completed', control_requested = NULL, finished_at = ?, updated_at = ?, read_at = NULL WHERE direction = 'receive' AND status = 'running'",
            params![timestamp, timestamp],
        )?;
        drop(connection);

        for (id, root_path, relative_path) in interrupted_receives {
            if let Err(error) = remove_receive_partial(&root_path, &relative_path) {
                tracing::warn!(transfer_id = %id, message = %error.0, "Failed to remove an interrupted Bluetooth receive target");
                self.connection()?.execute(
                    "UPDATE bluetooth_transfers SET error = 'Transfer service restarted before receive completed; partial file cleanup failed' WHERE id = ?",
                    [id],
                )?;
            }
        }
        Ok(())
    }

    pub fn update_progress(
        &self,
        id: &str,
        transferred: u64,
        total: Option<u64>,
        obex_path: Option<&str>,
    ) -> Result<bool, TransferError> {
        let changed = self.connection()?.execute(
            "UPDATE bluetooth_transfers SET transferred_bytes = ?, total_bytes = COALESCE(?, total_bytes), obex_transfer_path = COALESCE(?, obex_transfer_path), last_progress_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND control_requested IS NULL",
            params![to_i64(transferred), total.map(to_i64), obex_path, now(), now(), id],
        )?;
        if changed == 1 {
            self.heartbeat(None)?;
        }
        Ok(changed == 1)
    }

    pub fn cancel_requested(&self, id: &str) -> Result<bool, TransferError> {
        Ok(self
            .connection()?
            .query_row(
                "SELECT COALESCE(control_requested = 'cancel', 0) FROM bluetooth_transfers WHERE id = ?",
                [id],
                |row| row.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(true))
    }

    pub fn finish(&self, id: &str, status: &str, error: Option<&str>) -> Result<(), TransferError> {
        self.connection()?.execute(
            "UPDATE bluetooth_transfers SET status = ?, error = ?, control_requested = NULL, read_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?",
            params![status, error, now(), now(), id],
        )?;
        Ok(())
    }

    pub fn settings(&self) -> Result<Settings, TransferError> {
        let json = self
            .connection()?
            .query_row(
                "SELECT value_json FROM system_settings WHERE key = 'bluetooth_settings'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match json {
            Some(value) => {
                serde_json::from_str(&value).map_err(|error| TransferError(error.to_string()))
            }
            None => Ok(Settings::default()),
        }
    }

    pub fn root_path(&self, root_id: &str) -> Result<PathBuf, TransferError> {
        self.connection()?
            .query_row(
                "SELECT path FROM nas_roots WHERE id = ? AND enabled = 1",
                [root_id],
                |row| row.get::<_, String>(0).map(PathBuf::from),
            )
            .optional()?
            .ok_or_else(|| TransferError("Bluetooth inbox NAS root is unavailable".to_owned()))
    }

    pub fn record_receive(&self, input: ReceiveRecord<'_>) -> Result<String, TransferError> {
        let id = uuid::Uuid::new_v4().to_string();
        self.connection()?.execute(
            "INSERT INTO bluetooth_transfers(id, direction, device_address, root_id, storage_pool_id, relative_path, display_name, status, total_bytes, created_at, updated_at, started_at) VALUES (?, 'receive', ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)",
            params![id, input.address, input.root_id, input.pool_id, input.relative_path, input.display_name, input.total_bytes.map(to_i64), now(), now(), now()],
        )?;
        Ok(id)
    }

    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, TransferError> {
        self.0
            .lock()
            .map_err(|_| TransferError("Bluetooth transfer database lock is poisoned".to_owned()))
    }
}

pub struct ReceiveRecord<'a> {
    pub address: &'a str,
    pub root_id: &'a str,
    pub pool_id: &'a str,
    pub relative_path: &'a str,
    pub display_name: &'a str,
    pub total_bytes: Option<u64>,
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn remove_receive_partial(root: &Path, relative: &str) -> Result<(), TransferError> {
    let requested = root.join(relative);
    let target = match crate::safety::safe_existing(root, relative) {
        Ok(target) => target,
        Err(error) => {
            return match std::fs::symlink_metadata(requested) {
                Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                _ => Err(error),
            };
        }
    };
    std::fs::remove_file(target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::Db;

    fn test_db() -> (Db, TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let db = Db::open(&directory.path().join("state.sqlite")).unwrap();
        db.connection()
            .unwrap()
            .execute_batch(
                "
                CREATE TABLE nas_roots (
                    id TEXT PRIMARY KEY,
                    path TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE bluetooth_transfers (
                    id TEXT PRIMARY KEY,
                    direction TEXT NOT NULL,
                    adapter_id TEXT,
                    device_address TEXT NOT NULL,
                    root_id TEXT NOT NULL,
                    storage_pool_id TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    transferred_bytes INTEGER NOT NULL DEFAULT 0,
                    total_bytes INTEGER,
                    error TEXT,
                    obex_transfer_path TEXT,
                    control_requested TEXT,
                    read_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    last_progress_at TEXT
                );
                CREATE TABLE bluetooth_transfer_service_state (
                    id TEXT PRIMARY KEY,
                    heartbeat_at TEXT NOT NULL,
                    error TEXT
                );
                ",
            )
            .unwrap();
        (db, directory)
    }

    fn insert_transfer(db: &Db, id: &str, direction: &str, status: &str, root_id: &str) {
        db.connection()
            .unwrap()
            .execute(
                "INSERT INTO bluetooth_transfers(id, direction, adapter_id, device_address, root_id, storage_pool_id, relative_path, display_name, status, created_at, updated_at) VALUES (?, ?, 'adapter-hci0', 'AA:BB:CC:DD:EE:FF', ?, 'pool-1', 'inbox/partial.txt', 'partial.txt', ?, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z')",
                rusqlite::params![id, direction, root_id, status],
            )
            .unwrap();
    }

    #[test]
    fn progress_updates_refresh_the_service_heartbeat() {
        let (db, directory) = test_db();
        db.connection()
            .unwrap()
            .execute(
                "INSERT INTO nas_roots(id, path, enabled) VALUES ('root-1', ?, 1)",
                [directory.path().to_string_lossy().as_ref()],
            )
            .unwrap();
        insert_transfer(&db, "send-1", "send", "running", "root-1");
        db.connection()
            .unwrap()
            .execute(
                "INSERT INTO bluetooth_transfer_service_state(id, heartbeat_at, error) VALUES ('primary', '2000-01-01T00:00:00Z', 'stale')",
                [],
            )
            .unwrap();

        assert!(
            db.update_progress("send-1", 512, Some(1024), Some("/transfer/1"))
                .unwrap()
        );

        let (heartbeat, error, transferred): (String, Option<String>, i64) = db
            .connection()
            .unwrap()
            .query_row(
                "SELECT bluetooth_transfer_service_state.heartbeat_at, bluetooth_transfer_service_state.error, bluetooth_transfers.transferred_bytes FROM bluetooth_transfer_service_state JOIN bluetooth_transfers ON bluetooth_transfers.id = 'send-1' WHERE bluetooth_transfer_service_state.id = 'primary'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_ne!(heartbeat, "2000-01-01T00:00:00Z");
        assert_eq!(error, None);
        assert_eq!(transferred, 512);
    }

    #[test]
    fn claiming_a_send_with_an_unavailable_root_marks_it_failed() {
        let (db, directory) = test_db();
        db.connection()
            .unwrap()
            .execute(
                "INSERT INTO nas_roots(id, path, enabled) VALUES ('root-1', ?, 0)",
                [directory.path().to_string_lossy().as_ref()],
            )
            .unwrap();
        insert_transfer(&db, "send-1", "send", "queued", "root-1");

        assert!(db.claim_send().unwrap().is_none());

        let (status, error, finished_at): (String, Option<String>, Option<String>) = db
            .connection()
            .unwrap()
            .query_row(
                "SELECT status, error, finished_at FROM bluetooth_transfers WHERE id = 'send-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert_eq!(error.as_deref(), Some("NAS root is unavailable"));
        assert!(finished_at.is_some());
    }

    #[test]
    fn recovery_removes_an_interrupted_receive_target() {
        let (db, directory) = test_db();
        let root = directory.path().join("root");
        let inbox = root.join("inbox");
        fs::create_dir_all(&inbox).unwrap();
        let partial = inbox.join("partial.txt");
        fs::write(&partial, b"partial").unwrap();
        db.connection()
            .unwrap()
            .execute(
                "INSERT INTO nas_roots(id, path, enabled) VALUES ('root-1', ?, 1)",
                [root.to_string_lossy().as_ref()],
            )
            .unwrap();
        insert_transfer(&db, "receive-1", "receive", "running", "root-1");

        db.recover_interrupted().unwrap();

        assert!(!partial.exists());
        let (status, error): (String, Option<String>) = db
            .connection()
            .unwrap()
            .query_row(
                "SELECT status, error FROM bluetooth_transfers WHERE id = 'receive-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert_eq!(
            error.as_deref(),
            Some("Transfer service restarted before receive completed")
        );
    }
}
