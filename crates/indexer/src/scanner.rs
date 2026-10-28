use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::stream::{FuturesUnordered, StreamExt};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::db::{Db, IndexedFileRecord, IndexerSettings, QueueTask, RunStats};
use crate::error::{ErrorCode, IndexerError};
use crate::extractor::extract_file;
use crate::storage::{EntryKind, MountIdentity, StoragePoolStorage, probe_mount_identity};

const IGNORED_DIRECTORIES: &[&str] = &[".git", ".cyberos", "node_modules", "dist", "coverage"];

#[derive(Debug)]
struct FileOutcome {
    indexed: bool,
    unchanged: bool,
    bytes: u64,
    text_file: bool,
    failure: Option<(String, String)>,
}

struct ScanContext<'a> {
    db: &'a Db,
    task: &'a QueueTask,
    settings: &'a IndexerSettings,
    storage: Arc<StoragePoolStorage>,
    initial_mount_identity: Option<&'a MountIdentity>,
    generation: Option<&'a str>,
    target_is_directory: bool,
    root_rebuild: bool,
    shutdown: &'a CancellationToken,
}

pub async fn run_task(
    db: &Db,
    task: &QueueTask,
    settings: &IndexerSettings,
    shutdown: &CancellationToken,
) -> Result<RunStats, IndexerError> {
    let storage = Arc::new(StoragePoolStorage::open(Path::new(
        &task.storage_pool_path,
    ))?);
    let mount_identity = mount_identity(task).await?;
    let target = Path::new(&task.path);
    let target_is_directory =
        ignored_ancestor(target).is_none() && storage.open_directory(target).is_ok();
    let generation = (task.recursive && target_is_directory).then(|| Uuid::new_v4().to_string());
    let root_rebuild = task.path == "." && task.recursive && target_is_directory;
    if let Some(generation) = &generation {
        db.begin_generation(
            &task.storage_pool_id,
            generation,
            mount_identity.as_ref(),
            root_rebuild,
        )
        .await?;
    }
    let run_id = db.start_run(&task.storage_pool_id, &task.kind).await?;
    let mut stats = RunStats::default();
    let result = scan(
        ScanContext {
            db,
            task,
            settings,
            storage: Arc::clone(&storage),
            initial_mount_identity: mount_identity.as_ref(),
            generation: generation.as_deref(),
            target_is_directory,
            root_rebuild,
            shutdown,
        },
        &mut stats,
    )
    .await;
    let completed = result.is_ok() && stats.failures.is_empty();
    db.finish_run(&run_id, &stats, completed).await?;
    result.map(|_| stats)
}

async fn scan(context: ScanContext<'_>, stats: &mut RunStats) -> Result<(), IndexerError> {
    let ScanContext {
        db,
        task,
        settings,
        storage,
        initial_mount_identity,
        generation,
        target_is_directory,
        root_rebuild,
        shutdown,
    } = context;
    let target = PathBuf::from(&task.path);
    if shutdown.is_cancelled() {
        return Err(IndexerError::new(
            ErrorCode::Internal,
            "Indexer is stopping",
            true,
        ));
    }
    if let Some(ignored) = ignored_ancestor(&target) {
        verify_source_unchanged(&storage, task, initial_mount_identity).await?;
        stats.skipped += 1;
        stats.removed += db
            .remove_path(&task.storage_pool_id, &ignored, true)
            .await?;
        return Ok(());
    }
    if !target_is_directory {
        match storage.open_file(&target) {
            Ok(_) => {
                let outcome = process_file(
                    db.clone(),
                    Arc::clone(&storage),
                    task.storage_pool_id.clone(),
                    task.path.clone(),
                    generation.map(str::to_owned),
                    settings.clone(),
                    Arc::new(Semaphore::new(settings.extraction_concurrency)),
                )
                .await;
                apply_outcome(stats, outcome);
                if !stats.failures.is_empty() {
                    return Err(IndexerError::new(
                        ErrorCode::StorageUnavailable,
                        "File indexing failed",
                        true,
                    ));
                }
                verify_source_unchanged(&storage, task, initial_mount_identity).await?;
                return Ok(());
            }
            Err(error) if is_missing(&error) => {
                verify_source_unchanged(&storage, task, initial_mount_identity).await?;
                stats.removed += db
                    .remove_path(&task.storage_pool_id, &task.path, task.recursive)
                    .await?;
                return Ok(());
            }
            Err(error) => return Err(error),
        }
    }

    let extraction = Arc::new(Semaphore::new(settings.extraction_concurrency));
    let mut directories = VecDeque::from([target.clone()]);
    let mut pending = FuturesUnordered::new();
    let mut traversal_complete = true;
    while let Some(directory) = directories.pop_front() {
        if shutdown.is_cancelled() {
            return Err(IndexerError::new(
                ErrorCode::Internal,
                "Indexer is stopping",
                true,
            ));
        }
        let entries = match storage.list_directory(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                traversal_complete = false;
                stats
                    .failures
                    .push((display_path(&directory), stable_reason(&error)));
                continue;
            }
        };
        for entry in entries {
            stats.scanned += 1;
            let path = if directory == Path::new(".") {
                PathBuf::from(&entry.name)
            } else {
                directory.join(&entry.name)
            };
            let relative = display_path(&path);
            match entry.kind {
                EntryKind::Symlink | EntryKind::Other => stats.skipped += 1,
                EntryKind::Directory => {
                    if IGNORED_DIRECTORIES.contains(&entry.name.as_str()) || !task.recursive {
                        stats.skipped += 1;
                    } else if storage.open_directory(&path).is_ok() {
                        directories.push_back(path);
                    } else {
                        traversal_complete = false;
                        stats
                            .failures
                            .push((relative, "path changed during traversal".to_owned()));
                    }
                }
                EntryKind::File => {
                    let future = process_file(
                        db.clone(),
                        Arc::clone(&storage),
                        task.storage_pool_id.clone(),
                        relative,
                        generation.map(str::to_owned),
                        settings.clone(),
                        Arc::clone(&extraction),
                    );
                    pending.push(future);
                    if pending.len() >= settings.scan_concurrency
                        && let Some(outcome) = pending.next().await
                    {
                        apply_outcome(stats, outcome);
                    }
                }
            }
        }
    }
    while let Some(outcome) = pending.next().await {
        apply_outcome(stats, outcome);
    }

    verify_source_unchanged(&storage, task, initial_mount_identity).await?;
    if !traversal_complete {
        return Err(IndexerError::new(
            ErrorCode::StorageUnavailable,
            "Directory traversal was incomplete; stale cleanup was skipped",
            true,
        ));
    }
    if !stats.failures.is_empty() {
        return Err(IndexerError::new(
            ErrorCode::StorageUnavailable,
            "One or more files failed",
            true,
        ));
    }
    if let Some(generation) = generation {
        stats.removed += db
            .cleanup_generation(&task.storage_pool_id, &task.path, generation, root_rebuild)
            .await?;
    }
    Ok(())
}

async fn verify_source_unchanged(
    storage: &StoragePoolStorage,
    task: &QueueTask,
    initial_mount_identity: Option<&MountIdentity>,
) -> Result<(), IndexerError> {
    storage.verify_unchanged()?;
    if mount_identity(task).await? != initial_mount_identity.cloned() {
        return Err(IndexerError::new(
            ErrorCode::SourceChanged,
            "mount identity changed during indexing",
            true,
        ));
    }
    Ok(())
}

fn ignored_ancestor(path: &Path) -> Option<String> {
    let mut prefix = PathBuf::new();
    for component in path.components() {
        let std::path::Component::Normal(name) = component else {
            continue;
        };
        prefix.push(name);
        if name
            .to_str()
            .is_some_and(|name| IGNORED_DIRECTORIES.contains(&name))
        {
            return Some(display_path(&prefix));
        }
    }
    None
}

pub(crate) fn is_ignored_path(path: &Path) -> bool {
    ignored_ancestor(path).is_some()
}

async fn mount_identity(task: &QueueTask) -> Result<Option<MountIdentity>, IndexerError> {
    probe_mount_identity(
        Path::new(&task.storage_pool_path),
        &task.mount_policy,
        task.expected_source.as_deref(),
        task.expected_uuid.as_deref(),
        task.expected_fstype.as_deref(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn process_file(
    db: Db,
    storage: Arc<StoragePoolStorage>,
    storage_pool_id: String,
    path: String,
    generation: Option<String>,
    settings: IndexerSettings,
    extraction: Arc<Semaphore>,
) -> FileOutcome {
    let result = async {
        let relative = Path::new(&path);
        let file = storage.open_file(relative)?;
        let identity = StoragePoolStorage::file_identity(&file)?;
        if let Some(existing) = db.existing_file(&storage_pool_id, &path).await?
            && existing.identity == Some(identity)
            && existing.has_content
        {
            verify_file_unchanged(&storage, relative, &file, identity)?;
            if let Some(generation) = &generation {
                db.touch_generation(&storage_pool_id, &path, generation)
                    .await?;
            }
            return Ok::<FileOutcome, IndexerError>(FileOutcome {
                indexed: false,
                unchanged: true,
                bytes: identity.size,
                text_file: false,
                failure: None,
            });
        }
        let identity_probe = file.try_clone().map_err(IndexerError::storage)?;
        let _permit = extraction
            .acquire()
            .await
            .map_err(|error| IndexerError::internal(error.to_string()))?;
        let name = relative
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| IndexerError::invalid_path("Indexer paths must be valid UTF-8"))?;
        let indexed_file = IndexedFileRecord {
            storage_pool_id: &storage_pool_id,
            path: &path,
            name,
            identity,
            scan_generation: generation.as_deref(),
        };
        let extracted = match extract_file(
            file,
            name,
            &settings,
            settings.ocr_storage_pool_ids.contains(&storage_pool_id),
        )
        .await
        {
            Ok(extracted) => extracted,
            Err(error) => {
                verify_file_unchanged(&storage, relative, &identity_probe, identity)?;
                db.record_extraction_error(indexed_file, &error).await?;
                return Ok(FileOutcome {
                    indexed: false,
                    unchanged: false,
                    bytes: identity.size,
                    text_file: false,
                    failure: Some((path.clone(), stable_reason(&error))),
                });
            }
        };
        verify_file_unchanged(&storage, relative, &identity_probe, identity)?;
        storage.verify_unchanged()?;
        let text_file = extracted.status == "ready";
        db.publish_file(indexed_file, extracted).await?;
        Ok(FileOutcome {
            indexed: true,
            unchanged: false,
            bytes: identity.size,
            text_file,
            failure: None,
        })
    }
    .await;
    match result {
        Ok(outcome) => outcome,
        Err(error) => FileOutcome {
            indexed: false,
            unchanged: false,
            bytes: 0,
            text_file: false,
            failure: Some((path, stable_reason(&error))),
        },
    }
}

fn verify_file_unchanged(
    storage: &StoragePoolStorage,
    relative: &Path,
    file: &std::fs::File,
    expected: crate::storage::FileIdentity,
) -> Result<(), IndexerError> {
    if StoragePoolStorage::file_identity(file)? != expected
        || storage.identity_for(relative)? != expected
    {
        return Err(IndexerError::new(
            ErrorCode::SourceChanged,
            "file changed during indexing",
            true,
        ));
    }
    Ok(())
}

fn apply_outcome(stats: &mut RunStats, outcome: FileOutcome) {
    stats.bytes = stats.bytes.saturating_add(outcome.bytes);
    stats.indexed += u64::from(outcome.indexed);
    stats.unchanged += u64::from(outcome.unchanged);
    stats.text_files += u64::from(outcome.text_file);
    if let Some(failure) = outcome.failure {
        stats.failed += 1;
        stats.failures.push(failure);
    }
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if value.is_empty() {
        ".".to_owned()
    } else {
        value
    }
}

fn is_missing(error: &IndexerError) -> bool {
    let lower = error.message.to_ascii_lowercase();
    lower.contains("no such file") || lower.contains("not found")
}

fn stable_reason(error: &IndexerError) -> String {
    match error.code {
        ErrorCode::PermissionDenied => "permission denied".to_owned(),
        ErrorCode::InvalidPath => "unsafe or symlink path".to_owned(),
        ErrorCode::SourceChanged => error.message.clone(),
        ErrorCode::SizeLimit => "extractor safety limit exceeded".to_owned(),
        ErrorCode::CommandTimeout => "extractor command timed out".to_owned(),
        _ => error.message.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignore_list_is_fixed() {
        assert!(IGNORED_DIRECTORIES.contains(&".git"));
        assert!(IGNORED_DIRECTORIES.contains(&".cyberos"));
        assert!(!IGNORED_DIRECTORIES.contains(&"documents"));
        assert_eq!(
            ignored_ancestor(Path::new("docs/.git/config")),
            Some("docs/.git".to_owned())
        );
        assert_eq!(ignored_ancestor(Path::new("docs/file.txt")), None);
        assert!(is_ignored_path(Path::new("docs/.cyberos/state.tar")));
        assert!(!is_ignored_path(Path::new("docs/file.txt")));
    }

    #[test]
    fn identity_shape_is_compared_in_full() {
        let first = crate::storage::FileIdentity {
            device: 1,
            inode: 2,
            size: 3,
            mtime_ns: 4,
            ctime_ns: 5,
        };
        let second = crate::storage::FileIdentity {
            ctime_ns: 6,
            ..first
        };
        assert_ne!(first, second);
    }
}
