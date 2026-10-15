use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::{ErrorCode, PhotostaffError};
use crate::media::{MediaKind, ProcessedMedia};
use crate::storage::FileIdentity;

type DbResult<T> = Result<T, PhotostaffError>;
type DbJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

#[derive(Clone)]
pub struct Db {
    sender: mpsc::Sender<DbJob>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySettings {
    pub root_id: String,
    pub storage_pool_id: String,
    pub path: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProcessingSettings {
    pub processing_concurrency: usize,
    pub scan_interval_ms: u64,
    pub max_auto_retries: u32,
    pub retry_base_delay_ms: u64,
    pub retry_max_delay_ms: u64,
    pub command_timeout_ms: u64,
    pub max_file_size_bytes: u64,
    pub max_xmp_size_bytes: u64,
    pub max_intermediate_bytes: u64,
    pub min_free_space_bytes: u64,
    pub max_decoded_pixels: u64,
}

impl Default for ProcessingSettings {
    fn default() -> Self {
        Self {
            processing_concurrency: 1,
            scan_interval_ms: 1_800_000,
            max_auto_retries: 5,
            retry_base_delay_ms: 2_000,
            retry_max_delay_ms: 300_000,
            command_timeout_ms: 120_000,
            max_file_size_bytes: 512 * 1024 * 1024,
            max_xmp_size_bytes: 16 * 1024 * 1024,
            max_intermediate_bytes: 2 * 1024 * 1024 * 1024,
            min_free_space_bytes: 0,
            max_decoded_pixels: 268_402_689,
        }
    }
}

impl ProcessingSettings {
    fn validate(self) -> DbResult<Self> {
        check(
            "processingConcurrency",
            self.processing_concurrency as u64,
            1,
            4,
        )?;
        check("scanIntervalMs", self.scan_interval_ms, 60_000, 86_400_000)?;
        check("maxAutoRetries", u64::from(self.max_auto_retries), 0, 20)?;
        check("retryBaseDelayMs", self.retry_base_delay_ms, 500, 1_800_000)?;
        check(
            "retryMaxDelayMs",
            self.retry_max_delay_ms,
            self.retry_base_delay_ms,
            1_800_000,
        )?;
        check("commandTimeoutMs", self.command_timeout_ms, 5_000, 900_000)?;
        check(
            "maxFileSizeBytes",
            self.max_file_size_bytes,
            1024 * 1024,
            1024_u64.pow(4),
        )?;
        check(
            "maxXmpSizeBytes",
            self.max_xmp_size_bytes,
            1024,
            64 * 1024 * 1024,
        )?;
        check(
            "maxIntermediateBytes",
            self.max_intermediate_bytes,
            64 * 1024 * 1024,
            8 * 1024 * 1024 * 1024,
        )?;
        check(
            "minFreeSpaceBytes",
            self.min_free_space_bytes,
            0,
            1024_u64.pow(4),
        )?;
        check(
            "maxDecodedPixels",
            self.max_decoded_pixels,
            1_000_000,
            268_402_689,
        )?;
        Ok(self)
    }
}

#[derive(Debug, Clone)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub root_id: String,
    pub root_path: String,
    pub storage_pool_id: String,
    pub path: String,
    pub library_updated_at: String,
    pub scan_generation: String,
    pub retry_count: u32,
}

#[derive(Debug, Clone)]
pub struct ScanEntry {
    pub path: String,
    pub entry_type: String,
    pub retry_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishRecord {
    pub operation_id: String,
    pub job_id: String,
    pub asset_id: String,
    pub root_id: String,
    pub storage_pool_id: String,
    pub library_updated_at: String,
    pub scan_generation: String,
    pub path: String,
    pub name: String,
    pub source_identity: FileIdentity,
    pub sidecar_identity: Option<FileIdentity>,
    pub sidecar_path: Option<String>,
    pub processed: ProcessedMedia,
}

impl Db {
    pub fn open(path: &Path) -> DbResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(PhotostaffError::storage)?;
        }
        let connection = Connection::open(path).map_err(PhotostaffError::database)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(PhotostaffError::database)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(PhotostaffError::database)?;
        connection
            .pragma_update(None, "busy_timeout", 30_000)
            .map_err(PhotostaffError::database)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(PhotostaffError::database)?;
        let (sender, receiver) = mpsc::channel::<DbJob>();
        std::thread::Builder::new()
            .name("zos-photostaff-db".into())
            .spawn(move || {
                let mut connection = connection;
                while let Ok(job) = receiver.recv() {
                    job(&mut connection);
                }
            })
            .map_err(PhotostaffError::storage)?;
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
            .map_err(|_| PhotostaffError::database("Database thread stopped"))?;
        receiver
            .await
            .map_err(|_| PhotostaffError::database("Database response channel closed"))?
    }

    pub async fn wait_for_schema(&self, timeout: Duration) -> DbResult<()> {
        let started = tokio::time::Instant::now();
        loop {
            let ready = self
                .call(|connection| {
                    Ok(connection.query_row(
                    "SELECT 1 FROM schema_migrations WHERE id = '023_photostaff_reliability'",
                    [], |_| Ok(()),
                ).optional().unwrap_or(None).is_some())
                })
                .await
                .unwrap_or(false);
            if ready {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err(PhotostaffError::new(
                    ErrorCode::Database,
                    "Required migration 023_photostaff_reliability is not applied",
                    true,
                ));
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    pub async fn settings(&self) -> DbResult<(Option<LibrarySettings>, ProcessingSettings)> {
        self.call(|connection| {
            let library = setting_json(connection, "photostaff_library_settings")?
                .map(|value| {
                    serde_json::from_str::<LibrarySettings>(&value)
                        .map_err(PhotostaffError::database)
                })
                .transpose()?;
            let processing = setting_json(connection, "photostaff_processing_settings")?
                .map(|value| {
                    serde_json::from_str::<ProcessingSettings>(&value)
                        .map_err(PhotostaffError::database)
                })
                .transpose()?
                .unwrap_or_default()
                .validate()?;
            Ok((library, processing))
        })
        .await
    }

    pub async fn root_path(&self, root_id: &str) -> DbResult<String> {
        let root_id = root_id.to_owned();
        self.call(move |connection| {
            connection
                .query_row(
                    "SELECT path FROM nas_roots WHERE id = ?",
                    [root_id],
                    |row| row.get(0),
                )
                .map_err(PhotostaffError::database)
        })
        .await
    }

    pub async fn heartbeat(&self, worker_id: &str, version: &str) -> DbResult<()> {
        let worker_id = worker_id.to_owned();
        let version = version.to_owned();
        self.call(move |connection| {
            let now = now_iso();
            connection.execute(
                "INSERT INTO photostaff_workers (worker_id, version, started_at, heartbeat_at) VALUES (?, ?, ?, ?) ON CONFLICT(worker_id) DO UPDATE SET version = excluded.version, heartbeat_at = excluded.heartbeat_at",
                params![worker_id, version, now, now],
            ).map_err(PhotostaffError::database)?;
            Ok(())
        }).await
    }

    pub async fn ensure_periodic_job(
        &self,
        settings: &LibrarySettings,
        interval_ms: u64,
    ) -> DbResult<()> {
        let settings = settings.clone();
        self.call(move |connection| {
            let cutoff = iso_after(-(interval_ms as i128));
            let pending: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM photostaff_jobs WHERE library_updated_at = ? AND status IN ('queued','running','retrying'))",
                [&settings.updated_at], |row| row.get(0),
            ).map_err(PhotostaffError::database)?;
            if pending { return Ok(()); }
            let recent: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM photostaff_jobs WHERE library_updated_at = ? AND kind = 'full_scan' AND created_at > ?)",
                params![settings.updated_at, cutoff], |row| row.get(0),
            ).map_err(PhotostaffError::database)?;
            if recent { return Ok(()); }
            insert_job(connection, &settings, "full_scan", &settings.path)?;
            Ok(())
        }).await
    }

    pub async fn claim_job(&self, worker_id: &str) -> DbResult<Option<Job>> {
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotostaffError::database)?;
            let now = now_iso();
            transaction.execute(
                "UPDATE photostaff_jobs SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, phase = NULL, updated_at = ? WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
                params![now, now],
            ).map_err(PhotostaffError::database)?;
            let id: Option<String> = transaction.query_row(
                "SELECT id FROM photostaff_jobs WHERE status = 'queued' OR (status = 'retrying' AND next_retry_at <= ?) ORDER BY created_at LIMIT 1",
                [&now], |row| row.get(0),
            ).optional().map_err(PhotostaffError::database)?;
            let Some(id) = id else { transaction.commit().map_err(PhotostaffError::database)?; return Ok(None); };
            transaction.execute(
                "UPDATE photostaff_jobs SET status = 'running', worker_id = ?, lease_expires_at = ?, phase = COALESCE(phase, 'discovering'), error = NULL, error_code = NULL, error_retryable = 0, next_retry_at = NULL, started_at = COALESCE(started_at, ?), finished_at = NULL, updated_at = ? WHERE id = ?",
                params![worker_id, iso_after(30_000), now, now, id],
            ).map_err(PhotostaffError::database)?;
            transaction.execute("DELETE FROM photostaff_space_reservations WHERE job_id = ?", [&id]).map_err(PhotostaffError::database)?;
            transaction.execute("UPDATE photostaff_scan_entries SET status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'processing'", params![now, id]).map_err(PhotostaffError::database)?;
            let job = transaction.query_row(
                "SELECT j.id, j.kind, j.root_id, r.path, j.storage_pool_id, j.path, j.library_updated_at, j.scan_generation, j.retry_count FROM photostaff_jobs j JOIN nas_roots r ON r.id = j.root_id WHERE j.id = ?",
                [&id], map_job,
            ).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)?;
            Ok(Some(job))
        }).await
    }

    pub async fn renew_lease(&self, job_id: &str, worker_id: &str) -> DbResult<bool> {
        let job_id = job_id.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            Ok(connection.execute(
                "UPDATE photostaff_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND worker_id = ?",
                params![iso_after(30_000), now_iso(), job_id, worker_id],
            ).map_err(PhotostaffError::database)? == 1)
        }).await
    }

    pub async fn initialize_scan(&self, job: &Job, worker_id: &str) -> DbResult<()> {
        let job = job.clone();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &job.id, &worker_id)?;
            transaction.execute(
                "INSERT INTO photostaff_scan_entries (job_id, path, entry_type, status, parent_path, updated_at) VALUES (?, ?, 'directory', 'pending', NULL, ?) ON CONFLICT(job_id,path) DO NOTHING",
                params![job.id, job.path, now_iso()],
            ).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)
        }).await
    }

    pub async fn claim_entry(
        &self,
        job_id: &str,
        entry_type: &str,
        worker_id: &str,
    ) -> DbResult<Option<ScanEntry>> {
        let job_id = job_id.to_owned();
        let entry_type = entry_type.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &job_id, &worker_id)?;
            let now = now_iso();
            let entry = transaction.query_row(
                "SELECT path, entry_type, retry_count FROM photostaff_scan_entries WHERE job_id = ? AND entry_type = ? AND (status = 'pending' OR (status = 'failed' AND error_retryable = 1 AND next_retry_at <= ?)) ORDER BY path LIMIT 1",
                params![job_id, entry_type, now],
                |row| Ok(ScanEntry { path: row.get(0)?, entry_type: row.get(1)?, retry_count: row.get(2)? }),
            ).optional().map_err(PhotostaffError::database)?;
            if let Some(entry) = &entry {
                transaction.execute("UPDATE photostaff_scan_entries SET status = 'processing', updated_at = ? WHERE job_id = ? AND path = ?", params![now, job_id, entry.path]).map_err(PhotostaffError::database)?;
            }
            transaction.commit().map_err(PhotostaffError::database)?;
            Ok(entry)
        }).await
    }

    pub async fn add_scan_entry(
        &self,
        job_id: &str,
        path: &str,
        entry_type: &str,
        parent_path: &str,
        worker_id: &str,
    ) -> DbResult<()> {
        let values = (
            job_id.to_owned(),
            path.to_owned(),
            entry_type.to_owned(),
            parent_path.to_owned(),
        );
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &values.0, &worker_id)?;
            transaction.execute(
                "INSERT INTO photostaff_scan_entries (job_id,path,entry_type,status,parent_path,updated_at) VALUES (?,?,?,CASE WHEN ? = 'sidecar' THEN 'completed' ELSE 'pending' END,?,?) ON CONFLICT(job_id,path) DO NOTHING",
                params![values.0, values.1, values.2, values.2, values.3, now_iso()],
            ).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)
        }).await
    }

    pub async fn complete_entry(
        &self,
        job_id: &str,
        path: &str,
        processed: bool,
        worker_id: &str,
    ) -> DbResult<()> {
        let job_id = job_id.to_owned();
        let path = path.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &job_id, &worker_id)?;
            transaction.execute("UPDATE photostaff_scan_entries SET status = 'completed', error = NULL, error_code = NULL, error_retryable = 0, next_retry_at = NULL, updated_at = ? WHERE job_id = ? AND path = ?", params![now_iso(), job_id, path]).map_err(PhotostaffError::database)?;
            transaction.execute(if processed {
                "UPDATE photostaff_jobs SET scanned = scanned + 1, processed = processed + 1, current_path = ?, phase = 'processing', updated_at = ? WHERE id = ?"
            } else {
                "UPDATE photostaff_jobs SET scanned = scanned + 1, current_path = ?, phase = 'discovering', updated_at = ? WHERE id = ?"
            }, params![path, now_iso(), job_id]).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)?;
            Ok(())
        }).await
    }

    pub async fn set_phase(
        &self,
        job_id: &str,
        worker_id: &str,
        phase: &str,
        current_path: Option<&str>,
    ) -> DbResult<bool> {
        let job_id = job_id.to_owned();
        let worker_id = worker_id.to_owned();
        let phase = phase.to_owned();
        let current_path = current_path.map(str::to_owned);
        self.call(move |connection| Ok(connection.execute("UPDATE photostaff_jobs SET phase = ?, current_path = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'running'", params![phase,current_path,now_iso(),job_id,worker_id]).map_err(PhotostaffError::database)? == 1)).await
    }

    pub async fn sidecar_for(
        &self,
        job_id: &str,
        media_path: &str,
    ) -> DbResult<Result<Option<String>, String>> {
        let job_id = job_id.to_owned();
        let media_path = media_path.to_owned();
        self.call(move |connection| {
            let path = Path::new(&media_path);
            let parent = path.parent().unwrap_or_else(|| Path::new(""));
            let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
            let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("");
            let exact = parent.join(format!("{name}.xmp")).to_string_lossy().into_owned();
            let generic = parent.join(format!("{stem}.xmp")).to_string_lossy().into_owned();
            let mut statement = connection.prepare("SELECT path FROM photostaff_scan_entries WHERE job_id = ? AND entry_type = 'sidecar' AND (lower(path) = lower(?) OR lower(path) = lower(?)) ORDER BY path").map_err(PhotostaffError::database)?;
            let candidates: Vec<String> = statement.query_map(params![job_id, exact, generic], |row| row.get(0)).map_err(PhotostaffError::database)?.collect::<Result<_,_>>().map_err(PhotostaffError::database)?;
            let exact_matches: Vec<_> = candidates.iter().filter(|candidate| candidate.to_lowercase() == exact.to_lowercase()).cloned().collect();
            if exact_matches.len() == 1 { return Ok(Ok(Some(exact_matches[0].clone()))); }
            if exact_matches.len() > 1 { return Ok(Err("Ambiguous XMP sidecar name".into())); }
            let generic_matches: Vec<_> = candidates.iter().filter(|candidate| candidate.to_lowercase() == generic.to_lowercase()).cloned().collect();
            if generic_matches.is_empty() { return Ok(Ok(None)); }
            if generic_matches.len() > 1 { return Ok(Err("Ambiguous XMP sidecar name".into())); }
            let sibling_prefix = if parent.as_os_str().is_empty() { String::new() } else { format!("{}/", parent.to_string_lossy()) };
            let sibling_like = format!("{}%", sibling_prefix.replace('%', "\\%").replace('_', "\\_"));
            let mut sibling_statement = connection.prepare("SELECT path FROM photostaff_scan_entries WHERE job_id = ? AND entry_type = 'media' AND path LIKE ? ESCAPE '\\'").map_err(PhotostaffError::database)?;
            let siblings: Vec<String> = sibling_statement.query_map(params![job_id,sibling_like], |row| row.get(0)).map_err(PhotostaffError::database)?.collect::<Result<_,_>>().map_err(PhotostaffError::database)?;
            let same_stem: Vec<_> = siblings.iter().filter(|candidate| same_directory_stem(candidate, parent, stem)).collect();
            let raw_matches = same_stem.iter().filter(|candidate| crate::media::candidate_kind(candidate) == Some(MediaKind::Raw)).count();
            if same_stem.len() == 1 || (crate::media::candidate_kind(&media_path) == Some(MediaKind::Raw) && raw_matches == 1) {
                Ok(Ok(Some(generic_matches[0].clone())))
            } else {
                Ok(Err("Ambiguous XMP sidecar was not attached".into()))
            }
        }).await
    }

    pub async fn skip_entry(&self, job_id: &str, path: &str, worker_id: &str) -> DbResult<()> {
        let job_id = job_id.to_owned();
        let path = path.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &job_id, &worker_id)?;
            transaction.execute("UPDATE photostaff_scan_entries SET status = 'skipped', updated_at = ? WHERE job_id = ? AND path = ?", params![now_iso(), job_id, path]).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)
        }).await
    }

    pub async fn fail_entry(
        &self,
        job: &Job,
        entry: &ScanEntry,
        error: &PhotostaffError,
        retry_delay: Option<Duration>,
        worker_id: &str,
    ) -> DbResult<()> {
        let job = job.clone();
        let entry = entry.clone();
        let code = error.code.as_str().to_owned();
        let message = error.message.clone();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &job.id, &worker_id)?;
            let retry = retry_delay.is_some();
            let next = retry_delay.map(|delay| iso_after(delay.as_millis() as i128));
            transaction.execute(
                "UPDATE photostaff_scan_entries SET status = 'failed', error = ?, error_code = ?, error_retryable = ?, retry_count = retry_count + 1, next_retry_at = ?, updated_at = ? WHERE job_id = ? AND path = ?",
                params![message, code, i64::from(retry), next, now_iso(), job.id, entry.path],
            ).map_err(PhotostaffError::database)?;
            transaction.execute("UPDATE photostaff_jobs SET failed = failed + 1, current_path = ?, error = ?, error_code = ?, error_retryable = ?, updated_at = ? WHERE id = ?", params![entry.path, message, code, i64::from(retry), now_iso(), job.id]).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)?;
            Ok(())
        }).await
    }

    pub async fn asset_id(&self, job: &Job, path: &str) -> DbResult<String> {
        let root_id = job.root_id.clone();
        let pool = job.storage_pool_id.clone();
        let path = path.to_owned();
        self.call(move |connection| {
            Ok(connection.query_row("SELECT id FROM photostaff_assets WHERE root_id = ? AND storage_pool_id = ? AND path = ?", params![root_id, pool, path], |row| row.get(0)).optional().map_err(PhotostaffError::database)?.unwrap_or_else(|| Uuid::new_v4().to_string()))
        }).await
    }

    pub async fn mark_current_if_unchanged(
        &self,
        job: &Job,
        path: &str,
        source: FileIdentity,
        sidecar: Option<(&str, FileIdentity)>,
        worker_id: &str,
    ) -> DbResult<bool> {
        let job = job.clone();
        let path = path.to_owned();
        let sidecar_path = sidecar.map(|value| value.0.to_owned());
        let sidecar_identity = sidecar.map(|value| value.1);
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &job.id, &worker_id)?;
            let matched: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM photostaff_assets a JOIN photostaff_asset_metadata m ON m.asset_id = a.id WHERE a.root_id = ? AND a.storage_pool_id = ? AND a.path = ? AND a.status = 'ready' AND a.source_device = ? AND a.source_inode = ? AND a.source_size_bytes = ? AND a.source_mtime_ns = ? AND a.source_ctime_ns = ? AND a.derivative_schema_version = 1 AND m.schema_version = 2 AND a.sidecar_path IS ? AND a.sidecar_device IS ? AND a.sidecar_inode IS ? AND a.sidecar_size_bytes IS ? AND a.sidecar_mtime_ns IS ? AND a.sidecar_ctime_ns IS ?)",
                params![job.root_id, job.storage_pool_id, path, source.device as i64, source.inode as i64, source.size as i64, source.mtime_ns, source.ctime_ns, sidecar_path, sidecar_identity.map(|v| v.device as i64), sidecar_identity.map(|v| v.inode as i64), sidecar_identity.map(|v| v.size as i64), sidecar_identity.map(|v| v.mtime_ns), sidecar_identity.map(|v| v.ctime_ns)],
                |row| row.get(0),
            ).map_err(PhotostaffError::database)?;
            if matched {
                transaction.execute("UPDATE photostaff_assets SET scan_generation = ?, indexed_at = ? WHERE root_id = ? AND storage_pool_id = ? AND path = ?", params![job.scan_generation, now_iso(), job.root_id, job.storage_pool_id, path]).map_err(PhotostaffError::database)?;
            }
            transaction.commit().map_err(PhotostaffError::database)?;
            Ok(matched)
        }).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn reserve_space(
        &self,
        job: &Job,
        path: &str,
        reservation_scope: &str,
        bytes: u64,
        available: u64,
        minimum_free: u64,
        worker_id: &str,
    ) -> DbResult<String> {
        let id = Uuid::new_v4().to_string();
        let result = id.clone();
        let job = job.clone();
        let path = path.to_owned();
        let reservation_scope = reservation_scope.to_owned();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &job.id, &worker_id)?;
            let reserved: i64 = transaction.query_row("SELECT COALESCE(SUM(reserved_bytes),0) FROM photostaff_space_reservations WHERE storage_pool_id = ?", [&reservation_scope], |row| row.get(0)).map_err(PhotostaffError::database)?;
            let reserved = reserved.max(0) as u64;
            if available.saturating_sub(reserved).saturating_sub(minimum_free) < bytes {
                return Err(PhotostaffError::new(ErrorCode::DiskSpace, "Insufficient space for Photostaff processing", false));
            }
            transaction.execute("INSERT INTO photostaff_space_reservations (id,job_id,storage_pool_id,path,reserved_bytes,updated_at) VALUES (?,?,?,?,?,?)", params![id, job.id, reservation_scope, path, bytes as i64, now_iso()]).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)
        }).await?;
        Ok(result)
    }

    pub async fn release_space(&self, id: &str) -> DbResult<()> {
        let id = id.to_owned();
        self.call(move |connection| {
            connection
                .execute(
                    "DELETE FROM photostaff_space_reservations WHERE id = ?",
                    [id],
                )
                .map_err(PhotostaffError::database)?;
            Ok(())
        })
        .await
    }

    pub async fn reserved_space(&self, storage_pool_id: &str) -> DbResult<u64> {
        let storage_pool_id = storage_pool_id.to_owned();
        self.call(move |connection| {
            let value: i64 = connection.query_row("SELECT COALESCE(SUM(reserved_bytes),0) FROM photostaff_space_reservations WHERE storage_pool_id = ?", [storage_pool_id], |row| row.get(0)).map_err(PhotostaffError::database)?;
            Ok(value.max(0) as u64)
        }).await
    }

    pub async fn derivative_cleanup_state(
        &self,
    ) -> DbResult<(HashSet<String>, Vec<PublishRecord>)> {
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(PhotostaffError::database)?;
            let mut statement = transaction
                .prepare("SELECT thumbnail_key, preview_key FROM photostaff_assets WHERE status = 'ready'")
                .map_err(PhotostaffError::database)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?))
                })
                .map_err(PhotostaffError::database)?;
            let mut keys = HashSet::new();
            for row in rows {
                let (thumbnail, preview) = row.map_err(PhotostaffError::database)?;
                keys.extend(thumbnail);
                keys.extend(preview);
            }
            drop(statement);
            let mut journal_statement = transaction
                .prepare("SELECT result_json FROM photostaff_publish_journal")
                .map_err(PhotostaffError::database)?;
            let journal_rows = journal_statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(PhotostaffError::database)?;
            let mut journals = Vec::new();
            for row in journal_rows {
                journals.push(
                    serde_json::from_str(&row.map_err(PhotostaffError::database)?)
                        .map_err(PhotostaffError::database)?,
                );
            }
            drop(journal_statement);
            transaction.commit().map_err(PhotostaffError::database)?;
            Ok((keys, journals))
        })
        .await
    }

    pub async fn record_failed_asset(
        &self,
        job: &Job,
        path: &str,
        name: &str,
        identity: FileIdentity,
        error: &PhotostaffError,
        worker_id: &str,
    ) -> DbResult<()> {
        let job = job.clone();
        let path = path.to_owned();
        let name = name.to_owned();
        let message = error.message.clone();
        let code = error.code.as_str().to_owned();
        let retryable = error.retryable;
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection
                .transaction()
                .map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &job.id, &worker_id)?;
            record_failed_asset_connection(
                &transaction,
                &job,
                &path,
                &name,
                identity,
                &message,
                &code,
                retryable,
            )?;
            transaction.commit().map_err(PhotostaffError::database)
        })
        .await
    }

    pub async fn begin_publish(&self, record: &PublishRecord, worker_id: &str) -> DbResult<()> {
        let record = record.clone();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &record.job_id, &worker_id)?;
            let existing: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM photostaff_publish_journal WHERE job_id = ? AND source_path = ?)",
                params![record.job_id, record.path],
                |row| row.get(0),
            ).map_err(PhotostaffError::database)?;
            if existing {
                return Err(PhotostaffError::new(ErrorCode::Database, "A Photostaff publication is already in progress for this media", true));
            }
            let result = serde_json::to_string(&record).map_err(PhotostaffError::database)?;
            transaction.execute(
                "INSERT INTO photostaff_publish_journal (operation_id,job_id,asset_id,source_path,thumbnail_temp_path,thumbnail_path,preview_temp_path,preview_path,source_device,source_inode,source_size_bytes,result_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET result_json = excluded.result_json",
                params![record.operation_id, record.job_id, record.asset_id, record.path, record.processed.thumbnail_temp_path.to_string_lossy(), record.processed.thumbnail_path.to_string_lossy(), record.processed.preview_temp_path.to_string_lossy(), record.processed.preview_path.to_string_lossy(), record.source_identity.device as i64, record.source_identity.inode as i64, record.source_identity.size as i64, result, now_iso()],
            ).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)?;
            Ok(())
        }).await
    }

    pub async fn journals(&self) -> DbResult<Vec<PublishRecord>> {
        self.call(|connection| {
            let mut statement = connection
                .prepare("SELECT result_json FROM photostaff_publish_journal ORDER BY created_at")
                .map_err(PhotostaffError::database)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(PhotostaffError::database)?;
            let mut result = Vec::new();
            for row in rows {
                let json = row.map_err(PhotostaffError::database)?;
                result.push(serde_json::from_str(&json).map_err(PhotostaffError::database)?);
            }
            Ok(result)
        })
        .await
    }

    pub async fn recoverable_journals(&self) -> DbResult<Vec<PublishRecord>> {
        self.call(|connection| {
            let now = now_iso();
            let mut statement = connection
                .prepare("SELECT p.result_json FROM photostaff_publish_journal p JOIN photostaff_jobs j ON j.id = p.job_id WHERE j.status <> 'running' OR j.lease_expires_at IS NULL OR j.lease_expires_at <= ? ORDER BY p.created_at")
                .map_err(PhotostaffError::database)?;
            let rows = statement
                .query_map([now], |row| row.get::<_, String>(0))
                .map_err(PhotostaffError::database)?;
            let mut result = Vec::new();
            for row in rows {
                let json = row.map_err(PhotostaffError::database)?;
                result.push(serde_json::from_str(&json).map_err(PhotostaffError::database)?);
            }
            Ok(result)
        })
        .await
    }

    pub async fn abort_journal(&self, operation_id: &str, requeue: bool) -> DbResult<()> {
        self.abort_journal_for_worker(operation_id, requeue, None)
            .await
    }

    pub async fn abort_journal_owned(
        &self,
        operation_id: &str,
        requeue: bool,
        worker_id: &str,
    ) -> DbResult<()> {
        self.abort_journal_for_worker(operation_id, requeue, Some(worker_id))
            .await
    }

    async fn abort_journal_for_worker(
        &self,
        operation_id: &str,
        requeue: bool,
        worker_id: Option<&str>,
    ) -> DbResult<()> {
        let operation_id = operation_id.to_owned();
        let worker_id = worker_id.map(str::to_owned);
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(PhotostaffError::database)?;
            let job_id: Option<String> = transaction.query_row(
                    "SELECT job_id FROM photostaff_publish_journal WHERE operation_id = ?",
                    [&operation_id],
                    |row| row.get(0),
                ).optional().map_err(PhotostaffError::database)?;
            let Some(job_id) = job_id else {
                transaction.commit().map_err(PhotostaffError::database)?;
                return Ok(());
            };
            if let Some(worker_id) = worker_id {
                ensure_job_owned(&transaction, &job_id, &worker_id)?;
            } else if !job_recoverable(&transaction, &job_id)? {
                transaction.commit().map_err(PhotostaffError::database)?;
                return Ok(());
            }
            if requeue {
                transaction.execute("UPDATE photostaff_scan_entries SET status = 'pending', updated_at = ? WHERE (job_id,path) = (SELECT job_id,source_path FROM photostaff_publish_journal WHERE operation_id = ?)", params![now_iso(), operation_id]).map_err(PhotostaffError::database)?;
            }
            transaction.execute("DELETE FROM photostaff_publish_journal WHERE operation_id = ?", [&operation_id]).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)?;
            Ok(())
        }).await
    }

    pub async fn complete_publish(&self, record: &PublishRecord) -> DbResult<bool> {
        let record = record.clone();
        self.call(move |connection| complete_publish_transaction(connection, &record, None))
            .await
    }

    pub async fn complete_publish_owned(
        &self,
        record: &PublishRecord,
        worker_id: &str,
    ) -> DbResult<()> {
        let record = record.clone();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            complete_publish_transaction(connection, &record, Some(&worker_id)).map(|_| ())
        })
        .await
    }

    pub async fn finish_job(&self, job: &Job, worker_id: &str) -> DbResult<()> {
        let job = job.clone();
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(PhotostaffError::database)?;
            ensure_job_owned(&transaction, &job.id, &worker_id)?;
            let incomplete: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM photostaff_scan_entries WHERE job_id = ? AND status IN ('pending','processing'))",
                [&job.id],
                |row| row.get(0),
            ).map_err(PhotostaffError::database)?;
            if incomplete {
                return Err(PhotostaffError::new(ErrorCode::Database, "Photostaff job still has incomplete scan entries", true));
            }
            if job.kind == "full_scan" {
                transaction.execute("DELETE FROM photostaff_assets WHERE library_updated_at = ? AND scan_generation IS NOT ?", params![job.library_updated_at, job.scan_generation]).map_err(PhotostaffError::database)?;
            }
            let updated = transaction.execute("UPDATE photostaff_jobs SET status = 'completed', phase = NULL, current_path = NULL, worker_id = NULL, lease_expires_at = NULL, error = NULL, error_code = NULL, error_retryable = 0, next_retry_at = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'running'", params![now_iso(), now_iso(), job.id, worker_id]).map_err(PhotostaffError::database)?;
            if updated != 1 {
                return Err(PhotostaffError::new(ErrorCode::Database, "Photostaff job lease was lost before completion", true));
            }
            transaction.execute("DELETE FROM photostaff_space_reservations WHERE job_id = ?", [&job.id]).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)?;
            Ok(())
        }).await
    }

    pub async fn retry_or_fail_job(
        &self,
        job: &Job,
        worker_id: &str,
        error: &PhotostaffError,
        delay: Option<Duration>,
    ) -> DbResult<()> {
        let job = job.clone();
        let worker_id = worker_id.to_owned();
        let message = error.message.clone();
        let code = error.code.as_str().to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(PhotostaffError::database)?;
            let retry = delay.is_some(); let status = if retry { "retrying" } else { "failed" }; let next = delay.map(|delay| iso_after(delay.as_millis() as i128));
            let updated = transaction.execute("UPDATE photostaff_jobs SET status = ?, phase = CASE WHEN ? THEN 'retry_wait' ELSE NULL END, error = ?, error_code = ?, error_retryable = ?, retry_count = retry_count + 1, next_retry_at = ?, worker_id = NULL, lease_expires_at = NULL, finished_at = CASE WHEN ? THEN NULL ELSE ? END, updated_at = ? WHERE id = ? AND worker_id = ?", params![status, retry, message, code, retry, next, retry, now_iso(), now_iso(), job.id, worker_id]).map_err(PhotostaffError::database)?;
            if updated == 1 {
                transaction.execute("DELETE FROM photostaff_space_reservations WHERE job_id = ?", [&job.id]).map_err(PhotostaffError::database)?;
            }
            transaction.commit().map_err(PhotostaffError::database)
        }).await
    }

    pub async fn release_worker(&self, worker_id: &str) -> DbResult<()> {
        let worker_id = worker_id.to_owned();
        self.call(move |connection| {
            let transaction = connection.transaction().map_err(PhotostaffError::database)?;
            transaction.execute("DELETE FROM photostaff_space_reservations WHERE job_id IN (SELECT id FROM photostaff_jobs WHERE worker_id = ?)", [&worker_id]).map_err(PhotostaffError::database)?;
            transaction.execute("UPDATE photostaff_scan_entries SET status = 'pending', updated_at = ? WHERE status = 'processing' AND job_id IN (SELECT id FROM photostaff_jobs WHERE worker_id = ?)", params![now_iso(), worker_id]).map_err(PhotostaffError::database)?;
            transaction.execute("UPDATE photostaff_jobs SET status = 'queued', phase = NULL, worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'running' AND worker_id = ?", params![now_iso(), worker_id]).map_err(PhotostaffError::database)?;
            transaction.execute("DELETE FROM photostaff_workers WHERE worker_id = ?", [&worker_id]).map_err(PhotostaffError::database)?;
            transaction.commit().map_err(PhotostaffError::database)?;
            Ok(())
        }).await
    }
}

#[allow(clippy::too_many_arguments)]
fn record_failed_asset_connection(
    connection: &Connection,
    job: &Job,
    path: &str,
    name: &str,
    identity: FileIdentity,
    message: &str,
    code: &str,
    retryable: bool,
) -> DbResult<()> {
    let id: String = connection
        .query_row(
            "SELECT id FROM photostaff_assets WHERE root_id=? AND storage_pool_id=? AND path=?",
            params![job.root_id, job.storage_pool_id, path],
            |row| row.get(0),
        )
        .optional()
        .map_err(PhotostaffError::database)?
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    connection.execute("INSERT INTO photostaff_assets (id,root_id,storage_pool_id,path,name,mime_type,size_bytes,mtime_ms,taken_at,taken_at_source,status,error,error_code,error_retryable,source_device,source_inode,source_size_bytes,source_mtime_ns,source_ctime_ns,derivative_schema_version,scan_generation,library_updated_at,indexed_at) VALUES (?,?,?,?,?,'application/octet-stream',?,?,?,?, 'failed',?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(root_id,storage_pool_id,path) DO UPDATE SET name=excluded.name,size_bytes=excluded.size_bytes,mtime_ms=excluded.mtime_ms,status='failed',error=excluded.error,error_code=excluded.error_code,error_retryable=excluded.error_retryable,source_device=excluded.source_device,source_inode=excluded.source_inode,source_size_bytes=excluded.source_size_bytes,source_mtime_ns=excluded.source_mtime_ns,source_ctime_ns=excluded.source_ctime_ns,scan_generation=excluded.scan_generation,library_updated_at=excluded.library_updated_at,indexed_at=excluded.indexed_at", params![id,job.root_id,job.storage_pool_id,path,name,identity.size as i64,identity.mtime_ns/1_000_000,iso_from_ns(identity.mtime_ns),"file_mtime",message,code,i64::from(retryable),identity.device as i64,identity.inode as i64,identity.size as i64,identity.mtime_ns,identity.ctime_ns,job.scan_generation,job.library_updated_at,now_iso()]).map_err(PhotostaffError::database)?;
    Ok(())
}

fn complete_publish_transaction(
    connection: &mut Connection,
    record: &PublishRecord,
    worker_id: Option<&str>,
) -> DbResult<bool> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(PhotostaffError::database)?;
    let journal_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM photostaff_publish_journal WHERE operation_id = ?)",
            [&record.operation_id],
            |row| row.get(0),
        )
        .map_err(PhotostaffError::database)?;
    if !journal_exists {
        transaction.commit().map_err(PhotostaffError::database)?;
        return Ok(false);
    }
    if let Some(worker_id) = worker_id {
        ensure_job_owned(&transaction, &record.job_id, worker_id)?;
    } else if !job_recoverable(&transaction, &record.job_id)? {
        return Err(PhotostaffError::new(
            ErrorCode::Database,
            "Photostaff journal recovery lost its job fence",
            true,
        ));
    }
    let metadata = &record.processed.metadata;
    transaction.execute(
        "INSERT INTO photostaff_assets (id,root_id,storage_pool_id,path,name,mime_type,size_bytes,mtime_ms,content_hash,width,height,orientation,taken_at,taken_at_source,thumbnail_key,preview_key,status,error,error_code,error_retryable,source_device,source_inode,source_size_bytes,source_mtime_ns,source_ctime_ns,sidecar_path,sidecar_device,sidecar_inode,sidecar_size_bytes,sidecar_mtime_ns,sidecar_ctime_ns,derivative_schema_version,scan_generation,library_updated_at,indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ready',NULL,NULL,0,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(root_id,storage_pool_id,path) DO UPDATE SET name=excluded.name,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,mtime_ms=excluded.mtime_ms,content_hash=excluded.content_hash,width=excluded.width,height=excluded.height,orientation=excluded.orientation,taken_at=excluded.taken_at,taken_at_source=excluded.taken_at_source,thumbnail_key=excluded.thumbnail_key,preview_key=excluded.preview_key,status='ready',error=NULL,error_code=NULL,error_retryable=0,source_device=excluded.source_device,source_inode=excluded.source_inode,source_size_bytes=excluded.source_size_bytes,source_mtime_ns=excluded.source_mtime_ns,source_ctime_ns=excluded.source_ctime_ns,sidecar_path=excluded.sidecar_path,sidecar_device=excluded.sidecar_device,sidecar_inode=excluded.sidecar_inode,sidecar_size_bytes=excluded.sidecar_size_bytes,sidecar_mtime_ns=excluded.sidecar_mtime_ns,sidecar_ctime_ns=excluded.sidecar_ctime_ns,derivative_schema_version=1,scan_generation=excluded.scan_generation,library_updated_at=excluded.library_updated_at,indexed_at=excluded.indexed_at",
        params![record.asset_id,record.root_id,record.storage_pool_id,record.path,record.name,record.processed.mime_type,record.source_identity.size as i64,record.source_identity.mtime_ns/1_000_000,record.processed.content_hash,record.processed.width,record.processed.height,record.processed.orientation,record.processed.taken_at,record.processed.taken_at_source,record.processed.thumbnail_key,record.processed.preview_key,record.source_identity.device as i64,record.source_identity.inode as i64,record.source_identity.size as i64,record.source_identity.mtime_ns,record.source_identity.ctime_ns,record.sidecar_path,record.sidecar_identity.map(|v|v.device as i64),record.sidecar_identity.map(|v|v.inode as i64),record.sidecar_identity.map(|v|v.size as i64),record.sidecar_identity.map(|v|v.mtime_ns),record.sidecar_identity.map(|v|v.ctime_ns),record.scan_generation,record.library_updated_at,now_iso()],
    ).map_err(PhotostaffError::database)?;
    let asset_id: String = transaction
        .query_row(
            "SELECT id FROM photostaff_assets WHERE root_id=? AND storage_pool_id=? AND path=?",
            params![record.root_id, record.storage_pool_id, record.path],
            |row| row.get(0),
        )
        .map_err(PhotostaffError::database)?;
    transaction
        .execute(
            "DELETE FROM photostaff_asset_metadata WHERE asset_id = ?",
            [&asset_id],
        )
        .map_err(PhotostaffError::database)?;
    transaction.execute(
        "INSERT INTO photostaff_asset_metadata (asset_id,schema_version,status,media_kind,captured_at,captured_at_local,capture_offset_minutes,capture_source,duration_ms,container,video_codec,audio_codec,camera_make,camera_model,software,body_serial,lens_make,lens_model,lens_serial,iso,exposure_time_seconds,aperture,focal_length_mm,focal_length_35_mm,exposure_bias_ev,exposure_program,metering_mode,flash,white_balance,title,description,creator,copyright,rating,gps_latitude,gps_longitude,gps_altitude_m,gps_direction_deg,raw_metadata_json,warnings_json,sidecar_path,sidecar_size_bytes,sidecar_mtime_ms,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![asset_id,metadata.schema_version,metadata.status,media_kind(metadata.media_kind),metadata.captured_at,metadata.captured_at_local,metadata.capture_offset_minutes,metadata.capture_source,metadata.duration_ms.map(|value| value as i64),metadata.container,metadata.video_codec,metadata.audio_codec,metadata.camera_make,metadata.camera_model,metadata.software,metadata.body_serial,metadata.lens_make,metadata.lens_model,metadata.lens_serial,metadata.iso,metadata.exposure_time_seconds,metadata.aperture,metadata.focal_length_mm,metadata.focal_length_35_mm,metadata.exposure_bias_ev,metadata.exposure_program,metadata.metering_mode,metadata.flash,metadata.white_balance,metadata.title,metadata.description,metadata.creator,metadata.copyright,metadata.rating,metadata.gps_latitude,metadata.gps_longitude,metadata.gps_altitude_m,metadata.gps_direction_deg,serde_json::to_string(&metadata.raw_metadata).map_err(PhotostaffError::database)?,serde_json::to_string(&metadata.warnings).map_err(PhotostaffError::database)?,metadata.sidecar_path,metadata.sidecar_size_bytes.map(|value| value as i64),metadata.sidecar_mtime_ms,now_iso()],
    ).map_err(PhotostaffError::database)?;
    transaction
        .execute(
            "DELETE FROM photostaff_keywords WHERE asset_id = ?",
            [&asset_id],
        )
        .map_err(PhotostaffError::database)?;
    for keyword in &metadata.keywords {
        transaction.execute("INSERT OR IGNORE INTO photostaff_keywords (asset_id,keyword,normalized_keyword) VALUES (?,?,?)", params![asset_id,keyword,keyword.to_lowercase()]).map_err(PhotostaffError::database)?;
    }
    transaction
        .execute(
            "DELETE FROM photostaff_metadata_values WHERE asset_id = ?",
            [&asset_id],
        )
        .map_err(PhotostaffError::database)?;
    for value in &metadata.values {
        transaction.execute("INSERT INTO photostaff_metadata_values (asset_id,source,key,value_type,text_value,normalized_text_value,number_value,date_value,boolean_value,sensitive,ordinal) VALUES (?,?,?,?,?,?,?,?,?,?,?)", params![asset_id,value.source,value.key,value.value_type,value.text_value,value.text_value.as_ref().map(|v|v.to_lowercase()),value.number_value,value.date_value,value.boolean_value.map(i64::from),i64::from(value.sensitive),value.ordinal as i64]).map_err(PhotostaffError::database)?;
    }
    transaction
        .execute(
            "DELETE FROM photostaff_metadata_fts WHERE asset_id = ?",
            [&asset_id],
        )
        .map_err(PhotostaffError::database)?;
    transaction.execute("INSERT INTO photostaff_metadata_fts (asset_id,name,path,title,description,creator,copyright,keywords,camera,lens) VALUES (?,?,?,?,?,?,?,?,?,?)", params![asset_id,record.name,record.path,metadata.title,metadata.description,metadata.creator,metadata.copyright,metadata.keywords.join(" "),metadata.camera_model,metadata.lens_model]).map_err(PhotostaffError::database)?;
    let rowid: i64 = transaction
        .query_row(
            "SELECT rowid FROM photostaff_asset_metadata WHERE asset_id = ?",
            [&asset_id],
            |row| row.get(0),
        )
        .map_err(PhotostaffError::database)?;
    transaction
        .execute(
            "DELETE FROM photostaff_geo_index WHERE metadata_rowid = ?",
            [rowid],
        )
        .map_err(PhotostaffError::database)?;
    if let (Some(latitude), Some(longitude)) = (metadata.gps_latitude, metadata.gps_longitude) {
        transaction
            .execute(
                "INSERT INTO photostaff_geo_index VALUES (?,?,?,?,?)",
                params![rowid, latitude, latitude, longitude, longitude],
            )
            .map_err(PhotostaffError::database)?;
    }
    transaction.execute("UPDATE photostaff_scan_entries SET status='completed',error=NULL,error_code=NULL,error_retryable=0,next_retry_at=NULL,updated_at=? WHERE job_id=? AND path=?", params![now_iso(),record.job_id,record.path]).map_err(PhotostaffError::database)?;
    transaction.execute("UPDATE photostaff_jobs SET scanned=scanned+1,processed=processed+1,current_path=?,phase='processing',updated_at=? WHERE id=?", params![record.path,now_iso(),record.job_id]).map_err(PhotostaffError::database)?;
    transaction
        .execute(
            "DELETE FROM photostaff_publish_journal WHERE operation_id = ?",
            [&record.operation_id],
        )
        .map_err(PhotostaffError::database)?;
    transaction
        .commit()
        .map_err(PhotostaffError::database)
        .map(|_| true)
}

fn ensure_job_owned(connection: &Connection, job_id: &str, worker_id: &str) -> DbResult<()> {
    let now = now_iso();
    let owned: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM photostaff_jobs WHERE id = ? AND status = 'running' AND worker_id = ? AND lease_expires_at > ?)",
        params![job_id, worker_id, now],
        |row| row.get(0),
    ).map_err(PhotostaffError::database)?;
    if !owned {
        return Err(PhotostaffError::new(
            ErrorCode::Database,
            "Photostaff job lease is no longer owned by this worker",
            true,
        ));
    }
    Ok(())
}

fn job_recoverable(connection: &Connection, job_id: &str) -> DbResult<bool> {
    let now = now_iso();
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM photostaff_jobs WHERE id = ? AND (status <> 'running' OR lease_expires_at IS NULL OR lease_expires_at <= ?))",
            params![job_id, now],
            |row| row.get(0),
        )
        .map_err(PhotostaffError::database)
}

fn same_directory_stem(candidate: &str, parent: &Path, stem: &str) -> bool {
    let candidate = Path::new(candidate);
    candidate.parent().unwrap_or_else(|| Path::new("")) == parent
        && candidate
            .file_stem()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.to_lowercase() == stem.to_lowercase())
}

fn setting_json(connection: &Connection, key: &str) -> DbResult<Option<String>> {
    connection
        .query_row(
            "SELECT value_json FROM system_settings WHERE key = ?",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(PhotostaffError::database)
}

fn insert_job(
    connection: &Connection,
    settings: &LibrarySettings,
    kind: &str,
    path: &str,
) -> DbResult<()> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    connection.execute("INSERT INTO photostaff_jobs (id,kind,status,root_id,storage_pool_id,path,library_updated_at,scan_generation,created_at,updated_at) VALUES (?,?,'queued',?,?,?,?,?,?,?)", params![id,kind,settings.root_id,settings.storage_pool_id,path,settings.updated_at,id,now,now]).map_err(PhotostaffError::database)?;
    Ok(())
}

fn map_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    Ok(Job {
        id: row.get(0)?,
        kind: row.get(1)?,
        root_id: row.get(2)?,
        root_path: row.get(3)?,
        storage_pool_id: row.get(4)?,
        path: row.get(5)?,
        library_updated_at: row.get(6)?,
        scan_generation: row.get(7)?,
        retry_count: row.get(8)?,
    })
}

fn media_kind(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => "image",
        MediaKind::Video => "video",
        MediaKind::Raw => "raw",
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC3339 timestamp")
}
fn iso_from_ns(timestamp_ns: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(timestamp_ns))
        .ok()
        .and_then(|value| value.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into())
}
fn iso_after(milliseconds: i128) -> String {
    (OffsetDateTime::now_utc() + time::Duration::milliseconds(milliseconds as i64))
        .format(&Rfc3339)
        .expect("RFC3339 timestamp")
}

fn check(name: &str, value: u64, minimum: u64, maximum: u64) -> DbResult<()> {
    if value < minimum || value > maximum {
        return Err(PhotostaffError::new(
            ErrorCode::Database,
            format!("Invalid Photostaff setting {name}"),
            false,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{MetadataRecord, MetadataValue};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    #[test]
    fn processing_defaults_validate() {
        assert!(ProcessingSettings::default().validate().is_ok());
        let invalid = ProcessingSettings {
            processing_concurrency: 5,
            ..ProcessingSettings::default()
        };
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn sidecar_sibling_matching_excludes_nested_directories() {
        assert!(same_directory_stem(
            "Pictures/coast.jpg",
            Path::new("Pictures"),
            "coast"
        ));
        assert!(!same_directory_stem(
            "Pictures/archive/coast.jpg",
            Path::new("Pictures"),
            "coast"
        ));
    }

    #[test]
    fn publication_transaction_updates_all_indexes_and_clears_the_journal() {
        let mut connection = test_connection();
        seed_job(&connection);
        let record = publish_record();
        connection.execute(
            "INSERT INTO photostaff_publish_journal (operation_id,job_id,asset_id,source_path,result_json,created_at) VALUES (?,?,?,?,?,?)",
            params![record.operation_id, record.job_id, record.asset_id, record.path, "{}", now_iso()],
        ).unwrap();

        complete_publish_transaction(&mut connection, &record, Some("worker-1")).unwrap();

        let asset: (String, String, i64) = connection.query_row(
            "SELECT status,error_code,derivative_schema_version FROM photostaff_assets WHERE id='asset-1'",
            [],
            |row| Ok((row.get(0)?, row.get::<_, Option<String>>(1)?.unwrap_or_default(), row.get(2)?)),
        ).unwrap();
        assert_eq!(asset, ("ready".into(), String::new(), 1));
        let metadata: (String, String, i64) = connection.query_row(
            "SELECT status,camera_model,schema_version FROM photostaff_asset_metadata WHERE asset_id='asset-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(metadata, ("ready".into(), "Camera 1".into(), 2));
        assert_eq!(
            scalar(&connection, "SELECT COUNT(*) FROM photostaff_keywords"),
            1
        );
        assert_eq!(
            scalar(
                &connection,
                "SELECT COUNT(*) FROM photostaff_metadata_values"
            ),
            1
        );
        assert_eq!(
            scalar(
                &connection,
                "SELECT COUNT(*) FROM photostaff_metadata_fts WHERE photostaff_metadata_fts MATCH 'coast'"
            ),
            1
        );
        assert_eq!(
            scalar(&connection, "SELECT COUNT(*) FROM photostaff_geo_index"),
            1
        );
        assert_eq!(
            scalar(
                &connection,
                "SELECT COUNT(*) FROM photostaff_publish_journal"
            ),
            0
        );
        let progress: (String, i64, i64) = connection.query_row(
            "SELECT status,(SELECT scanned FROM photostaff_jobs WHERE id='job-1'),(SELECT processed FROM photostaff_jobs WHERE id='job-1') FROM photostaff_scan_entries WHERE job_id='job-1' AND path='Pictures/coast.jpg'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(progress, ("completed".into(), 1, 1));

        complete_publish_transaction(&mut connection, &record, Some("worker-1")).unwrap();
        let repeated_progress: (i64, i64) = connection
            .query_row(
                "SELECT scanned,processed FROM photostaff_jobs WHERE id='job-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(repeated_progress, (1, 1));
    }

    #[test]
    fn publication_transaction_rejects_a_stale_worker() {
        let mut connection = test_connection();
        seed_job(&connection);
        let record = publish_record();
        connection.execute(
            "INSERT INTO photostaff_publish_journal (operation_id,job_id,asset_id,source_path,result_json,created_at) VALUES (?,?,?,?,?,?)",
            params![record.operation_id, record.job_id, record.asset_id, record.path, "{}", now_iso()],
        ).unwrap();

        let error =
            complete_publish_transaction(&mut connection, &record, Some("worker-2")).unwrap_err();

        assert_eq!(error.code, ErrorCode::Database);
        assert_eq!(
            scalar(
                &connection,
                "SELECT COUNT(*) FROM photostaff_publish_journal"
            ),
            1
        );
        assert_eq!(
            scalar(&connection, "SELECT COUNT(*) FROM photostaff_assets"),
            0
        );
    }

    #[test]
    fn journal_recovery_cannot_race_an_active_worker() {
        let mut connection = test_connection();
        seed_job(&connection);
        let record = publish_record();
        connection.execute(
            "INSERT INTO photostaff_publish_journal (operation_id,job_id,asset_id,source_path,result_json,created_at) VALUES (?,?,?,?,?,?)",
            params![record.operation_id, record.job_id, record.asset_id, record.path, "{}", now_iso()],
        ).unwrap();

        let error = complete_publish_transaction(&mut connection, &record, None).unwrap_err();

        assert_eq!(error.code, ErrorCode::Database);
        assert_eq!(
            scalar(
                &connection,
                "SELECT COUNT(*) FROM photostaff_publish_journal"
            ),
            1
        );
        assert_eq!(
            scalar(&connection, "SELECT COUNT(*) FROM photostaff_assets"),
            0
        );
    }

    #[test]
    fn failed_asset_sql_preserves_identity_and_stable_error() {
        let connection = test_connection();
        let job = test_job();
        let identity = identity(99);
        record_failed_asset_connection(
            &connection,
            &job,
            "Pictures/broken.raw",
            "broken.raw",
            identity,
            "decoder rejected input",
            "CORRUPT_MEDIA",
            false,
        )
        .unwrap();

        let row: (String, String, i64, i64, i64) = connection.query_row(
            "SELECT status,error_code,error_retryable,source_inode,source_size_bytes FROM photostaff_assets WHERE path='Pictures/broken.raw'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap();
        assert_eq!(row, ("failed".into(), "CORRUPT_MEDIA".into(), 0, 99, 4096));
    }

    #[tokio::test]
    async fn stale_worker_cannot_delete_the_current_owners_reservation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db.sqlite");
        seed_lease_database(&path);
        let db = Db::open(&path).unwrap();
        let job = test_job();
        let error = PhotostaffError::new(ErrorCode::CommandTimeout, "timeout", true);

        db.retry_or_fail_job(&job, "stale-worker", &error, Some(Duration::from_secs(1)))
            .await
            .unwrap();

        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            scalar(
                &connection,
                "SELECT COUNT(*) FROM photostaff_space_reservations"
            ),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT worker_id FROM photostaff_jobs WHERE id = 'job-1'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "current-worker"
        );
    }

    #[tokio::test]
    async fn concurrent_workers_cannot_overcommit_reserved_space() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db.sqlite");
        seed_lease_database(&path);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute("DELETE FROM photostaff_space_reservations", [])
            .unwrap();
        connection.execute("INSERT INTO photostaff_jobs (id,status,worker_id,lease_expires_at,retry_count,error_retryable,updated_at) VALUES ('job-2','running','worker-2','9999-01-01T00:00:00Z',0,0,'2026-01-01T00:00:00Z')", []).unwrap();
        drop(connection);
        let first = Db::open(&path).unwrap();
        let second = Db::open(&path).unwrap();
        let first_job = test_job();
        let mut second_job = test_job();
        second_job.id = "job-2".into();

        let (left, right) = tokio::join!(
            first.reserve_space(&first_job, "a.jpg", "cache", 80, 100, 0, "current-worker"),
            second.reserve_space(&second_job, "b.jpg", "cache", 80, 100, 0, "worker-2")
        );

        assert_ne!(left.is_ok(), right.is_ok());
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            scalar(
                &connection,
                "SELECT SUM(reserved_bytes) FROM photostaff_space_reservations"
            ),
            80
        );
    }

    fn seed_lease_database(path: &Path) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                r#"
            CREATE TABLE photostaff_jobs (
              id TEXT PRIMARY KEY, status TEXT NOT NULL, worker_id TEXT,
              lease_expires_at TEXT, phase TEXT, error TEXT, error_code TEXT,
              error_retryable INTEGER NOT NULL DEFAULT 0,
              retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
              finished_at TEXT, updated_at TEXT NOT NULL
            );
            CREATE TABLE photostaff_space_reservations (
              id TEXT PRIMARY KEY, job_id TEXT NOT NULL, storage_pool_id TEXT NOT NULL,
              path TEXT NOT NULL, reserved_bytes INTEGER NOT NULL, updated_at TEXT NOT NULL
            );
            INSERT INTO photostaff_jobs (
              id,status,worker_id,lease_expires_at,retry_count,error_retryable,updated_at
            ) VALUES (
              'job-1','running','current-worker','9999-01-01T00:00:00Z',0,0,
              '2026-01-01T00:00:00Z'
            );
            INSERT INTO photostaff_space_reservations (
              id,job_id,storage_pool_id,path,reserved_bytes,updated_at
            ) VALUES (
              'reservation-1','job-1','cache','current.jpg',10,
              '2026-01-01T00:00:00Z'
            );
            "#,
            )
            .unwrap();
    }

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
            CREATE TABLE photostaff_assets (
              id TEXT PRIMARY KEY, root_id TEXT NOT NULL, storage_pool_id TEXT NOT NULL,
              path TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL,
              size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, content_hash TEXT,
              width INTEGER, height INTEGER, orientation INTEGER, taken_at TEXT NOT NULL,
              taken_at_source TEXT NOT NULL, thumbnail_key TEXT, preview_key TEXT,
              status TEXT NOT NULL, error TEXT, error_code TEXT, error_retryable INTEGER NOT NULL,
              source_device INTEGER, source_inode INTEGER, source_size_bytes INTEGER,
              source_mtime_ns INTEGER, source_ctime_ns INTEGER, sidecar_path TEXT,
              sidecar_device INTEGER, sidecar_inode INTEGER, sidecar_size_bytes INTEGER,
              sidecar_mtime_ns INTEGER, sidecar_ctime_ns INTEGER,
              derivative_schema_version INTEGER NOT NULL, scan_generation TEXT,
              library_updated_at TEXT NOT NULL, indexed_at TEXT NOT NULL,
              UNIQUE(root_id,storage_pool_id,path)
            );
            CREATE TABLE photostaff_jobs (
              id TEXT PRIMARY KEY, scanned INTEGER NOT NULL DEFAULT 0,
              processed INTEGER NOT NULL DEFAULT 0, current_path TEXT, phase TEXT,
              updated_at TEXT, status TEXT NOT NULL DEFAULT 'running',
              worker_id TEXT, lease_expires_at TEXT
            );
            CREATE TABLE photostaff_scan_entries (
              job_id TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL,
              error TEXT, error_code TEXT, error_retryable INTEGER NOT NULL DEFAULT 0,
              next_retry_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(job_id,path)
            );
            CREATE TABLE photostaff_publish_journal (
              operation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, asset_id TEXT NOT NULL,
              source_path TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE photostaff_asset_metadata (
              asset_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, status TEXT NOT NULL,
              media_kind TEXT NOT NULL, captured_at TEXT, captured_at_local TEXT,
              capture_offset_minutes INTEGER, capture_source TEXT NOT NULL, duration_ms INTEGER,
              container TEXT, video_codec TEXT, audio_codec TEXT, camera_make TEXT,
              camera_model TEXT, software TEXT, body_serial TEXT, lens_make TEXT,
              lens_model TEXT, lens_serial TEXT, iso REAL, exposure_time_seconds REAL,
              aperture REAL, focal_length_mm REAL, focal_length_35_mm REAL,
              exposure_bias_ev REAL, exposure_program TEXT, metering_mode TEXT, flash TEXT,
              white_balance TEXT, title TEXT, description TEXT, creator TEXT, copyright TEXT,
              rating REAL, gps_latitude REAL, gps_longitude REAL, gps_altitude_m REAL,
              gps_direction_deg REAL, raw_metadata_json TEXT NOT NULL, warnings_json TEXT NOT NULL,
              sidecar_path TEXT, sidecar_size_bytes INTEGER, sidecar_mtime_ms INTEGER,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE photostaff_keywords (
              asset_id TEXT NOT NULL, keyword TEXT NOT NULL, normalized_keyword TEXT NOT NULL,
              PRIMARY KEY(asset_id,normalized_keyword)
            );
            CREATE TABLE photostaff_metadata_values (
              id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL, source TEXT NOT NULL,
              key TEXT NOT NULL, value_type TEXT NOT NULL, text_value TEXT,
              normalized_text_value TEXT, number_value REAL, date_value TEXT,
              boolean_value INTEGER, sensitive INTEGER NOT NULL, ordinal INTEGER NOT NULL
            );
            CREATE VIRTUAL TABLE photostaff_metadata_fts USING fts5(
              asset_id UNINDEXED,name,path,title,description,creator,copyright,keywords,camera,lens
            );
            CREATE VIRTUAL TABLE photostaff_geo_index USING rtree(
              metadata_rowid,min_latitude,max_latitude,min_longitude,max_longitude
            );
        "#,
            )
            .unwrap();
        connection
    }

    fn seed_job(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO photostaff_jobs (id,worker_id,lease_expires_at) VALUES ('job-1','worker-1','9999-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO photostaff_scan_entries (job_id,path,status,updated_at) VALUES ('job-1','Pictures/coast.jpg','processing',?)",
            [now_iso()],
        ).unwrap();
    }

    fn test_job() -> Job {
        Job {
            id: "job-1".into(),
            kind: "full_scan".into(),
            root_id: "root-1".into(),
            root_path: "/zos/data/primary".into(),
            storage_pool_id: "pool-1".into(),
            path: "Pictures".into(),
            library_updated_at: "2026-10-11T00:00:00Z".into(),
            scan_generation: "generation-1".into(),
            retry_count: 0,
        }
    }

    fn publish_record() -> PublishRecord {
        let mut raw_metadata = BTreeMap::new();
        raw_metadata.insert("exif".into(), BTreeMap::new());
        PublishRecord {
            operation_id: "operation-1".into(),
            job_id: "job-1".into(),
            asset_id: "asset-1".into(),
            root_id: "root-1".into(),
            storage_pool_id: "pool-1".into(),
            library_updated_at: "2026-10-11T00:00:00Z".into(),
            scan_generation: "generation-1".into(),
            path: "Pictures/coast.jpg".into(),
            name: "coast.jpg".into(),
            source_identity: identity(11),
            sidecar_identity: Some(identity(12)),
            sidecar_path: Some("Pictures/coast.xmp".into()),
            processed: ProcessedMedia {
                content_hash: "abc123".into(),
                mime_type: "image/jpeg".into(),
                width: 4000,
                height: 3000,
                orientation: Some(1),
                taken_at: "2026-10-10T12:00:00Z".into(),
                taken_at_source: "exif".into(),
                thumbnail_key: "thumbnail/key.webp".into(),
                preview_key: "preview/key.webp".into(),
                thumbnail_temp_path: PathBuf::from("thumbnail/.key.tmp"),
                thumbnail_path: PathBuf::from("thumbnail/key.webp"),
                thumbnail_identity: identity(21),
                preview_temp_path: PathBuf::from("preview/.key.tmp"),
                preview_path: PathBuf::from("preview/key.webp"),
                preview_identity: identity(22),
                metadata: metadata_record(raw_metadata),
            },
        }
    }

    fn metadata_record(
        raw_metadata: BTreeMap<String, BTreeMap<String, Vec<serde_json::Value>>>,
    ) -> MetadataRecord {
        MetadataRecord {
            schema_version: 2,
            status: "ready".into(),
            media_kind: MediaKind::Image,
            captured_at: Some("2026-10-10T12:00:00Z".into()),
            captured_at_local: None,
            capture_offset_minutes: None,
            capture_source: "exif".into(),
            duration_ms: None,
            container: None,
            video_codec: None,
            audio_codec: None,
            camera_make: Some("Sigma".into()),
            camera_model: Some("Camera 1".into()),
            software: None,
            body_serial: None,
            lens_make: None,
            lens_model: Some("Lens 1".into()),
            lens_serial: None,
            iso: Some(100.0),
            exposure_time_seconds: Some(0.01),
            aperture: Some(2.8),
            focal_length_mm: Some(35.0),
            focal_length_35_mm: Some(35.0),
            exposure_bias_ev: None,
            exposure_program: None,
            metering_mode: None,
            flash: None,
            white_balance: None,
            title: Some("Coast".into()),
            description: Some("Coast sunset".into()),
            creator: Some("Tester".into()),
            copyright: None,
            rating: Some(5.0),
            gps_latitude: Some(31.2),
            gps_longitude: Some(121.5),
            gps_altitude_m: None,
            gps_direction_deg: None,
            raw_metadata,
            warnings: Vec::new(),
            keywords: vec!["Coast".into()],
            values: vec![MetadataValue {
                source: "exif".into(),
                key: "EXIF:Model".into(),
                value_type: "text".into(),
                text_value: Some("Camera 1".into()),
                number_value: None,
                date_value: None,
                boolean_value: None,
                sensitive: false,
                ordinal: 0,
            }],
            sidecar_path: Some("Pictures/coast.xmp".into()),
            sidecar_size_bytes: Some(512),
            sidecar_mtime_ms: Some(1_700_000_000_000),
        }
    }

    fn identity(inode: u64) -> FileIdentity {
        FileIdentity {
            device: 7,
            inode,
            size: 4096,
            mtime_ns: 1_700_000_000_000_000_000,
            ctime_ns: 1_700_000_000_000_000_001,
        }
    }

    fn scalar(connection: &Connection, sql: &str) -> i64 {
        connection.query_row(sql, [], |row| row.get(0)).unwrap()
    }
}
