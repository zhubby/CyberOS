use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use nix::fcntl::{RenameFlags, renameat2};

use crate::db::PublishRecord;
use crate::error::{ErrorCode, PhotostaffError};
use crate::storage::FileIdentity;

pub struct CacheLock {
    file: File,
}

impl CacheLock {
    pub async fn shared(cache_root: &Path) -> Result<Self, PhotostaffError> {
        Self::acquire_async(cache_root, nix::libc::LOCK_SH).await
    }

    pub async fn exclusive(cache_root: &Path) -> Result<Self, PhotostaffError> {
        Self::acquire_async(cache_root, nix::libc::LOCK_EX).await
    }

    async fn acquire_async(cache_root: &Path, operation: i32) -> Result<Self, PhotostaffError> {
        let cache_root = cache_root.to_owned();
        tokio::task::spawn_blocking(move || Self::acquire(&cache_root, operation))
            .await
            .map_err(|error| PhotostaffError::internal(error.to_string()))?
    }

    fn acquire(cache_root: &Path, operation: i32) -> Result<Self, PhotostaffError> {
        std::fs::create_dir_all(cache_root).map_err(PhotostaffError::storage)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(cache_root.join(".cache.lock"))
            .map_err(PhotostaffError::storage)?;
        if unsafe { nix::libc::flock(file.as_raw_fd(), operation) } != 0 {
            return Err(PhotostaffError::storage(std::io::Error::last_os_error()));
        }
        Ok(Self { file })
    }

    pub async fn run_blocking<T, F>(self, operation: F) -> Result<(Self, T), PhotostaffError>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, PhotostaffError> + Send + 'static,
    {
        let (cache_lock, result) = tokio::task::spawn_blocking(move || {
            let result = operation();
            (self, result)
        })
        .await
        .map_err(|error| PhotostaffError::internal(error.to_string()))?;
        result.map(|value| (cache_lock, value))
    }
}

impl Drop for CacheLock {
    fn drop(&mut self) {
        let _ = unsafe { nix::libc::flock(self.file.as_raw_fd(), nix::libc::LOCK_UN) };
    }
}

pub fn publish_derivatives(
    record: &PublishRecord,
    cache_root: &Path,
) -> Result<(), PhotostaffError> {
    publish_one(
        &record.processed.thumbnail_temp_path,
        &record.processed.thumbnail_path,
        record.processed.thumbnail_identity,
        cache_root,
    )?;
    publish_one(
        &record.processed.preview_temp_path,
        &record.processed.preview_path,
        record.processed.preview_identity,
        cache_root,
    )
}

pub fn derivatives_published(record: &PublishRecord, cache_root: &Path) -> bool {
    target_matches(
        &record.processed.thumbnail_path,
        record.processed.thumbnail_identity,
        cache_root,
    ) && target_matches(
        &record.processed.preview_path,
        record.processed.preview_identity,
        cache_root,
    )
}

fn publish_one(
    source: &Path,
    target: &Path,
    expected: FileIdentity,
    cache_root: &Path,
) -> Result<(), PhotostaffError> {
    validate_cache_path(source, cache_root)?;
    validate_cache_path(target, cache_root)?;
    if target.exists() {
        if target_matches(target, expected, cache_root) {
            match std::fs::remove_file(source) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(PhotostaffError::storage(error)),
            }
            return Ok(());
        }
        if files_equal(source, target)? {
            return Ok(());
        }
        return Err(PhotostaffError::new(
            ErrorCode::PublishConflict,
            "Photostaff derivative target conflicts with journal identity",
            false,
        ));
    }
    let source_file = open_regular_nofollow(source)?;
    if FileIdentity::from_file(&source_file)? != expected {
        return Err(PhotostaffError::new(
            ErrorCode::SourceChanged,
            "Photostaff derivative changed before publication",
            false,
        ));
    }
    source_file.sync_all().map_err(PhotostaffError::storage)?;
    rename_no_replace(source, target)?;
    sync_parent(target)?;
    if !target_matches(target, expected, cache_root) {
        return Err(PhotostaffError::new(
            ErrorCode::SourceChanged,
            "Published Photostaff derivative identity changed",
            false,
        ));
    }
    Ok(())
}

pub fn cleanup_publish_temps(record: &PublishRecord) {
    for path in [
        &record.processed.thumbnail_temp_path,
        &record.processed.preview_temp_path,
    ] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "Could not remove Photostaff publish temp")
            }
        }
    }
}

pub fn cleanup_orphan_temps(
    cache_root: &Path,
    active_journals: &[PublishRecord],
) -> Result<(), PhotostaffError> {
    let preserved = active_journals
        .iter()
        .flat_map(|record| {
            [
                record.processed.thumbnail_temp_path.as_path(),
                record.processed.preview_temp_path.as_path(),
            ]
        })
        .map(Path::to_path_buf)
        .collect::<HashSet<_>>();
    cleanup_orphan_paths(cache_root, &preserved)
}

pub fn cleanup_orphan_derivatives(
    cache_root: &Path,
    active_keys: &HashSet<String>,
    active_journals: &[PublishRecord],
) -> Result<(), PhotostaffError> {
    let preserved = active_journals
        .iter()
        .flat_map(|record| {
            [
                record.processed.thumbnail_path.as_path(),
                record.processed.preview_path.as_path(),
            ]
        })
        .map(Path::to_path_buf)
        .collect::<HashSet<_>>();
    for purpose in ["thumbnail", "preview"] {
        let directory = cache_root.join(purpose);
        cleanup_directory(&directory, &preserved, |file_name| {
            file_name.ends_with(".webp") && !active_keys.contains(&format!("{purpose}/{file_name}"))
        })?;
    }
    Ok(())
}

fn cleanup_orphan_paths(
    cache_root: &Path,
    preserved: &HashSet<PathBuf>,
) -> Result<(), PhotostaffError> {
    cleanup_directory(&cache_root.join("scratch"), preserved, |_| true)?;
    for name in ["thumbnail", "preview"] {
        cleanup_directory(&cache_root.join(name), preserved, |file_name| {
            file_name.starts_with('.') && file_name.ends_with(".tmp")
        })?;
    }
    Ok(())
}

fn cleanup_directory(
    directory: &Path,
    preserved: &HashSet<PathBuf>,
    should_remove: impl Fn(&str) -> bool,
) -> Result<(), PhotostaffError> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(PhotostaffError::storage(error)),
    };
    let mut changed = false;
    for entry in entries {
        let entry = entry.map_err(PhotostaffError::storage)?;
        let path = entry.path();
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let file_type = entry.file_type().map_err(PhotostaffError::storage)?;
        if preserved.contains(&path)
            || !should_remove(file_name)
            || !(file_type.is_file() || file_type.is_symlink())
        {
            continue;
        }
        std::fs::remove_file(&path).map_err(PhotostaffError::storage)?;
        changed = true;
    }
    if changed {
        open_directory(directory)?
            .sync_all()
            .map_err(PhotostaffError::storage)?;
    }
    Ok(())
}

fn target_matches(path: &Path, expected: FileIdentity, cache_root: &Path) -> bool {
    if validate_cache_path(path, cache_root).is_err() {
        return false;
    }
    open_regular_nofollow(path)
        .ok()
        .and_then(|file| FileIdentity::from_file(&file).ok())
        == Some(expected)
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, PhotostaffError> {
    let mut left = open_regular_nofollow(left)?;
    let mut right = match open_regular_nofollow(right) {
        Ok(file) => file,
        Err(_) => return Ok(false),
    };
    if left.metadata().map_err(PhotostaffError::storage)?.len()
        != right.metadata().map_err(PhotostaffError::storage)?.len()
    {
        return Ok(false);
    }
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let left_read = left
            .read(&mut left_buffer)
            .map_err(PhotostaffError::storage)?;
        let right_read = right
            .read(&mut right_buffer)
            .map_err(PhotostaffError::storage)?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn open_regular_nofollow(path: &Path) -> Result<File, PhotostaffError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(PhotostaffError::storage)?;
    FileIdentity::from_file(&file)?;
    Ok(file)
}

fn validate_cache_path(path: &Path, cache_root: &Path) -> Result<(), PhotostaffError> {
    let parent = path.parent().ok_or_else(|| {
        PhotostaffError::new(ErrorCode::InvalidPath, "Derivative has no parent", false)
    })?;
    let root = std::fs::canonicalize(cache_root).map_err(PhotostaffError::storage)?;
    let parent = std::fs::canonicalize(parent).map_err(PhotostaffError::storage)?;
    if !parent.starts_with(&root) || path.file_name().is_none() {
        return Err(PhotostaffError::new(
            ErrorCode::InvalidPath,
            "Derivative path escapes the Photostaff cache",
            false,
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn rename_no_replace(source: &Path, target: &Path) -> Result<(), PhotostaffError> {
    let source_parent = open_directory(source.parent().unwrap())?;
    let target_parent = open_directory(target.parent().unwrap())?;
    renameat2(
        &source_parent,
        Path::new(source.file_name().unwrap()),
        &target_parent,
        Path::new(target.file_name().unwrap()),
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|error| {
        if error == nix::errno::Errno::EEXIST {
            PhotostaffError::new(
                ErrorCode::PublishConflict,
                "Photostaff derivative already exists",
                false,
            )
        } else {
            PhotostaffError::storage(error)
        }
    })
}

#[cfg(not(target_os = "linux"))]
fn rename_no_replace(source: &Path, target: &Path) -> Result<(), PhotostaffError> {
    std::fs::hard_link(source, target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            PhotostaffError::new(
                ErrorCode::PublishConflict,
                "Photostaff derivative already exists",
                false,
            )
        } else {
            PhotostaffError::storage(error)
        }
    })?;
    std::fs::remove_file(source).map_err(PhotostaffError::storage)
}

fn open_directory(path: &Path) -> Result<File, PhotostaffError> {
    OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(PhotostaffError::storage)
}

fn sync_parent(path: &Path) -> Result<(), PhotostaffError> {
    open_directory(
        path.parent()
            .ok_or_else(|| PhotostaffError::internal("Derivative has no parent"))?,
    )?
    .sync_all()
    .map_err(PhotostaffError::storage)
}

#[allow(dead_code)]
fn _path(path: PathBuf) -> PathBuf {
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn publishes_without_replacing_an_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("photostaff");
        let derivatives = cache.join("thumbnail");
        std::fs::create_dir_all(&derivatives).unwrap();
        let source = derivatives.join(".source.tmp");
        let target = derivatives.join("target.webp");
        std::fs::write(&source, b"new").unwrap();
        std::fs::write(&target, b"user").unwrap();
        let identity = FileIdentity::from_file(&File::open(&source).unwrap()).unwrap();
        assert!(publish_one(&source, &target, identity, &cache).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"user");
    }

    #[test]
    fn reuses_an_identical_derivative_without_replacing_it() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("photostaff");
        let derivatives = cache.join("thumbnail");
        std::fs::create_dir_all(&derivatives).unwrap();
        let source = derivatives.join(".source.tmp");
        let target = derivatives.join("target.webp");
        std::fs::write(&source, b"same bytes").unwrap();
        std::fs::write(&target, b"same bytes").unwrap();
        let target_identity = FileIdentity::from_file(&File::open(&target).unwrap()).unwrap();
        let source_identity = FileIdentity::from_file(&File::open(&source).unwrap()).unwrap();

        publish_one(&source, &target, source_identity, &cache).unwrap();

        assert!(source.exists());
        assert_eq!(
            FileIdentity::from_file(&File::open(&target).unwrap()).unwrap(),
            target_identity
        );
    }

    #[test]
    fn refuses_a_symlinked_existing_derivative() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("photostaff");
        let derivatives = cache.join("thumbnail");
        std::fs::create_dir_all(&derivatives).unwrap();
        let source = derivatives.join(".source.tmp");
        let target = derivatives.join("target.webp");
        let outside = directory.path().join("outside.webp");
        std::fs::write(&source, b"same bytes").unwrap();
        std::fs::write(&outside, b"same bytes").unwrap();
        symlink(&outside, &target).unwrap();
        let source_identity = FileIdentity::from_file(&File::open(&source).unwrap()).unwrap();

        assert!(publish_one(&source, &target, source_identity, &cache).is_err());
        assert_eq!(std::fs::read(outside).unwrap(), b"same bytes");
    }

    #[test]
    fn removes_only_unjournaled_temporary_files() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("photostaff");
        let thumbnail = cache.join("thumbnail");
        let preview = cache.join("preview");
        let scratch = cache.join("scratch");
        for path in [&thumbnail, &preview, &scratch] {
            std::fs::create_dir_all(path).unwrap();
        }
        let orphan_thumbnail = thumbnail.join(".orphan.tmp");
        let preserved_thumbnail = thumbnail.join(".preserved.tmp");
        let published_thumbnail = thumbnail.join("published.webp");
        let orphan_preview = preview.join(".orphan.tmp");
        let scratch_file = scratch.join("intermediate.jpg");
        for path in [
            &orphan_thumbnail,
            &preserved_thumbnail,
            &published_thumbnail,
            &orphan_preview,
            &scratch_file,
        ] {
            std::fs::write(path, b"data").unwrap();
        }
        let preserved = HashSet::from([preserved_thumbnail.clone()]);

        cleanup_orphan_paths(&cache, &preserved).unwrap();

        assert!(!orphan_thumbnail.exists());
        assert!(!orphan_preview.exists());
        assert!(!scratch_file.exists());
        assert!(preserved_thumbnail.exists());
        assert!(published_thumbnail.exists());
    }

    #[test]
    fn removes_only_unreferenced_published_derivatives() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("photostaff");
        let thumbnail = cache.join("thumbnail");
        let preview = cache.join("preview");
        std::fs::create_dir_all(&thumbnail).unwrap();
        std::fs::create_dir_all(&preview).unwrap();
        let active = thumbnail.join("active.webp");
        let orphan = thumbnail.join("orphan.webp");
        let unrelated = preview.join("keep.txt");
        for path in [&active, &orphan, &unrelated] {
            std::fs::write(path, b"data").unwrap();
        }

        cleanup_orphan_derivatives(
            &cache,
            &HashSet::from(["thumbnail/active.webp".to_owned()]),
            &[],
        )
        .unwrap();

        assert!(active.exists());
        assert!(!orphan.exists());
        assert!(unrelated.exists());
    }

    #[tokio::test]
    async fn exclusive_cleanup_waits_for_active_publication_lock() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("photostaff");
        let publication = CacheLock::shared(&cache).await.unwrap();
        let cleanup_cache = cache.clone();
        let cleanup =
            tokio::spawn(async move { CacheLock::exclusive(&cleanup_cache).await.unwrap() });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!cleanup.is_finished());
        drop(publication);

        let cleanup_lock = tokio::time::timeout(Duration::from_secs(1), cleanup)
            .await
            .unwrap()
            .unwrap();
        drop(cleanup_lock);
    }

    #[tokio::test]
    async fn publication_waits_for_exclusive_cleanup_lock() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("photostaff");
        let cleanup = CacheLock::exclusive(&cache).await.unwrap();
        let publication_cache = cache.clone();
        let publication =
            tokio::spawn(async move { CacheLock::shared(&publication_cache).await.unwrap() });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!publication.is_finished());
        drop(cleanup);

        let publication_lock = tokio::time::timeout(Duration::from_secs(1), publication)
            .await
            .unwrap()
            .unwrap();
        drop(publication_lock);
    }
}
