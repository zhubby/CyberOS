use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sd_notify::NotifyState;
use tokio::sync::{Mutex, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::Config;
use crate::db::{Db, IndexerSettings, QueueTask, StoragePool};
use crate::error::{ErrorCode, IndexerError};
use crate::media::{MediaScanTask, run_media_scan};
use crate::music::{MusicScanTask, run_music_scan};
use crate::scanner::run_task;
use crate::watcher::{WatchMessage, merge_ancestor};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OnceOptions {
    pub storage_pool_id: Option<String>,
    pub path: Option<String>,
    pub recursive: bool,
}

#[derive(Clone)]
pub struct Indexer {
    db: Db,
    data_root: PathBuf,
    music_artwork_root: PathBuf,
    production: bool,
    worker_id: String,
    shutdown: CancellationToken,
}

impl Indexer {
    pub fn new(config: Config) -> Result<Self, IndexerError> {
        Ok(Self {
            db: Db::open(&config.database_path)?,
            music_artwork_root: config
                .database_path
                .parent()
                .unwrap_or(Path::new("."))
                .join("music/artwork"),
            data_root: config.data_root,
            production: config.production,
            worker_id: Uuid::new_v4().to_string(),
            shutdown: CancellationToken::new(),
        })
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    pub async fn run(self, once: Option<OnceOptions>) -> Result<(), IndexerError> {
        let _shutdown_guard = self.shutdown.clone().drop_guard();
        self.db.wait_for_schema(Duration::from_secs(60)).await?;
        let storage_pools = discover_storage_pools(&self.data_root, self.production)?;
        self.db.ensure_storage_pool_state(&storage_pools).await?;
        let settings = Arc::new(Mutex::new(self.db.settings().await?));
        if once.is_none() {
            self.db.heartbeat(&self.worker_id, VERSION).await?;
        }

        if let Some(options) = &once {
            self.enqueue_once(&storage_pools, options).await?;
        }

        let (watch_sender, watch_receiver) = mpsc::unbounded_channel();
        let watcher = if once.is_none() {
            match crate::watcher::start(&storage_pools, watch_sender) {
                Ok(watcher) => {
                    for storage_pool in &storage_pools {
                        self.db
                            .set_watcher_status(&storage_pool.id, "ready", None)
                            .await?;
                    }
                    Some(watcher)
                }
                Err(error) => {
                    for storage_pool in &storage_pools {
                        self.db
                            .set_watcher_status(&storage_pool.id, "degraded", Some(&error.message))
                            .await?;
                        self.db
                            .enqueue(&storage_pool.id, ".", true, "full", 10)
                            .await?;
                    }
                    None
                }
            }
        } else {
            None
        };

        let watch_task = if once.is_none() {
            Some(tokio::spawn(watch_loop(
                self.db.clone(),
                watch_receiver,
                self.shutdown.clone(),
            )))
        } else {
            None
        };

        let heartbeat = once.is_none().then(|| {
            tokio::spawn(heartbeat_loop(
                self.db.clone(),
                self.worker_id.clone(),
                self.shutdown.clone(),
            ))
        });
        let watchdog = once
            .is_none()
            .then(|| tokio::spawn(watchdog_loop(self.shutdown.clone())));
        let catalog = once.is_none().then(|| {
            let worker = self.clone();
            let pools = storage_pools.clone();
            tokio::spawn(async move {
                let result = worker.run_catalog_queue(&pools).await;
                if let Err(error) = &result {
                    tracing::error!(%error, "Catalog queue stopped");
                    worker.shutdown.cancel();
                }
                result
            })
        });
        if once.is_none() {
            let _ = sd_notify::notify(&[NotifyState::Ready]);
        }
        tracing::info!(worker_id = %self.worker_id, "Indexer ready");

        let mut poll = tokio::time::interval(Duration::from_millis(250));
        poll.tick().await;
        let mut settings_refresh = tokio::time::interval(Duration::from_secs(5));
        settings_refresh.tick().await;
        let mut idle_polls = 0_u8;
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => break,
                _ = settings_refresh.tick() => {
                    let next = self.db.settings().await?;
                    *settings.lock().await = next;
                }
                _ = poll.tick() => {
                    let snapshot = settings.lock().await.clone();
                    if once.is_none() {
                        self.db.ensure_reconciliation_tasks(Duration::from_millis(snapshot.reconciliation_interval_ms)).await?;
                        self.db.reconcile_music(Duration::from_millis(snapshot.reconciliation_interval_ms)).await?;
                    }
                    match self.db.claim(&self.worker_id, &storage_pools).await? {
                        Some(task) => {
                            idle_polls = 0;
                            self.process_task(task, &snapshot).await?;
                        }
                        None if once.is_some() && let Some(task) = self.db.claim_media_scan(&self.worker_id, &storage_pools).await? => {
                            idle_polls = 0;
                            self.process_media_scan(task).await?;
                        }
                        None if once.is_some() && let Some(task) = self.db.claim_music_scan(&self.worker_id, &storage_pools).await? => {
                            idle_polls = 0;
                            self.process_music_scan(task).await?;
                        }
                        None if once.is_some() => {
                            idle_polls = idle_polls.saturating_add(1);
                            if idle_polls >= 2 { break; }
                        }
                        None => {}
                    }
                }
            }
        }

        if once.is_none() {
            let _ = sd_notify::notify(&[NotifyState::Stopping]);
        }
        self.shutdown.cancel();
        drop(watcher);
        if let Some(task) = watch_task {
            let _ = task.await;
        }
        let catalog_result = match catalog {
            Some(task) => task
                .await
                .map_err(|error| IndexerError::internal(error.to_string()))?,
            None => Ok(()),
        };
        if let Some(heartbeat) = heartbeat {
            let _ = heartbeat.await;
            self.db.release_worker(&self.worker_id).await?;
        }
        if let Some(watchdog) = watchdog {
            let _ = watchdog.await;
        }
        catalog_result
    }

    // Catalog scans must progress even while ordinary indexing hashes large files.
    async fn run_catalog_queue(&self, pools: &[StoragePool]) -> Result<(), IndexerError> {
        let mut poll = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => return Ok(()),
                _ = poll.tick() => {
                    if let Some(task) = self.db.claim_media_scan(&self.worker_id, pools).await? {
                        self.process_media_scan(task).await?;
                    } else if let Some(task) = self.db.claim_music_scan(&self.worker_id, pools).await? {
                        self.process_music_scan(task).await?;
                    }
                }
            }
        }
    }

    async fn enqueue_once(
        &self,
        storage_pools: &[StoragePool],
        options: &OnceOptions,
    ) -> Result<(), IndexerError> {
        let selected: Vec<_> = match &options.storage_pool_id {
            Some(storage_pool_id) => {
                let storage_pool = storage_pools
                    .iter()
                    .find(|storage_pool| storage_pool.id == *storage_pool_id)
                    .ok_or_else(|| {
                        IndexerError::new(
                            ErrorCode::InvalidPath,
                            format!("Unknown storage pool: {storage_pool_id}"),
                            false,
                        )
                    })?;
                vec![storage_pool]
            }
            None => storage_pools.iter().collect(),
        };
        for storage_pool in selected {
            let path = normalize_cli_path(options.path.as_deref().unwrap_or("."))?;
            self.db
                .enqueue(
                    &storage_pool.id,
                    &path,
                    options.recursive || path == ".",
                    "manual",
                    100,
                )
                .await?;
        }
        Ok(())
    }

    async fn process_task(
        &self,
        task: QueueTask,
        settings: &IndexerSettings,
    ) -> Result<(), IndexerError> {
        let lease_stop = CancellationToken::new();
        let lease_lost = CancellationToken::new();
        let lease_task = {
            let db = self.db.clone();
            let task_id = task.id.clone();
            let worker_id = self.worker_id.clone();
            let stop = lease_stop.clone();
            let lost = lease_lost.clone();
            let generation = task.generation;
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(5));
                interval.tick().await;
                loop {
                    tokio::select! {
                        _ = stop.cancelled() => break,
                        _ = interval.tick() => match db.renew_lease(&task_id, generation, &worker_id).await {
                            Ok(true) => {}
                            _ => { lost.cancel(); break; }
                        }
                    }
                }
            })
        };
        let result = tokio::select! {
            _ = self.shutdown.cancelled() => Err(IndexerError::new(ErrorCode::Internal, "Indexer is stopping", true)),
            _ = lease_lost.cancelled() => Err(IndexerError::new(ErrorCode::Database, "Indexer queue lease was lost", true)),
            result = run_task(&self.db, &task, settings, &self.shutdown) => result.map(|_| ()),
        };
        lease_stop.cancel();
        let _ = lease_task.await;
        match result {
            Ok(()) => {
                self.db.complete_task(&task, &self.worker_id).await?;
                self.db
                    .enqueue_music_changes(&task.storage_pool_id, &task.path)
                    .await?;
                Ok(())
            }
            Err(error) => {
                self.db
                    .retry_or_fail(&task, &self.worker_id, &error)
                    .await?;
                tracing::warn!(task_id = %task.id, code = error.code.as_str(), message = %error.message, "Indexer task failed");
                Ok(())
            }
        }
    }

    async fn process_music_scan(&self, task: MusicScanTask) -> Result<(), IndexerError> {
        if let Err(error) = run_music_scan(
            &self.db,
            &task,
            &self.worker_id,
            &self.music_artwork_root,
            &self.shutdown,
        )
        .await
        {
            self.db
                .fail_music_scan(&task, &self.worker_id, &error)
                .await?;
            tracing::warn!(scan_id=%task.id,code=error.code.as_str(),message=%error.message,"Music scan failed");
        }
        Ok(())
    }

    async fn process_media_scan(&self, task: MediaScanTask) -> Result<(), IndexerError> {
        let result = run_media_scan(&self.db, &task, &self.worker_id, &self.shutdown).await;
        if let Err(error) = result {
            self.db
                .fail_media_scan(&task.id, &self.worker_id, &error)
                .await?;
            tracing::warn!(
                scan_id = %task.id,
                source_id = %task.source_id,
                code = error.code.as_str(),
                message = %error.message,
                "Media scan failed"
            );
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
                Err(error) => tracing::warn!(code = error.code.as_str(), message = %error.message, "Indexer heartbeat failed"),
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

async fn watch_loop(
    db: Db,
    mut receiver: mpsc::UnboundedReceiver<WatchMessage>,
    shutdown: CancellationToken,
) {
    let mut pending: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut debounce = tokio::time::interval(Duration::from_millis(750));
    debounce.tick().await;
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            message = receiver.recv() => match message {
                Some(WatchMessage::Changed { storage_pool_id, path }) => {
                    merge_ancestor(pending.entry(storage_pool_id).or_default(), path);
                }
                Some(WatchMessage::Degraded { storage_pool_ids, reason }) => {
                    for storage_pool_id in storage_pool_ids {
                        if let Err(error) = db.set_watcher_status(&storage_pool_id, "degraded", Some(&reason)).await {
                            tracing::warn!(message = %error.message, "Could not persist watcher degradation");
                        }
                        let _ = db.enqueue(&storage_pool_id, ".", true, "full", 10).await;
                        let _ = db.enqueue_music_changes(&storage_pool_id, ".").await;
                    }
                }
                None => break,
            },
            _ = debounce.tick() => {
                let events = std::mem::take(&mut pending);
                for (storage_pool_id, paths) in events {
                    for path in paths {
                        let _ = db.enqueue_music_changes(&storage_pool_id, &path).await;
                        if let Err(error) = db.enqueue(&storage_pool_id, &path, true, "incremental", 50).await {
                            tracing::warn!(storage_pool_id = %storage_pool_id, path = %path, message = %error.message, "Could not enqueue filesystem event");
                        }
                    }
                }
            }
        }
    }
}

fn normalize_cli_path(value: &str) -> Result<String, IndexerError> {
    if value.is_empty() {
        return Err(IndexerError::invalid_path("--path must not be empty"));
    }
    let normalized_separators = value.replace('\\', "/");
    let path = Path::new(&normalized_separators);
    if path.is_absolute() {
        return Err(IndexerError::invalid_path(
            "--path must stay inside the selected storage pool",
        ));
    }
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(segment) => segments.push(segment.to_string_lossy()),
            _ => {
                return Err(IndexerError::invalid_path(
                    "--path must stay inside the selected storage pool",
                ));
            }
        }
    }
    Ok(if segments.is_empty() {
        ".".to_owned()
    } else {
        segments.join("/")
    })
}

fn discover_storage_pools(
    data_root: &Path,
    production: bool,
) -> Result<Vec<StoragePool>, IndexerError> {
    let canonical_data_root = std::fs::canonicalize(data_root).map_err(IndexerError::storage)?;
    let entries = std::fs::read_dir(&canonical_data_root).map_err(IndexerError::storage)?;
    let mut storage_pools = Vec::new();
    for entry in entries {
        let entry = entry.map_err(IndexerError::storage)?;
        let file_type = entry.file_type().map_err(IndexerError::storage)?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let id = entry
            .file_name()
            .into_string()
            .map_err(|_| IndexerError::invalid_path("Storage pool IDs must be valid UTF-8"))?;
        if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
            continue;
        }
        let path = std::fs::canonicalize(entry.path()).map_err(IndexerError::storage)?;
        if path.parent() != Some(canonical_data_root.as_path()) {
            continue;
        }
        let path = path
            .to_str()
            .ok_or_else(|| IndexerError::invalid_path("Storage pool paths must be valid UTF-8"))?;
        storage_pools.push(StoragePool {
            id,
            path: path.to_owned(),
            mount_policy: if production { "required" } else { "optional" }.to_owned(),
            expected_source: None,
            expected_uuid: None,
            expected_fstype: None,
        });
    }
    storage_pools.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(storage_pools)
}

#[cfg(test)]
mod tests {
    use super::normalize_cli_path;

    #[allow(dead_code)]
    mod common {
        use crate as cyberos_indexer;
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/common/mod.rs"));
    }

    #[tokio::test]
    async fn media_catalog_queue_runs_while_a_file_index_task_is_still_running() {
        use super::*;
        use rusqlite::Connection;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        std::fs::create_dir_all(root.join("Movies")).unwrap();
        std::fs::write(root.join("Movies/Arrival.2016.mkv"), b"video").unwrap();
        let database = directory.path().join("cyberos.sqlite");
        common::create_schema(&database, &root);
        let db = Db::open(&database).unwrap();
        let pools = vec![common::storage_pool(&root)];
        db.enqueue("local", "large-video.mkv", false, "manual", 100)
            .await
            .unwrap();
        let generic = db.claim("worker", &pools).await.unwrap().unwrap();
        let connection = Connection::open(&database).unwrap();
        connection.execute_batch("INSERT INTO media_sources (id, name, kind, storage_pool_id, path, enabled, created_at, updated_at) VALUES ('movies', 'Movies', 'movie', 'local', 'Movies', 1, 'now', 'now');
            INSERT INTO media_scan_runs (id, source_id, status, generation, created_at, updated_at) VALUES ('media', 'movies', 'queued', 'generation', 'now', 'now');").unwrap();
        let worker = Indexer {
            db,
            data_root: root,
            music_artwork_root: directory.path().join("artwork"),
            production: false,
            worker_id: "worker".to_owned(),
            shutdown: CancellationToken::new(),
        };
        let shutdown = worker.shutdown.clone();
        let task = tokio::spawn(async move { worker.run_catalog_queue(&pools).await });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status: String = connection
                    .query_row(
                        "SELECT status FROM media_scan_runs WHERE id = 'media'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                if status == "completed" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
        let status: String = connection
            .query_row(
                "SELECT status FROM index_queue WHERE id = ?",
                [&generic.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "running");
        let titles: i64 = connection
            .query_row("SELECT count(*) FROM media_titles", [], |row| row.get(0))
            .unwrap();
        assert_eq!(titles, 1);
        shutdown.cancel();
        task.await.unwrap().unwrap();
    }

    #[test]
    fn cli_paths_are_canonical_relative_paths() {
        assert_eq!(normalize_cli_path("docs/").unwrap(), "docs");
        assert_eq!(normalize_cli_path("docs/./sub").unwrap(), "docs/sub");
        assert_eq!(normalize_cli_path(r"docs\sub").unwrap(), "docs/sub");
        assert_eq!(normalize_cli_path(".").unwrap(), ".");
        assert!(normalize_cli_path("").is_err());
        assert!(normalize_cli_path("../outside").is_err());
        assert!(normalize_cli_path("/outside").is_err());
    }
}
