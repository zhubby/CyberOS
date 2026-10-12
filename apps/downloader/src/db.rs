use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::oneshot;

use crate::error::{DownloadError, ErrorCode};

type DbResult<T> = Result<T, DownloadError>;
type DbJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

const TASK_COLUMNS: &str = "
  d.id, d.url, d.root_id, d.storage_pool_id, d.target_directory,
  d.target_file_name, d.target_path, d.partial_path, d.status,
  d.received_bytes, d.total_bytes, d.speed_bytes_per_second,
  d.etag, d.last_modified, d.worker_id, d.lease_expires_at,
  d.phase, d.download_mode, d.expected_sha256, d.actual_sha256,
  d.retry_count, d.next_retry_at, d.control_requested, d.segment_count,
  r.path
";

#[derive(Clone)]
pub struct Db {
    sender: mpsc::Sender<DbJob>,
}

#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub url: String,
    pub root_id: String,
    pub storage_pool_id: String,
    pub target_directory: String,
    pub target_file_name: String,
    pub target_path: String,
    pub partial_path: String,
    pub status: String,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_second: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub worker_id: Option<String>,
    pub lease_expires_at: Option<String>,
    pub phase: Option<String>,
    pub download_mode: Option<String>,
    pub expected_sha256: Option<String>,
    pub actual_sha256: Option<String>,
    pub retry_count: u32,
    pub next_retry_at: Option<String>,
    pub control_requested: Option<String>,
    pub segment_count: u32,
    pub root_path: String,
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub start: u64,
    pub end: u64,
    pub next: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct SegmentCheckpoint {
    pub start: u64,
    pub next: u64,
    pub total: u64,
    pub speed_bytes_per_second: u64,
}

#[derive(Debug, Clone)]
pub struct PublishJournal {
    pub task_id: String,
    pub operation_id: String,
    pub worker_id: String,
    pub device: u64,
    pub inode: u64,
    pub size_bytes: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadSettings {
    pub concurrency: usize,
    pub parallel_requests_per_task: usize,
    pub segmented_download_min_bytes: u64,
    pub max_auto_retries: u32,
    pub retry_base_delay_ms: u64,
    pub retry_max_delay_ms: u64,
    pub retry_after_max_delay_ms: u64,
    pub connect_timeout_ms: u64,
    pub response_header_timeout_ms: u64,
    pub read_idle_timeout_ms: u64,
    pub min_free_space_bytes: u64,
    pub max_file_size_bytes: Option<u64>,
}

impl Default for DownloadSettings {
    fn default() -> Self {
        Self {
            concurrency: 1,
            parallel_requests_per_task: 4,
            segmented_download_min_bytes: 64 * 1024 * 1024,
            max_auto_retries: 5,
            retry_base_delay_ms: 2_000,
            retry_max_delay_ms: 300_000,
            retry_after_max_delay_ms: 900_000,
            connect_timeout_ms: 15_000,
            response_header_timeout_ms: 30_000,
            read_idle_timeout_ms: 60_000,
            min_free_space_bytes: 0,
            max_file_size_bytes: None,
        }
    }
}

impl DownloadSettings {
    fn validate(self) -> DbResult<Self> {
        validate_range("concurrency", self.concurrency as u64, 1, 3)?;
        validate_range(
            "parallelRequestsPerTask",
            self.parallel_requests_per_task as u64,
            1,
            8,
        )?;
        validate_range(
            "segmentedDownloadMinBytes",
            self.segmented_download_min_bytes,
            1024 * 1024,
            1024_u64.pow(4),
        )?;
        validate_range("maxAutoRetries", u64::from(self.max_auto_retries), 0, 20)?;
        validate_range("retryBaseDelayMs", self.retry_base_delay_ms, 500, 60_000)?;
        validate_range(
            "retryMaxDelayMs",
            self.retry_max_delay_ms,
            self.retry_base_delay_ms,
            1_800_000,
        )?;
        validate_range(
            "retryAfterMaxDelayMs",
            self.retry_after_max_delay_ms,
            1_000,
            3_600_000,
        )?;
        validate_range("connectTimeoutMs", self.connect_timeout_ms, 1_000, 120_000)?;
        validate_range(
            "responseHeaderTimeoutMs",
            self.response_header_timeout_ms,
            5_000,
            300_000,
        )?;
        validate_range(
            "readIdleTimeoutMs",
            self.read_idle_timeout_ms,
            5_000,
            900_000,
        )?;
        if self.max_file_size_bytes == Some(0) {
            return Err(invalid_setting("maxFileSizeBytes"));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone)]
pub struct Progress<'a> {
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_second: u64,
    pub etag: Option<&'a str>,
    pub last_modified: Option<&'a str>,
    pub phase: &'a str,
    pub mode: &'a str,
    pub segment_count: u32,
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(DownloadError::storage)?;
        }
        let connection = Connection::open(path).map_err(DownloadError::database)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(DownloadError::database)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(DownloadError::database)?;
        connection
            .pragma_update(None, "busy_timeout", 5_000)
            .map_err(DownloadError::database)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(DownloadError::database)?;
        let (sender, receiver) = mpsc::channel::<DbJob>();
        std::thread::Builder::new()
            .name("sigmaos-downloader-db".to_owned())
            .spawn(move || {
                let mut connection = connection;
                while let Ok(job) = receiver.recv() {
                    job(&mut connection);
                }
            })
            .map_err(DownloadError::storage)?;
        Ok(Self { sender })
    }

    async fn call<T, F>(&self, operation: F) -> DbResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> DbResult<T> + Send + 'static,
    {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(Box::new(move |connection| {
                let _ = sender.send(operation(connection));
            }))
            .map_err(|_| DownloadError::database("database thread stopped"))?;
        receiver
            .await
            .map_err(|_| DownloadError::database("database response channel closed"))?
    }

    #[cfg(test)]
    pub(crate) async fn test_call<T, F>(&self, operation: F) -> DbResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> DbResult<T> + Send + 'static,
    {
        self.call(operation).await
    }

    pub async fn wait_for_schema(&self, timeout: Duration) -> DbResult<()> {
        let started = tokio::time::Instant::now();
        loop {
            let ready = self
                .call(|connection| {
                    let found: Option<i64> = connection
                        .query_row(
                            "SELECT 1 FROM schema_migrations WHERE id = '024_rust_indexer'",
                            [],
                            |row| row.get(0),
                        )
                        .optional()
                        .unwrap_or(None);
                    Ok(found.is_some())
                })
                .await
                .unwrap_or(false);
            if ready {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err(DownloadError::new(
                    ErrorCode::Database,
                    "database migration 024_rust_indexer is not available",
                    true,
                ));
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    pub async fn settings(&self) -> DbResult<DownloadSettings> {
        self.call(|connection| {
            let json: Option<String> = connection
                .query_row(
                    "SELECT value_json FROM system_settings WHERE key = 'download_settings'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(DownloadError::database)?;
            match json {
                Some(json) => serde_json::from_str::<DownloadSettings>(&json)
                    .map_err(|error| {
                        DownloadError::new(
                            ErrorCode::Database,
                            format!("invalid download settings: {error}"),
                            false,
                        )
                    })?
                    .validate(),
                None => Ok(DownloadSettings::default()),
            }
        })
        .await
    }

    pub async fn register_worker(&self, worker_id: &str, version: &str) -> DbResult<()> {
        let worker_id = worker_id.to_owned();
        let version = version.to_owned();
        self.call(move |connection| {
            let now = now_iso();
            connection.execute(
                "INSERT INTO download_workers (worker_id, version, started_at, heartbeat_at) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(worker_id) DO UPDATE SET version = excluded.version, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at",
                params![worker_id, version, now, now],
            ).map_err(DownloadError::database)?;
            connection.execute("DELETE FROM download_workers WHERE heartbeat_at < ?", [ago_iso(Duration::from_secs(300))])
                .map_err(DownloadError::database)?;
            Ok(())
        }).await
    }

    pub async fn heartbeat_worker(&self, worker_id: &str) -> DbResult<()> {
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            connection
                .execute(
                    "UPDATE download_workers SET heartbeat_at = ? WHERE worker_id = ?",
                    params![now_iso(), worker_id],
                )
                .map_err(DownloadError::database)?;
            Ok(())
        })
        .await
    }

    pub async fn extend_lease(
        &self,
        task_id: &str,
        worker_id: &str,
        lease: Duration,
    ) -> DbResult<bool> {
        let task_id = task_id.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let changed = connection
                .execute(
                    "UPDATE download_tasks SET lease_expires_at = ?, updated_at = ? \
                 WHERE id = ? AND status = 'running' AND worker_id = ? AND control_requested IS NULL",
                    params![future_iso(lease), now_iso(), task_id, worker_id],
                )
                .map_err(DownloadError::database)?;
            Ok(changed == 1)
        })
        .await
    }

    pub async fn remove_worker(&self, worker_id: &str) -> DbResult<()> {
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            connection
                .execute(
                    "DELETE FROM download_workers WHERE worker_id = ?",
                    [worker_id],
                )
                .map_err(DownloadError::database)?;
            Ok(())
        })
        .await
    }

    pub async fn recover_expired(&self) -> DbResult<usize> {
        self.call(|connection| {
            let now = now_iso();
            let transaction = connection.transaction().map_err(DownloadError::database)?;
            let changed = transaction.execute(
                "UPDATE download_tasks SET \
                   status = CASE control_requested WHEN 'pause' THEN 'paused' WHEN 'cancel' THEN 'cancelled' ELSE 'queued' END, \
                   worker_id = NULL, lease_expires_at = NULL, speed_bytes_per_second = 0, phase = NULL, \
                   control_requested = NULL, finished_at = CASE WHEN control_requested = 'cancel' THEN ? ELSE NULL END, updated_at = ? \
                 WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?) \
                   AND NOT EXISTS (SELECT 1 FROM download_publish_journal j WHERE j.task_id = download_tasks.id)",
                params![now, now, now],
            ).map_err(DownloadError::database)?;
            transaction.execute(
                "DELETE FROM download_space_reservations WHERE task_id IN (SELECT id FROM download_tasks WHERE status <> 'running')",
                [],
            ).map_err(DownloadError::database)?;
            transaction.commit().map_err(DownloadError::database)?;
            Ok(changed)
        }).await
    }

    pub async fn running_count(&self) -> DbResult<usize> {
        self.call(|connection| {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM download_tasks WHERE status = 'running'",
                    [],
                    |row| row.get(0),
                )
                .map_err(DownloadError::database)?;
            Ok(count.max(0) as usize)
        })
        .await
    }

    pub async fn claim(&self, worker_id: &str, lease: Duration) -> DbResult<Option<Task>> {
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let now = now_iso();
            let lease_expires = future_iso(lease);
            let sql = format!("\
                UPDATE download_tasks SET status = 'running', worker_id = ?1, lease_expires_at = ?2, \
                  started_at = COALESCE(started_at, ?3), finished_at = NULL, error = NULL, error_code = NULL, \
                  error_retryable = 0, phase = 'probing', next_retry_at = NULL, control_requested = NULL, updated_at = ?3 \
                WHERE id = (SELECT id FROM download_tasks WHERE status = 'queued' \
                  AND (next_retry_at IS NULL OR next_retry_at <= ?3) \
                  AND NOT EXISTS (SELECT 1 FROM download_publish_journal j WHERE j.task_id = download_tasks.id) \
                  ORDER BY COALESCE(next_retry_at, created_at), created_at LIMIT 1) \
                AND status = 'queued' \
                RETURNING {}", TASK_COLUMNS.replace("d.", "").replace("r.path", "(SELECT path FROM nas_roots WHERE id = root_id)"));
            connection.query_row(&sql, params![worker_id, lease_expires, now], map_task)
                .optional().map_err(DownloadError::database)
        }).await
    }

    pub async fn get_task(&self, task_id: &str) -> DbResult<Option<Task>> {
        let task_id = task_id.to_owned();
        self.call(move |connection| {
            let sql = format!("SELECT {TASK_COLUMNS} FROM download_tasks d JOIN nas_roots r ON r.id = d.root_id WHERE d.id = ?");
            connection.query_row(&sql, [task_id], map_task).optional().map_err(DownloadError::database)
        }).await
    }

    pub async fn progress(
        &self,
        task_id: &str,
        worker_id: &str,
        lease: Duration,
        progress: Progress<'_>,
    ) -> DbResult<bool> {
        let task_id = task_id.to_owned();
        let worker_id = worker_id.to_owned();
        let etag = progress.etag.map(ToOwned::to_owned);
        let last_modified = progress.last_modified.map(ToOwned::to_owned);
        let phase = progress.phase.to_owned();
        let mode = progress.mode.to_owned();
        let received = i64_from(progress.received_bytes)?;
        let total = progress.total_bytes.map(i64_from).transpose()?;
        let speed = i64_from(progress.speed_bytes_per_second)?;
        let segment_count = i64::from(progress.segment_count);
        self.call(move |connection| {
            let changed = connection.execute(
                "UPDATE download_tasks SET received_bytes = ?, total_bytes = ?, speed_bytes_per_second = ?, \
                   etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), phase = ?, \
                   download_mode = ?, segment_count = ?, lease_expires_at = ?, last_progress_at = ?, updated_at = ? \
                 WHERE id = ? AND status = 'running' AND worker_id = ? AND control_requested IS NULL",
                params![received, total, speed, etag, last_modified, phase, mode, segment_count,
                    future_iso(lease), now_iso(), now_iso(), task_id, worker_id],
            ).map_err(DownloadError::database)?;
            Ok(changed == 1)
        }).await
    }

    pub async fn renew_phase(
        &self,
        task_id: &str,
        worker_id: &str,
        phase: &str,
        lease: Duration,
    ) -> DbResult<bool> {
        let task_id = task_id.to_owned();
        let worker_id = worker_id.to_owned();
        let phase = phase.to_owned();
        self.call(move |connection| {
            let changed = connection.execute(
                "UPDATE download_tasks SET phase = ?, lease_expires_at = ?, last_progress_at = ?, updated_at = ? \
                 WHERE id = ? AND status = 'running' AND worker_id = ? AND control_requested IS NULL",
                params![phase, future_iso(lease), now_iso(), now_iso(), task_id, worker_id],
            ).map_err(DownloadError::database)?;
            Ok(changed == 1)
        }).await
    }

    pub async fn segments(&self, task_id: &str) -> DbResult<Vec<Segment>> {
        let task_id = task_id.to_owned();
        self.call(move |connection| {
            let mut statement = connection.prepare(
                "SELECT start_byte, end_byte, next_byte FROM download_segments WHERE task_id = ? ORDER BY start_byte"
            ).map_err(DownloadError::database)?;
            let rows = statement.query_map([task_id], |row| {
                Ok(Segment {
                    start: row.get::<_, i64>(0)? as u64,
                    end: row.get::<_, i64>(1)? as u64,
                    next: row.get::<_, i64>(2)? as u64,
                })
            }).map_err(DownloadError::database)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(DownloadError::database)
        }).await
    }

    pub async fn reset_transfer(&self, task_id: &str, worker_id: &str) -> DbResult<()> {
        let task_id = task_id.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(DownloadError::database)?;
            let changed = transaction.execute(
                "UPDATE download_tasks SET received_bytes = 0, total_bytes = NULL, speed_bytes_per_second = 0, \
                   etag = NULL, last_modified = NULL, actual_sha256 = NULL, download_mode = NULL, segment_count = 0, \
                   phase = 'probing', updated_at = ? WHERE id = ? AND status = 'running' AND worker_id = ? \
                   AND control_requested IS NULL",
                params![now_iso(), task_id, worker_id],
            ).map_err(DownloadError::database)?;
            ensure_owned(changed)?;
            transaction.execute("DELETE FROM download_segments WHERE task_id = ?", [&task_id])
                .map_err(DownloadError::database)?;
            transaction.execute("DELETE FROM download_space_reservations WHERE task_id = ?", [&task_id])
                .map_err(DownloadError::database)?;
            transaction.commit().map_err(DownloadError::database)?;
            Ok(())
        }).await
    }

    pub async fn set_actual_checksum(
        &self,
        task_id: &str,
        worker_id: &str,
        checksum: &str,
    ) -> DbResult<bool> {
        let task_id = task_id.to_owned();
        let worker_id = worker_id.to_owned();
        let checksum = checksum.to_owned();
        self.call(move |connection| {
            let changed = connection.execute(
                "UPDATE download_tasks SET phase = 'verifying', actual_sha256 = ?, updated_at = ? \
                 WHERE id = ? AND status = 'running' AND worker_id = ? AND control_requested IS NULL",
                params![checksum, now_iso(), task_id, worker_id],
            ).map_err(DownloadError::database)?;
            Ok(changed == 1)
        })
        .await
    }

    pub async fn replace_segments(
        &self,
        task_id: &str,
        worker_id: &str,
        segments: &[Segment],
    ) -> DbResult<()> {
        let task_id = task_id.to_owned();
        let worker_id = worker_id.to_owned();
        let segments = segments.to_vec();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(DownloadError::database)?;
            let owned: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM download_tasks WHERE id = ? AND status = 'running' \
                 AND worker_id = ? AND control_requested IS NULL)",
                params![task_id, worker_id],
                |row| row.get(0),
            ).map_err(DownloadError::database)?;
            if !owned {
                return Err(lease_lost());
            }
            transaction.execute("DELETE FROM download_segments WHERE task_id = ?", [&task_id])
                .map_err(DownloadError::database)?;
            let now = now_iso();
            {
                let mut insert = transaction.prepare(
                    "INSERT INTO download_segments (task_id, start_byte, end_byte, next_byte, updated_at) VALUES (?, ?, ?, ?, ?)"
                ).map_err(DownloadError::database)?;
                for segment in &segments {
                    insert.execute(params![task_id, i64_from(segment.start)?, i64_from(segment.end)?, i64_from(segment.next)?, now])
                        .map_err(DownloadError::database)?;
                }
            }
            transaction.commit().map_err(DownloadError::database)?;
            Ok(())
        }).await
    }

    pub async fn checkpoint_segment(
        &self,
        task_id: &str,
        worker_id: &str,
        checkpoint: SegmentCheckpoint,
        lease: Duration,
    ) -> DbResult<bool> {
        let task_id = task_id.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(DownloadError::database)?;
            let owned: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM download_tasks WHERE id = ? AND status = 'running' AND worker_id = ? AND control_requested IS NULL)",
                params![task_id, worker_id], |row| row.get(0),
            ).map_err(DownloadError::database)?;
            if !owned {
                return Ok(false);
            }
            transaction.execute(
                "UPDATE download_segments SET next_byte = ?, updated_at = ? WHERE task_id = ? AND start_byte = ?",
                params![i64_from(checkpoint.next)?, now_iso(), task_id, i64_from(checkpoint.start)?],
            ).map_err(DownloadError::database)?;
            let received: i64 = transaction.query_row(
                "SELECT COALESCE(SUM(next_byte - start_byte), 0) FROM download_segments WHERE task_id = ?",
                [&task_id], |row| row.get(0),
            ).map_err(DownloadError::database)?;
            transaction.execute(
                "UPDATE download_tasks SET received_bytes = ?, total_bytes = ?, speed_bytes_per_second = ?, \
                   phase = 'downloading', download_mode = 'segmented', \
                   lease_expires_at = ?, last_progress_at = ?, updated_at = ? WHERE id = ? AND worker_id = ?",
                params![received, i64_from(checkpoint.total)?, i64_from(checkpoint.speed_bytes_per_second)?, future_iso(lease),
                    now_iso(), now_iso(), task_id, worker_id],
            ).map_err(DownloadError::database)?;
            transaction.execute(
                "UPDATE download_space_reservations SET reserved_bytes = MAX(0, ? - ?), updated_at = ? WHERE task_id = ?",
                params![i64_from(checkpoint.total)?, received, now_iso(), task_id],
            ).map_err(DownloadError::database)?;
            transaction.commit().map_err(DownloadError::database)?;
            Ok(true)
        }).await
    }

    pub async fn reserve_space(
        &self,
        task: &Task,
        required: u64,
        available: u64,
        minimum_free: u64,
    ) -> DbResult<()> {
        let task_id = task.id.clone();
        let pool_id = task.storage_pool_id.clone();
        let worker_id = task.worker_id.clone().unwrap_or_default();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(DownloadError::database)?;
            let owned: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM download_tasks WHERE id = ? AND status = 'running' \
                 AND worker_id = ? AND control_requested IS NULL)",
                params![task_id, worker_id],
                |row| row.get(0),
            ).map_err(DownloadError::database)?;
            if !owned {
                return Err(lease_lost());
            }
            let other: i64 = transaction.query_row(
                "SELECT COALESCE(SUM(reserved_bytes), 0) FROM download_space_reservations WHERE storage_pool_id = ? AND task_id <> ?",
                params![pool_id, task_id], |row| row.get(0),
            ).map_err(DownloadError::database)?;
            let needed = required.saturating_add(minimum_free).saturating_add(other.max(0) as u64);
            if needed > available {
                return Err(DownloadError::new(ErrorCode::DiskSpace, "not enough unreserved disk space for download", false));
            }
            transaction.execute(
                "INSERT INTO download_space_reservations (task_id, storage_pool_id, reserved_bytes, updated_at) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(task_id) DO UPDATE SET storage_pool_id = excluded.storage_pool_id, reserved_bytes = excluded.reserved_bytes, updated_at = excluded.updated_at",
                params![task_id, pool_id, i64_from(required)?, now_iso()],
            ).map_err(DownloadError::database)?;
            transaction.commit().map_err(DownloadError::database)?;
            Ok(())
        }).await
    }

    pub async fn begin_publish(&self, journal: PublishJournal) -> DbResult<()> {
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(DownloadError::database)?;
            let changed = transaction.execute(
                "UPDATE download_tasks SET phase = 'publishing', actual_sha256 = ?, updated_at = ? \
                 WHERE id = ? AND status = 'running' AND worker_id = ? AND control_requested IS NULL",
                params![journal.sha256, now_iso(), journal.task_id, journal.worker_id],
            ).map_err(DownloadError::database)?;
            if changed != 1 {
                return Err(DownloadError::new(
                    ErrorCode::Internal,
                    "download task lease was lost before publication",
                    false,
                ));
            }
            transaction.execute(
                "INSERT INTO download_publish_journal \
                 (task_id, operation_id, worker_id, device, inode, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(task_id) DO UPDATE SET operation_id = excluded.operation_id, worker_id = excluded.worker_id, \
                   device = excluded.device, inode = excluded.inode, size_bytes = excluded.size_bytes, \
                   sha256 = excluded.sha256, created_at = excluded.created_at",
                params![journal.task_id, journal.operation_id, journal.worker_id, i64_from(journal.device)?,
                    i64_from(journal.inode)?, i64_from(journal.size_bytes)?, journal.sha256, now_iso()],
            ).map_err(DownloadError::database)?;
            transaction.commit().map_err(DownloadError::database)?;
            Ok(())
        }).await
    }

    pub async fn journals(&self) -> DbResult<Vec<PublishJournal>> {
        self.call(|connection| {
            let mut statement = connection.prepare(
                "SELECT task_id, operation_id, worker_id, device, inode, size_bytes, sha256 FROM download_publish_journal"
            ).map_err(DownloadError::database)?;
            let rows = statement.query_map([], |row| Ok(PublishJournal {
                task_id: row.get(0)?, operation_id: row.get(1)?, worker_id: row.get(2)?,
                device: row.get::<_, i64>(3)? as u64, inode: row.get::<_, i64>(4)? as u64,
                size_bytes: row.get::<_, i64>(5)? as u64, sha256: row.get(6)?,
            })).map_err(DownloadError::database)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(DownloadError::database)
        }).await
    }

    pub async fn finalize_publish(
        &self,
        journal: &PublishJournal,
        task: &Task,
        mode: &str,
    ) -> DbResult<()> {
        let journal = journal.clone();
        let task = task.clone();
        let mode = mode.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(DownloadError::database)?;
            let now = now_iso();
            let journal_matches: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM download_publish_journal \
                 WHERE task_id = ? AND operation_id = ? AND worker_id = ? AND device = ? AND inode = ? AND size_bytes = ?)",
                params![journal.task_id, journal.operation_id, journal.worker_id,
                    i64_from(journal.device)?, i64_from(journal.inode)?, i64_from(journal.size_bytes)?],
                |row| row.get(0),
            ).map_err(DownloadError::database)?;
            if !journal_matches {
                let already_completed: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM download_tasks WHERE id = ? AND status = 'completed' AND file_operation_id = ?)",
                    params![journal.task_id, journal.operation_id],
                    |row| row.get(0),
                ).map_err(DownloadError::database)?;
                if already_completed {
                    return Ok(());
                }
                return Err(DownloadError::database(
                    "download publish journal no longer matches the finishing worker",
                ));
            }
            let metadata = serde_json::json!({
                "rootId": task.root_id,
                "storagePoolId": task.storage_pool_id,
                "reversible": true,
                "url": task.url,
                "sizeBytes": journal.size_bytes,
                "sha256": journal.sha256,
                "downloadMode": mode
            });
            transaction.execute(
                "INSERT OR IGNORE INTO file_operations (id, approval_id, operation, source_path, target_path, status, metadata_json, created_at, updated_at) \
                 VALUES (?, NULL, 'download', NULL, ?, 'applied', ?, ?, ?)",
                params![journal.operation_id, task.target_path, metadata.to_string(), now, now],
            ).map_err(DownloadError::database)?;
            transaction.execute(
                "UPDATE download_tasks SET status = 'completed', received_bytes = ?, total_bytes = ?, speed_bytes_per_second = 0, \
                   worker_id = NULL, lease_expires_at = NULL, error = NULL, error_code = NULL, error_retryable = 0, \
                   phase = NULL, control_requested = NULL, next_retry_at = NULL, actual_sha256 = ?, finished_at = ?, \
                   last_progress_at = ?, file_operation_id = ?, updated_at = ? WHERE id = ?",
                params![i64_from(journal.size_bytes)?, i64_from(journal.size_bytes)?, journal.sha256, now, now,
                    journal.operation_id, now, journal.task_id],
            ).map_err(DownloadError::database)?;
            transaction.execute(
                "INSERT INTO index_queue (id, root_id, storage_pool_id, path, recursive, kind, generation, priority, status, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, 0, 'incremental', 1, 50, 'queued', ?, ?) \
                 ON CONFLICT(root_id, path) DO UPDATE SET storage_pool_id = excluded.storage_pool_id, \
                   generation = index_queue.generation + 1, priority = MAX(index_queue.priority, 50), status = 'queued', \
                   retry_count = 0, next_retry_at = NULL, worker_id = NULL, lease_expires_at = NULL, \
                   error = NULL, error_code = NULL, updated_at = excluded.updated_at, finished_at = NULL",
                params![format!("{}-index", journal.operation_id), task.root_id, task.storage_pool_id, task.target_path, now, now],
            ).map_err(DownloadError::database)?;
            transaction.execute("DELETE FROM download_publish_journal WHERE task_id = ?", [&journal.task_id])
                .map_err(DownloadError::database)?;
            transaction.execute("DELETE FROM download_segments WHERE task_id = ?", [&journal.task_id])
                .map_err(DownloadError::database)?;
            transaction.execute("DELETE FROM download_space_reservations WHERE task_id = ?", [&journal.task_id])
                .map_err(DownloadError::database)?;
            transaction.commit().map_err(DownloadError::database)?;
            Ok(())
        }).await
    }

    pub async fn recover_unpublished(&self, task_id: &str) -> DbResult<bool> {
        let task_id = task_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(DownloadError::database)?;
            let now = now_iso();
            let changed = transaction.execute(
                "UPDATE download_tasks SET \
                   status = CASE control_requested WHEN 'pause' THEN 'paused' WHEN 'cancel' THEN 'cancelled' ELSE 'queued' END, \
                   phase = NULL, worker_id = NULL, lease_expires_at = NULL, speed_bytes_per_second = 0, \
                   control_requested = NULL, finished_at = CASE WHEN control_requested = 'cancel' THEN ? ELSE NULL END, updated_at = ? \
                 WHERE id = ? AND NOT (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at > ?)",
                params![now, now, task_id, now],
            ).map_err(DownloadError::database)?;
            if changed == 1 {
                transaction.execute("DELETE FROM download_publish_journal WHERE task_id = ?", [&task_id])
                    .map_err(DownloadError::database)?;
            }
            transaction.commit().map_err(DownloadError::database)?;
            Ok(changed == 1)
        }).await
    }

    pub async fn fail_recovery(&self, task_id: &str, code: &str, message: &str) -> DbResult<()> {
        let task_id = task_id.to_owned();
        let code = code.to_owned();
        let message = message.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(DownloadError::database)?;
            transaction.execute("DELETE FROM download_publish_journal WHERE task_id = ?", [&task_id])
                .map_err(DownloadError::database)?;
            transaction.execute(
                "UPDATE download_tasks SET status = 'failed', phase = NULL, error = ?, error_code = ?, error_retryable = 0, \
                   worker_id = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?",
                params![message, code, now_iso(), now_iso(), task_id],
            ).map_err(DownloadError::database)?;
            transaction.execute("DELETE FROM download_space_reservations WHERE task_id = ?", [&task_id])
                .map_err(DownloadError::database)?;
            transaction.commit().map_err(DownloadError::database)?;
            Ok(())
        }).await
    }

    pub async fn finish_control(&self, task: &Task, cancelled: bool) -> DbResult<()> {
        let task_id = task.id.clone();
        let worker_id = task.worker_id.clone().unwrap_or_default();
        self.call(move |connection| {
            let status = if cancelled { "cancelled" } else { "paused" };
            let now = now_iso();
            let transaction = connection.transaction().map_err(DownloadError::database)?;
            let changed = transaction.execute(
                "UPDATE download_tasks SET status = ?, phase = NULL, control_requested = NULL, worker_id = NULL, lease_expires_at = NULL, \
                   speed_bytes_per_second = 0, finished_at = CASE WHEN ? THEN ? ELSE NULL END, updated_at = ? \
                 WHERE id = ? AND status = 'running' AND worker_id = ?",
                params![status, cancelled, now, now, task_id, worker_id],
            ).map_err(DownloadError::database)?;
            if changed == 1 {
                transaction.execute("DELETE FROM download_space_reservations WHERE task_id = ?", [task_id])
                    .map_err(DownloadError::database)?;
            }
            transaction.commit().map_err(DownloadError::database)?;
            Ok(())
        }).await
    }

    pub async fn fail_or_retry(
        &self,
        task: &Task,
        error: &DownloadError,
        settings: &DownloadSettings,
        retry_delay: Option<Duration>,
    ) -> DbResult<bool> {
        let task_id = task.id.clone();
        let worker_id = task.worker_id.clone().unwrap_or_default();
        let code = error.code.as_str().to_owned();
        let message = error.message.clone();
        let error_retryable = error.retryable;
        let retry = error.retryable
            && task.retry_count < settings.max_auto_retries
            && retry_delay.is_some();
        let next_retry_at = retry_delay.map(future_iso);
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(DownloadError::database)?;
            let changed = transaction.execute(
                "UPDATE download_tasks SET status = ?, phase = ?, error = ?, error_code = ?, error_retryable = ?, \
                   retry_count = retry_count + ?, next_retry_at = ?, worker_id = NULL, lease_expires_at = NULL, \
                   speed_bytes_per_second = 0, control_requested = NULL, finished_at = ?, updated_at = ? \
                 WHERE id = ? AND status = 'running' AND worker_id = ?",
                params![if retry { "queued" } else { "failed" }, if retry { Some("retry_wait") } else { None },
                    message, code, error_retryable, if retry { 1 } else { 0 }, next_retry_at,
                    if retry { None } else { Some(now_iso()) }, now_iso(), task_id, worker_id],
            ).map_err(DownloadError::database)?;
            if changed == 1 {
                transaction.execute("DELETE FROM download_space_reservations WHERE task_id = ?", [&task_id])
                    .map_err(DownloadError::database)?;
            }
            transaction.commit().map_err(DownloadError::database)?;
            Ok(retry && changed == 1)
        }).await
    }

    pub async fn requeue_owned(&self, worker_id: &str) -> DbResult<()> {
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(DownloadError::database)?;
            let now = now_iso();
            transaction.execute(
                "UPDATE download_tasks SET \
                   status = CASE control_requested WHEN 'pause' THEN 'paused' WHEN 'cancel' THEN 'cancelled' ELSE 'queued' END, \
                   phase = NULL, worker_id = NULL, lease_expires_at = NULL, speed_bytes_per_second = 0, \
                   control_requested = NULL, finished_at = CASE WHEN control_requested = 'cancel' THEN ? ELSE NULL END, updated_at = ? \
                 WHERE status = 'running' AND worker_id = ?",
                params![now, now, worker_id],
            ).map_err(DownloadError::database)?;
            transaction.execute(
                "DELETE FROM download_space_reservations WHERE task_id IN (SELECT id FROM download_tasks WHERE worker_id IS NULL)",
                [],
            ).map_err(DownloadError::database)?;
            transaction.commit().map_err(DownloadError::database)?;
            Ok(())
        }).await
    }
}

fn map_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        url: row.get(1)?,
        root_id: row.get(2)?,
        storage_pool_id: row.get(3)?,
        target_directory: row.get(4)?,
        target_file_name: row.get(5)?,
        target_path: row.get(6)?,
        partial_path: row.get(7)?,
        status: row.get(8)?,
        received_bytes: row.get::<_, i64>(9)?.max(0) as u64,
        total_bytes: row
            .get::<_, Option<i64>>(10)?
            .map(|value| value.max(0) as u64),
        speed_bytes_per_second: row.get::<_, i64>(11)?.max(0) as u64,
        etag: row.get(12)?,
        last_modified: row.get(13)?,
        worker_id: row.get(14)?,
        lease_expires_at: row.get(15)?,
        phase: row.get(16)?,
        download_mode: row.get(17)?,
        expected_sha256: row.get(18)?,
        actual_sha256: row.get(19)?,
        retry_count: row.get::<_, i64>(20)?.max(0) as u32,
        next_retry_at: row.get(21)?,
        control_requested: row.get(22)?,
        segment_count: row.get::<_, i64>(23)?.max(0) as u32,
        root_path: row.get(24)?,
    })
}

fn ensure_owned(changed: usize) -> DbResult<()> {
    if changed == 1 {
        Ok(())
    } else {
        Err(lease_lost())
    }
}

fn lease_lost() -> DownloadError {
    DownloadError::new(
        ErrorCode::Internal,
        "download task lease or control ownership was lost",
        false,
    )
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC3339 formatting cannot fail")
}

fn future_iso(duration: Duration) -> String {
    (OffsetDateTime::now_utc() + time::Duration::try_from(duration).unwrap_or(time::Duration::MAX))
        .format(&Rfc3339)
        .expect("RFC3339 formatting cannot fail")
}

fn ago_iso(duration: Duration) -> String {
    (OffsetDateTime::now_utc() - time::Duration::try_from(duration).unwrap_or(time::Duration::MAX))
        .format(&Rfc3339)
        .expect("RFC3339 formatting cannot fail")
}

fn i64_from(value: u64) -> DbResult<i64> {
    i64::try_from(value).map_err(|_| {
        DownloadError::new(
            ErrorCode::SizeLimit,
            "download size exceeds SQLite integer range",
            false,
        )
    })
}

fn validate_range(name: &str, value: u64, minimum: u64, maximum: u64) -> DbResult<()> {
    if (minimum..=maximum).contains(&value) {
        Ok(())
    } else {
        Err(invalid_setting(name))
    }
}

fn invalid_setting(name: &str) -> DownloadError {
    DownloadError::new(
        ErrorCode::Database,
        format!("invalid download setting: {name}"),
        false,
    )
}

#[cfg(test)]
pub(crate) const TEST_SCHEMA: &str = r#"
CREATE TABLE nas_roots (id TEXT PRIMARY KEY, path TEXT NOT NULL);
CREATE TABLE file_operations (
  id TEXT PRIMARY KEY, approval_id TEXT, operation TEXT NOT NULL, source_path TEXT,
  target_path TEXT, status TEXT NOT NULL, metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE download_tasks (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, root_id TEXT NOT NULL,
  storage_pool_id TEXT NOT NULL, target_directory TEXT NOT NULL,
  target_file_name TEXT NOT NULL, target_path TEXT NOT NULL, partial_path TEXT NOT NULL,
  status TEXT NOT NULL, received_bytes INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER,
  speed_bytes_per_second INTEGER NOT NULL DEFAULT 0, etag TEXT, last_modified TEXT,
  error TEXT, worker_id TEXT, lease_expires_at TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, last_progress_at TEXT,
  file_operation_id TEXT, phase TEXT, download_mode TEXT, expected_sha256 TEXT,
  actual_sha256 TEXT, error_code TEXT, error_retryable INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, control_requested TEXT,
  segment_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE download_segments (
  task_id TEXT NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
  next_byte INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (task_id, start_byte)
);
CREATE TABLE download_publish_journal (
  task_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, worker_id TEXT NOT NULL,
  device INTEGER NOT NULL, inode INTEGER NOT NULL, size_bytes INTEGER NOT NULL,
  sha256 TEXT, created_at TEXT NOT NULL
);
CREATE TABLE download_space_reservations (
  task_id TEXT PRIMARY KEY, storage_pool_id TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE download_workers (
  worker_id TEXT PRIMARY KEY, version TEXT NOT NULL,
  started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL
);
CREATE TABLE index_queue (
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL, storage_pool_id TEXT, path TEXT NOT NULL,
  recursive INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued', retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT, worker_id TEXT, lease_expires_at TEXT, error TEXT, error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  UNIQUE(root_id, path)
);
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn journal_fences_claims_and_live_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let db = Db::open(&directory.path().join("test.sqlite")).unwrap();
        db.test_call(|connection| {
            connection
                .execute_batch(TEST_SCHEMA)
                .map_err(DownloadError::database)?;
            connection
                .execute("INSERT INTO nas_roots (id, path) VALUES ('root', '/tmp')", [])
                .map_err(DownloadError::database)?;
            connection.execute(
                "INSERT INTO download_tasks (id, url, root_id, storage_pool_id, target_directory, \
                   target_file_name, target_path, partial_path, status, worker_id, lease_expires_at, \
                   created_at, updated_at) VALUES \
                   ('task', 'https://example.com/file', 'root', '/tmp', '.', 'file', 'file', '.part', \
                    'running', 'owner', ?, ?, ?)",
                params![future_iso(Duration::from_secs(60)), now_iso(), now_iso()],
            ).map_err(DownloadError::database)?;
            connection.execute(
                "INSERT INTO download_publish_journal \
                   (task_id, operation_id, worker_id, device, inode, size_bytes, created_at) \
                   VALUES ('task', 'download:task', 'owner', 1, 2, 3, ?)",
                [now_iso()],
            ).map_err(DownloadError::database)?;
            Ok(())
        }).await.unwrap();

        assert!(
            db.claim("other", Duration::from_secs(30))
                .await
                .unwrap()
                .is_none()
        );
        assert!(!db.recover_unpublished("task").await.unwrap());
        assert_eq!(
            db.get_task("task").await.unwrap().unwrap().status,
            "running"
        );
        assert_eq!(db.journals().await.unwrap().len(), 1);

        db.test_call(|connection| {
            connection.execute(
                "UPDATE download_tasks SET lease_expires_at = '1970-01-01T00:00:00Z', control_requested = 'pause' WHERE id = 'task'",
                [],
            ).map_err(DownloadError::database)?;
            Ok(())
        }).await.unwrap();
        assert_eq!(db.recover_expired().await.unwrap(), 0);
        assert!(db.recover_unpublished("task").await.unwrap());
        let recovered = db.get_task("task").await.unwrap().unwrap();
        assert_eq!(recovered.status, "paused");
        assert!(recovered.worker_id.is_none());
        assert!(db.journals().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn database_actor_executes_transfer_and_retry_state_machine() {
        let directory = tempfile::tempdir().unwrap();
        let db = Db::open(&directory.path().join("test.sqlite")).unwrap();
        db.test_call(|connection| {
            connection
                .execute_batch(TEST_SCHEMA)
                .map_err(DownloadError::database)?;
            connection
                .execute(
                    "INSERT INTO nas_roots (id, path) VALUES ('root', '/tmp')",
                    [],
                )
                .map_err(DownloadError::database)?;
            connection
                .execute(
                    "INSERT INTO system_settings (key, value_json, updated_at) \
                 VALUES ('download_settings', '{\"concurrency\":2}', '2026-01-01T00:00:00Z')",
                    [],
                )
                .map_err(DownloadError::database)?;
            insert_queued_task(connection, "complete")?;
            Ok(())
        })
        .await
        .unwrap();

        let settings = db.settings().await.unwrap();
        assert_eq!(settings.concurrency, 2);
        assert_eq!(settings.parallel_requests_per_task, 4);
        db.register_worker("worker", "test").await.unwrap();
        db.heartbeat_worker("worker").await.unwrap();
        let task = db
            .claim("worker", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        assert!(
            db.progress(
                &task.id,
                "worker",
                Duration::from_secs(30),
                Progress {
                    received_bytes: 1,
                    total_bytes: Some(10),
                    speed_bytes_per_second: 1,
                    etag: Some("\"v1\""),
                    last_modified: None,
                    phase: "downloading",
                    mode: "segmented",
                    segment_count: 1,
                },
            )
            .await
            .unwrap()
        );
        db.reset_transfer(&task.id, "worker").await.unwrap();
        db.replace_segments(
            &task.id,
            "worker",
            &[Segment {
                start: 0,
                end: 10,
                next: 0,
            }],
        )
        .await
        .unwrap();
        db.reserve_space(&task, 10, 100, 5).await.unwrap();
        assert!(
            db.checkpoint_segment(
                &task.id,
                "worker",
                SegmentCheckpoint {
                    start: 0,
                    next: 10,
                    total: 10,
                    speed_bytes_per_second: 5,
                },
                Duration::from_secs(30),
            )
            .await
            .unwrap()
        );
        assert!(
            db.set_actual_checksum(&task.id, "worker", &"a".repeat(64))
                .await
                .unwrap()
        );
        let journal = PublishJournal {
            task_id: task.id.clone(),
            operation_id: "download:complete".to_owned(),
            worker_id: "worker".to_owned(),
            device: 1,
            inode: 2,
            size_bytes: 10,
            sha256: Some("a".repeat(64)),
        };
        db.begin_publish(journal.clone()).await.unwrap();
        db.finalize_publish(&journal, &task, "segmented")
            .await
            .unwrap();
        db.finalize_publish(&journal, &task, "segmented")
            .await
            .unwrap();
        assert_eq!(
            db.get_task(&task.id).await.unwrap().unwrap().status,
            "completed"
        );
        let queued_index = db
            .test_call(|connection| {
                connection
                    .query_row(
                        "SELECT root_id, storage_pool_id, path, generation, status FROM index_queue WHERE root_id = 'root' AND path = 'complete.bin'",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, i64>(3)?,
                                row.get::<_, String>(4)?,
                            ))
                        },
                    )
                    .map_err(DownloadError::database)
            })
            .await
            .unwrap();
        assert_eq!(
            queued_index,
            (
                "root".to_owned(),
                "/tmp".to_owned(),
                "complete.bin".to_owned(),
                1,
                "queued".to_owned()
            )
        );

        db.test_call(|connection| insert_queued_task(connection, "retry"))
            .await
            .unwrap();
        let retry_task = db
            .claim("worker", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        let retry_error = DownloadError::new(ErrorCode::Connect, "disconnected", true);
        assert!(
            db.fail_or_retry(
                &retry_task,
                &retry_error,
                &DownloadSettings::default(),
                Some(Duration::from_secs(1)),
            )
            .await
            .unwrap()
        );
        let retry_task = db.get_task("retry").await.unwrap().unwrap();
        assert_eq!(retry_task.status, "queued");
        assert_eq!(retry_task.retry_count, 1);
        assert!(retry_task.next_retry_at.is_some());

        db.test_call(|connection| insert_queued_task(connection, "shutdown"))
            .await
            .unwrap();
        let shutdown_task = db
            .claim("worker", Duration::from_secs(30))
            .await
            .unwrap()
            .unwrap();
        let shutdown_task_id = shutdown_task.id.clone();
        db.test_call(move |connection| {
            connection
                .execute(
                    "UPDATE download_tasks SET control_requested = 'pause' WHERE id = ?",
                    [shutdown_task_id],
                )
                .map_err(DownloadError::database)?;
            Ok(())
        })
        .await
        .unwrap();
        assert!(
            !db.extend_lease(&shutdown_task.id, "worker", Duration::from_secs(30))
                .await
                .unwrap()
        );
        db.requeue_owned("worker").await.unwrap();
        assert_eq!(
            db.get_task("shutdown").await.unwrap().unwrap().status,
            "paused"
        );

        db.remove_worker("worker").await.unwrap();
    }

    fn insert_queued_task(connection: &Connection, id: &str) -> DbResult<()> {
        connection
            .execute(
                "INSERT INTO download_tasks (id, url, root_id, storage_pool_id, target_directory, \
               target_file_name, target_path, partial_path, status, created_at, updated_at) \
             VALUES (?, 'https://example.com/file', 'root', '/tmp', '.', ?, ?, ?, 'queued', ?, ?)",
                params![
                    id,
                    format!("{id}.bin"),
                    format!("{id}.bin"),
                    format!(".{id}.part"),
                    now_iso(),
                    now_iso()
                ],
            )
            .map_err(DownloadError::database)?;
        Ok(())
    }
}
