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
use crate::db::{
    Db, DiscoveredEntry, Job, ProcessingSettings, PublishRecord, SCAN_BATCH_SIZE, ScanEntry,
};
use crate::error::{ErrorCode, PhotosError};
use crate::media::{METADATA_SCHEMA_VERSION, Sidecar, candidate_kind, process_media_reusing};
use crate::publish::{
    CacheLock, cleanup_orphan_derivatives, cleanup_orphan_temps, cleanup_publish_temps,
    publish_derivatives,
};
use crate::retry::retry_delay;
use crate::storage::{FileIdentity, Library};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const CACHE_RESERVATION_SCOPE: &str = "__photos_cache__";

pub struct Photos {
    config: Arc<Config>,
    db: Db,
    worker_id: String,
    shutdown: CancellationToken,
}

impl Photos {
    pub fn new(config: Config) -> Result<Self, PhotosError> {
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

    pub async fn run(self) -> Result<(), PhotosError> {
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
        if let Err(error) = recover_journals(
            &self.db,
            &self.config.data_root,
            &self.config.cache_root,
            self.config.production,
        )
        .await
        {
            if error.code == ErrorCode::PhotosStorageUnavailable {
                tracing::warn!(code = error.code.as_str(), message = %error.message, "Photos journal recovery is waiting for storage");
            } else {
                return Err(error);
            }
        }
        self.db.heartbeat(&self.worker_id, VERSION).await?;
        let _ = sd_notify::notify(&[NotifyState::Ready]);
        tracing::info!(worker_id = %self.worker_id, "Photos worker ready");

        let heartbeat = tokio::spawn(heartbeat_loop(
            self.db.clone(),
            self.worker_id.clone(),
            self.shutdown.clone(),
        ));
        let watchdog = tokio::spawn(watchdog_loop(self.shutdown.clone()));
        let maintenance =
            tokio::spawn(history_cleanup_loop(self.db.clone(), self.shutdown.clone()));

        let mut poll = tokio::time::interval(Duration::from_secs(1));
        poll.tick().await;
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => break,
                _ = poll.tick() => {
                    if let Err(error) = self.tick().await {
                        tracing::warn!(code = error.code.as_str(), message = %error.message, "Photos tick failed");
                    }
                }
            }
        }
        let _ = sd_notify::notify(&[NotifyState::Stopping]);
        self.shutdown.cancel();
        let _ = heartbeat.await;
        let _ = watchdog.await;
        let _ = maintenance.await;
        self.db.release_worker(&self.worker_id).await?;
        Ok(())
    }

    async fn tick(&self) -> Result<(), PhotosError> {
        recover_journals(
            &self.db,
            &self.config.data_root,
            &self.config.cache_root,
            self.config.production,
        )
        .await?;
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
            &self.config,
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

async fn history_cleanup_loop(db: Db, shutdown: CancellationToken) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = interval.tick() => {
                if let Err(error) = db.prune_history_batch().await {
                    tracing::warn!(code = error.code.as_str(), message = %error.message, "Photos history cleanup failed");
                }
            }
        }
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
                Err(error) => tracing::warn!(code = error.code.as_str(), message = %error.message, "Photos heartbeat failed"),
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
    config: &Config,
    shutdown: &CancellationToken,
) -> Result<(), PhotosError> {
    let started = std::time::Instant::now();
    let cache_root = &config.cache_root;
    let (current, _) = db.settings().await?;
    let current = current
        .filter(|current| {
            current.updated_at == job.library_updated_at
                && current.storage_pool_id == job.storage_pool_id
        })
        .ok_or_else(|| {
            PhotosError::new(
                ErrorCode::SourceChanged,
                "Photos library configuration changed",
                false,
            )
        })?;
    let library = Arc::new(Library::resolve(
        &config.data_root,
        &job.storage_pool_id,
        Path::new(&current.path),
        config.production,
    )?);
    tracing::debug!(mountpoint = %library.mountpoint().display(), job_id = %job.id, "Photos storage verified");
    let original_path = job.path.clone();
    let mut job = job.clone();
    // Keep the path spelling used by existing pool-root scans, preserving asset IDs.
    if current.path == "." && job.path != "." && !job.path.starts_with("./") {
        job.path = format!("./{}", job.path);
    }
    // A deleted/moved refresh directory is covered by its nearest existing ancestor.
    // Resolve through Library so symlink, mount and configured-root checks still apply.
    loop {
        match library.open_directory(Path::new(&job.path)) {
            Ok(_) => break,
            Err(error)
                if job.kind == "path_refresh"
                    && error.code == ErrorCode::SourceChanged
                    && job.path != current.path =>
            {
                let parent = Path::new(&job.path)
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or_else(|| Path::new("."));
                let path = parent.to_string_lossy().into_owned();
                job.path = path;
            }
            Err(error) => return Err(error),
        }
    }
    if job.path != original_path {
        job.scan_generation = Uuid::new_v4().to_string();
    }
    let job = &job;
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
        if job.path != original_path {
            db.restart_refresh_scope(job, worker_id).await?;
        }
        db.initialize_scan(job, worker_id).await?;
        db.backfill_lookup_keys(job, worker_id).await?;
        loop {
            check_control(shutdown, &lease_lost)?;
            if let Some(directory) = db.completed_directory(job, worker_id).await? {
                db.set_phase(&job.id, worker_id, "processing", Some(&directory))
                    .await?;
                process_entries(
                    db,
                    worker_id,
                    job,
                    &directory,
                    settings,
                    Arc::clone(&library),
                    cache_root,
                    shutdown,
                    &lease_lost,
                )
                .await?;
                db.finish_directory(job, &directory, worker_id).await?;
            } else if let Some(directory) = db.claim_entry(&job.id, "directory", worker_id).await? {
                db.set_phase(&job.id, worker_id, "discovering", Some(&directory.path))
                    .await?;
                discover(
                    db,
                    worker_id,
                    job,
                    &directory,
                    &library,
                    shutdown,
                    &lease_lost,
                )
                .await?;
            } else {
                break;
            }
        }
        library.verify_unchanged()?;
        db.set_phase(&job.id, worker_id, "cleanup", None).await?;
        db.finish_job(job, worker_id).await?;
        tracing::info!(job_id = %job.id, scope = %job.path, elapsed_ms = started.elapsed().as_millis() as u64, "Photos scan completed");
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
                tracing::warn!(code = error.code.as_str(), message = %error.message, "Could not clean orphaned Photos derivatives");
            }
        }
        Ok(())
    };
    let result = tokio::select! {
        _ = shutdown.cancelled() => Err(PhotosError::new(ErrorCode::Internal, "Photos is stopping", true)),
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
    entry: &ScanEntry,
    library: &Library,
    shutdown: &CancellationToken,
    lease_lost: &CancellationToken,
) -> Result<(), PhotosError> {
    check_control(shutdown, lease_lost)?;
    let directory = library.read_directory(Path::new(&entry.path))?;
    let mut batch = Vec::with_capacity(SCAN_BATCH_SIZE);
    for child in directory {
        check_control(shutdown, lease_lost)?;
        let child = child.map_err(PhotosError::storage)?;
        let name = child.file_name().into_string().map_err(|_| {
            PhotosError::new(
                ErrorCode::InvalidPath,
                "Photos paths must be valid UTF-8",
                false,
            )
        })?;
        let child_path = Path::new(&entry.path)
            .join(&name)
            .to_string_lossy()
            .into_owned();
        let file_type = child.file_type().map_err(PhotosError::storage)?;
        if file_type.is_symlink() {
            continue;
        }
        let entry_type = if file_type.is_dir() {
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
            "directory"
        } else if file_type.is_file() && candidate_kind(&name).is_some() {
            "media"
        } else if file_type.is_file() && name.to_ascii_lowercase().ends_with(".xmp") {
            "sidecar"
        } else {
            continue;
        };
        batch.push(DiscoveredEntry {
            path: child_path,
            entry_type: entry_type.into(),
        });
        if batch.len() == SCAN_BATCH_SIZE {
            db.add_scan_entries(&job.id, &entry.path, std::mem::take(&mut batch), worker_id)
                .await?;
        }
    }
    check_control(shutdown, lease_lost)?;
    db.add_scan_entries(&job.id, &entry.path, batch, worker_id)
        .await?;
    db.complete_entry(&job.id, &entry.path, false, worker_id)
        .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn process_entries(
    db: &Db,
    worker_id: &str,
    job: &Job,
    parent: &str,
    settings: &ProcessingSettings,
    library: Arc<Library>,
    cache_root: &Path,
    shutdown: &CancellationToken,
    lease_lost: &CancellationToken,
) -> Result<(), PhotosError> {
    loop {
        check_control(shutdown, lease_lost)?;
        let entries = db.claim_media_batch(job, parent, worker_id).await?;
        if entries.is_empty() {
            break;
        }
        let mut entries = entries.into_iter();
        let mut running = FuturesUnordered::new();
        let mut unchanged = Vec::new();
        loop {
            while running.len() < settings.processing_concurrency {
                let Some(entry) = entries.next() else {
                    break;
                };
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
            if running.is_empty() {
                break;
            }
            if let Some(result) = running.next().await {
                match result {
                    Ok(Some(path)) => unchanged.push(path),
                    Ok(None) => {}
                    Err(error) => {
                        db.complete_unchanged_batch(job, unchanged, worker_id)
                            .await?;
                        return Err(error);
                    }
                }
            }
        }
        db.complete_unchanged_batch(job, unchanged, worker_id)
            .await?;
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
) -> Result<Option<String>, PhotosError> {
    check_lease(lease_lost)?;
    let source_result = library.open_media(Path::new(&entry.path));
    let (mut source, source_identity) = match source_result {
        Ok(value) => value,
        Err(error) if !error.retryable => {
            db.fail_entry(job, entry, &error, None, worker_id).await?;
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let sidecar_resolution = db.indexed_sidecar_for(&job.id, &entry.path).await?;
    let (sidecar_file, sidecar_path, sidecar_identity, sidecar_warning) = match sidecar_resolution {
        Ok(Some(path)) => {
            let (file, identity) = library.open_media(Path::new(&path))?;
            (Some(file), Some(path), Some(identity), None)
        }
        Ok(None) => (None, None, None, None),
        Err(warning) => (None, None, None, Some(warning)),
    };
    let current = db.current_asset(job, &entry.path).await?;
    let reusable = current.as_ref().filter(|asset| {
        asset.source == source_identity && asset.media.cached_identities(cache_root).is_some()
    });
    if let Some(asset) = reusable
        && asset.sidecar_path == sidecar_path
        && asset.sidecar == sidecar_identity
        && asset.metadata_version == METADATA_SCHEMA_VERSION
        && asset.sidecar_warning == sidecar_warning
    {
        verify_sources(
            library,
            entry,
            &source,
            source_identity,
            sidecar_file.as_ref(),
            sidecar_path.as_deref(),
            sidecar_identity,
        )?;
        return Ok(Some(entry.path.clone()));
    }
    // A decode scratch file and both derivatives can coexist until publication.
    let estimate = settings.max_intermediate_bytes.saturating_mul(3);
    let reservation = if reusable.is_none() {
        Some(
            db.reserve_space(
                job,
                &entry.path,
                CACHE_RESERVATION_SCOPE,
                estimate,
                cache_available_bytes(cache_root)?,
                settings.min_free_space_bytes,
                worker_id,
            )
            .await?,
        )
    } else {
        None
    };
    let result: Result<(), PhotosError> = async {
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
                PhotosError::new(ErrorCode::InvalidPath, "Media has no file name", false)
            })?;
        let mut processed = tokio::select! {
            _ = lease_lost.cancelled() => return Err(lease_lost_error()),
            result = process_media_reusing(
                &mut source,
                name,
                source_identity,
                sidecar,
                cache_root,
                settings,
                &runner,
                reusable.map(|asset| &asset.media),
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
        let asset_id = match &current { Some(asset) => asset.id.clone(), None => db.asset_id(job, &entry.path).await? };
        let record = PublishRecord {
            operation_id: Uuid::new_v4().to_string(),
            job_id: job.id.clone(),
            asset_id,
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
        if reusable.is_some() {
            db.complete_metadata_only(&record, worker_id).await?;
            return Ok(());
        }
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
            tracing::warn!(code = error.code.as_str(), message = %error.message, "Could not clean Photos publish temps");
        }
        Ok(())
    }
    .await;
    if let Some(reservation) = reservation {
        db.release_space(&reservation).await?;
    }
    match result {
        Ok(()) => Ok(None),
        Err(error) if error.retryable => Err(error),
        Err(error) => {
            let name = Path::new(&entry.path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("media");
            db.record_failed_asset(job, &entry.path, name, source_identity, &error, worker_id)
                .await?;
            db.fail_entry(job, entry, &error, None, worker_id).await?;
            Ok(None)
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
) -> Result<(), PhotosError> {
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
    data_root: &Path,
    record: &PublishRecord,
    require_mount: bool,
) -> Result<JournalSources, PhotosError> {
    let parent = Path::new(&record.path)
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let library = Library::resolve(data_root, &record.storage_pool_id, parent, require_mount)?;
    let (source, identity) = library.open_media(Path::new(&record.path))?;
    if identity != record.source_identity {
        return Err(PhotosError::new(
            ErrorCode::SourceChanged,
            "Journal source no longer matches its recorded identity",
            false,
        ));
    }
    let sidecar = match (&record.sidecar_path, record.sidecar_identity) {
        (Some(path), Some(expected)) => {
            let (file, current) = library.open_media(Path::new(path))?;
            if current != expected {
                return Err(PhotosError::new(
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
) -> Result<(), PhotosError> {
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

async fn recover_journals(
    db: &Db,
    data_root: &Path,
    cache_root: &Path,
    require_mount: bool,
) -> Result<(), PhotosError> {
    let (current, _) = db.settings().await?;
    for record in db.recoverable_journals().await? {
        if !current.as_ref().is_some_and(|settings| {
            settings.updated_at == record.library_updated_at
                && settings.storage_pool_id == record.storage_pool_id
        }) {
            db.abort_journal(&record.operation_id, false).await?;
            continue;
        }
        let cache_lock = CacheLock::shared(cache_root).await?;
        let sources = match open_journal_sources(data_root, &record, require_mount).await {
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
                        tracing::warn!(code = error.code.as_str(), message = %error.message, "Could not clean recovered Photos publish temps");
                    }
                }
            }
            Err(error) if error.code == ErrorCode::PhotosStorageUnavailable => {
                return Err(error);
            }
            Err(_) => db.abort_journal(&record.operation_id, true).await?,
        }
    }
    Ok(())
}

fn cache_available_bytes(cache_root: &Path) -> Result<u64, PhotosError> {
    std::fs::create_dir_all(cache_root).map_err(PhotosError::storage)?;
    let directory = File::open(cache_root).map_err(PhotosError::storage)?;
    let stats = fstatvfs(&directory).map_err(PhotosError::storage)?;
    #[cfg(target_os = "linux")]
    let blocks_available = stats.blocks_available();
    #[cfg(not(target_os = "linux"))]
    let blocks_available = u64::from(stats.blocks_available());
    Ok(blocks_available.saturating_mul(stats.fragment_size()))
}

fn verify_identity(file: &File, expected: FileIdentity) -> Result<(), PhotosError> {
    if FileIdentity::from_file(file)? != expected {
        return Err(PhotosError::new(
            ErrorCode::SourceChanged,
            "Media source changed during publication",
            false,
        ));
    }
    Ok(())
}

fn lease_lost_error() -> PhotosError {
    PhotosError::new(ErrorCode::Database, "Photos job lease was lost", true)
}

fn check_control(
    shutdown: &CancellationToken,
    lease_lost: &CancellationToken,
) -> Result<(), PhotosError> {
    if shutdown.is_cancelled() {
        return Err(PhotosError::new(
            ErrorCode::Internal,
            "Photos is stopping",
            true,
        ));
    }
    check_lease(lease_lost)
}

fn check_lease(lease_lost: &CancellationToken) -> Result<(), PhotosError> {
    if lease_lost.is_cancelled() {
        return Err(lease_lost_error());
    }
    Ok(())
}

#[allow(dead_code)]
fn _identity(identity: FileIdentity) -> FileIdentity {
    identity
}
