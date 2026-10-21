use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{FuturesUnordered, StreamExt};
use nix::sys::statvfs::fstatvfs;
use sd_notify::NotifyState;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::command::CommandRunner;
use crate::config::{Config, verify_tools};
use crate::db::{Db, Job, ProcessingSettings, PublishRecord, ScanEntry};
use crate::error::{ErrorCode, PhotostaffError};
use crate::media::{Sidecar, candidate_kind, process_media};
use crate::publish::{
    CacheLock, cleanup_orphan_derivatives, cleanup_orphan_temps, cleanup_publish_temps,
    publish_derivatives,
};
use crate::retry::retry_delay;
use crate::storage::{FileIdentity, Library};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const CACHE_RESERVATION_SCOPE: &str = "__photostaff_cache__";

pub struct Photostaff {
    config: Arc<Config>,
    db: Db,
    worker_id: String,
    shutdown: CancellationToken,
}

impl Photostaff {
    pub fn new(config: Config) -> Result<Self, PhotostaffError> {
        let db = Db::open(&config.database_path)?;
        Ok(Self {
            config: Arc::new(config),
            db,
            worker_id: Uuid::new_v4().to_string(),
            shutdown: CancellationToken::new(),
        })
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    pub async fn run(self) -> Result<(), PhotostaffError> {
        self.db.wait_for_schema(Duration::from_secs(60)).await?;
        verify_tools()?;
        {
            let cleanup_lock = CacheLock::exclusive(&self.config.cache_root).await?;
            let journals = self.db.journals().await?;
            let cache_root = self.config.cache_root.clone();
            cleanup_lock
                .run_blocking(move || cleanup_orphan_temps(&cache_root, &journals))
                .await?;
        }
        if let Err(error) = recover_journals(&self.db, &self.config.cache_root).await {
            if error.code == ErrorCode::PhotostaffStorageUnavailable {
                tracing::warn!(code = error.code.as_str(), message = %error.message, "Photostaff journal recovery is waiting for storage");
            } else {
                return Err(error);
            }
        }
        self.db.heartbeat(&self.worker_id, VERSION).await?;
        let _ = sd_notify::notify(&[NotifyState::Ready]);
        tracing::info!(worker_id = %self.worker_id, "Photostaff worker ready");

        let heartbeat = tokio::spawn(heartbeat_loop(
            self.db.clone(),
            self.worker_id.clone(),
            self.shutdown.clone(),
        ));
        let watchdog = tokio::spawn(watchdog_loop(self.shutdown.clone()));

        let mut poll = tokio::time::interval(Duration::from_secs(1));
        poll.tick().await;
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => break,
                _ = poll.tick() => {
                    if let Err(error) = self.tick().await {
                        tracing::warn!(code = error.code.as_str(), message = %error.message, "Photostaff tick failed");
                    }
                }
            }
        }
        let _ = sd_notify::notify(&[NotifyState::Stopping]);
        self.shutdown.cancel();
        let _ = heartbeat.await;
        let _ = watchdog.await;
        self.db.release_worker(&self.worker_id).await?;
        Ok(())
    }

    async fn tick(&self) -> Result<(), PhotostaffError> {
        recover_journals(&self.db, &self.config.cache_root).await?;
        let (library_settings, processing) = self.db.settings().await?;
        let Some(library_settings) = library_settings else {
            return Ok(());
        };
        self.db
            .ensure_periodic_job(&library_settings, processing.scan_interval_ms)
            .await?;
        let Some(job) = self.db.claim_job(&self.worker_id).await? else {
            return Ok(());
        };
        let result = run_job(
            &self.db,
            &self.worker_id,
            &job,
            &processing,
            &self.config.cache_root,
            &self.shutdown,
        )
        .await;
        if let Err(error) = result {
            if self.shutdown.is_cancelled() {
                return Ok(());
            }
            let delay = retry_delay(&error, job.retry_count, &processing);
            self.db
                .retry_or_fail_job(&job, &self.worker_id, &error, delay)
                .await?;
        }
        Ok(())
    }
}

async fn heartbeat_loop(db: Db, worker_id: String, shutdown: CancellationToken) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    interval.tick().await;
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = interval.tick() => match db.heartbeat(&worker_id, VERSION).await {
                Ok(()) => {}
                Err(error) => tracing::warn!(code = error.code.as_str(), message = %error.message, "Photostaff heartbeat failed"),
            }
        }
    }
}

async fn watchdog_loop(shutdown: CancellationToken) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    interval.tick().await;
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = interval.tick() => { let _ = sd_notify::notify(&[NotifyState::Watchdog]); }
        }
    }
}

async fn run_job(
    db: &Db,
    worker_id: &str,
    job: &Job,
    settings: &ProcessingSettings,
    cache_root: &Path,
    shutdown: &CancellationToken,
) -> Result<(), PhotostaffError> {
    let library = Arc::new(Library::resolve(
        Path::new(&job.root_path),
        &job.storage_pool_id,
        Path::new(&job.path),
    )?);
    tracing::debug!(mountpoint = %library.mountpoint().display(), job_id = %job.id, "Photostaff storage verified");
    db.initialize_scan(job, worker_id).await?;
    let lease_shutdown = CancellationToken::new();
    let lease_lost = CancellationToken::new();
    let lease_task = {
        let db = db.clone();
        let job_id = job.id.clone();
        let worker_id = worker_id.to_owned();
        let stop = lease_shutdown.clone();
        let lost = lease_lost.clone();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(Duration::from_secs(5));
            timer.tick().await;
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = timer.tick() => match db.renew_lease(&job_id, &worker_id).await {
                        Ok(true) => {}
                        _ => { lost.cancel(); break; }
                    }
                }
            }
        })
    };
    let work = async {
        discover(db, worker_id, job, &library, shutdown, &lease_lost).await?;
        library.verify_unchanged()?;
        if !db.set_phase(&job.id, worker_id, "processing", None).await? {
            return Err(lease_lost_error());
        }
        process_entries(
            db,
            worker_id,
            job,
            settings,
            library,
            cache_root,
            shutdown,
            &lease_lost,
        )
        .await?;
        db.set_phase(&job.id, worker_id, "cleanup", None).await?;
        db.finish_job(job, worker_id).await?;
        if job.kind == "full_scan" {
            let cleanup = async {
                let cleanup_lock = CacheLock::exclusive(cache_root).await?;
                let (keys, journals) = db.derivative_cleanup_state().await?;
                let cache_root = cache_root.to_owned();
                cleanup_lock
                    .run_blocking(move || cleanup_orphan_derivatives(&cache_root, &keys, &journals))
                    .await
                    .map(|_| ())
            }
            .await;
            if let Err(error) = cleanup {
                tracing::warn!(code = error.code.as_str(), message = %error.message, "Could not clean orphaned Photostaff derivatives");
            }
        }
        Ok(())
    };
    let result = tokio::select! {
        _ = shutdown.cancelled() => Err(PhotostaffError::new(ErrorCode::Internal, "Photostaff is stopping", true)),
        result = work => result,
    };
    lease_shutdown.cancel();
    let _ = lease_task.await;
    result
}

async fn discover(
    db: &Db,
    worker_id: &str,
    job: &Job,
    library: &Library,
    shutdown: &CancellationToken,
    lease_lost: &CancellationToken,
) -> Result<(), PhotostaffError> {
    while let Some(entry) = db.claim_entry(&job.id, "directory", worker_id).await? {
        check_control(shutdown, lease_lost)?;
        let directory = match library.read_directory(Path::new(&entry.path)) {
            Ok(directory) => directory,
            Err(error)
                if matches!(
                    error.code,
                    ErrorCode::InvalidPath | ErrorCode::SourceChanged
                ) =>
            {
                db.skip_entry(&job.id, &entry.path, worker_id).await?;
                continue;
            }
            Err(error) => return Err(error),
        };
        for child in directory {
            check_control(shutdown, lease_lost)?;
            let child = child.map_err(PhotostaffError::storage)?;
            let name = child.file_name().into_string().map_err(|_| {
                PhotostaffError::new(
                    ErrorCode::InvalidPath,
                    "Photostaff paths must be valid UTF-8",
                    false,
                )
            })?;
            let child_path = Path::new(&entry.path)
                .join(&name)
                .to_string_lossy()
                .into_owned();
            let file_type = child.file_type().map_err(PhotostaffError::storage)?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                match library.open_directory(Path::new(&child_path)) {
                    Ok(directory) => drop(directory),
                    Err(error)
                        if matches!(
                            error.code,
                            ErrorCode::InvalidPath | ErrorCode::SourceChanged
                        ) =>
                    {
                        continue;
                    }
                    Err(error) => return Err(error),
                }
                db.add_scan_entry(&job.id, &child_path, "directory", &entry.path, worker_id)
                    .await?;
            } else if file_type.is_file() && candidate_kind(&name).is_some() {
                db.add_scan_entry(&job.id, &child_path, "media", &entry.path, worker_id)
                    .await?;
            } else if file_type.is_file() && name.to_ascii_lowercase().ends_with(".xmp") {
                db.add_scan_entry(&job.id, &child_path, "sidecar", &entry.path, worker_id)
                    .await?;
            }
        }
        db.complete_entry(&job.id, &entry.path, false, worker_id)
            .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn process_entries(
    db: &Db,
    worker_id: &str,
    job: &Job,
    settings: &ProcessingSettings,
    library: Arc<Library>,
    cache_root: &Path,
    shutdown: &CancellationToken,
    lease_lost: &CancellationToken,
) -> Result<(), PhotostaffError> {
    let mut running = FuturesUnordered::new();
    let mut exhausted = false;
    loop {
        check_control(shutdown, lease_lost)?;
        while running.len() < settings.processing_concurrency && !exhausted {
            match db.claim_entry(&job.id, "media", worker_id).await? {
                Some(entry) => {
                    let db = db.clone();
                    let worker_id = worker_id.to_owned();
                    let job = job.clone();
                    let settings = settings.clone();
                    let library = Arc::clone(&library);
                    let cache_root = cache_root.to_owned();
                    running.push(async move {
                        process_entry(
                            &db,
                            &worker_id,
                            &job,
                            &entry,
                            &settings,
                            &library,
                            &cache_root,
                            lease_lost,
                        )
                        .await
                    });
                }
                None => exhausted = true,
            }
        }
        if running.is_empty() {
            break;
        }
        if let Some(result) = running.next().await {
            result?;
        }
    }
    library.verify_unchanged()
}

#[allow(clippy::too_many_arguments)]
async fn process_entry(
    db: &Db,
    worker_id: &str,
    job: &Job,
    entry: &ScanEntry,
    settings: &ProcessingSettings,
    library: &Library,
    cache_root: &Path,
    lease_lost: &CancellationToken,
) -> Result<(), PhotostaffError> {
    check_lease(lease_lost)?;
    let source_result = library.open_media(Path::new(&entry.path));
    let (mut source, source_identity) = match source_result {
        Ok(value) => value,
        Err(error) if !error.retryable => {
            db.fail_entry(job, entry, &error, None, worker_id).await?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let sidecar_resolution = db.sidecar_for(&job.id, &entry.path).await?;
    let (sidecar_file, sidecar_path, sidecar_identity, sidecar_warning) = match sidecar_resolution {
        Ok(Some(path)) => {
            let (file, identity) = library.open_media(Path::new(&path))?;
            (Some(file), Some(path), Some(identity), None)
        }
        Ok(None) => (None, None, None, None),
        Err(warning) => (None, None, None, Some(warning)),
    };
    if db
        .mark_current_if_unchanged(
            job,
            &entry.path,
            source_identity,
            sidecar_path.as_deref().zip(sidecar_identity),
            worker_id,
        )
        .await?
    {
        db.complete_entry(&job.id, &entry.path, true, worker_id)
            .await?;
        return Ok(());
    }
    let available = cache_available_bytes(cache_root)?;
    // A decode scratch file and both derivatives can coexist until publication.
    let estimate = settings.max_intermediate_bytes.saturating_mul(3);
    let reservation = db
        .reserve_space(
            job,
            &entry.path,
            CACHE_RESERVATION_SCOPE,
            estimate,
            available,
            settings.min_free_space_bytes,
            worker_id,
        )
        .await?;
    let result: Result<(), PhotostaffError> = async {
        let cache_lock = CacheLock::shared(cache_root).await?;
        let runner = CommandRunner;
        let sidecar = sidecar_file
            .as_ref()
            .zip(sidecar_path.as_ref())
            .zip(sidecar_identity)
            .map(|((file, path), identity)| Sidecar {
                file,
                path: path.clone(),
                identity,
            });
        let name = Path::new(&entry.path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                PhotostaffError::new(ErrorCode::InvalidPath, "Media has no file name", false)
            })?;
        let mut processed = tokio::select! {
            _ = lease_lost.cancelled() => return Err(lease_lost_error()),
            result = process_media(
                &mut source,
                name,
                source_identity,
                sidecar,
                cache_root,
                settings,
                &runner,
            ) => result?,
        };
        verify_sources(
            library,
            entry,
            &source,
            source_identity,
            sidecar_file.as_ref(),
            sidecar_path.as_deref(),
            sidecar_identity,
        )?;
        check_lease(lease_lost)?;
        if let Some(warning) = sidecar_warning {
            processed.metadata.warnings.push(warning);
            processed.metadata.status = "partial".into();
        }
        let asset_id = db.asset_id(job, &entry.path).await?;
        let record = PublishRecord {
            operation_id: Uuid::new_v4().to_string(),
            job_id: job.id.clone(),
            asset_id,
            root_id: job.root_id.clone(),
            storage_pool_id: job.storage_pool_id.clone(),
            library_updated_at: job.library_updated_at.clone(),
            scan_generation: job.scan_generation.clone(),
            path: entry.path.clone(),
            name: name.to_owned(),
            source_identity,
            sidecar_identity,
            sidecar_path: sidecar_path.clone(),
            processed,
        };
        if !db
            .set_phase(&job.id, worker_id, "publishing", Some(&entry.path))
            .await?
        {
            return Err(lease_lost_error());
        }
        db.begin_publish(&record, worker_id).await?;
        let publish_record = record.clone();
        let publish_cache_root = cache_root.to_owned();
        let (cache_lock, ()) = match cache_lock
            .run_blocking(move || publish_derivatives(&publish_record, &publish_cache_root))
            .await
        {
            Ok(result) => result,
            Err(error) => {
                db.abort_journal_owned(&record.operation_id, false, worker_id)
                    .await?;
                return Err(error);
            }
        };
        if let Err(error) = verify_sources(
            library,
            entry,
            &source,
            source_identity,
            sidecar_file.as_ref(),
            sidecar_path.as_deref(),
            sidecar_identity,
        ) {
            db.abort_journal_owned(&record.operation_id, true, worker_id)
                .await?;
            return Err(error);
        }
        check_lease(lease_lost)?;
        db.complete_publish_owned(&record, worker_id).await?;
        let cleanup_record = record.clone();
        if let Err(error) = cache_lock
            .run_blocking(move || {
                cleanup_publish_temps(&cleanup_record);
                Ok(())
            })
            .await
        {
            tracing::warn!(code = error.code.as_str(), message = %error.message, "Could not clean Photostaff publish temps");
        }
        Ok(())
    }
    .await;
    db.release_space(&reservation).await?;
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.retryable => Err(error),
        Err(error) => {
            let name = Path::new(&entry.path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("media");
            db.record_failed_asset(job, &entry.path, name, source_identity, &error, worker_id)
                .await?;
            db.fail_entry(job, entry, &error, None, worker_id).await?;
            Ok(())
        }
    }
}

fn verify_sources(
    library: &Library,
    entry: &ScanEntry,
    source: &File,
    source_identity: FileIdentity,
    sidecar_file: Option<&File>,
    sidecar_path: Option<&str>,
    sidecar_identity: Option<FileIdentity>,
) -> Result<(), PhotostaffError> {
    verify_identity(source, source_identity)?;
    library.verify_media_identity(Path::new(&entry.path), source_identity)?;
    if let (Some(file), Some(path), Some(identity)) = (sidecar_file, sidecar_path, sidecar_identity)
    {
        verify_identity(file, identity)?;
        library.verify_media_identity(Path::new(path), identity)?;
    }
    Ok(())
}

struct JournalSources {
    library: Library,
    source: File,
    sidecar: Option<File>,
}

async fn open_journal_sources(
    db: &Db,
    record: &PublishRecord,
) -> Result<JournalSources, PhotostaffError> {
    let root_path = db.root_path(&record.root_id).await?;
    let parent = Path::new(&record.path)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let library = Library::resolve(Path::new(&root_path), &record.storage_pool_id, parent)?;
    let (source, identity) = library.open_media(Path::new(&record.path))?;
    if identity != record.source_identity {
        return Err(PhotostaffError::new(
            ErrorCode::SourceChanged,
            "Journal source no longer matches its recorded identity",
            false,
        ));
    }
    let sidecar = match (&record.sidecar_path, record.sidecar_identity) {
        (Some(path), Some(expected)) => {
            let (file, current) = library.open_media(Path::new(path))?;
            if current != expected {
                return Err(PhotostaffError::new(
                    ErrorCode::SourceChanged,
                    "Journal sidecar no longer matches its recorded identity",
                    false,
                ));
            }
            Some(file)
        }
        _ => None,
    };
    Ok(JournalSources {
        library,
        source,
        sidecar,
    })
}

fn verify_journal_sources(
    sources: &JournalSources,
    record: &PublishRecord,
) -> Result<(), PhotostaffError> {
    verify_identity(&sources.source, record.source_identity)?;
    sources
        .library
        .verify_media_identity(Path::new(&record.path), record.source_identity)?;
    if let (Some(file), Some(path), Some(identity)) = (
        sources.sidecar.as_ref(),
        record.sidecar_path.as_deref(),
        record.sidecar_identity,
    ) {
        verify_identity(file, identity)?;
        sources
            .library
            .verify_media_identity(Path::new(path), identity)?;
    }
    Ok(())
}

async fn recover_journals(db: &Db, cache_root: &Path) -> Result<(), PhotostaffError> {
    for record in db.recoverable_journals().await? {
        let cache_lock = CacheLock::shared(cache_root).await?;
        let sources = match open_journal_sources(db, &record).await {
            Ok(sources) => sources,
            Err(error) if error.retryable => return Err(error),
            Err(_) => {
                db.abort_journal(&record.operation_id, true).await?;
                continue;
            }
        };
        let publish_record = record.clone();
        let publish_cache_root = cache_root.to_owned();
        match cache_lock
            .run_blocking(move || publish_derivatives(&publish_record, &publish_cache_root))
            .await
        {
            Ok((cache_lock, ())) => {
                if let Err(error) = verify_journal_sources(&sources, &record) {
                    if error.retryable {
                        return Err(error);
                    }
                    db.abort_journal(&record.operation_id, true).await?;
                    continue;
                }
                if db.complete_publish(&record).await? {
                    let cleanup_record = record.clone();
                    if let Err(error) = cache_lock
                        .run_blocking(move || {
                            cleanup_publish_temps(&cleanup_record);
                            Ok(())
                        })
                        .await
                    {
                        tracing::warn!(code = error.code.as_str(), message = %error.message, "Could not clean recovered Photostaff publish temps");
                    }
                }
            }
            Err(error) if error.code == ErrorCode::PhotostaffStorageUnavailable => {
                return Err(error);
            }
            Err(_) => db.abort_journal(&record.operation_id, true).await?,
        }
    }
    Ok(())
}

fn cache_available_bytes(cache_root: &Path) -> Result<u64, PhotostaffError> {
    std::fs::create_dir_all(cache_root).map_err(PhotostaffError::storage)?;
    let directory = File::open(cache_root).map_err(PhotostaffError::storage)?;
    let stats = fstatvfs(&directory).map_err(PhotostaffError::storage)?;
    #[cfg(target_os = "linux")]
    let blocks_available = stats.blocks_available();
    #[cfg(not(target_os = "linux"))]
    let blocks_available = u64::from(stats.blocks_available());
    Ok(blocks_available.saturating_mul(stats.fragment_size()))
}

fn verify_identity(file: &File, expected: FileIdentity) -> Result<(), PhotostaffError> {
    if FileIdentity::from_file(file)? != expected {
        return Err(PhotostaffError::new(
            ErrorCode::SourceChanged,
            "Media source changed during publication",
            false,
        ));
    }
    Ok(())
}

fn lease_lost_error() -> PhotostaffError {
    PhotostaffError::new(ErrorCode::Database, "Photostaff job lease was lost", true)
}

fn check_control(
    shutdown: &CancellationToken,
    lease_lost: &CancellationToken,
) -> Result<(), PhotostaffError> {
    if shutdown.is_cancelled() {
        return Err(PhotostaffError::new(
            ErrorCode::Internal,
            "Photostaff is stopping",
            true,
        ));
    }
    check_lease(lease_lost)
}

fn check_lease(lease_lost: &CancellationToken) -> Result<(), PhotostaffError> {
    if lease_lost.is_cancelled() {
        return Err(lease_lost_error());
    }
    Ok(())
}

#[allow(dead_code)]
fn _identity(identity: FileIdentity) -> FileIdentity {
    identity
}
