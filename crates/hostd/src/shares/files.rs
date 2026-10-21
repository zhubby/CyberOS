use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::error::HostdError;

use super::validation::{normalize_path, path_inside};

pub(super) async fn write_managed_file(
    path: &Path,
    content: &str,
    roots: &[PathBuf],
    mode: u32,
) -> Result<(), HostdError> {
    let path = normalize_path(path);
    if !roots
        .iter()
        .map(|root| normalize_path(root))
        .any(|root| path_inside(&root, &path))
    {
        return Err(HostdError::validation(format!(
            "Managed path is not allowed: {}",
            path.display()
        )));
    }
    let parent = path
        .parent()
        .ok_or_else(|| HostdError::validation("Managed path has no parent"))?;
    fs::create_dir_all(parent).await?;
    replace_file(&path, content.as_bytes(), mode).await
}

async fn replace_file(path: &Path, content: &[u8], mode: u32) -> Result<(), HostdError> {
    let parent = path
        .parent()
        .ok_or_else(|| HostdError::validation("Managed path has no parent"))?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("hostd"),
        Uuid::new_v4()
    ));
    let result = async {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temp)
            .await?;
        file.write_all(content).await?;
        file.flush().await?;
        file.set_permissions(std::fs::Permissions::from_mode(mode))
            .await?;
        file.sync_all().await?;
        drop(file);
        fs::rename(&temp, path).await?;
        sync_parent(path).await?;
        Ok::<(), HostdError>(())
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temp).await;
    }
    result
}

pub(super) struct FileSnapshot {
    path: PathBuf,
    content: Option<Vec<u8>>,
    mode: u32,
}

pub(super) async fn snapshot_files<'a>(
    paths: impl Iterator<Item = &'a Path>,
) -> Result<Vec<FileSnapshot>, HostdError> {
    let mut snapshot = Vec::new();
    for path in paths {
        let content = match fs::read(path).await {
            Ok(content) => Some(content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let mode = if content.is_some() {
            fs::metadata(path).await?.permissions().mode() & 0o777
        } else {
            0o640
        };
        snapshot.push(FileSnapshot {
            path: path.to_owned(),
            content,
            mode,
        });
    }
    Ok(snapshot)
}

pub(super) async fn restore_files(snapshot: &[FileSnapshot]) {
    for FileSnapshot {
        path,
        content,
        mode,
    } in snapshot
    {
        match content {
            Some(content) => {
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent).await;
                }
                let _ = replace_file(path, content, *mode).await;
            }
            None => {
                if fs::remove_file(path).await.is_ok() {
                    let _ = sync_parent(path).await;
                }
            }
        }
    }
}

async fn sync_parent(path: &Path) -> Result<(), HostdError> {
    let parent = path
        .parent()
        .ok_or_else(|| HostdError::validation("Managed path has no parent"))?;
    fs::File::open(parent).await?.sync_all().await?;
    Ok(())
}
