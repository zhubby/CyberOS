use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::{ErrorCode, IndexerError};
use crate::extractor::ExtractedFile;
use crate::media::{MediaCatalogEntry, MediaScanTask};
use crate::storage::{FileIdentity, MountIdentity};

type DbResult<T> = Result<T, IndexerError>;
type DbJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

#[derive(Clone)]
pub struct Db {
    sender: mpsc::Sender<DbJob>,
}

#[derive(Debug, Clone)]
pub struct StoragePool {
    pub id: String,
    pub path: String,
    pub mount_policy: String,
    pub expected_source: Option<String>,
    pub expected_uuid: Option<String>,
    pub expected_fstype: Option<String>,
}

#[derive(Debug, Clone)]
pub struct QueueTask {
    pub id: String,
    pub storage_pool_id: String,
    pub storage_pool_path: String,
    pub path: String,
    pub recursive: bool,
    pub kind: String,
    pub generation: i64,
    pub retry_count: u32,
    pub mount_policy: String,
    pub expected_source: Option<String>,
    pub expected_uuid: Option<String>,
    pub expected_fstype: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ExistingFile {
    pub id: String,
    pub identity: Option<FileIdentity>,
    pub has_content: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct IndexedFileRecord<'a> {
    pub storage_pool_id: &'a str,
    pub path: &'a str,
    pub name: &'a str,
    pub identity: FileIdentity,
    pub scan_generation: Option<&'a str>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexerSettings {
    pub scan_concurrency: usize,
    pub extraction_concurrency: usize,
    pub reconciliation_interval_ms: u64,
    pub max_extracted_text_bytes: usize,
    pub max_source_document_bytes: u64,
    pub command_timeout_ms: u64,
    pub max_pdf_text_pages: usize,
    pub max_ocr_pages: usize,
    pub ocr_storage_pool_ids: Vec<String>,
    pub updated_at: String,
}

impl Default for IndexerSettings {
    fn default() -> Self {
        Self {
            scan_concurrency: 4,
            extraction_concurrency: 2,
            reconciliation_interval_ms: 1_800_000,
            max_extracted_text_bytes: 2 * 1024 * 1024,
            max_source_document_bytes: 512 * 1024 * 1024,
            command_timeout_ms: 120_000,
            max_pdf_text_pages: 500,
            max_ocr_pages: 20,
            ocr_storage_pool_ids: Vec::new(),
            updated_at: String::new(),
        }
    }
}

impl IndexerSettings {
    pub fn command_timeout(&self) -> Duration {
        Duration::from_millis(self.command_timeout_ms)
    }

    fn validate(self) -> DbResult<Self> {
        check("scanConcurrency", self.scan_concurrency as u64, 1, 16)?;
        check(
            "extractionConcurrency",
            self.extraction_concurrency as u64,
            1,
            8,
        )?;
        check(
            "reconciliationIntervalMs",
            self.reconciliation_interval_ms,
            60_000,
            86_400_000,
        )?;
        check(
            "maxExtractedTextBytes",
            self.max_extracted_text_bytes as u64,
            64 * 1024,
            16 * 1024 * 1024,
        )?;
        check(
            "maxSourceDocumentBytes",
            self.max_source_document_bytes,
            1024 * 1024,
            2 * 1024_u64.pow(4),
        )?;
        check("commandTimeoutMs", self.command_timeout_ms, 5_000, 900_000)?;
        check("maxPdfTextPages", self.max_pdf_text_pages as u64, 1, 5_000)?;
        check("maxOcrPages", self.max_ocr_pages as u64, 1, 100)?;
        Ok(self)
    }
}

#[derive(Debug, Default, Clone)]
pub struct RunStats {
    pub scanned: u64,
    pub indexed: u64,
    pub unchanged: u64,
    pub removed: u64,
    pub skipped: u64,
    pub failed: u64,
    pub bytes: u64,
    pub text_files: u64,
    pub failures: Vec<(String, String)>,
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(IndexerError::storage)?;
        }
        let connection = Connection::open(path).map_err(IndexerError::database)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(IndexerError::database)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(IndexerError::database)?;
        connection
            .pragma_update(None, "busy_timeout", 30_000)
            .map_err(IndexerError::database)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(IndexerError::database)?;
        let (sender, receiver) = mpsc::channel::<DbJob>();
        std::thread::Builder::new()
            .name("cyberos-indexer-db".to_owned())
            .spawn(move || {
                let mut connection = connection;
                while let Ok(job) = receiver.recv() {
                    job(&mut connection);
                }
            })
            .map_err(IndexerError::storage)?;
        Ok(Self { sender })
    }

    pub(crate) async fn call<T, F>(&self, operation: F) -> DbResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> DbResult<T> + Send + 'static,
    {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(Box::new(move |connection| {
                let _ = sender.send(operation(connection));
            }))
            .map_err(|_| IndexerError::database("Database thread stopped"))?;
        receiver
            .await
            .map_err(|_| IndexerError::database("Database response channel closed"))?
    }

    pub async fn wait_for_schema(&self, timeout: Duration) -> DbResult<()> {
        let started = tokio::time::Instant::now();
        loop {
            let ready = self
                .call(|connection| {
                    Ok(connection
                        .query_row(
                            "SELECT 1 FROM schema_migrations WHERE id = '001_cyberos_2_0'",
                            [],
                            |_| Ok(()),
                        )
                        .optional()
                        .unwrap_or(None)
                        .is_some())
                })
                .await
                .unwrap_or(false);
            if ready {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err(IndexerError::new(
                    ErrorCode::Database,
                    "CyberOS 2.0 database baseline is not applied",
                    true,
                ));
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    pub async fn settings(&self) -> DbResult<IndexerSettings> {
        self.call(|connection| {
            let json: Option<String> = connection
                .query_row(
                    "SELECT value_json FROM system_settings WHERE key = 'indexer_settings'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(IndexerError::database)?;
            match json {
                Some(json) => serde_json::from_str::<IndexerSettings>(&json)
                    .map_err(IndexerError::database)?
                    .validate(),
                None => IndexerSettings::default().validate(),
            }
        })
        .await
    }

    pub async fn heartbeat(&self, worker_id: &str, version: &str) -> DbResult<()> {
        let worker_id = worker_id.to_owned();
        let version = version.to_owned();
        self.call(move |connection| {
            let now = now_iso();
            connection.execute(
                "INSERT INTO indexer_workers (worker_id, version, started_at, heartbeat_at) VALUES (?, ?, ?, ?) \
                 ON CONFLICT(worker_id) DO UPDATE SET version = excluded.version, heartbeat_at = excluded.heartbeat_at",
                params![worker_id, version, now, now],
            ).map_err(IndexerError::database)?;
            connection.execute("DELETE FROM indexer_workers WHERE heartbeat_at < ?", [ago_iso(Duration::from_secs(300))])
                .map_err(IndexerError::database)?;
            Ok(())
        }).await
    }

    pub async fn release_worker(&self, worker_id: &str) -> DbResult<()> {
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            connection
                .execute(
                    "DELETE FROM indexer_workers WHERE worker_id = ?",
                    [worker_id],
                )
                .map_err(IndexerError::database)?;
            Ok(())
        })
        .await
    }

    pub async fn ensure_storage_pool_state(&self, storage_pools: &[StoragePool]) -> DbResult<()> {
        let storage_pools = storage_pools.to_vec();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(IndexerError::database)?;
            let now = now_iso();
            for storage_pool in storage_pools {
                transaction.execute(
                    "INSERT INTO index_storage_pool_state (storage_pool_id, updated_at) VALUES (?, ?) ON CONFLICT(storage_pool_id) DO NOTHING",
                    params![storage_pool.id, now],
                ).map_err(IndexerError::database)?;
                transaction.execute(
                    "INSERT INTO index_content_state (storage_pool_id, status, updated_at) \
                     VALUES (?, 'ready', ?) ON CONFLICT(storage_pool_id) DO NOTHING",
                    params![storage_pool.id, now],
                ).map_err(IndexerError::database)?;
            }
            transaction.commit().map_err(IndexerError::database)
        }).await
    }

    pub async fn ensure_reconciliation_tasks(&self, interval: Duration) -> DbResult<()> {
        self.call(move |connection| {
            let cutoff = ago_iso(interval);
            let mut statement = connection.prepare(
                "SELECT storage_pool_id FROM index_storage_pool_state \
                 WHERE reconcile_requested = 1 OR last_reconcile_at IS NULL OR last_reconcile_at <= ?"
            ).map_err(IndexerError::database)?;
            let storage_pools = statement.query_map([cutoff], |row| row.get::<_, String>(0))
                .map_err(IndexerError::database)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(IndexerError::database)?;
            drop(statement);
            for storage_pool_id in storage_pools {
                enqueue(connection, &storage_pool_id, ".", true, "full", 10)?;
            }
            Ok(())
        }).await
    }

    pub async fn enqueue(
        &self,
        storage_pool_id: &str,
        path: &str,
        recursive: bool,
        kind: &str,
        priority: i64,
    ) -> DbResult<()> {
        let values = (storage_pool_id.to_owned(), path.to_owned(), kind.to_owned());
        self.call(move |connection| {
            enqueue(
                connection, &values.0, &values.1, recursive, &values.2, priority,
            )
        })
        .await
    }

    pub async fn claim(
        &self,
        worker_id: &str,
        storage_pools: &[StoragePool],
    ) -> DbResult<Option<QueueTask>> {
        let worker_id = worker_id.to_owned();
        let storage_pools = storage_pools.to_vec();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(IndexerError::database)?;
            let now = now_iso();
            transaction.execute(
                "UPDATE index_queue SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = ? \
                 WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
                params![now, now],
            ).map_err(IndexerError::database)?;
            let id: Option<String> = transaction.query_row(
                "SELECT id FROM index_queue WHERE status = 'queued' OR (status = 'retrying' AND next_retry_at <= ?) \
                 ORDER BY priority DESC, COALESCE(next_retry_at, created_at), created_at LIMIT 1",
                [&now],
                |row| row.get(0),
            ).optional().map_err(IndexerError::database)?;
            let Some(id) = id else {
                transaction.commit().map_err(IndexerError::database)?;
                return Ok(None);
            };
            transaction.execute(
                "UPDATE index_queue SET status = 'running', worker_id = ?, lease_expires_at = ?, \
                 started_at = COALESCE(started_at, ?), next_retry_at = NULL, error = NULL, error_code = NULL, updated_at = ? WHERE id = ?",
                params![worker_id, future_iso(Duration::from_secs(30)), now, now, id],
            ).map_err(IndexerError::database)?;
            let row = transaction.query_row(
                "SELECT id, storage_pool_id, path, recursive, kind, generation, retry_count \
                 FROM index_queue WHERE id = ?",
                [&id],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? != 0,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?.max(0) as u32,
                )),
            ).map_err(IndexerError::database)?;
            let storage_pool = storage_pools.iter().find(|pool| pool.id == row.1).ok_or_else(|| {
                IndexerError::new(
                    ErrorCode::StorageUnavailable,
                    format!("Storage pool {} is unavailable", row.1),
                    true,
                )
            })?;
            let task = QueueTask {
                id: row.0,
                storage_pool_id: row.1,
                storage_pool_path: storage_pool.path.clone(),
                path: row.2,
                recursive: row.3,
                kind: row.4,
                generation: row.5,
                retry_count: row.6,
                mount_policy: storage_pool.mount_policy.clone(),
                expected_source: storage_pool.expected_source.clone(),
                expected_uuid: storage_pool.expected_uuid.clone(),
                expected_fstype: storage_pool.expected_fstype.clone(),
            };
            transaction.commit().map_err(IndexerError::database)?;
            Ok(Some(task))
        }).await
    }

    pub async fn renew_lease(
        &self,
        task_id: &str,
        generation: i64,
        worker_id: &str,
    ) -> DbResult<bool> {
        let values = (task_id.to_owned(), worker_id.to_owned());
        self.call(move |connection| {
            Ok(connection
                .execute(
                    "UPDATE index_queue SET lease_expires_at = ?, updated_at = ? \
                 WHERE id = ? AND generation = ? AND status = 'running' AND worker_id = ?",
                    params![
                        future_iso(Duration::from_secs(30)),
                        now_iso(),
                        values.0,
                        generation,
                        values.1
                    ],
                )
                .map_err(IndexerError::database)?
                == 1)
        })
        .await
    }

    pub async fn complete_task(&self, task: &QueueTask, worker_id: &str) -> DbResult<bool> {
        let values = (task.id.clone(), worker_id.to_owned());
        let generation = task.generation;
        self.call(move |connection| {
            Ok(connection.execute(
                "DELETE FROM index_queue WHERE id = ? AND generation = ? AND status = 'running' AND worker_id = ?",
                params![values.0, generation, values.1],
            ).map_err(IndexerError::database)? == 1)
        }).await
    }

    pub async fn retry_or_fail(
        &self,
        task: &QueueTask,
        worker_id: &str,
        error: &IndexerError,
    ) -> DbResult<()> {
        let values = (
            task.id.clone(),
            worker_id.to_owned(),
            error.message.clone(),
            error.code.as_str().to_owned(),
        );
        let generation = task.generation;
        let retry_count = task.retry_count + 1;
        let retry = error.retryable && retry_count <= 5;
        let delay = Duration::from_secs(
            (2_u64.saturating_mul(2_u64.saturating_pow(task.retry_count))).min(300),
        );
        self.call(move |connection| {
            connection.execute(
                "UPDATE index_queue SET status = ?, retry_count = ?, next_retry_at = ?, worker_id = NULL, \
                 lease_expires_at = NULL, error = ?, error_code = ?, updated_at = ?, finished_at = ? \
                 WHERE id = ? AND generation = ? AND status = 'running' AND worker_id = ?",
                params![
                    if retry { "retrying" } else { "failed" },
                    retry_count,
                    if retry { Some(future_iso(delay)) } else { None },
                    values.2,
                    values.3,
                    now_iso(),
                    if retry { None } else { Some(now_iso()) },
                    values.0,
                    generation,
                    values.1,
                ],
            ).map_err(IndexerError::database)?;
            Ok(())
        }).await
    }

    pub async fn existing_file(
        &self,
        storage_pool_id: &str,
        path: &str,
    ) -> DbResult<Option<ExistingFile>> {
        let values = (storage_pool_id.to_owned(), path.to_owned());
        self.call(move |connection| {
            connection.query_row(
                "SELECT f.id, f.source_device, f.source_inode, f.source_size_bytes, f.source_mtime_ns, f.source_ctime_ns, \
                   EXISTS(SELECT 1 FROM indexed_content_fts c WHERE c.file_id = f.id) \
                 FROM indexed_files f WHERE f.storage_pool_id = ? AND f.path = ?",
                params![values.0, values.1],
                |row| {
                    let device: Option<i64> = row.get(1)?;
                    let inode: Option<i64> = row.get(2)?;
                    let size: Option<i64> = row.get(3)?;
                    let mtime_ns: Option<i64> = row.get(4)?;
                    let ctime_ns: Option<i64> = row.get(5)?;
                    Ok(ExistingFile {
                        id: row.get(0)?,
                        identity: device.map(|device| FileIdentity {
                            device: device as u64,
                            inode: inode.unwrap_or_default() as u64,
                            size: size.unwrap_or_default() as u64,
                            mtime_ns: mtime_ns.unwrap_or_default(),
                            ctime_ns: ctime_ns.unwrap_or_default(),
                        }),
                        has_content: row.get::<_, i64>(6)? != 0,
                    })
                },
            ).optional().map_err(IndexerError::database)
        }).await
    }

    pub async fn publish_file(
        &self,
        file: IndexedFileRecord<'_>,
        extracted: ExtractedFile,
    ) -> DbResult<()> {
        let values = (
            file.storage_pool_id.to_owned(),
            file.path.to_owned(),
            file.name.to_owned(),
            file.scan_generation.map(str::to_owned),
        );
        let identity = file.identity;
        self.call(move |connection| {
            // Acquire the writer lock before establishing a read snapshot;
            // WAL read-to-write upgrades can bypass busy_timeout.
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(IndexerError::database)?;
            let id = transaction.query_row(
                "SELECT id FROM indexed_files WHERE storage_pool_id = ? AND path = ?",
                params![values.0, values.1],
                |row| row.get::<_, String>(0),
            ).optional().map_err(IndexerError::database)?.unwrap_or_else(|| Uuid::new_v4().to_string());
            let now = now_iso();
            transaction.execute(
                "INSERT INTO indexed_files (
                   id, storage_pool_id, path, name, mime_type, size_bytes, mtime_ms, hash, indexed_at,
                   source_device, source_inode, source_size_bytes, source_mtime_ns, source_ctime_ns,
                   scan_generation, extraction_source, extraction_status, extraction_error
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                 ON CONFLICT(storage_pool_id, path) DO UPDATE SET
                   name = excluded.name, mime_type = excluded.mime_type, size_bytes = excluded.size_bytes,
                   mtime_ms = excluded.mtime_ms, hash = excluded.hash, indexed_at = excluded.indexed_at,
                   source_device = excluded.source_device, source_inode = excluded.source_inode,
                   source_size_bytes = excluded.source_size_bytes, source_mtime_ns = excluded.source_mtime_ns,
                   source_ctime_ns = excluded.source_ctime_ns, scan_generation = COALESCE(excluded.scan_generation, indexed_files.scan_generation),
                   extraction_source = excluded.extraction_source, extraction_status = excluded.extraction_status,
                   extraction_error = NULL",
                params![
                    id, values.0, values.1, values.2, extracted.mime_type,
                    i64_from(identity.size)?, identity.mtime_ns / 1_000_000, extracted.hash, now,
                    i64_from(identity.device)?, i64_from(identity.inode)?, i64_from(identity.size)?,
                    identity.mtime_ns, identity.ctime_ns, values.3,
                    extracted.source.map(|source| source.as_str()), extracted.status,
                ],
            ).map_err(IndexerError::database)?;
            transaction.execute("DELETE FROM indexed_content_fts WHERE file_id = ?", [&id])
                .map_err(IndexerError::database)?;
            transaction.execute(
                "INSERT INTO indexed_content_fts (file_id, storage_pool_id, path, name, body, terms) VALUES (?, ?, ?, ?, ?, ?)",
                params![id, values.0, values.1, values.2, extracted.body, extracted.terms],
            ).map_err(IndexerError::database)?;
            transaction.commit().map_err(IndexerError::database)
        }).await
    }

    pub async fn record_extraction_error(
        &self,
        file: IndexedFileRecord<'_>,
        error: &IndexerError,
    ) -> DbResult<()> {
        let values = (
            file.storage_pool_id.to_owned(),
            file.path.to_owned(),
            file.name.to_owned(),
            file.scan_generation.map(str::to_owned),
            error.message.clone(),
        );
        let identity = file.identity;
        self.call(move |connection| {
            let id = connection.query_row(
                "SELECT id FROM indexed_files WHERE storage_pool_id = ? AND path = ?",
                params![values.0, values.1], |row| row.get::<_, String>(0),
            ).optional().map_err(IndexerError::database)?;
            if let Some(id) = id {
                let has_content: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM indexed_content_fts WHERE file_id = ?)",
                    [&id], |row| row.get(0),
                ).map_err(IndexerError::database)?;
                connection.execute(
                    "UPDATE indexed_files SET name = ?, size_bytes = ?, mtime_ms = ?, source_device = ?, source_inode = ?,
                       source_size_bytes = ?, source_mtime_ns = ?, source_ctime_ns = ?, scan_generation = COALESCE(?, scan_generation),
                       extraction_status = ?, extraction_error = ? WHERE id = ?",
                    params![values.2, i64_from(identity.size)?, identity.mtime_ns / 1_000_000,
                        i64_from(identity.device)?, i64_from(identity.inode)?, i64_from(identity.size)?,
                        identity.mtime_ns, identity.ctime_ns, values.3,
                        if has_content { "stale" } else { "error" }, values.4, id],
                ).map_err(IndexerError::database)?;
            } else {
                connection.execute(
                    "INSERT INTO indexed_files (
                       id, storage_pool_id, path, name, size_bytes, mtime_ms, indexed_at,
                       source_device, source_inode, source_size_bytes, source_mtime_ns, source_ctime_ns,
                       scan_generation, extraction_status, extraction_error
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'error', ?)",
                    params![Uuid::new_v4().to_string(), values.0, values.1, values.2,
                        i64_from(identity.size)?, identity.mtime_ns / 1_000_000, now_iso(),
                        i64_from(identity.device)?, i64_from(identity.inode)?, i64_from(identity.size)?,
                        identity.mtime_ns, identity.ctime_ns, values.3, values.4],
                ).map_err(IndexerError::database)?;
            }
            Ok(())
        }).await
    }

    pub async fn touch_generation(
        &self,
        storage_pool_id: &str,
        path: &str,
        generation: &str,
    ) -> DbResult<()> {
        let values = (
            storage_pool_id.to_owned(),
            path.to_owned(),
            generation.to_owned(),
        );
        self.call(move |connection| {
            connection
                .execute(
                    "UPDATE indexed_files SET scan_generation = ? WHERE storage_pool_id = ? AND path = ?",
                    params![values.2, values.0, values.1],
                )
                .map_err(IndexerError::database)?;
            Ok(())
        })
        .await
    }

    pub async fn remove_path(
        &self,
        storage_pool_id: &str,
        path: &str,
        recursive: bool,
    ) -> DbResult<u64> {
        let values = (storage_pool_id.to_owned(), path.to_owned());
        self.call(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(IndexerError::database)?;
            let ids = selected_ids(&transaction, &values.0, &values.1, recursive, None)?;
            delete_ids(&transaction, &ids)?;
            transaction.commit().map_err(IndexerError::database)?;
            Ok(ids.len() as u64)
        })
        .await
    }

    pub async fn cleanup_generation(
        &self,
        storage_pool_id: &str,
        path: &str,
        generation: &str,
        root_rebuild: bool,
    ) -> DbResult<u64> {
        let values = (
            storage_pool_id.to_owned(),
            path.to_owned(),
            generation.to_owned(),
            root_rebuild,
        );
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(IndexerError::database)?;
            let ids = selected_ids(&transaction, &values.0, &values.1, true, Some(&values.2))?;
            delete_ids(&transaction, &ids)?;
            transaction.execute(
                "DELETE FROM index_queue WHERE storage_pool_id = ? AND status = 'failed'
                   AND (? = '.' OR path = ? OR substr(path, 1, length(?) + 1) = ? || '/')",
                params![values.0, values.1, values.1, values.1, values.1],
            ).map_err(IndexerError::database)?;
            if values.3 {
                transaction.execute(
                    "UPDATE index_storage_pool_state SET active_scan_generation = NULL, completed_scan_generation = ?,
                       reconcile_requested = 0, last_reconcile_at = ?, updated_at = ? WHERE storage_pool_id = ?",
                    params![values.2, now_iso(), now_iso(), values.0],
                ).map_err(IndexerError::database)?;
                transaction.execute(
                    "UPDATE index_content_state SET status = 'ready', error = NULL, updated_at = ? WHERE storage_pool_id = ?",
                    params![now_iso(), values.0],
                ).map_err(IndexerError::database)?;
            } else {
                transaction.execute(
                    "UPDATE index_storage_pool_state SET active_scan_generation = NULL, updated_at = ? WHERE storage_pool_id = ?",
                    params![now_iso(), values.0],
                ).map_err(IndexerError::database)?;
            }
            transaction.commit().map_err(IndexerError::database)?;
            Ok(ids.len() as u64)
        }).await
    }

    pub async fn begin_generation(
        &self,
        storage_pool_id: &str,
        generation: &str,
        mount_identity: Option<&MountIdentity>,
        root_rebuild: bool,
    ) -> DbResult<()> {
        let values = (
            storage_pool_id.to_owned(),
            generation.to_owned(),
            mount_identity.and_then(|identity| identity.source.clone()),
            mount_identity.and_then(|identity| identity.uuid.clone()),
            mount_identity.and_then(|identity| identity.fstype.clone()),
            root_rebuild,
        );
        self.call(move |connection| {
            connection.execute(
                "UPDATE index_storage_pool_state SET active_scan_generation = ?, mount_source = ?, mount_uuid = ?, mount_fstype = ?, updated_at = ? WHERE storage_pool_id = ?",
                params![values.1, values.2, values.3, values.4, now_iso(), values.0],
            ).map_err(IndexerError::database)?;
            if values.5 {
                connection.execute(
                    "UPDATE index_content_state SET status = 'rebuilding', updated_at = ? WHERE storage_pool_id = ?",
                    params![now_iso(), values.0],
                ).map_err(IndexerError::database)?;
            }
            Ok(())
        }).await
    }

    pub async fn set_watcher_status(
        &self,
        storage_pool_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> DbResult<()> {
        let values = (
            storage_pool_id.to_owned(),
            status.to_owned(),
            error.map(str::to_owned),
        );
        self.call(move |connection| {
            connection.execute(
                "UPDATE index_storage_pool_state SET watcher_status = ?, watcher_error = ?,
                   reconcile_requested = CASE WHEN ? = 'degraded' THEN 1 ELSE reconcile_requested END,
                   updated_at = ? WHERE storage_pool_id = ?",
                params![values.1, values.2, values.1, now_iso(), values.0],
            ).map_err(IndexerError::database)?;
            Ok(())
        }).await
    }

    pub async fn start_run(&self, storage_pool_id: &str, kind: &str) -> DbResult<String> {
        let values = (storage_pool_id.to_owned(), kind.to_owned());
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(IndexerError::database)?;
            archive_previous_runs(&transaction, &values.0)?;
            let id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO index_runs (id, storage_pool_id, status, started_at, kind, phase, last_progress_at) \
                 VALUES (?, ?, 'running', ?, ?, 'scanning', ?)",
                params![id, values.0, now_iso(), values.1, now_iso()],
            ).map_err(IndexerError::database)?;
            transaction.commit().map_err(IndexerError::database)?;
            Ok(id)
        }).await
    }

    pub async fn finish_run(
        &self,
        run_id: &str,
        stats: &RunStats,
        completed: bool,
    ) -> DbResult<()> {
        let run_id = run_id.to_owned();
        let stats = stats.clone();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(IndexerError::database)?;
            let storage_pool_id: String = transaction.query_row("SELECT storage_pool_id FROM index_runs WHERE id = ?", [&run_id], |row| row.get(0))
                .map_err(IndexerError::database)?;
            for (path, reason) in &stats.failures {
                transaction.execute(
                    "INSERT INTO index_failures (id, run_id, storage_pool_id, path, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    params![Uuid::new_v4().to_string(), run_id, storage_pool_id, path, reason, now_iso()],
                ).map_err(IndexerError::database)?;
            }
            transaction.execute(
                "UPDATE index_runs SET status = ?, finished_at = ?, scanned = ?, indexed = ?, unchanged = ?, removed = ?,
                   skipped = ?, failed = ?, error = ?, bytes = ?, file_count = ?, text_file_count = ?, phase = 'completed', last_progress_at = ?
                 WHERE id = ? AND status = 'running'",
                params![if completed { "completed" } else { "failed" }, now_iso(),
                    i64_from(stats.scanned)?, i64_from(stats.indexed)?, i64_from(stats.unchanged)?, i64_from(stats.removed)?,
                    i64_from(stats.skipped)?, i64_from(stats.failed)?,
                    if completed { None } else { Some("one or more files failed") }, i64_from(stats.bytes)?,
                    i64_from(stats.indexed + stats.unchanged)?, i64_from(stats.text_files)?, now_iso(), run_id],
            ).map_err(IndexerError::database)?;
            transaction.commit().map_err(IndexerError::database)
        }).await
    }

    pub async fn claim_media_scan(
        &self,
        worker_id: &str,
        storage_pools: &[StoragePool],
    ) -> DbResult<Option<MediaScanTask>> {
        let worker_id = worker_id.to_owned();
        let storage_pools = storage_pools.to_vec();
        self.call(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(IndexerError::database)?;
            let now = now_iso();
            transaction.execute(
                "UPDATE media_scan_runs SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = ? \
                 WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
                params![now, now],
            ).map_err(IndexerError::database)?;
            let id: Option<String> = transaction.query_row(
                "SELECT r.id FROM media_scan_runs r JOIN media_sources s ON s.id = r.source_id \
                 WHERE r.status = 'queued' AND s.enabled = 1 ORDER BY r.created_at, r.id LIMIT 1",
                [],
                |row| row.get(0),
            ).optional().map_err(IndexerError::database)?;
            let Some(id) = id else {
                transaction.commit().map_err(IndexerError::database)?;
                return Ok(None);
            };
            transaction.execute(
                "UPDATE media_scan_runs SET status = 'running', worker_id = ?, lease_expires_at = ?, \
                 started_at = COALESCE(started_at, ?), finished_at = NULL, error = NULL, updated_at = ? \
                 WHERE id = ? AND status = 'queued'",
                params![worker_id, future_iso(Duration::from_secs(30)), now, now, id],
            ).map_err(IndexerError::database)?;
            let settings_json: Option<String> = transaction.query_row(
                "SELECT value_json FROM system_settings WHERE key = 'media_library_settings'",
                [],
                |row| row.get(0),
            ).optional().map_err(IndexerError::database)?;
            let row = transaction.query_row(
                "SELECT r.id, r.generation, s.id, s.kind, s.storage_pool_id, s.path \
                 FROM media_scan_runs r \
                 JOIN media_sources s ON s.id = r.source_id \
                 WHERE r.id = ? AND r.status = 'running' AND r.worker_id = ?",
                params![id, worker_id],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                )),
            ).map_err(IndexerError::database)?;
            let storage_pool = storage_pools.iter().find(|pool| pool.id == row.4).ok_or_else(|| {
                IndexerError::new(
                    ErrorCode::StorageUnavailable,
                    format!("Storage pool {} is unavailable", row.4),
                    true,
                )
            })?;
            let task = MediaScanTask {
                id: row.0,
                generation: row.1,
                source_id: row.2,
                kind: row.3,
                storage_pool_id: row.4,
                source_path: row.5,
                storage_pool_path: storage_pool.path.clone(),
                mount_policy: storage_pool.mount_policy.clone(),
                expected_source: storage_pool.expected_source.clone(),
                expected_uuid: storage_pool.expected_uuid.clone(),
                expected_fstype: storage_pool.expected_fstype.clone(),
                settings_json,
            };
            transaction.commit().map_err(IndexerError::database)?;
            Ok(Some(task))
        }).await
    }

    pub async fn update_media_scan_progress(
        &self,
        task_id: &str,
        worker_id: &str,
        scanned: u64,
        unmatched: u64,
        current_path: Option<&str>,
    ) -> DbResult<bool> {
        let values = (
            task_id.to_owned(),
            worker_id.to_owned(),
            current_path.map(str::to_owned),
        );
        self.call(move |connection| {
            Ok(connection.execute(
                "UPDATE media_scan_runs SET scanned = ?, unmatched = ?, current_path = ?, \
                 lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND worker_id = ?",
                params![
                    i64_from(scanned)?, i64_from(unmatched)?, values.2,
                    future_iso(Duration::from_secs(30)), now_iso(), values.0, values.1
                ],
            ).map_err(IndexerError::database)? == 1)
        }).await
    }

    pub async fn fail_media_scan(
        &self,
        task_id: &str,
        worker_id: &str,
        error: &IndexerError,
    ) -> DbResult<()> {
        let values = (
            task_id.to_owned(),
            worker_id.to_owned(),
            error.message.clone(),
        );
        self.call(move |connection| {
            connection
                .execute(
                    "UPDATE media_scan_runs SET status = 'failed', error = ?, worker_id = NULL, \
                 lease_expires_at = NULL, current_path = NULL, finished_at = ?, updated_at = ? \
                 WHERE id = ? AND status = 'running' AND worker_id = ?",
                    params![values.2, now_iso(), now_iso(), values.0, values.1],
                )
                .map_err(IndexerError::database)?;
            Ok(())
        })
        .await
    }

    pub async fn media_match_overrides(
        &self,
        source_id: &str,
    ) -> DbResult<std::collections::HashMap<String, Option<i64>>> {
        let source = source_id.to_owned();
        self.call(move |connection| {
            connection.prepare("SELECT t.source_path,o.tmdb_id FROM media_match_overrides o JOIN media_titles t ON t.id=o.title_id WHERE t.source_id=?")
                .and_then(|mut s| s.query_map([source], |r| Ok((r.get(0)?,r.get(1)?)))?.collect()).map_err(IndexerError::database)
        }).await
    }

    pub async fn publish_media_scan(
        &self,
        task: &MediaScanTask,
        worker_id: &str,
        entries: &[MediaCatalogEntry],
    ) -> DbResult<()> {
        let task = task.clone();
        let worker_id = worker_id.to_owned();
        let entries = entries.to_vec();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(IndexerError::database)?;
            let active: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM media_scan_runs \
                 WHERE id = ? AND generation = ? AND status = 'running' AND worker_id = ?)",
                params![task.id, task.generation, worker_id],
                |row| row.get(0),
            ).map_err(IndexerError::database)?;
            if !active {
                return Err(IndexerError::new(
                    ErrorCode::Database,
                    "Media scan lease was lost",
                    true,
                ));
            }
            let existing_files = transaction.prepare(
                "SELECT relative_path FROM media_files WHERE source_id = ?",
            ).and_then(|mut statement| {
                statement.query_map([&task.source_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<std::collections::HashSet<_>, _>>()
            }).map_err(IndexerError::database)?;
            transaction.execute(
                "DELETE FROM media_artwork WHERE title_id IN \
                 (SELECT id FROM media_titles WHERE source_id = ?)",
                [&task.source_id],
            ).map_err(IndexerError::database)?;
            let now = now_iso();
            for entry in &entries {
                let title_id = transaction.query_row(
                    "SELECT id FROM media_titles WHERE source_id = ? AND source_path = ?",
                    params![task.source_id, entry.title.source_path],
                    |row| row.get::<_, String>(0),
                ).optional().map_err(IndexerError::database)?
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                transaction.execute(
                    "INSERT INTO media_titles (
                       id, source_id, kind, source_path, tmdb_id, title, original_title, sort_title,
                       overview, year, release_date, runtime_minutes, original_language, genres_json,
                       metadata_source, match_status, match_confidence, poster_key, backdrop_key,
                       scan_generation, added_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(source_id, source_path) DO UPDATE SET
                       tmdb_id = excluded.tmdb_id, title = excluded.title, original_title = excluded.original_title,
                       sort_title = excluded.sort_title, overview = excluded.overview, year = excluded.year,
                       release_date = excluded.release_date, runtime_minutes = excluded.runtime_minutes,
                       original_language = excluded.original_language, genres_json = excluded.genres_json,
                       metadata_source = excluded.metadata_source, match_status = excluded.match_status,
                       match_confidence = excluded.match_confidence, poster_key = excluded.poster_key,
                       backdrop_key = excluded.backdrop_key, scan_generation = excluded.scan_generation,
                       updated_at = excluded.updated_at",
                    params![
                        title_id, task.source_id, task.kind, entry.title.source_path,
                        entry.title.tmdb_id, entry.title.title, entry.title.original_title,
                        entry.title.title.to_lowercase(), entry.title.overview, entry.title.year,
                        entry.title.release_date, entry.title.runtime_minutes,
                        entry.title.original_language, serde_json::to_string(&entry.title.genres).map_err(IndexerError::database)?,
                        entry.title.metadata_source, entry.title.match_status,
                        entry.title.match_confidence, entry.title.poster_key, entry.title.backdrop_key,
                        task.generation, now, now
                    ],
                ).map_err(IndexerError::database)?;

                transaction.execute(
                    "UPDATE media_titles SET
                       tmdb_id = (SELECT tmdb_id FROM media_match_overrides WHERE title_id = ?),
                       match_status = CASE
                         WHEN (SELECT excluded FROM media_match_overrides WHERE title_id = ?) = 1 THEN 'excluded'
                         ELSE 'matched'
                       END,
                       match_confidence = CASE
                         WHEN (SELECT excluded FROM media_match_overrides WHERE title_id = ?) = 1 THEN NULL
                         ELSE 1
                       END
                     WHERE id = ? AND EXISTS (SELECT 1 FROM media_match_overrides WHERE title_id = ?)",
                    params![title_id, title_id, title_id, title_id, title_id],
                ).map_err(IndexerError::database)?;

                transaction.execute("INSERT INTO media_title_metadata(title_id,rating,credits_json) VALUES(?,?,?) ON CONFLICT(title_id) DO UPDATE SET rating=COALESCE(excluded.rating,media_title_metadata.rating),credits_json=CASE WHEN excluded.credits_json='[]' THEN media_title_metadata.credits_json ELSE excluded.credits_json END",params![title_id,entry.title.rating,serde_json::to_string(&entry.title.credits).map_err(IndexerError::database)?]).map_err(IndexerError::database)?;
                if let Some((external_id,name)) = &entry.title.collection {
                    let collection_id = format!("tmdb-{external_id}");
                    transaction.execute("INSERT INTO media_collections(id,name,kind,external_id) VALUES(?,?,'tmdb',?) ON CONFLICT(external_id) DO UPDATE SET name=excluded.name",params![collection_id,name,external_id]).map_err(IndexerError::database)?;
                    transaction.execute("DELETE FROM media_collection_members WHERE title_id=? AND collection_id IN(SELECT id FROM media_collections WHERE kind='tmdb' AND external_id<>?)",params![title_id,external_id]).map_err(IndexerError::database)?;
                    transaction.execute("INSERT OR IGNORE INTO media_collection_members(collection_id,title_id,position) VALUES(?,?,COALESCE(?,0))",params![collection_id,title_id,entry.title.year]).map_err(IndexerError::database)?;
                }
                let mut season_id = None;
                let mut episode_id = None;
                if let (Some(season), Some(episode)) = (&entry.season, &entry.episode) {
                    let id = transaction.query_row(
                        "SELECT id FROM media_seasons WHERE title_id = ? AND season_number = ?",
                        params![title_id, season.number],
                        |row| row.get::<_, String>(0),
                    ).optional().map_err(IndexerError::database)?
                        .unwrap_or_else(|| Uuid::new_v4().to_string());
                    transaction.execute(
                        "INSERT INTO media_seasons (id, title_id, season_number, name, overview, poster_key, updated_at) \
                         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(title_id, season_number) DO UPDATE SET \
                         name = excluded.name, overview = excluded.overview, poster_key = excluded.poster_key, updated_at = excluded.updated_at",
                        params![id, title_id, season.number, season.name, season.overview, season.poster_key, now],
                    ).map_err(IndexerError::database)?;
                    let ep_id = transaction.query_row(
                        "SELECT id FROM media_episodes WHERE season_id = ? AND episode_number = ?",
                        params![id, episode.number],
                        |row| row.get::<_, String>(0),
                    ).optional().map_err(IndexerError::database)?
                        .unwrap_or_else(|| Uuid::new_v4().to_string());
                    transaction.execute(
                        "INSERT INTO media_episodes (
                           id, title_id, season_id, episode_number, name, overview, air_date,
                           runtime_minutes, still_key, updated_at
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(season_id, episode_number) DO UPDATE SET
                           name = excluded.name, overview = excluded.overview, air_date = excluded.air_date,
                           runtime_minutes = excluded.runtime_minutes, still_key = excluded.still_key,
                           updated_at = excluded.updated_at",
                        params![ep_id, title_id, id, episode.number, episode.name, episode.overview,
                            episode.air_date, episode.runtime_minutes, episode.still_key, now],
                    ).map_err(IndexerError::database)?;
                    season_id = Some(id);
                    episode_id = Some(ep_id);
                }

                let file_id = transaction.query_row(
                    "SELECT id FROM media_files WHERE source_id = ? AND relative_path = ?",
                    params![task.source_id, entry.file.relative_path],
                    |row| row.get::<_, String>(0),
                ).optional().map_err(IndexerError::database)?
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                transaction.execute(
                    "INSERT INTO media_files (
                       id, source_id, title_id, episode_id, storage_pool_id, relative_path,
                       name, mime_type, size_bytes, mtime_ms, duration_seconds, container,
                       video_codec, audio_codec, scan_generation, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(source_id, relative_path) DO UPDATE SET
                       title_id = excluded.title_id, episode_id = excluded.episode_id,
                       name = excluded.name, mime_type = excluded.mime_type, size_bytes = excluded.size_bytes,
                       mtime_ms = excluded.mtime_ms, duration_seconds = CASE WHEN media_files.size_bytes=excluded.size_bytes AND media_files.mtime_ms=excluded.mtime_ms THEN COALESCE(excluded.duration_seconds,media_files.duration_seconds) ELSE excluded.duration_seconds END,
                       container = CASE WHEN media_files.size_bytes=excluded.size_bytes AND media_files.mtime_ms=excluded.mtime_ms THEN COALESCE(excluded.container,media_files.container) ELSE excluded.container END, video_codec = CASE WHEN media_files.size_bytes=excluded.size_bytes AND media_files.mtime_ms=excluded.mtime_ms THEN COALESCE(excluded.video_codec,media_files.video_codec) ELSE excluded.video_codec END,
                       audio_codec = CASE WHEN media_files.size_bytes=excluded.size_bytes AND media_files.mtime_ms=excluded.mtime_ms THEN COALESCE(excluded.audio_codec,media_files.audio_codec) ELSE excluded.audio_codec END, scan_generation = excluded.scan_generation,
                       updated_at = excluded.updated_at",
                    params![
                        file_id, task.source_id, title_id, episode_id, task.storage_pool_id,
                        entry.file.relative_path, entry.file.name,
                        entry.file.mime_type, i64_from(entry.file.size_bytes)?, entry.file.mtime_ms,
                        entry.file.duration_seconds, entry.file.container, entry.file.video_codec,
                        entry.file.audio_codec, task.generation, now, now
                    ],
                ).map_err(IndexerError::database)?;

                for artwork in &entry.artwork {
                    let owner_season = artwork.for_season.then(|| season_id.clone()).flatten();
                    let owner_episode = artwork.for_episode.then(|| episode_id.clone()).flatten();
                    transaction.execute(
                        "INSERT INTO media_artwork (
                           id, title_id, season_id, episode_id, kind, source, source_url,
                           cache_key, width, height, language, is_primary, updated_at
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        params![Uuid::new_v4().to_string(), title_id, owner_season, owner_episode,
                            artwork.kind, artwork.source, artwork.source_url, artwork.cache_key,
                            artwork.width, artwork.height, artwork.language, i64::from(artwork.is_primary), now],
                    ).map_err(IndexerError::database)?;
                }
            }
            let removed = transaction.execute(
                "DELETE FROM media_files WHERE source_id = ? AND scan_generation <> ?",
                params![task.source_id, task.generation],
            ).map_err(IndexerError::database)?;
            transaction.execute(
                "DELETE FROM media_episodes WHERE title_id IN \
                 (SELECT id FROM media_titles WHERE source_id = ?) \
                 AND id NOT IN (SELECT episode_id FROM media_files WHERE episode_id IS NOT NULL)",
                [&task.source_id],
            ).map_err(IndexerError::database)?;
            transaction.execute(
                "DELETE FROM media_seasons WHERE title_id IN \
                 (SELECT id FROM media_titles WHERE source_id = ?) \
                 AND id NOT IN (SELECT season_id FROM media_episodes)",
                [&task.source_id],
            ).map_err(IndexerError::database)?;
            transaction.execute(
                "DELETE FROM media_titles WHERE source_id = ? \
                 AND id NOT IN (SELECT title_id FROM media_files WHERE source_id = ?)",
                params![task.source_id, task.source_id],
            ).map_err(IndexerError::database)?;
            let added = entries.iter().filter(|entry| !existing_files.contains(&entry.file.relative_path)).count();
            let updated = entries.len().saturating_sub(added);
            let unmatched = entries.iter().filter(|entry| entry.title.match_status != "matched").count();
            transaction.execute(
                "UPDATE media_scan_runs SET status = 'completed', scanned = ?, added = ?, updated = ?, removed = ?, \
                 unmatched = ?, current_path = NULL, error = NULL, worker_id = NULL, lease_expires_at = NULL, \
                 finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND worker_id = ?",
                params![i64_from(entries.len() as u64)?, i64_from(added as u64)?, i64_from(updated as u64)?,
                    i64_from(removed as u64)?, i64_from(unmatched as u64)?, now, now, task.id, worker_id],
            ).map_err(IndexerError::database)?;
            transaction.commit().map_err(IndexerError::database)
        }).await
    }
}

fn enqueue(
    connection: &Connection,
    storage_pool_id: &str,
    path: &str,
    recursive: bool,
    kind: &str,
    priority: i64,
) -> DbResult<()> {
    let now = now_iso();
    connection.execute(
        "INSERT INTO index_queue (id, storage_pool_id, path, recursive, kind, generation, priority, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 'queued', ?, ?)
         ON CONFLICT(storage_pool_id, path) DO UPDATE SET
           recursive = MAX(index_queue.recursive, excluded.recursive),
           kind = CASE WHEN excluded.kind = 'manual' THEN 'manual' WHEN index_queue.kind = 'manual' THEN index_queue.kind
             WHEN excluded.kind = 'full' THEN 'full' ELSE index_queue.kind END,
           generation = index_queue.generation + 1, priority = MAX(index_queue.priority, excluded.priority),
           status = 'queued', retry_count = 0, next_retry_at = NULL, worker_id = NULL, lease_expires_at = NULL,
           error = NULL, error_code = NULL, updated_at = excluded.updated_at, finished_at = NULL",
        params![Uuid::new_v4().to_string(), storage_pool_id, path, i64::from(recursive), kind, priority, now, now],
    ).map_err(IndexerError::database)?;
    Ok(())
}

fn selected_ids(
    transaction: &Transaction<'_>,
    storage_pool_id: &str,
    path: &str,
    recursive: bool,
    generation_to_exclude: Option<&str>,
) -> DbResult<Vec<String>> {
    let sql = if generation_to_exclude.is_some() {
        "SELECT id FROM indexed_files WHERE storage_pool_id = ? AND (? = '.' OR path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
         AND COALESCE(scan_generation, '') <> ?"
    } else if recursive {
        "SELECT id FROM indexed_files WHERE storage_pool_id = ? AND (? = '.' OR path = ? OR substr(path, 1, length(?) + 1) = ? || '/')"
    } else {
        "SELECT id FROM indexed_files WHERE storage_pool_id = ? AND path = ?"
    };
    let mut statement = transaction.prepare(sql).map_err(IndexerError::database)?;
    if let Some(generation) = generation_to_exclude {
        statement
            .query_map(
                params![storage_pool_id, path, path, path, path, generation],
                |row| row.get(0),
            )
            .map_err(IndexerError::database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(IndexerError::database)
    } else if recursive {
        statement
            .query_map(params![storage_pool_id, path, path, path, path], |row| {
                row.get(0)
            })
            .map_err(IndexerError::database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(IndexerError::database)
    } else {
        statement
            .query_map(params![storage_pool_id, path], |row| row.get(0))
            .map_err(IndexerError::database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(IndexerError::database)
    }
}

fn delete_ids(transaction: &Transaction<'_>, ids: &[String]) -> DbResult<()> {
    for id in ids {
        transaction
            .execute("DELETE FROM indexed_content_fts WHERE file_id = ?", [id])
            .map_err(IndexerError::database)?;
        transaction
            .execute("DELETE FROM indexed_files WHERE id = ?", [id])
            .map_err(IndexerError::database)?;
    }
    Ok(())
}

fn archive_previous_runs(transaction: &Transaction<'_>, storage_pool_id: &str) -> DbResult<()> {
    transaction.execute(
        "UPDATE index_runs SET status = 'failed', finished_at = ?, error = 'interrupted/superseded' WHERE storage_pool_id = ? AND status = 'running'",
        params![now_iso(), storage_pool_id],
    ).map_err(IndexerError::database)?;
    let mut statement = transaction.prepare(
        "SELECT id, status, started_at, finished_at, scanned, indexed, unchanged, removed, skipped, failed, error,
           duration_ms, bytes, file_count, text_file_count, phase, current_path, last_progress_at, kind
         FROM index_runs WHERE storage_pool_id = ? AND status <> 'running' ORDER BY COALESCE(finished_at, started_at) DESC"
    ).map_err(IndexerError::database)?;
    let rows = statement
        .query_map([storage_pool_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, i64>(12)?,
                row.get::<_, i64>(13)?,
                row.get::<_, i64>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<String>>(16)?,
                row.get::<_, Option<String>>(17)?,
                row.get::<_, String>(18)?,
            ))
        })
        .map_err(IndexerError::database)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(IndexerError::database)?;
    drop(statement);
    let newest_id = rows.first().map(|row| row.0.clone());
    let newest_full_id = rows
        .iter()
        .find(|row| row.18 == "full")
        .map(|row| row.0.clone());
    for row in rows {
        if newest_id.as_deref() == Some(row.0.as_str())
            || newest_full_id.as_deref() == Some(row.0.as_str())
        {
            continue;
        }
        let failures: Vec<(String, String)> = {
            let mut failures = transaction
                .prepare(
                    "SELECT path, reason FROM index_failures WHERE run_id = ? ORDER BY created_at",
                )
                .map_err(IndexerError::database)?;
            failures
                .query_map([&row.0], |item| Ok((item.get(0)?, item.get(1)?)))
                .map_err(IndexerError::database)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(IndexerError::database)?
        };
        transaction.execute(
            "INSERT OR REPLACE INTO index_run_history (id, storage_pool_id, status, started_at, finished_at, scanned, indexed,
               unchanged, removed, skipped, failed, error, duration_ms, bytes, file_count, text_file_count, phase,
               current_path, last_progress_at, failures_json, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![row.0, storage_pool_id, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9, row.10,
                row.11, row.12, row.13, row.14, row.15, row.16, row.17, serde_json::to_string(&failures).unwrap_or_else(|_| "[]".into()), row.18],
        ).map_err(IndexerError::database)?;
        transaction
            .execute("DELETE FROM index_runs WHERE id = ?", [&row.0])
            .map_err(IndexerError::database)?;
    }
    Ok(())
}

fn check(name: &str, value: u64, minimum: u64, maximum: u64) -> DbResult<()> {
    if value < minimum || value > maximum {
        return Err(IndexerError::new(
            ErrorCode::Database,
            format!("Invalid indexer setting {name}"),
            false,
        ));
    }
    Ok(())
}

fn i64_from(value: u64) -> DbResult<i64> {
    i64::try_from(value).map_err(IndexerError::database)
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC3339 time")
}

fn future_iso(duration: Duration) -> String {
    (OffsetDateTime::now_utc() + time::Duration::try_from(duration).unwrap_or(time::Duration::MAX))
        .format(&Rfc3339)
        .expect("RFC3339 time")
}

fn ago_iso(duration: Duration) -> String {
    (OffsetDateTime::now_utc() - time::Duration::try_from(duration).unwrap_or(time::Duration::MAX))
        .format(&Rfc3339)
        .expect("RFC3339 time")
}
