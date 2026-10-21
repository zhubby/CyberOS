use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use nix::unistd::{Gid, Uid, chown};
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::error::HostdError;

use super::model::RecoveryState;
use super::validation::{is_uuid, valid_device};

pub(super) async fn read_recovery_state(path: &Path) -> Result<RecoveryState, HostdError> {
    let content = match fs::read(path.join("state.json")).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecoveryState::new());
        }
        Err(error) => return Err(error.into()),
    };
    let state: RecoveryState = serde_json::from_slice(&content)
        .map_err(|_| HostdError::validation("Hotspot recovery state is invalid"))?;
    Ok(state
        .into_iter()
        .filter(|(device, entry)| {
            valid_device(device)
                && entry.restore_profile_id.as_deref().is_none_or(is_uuid)
                && is_uuid(&entry.hotspot_profile_id)
        })
        .collect())
}

pub(super) async fn write_recovery_state(
    path: &Path,
    state: &RecoveryState,
) -> Result<(), HostdError> {
    fs::create_dir_all(path).await?;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    let mut content = serde_json::to_vec(state)
        .map_err(|error| HostdError::operation_failed(error.to_string()))?;
    content.push(b'\n');
    atomic_write(&path.join("state.json"), &content, 0o600, || async {
        Ok(())
    })
    .await
}

pub(super) async fn atomic_write<F, Fut>(
    path: &Path,
    content: &[u8],
    mode: u32,
    before_rename: F,
) -> Result<(), HostdError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), HostdError>>,
{
    let parent = path
        .parent()
        .ok_or_else(|| HostdError::validation("Managed profile has no parent"))?;
    fs::create_dir_all(parent).await?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("profile"),
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
        file.set_permissions(std::fs::Permissions::from_mode(mode))
            .await?;
        if Uid::effective().is_root() {
            chown(&temp, Some(Uid::from_raw(0)), Some(Gid::from_raw(0)))
                .map_err(|error| HostdError::operation_failed(error.to_string()))?;
        }
        file.sync_all().await?;
        drop(file);
        before_rename().await?;
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

pub(super) async fn remove_if_exists(path: &Path) -> Result<(), HostdError> {
    match fs::remove_file(path).await {
        Ok(()) => {
            sync_parent(path).await?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn sync_parent(path: &Path) -> Result<(), HostdError> {
    let parent = path
        .parent()
        .ok_or_else(|| HostdError::validation("Managed profile has no parent"))?;
    fs::File::open(parent).await?.sync_all().await?;
    Ok(())
}
